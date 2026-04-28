#!/usr/bin/env node
// Assemble a ClaudeVille character sheet (8 dirs × 10 rows × 92px = 736×920)
// from a pixellab MCP character ZIP.
//
// Pixellab ZIP layout (verified 2026-04-27):
//   metadata.json
//   rotations/<dir>.png                                          (S × S, S = source canvas)
//   animations/animating-<uuid>/<dir>/frame_NNN.png              (S × S each)
//
// We map the two animations by FRAME COUNT:
//   6 frames per direction → walk
//   4 frames per direction → breathing-idle
//
// Usage:
//   node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path-to-zip>
//   (or omit --zip and the script looks for output/character-mcp-cache/<id>.zip)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import yaml from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cacheRoot = join(repoRoot, 'output', 'character-mcp-cache');
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters');
const manifestPath = join(repoRoot, 'claudeville', 'assets', 'sprites', 'manifest.yaml');

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const CELL = 92;
const WALK_FRAMES = 6;
const IDLE_FRAMES = 4;
const COLS = DIRECTIONS.length;
const ROWS = WALK_FRAMES + IDLE_FRAMES;
const args = new Set(process.argv.slice(2));
const allowUnmanifested = args.has('--allow-unmanifested');
const dryRun = args.has('--dry-run');

function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
}

const id = arg('id', null);
if (!id) { console.error('Missing --id=<sprite-id>'); process.exit(1); }
const zipPath = arg('zip', join(cacheRoot, `${id}.zip`));

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

async function main() {
    assertManifested(id);
    if (!existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
    if (dryRun) {
        console.log(`[character-mcp] dry run: ${id} is manifest-backed; ZIP exists at ${zipPath}`);
        return;
    }
    const extractDir = join(cacheRoot, `${id}-extracted`);
    mkdirSync(extractDir, { recursive: true });
    const unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], { stdio: 'inherit' });
    if (unzip.error) throw unzip.error;
    if (unzip.status !== 0) throw new Error(`unzip failed with exit code ${unzip.status}`);

    const meta = JSON.parse(readFileSync(join(extractDir, 'metadata.json'), 'utf8'));
    const SOURCE = meta.character.size.width;
    if (SOURCE < CELL) throw new Error(`Source canvas ${SOURCE} smaller than cell ${CELL}`);

    // Merge all animations by frame count: a single template (walk/idle) may be
    // split across multiple animation IDs if some directions failed and were
    // re-queued separately. Build per-direction frame lists by union.
    const walkByDir = {};
    const idleByDir = {};
    for (const [, dirs] of Object.entries(meta.frames.animations)) {
        for (const [dir, frames] of Object.entries(dirs)) {
            if (frames.length === WALK_FRAMES && !walkByDir[dir]) walkByDir[dir] = frames;
            else if (frames.length === IDLE_FRAMES && !idleByDir[dir]) idleByDir[dir] = frames;
        }
    }

    const sheet = new PNG({ width: CELL * COLS, height: CELL * ROWS });
    sheet.data.fill(0);

    for (let col = 0; col < COLS; col++) {
        const dir = DIRECTIONS[col];

        // Walk rows 0..5
        const walkFrames = walkByDir[dir];
        if (!walkFrames || walkFrames.length !== WALK_FRAMES) {
            throw new Error(`walk animation missing direction ${dir} or wrong frame count`);
        }
        for (let f = 0; f < WALK_FRAMES; f++) {
            const frame = readPng(join(extractDir, walkFrames[f]));
            const cropped = cropCenter(frame, SOURCE);
            blit(cropped, sheet, col * CELL, f * CELL);
        }

        // Idle rows 6..9
        const idleFrames = idleByDir[dir];
        if (!idleFrames || idleFrames.length !== IDLE_FRAMES) {
            throw new Error(`idle animation missing direction ${dir} or wrong frame count`);
        }
        for (let f = 0; f < IDLE_FRAMES; f++) {
            const frame = readPng(join(extractDir, idleFrames[f]));
            const cropped = cropCenter(frame, SOURCE);
            blit(cropped, sheet, col * CELL, (WALK_FRAMES + f) * CELL);
        }
    }

    const outPath = join(spritesRoot, id, 'sheet.png');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(sheet));
    console.log(`wrote ${outPath} (${CELL * COLS}×${CELL * ROWS}, source=${SOURCE})`);
}

function readPng(p) {
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return PNG.sync.read(readFileSync(p));
}

function assertManifested(spriteId) {
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
    const ids = new Set((manifest.characters || []).map((entry) => entry?.id).filter(Boolean));
    if (ids.has(spriteId)) return;

    const message = `unmanifested character ID: ${spriteId}`;
    if (!allowUnmanifested) {
        throw new Error(`${message}; pass --allow-unmanifested only for scratch assets`);
    }
    console.warn(`[character-mcp] WARNING: ${message}`);
}

// Center-crop a CELL×CELL window from a SOURCE×SOURCE frame.
function cropCenter(src, source) {
    if (src.width !== source || src.height !== source) {
        throw new Error(`expected ${source}×${source}, got ${src.width}×${src.height}`);
    }
    const off = Math.floor((source - CELL) / 2);
    const out = new PNG({ width: CELL, height: CELL });
    out.data.fill(0);
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const sxx = off + x;
            const syy = off + y;
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
