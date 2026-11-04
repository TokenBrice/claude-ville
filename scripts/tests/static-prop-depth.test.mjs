import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { BRIDGE_HINTS } from '../../claudeville/src/config/scenery.js';
import { VILLAGE_GATE, VILLAGE_GATE_BOUNDS } from '../../claudeville/src/config/townPlan.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { appendDepthSortedDrawables } from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import {
    StaticPropSprite,
    buildStaticPropDrawables,
    lineOcclusionColumns,
} from '../../claudeville/src/presentation/character-mode/StaticPropDrawables.js';

const TREE_BOUNDS = Object.freeze({ left: -32, right: 32, top: -51, bottom: 1, splitY: -21 });

function tree(tileX, tileY) {
    return new StaticPropSprite({ tileX, tileY, id: 'fantasy.tree', bounds: TREE_BOUNDS, splitForOcclusion: true, drawFn() {} });
}

function villageGate() {
    const origin = tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
    return new StaticPropSprite({
        tileX: VILLAGE_GATE.tileX,
        tileY: VILLAGE_GATE.tileY,
        id: VILLAGE_GATE.id,
        bounds: VILLAGE_GATE_BOUNDS,
        occlusionColumns: lineOcclusionColumns({
            left: VILLAGE_GATE_BOUNDS.left,
            right: VILLAGE_GATE_BOUNDS.right,
            width: 16,
            originY: origin.y,
            slope: TILE_HEIGHT / TILE_WIDTH,
        }),
        drawFn() {},
    });
}

function paintOrder(...sprites) {
    const order = [];
    appendDepthSortedDrawables(order, { propDrawables: buildStaticPropDrawables(sprites) });
    return order;
}

function columnUnder(order, gate, sprite) {
    const localX = sprite.x - gate.x;
    return order.findIndex(({ payload }) => payload.sprite === gate
        && payload.column.left <= localX && localX < payload.column.right);
}

function partIndex(order, sprite, part) {
    return order.findIndex(({ payload }) => payload.sprite === sprite && payload.part === part);
}

test('a prop without an explicit sortY paints at its footprint depth', () => {
    const north = tree(10, 10);
    const south = tree(10, 20);
    const order = paintOrder(south, north);
    assert.ok(partIndex(order, north, 'front') < partIndex(order, south, 'back'),
        'a tree ten rows further north must finish painting before the southern tree starts');
});

test('trees behind the village gate paint under it along its whole length', () => {
    const gate = villageGate();
    // One behind each part of the gate: west stub, centre arch, east tower,
    // and the east stub where one sortY for the whole gate used to fail.
    for (const [tileX, tileY] of [[16.55, 38.42], [18.5, 37.5], [22.27, 38.72], [23.5, 38.5]]) {
        const behind = tree(tileX, tileY);
        const order = paintOrder(gate, behind);
        const column = columnUnder(order, gate, behind);
        assert.ok(column >= 0, `no gate column under ${tileX},${tileY}`);
        assert.ok(partIndex(order, behind, 'front') < column,
            `tree at ${tileX},${tileY} (north of the wall) must paint before the gate column over it`);
    }
});

test('props standing in front of the village gate paint over it', () => {
    const gate = villageGate();
    // The arrival point outside the gate mouth, and a spot on the east apron.
    for (const { tileX, tileY } of [VILLAGE_GATE.outside, { tileX: 22.01, tileY: 39.88 }]) {
        const inFront = new StaticPropSprite({ tileX, tileY, drawFn() {} });
        const order = paintOrder(gate, inFront);
        const column = columnUnder(order, gate, inFront);
        assert.ok(column >= 0, `no gate column under ${tileX},${tileY}`);
        assert.ok(partIndex(order, inFront, 'whole') > column,
            `prop at ${tileX},${tileY} (south of the wall) must paint after the gate column under it`);
    }
});

// The east curtain run and the sea tower its coastal end stands in, as the
// renderer builds them (the tower's dims and anchor as manifest.yaml
// declares them). `waterAt` picks how far back from the run's end the tower
// stands (_villageWallSeaTowerTile).
function eastRunAndSeaTower(waterAt) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.waterTiles = { has: waterAt };
    renderer.assets = {
        has: (id) => id === 'prop.villageWallSeaTower',
        getDims: () => ({ w: 94, h: 226 }),
        getAnchor: () => [47, 201],
    };
    const run = renderer._buildVillageWallSprites().find((sprite) => sprite.id === 'village.wall.east.0');
    const [tower] = renderer._buildVillageWallTerminalSprites();
    return { renderer, run, tower };
}

test('the sea tower paints after the east run that ends in its drum, at every zoom and with a villager near', () => {
    for (const waterAt of [() => true, () => false]) {
        const { renderer, run, tower } = eastRunAndSeaTower(waterAt);
        // Below FAST_PROP_MIN_ZOOM every prop goes through the static drawables.
        const slow = buildStaticPropDrawables([run, tower]);
        // At and above it, with a villager standing just behind the drum.
        renderer._staticPropSprites = [run, tower];
        renderer._staticPropFastDrawables = renderer._buildStaticPropFastDrawables();
        renderer._staticPropFastFrameDrawables = [];
        renderer._screenViewport = () => null;
        renderer._isGateTransit = () => false;
        renderer._snapshotSortedSprites = () => [{ x: tower.x + 20, y: tower.y - 14 }];
        const fast = renderer._enumerateFastPropDrawables();
        for (const [path, drawables] of [['slow', slow], ['fast', fast]]) {
            const order = [];
            appendDepthSortedDrawables(order, { propDrawables: drawables });
            const runAt = order.findIndex(({ payload }) => payload.sprite === run);
            const towerAt = order.map(({ payload }, index) => (payload.sprite === tower ? index : -1)).filter((index) => index >= 0);
            assert.ok(runAt >= 0 && towerAt.length > 0, `${path} path: run and tower both draw`);
            assert.ok(towerAt.every((index) => index > runAt), `${path} path: a part of the sea tower paints before the run, so the run's parapet covers its drum`);
        }
    }
});

// The central bridge's near-rail slices, built as the renderer builds them:
// the real bridge tiles (SceneryEngine on the renderer's own noise and the
// real buildings), then its spans and slices.
function centralBridge(bridgeId = 'central-river-bridge') {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
    const scenery = new SceneryEngine({
        world: { buildings: new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)])) },
        terrainSeed,
        tileNoise: (x, y) => noise._tileNoise(x, y),
        smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.bridgeTiles = scenery.bridgeTiles;
    renderer.assets = {};
    renderer.bridgeSpans = renderer._buildBridgeSpans();
    const span = renderer.bridgeSpans.find((entry) => entry.id === bridgeId);
    const rails = renderer._buildBridgeNearRailSprites().filter((sprite) => sprite.id.startsWith(`bridge.rail.${bridgeId}.`));
    // Each slice's painted region: the clip quad its drawFn cuts.
    const count = rails.length;
    rails.forEach((rail, index) => { rail.quad = renderer._bridgeNearRailQuad(span, index / count, (index + 1) / count); });
    return { renderer, rails };
}

// The deck's walk column x=18, nominal rows along it, at the hint's lane
// offset either side (laneOffsetPx, + the far file); the landings at most an
// avenue's 4.4 px. A body stands at tile (18, row) moved `lanePx` along the
// lane perp, as lane discipline moves it.
const LANE_PX = BRIDGE_HINTS.find((hint) => hint.id === 'central-river-bridge').laneOffsetPx;

function samplesAlong(from, to, lanes) {
    const samples = [];
    for (let step = 0; from + step / 20 <= to + 1e-9; step++) {
        for (const lanePx of lanes) samples.push({ tileY: from + step / 20, lanePx });
    }
    return samples;
}

// A body at a tile, `lanePx` across the walk, lifted as AgentSprite lifts it.
function body(renderer, tileX, tileY, lanePx = 0) {
    const world = tileToWorld(tileX, tileY);
    const x = world.x - 0.4472136 * lanePx;
    const y = world.y - 0.8944272 * lanePx;
    const tile = worldToTile(x, y);
    const lift = Math.max(0, renderer.getBridgeLift(tile.tileX, tile.tileY));
    return { x, y, tile, lift, _currentBridgeLift: () => lift };
}

function bodySortY(rails, sprite) {
    const target = [];
    appendDepthSortedDrawables(target, { propDrawables: buildStaticPropDrawables(rails), agentSprites: [sprite] });
    return target.find((drawable) => drawable.kind === 'agent').sortY;
}

function insideQuad(quad, x, y) {
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
        if ((quad[i].y > y) !== (quad[j].y > y)
            && x < (quad[j].x - quad[i].x) * (y - quad[i].y) / (quad[j].y - quad[i].y) + quad[i].x) inside = !inside;
    }
    return inside;
}

// The slices whose painted quad crosses the body's drawn box (AgentSprite's
// default body box, -17..17 x -58..3 around its lifted feet), sampled every
// texel, each with the highest row it covers over the figure itself (the
// middle 16 columns; hats and staffs fill the rest of the box), in px above
// the feet (-Infinity when it only crosses the box's sides).
function railsOver(rails, sprite) {
    const footY = sprite.y - sprite.lift;
    const out = [];
    for (const rail of rails) {
        let hit = false;
        let reach = -Infinity;
        for (let y = footY - 58; y <= footY + 3; y++) {
            for (let x = sprite.x - 17; x <= sprite.x + 17; x++) {
                if (!insideQuad(rail.quad, x, y)) continue;
                hit = true;
                if (Math.abs(x - sprite.x) <= 8) reach = Math.max(reach, footY - y);
            }
        }
        if (hit) out.push({ rail, reach });
    }
    return out;
}

// The deck's north stair top (deckProfile's second point, along the axis
// from the hint tile); its south end is the walk's over-rail depth (minY).
const DECK_FROM = 24 + BRIDGE_HINTS.find((hint) => hint.id === 'central-river-bridge').deckProfile[1][0];

// The lower box: the legs, the bottom 20 of the box's 61 rows (feet + 3 up).
const LEGS_PX = 17;

test('bridge-deck: the central deck lifts the feet onto the planks, ramps over both stairs and never drops', () => {
    const { renderer } = centralBridge();
    // The plateau: the painted deck stands about 25 px over the water.
    for (const tileY of [23, 23.5, 24, 24.5, 25, 25.5]) {
        for (const lanePx of [-LANE_PX, 0, LANE_PX]) {
            const { lift } = body(renderer, 18, tileY, lanePx);
            assert.ok(lift >= 22 && lift <= 25, `18,${tileY} lane ${lanePx}: lift ${lift.toFixed(1)} is on the plateau`);
        }
    }
    // Walking the column from the plaza to the south bank, the lift moves by
    // at most 5 px per 1/20 tile on every file (the steep north steps are 23
    // px over a quarter tile): stairs at both ends, never a drop.
    for (const lanePx of [-LANE_PX, 0, LANE_PX]) {
        let last = 0;
        for (const { tileY } of samplesAlong(21.2, 27.4, [0])) {
            const { lift } = body(renderer, 18, tileY, lanePx);
            assert.ok(Math.abs(lift - last) <= 5, `lane ${lanePx}: lift jumps ${last.toFixed(1)} -> ${lift.toFixed(1)} at 18,${tileY.toFixed(2)}`);
            last = lift;
        }
        assert.equal(last, 0, 'off the south stairs the body is back on the ground');
    }
    assert.equal(body(renderer, 18, 21.5).lift, 0, 'past the north steps the plaza is ground');
    // Turning off the stairs onto the bank fades the lift: no drop at the side.
    for (const tileY of [22.1, 26.2]) {
        let last = body(renderer, 18, tileY).lift;
        for (let tileX = 18; tileX >= 16.9; tileX -= 0.05) {
            const { lift } = body(renderer, tileX, tileY);
            assert.ok(Math.abs(lift - last) <= 5, `turning west at row ${tileY}: lift jumps ${last.toFixed(1)} -> ${lift.toFixed(1)} at x ${tileX.toFixed(2)}`);
            last = lift;
        }
        assert.equal(last, 0, `the bank west of row ${tileY} is ground`);
    }
    // Off the walk (the water beside the deck, the pause points) is ground.
    for (const [tileX, tileY] of [[19, 22], [17, 22], [19, 24], [17, 24], [17, 26], [19, 26]]) {
        assert.equal(body(renderer, tileX, tileY).lift, 0, `${tileX},${tileY} is not lifted`);
    }
});

test('bridge-deck: on the deck both files sort behind the rail, which crosses the near file\'s legs and never a far-file body', () => {
    const { renderer, rails } = centralBridge();
    assert.equal(rails.length, 6, 'the 3-tile span keeps six near-rail slices');
    let nearCrossed = 0;
    for (const { tileY, lanePx } of samplesAlong(22, 26, [-LANE_PX, 0, LANE_PX])) {
        const sprite = body(renderer, 18, tileY, lanePx);
        // The deck: past the north stair top (the lane moves a body along
        // the axis) and short of the over-rail depth at the south one.
        if (sprite.tile.tileY < DECK_FROM || sprite.y >= rails[0].bridgeWalk.minY) continue;
        const sortY = bodySortY(rails, sprite);
        assert.equal(sortY, sprite.y, `body at 18,${tileY.toFixed(2)} lane ${lanePx} keeps its ground Y on the deck`);
        for (const { rail, reach } of railsOver(rails, sprite)) {
            assert.ok(sortY < rail.sortY, `body at 18,${tileY.toFixed(2)} lane ${lanePx}: sorts at ${sortY.toFixed(2)}, after ${rail.id} (${rail.sortY.toFixed(2)})`);
            assert.ok(reach <= LEGS_PX, `body at 18,${tileY.toFixed(2)} lane ${lanePx}: ${rail.id} reaches ${reach.toFixed(0)} px up its box, above the legs`);
            if (lanePx > 0) assert.ok(reach <= 1, `far-file body at 18,${tileY.toFixed(2)}: ${rail.id} reaches ${reach.toFixed(0)} px above its feet`);
            if (lanePx < 0 && reach > 0) nearCrossed++;
        }
    }
    assert.ok(nearCrossed > 20, `the rail crosses the near file's legs along the deck (${nearCrossed} samples)`);
});

test('bridge-deck: on the south stairs and landing a body keeps the over-rail rule and the rail never cuts it', () => {
    const { renderer, rails } = centralBridge();
    const last = Math.max(...rails.map((rail) => rail.sortY));
    let ruled = 0;
    for (const { tileY, lanePx } of samplesAlong(25.9, 26.6, [-LANE_PX, -4.4, 0, 4.4])) {
        const sprite = body(renderer, 18, tileY, lanePx);
        if (sprite.y < rails[0].bridgeWalk.minY) continue;
        const sortY = bodySortY(rails, sprite);
        assert.ok(sortY > last, `body at 18,${tileY.toFixed(2)} lane ${lanePx}: sorts at ${sortY.toFixed(2)}, before the last slice (${last.toFixed(2)})`);
        for (const { rail } of railsOver(rails, sprite)) assert.ok(sortY > rail.sortY, `${rail.id} paints over the body at 18,${tileY.toFixed(2)}`);
        ruled++;
    }
    assert.ok(ruled > 20, 'the stairs and the landing are sampled');
});

test('bridge-deck: on the north steps and landing a body keeps its ground Y, behind the rail\'s north end', () => {
    const { renderer, rails } = centralBridge();
    for (const { tileY, lanePx } of samplesAlong(21.5, 22.25, [-4.4, 0, 4.4])) {
        const sprite = body(renderer, 18, tileY, lanePx);
        assert.equal(bodySortY(rails, sprite), sprite.y, `18,${tileY.toFixed(2)} lane ${lanePx} keeps its ground Y`);
    }
});

test('bridge-deck: off the walk a body keeps its ground Y, so the rail still covers what stands behind it', () => {
    const { renderer, rails } = centralBridge();
    // The bridge-east pause, the pond plank, the plaza north of the landing,
    // and the water beside the deck under its near and far sides.
    for (const [tileX, tileY] of [[19, 22], [17, 22], [18, 21], [19, 24], [17, 24], [20, 24], [19, 26], [17, 26]]) {
        const sprite = body(renderer, tileX, tileY);
        assert.equal(bodySortY(rails, sprite), sprite.y, `${tileX},${tileY} keeps its ground Y`);
    }
});

test('bridge-deck: bodies on the walk that overlap keep their ground order', () => {
    const { renderer, rails } = centralBridge();
    const bodies = samplesAlong(21.5, 26.6, [-LANE_PX, -4.4, 0, 4.4, LANE_PX]).map(({ tileY, lanePx }) => {
        const sprite = body(renderer, 18, tileY, lanePx);
        return { sprite, sortY: bodySortY(rails, sprite) };
    });
    for (const a of bodies) {
        for (const b of bodies) {
            if (b.sprite.y - a.sprite.y < 1) continue;
            const ay = a.sprite.y - a.sprite.lift;
            const by = b.sprite.y - b.sprite.lift;
            if (Math.abs(a.sprite.x - b.sprite.x) >= 34 || Math.abs(ay - by) >= 61) continue;
            assert.ok(b.sortY > a.sortY, `nearer body (y ${b.sprite.y.toFixed(1)}) sorts after the farther (y ${a.sprite.y.toFixed(1)})`);
        }
    }
});

test('bridge-deck: the hint\'s span fields reach the tiles, the span, the lanes, the trees and the shadow', () => {
    const { renderer } = centralBridge();
    const hint = BRIDGE_HINTS.find((entry) => entry.id === 'central-river-bridge');
    const deck = renderer.bridgeTiles.get('18,24');
    assert.equal(deck.deckProfile, hint.deckProfile);
    assert.equal(deck.laneOffsetPx, hint.laneOffsetPx);
    assert.equal(deck.treeExclusion, true, 'treeExclusion defaults on');
    assert.equal(deck.underDeckShadow, true, 'underDeckShadow defaults on');
    assert.equal(renderer.bridgeTiles.get('17,22')?.laneOffsetPx, null, 'a plank tile carries no lane offset (Flow falls back to 10)');
    const span = renderer.bridgeSpans.find((entry) => entry.id === 'central-river-bridge');
    assert.equal(span.deckProfile, hint.deckProfile);
    assert.equal(span.laneOffsetPx, hint.laneOffsetPx);
    assert.deepEqual(span.centerTile, { x: 18, y: 24 });

    // Lane discipline: the deck's files at the hint's offset, a deck without
    // one at LANE_STEERING.bridgeOffsetPx (10).
    Object.assign(renderer, {
        pathTiles: new Set(['18,23', '18,24', '18,25']),
        mainAvenueTiles: new Set(),
        townSquareTiles: new Set(),
        _roadNeighborCount: () => 2,
        _roadMaterialForKey: () => 'avenue',
    });
    assert.equal(renderer._buildLaneTileIndex().get('18,24').laneOffset, hint.laneOffsetPx);
    renderer.bridgeTiles = new Map([...renderer.bridgeTiles].map(([key, info]) => [key, { ...info, laneOffsetPx: null }]));
    assert.equal(renderer._buildLaneTileIndex().get('18,24').laneOffset, 10);

    // Trees and the under-deck shadow follow the span's switches.
    assert.equal(renderer._isInBridgeTreeExclusion(19, 26), true, 'the central bridge keeps its tree exclusion');
    renderer.bridgeSpans = [{ ...span, treeExclusion: false }];
    assert.equal(renderer._isInBridgeTreeExclusion(19, 26), false, 'treeExclusion false keeps trees');
    let fills = 0;
    const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { fills++; } };
    renderer._drawBridgeUnderDeckWaterShadow(ctx, span);
    renderer._drawBridgeUnderDeckWaterShadow(ctx, { ...span, underDeckShadow: false });
    assert.equal(fills, 1, 'underDeckShadow false draws no shadow');
});

test('bridge-deck: a span without a measured profile keeps the sine lift and the whole-walk rail rule', () => {
    const { renderer } = centralBridge();
    const span = renderer.bridgeSpans.find((entry) => entry.id === 'central-river-bridge');
    renderer.bridgeSpans = [{ ...span, deckProfile: null }];
    assert.ok(Math.abs(renderer.getBridgeLift(18, 24) - span.deckRise) < 0.01, 'mid-span lifts the full deckRise');
    assert.equal(renderer.getBridgeLift(18, 22), 0, 'the landing is ground');
    const walk = renderer._bridgeWalk(renderer.bridgeSpans[0]);
    assert.equal(walk.minY, -Infinity);
    assert.ok(walk.from < 22 && walk.to > 26, 'both landing tiles take the rule');
});

// BR-7 — the Miner's trestle (west-river-plank), a landmark span installed by
// data alone: walk column x=7, deck rows 22.5..26.5 16 px over the water,
// half-tile ramps onto the banks (7,22) and (7,27), files at its hint's
// laneOffsetPx, the near handrail and mid-rail as the rail band.
const TRESTLE = BRIDGE_HINTS.find((hint) => hint.id === 'west-river-plank');
const TRESTLE_LANE = TRESTLE.laneOffsetPx;
const TRESTLE_FROM = 24.5 + TRESTLE.deckProfile[1][0];

test('trestle: the deck lifts the feet onto its planks, ramps onto both banks and never drops', () => {
    const { renderer } = centralBridge('west-river-plank');
    for (const tileY of [23, 23.5, 24, 24.5, 25, 25.5, 26]) {
        for (const lanePx of [-TRESTLE_LANE, 0, TRESTLE_LANE]) {
            const { lift } = body(renderer, 7, tileY, lanePx);
            assert.ok(lift >= 15 && lift <= 16, `7,${tileY} lane ${lanePx}: lift ${lift.toFixed(1)} is on the plateau`);
        }
    }
    // Walking the column from the north bank to the south bank the lift
    // moves by at most 2 px per 1/20 tile on every file: ramps, no drop.
    for (const lanePx of [-TRESTLE_LANE, 0, TRESTLE_LANE]) {
        let last = 0;
        for (const { tileY } of samplesAlong(21.2, 27.8, [0])) {
            const { lift } = body(renderer, 7, tileY, lanePx);
            assert.ok(Math.abs(lift - last) <= 2, `lane ${lanePx}: lift jumps ${last.toFixed(1)} -> ${lift.toFixed(1)} at 7,${tileY.toFixed(2)}`);
            last = lift;
        }
        assert.equal(last, 0, 'off the south ramp the body is back on the bank');
    }
    assert.equal(body(renderer, 7, 21.8).lift, 0, 'the north bank is ground');
    // Turning off a ramp onto the bank fades the lift: no drop at the side.
    for (const tileY of [22.3, 26.7]) {
        let last = body(renderer, 7, tileY).lift;
        for (let tileX = 7; tileX <= 8.1; tileX += 0.05) {
            const { lift } = body(renderer, tileX, tileY);
            assert.ok(Math.abs(lift - last) <= 5, `turning east at row ${tileY}: lift jumps ${last.toFixed(1)} -> ${lift.toFixed(1)} at x ${tileX.toFixed(2)}`);
            last = lift;
        }
        assert.equal(last, 0, `the bank east of row ${tileY} is ground`);
    }
    // The water either side of the deck is ground.
    for (const [tileX, tileY] of [[6, 24], [8, 24], [6, 26], [8, 23]]) {
        assert.equal(body(renderer, tileX, tileY).lift, 0, `${tileX},${tileY} is not lifted`);
    }
});

test('trestle: on the deck both files sort behind the rail, which crosses the near file\'s legs and never a far-file body', () => {
    const { renderer, rails } = centralBridge('west-river-plank');
    assert.equal(rails.length, 8, 'the 4-tile span keeps eight near-rail slices');
    let nearCrossed = 0;
    for (const { tileY, lanePx } of samplesAlong(22, 27, [-TRESTLE_LANE, 0, TRESTLE_LANE])) {
        const sprite = body(renderer, 7, tileY, lanePx);
        if (sprite.tile.tileY < TRESTLE_FROM || sprite.y >= rails[0].bridgeWalk.minY) continue;
        const sortY = bodySortY(rails, sprite);
        assert.equal(sortY, sprite.y, `body at 7,${tileY.toFixed(2)} lane ${lanePx} keeps its ground Y on the deck`);
        for (const { rail, reach } of railsOver(rails, sprite)) {
            assert.ok(sortY < rail.sortY, `body at 7,${tileY.toFixed(2)} lane ${lanePx}: sorts at ${sortY.toFixed(2)}, after ${rail.id} (${rail.sortY.toFixed(2)})`);
            assert.ok(reach <= LEGS_PX, `body at 7,${tileY.toFixed(2)} lane ${lanePx}: ${rail.id} reaches ${reach.toFixed(0)} px up its box, above the legs`);
            if (lanePx > 0) assert.ok(reach <= 1, `far-file body at 7,${tileY.toFixed(2)}: ${rail.id} reaches ${reach.toFixed(0)} px above its feet`);
            if (lanePx < 0 && reach > 0) nearCrossed++;
        }
    }
    assert.ok(nearCrossed > 20, `the rail crosses the near file's legs along the deck (${nearCrossed} samples)`);
});

test('trestle: on the south ramp and landing a body keeps the over-rail rule and the rail never cuts it', () => {
    const { renderer, rails } = centralBridge('west-river-plank');
    const last = Math.max(...rails.map((rail) => rail.sortY));
    let ruled = 0;
    for (const { tileY, lanePx } of samplesAlong(26.3, 27.4, [-TRESTLE_LANE, -4.4, 0, 4.4])) {
        const sprite = body(renderer, 7, tileY, lanePx);
        if (sprite.y < rails[0].bridgeWalk.minY) continue;
        const sortY = bodySortY(rails, sprite);
        assert.ok(sortY > last, `body at 7,${tileY.toFixed(2)} lane ${lanePx}: sorts at ${sortY.toFixed(2)}, before the last slice (${last.toFixed(2)})`);
        for (const { rail } of railsOver(rails, sprite)) assert.ok(sortY > rail.sortY, `${rail.id} paints over the body at 7,${tileY.toFixed(2)}`);
        ruled++;
    }
    assert.ok(ruled > 20, 'the ramp and the landing are sampled');
});

test('trestle: on the north ramp and landing, and off the walk, a body keeps its ground Y', () => {
    const { renderer, rails } = centralBridge('west-river-plank');
    for (const { tileY, lanePx } of samplesAlong(21.5, 22.4, [-4.4, 0, 4.4])) {
        const sprite = body(renderer, 7, tileY, lanePx);
        assert.equal(bodySortY(rails, sprite), sprite.y, `7,${tileY.toFixed(2)} lane ${lanePx} keeps its ground Y`);
    }
    for (const [tileX, tileY] of [[6, 24], [8, 24], [8, 22], [6, 22], [8, 26], [6, 27], [9, 25]]) {
        const sprite = body(renderer, tileX, tileY);
        assert.equal(bodySortY(rails, sprite), sprite.y, `${tileX},${tileY} keeps its ground Y`);
    }
});

test('trestle: bodies on the walk that overlap keep their ground order', () => {
    const { renderer, rails } = centralBridge('west-river-plank');
    const bodies = samplesAlong(21.5, 27.4, [-TRESTLE_LANE, -4.4, 0, 4.4, TRESTLE_LANE]).map(({ tileY, lanePx }) => {
        const sprite = body(renderer, 7, tileY, lanePx);
        return { sprite, sortY: bodySortY(rails, sprite) };
    });
    for (const a of bodies) {
        for (const b of bodies) {
            if (b.sprite.y - a.sprite.y < 1) continue;
            const ay = a.sprite.y - a.sprite.lift;
            const by = b.sprite.y - b.sprite.lift;
            if (Math.abs(a.sprite.x - b.sprite.x) >= 34 || Math.abs(ay - by) >= 61) continue;
            assert.ok(b.sortY > a.sortY, `nearer body (y ${b.sprite.y.toFixed(1)}) sorts after the farther (y ${a.sprite.y.toFixed(1)})`);
        }
    }
});

test('trestle: installed by data, on the same walk tiles, keeping the maples and casting no under-deck shadow', () => {
    const { renderer } = centralBridge('west-river-plank');
    const span = renderer.bridgeSpans.find((entry) => entry.id === 'west-river-plank');
    assert.equal(span.style, 'rustic');
    assert.equal(renderer._bridgeSpriteId(span), 'bridge.landmark.rustic.ns');
    assert.deepEqual(span.centerTile, { x: 7, y: 24.5 });
    assert.equal(span.laneOffsetPx, TRESTLE_LANE);
    // The walk grid is today's: the deck column (7, 23..26) only.
    const deck = [...renderer.bridgeTiles].filter(([, info]) => info.bridgeId === 'west-river-plank');
    assert.deepEqual(deck.map(([key]) => key).sort(), ['7,23', '7,24', '7,25', '7,26']);
    for (const [, info] of deck) {
        assert.equal(info.kind, 'landmark');
        assert.equal(info.walkable, true);
        assert.equal(info.treeExclusion, false);
        assert.equal(info.underDeckShadow, false);
    }
    // The maples south-east of the Mine stay; the central bridge keeps its exclusion.
    assert.equal(renderer._isInBridgeTreeExclusion(9.2, 27.8), false);
    assert.equal(renderer._isInBridgeTreeExclusion(10.2, 27.8), false);
    assert.equal(renderer._isInBridgeTreeExclusion(7, 24.5), false);
    assert.equal(renderer._isInBridgeTreeExclusion(19, 26), true);
    let fills = 0;
    const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { fills++; } };
    renderer._drawBridgeUnderDeckWaterShadow(ctx, span);
    assert.equal(fills, 0, 'a piled trestle bakes no under-deck shadow');
});
