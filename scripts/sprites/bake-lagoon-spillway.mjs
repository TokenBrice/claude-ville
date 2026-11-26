#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { ART_RAMPS as ramps } from '../../claudeville/src/config/artPalette.js';
import { TERRACE_ANCHORS, wallCourseStop } from '../../claudeville/src/presentation/character-mode/TerraceWallPattern.js';
import { spillContact, VILLAGE_SURFACES } from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';
import { SURFACE_FACE } from './bake-surface-channel.mjs';
import { spriteChannels, writeSpriteChannels } from './bake-terrace-kit.mjs';

export const SPILLWAY_SPEC = { frames: 4, frameWidth: 64, frameHeight: 96, width: 256, height: 96, anchor: TERRACE_ANCHORS.spill, fps: 6 };

function spillway() {
    const art = spriteChannels(SPILLWAY_SPEC.width, SPILLWAY_SPEC.height);
    const { lip, pool } = spillContact(VILLAGE_SURFACES.spills[0], VILLAGE_SURFACES);
    const head = pool.y - lip.y;
    const [cx, cy] = TERRACE_ANCHORS.spill;
    for (let f = 0; f < 4; f++) for (let dx = -16; dx < 16; dx++) {
        const x = f * 64 + cx + dx;
        const foot = cy - Math.floor((dx + 1) / 2);
        const cheek = dx < -9 || dx >= 9;
        for (let h = 0; h <= head; h++) {
            const row = head - h;
            const ribbon = (dx * dx + dx + row - f * 3 + 42) % 13;
            const stone = ramps.ashlar[wallCourseStop(dx + pool.x, row, head + 1, true)];
            let color = cheek ? stone : ramps.shallowWater[ribbon < 3 ? 2 : 0];
            if (!cheek && (row === 0 || h === 0)) color = (dx + f) % 5 === 0 ? ramps.snow[3] : ramps.shallowWater[2];
            if (!cheek && h > 0 && row > 0 && ribbon > 8) color = ramps.deepWater[1];
            art.pixel(x, foot - h, color, cheek ? 'stone' : 'water', SURFACE_FACE.right, h);
        }
        if (cheek) {
            art.pixel(x, foot - head - 1, ramps.ashlar[5], 'stone', SURFACE_FACE.up, head);
        } else {
            for (let y = 1; y <= 3; y++) {
                if (y === 3 && ((dx + f) & 3) === 0) continue;
                art.pixel(x + y, foot + y, ramps.shallowWater[(dx + f + y + 18) % 3], 'water', SURFACE_FACE.up, 0);
            }
        }
    }
    return art;
}

export const bakeLagoonSpillwayPng = () => spillway().png;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    writeSpriteChannels([{ rel: 'prop.lagoonSpillway.png', ...spillway() }], process.argv.slice(2));
}
