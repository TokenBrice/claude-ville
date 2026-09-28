#!/usr/bin/env node

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  BENCH_WEATHER,
  hostSnapshot,
  launchBenchBrowser,
  median as medianOf,
  openWorld,
  parseConditions,
  parseViewport,
  poseWorld,
  quantile,
  resolveServer,
  round as roundTo,
} from './support/world-bench.mjs';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
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

const MODES = Object.freeze(['matrix', 'soak', 'inject', 'dashboard', 'kslope', 'unlocked']);
const MODE_DEFAULTS = Object.freeze({
  matrix: { durationSeconds: 30, warmupSeconds: 10, repetitions: 3 },
  soak: { durationSeconds: 180, warmupSeconds: 10, repetitions: 1 },
  inject: { durationSeconds: 0, warmupSeconds: 10, repetitions: 1 },
  dashboard: { durationSeconds: 0, warmupSeconds: 10, repetitions: 1 },
  kslope: { durationSeconds: 24, warmupSeconds: 4, repetitions: 3 },
  unlocked: { durationSeconds: 12, warmupSeconds: 4, repetitions: 3 },
});
const MATRIX_ONLY_FLAGS = new Set(['--counts', '--weather', '--max-rain-regression-pct', '--profile']);
const LADDER_ONLY_FLAGS = new Set([
  '--scenario', '--viewport', '--dpr', '--zoom', '--conditions', '--level', '--load-passes', '--load-levels',
  '--baseline-seconds', '--load-seconds', '--recover-seconds', '--away-seconds', '--returns', '--candidate-passes',
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
  unlocked   V2 receipt: vsync and frame-rate limit off, forced FULL vs
             MINIMAL in alternating 60-frame blocks; the rAF interval delta

Common options:
  --url=<url>                 ClaudeVille URL (matrix default: ${DEFAULT_URL};
                              other modes default to an isolated server unless
                              --url or CLAUDEVILLE_URL is given)
  --duration-seconds=<n>      Measurement per run (matrix 30, soak 180, kslope 24,
                              unlocked 12)
  --warmup-seconds=<n>        Warmup per run (matrix/soak/inject/dashboard 10,
                              kslope/unlocked 4)
  --repetitions=<n>           Fresh browser contexts per case (matrix/kslope/unlocked 3,
                              soak/inject/dashboard 1)
  --out=<file>                Also write runs and summary as JSON
  --headed                    Show the Chromium window (use on the 120 Hz panel)
  --help                      Print this help

Matrix options:
  --counts=<list>             Comma-separated agent counts from 1 to 200
  --weather=<list>            Comma-separated subset of clear,rain
  --max-rain-regression-pct=<n>
                              Fail if paired rain median FPS is more than n% below clear
  --profile                   Include opt-in update/render timings

Ladder and receipt options (soak, inject, dashboard, kslope, unlocked):
  --scenario=<ids>            Sim scenarios (default: dense-24-agents)
  --viewport=<list>           WIDTHxHEIGHT list (default: 1920x1080)
  --dpr=<n>                   Device scale factor (default: 1)
  --zoom=<list>               Zoom tiers, or survey (default: 1)
  --conditions=<list>         hour:weather pairs, weather ${Object.keys(BENCH_WEATHER).join('|')}
                              (default: 22:clear)
  --level=<0|1|2>             kslope: forced ladder level (default: 0)
  --candidate-passes=<n>      kslope: present passes per K unit (default: 1)
  --load-passes=<n>           inject: injected full-screen passes (default: 400)
  --load-levels=<full|all>    inject: load drawn at FULL only, which the ladder
                              can shed (default), or at every level
  --baseline-seconds=<n>      inject: free-ladder window before the load (default: 5)
  --load-seconds=<n>          inject: load duration (default: 20)
  --recover-seconds=<n>       inject: observation after removal (default: 90)
  --away-seconds=<n>          dashboard: time in the Dashboard (default: 5)
  --returns=<n>               dashboard: returns per run (default: 3)

Output is newline-delimited JSON per run followed by a summary object.`);
}

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
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
  };
  const seen = new Set();

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
    const [flag, inlineValue] = arg.split('=', 2);
    if (![
      '--mode',
      '--url',
      '--duration-seconds',
      '--warmup-seconds',
      '--repetitions',
      '--out',
      ...MATRIX_ONLY_FLAGS,
      ...LADDER_ONLY_FLAGS,
    ].includes(flag) || flag === '--profile') {
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
  }

  if (!MODES.includes(options.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const onlyFor = options.mode === 'matrix' ? LADDER_ONLY_FLAGS : MATRIX_ONLY_FLAGS;
  for (const flag of seen) {
    if (onlyFor.has(flag)) throw new Error(`${flag} does not apply to --mode=${options.mode}`);
  }
  const defaults = MODE_DEFAULTS[options.mode];
  options.durationSeconds ??= defaults.durationSeconds;
  options.warmupSeconds ??= defaults.warmupSeconds;
  options.repetitions ??= defaults.repetitions;

  if (['matrix', 'soak', 'kslope', 'unlocked'].includes(options.mode)
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
  const browser = await chromium.launch({ headless: !options.headed });
  const runs = [];
  try {
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
      url: options.url,
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
    await browser.close();
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
  };
}

// Boot, let the opening glide finish, pose, warm up, and re-assert the pose
// (director and idle glides can steal it).
async function openPosedWorld(browser, baseUrl, spec, warmupSeconds) {
  const opened = await openWorld(browser, {
    baseUrl, scenario: spec.scenario, width: spec.width, height: spec.height, dpr: spec.dpr,
  });
  try {
    await sleep(4500);
    const pose = await poseWorld(opened.page, spec);
    if (!pose.gpuWorldActive) throw new Error(`resident GPU world inactive for ${spec.scenario} ${spec.viewport}`);
    await sleep(warmupSeconds * 1000);
    await poseWorld(opened.page, spec);
    return { ...opened, pose };
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
  const { context, page, errors, pose } = await openPosedWorld(browser, baseUrl, spec, options.warmupSeconds);
  try {
    const durationMs = options.durationSeconds * 1000;
    const startedAt = await installLadderRecorder(page, Math.ceil(options.durationSeconds * 300) + 600);
    await sleep(durationMs);
    const recorded = await readLadderRecorder(page);
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
      const gpu = window.__claudeVilleApp.renderer.gpuWorld;
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

function summarizeLadderRuns(mode, runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [run.scenario, run.viewport, run.dpr, run.zoom, run.hour, run.weather].join('|');
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
  }[options.mode];
  const server = await resolveServer(options.urlExplicit ? options.url : null);
  const runs = [];
  let browser = null;
  try {
    browser = await launchBenchBrowser({ headed: options.headed, unlocked: options.mode === 'unlocked' });
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
      server: server.isolated ? 'isolated' : server.baseUrl,
      browserVersion: browser.version(),
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
        ...(options.mode === 'kslope' ? { level: options.level, candidatePasses: options.candidatePasses } : {}),
        ...(options.mode === 'inject' ? {
          loadPasses: options.loadPasses,
          loadLevels: options.loadLevels,
          baselineSeconds: options.baselineSeconds,
          loadSeconds: options.loadSeconds,
          recoverSeconds: options.recoverSeconds,
        } : {}),
        ...(options.mode === 'dashboard' ? { awaySeconds: options.awaySeconds, returns: options.returns } : {}),
      },
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
  else await runLadderMode(options);
}

main().catch(error => {
  console.error(`[world-fps-benchmark] FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
