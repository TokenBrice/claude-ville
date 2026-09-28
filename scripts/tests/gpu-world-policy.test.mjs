import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_MATERIAL_CLASSES,
  buildStableGpuBatches,
  clampGpuLights,
  estimateGpuWorldTextureBytes,
  isAttentionLight,
  localLightPhaseForLighting,
  materialClassId,
  isSoftwareRasterizer,
  forcedGpuWorldRendererMode,
  resolveGpuWorldRendererMode,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
  applyGradeToRgb,
  evaluateGrade,
  GRADE_EXPOSURE_FLOOR,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import {
  buildGpuWorldRecords,
  gpuMaterialNameForBuilding,
  gpuMaterialNameForProp,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('GPU renderer is the default after parity gates pass with a Canvas escape hatch', () => {
  assert.equal(resolveGpuWorldRendererMode('', { webgl2: true }), 'webgl');
  assert.equal(resolveGpuWorldRendererMode('?renderer=canvas', { webgl2: true }), 'canvas');
  assert.equal(resolveGpuWorldRendererMode('?renderer=webgl', { webgl2: false }), 'canvas');
});

test('a software rasterizer defaults to the Canvas world unless WebGL is forced', () => {
  const software = { webgl2: true, softwareRaster: true };
  assert.equal(resolveGpuWorldRendererMode('', software), 'canvas');
  assert.equal(resolveGpuWorldRendererMode('?renderer=webgl', software), 'webgl');
  assert.equal(resolveGpuWorldRendererMode('?renderer=canvas', software), 'canvas');
  // Only exactly `webgl` / `canvas` (any case) forces a mode and may skip the
  // software-raster probe; an empty or unknown value takes the default.
  assert.equal(forcedGpuWorldRendererMode('?renderer=WebGL'), 'webgl');
  assert.equal(forcedGpuWorldRendererMode('?renderer=CANVAS'), 'canvas');
  for (const search of ['', '?renderer=', '?renderer=bogus', '?renderer=webgl2', '?postfx=0']) {
    assert.equal(forcedGpuWorldRendererMode(search), null, search);
    assert.equal(resolveGpuWorldRendererMode(search, software), 'canvas', search);
  }
  for (const name of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]) assert.equal(isSoftwareRasterizer(name), true, name);
  for (const name of [
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
    'Apple GPU',
    '',
  ]) assert.equal(isSoftwareRasterizer(name), false, name);
});

test('stable GPU batches merge only consecutive compatible records', () => {
  const imageA = { width: 16, height: 16 };
  const imageB = { width: 16, height: 16 };
  const records = [
    { source: imageA, textureKey: 'a', x: 0, y: 0, width: 16, height: 16 },
    { source: imageA, textureKey: 'a', x: 16, y: 0, width: 16, height: 16 },
    { source: imageB, textureKey: 'b', x: 32, y: 0, width: 16, height: 16 },
    { source: imageA, textureKey: 'a', x: 48, y: 0, width: 16, height: 16 },
  ];
  const batches = buildStableGpuBatches(records);
  assert.deepEqual(batches.map(batch => batch.records.length), [2, 1, 1]);
  assert.deepEqual(batches.flatMap(batch => batch.records.map(record => record.x)), [0, 16, 32, 48]);
});

test('material ids and light admission are deterministic', () => {
  assert.equal(materialClassId('water'), GPU_MATERIAL_CLASSES.water);
  assert.equal(materialClassId('unknown'), GPU_MATERIAL_CLASSES.default);
  const admitted = clampGpuLights([
    { id: 'b', x: 1, y: 1, priority: 1, intensity: 2 },
    { id: 'a', x: 1, y: 1, priority: 2, intensity: 1 },
    { id: 'invalid', x: Number.NaN, y: 1, priority: 99 },
  ], 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].id, 'a');
});

test('the moon brightens the night grade and never relights the day', () => {
  const night = moonFill => evaluateGrade({ minuteOfDay: 23 * 60, moonFill });
  const dark = night(0);
  const half = night(0.4);
  const moonlit = night(0.95);
  assert.ok(dark.exposure < half.exposure && half.exposure < moonlit.exposure);
  // A dark storm night still has to be readable ground, not a black screen.
  const stormNight = evaluateGrade({ minuteOfDay: 2 * 60, moonFill: 0, weather: { type: 'storm', intensity: 1, cloudCover: 1 } });
  assert.ok(stormNight.exposure >= GRADE_EXPOSURE_FLOOR);
  // Daylight ignores the moon entirely.
  assert.deepEqual(evaluateGrade({ minuteOfDay: 12 * 60, moonFill: 1 }), evaluateGrade({ minuteOfDay: 12 * 60, moonFill: 0 }));
});

test('the grade tells the time and the weather apart', () => {
  const at = (hour, weather = { type: 'clear', cloudCover: 0.08 }) => evaluateGrade({ minuteOfDay: hour * 60, weather });
  const noon = at(12);
  const night = at(22);
  // Representative world albedo: grass, stone, slate roof, water, timber.
  const albedo = [[0.34, 0.46, 0.22], [0.58, 0.55, 0.50], [0.30, 0.36, 0.46], [0.18, 0.32, 0.38], [0.48, 0.33, 0.20]];
  const graded = grade => albedo.map(rgb => applyGradeToRgb(rgb, grade));
  const meanSat = grade => graded(grade).reduce((sum, [r, g, b]) => {
    const max = Math.max(r, g, b);
    return sum + (max > 0 ? (max - Math.min(r, g, b)) / max : 0);
  }, 0) / albedo.length;
  const meanRedMinusBlue = grade => graded(grade).reduce((sum, [r, , b]) => sum + r - b, 0) / albedo.length;
  // Night is darker than noon but keeps colour: a moonlit blue, neither
  // black-and-white nor as colourful as day.
  assert.ok(night.exposure < noon.exposure * 0.8);
  const satRatio = meanSat(night) / meanSat(noon);
  assert.ok(satRatio >= 0.5 && satRatio <= 0.85, `night/noon saturation ${satRatio.toFixed(2)}`);
  assert.ok(meanRedMinusBlue(night) < meanRedMinusBlue(noon));
  // Golden hour is warmer than noon.
  const warmth = grade => grade.gain[0] * grade.highlightTint[0] - grade.gain[2] * grade.highlightTint[2];
  assert.ok(warmth(at(17)) > warmth(noon));
  // Rain and storm at noon are flatter and less colourful than clear, storm most.
  const rain = at(12, { type: 'rain', intensity: 0.8, cloudCover: 0.92 });
  const storm = at(12, { type: 'storm', intensity: 1, cloudCover: 1 });
  assert.ok(storm.saturation < rain.saturation && rain.saturation < noon.saturation);
  assert.ok(storm.sunBand === 0 && rain.sunBand === 0 && noon.sunBand === 1);
});

test('action-needed lights are recognised so the exposure budget can skip them', () => {
  assert.equal(isAttentionLight({ id: 'attention:waiting:a1' }), true);
  assert.equal(isAttentionLight({ attention: 'errored' }), true);
  assert.equal(isAttentionLight({ id: 'building.harbor.point.1.2' }), false);
});

test('local point lights disappear at noon and rise with darkness or weather beacons', () => {
  assert.equal(localLightPhaseForLighting({ ambientLight: 1, beaconIntensity: 0 }), 0);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0.65, beaconIntensity: 0.2 }), 0.35);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0.9, beaconIntensity: 0.42 }), 0.42);
  assert.equal(localLightPhaseForLighting({ ambientLight: 0, beaconIntensity: 1 }), 1);
});

test('texture byte estimates include render targets and cached sources', () => {
  const estimate = estimateGpuWorldTextureBytes({
    width: 100,
    height: 80,
    bloomScale: 0.5,
    cachedTextures: [{ width: 20, height: 10, copies: 2 }],
  });
  assert.equal(estimate.targets, (8000 + 2000 * 2) * 4);
  assert.equal(estimate.textures, 20 * 10 * 4 * 2);
  assert.equal(estimate.total, estimate.targets + estimate.textures);
});

test('scene builder preserves terrain-first and painter-order records', () => {
  const terrain = { width: 64, height: 32 };
  const building = { width: 20, height: 30 };
  const renderer = {
    terrainCacheKey: 'summer',
    _getTerrainCache: () => ({ canvas: terrain, bounds: { x: -10, y: -5, w: 64, h: 32 } }),
    assets: {
      assetVersion: 'v1',
      get: id => id === 'building.command' ? building : null,
      getDims: () => ({ w: 20, h: 30 }),
      getAnchor: () => [10, 25],
    },
    buildingRenderer: { _workTierFor: () => 'occupied' },
    camera: { zoom: 1 },
  };
  const records = buildGpuWorldRecords(renderer, {
    drawables: [{
      kind: 'building',
      payload: {
        kind: 'building',
        building: { type: 'command' },
        entry: { id: 'building.command' },
        wx: 100,
        wy: 80,
      },
    }],
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'terrain:static');
  assert.equal(records[1].id, 'building.command:building');
  assert.equal(records[1].x, 90);
  assert.equal(records[1].y, 55);
});

test('scene material inference follows semantic sprite identity', () => {
  assert.equal(gpuMaterialNameForBuilding('harbor'), 'timber');
  assert.equal(gpuMaterialNameForBuilding('portal'), 'rune');
  assert.equal(gpuMaterialNameForProp({ id: 'veg.tree.oak.large' }), 'foliage');
  assert.equal(gpuMaterialNameForProp({ id: 'prop.runeBrazier' }), 'fire');
});
