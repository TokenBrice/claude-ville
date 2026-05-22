const BASE_URL = window.location.origin;

export class ClaudeDataSource {
    async getSessions() {
        return this._getJson('/api/sessions', [], 'sessions', (data) => data.sessions || []);
    }

    async getTeams() {
        return this._getJson('/api/teams', [], 'teams', (data) => data.teams || []);
    }

    async getUsage() {
        return this._getJson('/api/usage', null, 'usage');
    }

    async _getJson(path, fallback, label, select) {
        try {
            const res = await fetch(`${BASE_URL}${path}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return typeof select === 'function' ? select(data) : data;
        } catch (err) {
            console.error(`[DataSource] Failed to fetch ${label}:`, err.message);
            return fallback;
        }
    }

}
