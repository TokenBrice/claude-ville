import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';

const FLUSH_DEBOUNCE_MS = 3000;
const WRITE_LEASE_KEY = 'claudeville.biography.writeLease';
const WRITE_LEASE_TTL_MS = 15000;

function randomToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    return (Number(tokens.input) || 0) + (Number(tokens.output) || 0);
}

function isCountablePush(event) {
    if (!event || typeof event !== 'object') return false;
    if (!String(event.type || '').toLowerCase().includes('push')) return false;
    if (event.dryRun === true) return false;
    if (event.success === false) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected') return false;
    return true;
}

function pushEventKey(event) {
    return String(event.id || `push:${event.ts || event.timestamp || 0}:${event.commandHash || event.command || ''}`);
}

function nameFromIdentityKey(identityKey) {
    return String(identityKey || '').split(':').pop() || '';
}

/**
 * Accumulates per-villager biography state (sessions completed, pushes,
 * lifetime tokens, error recoveries, milestones, earned nicknames) across
 * restarts, persisted through the ChronicleStore `biographies` object
 * store. Also persists the one-time village founding record (first-ever
 * villager + timestamp) under the chronicle `meta` store.
 *
 * Emits `biography:updated` on the event bus whenever milestones are
 * earned; cross-tab consumers get `biography-updated` messages on the
 * chronicle BroadcastChannel via `ChronicleStore.putBiography`.
 *
 * Only the tab holding the write lease accumulates and persists, so
 * multiple open tabs do not double-count the same telemetry.
 */
export class AgentBiographyService {
    constructor({ store = null } = {}) {
        this.store = store;
        this._biographies = new Map(); // identityKey -> Promise<AgentBiography|null>
        this._mutationTails = new Map(); // identityKey -> Promise (serializes mutations)
        this._sessions = new Map(); // agent.id -> { identityKey, tokenBaseline, countedPushKeys, completed }
        this._dirty = new Set();
        this._foundingPromise = null;
        this._flushTimer = null;
        this._leaseToken = randomToken();
        this._unsubscribers = [];
        this._channelListener = null;
    }

    start() {
        if (!this.store || this._unsubscribers.length) return this;
        const seen = (agent) => this._handleAgentSeen(agent);
        this._unsubscribers.push(eventBus.on('agent:added', seen));
        this._unsubscribers.push(eventBus.on('agent:updated', seen));
        this._unsubscribers.push(eventBus.on('agent:removed', (agent) => this._handleAgentRemoved(agent)));
        if (this.store.channel?.addEventListener) {
            this._channelListener = (event) => {
                if (event.data?.type !== 'biography-updated') return;
                // Another tab wrote this biography; drop the cached copy so
                // follower-tab reads pick up the fresh record.
                if (!this._holdsWriteLease()) {
                    this._biographies.delete(event.data.identityKey);
                }
            };
            this.store.channel.addEventListener('message', this._channelListener);
        }
        return this;
    }

    stop() {
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
        this.flush().catch(() => {});
        this._releaseWriteLease();
    }

    identityKeyFor(agent) {
        return AgentBiography.identityKeyFor(agent);
    }

    /** Read access for renderers and later systems (nicknames, mood, affinity). */
    async getBiography(identityKey) {
        if (!identityKey || !this.store) return null;
        if (!this._biographies.has(identityKey)) {
            this._biographies.set(identityKey, this._load(identityKey));
        }
        return this._biographies.get(identityKey);
    }

    /** Founding record (`{ identityKey, name, foundedAt }`) or null. */
    async getFounding() {
        if (!this.store) return null;
        return this.store.getFounding();
    }

    async flush() {
        if (!this.store || !this._dirty.size) return;
        const keys = [...this._dirty];
        this._dirty.clear();
        for (const identityKey of keys) {
            try {
                const biography = await this._biographies.get(identityKey);
                if (biography) await this.store.putBiography(biography.toRecord());
            } catch (err) {
                this._dirty.add(identityKey);
                console.warn('[AgentBiographyService] flush failed:', err?.message || err);
            }
        }
    }

    _handleAgentSeen(agent) {
        if (!agent?.id || !this._holdsWriteLease()) return;
        const identityKey = AgentBiography.identityKeyFor(agent);
        if (!identityKey) return;
        let session = this._sessions.get(agent.id);
        if (!session) {
            // Baseline at first sight: sessions report cumulative totals, so
            // counting the initial total would double-count on every page
            // reload. Only growth observed by this tab accrues.
            session = {
                identityKey,
                tokenBaseline: tokenTotal(agent),
                countedPushKeys: new Set(),
                lastStatus: null,
                completed: false,
            };
            this._sessions.set(agent.id, session);
        }
        session.identityKey = identityKey;
        this._ensureFounding(identityKey, agent);

        const status = String(agent.status || '').toLowerCase();
        const recoveredFromError = session.lastStatus === 'errored' && status && status !== 'errored';
        if (status) session.lastStatus = status;

        const total = tokenTotal(agent);
        const tokenDelta = total - session.tokenBaseline;
        session.tokenBaseline = total;

        const newPushes = [];
        for (const event of agent.gitEvents || []) {
            if (!isCountablePush(event)) continue;
            const key = pushEventKey(event);
            if (session.countedPushKeys.has(key)) continue;
            session.countedPushKeys.add(key);
            newPushes.push(event);
        }

        const now = Date.now();
        this._mutate(identityKey, (biography) => {
            biography.noteSeen(now);
            const earned = [];
            if (tokenDelta > 0) earned.push(...biography.addLifetimeTokens(tokenDelta, now));
            for (const _event of newPushes) earned.push(...biography.recordPush(now));
            if (recoveredFromError) earned.push(...biography.recordErrorRecovery(now));
            return earned;
        });
    }

    /**
     * Persist the founding record (first-ever villager + timestamp) once.
     * Prefers the earliest persisted biography so upgrades credit the true
     * first villager rather than whoever happens to load first today.
     */
    _ensureFounding(identityKey, agent) {
        if (!this.store || this._foundingPromise) return this._foundingPromise;
        this._foundingPromise = (async () => {
            try {
                const existing = await this.store.getFounding();
                if (existing) return existing;
                const [earliest] = await this.store.queryRange('biographies', {
                    index: 'firstSeenAt',
                    limit: 1,
                });
                const founderKey = earliest?.identityKey || identityKey;
                const record = await this.store.recordFounding({
                    identityKey: founderKey,
                    name: founderKey === identityKey
                        ? String(agent.name || agent.displayName || nameFromIdentityKey(founderKey))
                        : nameFromIdentityKey(founderKey),
                    foundedAt: Number(earliest?.firstSeenAt) || Date.now(),
                });
                this._mutate(record.identityKey, (biography) => biography.markFounder(record.foundedAt));
                return record;
            } catch (err) {
                this._foundingPromise = null;
                console.warn('[AgentBiographyService] founding record failed:', err?.message || err);
                return null;
            }
        })();
        return this._foundingPromise;
    }

    _handleAgentRemoved(agent) {
        if (!agent?.id) return;
        const session = this._sessions.get(agent.id);
        this._sessions.delete(agent.id);
        if (!session || session.completed || !this._holdsWriteLease()) return;
        session.completed = true;
        const now = Date.now();
        this._mutate(session.identityKey, (biography) => {
            biography.noteSeen(now);
            return biography.recordSessionCompleted(now);
        });
    }

    /** Serialize async mutations per identity to avoid lost updates. */
    _mutate(identityKey, mutator) {
        if (!this.store) return;
        const tail = this._mutationTails.get(identityKey) || Promise.resolve();
        const next = tail
            .then(() => this.getBiography(identityKey))
            .then(async (existing) => {
                let biography = existing;
                if (!biography) {
                    biography = AgentBiography.create(identityKey);
                    this._biographies.set(identityKey, Promise.resolve(biography));
                }
                const earned = mutator(biography) || [];
                this._dirty.add(identityKey);
                if (earned.length) {
                    eventBus.emit('biography:updated', { identityKey, biography, milestones: earned });
                    await this.flush();
                } else {
                    this._scheduleFlush();
                }
            })
            .catch((err) => {
                console.warn('[AgentBiographyService] mutation failed:', err?.message || err);
            });
        this._mutationTails.set(identityKey, next);
    }

    async _load(identityKey) {
        try {
            const record = await this.store.getBiography(identityKey);
            return AgentBiography.fromRecord(record);
        } catch (err) {
            console.warn('[AgentBiographyService] load failed:', err?.message || err);
            return null;
        }
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
