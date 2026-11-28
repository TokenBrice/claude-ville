#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BENCH_WEATHER,
  benchLaunchArgs,
  browserRootPid,
  buildMetadata,
  buildWorldQuery,
  collectWorldStateSnapshot,
  hostSnapshot,
  launchBenchBrowser,
  median as medianOf,
  openWorld,
  parseConditions,
  parseViewport,
  poseWorld,
  procTreeCpuSeconds,
  quantile,
  readWorldStateSnapshot,
  resolveServer,
  round as roundTo,
} from './support/world-bench.mjs';
import {
  INCIDENT_DEFAULT_PRESETS,
  INCIDENT_GATE_DEFAULTS,
  buildIncidentCases,
  buildPairedArmOrder,
  caseComparisonKey,
  computeGpuDeltas,
  computeWaterDeltas,
  evaluateIncidentGates,
  indexBaselineReport,
  normalizeTriStateFlag,
  parseTile,
  summarizeIncidentCase,
  summarizeIntervals,
  verifyEffectiveBackend,
} from './support/incident-gate.mjs';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || '';
const DEFAULT_COUNTS = [1, 10, 24, 50, 100];
const WEATHER_PROFILES = Object.freeze({
  clear: Object.freeze({
    type: 'clear',
    intensity: 0,
    precipitation: 0,
    fog: 0,
    cloudCover: 0.1,
    windX: 0,
    seed: 4242,
  }),
  rain: Object.freeze({
    type: 'rain',
    intensity: 0.82,
    precipitation: 0.92,
    fog: 0.12,
    cloudCover: 0.92,
    windX: -0.44,
    seed: 4242,
  }),
});
const FIXED_DATE = '2026-05-18T12:00:00.000Z';
const VIEWPORT = Object.freeze({ width: 1600, height: 1000 });
const CAMERA_POSE = Object.freeze({ x: -128, y: 704, zoom: 1.72 });

const MODES = Object.freeze(['matrix', 'soak', 'inject', 'dashboard', 'kslope', 'unlocked', 'idle', 'incident']);
const MODE_DEFAULTS = Object.freeze({
  matrix: { durationSeconds: 30, warmupSeconds: 10, repetitions: 3 },
  soak: { durationSeconds: 180, warmupSeconds: 10, repetitions: 1 },
  inject: { durationSeconds: 0, warmupSeconds: 10, repetitions: 1 },
  dashboard: { durationSeconds: 0, warmupSeconds: 10, repetitions: 1 },
  kslope: { durationSeconds: 24, warmupSeconds: 4, repetitions: 3 },
  unlocked: { durationSeconds: 12, warmupSeconds: 4, repetitions: 3 },
  idle: { durationSeconds: 20, warmupSeconds: 4, repetitions: 1 },
  incident: { durationSeconds: 30, warmupSeconds: 20, repetitions: 3 },
});
// FP-11 — the idle-power arm's scene classes: an empty village is ambient
// only; every other scenario is a walking scene (bodies on the move).
const IDLE_DEFAULT_SCENARIOS = Object.freeze(['no-agents', 'dense-24-agents']);
const IDLE_DEFAULT_CONDITIONS = '12:clear';
const AMBIENT_SCENARIOS = new Set(['no-agents']);
const MATRIX_ONLY_FLAGS = new Set(['--counts', '--weather', '--max-rain-regression-pct', '--profile']);
const LADDER_ONLY_FLAGS = new Set([
  '--scenario', '--viewport', '--dpr', '--zoom', '--conditions', '--level', '--load-passes', '--load-levels',
  '--baseline-seconds', '--load-seconds', '--recover-seconds', '--away-seconds', '--returns', '--candidate-passes',
  '--reduced-motion', '--postfx', '--frontier', '--disable-gpu', '--sidebar', '--camera-mode', '--tile',
]);
const INCIDENT_ONLY_FLAGS = new Set([
  '--incident-cases', '--pacing', '--settle-seconds', '--attribution', '--baseline', '--gate',
]);
const BOOLEAN_FLAGS = new Set([
  '--headed', '--profile', '--reduced-motion', '--disable-gpu', '--attribution',
]);

function usage() {
  console.log(`Usage: node scripts/smoke/world-fps-benchmark.mjs [--mode=<mode>] [options]

Modes:
  matrix     (default) Renderer FPS across agent counts, clear vs heavy rain
  soak       Free ladder at 60 Hz (or the display's rate): per-frame level
             histogram, level changes per minute, rAF p50/p95/p99, shed lines
  inject     Free ladder under the debug GPU-side load (extra full-screen
             passes in _present): time to shed after it starts, time to
             recover after it stops
  dashboard  Free ladder across World -> Dashboard -> World returns: time to
             the first frame and to the level held before leaving
  kslope     V2 receipt: per-frame interleaved K in {0,1,8} of one present
             pass beside an A/A arm set; price = (T8 - T0) / 8
  unlocked   V2 receipt: vsync, frame-rate limit and the World's 60 fps cap
             off, forced FULL vs MINIMAL in alternating 60-frame blocks; the
             rAF interval delta
  idle       FP-11 idle power: per scene class (no-agents = empty ambient,
             any other scenario = walking), the renderer's frames/s (admitted,
             painted, GPU-submitted) and the launched browser's renderer and
             GPU-process CPU-seconds per hour read from /proc (Linux). With
             ambient pacing on (FramePacing.js), ambient scenes must render
             at 31 fps or fewer and walking scenes at 59-61 fps
  incident   Paired overview/close incident gate (default presets: 4-agent
             23:53 2496x1404 zoom 1/3 and 17-agent 22:47 2560x1428 zoom
             survey/3, collapsed sidebar). Records effective backend, PostFx
             and Frontier mask/readiness after warm-up, per frame and at end,
             successful paint throughput and p50/p95/p99 paint intervals via
             presentGeneration, separate rAF/admitted/GPU-submit/dropped
             counts, GPU and water deltas, first zoom-out vs return, and
             active/ambient plus absolute and optional paired baseline gates

Common options:
  --url=<url>                 ClaudeVille URL (default: an isolated server
                              unless --url or CLAUDEVILLE_URL is given)
  --duration-seconds=<n>      Measurement per run (matrix/incident 30, soak 180,
                              kslope 24, unlocked 12, idle 20)
  --warmup-seconds=<n>        Warmup per run (incident 20, matrix/soak/inject/
                              dashboard 10, kslope/unlocked/idle 4)
  --repetitions=<n>           Fresh browser contexts per case (matrix/incident/
                              kslope/unlocked 3, soak/inject/dashboard/idle 1)
  --out=<file>                Also write runs and summary as JSON
  --renderer=<mode>           Force the World backend: webgl | webgpu | canvas
                              (default: the app's default; WebGPU in Chromium
                              with a GPU). Receipts that measure WebGL2 pass
                              --renderer=webgl; every run records its backend.
  --headed                    Show the Chromium window (use on the 120 Hz panel)
  --help                      Print this help

Matrix options:
  --counts=<list>             Comma-separated agent counts from 1 to 200
  --weather=<list>            Comma-separated subset of clear,rain
  --max-rain-regression-pct=<n>
                              Fail if paired rain median FPS is more than n% below clear
  --profile                   Include opt-in update/render timings

Ladder, receipt and incident options (soak, inject, dashboard, kslope, unlocked, idle, incident):
  --scenario=<ids>            Sim scenarios (default: dense-24-agents; incident uses presets)
  --viewport=<list>           WIDTHxHEIGHT list (default: 1920x1080; incident uses presets)
  --dpr=<n>                   Device scale factor (default: 1)
  --zoom=<list>               Zoom tiers, or survey (default: 1; incident expects overview,close)
  --conditions=<list>         hour:weather pairs, weather ${Object.keys(BENCH_WEATHER).join('|')}
                              (default: 22:clear; incident uses presets)
  --postfx=<default|on|off>   Page query postfx flag (off passes ?postfx=0 for pure Canvas)
  --frontier=<default|on|off> Page query frontier flag (on passes ?frontier=1 under ?sim)
  --disable-gpu               Launch Chromium with --disable-gpu --disable-webgl (no GPU APIs)
  --sidebar=<default|collapsed|expanded>
                              Sidebar fold state before boot (incident defaults to collapsed)
  --camera-mode=<fixed|auto>  Camera control mode (default: fixed)
  --tile=<x,y>                Pinned camera center tile (default: 20,20)
  --level=<0|1|2>             kslope: forced ladder level (default: 0); incident: optional fixed GPU level
  --candidate-passes=<n>      kslope: present passes per K unit (default: 1)
  --load-passes=<n>           inject: injected full-screen passes (default: 400)
  --load-levels=<full|all>    inject: load drawn at FULL only, which the ladder
                              can shed (default), or at every level
  --baseline-seconds=<n>      inject: free-ladder window before the load (default: 5)
  --load-seconds=<n>          inject: load duration (default: 20)
  --recover-seconds=<n>       inject: observation after removal (default: 90)
  --away-seconds=<n>          dashboard: time in the Dashboard (default: 5)
  --returns=<n>               dashboard: returns per run (default: 3)
  --reduced-motion            idle: pages prefer reduced motion (the static path)

Incident options (--mode=incident):
  --incident-cases=<list>     Subset of 4,17 (default: ${INCIDENT_DEFAULT_PRESETS.join(',')})
  --pacing=<active|ambient|both>
                              Active 60 Hz held, ambient 30 Hz allowed, or both (default: active)
  --settle-seconds=<n>        Settle wait after each camera pose (default: 3)
  --attribution               Enable GPU pass sampling for a separate attribution run
  --baseline=<file>           Saved --mode=incident JSON for paired comparability + close-retention gate
  --gate=<auto|all|absolute|baseline|none>
                              Gate enforcement: auto (absolute, or all with --baseline),
                              all, absolute, baseline, or none (hygiene only; records baseline)

Idle defaults: --scenario=${IDLE_DEFAULT_SCENARIOS.join(',')} --conditions=${IDLE_DEFAULT_CONDITIONS}, 20 s
per case after a 4 s warmup. Headless Chromium composites in software and
paces rAF at 60 Hz, so its CPU-seconds include compositor work a headed,
GPU-composited window does not pay: compare arms run on one host, never a
headless number with a real window's.

Output is newline-delimited JSON per run followed by a summary object.`);
}

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  const options = {
    mode: 'matrix',
    url: DEFAULT_URL.replace(/\/+$/, ''),
    urlExplicit: Boolean(process.env.CLAUDEVILLE_URL),
    durationSeconds: null,
    warmupSeconds: null,
    repetitions: null,
    counts: [...DEFAULT_COUNTS],
    weather: Object.keys(WEATHER_PROFILES),
    profile: false,
    headed: false,
    maxRainRegressionPct: null,
    out: null,
    renderer: null,
    postfx: 'default',
    frontier: 'default',
    disableGpu: false,
    sidebar: 'default',
    cameraMode: 'fixed',
    tile: [20, 20],
    scenarios: ['dense-24-agents'],
    viewports: [parseViewport('1920x1080')],
    dpr: 1,
    zooms: ['1'],
    conditions: parseConditions('22:clear'),
    level: 0,
    candidatePasses: 1,
    loadPasses: 400,
    loadLevels: 'full',
    baselineSeconds: 5,
    loadSeconds: 20,
    recoverSeconds: 90,
    awaySeconds: 5,
    returns: 3,
    reducedMotion: false,
    incidentCases: [...INCIDENT_DEFAULT_PRESETS],
    pacing: 'active',
    settleSeconds: 3,
    attribution: false,
    baseline: null,
    gate: 'auto',
    seenFlags: new Set(),
  };
  const seen = options.seenFlags;

  const allowedValueFlags = new Set([
    '--mode',
    '--url',
    '--duration-seconds',
    '--warmup-seconds',
    '--repetitions',
    '--out',
    '--renderer',
    ...MATRIX_ONLY_FLAGS,
    ...LADDER_ONLY_FLAGS,
    ...INCIDENT_ONLY_FLAGS,
  ]);
  for (const flag of BOOLEAN_FLAGS) allowedValueFlags.delete(flag);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      options.headed = true;
      continue;
    }
    if (arg === '--profile') {
      options.profile = true;
      seen.add(arg);
      continue;
    }
    if (arg === '--reduced-motion') {
      options.reducedMotion = true;
      seen.add(arg);
      continue;
    }
    if (arg === '--disable-gpu') {
      options.disableGpu = true;
      seen.add(arg);
      continue;
    }
    if (arg === '--attribution') {
      options.attribution = true;
      seen.add(arg);
      continue;
    }
    const [flag, inlineValue] = arg.split('=', 2);
    if (!allowedValueFlags.has(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    seen.add(flag);
    if (flag === '--mode') options.mode = value;
    if (flag === '--url') {
      options.url = value.replace(/\/+$/, '');
      options.urlExplicit = true;
    }
    if (flag === '--duration-seconds') options.durationSeconds = Number(value);
    if (flag === '--warmup-seconds') options.warmupSeconds = Number(value);
    if (flag === '--repetitions') options.repetitions = Number(value);
    if (flag === '--out') options.out = value;
    if (flag === '--renderer') options.renderer = value;
    if (flag === '--postfx') options.postfx = normalizeTriStateFlag(value, '--postfx');
    if (flag === '--frontier') options.frontier = normalizeTriStateFlag(value, '--frontier');
    if (flag === '--sidebar') options.sidebar = value;
    if (flag === '--camera-mode') options.cameraMode = value;
    if (flag === '--tile') options.tile = parseTile(value);
    if (flag === '--counts') options.counts = parseList(value).map(Number);
    if (flag === '--weather') options.weather = parseList(value);
    if (flag === '--max-rain-regression-pct') options.maxRainRegressionPct = Number(value);
    if (flag === '--scenario') options.scenarios = parseList(value);
    if (flag === '--viewport') options.viewports = parseList(value).map(parseViewport);
    if (flag === '--dpr') options.dpr = Number(value);
    if (flag === '--zoom') options.zooms = parseList(value);
    if (flag === '--conditions') options.conditions = parseConditions(value);
    if (flag === '--level') options.level = Number(value);
    if (flag === '--candidate-passes') options.candidatePasses = Number(value);
    if (flag === '--load-passes') options.loadPasses = Number(value);
    if (flag === '--load-levels') options.loadLevels = value;
    if (flag === '--baseline-seconds') options.baselineSeconds = Number(value);
    if (flag === '--load-seconds') options.loadSeconds = Number(value);
    if (flag === '--recover-seconds') options.recoverSeconds = Number(value);
    if (flag === '--away-seconds') options.awaySeconds = Number(value);
    if (flag === '--returns') options.returns = Number(value);
    if (flag === '--incident-cases') options.incidentCases = parseList(value);
    if (flag === '--pacing') options.pacing = value;
    if (flag === '--settle-seconds') options.settleSeconds = Number(value);
    if (flag === '--baseline') options.baseline = value;
    if (flag === '--gate') options.gate = value;
  }

  if (!MODES.includes(options.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  if (options.reducedMotion && options.mode !== 'idle') throw new Error('--reduced-motion applies to --mode=idle only');
  if (options.mode === 'idle') {
    if (!seen.has('--scenario')) options.scenarios = [...IDLE_DEFAULT_SCENARIOS];
    if (!seen.has('--conditions')) options.conditions = parseConditions(IDLE_DEFAULT_CONDITIONS);
  }
  if (options.renderer != null && !['webgl', 'webgpu', 'canvas'].includes(options.renderer)) {
    throw new Error('renderer must be webgl, webgpu or canvas');
  }
  if (!['default', 'collapsed', 'expanded'].includes(options.sidebar)) {
    throw new Error('sidebar must be default, collapsed or expanded');
  }
  if (!['fixed', 'auto'].includes(options.cameraMode)) {
    throw new Error('camera-mode must be fixed or auto');
  }
  for (const flag of seen) {
    if (options.mode === 'matrix' && (LADDER_ONLY_FLAGS.has(flag) || INCIDENT_ONLY_FLAGS.has(flag))) {
      throw new Error(`${flag} does not apply to --mode=${options.mode}`);
    }
    if (options.mode !== 'matrix' && MATRIX_ONLY_FLAGS.has(flag)) {
      throw new Error(`${flag} does not apply to --mode=${options.mode}`);
    }
    if (options.mode !== 'incident' && INCIDENT_ONLY_FLAGS.has(flag)) {
      throw new Error(`${flag} applies to --mode=incident only`);
    }
  }
  const defaults = MODE_DEFAULTS[options.mode];
  options.durationSeconds ??= defaults.durationSeconds;
  options.warmupSeconds ??= defaults.warmupSeconds;
  options.repetitions ??= defaults.repetitions;

  if (['matrix', 'soak', 'kslope', 'unlocked', 'idle', 'incident'].includes(options.mode)
    && (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1)) {
    throw new Error('duration seconds must be at least 1');
  }
  if (!Number.isFinite(options.warmupSeconds) || options.warmupSeconds < 0) {
    throw new Error('warmup seconds must be zero or positive');
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions <= 0) {
    throw new Error('repetitions must be a positive integer');
  }
  if (!options.counts.length || options.counts.some(count => !Number.isInteger(count) || count < 1 || count > 200)) {
    throw new Error('counts must be a non-empty list of integers from 1 to 200');
  }
  if (!options.weather.length || options.weather.some(name => !WEATHER_PROFILES[name])) {
    throw new Error(`weather must be a non-empty subset of ${Object.keys(WEATHER_PROFILES).join(',')}`);
  }
  if (
    options.maxRainRegressionPct != null
    && (!Number.isFinite(options.maxRainRegressionPct) || options.maxRainRegressionPct < 0)
  ) {
    throw new Error('max rain regression percent must be zero or positive');
  }
  if (
    options.maxRainRegressionPct != null
    && (!options.weather.includes('clear') || !options.weather.includes('rain'))
  ) {
    throw new Error('rain regression checks require both clear and rain weather cases');
  }
  if (!options.scenarios.length || !options.viewports.length || !options.zooms.length || !options.conditions.length) {
    throw new Error('scenario, viewport, zoom and conditions lists must be non-empty');
  }
  if (!(options.dpr > 0)) throw new Error('dpr must be positive');
  if (![0, 1, 2].includes(options.level)) throw new Error('level must be 0, 1 or 2');
  if (!Number.isInteger(options.candidatePasses) || options.candidatePasses < 1) {
    throw new Error('candidate passes must be a positive integer');
  }
  if (!Number.isInteger(options.loadPasses) || options.loadPasses < 1) throw new Error('load passes must be a positive integer');
  if (!['full', 'all'].includes(options.loadLevels)) throw new Error('load levels must be full or all');
  for (const key of ['baselineSeconds', 'loadSeconds', 'recoverSeconds', 'awaySeconds']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (!Number.isInteger(options.returns) || options.returns < 1) throw new Error('returns must be a positive integer');

  if (options.mode === 'incident') {
    if (!options.incidentCases.length || options.incidentCases.some(id => !['4', '17'].includes(id))) {
      throw new Error('incident-cases must be a non-empty subset of 4,17');
    }
    if (!['active', 'ambient', 'both'].includes(options.pacing)) {
      throw new Error('pacing must be active, ambient or both');
    }
    if (!['auto', 'all', 'absolute', 'baseline', 'none'].includes(options.gate)) {
      throw new Error('gate must be auto, all, absolute, baseline or none');
    }
    if (options.gate === 'baseline' && !options.baseline) {
      throw new Error('--gate=baseline requires --baseline=<file>');
    }
    if (seen.has('--zoom') && options.zooms.length !== 2) {
      throw new Error('incident mode --zoom expects two values (overview,close), e.g. --zoom=survey,3');
    }
    if (!Number.isFinite(options.settleSeconds) || options.settleSeconds < 0) {
      throw new Error('settle-seconds must be zero or positive');
    }
  }
  return options;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function summarizeFps(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    mean: round(mean, 1),
    median: round(percentile(values, 0.5), 1),
    p10: round(percentile(values, 0.1), 1),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeFrames(deltas) {
  if (!deltas.length) return null;
  const meanMs = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const longFrames = deltas.filter(value => value > 50).length;
  return {
    samples: deltas.length,
    fps: round(1000 / meanMs, 1),
    meanMs: round(meanMs),
    p50Ms: round(percentile(deltas, 0.5)),
    p95Ms: round(percentile(deltas, 0.95)),
    maxMs: round(Math.max(...deltas)),
    over50Ms: longFrames,
    over50MsRatio: round(longFrames / deltas.length, 4),
  };
}

function summarizeProfile(profile) {
  const samples = profile?.samples;
  if (!samples?.length) return null;
  const summarize = key => ({
    p50Ms: round(percentile(samples.map(sample => sample[key]), 0.5)),
    p95Ms: round(percentile(samples.map(sample => sample[key]), 0.95)),
  });
  return {
    samples: samples.length,
    update: summarize('updateMs'),
    render: summarize('renderMs'),
    total: summarize('totalMs'),
    renderSegments: profile.renderTimings?.segments || [],
  };
}

async function measureFrames(page, durationMs) {
  return page.evaluate(async measurementMs => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const fpsSamples = [];
    const renderer = window.__claudeVilleApp?.renderer;
    if (renderer) {
      renderer._fpsFrames = 0;
      renderer._fpsWindowStart = performance.now();
    }
    const unsubscribe = eventBus.on('fps:updated', value => {
      if (Number.isFinite(value)) fpsSamples.push(value);
    });
    const deltas = await new Promise(resolve => {
      const values = [];
      const startedAt = performance.now();
      let previous = startedAt;
      const tick = now => {
        if (now > startedAt) values.push(now - previous);
        previous = now;
        if (now - startedAt >= measurementMs) resolve(values);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    unsubscribe?.();
    return { fpsSamples, deltas };
  }, durationMs);
}

async function startQualityTimeline(page) {
  await page.evaluate(() => {
    const startedAt = performance.now();
    const entries = [];
    let lastLevel;
    const sample = () => {
      const health = window.__claudeVillePerf?.frameHealth?.() || null;
      const gpu = window.__claudeVilleApp?.renderer?.gpuWorld?.getDiagnostics?.() || null;
      const qualityLevel = health?.qualityLevel ?? null;
      if (qualityLevel === null) return;
      if (entries.length && qualityLevel === lastLevel) return;
      lastLevel = qualityLevel;
      entries.push({
        elapsedMs: Math.round(performance.now() - startedAt),
        qualityLevel,
        qualityReason: health?.qualityReason ?? null,
        gpuMs: Number.isFinite(health?.gpuMs) ? health.gpuMs : null,
        lights: gpu?.lights ?? null,
      });
    };
    sample();
    const interval = setInterval(sample, 250);
    window.__claudeVilleBenchmarkQualityTimeline = {
      entries,
      sample,
      stop() {
        clearInterval(interval);
        sample();
        return entries;
      },
    };
  });
}

async function stopQualityTimeline(page) {
  return page.evaluate(() => {
    const tracker = window.__claudeVilleBenchmarkQualityTimeline;
    const entries = tracker?.stop?.() || [];
    delete window.__claudeVilleBenchmarkQualityTimeline;
    return entries;
  });
}

async function runCase(browser, options, count, weatherName, repetition) {
  const loadAverageStart = os.loadavg();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  const pageUrl = new URL(options.url);
  pageUrl.searchParams.set('sim', '1');
  pageUrl.searchParams.set('scenario', `perf-${count}-agents`);
  for (const [key, value] of Object.entries(buildWorldQuery(options))) pageUrl.searchParams.set(key, value);

  try {
    await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await startQualityTimeline(page);
    await page.waitForFunction(expectedCount => {
      const app = window.__claudeVilleApp;
      return app?._bootState === 'ready'
        && app?.renderer?.agentSprites?.size === expectedCount
        && app?.world?.getStats?.().working === expectedCount
        && typeof window.cameraSet === 'function'
        && typeof window.__claudeVillePerf?.canvasBudget === 'function';
    }, count, { timeout: 60_000 });

    const weather = WEATHER_PROFILES[weatherName];
    await page.evaluate(({ cameraPose, fixedDate, weatherProfile }) => {
      const renderer = window.__claudeVilleApp.renderer;
      renderer.cameraDirector?.setAutoMode?.(false);
      window.cameraSet(cameraPose);
      const atmosphere = renderer.atmosphereState;
      atmosphere.clear();
      // WorldFrameRenderer supplies a live date every frame. Override only this
      // fixture's atmosphere clock so the rain case cannot become winter snow.
      const updateAtmosphere = atmosphere.update.bind(atmosphere);
      const fixedNow = new Date(fixedDate);
      atmosphere.update = (options = {}) => updateAtmosphere({ ...options, now: fixedNow });
      atmosphere.setTimelineMode('fixed');
      atmosphere.setHour(12);
      atmosphere.setSeed(weatherProfile.seed);
      atmosphere.setWeather(weatherProfile);
      if (renderer.weatherRenderer) renderer.weatherRenderer.elapsedMs = 0;
    }, { cameraPose: CAMERA_POSE, fixedDate: FIXED_DATE, weatherProfile: weather });

    await page.waitForFunction(expectedWeather => {
      const atmosphere = window.__claudeVilleApp?.renderer?._lastAtmosphere;
      return atmosphere?.weather?.type === expectedWeather
        && atmosphere?.motion?.particleEnabled === true;
    }, weatherName);
    await sleep(options.warmupSeconds * 1000);

    if (options.profile) {
      await page.evaluate(() => window.__claudeVillePerf.startFrameProfile());
    }
    const measured = await measureFrames(page, options.durationSeconds * 1000);
    const profile = options.profile
      ? await page.evaluate(() => window.__claudeVillePerf.stopFrameProfile())
      : null;
    const qualityTimeline = await stopQualityTimeline(page);
    if (!measured.fpsSamples.length) throw new Error('no fps:updated samples were recorded');
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);

    const snapshot = await page.evaluate(() => {
      const app = window.__claudeVilleApp;
      const renderer = app?.renderer;
      const canvasBudget = window.__claudeVillePerf?.canvasBudget?.() || null;
      const postFx = renderer?.postFx?.getDiagnostics?.() || null;
      const postFxFeed = renderer?.postFxFeed?.getDiagnostics?.() || null;
      return {
        agents: app?.world?.agents?.size ?? null,
        working: app?.world?.getStats?.().working ?? null,
        weather: renderer?._lastAtmosphere?.weather || null,
        effectiveMonth: renderer?._lastAtmosphere?.effectiveDate?.getMonth?.() ?? null,
        particleEnabled: renderer?._lastAtmosphere?.motion?.particleEnabled ?? null,
        renderMode: renderer?._lastRenderStats?.quality?.agentRenderMode || null,
        canvasDpr: canvasBudget?.dpr ?? null,
        visibleCanvasPixels: canvasBudget?.visibleCanvasPixels ?? null,
        particles: renderer?._lastRenderStats?.canvas?.particles ?? null,
        frameFailures: canvasBudget?.runtime?.frameFailures || null,
        postFx,
        postFxFeed,
        gpuWorld: renderer?.gpuWorld?.getDiagnostics?.() || null,
        worldRendererMode: renderer?.worldRendererMode ?? null,
        resources: canvasBudget?.resources || null,
        trails: renderer?.trailRenderer?.getDiagnostics?.() || null,
      };
    });

    if (snapshot.agents !== count || snapshot.working !== count) {
      throw new Error(`expected ${count} active agents, received ${snapshot.agents}/${snapshot.working}`);
    }
    if (snapshot.weather?.type !== weatherName || snapshot.particleEnabled !== true) {
      throw new Error(`weather control failed for ${weatherName}`);
    }
    if (snapshot.effectiveMonth !== 4) {
      throw new Error(`fixed benchmark date drifted to month ${snapshot.effectiveMonth}`);
    }

    return {
      type: 'run',
      count,
      weather: weatherName,
      repetition,
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      hostLoadAverage: { start: loadAverageStart, end: os.loadavg() },
      uiFps: summarizeFps(measured.fpsSamples),
      frames: summarizeFrames(measured.deltas),
      qualityTimeline,
      profile: summarizeProfile(profile),
      snapshot,
    };
  } finally {
    await context.close();
  }
}

function summarizeRuns(runs) {
  const cases = [];
  for (const count of [...new Set(runs.map(run => run.count))].sort((a, b) => a - b)) {
    for (const weather of [...new Set(runs.map(run => run.weather))]) {
      const matches = runs.filter(run => run.count === count && run.weather === weather);
      if (!matches.length) continue;
      cases.push({
        count,
        weather,
        repetitions: matches.length,
        medianFps: round(percentile(matches.map(run => run.uiFps.median), 0.5), 1),
        p10Fps: round(percentile(matches.map(run => run.uiFps.p10), 0.5), 1),
        rawFps: round(percentile(matches.map(run => run.frames.fps), 0.5), 1),
        frameP95Ms: round(percentile(matches.map(run => run.frames.p95Ms), 0.5)),
      });
    }
  }
  for (const item of cases) {
    const clear = cases.find(candidate => candidate.count === item.count && candidate.weather === 'clear');
    if (item.weather === 'rain' && clear?.medianFps) {
      item.fpsChangeVsClearPct = round(((item.medianFps / clear.medianFps) - 1) * 100, 1);
    }
  }
  return cases;
}

async function runMatrix(options) {
  const server = await resolveServer(options.urlExplicit ? options.url : null);
  options = { ...options, url: server.baseUrl };
  let browser = null;
  const runs = [];
  try {
    browser = await launchBenchBrowser(options);
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const weatherOrder = repetition % 2 === 0 ? [...options.weather].reverse() : options.weather;
      const countOrder = repetition % 2 === 0 ? [...options.counts].reverse() : options.counts;
      for (const count of countOrder) {
        for (const weather of weatherOrder) {
          const result = await runCase(browser, options, count, weather, repetition);
          runs.push(result);
          console.log(JSON.stringify(result));
        }
      }
    }
    const cpu = os.cpus()[0];
    const cases = summarizeRuns(runs);
    const rainRegressionViolations = options.maxRainRegressionPct == null
      ? []
      : cases
        .filter(item => item.weather === 'rain')
        .filter(item => (
          !Number.isFinite(item.fpsChangeVsClearPct)
          || item.fpsChangeVsClearPct < -options.maxRainRegressionPct
        ))
        .map(item => ({
          count: item.count,
          fpsChangeVsClearPct: item.fpsChangeVsClearPct,
          maxRainRegressionPct: options.maxRainRegressionPct,
        }));
    const summary = {
      type: 'summary',
      ok: rainRegressionViolations.length === 0,
      url: server.isolated ? 'isolated' : options.url,
      browserVersion: browser.version(),
      environment: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpu: cpu?.model || null,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        loadAverage: os.loadavg(),
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        fixedDate: FIXED_DATE,
      },
      options: {
        counts: options.counts,
        weather: options.weather,
        durationSeconds: options.durationSeconds,
        warmupSeconds: options.warmupSeconds,
        repetitions: options.repetitions,
        profile: options.profile,
        headed: options.headed,
        maxRainRegressionPct: options.maxRainRegressionPct,
      },
      cases,
      rainRegressionViolations,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify({ summary, runs }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// Ladder and receipt modes (plan 0.1, V2). Every run is a fresh context on a
// pinned pose; the ladder runs free except in the receipt modes, which force
// a level.

// rAF p95 may sit this far above the latched period (17.5 ms at 60 Hz,
// 8.75 ms at 120 Hz) before a soak row fails.
const RAF_P95_PERIOD_RATIO = 1.05;
const DASHBOARD_RETURN_BUDGET_MS = 1000;
const INJECT_SHED_BUDGET_MS = 2000;

function* ladderCases(options) {
  for (const scenario of options.scenarios) {
    for (const viewport of options.viewports) {
      for (const zoom of options.zooms) {
        for (const condition of options.conditions) {
          yield {
            scenario,
            viewport: `${viewport.width}x${viewport.height}`,
            width: viewport.width,
            height: viewport.height,
            dpr: options.dpr,
            zoom,
            hour: condition.hour,
            weather: condition.weather,
            renderer: options.renderer,
            postfx: options.postfx,
            frontier: options.frontier,
            disableGpu: options.disableGpu,
            sidebar: options.sidebar,
            cameraMode: options.cameraMode,
            tile: options.tile,
            reducedMotion: options.reducedMotion,
          };
        }
      }
    }
  }
}

function caseFields(spec) {
  return {
    scenario: spec.scenario,
    viewport: spec.viewport,
    dpr: spec.dpr,
    zoom: spec.zoom,
    hour: spec.hour,
    weather: spec.weather,
    renderer: spec.renderer || 'default',
    ...(spec.postfx && spec.postfx !== 'default' ? { postfx: spec.postfx } : {}),
    ...(spec.frontier && spec.frontier !== 'default' ? { frontier: spec.frontier } : {}),
    ...(spec.disableGpu ? { disableGpu: true } : {}),
  };
}

// Wait for boot, opening glide, backend handover (e.g. WebGL2 -> WebGPU),
// terrain cache, Frontier pass compilation, and remaining cache-stabilization
// warm-up time. Keeps Shift-D closed for timed runs.
async function waitForWorldWarmup(page, { warmupSeconds = 0, expectFrontier = false, initialGlideMs = 4500 } = {}) {
  const startedAt = performance.now();
  await page.evaluate(() => {
    const renderer = window.__claudeVilleApp?.renderer;
    if (renderer?.debugOverlay) renderer.debugOverlay.enabled = false;
  });
  if (initialGlideMs > 0) await sleep(initialGlideMs);

  // Hardware compilation can outlast a short sampling warmup.
  const settleBudgetMs = Math.max(expectFrontier ? 60_000 : 5_000, warmupSeconds * 1000);
  try {
    await page.waitForFunction(({ wantFrontier }) => {
      const app = window.__claudeVilleApp;
      const renderer = app?.renderer;
      if (app?._bootState !== 'ready' || !renderer?.camera) return false;
      if (renderer._pendingWebGpu || renderer._worldSwap || renderer._fallbackPrep) return false;
      if (wantFrontier && renderer.gpuWorld?.frontierEnabled) {
        const frontier = renderer.gpuWorld.getDiagnostics?.()?.frontier;
        if (frontier?.passes) {
          const config = renderer.gpuWorld.frontierConfig;
          const required = Object.entries(frontier.passes).filter(([name]) =>
            config?.[name] !== false && (name !== 'shafts' || config?.surfaceDepth !== false));
          if (!frontier.featureMask || required.some(([, entry]) => !entry.ready && !entry.error)) return false;
        }
      }
      return true;
    }, { wantFrontier: expectFrontier }, { timeout: settleBudgetMs });
  } catch {
    // Proceeding after timeout still records exact afterWarmup state so gates catch any incomplete readiness.
  }

  const targetMs = initialGlideMs + warmupSeconds * 1000;
  const remainingMs = targetMs - (performance.now() - startedAt);
  if (remainingMs > 0) await sleep(remainingMs);
}

// Boot, let the opening glide finish, pose, warm up, and re-assert the pose
// (director and idle glides can steal it).
async function openPosedWorld(browser, baseUrl, spec, warmupSeconds, { requireGpu = true } = {}) {
  const query = buildWorldQuery({
    renderer: spec.renderer,
    postfx: spec.postfx,
    frontier: spec.frontier,
  });
  const opened = await openWorld(browser, {
    baseUrl,
    scenario: spec.scenario,
    width: spec.width,
    height: spec.height,
    dpr: spec.dpr,
    query,
    reducedMotion: spec.reducedMotion === true,
    sidebar: spec.sidebar || 'default',
    autoCamera: spec.cameraMode === 'auto',
  });
  try {
    await sleep(4500);
    const pose = await poseWorld(opened.page, {
      hour: spec.hour,
      weather: spec.weather,
      zoom: spec.zoom,
      tile: spec.tile || [20, 20],
      autoCamera: spec.cameraMode === 'auto',
    });
    if (requireGpu && !pose.gpuWorldActive) throw new Error(`resident GPU world inactive for ${spec.scenario} ${spec.viewport}`);
    await waitForWorldWarmup(opened.page, {
      warmupSeconds,
      expectFrontier: spec.frontier === 'on',
      initialGlideMs: 0,
    });
    const settledPose = await poseWorld(opened.page, {
      hour: spec.hour,
      weather: spec.weather,
      zoom: spec.zoom,
      tile: spec.tile || [20, 20],
      autoCamera: spec.cameraMode === 'auto',
    });
    const afterWarmup = await readWorldStateSnapshot(opened.page);
    return { ...opened, pose: settledPose, afterWarmup };
  } catch (error) {
    await opened.context.close();
    throw error;
  }
}

// In-page recorder: every rAF interval with the effective level (-1 while the
// resident world is inactive), each level change with its reason, and a 2 s
// diagnostic sample (reason, pacing, timer, admission, shed rows).
function installLadderRecorder(page, capacity) {
  return page.evaluate((capacityFrames) => {
    const renderer = window.__claudeVilleApp.renderer;
    const recorder = {
      gaps: new Float32Array(capacityFrames),
      levels: new Int8Array(capacityFrames),
      times: new Float64Array(capacityFrames),
      count: 0,
      transitions: [],
      samples: [],
      running: true,
      lastTs: null,
      lastLevel: null,
    };
    const levelNow = () => {
      const gpu = renderer.gpuWorld;
      return gpu?.isActive?.() ? gpu.qualityLadder.getLevel() : -1;
    };
    const tick = (ts) => {
      if (!recorder.running) return;
      const level = levelNow();
      if (recorder.lastTs !== null && recorder.count < capacityFrames) {
        recorder.gaps[recorder.count] = ts - recorder.lastTs;
        recorder.levels[recorder.count] = level;
        recorder.times[recorder.count] = ts;
        recorder.count += 1;
      }
      if (level !== recorder.lastLevel) {
        const state = renderer.gpuWorld?.qualityLadder?.getState?.();
        recorder.transitions.push({
          t: ts,
          from: recorder.lastLevel,
          to: level,
          reason: level < 0 ? 'inactive' : state?.lastTransitionReason ?? state?.lastDecisionReason ?? null,
        });
        recorder.lastLevel = level;
      }
      recorder.lastTs = ts;
      requestAnimationFrame(tick);
    };
    recorder.sample = () => {
      const gpu = renderer.gpuWorld;
      if (!gpu?.isActive?.()) return;
      const diagnostics = gpu.getDiagnostics();
      recorder.samples.push({
        t: performance.now(),
        level: diagnostics.qualityLevel,
        reason: diagnostics.qualityReason,
        refreshHz: diagnostics.pacing?.refreshHz ?? null,
        periodMs: diagnostics.pacing?.periodMs ?? null,
        budgetMs: diagnostics.pacing?.budgetMs ?? null,
        missShare: diagnostics.pacing?.missShare ?? null,
        timerVeto: diagnostics.pacing?.timerVeto ?? null,
        gpuMsP25: diagnostics.gpuMsP25,
        gpuMs: diagnostics.gpuMs,
        gpuTimerEvery: diagnostics.gpuTimerEvery,
        lights: diagnostics.lights,
        lightAdmission: diagnostics.lightAdmission,
        shed: diagnostics.shedEffects.map(effect => `${effect.id} ${effect.mode}`),
      });
    };
    recorder.interval = setInterval(recorder.sample, 2000);
    requestAnimationFrame(tick);
    window.__cvLadderRecorder = recorder;
    return performance.now();
  }, capacity);
}

function readLadderRecorder(page) {
  return page.evaluate(() => {
    const recorder = window.__cvLadderRecorder;
    recorder.running = false;
    clearInterval(recorder.interval);
    recorder.sample();
    delete window.__cvLadderRecorder;
    const count = recorder.count;
    return {
      frames: Array.from(recorder.times.subarray(0, count), (t, index) => [t, recorder.gaps[index], recorder.levels[index]]),
      transitions: recorder.transitions.filter(item => item.from !== null),
      samples: recorder.samples,
    };
  });
}

function summarizeLadderWindow(frames, fromMs, toMs) {
  const byLevel = {};
  const gaps = [];
  let changes = 0;
  let previous = null;
  for (const [t, gap, level] of frames) {
    if (t < fromMs || t >= toMs) continue;
    byLevel[level] = (byLevel[level] || 0) + 1;
    if (previous !== null && level !== previous) changes += 1;
    previous = level;
    gaps.push(gap);
  }
  const total = gaps.length || 1;
  const minutes = Math.max(1e-9, (toMs - fromMs) / 60000);
  return {
    frames: gaps.length,
    seconds: roundTo((toMs - fromMs) / 1000, 1),
    levelShare: Object.fromEntries(Object.entries(byLevel).map(([level, count]) => [level, roundTo(count / total, 4)])),
    fullShare: roundTo((byLevel[0] || 0) / total, 4),
    levelChanges: changes,
    changesPerMinute: roundTo(changes / minutes, 2),
    raf: {
      p50: roundTo(quantile(gaps, 0.5), 2),
      p95: roundTo(quantile(gaps, 0.95), 2),
      p99: roundTo(quantile(gaps, 0.99), 2),
      max: roundTo(gaps.length ? Math.max(...gaps) : null, 2),
    },
  };
}

// Every cap Shift-D's shed line reports: the rows below FULL, plus the light
// admission whenever it drops offered lights.
function capLines(samples) {
  const lines = {};
  for (const sample of samples) {
    const caps = [...sample.shed];
    const admission = sample.lightAdmission;
    if (admission && !admission.daylight && admission.offered > admission.cap
      && !caps.some(cap => cap.startsWith('light-admission'))) {
      caps.push(`light-admission ${admission.cap}`);
    }
    const key = `level ${sample.level}: ${caps.join(', ') || 'none'}`;
    lines[key] = (lines[key] || 0) + 1;
  }
  return lines;
}

function reasonCounts(samples) {
  const counts = {};
  for (const sample of samples) counts[sample.reason] = (counts[sample.reason] || 0) + 1;
  return counts;
}

function relativeTransitions(transitions, originMs) {
  return transitions.map(item => ({ ...item, t: roundTo(item.t - originMs, 0) }));
}

async function runSoak(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose, afterWarmup } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds, {
    requireGpu: spec.renderer !== 'canvas' && !spec.disableGpu && spec.postfx !== 'off',
  });
  try {
    const durationMs = options.durationSeconds * 1000;
    const startedAt = await installLadderRecorder(page, Math.ceil(options.durationSeconds * 300) + 600);
    await sleep(durationMs);
    const recorded = await readLadderRecorder(page);
    const atEnd = await readWorldStateSnapshot(page);
    const soak = summarizeLadderWindow(recorded.frames, startedAt, startedAt + durationMs);
    const last = recorded.samples.at(-1) || null;
    const periodMs = last?.periodMs ?? null;
    return {
      type: 'run',
      mode: 'soak',
      ...caseFields(spec),
      repetition,
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      pose,
      afterWarmup,
      atEnd,
      effectiveBackend: {
        afterWarmup: afterWarmup?.backend ?? null,
        atEnd: atEnd?.backend ?? null,
        stable: afterWarmup?.backend === atEnd?.backend,
        postFxActive: atEnd?.postFx?.active === true,
        frontierEnabled: atEnd?.frontier?.enabled === true,
        frontierFeatureMask: atEnd?.frontier?.featureMask ?? 0,
      },
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      latchedHz: last?.refreshHz ?? null,
      periodMs: roundTo(periodMs, 2),
      ...soak,
      acceptance: {
        fullShareAtLeast98: soak.fullShare >= 0.98,
        atMostOneChangePerMinute: soak.changesPerMinute <= 1,
        rafP95WithinPeriod: Number.isFinite(periodMs) && soak.raf.p95 <= periodMs * RAF_P95_PERIOD_RATIO,
      },
      transitions: relativeTransitions(recorded.transitions.filter(item => item.t >= startedAt), startedAt),
      reasons: reasonCounts(recorded.samples),
      capLines: capLines(recorded.samples),
      final: last,
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

async function runInject(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds);
  try {
    const seconds = options.baselineSeconds + options.loadSeconds + options.recoverSeconds;
    const startedAt = await installLadderRecorder(page, Math.ceil(seconds * 300) + 600);
    await sleep(options.baselineSeconds * 1000);
    const loadOnAt = await page.evaluate(({ passes, levels }) => {
      window.__claudeVilleApp.renderer.gpuWorld.setDebugLoad({ passes, levels });
      return performance.now();
    }, { passes: options.loadPasses, levels: options.loadLevels });
    await sleep(options.loadSeconds * 1000);
    const loadOffAt = await page.evaluate(() => {
      window.__claudeVilleApp.renderer.gpuWorld.setDebugLoad(null);
      return performance.now();
    });
    await sleep(options.recoverSeconds * 1000);
    const recorded = await readLadderRecorder(page);
    const frames = recorded.frames;
    const baselineLevel = frames.filter(([t]) => t < loadOnAt).at(-1)?.[2] ?? null;
    const firstShed = frames.find(([t, , level]) => t >= loadOnAt && t < loadOffAt && level > baselineLevel);
    // Recovered: from this frame on the level stays at the pre-load level to
    // the end of the observation window.
    let recoveredAt = null;
    for (let index = frames.length - 1; index >= 0 && frames[index][0] >= loadOffAt; index--) {
      if (frames[index][2] !== baselineLevel) break;
      recoveredAt = frames[index][0];
    }
    const firstShedMs = firstShed ? roundTo(firstShed[0] - loadOnAt, 0) : null;
    const recoveredMs = recoveredAt === null ? null : roundTo(recoveredAt - loadOffAt, 0);
    return {
      type: 'run',
      mode: 'inject',
      ...caseFields(spec),
      repetition,
      load: { passes: options.loadPasses, levels: options.loadLevels, seconds: options.loadSeconds },
      pose,
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      latchedHz: recorded.samples.at(-1)?.refreshHz ?? null,
      baselineLevel,
      firstShedMs,
      recoveredMs,
      acceptance: {
        shedWithin2s: firstShedMs !== null && firstShedMs <= INJECT_SHED_BUDGET_MS,
        recoveredAfterRemoval: recoveredMs !== null,
      },
      baseline: summarizeLadderWindow(frames, startedAt, loadOnAt),
      loaded: summarizeLadderWindow(frames, loadOnAt, loadOffAt),
      after: summarizeLadderWindow(frames, loadOffAt, loadOffAt + options.recoverSeconds * 1000),
      transitions: relativeTransitions(recorded.transitions.filter(item => item.t >= startedAt), loadOnAt),
      reasons: reasonCounts(recorded.samples),
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

async function runDashboard(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds);
  const observeMs = 5000;
  try {
    const seconds = options.returns * (options.awaySeconds + observeMs / 1000 + 1);
    await installLadderRecorder(page, Math.ceil(seconds * 300) + 600);
    const trips = [];
    for (let index = 0; index < options.returns; index++) {
      const before = await page.evaluate(() => {
        const state = window.__claudeVilleApp.renderer.gpuWorld.qualityLadder.getState();
        return { level: state.effectiveLevel, refreshHz: state.refreshHz };
      });
      await page.evaluate(() => window.__claudeVilleApp.modeManager.switchMode('dashboard'));
      await sleep(options.awaySeconds * 1000);
      const backAt = await page.evaluate(() => {
        window.__claudeVilleApp.modeManager.switchMode('character');
        return performance.now();
      });
      await sleep(observeMs);
      trips.push({ before, backAt });
    }
    const recorded = await readLadderRecorder(page);
    const returns = trips.map(({ before, backAt }) => {
      const after = recorded.frames.filter(([t]) => t >= backAt && t < backAt + observeMs);
      const firstActive = after.find(([, , level]) => level >= 0);
      const reached = after.find(([, , level]) => level === before.level);
      const reachedIndex = reached ? after.indexOf(reached) : -1;
      return {
        levelBefore: before.level,
        refreshHzBefore: before.refreshHz,
        firstFrameMs: firstActive ? roundTo(firstActive[0] - backAt, 0) : null,
        levelOnReturn: firstActive ? firstActive[2] : null,
        reachedPreviousMs: reached ? roundTo(reached[0] - backAt, 0) : null,
        heldAfterReaching: reachedIndex >= 0 && after.slice(reachedIndex).every(([, , level]) => level === before.level),
      };
    });
    return {
      type: 'run',
      mode: 'dashboard',
      ...caseFields(spec),
      repetition,
      awaySeconds: options.awaySeconds,
      pose,
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      returns,
      acceptance: {
        previousLevelWithin1s: returns.every(item => item.reachedPreviousMs !== null
          && item.reachedPreviousMs <= DASHBOARD_RETURN_BUDGET_MS),
      },
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

async function runKSlope(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose } = await openPosedWorld(browser, baseUrl, spec, 0);
  try {
    await page.evaluate((level) => {
      const gpu = window.__claudeVilleApp.renderer.gpuWorld;
      window.__claudeVilleApp.renderer._forceFreshGpuOutput = true;
      gpu.setPassSamplingEnabled(false);
      gpu.qualityLadder.setOverride(level);
    }, options.level);
    await sleep(options.warmupSeconds * 1000);
    const unit = options.candidatePasses;
    // A/A arms carry the K labels with no work: their slope is the noise floor.
    const schedule = [
      { id: 'aa0', passes: 0 }, { id: 'aa1', passes: 0 }, { id: 'aa8', passes: 0 },
      { id: 'k0', passes: 0 }, { id: 'k1', passes: unit }, { id: 'k8', passes: 8 * unit },
    ];
    await page.evaluate((arms) => window.__claudeVilleApp.renderer.gpuWorld.setDebugLoad({ schedule: arms }), schedule);
    await sleep(2000);
    await page.evaluate(() => window.__claudeVilleApp.renderer.gpuWorld.takeDebugLoadSamples());
    await sleep(options.durationSeconds * 1000);
    const taken = await page.evaluate(() => {
      const gpu = window.__claudeVilleApp.renderer.gpuWorld;
      const samples = gpu.takeDebugLoadSamples();
      gpu.setDebugLoad(null);
      gpu.qualityLadder.setOverride(null);
      window.__claudeVilleApp.renderer._forceFreshGpuOutput = false;
      const state = gpu.qualityLadder.getState();
      return { samples, refreshHz: state.refreshHz, backing: [gpu.width, gpu.height] };
    });
    const arms = Object.fromEntries(Object.entries(taken.samples || {}).map(([id, values]) => [id, {
      n: values.length,
      p50: roundTo(medianOf(values), 4),
      p25: roundTo(quantile(values, 0.25), 4),
    }]));
    const at = id => arms[id]?.p50 ?? NaN;
    const priceMs = (at('k8') - at('k0')) / (8 * unit);
    const aaSlopeMs = (at('aa8') - at('aa0')) / 8;
    return {
      type: 'run',
      mode: 'kslope',
      ...caseFields(spec),
      repetition,
      level: options.level,
      candidate: `${unit} present pass${unit === 1 ? '' : 'es'} per K`,
      durationSeconds: options.durationSeconds,
      refreshHz: taken.refreshHz,
      backing: taken.backing,
      pose,
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      arms,
      priceMs: roundTo(priceMs, 4),
      dK1Ms: roundTo((at('k1') - at('k0')) / unit, 4),
      aaSlopeMs: roundTo(aaSlopeMs, 4),
      resolved: Number.isFinite(priceMs) && Math.abs(priceMs) > 2 * Math.abs(aaSlopeMs),
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

async function runUnlocked(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds);
  try {
    // Alternating 60-frame blocks at forced FULL and MINIMAL; the first five
    // intervals of a block still carry the previous level's frames.
    const measured = await page.evaluate((durationMs) => new Promise((resolve) => {
      const renderer = window.__claudeVilleApp.renderer;
      const gpu = renderer.gpuWorld;
      const previousFreshOutput = renderer._forceFreshGpuOutput;
      renderer._forceFreshGpuOutput = true;
      // The rAF interval is the frame's cost only if every tick renders:
      // lift the 60 fps cap (FP-1a) for the receipt.
      const pacedLoop = renderer._loop;
      renderer._loop = function uncappedLoop(frameTime) {
        this._framePacing.lastRenderMs = null;
        return pacedLoop.call(this, frameTime);
      };
      const previous = gpu.qualityLadder.getState().override;
      const block = 60;
      const skip = 5;
      const arms = { 0: [], 2: [] };
      let arm = 0;
      let frame = 0;
      let last = null;
      const started = performance.now();
      gpu.qualityLadder.setOverride(arm);
      const tick = (ts) => {
        if (last !== null && frame % block >= skip) arms[arm].push(ts - last);
        last = ts;
        frame += 1;
        if (frame % block === 0) {
          arm = arm === 0 ? 2 : 0;
          gpu.qualityLadder.setOverride(arm);
        }
        if (ts - started >= durationMs) {
          gpu.qualityLadder.setOverride(previous);
          renderer._forceFreshGpuOutput = previousFreshOutput;
          renderer._loop = pacedLoop;
          resolve({ arms, backing: [gpu.width, gpu.height] });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    }), options.durationSeconds * 1000);
    const full = measured.arms[0];
    const minimal = measured.arms[2];
    const stats = values => ({
      n: values.length,
      p50: roundTo(quantile(values, 0.5), 3),
      p95: roundTo(quantile(values, 0.95), 3),
    });
    const fullStats = stats(full);
    const minimalStats = stats(minimal);
    return {
      type: 'run',
      mode: 'unlocked',
      ...caseFields(spec),
      repetition,
      backing: measured.backing,
      pose,
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      full: fullStats,
      minimal: minimalStats,
      deltaP50Ms: roundTo(fullStats.p50 - minimalStats.p50, 3),
      deltaP95Ms: roundTo(fullStats.p95 - minimalStats.p95, 3),
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

// FP-11 — idle power. No input reaches the page (FP-1b holds 60 fps for 1 s
// after pointer input). In-page counters wrap the renderer's own `_update`
// (one call per admitted frame) and `_render` (one per painted frame); the
// GPU world's diagnostics give its submitted frames. CPU comes from /proc
// for the launched browser's whole tree, by process type.
async function runIdle(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const { context, page, errors, pose, afterWarmup } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds, {
    requireGpu: spec.renderer !== 'canvas' && !spec.disableGpu && spec.postfx !== 'off',
  });
  try {
    const durationMs = options.durationSeconds * 1000;
    const cpuStart = procTreeCpuSeconds(options.rootPid);
    const wallStart = performance.now();
    const measured = await page.evaluate(async (windowMs) => {
      const renderer = window.__claudeVilleApp.renderer;
      const counts = { ticks: 0, updates: 0, ambientUpdates: 0, paints: 0 };
      const paintIntervals = [];
      let lastPaintTs = null;
      const startGen = renderer.presentGeneration ?? 0;
      const loop = renderer._loop;
      const update = renderer._update;
      const render = renderer._render;
      renderer._update = function countedUpdate(...args) {
        counts.updates++;
        if (this._framePacing?.ambient) counts.ambientUpdates++;
        return update.apply(this, args);
      };
      renderer._render = function countedRender(...args) {
        counts.paints++;
        return render.apply(this, args);
      };
      renderer._loop = function countedLoop(...args) {
        const prevGen = this.presentGeneration ?? 0;
        const result = loop.apply(this, args);
        if ((this.presentGeneration ?? 0) > prevGen) {
          const now = performance.now();
          if (lastPaintTs !== null) paintIntervals.push(now - lastPaintTs);
          lastPaintTs = now;
        }
        return result;
      };
      const gpuStart = renderer.gpuWorld?.getDiagnostics?.() || null;
      const started = performance.now();
      await new Promise((resolve) => {
        const tick = (ts) => {
          counts.ticks++;
          if (ts - started >= windowMs) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const seconds = (performance.now() - started) / 1000;
      delete renderer._loop;
      delete renderer._update;
      delete renderer._render;
      const endGen = renderer.presentGeneration ?? 0;
      const gpuEnd = renderer.gpuWorld?.getDiagnostics?.() || null;
      let pacing = null;
      try {
        pacing = await import('/src/presentation/character-mode/FramePacing.js');
      } catch { /* a build without the module */ }
      return {
        seconds,
        counts,
        successfulPaints: Math.max(0, endGen - startGen),
        paintIntervals,
        // `frames` counts submitted frames; a byte-gate reuse is `skippedFrames`.
        gpuSubmits: gpuStart && gpuEnd ? gpuEnd.frames - gpuStart.frames : null,
        gpuReused: gpuStart && gpuEnd ? (gpuEnd.skippedFrames || 0) - (gpuStart.skippedFrames || 0) : null,
        ambientPacing: pacing?.AMBIENT_FRAME_PACING === true,
        motionScale: renderer.motionScale ?? null,
        level: renderer.gpuWorld?.qualityLadder?.getLevel?.() ?? null,
      };
    }, durationMs);
    const wallSeconds = (performance.now() - wallStart) / 1000;
    const cpuEnd = procTreeCpuSeconds(options.rootPid);
    const atEnd = await readWorldStateSnapshot(page);
    // A walking scene's reference: the same page with the ambient cadence
    // forced off, so "not paced down" holds on a host that cannot reach 60.
    const referenceFps = measured.ambientPacing && !AMBIENT_SCENARIOS.has(spec.scenario) && !spec.reducedMotion
      ? await page.evaluate(async (windowMs) => {
        const renderer = window.__claudeVilleApp.renderer;
        let updates = 0;
        const update = renderer._update;
        renderer._ambientTick = () => false;
        renderer._update = function countedUpdate(...args) {
          updates++;
          return update.apply(this, args);
        };
        const started = performance.now();
        await new Promise(resolve => setTimeout(resolve, windowMs));
        delete renderer._update;
        delete renderer._ambientTick;
        return Math.round((updates / ((performance.now() - started) / 1000)) * 10) / 10;
      }, Math.min(durationMs, 8000))
      : null;
    const cores = {};
    for (const key of new Set([...Object.keys(cpuStart), ...Object.keys(cpuEnd)])) {
      cores[key] = roundTo(((cpuEnd[key] || 0) - (cpuStart[key] || 0)) / wallSeconds, 3);
    }
    const appCores = (cores.renderer || 0) + (cores.gpu || 0);
    const perSecond = value => (Number.isFinite(value) ? roundTo(value / measured.seconds, 1) : null);
    // Under reduced motion no body walks (it cuts to its route's end).
    const sceneClass = AMBIENT_SCENARIOS.has(spec.scenario) || spec.reducedMotion ? 'ambient' : 'walking';
    const renderedFps = perSecond(measured.counts.updates);
    return {
      type: 'run',
      mode: 'idle',
      ...caseFields(spec),
      reducedMotion: spec.reducedMotion === true,
      sceneClass,
      repetition,
      durationSeconds: options.durationSeconds,
      pose,
      afterWarmup,
      atEnd,
      effectiveBackend: {
        afterWarmup: afterWarmup?.backend ?? null,
        atEnd: atEnd?.backend ?? null,
        stable: afterWarmup?.backend === atEnd?.backend,
        postFxActive: atEnd?.postFx?.active === true,
        frontierEnabled: atEnd?.frontier?.enabled === true,
        frontierFeatureMask: atEnd?.frontier?.featureMask ?? 0,
      },
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      ambientPacing: measured.ambientPacing,
      motionScale: measured.motionScale,
      level: measured.level,
      rafFps: perSecond(measured.counts.ticks),
      renderedFps,
      paintedFps: perSecond(measured.counts.paints),
      successfulPaints: measured.successfulPaints,
      paintsPerSec: roundTo(measured.successfulPaints / measured.seconds, 2),
      paintIntervalsMs: summarizeIntervals(measured.paintIntervals),
      gpuSubmitFps: perSecond(measured.gpuSubmits),
      gpuReusedFps: perSecond(measured.gpuReused),
      ambientShare: measured.counts.updates ? roundTo(measured.counts.ambientUpdates / measured.counts.updates, 3) : null,
      cores,
      appCores: roundTo(appCores, 3),
      cpuSecondsPerHour: {
        renderer: Math.round((cores.renderer || 0) * 3600),
        gpu: Math.round((cores.gpu || 0) * 3600),
        app: Math.round(appCores * 3600),
      },
      referenceFps,
      // Walking: never paced below the 60 fps cadence's own rate, and 59-61
      // fps wherever the host reaches 59 with the ambient cadence off.
      acceptance: measured.ambientPacing
        ? (sceneClass === 'ambient'
          ? { ambientAtMost31Fps: renderedFps <= 31 }
          : {
            walkingNotPacedDown: renderedFps >= referenceFps - 1.5,
            walkingAt59To61Fps: referenceFps < 59 || (renderedFps >= 59 && renderedFps <= 61),
          })
        : { atMost61Fps: renderedFps <= 61 },
      errors: errors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

function summarizeLadderRuns(mode, runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [run.scenario, run.viewport, run.dpr, run.zoom, run.hour, run.weather, run.reducedMotion].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()].map((matches) => {
    const base = { ...caseFields(matches[0]), repetitions: matches.length };
    const passes = matches.every(run => !run.acceptance || Object.values(run.acceptance).every(Boolean));
    if (mode === 'soak') {
      return {
        ...base,
        ok: passes,
        effectiveBackends: [...new Set(matches.flatMap(run => [run.effectiveBackend?.afterWarmup, run.effectiveBackend?.atEnd]).filter(Boolean))],
        backendStable: matches.every(run => run.effectiveBackend?.stable !== false),
        postFxActive: matches.some(run => run.effectiveBackend?.postFxActive === true),
        frontierEnabled: matches.some(run => run.effectiveBackend?.frontierEnabled === true),
        latchedHz: matches[0].latchedHz,
        minFullShare: Math.min(...matches.map(run => run.fullShare)),
        maxChangesPerMinute: Math.max(...matches.map(run => run.changesPerMinute)),
        maxRafP95Ms: Math.max(...matches.map(run => run.raf.p95)),
        capLines: Object.keys(Object.assign({}, ...matches.map(run => run.capLines))),
      };
    }
    if (mode === 'inject') {
      return {
        ...base,
        ok: passes,
        firstShedMs: matches.map(run => run.firstShedMs),
        recoveredMs: matches.map(run => run.recoveredMs),
      };
    }
    if (mode === 'dashboard') {
      return {
        ...base,
        ok: passes,
        reachedPreviousMs: matches.flatMap(run => run.returns.map(item => item.reachedPreviousMs)),
      };
    }
    if (mode === 'idle') {
      const median = key => roundTo(medianOf(matches.map(run => run[key])), 3);
      return {
        ...base,
        ok: passes && matches.every(run => run.errors.length === 0),
        effectiveBackends: [...new Set(matches.flatMap(run => [run.effectiveBackend?.afterWarmup, run.effectiveBackend?.atEnd]).filter(Boolean))],
        backendStable: matches.every(run => run.effectiveBackend?.stable !== false),
        postFxActive: matches.some(run => run.effectiveBackend?.postFxActive === true),
        frontierEnabled: matches.some(run => run.effectiveBackend?.frontierEnabled === true),
        reducedMotion: matches[0].reducedMotion,
        sceneClass: matches[0].sceneClass,
        ambientPacing: matches[0].ambientPacing,
        renderedFps: median('renderedFps'),
        paintedFps: median('paintedFps'),
        paintsPerSec: roundTo(medianOf(matches.map(run => run.paintsPerSec)), 2),
        paintGapP95Ms: roundTo(medianOf(matches.map(run => run.paintIntervalsMs?.p95Ms)), 2),
        gpuSubmitFps: median('gpuSubmitFps'),
        ambientShare: median('ambientShare'),
        rendererCores: roundTo(medianOf(matches.map(run => run.cores.renderer)), 3),
        gpuCores: roundTo(medianOf(matches.map(run => run.cores.gpu)), 3),
        appCpuSecondsPerHour: Math.round(medianOf(matches.map(run => run.cpuSecondsPerHour.app))),
      };
    }
    if (mode === 'kslope') {
      const prices = matches.map(run => run.priceMs);
      const aaSpreadMs = Math.max(...matches.map(run => Math.abs(run.aaSlopeMs)).filter(Number.isFinite));
      const priceMs = medianOf(prices);
      return {
        ...base,
        ok: matches.every(run => run.errors.length === 0),
        refreshHz: matches[0].refreshHz,
        priceMs: roundTo(priceMs, 4),
        prices,
        aaSpreadMs: roundTo(aaSpreadMs, 4),
        resolved: Number.isFinite(priceMs) && Math.abs(priceMs) > 2 * aaSpreadMs,
      };
    }
    return {
      ...base,
      ok: matches.every(run => run.errors.length === 0),
      fullP50Ms: roundTo(medianOf(matches.map(run => run.full.p50)), 3),
      minimalP50Ms: roundTo(medianOf(matches.map(run => run.minimal.p50)), 3),
      deltaP50Ms: roundTo(medianOf(matches.map(run => run.deltaP50Ms)), 3),
      deltaP95Ms: roundTo(medianOf(matches.map(run => run.deltaP95Ms)), 3),
    };
  });
}

async function runLadderMode(options) {
  const runner = {
    soak: runSoak,
    inject: runInject,
    dashboard: runDashboard,
    kslope: runKSlope,
    unlocked: runUnlocked,
    idle: runIdle,
  }[options.mode];
  const server = await resolveServer(options.urlExplicit ? options.url : null);
  const runs = [];
  let browser = null;
  try {
    const tag = options.mode === 'idle' ? `idle-${process.pid}-${Date.now()}` : null;
    browser = await launchBenchBrowser({
      headed: options.headed,
      unlocked: options.mode === 'unlocked',
      disableGpu: options.disableGpu,
      renderer: options.renderer,
      postfx: options.postfx,
      tag,
    });
    if (tag) {
      options.rootPid = browserRootPid(tag);
      if (!options.rootPid) throw new Error('idle mode needs /proc to find the launched browser (Linux only)');
    }
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      for (const spec of ladderCases(options)) {
        const run = await runner(browser, server.baseUrl, options, spec, repetition);
        runs.push(run);
        console.log(JSON.stringify(run));
      }
    }
    const cases = summarizeLadderRuns(options.mode, runs);
    const summary = {
      type: 'summary',
      mode: options.mode,
      ok: cases.every(item => item.ok),
      build: buildMetadata(),
      server: server.isolated ? 'isolated' : server.baseUrl,
      browserVersion: browser.version(),
      backend: runs[0]?.afterWarmup?.backend ?? runs[0]?.pose?.backend ?? null,
      glRenderer: runs[0]?.pose?.glRenderer ?? null,
      host: hostSnapshot(),
      options: {
        durationSeconds: options.durationSeconds,
        warmupSeconds: options.warmupSeconds,
        repetitions: options.repetitions,
        headed: options.headed,
        scenarios: options.scenarios,
        viewports: options.viewports.map(viewport => `${viewport.width}x${viewport.height}`),
        dpr: options.dpr,
        zooms: options.zooms,
        conditions: options.conditions,
        ...(options.postfx !== 'default' ? { postfx: options.postfx } : {}),
        ...(options.frontier !== 'default' ? { frontier: options.frontier } : {}),
        ...(options.disableGpu ? { disableGpu: true } : {}),
        ...(options.sidebar !== 'default' ? { sidebar: options.sidebar } : {}),
        ...(options.cameraMode !== 'fixed' ? { cameraMode: options.cameraMode } : {}),
        ...(options.mode === 'kslope' ? { level: options.level, candidatePasses: options.candidatePasses } : {}),
        ...(options.mode === 'inject' ? {
          loadPasses: options.loadPasses,
          loadLevels: options.loadLevels,
          baselineSeconds: options.baselineSeconds,
          loadSeconds: options.loadSeconds,
          recoverSeconds: options.recoverSeconds,
        } : {}),
        ...(options.mode === 'dashboard' ? { awaySeconds: options.awaySeconds, returns: options.returns } : {}),
        ...(options.mode === 'idle' ? { reducedMotion: options.reducedMotion } : {}),
      },
      ...(options.mode === 'idle' ? {
        compositor: options.headed ? 'headed' : 'software (headless)',
        caveat: options.headed
          ? 'Headed: CPU includes this host\'s compositor; the rAF rate is the panel\'s.'
          : 'Headless Chromium composites in software (viz SoftwareRenderer) and paces rAF at 60 Hz: renderer and GPU-process CPU include compositor work a headed, GPU-composited window does not pay. Compare arms from one host; never compare these cores with a real window\'s.',
      } : {}),
      cases,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify({ summary, runs }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// Paired overview/close incident gate (`--mode=incident`).
// Measures successful world paints (`presentGeneration`), p50/p95/p99 paint
// intervals, rAF, admitted updates, GPU submissions/evictions/uploads, light
// admission, records/batches, effective backend/PostFx/Frontier per frame,
// active vs ambient pacing, first zoom-out vs return, and absolute + paired
// baseline gates.

export async function measureIncidentWindow(page, { durationMs, pacing, attribution, shotState, spec }) {
  const measured = await page.evaluate(async ({ windowMs, pacingMode, passSampling, collectSource }) => {
    let eventBus = null;
    try {
      ({ eventBus } = await import('/src/domain/events/DomainEvent.js'));
    } catch { /* test stub without module loader */ }
    let ambientFramePacing = null;
    try {
      const pacingModule = await import('/src/presentation/character-mode/FramePacing.js');
      ambientFramePacing = pacingModule?.AMBIENT_FRAME_PACING === true;
    } catch { /* optional */ }
    const collectSnapshot = typeof collectSource === 'string'
      ? new Function(`return (${collectSource});`)()
      : null;

    const renderer = window.__claudeVilleApp.renderer;
    if (renderer.debugOverlay) renderer.debugOverlay.enabled = false;

    const savedDescriptors = new Map();
    const saveDescriptor = (key) => {
      if (!savedDescriptors.has(key)) {
        savedDescriptors.set(key, Object.getOwnPropertyDescriptor(renderer, key));
      }
    };
    const patchMethod = (key, value) => {
      saveDescriptor(key);
      Object.defineProperty(renderer, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: savedDescriptors.get(key)?.enumerable ?? false,
      });
    };
    const restoreDescriptors = () => {
      for (const [key, desc] of savedDescriptors) {
        if (desc) Object.defineProperty(renderer, key, desc);
        else delete renderer[key];
      }
    };

    const prevPassSampling = renderer.gpuWorld?.passSamplingEnabled;
    const hudFpsSamples = [];
    const rafGaps = [];
    let rafCount = 0;
    let lastRafTs = null;
    let admittedUpdates = 0;
    let activeUpdates = 0;
    let ambientUpdates = 0;
    let renderCalls = 0;
    let skippedByPacing = 0;
    let countedPaints = 0;
    let lastPaintTs = null;
    const paintIntervals = [];
    const updateMs = [];
    const renderMs = [];
    const totalMs = [];
    const perFrameBackends = {};
    const perFrameQualityLevels = {};
    const perFrameFrontierMasks = {};
    let perFramePostFxActive = 0;

    let unsubscribeFps = null;
    let elapsedSeconds = 0;
    let profile = null;
    let startSnapshot = null;
    let endSnapshot = null;
    let profileStarted = false;

    try {
      if (pacingMode === 'active') {
        patchMethod('_ambientTick', () => false);
      } else if (pacingMode === 'ambient') {
        saveDescriptor('_ambientTick');
        delete renderer._ambientTick;
        renderer._pointerInputAt = -Infinity;
      }
      if (typeof renderer.gpuWorld?.setPassSamplingEnabled === 'function') {
        renderer.gpuWorld.setPassSamplingEnabled(passSampling === true);
      }

      renderer._fpsFrames = 0;
      renderer._fpsWindowStart = performance.now();
      unsubscribeFps = eventBus?.on?.('fps:updated', (value) => {
        if (Number.isFinite(value)) hudFpsSamples.push(value);
      }) ?? null;

      renderer.startPerformanceProfile?.();
      profileStarted = true;

      const origLoop = renderer._loop;
      const origUpdate = renderer._update;
      const origRender = renderer._render;

      let didUpdateInLoop = false;
      let loopUpdateMs = 0;
      let loopRenderMs = 0;

      patchMethod('_update', function measuredUpdate(...args) {
        didUpdateInLoop = true;
        admittedUpdates += 1;
        if (this._framePacing?.ambient) ambientUpdates += 1;
        else activeUpdates += 1;
        const t0 = performance.now();
        const result = origUpdate.apply(this, args);
        const dt = performance.now() - t0;
        loopUpdateMs += dt;
        updateMs.push(dt);
        return result;
      });

      patchMethod('_render', function measuredRender(...args) {
        renderCalls += 1;
        const t0 = performance.now();
        const result = origRender.apply(this, args);
        const dt = performance.now() - t0;
        loopRenderMs += dt;
        renderMs.push(dt);
        return result;
      });

      patchMethod('_loop', function measuredLoop(...args) {
        didUpdateInLoop = false;
        loopUpdateMs = 0;
        loopRenderMs = 0;
        const genBefore = this.presentGeneration ?? 0;
        const result = origLoop.apply(this, args);
        if (!didUpdateInLoop) {
          skippedByPacing += 1;
        } else {
          totalMs.push(loopUpdateMs + loopRenderMs);
        }
        if ((this.presentGeneration ?? 0) > genBefore) {
          const now = performance.now();
          if (lastPaintTs !== null) paintIntervals.push(now - lastPaintTs);
          lastPaintTs = now;
          countedPaints += 1;
          // The compositor hides the GPU canvas on a failed submission, even
          // while the selected backend still reports itself active.
          const mode = this._postFxCanvasVisible ? (this.worldRendererMode || 'unknown') : 'canvas';
          perFrameBackends[mode] = (perFrameBackends[mode] || 0) + 1;
          if (mode === 'canvas' && this._postFxCanvasVisible) perFramePostFxActive += 1;
          if (mode === 'webgpu' && this.gpuWorld?.frontierEnabled) {
            const mask = this.gpuWorld._frontierMask;
            perFrameFrontierMasks[mask] = (perFrameFrontierMasks[mask] || 0) + 1;
          }
          const qLevel = this.gpuWorld?.isActive?.()
            ? this.gpuWorld.qualityLadder?.getLevel?.()
            : (this.postFx?.isActive?.() ? this.postFx.ladder?.getLevel?.() : null);
          if (qLevel !== null && qLevel !== undefined) {
            perFrameQualityLevels[qLevel] = (perFrameQualityLevels[qLevel] || 0) + 1;
          }
        }
        return result;
      });

      // Capture start and end snapshots synchronously inside the measured rAF
      // window so presentGeneration, GPU submissions/uploads/evictions, water
      // builds, and frame failures share exact frame boundaries with no IPC skew.
      startSnapshot = collectSnapshot ? collectSnapshot(ambientFramePacing) : null;
      const started = performance.now();
      await new Promise((resolve) => {
        const tick = (ts) => {
          if (lastRafTs !== null) rafGaps.push(ts - lastRafTs);
          lastRafTs = ts;
          rafCount += 1;
          if (ts - started >= windowMs) {
            elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
            endSnapshot = collectSnapshot ? collectSnapshot(ambientFramePacing) : null;
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      });
    } finally {
      restoreDescriptors();
      if (typeof renderer.gpuWorld?.setPassSamplingEnabled === 'function' && typeof prevPassSampling === 'boolean') {
        renderer.gpuWorld.setPassSamplingEnabled(prevPassSampling);
      }
      unsubscribeFps?.();
      if (profileStarted) profile = renderer.stopPerformanceProfile?.() || null;
    }

    return {
      elapsedSeconds,
      startSnapshot,
      endSnapshot,
      startGen: startSnapshot?.presentGeneration ?? 0,
      endGen: endSnapshot?.presentGeneration ?? 0,
      startPostFxFrames: startSnapshot?.postFx?.frames ?? 0,
      endPostFxFrames: endSnapshot?.postFx?.frames ?? 0,
      rafCount,
      rafGaps,
      admittedUpdates,
      activeUpdates,
      ambientUpdates,
      renderCalls,
      skippedByPacing,
      countedPaints,
      paintIntervals,
      updateMs,
      renderMs,
      totalMs,
      perFrameBackends,
      perFramePostFxActive,
      perFrameQualityLevels,
      perFrameFrontierMasks,
      hudFpsSamples,
      renderSegments: profile?.renderTimings?.segments || [],
    };
  }, {
    windowMs: durationMs,
    pacingMode: pacing,
    passSampling: attribution === true,
    collectSource: collectWorldStateSnapshot.toString(),
  });

  const { startSnapshot, endSnapshot } = measured;
  const successfulPaints = Math.max(0, measured.endGen - measured.startGen);
  const perSec = value => (Number.isFinite(value) ? roundTo(value / measured.elapsedSeconds, 2) : null);
  const gpuDeltas = computeGpuDeltas(startSnapshot.gpu, endSnapshot.gpu);
  const postFxFramesDelta = Math.max(0, measured.endPostFxFrames - measured.startPostFxFrames);
  const targetPeriodMs = pacing === 'ambient' ? (1000 / 30) : (1000 / 60);
  const missedDisplayIntervals = measured.paintIntervals.filter(gap => gap > targetPeriodMs * 1.5).length;
  const failedFrames = Math.max(
    0,
    (endSnapshot.frameFailures?.total || 0) - (startSnapshot.frameFailures?.total || 0),
  );

  return {
    shotState,
    pacing,
    seconds: roundTo(measured.elapsedSeconds, 3),
    successfulPaints,
    loopCountedPaints: measured.countedPaints,
    paintsPerSec: perSec(successfulPaints),
    paintIntervalsMs: summarizeIntervals(measured.paintIntervals),
    hudFps: summarizeFps(measured.hudFpsSamples),
    raf: {
      count: measured.rafCount,
      fps: perSec(measured.rafCount),
      ...summarizeIntervals(measured.rafGaps),
    },
    admittedUpdates: {
      count: measured.admittedUpdates,
      fps: perSec(measured.admittedUpdates),
      activeCount: measured.activeUpdates,
      ambientCount: measured.ambientUpdates,
      ambientShare: measured.admittedUpdates ? roundTo(measured.ambientUpdates / measured.admittedUpdates, 3) : null,
    },
    renderCalls: measured.renderCalls,
    gpuSubmissions: {
      submitted: gpuDeltas.frames,
      submittedFps: perSec(gpuDeltas.frames),
      reused: gpuDeltas.skippedFrames,
      reusedFps: perSec(gpuDeltas.skippedFrames),
      postFxFrames: postFxFramesDelta,
      postFxFps: perSec(postFxFramesDelta),
    },
    cpuMs: {
      samples: measured.totalMs.length,
      update: summarizeIntervals(measured.updateMs),
      render: summarizeIntervals(measured.renderMs),
      total: summarizeIntervals(measured.totalMs),
    },
    droppedFrames: {
      failedFrames,
      skippedByPacing: measured.skippedByPacing,
      missedDisplayIntervals,
      targetPeriodMs: roundTo(targetPeriodMs, 2),
      frameFailuresByStage: endSnapshot.frameFailures?.byStage || {},
    },
    perFrameBackends: measured.perFrameBackends,
    perFramePostFxActive: measured.perFramePostFxActive,
    perFrameQualityLevels: measured.perFrameQualityLevels,
    perFrameFrontierMasks: measured.perFrameFrontierMasks,
    camera: {
      mode: endSnapshot.camera.mode,
      centerTile: spec.tile,
      startPose: startSnapshot.camera,
      endPose: endSnapshot.camera,
      resolvedZoomStart: startSnapshot.camera.zoom,
      resolvedZoomEnd: endSnapshot.camera.zoom,
    },
    viewport: endSnapshot.viewport,
    quality: endSnapshot.quality,
    postFxEnd: endSnapshot.postFx,
    frontierEnd: endSnapshot.frontier,
    gpuDeltas,
    gpuEnd: endSnapshot.gpu,
    water: computeWaterDeltas(startSnapshot.water, endSnapshot.water),
    lightGradientsEnd: endSnapshot.lightGradients,
    renderSegments: measured.renderSegments,
    agentsEnd: endSnapshot.agents,
  };
}

async function runIncidentRepetition(browser, baseUrl, options, spec, repetition) {
  const loadStart = os.loadavg();
  const query = buildWorldQuery({
    renderer: spec.renderer,
    postfx: spec.postfx,
    frontier: spec.frontier,
  });
  const opened = await openWorld(browser, {
    baseUrl,
    scenario: spec.scenario,
    width: spec.width,
    height: spec.height,
    dpr: spec.dpr,
    query,
    sidebar: spec.sidebar,
    autoCamera: spec.cameraMode === 'auto',
  });
  const { context, page, errors } = opened;

  try {
    const schedule = buildPairedArmOrder(repetition);
    const firstZoom = schedule[0].role === 'overview' ? spec.overviewZoom : spec.closeZoom;

    await sleep(4500);
    await poseWorld(page, {
      hour: spec.hour,
      weather: spec.weather,
      zoom: firstZoom,
      tile: spec.tile,
      autoCamera: spec.cameraMode === 'auto',
    });
    if (spec.qualityOverride != null) {
      await page.waitForFunction(({ level, renderer: requested }) => {
        const r = window.__claudeVilleApp?.renderer;
        if (!r || (requested && r.worldRendererMode !== requested)) return false;
        const ladder = r.gpuWorld?.isActive?.() ? r.gpuWorld.qualityLadder : r.postFx?.isActive?.() && r.postFx.ladder;
        if (!ladder) return false;
        ladder.setOverride(level);
        return ladder.getLevel() === level;
      }, { level: spec.qualityOverride, renderer: spec.renderer }, { timeout: 60_000 });
    }
    await waitForWorldWarmup(page, {
      warmupSeconds: options.warmupSeconds,
      expectFrontier: spec.frontier === 'on',
      initialGlideMs: 0,
    });
    const afterWarmup = await readWorldStateSnapshot(page);

    const arms = [];
    const transitions = [];
    const perFrameBackendsTotal = {};
    const allSegments = [];

    for (let index = 0; index < schedule.length; index++) {
      const step = schedule[index];
      const targetZoom = step.role === 'overview' ? spec.overviewZoom : spec.closeZoom;
      await poseWorld(page, {
        hour: spec.hour,
        weather: spec.weather,
        zoom: targetZoom,
        tile: spec.tile,
        autoCamera: spec.cameraMode === 'auto',
      });

      if (index > 0 && options.settleSeconds > 0) {
        const transition = await measureIncidentWindow(page, {
          durationMs: Math.min(1000, options.settleSeconds * 1000),
          pacing: spec.pacing,
          attribution: false,
          shotState: 'transition',
          spec,
        });
        transitions.push({
          arm: step.arm,
          role: step.role,
          phase: step.phase,
          targetZoom,
          paintsPerSec: transition.paintsPerSec,
          successfulPaints: transition.successfulPaints,
          paintIntervalsMs: transition.paintIntervalsMs,
          camera: transition.camera,
        });
      }

      const remainingSettleMs = index > 0
        ? Math.max(0, options.settleSeconds * 1000 - Math.min(1000, options.settleSeconds * 1000))
        : options.settleSeconds * 1000;
      if (remainingSettleMs > 0) await sleep(remainingSettleMs);
      if (options.settleSeconds > 0 && spec.cameraMode !== 'auto') {
        await poseWorld(page, {
          hour: spec.hour,
          weather: spec.weather,
          zoom: targetZoom,
          tile: spec.tile,
          autoCamera: false,
        });
      }

      const armResult = await measureIncidentWindow(page, {
        durationMs: options.durationSeconds * 1000,
        pacing: spec.pacing,
        attribution: options.attribution,
        shotState: 'settled',
        spec,
      });
      for (const [name, count] of Object.entries(armResult.perFrameBackends || {})) {
        perFrameBackendsTotal[name] = (perFrameBackendsTotal[name] || 0) + count;
      }
      allSegments.push(...(armResult.renderSegments || []));

      arms.push({
        arm: step.arm,
        role: step.role,
        phase: step.phase,
        primary: step.primary,
        targetZoom,
        ...armResult,
      });
    }

    const atEnd = await readWorldStateSnapshot(page);
    const backendCheck = verifyEffectiveBackend({
      requestedRenderer: spec.renderer,
      requestedPostfx: spec.postfx,
      requestedFrontier: spec.frontier,
      disableGpu: spec.disableGpu,
      afterWarmup,
      atEnd,
      perFrameBackends: perFrameBackendsTotal,
      frontierMasks: arms.flatMap(arm => Object.keys(arm.perFrameFrontierMasks).map(Number)),
      hybridPaints: arms.reduce((total, arm) => total + arm.perFramePostFxActive, 0),
      renderSegments: allSegments,
    });

    return {
      type: 'run',
      mode: 'incident',
      preset: spec.preset,
      label: spec.label,
      scenario: spec.scenario,
      viewport: spec.viewport,
      dpr: spec.dpr,
      hour: spec.hour,
      weather: spec.weather,
      sidebar: spec.sidebar,
      cameraMode: spec.cameraMode,
      tile: spec.tile,
      pacing: spec.pacing,
      overviewZoom: spec.overviewZoom,
      closeZoom: spec.closeZoom,
      qualityOverride: spec.qualityOverride,
      requestedRenderer: spec.renderer || 'default',
      requestedPostfx: spec.postfx,
      requestedFrontier: spec.frontier,
      disableGpu: spec.disableGpu,
      repetition,
      headed: options.headed,
      browserVersion: browser.version(),
      launchArgs: benchLaunchArgs(options),
      armOrder: schedule.map(step => step.arm),
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      settleSeconds: options.settleSeconds,
      attribution: options.attribution,
      hostLoadAverage: { start: loadStart, end: os.loadavg() },
      afterWarmup,
      atEnd,
      perFrameBackends: perFrameBackendsTotal,
      backendCheck,
      transitions,
      arms,
      errors: errors.slice(0, 10),
    };
  } finally {
    await context.close();
  }
}

async function runIncidentMode(options) {
  const casesToRun = buildIncidentCases(options, options.seenFlags);
  const baselineMap = options.baseline
    ? indexBaselineReport(JSON.parse(readFileSync(options.baseline, 'utf8')))
    : null;
  const thresholds = INCIDENT_GATE_DEFAULTS;

  const server = await resolveServer(options.urlExplicit ? options.url : null);
  const runs = [];
  let browser = null;
  try {
    browser = await launchBenchBrowser({
      headed: options.headed,
      disableGpu: options.disableGpu,
      renderer: options.renderer,
      postfx: options.postfx,
    });
    for (const spec of casesToRun) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        const run = await runIncidentRepetition(browser, server.baseUrl, options, spec, repetition);
        runs.push(run);
        console.log(JSON.stringify(run));
      }
    }

    const grouped = new Map();
    for (const run of runs) {
      const key = caseComparisonKey(run);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(run);
    }

    const cases = [...grouped.values()].map((caseRuns) => {
      const summarized = summarizeIncidentCase(caseRuns);
      const baselineCase = baselineMap ? (baselineMap.get(summarized.comparisonKey) || null) : null;
      const gates = evaluateIncidentGates(summarized, {
        thresholds,
        baselineCase,
        baselineExpected: Boolean(baselineMap),
        gateMode: options.gate,
      });
      return { ...summarized, ok: gates.passed, gates };
    });

    const summary = {
      type: 'summary',
      mode: 'incident',
      ok: cases.every(item => item.ok),
      build: buildMetadata(),
      server: server.isolated ? 'isolated' : server.baseUrl,
      browserVersion: browser.version(),
      host: hostSnapshot(),
      options: {
        incidentCases: options.incidentCases,
        pacing: options.pacing,
        durationSeconds: options.durationSeconds,
        warmupSeconds: options.warmupSeconds,
        settleSeconds: options.settleSeconds,
        repetitions: options.repetitions,
        attribution: options.attribution,
        headed: options.headed,
        launchArgs: benchLaunchArgs(options),
        renderer: options.renderer || 'default',
        postfx: options.postfx,
        frontier: options.frontier,
        disableGpu: options.disableGpu,
        sidebar: options.sidebar,
        cameraMode: options.cameraMode,
        tile: options.tile,
        gate: options.gate,
        baseline: options.baseline,
      },
      thresholds,
      cases,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify({ summary, runs }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'matrix') await runMatrix(options);
  else if (options.mode === 'incident') await runIncidentMode(options);
  else await runLadderMode(options);
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch(error => {
    console.error(`[world-fps-benchmark] FAIL: ${error.stack || error.message}`);
    process.exit(1);
  });
}
