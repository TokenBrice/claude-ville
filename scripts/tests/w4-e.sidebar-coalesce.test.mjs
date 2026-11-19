import assert from 'node:assert/strict';
import test from 'node:test';

import { Sidebar, crewLeadsById, nestCrewRows } from '../../claudeville/src/presentation/shared/Sidebar.js';
import { isImplicitSessionTeam } from '../../claudeville/src/presentation/shared/TeamColor.js';
import { projectKeyForAgent } from '../../claudeville/src/presentation/shared/AgentPresentation.js';
import { getWorldScenario } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

function makeSidebar() {
    const frames = [];
    const cancelledFrames = [];
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        _destroyed: false,
        _reactiveFrame: null,
        _reactiveFrameGeneration: 0,
        _pendingAgentChanges: new Map(),
        _reactiveRenderPending: false,
        _workflowPruneTimer: null,
        _workflowPruneAt: 0,
        _detailIndexTimer: null,
        _filter: '',
        _renderSignature: '',
        _seenWorkflows: new Set(),
        _collapsedWorkflows: new Set(),
        _workflowLastSeenAt: new Map(),
        _renderCalls: 0,
        _renderedSelection: null,
        _indexedAgents: [],
        selection: {
            selectedId: null,
            destroy() {},
        },
        searchIndex: {
            remove() {},
            clear() {},
        },
    });

    sidebar._requestAnimationFrame = callback => {
        frames.push(callback);
        return frames.length;
    };
    sidebar._cancelAnimationFrame = frame => cancelledFrames.push(frame);
    sidebar._indexAgent = agent => sidebar._indexedAgents.push(agent.id);
    sidebar.render = () => {
        sidebar._renderCalls++;
        sidebar._renderedSelection = sidebar.selection.selectedId;
    };

    return { sidebar, frames, cancelledFrames };
}

test('coalesces a burst into one reindex pass and one render of final selection', () => {
    const { sidebar, frames } = makeSidebar();
    let reindexPasses = 0;
    const reindex = sidebar._reindexPendingAgentChanges.bind(sidebar);
    sidebar._reindexPendingAgentChanges = () => {
        reindexPasses++;
        return reindex();
    };

    const agents = ['ada', 'beau', 'clio'].map(id => ({ id }));
    for (const agent of agents) sidebar._handleAgentUpdate(agent);
    // The final operation for one agent replaces its earlier queued update.
    sidebar._handleAgentUpdate({ id: 'ada', status: 'idle' });
    sidebar.selection.selectedId = 'clio';

    assert.equal(frames.length, 1);
    assert.equal(sidebar._renderCalls, 0);

    frames[0]();

    assert.equal(reindexPasses, 1);
    assert.equal(sidebar._renderCalls, 1);
    assert.deepEqual(sidebar._indexedAgents.sort(), ['ada', 'beau', 'clio']);
    assert.equal(sidebar._renderedSelection, 'clio');
});

test('filter input flushes pending reactive work and renders immediately', () => {
    const { sidebar, frames, cancelledFrames } = makeSidebar();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar._handleFilterInput({ target: { value: '  Ada ' } });

    assert.equal(sidebar._filter, 'ada');
    assert.equal(sidebar._renderCalls, 1);
    assert.deepEqual(sidebar._indexedAgents, ['ada']);
    assert.deepEqual(cancelledFrames, [1]);

    // A cancelled callback must be harmless if the browser had already queued it.
    frames[0]();
    assert.equal(sidebar._renderCalls, 1);

    sidebar._handleAgentUpdate({ id: 'beau' });
    frames[0]();
    assert.equal(sidebar._renderCalls, 1);
    frames[1]();
    assert.equal(sidebar._renderCalls, 2);
});

test('workflow collapse click flushes pending work before its synchronous render', () => {
    const { sidebar, cancelledFrames } = makeSidebar();
    const toggle = { dataset: { workflowId: 'workflow-1' } };
    sidebar.listEl = {
        addEventListener(_type, callback) {
            sidebar._onListClick = callback;
        },
        contains(node) {
            return node === toggle;
        },
    };
    sidebar._bindListClick();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar._onListClick({
        target: {
            closest() {
                return toggle;
            },
        },
    });

    assert.equal(sidebar._renderCalls, 1);
    assert.equal(sidebar._collapsedWorkflows.has('workflow-1'), true);
    assert.deepEqual(cancelledFrames, [1]);
});

test('destroy cancels the pending frame and prevents its callback from rendering', () => {
    const { sidebar, frames, cancelledFrames } = makeSidebar();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar.destroy();

    assert.deepEqual(cancelledFrames, [1]);
    assert.equal(sidebar._reactiveFrame, null);
    frames[0]();
    assert.equal(sidebar._renderCalls, 0);
    assert.deepEqual(sidebar._indexedAgents, []);
});

// FK-4 — a fleet reads as a fleet: the crew nests under its lead, in the
// lead's group, whatever directory a child works in.
function councilAgents() {
    return getWorldScenario('council-fleet').agents.map(spec => ({
        ...spec,
        parentSessionId: spec.parentId || null,
    }));
}

test('council-fleet: every child groups with its lead and nests after it', () => {
    const agents = councilAgents();
    const leads = crewLeadsById(agents);
    const lead = agents.find(agent => !agent.parentSessionId);
    assert.equal(leads.size, 20);
    const groupKeys = new Set(agents.map(agent => projectKeyForAgent(leads.get(agent.id) || agent)));
    assert.deepEqual([...groupKeys], [lead.projectPath], 'MCP jobs in their own directory nest under the lead group');

    // Arrival order interleaves; the nesting does not.
    const early = [agents[3], agents[6]];
    const unique = [...early, ...agents.filter(agent => !early.includes(agent))];
    assert.notEqual(unique[0].id, lead.id);
    const { topLevel, workflows, crews } = nestCrewRows(unique, leads);
    assert.deepEqual(topLevel.map(agent => agent.id), [lead.id]);
    assert.equal(workflows.size, 0, 'workflow members ride inside the crew');
    assert.equal(crews.get(lead.id).length, 20);
});

test('a nested crew climbs to its topmost live lead; an ended lead leaves a top-level child', () => {
    const agents = [
        { id: 'lead', parentSessionId: null },
        { id: 'mid', parentSessionId: 'lead' },
        { id: 'leaf', parentSessionId: 'mid' },
        { id: 'orphan', parentSessionId: 'gone' },
    ];
    const leads = crewLeadsById(agents);
    assert.equal(leads.get('leaf').id, 'lead');
    assert.equal(leads.has('orphan'), false);
    const { topLevel, crews } = nestCrewRows(agents, leads);
    assert.deepEqual(topLevel.map(agent => agent.id), ['lead', 'orphan']);
    assert.deepEqual(crews.get('lead').map(agent => agent.id), ['mid', 'leaf']);

    // A filtered-out lead: its visible child stands alone and keeps its link.
    const alone = nestCrewRows(agents.slice(1), leads);
    assert.deepEqual(alone.topLevel.map(agent => agent.id), ['mid', 'leaf', 'orphan']);
});

test('the implicit session- team of one lead shows no team swatch', () => {
    const agents = councilAgents();
    const team = agents.find(agent => agent.teamName)?.teamName;
    assert.ok(team.startsWith('session-'));
    assert.equal(isImplicitSessionTeam(team, agents.filter(agent => agent.teamName === team)), true);
    assert.equal(isImplicitSessionTeam('Gather Blue', [{ parentSessionId: 'lead' }]), false);
    assert.equal(isImplicitSessionTeam('session-x', [{ parentSessionId: 'a' }, { parentSessionId: 'b' }]), false);
});

test('CX-3: a renamed linked worktree repaints the row', () => {
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        _agentRows: new Map(),
        world: { agents: new Map() },
    });
    const patched = [];
    sidebar._createAgentRow = () => ({});
    sidebar._patchAgentRow = (_row, agent, _profile, extras) => patched.push([agent.worktree.name, Boolean(extras.nested)]);
    const agent = { id: 'a', name: 'Ada', worktree: { name: 'one', path: '/r/one', isMain: false } };
    sidebar._getAgentRow(agent, { accent: '#123456' }, {});
    agent.worktree = { ...agent.worktree, name: 'two' };
    sidebar._getAgentRow(agent, { accent: '#123456' }, {});
    sidebar._getAgentRow(agent, { accent: '#123456' }, { nested: true });
    assert.deepEqual(patched, [['one', false], ['two', false], ['two', true]]);
});
