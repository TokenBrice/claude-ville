// Shared plumbing for the resident-renderer receipt tools (plan 0.1, V2):
// `scripts/smoke/world-fps-benchmark.mjs` (ladder soak, injected load,
// Dashboard return, K-slope and vsync-unlocked arms) and
// `scripts/world/gpu-burst.mjs` (real-frame throughput per level). Imported
// helper; not directly executable.
import os from 'node:os';
import { chromium } from 'playwright';
import { startIsolatedServer } from './isolated-server.mjs';

// Pinned weather presets (the V2 quiet-host protocol: clear, plus rain and
// storm for weather items).
export const BENCH_WEATHER = Object.freeze({
  clear: Object.freeze({ type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.08, windX: 0 }),
  rain: Object.freeze({ type: 'rain', intensity: 0.82, precipitation: 0.9, fog: 0.16, cloudCover: 0.92, windX: -0.4 }),
  storm: Object.freeze({ type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78 }),
});

// Real-GPU Chromium on macOS (a hardware WebGPU adapter, so the World's
// default backend is WebGPU: pass `query: { renderer: 'webgl' }` to measure
// WebGL2); the unlocked arm adds vsync and frame-rate limits off so the rAF
// interval is the frame's own cost.
export const GPU_LAUNCH_ARGS = Object.freeze(['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']);
export const UNLOCKED_LAUNCH_ARGS = Object.freeze(['--disable-gpu-vsync', '--disable-frame-rate-limit']);

export function launchBenchBrowser({ headed = false, unlocked = false } = {}) {
  return chromium.launch({
    headless: !headed,
    args: [...GPU_LAUNCH_ARGS, ...(unlocked ? UNLOCKED_LAUNCH_ARGS : [])],
  });
}

/** An explicit ClaudeVille URL, or an isolated server (OS port, temp HOME; never port 4000). */
export async function resolveServer(url) {
  if (url) return { baseUrl: String(url).replace(/\/+$/, ''), isolated: false, stop: async () => {} };
  const server = await startIsolatedServer();
  return { baseUrl: server.baseUrl, isolated: true, stop: () => server.stop() };
}

export function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`viewport must be WIDTHxHEIGHT, received ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `hour:weather` pairs, e.g. `12:clear,22:clear,16:rain,16:storm`. */
export function parseConditions(value) {
  return String(value).split(',').map(item => item.trim()).filter(Boolean).map((item) => {
    const [hourText, weather = 'clear'] = item.split(':');
    const hour = Number(hourText);
    if (!Number.isFinite(hour) || hour < 0 || hour >= 24) throw new Error(`condition hour must be 0-23.99: ${item}`);
    if (!BENCH_WEATHER[weather]) throw new Error(`condition weather must be one of ${Object.keys(BENCH_WEATHER).join(',')}: ${item}`);
    return { hour, weather };
  });
}

/** Boot a fresh context on a sim scenario and wait for the World to be ready. */
export async function openWorld(browser, { baseUrl, scenario, width, height, dpr = 1, query = {} }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 300));
  });
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('sim', '1');
  url.searchParams.set('scenario', scenario);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => {
    const app = window.__claudeVilleApp;
    return app?._bootState === 'ready' && Boolean(app?.renderer?.camera);
  }, null, { timeout: 60_000 });
  return { context, page, errors };
}

/**
 * Pin the V1 pose: Auto off, fixed hour and weather, camera on a tile at a
 * zoom tier (`survey` where the backing DPR offers it). Returns what the page
 * reports about the GPU world it is posed on.
 */
export function poseWorld(page, { hour = 22, weather = 'clear', zoom = 1, tile = [20, 20] } = {}) {
  return page.evaluate(async ({ hour, weatherProfile, zoom, tile }) => {
    const renderer = window.__claudeVilleApp.renderer;
    renderer.cameraDirector?.setAutoMode?.(false);
    const atmosphere = renderer.atmosphereState || window.__claudeVilleAtmosphere;
    atmosphere?.setTimelineMode?.('fixed');
    atmosphere?.setHour?.(hour);
    atmosphere?.setWeather?.(weatherProfile);
    const camera = renderer.camera;
    camera.abortDirectorGlide?.();
    camera.noteUserInput?.();
    const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
    const point = tileToWorld({ tileX: tile[0], tileY: tile[1] });
    // `tierZoom(0.5)` is the survey tier (SURVEY_TIER): 0.5 at backing DPR 2,
    // the widest resting step elsewhere.
    const cameraZoom = camera.tierZoom(zoom === 'survey' ? 0.5 : Number(zoom));
    renderer.setCameraPose({ x: point.x, y: point.y, zoom: cameraZoom });
    const gpu = renderer.gpuWorld;
    // WebGL2 names its driver; WebGPU its adapter (Stage B: the Chromium default).
    const gl = gpu?.gl;
    const info = gl?.getExtension?.('WEBGL_debug_renderer_info');
    return {
      gpuWorldActive: gpu?.isActive?.() === true,
      backend: renderer.worldRendererMode ?? null,
      glRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
      gpuAdapter: gpu?.adapterInfo ?? null,
      dpr: window.devicePixelRatio,
      zoom: camera.zoom,
      backing: gpu ? [gpu.width, gpu.height] : null,
      agents: renderer.agentSprites?.size ?? null,
    };
  }, { hour, weatherProfile: BENCH_WEATHER[weather], zoom, tile });
}

export function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function hostSnapshot() {
  const cpu = os.cpus()[0];
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: cpu?.model || null,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
  };
}
