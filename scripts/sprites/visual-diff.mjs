#!/usr/bin/env node
// Compare baseline screenshots to fresh captures using pixelmatch.
// Exits non-zero if any pose exceeds 0.5% pixel diff.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const baselineDir = join(repoRoot, 'docs', 'superpowers', 'specs',
                          '2026-04-25-pixel-art-baseline');
const POSES = ['overview', 'command', 'harbor', 'mine', 'fringe'];
const THRESHOLD_PCT = 0.5;     // fail if > 0.5% pixels differ
const PIXELMATCH_THRESHOLD = 0.1;

if (!existsSync(baselineDir)) {
    console.warn(`[visual-diff] baseline directory not found at ${baselineDir} — nothing to compare yet`);
    console.warn('[visual-diff] run Task 4.6 to capture baselines first');
    process.exit(0);
}

let failed = 0;
let skipped = 0;

for (const pose of POSES) {
    const basePath = join(baselineDir, `${pose}.png`);
    const freshPath = join(baselineDir, `${pose}-fresh.png`);
    const diffPath = join(baselineDir, `${pose}-diff.png`);

    if (!existsSync(basePath)) {
        console.warn(`[visual-diff] skip ${pose}: no baseline at ${basePath}`);
        skipped++;
        continue;
    }
    if (!existsSync(freshPath)) {
        console.warn(`[visual-diff] skip ${pose}: no fresh capture at ${freshPath}`);
        skipped++;
        continue;
    }

    const base = PNG.sync.read(readFileSync(basePath));
    const fresh = PNG.sync.read(readFileSync(freshPath));
    if (base.width !== fresh.width || base.height !== fresh.height) {
        console.error(`[visual-diff] FAIL ${pose}: dimensions differ — baseline ${base.width}x${base.height}, fresh ${fresh.width}x${fresh.height}`);
        failed++;
        continue;
    }
    const { width, height } = base;
    const diff = new PNG({ width, height });
    const mismatched = pixelmatch(
        base.data, fresh.data, diff.data,
        width, height, { threshold: PIXELMATCH_THRESHOLD }
    );
    const total = width * height;
    const pct = (mismatched / total) * 100;
    writeFileSync(diffPath, PNG.sync.write(diff));
    const verdict = pct > THRESHOLD_PCT ? 'FAIL' : 'OK';
    console.log(`[visual-diff] ${verdict} ${pose}: ${mismatched}/${total} px (${pct.toFixed(3)}%)`);
    if (pct > THRESHOLD_PCT) failed++;
}

console.log(`[visual-diff] summary: ${POSES.length - skipped - failed}/${POSES.length} passing, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
