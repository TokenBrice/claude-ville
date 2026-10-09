// W7.2 outcome chits, W7.4 squad standards + repo ground course, W7.6 ambient
// shared-file knots (The Living Isle, batch 2).
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { FAILURE } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { groundMarkDepth, groundRingPlan } from '../../claudeville/src/presentation/character-mode/AgentGroundMarks.js';
import { drawFamilyTethers, resolveSquads, squadPennonSide, SQUAD_MIN_CHILDREN, SQUAD_TETHER_PATTERNS } from '../../claudeville/src/presentation/character-mode/CouncilRing.js';
import { drawSquadPennon } from '../../claudeville/src/presentation/character-mode/PixelPennant.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { AMBIENT_KNOT_LIMIT, RelationshipState, ambientFileKnots } from '../../claudeville/src/presentation/character-mode/RelationshipState.js';

const NOW = 1_000_000;

function building(tileX, tileY) {
    return { position: { tileX, tileY }, width: 4, height: 4, entrance: { tileX: tileX + 2, tileY: tileY + 3 } };
}

function activityWithWorld() {
    const world = {
        buildings: new Map([
            ['taskboard', building(10, 10)],
            ['forge', building(20, 10)],
            ['archive', building(30, 10)],
            ['command', building(40, 10)],
        ]),
    };
    return new LandmarkActivity({ world });
}

function result(id, exitCode, building = 'taskboard', tool = 'bash') {
    return { id, agentId: 'agent-1', tool, exitCode, completedAt: NOW, building };
}

function outcomes(activity) {
    return [...activity.items.values()].filter(item => item.type === 'outcome');
}

test('W7.2: only a real exit code lands a chit, at the owning building', t => {
    const activity = activityWithWorld();
    t.after(() => activity.dispose());
    activity._observeToolResult(result('none', null), NOW);
    activity._observeToolResult(result('undef', undefined), NOW);
    activity._observeToolResult(result('nan', 'abc'), NOW);
    activity._observeToolResult(result('nobuilding', 1, null), NOW);
    activity._observeToolResult(result('unknownbuilding', 1, 'lighthouse'), NOW);
    assert.equal(outcomes(activity).length, 0, 'absence is never success; unknown homes land nothing');

    activity._observeToolResult(result('fail', 1), NOW);
    activity._observeToolResult(result('pass', 0, 'forge'), NOW);
    activity._observeToolResult(result('fail', 1), NOW + 5);
    const [fail, pass] = outcomes(activity);
    assert.equal(outcomes(activity).length, 2, 'a repeated result id stamps once');
    assert.equal(fail.building, 'taskboard');
    assert.equal(fail.failed, true);
    assert.equal(fail.detail, 'exit 1');
    assert.equal(pass.building, 'forge', 'the Forge gate is gone: every building, the Forge included');
    assert.equal(pass.failed, false);
    assert.equal(pass.detail, '');
});

test('W7.2: the chit subscribes to tool:result on the bus', t => {
    const activity = activityWithWorld();
    t.after(() => activity.dispose());
    eventBus.emit('tool:result', result('bus-1', 2, 'archive'));
    assert.equal(outcomes(activity).length, 1);
    activity.dispose();
    eventBus.emit('tool:result', result('bus-2', 2, 'archive'));
    assert.equal(outcomes(activity).length, 0, 'disposed: unsubscribed and cleared');
});

test('W7.2: per-kind cap 10, newest four per door, TTL 18 s', t => {
    const activity = activityWithWorld();
    t.after(() => activity.dispose());
    for (let i = 0; i < 6; i++) activity._observeToolResult(result(`tb-${i}`, i % 2), NOW + i);
    const board = outcomes(activity).filter(item => item.building === 'taskboard');
    assert.equal(board.length, 4, 'a door holds its newest four');
    assert.deepEqual(board.map(item => item.id).sort(), ['outcome:tb-2', 'outcome:tb-3', 'outcome:tb-4', 'outcome:tb-5']);
    assert.equal(new Set(board.map(item => item.slot)).size, 4, 'the four never share a place');

    for (const type of ['forge', 'archive', 'command']) {
        for (let i = 0; i < 4; i++) activity._observeToolResult(result(`${type}-${i}`, 0, type), NOW + 10 + i);
    }
    assert.equal(outcomes(activity).length, 10, 'per-kind cap 10');
    assert.equal(outcomes(activity).filter(item => item.building === 'taskboard').length, 0, 'the oldest go first');

    activity._expireItems(NOW + 13 + 18_000 - 1);
    assert.equal(outcomes(activity).length > 0, true);
    activity._expireItems(NOW + 13 + 18_000 + 1);
    assert.equal(outcomes(activity).length, 0, 'gone after 18 s');
});

test('W7.2: failure paints the broken bracket, success the stone residue', t => {
    const activity = activityWithWorld();
    t.after(() => activity.dispose());
    const paints = [];
    const ctx = {
        globalAlpha: 1,
        fillStyle: '',
        save() {},
        restore() {},
        fillRect() { paints.push(this.fillStyle); },
    };
    activity.draw(ctx, { payload: { type: 'outcome', id: 'a', building: 'taskboard', failed: true, x: 100, y: 100, alpha: 1 } });
    assert.ok(paints.includes(FAILURE), 'failure stamp in the failure red');
    paints.length = 0;
    activity.draw(ctx, { payload: { type: 'outcome', id: 'b', building: 'taskboard', failed: false, x: 100, y: 100, alpha: 1 } });
    assert.ok(paints.length > 0);
    assert.ok(!paints.includes(FAILURE), 'success never borrows the failure red');
});

test('W7.2: chit rows stand on the door ground, stepped back where the door tile is hidden', t => {
    const activity = activityWithWorld();
    t.after(() => activity.dispose());
    // The forge's entrance tile (22, 13) is open ground: its centre is the anchor.
    assert.deepEqual(activity._entranceGround('forge'), tileToWorld(22.5, 13.5));
    // The Task board's door-front sits under the curtain wall: back 1.5 tiles.
    assert.deepEqual(activity._entranceGround('taskboard'), tileToWorld(12.5, 12));
    for (let i = 0; i < 4; i++) activity._observeToolResult(result(`row-${i}`, i % 2, 'archive'), NOW + i);
    const ground = activity._entranceGround('archive');
    for (const item of outcomes(activity)) {
        const at = activity._itemPosition(item, NOW + 1000);
        // One row in front of the chip rows (which end 5 texels below the
        // door ground), still within the door's own and the next tile.
        const dx = Math.abs(at.x - ground.x);
        const dy = at.y - ground.y;
        assert.ok(dy >= 16 && dy <= 17 && dx <= 20, `outcome ${item.id} stands in front of the chip rows`);
    }
});

function sprite(id, extra = {}) {
    return { agent: { id, ...extra.agent }, x: extra.x ?? 0, y: extra.y ?? 0, isArrivalPending: () => Boolean(extra.pending) };
}

test('W7.4: a squad is a live parent with >= 2 live children, each holding a distinct shape', () => {
    assert.equal(SQUAD_MIN_CHILDREN, 2);
    const sprites = new Map([
        ['p1', sprite('p1')], ['c1', sprite('c1')], ['c2', sprite('c2')],
        ['p2', sprite('p2')], ['c3', sprite('c3')],
        ['p3', sprite('p3')], ['c4', sprite('c4')], ['c5', sprite('c5', { pending: true })],
        ['p4', sprite('p4')], ['c6', sprite('c6')], ['c7', sprite('c7', { agent: { isDeparted: true } })],
        ['p5', sprite('p5')], ['c8', sprite('c8')], ['c9', sprite('c9')],
    ]);
    const families = new Map([
        ['p1', new Set(['c1', 'c2'])],
        ['p2', new Set(['c3'])],
        ['p3', new Set(['c4', 'c5'])],
        ['p4', new Set(['c6', 'c7'])],
        ['p5', new Set(['c8', 'c9'])],
        ['gone', new Set(['c1', 'c2'])],
    ]);
    const registry = new Map();
    const squads = resolveSquads(families, sprites, { registry });
    assert.deepEqual(squads.map(squad => squad.parentId), ['p1', 'p5']);
    assert.notEqual(squads[0].shape, squads[1].shape, 'two live squads never share a shape');
    for (const squad of squads) assert.ok(squad.shape >= 0 && squad.shape < SQUAD_TETHER_PATTERNS.length);

    // Sticky: a new squad never moves an existing one off its shape.
    const before = new Map(squads.map(squad => [squad.parentId, squad.shape]));
    sprites.set('c10', sprite('c10'));
    families.set('p2', new Set(['c3', 'c10']));
    const again = resolveSquads(families, sprites, { registry });
    assert.equal(again.length, 3);
    for (const squad of again) {
        if (before.has(squad.parentId)) assert.equal(squad.shape, before.get(squad.parentId));
    }
    assert.equal(new Set(again.map(squad => squad.shape)).size, 3);

    // A squad that falls below two children leaves the registry.
    families.set('p5', new Set(['c8']));
    resolveSquads(families, sprites, { registry });
    assert.equal(registry.has('p5'), false);
});

function recordingCtx() {
    const fills = [];
    return {
        fills,
        globalAlpha: 1,
        fillStyle: '',
        save() {},
        restore() {},
        fillRect(x, y, w, h) { fills.push({ x, y, w, h, alpha: this.globalAlpha, color: this.fillStyle }); },
    };
}

function squadSprite(id, x, y) {
    return { ...sprite(id, { x, y }), thoughtRepoAccent: () => '#5aa0d8', _stableContentWidth: () => 28 };
}

test('W7.4: squad cords lie on the ground, feet to feet, and drop out between close bodies', () => {
    const leader = squadSprite('lead', 0, 0);
    const far = squadSprite('far', 160, 80); // 5 tiles off
    const near = squadSprite('near', 32, 16); // one tile off
    const sprites = new Map([['lead', leader], ['far', far], ['near', near]]);
    const relationship = { parentToChildren: new Map([['lead', new Set(['far', 'near'])]]) };
    const ctx = recordingCtx();
    drawFamilyTethers(ctx, { relationship, agentSprites: sprites, motionScale: 0 });
    const cord = ctx.fills.filter(fill => fill.alpha < 1);
    assert.ok(cord.length > 0, 'the far child is tethered');
    for (const fill of cord) {
        // On the straight ground run from the leader's feet to the far child's
        // (a lit texel), or its keyline one texel under it.
        const along = (fill.x * 160 + fill.y * 80) / (160 * 160 + 80 * 80);
        assert.ok(Math.abs(fill.y - 1 - along * 80) <= 2, `cord texel (${fill.x}, ${fill.y}) on the ground line`);
        assert.ok(fill.y >= 0, 'never lifted above the feet');
        for (const body of [leader, far]) {
            const inside = ((fill.x - body.x) / 12) ** 2 + ((fill.y - body.y - 1) / 5) ** 2 <= 1;
            assert.ok(!inside, 'broken under every member footprint');
        }
    }
    assert.ok(cord.every(fill => Math.abs(fill.y - fill.x / 2) <= 3), 'no cord toward the one-tile neighbour');
});

test('W7.4: the standard stands beside the leader feet, mirrored away from a covering neighbour', () => {
    const leader = squadSprite('lead', 0, 0);
    const sprites = new Map([['lead', leader]]);
    assert.equal(squadPennonSide(leader, sprites), 1, 'right by default');
    sprites.set('east', squadSprite('east', 24, 10));
    assert.equal(squadPennonSide(leader, sprites), -1, 'a body in front on the right sends it left');
    sprites.set('west', squadSprite('west', -24, 10));
    assert.equal(squadPennonSide(leader, sprites), 1, 'both sides covered: right');
    sprites.delete('east');
    sprites.delete('west');
    sprites.set('behind', squadSprite('behind', 24, -30));
    assert.equal(squadPennonSide(leader, sprites), 1, 'a body behind the pole never hides it');

    for (const facing of [1, -1]) {
        const ctx = recordingCtx();
        drawSquadPennon(ctx, 20, 0, { accent: '#5aa0d8', facing });
        const bottom = Math.max(...ctx.fills.map(fill => fill.y + fill.h - 1));
        const top = Math.min(...ctx.fills.map(fill => fill.y));
        assert.equal(bottom, 0, 'the pole foot stands on the given ground row');
        assert.ok(bottom - top <= 13, 'a short standard, knee to hip');
        const cloth = ctx.fills.filter(fill => fill.color === '#5aa0d8');
        assert.ok(cloth.length > 0);
        for (const fill of cloth) {
            assert.ok(facing > 0 ? fill.x > 20 : fill.x + fill.w - 1 < 20, `cloth flies to the ${facing > 0 ? 'right' : 'left'}`);
        }
    }
});

test('W7.4: the repo course sits under status rings; NEEDS YOU always wins', () => {
    const repo = '#5aa0d8';
    assert.deepEqual(groundRingPlan({ status: AgentStatus.WORKING, repo }).map(ring => ring.kind), ['repo']);
    assert.deepEqual(groundRingPlan({ status: AgentStatus.IDLE, repo: null }).map(ring => ring.kind), []);
    for (const status of [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED]) {
        const kinds = groundRingPlan({ status, repo }).map(ring => ring.kind);
        assert.deepEqual(kinds, ['status'], `${status}: no repo course under an action-needed ring`);
    }
    const selected = groundRingPlan({ status: AgentStatus.WORKING, repo, selected: true });
    assert.deepEqual(selected.map(ring => ring.kind), ['repo', 'selected']);
    assert.ok(selected[0].pad < selected[1].pad, 'the course sits inside the selection ring');
    const withStatus = groundRingPlan({ status: AgentStatus.WAITING_ON_USER, repo: null })[0];
    assert.ok(groundRingPlan({ repo })[0].pad < withStatus.pad, 'the course sits inside the status ring');
    // Labels under the feet clear the course.
    assert.ok(groundMarkDepth({ contentWidth: 28, repo }) > groundMarkDepth({ contentWidth: 28 }));
});

function collider(id, collisions, extra = {}) {
    return sprite(id, { ...extra, agent: { collisions, ...(extra.agent || {}) } });
}

function collision(path, kind, overlapKind, observations) {
    return { path, kind, overlapKind, agents: observations.map(entry => entry.agentId), observations };
}

test('W7.6: write-write and concurrent read-write knots draw without selection, loudest N', () => {
    const ww = collision('/r/a.json', 'write-write', 'recent', [
        { agentId: 'a', op: 'write', at: 10 }, { agentId: 'b', op: 'write', at: 20 },
    ]);
    const rwRecent = collision('/r/b.js', 'read-write', 'recent', [
        { agentId: 'a', op: 'write', at: 30 }, { agentId: 'c', op: 'read', at: 31 },
    ]);
    const rwConcurrent = collision('/r/c.js', 'read-write', 'concurrent', [
        { agentId: 'c', op: 'write', at: 40 }, { agentId: 'd', op: 'read', at: 41 },
    ]);
    const sprites = [
        collider('a', [ww, rwRecent]),
        collider('b', [ww]),
        collider('c', [rwRecent, rwConcurrent]),
        collider('d', [rwConcurrent]),
    ];
    const knots = ambientFileKnots(sprites);
    assert.deepEqual(knots.map(knot => knot.basename), ['a.json', 'c.js'], 'recent read-write stays behind selection');
    assert.equal(knots[0].kind, 'write-write');
    assert.equal(knots[0].writers, 2);
    assert.deepEqual([knots[1].aId, knots[1].bId], ['c', 'd'], 'the writer, then its reader');

    // Loudest N, write-write first, and an arrival-pending body draws nothing.
    const many = [];
    for (let i = 0; i < 6; i++) {
        many.push(collision(`/r/w${i}.js`, 'write-write', i % 2 ? 'concurrent' : 'recent', [
            { agentId: 'a', op: 'write', at: i }, { agentId: 'b', op: 'write', at: i + 1 },
        ]));
    }
    const ranked = ambientFileKnots([collider('a', many), collider('b', many), collider('c', [rwConcurrent]), collider('d', [rwConcurrent])]);
    assert.equal(ranked.length, AMBIENT_KNOT_LIMIT);
    assert.ok(ranked.every(knot => knot.kind === 'write-write' && knot.overlapKind === 'concurrent'));
    assert.equal(ambientFileKnots([collider('a', [ww]), collider('b', [ww], { pending: true })]).length, 0);
    assert.equal(ambientFileKnots([sprite('x'), sprite('y')]).length, 0);
});

test('W7.6: RelationshipState publishes knots with and without a selection', t => {
    const state = new RelationshipState({ agents: new Map() });
    t.after(() => state.dispose());
    const ww = collision('/r/a.json', 'write-write', 'concurrent', [
        { agentId: 'a', op: 'write', at: 10 }, { agentId: 'b', op: 'write', at: 20 },
    ]);
    const other = collision('/r/z.json', 'write-write', 'recent', [
        { agentId: 'a', op: 'write', at: 5 }, { agentId: 'c', op: 'write', at: 6 },
    ]);
    const a = collider('a', [ww, other]);
    const sprites = new Map([['a', a], ['b', collider('b', [ww])], ['c', collider('c', [other])]]);
    state.reconcile({ agentSprites: sprites });
    let overlap = state.getSnapshot().fileOverlap;
    assert.equal(overlap.edge, null, 'no selection: no single thread');
    assert.equal(overlap.knots.length, 2);

    a.selected = true;
    state.reconcile({ agentSprites: sprites });
    overlap = state.getSnapshot().fileOverlap;
    assert.equal(overlap.edge.path, '/r/a.json', 'the selection thread keeps its own edge');
    assert.deepEqual(overlap.knots.map(knot => knot.path), ['/r/z.json'], 'no double-drawn knot for the selected edge');
});
