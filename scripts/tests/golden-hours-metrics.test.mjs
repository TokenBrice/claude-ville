import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DECLARED_ORDER,
  DEFAULT_TOLERANCES,
  GOLDEN_BACKENDS,
  GOLDEN_SCENES,
  buildCurve,
  checkGoldenRun,
  frameMetrics,
  metricsSettled,
} from '../world/golden-hours-metrics.mjs';

function frame(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

const metrics = (mean, warmShare = 0.02, extra = {}) => ({ mean, p10: 30, p90: 120, warmShare, darkShare: 0.08, ...extra });

// A plausible calibrated backend: the declared orderings hold with margin.
const CURVE_SCENES = {
  'clear-0500': metrics(70), 'clear-1200': metrics(93, 0.08), 'clear-1915': metrics(76, 0.009),
  'storm-1915': metrics(70, 0.008), 'clear-2300': metrics(80, 0.03), 'storm-0200': metrics(62),
};
const clone = (value) => JSON.parse(JSON.stringify(value));

test('frameMetrics reads luma percentiles, dark and lamp-light shares over the region only', () => {
  // Left half black, right half a warm lamp orange; region = right half.
  const img = frame(10, 4, (x) => (x < 5 ? [0, 0, 0] : [240, 160, 60]));
  const right = frameMetrics(img, [0.5, 0, 1, 1]);
  assert.equal(right.mean, Math.round(0.2126 * 240 + 0.7152 * 160 + 0.0722 * 60));
  assert.equal(right.warmShare, 1);
  assert.equal(right.darkShare, 0);
  const whole = frameMetrics(img, [0, 0, 1, 1]);
  assert.equal(whole.warmShare, 0.5);
  assert.equal(whole.darkShare, 0.5);
  assert.equal(whole.p10, 0);
  assert.equal(whole.p90, right.mean);
});

test('a warm pixel is bright, red over blue, green between: not cool, grey or dim light', () => {
  const cases = [
    [[240, 160, 60], 1], // lantern pool
    [[200, 200, 200], 0], // grey
    [[60, 120, 220], 0], // cool moonlight
    [[120, 70, 20], 0], // dim warm ground under the luma floor
    [[230, 100, 200], 0], // magenta: green not between
  ];
  for (const [rgb, expected] of cases) {
    assert.equal(frameMetrics(frame(2, 2, () => rgb), [0, 0, 1, 1]).warmShare, expected, `rgb ${rgb}`);
  }
});

test('frameMetrics rejects short buffers and empty regions', () => {
  assert.throws(() => frameMetrics({ data: new Uint8Array(4), width: 2, height: 2 }));
  assert.throws(() => frameMetrics(frame(4, 4, () => [0, 0, 0]), [0.5, 0.5, 0.5, 0.5]));
});

test('metricsSettled needs two agreeing captures', () => {
  const a = metrics(80);
  assert.equal(metricsSettled(null, a), false);
  assert.equal(metricsSettled(a, { ...a, mean: 80.04 }), true);
  assert.equal(metricsSettled(a, { ...a, mean: 80.2 }), false);
  assert.equal(metricsSettled(a, { ...a, p90: 121 }), false);
});

test('a run equal to the curve passes; drift past each tolerance fails', () => {
  const curve = buildCurve({ webgpu: clone(CURVE_SCENES) });
  assert.deepEqual(checkGoldenRun({ webgpu: clone(CURVE_SCENES) }, curve), []);

  const within = clone(CURVE_SCENES);
  within['clear-2300'].mean += DEFAULT_TOLERANCES.mean - 0.1;
  within['clear-2300'].warmShare *= 1 + DEFAULT_TOLERANCES.warmRel - 0.01;
  assert.deepEqual(checkGoldenRun({ webgpu: within }, curve), []);

  const cases = [
    ['mean', s => { s['clear-2300'].mean -= DEFAULT_TOLERANCES.mean + 0.5; }, /clear-2300: mean luma/],
    ['p90', s => { s['storm-0200'].p90 += DEFAULT_TOLERANCES.percentile + 1; }, /storm-0200: p90/],
    ['dark', s => { s['clear-0500'].darkShare += DEFAULT_TOLERANCES.dark + 0.01; }, /clear-0500: dark share/],
    ['lamps out', s => { s['clear-2300'].warmShare *= 0.5; }, /clear-2300: lamp-light share/],
    ['lamps brighter', s => { s['storm-0200'].warmShare += Math.max(DEFAULT_TOLERANCES.warmAbs, DEFAULT_TOLERANCES.warmRel * 0.02) + 0.001; }, /storm-0200: lamp-light share/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const run = clone(CURVE_SCENES);
    mutate(run);
    const failures = checkGoldenRun({ webgpu: run }, curve);
    assert.ok(failures.some(f => pattern.test(f)), `${name}: ${failures.join('; ')}`);
  }
});

test('curve tolerances override the defaults', () => {
  const curve = buildCurve({ webgpu: clone(CURVE_SCENES) });
  curve.tolerances.mean = 10;
  const run = clone(CURVE_SCENES);
  run['clear-1200'].mean += 5;
  assert.deepEqual(checkGoldenRun({ webgpu: run }, curve), []);
});

test('missing measurements and uncalibrated scenes fail; unmeasured backends are not checked', () => {
  const curve = buildCurve({ webgpu: clone(CURVE_SCENES) });
  const partial = clone(CURVE_SCENES);
  delete partial['storm-1915'];
  assert.ok(checkGoldenRun({ webgpu: partial }, curve).some(f => /storm-1915: not measured/.test(f)));
  assert.ok(checkGoldenRun({ canvas: clone(CURVE_SCENES) }, curve).every(f => /no calibrated value/.test(f)));
  // A scene subset (--scenes) checks only those scenes.
  const only = [GOLDEN_SCENES.find(s => s.id === 'clear-1200')];
  assert.deepEqual(checkGoldenRun({ webgpu: { 'clear-1200': CURVE_SCENES['clear-1200'] } }, curve, { scenes: only }), []);
});

test('declared orderings hold on every backend, whatever the curve says', () => {
  const broken = clone(CURVE_SCENES);
  broken['storm-1915'].mean = broken['clear-1915'].mean; // a storm as bright as clear dusk
  const curve = buildCurve({ webgpu: clone(broken) });
  const failures = checkGoldenRun({ webgpu: broken }, curve);
  assert.ok(failures.some(f => /clear-1915 .* brighter than storm-1915/.test(f)), failures.join('; '));
  for (const [bright, dim] of DECLARED_ORDER) {
    assert.ok(GOLDEN_SCENES.some(s => s.id === bright) && GOLDEN_SCENES.some(s => s.id === dim));
  }
});

test('cross-backend limits: WebGPU and WebGL2 agree tightly, Canvas loosely', () => {
  const gl = clone(CURVE_SCENES);
  const canvas = clone(CURVE_SCENES);
  const curve = buildCurve({ webgpu: clone(CURVE_SCENES), webgl: clone(CURVE_SCENES), canvas: clone(CURVE_SCENES) });
  curve.tolerances.mean = 100;
  gl['clear-2300'].mean += DEFAULT_TOLERANCES.gpuPairMean + 0.5;
  canvas['storm-1915'].mean += DEFAULT_TOLERANCES.canvasMean + 0.5;
  const failures = checkGoldenRun({ webgpu: clone(CURVE_SCENES), webgl: gl, canvas }, curve);
  assert.ok(failures.some(f => /clear-2300: WebGPU .* WebGL2/.test(f)), failures.join('; '));
  assert.ok(failures.some(f => /storm-1915: Canvas/.test(f)), failures.join('; '));
});

test('buildCurve keeps prior tolerances and backends it did not re-measure', () => {
  const previous = buildCurve({ canvas: clone(CURVE_SCENES) });
  previous.tolerances.mean = 2.5;
  const next = buildCurve({ webgpu: clone(CURVE_SCENES) }, previous);
  assert.equal(next.tolerances.mean, 2.5);
  assert.deepEqual(Object.keys(next.backends).sort(), ['canvas', 'webgpu']);
});

test('the committed curve covers every backend and scene and passes its own checks', () => {
  const curve = JSON.parse(readFileSync(new URL('../world/golden-hours.json', import.meta.url), 'utf8'));
  for (const backend of GOLDEN_BACKENDS) {
    for (const scene of GOLDEN_SCENES) {
      const m = curve.backends?.[backend]?.[scene.id];
      assert.ok(m && Number.isFinite(m.mean) && Number.isFinite(m.warmShare), `${backend} ${scene.id}`);
    }
  }
  assert.deepEqual(checkGoldenRun(curve.backends, curve), []);
});
