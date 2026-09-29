// Art-geometry checks for `npm run world:validate-buildings` (plan 0.8 BL-6):
// registry window and room rects must sit on the emissive sidecar's glass, and
// manifest frame-strip parts (plan 6.1) must be well-formed strips whose rest
// frame is the base art when they say so. Pure functions over decoded PNGs so
// a probe can run them against any registry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { windowRectBounds } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';

export const WINDOW_SIDECAR_MIN_COVERAGE = 0.6;
export const PART_FPS_RANGE = Object.freeze([4, 8]);

function readPng(path) {
    return existsSync(path) ? PNG.sync.read(readFileSync(path)) : null;
}

// Glass sidecars stripe their panes (lit every other column), so raw alpha
// under-scores a rect that sits squarely on the glass. A 1-texel morphological
// closing (3x3 dilate, then 3x3 erode) bridges the one-texel mullion gaps
// without growing the glass outline.
export function closedAlphaMask(png) {
    const { width: W, height: H, data } = png;
    const raw = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) raw[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    // One 3x3 pass: dilation turns a texel on when any neighbour is on;
    // erosion keeps it on only when every neighbour is on.
    const pass = (source, dilate) => {
        const out = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let any = false;
                let all = true;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        const on = nx >= 0 && ny >= 0 && nx < W && ny < H && source[ny * W + nx] === 1;
                        any ||= on;
                        all &&= on;
                    }
                }
                out[y * W + x] = (dilate ? any : all) ? 1 : 0;
            }
        }
        return out;
    };
    return { mask: pass(pass(raw, true), false), width: W, height: H };
}

export function maskCoverage({ mask, width, height }, { left, top, w, h }) {
    let hit = 0;
    for (let y = top; y < top + h; y++) {
        for (let x = left; x < left + w; x++) {
            if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x]) hit++;
        }
    }
    return w * h > 0 ? hit / (w * h) : 0;
}

// Every registry `windowRects` entry and `rooms.slots` pane must cover
// >= 60 % closed sidecar alpha under the glass-centre `at` convention.
// Buildings without a `base.emissive.png` have no authored glass to measure.
export function validateWindowGeometry(reporter, { registry, spritesRoot }) {
    for (const [type, visual] of Object.entries(registry)) {
        const groups = [
            ['windowRects', visual?.windowRects || []],
            ['rooms.slots', visual?.rooms?.slots || []],
        ];
        if (!groups.some(([, rects]) => rects.length)) continue;
        const sidecar = readPng(join(spritesRoot, 'buildings', `building.${type}`, 'base.emissive.png'));
        if (!sidecar) continue;
        const closed = closedAlphaMask(sidecar);
        for (const [label, rects] of groups) {
            rects.forEach((rect, index) => {
                const path = `registry.${type}.${label}[${index}]`;
                if (!Array.isArray(rect?.at) || !rect.at.every(Number.isFinite)) {
                    reporter.error(path, '`at` must be a finite [x, y] glass centre');
                    return;
                }
                const bounds = windowRectBounds(rect);
                if (bounds.left < 0 || bounds.top < 0
                    || bounds.left + bounds.w > sidecar.width || bounds.top + bounds.h > sidecar.height) {
                    reporter.error(path, `rect ${bounds.w}x${bounds.h} at centre [${rect.at}] leaves the ${sidecar.width}x${sidecar.height} sprite`);
                    return;
                }
                const coverage = maskCoverage(closed, bounds);
                if (coverage >= WINDOW_SIDECAR_MIN_COVERAGE) return;
                const cornerCoverage = maskCoverage(closed, { left: rect.at[0], top: rect.at[1], w: bounds.w, h: bounds.h });
                const hint = cornerCoverage >= WINDOW_SIDECAR_MIN_COVERAGE
                    ? `; it scores ${pct(cornerCoverage)} read as a top-left corner — \`at\` is the glass centre`
                    : '';
                reporter.error(path, `covers ${pct(coverage)} emissive-sidecar glass (closed mask), needs >= ${pct(WINDOW_SIDECAR_MIN_COVERAGE)}${hint}`);
            });
        }
    }
}

// Plan 6.3 room masks (`base.rooms.png`, R = room index, baked by
// scripts/sprites/bake-room-masks.mjs). A building's rooms are its registry
// `rooms.slots`, else its `windowRects`. Each room rect must sit >= 60 % on a
// single mask room (glass-centre convention); with `rooms.slots`, slot k is
// room k + 1; room indices run 1..N with every room named by a rect; mask
// texels stay on the closed emissive glass. Buildings without an emissive
// sidecar have no glass to segment and carry no mask.
export function validateRoomMasks(reporter, { registry, spritesRoot }) {
    for (const [type, visual] of Object.entries(registry)) {
        const slots = visual?.rooms?.slots || [];
        const rects = slots.length ? slots : (visual?.windowRects || []);
        if (!rects.length) continue;
        const dir = join(spritesRoot, 'buildings', `building.${type}`);
        const sidecar = readPng(join(dir, 'base.emissive.png'));
        if (!sidecar) continue;
        const path = `buildings/building.${type}/base.rooms.png`;
        const mask = readPng(join(dir, 'base.rooms.png'));
        if (!mask) {
            reporter.error(path, 'missing: run `node scripts/sprites/bake-room-masks.mjs`');
            continue;
        }
        if (mask.width !== sidecar.width || mask.height !== sidecar.height) {
            reporter.error(path, `is ${mask.width}x${mask.height}, the emissive sidecar is ${sidecar.width}x${sidecar.height}`);
            continue;
        }
        const glass = closedAlphaMask(sidecar).mask;
        const present = new Set();
        let offGlass = 0;
        for (let p = 0; p < mask.width * mask.height; p++) {
            if (!mask.data[p * 4 + 3]) continue;
            const index = mask.data[p * 4];
            if (!index) offGlass++;
            else present.add(index);
            if (!glass[p]) offGlass++;
        }
        if (offGlass) reporter.error(path, `${offGlass} mask texel(s) are off the emissive glass or carry room 0`);
        const named = new Set();
        rects.forEach((rect, slot) => {
            const label = `registry.${type}.${slots.length ? 'rooms.slots' : 'windowRects'}[${slot}]`;
            if (!Array.isArray(rect?.at) || !rect.at.every(Number.isFinite)) return;
            const { left, top, w, h } = windowRectBounds(rect);
            const counts = new Map();
            for (let y = top; y < top + h; y++) {
                for (let x = left; x < left + w; x++) {
                    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;
                    const i = (y * mask.width + x) * 4;
                    if (mask.data[i + 3] && mask.data[i]) counts.set(mask.data[i], (counts.get(mask.data[i]) || 0) + 1);
                }
            }
            const [index, hits] = [...counts].sort((a, b) => b[1] - a[1])[0] || [0, 0];
            const coverage = w * h ? hits / (w * h) : 0;
            if (coverage < WINDOW_SIDECAR_MIN_COVERAGE) {
                reporter.error(label, `covers ${pct(coverage)} of one room in ${path}, needs >= ${pct(WINDOW_SIDECAR_MIN_COVERAGE)}`);
                return;
            }
            if (slots.length && index !== slot + 1) {
                reporter.error(label, `sits on mask room ${index}; rooms.slots[${slot}] must be room ${slot + 1}`);
            }
            named.add(index);
        });
        const max = present.size ? Math.max(...present) : 0;
        for (let index = 1; index <= max; index++) {
            if (!present.has(index)) reporter.error(path, `room indices must run 1..${max}; room ${index} has no texels`);
            else if (!named.has(index)) reporter.error(path, `room ${index} is named by no registry rect`);
        }
    }
}

function pct(value) {
    return `${Math.round(value * 100)}%`;
}

function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}

// Plan 6.1 frame-strip parts: a manifest building layer with `frames` is a
// horizontal strip of `frames` cells of `frameW x frameH`, bottom-centre
// anchored at `anchor` in base-local texels (as `partDrawsFor` draws
// it). `restIsBase` promises frame 0 is exactly the base art under it. A
// 6.7 `dressing: true` layer is a static strip (one frame per earned tier):
// no clock and no work gate, so only its strip geometry is checked. A layer
// with `cycle` is an EmitterCycle mask (V4): its gate, its slow-band rate
// and a mask the size of its art (base.png, or the `cycle.art` layer) that
// covers authored texels.
export function validateFrameStripParts(reporter, { entries, spritesRoot }) {
    for (const entry of entries) {
        const id = String(entry?.id || '');
        if (!id.startsWith('building.') || !entry.layers || Array.isArray(entry.layers)) continue;
        let base;
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base' || !layer) continue;
            if (layer.cycle) {
                validateEmitterCycle(reporter, { id, name, layer, entry, spritesRoot });
                continue;
            }
            if (layer.frames === undefined) continue;
            const path = `manifest.${id}.layers.${name}`;
            const { frames, frameW, frameH, fps, staticFrame, gate } = layer;
            if (!isPositiveInt(frames) || !isPositiveInt(frameW) || !isPositiveInt(frameH)) {
                reporter.error(path, '`frames`, `frameW` and `frameH` must be positive integers');
                continue;
            }
            if (layer.dressing !== true) {
                if (!(Number(fps) >= PART_FPS_RANGE[0] && Number(fps) <= PART_FPS_RANGE[1])) {
                    reporter.error(path, `\`fps\` must be ${PART_FPS_RANGE[0]}-${PART_FPS_RANGE[1]} (stepped, not smooth)`);
                }
                if (!Number.isInteger(staticFrame) || staticFrame < 0 || staticFrame >= frames) {
                    reporter.error(path, '`staticFrame` must index a frame of the strip (the gated-off and reduced-motion frame)');
                }
                if (typeof gate !== 'string' || !/^((work|door)\.[a-z]+|room\.[a-z]+\.\d+)$/.test(gate.trim())) {
                    reporter.error(path, '`gate` must name a BuildingPartGates gate (`work.<type>`, `door.<type>` or `room.<type>.<k>`, real work via isWorkingVisitor)');
                }
            }
            if (!Array.isArray(layer.anchor) || !layer.anchor.every(Number.isFinite)) {
                reporter.error(path, '`anchor` must be the base-local bottom-centre [x, y]');
                continue;
            }
            const strip = readPng(join(spritesRoot, 'buildings', id, `${name}.png`));
            if (!strip) {
                reporter.error(path, `strip buildings/${id}/${name}.png is missing`);
                continue;
            }
            if (strip.width !== frames * frameW || strip.height !== frameH) {
                reporter.error(path, `strip is ${strip.width}x${strip.height}, expected frames x frameW = ${frames * frameW}x${frameH}`);
                continue;
            }
            if (layer.restIsBase !== true) continue;
            base ??= readPng(join(spritesRoot, 'buildings', id, 'base.png'));
            if (!base) {
                reporter.error(path, '`restIsBase` needs base.png to compare against');
                continue;
            }
            const left = Math.round(layer.anchor[0] - frameW / 2);
            const top = Math.round(layer.anchor[1] - frameH);
            const mismatch = firstStripMismatch(strip, base, left, top, frameW, frameH);
            if (mismatch) {
                reporter.error(path, `\`restIsBase\` but frame 0 differs from the base crop at base [${mismatch}]`);
            }
        }
    }
}

const CYCLE_MAX_HZ = 8;

function validateEmitterCycle(reporter, { id, name, layer, entry, spritesRoot }) {
    const path = `manifest.${id}.layers.${name}.cycle`;
    const { gate, hz = 8, frames = 8, art, mode = 'wave' } = layer.cycle;
    if (typeof gate !== 'string' || !/^(lamps|work\.[a-z]+)$/.test(gate.trim())) {
        reporter.error(path, '`gate` must be `lamps` (lampsLitAt) or `work.<type>` (real work via isWorkingVisitor)');
    }
    if (!(Number(hz) > 0 && Number(hz) <= CYCLE_MAX_HZ)) {
        reporter.error(path, `\`hz\` must be in (0, ${CYCLE_MAX_HZ}] (the V4 slow band)`);
    }
    if (!isPositiveInt(frames)) reporter.error(path, '`frames` must be a positive integer');
    if (mode !== 'wave' && mode !== 'tongues') {
        reporter.error(path, `\`mode\` must be \`wave\` (a rank wave) or \`tongues\` (a tongue climb) (got "${mode}")`);
    }
    if (art !== undefined) {
        const artLayer = entry.layers[art];
        if (!artLayer || artLayer.cycle || artLayer.frames !== undefined || !Array.isArray(artLayer.anchor)) {
            reporter.error(path, `\`art\` must name a static overlay layer of ${id} (got "${art}")`);
            return;
        }
    }
    const artPng = readPng(join(spritesRoot, 'buildings', id, `${art ?? 'base'}.png`));
    const mask = readPng(join(spritesRoot, 'buildings', id, `${name}.png`));
    if (!artPng || !mask) {
        reporter.error(path, `needs buildings/${id}/${name}.png and its art ${art ?? 'base'}.png`);
        return;
    }
    if (mask.width !== artPng.width || mask.height !== artPng.height) {
        reporter.error(path, `mask is ${mask.width}x${mask.height}, its art is ${artPng.width}x${artPng.height}`);
        return;
    }
    let covered = 0;
    for (let i = 3; i < mask.data.length; i += 4) {
        if (mask.data[i] > 0 && artPng.data[i] > 0) covered++;
    }
    if (!covered) reporter.error(path, 'mask covers no authored texel of its art');
}

function firstStripMismatch(strip, base, left, top, frameW, frameH) {
    for (let y = 0; y < frameH; y++) {
        for (let x = 0; x < frameW; x++) {
            const bx = left + x;
            const by = top + y;
            const inside = bx >= 0 && by >= 0 && bx < base.width && by < base.height;
            const s = (y * strip.width + x) * 4;
            const b = (by * base.width + bx) * 4;
            for (let c = 0; c < 4; c++) {
                const baseValue = inside ? base.data[b + c] : 0;
                // Fully transparent texels match regardless of their RGB.
                if (c < 3 && strip.data[s + 3] === 0 && (!inside || base.data[b + 3] === 0)) break;
                if (strip.data[s + c] !== baseValue) return `${bx}, ${by}`;
            }
        }
    }
    return null;
}
