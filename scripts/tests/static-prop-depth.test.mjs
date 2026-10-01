import assert from 'node:assert/strict';
import test from 'node:test';

import { TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { VILLAGE_GATE, VILLAGE_GATE_BOUNDS } from '../../claudeville/src/config/townPlan.js';
import { appendDepthSortedDrawables } from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
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
