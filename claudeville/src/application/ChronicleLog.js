import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';

// The village has always been a live view: look away for forty minutes and
// nothing tells you what happened. Monuments remember commits and biographies
// remember agents, but neither answers "what did I miss?".
//
// ChronicleLog is the town's day book. It records the handful of moments worth
// remembering — who arrived and left, what shipped, what broke, who waited and
// how long — into the ChronicleStore `events` table, where the Chronicle modal
// reads them back as a recap.

export const ChronicleEventKind = Object.freeze({
    ARRIVED: 'arrived',
    DEPARTED: 'departed',
    COMPLETED: 'completed',
    WAITING: 'waiting',
    RESOLVED: 'resolved',
    ERRORED: 'errored',
    RATE_LIMITED: 'rate_limited',
    COMMIT: 'commit',
    PUSH: 'push',
});

// Statuses whose entry is worth a line in the day book, and the kind to log.
const STATUS_EVENTS = {
    [AgentStatus.WAITING_ON_USER]: ChronicleEventKind.WAITING,
    [AgentStatus.ERRORED]: ChronicleEventKind.ERRORED,
    [AgentStatus.RATE_LIMITED]: ChronicleEventKind.RATE_LIMITED,
    [AgentStatus.COMPLETED]: ChronicleEventKind.COMPLETED,
};

function localDateKey(ts) {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function projectName(path) {
    if (!path) return null;
    const parts = String(path).split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
}

// Git events arrive in two shapes: a parsed subject line, and the raw shell
// text the agent actually ran. The Chronicle is prose, so it wants the former,
// and will dig a subject out of the latter rather than print a heredoc.
const SHELL_LOOKING = /^\s*git\b|<<\s*'?EOF|\$\(/;

export function commitSubject(event) {
    const label = String(event?.label || '').trim();
    if (label && !SHELL_LOOKING.test(label)) return label;

    const source = label || String(event?.command || '');
    // `git commit -m "subject"` / `-m 'subject'`
    const flag = source.match(/-m\s+["']([^"'\n]{3,})["']/);
    if (flag && !SHELL_LOOKING.test(flag[1])) return flag[1].trim();
    // Heredoc bodies put the subject on the line after the opener.
    const heredoc = source.match(/<<\s*'?EOF'?\s*\n?\s*([^\n]{3,})/);
    if (heredoc && !SHELL_LOOKING.test(heredoc[1])) return heredoc[1].trim();
    return null;
}

export class ChronicleLog {
    constructor({ store = null } = {}) {
        this.store = store;
        this.running = false;
        this._statusById = new Map();
        this._waitingSince = new Map();
        this._seenGitEvents = new Set();
        this._writeTail = Promise.resolve();
        this._seq = 0;
    }

    start() {
        if (this.running) return this;
        this.running = true;

        this._onAdded = (agent) => {
            this._statusById.set(agent.id, agent.status);
            this.record(ChronicleEventKind.ARRIVED, agent);
            this._noteStatus(agent);
            this._noteGitEvents(agent);
        };
        this._onUpdated = (agent) => {
            this._noteStatus(agent);
            this._noteGitEvents(agent);
        };
        this._onRemoved = (agent) => {
            this._statusById.delete(agent.id);
            this._waitingSince.delete(agent.id);
            this.record(ChronicleEventKind.DEPARTED, agent);
        };

        eventBus.on('agent:added', this._onAdded);
        eventBus.on('agent:updated', this._onUpdated);
        eventBus.on('agent:removed', this._onRemoved);
        return this;
    }

    stop() {
        if (!this.running) return this;
        this.running = false;
        eventBus.off('agent:added', this._onAdded);
        eventBus.off('agent:updated', this._onUpdated);
        eventBus.off('agent:removed', this._onRemoved);
        return this;
    }

    // Only transitions are logged; a status that merely persists across polls
    // would otherwise write a line every two seconds.
    _noteStatus(agent) {
        const previous = this._statusById.get(agent.id);
        const status = agent.status;
        if (previous === status) return;
        this._statusById.set(agent.id, status);

        if (previous === AgentStatus.WAITING_ON_USER) {
            const since = this._waitingSince.get(agent.id);
            this._waitingSince.delete(agent.id);
            if (since) {
                this.record(ChronicleEventKind.RESOLVED, agent, {
                    waitedMs: Math.max(0, Date.now() - since),
                });
            }
        }

        const kind = STATUS_EVENTS[status];
        if (!kind) return;
        if (status === AgentStatus.WAITING_ON_USER) {
            this._waitingSince.set(agent.id, agent.awaitingSince || Date.now());
        }
        this.record(kind, agent, { reason: agent.waitReason || null, tool: agent.pendingTool || null });
    }

    _noteGitEvents(agent) {
        // One commit reaches us twice: once parsed from the tool command and
        // once from the repository scan. Collapse on the commit identity and
        // keep the copy that carries a real subject line rather than the raw
        // `git commit -m "$(cat <<'EOF' ...` shell text.
        const best = new Map();
        for (const event of agent.gitEvents || []) {
            if (!event?.id) continue;
            const key = event.sha || event.commandHash || event.id;
            const existing = best.get(key);
            if (!existing || this._gitEventScore(event) > this._gitEventScore(existing)) {
                best.set(key, event);
            }
        }

        for (const [key, event] of best) {
            if (this._seenGitEvents.has(key)) continue;
            this._seenGitEvents.add(key);
            // Backfilled repository scans surface history, not news; only log
            // what happened while this page was watching.
            const ts = Number(event.completedAt || event.ts || 0);
            if (!ts || Date.now() - ts > 60 * 60 * 1000) continue;
            const kind = event.type === 'push' ? ChronicleEventKind.PUSH : ChronicleEventKind.COMMIT;
            this.record(kind, agent, { label: commitSubject(event), ts, sha: event.sha || null });
        }
        // Keep the dedupe set from growing without bound across a long day.
        if (this._seenGitEvents.size > 2000) {
            this._seenGitEvents = new Set([...this._seenGitEvents].slice(-1000));
        }
    }

    // A commit record is better the more it can say. A readable subject line
    // outweighs everything else: a sha the reader cannot see is worth less than
    // knowing what the commit was.
    _gitEventScore(event) {
        let score = 0;
        if (commitSubject(event)) score += 8;
        if (event.sha) score += 2;
        if (event.observed) score += 1;
        return score;
    }

    record(kind, agent, extra = {}) {
        if (!this.store || !this.running) return;
        const ts = Number(extra.ts) || Date.now();
        const record = {
            id: `${ts}-${this._seq++}-${kind}`,
            ts,
            localDate: localDateKey(ts),
            kind,
            agentId: agent?.id || null,
            agentName: agent?.name || null,
            provider: agent?.provider || null,
            project: projectName(agent?.projectPath),
            ...extra,
        };
        delete record.ts_;
        this._writeTail = this._writeTail
            .then(() => this.store.put('events', record))
            .catch(() => { /* the day book is best effort; never break the app */ });
    }

    /** Events for a local day, oldest first. */
    async readDay(date = new Date()) {
        if (!this.store) return [];
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        try {
            return await this.store.queryRange('events', {
                index: 'ts',
                lower: start.getTime(),
                upper: end.getTime(),
            });
        } catch {
            return [];
        }
    }

    /** Wait for queued writes — used by tests and before reading back. */
    flush() {
        return this._writeTail;
    }
}

/**
 * Roll a day's events into the numbers a recap needs. Pure, so it can be
 * tested without IndexedDB.
 */
export function summarizeDay(events = []) {
    const summary = {
        agents: new Set(),
        projects: new Set(),
        commits: 0,
        pushes: 0,
        completed: 0,
        errors: 0,
        rateLimits: 0,
        waits: 0,
        totalWaitMs: 0,
        longestWaitMs: 0,
        firstTs: null,
        lastTs: null,
    };
    for (const event of events) {
        if (event.agentName) summary.agents.add(event.agentName);
        if (event.project) summary.projects.add(event.project);
        if (summary.firstTs === null || event.ts < summary.firstTs) summary.firstTs = event.ts;
        if (summary.lastTs === null || event.ts > summary.lastTs) summary.lastTs = event.ts;
        switch (event.kind) {
            case ChronicleEventKind.COMMIT: summary.commits++; break;
            case ChronicleEventKind.PUSH: summary.pushes++; break;
            case ChronicleEventKind.COMPLETED: summary.completed++; break;
            case ChronicleEventKind.ERRORED: summary.errors++; break;
            case ChronicleEventKind.RATE_LIMITED: summary.rateLimits++; break;
            case ChronicleEventKind.WAITING: summary.waits++; break;
            case ChronicleEventKind.RESOLVED:
                summary.totalWaitMs += event.waitedMs || 0;
                summary.longestWaitMs = Math.max(summary.longestWaitMs, event.waitedMs || 0);
                break;
            default: break;
        }
    }
    return {
        ...summary,
        agents: [...summary.agents],
        projects: [...summary.projects],
    };
}
