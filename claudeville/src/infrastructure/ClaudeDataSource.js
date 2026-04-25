const BASE_URL = window.location.origin;

export class ClaudeDataSource {
    async getSessions() {
        try {
            const res = await fetch(`${BASE_URL}/api/sessions`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.sessions || [];
        } catch (err) {
            console.error('[DataSource] Failed to fetch sessions:', err.message);
            return [];
        }
    }

    async getTeams() {
        try {
            const res = await fetch(`${BASE_URL}/api/teams`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.teams || [];
        } catch (err) {
            console.error('[DataSource] Failed to fetch teams:', err.message);
            return [];
        }
    }

    async getTasks() {
        try {
            const res = await fetch(`${BASE_URL}/api/tasks`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.taskGroups || [];
        } catch (err) {
            console.error('[DataSource] Failed to fetch tasks:', err.message);
            return [];
        }
    }

    async getUsage() {
        try {
            const res = await fetch(`${BASE_URL}/api/usage`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('[DataSource] Failed to fetch usage:', err.message);
            return null;
        }
    }

    async getHistory(lines = 100) {
        try {
            const res = await fetch(`${BASE_URL}/api/history?lines=${lines}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.entries || [];
        } catch (err) {
            console.error('[DataSource] Failed to fetch history:', err.message);
            return [];
        }
    }
}
