// Shared plumbing for the resident-renderer receipt tools (plan 0.1, V2):
// `scripts/smoke/world-fps-benchmark.mjs` (ladder soak, injected load,
// Dashboard return, K-slope and vsync-unlocked arms) and
// `scripts/world/gpu-burst.mjs` (real-frame throughput per level). Imported
// helper; not directly executable.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuLaunchArgs, launchChromium } from './chromium.mjs';
import { startIsolatedServer } from './isolated-server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Pinned weather presets (the V2 quiet-host protocol: clear, plus rain and
// storm for weather items).
export const BENCH_WEATHER = Object.freeze({
  clear: Object.freeze({ type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.08, windX: 0 }),
  rain: Object.freeze({ type: 'rain', intensity: 0.82, precipitation: 0.9, fog: 0.16, cloudCover: 0.92, windX: -0.4 }),
  storm: Object.freeze({ type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78 }),
  overcast: Object.freeze({ type: 'overcast', intensity: 0, precipitation: 0, fog: 0.08, cloudCover: 0.96, windX: -0.15 }),
  fog: Object.freeze({ type: 'fog', intensity: 0.85, precipitation: 0, fog: 0.82, cloudCover: 0.72, windX: -0.05 }),
  snow: Object.freeze({ type: 'snow', intensity: 0.78, precipitation: 0.85, fog: 0.14, cloudCover: 0.94, windX: -0.25, snowCover: 0.92 }),
});

// Real-GPU Chromium (Metal ANGLE on macOS, Vulkan on Linux; see
// `chromium.mjs`): a hardware WebGPU adapter, so the World's default backend
// is WebGPU (pass `query: { renderer: 'webgl' }` to measure WebGL2); the
// unlocked arm adds vsync and frame-rate limits off so the rAF interval is
// the frame's own cost.
export const GPU_LAUNCH_ARGS = Object.freeze(gpuLaunchArgs());
export const NO_GPU_LAUNCH_ARGS = Object.freeze(['--disable-gpu', '--disable-webgl']);
export const UNLOCKED_LAUNCH_ARGS = Object.freeze(['--disable-gpu-vsync', '--disable-frame-rate-limit']);

// A `tag` adds an inert `--cv-bench-tag=<tag>` switch (Chromium ignores
// unknown switches) so `browserRootPid(tag)` can find the launched browser's
// process tree in `/proc`.
// Explicit pure Canvas headed runs use ordinary Chrome flags (omitting
// `GPU_LAUNCH_ARGS`, whose Linux Vulkan ANGLE flags blank headed 2D canvases),
// while resident GPU, hybrid PostFx, headless and `--disable-gpu` runs keep
// their respective flags.
export function benchLaunchArgs({
  headed = false,
  unlocked = false,
  disableGpu = false,
  renderer = null,
  postfx = 'default',
  tag = null,
} = {}) {
  const pureCanvasHeaded = headed === true
    && disableGpu !== true
    && renderer === 'canvas'
    && (postfx === 'off' || postfx === '0' || postfx === false);
  const baseArgs = disableGpu
    ? NO_GPU_LAUNCH_ARGS
    : (pureCanvasHeaded ? [] : GPU_LAUNCH_ARGS);
  return [
    ...baseArgs,
    ...(unlocked ? UNLOCKED_LAUNCH_ARGS : []),
    ...(tag ? [`--cv-bench-tag=${tag}`] : []),
  ];
}

export function launchBenchBrowser({
  headed = false,
  unlocked = false,
  disableGpu = false,
  renderer = null,
  postfx = 'default',
  tag = null,
} = {}) {
  return launchChromium({
    headless: !headed,
    args: benchLaunchArgs({ headed, unlocked, disableGpu, renderer, postfx, tag }),
  });
}

/** Build URL query params for World backend, PostFx and Frontier controls. */
export function buildWorldQuery({ renderer = null, postfx = 'default', frontier = 'default' } = {}) {
  const query = {};
  if (renderer) query.renderer = renderer;
  if (postfx === 'off') query.postfx = '0';
  else if (postfx === 'on') query.postfx = '1';
  if (frontier === 'on') query.frontier = '1';
  else if (frontier === 'off') query.frontier = '0';
  return query;
}

/** Build metadata (package version + short git commit when available). */
export function buildMetadata() {
  let version = null;
  let commit = null;
  let dirty = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    version = pkg?.version ?? null;
  } catch { /* ignore */ }
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
    dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch { /* ignore */ }
  return { version, commit, dirty };
}

function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

// utime + stime in clock ticks (`/proc/<pid>/stat` fields 14 and 15; Linux
// reports them in USER_HZ, 100 on every mainstream kernel), and the parent.
function procStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]) };
  } catch {
    return null;
  }
}

/** The browser process launched with `tag` (Linux `/proc` only), or null. */
export function browserRootPid(tag) {
  if (!tag || !fs.existsSync('/proc/self/stat')) return null;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = procCmdline(entry);
    if (cmdline.includes(`--cv-bench-tag=${tag}`) && !cmdline.includes('--type=')) return Number(entry);
  }
  return null;
}

/**
 * CPU seconds consumed so far by the process tree under `rootPid`, by
 * Chromium process type: `browser`, `renderer`, `gpu` (the GPU process),
 * `utility`, … Exited children no longer count, so sample a steady page.
 */
export function procTreeCpuSeconds(rootPid) {
  const out = {};
  if (!rootPid) return out;
  const children = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(entry);
    if (!stat) continue;
    if (!children.has(stat.ppid)) children.set(stat.ppid, []);
    children.get(stat.ppid).push(Number(entry));
  }
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const stat = procStat(pid);
    if (!stat) continue;
    const type = /--type=([a-z-]+)/.exec(procCmdline(pid))?.[1] || 'browser';
    const key = type === 'gpu-process' ? 'gpu' : type;
    out[key] = (out[key] || 0) + stat.ticks / 100;
    queue.push(...(children.get(pid) || []));
  }
  return out;
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
export async function openWorld(browser, {
  baseUrl,
  scenario,
  width,
  height,
  dpr = 1,
  query = {},
  reducedMotion = false,
  sidebar = 'default',
  autoCamera = false,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  await context.addInitScript(({ sidebarState, autoCam }) => {
    try {
      localStorage.setItem('cv-auto-camera', autoCam ? '1' : '0');
      if (sidebarState === 'collapsed') localStorage.setItem('claudeville.sidebarCollapsed', 'true');
      else if (sidebarState === 'expanded') localStorage.setItem('claudeville.sidebarCollapsed', 'false');
    } catch {}
  }, { sidebarState: sidebar, autoCam: autoCamera === true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 300));
  });
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('sim', '1');
  url.searchParams.set('scenario', scenario);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => {
    const app = window.__claudeVilleApp;
    return app?._bootState === 'ready' && Boolean(app?.renderer?.camera);
  }, null, { timeout: 60_000 });
  return { context, page, errors };
}

/**
 * Pin the V1 pose: Auto off (unless `autoCamera: true`), fixed hour and
 * weather, camera on a tile at a zoom tier (`survey` where the backing DPR
 * offers it). Returns what the page reports about the world it is posed on.
 */
export function poseWorld(page, { hour = 22, weather = 'clear', zoom = 1, tile = [20, 20], autoCamera = false } = {}) {
  return page.evaluate(async ({ hour, weatherProfile, zoom, tile, autoCam }) => {
    const renderer = window.__claudeVilleApp.renderer;
    renderer.cameraDirector?.setAutoMode?.(autoCam === true);
    const atmosphere = renderer.atmosphereState || window.__claudeVilleAtmosphere;
    atmosphere?.setTimelineMode?.('fixed');
    atmosphere?.setHour?.(hour);
    atmosphere?.setWeather?.(weatherProfile);
    const camera = renderer.camera;
    if (!autoCam) {
      camera.abortDirectorGlide?.();
      camera.noteUserInput?.();
      const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
      const point = tileToWorld({ tileX: tile[0], tileY: tile[1] });
      // `tierZoom(0.5)` is the survey tier (SURVEY_TIER): 0.5 at backing DPR 2,
      // the widest resting step elsewhere.
      const cameraZoom = camera.tierZoom(zoom === 'survey' ? 0.5 : Number(zoom));
      renderer.setCameraPose({ x: point.x, y: point.y, zoom: cameraZoom });
    }
    const gpu = renderer.gpuWorld;
    const postFx = renderer.postFx?.getDiagnostics?.() || null;
    const canvasBudget = window.__claudeVillePerf?.canvasBudget?.() || null;
    const mainCanvas = renderer.canvas;
    // WebGL2 names its driver; WebGPU its adapter (Stage B: the Chromium default).
    const gl = gpu?.gl;
    const info = gl?.getExtension?.('WEBGL_debug_renderer_info');
    const frontier = gpu?._frontierDiagnostics?.() || gpu?.getDiagnostics?.()?.frontier || null;
    return {
      gpuWorldActive: gpu?.isActive?.() === true,
      backend: renderer.worldRendererMode ?? null,
      worldBackendReason: renderer.worldBackendReason ?? null,
      worldBackendNotes: renderer.worldBackendNotes ? { ...renderer.worldBackendNotes } : null,
      glRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
      gpuAdapter: gpu?.adapterInfo ?? null,
      dpr: window.devicePixelRatio,
      effectiveDpr: canvasBudget?.dpr ?? null,
      zoom: camera.zoom,
      cameraCenter: camera.screenToWorld(camera._viewportWidth() / 2, camera._viewportHeight() / 2),
      cameraMode: renderer.cameraDirector?.isAutoMode?.() ? 'auto' : 'fixed',
      backing: gpu?.isActive?.()
        ? [gpu.width, gpu.height]
        : (mainCanvas ? [mainCanvas.width, mainCanvas.height] : null),
      visibleCanvasPixels: canvasBudget?.visibleCanvasPixels ?? null,
      maxMainCanvasPixels: canvasBudget?.budgets?.maxMainCanvasPixels ?? null,
      cssViewport: [window.innerWidth, window.innerHeight],
      canvasCss: mainCanvas ? [Math.round(mainCanvas.clientWidth), Math.round(mainCanvas.clientHeight)] : null,
      sidebarCollapsed: Boolean(document.getElementById('sidebar')?.classList?.contains('sidebar--collapsed')),
      postFxSupported: postFx?.supported === true,
      postFxActive: postFx?.active === true,
      frontierEnabled: frontier?.enabled === true,
      frontierMask: frontier?.featureMask ?? 0,
      agents: renderer.agentSprites?.size ?? null,
    };
  }, { hour, weatherProfile: BENCH_WEATHER[weather], zoom, tile, autoCam: autoCamera === true });
}

/**
 * Synchronous in-page collector for the measurement-contract snapshot.
 * Exported so both `readWorldStateSnapshot(page)` and `measureIncidentWindow`
 * reuse the exact same snapshot logic without IPC skew.
 */
export function collectWorldStateSnapshot(ambientFramePacing = null) {
  const app = window.__claudeVilleApp;
  const renderer = app?.renderer;
  const gpu = renderer?.gpuWorld;
  const gpuDiag = gpu?.getDiagnostics?.() || null;
  const postFx = renderer?.postFx?.getDiagnostics?.() || null;
  const postFxFeed = renderer?.postFxFeed?.getDiagnostics?.() || null;
  const canvasBudget = window.__claudeVillePerf?.canvasBudget?.() || null;
  const mainCanvas = renderer?.canvas || null;
  const camera = renderer?.camera || null;
  const gl = gpu?.isActive?.() ? gpu.gl : renderer?.postFx?.gl;
  const info = gl?.getExtension?.('WEBGL_debug_renderer_info');

  const frontierDiag = gpuDiag?.frontier || null;
  const frontierPasses = frontierDiag?.passes
    ? Object.fromEntries(Object.entries(frontierDiag.passes).map(([name, entry]) => [name, {
      configured: gpu.frontierConfig?.[name] !== false && (name !== 'shafts' || gpu.frontierConfig?.surfaceDepth !== false),
      ready: entry?.ready === true,
      error: entry?.error ?? null,
    }]))
    : null;
  const readyPasses = frontierPasses
    ? Object.entries(frontierPasses).filter(([, entry]) => entry.ready).map(([name]) => name)
    : [];
  const pendingPasses = frontierPasses
    ? Object.entries(frontierPasses).filter(([, entry]) => entry.configured && !entry.ready).map(([name]) => name)
    : [];

  const gpuTimerSupported = gpuDiag?.gpuTimerSupported === true;
  const gpuTimerSamples = gpuDiag?.gpuTimerSamples ?? 0;
  const gpuMs = Number.isFinite(gpuDiag?.gpuMs) ? gpuDiag.gpuMs : null;
  const gpuTimingState = gpuDiag?.active
    ? (gpuTimerSupported && gpuTimerSamples > 0 && gpuMs !== null ? 'measured' : 'unknown')
    : (postFx?.active
      ? (Number.isFinite(postFx?.gpuMs) ? 'measured' : 'unknown')
      : 'not-applicable');

  const worldStats = app?.world?.getStats?.() || null;
  const qualityLevel = gpuDiag?.active
    ? gpuDiag.qualityLevel
    : (postFx?.active ? (postFx.level ?? postFx.ladder?.effectiveLevel ?? null) : null);
  const qualityReason = gpuDiag?.active
    ? gpuDiag.qualityReason
    : (postFx?.active ? (postFx.ladder?.lastDecisionReason ?? null) : null);

  return {
    backend: renderer?.worldRendererMode ?? null,
    worldBackendReason: renderer?.worldBackendReason ?? null,
    worldBackendNotes: renderer?.worldBackendNotes ? { ...renderer.worldBackendNotes } : null,
    gpuWorldActive: gpu?.isActive?.() === true,
    gpuAdapter: gpu?.adapterInfo ?? null,
    glRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
    postFx: {
      supported: postFx?.supported === true,
      active: postFx?.active === true,
      suspended: postFx?.suspended === true,
      level: postFx?.level ?? null,
      ladderReason: postFx?.ladder?.lastDecisionReason ?? null,
      frames: postFx?.frames ?? 0,
      uploadMs: Number.isFinite(postFx?.uploadMs) ? postFx.uploadMs : null,
      maskUploadMs: Number.isFinite(postFx?.maskUploadMs) ? postFx.maskUploadMs : null,
      setupCpuMs: Number.isFinite(postFx?.setupCpuMs) ? postFx.setupCpuMs : null,
      shaderCpuMs: Number.isFinite(postFx?.shaderCpuMs) ? postFx.shaderCpuMs : null,
      renderTotalCpuMs: Number.isFinite(postFx?.renderTotalCpuMs) ? postFx.renderTotalCpuMs : null,
      gpuMs: Number.isFinite(postFx?.gpuMs) ? postFx.gpuMs : null,
      feed: postFxFeed ? {
        maskPixels: postFxFeed.maskPixels ?? null,
        maskRebuilds: postFxFeed.maskRebuilds ?? 0,
        maskReuses: postFxFeed.maskReuses ?? 0,
        maskLastReason: postFxFeed.maskLastReason ?? null,
      } : null,
    },
    frontier: {
      enabled: frontierDiag?.enabled === true,
      featureMask: frontierDiag?.featureMask ?? 0,
      allReady: frontierDiag?.enabled === true ? readyPasses.length > 0 && pendingPasses.length === 0 : null,
      readyPasses,
      pendingPasses,
      passes: frontierPasses,
      policy: frontierDiag?.policy ?? null,
    },
    quality: {
      level: qualityLevel,
      reason: qualityReason,
      shedEffects: gpuDiag?.shedEffects ? gpuDiag.shedEffects.map(effect => `${effect.id} ${effect.mode}`) : [],
      transitions: gpuDiag?.qualityTransitions ?? null,
      timingSource: gpuDiag?.qualityTimingSource ?? null,
    },
    viewport: {
      css: [window.innerWidth, window.innerHeight],
      canvasCss: mainCanvas ? [Math.round(mainCanvas.clientWidth), Math.round(mainCanvas.clientHeight)] : null,
      backing: gpu?.isActive?.()
        ? [gpu.width, gpu.height]
        : (mainCanvas ? [mainCanvas.width, mainCanvas.height] : null),
      visibleCanvasPixels: canvasBudget?.visibleCanvasPixels ?? (mainCanvas ? mainCanvas.width * mainCanvas.height : null),
      maxMainCanvasPixels: canvasBudget?.budgets?.maxMainCanvasPixels ?? null,
      effectiveDpr: canvasBudget?.dpr ?? null,
      windowDpr: window.devicePixelRatio,
      sidebarCollapsed: Boolean(document.getElementById('sidebar')?.classList?.contains('sidebar--collapsed')),
    },
    camera: {
      mode: renderer?.cameraDirector?.isAutoMode?.() ? 'auto' : 'fixed',
      center: camera?.screenToWorld(camera._viewportWidth() / 2, camera._viewportHeight() / 2) ?? null,
      x: camera?.x ?? null,
      y: camera?.y ?? null,
      zoom: camera?.zoom ?? null,
      gliding: Boolean(camera?.isDirectorGliding?.() || camera?._zoomAnimation || camera?._followEase),
      owner: renderer?.cameraDirector?.getOwner?.() ?? null,
    },
    atmosphere: {
      hour: renderer?._lastAtmosphere?.clock?.minuteOfDay != null
        ? Number((renderer._lastAtmosphere.clock.minuteOfDay / 60).toFixed(2))
        : null,
      clockLabel: renderer?._lastAtmosphere?.clock?.label ?? null,
      weather: renderer?._lastAtmosphere?.weather?.type ?? null,
      effectiveMonth: renderer?._lastAtmosphere?.effectiveDate?.getMonth?.() ?? null,
    },
    agents: {
      total: app?.world?.agents?.size ?? renderer?.agentSprites?.size ?? null,
      working: worldStats?.working ?? null,
      idle: worldStats?.idle ?? null,
      waiting: worldStats?.waiting ?? null,
    },
    pacing: {
      ambientFramePacing,
      motionScale: renderer?.motionScale ?? null,
      ambientNow: renderer?._framePacing?.ambient === true,
    },
    presentGeneration: renderer?.presentGeneration ?? 0,
    debugOverlayEnabled: renderer?.debugOverlay?.enabled === true,
    frameFailures: canvasBudget?.runtime?.frameFailures
      ? {
        total: canvasBudget.runtime.frameFailures.total ?? 0,
        consecutive: canvasBudget.runtime.frameFailures.consecutive ?? 0,
        paused: canvasBudget.runtime.frameFailures.paused === true,
        byStage: { ...(canvasBudget.runtime.frameFailures.byStage || {}) },
      }
      : null,
    gpu: gpuDiag
      ? {
        active: gpuDiag.active === true,
        frames: gpuDiag.frames ?? 0,
        skippedFrames: gpuDiag.skippedFrames ?? 0,
        uploads: gpuDiag.uploads ?? 0,
        uploadBytes: gpuDiag.uploadBytes ?? 0,
        uploadBytesByKind: gpuDiag.uploadBytesByKind ? { ...gpuDiag.uploadBytesByKind } : null,
        textureEvictions: gpuDiag.textureEvictions ?? 0,
        records: gpuDiag.records ?? null,
        batches: gpuDiag.batches ?? null,
        lights: gpuDiag.lights ?? null,
        lightAdmission: gpuDiag.lightAdmission ? { ...gpuDiag.lightAdmission } : null,
        cachedTextures: gpuDiag.cachedTextures ?? null,
        cachedTextureBytes: gpuDiag.cachedTextureBytes ?? null,
        residentTextureBytes: gpuDiag.residentTextureBytes ?? gpuDiag.textureBytes ?? null,
        gpuMs,
        gpuMsP25: Number.isFinite(gpuDiag.gpuMsP25) ? gpuDiag.gpuMsP25 : null,
        gpuTimerSupported,
        gpuTimerSamples,
        gpuTimingState,
        passSamplingEnabled: gpuDiag.passSamplingEnabled === true,
        passes: gpuDiag.passSamplingEnabled && gpuDiag.passes ? gpuDiag.passes : null,
      }
      : {
        active: false,
        frames: 0,
        skippedFrames: 0,
        uploads: 0,
        uploadBytes: 0,
        uploadBytesByKind: null,
        textureEvictions: 0,
        records: null,
        batches: null,
        lights: null,
        lightAdmission: null,
        cachedTextures: null,
        cachedTextureBytes: null,
        residentTextureBytes: null,
        gpuMs: null,
        gpuMsP25: null,
        gpuTimerSupported: false,
        gpuTimerSamples: 0,
        gpuTimingState,
        passSamplingEnabled: false,
        passes: null,
      },
    water: renderer?._canvasWater?.stats ? { ...renderer._canvasWater.stats } : null,
    lightGradients: renderer?.lightGradientCache?.size ?? null,
  };
}

/**
 * Capture a complete World runtime snapshot for measurement-contract reporting:
 * effective backend, PostFx, Frontier mask/readiness, quality level, pacing,
 * viewport/backing dimensions, camera state, GPU/water counters, and agent counts.
 */
export function readWorldStateSnapshot(page) {
  return page.evaluate(async (collectSource) => {
    let ambientFramePacing = null;
    try {
      const pacingModule = await import('/src/presentation/character-mode/FramePacing.js');
      ambientFramePacing = pacingModule?.AMBIENT_FRAME_PACING === true;
    } catch { /* optional */ }
    const collect = typeof collectSource === 'string'
      ? new Function(`return (${collectSource});`)()
      : collectWorldStateSnapshot;
    return collect(ambientFramePacing);
  }, collectWorldStateSnapshot.toString());
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
