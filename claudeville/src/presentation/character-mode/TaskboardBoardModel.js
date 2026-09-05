export function resolveTaskboardAgent({ candidates, agentSprites } = {}) {
    if (!Array.isArray(candidates)) return null;
    const spriteFor = typeof agentSprites?.get === 'function'
        ? (id) => agentSprites.get(id)
        : Array.isArray(agentSprites)
            ? (id) => agentSprites.find((sprite) => sprite?.agent?.id === id)
            : () => null;
    for (const candidate of candidates) {
        const id = typeof candidate === 'string' ? candidate.trim() : '';
        if (!id) continue;
        const agent = spriteFor(id)?.agent || null;
        if (!agent || agent.isDeparted || !Array.isArray(agent.todos) || agent.todos.length === 0) continue;
        return agent;
    }
    return null;
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
