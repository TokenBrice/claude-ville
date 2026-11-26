#!/usr/bin/env node
// Wave 0.4 — Deterministic Frozen-Frame Visual QA Capture Harness
// (Spec 01 §5 Green First-Frame Capture Fence + Spec 03 §3.3 Visual QA Lab)
//
// Boots an isolated ephemeral-port ClaudeVille server (NEVER touches port 4000),
// pins date/hour/weather/camera/reduced-motion/qualityLadder(0), waits for
// Astra's strict present-generation capture fence (eliminating `#416139` green
// first frames), freezes mutable canvas sources, verifies two consecutive
// byte-identical readbacks via `debugCaptureTargets()`, records structured
// telemetry, and writes lossless PNGs + `meta.json` into
// `output/visual-capture/<run>/<caseId>/` (or updates
// `claudeville/visual/golden/<caseId>/` ONLY when `--accept` is explicitly passed).
//
// Usage:
//   node scripts/visual/capture.mjs [options]
//   Options:
//     --scenarios=<list|all>  Scenario ids (default: readme-noon,readme-night)
//     --case=<spec>           Ad-hoc scenario:hour:weather:zoom[:date]
//     --sizes=<list>          WIDTHxHEIGHT[@DPR] (default: 1920x1080)
//     --backend=<mode>        webgpu | webgl | canvas (default: webgpu)
//     --date=<YYYY-MM-DD>     Pin calendar date via page.clock.setFixedTime
//     --motion=<mode>         reduce | no-preference (default: reduce)
//     --settle=<n>            Consecutive identical readbacks required (default: 2)
//     --out=<dir>             Output directory (default: output/visual-capture/<timestamp>)
//     --golden-dir=<dir>      Golden root (default: claudeville/visual/golden)
//     --accept                Also write/update golden baselines under --golden-dir
//     --allow-fallback        Permit software fallback adapters (for CPU-only tests)
//     --authored-solar        Pin the authored diurnal keys (zero day shift)
//     --url=<url>             Existing server URL (default: isolated ephemeral port)
//     --headed                Show browser window
//     --help                  Show help

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { launchChromium } from '../smoke/support/chromium.mjs';
import { BENCH_WEATHER, GPU_LAUNCH_ARGS, resolveServer } from '../smoke/support/world-bench.mjs';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_GOLDEN_DIR = path.join(ROOT, 'claudeville', 'visual', 'golden');

/**
 * Resolve the canonical GPU ABI flag bitmask for a frozen scene record.
 * Uses `rec.flags` when present and ORs in any matching named boolean fields
 * (e.g. `rec.reflect`, `rec.screenSpace`, `rec.writesDepth`) from `GPU_RECORD_FLAGS`.
 */
export function resolveRecordFlags(rec, flagMap = GPU_RECORD_FLAGS) {
    let bits = Number.isFinite(rec?.flags) ? (rec.flags | 0) : 0;
    if (flagMap && rec && typeof rec === 'object') {
        for (const [name, bit] of Object.entries(flagMap)) {
            if (rec[name] === true) bits |= bit;
        }
    }
    return bits >>> 0;
}

// Astra 01 §5 causal control: daytime reduced-motion CSS opening land fill.
export const GREEN_SWATCH_RGB = Object.freeze([65, 97, 57]); // #416139
export const MIN_DISTINCT_INTERIOR_COLORS = 4;
export const MAX_GREEN_FILL_SHARE = 0.50;
// Deterministic calendar date pinned for any undated `--case` run so captures
// never depend on the host's wall-clock date/time.
export const DEFAULT_CAPTURE_DATE = '2026-07-15';
// W2-Fix-B — an undated snow case lands mid-winter (snow only settles in
// December–February; `GroundState.snowCoverAt`).
export const DEFAULT_SNOW_CAPTURE_DATE = '2026-01-15';
// W2-Fix-B — the page's zone, pinned like `scripts/world/golden-hours.mjs`:
// the village keeps this city's real sun (LA-2) whatever the host's zone.
export const CAPTURE_TIMEZONE = 'Europe/Belgrade';
// `--authored-solar`: the authored grade keys at their own minutes
// (06:00 / 12:30 / 18:00 / 18:27 / 19:45 / 22:00), whatever the date.
export const AUTHORED_DAY_SHIFT = Object.freeze({ sunriseShift: 0, sunsetShift: 0, goldenShift: 0 });
// Canvas: the CanvasWaterState sea chunks build within a per-frame budget;
// wait (bounded) until a render builds none before reading back.
export const CANVAS_SEA_SETTLE_MS = 10_000;
export const CANVAS_SEA_SETTLE_RENDERS = 240;

/**
 * W2-Fix-B — the pinned weather for a capture item's `weather` key. Unknown
 * keys throw (never a silent fallback to clear). `snow` is not an atmosphere
 * weather type: it poses as winter rain (precipitation falls as snow in
 * December–February) over a pinned timeline of frozen rain, so the ground
 * history (`GroundState.groundStateAt`) lays real snow cover; the capture
 * then requires `snowCover >= minSnowCover` and its bucket (`snowBucketOf`)
 * >= `minSnowBucket`, the bucket the icicles, the lagoon rim ice and the
 * trampled avenue crowns need.
 */
export function resolveCaptureWeather(key) {
    const name = String(key ?? '');
    const preset = Object.prototype.hasOwnProperty.call(BENCH_WEATHER, name) ? BENCH_WEATHER[name] : null;
    if (!preset) throw new Error(`Unknown capture weather "${name}" (expected one of ${Object.keys(BENCH_WEATHER).join(', ')})`);
    if (preset.type !== 'snow') return Object.freeze({ key: name, profile: preset, knots: null, snow: false, minSnowCover: 0, minSnowBucket: 0 });
    const { snowCover = 1, ...rest } = preset;
    const profile = Object.freeze({ ...rest, type: 'rain' });
    const knot = (minute) => Object.freeze({
        minute, type: 'rain', intensity: rest.intensity, precipitation: rest.precipitation,
        cloudCover: rest.cloudCover, fog: rest.fog, windX: rest.windX, frozen: true,
    });
    return Object.freeze({
        key: name,
        profile,
        knots: Object.freeze([knot(0), knot(1439)]),
        snow: true,
        minSnowCover: snowCover,
        minSnowBucket: Math.max(3, snowBucketOf(snowCover)),
    });
}

/**
 * W2-Fix-B — the instant the page clock pins for a capture date: 12:00 on
 * that date in `timeZone` (the page's zone), whatever the host's zone, so the
 * page never lands on a neighbouring date.
 */
export function captureInstant(dateStr, timeZone = CAPTURE_TIMEZONE) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
    if (!match) throw new Error(`Capture date must be YYYY-MM-DD, received ${dateStr}`);
    const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const zoned = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return new Date(guess - (zoned - guess));
}

// GroundState `snowBucketOf` (0 bare, 1–4 quarters), for the Node side.
export function snowBucketOf(snowCover) {
    const cover = Number(snowCover) || 0;
    return cover <= 0 ? 0 : Math.min(4, Math.ceil(cover * 4 - 1e-9));
}

/**
 * W2-Fix-B — the capture date for an item: `--date`, else the item's date,
 * else the default (mid-winter for snow). Snow on a non-winter date throws.
 */
export function resolveCaptureDate({ optionDate = null, itemDate = null, weather = null } = {}) {
    const explicit = optionDate || itemDate || null;
    const date = explicit || (weather?.snow ? DEFAULT_SNOW_CAPTURE_DATE : DEFAULT_CAPTURE_DATE);
    if (weather?.snow && inferSeasonFromDate(date) !== 'winter') {
        throw new Error(`Snow capture needs a winter date (December–February), received ${date}`);
    }
    return date;
}

/**
 * W2-Fix-B — a forced backend's definitive start failure (`worldBackendReason`
 * from IsometricRenderer `_noteWorldBackend`): a forced WebGPU that reported
 * no adapter, unavailable or failed to start will never present, so the
 * fence fails at once. Returns the reason, or null.
 */
export function definitiveBackendFailure(expectedBackend, reason) {
    if (expectedBackend !== 'webgpu' || typeof reason !== 'string') return null;
    return /\bwebgpu (?:unavailable\b|failed to start)|no-adapter/.test(reason) ? reason : null;
}

// The fence's diagnostic tail: grade key, warm terms, backend reason, snow.
export function describeFenceState(state) {
    const grade = state?.grade || null;
    return `gradeKey=${grade?.key ?? null} afterglow=${grade?.afterglow ?? null} rimStrength=${grade?.rimStrength ?? null} `
        + `worldBackendReason=${JSON.stringify(state?.worldBackendReason ?? null)} snowCover=${state?.snowCover ?? null} snowBucket=${state?.snowBucket ?? null}`;
}

/**
 * Merge newly captured cases into an existing `manifest.json` case list by
 * `caseId`, preserving prior captured cases in `--out` while updating any
 * re-captured `caseId` in place (so incremental `--case` runs never drop
 * earlier scenarios from `manifest.json`).
 */
export function mergeManifestCases(existingCases = [], nextCases = []) {
    const byId = new Map();
    for (const item of Array.isArray(existingCases) ? existingCases : []) {
        if (item?.caseId) byId.set(item.caseId, item);
    }
    for (const item of Array.isArray(nextCases) ? nextCases : []) {
        if (item?.caseId) byId.set(item.caseId, item);
    }
    return [...byId.values()];
}

export const DEFAULT_SCENARIOS = Object.freeze([
    { id: 'readme-noon', scenario: 'readme-showcase', hour: 12, weather: 'clear', zoom: 2, date: '2026-07-15', season: 'summer' },
    { id: 'readme-night', scenario: 'readme-showcase', hour: 22, weather: 'clear', zoom: 3, date: '2026-07-15', season: 'summer' },
    { id: 'harbor-blue', scenario: 'git-harbor', hour: 19.75, weather: 'clear', zoom: 1, date: '2026-07-15', season: 'summer' },
    { id: 'failed-push-golden', scenario: 'failed-push', hour: 18, weather: 'clear', zoom: 2, date: '2026-07-15', season: 'summer' },
    { id: 'dense-100-noon', scenario: 'dense-100-agents', hour: 12, weather: 'clear', zoom: 1, date: '2026-07-15', season: 'summer' },
    { id: 'winter-noon', scenario: 'readme-showcase', hour: 12, weather: 'clear', zoom: 1, date: '2026-01-15', season: 'winter' },
    { id: 'autumn-noon', scenario: 'readme-showcase', hour: 12, weather: 'clear', zoom: 1, date: '2026-11-19', season: 'autumn' },
    { id: 'spring-noon', scenario: 'readme-showcase', hour: 12, weather: 'clear', zoom: 1, date: '2026-04-20', season: 'spring' },
]);

/**
 * Pure-Node / in-page guard verifying Astra's green first-frame rule (Spec 01 §5).
 * Samples center pixel and an interior grid (16x12 inset 15% from edges).
 * Fails loudly if solid `#416139` dominates or distinct interior colors < 4.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba - top-left RGBA8 buffer
 * @param {number} width
 * @param {number} height
 * @returns {{ ok: boolean, reason: string|null, centerRgb: number[], greenFillShare: number, distinctInteriorColors: number, sampledPixels: number }}
 */
export function analyzeFrameReadback(rgba, width, height) {
    if (!rgba || width <= 0 || height <= 0 || rgba.length < width * height * 4) {
        return {
            ok: false,
            reason: 'invalid or empty RGBA readback buffer',
            centerRgb: [0, 0, 0],
            greenFillShare: 0,
            distinctInteriorColors: 0,
            sampledPixels: 0,
        };
    }
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const ci = (cy * width + cx) * 4;
    const centerRgb = [rgba[ci], rgba[ci + 1], rgba[ci + 2]];

    const x0 = Math.floor(width * 0.15);
    const x1 = Math.max(x0 + 1, Math.floor(width * 0.85));
    const y0 = Math.floor(height * 0.15);
    const y1 = Math.max(y0 + 1, Math.floor(height * 0.85));
    const cols = Math.min(16, x1 - x0);
    const rows = Math.min(12, y1 - y0);

    const distinct = new Set();
    let greenHits = 0;
    let sampledPixels = 0;
    for (let r = 0; r < rows; r++) {
        const y = rows === 1 ? y0 : Math.floor(y0 + (r * (y1 - 1 - y0)) / (rows - 1));
        for (let c = 0; c < cols; c++) {
            const x = cols === 1 ? x0 : Math.floor(x0 + (c * (x1 - 1 - x0)) / (cols - 1));
            const i = (y * width + x) * 4;
            const red = rgba[i];
            const green = rgba[i + 1];
            const blue = rgba[i + 2];
            sampledPixels++;
            distinct.add((red << 16) | (green << 8) | blue);
            if (red === GREEN_SWATCH_RGB[0] && green === GREEN_SWATCH_RGB[1] && blue === GREEN_SWATCH_RGB[2]) {
                greenHits++;
            }
        }
    }

    const greenFillShare = sampledPixels > 0 ? greenHits / sampledPixels : 0;
    const distinctInteriorColors = distinct.size;

    let reason = null;
    if (greenFillShare > MAX_GREEN_FILL_SHARE) {
        reason = `solid #416139 opening swatch captured (${(greenFillShare * 100).toFixed(1)}% of interior samples; center RGB ${centerRgb.join(',')})`;
    } else if (distinctInteriorColors < MIN_DISTINCT_INTERIOR_COLORS) {
        reason = `degenerate frame: only ${distinctInteriorColors} distinct interior color(s) (min ${MIN_DISTINCT_INTERIOR_COLORS}; center RGB ${centerRgb.join(',')})`;
    }

    return {
        ok: reason === null,
        reason,
        centerRgb,
        greenFillShare,
        distinctInteriorColors,
        sampledPixels,
    };
}

/**
 * Pure evaluator for Astra's strict present-generation capture fence (Spec 01 §5).
 * Returns `{ ready: boolean, pendingReasons: string[] }`.
 *
 * Supports both `presentGeneration` (once wired by W0 Integrator) and
 * `frameCount` fallback so the fence works before and after Integrator wiring.
 */
export function evaluateCaptureFenceState(state, {
    expectedSeason = null,
    expectedBackend = null,
    minPresentGeneration = 0,
    minSnowBucket = 0,
} = {}) {
    const pendingReasons = [];
    if (!state || typeof state !== 'object') {
        return { ready: false, pendingReasons: ['missing fence state'] };
    }
    if (!state.worldReadyAttr) pendingReasons.push('characterMode[data-world-ready] absent');
    if (state.worldStackOpacity !== 1) pendingReasons.push(`#worldStack opacity ${state.worldStackOpacity} != 1`);
    if (state.firstFrameReason !== null && state.firstFrameReason !== undefined && state.firstFrameReason !== '') {
        pendingReasons.push(`renderer._firstFrameReason=${state.firstFrameReason}`);
    }
    if (state.revealSnapshotPending) pendingReasons.push('renderer._revealSnapshotPending=true');
    if (state.assetsLoading === true) pendingReasons.push('assets still loading');
    if (state.terrainRestaging === true) pendingReasons.push('terrain restage in progress');
    if (expectedBackend && state.activeBackend !== expectedBackend) {
        pendingReasons.push(`activeBackend ${state.activeBackend} != expected ${expectedBackend}`);
    }
    if (expectedSeason) {
        if (!state.season || typeof state.season !== 'string' || state.season.trim() === '') {
            pendingReasons.push(`season missing/empty (expected ${expectedSeason})`);
        } else if (state.season !== expectedSeason) {
            pendingReasons.push(`season ${state.season} != expected ${expectedSeason}`);
        }
    }
    if (!state.terrainKey || typeof state.terrainKey !== 'string' || state.terrainKey.trim() === '') {
        pendingReasons.push('empty published terrain key');
    }
    if (minSnowBucket > 0 && !(Number(state.snowBucket) >= minSnowBucket)) {
        pendingReasons.push(`snowBucket ${state.snowBucket ?? null} < ${minSnowBucket}`);
    }
    const gen = Number.isFinite(state.presentGeneration) ? state.presentGeneration : state.fallbackFrameCount;
    if (!Number.isFinite(gen) || gen <= minPresentGeneration) {
        pendingReasons.push(`presentGeneration ${gen} did not advance past ${minPresentGeneration}`);
    }
    return {
        ready: pendingReasons.length === 0,
        pendingReasons,
    };
}

function encodePngBuffer(rgba, width, height) {
    const png = new PNG({ width, height });
    png.data.set(rgba);
    // Force opaque alpha on presented composite frames for lossless review.
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    return PNG.sync.write(png);
}

function inferSeasonFromDate(dateStr) {
    if (!dateStr) return null;
    const match = /^\d{4}-(\d{2})-\d{2}$/.exec(dateStr);
    if (!match) return null;
    const month = Number(match[1]);
    if (month === 12 || month <= 2) return 'winter';
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    return 'autumn';
}

function usage() {
    console.log(`Usage: node scripts/visual/capture.mjs [options]

Options:
  --scenarios=<list|all>  Scenario ids (default: readme-noon,readme-night)
  --case=<spec>           Ad-hoc scenario:hour:weather:zoom[:date], comma-separated
  --sizes=<list>          WIDTHxHEIGHT[@DPR] (default: 1920x1080)
  --backend=<mode>        webgpu | webgl | canvas (default: webgpu)
  --date=<YYYY-MM-DD>     Override fixed calendar date
  --motion=<mode>         reduce | no-preference (default: reduce)
  --settle=<n>            Consecutive identical readbacks required (default: 2)
  --out=<dir>             Output directory (default: output/visual-capture/<timestamp>)
  --golden-dir=<dir>      Golden root (default: claudeville/visual/golden)
  --accept                Write/update golden baselines in --golden-dir
  --allow-fallback        Do not fail on software fallback adapter
  --frontier              Enable WebGPU Frontier passes
  --authored-solar        Pin a zero day shift: authored diurnal keys at
                          06:00/12:30/18:00/18:27/19:45/22:00 on any date/host
  --url=<url>             Existing server URL (default: isolated ephemeral port)
  --headed                Show Chromium window
  --help                  Print this help`);
}

export function parseArgs(argv) {
    const opts = {
        scenarios: null,
        cases: [],
        sizes: [{ width: 1920, height: 1080, dpr: 1, label: '1920x1080' }],
        backend: 'webgpu',
        date: null,
        reducedMotion: true,
        settleFrames: 2,
        out: null,
        goldenDir: DEFAULT_GOLDEN_DIR,
        accept: false,
        allowFallback: false,
        frontier: false,
        authoredSolar: false,
        url: null,
        headed: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        if (arg === '--accept') { opts.accept = true; continue; }
        if (arg === '--allow-fallback') { opts.allowFallback = true; continue; }
        if (arg === '--authored-solar') { opts.authoredSolar = true; continue; }
        if (arg === '--frontier') { opts.frontier = true; continue; }
        if (arg === '--headed') { opts.headed = true; continue; }
        const [flag, inline] = arg.split('=', 2);
        const value = inline ?? argv[++i];
        if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
        switch (flag) {
            case '--scenarios':
                opts.scenarios = value === 'all'
                    ? [...DEFAULT_SCENARIOS]
                    : value.split(',').map((s) => s.trim()).filter(Boolean).map((id) => {
                        const hit = DEFAULT_SCENARIOS.find((item) => item.id === id);
                        if (!hit) throw new Error(`Unknown scenario id: ${id}`);
                        return hit;
                    });
                break;
            case '--case':
                for (const spec of value.split(',').map((s) => s.trim()).filter(Boolean)) {
                    const [scenario, hourStr, weather = 'clear', zoomStr = '1', date = null] = spec.split(':');
                    const hour = Number(hourStr);
                    const zoom = Number(zoomStr);
                    if (!scenario || !Number.isFinite(hour) || hour < 0 || hour >= 24) {
                        throw new Error(`Invalid --case spec: ${spec}`);
                    }
                    // W2-Fix-B — an unknown weather fails here, never as clear.
                    resolveCaptureWeather(weather);
                    opts.cases.push({
                        id: `${scenario}-h${String(hour).replace('.', 'p')}-${weather}-z${zoom}`,
                        scenario,
                        hour,
                        weather,
                        zoom,
                        date,
                        season: inferSeasonFromDate(date),
                    });
                }
                break;
            case '--sizes':
                opts.sizes = value.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
                    const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(item);
                    if (!m) throw new Error(`Invalid size: ${item}`);
                    return { width: Number(m[1]), height: Number(m[2]), dpr: Number(m[3] || 1), label: item };
                });
                break;
            case '--backend':
                if (!['webgpu', 'webgl', 'canvas'].includes(value)) throw new Error(`Unsupported backend: ${value}`);
                opts.backend = value;
                break;
            case '--date':
                opts.date = value;
                break;
            case '--motion':
                opts.reducedMotion = value !== 'no-preference';
                break;
            case '--settle':
                opts.settleFrames = Math.max(2, Number(value) || 2);
                break;
            case '--out':
                opts.out = value;
                break;
            case '--golden-dir':
                opts.goldenDir = path.resolve(ROOT, value);
                break;
            case '--url':
                opts.url = value;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    const baseList = opts.scenarios || (opts.cases.length ? [] : DEFAULT_SCENARIOS.slice(0, 2));
    opts.scenarios = [...baseList, ...opts.cases];
    if (opts.frontier && opts.backend !== 'webgpu') throw new Error('--frontier requires --backend=webgpu');
    return opts;
}

// ---------------------------------------------------------------------------
// In-page capture helpers (serialized into Playwright page context)
function installVisualCaptureHelpers() {
    const C = (window.__cvVisualCapture = {});

    const toBase64 = (bytes) => {
        if (!bytes) return null;
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    };

    const nextRaf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    C.readFenceState = () => {
        const app = window.__claudeVilleApp;
        const r = app?.renderer;
        const modeEl = document.querySelector('#characterMode[data-world-ready]');
        const stackEl = document.querySelector('#characterMode[data-world-ready] > #worldStack');
        const worldStackOpacity = stackEl ? Number(getComputedStyle(stackEl).opacity) : 0;
        const atmosphere = r?.atmosphereState || window.__claudeVilleAtmosphere;
        const terrainKey = typeof r?.terrainCacheKey === 'string' ? r.terrainCacheKey : '';
        const presentGeneration =
            Number.isFinite(r?.presentGeneration) ? r.presentGeneration
            : Number.isFinite(r?._presentGeneration) ? r._presentGeneration
            : Number.isFinite(r?.gpuWorld?.presentGeneration) ? r.gpuWorld.presentGeneration
            : null;
        const fallbackFrameCount =
            Number.isFinite(r?._frameCount) ? r._frameCount
            : Number.isFinite(r?._renderedFrames) ? r._renderedFrames
            : Number.isFinite(r?.gpuWorld?.frameCount) ? r.gpuWorld.frameCount
            : null;
        const assetStats = r?.assets?.cacheStats?.() || null;
        const assetsLoading = Boolean(r?.assets?.isLoading || (Number(assetStats?.pending) > 0));
        // W2-Fix-B — the frame's grade keys and warm terms, the backend's
        // own start reason, and the ground's snow (GroundState snowBucketOf).
        const grade = r?._lastAtmosphere?.lightGrade || null;
        const snowCover = Number(r?._groundState?.snowCover) || 0;
        const solar = r?._lastAtmosphere?.solar || null;
        return {
            bootState: app?._bootState || null,
            worldReadyAttr: Boolean(modeEl),
            worldStackOpacity,
            firstFrameReason: r?._firstFrameReason ?? null,
            revealSnapshotPending: Boolean(r?._revealSnapshotPending),
            assetsLoading,
            terrainRestaging: Boolean(r?._terrainRestage),
            lampSilhouetteMode: r?._lampSilhouetteMode ?? r?._lampSilhouetteGate ?? null,
            season: r?._terrainSeason || atmosphere?.getSeason?.() || atmosphere?.season || null,
            terrainKey,
            presentGeneration,
            fallbackFrameCount,
            activeBackend: r?.worldRendererMode || null,
            gpuWorldActive: r?.gpuWorld?.isActive?.() === true,
            worldBackendReason: r?.worldBackendReason ?? null,
            grade: grade ? { key: grade.key ?? null, afterglow: grade.afterglow ?? null, rimStrength: grade.rimStrength ?? null } : null,
            snowCover,
            snowBucket: snowCover <= 0 ? 0 : Math.min(4, Math.ceil(snowCover * 4 - 1e-9)),
            solar: solar ? {
                zone: solar.site?.zone ?? null,
                sunriseShift: solar.sunriseShift ?? null,
                sunsetShift: solar.sunsetShift ?? null,
                goldenShift: solar.goldenShift ?? null,
            } : null,
        };
    };

    C.pinAndPose = async ({ scenario, hour, weather, knots = null, zoom, authoredSolar = null }) => {
        const r = window.__claudeVilleApp.renderer;
        r._startLoop?.();
        r.cameraDirector?.setAutoMode?.(false);
        const atmosphere = r.atmosphereState || window.__claudeVilleAtmosphere;
        // W2-Fix-B — `--authored-solar`: the city's sun with a zero day
        // shift, so the grade keys sit at their authored minutes.
        if (authoredSolar) {
            if (typeof atmosphere?.setSolarSite !== 'function') throw new Error('--authored-solar: atmosphereState.setSolarSite is unavailable');
            atmosphere.setSolarSite({ zone: authoredSolar.zone, dayShift: { ...authoredSolar.dayShift } });
        }
        atmosphere?.setTimelineMode?.('fixed');
        atmosphere?.setHour?.(hour);
        // W2-Fix-B — a pinned timeline (snow: frozen rain every day), so the
        // ground history the terrain bakes from is the weather's own.
        if (knots) atmosphere?.setTimelineKnots?.(knots);
        if (weather) atmosphere?.setWeather?.(weather);
        // Pin wind cloud drift and calm MarkGovernor if present.
        if (r.wind && typeof r.wind.cloudCourseDrift === 'number') r.wind.cloudCourseDrift = 0;
        r.markGovernor?.setCalm?.(true);

        const camera = r.camera;
        camera.abortDirectorGlide?.();
        camera.noteUserInput?.();
        const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
        const { getWorldScenario } = await import('/src/presentation/character-mode/__simfixture__/WorldScenarios.js');
        const meta = getWorldScenario(scenario);
        const tile = meta?.metadata?.camera?.centerTile || { tileX: 20, tileY: 20 };
        const point = tileToWorld({ tileX: tile.tileX, tileY: tile.tileY });
        r.setCameraPose({ x: point.x, y: point.y, zoom: camera.tierZoom(zoom) });
        r.gpuWorld?.qualityLadder?.setOverride?.(0);

        const before = C.readFenceState();
        // Force at least two real compositor ticks after pose so GPU/Canvas presents.
        await nextRaf();
        await nextRaf();
        return {
            scenarioResolved: meta?.id || null,
            beforePresentGeneration: before.presentGeneration ?? before.fallbackFrameCount ?? 0,
            pose: { x: point.x, y: point.y, zoom: camera.zoom, tile },
        };
    };

    const snapshotSources = (records) => {
        const copies = new Map();
        const snap = (source) => {
            if (!source || !(source instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas))) {
                return source;
            }
            if (copies.has(source)) return copies.get(source);
            let copy = source;
            if (source.width > 0 && source.height > 0) {
                copy = document.createElement('canvas');
                copy.width = source.width;
                copy.height = source.height;
                const g = copy.getContext('2d');
                g.imageSmoothingEnabled = false;
                g.drawImage(source, 0, 0);
            }
            copies.set(source, copy);
            return copy;
        };
        return records.map((record) => {
            const out = { ...record };
            for (const key of ['source', 'image', 'materialSource', 'sidecar', 'emissiveSource', 'occluderSource']) {
                if (record[key]) out[key] = snap(record[key]);
            }
            for (const key of ['textureUpdates', 'materialTextureUpdates', 'emissiveTextureUpdates', 'occluderTextureUpdates']) {
                if (Array.isArray(record[key])) out[key] = record[key].map((u) => ({ ...u, source: snap(u.source) }));
            }
            return out;
        });
    };

    const readCanvasWorld = (renderer) => {
        const world = renderer.canvas || renderer.worldCanvas || document.getElementById('worldCanvas') || document.querySelector('#worldStack canvas');
        if (!world || world.width <= 0 || world.height <= 0) return null;
        const width = world.width;
        const height = world.height;
        const tmp = document.createElement('canvas');
        tmp.width = width;
        tmp.height = height;
        const g = tmp.getContext('2d', { willReadFrequently: true });
        // Composite the exact presented Canvas stack:
        // 1. Base 2D world canvas (#worldCanvas — graded directly when PostFx
        //    is inactive, or ungraded 2D source when hybrid PostFx grades onto
        //    #worldFxCanvas).
        g.drawImage(world, 0, 0, width, height);
        // 2. Hybrid PostFx canvas (#worldFxCanvas) when visible: carries the
        //    graded night/day world frame over #worldCanvas.
        const fx = renderer.fxCanvas || document.getElementById('worldFxCanvas');
        const fxVisible = Boolean(
            fx && fx.width > 0 && fx.height > 0
            && fx.style?.display !== 'none'
            && getComputedStyle(fx).display !== 'none',
        );
        if (fxVisible) {
            g.drawImage(fx, 0, 0, width, height);
        }
        // 3. Ungraded upper overlay (#worldOverlayCanvas: emitter cuts, water
        //    columns, weather foreground, fireflies, marks, labels).
        const overlay = renderer.overlayCanvas || document.getElementById('worldOverlayCanvas');
        if (overlay && overlay.width > 0 && overlay.height > 0 && overlay.style?.display !== 'none') {
            g.drawImage(overlay, 0, 0, width, height);
        }
        const data = g.getImageData(0, 0, width, height).data;
        return {
            width,
            height,
            composite: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            scene: null,
            emission: null,
            attribution: null,
            attributionFormat: null,
            source: fxVisible ? 'canvas-postfx-composite' : 'canvas-overlay-composite',
        };
    };

    const flipRows = (bytes, width, height) => {
        const row = width * 4;
        const out = new Uint8Array(bytes.length);
        for (let y = 0; y < height; y++) {
            out.set(bytes.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        }
        return out;
    };

    const readWebglFallback = (gpuWorld, renderer) => {
        const gl = gpuWorld?.gl || renderer?.fxCanvas?.getContext?.('webgl2');
        if (!gl) return null;
        if (typeof gpuWorld?.ensureFreshOutput === 'function' && !gpuWorld.ensureFreshOutput()) return null;
        const width = gpuWorld?.width || gl.drawingBufferWidth || renderer?.fxCanvas?.width || 0;
        const height = gpuWorld?.height || gl.drawingBufferHeight || renderer?.fxCanvas?.height || 0;
        if (width <= 0 || height <= 0) return null;
        const read = (framebuffer, buffer) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.readBuffer(buffer);
            const bytes = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            return gl.getError() === gl.NO_ERROR ? flipRows(bytes, width, height) : null;
        };
        const composite = read(null, gl.BACK);
        const target = gpuWorld?.sceneTarget;
        const scene = target?.framebuffer ? read(target.framebuffer, gl.COLOR_ATTACHMENT0) : null;
        const emission = target?.framebuffer && target.attachments >= 2 ? read(target.framebuffer, gl.COLOR_ATTACHMENT1) : null;
        if (target?.framebuffer) gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!composite) return null;
        return {
            width,
            height,
            composite,
            scene,
            emission,
            attribution: null,
            attributionFormat: null,
            source: 'webgl-readPixels',
        };
    };

    const readGpuTargets = async (gpuWorld, renderer) => {
        if (typeof gpuWorld.debugCaptureTargets === 'function') {
            const cap = await gpuWorld.debugCaptureTargets({ includeAttribution: true });
            if (!cap) return null;
            const attrBytes = cap.attribution
                ? new Uint8Array(cap.attribution.buffer || cap.attribution, cap.attribution.byteOffset || 0, cap.attribution.byteLength || cap.attribution.length)
                : null;
            const attrFormat = cap.attributionFormat
                || (cap.attribution instanceof Uint32Array ? 'r32uint' : attrBytes ? 'rgba8' : null);
            return {
                width: cap.width,
                height: cap.height,
                composite: cap.composite ? new Uint8Array(cap.composite.buffer || cap.composite, cap.composite.byteOffset || 0, cap.composite.byteLength || cap.composite.length) : null,
                scene: cap.scene ? new Uint8Array(cap.scene.buffer || cap.scene, cap.scene.byteOffset || 0, cap.scene.byteLength || cap.scene.length) : null,
                emission: cap.emission ? new Uint8Array(cap.emission.buffer || cap.emission, cap.emission.byteOffset || 0, cap.emission.byteLength || cap.emission.length) : null,
                attribution: attrBytes,
                attributionFormat: attrFormat,
                source: 'debugCaptureTargets',
            };
        }
        return readWebglFallback(gpuWorld, renderer);
    };

    C.freezeAndCapture = async ({ settleFrames = 2, seaSettleMs = 10_000, seaSettleRenders = 240 } = {}) => {
        const r = window.__claudeVilleApp.renderer;
        // Opus P0-3 night reproducibility: wait for pending asset loads /
        // terrain restages and run 2 real render ticks after pose+hour+weather
        // so `_lampSilhouetteMode`, `brazierFlames`, and Command banner settle
        // deterministically before stopping the loop and freezing records.
        const settleDeadline = Date.now() + 10_000;
        while (Date.now() < settleDeadline) {
            const state = C.readFenceState();
            if (!state.assetsLoading && !state.terrainRestaging) break;
            await nextRaf();
        }
        let prevLampMode = r._lampSilhouetteMode ?? r._lampSilhouetteGate ?? null;
        await nextRaf();
        await nextRaf();
        if ((r._lampSilhouetteMode ?? r._lampSilhouetteGate ?? null) !== prevLampMode) {
            await nextRaf();
            await nextRaf();
        }

        let gpuRecordFlags = null;
        try {
            const policy = await import('/src/presentation/character-mode/gpu/GpuWorldPolicy.js');
            gpuRecordFlags = policy?.GPU_RECORD_FLAGS || null;
        } catch {}

        const resolveFlags = (rec) => {
            let bits = Number.isFinite(rec?.flags) ? (rec.flags | 0) : 0;
            if (gpuRecordFlags && rec && typeof rec === 'object') {
                for (const [name, bit] of Object.entries(gpuRecordFlags)) {
                    if (rec[name] === true) bits |= bit;
                }
            }
            return bits >>> 0;
        };

        r._stopLoop?.();
        const gpu = r.gpuWorld;
        const isGpu = gpu?.isActive?.() === true;
        const ctx = r._gpuRenderContext;
        let frozenFrame = null;
        if (isGpu && ctx?.records?.length) {
            const sunShade = ctx.feed?.sunShade;
            const shadeTex = sunShade?.texture;
            frozenFrame = {
                forceFreshOutput: true,
                records: snapshotSources(ctx.records),
                camera: ctx.camera,
                feed: {
                    ...ctx.feed,
                    sunShade: shadeTex ? { ...sunShade, texture: { ...shadeTex, data: shadeTex.data.slice() } } : null,
                },
                particles: ctx.particles || null,
                marks: ctx.marks ? snapshotSources(ctx.marks) : null,
                sceneCommands: ctx.sceneCommands,
            };
        }

        // W2-Fix-B — Canvas: the sea chunks (CanvasWaterState deep field and
        // swell caps) build within a per-frame budget, so render until a
        // frame builds none (and no drift swap is pending), yielding a real
        // animation frame between renders, bounded in time and count.
        const canvasSea = { settled: true, renders: 0, capBuilds: null, chunks: null };
        if (!(isGpu && frozenFrame)) {
            const seaSignature = () => {
                const water = r._canvasWater;
                if (!water) return null;
                return `${water.stats?.capBuilds ?? 0}|${water.chunks?.size ?? 0}|${water.caps?.size ?? 0}|${water.nextCaps ? 'swap' : ''}`;
            };
            const seaDeadline = Date.now() + seaSettleMs;
            let previous = seaSignature();
            let quiet = 0;
            canvasSea.settled = false;
            while (canvasSea.renders < seaSettleRenders && Date.now() < seaDeadline) {
                r.renderNow?.();
                canvasSea.renders++;
                await nextRaf();
                const next = seaSignature();
                quiet = next !== null && next === previous && !r._canvasWater?.nextCaps ? quiet + 1 : 0;
                previous = next;
                if (quiet >= 2 || next === null) { canvasSea.settled = true; break; }
            }
            canvasSea.capBuilds = r._canvasWater?.stats?.capBuilds ?? null;
            canvasSea.chunks = r._canvasWater?.chunks?.size ?? null;
        }

        let prevComposite = null;
        let finalCap = null;
        let identicalStreak = 0;
        const maxAttempts = Math.max(settleFrames + 2, 4);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (isGpu && frozenFrame) {
                gpu.qualityLadder?.setOverride?.(0);
                gpu.prepareFrame?.(frozenFrame.feed);
                gpu.render(frozenFrame);
                if (gpu.backend === 'webgpu') await gpu.drain?.();
                finalCap = await readGpuTargets(gpu, r);
            } else {
                // Yield a real frame between Canvas attempts (budgets and
                // chunked work advance on the frame clock).
                if (attempt > 0) await nextRaf();
                r.renderNow?.();
                finalCap = readCanvasWorld(r);
            }
            if (!finalCap?.composite) break;
            if (prevComposite && prevComposite.length === finalCap.composite.length) {
                let same = true;
                for (let i = 0; i < prevComposite.length; i++) {
                    if (prevComposite[i] !== finalCap.composite[i]) { same = false; break; }
                }
                if (same) {
                    identicalStreak++;
                    if (identicalStreak >= settleFrames - 1) break;
                } else {
                    identicalStreak = 0;
                }
            }
            prevComposite = finalCap.composite.slice();
        }

        const gpuDiag = gpu?.getDiagnostics?.() || null;
        const canvasBudget = r.getCanvasBudget?.() || null;
        const pathDiag = r.pathfinder?.getDiagnostics?.() || null;
        const adapterInfo = gpu?.adapterInfo || gpuDiag?.adapter || null;
        const ladderLevel = gpu?.qualityLadder?.getLevel?.() ?? (isGpu ? null : 0);

        return {
            backend: r.worldRendererMode || 'canvas',
            width: finalCap?.width ?? 0,
            height: finalCap?.height ?? 0,
            source: finalCap?.source || null,
            selfStableBytes: identicalStreak >= settleFrames - 1,
            canvasSea,
            ladderLevel,
            cameraPose: { ...r.camera.screenToWorld(r.camera._viewportWidth() / 2, r.camera._viewportHeight() / 2), zoom: r.camera.zoom },
            frontier: { featureMask: gpuDiag?.frontier?.featureMask ?? 0 },
            substrateRevision: gpu?.substrateRevision ?? 0,
            adapter: adapterInfo ? {
                vendor: adapterInfo.vendor || null,
                architecture: adapterInfo.architecture || null,
                fallback: Boolean(adapterInfo.isFallbackAdapter ?? adapterInfo.fallback ?? false),
            } : { vendor: null, architecture: null, fallback: false },
            records: (frozenFrame?.records || []).map((rec, index) => ({
                index,
                id: rec.id || rec.debugId || rec.key || `record:${index}`,
                layer: rec.layer ?? 0,
                flags: resolveFlags(rec),
            })),
            marksCount: frozenFrame?.marks?.length || 0,
            telemetry: {
                canvasBudget,
                cacheStats: canvasBudget?.cacheStats || null,
                gpuDiag,
                pathDiag,
                gpuTimerSupported: Boolean(gpuDiag?.gpuTimerSupported ?? gpuDiag?.timestamps?.supported),
                gpuPassTimestampsMs: gpuDiag?.passTimestampsMs || null,
            },
            compositeBase64: toBase64(finalCap?.composite),
            sceneBase64: toBase64(finalCap?.scene),
            emissionBase64: toBase64(finalCap?.emission),
            attributionBase64: toBase64(finalCap?.attribution),
            attributionFormat: finalCap?.attributionFormat || null,
        };
    };
}

async function waitForStrictCaptureFence(page, { expectedSeason, expectedBackend = null, minPresentGeneration, minSnowBucket = 0, timeoutMs = 30_000 }) {
    const start = Date.now();
    let lastState = null;
    let lastEval = null;
    while (Date.now() - start < timeoutMs) {
        lastState = await page.evaluate(() => window.__cvVisualCapture.readFenceState());
        lastEval = evaluateCaptureFenceState(lastState, { expectedSeason, expectedBackend, minPresentGeneration, minSnowBucket });
        if (lastEval.ready) return { state: lastState, elapsedMs: Date.now() - start };
        // W2-Fix-B — a forced WebGPU that reported no adapter / unavailable
        // never presents: fail now with its reason, not after the timeout.
        const failure = definitiveBackendFailure(expectedBackend, lastState?.worldBackendReason);
        if (failure) {
            throw new Error(`Capture fence failed fast: forced --backend=${expectedBackend} did not start (${failure}); ${describeFenceState(lastState)}`);
        }
        await page.waitForTimeout(100);
    }
    throw new Error(
        `Capture fence timed out after ${timeoutMs}ms: pending=[${(lastEval?.pendingReasons || []).join('; ')}] `
        + `backend=${lastState?.activeBackend} terrainKey=${JSON.stringify(lastState?.terrainKey)} `
        + `season=${lastState?.season} firstFrameReason=${lastState?.firstFrameReason} ${describeFenceState(lastState)}`,
    );
}

export async function captureVisualRun(options) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.resolve(ROOT, options.out || path.join('output', 'visual-capture', stamp));
    mkdirSync(outDir, { recursive: true });
    const server = await resolveServer(options.url);
    const browser = await launchChromium({ headless: !options.headed, args: [...GPU_LAUNCH_ARGS] });
    const results = [];

    try {
        for (const size of options.sizes) {
            for (const item of options.scenarios) {
                const caseId = `${item.id}-${size.label.replace('@', 'dpr')}-${options.backend}`;
                const caseDir = path.join(outDir, caseId);
                mkdirSync(caseDir, { recursive: true });

                // W2-Fix-B — resolve the weather and date before any browser
                // work: an unknown weather key or a snow case off-winter throws.
                const weather = resolveCaptureWeather(item.weather);
                const effectiveDate = resolveCaptureDate({ optionDate: options.date, itemDate: item.date, weather });
                const context = await browser.newContext({
                    viewport: { width: size.width, height: size.height },
                    deviceScaleFactor: size.dpr,
                    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
                    // W2-Fix-B — the village's zone, never the host's.
                    timezoneId: CAPTURE_TIMEZONE,
                });
                await context.addInitScript(() => {
                    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
                });
                const page = await context.newPage();
                const expectedSeason = inferSeasonFromDate(effectiveDate) || item.season || null;
                await page.clock.setFixedTime(captureInstant(effectiveDate));
                const pageErrors = [];
                page.on('pageerror', (err) => pageErrors.push(String(err?.message || err).slice(0, 300)));
                page.on('console', (msg) => {
                    if (msg.type() === 'error') pageErrors.push(msg.text().slice(0, 300));
                });

                try {
                    const url = new URL(`${server.baseUrl}/`);
                    url.searchParams.set('sim', '1');
                    if (options.frontier) url.searchParams.set('frontier', '1');
                    url.searchParams.set('scenario', item.scenario);
                    url.searchParams.set('renderer', options.backend);
                    await page.goto(url.href, { waitUntil: 'load', timeout: 60_000 });
                    await page.waitForFunction(
                        () => window.__claudeVilleApp?._bootState === 'ready' && Boolean(window.__claudeVilleApp?.renderer?.camera),
                        null,
                        { timeout: 60_000 },
                    );
                    await page.evaluate(`(${installVisualCaptureHelpers.toString()})()`);
                    await page.keyboard.press('Escape');

                    const posed = await page.evaluate((a) => window.__cvVisualCapture.pinAndPose(a), {
                        scenario: item.scenario,
                        hour: item.hour,
                        weather: weather.profile,
                        knots: weather.knots,
                        zoom: item.zoom,
                        authoredSolar: options.authoredSolar ? { zone: CAPTURE_TIMEZONE, dayShift: AUTHORED_DAY_SHIFT } : null,
                    });

                    // Wait for Astra's strict present-generation capture fence.
                    const fenced = await waitForStrictCaptureFence(page, {
                        expectedSeason,
                        expectedBackend: options.backend,
                        minPresentGeneration: posed.beforePresentGeneration,
                        minSnowBucket: weather.minSnowBucket,
                    });
                    if (weather.snow && !(fenced.state.snowCover >= weather.minSnowCover)) {
                        throw new Error(`Snow capture ${caseId}: snowCover ${fenced.state.snowCover} < ${weather.minSnowCover}; ${describeFenceState(fenced.state)}`);
                    }
                    if (options.authoredSolar) {
                        const shift = fenced.state.solar;
                        if (!shift || shift.sunriseShift !== 0 || shift.sunsetShift !== 0 || shift.goldenShift !== 0) {
                            throw new Error(`--authored-solar did not pin a zero day shift for ${caseId}: ${JSON.stringify(shift)}`);
                        }
                    }

                    if (options.frontier) {
                        await page.waitForFunction(() => {
                            const d = window.__claudeVilleApp.renderer.gpuWorld?.getDiagnostics().frontier;
                            return d?.enabled && ['surfaceDepth', 'mirror', 'ripples', 'shafts', 'wind'].every(name => {
                                const pass = d.passes[name];
                                if (pass?.error) throw Error(name + ' failed to prepare: ' + pass.error);
                                return pass?.ready;
                            }) && (d.featureMask & 5) === 5;
                        }, null, { timeout: 60000 });
                    }
                    const captured = await page.evaluate(
                        (a) => window.__cvVisualCapture.freezeAndCapture(a),
                        { settleFrames: options.settleFrames, seaSettleMs: CANVAS_SEA_SETTLE_MS, seaSettleRenders: CANVAS_SEA_SETTLE_RENDERS },
                    );
                    if (captured.backend === 'canvas' && captured.canvasSea && !captured.canvasSea.settled) {
                        throw new Error(`Canvas sea chunks still building for ${caseId} after ${captured.canvasSea.renders} renders (${JSON.stringify(captured.canvasSea)})`);
                    }

                    // Hard fail on silent backend fallback (e.g. webgpu/webgl -> canvas).
                    if (captured.backend !== options.backend) {
                        throw new Error(`Hard fail: active backend ${captured.backend} !== requested --backend=${options.backend}`);
                    }
                    // Hard fail on fallback adapter or non-FULL quality ladder on GPU backends.
                    if (options.backend !== 'canvas' && !options.allowFallback && captured.adapter?.fallback === true) {
                        throw new Error(`Hard fail: adapter.fallback === true on ${options.backend}`);
                    }
                    if (options.backend !== 'canvas' && captured.ladderLevel !== 0) {
                        throw new Error(`Hard fail: qualityLadder level ${captured.ladderLevel} !== 0`);
                    }
                    if (!captured.compositeBase64) {
                        throw new Error(`No composite readback produced for ${caseId}`);
                    }

                    const compositeBytes = Buffer.from(captured.compositeBase64, 'base64');
                    const guard = analyzeFrameReadback(compositeBytes, captured.width, captured.height);
                    if (!guard.ok) {
                        throw new Error(
                            `Green/degenerate first-frame guard failed for ${caseId}: ${guard.reason} `
                            + `(backend=${captured.backend}, terrainKey=${fenced.state.terrainKey}, pose=${JSON.stringify(posed.pose)})`,
                        );
                    }

                    writeFileSync(path.join(caseDir, 'composite.png'), encodePngBuffer(compositeBytes, captured.width, captured.height));
                    if (captured.sceneBase64) {
                        const sceneBytes = Buffer.from(captured.sceneBase64, 'base64');
                        writeFileSync(path.join(caseDir, 'scene.png'), encodePngBuffer(sceneBytes, captured.width, captured.height));
                    }
                    if (captured.emissionBase64) {
                        const emBytes = Buffer.from(captured.emissionBase64, 'base64');
                        writeFileSync(path.join(caseDir, 'emission.png'), encodePngBuffer(emBytes, captured.width, captured.height));
                    }
                    if (captured.attributionBase64) {
                        writeFileSync(path.join(caseDir, 'attribution.bin'), Buffer.from(captured.attributionBase64, 'base64'));
                    }

                    const meta = {
                        schemaVersion: 1,
                        caseId,
                        capturedAt: new Date().toISOString(),
                        scenario: item.scenario,
                        hour: item.hour,
                        weather: item.weather,
                        zoom: item.zoom,
                        date: effectiveDate || null,
                        timezone: CAPTURE_TIMEZONE,
                        season: fenced.state.season,
                        backend: captured.backend,
                        worldBackendReason: fenced.state.worldBackendReason ?? null,
                        // W2-Fix-B — the frame's grade keys (`from>to`) and warm terms.
                        gradeKey: fenced.state.grade?.key ?? null,
                        afterglow: fenced.state.grade?.afterglow ?? null,
                        rimStrength: fenced.state.grade?.rimStrength ?? null,
                        solar: { authored: options.authoredSolar, ...(fenced.state.solar || {}) },
                        weatherProfile: weather.profile,
                        snow: weather.snow ? { cover: fenced.state.snowCover, bucket: fenced.state.snowBucket, minBucket: weather.minSnowBucket } : null,
                        backing: [captured.width, captured.height],
                        dpr: size.dpr,
                        adapter: captured.adapter,
                        cameraPose: captured.cameraPose, frontier: captured.frontier, substrateRevision: captured.substrateRevision,
                        determinism: {
                            selfStableBytes: captured.selfStableBytes,
                            ladderLevel: captured.ladderLevel,
                            nondeterministicMasks: [],
                            canvasSea: captured.backend === 'canvas' ? captured.canvasSea : null,
                        },
                        fence: {
                            elapsedMs: fenced.elapsedMs,
                            terrainKey: fenced.state.terrainKey,
                            presentGeneration: fenced.state.presentGeneration ?? fenced.state.fallbackFrameCount,
                            centerRgb: guard.centerRgb,
                            greenFillShare: guard.greenFillShare,
                            distinctInteriorColors: guard.distinctInteriorColors,
                        },
                        attributionFormat: captured.attributionFormat,
                        recordsCount: captured.records.length,
                        marksCount: captured.marksCount,
                        records: captured.records,
                        telemetry: captured.telemetry,
                        pageErrors: [...new Set(pageErrors)].slice(0, 10),
                    };
                    writeFileSync(path.join(caseDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

                    if (options.accept) {
                        if (!captured.selfStableBytes) {
                            throw new Error(`Refusing --accept for ${caseId}: readback was not byte-identical across settle passes (selfStableBytes=false)`);
                        }
                        const goldenCaseDir = path.join(options.goldenDir, caseId);
                        mkdirSync(goldenCaseDir, { recursive: true });
                        cpSync(caseDir, goldenCaseDir, { recursive: true, force: true });
                    }

                    results.push({ caseId, status: 'ok', caseDir, meta });
                    console.log(`[visual:capture] OK ${caseId} (${captured.width}x${captured.height}, stable=${captured.selfStableBytes}, distinct=${guard.distinctInteriorColors})`);
                } finally {
                    await context.close();
                }
            }
        }
    } finally {
        await browser.close();
        await server.stop();
    }

    const manifestPath = path.join(outDir, 'manifest.json');
    let priorCases = [];
    if (existsSync(manifestPath)) {
        try {
            const prior = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (Array.isArray(prior?.cases)) priorCases = prior.cases;
        } catch {}
    }
    const nextCases = results.map((r) => ({
        caseId: r.caseId,
        status: r.status,
        scenario: r.meta.scenario,
        hour: r.meta.hour,
        weather: r.meta.weather,
        zoom: r.meta.zoom,
        date: r.meta.date,
        backend: r.meta.backend,
        gradeKey: r.meta.gradeKey,
        backing: r.meta.backing,
        selfStableBytes: r.meta.determinism.selfStableBytes,
    }));
    const summary = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model || null },
        outDir,
        acceptedToGolden: options.accept ? options.goldenDir : null,
        cases: mergeManifestCases(priorCases, nextCases),
    };
    writeFileSync(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        usage();
        process.exit(0);
    }
    captureVisualRun(opts).catch((error) => {
        console.error(`[visual:capture] FAIL: ${error.stack || error.message}`);
        process.exit(1);
    });
}
