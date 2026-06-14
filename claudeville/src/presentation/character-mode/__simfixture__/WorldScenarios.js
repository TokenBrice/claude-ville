import { AgentStatus } from '../../../domain/value-objects/AgentStatus.js';

export const DEFAULT_WORLD_SCENARIO_ID = 'mixed-tools';
export const SCENARIO_TIME_BASE = Date.UTC(2026, 4, 18, 12, 0, 0);

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const CODEX_MODEL = 'gpt-5-codex';

function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function agentSpec({
    id,
    name,
    provider = 'claude',
    model = CLAUDE_MODEL,
    role = 'general',
    teamName = null,
    status = AgentStatus.IDLE,
    agentId = id,
    agentType = 'main',
    parentId = null,
    projectPath = '/sim/project',
    position = null,
    targetPosition = null,
    currentTool = null,
    currentToolInput = null,
    lastTool = null,
    lastToolInput = null,
    lastMessage = null,
    tokens = { input: 0, output: 0 },
    gitEvents = [],
}) {
    return {
        id,
        name,
        provider,
        model,
        role,
        teamName,
        status,
        agentId,
        agentName: name,
        agentType,
        parentId,
        projectPath,
        position,
        targetPosition,
        currentTool,
        currentToolInput,
        lastTool: lastTool || currentTool,
        lastToolInput: lastToolInput || currentToolInput,
        lastMessage,
        tokens,
        gitEvents,
    };
}

function gitEvent({
    id,
    type,
    project = '/sim/repos/claude-ville',
    branch = 'main',
    targetRef = branch,
    timestampOffset = 0,
    provider = 'claude',
    label = '',
    command = '',
    sha = '',
    success = null,
    exitCode = null,
    stderr = '',
    inferred = false,
    upstream = 'origin/main',
}) {
    return {
        id,
        type,
        project,
        branch,
        targetRef,
        timestamp: SCENARIO_TIME_BASE + timestampOffset,
        provider,
        label,
        command,
        sha,
        success,
        exitCode,
        stderr,
        inferred,
        upstream,
    };
}

const DEFAULT_AGENTS = [
    agentSpec({
        id: 'sim1',
        name: 'Atlas',
        teamName: 'Sim Alpha',
        position: { tileX: 16, tileY: 21 },
    }),
    agentSpec({
        id: 'sim2',
        name: 'Nova',
        teamName: 'Sim Alpha',
        position: { tileX: 23, tileY: 18 },
    }),
    agentSpec({
        id: 'codex-sim3',
        name: 'Cipher',
        provider: 'codex',
        model: 'gpt-5',
        agentId: 'sim3',
        position: { tileX: 27, tileY: 31 },
    }),
    agentSpec({
        id: 'sim4',
        name: 'Pixel',
        teamName: 'Sim Beta',
        position: { tileX: 25, tileY: 30 },
    }),
    agentSpec({
        id: 'sim5',
        name: 'Spark',
        teamName: 'Sim Beta',
        position: { tileX: 29, tileY: 19 },
    }),
    agentSpec({
        id: 'codex-sim6',
        name: 'Echo',
        provider: 'codex',
        model: CODEX_MODEL,
        agentId: 'sim6',
        position: { tileX: 8, tileY: 17 },
    }),
];

const DEFAULT_TIMELINE = [
    {
        ts: 1000,
        agentId: 'sim1',
        tool: 'Edit',
        input: 'file_path=/src/world/forge.js',
        status: AgentStatus.WORKING,
    },
    {
        ts: 1500,
        agentId: 'sim1',
        event: 'subagent:spawn',
        subagentId: 'subagent-sim1-child',
        subagentType: 'code-reviewer',
        parentId: 'sim1',
        agentName: 'Forge Helper',
        position: { tileX: 25, tileY: 28 },
    },
    {
        ts: 2000,
        agentId: 'sim2',
        tool: 'WebFetch',
        input: 'url=https://docs.example.com/spec',
        status: AgentStatus.WORKING,
    },
    {
        ts: 3000,
        agentId: 'codex-sim3',
        tool: 'EnterPlanMode',
        input: '',
        status: AgentStatus.WORKING,
    },
    {
        ts: 4000,
        agentId: 'sim1',
        tool: 'SendMessage',
        input: 'recipient_name=Nova, message=Can you review the spec section?',
        status: AgentStatus.WORKING,
    },
    {
        ts: 4500,
        agentId: 'sim2',
        tool: 'SendMessage',
        input: 'recipient_name=Atlas, message=Sure, looking now',
        status: AgentStatus.WORKING,
    },
    {
        ts: 5500,
        agentId: 'subagent-sim1-child',
        tool: 'Read',
        input: 'file_path=/src/world/forge.js',
        status: AgentStatus.WORKING,
    },
    {
        ts: 6000,
        agentId: 'sim4',
        tool: 'Bash',
        input: 'command=npm run dev',
        status: AgentStatus.WORKING,
    },
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
    {
        ts: 10000,
        agentId: 'codex-sim6',
        tool: 'Read',
        input: 'file_path=/docs/design-decisions.md',
        status: AgentStatus.WORKING,
    },
    {
        ts: 11000,
        agentId: 'subagent-sim1-child',
        event: 'subagent:complete',
    },
    {
        ts: 12000,
        agentId: 'sim1',
        tool: null,
        input: null,
        status: AgentStatus.COMPLETED,
    },
];

export const NO_AGENTS_SCENARIO = {
    id: 'no-agents',
    label: 'No agents',
    description: 'Empty World mode state for baseline map, labels, lighting, and idle harbor checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [],
    timeline: [],
    metadata: {
        qaTags: ['empty', 'baseline-map', 'labels'],
        expectedAgentCount: 0,
        camera: { centerTile: { tileX: 20, tileY: 22 }, zoom: 2.35 },
    },
};

export const ONE_WORKING_AGENT_SCENARIO = {
    id: 'one-working-agent',
    label: 'One working agent',
    description: 'Single deterministic worker moving through read, edit, shell, and completion states.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-one-worker',
            name: 'Solo',
            status: AgentStatus.WORKING,
            currentTool: 'Read',
            currentToolInput: 'file_path=/claudeville/src/presentation/character-mode/AgentSprite.js',
            position: { tileX: 8, tileY: 17 },
            projectPath: '/sim/repos/solo',
            tokens: { input: 4200, output: 900 },
        }),
    ],
    timeline: [
        {
            ts: 1200,
            agentId: 'sim-one-worker',
            tool: 'Edit',
            input: 'file_path=/claudeville/src/presentation/character-mode/AgentSprite.js',
            status: AgentStatus.WORKING,
        },
        {
            ts: 2800,
            agentId: 'sim-one-worker',
            tool: 'Bash',
            input: 'command=node --check claudeville/src/presentation/character-mode/AgentSprite.js',
            status: AgentStatus.WORKING,
        },
        {
            ts: 4400,
            agentId: 'sim-one-worker',
            tool: null,
            input: null,
            status: AgentStatus.COMPLETED,
            lastMessage: 'Syntax check passed',
        },
    ],
    metadata: {
        qaTags: ['single-agent', 'tool-bubble', 'completion'],
        selectedAgentId: 'sim-one-worker',
        camera: { centerTile: { tileX: 14, tileY: 20 }, zoom: 2.8 },
    },
};

const DENSE_NAMES = [
    'Atlas', 'Nova', 'Cipher', 'Pixel', 'Spark', 'Echo',
    'Flux', 'Helix', 'Onyx', 'Prism', 'Qubit', 'Rune',
    'Sage', 'Vex', 'Lyra', 'Orion', 'Mira', 'Vale',
    'Kite', 'Sol', 'Pax', 'Iris', 'Quill', 'Wren',
];

const DENSE_TOOLS = [
    { tool: 'Read', input: 'file_path=/docs/design-decisions.md' },
    { tool: 'Edit', input: 'file_path=/claudeville/src/presentation/character-mode/AgentSprite.js' },
    { tool: 'Bash', input: 'command=npm run dev' },
    { tool: 'WebFetch', input: 'url=https://docs.example.com/api' },
    { tool: 'SendMessage', input: 'recipient_name=Atlas, message=Sync on the fixture pass' },
    { tool: 'Task', input: 'description=Audit label density' },
    { tool: 'apply_patch', input: 'path=/claudeville/src/presentation/character-mode/VisitIntentManager.js' },
    { tool: 'Grep', input: 'pattern=HarborTraffic path=claudeville/src' },
];

function denseAgentName(index) {
    const baseName = DENSE_NAMES[index % DENSE_NAMES.length];
    const generation = Math.floor(index / DENSE_NAMES.length);
    return generation > 0 ? `${baseName} ${generation + 1}` : baseName;
}

function denseAgentPosition(index) {
    const column = index % 12;
    const row = Math.floor(index / 12) % 7;
    const band = Math.floor(index / 84);
    return {
        tileX: 6 + column * 2.55 + band * 0.45,
        tileY: 12 + row * 3.2 + band * 0.35,
    };
}

function denseTeamName(index) {
    return `Dense ${String.fromCharCode(65 + (Math.floor(index / 12) % 5))}`;
}

function buildDenseAgents(count = DENSE_NAMES.length) {
    return Array.from({ length: count }, (_, index) => {
        const name = denseAgentName(index);
        const tool = DENSE_TOOLS[index % DENSE_TOOLS.length];
        const provider = index % 3 === 0 ? 'codex' : 'claude';
        const isWorking = index % 5 !== 0;
        return agentSpec({
            id: `${provider}-dense-${String(index + 1).padStart(2, '0')}`,
            name,
            provider,
            model: provider === 'codex' ? CODEX_MODEL : CLAUDE_MODEL,
            teamName: denseTeamName(index),
            status: isWorking ? AgentStatus.WORKING : AgentStatus.IDLE,
            currentTool: isWorking ? tool.tool : null,
            currentToolInput: isWorking ? tool.input : null,
            lastTool: tool.tool,
            lastToolInput: tool.input,
            position: denseAgentPosition(index),
            projectPath: `/sim/repos/dense-${(index % 4) + 1}`,
            tokens: { input: 1000 + index * 83, output: 300 + index * 29 },
        });
    });
}

function buildDenseTimeline(count = DENSE_NAMES.length) {
    return Array.from({ length: count }, (_, index) => {
        const provider = index % 3 === 0 ? 'codex' : 'claude';
        const id = `${provider}-dense-${String(index + 1).padStart(2, '0')}`;
        const tool = DENSE_TOOLS[(index + 2) % DENSE_TOOLS.length];
        return {
            ts: 900 + index * 220,
            agentId: id,
            tool: tool.tool,
            input: tool.input,
            status: AgentStatus.WORKING,
        };
    });
}

export const DENSE_AGENTS_SCENARIO = {
    id: 'dense-24-agents',
    label: 'Dense 24 agents',
    description: 'Twenty-four deterministic agents for label density, visit allocation, and crowd readability.',
    timeBase: SCENARIO_TIME_BASE,
    agents: buildDenseAgents(),
    timeline: buildDenseTimeline(),
    metadata: {
        qaTags: ['dense-agents', 'label-density', 'visit-capacity'],
        expectedAgentCount: 24,
        camera: { centerTile: { tileX: 20, tileY: 25 }, zoom: 2.15 },
    },
};

export const DENSE_100_AGENTS_SCENARIO = {
    id: 'dense-100-agents',
    label: 'Dense 100 agents',
    description: 'One hundred deterministic agents for Phase 7 crowd clustering, local avoidance, and minimap stress checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: buildDenseAgents(100),
    timeline: buildDenseTimeline(100),
    metadata: {
        qaTags: ['dense-agents', 'label-density', 'visit-capacity', 'crowd-100'],
        expectedAgentCount: 100,
        camera: { centerTile: { tileX: 20, tileY: 24 }, zoom: 1.72 },
    },
};

export const PARENT_SUBAGENTS_SCENARIO = {
    id: 'parent-subagents',
    label: 'Parent and subagents',
    description: 'Parent session dispatches deterministic child agents and then retires one child.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-parent',
            name: 'Prime',
            status: AgentStatus.WORKING,
            currentTool: 'Task',
            currentToolInput: 'description=Review World mode changes',
            position: { tileX: 16, tileY: 21 },
            projectPath: '/sim/repos/parent',
        }),
    ],
    timeline: [
        {
            ts: 800,
            agentId: 'sim-parent',
            event: 'subagent:spawn',
            subagentId: 'sim-parent-reviewer',
            subagentType: 'code-reviewer',
            parentId: 'sim-parent',
            agentName: 'Review',
            position: { tileX: 14, tileY: 21 },
        },
        {
            ts: 1200,
            agentId: 'sim-parent',
            event: 'subagent:spawn',
            subagentId: 'sim-parent-researcher',
            subagentType: 'researcher',
            parentId: 'sim-parent',
            agentName: 'Scout',
            position: { tileX: 23, tileY: 18 },
        },
        {
            ts: 2600,
            agentId: 'sim-parent-reviewer',
            tool: 'Read',
            input: 'file_path=/claudeville/src/presentation/character-mode/VisitTileAllocator.js',
            status: AgentStatus.WORKING,
        },
        {
            ts: 3400,
            agentId: 'sim-parent-researcher',
            tool: 'WebFetch',
            input: 'url=https://docs.example.com/world-qa',
            status: AgentStatus.WORKING,
        },
        {
            ts: 5200,
            agentId: 'sim-parent-reviewer',
            event: 'subagent:complete',
        },
    ],
    metadata: {
        qaTags: ['subagents', 'parent-child', 'summon'],
        selectedAgentId: 'sim-parent',
        camera: { centerTile: { tileX: 18, tileY: 20 }, zoom: 2.65 },
    },
};

export const TEAM_GATHER_SCENARIO = {
    id: 'team-gather',
    label: 'Team gather',
    description: 'A named team coordinates around Command and Task Board visit tiles.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({ id: 'sim-team-a', name: 'Anchor', teamName: 'Gather Blue', position: { tileX: 16, tileY: 21 } }),
        agentSpec({ id: 'sim-team-b', name: 'Beacon', teamName: 'Gather Blue', position: { tileX: 14, tileY: 21 } }),
        agentSpec({ id: 'sim-team-c', name: 'Cobalt', teamName: 'Gather Blue', position: { tileX: 18, tileY: 21 } }),
        agentSpec({ id: 'sim-team-d', name: 'Delta', teamName: 'Gather Blue', position: { tileX: 23, tileY: 35 } }),
        agentSpec({ id: 'sim-team-e', name: 'Ember', teamName: 'Gather Blue', position: { tileX: 21, tileY: 35 } }),
    ],
    timeline: [
        {
            ts: 700,
            agentId: 'sim-team-a',
            tool: 'TeamCreate',
            input: 'team_name=Gather Blue',
            status: AgentStatus.WORKING,
        },
        {
            ts: 1400,
            agentId: 'sim-team-b',
            tool: 'SendMessage',
            input: 'recipient_name=Anchor, message=Ready at Command',
            status: AgentStatus.WORKING,
        },
        {
            ts: 2100,
            agentId: 'sim-team-d',
            tool: 'SendMessage',
            input: 'recipient_name=Gather Blue, message=Task Board is clear',
            status: AgentStatus.WORKING,
        },
    ],
    metadata: {
        qaTags: ['team', 'gather', 'chat'],
        gatherBuilding: 'command',
        selectedAgentId: 'sim-team-a',
        camera: { centerTile: { tileX: 19, tileY: 24 }, zoom: 2.55 },
    },
};

export const MIXED_TOOLS_SCENARIO = {
    id: 'mixed-tools',
    label: 'Mixed tools',
    description: 'Default simulator scenario covering common World mode tool/status transitions.',
    timeBase: SCENARIO_TIME_BASE,
    agents: DEFAULT_AGENTS,
    timeline: DEFAULT_TIMELINE,
    metadata: {
        qaTags: ['mixed-tools', 'chat', 'retry', 'plan-mode', 'subagent'],
        selectedAgentId: 'sim1',
        camera: { centerTile: { tileX: 20, tileY: 23 }, zoom: 2.45 },
    },
};

const GIT_EVENTS = [
    gitEvent({
        id: 'git-commit-1',
        type: 'commit',
        timestampOffset: 1000,
        label: 'Add world guardrail fixtures',
        command: 'git commit -m "Add world guardrail fixtures"',
        sha: '61f10ef0c447e43a1199439fd7d78cdda7fa5b31',
    }),
    gitEvent({
        id: 'git-push-1',
        type: 'push',
        timestampOffset: 2600,
        command: 'git push origin main',
        success: true,
        exitCode: 0,
    }),
    gitEvent({
        id: 'git-fetch-1',
        type: 'fetch',
        timestampOffset: 4100,
        command: 'git fetch upstream main',
        inferred: true,
        upstream: 'upstream/main',
    }),
    gitEvent({
        id: 'git-pull-1',
        type: 'pull',
        timestampOffset: 5600,
        command: 'git pull --ff-only upstream main',
        upstream: 'upstream/main',
    }),
];

export const GIT_HARBOR_SCENARIO = {
    id: 'git-harbor',
    label: 'Git harbor',
    description: 'Commit, push, fetch, and pull sequence for future harbor reducer and ship checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-git-captain',
            name: 'Mariner',
            status: AgentStatus.WORKING,
            currentTool: 'Bash',
            currentToolInput: 'command=git status --short',
            position: { tileX: 29, tileY: 19 },
            projectPath: '/sim/repos/claude-ville',
        }),
    ],
    timeline: [
        {
            ts: 1000,
            agentId: 'sim-git-captain',
            tool: 'Bash',
            input: 'command=git commit -m "Add world guardrail fixtures"',
            status: AgentStatus.WORKING,
            gitEvent: GIT_EVENTS[0],
        },
        {
            ts: 2600,
            agentId: 'sim-git-captain',
            tool: 'Bash',
            input: 'command=git push origin main',
            status: AgentStatus.WORKING,
            gitEvent: GIT_EVENTS[1],
        },
        {
            ts: 4100,
            agentId: 'sim-git-captain',
            tool: 'Bash',
            input: 'command=git fetch upstream main',
            status: AgentStatus.WORKING,
            gitEvent: GIT_EVENTS[2],
        },
        {
            ts: 5600,
            agentId: 'sim-git-captain',
            tool: 'Bash',
            input: 'command=git pull --ff-only upstream main',
            status: AgentStatus.WORKING,
            gitEvent: GIT_EVENTS[3],
        },
    ],
    metadata: {
        qaTags: ['git', 'harbor', 'commit', 'push', 'fetch', 'pull'],
        selectedAgentId: 'sim-git-captain',
        expectedGitEventTypes: ['commit', 'push', 'fetch', 'pull'],
        camera: { centerTile: { tileX: 34, tileY: 20 }, zoom: 2.55 },
    },
};

const FAILED_PUSH_EVENT = gitEvent({
    id: 'git-push-failed-1',
    type: 'push',
    timestampOffset: 1800,
    command: 'git push origin main',
    success: false,
    exitCode: 1,
    stderr: 'rejected: failed to push some refs to origin',
});

export const FAILED_PUSH_SCENARIO = {
    id: 'failed-push',
    label: 'Failed push',
    description: 'Rejected push event for watchtower alert, harbor return, and failure label checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-failed-push',
            name: 'Harbor',
            status: AgentStatus.WORKING,
            currentTool: 'Bash',
            currentToolInput: 'command=git push origin main',
            position: { tileX: 28, tileY: 20 },
            projectPath: '/sim/repos/failure',
        }),
    ],
    timeline: [
        {
            ts: 1800,
            agentId: 'sim-failed-push',
            tool: 'Bash',
            input: 'command=git push origin main',
            status: AgentStatus.WORKING,
            gitEvent: FAILED_PUSH_EVENT,
        },
        {
            ts: 3600,
            agentId: 'sim-failed-push',
            tool: null,
            input: null,
            status: AgentStatus.WAITING,
            lastMessage: 'Push rejected',
        },
    ],
    metadata: {
        qaTags: ['git', 'failed-push', 'watchtower-alert'],
        selectedAgentId: 'sim-failed-push',
        expectedPushStatus: 'rejected',
        camera: { centerTile: { tileX: 32, tileY: 18 }, zoom: 2.6 },
    },
};

export const WAITING_ON_USER_SCENARIO = {
    id: 'waiting-on-user',
    label: 'Waiting on user',
    description: 'Command-side input wait for amber bell, Director incident, and ActivityPanel attention checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-user-bell',
            name: 'Bellkeep',
            status: AgentStatus.WAITING_ON_USER,
            currentTool: 'request_user_input',
            currentToolInput: 'question=Approve the deployment window?',
            position: { tileX: 16, tileY: 21 },
            projectPath: '/sim/repos/input-wait',
        }),
        agentSpec({
            id: 'sim-user-support',
            name: 'Scribe',
            status: AgentStatus.WORKING,
            currentTool: 'Read',
            currentToolInput: 'file_path=docs/release-notes.md',
            position: { tileX: 9, tileY: 18 },
            projectPath: '/sim/repos/input-wait',
        }),
    ],
    timeline: [
        {
            ts: 1200,
            agentId: 'sim-user-bell',
            tool: 'request_user_input',
            input: 'question=Approve the deployment window?',
            status: AgentStatus.WAITING_ON_USER,
            lastMessage: 'Waiting for approval',
        },
    ],
    metadata: {
        qaTags: ['waiting-on-user', 'director-incident', 'command-bell'],
        selectedAgentId: 'sim-user-bell',
        camera: { centerTile: { tileX: 18, tileY: 22 }, zoom: 2.7 },
    },
};

export const QUOTA_RATE_LIMIT_SCENARIO = {
    id: 'quota-rate-limit',
    label: 'Quota rate limit',
    description: 'Mine-side quota pressure and rate-limit state for weather, incident, and building-signal checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-quota-watch',
            name: 'Gauge',
            status: AgentStatus.RATE_LIMITED,
            currentTool: 'Bash',
            currentToolInput: 'command=claude usage --quota --tokens --rate-limit',
            position: { tileX: 12, tileY: 34 },
            projectPath: '/sim/repos/quota',
            tokens: { input: 180000, output: 24000, contextWindow: 176000, contextWindowMax: 200000 },
        }),
        agentSpec({
            id: 'sim-quota-runner',
            name: 'Runner',
            status: AgentStatus.WORKING,
            currentTool: 'Bash',
            currentToolInput: 'command=check token burn and usage budget',
            position: { tileX: 14, tileY: 35 },
            projectPath: '/sim/repos/quota',
            tokens: { input: 120000, output: 12000, contextWindow: 150000, contextWindowMax: 200000 },
        }),
    ],
    timeline: [
        {
            ts: 1000,
            agentId: 'sim-quota-watch',
            tool: 'Bash',
            input: 'command=claude usage --quota --tokens --rate-limit',
            status: AgentStatus.RATE_LIMITED,
            lastMessage: 'Rate limit window active',
        },
        {
            ts: 2200,
            agentId: 'sim-quota-runner',
            tool: 'Bash',
            input: 'command=check token burn and usage budget',
            status: AgentStatus.WORKING,
        },
    ],
    metadata: {
        qaTags: ['quota', 'rate-limited', 'mine', 'director-incident', 'weather-nudge'],
        selectedAgentId: 'sim-quota-watch',
        selectedBuildingType: 'mine',
        camera: { centerTile: { tileX: 13, tileY: 34 }, zoom: 2.75 },
    },
};

export const RELEASE_PARADE_SCENARIO = {
    id: 'release-parade',
    label: 'Release parade',
    description: 'Harbor release celebration triggered from scenario metadata for parade and banner checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-release-captain',
            name: 'Banneret',
            status: AgentStatus.WORKING,
            currentTool: 'Bash',
            currentToolInput: 'command=git tag v0.12.0 && git push origin v0.12.0',
            position: { tileX: 30, tileY: 19 },
            projectPath: '/sim/repos/release',
        }),
    ],
    timeline: [
        {
            ts: 1600,
            agentId: 'sim-release-captain',
            tool: 'Bash',
            input: 'command=git tag v0.12.0 && git push origin v0.12.0',
            status: AgentStatus.WORKING,
            gitEvent: gitEvent({
                id: 'git-release-tag-1',
                type: 'push',
                timestampOffset: 1600,
                command: 'git push origin v0.12.0',
                targetRef: 'refs/tags/v0.12.0',
                success: true,
                exitCode: 0,
            }),
        },
    ],
    metadata: {
        qaTags: ['release', 'parade', 'harbor', 'director-scene'],
        selectedAgentId: 'sim-release-captain',
        releaseParade: { label: 'v0.12.0', version: 'v0.12.0', weight: 'major' },
        camera: { centerTile: { tileX: 31, tileY: 20 }, zoom: 2.55 },
    },
};

export const BUILDING_INSPECTION_REPLAY_SCENARIO = {
    id: 'building-inspection-replay',
    label: 'Building inspection replay',
    description: 'Selected Command building plus active replay trails for route preview and Signal panel QA.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-inspect-lead',
            name: 'Marshal',
            teamName: 'Inspection',
            status: AgentStatus.WORKING,
            currentTool: 'spawn_agent',
            currentToolInput: 'agent_type=worker, task=review command queue',
            position: { tileX: 16, tileY: 21 },
            projectPath: '/sim/repos/inspection',
        }),
        agentSpec({
            id: 'sim-inspect-runner',
            name: 'Courier',
            teamName: 'Inspection',
            status: AgentStatus.WORKING,
            currentTool: 'SendMessage',
            currentToolInput: 'recipient_name=Marshal, message=Command queue is ready',
            position: { tileX: 15, tileY: 22 },
            targetPosition: { tileX: 16, tileY: 21 },
            projectPath: '/sim/repos/inspection',
        }),
        agentSpec({
            id: 'sim-inspect-scribe',
            name: 'Ledger',
            teamName: 'Inspection',
            status: AgentStatus.WAITING,
            currentTool: 'wait_agent',
            currentToolInput: 'targets=[sim-inspect-runner]',
            position: { tileX: 18, tileY: 21 },
            targetPosition: { tileX: 16, tileY: 21 },
            projectPath: '/sim/repos/inspection',
        }),
    ],
    timeline: [
        {
            ts: 900,
            agentId: 'sim-inspect-lead',
            tool: 'spawn_agent',
            input: 'agent_type=worker, task=review command queue',
            status: AgentStatus.WORKING,
            position: { tileX: 16, tileY: 21 },
        },
        {
            ts: 1700,
            agentId: 'sim-inspect-runner',
            tool: 'SendMessage',
            input: 'recipient_name=Marshal, message=Command queue is ready',
            status: AgentStatus.WORKING,
            position: { tileX: 16.5, tileY: 21.4 },
        },
        {
            ts: 2500,
            agentId: 'sim-inspect-scribe',
            tool: 'wait_agent',
            input: 'targets=[sim-inspect-runner]',
            status: AgentStatus.WAITING,
            position: { tileX: 17.2, tileY: 21.6 },
        },
    ],
    metadata: {
        qaTags: ['building-signal', 'inspection', 'replay', 'routes', 'handoff'],
        selectedAgentId: 'sim-inspect-lead',
        selectedBuildingType: 'command',
        replayActive: true,
        camera: { centerTile: { tileX: 16, tileY: 21 }, zoom: 2.8 },
    },
};

export const SELECTED_BEHIND_BUILDING_SCENARIO = {
    id: 'selected-behind-building',
    label: 'Selected behind building',
    description: 'Selected agent starts behind the Command Center sprite for occlusion and label checks.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-selected-hidden',
            name: 'Hidden',
            status: AgentStatus.WORKING,
            currentTool: 'Read',
            currentToolInput: 'file_path=/claudeville/src/config/buildings.js',
            position: { tileX: 15.4, tileY: 17.2 },
            projectPath: '/sim/repos/occlusion',
        }),
        agentSpec({
            id: 'sim-selected-anchor',
            name: 'Marker',
            status: AgentStatus.IDLE,
            position: { tileX: 18, tileY: 21 },
            projectPath: '/sim/repos/occlusion',
        }),
    ],
    timeline: [
        {
            ts: 1800,
            agentId: 'sim-selected-hidden',
            tool: 'Read',
            input: 'file_path=/claudeville/src/config/buildings.js',
            status: AgentStatus.WORKING,
            position: { tileX: 15.4, tileY: 17.2 },
        },
    ],
    metadata: {
        qaTags: ['selected-agent', 'occlusion', 'building-split'],
        selectedAgentId: 'sim-selected-hidden',
        occludingBuilding: 'command',
        camera: { centerTile: { tileX: 15.5, tileY: 18.5 }, zoom: 3.0 },
    },
};

export const STORM_NIGHT_REDUCED_MOTION_SCENARIO = {
    id: 'storm-night-reduced-motion',
    label: 'Storm night reduced motion',
    description: 'Metadata-heavy atmosphere fixture for night, storm, and reduced-motion QA.',
    timeBase: SCENARIO_TIME_BASE,
    agents: [
        agentSpec({
            id: 'sim-storm-watch',
            name: 'Lantern',
            status: AgentStatus.WORKING,
            currentTool: 'Bash',
            currentToolInput: 'command=git fetch upstream main',
            position: { tileX: 28, tileY: 14 },
            projectPath: '/sim/repos/weather',
        }),
        agentSpec({
            id: 'sim-storm-dock',
            name: 'Dock',
            status: AgentStatus.WAITING,
            position: { tileX: 29, tileY: 19 },
            projectPath: '/sim/repos/weather',
        }),
    ],
    timeline: [
        {
            ts: 2000,
            agentId: 'sim-storm-watch',
            tool: 'Bash',
            input: 'command=git fetch upstream main',
            status: AgentStatus.WORKING,
            gitEvent: gitEvent({
                id: 'git-fetch-storm-1',
                type: 'fetch',
                timestampOffset: 2000,
                command: 'git fetch upstream main',
                inferred: true,
                upstream: 'upstream/main',
            }),
        },
    ],
    metadata: {
        qaTags: ['night', 'storm', 'reduced-motion', 'weather'],
        selectedAgentId: 'sim-storm-watch',
        reducedMotion: true,
        atmosphere: {
            phase: 'night',
            clock: { hours: 23, minutes: 40, seconds: 0, label: '23:40', phase: 'night' },
            weather: {
                type: 'storm',
                intensity: 0.86,
                precipitation: 0.92,
                fog: 0.34,
                cloudCover: 0.95,
                windX: -0.44,
                seed: 20260518,
            },
            motion: { motionScale: 0, particleEnabled: false, reducedMotion: true },
        },
        camera: { centerTile: { tileX: 31, tileY: 17 }, zoom: 2.55 },
    },
};

export const WORLD_SCENARIOS = [
    NO_AGENTS_SCENARIO,
    ONE_WORKING_AGENT_SCENARIO,
    DENSE_AGENTS_SCENARIO,
    DENSE_100_AGENTS_SCENARIO,
    PARENT_SUBAGENTS_SCENARIO,
    TEAM_GATHER_SCENARIO,
    MIXED_TOOLS_SCENARIO,
    GIT_HARBOR_SCENARIO,
    FAILED_PUSH_SCENARIO,
    WAITING_ON_USER_SCENARIO,
    QUOTA_RATE_LIMIT_SCENARIO,
    RELEASE_PARADE_SCENARIO,
    BUILDING_INSPECTION_REPLAY_SCENARIO,
    SELECTED_BEHIND_BUILDING_SCENARIO,
    STORM_NIGHT_REDUCED_MOTION_SCENARIO,
];

const WORLD_SCENARIO_BY_ID = new Map(WORLD_SCENARIOS.map((scenario) => [scenario.id, scenario]));

export function getWorldScenario(id = DEFAULT_WORLD_SCENARIO_ID) {
    return WORLD_SCENARIO_BY_ID.get(id) || WORLD_SCENARIO_BY_ID.get(DEFAULT_WORLD_SCENARIO_ID);
}

export function cloneWorldScenario(idOrScenario = DEFAULT_WORLD_SCENARIO_ID) {
    const scenario = typeof idOrScenario === 'string'
        ? getWorldScenario(idOrScenario)
        : idOrScenario;
    if (!scenario || typeof scenario !== 'object') {
        return clonePlain(getWorldScenario(DEFAULT_WORLD_SCENARIO_ID));
    }
    return clonePlain(scenario);
}

export function listWorldScenarios() {
    return WORLD_SCENARIOS.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        description: scenario.description,
        metadata: clonePlain(scenario.metadata || {}),
    }));
}
