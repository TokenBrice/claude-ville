// Pure-Node measurement-contract helpers for `world-fps-benchmark.mjs --mode=incident`.
// Imported helper; not directly executable.

export const INCIDENT_PRESETS = Object.freeze({
  '4': Object.freeze({
    preset: '4',
    label: 'four-agent-canvas',
    scenario: 'perf-4-agents',
    viewport: Object.freeze({ width: 2496, height: 1404 }),
    dpr: 1,
    overviewZoom: '1',
    closeZoom: '3',
    hour: 23.88,
    weather: 'clear',
    sidebar: 'collapsed',
    tile: Object.freeze([20, 20]),
  }),
  '17': Object.freeze({
    preset: '17',
    label: 'seventeen-agent-night',
    scenario: 'perf-17-agents',
    viewport: Object.freeze({ width: 2560, height: 1428 }),
    dpr: 1,
    overviewZoom: 'survey',
    closeZoom: '3',
    hour: 22.78,
    weather: 'clear',
    sidebar: 'collapsed',
    tile: Object.freeze([20, 20]),
  }),
});

export const INCIDENT_DEFAULT_PRESETS = Object.freeze(['4', '17']);

export const INCIDENT_GATE_DEFAULTS = Object.freeze({
  minOverviewPaintsPerSec: 50,
  maxOverviewP95Ms: 33.5,
  minCloseBaselineRatio: 0.95,
  minAmbientPaintsPerSec: 25,
  maxAmbientPaintsPerSec: 31,
  maxAmbientP95Ms: 45,
  minAmbientShare: 0.8,
});

const quantile = (values, p) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
};
const median = (values) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
const samePair = (a, b, tol = 0) => Array.isArray(a) && Array.isArray(b)
  && a.length === 2 && b.length === 2
  && Math.abs(Number(a[0]) - Number(b[0])) <= tol
  && Math.abs(Number(a[1]) - Number(b[1])) <= tol;

const UNIDENTIFIED_ADAPTER_STRINGS = new Set(['', 'unknown', 'n/a', 'none', 'null', 'undefined', '{}']);

/**
 * Extract a meaningful, canonical GPU adapter identity string from a runtime
 * snapshot (`glRenderer` or `gpuAdapter`), or `null` when absent/uninformative.
 */
export function formatAdapterIdentity(snapshot) {
  if (!snapshot) return null;
  if (typeof snapshot.glRenderer === 'string') {
    const trimmed = snapshot.glRenderer.trim();
    if (trimmed && !UNIDENTIFIED_ADAPTER_STRINGS.has(trimmed.toLowerCase())) return trimmed;
  }
  const adapter = snapshot.gpuAdapter;
  if (typeof adapter === 'string') {
    const trimmed = adapter.trim();
    return trimmed && !UNIDENTIFIED_ADAPTER_STRINGS.has(trimmed.toLowerCase()) ? trimmed : null;
  }
  if (adapter && typeof adapter === 'object') {
    const vendor = typeof adapter.vendor === 'string' ? adapter.vendor.trim() : '';
    const architecture = typeof adapter.architecture === 'string' ? adapter.architecture.trim() : '';
    const device = typeof adapter.device === 'string' ? adapter.device.trim() : '';
    const description = typeof adapter.description === 'string' ? adapter.description.trim() : '';
    if (!vendor && !architecture && !device && !description) return null;
    return JSON.stringify({
      vendor,
      architecture,
      device,
      description,
      isFallbackAdapter: Boolean(adapter.isFallbackAdapter),
    });
  }
  return null;
}

/** True when a serialized adapter entry carries meaningful identifying data. */
export function isMeaningfulAdapterIdentity(entry) {
  if (typeof entry !== 'string') return false;
  const trimmed = entry.trim();
  if (!trimmed || UNIDENTIFIED_ADAPTER_STRINGS.has(trimmed.toLowerCase())) return false;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return formatAdapterIdentity({ gpuAdapter: JSON.parse(trimmed) }) !== null;
    } catch {
      return false;
    }
  }
  return true;
}

export function normalizeTriStateFlag(value, flagName) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'default' || text === 'auto') return 'default';
  if (text === 'on' || text === '1' || text === 'true') return 'on';
  if (text === 'off' || text === '0' || text === 'false') return 'off';
  throw new Error(`${flagName} must be default, on or off (received ${value})`);
}

export function parseTile(value) {
  const parts = String(value ?? '').split(',').map(item => Number(item.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    throw new Error(`tile must be X,Y numbers, received ${value}`);
  }
  return [parts[0], parts[1]];
}

export function buildIncidentCases(options, seen = new Set()) {
  const pacingModes = options.pacing === 'both' ? ['active', 'ambient'] : [options.pacing];
  const baseCases = [];

  if (!seen.has('--scenario')) {
    const presets = options.incidentCases?.length ? options.incidentCases : INCIDENT_DEFAULT_PRESETS;
    for (const id of presets) {
      const preset = INCIDENT_PRESETS[id];
      if (!preset) throw new Error(`incident case must be 4 or 17, received ${id}`);
      const viewports = seen.has('--viewport') ? options.viewports : [preset.viewport];
      const conditions = seen.has('--conditions') ? options.conditions : [{ hour: preset.hour, weather: preset.weather }];
      for (const vp of viewports) {
        for (const cond of conditions) {
          baseCases.push({
            preset: preset.preset,
            label: preset.label,
            scenario: preset.scenario,
            viewport: `${vp.width}x${vp.height}`,
            width: vp.width,
            height: vp.height,
            dpr: seen.has('--dpr') ? options.dpr : preset.dpr,
            overviewZoom: seen.has('--zoom') ? options.zooms[0] : preset.overviewZoom,
            closeZoom: seen.has('--zoom') ? (options.zooms[1] ?? '3') : preset.closeZoom,
            hour: cond.hour,
            weather: cond.weather,
            sidebar: seen.has('--sidebar') ? options.sidebar : preset.sidebar,
            tile: seen.has('--tile') ? [...options.tile] : [...preset.tile],
            cameraMode: options.cameraMode || 'fixed',
            renderer: options.renderer ?? null,
            postfx: options.postfx || 'default',
            frontier: options.frontier || 'default',
            disableGpu: options.disableGpu === true,
          });
        }
      }
    }
  } else {
    const overviewZoom = seen.has('--zoom') ? options.zooms[0] : 'survey';
    const closeZoom = seen.has('--zoom') ? (options.zooms[1] ?? '3') : '3';
    for (const scenario of options.scenarios) {
      for (const vp of options.viewports) {
        for (const cond of options.conditions) {
          baseCases.push({
            preset: null,
            label: scenario,
            scenario,
            viewport: `${vp.width}x${vp.height}`,
            width: vp.width,
            height: vp.height,
            dpr: options.dpr,
            overviewZoom,
            closeZoom,
            hour: cond.hour,
            weather: cond.weather,
            sidebar: seen.has('--sidebar') ? options.sidebar : 'collapsed',
            tile: seen.has('--tile') ? [...options.tile] : [20, 20],
            cameraMode: options.cameraMode || 'fixed',
            renderer: options.renderer ?? null,
            postfx: options.postfx || 'default',
            frontier: options.frontier || 'default',
            disableGpu: options.disableGpu === true,
          });
        }
      }
    }
  }

  const qualityOverride = seen.has('--level') ? options.level : null;
  return baseCases.flatMap(spec => pacingModes.map(pacing => ({ ...spec, pacing, qualityOverride })));
}

export function buildPairedArmOrder(repetition) {
  return repetition % 2 === 0
    ? [
      { arm: 'close', role: 'close', phase: 'primary', primary: true },
      { arm: 'overview', role: 'overview', phase: 'first-zoom-out', primary: true },
      { arm: 'close-return', role: 'close', phase: 'return', primary: false },
    ]
    : [
      { arm: 'overview', role: 'overview', phase: 'first-zoom-out', primary: true },
      { arm: 'close', role: 'close', phase: 'primary', primary: true },
      { arm: 'overview-return', role: 'overview', phase: 'return', primary: false },
    ];
}

export function summarizeIntervals(intervalsMs, { stallThresholdMs = 33.5, longThresholdMs = 50, topStalls = 5 } = {}) {
  const sorted = (intervalsMs || []).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) {
    return {
      count: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null,
      over33_5Ms: 0, over33_5MsShare: null, over50Ms: 0, over50MsShare: null, worstStallsMs: [],
    };
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const over33_5 = sorted.filter(v => v > stallThresholdMs).length;
  const over50 = sorted.filter(v => v > longThresholdMs).length;
  return {
    count: sorted.length,
    meanMs: round(sum / sorted.length),
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    over33_5Ms: over33_5,
    over33_5MsShare: round(over33_5 / sorted.length, 4),
    over50Ms: over50,
    over50MsShare: round(over50 / sorted.length, 4),
    worstStallsMs: sorted.slice(-topStalls).reverse().map(v => round(v)),
  };
}

export function computeGpuDeltas(startGpu, endGpu) {
  const delta = k => (Number.isFinite(startGpu?.[k]) && Number.isFinite(endGpu?.[k]) ? Math.max(0, endGpu[k] - startGpu[k]) : null);
  let uploadBytesByKind = null;
  if (endGpu?.uploadBytesByKind && typeof endGpu.uploadBytesByKind === 'object') {
    uploadBytesByKind = {};
    const keys = new Set([...Object.keys(startGpu?.uploadBytesByKind || {}), ...Object.keys(endGpu.uploadBytesByKind)]);
    for (const k of [...keys].sort()) {
      uploadBytesByKind[k] = Math.max(0, (Number(endGpu.uploadBytesByKind[k]) || 0) - (Number(startGpu?.uploadBytesByKind?.[k]) || 0));
    }
  }
  return {
    frames: delta('frames'),
    skippedFrames: delta('skippedFrames'),
    uploads: delta('uploads'),
    uploadBytes: delta('uploadBytes'),
    uploadBytesByKind,
    textureEvictions: delta('textureEvictions'),
  };
}

export function computeWaterDeltas(startWater, endWater) {
  if (!endWater) return null;
  const diff = k => (Number.isFinite(startWater?.[k]) && Number.isFinite(endWater?.[k]) ? Math.max(0, endWater[k] - startWater[k]) : null);
  return { overlayBuildsDelta: diff('overlayBuilds'), capBuildsDelta: diff('capBuilds'), end: { ...endWater } };
}

export function verifyEffectiveBackend({
  requestedRenderer = null,
  requestedPostfx = 'default',
  requestedFrontier = 'default',
  disableGpu = false,
  afterWarmup = null,
  atEnd = null,
  perFrameBackends = {},
  hybridPaints = null,
  frontierMasks = [],
  renderSegments = [],
} = {}) {
  const observedSet = new Set();
  if (afterWarmup?.backend) observedSet.add(afterWarmup.backend);
  if (atEnd?.backend) observedSet.add(atEnd.backend);
  for (const [name, count] of Object.entries(perFrameBackends || {})) if (count > 0 && name) observedSet.add(name);
  const backendsObserved = [...observedSet];
  const backendStable = backendsObserved.length === 1;
  const effectiveBackend = atEnd?.backend ?? afterWarmup?.backend ?? backendsObserved[0] ?? null;

  const postFxActive = atEnd?.postFx?.active === true || afterWarmup?.postFx?.active === true;
  const gpuWorldActive = atEnd?.gpuWorldActive === true || afterWarmup?.gpuWorldActive === true;
  const labels = (renderSegments || []).map(s => s?.label).filter(Boolean);
  const hasAtmosphereLightsStage = labels.includes('atmosphere-lights');
  const hasPostFxStage = labels.includes('postfx');

  const pureCanvasRequested = disableGpu === true || requestedPostfx === 'off';
  const pureCanvasConfirmed = effectiveBackend === 'canvas'
    && !gpuWorldActive && !postFxActive && !hasPostFxStage && hasAtmosphereLightsStage;

  const frontierEnabled = atEnd?.frontier?.enabled === true;
  const frontierFeatureMask = atEnd?.frontier?.featureMask ?? 0;
  const frontierAllReady = atEnd?.frontier?.allReady ?? null;

  const issues = [];
  if (!effectiveBackend) issues.push('effective backend was not recorded');
  if (!backendStable && backendsObserved.length > 1) issues.push(`effective backend changed during run (${backendsObserved.join(' -> ')})`);
  if (requestedRenderer && effectiveBackend && effectiveBackend !== requestedRenderer) {
    issues.push(`requested renderer=${requestedRenderer}, observed effective backend=${effectiveBackend}`);
  }
  if (requestedPostfx === 'off' && (postFxActive || hasPostFxStage)) issues.push('requested postfx=off but hybrid PostFx was active');
  const canvasPaints = Number(perFrameBackends?.canvas) || 0;
  if (hybridPaints !== null && (postFxActive || hybridPaints > 0) && hybridPaints !== canvasPaints) {
    issues.push('Canvas switched between hybrid PostFx and pure Canvas during measurement');
  }
  if (requestedPostfx === 'on' && effectiveBackend === 'canvas' && !hybridPaints) issues.push('requested postfx=on but no hybrid frame was presented');
  if (disableGpu && (gpuWorldActive || postFxActive || effectiveBackend !== 'canvas')) {
    issues.push(`--disable-gpu expected pure Canvas, observed backend=${effectiveBackend} gpuWorldActive=${gpuWorldActive} postFxActive=${postFxActive}`);
  }
  if (pureCanvasRequested && effectiveBackend === 'canvas' && !hasAtmosphereLightsStage) {
    issues.push('pure Canvas run did not observe atmosphere-lights stage in frame timings');
  }
  if (requestedFrontier === 'on' && effectiveBackend === 'webgpu') {
    if (!frontierEnabled) issues.push('requested frontier=on on WebGPU but frontier was disabled');
    else if (!(frontierFeatureMask > 0)) issues.push('requested frontier=on on WebGPU but frontier featureMask was 0');
    if (afterWarmup?.frontier?.allReady !== true || frontierAllReady !== true) {
      issues.push('Frontier passes were not ready throughout the measurement');
    }
    if (afterWarmup?.frontier?.featureMask !== frontierFeatureMask || frontierMasks.some(mask => mask !== frontierFeatureMask)) {
      issues.push('Frontier feature mask changed during measurement');
    }
  }
  if (requestedFrontier === 'off' && frontierEnabled) issues.push('requested frontier=off but frontier remained enabled');

  return {
    ok: issues.length === 0,
    effectiveBackend,
    backendsObserved,
    backendStable,
    gpuWorldActive,
    postFxActive,
    pureCanvasRequested,
    pureCanvasConfirmed,
    hasAtmosphereLightsStage,
    hasPostFxStage,
    frontierEnabled,
    frontierFeatureMask,
    frontierAllReady,
    issues,
  };
}

export function caseComparisonKey(item) {
  const tile = Array.isArray(item.tile) ? item.tile.join(',') : '20,20';
  return [
    item.scenario,
    item.viewport,
    String(item.dpr),
    String(item.hour),
    item.weather,
    item.sidebar || 'collapsed',
    item.cameraMode || 'fixed',
    tile,
    item.pacing,
    item.requestedRenderer || 'default',
    item.requestedPostfx || 'default',
    item.requestedFrontier || 'default',
    item.disableGpu ? 'nogpu' : 'gpu',
    String(item.overviewZoom),
    String(item.closeZoom),
    ...(item.qualityOverride == null ? [] : [`level=${item.qualityOverride}`]),
  ].join('|');
}

export function summarizeNoise(values) {
  const valid = (values || []).filter(Number.isFinite);
  if (!valid.length) return { n: 0, median: null, min: null, max: null, spread: null, iqr: null, spreadPct: null };
  const med = median(valid);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const q1 = quantile(valid, 0.25);
  const q3 = quantile(valid, 0.75);
  const spread = max - min;
  return {
    n: valid.length,
    median: round(med),
    min: round(min),
    max: round(max),
    spread: round(spread),
    iqr: Number.isFinite(q1) && Number.isFinite(q3) ? round(q3 - q1) : null,
    spreadPct: med > 0 ? round((spread / med) * 100) : null,
  };
}

function summarizeArmGroup(arms) {
  if (!arms.length) return null;
  const med = fn => round(median(arms.map(fn)));
  const segMap = new Map();
  for (const arm of arms) {
    for (const seg of arm.renderSegments || []) {
      if (!seg?.label) continue;
      const val = Number.isFinite(seg.p50) ? seg.p50 : seg.ms;
      if (!Number.isFinite(val)) continue;
      if (!segMap.has(seg.label)) segMap.set(seg.label, []);
      segMap.get(seg.label).push(val);
    }
  }
  const topSegments = [...segMap.entries()]
    .map(([label, vals]) => ({ label, medianMs: round(median(vals)) }))
    .sort((a, b) => (b.medianMs ?? 0) - (a.medianMs ?? 0))
    .slice(0, 8);
  const worstStallsMs = arms
    .flatMap(arm => arm.paintIntervalsMs?.worstStallsMs || [])
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .map(v => round(v));
  const qualityLevels = [...new Set(arms.flatMap((arm) => {
    const observed = Object.keys(arm.perFrameQualityLevels || {}).map(Number).filter(Number.isFinite);
    if (observed.length) return observed;
    return Number.isFinite(arm.quality?.level) ? [arm.quality.level] : [];
  }))].sort((a, b) => a - b);
  const endCenterX = med(arm => arm.camera?.endPose?.center?.x);
  const endCenterY = med(arm => arm.camera?.endPose?.center?.y);

  return {
    samples: arms.length,
    resolvedZoom: med(arm => arm.camera?.resolvedZoomEnd ?? arm.camera?.resolvedZoomStart),
    cameraCenter: Number.isFinite(endCenterX) && Number.isFinite(endCenterY) ? [endCenterX, endCenterY] : null,
    qualityLevel: med(arm => arm.quality?.level),
    qualityLevelsObserved: qualityLevels,
    paintsPerSec: med(arm => arm.paintsPerSec),
    paintsPerSecNoise: summarizeNoise(arms.map(arm => arm.paintsPerSec)),
    paintIntervalsMs: {
      p50Ms: med(arm => arm.paintIntervalsMs?.p50Ms),
      p95Ms: med(arm => arm.paintIntervalsMs?.p95Ms),
      p99Ms: med(arm => arm.paintIntervalsMs?.p99Ms),
      maxMs: round(Math.max(...arms.map(arm => arm.paintIntervalsMs?.maxMs).filter(Number.isFinite), -Infinity)),
      worstStallsMs,
    },
    rafFps: med(arm => arm.raf?.fps),
    admittedUpdatesFps: med(arm => arm.admittedUpdates?.fps),
    ambientShare: round(median(arms.map(arm => arm.admittedUpdates?.ambientShare)), 3),
    gpuSubmitFps: med(arm => arm.gpuSubmissions?.submittedFps),
    gpuReusedFps: med(arm => arm.gpuSubmissions?.reusedFps),
    cpuUpdateP50Ms: med(arm => arm.cpuMs?.update?.p50Ms),
    cpuRenderP50Ms: med(arm => arm.cpuMs?.render?.p50Ms),
    cpuTotalP50Ms: med(arm => arm.cpuMs?.total?.p50Ms),
    cpuTotalP95Ms: med(arm => arm.cpuMs?.total?.p95Ms),
    gpuMs: med(arm => arm.gpuEnd?.gpuMs),
    gpuTimingStates: [...new Set(arms.map(arm => arm.gpuEnd?.gpuTimingState).filter(Boolean))],
    textureEvictionsDelta: med(arm => arm.gpuDeltas?.textureEvictions),
    uploadBytesDelta: med(arm => arm.gpuDeltas?.uploadBytes),
    records: med(arm => arm.gpuEnd?.records),
    batches: med(arm => arm.gpuEnd?.batches),
    lightsAdmitted: med(arm => arm.gpuEnd?.lightAdmission?.admitted ?? arm.gpuEnd?.lights),
    maxLightsPerTile: med(arm => arm.gpuEnd?.lightAdmission?.maxPerTile),
    droppedFramesTotal: arms.reduce((sum, arm) => sum + (arm.droppedFrames?.failedFrames || 0), 0),
    missedDisplayIntervals: med(arm => arm.droppedFrames?.missedDisplayIntervals),
    topSegments,
  };
}

export function summarizeIncidentCase(runs) {
  const first = runs[0];
  const primaryOverview = runs.flatMap(r => r.arms.filter(a => a.primary && a.role === 'overview'));
  const primaryClose = runs.flatMap(r => r.arms.filter(a => a.primary && a.role === 'close'));
  const firstZoomOut = runs.flatMap(r => r.arms.filter(a => a.phase === 'first-zoom-out'));
  const overviewReturns = runs.flatMap(r => r.arms.filter(a => a.phase === 'return' && a.role === 'overview'));
  const closeReturns = runs.flatMap(r => r.arms.filter(a => a.phase === 'return' && a.role === 'close'));
  const transitions = runs.flatMap(r => r.transitions || []);

  const overview = summarizeArmGroup(primaryOverview);
  const close = summarizeArmGroup(primaryClose);
  const pairedPoses = runs.every(run => {
    const wide = run.arms.find(arm => arm.primary && arm.role === 'overview')?.camera;
    const close = run.arms.find(arm => arm.primary && arm.role === 'close')?.camera;
    if (!wide || !close || !(wide.resolvedZoomEnd < close.resolvedZoomEnd)) return false;
    const center = wide.endPose?.center;
    return run.arms.every(({ camera, role }) => {
      const zoom = (role === 'overview' ? wide : close).resolvedZoomEnd;
      return [camera?.resolvedZoomStart, camera?.resolvedZoomEnd].every(z => Math.abs(z - zoom) < 0.001)
        && [camera.startPose ?? camera.endPose, camera.endPose].every(pose =>
          !pose?.gliding && Math.abs(pose?.center?.x - center?.x) <= 1 && Math.abs(pose?.center?.y - center?.y) <= 1);
    });
  });
  const tile = Array.isArray(first.tile) ? [...first.tile] : [20, 20];

  return {
    preset: first.preset ?? null,
    label: first.label,
    scenario: first.scenario,
    viewport: first.viewport,
    dpr: first.dpr,
    hour: first.hour,
    weather: first.weather,
    sidebar: first.sidebar,
    cameraMode: first.cameraMode || 'fixed',
    tile,
    pacing: first.pacing,
    overviewZoom: first.overviewZoom,
    closeZoom: first.closeZoom,
    qualityOverride: first.qualityOverride ?? null,
    requestedRenderer: first.requestedRenderer ?? 'default',
    requestedPostfx: first.requestedPostfx ?? 'default',
    requestedFrontier: first.requestedFrontier ?? 'default',
    disableGpu: first.disableGpu === true,
    headed: first.headed,
    browserVersion: first.browserVersion,
    attribution: first.attribution,
    launchArgs: first.launchArgs,
    comparisonKey: caseComparisonKey({ ...first, tile }),
    repetitions: runs.length,
    effectiveBackends: [...new Set(runs.flatMap(r => r.backendCheck?.backendsObserved || []))],
    adapters: [...new Set(runs.flatMap(r => [r.afterWarmup, r.atEnd])
      .filter(s => s?.gpuWorldActive || s?.postFx?.active)
      .map(formatAdapterIdentity)
      .filter(Boolean))].sort(),
    backendStable: runs.every(r => r.backendCheck?.backendStable === true),
    postFxActive: runs.some(r => r.backendCheck?.postFxActive === true),
    pureCanvasRequested: runs.some(r => r.backendCheck?.pureCanvasRequested === true),
    pureCanvasConfirmed: runs.every(r => r.backendCheck?.pureCanvasConfirmed === true),
    frontierEnabled: runs.some(r => r.backendCheck?.frontierEnabled === true),
    frontierFeatureMasks: [...new Set(runs.map(r => r.backendCheck?.frontierFeatureMask ?? 0))].sort((a, b) => a - b),
    backing: first.afterWarmup?.viewport?.backing ?? null,
    visibleCanvasPixels: first.afterWarmup?.viewport?.visibleCanvasPixels ?? null,
    effectiveDpr: first.afterWarmup?.viewport?.effectiveDpr ?? null,
    sidebarCollapsed: first.afterWarmup?.viewport?.sidebarCollapsed ?? null,
    ambientFramePacing: runs.every(r => r.afterWarmup?.pacing?.ambientFramePacing === true),
    errors: runs.reduce((sum, r) => sum + (r.errors?.length || 0), 0),
    backendIssues: [...new Set(runs.flatMap(r => r.backendCheck?.issues || []))],
    overview,
    close,
    pairedPoses,
    overviewToCloseRatio: overview?.paintsPerSec && close?.paintsPerSec ? round(overview.paintsPerSec / close.paintsPerSec, 3) : null,
    firstZoomOut: summarizeArmGroup(firstZoomOut),
    overviewReturn: summarizeArmGroup(overviewReturns),
    closeReturn: summarizeArmGroup(closeReturns),
    transitions: transitions.length
      ? {
        count: transitions.length,
        overviewEntryPaintsPerSec: round(median(transitions.filter(t => t.role === 'overview').map(t => t.paintsPerSec))),
        overviewEntryMaxGapMs: round(Math.max(...transitions.filter(t => t.role === 'overview').map(t => t.paintIntervalsMs?.maxMs).filter(Number.isFinite), -Infinity)),
        closeEntryPaintsPerSec: round(median(transitions.filter(t => t.role === 'close').map(t => t.paintsPerSec))),
        closeEntryMaxGapMs: round(Math.max(...transitions.filter(t => t.role === 'close').map(t => t.paintIntervalsMs?.maxMs).filter(Number.isFinite), -Infinity)),
      }
      : null,
  };
}

/** Verify runtime comparability between candidate and saved baseline cases. */
export function checkBaselineComparability(candidate, baseline) {
  const mismatches = [];
  for (const field of ['headed', 'browserVersion', 'attribution']) {
    if (candidate[field] == null || candidate[field] !== baseline[field]) {
      mismatches.push(`${field} mismatch or missing browser configuration`);
    }
  }
  if (!Array.isArray(candidate.launchArgs) || !Array.isArray(baseline.launchArgs)
    || !sameList(candidate.launchArgs, baseline.launchArgs)) {
    mismatches.push('browser launch arguments differ or are unavailable');
  }
  const usesGpuAdapter = item => Boolean(item?.postFxActive)
    || (Array.isArray(item?.effectiveBackends) && item.effectiveBackends.some(b => b === 'webgpu' || b === 'webgl'));
  if (!Array.isArray(candidate.adapters) || !Array.isArray(baseline.adapters)) {
    mismatches.push('GPU adapter comparability requires explicit adapters arrays on both baseline and candidate');
  } else {
    const candidateInvalid = candidate.adapters.some(entry => !isMeaningfulAdapterIdentity(entry));
    const baselineInvalid = baseline.adapters.some(entry => !isMeaningfulAdapterIdentity(entry));
    if (candidateInvalid || baselineInvalid) {
      mismatches.push('GPU adapter identity must be meaningful on both baseline and candidate');
    } else if ((usesGpuAdapter(candidate) && candidate.adapters.length === 0)
      || (usesGpuAdapter(baseline) && baseline.adapters.length === 0)) {
      mismatches.push('GPU/hybrid comparability requires non-empty meaningful GPU adapter identity');
    } else if (!sameList(candidate.adapters, baseline.adapters)) {
      mismatches.push('GPU adapter changed between baseline and candidate');
    }
  }
  if (!sameList(candidate.effectiveBackends, baseline.effectiveBackends)) {
    mismatches.push(`effective backend mismatch: candidate ${candidate.effectiveBackends?.join(',')} vs baseline ${baseline.effectiveBackends?.join(',')}`);
  }
  if (Boolean(candidate.postFxActive) !== Boolean(baseline.postFxActive)) {
    mismatches.push(`postFxActive mismatch: candidate ${candidate.postFxActive} vs baseline ${baseline.postFxActive}`);
  }
  if (Boolean(candidate.frontierEnabled) !== Boolean(baseline.frontierEnabled)
    || !sameList(candidate.frontierFeatureMasks, baseline.frontierFeatureMasks)) {
    mismatches.push(`frontier mismatch: candidate enabled=${candidate.frontierEnabled} mask=${candidate.frontierFeatureMasks?.join(',')} vs baseline enabled=${baseline.frontierEnabled} mask=${baseline.frontierFeatureMasks?.join(',')}`);
  }
  if (!samePair(candidate.backing, baseline.backing, 0)) {
    mismatches.push(`backing mismatch: candidate ${candidate.backing?.join('x') ?? 'n/a'} vs baseline ${baseline.backing?.join('x') ?? 'n/a'}`);
  }
  if (candidate.effectiveDpr !== baseline.effectiveDpr) {
    mismatches.push(`effectiveDpr mismatch: candidate ${candidate.effectiveDpr} vs baseline ${baseline.effectiveDpr}`);
  }
  if (candidate.sidebarCollapsed !== baseline.sidebarCollapsed) {
    mismatches.push(`sidebarCollapsed mismatch: candidate ${candidate.sidebarCollapsed} vs baseline ${baseline.sidebarCollapsed}`);
  }
  if (!samePair(candidate.tile, baseline.tile, 0)) {
    mismatches.push(`tile mismatch: candidate ${candidate.tile?.join(',')} vs baseline ${baseline.tile?.join(',')}`);
  }
  if (candidate.cameraMode !== baseline.cameraMode) {
    mismatches.push(`cameraMode mismatch: candidate ${candidate.cameraMode} vs baseline ${baseline.cameraMode}`);
  }
  for (const armName of ['overview', 'close']) {
    const cArm = candidate[armName];
    const bArm = baseline[armName];
    if (!cArm || !bArm) continue;
    if (Number.isFinite(cArm.resolvedZoom) && Number.isFinite(bArm.resolvedZoom)
      && Math.abs(cArm.resolvedZoom - bArm.resolvedZoom) > 1e-3) {
      mismatches.push(`${armName} resolvedZoom mismatch: candidate ${cArm.resolvedZoom} vs baseline ${bArm.resolvedZoom}`);
    }
    if (candidate.cameraMode === 'fixed' && cArm.cameraCenter && bArm.cameraCenter
      && !samePair(cArm.cameraCenter, bArm.cameraCenter, 1)) {
      mismatches.push(`${armName} cameraCenter mismatch: candidate [${cArm.cameraCenter.join(',')}] vs baseline [${bArm.cameraCenter.join(',')}]`);
    }
    if ((cArm.qualityLevel ?? null) !== (bArm.qualityLevel ?? null)) {
      mismatches.push(`${armName} qualityLevel mismatch: candidate ${cArm.qualityLevel ?? 'none'} vs baseline ${bArm.qualityLevel ?? 'none'}`);
    }
    if (!sameList(cArm.qualityLevelsObserved, bArm.qualityLevelsObserved)) {
      mismatches.push(`${armName} qualityLevelsObserved mismatch: candidate [${cArm.qualityLevelsObserved?.join(',')}] vs baseline [${bArm.qualityLevelsObserved?.join(',')}]`);
    }
  }
  return { comparable: mismatches.length === 0, mismatches };
}

export function evaluateIncidentGates(caseSummary, {
  thresholds = INCIDENT_GATE_DEFAULTS,
  baselineCase = null,
  baselineExpected = false,
  gateMode = 'auto',
} = {}) {
  const limits = { ...INCIDENT_GATE_DEFAULTS, ...thresholds };
  const effectiveGateMode = gateMode === 'auto'
    ? (baselineExpected || baselineCase ? 'all' : 'absolute')
    : gateMode;

  const hygieneChecks = {
    zeroErrors: (caseSummary.errors || 0) === 0,
    backendVerified: (caseSummary.backendIssues || []).length === 0 && caseSummary.backendStable === true,
    hasPairedArms: Boolean(caseSummary.overview && caseSummary.close),
    pairedPoses: caseSummary.pairedPoses === true,
  };
  const hygienePassed = Object.values(hygieneChecks).every(Boolean);
  const violations = [];
  if (!hygieneChecks.zeroErrors) violations.push(`browser errors: ${caseSummary.errors}`);
  if (!hygieneChecks.backendVerified) violations.push(...(caseSummary.backendIssues?.length ? caseSummary.backendIssues : ['effective backend unstable']));
  if (!hygieneChecks.hasPairedArms) violations.push('missing paired overview/close measurements');
  else if (!hygieneChecks.pairedPoses) violations.push('overview and close require distinct settled zooms at the same camera center');

  const enforceAbsolute = effectiveGateMode === 'all' || effectiveGateMode === 'absolute';
  const enforceBaseline = effectiveGateMode === 'all' || effectiveGateMode === 'baseline';

  let absolute;
  if (caseSummary.pacing === 'active') {
    const overviewFps = caseSummary.overview?.paintsPerSec;
    const overviewP95 = caseSummary.overview?.paintIntervalsMs?.p95Ms;
    const overviewPaintsAtLeastTarget = Number.isFinite(overviewFps) && overviewFps >= limits.minOverviewPaintsPerSec;
    const overviewP95WithinTarget = Number.isFinite(overviewP95) && overviewP95 <= limits.maxOverviewP95Ms;
    absolute = {
      pacing: 'active',
      passed: overviewPaintsAtLeastTarget && overviewP95WithinTarget,
      checks: { overviewPaintsAtLeastTarget, overviewP95WithinTarget },
      observed: { overviewPaintsPerSec: overviewFps ?? null, overviewPaintP95Ms: overviewP95 ?? null },
      targets: { minOverviewPaintsPerSec: limits.minOverviewPaintsPerSec, maxOverviewP95Ms: limits.maxOverviewP95Ms },
    };
    if (enforceAbsolute) {
      if (!overviewPaintsAtLeastTarget) violations.push(`overview paints/s ${overviewFps ?? 'n/a'} < target ${limits.minOverviewPaintsPerSec}`);
      if (!overviewP95WithinTarget) violations.push(`overview p95 paint gap ${overviewP95 ?? 'n/a'} ms > target ${limits.maxOverviewP95Ms} ms`);
    }
  } else {
    const overviewFps = caseSummary.overview?.paintsPerSec;
    const closeFps = caseSummary.close?.paintsPerSec;
    const overviewP95 = caseSummary.overview?.paintIntervalsMs?.p95Ms;
    const closeP95 = caseSummary.close?.paintIntervalsMs?.p95Ms;
    const overviewShare = caseSummary.overview?.ambientShare;
    const closeShare = caseSummary.close?.ambientShare;

    const ambientCadenceActivated = caseSummary.ambientFramePacing === true
      && Number.isFinite(overviewShare) && overviewShare >= limits.minAmbientShare
      && Number.isFinite(closeShare) && closeShare >= limits.minAmbientShare;
    const ambientWithinCap = Number.isFinite(overviewFps) && overviewFps <= limits.maxAmbientPaintsPerSec
      && Number.isFinite(closeFps) && closeFps <= limits.maxAmbientPaintsPerSec;
    const ambientNotStalled = Number.isFinite(overviewFps) && overviewFps >= limits.minAmbientPaintsPerSec
      && Number.isFinite(closeFps) && closeFps >= limits.minAmbientPaintsPerSec
      && Number.isFinite(overviewP95) && overviewP95 <= limits.maxAmbientP95Ms
      && Number.isFinite(closeP95) && closeP95 <= limits.maxAmbientP95Ms;

    absolute = {
      pacing: 'ambient',
      passed: ambientCadenceActivated && ambientWithinCap && ambientNotStalled,
      checks: { ambientCadenceActivated, ambientWithinCap, ambientNotStalled },
      observed: {
        ambientFramePacing: caseSummary.ambientFramePacing === true,
        overviewPaintsPerSec: overviewFps ?? null,
        closePaintsPerSec: closeFps ?? null,
        overviewPaintP95Ms: overviewP95 ?? null,
        closePaintP95Ms: closeP95 ?? null,
        overviewAmbientShare: overviewShare ?? null,
        closeAmbientShare: closeShare ?? null,
      },
      targets: {
        minAmbientShare: limits.minAmbientShare,
        minAmbientPaintsPerSec: limits.minAmbientPaintsPerSec,
        maxAmbientPaintsPerSec: limits.maxAmbientPaintsPerSec,
        maxAmbientP95Ms: limits.maxAmbientP95Ms,
      },
    };
    if (enforceAbsolute) {
      if (!ambientCadenceActivated) {
        violations.push(`ambient cadence did not activate (ambientFramePacing=${caseSummary.ambientFramePacing}, shares overview=${overviewShare ?? 'n/a'} close=${closeShare ?? 'n/a'} < ${limits.minAmbientShare})`);
      }
      if (!ambientWithinCap) {
        violations.push(`ambient paints/s (overview=${overviewFps ?? 'n/a'}, close=${closeFps ?? 'n/a'}) > cap ${limits.maxAmbientPaintsPerSec}`);
      }
      if (!ambientNotStalled) {
        violations.push(`ambient paints stalled (overview=${overviewFps ?? 'n/a'} fps / p95=${overviewP95 ?? 'n/a'} ms, close=${closeFps ?? 'n/a'} fps / p95=${closeP95 ?? 'n/a'} ms; expected >=${limits.minAmbientPaintsPerSec} fps and p95<=${limits.maxAmbientP95Ms} ms)`);
      }
    }
  }

  let baseline = null;
  if (baselineExpected || baselineCase) {
    if (!baselineCase) {
      baseline = {
        matched: false,
        comparable: false,
        comparabilityMismatches: [],
        passed: false,
        checks: { baselineCaseFound: false, baselineComparable: false, closeThroughputRetained: false },
        targets: { minCloseBaselineRatio: limits.minCloseBaselineRatio },
      };
      if (enforceBaseline) violations.push(`no matching baseline case for key ${caseSummary.comparisonKey}`);
    } else {
      const comp = checkBaselineComparability(caseSummary, baselineCase);
      const baseClose = baselineCase.close?.paintsPerSec;
      const candClose = caseSummary.close?.paintsPerSec;
      const baseOverview = baselineCase.overview?.paintsPerSec;
      const candOverview = caseSummary.overview?.paintsPerSec;
      const baseOverviewP95 = baselineCase.overview?.paintIntervalsMs?.p95Ms;
      const candOverviewP95 = caseSummary.overview?.paintIntervalsMs?.p95Ms;
      const closeRatio = Number.isFinite(baseClose) && baseClose > 0 && Number.isFinite(candClose) ? candClose / baseClose : null;
      const closeThroughputRetained = closeRatio !== null && closeRatio >= limits.minCloseBaselineRatio;
      const overviewDelta = Number.isFinite(baseOverview) && Number.isFinite(candOverview) ? candOverview - baseOverview : null;
      const baseNoise = baselineCase.overview?.paintsPerSecNoise;
      const baseNoiseSpread = baseNoise && baseNoise.n >= 2 ? baseNoise.spread : null;

      baseline = {
        matched: true,
        comparable: comp.comparable,
        comparabilityMismatches: comp.mismatches,
        passed: comp.comparable && closeThroughputRetained,
        checks: {
          baselineCaseFound: true,
          baselineComparable: comp.comparable,
          closeThroughputRetained,
        },
        observed: {
          closePaintsPerSec: candClose ?? null,
          baselineClosePaintsPerSec: baseClose ?? null,
          closeBaselineRatio: round(closeRatio, 4),
          overviewPaintsPerSec: candOverview ?? null,
          baselineOverviewPaintsPerSec: baseOverview ?? null,
          overviewPaintsDelta: round(overviewDelta),
          overviewPaintsDeltaPct: overviewDelta !== null && baseOverview > 0 ? round((overviewDelta / baseOverview) * 100) : null,
          overviewP95DeltaMs: Number.isFinite(baseOverviewP95) && Number.isFinite(candOverviewP95) ? round(candOverviewP95 - baseOverviewP95) : null,
          baselineOverviewNoiseSpread: baseNoiseSpread,
          exceedsBaselineNoise: overviewDelta !== null && Number.isFinite(baseNoiseSpread) ? Math.abs(overviewDelta) > baseNoiseSpread : null,
        },
        targets: { minCloseBaselineRatio: limits.minCloseBaselineRatio },
      };
      if (enforceBaseline) {
        if (!comp.comparable) violations.push(...comp.mismatches);
        if (!closeThroughputRetained) {
          violations.push(`close throughput ratio ${round(closeRatio, 3) ?? 'n/a'} (${candClose ?? 'n/a'} vs baseline ${baseClose ?? 'n/a'} paints/s) < ${limits.minCloseBaselineRatio}`);
        }
      }
    }
  }

  let passed = hygienePassed;
  if (effectiveGateMode === 'all') passed = hygienePassed && absolute.passed && (baseline ? baseline.passed : true);
  else if (effectiveGateMode === 'absolute') passed = hygienePassed && absolute.passed;
  else if (effectiveGateMode === 'baseline') passed = hygienePassed && (baseline ? baseline.passed : true);

  return {
    gateMode: effectiveGateMode,
    passed,
    hygiene: { passed: hygienePassed, checks: hygieneChecks },
    absolute,
    baseline,
    violations,
  };
}

export function indexBaselineReport(report) {
  const summary = report?.summary ?? report;
  if (!Array.isArray(summary?.cases)) throw new Error('baseline JSON must contain summary.cases or cases array');
  // Earlier reports stored the browser configuration once for the whole run.
  return new Map(summary.cases.map(item => [item.comparisonKey || caseComparisonKey(item), {
    ...item,
    headed: item.headed ?? summary.options?.headed,
    browserVersion: item.browserVersion ?? summary.browserVersion,
    attribution: item.attribution ?? summary.options?.attribution,
    launchArgs: item.launchArgs ?? summary.options?.launchArgs,
  }]));
}
