#!/usr/bin/env node
// SD-3 (look `sd3`) render check: the sun's lift as it renders, on every
// World backend. Drives `scripts/world/golden-hours.mjs` (its isolated
// server, pinned clear noon on 2026-10-24, reduced motion, frames read back
// per backend: WebGPU through debugCaptureTargets) and compares the frames:
//
//   - sd3 at 1 lifts: at least LIFT_SHARE of the frame brightens, and no
//     pixel darkens;
//   - the cap, on one integer luma (support/sun-lift-check.mjs): no pixel
//     at or under CANDLE (the waiting candle's 192) at sd3 0 ends above it,
//     and a pixel already above it rises by at most BRIGHT_RISE. That bound covers a handful of bridge-plank highlights
//     already at 192-210 under the bridge candles: as understood (not
//     verified) the candles' additive glow is composited after the scene
//     pass over the lifted surface, out of the shader's hold. Their count
//     and largest rise are printed so a regression shows;
//   - every frame is captured by this run: a missing frame, or one older
//     than the run, fails (no PNG is ever reused);
//   - with --baseline-root=<tree> (a checkout or `git archive` of the base,
//     e.g. council/integration, with node_modules linked), sd3 at 0 renders
//     that tree's frame byte for byte (--max-diff pixels allowed, default 0).
//
// Usage: node scripts/smoke/sun-lift.mjs [--renderers=webgpu,webgl,canvas]
//          [--baseline-root=<dir>] [--max-diff=<n>] [--out=<dir>]
// Exit: 0 pass, 1 a check failed or a backend produced no fresh frame.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { BRIGHT_RISE, CANDLE, liftVerdict, lumaAt } from './support/sun-lift-check.mjs';

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

function frames(tree, dir, look, only = renderers) {
  const runArgs = ['scripts/world/golden-hours.mjs', `--scenes=${SCENE}`, `--renderers=${only.join(',')}`, `--frames=${dir}`];
  if (look) runArgs.push(`--look=${look}`);
  // The curve's own verdict is not this check's: only the frames are read.
  // Each tree starts its own isolated server: an inherited CLAUDEVILLE_URL
  // would send baseline and candidate to one server, so it is dropped.
  const { CLAUDEVILLE_URL: _inherited, ...env } = process.env;
  try { execFileSync(process.execPath, runArgs, { cwd: tree, stdio: 'ignore', env: { ...env, NODE_NO_WARNINGS: '1' } }); } catch {}
}

const read = file => PNG.sync.read(readFileSync(file));
const luma = lumaAt;
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

frames(ROOT, path.join(out, 'zero'), 'sd3:0');
frames(ROOT, path.join(out, 'one'), 'sd3:1');
if (args['baseline-root']) frames(path.resolve(args['baseline-root']), path.join(out, 'base'), null);

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
    frames(ROOT, again, 'sd3:0', [renderer]);
    if (fresh(path.join(again, name))) diff = Math.min(diff, count(path.join(again, name)));
    const baseAgain = path.join(out, `base-${renderer}`);
    frames(path.resolve(args['baseline-root']), baseAgain, null, [renderer]);
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
    frames(ROOT, again, 'sd3:1', [renderer]);
    if (fresh(path.join(again, name))) {
      const retry = read(path.join(again, name));
      if (darkened(retry) < darkened(one)) one = retry;
    }
  }
  let brightRise = 0;
  let brightRisen = 0;
  let lifted = 0;
  let darker = 0;
  let overCap = 0;
  let brightest = 0;
  for (let i = 0; i < zero.data.length; i += 4) {
    const a = luma(zero.data, i);
    const b = luma(one.data, i);
    const verdict = liftVerdict(a, b);
    if (verdict.over) overCap++;
    if (verdict.brightRise > 0) {
      brightRisen++;
      brightRise = Math.max(brightRise, verdict.brightRise);
    }
    if (b > a) {
      lifted++;
      brightest = Math.max(brightest, b);
    } else if (b < a - 2) {
      darker++;
    }
  }
  const pixels = zero.data.length / 4;
  const row = { renderer, lifted: `${(100 * lifted / pixels).toFixed(2)}%`, darker, overCap, brightest, brightRisen, brightRise };
  if (lifted / pixels < LIFT_SHARE) failures.push(`${renderer}: sd3 1 lifts ${row.lifted} of the frame (< ${LIFT_SHARE * 100}%)`);
  if (darker) failures.push(`${renderer}: sd3 1 darkens ${darker} pixels`);
  if (overCap) failures.push(`${renderer}: ${overCap} lifted pixels cross the candle's ${CANDLE}, or rise more than ${BRIGHT_RISE} above it`);
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
process.exitCode = failures.length ? 1 : 0;
