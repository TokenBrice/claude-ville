class SessionDetailsService {
    constructor() {
        this._defaultProvider = 'claude';
        this._inFlight = new Map();
        this._cache = new Map();
        this._cacheTtlMs = 5000;
        this._staleTtlMs = 15000;
        this._maxCacheEntries = 128;
        this._fetchTimeoutMs = 4000;
        this._counters = this._newCounters();
        this._installDebugSnapshot();
    }

    _newCounters() {
        return {
            cacheHits: 0,
            cacheStaleHits: 0,
            cacheMisses: 0,
            fetchStarted: 0,
            fetchSucceeded: 0,
            fetchFailed: 0,
            fetchTimedOut: 0,
            batchStarted: 0,
            batchSucceeded: 0,
            batchFailed: 0,
            batchTimedOut: 0,
            inFlightJoined: 0,
            staleRefreshStarted: 0,
            cacheTrimmed: 0,
            cacheDeleted: 0,
            cacheSwept: 0,
        };
    }

    _installDebugSnapshot() {
        if (typeof window === 'undefined') return;
        const service = this;
        window.__claudeVilleSessionDetails = {
            snapshot() {
                return service.getDebugSnapshot();
            },
            reset() {
                service.resetDebugCounters();
                return service.getDebugSnapshot();
            },
        };
    }

    getDebugSnapshot() {
        return {
            counters: { ...this._counters },
            cacheEntries: this._cache.size,
            inFlightEntries: this._inFlight.size,
            cacheTtlMs: this._cacheTtlMs,
            staleTtlMs: this._staleTtlMs,
            maxCacheEntries: this._maxCacheEntries,
            fetchTimeoutMs: this._fetchTimeoutMs,
        };
    }

    resetDebugCounters() {
        this._counters = this._newCounters();
    }

    _trimCache() {
        if (this._cache.size <= this._maxCacheEntries) return;

        const toRemove = this._cache.size - this._maxCacheEntries;
        for (let removed = 0; removed < toRemove; removed++) {
            const oldestKey = this._cache.keys().next().value;
            if (!oldestKey) break;
            this._cache.delete(oldestKey);
            this._counters.cacheTrimmed++;
        }
    }

    getSessionDetailKey(agent) {
        const provider = (agent?.provider || this._defaultProvider);
        const project = agent?.projectPath || '';
        const sessionId = agent?.id || '';
        return `${provider}::${project}::${sessionId}`;
    }

    deleteForAgent(agent) {
        if (!agent) return;
        const key = this.getSessionDetailKey(agent);
        if (this._cache.delete(key)) this._counters.cacheDeleted++;
        if (this._inFlight.delete(key)) this._counters.cacheDeleted++;
    }

    sweep(activeAgents = []) {
        const activeKeys = new Set(activeAgents.map(agent => this.getSessionDetailKey(agent)));
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (activeKeys.has(key) && now - entry.at <= this._staleTtlMs) continue;
            this._cache.delete(key);
            this._counters.cacheSwept++;
        }
    }

    _requestPayloadFor(agent, key = this.getSessionDetailKey(agent)) {
        return {
            key,
            sessionId: agent.id,
            project: agent.projectPath || '',
            provider: agent.provider || this._defaultProvider,
        };
    }

    fetchSessionDetail(agent) {
        if (!agent || !agent.id) return Promise.resolve(null);

        const key = this.getSessionDetailKey(agent);
        const now = Date.now();
        const cached = this._cache.get(key);
        if (cached) {
            const age = now - cached.at;
            if (age <= this._cacheTtlMs) {
                this._counters.cacheHits++;
                return Promise.resolve(cached.value);
            }

            if (age <= this._staleTtlMs) {
                this._counters.cacheStaleHits++;
                if (!this._inFlight.has(key)) {
                    this._counters.staleRefreshStarted++;
                    this._startFetch(key, agent, cached).catch(() => {});
                }
                return Promise.resolve(cached.value);
            }
        }

        if (this._inFlight.has(key)) {
            this._counters.inFlightJoined++;
            return this._inFlight.get(key);
        }

        this._counters.cacheMisses++;
        return this._startFetch(key, agent, cached);
    }

    async fetchSessionDetailsBatch(agents = []) {
        const now = Date.now();
        const results = new Map();
        const requests = [];
        const pendingKeys = [];

        for (const agent of agents) {
            if (!agent?.id) continue;
            const key = this.getSessionDetailKey(agent);
            const cached = this._cache.get(key);
            if (cached && now - cached.at <= this._cacheTtlMs) {
                this._counters.cacheHits++;
                results.set(agent.id, cached.value);
                continue;
            }
            if (cached && now - cached.at <= this._staleTtlMs) {
                this._counters.cacheStaleHits++;
                results.set(agent.id, cached.value);
            }
            if (this._inFlight.has(key)) {
                this._counters.inFlightJoined++;
                pendingKeys.push({ agentId: agent.id, promise: this._inFlight.get(key), fallback: cached?.value || null });
                continue;
            }
            if (!cached) this._counters.cacheMisses++;
            requests.push(this._requestPayloadFor(agent, key));
        }

        const applyPending = async () => {
            for (const pending of pendingKeys) {
                try {
                    const detail = await pending.promise;
                    if (detail) results.set(pending.agentId, detail);
                    else if (pending.fallback) results.set(pending.agentId, pending.fallback);
                } catch {
                    if (pending.fallback) results.set(pending.agentId, pending.fallback);
                }
            }
        };

        if (requests.length === 0) {
            await applyPending();
            return results;
        }

        const requestKey = `batch::${requests.map(item => item.key).sort().join('\n')}`;
        if (this._inFlight.has(requestKey)) {
            this._counters.inFlightJoined++;
            const fetched = await this._inFlight.get(requestKey);
            for (const [agentId, detail] of fetched) results.set(agentId, detail);
            await applyPending();
            return results;
        }

        const controller = new AbortController();
        let didTimeout = false;
        const timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, this._fetchTimeoutMs);
        const fetchPromise = (async () => {
            const fetched = new Map();
            this._counters.batchStarted++;
            try {
                const resp = await fetch('/api/session-details', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: requests }),
                    signal: controller.signal,
                });
                if (!resp.ok) {
                    this._counters.batchFailed++;
                    return fetched;
                }
                const data = await resp.json();
                const details = data.details || {};
                for (const request of requests) {
                    const detail = details[request.key];
                    if (!detail) continue;
                    this._cache.set(request.key, { value: detail, at: Date.now() });
                    fetched.set(request.sessionId, detail);
                }
                this._trimCache();
                this._counters.batchSucceeded++;
            } catch {
                if (didTimeout) this._counters.batchTimedOut++;
                else this._counters.batchFailed++;
                // Keep any stale values already returned to the caller.
            } finally {
                clearTimeout(timeout);
            }
            return fetched;
        })();

        const trackedBatch = fetchPromise.finally(() => this._inFlight.delete(requestKey));
        this._inFlight.set(requestKey, trackedBatch);
        for (const request of requests) {
            let perKeyPromise = null;
            perKeyPromise = trackedBatch
                .then(fetched => fetched.get(request.sessionId) || this._cache.get(request.key)?.value || null)
                .finally(() => {
                    if (this._inFlight.get(request.key) === perKeyPromise) this._inFlight.delete(request.key);
                });
            this._inFlight.set(request.key, perKeyPromise);
        }
        const fetched = await trackedBatch;
        for (const [agentId, detail] of fetched) results.set(agentId, detail);
        await applyPending();
        return results;
    }

    _startFetch(key, agent, fallbackCache) {
        const controller = new AbortController();
        let didTimeout = false;
        const timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, this._fetchTimeoutMs);

        const fetchPromise = (async () => {
            this._counters.fetchStarted++;
            try {
                const params = new URLSearchParams({
                    sessionId: agent.id,
                    project: agent.projectPath || '',
                    provider: agent.provider || this._defaultProvider,
                });
                const resp = await fetch(`/api/session-detail?${params}`, { signal: controller.signal });
                if (!resp.ok) {
                    this._counters.fetchFailed++;
                    return fallbackCache ? fallbackCache.value : null;
                }

                const data = await resp.json();
                this._cache.set(key, { value: data, at: Date.now() });
                this._trimCache();
                this._counters.fetchSucceeded++;
                return data;
            } catch {
                if (didTimeout) this._counters.fetchTimedOut++;
                else this._counters.fetchFailed++;
                if (fallbackCache) return fallbackCache.value;
                return null;
            } finally {
                clearTimeout(timeout);
            }
        })();

        const trackedPromise = fetchPromise.finally(() => this._inFlight.delete(key));
        this._inFlight.set(key, trackedPromise);
        return trackedPromise;
    }
}

export const sessionDetailsService = new SessionDetailsService();
