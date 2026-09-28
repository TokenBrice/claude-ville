#!/usr/bin/env node
// Offline art analyzer (Opus 5.5 aesthetic plan, item 3.1 / contract C1).
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
//   scale     manifest display scales that are not an integer multiple of
//             the source texel (displaySize / size, display* / width|height,
//             any numeric *scale* key)
// Terrain pixels are also binned by their nearest ramp: water sheets are
// checked against WATER_VOID_SATURATION_MAX, and the pooled land pixels of the
// run against the D5 ground band (GROUND_SATURATION), with a per-ramp
// breakdown (measured S vs the ramp's own S). Pooling counts sheet pixels, not
// on-screen coverage.
//
// Seasonal and canopy ramps (plan 5.1/5.3): each ramp the tree canopies and
// the baked leaf litter use is checked against its rules (dark -> light by
// luminance, no Tier A except snow's M9 winter exception, foliageDeep /
// foliageSun at S <= 0.50 with a mid hue of 90-110 deg), and every tree sheet
// is run through FoliageRenderer's own canopy remap for every variant and
// season: every remapped canopy pixel must be a stop of the plan's ramps
// (`offRamp` 0).
//
// Advisory only: always exits 0. Runs next to `npm run sprites:audit-refresh`.
//
// Usage:
//   node scripts/sprites/art-analyze.mjs [--json] [--ids <id,prefix.*,...>] [--flagged]

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import {
    ART_RAMPS,
    GROUND_RAMP_KEYS,
    GROUND_SATURATION,
    WATER_VOID_SATURATION_MAX,
} from '../../claudeville/src/config/artPalette.js';
import {
    CANOPY_SEASONS,
    CANOPY_VARIANTS,
    TREE_SPRITES,
    canopyPlan,
    isCanopyPixel,
    recolorCanopy,
} from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import {
    collectSpriteEntries,
    expectedPathsForEntry,
    loadSpriteManifest,
    spritesRoot,
} from './manifest-utils.mjs';

const THRESHOLDS = Object.freeze({
    colours: 400,
    semiAlpha: 0.01,
    tierA: 0.05,
    tierALuminance: 0.70,
    tierASaturation: 0.65,
    tierASaturationMinValue: 0.50,
    offRampDistance: 0.04,
    offRamp: 0.10,
});

// Every manifest art group; `luts` (data images, grading tables) is not art.
const ANALYZED_GROUPS = [
    'characters', 'equipment', 'accessories', 'statusOverlays', 'buildings',
    'props', 'vegetation', 'terrain', 'bridges', 'atmosphere',
];
const SIDECAR_SUFFIX = /\.(material|emissive|occluder)\.png$/;
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
    const opts = { json: false, flaggedOnly: false, ids: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') opts.json = true;
        else if (arg === '--flagged') opts.flaggedOnly = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--ids' || arg.startsWith('--ids=')) {
            const value = arg === '--ids' ? argv[++i] : arg.slice('--ids='.length);
            opts.ids = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
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

function luminance(r, g, b) {
    return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
}

function oklab(r, g, b) {
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

function analyzeFile(stats, absPath, { exemptWholeFile, terrainRamps }) {
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
            if (exemptWholeFile || (mask && mask[p])) stats.exempt++;
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

function analyzeEntry(entry, group) {
    const stats = newStats();
    const files = [];
    const missing = [];
    const errors = [];
    const terrainRamps = terrainRampsFor(entry.id);
    const statusRole = group === 'statusOverlays';

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
            analyzeFile(stats, absPath, { exemptWholeFile, terrainRamps });
            files.push(relPath);
        } catch (err) {
            errors.push(`${relPath}: ${err.message}`);
        }
    }

    const visible = stats.visible || 0;
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
        terrain: null,
        scaleIssues: scaleIssues(entry),
        missing,
        errors,
        flags: [],
    };

    if (stats.terrain) {
        const t = stats.terrain;
        result.offRamp = t.pixels ? t.offRamp / t.pixels : 0;
        result.terrain = {
            ramps: terrainRamps,
            landShare: t.pixels ? t.land / t.pixels : 0,
            landSaturation: histMedian(t.landHist),
            waterShare: t.pixels ? t.water / t.pixels : 0,
            waterSaturation: histMedian(t.waterHist),
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

function summarize(results) {
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
    const ground = landPixels ? {
        landPixels,
        medianSaturation: histMedian(pooled),
        band: GROUND_SATURATION,
        ramps,
    } : null;
    return { classes: out, ground };
}

function hexSaturation(hex) {
    const [r, g, b] = hexToRgb(hex);
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

// ------------------------------------------------ seasonal and canopy ramps

// Rules per plan 5.1/5.3 ramp. Every ramp runs dark -> light by luminance and
// stays out of Tier A unless `tierAExempt` (snow: maintainer decision M9).
// Snow may cool its shadow step but its top step reads as snow only near
// achromatic (terrain-foliage notes: S <= 0.12).
const SEASONAL_RAMP_RULES = Object.freeze({
    snow: { maxSat: 0.2, topMaxSat: 0.12, tierAExempt: true },
    leafAutumn: {},
    canopyRusset: {},
    canopyOchre: {},
    willowGold: {},
    blossom: {},
    foliageDeep: { maxSat: 0.5, midHue: [90, 110] },
    foliageSun: { maxSat: 0.5, midHue: [90, 110] },
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
    return Object.entries(SEASONAL_RAMP_RULES).map(([key, rule]) => {
        const stops = ART_RAMPS[key] || [];
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
        return {
            ramp: key,
            stops: stops.length,
            minSat: Math.min(1, ...hsv.map((c) => c.s)),
            maxSat,
            minLum: lum.length ? lum[0] : null,
            maxLum: lum.length ? lum[lum.length - 1] : null,
            midHue,
            tierAStops: tierA.length,
            flags,
        };
    });
}

const packRgb = (r, g, b) => (r << 16) | (g << 8) | b;

function rampStopSet(key, stops = 0) {
    const hexes = ART_RAMPS[key] || [];
    return (stops ? hexes.slice(0, stops) : hexes).map((hex) => packRgb(...hexToRgb(hex)));
}

// Runs every tree sheet through FoliageRenderer's canopy remap for each plan
// its variants and seasons use and counts canopy pixels that land off the
// plan's ramps. A turning oak keeps its authored pixels below the turned
// crown; those are counted as `authored`, not off-ramp.
function canopyRemapReport() {
    return Object.entries(TREE_SPRITES).map(([key, sprite]) => {
        const absPath = join(spritesRoot, 'vegetation', `${sprite.id}.png`);
        if (!existsSync(absPath)) return { sprite: key, missing: true, plans: 0, canopy: 0, remapped: 0, authored: 0, offRamp: 0 };
        const png = readPng(absPath);
        const width = png.width;
        const height = Math.min(sprite.height, png.height);
        const source = Uint8ClampedArray.from(png.data.subarray(0, width * height * 4));
        const species = key.slice(0, key.indexOf('.'));
        const plans = new Set();
        for (const season of CANOPY_SEASONS) {
            for (const variant of CANOPY_VARIANTS) {
                const plan = canopyPlan(species, variant, season);
                if (plan) plans.add(plan);
            }
        }
        const row = { sprite: key, missing: false, plans: plans.size, canopy: 0, remapped: 0, authored: 0, offRamp: 0 };
        for (const plan of plans) {
            const data = Uint8ClampedArray.from(source);
            recolorCanopy(data, width, height, plan);
            const allowed = new Set([
                ...(plan.ramp ? rampStopSet(plan.ramp, plan.stops) : []),
                ...(plan.turning ? rampStopSet(plan.turning) : []),
                ...(plan.blossom ? rampStopSet('blossom') : []),
            ]);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    if (!isCanopyPixel(source, i, y, height)) continue;
                    row.canopy++;
                    if (allowed.has(packRgb(data[i], data[i + 1], data[i + 2]))) row.remapped++;
                    else if (!plan.ramp && data[i] === source[i] && data[i + 1] === source[i + 1] && data[i + 2] === source[i + 2]) row.authored++;
                    else row.offRamp++;
                }
            }
        }
        return row;
    });
}

function printReport(results, summary, opts) {
    const rows = opts.flaggedOnly ? results.filter((r) => r.flags.length) : results;
    console.log(`ClaudeVille art analysis — ${results.length} assets (advisory; see artPalette.js for the rules)\n`);
    console.log(table(rows, [
        { label: 'id', get: (r) => r.id },
        { label: 'class', get: (r) => r.class },
        { label: 'colours', get: (r) => r.colours, right: true },
        { label: 'semiA', get: (r) => pct(r.semiAlpha), right: true },
        { label: 'sat', get: (r) => num(r.saturation), right: true },
        { label: 'tierA', get: (r) => pct(r.tierA), right: true },
        { label: 'offRamp', get: (r) => pct(r.offRamp), right: true },
        { label: 'flags', get: (r) => r.flags.join(',') },
    ]));

    const scaleRows = results.filter((r) => r.scaleIssues.length);
    if (scaleRows.length) {
        console.log('\nNon-integer display scales (manifest):');
        for (const r of scaleRows) console.log(`  ${r.id}: ${r.scaleIssues.join('; ')}`);
    }

    const terrainRows = results.filter((r) => r.terrain);
    if (terrainRows.length) {
        console.log(`\nTerrain vs C1 (ground band S ${GROUND_SATURATION.min}-${GROUND_SATURATION.max}, water S <= ${WATER_VOID_SATURATION_MAX}, off-ramp dE_OK > ${THRESHOLDS.offRampDistance}):`);
        console.log(table(terrainRows, [
            { label: 'id', get: (r) => r.id },
            { label: 'ramps', get: (r) => r.terrain.ramps.join('+') },
            { label: 'land', get: (r) => pct(r.terrain.landShare, 0), right: true },
            { label: 'landS', get: (r) => num(r.terrain.landSaturation), right: true },
            { label: 'water', get: (r) => pct(r.terrain.waterShare, 0), right: true },
            { label: 'waterS', get: (r) => num(r.terrain.waterSaturation), right: true },
            { label: 'offRamp', get: (r) => pct(r.offRamp), right: true },
        ]));
        if (summary.ground) {
            const s = summary.ground.medianSaturation;
            const verdict = s > GROUND_SATURATION.max ? 'above band (too loud)' : s < GROUND_SATURATION.min ? 'below band (too grey)' : 'inside band';
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

    if (summary.seasonalRamps) {
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
    if (summary.canopyRemaps) {
        console.log('\nTree canopy remaps (FoliageRenderer, every variant and season; offRamp must be 0):');
        console.log(table(summary.canopyRemaps, [
            { label: 'sprite', get: (r) => r.sprite },
            { label: 'plans', get: (r) => (r.missing ? 'missing' : r.plans), right: true },
            { label: 'canopy px', get: (r) => r.canopy, right: true },
            { label: 'on-ramp', get: (r) => r.remapped, right: true },
            { label: 'authored', get: (r) => r.authored, right: true },
            { label: 'offRamp', get: (r) => r.offRamp, right: true },
        ]));
    }

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

    const problems = results.filter((r) => r.missing.length || r.errors.length);
    if (problems.length) {
        console.log('\nUnread files:');
        for (const r of problems) {
            for (const m of r.missing) console.log(`  ${r.id}: missing ${m}`);
            for (const e of r.errors) console.log(`  ${r.id}: ${e}`);
        }
    }

    const flagged = results.filter((r) => r.flags.length).length;
    console.log(`\n${flagged} of ${results.length} assets flagged. Flags: colours > ${THRESHOLDS.colours}; semi-alpha > ${pct(THRESHOLDS.semiAlpha, 0)}; tier-a > ${pct(THRESHOLDS.tierA, 0)} of visible pixels outside status/emissive roles; off-ramp > ${pct(THRESHOLDS.offRamp, 0)}; water-loud = water pixels above S ${WATER_VOID_SATURATION_MAX}; scale = non-integer manifest display scale.`);
}

function toJson(results, summary) {
    return {
        generatedAt: new Date().toISOString(),
        thresholds: THRESHOLDS,
        groundBand: GROUND_SATURATION,
        waterSaturationMax: WATER_VOID_SATURATION_MAX,
        summary,
        assets: results.map((r) => ({
            ...r,
            terrain: r.terrain ? { ...r.terrain, landHist: undefined, rampHists: undefined } : null,
        })),
    };
}

// -------------------------------------------------------------------- main

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/sprites/art-analyze.mjs [--json] [--ids <id,prefix.*,...>] [--flagged]');
        return;
    }
    const matches = idMatcher(opts.ids);
    const manifest = loadSpriteManifest();
    const results = [];
    for (const group of ANALYZED_GROUPS) {
        for (const entry of collectSpriteEntries(manifest, [group])) {
            if (!entry?.id || !matches(entry.id)) continue;
            results.push(analyzeEntry(entry, group));
        }
    }
    if (opts.ids && results.length === 0) {
        console.error(`[art-analyze] no manifest ids match: ${opts.ids.join(', ')}`);
    }
    const summary = summarize(results);
    if (!opts.ids || Object.values(TREE_SPRITES).some((sprite) => matches(sprite.id))) {
        summary.seasonalRamps = seasonalRampReport();
        summary.canopyRemaps = canopyRemapReport();
    }
    if (opts.json) {
        console.log(JSON.stringify(toJson(results, summary), null, 2));
    } else {
        printReport(results, summary, opts);
    }
}

try {
    main();
} catch (err) {
    console.error(`[art-analyze] advisory run failed: ${err?.stack || err}`);
}
process.exitCode = 0;
