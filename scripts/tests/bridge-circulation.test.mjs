import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { getCoastField } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { VILLAGE_SURFACES } from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';

function buildLiveWorld() {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
    }
    const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
    const scenery = new SceneryEngine({
        world: { buildings },
        terrainSeed,
        tileNoise: (x, y) => noise._tileNoise(x, y),
        smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const pathfinder = new Pathfinder(grid.slice());
    pathfinder.keepReachableFrom(VILLAGE_GATE.inside);
    const bridgeTiles = scenery.getBridgeTiles();
    const coastField = getCoastField({
        world: { buildings },
        waterTiles: scenery.getWaterTiles(),
        shoreTiles: scenery.getShoreTiles(),
        bridgeTiles,
        waterMeta: scenery.getWaterMeta(),
        scenery,
        terrainSeed,
        _tileNoise: (x, y) => noise._tileNoise(x, y),
        _smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    return { buildings, scenery, pathfinder, bridgeTiles, coastField };
}

const LIVE_WORLD = buildLiveWorld();

function createLiveRenderer() {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.world = { buildings: LIVE_WORLD.buildings };
    renderer.scenery = LIVE_WORLD.scenery;
    renderer.pathfinder = LIVE_WORLD.pathfinder;
    renderer.bridgeTiles = LIVE_WORLD.bridgeTiles;
    renderer._coastField = LIVE_WORLD.coastField;
    renderer.surfaceRegistry = VILLAGE_SURFACES;
    renderer.agentSprites = new Map();
    renderer.gateTransits = new Map();
    renderer.motionScale = 1;
    renderer._markSpritesDirty = () => {};
    for (const name of [
        'pathTiles',
        'townSquareTiles',
        'mainAvenueTiles',
        'dirtPathTiles',
        'busyWalkTiles',
        'commandCenterRoadTiles',
    ]) {
        renderer[name] = new Set();
    }
    renderer._generatePaths();
    for (const key of LIVE_WORLD.bridgeTiles.keys()) {
        renderer.pathTiles.add(key);
    }
    renderer._laneTiles = renderer._buildLaneTileIndex();
    assert.ok(renderer._laneTiles.has('18,24'), 'production lane tile index must include central bridge deck');
    return renderer;
}

function spawnWalker(renderer, id, startTile, goalTile, { status = 'working' } = {}) {
    const agent = new Agent({
        id,
        name: id,
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        status,
        position: { tileX: startTile[0], tileY: startTile[1] },
    });
    const sprite = new AgentSprite(agent, {
        pathfinder: LIVE_WORLD.pathfinder,
        bridgeTiles: LIVE_WORLD.bridgeTiles,
        isPointWalkable: (x, y) => renderer._isWorldPointWalkable(x, y),
        deferInitialTarget: true,
    });
    // Pin start coordinates explicitly and disable autonomous post-arrival re-picking.
    const startWorld = tileToWorld(startTile[0], startTile[1]);
    sprite.x = startWorld.x;
    sprite.y = startWorld.y;
    sprite._pickTarget = () => {};
    // Track blocked-step reroutes cleanly for zero-reroute assertions.
    let reroutes = 0;
    const origReroute = sprite._rerouteAroundBlockedStep.bind(sprite);
    sprite._rerouteAroundBlockedStep = (...args) => {
        reroutes++;
        return origReroute(...args);
    };
    sprite._testGetReroutes = () => reroutes;

    const goalWorld = tileToWorld(goalTile[0], goalTile[1]);
    sprite._assignTarget(goalWorld.x, goalWorld.y, goalTile[0], goalTile[1]);
    assert.equal(sprite._targetReachable, true, `expected reachable route for ${id} from (${startTile}) to (${goalTile})`);
    assert.ok(sprite.waypoints.length > 0, `expected waypoints for ${id} from (${startTile}) to (${goalTile})`);
    sprite.moving = true;
    // Clear initial start-beat delay so synchronized timing fixtures are exact.
    sprite._holdMs = 0;
    renderer.agentSprites.set(id, sprite);
    return sprite;
}

function simulateWalkers(renderer, sprites, { maxFrames = 1400, dtMs = 1000 / 60, onFrame = null } = {}) {
    let frames = 0;
    while (frames < maxFrames) {
        const moving = sprites.filter((s) => s.moving);
        if (moving.length === 0) break;
        frames++;
        for (const sprite of sprites) {
            sprite.update(null, dtMs);
        }
        const stillMoving = sprites.filter((s) => s.moving);
        if (stillMoving.length > 0) {
            renderer._stepOrcaCrowd(stillMoving, dtMs);
        }
        if (onFrame) onFrame(frames, sprites, renderer);
    }
    const doneCount = sprites.filter((s) => !s.moving).length;
    return {
        frames,
        seconds: (frames * dtMs) / 1000,
        doneCount,
        allDone: doneCount === sprites.length,
    };
}

test('solo crossing on central-river-bridge completes cleanly with zero reroutes and zero walk clamps', () => {
    for (const [label, start, goal] of [
        ['southbound', [18, 20], [18, 28]],
        ['northbound', [18, 28], [18, 20]],
    ]) {
        const renderer = createLiveRenderer();
        const walker = spawnWalker(renderer, `solo-${label}`, start, goal);
        const result = simulateWalkers(renderer, [walker], { maxFrames: 420 });
        const stats = renderer.getCrowdOrcaDiagnostics();

        assert.equal(result.allDone, true, `${label} solo walker must finish (${result.seconds.toFixed(2)}s)`);
        assert.ok(result.seconds <= 6.0, `${label} solo crossing took ${result.seconds.toFixed(2)}s`);
        assert.equal(walker._testGetReroutes(), 0, `${label} solo crossing must have 0 blocked-step reroutes`);
        assert.equal(stats.walkClamps, 0, `${label} solo crossing must have 0 ORCA walk clamps`);
    }
});

test('all 6 opposing 1v1 timing offsets on central-river-bridge pass smoothly in dedicated lanes with zero yields or reroutes', () => {
    const cases = [
        ['20v28', [18, 20], [18, 28]],
        ['21v28', [18, 21], [18, 28]],
        ['21v27', [18, 21], [18, 27]],
        ['22v28', [18, 22], [18, 28]],
        ['20v27', [18, 20], [18, 27]],
        ['21v29', [18, 21], [18, 29]],
    ];

    for (const [label, startS, startN] of cases) {
        const renderer = createLiveRenderer();
        const south = spawnWalker(renderer, `S-${label}`, startS, startN);
        const north = spawnWalker(renderer, `N-${label}`, startN, startS);
        let minDist = Infinity;
        let yieldFrames = 0;

        const result = simulateWalkers(renderer, [south, north], {
            maxFrames: 420,
            onFrame: () => {
                const dist = Math.hypot(south.x - north.x, south.y - north.y);
                if (dist < minDist) minDist = dist;
                if (south._followYield || north._followYield) yieldFrames++;
            },
        });

        assert.equal(result.allDone, true, `1v1 ${label} must finish cleanly`);
        assert.ok(result.seconds <= 5.5, `1v1 ${label} took ${result.seconds.toFixed(2)}s`);
        assert.equal(yieldFrames, 0, `1v1 ${label} opposing lanes must glide past with 0 yields, got ${yieldFrames}`);
        assert.equal(south._testGetReroutes() + north._testGetReroutes(), 0, `1v1 ${label} must have 0 reroutes`);
        assert.ok(minDist >= 13.0, `1v1 ${label} must keep >= 13px lane separation, got ${minDist.toFixed(2)}px`);
    }
});

test('heavy 6v6 bidirectional rush across central-river-bridge achieves 100% completion without landing traps or deadlocks', () => {
    const renderer = createLiveRenderer();
    const northStarts = [[16, 20], [17, 20], [18, 20], [19, 20], [20, 20], [18, 21]];
    const southGoals = [[16, 28], [17, 28], [18, 28], [19, 28], [20, 28], [18, 27]];
    const southStarts = [[16, 28], [17, 28], [18, 28], [19, 28], [20, 28], [18, 27]];
    const northGoals = [[16, 20], [17, 20], [18, 20], [19, 20], [20, 20], [18, 21]];

    const sprites = [];
    for (let i = 0; i < 6; i++) {
        sprites.push(spawnWalker(renderer, `S-${i}`, northStarts[i], southGoals[i]));
        sprites.push(spawnWalker(renderer, `N-${i}`, southStarts[i], northGoals[i]));
    }

    const lastPos = sprites.map((s) => ({ x: s.x, y: s.y, stallFrames: 0, maxStallFrames: 0 }));
    const result = simulateWalkers(renderer, sprites, {
        maxFrames: 1200,
        onFrame: () => {
            for (let i = 0; i < sprites.length; i++) {
                const s = sprites[i];
                if (!s.moving) {
                    lastPos[i].stallFrames = 0;
                    continue;
                }
                const moved = Math.hypot(s.x - lastPos[i].x, s.y - lastPos[i].y);
                if (moved < 0.05) {
                    lastPos[i].stallFrames++;
                    if (lastPos[i].stallFrames > lastPos[i].maxStallFrames) {
                        lastPos[i].maxStallFrames = lastPos[i].stallFrames;
                    }
                } else {
                    lastPos[i].stallFrames = 0;
                    lastPos[i].x = s.x;
                    lastPos[i].y = s.y;
                }
            }
        },
    });

    const stuck = sprites
        .filter((s) => s.moving)
        .map((s) => {
            const t = worldToTile(s.x, s.y);
            const wp = worldToTile(s.targetX, s.targetY);
            return `${s.agent.id}@(${t.tileX.toFixed(2)},${t.tileY.toFixed(2)})->(${wp.tileX.toFixed(2)},${wp.tileY.toFixed(2)})`;
        });
    assert.equal(result.allDone, true, `6v6 central bridge rush must finish 12/12; stuck: ${stuck.join(', ')}`);
    assert.ok(result.seconds <= 18.0, `6v6 central rush took ${result.seconds.toFixed(2)}s`);
    const worstStallSec = Math.max(...lastPos.map((p) => p.maxStallFrames)) / 60;
    assert.ok(worstStallSec < 5.0, `worst continuous stall ${worstStallSec.toFixed(2)}s exceeded 5s`);
    for (const s of sprites) {
        assert.equal(renderer._isWorldPointWalkable(s.x, s.y), true, `${s.agent.id} finished on unwalkable ground`);
    }
});

test('heavy 4v4 bidirectional rush across west-river-plank enforces strict alternating platoon lock with zero opposing deck frames', () => {
    const renderer = createLiveRenderer();
    const northStarts = [[7, 20], [8, 20], [7, 21], [8, 21]];
    const southGoals = [[7, 28], [8, 28], [7, 29], [8, 29]];
    const southStarts = [[7, 28], [8, 28], [7, 29], [8, 29]];
    const northGoals = [[7, 20], [8, 20], [7, 21], [8, 21]];

    const sprites = [];
    for (let i = 0; i < 4; i++) {
        sprites.push(spawnWalker(renderer, `WS-${i}`, northStarts[i], southGoals[i]));
        sprites.push(spawnWalker(renderer, `WN-${i}`, southStarts[i], northGoals[i]));
    }

    let oppOnDeckFrames = 0;
    const result = simulateWalkers(renderer, sprites, {
        maxFrames: 1400,
        onFrame: () => {
            let southOnDeck = 0;
            let northOnDeck = 0;
            for (const s of sprites) {
                if (!s.moving) continue;
                const t = worldToTile(s.x, s.y);
                if (Math.abs(t.tileX - 7) <= 0.6 && t.tileY >= 22.5 && t.tileY <= 26.5) {
                    if (s.agent.id.startsWith('WS-')) southOnDeck++;
                    else northOnDeck++;
                }
            }
            if (southOnDeck > 0 && northOnDeck > 0) oppOnDeckFrames++;
        },
    });

    const diag = renderer.getBridgeTrafficDiagnostics();
    const westSpan = diag?.spans.find((s) => s.id === 'west-river-plank');

    assert.equal(result.allDone, true, `4v4 west trestle rush must finish 8/8 (${result.doneCount}/8)`);
    assert.ok(result.seconds <= 20.0, `4v4 west trestle rush took ${result.seconds.toFixed(2)}s`);
    assert.equal(oppOnDeckFrames, 0, `platoon lock must allow 0 opposing frames on west-river-plank deck, got ${oppOnDeckFrames}`);
    assert.ok(westSpan && westSpan.flips >= 1, `west-river-plank must flip platoon direction, got ${westSpan?.flips}`);
    assert.ok(westSpan && westSpan.holds > 0, `west-river-plank must hold opposing platoon approaches, got ${westSpan?.holds}`);
});

test('command-pond-plank yields brief T-junction courtesy to northbound central-river-bridge exits and completes cleanly', () => {
    const renderer = createLiveRenderer();
    // Synchronized arrival at (18, 22): northbound central-bridge walkers start on
    // the south deck/landing so they exit onto (18, 22) just as eastbound pond-plank
    // walkers enter the approach zone at x = 15..16, y = 22.
    const sprites = [
        spawnWalker(renderer, 'C-0', [18, 25], [18, 19]),
        spawnWalker(renderer, 'C-1', [18, 26], [19, 19]),
        spawnWalker(renderer, 'P-0', [14, 22], [18, 28]),
        spawnWalker(renderer, 'P-1', [13, 22], [19, 28]),
    ];

    const result = simulateWalkers(renderer, sprites, { maxFrames: 900 });
    const diag = renderer.getBridgeTrafficDiagnostics();
    const pondSpan = diag?.spans.find((s) => s.id === 'command-pond-plank');

    assert.equal(result.allDone, true, `T-junction merge must finish 4/4 (${result.doneCount}/4)`);
    assert.ok(result.seconds <= 12.0, `T-junction merge took ${result.seconds.toFixed(2)}s`);
    assert.ok(pondSpan && pondSpan.holds > 0, `command-pond-plank must apply T-junction courtesy hold, got ${pondSpan?.holds}`);
});

test('getBridgeTrafficDiagnostics reports all village spans with hybrid circulation modes', () => {
    const renderer = createLiveRenderer();
    const walker = spawnWalker(renderer, 'probe', [18, 20], [18, 28]);
    simulateWalkers(renderer, [walker], { maxFrames: 5 });

    const diag = renderer.getBridgeTrafficDiagnostics();
    assert.ok(diag && Array.isArray(diag.spans), 'diagnostics must expose span array');
    const byId = new Map(diag.spans.map((s) => [s.id, s]));
    assert.equal(byId.get('central-river-bridge')?.circulationMode, 'two-way');
    assert.equal(byId.get('west-river-plank')?.circulationMode, 'platoon');
    assert.equal(byId.get('command-pond-plank')?.circulationMode, 'platoon');
    assert.equal(byId.get('north-farm-bridge')?.circulationMode, 'platoon');
});

test('adversarial council scenarios: 6v6 west trestle, 3v3/4v4 pond plank, T-junction 10-agent, central 8v8, near-landing goals, and idle deck body all finish 100%', () => {
    const runScenario = (label, specs, maxFrames = 2400) => {
        const renderer = createLiveRenderer();
        const sprites = specs.map(([id, start, goal, opts]) => {
            const sp = spawnWalker(renderer, id, start, goal, opts);
            if (opts?.moving === false) sp.moving = false;
            return sp;
        });
        const active = sprites.filter((s) => s.moving);
        let frames = 0;
        while (frames < maxFrames) {
            const moving = active.filter((s) => s.moving);
            if (moving.length === 0) break;
            frames++;
            for (const sp of sprites) sp.update(null, 1000 / 60);
            const still = active.filter((s) => s.moving);
            if (still.length > 0) renderer._stepOrcaCrowd(still, 1000 / 60);
        }
        const stuck = active.filter((s) => s.moving).map((s) => {
            const t = worldToTile(s.x, s.y);
            const w = worldToTile(s.targetX, s.targetY);
            return `${s.agent.id}@(${t.tileX.toFixed(2)},${t.tileY.toFixed(2)})->(${w.tileX.toFixed(2)},${w.tileY.toFixed(2)})`;
        });
        assert.equal(stuck.length, 0, `${label} must finish 100% within ${(maxFrames / 60).toFixed(1)}s; stuck: ${stuck.join(', ')}`);
    };

    // 1. Astra 6v6 west-river-plank (cols 6..8, rows 20..21 <-> rows 28..29).
    const westN = [[6, 20], [7, 20], [8, 20], [6, 21], [7, 21], [8, 21]];
    const westS = [[6, 28], [7, 28], [8, 28], [6, 29], [7, 29], [8, 29]];
    runScenario('6v6 west-river-plank', [
        ...westN.map((p, i) => [`WS-${i}`, p, westS[i]]),
        ...westS.map((p, i) => [`WN-${i}`, p, westN[i]]),
    ]);

    // 2. Opus 3v3 & Neon 4v4 EW command-pond-plank rushes.
    runScenario('3v3 command-pond-plank', [
        ['E0', [11, 22], [19, 20]], ['E1', [12, 22], [20, 20]], ['E2', [13, 22], [19, 21]],
        ['W0', [19, 20], [11, 22]], ['W1', [20, 20], [12, 22]], ['W2', [19, 21], [13, 22]],
    ]);
    const pondE = [[13, 21], [14, 21], [13, 22], [14, 22]];
    const pondW = [[19, 21], [20, 21], [19, 22], [20, 22]];
    runScenario('4v4 command-pond-plank', [
        ...pondE.map((p, i) => [`PE-${i}`, p, pondW[i]]),
        ...pondW.map((p, i) => [`PW-${i}`, p, pondE[i]]),
    ]);

    // 3. Opus 10-agent central + pond + reverse T-junction rush.
    runScenario('10-agent T-junction heavy', [
        ['E0', [13, 22], [18, 28]], ['E1', [14, 22], [19, 28]], ['E2', [12, 22], [20, 28]],
        ['CW0', [18, 25], [13, 22]], ['CW1', [18, 26], [14, 22]],
        ['CS0', [18, 19], [18, 28]], ['CS1', [19, 19], [19, 28]],
        ['CN0', [18, 28], [18, 19]], ['CN1', [19, 28], [19, 19]],
        ['W0', [20, 22], [12, 22]],
    ]);

    // 4. Neon 4v4 west-river-plank with near-landing goals ([7..8, 20..21] <-> [7..8, 27..28]).
    const nearN = [[7, 20], [8, 20], [7, 21], [8, 21]];
    const nearS = [[7, 27], [8, 27], [7, 28], [8, 28]];
    runScenario('4v4 west-river-plank near-landing', [
        ...nearN.map((p, i) => [`NS-${i}`, p, nearS[i]]),
        ...nearS.map((p, i) => [`NN-${i}`, p, nearN[i]]),
    ]);

    // 5. Opus 8v8 central-river-bridge heavy rush.
    const cN = [[15, 19], [16, 19], [17, 19], [18, 19], [19, 19], [16, 20], [17, 20], [18, 20]];
    const cS = [[15, 28], [16, 28], [17, 28], [18, 28], [19, 28], [16, 29], [17, 29], [18, 29]];
    runScenario('8v8 central-river-bridge', [
        ...cN.map((p, i) => [`CS-${i}`, p, cS[i]]),
        ...cS.map((p, i) => [`CN-${i}`, p, cN[i]]),
    ]);

    // 6. Idle planted body parked on west-river-plank deck with stale route never locks crossing.
    runScenario('idle planted on platoon deck', [
        ['idle-deck', [7, 24], [7, 28], { moving: false }],
        ['N0', [7, 28], [7, 20]],
        ['S0', [7, 20], [7, 28]],
    ]);
});

test('_isSameDirBridgeLeader is a strict total order, bridgeHold never moonwalks during walk-out, and _isFinalStopClearOfStationary guards body boxes', () => {
    const renderer = createLiveRenderer();

    // 1. Strict total order: irreflexive, antisymmetric, and transitive across
    // mixed zones, bucket boundaries, and held/unheld states (including Astra & Neon 3-walker counterexamples).
    const samples = [
        { id: 'a', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'deck', bridgeHold: false, bridgeAlongCoord: 0.0, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 8, bridgeCrossOffset: 8 },
        { id: 'b', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'landing', bridgeHold: false, bridgeAlongCoord: 0.04, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 4, bridgeCrossOffset: 1 },
        { id: 'c', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'deck', bridgeHold: false, bridgeAlongCoord: 0.08, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 8, bridgeCrossOffset: -6 },
        { id: 'd', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'landing', bridgeHold: false, bridgeAlongCoord: 0.04, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 4, bridgeCrossOffset: 4 },
        { id: 'e', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'approach', bridgeHold: true, bridgeAlongCoord: 0.5, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 0, bridgeCrossOffset: 8 },
        { id: 'f', bridgeSpanId: 'central-river-bridge', bridgeDir: 1, bridgeZone: 'deck', bridgeHold: false, bridgeAlongCoord: 0.04, bridgeSpanLaneOffset: 8, bridgeLaneOffset: 8, bridgeCrossOffset: 4 },
    ];
    for (let i = 0; i < samples.length; i++) {
        assert.equal(renderer._isSameDirBridgeLeader(samples[i], samples[i]), false, 'irreflexive');
        for (let j = 0; j < samples.length; j++) {
            if (i === j) continue;
            const ij = renderer._isSameDirBridgeLeader(samples[i], samples[j]);
            const ji = renderer._isSameDirBridgeLeader(samples[j], samples[i]);
            assert.notEqual(ij, ji, `strict antisymmetry for ${samples[i].id} vs ${samples[j].id}`);
            for (let k = 0; k < samples.length; k++) {
                if (ij && renderer._isSameDirBridgeLeader(samples[j], samples[k])) {
                    assert.equal(
                        renderer._isSameDirBridgeLeader(samples[i], samples[k]),
                        true,
                        `strict transitivity for ${samples[i].id} < ${samples[j].id} < ${samples[k].id}`,
                    );
                }
            }
        }
    }
    // Unheld deck walker must always precede a bridgeHold approacher regardless of coordinate.
    assert.equal(renderer._isSameDirBridgeLeader(samples[0], samples[4]), false);
    assert.equal(renderer._isSameDirBridgeLeader(samples[4], samples[0]), true);

    // 2. bridgeHold overrides negative knot walk-out timer cleanly (zero moonwalk).
    const walker = spawnWalker(renderer, 'hold-walkout', [7, 22], [7, 28]);
    // Step past initial start-beat so the walker is actively mid-stride.
    for (let f = 0; f < 6; f++) walker.update(null, 1000 / 60);
    walker._followYield = 'bridge';
    walker._followYieldMs = -400; // active post-knot walk-out window
    const startX = walker.x;
    const startY = walker.y;
    walker.update(null, 1000 / 60);
    // Frame 1 immediately enters contact-frame hold; position, walk frame, and
    // stride distance remain completely frozen across all subsequent held frames.
    const heldFrame = walker.walkFrame;
    const heldStride = walker._strideDistance;
    for (let f = 0; f < 10; f++) {
        walker._followYield = 'bridge';
        walker.update(null, 1000 / 60);
    }
    assert.equal(walker.x, startX, 'bridgeHold must not advance position during walk-out');
    assert.equal(walker.y, startY, 'bridgeHold must not advance position during walk-out');
    assert.equal(walker.walkFrame, heldFrame, 'bridgeHold must not cycle walk frames during walk-out');
    assert.equal(walker._strideDistance, heldStride, 'bridgeHold must not advance walk stride during walk-out');

    // 3. _isFinalStopClearOfStationary rejects intermediate strides stepping deeper into a body box,
    // rejects moving/held blockers, and checks all same-plane stationary neighbors.
    const stationaryA = { id: 'stat-a', x: 0, y: 0, planted: true, surfaceTier: 0, supportH: 0, sprite: { moving: false } };
    const stationaryB = { id: 'stat-b', x: 8, y: 8.7, planted: true, surfaceTier: 0, supportH: 0, sprite: { moving: false } };
    const heldMover = { id: 'held-m', x: 0, y: 0, planted: true, surfaceTier: 0, supportH: 0, sprite: { moving: true } };
    const inwardDesc = {
        id: 'w-in',
        x: 14.1,
        y: 1.5,
        origX: 13.2,
        origY: 2.56,
        targetX: 8,
        targetY: 8.7,
        hasStep: true,
        surfaceTier: 0,
        supportH: 0,
        sprite: { waypoints: [{ x: 8, y: 8.7 }] },
    };
    assert.equal(
        renderer._isFinalStopClearOfStationary(inwardDesc, { other: stationaryA }, [inwardDesc, stationaryA], 2),
        false,
        'must reject stride stepping inward into planted body box',
    );
    assert.equal(
        renderer._isFinalStopClearOfStationary(inwardDesc, { other: heldMover }, [inwardDesc, heldMover], 2),
        false,
        'must reject moving/held blocker as stationary',
    );
    const clearStepDesc = {
        ...inwardDesc,
        x: 10,
        y: 8.7,
        origX: 9,
        origY: 8.7,
    };
    assert.equal(
        renderer._isFinalStopClearOfStationary(clearStepDesc, { other: stationaryA }, [clearStepDesc, stationaryA, stationaryB], 3),
        false,
        'must reject final stop overlapping a second same-plane stationary neighbor',
    );
});
