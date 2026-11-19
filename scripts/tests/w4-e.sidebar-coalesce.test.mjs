import assert from 'node:assert/strict';
import test from 'node:test';

import { Sidebar, crewFoldPlan, crewLeadsById, nestCrewRows } from '../../claudeville/src/presentation/shared/Sidebar.js';
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

function fakeNode() {
    const attrs = new Map();
    return {
        textContent: '',
        hidden: false,
        className: '',
        style: { setProperty() {} },
        getAttribute: name => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, String(value)),
    };
}

test('council-fleet folds its crew behind one toggle naming all 20, attention outside the fold', () => {
    const agents = councilAgents();
    const lead = agents.find(agent => !agent.parentSessionId);
    const crew = agents.filter(agent => agent.parentSessionId === lead.id);
    const plan = crewFoldPlan(crew);
    assert.equal(plan.rows, 9, 'eight direct children and one workflow row');
    assert.equal(plan.foldable, true);
    assert.equal(plan.collapsed, true);
    assert.equal(plan.pinnedIds.size, 0);
    assert.equal(crewFoldPlan(crew, { expanded: true }).collapsed, false);
    assert.equal(crewFoldPlan(crew, { filter: 'lane' }).collapsed, false, 'a search unfolds it');
    assert.equal(crewFoldPlan(crew.slice(0, 8)).foldable, false, 'eight rows stay open');

    // The rendered toggle.
    const sidebar = Object.create(Sidebar.prototype);
    const group = { className: '', style: { setProperty() {} }, _sidebarRefs: { toggle: fakeNode(), count: fakeNode() } };
    sidebar._patchCrewGroup(group, plan, { accent: '#4c9a4c' });
    assert.equal(group._sidebarRefs.count.textContent, '20 crew');
    assert.equal(group._sidebarRefs.toggle.hidden, false);
    assert.equal(group._sidebarRefs.toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(group.className, 'sidebar__crew sidebar__crew--collapsed');

    // A member that needs you, or errored, stays outside the fold.
    const asking = crew.map((agent, index) => (index === 2 ? { ...agent, status: 'waiting_on_user' }
        : index === 15 ? { ...agent, status: 'errored' } : agent));
    assert.deepEqual([...crewFoldPlan(asking).pinnedIds].sort(), [crew[15].id, crew[2].id].sort());
    assert.equal(crewFoldPlan(asking, { expanded: true }).pinnedIds.size, 0);
});

test('a departed parent leads no one; a live recorded root keeps its grandchild', () => {
    const agents = [
        { id: 'lead', parentSessionId: null },
        { id: 'gone', parentSessionId: 'lead', departedAt: 1000 },
        { id: 'kid', parentSessionId: 'gone' },
        { id: 'grandkid', parentSessionId: 'gone', rootSessionId: 'lead' },
        { id: 'orphan', parentSessionId: 'mid-ended', rootSessionId: 'lead' },
    ];
    const leads = crewLeadsById(agents);
    assert.equal(leads.has('kid'), false, 'a departed parent does not absorb its child');
    assert.equal(leads.get('grandkid').id, 'lead', 'the recorded live root wins');
    assert.equal(leads.get('orphan').id, 'lead', 'a vanished parent leaves the root crew intact');
    assert.equal(crewLeadsById([{ id: 'r', departedAt: 5 }, { id: 'c', parentSessionId: 'r', rootSessionId: 'r' }]).has('c'), false);

    // Its row shows the ended-parent link, disabled.
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        _agentRows: new Map(),
        world: { agents: new Map([['gone', { id: 'gone', name: 'Gone', departedAt: 1000 }]]) },
    });
    let seenParent = 'unset';
    sidebar._createAgentRow = () => ({});
    sidebar._patchAgentRow = (_row, _agent, _profile, _extras, parent) => { seenParent = parent; };
    sidebar._getAgentRow({ id: 'kid', name: 'Kid', parentSessionId: 'gone' }, { accent: '#123456' }, {});
    assert.equal(seenParent, null);
});
