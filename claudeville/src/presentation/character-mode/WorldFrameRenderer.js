import { eventBus } from '../../domain/events/DomainEvent.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
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
import { createBoundedRing, writeBoundedRing } from '../shared/ClientPerfMetrics.js';
import { drawWorkScoreGround, drawWorkScoreScreen } from './SpatialWorkScore.js';
import { ornamentPlan, sampleFramePressure } from './MarkGovernor.js';
import { GroundCueRecorder, insertGroundCueRecords } from './GroundCueRecords.js';
import { PARTICLE_LAYER_AIR } from './ParticleSystem.js';
import { gradeColor } from './AtmosphereState.js';
import { drawCanvasAerialHaze, drawResidentBackdropGrade } from './BackdropGrade.js';
import { castLightingFor, drawTreeCasts, setFrameCastLighting } from './RakingLight.js';

const FRAME_TIMING_RING_CAPACITY = 90;
const FRAME_TIMER_MAX_MARKS = 48;
const CANVAS_SCENE_BACKEND = Object.freeze({ id: 'canvas-2d', canvasFallback: true });
// 3.5 — the authored palette-ramp table (11x3 RGBA, nearest-sampled). Declared
// in the sprite manifest like every other asset; absent means the Command
// pilot keeps today's additive light response.
export const PALETTE_RAMP_ASSET_ID = 'lut.light-ramp.command';

// Quarter-res occupancy field, matching the PostFx water-mask budget. One
// byte per sample; the renderer paints it into a reused quarter-res canvas
// only when the pose/viewport/atmosphere key changes.
export const HAZE_FIELD_SCALE = 0.25;
export const HAZE_FIELD_BYTES_PER_SAMPLE = 1;
export const HAZE_ALPHA_CAP = 0.16;
export const HAZE_WATER_FALLOFF_PX = 220;
export const HAZE_LOWLAND_FALLOFF_PX = 160;
export const HAZE_ROAD_CARVE_RADIUS_PX = 28;
export const HAZE_SUBJECT_CARVE_RADIUS_PX = 42;
export const HAZE_ROAD_CARVE = 0.12;
export const HAZE_SUBJECT_CARVE = 0.18;
export const WETNESS_ATTACK_MS = 480;
export const WETNESS_RELEASE_MS = 4000;
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

export function hazeFieldSampleCount(viewportWidth, viewportHeight, scale = HAZE_FIELD_SCALE) {
    const width = Math.max(1, Math.ceil(Math.max(0, Number(viewportWidth) || 0) * scale));
    const height = Math.max(1, Math.ceil(Math.max(0, Number(viewportHeight) || 0) * scale));
    return width * height;
}

export function hazeFieldMemoryBytes(viewportWidth, viewportHeight, scale = HAZE_FIELD_SCALE) {
    return hazeFieldSampleCount(viewportWidth, viewportHeight, scale) * HAZE_FIELD_BYTES_PER_SAMPLE;
}

export function hazePlanForPressure(level = 0, motionScale = 1) {
    const reduced = Number(motionScale) <= 0;
    const plan = ornamentPlan({ level, motionScale: reduced ? 0 : 1 });
    const shed = plan.ambientWeatherEmbellishment === 'off';
    return {
        density: shed ? 0.36 : 1,
        detail: shed ? 0 : 1,
        fieldScale: shed ? 0.125 : HAZE_FIELD_SCALE,
        static: reduced,
        rebuild: !reduced,
        pressureLevel: Number(level) || 0,
    };
}

export function hazeFieldCacheKey({
    camera = null,
    viewport = null,
    atmosphereBucket = '',
    pressureLevel = 0,
    focusedId = '',
    fieldScale = HAZE_FIELD_SCALE,
} = {}) {
    const x = Math.round((Number(camera?.x) || 0) * 2) / 2;
    const y = Math.round((Number(camera?.y) || 0) * 2) / 2;
    const z = Math.round((Number(camera?.zoom) || 1) * 100);
    const vw = Math.round(Number(viewport?.width) || 0);
    const vh = Math.round(Number(viewport?.height) || 0);
    return `${x}|${y}|${z}|${vw}x${vh}|${atmosphereBucket}|p${pressureLevel}|f${focusedId || ''}|s${fieldScale}`;
}

export function shouldRebuildHazeField(previousKey, nextKey, { motionScale = 1, hasField = false } = {}) {
    if (!nextKey) return false;
    if (previousKey === nextKey) return false;
    if (Number(motionScale) <= 0 && hasField) return false;
    return true;
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
    focused = null,
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
    if (focused && Number.isFinite(focused.x) && Number.isFinite(focused.y)) {
        const dist = isoDistance(worldX, worldY, focused.x, focused.y);
        if (dist < HAZE_SUBJECT_CARVE_RADIUS_PX) {
            const t = 1 - dist / HAZE_SUBJECT_CARVE_RADIUS_PX;
            occupancy *= 1 - t * (1 - HAZE_SUBJECT_CARVE);
        }
    }
    return occupancy;
}

export function hazeDensityAtWorld(worldX, worldY, options = {}) {
    const alphaCap = Number.isFinite(Number(options.alphaCap)) ? Number(options.alphaCap) : HAZE_ALPHA_CAP;
    const occupancy = hazeOccupancyAtWorld(worldX, worldY, options);
    return Math.min(alphaCap, occupancy * alphaCap);
}

export function projectWorldToScreen(camera, worldX, worldY) {
    const zoom = Number(camera?.zoom) || 1;
    return {
        x: (worldX + (Number(camera?.x) || 0)) * zoom,
        y: (worldY + (Number(camera?.y) || 0)) * zoom,
    };
}

export function projectScreenToWorld(camera, screenX, screenY) {
    const zoom = Number(camera?.zoom) || 1;
    return {
        x: screenX / zoom - (Number(camera?.x) || 0),
        y: screenY / zoom - (Number(camera?.y) || 0),
    };
}

export function projectHazeField({
    anchors = [],
    roads = [],
    focused = null,
    camera = { x: 0, y: 0, zoom: 1 },
    viewport = { width: 1280, height: 720 },
    scale = HAZE_FIELD_SCALE,
    strength = 1,
    densityScale = 1,
    alphaCap = HAZE_ALPHA_CAP,
} = {}) {
    const width = Math.max(1, Math.ceil(Math.max(0, Number(viewport.width) || 0) * scale));
    const height = Math.max(1, Math.ceil(Math.max(0, Number(viewport.height) || 0) * scale));
    const samples = new Uint8Array(width * height);
    const invScale = 1 / scale;
    const gain = clamp01(strength) * clamp01(densityScale);
    for (let y = 0; y < height; y++) {
        const sy = (y + 0.5) * invScale;
        for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) * invScale;
            const world = projectScreenToWorld(camera, sx, sy);
            const occupancy = hazeOccupancyAtWorld(world.x, world.y, { anchors, roads, focused });
            samples[y * width + x] = Math.round(Math.min(1, occupancy * gain) * 255);
        }
    }
    return {
        width,
        height,
        scale,
        samples,
        bytes: samples.length * HAZE_FIELD_BYTES_PER_SAMPLE,
        alphaCap,
    };
}

export function sampleHazeField(field, screenX, screenY) {
    if (!field?.samples || !field.width || !field.height) return 0;
    const scale = field.scale || HAZE_FIELD_SCALE;
    const x = Math.floor(screenX * scale);
    const y = Math.floor(screenY * scale);
    if (x < 0 || y < 0 || x >= field.width || y >= field.height) return 0;
    return field.samples[y * field.width + x] / 255;
}

export function advanceSurfaceWetness(current = 0, {
    precipitation = 0,
    dt = 16,
    weatherType = 'clear',
} = {}) {
    const wetness = clamp01(current);
    const precip = clamp01(precipitation);
    const raining = precip > 0.04 || weatherType === 'rain' || weatherType === 'storm';
    const frameDt = Math.max(0, Number(dt) || 0);
    if (raining) {
        const attack = frameDt / WETNESS_ATTACK_MS;
        return clamp01(wetness + Math.max(precip, 0.35) * attack);
    }
    return clamp01(wetness - frameDt / WETNESS_RELEASE_MS);
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
    const atmosphere = renderer.atmosphereState.update({
        now: new Date(renderNow),
        motionScale: renderer.motionScale,
        // 2.2 — village mood nudges the weather (error spikes raise
        // storminess, push streaks clear the skies). Stateless per-frame read.
        eventInfluence: combineWeatherInfluence(
            renderer.moodService?.getWeatherInfluence?.(renderNow) ?? null,
            renderer.villageDirector?.getWeatherInfluence?.(renderNow) ?? null,
        ),
    });
    renderer._lastAtmosphere = atmosphere;
    const wx = atmosphere?.weather;
    renderer._stormIntensity = (wx?.type === 'overcast' || wx?.type === 'rain' || wx?.type === 'storm') && wx.intensity > 0.4
        ? wx.intensity
        : 0;
    renderer._waterWeather = renderer._waterWeatherState(atmosphere);
    renderer._surfaceWetness = advanceSurfaceWetness(renderer._surfaceWetness || 0, {
        precipitation: wx?.precipitation || 0,
        weatherType: wx?.type || 'clear',
        dt,
    });
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
    });
    markFrameTiming(frameTimer, 'sky');

    renderer.camera.applyTransform(ctx);
    // 3.4 — cached outer ocean: one drawImage; pre-graded only on the
    // resident path (Canvas/PostFx grade the finished frame afterwards).
    renderer._drawDistantSeaHorizon(ctx, atmosphere, { gpuGraded: gpuWorldActive });
    if (gpuWorldActive) {
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
        renderer.camera.applyTransform(ctx);
    }
    markFrameTiming(frameTimer, 'horizon');
    renderer._gpuHazeStrength = 0;
    if (!gpuWorldActive) {
        renderer._drawTerrain(
            ctx,
            frameTimer ? label => markFrameTiming(frameTimer, label) : null,
        );
        // 1.4 — world-locked stepped cloud-shadow courses over the terrain.
        drawCloudShadows(renderer, ctx, atmosphere, perfNow);
        // 6.4 — ground haze over water and lowlands, drawn on the ground plane
        // ahead of agents and buildings. The ten wisps are the crest of this
        // field, not the whole effect.
        drawGroundFog(renderer, ctx, atmosphere, perfNow);
    } else {
        const pressure = sampleFramePressure();
        const plan = hazePlanForPressure(pressure.level, renderer.motionScale ?? 1);
        renderer._gpuHazeStrength = groundFogStrength(renderer, atmosphere) * plan.density;
        if (renderer._gpuHazeStrength > 0.02) ensureHazeField(renderer, atmosphere, plan);
    }
    markFrameTiming(frameTimer, 'ground-atmosphere');
    // [0.6] Draw-order: the canopy pass now also carries the hero sky rewards
    // (aurora, shooting stars, sky-flare, sun glints, push grade) so they
    // composite over terrain instead of behind the village. The rewards live
    // in SkyRenderer.drawCanopy — this call site is the whole draw-order change.
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
        renderer.buildingRenderer?.drawShadows(ctx);
        // 1.5 — tree casts on the ground layer (the resident path emits them
        // as ground records with each tree).
        drawTreeCasts(ctx, renderer.treePropSprites, castLightingFor(atmosphere), renderer.camera, viewport);
    } else {
        // 0.2 — the resident path splits the ground cues: the text-bearing
        // work score stays in the retained texture (re-uploaded only when it
        // changes), and every cue that follows an agent becomes native ground
        // records spliced in after terrain, so moving agents move records.
        const ground = prepareSemanticGround(renderer, viewport, villageSnapshot, atmosphere);
        if (ground?.dirty) drawGroundSemantics(renderer, ground.ctx, groundOptions, GROUND_CUES_RETAINED);
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
    const chroniclerDrawables = renderer.chronicler?.enumerateDrawables?.() ?? [];
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
    drawableAssembly.chroniclerDrawables = chroniclerDrawables;
    drawableAssembly.familiarDrawables = familiarDrawables;
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
    drawableContext.chronicler = renderer.chronicler;
    drawableContext.agentRenderMode = agentRenderMode;
    drawableContext.gpuWorldActive = gpuWorldActive;
    drawableContext.overlayCategoryIds = sceneCategoryResolution.overlayCategoryIds;
    drawableContext.paintCounts = paintCounts;
    drawDepthSortedDrawables(ctx, drawables, drawableContext);
    // Direct GPU carries wetness in the material shader; the discrete Canvas
    // damp-mark decoration remains fallback-only and is documented as such.
    if (!gpuWorldActive) renderer._drawSurfaceWetnessMarks?.(ctx, 'roofs');
    markFrameTiming(frameTimer, 'drawables');
    // 0.1 — on the resident path this 2D context sits under the opaque GPU
    // island, so world particles and the harbor finale replay on the overlay
    // after the GPU world renders (see drawAirParticles below) instead.
    if (!gpuWorldActive) {
        renderer.particleSystem.draw(ctx, { excludeLayer: 'screen' });
        renderer._drawChimneySmokeStatic?.(ctx);
        renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);
    }
    markFrameTiming(frameTimer, 'world-effects');

    renderer._resetScreenTransform(ctx);
    // 1.6 Canvas parity — the resident composite's stepped screen-Y aerial
    // haze over the finished Canvas world, before the frame grade.
    if (!gpuWorldActive) drawCanvasAerialHaze(ctx, { viewport, atmosphere, zoom: renderer.camera.zoom });
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
    if (gpuWorldActive) {
        const gpuBuildContext = renderer._gpuBuildContext || (renderer._gpuBuildContext = {});
        gpuBuildContext.drawables = drawables;
        const gpuFeed = Object.assign(renderer._gpuFeedEnvelope ||= {}, feed || {});
        gpuFeed.timeMs = renderer.motionTimeMs ?? feed?.timeMs;
        gpuFeed.atmosphere = atmosphere;
        gpuFeed.weather = atmosphere?.weather || null;
        gpuFeed.lighting = atmosphere?.lighting || null;
        // 3.2 — the resident shader consumes the same accumulated wetness the
        // Canvas damp marks use; it never re-derives rain history in GLSL.
        gpuFeed.wetness = renderer._surfaceWetness || 0;
        // 3.5 — the authored palette ramp travels as a plain decoded image; a
        // missing or unexpected table leaves the pilot at today's response.
        gpuFeed.paletteLut = renderer.assets?.get?.(PALETTE_RAMP_ASSET_ID) || null;
        gpuFeed.paletteLutRevision = renderer.assets?.assetVersion || null;
        gpuBuildContext.occluderChannelEnabled = renderer.gpuWorld.prepareFrame(gpuFeed);
        const records = insertGroundCueRecords(buildGpuWorldRecords(renderer, gpuBuildContext), renderer._groundCueRecords);
        const gpuRenderContext = renderer._gpuRenderContext || (renderer._gpuRenderContext = {});
        gpuRenderContext.records = records;
        gpuRenderContext.camera = renderer.camera;
        gpuRenderContext.feed = gpuFeed;
        gpuRenderContext.sceneCommands = sceneCategoryResolution.nativeCommandBatches;
        gpuWorldRendered = renderer.gpuWorld?.render?.(gpuRenderContext) === true;
        markFrameTiming(frameTimer, 'gpu-world');
    } else if (postFxActive) {
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

    renderer._resetScreenTransform(overlayCtx);
    renderer.weatherRenderer?.drawForeground(overlayCtx, {
        canvas: viewport,
        atmosphere,
        dt,
        profileMark: frameTimer ? label => markFrameTiming(frameTimer, label) : null,
    });
    renderer.camera.applyTransform(overlayCtx);
    if (gpuWorldRendered) {
        // 0.1 — open-air particles (chimney smoke, forge embers, torch flames,
        // seasonal drift, roof and lantern motes) replay above the opaque
        // island, under every mark and label. Ground-level presets stay
        // deferred here until GPU particle records exist: the overlay has no
        // depth order. 6.7 — under reduced motion the live chimneys show a
        // static wisp instead.
        drawAirParticles(renderer, overlayCtx, atmosphere);
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
                chronicler: chroniclerDrawables.length,
                familiars: familiarDrawables.length,
            },
            agentRenderMode,
            annotationMode,
        });
    }
    markFrameTiming(frameTimer, 'labels');

    renderer._resetScreenTransform(overlayCtx);
    renderer.particleSystem.draw(overlayCtx, { layer: 'screen' });
    renderer.harborTraffic?.drawScreenSummary(overlayCtx, viewport, renderer.camera, renderNow);
    drawVillageDirectorScreen(overlayCtx, villageSnapshot, viewport);
    // 5.4 — the work score's badge and every exact count, once, on the shared
    // upper overlay so Canvas and resident WebGL say the same thing.
    drawWorkScoreScreen(overlayCtx, viewport, villageSnapshot?.workScore || {});
    // 5.7 — offscreen-event edge indicators (incl. cues the CameraDirector
    // dropped): small screen-edge markers, click to glide there.
    drawOffscreenCueEdges(overlayCtx, renderer, viewport, renderNow);
    // #21 — director glide grade pass: a momentary vignette + worldTint wash that
    // fades in and out with the cinematic move. Reduced motion yields no grade
    // (the camera cut leaves nothing to fade), so this is a no-op there.
    drawDirectorGlideGrade(overlayCtx, renderer.camera?.getDirectorGlideGrade?.(), viewport);
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
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(camera.zoom * scale, 0, 0, camera.zoom * scale, camera.renderOffsetX * scale, camera.renderOffsetY * scale);
    renderer._semanticGroundKey = key;
    renderer._semanticGroundRevision = (renderer._semanticGroundRevision || 0) + 1;
    return { ctx, dirty: true };
}

// 0.1 — the open-air particle replay for the resident path. The overlay sits
// above the graded GPU composite, so lit presets (smoke, dust) take the frame's
// C2 light here: albedo x ambient light x grade gain, desaturated by the grade,
// memoized per grade course. Emissive presets (flames, embers, fireflies,
// motes) are light sources and keep their authored colour. Without a C2 grade
// the legacy multiply strength stands in.
function airParticleShade(hex, lightGrade, grade) {
    // Forge smoke arrives as `rgb(...)` (heat-mixed); presets as `#rrggbb`.
    const text = String(hex || '');
    const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(text);
    const rgb = match
        ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
        : hexToRgb(lightGrade ? text : gradeColor(text, grade));
    if (!rgb) return hex;
    let r = rgb.r;
    let g = rgb.g;
    let b = rgb.b;
    if (lightGrade) {
        const ambient = lightGrade.ambientTint || [1, 1, 1];
        const gain = lightGrade.gain || [1, 1, 1];
        r *= ambient[0] * gain[0];
        g *= ambient[1] * gain[1];
        b *= ambient[2] * gain[2];
        const saturation = Math.max(0, Math.min(1, Number(lightGrade.saturation ?? 1)));
        const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        r = luma + (r - luma) * saturation;
        g = luma + (g - luma) * saturation;
        b = luma + (b - luma) * saturation;
    } else {
        const dim = 1 - Math.max(0, Math.min(0.9, Number(grade?.overlayAlpha) || 0));
        r *= dim;
        g *= dim;
        b *= dim;
    }
    const channel = value => Math.max(0, Math.min(255, Math.round(value)));
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
}

function drawAirParticles(renderer, ctx, atmosphere) {
    const particles = renderer.particleSystem;
    if (!particles?.particles?.length) return;
    const lightGrade = atmosphere?.lightGrade || null;
    const grade = atmosphere?.grade || null;
    const key = lightGrade?.cacheKey ?? `${grade?.worldTint || ''}|${grade?.overlayAlpha ?? 0}`;
    const shade = renderer._airParticleShade || (renderer._airParticleShade = { key: null, cache: new Map(), litColor: null });
    if (shade.key !== key) {
        shade.key = key;
        shade.cache.clear();
        shade.litColor = (hex) => {
            let color = shade.cache.get(hex);
            if (color === undefined) {
                color = airParticleShade(hex, lightGrade, grade);
                // Forge smoke blends its palette with heat; bound the memo.
                if (shade.cache.size >= 256) shade.cache.clear();
                shade.cache.set(hex, color);
            }
            return color;
        };
    }
    particles.draw(ctx, { layer: PARTICLE_LAYER_AIR, litColor: shade.litColor });
}

function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return null;
    const n = Number.parseInt(value, 16);
    if (!Number.isFinite(n)) return null;
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// #21 — screen-space cinematic grade for an active director glide. A radial
// vignette pulls focus to the framed subject and a faint worldTint wash colours
// the moment (red for incidents, gold for a parade, teal for an arrival). Both
// scale with the glide's bell-curve weight so they never linger after the move.
//
// 5.8 — the vignette gradient is cached per (viewport, quantized-strength)
// bucket instead of allocated every frame of the glide; strength is quantized
// to 0.05 steps so the bell-curve ramp reuses a handful of buckets.
const _glideVignetteCache = new Map();
const GLIDE_VIGNETTE_CACHE_LIMIT = 24;

function glideVignetteGradient(ctx, w, h, vignette) {
    const quantized = Math.round(vignette * 20) / 20;
    const key = `${w}x${h}:${quantized}`;
    const cached = _glideVignetteCache.get(key);
    if (cached) return cached;
    const cx = w / 2;
    const cy = h / 2;
    const inner = Math.min(w, h) * 0.32;
    const outer = Math.hypot(w, h) / 2;
    const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${quantized})`);
    if (_glideVignetteCache.size >= GLIDE_VIGNETTE_CACHE_LIMIT) _glideVignetteCache.clear();
    _glideVignetteCache.set(key, gradient);
    return gradient;
}

function drawDirectorGlideGrade(ctx, grade, viewport) {
    if (!grade || !(grade.weight > 0.01) || !viewport?.width || !viewport?.height) return;
    const w = viewport.width;
    const h = viewport.height;
    const weight = Math.max(0, Math.min(1, grade.weight));
    const tint = hexToRgb(grade.worldTint);

    ctx.save();
    if (tint) {
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.5 * weight;
        ctx.fillStyle = `rgb(${tint.r}, ${tint.g}, ${tint.b})`;
        ctx.fillRect(0, 0, w, h);
    }
    const vignette = Math.max(0, Math.min(1, Number(grade.vignette) || 0)) * weight;
    if (vignette > 0.01) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = glideVignetteGradient(ctx, w, h, vignette);
        ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
}

// 5.7 — cinematic letterbox bars while a release/incident camera cue glide
// owns the frame. Bar height rides the glide's bell-curve weight so the bars
// slide in and out with the move; a 1px ember line on the inner edge (tinted
// by the cue grade) keeps them reading as cinema chrome, not a render
// artifact. Reduced motion: cue glides are suppressed and Camera cuts instead,
// so no bars ever appear.
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
    const tint = hexToRgb(state?.grade?.worldTint) || { r: 214, g: 169, b: 81 };
    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${0.5 * weight})`;
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

function captionSource(renderer, villageSnapshot) {
    const ambient = renderer?.cameraDirector?.getAmbientCaption?.();
    const ambientText = String(ambient?.text || '').trim();
    if (ambientText && ambient.kind === 'chapter') return { style: CAPTION_STYLES.incident, text: ambientText };
    const parade = villageSnapshot?.releaseParade;
    const paradeText = String(parade?.label || '').trim();
    if (paradeText && parade.kind === 'parade') return { style: CAPTION_STYLES.release, text: paradeText };
    if (ambientText) return { style: CAPTION_STYLES.ambient, text: ambientText };
    // A biography milestone is a neutral stone line, never a parade, and a
    // sub-agent's session ending is not celebrated at all: its return is the
    // neutral RETURNED line (child → parent), with no success wording.
    if (paradeText && parade.kind === 'return-banner') return { style: CAPTION_STYLES.returned, text: paradeText };
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

function combineWeatherInfluence(a, b) {
    if (!a && !b) return null;
    return {
        storminess: Math.max(
            Number(a?.storminess) || 0,
            Number(b?.storminess) || 0,
        ),
        clearing: Math.max(
            Number(a?.clearing) || 0,
            Number(b?.clearing) || 0,
        ),
    };
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
// 6.4 — ground haze over water and lowlands. The coherent field is a
// quarter-resolution occupancy mask keyed by camera pose / viewport /
// atmosphere bucket and rebuilt only when that key changes. The existing
// ten wisps remain the visible crest of that field, not the whole effect.
const FOG_SPOT_LIMIT = 10;
const FOG_WATER_ANCHOR_LIMIT = 6;
const FOG_DRIFT_PERIOD_MS = 52000;
const FOG_DRIFT_PX = 14;
const FOG_WISP_SPRITE_ID = 'atmosphere.fog.wisp.low';
const HAZE_FIELD_RGB = Object.freeze([214, 228, 236]);
let _fogStamp = null;

function fogStampCanvas() {
    if (_fogStamp) return _fogStamp;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 48;
    const stampCtx = canvas.getContext('2d');
    const gradient = stampCtx.createRadialGradient(48, 24, 0, 48, 24, 48);
    gradient.addColorStop(0, 'rgba(214, 228, 236, 0.55)');
    gradient.addColorStop(0.6, 'rgba(214, 228, 236, 0.22)');
    gradient.addColorStop(1, 'rgba(214, 228, 236, 0)');
    stampCtx.fillStyle = gradient;
    stampCtx.save();
    stampCtx.translate(48, 24);
    stampCtx.scale(1, 0.5);
    stampCtx.translate(-48, -48);
    stampCtx.fillRect(0, -24, 96, 96);
    stampCtx.restore();
    _fogStamp = canvas;
    return canvas;
}

function groundFogSpots(renderer) {
    if (renderer._groundFogSpots) return renderer._groundFogSpots;
    const { anchors } = collectHazeAnchors({
        waterTiles: renderer.waterTiles,
        waterMeta: renderer.waterMeta,
        lowlandPoints: lowlandPointsFromDiamond(renderer._worldDiamondPoints?.()),
        waterLimit: FOG_WATER_ANCHOR_LIMIT,
    });
    renderer._groundFogSpots = anchors.slice(0, FOG_SPOT_LIMIT).map((anchor) => ({
        x: anchor.x,
        y: anchor.y,
        seed: anchor.seed || 0,
    }));
    return renderer._groundFogSpots;
}

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

function hazeAtmosphereBucket(atmosphere) {
    if (atmosphere?.cacheKey) return atmosphere.cacheKey;
    const fog = Math.round((Number(atmosphere?.weather?.fog) || 0) * 10);
    const precip = Math.round((Number(atmosphere?.weather?.precipitation) || 0) * 10);
    return `${atmosphere?.phase || 'day'}|f${fog}|p${precip}`;
}

function focusedHazeSubject(renderer) {
    const selected = renderer.selectedAgent;
    const sprite = selected?.id ? renderer.agentSprites?.get?.(selected.id) : null;
    if (sprite && Number.isFinite(sprite.x) && Number.isFinite(sprite.y)) {
        return { id: selected.id, x: sprite.x, y: sprite.y };
    }
    return null;
}

function groundFogStrength(renderer, atmosphere) {
    let strength = 0;
    if (atmosphere?.phase === 'dawn') {
        const progress = Math.max(0, Math.min(1, Number(atmosphere.phaseProgress) || 0));
        // Fade in and back out across the dawn phase rather than popping.
        strength = Math.sin(progress * Math.PI);
    }
    const weatherFog = Number(renderer._waterWeather?.fog) || 0;
    const precipitation = Number(renderer._waterWeather?.rain) || 0;
    return Math.max(strength, weatherFog * 0.7, precipitation * 0.45);
}

function paintHazeMaskCanvas(field) {
    if (typeof document === 'undefined') return null;
    const width = field.width;
    const height = field.height;
    let canvas = field.canvas;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const samples = field.samples;
    const r = HAZE_FIELD_RGB[0];
    const g = HAZE_FIELD_RGB[1];
    const b = HAZE_FIELD_RGB[2];
    for (let i = 0; i < samples.length; i++) {
        const offset = i * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = samples[i];
    }
    ctx.putImageData(imageData, 0, 0);
    field.canvas = canvas;
    return canvas;
}

function ensureHazeField(renderer, atmosphere, plan) {
    const viewport = renderer._screenViewport?.() || { width: 0, height: 0 };
    if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
    const focused = focusedHazeSubject(renderer);
    const key = hazeFieldCacheKey({
        camera: renderer.camera,
        viewport,
        atmosphereBucket: hazeAtmosphereBucket(atmosphere),
        pressureLevel: plan.pressureLevel || 0,
        focusedId: focused?.id || '',
        fieldScale: plan.fieldScale,
    });
    const cached = renderer._hazeField;
    if (!shouldRebuildHazeField(cached?.key, key, {
        motionScale: renderer.motionScale ?? 1,
        hasField: Boolean(cached?.canvas || cached?.samples),
    })) {
        return cached;
    }
    const { anchors } = collectHazeAnchors({
        waterTiles: renderer.waterTiles,
        waterMeta: renderer.waterMeta,
        lowlandPoints: lowlandPointsFromDiamond(renderer._worldDiamondPoints?.()),
        waterLimit: FOG_WATER_ANCHOR_LIMIT,
    });
    if (!anchors.length) {
        renderer._hazeField = { key, width: 0, height: 0, samples: new Uint8Array(0), canvas: null };
        return renderer._hazeField;
    }
    const field = projectHazeField({
        anchors,
        roads: hazeRoadPoints(renderer),
        focused,
        camera: renderer.camera,
        viewport,
        scale: plan.fieldScale,
        strength: 1,
        densityScale: 1,
    });
    field.key = key;
    if (paintHazeMaskCanvas(field)) field.samples = null;
    renderer._hazeField = field;
    return field;
}

function clipProjectedDiamond(renderer, ctx) {
    const points = renderer._worldDiamondPoints?.();
    const camera = renderer.camera;
    if (!Array.isArray(points) || points.length < 4 || !camera?.worldToScreen) return false;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
        const screen = camera.worldToScreen(points[i].x, points[i].y);
        if (i === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
    }
    ctx.closePath();
    ctx.clip();
    return true;
}

function drawHazeField(renderer, ctx, field, strength) {
    if (!field?.canvas || !(field.width > 0) || strength <= 0.01) return;
    const viewport = renderer._screenViewport?.();
    if (!viewport?.width || !viewport?.height) return;
    ctx.save();
    renderer._resetScreenTransform?.(ctx);
    clipProjectedDiamond(renderer, ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(HAZE_ALPHA_CAP, HAZE_ALPHA_CAP * strength);
    ctx.drawImage(field.canvas, 0, 0, viewport.width, viewport.height);
    ctx.restore();
}

function drawGroundFog(renderer, ctx, atmosphere, perfNow) {
    const strength = groundFogStrength(renderer, atmosphere);
    const pressure = sampleFramePressure();
    const plan = hazePlanForPressure(pressure.level, renderer.motionScale ?? 1);
    const fieldStrength = strength * plan.density;
    if (fieldStrength <= 0.02) return;
    const field = ensureHazeField(renderer, atmosphere, plan);
    if (field) drawHazeField(renderer, ctx, field, fieldStrength);

    if (plan.detail <= 0) return;
    const spots = groundFogSpots(renderer);
    if (!spots.length) return;
    const drifting = (renderer.motionScale ?? 1) > 0;
    const driftPhase = drifting ? (perfNow / FOG_DRIFT_PERIOD_MS) * Math.PI * 2 : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < spots.length; i++) {
        const spot = spots[i];
        const dx = Math.sin(driftPhase + spot.seed * Math.PI * 2 + i) * FOG_DRIFT_PX;
        const alpha = Math.min(0.26, (0.15 + spot.seed * 0.08) * strength);
        const drew = renderer._drawAtmosphereEffectSprite?.(ctx, FOG_WISP_SPRITE_ID, {
            x: spot.x + dx,
            y: spot.y,
            alpha,
            scaleX: 1.7 + spot.seed * 0.9,
            scaleY: 0.55 + spot.seed * 0.25,
            rotation: -0.1 + spot.seed * 0.2,
            flipX: spot.seed > 0.5,
        });
        if (drew) continue;
        const stamp = fogStampCanvas();
        ctx.globalAlpha = alpha;
        ctx.drawImage(stamp, Math.round(spot.x + dx - 80), Math.round(spot.y - 26), 160, 64);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// 1.4 — world-locked dithered cloud-shadow courses from the same baked field
// as the resident composite (IsometricRenderer → CloudShadowCourses).
function drawCloudShadows(renderer, ctx, atmosphere, perfNow) {
    renderer._drawCloudShadowCourses?.(ctx, atmosphere, perfNow);
}

function drawBuildingLightReflections(renderer, ctx, atmosphere) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    const lights = renderer._frameLightSources?.building || [];
    const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
    const alphaBase = 0.10 * glowScale;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const light of lights) {
        if (light.kind === 'beam') {
            renderer._drawLighthouseBeam(ctx, light, atmosphere);
            continue;
        }
        const overlayId = light.overlay || 'atmosphere.light.lantern-glow';
        const overlayImg = renderer.assets.get(overlayId);
        if (!overlayImg) continue;
        const dims = renderer.assets.getDims(overlayId);
        if (!dims) continue;
        const alpha = alphaBase * (light.intensity || 1) * (light.buildingType === 'watchtower' ? 1.55 : 1);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
            overlayImg,
            Math.round(light.x - dims.w / 2),
            Math.round(light.y - dims.h / 2)
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
