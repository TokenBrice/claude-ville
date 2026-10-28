import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
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
function centralBridge() {
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
    const span = renderer.bridgeSpans.find((entry) => entry.id === 'central-river-bridge');
    const rails = renderer._buildBridgeNearRailSprites().filter((sprite) => sprite.id.startsWith('bridge.rail.central-river-bridge.'));
    // Each slice's painted region: the clip quad its drawFn cuts.
    const count = rails.length;
    rails.forEach((rail, index) => { rail.quad = renderer._bridgeNearRailQuad(span, index / count, (index + 1) / count); });
    return { renderer, rails };
}

// The walk the user saw a body cross: the deck column x=18 from the north
// landing tile (18,22) to the south one (18,26). Deck tiles keep their lanes
// 10 px either side of the line (LANE_STEERING.bridgeOffsetPx), the landings
// at most an avenue's 4.4 px.
function walkSamples() {
    const samples = [];
    for (let step = 0; step <= 48; step++) {
        const tileY = 21.6 + step / 10;
        const lane = tileY > 22.5 && tileY < 25.5 ? 10 : 4.4;
        for (const lanePx of [-lane, 0, lane]) samples.push({ tileY, lanePx });
    }
    return samples;
}

// A body at a tile, `lanePx` across the walk, lifted along the arch as
// AgentSprite lifts it.
function body(renderer, tileX, tileY, lanePx = 0) {
    const world = tileToWorld(tileX, tileY);
    const x = world.x - 0.4472136 * lanePx;
    const y = world.y - 0.8944272 * lanePx;
    const tile = worldToTile(x, y);
    const lift = Math.max(0, renderer.getBridgeLift(tile.tileX, tile.tileY));
    return { x, y, lift, _currentBridgeLift: () => lift };
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
// default body box, at its lifted feet), sampled every texel.
function railsOver(rails, sprite) {
    const footY = sprite.y - sprite.lift;
    return rails.filter((rail) => {
        for (let y = footY - 58; y <= footY + 3; y++) {
            for (let x = sprite.x - 17; x <= sprite.x + 17; x++) if (insideQuad(rail.quad, x, y)) return true;
        }
        return false;
    });
}

test('bridge-end: a body on the central bridge walk paints over every near-rail slice it overlaps', () => {
    const { renderer, rails } = centralBridge();
    assert.equal(rails.length, 6, 'the 3-tile span keeps six near-rail slices');
    let overlapped = 0;
    for (const { tileY, lanePx } of walkSamples()) {
        const sprite = body(renderer, 18, tileY, lanePx);
        const sortY = bodySortY(rails, sprite);
        for (const rail of railsOver(rails, sprite)) {
            overlapped++;
            assert.ok(sortY > rail.sortY, `body at 18,${tileY.toFixed(1)} lane ${lanePx}: sorts at ${sortY.toFixed(2)}, under ${rail.id} (${rail.sortY.toFixed(2)})`);
        }
    }
    assert.ok(overlapped > 0, 'the walk crosses the near-rail slices');
    // The user's report: a body at the north landing, under the end posts.
    const landing = body(renderer, 18, 22);
    assert.ok(railsOver(rails, landing).length >= 2, 'the north landing sits under the end posts and the deck end');
});

test('bridge-end: off the walk a body keeps its ground Y, so the rail still covers what stands behind it', () => {
    const { renderer, rails } = centralBridge();
    // The bridge-east pause, the pond plank, the plaza north of the landing,
    // and the water beside the deck under its near and far sides.
    for (const [tileX, tileY] of [[19, 22], [17, 22], [18, 21], [19, 24], [17, 24], [20, 24]]) {
        const sprite = body(renderer, tileX, tileY);
        assert.equal(bodySortY(rails, sprite), sprite.y, `${tileX},${tileY} keeps its ground Y`);
    }
    const underArch = body(renderer, 19, 24);
    assert.ok(railsOver(rails, underArch).some((rail) => rail.sortY > underArch.y), 'a body in the water beside the near side stays behind the rail');
});

test('bridge-end: two bodies on the walk that overlap keep their ground order', () => {
    const { renderer, rails } = centralBridge();
    const bodies = walkSamples().map(({ tileY, lanePx }) => {
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
