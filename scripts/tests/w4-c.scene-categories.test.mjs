import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    appendDepthSortedDrawables,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import {
    SceneCategoryRegistry,
    worldSceneCategoryRegistry,
} from '../../claudeville/src/presentation/character-mode/SceneCategoryRegistry.js';

function category(overrides = {}) {
    return {
        id: 'test-category',
        sortBand: 45,
        enumerate: () => [{ id: 'item-1', sortY: 20 }],
        emitSceneCommands: () => null,
        canvasFallback: () => {},
        unsupported: 'overlay-safe',
        overlayBand: 30,
        ...overrides,
    };
}

test('harbor traffic uses the same Canvas fallback for Canvas and automatic GPU overlay frames', () => {
    const item = { id: 'ship-1', sortY: 20, payload: { type: 'ship' } };
    const calls = [];
    const renderer = {
        harborTraffic: {
            enumerateDrawables: () => [item],
            draw: (ctx, drawable, zoom) => calls.push({ ctx, drawable, zoom }),
        },
    };
    const frame = worldSceneCategoryRegistry.enumerate({ renderer });
    const resolution = worldSceneCategoryRegistry.resolve(frame, {
        id: 'webgl2',
        supportsSceneCommands: () => false,
    });
    const drawables = [];
    appendDepthSortedDrawables(drawables, { sceneCategoryFrame: frame });

    const canvasCtx = { path: 'canvas' };
    drawDepthSortedDrawables(canvasCtx, drawables, { renderer, zoom: 1.25 });
    const overlayCtx = { path: 'overlay' };
    drawSceneCategoryOverlays(overlayCtx, drawables, resolution, { renderer, zoom: 1.25 });

    assert.equal(drawables.length, 1);
    assert.equal(drawables[0].kind, 'harbor-traffic');
    assert.equal(drawables[0].sortY, 20);
    assert.equal(drawables[0].sortBand, 40);
    assert.equal(drawables[0].payload, item);
    assert.deepEqual(calls, [
        { ctx: canvasCtx, drawable: item, zoom: 1.25 },
        { ctx: overlayCtx, drawable: item, zoom: 1.25 },
    ]);
    assert.deepEqual([...resolution.overlayCategoryIds], ['harbor-traffic']);
});

test('landmark activity uses the depth pass on Canvas and overlay replay on unsupported GPU backends', () => {
    const item = {
        kind: 'landmark-activity',
        sortY: 66,
        payload: { id: 'cache-cart', type: 'token', cargoLabel: '50% CACHE' },
    };
    const calls = [];
    const enumerationTimes = [];
    const renderer = {
        landmarkActivity: {
            enumerateDrawables: now => {
                enumerationTimes.push(now);
                return [item];
            },
            draw: (ctx, drawable, zoom) => calls.push({ ctx, drawable, zoom }),
        },
    };
    const frame = worldSceneCategoryRegistry.enumerate({ renderer, renderNow: 8500 });
    const resolution = worldSceneCategoryRegistry.resolve(frame, {
        id: 'webgl2',
        supportsSceneCommands: () => false,
    });
    const drawables = [];
    appendDepthSortedDrawables(drawables, { sceneCategoryFrame: frame });

    const canvasCtx = { path: 'canvas-depth' };
    drawDepthSortedDrawables(canvasCtx, drawables, { renderer, zoom: 1.5 });
    const overlayCtx = { path: 'gpu-overlay' };
    drawSceneCategoryOverlays(overlayCtx, drawables, resolution, { renderer, zoom: 1.5 });

    assert.deepEqual(enumerationTimes, [8500]);
    assert.equal(drawables.length, 1);
    assert.equal(drawables[0].kind, 'landmark-activity');
    assert.equal(drawables[0].sortBand, 60);
    assert.equal(drawables[0].payload, item);
    assert.deepEqual([...resolution.overlayCategoryIds], ['landmark-activity']);
    assert.deepEqual(calls, [
        { ctx: canvasCtx, drawable: item, zoom: 1.5 },
        { ctx: overlayCtx, drawable: item, zoom: 1.5 },
    ]);
});

test('require-canvas-frame prevents an unsupported depth category from being overlaid', () => {
    const registry = new SceneCategoryRegistry([
        category({ unsupported: 'require-canvas-frame' }),
    ]);
    const resolution = registry.resolve(registry.enumerate(), {
        id: 'future-backend',
        supportsSceneCommands: () => false,
    });

    assert.equal(resolution.requireCanvasFrame, true);
    assert.equal(resolution.overlayCategoryIds.size, 0);
    assert.deepEqual(resolution.diagnostics, [{
        code: 'scene-category-requires-canvas',
        categoryId: 'test-category',
        backendId: 'future-backend',
        message: 'Scene backend future-backend cannot render category test-category; using the Canvas frame.',
    }]);
    assert.equal(resolution.categories[0].handling, 'canvas-required');
});

test('omit deliberately drops an unsupported category from alternate-backend handling', () => {
    const registry = new SceneCategoryRegistry([
        category({ unsupported: 'omit' }),
    ]);
    const resolution = registry.resolve(registry.enumerate(), {
        id: 'future-backend',
        supportsSceneCommands: () => false,
    });

    assert.equal(resolution.requireCanvasFrame, false);
    assert.equal(resolution.overlayCategoryIds.size, 0);
    assert.deepEqual([...resolution.omittedCategoryIds], ['test-category']);
    assert.equal(resolution.categories[0].handling, 'omitted');
});

test('a backend must accept complete neutral commands before a category is native', () => {
    const seen = [];
    const registry = new SceneCategoryRegistry([
        category({
            enumerate: () => [
                { id: 'one', sortY: 10 },
                { id: 'two', sortY: 20 },
            ],
            emitSceneCommands: item => ({ type: 'sprite', id: item.id }),
        }),
    ]);
    const resolution = registry.resolve(registry.enumerate(), {
        id: 'future-backend',
        supportsSceneCommands(request) {
            seen.push(request);
            return true;
        },
    });

    assert.deepEqual(seen, [{
        categoryId: 'test-category',
        commands: [
            { type: 'sprite', id: 'one' },
            { type: 'sprite', id: 'two' },
        ],
    }]);
    assert.deepEqual(resolution.nativeCommandBatches, seen);
    assert.equal(resolution.categories[0].handling, 'native');
    assert.equal(resolution.overlayCategoryIds.size, 0);
});

test('partial neutral command emission follows policy instead of partially vanishing', () => {
    let capabilityChecks = 0;
    const registry = new SceneCategoryRegistry([
        category({
            enumerate: () => [{ id: 'one' }, { id: 'two' }],
            emitSceneCommands: item => item.id === 'one'
                ? { type: 'sprite', id: item.id }
                : null,
        }),
    ]);
    const resolution = registry.resolve(registry.enumerate(), {
        id: 'future-backend',
        supportsSceneCommands() {
            capabilityChecks++;
            return true;
        },
    });

    assert.equal(capabilityChecks, 0);
    assert.deepEqual([...resolution.overlayCategoryIds], ['test-category']);
    assert.equal(resolution.nativeCommandBatches.length, 0);
    assert.equal(resolution.categories[0].handling, 'overlay');
});

test('overlayBand orders categories while preserving depth order inside a band', () => {
    const calls = [];
    const registry = new SceneCategoryRegistry([
        category({
            id: 'late-overlay',
            overlayBand: 80,
            enumerate: () => [{ id: 'late', sortY: 1 }],
            canvasFallback: (_ctx, item) => calls.push(item.id),
        }),
        category({
            id: 'early-overlay',
            overlayBand: 10,
            enumerate: () => [
                { id: 'early-a', sortY: 30 },
                { id: 'early-b', sortY: 40 },
            ],
            canvasFallback: (_ctx, item) => calls.push(item.id),
        }),
    ]);
    const frame = registry.enumerate();
    const resolution = registry.resolve(frame, { id: 'webgl2' });
    const drawables = [];
    appendDepthSortedDrawables(drawables, { sceneCategoryFrame: frame });

    drawSceneCategoryOverlays({}, drawables, resolution);

    assert.deepEqual(calls, ['early-a', 'early-b', 'late']);
});

test('WorldFrameRenderer contains no backend-specific category replay list', async () => {
    const source = await readFile(new URL(
        '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js',
        import.meta.url,
    ), 'utf8');

    assert.equal(source.includes("['harbor-traffic']"), false);
    assert.equal(source.includes('drawDepthSortedDrawableKinds'), false);
    assert.match(source, /drawSceneCategoryOverlays\(overlayCtx, drawables, sceneCategoryResolution/);
});
