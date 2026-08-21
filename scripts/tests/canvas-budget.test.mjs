import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CANVAS_BUDGET,
    gpuResourceAccounting,
    unifiedRendererResourceAccounting,
} from '../../claudeville/src/presentation/character-mode/CanvasBudget.js';

test('GPU accounting names and sums textures, attachments, and buffers once', () => {
    const resources = gpuResourceAccounting({
        textures: { source: 400, waterMask: 100 },
        attachments: { sceneColor: 400, bloom: 50 },
        buffers: { vertices: 32 },
    });
    assert.deepEqual(resources.groupTotals, {
        textures: 500,
        attachments: 450,
        buffers: 32,
    });
    assert.equal(resources.totalBytes, 982);
});

test('unified accounting combines RGBA canvas pixels with GPU byte ownership', () => {
    const gpu = gpuResourceAccounting({ textures: { source: 1024 } });
    const resources = unifiedRendererResourceAccounting({
        visibleCanvasPixels: 100,
        volatileCanvasPixels: 50,
        retainedCanvasPixels: 25,
        gpu,
    });
    assert.equal(resources.canvasBytes, 175 * 4);
    assert.equal(resources.gpuBytes, 1024);
    assert.equal(resources.totalBytes, 1724);
    assert.equal(resources.budgetBytes, CANVAS_BUDGET.maxUnifiedRendererBytes);
});
