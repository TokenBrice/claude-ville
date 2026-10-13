#!/usr/bin/env node
// Stage one action-strip group from a named animation already on the
// character's PixelLab rig (any mode: v3, pixminimax, template), for
// assemble-action-strip.mjs. Spends nothing: the animation is requested
// beforehand (MCP `animate_character`) and only read back here.
//
// `--frames` picks which exported frames become the group's rows, in order
// (pixminimax exports a reference frame 0 plus the animated frames). An
// existing stage at the output path keeps the facings this run does not
// write, so one group can merge facings from two animations.
//
// Usage:
//   node scripts/sprites/stage-animation-strip.mjs --id=agent.claude.opus --group=read \
//       --animation=claudeville-read-opus-pmm --frames=3,6,7,8 [--hold=3] \
//       [--directions=south,south-west] [--out=output/pose-strips] [--seat]
//   --seat moves each staged frame so its feet land on the base sheet's V7
//   anchor (the foot line and the idle row-6 feet, matched as feet-audit
//   measures them), so a model that drifted the body a few px still passes.
//   → <out>/<id>.<group>.png (8 columns × frames rows of 92px) + .json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import {
    blitPng,
    characterAnimationFrames,
    fetchPng,
    fitCenterToCell,
    getCharacter,
    readPixellabToken,
} from './pixellab-rest.mjs';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, repoRoot, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
const ALPHA_MIN = 16;
const FOOT_WINDOW = 10;
const FOOT_SEARCH = 8;
const IDLE_ROW = 6;
const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const fail = (message) => { console.error(`[stage-animation] ${message}`); process.exit(1); };

const id = option('id');
const group = option('group');
const animation = option('animation');
const frames = (option('frames') || '').split(',').filter(Boolean).map(Number);
if (!id || !group || !animation || !frames.length || frames.some((n) => !Number.isInteger(n) || n < 0)) {
    fail('usage: --id=<sprite id> --group=<name> --animation=<rig animation name> --frames=a,b,c [--hold=n] [--directions=…] [--out=dir]');
}
const hold = Number(option('hold', String(frames.length - 1)));
const directions = (option('directions') || DIRECTIONS.join(',')).split(',').filter(Boolean);
for (const direction of directions) if (!DIRECTIONS.includes(direction)) fail(`unknown direction ${direction}`);
const entry = collectSpriteEntries(loadSpriteManifest()).find((candidate) => candidate.id === id);
const characterId = option('character-id') || entry?.provenance?.characterId;
if (!characterId) fail(`${id} has no provenance.characterId`);

const outDir = resolve(repoRoot, option('out', join('output', 'pose-strips')));
const stagePath = join(outDir, `${id}.${group}.png`);
const metaPath = stagePath.replace(/\.png$/, '.json');
const previous = existsSync(stagePath) ? PNG.sync.read(readFileSync(stagePath)) : null;
const previousMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
if (previous && previous.height !== CELL * frames.length) fail(`existing stage has ${previous.height / CELL} rows, not ${frames.length}`);

const seat = args.includes('--seat');
const sheet = PNG.sync.read(readFileSync(join(spritesRoot, pathForEntry(entry))));
const anchors = DIRECTIONS.map((_, col) => {
    const idle = measure(sheet, col, IDLE_ROW);
    let maxY = -1;
    for (let row = 0; row < 10; row++) maxY = Math.max(maxY, measure(sheet, col, row).maxY);
    return { mask: idle.mask, maxY };
});
const shifts = [];

const token = readPixellabToken();
const character = await getCharacter(token, characterId);
const { byDirection, byDirectionGroup } = characterAnimationFrames(character, animation, { frameCount: Math.max(...frames) + 1 });
const stage = new PNG({ width: CELL * DIRECTIONS.length, height: CELL * frames.length });
if (previous) blitPng(previous, stage, 0, 0);
const sources = { ...(previousMeta?.provenance?.sources || {}) };
for (const direction of directions) {
    const urls = byDirection.get(direction);
    if (!urls) fail(`${animation} has no ${direction} record with ${Math.max(...frames) + 1} frames`);
    const col = DIRECTIONS.indexOf(direction);
    for (let row = 0; row < CELL * frames.length; row++) stage.data.fill(0, (row * stage.width + col * CELL) * 4, (row * stage.width + (col + 1) * CELL) * 4);
    for (let i = 0; i < frames.length; i++) {
        const png = await fetchPng(urls[frames[i]], { label: `${direction}#${frames[i]}` });
        let cell = fitCenterToCell(png, CELL);
        const shift = seat ? feetShift(anchors[col], measure(cell, 0, 0)) : { dx: 0, dy: 0 };
        if (shift.dx || shift.dy) cell = translated(cell, -shift.dx, -shift.dy);
        shifts.push(shift.dx || shift.dy ? `${direction}#${frames[i]} ${-shift.dx}/${-shift.dy}` : null);
        blitPng(cell, stage, col * CELL, i * CELL);
    }
    sources[direction] = { animation, animationGroupId: byDirectionGroup.get(direction), frames, ...(seat ? { seated: true } : {}) };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(stagePath, PNG.sync.write(stage));
writeFileSync(metaPath, `${JSON.stringify({
    id,
    groups: { [group]: { rows: [0, frames.length - 1], hold } },
    provenance: { characterId, sources },
}, null, 1)}\n`);
if (shifts.some(Boolean)) console.log(`[stage-animation] seated (dx/dy): ${shifts.filter(Boolean).join(', ')}`);
console.log(`[stage-animation] wrote ${relative(repoRoot, stagePath)} (${directions.join(', ')}); next: feet-audit, then assemble-action-strip --stage=…`);

function measure(png, col, row) {
    const mask = new Uint8Array(CELL * CELL);
    let maxY = -1;
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            if (png.data[((row * CELL + y) * png.width + col * CELL + x) * 4 + 3] < ALPHA_MIN) continue;
            mask[y * CELL + x] = 1;
            maxY = y;
        }
    }
    return { mask, maxY };
}

// feet-audit's measure: the foot line vertically, and the idle feet window
// template-matched (IoU, ties to the smallest move) horizontally.
function feetShift(ref, frame) {
    const dy = frame.maxY - ref.maxY;
    const top = Math.max(0, ref.maxY - FOOT_WINDOW + 1);
    let best = { dx: 0, dy, iou: -1 };
    for (let dx = -FOOT_SEARCH; dx <= FOOT_SEARCH; dx++) {
        let inter = 0, union = 0;
        for (let y = top; y <= ref.maxY; y++) {
            for (let x = 0; x < CELL; x++) {
                const fy = y + dy, fx = x + dx;
                const hit = fy >= 0 && fy < CELL && fx >= 0 && fx < CELL ? frame.mask[fy * CELL + fx] : 0;
                const r = ref.mask[y * CELL + x];
                inter += hit & r;
                union += hit | r;
            }
        }
        const iou = inter / Math.max(1, union);
        if (iou > best.iou + 1e-9 || (Math.abs(iou - best.iou) <= 1e-9 && Math.abs(dx) < Math.abs(best.dx))) best = { dx, dy, iou };
    }
    return best;
}

function translated(src, dx, dy) {
    const out = new PNG({ width: CELL, height: CELL });
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const sx = x - dx, sy = y - dy;
            if (sx < 0 || sy < 0 || sx >= CELL || sy >= CELL) continue;
            src.data.copy(out.data, (y * CELL + x) * 4, (sy * CELL + sx) * 4, (sy * CELL + sx) * 4 + 4);
        }
    }
    return out;
}
