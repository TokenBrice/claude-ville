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
    let result;
    try {
      result = await renderer.strikePostcard({ save: false, trace });
    } finally {
      AgentSprite.prototype._drawOverlayStamp = stamp;
      BuildingSprite.prototype._drawOnTaskboardSlate = slate;
    }
    if (!result.ok) return { ok: false, reason: result.reason, textCalls: result.textCalls };
    const canvas = result.canvas;
    const world = renderer.canvas;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, world.width, world.height).data;
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
          if (!(got.liveTextCalls > 0)) problems.push('live frame drew no text after the strike');
        }
        if (errors.length) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
        const status = problems.length ? 'FAIL' : 'ok';
        if (problems.length) failures.push({ backend, scenario, problems });
        console.log(`${status} ${backend} ${scenario} distinct=${got.distinct} text=${got.textCalls} ${problems.join('; ')}`);
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
    ];
    for (const sample of samples) {
      const { context, page } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase', width, height, dpr, query: QUERY.webgl });
      try {
        await poseWorld(page, { hour: sample.hour, weather: sample.weather, zoom: 1, tile: [20, 22] });
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
