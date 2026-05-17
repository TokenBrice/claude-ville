// AgentSimulator — development-only behavior fixture (B-R10).
//
// Drives the live World with synthetic agents and a scripted tool/event
// timeline so renderer/behavior changes can be exercised without a real CLI
// session. Gated by `?sim=1` in `App.js`; production loads never construct
// this class.
//
// Contract:
//   - Pushes 6-12 fake agents into `world` directly via `world.addAgent` /
//     `world.updateAgent` (real `Agent` constructor — no adapter, no WS).
//   - Steps a timeline (`[{ ts, agentId, tool|event|status, ... }]`) using
//     `setTimeout` keyed off step `ts` offsets.
//   - Calls `world.removeAgent(id)` for every sim agent on `stop()`.
//   - Never writes to `~/.claude` or any session file.

import { Agent } from '../../../domain/entities/Agent.js';
import { AgentStatus } from '../../../domain/value-objects/AgentStatus.js';

const SIM_DEBUG = false;

function debug(...args) {
    if (SIM_DEBUG) console.info('[AgentSimulator]', ...args);
}

// Default cast — two main agents, two co-workers, two distinct teams.
// Names are short and unique so renderer chat-pair matching can resolve them.
const DEFAULT_AGENTS = [
    {
        id: 'sim1',
        name: 'Atlas',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        role: 'general',
        teamName: 'Sim Alpha',
        status: AgentStatus.IDLE,
        agentId: 'sim1',
    },
    {
        id: 'sim2',
        name: 'Nova',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        role: 'general',
        teamName: 'Sim Alpha',
        status: AgentStatus.IDLE,
        agentId: 'sim2',
    },
    {
        id: 'codex-sim3',
        name: 'Cipher',
        provider: 'codex',
        model: 'gpt-5',
        role: 'general',
        teamName: null,
        status: AgentStatus.IDLE,
        agentId: 'sim3',
    },
    {
        id: 'sim4',
        name: 'Pixel',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        role: 'general',
        teamName: 'Sim Beta',
        status: AgentStatus.IDLE,
        agentId: 'sim4',
    },
    {
        id: 'sim5',
        name: 'Spark',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        role: 'general',
        teamName: 'Sim Beta',
        status: AgentStatus.IDLE,
        agentId: 'sim5',
    },
    {
        id: 'codex-sim6',
        name: 'Echo',
        provider: 'codex',
        model: 'gpt-5-codex',
        role: 'general',
        teamName: null,
        status: AgentStatus.IDLE,
        agentId: 'sim6',
    },
];

// Default timeline: covers each R10 scenario (chat exchange, subagent
// dispatch, plan-mode toggle, retry, idle→working, completion).
const DEFAULT_TIMELINE = [
    // ts 1000: Atlas starts editing code
    {
        ts: 1000,
        agentId: 'sim1',
        tool: 'Edit',
        input: 'file_path=/src/world/forge.js',
        status: AgentStatus.WORKING,
    },
    // ts 1500: Atlas dispatches a subagent
    {
        ts: 1500,
        agentId: 'sim1',
        event: 'subagent:spawn',
        subagentId: 'subagent-sim1-child',
        subagentType: 'code-reviewer',
        parentId: 'sim1',
        agentName: 'Forge Helper',
    },
    // ts 2000: Nova picks up research work at the Observatory
    {
        ts: 2000,
        agentId: 'sim2',
        tool: 'WebFetch',
        input: 'url=https://docs.example.com/spec',
        status: AgentStatus.WORKING,
    },
    // ts 3000: Cipher enters plan mode
    {
        ts: 3000,
        agentId: 'codex-sim3',
        tool: 'EnterPlanMode',
        input: '',
        status: AgentStatus.WORKING,
    },
    // ts 4000: Atlas sends a chat message to Nova (recipient_name format)
    {
        ts: 4000,
        agentId: 'sim1',
        tool: 'SendMessage',
        input: 'recipient_name=Nova, message=Can you review the spec section?',
        status: AgentStatus.WORKING,
    },
    // ts 4500: Nova replies (chat pair)
    {
        ts: 4500,
        agentId: 'sim2',
        tool: 'SendMessage',
        input: 'recipient_name=Atlas, message=Sure, looking now',
        status: AgentStatus.WORKING,
    },
    // ts 5500: Subagent reports back
    {
        ts: 5500,
        agentId: 'subagent-sim1-child',
        tool: 'Read',
        input: 'file_path=/src/world/forge.js',
        status: AgentStatus.WORKING,
    },
    // ts 6000: Pixel transitions from idle to working (status flip)
    {
        ts: 6000,
        agentId: 'sim4',
        tool: 'Bash',
        input: 'command=npm run dev',
        status: AgentStatus.WORKING,
    },
    // ts 7000: Spark issues a tool, then retries the same tool/input — exercises tool:retried
    {
        ts: 7000,
        agentId: 'sim5',
        tool: 'Bash',
        input: 'command=git push origin main',
        status: AgentStatus.WORKING,
    },
    {
        ts: 7800,
        agentId: 'sim5',
        tool: 'Bash',
        input: 'command=git push origin main',
        status: AgentStatus.WORKING,
        retry: true,
    },
    // ts 8500: Cipher exits plan mode and starts editing
    {
        ts: 8500,
        agentId: 'codex-sim3',
        tool: 'ExitPlanMode',
        input: '',
        status: AgentStatus.WORKING,
    },
    {
        ts: 9000,
        agentId: 'codex-sim3',
        tool: 'apply_patch',
        input: 'path=/src/codex/router.ts',
        status: AgentStatus.WORKING,
    },
    // ts 10000: Echo reads documentation
    {
        ts: 10000,
        agentId: 'codex-sim6',
        tool: 'Read',
        input: 'file_path=/docs/design-decisions.md',
        status: AgentStatus.WORKING,
    },
    // ts 11000: Subagent completes (removed from world)
    {
        ts: 11000,
        agentId: 'subagent-sim1-child',
        event: 'subagent:complete',
    },
    // ts 12000: Atlas finishes its work
    {
        ts: 12000,
        agentId: 'sim1',
        tool: null,
        input: null,
        status: AgentStatus.COMPLETED,
    },
];

function buildAgent(spec) {
    return new Agent({
        id: spec.id,
        name: spec.name,
        model: spec.model || 'unknown',
        status: spec.status || AgentStatus.IDLE,
        role: spec.role || 'general',
        provider: spec.provider || 'claude',
        teamName: spec.teamName || null,
        projectPath: spec.projectPath || '/sim/project',
        agentId: spec.agentId || spec.id,
        agentName: spec.name,
        agentType: spec.agentType || 'main',
        parentSessionId: spec.parentId || null,
        tokens: spec.tokens || { input: 0, output: 0 },
        lastMessage: spec.lastMessage || null,
        currentTool: spec.currentTool || null,
        currentToolInput: spec.currentToolInput || null,
        lastTool: spec.lastTool || null,
        lastToolInput: spec.lastToolInput || null,
        lastSessionActivity: Date.now(),
        activityAgeMs: 0,
    });
}

export default class AgentSimulator {
    constructor({ world, agentManager = null, eventBus = null } = {}) {
        if (!world || typeof world.addAgent !== 'function') {
            throw new Error('AgentSimulator requires a World with addAgent()');
        }
        this.world = world;
        this.agentManager = agentManager;
        this.eventBus = eventBus;
        this._active = false;
        this._timers = [];
        this._agentIds = new Set();
        this._timeline = null;
    }

    isActive() {
        return this._active;
    }

    start(timeline = null) {
        if (this._active) {
            debug('start() ignored — already active');
            return;
        }
        this._active = true;
        this._timeline = Array.isArray(timeline) && timeline.length
            ? [...timeline].sort((a, b) => (a.ts || 0) - (b.ts || 0))
            : [...DEFAULT_TIMELINE];

        // Seed the cast immediately.
        for (const spec of DEFAULT_AGENTS) {
            const agent = buildAgent(spec);
            this.world.addAgent(agent);
            this._agentIds.add(agent.id);
        }
        debug(`seeded ${this._agentIds.size} agents`);

        // Schedule each step against its `ts` offset.
        for (const step of this._timeline) {
            const delay = Math.max(0, Number(step.ts) || 0);
            const handle = setTimeout(() => this._applyStep(step), delay);
            this._timers.push(handle);
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
        this._timeline = null;
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
            this._applyToolStep(step);
        } catch (err) {
            debug('step failed', step, err?.message || err);
        }
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
        });
        this.world.addAgent(agent);
        this._agentIds.add(agent.id);
    }

    _removeAgent(agentId) {
        if (!agentId || !this._agentIds.has(agentId)) return;
        this.world.removeAgent(agentId);
        this._agentIds.delete(agentId);
    }

    _applyToolStep(step) {
        const id = step.agentId;
        if (!id || !this.world.agents.has(id)) return;
        const hasFreshTool = step.tool && step.status === AgentStatus.WORKING;
        const updates = {
            status: step.status || AgentStatus.IDLE,
            currentTool: hasFreshTool ? step.tool : null,
            currentToolInput: hasFreshTool ? (step.input || null) : null,
            lastTool: step.tool || null,
            lastToolInput: step.input || null,
            lastSessionActivity: Date.now(),
            activityAgeMs: 0,
        };
        // For retries, nudge the activity timestamp so AgentEventStream sees a
        // new toolKey (its key incorporates lastSessionActivity).
        if (step.retry) updates.lastSessionActivity = Date.now() + 1;
        this.world.updateAgent(id, updates);
    }
}
