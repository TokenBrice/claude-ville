#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import { TERRACE_ANCHORS, wallCourseStop } from '../../claudeville/src/presentation/character-mode/TerraceWallPattern.js';
import { encodeSurface, SURFACE_FACE } from './bake-surface-channel.mjs';

export const TERRACE_KIT_SPEC = {
    stair: { width: 64, height: 48, anchor: TERRACE_ANCHORS.stair, risePx: 8, steps: 8, riserPx: 1, directions: ['ne', 'nw', 'se', 'sw'] },
    corner: { width: 32, height: 32, anchor: TERRACE_ANCHORS.corner, wallHeightPx: 8, variants: ['inner', 'outer'] },
};

export function spriteChannels(width, height) {
    const image = () => new PNG({ width, height, colorType: 6 });
    const png = image(), material = image(), occluder = image();
    function pixel(x, y, color, kind, face, h) {
        const at = 4 * (y * width + x);
        png.data.writeUInt32BE(parseInt(color.slice(1), 16) * 256 + 255, at);
        material.data.set([materialClassId(kind), 0, 0, 255], at);
        const { r, b } = encodeSurface(face, h);
        occluder.data.set([r, 255, b, 255], at);
    }
    return { png, material, occluder, pixel };
}

function stair(direction) {
    const { width, height, anchor } = TERRACE_KIT_SPEC.stair;
    const art = spriteChannels(width, height);
    const alongU = direction === 'se' || direction === 'nw';
    const forward = direction === 'se' || direction === 'sw';
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const q = (x + 0.5 - anchor[0]) / 32;
        // Back-project the eight horizontal treads and their vertical risers.
        for (let h = 0; h <= 8; h++) {
            const sum = (y + 0.5 - anchor[1] - 4 + h) / 16;
            const u = (sum + q + 1) / 2, v = (sum - q + 1) / 2;
            const along = alongU ? u : v, across = alongU ? v : u;
            if (along < 0 || along >= 1 || across < 0.125 || across >= 0.875) continue;
            const step = (forward ? along : 1 - along) * 8;
            const tread = Math.floor(step);
            const cheek = across < 0.22 || across >= 0.78;
            const top = tread + Number(cheek || step - tread >= 0.75);
            if (h > top) continue;
            const row = top - h;
            let stop = wallCourseStop(x, row, top + 1, q > 0);
            if (!cheek && row === 0) {
                const seam = (Math.floor(across * 32) + (tread & 1) * 4) & 7;
                stop = step - tread >= 0.75 ? 6 : seam === 0 ? 1 : 3;
            }
            const edge = across < 0.15 || across > 0.85;
            const color = edge && h === 0 ? '#060402' : ART_RAMPS.ashlar[stop];
            art.pixel(x, y, color, 'stone', row ? SURFACE_FACE.right : SURFACE_FACE.up, h);
        }
    }
    return art;
}

function corner(variant) {
    const { width, height, anchor } = TERRACE_KIT_SPEC.corner;
    const art = spriteChannels(width, height);
    for (let x = 0; x < width; x++) {
        const dx = x + 0.5 - anchor[0];
        const lip = anchor[1] + Math.floor((variant === 'outer' ? -1 : 1) * Math.abs(dx) / 2);
        for (let row = 0; row < 8; row++) {
            const east = (dx > 0) === (variant === 'outer');
            const stop = wallCourseStop(x, row, 8, east);
            const color = row === 7 && Math.abs(dx) > 14 ? '#060402' : ART_RAMPS.ashlar[stop];
            art.pixel(x, lip + row, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, 8 - row);
        }
    }
    return art;
}

export const bakeTerraceStairPng = dir => stair(dir).png;
export const bakeTerraceCornerPng = variant => corner(variant).png;

export function buildAllTerraceKitPngs() {
    return [...TERRACE_KIT_SPEC.stair.directions.map(dir => ({ rel: 'prop.terraceStair.' + dir + '.png', anchor: TERRACE_ANCHORS.stair, ...stair(dir) })),
        ...TERRACE_KIT_SPEC.corner.variants.map(v => ({ rel: 'prop.terraceCorner.' + v + '.png', anchor: TERRACE_ANCHORS.corner, ...corner(v) }))];
}

export function writeSpriteChannels(outputs, args) {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Write deterministic albedo, material and occluder PNGs. Use --check to verify all three.');
        return;
    }
    for (const { rel, png, material, occluder } of outputs) {
        for (const [suffix, image] of [['', png], ['.material', material], ['.occluder', occluder]]) {
            const name = rel.replace(/\.png$/, suffix + '.png');
            const file = new URL('../../claudeville/assets/sprites/props/' + name, import.meta.url);
            const bytes = PNG.sync.write(image);
            if (args.includes('--check')) {
                if (!existsSync(file) || !readFileSync(file).equals(bytes)) throw Error('Stale or missing ' + name);
                console.log('ok: ' + name);
            } else writeFileSync(file, bytes);
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeSpriteChannels(buildAllTerraceKitPngs(), process.argv.slice(2));
