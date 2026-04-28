class SessionDetailsService {
    constructor() {
        this._defaultProvider = 'claude';
        this._inFlight = new Map();
        this._cache = new Map();
        this._cacheTtlMs = 5000;
        this._staleTtlMs = 15000;
        this._maxCacheEntries = 128;
        this._fetchTimeoutMs = 4000;
    }

    _trimCache() {
        if (this._cache.size <= this._maxCacheEntries) return;

        const toRemove = this._cache.size - this._maxCacheEntries;
        for (let removed = 0; removed < toRemove; removed++) {
            const oldestKey = this._cache.keys().next().value;
            if (!oldestKey) break;
            this._cache.delete(oldestKey);
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
        this._cache.delete(key);
        this._inFlight.delete(key);
    }

    sweep(activeAgents = []) {
        const activeKeys = new Set(activeAgents.map(agent => this.getSessionDetailKey(agent)));
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (activeKeys.has(key) && now - entry.at <= this._staleTtlMs) continue;
            this._cache.delete(key);
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
            if (age <= this._cacheTtlMs) return Promise.resolve(cached.value);

            if (age <= this._staleTtlMs) {
                if (!this._inFlight.has(key)) {
                    this._startFetch(key, agent, cached).catch(() => {});
                }
                return Promise.resolve(cached.value);
            }
        }

        if (this._inFlight.has(key)) {
            return this._inFlight.get(key);
        }

        return this._startFetch(key, agent, cached);
    }

    async fetchSessionDetailsBatch(agents = []) {
        const now = Date.now();
        const results = new Map();
        const requests = [];

        for (const agent of agents) {
            if (!agent?.id) continue;
            const key = this.getSessionDetailKey(agent);
            const cached = this._cache.get(key);
            if (cached && now - cached.at <= this._cacheTtlMs) {
                results.set(agent.id, cached.value);
                continue;
            }
            if (cached && now - cached.at <= this._staleTtlMs) {
                results.set(agent.id, cached.value);
            }
            requests.push(this._requestPayloadFor(agent, key));
        }

        if (requests.length === 0) return results;

        const requestKey = requests.map(item => item.key).sort().join('\n');
        if (this._inFlight.has(requestKey)) {
            const fetched = await this._inFlight.get(requestKey);
            for (const [agentId, detail] of fetched) results.set(agentId, detail);
            return results;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._fetchTimeoutMs);
        const fetchPromise = (async () => {
            const fetched = new Map();
            try {
                const resp = await fetch('/api/session-details', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: requests }),
                    signal: controller.signal,
                });
                if (!resp.ok) return fetched;
                const data = await resp.json();
                const details = data.details || {};
                for (const request of requests) {
                    const detail = details[request.key];
                    if (!detail) continue;
                    this._cache.set(request.key, { value: detail, at: Date.now() });
                    fetched.set(request.sessionId, detail);
                }
                this._trimCache();
            } catch {
                // Keep any stale values already returned to the caller.
            } finally {
                clearTimeout(timeout);
            }
            return fetched;
        })();

        this._inFlight.set(requestKey, fetchPromise.finally(() => this._inFlight.delete(requestKey)));
        const fetched = await fetchPromise;
        for (const [agentId, detail] of fetched) results.set(agentId, detail);
        return results;
    }

    _startFetch(key, agent, fallbackCache) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._fetchTimeoutMs);

        const fetchPromise = (async () => {
            try {
                const params = new URLSearchParams({
                    sessionId: agent.id,
                    project: agent.projectPath || '',
                    provider: agent.provider || this._defaultProvider,
                });
                const resp = await fetch(`/api/session-detail?${params}`, { signal: controller.signal });
                if (!resp.ok) return fallbackCache ? fallbackCache.value : null;

                const data = await resp.json();
                this._cache.set(key, { value: data, at: Date.now() });
                this._trimCache();
                return data;
            } catch {
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
