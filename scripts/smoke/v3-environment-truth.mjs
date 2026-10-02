#!/usr/bin/env node
// V3 environment truth and reduced-motion static frames (Phase 5, definition
// of done line 3: no environment pixel changes with agent state; every motion
// has a static reduced-motion frame).
//
// One isolated server; per World backend (WebGPU default, `?renderer=webgl`,
// `?renderer=canvas`) three arms, each truth timeline and each other arm on a
// fresh page (new context: nothing an earlier timeline's states left, such
// as Harbor ships or the release pennant, carries over):
//
//   truth  - reduced motion. The environment timeline is pinned (date,
//            minute, explicit seed: AtmosphereState.update always sees the
//            pinned `now`, in auto/timeline mode), the camera is pinned, the
//            quality ladder is held FULL and the mark governor calm. From a
//            0-agent baseline the agent-state matrix runs: 24 and 100 agents,
//            all working / idle / waiting, push success, failed push,
//            release, director replay / quota / parade / Ambient, Chronicle
//            populated. Pass per state: the state took (agent count), every
//            environment producer's resolved state (atmosphere, ground,
//            wetness, wind, cloud drift, water frame, the GPU/PostFx feed and
//            frame uniforms, sky/weather renderers, wildlife, seasonal drift,
//            weather particles) equals the baseline's, and no sky pixel above
//            the sea horizon changes outside DOM chrome (Canvas only: up to
//            SKY_LSB_BUDGET 1-LSB rim pixels, the 2D rasterizer's
//            anti-aliasing switch). The baseline is taken once the frame is
//            still; recaptured 3 s later it must be 0 px and equal state.
//   static - reduced motion. Thirteen environment-only scenes (no agents:
//            day, harbor, shallows, golden hour, rainbow, night wide /
//            lighthouse / command / harbor, storm, rain drips, snow, fog).
//            Two captures 3 s apart: 0 changed px outside DOM chrome, the
//            motion clock reads 0, no running document animation.
//   motion - full motion, the same scenes: two captures 2.5 s apart must
//            differ by at least MIN_MOTION_PX, so a 0-px static result means
//            the motion was held, not absent.
//
// Diagnostics (failing frames and diff overlays) and report.json go to
// `--out` (default output/v3-environment-truth/<stamp>/).
// Exit: 0 every check passed; 1 any failure; 2 nothing failed but a
// requested backend was unavailable.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { GPU_LAUNCH_ARGS, resolveServer } from './support/world-bench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWPORT = { width: 2560, height: 1440 };
// Every environment scene moves >= ~97k px in 2.5 s of full motion (2560x1440).
const MIN_MOTION_PX = 10_000;
const RENDERERS = ['webgpu', 'webgl', 'canvas'];
const ARMS = ['truth', 'static', 'motion'];

const T = (mo, d, h, mi, seed) => Object.freeze({ y: 2026, mo, d, h, mi, seed });
// Timelines for the truth arm (weather resolved from the seed on that date).
const TIMELINES = Object.freeze({
  'partly-noon': T(5, 15, 12, 0, 1), // partly cloudy
  'storm-noon': T(5, 15, 12, 0, 136), // storm, puddles, strong wind
  'clear-night': T(5, 15, 22, 0, 2), // clear night
  'snow-noon': T(0, 15, 12, 0, 2), // January precipitation falls as snow, snow cover
  'fog-noon': T(5, 15, 12, 0, 5), // fog
});
const FULL_MATRIX_TIMELINES = new Set(['partly-noon', 'storm-noon']);
const TRUTH_POSE = Object.freeze({ tile: [10, 6], zoom: 1 });

// [id, apply(page), expected agent count (null: at least one)]
const STATES = [
  ['dense-24', page => setScenario(page, 'dense-24-agents'), 24],
  ['dense-100', page => setScenario(page, 'dense-100-agents'), 100],
  ['all-working', page => setAllStatus(page, 'working'), 100],
  ['all-idle', page => setAllStatus(page, 'idle'), 100],
  ['all-waiting', page => setAllStatus(page, 'waiting_on_user'), 100],
  ['push-success', page => setScenario(page, 'git-harbor'), null],
  ['push-failed', page => setScenario(page, 'failed-push'), null],
  ['release', page => setScenario(page, 'release-parade'), null],
  ['dir-replay', async (page) => {
    await setScenario(page, 'dense-24-agents');
    await page.evaluate(() => window.__claudeVilleApp.renderer.villageDirector.setReplayActive(true));
  }, 24],
  ['dir-quota', page => page.evaluate(() => {
    const r = window.__claudeVilleApp.renderer;
    r.villageDirector.setReplayActive(false);
    r.villageDirector.setQuotaState({ fiveHour: 0.97 });
    r.setQuotaState?.({ fiveHour: 0.97 });
  }), 24],
  ['dir-parade', page => page.evaluate(() => window.__claudeVilleApp.renderer.villageDirector
    .triggerReleaseParade({ label: 'v9.9.9', version: 'v9.9.9', weight: 'major' })), 24],
  ['dir-ambient', page => page.evaluate(() => {
    const r = window.__claudeVilleApp.renderer;
    r.cameraDirector.setAutoMode(true);
    r.cameraDirector.setAmbient(true);
  }), 24],
  ['chronicle-after', async (page) => {
    await page.evaluate(() => {
      const r = window.__claudeVilleApp.renderer;
      r.cameraDirector.setAmbient(false);
      r.cameraDirector.setAutoMode(false);
    });
    await setScenario(page, 'no-agents');
  }, 0],
];
const SHORT_STATES = new Set(['dense-100', 'all-working', 'all-waiting', 'push-failed', 'release', 'chronicle-after']);

// Environment-only scenes: [id, timeline, pose, zoom]. A pose is a tile or a
// building (its screen centre, optionally offset in world px).
const SCENES = [
  ['day-wide-z1', T(5, 15, 12, 0, 1), { tile: [10, 6] }, 1],
  ['day-harbor-z2', T(5, 15, 12, 0, 1), { building: 'harbor' }, 2],
  ['clear-shallows-z3', T(5, 15, 12, 0, 3), { building: 'harbor', dx: -160, dy: 80 }, 3],
  ['golden-z1', T(5, 15, 19, 30, 3), { tile: [10, 6] }, 1],
  ['rainbow-z1', T(5, 15, 19, 10, 8), { tile: [10, 6] }, 1],
  ['night-wide-z1', T(5, 30, 22, 0, 2), { tile: [10, 6] }, 1],
  ['night-lighthouse-z2', T(5, 30, 22, 0, 2), { building: 'watchtower' }, 2],
  ['night-command-z3', T(5, 30, 22, 0, 2), { building: 'command' }, 3],
  ['night-harbor-z3', T(5, 30, 22, 0, 2), { building: 'harbor', dx: -120, dy: 60 }, 3],
  ['storm-wide-z1', T(5, 15, 12, 0, 136), { tile: [10, 6] }, 1],
  ['rain-forge-z3', T(5, 15, 12, 0, 2), { building: 'forge' }, 3],
  ['snow-command-z2', T(0, 15, 12, 0, 2), { building: 'command' }, 2],
  ['fog-wide-z1', T(5, 15, 12, 0, 5), { tile: [10, 6] }, 1],
];

// Environment-state paths that are agent-tied (V3/V8-legit: agent and fire
// lights, their halos, footprints and the Canvas pools' receiver mask, whose
// rect is the lights' reach) or bookkeeping (clocks of the frame loop, camera
// input stamps, cache keys, bake counters, GPU resource byte counts). The
// hybrid (Canvas) feed's `timeMs` is the frame's wall time; its shader holds
// the phase under reduced motion (`u_reducedMotion`), and the motion clock
// itself is compared as `motionTimeMs`.
const IGNORED_PATHS = [
  /^feed\.(lights|haze|footprint|radiance|poolMask)\b/,
  /^feed\.(timeMs|water\.maskRevision)$/,
  /^frameState\.(light|lights|lightCount|tile|cluster|admission|wetReflectionCount|beamGround|footprint|radiance|mark|record)/i,
  /^weatherRenderer\.sceneContext\.camera\./,
  /^skyRenderer\.(deckBakes|plateBakes|_frameCacheKey)$/,
  /^wildlife\.(_landBirdLastNow|_sceneFrameToken|_sceneFrameNow)$/,
  /^postFx\.(light|attention|poolMask|hazeValues|maskRevision|_frameMaskUploadMs|textureBytes|resourceBytes|pendingGpuQueries|unifiedResources|gpuMs|cpuMs|frames|upload|_upload|timings|lastUpload|sourceUpload|maskUpload|diagnostics)/,
  /^postFx\.\w*(CpuMs|GpuMs|UploadMs|GapMs|EndMs)$/,
];
// Chrome's 2D canvas switches a render pass's anti-aliasing (to multisample)
// under heavy path load: on the Canvas world, 100 agents move the code
// moon's anti-aliased rim by 1 LSB on a few dozen pixels, and so do 3000
// unrelated paths with no agents. A sky pixel that changes by more than 1
// LSB, or more 1-LSB pixels than this, fails.
const SKY_LSB_BUDGET = 256;
// Particle presets that belong to agents, buildings or moments (not weather).
const AGENT_PARTICLE = /^(footfall|spark|sparkle|smoke|dust|chip|bump|sweat|scuff|crowd|forge|recovery|splash-agent|sigil|rune|comet|ember|mote|confetti|coin)/i;

function usage() {
  return `Usage: node scripts/smoke/v3-environment-truth.mjs [options]

  --renderers=<list>  ${RENDERERS.join(',')} (default: all)
  --arms=<list>       ${ARMS.join(',')} (default: all)
  --timelines=<list>  truth-arm timelines: ${Object.keys(TIMELINES).join(',')} (default: all)
  --scenes=<list>     static/motion scenes (default: all ${SCENES.length})
  --out=<dir>         report and diagnostics (default: output/v3-environment-truth/<stamp>)
  --url=<baseUrl>     an explicit ClaudeVille server (default: an isolated server)
  --headed            show the browser`;
}

function parseList(value, allowed, name) {
  const list = String(value).split(',').map(s => s.trim()).filter(Boolean);
  for (const item of list) if (!allowed.includes(item)) throw new Error(`--${name}: unknown ${item} (known: ${allowed.join(',')})`);
  return list;
}

function parseArgs(argv) {
  const options = { renderers: RENDERERS, arms: ARMS, timelines: Object.keys(TIMELINES), scenes: SCENES.map(s => s[0]), out: null, url: null, headed: false };
  for (const arg of argv) {
    const [key, value = ''] = arg.replace(/^--/, '').split('=');
    if (key === 'help' || key === 'h') { console.log(usage()); process.exit(0); }
    else if (key === 'renderers') options.renderers = parseList(value, RENDERERS, key);
    else if (key === 'arms') options.arms = parseList(value, ARMS, key);
    else if (key === 'timelines') options.timelines = parseList(value, Object.keys(TIMELINES), key);
    else if (key === 'scenes') options.scenes = parseList(value, SCENES.map(s => s[0]), key);
    else if (key === 'out') options.out = value;
    else if (key === 'url') options.url = value;
    else if (key === 'headed') options.headed = true;
    else throw new Error(`unknown option ${arg}\n${usage()}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Page setup and pinning.

class BackendUnavailable extends Error {}

async function openArm(browser, baseUrl, { renderer, reduced }) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 300)));
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('sim', '1');
  url.searchParams.set('scenario', 'no-agents');
  if (renderer !== 'webgpu') url.searchParams.set('renderer', renderer);
  await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => {
    const app = window.__claudeVilleApp;
    return app?._bootState === 'ready' && Boolean(app?.renderer?.camera);
  }, null, { timeout: 60_000 });
  // The default arm boots WebGL2 on a cold shader cache and switches live.
  try {
    await page.waitForFunction((want) => {
      const r = window.__claudeVilleApp.renderer;
      const name = r.gpuWorld?.constructor?.name || '';
      if (want === 'canvas') return !r.gpuWorld;
      return want === 'webgpu' ? /WebGPU/.test(name) : name === 'GpuWorldRenderer';
    }, renderer, { timeout: 60_000 });
  } catch {
    const reason = await page.evaluate(() => window.__claudeVilleApp.renderer.worldBackendReason || null).catch(() => null);
    await context.close();
    throw new BackendUnavailable(`${renderer} backend did not start (${reason || 'no reason reported'})`);
  }
  await page.evaluate(async () => {
    // Hold the ladder FULL and the mark governor calm, so no shed or admit
    // decision (host load) differs between captures.
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
    // The hybrid (Canvas) PostFx path keeps no render context: keep the last
    // feed it built.
    const feed = r.postFxFeed;
    if (feed?.build && !feed.__v3Wrapped) {
      const build = feed.build.bind(feed);
      feed.build = ctx => (window.__v3LastFeed = build(ctx));
      feed.__v3Wrapped = true;
    }
  });
  await page.waitForTimeout(2000);
  const backend = await page.evaluate(() => {
    const r = window.__claudeVilleApp.renderer;
    return { gpu: r.gpuWorld?.constructor?.name || null, postFx: Boolean(r.postFx), motionScale: r.motionScale, reason: r.worldBackendReason || null };
  });
  return { context, page, errors, backend };
}

// AtmosphereState.update sees the pinned date every frame (no hour override),
// with the explicit seed, in auto (timeline) mode.
function pinTimeline(page, t) {
  return page.evaluate((t) => {
    const a = window.__claudeVilleApp.renderer.atmosphereState;
    a.clear();
    a.setSeed(t.seed);
    a.setTimelineMode('auto');
    const pinned = new Date(t.y, t.mo, t.d, t.h, t.mi, 0, 0).getTime();
    if (!a.__v3Update) a.__v3Update = a.update.bind(a);
    a.update = (o = {}) => a.__v3Update({ ...o, now: new Date(pinned) });
  }, t);
}

function pinPose(page, pose, zoom) {
  return page.evaluate(async ({ pose, zoom }) => {
    const r = window.__claudeVilleApp.renderer;
    r.cameraDirector?.setAmbient?.(false);
    r.cameraDirector?.setAutoMode?.(false);
    r.camera.noteUserInput?.();
    let w;
    if (pose.building) {
      const b = [...(r.buildingRenderer?.buildings || [])].find(x => x.type === pose.building);
      const c = r.buildingRenderer._buildingScreenCenter(b);
      w = { x: c.x + (pose.dx || 0), y: c.y + (pose.dy || 0) };
    } else {
      const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
      w = tileToWorld({ tileX: pose.tile[0], tileY: pose.tile[1] });
    }
    r.camera.abortDirectorGlide?.();
    r.setCameraPose({ x: w.x, y: w.y, zoom });
  }, { pose, zoom });
}

// Re-assert the camera pose without leaving Ambient (the dir-ambient state).
function reassertPose(page, pose, zoom) {
  return page.evaluate(async ({ pose, zoom }) => {
    const r = window.__claudeVilleApp.renderer;
    const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
    const w = tileToWorld({ tileX: pose.tile[0], tileY: pose.tile[1] });
    r.camera.abortDirectorGlide?.();
    r.setCameraPose({ x: w.x, y: w.y, zoom });
  }, { pose, zoom });
}

function setScenario(page, id) {
  return page.evaluate((id) => {
    const sim = window.__claudeVilleApp.agentSimulator;
    sim.stop();
    sim.start(id);
  }, id);
}

function setAllStatus(page, status) {
  return page.evaluate((status) => {
    const app = window.__claudeVilleApp;
    const now = Date.now();
    for (const a of app.world.agents.values()) {
      app.world.updateAgent(a.id, {
        status,
        currentTool: status === 'working' ? 'Edit' : null,
        currentToolInput: status === 'working' ? 'file_path=/sim/probe.js' : null,
        lastSessionActivity: now,
        activityAgeMs: 0,
      });
    }
  }, status);
}

// ---------------------------------------------------------------------------
// Capture: a screenshot, the environment snapshot and the DOM chrome rects
// (taken before and after the screenshot: toasts come and go).

function collectDom(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('worldCanvas') || window.__claudeVilleApp.renderer.canvas;
    const cr = canvas.getBoundingClientRect();
    const rects = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.right <= cr.left || b.left >= cr.right || b.bottom <= cr.top || b.top >= cr.bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (b.width * b.height >= cr.width * cr.height * 0.5) continue; // containers
      rects.push([Math.floor(b.left) - 4, Math.floor(b.top) - 4, Math.ceil(b.right) + 4, Math.ceil(b.bottom) + 4]);
    }
    return rects;
  });
}

function collectGeometry(page) {
  return page.evaluate(async () => {
    const r = window.__claudeVilleApp.renderer;
    const canvas = document.getElementById('worldCanvas') || r.canvas;
    const cr = canvas.getBoundingClientRect();
    const { OCEAN_HORIZON_WORLD_Y } = await import('/src/presentation/character-mode/CoastBake.js');
    return {
      canvas: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.right), Math.round(cr.bottom)],
      horizonY: Math.round(r.camera.worldToScreen(0, OCEAN_HORIZON_WORLD_Y).y + cr.top),
    };
  });
}

// Every environment producer's resolved state, JSON-safe, numbers rounded.
function collectEnv(page) {
  return page.evaluate(async () => {
    const r = window.__claudeVilleApp.renderer;
    const round = v => Math.round(v * 1e5) / 1e5;
    const hashArr = (a) => {
      let h = 2166136261;
      for (let i = 0; i < a.length; i++) { h ^= Math.round(Number(a[i]) * 1000) & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; }
      return `#${a.length}:${h.toString(16)}`;
    };
    const plain = (v, depth = 0, seen = new WeakSet()) => {
      if (v == null || typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number') return Number.isFinite(v) ? round(v) : String(v);
      if (typeof v === 'function') return undefined;
      if (typeof v !== 'object') return String(v);
      if (ArrayBuffer.isView(v)) return v.length <= 64 ? Array.from(v, round) : hashArr(v);
      if (v instanceof HTMLCanvasElement || v instanceof OffscreenCanvas || v instanceof ImageBitmap || v instanceof HTMLImageElement || v instanceof ImageData) return `[img ${v.width}x${v.height}]`;
      if (typeof GPUBuffer !== 'undefined' && (v instanceof GPUBuffer || v instanceof GPUTexture)) return '[gpu]';
      if (typeof WebGLTexture !== 'undefined' && (v instanceof WebGLTexture || v instanceof WebGLBuffer || v instanceof WebGLFramebuffer || v instanceof WebGLProgram || v instanceof WebGLUniformLocation)) return '[gl]';
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
      if (depth >= 4) return '[deep]';
      if (Array.isArray(v)) return v.length > 48 ? `[array ${v.length}]` : v.map(x => plain(x, depth + 1, seen));
      if (v instanceof Map || v instanceof Set) return `[${v.constructor.name} ${v.size}]`;
      if (v instanceof Date) return v.toISOString();
      const out = {};
      for (const k of Object.keys(v)) {
        const x = plain(v[k], depth + 1, seen);
        if (x !== undefined) out[k] = x;
      }
      return out;
    };
    // An object's own scalar, typed-array, small-array and plain-object fields.
    const pick = (obj) => {
      if (!obj) return null;
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v == null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || ArrayBuffer.isView(v)) out[k] = plain(v);
        else if (Array.isArray(v)) out[k] = v.length <= 48 ? plain(v) : `[array ${v.length}]`;
        else if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) out[k] = plain(v, 2);
      }
      return out;
    };
    const Wind = await import('/src/presentation/character-mode/Wind.js');
    const t = r.motionTimeMs;
    const weather = r._lastAtmosphere?.weather;
    const wind = [];
    for (const [x, y] of [[0, 0], [600, 300], [-600, 300], [1200, 900], [300, -400], [2000, 1200]]) {
      const w = Wind.windAt(x, y, t, weather, { x: 0, gust: 0 });
      wind.push([round(w.x), round(w.gust)]);
    }
    const particles = {};
    for (const p of r.particleSystem?.particles || []) {
      const k = p.type || p.preset || p.kind || '?';
      particles[k] = (particles[k] || 0) + 1;
    }
    const wl = r.wildlifeRenderer;
    let gulls;
    try {
      const flying = wl?._gullPlan?.().flying ? wl._openSeaGullPositions() : [];
      const beacon = wl?._watchtowerGullPosition?.();
      gulls = { stats: plain(wl?.lastGullStats), list: [...flying, ...(beacon ? [beacon] : [])].map(g => [round(g.x), round(g.y), g.frameId]) };
    } catch (error) {
      gulls = { error: String(error).slice(0, 120) };
    }
    return {
      env: {
        motionTimeMs: t,
        atmosphere: plain(r._lastAtmosphere),
        ground: plain(r._groundState),
        surfaceWetness: plain(r._surfaceWetness),
        reactions: plain(r._atmosphereReactions),
        wind,
        cloudDrift: plain(Wind.cloudCourseDrift(t, weather)),
        waterFrame: plain(r.waterFrame),
        feed: pick(r._gpuRenderContext?.feed || window.__v3LastFeed || null),
        frameState: r.gpuWorld?._frameState ? plain(r.gpuWorld._frameState) : null,
        postFx: pick(r.postFx),
        weatherRenderer: pick(r.weatherRenderer),
        skyRenderer: pick(r.skyRenderer),
        wildlife: pick(wl),
        gulls,
        seasonal: pick(r.seasonalAmbience),
        particles,
      },
      agents: r.agentSprites?.size ?? 0,
      running: document.getAnimations().filter(a => a.playState === 'running').length,
    };
  });
}

async function capture(page, { pose, zoom, keepAmbient = false }) {
  if (keepAmbient) await reassertPose(page, pose, zoom);
  else await pinPose(page, pose, zoom);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    if (!window.__claudeVilleApp.renderer.renderNow()) throw new Error('environment capture repaint failed');
  });
  const before = await collectDom(page);
  const png = PNG.sync.read(await page.screenshot());
  const after = await collectDom(page);
  const { env, agents, running } = await collectEnv(page);
  const geometry = await collectGeometry(page);
  return { png, env, agents, running, dom: [...before, ...after], ...geometry };
}

// ---------------------------------------------------------------------------
// Comparisons.

function diffPaths(a, b, at = '', out = []) {
  if (a === b) return out;
  const oa = a && typeof a === 'object';
  const ob = b && typeof b === 'object';
  if (!oa || !ob) {
    out.push(at);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out);
  return out;
}

function envDiff(a, b) {
  const agentParticle = p => /^particles\./.test(p) && AGENT_PARTICLE.test(p.slice('particles.'.length));
  return diffPaths(a, b).filter(p => !IGNORED_PATHS.some(re => re.test(p)) && !agentParticle(p));
}

// Changed pixels inside the world canvas and outside the excluded rects: all of them
// and those in the sky above the sea horizon. With `overlay`, a PNG marking
// them (magenta) over the dimmed second frame.
function pixelDiff(A, B, { canvas, horizonY, excluded }, overlay = false) {
  const W = A.width;
  const H = A.height;
  const skip = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of excluded) {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) skip.fill(1, y * W + Math.max(0, x0), y * W + Math.min(W, x1));
  }
  const vis = overlay ? new PNG({ width: W, height: H }) : null;
  let changed = 0;
  let sky = 0;
  let skyOver1 = 0;
  let box = null;
  const [cx0, cy0, cx1, cy1] = canvas;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const p = y * W + x;
      const i = p * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      if (vis) {
        const g = (B.data[i] * 0.3 + B.data[i + 1] * 0.59 + B.data[i + 2] * 0.11) * 0.35;
        vis.data[i] = vis.data[i + 1] = vis.data[i + 2] = g;
        vis.data[i + 3] = 255;
      }
      if (!d || skip[p]) continue;
      changed++;
      if (y < horizonY - 2) {
        sky++;
        if (d > 1) skyOver1++;
      }
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1];
      if (vis) { vis.data[i] = 255; vis.data[i + 1] = 40; vis.data[i + 2] = 200; }
    }
  }
  return { changed, sky, skyOver1, box, vis };
}

// ---------------------------------------------------------------------------
// Arms.

// The baseline must be still before it is a baseline (the fresh page's first
// bakes and backend switch). Recapture until two frames 2 s apart match (at
// most 30 s).
async function settledBaseline(shot) {
  let previous = await shot();
  for (let waited = 0; waited < 30_000; waited += 2000) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const next = await shot();
    if (!compare(previous, next).changed) return next;
    previous = next;
  }
  return previous;
}

// One timeline on its own fresh page (a new context: no Harbor ships, release
// pennant or Chronicle entries left by an earlier timeline's states).
async function runTruth(page, tl, record, renderer) {
  const lsbBudget = renderer === 'canvas' ? SKY_LSB_BUDGET : 0;
  await pinTimeline(page, TIMELINES[tl]);
  await pinPose(page, TRUTH_POSE, TRUTH_POSE.zoom);
  await page.waitForTimeout(3000);
  const shot = (keepAmbient = false) => capture(page, { pose: TRUTH_POSE, zoom: TRUTH_POSE.zoom, keepAmbient });
  const base = await settledBaseline(shot);
  await page.waitForTimeout(3000);
  const again = await shot();
  const control = compare(base, again);
  const controlPaths = envDiff(base.env, again.env);
  const controlFailures = [];
  if (control.changed) controlFailures.push(`${control.changed} px changed with nothing changed (box ${control.box})`);
  if (controlPaths.length) controlFailures.push(`env state drifted: ${controlPaths.slice(0, 6).join(', ')}`);
  if (base.agents !== 0) controlFailures.push(`baseline has ${base.agents} agents`);
  record({ arm: 'truth', timeline: tl, state: 'control', weather: base.env.atmosphere?.weather?.type ?? null, px: control.changed, sky: control.sky, envPaths: controlPaths.length, failures: controlFailures }, [base, again]);
  for (const [state, apply, expected] of STATES) {
    if (!FULL_MATRIX_TIMELINES.has(tl) && !SHORT_STATES.has(state)) continue;
    await apply(page);
    await page.waitForTimeout(state === 'dir-ambient' ? 3500 : 2500);
    const cap = await shot(state === 'dir-ambient');
    const d = compare(base, cap);
    const paths = envDiff(base.env, cap.env);
    const failures = [];
    if (expected == null ? cap.agents < 1 : cap.agents !== expected) failures.push(`state did not take: ${cap.agents} agents (expected ${expected ?? '>= 1'})`);
    if (paths.length) failures.push(`environment state follows agent state: ${paths.slice(0, 8).join(', ')}`);
    if (d.skyOver1 || d.sky > lsbBudget) failures.push(`${d.sky} sky px changed with agent state (${d.skyOver1} by more than 1 LSB)`);
    record({ arm: 'truth', timeline: tl, state, weather: cap.env.atmosphere?.weather?.type ?? null, agents: cap.agents, px: d.changed, sky: d.sky, skyOver1: d.skyOver1, envPaths: paths.length, failures }, [base, cap]);
  }
}

async function runScenes(page, options, record, { reduced }) {
  const arm = reduced ? 'static' : 'motion';
  await setScenario(page, 'no-agents');
  for (const [id, tl, pose, zoom] of SCENES) {
    if (!options.scenes.includes(id)) continue;
    await pinTimeline(page, tl);
    await pinPose(page, pose, zoom);
    await page.waitForTimeout(3500);
    const a = await capture(page, { pose, zoom });
    await page.waitForTimeout(reduced ? 3000 : 2500);
    const b = await capture(page, { pose, zoom });
    const d = compare(a, b);
    const failures = [];
    if (a.agents || b.agents) failures.push(`scene has agents (${a.agents}, ${b.agents})`);
    if (reduced) {
      if (d.changed) failures.push(`${d.changed} px changed under reduced motion (box ${d.box})`);
      if (a.env.motionTimeMs !== 0 || b.env.motionTimeMs !== 0) failures.push(`motion clock runs under reduced motion (${a.env.motionTimeMs} -> ${b.env.motionTimeMs})`);
      if (a.running || b.running) failures.push(`${Math.max(a.running, b.running)} running document animations`);
    } else if (d.changed < MIN_MOTION_PX) {
      failures.push(`only ${d.changed} px moved in 2.5 s of full motion (< ${MIN_MOTION_PX}): the static check proves nothing here`);
    }
    record({ arm, scene: id, weather: a.env.atmosphere?.weather?.type ?? null, px: d.changed, sky: d.sky, motionTimeMs: [a.env.motionTimeMs, b.env.motionTimeMs].map(Math.round), running: Math.max(a.running, b.running), failures }, [a, b]);
  }
}

// Two captures on one pose; DOM chrome of either frame excluded.
function compare(a, b, overlay = false) {
  return pixelDiff(a.png, b.png, { canvas: a.canvas, horizonY: a.horizonY, excluded: [...a.dom, ...b.dom] }, overlay);
}

function saveDiagnostics(out, tag, [a, b]) {
  writeFileSync(path.join(out, `${tag}-a.png`), PNG.sync.write(a.png));
  writeFileSync(path.join(out, `${tag}-b.png`), PNG.sync.write(b.png));
  writeFileSync(path.join(out, `${tag}-diff.png`), PNG.sync.write(compare(a, b, true).vis));
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(ROOT, options.out || path.join('output', 'v3-environment-truth', stamp));
  mkdirSync(out, { recursive: true });
  const server = await resolveServer(options.url);
  const browser = await chromium.launch({ headless: !options.headed, args: [...GPU_LAUNCH_ARGS] });
  const report = { tool: 'v3-environment-truth', startedAt: new Date().toISOString(), browserVersion: browser.version(), options, backends: {}, rows: [] };
  let failed = 0;
  let unavailable = 0;
  try {
    // One fresh page per session: each truth timeline, the static arm, the
    // motion arm.
    const sessions = [
      ...(options.arms.includes('truth') ? options.timelines.map(tl => ({ arm: 'truth', tl })) : []),
      ...['static', 'motion'].filter(arm => options.arms.includes(arm)).map(arm => ({ arm })),
    ];
    backends: for (const renderer of options.renderers) {
      for (const { arm, tl } of sessions) {
        const reduced = arm !== 'motion';
        let opened;
        try {
          opened = await openArm(browser, server.baseUrl, { renderer, reduced });
        } catch (error) {
          if (!(error instanceof BackendUnavailable)) throw error;
          unavailable++;
          report.backends[renderer] = { unavailable: error.message };
          console.log(`[v3-truth] ${renderer}: n/a (${error.message})`);
          continue backends;
        }
        const { context, page, errors, backend } = opened;
        report.backends[renderer] = backend;
        const record = (row, frames) => {
          row.renderer = renderer;
          report.rows.push(row);
          const label = row.state ? `${row.timeline} ${row.state}` : row.scene;
          if (row.failures.length) {
            failed++;
            saveDiagnostics(out, `${renderer}-${arm}-${label.replace(' ', '-')}`, frames);
            console.log(`[v3-truth] FAIL ${renderer} ${arm} ${label}: ${row.failures.join('; ')}`);
          } else {
            console.log(`[v3-truth] ok   ${renderer} ${arm} ${label}: ${row.px} px${row.state && row.state !== 'control' ? ` (sky ${row.sky}, env paths ${row.envPaths})` : ''}`);
          }
        };
        try {
          if (backend.motionScale !== (reduced ? 0 : 1)) {
            failed++;
            report.rows.push({ renderer, arm, failures: [`motionScale ${backend.motionScale}, expected ${reduced ? 0 : 1}`] });
            console.log(`[v3-truth] FAIL ${renderer} ${arm}: motionScale ${backend.motionScale}, expected ${reduced ? 0 : 1}`);
          } else if (arm === 'truth') await runTruth(page, tl, record, renderer);
          else await runScenes(page, options, record, { reduced });
        } finally {
          if (errors.length) report.rows.push({ renderer, arm, timeline: tl, pageErrors: [...new Set(errors)].slice(0, 5) });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  report.verdict = failed ? 'FAIL' : unavailable ? 'INCOMPLETE' : 'PASS';
  report.failures = failed;
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`[v3-truth] ${report.verdict}: ${report.rows.filter(r => r.failures).length} checks, ${failed} failed — report ${path.relative(ROOT, path.join(out, 'report.json'))}`);
  process.exit(failed ? 1 : unavailable ? 2 : 0);
}

main().catch((error) => {
  console.error(`[v3-truth] FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
