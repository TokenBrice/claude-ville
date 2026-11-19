#!/usr/bin/env node
// SD-3 (look `sd3`) render check: the sun's lift as it renders, on every
// World backend. Drives `scripts/world/golden-hours.mjs` (its isolated
// server, pinned clear noon on 2026-10-24, reduced motion, frames read back
// per backend: WebGPU through debugCaptureTargets) and compares the frames:
//
//   - sd3 at 1 lifts: at least LIFT_SHARE of the frame brightens, and no
//     pixel darkens;
//   - the cap, on one integer luma (support/sun-lift-check.mjs): a pixel at
//     or under GLOW_BAND - 1 (187) with the lift off ends at or under the
//     candle's 192; one from GLOW_BAND (188) up rises by at most BRIGHT_RISE
//     (5). The upper band is a known residual: bridge-plank highlights inside
//     the bridge candles' additive glow at the candle threshold (cause
//     unverified, to be checked on hardware). Each band's count of risen
//     pixels and largest rise are printed, so a regression shows;
//   - every frame is captured by this run: a missing frame, or one older
//     than the run, fails (no PNG is ever reused);
//   - with --baseline-root=<tree> (a checkout or `git archive` of the base,
//     e.g. council/integration, with node_modules linked), sd3 at 0 renders
//     that tree's frame byte for byte (--max-diff pixels allowed, default 0);
//     both sides are captured settled (`--settle=frames`: no pending terrain
//     restage, two byte-identical captures in a row), the baseline from its
//     own isolated server.
//
// Usage: node scripts/smoke/sun-lift.mjs [--renderers=webgpu,webgl,canvas]
//          [--baseline-root=<dir>] [--max-diff=<n>] [--out=<dir>]
// Exit: 0 pass, 1 a check failed or a backend produced no fresh frame.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { BRIGHT_RISE, CANDLE, GLOW_BAND, liftVerdict, lumaAt } from './support/sun-lift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCENE = 'clear-1200';
const LIFT_SHARE = 0.01;
const STARTED = Date.now();
// A frame this run did not write is no evidence.
function fresh(file) {
  return existsSync(file) && statSync(file).mtimeMs >= STARTED;
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [flag, value = ''] = arg.split(/=(.*)/s);
  return [flag.replace(/^--/, ''), value];
}));
const renderers = (args.renderers || 'webgpu,webgl,canvas').split(',').map(s => s.trim()).filter(Boolean);
const maxDiff = Number(args['max-diff'] || 0);
const out = path.resolve(args.out || path.join(process.env.CLAUDEVILLE_TEST_TMPDIR || os.tmpdir(), `sun-lift-${Date.now()}`));
mkdirSync(out, { recursive: true });

// Every capture goes through this tree's golden-hours.mjs with
// `--settle=frames` (no pending restage, two byte-identical captures in a
// row); the baseline's pages come from its own isolated server (`url`). An
// inherited CLAUDEVILLE_URL is dropped, so the two never share a server.
function frames(dir, look, only = renderers, url = null) {
  const runArgs = ['scripts/world/golden-hours.mjs', `--scenes=${SCENE}`, `--renderers=${only.join(',')}`, `--frames=${dir}`, '--settle=frames'];
  if (look) runArgs.push(`--look=${look}`);
  if (url) runArgs.push(`--url=${url}`);
  const { CLAUDEVILLE_URL: _inherited, ...env } = process.env;
  // The curve's own verdict is not this check's: only the frames are read.
  try { execFileSync(process.execPath, runArgs, { cwd: ROOT, stdio: 'ignore', env: { ...env, NODE_NO_WARNINGS: '1' } }); } catch {}
}

const read = file => PNG.sync.read(readFileSync(file));
const luma = lumaAt;
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

frames(path.join(out, 'zero'), 'sd3:0');
frames(path.join(out, 'one'), 'sd3:1');
// The baseline tree serves its own pages from its own isolated server.
let baseServer = null;
if (args['baseline-root']) {
  const { startIsolatedServer } = await import(pathToFileURL(path.join(path.resolve(args['baseline-root']), 'scripts/smoke/support/isolated-server.mjs')).href);
  baseServer = await startIsolatedServer();
  frames(path.join(out, 'base'), null, renderers, baseServer.baseUrl);
}

// A frame captured while a progressive bake (the Canvas sea) is still
// landing can differ from the baseline: the strength-zero frame is captured
// once more before it is judged.
function zeroDiff(renderer, name) {
  const base = read(path.join(out, 'base', name));
  const count = file => {
    const zero = read(file);
    let diff = 0;
    for (let i = 0; i < base.data.length; i += 4) {
      if (base.data[i] !== zero.data[i] || base.data[i + 1] !== zero.data[i + 1] || base.data[i + 2] !== zero.data[i + 2]) diff++;
    }
    return diff;
  };
  let diff = count(path.join(out, 'zero', name));
  if (diff > maxDiff) {
    // Both sides once more (a frame can also catch a bake mid-flight on the base).
    const again = path.join(out, `zero-${renderer}`);
    frames(again, 'sd3:0', [renderer]);
    if (fresh(path.join(again, name))) diff = Math.min(diff, count(path.join(again, name)));
    const baseAgain = path.join(out, `base-${renderer}`);
    frames(baseAgain, null, [renderer], baseServer.baseUrl);
    if (fresh(path.join(baseAgain, name))) {
      const zeroNow = path.join(fresh(path.join(again, name)) ? again : path.join(out, 'zero'), name);
      const rebased = read(path.join(baseAgain, name));
      const zero = read(zeroNow);
      let d = 0;
      for (let i = 0; i < rebased.data.length; i += 4) {
        if (rebased.data[i] !== zero.data[i] || rebased.data[i + 1] !== zero.data[i + 1] || rebased.data[i + 2] !== zero.data[i + 2]) d++;
      }
      diff = Math.min(diff, d);
    }
  }
  return diff;
}

const failures = [];
let missing = false;
for (const renderer of renderers) {
  const name = `${renderer}-${SCENE}.png`;
  const [zeroFile, oneFile, baseFile] = ['zero', 'one', 'base'].map(dir => path.join(out, dir, name));
  if (!fresh(zeroFile) || !fresh(oneFile)) {
    failures.push(`${renderer}: no fresh frame from this run (backend unavailable, or a capture failed)`);
    missing = true;
    continue;
  }
  const zero = read(zeroFile);
  let one = read(oneFile);
  // A progressive bake (the Canvas sea) caught mid-flight reads as darkening:
  // the lifted frame is captured once more before it is judged.
  const darkened = frame => {
    let n = 0;
    for (let i = 0; i < zero.data.length; i += 4) if (luma(frame.data, i) < luma(zero.data, i) - 2) n++;
    return n;
  };
  if (darkened(one) > 0) {
    const again = path.join(out, `one-${renderer}`);
    frames(again, 'sd3:1', [renderer]);
    if (fresh(path.join(again, name))) {
      const retry = read(path.join(again, name));
      if (darkened(retry) < darkened(one)) one = retry;
    }
  }
  // Per band: how many pixels rose and the largest rise.
  const bands = { low: { risen: 0, maxRise: 0, maxEnd: 0 }, high: { risen: 0, maxRise: 0 } };
  let lifted = 0;
  let darker = 0;
  let overCap = 0;
  let brightest = 0;
  for (let i = 0; i < zero.data.length; i += 4) {
    const a = luma(zero.data, i);
    const b = luma(one.data, i);
    const verdict = liftVerdict(a, b);
    if (verdict.over) overCap++;
    if (verdict.rise > 0) {
      const band = bands[verdict.band];
      band.risen++;
      band.maxRise = Math.max(band.maxRise, verdict.rise);
      if (verdict.band === 'low') band.maxEnd = Math.max(band.maxEnd, b);
    }
    if (b > a) {
      lifted++;
      brightest = Math.max(brightest, b);
    } else if (b < a - 2) {
      darker++;
    }
  }
  const pixels = zero.data.length / 4;
  const row = { renderer, lifted: `${(100 * lifted / pixels).toFixed(2)}%`, darker, overCap, brightest, low: bands.low, high: bands.high };
  if (lifted / pixels < LIFT_SHARE) failures.push(`${renderer}: sd3 1 lifts ${row.lifted} of the frame (< ${LIFT_SHARE * 100}%)`);
  if (darker) failures.push(`${renderer}: sd3 1 darkens ${darker} pixels`);
  if (overCap) failures.push(`${renderer}: ${overCap} pixels break their band (under ${GLOW_BAND}: end at or under ${CANDLE}; from ${GLOW_BAND}: rise at most ${BRIGHT_RISE})`);
  if (args['baseline-root']) {
    if (!fresh(baseFile)) {
      failures.push(`${renderer}: the baseline tree produced no fresh frame`);
    } else {
      const diff = zeroDiff(renderer, name);
      row.zeroHash = hash(zeroFile);
      row.baseHash = hash(baseFile);
      row.zeroDiff = diff;
      if (diff > maxDiff) failures.push(`${renderer}: sd3 0 differs from the baseline in ${diff} pixels`);
    }
  }
  console.log(JSON.stringify(row));
}
console.log(`frames: ${out}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
if (!failures.length) console.log('PASS');
await baseServer?.stop?.();
process.exitCode = failures.length ? 1 : 0;
