#!/usr/bin/env node
// Assemble a ClaudeVille character sheet (8 dirs × 10 rows × 92px = 736×920)
// from pixellab MCP outputs cached on disk.
//
// Usage:
//   node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> [--source-size=132]
//
// Cache layout (operator must populate before running):
//   output/character-mcp-cache/<id>/rotations/<dir>.png       (S × S, where S = source size, default 132)
//   output/character-mcp-cache/<id>/walk/<dir>.png            (S × (S × 6) — 6-frame strip)
//   output/character-mcp-cache/<id>/breathing-idle/<dir>.png  (S × (S × 4) — 4-frame strip)
//
// Output: claudeville/assets/sprites/characters/<id>/sheet.png  (736×920)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cacheRoot = join(repoRoot, 'output', 'character-mcp-cache');
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters');

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const CELL = 92;
const WALK_FRAMES = 6;
const IDLE_FRAMES = 4;
const COLS = DIRECTIONS.length;
const ROWS = WALK_FRAMES + IDLE_FRAMES;

function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
}

const id = arg('id', null);
if (!id) { console.error('Missing --id=<sprite-id>'); process.exit(1); }
const SOURCE = parseInt(arg('source-size', '132'), 10);
if (Number.isNaN(SOURCE) || SOURCE < CELL) { console.error(`--source-size must be ≥ ${CELL}`); process.exit(1); }

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

async function main() {
    const cacheDir = join(cacheRoot, id);
    if (!existsSync(cacheDir)) throw new Error(`Cache not found: ${cacheDir}`);

    // Pre-flight: 24 files must exist
    let count = 0;
    for (const sub of ['rotations', 'walk', 'breathing-idle']) {
        for (const dir of DIRECTIONS) {
            if (existsSync(join(cacheDir, sub, `${dir}.png`))) count++;
        }
    }
    if (count !== 24) throw new Error(`Cache for ${id} has ${count}/24 PNGs — re-run download step.`);

    const sheet = new PNG({ width: CELL * COLS, height: CELL * ROWS });
    sheet.data.fill(0);

    for (let col = 0; col < COLS; col++) {
        const dir = DIRECTIONS[col];

        const walkStrip = readPng(join(cacheDir, 'walk', `${dir}.png`));
        if (walkStrip.height !== SOURCE || walkStrip.width !== SOURCE * WALK_FRAMES) {
            throw new Error(`walk/${dir}.png: expected ${SOURCE * WALK_FRAMES}×${SOURCE}, got ${walkStrip.width}×${walkStrip.height}. Use --source-size=<actual height> if pixellab returned a different canvas.`);
        }
        for (let f = 0; f < WALK_FRAMES; f++) {
            const frame = cropCenter(walkStrip, f * SOURCE, 0);
            blit(frame, sheet, col * CELL, f * CELL);
        }

        const idleStrip = readPng(join(cacheDir, 'breathing-idle', `${dir}.png`));
        if (idleStrip.height !== SOURCE || idleStrip.width !== SOURCE * IDLE_FRAMES) {
            throw new Error(`breathing-idle/${dir}.png: expected ${SOURCE * IDLE_FRAMES}×${SOURCE}, got ${idleStrip.width}×${idleStrip.height}.`);
        }
        for (let f = 0; f < IDLE_FRAMES; f++) {
            const frame = cropCenter(idleStrip, f * SOURCE, 0);
            blit(frame, sheet, col * CELL, (WALK_FRAMES + f) * CELL);
        }
    }

    const outPath = join(spritesRoot, id, 'sheet.png');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(sheet));
    console.log(`wrote ${outPath} (${CELL * COLS}×${CELL * ROWS})`);
}

function readPng(p) {
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return PNG.sync.read(readFileSync(p));
}

// Center-crop CELL×CELL from a SOURCE×SOURCE region of src starting at (sx, sy).
function cropCenter(src, sx, sy) {
    const off = Math.floor((SOURCE - CELL) / 2);
    const out = new PNG({ width: CELL, height: CELL });
    out.data.fill(0);
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const sxx = sx + off + x;
            const syy = sy + off + y;
            if (sxx < 0 || syy < 0 || sxx >= src.width || syy >= src.height) continue;
            const si = (src.width * syy + sxx) << 2;
            const di = (CELL * y + x) << 2;
            out.data[di] = src.data[si];
            out.data[di + 1] = src.data[si + 1];
            out.data[di + 2] = src.data[si + 2];
            out.data[di + 3] = src.data[si + 3];
        }
    }
    return out;
}

function blit(src, dst, dx, dy) {
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const si = (src.width * y + x) << 2;
            if (src.data[si + 3] === 0) continue;
            const dxx = dx + x;
            const dyy = dy + y;
            if (dxx < 0 || dyy < 0 || dxx >= dst.width || dyy >= dst.height) continue;
            const di = (dst.width * dyy + dxx) << 2;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = src.data[si + 3];
        }
    }
}
