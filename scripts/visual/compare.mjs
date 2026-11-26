#!/usr/bin/env node
// Wave 0.4 — Pure-Node Visual QA Comparator & CI Gate (`npm run visual:gate`)
// (Spec 03 §3.3 — 100% pure Node, ZERO browser, runs in < 5 s)
//
// Computes:
//   - Per-pixel OKLab ΔE (scaled by 100 so 2.3 = 1 JND, matching Spec 03 §3.3)
//     with per-region histograms (`meanDeltaE`, `p95DeltaE`, `p999DeltaE`,
//     `maxDeltaE`, `shareOverJnd`)
//   - Region-weighted windowed luma SSIM
//   - Record-ID pixel attribution bucketing (`parityAttribution`)
//   - Golden-free structural & telemetry budget assertions
//   - Structured `verdict.json` matching Spec 03 §3.3 schema
//
// Usage:
//   node scripts/visual/compare.mjs --gate [--golden-dir <dir>] [--candidate-dir <dir>] [--json]
//   node scripts/visual/compare.mjs --base <png> --head <png> [--meta <json>] [--attribution <bin>] [--out <verdict.json>]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
    REGION_CLASS_NAMES,
    bucketAttributionDiffs,
    decodeAttributionBuffer,
    decodeAttributionWord,
} from './attribution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_GOLDEN_DIR = path.join(ROOT, 'claudeville', 'visual', 'golden');

// 100 * OKLab Euclidean distance: 2.3 corresponds to 1 perceptual JND (Spec 03 §3.3).
export const OKLAB_JND_SCALE = 100;
export const JND_DELTA_E = 2.3;

export const DEFAULT_THRESHOLDS = Object.freeze({
    maxP999DeltaE: 3.0,
    maxShareOverJnd: 0.005,
    minSsim: 0.98,
    maxUnclassifiedNonRimOver1: 10,
    maxLabelCollisionPairs: 0,
    maxBodyOverlapPairs: 0,
});

export const DEFAULT_TELEMETRY_CAPS = Object.freeze({
    derivedCpuCap: 100_663_296,      // 96 MiB transitional (16.5 MiB Canvas)
    unifiedCap: 335_544_320,         // 320 MiB
    gpuOwnedCap: 167_772_160,        // 160 MiB
    gpuEquippedCapMs: 16,
    pathLookupCapMs: 0.10,
});

// ------------------------------------------------------------------ OKLab

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(r, g, b) {
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

export function oklabDeltaEJnd(r1, g1, b1, r2, g2, b2) {
    if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
    const a = rgbToOklab(r1, g1, b1);
    const b = rgbToOklab(r2, g2, b2);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * OKLAB_JND_SCALE;
}

// ------------------------------------------------------------------- SSIM

const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

function ssimFromStats(n, sumA, sumB, sumA2, sumB2, sumAB) {
    if (n <= 0) return 1;
    const muA = sumA / n;
    const muB = sumB / n;
    const varA = Math.max(0, sumA2 / n - muA * muA);
    const varB = Math.max(0, sumB2 / n - muB * muB);
    const cov = sumAB / n - muA * muB;
    const num = (2 * muA * muB + SSIM_C1) * (2 * cov + SSIM_C2);
    const den = (muA * muA + muB * muB + SSIM_C1) * (varA + varB + SSIM_C2);
    return den > 0 ? Math.max(-1, Math.min(1, num / den)) : 1;
}

/**
 * Compute windowed 8x8 luma SSIM globally or over pixels matching a mask.
 * Falls back to full-region SSIM when a region has no dense 8x8 windows.
 */
export function computeLumaSsim(lumaA, lumaB, width, height, regionMask = null, targetValue = 1) {
    const win = 8;
    const step = width >= 64 && height >= 64 ? 4 : 2;
    let ssimSum = 0;
    let weightSum = 0;

    if (width >= win && height >= win) {
        for (let y = 0; y <= height - win; y += step) {
            for (let x = 0; x <= width - win; x += step) {
                let n = 0;
                let sA = 0;
                let sB = 0;
                let sA2 = 0;
                let sB2 = 0;
                let sAB = 0;
                for (let dy = 0; dy < win; dy++) {
                    const row = (y + dy) * width + x;
                    for (let dx = 0; dx < win; dx++) {
                        const p = row + dx;
                        if (regionMask && regionMask[p] !== targetValue) continue;
                        const a = lumaA[p];
                        const b = lumaB[p];
                        n++;
                        sA += a;
                        sB += b;
                        sA2 += a * a;
                        sB2 += b * b;
                        sAB += a * b;
                    }
                }
                if (n >= 8) {
                    ssimSum += ssimFromStats(n, sA, sB, sA2, sB2, sAB) * n;
                    weightSum += n;
                }
            }
        }
    }

    if (weightSum > 0) return ssimSum / weightSum;

    // Fallback for tiny images or thin 1px regions: aggregate region SSIM.
    let n = 0;
    let sA = 0;
    let sB = 0;
    let sA2 = 0;
    let sB2 = 0;
    let sAB = 0;
    for (let p = 0; p < lumaA.length; p++) {
        if (regionMask && regionMask[p] !== targetValue) continue;
        const a = lumaA[p];
        const b = lumaB[p];
        n++;
        sA += a;
        sB += b;
        sA2 += a * a;
        sB2 += b * b;
        sAB += a * b;
    }
    return ssimFromStats(n, sA, sB, sA2, sB2, sAB);
}

// ------------------------------------------------------------ histogramming

// High-resolution fixed histogram in 0.1 ΔE bins from 0.0 to 100.0 (1001 bins)
// so p95 / p99.9 run in O(1) memory without sorting millions of floats.
const DE_HIST_SCALE = 10;
const DE_HIST_BINS = 1001;

function newRegionAccumulator() {
    return {
        pixels: 0,
        sumDeltaE: 0,
        maxDeltaE: 0,
        overJnd: 0,
        hist: new Uint32Array(DE_HIST_BINS),
    };
}

function histQuantile(hist, total, q) {
    if (total <= 0) return 0;
    const target = Math.ceil(total * q);
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
        acc += hist[i];
        if (acc >= target) return i / DE_HIST_SCALE;
    }
    return (hist.length - 1) / DE_HIST_SCALE;
}

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

/**
 * Compare two RGBA8 PNG-like objects `{ width, height, data }` in pure Node.
 * Returns per-region OKLab ΔE stats, region-weighted luma SSIM, and optional
 * attribution buckets.
 */
export function comparePngBuffers(refPng, candPng, {
    attribution = null,
    attributionFormat = 'auto',
    records = [],
    rimMask = null,
    jndThreshold = JND_DELTA_E,
} = {}) {
    if (refPng.width !== candPng.width || refPng.height !== candPng.height) {
        throw new Error(`Dimension mismatch: ref ${refPng.width}x${refPng.height} != cand ${candPng.width}x${candPng.height}`);
    }
    const { width, height } = refPng;
    const count = width * height;
    const refData = refPng.data;
    const candData = candPng.data;

    const attrWords = attribution
        ? decodeAttributionBuffer(attribution, width, height, attributionFormat)
        : null;

    const lumaA = new Float32Array(count);
    const lumaB = new Float32Array(count);
    const pixelD = new Uint8Array(count);
    const regionIds = attrWords ? new Uint8Array(count) : null;
    const accumulators = new Map();
    const labCache = new Map();

    const getLab = (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        let hit = labCache.get(key);
        if (!hit) {
            hit = rgbToOklab(r, g, b);
            if (labCache.size < 65536) labCache.set(key, hit);
        }
        return hit;
    };

    const getAcc = (name) => {
        let acc = accumulators.get(name);
        if (!acc) {
            acc = newRegionAccumulator();
            accumulators.set(name, acc);
        }
        return acc;
    };

    const presentRegionCodes = new Set();

    for (let p = 0, i = 0; p < count; p++, i += 4) {
        const r1 = refData[i];
        const g1 = refData[i + 1];
        const b1 = refData[i + 2];
        const a1 = refData[i + 3];
        const r2 = candData[i];
        const g2 = candData[i + 1];
        const b2 = candData[i + 2];
        const a2 = candData[i + 3];

        lumaA[p] = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
        lumaB[p] = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;

        const d = Math.max(
            Math.abs(r1 - r2),
            Math.abs(g1 - g2),
            Math.abs(b1 - b2),
            Math.abs(a1 - a2),
        );
        pixelD[p] = d;

        let de = 0;
        if (r1 !== r2 || g1 !== g2 || b1 !== b2) {
            const la = getLab(r1, g1, b1);
            const lb = getLab(r2, g2, b2);
            de = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) * OKLAB_JND_SCALE;
        }

        let regionName = 'all';
        if (attrWords) {
            const code = decodeAttributionWord(attrWords[p]).regionClass;
            regionIds[p] = code;
            presentRegionCodes.add(code);
            regionName = REGION_CLASS_NAMES[code] || `region${code}`;
        }

        const acc = getAcc(regionName);
        acc.pixels++;
        acc.sumDeltaE += de;
        if (de > acc.maxDeltaE) acc.maxDeltaE = de;
        if (de > jndThreshold) acc.overJnd++;
        const bin = Math.min(DE_HIST_BINS - 1, Math.floor(de * DE_HIST_SCALE));
        acc.hist[bin]++;
    }

    const perceptualByRegion = {};
    if (attrWords) {
        for (const code of [...presentRegionCodes].sort((a, b) => a - b)) {
            const name = REGION_CLASS_NAMES[code] || `region${code}`;
            const acc = accumulators.get(name);
            const ssim = computeLumaSsim(lumaA, lumaB, width, height, regionIds, code);
            perceptualByRegion[name] = {
                pixels: acc.pixels,
                meanDeltaE: round(acc.sumDeltaE / Math.max(1, acc.pixels), 4),
                p95DeltaE: round(histQuantile(acc.hist, acc.pixels, 0.95), 3),
                p999DeltaE: round(histQuantile(acc.hist, acc.pixels, 0.999), 3),
                maxDeltaE: round(acc.maxDeltaE, 3),
                shareOverJnd: round(acc.overJnd / Math.max(1, acc.pixels), 6),
                ssim: round(ssim, 6),
            };
        }
    } else {
        const acc = accumulators.get('all') || newRegionAccumulator();
        const ssim = computeLumaSsim(lumaA, lumaB, width, height);
        perceptualByRegion.all = {
            pixels: acc.pixels,
            meanDeltaE: round(acc.sumDeltaE / Math.max(1, acc.pixels), 4),
            p95DeltaE: round(histQuantile(acc.hist, acc.pixels, 0.95), 3),
            p999DeltaE: round(histQuantile(acc.hist, acc.pixels, 0.999), 3),
            maxDeltaE: round(acc.maxDeltaE, 3),
            shareOverJnd: round(acc.overJnd / Math.max(1, acc.pixels), 6),
            ssim: round(ssim, 6),
        };
    }

    // Region-weighted luma SSIM across all pixels
    let weightedSsimNum = 0;
    let weightedSsimDen = 0;
    for (const r of Object.values(perceptualByRegion)) {
        weightedSsimNum += r.ssim * r.pixels;
        weightedSsimDen += r.pixels;
    }
    const weightedSsim = weightedSsimDen > 0 ? round(weightedSsimNum / weightedSsimDen, 6) : 1;

    const parityAttribution = bucketAttributionDiffs({
        pixelD,
        attribution: attrWords,
        attributionFormat: 'r32uint',
        records,
        rimMask,
        width,
        height,
    });

    return {
        width,
        height,
        pixels: count,
        weightedSsim,
        perceptualByRegion,
        parityAttribution: {
            over1Total: parityAttribution.over1Total,
            rimOver1: parityAttribution.rimOver1,
            explainedNonRimOver1: parityAttribution.explainedNonRimOver1,
            unclassifiedNonRimOver1: parityAttribution.unclassifiedNonRimOver1,
            byTag: parityAttribution.byTag,
        },
    };
}

/**
 * Build a Spec 03 §3.3 `verdict.json` object and evaluate every CI gate rule.
 */
export function evaluateVerdict({
    caseId = 'unknown',
    backend = 'webgpu',
    adapter = { vendor: null, architecture: null, fallback: false },
    determinism = { selfStableBytes: true, ladderLevel: 0, nondeterministicMasks: [] },
    perceptualByRegion = {},
    parityAttribution = {
        over1Total: 0,
        rimOver1: 0,
        explainedNonRimOver1: 0,
        unclassifiedNonRimOver1: 0,
        byTag: {},
    },
    structural = {},
    telemetryBudgets = {},
    thresholds = DEFAULT_THRESHOLDS,
} = {}) {
    const failures = [];

    if (determinism?.selfStableBytes !== true) {
        failures.push('determinism.selfStableBytes is not true');
    }
    if (determinism?.ladderLevel !== undefined && determinism?.ladderLevel !== null && determinism.ladderLevel !== 0) {
        failures.push(`determinism.ladderLevel ${determinism.ladderLevel} !== 0`);
    }
    if (adapter?.fallback === true) {
        failures.push('adapter.fallback === true (software adapter forbidden)');
    }

    for (const [region, metrics] of Object.entries(perceptualByRegion || {})) {
        if (metrics.p999DeltaE > thresholds.maxP999DeltaE) {
            failures.push(`perceptualByRegion.${region}.p999DeltaE ${metrics.p999DeltaE} > ${thresholds.maxP999DeltaE}`);
        }
        if (metrics.shareOverJnd > thresholds.maxShareOverJnd) {
            failures.push(`perceptualByRegion.${region}.shareOverJnd ${metrics.shareOverJnd} > ${thresholds.maxShareOverJnd}`);
        }
        if (Number.isFinite(metrics.ssim) && metrics.ssim < thresholds.minSsim) {
            failures.push(`perceptualByRegion.${region}.ssim ${metrics.ssim} < ${thresholds.minSsim}`);
        }
    }

    if ((parityAttribution?.unclassifiedNonRimOver1 ?? 0) > thresholds.maxUnclassifiedNonRimOver1) {
        failures.push(`parityAttribution.unclassifiedNonRimOver1 ${parityAttribution.unclassifiedNonRimOver1} > ${thresholds.maxUnclassifiedNonRimOver1}`);
    }

    if (Number.isFinite(structural?.labelCollisionPairs) && structural.labelCollisionPairs > thresholds.maxLabelCollisionPairs) {
        failures.push(`structural.labelCollisionPairs ${structural.labelCollisionPairs} > ${thresholds.maxLabelCollisionPairs}`);
    }
    if (Number.isFinite(structural?.bodyOverlapPairs) && structural.bodyOverlapPairs > thresholds.maxBodyOverlapPairs) {
        failures.push(`structural.bodyOverlapPairs ${structural.bodyOverlapPairs} > ${thresholds.maxBodyOverlapPairs}`);
    }

    const budgetPairs = [
        ['derivedCpuBytes', 'derivedCpuCap', DEFAULT_TELEMETRY_CAPS.derivedCpuCap],
        ['unifiedBytes', 'unifiedCap', DEFAULT_TELEMETRY_CAPS.unifiedCap],
        ['gpuOwnedBytes', 'gpuOwnedCap', DEFAULT_TELEMETRY_CAPS.gpuOwnedCap],
        ['gpuEquippedMaxComposeMs', 'gpuEquippedCapMs', DEFAULT_TELEMETRY_CAPS.gpuEquippedCapMs],
        ['pathLookupAvgMs', 'pathLookupCapMs', DEFAULT_TELEMETRY_CAPS.pathLookupCapMs],
    ];
    for (const [metricKey, capKey, defaultCap] of budgetPairs) {
        const value = telemetryBudgets?.[metricKey];
        if (!Number.isFinite(value)) continue;
        const cap = Number.isFinite(telemetryBudgets?.[capKey]) ? telemetryBudgets[capKey] : defaultCap;
        if (value > cap) {
            failures.push(`telemetryBudgets.${metricKey} ${value} > ${cap}`);
        }
    }

    return {
        schemaVersion: 1,
        caseId,
        backend,
        adapter,
        determinism,
        perceptualByRegion,
        parityAttribution,
        structural,
        telemetryBudgets,
        failures,
        verdict: failures.length === 0 ? 'pass' : 'fail',
    };
}

function makeSolidPng(width, height, rgba) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3];
    }
    return { width, height, data };
}

/**
 * Pure-Node schema and metric self-test run by `--gate` when
 * `claudeville/visual/golden/` does not yet contain committed Wave 0 goldens.
 */
export function runSchemaSelfTest() {
    const a = makeSolidPng(16, 16, [80, 120, 90, 255]);
    const b = makeSolidPng(16, 16, [80, 120, 90, 255]);
    const c = makeSolidPng(16, 16, [220, 40, 180, 255]);

    const sameCmp = comparePngBuffers(a, b);
    const sameVerdict = evaluateVerdict({
        caseId: 'self-test-identical',
        perceptualByRegion: sameCmp.perceptualByRegion,
        parityAttribution: sameCmp.parityAttribution,
    });
    if (sameVerdict.verdict !== 'pass') {
        throw new Error(`Schema self-test failed: identical buffers did not pass (${sameVerdict.failures.join('; ')})`);
    }

    const diffCmp = comparePngBuffers(a, c);
    const diffVerdict = evaluateVerdict({
        caseId: 'self-test-regressed',
        perceptualByRegion: diffCmp.perceptualByRegion,
        parityAttribution: diffCmp.parityAttribution,
    });
    if (diffVerdict.verdict !== 'fail') {
        throw new Error('Schema self-test failed: strongly shifted buffers did not fail');
    }
    return { ok: true, identicalVerdict: sameVerdict.verdict, regressedVerdict: diffVerdict.verdict };
}

function readPngFile(filePath) {
    return PNG.sync.read(readFileSync(filePath));
}

function extractTelemetryBudgets(meta) {
    if (meta?.telemetryBudgets) return meta.telemetryBudgets;
    const budget = meta?.telemetry?.canvasBudget;
    const pathDiag = meta?.telemetry?.pathDiag;
    const out = {};
    if (Number.isFinite(budget?.derivedCpuBytes)) {
        out.derivedCpuBytes = budget.derivedCpuBytes;
        out.derivedCpuCap = DEFAULT_TELEMETRY_CAPS.derivedCpuCap;
    }
    if (Number.isFinite(budget?.unifiedBytes)) {
        out.unifiedBytes = budget.unifiedBytes;
        out.unifiedCap = DEFAULT_TELEMETRY_CAPS.unifiedCap;
    }
    if (Number.isFinite(budget?.gpuOwnedBytes)) {
        out.gpuOwnedBytes = budget.gpuOwnedBytes;
        out.gpuOwnedCap = DEFAULT_TELEMETRY_CAPS.gpuOwnedCap;
    }
    if (Number.isFinite(budget?.gpuEquippedMaxComposeMs)) {
        out.gpuEquippedMaxComposeMs = budget.gpuEquippedMaxComposeMs;
        out.gpuEquippedCapMs = DEFAULT_TELEMETRY_CAPS.gpuEquippedCapMs;
    }
    if (Number.isFinite(pathDiag?.lookupAvgMs)) {
        out.pathLookupAvgMs = pathDiag.lookupAvgMs;
        out.pathLookupCapMs = DEFAULT_TELEMETRY_CAPS.pathLookupCapMs;
    }
    return out;
}

/**
 * Run CI `--gate` verification over `goldenDir` (and optional `candidateDir`).
 */
export function runVisualGate({
    goldenDir = DEFAULT_GOLDEN_DIR,
    candidateDir = null,
    thresholds = DEFAULT_THRESHOLDS,
} = {}) {
    const cases = [];
    if (existsSync(goldenDir)) {
        for (const entry of readdirSync(goldenDir).sort()) {
            const dir = path.join(goldenDir, entry);
            if (!statSync(dir).isDirectory()) continue;
            if (existsSync(path.join(dir, 'meta.json')) || existsSync(path.join(dir, 'composite.png'))) {
                cases.push({ caseId: entry, dir });
            }
        }
    }

    if (cases.length === 0) {
        const selfTest = runSchemaSelfTest();
        return {
            pass: true,
            mode: 'schema-self-test',
            goldenDir,
            goldenCases: 0,
            selfTest,
            verdicts: [],
        };
    }

    const verdicts = [];
    for (const item of cases) {
        const metaPath = path.join(item.dir, 'meta.json');
        const goldenPngPath = path.join(item.dir, 'composite.png');
        if (!existsSync(metaPath) || !existsSync(goldenPngPath)) {
            verdicts.push(evaluateVerdict({
                caseId: item.caseId,
                determinism: { selfStableBytes: false, ladderLevel: null, nondeterministicMasks: [] },
                thresholds,
            }));
            continue;
        }
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const refPng = readPngFile(goldenPngPath);
        const candDir = candidateDir ? path.join(candidateDir, item.caseId) : item.dir;
        const candPngPath = path.join(candDir, 'composite.png');
        const candPng = existsSync(candPngPath) ? readPngFile(candPngPath) : refPng;
        const candMeta = candidateDir && existsSync(path.join(candDir, 'meta.json'))
            ? JSON.parse(readFileSync(path.join(candDir, 'meta.json'), 'utf8'))
            : meta;
        const attrPath = path.join(candDir, 'attribution.bin');
        const attribution = existsSync(attrPath) ? readFileSync(attrPath) : null;

        const cmp = comparePngBuffers(refPng, candPng, {
            attribution,
            attributionFormat: candMeta.attributionFormat || 'auto',
            records: candMeta.records || [],
        });

        verdicts.push(evaluateVerdict({
            caseId: candMeta.caseId || item.caseId,
            backend: candMeta.backend || 'unknown',
            adapter: candMeta.adapter || { vendor: null, architecture: null, fallback: false },
            determinism: candMeta.determinism || { selfStableBytes: true, ladderLevel: 0, nondeterministicMasks: [] },
            perceptualByRegion: cmp.perceptualByRegion,
            parityAttribution: cmp.parityAttribution,
            structural: candMeta.structural || {},
            telemetryBudgets: extractTelemetryBudgets(candMeta),
            thresholds,
        }));
    }

    const pass = verdicts.every((v) => v.verdict === 'pass');
    return {
        pass,
        mode: candidateDir ? 'golden-diff' : 'golden-verify',
        goldenDir,
        goldenCases: cases.length,
        verdicts,
    };
}

// ---------------------------------------------------------------------- CLI

function parseArgs(argv) {
    const opts = {
        gate: false,
        json: false,
        goldenDir: DEFAULT_GOLDEN_DIR,
        candidateDir: null,
        base: null,
        head: null,
        meta: null,
        attribution: null,
        out: null,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--gate') { opts.gate = true; continue; }
        if (arg === '--json') { opts.json = true; continue; }
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        const [flag, inline] = arg.split('=', 2);
        const value = inline ?? argv[++i];
        if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
        switch (flag) {
            case '--golden-dir': opts.goldenDir = path.resolve(process.cwd(), value); break;
            case '--candidate-dir': opts.candidateDir = path.resolve(process.cwd(), value); break;
            case '--base': opts.base = path.resolve(process.cwd(), value); break;
            case '--head': opts.head = path.resolve(process.cwd(), value); break;
            case '--meta': opts.meta = path.resolve(process.cwd(), value); break;
            case '--attribution': opts.attribution = path.resolve(process.cwd(), value); break;
            case '--out': opts.out = path.resolve(process.cwd(), value); break;
            default: throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/visual/compare.mjs --gate [--golden-dir <dir>] [--candidate-dir <dir>] [--json]');
        console.log('       node scripts/visual/compare.mjs --base <png> --head <png> [--meta <json>] [--attribution <bin>] [--out <verdict.json>]');
        return;
    }

    if (opts.base && opts.head) {
        const refPng = readPngFile(opts.base);
        const candPng = readPngFile(opts.head);
        const meta = opts.meta && existsSync(opts.meta) ? JSON.parse(readFileSync(opts.meta, 'utf8')) : {};
        const attribution = opts.attribution && existsSync(opts.attribution) ? readFileSync(opts.attribution) : null;
        const cmp = comparePngBuffers(refPng, candPng, {
            attribution,
            attributionFormat: meta.attributionFormat || 'auto',
            records: meta.records || [],
        });
        const verdict = evaluateVerdict({
            caseId: meta.caseId || path.basename(opts.head, '.png'),
            backend: meta.backend || 'unknown',
            adapter: meta.adapter || { vendor: null, architecture: null, fallback: false },
            determinism: meta.determinism || { selfStableBytes: true, ladderLevel: 0, nondeterministicMasks: [] },
            perceptualByRegion: cmp.perceptualByRegion,
            parityAttribution: cmp.parityAttribution,
            structural: meta.structural || {},
            telemetryBudgets: extractTelemetryBudgets(meta),
        });
        if (opts.out) {
            mkdirSync(path.dirname(opts.out), { recursive: true });
            writeFileSync(opts.out, `${JSON.stringify(verdict, null, 2)}\n`);
        }
        if (opts.json || !opts.out) {
            console.log(JSON.stringify(verdict, null, 2));
        } else {
            console.log(`[visual:compare] ${verdict.caseId}: ${verdict.verdict.toUpperCase()} (weightedSSIM=${cmp.weightedSsim})`);
        }
        if (verdict.verdict !== 'pass') process.exitCode = 1;
        return;
    }

    const report = runVisualGate({
        goldenDir: opts.goldenDir,
        candidateDir: opts.candidateDir,
    });
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else if (report.mode === 'schema-self-test') {
        console.log(`[visual:gate] PASS — 0 golden cases under ${path.relative(ROOT, report.goldenDir)}; pure-Node schema & metric self-test passed.`);
    } else {
        const failed = report.verdicts.filter((v) => v.verdict !== 'pass');
        console.log(`[visual:gate] ${report.pass ? 'PASS' : 'FAIL'} — ${report.goldenCases} golden case(s) checked (${failed.length} failed).`);
        for (const f of failed) {
            console.error(`  - ${f.caseId}: ${f.failures.join('; ')}`);
        }
    }
    if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`[visual:compare] FAIL: ${error.stack || error.message}`);
        process.exit(1);
    }
}
