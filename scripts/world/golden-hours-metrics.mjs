// T5 golden hour-sweep: the scenes, the frame metrics and the tolerance
// checks, as pure functions (no browser). `golden-hours.mjs` renders the
// scenes and calls these; `scripts/tests/golden-hours-metrics.test.mjs`
// covers them. The committed curve is `golden-hours.json`: numbers only.

// The scene matrix: fixed hours and weathers on one pinned date. Weather
// profiles carry an explicit seed so cloud courses are the same every run.
const CLEAR = Object.freeze({ type: 'clear', intensity: 0.18, cloudCover: 0.08, precipitation: 0, fog: 0, windX: 0.1, seed: 4242 });
// The user's real 2026-10-24 19:15 timeline state (storm 0.90, cover 0.97).
const STORM = Object.freeze({ type: 'storm', intensity: 0.9, cloudCover: 0.97, precipitation: 0.92, fog: 0.18, windX: -0.6, seed: 4242 });

export const GOLDEN_SCENES = Object.freeze([
  Object.freeze({ id: 'clear-0500', hour: 5, weather: CLEAR }),
  Object.freeze({ id: 'clear-1200', hour: 12, weather: CLEAR }),
  Object.freeze({ id: 'clear-1915', hour: 19.25, weather: CLEAR }),
  Object.freeze({ id: 'storm-1915', hour: 19.25, weather: STORM }),
  Object.freeze({ id: 'clear-2300', hour: 23, weather: CLEAR }),
  Object.freeze({ id: 'storm-0200', hour: 2, weather: STORM }),
]);

export const GOLDEN_BACKENDS = Object.freeze(['webgpu', 'webgl', 'canvas']);

// Island region of the world stack, as fractions [x0, y0, x1, y1]: clear of
// the frame edges, where the camera pose puts the village.
export const ISLAND_REGION = Object.freeze([0.2, 0.15, 0.8, 0.85]);

// A "warm" pixel: red over blue by WARM_SPREAD with green between them, and
// bright. At night that is lamp light (lantern and brazier pools, lit
// windows, the Pharos lens); by day it also counts sunlit thatch, timber
// and sand, so the share is a lamp metric only for the night scenes and is
// compared per scene, never across hours.
export const WARM_SPREAD = 48;
export const WARM_MIN_LUMA = 96;
export const DARK_MAX_LUMA = 32;

const luma = (r, g, b) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

/**
 * Metrics of one RGBA frame (alpha ignored) over `region`:
 * `mean` (8-bit Rec. 709 luma on the encoded values), `p10`/`p90`, and the
 * shares of warm (lamp-light) and dark (< 32) pixels.
 */
export function frameMetrics({ data, width, height }, region = ISLAND_REGION) {
  if (!data || !(width > 0) || !(height > 0) || data.length < width * height * 4) {
    throw new Error('frameMetrics needs RGBA data of width * height * 4 bytes');
  }
  const x0 = Math.floor(region[0] * width);
  const x1 = Math.floor(region[2] * width);
  const y0 = Math.floor(region[1] * height);
  const y1 = Math.floor(region[3] * height);
  const hist = new Uint32Array(256);
  let n = 0;
  let sum = 0;
  let warm = 0;
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const l = luma(r, g, b);
      hist[l]++;
      sum += l;
      n++;
      if (l < DARK_MAX_LUMA) dark++;
      if (l >= WARM_MIN_LUMA && r - b >= WARM_SPREAD && r >= g && g >= b) warm++;
    }
  }
  if (!n) throw new Error('frameMetrics region is empty');
  const percentile = (q) => {
    let acc = 0;
    const target = q * n;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  };
  return {
    mean: round(sum / n, 2),
    p10: percentile(0.1),
    p90: percentile(0.9),
    warmShare: round(warm / n, 5),
    darkShare: round(dark / n, 5),
  };
}

function round(value, digits) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/** Two captures of a settled frame agree (the reduced-motion frame is still). */
export function metricsSettled(a, b, { meanEpsilon = 0.05, shareEpsilon = 0.0002 } = {}) {
  if (!a || !b) return false;
  return Math.abs(a.mean - b.mean) <= meanEpsilon
    && a.p10 === b.p10 && a.p90 === b.p90
    && Math.abs(a.warmShare - b.warmShare) <= shareEpsilon
    && Math.abs(a.darkShare - b.darkShare) <= shareEpsilon;
}

// Default tolerances, overridable from the curve file. Per backend, a scene
// may drift from its calibrated value by `mean` luma, `percentile` on p10 and
// p90, `dark` share (absolute) and warm share by the larger of `warmAbs` and
// `warmRel` of its calibrated value. Across backends: WebGPU and WebGL2 are
// the same frame (the parity gate), so their means stay within
// `gpuPairMean`; Canvas grades on the CPU and may differ by `canvasMean`
// (calibrated 2026-10-24: Canvas reads +10.4 at storm 19:15 and +6.6 at
// clear 19:15, within 4.5 elsewhere).
export const DEFAULT_TOLERANCES = Object.freeze({
  mean: 2,
  percentile: 4,
  dark: 0.03,
  warmAbs: 0.002,
  warmRel: 0.25,
  gpuPairMean: 2,
  canvasMean: 12,
});

// Declared orderings that must hold on every backend, whatever the curve
// says: [brighter scene, darker scene, minimum mean-luma margin].
export const DECLARED_ORDER = Object.freeze([
  Object.freeze(['clear-1200', 'clear-1915', 4]),
  Object.freeze(['clear-1200', 'clear-2300', 4]),
  Object.freeze(['clear-1200', 'clear-0500', 4]),
  Object.freeze(['clear-1915', 'storm-1915', 2]),
  Object.freeze(['clear-2300', 'storm-0200', 2]),
]);

/**
 * Compare one run to the committed curve. `run` and `curve.backends` are
 * `{ [backend]: { [sceneId]: metrics } }`. A backend absent from `run` is
 * not checked (reported by the caller); a scene missing from the curve is a
 * failure (recalibrate with `--update`). Returns failure strings, empty when
 * the run passes.
 */
export function checkGoldenRun(run, curve, { scenes = GOLDEN_SCENES } = {}) {
  const failures = [];
  const tol = { ...DEFAULT_TOLERANCES, ...(curve?.tolerances || {}) };
  for (const [backend, measured] of Object.entries(run || {})) {
    const expected = curve?.backends?.[backend];
    for (const scene of scenes) {
      const m = measured?.[scene.id];
      const label = `${backend} ${scene.id}`;
      if (!m) {
        failures.push(`${label}: not measured`);
        continue;
      }
      const e = expected?.[scene.id];
      if (!e) {
        failures.push(`${label}: no calibrated value (run with --update)`);
      } else {
        const meanDelta = m.mean - e.mean;
        if (Math.abs(meanDelta) > tol.mean) failures.push(`${label}: mean luma ${m.mean} vs ${e.mean} (Δ ${round(meanDelta, 2)} > ${tol.mean})`);
        for (const key of ['p10', 'p90']) {
          if (Math.abs(m[key] - e[key]) > tol.percentile) failures.push(`${label}: ${key} ${m[key]} vs ${e[key]} (> ${tol.percentile})`);
        }
        if (Math.abs(m.darkShare - e.darkShare) > tol.dark) failures.push(`${label}: dark share ${m.darkShare} vs ${e.darkShare} (> ${tol.dark})`);
        const warmTol = Math.max(tol.warmAbs, tol.warmRel * e.warmShare);
        if (Math.abs(m.warmShare - e.warmShare) > warmTol) failures.push(`${label}: lamp-light share ${m.warmShare} vs ${e.warmShare} (> ${round(warmTol, 5)})`);
      }
    }
    for (const [bright, dim, margin] of DECLARED_ORDER) {
      const a = measured?.[bright];
      const b = measured?.[dim];
      if (a && b && a.mean - b.mean < margin) {
        failures.push(`${backend}: ${bright} (${a.mean}) must be at least ${margin} brighter than ${dim} (${b.mean})`);
      }
    }
  }
  const gpu = run?.webgpu;
  const gl = run?.webgl;
  const canvas = run?.canvas;
  for (const scene of scenes) {
    const id = scene.id;
    if (gpu?.[id] && gl?.[id] && Math.abs(gpu[id].mean - gl[id].mean) > tol.gpuPairMean) {
      failures.push(`${id}: WebGPU ${gpu[id].mean} vs WebGL2 ${gl[id].mean} (> ${tol.gpuPairMean})`);
    }
    const reference = gpu?.[id] || gl?.[id];
    if (reference && canvas?.[id] && Math.abs(reference.mean - canvas[id].mean) > tol.canvasMean) {
      failures.push(`${id}: Canvas ${canvas[id].mean} vs GPU ${reference.mean} (> ${tol.canvasMean})`);
    }
  }
  return failures;
}

/** A curve file from a measured run (the `--update` path), keeping prior tolerances and backends not re-measured. */
export function buildCurve(run, previous = null, meta = {}) {
  return {
    schema: 1,
    note: 'T5 golden hour-sweep curve: island metrics per backend and scene. Regenerate with `npm run world:golden-hours -- --update` after an intended lighting change; review the diff.',
    ...meta,
    tolerances: { ...DEFAULT_TOLERANCES, ...(previous?.tolerances || {}) },
    backends: { ...(previous?.backends || {}), ...run },
  };
}
