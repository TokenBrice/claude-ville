function agentSpritesList(agentSprites) {
    if (agentSprites instanceof Map) return [...agentSprites.values()];
    return Array.isArray(agentSprites) ? agentSprites : [];
}

function hasTodos(agent) {
    return Boolean(agent
        && !agent.isDeparted
        && Array.isArray(agent.todos)
        && agent.todos.length > 0);
}

function latestActivity(agent) {
    return Math.max(
        Number(agent?.lastActive) || 0,
        Number(agent?.lastSessionActivity) || 0,
    );
}

function todosSignature(todos) {
    if (!Array.isArray(todos)) return '[]';
    return JSON.stringify(todos.map(todo => [
        typeof todo?.subject === 'string' ? todo.subject : '',
        typeof todo?.status === 'string' ? todo.status : '',
    ]));
}

export function resolveTaskboardAgent({
    candidates,
    agentSprites,
    todosUpdatedAt,
} = {}) {
    const sprites = agentSpritesList(agentSprites);
    const spriteFor = typeof agentSprites?.get === 'function'
        ? (id) => agentSprites.get(id)
        : (id) => sprites.find((sprite) => sprite?.agent?.id === id);
    const preferredIds = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const id = typeof candidate === 'string' ? candidate.trim() : '';
        if (!id) continue;
        preferredIds.add(id);
        const agent = spriteFor(id)?.agent || null;
        if (hasTodos(agent)) return agent;
    }

    let fallback = null;
    for (const sprite of sprites) {
        const agent = sprite?.agent || null;
        if (!hasTodos(agent) || preferredIds.has(agent.id)) continue;
        if (!fallback) {
            fallback = agent;
            continue;
        }
        const updatedAt = Number(todosUpdatedAt?.get?.(agent.id)) || 0;
        const fallbackUpdatedAt = Number(todosUpdatedAt?.get?.(fallback.id)) || 0;
        if (
            updatedAt > fallbackUpdatedAt
            || (updatedAt === fallbackUpdatedAt && latestActivity(agent) > latestActivity(fallback))
            || (
                updatedAt === fallbackUpdatedAt
                && latestActivity(agent) === latestActivity(fallback)
                && String(agent.id).localeCompare(String(fallback.id)) < 0
            )
        ) fallback = agent;
    }
    return fallback;
}

export class TaskboardBoardModel {
    constructor({ now = Date.now } = {}) {
        this._now = now;
        this._todoStateByAgent = new Map();
        this.todosUpdatedAt = new Map();
    }

    updateAgentSprites(agentSprites, now = this._now()) {
        const seen = new Set();
        for (const sprite of agentSpritesList(agentSprites)) {
            const agent = sprite?.agent;
            const id = typeof agent?.id === 'string' ? agent.id : '';
            if (!id) continue;
            seen.add(id);
            const signature = todosSignature(agent.todos);
            const previous = this._todoStateByAgent.get(id);
            if (!previous || previous.signature !== signature) {
                this._todoStateByAgent.set(id, { signature });
                this.todosUpdatedAt.set(id, Number(now) || 0);
            }
        }
        for (const id of this._todoStateByAgent.keys()) {
            if (seen.has(id)) continue;
            this._todoStateByAgent.delete(id);
            this.todosUpdatedAt.delete(id);
        }
    }

    resolve({ candidates, agentSprites } = {}) {
        return resolveTaskboardAgent({
            candidates,
            agentSprites,
            todosUpdatedAt: this.todosUpdatedAt,
        });
    }
}

export function taskboardBoardRows(todos, { maxRows = 6 } = {}) {
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const limit = Number.isFinite(Number(maxRows))
        ? Math.max(0, Math.trunc(Number(maxRows)))
        : 6;
    const shaped = todos.flatMap((todo) => {
        if (!todo || typeof todo.subject !== 'string' || !todo.subject) return [];
        const status = typeof todo.status === 'string' ? todo.status : '';
        return [{ subject: todo.subject, status, done: status === 'completed' }];
    });
    if (!shaped.length) return null;
    return {
        rows: shaped.slice(0, limit),
        overflow: Math.max(0, shaped.length - limit),
        done: shaped.reduce((count, row) => count + (row.done ? 1 : 0), 0),
        total: shaped.length,
    };
}
