// Replay offsets use elapsed milliseconds from local midnight, including DST.
import { dayBounds, chronicleDateKey } from './ChronicleLog.js';
import { VILLAGE_GATE } from '../config/townPlan.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { readRecordedDay, RECORDED_TRAIL_INTERVAL_MS } from '../infrastructure/ChronicleStore.js';

const STATUS = new Map([
    ['completed', AgentStatus.COMPLETED],
    ['waiting', AgentStatus.WAITING_ON_USER],
    ['errored', AgentStatus.ERRORED],
    ['rate_limited', AgentStatus.RATE_LIMITED],
    ['resolved', AgentStatus.IDLE],
]);

export async function loadChronicleScenario(dateKey) {
    const bounds = dayBounds(dateKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || chronicleDateKey(bounds.lower) !== dateKey) {
        throw Object.assign(new Error('Invalid Chronicle date'), { code: 'retold-date-invalid' });
    }
    let rows;
    try {
        rows = await readRecordedDay(bounds);
    } catch (cause) {
        throw Object.assign(new Error('Could not read recorded day', { cause }), { code: 'retold-read-failed' });
    }
    if (!rows.samples.some(hasTile)) return null;
    return { ...bounds, scenario: buildChronicleScenario(bounds, rows) };
}

function hasTile(row) {
    return row?.agentId && Number.isFinite(row.tileX) && Number.isFinite(row.tileY);
}

export function buildChronicleScenario({ lower, upper }, { events, samples }) {
    const observations = [];
    for (const row of events) {
        if (row.ts >= lower && row.ts <= upper) observations.push(row);
    }
    // Also accept raw captures. Keep the first observed tile per interval
    // without materializing or sorting a full day's one-second samples.
    const byAgent = new Map();
    for (const row of samples) {
        if (!hasTile(row) || !Number.isFinite(row.ts) || row.ts < lower || row.ts > upper) continue;
        let bins = byAgent.get(row.agentId);
        if (!bins) {
            bins = new Map();
            byAgent.set(row.agentId, bins);
        }
        const bin = Math.floor((row.ts - lower) / RECORDED_TRAIL_INTERVAL_MS);
        const first = bins.get(bin);
        if (!first || row.ts < first.ts) bins.set(bin, row);
    }
    for (const bins of byAgent.values()) for (const row of bins.values()) observations.push(row);
    observations.sort((a, b) => a.ts - b.ts);

    const timeline = [];
    const present = new Map();
    for (const row of observations) {
        const agentId = row.agentId;
        const ts = row.ts - lower;
        const git = row.kind === 'push' || row.kind === 'commit';
        if (git) {
            const gitEvent = {
                id: row.gitKey || row.id, type: row.kind, project: row.project, provider: row.provider,
                label: row.label, sha: row.sha, sessionId: agentId,
            };
            if (row.outcome) gitEvent.status = row.outcome;
            else if (row.gitKey?.endsWith(':landed')) gitEvent.success = true;
            timeline.push({ ts, agentId, event: 'git:event', gitEvent });
        }
        if (!agentId || row.provider === 'git') continue;
        const previous = present.get(agentId);
        if (row.kind === 'departed' || (row.kind === 'completed' && row.sessionEndedAt)) {
            if (previous) timeline.push({ ts, agentId, event: 'agent:remove' });
            present.set(agentId, null);
            continue;
        }
        // The capture loop can sample a departed session during its grace period.
        if (previous === null && row.kind !== 'arrived') continue;
        const sample = !row.kind;
        const position = sample ? { tileX: row.tileX, tileY: row.tileY } : null;
        const status = STATUS.get(row.kind);
        if (!previous) {
            const agent = {
                id: agentId, name: row.agentName || agentId, provider: row.provider || 'unknown',
                projectPath: row.project || null, model: row.model || 'unknown',
                position: position || VILLAGE_GATE.inside, status: status || AgentStatus.IDLE,
                tokens: null,
            };
            timeline.push({ ts, event: 'agent:add', agent });
            present.set(agentId, { ...agent, gateArrival: sample ? null : agent });
        } else {
            if (sample && previous.gateArrival) {
                // The first retained tile identifies this visit's body before it leaves the gate.
                for (const key of ['model', 'provider']) {
                    if (row[key] && previous.gateArrival[key] === 'unknown') {
                        if (previous[key] === 'unknown') previous[key] = row[key];
                        previous.gateArrival[key] = previous[key];
                    }
                }
                previous.gateArrival = null;
            }
            const update = {};
            if (position && (position.tileX !== previous.position.tileX || position.tileY !== previous.position.tileY)) update.position = position;
            if (row.model && row.model !== previous.model) update.model = row.model;
            if (row.provider && row.provider !== previous.provider) update.provider = row.provider;
            if (row.agentName && row.agentName !== previous.name) update.name = row.agentName;
            if (row.project && row.project !== previous.projectPath) update.projectPath = row.project;
            if (status && status !== previous.status) update.status = status;
            if (Object.keys(update).length) {
                timeline.push({ ts, agentId, event: 'agent:observed', update });
                Object.assign(previous, update);
            }
        }
    }
    return { agents: [], timeline };
}
