import { eventBus } from '../../domain/events/DomainEvent.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { drawAttentionPlates } from './AttentionPlates.js';
import { fitLabelText, measureLabelText } from './WorldLabelKit.js';
import { drawCouncilRings, drawFamilyTethers, drawAdvisorTethers, drawAllyTethers, drawTalkArcs, admitTalkArcMarks } from './CouncilRing.js';
import { drawCrowdClusterAuras, drawCrowdClusterBadges } from './CrowdClusterOverlay.js';
import { drawSharedFileKnot, drawSharedFileOverlapLabel } from './SharedFileKnot.js';
import {
    appendDepthSortedDrawables,
    cullDepthSortedDrawables,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
    summarizeDrawableLayers,
} from './DrawablePass.js';
import {
    drawVillageDirectorGround,
    drawVillageDirectorOverlays,
    drawVillageDirectorScreen,
    drawOffscreenCueEdges,
} from './VillageDirectorOverlay.js';
import { worldSceneCategoryRegistry } from './SceneCategoryRegistry.js';
import { buildGpuWorldRecords } from './gpu/GpuSceneBuilder.js';
import { localLightPhaseForLighting, materialClassId } from './gpu/GpuWorldPolicy.js';
import { createBoundedRing, writeBoundedRing } from '../shared/ClientPerfMetrics.js';
import { drawWorkScoreGround, drawWorkScoreScreen } from './SpatialWorkScore.js';
import { ornamentPlan } from './MarkGovernor.js';
import { GroundCueRecorder, insertGroundCueRecords } from './GroundCueRecords.js';
import { insertBodyReflectionRecords } from './WaterReflections.js';
import { drawCanvasAerialHaze, drawResidentBackdropGrade } from './BackdropGrade.js';
import { castLightingFor, drawTreeCasts, setFrameCastLighting, setFramePointCastLights } from './RakingLight.js';
import { drawFlashExposure, stormStrikeAt, weatherPressureLevel } from './WeatherRenderer.js';
import { OCEAN_HORIZON_WORLD_Y } from './CoastBake.js';
import { poolMaskRect, poolReceiverMask } from './CanvasPoolMask.js';
import { drawCanvasWaterColumns } from './CanvasWaterState.js';
import { drawCanvasEmitterCuts } from './EmitterCuts.js';
import { groundOptionsFor, groundStateAt } from './GroundState.js';
import { ungradeRgb } from './CanvasGrade.js';
import { drawMomentEdgePlates, setMomentStage } from './EffectStamps.js';
import { getReservedRects, publishReservedBox } from '../shared/ReservedRects.js';

const FRAME_TIMING_RING_CAPACITY = 90;
const FRAME_TIMER_MAX_MARKS = 48;
const CANVAS_SCENE_BACKEND = Object.freeze({ id: 'canvas-2d', canvasFallback: true });
// 3.5 — the authored palette-ramp table (11x3 RGBA, nearest-sampled). Declared
// in the sprite manifest like every other asset; absent means the Command
// pilot keeps today's additive light response.
export const PALETTE_RAMP_ASSET_ID = 'lut.light-ramp.command';

// 0.10 — ground haze is one world-locked field baked per map revision: HAZE_TEXEL
// world px per texel over the island's bounds plus a margin, cut into three
// flat courses (occupancy thresholds HAZE_COURSES) with a 4x4 ordered dither
// only in a narrow band at each seam, and drawn at a stepped strength. Both
// backends read the same canvas (Canvas drawImage, the GPU `ground:haze`
// record); it never re-projects with the camera and carries no gradient.
export const HAZE_TEXEL = 2;
export const HAZE_ALPHA_CAP = 0.3;
export const HAZE_COURSES = Object.freeze([0.22, 0.44, 0.68]);
export const HAZE_COURSE_ALPHA = Object.freeze([0.34, 0.64, 1]);
export const HAZE_STRENGTH_STEPS = 8;
export const HAZE_WATER_FALLOFF_PX = 220;
export const HAZE_LOWLAND_FALLOFF_PX = 160;
export const HAZE_ROAD_CARVE_RADIUS_PX = 28;
export const HAZE_ROAD_CARVE = 0.12;
const HAZE_SEAM = 0.08;
const HAZE_MARGIN = 96;
const HAZE_OCCUPANCY_CELL = 8;
const HAZE_FIELD_RGB = Object.freeze([214, 228, 236]);
const HAZE_BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
export const DAMP_MARK_LIMIT = 24;
export const DAMP_MATERIAL_MULTIPLIER = Object.freeze({
    roof: 1,
    dock: 1.12,
    stone: 0.82,
    road: 0.7,
    fire: 0,
    emissive: 0,
});

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function isoFromTileKey(key, tileWidth = TILE_WIDTH, tileHeight = TILE_HEIGHT) {
    const text = String(key || '');
    const comma = text.indexOf(',');
    if (comma < 0) return null;
    const tileX = Number(text.slice(0, comma));
    const tileY = Number(text.slice(comma + 1));
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return {
        tileX,
        tileY,
        x: (tileX - tileY) * tileWidth / 2,
        y: (tileX + tileY) * tileHeight / 2,
    };
}

export function isoFromTile(tileX, tileY, tileWidth = TILE_WIDTH, tileHeight = TILE_HEIGHT) {
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return {
        tileX,
        tileY,
        x: (tileX - tileY) * tileWidth / 2,
        y: (tileX + tileY) * tileHeight / 2,
    };
}

export function hazePlanForPressure(level = 0, motionScale = 1) {
    const reduced = Number(motionScale) <= 0;
    const plan = ornamentPlan({ level, motionScale: reduced ? 0 : 1 });
    const shed = plan.ambientWeatherEmbellishment === 'off';
    return {
        density: shed ? 0.36 : 1,
        pressureLevel: Number(level) || 0,
    };
}

export function collectHazeAnchors({
    waterTiles = [],
    waterMeta = null,
    lowlandPoints = [],
    waterBucketSize = 9,
    waterLimit = 6,
    tileWidth = TILE_WIDTH,
    tileHeight = TILE_HEIGHT,
} = {}) {
    const buckets = new Map();
    for (const key of waterTiles || []) {
        const iso = isoFromTileKey(key, tileWidth, tileHeight);
        if (!iso) continue;
        const bucketKey = `${Math.floor(iso.tileX / waterBucketSize)},${Math.floor(iso.tileY / waterBucketSize)}`;
        const bucket = buckets.get(bucketKey) || { n: 0, sx: 0, sy: 0, weight: 0 };
        bucket.n += 1;
        bucket.sx += iso.tileX;
        bucket.sy += iso.tileY;
        const meta = waterMeta?.get?.(key) || null;
        const region = meta?.region || meta?.weatherProfile || '';
        bucket.weight += region === 'lagoon' ? 1.2 : region === 'harbor' ? 1.1 : 1;
        buckets.set(bucketKey, bucket);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, waterLimit);
    const anchors = [];
    for (const bucket of ranked) {
        const tileX = bucket.sx / bucket.n;
        const tileY = bucket.sy / bucket.n;
        const iso = isoFromTile(tileX, tileY, tileWidth, tileHeight);
        if (!iso) continue;
        anchors.push({
            x: iso.x,
            y: iso.y,
            kind: 'water',
            weight: Math.min(1.35, bucket.weight / bucket.n),
            seed: (bucket.n % 7) / 7,
        });
    }
    for (let i = 0; i < (lowlandPoints || []).length; i++) {
        const point = lowlandPoints[i];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        anchors.push({
            x: point.x,
            y: point.y,
            kind: 'lowland',
            weight: 0.72,
            seed: i === 0 ? 0.31 : 0.67,
        });
    }
    return { anchors };
}

export function collectRoadCarvePoints({
    pathTiles = [],
    mainAvenueTiles = [],
    dirtPathTiles = [],
    commandCenterRoadTiles = [],
    stride = 4,
    limit = 28,
    tileWidth = TILE_WIDTH,
    tileHeight = TILE_HEIGHT,
} = {}) {
    const points = [];
    const seen = new Set();
    const ingest = (tiles, extraStride = 0) => {
        if (!tiles) return;
        let index = 0;
        const step = Math.max(1, stride + extraStride);
        for (const key of tiles) {
            if ((index++ % step) !== 0) continue;
            if (seen.has(key)) continue;
            const iso = isoFromTileKey(key, tileWidth, tileHeight);
            if (!iso) continue;
            seen.add(key);
            points.push({ x: iso.x, y: iso.y, key });
            if (points.length >= limit) return;
        }
    };
    ingest(mainAvenueTiles, 0);
    ingest(commandCenterRoadTiles, 1);
    ingest(pathTiles, 1);
    ingest(dirtPathTiles, 2);
    return points;
}

export function lowlandPointsFromDiamond(points) {
    if (!Array.isArray(points) || points.length < 4) return [];
    const bottom = points[2];
    const left = points[3];
    const right = points[1];
    if (!bottom || !left || !right) return [];
    return [
        { x: (bottom.x + left.x) / 2, y: (bottom.y + left.y) / 2 },
        { x: (bottom.x + right.x) / 2, y: (bottom.y + right.y) / 2 },
    ];
}

function isoDistance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = (ay - by) * 2;
    return Math.hypot(dx, dy);
}

export function hazeOccupancyAtWorld(worldX, worldY, {
    anchors = [],
    roads = [],
} = {}) {
    let occupancy = 0;
    for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const falloff = anchor.kind === 'lowland' ? HAZE_LOWLAND_FALLOFF_PX : HAZE_WATER_FALLOFF_PX;
        const dist = isoDistance(worldX, worldY, anchor.x, anchor.y);
        const contrib = (anchor.weight || 1) * Math.max(0, 1 - dist / falloff);
        if (contrib > occupancy) occupancy = contrib;
    }
    occupancy = Math.min(1, occupancy);
    for (let i = 0; i < roads.length; i++) {
        const road = roads[i];
        const dist = isoDistance(worldX, worldY, road.x, road.y);
        if (dist >= HAZE_ROAD_CARVE_RADIUS_PX) continue;
        const t = 1 - dist / HAZE_ROAD_CARVE_RADIUS_PX;
        occupancy *= 1 - t * (1 - HAZE_ROAD_CARVE);
    }
    return occupancy;
}

function hazeHash(ix, iy) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ 0x2c1b3c6d;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Low strata: ground haze lies in flat bands HAZE_BAND_PX world px tall along
// the iso horizontal, each band a run of streaks ~HAZE_STREAK_PX long at its
// own phase, so the occupancy reach is cut into stacked courses of mist over
// water and lowland (hard band edges, Bayer only where a streak ends), never
// concentric rings around the anchors.
const HAZE_BAND_PX = 16;
const HAZE_STREAK_PX = 240;
function hazeStrata(worldX, worldY) {
    const band = Math.floor(worldY / HAZE_BAND_PX);
    const gx = worldX / HAZE_STREAK_PX + hazeHash(band, 977) * 31;
    const x0 = Math.floor(gx);
    const fx = gx - x0;
    const sx = fx * fx * (3 - 2 * fx);
    const n = hazeHash(x0, band) + (hazeHash(x0 + 1, band) - hazeHash(x0, band)) * sx;
    return Math.min(1, Math.max(0, (n - 0.3) / 0.4));
}

/**
 * Bake the ground-haze field for a world rect `bounds` ({ x, y, w, h }):
 * straight RGBA at `texel` world px per texel, alpha on exactly three
 * courses (HAZE_COURSE_ALPHA × HAZE_ALPHA_CAP) or zero. Occupancy is sampled
 * on a coarse HAZE_OCCUPANCY_CELL grid and read back bilinearly, so the bake
 * stays a few tens of ms; the field fades to nothing inside its own margin.
 * Pure: no camera, no DOM.
 */
export function bakeHazeField({ anchors = [], roads = [], bounds, texel = HAZE_TEXEL } = {}) {
    const width = Math.max(1, Math.ceil(bounds.w / texel));
    const height = Math.max(1, Math.ceil(bounds.h / texel));
    const cell = HAZE_OCCUPANCY_CELL;
    const cw = Math.ceil(bounds.w / cell) + 2;
    const ch = Math.ceil(bounds.h / cell) + 2;
    const coarse = new Float32Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
        const wy = bounds.y + cy * cell;
        for (let cx = 0; cx < cw; cx++) {
            const wx = bounds.x + cx * cell;
            const edge = Math.min(wx - bounds.x, bounds.x + bounds.w - wx, wy - bounds.y, bounds.y + bounds.h - wy);
            if (edge <= 0) continue;
            coarse[cy * cw + cx] = hazeOccupancyAtWorld(wx, wy, { anchors, roads })
                * hazeStrata(wx, wy)
                * Math.min(1, edge / HAZE_MARGIN);
        }
    }
    const data = new Uint8ClampedArray(width * height * 4);
    const alphas = HAZE_COURSE_ALPHA.map(share => Math.round(share * HAZE_ALPHA_CAP * 255));
    for (let y = 0; y < height; y++) {
        const gy = ((y + 0.5) * texel) / cell;
        const y0 = Math.min(ch - 2, Math.floor(gy));
        const fy = gy - y0;
        for (let x = 0; x < width; x++) {
            const gx = ((x + 0.5) * texel) / cell;
            const x0 = Math.min(cw - 2, Math.floor(gx));
            const fx = gx - x0;
            const i = y0 * cw + x0;
            const top = coarse[i] + (coarse[i + 1] - coarse[i]) * fx;
            const bottom = coarse[i + cw] + (coarse[i + cw + 1] - coarse[i + cw]) * fx;
            const o = top + (bottom - top) * fy
                + (HAZE_BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * HAZE_SEAM;
            const course = (o >= HAZE_COURSES[0] ? 1 : 0) + (o >= HAZE_COURSES[1] ? 1 : 0) + (o >= HAZE_COURSES[2] ? 1 : 0);
            if (!course) continue;
            const offset = (y * width + x) * 4;
            data[offset] = HAZE_FIELD_RGB[0];
            data[offset + 1] = HAZE_FIELD_RGB[1];
            data[offset + 2] = HAZE_FIELD_RGB[2];
            data[offset + 3] = alphas[course - 1];
        }
    }
    return { x: bounds.x, y: bounds.y, w: width * texel, h: height * texel, width, height, data };
}

/**
 * 0.10 — how strongly the ground haze lies, stepped in HAZE_STRENGTH_STEPS:
 * the dawn mist (rising and burning off across the dawn phase) or a real fog
 * (the village's own timeline). Rain and overcast lay none; it is never a
 * multiple of the weather.
 */
export function groundHazeStrength(atmosphere, density = 1) {
    const dawn = atmosphere?.phase === 'dawn'
        ? Math.sin(clamp01(atmosphere.phaseProgress) * Math.PI)
        : 0;
    const weather = atmosphere?.weather;
    const fog = weather?.type === 'fog' ? clamp01(((Number(weather.fog) || 0) - 0.24) / 0.5) : 0;
    return Math.round(Math.max(dawn, fog) * clamp01(density) * HAZE_STRENGTH_STEPS) / HAZE_STRENGTH_STEPS;
}

const NO_GROUND_STATE = Object.freeze({ wetness: 0, puddles: 0, snowCover: 0, frost: 0, bucketMinute: 0 });

// C-W2 — the ground state for a snapshot, read with the same timeline inputs
// (seed override, fixed/auto mode, pinned QA knots) the live weather used.
export function groundStateForAtmosphere(atmosphere) {
    const date = atmosphere?.effectiveDate;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return NO_GROUND_STATE;
    return groundStateAt(date, groundOptionsFor(atmosphere));
}

// 5.2 — the Canvas/PostFx twin of the resident puddle courses: the same
// GroundBake site mask and puddle level, composed once per (level, sky
// palette) into one world-space layer: the far-rim lip as black at 0.36
// (the resident ground × 0.64), the body as the capped sky at 0.72 over the
// street (the resident 28 % street share), sparse opaque horizon glints on
// the near rim, and the shallow rim at half the body's sky share. These
// paths grade the finished frame, so the sky colours are
// painted as their preimage (ungradeRgb), like the sky plate. The caps sit
// a step under the resident ones (body min(0.56, ...), glint 0.62) because
// the preimage round trip lands a touch light; measured, both backends then
// land on the same sky-blue (OKLab-close body, equal saturation).
const PUDDLE_BODY_CAP = 0.53;
const PUDDLE_GLINT_CAP = 0.59;

function cappedSkyRgb(hex, cap) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return [0.6, 0.68, 0.74];
    const rgb = [1, 3, 5].map(index => parseInt(text.slice(index, index + 2), 16) / 255);
    const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    return luma > cap ? rgb.map(channel => channel * cap / luma) : rgb;
}

function puddleLayerFor(renderer, mask, level, atmosphere) {
    const palette = atmosphere?.sky?.palette;
    const grade = atmosphere?.lightGrade || null;
    const key = `${mask.revision}|${level}|${palette?.upperBand}|${palette?.horizon}|${grade?.cacheKey || ''}`;
    const cached = renderer._canvasPuddleLayer;
    if (cached?.key === key) return cached;
    const { cols, rows, data } = mask;
    const threshold = Math.ceil(255 * (1 - level));
    const wet = (col, row) => col >= 0 && row >= 0 && col < cols && row < rows
        && data[row * cols + col] > 0 && data[row * cols + col] >= threshold;
    let minCol = cols;
    let minRow = rows;
    let maxCol = -1;
    let maxRow = -1;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (!wet(col, row)) continue;
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
        }
    }
    if (cached?.canvas) cached.canvas.width = cached.canvas.height = 0;
    if (maxCol < 0) {
        renderer._canvasPuddleLayer = { key, canvas: null };
        return renderer._canvasPuddleLayer;
    }
    const toBytes = (rgb) => ungradeRgb(rgb, grade).map(channel => Math.round(clamp01(channel) * 255));
    const body = toBytes(cappedSkyRgb(palette?.upperBand, PUDDLE_BODY_CAP));
    const glint = toBytes(cappedSkyRgb(palette?.horizon, PUDDLE_GLINT_CAP));
    const texelW = mask.texelW || 2;
    const w = (maxCol - minCol + 1) * texelW;
    const h = maxRow - minRow + 1;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cctx = canvas.getContext('2d');
    const image = cctx.createImageData(w, h);
    const out = image.data;
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            if (!wet(col, row)) continue;
            let rgba;
            if (!wet(col, row - 1)) rgba = [0, 0, 0, 92];
            else if (!wet(col, row + 1) && fractHash(col, row) < 0.42) rgba = [...glint, 255];
            else rgba = [...body, data[row * cols + col] / 255 - (1 - level) < 0.12 ? 92 : 184];
            for (let k = 0; k < texelW; k++) {
                const o = ((row - minRow) * w + (col - minCol) * texelW + k) * 4;
                out[o] = rgba[0]; out[o + 1] = rgba[1]; out[o + 2] = rgba[2]; out[o + 3] = rgba[3];
            }
        }
    }
    cctx.putImageData(image, 0, 0);
    renderer._canvasPuddleLayer = {
        key,
        canvas,
        x: mask.x0 + minCol * texelW,
        y: mask.y0 + minRow,
    };
    return renderer._canvasPuddleLayer;
}

// The GLSL glint hash (`fract(sin(dot(cell, (12.9898, 78.233))) * 43758.5453)`).
function fractHash(col, row) {
    const v = Math.sin(col * 12.9898 + row * 78.233) * 43758.5453;
    return v - Math.floor(v);
}

export function drawCanvasPuddles(renderer, ctx, atmosphere) {
    const puddles = renderer._groundState?.puddles || 0;
    const mask = renderer.groundPuddleMask;
    if (puddles <= 0.001 || !mask?.data) return;
    const layer = puddleLayerFor(renderer, mask, puddles, atmosphere);
    if (!layer.canvas) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer.canvas, layer.x, layer.y);
    ctx.restore();
}

export function dampMaterialMultiplier(material) {
    return DAMP_MATERIAL_MULTIPLIER[material] ?? 0;
}

export function dampMarkAlpha(wetness, material, seed = 0.5) {
    const multiplier = dampMaterialMultiplier(material);
    if (multiplier <= 0) return 0;
    return Math.min(0.22, clamp01(wetness) * multiplier * (0.45 + clamp01(seed) * 0.35));
}

export function applySurfaceWetnessToReactions(reactions = {}, wetness = 0) {
    const w = clamp01(wetness);
    return {
        ...reactions,
        surfaceWetness: w,
        puddleAlpha: Math.max(Number(reactions.puddleAlpha) || 0, w * 0.38),
        roofGlintAlpha: Math.max(Number(reactions.roofGlintAlpha) || 0, w * 0.18),
    };
}

export function collectDampMarks({
    roads = [],
    docks = [],
    roofs = [],
    footings = [],
    wetness = 0,
    limit = DAMP_MARK_LIMIT,
    layer = 'all',
} = {}) {
    if (clamp01(wetness) <= 0.03) return [];
    const marks = [];
    const take = (items, material) => {
        if (layer === 'roofs' && material !== 'roof') return;
        if (layer === 'ground' && material === 'roof') return;
        for (let i = 0; i < (items || []).length; i++) {
            const item = items[i];
            if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
            if (dampMaterialMultiplier(material) <= 0) continue;
            marks.push({
                x: Math.round(item.x),
                y: Math.round(item.y),
                material,
                seed: clamp01(item.seed),
                alpha: dampMarkAlpha(wetness, material, item.seed),
            });
            if (marks.length >= limit) return;
        }
    };
    take(roads, 'road');
    take(docks, 'dock');
    take(footings, 'stone');
    take(roofs, 'roof');
    return marks.slice(0, limit);
}

// Follow-up after layer extraction: move private renderer calls used here into
// explicit layer/context methods so this module stays a frame orchestrator.
export function renderWorldFrame(renderer, dt = 16) {
    const ctx = renderer.ctx;
    const canvas = renderer.canvas;
    const overlayCtx = renderer.overlayCtx;
    if (!ctx || !canvas || !overlayCtx) return;
    if (!canvas.width || !canvas.height) return;
    const frameTimer = beginFrameTiming(renderer);
    const collectStructuralDiagnostics = renderer.debugOverlay?.enabled === true;
    const paintCounts = collectStructuralDiagnostics
        ? (renderer._paintCounts ||= { lower: Object.create(null), upper: Object.create(null) })
        : null;
    if (paintCounts) {
        for (const kind in paintCounts.lower) paintCounts.lower[kind] = 0;
        for (const kind in paintCounts.upper) paintCounts.upper[kind] = 0;
    }
    const renderNow = Date.now();
    const villageSnapshot = renderer.villageDirector?.getSnapshot?.() || null;
    const viewport = renderer._screenViewport();
    // V8 — the frame's moment stage: every C4 moment (and the building chits)
    // resolves where it may stand against this camera, the chrome's reserved
    // rects and the building sprites sorted in front of it.
    setMomentStage({
        camera: renderer.camera,
        viewport,
        reserved: getReservedRects(),
        buildings: renderer.buildingRenderer,
        actors: renderer.agentSprites,
    });
    const gpuWorldRequested = renderer.gpuWorld?.isActive?.() === true;
    const sceneCategoryContext = renderer._sceneCategoryContext || (renderer._sceneCategoryContext = {});
    sceneCategoryContext.renderer = renderer;
    sceneCategoryContext.renderNow = renderNow;
    const sceneCategoryFrame = worldSceneCategoryRegistry.enumerate(sceneCategoryContext);
    const sceneCategoryResolution = worldSceneCategoryRegistry.resolve(
        sceneCategoryFrame,
        gpuWorldRequested
            ? sceneCommandBackend(renderer, renderer.gpuWorld)
            : CANVAS_SCENE_BACKEND,
    );
    emitSceneCategoryDiagnostics(renderer, sceneCategoryResolution.diagnostics);
    const gpuWorldActive = gpuWorldRequested && !sceneCategoryResolution.requireCanvasFrame;
    // 4.6 — a glide planned now is a continuous dolly only where its flight
    // frames will render fat-pixel; the Canvas world takes the stepped family.
    if (renderer.camera) renderer.camera.fatFlight = gpuWorldActive;
    const postFxActive = !gpuWorldActive && renderer.postFx?.isActive?.() === true;
    renderer._setPostFxCanvasVisible?.(gpuWorldActive || postFxActive);
    renderer._resetScreenTransform(overlayCtx);
    overlayCtx.clearRect(0, 0, viewport.width, viewport.height);
    // #28 integration — fire the child sprite's one-shot handoff ack-bob once the
    // director's baton reaches it (progress near terminus), deduped per scene id.
    if (villageSnapshot?.handoffs?.length) {
        const acked = (renderer._handoffAcked ||= new Set());
        const live = renderer._liveHandoffIds || (renderer._liveHandoffIds = new Set());
        live.clear();
        for (const h of villageSnapshot.handoffs) {
            if (h?.kind !== 'handoff' || !h?.to?.id) continue;
            live.add(h.id);
            if ((h.progress ?? 0) >= 0.9 && !acked.has(h.id)) {
                acked.add(h.id);
                renderer.agentSprites.get(h.to.id)?.setHandoffAck?.(true);
            }
        }
        for (const id of acked) if (!live.has(id)) acked.delete(id);
    }
    // C-W1 — the environment reads the village's own timeline only: no agent,
    // mood or director input reaches the weather, sky, fog or grade (V3).
    const atmosphere = renderer.atmosphereState.update({
        now: new Date(renderNow),
        motionScale: renderer.motionScale,
    });
    renderer._lastAtmosphere = atmosphere;
    // 0.10 — one lightning schedule per frame on the one clock: the stepped
    // flash exposure both backends apply and the bolt WeatherRenderer draws.
    const strike = stormStrikeAt(renderer.motionTimeMs, atmosphere, renderer.motionScale ?? 1);
    const wx = atmosphere?.weather;
    // C-W2 — the ground remembers the village's own weather: wetness,
    // puddles, snow cover and frost integrated from the timeline history
    // (today and the two previous days), memoized per 10-minute bucket, so a
    // reload or reduced motion shows the same ground. Live precipitation
    // wets the street at once; the history keeps it wet after the rain.
    renderer._groundState = groundStateForAtmosphere(atmosphere);
    // 5.2 — flora props step their winter state with the season and bucket.
    renderer._syncPropWinter?.();
    renderer._surfaceWetness = Math.max(clamp01(Number(wx?.precipitation) || 0), renderer._groundState.wetness);
    // 5.2 roofs / 6.6 — roof snow, wet slate and eave drips step with the
    // same ground state and the live precipitation.
    renderer.buildingRenderer?.syncRoofWeather?.(atmosphere, renderer._groundState, renderer.motionScale ?? 1, renderer.motionTimeMs);
    const reactions = applySurfaceWetnessToReactions(atmosphere?.reactions || {}, renderer._surfaceWetness);
    renderer._atmosphereReactions = reactions;
    renderer.buildingRenderer?.setLightingState(atmosphere?.lighting);
    renderer.buildingRenderer?.setClockState?.(atmosphere?.clock);
    renderer.buildingRenderer?.setAtmosphereState?.(atmosphere
        ? { ...atmosphere, reactions }
        : atmosphere);
    // S12 — albedo marks agents paint on the ungraded overlay (the signature
    // clasp) take the frame's C2 grade.
    const overlayLightGrade = atmosphere?.lightGrade || null;
    for (const sprite of renderer.agentSprites?.values?.() || []) sprite.overlayLightGrade = overlayLightGrade;
    // #3 — grade authority: harbor anchorage glows lerp toward the time-of-day tint.
    renderer.harborTraffic?.setGradeState?.(atmosphere?.grade);
    const perfNow = performance.now();
    renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);
    renderer._updateGateDoorState?.(perfNow);
    markFrameTiming(frameTimer, 'setup');

    renderer._resetScreenTransform(ctx);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    // 1.5 — this frame's sun bucket for the villager contact stamps.
    setFrameCastLighting(castLightingFor(atmosphere));
    // 2.8 — the lamps that may throw villager casts this frame (from their
    // feet), ranked for the crowd cap from the view centre.
    setFramePointCastLights(
        renderer._frameLightSources?.ambient,
        localLightPhaseForLighting(atmosphere?.lighting),
        renderer.camera?.screenToWorld?.(viewport.width / 2, viewport.height / 2),
    );
    // 1.3 — the sky/void plate is graded with the island: on the resident
    // path nothing grades this canvas afterwards, so it paints the C2 sky
    // colours as-is; the Canvas/PostFx paths grade the finished frame, so it
    // paints their preimage.
    renderer.skyRenderer.draw(ctx, {
        canvas: viewport,
        camera: renderer.camera,
        dt,
        atmosphere,
        motionScale: renderer.motionScale,
        backdropGraded: gpuWorldActive,
        // 5.7 — the deck's drift rides the motion clock (held when reduced).
        timeMs: renderer.motionTimeMs,
    });
    markFrameTiming(frameTimer, 'sky');

    renderer.camera.applyTransform(ctx);
    // 3.4 — cached outer ocean: one drawImage; pre-graded only on the
    // resident path (Canvas/PostFx grade the finished frame afterwards).
    renderer._drawDistantSeaHorizon(ctx, atmosphere, { gpuGraded: gpuWorldActive });
    if (gpuWorldActive) {
        // 0.10 — the fog banks over the outer ocean (the island's own come
        // in as ground records, under its bodies): the same world-locked
        // lattice, pre-graded like the ocean under it.
        drawGroundFog(ctx, renderer, atmosphere, viewport, { graded: true });
        // 1.3 — the island's stepped vignette and screen-Y aerial haze over
        // the backdrop (sky plate + outer ocean), so sea and sky meet the
        // graded island without a seam at the frame edges.
        renderer._resetScreenTransform(ctx);
        drawResidentBackdropGrade(ctx, {
            viewport,
            atmosphere,
            zoom: renderer.camera.zoom,
            hazeStrength: renderer.gpuWorld?.aerialHaze || 0,
        });
        // 0.10 — the flash exposure on the backdrop; the composite applies
        // the same scale to the island (`u_flash`).
        drawFlashExposure(ctx, viewport.width, viewport.height, strike);
        renderer.camera.applyTransform(ctx);
    }
    markFrameTiming(frameTimer, 'horizon');
    renderer._gpuHazeStrength = 0;
    if (!gpuWorldActive) {
        renderer._drawTerrain(
            ctx,
            frameTimer ? label => markFrameTiming(frameTimer, label) : null,
        );
        // 5.2 — the Canvas twin of the resident puddle courses.
        drawCanvasPuddles(renderer, ctx, atmosphere);
        // 1.4 — world-locked stepped cloud-shadow courses over the terrain.
        drawCloudShadows(renderer, ctx, atmosphere, perfNow);
        // 0.10 — ground haze and the fog banks: world-locked stepped fields
        // on the ground plane, ahead of agents and buildings.
        drawGroundHaze(renderer, ctx, atmosphere, viewport);
        drawGroundFog(ctx, renderer, atmosphere, viewport);
    } else {
        const plan = hazePlanForPressure(hazePressureLevel(renderer, atmosphere, viewport), renderer.motionScale ?? 1);
        renderer._gpuHazeStrength = groundHazeStrength(atmosphere, plan.density);
        if (renderer._gpuHazeStrength > 0) ensureHazeField(renderer);
    }
    markFrameTiming(frameTimer, 'ground-atmosphere');
    // The sky canopy: stars, the sun's glare, the moon, god rays, icon clouds
    // and ambient meteors over the terrain, clipped to the sky above the sea
    // horizon (SkyRenderer.drawCanopy).
    renderer._drawSkyCanopy(ctx, atmosphere, dt, renderer.motionScale);
    renderer.camera.applyTransform(ctx);
    markFrameTiming(frameTimer, 'sky-canopy');
    // Wildlife and waterfalls now enter through the harbor's overlay-safe
    // scene category. Canvas draws them in the depth stream; direct GPU replays
    // the same category above its opaque island.
    markFrameTiming(frameTimer, 'fauna');
    admitTalkArcMarks({ relationship: renderer.relationshipState, agentSprites: renderer.agentSprites });
    const groundOptions = { villageSnapshot, renderNow, perfNow, atmosphere, viewport };
    if (!gpuWorldActive) {
        drawGroundSemantics(renderer, ctx, groundOptions, GROUND_CUES_ALL);
        drawBuildingLightReflections(renderer, ctx, atmosphere);
        // 2.9 — casts over painted water stay faint and ripple-broken.
        const waterFields = renderer._coastBake?.waterFields || null;
        renderer.buildingRenderer?.drawShadows(ctx, waterFields);
        // 1.5 — tree casts on the ground layer (the resident path emits them
        // as ground records with each tree).
        drawTreeCasts(ctx, renderer.treePropSprites, castLightingFor(atmosphere), renderer.camera, viewport, waterFields);
    } else {
        // 0.2 — the resident path splits the ground cues: the text-bearing
        // work score stays in the retained texture (re-uploaded only when it
        // changes), and every cue that follows an agent becomes native ground
        // records spliced in after terrain, so moving agents move records.
        const ground = prepareSemanticGround(renderer, viewport, villageSnapshot, atmosphere);
        if (ground?.dirty) {
            drawGroundSemantics(renderer, ground.ctx, groundOptions, GROUND_CUES_RETAINED);
            ground.finish();
        }
        recordLiveGroundCues(renderer, groundOptions);
    }
    markFrameTiming(frameTimer, 'prelayers');

    const buildingDrawables = renderer.buildingRenderer?.enumerateDrawables() ?? [];
    const sortedSprites = renderer._snapshotSortedSprites();
    const agentLighting = atmosphere?.lighting || null;
    for (const sprite of sortedSprites) {
        sprite.setLightingState?.(agentLighting);
        sprite.setGpuWorldEnabled?.(gpuWorldActive);
    }
    const propDrawables = renderer._enumeratePropDrawables();
    const harborPendingRepos = renderer.harborTraffic?.getPendingRepoSummaries?.() ?? [];
    renderer.bridgeLanterns?.update?.(harborPendingRepos, renderNow);
    const harborSignature = renderer._harborPendingReposSignature(harborPendingRepos);
    if (harborSignature !== renderer._harborPendingSignature) {
        renderer._harborPendingSignature = harborSignature;
        eventBus.emit('harbor:updated', harborPendingRepos);
    }
    const chronicleMonumentDrawables = renderer.chronicleMonuments?.enumerateDrawables?.(renderNow, renderer.camera) ?? [];
    const familiarDrawables = renderer._enumerateFamiliarMoteDrawables?.(atmosphere) ?? [];
    const zoom = renderer.camera.zoom;
    const renderModes = renderer._agentRenderMode?.(viewport, sortedSprites);
    const agentRenderMode = renderModes?.body || 'full';
    const annotationMode = renderModes?.annotation || 'full';
    renderer._assignAgentOverlaySlots(sortedSprites, zoom, { agentRenderMode: annotationMode });
    markFrameTiming(frameTimer, 'collect');

    const drawables = renderer._drawables;
    drawables.length = 0;
    const drawableAssembly = renderer._drawableAssembly || (renderer._drawableAssembly = {});
    drawableAssembly.buildingDrawables = buildingDrawables;
    drawableAssembly.propDrawables = propDrawables;
    drawableAssembly.agentSprites = sortedSprites;
    drawableAssembly.sceneCategoryFrame = sceneCategoryFrame;
    drawableAssembly.chronicleMonumentDrawables = chronicleMonumentDrawables;
    drawableAssembly.familiarDrawables = familiarDrawables;
    // 0.6 — Canvas paints world particles as small depth drawables at their
    // painter sortY; the resident path draws them in its own depth pass.
    drawableAssembly.particles = gpuWorldActive ? null : renderer.particleSystem?.particles || null;
    appendDepthSortedDrawables(drawables, drawableAssembly);
    const cullingStats = cullDepthSortedDrawables(
        drawables,
        renderer.camera,
        viewport,
        220,
        collectStructuralDiagnostics,
    );
    const drawableStats = collectStructuralDiagnostics
        ? summarizeDrawableLayers(drawables, cullingStats)
        : null;
    markFrameTiming(frameTimer, 'sort/cull');
    const drawableContext = renderer._drawableContext || (renderer._drawableContext = {});
    drawableContext.zoom = zoom;
    drawableContext.renderNow = renderNow;
    drawableContext.renderer = renderer;
    drawableContext.buildingRenderer = renderer.buildingRenderer;
    drawableContext.harborTraffic = renderer.harborTraffic;
    drawableContext.landmarkActivity = renderer.landmarkActivity;
    drawableContext.chronicleMonuments = renderer.chronicleMonuments;
    drawableContext.agentRenderMode = agentRenderMode;
    drawableContext.gpuWorldActive = gpuWorldActive;
    drawableContext.paintCounts = paintCounts;
    drawableContext.particleMotionEnabled = renderer.particleSystem?.motionEnabled !== false;
    drawDepthSortedDrawables(ctx, drawables, drawableContext);
    // Direct GPU carries wetness in the material shader; the discrete Canvas
    // damp-mark decoration remains fallback-only and is documented as such.
    if (!gpuWorldActive) renderer._drawSurfaceWetnessMarks?.(ctx, 'roofs');
    markFrameTiming(frameTimer, 'drawables');
    // On the resident path this 2D context sits under the opaque GPU island;
    // the harbor finale and the reduced-motion chimney wisp replay on the
    // overlay after the GPU world renders instead.
    if (!gpuWorldActive) {
        renderer._drawChimneySmokeStatic?.(ctx);
        renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);
    }
    markFrameTiming(frameTimer, 'world-effects');

    renderer._resetScreenTransform(ctx);
    // 1.6 Canvas parity — the resident composite's stepped screen-Y aerial
    // haze over the finished Canvas world, before the frame grade.
    if (!gpuWorldActive) {
        drawCanvasAerialHaze(ctx, { viewport, atmosphere, zoom: renderer.camera.zoom });
        // 0.10 — the flash exposure over the whole finished Canvas frame.
        drawFlashExposure(ctx, viewport.width, viewport.height, strike);
    }
    let gpuWorldRendered = false;
    let postFxRendered = false;
    const needsGpuFeed = gpuWorldActive || postFxActive;
    const postFxFeedContext = renderer._postFxFeedContext || (renderer._postFxFeedContext = {});
    postFxFeedContext.renderer = renderer;
    postFxFeedContext.gpuWorldActive = gpuWorldActive;
    postFxFeedContext.atmosphere = atmosphere;
    postFxFeedContext.villageSnapshot = villageSnapshot;
    postFxFeedContext.nowMs = renderNow;
    const feed = needsGpuFeed
        ? renderer.postFxFeed?.build?.(postFxFeedContext) || null
        : null;
    // V5 — the hybrid pools' ground-receiver mask (CanvasPoolMask), built
    // here so both grade owners read one mask.
    if (feed && postFxActive) {
        const maskRect = poolMaskRect(renderer, viewport);
        feed.poolMask = maskRect ? poolReceiverMask(renderer, maskRect) : null;
    }
    if (gpuWorldActive) {
        // 4.6 — the camera feed: whether this GL frame is a flight frame (the
        // unrounded `renderOffsetGpuX/Y` and fat-pixel sampling) is decided
        // once, before any GL consumer reads the offset.
        renderer.camera?.latchGpuFrame?.();
        const gpuBuildContext = renderer._gpuBuildContext || (renderer._gpuBuildContext = {});
        gpuBuildContext.drawables = drawables;
        const gpuFeed = Object.assign(renderer._gpuFeedEnvelope ||= {}, feed || {});
        gpuFeed.timeMs = renderer.motionTimeMs ?? feed?.timeMs;
        gpuFeed.atmosphere = atmosphere;
        gpuFeed.weather = atmosphere?.weather || null;
        // 0.10 — the lightning exposure scale the composite applies (0 = none).
        gpuFeed.flash = strike.exposure;
        // 2.7 — the Lighthouse beam fan (null by day), swept on the motion clock.
        gpuFeed.beam = renderer.buildingRenderer?.lighthouseBeam?.(renderer.motionTimeMs) || null;
        gpuFeed.lighting = atmosphere?.lighting || null;
        // 3.2 — the resident shader consumes the same accumulated wetness the
        // Canvas damp marks use; it never re-derives rain history in GLSL.
        gpuFeed.wetness = renderer._surfaceWetness || 0;
        // 5.2 — puddles: the level from the ground history over GroundBake's
        // baked site mask, reflecting the graded sky palette.
        gpuFeed.puddles = renderer._groundState?.puddles || 0;
        gpuFeed.puddleMask = renderer.groundPuddleMask || null;
        gpuFeed.skyPalette = atmosphere?.sky?.palette || null;
        // 3.5 — the authored palette ramp travels as a plain decoded image; a
        // missing or unexpected table leaves the pilot at today's response.
        gpuFeed.paletteLut = renderer.assets?.get?.(PALETTE_RAMP_ASSET_ID) || null;
        gpuFeed.paletteLutRevision = renderer.assets?.assetVersion || null;
        // 3.1 + 3.6 — the coast bake's resident water fields (cycle offset,
        // coast field), uploaded once per coast bake on units 7 and 8.
        gpuFeed.coastWater = renderer._coastBake?.waterFields || null;
        renderer.gpuWorld.prepareFrame(gpuFeed);
        const records = insertGroundFogRecords(
            insertGroundCueRecords(
                // 3.11 — reflect twins of bodies at the water (after the agent atlas packs).
                insertBodyReflectionRecords(renderer, buildGpuWorldRecords(renderer, gpuBuildContext)),
                renderer._groundCueRecords,
            ),
            groundFogRecords(renderer, atmosphere, viewport),
        );
        const gpuRenderContext = renderer._gpuRenderContext || (renderer._gpuRenderContext = {});
        gpuRenderContext.records = records;
        gpuRenderContext.camera = renderer.camera;
        gpuRenderContext.feed = gpuFeed;
        gpuRenderContext.sceneCommands = sceneCategoryResolution.nativeCommandBatches;
        // 0.6 — every live world particle, depth-tested against the painter
        // depth the records write (one instanced draw).
        gpuRenderContext.particles = renderer.particleSystem || null;
        gpuWorldRendered = renderer.gpuWorld?.render?.(gpuRenderContext) === true;
        markFrameTiming(frameTimer, 'gpu-world');
    } else if (postFxActive) {
        // 1.3 — on the hybrid path the water columns and emitter cuts land on
        // the (still empty) overlay before the PostFx pass: the cuts' own
        // emission, at the FULL bloom target's half scale, is its bloom
        // source, as authored emission is the resident bloom's.
        drawCanvasWaterColumns(overlayCtx, renderer);
        const emission = drawCanvasEmitterCuts(overlayCtx, renderer, atmosphere, 0.5);
        if (feed) feed.emission = emission;
        postFxRendered = renderer.postFx?.render?.(canvas, feed) === true;
        markFrameTiming(frameTimer, 'postfx');
    }
    if ((!gpuWorldActive || !gpuWorldRendered) && (!postFxActive || !postFxRendered)) {
        renderer._drawAtmosphere(
            ctx,
            atmosphere,
            dt,
            renderer._frameLightSources?.ambient || null,
            frameTimer ? label => markFrameTiming(frameTimer, label) : null,
        );
    }
    if ((gpuWorldActive && !gpuWorldRendered) || (postFxActive && !postFxRendered)) {
        renderer._setPostFxCanvasVisible?.(false);
    }

    // 1.3 — the Canvas and hybrid PostFx paths grade the whole 2D frame, so
    // authored emitters keep their own light as cached cuts on the ungraded
    // overlay, under weather, marks and labels; the 2.9 water columns land
    // there first, as the resident pass lands them after its grade (the
    // hybrid path drew both above, before its pass).
    if (!gpuWorldRendered && !postFxActive) {
        drawCanvasWaterColumns(overlayCtx, renderer);
        drawCanvasEmitterCuts(overlayCtx, renderer, atmosphere);
    }
    renderer._resetScreenTransform(overlayCtx);
    renderer.weatherRenderer?.drawForeground(overlayCtx, {
        canvas: viewport,
        atmosphere,
        dt,
        timeMs: renderer.motionTimeMs,
        strike,
        seaAt: strikeSeaAt(renderer),
        profileMark: frameTimer ? label => markFrameTiming(frameTimer, label) : null,
    });
    renderer.camera.applyTransform(overlayCtx);
    if (gpuWorldRendered) {
        // 6.7 — under reduced motion the live chimneys show a static wisp
        // (live particles draw in the GPU scene pass, depth-tested).
        renderer._drawChimneySmokeStatic?.(overlayCtx, atmosphere?.lightGrade || null);
        renderer.buildingRenderer?.drawGpuFunctionalOverlays?.(overlayCtx);
    }
    drawTalkArcs(overlayCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawCrowdClusterBadges(overlayCtx, {
        crowdStats: renderer._crowdStats,
        agentSprites: renderer.agentSprites,
        zoom,
    });
    renderer.arrivalDeparture?.draw?.(overlayCtx, {
        zoom,
        now: perfNow,
        lighting: atmosphere?.lighting,
    });
    renderer.chronicleMonuments?.drawMoments?.(overlayCtx, zoom, renderNow);
    renderer.harborTraffic?.drawMoments?.(overlayCtx, zoom, renderNow);
    drawVillageDirectorOverlays(overlayCtx, villageSnapshot, perfNow, atmosphere?.grade);

    if (gpuWorldRendered) {
        const sceneOverlayContext = renderer._sceneOverlayContext || (renderer._sceneOverlayContext = {});
        sceneOverlayContext.zoom = zoom;
        sceneOverlayContext.renderNow = renderNow;
        sceneOverlayContext.renderer = renderer;
        sceneOverlayContext.paintCounts = paintCounts;
        drawSceneCategoryOverlays(overlayCtx, drawables, sceneCategoryResolution, sceneOverlayContext);
        renderer.harborTraffic?.drawFinaleEffects?.(overlayCtx, renderNow);
    } else {
        // 6.7 — fireflies are light: on Canvas they skip the depth stream
        // (graded after the fact) and land here, after the grade, as on the
        // resident overlay.
        renderer.wildlifeRenderer?.drawFireflies?.(overlayCtx, perfNow);
    }
    // 0.7 — re-strike the selected agent's chevron AFTER the Canvas
    // atmosphere multiply so it survives the night grade.
    drawPrimaryMarksPostAtmosphere(renderer, overlayCtx, atmosphere, {
        force: gpuWorldRendered,
    });
    if (gpuWorldRendered) {
        for (const sprite of sortedSprites) {
            if (sprite.drawGpuWorldOverlay) {
                sprite.drawGpuWorldOverlay(overlayCtx, zoom, annotationMode);
                if (paintCounts) paintCounts.upper.agent = (paintCounts.upper.agent || 0) + 1;
            }
        }
    }
    drawSelectedAgentXray(renderer, overlayCtx, buildingDrawables);
    // 4.5 — the shared-file overlap plate. The thread and knot live in the
    // occluded ground texture; the exact counts belong here, once, in both
    // backends, so dense load keeps the numbers when the lines are dropped.
    drawSharedFileOverlapLabel(overlayCtx, {
        overlap: renderer.relationshipState?.getSnapshot?.()?.fileOverlap || null,
        agentSprites: renderer.agentSprites,
        zoom,
        threaded: renderer._sharedFileThreadDrawn === true,
    });
    markFrameTiming(frameTimer, 'post-atmosphere-effects');

    // 5.3 — the building occupancy count lives on the plaque's count cell
    // (FORGE │ 8); there is no separate floating bubble.
    // 5.1/5.5 — the lower-third caption is measured before the label pass so
    // plaques treat its strip as occupied and step aside instead of colliding
    // with it. Screen rect converted to world space: the label pass runs under
    // the world transform.
    const ambientCaption = ambientCaptionLayout(overlayCtx, renderer, viewport, villageSnapshot);
    // V8 — the caption band is reserved screen for the next frame's moments
    // and plates (the painter publishes it; it is not a DOM element).
    publishReservedBox('caption-band', ambientCaption?.rect || null);
    const captionWorldBox = ambientCaption && renderer.camera?.screenToWorld
        ? (() => {
            const topLeft = renderer.camera.screenToWorld(ambientCaption.rect.left, ambientCaption.rect.top);
            const bottomRight = renderer.camera.screenToWorld(ambientCaption.rect.right, ambientCaption.rect.bottom);
            return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
        })()
        : null;
    renderer.buildingRenderer?.drawLabels(overlayCtx, {
        zoom,
        scaleMode: 'screen-fixed',
        occupiedBoxes: captionWorldBox
            ? [...renderer._collectAgentLabelHitRects(sortedSprites), captionWorldBox]
            : renderer._collectAgentLabelHitRects(sortedSprites),
        harborPendingRepos,
        readMode: renderer.getReadMode(),
        selectedType: villageSnapshot?.selectedBuildingSignal?.type || null,
    });
    if (collectStructuralDiagnostics) {
        renderer._lastRenderStats = buildRenderStats(renderer, {
            drawableStats,
            cullingStats,
            harborPendingRepos,
            sceneCategoryResolution,
            inputCounts: {
                buildings: buildingDrawables.length,
                props: propDrawables.length,
                agents: sortedSprites.length,
                sceneCategories: Object.fromEntries(sceneCategoryFrame.entries.map(entry => [
                    entry.category.id,
                    entry.items.length,
                ])),
                monuments: chronicleMonumentDrawables.length,
                familiars: familiarDrawables.length,
            },
            agentRenderMode,
            annotationMode,
        });
    }
    markFrameTiming(frameTimer, 'labels');

    renderer._resetScreenTransform(overlayCtx);
    renderer.harborTraffic?.drawScreenSummary(overlayCtx, viewport, renderer.camera, renderNow);
    drawVillageDirectorScreen(overlayCtx, villageSnapshot, viewport);
    // 5.4 — the work score's badge and every exact count, once, on the shared
    // upper overlay so Canvas and resident WebGL say the same thing.
    drawWorkScoreScreen(overlayCtx, viewport, villageSnapshot?.workScore || {});
    // 5.7 — offscreen-event edge indicators (incl. cues the CameraDirector
    // dropped): small screen-edge markers, click to glide there.
    drawOffscreenCueEdges(overlayCtx, renderer, viewport, renderNow);
    // V8 — moments that could not stand in their column dock here.
    drawMomentEdgePlates(overlayCtx);
    // 5.7/5.2 — cinematic letterbox bars: they ride a release/incident cue
    // glide, and an ambient chapter holds them for a beat after settling so
    // the caption is read at rest. Reduced motion draws none.
    drawCueLetterbox(overlayCtx, renderer.camera, viewport);
    // T1 — attention plates and beacons (plan 5.1), laid out from live status
    // in _assignAgentOverlaySlots. Drawn once, ungraded, after the letterbox
    // so no bar, focus or Ambient state can hide an agent that needs you.
    drawAttentionPlates(overlayCtx, renderer._attentionLayout);
    // 5.1/5.2/5.5 — the lower-third caption, drawn after the bars so they
    // never cover it. Static text, no motion of its own.
    drawAmbientCaption(overlayCtx, ambientCaption);
    drawDebugOverlay(renderer, overlayCtx, atmosphere, viewport);
    const timings = finishFrameTiming(renderer, frameTimer);
    if (frameTimer) {
        const renderStats = renderer._lastRenderStats || (renderer._lastRenderStats = {});
        renderStats.timings = timings;
    }
}

// 0.2 — which ground cues a pass paints. Canvas paints all of them into the
// frame in one pass. The resident path splits them by how they change: tile-
// anchored crowd auras and the transient or text-bearing washes (recoveries,
// the parade, replay, the work score) go into the retained texture, which
// re-renders only when their quantized state changes (plus the 8 Hz ornament
// tick while a transient animates); every cue that follows an agent or pulses
// (building halos, team auras, incidents, council rings, tethers, trails, the
// hovered/selected building's routes, the shared-file knot) is recorded as
// native ground records each frame.
export const GROUND_CUES_ALL = 'all';
export const GROUND_CUES_RETAINED = 'retained';
export const GROUND_CUES_LIVE = 'live';

const EMPTY_LIST = Object.freeze([]);

function retainedDirectorSnapshot(renderer, snapshot) {
    if (!snapshot) return null;
    const view = renderer._retainedDirectorView || (renderer._retainedDirectorView = {});
    view.now = snapshot.now;
    view.perfNow = snapshot.perfNow;
    view.motionScale = snapshot.motionScale;
    view.selectedAgentId = snapshot.selectedAgentId;
    view.selectedBuildingSignal = null;
    view.hoverBuildingSignal = null;
    view.incidents = EMPTY_LIST;
    view.replaySamples = snapshot.replaySamples;
    view.recoveries = snapshot.recoveries;
    view.releaseParade = snapshot.releaseParade;
    return view;
}

function liveDirectorSnapshot(renderer, snapshot) {
    if (!snapshot) return null;
    const view = renderer._liveDirectorView || (renderer._liveDirectorView = {});
    view.now = snapshot.now;
    view.perfNow = snapshot.perfNow;
    view.motionScale = snapshot.motionScale;
    view.selectedAgentId = snapshot.selectedAgentId;
    view.selectedBuildingSignal = snapshot.selectedBuildingSignal;
    view.hoverBuildingSignal = snapshot.hoverBuildingSignal;
    view.incidents = snapshot.incidents;
    view.replaySamples = EMPTY_LIST;
    view.recoveries = EMPTY_LIST;
    view.releaseParade = null;
    return view;
}

function drawGroundSemantics(renderer, groundCtx, { villageSnapshot, renderNow, perfNow, atmosphere, viewport }, layer = GROUND_CUES_ALL) {
    const live = layer !== GROUND_CUES_RETAINED;
    const retained = layer !== GROUND_CUES_LIVE;
    if (live) renderer.trailRenderer?.draw?.(groundCtx, renderer.camera, viewport, renderNow, true);

    // 5.4 — the requested work score sits on the retained ground cue texture,
    // so buildings and bodies occlude the diagram like every other ground cue.
    if (retained && villageSnapshot?.workScore) {
        drawWorkScoreGround(groundCtx, {
            ...villageSnapshot.workScore,
            zoom: renderer.camera.zoom,
            perfNow,
            motionScale: renderer.motionScale ?? 1,
        });
    }

    const directorSnapshot = layer === GROUND_CUES_ALL
        ? villageSnapshot
        : live ? liveDirectorSnapshot(renderer, villageSnapshot) : retainedDirectorSnapshot(renderer, villageSnapshot);
    drawVillageDirectorGround(groundCtx, directorSnapshot, renderNow, atmosphere?.grade);
    if (!live) {
        drawCrowdClusterAuras(groundCtx, {
            crowdStats: renderer._crowdStats,
            zoom: renderer.camera.zoom,
            lighting: atmosphere?.lighting,
        });
        return;
    }

    drawCouncilRings(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawFamilyTethers(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawAdvisorTethers(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawAllyTethers(groundCtx, {
        pairs: renderer._allyTetherPairs,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    if (retained) {
        drawCrowdClusterAuras(groundCtx, {
            crowdStats: renderer._crowdStats,
            zoom: renderer.camera.zoom,
            lighting: atmosphere?.lighting,
        });
    }
    // 4.5 — one shared-file thread and knot for the selected agent. Under
    // annotation pressure (a hundred agents) the thread is dropped entirely and
    // the upper label carries the exact per-building counts instead.
    renderer._sharedFileThreadDrawn = drawSharedFileKnot(groundCtx, {
        overlap: renderer.relationshipState?.getSnapshot?.()?.fileOverlap || null,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
        allowThread: (renderer._annotationMode || 'full') === 'full',
    });
}

// 0.2 — the per-frame half of the resident ground cues. The same painters the
// Canvas path calls draw into a GroundCueRecorder, which turns them into ground
// records on the art-pixel grid; nothing here uploads a texture unless a cue
// colour is seen for the first time.
export function recordLiveGroundCues(renderer, options) {
    const recorder = renderer._groundCueRecorder || (renderer._groundCueRecorder = new GroundCueRecorder());
    const camera = renderer.camera;
    const zoom = Math.max(0.01, Number(camera?.zoom) || 1);
    const viewport = options.viewport;
    const bounds = renderer._groundCueBounds || (renderer._groundCueBounds = {});
    bounds.left = Math.floor(-(Number(camera?.renderOffsetX) || 0) / zoom) - 4;
    bounds.top = Math.floor(-(Number(camera?.renderOffsetY) || 0) / zoom) - 4;
    bounds.right = Math.ceil(bounds.left + (viewport?.width || 0) / zoom) + 8;
    bounds.bottom = Math.ceil(bounds.top + (viewport?.height || 0) / zoom) + 8;
    recorder.begin(bounds);
    drawGroundSemantics(renderer, recorder, options, GROUND_CUES_LIVE);
    renderer._groundCueRecords = recorder.end();
    const stats = renderer._groundCueStats || (renderer._groundCueStats = {});
    stats.records = renderer._groundCueRecords.length;
    stats.unsupported = recorder.unsupported;
    stats.dropped = recorder.dropped;
    stats.swatchRevision = recorder.atlas.revision;
    return renderer._groundCueRecords;
}

export function semanticGroundScale(viewport) {
    // Integer texel grid only: 1:1, or exactly 2x magnified on wide viewports.
    return Math.max(Number(viewport?.width) || 0, Number(viewport?.height) || 0) > 1024 ? 0.5 : 1;
}

function retainedGroundState(renderer, snapshot) {
    const clusters = [];
    for (const cluster of renderer._crowdStats?.clusters || EMPTY_LIST) {
        // Cluster centroids drift in fractional tiles as members shuffle; a
        // sixteenth of a tile (2 world px) is below what the aura can show.
        clusters.push(cluster.id, Math.round(cluster.tileX * 16), Math.round(cluster.tileY * 16), cluster.count, cluster.dominantStatus);
    }
    const recoveries = [];
    for (const recovery of snapshot?.recoveries || EMPTY_LIST) {
        recoveries.push(recovery.agentId ?? recovery.id, Math.round(recovery.center?.x ?? 0), Math.round(recovery.center?.y ?? 0));
    }
    const replay = snapshot?.replaySamples?.length
        ? [snapshot.replaySamples.length, snapshot.replaySamples.at(-1)?.ts ?? 0, snapshot.selectedAgentId ?? null]
        : null;
    const parade = snapshot?.releaseParade?.center
        ? [Math.round(snapshot.releaseParade.center.x), Math.round(snapshot.releaseParade.center.y), snapshot.releaseParade.label ?? '']
        : null;
    const workScore = snapshot?.workScore?.score?.nodes?.length && snapshot.workScore.geometry?.placements?.length
        ? [snapshot.workScore.signature || snapshot.workScore.geometry.signature || '', snapshot.workScore.cursorAt ?? null]
        : null;
    const active = clusters.length > 0 || recoveries.length > 0 || replay || parade || workScore;
    // Fading recoveries, the parade, replay ageing and the score cursor animate
    // with motion on; crowd auras only change when a cluster does.
    const animated = (recoveries.length || replay || parade || workScore) && renderer.motionScale > 0;
    return { active: Boolean(active), animated: Boolean(animated), signature: JSON.stringify([clusters, recoveries, replay, parade, workScore]) };
}

export function prepareSemanticGround(renderer, viewport, snapshot, atmosphere) {
    const state = retainedGroundState(renderer, snapshot);
    renderer._semanticGroundActive = state.active;
    if (!state.active) return null;
    const canvas = renderer._semanticGroundCanvas ||= document.createElement('canvas');
    const scale = semanticGroundScale(viewport);
    const width = Math.ceil(viewport.width * scale);
    const height = Math.ceil(viewport.height * scale);
    // The GPU record spans the texture's own footprint, so the texel-to-pixel
    // ratio stays exactly 1/scale even when the viewport has an odd width.
    const footprint = renderer._semanticGroundViewport || (renderer._semanticGroundViewport = {});
    footprint.width = width / scale;
    footprint.height = height / scale;
    renderer._semanticGroundScale = scale;
    const camera = renderer.camera;
    const key = [width, height, camera.renderOffsetX, camera.renderOffsetY, camera.zoom,
        state.animated ? Math.floor((renderer.motionTimeMs || 0) / 125) : 0,
        renderer.motionScale,
        state.signature,
        // Light boost changes continuously through the day. Sub-byte alpha
        // drift must not turn a static cue texture into a per-frame upload.
        Math.round((atmosphere?.lighting?.lightBoost ?? 1) * 64), atmosphere?.grade?.worldTint,
    ].join(';');
    const ctx = canvas.getContext('2d');
    if (key === renderer._semanticGroundKey) return { ctx, dirty: false };
    // B.2 — on the same canvas size and camera transform the last redraw's
    // painted extent is the only non-transparent area: clear just it, record
    // this redraw's extent, and upload their union (plus any rect a skipped
    // upload left behind) through a sub-rect texSubImage2D.
    const transform = [width, height, camera.renderOffsetX, camera.renderOffsetY, camera.zoom].join(';');
    const previous = canvas.width === width && canvas.height === height
        && renderer._semanticGroundTransform === transform
        ? renderer._semanticGroundExtent
        : null;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!previous) ctx.clearRect(0, 0, width, height);
    else if (!previous.empty) ctx.clearRect(previous.x0, previous.y0, previous.x1 - previous.x0, previous.y1 - previous.y0);
    ctx.setTransform(camera.zoom * scale, 0, 0, camera.zoom * scale, camera.renderOffsetX * scale, camera.renderOffsetY * scale);
    const uploaded = renderer.gpuWorld?.hasResidentTexture?.('ground:semantics', renderer._semanticGroundRevision) === true;
    const carried = uploaded ? null : renderer._semanticGroundPending;
    renderer._semanticGroundKey = key;
    renderer._semanticGroundTransform = transform;
    const extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, full: false };
    const finish = () => {
        const painted = pixelExtent(extent, width, height);
        renderer._semanticGroundExtent = painted;
        renderer._semanticGroundRevision = (renderer._semanticGroundRevision || 0) + 1;
        if (!previous) {
            renderer._semanticGroundPending = null;
            renderer._semanticGroundUpdates = null;
            return;
        }
        const dirty = unionExtent(unionExtent(previous, painted), carried);
        renderer._semanticGroundPending = dirty;
        renderer._semanticGroundUpdates = dirty.empty ? null : [{
            x: dirty.x0, y: dirty.y0, sx: dirty.x0, sy: dirty.y0,
            width: dirty.x1 - dirty.x0, height: dirty.y1 - dirty.y0, source: canvas,
        }];
    };
    return { ctx: paintBoundsContext(ctx, extent), dirty: true, finish };
}

const EMPTY_EXTENT = Object.freeze({ empty: true, x0: 0, y0: 0, x1: 0, y1: 0 });

// Integer canvas rect of a device-space paint extent, 2 px padded (stroke
// caps, glyph antialiasing) and clamped to the canvas.
function pixelExtent(extent, width, height) {
    if (extent.full) return { empty: false, x0: 0, y0: 0, x1: width, y1: height };
    if (!(extent.x1 >= extent.x0) || !(extent.y1 >= extent.y0)) return EMPTY_EXTENT;
    const x0 = Math.max(0, Math.floor(extent.x0) - 2);
    const y0 = Math.max(0, Math.floor(extent.y0) - 2);
    const x1 = Math.min(width, Math.ceil(extent.x1) + 2);
    const y1 = Math.min(height, Math.ceil(extent.y1) + 2);
    return x1 > x0 && y1 > y0 ? { empty: false, x0, y0, x1, y1 } : EMPTY_EXTENT;
}

function unionExtent(a, b) {
    if (!b || b.empty) return a;
    if (!a || a.empty) return b;
    return { empty: false, x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

// Composite modes that change pixels outside the drawn shape.
const UNBOUNDED_COMPOSITES = new Set(['copy', 'source-in', 'source-out', 'destination-in', 'destination-atop']);

// B.2 — a 2D context wrapper that forwards every call and grows `extent`
// (device px) by the conservative bounds of each paint: path control points
// (a curve lies in their hull), stroke width, text metrics, image and rect
// destinations. Path2D arguments, shadows and unbounded composites mark the
// whole canvas. Filters are not tracked: the pixel grammar admits only
// per-pixel colour filters (never blur), which paint inside the shape.
function paintBoundsContext(ctx, extent) {
    let path = null;
    const grow = (box, pad = 0) => {
        if (!box) return;
        extent.x0 = Math.min(extent.x0, box.x0 - pad);
        extent.y0 = Math.min(extent.y0, box.y0 - pad);
        extent.x1 = Math.max(extent.x1, box.x1 + pad);
        extent.y1 = Math.max(extent.y1, box.y1 + pad);
    };
    const deviceBox = (x0, y0, x1, y1) => {
        const m = ctx.getTransform();
        const xs = [m.a * x0 + m.c * y0 + m.e, m.a * x1 + m.c * y0 + m.e, m.a * x0 + m.c * y1 + m.e, m.a * x1 + m.c * y1 + m.e];
        const ys = [m.b * x0 + m.d * y0 + m.f, m.b * x1 + m.d * y0 + m.f, m.b * x0 + m.d * y1 + m.f, m.b * x1 + m.d * y1 + m.f];
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    };
    const addToPath = (x0, y0, x1, y1) => {
        const box = deviceBox(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
        path = path ? { x0: Math.min(path.x0, box.x0), y0: Math.min(path.y0, box.y0), x1: Math.max(path.x1, box.x1), y1: Math.max(path.y1, box.y1) } : box;
    };
    const addPoints = (coords) => {
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (let i = 0; i + 1 < coords.length; i += 2) {
            x0 = Math.min(x0, coords[i]); x1 = Math.max(x1, coords[i]);
            y0 = Math.min(y0, coords[i + 1]); y1 = Math.max(y1, coords[i + 1]);
        }
        if (x1 >= x0) addToPath(x0, y0, x1, y1);
    };
    const strokePad = () => {
        const m = ctx.getTransform();
        const scale = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
        const join = ctx.lineJoin === 'miter' ? Math.max(1, ctx.miterLimit) : 1;
        return (Number(ctx.lineWidth) || 1) * scale * join * 0.5 + 1;
    };
    const unbounded = () => UNBOUNDED_COMPOSITES.has(ctx.globalCompositeOperation)
        || ((ctx.shadowBlur > 0 || ctx.shadowOffsetX || ctx.shadowOffsetY) && ctx.shadowColor !== 'rgba(0, 0, 0, 0)');
    const paint = (box, pad = 0) => {
        if (unbounded()) extent.full = true;
        else grow(box, pad);
    };
    const wrap = {
        beginPath: () => { path = null; ctx.beginPath(); },
        moveTo: (x, y) => { addPoints([x, y]); ctx.moveTo(x, y); },
        lineTo: (x, y) => { addPoints([x, y]); ctx.lineTo(x, y); },
        quadraticCurveTo: (...a) => { addPoints(a); ctx.quadraticCurveTo(...a); },
        bezierCurveTo: (...a) => { addPoints(a); ctx.bezierCurveTo(...a); },
        arcTo: (x1, y1, x2, y2, r) => { addToPath(Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r); ctx.arcTo(x1, y1, x2, y2, r); },
        rect: (x, y, w, h) => { addToPath(x, y, x + w, y + h); ctx.rect(x, y, w, h); },
        roundRect: (x, y, w, h, r) => { addToPath(x, y, x + w, y + h); ctx.roundRect(x, y, w, h, r); },
        arc: (x, y, r, ...a) => { addToPath(x - r, y - r, x + r, y + r); ctx.arc(x, y, r, ...a); },
        ellipse: (x, y, rx, ry, ...a) => { const r = Math.max(rx, ry); addToPath(x - r, y - r, x + r, y + r); ctx.ellipse(x, y, rx, ry, ...a); },
        fill: (...a) => { if (typeof a[0] === 'object' && a[0]) extent.full = true; else paint(path, 1); ctx.fill(...a); },
        stroke: (...a) => { if (typeof a[0] === 'object' && a[0]) extent.full = true; else paint(path, strokePad()); ctx.stroke(...a); },
        fillRect: (x, y, w, h) => { paint(deviceBox(Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)), 1); ctx.fillRect(x, y, w, h); },
        strokeRect: (x, y, w, h) => { paint(deviceBox(Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)), strokePad()); ctx.strokeRect(x, y, w, h); },
        clearRect: (x, y, w, h) => { grow(deviceBox(Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)), 1); ctx.clearRect(x, y, w, h); },
        fillText: (text, x, y, maxWidth) => { paint(textBox(text, x, y, maxWidth), 2); ctx.fillText(text, x, y, maxWidth); },
        strokeText: (text, x, y, maxWidth) => { paint(textBox(text, x, y, maxWidth), strokePad() + 2); ctx.strokeText(text, x, y, maxWidth); },
        drawImage: (image, ...a) => {
            const [dx, dy, dw, dh] = a.length >= 8 ? a.slice(4, 8) : a.length >= 4 ? a : [a[0], a[1], image?.width || 0, image?.height || 0];
            paint(deviceBox(Math.min(dx, dx + dw), Math.min(dy, dy + dh), Math.max(dx, dx + dw), Math.max(dy, dy + dh)), 1);
            ctx.drawImage(image, ...a);
        },
        putImageData: (data, dx, dy, ...a) => { extent.full = true; ctx.putImageData(data, dx, dy, ...a); },
    };
    function textBox(text, x, y, maxWidth) {
        const m = ctx.measureText(String(text ?? ''));
        const w = Number.isFinite(maxWidth) ? Math.min(maxWidth, m.actualBoundingBoxLeft + m.actualBoundingBoxRight) : m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        return deviceBox(x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent, x - m.actualBoundingBoxLeft + w, y + m.actualBoundingBoxDescent);
    }
    const bound = new Map();
    return new Proxy(ctx, {
        get(target, prop) {
            if (Object.hasOwn(wrap, prop)) return wrap[prop];
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            let fn = bound.get(prop);
            if (!fn) bound.set(prop, fn = value.bind(target));
            return fn;
        },
        set(target, prop, value) {
            return Reflect.set(target, prop, value, target);
        },
    });
}

// 5.7 — cinematic letterbox bars while a release/incident camera cue glide
// owns the frame. Bar height rides the glide's bell-curve weight so the bars
// slide in and out with the move; a 1px brass line on the inner edge keeps
// them reading as cinema chrome, not a render artifact. The bars are neutral
// brass whatever the cue: nothing here tints the frame (0.2, V3). Reduced
// motion: cue glides are suppressed and Camera cuts instead, so no bars ever
// appear.
//
// 5.2 — an Ambient incident chapter keeps its bars at full height for three
// seconds after the move settles instead of dropping them on arrival, so the
// caption is read at rest. The Camera owns that timing (getLetterboxState);
// cue bars are unchanged.
function drawCueLetterbox(ctx, camera, viewport) {
    if (!camera?.getLetterboxState || !viewport?.width || !viewport?.height) return 0;
    const state = camera.getLetterboxState();
    const weight = Math.max(0, Math.min(1, Number(state?.weight) || 0));
    if (weight <= 0.02) return 0;
    const barH = Math.round(Math.min(72, viewport.height * 0.08) * weight);
    if (barH < 2) return 0;
    ctx.save();
    ctx.fillStyle = 'rgba(12, 9, 7, 0.94)';
    ctx.fillRect(0, 0, viewport.width, barH);
    ctx.fillRect(0, viewport.height - barH, viewport.width, barH);
    ctx.fillStyle = `rgba(184, 137, 63, ${0.5 * weight})`;
    ctx.fillRect(0, barH, viewport.width, 1);
    ctx.fillRect(0, viewport.height - barH - 1, viewport.width, 1);
    ctx.restore();
    return barH;
}

// 5.1/5.2/5.5 — the broadcast caption as a bottom-left lower third: an 8 px
// Press Start 2P eyebrow over one 11 px Departure Mono line, on a dark strip
// with a 1 px accent rule above and no outline. It carries the Ambient line
// ("Forge · 4 working"), the incident chapter's identity ("Push failed ·
// pharos-watch"), and the release parade that used to float as a world pill.
// Static: no fade, no motion, identical in Canvas and resident WebGL, and
// present under reduced motion where it is the only thing the static
// overview has to say. Measured once per frame, before the label pass, so
// the plaques treat its strip as occupied.
const CAPTION_LEFT = 24;
const CAPTION_BOTTOM = 24;
const CAPTION_PAD_X = 10;
const CAPTION_HEIGHT = 36;
const CAPTION_REPLAY_RESERVE = 34;
const CAPTION_STYLES = Object.freeze({
    ambient: { eyebrow: 'AMBIENT', accent: '#b8893f', text: '#f3e2bd' },
    incident: { eyebrow: 'INCIDENT', accent: '#e06c5b', text: '#ffd9d3' },
    release: { eyebrow: 'RELEASE', accent: '#6db3a5', text: '#f3e2bd' },
    milestone: { eyebrow: 'MILESTONE', accent: '#b9ad96', text: '#f3e2bd' },
    returned: { eyebrow: 'RETURNED', accent: '#b9ad96', text: '#f3e2bd' },
});

// V8 — caption priority: incident > verified release > returned > milestone.
// An incident is the chapter Ambient composed, or a verified failed/rejected
// push inside its window whether or not Ambient owns the camera (the bracket
// at the slip has no words of its own). The standing Ambient line yields to
// the three event lines and outranks a milestone; a biography banner never
// blocks the first three (VillageDirector stages banners in the same order).
function captionSource(renderer, villageSnapshot) {
    const ambient = renderer?.cameraDirector?.getAmbientCaption?.();
    const ambientText = String(ambient?.text || '').trim();
    if (ambientText && ambient.kind === 'chapter') return { style: CAPTION_STYLES.incident, text: ambientText };
    const chapter = villageSnapshot?.incidentChapter;
    const chapterText = String(chapter?.caption || '').trim();
    if (chapterText && chapter.kind === 'failed-push') return { style: CAPTION_STYLES.incident, text: chapterText };
    const parade = villageSnapshot?.releaseParade;
    const paradeText = String(parade?.label || '').trim();
    if (paradeText && parade.kind === 'parade') return { style: CAPTION_STYLES.release, text: paradeText };
    // A sub-agent's session ending is not celebrated: its return is the
    // neutral RETURNED line (child → parent), with no success wording.
    if (paradeText && parade.kind === 'return-banner') return { style: CAPTION_STYLES.returned, text: paradeText };
    if (ambientText) return { style: CAPTION_STYLES.ambient, text: ambientText };
    // A biography milestone is a neutral stone line, never a parade.
    if (paradeText && parade.kind === 'biography-banner') {
        const agent = parade.agentId ? renderer?.world?.agents?.get?.(parade.agentId) : null;
        if (!agent?.isSubagent) return { style: CAPTION_STYLES.milestone, text: paradeText };
    }
    return null;
}

function ambientCaptionLayout(ctx, renderer, viewport, villageSnapshot = null) {
    const source = captionSource(renderer, villageSnapshot);
    if (!source || !viewport?.width || !viewport?.height) return null;
    const bars = renderer.camera?.getLetterboxState?.();
    const barH = bars?.weight > 0.02
        ? Math.round(Math.min(72, viewport.height * 0.08) * Math.min(1, bars.weight))
        : 0;
    ctx.save();
    ctx.font = WORLD_BODY_FONT_11;
    const text = fitLabelText(ctx, source.text, Math.max(120, Math.round(viewport.width * 0.42)));
    const textWidth = measureLabelText(ctx, text);
    ctx.font = WORLD_DISPLAY_FONT_8;
    const eyebrowWidth = measureLabelText(ctx, source.style.eyebrow);
    ctx.restore();
    const width = Math.max(textWidth, eyebrowWidth) + CAPTION_PAD_X * 2;
    // Over the lower letterbox bar when bars are up; above the replay chip
    // when the 60 s replay badge holds the corner.
    const bottomInset = Math.max(barH > CAPTION_HEIGHT ? Math.round((barH - CAPTION_HEIGHT) / 2) : CAPTION_BOTTOM,
        villageSnapshot?.replayActive ? CAPTION_BOTTOM + CAPTION_REPLAY_RESERVE : 0);
    const bottom = viewport.height - bottomInset;
    const left = CAPTION_LEFT;
    return {
        text,
        style: source.style,
        rect: { left, top: bottom - CAPTION_HEIGHT, right: left + width, bottom },
    };
}

function drawAmbientCaption(ctx, layout) {
    if (!layout) return;
    const { rect, style, text } = layout;
    const width = rect.right - rect.left;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(12, 9, 7, 0.94)';
    ctx.fillRect(rect.left, rect.top, width, CAPTION_HEIGHT);
    ctx.fillStyle = style.accent;
    ctx.fillRect(rect.left, rect.top, width, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = WORLD_DISPLAY_FONT_8;
    ctx.fillText(style.eyebrow, rect.left + CAPTION_PAD_X, rect.top + 15);
    ctx.font = WORLD_BODY_FONT_11;
    ctx.fillStyle = style.text;
    ctx.fillText(text, rect.left + CAPTION_PAD_X, rect.top + 28);
    ctx.restore();
}

// 0.7 — PRIMARY marks survive night. On the Canvas backend everything drawn
// before _drawAtmosphere is dimmed by the multiply grade, so the selected
// agent's pixel chevron is re-struck here, scaled by the beacon night factor
// the lantern glows use. The resident overlay is ungraded and needs nothing.
// Action-needed agents need no re-stamp on either backend: their T1 plates
// and beacons are drawn once, at full strength, on the ungraded overlay.
// Reduced motion: identical — the re-stamp carries no motion of its own.
function drawPrimaryMarksPostAtmosphere(renderer, ctx, atmosphere, { force = false } = {}) {
    if (force) return;
    const sprite = renderer.selectedAgent?.id ? renderer.agentSprites?.get?.(renderer.selectedAgent.id) : null;
    if (!sprite?.selected || !sprite._bodyBox) return;
    const nightFactor = primaryRestampNightFactor(renderer, atmosphere);
    if (nightFactor <= 0.06) return;
    const drawChevron = () => {
        ctx.save();
        ctx.globalAlpha = nightFactor;
        sprite._drawSelectionChevron?.(ctx, sprite.y + sprite._bodyBox.top);
        ctx.restore();
    };
    if (typeof sprite.withBridgeLift === 'function') sprite.withBridgeLift(drawChevron);
    else drawChevron();
}

function primaryRestampNightFactor(renderer, atmosphere) {
    const fromRenderer = renderer._lanternNightFactor?.(atmosphere);
    if (Number.isFinite(fromRenderer)) return fromRenderer;
    const lighting = atmosphere?.lighting || null;
    if (!lighting) return 0;
    const beacon = Number(lighting.beaconIntensity);
    if (Number.isFinite(beacon)) return Math.max(0, Math.min(1, beacon));
    const ambient = Number(lighting.ambientLight);
    return Number.isFinite(ambient) ? Math.max(0, Math.min(1, 1 - ambient)) : 0;
}

// ---------------------------------------------------------------------------
// 0.10 — ground haze over water and lowlands: the world-locked stepped field
// (see HAZE_TEXEL above), baked once per map revision and drawn at the
// stepped `groundHazeStrength`. On the resident path the GPU `ground:haze`
// record samples the same canvas over the same world rect.
function hazeRoadPoints(renderer) {
    if (renderer._hazeRoadPoints) return renderer._hazeRoadPoints;
    renderer._hazeRoadPoints = collectRoadCarvePoints({
        pathTiles: renderer.pathTiles,
        mainAvenueTiles: renderer.mainAvenueTiles,
        dirtPathTiles: renderer.dirtPathTiles,
        commandCenterRoadTiles: renderer.commandCenterRoadTiles,
    });
    return renderer._hazeRoadPoints;
}

function hazeBounds(points) {
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const x = Math.floor((Math.min(...xs) - HAZE_MARGIN) / HAZE_TEXEL) * HAZE_TEXEL;
    const y = Math.floor((Math.min(...ys) - HAZE_MARGIN) / HAZE_TEXEL) * HAZE_TEXEL;
    return {
        x,
        y,
        w: Math.ceil((Math.max(...xs) + HAZE_MARGIN - x) / HAZE_TEXEL) * HAZE_TEXEL,
        h: Math.ceil((Math.max(...ys) + HAZE_MARGIN - y) / HAZE_TEXEL) * HAZE_TEXEL,
    };
}

// The baked field, keyed by the terrain revision and the water it hangs over.
function ensureHazeField(renderer) {
    const points = renderer._worldDiamondPoints?.();
    if (!Array.isArray(points) || points.length < 4 || typeof document === 'undefined') return null;
    const key = `${renderer.terrainCacheKey || 'static'}|${renderer.waterTiles?.size || 0}`;
    if (renderer._hazeField?.key === key) return renderer._hazeField;
    const { anchors } = collectHazeAnchors({
        waterTiles: renderer.waterTiles,
        waterMeta: renderer.waterMeta,
        lowlandPoints: lowlandPointsFromDiamond(points),
    });
    const baked = bakeHazeField({ anchors, roads: hazeRoadPoints(renderer), bounds: hazeBounds(points) });
    const canvas = renderer._hazeField?.canvas || document.createElement('canvas');
    canvas.width = baked.width;
    canvas.height = baked.height;
    const hazeCtx = canvas.getContext('2d');
    if (!hazeCtx) return null;
    hazeCtx.putImageData(new ImageData(baked.data, baked.width, baked.height), 0, 0);
    renderer._hazeField = { key, canvas, x: baked.x, y: baked.y, w: baked.w, h: baked.h };
    return renderer._hazeField;
}

// Reduced motion latches the governor's level with the weather overlay's
// (one static frame; `weatherPressureLevel`).
function hazePressureLevel(renderer, atmosphere, viewport) {
    return weatherPressureLevel(atmosphere, !((renderer.motionScale ?? 1) > 0), {
        zoom: renderer.camera?.zoom,
        width: viewport?.width,
        height: viewport?.height,
    });
}

function drawGroundHaze(renderer, ctx, atmosphere, viewport) {
    const plan = hazePlanForPressure(hazePressureLevel(renderer, atmosphere, viewport), renderer.motionScale ?? 1);
    const strength = groundHazeStrength(atmosphere, plan.density);
    if (strength <= 0) return;
    const field = ensureHazeField(renderer);
    if (!field?.canvas) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = strength;
    ctx.drawImage(field.canvas, field.x, field.y, field.w, field.h);
    ctx.restore();
}

// 0.10 — the fog banks on the ground plane (WeatherRenderer
// `groundFogLayer`): a world-locked tile lattice below the sea horizon,
// under every body, building and tree. `groundFogSpan` is the visible world
// rect it covers this frame.
function groundFogSpan(renderer, viewport, layer) {
    const camera = renderer.camera;
    const zoom = Math.max(0.01, Number(camera?.zoom) || 1);
    const left = Math.floor(-(Number(camera?.renderOffsetX) || 0) / zoom) - layer.texel;
    const top = Math.max(layer.top, Math.floor(-(Number(camera?.renderOffsetY) || 0) / zoom) - layer.texel);
    const right = left + Math.ceil((Number(viewport?.width) || 0) / zoom) + layer.texel * 2;
    const bottom = Math.floor(-(Number(camera?.renderOffsetY) || 0) / zoom) + Math.ceil((Number(viewport?.height) || 0) / zoom) + layer.texel;
    return bottom > top && right > left ? { left, top, right, bottom } : null;
}

function groundFogFor(renderer, atmosphere, viewport, graded = false) {
    return renderer.weatherRenderer?.groundFogLayer?.({
        atmosphere,
        viewport,
        timeMs: renderer.motionTimeMs,
        graded,
    }) || null;
}

function drawGroundFog(ctx, renderer, atmosphere, viewport, { graded = false } = {}) {
    const layer = groundFogFor(renderer, atmosphere, viewport, graded);
    const span = layer && groundFogSpan(renderer, viewport, layer);
    if (!span) return;
    let cached = renderer._groundFogPattern;
    if (cached?.key !== layer.key || cached.canvas !== layer.canvas) {
        const pattern = ctx.createPattern(layer.canvas, 'repeat');
        if (!pattern) return;
        cached = renderer._groundFogPattern = { key: layer.key, canvas: layer.canvas, pattern };
    }
    cached.pattern.setTransform?.(new DOMMatrix([layer.texel, 0, 0, layer.texel, layer.x, layer.y]));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = cached.pattern;
    ctx.fillRect(span.left, span.top, span.right - span.left, span.bottom - span.top);
    ctx.restore();
}

// The resident path: one ground record per lattice cell in view, each cut to
// the visible span on the texel grid (records reused frame to frame).
function groundFogRecords(renderer, atmosphere, viewport) {
    const out = renderer._groundFogRecords || (renderer._groundFogRecords = []);
    out.length = 0;
    const layer = groundFogFor(renderer, atmosphere, viewport);
    const span = layer && groundFogSpan(renderer, viewport, layer);
    if (!span) return out;
    const pool = renderer._groundFogRecordPool || (renderer._groundFogRecordPool = []);
    const { width: W, height: H, texel } = layer;
    const snapDown = (value, origin) => origin + Math.floor((value - origin) / texel) * texel;
    const snapUp = (value, origin) => origin + Math.ceil((value - origin) / texel) * texel;
    for (let j = Math.floor((span.top - layer.y) / H); layer.y + j * H < span.bottom; j++) {
        const tileY = layer.y + j * H;
        const y0 = snapDown(Math.max(span.top, tileY), tileY);
        const y1 = snapUp(Math.min(span.bottom, tileY + H), tileY);
        if (!(y1 > y0)) continue;
        for (let i = Math.floor((span.left - layer.x) / W); layer.x + i * W < span.right; i++) {
            const tileX = layer.x + i * W;
            const x0 = snapDown(Math.max(span.left, tileX), tileX);
            const x1 = snapUp(Math.min(span.right, tileX + W), tileX);
            if (!(x1 > x0)) continue;
            const record = pool[out.length] || (pool[out.length] = {
                id: 'ground:fog',
                stableKey: 'ground:fog',
                textureKey: 'ground-fog-tile',
                material: materialClassId('default'),
                alpha: 1,
                elevation: 0,
                emissive: 0,
                occluder: 0,
                sequence: -0.85,
                sourceKind: 'individual',
                // V9 — like the haze field, the fog's texels sit on the screen.
                screenSpace: true,
            });
            record.source = layer.canvas;
            record.sourceWidth = layer.canvas.width;
            record.sourceHeight = layer.canvas.height;
            record.sx = (x0 - tileX) / texel;
            record.sy = (y0 - tileY) / texel;
            record.sw = (x1 - x0) / texel;
            record.sh = (y1 - y0) / texel;
            record.x = x0;
            record.y = y0;
            record.width = x1 - x0;
            record.height = y1 - y0;
            record.textureRevision = layer.key;
            out.push(record);
        }
    }
    return out;
}

// After the terrain and the ground haze, ahead of the retained cue texture
// and every live cue (the Canvas order: haze, fog, then the ground cues).
function insertGroundFogRecords(ordered, fogRecords) {
    if (!Array.isArray(ordered) || !fogRecords?.length) return ordered;
    let at = 0;
    while (at < ordered.length) {
        const id = ordered[at]?.id;
        if (id === 'terrain:static' || id === 'ground:haze') at++;
        else break;
    }
    ordered.splice(at, 0, ...fogRecords);
    return ordered;
}

// 0.10 — where a lightning bolt may land (and where its forks may run): the
// open ocean around the island, off the map's tile grid (the island diamond
// ends at the grid edge; everything beyond it is sea) and below the sea
// horizon, and clear of island art: the ground in front of the point for
// STRIKE_OVERHANG_PX is off the grid too, so a tall sprite on a north shore
// never stands over it. Never the island, its rivers, lagoon, harbour,
// bridges or piers: a strike in the village would read as an event. With
// `sky` the band above the sea horizon counts as open too (fork channels).
const STRIKE_OVERHANG_PX = 176;
function strikeOnGrid(worldX, worldY) {
    const tileX = Math.round(worldY / TILE_HEIGHT + worldX / TILE_WIDTH);
    const tileY = Math.round(worldY / TILE_HEIGHT - worldX / TILE_WIDTH);
    return tileX >= -1 && tileY >= -1 && tileX <= MAP_SIZE && tileY <= MAP_SIZE;
}

function strikeSeaAt(renderer) {
    if (renderer._strikeSeaAt) return renderer._strikeSeaAt;
    renderer._strikeSeaAt = (worldX, worldY, sky = false) => {
        if (!sky && !(worldY > OCEAN_HORIZON_WORLD_Y)) return false;
        for (let reach = 0; reach <= STRIKE_OVERHANG_PX; reach += TILE_HEIGHT / 2) {
            if (strikeOnGrid(worldX, worldY + reach)) return false;
        }
        return true;
    };
    return renderer._strikeSeaAt;
}

// 1.4 — world-locked dithered cloud-shadow courses from the same baked field
// as the resident composite (IsometricRenderer → CloudShadowCourses).
function drawCloudShadows(renderer, ctx, atmosphere, perfNow) {
    renderer._drawCloudShadowCourses?.(ctx, atmosphere, perfNow);
}

// 0.8 — the reflection overlays (`atmosphere.light.lantern-glow`) are smooth
// radial gradients; screen-blended as authored they laid a smooth warm wash
// round the Archive door on Canvas. Each overlay is re-cut once into three
// flat courses with a 4x4 ordered dither across the course edges (the
// CanvasGrade pool thresholds), keeping its colour, so the wash lands on the
// art grid like every other pool.
const _steppedReflections = new WeakMap();

function steppedReflection(image) {
    if (_steppedReflections.has(image)) return _steppedReflections.get(image);
    let stepped = null;
    const w = image?.naturalWidth || image?.width || 0;
    const h = image?.naturalHeight || image?.height || 0;
    if (w > 0 && h > 0 && typeof document !== 'undefined') {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const c = canvas.getContext('2d', { willReadFrequently: true });
            c.drawImage(image, 0, 0);
            const data = c.getImageData(0, 0, w, h);
            const px = data.data;
            let peak = 0;
            for (let i = 3; i < px.length; i += 4) if (px[i] > peak) peak = px[i];
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4 + 3;
                    const q = px[i] / Math.max(1, peak) + (HAZE_BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.08;
                    const course = (q >= 0.12 ? 1 : 0) + (q >= 0.40 ? 1 : 0) + (q >= 0.75 ? 1 : 0);
                    px[i] = Math.round(peak * course / 3);
                }
            }
            c.putImageData(data, 0, 0);
            stepped = canvas;
        } catch {
            stepped = null;
        }
    }
    _steppedReflections.set(image, stepped);
    return stepped;
}

function drawBuildingLightReflections(renderer, ctx, atmosphere) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    const lights = renderer._frameLightSources?.building || [];
    const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
    const alphaBase = 0.10 * glowScale;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const light of lights) {
        // 2.7 — the Lighthouse lamp lights its gallery and base course from
        // its foot (V5); no reflection sticker at the lantern over the sea.
        if (light.buildingType === 'watchtower') continue;
        const overlayId = light.overlay || 'atmosphere.light.lantern-glow';
        const overlayImg = renderer.assets.get(overlayId);
        if (!overlayImg) continue;
        const dims = renderer.assets.getDims(overlayId);
        if (!dims) continue;
        const stepped = steppedReflection(overlayImg);
        if (!stepped) continue;
        const alpha = alphaBase * (light.intensity || 1);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
            stepped,
            Math.round(light.x - dims.w / 2),
            Math.round(light.y - dims.h / 2),
            dims.w,
            dims.h,
        );
    }
    ctx.restore();
}

function drawSelectedAgentXray(renderer, ctx, buildingDrawables) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    for (const drawable of buildingDrawables) {
        if (drawable.kind !== 'building-front' && drawable.kind !== 'building') continue;
        const dims = renderer.assets.getDims(drawable.entry.id);
        if (!dims) continue;
        const [ax, ay] = renderer.assets.getAnchor(drawable.entry.id);
        const left = drawable.wx - ax;
        const top = drawable.wy - ay;
        const right = left + dims.w;
        const bottom = top + dims.h;
        const frontY = drawable.sortY;
        for (const sprite of renderer.agentSprites.values()) {
            if (!sprite.selected) continue;
            const withinSpriteBounds = sprite.x >= left - 12
                && sprite.x <= right + 12
                && sprite.y >= top
                && sprite.y <= bottom + 12;
            if (withinSpriteBounds && sprite.y < frontY) {
                sprite.drawXraySilhouette(ctx);
                return;
            }
        }
    }
}

function drawDebugOverlay(renderer, ctx, atmosphere, viewport) {
    const overlay = renderer.debugOverlay;
    // Shift-D owns pass sampling, but only at its edges: a per-frame write
    // would stomp a deliberate setPassSamplingEnabled() measurement made with
    // the overlay hidden (the overlay's own draw cost would then be inside
    // every comparison).
    if (renderer._debugPassSampling !== Boolean(overlay?.enabled)) {
        renderer._debugPassSampling = Boolean(overlay?.enabled);
        renderer.gpuWorld?.setPassSamplingEnabled?.(renderer._debugPassSampling);
    }
    if (!overlay?.enabled && !overlay?.pathDebugEnabled) return;
    const visitIntentDebug = overlay.enabled ? (renderer.visitIntentManager?.debugSnapshot?.() || null) : null;
    const visitReservationDebug = overlay.enabled ? (renderer.visitTileAllocator?.debug?.() || null) : null;
    renderer.camera.applyTransform(ctx);
    overlay.draw(ctx, {
        walkabilityGrid: renderer.walkabilityGrid,
        bridgeTiles: renderer.bridgeTiles,
        agentSprites: renderer.agentSprites,
        buildings: renderer.world?.buildings,
        sceneryZones: renderer.scenery?.getBuildingSceneryZones?.() || [],
        treeProps: renderer.treePropSprites,
        boulderProps: renderer.boulderPropSprites,
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        buildingRenderer: renderer.buildingRenderer,
    });
    overlay.drawPathDebug(ctx, { agentSprites: renderer.agentSprites });
    renderer._resetScreenTransform(ctx);
    if (!overlay.enabled) return;
    renderer._drawAtmosphereDebug(ctx, atmosphere);
    renderer.debugOverlay.drawScreen(ctx, {
        renderer,
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        agentSprites: renderer.agentSprites,
        viewport,
        panelY: 180,
        behaviorStats: renderer._agentBehaviorStats(),
        renderStats: renderer._lastRenderStats,
        // Integrator follow-up (plan 1.9): light inline camera snapshot — zoom
        // plus glide owner/state. DPR/backing pixels are derived by the overlay
        // from the viewport itself; no getCanvasBudget() call per frame.
        cameraState: cameraDebugState(renderer),
    });
}

function cameraDebugState(renderer) {
    const camera = renderer?.camera;
    if (!camera) return null;
    return {
        zoom: camera.zoom,
        owner: camera._cameraOwner || null,
        gliding: Boolean(camera.isDirectorGliding?.()),
    };
}

function buildRenderStats(renderer, {
    drawableStats,
    cullingStats,
    harborPendingRepos,
    inputCounts,
    sceneCategoryResolution,
    agentRenderMode = 'full',
    annotationMode = 'full',
}) {
    const pendingRepos = Array.isArray(harborPendingRepos) ? harborPendingRepos : [];
    return {
        drawables: drawableStats,
        culling: cullingStats,
        inputs: inputCounts,
        paintCounts: renderer._paintCounts,
        harbor: {
            pendingRepos: pendingRepos.length,
            pendingCommits: pendingRepos.reduce((sum, repo) => sum + (Number(repo.pendingCommits ?? repo.count) || 0), 0),
            failedPushes: pendingRepos.reduce((sum, repo) => sum + (Number(repo.failedPushes) || 0), 0),
            bridgeLanterns: Number(inputCounts?.sceneCategories?.['bridge-lantern']) || 0,
        },
        canvas: {
            particles: renderer.particleSystem?.particles?.length || 0,
            lightGradients: renderer.lightGradientCache?.size || 0,
            lightSources: renderer._frameLightSources?.ambient?.length || 0,
        },
        director: renderer.villageDirector?.getStats?.() || null,
        quality: {
            agentRenderMode,
            annotationMode,
            worldRendererMode: renderer.worldRendererMode || 'canvas',
            gpuWorld: renderer.gpuWorld?.getDiagnostics?.() || null,
            sceneCategories: sceneCategoryResolution?.categories || [],
        },
        terrainCache: renderer.getTerrainCacheDiagnostics?.() || null,
        timings: renderer._lastRenderStats?.timings || null,
    };
}

function sceneCommandBackend(renderer, backend) {
    const adapter = renderer._sceneCommandBackend || (renderer._sceneCommandBackend = {
        id: 'gpu-world',
        backend: null,
        supportsSceneCommands(request) {
            return this.backend?.supportsSceneCommands?.(request) === true;
        },
    });
    adapter.id = backend?.backendId || backend?.constructor?.name || 'gpu-world';
    adapter.backend = backend;
    return adapter;
}

function emitSceneCategoryDiagnostics(renderer, diagnostics = []) {
    if (!diagnostics.length) return;
    const emitted = (renderer._sceneCategoryDiagnostics ||= new Set());
    for (const diagnostic of diagnostics) {
        const key = `${diagnostic.code}:${diagnostic.backendId}:${diagnostic.categoryId}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        console.warn(diagnostic.message);
    }
}

function frameTimingRequested(renderer) {
    return Boolean(renderer?.debugOverlay?.enabled || renderer?._performanceSamples);
}

function createFrameTimer() {
    return {
        start: 0,
        last: 0,
        markCount: 0,
        maxMarks: FRAME_TIMER_MAX_MARKS,
        dropped: 0,
        lastTotalMs: 0,
        markLabels: new Array(FRAME_TIMER_MAX_MARKS),
        markMs: new Float64Array(FRAME_TIMER_MAX_MARKS),
        segmentPool: Array.from({ length: FRAME_TIMER_MAX_MARKS }, () => ({ label: '', ms: 0, p95: 0 })),
        lastTimings: { totalMs: 0, totalP50: 0, totalP95: 0, segments: [] },
    };
}

function beginFrameTiming(renderer) {
    if (!frameTimingRequested(renderer)) return null;
    const timer = renderer._frameTimer || (renderer._frameTimer = createFrameTimer());
    const now = performance.now();
    timer.start = now;
    timer.last = now;
    timer.markCount = 0;
    return timer;
}

function markFrameTiming(timer, label) {
    if (!timer) return;
    const now = performance.now();
    const ms = now - timer.last;
    timer.last = now;
    if (timer.markCount >= timer.maxMarks) {
        timer.dropped += 1;
        return;
    }
    const index = timer.markCount;
    timer.markLabels[index] = label;
    timer.markMs[index] = ms;
    timer.markCount = index + 1;
}

function writeFrameTimingSample(renderer, label, ms) {
    const rings = renderer._frameTimingSamples || (renderer._frameTimingSamples = new Map());
    let ring = rings.get(label);
    if (!ring) {
        ring = createBoundedRing(FRAME_TIMING_RING_CAPACITY);
        rings.set(label, ring);
    }
    writeBoundedRing(ring, ms);
}

function finishFrameTiming(renderer, timer) {
    if (!timer) return renderer?._lastRenderStats?.timings || null;
    const totalMs = performance.now() - timer.start;
    timer.lastTotalMs = totalMs;
    writeFrameTimingSample(renderer, 'total', totalMs);
    const timings = timer.lastTimings;
    const segments = timings.segments;
    const pool = timer.segmentPool;
    for (let i = 0; i < timer.markCount; i++) {
        const label = timer.markLabels[i];
        const ms = timer.markMs[i];
        writeFrameTimingSample(renderer, label, ms);
        const slot = pool[i];
        slot.label = label;
        slot.ms = ms;
        slot.p95 = 0;
        segments[i] = slot;
    }
    segments.length = timer.markCount;
    timings.totalMs = totalMs;
    timings.totalP50 = 0;
    timings.totalP95 = 0;
    if (timer.dropped) {
        if (renderer._frameEnvelope) renderer._frameEnvelope.droppedSamples += timer.dropped;
        timer.dropped = 0;
    }
    return timings;
}
