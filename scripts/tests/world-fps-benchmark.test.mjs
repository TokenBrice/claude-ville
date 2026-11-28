import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCIDENT_DEFAULT_PRESETS,
  INCIDENT_GATE_DEFAULTS,
  INCIDENT_PRESETS,
  buildIncidentCases,
  buildPairedArmOrder,
  caseComparisonKey,
  checkBaselineComparability,
  computeGpuDeltas,
  computeWaterDeltas,
  evaluateIncidentGates,
  formatAdapterIdentity,
  indexBaselineReport,
  isMeaningfulAdapterIdentity,
  normalizeTriStateFlag,
  parseTile,
  summarizeIncidentCase,
  summarizeIntervals,
  summarizeNoise,
  verifyEffectiveBackend,
} from '../smoke/support/incident-gate.mjs';
import {
  GPU_LAUNCH_ARGS,
  NO_GPU_LAUNCH_ARGS,
  UNLOCKED_LAUNCH_ARGS,
  benchLaunchArgs,
  buildWorldQuery,
  readWorldStateSnapshot,
} from '../smoke/support/world-bench.mjs';
import { measureIncidentWindow, parseArgs } from '../smoke/world-fps-benchmark.mjs';

test('parseArgs preserves existing matrix, soak, idle, kslope, unlocked defaults and flags', () => {
  const matrix = parseArgs(['--profile', '--counts=1,10', '--weather=clear,rain', '--max-rain-regression-pct=15']);
  assert.equal(matrix.mode, 'matrix');
  assert.equal(matrix.profile, true);
  assert.deepEqual(matrix.counts, [1, 10]);
  assert.equal(matrix.durationSeconds, 30);

  const idle = parseArgs(['--mode=idle']);
  assert.equal(idle.mode, 'idle');
  assert.deepEqual(idle.scenarios, ['no-agents', 'dense-24-agents']);
  assert.deepEqual(idle.conditions, [{ hour: 12, weather: 'clear' }]);

  const soak = parseArgs([
    '--mode=soak', '--renderer=webgpu', '--frontier=on', '--sidebar=collapsed',
    '--scenario=perf-17-agents', '--conditions=22.78:clear', '--viewport=2560x1428', '--zoom=survey',
  ]);
  assert.equal(soak.mode, 'soak');
  assert.equal(soak.frontier, 'on');
  assert.equal(soak.sidebar, 'collapsed');

  assert.throws(() => parseArgs(['--counts=1', '--pacing=active']), /does not apply/);
  assert.throws(() => parseArgs(['--mode=soak', '--baseline=foo.json']), /applies to --mode=incident only/);
  assert.throws(() => parseArgs(['--mode=incident', '--gate=baseline']), /requires --baseline/);
  assert.throws(() => parseArgs(['--mode=incident', '--zoom=1']), /expects two values/);
});

test('parseArgs and buildIncidentCases configure paired 4- and 17-agent presets and custom overrides', () => {
  const options = parseArgs(['--mode=incident', '--renderer=canvas', '--postfx=off', '--disable-gpu', '--pacing=both']);
  assert.deepEqual(options.incidentCases, [...INCIDENT_DEFAULT_PRESETS]);
  const cases = buildIncidentCases(options, options.seenFlags);
  assert.equal(cases.length, 4);

  const four = cases.find(item => item.preset === '4' && item.pacing === 'active');
  const seventeen = cases.find(item => item.preset === '17' && item.pacing === 'active');
  assert.equal(four.scenario, 'perf-4-agents');
  assert.equal(four.viewport, '2496x1404');
  assert.equal(four.hour, 23.88);
  assert.equal(four.overviewZoom, '1');
  assert.equal(four.closeZoom, '3');
  assert.equal(four.sidebar, 'collapsed');

  assert.equal(seventeen.scenario, 'perf-17-agents');
  assert.equal(seventeen.viewport, '2560x1428');
  assert.equal(seventeen.hour, 22.78);
  assert.equal(seventeen.overviewZoom, 'survey');
  assert.equal(seventeen.closeZoom, '3');

  const custom = parseArgs([
    '--mode=incident', '--renderer=webgpu', '--frontier=on', '--scenario=perf-17-agents',
    '--viewport=1440x800', '--dpr=2', '--zoom=survey,1.5', '--conditions=22.78:clear', '--tile=18,22', '--level=0',
  ]);
  const customCases = buildIncidentCases(custom, custom.seenFlags);
  assert.equal(customCases.length, 1);
  assert.deepEqual(customCases[0].tile, [18, 22]);
  assert.equal(customCases[0].closeZoom, '1.5');
  assert.equal(customCases[0].qualityOverride, 0);
  assert.notEqual(caseComparisonKey(customCases[0]), caseComparisonKey({ ...customCases[0], qualityOverride: null }));
});

test('buildWorldQuery, flag parsers, paired arm alternation, intervals and deltas work accurately', () => {
  assert.deepEqual(buildWorldQuery({ renderer: 'canvas', postfx: 'off' }), { renderer: 'canvas', postfx: '0' });
  assert.deepEqual(buildWorldQuery({ renderer: 'webgpu', frontier: 'on' }), { renderer: 'webgpu', frontier: '1' });
  assert.equal(normalizeTriStateFlag('0', '--postfx'), 'off');
  assert.deepEqual(parseTile('20,20'), [20, 20]);
});

test('benchLaunchArgs uses ordinary Chrome flags for explicit headed pure Canvas while preserving GPU and --disable-gpu flags', () => {
  // Explicit pure Canvas headed -> ordinary Chrome flags (no Vulkan/ANGLE GPU_LAUNCH_ARGS).
  assert.deepEqual(benchLaunchArgs({ headed: true, renderer: 'canvas', postfx: 'off' }), []);
  assert.deepEqual(benchLaunchArgs({ headed: true, renderer: 'canvas', postfx: '0', tag: 't1' }), ['--cv-bench-tag=t1']);

  // --disable-gpu always wins and preserves NO_GPU_LAUNCH_ARGS.
  assert.deepEqual(benchLaunchArgs({ headed: true, disableGpu: true, renderer: 'canvas', postfx: 'off' }), [...NO_GPU_LAUNCH_ARGS]);
  assert.deepEqual(benchLaunchArgs({ headed: false, disableGpu: true }), [...NO_GPU_LAUNCH_ARGS]);

  // Hybrid Canvas, resident GPU, headless pure Canvas, and default auto keep GPU_LAUNCH_ARGS.
  assert.deepEqual(benchLaunchArgs({ headed: true, renderer: 'canvas', postfx: 'default' }), [...GPU_LAUNCH_ARGS]);
  assert.deepEqual(benchLaunchArgs({ headed: true, renderer: 'webgpu', postfx: 'default' }), [...GPU_LAUNCH_ARGS]);
  assert.deepEqual(benchLaunchArgs({ headed: false, renderer: 'canvas', postfx: 'off' }), [...GPU_LAUNCH_ARGS]);
  assert.deepEqual(benchLaunchArgs({ headed: true, unlocked: true }), [...GPU_LAUNCH_ARGS, ...UNLOCKED_LAUNCH_ARGS]);
});

test('paired arm alternation, intervals and deltas work accurately', () => {

  assert.deepEqual(buildPairedArmOrder(1).map(i => i.arm), ['overview', 'close', 'overview-return']);
  assert.deepEqual(buildPairedArmOrder(2).map(i => i.arm), ['close', 'overview', 'close-return']);

  const stats = summarizeIntervals(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(stats.p50Ms, 51);
  assert.equal(stats.p95Ms, 96);
  assert.equal(stats.p99Ms, 100);
  assert.equal(stats.over33_5Ms, 67);

  const gpuDeltas = computeGpuDeltas(
    { frames: 10, skippedFrames: 2, uploads: 100, uploadBytes: 1000, textureEvictions: 5, uploadBytesByKind: { atlas: 400 } },
    { frames: 55, skippedFrames: 5, uploads: 140, uploadBytes: 3500, textureEvictions: 25, uploadBytesByKind: { atlas: 1400, water: 500 } },
  );
  assert.deepEqual(gpuDeltas.uploadBytesByKind, { atlas: 1000, water: 500 });
  assert.equal(gpuDeltas.textureEvictions, 20);

  const water = computeWaterDeltas({ overlayBuilds: 10, capBuilds: 20 }, { overlayBuilds: 42, capBuilds: 55 });
  assert.equal(water.overlayBuildsDelta, 32);
  assert.equal(water.capBuildsDelta, 35);
});

test('Frontier readiness tracks configured passes, including late pipeline compilation', async t => {
  const passes = { mirror: { ready: true }, wind: { ready: false }, gi: { ready: false } };
  const gpuWorld = {
    frontierConfig: { mirror: true, wind: true, gi: false },
    getDiagnostics: () => ({ frontier: { enabled: true, featureMask: 1, passes } }),
  };
  const browser = { __claudeVilleApp: { renderer: { gpuWorld } } };
  const page = { evaluate: fn => fn() };
  const previous = { window: globalThis.window, document: globalThis.document };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  globalThis.window = browser;
  globalThis.document = { getElementById: () => null };
  const pending = (await readWorldStateSnapshot(page)).frontier;
  assert.deepEqual(pending.pendingPasses, ['wind']);
  assert.equal(pending.allReady, false);
  passes.wind.ready = true;
  assert.equal((await readWorldStateSnapshot(page)).frontier.allReady, true);
});

test('verifyEffectiveBackend catches hybrid PostFx, mid-run backend switches and missing Frontier mask', () => {
  const pureOk = verifyEffectiveBackend({
    requestedRenderer: 'canvas', requestedPostfx: 'off', disableGpu: true,
    afterWarmup: { backend: 'canvas', gpuWorldActive: false, postFx: { active: false }, frontier: { enabled: false, featureMask: 0 } },
    atEnd: { backend: 'canvas', gpuWorldActive: false, postFx: { active: false }, frontier: { enabled: false, featureMask: 0 } },
    perFrameBackends: { canvas: 120 },
    renderSegments: [{ label: 'atmosphere-lights', p50: 95 }],
  });
  assert.equal(pureOk.ok, true);
  assert.equal(pureOk.pureCanvasConfirmed, true);

  const hybridBad = verifyEffectiveBackend({
    requestedRenderer: 'canvas', requestedPostfx: 'off',
    afterWarmup: { backend: 'canvas', gpuWorldActive: false, postFx: { active: true } },
    atEnd: { backend: 'canvas', gpuWorldActive: false, postFx: { active: true } },
    perFrameBackends: { canvas: 90 },
    renderSegments: [{ label: 'postfx', p50: 88 }],
  });
  assert.equal(hybridBad.ok, false);
  assert.ok(hybridBad.issues.some(m => m.includes('hybrid PostFx')));
  const hybridFallback = verifyEffectiveBackend({
    requestedRenderer: 'canvas', requestedPostfx: 'on',
    atEnd: { backend: 'canvas', postFx: { active: true } },
    perFrameBackends: { canvas: 90 }, hybridPaints: 80,
  });
  assert.ok(hybridFallback.issues.some(m => m.includes('switched between')));

  // Zero-paint hybrid must not falsely report a hybrid/pure-Canvas switch
  // when perFrameBackends.canvas is undefined.
  const zeroPaintHybrid = verifyEffectiveBackend({
    requestedRenderer: 'canvas', requestedPostfx: 'default',
    afterWarmup: { backend: 'canvas', postFx: { active: true } },
    atEnd: { backend: 'canvas', postFx: { active: true } },
    perFrameBackends: {}, hybridPaints: 0,
  });
  assert.equal(zeroPaintHybrid.issues.some(m => m.includes('switched between')), false);
  const zeroPaintRequestedHybrid = verifyEffectiveBackend({
    requestedRenderer: 'canvas', requestedPostfx: 'on',
    afterWarmup: { backend: 'canvas', postFx: { active: true } },
    atEnd: { backend: 'canvas', postFx: { active: true } },
    perFrameBackends: {}, hybridPaints: 0,
  });
  assert.equal(zeroPaintRequestedHybrid.issues.some(m => m.includes('switched between')), false);
  assert.ok(zeroPaintRequestedHybrid.issues.some(m => m.includes('no hybrid frame was presented')));

  const switchBad = verifyEffectiveBackend({
    requestedRenderer: 'webgpu', requestedFrontier: 'on',
    afterWarmup: { backend: 'webgl', gpuWorldActive: true, postFx: { active: false }, frontier: { enabled: false, featureMask: 0 } },
    atEnd: { backend: 'webgpu', gpuWorldActive: true, postFx: { active: false }, frontier: { enabled: true, featureMask: 0 } },
    perFrameBackends: { webgl: 12, webgpu: 88 },
    renderSegments: [{ label: 'gpu-world', p50: 6 }],
  });
  assert.equal(switchBad.ok, false);
  assert.ok(switchBad.issues.some(m => m.includes('changed during run')));
  assert.ok(switchBad.issues.some(m => m.includes('featureMask was 0')));
  const ready = { backend: 'webgpu', frontier: { enabled: true, allReady: true, featureMask: 31 } };
  assert.equal(verifyEffectiveBackend({
    requestedFrontier: 'on', afterWarmup: ready, atEnd: ready, frontierMasks: [31, 15, 31],
  }).ok, false);

});

function makeSyntheticRun({
  preset = '4',
  pacing = 'active',
  repetition = 1,
  overviewFps = 54,
  overviewP95 = 24,
  closeFps = 58,
  closeP95 = 18,
  ambientShare = 0,
  ambientFramePacing = true,
  backend = 'canvas',
  pureCanvas = true,
  postFxActive = false,
  frontierEnabled = false,
  frontierMask = 0,
  backing = [2448, 1356],
  effectiveDpr = 1,
  sidebarCollapsed = true,
  tile = [20, 20],
  cameraMode = 'fixed',
  cameraCenter = [0, 640],
  overviewZoom = 1,
  closeZoom = 3,
  qualityLevel = null,
  errors = [],
} = {}) {
  const presetSpec = INCIDENT_PRESETS[preset];
  const makeArm = (arm, role, phase, primary, fps, p95) => ({
    arm, role, phase, primary,
    paintsPerSec: fps,
    paintIntervalsMs: { p50Ms: Number((1000 / fps).toFixed(2)), p95Ms: p95, p99Ms: p95 + 4, maxMs: p95 + 8, worstStallsMs: [p95 + 8] },
    raf: { fps: 60 },
    admittedUpdates: { fps, ambientShare },
    gpuSubmissions: { submittedFps: backend === 'canvas' ? 0 : fps, reusedFps: 0 },
    cpuMs: { update: { p50Ms: 0.8 }, render: { p50Ms: 9.5 }, total: { p50Ms: 10.3, p95Ms: 14.2 } },
    gpuDeltas: { textureEvictions: 0, uploadBytes: 0 },
    gpuEnd: { gpuMs: null, gpuTimingState: 'not-applicable', records: null, batches: null, lightAdmission: null },
    droppedFrames: { failedFrames: 0, missedDisplayIntervals: 0 },
    quality: { level: qualityLevel },
    perFrameQualityLevels: qualityLevel === null ? {} : { [qualityLevel]: 50 },
    camera: {
      resolvedZoomStart: role === 'overview' ? overviewZoom : closeZoom,
      resolvedZoomEnd: role === 'overview' ? overviewZoom : closeZoom,
      endPose: { x: 1224, y: 38, center: { x: cameraCenter[0], y: cameraCenter[1] } },
    },
    renderSegments: pureCanvas ? [{ label: 'atmosphere-lights', p50: 5 }, { label: 'water-highlights', p50: 3 }] : [{ label: 'gpu-world', p50: 4 }],
  });
  return {
    preset,
    label: presetSpec.label,
    scenario: presetSpec.scenario,
    viewport: `${presetSpec.viewport.width}x${presetSpec.viewport.height}`,
    dpr: presetSpec.dpr,
    hour: presetSpec.hour,
    weather: presetSpec.weather,
    sidebar: presetSpec.sidebar,
    cameraMode,
    tile,
    pacing,
    overviewZoom: presetSpec.overviewZoom,
    closeZoom: presetSpec.closeZoom,
    requestedRenderer: backend,
    headed: true,
    browserVersion: 'example-chromium',
    launchArgs: [],
    attribution: false,
    requestedPostfx: pureCanvas ? 'off' : 'default',
    requestedFrontier: frontierEnabled ? 'on' : 'default',
    disableGpu: pureCanvas,
    repetition,
    afterWarmup: {
      backend,
      viewport: { backing, visibleCanvasPixels: backing[0] * backing[1], effectiveDpr, sidebarCollapsed },
      pacing: { ambientFramePacing },
    },
    backendCheck: {
      ok: true,
      effectiveBackend: backend,
      backendsObserved: [backend],
      backendStable: true,
      postFxActive,
      pureCanvasRequested: pureCanvas,
      pureCanvasConfirmed: pureCanvas,
      frontierEnabled,
      frontierFeatureMask: frontierMask,
      issues: [],
    },
    transitions: [],
    arms: [
      makeArm('overview', 'overview', 'first-zoom-out', true, overviewFps, overviewP95),
      makeArm('close', 'close', 'primary', true, closeFps, closeP95),
      makeArm('overview-return', 'overview', 'return', false, overviewFps - 0.5, overviewP95 + 0.5),
    ],
    errors,
  };
}

test('absolute and baseline gates enforce active targets, close retention, noise floor and strict comparability', () => {
  const baseline = summarizeIncidentCase([
    makeSyntheticRun({ repetition: 1, overviewFps: 5.0, overviewP95: 220, closeFps: 58.0, closeP95: 18 }),
    makeSyntheticRun({ repetition: 2, overviewFps: 4.6, overviewP95: 230, closeFps: 57.6, closeP95: 18.5 }),
    makeSyntheticRun({ repetition: 3, overviewFps: 4.8, overviewP95: 225, closeFps: 58.4, closeP95: 17.8 }),
  ]);
  assert.equal(evaluateIncidentGates(baseline, { gateMode: 'none' }).passed, true);
  assert.equal(evaluateIncidentGates(baseline, { gateMode: 'auto' }).passed, false);

  const candidatePass = summarizeIncidentCase([
    makeSyntheticRun({ repetition: 1, overviewFps: 52.5, overviewP95: 28.0, closeFps: 56.0, closeP95: 19.0 }),
    makeSyntheticRun({ repetition: 2, overviewFps: 53.0, overviewP95: 27.5, closeFps: 56.2, closeP95: 18.8 }),
  ]);
  const index = indexBaselineReport({ summary: { cases: [baseline] } });
  const matched = index.get(caseComparisonKey(candidatePass));
  const passEval = evaluateIncidentGates(candidatePass, {
    thresholds: INCIDENT_GATE_DEFAULTS, baselineCase: matched, baselineExpected: true, gateMode: 'auto',
  });
  assert.equal(passEval.passed, true);
  assert.equal(passEval.baseline.comparable, true);
  assert.equal(passEval.baseline.observed.exceedsBaselineNoise, true);

  // Close throughput regression fails baseline gate even when overview passes absolute targets.
  const closeRegressed = summarizeIncidentCase([
    makeSyntheticRun({ repetition: 1, overviewFps: 55.0, overviewP95: 25.0, closeFps: 52.0, closeP95: 21.0 }),
  ]);
  const regEval = evaluateIncidentGates(closeRegressed, { baselineCase: matched, baselineExpected: true, gateMode: 'auto' });
  assert.equal(regEval.passed, false);
  assert.equal(regEval.baseline.checks.closeThroughputRetained, false);

  // Comparability mismatches (backend, backing, sidebar, camera center/zoom, render quality) MUST fail baseline gate.
  const wrongBacking = summarizeIncidentCase([makeSyntheticRun({ backing: [2512, 1380], overviewFps: 55, closeFps: 58 })]);
  const wrongSidebar = summarizeIncidentCase([makeSyntheticRun({ sidebarCollapsed: false, overviewFps: 55, closeFps: 58 })]);
  const wrongCamera = summarizeIncidentCase([makeSyntheticRun({ cameraCenter: [40, 640], overviewZoom: 2, overviewFps: 55, closeFps: 58 })]);
  const wrongQuality = summarizeIncidentCase([makeSyntheticRun({ qualityLevel: 1, overviewFps: 55, closeFps: 58 })]);
  const wrongBackend = summarizeIncidentCase([makeSyntheticRun({ backend: 'webgpu', pureCanvas: false, frontierEnabled: true, frontierMask: 31, qualityLevel: 0, overviewFps: 55, closeFps: 58 })]);

  for (const [label, cand, expectedText] of [
    ['backing', wrongBacking, 'backing mismatch'],
    ['sidebar', wrongSidebar, 'sidebarCollapsed mismatch'],
    ['camera', wrongCamera, 'cameraCenter mismatch'],
    ['quality', wrongQuality, 'qualityLevel mismatch'],
    ['window mode', { ...candidatePass, headed: false }, 'headed mismatch'],
    ['launch flags', { ...candidatePass, launchArgs: ['--use-angle=vulkan'] }, 'browser launch arguments'],
    ['unknown launch flags', { ...candidatePass, launchArgs: undefined }, 'browser launch arguments'],
    ['browser', { ...candidatePass, browserVersion: 'other-version' }, 'browserVersion mismatch'],
    ['profiling', { ...candidatePass, attribution: true }, 'attribution mismatch'],
    ['backend', wrongBackend, 'effective backend mismatch'],
  ]) {
    const comp = checkBaselineComparability(cand, matched);
    assert.equal(comp.comparable, false, `${label} should fail comparability`);
    assert.ok(comp.mismatches.some(m => m.includes(expectedText)), `${label} mismatch should cite ${expectedText}`);
    const gated = evaluateIncidentGates(cand, { baselineCase: matched, baselineExpected: true, gateMode: 'baseline' });
    assert.equal(gated.passed, false, `${label} must fail baseline gate`);
  }

  // Single-rep baseline leaves noise comparison null.
  const singleRepBase = summarizeIncidentCase([makeSyntheticRun({ repetition: 1, overviewFps: 50, closeFps: 58 })]);
  const singleEval = evaluateIncidentGates(candidatePass, { baselineCase: singleRepBase, baselineExpected: true, gateMode: 'auto' });
  assert.equal(singleEval.baseline.observed.exceedsBaselineNoise, null);
  assert.equal(summarizeNoise([10, 12, 14]).spread, 4);
});

test('the director holding both arms at the same zoom cannot pass an incident gate', () => {
  const run = makeSyntheticRun({ cameraMode: 'auto', overviewZoom: 2, closeZoom: 2 });
  const gates = evaluateIncidentGates(summarizeIncidentCase([run]));
  assert.equal(gates.passed, false);
  assert.ok(gates.violations.some(reason => reason.includes('distinct settled zooms')));
});

test('ambient gate rejects unactivated cadence, stalled paints and >31 fps while passing healthy 30 Hz ambient', () => {
  // Healthy 30 Hz ambient passes.
  const healthyAmbient = summarizeIncidentCase([
    makeSyntheticRun({ pacing: 'ambient', overviewFps: 30.0, overviewP95: 35.0, closeFps: 30.1, closeP95: 34.5, ambientShare: 0.98 }),
  ]);
  assert.equal(evaluateIncidentGates(healthyAmbient, { gateMode: 'absolute' }).passed, true);

  // Stalled pure Canvas (4.2 FPS, 271 ms p95) MUST NOT falsely pass ambient even if ambientShare is high!
  const stalledAmbient = summarizeIncidentCase([
    makeSyntheticRun({ pacing: 'ambient', overviewFps: 4.2, overviewP95: 271.4, closeFps: 8.9, closeP95: 129.1, ambientShare: 0.95 }),
  ]);
  const stalledEval = evaluateIncidentGates(stalledAmbient, { gateMode: 'absolute' });
  assert.equal(stalledEval.passed, false);
  assert.equal(stalledEval.absolute.checks.ambientNotStalled, false);
  assert.ok(stalledEval.violations.some(v => v.includes('ambient paints stalled')));

  // Ambient cadence never activated (ambientShare 0.1) MUST NOT falsely pass even at 30 FPS!
  const unactivatedAmbient = summarizeIncidentCase([
    makeSyntheticRun({ pacing: 'ambient', overviewFps: 30.0, overviewP95: 34.0, closeFps: 30.0, closeP95: 34.0, ambientShare: 0.1 }),
  ]);
  const unactivatedEval = evaluateIncidentGates(unactivatedAmbient, { gateMode: 'absolute' });
  assert.equal(unactivatedEval.passed, false);
  assert.equal(unactivatedEval.absolute.checks.ambientCadenceActivated, false);
  assert.ok(unactivatedEval.violations.some(v => v.includes('ambient cadence did not activate')));

  // Unthrottled >31 FPS ambient fails cap.
  const uncappedAmbient = summarizeIncidentCase([
    makeSyntheticRun({ pacing: 'ambient', overviewFps: 45.0, overviewP95: 24.0, closeFps: 30.0, closeP95: 34.0, ambientShare: 0.95 }),
  ]);
  const uncappedEval = evaluateIncidentGates(uncappedAmbient, { gateMode: 'absolute' });
  assert.equal(uncappedEval.passed, false);
  assert.equal(uncappedEval.absolute.checks.ambientWithinCap, false);
});

test('adapter identity and comparability require explicit adapters arrays and meaningful GPU identities', () => {
  assert.equal(formatAdapterIdentity({ gpuAdapter: { vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false } }), null);
  assert.equal(formatAdapterIdentity({ gpuAdapter: {} }), null);
  assert.equal(formatAdapterIdentity({ glRenderer: '   ' }), null);
  assert.equal(formatAdapterIdentity({ glRenderer: 'unknown' }), null);
  assert.equal(isMeaningfulAdapterIdentity('{}'), false);
  assert.equal(isMeaningfulAdapterIdentity('{"vendor":"","architecture":"","device":"","description":"","isFallbackAdapter":false}'), false);
  assert.equal(isMeaningfulAdapterIdentity('ANGLE (NVIDIA, Vulkan)'), true);

  const realAdapter = { vendor: 'nvidia', architecture: 'blackwell', device: '', description: 'RTX 5070 Ti', isFallbackAdapter: false };
  const formatted = formatAdapterIdentity({ gpuAdapter: realAdapter });
  assert.ok(formatted && isMeaningfulAdapterIdentity(formatted));

  const pureCanvasBase = summarizeIncidentCase([makeSyntheticRun({ repetition: 1 })]);
  assert.deepEqual(pureCanvasBase.adapters, []);

  // Missing adapters array fails comparability even for pure Canvas.
  const missingAdapters = { ...pureCanvasBase };
  delete missingAdapters.adapters;
  const missingComp = checkBaselineComparability(pureCanvasBase, missingAdapters);
  assert.equal(missingComp.comparable, false);
  assert.ok(missingComp.mismatches.some(m => m.includes('explicit adapters arrays')));

  // GPU/hybrid runs with empty or meaningless adapters fail comparability.
  const webgpuBase = {
    ...pureCanvasBase,
    effectiveBackends: ['webgpu'],
    pureCanvasConfirmed: false,
    adapters: [formatted],
  };
  const webgpuMatching = { ...webgpuBase, adapters: [formatted] };
  assert.equal(checkBaselineComparability(webgpuMatching, webgpuBase).comparable, true);

  const webgpuEmptyAdapters = { ...webgpuBase, adapters: [] };
  const emptyComp = checkBaselineComparability(webgpuEmptyAdapters, webgpuBase);
  assert.equal(emptyComp.comparable, false);
  assert.ok(emptyComp.mismatches.some(m => m.includes('non-empty meaningful GPU adapter')));

  const webgpuMeaningless = {
    ...webgpuBase,
    adapters: ['{"vendor":"","architecture":"","device":"","description":"","isFallbackAdapter":false}'],
  };
  const meaninglessComp = checkBaselineComparability(webgpuMeaningless, webgpuBase);
  assert.equal(meaninglessComp.comparable, false);
  assert.ok(meaninglessComp.mismatches.some(m => m.includes('meaningful')));

  // Summarize filters out uninformative WebGPU adapter objects to [].
  const runWithEmptyGpuAdapter = makeSyntheticRun({ backend: 'webgpu', pureCanvas: false });
  runWithEmptyGpuAdapter.afterWarmup.gpuWorldActive = true;
  runWithEmptyGpuAdapter.afterWarmup.gpuAdapter = { vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false };
  assert.deepEqual(summarizeIncidentCase([runWithEmptyGpuAdapter]).adapters, []);
});

test('measureIncidentWindow captures synchronous start/end snapshots inside one evaluate and restores property descriptors', async t => {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  class FakeRenderer {
    constructor() {
      this.worldRendererMode = 'webgpu';
      this._postFxCanvasVisible = true;
      this.presentGeneration = 10;
      this._gpuFrames = 100;
      this._waterOverlayBuilds = 5;
      this._framePacing = { ambient: false };
      this._canvasWater = { stats: { overlayBuilds: 5, capBuilds: 2 } };
      this.gpuWorld = {
        frontierEnabled: true,
        _frontierMask: 31,
        passSamplingEnabled: false,
        setPassSamplingEnabled(v) { this.passSamplingEnabled = v; },
        isActive: () => true,
        qualityLadder: { getLevel: () => 0 },
        getDiagnostics: () => ({
          active: true,
          frames: this._gpuFrames,
          skippedFrames: 0,
          uploads: 20,
          uploadBytes: 4096,
          textureEvictions: 1,
          qualityLevel: 0,
          frontier: { enabled: true, featureMask: 31, passes: {} },
        }),
      };
      this.camera = {
        zoom: 1,
        x: 0,
        y: 0,
        _viewportWidth: () => 1440,
        _viewportHeight: () => 800,
        screenToWorld: () => ({ x: 100, y: 200 }),
      };
      this.canvas = { width: 1440, height: 800, clientWidth: 1440, clientHeight: 800 };
    }
    _ambientTick() { return true; }
    _update() {}
    _render() {
      this._gpuFrames += 1;
      this._canvasWater.stats.overlayBuilds += 1;
      return true;
    }
    _loop() {
      this._update(16);
      this._render(16);
      this.presentGeneration += 1;
    }
  }

  const renderer = new FakeRenderer();
  // Define custom own descriptors on _update and _ambientTick to verify exact
  // descriptor restoration (not deletion) while prototype _loop/_render delete back to prototype.
  const customUpdate = function ownUpdate(...args) { return FakeRenderer.prototype._update.apply(this, args); };
  const customAmbient = () => true;
  Object.defineProperty(renderer, '_update', { value: customUpdate, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(renderer, '_ambientTick', { value: customAmbient, writable: false, enumerable: true, configurable: true });
  const origUpdateDesc = Object.getOwnPropertyDescriptor(renderer, '_update');
  const origAmbientDesc = Object.getOwnPropertyDescriptor(renderer, '_ambientTick');

  globalThis.window = {
    innerWidth: 1440,
    innerHeight: 800,
    devicePixelRatio: 1,
    __claudeVilleApp: { renderer },
  };
  globalThis.document = { getElementById: () => null };

  let rafStep = 0;
  t.mock.method(performance, 'now', () => rafStep * 16);
  globalThis.requestAnimationFrame = (cb) => {
    rafStep += 1;
    // Simulate renderer loop firing on each frame BEFORE the benchmark tick,
    // plus one extra frame AFTER the window resolves (must not skew deltas).
    const timestamp = performance.now();
    renderer._loop(timestamp);
    queueMicrotask(() => cb(timestamp));
    return rafStep;
  };

  let evaluateCalls = 0;
  const page = {
    evaluate: (fn, arg) => {
      evaluateCalls += 1;
      return fn(arg);
    },
  };

  const result = await measureIncidentWindow(page, {
    durationMs: 30,
    pacing: 'active',
    attribution: false,
    shotState: 'settled',
    spec: { tile: [20, 20] },
  });

  // Extra frame after window end must not affect captured deltas.
  renderer._loop(performance.now() + 500);

  assert.equal(evaluateCalls, 1, 'start and end snapshots must be captured inside the single measured evaluate call');
  assert.equal(result.successfulPaints, 2);
  assert.equal(result.gpuSubmissions.submitted, 2);
  assert.equal(result.water.overlayBuildsDelta, 2);
  assert.deepEqual(result.perFrameFrontierMasks, { 31: 2 });

  // Prior own descriptors restored identically; prototype methods have no lingering own overrides.
  assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, '_update'), origUpdateDesc);
  assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, '_ambientTick'), origAmbientDesc);
  assert.equal(Object.prototype.hasOwnProperty.call(renderer, '_loop'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(renderer, '_render'), false);
  assert.equal(renderer._loop, FakeRenderer.prototype._loop);
  assert.equal(renderer._render, FakeRenderer.prototype._render);
});
