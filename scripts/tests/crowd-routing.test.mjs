import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { homeDistrictFor, WORK_DISTRICTS, updateHomeDistrictContext } from '../../claudeville/src/presentation/character-mode/HomeDistrict.js';
import { resolveUpdateRouteBuilding } from '../../claudeville/src/presentation/character-mode/MovementRouting.js';
import { AgentBehaviorState } from '../../claudeville/src/presentation/character-mode/AgentBehaviorState.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { VisitTileAllocator } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';
import { VisitIntentManager, isWorkingVisitor } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { Pathfinder, routePersonalityFor, ROUTE_PERSONALITIES } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';

const fullGrid = () => new Uint8Array(MAP_SIZE * MAP_SIZE).fill(1);

test('home holds for two minutes across object replacements, load and tool-mix changes', () => {
    const agent = { id: 'stable-home', projectPath: '/repo' };
    const home = homeDistrictFor(agent, { now: 1000 });
    const loads = Object.fromEntries(WORK_DISTRICTS.map(type => [type, type === home ? 10000 : 0]));
    assert.equal(homeDistrictFor({ ...agent }, { now: 120999, loads }), home);
    assert.notEqual(homeDistrictFor(agent, { now: 121000, loads }), home);
});

test('live district load weighting reduces overloaded fallback share', () => {
    let baseline = 0;
    let loaded = 0;
    for (let i = 0; i < 400; i++) {
        const agent = { id: `load-${i}` };
        if (homeDistrictFor(agent, { now: 0, loads: {} }) === 'command') baseline++;
        if (homeDistrictFor(agent, { now: 120000, loads: { command: 30 } }) === 'command') loaded++;
    }
    assert.ok(baseline > 20);
    assert.ok(loaded < baseline / 4, `${loaded} overloaded vs ${baseline} baseline`);
});

test('project observations weight homes while unknown projects keep a spread', () => {
    const sprites = Array.from({ length: 8 }, (_, i) => ({ agent: { id: `mix-${i}`, projectPath: '/forge', lastTool: 'Edit' } }));
    updateHomeDistrictContext(sprites, 400000);
    let forgeShare = 0;
    const homes = new Set();
    for (let i = 0; i < 200; i++) {
        if (homeDistrictFor({ id: `forge-${i}`, projectPath: '/forge' }, { now: 400000 }) === 'forge') forgeShare++;
        homes.add(homeDistrictFor({ id: `spread-${i}` }, { now: 400000 }));
    }
    assert.ok(forgeShare > 65, `forge share ${forgeShare}/200`);
    assert.equal(homes.size, WORK_DISTRICTS.length);
});

test('live tool and route evidence always precede home fallback', () => {
    const agent = { id: 'evidence', currentTool: 'Edit' };
    assert.equal(resolveUpdateRouteBuilding({ agent, status: 'working' }), 'forge');
    assert.equal(resolveUpdateRouteBuilding({ agent, status: 'working', activeIntentBuilding: 'harbor' }), 'harbor');
    assert.equal(resolveUpdateRouteBuilding({ agent: { id: 'known' }, status: 'working', lastKnownBuilding: 'archive' }), 'archive');
});

function itineraryFixture(inferred = false) {
    let now = 0;
    const behavior = new AgentBehaviorState({ now: () => now });
    const intent = { id: 'round', source: 'tool', building: 'archive', priority: 80, itinerary: { route: ['archive', 'forge', 'taskboard'], currentIndex: 0, inferred } };
    behavior.setRoute({ intent, building: 'archive' });
    behavior.arrive();
    return { behavior, intent, setNow: value => { now = value; } };
}

test('positive arrival dwell advances only real itineraries exactly once', () => {
    for (const inferred of [false, true]) {
        const { behavior, setNow } = itineraryFixture(inferred);
        behavior.finishVisit();
        assert.equal(behavior.currentItinerary.currentIndex, 0, 'no dwell is not completion');
        behavior.arrive();
        setNow(5000);
        behavior.finishVisit();
        assert.equal(behavior.currentItinerary.currentIndex, inferred ? 0 : 1);
        if (!inferred) {
            assert.equal(behavior.currentItinerary.currentStop, 'forge');
            assert.equal(behavior.currentItinerary.nextStop, 'taskboard');
        }
        behavior.finishVisit();
        assert.equal(behavior.currentItinerary.currentIndex, inferred ? 0 : 1);
    }
});

test('preemption records dwell without advancing an unfinished itinerary', () => {
    const { behavior, setNow } = itineraryFixture();
    setNow(2000);
    behavior.setRoute({ intent: { id: 'alert', source: 'alert', building: 'watchtower' }, building: 'watchtower' });
    assert.equal(behavior.completedVisitHistory[0].itinerary.currentIndex, 0);
});

test('itinerary hook routes the advanced real stop and reduced motion holds', () => {
    const { behavior, intent, setNow } = itineraryFixture();
    setNow(5000);
    behavior.finishVisit();
    // Manager normalization explicitly marks authored routes as non-inferred.
    intent.itinerary = { ...intent.itinerary, currentStop: 'archive', nextStop: 'forge' };
    const sprite = Object.assign(Object.create(AgentSprite.prototype), { behavior, agent: { status: 'working' }, motionScale: 0 });
    assert.equal(sprite._itineraryNextStop(intent), null);
    sprite.motionScale = 1;
    assert.equal(sprite._itineraryNextStop(intent), 'forge');
    assert.equal(intent.building, 'forge');
    assert.equal(intent.itinerary.currentIndex, 1);
    assert.equal(sprite._itineraryNextStop(intent), null);
});

test('manager preserves real itinerary progress on refresh, phase guesses stay inferred and unlit', () => {
    const manager = new VisitIntentManager({ now: () => 1000 });
    try {
        const draft = { source: 'tool', sourceKey: 'real', building: 'archive', itinerary: ['archive', 'forge'] };
        const real = manager._upsertIntent('worker', draft, 1000);
        assert.equal(real.itinerary.inferred, false);
        real.itinerary.currentIndex = 1;
        real.itinerary.currentStop = 'forge';
        real.itinerary.nextStop = null;
        const refreshed = manager._upsertIntent('worker', draft, 2000);
        assert.equal(refreshed.building, 'forge');
        assert.equal(refreshed.itinerary.currentIndex, 1);
        const inferred = manager._upsertIntent('guessed', { source: 'tool', building: 'archive' }, 1000);
        assert.equal(inferred.itinerary.inferred, true);
        assert.equal(isWorkingVisitor({ status: 'working' }, { intent: inferred, building: 'forge' }), false);
        assert.equal(isWorkingVisitor({ status: 'working' }, { intent: inferred, building: 'archive' }), true);
    } finally {
        manager.dispose();
    }
});

test('allocator project tie-break co-locates same repos and spreads different repos without overpowering capacity', () => {
    const allocator = new VisitTileAllocator();
    allocator.agentMeta.set('a', { projectKey: '/one' });
    allocator.agentMeta.set('b', { projectKey: '/one' });
    allocator.reservations.set('b', { agentId: 'b', buildingType: 'forge', tileX: 10, tileY: 10 });
    const slot = { tileX: 11, tileY: 10 };
    assert.ok(allocator._projectSlotBonus('a', 'forge', slot) > 0);
    allocator.agentMeta.set('b', { projectKey: '/two' });
    assert.ok(allocator._projectSlotBonus('a', 'forge', slot) < 0);
    assert.ok(Math.abs(allocator._projectSlotBonus('a', 'forge', slot)) < 1);
});

test('congestion snapshots hold two seconds, round counts and reuse unchanged content versions', () => {
    const allocator = new VisitTileAllocator();
    allocator._occupancyBuckets.set('10,10', [{}, {}, {}]);
    const first = allocator.getCongestionSnapshot(2000);
    assert.equal(first.congestionTiles.get('10,10'), 4);
    allocator._occupancyBuckets.set('10,10', [{}, {}, {}, {}, {}]);
    assert.equal(allocator.getCongestionSnapshot(3999), first);
    const next = allocator.getCongestionSnapshot(4000);
    assert.equal(next.congestionTiles.get('10,10'), 6);
    assert.notEqual(next.congestionVersion, first.congestionVersion);
    assert.equal(allocator.getCongestionSnapshot(6000).congestionVersion, next.congestionVersion);
    assert.equal(allocator.occupancyBuckets, allocator._occupancyBuckets);
});

test('long trips receive authored lanes, congestion and at most four route personality/cache buckets', () => {
    const lanes = new Map([['4,4', {}], ['6,6', { plazaLike: true }]]);
    const congestion = new Map([['3,3', 4]]);
    const bridges = new Map([['5,5', { bridgeId: 'west' }], ['7,7', { bridgeId: 'east' }]]);
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        getRoadTiles: () => new Set(['2,2']), bridgeTiles: bridges,
        getRoutingContext: () => ({ laneTiles: lanes, congestionTiles: congestion, congestionVersion: 'crowd-1' }),
    });
    const pathfinder = new Pathfinder(fullGrid());
    const keys = new Set();
    const buckets = new Set();
    const from = { tileX: 1, tileY: 1 };
    const to = { tileX: 12, tileY: 12 };
    for (let i = 0; i < 100; i++) {
        sprite.agent = { id: `personality-${i}` };
        const options = sprite._pathOptions(from, to);
        assert.equal(options.laneTiles, lanes);
        assert.equal(options.congestionTiles, congestion);
        assert.equal(routePersonalityFor(sprite.agent.id), options.personalityBucket);
        assert.equal(options.plazaTiles.has('6,6'), true);
        const normalized = pathfinder._normalizePathOptions(options, bridges);
        assert.equal(pathfinder._tileTravelWeight(6, 6, null, normalized), options.weights.plaza);
        keys.add(pathfinder._pathOptionsCacheKey(pathfinder._normalizePathOptions(options, bridges)));
        buckets.add(options.personalityBucket);
    }
    assert.equal(buckets.size, 4);
    assert.equal(keys.size, 4);
    assert.equal(sprite._pathOptions(from, { tileX: 4, tileY: 4 }), null);
    assert.equal(ROUTE_PERSONALITIES.length, 4);
    assert.equal(pathfinder.getDiagnostics().cacheLimit, 384);
});

test('cache versions include personality and congestion even with explicit cacheKey; overrides affect travel costs', () => {
    const pathfinder = new Pathfinder(fullGrid());
    const roadTiles = new Set(['2,2']);
    const base = { roadTiles, cacheKey: 'roads', congestionVersion: 'a' };
    const first = pathfinder._normalizePathOptions({ ...base, personalityBucket: 0 }, null);
    const second = pathfinder._normalizePathOptions({ ...base, personalityBucket: 1 }, null);
    const crowd = pathfinder._normalizePathOptions({ ...base, personalityBucket: 0, congestionVersion: 'b' }, null);
    assert.notEqual(pathfinder._pathOptionsCacheKey(first), pathfinder._pathOptionsCacheKey(second));
    assert.notEqual(pathfinder._pathOptionsCacheKey(first), pathfinder._pathOptionsCacheKey(crowd));
    assert.notEqual(pathfinder._tileTravelWeight(2, 2, null, first), pathfinder._tileTravelWeight(2, 2, null, second));
    const bridges = new Map([['5,5', { bridgeId: 'west' }], ['7,7', { bridgeId: 'east' }]]);
    const preferred = pathfinder._normalizePathOptions({ ...base, preferredBridgeId: 'west' }, bridges);
    assert.ok(pathfinder._tileTravelWeight(5, 5, bridges, preferred) < pathfinder._tileTravelWeight(7, 7, bridges, preferred));
});

test('pickTarget consumes dwell advancement through all real itinerary stops', () => {
    const { behavior, intent, setNow } = itineraryFixture();
    const visited = [];
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        behavior, agent: { id: 'round-worker', status: 'working' }, motionScale: 1, _targetCycle: 0,
        _routeToRestPlace: () => false,
        _activeVisitIntent: () => intent,
        _ambientDestination: () => null,
        _buildingForType: type => ({ type }),
        _visitTileForBuilding: () => ({ tileX: 10, tileY: 10 }),
        _routeToVisitTarget: (building, routeIntent) => {
            visited.push(building.type);
            behavior.setRoute({ intent: routeIntent, building: building.type });
            behavior.arrive();
            return true;
        },
    });
    for (const now of [5000, 10000]) {
        setNow(now);
        behavior.finishVisit();
        sprite._pickTarget();
    }
    assert.deepEqual(visited, ['forge', 'taskboard']);
    assert.equal(behavior.currentItinerary.currentIndex, 2);
    assert.equal(behavior.currentItinerary.nextStop, null);
});
