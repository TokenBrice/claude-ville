import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDepthDrawable,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';

test('paint counts distinguish resident skips from lower and upper category replay', () => {
    const calls = [];
    const drawables = ['building-front', 'prop', 'harbor-traffic', 'bridge-lantern'].map(kind =>
        createDepthDrawable(kind, 0, {}, ctx => calls.push(`${ctx.pass}:${kind}`)));
    drawables[2].sceneCategory = { id: 'harbor-traffic' };
    drawables[2].overlayBand = 40;
    drawables[3].sceneCategory = { id: 'bridge-lantern' };
    drawables[3].overlayBand = 45;
    const paintCounts = { lower: Object.create(null), upper: Object.create(null) };
    const resolution = { overlayCategoryIds: new Set(['harbor-traffic', 'bridge-lantern']) };
    drawDepthSortedDrawables({ pass: 'lower' }, drawables, { gpuWorldActive: true, paintCounts });
    drawSceneCategoryOverlays({ pass: 'upper' }, drawables, resolution, { paintCounts });
    assert.deepEqual({ ...paintCounts.lower }, {
        'building-front': 0, prop: 0, 'harbor-traffic': 1, 'bridge-lantern': 1,
    });
    assert.deepEqual({ ...paintCounts.upper }, {
        'building-front': 0, prop: 0, 'harbor-traffic': 1, 'bridge-lantern': 1,
    });
    assert.deepEqual(calls, [
        'lower:harbor-traffic', 'lower:bridge-lantern',
        'upper:harbor-traffic', 'upper:bridge-lantern',
    ]);
    calls.length = 0;
    drawDepthSortedDrawables({ pass: 'fallback' }, drawables);
    assert.deepEqual(calls, [
        'fallback:building-front', 'fallback:prop',
        'fallback:harbor-traffic', 'fallback:bridge-lantern',
    ]);
});
