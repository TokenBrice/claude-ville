// AgentSimulator — authored scenarios and read-only Chronicle replays.
//
// Drives the live World with synthetic agents and a scripted tool/event
// timeline so renderer/behavior changes can be exercised without a real CLI
// session. Gated by `?sim=1` or `?retold=<date>` in App; live loads never construct
// this class.
//
// Contract:
//   - Pushes fake agents into `world` directly via `world.addAgent` /
//     `world.updateAgent` (real `Agent` constructor; no adapter, no WS).
//   - Steps a timeline (`[{ ts, agentId, tool|event|status, ... }]`) using
//     timeout offsets, or one frame-driven cursor for a time-lapse.
//   - Calls `world.removeAgent(id)` for every sim agent on `stop()`.
//   - Never writes to `~/.claude` or any session file.

import { ReplayClock } from './ReplayClock.js';
import { Agent } from '../../../domain/entities/Agent.js';
import { AgentStatus } from '../../../domain/value-objects/AgentStatus.js';
import { Position } from '../../../domain/value-objects/Position.js';
import {
    DEFAULT_WORLD_SCENARIO_ID,
    cloneWorldScenario,
} from './WorldScenarios.js';

export {
    DEFAULT_WORLD_SCENARIO_ID,
    getWorldScenario,
    listWorldScenarios,
    WORLD_SCENARIOS,
} from './WorldScenarios.js';

const SIM_DEBUG = false;
const SCENARIO_TIMESTAMP_REBASE_WINDOW_MS = 24 * 60 * 60 * 1000;

function debug(...args) {
    if (SIM_DEBUG) console.info('[AgentSimulator]', ...args);
}

function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function browserScenarioId() {
    try {
        if (typeof location === 'undefined' || !location.search) return null;
        const params = new URLSearchParams(location.search);
        return params.get('scenario') || params.get('simScenario') || null;
    } catch {
        return null;
    }
}

function positionFromSpec(value) {
    const tileX = Number(value?.tileX);
    const tileY = Number(value?.tileY);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    const pos = new Position(tileX, tileY);
    if (value?.surfaceId != null) pos.surfaceId = value.surfaceId;
    return pos;
}

function buildAgent(spec, timeBase, rebase = value => value) {
    const lastSessionActivity = Number.isFinite(Number(spec.lastSessionActivity))
        ? Number(spec.lastSessionActivity)
        : timeBase;
    const agent = new Agent({
        id: spec.id,
        name: spec.name,
        model: spec.model || 'unknown',
        status: spec.status || AgentStatus.IDLE,
        role: spec.role || 'general',
        provider: spec.provider || 'claude',
        teamName: spec.teamName || null,
        projectPath: spec.projectPath === undefined ? '/sim/project' : spec.projectPath,
        agentId: spec.agentId || spec.id,
        agentName: spec.name,
        agentType: spec.agentType || 'main',
        subagentKind: spec.subagentKind,
        parentSessionId: spec.parentId || null,
        workflowId: spec.workflowId || null,
        workflowName: spec.workflowName || null,
        tokens: spec.tokens === undefined ? { input: 0, output: 0 } : spec.tokens,
        cost: spec.cost,
        effort: spec.effort,
        waitReason: spec.waitReason,
        awaitingSince: Number.isFinite(Number(spec.awaitingSince)) && spec.awaitingSince !== null
            ? rebase(Number(spec.awaitingSince))
            : null,
        pendingTool: spec.pendingTool,
        turnState: spec.turnState,
        backgroundPending: spec.backgroundPending
            ? { ...spec.backgroundPending, since: rebase(Number(spec.backgroundPending.since)) }
            : null,
        pendingSince: Number.isFinite(Number(spec.pendingSince)) && spec.pendingSince !== null
            ? rebase(Number(spec.pendingSince))
            : null,
        signalSource: spec.signalSource,
        signalCertainty: spec.signalCertainty,
        signalStale: spec.signalStale,
        signalObservedAt: timeBase - (Number(spec.signalAgeMs) || 0),
        freshness: spec.freshness ? { ...spec.freshness, observedAt: timeBase - (Number(spec.freshness.ageMs) || 0) } : null,
        messages: Array.isArray(spec.messages) ? clonePlain(spec.messages) : [],
        gitEvents: Array.isArray(spec.gitEvents) ? clonePlain(spec.gitEvents) : [],
        workingSet: Array.isArray(spec.workingSet) ? clonePlain(spec.workingSet) : [],
        lastPrompt: spec.lastPrompt ?? null,
        todos: Array.isArray(spec.todos) ? clonePlain(spec.todos) : [],
        gitBranch: spec.gitBranch ?? null,
        lastMessage: spec.lastMessage || null,
        currentTool: spec.currentTool || null,
        currentToolInput: spec.currentToolInput || null,
        lastTool: spec.lastTool || null,
        lastToolInput: spec.lastToolInput || null,
        lastSessionActivity,
        activityAgeMs: 0,
    });
    agent.underlyingProvider = spec.underlyingProvider || null;
    agent.promptDetail = spec.promptDetail || null;
    // Wire fields the client reads off the agent but Agent's constructor does
    // not take (AgentManager assigns them the same way).
    if (spec.agentColor) agent.agentColor = spec.agentColor;
    if (spec.script) agent.script = { ...spec.script, since: rebase(Number(spec.script.since)) };
    const position = positionFromSpec(spec.position);
    if (position) agent.position = position;
    const targetPosition = positionFromSpec(spec.targetPosition);
    if (targetPosition) agent.targetPosition = targetPosition;
    // As live: `lastActive` is the last touch (every WebSocket message stamps
    // it on every agent), never the session's activity time (VB-14).
    agent.lastActive = Date.now();
    return agent;
}

function materializeScenario(input, fallbackId = DEFAULT_WORLD_SCENARIO_ID) {
    if (Array.isArray(input)) {
        const base = cloneWorldScenario(fallbackId);
        base.id = 'custom-timeline';
        base.label = 'Custom timeline';
        base.timeline = clonePlain(input);
        return base;
    }

    if (input && typeof input === 'object') {
        const base = cloneWorldScenario(input.extends || fallbackId);
        const custom = clonePlain(input);
        return {
            ...base,
            ...custom,
            agents: Array.isArray(custom.agents) ? custom.agents : base.agents,
            timeline: Array.isArray(custom.timeline) ? custom.timeline : base.timeline,
            metadata: {
                ...(base.metadata || {}),
                ...(custom.metadata || {}),
            },
        };
    }

    return cloneWorldScenario(input || fallbackId);
}

export default class AgentSimulator {
    constructor({ world, agentManager = null, eventBus = null, scenario = null, scenarioId = null, recordedDay = null, timelapse = false } = {}) {
        if (!world || typeof world.addAgent !== 'function') {
            throw new Error('AgentSimulator requires a World with addAgent()');
        }
        this.world = world;
        this.agentManager = agentManager;
        this.eventBus = eventBus;
        this.recorded = Boolean(recordedDay);
        this.replayClock = timelapse || recordedDay ? new ReplayClock(recordedDay) : null;
        this.pendingGit = [];
        this._scenarioInput = recordedDay?.scenario || scenario || scenarioId || browserScenarioId() || DEFAULT_WORLD_SCENARIO_ID;
        this._scenario = null;
        this._timeBase = Date.now();
        this._scenarioTimeBase = this._timeBase;
        this._preserveScenarioTimestamps = false;
        this._active = false;
        this._timers = [];
        this._agentIds = new Set();
        this._timeline = null;
    }

    isActive() {
        return this._active;
    }

    getScenario() {
        return this._scenario ? clonePlain(this._scenario) : null;
    }

    start(input = null) {
        if (this._active) {
            debug('start() ignored — already active');
            return;
        }
        this._active = true;
        const scenario = this.recorded ? this._scenarioInput : materializeScenario(input || this._scenarioInput);
        this._scenario = scenario;
        const configuredTimeBase = Number(scenario.timeBase);
        const liveTimeBase = Date.now();
        this._scenarioTimeBase = Number.isFinite(configuredTimeBase)
            ? configuredTimeBase
            : liveTimeBase;
        this._preserveScenarioTimestamps = scenario.metadata?.preserveTimestamps === true;
        this._timeBase = this._preserveScenarioTimestamps
            ? this._scenarioTimeBase
            : liveTimeBase;
        this._timeline = scenario.timeline || [];
        if (!this.recorded) this._timeline = [...this._timeline].sort((a, b) => (a.ts || 0) - (b.ts || 0));

        // Seed the cast immediately.
        for (const spec of scenario.agents || []) {
            const agent = buildAgent(spec, this._timeBase, value => this._rebaseScenarioTimestamp(value));
            this.world.addAgent(agent);
            this._agentIds.add(agent.id);
        }
        debug(`seeded ${this._agentIds.size} agents for ${scenario.id}`);

        if (this.replayClock) {
            this.replayClock.reset();
            this._nextStep = 0;
            this._timelineSpan = this.recorded
                ? this.replayClock.end - this.replayClock.start
                : Math.max(this.replayClock.duration, this._timeline.at(-1)?.ts || 0);
            return;
        }
        // Schedule each step against its `ts` offset.
        for (const step of this._timeline) {
            const delay = Math.max(0, Number(step.ts) || 0);
            const handle = setTimeout(() => this._applyStep(step), delay);
            this._timers.push(handle);
        }
    }

    advanceReplay(dt, reduced) {
        if (!this._active || !this.replayClock) return;
        const clock = this.replayClock;
        clock.advance(dt, reduced);
        const offset = clock.playhead / clock.duration * this._timelineSpan;
        while (this._nextStep < this._timeline.length && this._timeline[this._nextStep].ts <= offset) {
            this._applyStep(this._timeline[this._nextStep++]);
        }
    }

    stop() {
        if (!this._active) return;
        this._active = false;
        for (const handle of this._timers) clearTimeout(handle);
        this._timers = [];
        for (const id of Array.from(this._agentIds)) {
            this.world.removeAgent(id);
        }
        this._agentIds.clear();
        this.pendingGit.length = 0;
        this._timeline = null;
        this._scenario = null;
        debug('stopped');
    }

    _applyStep(step) {
        if (!this._active || !step) return;
        try {
            if (step.event === 'subagent:spawn') {
                this._spawnSubagent(step);
                return;
            }
            if (step.event === 'subagent:complete') {
                this._removeAgent(step.agentId);
                return;
            }
            if (step.event === 'agent:add') {
                this._addAgent(step.agent || step);
                return;
            }
            if (step.event === 'agent:remove') {
                this._removeAgent(step.agentId || step.id);
                return;
            }
            if (step.event === 'agent:observed') {
                this.world.updateAgent(step.agentId, step.update);
                return;
            }
            if (this.recorded && step.event === 'git:event') {
                // The harbor consumes this batch even if its session leaves on the same frame.
                const age = (this.replayClock.now - this.replayClock.start - step.ts) / this._timelineSpan * this.replayClock.duration;
                this.pendingGit.push({ ...step.gitEvent, timestamp: Date.now() - Math.max(0, age) });
                return;
            }
            if (step.event === 'git:event') {
                this._applyGitEventStep(step);
                return;
            }
            this._applyToolStep(step);
        } catch (err) {
            debug('step failed', step, err?.message || err);
        }
    }

    _addAgent(spec) {
        if (!spec?.id || this.world.agents.has(spec.id)) return;
        const agent = buildAgent(spec, this.recorded ? Date.now() : this._timeBase, value => this._rebaseScenarioTimestamp(value));
        if (this.recorded) agent.isRecorded = true;
        this.world.addAgent(agent);
        this._agentIds.add(agent.id);
    }

    _spawnSubagent(step) {
        const id = step.subagentId || `${step.parentId || step.agentId}-child`;
        if (this.world.agents.has(id)) return;
        const agent = buildAgent({
            id,
            name: step.agentName || 'Subagent',
            provider: step.provider || 'claude',
            model: step.model || 'claude-sonnet-4-5',
            role: step.subagentType || 'subagent',
            teamName: step.teamName || null,
            agentId: step.agentId || id,
            agentType: step.subagentType || 'subagent',
            parentId: step.parentId || step.agentId,
            status: AgentStatus.WORKING,
            position: step.position || null,
            targetPosition: step.targetPosition || null,
            tokens: step.tokens || { input: 0, output: 0 },
        }, this._stepTime(step));
        this.world.addAgent(agent);
        this._agentIds.add(agent.id);
    }

    _removeAgent(agentId) {
        if (!agentId || !this._agentIds.has(agentId)) return;
        this.world.removeAgent(agentId);
        this._agentIds.delete(agentId);
    }

    _stepTime(step, offset = 0) {
        const explicit = step?.timestamp ?? step?.time;
        if (Number.isFinite(Number(explicit))) return Number(explicit) + offset;
        const ts = Number.isFinite(Number(step?.ts)) ? Number(step.ts) : 0;
        return (this.replayClock ? Date.now() : this._timeBase + ts) + offset;
    }

    _rebaseScenarioTimestamp(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || this._preserveScenarioTimestamps) return timestamp;
        const offset = timestamp - this._scenarioTimeBase;
        if (Math.abs(offset) > SCENARIO_TIMESTAMP_REBASE_WINDOW_MS) return timestamp;
        return this._timeBase + offset;
    }

    _agentById(id) {
        return this.world.agents instanceof Map
            ? this.world.agents.get(id)
            : null;
    }

    _gitEventsFromStep(step, agent) {
        const rawEvents = [];
        if (step.gitEvent) rawEvents.push(step.gitEvent);
        if (Array.isArray(step.gitEvents)) rawEvents.push(...step.gitEvents);
        return rawEvents
            .filter((event) => event && typeof event === 'object')
            .map((event, index) => {
                const explicitTimestamp = Number(event.timestamp ?? event.ts ?? event.time);
                const timestamp = Number.isFinite(explicitTimestamp)
                    ? this._rebaseScenarioTimestamp(explicitTimestamp)
                    : this._stepTime(step, index);
                return {
                    ...clonePlain(event),
                    id: event.id || `${step.agentId}:git:${event.type || event.kind || 'event'}:${this._stepTime(step, index)}`,
                    project: event.project || event.projectPath || agent?.projectPath || '/sim/project',
                    provider: event.provider || agent?.provider || '',
                    timestamp,
                };
            });
    }

    _applyGitEventStep(step) {
        const id = step.agentId;
        if (!id || !this.world.agents.has(id)) return;
        const agent = this._agentById(id);
        const gitEvents = this._gitEventsFromStep(step, agent);
        if (!gitEvents.length) return;
        const updates = {
            gitEvents: [
                ...(Array.isArray(agent?.gitEvents) ? agent.gitEvents : []),
                ...gitEvents,
            ],
            lastSessionActivity: this._stepTime(step),
            activityAgeMs: 0,
        };
        if (step.status) updates.status = step.status;
        if (step.tool) {
            updates.currentTool = step.tool;
            updates.currentToolInput = step.input || null;
            updates.lastTool = step.tool;
            updates.lastToolInput = step.input || null;
        }
        this.world.updateAgent(id, updates);
    }

    _applyToolStep(step) {
        const id = step.agentId;
        if (!id || !this.world.agents.has(id)) return;
        const agent = this._agentById(id);
        const status = step.status || agent?.status || AgentStatus.IDLE;
        const hasFreshTool = step.tool && status === AgentStatus.WORKING;
        const stepTime = this._stepTime(step);
        const updates = {
            status,
            currentTool: hasFreshTool ? step.tool : null,
            currentToolInput: hasFreshTool ? (step.input || null) : null,
            lastTool: step.tool || null,
            lastToolInput: step.input || null,
            lastSessionActivity: stepTime,
            activityAgeMs: 0,
        };
        // For retries, nudge the activity timestamp so AgentEventStream sees a
        // new toolKey (its key incorporates lastSessionActivity).
        if (step.retry) updates.lastSessionActivity = stepTime + 1;
        const position = positionFromSpec(step.position);
        if (position) updates.position = position;
        const targetPosition = positionFromSpec(step.targetPosition);
        if (targetPosition) updates.targetPosition = targetPosition;
        if (step.tokens) updates.tokens = { ...(agent?.tokens || {}), ...step.tokens };
        if (Object.prototype.hasOwnProperty.call(step, 'lastPrompt')) updates.lastPrompt = step.lastPrompt;
        if (Array.isArray(step.todos)) updates.todos = clonePlain(step.todos);
        if (Object.prototype.hasOwnProperty.call(step, 'gitBranch')) updates.gitBranch = step.gitBranch;
        if (Object.prototype.hasOwnProperty.call(step, 'lastMessage')) {
            updates.lastMessage = step.lastMessage;
        }
        const gitEvents = this._gitEventsFromStep(step, agent);
        if (gitEvents.length) {
            updates.gitEvents = [
                ...(Array.isArray(agent?.gitEvents) ? agent.gitEvents : []),
                ...gitEvents,
            ];
        }
        this.world.updateAgent(id, updates);
    }
}
