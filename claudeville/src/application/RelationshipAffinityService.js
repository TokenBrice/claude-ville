import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';
import { PairAffinity, affinityPairKey } from '../domain/value-objects/PairAffinity.js';
import { extractRecipientName } from '../domain/services/RecipientResolver.js';

const FLUSH_DEBOUNCE_MS = 3000;
const WRITE_LEASE_KEY = 'claudeville.affinity.writeLease';
const WRITE_LEASE_TTL_MS = 15000;
const AFFINITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
    return String(event.id || `git:${event.ts || event.timestamp || 0}:${event.commandHash || event.command || ''}`);
}

function sessionPairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

function normalizeAlias(value) {
    return String(value || '').trim().toLowerCase();
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
 * Emits `affinity:changed` on the event bus (`{ pairKey, affinity, kind }`)
 * whenever a pair record changes; cross-tab consumers get
 * `affinity-updated` messages on the chronicle BroadcastChannel via
 * `ChronicleStore.putAffinity`. Only the tab holding the write lease
 * accumulates, so multiple open tabs do not double-count.
 */
export class RelationshipAffinityService {
    constructor({ store = null } = {}) {
        this.store = store;
        this._affinities = new Map(); // pairKey -> PairAffinity
        this._roster = new Map(); // agent.id -> { agent, identityKey, countedGitKeys, lastChatSignature }
        this._metSessionPairs = new Set();
        this._dirty = new Set();
        this._flushTimer = null;
        this._flushTail = Promise.resolve();
        this._stopPromise = null;
        this._accepting = false;
        this._ready = Promise.resolve();
        this._leaseToken = randomToken();
        this._unsubscribers = [];
        this._channelListener = null;
    }

    start() {
        if (!this.store || this._accepting || this._stopPromise) return this;
        this._accepting = true;
        this._ready = this._preload();
        const seen = (agent) => {
            this._ready.then(() => {
                if (this._accepting) this._handleAgentSeen(agent);
            }).catch(() => {});
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
        return pairKey ? this._affinities.get(pairKey) || null : null;
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
        for (const pairKey of keys) {
            const affinity = this._affinities.get(pairKey);
            if (!affinity) continue;
            try {
                await this.store.putAffinity(affinity.toRecord());
            } catch (err) {
                this._dirty.add(pairKey);
                console.warn('[RelationshipAffinityService] flush failed:', err?.message || err);
            }
        }
    }

    _handleAgentSeen(agent) {
        if (!this._accepting || !agent?.id) return;
        let entry = this._roster.get(agent.id);
        if (!entry) {
            entry = { agent, identityKey: null, countedGitKeys: new Set(), lastChatSignature: null };
            this._roster.set(agent.id, entry);
        }
        entry.agent = agent;
        entry.identityKey = AgentBiography.identityKeyFor(agent);
        if (!entry.identityKey || !this._holdsWriteLease()) return;
        this._recordMeetings(entry);
        this._recordChat(entry);
        this._recordSharedCommits(entry);
    }

    _handleAgentRemoved(agent) {
        if (!this._accepting || !agent?.id) return;
        this._roster.delete(agent.id);
        // Forget session-pair meeting memory so a future re-arrival counts
        // as a new meeting.
        for (const key of this._metSessionPairs) {
            const [a, b] = key.split('|');
            if (a === agent.id || b === agent.id) this._metSessionPairs.delete(key);
        }
    }

    _recordMeetings(entry) {
        for (const other of this._roster.values()) {
            if (other === entry || !other.identityKey) continue;
            if (!sharesContext(entry.agent, other.agent)) continue;
            const key = sessionPairKey(entry.agent.id, other.agent.id);
            if (this._metSessionPairs.has(key)) continue;
            this._metSessionPairs.add(key);
            this._mutatePair(entry, other, 'meeting');
        }
    }

    _recordChat(entry) {
        const agent = entry.agent;
        if (String(agent.currentTool || '') !== 'SendMessage') return;
        const signature = String(agent.currentToolInput || '');
        if (entry.lastChatSignature === signature) return;
        entry.lastChatSignature = signature;
        const alias = normalizeAlias(extractRecipientName(signature));
        if (!alias) return;
        for (const other of this._roster.values()) {
            if (other === entry || !other.identityKey) continue;
            const candidates = [other.agent.name, other.agent.agentName, other.agent.agentId];
            if (candidates.some(value => normalizeAlias(value) === alias)) {
                this._mutatePair(entry, other, 'chat');
                return;
            }
        }
    }

    _recordSharedCommits(entry) {
        let fresh = 0;
        for (const event of entry.agent.gitEvents || []) {
            if (!isCountableGitEvent(event)) continue;
            const key = gitEventKey(event);
            if (entry.countedGitKeys.has(key)) continue;
            entry.countedGitKeys.add(key);
            fresh++;
        }
        if (!fresh) return;
        const project = entry.agent.projectPath;
        if (!project) return;
        for (const other of this._roster.values()) {
            if (other === entry || !other.identityKey) continue;
            if (other.agent.projectPath !== project) continue;
            for (let i = 0; i < fresh; i++) this._mutatePair(entry, other, 'sharedCommit');
        }
    }

    _mutatePair(entryA, entryB, kind) {
        if (!this._accepting) return;
        const pairKey = affinityPairKey(entryA.identityKey, entryB.identityKey);
        if (!pairKey) return;
        const now = Date.now();
        let affinity = this._affinities.get(pairKey);
        if (!affinity) {
            affinity = PairAffinity.create(entryA.identityKey, entryB.identityKey, now);
            if (!affinity) return;
            this._affinities.set(pairKey, affinity);
        }
        if (!affinity.recordInteraction(kind, now)) return;
        this._dirty.add(pairKey);
        this._scheduleFlush();
        eventBus.emit('affinity:changed', { pairKey, affinity, kind });
    }

    async _preload() {
        if (!this.store) return;
        try {
            const records = await this.store.getAllAffinities({
                since: Date.now() - AFFINITY_RETENTION_MS,
            });
            for (const record of records || []) {
                const affinity = PairAffinity.fromRecord(record);
                if (affinity) this._affinities.set(affinity.pairKey, affinity);
            }
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

    _holdsWriteLease() {
        if (typeof localStorage === 'undefined') return true;
        const now = Date.now();
        try {
            const raw = localStorage.getItem(WRITE_LEASE_KEY);
            const current = raw ? JSON.parse(raw) : null;
            if (current && current.token !== this._leaseToken && Number(current.expiresAt) > now) {
                return false;
            }
            localStorage.setItem(WRITE_LEASE_KEY, JSON.stringify({
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
            const raw = localStorage.getItem(WRITE_LEASE_KEY);
            const current = raw ? JSON.parse(raw) : null;
            if (current?.token === this._leaseToken) localStorage.removeItem(WRITE_LEASE_KEY);
        } catch { /* ignore */ }
    }
}
