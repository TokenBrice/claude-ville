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
    const brazier = REST_SEATS.find((seat) => seat.id === 'command-east-step-n');
    assert.ok(restSeatStepBias(23, brazier) < 0);
    assert.equal(restSeatStepBias(13, brazier), 0);
    assert.equal(restSeatStepBias(null, brazier), 0);
});

test('the errand table follows recent phases and never picks where the body stands', () => {
    const tally = (recent, current = null) => {
        const counts = {};
        for (let cycle = 0; cycle < 400; cycle++) {
            const choice = errandChoice({ agentId: 'w', cycle, recentBuildings: recent, currentBuilding: current, homeDistrict: 'observatory' });
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
