const BASE_URL = window.location.origin;

export class ClaudeDataSource {
    async getSessions(options = {}) {
        return this._getJson('/api/sessions', [], 'sessions', (data) => data.sessions || [], options);
    }

    async getTeams(options = {}) {
        return this._getJson('/api/teams', [], 'teams', (data) => data.teams || [], options);
    }

    async getUsage(options = {}) {
        return this._getJson('/api/usage', null, 'usage', null, options);
    }

    async _getJson(path, fallback, label, select, { signal } = {}) {
        try {
            const res = await fetch(`${BASE_URL}${path}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return typeof select === 'function' ? select(data) : data;
        } catch (err) {
            if (err?.name === 'AbortError' || signal?.aborted) return fallback;
            console.error(`[DataSource] Failed to fetch ${label}:`, err.message);
            return fallback;
        }
    }

}
