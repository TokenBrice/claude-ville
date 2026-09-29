#!/usr/bin/env node
// Wave 10 (10.1 Stage A) — the WebGPU parity gate (webgpu contract §5).
//
// One page, two backends, one frozen frame context: for each scenario case
// the app boots on an isolated server with the resident WebGL2 world, is
// pinned (Auto camera off, fixed hour and weather, scenario camera tile, tier
// zoom; DPR != 1 sizes as a flight frame), settles, and its loop is stopped.
// The last resident frame context (`renderer._gpuRenderContext`: records,
// camera, feed, particles, marks) is frozen — canvas record sources copied,
// the particle system cloned — and rendered by two fresh renderers built in
// the page at the app's backing size — `GpuWorldRenderer` on a WebGL2 canvas
// and `GpuWorldRendererWebGPU` on a WebGPU canvas — with the quality ladder
// forced to FULL, and both are read back through `debugCaptureTargets()`
// (scene, composite, emission; top-left rows, RGBA8). The WebGL2 reference is
// rendered twice around the WebGPU frame; a reference that is not self-stable
// fails the case.
//
// Metric (§5.2): per pixel d = max over RGBA of |webgl - webgpu| (8-bit), so a
// pixel is within 1 LSB only when every channel is. Reported per target:
// share(d <= 1), share(d == 0), maxAbsDiff, a histogram, the 100 worst pixels
// and the `rimTier` bucket (pixels a record samples from a source texel with
// 0 < a < 255, from the frame's own records, 1-px dilated). Pass: share(d<=1)
// >= 0.999 on the composite of every case; a failure whose > 1 LSB pixels all
// sit in rimTier is `P1-limited` (still a failure). A missing backend, method
// or target is `n/a`, never a crash. No shader-source assertions, no per-pass
// timing assertions, no tolerance flag.
//
// Also: the device-loss check (§5.4: `device.destroy()`, isActive() false
// within a frame, the app hands over to a fresh WebGL2 world, `deviceLost`
// carries a reason; on a harness-built renderer the frame after
// `_rebuildDevice()` matches the frame before), and `--burst`: the
// gpu-burst FULL comparison at 1680 and 4880 per backend with the host load
// recorded (a receipt only on a quiet host, load < 4).
//
// Exit: 0 every case measured and passing (and device loss passing when run),
// 1 any failure, 2 nothing failed but something was n/a (not a gate pass).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BENCH_WEATHER, GPU_LAUNCH_ARGS, resolveServer } from './support/world-bench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GPU_BURST = path.join(ROOT, 'scripts', 'world', 'gpu-burst.mjs');
const PASS_SHARE = 0.999;
const QUIET_LOAD = 4;
const FLIGHT_ZOOM = 1.37;
const TARGETS = ['composite', 'scene', 'emission'];

// §5.3 scenario matrix. `zoom` is a camera tier (Camera.tierZoom); the camera
// centres on the scenario's own `metadata.camera.centerTile`.
// Weather-transition frames (a clear -> rain crossfade, AuditWGPU #7): the
// motion audit's ramp at progress p, frozen at intermediate cloud cover so
// every cloud course (and the sea's sunlit course) has edges on screen.
const transitionWeather = p => Object.freeze({
  type: p < 0.5 ? 'clear' : 'rain', previousType: 'clear', nextType: 'rain', transitionProgress: p,
  intensity: 0.82 * p, precipitation: 0.9 * p, cloudCover: 0.08 + 0.84 * p, fog: 0.16 * p, windX: -0.4 * p,
});
const WEATHER = {
  ...BENCH_WEATHER,
  golden: BENCH_WEATHER.clear,
  'clear-rain-35': transitionWeather(0.35),
  'clear-rain-50': transitionWeather(0.5),
};
const PARITY_SCENARIOS = Object.freeze([
  { n: 1, id: 'readme-noon', scenario: 'readme-showcase', hour: 12, weather: 'clear', zoom: 2, why: 'reference daylight frame' },
  { n: 2, id: 'readme-night', scenario: 'readme-showcase', hour: 22, weather: 'clear', zoom: 3, why: 'full night composition' },
  { n: 3, id: 'midnight-oil', scenario: 'midnight-oil', hour: 22, weather: 'clear', zoom: 2, why: 'night emitters and windows' },
  { n: 4, id: 'storm-night', scenario: 'storm-night-reduced-motion', hour: 22, weather: 'storm', zoom: 2, reducedMotion: true, why: 'storm courses, water mood, static frame' },
  { n: 5, id: 'harbor-blue', scenario: 'git-harbor', hour: 19.75, weather: 'clear', zoom: 1, why: 'water, open-sea handover, ships' },
  { n: 6, id: 'dense-100-noon', scenario: 'dense-100-agents', hour: 12, weather: 'clear', zoom: 1, why: 'batch and page stress' },
  { n: 7, id: 'dense-100-night', scenario: 'dense-100-agents', hour: 22, weather: 'clear', zoom: 1, why: 'lights and clusters' },
  { n: 8, id: 'failed-push-golden', scenario: 'failed-push', hour: 18, weather: 'golden', zoom: 2, why: 'sun key, cast path, effects' },
  { n: 9, id: 'many-waiting-night', scenario: 'many-waiting', hour: 22, weather: 'clear', zoom: 2, why: 'attention lights and T1 marks' },
  { n: 10, id: 'release-morning', scenario: 'release-parade', hour: 9, weather: 'clear', zoom: 2, why: 'second daytime grade' },
  { n: 11, id: 'transition-partly', scenario: 'readme-showcase', hour: 14, weather: 'clear-rain-35', zoom: 1, why: 'clear -> rain at cover 0.37: cloud and sunlit course edges' },
  { n: 12, id: 'transition-mid', scenario: 'readme-showcase', hour: 14, weather: 'clear-rain-50', zoom: 1, why: 'clear -> rain at cover 0.50: rain-side courses mid-crossfade' },
]);

// Viewports whose World backing is the plan's gate sizes (1680x1032,
// 4880x1392) plus the XDR geometry (fractional k, fat pixels).
const DEFAULT_SIZES = '1920x1080,5120x1440,1512x982@2';

function usage() {
  console.log(`Usage: node scripts/smoke/webgpu-parity.mjs [options]

Options:
  --scenarios=<list>      Matrix numbers or ids (default: all ${PARITY_SCENARIOS.length}): ${PARITY_SCENARIOS.map(s => `${s.n}=${s.id}`).join(', ')}
  --sizes=<list>          Viewports WIDTHxHEIGHT[@DPR] (default: ${DEFAULT_SIZES})
  --case=<spec>           Ad-hoc case(s) scenario:hour:weather:zoom[:reduced], comma separated,
                          e.g. git-harbor:12:clear:1,git-harbor:15:storm:1 (replaces the matrix
                          unless --scenarios is also given); weather ${Object.keys(WEATHER).join('|')}
  --settle-seconds=<n>    Wait after posing before freezing (default: 4)
  --out=<dir>             Report directory (default: output/webgpu-parity/<timestamp>)
  --url=<url>             Existing ClaudeVille server (default: an isolated server)
  --no-device-loss        Skip the device-loss check
  --burst                 Also run gpu-burst FULL (level 0) per backend at 1680 and 4880
  --no-images             Skip the frame/diff PNGs
  --headed                Show the Chromium window
  --help                  Print this help

Writes <out>/report.json and per case <case>/{webgl,webgpu,diff-<target>}.png.
Exit 0 = every case measured and passing; 1 = a failure; 2 = no failure but n/a present.`);
}

function parseArgs(argv) {
  const options = {
    scenarios: null,
    cases: [],
    sizes: parseSizes(DEFAULT_SIZES),
    settleSeconds: 4,
    out: null,
    url: null,
    deviceLoss: true,
    burst: false,
    images: true,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') { usage(); process.exit(0); }
    if (arg === '--headed') { options.headed = true; continue; }
    if (arg === '--burst') { options.burst = true; continue; }
    if (arg === '--no-device-loss') { options.deviceLoss = false; continue; }
    if (arg === '--no-images') { options.images = false; continue; }
    const [flag, inline] = arg.split('=', 2);
    const value = inline ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--scenarios': options.scenarios = parseScenarios(value); break;
      case '--case': options.cases.push(...parseCases(value)); break;
      case '--sizes': options.sizes = parseSizes(value); break;
      case '--settle-seconds': options.settleSeconds = Number(value); break;
      case '--out': options.out = value; break;
      case '--url': options.url = value; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!(options.settleSeconds >= 0)) throw new Error('settle seconds must be zero or positive');
  options.scenarios = [...(options.scenarios || (options.cases.length ? [] : PARITY_SCENARIOS)), ...options.cases];
  return options;
}

function parseScenarios(value) {
  if (value === 'all') return PARITY_SCENARIOS;
  return String(value).split(',').map(item => item.trim()).filter(Boolean).map((item) => {
    const match = PARITY_SCENARIOS.find(s => String(s.n) === item || s.id === item);
    if (!match) throw new Error(`unknown scenario ${item}`);
    return match;
  });
}

function parseCases(value) {
  return String(value).split(',').map(item => item.trim()).filter(Boolean).map((item) => {
    const [scenario, hourText, weather = 'clear', zoomText = '1', reduced] = item.split(':');
    const hour = Number(hourText);
    const zoom = Number(zoomText);
    if (!scenario || !Number.isFinite(hour) || hour < 0 || hour >= 24) throw new Error(`case must be scenario:hour:weather:zoom, received ${item}`);
    if (!WEATHER[weather]) throw new Error(`case weather must be one of ${Object.keys(WEATHER).join(',')}: ${item}`);
    if (!(zoom > 0)) throw new Error(`case zoom must be a positive tier: ${item}`);
    return {
      n: `case:${item}`, id: `${scenario}-h${String(hour).replace('.', 'p')}-${weather}-z${zoom}${reduced ? '-reduced' : ''}`,
      scenario, hour, weather, zoom, reducedMotion: reduced === 'reduced', why: 'ad-hoc --case',
    };
  });
}

function parseSizes(value) {
  return String(value).split(',').map(item => item.trim()).filter(Boolean).map((item) => {
    const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(item);
    if (!match) throw new Error(`size must be WIDTHxHEIGHT[@DPR], received ${item}`);
    const dpr = Number(match[3] || 1);
    // Off DPR 1 the case is a flight frame (k = FLIGHT_ZOOM x dpr, fractional,
    // sub-pixel offset): the XDR geometry where the fat-pixel path samples.
    return { width: Number(match[1]), height: Number(match[2]), dpr, flight: dpr !== 1 ? FLIGHT_ZOOM : null, label: item };
  });
}

// ---------------------------------------------------------------------------
// In-page helpers (serialized into the page; no Node scope).
function installParityHelpers() {
  const GPU = '/src/presentation/character-mode/gpu/';
  const T = window.__webgpuParity = {};

  const toBase64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  // Premultiplied bytes shown over black (alpha forced opaque).
  T.png = async (rgba, width, height) => {
    const canvas = new OffscreenCanvas(width, height);
    const image = new ImageData(width, height);
    image.data.set(rgba);
    for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return toBase64(await canvas.convertToBlob({ type: 'image/png' }));
  };

  T.pose = async ({ scenario, hour, weather, zoom, flight }) => {
    const r = window.__claudeVilleApp.renderer;
    r._startLoop?.();
    // B.2 releases the terrain bake's CPU canvas once the app's own GPU world
    // holds it (a GPU-resident stand-in keys the record), which a fresh
    // renderer cannot sample: keep the canvas for this page (same pixels).
    if (typeof r.dropTerrainResident === 'function' && r.releaseTerrainCanvas !== null) {
      r.dropTerrainResident();
      r.releaseTerrainCanvas = null;
    }
    r.cameraDirector?.setAutoMode?.(false);
    const atmosphere = r.atmosphereState || window.__claudeVilleAtmosphere;
    atmosphere?.setTimelineMode?.('fixed');
    atmosphere?.setHour?.(hour);
    atmosphere?.setWeather?.(weather);
    const camera = r.camera;
    camera.abortDirectorGlide?.();
    camera.noteUserInput?.();
    const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
    const { getWorldScenario } = await import('/src/presentation/character-mode/__simfixture__/WorldScenarios.js');
    const meta = getWorldScenario(scenario);
    const tile = meta?.metadata?.camera?.centerTile || { tileX: 20, tileY: 20 };
    const point = tileToWorld({ tileX: tile.tileX, tileY: tile.tileY });
    r.setCameraPose({ x: point.x, y: point.y, zoom: camera.tierZoom(zoom) });
    if (flight) {
      // A flight frame (4.6): a fractional zoom and a sub-pixel offset, so
      // k = zoom x dpr is fractional and the fat-pixel path samples.
      const centre = camera.currentCenterWorld();
      camera.zoom = flight;
      camera.x = camera._viewportWidth() / (2 * camera.zoom) - centre.x + 0.37 / (camera.zoom * camera._dpr());
      camera.y = camera._viewportHeight() / (2 * camera.zoom) - centre.y + 0.21 / (camera.zoom * camera._dpr());
    }
    r.gpuWorld?.qualityLadder?.setOverride?.(0);
    return {
      scenarioResolved: meta?.id || null,
      gpuWorldActive: r.gpuWorld?.isActive?.() === true,
      mode: r.worldRendererMode,
      zoom: camera.zoom,
      dpr: window.devicePixelRatio,
      agents: r.agentSprites?.size ?? null,
    };
  };

  const freezeParticles = (system) => {
    const frozen = Object.create(Object.getPrototypeOf(system));
    Object.assign(frozen, system);
    frozen.particles = system.particles.map(particle => Object.assign(Object.create(Object.getPrototypeOf(particle)), particle));
    // Its own order scratch and comparator: the live one closes over the
    // live system's particle array.
    frozen._gpuOrder = [];
    frozen._compareGpuOrder = null;
    return frozen;
  };

  // Record sources that are canvases can be repainted after the loop stops
  // (an animated prop's frame canvas, a deferred compose), so one renderer
  // would upload a different frame than the other: every canvas source is
  // copied once at freeze (same size, identity drawImage) and the frozen
  // records point at the copies. Decoded images and bitmaps are immutable.
  const snapshotSources = (records) => {
    const copies = new Map();
    const snap = (source) => {
      if (!source || !(source instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas))) return source;
      if (copies.has(source)) return copies.get(source);
      let copy = source;
      if (source.width > 0 && source.height > 0) {
        copy = document.createElement('canvas');
        copy.width = source.width;
        copy.height = source.height;
        const g = copy.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(source, 0, 0);
      }
      copies.set(source, copy);
      return copy;
    };
    const frozen = records.map((record) => {
      const out = { ...record };
      for (const key of ['source', 'image', 'materialSource', 'sidecar', 'emissiveSource', 'occluderSource']) {
        if (record[key]) out[key] = snap(record[key]);
      }
      for (const key of ['textureUpdates', 'materialTextureUpdates', 'emissiveTextureUpdates', 'occluderTextureUpdates']) {
        if (Array.isArray(record[key])) out[key] = record[key].map(update => ({ ...update, source: snap(update.source) }));
      }
      return out;
    });
    return { records: frozen, copies: copies.size };
  };

  T.freeze = ({ flight } = {}) => {
    const r = window.__claudeVilleApp.renderer;
    r._stopLoop();
    if (flight) {
      r.camera.latchGpuFrame();
      r.camera._gpuLatch.subPixel = true;
    }
    const ctx = r._gpuRenderContext;
    if (!ctx?.records?.length) throw new Error('no resident frame context to freeze');
    const records = snapshotSources(ctx.records);
    const marks = ctx.marks ? snapshotSources(ctx.marks) : null;
    T.frame = {
      records: records.records,
      camera: ctx.camera,
      feed: ctx.feed,
      // A frozen copy of the live particle system: the app loop (restarted
      // for the device-loss fallback) must not move the frame's particles.
      particles: ctx.particles ? freezeParticles(ctx.particles) : null,
      marks: marks?.records || null,
      sceneCommands: ctx.sceneCommands,
    };
    T.sourceCopies = records.copies + (marks?.copies || 0);
    T.width = r.gpuWorld.width;
    T.height = r.gpuWorld.height;
    return { backing: [T.width, T.height], records: T.frame.records.length, marks: T.frame.marks?.length || 0, sourceCopies: T.sourceCopies };
  };

  const flipRows = (bytes, width, height) => {
    const row = width * 4;
    const out = new Uint8Array(bytes.length);
    for (let y = 0; y < height; y++) out.set(bytes.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out;
  };
  // Harness readback for a WebGL2 renderer that has no debugCaptureTargets():
  // the presented frame and the scene target's two attachments, flipped to
  // top-left rows. Called in the render's own task (the drawing buffer is not
  // preserved across tasks).
  const glReadback = (renderer) => {
    const gl = renderer.gl;
    const width = renderer.width;
    const height = renderer.height;
    const read = (framebuffer, buffer) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.readBuffer(buffer);
      const bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return gl.getError() === gl.NO_ERROR ? flipRows(bytes, width, height) : null;
    };
    const composite = read(null, gl.BACK);
    const target = renderer.sceneTarget;
    const scene = target?.framebuffer ? read(target.framebuffer, gl.COLOR_ATTACHMENT0) : null;
    const emission = target?.framebuffer && target.attachments >= 2 ? read(target.framebuffer, gl.COLOR_ATTACHMENT1) : null;
    if (target?.framebuffer) gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { composite, scene, emission, width, height, rowOrder: 'top-left', channelOrder: 'rgba', source: 'harness-readPixels' };
  };
  const normalizeCapture = (capture, source) => {
    if (!capture) return null;
    const out = { width: capture.width, height: capture.height, source: capture.source || source, rowOrder: capture.rowOrder, channelOrder: capture.channelOrder };
    for (const name of ['composite', 'scene', 'emission']) {
      const bytes = capture[name];
      out[name] = bytes && bytes.length === capture.width * capture.height * 4 ? new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length) : null;
      if (bytes && !out[name]) out[`${name}Error`] = `length ${bytes.length} != ${capture.width}x${capture.height}x4`;
    }
    if (out.rowOrder && out.rowOrder !== 'top-left') out.error = `rowOrder ${out.rowOrder}`;
    if (out.channelOrder && out.channelOrder !== 'rgba') out.error = `channelOrder ${out.channelOrder}`;
    return out;
  };

  // Render the frozen frame `passes` times and capture the last one inside
  // its own task (the WebGPU current texture expires with the task).
  T.renderCapture = async (renderer, backend, passes = 3) => {
    let ok = false;
    for (let i = 0; i < passes; i++) {
      renderer.prepareFrame?.(T.frame.feed);
      ok = renderer.render(T.frame) === true;
      if (i < passes - 1 && backend === 'webgpu') await renderer.drain?.();
    }
    let capture = null;
    let reason = null;
    if (typeof renderer.debugCaptureTargets === 'function') {
      capture = normalizeCapture(await renderer.debugCaptureTargets(), 'debugCaptureTargets');
      if (!capture) reason = 'debugCaptureTargets() returned nothing';
    } else if (backend === 'webgl') {
      capture = normalizeCapture(glReadback(renderer), 'harness-readPixels');
    } else {
      reason = 'renderer has no debugCaptureTargets()';
    }
    if (backend === 'webgpu') await renderer.drain?.();
    return { ok, capture, reason };
  };

  T.makeWebgl = async () => {
    const { GpuWorldRenderer } = await import(`${GPU}GpuWorldRenderer.js`);
    const canvas = document.createElement('canvas');
    canvas.width = T.width;
    canvas.height = T.height;
    const renderer = new GpuWorldRenderer(canvas, { enabled: true });
    renderer.resize(T.width, T.height);
    renderer.qualityLadder.setOverride(0);
    return renderer;
  };

  // Resolves { renderer } or { reason } (never throws): the skeleton may be
  // absent, unavailable or inactive.
  T.makeWebgpu = async () => {
    let module;
    try {
      module = await import(`${GPU}GpuWorldRendererWebGPU.js`);
    } catch (error) {
      return { reason: `GpuWorldRendererWebGPU.js not loadable: ${String(error?.message || error).slice(0, 160)}` };
    }
    if (typeof module.createGpuWorldRendererWebGPU !== 'function') return { reason: 'createGpuWorldRendererWebGPU not exported' };
    // The app's own path (IsometricRenderer.resolveBackend): a prepared
    // device + pipelines when the module offers it, else the bare probe.
    let probe = null;
    const prepare = module.prepareGpuWorldWebGPU || module.probeWebGpu;
    if (typeof prepare === 'function') {
      try { probe = await prepare(); } catch (error) { return { reason: `${prepare.name} threw: ${error?.message || error}` }; }
      if (!probe?.available) return { reason: `${prepare.name} unavailable: ${probe?.reason || 'no reason'}` };
    }
    const canvas = document.createElement('canvas');
    canvas.width = T.width;
    canvas.height = T.height;
    let renderer;
    try {
      renderer = module.createGpuWorldRendererWebGPU({ canvas, enabled: true, device: probe?.device, adapter: probe?.adapter, pipelines: probe?.pipelines });
      renderer = await renderer;
      if (renderer?.ready) await renderer.ready;
    } catch (error) {
      return { reason: `createGpuWorldRendererWebGPU threw: ${String(error?.message || error).slice(0, 160)}` };
    }
    if (!renderer) return { reason: 'createGpuWorldRendererWebGPU returned null' };
    renderer.resize?.(T.width, T.height);
    renderer.qualityLadder?.setOverride?.(0);
    if (renderer.isActive?.() === false) return { renderer, reason: 'renderer not active' };
    const info = probe?.adapter?.info;
    return { renderer, adapter: info ? { vendor: info.vendor, architecture: info.architecture, fallback: probe.isFallbackAdapter ?? info.isFallbackAdapter ?? null } : null };
  };

  // rimTier: backing pixels a frame record samples from a source texel with
  // 0 < a < 255 (nearest mapping of the record's rect onto its source rect,
  // reflect mirrored, screen-space rects passed through), dilated by 1 px.
  T.rimMask = async () => {
    const policy = await import(`${GPU}GpuWorldPolicy.js`);
    const { resolveCamera } = await import(`${GPU}GpuFrameState.js`);
    const F = policy.GPU_RECORD_FLAGS;
    const width = T.width;
    const height = T.height;
    const view = resolveCamera(T.frame.camera, 1);
    const raw = new Uint8Array(width * height);
    const sources = new Map();
    const alphaOf = (source, sw, sh) => {
      if (sources.has(source)) return sources.get(source);
      let entry = null;
      try {
        const canvas = new OffscreenCanvas(sw, sh);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(source, 0, 0);
        const data = g.getImageData(0, 0, sw, sh).data;
        const alpha = new Uint8Array(sw * sh);
        let translucent = false;
        for (let i = 0; i < alpha.length; i++) {
          const a = data[i * 4 + 3];
          alpha[i] = a;
          if (a > 0 && a < 255) translucent = true;
        }
        entry = translucent ? { alpha, width: sw, height: sh } : null;
      } catch {
        entry = null;
      }
      sources.set(source, entry);
      return entry;
    };
    const records = [...T.frame.records, ...(T.frame.marks || [])];
    let sampledRecords = 0;
    for (let i = 0; i < records.length; i++) {
      const n = policy.normalizeGpuRecord(records[i], i);
      if (!policy.validGpuRecord(n)) continue;
      const flags = n.flags | 0;
      if (flags & F.cueRun) continue;
      const src = alphaOf(n.source, n.sourceWidth, n.sourceHeight);
      if (!src) continue;
      sampledRecords++;
      const mirrored = (flags & F.reflect) !== 0;
      const wy0 = mirrored ? n.y + n.height : n.y;
      let x0; let x1; let y0; let y1;
      if (flags & F.screenSpace) {
        x0 = n.x; x1 = n.x + n.width; y0 = wy0; y1 = wy0 + n.height;
      } else {
        x0 = (n.x + view.xy[0]) * view.scale;
        x1 = (n.x + n.width + view.xy[0]) * view.scale;
        y0 = (wy0 + view.xy[1]) * view.scale;
        y1 = (wy0 + n.height + view.xy[1]) * view.scale;
      }
      const px0 = Math.max(0, Math.ceil(x0 - 0.5));
      const px1 = Math.min(width, Math.ceil(x1 - 0.5));
      const py0 = Math.max(0, Math.ceil(y0 - 0.5));
      const py1 = Math.min(height, Math.ceil(y1 - 0.5));
      if (px1 <= px0 || py1 <= py0) continue;
      const spanX = x1 - x0;
      const spanY = y1 - y0;
      for (let py = py0; py < py1; py++) {
        let v = (py + 0.5 - y0) / spanY;
        if (mirrored) v = 1 - v;
        const ty = Math.min(src.height - 1, Math.max(0, Math.floor(n.sy + v * n.sh)));
        const rowBase = ty * src.width;
        const outBase = py * width;
        for (let px = px0; px < px1; px++) {
          const tx = Math.min(src.width - 1, Math.max(0, Math.floor(n.sx + ((px + 0.5 - x0) / spanX) * n.sw)));
          const a = src.alpha[rowBase + tx];
          if (a > 0 && a < 255) raw[outBase + px] = 1;
        }
      }
    }
    const mask = new Uint8Array(width * height);
    let pixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < width && raw[yy * width + xx]) { hit = 1; break; }
          }
        }
        if (hit) { mask[y * width + x] = 1; pixels++; }
      }
    }
    T.rim = mask;
    return { pixels, share: pixels / (width * height), sampledRecords, translucentSources: [...sources.values()].filter(Boolean).length };
  };

  // §5.2 metric for one target, plus a diff image: d=0 dimmed reference luma,
  // d=1 blue, d 2-3 yellow, d>=4 red, rimTier pixels over 1 LSB magenta.
  // `image`: 'always', 'diff' (only when something differs) or false.
  T.compare = async (a, b, image) => {
    const width = T.width;
    const height = T.height;
    const count = width * height;
    const rim = T.rim;
    const histogram = new Array(256).fill(0);
    const pixelD = new Uint8Array(count);
    let channelLe1 = 0;
    for (let p = 0, i = 0; p < count; p++, i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) {
        const dc = Math.abs(a[i + c] - b[i + c]);
        if (dc <= 1) channelLe1++;
        if (dc > d) d = dc;
      }
      pixelD[p] = d;
      histogram[d]++;
    }
    let over = 0;
    let rimOver = 0;
    let rimPixels = 0;
    for (let p = 0; p < count; p++) {
      if (rim?.[p]) rimPixels++;
      if (pixelD[p] > 1) { over++; if (rim?.[p]) rimOver++; }
    }
    let maxAbsDiff = 0;
    for (let d = 255; d > 0; d--) if (histogram[d]) { maxAbsDiff = d; break; }
    // Worst 100: every pixel above the cut (fewer than 100), then pixels at
    // the cut in scan order until 100.
    let cut = maxAbsDiff;
    let above = 0;
    while (cut > 1 && above + histogram[cut] < 100) { above += histogram[cut]; cut--; }
    const worst = [];
    if (maxAbsDiff > 0) {
      let atCut = 0;
      for (let p = 0; p < count; p++) {
        const d = pixelD[p];
        if (d < cut || d === 0) continue;
        if (d === cut) { if (atCut >= 100 - above) continue; atCut++; }
        const i = p * 4;
        worst.push({ x: p % width, y: Math.floor(p / width), d, webgl: [a[i], a[i + 1], a[i + 2], a[i + 3]], webgpu: [b[i], b[i + 1], b[i + 2], b[i + 3]], rim: Boolean(rim?.[p]) });
      }
      worst.sort((l, r) => r.d - l.d || l.y - r.y || l.x - r.x);
    }
    const hist = {};
    histogram.forEach((n, d) => { if (n) hist[d] = n; });
    const shareLe1 = (histogram[0] + histogram[1]) / count;
    const result = {
      pixels: count,
      shareLe1,
      shareEq0: histogram[0] / count,
      channelShareLe1: channelLe1 / (count * 4),
      maxAbsDiff,
      histogram: hist,
      over1: over,
      rimTier: { pixels: rimPixels, share: rimPixels / count, over1: rimOver, nonRimOver1: over - rimOver },
      worst,
      pass: shareLe1 >= 0.999,
    };
    result.verdict = result.pass ? 'pass' : (over > 0 && rimOver === over ? 'P1-limited' : 'fail');
    if (image === 'always' || (image === 'diff' && maxAbsDiff > 0)) {
      const diff = new Uint8Array(count * 4);
      for (let p = 0, i = 0; p < count; p++, i += 4) {
        const d = pixelD[p];
        let r; let g; let bl;
        if (d === 0) { const l = (a[i] * 0.2126 + a[i + 1] * 0.7152 + a[i + 2] * 0.0722) * 0.3; r = g = bl = l; }
        else if (d > 1 && rim?.[p]) { r = 255; g = 0; bl = 255; }
        else if (d === 1) { r = 0; g = 90; bl = 255; }
        else if (d <= 3) { r = 255; g = 200; bl = 0; }
        else { r = 255; g = 0; bl = 0; }
        diff[i] = r; diff[i + 1] = g; diff[i + 2] = bl; diff[i + 3] = 255;
      }
      result.image = await T.png(diff, width, height);
    }
    return result;
  };

  // The whole case: WebGL2 A, WebGPU, WebGL2 B; compare A vs WebGPU per
  // target and A vs B as the reference's own stability control.
  T.runCase = async ({ images }) => {
    const out = { backing: [T.width, T.height], targets: {}, webgpu: {}, webgl: {} };
    out.rim = await T.rimMask();
    const gl = await T.makeWebgl();
    const a = await T.renderCapture(gl, 'webgl');
    out.webgl = { ok: a.ok, source: a.capture?.source || null, fat: gl.fatPixelsFrame ?? null, lightAdmission: gl.lightAdmission || null, markRecords: gl.markRecords ?? null };
    if (!a.ok) out.error = 'the WebGL2 reference render() returned false';
    const made = await T.makeWebgpu();
    let g = null;
    if (made.renderer && !made.reason) {
      try {
        g = await T.renderCapture(made.renderer, 'webgpu');
      } catch (error) {
        g = { ok: false, capture: null, reason: `render/capture threw: ${String(error?.message || error).slice(0, 200)}` };
      }
      const diag = made.renderer.getDiagnostics?.() || null;
      out.webgpu = {
        ok: g.ok, source: g.capture?.source || null, adapter: made.adapter || null, reason: g.reason || (g.ok ? null : 'render() returned false'),
        fat: made.renderer.fatPixelsFrame ?? null, lightAdmission: diag?.lightAdmission ?? made.renderer.lightAdmission ?? null,
        markRecords: made.renderer.markRecords ?? null,
      };
    } else {
      out.webgpu = { ok: false, reason: made.reason, adapter: made.adapter || null };
    }
    const b = await T.renderCapture(gl, 'webgl');
    const stable = a.capture?.composite && b.capture?.composite
      ? a.capture.composite.every((v, i) => v === b.capture.composite[i])
      : null;
    out.webglSelfStable = stable;
    // Replay fidelity: the app's own resident world on the same frozen
    // context. A fresh renderer that misses app-held state (a released
    // source, a resident-only texture) shows up here, not as parity.
    const appWorld = window.__claudeVilleApp.renderer.gpuWorld;
    if (appWorld?.gl && appWorld.width === T.width && appWorld.height === T.height && a.capture?.composite) {
      const app = await T.renderCapture(appWorld, 'webgl', 1);
      const ref = a.capture.composite;
      const got = app.capture?.composite;
      let diffPixels = 0;
      let maxAbsDiff = 0;
      if (got) {
        for (let i = 0; i < ref.length; i += 4) {
          let d = 0;
          for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ref[i + c] - got[i + c]));
          if (d) { diffPixels++; maxAbsDiff = Math.max(maxAbsDiff, d); }
        }
      }
      out.appReplay = got ? { diffPixels, share: diffPixels / (T.width * T.height), maxAbsDiff } : { status: 'n/a' };
    }
    out.sameLightAdmission = out.webgpu.lightAdmission && out.webgl.lightAdmission
      ? JSON.stringify(out.webgpu.lightAdmission) === JSON.stringify(out.webgl.lightAdmission) : null;
    out.sameMarkRecords = out.webgpu.ok ? out.webgpu.markRecords === out.webgl.markRecords : null;
    out.sameFatGate = out.webgpu.ok ? out.webgpu.fat === out.webgl.fat : null;
    for (const name of ['composite', 'scene', 'emission']) {
      const ref = a.capture?.[name];
      const test = g?.capture?.[name];
      if (!ref) { out.targets[name] = { status: 'n/a', reason: `webgl ${name} not captured` }; continue; }
      if (!test) {
        out.targets[name] = { status: 'n/a', reason: out.webgpu.reason || g?.capture?.[`${name}Error`] || `webgpu ${name} not captured` };
        continue;
      }
      if (!out.webgpu.ok) { out.targets[name] = { status: 'n/a', reason: out.webgpu.reason }; continue; }
      const metric = await T.compare(ref, test, images ? (name === 'composite' ? 'always' : 'diff') : false);
      out.targets[name] = { status: metric.verdict, ...metric };
    }
    if (images) {
      if (a.capture?.composite) out.webglImage = await T.png(a.capture.composite, T.width, T.height);
      if (g?.capture?.composite) out.webgpuImage = await T.png(g.capture.composite, T.width, T.height);
    }
    gl.dispose?.();
    made.renderer?.dispose?.();
    window.__claudeVilleApp.renderer._startLoop?.();
    return out;
  };

  // §5.4 device loss. With the app's own WebGPU world (booted with
  // ?renderer=webgpu): an explicit destroy() is unrecoverable, so the app
  // must see the world inactive within a frame, hold its last presented
  // frame meanwhile and hand over to a fresh WebGL2 world (fallbackOk). The
  // rebuild — `_rebuildDevice()` restores a frame equal to the one before —
  // runs on a harness-built WebGPU renderer, which no app replaces.
  T.deviceLoss = async () => {
    const app = window.__claudeVilleApp;
    const r = app.renderer;
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    // Detection bound after destroy(). The WebGL2 world then builds, re-bakes
    // the terrain and draws its swap frame in three idle tasks while the loop
    // holds the last frame (IsometricRenderer._stepFallbackPrep): each lets
    // one held frame through, so it takes over by the fourth frame after.
    const DEVICE_LOSS_MAX_FRAMES = 3;
    const FALLBACK_IDLE_STEPS = 3;
    const appWorld = r.gpuWorld?.backend === 'webgpu' && r.gpuWorld.device ? r.gpuWorld : null;
    const result = { appWorld: Boolean(appWorld), mode: r.worldRendererMode, fallbackOk: null };
    const awaitInactive = async (world) => {
      for (let frame = 1; frame <= 10; frame++) {
        await nextFrame();
        if (world.isActive() === false) return frame;
      }
      return null;
    };
    if (appWorld) {
      r._startLoop?.();
      const lost = appWorld.device.lost;
      appWorld.device.destroy();
      result.framesToInactive = await awaitInactive(appWorld);
      const info = await Promise.race([lost, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
      result.lostInfo = info ? { reason: info.reason, message: String(info.message || '').slice(0, 200) } : null;
      const diag = appWorld.getDiagnostics?.() || {};
      result.deviceLost = diag.deviceLost ?? null;
      result.failure = diag.failure ?? null;
      let framesToWebgl = null;
      for (let frame = 1; frame <= 30; frame++) {
        await nextFrame();
        if (r.worldRendererMode === 'webgl' && r.gpuWorld?.isActive?.() === true) { framesToWebgl = frame; break; }
      }
      const fx = document.getElementById('worldFxCanvas');
      const style = fx ? getComputedStyle(fx) : null;
      result.fallback = {
        mode: r.worldRendererMode,
        gpuActive: r.gpuWorld?.isActive?.() === true,
        framesToWebgl,
        fxCanvasVisible: style ? style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 : null,
        reason: r.worldBackendReason,
      };
      result.fallbackOk = result.fallback.mode === 'webgl' && result.fallback.gpuActive
        && framesToWebgl !== null && framesToWebgl <= DEVICE_LOSS_MAX_FRAMES + 1 + FALLBACK_IDLE_STEPS
        && result.fallback.fxCanvasVisible === true && /webgpu failed in frame: device/.test(result.fallback.reason || '');
      r._stopLoop();
    }
    const made = await T.makeWebgpu();
    if (!made.renderer || made.reason) {
      made.renderer?.dispose?.();
      if (appWorld) r._startLoop?.();
      return { ...result, status: 'n/a', reason: made.reason || 'no WebGPU renderer' };
    }
    const world = made.renderer;
    if (typeof world._rebuildDevice !== 'function' || !world.device) {
      world.dispose?.();
      if (appWorld) r._startLoop?.();
      return { ...result, status: 'n/a', reason: 'renderer has no device/_rebuildDevice()' };
    }
    world.qualityLadder?.setOverride?.(0);
    const before = await T.renderCapture(world, 'webgpu');
    if (!before.capture?.composite) {
      world.dispose?.();
      if (appWorld) r._startLoop?.();
      return { ...result, status: 'n/a', reason: before.reason || 'no composite before loss' };
    }
    const lost = world.device.lost;
    world.device.destroy();
    const standaloneFrames = await awaitInactive(world);
    if (!appWorld) result.framesToInactive = standaloneFrames;
    // `device.lost` resolves asynchronously after destroy(); no synchronous
    // signal exists (getCurrentTexture/submit/createBuffer all succeed on a
    // destroyed device), so detection lands 1-3 rAFs later on a loaded host.
    // The canvas holds the last good frame meanwhile (audit8/ReAuditP4:
    // 0 dark frames over ~440 screencast frames), so the gate is time-bounded.
    result.inactiveInTime = result.framesToInactive !== null && result.framesToInactive <= DEVICE_LOSS_MAX_FRAMES;
    const info = await Promise.race([lost, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
    if (!appWorld) result.lostInfo = info ? { reason: info.reason, message: String(info.message || '').slice(0, 200) } : null;
    const diag = world.getDiagnostics?.() || {};
    if (!appWorld) result.deviceLost = diag.deviceLost ?? null;
    result.deviceLostReason = Boolean(result.deviceLost && (result.deviceLost.reason || typeof result.deviceLost === 'string'));
    let rebuilt = false;
    try { rebuilt = (await world._rebuildDevice()) !== false; } catch (error) { result.rebuildError = String(error?.message || error).slice(0, 200); }
    result.rebuilt = rebuilt && world.isActive() === true;
    if (result.rebuilt) {
      world.qualityLadder?.setOverride?.(0);
      const after = await T.renderCapture(world, 'webgpu');
      if (after.capture?.composite) {
        T.rim = null;
        const metric = await T.compare(before.capture.composite, after.capture.composite, false);
        delete metric.worst;
        result.afterRebuild = metric;
      } else {
        result.afterRebuild = { status: 'n/a', reason: after.reason };
      }
    }
    const checks = [result.inactiveInTime, result.deviceLostReason, result.rebuilt, result.afterRebuild?.pass === true];
    if (result.fallbackOk !== null) checks.push(result.fallbackOk);
    result.status = checks.every(Boolean) ? 'pass' : 'fail';
    world.dispose?.();
    if (appWorld) r._startLoop?.();
    return result;
  };
}

// ---------------------------------------------------------------------------
async function openCase(browser, baseUrl, { size, scenario, reducedMotion, renderer }) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.message || error).slice(0, 300)));
  page.on('console', (message) => {
    const text = message.text();
    // A backend's own render-failure warning names the cause of an n/a.
    if (message.type() === 'warning' && /\[GpuWorldRenderer/.test(text)) { errors.push(text.slice(0, 300)); return; }
    if (message.type() !== 'error') return;
    // A missing module is reported as n/a with its reason instead.
    if (/Failed to load resource/.test(text)) return;
    errors.push(text.slice(0, 300));
  });
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('sim', '1');
  url.searchParams.set('scenario', scenario);
  url.searchParams.set('renderer', renderer);
  await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => {
    const app = window.__claudeVilleApp;
    return app?._bootState === 'ready' && Boolean(app?.renderer?.camera);
  }, null, { timeout: 60_000 });
  await page.evaluate(`(${installParityHelpers.toString()})()`);
  return { context, page, errors };
}

async function poseAndFreeze(page, item, size, settleSeconds) {
  // The opening glide owns the camera for its first seconds. A scenario that
  // selects an agent opens its panel, which narrows the World: close it so the
  // backing is the gate size.
  await page.waitForTimeout(4500);
  await page.keyboard.press('Escape');
  const args = { scenario: item.scenario, hour: item.hour, weather: WEATHER[item.weather], zoom: item.zoom, flight: size.flight };
  const pose = await page.evaluate(a => window.__webgpuParity.pose(a), args);
  await page.waitForTimeout(settleSeconds * 1000);
  await page.evaluate(a => window.__webgpuParity.pose(a), args);
  await page.waitForFunction(() => Boolean(window.__claudeVilleApp?.renderer?._gpuRenderContext?.records?.length), null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const frozen = await page.evaluate(a => window.__webgpuParity.freeze(a), { flight: size.flight });
  return { pose, frozen };
}

function writePng(file, base64) {
  if (base64) writeFileSync(file, Buffer.from(base64, 'base64'));
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(3)}%` : 'n/a';
}

function targetCell(target) {
  if (!target || target.status === 'n/a') return 'n/a';
  return `${pct(target.shareLe1)} max ${target.maxAbsDiff} ${target.status}`;
}

function caseVerdict(row) {
  if (row.error) return 'fail';
  if (row.webglSelfStable === false) return 'fail';
  const composite = row.targets?.composite;
  if (!composite || composite.status === 'n/a') return 'n/a';
  return composite.status;
}

async function runDeviceLoss(browser, baseUrl, size, settleSeconds) {
  const item = PARITY_SCENARIOS[0];
  const { context, page, errors } = await openCase(browser, baseUrl, { size, scenario: item.scenario, reducedMotion: false, renderer: 'webgpu' });
  try {
    const { pose, frozen } = await poseAndFreeze(page, item, size, settleSeconds);
    const result = await page.evaluate(() => window.__webgpuParity.deviceLoss());
    return { scenario: item.id, size: size.label, pose, backing: frozen.backing, ...result, errors: errors.slice(0, 5) };
  } finally {
    await context.close();
  }
}

// gpu-burst FULL per backend. The tool needs `--renderer` to boot WebGPU; a
// tool without it records the WebGPU arm as n/a.
function runBurst(outDir) {
  const help = spawnSync(process.execPath, [GPU_BURST, '--help'], { encoding: 'utf8' }).stdout || '';
  const supportsRenderer = /--renderer/.test(help);
  const arms = {};
  for (const backend of ['webgl', 'webgpu']) {
    if (backend === 'webgpu' && !supportsRenderer) {
      arms[backend] = { status: 'n/a', reason: 'gpu-burst.mjs has no --renderer option' };
      continue;
    }
    const out = path.join(outDir, `burst-${backend}.json`);
    const args = [GPU_BURST, '--levels=0', '--viewport=1920x1080,5120x1440', '--zoom=1', '--contexts=3', `--out=${out}`];
    if (supportsRenderer) args.push(`--renderer=${backend}`);
    const loadStart = os.loadavg();
    console.log(`[webgpu-parity] gpu-burst ${backend} ...`);
    const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const loadEnd = os.loadavg();
    if (run.status !== 0 || !existsSync(out)) {
      arms[backend] = { status: 'error', exit: run.status, stderr: String(run.stderr || '').slice(-800), loadAverage: { start: loadStart, end: loadEnd } };
      continue;
    }
    const report = JSON.parse(readFileSync(out, 'utf8'));
    arms[backend] = {
      status: 'ran',
      loadAverage: { start: loadStart, end: loadEnd },
      cases: report.summary.cases.map(c => ({ viewport: c.viewport, zoom: c.zoom, level: c.level, wallMs: c.wallMs, wallSpreadMs: c.wallSpreadMs, cpuMs: c.cpuMs, contexts: c.contexts })),
      backings: [...new Set(report.runs.map(r => (r.backing || []).join('x')))],
      backends: [...new Set(report.runs.map(r => r.backend || null))],
    };
  }
  const comparison = [];
  if (arms.webgl?.status === 'ran' && arms.webgpu?.status === 'ran') {
    for (const c of arms.webgl.cases) {
      const other = arms.webgpu.cases.find(o => o.viewport === c.viewport && o.zoom === c.zoom && o.level === c.level);
      if (!other) continue;
      comparison.push({ viewport: c.viewport, webglMs: c.wallMs, webgpuMs: other.wallMs, webgpuNotSlower: other.wallMs <= c.wallMs });
    }
  }
  const loads = Object.values(arms).flatMap(a => (a.loadAverage ? [a.loadAverage.start[0], a.loadAverage.end[0]] : []));
  const quiet = loads.length > 0 && Math.max(...loads) < QUIET_LOAD;
  return { arms, comparison, quietHost: quiet, receipt: quiet ? 'quiet host (load < 4): a receipt' : 'not a receipt (host load >= 4 or unmeasured)' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(ROOT, options.out || path.join('output', 'webgpu-parity', stamp));
  mkdirSync(outDir, { recursive: true });
  const server = await resolveServer(options.url);
  const browser = await chromium.launch({ headless: !options.headed, args: [...GPU_LAUNCH_ARGS] });
  const report = {
    tool: 'webgpu-parity',
    contract: 'webgpu contract §5 (10.1 Stage A gate)',
    startedAt: new Date().toISOString(),
    browserVersion: browser.version(),
    host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model || null, loadAverageStart: os.loadavg() },
    passShare: PASS_SHARE,
    options: { ...options, scenarios: options.scenarios.map(s => s.id), sizes: options.sizes.map(s => s.label) },
    cases: [],
    deviceLoss: null,
    burst: null,
  };
  try {
    for (const size of options.sizes) {
      for (const item of options.scenarios) {
        const name = `${item.id}-${size.label.replace('@', 'dpr')}`;
        const row = { case: name, n: item.n, scenario: item.scenario, size: size.label, hour: item.hour, weather: item.weather, zoom: item.zoom };
        const { context, page, errors } = await openCase(browser, server.baseUrl, { size, scenario: item.scenario, reducedMotion: item.reducedMotion, renderer: 'webgl' });
        try {
          const { pose, frozen } = await poseAndFreeze(page, item, size, options.settleSeconds);
          Object.assign(row, { pose, ...frozen });
          if (pose.scenarioResolved !== item.scenario) throw new Error(`scenario ${item.scenario} resolved to ${pose.scenarioResolved}`);
          if (!pose.gpuWorldActive) throw new Error('the resident WebGL2 world is not active');
          const result = await page.evaluate(a => window.__webgpuParity.runCase(a), { images: options.images });
          const caseDir = path.join(outDir, name);
          if (options.images) {
            mkdirSync(caseDir, { recursive: true });
            writePng(path.join(caseDir, 'webgl.png'), result.webglImage);
            writePng(path.join(caseDir, 'webgpu.png'), result.webgpuImage);
            for (const target of TARGETS) {
              const t = result.targets[target];
              if (t?.image) { writePng(path.join(caseDir, `diff-${target}.png`), t.image); t.image = path.relative(outDir, path.join(caseDir, `diff-${target}.png`)); }
            }
          }
          delete result.webglImage;
          delete result.webgpuImage;
          Object.assign(row, result);
        } catch (error) {
          row.error = String(error?.message || error).slice(0, 400);
        } finally {
          row.pageErrors = [...new Set(errors)].slice(0, 5);
          await context.close();
        }
        row.verdict = caseVerdict(row);
        report.cases.push(row);
        const c = row.targets?.composite;
        console.log(`[webgpu-parity] ${name}: ${row.verdict}${row.error ? ` (${row.error})` : ''}${c?.status === 'n/a' ? ` (${c.reason})` : ''}`);
      }
    }
    if (options.deviceLoss) {
      try {
        report.deviceLoss = await runDeviceLoss(browser, server.baseUrl, options.sizes[0], options.settleSeconds);
      } catch (error) {
        report.deviceLoss = { status: 'fail', error: String(error?.message || error).slice(0, 400) };
      }
      console.log(`[webgpu-parity] device loss: ${report.deviceLoss.status}${report.deviceLoss.reason ? ` (${report.deviceLoss.reason})` : ''}`);
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  if (options.burst) report.burst = runBurst(outDir);
  report.host.loadAverageEnd = os.loadavg();

  const verdicts = report.cases.map(row => row.verdict);
  if (report.deviceLoss) verdicts.push(report.deviceLoss.status);
  const failed = verdicts.some(v => v === 'fail' || v === 'P1-limited');
  const incomplete = verdicts.some(v => v === 'n/a');
  report.verdict = failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS';
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));

  const table = report.cases.map(row => ({
    case: row.case,
    backing: row.backing ? row.backing.join('x') : '-',
    records: row.records ?? '-',
    marks: row.marks ?? '-',
    fat: row.webgl?.fat ?? '-',
    composite: targetCell(row.targets?.composite),
    scene: targetCell(row.targets?.scene),
    emission: targetCell(row.targets?.emission),
    rim: row.rim ? pct(row.rim.share) : '-',
    'rim>1': row.targets?.composite?.rimTier ? `${row.targets.composite.rimTier.over1}/${row.targets.composite.over1}` : '-',
    glStable: row.webglSelfStable ?? '-',
    appReplay: row.appReplay?.diffPixels ?? '-',
    verdict: row.verdict,
  }));
  console.table(table);
  if (report.deviceLoss) console.log('device loss:', JSON.stringify({ status: report.deviceLoss.status, reason: report.deviceLoss.reason, framesToInactive: report.deviceLoss.framesToInactive, inactiveInTime: report.deviceLoss.inactiveInTime, fallbackOk: report.deviceLoss.fallbackOk, rebuilt: report.deviceLoss.rebuilt, afterRebuild: report.deviceLoss.afterRebuild?.shareLe1 }));
  if (report.burst) console.log('gpu-burst:', JSON.stringify({ comparison: report.burst.comparison, receipt: report.burst.receipt, webgpu: report.burst.arms.webgpu?.status }));
  console.log(`[webgpu-parity] ${report.verdict} — report ${path.relative(ROOT, path.join(outDir, 'report.json'))}`);
  process.exit(failed ? 1 : incomplete ? 2 : 0);
}

main().catch((error) => {
  console.error(`[webgpu-parity] FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
