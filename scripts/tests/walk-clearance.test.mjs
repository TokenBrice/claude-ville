import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { inVillageMasonry, VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../claudeville/src/config/townPlan.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { getCoastField } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { GATE_ENTRY_LANES, IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { bridgeLaneOffsetFor, bridgeLaneShift } from '../../claudeville/src/presentation/character-mode/MovementSteering.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { standsOnFixture } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';
import {
    COAST_CLEARANCE_SD,
    createWalkClearance,
    FOOTPRINT_CLEARANCE_PAD,
} from '../../claudeville/src/presentation/character-mode/WalkClearance.js';

function buildWorldFixture() {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
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
    const clearance = createWalkClearance({
        buildings,
        bridgeTiles,
        pathfinder,
        getCoastField: () => coastField,
    });
    return { buildings, scenery, pathfinder, bridgeTiles, coastField, clearance };
}

test('continuous clearance rejects sub-tile footprint, walkExclusion and shore intrusions while preserving open floors and bridges', () => {
    const { buildings, pathfinder, bridgeTiles, coastField, clearance } = buildWorldFixture();

    assert.equal(FOOTPRINT_CLEARANCE_PAD, 0.25);
    assert.equal(COAST_CLEARANCE_SD, -0.15);

    // Command front steps (15.25, 18.75) rounded to walkable (15, 19) before; now rejected.
    assert.equal(pathfinder.isWalkable(15, 19), true);
    assert.equal(clearance.isTileClear(15, 19), true, 'Command front work slot (15,19) stays clear');
    assert.equal(clearance.isTileClear(15.25, 18.75), false, 'fan intrusion onto Command steps (15.25,18.75) is rejected');

    // SE walls & corners are blocked in the grid and continuously padded.
    assert.equal(pathfinder.isWalkable(6, 30), false, 'Portal SE dais (6,30) is excluded');
    assert.equal(pathfinder.isWalkable(6, 32), false, 'Portal SE dais (6,32) is excluded');
    assert.equal(clearance.isTileClear(7, 30), true, 'moved Portal slot (7,30) is clear');
    assert.equal(clearance.isTileClear(6.75, 30), false, 'sub-tile intrusion toward Portal dais (6.75,30) is rejected');
    assert.equal(pathfinder.isWalkable(15, 34), false, 'Mine SE corner (15,34) is excluded');
    assert.equal(pathfinder.isWalkable(18, 18), false, 'Command SE corner (18,18) is excluded');
    assert.equal(pathfinder.isWalkable(12, 16), false, 'Command west spire overhang (12,16) is excluded');
    assert.equal(clearance.isTileClear(12, 16.5), false, 'fan behind Command west spire (12,16.5) is rejected');
    assert.equal(clearance.isTileClear(12, 17), true, 'Command west scenic slot (12,17) stays clear');
    assert.equal(pathfinder.isWalkable(30, 29), false, 'Forge SE corner (30,29) is excluded');

    // Tavern openFloor (bar stools and veranda) remains walkable; solid bar wall and east room reject intrusions.
    assert.equal(clearance.isTileClear(22, 16), true, 'Tavern bar stool (22,16) stays clear');
    assert.equal(clearance.isTileClear(23, 17.8), true, 'Tavern veranda threshold (23,17.8) stays clear');
    assert.equal(clearance.isTileClear(22, 15.75), false, 'Tavern bar counter wall (22,15.75) is rejected');
    assert.equal(clearance.isTileClear(23.25, 16.5), false, 'Tavern solid east room wall (23.25,16.5) is rejected');

    // Harbor stone quay work slots stay clear while Harbor's solid wall blocks intrusion.
    assert.equal(clearance.isTileClear(29, 20), true, 'Harbor quay work slot (29,20) stays clear');
    assert.equal(clearance.isTileClear(30, 20), true, 'Harbor quay work slot (30,20) stays clear');
    assert.equal(clearance.isTileClear(29, 19.85), false, 'Harbor wall intrusion (29,19.85) is rejected');

    // Shoreline curve (coast signed distance > -0.15) rejected off bridges, allowed on walkable bridges.
    assert.ok(coastField.signedDistance(30.25, 29.75) > COAST_CLEARANCE_SD);
    assert.equal(clearance.isTileClear(30.25, 29.75), false, 'Forge SE riverbank water edge is rejected');
    assert.equal(clearance.isTileClear(18, 24), true, 'Central bridge deck (18,24) stays walkable over water');
    assert.equal(clearance.isTileClear(17, 24), false, 'Non-walkable central bridge side span (17,24) stays blocked');

    // AgentSprite._isScreenPointWalkable delegates to the shared continuous clearance check.
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.world = { buildings };
    renderer.pathfinder = pathfinder;
    renderer.bridgeTiles = bridgeTiles;
    renderer._coastField = coastField;
    const sprite = new AgentSprite(
        { id: 'probe', name: 'Probe', status: 'working', provider: 'claude', position: { tileX: 15, tileY: 19 } },
        {
            pathfinder,
            bridgeTiles,
            isPointWalkable: (x, y) => renderer._isWorldPointWalkable(x, y),
            deferInitialTarget: true,
        },
    );
    const stepPos = tileToWorld(15.25, 18.75);
    const clearPos = tileToWorld(15, 19);
    assert.equal(renderer._isSpritePositionWalkable(sprite, stepPos.x, stepPos.y), false);
    assert.equal(sprite._isScreenPointWalkable(stepPos.x, stepPos.y), false);
    assert.equal(renderer._isSpritePositionWalkable(sprite, clearPos.x, clearPos.y), true);
    assert.equal(sprite._isScreenPointWalkable(clearPos.x, clearPos.y), true);
});

test('gate entry lanes center on arch axis 19.0, clear tightened masonry reach, and exit clear of the lantern', () => {
    const G = VILLAGE_GATE_GEOMETRY;
    const axis = VILLAGE_GATE.tileX;
    assert.equal(axis, 19.0);
    assert.equal(GATE_ENTRY_LANES.length, 2);
    const meanX = (GATE_ENTRY_LANES[0].tileX + GATE_ENTRY_LANES[1].tileX) / 2;
    assert.ok(Math.abs(meanX - axis) < 1e-6, `gate lanes center on ${axis}, got ${meanX}`);
    for (const lane of GATE_ENTRY_LANES) {
        assert.equal(Math.round(lane.tileX), 19, 'lane rounds onto walkable column 19');
        assert.equal(inVillageMasonry(lane.tileX, VILLAGE_GATE.tileY, 0.3), false, 'lane clears tightened arch opening');
        const exit = tileToWorld(lane.tileX, lane.insideY);
        assert.equal(standsOnFixture(exit.x, exit.y), false, 'lane exit clears (18,37) lantern fixture');
    }
    // Jamb grazing (old east lane 19.55, offset 0.55 > archHalfWidth - reach = 0.42) is now rejected.
    assert.equal(inVillageMasonry(axis + G.archHalfWidth - 0.15, VILLAGE_GATE.tileY, 0.3), true, 'within body reach of jamb is masonry');
    assert.equal(inVillageMasonry(19.55, VILLAGE_GATE.tileY, 0.3), true, 'old east lane 19.55 is rejected as jamb masonry');

    // Straight-walk gate channel arrivals are exempt from lateral steering/arrival fanning until clear of the arch.
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.gateTransits = new Map([
        ['gate-entrant', { type: 'arrival', gate: true, since: 1 }],
        ['portal-arrival', { type: 'arrival', since: 1 }],
        ['departing', { type: 'departure', since: 1 }],
    ]);
    assert.equal(renderer._isGateChannelTransit({ agent: { id: 'gate-entrant' } }), true);
    assert.equal(renderer._isGateChannelTransit({ agent: { id: 'portal-arrival' } }), false);
    assert.equal(renderer._isGateChannelTransit({ agent: { id: 'departing' } }), true);
});

test('PERFORMING_FAN skips wall/water offsets and falls back to clear neighbours', () => {
    const { buildings, pathfinder, bridgeTiles, coastField } = buildWorldFixture();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.world = { buildings };
    renderer.pathfinder = pathfinder;
    renderer.bridgeTiles = bridgeTiles;
    renderer._coastField = coastField;

    const sprite = { _screenToTile: (x, y) => ({ tileX: (x / 32 + y / 16) / 2, tileY: (y / 16 - x / 32) / 2 }) };
    // Anchor at Command (15, 19): north/east offsets land on Command steps (15.25, 18.75) and must be skipped.
    const anchor = tileToWorld(15, 19);
    const taken = [{ x: anchor.x, y: anchor.y }];
    for (let i = 0; i < 6; i++) {
        const place = renderer._freeFanPlace(sprite, anchor, 1, taken, `command|${i}`);
        assert.ok(place, `fan place ${i} resolves to a clear neighbour`);
        assert.equal(renderer._isSpriteStandable(sprite, place.x, place.y), true, `fan place ${i} is continuously standable`);
        taken.push(place);
    }
});

test('inVillageMasonry and WalkClearance.isWorldClear run allocation-free on the hot path', async () => {
    const { clearance } = buildWorldFixture();

    // Behavioral parity inside the masonry band: wall, drums, sea tower, arch opening, and clear verge.
    assert.equal(inVillageMasonry(19.0, 39.1, 0.3), false, 'arch centre is clear');
    assert.equal(inVillageMasonry(19.0 + VILLAGE_GATE_GEOMETRY.towerX[0], 39.1, 0.3), true, 'west gate drum is masonry');
    assert.equal(inVillageMasonry(19.0 + VILLAGE_GATE_GEOMETRY.towerX[1], 39.1, 0.3), true, 'east gate drum is masonry');
    assert.equal(inVillageMasonry(34.35, 39.1, 0.3), true, 'sea tower drum is masonry');
    assert.equal(inVillageMasonry(10.0, 39.1, 0.3), true, 'west curtain wall is masonry');
    assert.equal(inVillageMasonry(10.0, 38.6, 0.3), false, 'clear point inside masonry Y-band passes full loop');

    const mid = tileToWorld(15, 19);
    const runMasonryFullLoop = (n) => {
        let hits = 0;
        for (let i = 0; i < n; i++) {
            if (inVillageMasonry(10.0, 38.6, 0.3)) hits++;
        }
        return hits;
    };
    const runWorldClear = (n) => {
        let ok = 0;
        for (let i = 0; i < n; i++) {
            if (clearance.isWorldClear(mid.x, mid.y)) ok++;
        }
        return ok;
    };

    // Warm JIT before observing GC.
    assert.equal(runMasonryFullLoop(250000), 0);
    assert.equal(runWorldClear(250000), 250000);
    await new Promise((resolve) => setTimeout(resolve, 30));

    let gcEvents = 0;
    const obs = new PerformanceObserver((list) => { gcEvents += list.getEntries().length; });
    obs.observe({ entryTypes: ['gc'] });
    const heapBefore = process.memoryUsage().heapUsed;
    try {
        assert.equal(runMasonryFullLoop(1000000), 0);
        assert.equal(runWorldClear(1000000), 1000000);
    } finally {
        const heapAfter = process.memoryUsage().heapUsed;
        await new Promise((resolve) => setTimeout(resolve, 20));
        obs.disconnect();
        assert.ok(heapAfter - heapBefore < 2 * 1024 * 1024, `expected near-zero heap growth across 2M checks, got ${heapAfter - heapBefore} B`);
    }
    assert.equal(gcEvents, 0, `expected 0 GC events across 2M hot clearance checks, observed ${gcEvents}`);
});

test('gate entry lanes release two abreast and sustain base 30-arrival throughput', () => {
    const { pathfinder, bridgeTiles } = buildWorldFixture();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map();
    renderer.gateTransits = new Map();
    renderer._gateEntryQueue = [];
    renderer.motionScale = 1;
    renderer._markSpritesDirty = () => {};

    const sprites = [];
    for (let i = 0; i < 30; i++) {
        const agent = new Agent({
            id: `gate-burst-${i}`,
            name: `Burst ${i}`,
            provider: 'claude',
            model: 'claude-sonnet-4-5',
            status: 'working',
        });
        const sprite = new AgentSprite(agent, { pathfinder, bridgeTiles, deferInitialTarget: true });
        renderer.agentSprites.set(agent.id, sprite);
        sprites.push(sprite);
        renderer._walkInThroughGate(agent, sprite);
    }

    const activeFrame0 = sprites.filter((s) => !s.isArrivalPending());
    assert.equal(activeFrame0.length, 2, 'both gate lanes release abreast on frame 0');
    assert.notEqual(
        renderer.gateTransits.get(activeFrame0[0].agent.id)?.lane,
        renderer.gateTransits.get(activeFrame0[1].agent.id)?.lane,
        'the two initial entrants occupy distinct gate lanes',
    );

    let queueEmptyFrame = -1;
    let frames = 0;
    while (frames < 800) {
        if (queueEmptyFrame < 0 && renderer._gateEntryQueue.length === 0) queueEmptyFrame = frames;
        if (renderer._gateEntryQueue.length === 0 && renderer.gateTransits.size === 0) break;
        frames++;
        for (const sprite of sprites) {
            sprite.update(null, 1000 / 60);
            const transit = renderer.gateTransits.get(sprite.agent.id);
            if (transit && !sprite.moving && sprite.hasReachedTarget()) {
                renderer.gateTransits.delete(sprite.agent.id);
            }
        }
        renderer._releaseGateEntries();
    }

    assert.equal(renderer._gateEntryQueue.length, 0);
    assert.equal(renderer.gateTransits.size, 0);
    assert.ok(queueEmptyFrame > 0 && queueEmptyFrame <= 360, `30 arrivals should clear the queue near base 337 frames, got ${queueEmptyFrame}`);
});

test('_subagentLandingTile respects continuous WalkClearance pads and avoids building/shore edges', () => {
    const { buildings, pathfinder, bridgeTiles, coastField, clearance } = buildWorldFixture();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.world = { buildings };
    renderer.pathfinder = pathfinder;
    renderer.bridgeTiles = bridgeTiles;
    renderer._coastField = coastField;
    renderer.agentSprites = new Map();

    // Occupy every visit tile so _subagentLandingTile must pick ring landings.
    const reservations = new Map();
    let idx = 0;
    for (const b of buildings.values()) {
        for (const t of b.visitTiles || []) {
            reservations.set(`res-${idx}`, { agentId: `res-${idx}`, tileX: t.tileX, tileY: t.tileY });
            idx++;
        }
    }
    renderer.visitTileAllocator = { reservations };

    let tested = 0;
    for (const b of buildings.values()) {
        for (const vt of b.visitTiles || []) {
            const parentPos = tileToWorld(vt.tileX, vt.tileY);
            const parentSprite = {
                agent: { id: 'parent' },
                x: parentPos.x,
                y: parentPos.y,
                _screenToTile: () => ({ tileX: vt.tileX, tileY: vt.tileY }),
                getBehaviorDebugSnapshot: () => ({ building: b.type }),
            };
            const landing = renderer._subagentLandingTile({ id: `child-${tested}` }, parentSprite);
            if (!landing) continue;
            tested++;
            assert.equal(
                clearance.isTileClear(landing.tileX, landing.tileY),
                true,
                `ring landing (${landing.tileX.toFixed(2)},${landing.tileY.toFixed(2)}) near ${b.type} must pass continuous WalkClearance`,
            );
        }
    }
    assert.ok(tested >= 30, `verified ${tested} ring landings`);
});

test('Watchtower entrance grounds on its visible tile and frontage skips water columns', () => {
    const { buildings, scenery, bridgeTiles } = buildWorldFixture();
    const watchtower = buildings.get('watchtower');
    const activity = new LandmarkActivity({ world: { buildings } });
    const ground = activity._entranceGround('watchtower');
    const expected = tileToWorld(watchtower.entrance.tileX + 0.5, watchtower.entrance.tileY + 0.5);
    assert.deepEqual(ground, expected, 'Watchtower activity chips ground at the moved entrance tile centre');

    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.world = { buildings };
    renderer.waterTiles = scenery.getWaterTiles();
    renderer.bridgeTiles = bridgeTiles;
    const keys = renderer._buildingFrontageKeys(watchtower);
    assert.equal(keys.includes('26,8'), false, 'water tile (26,8) excluded from Watchtower frontage');
    assert.equal(keys.includes('26,9'), false, 'water tile (26,9) excluded from Watchtower frontage');
    assert.equal(keys.includes('26,13'), true, 'dry entrance corner (26,13) stays in Watchtower frontage');
});

test('bridge ramp corridors stay continuously clear across stair seams and lane offsets while preserving shore and side-span rejections', () => {
    const { bridgeTiles, coastField, clearance } = buildWorldFixture();

    assert.ok(clearance.bridgeRampBoxes instanceof Float32Array, 'bridgeRampBoxes is exposed as a Float32Array');
    assert.ok(clearance.bridgeRampBoxes.length >= 16 && clearance.bridgeRampBoxes.length % 4 === 0);

    // Bridge tile metadata propagates landingLaneOffsetPx and circulationMode.
    const central = bridgeTiles.get('18,24');
    const trestle = bridgeTiles.get('7,25');
    const pondPlank = bridgeTiles.get('17,22');
    assert.equal(central?.laneOffsetPx, 8);
    assert.equal(central?.landingLaneOffsetPx, 4);
    assert.equal(central?.circulationMode, 'two-way');
    assert.equal(trestle?.laneOffsetPx, 6);
    assert.equal(trestle?.landingLaneOffsetPx, 0);
    assert.equal(trestle?.circulationMode, 'platoon');
    assert.equal(pondPlank?.landingLaneOffsetPx, null);
    assert.equal(pondPlank?.circulationMode, 'platoon');

    // MovementSteering landing lane offset helper & bridgeLaneShift landing option.
    assert.equal(bridgeLaneOffsetFor(central, false), 8);
    assert.equal(bridgeLaneOffsetFor(central, true), 4);
    assert.equal(bridgeLaneOffsetFor(trestle, true), 0);
    assert.equal(bridgeLaneOffsetFor(pondPlank, true), 0);
    const along = tileToWorld(0, 1);
    const centralLandingShift = bridgeLaneShift(central, along.x, along.y, { landing: true });
    assert.ok(centralLandingShift && Math.abs(Math.hypot(centralLandingShift.x, centralLandingShift.y) - 4) < 1e-9);
    assert.equal(bridgeLaneShift(trestle, along.x, along.y, { landing: true }), null);
    assert.equal(bridgeLaneShift(pondPlank, along.x, along.y, { landing: true }), null);

    // Central bridge (x = 18): continuous clearance at every 0.05-tile step from 21.5 to 26.8,
    // including stair seams y in [22.35, 22.49] and [25.51, 25.59] where coastSD > -0.15.
    for (let step = 0; step <= 106; step++) {
        const y = Number((21.5 + step * 0.05).toFixed(2));
        assert.equal(
            clearance.isTileClear(18, y),
            true,
            `central bridge sample (18, ${y.toFixed(2)}) must stay clear (coastSD=${coastField.signedDistance(18, y).toFixed(3)})`,
        );
    }
    for (const seamY of [22.35, 22.40, 22.45, 22.49, 25.51, 25.55, 25.59]) {
        assert.equal(clearance.isTileClear(18, seamY), true, `central bridge seam (18, ${seamY}) must stay clear`);
        const w = tileToWorld(18, seamY);
        assert.equal(clearance.isWorldClear(w.x, w.y), true, `central bridge seam world point (18, ${seamY}) must stay clear`);
    }

    // West river plank / trestle (x = 7): continuous clearance at every 0.05-tile step from 22.0 to 27.0,
    // including seams around y = 22.45 and y in [26.51, 26.65].
    for (let step = 0; step <= 100; step++) {
        const y = Number((22.0 + step * 0.05).toFixed(2));
        assert.equal(
            clearance.isTileClear(7, y),
            true,
            `west-river-plank sample (7, ${y.toFixed(2)}) must stay clear (coastSD=${coastField.signedDistance(7, y).toFixed(3)})`,
        );
    }
    for (const seamY of [22.45, 26.51, 26.55, 26.60, 26.65]) {
        assert.equal(clearance.isTileClear(7, seamY), true, `west-river-plank seam (7, ${seamY}) must stay clear`);
    }

    // Opposing lane files on central bridge: ±8 px on deck y = 23..25 and ±4 px on landings y = 22, 26.
    for (const [y, landing] of [[22, true], [23, false], [24, false], [25, false], [26, true]]) {
        const base = tileToWorld(18, y);
        for (const sign of [-1, 1]) {
            const shift = bridgeLaneShift(central, sign * along.x, sign * along.y, landing ? { landing: true } : null);
            assert.ok(shift, `expected non-null shift for central bridge y=${y} sign=${sign}`);
            const wx = base.x + shift.x;
            const wy = base.y + shift.y;
            const tile = worldToTile(wx, wy);
            assert.equal(
                clearance.isWorldClear(wx, wy),
                true,
                `central bridge lane world point y=${y} sign=${sign} (${tile.tileX.toFixed(3)}, ${tile.tileY.toFixed(3)}) must stay clear`,
            );
            assert.equal(
                clearance.isTileClear(tile.tileX, tile.tileY),
                true,
                `central bridge lane tile (${tile.tileX.toFixed(3)}, ${tile.tileY.toFixed(3)}) must stay clear`,
            );
        }
    }

    // Non-bridge shoreline edges, non-walkable bridge side spans, dock water
    // edges, and bridge corner water past ±0.35 tile remain rejected.
    assert.ok(coastField.signedDistance(30.25, 29.75) > COAST_CLEARANCE_SD);
    assert.equal(clearance.isTileClear(30.25, 29.75), false, 'non-bridge shore edge (30.25, 29.75) remains rejected');
    assert.equal(clearance.isTileClear(17, 24), false, 'west bridge side span (17, 24) remains rejected');
    assert.equal(clearance.isTileClear(19, 24), false, 'east bridge side span (19, 24) remains rejected');
    assert.equal(clearance.isTileClear(28.48, 20.48), false, 'dock base open water (28.48, 20.48) must stay rejected');
    assert.equal(clearance.isTileClear(28.45, 20.45), false, 'dock base water edge (28.45, 20.45) must stay rejected');
    assert.equal(clearance.isTileClear(17.5, 22.45), false, 'central bridge NW corner water (17.5, 22.45) must stay rejected');
    assert.equal(clearance.isTileClear(18.5, 22.45), false, 'central bridge NE adjacent-tile edge (18.5, 22.45) must stay rejected');
    assert.equal(clearance.isTileClear(15.45, 22.45), false, 'pond plank SW corner water (15.45, 22.45) must stay rejected');
    assert.equal(clearance.isTileClear(6.55, 26.55), false, 'west-river-plank SW corner shore (6.55, 26.55) must stay rejected');
});
