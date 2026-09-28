import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDepthDrawable,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';

test('resident path paints scene categories only on the overlay; native ones never on Canvas', () => {
    const calls = [];
    const drawables = ['building-front', 'prop', 'harbor-traffic', 'bridge-lantern'].map(kind =>
        createDepthDrawable(kind, 0, {}, ctx => calls.push(`${ctx.pass}:${kind}`)));
    drawables[2].sceneCategory = { id: 'harbor-traffic' };
    drawables[2].sceneNative = true;
    drawables[2].overlayBand = 40;
    drawables[3].sceneCategory = { id: 'bridge-lantern' };
    drawables[3].overlayBand = 45;
    const paintCounts = { lower: Object.create(null), upper: Object.create(null) };
    const resolution = { overlayCategoryIds: new Set(['bridge-lantern']) };
    drawDepthSortedDrawables({ pass: 'lower' }, drawables, { gpuWorldActive: true, paintCounts });
    drawSceneCategoryOverlays({ pass: 'upper' }, drawables, resolution, { paintCounts });
    assert.deepEqual({ ...paintCounts.lower }, {
        'building-front': 0, prop: 0, 'harbor-traffic': 0, 'bridge-lantern': 0,
    });
    assert.deepEqual({ ...paintCounts.upper }, {
        'building-front': 0, prop: 0, 'harbor-traffic': 0, 'bridge-lantern': 1,
    });
    assert.deepEqual(calls, ['upper:bridge-lantern']);
    calls.length = 0;
    drawDepthSortedDrawables({ pass: 'fallback' }, drawables);
    assert.deepEqual(calls, [
        'fallback:building-front', 'fallback:prop',
        'fallback:harbor-traffic', 'fallback:bridge-lantern',
    ]);
});
