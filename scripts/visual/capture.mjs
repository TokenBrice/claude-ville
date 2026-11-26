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
//     --url=<url>             Existing server URL (default: isolated ephemeral port)
//     --headed                Show browser window
//     --help                  Show help

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { launchChromium } from '../smoke/support/chromium.mjs';
import { BENCH_WEATHER, GPU_LAUNCH_ARGS, resolveServer } from '../smoke/support/world-bench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_GOLDEN_DIR = path.join(ROOT, 'claudeville', 'visual', 'golden');

// Astra 01 §5 causal control: daytime reduced-motion CSS opening land fill.
export const GREEN_SWATCH_RGB = Object.freeze([65, 97, 57]); // #416139
export const MIN_DISTINCT_INTERIOR_COLORS = 4;
export const MAX_GREEN_FILL_SHARE = 0.50;

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
    minPresentGeneration = 0,
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
    if (expectedSeason && state.season && state.season !== expectedSeason) {
        pendingReasons.push(`season ${state.season} != expected ${expectedSeason}`);
    }
    if (!state.terrainKey || typeof state.terrainKey !== 'string' || state.terrainKey.trim() === '') {
        pendingReasons.push('empty published terrain key');
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
        url: null,
        headed: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        if (arg === '--accept') { opts.accept = true; continue; }
        if (arg === '--allow-fallback') { opts.allowFallback = true; continue; }
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
        const terrainKey =
            r?._terrainArtifactKey
            || r?._lastTerrainKey
            || r?._terrainBakedKey
            || r?.terrainKey
            || (r?._terrainCanvas ? `canvas:${r._terrainCanvas.width}x${r._terrainCanvas.height}` : '')
            || (r?.gpuWorld?._terrainTexture ? 'gpu:terrain-bound' : '');
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
        return {
            bootState: app?._bootState || null,
            worldReadyAttr: Boolean(modeEl),
            worldStackOpacity,
            firstFrameReason: r?._firstFrameReason ?? null,
            revealSnapshotPending: Boolean(r?._revealSnapshotPending),
            season: r?._terrainSeason || atmosphere?.getSeason?.() || atmosphere?.season || null,
            terrainKey: String(terrainKey || ''),
            presentGeneration,
            fallbackFrameCount,
            activeBackend: r?.worldRendererMode || null,
            gpuWorldActive: r?.gpuWorld?.isActive?.() === true,
        };
    };

    C.pinAndPose = async ({ scenario, hour, weather, zoom }) => {
        const r = window.__claudeVilleApp.renderer;
        r._startLoop?.();
        r.cameraDirector?.setAutoMode?.(false);
        const atmosphere = r.atmosphereState || window.__claudeVilleAtmosphere;
        atmosphere?.setTimelineMode?.('fixed');
        atmosphere?.setHour?.(hour);
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
        const canvas = renderer.worldCanvas || document.getElementById('worldCanvas') || document.querySelector('#worldStack canvas');
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const g = tmp.getContext('2d', { willReadFrequently: true });
        g.drawImage(canvas, 0, 0);
        const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
        return {
            width: canvas.width,
            height: canvas.height,
            composite: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            scene: null,
            emission: null,
            attribution: null,
            attributionFormat: null,
            source: 'canvas-getImageData',
        };
    };

    const readGpuTargets = async (gpuWorld) => {
        if (typeof gpuWorld.debugCaptureTargets === 'function') {
            const cap = await gpuWorld.debugCaptureTargets();
            if (!cap) return null;
            return {
                width: cap.width,
                height: cap.height,
                composite: cap.composite ? new Uint8Array(cap.composite.buffer || cap.composite, cap.composite.byteOffset || 0, cap.composite.byteLength || cap.composite.length) : null,
                scene: cap.scene ? new Uint8Array(cap.scene.buffer || cap.scene, cap.scene.byteOffset || 0, cap.scene.byteLength || cap.scene.length) : null,
                emission: cap.emission ? new Uint8Array(cap.emission.buffer || cap.emission, cap.emission.byteOffset || 0, cap.emission.byteLength || cap.emission.length) : null,
                attribution: cap.attribution ? new Uint8Array(cap.attribution.buffer || cap.attribution, cap.attribution.byteOffset || 0, cap.attribution.byteLength || cap.attribution.length) : null,
                attributionFormat: cap.attributionFormat || (cap.attribution instanceof Uint32Array ? 'r32uint' : cap.attribution ? 'rgba8' : null),
                source: 'debugCaptureTargets',
            };
        }
        return null;
    };

    C.freezeAndCapture = async ({ settleFrames = 2 } = {}) => {
        const r = window.__claudeVilleApp.renderer;
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
                finalCap = await readGpuTargets(gpu);
            } else {
                r._renderSingleFrame?.();
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
            ladderLevel,
            adapter: adapterInfo ? {
                vendor: adapterInfo.vendor || null,
                architecture: adapterInfo.architecture || null,
                fallback: Boolean(adapterInfo.isFallbackAdapter ?? adapterInfo.fallback ?? false),
            } : { vendor: null, architecture: null, fallback: false },
            records: (frozenFrame?.records || []).map((rec, index) => ({
                index,
                id: rec.id || rec.debugId || rec.key || `record:${index}`,
                layer: rec.layer ?? 0,
                flags: rec.flags ?? 0,
            })),
            marksCount: frozenFrame?.marks?.length || 0,
            telemetry: {
                canvasBudget,
                gpuDiag,
                pathDiag,
                gpuTimerSupported: Boolean(gpuDiag?.gpuTimerSupported),
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

async function waitForStrictCaptureFence(page, { expectedSeason, minPresentGeneration, timeoutMs = 30_000 }) {
    const start = Date.now();
    let lastState = null;
    let lastEval = null;
    while (Date.now() - start < timeoutMs) {
        lastState = await page.evaluate(() => window.__cvVisualCapture.readFenceState());
        lastEval = evaluateCaptureFenceState(lastState, { expectedSeason, minPresentGeneration });
        if (lastEval.ready) return { state: lastState, elapsedMs: Date.now() - start };
        await page.waitForTimeout(100);
    }
    throw new Error(
        `Capture fence timed out after ${timeoutMs}ms: pending=[${(lastEval?.pendingReasons || []).join('; ')}] `
        + `backend=${lastState?.activeBackend} terrainKey=${JSON.stringify(lastState?.terrainKey)} `
        + `season=${lastState?.season} firstFrameReason=${lastState?.firstFrameReason}`,
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

                const context = await browser.newContext({
                    viewport: { width: size.width, height: size.height },
                    deviceScaleFactor: size.dpr,
                    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
                });
                await context.addInitScript(() => {
                    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
                });
                const page = await context.newPage();
                const effectiveDate = options.date || item.date;
                const expectedSeason = inferSeasonFromDate(effectiveDate) || item.season || null;
                if (effectiveDate) {
                    await page.clock.setFixedTime(new Date(`${effectiveDate}T12:00:00`));
                }
                const pageErrors = [];
                page.on('pageerror', (err) => pageErrors.push(String(err?.message || err).slice(0, 300)));
                page.on('console', (msg) => {
                    if (msg.type() === 'error') pageErrors.push(msg.text().slice(0, 300));
                });

                try {
                    const url = new URL(`${server.baseUrl}/`);
                    url.searchParams.set('sim', '1');
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
                        weather: BENCH_WEATHER[item.weather] || BENCH_WEATHER.clear,
                        zoom: item.zoom,
                    });

                    // Wait for Astra's strict present-generation capture fence.
                    const fenced = await waitForStrictCaptureFence(page, {
                        expectedSeason,
                        minPresentGeneration: posed.beforePresentGeneration,
                    });

                    const captured = await page.evaluate(
                        (a) => window.__cvVisualCapture.freezeAndCapture(a),
                        { settleFrames: options.settleFrames },
                    );

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
                        season: fenced.state.season,
                        backend: captured.backend,
                        backing: [captured.width, captured.height],
                        dpr: size.dpr,
                        adapter: captured.adapter,
                        determinism: {
                            selfStableBytes: captured.selfStableBytes,
                            ladderLevel: captured.ladderLevel,
                            nondeterministicMasks: [],
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

    const summary = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model || null },
        outDir,
        acceptedToGolden: options.accept ? options.goldenDir : null,
        cases: results.map((r) => ({ caseId: r.caseId, status: r.status, backing: r.meta.backing, selfStableBytes: r.meta.determinism.selfStableBytes })),
    };
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(summary, null, 2)}\n`);
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
