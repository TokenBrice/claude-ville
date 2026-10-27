import test from 'node:test';
import assert from 'node:assert/strict';

import { AMBIENT_SCENIC_POINTS } from '../../claudeville/src/config/scenery.js';
import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import {
    ERRAND_GAP_MS,
    MAX_SIT_MS,
    MIN_SIT_MS,
    STROLL_CAP,
    SUBAGENT_WAIT_PINT_MS,
    SUBAGENT_WAIT_SLICE_GAP_MS,
    advanceSubagentWait,
    errandCap,
    errandChoice,
    errandDwellMs,
    sitDurationMs,
    strollDwellMs,
    windDownDwellMs,
} from '../../claudeville/src/presentation/character-mode/CrowdRoutine.js';
import {
    buildingWeightsForHour,
    daypartForHour,
    restSeatStepBias,
    scenicScoreBias,
    strollCapForHour,
} from '../../claudeville/src/presentation/character-mode/DayRoutine.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { isWorkingVisitor } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import VisitTileAllocator from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

const NOW = 1_800_000_000_000;
const SCENIC = AMBIENT_SCENIC_POINTS[0];
const scenicBuilding = (point = SCENIC) => ({
    type: `ambient:${point.id}`,
    capacity: { ambient: 1, work: 1 },
    visitTiles: [{ tileX: point.tileX, tileY: point.tileY, slotId: `ambient:${point.id}`, scenic: true }],
});

function allocatorWith(count) {
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ agentSprites: Array.from({ length: count }, (_, i) => ({ agent: { id: `a${i}` } })) });
    return allocator;
}

test('the stroll cap holds at six, and at the night cap when asked', () => {
    const allocator = allocatorWith(12);
    const granted = [];
    for (let i = 0; i < 8; i++) {
        const point = AMBIENT_SCENIC_POINTS[i % AMBIENT_SCENIC_POINTS.length];
        granted.push(allocator.allocate({ agent: { id: `a${i}` }, building: scenicBuilding(point), role: 'stroll' }));
    }
    assert.equal(granted.filter(Boolean).length, STROLL_CAP);
    assert.equal(allocator.routineHolders('stroll'), STROLL_CAP);
    assert.equal(allocator.metrics.routineRefusals, 2);
    // A stroller re-asking for its own leg is not refused by its own hold.
    assert.ok(allocator.allocate({ agent: { id: 'a0' }, building: scenicBuilding(), role: 'stroll' }));
    // Releasing one frees one place.
    allocator.release('a1');
    assert.ok(allocator.allocate({ agent: { id: 'a7' }, building: scenicBuilding(), role: 'stroll' }));

    const night = allocatorWith(12);
    const capped = Array.from({ length: 5 }, (_, i) => night.allocate({
        agent: { id: `n${i}` }, building: scenicBuilding(), role: 'stroll', routineCap: strollCapForHour(23),
    }));
    assert.equal(capped.filter(Boolean).length, 3);
});

test('errands hold at a third of the live agents', () => {
    assert.equal(errandCap(0), 0);
    assert.equal(errandCap(2), 0);
    assert.equal(errandCap(9), 3);
    const allocator = allocatorWith(9);
    const taskboard = { type: 'taskboard', capacity: { work: 8 }, visitTiles: Array.from({ length: 8 }, (_, i) => ({ tileX: 20 + i, tileY: 30, slotId: `t${i}` })) };
    const granted = Array.from({ length: 6 }, (_, i) => allocator.allocate({ agent: { id: `a${i}` }, building: taskboard, role: 'errand' }));
    assert.equal(granted.filter(Boolean).length, 3);
});

test('a sit is never shorter than the minimum, and a bench row is staggered', () => {
    const row = Array.from({ length: 10 }, (_, i) => `bench-${i}`);
    for (const id of row) {
        for (let cycle = 0; cycle < 20; cycle++) {
            const ms = sitDurationMs(id, cycle);
            assert.ok(ms >= MIN_SIT_MS && ms <= MAX_SIT_MS, `${id}#${cycle}: ${ms}`);
            assert.equal(sitDurationMs(id, cycle), ms, 'seeded: the same agent and cycle sit the same span');
            assert.ok(sitDurationMs(id, cycle, 1.6) >= ms);
            assert.ok(sitDurationMs(id, cycle, 0.1) >= MIN_SIT_MS);
        }
    }
    const firstStand = row.map((id) => sitDurationMs(id, 0)).sort((a, b) => a - b);
    assert.ok(new Set(firstStand.map((ms) => Math.round(ms / 1000))).size >= 8, 'no two-second bucket holds the row');
    assert.ok(firstStand.at(-1) - firstStand[0] >= 30_000, 'the row stands up over half a minute or more');
    for (const id of row) {
        const dwell = strollDwellMs(id, 0);
        assert.ok(dwell >= 20_000 && dwell <= 40_000);
    }
});

test('daypart weights are deterministic per hour and distinct across the day', () => {
    assert.equal(daypartForHour(7), 'morning');
    assert.equal(daypartForHour(13), 'midday');
    assert.equal(daypartForHour(19), 'golden');
    assert.equal(daypartForHour(23), 'night');
    assert.equal(daypartForHour(-1), 'night');
    assert.equal(daypartForHour(null), 'midday');
    assert.equal(buildingWeightsForHour(7.5), buildingWeightsForHour(8.25));
    const top = (hour) => AMBIENT_SCENIC_POINTS
        .map((point) => ({ id: point.id, bias: scenicScoreBias(hour, point) }))
        .sort((a, b) => a.bias - b.bias || a.id.localeCompare(b.id))[0].id;
    for (const hour of [7, 13, 19, 23]) assert.equal(top(hour), top(hour + 0.5));
    const favoured = new Set([7, 13, 19, 23].map(top));
    assert.ok(favoured.size >= 3, `dayparts favour different points: ${[...favoured]}`);
    assert.equal(AMBIENT_SCENIC_POINTS.find((point) => point.id === top(19)).district, 'harbor');
    assert.ok(buildingWeightsForHour(8).command > buildingWeightsForHour(13).command ?? 1);
    assert.ok(strollCapForHour(23) < strollCapForHour(13));
    const step = REST_SEATS.find((seat) => seat.id === 'command-east-step-n');
    const table = REST_SEATS.find((seat) => seat.occluder === 'tavern');
    assert.equal(restSeatStepBias(23, step), 0);
    assert.ok(restSeatStepBias(13, table) < 0, 'the Tavern draws idlers by day');
    assert.ok(restSeatStepBias(23, table) < restSeatStepBias(13, table), 'and more so at night');
    assert.ok(restSeatStepBias(null, table) < 0);
});

test('the errand table follows recent phases and never picks where the body stands', () => {
    const tally = (recent, current = null) => {
        const counts = {};
        for (let cycle = 0; cycle < 400; cycle++) {
            const choice = errandChoice({ agentId: 'w', cycle, recentBuildings: recent, currentBuilding: current, homeDistrict: 'portal' });
            assert.notEqual(choice.building, current);
            counts[choice.kind] = (counts[choice.kind] || 0) + 1;
        }
        return counts;
    };
    const edits = tally(['forge', 'forge', 'forge', 'forge']);
    assert.ok(edits.deliver > edits.scroll && edits.deliver > edits.quay);
    const reads = tally(['archive', 'archive', 'archive', 'archive'], 'forge');
    assert.ok(reads.scroll > reads.deliver);
    const pushes = tally(['harbor', 'harbor', 'harbor'], 'forge');
    assert.ok(pushes.quay > pushes.scroll);
    tally(['forge'], 'taskboard');
});

function workerSprite(t, { intent = null } = {}) {
    let now = NOW;
    t.mock.method(Date, 'now', () => now);
    let current = intent;
    const calls = [];
    const sprite = new AgentSprite({ id: 'worker-1', status: AgentStatus.WORKING, provider: 'claude', model: 'claude-sonnet-4-6' }, {
        getIntentForAgent: () => current,
        allocateVisitTile: (request) => {
            calls.push(request);
            return { tileX: 24, tileY: 28, slotId: `${request.building?.type}-0`, buildingType: request.building?.type };
        },
    });
    t.mock.method(sprite, '_assignTarget', function assign() { this._targetReachable = true; });
    Object.assign(sprite, tileToWorld(25, 30));
    sprite.moving = false;
    sprite.motionScale = 1;
    return {
        sprite,
        calls,
        setIntent: (next) => { current = next; },
        advance: (ms) => { now += ms; return now; },
        now: () => now,
    };
}

test('an errand starts only after the gap, ends the moment a real intent arrives, and is never work', t => {
    const tool = { id: 'tool-edit', source: 'tool', building: 'forge', priority: 80, expiresAt: NOW + 30_000 };
    const { sprite, setIntent, advance, now } = workerSprite(t, { intent: tool });
    sprite.behavior.recentBuildings.push('forge', 'forge', 'forge');
    sprite._lastBuildingType = 'forge';
    sprite._advanceCrowdRoutine(now());
    assert.equal(sprite._restPlaceForState(), null, 'a live intent: no errand');
    setIntent(null);
    sprite._advanceCrowdRoutine(advance(ERRAND_GAP_MS - 1));
    assert.equal(sprite._crowd.place, null, 'inside the gap: no errand yet');
    sprite._advanceCrowdRoutine(advance(2));
    const leg = sprite._restPlaceForState();
    assert.equal(leg?.role, 'errand');
    assert.ok(sprite._routeToRestPlace());
    assert.equal(sprite.visitRole, 'errand');
    assert.equal(isWorkingVisitor(sprite.agent, { building: leg.building.type, role: sprite.visitRole }), false);

    setIntent({ ...tool, id: 'tool-edit-2', expiresAt: now() + 30_000 });
    sprite._advanceCrowdRoutine(advance(16));
    assert.equal(sprite._crowd.place, null, 'a real intent ends the errand at once');
    assert.equal(sprite._restPlaceForState(), null);
});

test('an errand never outlives its dwell or a lost leg', t => {
    const { sprite, setIntent, advance, now } = workerSprite(t);
    setIntent({ id: 'read', building: 'archive', priority: 80 });
    sprite._advanceCrowdRoutine(now());
    setIntent(null);
    sprite._advanceCrowdRoutine(advance(ERRAND_GAP_MS));
    assert.ok(sprite._routeToRestPlace());
    sprite.moving = false;
    sprite.waitTimer = 60;
    sprite._holdRestPlace(now());
    assert.equal(sprite._crowd.arrivedAt, now());
    sprite._advanceCrowdRoutine(advance(errandDwellMs('worker-1', sprite._crowd.cycle)));
    assert.equal(sprite._crowd.place, null);
    assert.ok(sprite._crowd.cooldownUntil > now(), 'a cooldown follows every errand');
    // A leg that never arrives gives up too.
    sprite._advanceCrowdRoutine(advance(20_000));
    assert.equal(sprite._crowd.place?.role, 'errand');
    sprite._advanceCrowdRoutine(advance(45_000));
    assert.equal(sprite._crowd.place, null);
});

test('an idle villager sits its seeded span, strolls under the cap, then sits again', t => {
    let now = NOW;
    t.mock.method(Date, 'now', () => now);
    const requests = [];
    let grant = true;
    const sprite = new AgentSprite({ id: 'idle-1', status: AgentStatus.IDLE, provider: 'claude', model: 'claude-sonnet-4-6' }, {
        getAmbientDestination: (request) => { requests.push(request); return grant ? scenicBuilding() : null; },
        getDayHour: () => 13,
    });
    sprite.motionScale = 1;
    sprite.moving = false;
    sprite.visitRole = 'rest';
    sprite._advanceCrowdRoutine(now);
    const sitUntil = sprite._crowd.until;
    assert.equal(sitUntil - now, sitDurationMs('idle-1', 0, 1));
    now = sitUntil - 1;
    sprite._advanceCrowdRoutine(now);
    assert.equal(requests.length, 0, 'no stroll before the minimum sit');
    grant = false;
    now = sitUntil;
    sprite._advanceCrowdRoutine(now);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].role, 'stroll');
    assert.equal(requests[0].routineCap, STROLL_CAP);
    assert.ok(sprite._crowd.until > now, 'a refused stroll stays seated and asks later');
    assert.equal(sprite._restPlaceForState().restSeats, true);
    grant = true;
    now = sprite._crowd.until;
    sprite._advanceCrowdRoutine(now);
    assert.equal(sprite._restPlaceForState().role, 'stroll');
    sprite.visitRole = 'stroll';
    sprite.waitTimer = 60;
    sprite._markCrowdArrival(now);
    now += strollDwellMs('idle-1', 0);
    sprite._advanceCrowdRoutine(now);
    assert.equal(sprite._crowd.phase, 'sit');
    assert.equal(sprite._restPlaceForState().restSeats, true, 'back to a seat after the dwell');
    // Reduced motion: the seated body never stands up.
    sprite.visitRole = 'rest';
    sprite.motionScale = 0;
    sprite._advanceCrowdRoutine(now);
    now = sprite._crowd.until + 1;
    const before = requests.length;
    sprite._advanceCrowdRoutine(now);
    assert.equal(requests.length, before);
});

test('a finished session winds down at a stop, then waits inside the gate; resuming ends it', t => {
    let now = NOW;
    t.mock.method(Date, 'now', () => now);
    const agent = { id: 'done-1', status: AgentStatus.COMPLETED, provider: 'claude', model: 'claude-sonnet-4-6' };
    const sprite = new AgentSprite(agent, {});
    sprite.motionScale = 1;
    sprite._advanceCrowdRoutine(now);
    const stop = sprite._restPlaceForState();
    assert.ok(stop, 'a wind-down stop');
    assert.equal(sprite._crowd.phase, 'winddown-stop');
    sprite.visitRole = stop.restSeats ? 'rest' : 'winddown';
    sprite._markCrowdArrival(now);
    now += windDownDwellMs('done-1');
    sprite._advanceCrowdRoutine(now);
    assert.equal(sprite._crowd.phase, 'winddown-gate');
    assert.equal(sprite._restPlaceForState().building.type, 'ambient:gate-winddown');
    assert.equal(isWorkingVisitor({ ...agent, status: 'working' }, { role: 'winddown' }), false);
    agent.status = AgentStatus.WORKING;
    sprite._advanceCrowdRoutine(now + 16);
    assert.equal(sprite._restPlaceForState(), null, 'a resumed session drops the wind-down at once');
});

test('an orchestrator blocked on its subagents goes for a pint, and the wait ending calls it back', t => {
    const { sprite, calls, advance, now } = workerSprite(t);
    Object.assign(sprite.agent, { provider: 'omp', turnState: 'tool_pending', pendingTool: 'wait', pendingSince: now() });
    sprite._advanceCrowdRoutine(now());
    assert.equal(sprite._restPlaceForState(), null, 'a fresh wait stays at Command');
    sprite._advanceCrowdRoutine(advance(SUBAGENT_WAIT_PINT_MS));
    assert.equal(sprite._crowd.place, null, 'no errand while waiting');
    assert.equal(sprite._restPlaceForState()?.restSeats, true, 'a long wait takes a rest seat');
    assert.ok(sprite._routeToRestPlace());
    assert.equal(sprite.visitRole, 'rest');
    assert.equal(calls.at(-1).building.restSeats, true);
    assert.equal(calls.at(-1).restAt, 'tavern', 'AG-2: a lead waiting on its subagents rests at the Tavern only');

    Object.assign(sprite.agent, { turnState: 'working', pendingTool: null, pendingSince: null });
    assert.equal(sprite._restPlaceForState(), null, 'the wait ending sends it back to work');
});

test('every harness wait on subagents counts, and nothing else does', () => {
    const pending = (provider, pendingTool, extra = {}) => ({
        provider, pendingTool, status: AgentStatus.WORKING, turnState: 'tool_pending',
        pendingSince: NOW - SUBAGENT_WAIT_PINT_MS, ...extra,
    });
    const pint = (agent, prev = null, opts) => advanceSubagentWait(prev, agent, NOW, opts)?.pint === true;
    assert.equal(pint(pending('omp', 'wait')), true, 'omp job wait');
    assert.equal(pint(pending('codex', 'wait_agent')), true, 'Codex wait_agent');
    assert.equal(pint(pending('claude', 'Agent')), true, 'Claude Code foreground subagent');
    assert.equal(pint(pending('codex', 'wait')), false, "Codex's bare wait polls a code cell");
    assert.equal(pint(pending('omp', 'grep')), false, 'a stale grep is no wait');
    assert.equal(pint(pending('omp', 'wait', { pendingSince: NOW - 1 })), false, 'not yet a minute');
    assert.equal(pint(pending('omp', 'wait', { status: AgentStatus.WAITING_ON_USER })), false);

    const closed = { provider: 'claude', status: AgentStatus.COMPLETED, turnState: 'awaiting_input' };
    assert.equal(pint(closed, null, { hasLiveSubagents: true }), true, 'a closed turn on background subagents');
    assert.equal(pint(closed), false, 'a closed turn with none left winds down');
    assert.equal(pint({ ...closed, isDeparted: true }, null, { hasLiveSubagents: true }), false);
});

test('PV-2: a closed turn waiting on its own crew takes its pint after a minute, like a pending Agent call', () => {
    const crew = (extra = {}) => ({
        provider: 'claude', status: AgentStatus.WORKING, turnState: 'awaiting_input',
        awaitingSince: NOW - SUBAGENT_WAIT_PINT_MS, backgroundPending: { count: 2, kinds: ['agent'], since: NOW - 90_000 },
        ...extra,
    });
    const wait = advanceSubagentWait(null, crew(), NOW);
    assert.equal(wait.pint, true, 'a minute since its turn closed');
    assert.equal(wait.since, NOW - SUBAGENT_WAIT_PINT_MS, 'the wait runs from the close, not the launch');
    assert.equal(advanceSubagentWait(null, crew({ awaitingSince: NOW - 1 }), NOW).pint, false, 'not yet a minute');
    assert.equal(advanceSubagentWait(null, crew({ backgroundPending: null }), NOW), null, 'no crew, no wait');
    assert.equal(advanceSubagentWait(null, crew({ status: AgentStatus.COMPLETED }), NOW), null,
        'a COMPLETED status is not this wait');

    // The lead reads a crew notice and closes again: the seat holds.
    const reading = crew({ turnState: 'working', awaitingSince: null, lastTool: 'Read' });
    assert.equal(advanceSubagentWait(wait, reading, NOW + 5_000), wait);
    assert.equal(advanceSubagentWait(wait, reading, NOW + SUBAGENT_WAIT_SLICE_GAP_MS), null, 'a long read is work');
    assert.equal(advanceSubagentWait(wait, { ...reading, backgroundPending: null }, NOW + 5_000), null,
        'with its crew home, work is just work');
});

test('PV-2: a lead waits on its crew at any depth, finished children included', () => {
    const agents = new Map([
        ['lead', { id: 'lead', status: AgentStatus.COMPLETED }],
        ['child', { id: 'child', status: AgentStatus.COMPLETED }],
        ['grandchild', { id: 'grandchild', status: AgentStatus.WORKING }],
    ]);
    const parentToChildren = new Map([['lead', new Set(['child'])], ['child', new Set(['grandchild'])]]);
    const renderer = { world: { agents }, relationshipState: { parentToChildren } };
    renderer._hasLiveSubagents = IsometricRenderer.prototype._hasLiveSubagents;
    assert.equal(renderer._hasLiveSubagents('lead'), true, 'a working grandchild holds its lead');
    agents.get('grandchild').status = AgentStatus.COMPLETED;
    assert.equal(renderer._hasLiveSubagents('lead'), false);
    agents.get('grandchild').status = AgentStatus.WORKING;
    agents.get('grandchild').isDeparted = true;
    assert.equal(renderer._hasLiveSubagents('lead'), false, 'a departed grandchild holds nobody');
    parentToChildren.set('grandchild', new Set(['lead']));
    agents.get('grandchild').isDeparted = false;
    agents.get('grandchild').status = AgentStatus.COMPLETED;
    assert.equal(renderer._hasLiveSubagents('lead'), false, 'a cycle ends the walk');
});

test("Codex's short wait slices add up to one wait, and real work ends it", () => {
    const slice = (start) => ({
        provider: 'codex', status: AgentStatus.WORKING, turnState: 'tool_pending',
        pendingTool: 'wait_agent', pendingSince: start, lastTool: 'wait_agent',
    });
    const between = { provider: 'codex', status: AgentStatus.WORKING, turnState: 'working', lastTool: 'wait_agent' };
    let wait = null;
    let t = NOW;
    for (let i = 0; i < 6; i++) {
        wait = advanceSubagentWait(wait, slice(t), t);
        t += 10_000;
        wait = advanceSubagentWait(wait, between, t);
        assert.ok(wait, 'the gap between slices holds the wait');
        t += 2_000;
    }
    assert.equal(advanceSubagentWait(wait, slice(t), t).pint, true, 'six 10 s slices make a minute');
    assert.equal(advanceSubagentWait(wait, between, t + SUBAGENT_WAIT_SLICE_GAP_MS), null, 'a long gap is not a wait');
    assert.equal(advanceSubagentWait(wait, { ...between, lastTool: 'exec_command' }, t + 1), null, 'a real tool ends it');
});

test('a Claude Code orchestrator closed on background subagents drinks instead of winding down', t => {
    t.mock.method(Date, 'now', () => NOW);
    let live = true;
    const agent = { id: 'lead-1', status: AgentStatus.COMPLETED, provider: 'claude', model: 'claude-opus-5-5' };
    const sprite = new AgentSprite(agent, { hasLiveSubagents: (id) => id === 'lead-1' && live });
    sprite.motionScale = 1;
    sprite._advanceCrowdRoutine(NOW);
    assert.equal(sprite._crowd.phase, null, 'no wind-down while its subagents run');
    assert.equal(sprite._restPlaceForState().restSeats, true);
    live = false;
    sprite._advanceCrowdRoutine(NOW);
    assert.equal(sprite._crowd.phase, 'winddown-stop', 'the last subagent done: the wind-down starts');
    const stop = sprite._restPlaceForState();
    assert.equal(sprite._restAtFor(stop), stop.restSeats ? 'tavern' : null, 'AG-2: a Tavern wind-down rests at the Tavern only');
});
