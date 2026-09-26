import assert from 'node:assert/strict';
import test from 'node:test';

import { TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { VILLAGE_GATE, VILLAGE_GATE_BOUNDS } from '../../claudeville/src/config/townPlan.js';
import { appendDepthSortedDrawables } from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
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
