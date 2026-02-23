const BASE_URL = window.location.origin;

export class ClaudeDataSource {
    async getSessions() {
        try {
            const res = await fetch(`${BASE_URL}/api/sessions`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.sessions || [];
        } catch (err) {
            console.error('[DataSource] 세션 조회 실패:', err.message);
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
            console.error('[DataSource] 팀 조회 실패:', err.message);
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
            console.error('[DataSource] 태스크 조회 실패:', err.message);
            return [];
        }
    }

    async getUsage() {
        try {
            const res = await fetch(`${BASE_URL}/api/usage`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('[DataSource] 사용량 조회 실패:', err.message);
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
            console.error('[DataSource] 히스토리 조회 실패:', err.message);
            return [];
        }
    }
}
