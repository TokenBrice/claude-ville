const BASE_URL = window.location.origin;
const PROVIDER_HEALTH = new Set(['unavailable', 'empty', 'healthy', 'degraded']);

function normalizeProvider(provider) {
    const value = typeof provider === 'string' ? { id: provider, name: provider } : provider || {};
    const id = String(value.id ?? value.provider ?? value.name ?? 'unknown');
    return {
        id,
        name: String(value.name ?? value.id ?? value.provider ?? 'unknown'),
        health: PROVIDER_HEALTH.has(value.health) ? value.health : 'unavailable',
        sessions: Math.max(0, Number(value.sessions) || 0),
        lastSuccessAt: Number(value.lastSuccessAt) || null,
        skippedLines: Math.max(0, Number(value.skippedLines) || 0),
    };
}

function selectProviders(data) {
    const providers = Array.isArray(data)
        ? data
        : (Array.isArray(data?.providers) ? data.providers : data?.active);
    return (Array.isArray(providers) ? providers : []).map(normalizeProvider);
}

export class ClaudeDataSource {
    async getSessions(options = {}) {
        return this._getJson(
            '/api/sessions',
            [],
            'sessions',
            (data) => data.sessions || [],
            { ...options, rejectOnError: true },
        );
    }

    async getTeams(options = {}) {
        return this._getJson('/api/teams', [], 'teams', (data) => data.teams || [], options);
    }

    async getUsage(options = {}) {
        return this._getJson('/api/usage', null, 'usage', null, options);
    }

    async getProviders(options = {}) {
        return this._getJson('/api/providers', [], 'providers', selectProviders, options);
    }

    async _getJson(path, fallback, label, select, { signal, rejectOnError = false } = {}) {
        try {
            const res = await fetch(`${BASE_URL}${path}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return typeof select === 'function' ? select(data) : data;
        } catch (err) {
            if (rejectOnError) throw err;
            if (err?.name === 'AbortError' || signal?.aborted) return fallback;
            console.error(`[DataSource] Failed to fetch ${label}:`, err.message);
            return fallback;
        }
    }

}
