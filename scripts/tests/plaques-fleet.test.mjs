import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import {
    RelationshipState,
    squadMusterLines,
    squadRollups,
} from '../../claudeville/src/presentation/character-mode/RelationshipState.js';
import {
    TaskboardBoardModel,
    taskboardFleetRollup,
} from '../../claudeville/src/presentation/character-mode/TaskboardBoardModel.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { AgentAction, isPlanMode, resolveAgentAction } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import { PLAN_MODE_GLYPH, toolGlyphKey } from '../../claudeville/src/presentation/character-mode/ToolGlyphBadge.js';

const NOW = 1_800_000_000_000;

function agentsMap(list) {
    return new Map(list.map(agent => [agent.id, agent]));
}

// --- W7.5 squad rollups -------------------------------------------------

test('squad rollup counts live children out and departed children returned, exactly', () => {
    const agents = agentsMap([
        { id: 'p1', name: 'Wave', projectPath: '/w/claude-ville' },
        { id: 'c1', parentSessionId: 'p1' },
        { id: 'c2', parentSessionId: 'p1' },
        { id: 'c3', parentSessionId: 'p1', isDeparted: true },
        { id: 'c4', parentSessionId: 'p1', departedAt: NOW },
    ]);
    const parentToChildren = new Map([['p1', new Set(['c1', 'c2', 'c3', 'c4'])]]);
    const returnedByParent = new Map([['p1', new Set(['gone-a', 'gone-b', 'c3'])]]);
    const [row] = squadRollups({ parentToChildren, returnedByParent, agents });
    assert.deepEqual(row, { parentId: 'p1', name: 'Wave', project: '/w/claude-ville', out: 2, returned: 4 });
});

test('squad rollup skips departed or unknown parents and empty squads; a resumed child is out, not back', () => {
    const agents = agentsMap([
        { id: 'gone', isDeparted: true },
        { id: 'quiet' },
        { id: 'resume' },
        { id: 'kid', parentSessionId: 'resume' },
        { id: 'orphan', parentSessionId: 'ghost' },
    ]);
    const rows = squadRollups({
        parentToChildren: new Map([
            ['gone', new Set(['x'])],
            ['ghost', new Set(['orphan'])],
            ['quiet', new Set()],
            ['resume', new Set(['kid'])],
        ]),
        returnedByParent: new Map([['resume', new Set(['kid'])], ['gone', new Set(['y'])]]),
        agents,
    });
    assert.deepEqual(rows.map(row => [row.parentId, row.out, row.returned]), [['resume', 1, 0]]);
});

test('squads order by most out, then most returned, then name', () => {
    const agents = agentsMap([
        { id: 'a', name: 'Bravo' }, { id: 'b', name: 'Alpha' }, { id: 'c', name: 'Charlie' },
        { id: 'a1', parentSessionId: 'a' },
        { id: 'b1', parentSessionId: 'b' },
        { id: 'c1', parentSessionId: 'c' }, { id: 'c2', parentSessionId: 'c' },
    ]);
    const rows = squadRollups({
        parentToChildren: new Map([['a', new Set(['a1'])], ['b', new Set(['b1'])], ['c', new Set(['c1', 'c2'])]]),
        returnedByParent: new Map([['a', new Set(['z'])]]),
        agents,
    });
    assert.deepEqual(rows.map(row => row.name), ['Charlie', 'Bravo', 'Alpha']);
});

test('muster lines show up to three squads, else two and one exact +N squads line', () => {
    const squad = (n) => ({ parentId: `p${n}`, name: `S${n}`, project: '', out: 1, returned: 0 });
    assert.equal(squadMusterLines([squad(1), squad(2), squad(3)]).length, 3);
    assert.ok(squadMusterLines([squad(1), squad(2), squad(3)]).every(line => line.kind === 'squad'));
    const five = squadMusterLines([1, 2, 3, 4, 5].map(squad));
    assert.deepEqual(five.map(line => line.kind), ['squad', 'squad', 'more']);
    assert.equal(five[2].text, '+3 squads');
    assert.equal(five[2].count, 3);
    assert.equal(squadMusterLines([1, 2, 3, 4].map(squad))[2].text, '+2 squads');
    assert.deepEqual(squadMusterLines([]), []);
});

test('RelationshipState tallies removed children per live parent and drops the tally with the parent', () => {
    const world = { agents: agentsMap([
        { id: 'lead', name: 'Lead' },
        { id: 'k1', parentSessionId: 'lead' },
        { id: 'k2', parentSessionId: 'lead' },
    ]) };
    const state = new RelationshipState(world);
    try {
        state.reconcile({ now: 0 });
        assert.deepEqual(state.getSnapshot().squads.map(s => [s.out, s.returned]), [[2, 0]]);
        world.agents.delete('k1');
        eventBus.emit('agent:removed', { id: 'k1', parentSessionId: 'lead' });
        state.reconcile({ now: 100 });
        assert.deepEqual(state.getSnapshot().squads.map(s => [s.name, s.out, s.returned]), [['Lead', 1, 1]]);
        // Long past the 12 s recentDepartures window the return still counts.
        state.reconcile({ now: 60_000 });
        assert.equal(state.getSnapshot().recentDepartures.length, 0);
        assert.equal(state.getSnapshot().squads[0].returned, 1);
        world.agents.delete('lead');
        eventBus.emit('agent:removed', { id: 'lead' });
        state.reconcile({ now: 60_100 });
        assert.deepEqual(state.getSnapshot().squads, []);
        assert.equal(state._returnedByParent.size, 0);
    } finally {
        state.dispose();
    }
});

// --- W7.10a fleet plan rollup -------------------------------------------

function planAgent(id, todos, extra = {}) {
    return { agent: { id, name: id, projectPath: `/work/${extra.project || id}`, todos, lastActive: 0, ...extra } };
}

const todo = (subject, status, phase = undefined) => ({ subject, status, ...(phase ? { phase } : {}) });

test('fleet rollup: one row per live plan, active named phase and plan totals, most recent change first', () => {
    const model = new TaskboardBoardModel({ now: () => NOW });
    const older = planAgent('older', [todo('a', 'completed', 'Scout'), todo('b', 'pending', 'Build'), todo('c', 'pending', 'Build')], { project: 'alpha' });
    const newer = planAgent('newer', [todo('x', 'completed'), todo('y', 'in_progress')], { project: 'beta' });
    model.updateAgentSprites([older], NOW);
    model.updateAgentSprites([older, newer], NOW + 5000);
    const rows = taskboardFleetRollup({ agentSprites: [older, newer], todosUpdatedAt: model.todosUpdatedAt });
    assert.deepEqual(rows.map(row => [row.text, row.done, row.total]), [
        ['beta', 1, 2],
        ['alpha · Build', 1, 3],
    ]);
    assert.ok(rows.every(row => row.kind === 'plan'));
});

test('fleet rollup tells two plans in one project apart by owner and skips departed sessions', () => {
    const one = planAgent('Ada', [todo('a', 'pending')], { project: 'same' });
    const two = planAgent('Bo', [todo('b', 'pending')], { project: 'same' });
    const gone = planAgent('Cy', [todo('c', 'pending')], { project: 'other', isDeparted: true });
    const rows = taskboardFleetRollup({ agentSprites: [one, two, gone] });
    assert.deepEqual(rows.map(row => row.text).sort(), ['Ada', 'Bo']);
});

test('board: selection wins; two or more plans make a fleet; a lone plan shows in full', () => {
    const model = new TaskboardBoardModel({ now: () => NOW });
    const a = planAgent('a', [todo('a', 'pending')]);
    const b = planAgent('b', [todo('b', 'pending')]);
    const idle = { agent: { id: 'idle', todos: [] } };
    const sprites = [a, b, idle];
    model.updateAgentSprites(sprites, NOW);
    assert.equal(model.board({ candidates: ['b'], agentSprites: sprites }).agent.id, 'b');
    assert.equal(model.board({ candidates: ['b'], agentSprites: sprites }).fleet, null);
    // A selected agent without a plan does not own the board.
    const unselected = model.board({ candidates: ['idle'], agentSprites: sprites });
    assert.equal(unselected.agent, null);
    assert.equal(unselected.fleet.length, 2);
    assert.equal(model.board({ candidates: [], agentSprites: [a, idle] }).agent.id, 'a');
    assert.equal(model.board({ candidates: [], agentSprites: [idle] }), null);
});

// --- W7.10b plan-mode stance --------------------------------------------

test('plan mode is the Claude permissionMode, never a departed session', () => {
    assert.equal(isPlanMode({ permissionMode: 'plan' }), true);
    assert.equal(isPlanMode({ permissionMode: 'acceptEdits' }), false);
    assert.equal(isPlanMode({ permissionMode: 'bypassPermissions' }), false);
    assert.equal(isPlanMode({ permissionMode: 'plan', isDeparted: true }), false);
    assert.equal(resolveAgentAction({ id: 'p', status: 'working', currentTool: 'Bash', permissionMode: 'plan' }, { verifiedOutcome: null, now: NOW }), AgentAction.THINK);
    assert.equal(resolveAgentAction({ id: 'p', status: 'working', currentTool: 'Read', permissionMode: 'plan' }, { verifiedOutcome: null, now: NOW }), AgentAction.READ);
});

test('the plan glyph is the authored EnterPlanMode motif', () => {
    assert.equal(PLAN_MODE_GLYPH, toolGlyphKey('EnterPlanMode'));
    assert.equal(PLAN_MODE_GLYPH, 'scroll');
});

test('a working plan-mode session is routed to the Task board over its tool building, and released on exit', t => {
    const manager = new VisitIntentManager({ now: () => NOW });
    t.after(() => manager.dispose());
    const agent = {
        id: 'planner',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: { file_path: 'src/main.js' },
        permissionMode: 'plan',
        tokens: { input: 0, output: 0 },
    };
    manager.reconcile([agent], NOW);
    const intent = manager.getIntentForAgent(agent.id, NOW);
    assert.equal(intent.source, 'plan');
    assert.equal(intent.building, 'taskboard');
    assert.equal(intent.priority, 84);
    agent.permissionMode = 'default';
    manager.reconcile([agent], NOW + 1000);
    const after = manager.getIntentForAgent(agent.id, NOW + 1000);
    assert.equal(after.source, 'tool');
    assert.notEqual(after.building, 'taskboard');
    agent.permissionMode = 'plan';
    agent.status = 'idle';
    manager.reconcile([agent], NOW + 2000);
    assert.ok(![...(manager.intentsByAgent.get(agent.id)?.values() || [])].some(i => i.source === 'plan'));
});

// --- Paint paths (stub canvas) ------------------------------------------

function recordingCtx(charWidth = 3) {
    const calls = [];
    const ctx = new Proxy({ measureText: text => ({ width: String(text).length * charWidth }) }, {
        get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])),
    });
    return { ctx, calls };
}

// Reassemble the slope-stepped chalk glyphs into the lines a reader sees.
function chalkLines(calls) {
    const lines = new Map();
    for (const [method, text, x, y] of calls) {
        if (method !== 'fillText') continue;
        const baseline = y - Math.round(x * 0.5);
        if (!lines.has(baseline)) lines.set(baseline, []);
        lines.get(baseline).push([x, text]);
    }
    return [...lines.entries()].sort(([a], [b]) => a - b)
        .map(([, glyphs]) => glyphs.sort(([a], [b]) => a - b).map(([, text]) => text).join(''));
}

test('the fleet slate chalks Plans · N over plan rows and folds the rest into one exact line', async () => {
    const { BuildingSprite } = await import('../../claudeville/src/presentation/character-mode/BuildingSprite.js');
    const fleet = [
        { kind: 'plan', agentId: 'a', text: 'alpha · Build', done: 1, total: 3 },
        { kind: 'plan', agentId: 'b', text: 'beta', done: 2, total: 2 },
        { kind: 'plan', agentId: 'c', text: 'gamma', done: 0, total: 4 },
        { kind: 'plan', agentId: 'd', text: 'delta', done: 1, total: 1 },
    ];
    const building = Object.create(BuildingSprite.prototype);
    building._taskboardBoard = () => ({ agent: null, fleet });
    building._zoom = 1;
    const { ctx, calls } = recordingCtx();
    assert.equal(building._drawTaskboardBoard(ctx, (x, y) => ({ x, y })), true);
    assert.deepEqual(chalkLines(calls), ['Plans · 4', 'alpha · Build · 1/3', '+3 more']);
});

test('the Command plaque carves one muster line per squad: name, then the exact · out ▸ returned', async () => {
    const { BuildingSprite } = await import('../../claudeville/src/presentation/character-mode/BuildingSprite.js');
    const building = Object.create(BuildingSprite.prototype);
    const rows = building._musterRows([
        { parentId: 'p1', name: 'Wave', project: '', out: 6, returned: 2 },
        { parentId: 'p2', name: 'Tide', project: '', out: 1, returned: 0 },
        { parentId: 'p3', name: 'Surf', project: '', out: 1, returned: 0 },
        { parentId: 'p4', name: 'Foam', project: '', out: 0, returned: 3 },
    ]);
    assert.deepEqual(rows.map(row => row.label), ['Wave', 'Tide', '+2 squads']);
    const { ctx, calls } = recordingCtx(7);
    // No motif: its outlined stamp needs a DOM canvas; the rows are the subject.
    const attempt = { text: '', rows, motif: false, rowMaxWidth: 184 };
    const plaque = building._measurePlaque(ctx, { type: 'command' }, attempt, { count: 9, zoom: 1 });
    building._paintPlaque(ctx, plaque, { x: 100, y: 100, labelScale: 1, poleBottom: 140, accent: '#fff' });
    const texts = calls.filter(([method]) => method === 'fillText').map(([, text]) => text);
    for (const piece of ['Wave', ' · 6 ', ' 2', 'Tide', ' · 1 ', ' 0', '+2 squads']) {
        assert.ok(texts.includes(piece), `missing ${JSON.stringify(piece)} in ${JSON.stringify(texts)}`);
    }
    // The ▸ is carved from whole pixels: a 1×5, 1×3 and 1×1 column per line.
    const rects = calls.filter(([method]) => method === 'fillRect').map(([, , , w, h]) => `${w}x${h}`);
    assert.equal(rects.filter(size => size === '1x5').length >= 2, true);
    assert.ok(plaque.width >= Math.max(...plaque.rows.map(row => row.label.length * 7 + (row.tailWidth || 0))));
});
