#!/usr/bin/env node
// Plan 6.3 (BL-3) — per-building room masks, baked in Wave 2 for 2.4 aperture
// lights, 2.9 water columns and 6.3's per-room window gate.
//
// Writes `buildings/building.<type>/base.rooms.png` (same size as base.png):
//   R = room index 1..N on the room's glass texels, 0 = not a room
//   G = B = 0, A = 255 where R > 0, else transparent
// Manifest opt-in: `roomsSidecar: true` on the building entry.
//
// Glass = the building's `base.emissive.png` alpha after the same 1-texel
// morphological closing the building validator uses (bridges mullions), split
// into 4-connected components. Room numbering follows the registry:
//   - buildings with `rooms.slots`: room k+1 is the component under slot k
//     (glass-centre `windowRectBounds`); other glass stays 0;
//   - otherwise every component under a `windowRects` entry is a room,
//     numbered by first reference; a component shared by two rects is one
//     room. Fire, crystal, lantern-body and door-spill emission that no rect
//     names stays 0 (the building-level gate).
// A room component that two different slots claim is an error.
//
// Usage:
//   node scripts/sprites/bake-room-masks.mjs           # write masks
//   node scripts/sprites/bake-room-masks.mjs --check   # verify on-disk masks
//   node scripts/sprites/bake-room-masks.mjs --ids=archive,command

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
    BUILDING_VISUAL_REGISTRY,
    windowRectBounds,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { closedAlphaMask } from '../world/building-art-geometry.mjs';
import { spritesRoot } from './manifest-utils.mjs';

// The rects that define a building's rooms, in slot order.
export function roomRectsFor(visual) {
    const slots = visual?.rooms?.slots || [];
    return slots.length ? slots : (visual?.windowRects || []);
}

// Rect slots that are panes of one lamp or window split by a solid post: they
// light together as one room. Task board: each end lantern has two panes.
export const ROOM_PANE_GROUPS = Object.freeze({
    taskboard: [[0, 1], [2, 3]],
});

function groupLeader(type, slot) {
    const group = (ROOM_PANE_GROUPS[type] || []).find((members) => members.includes(slot));
    return group ? group[0] : slot;
}

// 4-connected components of a closed glass mask: Int32Array labels (0 = none).
export function glassComponents({ mask, width, height }) {
    const labels = new Int32Array(width * height);
    let next = 0;
    const stack = [];
    for (let start = 0; start < width * height; start++) {
        if (!mask[start] || labels[start]) continue;
        next++;
        labels[start] = next;
        stack.push(start);
        while (stack.length) {
            const p = stack.pop();
            const x = p % width;
            const y = (p - x) / width;
            const neighbours = [
                x > 0 ? p - 1 : -1,
                x < width - 1 ? p + 1 : -1,
                y > 0 ? p - width : -1,
                y < height - 1 ? p + width : -1,
            ];
            for (const q of neighbours) {
                if (q < 0 || !mask[q] || labels[q]) continue;
                labels[q] = next;
                stack.push(q);
            }
        }
    }
    return { labels, count: next };
}

function dominantComponent(labels, width, height, bounds) {
    const counts = new Map();
    for (let y = bounds.top; y < bounds.top + bounds.h; y++) {
        for (let x = bounds.left; x < bounds.left + bounds.w; x++) {
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const label = labels[y * width + x];
            if (label) counts.set(label, (counts.get(label) || 0) + 1);
        }
    }
    let best = 0;
    let bestCount = 0;
    for (const [label, count] of counts) {
        if (count > bestCount) {
            best = label;
            bestCount = count;
        }
    }
    return best;
}

// Returns { png, rooms: [{ index, rects: [slot indices], texels }], errors }.
export function bakeRoomMask({ type, visual, emissive, albedo }) {
    const { width, height } = emissive;
    const closed = closedAlphaMask(emissive);
    const { labels } = glassComponents(closed);
    const rects = roomRectsFor(visual);
    const roomOfComponent = new Map();
    const rooms = [];
    const errors = [];
    const roomOfSlot = new Map();
    rects.forEach((rect, slot) => {
        const component = dominantComponent(labels, width, height, windowRectBounds(rect));
        if (!component) {
            errors.push(`${type}: rect ${slot} at [${rect.at}] covers no emissive glass`);
            return;
        }
        let index = roomOfComponent.get(component) ?? roomOfSlot.get(groupLeader(type, slot));
        if (index === undefined) {
            index = rooms.length + 1;
            rooms.push({ index, rects: [slot], texels: 0 });
        } else {
            rooms[index - 1].rects.push(slot);
        }
        roomOfComponent.set(component, index);
        roomOfSlot.set(slot, index);
    });
    if (visual?.rooms?.slots?.length) {
        for (const room of rooms) {
            if (room.rects.length > 1) {
                errors.push(`${type}: rooms.slots ${room.rects.join(' and ')} share one glass component`);
            }
        }
    }
    const png = new PNG({ width, height, colorType: 6 });
    for (let p = 0; p < width * height; p++) {
        const index = roomOfComponent.get(labels[p]);
        if (!index || albedo.data[p * 4 + 3] === 0) continue;
        png.data[p * 4] = index;
        png.data[p * 4 + 3] = 255;
        rooms[index - 1].texels++;
    }
    return { png, rooms, errors };
}

function main() {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const idsArg = args.find((arg) => arg.startsWith('--ids='));
    const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').filter(Boolean)) : null;
    let failures = 0;
    for (const [type, visual] of Object.entries(BUILDING_VISUAL_REGISTRY)) {
        if (onlyIds && !onlyIds.has(type)) continue;
        const dir = join(spritesRoot, 'buildings', `building.${type}`);
        const emissivePath = join(dir, 'base.emissive.png');
        if (!existsSync(emissivePath) || !roomRectsFor(visual).length) continue;
        const emissive = PNG.sync.read(readFileSync(emissivePath));
        const albedo = PNG.sync.read(readFileSync(join(dir, 'base.png')));
        const { png, rooms, errors } = bakeRoomMask({ type, visual, emissive, albedo });
        for (const error of errors) console.error(`[rooms] ${error}`);
        failures += errors.length;
        const maskPath = join(dir, 'base.rooms.png');
        const summary = rooms.map((room) => `${room.index}:${room.texels}px[${room.rects.join(',')}]`).join(' ');
        if (checkOnly) {
            const current = existsSync(maskPath) ? PNG.sync.read(readFileSync(maskPath)) : null;
            if (!current || Buffer.compare(current.data, png.data) !== 0) {
                console.error(`[rooms] STALE ${type}: base.rooms.png differs from the bake`);
                failures++;
            }
            continue;
        }
        writeFileSync(maskPath, PNG.sync.write(png, { colorType: 6 }));
        console.log(`[rooms] ${type}: ${rooms.length} room(s) ${summary}`);
    }
    if (checkOnly) console.log(failures ? `[rooms] ${failures} problem(s)` : '[rooms] all room masks current');
    process.exit(failures ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
