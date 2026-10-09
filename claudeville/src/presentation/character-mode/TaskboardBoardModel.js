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

/**
 * 4.7 — one compact summary per concurrent plan owner, for the slate's frame
 * tabs. A task list is one session's plan, never a verified project backlog,
 * so summaries are never merged across owners even when two subjects match.
 *
 * Ordering is explicit-first (selected, then pinned, in the order the caller
 * passed them) and then by agent id, so a tab keeps its place while sessions
 * come and go instead of churning with activity.
 */
export function taskboardPlanSummaries({ candidates, agentSprites } = {}) {
    const preferred = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const id = typeof candidate === 'string' ? candidate.trim() : '';
        if (id && !seen.has(id)) {
            seen.add(id);
            preferred.push(id);
        }
    }
    const byId = new Map();
    for (const sprite of agentSpritesList(agentSprites)) {
        const agent = sprite?.agent || null;
        if (!hasTodos(agent) || byId.has(agent.id)) continue;
        let done = 0;
        for (const todo of agent.todos) {
            if (todo?.status === 'completed') done += 1;
        }
        byId.set(agent.id, {
            agentId: agent.id,
            name: String(agent.displayName || agent.name || agent.id),
            done,
            total: agent.todos.length,
            project: String(agent.projectPath || agent.project || agent.teamName || agent.provider || '').trim(),
        });
    }
    const ordered = [];
    for (const id of preferred) {
        const summary = byId.get(id);
        if (summary) {
            ordered.push({ ...summary, preferred: true });
            byId.delete(id);
        }
    }
    const rest = [...byId.values()].sort((a, b) => String(a.agentId).localeCompare(String(b.agentId)));
    for (const summary of rest) ordered.push({ ...summary, preferred: false });
    return ordered;
}

function projectLabel(agent) {
    const raw = String(agent?.projectPath || agent?.project || '').trim();
    const segments = raw.split(/[\\/]+/).filter(Boolean);
    return segments.at(-1) || String(agent?.teamName || agent?.provider || '').trim();
}

/**
 * W7.10a — the fleet rollup the slate shows when nothing selected or pinned
 * owns a plan: one row per live plan (`project · phase · done/total`), most
 * recently changed first (todos change, then session activity, then id).
 * `phase` is the plan's active named phase (the first with work left, else
 * the last); a plan without named phases has none. Two plans in one project
 * are told apart by their owner's name, never merged: a task list is one
 * session's plan, not a project backlog.
 */
export function taskboardFleetRollup({ agentSprites, todosUpdatedAt } = {}) {
    const plans = [];
    const seen = new Set();
    for (const sprite of agentSpritesList(agentSprites)) {
        const agent = sprite?.agent || null;
        if (!hasTodos(agent) || seen.has(agent.id)) continue;
        seen.add(agent.id);
        const groups = groupTodosByPhase(agent.todos);
        const named = groups.filter((group) => group.phase !== null);
        const active = named.find((group) => group.done < group.total) || named.at(-1) || null;
        const done = groups.reduce((count, group) => count + group.done, 0);
        plans.push({
            agentId: agent.id,
            name: String(agent.displayName || agent.name || agent.id),
            project: projectLabel(agent),
            phase: active?.phase || '',
            done,
            total: agent.todos.length,
            updatedAt: Number(todosUpdatedAt?.get?.(agent.id)) || 0,
            activity: latestActivity(agent),
        });
    }
    plans.sort((a, b) => (b.updatedAt - a.updatedAt)
        || (b.activity - a.activity)
        || String(a.agentId).localeCompare(String(b.agentId)));
    const projectCounts = new Map();
    for (const plan of plans) projectCounts.set(plan.project, (projectCounts.get(plan.project) || 0) + 1);
    return plans.map((plan) => {
        const label = plan.project && projectCounts.get(plan.project) === 1 ? plan.project : plan.name;
        return {
            kind: 'plan',
            agentId: plan.agentId,
            text: plan.phase ? `${label} · ${plan.phase}` : label,
            done: plan.done,
            total: plan.total,
        };
    });
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

    /**
     * What the slate shows. Selection wins: a selected or pinned agent with a
     * plan owns the board. Otherwise two or more live plans show the fleet
     * rollup; a lone live plan is the whole fleet, shown in full.
     */
    board({ candidates, agentSprites } = {}) {
        const agent = this.resolve({ candidates, agentSprites });
        if (!agent) return null;
        const ids = Array.isArray(candidates) ? candidates : [];
        if (ids.includes(agent.id)) return { agent, fleet: null };
        const fleet = taskboardFleetRollup({ agentSprites, todosUpdatedAt: this.todosUpdatedAt });
        return fleet.length >= 2 ? { agent: null, fleet } : { agent, fleet: null };
    }

    summaries({ candidates, agentSprites } = {}) {
        return taskboardPlanSummaries({ candidates, agentSprites });
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
            rows.push({ kind: 'more', text: `+${items.length - limit} more`, count: items.length - limit });
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
            rows.push({ kind: 'more', text: `+${group.items.length - limit} more`, count: group.items.length - limit });
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
