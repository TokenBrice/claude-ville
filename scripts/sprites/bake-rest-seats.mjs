#!/usr/bin/env node
// W1-D 1.6 — the Tavern's oak trestle beer garden, baked from RestSeats.js.
//
// The bench and table are authored in `tavernTableArt` (RestSeats.js): one
// 64×48 cell per facing and slice, anchor [32, 30] on the seat point, every
// texel a stop of ART_RAMPS (timber oak, slate iron, trimGold wax) under the
// selective #060402 outline. This script writes those pixels out as the
// manifest sprites, so the PNG and the renderer's own fallback (drawn from
// the same function until the sheet loads) are one image:
//
//   prop.tavernTable.{sw,se}.back.png            the bench's seat boards
//   prop.tavernTable.{sw,se}.front.png           apron, legs, the table, candle
//   prop.tavernTable.{sw,se}.front.emissive.png  the candle's wick and wax pool
//                                                (ART_RAMPS.emissive, alpha 160,
//                                                lit on the village lamp clock)
//
// The seeded table dressing (foam tankard, folded parchment, trencher) is a
// per-seat stamp drawn over the front slice at runtime (`tableDressingFor`),
// so it is not part of these sheets.
//
// Usage:
//   node scripts/sprites/bake-rest-seats.mjs            write the PNGs
//   node scripts/sprites/bake-rest-seats.mjs --check    exit 1 if a PNG is stale
//   node scripts/sprites/bake-rest-seats.mjs --preview <dir>   8x previews

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
    TAVERN_DRESSINGS,
    TAVERN_TABLE,
    tableDressingStamp,
    tavernTableArt,
} from '../../claudeville/src/presentation/character-mode/RestSeats.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PROPS = join(repoRoot, 'claudeville/assets/sprites/props');
const { width: W, height: H } = TAVERN_TABLE;

function png(data, width = W, height = H) {
    const image = new PNG({ width, height });
    image.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return PNG.sync.write(image, { colorType: 6 });
}

function files() {
    const out = [];
    for (const [facing, key] of [['south-west', 'sw'], ['south-east', 'se']]) {
        const art = tavernTableArt(facing);
        out.push([`prop.tavernTable.${key}.back.png`, png(art.back)]);
        out.push([`prop.tavernTable.${key}.front.png`, png(art.front)]);
        out.push([`prop.tavernTable.${key}.front.emissive.png`, png(art.emissive)]);
    }
    return out;
}

// A preview of both facings with every dressing laid on, `scale`x, on a
// grass-green ground, the back slice under the front.
function preview(scale = 8) {
    const pad = 4;
    const cols = TAVERN_DRESSINGS.length;
    const width = (W + pad) * cols;
    const height = (H + pad) * 2;
    const base = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) base.set([92, 118, 74, 255], i * 4);
    const blit = (src, ox, oy) => {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = (y * W + x) * 4;
            if (!src[s + 3]) continue;
            base.set(src.subarray(s, s + 4), ((oy + y) * width + ox + x) * 4);
        }
    };
    [['south-west', 0], ['south-east', 1]].forEach(([facing, row]) => {
        const art = tavernTableArt(facing);
        TAVERN_DRESSINGS.forEach((kind, col) => {
            const ox = col * (W + pad);
            const oy = row * (H + pad);
            blit(art.back, ox, oy);
            blit(art.front, ox, oy);
            const stamp = tableDressingStamp(kind, facing);
            const se = facing === 'south-east';
            const { along, across } = TAVERN_TABLE.dressing;
            const [u, v] = se ? [across, along] : [along, across];
            const dx = Math.floor((u - v) * 32) - Math.floor(stamp.width / 2) + TAVERN_TABLE.anchor[0];
            const dy = Math.floor((u + v) * 16 - TAVERN_TABLE.table.height) - stamp.height + 1 + TAVERN_TABLE.anchor[1];
            stamp.rows.forEach((cells, y) => cells.forEach((hex, x) => {
                if (!hex) return;
                const n = parseInt(hex.slice(1), 16);
                base.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], ((oy + dy + y) * width + ox + dx + x) * 4);
            }));
        });
    });
    const big = new Uint8ClampedArray(width * scale * height * scale * 4);
    for (let y = 0; y < height * scale; y++) for (let x = 0; x < width * scale; x++) {
        const s = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
        big.set(base.subarray(s, s + 4), (y * width * scale + x) * 4);
    }
    return png(big, width * scale, height * scale);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const previewAt = args.indexOf('--preview');
const list = files();
if (previewAt >= 0) {
    const dir = args[previewAt + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tavern-tables-8x.png'), preview());
    console.log(`[bake-rest-seats] preview written to ${dir}`);
} else if (check) {
    let stale = 0;
    for (const [name, bytes] of list) {
        const path = join(PROPS, name);
        if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
            console.error(`[bake-rest-seats] stale: ${name}`);
            stale++;
        }
    }
    if (stale) {
        console.error(`[bake-rest-seats] ${stale} PNG(s) stale; run node scripts/sprites/bake-rest-seats.mjs`);
        process.exit(1);
    }
    console.log(`[bake-rest-seats] ${list.length} PNGs current (${W}x${H}, anchor [${TAVERN_TABLE.anchor}])`);
} else {
    for (const [name, bytes] of list) writeFileSync(join(PROPS, name), bytes);
    console.log(`[bake-rest-seats] wrote ${list.length} PNGs to ${PROPS} (${W}x${H}, anchor [${TAVERN_TABLE.anchor}])`);
}
