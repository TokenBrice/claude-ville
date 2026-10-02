import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';
import {
    AFFINITY_HALF_LIFE_MS,
    PairAffinity,
    affinityPairKey,
} from '../domain/value-objects/PairAffinity.js';
import { extractRecipientName } from '../domain/services/RecipientResolver.js';

const FLUSH_DEBOUNCE_MS = 3000;
const WRITE_LEASE_KEY = 'claudeville.affinity.writeLease';
const WRITE_LEASE_TTL_MS = 15000;
const AFFINITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AFFINITY_CACHE_LIMIT = 1024;
const MET_SESSION_PAIR_LIMIT = AFFINITY_CACHE_LIMIT;
const ROSTER_LIMIT = AFFINITY_CACHE_LIMIT;
const WARMTH_KINDLED_MS = AFFINITY_HALF_LIFE_MS / 4;

/**
 * A lore-facing decay phase. These labels describe time since the warmth
 * score was last settled, not the score itself: after one 48-hour half-life
 * a bond is cooling, and after two it is a faint trail.
 */
export function affinityWarmthPhase(affinity, now = Date.now()) {
    const updatedAt = Number(affinity?.scoreUpdatedAt || affinity?.lastInteractionAt || 0);
    if (!updatedAt) return 'faint';
    const elapsed = Math.max(0, Number(now) - updatedAt);
    if (elapsed < WARMTH_KINDLED_MS) return 'hearth-warm';
    if (elapsed < AFFINITY_HALF_LIFE_MS) return 'warm';
    if (elapsed < AFFINITY_HALF_LIFE_MS * 2) return 'cooling';
    return 'faint';
}

function interactionTotal(affinity) {
    return (
        Number(affinity?.meetings || 0)
        + Number(affinity?.chats || 0)
        + Number(affinity?.sharedCommits || 0)
    );
}

function randomToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isCountableGitEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const type = String(event.type || '').toLowerCase();
    if (!type.includes('commit') && !type.includes('push')) return false;
    if (event.dryRun === true) return false;
    if (event.success === false) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected') return false;
    return true;
}

function gitEventKey(event) {
    if (event?.id) return compactIdentity(event.id);
    const source = String(event?.commandHash || event?.command || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return compactIdentity(`${event?.ts || event?.timestamp || 0}:${(hash >>> 0).toString(36)}`);
}

function compactIdentity(value) {
    const text = String(value || '');
    if (text.length <= 160) return text;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.slice(0, 80)}:${(hash >>> 0).toString(36)}`;
}

function eventTimestamp(event) {
    const raw = event?.completedAt ?? event?.ts ?? event?.timestamp;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function chatEventKey(agent, message, index) {
    return compactIdentity([
        'chat',
        agent.id,
        eventTimestamp(message) || `index:${index}`,
        normalizeAlias(message?.recipient),
        String(message?.messageType || 'message'),
        String(message?.summary || ''),
    ].join(':'));
}

function sessionPairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

function meetingContextSignature(entry) {
    return compactIdentity([
        entry?.identityKey,
        entry?.agent?.parentSessionId,
        entry?.agent?.teamName,
        entry?.agent?.projectPath,
    ].join('|'));
}

function normalizeAlias(value) {
    return String(value || '').trim().toLowerCase();
}

function isDepartedAgent(agent) {
    return agent?.isDeparted === true
        || (agent?.departedAt !== null
            && agent?.departedAt !== undefined
            && Number.isFinite(Number(agent.departedAt)));
}

function isLiveAgent(agent) {
    return Boolean(agent) && !isDepartedAgent(agent);
}

function recipientAliases(agent) {
    return [agent?.name, agent?.agentName, agent?.agentId].map(normalizeAlias);
}

function addressesAliases(agent, aliases) {
    if ((agent.sendMessages || []).some(message => aliases.has(normalizeAlias(message?.recipient)))) {
        return true;
    }
    return agent.currentTool === 'SendMessage'
        && aliases.has(normalizeAlias(extractRecipientName(agent.currentToolInput || '')));
}

// Fixed-size revisions, independent of the retained provider history length.
// Length framing distinguishes fields without retaining another telemetry copy.
function revisionWriter() {
    let a = 2166136261;
    let b = 5381;
    let length = 0;
    return {
        add(value) {
            const text = String(value ?? '');
            const framed = `${text.length}:${text}`;
            length += framed.length;
            for (let index = 0; index < framed.length; index++) {
                const code = framed.charCodeAt(index);
                a = Math.imul(a ^ code, 16777619);
                b = Math.imul(b, 33) ^ code;
            }
        },
        value() { return `${length}:${a >>> 0}:${b >>> 0}`; },
    };
}

function telemetryRevisions(agent) {
    const chat = revisionWriter();
    const git = revisionWriter();
    (agent.sendMessages || []).forEach((message, index) => {
        chat.add(chatEventKey(agent, message, index));
        chat.add(eventTimestamp(message));
    });
    if (agent.currentTool === 'SendMessage') {
        chat.add('SendMessage');
        chat.add(agent.currentToolInput);
    }
    for (const event of agent.gitEvents || []) {
        if (!isCountableGitEvent(event)) continue;
        git.add(gitEventKey(event));
        git.add(eventTimestamp(event));
    }
    return { chat: chat.value(), git: git.value() };
}

/** Two live agents share context when they could plausibly "meet". */
function sharesContext(a, b) {
    if (a.parentSessionId && a.parentSessionId === b.id) return true;
    if (b.parentSessionId && b.parentSessionId === a.id) return true;
    if (a.parentSessionId && a.parentSessionId === b.parentSessionId) return true;
    if (a.teamName && a.teamName === b.teamName) return true;
    if (a.projectPath && a.projectPath === b.projectPath) return true;
    return false;
}

/**
 * Accumulates per-pair affinity (meetings, chats, shared commits, last
 * interaction, decaying warmth score) across restarts, persisted through
 * the ChronicleStore `affinities` object store. Pairs are keyed by the
 * same biography identity keys as `AgentBiographyService`, so affinity
 * survives session churn.
 *
 * Interaction signals, all derived from domain `agent:*` events:
 * - meeting: two live agents share context (same project, same team, or
 *   parent/child link), counted once per session pair.
 * - chat: a `SendMessage` tool call whose recipient alias resolves to
 *   another live agent.
 * - sharedCommit: a countable commit/push git event, credited to every
 *   other live agent in the same project.
 *
 * Fixed-size per-resident telemetry revisions skip unrelated updates.
 * Membership/alias changes revisit affected senders so late recipients and
 * returning project peers still consume retained telemetry. Failed git pair
 * admissions remain pending until a later observation can retry them.
 * Dirty snapshots commit atomically before per-pair follower invalidations.
 *
 * Emits `affinity:changed` on the event bus (`{ pairKey, affinity, kind }`)
 * whenever a pair record changes; cross-tab consumers get
 * `affinity-updated` messages on the chronicle BroadcastChannel via
 * `ChronicleStore.putAffinities`. Only the tab holding the write lease
 * accumulates, so multiple open tabs do not double-count.
 */
export class RelationshipAffinityService {
    constructor({ store = null } = {}) {
        this.store = store;
        this._writeLeaseKey = WRITE_LEASE_KEY + (store?.storageNamespace || '');
        this._affinities = new Map(); // pairKey -> PairAffinity
        this._roster = new Map(); // agent.id -> resident telemetry + observation baseline
        this._metSessionPairs = new Set();
        this._pendingGit = new Set(); // roster IDs whose pair admission must retry
        this._dirty = new Set();
        this._flushing = new Set();
        this._flushTimer = null;
        this._flushTail = Promise.resolve();
        this._stopPromise = null;
        this._accepting = false;
        this._ready = Promise.resolve();
        // Store-less instances are also used by pure signal tests and helper
        // callers that exercise pair mutation directly; those have no preload
        // gate to wait for.
        this._readyState = store ? 'idle' : 'ready';
        this._leaseToken = randomToken();
        this._unsubscribers = [];
        this._channelListener = null;
        this._capacityDrops = 0;
    }

    start() {
        if (!this.store || this._accepting || this._stopPromise) return this;
        this._accepting = true;
        this._readyState = 'loading';
        this._ready = this._preload()
            .then(() => {
                this._readyState = 'ready';
                if (!this._accepting) return;
                this._replayRoster();
                eventBus.emit('affinity:ready', { service: this });
            })
            .catch((err) => {
                // _preload currently degrades internally, but keep the ready
                // gate finite if a future store adapter rejects unexpectedly.
                this._readyState = 'ready';
                if (this._accepting) {
                    console.warn('[RelationshipAffinityService] preload degraded:', err?.message || err);
                    this._replayRoster();
                    eventBus.emit('affinity:ready', { service: this });
                }
            });
        const seen = (agent) => {
            // Do not attach a continuation for every polling update. While a
            // blocked IndexedDB upgrade is pending, retain only the latest
            // bounded roster entry and replay it once when preload settles.
            this._handleAgentSeen(agent);
        };
        this._unsubscribers.push(eventBus.on('agent:added', seen));
        this._unsubscribers.push(eventBus.on('agent:updated', seen));
        this._unsubscribers.push(eventBus.on('agent:removed', (agent) => this._handleAgentRemoved(agent)));
        if (this.store.channel?.addEventListener) {
            this._channelListener = (event) => {
                if (event.data?.type !== 'affinity-updated') return;
                // Another tab wrote this pair; refresh the cached record so
                // follower-tab reads (and renderers) stay current.
                if (!this._holdsWriteLease()) this._refreshFromStore(event.data.pairKey);
            };
            this.store.channel.addEventListener('message', this._channelListener);
        }
        return this;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        this._accepting = false;
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._unsubscribers = [];
        if (this._channelListener && this.store?.channel?.removeEventListener) {
            this.store.channel.removeEventListener('message', this._channelListener);
        }
        this._channelListener = null;
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        this._stopPromise = (async () => {
            try {
                await this._ready.catch(() => {});
                await this.flush();
                await this._flushTail;
            } finally {
                this._releaseWriteLease();
                this._affinities.clear();
                this._roster.clear();
                this._metSessionPairs.clear();
                this._pendingGit.clear();
                this._dirty.clear();
                this._flushing.clear();
                this._readyState = 'stopped';
            }
        })();
        return this._stopPromise;
    }

    /**
     * Read access for renderers (proximity preference, chat frequency).
     * The Map is live; treat it as read-only.
     */
    getSnapshot() {
        return this._affinities;
    }

    getAffinity(identityKeyA, identityKeyB) {
        const pairKey = affinityPairKey(identityKeyA, identityKeyB);
        const affinity = pairKey ? this._affinities.get(pairKey) || null : null;
        if (affinity) this._touchAffinity(pairKey);
        return affinity;
    }

    /**
     * Ranked relationship summaries for one persistent biography identity.
     * Lifetime counters remain exact while tier and warmth are evaluated at
     * read time, so UI consumers never need to understand the decay formula.
     */
    collaboratorsFor(identityKey, now = Date.now()) {
        const key = String(identityKey || '').trim();
        if (!key) return [];
        const tierRank = { allies: 0, acquaintances: 1, strangers: 2 };
        const collaborators = [];
        for (const affinity of this._affinities.values()) {
            if (!affinity?.involves?.(key) || interactionTotal(affinity) <= 0) continue;
            const otherIdentity = affinity.otherIdentity(key);
            if (!otherIdentity) continue;
            collaborators.push({
                identityKey: otherIdentity,
                tier: affinity.tier(now),
                warmth: affinityWarmthPhase(affinity, now),
                score: affinity.decayedScore(now),
                meetings: Number(affinity.meetings) || 0,
                chats: Number(affinity.chats) || 0,
                sharedCommits: Number(affinity.sharedCommits) || 0,
                firstMetAt: Number(affinity.firstMetAt) || 0,
                lastInteractionAt: Number(affinity.lastInteractionAt) || 0,
            });
        }
        return collaborators.sort((a, b) => (
            (tierRank[a.tier] - tierRank[b.tier])
            || (b.score - a.score)
            || (b.sharedCommits - a.sharedCommits)
            || (b.lastInteractionAt - a.lastInteractionAt)
            || a.identityKey.localeCompare(b.identityKey)
        ));
    }

    /** Decayed warmth between two live agents; 0 for strangers/unknown. */
    affinityBetween(agentA, agentB, now = Date.now()) {
        const affinity = this.getAffinity(
            AgentBiography.identityKeyFor(agentA),
            AgentBiography.identityKeyFor(agentB),
        );
        return affinity ? affinity.decayedScore(now) : 0;
    }

    flush() {
        const run = this._flushTail.then(() => this._flushDirty());
        this._flushTail = run.catch(() => {});
        return run;
    }

    async _flushDirty() {
        if (!this.store || !this._dirty.size) return;
        const keys = [...this._dirty];
        this._dirty.clear();
        for (const pairKey of keys) this._flushing.add(pairKey);
        try {
            const records = keys.map(key => this._affinities.get(key))
                .filter(Boolean).map(affinity => affinity.toRecord());
            if (records.length) await this.store.putAffinities(records);
        } catch (err) {
            for (const pairKey of keys) this._dirty.add(pairKey);
            console.warn('[RelationshipAffinityService] flush failed:', err?.message || err);
        } finally {
            for (const pairKey of keys) this._flushing.delete(pairKey);
        }
        this._pruneAffinityCache();
    }

    _handleAgentSeen(agent) {
        if (!this._accepting || !agent?.id) return;
        const observation = this._rememberAgent(agent);
        if (!observation || this._readyState !== 'ready') return;
        this._processAgentSeen(observation.entry, observation.firstObservation);
    }

    _rememberAgent(agent) {
        if (!this._accepting || !agent?.id) return null;
        let entry = this._roster.get(agent.id);
        if (!entry) {
            if (this._roster.size >= ROSTER_LIMIT) {
                const departedId = [...this._roster.values()]
                    .find(candidate => isDepartedAgent(candidate.agent))?.agent?.id;
                if (!departedId) return null;
                this._roster.delete(departedId);
                this._pendingGit.delete(departedId);
            }
            entry = {
                agent,
                identityKey: null,
                meetingContextSignature: null,
                observedAt: Date.now(),
                countedChatKeys: new Set(),
                lastChatSignature: null,
                observed: false,
                recipientContext: null,
                chatRevision: null,
                gitRevision: null,
            };
            this._roster.set(agent.id, entry);
        }
        entry.agent = agent;
        entry.identityKey = AgentBiography.identityKeyFor(agent);
        return { entry, firstObservation: !entry.observed };
    }

    _processAgentSeen(entry, firstObservation = false, primeRoster = false) {
        if (!entry) return;
        entry.observed = true;
        if (!isLiveAgent(entry.agent)) {
            // Return is a membership change even when aliases/project did not
            // change while the resident was departed.
            entry.recipientContext = null;
            entry.chatRevision = null;
            entry.gitRevision = null;
            this._pendingGit.delete(entry.agent.id);
            return;
        }
        if (!entry.identityKey || !this._holdsWriteLease()) return;
        const nextMeetingContext = meetingContextSignature(entry);
        const contextChanged = firstObservation || entry.meetingContextSignature !== nextMeetingContext;
        if (contextChanged) {
            entry.meetingContextSignature = nextMeetingContext;
            this._recordMeetings(entry);
        }
        const previous = entry.recipientContext;
        const aliases = recipientAliases(entry.agent);
        const recipientChanged = !previous
            || previous.identityKey !== entry.identityKey
            || aliases.some((alias, index) => alias !== previous.aliases[index]);
        const projectChanged = !previous
            || previous.identityKey !== entry.identityKey
            || previous.project !== entry.agent.projectPath;
        entry.recipientContext = { identityKey: entry.identityKey, aliases, project: entry.agent.projectPath };
        const revisions = telemetryRevisions(entry.agent);
        const chatChanged = firstObservation || revisions.chat !== entry.chatRevision;
        const gitChanged = firstObservation || projectChanged || revisions.git !== entry.gitRevision;
        entry.chatRevision = revisions.chat;
        entry.gitRevision = revisions.git;
        if (primeRoster) {
            // Preload retains the whole roster before observing its first
            // resident. Prime it once in the original roster order: other
            // senders are not first-observation baselines in this pass.
            for (const sender of this._roster.values()) {
                if (!isLiveAgent(sender.agent)) continue;
                const revision = sender === entry ? revisions : telemetryRevisions(sender.agent);
                this._recordChats(sender, sender === entry && firstObservation);
                const admitted = this._recordSharedCommits(sender, sender === entry && firstObservation);
                sender.chatRevision = revision.chat;
                sender.gitRevision = admitted ? revision.git : null;
            }
            return;
        }
        if (!recipientChanged && !projectChanged && !this._pendingGit.size) {
            if (chatChanged) this._recordChats(entry, firstObservation);
            if (gitChanged && !this._recordSharedCommits(entry, firstObservation)) entry.gitRevision = null;
            return;
        }

        // Membership/identity changes replay only senders addressing the affected
        // aliases and commits in the affected project, against the arriving peer.
        // Roster order and chat-before-git preserve admission and baseline order.
        const affectedAliases = new Set([...aliases, ...(previous?.aliases || [])].filter(Boolean));
        for (const sender of this._roster.values()) {
            if (!isLiveAgent(sender.agent)) continue;
            if (sender === entry) {
                if (chatChanged) this._recordChats(entry, firstObservation);
                if (gitChanged && !this._recordSharedCommits(entry, firstObservation)) entry.gitRevision = null;
                continue;
            }
            if (recipientChanged && addressesAliases(sender.agent, affectedAliases)) {
                this._recordChats(sender, false, affectedAliases);
            }
            if (this._pendingGit.has(sender.agent.id)) {
                if (!this._recordSharedCommits(sender)) sender.gitRevision = null;
            } else if (projectChanged && entry.agent.projectPath
                && sender.agent.projectPath === entry.agent.projectPath) {
                if (!this._recordSharedCommits(sender, false, entry)) sender.gitRevision = null;
            }
        }
    }

    _replayRoster() {
        let primed = false;
        for (const entry of this._roster.values()) {
            if (!this._accepting || entry.observed) continue;
            const prime = !primed && entry.identityKey && isLiveAgent(entry.agent) && this._holdsWriteLease();
            this._processAgentSeen(entry, true, prime);
            if (prime) primed = true;
        }
    }

    _handleAgentRemoved(agent) {
        if (!this._accepting || !agent?.id) return;
        this._roster.delete(agent.id);
        this._pendingGit.delete(agent.id);
        // Forget session-pair meeting memory so a future re-arrival counts
        // as a new meeting.
        for (const key of this._metSessionPairs) {
            const [a, b] = key.split('|');
            if (a === agent.id || b === agent.id) this._metSessionPairs.delete(key);
        }
        this._pruneAffinityCache();
    }

    _recordMeetings(entry) {
        if (!isLiveAgent(entry?.agent)) return;
        for (const other of this._roster.values()) {
            if (other === entry || !other.identityKey || !isLiveAgent(other.agent)) continue;
            if (!sharesContext(entry.agent, other.agent)) continue;
            const key = sessionPairKey(entry.agent.id, other.agent.id);
            if (this._metSessionPairs.has(key)) continue;
            const admitted = this._mutatePair(entry, other, 'meeting', `meeting:${key}`);
            if (admitted !== null) this._rememberMetSessionPair(key);
        }
    }

    _recordChats(entry, firstObservation = false, aliases = null) {
        const agent = entry.agent;
        if (!isLiveAgent(agent)) return;
        const messages = Array.isArray(agent.sendMessages) ? agent.sendMessages : [];
        messages.forEach((message, index) => {
            const alias = normalizeAlias(message?.recipient);
            if (!alias || (aliases && !aliases.has(alias))) return;
            const other = this._findRecipient(entry, alias);
            if (!other) return;
            const key = chatEventKey(agent, message, index);
            if (entry.countedChatKeys.has(key)) return;
            entry.countedChatKeys.add(key);
            while (entry.countedChatKeys.size > 96) {
                entry.countedChatKeys.delete(entry.countedChatKeys.values().next().value);
            }
            const at = eventTimestamp(message);
            const baseline = firstObservation || (at > 0 && at <= entry.observedAt);
            this._mutatePair(entry, other, 'chat', key, { baseline });
        });

        // Keep the live-tool fallback for providers without sendMessages.
        if (String(agent.currentTool || '') !== 'SendMessage') return;
        const signature = String(agent.currentToolInput || '');
        if (!signature || entry.lastChatSignature === signature) return;
        const alias = normalizeAlias(extractRecipientName(signature));
        if (!alias || (aliases && !aliases.has(alias))) return;
        const other = this._findRecipient(entry, alias);
        if (!other) return;
        entry.lastChatSignature = signature;
        this._mutatePair(
            entry,
            other,
            'chat',
            compactIdentity(`chat-tool:${agent.id}:${signature}`),
            { baseline: firstObservation },
        );
    }

    _findRecipient(entry, alias) {
        for (const other of this._roster.values()) {
            if (other === entry || !other.identityKey || !isLiveAgent(other.agent)) continue;
            const candidates = [other.agent.name, other.agent.agentName, other.agent.agentId];
            if (candidates.some(value => normalizeAlias(value) === alias)) {
                return other;
            }
        }
        return null;
    }

    _recordSharedCommits(entry, firstObservation = false, peer = null) {
        const project = entry.agent.projectPath;
        if (!project || !isLiveAgent(entry.agent)) {
            if (!peer) this._pendingGit.delete(entry.agent.id);
            return true;
        }
        let admitted = true;
        // Build the peer subset once, not once per retained commit.
        const peers = peer ? [peer] : [...this._roster.values()].filter(other => (
            other !== entry && other.identityKey && isLiveAgent(other.agent)
            && other.agent.projectPath === project
        ));
        if (!peers.length) {
            if (!peer) this._pendingGit.delete(entry.agent.id);
            return true;
        }
        for (const event of entry.agent.gitEvents || []) {
            if (!isCountableGitEvent(event)) continue;
            const key = `git:${gitEventKey(event)}`;
            const at = eventTimestamp(event);
            const baseline = firstObservation || (at > 0 && at <= entry.observedAt);
            for (const other of peers) {
                if (!affinityPairKey(entry.identityKey, other.identityKey)) continue;
                if (this._mutatePair(entry, other, 'sharedCommit', key, { baseline }) === null) admitted = false;
            }
        }
        if (!admitted) this._pendingGit.add(entry.agent.id);
        else if (!peer) this._pendingGit.delete(entry.agent.id);
        return admitted;
    }

    _mutatePair(entryA, entryB, kind, interactionKey, { baseline = false } = {}) {
        if (!this._accepting || isDepartedAgent(entryA?.agent) || isDepartedAgent(entryB?.agent)) return null;
        const pairKey = affinityPairKey(entryA.identityKey, entryB.identityKey);
        if (!pairKey) return null;
        const now = Date.now();
        let affinity = this._affinities.get(pairKey);
        if (!affinity) {
            if (!this._reserveAffinitySlot()) return null;
            affinity = PairAffinity.create(entryA.identityKey, entryB.identityKey, now);
            if (!affinity) return null;
            this._affinities.set(pairKey, affinity);
        } else {
            this._touchAffinity(pairKey);
        }
        // Legacy records had counters but no identities. Baseline their first
        // observed event rather than incrementing once during migration.
        const legacy = affinity.schemaVersion < 2;
        if (baseline || legacy) {
            const remembered = affinity.rememberInteraction(interactionKey);
            affinity.schemaVersion = 2;
            if (!remembered && !legacy) return false;
            this._dirty.add(pairKey);
            this._scheduleFlush();
            return true;
        }
        if (!affinity.recordInteraction(kind, now, interactionKey)) return false;
        this._dirty.add(pairKey);
        this._scheduleFlush();
        eventBus.emit('affinity:changed', { pairKey, affinity, kind });
        return true;
    }

    async _preload() {
        if (!this.store) return;
        try {
            const records = await this.store.getAllAffinities({
                since: Date.now() - AFFINITY_RETENTION_MS,
                limit: AFFINITY_CACHE_LIMIT,
            });
            // Store queries newest-first; insert oldest-first so Map order is
            // a useful LRU baseline.
            for (const record of [...(records || [])].reverse()) {
                const affinity = PairAffinity.fromRecord(record);
                if (affinity) this._affinities.set(affinity.pairKey, affinity);
            }
            this._pruneAffinityCache();
        } catch (err) {
            console.warn('[RelationshipAffinityService] preload failed:', err?.message || err);
        }
    }

    _refreshFromStore(pairKey) {
        if (!this._accepting || !pairKey || !this.store) return;
        this.store.getAffinity(pairKey)
            .then((record) => {
                if (!this._accepting) return;
                const affinity = PairAffinity.fromRecord(record);
                if (!affinity) return;
                this._affinities.set(pairKey, affinity);
                this._touchAffinity(pairKey);
                this._pruneAffinityCache();
                eventBus.emit('affinity:changed', { pairKey, affinity, kind: 'sync' });
            })
            .catch(() => {});
    }

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush().catch(() => {});
        }, FLUSH_DEBOUNCE_MS);
    }

    _touchAffinity(pairKey) {
        const affinity = this._affinities.get(pairKey);
        if (!affinity) return;
        this._affinities.delete(pairKey);
        this._affinities.set(pairKey, affinity);
    }

    _reserveAffinitySlot() {
        if (this._affinities.size < AFFINITY_CACHE_LIMIT) return true;
        for (const pairKey of this._affinities.keys()) {
            if (this._dirty.has(pairKey) || this._flushing.has(pairKey)) continue;
            this._affinities.delete(pairKey);
            return true;
        }
        // Affinity is ambient telemetry. When every retained pair is awaiting
        // persistence, prefer a hard memory bound over an unbounded dirty burst.
        this._capacityDrops++;
        return false;
    }

    _rememberMetSessionPair(pairKey) {
        this._metSessionPairs.delete(pairKey);
        this._metSessionPairs.add(pairKey);
        while (this._metSessionPairs.size > MET_SESSION_PAIR_LIMIT) {
            this._metSessionPairs.delete(this._metSessionPairs.values().next().value);
        }
    }

    _pruneAffinityCache(now = Date.now()) {
        const cutoff = now - AFFINITY_RETENTION_MS;
        for (const [pairKey, affinity] of this._affinities) {
            if (this._dirty.has(pairKey) || this._flushing.has(pairKey)) continue;
            if (Number(affinity.lastInteractionAt || 0) < cutoff) {
                this._affinities.delete(pairKey);
            }
        }
        for (const pairKey of this._affinities.keys()) {
            if (this._affinities.size <= AFFINITY_CACHE_LIMIT) break;
            if (this._dirty.has(pairKey) || this._flushing.has(pairKey)) continue;
            this._affinities.delete(pairKey);
        }
    }

    _holdsWriteLease() {
        if (typeof localStorage === 'undefined') return true;
        const now = Date.now();
        try {
            const raw = localStorage.getItem(this._writeLeaseKey);
            const current = raw ? JSON.parse(raw) : null;
            if (current && current.token !== this._leaseToken && Number(current.expiresAt) > now) {
                return false;
            }
            localStorage.setItem(this._writeLeaseKey, JSON.stringify({
                token: this._leaseToken,
                expiresAt: now + WRITE_LEASE_TTL_MS,
            }));
            return true;
        } catch {
            return true;
        }
    }

    _releaseWriteLease() {
        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem(this._writeLeaseKey);
            const current = raw ? JSON.parse(raw) : null;
            if (current?.token === this._leaseToken) localStorage.removeItem(this._writeLeaseKey);
        } catch { /* ignore */ }
    }
}
