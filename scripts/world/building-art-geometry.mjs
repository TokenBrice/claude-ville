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

function pct(value) {
    return `${Math.round(value * 100)}%`;
}

function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}

// Plan 6.1 frame-strip parts: a manifest building layer with `frames` is a
// horizontal strip of `frames` cells of `frameW x frameH`, bottom-centre
// anchored at `anchor` in base-local texels (as `_drawManifestLayers` draws
// it). `restIsBase` promises frame 0 is exactly the base art under it.
export function validateFrameStripParts(reporter, { entries, spritesRoot }) {
    for (const entry of entries) {
        const id = String(entry?.id || '');
        if (!id.startsWith('building.') || !entry.layers || Array.isArray(entry.layers)) continue;
        let base;
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base' || !layer || layer.frames === undefined) continue;
            const path = `manifest.${id}.layers.${name}`;
            const { frames, frameW, frameH, fps, staticFrame, gate } = layer;
            if (!isPositiveInt(frames) || !isPositiveInt(frameW) || !isPositiveInt(frameH)) {
                reporter.error(path, '`frames`, `frameW` and `frameH` must be positive integers');
                continue;
            }
            if (!(Number(fps) >= PART_FPS_RANGE[0] && Number(fps) <= PART_FPS_RANGE[1])) {
                reporter.error(path, `\`fps\` must be ${PART_FPS_RANGE[0]}-${PART_FPS_RANGE[1]} (stepped, not smooth)`);
            }
            if (!Number.isInteger(staticFrame) || staticFrame < 0 || staticFrame >= frames) {
                reporter.error(path, '`staticFrame` must index a frame of the strip (the gated-off and reduced-motion frame)');
            }
            if (typeof gate !== 'string' || !gate.trim()) {
                reporter.error(path, '`gate` must name a BuildingPartGates gate (real work via isWorkingVisitor, or an ambient cycle)');
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
