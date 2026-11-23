import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { inVillageMasonry, VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../claudeville/src/config/townPlan.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { getCoastField } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { GATE_ENTRY_LANES, IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
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
