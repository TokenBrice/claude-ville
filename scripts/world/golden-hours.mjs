#!/usr/bin/env node
// T5 golden hour-sweep gate. Renders fixed scenes per World backend and checks
// island brightness and lamp-light metrics against the committed curve
// (`golden-hours.json`). Numbers only: no PNG is written or committed.
//
// Determinism: an isolated server, the `no-agents` sim scenario (no live
// data, no bodies), reduced motion from the first frame (the motion clock
// stays at 0, so the swell, cloud drift and lightning hold still), the
// atmosphere pinned to one date (`AtmosphereState.update` always sees it) in
// fixed mode with a forced hour and a seeded weather, the camera pose pinned,
// the quality ladder held FULL and the mark governor calm. Each scene is
// captured until two captures 1.2 s apart agree.
//
// Backends: WebGPU through the renderer's own `debugCaptureTargets()`
// composite (headless screenshots miss the WebGPU swap chain), WebGL2 and
// Canvas through a screenshot of the world stack with every DOM layer and the
// label overlay hidden.
//
// Usage:
//   npm run world:golden-hours                 check every backend
//   npm run world:golden-hours -- --update     recalibrate the curve
//   --renderers=webgpu,webgl,canvas  --scenes=clear-1200,storm-1915
//   --url=<ClaudeVille URL> (default: an isolated server)  --json=<report path>
//   --frames=<dir>  also write each settled frame as PNG there, for review
// Exit: 0 pass; 1 a failure; 2 nothing failed but a backend was unavailable.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { gpuLaunchArgs, launchChromium } from '../smoke/support/chromium.mjs';
import { resolveServer } from '../smoke/support/world-bench.mjs';
import {
  GOLDEN_BACKENDS,
  GOLDEN_SCENES,
  ISLAND_REGION,
  buildCurve,
  checkGoldenRun,
  frameMetrics,
  metricsSettled,
} from './golden-hours-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURVE_PATH = path.join(HERE, 'golden-hours.json');
const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
// 2026-10-24 12:00 UTC: the season and moon phase every scene sees.
const PINNED_DATE_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
// The village from Command to the Harbor, zoom 1.
const POSE = Object.freeze({ tile: [18, 20], zoom: 1 });
const SETTLE_MS = 1200;
const MAX_CAPTURES = 8;

class BackendUnavailable extends Error {}

function parseArgs(argv) {
  const options = { renderers: [...GOLDEN_BACKENDS], scenes: null, update: false, url: process.env.CLAUDEVILLE_URL || null, json: null, frames: null };
  for (const arg of argv) {
    const [flag, value = ''] = arg.split(/=(.*)/s);
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--update') options.update = true;
    else if (flag === '--renderers') options.renderers = value.split(',').map(s => s.trim()).filter(Boolean);
    else if (flag === '--scenes') options.scenes = value.split(',').map(s => s.trim()).filter(Boolean);
    else if (flag === '--url') options.url = value || null;
    else if (flag === '--json') options.json = value || null;
    else if (flag === '--frames') options.frames = value || null;
    else throw new Error(`unknown option ${arg}`);
  }
  for (const r of options.renderers) if (!GOLDEN_BACKENDS.includes(r)) throw new Error(`unknown renderer ${r}`);
  return options;
}

async function openBackend(browser, baseUrl, renderer) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 300)));
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('sim', '1');
  url.searchParams.set('scenario', 'no-agents');
  url.searchParams.set('renderer', renderer);
  await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => {
    const app = window.__claudeVilleApp;
    return app?._bootState === 'ready' && Boolean(app?.renderer?.camera);
  }, null, { timeout: 90_000 });
  try {
    await page.waitForFunction((want) => {
      const r = window.__claudeVilleApp.renderer;
      const name = r.gpuWorld?.constructor?.name || '';
      if (want === 'canvas') return !r.gpuWorld;
      return want === 'webgpu' ? /WebGPU/.test(name) : name === 'GpuWorldRenderer';
    }, renderer, { timeout: 90_000 });
  } catch {
    const reason = await page.evaluate(() => window.__claudeVilleApp.renderer.worldBackendReason || null).catch(() => null);
    await context.close();
    throw new BackendUnavailable(`${renderer} backend did not start (${reason || 'no reason reported'})`);
  }
  await page.evaluate(async ({ pinned, pose }) => {
    // Hold the ladder FULL and the mark governor calm: no shed or admit
    // decision depends on host load.
    window.__claudeVillePerf ||= {};
    Object.defineProperty(window.__claudeVillePerf, 'frameHealth', { get: () => () => ({}), set() {}, configurable: true });
    const governor = await import('/src/presentation/character-mode/MarkGovernor.js');
    governor.resetFramePressureState();
    const r = window.__claudeVilleApp.renderer;
    r.gpuWorld?.qualityLadder?.setOverride?.(0);
    r.postFx?.ladder?.setOverride?.(0);
    r.cameraDirector?.setAmbient?.(false);
    r.cameraDirector?.setAutoMode?.(false);
    r.camera.noteUserInput?.();
    const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
    const w = tileToWorld({ tileX: pose.tile[0], tileY: pose.tile[1] });
    r.camera.abortDirectorGlide?.();
    r.setCameraPose({ x: w.x, y: w.y, zoom: pose.zoom });
    // One date for every frame, fixed timeline mode.
    const a = r.atmosphereState;
    a.clear();
    a.setTimelineMode('fixed');
    if (!a.__goldenUpdate) a.__goldenUpdate = a.update.bind(a);
    a.update = (o = {}) => a.__goldenUpdate({ ...o, now: new Date(pinned) });
    // Screenshots see only the world canvases: no DOM chrome, no labels.
    const style = document.createElement('style');
    style.textContent = 'body * { visibility: hidden !important; } #worldStack, #worldCanvas, #worldFxCanvas { visibility: visible !important; } #worldOverlayCanvas { visibility: hidden !important; }';
    document.head.appendChild(style);
  }, { pinned: PINNED_DATE_MS, pose: POSE });
  const backend = await page.evaluate(() => {
    const r = window.__claudeVilleApp.renderer;
    return { gpu: r.gpuWorld?.constructor?.name || null, postFx: Boolean(r.postFx), motionScale: r.motionScale, reason: r.worldBackendReason || null };
  });
  return { context, page, errors, backend };
}

function decode(buffer) {
  const png = PNG.sync.read(buffer);
  return { data: png.data, width: png.width, height: png.height };
}

async function captureFrame(page, renderer) {
  if (renderer === 'webgpu') {
    const dataUrl = await page.evaluate(async () => {
      const r = window.__claudeVilleApp.renderer;
      const t = await r.gpuWorld.debugCaptureTargets();
      if (!t?.composite) return null;
      const n = t.width * t.height;
      const rgba = new Uint8ClampedArray(n * 4);
      const src = t.composite;
      // An rgba16float composite (HDR present) reads back as floats.
      const scale = src instanceof Float32Array ? 255 : 1;
      for (let i = 0; i < n * 4; i++) rgba[i] = (i & 3) === 3 ? 255 : src[i] * scale;
      const c = document.createElement('canvas');
      c.width = t.width;
      c.height = t.height;
      c.getContext('2d').putImageData(new ImageData(rgba, t.width, t.height), 0, 0);
      return c.toDataURL('image/png');
    });
    if (!dataUrl) throw new Error('webgpu: debugCaptureTargets() returned no composite');
    return decode(Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  return decode(await page.locator('#worldStack').screenshot());
}

async function measureScene(page, renderer, scene, framesDir) {
  await page.evaluate(({ hour, weather }) => {
    const a = window.__claudeVilleApp.renderer.atmosphereState;
    a.setWeather(weather);
    a.setHour(hour);
  }, scene);
  let previous = null;
  for (let attempt = 0; attempt < MAX_CAPTURES; attempt++) {
    await page.waitForTimeout(SETTLE_MS);
    const frame = await captureFrame(page, renderer);
    const metrics = frameMetrics(frame, ISLAND_REGION);
    if (metricsSettled(previous, metrics)) {
      if (framesDir) writeFrame(path.join(framesDir, `${renderer}-${scene.id}.png`), frame);
      return { ...metrics, captures: attempt + 1 };
    }
    previous = metrics;
  }
  return { ...previous, unsettled: true, captures: MAX_CAPTURES };
}

function writeFrame(file, { data, width, height }) {
  const png = new PNG({ width, height });
  data.copy ? data.copy(png.data) : png.data.set(data);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
}

function printTable(run) {
  for (const [backend, scenes] of Object.entries(run)) {
    console.log(`\n${backend}`);
    console.log('  scene        mean    p10  p90  lamp      dark');
    for (const [id, m] of Object.entries(scenes)) {
      console.log(`  ${id.padEnd(11)}  ${String(m.mean).padStart(6)}  ${String(m.p10).padStart(4)} ${String(m.p90).padStart(4)}  ${m.warmShare.toFixed(5)}  ${m.darkShare.toFixed(5)}${m.unsettled ? '  (unsettled)' : ''}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const scenes = options.scenes
    ? GOLDEN_SCENES.filter(scene => options.scenes.includes(scene.id))
    : GOLDEN_SCENES;
  if (!scenes.length) throw new Error('no scene selected');
  const server = await resolveServer(options.url);
  const run = {};
  const unavailable = [];
  const backends = {};
  const pageErrors = [];
  let browser = null;
  try {
    browser = await launchChromium({ headless: true, args: gpuLaunchArgs() });
    for (const renderer of options.renderers) {
      let opened;
      try {
        opened = await openBackend(browser, server.baseUrl, renderer);
      } catch (error) {
        if (!(error instanceof BackendUnavailable)) throw error;
        unavailable.push(error.message);
        console.warn(error.message);
        continue;
      }
      backends[renderer] = opened.backend;
      run[renderer] = {};
      try {
        for (const scene of scenes) {
          run[renderer][scene.id] = await measureScene(opened.page, renderer, scene, options.frames);
        }
      } finally {
        pageErrors.push(...opened.errors.map(e => `${renderer}: ${e}`));
        await opened.context.close();
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
  }

  printTable(run);
  const unsettled = Object.entries(run).flatMap(([backend, s]) => Object.entries(s)
    .filter(([, m]) => m.unsettled).map(([id]) => `${backend} ${id}: frame never settled`));

  let failures;
  if (options.update) {
    const previous = (() => { try { return JSON.parse(readFileSync(CURVE_PATH, 'utf8')); } catch { return null; } })();
    const clean = Object.fromEntries(Object.entries(run).map(([backend, s]) => [backend,
      Object.fromEntries(Object.entries(s).map(([id, { captures, unsettled: _u, ...m }]) => [id, m]))]));
    const curve = buildCurve(clean, previous, { viewport: VIEWPORT, pose: POSE, pinnedDate: new Date(PINNED_DATE_MS).toISOString(), region: ISLAND_REGION });
    failures = [...unsettled, ...checkGoldenRun(run, curve, { scenes })];
    if (!unsettled.length) {
      writeFileSync(CURVE_PATH, `${JSON.stringify(curve, null, 2)}\n`);
      console.log(`\nwrote ${path.relative(process.cwd(), CURVE_PATH)}`);
    }
  } else {
    const curve = JSON.parse(readFileSync(CURVE_PATH, 'utf8'));
    failures = [...unsettled, ...checkGoldenRun(run, curve, { scenes })];
  }
  if (pageErrors.length) failures.push(...pageErrors.map(e => `page error ${e}`));

  if (options.json) {
    mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify({ backends, run, failures, unavailable }, null, 2)}\n`);
  }
  console.log('');
  for (const line of unavailable) console.log(`unavailable: ${line}`);
  for (const line of failures) console.log(`FAIL ${line}`);
  if (failures.length) return 1;
  if (unavailable.length) return 2;
  console.log(`golden hours: PASS (${Object.keys(run).join(', ')}; ${scenes.length} scenes)`);
  return 0;
}

main().then(code => { process.exitCode = code; }, (error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
