#!/usr/bin/env node
// XP-5 — the postcard readback smoke. For each backend (WebGPU, the
// default on a hardware adapter; WebGL2 via `renderer=webgl`; Canvas via
// `renderer=canvas`) and each scenario, boots the app on an isolated server
// (never port 4000), poses the World, holds READ (every work label up) and
// selects a villager (its T2 plate up), then strikes a postcard in the page
// without saving and checks:
//   - text: the postcard frame's text guard dropped 0 calls (every text class
//     stood down on its own flag; `--trace` lists the sites that did not);
//   - readback: the composite is the backing size plus the caption band, and
//     its world area is a real frame (opaque, many distinct colours), which
//     proves WebGL2 and WebGPU read back inside the frame (headless
//     screenshots of WebGPU are blank, this readback is not);
//   - the live frame is restored (labels present again after the strike).
// `--save` also strikes one real `a[download]` postcard and writes the
// day, dusk-rain and night samples to output/council-postcards/.
//
// Usage: node scripts/smoke/postcard.mjs [--backends=webgpu,webgl,canvas]
//          [--scenarios=a,b] [--size=1440x900] [--dpr=1] [--trace] [--save]
// Exit: 0 every case passed; 1 any failure; 2 a requested backend was absent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_WEATHER, launchBenchBrowser, openWorld, parseViewport, poseWorld, resolveServer } from './support/world-bench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'output', 'council-postcards');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const BACKENDS = (args.backends || 'webgpu,webgl,canvas').split(',');
const SCENARIOS = (args.scenarios || [
  'readme-showcase', 'waiting-on-user', 'git-harbor', 'taskboard-live', 'council-fleet',
  'team-gather', 'release-parade', 'building-inspection-replay', 'stale-cargo', 'squad-distress',
].join(',')).split(',');
const { width, height } = parseViewport(args.size || '1440x900');
const dpr = Number(args.dpr || 1);
const QUERY = { webgpu: {}, webgl: { renderer: 'webgl' }, canvas: { renderer: 'canvas' } };
const MIN_DISTINCT = 400;

async function strike(page, { trace, sample = false }) {
  return page.evaluate(async ({ trace, sample }) => {
    const renderer = window.__claudeVilleApp.renderer;
    // Cached text (the T2/T4 name stamps, the taskboard's chalk raster)
    // reaches the frame through drawImage, out of the text guard's reach:
    // count each cached-text blit the postcard frame asks for.
    const base = '/src/presentation/character-mode/';
    const [{ postcardFrame }, { AgentSprite }, { BuildingSprite }] = await Promise.all([
      import(base + 'Postcard.js'), import(base + 'AgentSprite.js'), import(base + 'BuildingSprite.js'),
    ]);
    const cachedText = [];
    const stamp = AgentSprite.prototype._drawOverlayStamp;
    const slate = BuildingSprite.prototype._drawOnTaskboardSlate;
    AgentSprite.prototype._drawOverlayStamp = function (ctx, identity, ...rest) {
      if (postcardFrame() && /^(plate|name)\|/.test(String(identity))) cachedText.push(String(identity).split('|')[0]);
      return stamp.call(this, ctx, identity, ...rest);
    };
    BuildingSprite.prototype._drawOnTaskboardSlate = function (ctx, localPoint, signature, ...rest) {
      if (postcardFrame() && !/\|postcard$|^empty-rack$/.test(String(signature))) cachedText.push(`slate:${String(signature).split('|')[0]}`);
      return slate.call(this, ctx, localPoint, signature, ...rest);
    };
    // An independent readback of the postcard frame, taken the moment it is
    // drawn (same task), by other means than Postcard.js: WebGL2 readPixels
    // of the GPU drawing buffer, WebGPU its own copy of the presented
    // texture, Canvas the world canvas's pixels; plus the overlay's alpha
    // and where the T1 beacons and plates stand.
    const renderNow = renderer.renderNow;
    let independent = null;
    renderer.renderNow = function (...a) {
      const drawn = renderNow.apply(this, a);
      if (drawn && independent && !postcardFrame() && !independent.liveOverlay) {
        independent.liveOverlay = renderer.overlayCanvas.getContext('2d').getImageData(0, 0, independent.w, independent.h).data;
        independent.liveMarks = renderer._gpuRenderContext?.marks?.length ?? null;
      }
      if (drawn && postcardFrame() && !independent) {
        const w = renderer.canvas.width;
        const h = renderer.canvas.height;
        // The presented GPU layer: the resident world, or Canvas's PostFx pass.
        const fxShown = renderer.fxCanvas?.style?.display !== 'none';
        const gpu = renderer.gpuWorld?.isActive?.() ? renderer.gpuWorld : fxShown ? renderer.postFx : null;
        const overlay = renderer.overlayCanvas.getContext('2d').getImageData(0, 0, w, h).data;
        let layer = null;
        if (gpu?.gl) {
          const gl = gpu.gl;
          const px = new Uint8Array(w * h * 4);
          const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
          layer = { kind: 'webgl-readPixels', rows: 'bottom-up', px };
        } else if (gpu?.debugCaptureTargets && gpu === renderer.gpuWorld) {
          layer = { kind: 'webgpu-copy', rows: 'top-down', pending: gpu.debugCaptureTargets() };
        } else {
          layer = { kind: 'canvas-getImageData', rows: 'top-down', px: renderer.canvas.getContext('2d').getImageData(0, 0, w, h).data };
        }
        const layout = renderer._attentionLayout || {};
        independent = {
          w, h, overlay, layer,
          beacons: (layout.beacons || []).map(b => ({ left: b.left, top: b.top, right: b.right ?? b.left + 8, bottom: b.bottom })),
          plates: (layout.plates || []).map(p => ({ ...p.rect })),
          marks: renderer._gpuRenderContext?.marks?.length ?? null,
        };
      }
      return drawn;
    };
    let result;
    try {
      result = await renderer.strikePostcard({ save: false, trace });
    } finally {
      renderer.renderNow = renderNow;
      AgentSprite.prototype._drawOverlayStamp = stamp;
      BuildingSprite.prototype._drawOnTaskboardSlate = slate;
    }
    if (!result.ok) return { ok: false, reason: result.reason, textCalls: result.textCalls };
    const canvas = result.canvas;
    const world = renderer.canvas;
    // The exported PNG, decoded.
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const bitmap = await createImageBitmap(blob);
    const decoded = document.createElement('canvas');
    decoded.width = bitmap.width;
    decoded.height = bitmap.height;
    const ctx = decoded.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, world.width, world.height).data;
    // Island pixels: opaque in the independent layer readback and clear of
    // the overlay. Each must match the PNG (a blank GPU layer would leave
    // the backdrop there instead).
    let island = 0;
    let islandMatch = 0;
    let layerKind = null;
    let beaconInk = null;
    let plateInk = null;
    if (independent) {
      const { w, h, overlay, layer } = independent;
      layerKind = layer.kind;
      let px = layer.px;
      if (layer.pending) {
        const targets = await layer.pending;
        px = targets?.composite instanceof Uint8Array ? targets.composite : null;
      }
      if (px) {
        for (let y = 0; y < h; y += 5) {
          for (let x = 0; x < w; x += 5) {
            const o = (y * w + x) * 4;
            if (overlay[o + 3] !== 0) continue;
            const ly = layer.rows === 'bottom-up' ? h - 1 - y : y;
            const l = (ly * w + x) * 4;
            if (px[l + 3] !== 255) continue;
            island += 1;
            if (Math.abs(px[l] - data[o]) <= 3 && Math.abs(px[l + 1] - data[o + 1]) <= 3 && Math.abs(px[l + 2] - data[o + 2]) <= 3) islandMatch += 1;
          }
        }
      }
      // T1: beacons stay (overlay pixels on Canvas and WebGL2's overlay
      // path, GPU mark records on the resident path); plates leave no ink.
      const inkIn = (rect, skip = null, overlay = independent.overlay) => {
        let ink = 0;
        for (let y = Math.max(0, Math.floor(rect.top)); y < Math.min(h, Math.ceil(rect.bottom)); y++) {
          for (let x = Math.max(0, Math.floor(rect.left)); x < Math.min(w, Math.ceil(rect.right)); x++) {
            if (skip?.some(b => x >= b.left - 2 && x < b.right + 2 && y >= b.top - 2 && y < b.bottom + 2)) continue;
            if (overlay[(y * w + x) * 4 + 3]) ink += 1;
          }
        }
        return ink;
      };
      beaconInk = independent.beacons.length ? independent.beacons.reduce((sum, rect) => sum + inkIn(rect), 0) + (independent.marks || 0) : null;
      // Plates. On the resident GPU path they are mark records: the postcard
      // frame carries fewer than the live one (its beacons only). On the
      // overlay the postcard leaves at most a fifth of the live frame's ink
      // in the plate rects (other marks may lie under a plate's footprint).
      if (independent.plates.length && independent.liveMarks > 0) {
        plateInk = { postcardMarks: independent.marks || 0, liveMarks: independent.liveMarks };
      } else if (independent.plates.length && independent.liveOverlay) {
        const postcardInk = independent.plates.reduce((sum, rect) => sum + inkIn(rect, independent.beacons), 0);
        const liveInk = independent.plates.reduce((sum, rect) => sum + inkIn(rect, independent.beacons, independent.liveOverlay), 0);
        plateInk = { postcardInk, liveInk };
      }
    }
    const colours = new Set();
    let transparent = 0;
    const step = 7;
    let samples = 0;
    for (let y = 0; y < world.height; y += step) {
      for (let x = 0; x < world.width; x += step) {
        const i = (y * world.width + x) * 4;
        samples += 1;
        if (data[i + 3] < 250) transparent += 1;
        colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    }
    // The live frame is back: the overlay carries labels again.
    let liveTextCalls = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    proto.fillText = function (...a) { liveTextCalls += 1; return original.apply(this, a); };
    AgentSprite.prototype._drawOverlayStamp = function (ctx, identity, ...rest) {
      if (/^(plate|name)\|/.test(String(identity))) liveTextCalls += 1;
      return stamp.call(this, ctx, identity, ...rest);
    };
    try { renderer.renderNow(); } finally {
      proto.fillText = original;
      AgentSprite.prototype._drawOverlayStamp = stamp;
    }
    return {
      ok: true,
      backend: renderer.worldRendererMode ?? null,
      gpuActive: renderer.gpuWorld?.isActive?.() === true,
      gpuKind: renderer.gpuWorld?.constructor?.name || null,
      size: [canvas.width, canvas.height],
      backing: [world.width, world.height],
      caption: result.caption,
      textCalls: result.textCalls,
      cachedText: [...new Set(cachedText)],
      textSites: result.textSites ? [...new Set(result.textSites)].slice(0, 40) : null,
      distinct: colours.size,
      layerKind,
      island,
      islandShare: island ? islandMatch / island : 0,
      beacons: independent?.beacons.length || 0,
      beaconInk,
      plateInk,
      transparentShare: transparent / samples,
      liveTextCalls,
      png: sample ? canvas.toDataURL('image/png') : null,
    };
  }, { trace, sample });
}

async function prepare(page, backend, pose) {
  // The World mounts WebGL2 and moves to WebGPU once it has compiled.
  if (backend === 'webgpu') {
    await page.waitForFunction(() => /WebGPU/.test(window.__claudeVilleApp.renderer.gpuWorld?.constructor?.name || ''), null, { timeout: 30_000 }).catch(() => {});
  }
  const posed = await poseWorld(page, pose);
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const renderer = window.__claudeVilleApp.renderer;
    const first = [...(renderer.agentSprites?.values?.() || [])][0];
    if (first) renderer.selectAgentById(first.agent.id);
    renderer.setReadMode(true);
  });
  await page.waitForTimeout(600);
  return posed;
}

const server = await resolveServer(args.url);
const browser = await launchBenchBrowser();
const failures = [];
let absent = false;
const rows = [];
try {
  for (const backend of BACKENDS) {
    for (const scenario of SCENARIOS) {
      const { context, page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario, width, height, dpr, query: QUERY[backend] });
      try {
        await prepare(page, backend, { hour: 16, weather: 'clear', zoom: 2, tile: [20, 21] });
        const got = await strike(page, { trace: args.trace === 'true' });
        const kind = got.gpuKind || '';
        const onBackend = backend === 'canvas' ? !got.gpuActive
          : backend === 'webgpu' ? got.gpuActive && /WebGPU/.test(kind)
            : got.gpuActive && !/WebGPU/.test(kind);
        const row = { backend, scenario, ...got, png: undefined };
        rows.push(row);
        const problems = [];
        if (!got.ok) problems.push(`strike failed: ${got.reason}`);
        else {
          if (!onBackend) { absent = true; problems.push(`not on ${backend} (${kind || 'canvas'})`); }
          if (got.cachedText.length) problems.push(`cached text blitted: ${got.cachedText.join(', ')}`);
          if (got.textCalls !== 0) problems.push(`${got.textCalls} text call(s) reached the postcard frame${got.textSites ? `: ${got.textSites.join(' | ')}` : ''}`);
          if (got.size[0] !== got.backing[0] || got.size[1] <= got.backing[1]) problems.push(`size ${got.size} for backing ${got.backing}`);
          if (got.distinct < MIN_DISTINCT) problems.push(`blank readback: ${got.distinct} distinct colours`);
          if (got.transparentShare > 0.01) problems.push(`transparent readback: ${(got.transparentShare * 100).toFixed(1)}%`);
          if (got.island < 2000) problems.push(`independent readback (${got.layerKind}) found only ${got.island} island samples`);
          else if (got.islandShare < 0.99) problems.push(`PNG matches the independent ${got.layerKind} readback on ${(got.islandShare * 100).toFixed(1)}% of island samples`);
          if (got.beacons && !(got.beaconInk > 0)) problems.push('T1 beacons left no mark');
          if (got.plateInk?.liveMarks && !(got.plateInk.postcardMarks < got.plateInk.liveMarks)) problems.push(`T1 mark records: ${got.plateInk.postcardMarks} on the postcard, ${got.plateInk.liveMarks} live`);
          if (got.plateInk?.liveInk !== undefined && !(got.plateInk.postcardInk <= got.plateInk.liveInk * 0.2)) problems.push(`T1 plate rects keep ${got.plateInk.postcardInk} of the live frame's ${got.plateInk.liveInk} overlay pixels`);
          if (!(got.liveTextCalls > 0)) problems.push('live frame drew no text after the strike');
        }
        if (errors.length) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
        const status = problems.length ? 'FAIL' : 'ok';
        if (problems.length) failures.push({ backend, scenario, problems });
        console.log(`${status} ${backend} ${scenario} distinct=${got.distinct} text=${got.textCalls} island=${got.island}@${((got.islandShare || 0) * 100).toFixed(1)}% beacons=${got.beacons} ${problems.join('; ')}`);
      } finally {
        await context.close();
      }
    }
  }
  if (args.save === 'true') {
    fs.mkdirSync(OUT, { recursive: true });
    const samples = [
      { name: 'day', hour: 13, weather: 'clear' },
      { name: 'dusk-rain', hour: 16.4, weather: 'rain' },
      { name: 'night', hour: 23, weather: 'clear' },
      { name: 'beacon', hour: 15, weather: 'clear', scenario: 'waiting-on-user', zoom: 2, attention: true },
    ];
    for (const sample of samples) {
      const { context, page } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: sample.scenario || 'readme-showcase', width, height, dpr, query: QUERY.webgl });
      try {
        await poseWorld(page, { hour: sample.hour, weather: sample.weather, zoom: sample.zoom || 1, tile: [20, 22] });
        if (sample.attention) {
          // Centre the camera on the first villager whose T1 beacon is up.
          await page.evaluate(async () => {
            const { isAttentionStatus } = await import('/src/presentation/character-mode/AttentionPlates.js');
            const renderer = window.__claudeVilleApp.renderer;
            const sprite = [...renderer.agentSprites.values()].find(s => isAttentionStatus(s.agent?.status));
            if (sprite) renderer.setCameraPose({ x: sprite.x, y: sprite.y - 30, zoom: renderer.camera.zoom });
          });
        }
        await page.waitForTimeout(3000);
        const got = await strike(page, { trace: false, sample: true });
        if (got.png) fs.writeFileSync(path.join(OUT, `postcard-${sample.name}.png`), Buffer.from(got.png.split(',')[1], 'base64'));
        console.log(`sample ${sample.name}: ${got.caption}`);
      } finally {
        await context.close();
      }
    }
    // One real save through a[download].
    const { context, page } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase', width, height, dpr, query: QUERY.webgl });
    try {
      await page.waitForTimeout(1500);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        page.evaluate(() => window.__claudeVilleApp.renderer.strikePostcard()),
      ]);
      const file = path.join(OUT, 'postcard-download.png');
      await download.saveAs(file);
      const toast = await page.evaluate(() => document.getElementById('toastContainer')?.textContent || '');
      const named = /^claudeville-\d{4}-\d{2}-\d{2}-\d{4}\.png$/.test(download.suggestedFilename());
      if (!named || !/Postcard saved/.test(toast)) failures.push({ backend: 'webgl', scenario: 'download', problems: [`file ${download.suggestedFilename()}, toast "${toast.slice(0, 80)}"`] });
      console.log(`download ${download.suggestedFilename()} toast="${toast.trim().slice(0, 80)}"`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
if (failures.length) {
  console.log(JSON.stringify(failures, null, 1));
  process.exit(absent && failures.every(f => f.problems.every(p => p.startsWith('not on'))) ? 2 : 1);
}
console.log(`postcard smoke: ${rows.length} case(s) passed`);
