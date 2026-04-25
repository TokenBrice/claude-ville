class SessionDetailsService {
    constructor() {
        this._defaultProvider = 'claude';
        this._inFlight = new Map();
        this._cache = new Map();
        this._cacheTtlMs = 2500;
        this._staleTtlMs = 8000;
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
