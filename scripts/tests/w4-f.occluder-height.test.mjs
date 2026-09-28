import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLightSource } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { clampGpuLights } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { packGeometryPixels } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('packed geometry keeps material, height and strength apart and marks missing channels', () => {
    // Texel 0: both channels. 1: material only. 2: occluder only (strength 0
    // authored). 3: neither.
    const packed = packGeometryPixels(
        new Uint8ClampedArray([3, 0, 0, 255, 4, 0, 0, 255, 9, 9, 9, 0, 5, 0, 0, 0]),
        new Uint8ClampedArray([19, 203, 77, 255, 231, 17, 42, 0, 88, 0, 0, 255, 7, 7, 7, 0]),
        4,
    );
    assert.deepEqual([...packed], [
        3, 19, 203, 255,
        // No geometry: B = 0, so the shader keeps the record's elevation and strength.
        4, 0, 0, 255,
        // No material: R = 255, so the shader keeps the record's material class;
        // an authored strength of 0 still reads as geometry (1/255).
        255, 88, 1, 255,
        0, 0, 0, 0,
    ]);
});

test('authored light priority survives normalization and controls the admitted slot', () => {
    const incidental = normalizeLightSource({
        id: 'lantern',
        x: 80,
        y: 80,
        priority: 1,
        intensity: 3,
    });
    const lighthouse = normalizeLightSource({
        id: 'lighthouse',
        x: 120,
        y: 80,
        priority: 9,
        intensity: 1,
    });

    assert.equal(incidental.priority, 1);
    assert.equal(lighthouse.priority, 9);
    assert.equal(clampGpuLights([incidental, lighthouse], 1)[0].id, 'lighthouse');
});
