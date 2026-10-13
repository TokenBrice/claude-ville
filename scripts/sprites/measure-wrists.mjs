#!/usr/bin/env node
// Propose CodexCelestialGrips wrist tables for a regenerated Codex body: one
// PixelLab /estimate-skeleton per cell (≈0.1 generation each, cached by cell
// hash), reporting the tracked hand's wrist (`LEFT ARM`: screen-right facing
// S, the far hand facing E/NE, screen-left facing N — the hand the shipped
// tables follow) in 92px cell coordinates. Review the overlay before pasting:
// an estimate can swap hands on a turn or drift onto a cape.
//
// Usage:
//   node scripts/sprites/measure-wrists.mjs --id=agent.codex.gpt56luna [--overlay=<png>]
//       base sheet: six walk rows then four idle rows → `wrists`
//   node scripts/sprites/measure-wrists.mjs --id=… --strip-group=run [--overlay=<png>]
//       an actionStrip group's rows → `poseWrists.<group>`
//   … --rows=6   only those rows (calibrate against a shipped table first)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { readPixellabToken } from './pixellab-rest.mjs';
import { api, createSpend } from './pixellab-spend.mjs';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, repoRoot, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
const PAD = 128;
const OFFSET = (PAD - CELL) / 2;
const SHORT = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const HAND = 'LEFT ARM';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const id = option('id');
const stripGroup = option('strip-group');
const overlayPath = option('overlay');
const entry = collectSpriteEntries(loadSpriteManifest()).find((candidate) => candidate.id === id);
if (!entry) throw new Error(`${id} is not a manifest character`);

let source;
let rows;
if (stripGroup) {
    const group = entry.actionStrip?.groups?.[stripGroup];
    if (!group) throw new Error(`${id} has no actionStrip group ${stripGroup}`);
    source = PNG.sync.read(readFileSync(join(spritesRoot, entry.actionStrip.path)));
    rows = Array.from({ length: group.rows[1] - group.rows[0] + 1 }, (_, i) => group.rows[0] + i);
} else {
    source = PNG.sync.read(readFileSync(join(spritesRoot, pathForEntry(entry))));
    rows = Array.from({ length: 10 }, (_, i) => i);
}
// `--rows=6` measures only those sheet/strip rows (a calibration run).
if (option('rows')) rows = option('rows').split(',').map(Number).filter((row) => rows.includes(row));

const cacheDir = join(repoRoot, 'output', 'wrist-cache', id);
mkdirSync(cacheDir, { recursive: true });
const token = readPixellabToken();
const spend = createSpend({ token, agent: 'measure-wrists' });

const table = {};
for (let col = 0; col < SHORT.length; col++) {
    table[SHORT[col]] = [];
    for (const row of rows) {
        const padded = new PNG({ width: PAD, height: PAD });
        PNG.bitblt(source, padded, col * CELL, row * CELL, CELL, CELL, OFFSET, OFFSET);
        const bytes = PNG.sync.write(padded);
        const hash = createHash('sha256').update(padded.data).digest('hex').slice(0, 16);
        const cached = join(cacheDir, `${hash}.json`);
        let keypoints;
        if (existsSync(cached)) {
            keypoints = JSON.parse(readFileSync(cached, 'utf8'));
        } else {
            const result = await spend.job({
                item: 'measure-wrists',
                endpoint: '/estimate-skeleton',
                target: `${id} ${SHORT[col]} row ${row}`,
                maxCost: 1,
                run: () => api(token, '/estimate-skeleton', {
                    method: 'POST',
                    label: `estimate ${SHORT[col]} row ${row}`,
                    body: { image: { type: 'base64', base64: bytes.toString('base64'), format: 'png' } },
                }),
            });
            keypoints = result?.keypoints || [];
            writeFileSync(cached, JSON.stringify(keypoints));
        }
        // Facing N the estimate often swaps hands; the tracked hand is the
        // screen-left one there.
        const hand = SHORT[col] === 'n'
            ? keypoints.filter((k) => k.label.endsWith(' ARM')).sort((a, b) => a.x - b.x)[0]
            : keypoints.find((k) => k.label === HAND);
        if (!hand) throw new Error(`${SHORT[col]} row ${row}: no ${HAND} keypoint`);
        table[SHORT[col]].push([Math.round(hand.x * PAD - OFFSET), Math.round(hand.y * PAD - OFFSET)]);
    }
}

for (const [dir, points] of Object.entries(table)) {
    console.log(`            ${`${dir}:`.padEnd(4)}${points.map(([x, y]) => `[${x},${y}]`).join(', ')},`);
}

if (overlayPath) {
    // Review sheet: every measured cell at 3× with the wrist marked red.
    const scale = 3;
    const out = new PNG({ width: SHORT.length * CELL * scale, height: rows.length * CELL * scale });
    for (let col = 0; col < SHORT.length; col++) {
        rows.forEach((row, r) => {
            for (let y = 0; y < CELL; y++) {
                for (let x = 0; x < CELL; x++) {
                    const si = ((row * CELL + y) * source.width + col * CELL + x) * 4;
                    const [wx, wy] = table[SHORT[col]][r];
                    const mark = Math.abs(x - wx) + Math.abs(y - wy) <= 1;
                    const alpha = source.data[si + 3];
                    const rgba = mark ? [255, 0, 0, 255] : alpha ? [source.data[si], source.data[si + 1], source.data[si + 2], 255] : [58, 66, 58, 255];
                    for (let dy = 0; dy < scale; dy++) {
                        for (let dx = 0; dx < scale; dx++) {
                            const di = (((r * CELL + y) * scale + dy) * out.width + (col * CELL + x) * scale + dx) * 4;
                            out.data.set(rgba, di);
                        }
                    }
                }
            }
        });
    }
    writeFileSync(overlayPath, PNG.sync.write(out));
    console.log(`[measure-wrists] overlay ${overlayPath}`);
}
