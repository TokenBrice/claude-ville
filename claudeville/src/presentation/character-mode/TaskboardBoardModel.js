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
        typeof todo?.phase === 'string' ? todo.phase : null,
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

export function taskboardCompactCardAnchor({
    buildingCenter,
    spriteAnchor,
    panel,
    zoom = 1,
    renderOffset = { x: 0, y: 0 },
} = {}) {
    const scale = Number(zoom) || 1;
    const worldX = (Number(buildingCenter?.x) || 0)
        - (Number(spriteAnchor?.[0]) || 0)
        + (Number(panel?.x) || 0)
        + (Number(panel?.w) || 0) / 2;
    const worldY = (Number(buildingCenter?.y) || 0)
        - (Number(spriteAnchor?.[1]) || 0)
        + (Number(panel?.y) || 0);
    return {
        x: Math.round(worldX * scale + (Number(renderOffset?.x) || 0)),
        y: Math.round(worldY * scale + (Number(renderOffset?.y) || 0)),
    };
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

    signatureFor(agentId) {
        return this._todoStateByAgent.get(agentId)?.signature || '[]';
    }
}

export function groupTodosByPhase(todos) {
    if (!Array.isArray(todos) || todos.length === 0) return [];
    const groups = [];
    const byPhase = new Map();
    for (const todo of todos) {
        const phase = typeof todo?.phase === 'string' && todo.phase ? todo.phase : null;
        let group = byPhase.get(phase);
        if (!group) {
            group = { phase, items: [], done: 0, total: 0 };
            byPhase.set(phase, group);
            groups.push(group);
        }
        group.items.push(todo);
        group.total += 1;
        if (todo?.status === 'completed') group.done += 1;
    }
    return groups;
}

export function taskboardBoardLayout(todos, { maxItemRows = 6 } = {}) {
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const groups = groupTodosByPhase(todos);
    const done = groups.reduce((count, group) => count + group.done, 0);
    const total = todos.length;
    const limit = Number.isFinite(Number(maxItemRows))
        ? Math.max(0, Math.trunc(Number(maxItemRows)))
        : 6;
    const hasNamedPhase = groups.some((group) => group.phase !== null);
    const rows = [];

    if (!hasNamedPhase) {
        const items = groups[0]?.items || [];
        for (const todo of items.slice(0, limit)) {
            rows.push({
                kind: 'item',
                text: String(todo?.subject || ''),
                status: todo?.status,
            });
        }
        if (items.length > limit) {
            rows.push({ kind: 'more', text: `+${items.length - limit} more` });
        }
        return { done, total, rows };
    }

    let activeIndex = groups.findIndex((group) => group.done < group.total);
    if (activeIndex < 0) activeIndex = groups.length - 1;
    groups.forEach((group, index) => {
        const active = index === activeIndex;
        if (group.phase !== null) {
            rows.push({
                kind: 'phase',
                text: group.phase,
                done: group.done,
                total: group.total,
                active,
            });
        }
        if (!active) return;
        for (const todo of group.items.slice(0, limit)) {
            rows.push({
                kind: 'item',
                text: String(todo?.subject || ''),
                status: todo?.status,
            });
        }
        if (group.items.length > limit) {
            rows.push({ kind: 'more', text: `+${group.items.length - limit} more` });
        }
    });
    return { done, total, rows };
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
