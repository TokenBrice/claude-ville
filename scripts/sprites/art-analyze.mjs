#!/usr/bin/env node
// Offline art analyzer & ratcheted CI gate (Opus 5.5 aesthetic plan, item 3.1 /
// contract C1 + Wave 0.4 Medium Contract OA-M1 & art-budget.json ratchet).
//
// Reads every manifest sprite and terrain PNG and reports, per asset:
//   colours   unique RGBA colours among visible pixels (> 400 = unquantized)
//   semiA     share of visible pixels with 0 < alpha < 255 (> 1% = AA edges)
//   sat       median HSV saturation of visible pixels; classes report the
//             median of their assets' medians
//   tierA     share of visible pixels in Tier A (luminance > 0.70, or HSV
//             S > 0.65 at V >= 0.50) outside the reserved roles: status
//             overlays, emissive layers/light sprites, and pixels lit in an
//             emissive sidecar. One-pixel speculars are normal, so an asset
//             is flagged only above 5% of its visible pixels.
//   offRamp   terrain only: share of pixels whose nearest stop of the sheet's
//             C1 ramps (ART_RAMPS) is further than dE_OK 0.04 in OKLab
//   edgeCont  terrain only (4x4 Wang sheets): share of shared Wang-neighbor
//             border texels within OKLab dE <= 0.03
//   grain     Medium Contract OA-M1 perceptual OKLab 4-neighbor mean ΔE edge
//             density per 32x32 opaque sample relative to building.tavern/base.png
//             (target [0.70, 1.30])
//   scale     manifest display scales that are not an integer multiple of
//             the source texel (displaySize / size, display* / width|height,
//             any numeric *scale* key)
//
// Advisory by default (exits 0). Pass `--gate` to enforce `art-budget.json`
// monotonically (exits 1 on any regression or over-budget new asset).
// Pass `--update-budget` to tighten `art-budget.json` monotonically (refuses to
// loosen any cap unless `--allow-loosen` is passed).
//
// Usage:
//   node scripts/sprites/art-analyze.mjs [--json] [--ids <id,prefix.*,...>] [--flagged]
//   node scripts/sprites/art-analyze.mjs --gate [--budget <path>] [--season <spring|summer|autumn|winter>] [--no-feet-audit]
//   node scripts/sprites/art-analyze.mjs --update-budget [--allow-loosen] [--budget <path>] [--no-feet-audit]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as artPalette from '../../claudeville/src/config/artPalette.js';
import {
    CANOPY_SEASONS,
    CANOPY_VARIANTS,
    TREE_SPRITES,
    canopyPlan,
    isCanopyPixel,
    recolorCanopy,
    shedCanopy,
} from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import { PHENOLOGY_STAGES } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import {
    collectSpriteEntries,
    expectedPathsForEntry,
    loadSpriteManifest,
    repoRoot,
    spritesRoot,
} from './manifest-utils.mjs';

const {
    ART_RAMPS,
    GROUND_RAMP_KEYS,
    GROUND_SATURATION,
    WATER_VOID_SATURATION_MAX,
} = artPalette;

// Reconciliation ruling X-7 (Opus 02 §1.1): OKLCH-verified per-season ground
// median saturation bands. Uses artPalette.GROUND_SATURATION_BY_SEASON once
// Wave 1/2 exports it, falling back to the locked X-7 bands today.
export const GROUND_SATURATION_BY_SEASON = Object.freeze(
    artPalette.GROUND_SATURATION_BY_SEASON || {
        spring: Object.freeze({ min: 0.48, max: 0.56 }),
        summer: Object.freeze({ min: 0.45, max: 0.50 }),
        autumn: Object.freeze({ min: 0.40, max: 0.50 }),
        winter: Object.freeze({ min: 0.22, max: 0.36 }),
    },
);

export const THRESHOLDS = Object.freeze({
    colours: 400,
    semiAlpha: 0.01,
    tierA: 0.05,
    tierALuminance: 0.70,
    tierASaturation: 0.65,
    tierASaturationMinValue: 0.50,
    offRampDistance: 0.04,
    offRamp: 0.10,
    terrainEdgeDeltaE: 0.03,
    terrainMinEdgeContinuity: 0.99,
    // Calibrated perceptual OKLab 4-neighbor mean ΔE threshold so Tavern sits
    // near ~0.38 edge density (~392 / 1024 interior px), leaving generous
    // headroom for noisy/checkerboard assets to exceed 1.30x (max ~2.61x).
    grainOklabDeltaE: 0.14,
    grainMinInteriorPixels: 64,
    grainRatioBand: Object.freeze([0.70, 1.30]),
});

export const DEFAULT_BUDGET_PATH = fileURLToPath(new URL('./art-budget.json', import.meta.url));
const TAVERN_BENCHMARK_PATH = join(spritesRoot, 'buildings', 'building.tavern', 'base.png');

// Every manifest art group; `luts` (data images, grading tables) is not art.
const ANALYZED_GROUPS = [
    'characters', 'equipment', 'accessories', 'statusOverlays', 'buildings',
    'props', 'vegetation', 'terrain', 'bridges', 'atmosphere',
];
const GRAIN_CHECKED_CLASSES = new Set(['props', 'vegetation', 'bridges', 'terrain']);
const SIDECAR_SUFFIX = /\.(material|emissive|occluder|surface|rooms)\.png$/;
// Whole-file emissive roles: authored light is allowed to be Tier A.
const EMISSIVE_MATERIALS = new Set(['fire', 'unlit']);
const EMISSIVE_GEOMETRIES = new Set(['authored-albedo', 'layer', 'light']);
const EMISSIVE_ID = /^atmosphere\.(light|sun|moon)\b/;
// Terrain id token -> C1 ramp key.
const TERRAIN_TOKEN_RAMPS = Object.freeze({
    grass: 'grass',
    dirt: 'dirt',
    cobble: 'road',
    square: 'plaza',
    shore: 'sand',
    shallow: 'shallowWater',
    deep: 'deepWater',
});
const WATER_RAMPS = new Set(['shallowWater', 'deepWater', 'void']);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = {
        json: false,
        flaggedOnly: false,
        ids: null,
        help: false,
        gate: false,
        updateBudget: false,
        allowLoosen: false,
        budgetPath: DEFAULT_BUDGET_PATH,
        season: 'summer',
        withFeetAudit: false,
        noFeetAudit: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') opts.json = true;
        else if (arg === '--flagged') opts.flaggedOnly = true;
        else if (arg === '--gate') opts.gate = true;
        else if (arg === '--update-budget') opts.updateBudget = true;
        else if (arg === '--allow-loosen') opts.allowLoosen = true;
        else if (arg === '--with-feet-audit') opts.withFeetAudit = true;
        else if (arg === '--no-feet-audit') opts.noFeetAudit = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--ids' || arg.startsWith('--ids=')) {
            const value = arg === '--ids' ? argv[++i] : arg.slice('--ids='.length);
            opts.ids = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
        } else if (arg === '--budget' || arg.startsWith('--budget=')) {
            const value = arg === '--budget' ? argv[++i] : arg.slice('--budget='.length);
            opts.budgetPath = resolve(process.cwd(), String(value || ''));
        } else if (arg === '--season' || arg.startsWith('--season=')) {
            const value = arg === '--season' ? argv[++i] : arg.slice('--season='.length);
            opts.season = String(value || 'summer').toLowerCase();
        } else {
            console.error(`[art-analyze] ignoring unknown argument: ${arg}`);
        }
    }
    return opts;
}

function idMatcher(patterns) {
    if (!patterns || patterns.length === 0) return () => true;
    const tests = patterns.map((pattern) => {
        if (!pattern.includes('*')) return (id) => id === pattern;
        const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return (id) => re.test(id);
    });
    return (id) => tests.some((test) => test(id));
}

// ------------------------------------------------------------------ colour

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(r, g, b) {
    return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
}

export function oklab(r, g, b) {
    const lr = SRGB_TO_LINEAR[r];
    const lg = SRGB_TO_LINEAR[g];
    const lb = SRGB_TO_LINEAR[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function hexToRgb(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RAMP_STOPS = Object.fromEntries(Object.entries(ART_RAMPS).map(([key, stops]) => [
    key,
    stops.map((hex) => oklab(...hexToRgb(hex))),
]));

// Snow stops (maintainer decision M9): achromatic snow may sit above the
// Tier-A value ceiling wherever it appears (ground snow, snow-laden pines).
const SNOW_STOP_SET = new Set(ART_RAMPS.snow.map((hex) => {
    const [r, g, b] = hexToRgb(hex);
    return (r << 16) | (g << 8) | b;
}));

function nearestStop(lab, rampKeys) {
    let best = Infinity;
    let bestKey = null;
    for (const key of rampKeys) {
        for (const stop of RAMP_STOPS[key] || []) {
            const d = Math.hypot(lab[0] - stop[0], lab[1] - stop[1], lab[2] - stop[2]);
            if (d < best) {
                best = d;
                bestKey = key;
            }
        }
    }
    return { distance: best, ramp: bestKey };
}

// ------------------------------------------------ grain & Wang continuity

/**
 * Medium Contract OA-M1 grain measurement: perceptual OKLab 4-neighbor mean
 * ΔE edge-texel density normalized per 32x32 opaque interior sample (1024
 * interior opaque texels). Calibrated at ΔE >= 0.14 so building.tavern/base.png
 * sits at ~392/1024 (~38.3%), leaving headroom up to ~2.61x so noisy or
 * checkerboard assets cleanly exceed the 1.30x upper bound.
 *
 * @param {{ width: number, height: number, data: Uint8Array|Buffer }} png
 * @param {number} [edgeThreshold]
 * @returns {{ edgePixels: number, interiorPixels: number, densityPer32x32: number|null }}
 */
export function measureGrainDensity(png, edgeThreshold = THRESHOLDS.grainOklabDeltaE) {
    const { width, height, data } = png;
    if (width < 3 || height < 3) {
        return { edgePixels: 0, interiorPixels: 0, densityPer32x32: null };
    }
    const count = width * height;
    const labL = new Float32Array(count);
    const labA = new Float32Array(count);
    const labB = new Float32Array(count);
    const opaque = new Uint8Array(count);
    const labCache = new Map();
    for (let p = 0, i = 0; p < count; p++, i += 4) {
        if (data[i + 3] >= 128) {
            opaque[p] = 1;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const key = (r << 16) | (g << 8) | b;
            let hit = labCache.get(key);
            if (!hit) {
                hit = oklab(r, g, b);
                if (labCache.size < 65536) labCache.set(key, hit);
            }
            labL[p] = hit[0];
            labA[p] = hit[1];
            labB[p] = hit[2];
        }
    }
    let interiorPixels = 0;
    let edgePixels = 0;
    const meanSumThreshold = edgeThreshold * 4;
    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        const rowUp = row - width;
        const rowDown = row + width;
        for (let x = 1; x < width - 1; x++) {
            const p = row + x;
            if (
                !opaque[p]
                || !opaque[p - 1] || !opaque[p + 1]
                || !opaque[rowUp + x] || !opaque[rowDown + x]
            ) {
                continue;
            }
            interiorPixels++;
            const lp = labL[p];
            const ap = labA[p];
            const bp = labB[p];
            const dL = Math.hypot(lp - labL[p - 1], ap - labA[p - 1], bp - labB[p - 1]);
            const dR = Math.hypot(lp - labL[p + 1], ap - labA[p + 1], bp - labB[p + 1]);
            const dU = Math.hypot(lp - labL[rowUp + x], ap - labA[rowUp + x], bp - labB[rowUp + x]);
            const dD = Math.hypot(lp - labL[rowDown + x], ap - labA[rowDown + x], bp - labB[rowDown + x]);
            if (dL + dR + dU + dD >= meanSumThreshold) edgePixels++;
        }
    }
    const densityPer32x32 = interiorPixels >= THRESHOLDS.grainMinInteriorPixels
        ? (edgePixels / interiorPixels) * 1024
        : null;
    return { edgePixels, interiorPixels, densityPer32x32 };
}

/**
 * Wang 4x4 terrain sheet edge-continuity check (Spec 03 §3.3).
 *
 * Each sheet is a 4x4 grid of square cells (`cell = width / 4`), indexed by
 * 4-bit edge mask (bit 0 = N, 1 = E, 2 = S, 3 = W; see TerrainTileset.js).
 * Measures the share of shared border texels across matching Wang-neighbor
 * pairs whose OKLab distance is <= `maxDeltaE` (default 0.03).
 *
 * @param {{ width: number, height: number, data: Uint8Array|Buffer }} png
 * @param {number} [maxDeltaE=0.03]
 * @returns {{ pairsChecked: number, borderTexels: number, continuousTexels: number, continuity: number|null, maxEdgeDeltaE: number }}
 */
export function measureWangEdgeContinuity(png, maxDeltaE = THRESHOLDS.terrainEdgeDeltaE) {
    const { width, height, data } = png;
    if (width !== height || width < 16 || width % 4 !== 0) {
        return { pairsChecked: 0, borderTexels: 0, continuousTexels: 0, continuity: null, maxEdgeDeltaE: 0 };
    }
    const cell = width / 4;
    const labCache = new Map();
    const labAt = (x, y) => {
        const i = (y * width + x) * 4;
        if (data[i + 3] === 0) return null;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        let hit = labCache.get(key);
        if (!hit) {
            hit = oklab(data[i], data[i + 1], data[i + 2]);
            labCache.set(key, hit);
        }
        return hit;
    };

    let pairsChecked = 0;
    let borderTexels = 0;
    let continuousTexels = 0;
    let maxObserved = 0;

    // Check matching horizontal (a.E === b.W) and vertical (a.S === b.N) Wang
    // neighbors for uniform edge cells (cells 0 and 15 self-tile and pair with
    // all matching-edge cells).
    for (let a = 0; a < 16; a++) {
        const ax = (a % 4) * cell;
        const ay = Math.floor(a / 4) * cell;
        const aE = (a >> 1) & 1;
        const aS = (a >> 2) & 1;
        for (let b = 0; b < 16; b++) {
            const bx = (b % 4) * cell;
            const by = Math.floor(b / 4) * cell;
            const bW = (b >> 3) & 1;
            const bN = b & 1;
            if (aE === bW) {
                pairsChecked++;
                for (let y = 0; y < cell; y++) {
                    const l1 = labAt(ax + cell - 1, ay + y);
                    const l2 = labAt(bx, by + y);
                    if (!l1 || !l2) continue;
                    borderTexels++;
                    const d = Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);
                    if (d > maxObserved) maxObserved = d;
                    if (d <= maxDeltaE) continuousTexels++;
                }
            }
            if (aS === bN) {
                pairsChecked++;
                for (let x = 0; x < cell; x++) {
                    const l1 = labAt(ax + x, ay + cell - 1);
                    const l2 = labAt(bx + x, by);
                    if (!l1 || !l2) continue;
                    borderTexels++;
                    const d = Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);
                    if (d > maxObserved) maxObserved = d;
                    if (d <= maxDeltaE) continuousTexels++;
                }
            }
        }
    }

    return {
        pairsChecked,
        borderTexels,
        continuousTexels,
        continuity: borderTexels > 0 ? continuousTexels / borderTexels : null,
        maxEdgeDeltaE: maxObserved,
    };
}

/**
 * Validate a Wave 5 `.surface.png` sidecar against an albedo PNG.
 * Contract (Spec 01 §1 & Spec 03 §3.3):
 *   - Identical dimensions to albedo PNG
 *   - Outside albedo alpha (albedo.a === 0): H16 === 0 and valid bit (A & 0x80) === 0
 *   - On valid pixels (A & 0x80): quantized normal index B in [0..63] (upper 2 bits zero)
 */
export function validateSurfaceSidecar(albedoPng, surfacePng) {
    const issues = [];
    if (albedoPng.width !== surfacePng.width || albedoPng.height !== surfacePng.height) {
        issues.push(`dimensions ${surfacePng.width}x${surfacePng.height} != ${albedoPng.width}x${albedoPng.height}`);
        return issues;
    }
    const count = albedoPng.width * albedoPng.height;
    let outsideAlphaHeight = 0;
    let invalidNormalId = 0;
    for (let p = 0, i = 0; p < count; p++, i += 4) {
        const albedoA = albedoPng.data[i + 3];
        const r = surfacePng.data[i];
        const g = surfacePng.data[i + 1];
        const b = surfacePng.data[i + 2];
        const a = surfacePng.data[i + 3];
        const h16 = r | (g << 8);
        if (albedoA === 0) {
            if (h16 !== 0 || (a & 0x80) !== 0) outsideAlphaHeight++;
        } else if ((a & 0x80) !== 0) {
            if (b > 63) invalidNormalId++;
        }
    }
    if (outsideAlphaHeight > 0) issues.push(`${outsideAlphaHeight} px have non-zero height/valid outside alpha`);
    if (invalidNormalId > 0) issues.push(`${invalidNormalId} valid px have normal index > 63`);
    return issues;
}

// ------------------------------------------------------------------- stats

const SAT_BINS = 256;

function newStats() {
    return {
        visible: 0,
        semi: 0,
        tierA: 0,
        exempt: 0,
        colours: new Set(),
        satHist: new Uint32Array(SAT_BINS),
        terrain: null,
        grainEdgePixels: 0,
        grainInteriorPixels: 0,
        surfaceIssues: [],
    };
}

function newTerrainStats() {
    return {
        pixels: 0,
        offRamp: 0,
        landHist: new Uint32Array(SAT_BINS),
        waterHist: new Uint32Array(SAT_BINS),
        land: 0,
        water: 0,
        rampHists: {},
        edgeContinuity: null,
        maxEdgeDeltaE: null,
    };
}

function histMedian(hist) {
    let total = 0;
    for (const n of hist) total += n;
    if (total === 0) return null;
    const half = total / 2;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
        acc += hist[i];
        if (acc >= half) return (i + 0.5) / hist.length;
    }
    return 1;
}

function median(values) {
    const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (list.length === 0) return null;
    const mid = list.length >> 1;
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function readPng(absPath) {
    return PNG.sync.read(readFileSync(absPath));
}

function emissiveMask(absPath, width, height) {
    const sidecar = absPath.replace(/\.png$/, '.emissive.png');
    if (!existsSync(sidecar)) return null;
    try {
        const png = readPng(sidecar);
        if (png.width !== width || png.height !== height) return null;
        const mask = new Uint8Array(width * height);
        const d = png.data;
        for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
            if (d[i + 3] > 0 && (d[i] | d[i + 1] | d[i + 2])) mask[p] = 1;
        }
        return mask;
    } catch {
        return null;
    }
}

function analyzeFile(stats, absPath, { exemptWholeFile, terrainRamps, measureGrain }) {
    const png = readPng(absPath);
    const { width, height, data } = png;
    const mask = exemptWholeFile ? null : emissiveMask(absPath, width, height);
    const terrainCache = terrainRamps ? new Map() : null;
    if (terrainRamps && !stats.terrain) stats.terrain = newTerrainStats();
    const lumLimit = THRESHOLDS.tierALuminance;
    const satLimit = THRESHOLDS.tierASaturation;
    const valFloor = THRESHOLDS.tierASaturationMinValue * 255;

    for (let p = 0, i = 0; p < width * height; p++, i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        stats.visible++;
        if (a < 255) stats.semi++;
        stats.colours.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const satBin = Math.min(SAT_BINS - 1, Math.floor(sat * SAT_BINS));
        stats.satHist[satBin]++;

        const hot = luminance(r, g, b) > lumLimit || (sat > satLimit && max >= valFloor);
        if (hot) {
            if (exemptWholeFile || (mask && mask[p]) || SNOW_STOP_SET.has((r << 16) | (g << 8) | b)) stats.exempt++;
            else stats.tierA++;
        }

        if (terrainCache) {
            const key = (r << 16) | (g << 8) | b;
            let hit = terrainCache.get(key);
            if (!hit) {
                hit = nearestStop(oklab(r, g, b), terrainRamps);
                terrainCache.set(key, hit);
            }
            const t = stats.terrain;
            t.pixels++;
            if (hit.distance > THRESHOLDS.offRampDistance) t.offRamp++;
            if (WATER_RAMPS.has(hit.ramp)) {
                t.water++;
                t.waterHist[satBin]++;
            } else {
                t.land++;
                t.landHist[satBin]++;
            }
            (t.rampHists[hit.ramp] ||= new Uint32Array(SAT_BINS))[satBin]++;
        }
    }

    if (measureGrain) {
        const g = measureGrainDensity(png);
        stats.grainEdgePixels += g.edgePixels;
        stats.grainInteriorPixels += g.interiorPixels;
    }

    if (terrainRamps && stats.terrain && stats.terrain.edgeContinuity === null) {
        const wang = measureWangEdgeContinuity(png);
        if (wang.continuity !== null) {
            stats.terrain.edgeContinuity = wang.continuity;
            stats.terrain.maxEdgeDeltaE = wang.maxEdgeDeltaE;
        }
    }

    const surfaceSidecar = absPath.replace(/\.png$/, '.surface.png');
    if (existsSync(surfaceSidecar)) {
        try {
            const surfacePng = readPng(surfaceSidecar);
            const issues = validateSurfaceSidecar(png, surfacePng);
            for (const issue of issues) stats.surfaceIssues.push(`${basename(surfaceSidecar)}: ${issue}`);
        } catch (err) {
            stats.surfaceIssues.push(`${basename(surfaceSidecar)}: ${err.message}`);
        }
    }

    return { width, height };
}

// --------------------------------------------------------------- manifest

function layerSpecFor(entry, relPath) {
    const file = basename(relPath, '.png');
    if (!relPath.startsWith(`buildings/${entry.id}/`)) return { name: 'base', spec: entry };
    if (/^base(-\d+-\d+)?$/.test(file)) return { name: 'base', spec: entry };
    const layers = entry.layers && !Array.isArray(entry.layers) ? entry.layers : {};
    return { name: file, spec: layers[file] || {} };
}

function isEmissiveRole(entry, spec) {
    if (EMISSIVE_ID.test(entry.id)) return true;
    if (EMISSIVE_MATERIALS.has(spec?.materialClass)) return true;
    const sources = spec?.emissive?.sources;
    if (Array.isArray(sources) && sources.some((src) => EMISSIVE_GEOMETRIES.has(src?.geometry))) {
        // Only when the light is the whole layer, not a sidecar-mapped patch.
        return spec !== entry || sources.every((src) => EMISSIVE_GEOMETRIES.has(src?.geometry));
    }
    return false;
}

function terrainRampsFor(id) {
    if (!id.startsWith('terrain.')) return null;
    const tokens = id.slice('terrain.'.length).split(/[-.]/);
    const ramps = [...new Set(tokens.map((t) => TERRAIN_TOKEN_RAMPS[t]).filter(Boolean))];
    return ramps.length > 0 ? ramps : [...GROUND_RAMP_KEYS];
}

function scaleIssues(entry) {
    const issues = [];
    const check = (label, spec) => {
        if (!spec || typeof spec !== 'object') return;
        const pairs = [
            ['displaySize', 'size'],
            ['displayWidth', 'width'],
            ['displayHeight', 'height'],
        ];
        for (const [display, source] of pairs) {
            const d = Number(spec[display]);
            const s = Number(spec[source]);
            if (!Number.isFinite(d) || !Number.isFinite(s) || s <= 0) continue;
            const ratio = d / s;
            if (!Number.isInteger(ratio) || ratio < 1) {
                issues.push(`${label}${display} ${d} / ${source} ${s} = ${+ratio.toFixed(3)}x`);
            }
        }
        for (const [key, value] of Object.entries(spec)) {
            if (!/scale/i.test(key) || typeof value !== 'number') continue;
            if (!Number.isInteger(value) || value < 1) issues.push(`${label}${key} ${value}`);
        }
    };
    check('', entry);
    if (entry.layers && !Array.isArray(entry.layers)) {
        for (const [name, spec] of Object.entries(entry.layers)) check(`${name}.`, spec);
    }
    return issues;
}

export function computeTavernGrainBenchmark() {
    if (!existsSync(TAVERN_BENCHMARK_PATH)) return null;
    const png = readPng(TAVERN_BENCHMARK_PATH);
    return measureGrainDensity(png).densityPer32x32;
}

function analyzeEntry(entry, group, tavernGrainDensity = null) {
    const stats = newStats();
    const files = [];
    const missing = [];
    const errors = [];
    const terrainRamps = terrainRampsFor(entry.id);
    const statusRole = group === 'statusOverlays';
    const measureGrain = GRAIN_CHECKED_CLASSES.has(group) || group === 'buildings';

    for (const relPath of expectedPathsForEntry(entry)) {
        if (SIDECAR_SUFFIX.test(relPath)) continue;
        const absPath = join(spritesRoot, relPath);
        if (!existsSync(absPath)) {
            missing.push(relPath);
            continue;
        }
        const { spec } = layerSpecFor(entry, relPath);
        const exemptWholeFile = statusRole || isEmissiveRole(entry, spec);
        try {
            analyzeFile(stats, absPath, { exemptWholeFile, terrainRamps, measureGrain });
            files.push(relPath);
        } catch (err) {
            errors.push(`${relPath}: ${err.message}`);
        }
    }

    const visible = stats.visible || 0;
    const grainDensity = stats.grainInteriorPixels >= THRESHOLDS.grainMinInteriorPixels
        ? (stats.grainEdgePixels / stats.grainInteriorPixels) * 1024
        : null;
    const grainRatio = grainDensity !== null && tavernGrainDensity
        ? grainDensity / tavernGrainDensity
        : null;

    const result = {
        id: entry.id,
        class: group,
        files,
        visiblePixels: visible,
        colours: stats.colours.size,
        semiAlpha: visible ? stats.semi / visible : 0,
        saturation: histMedian(stats.satHist),
        tierA: visible ? stats.tierA / visible : 0,
        tierAExempt: visible ? stats.exempt / visible : 0,
        offRamp: null,
        edgeContinuity: null,
        grainDensity,
        grainRatio,
        surfaceIssues: stats.surfaceIssues,
        terrain: null,
        scaleIssues: scaleIssues(entry),
        missing,
        errors,
        flags: [],
    };

    if (stats.terrain) {
        const t = stats.terrain;
        result.offRamp = t.pixels ? t.offRamp / t.pixels : 0;
        result.edgeContinuity = t.edgeContinuity;
        result.terrain = {
            ramps: terrainRamps,
            landShare: t.pixels ? t.land / t.pixels : 0,
            landSaturation: histMedian(t.landHist),
            waterShare: t.pixels ? t.water / t.pixels : 0,
            waterSaturation: histMedian(t.waterHist),
            edgeContinuity: t.edgeContinuity,
            maxEdgeDeltaE: t.maxEdgeDeltaE,
            landHist: t.landHist,
            rampHists: t.rampHists,
        };
    }

    if (files.length === 0) result.flags.push(errors.length ? 'unreadable' : 'no-png');
    if (result.colours > THRESHOLDS.colours) result.flags.push('colours');
    if (result.semiAlpha > THRESHOLDS.semiAlpha) result.flags.push('semi-alpha');
    if (result.tierA > THRESHOLDS.tierA) result.flags.push('tier-a');
    if (result.offRamp !== null && result.offRamp > THRESHOLDS.offRamp) result.flags.push('off-ramp');
    if (result.scaleIssues.length) result.flags.push('scale');
    if (result.surfaceIssues.length) result.flags.push('surface');
    // The D5 ground band applies to the ground as a whole (pooled in
    // summarize), not to one mixed sheet: a cobble sheet is meant to be grey.
    const water = result.terrain?.waterSaturation;
    if (water !== null && water !== undefined && result.terrain.waterShare > 0.05 && water > WATER_VOID_SATURATION_MAX) {
        result.flags.push('water-loud');
    }
    return result;
}

// ------------------------------------------------------------------ report

function pct(value, digits = 1) {
    if (value === null || value === undefined) return '-';
    return `${(value * 100).toFixed(digits)}%`;
}

function num(value, digits = 2) {
    if (value === null || value === undefined) return '-';
    return value.toFixed(digits);
}

function table(rows, columns) {
    const widths = columns.map((col) => Math.max(col.label.length, ...rows.map((row) => String(col.get(row)).length)));
    const line = (cells) => cells.map((cell, i) => (columns[i].right ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join('  ');
    const out = [line(columns.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w)))];
    for (const row of rows) out.push(line(columns.map((c) => c.get(row))));
    return out.join('\n');
}

function resolveGroundBand(season = 'summer') {
    const band = GROUND_SATURATION_BY_SEASON[season] || GROUND_SATURATION_BY_SEASON.summer || GROUND_SATURATION;
    return Array.isArray(band) ? { min: band[0], max: band[1] } : band;
}

function summarize(results, { season = 'summer', tavernGrainDensity = null } = {}) {
    const classes = {};
    for (const r of results) {
        const c = (classes[r.class] ||= { assets: 0, flagged: 0, colours: [], semi: [], sat: [], tierA: [] });
        c.assets++;
        if (r.flags.length) c.flagged++;
        if (!r.visiblePixels) continue;
        c.colours.push(r.colours);
        c.semi.push(r.semiAlpha);
        c.sat.push(r.saturation);
        c.tierA.push(r.tierA);
    }
    const out = {};
    for (const [name, c] of Object.entries(classes)) {
        out[name] = {
            assets: c.assets,
            flagged: c.flagged,
            medianColours: median(c.colours),
            medianSemiAlpha: median(c.semi),
            medianSaturation: median(c.sat),
            medianTierA: median(c.tierA),
        };
    }

    // Pooled ground: every land pixel of every terrain sheet in the run, plus
    // the same pixels binned by nearest ramp next to that ramp's own S.
    const pooled = new Uint32Array(SAT_BINS);
    const perRamp = {};
    let landPixels = 0;
    for (const r of results) {
        const hist = r.terrain?.landHist;
        if (!hist) continue;
        for (let i = 0; i < SAT_BINS; i++) {
            pooled[i] += hist[i];
            landPixels += hist[i];
        }
        for (const [ramp, rampHist] of Object.entries(r.terrain.rampHists)) {
            const into = (perRamp[ramp] ||= new Uint32Array(SAT_BINS));
            for (let i = 0; i < SAT_BINS; i++) into[i] += rampHist[i];
        }
    }
    const ramps = Object.entries(perRamp).map(([ramp, hist]) => ({
        ramp,
        water: WATER_RAMPS.has(ramp),
        pixels: hist.reduce((sum, n) => sum + n, 0),
        medianSaturation: histMedian(hist),
        rampSaturation: median((ART_RAMPS[ramp] || []).map(hexSaturation)),
    }));
    const band = resolveGroundBand(season);
    const ground = landPixels ? {
        season,
        landPixels,
        medianSaturation: histMedian(pooled),
        band,
        ramps,
    } : null;
    return { classes: out, ground, tavernGrainDensity };
}

function hexSaturation(hex) {
    const [r, g, b] = hexToRgb(hex);
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

// ------------------------------------------------ seasonal and canopy ramps

// Rules per plan 5.1/5.3 + Opus 02 §1.3 ramps. Optional future ramps are
// validated automatically as soon as they appear in ART_RAMPS.
const SEASONAL_RAMP_RULES = Object.freeze({
    snow: { maxSat: 0.2, topMaxSat: 0.12, tierAExempt: true },
    leafAutumn: {},
    canopyRusset: {},
    canopyOchre: {},
    willowGold: {},
    canopyScarlet: {},
    blossom: {},
    foliageDeep: { maxSat: 0.5, midHue: [90, 110] },
    foliageSun: { maxSat: 0.5, midHue: [90, 110] },
    // Opus 02 §1.3 (Wave 1/2 additions — enforced permanently once in ART_RAMPS)
    grassDormant: { maxSat: 0.36, midHue: [60, 75] },
    grassSpring: { maxSat: 0.60 },
    blossomIvory: {},
    leafMarcescent: { maxSat: 0.62 },
    cliff: { maxSat: 0.30 },
    tideline: { maxSat: 0.36 },
});

function hexHsv(hex) {
    const [r, g, b] = hexToRgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

function isTierAHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const { s, v } = hexHsv(hex);
    return luminance(r, g, b) > THRESHOLDS.tierALuminance
        || (s > THRESHOLDS.tierASaturation && v >= THRESHOLDS.tierASaturationMinValue);
}

function seasonalRampReport() {
    const out = [];
    for (const [key, rule] of Object.entries(SEASONAL_RAMP_RULES)) {
        const stops = ART_RAMPS[key] || [];
        if (!stops.length && rule.optionalUntilAdded) continue;
        const hsv = stops.map(hexHsv);
        const lum = stops.map((hex) => luminance(...hexToRgb(hex)));
        const flags = [];
        if (!stops.length) flags.push('missing');
        if (lum.some((l, i) => i > 0 && l <= lum[i - 1])) flags.push('not-dark-to-light');
        const tierA = stops.filter(isTierAHex);
        if (tierA.length && !rule.tierAExempt) flags.push('tier-a');
        const maxSat = Math.max(0, ...hsv.map((c) => c.s));
        if (rule.maxSat !== undefined && maxSat > rule.maxSat) flags.push('saturation');
        if (rule.topMaxSat !== undefined && hsv.length && hsv[hsv.length - 1].s > rule.topMaxSat) flags.push('top-saturation');
        const mid = stops.length >> 1;
        const midHue = stops.length ? (stops.length % 2 ? hsv[mid].h : (hsv[mid - 1].h + hsv[mid].h) / 2) : null;
        if (rule.midHue && !(midHue >= rule.midHue[0] && midHue <= rule.midHue[1])) flags.push('mid-hue');
        out.push({
            ramp: key,
            stops: stops.length,
            minSat: Math.min(1, ...hsv.map((c) => c.s)),
            maxSat,
            minLum: lum.length ? lum[0] : null,
            maxLum: lum.length ? lum[lum.length - 1] : null,
            midHue,
            tierAStops: tierA.length,
            flags,
        });
    }
    return out;
}

const packRgb = (r, g, b) => (r << 16) | (g << 8) | b;

function rampStopSet(key, stops = 0) {
    const hexes = ART_RAMPS[key] || [];
    return (stops ? hexes.slice(0, stops) : hexes).map((hex) => packRgb(...hexToRgb(hex)));
}

function canopyRemapReport() {
    return Object.entries(TREE_SPRITES).map(([key, sprite]) => {
        const absPath = join(spritesRoot, 'vegetation', `${sprite.id}.png`);
        if (!existsSync(absPath)) return { sprite: key, missing: true, plans: 0, shed: 0, canopy: 0, remapped: 0, authored: 0, offRamp: 0 };
        const png = readPng(absPath);
        const width = png.width;
        const height = Math.min(sprite.height, png.height);
        const source = Uint8ClampedArray.from(png.data.subarray(0, width * height * 4));
        const species = key.slice(0, key.indexOf('.'));
        const plans = new Set();
        const sheds = [];
        for (const season of sprite.canopy === false ? [] : CANOPY_SEASONS) {
            for (const variant of CANOPY_VARIANTS) {
                const plan = canopyPlan(species, variant, season);
                if (plan) plans.add(plan);
            }
        }
        for (const stage of sprite.canopy === false ? [] : PHENOLOGY_STAGES) {
            const share = stage.shed[species] || 0;
            for (const variant of CANOPY_VARIANTS) {
                const season = stage.season === 'spring' && !stage.blossom ? 'summer' : stage.season;
                const plan = canopyPlan(species, variant, season, season === 'autumn' ? stage.turned + share : 1);
                if (plan) plans.add(plan);
                if (sprite.bare && share > 0 && share < 1) sheds.push({ plan, share, salt: 11 + variant * 7 });
            }
        }
        const barePath = sprite.bare ? join(spritesRoot, 'vegetation', `${TREE_SPRITES[sprite.bare].id}.png`) : null;
        const bare = barePath && existsSync(barePath) ? Uint8ClampedArray.from(readPng(barePath).data.subarray(0, width * height * 4)) : null;
        const row = { sprite: key, missing: false, plans: plans.size, shed: bare ? sheds.length : 0, canopy: 0, remapped: 0, authored: 0, offRamp: 0 };
        const checks = [...[...plans].map((plan) => ({ plan, share: 0 })), ...(bare ? sheds : [])];
        const authoredColours = new Set();
        for (let i = 0; i < source.length; i += 4) {
            if (isCanopyPixel(source, i, Math.floor(i / 4 / width), height)) authoredColours.add(packRgb(source[i], source[i + 1], source[i + 2]));
        }
        for (const { plan, share, salt } of checks) {
            const data = Uint8ClampedArray.from(source);
            recolorCanopy(data, width, height, plan);
            if (share) shedCanopy(data, source, bare, width, height, share, salt);
            const allowed = new Set([
                ...(plan?.ramp ? rampStopSet(plan.ramp, plan.stops) : []),
                ...(plan?.turning ? rampStopSet(plan.turning) : []),
                ...(plan?.blossom ? rampStopSet(plan.blossom === 'ivory' ? 'blossomIvory' : 'blossom') : []),
            ]);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    const fallen = share && data[i] === bare[i] && data[i + 1] === bare[i + 1] && data[i + 2] === bare[i + 2] && data[i + 3] === bare[i + 3];
                    if (!isCanopyPixel(source, i, y, height)) {
                        if (share && !fallen && (data[i] !== source[i] || data[i + 1] !== source[i + 1] || data[i + 2] !== source[i + 2] || data[i + 3] !== source[i + 3])) row.offRamp++;
                        continue;
                    }
                    if (fallen) continue;
                    row.canopy++;
                    if (allowed.has(packRgb(data[i], data[i + 1], data[i + 2]))) row.remapped++;
                    else if (!plan?.ramp && data[i] === source[i] && data[i + 1] === source[i + 1] && data[i + 2] === source[i + 2]) row.authored++;
                    else if (!plan?.ramp && share && authoredColours.has(packRgb(data[i], data[i + 1], data[i + 2]))) row.authored++;
                    else row.offRamp++;
                }
            }
        }
        return row;
    });
}

// ------------------------------------------------------------ ratcheted gate

function roundUp(value, decimals = 4) {
    const scale = 10 ** decimals;
    return Math.ceil(value * scale - 1e-12) / scale;
}

function roundDown(value, decimals = 4) {
    const scale = 10 ** decimals;
    return Math.floor(value * scale + 1e-12) / scale;
}

export function loadArtBudget(budgetPath = DEFAULT_BUDGET_PATH) {
    if (!existsSync(budgetPath)) {
        throw new Error(`art-budget.json not found at ${budgetPath}`);
    }
    return JSON.parse(readFileSync(budgetPath, 'utf8'));
}

/**
 * Evaluate analyzed assets against `art-budget.json`.
 * Pure function so unit tests can inject synthetic regressions cleanly.
 */
export function evaluateGate(results, summary, budget, { season = 'summer' } = {}) {
    const rules = budget?.globalRules || {};
    const allowlist = budget?.legacyAllowlist || {};
    const violations = [];
    const maxColoursByClass = rules.maxColoursNewAsset || {};
    const defaultSemiAlpha = rules.maxSemiAlphaOutsideAtmosphere ?? 0.002;
    const defaultTierA = rules.maxTierAOutsideExempt ?? 0.05;
    const defaultMaxOffRamp = rules.terrainMinOnRampShare !== undefined
        ? roundUp(1 - rules.terrainMinOnRampShare, 4)
        : 0.03;
    const defaultMinEdgeContinuity = rules.terrainMinEdgeContinuity ?? 0.99;
    const grainBand = rules.mediumContractGrainRatioBand || [0.70, 1.30];

    for (const r of results) {
        const allow = allowlist[r.id] || null;
        if (r.missing.length) {
            violations.push({ id: r.id, rule: 'missing', message: `missing files: ${r.missing.join(', ')}` });
        }
        if (r.errors.length) {
            violations.push({ id: r.id, rule: 'errors', message: `unreadable files: ${r.errors.join(', ')}` });
        }
        if (r.scaleIssues.length) {
            violations.push({ id: r.id, rule: 'scale', message: `non-integer display scale: ${r.scaleIssues.join('; ')}` });
        }
        if (r.surfaceIssues?.length) {
            violations.push({ id: r.id, rule: 'surface', message: `surface sidecar invalid: ${r.surfaceIssues.join('; ')}` });
        }

        const classCap = maxColoursByClass[r.class] ?? THRESHOLDS.colours;
        const maxColours = allow?.maxColours ?? classCap;
        if (r.colours > maxColours) {
            violations.push({
                id: r.id,
                rule: 'maxColours',
                actual: r.colours,
                cap: maxColours,
                message: `colours ${r.colours} > cap ${maxColours}${allow ? ' (legacy cap regressed)' : ' (new asset cap)'}`,
            });
        }

        if (r.class !== 'atmosphere') {
            const maxSemi = allow?.maxSemiAlpha ?? defaultSemiAlpha;
            if (r.semiAlpha > maxSemi + 1e-9) {
                violations.push({
                    id: r.id,
                    rule: 'maxSemiAlpha',
                    actual: r.semiAlpha,
                    cap: maxSemi,
                    message: `semiAlpha ${pct(r.semiAlpha, 2)} > cap ${pct(maxSemi, 2)}`,
                });
            }
        }

        const maxTierA = allow?.maxTierA ?? defaultTierA;
        if (r.tierA > maxTierA + 1e-9) {
            violations.push({
                id: r.id,
                rule: 'maxTierA',
                actual: r.tierA,
                cap: maxTierA,
                message: `tierA ${pct(r.tierA, 2)} > cap ${pct(maxTierA, 2)}`,
            });
        }

        if (r.offRamp !== null) {
            const maxOffRamp = allow?.maxOffRamp ?? defaultMaxOffRamp;
            if (r.offRamp > maxOffRamp + 1e-9) {
                violations.push({
                    id: r.id,
                    rule: 'maxOffRamp',
                    actual: r.offRamp,
                    cap: maxOffRamp,
                    message: `terrain offRamp ${pct(r.offRamp, 2)} > cap ${pct(maxOffRamp, 2)}`,
                });
            }
        }

        if (r.edgeContinuity !== null && r.edgeContinuity !== undefined) {
            const minEdge = allow?.minEdgeContinuity ?? defaultMinEdgeContinuity;
            if (r.edgeContinuity + 1e-9 < minEdge) {
                violations.push({
                    id: r.id,
                    rule: 'minEdgeContinuity',
                    actual: r.edgeContinuity,
                    cap: minEdge,
                    message: `Wang edge continuity ${pct(r.edgeContinuity, 2)} < min ${pct(minEdge, 2)}`,
                });
            }
        }

        const waterSat = r.terrain?.waterSaturation;
        if (waterSat !== null && waterSat !== undefined && r.terrain.waterShare > 0.05) {
            const maxWaterSat = allow?.maxWaterSaturation ?? WATER_VOID_SATURATION_MAX;
            if (waterSat > maxWaterSat + 1e-9) {
                violations.push({
                    id: r.id,
                    rule: 'maxWaterSaturation',
                    actual: waterSat,
                    cap: maxWaterSat,
                    message: `water saturation ${num(waterSat, 4)} > cap ${num(maxWaterSat, 4)}`,
                });
            }
        }

        if (GRAIN_CHECKED_CLASSES.has(r.class) && r.grainRatio !== null && r.grainRatio !== undefined) {
            const minGrain = allow?.minGrainRatio ?? grainBand[0];
            const maxGrain = allow?.maxGrainRatio ?? grainBand[1];
            if (r.grainRatio + 1e-9 < minGrain || r.grainRatio > maxGrain + 1e-9) {
                violations.push({
                    id: r.id,
                    rule: 'grainRatio',
                    actual: r.grainRatio,
                    cap: [minGrain, maxGrain],
                    message: `Medium Contract grain ratio ${num(r.grainRatio, 3)} outside [${num(minGrain, 3)}, ${num(maxGrain, 3)}]`,
                });
            }
        }
    }

    // Seasonal ramp integrity
    for (const ramp of summary?.seasonalRamps || []) {
        if (ramp.flags.length) {
            violations.push({
                id: `ramp.${ramp.ramp}`,
                rule: 'seasonalRamp',
                message: `ramp ${ramp.ramp} flagged: ${ramp.flags.join(', ')}`,
            });
        }
    }

    // Canopy remap integrity (offRamp must be 0)
    for (const remap of summary?.canopyRemaps || []) {
        if (remap.missing || remap.offRamp > 0) {
            violations.push({
                id: `canopy.${remap.sprite}`,
                rule: 'canopyRemap',
                actual: remap.offRamp,
                cap: 0,
                message: remap.missing
                    ? `canopy sprite ${remap.sprite} missing`
                    : `canopy remap ${remap.sprite} has ${remap.offRamp} off-ramp pixels`,
            });
        }
    }

    // Seasonal ground saturation band (X-7)
    const seasonBands = budget?.groundSaturationBySeason || {};
    const fallbackBand = resolveGroundBand(season);
    const targetBand = seasonBands[season] || [fallbackBand.min, fallbackBand.max];
    if (summary?.ground && Number.isFinite(summary.ground.medianSaturation)) {
        const legacyBand = budget?.legacyPooledGroundSaturationBand?.[season];
        const effectiveMin = legacyBand ? legacyBand[0] : targetBand[0];
        const effectiveMax = legacyBand ? legacyBand[1] : targetBand[1];
        const s = summary.ground.medianSaturation;
        if (s + 1e-9 < effectiveMin || s > effectiveMax + 1e-9) {
            violations.push({
                id: `ground.${season}`,
                rule: 'groundSaturation',
                actual: s,
                cap: [effectiveMin, effectiveMax],
                message: `pooled ground median S ${num(s, 4)} outside [${num(effectiveMin, 4)}, ${num(effectiveMax, 4)}]`,
            });
        }
    }

    // Character strip V7 feet audit (non-empty frame failures in e,w,se,sw)
    const feetAudit = summary?.feetAudit;
    if (feetAudit && !feetAudit.skipped) {
        if (feetAudit.parseError || feetAudit.exitCode === 2) {
            violations.push({
                id: 'feet-audit',
                rule: 'feetAudit',
                message: `feet-audit execution failed (exit=${feetAudit.exitCode}${feetAudit.stderr ? `: ${feetAudit.stderr}` : ''})`,
            });
        } else {
            for (const [id, groups] of Object.entries(feetAudit.failingGroupsByCharacter || {})) {
                const allowedGroups = new Set(allowlist[id]?.legacyFeetAuditGroups || []);
                const unallowed = groups.filter((group) => !allowedGroups.has(group));
                if (unallowed.length > 0) {
                    const details = (feetAudit.detailsByCharacter?.[id] || [])
                        .filter((entry) => unallowed.includes(entry.group))
                        .map((entry) => entry.summary)
                        .join('; ');
                    violations.push({
                        id,
                        rule: 'feetAudit',
                        actual: unallowed,
                        cap: [...allowedGroups],
                        message: `feet-audit failed for group(s) [${unallowed.join(', ')}]${details ? ` (${details})` : ''}`,
                    });
                }
            }
        }
    }

    return {
        pass: violations.length === 0,
        assetsChecked: results.length,
        allowlistedCount: Object.keys(allowlist).length,
        violations,
    };
}

/**
 * Compute an updated `art-budget.json` object from analyzed results.
 * Strictly monotonic by default: caps may ONLY tighten (decrease upper bounds
 * or increase lower bounds). Throws if any asset would require loosening a cap
 * or adding a new allowlist entry unless `allowLoosen === true`.
 */
export function updateBudgetMonotonic(currentBudget, results, summary, { allowLoosen = false, season = 'summer' } = {}) {
    const next = JSON.parse(JSON.stringify(currentBudget));
    const rules = next.globalRules;
    const maxColoursByClass = rules.maxColoursNewAsset || {};
    const defaultSemiAlpha = rules.maxSemiAlphaOutsideAtmosphere ?? 0.002;
    const defaultTierA = rules.maxTierAOutsideExempt ?? 0.05;
    const defaultMaxOffRamp = roundUp(1 - (rules.terrainMinOnRampShare ?? 0.97), 4);
    const defaultMinEdge = rules.terrainMinEdgeContinuity ?? 0.99;
    const grainBand = rules.mediumContractGrainRatioBand || [0.70, 1.30];

    const prevAllow = currentBudget.legacyAllowlist || {};
    const nextAllow = {};
    const loosened = [];
    const tightened = [];

    const checkUpper = (id, key, actual, defaultCap, prevCap, decimals = 4) => {
        const rounded = decimals === 0 ? Math.ceil(actual) : roundUp(actual, decimals);
        if (actual <= defaultCap + 1e-9) {
            if (prevCap !== undefined) tightened.push(`${id}.${key}: removed (${prevCap} -> within global ${defaultCap})`);
            return undefined;
        }
        if (prevCap === undefined) {
            if (!allowLoosen) {
                loosened.push(`${id}.${key}: new violation (${rounded} > global ${defaultCap})`);
                return undefined;
            }
            return rounded;
        }
        if (rounded > prevCap + 1e-9) {
            if (!allowLoosen) {
                loosened.push(`${id}.${key}: regressed (${prevCap} -> ${rounded})`);
                return prevCap;
            }
            return rounded;
        }
        if (rounded < prevCap - 1e-9) {
            tightened.push(`${id}.${key}: tightened (${prevCap} -> ${rounded})`);
        }
        return Math.min(prevCap, rounded);
    };

    const checkLower = (id, key, actual, defaultMin, prevMin, decimals = 4) => {
        const rounded = roundDown(actual, decimals);
        if (actual + 1e-9 >= defaultMin) {
            if (prevMin !== undefined) tightened.push(`${id}.${key}: removed (${prevMin} -> within global ${defaultMin})`);
            return undefined;
        }
        if (prevMin === undefined) {
            if (!allowLoosen) {
                loosened.push(`${id}.${key}: new violation (${rounded} < global ${defaultMin})`);
                return undefined;
            }
            return rounded;
        }
        if (rounded + 1e-9 < prevMin) {
            if (!allowLoosen) {
                loosened.push(`${id}.${key}: regressed (${prevMin} -> ${rounded})`);
                return prevMin;
            }
            return rounded;
        }
        if (rounded > prevMin + 1e-9) {
            tightened.push(`${id}.${key}: tightened (${prevMin} -> ${rounded})`);
        }
        return Math.max(prevMin, rounded);
    };

    for (const r of results) {
        const prev = prevAllow[r.id];
        const entry = {};

        const classCap = maxColoursByClass[r.class] ?? THRESHOLDS.colours;
        const cCap = checkUpper(r.id, 'maxColours', r.colours, classCap, prev?.maxColours, 0);
        if (cCap !== undefined) entry.maxColours = cCap;

        if (r.class !== 'atmosphere') {
            const sCap = checkUpper(r.id, 'maxSemiAlpha', r.semiAlpha, defaultSemiAlpha, prev?.maxSemiAlpha, 4);
            if (sCap !== undefined) entry.maxSemiAlpha = sCap;
        }

        const tCap = checkUpper(r.id, 'maxTierA', r.tierA, defaultTierA, prev?.maxTierA, 4);
        if (tCap !== undefined) entry.maxTierA = tCap;

        if (r.offRamp !== null) {
            const oCap = checkUpper(r.id, 'maxOffRamp', r.offRamp, defaultMaxOffRamp, prev?.maxOffRamp, 4);
            if (oCap !== undefined) entry.maxOffRamp = oCap;
        }

        if (r.edgeContinuity !== null && r.edgeContinuity !== undefined) {
            const eMin = checkLower(r.id, 'minEdgeContinuity', r.edgeContinuity, defaultMinEdge, prev?.minEdgeContinuity, 4);
            if (eMin !== undefined) entry.minEdgeContinuity = eMin;
        }

        const waterSat = r.terrain?.waterSaturation;
        if (waterSat !== null && waterSat !== undefined && r.terrain.waterShare > 0.05) {
            const wCap = checkUpper(r.id, 'maxWaterSaturation', waterSat, WATER_VOID_SATURATION_MAX, prev?.maxWaterSaturation, 4);
            if (wCap !== undefined) entry.maxWaterSaturation = wCap;
        }

        if (GRAIN_CHECKED_CLASSES.has(r.class) && r.grainRatio !== null && r.grainRatio !== undefined) {
            const gMin = checkLower(r.id, 'minGrainRatio', r.grainRatio, grainBand[0], prev?.minGrainRatio, 4);
            const gMax = checkUpper(r.id, 'maxGrainRatio', r.grainRatio, grainBand[1], prev?.maxGrainRatio, 4);
            if (gMin !== undefined) entry.minGrainRatio = gMin;
            if (gMax !== undefined) entry.maxGrainRatio = gMax;
        }

        const feetAudit = summary?.feetAudit;
        if (r.class === 'characters' && feetAudit && !feetAudit.skipped && !feetAudit.parseError) {
            const measuredGroups = [...new Set(feetAudit.failingGroupsByCharacter?.[r.id] || [])].sort();
            const prevGroups = Array.isArray(prev?.legacyFeetAuditGroups) ? [...new Set(prev.legacyFeetAuditGroups)].sort() : [];
            const prevSet = new Set(prevGroups);
            const measuredSet = new Set(measuredGroups);
            const newlyFailing = measuredGroups.filter((g) => !prevSet.has(g));
            const fixedGroups = prevGroups.filter((g) => !measuredSet.has(g));
            if (newlyFailing.length > 0 && !allowLoosen) {
                loosened.push(`${r.id}.legacyFeetAuditGroups: new failing group(s) [${newlyFailing.join(', ')}]`);
            }
            if (fixedGroups.length > 0) {
                tightened.push(`${r.id}.legacyFeetAuditGroups: fixed [${fixedGroups.join(', ')}]`);
            }
            const keptGroups = allowLoosen ? measuredGroups : measuredGroups.filter((g) => prevSet.has(g));
            if (keptGroups.length > 0) entry.legacyFeetAuditGroups = keptGroups;
        } else if (Array.isArray(prev?.legacyFeetAuditGroups) && prev.legacyFeetAuditGroups.length > 0) {
            entry.legacyFeetAuditGroups = [...prev.legacyFeetAuditGroups].sort();
        }

        if (Object.keys(entry).length > 0) {
            entry.reason = prev?.reason || `pre-Wave-0 ${r.class} baseline; ratchet down on touch`;
            nextAllow[r.id] = entry;
        }
    }

    // Preserve any allowlisted entries for IDs not in a filtered subset (if any).
    const seen = new Set(results.map((r) => r.id));
    for (const [id, entry] of Object.entries(prevAllow)) {
        if (!seen.has(id)) nextAllow[id] = entry;
    }

    // Check pooled ground saturation band (refuse widening unless --allow-loosen)
    if (summary?.ground && Number.isFinite(summary.ground.medianSaturation)) {
        const s = summary.ground.medianSaturation;
        const fallbackBand = resolveGroundBand(season);
        const target = next.groundSaturationBySeason?.[season] || [fallbackBand.min, fallbackBand.max];
        if (s + 1e-9 < target[0] || s > target[1] + 1e-9) {
            const prevLegacy = currentBudget.legacyPooledGroundSaturationBand?.[season];
            const nextMin = roundDown(Math.min(s, target[0]), 4);
            const nextMax = roundUp(Math.max(s, target[1]), 4);
            if (!prevLegacy) {
                if (!allowLoosen) {
                    loosened.push(`legacyPooledGroundSaturationBand.${season}: new legacy band [${nextMin}, ${nextMax}] (measured ${num(s, 4)})`);
                } else {
                    next.legacyPooledGroundSaturationBand = {
                        ...(next.legacyPooledGroundSaturationBand || {}),
                        [season]: [nextMin, nextMax],
                    };
                }
            } else {
                const widenedMin = nextMin + 1e-9 < prevLegacy[0];
                const widenedMax = nextMax > prevLegacy[1] + 1e-9;
                if ((widenedMin || widenedMax) && !allowLoosen) {
                    loosened.push(`legacyPooledGroundSaturationBand.${season}: widened ([${prevLegacy[0]}, ${prevLegacy[1]}] -> [${nextMin}, ${nextMax}])`);
                } else {
                    const effectiveMin = allowLoosen ? nextMin : Math.max(prevLegacy[0], nextMin);
                    const effectiveMax = allowLoosen ? nextMax : Math.min(prevLegacy[1], nextMax);
                    if (effectiveMin > prevLegacy[0] + 1e-9 || effectiveMax < prevLegacy[1] - 1e-9) {
                        tightened.push(`legacyPooledGroundSaturationBand.${season}: tightened ([${prevLegacy[0]}, ${prevLegacy[1]}] -> [${effectiveMin}, ${effectiveMax}])`);
                    }
                    next.legacyPooledGroundSaturationBand = {
                        ...(next.legacyPooledGroundSaturationBand || {}),
                        [season]: [effectiveMin, effectiveMax],
                    };
                }
            }
        } else if (next.legacyPooledGroundSaturationBand?.[season]) {
            tightened.push(`legacyPooledGroundSaturationBand.${season}: removed (within target [${target[0]}, ${target[1]}])`);
            delete next.legacyPooledGroundSaturationBand[season];
            if (Object.keys(next.legacyPooledGroundSaturationBand).length === 0) {
                delete next.legacyPooledGroundSaturationBand;
            }
        }
    }

    if (loosened.length > 0 && !allowLoosen) {
        const err = new Error(`Refusing to loosen art-budget.json without --allow-loosen:\n  ${loosened.join('\n  ')}`);
        err.loosened = loosened;
        throw err;
    }

    if (Number.isFinite(summary?.tavernGrainDensity)) {
        next.tavernGrainBenchmark = {
            asset: 'buildings/building.tavern/base.png',
            metric: 'oklab-mean4-deltaE',
            threshold: THRESHOLDS.grainOklabDeltaE,
            densityPer32x32: Number(summary.tavernGrainDensity.toFixed(2)),
        };
    }

    // Sort keys deterministically so diffs stay minimal.
    next.legacyAllowlist = Object.fromEntries(
        Object.keys(nextAllow).sort().map((id) => [id, nextAllow[id]]),
    );

    return { budget: next, tightened, loosened };
}

function parseNonEmptyFeetFailures(parsed) {
    const failingGroupsByCharacter = {};
    const detailsByCharacter = {};
    for (const character of parsed?.characters || []) {
        const groups = new Set();
        const details = [];
        for (const strip of character.strips || []) {
            for (const group of strip.groups || []) {
                const reasons = [];
                for (const [dir, entry] of Object.entries(group.directions || {})) {
                    for (const frame of entry.frames || []) {
                        if (frame.empty || frame.pass !== false) continue;
                        const parts = [];
                        if (Math.abs(frame.dx) > (parsed.tolerance ?? 2) || Math.abs(frame.dy) > (parsed.tolerance ?? 2)) {
                            parts.push(`dx${frame.dx >= 0 ? '+' : ''}${frame.dx},dy${frame.dy >= 0 ? '+' : ''}${frame.dy}`);
                        }
                        if (frame.fragments?.length) parts.push(`fragment×${frame.fragments.length}`);
                        if (frame.clearancePass === false) parts.push(`clearance=${frame.rise}`);
                        if (frame.identityPass === false) parts.push('identity');
                        if (frame.flickerPass === false) parts.push('flicker');
                        reasons.push(`${dir}#${frame.frame ?? frame.index ?? '?'}(${parts.join(';') || 'fail'})`);
                    }
                }
                if (reasons.length > 0) {
                    groups.add(group.name);
                    details.push({ group: group.name, summary: `${group.name}: ${reasons.slice(0, 4).join(' ')}` });
                }
            }
        }
        if (groups.size > 0) {
            failingGroupsByCharacter[character.id] = [...groups].sort();
            detailsByCharacter[character.id] = details;
        }
    }
    return { failingGroupsByCharacter, detailsByCharacter };
}

export function runFeetAuditCheck(characterIds = null) {
    if (Array.isArray(characterIds) && characterIds.length === 0) {
        return {
            skipped: true,
            reason: 'no character ids in selection',
            exitCode: 0,
            parseError: false,
            failures: [],
            failingGroupsByCharacter: {},
            detailsByCharacter: {},
            stderr: '',
        };
    }
    const scriptPath = join(repoRoot, 'scripts', 'sprites', 'feet-audit.mjs');
    const args = [scriptPath, '--directions=e,w,se,sw', '--json'];
    if (Array.isArray(characterIds) && characterIds.length > 0) {
        args.push(`--ids=${characterIds.join(',')}`);
    }
    const run = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    let parsed = null;
    let parseError = false;
    try {
        parsed = JSON.parse(run.stdout || '');
    } catch {
        parsed = null;
        parseError = true;
    }
    const { failingGroupsByCharacter, detailsByCharacter } = parsed
        ? parseNonEmptyFeetFailures(parsed)
        : { failingGroupsByCharacter: {}, detailsByCharacter: {} };
    return {
        skipped: false,
        exitCode: run.status,
        parseError,
        charactersAudited: parsed?.characters?.length ?? 0,
        failures: parsed?.failures || [],
        failingGroupsByCharacter,
        detailsByCharacter,
        stderr: String(run.stderr || '').trim(),
    };
}

function printReport(results, summary, opts, gateResult = null) {
    const rows = opts.flaggedOnly ? results.filter((r) => r.flags.length) : results;
    const modeLabel = opts.gate ? 'GATE' : 'advisory; see artPalette.js for the rules';
    console.log(`ClaudeVille art analysis — ${results.length} assets (${modeLabel})\n`);
    if (!opts.gate || opts.flaggedOnly) {
        console.log(table(rows, [
            { label: 'id', get: (r) => r.id },
            { label: 'class', get: (r) => r.class },
            { label: 'colours', get: (r) => r.colours, right: true },
            { label: 'semiA', get: (r) => pct(r.semiAlpha), right: true },
            { label: 'sat', get: (r) => num(r.saturation), right: true },
            { label: 'tierA', get: (r) => pct(r.tierA), right: true },
            { label: 'offRamp', get: (r) => pct(r.offRamp), right: true },
            { label: 'grain', get: (r) => (r.grainRatio === null ? '-' : num(r.grainRatio)), right: true },
            { label: 'flags', get: (r) => r.flags.join(',') },
        ]));
    }

    const scaleRows = results.filter((r) => r.scaleIssues.length);
    if (scaleRows.length) {
        console.log('\nNon-integer display scales (manifest):');
        for (const r of scaleRows) console.log(`  ${r.id}: ${r.scaleIssues.join('; ')}`);
    }

    const terrainRows = results.filter((r) => r.terrain);
    if (terrainRows.length && !opts.gate) {
        const band = resolveGroundBand(opts.season);
        console.log(`\nTerrain vs C1 (season=${opts.season} ground band S ${band.min}-${band.max}, water S <= ${WATER_VOID_SATURATION_MAX}, off-ramp dE_OK > ${THRESHOLDS.offRampDistance}):`);
        console.log(table(terrainRows, [
            { label: 'id', get: (r) => r.id },
            { label: 'ramps', get: (r) => r.terrain.ramps.join('+') },
            { label: 'land', get: (r) => pct(r.terrain.landShare, 0), right: true },
            { label: 'landS', get: (r) => num(r.terrain.landSaturation), right: true },
            { label: 'water', get: (r) => pct(r.terrain.waterShare, 0), right: true },
            { label: 'waterS', get: (r) => num(r.terrain.waterSaturation), right: true },
            { label: 'offRamp', get: (r) => pct(r.offRamp), right: true },
            { label: 'edgeCont', get: (r) => pct(r.edgeContinuity), right: true },
        ]));
        if (summary.ground) {
            const s = summary.ground.medianSaturation;
            const verdict = s > band.max ? 'above band (too loud)' : s < band.min ? 'below band (too grey)' : 'inside band';
            console.log(`\n  Pooled ground median S ${num(s)} over ${summary.ground.landPixels} land sheet pixels: ${verdict}.`);
            console.log('  All terrain pixels by nearest C1 ramp (measured S vs the ramp\'s own median S):');
            console.log(table(summary.ground.ramps, [
                { label: '  ramp', get: (g) => `  ${g.ramp}` },
                { label: 'pixels', get: (g) => g.pixels, right: true },
                { label: 'S', get: (g) => num(g.medianSaturation), right: true },
                { label: 'rampS', get: (g) => num(g.rampSaturation), right: true },
            ]));
        }
    }

    if (summary.seasonalRamps && !opts.gate) {
        console.log('\nSeasonal and canopy ramps (plan 5.1/5.3; dark -> light, no Tier A except snow, foliageDeep/Sun S <= 0.50 and mid hue 90-110):');
        console.log(table(summary.seasonalRamps, [
            { label: 'ramp', get: (r) => r.ramp },
            { label: 'stops', get: (r) => r.stops, right: true },
            { label: 'S', get: (r) => `${num(r.minSat)}-${num(r.maxSat)}`, right: true },
            { label: 'L', get: (r) => `${num(r.minLum)}-${num(r.maxLum)}`, right: true },
            { label: 'midHue', get: (r) => (r.midHue === null ? '-' : Math.round(r.midHue)), right: true },
            { label: 'tierA', get: (r) => r.tierAStops, right: true },
            { label: 'flags', get: (r) => r.flags.join(',') },
        ]));
    }
    if (summary.canopyRemaps && !opts.gate) {
        console.log('\nTree canopy remaps (FoliageRenderer, every variant, season and BI-2 stage, shed crowns included; offRamp must be 0):');
        console.log(table(summary.canopyRemaps, [
            { label: 'sprite', get: (r) => r.sprite },
            { label: 'plans', get: (r) => (r.missing ? 'missing' : r.plans), right: true },
            { label: 'shed', get: (r) => r.shed, right: true },
            { label: 'canopy px', get: (r) => r.canopy, right: true },
            { label: 'on-ramp', get: (r) => r.remapped, right: true },
            { label: 'authored', get: (r) => r.authored, right: true },
            { label: 'offRamp', get: (r) => r.offRamp, right: true },
        ]));
    }

    if (!opts.gate) {
        console.log('\nBy class (medians of per-asset values):');
        const classRows = Object.entries(summary.classes).map(([name, c]) => ({ name, ...c }));
        console.log(table(classRows, [
            { label: 'class', get: (c) => c.name },
            { label: 'assets', get: (c) => c.assets, right: true },
            { label: 'flagged', get: (c) => c.flagged, right: true },
            { label: 'colours', get: (c) => (c.medianColours ?? '-'), right: true },
            { label: 'semiA', get: (c) => pct(c.medianSemiAlpha), right: true },
            { label: 'sat', get: (c) => num(c.medianSaturation), right: true },
            { label: 'tierA', get: (c) => pct(c.medianTierA), right: true },
        ]));
    }

    const problems = results.filter((r) => r.missing.length || r.errors.length);
    if (problems.length) {
        console.log('\nUnread files:');
        for (const r of problems) {
            for (const m of r.missing) console.log(`  ${r.id}: missing ${m}`);
            for (const e of r.errors) console.log(`  ${r.id}: ${e}`);
        }
    }

    const flagged = results.filter((r) => r.flags.length).length;
    if (gateResult) {
        if (summary.tavernGrainDensity) {
            console.log(`Tavern 32x32 OKLab grain benchmark (mean4 dE >= ${THRESHOLDS.grainOklabDeltaE}): ${num(summary.tavernGrainDensity, 1)} edge px / 1024 interior px`);
        }
        if (summary.feetAudit && !summary.feetAudit.skipped) {
            console.log(`Feet audit (e,w,se,sw): ${summary.feetAudit.charactersAudited} character(s) checked (${Object.keys(summary.feetAudit.failingGroupsByCharacter || {}).length} with ratcheted legacy failures).`);
        }
        console.log(`Checked ${gateResult.assetsChecked} assets (${gateResult.allowlistedCount} ratcheted legacy allowlist entries, ${flagged} advisory flags).`);
        if (gateResult.pass) {
            console.log('[art:gate] PASS — zero budget regressions or new-asset violations.');
        } else {
            console.error(`[art:gate] FAIL — ${gateResult.violations.length} violation(s):`);
            for (const v of gateResult.violations) {
                console.error(`  - ${v.id} [${v.rule}]: ${v.message}`);
            }
        }
    } else {
        console.log(`\n${flagged} of ${results.length} assets flagged. Flags: colours > ${THRESHOLDS.colours}; semi-alpha > ${pct(THRESHOLDS.semiAlpha, 0)}; tier-a > ${pct(THRESHOLDS.tierA, 0)} of visible pixels outside status/emissive roles; off-ramp > ${pct(THRESHOLDS.offRamp, 0)}; water-loud = water pixels above S ${WATER_VOID_SATURATION_MAX}; scale = non-integer manifest display scale.`);
    }
}

function toJson(results, summary, gateResult = null) {
    return {
        generatedAt: new Date().toISOString(),
        thresholds: THRESHOLDS,
        groundBand: GROUND_SATURATION,
        groundSaturationBySeason: GROUND_SATURATION_BY_SEASON,
        waterSaturationMax: WATER_VOID_SATURATION_MAX,
        summary,
        gate: gateResult,
        assets: results.map((r) => ({
            ...r,
            terrain: r.terrain ? { ...r.terrain, landHist: undefined, rampHists: undefined } : null,
        })),
    };
}

export function runArtAnalysis(opts = {}) {
    const matches = idMatcher(opts.ids || null);
    const manifest = loadSpriteManifest();
    const tavernGrainDensity = computeTavernGrainBenchmark();
    const results = [];
    for (const group of ANALYZED_GROUPS) {
        for (const entry of collectSpriteEntries(manifest, [group])) {
            if (!entry?.id || !matches(entry.id)) continue;
            results.push(analyzeEntry(entry, group, tavernGrainDensity));
        }
    }
    const summary = summarize(results, { season: opts.season || 'summer', tavernGrainDensity });
    if (!opts.ids || Object.values(TREE_SPRITES).some((sprite) => matches(sprite.id))) {
        summary.seasonalRamps = seasonalRampReport();
        summary.canopyRemaps = canopyRemapReport();
    }
    return { results, summary };
}

// -------------------------------------------------------------------- main

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/sprites/art-analyze.mjs [--json] [--ids <id,prefix.*,...>] [--flagged] [--gate] [--budget <path>] [--season <spring|summer|autumn|winter>] [--update-budget [--allow-loosen]] [--with-feet-audit|--no-feet-audit]');
        return;
    }

    const { results, summary } = runArtAnalysis(opts);
    if (opts.ids && results.length === 0) {
        console.error(`[art-analyze] no manifest ids match: ${opts.ids.join(', ')}`);
    }

    const selectedCharacterIds = opts.ids
        ? results.filter((r) => r.class === 'characters').map((r) => r.id)
        : null;

    if (opts.updateBudget) {
        const currentBudget = existsSync(opts.budgetPath)
            ? loadArtBudget(opts.budgetPath)
            : {
                schemaVersion: 1,
                globalRules: {
                    maxColoursNewAsset: {
                        characters: 64,
                        equipment: 48,
                        accessories: 48,
                        statusOverlays: 48,
                        buildings: 96,
                        props: 48,
                        vegetation: 32,
                        terrain: 64,
                        bridges: 64,
                        atmosphere: 64,
                    },
                    maxSemiAlphaOutsideAtmosphere: 0.002,
                    maxTierAOutsideExempt: 0.05,
                    terrainMinOnRampShare: 0.97,
                    terrainMaxEdgeDeltaE: 0.03,
                    terrainMinEdgeContinuity: 0.99,
                    mediumContractGrainRatioBand: [0.70, 1.30],
                    styleDistanceSigmaCap: 2.0,
                    feetAuditRequired: true,
                    feetAuditInvocation: 'node scripts/sprites/feet-audit.mjs --ids=<id> --directions=e,w,se,sw',
                },
                groundSaturationBySeason: Object.fromEntries(
                    Object.entries(GROUND_SATURATION_BY_SEASON).map(([k, v]) => [k, [v.min, v.max]]),
                ),
                legacyAllowlist: {},
            };
        const shouldRunFeet = opts.withFeetAudit || (currentBudget.globalRules?.feetAuditRequired === true && !opts.noFeetAudit);
        if (shouldRunFeet) {
            summary.feetAudit = runFeetAuditCheck(selectedCharacterIds);
        }
        const { budget: nextBudget, tightened } = updateBudgetMonotonic(currentBudget, results, summary, {
            allowLoosen: opts.allowLoosen,
            season: opts.season,
        });
        writeFileSync(opts.budgetPath, `${JSON.stringify(nextBudget, null, 2)}\n`);
        console.log(`[art-analyze] updated ${opts.budgetPath} (${Object.keys(nextBudget.legacyAllowlist).length} allowlisted entries, ${tightened.length} tightened).`);
        return;
    }

    let gateResult = null;
    if (opts.gate) {
        const budget = loadArtBudget(opts.budgetPath);
        const shouldRunFeet = opts.withFeetAudit || (budget.globalRules?.feetAuditRequired === true && !opts.noFeetAudit);
        if (shouldRunFeet) {
            summary.feetAudit = runFeetAuditCheck(selectedCharacterIds);
        }
        gateResult = evaluateGate(results, summary, budget, { season: opts.season });
        if (summary.feetAudit) gateResult.feetAudit = summary.feetAudit;
    }

    if (opts.json) {
        console.log(JSON.stringify(toJson(results, summary, gateResult), null, 2));
    } else {
        printReport(results, summary, opts, gateResult);
    }

    if (opts.gate && !gateResult.pass) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (err) {
        const isGate = process.argv.includes('--gate') || process.argv.includes('--update-budget');
        console.error(`[art-analyze] ${isGate ? 'gate' : 'advisory'} run failed: ${err?.stack || err}`);
        process.exitCode = isGate ? 1 : 0;
    }
}
