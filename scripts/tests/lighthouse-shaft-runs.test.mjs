import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { getBuildingEffectAnchor } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { BEAM_NEAR_HALF_WIDTH } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

// FP-7: the lighthouse shaft paints runs of texels, not single texels. Its
// pixels must be exactly those of the per-texel loop it replaced, kept below
// verbatim as the reference (the same anchors and landing share).
const FIRE = getBuildingEffectAnchor('watchtower', 'lanternFire', { flame: [200, 68], light: [200, 66], particle: [200, 66] });
const SEARCHLIGHT = getBuildingEffectAnchor('watchtower', 'searchlight', { pivot: [200, 68], length: 520, width: 96 });
const SEARCHLIGHT_LENGTH = SEARCHLIGHT.length || 320;
const SEARCHLIGHT_LANDING_SHARE = 0.35;

function referenceShaft(ctx, beacon, angle) {
    const distance = SEARCHLIGHT_LENGTH * SEARCHLIGHT_LANDING_SHARE;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const foot = FIRE.foot || SEARCHLIGHT.pivot;
    const height = foot[1] - FIRE.flame[1];
    const dx = Math.round(foot[0] - FIRE.flame[0] + c * distance);
    const dy = Math.round(height + s * distance * 0.5);
    const length = Math.hypot(dx, dy);
    const nx = -s;
    const ny = c * 0.5;
    const determinant = dx * ny - dy * nx;
    if (Math.abs(determinant) < 1) return;
    const spreadX = Math.abs(nx) * BEAM_NEAR_HALF_WIDTH + 2;
    const spreadY = Math.abs(ny) * BEAM_NEAR_HALF_WIDTH + 2;
    const minX = Math.floor(Math.min(0, dx) - spreadX);
    const maxX = Math.ceil(Math.max(0, dx) + spreadX);
    const minY = Math.floor(Math.min(0, dy) - spreadY);
    const maxY = Math.ceil(Math.max(0, dy) + spreadY);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const ox = Math.round(beacon.x);
    const oy = Math.round(beacon.y);
    const tower = beacon.tower?.mask && beacon.tower?.dims ? beacon.tower : null;
    const axisY = (FIRE.axis || foot)[1] - FIRE.flame[1];
    const hides = (wx, wy, t) => {
        if (!tower) return false;
        const lx = wx - tower.x;
        const ly = wy - tower.y;
        if (lx < 0 || ly < 0 || lx >= tower.dims.w || ly >= tower.dims.h) return false;
        const i = ly * tower.dims.w + lx;
        if (tower.mask[i] !== 1) return false;
        if (!tower.heights) return true;
        return wy - oy + tower.heights[i] > axisY + t * s * distance * 0.5 + 1;
    };
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const t = (px * ny - py * nx) / determinant;
            if (t < 6 / length || t >= 1) continue;
            if (hides(ox + x, oy + y, t)) continue;
            const width = 4 + (BEAM_NEAR_HALF_WIDTH - 4) * t;
            const across = Math.abs((dx * py - dy * px) / determinant);
            const coverage = Math.max(0, Math.min(1, (width - across) / 3))
                * (t < 0.78 ? 1 : t < 0.87 ? 0.75 : t < 0.94 ? 0.5 : 0.25);
            const order = (bayer[((oy + y) & 3) * 4 + ((ox + x) & 3)] + 0.5) / 16;
            if (coverage <= order) continue;
            const course = t < 0.3 ? 0 : t < 0.65 ? 1 : 2;
            ctx.globalAlpha = course === 0 ? 0.4 : course === 1 ? 0.27 : 0.16;
            ctx.fillStyle = ART_RAMPS.beaconFire[course === 0 ? 5 : 4];
            ctx.fillRect(ox + x, oy + y, 1, 1);
        }
    }
}

// A 2D context that rasterizes axis-aligned rects into a texel map, the way
// source-over paints whole texels at an integer world scale.
function recordingContext() {
    const pixels = new Map();
    const stats = { rects: 0, overlaps: 0 };
    return {
        pixels,
        stats,
        globalAlpha: 1,
        fillStyle: '#000000',
        fillRect(x, y, w, h) {
            assert.ok(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0,
                `whole-texel rect expected: ${x},${y} ${w}x${h}`);
            stats.rects += 1;
            for (let row = y; row < y + h; row++) {
                for (let column = x; column < x + w; column++) {
                    const key = `${column},${row}`;
                    if (pixels.has(key)) stats.overlaps += 1;
                    pixels.set(key, `${this.globalAlpha}|${this.fillStyle}`);
                }
            }
        },
    };
}

function syntheticTower(beacon, { heights }) {
    const dims = { w: 288, h: 340 };
    const x = beacon.x - 200;
    const y = beacon.y - 68;
    const mask = new Uint8Array(dims.w * dims.h);
    const surface = heights ? new Float32Array(dims.w * dims.h) : null;
    for (let ly = 0; ly < dims.h; ly++) {
        for (let lx = 0; lx < dims.w; lx++) {
            const i = ly * dims.w + lx;
            // A tower column, a gallery band and a cottage block.
            mask[i] = (Math.abs(lx - 200) < 26 && ly > 20) || (ly > 60 && ly < 74 && Math.abs(lx - 200) < 40) || (lx > 40 && lx < 150 && ly > 230) ? 1 : 0;
            if (surface) surface[i] = (ly * 7 + lx * 3) % 90;
        }
    }
    return { mask, heights: surface, dims, x, y };
}

test('run-length shaft paints exactly the per-texel pixels at every heading and tower state', () => {
    let referenceRects = 0;
    let runRects = 0;
    let painted = 0;
    for (const [bx, by] of [[1000, 1000], [1003, 998], [1001, 1002], [997, 1005]]) {
        for (const tower of [null, 'mask', 'heights']) {
            const beacon = { x: bx, y: by };
            if (tower) beacon.tower = syntheticTower(beacon, { heights: tower === 'heights' });
            for (let step = 0; step < 72; step++) {
                const angle = -0.4 + step * (Math.PI + 0.8) / 71;
                const reference = recordingContext();
                referenceShaft(reference, beacon, angle);
                const runs = recordingContext();
                BuildingSprite.prototype._fillBeaconShaft.call({}, runs, beacon, angle);
                assert.equal(runs.stats.overlaps, 0, 'runs never paint a texel twice');
                assert.equal(runs.pixels.size, reference.pixels.size, `texel count at ${angle}`);
                for (const [key, paint] of reference.pixels) {
                    assert.equal(runs.pixels.get(key), paint, `texel ${key} at ${angle} (${tower || 'no tower'})`);
                }
                referenceRects += reference.stats.rects;
                runRects += runs.stats.rects;
                painted += reference.pixels.size;
            }
        }
    }
    assert.ok(painted > 100_000, `the cases paint real shafts (${painted} texels)`);
    assert.ok(runRects * 2 < referenceRects, `runs cut the fills (${runRects} vs ${referenceRects})`);
});
