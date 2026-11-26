import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { INCIDENT_COLORS_RGB, THEME, WORLD_BODY_FONT_11 } from '../../config/theme.js';
import { drawPixelFlame, fillPixelEllipse, fillTileDiamond } from './PixelShapes.js';
import { normalizeBuildingType } from '../../config/buildings.js';
import { inVillageMasonry, PORTAL_SPAWN_TILE, TOWN_ROAD_ROUTES, VILLAGE_GATE, VILLAGE_GATE_BOUNDS, VILLAGE_GATE_GEOMETRY, VILLAGE_WALL_ROUTES, YARD_MATERIALS } from '../../config/townPlan.js';
import {
    AMBIENT_GROUND_PROPS,
    AMBIENT_SCENIC_POINTS,
    DISTRICT_PROPS,
    SCENIC_POINT_PROPS,
    WATCHTOWER_BEACON_BUOY_TILES,
} from '../../config/scenery.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { patinaFor } from '../../application/AgentBiographyService.js';
import { repoProfile } from '../shared/RepoColor.js';
import { Camera } from './Camera.js';
import { createMotionClock, advanceMotionClock, virtualFramesFor, SPEED_RUNGS } from './MotionClock.js';
import { AMBIENT_FRAME_PACING, admitFrame, ambientFrame, createFramePacing, resetFramePacing } from './FramePacing.js';
import { takeLiveMoment } from './EffectStamps.js';
import {
    createFrameEnvelope,
    recordFrameEnvelope,
    enableFrameEnvelopeRings,
    snapshotFrameEnvelope,
    getClientPerfMetrics,
    percentileAtSnapshot,
} from '../shared/ClientPerfMetrics.js';
import { getReservedRects } from '../shared/ReservedRects.js';
import { HARBOR_FOCUS_FLEET_EVENT } from '../shared/HarborLedger.js';
import { HarborFleetCard, isInFleetCard } from '../shared/HarborFleetCard.js';
import { WorldHoverPlate, villagerHoverLine } from '../shared/WorldHoverPlate.js';
import { dialogueSourceLabel } from '../../config/dialogue.js';
import { emitAgentSelected } from '../shared/AgentSelection.js';
import { shortcutBlocked } from '../shared/ShortcutGuard.js';
import { readSignageMode, SIGNAGE_EVENT, HDR_HIGHLIGHTS_EVENT, overlayContextAttributes, publishDisplayStatus, readHdrHighlights } from '../shared/DisplaySettings.js';
import { installP3OverlayInks, readDisplayMedia, setOverlayInksP3, watchDisplayMedia } from './DisplayColor.js';
import { CameraDirector } from './CameraDirector.js';
import { ParticleSystem } from './ParticleSystem.js';
import { AgentSprite, drawFamiliarMotes, familiarMoteLightSources, MUTUAL_CHAT_MAX_MS, ONE_SIDED_CHAT_GRACE_MS } from './AgentSprite.js';
import { BuildingSprite, SOURCE_HALO_RADIUS_CAP, lampsLitAt } from './BuildingSprite.js';
import { VillageCalendar } from './VillageCalendar.js';
import { IsleLandmarks } from './IsleLandmarks.js';
import { buildReedSprites } from './ReedBeds.js';
import { BehaviorTelemetry } from './BehaviorTelemetry.js';

import { SceneryEngine } from './SceneryEngine.js';
import { Pathfinder } from './Pathfinder.js';
import { createWalkClearance } from './WalkClearance.js';
import { bridgeCrossingTiles, constrainSteeringInto, constrainSteeringToTarget, laneAxisForBridgeOrientation } from './MovementSteering.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { DIRECTIONS, dirFromVelocity } from './SpriteSheet.js';
import { SkyRenderer } from './SkyRenderer.js';
import { AtmosphereState, sourceEnergyFor } from './AtmosphereState.js';
import { WeatherRenderer } from './WeatherRenderer.js';
import { WildlifeRenderer } from './WildlifeRenderer.js';
import { FoliageRenderer } from './FoliageRenderer.js';
import { PropWinter, WINTER_PROPS } from './PropWinter.js';
import { WALL_BRAZIER, WALL_IVY_SPRITE, WALL_SPEC, WALL_STAIR, drawWallLantern, lanternLit, paintWallRun, wallLanternLight, wallRunLayout } from './VillageWall.js';
import { SeasonalAmbience, phenologyForAtmosphere, seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { ambientEventsForHost, ambientDebugSnapshot } from './AmbientEvents.js';
import { ChimneySmoke } from './ChimneySmoke.js';
import { setPennantWeather } from './PixelPennant.js';
import { openGroundTiles } from './AmbientGround.js';
import { GROUND_CLASS, TERRAIN_HAZE_COURSES, groundWeatherWanted, installGroundBake } from './GroundBake.js';
import { drawSunLift, releaseFrameShade } from './RakingLight.js';
import { releaseShadeField, shadeFieldBufferBytes } from './ShadeField.js';
import { OCEAN_HORIZON_WORLD_Y, coastDistanceProbe, drawCanvasWaterMood, drawOuterOcean, registerCoastBake, riverCurrentAt } from './CoastBake.js';
import { frostQuarterOf, frostRisingOf, snowBucketOf } from './GroundState.js';
import {
    TerrainArtifactStore, terrainArtifactConfiguration, terrainArtifactInputsSettled, terrainArtifactKey, terrainContentHash,
    captureTerrainArtifactFields, captureTerrainArtifact, restoreTerrainArtifact, terrainArtifactManifest,
} from './TerrainArtifactStore.js';
import { drawCanvasWaterState } from './CanvasWaterState.js';
import { REVEAL_SAMPLE_H, REVEAL_SAMPLE_W, sampleRevealBands, sampleRevealBandsAsync } from './RevealBands.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';
import { BridgeLanterns } from './BridgeLanterns.js';
import { LandmarkActivity } from './LandmarkActivity.js';
import { AgentEventStream } from './AgentEventStream.js';
import { bindSquadNotice, notifySquadWatchers } from './SquadNotice.js';
import { VERIFIED_OUTCOME_EVENT } from '../../domain/services/VerifiedOutcome.js';
import { RelationshipState } from './RelationshipState.js';
import { RitualConductor } from './RitualConductor.js';
import { VisitIntentManager } from './VisitIntentManager.js';
import VisitTileAllocator, { FIXTURE_FEET, standsOnFixture } from './VisitTileAllocator.js';
import {
    ORCA_AGENT_RADIUS,
    ORCA_SWING_RADIUS,
    ORCA_TAU,
    ORCA_TAU_OBST,
    ORCA_Y_SCALE,
    computePreferredVelocity,
    isAgentPlanted,
    solveOrcaVelocity,
    stepCrowdOrca, sharesAvoidancePlane,
} from './CrowdOrca.js';
import {
    LABEL_MAX_SPEAKERS,
    OVERLAY_GRID_CELL,
    OVERLAY_LAYER_ATTENTION,
    OVERLAY_LAYER_PLAQUE,
    OVERLAY_LAYER_THOUGHT,
    OverlayOccupancyGrid,
    reserveAttentionPlates,
    solveLabelAuction,
} from './SlotAuction.js';
import { scenicScoreBias } from './DayRoutine.js';
import { getPulsePriority } from './PulsePolicy.js';
import { annotationModeForPressure, calculateScenePressure, getActiveMarkGovernor, MarkGovernor, setActiveMarkGovernor } from './MarkGovernor.js';
import { CouncilRibbon } from './CouncilRibbon.js';
import { getBuildingApertureProfile } from './BuildingVisualRegistry.js';
import { InspectionGlass, GLASS_EVENT, readGlassSetting } from './InspectionGlass.js';
import { postcardFrame, strikePostcard } from './Postcard.js';
import { fireBreath, fireBreathDepth, fixturePoolReach, groundCourseHeight, HEARTH_FIXTURES, HEARTH_TONE, hearthLightSources, lightSourceCacheKey, normalizeLightSource } from './LightSourceRegistry.js';
import { lampRoundFor } from './LamplighterRound.js';
import { applyTeamPlazaPreferences, getCouncilRingDiagnostics, releaseCouncilRingState } from './CouncilRing.js';
import { ArrivalDepartureController } from './ArrivalDeparture.js';
import { agentPathAlias, extractRecipientName } from '../../domain/services/RecipientResolver.js';
import { isAgentMessageTool } from '../../domain/services/ToolIdentity.js';
import { bucketCounts, buckets as signalBuckets } from '../../domain/services/SignalLedger.js';
import { BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { ChronicleMonuments } from './ChronicleMonuments.js';
import { TrailRenderer } from './TrailRenderer.js';
import { Chronicler } from './Chronicler.js';
import { VillageDirector } from './VillageDirector.js';
import { VILLAGE_SURFACES, supportHeight, tileCoords, planeHeight } from './SurfaceProjection.js';
import { tileToWorld, worldToTile, buildingCenterToWorld, tileToWorldElevated, pickSurfaceAtWorld } from './Projection.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';
import { attentionKeyAt, attentionScreenRects, isAttentionStatus, layoutAttentionPlates, reserveAttentionLayoutInGrid } from './AttentionPlates.js';
import { IDENTITY_LABEL, identityLabelTop, identityLabelWidth } from './WorldLabelKit.js';
import {
    THOUGHT_CANDIDATE_COUNT,
    THOUGHT_CANDIDATE_LATERAL,
    THOUGHT_CANDIDATE_SLOT,
    THOUGHT_HISTORY_LIMIT,
    THOUGHT_LEADER_TIP,
    THOUGHT_STACK_STEP,
    createThoughtCandidatePool,
    createThoughtColumn,
    layoutThoughtColumn,
    resetThoughtCandidateSlots,
    speakerTagFor,
    speakerTagsFor,
    thoughtCandidateCost,
    thoughtLateralShift,
    thoughtLeader,
} from './ThoughtColumn.js';
import { StaticPropSprite, buildStaticPropDrawables, lineOcclusionColumns } from './StaticPropDrawables.js';
import { buildRestSeatPropSprites, setRestSeatVisualBeat } from './RestSeats.js';
import { buildTavernArcadeSprites } from './TavernArcade.js';
import { buildCentralBridgeParapetSprite } from './BridgeParapet.js';
import { createDepthDrawable, propPartSortY } from './DrawablePass.js';
import {
    renderWorldFrame,
    groundStateForAtmosphere,
    collectDampMarks,
    isoFromTileKey,
    isoFromTile,
} from './WorldFrameRenderer.js';
import { createPostFx } from './postfx/PostFx.js';
import { createPostFxFeed } from './postfx/PostFxFeed.js';
import { createGpuWorldRenderer, probeWebgl2Raster, snapshotWebglFence } from './gpu/GpuWorldRenderer.js';
import { lookStrength } from './LookStrengths.js';
import {
    LANTERN_COLOR, LANTERN_HEIGHT, LANTERN_ID_PREFIX, lanternCandidate, lanternIntensity, lanternPoolRadius, selectLanternCarriers,
} from './CarriedLantern.js';
import {
    ARTIFACT_MIN_ZOOM,
    CAIRN_DOOR_ZONE_CAP,
    CAIRN_VIEW_CAP,
    admitReportCairn,
    assignWorkflowRibbons,
    resolveCarriedArtifact,
    selectCarriedArtifacts,
} from './CarriedArtifact.js';
import {
    GPU_ATTENTION_LIGHT_PRIORITY,
    effectBudgetMode,
    forcedGpuWorldRendererMode,
    isChromiumBrowser,
    localLightPhaseForLighting,
    resolveGpuWorldRendererMode,
    shouldProbeWebGpu,
    webGpuOutcomeSkipsProbe,
} from './gpu/GpuWorldPolicy.js';
import { NEUTRAL_GRADE } from './GradeEvaluator.js';
import { poolReceiverMask } from './CanvasPoolMask.js';
import {
    buildPoolDodgeStamp,
    canvasGradeMultiply,
    drawCanvasGradeGain,
    drawCanvasGradeGamma,
    drawCanvasGradeLift,
    drawCanvasGradeSaturation,
    gradedPoolReceiver,
} from './CanvasGrade.js';
import { createLoneCloudPose, drawCloudShadowCourses, loneCloudPose } from './CloudShadowCourses.js';
import {
    CANVAS_BUDGET,
    canvasMapPixelCount,
    canvasPixelCount,
    gpuResourceAccounting,
    releaseCanvasBackingStore,
    releaseCanvasMap,
    unifiedRendererResourceAccounting,
} from './CanvasBudget.js';

// Keep the field through a quick return so midday shade is already in the first frame.
const SHADE_SUSPEND_GRACE_MS = 2000;
// #8 — cadence of harbor reconciliation while the World loop is stopped.
const HARBOR_SEMANTICS_IDLE_MS = 1000;
// XP-4 — the hover plate re-reads a still pointer's target at this cadence,
// and keeps this many CSS px clear round a point hit with no drawn bounds.
const HOVER_PLATE_RESAMPLE_MS = 100;
const HOVER_PLATE_POINTER_PAD = 24;
const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
const LIGHT_FADE_COLOR_CACHE_LIMIT = 1024;
const LIGHT_COLOR_RGB_CACHE_LIMIT = 256;
const LIGHT_COLOR_QUANTIZATION_STEPS = 32;
const LIGHT_COLOR_MIX_STEPS = 16;
const NICKNAME_CACHE_LIMIT = 256;
const WORLD_FRAME_ERROR_REPORT_INTERVAL_MS = 5000;
const WORLD_FRAME_MAX_CONSECUTIVE_FAILURES = 3;
const WORLD_FRAME_RETRY_INITIAL_MS = 1000;
const WORLD_FRAME_RETRY_MAX_MS = 8000;
const WORLD_FALLBACK_PREP_TIMEOUT_MS = 5000;
// A terrain bake whose sprite layers did not land is shown but never stored,
// and the terrain rebakes after this delay (`_terrainSpritesLanded`).
const TERRAIN_BAKE_RETRY_MS = 30000;
const DEBUG_GLOBAL_OWNERS = new WeakMap();

function isAgentDeparted(agent) {
    return agent?.isDeparted === true
        || (agent?.departedAt != null && Number.isFinite(Number(agent.departedAt)));
}

function nearestBuildingDoorKey(buildings, footX, footY) {
    if (!buildings) return null;
    const list = typeof buildings.values === 'function' ? buildings.values() : buildings;
    let bestKey = null;
    let bestDistSq = Infinity;
    for (const building of list) {
        if (!building) continue;
        const point = building.entrance
            ? tileToWorld(building.entrance.tileX, building.entrance.tileY)
            : buildingCenterToWorld(building);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const dx = footX - point.x;
        const dy = footY - point.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestKey = String(building.type || building.id || `${point.x},${point.y}`);
        }
    }
    return bestKey;
}

function rebuildBenchPatina(renderer) {
    const claims = renderer._benchClaimsByIdentity ||= new Map();
    const bySeat = renderer._benchPatinaBySeat ||= new Map();
    const bestBySeat = new Map();
    for (const [identityKey, bench] of claims) {
        const seatId = bench?.seatId;
        if (!seatId) continue;
        const tier = bench.rune ? 2 : bench.hollow ? 1 : 0;
        const sits = Number(bench.sits) || 0;
        const prev = bestBySeat.get(seatId);
        if (
            !prev
            || tier > prev.tier
            || (tier === prev.tier && sits > prev.sits)
            || (tier === prev.tier && sits === prev.sits && identityKey < prev.identityKey)
        ) {
            bestBySeat.set(seatId, { identityKey, bench, tier, sits });
        }
    }
    const seats = new Set([
        ...bySeat.keys(),
        ...bestBySeat.keys(),
    ]);
    let anyChanged = false;
    for (const seatId of seats) {
        const prev = bySeat.get(seatId) || null;
        const next = bestBySeat.get(seatId)?.bench || null;
        if (next) bySeat.set(seatId, next);
        else bySeat.delete(seatId);
        const changed = Boolean(prev?.hollow) !== Boolean(next?.hollow)
            || Boolean(prev?.rune) !== Boolean(next?.rune)
            || ((Boolean(prev?.rune) || Boolean(next?.rune))
                && (prev?.repoColorIndex ?? 0) !== (next?.repoColorIndex ?? 0));
        if (changed) {
            anyChanged = true;
            renderer._restSeatBackProps?.get(seatId)?.invalidateCache?.();
        }
    }
    if (anyChanged) renderer._invalidateIdleFrame?.();
}

// The opaque texel nearest a sprite's centre and its colour, once per image:
// the probe `_terrainSpritesLanded` reads back from the terrain bake.
const CENTRE_TEXELS = new WeakMap();
function opaqueCentreTexel(img) {
    if (CENTRE_TEXELS.has(img)) return CENTRE_TEXELS.get(img);
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    let texel = null;
    if (w && h && typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let best = Infinity;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const d = (x - w / 2) ** 2 + (y - h / 2) ** 2;
                if (data[o + 3] !== 255 || d >= best) continue;
                best = d;
                texel = { x, y, rgb: [data[o], data[o + 1], data[o + 2]] };
            }
        }
        releaseCanvasBackingStore(canvas);
    }
    CENTRE_TEXELS.set(img, texel);
    return texel;
}

// Stage B (webgpu contract §8.1) — the default WebGPU world (module, hardware
// adapter, device, every pipeline) resolves from the moment App has loaded
// this module (`IsometricRenderer.prewarmBackend`, beside the asset fetch),
// so on a warm shader cache it is ready by the mount. One still compiling at
// the mount (a cold cache: the first boot after a WGSL, browser or driver
// change) never delays the first frame: the World mounts WebGL2 and switches
// to WebGPU once it is ready and the reveal is done (`_queueWebGpuSwitch`).
// `?renderer=webgpu` waits for it instead.
let earlyWebGpu = null;

// FP-9 — the last WebGPU resolution's outcome on this browser build
// (`webGpuOutcomeSkipsProbe`): a found adapter clears it.
const WEBGPU_OUTCOME_KEY = 'cv-webgpu-outcome';
function knownNoWebGpuAdapter() {
    try {
        const record = JSON.parse(globalThis.localStorage?.getItem(WEBGPU_OUTCOME_KEY) || 'null');
        return webGpuOutcomeSkipsProbe(record, { userAgent: globalThis.navigator?.userAgent });
    } catch (_) {
        return false;
    }
}
function storeWebGpuOutcome(value) {
    try {
        if (value?.available) globalThis.localStorage?.removeItem(WEBGPU_OUTCOME_KEY);
        else if (value?.reason === 'no-adapter') {
            globalThis.localStorage?.setItem(WEBGPU_OUTCOME_KEY, JSON.stringify({ webgpu: 'no-adapter', ua: String(globalThis.navigator?.userAgent || ''), at: Date.now() }));
        }
    } catch (_) { /* storage unavailable */ }
}

function wantsWebGpu(params) {
    const softwareRaster = !forcedGpuWorldRendererMode(params) && probeWebgl2Raster().softwareRaster;
    return shouldProbeWebGpu(params, {
        chromium: isChromiumBrowser(globalThis.navigator),
        gpu: Boolean(globalThis.navigator?.gpu),
        softwareRaster,
        knownNoAdapter: knownNoWebGpuAdapter(),
    });
}

function resolveWebGpuWorld() {
    const entry = { settled: false, value: null, promise: null };
    entry.promise = import('./gpu/GpuWorldRendererWebGPU.js')
        .then(async module => ({ ...(await module.prepareGpuWorldWebGPU()), create: module.createGpuWorldRendererWebGPU }))
        .catch(error => ({ available: false, reason: String(error?.message || error) }))
        .then((value) => {
            entry.settled = true;
            entry.value = value;
            storeWebGpuOutcome(value);
            return value;
        });
    return entry;
}

function releaseWebGpuWorld(entry) {
    entry?.promise.then(value => value?.device?.destroy?.());
}

// Work kept off the frame (a WebGPU failure's WebGL2 build and terrain
// re-bake): an idle task, or the next task where idle callbacks are missing.
// EY-5 — the renderer fields the terrain bake passes write (GroundBake's
// ground field and puddle mask, CoastBake's field, bake and its water fields):
// a restage keeps them private until its canvas publishes.
const TERRAIN_STAGED_FIELDS = Object.freeze(['groundField', 'groundPuddleMask', 'groundBakeMs', 'groundWinterBakeMs',
    '_coastField', 'coastField', '_coastBake', '_coastMoodLayer', '_mirrorAccentLayers']);

function whenIdle(callback) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => callback(), { timeout: 100 });
    else setTimeout(callback, 0);
}

const MAX_LIGHT_GRADIENT_CACHE_PIXELS = CANVAS_BUDGET.maxLightCachePixels;
const MAX_LIGHT_GRADIENT_STAMP_PIXELS = Math.floor(MAX_LIGHT_GRADIENT_CACHE_PIXELS / 5);
// 3.2 — Canvas/hybrid wet source reflections. FULL resident reflects eight
// sources; the Canvas fallback keeps a hard cap of four cached stamps and
// reaches at most two tiles down-slope from the source.
const CANVAS_WET_REFLECTION_CAP = 4;
const WET_REFLECTION_TILE_REACH = 2;
const clampUnit = value => Math.max(0, Math.min(1, Number(value) || 0));
// Viewport-size gates for the cheap sky/atmosphere/prop paths. CSS pixels, not
// backing pixels: a sharper display is not a bigger scene.
const FAST_ATMOSPHERE_CSS_PIXELS = 800_000;
const FAST_PROP_CSS_PIXELS = 800_000;
const FAST_PROP_MIN_ZOOM = 1.5;
const FAST_PROP_SCREEN_MARGIN = 96;
// Covers the tallest selected bubble stack plus the sprite body. Agents beyond
// this screen-space apron cannot contribute pixels to the viewport.
const AGENT_SCREEN_CULL_MARGIN = 420;
const AGENT_OVERLAY_GRID_CELL = 96;
// S1 — an action-needed light is a warm ground course under the body, on the
// same stepped pool courses as every lamp and capped per pixel (max, not
// sum): a crowd of waiting agents never blooms white over the bodies. The T1
// beacon and plate carry the salience; radius is world px (2:1 on the ground).
const ATTENTION_LIGHT_STYLES = Object.freeze({
    needsYou: Object.freeze({ color: THEME.waitingOnUser, radius: 40, intensity: 0.6 }),
    errors: Object.freeze({ color: THEME.error, radius: 38, intensity: 0.6 }),
    quota: Object.freeze({ color: `rgb(${INCIDENT_COLORS_RGB.quota})`, radius: 34, intensity: 0.45 }),
});
// V5 / 2.5 — the attention light stands on its owner's foot, this many world
// px up: its courses fill the owner's ground and hem, never a neighbour.
const ATTENTION_LIGHT_HEIGHT = 4;
const TERRAIN_CACHE_MARGIN = 360;
const TERRAIN_CACHE_CHUNK_SIZE = 16;
const TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS = CANVAS_BUDGET.maxWorldCachePixels;
const WORLD_EDGE_PAD_X = TILE_WIDTH / 2;
const WORLD_EDGE_PAD_Y = TILE_HEIGHT / 2;
const KEYBOARD_PAN_STEP = 90;
// A bridge profile ([along, px] pairs, scenery.js BRIDGE_HINTS `deckProfile`
// and `nearRail.lift`) at `along` tiles from the span's centre: linear between
// points, 0 outside them.
function bridgeProfileAt(points, along) {
    if (!(along > points[0][0] && along < points[points.length - 1][0])) return 0;
    let i = 1;
    while (points[i][0] < along) i++;
    const [a0, l0] = points[i - 1];
    const [a1, l1] = points[i];
    return l0 + (l1 - l0) * (along - a0) / (a1 - a0);
}
const LANE_STEERING = Object.freeze({
    correctionPx: 0.55,
    denseCorrectionPx: 0.42,
    arrivalDistancePx: 18,
    minimumCorrectionPx: 0.18,
    avenueOffsetPx: 4.4,
    dirtOffsetPx: 3.4,
    plazaOffsetPx: 2.2,
    // A landmark deck (not planks or docks) is walkable on its centre column
    // only; its hint's `laneOffsetPx` (scenery.js BRIDGE_HINTS) sets the two
    // files from the measured clear deck (the central bridge: 6 px, both
    // files on the planks between the rails). This is the fallback for a
    // hint without one.
    bridgeOffsetPx: 10,
});
const PAIR_BUCKET_DEFAULT_PX = 40;
// W5-C — final slot-entry fan (`_fanArrivals`, trimmed to 10 px approach).
// Walkers use 2D ORCA (`CrowdOrca.js`) for continuous avoidance; only the last
// 10 px of slot entry fans around an already-occupied standing slot.
const PERFORMING_FAN = Object.freeze({
    radiusXPx: 16,
    radiusYPx: 8,
    overlapXPx: 14,
    overlapYPx: 8,
    stackPx: 3,
    minApproachPx: 1,
    approachPx: 10,
});
// Ring places after the anchor in units of the radii: beside it (east and
// west, the stable hash mirroring the set), in front, behind, then the four
// corners. Every place clears the anchor's body box and its neighbours'.
const FAN_RING_PLACES = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]);
// A seated (7.1 'rest') or queued (7.2 'queue') villager holds an exact
// authored point; the fan never moves or re-aims it.
const FAN_EXEMPT_ROLES = new Set(['rest', 'queue']);
// 7.4 — sessions that arrive together enter the village gate in two
// parallel files: each waits hidden until a lane's entry point has no body
// within GATE_ENTRY_GAP_PX, so a restart that lands dozens of sessions in one
// frame walks in spaced, never as a stacked knot. Both lanes run straight
// through the arch along -tileY, from `outsideY` to `insideY`, symmetric on
// the arch's axis (tile column 19.0): both round to walkable column 19, stay
// clear of the masonry jambs (`archHalfWidth - reach = 0.42`) and clear the
// gate lantern fixture at (18, 37) on exit.
const GATE_ENTRY_GAP_PX = 24;
export const GATE_ENTRY_LANES = Object.freeze([
    Object.freeze({ tileX: 18.70, outsideY: 39.35, insideY: 36.6 }),
    Object.freeze({ tileX: 19.30, outsideY: 39.35, insideY: 36.6 }),
]);
// 7.4 — subagents emerging from the Portal Gate step out in two spaced files
// (mirroring GATE_ENTRY_LANES, 32 px apart, both walkable and fixture-free);
// Portal uses a tighter 16 px clearance so workers on its adjacent slots
// (4,34) and (6,34) (19.7 px from the lane entries) never starve the queue.
// A cold-load burst larger than PORTAL_COLD_SETTLE_LIMIT settles at its
// destinations instead of piling up at the Portal, and any queued entry that
// waits past PORTAL_QUEUE_MAX_WAIT_MS falls back to settleAtDestination.
const PORTAL_COLD_SETTLE_LIMIT = 4;
const PORTAL_ENTRY_GAP_PX = 16;
const PORTAL_QUEUE_MAX_WAIT_MS = 4000;
const PORTAL_ENTRY_LANES = Object.freeze([
    Object.freeze({ tileX: 4.55, outsideY: 34.0, insideY: 35.0 }),
    Object.freeze({ tileX: 5.45, outsideY: 34.0, insideY: 35.0 }),
]);

// C2 — the Canvas fallback grades with the same evaluated grade as the
// resident and hybrid paths. A multiply overlay carries the ambient (exposure
// x gain, with the split tone folded to its mid-weight), the stepped edge and
// the vignette; `_drawAtmosphere` adds the desaturation and lift fills.
function canvasGradeFor(atmosphere = null) {
    const grade = atmosphere?.lightGrade || NEUTRAL_GRADE;
    const base = canvasGradeMultiply(grade);
    return { grade, base, edge: grade.vignetteEdge, edgeAlpha: grade.vignetteAlpha };
}

// The overlay is rebuilt only when its visible colours move a 1/64 step.
function canvasGradeOverlayKey(atmosphere = null) {
    const { base, edge, edgeAlpha } = canvasGradeFor(atmosphere);
    return [...base, ...edge, edgeAlpha].map(value => Math.round(value * 64)).join(',');
}

// The resident vignette's two hard courses (t >= 0.62 at 40 %, t >= 0.84 at
// 100 %), as duplicate gradient stops: stepped, never a smooth ramp.
function addSteppedVignetteStops(gradient, colorAt, edgeAlpha) {
    gradient.addColorStop(0, colorAt(0));
    gradient.addColorStop(0.619, colorAt(0));
    gradient.addColorStop(0.62, colorAt(edgeAlpha * 0.4));
    gradient.addColorStop(0.839, colorAt(edgeAlpha * 0.4));
    gradient.addColorStop(0.84, colorAt(edgeAlpha));
    gradient.addColorStop(1, colorAt(edgeAlpha));
}

function gradeColorForCanvas(channels = []) {
    return `rgb(${channels.map(channel => Math.round(channel * 255)).join(', ')})`;
}
// Scene-complexity gates: how many sprites and labels compete for screen area
// is a CSS-space property. They must never read backing pixels — a Retina
// canvas has 4x as many for the same scene, which would strip annotations off
// the world purely because the display is sharp.
const AGENT_RENDER_COMPACT_COUNT = 80;
const AGENT_RENDER_COMPACT_ZOOM = 2.2;
const AGENT_RENDER_COMPACT_CSS_PIXELS = 1_450_000;
const AGENT_RENDER_MINIMAL_COUNT = 96;
const AGENT_RENDER_MINIMAL_CSS_PIXELS = 1_700_000;
const CROWD_CLUSTER_TILE_SIZE = 4;
const CROWD_CLUSTER_TOP_LIMIT = 12;
const CROWD_BUMP_COOLDOWN_LIMIT = 512;

// Body LOD for villager sprites (AgentSprite's 28px compact silhouette). Gated
// on population and CSS viewport only; never on frame-to-frame scene pressure.
function agentBodyRenderMode(count, viewport, zoom) {
    if (count < 50) return 'full';
    const cssPixels = Math.max(0, (viewport?.width || 0) * (viewport?.height || 0));
    if (count >= AGENT_RENDER_MINIMAL_COUNT && cssPixels >= AGENT_RENDER_MINIMAL_CSS_PIXELS) {
        return 'minimal';
    }
    if (
        count >= AGENT_RENDER_COMPACT_COUNT &&
        (zoom <= AGENT_RENDER_COMPACT_ZOOM || cssPixels >= AGENT_RENDER_COMPACT_CSS_PIXELS)
    ) {
        return 'compact';
    }
    return 'full';
}
// C5 identity labels (plan 5.2). Selected/hovered/focused agents get the T2
// plate; routine names (T4) are text only, admitted for the top-N most recent
// actors per 200 px screen region at zoom >= 1.6, and dropped — never slotted
// sideways — when they would overlap an admitted label. Action-needed agents
// are named by their T1 attention plate instead. Geometry: WorldLabelKit.
const ROUTINE_NAME_MIN_ZOOM = 1.6;
const ROUTINE_NAME_REGION_PX = 200;
const ROUTINE_NAMES_PER_REGION = 3;
const ROUTINE_NAMES_PER_REGION_DETAIL = 6;
const ROUTINE_NAME_DETAIL_ZOOM = 3;
// READ (hold B) shows every verb, so it may stack a label downward instead
// of dropping it.
const READ_MODE_NAME_SLOTS = 3;
// A tool change this recent wins a routine name slot.
const LABEL_TOOL_CHANGE_MS = 8000;
// Median 1:1 body footprint (plan 2.1: 48–75 texels tall) for the overlay
// pressure estimate in _agentRenderMode.
const AGENT_BODY_AREA_W = 34;
const AGENT_BODY_AREA_H = 62;
// 3.4 — cell size (world px) for the static prop footprint index that keeps
// name-tag de-collision slots from landing on prop art.
const NAME_SLOT_PROP_CELL = 96;
// W3.1/W3.3/W5-C — thought placement (ThoughtColumn.js owns the geometry). A
// committed candidate is kept while it stays free; on the shared layered grid
// a lower-priority thought collision holds up to THOUGHT_RESEARCH_MS (150 ms)
// before re-searching (never overlapping Layer 1 plaques or Layer 2 plates).
// Direct unlayered callers (without a shared grid or layered options) preserve
// the legacy 300 ms transient-blocker window.
const THOUGHT_RESEARCH_MS = 150;
const THOUGHT_LEGACY_RESEARCH_MS = 300;
const THOUGHT_RETURN_MS = 2000;
const THOUGHT_EDGE_MARGIN = 8;
// Thought budget: a swarm must not turn the World into a wall of text. At most
// THOUGHT_BUDGET columns are placed per frame, freshest line first; a placed
// column keeps its seat THOUGHT_MIN_SEAT_MS so it can be read before a newer
// line takes it. Only the selected or hovered speaker may overlap; anyone else
// with no free candidate stays silent (its head glyph returns). Older lines are
// drawn only for the focused speaker or while at most THOUGHT_CALM_SPEAKERS
// want a thought.
const THOUGHT_BUDGET = 8;
const THOUGHT_MIN_SEAT_MS = 4000;
const THOUGHT_CALM_SPEAKERS = 4;
// Ranking needs no thread, so only this many top-ranked speakers build one,
// merge and search candidates: the pass stays bounded however large the crowd.
const THOUGHT_SHORTLIST = THOUGHT_BUDGET * 3;
// W3.4 — screen px between an occluding building's crown and the tail tip of
// the thought it lifts there.
const THOUGHT_CROWN_GAP = 4;
const THOUGHT_NO_THREAD = Object.freeze([]);
// Street fixture pools (world px). The village keeps fewer lamp posts with a
// wider throw, so the night chain stays continuous without a plinth every
// tile; both stay under SOURCE_HALO_RADIUS_CAP, and deep night alone lets
// them reach `fixturePoolReach` (L1-5) past it.
const STREET_LAMP_POOL_RADIUS = 66;
const BRAZIER_POOL_RADIUS = 70;
// BR-6 / C2 — a bridge sprite's painted flames (manifest `lights`) light as
// candle-scale fixtures: a pool well inside the street lamps' and under
// SOURCE_HALO_RADIUS_CAP, the emissive ramp's gold, held steady (no breath).
const BRIDGE_LIGHT_POOL_RADIUS = 28;
const BRIDGE_LIGHT_INTENSITY = 0.62;
const BRIDGE_LIGHT_COLOR = '#ffcf7a';
const AVENUE_TREE_CLEARANCE = 0.5;

function rectIntersectionArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}
const ATMOSPHERE_EFFECT_ASSETS = Object.freeze({
    rainSplash: 'atmosphere.rain.splash',
});
// Archive fade: keep the sprite in the draw loop for this many ms after
// `agent:removed` so the sibling AgentSprite fade/sparkle animation can play.
const ARCHIVE_FADE_DURATION_MS = 800;
// VB-4 — a loop gap past this settles the world at once (_settleAfterFrameGap),
// and a departure or a gate arrival older than this is over: no walk, no fade.
const LONG_FRAME_GAP_MS = 10_000;
const STALE_TRANSIT_MS = 30_000;
// 2.4 — affinity proximity: how often ally pairs are re-evaluated, and how
// many warm pairs get a shared plaza preference per pass (keeps idle
// drift bounded in dense worlds).
const AFFINITY_PROXIMITY_INTERVAL_MS = 5000;
const MAX_AFFINITY_PROXIMITY_PAIRS = 6;
// drawSprite options for a prop drawn as authored (no winter state).
const NO_PROP_OPTS = Object.freeze({});
// The gatehouse's door leaves (frame 0 shut, 1 open) and how far each curtain
// stub runs into its tower (tiles).
const VILLAGE_GATE_DOORS_SPRITE_ID = 'prop.villageGateDoors';
const VILLAGE_GATE_STUB_INSET = 0.3;
// The gatehouse sorts as world-Y slices of its wall line (see
// _buildDistrictPropSprites). 16 px keeps each slice's depth error to 4 px.
const VILLAGE_GATE_OCCLUSION_COLUMN_PX = 16;
// Canvas counterpart to the GPU wetness shader's four-pixel ordered dither.
// Keep the same 2x2 Bayer ordering so the two paths share the same stepped
// visual grammar without introducing a second pattern.
export function orderedDither4(x = 0, y = 0) {
    const px = Math.floor(Number(x) || 0);
    const py = Math.floor(Number(y) || 0);
    return ((px + 2 * py) & 3) / 3;
}

const VILLAGE_WALL_SEA_TOWER_SPRITE_ID = 'prop.villageWallSeaTower';
// The curtain runs' layout seeds (VillageWall.wallRunLayout): the same run
// always lays the same piers, lanterns, loops and ivy.
const VILLAGE_WALL_SEEDS = Object.freeze({ west: 101, east: 211 });

class FountainWaterSprite extends StaticPropSprite {
    constructor(renderer, fountain) {
        const id = 'prop.plazaFountainWater';
        const [ax, ay] = renderer.assets.getAnchor(id);
        super({
            id, tileX: fountain.tileX, tileY: fountain.tileY,
            sortY: tileToWorld(fountain.tileX, fountain.tileY).y + 0.5,
            bounds: { left: -ax, right: 80 - ax, top: -ay, bottom: 88 - ay },
            materialClass: 'water',
            drawFn: (ctx, x, y) => ctx.drawImage(renderer.assets.get(id), this._paintFrame * 80, 0, 80, 88,
                Math.round(x - ax), Math.round(y - ay), 80, 88),
        });
        this.renderer = renderer;
        this._frames = [];
    }

    _getCachedCanvas(zoom) {
        if (snowBucketOf(this.renderer._groundState?.snowCover) >= 3) {
            this._cacheCanvas = null;
            return null;
        }
        if (!this._frames.length) {
            if (!this.renderer.assets.get(this.id) || typeof document === 'undefined') return null;
            for (let frame = 0; frame < 4; frame++) {
                this._paintFrame = frame;
                this._cacheCanvas = null;
                const cached = super._getCachedCanvas(zoom);
                if (!cached) {
                    this.releaseCache();
                    return null;
                }
                cached.textureKey = `${this.id}:frame${frame}`;
                this._frames.push(cached);
            }
        }
        const frame = this.renderer.motionScale > 0 ? Math.floor((this.renderer.motionTimeMs || 0) / 250) % 4 : 0;
        this._cacheCanvas = this._frames[frame];
        return this._cacheCanvas;
    }

    draw(ctx, zoom) {
        const cached = this._getCachedCanvas(zoom);
        if (cached) ctx.drawImage(cached.canvas, cached.x, cached.y);
    }

    releaseCache() {
        for (const cached of this._frames) releaseCanvasBackingStore(cached.canvas);
        this._frames.length = 0;
        this._cacheCanvas = null;
        this._alphaMask = null;
    }
}

// Both Canvas paths and both GPU backends use the same source rectangle.
class TerraceProp extends StaticPropSprite {
    constructor(renderer, id, tileX, tileY, image, width, height, anchorY, materialClass) {
        super({ id, tileX, tileY, drawFn: ctx => this.draw(ctx), materialClass,
            bounds: { left: -width / 2, right: width / 2, top: -anchorY, bottom: height - anchorY } });
        this.renderer = renderer;
        this.image = image;
        this.frameWidth = width;
        this.frameHeight = height;
    }

    terraceFrame() {
        const source = this.renderer.assets?.get?.(this.id) || this.image;
        if (!source?.width || source.complete === false || source.naturalWidth === 0) return null;
        const w = this.frameWidth, h = this.frameHeight;
        const frames = Math.floor(source.width / w);
        if (!frames || source.height < h) return null;
        const frame = this.renderer.motionScale > 0 ? Math.floor(this.renderer.motionTimeMs * 6 / 1000) % frames : 0;
        return { source, sx: frame * w, sy: 0, sw: w, sh: h,
            x: Math.round(this.x + this.bounds.left), y: Math.round(this.y + this.bounds.top), width: w, height: h };
    }

    draw(ctx) {
        const f = this.terraceFrame();
        if (f) ctx.drawImage(f.source, f.sx, f.sy, f.sw, f.sh, f.x, f.y, f.width, f.height);
    }

    drawCached(ctx) { this.draw(ctx); }
}

class WorldAgentSprite extends AgentSprite {
    _isScreenSegmentWalkable(x0, y0, x1, y1) {
        if (this.pathfinder?.surfaceRegistry) {
            const a = worldToTile(x0, y0), b = worldToTile(x1, y1);
            if (!this.pathfinder.surfaceSegmentClear(a.tileX, a.tileY, b.tileX, b.tileY)) return false;
        }
        return super._isScreenSegmentWalkable(x0, y0, x1, y1);
    }

    _thoughtOwnsHead() {
        return this.theatreMode || super._thoughtOwnsHead();
    }

    _drawToolGlyphBadge(ctx, top) {
        return !this.theatreMode && super._drawToolGlyphBadge(ctx, top);
    }
}

export class IsometricRenderer {
    constructor(world, options = {}) {
        this.world = world;
        this.surfaceRegistry = VILLAGE_SURFACES;
        this._spillwaySplashes = this.surfaceRegistry.spills.map(spill => {
            const { tx, ty } = tileCoords(spill.lower[0]);
            return tileToWorldElevated(tx, ty, spill.lower[1], this.surfaceRegistry);
        });
        this.replay = options.replay || null;
        this.assets = options.assets || null;
        this.sprites = this.assets ? new SpriteRenderer(this.assets) : null;
        installGroundBake(this);
        registerCoastBake(this);
        this.compositor = this.assets ? new Compositor(this.assets) : null;
        this.canvas = null;
        this.ctx = null;
        this.fxCanvas = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.postFx = null;
        this.postFxFeed = null;
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this.worldBackendReason = null;
        this.worldBackendNotes = null;
        this._backendSessionNote = null;
        this._backendSelection = null;
        this._pendingWebGpu = null;
        this._worldSwap = null;
        // A failed WebGPU world's WebGL2 fallback while it is being built off
        // the frame (`_fallBackFromWebGpu`); the loop holds the last frame.
        this._fallbackPrep = null;
        this._postFxCanvasVisible = null;
        this.camera = null;
        this.cameraDirector = null;
        this.particleSystem = new ParticleSystem();
        this.buildingRenderer = this.assets
            ? new BuildingSprite(this.assets, this.sprites, this.particleSystem)
            : null;
        this.harborTraffic = new HarborTraffic({ sprites: this.sprites });
        // #8 — the harbor's semantics (reconcile + `harbor:updated`) stay
        // live while the World loop is stopped (Dashboard mode), so the
        // sidebar ledger and the Dashboard lane chips never freeze. While the
        // loop runs, `_update` reconciles and this timer does nothing.
        this._harborSemanticsTimer = typeof setInterval === 'function'
            ? setInterval(() => this._reconcileHarborWhileWorldStopped(), HARBOR_SEMANTICS_IDLE_MS)
            : null;
        this.visitIntentManager = new VisitIntentManager({ world: this.world });
        this.visitTileAllocator = new VisitTileAllocator();
        this.atmosphereState = new AtmosphereState(this.replay
            ? { nowProvider: () => new Date(this.replay.replayClock.now) } : undefined);
        this.skyRenderer = new SkyRenderer({ assets: this.assets });
        this.weatherRenderer = new WeatherRenderer();
        // Weather renderer needs the AssetManager so its sprite-stamp helpers
        // (rain splashes, water ripples) can resolve atmosphere.* asset IDs.
        // Method is defensively optional because it only landed alongside the
        // stamp helpers.
        this.weatherRenderer.setAssets?.(this.assets);
        // Seasonal ambient particles (snow/petals/fireflies/leaves) routed
        // into the shared ParticleSystem. Atmosphere snapshot is captured
        // per-frame onto _lastAtmosphere by WorldFrameRenderer; fall back to
        // the raw AtmosphereState snapshot before the first frame runs.
        this.seasonalAmbience = new SeasonalAmbience({
            particleSystem: this.particleSystem,
            atmosphereStateGetter: () => this._lastAtmosphere ?? this.atmosphereState?.snapshot?.() ?? null,
            motionScaleGetter: () => this.motionScale ?? 1,
            viewportProvider: () => ({
                x: 0,
                y: 0,
                width: (this.canvas?.width ?? 0) / (this._screenDpr?.() || 1),
                height: (this.canvas?.height ?? 0) / (this._screenDpr?.() || 1),
            }),
            // C2 — anchor petal/leaf drift to visible tree canopies and
            // butterflies to flower tiles; snow falls anywhere in view. The
            // camera maps them into world space and gates the zoom budget.
            anchorsProvider: (kind) => this._seasonalDriftAnchors(kind),
            cameraGetter: () => this.camera,
            // BI-4 — the gust field's clock, and the river's current where a
            // falling leaf lands (the coast bake's water fields).
            motionTimeGetter: () => this.motionTimeMs || 0,
            riverCurrentAt: (x, y) => riverCurrentAt(this, x, y),
        });
        this.landmarkActivity = new LandmarkActivity({ world: this.world, sprites: this.sprites });
        this.chronicleStore = options.chronicleStore || null;
        this.modal = options.modal || null;
        // Application-layer services wired in App.js. All optional: the
        // renderer degrades to its pre-metaphor behavior when absent.
        this.moodService = options.moodService || null;
        this.biographyService = options.biographyService || null;
        this.affinityService = options.affinityService || null;
        this._nicknames = new Map(); // identityKey -> earned nickname
        this._biographyReadGeneration = 0;
        this._affinityProximityAccumulator = 0;
        this._allyTetherPairs = []; // warmest idle ally pairs, drawn as tethers

        this._chronicleChannelListener = null;
        this.agentEventStream = null;
        this.relationshipState = null;
        this.ritualConductor = null;
        this.arrivalDeparture = null;
        this.chronicleMonuments = null;
        this.trailRenderer = null;
        this.chronicler = null;
        this.villageDirector = new VillageDirector(this.world);
        this.pulsePriority = getPulsePriority();
        // #2 — value-hierarchy mark governor. Published as the active singleton
        // so the decorative draw paths (AgentSprite/CouncilRing/director overlay)
        // can consult it without the frame orchestrator threading it through.
        this.markGovernor = new MarkGovernor();
        setActiveMarkGovernor(this.markGovernor);
        this.agentSprites = new Map();
        this.gateTransits = new Map();
        this.gateDoorsOpen = false;
        this._gateDoorsOpenUntilMs = 0;
        this._gateDoorStateSprites = [];
        this._sortedSprites = [];
        this._allSpritesSnapshot = [];
        this._visibleSortedSprites = [];
        this._visibleSpriteCandidates = new Set();
        this._movingSprites = [];
        this._pairBuckets = new Map();
        this._pairColumnPool = [];
        this._pairBucketPool = [];
        this._pairIds = new Map();
        this._pairIdentityRanks = new Map();
        this._pairDuplicatePairs = new Map();
        this._spritesNeedSort = true;
        this._overlayPrioritizedSprites = [];
        this._overlayBubbleSprites = [];
        this._overlayBubbleOrder = [];
        this._overlayBubbleBaseRects = [];
        this._overlayBubbleClusters = [];
        this._overlayBubbleClusterCount = 0;
        this._overlayBubbleGroups = new Map();
        this._agentLabelHitRects = [];
        this._overlayRegionCounts = new Map();
        this._attentionWorldRects = [];
        this._attentionLayout = null;
        this._overlayNameRects = [];
        this._overlayReservedRects = [];
        this._overlayBubbleOccupiedRects = [];
        this._overlayNameGrid = this._createRectGrid();
        this._overlayBubbleGrid = this._createRectGrid();
        this._overlayClusterGrid = this._createRectGrid();
        // W5-C — shared 96 px flat typed-array overlay occupancy grids and
        // reusable ThoughtColumn candidate pool (zero per-frame allocations).
        this._overlayOccupancyGrid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
        this._attentionOccupancyGrid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
        this._thoughtCandidatePool = createThoughtCandidatePool(LABEL_MAX_SPEAKERS);
        this._labelAuctionStats = {
            frames: 0,
            plaques: 0,
            attention: 0,
            speakers: 0,
            placed: 0,
            filtered: 0,
            iterations: 0,
            totalPlaced: 0,
            totalFiltered: 0,
        };
        // W5-C — preallocated reusable ORCA crowd pools (zero per-frame heap churn).
        this._orcaPools = null;
        this._ensureOrcaPools();
        this._cutawayContext = { harborPendingRepos: [], compactionEvents: [] };
        this._laneTiles = new Map();
        this._staticPropDrawables = [];
        this._drawables = [];
        this._familiarMoteDrawables = [];
        this._harborPendingSignature = '';
        this._contextLost = false;
        this._disposed = false;
        this.running = false;
        this.frameId = null;
        this._framePacing = createFramePacing();
        // FP-1b — the ambient (30 fps) cadence: the last frame's verdict, the
        // camera it was judged on, and the last pointer input (rAF timebase).
        this._ambientHint = false;
        this._ambientCamera = { x: NaN, y: NaN, zoom: NaN };
        this._pointerInputAt = -Infinity;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
        this._cancelTerrainRestage();
        this.terrainCacheMeta = null;
        this._terrainCacheLimitWarningKey = '';
        this.foliageRenderer = new FoliageRenderer(this);
        // 5.2 — flora props' winter states (dormant beds, snow caps).
        this.propWinter = new PropWinter(this);
        this.wildlifeRenderer = new WildlifeRenderer(this);
        this.terrainSeed = [];
        this._motionClock = createMotionClock();
        // 6.1 — building parts and emitter cycles step on the one clock.
        if (this.buildingRenderer) this.buildingRenderer.motionClock = this._motionClock;
        this.waterFrame = 0;
        this.motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this.motionScale = this.motionQuery?.matches ? 0 : 1;
        this.ritualConductor = new RitualConductor({ motionScale: this.motionScale });
        this.arrivalDeparture = new ArrivalDepartureController({ motionScale: this.motionScale });
        // The repo stones draw from `assets`.
        this.chronicleMonuments = new ChronicleMonuments({
            store: this.chronicleStore,
            assets: this.assets,
            // 8.2 — the release crown rides the release's own sloop.
            harbor: this.harborTraffic,
        });
        this.harborTraffic?.setActiveBannerProbe?.(() => this.chronicleMonuments?._activeBanners || null);
        this._deferredChronicleBanners = [];
        this._lastChronicleBannerAt = -Infinity;
        // 6.7 — the Chronicle dressing layers read the planter's lifetime ledger;
        // 8.2 (M16) — the Harbor's day pennant reads the release records.
        if (this.buildingRenderer) {
            this.buildingRenderer.chronicleDressing = this.chronicleMonuments.planter.dressing;
            this.buildingRenderer.releaseDay = this.chronicleMonuments;
            // W6.10 — the calendar's landmark dressing (door wreaths).
            this.buildingRenderer.villageCalendar = (this.villageCalendar ||= new VillageCalendar());
        }
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            sprites: this.agentSprites,
            motionScale: this.motionScale,
            surfaceAt: (worldX, worldY) => this._trailSurfaceAt(worldX, worldY),
        });
        this._visualBeat = null;
        this._patinaByIdentity = new Map();
        this._benchClaimsByIdentity = new Map();
        this._benchPatinaBySeat = new Map();
        this._restSeatBackProps = new Map();
        this._seatedSeatByAgent = new Map();
        this._allyNodCooldowns = new Map();
        this._childTrimById = new Map();
        this._workflowRibbons = { byAgentId: new Map(), byParentId: new Map() };
        this._compactionsPrimedOnce = false;
        this.chronicler = new Chronicler({ motionScale: this.motionScale });
        this.particleSystem.setMotionEnabled(this.motionScale > 0);
        this._onMotionPreferenceChange = (event) => this._setMotionScale(event.matches ? 0 : 1);
        this._motionPreferenceBound = false;
        this._bindMotionPreference();
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        this._poolLayer = null;
        this._poolShadeLayer = null;
        this._poolLayerRect = null;
        this.lightGradientCache = new Map();
        this.lightFadeColorCache = new Map();
        this.lightColorRgbCache = new Map();
        this._atmosphereEffectSpriteCache = new Map();
        this._lightFadeColorCacheEvictions = 0;
        this._lightColorRgbCacheEvictions = 0;
        this._frameLightSources = null;
        this.selectedAgent = null;
        this.onAgentSelect = null;
        this._chatMatchAccumulator = 250;
        this._activeAgentsSnapshot = [];
        this._crowdBumpCooldowns = new Map();
        this._stationaryOverlapAccumulator = 0;
        this._rainSplashAccumulator = 0;
        this._localAvoidanceMetrics = {
            laneCorrections: 0,
            separationPushes: 0,
            zeroDistancePairs: 0,
            progressClamps: 0,
            orcaFrames: 0,
            orcaLines: 0,
            strideAdjustments: 0,
            walkClamps: 0,
            waypointAdvances: 0,
        };
        this._crowdStats = this._emptyCrowdStats();
        this._crowdStatsAccumulator = 0;
        this._lastAgentCount = 0;
        this._ritualSyncFrame = 0;
        this._lastRitualPoseMode = 'full';
        this.behaviorMetrics = {
            stationaryRetargets: 0,
            stationaryOverlapChecks: 0,
            scenicVisits: 0,
            parentCoherentChildren: 0,
            handoffIntents: 0,
        };
        this.behaviorTelemetry = new BehaviorTelemetry({
            buildingTypes: Array.from(this.world?.buildings?.values?.() || [], building => building.type),
        });
        this._chronicleNextUpdateAt = 0;
        this._chronicleUpdating = false;
        this._chronicleUpdatePromise = null;
        this._worldModeActive = true;
        this._worldResourcesSuspended = false;
        this._worldResourceGeneration = 0;
        this._worldResumePromise = null;
        this._worldResumeGeneration = null;
        this._worldResumeFailures = 0;
        // 0.3 — the boot reveal waits for the opening pose (App._openWorld).
        this._firstFrameReason = 'boot-pending';
        this.presentGeneration = 0;
        this._worldSpritesDirty = false;
        // VB-4 — between pauseForVisibility and resumeFromVisibility the agent
        // handlers take the inactive branch: no frame would advance a walk.
        this._visibilityPaused = false;
        this._idleFrameDirty = true;
        this._idleLastRenderCamera = { x: NaN, y: NaN, zoom: NaN };
        this._idleResourceWorkObserved = false;
        this._harborFailedPushState = null;
        this._activeWorkingCount = 0;
        this._onModeChanged = null;
        this._debugGlobals = new Map();
        this._frameFailureStats = {
            total: 0,
            consecutive: 0,
            lastStage: null,
            lastMessage: null,
            lastAt: 0,
            lastReportedAt: -Infinity,
            byStage: {},
            paused: false,
        };
        this._frameFailureRecoveryTimer = null;
        this._frameFailureRetryMs = WORLD_FRAME_RETRY_INITIAL_MS;
        this._frameFailureEpisode = false;
        this._performanceSamples = null;
        this._frameEnvelope = createFrameEnvelope();
        this._frameTimer = null;
        this._frameHealthHelper = null;
        this._installFrameHealthHelper();

        // Generate deterministic terrain seed so the village keeps its geography across reloads.
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                this.terrainSeed.push(this._tileNoise(x, y));
            }
        }

        // Path tiles (near buildings)
        this.pathTiles = new Set();
        this.townSquareTiles = new Set();
        this.mainAvenueTiles = new Set();
        this.avenueTiles = new Set();
        this.dirtPathTiles = new Set();
        this.busyWalkTiles = new Set();
        this.commandCenterRoadTiles = new Set();
        this._generatePaths();

        // Scenery (water, shorelines, bridges, vegetation, rocks)
        this.scenery = new SceneryEngine({
            world: this.world,
            terrainSeed: this.terrainSeed,
            tileNoise: (x, y) => this._tileNoise(x, y),
            smoothNoise: (x, y, scale) => this._smoothNoise(x, y, scale),
        });
        this.waterTiles = this.scenery.getWaterTiles();
        this.shoreTiles = this.scenery.getShoreTiles();
        this.wetShoreTiles = this.scenery.getWetShoreTiles?.() || new Set();
        this.deepWaterTiles = this.scenery.getDeepWaterTiles();
        this.lagoonWaterTiles = this.scenery.getLagoonWaterTiles();
        this.waterMeta = this.scenery.getWaterMeta?.() || new Map();
        this.harborWaterApronTiles = this._buildHarborWaterApronTiles();

        // Bridges (Task 5): two authored river crossings only.
        this.scenery.generateBridges();
        this.bridgeTiles = this.scenery.getBridgeTiles();
        // Harbor ships moor and sail on the live water (HarborLayout's field).
        this.harborTraffic?.setWaterMask?.(this.waterTiles, this.bridgeTiles);
        this.bridgeLanterns = new BridgeLanterns({ renderer: this });
        this.bridgeSpans = this._buildBridgeSpans();
        this._waterTileDescriptors = this._buildWaterTileDescriptors();
        for (const [key] of Array.from(this.yardTiles.entries())) {
            if (this.waterTiles.has(key) && !this.bridgeTiles.has(key)) {
                this.yardTiles.delete(key);
                if (!this.roadMaterialTiles.has(key)) this.pathTiles.delete(key);
            }
        }
        for (const key of this.bridgeTiles.keys()) {
            this.pathTiles.add(key);
        }
        this._generateFrontageSpurs();
        // Re-classify so newly-pathified bridge and spur tiles take their
        // material. _classifyRoadMaterials *adds* to mainAvenueTiles,
        // dirtPathTiles and busyWalkTiles, so clear first to keep the paved and
        // earth sets exclusive.
        this.mainAvenueTiles.clear();
        this.dirtPathTiles.clear();
        this.busyWalkTiles.clear();
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);
        // 3.3 — scenery keeps the whole old building ring clear even though
        // only the frontage is road now, so trees/boulders/props place exactly
        // as before and never crowd a wall.
        this.sceneryClearTiles = new Set([...this.pathTiles, ...this.yardClearTiles]);

        // Now that bridges are in pathTiles, generate terrain features so
        // bridges don't get tagged with reeds/flowers/stones/mushrooms.
        this.featureTiles = new Map();
        this._generateTerrainFeatures();

        // Flat vegetation (bushes, grass tufts) — populated after terrain features
        // so noise samples don't compete and after bridges so they're skipped.
        this.scenery.generateFlatVegetation(this.sceneryClearTiles, this.bridgeTiles);
        this.bushTiles = this.scenery.getBushTiles();
        this.grassTuftTiles = this.scenery.getGrassTuftTiles();
        this.flowerTiles = this.scenery.getFlowerTiles();

        // Trees (Y-sorted props): clumped 1× trees from SceneryEngine, drawn
        // from the foliage renderer's shared canopy and lean-frame images
        // (plinth-free sprites, one pixel grid, one wind).
        this.scenery.generateTrees(
            this.sceneryClearTiles,
            this.bridgeTiles,
            (tileX, tileY) => this._isInBridgeTreeExclusion(tileX, tileY),
            coastDistanceProbe(this),
            (tileX, tileY) => this._nearMainAvenue(tileX, tileY),
        );
        this.treePropSprites = this.foliageRenderer.createTreeProps(this.scenery.getTreeProps());

        // Boulders (Y-sorted props)
        this.scenery.generateBoulders(this.sceneryClearTiles, this.bridgeTiles);
        this.boulderPropSprites = this.scenery.getBoulderProps().map((b) => {
            // variant 'a' → mossy, 'b' → granite; size driven by scale threshold.
            const species = b.variant === 'b' ? 'granite' : 'mossy';
            const size = (b.scale ?? 1) >= 1.0 ? 'large' : 'small';
            const id = `veg.boulder.${species}.${size}`;
            return new StaticPropSprite({
                tileX: b.tileX,
                tileY: b.tileY,
                id,
                bounds: this._assetPropBounds(id, 0.62),
                splitForOcclusion: false,
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y, this._winterPropOpts(id)); },
            });
        });
        this.districtPropSprites = [...this._buildDistrictPropSprites(), ...this._buildTerraceProps()];
        this._staticPropSprites = [
            ...this.treePropSprites,
            ...this.boulderPropSprites,
            ...this.districtPropSprites,
        ];
        for (const sprite of this._staticPropSprites) {
            sprite.supportH = supportHeight(sprite.tileX, sprite.tileY, this.surfaceRegistry);
            sprite.y -= sprite.supportH;
        }
        // The cached flora and roofed props (and the bridge's near-rail
        // slices, cut from the bridge image; the gatehouse, whose towers and
        // arch take roof snow; the wall runs, whose walk takes it) that
        // repaint when the winter state steps.
        this._winterPropSprites = this._staticPropSprites.filter((sprite) => WINTER_PROPS[sprite.id]
            || sprite.id === VILLAGE_GATE.id
            || sprite.id?.startsWith?.('bridge.rail.')
            || sprite.id?.startsWith?.('village.wall.'));
        this._staticPropDrawables = this._buildStaticPropDrawables();
        this._staticPropFastDrawables = this._buildStaticPropFastDrawables();
        this._staticPropFastFrameDrawables = [];
        this._staticPropVisibleFrameDrawables = [];
        // 3.4 — props are static after init, so the footprint index the
        // name-tag slot clamp queries is built once here.
        this._propFootprintIndex = this._buildPropFootprintIndex(this._staticPropSprites);

        // Walkability grid + Pathfinder (Task 11). VB-15 — bodies route on the
        // gate's walk component only: the Pathfinder's copy closes every tile
        // no route from the gate reaches, so no boot spawn or nearest-walkable
        // snap lands in a sealed pocket. The ground grid itself (AmbientGround's
        // splashes and fireflies, monument sites, the debug overlay) keeps
        // every open tile.
        this.walkabilityGrid = this.scenery.getWalkabilityGrid();
        this.pathfinder = new Pathfinder(this.walkabilityGrid.slice(), { surfaceRegistry: this.surfaceRegistry });
        this.pathfinder.keepReachableFrom(VILLAGE_GATE.inside);
        this._walkClearance = createWalkClearance({
            buildings: this.world?.buildings,
            bridgeTiles: this.bridgeTiles,
            pathfinder: this.pathfinder,
            getCoastField: () => this._coastField || this.coastField || null,
        });
        this.visitTileAllocator.updateContext({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });

        this._generateCommandCenterAmbience();
        this._laneTiles = this._buildLaneTileIndex();
        this.ambientEmitters = [];
        this._generateAmbientEmitters();
        // 6.7 — occupancy-gated chimney smoke from the registry's chimney
        // anchors (one owner for every chimney column).
        this.chimneySmoke = new ChimneySmoke();

        // Event subscriptions
        this._unsubscribers = [];
        this.debugOverlay = null;
        this._debugOverlayModulePromise = null;
        this._terrainArtifactBoot = options.terrainArtifactBoot;
        this._prepareTerrainArtifactRead();
    }

    _generatePaths() {
        const buildingDefs = Array.from(this.world.buildings.values());
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        // 3.3 — a building no longer paves its footprint plus a one-tile ring
        // (that made 41% of the land "yard"). The ring stays clear of scenery
        // (`yardClearTiles`), but only the authored frontage — the ring side
        // the entrance faces, plus the entrance and visit tiles — is road.
        // `yardTiles` maps those frontage tiles to their building so the
        // ground bake can lay each district's yard material (4.7).
        this.yardTiles = new Map();
        this.yardClearTiles = new Set();
        this.roadMaterialTiles = new Map();
        for (const b of buildingDefs) {
            const x0 = b.position.tileX;
            const y0 = b.position.tileY;
            const x1 = x0 + b.width - 1;
            const y1 = y0 + b.height - 1;
            for (let x = x0 - 1; x <= x1 + 1; x++) {
                for (let y = y0 - 1; y <= y1 + 1; y++) {
                    if (this._inMapBounds(x, y)) this.yardClearTiles.add(`${x},${y}`);
                }
            }
            if (b === command) continue;
            for (const key of this._buildingFrontageKeys(b)) {
                this.pathTiles.add(key);
                this.yardTiles.set(key, b.type);
            }
            for (const tile of this._buildingApproachTiles(b)) {
                if (!this._inMapBounds(tile.tileX, tile.tileY)) continue;
                const tx = Math.round(tile.tileX);
                const ty = Math.round(tile.tileY);
                const key = `${tx},${ty}`;
                this.pathTiles.add(key);
                const reach = Math.max(x0 - tx, tx - x1, y0 - ty, ty - y1);
                if (reach <= 2 && !this.yardTiles.has(key)) this.yardTiles.set(key, b.type);
            }
        }
        // 4.2 — the Command plaza wraps the keep on all four sides: dressed
        // limestone right up to the walls, meeting the town square in front.
        if (command) {
            for (let x = command.position.tileX - 1; x <= command.position.tileX + command.width; x++) {
                for (let y = command.position.tileY - 1; y <= command.position.tileY + command.height; y++) {
                    if (!this._inMapBounds(x, y)) continue;
                    this.townSquareTiles.add(`${x},${y}`);
                    this.pathTiles.add(`${x},${y}`);
                }
            }
            for (const tile of this._buildingApproachTiles(command)) {
                if (this._inMapBounds(tile.tileX, tile.tileY)) {
                    this.pathTiles.add(`${Math.round(tile.tileX)},${Math.round(tile.tileY)}`);
                }
            }
        }
        // CM-1 — the square is centred one row out from the door, so it runs
        // from the gate steps to the river bank at the bridge's north landing.
        this._generateTownSquare(plazaHub.x, plazaHub.y + 1);
        this._generatePlannedRoads();
        this._generateGateApproach();
        // Fallback connection for future buildings that are not covered by
        // the authored road plan.
        for (const bDef of buildingDefs) {
            const destination = this._buildingRoadDestination(bDef);
            const key = `${destination.x},${destination.y}`;
            if (!this.pathTiles.has(key)) {
                this._addTownRoad(plazaHub.x, plazaHub.y, destination.x, destination.y);
            }
        }
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);
    }

    // The ring tiles on the side(s) of the footprint the entrance faces: one
    // tile deep along that face, plus the corner when the door sits diagonal.
    _buildingFrontageKeys(building) {
        const entrance = building?.entrance;
        if (!entrance) return [];
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const x1 = x0 + building.width - 1;
        const y1 = y0 + building.height - 1;
        const dx = entrance.tileX < x0 ? -1 : entrance.tileX > x1 ? 1 : 0;
        const dy = entrance.tileY < y0 ? -1 : entrance.tileY > y1 ? 1 : 0;
        const keys = [];
        const push = (x, y) => {
            if (!this._inMapBounds(x, y)) return;
            const key = `${x},${y}`;
            if (this.waterTiles?.has(key) && !this.bridgeTiles?.has(key)) return;
            keys.push(key);
        };
        if (dy) for (let x = x0; x <= x1; x++) push(x, dy > 0 ? y1 + 1 : y0 - 1);
        if (dx) for (let y = y0; y <= y1; y++) push(dx > 0 ? x1 + 1 : x0 - 1, y);
        if (dx && dy) push(dx > 0 ? x1 + 1 : x0 - 1, dy > 0 ? y1 + 1 : y0 - 1);
        return keys;
    }

    // 3.3 — every door connects to the road network by a short spur, a paved
    // `lane` since v0.61.2 (the yard ring used to do this implicitly). Runs
    // once water is known: a breadth-first walk from the entrance over dry,
    // unbuilt tiles to the nearest authored road, plaza or bridge tile. Spur
    // tiles are real path tiles, so routing and the painted ground agree.
    _generateFrontageSpurs() {
        this.frontageSpurs = [];
        const footprints = new Set();
        for (const b of this.world.buildings.values()) {
            for (let x = b.position.tileX; x < b.position.tileX + b.width; x++) {
                for (let y = b.position.tileY; y < b.position.tileY + b.height; y++) footprints.add(`${x},${y}`);
            }
        }
        const isNetwork = (key) => this.roadMaterialTiles.has(key)
            || this.townSquareTiles.has(key)
            || this.bridgeTiles?.has(key);
        for (const b of this.world.buildings.values()) {
            const entrance = b.entrance;
            if (!entrance || !this._inMapBounds(entrance.tileX, entrance.tileY)) continue;
            const start = `${Math.round(entrance.tileX)},${Math.round(entrance.tileY)}`;
            if (isNetwork(start)) {
                this.frontageSpurs.push({ type: b.type, tiles: [this._parseTileKey(start)] });
                continue;
            }
            const previous = new Map([[start, null]]);
            const queue = [start];
            let found = null;
            for (let head = 0; head < queue.length && !found; head++) {
                const key = queue[head];
                const tile = this._parseTileKey(key);
                for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = tile.tileX + ox;
                    const ny = tile.tileY + oy;
                    const next = `${nx},${ny}`;
                    if (previous.has(next) || !this._inMapBounds(nx, ny)) continue;
                    if (footprints.has(next)) continue;
                    if (this.waterTiles.has(next) && !this.bridgeTiles?.has(next)) continue;
                    previous.set(next, key);
                    if (isNetwork(next)) { found = next; break; }
                    if (Math.abs(nx - entrance.tileX) + Math.abs(ny - entrance.tileY) < 10) queue.push(next);
                }
            }
            if (!found) continue;
            const tiles = [];
            for (let key = found; key; key = previous.get(key)) {
                tiles.unshift(this._parseTileKey(key));
                if (key === found) continue;
                this.pathTiles.add(key);
                if (!this.roadMaterialTiles.has(key)) this.roadMaterialTiles.set(key, 'lane');
            }
            this.frontageSpurs.push({ type: b.type, tiles });
        }
    }

    _buildingApproachTiles(building) {
        const out = [];
        if (building?.entrance) out.push(building.entrance);
        if (Array.isArray(building?.visitTiles)) out.push(...building.visitTiles);
        return out;
    }

    _buildHarborWaterApronTiles() {
        const set = new Set();
        const harbor = this.world.buildings.get('harbor');
        if (!harbor) return set;
        const x0 = Math.floor(harbor.position.tileX);
        const y0 = Math.floor(harbor.position.tileY);
        for (let x = x0; x < x0 + harbor.width; x++) {
            for (let y = y0; y < y0 + harbor.height; y++) {
                set.add(`${x},${y}`);
            }
        }
        return set;
    }

    _isVisualWaterTile(tileX, tileY, key = `${tileX},${tileY}`) {
        return this.waterTiles.has(key) || this.harborWaterApronTiles?.has(key);
    }

    _waterMetaAt(tileX, tileY, key = `${tileX},${tileY}`) {
        return this.waterMeta?.get?.(key) || null;
    }

    _waterRegionAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        if (meta?.region) return meta.region;
        if (this.lagoonWaterTiles?.has(key)) return 'lagoon';
        if (this.deepWaterTiles?.has(key)) return 'sea';
        return 'water';
    }

    _waterProfileAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        if (meta?.weatherProfile) return meta.weatherProfile;
        const region = this._waterRegionAt(tileX, tileY, key);
        if (region === 'sea' || region === 'openSea') return 'openSea';
        return region;
    }

    // One record per open water tile: its screen centre and downstream unit
    // vector, for the Canvas lamp columns and PostFxFeed's water mask.
    _buildWaterTileDescriptors() {
        const descriptors = [];
        if (!this.waterTiles?.size) return descriptors;
        for (const key of this.waterTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const { tileX: x, tileY: y } = tile;
            const meta = this._waterMetaAt(x, y, key);
            const flowDirX = Number(meta?.flowDirX) || 0;
            const flowDirY = Number(meta?.flowDirY) || 0;
            const flowScreenX = (flowDirX - flowDirY) * TILE_WIDTH / 2;
            const flowScreenY = (flowDirX + flowDirY) * TILE_HEIGHT / 2;
            const flowScreenLength = Math.hypot(flowScreenX, flowScreenY) || 1;
            descriptors.push({
                x,
                y,
                key,
                screenX: (x - y) * TILE_WIDTH / 2,
                screenY: (x + y) * TILE_HEIGHT / 2,
                flowUnitX: flowScreenX / flowScreenLength,
                flowUnitY: flowScreenY / flowScreenLength,
            });
        }
        return descriptors;
    }

    _generatePlannedRoads() {
        for (const route of TOWN_ROAD_ROUTES) {
            this._addRoadPolyline(route.points, route.width || 1, route.material || 'lane');
        }
    }

    _addRoadPolyline(points = [], width = 1, material = 'lane') {
        if (points.length < 2) return;
        for (let i = 0; i < points.length - 1; i++) {
            this._addRoadSegment(points[i], points[i + 1], width, material);
        }
    }

    _addRoadSegment(from, to, width = 1, material = 'lane') {
        const [fromX, fromY] = from;
        const [toX, toY] = to;
        const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1) * 2;
        // Brush spans [lo, hi] tiles: width 1 → the tile, width 2 → a 2×2
        // brush (the radiating civic arms), width 3 → centred 3×3.
        const lo = -Math.floor((Math.max(1, width) - 1) / 2);
        const hi = Math.floor(Math.max(1, width) / 2);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(fromX + (toX - fromX) * t);
            const y = Math.round(fromY + (toY - fromY) * t);
            for (let ox = lo; ox <= hi; ox++) {
                for (let oy = lo; oy <= hi; oy++) {
                    const tx = x + ox;
                    const ty = y + oy;
                    if (!this._inMapBounds(tx, ty)) continue;
                    const key = `${tx},${ty}`;
                    this.pathTiles.add(key);
                    this._markRoadMaterial(key, material);
                }
            }
        }
    }

    _generateGateApproach() {
        this._addRoadPolyline([[18, 38], [20, 38], [21, 38], [20, 39], [18, 39]], 1, 'lane');
        for (let x = 18; x <= 21; x++) {
            for (let y = 38; y <= 39; y++) {
                if (!this._inMapBounds(x, y)) continue;
                const key = `${x},${y}`;
                this.pathTiles.add(key);
                this._markRoadMaterial(key, 'lane');
            }
        }
    }

    // Records the authored material of a route tile. Where routes cross the
    // busier one wins (avenue > dock > lane), so material changes only at
    // junctions; `_classifyRoadMaterials` turns this into the tile sets.
    _markRoadMaterial(key, material) {
        const current = this.roadMaterialTiles.get(key);
        const rank = (m) => (m === 'avenue' ? 3 : m === 'dock' ? 2 : m ? 1 : 0);
        if (rank(material) > rank(current)) this.roadMaterialTiles.set(key, material);
        if (material === 'avenue') {
            this.commandCenterRoadTiles.add(key);
            this.avenueTiles?.add(key);
        }
    }

    _buildingRoadDestination(building) {
        const visit = typeof building.primaryVisitTile === 'function'
            ? building.primaryVisitTile()
            : building.entrance;
        if (visit && Number.isFinite(visit.tileX) && Number.isFinite(visit.tileY)) {
            return {
                x: Math.round(visit.tileX),
                y: Math.round(visit.tileY),
            };
        }
        return {
            x: Math.floor(building.position.tileX + building.width / 2),
            y: Math.floor(building.position.tileY + building.height / 2),
        };
    }

    _commandPlazaHub(command) {
        const visit = typeof command?.primaryVisitTile === 'function'
            ? command.primaryVisitTile()
            : command?.entrance;
        if (visit && Number.isFinite(visit.tileX) && Number.isFinite(visit.tileY)) {
            return { x: Math.round(visit.tileX), y: Math.round(visit.tileY) };
        }
        if (command) {
            return {
                x: Math.floor(command.position.tileX + command.width / 2),
                y: Math.floor(command.position.tileY + command.height),
            };
        }
        return { x: 20, y: 22 };
    }

    _generateTownSquare(centerX, centerY) {
        for (let x = centerX - 3; x <= centerX + 4; x++) {
            for (let y = centerY - 2; y <= centerY + 2; y++) {
                const dx = (x - centerX) / 3.2;
                const dy = (y - centerY) / 2.2;
                if ((dx * dx + dy * dy) <= 1.0 && this._inMapBounds(x, y)) {
                    const key = `${x},${y}`;
                    this.townSquareTiles.add(key);
                    this.pathTiles.add(key);
                }
            }
        }
    }

    _addTownRoad(fromX, fromY, toX, toY) {
        const midX = toX;
        const startX = Math.min(fromX, midX);
        const endX = Math.max(fromX, midX);
        for (let x = startX; x <= endX; x++) {
            this.pathTiles.add(`${x},${fromY}`);
            this.pathTiles.add(`${x},${fromY + 1}`);
        }
        const startY = Math.min(fromY, toY);
        const endY = Math.max(fromY, toY);
        for (let y = startY; y <= endY; y++) {
            this.pathTiles.add(`${midX},${y}`);
            this.pathTiles.add(`${midX + 1},${y}`);
        }
    }

    // v0.61.2 — every lane is laid in the street stone: a path tile is paved
    // (`mainAvenueTiles`) unless it is an unpaved yard's own apron (the Task
    // board's earth, the Forge's cinder, the gravel yards) that no avenue or
    // dock crosses; the ground bake lays those in their yard material. The
    // busy walk (`busyWalkTiles`: avenue and dock routes, the plaza hub,
    // bridges and paved yards) is the authored avenue network, as 3.3 classed
    // it, and alone keeps the trees' clear verge (`_nearMainAvenue`).
    _classifyRoadMaterials(plazaHubX, plazaHubY) {
        for (const key of this.pathTiles) {
            if (this.townSquareTiles.has(key)) continue;
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            const dx = (x - plazaHubX) / 4.2;
            const dy = (y - plazaHubY) / 3.0;
            const nearPlaza = (dx * dx + dy * dy) <= 1.0;
            const material = this.roadMaterialTiles.get(key);
            const yard = this.yardTiles?.get(key);
            const busy = material === 'avenue' || material === 'dock' || nearPlaza
                || this.bridgeTiles?.has(key)
                || Boolean(!material && yard && YARD_MATERIALS[yard]?.paved);
            const unpavedYard = Boolean(yard && YARD_MATERIALS[yard] && !YARD_MATERIALS[yard].paved);
            if (busy) this.busyWalkTiles.add(key);
            if (busy || !unpavedYard) this.mainAvenueTiles.add(key);
            else this.dirtPathTiles.add(key);
        }
    }

    _generateTerrainFeatures() {
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                // The world ash's roots cover its islet: no reeds, stones or
                // flowers there.
                if (this.waterTiles.has(key) || this.sceneryClearTiles.has(key) || this.scenery.isWorldTreeIslet(key)) continue;
                // Low-frequency feature field (2.1): reeds form shoreline beds
                // and stones/mushrooms clump instead of peppering single tiles.
                const noise = this._smoothNoise(x + 41, y + 17, 3.5);
                if (this.shoreTiles.has(key) && noise > 0.46) {
                    this.featureTiles.set(key, 'reeds');
                } else if (noise < 0.045) {
                    this.featureTiles.set(key, 'flowers');
                } else if (noise > 0.948) {
                    this.featureTiles.set(key, 'stones');
                } else if (noise > 0.918 && this._smoothNoise(x - 9, y + 23, 3.5) > 0.62) {
                    this.featureTiles.set(key, 'mushrooms');
                }
            }
        }
    }

    _generateCommandCenterAmbience() {
        const command = this._getCommandBuilding();
        if (!command) return;

        const cx = command.position.tileX;
        const cy = command.position.tileY;
        const w = command.width;
        const h = command.height;

        const southY = cy + h + 0;
        const northY = cy - 1;
        const eastX = cx + w;
        const southGateX = cx + Math.floor(w / 2);

        // Processional approach lanes.
        this._addCommandRoadLine(cx - 7, southY, cx - 1, southY);
        this._addCommandRoadLine(cx - 2, southY, southGateX - 1, southY);
        this._addCommandRoadLine(cx + w - 1, southY + 1, eastX + 6, southY + 1);

        // North-side command lane.
        this._addCommandRoadLine(cx + 1, northY, cx + w + 3, northY);
        this._addCommandRoadLine(cx + w + 3, northY, cx + w + 3, cy + 1);

        // Hard guardrails at the approach mouths and northern shoulder.
        this.commandCenterRoadTiles.add(`${southGateX},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY - 1}`);
    }

    _inMapBounds(tileX, tileY) {
        return tileX >= 0 && tileX <= MAP_SIZE - 1 && tileY >= 0 && tileY <= MAP_SIZE - 1;
    }

    _getCommandBuilding() {
        return this.world.buildings.get('command');
    }

    _addCommandRoadLine(startX, startY, endX, endY) {
        const x1 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(startX)));
        const y1 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(startY)));
        const x2 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(endX)));
        const y2 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(endY)));

        if (x1 === x2) {
            const fromY = Math.min(y1, y2);
            const toY = Math.max(y1, y2);
            for (let y = fromY; y <= toY; y++) {
                this._markCommandRoadTile(x2, y);
                const key = `${x2},${y}`;
                this.pathTiles.add(key);
                this.mainAvenueTiles.add(key);
            }
            return;
        }

        if (y1 === y2) {
            const fromX = Math.min(x1, x2);
            const toX = Math.max(x1, x2);
            for (let x = fromX; x <= toX; x++) {
                this._markCommandRoadTile(x, y1);
                const key = `${x},${y1}`;
                this.pathTiles.add(key);
                this.mainAvenueTiles.add(key);
            }
            return;
        }

        // Diagonal fallback for robustness; keeps intent even if future paths shift.
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(x1 + (x2 - x1) * t);
            const y = Math.round(y1 + (y2 - y1) * t);
            this._markCommandRoadTile(x, y);
            const key = `${x},${y}`;
            this.pathTiles.add(key);
            this.mainAvenueTiles.add(key);
        }
    }

    _markCommandRoadTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return;
        const key = `${tileX},${tileY}`;
        this.commandCenterRoadTiles.add(key);
    }

    _generateAmbientEmitters() {
        const emitters = [
            { tileX: 4.8, tileY: 20.4, particleType: 'sparkle', chance: 0.018 },
            { tileX: 5.8, tileY: 21.2, particleType: 'sparkle', chance: 0.012 },
            { tileX: 28.0, tileY: 29.2, particleType: 'sparkle', chance: 0.016 },
            { tileX: 8.5, tileY: 12.0, particleType: 'sparkle', chance: 0.01 },
            { tileX: 13.4, tileY: 34.3, particleType: 'mineDust', chance: 0.016 },
            { tileX: 27.8, tileY: 29.2, particleType: 'forgeEmber', chance: 0.02 },
            { tileX: 3.4, tileY: 30.6, particleType: 'portalRune', chance: 0.022 },
            { tileX: 22.4, tileY: 33.1, particleType: 'questPing', chance: 0.014 },
            { tileX: 8.5, tileY: 16.8, particleType: 'archiveMote', chance: 0.022 },
            { tileX: 23.4, tileY: 17.8, particleType: 'sparkle', chance: 0.012 },
            { tileX: 32.5, tileY: 16.4, particleType: 'beaconMote', chance: 0.014 },
        ];

        this.ambientEmitters = emitters.map(emitter => ({
            ...emitter,
            ...tileToWorldElevated(emitter.tileX, emitter.tileY),
        }));
    }

    _tileNoise(tileX, tileY) {
        const n = Math.sin(tileX * 12.9898 + tileY * 78.233) * 43758.5453;
        return n - Math.floor(n);
    }

    // Low-frequency value noise in [0, 1]: the per-tile hash sampled on a
    // `scale`-tile lattice, bilinearly interpolated with smoothstep easing.
    // Variation comes out as coherent multi-tile masses instead of per-tile
    // confetti; deterministic and allocation-free, bake/init-side only.
    _smoothNoise(x, y, scale = 6) {
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const n00 = this._tileNoise(x0, y0);
        const n10 = this._tileNoise(x0 + 1, y0);
        const n01 = this._tileNoise(x0, y0 + 1);
        const n11 = this._tileNoise(x0 + 1, y0 + 1);
        const top = n00 + (n10 - n00) * sx;
        const bottom = n01 + (n11 - n01) * sx;
        return top + (bottom - top) * sy;
    }

    _installDebugGlobal(name, value) {
        if (typeof window === 'undefined' || !name) return;
        if (!this._debugGlobals.has(name)) {
            this._debugGlobals.set(name, {
                hadOwn: Object.prototype.hasOwnProperty.call(window, name),
                previous: window[name],
                value,
            });
        } else {
            this._debugGlobals.get(name).value = value;
        }
        if (value && (typeof value === 'object' || typeof value === 'function')) {
            DEBUG_GLOBAL_OWNERS.set(value, this);
        }
        window[name] = value;
    }

    _installFrameHealthHelper() {
        if (typeof window === 'undefined') return;
        if (!this._frameHealthHelper) {
            this._frameHealthHelper = () => this.frameHealth();
        }
        const existing = window.__claudeVillePerf || {};
        if (existing.frameHealth === this._frameHealthHelper) return;
        window.__claudeVillePerf = {
            ...existing,
            frameHealth: this._frameHealthHelper,
        };
    }

    _releaseFrameHealthHelper() {
        if (typeof window === 'undefined') return;
        const perf = window.__claudeVillePerf;
        if (!perf || perf.frameHealth !== this._frameHealthHelper) return;
        delete perf.frameHealth;
    }

    _releaseDebugGlobals() {
        if (typeof window === 'undefined') {
            this._debugGlobals.clear();
            return;
        }
        for (const [name, entry] of this._debugGlobals) {
            if (window[name] !== entry.value) continue;
            const previousOwner = entry.previous && (typeof entry.previous === 'object' || typeof entry.previous === 'function')
                ? DEBUG_GLOBAL_OWNERS.get(entry.previous)
                : null;
            if (entry.hadOwn && (!previousOwner || previousOwner.running)) window[name] = entry.previous;
            else delete window[name];
        }
        this._debugGlobals.clear();
    }

    /**
     * Stage B — start resolving the WebGPU world for `search` now (App calls
     * this as soon as the module loads, beside the asset fetch). A no-op when
     * the search does not want WebGPU (`shouldProbeWebGpu`: `?renderer=webgpu`,
     * or no forced mode in a Chromium browser with `navigator.gpu` and a
     * hardware WebGL2 rasterizer). Returns whether a resolution is running.
     */
    static prewarmBackend(search = globalThis.location?.search || '') {
        const key = String(search || '');
        if (earlyWebGpu?.search === key) return true;
        releaseWebGpuWorld(earlyWebGpu?.entry);
        earlyWebGpu = null;
        if (!wantsWebGpu(new URLSearchParams(key))) return false;
        earlyWebGpu = { search: key, entry: resolveWebGpuWorld() };
        return true;
    }

    /**
     * Wave 10 (contract §4.1, §8.1) — the async half of backend selection,
     * awaited by App before the synchronous `show()`. It takes over the
     * `prewarmBackend` resolution (or starts one). `?renderer=webgpu` waits
     * for it; the default takes it only when it has already settled, else
     * `show()` mounts WebGL2 and switches once it is ready. Any failure is a
     * resolved `{ available: false, reason }`, never a throw, and `show()`
     * takes WebGL2 (a fallback adapter takes Canvas).
     */
    async resolveBackend(search = window.location.search) {
        this.releaseResolvedBackend();
        const key = String(search || '');
        IsometricRenderer.prewarmBackend(key);
        const entry = earlyWebGpu?.search === key ? earlyWebGpu.entry : null;
        earlyWebGpu = null;
        if (!entry) return null;
        if (forcedGpuWorldRendererMode(new URLSearchParams(key)) === 'webgpu') await entry.promise;
        if (entry.settled) {
            this._resolvedBackend = entry.value;
            return entry.value;
        }
        this._pendingWebGpu = entry;
        return { available: false, pending: true, reason: 'compiling' };
    }

    releaseResolvedBackend() {
        this._resolvedBackend?.device?.destroy?.();
        this._resolvedBackend = null;
        releaseWebGpuWorld(this._pendingWebGpu);
        this._pendingWebGpu = null;
    }

    // §8.1 — `worldBackendReason` (Shift-D, diagnostics) and one console line
    // naming the World backend and why, so a field report is diagnosable;
    // `worldBackendNotes` holds the same parts for Shift-D's rows. A session
    // note (`_backendSessionNote`: the GPU-crash Canvas policy) belongs to the
    // selection, not to either backend's outcome.
    _noteWorldBackend(webgpuNote) {
        const { forced = null, postFxEnabled = true, webglNote = 'not probed' } = this._backendSelection || {};
        const selection = `${forced ? `?renderer=${forced}` : 'default'}${postFxEnabled ? '' : ' ?postfx=0'}`;
        const session = this._backendSessionNote || null;
        this.worldBackendNotes = { selection, session, webgpu: String(webgpuNote), webgl2: webglNote };
        this.worldBackendReason = `${selection}${session ? ` (${session})` : ''} · webgpu ${webgpuNote} · webgl2 ${webglNote}`;
        console.info(`[IsometricRenderer] world backend: ${this.worldRendererMode} (${this.worldBackendReason})`);
    }

    // Stage B — the WebGPU world finished compiling after a WebGL2 mount:
    // build it on a fresh fx canvas (off the document) and hand it to the
    // loop, which swaps it in at a frame boundary (`_beginWorldSwap`).
    _queueWebGpuSwitch(entry) {
        this._pendingWebGpu = entry;
        entry.promise.then((prepared) => {
            if (this._pendingWebGpu !== entry) {
                prepared?.device?.destroy?.();
                return;
            }
            this._pendingWebGpu = null;
            if (!prepared?.available || !this.running || this._disposed || this.worldRendererMode !== 'webgl' || !this.fxCanvas) {
                prepared?.device?.destroy?.();
                if (this.running && this.worldRendererMode === 'webgl') this._noteWorldBackend(`unavailable: ${prepared?.reason || 'renderer changed'}`);
                return;
            }
            const canvas = this.fxCanvas.cloneNode(false);
            const next = prepared.create({ canvas, enabled: true, device: prepared.device, adapter: prepared.adapter, pipelines: prepared.pipelines });
            if (!next?.isActive?.()) {
                next?.dispose?.();
                prepared.device?.destroy?.();
                this._noteWorldBackend('failed to start');
                return;
            }
            this._worldSwap = { gpuWorld: next, canvas, previous: null };
            this._invalidateIdleFrame();
        });
    }

    // The swap waits for a healthy WebGL2 world and no armed first-frame
    // signal (the reveal samples the fx canvas it presented). The frame then
    // renders on the WebGPU world; `_endWorldSwap` keeps it only if it drew.
    // The WebGPU ladder starts at the level WebGL2 shows (and any override):
    // a fresh ladder would open at MINIMAL while it latches, a visible drop.
    // A fallback swap (`_fallBackFromWebGpu`) runs the other way, from a
    // failed (inactive) WebGPU world to a fresh WebGL2 one, and runs on an
    // armed first frame too: that frame's reveal then samples the WebGL2
    // canvas it drew, never a Canvas-world frame of the failed one.
    _beginWorldSwap() {
        const swap = this._worldSwap;
        if (!swap || (this._firstFrameReason && !swap.fallback) || !this.gpuWorld) return null;
        if (!swap.fallback && !this.gpuWorld.isActive?.()) return null;
        this._worldSwap = null;
        swap.previous = this.gpuWorld;
        swap.gpuWorld.resize?.(swap.previous.width, swap.previous.height);
        // Both backends keep the same fall history even if the swap frame is retried.
        if (swap.previous._rain && swap.gpuWorld._rain) swap.gpuWorld._rain.motion = swap.previous._rain.motion;
        const ladder = swap.previous.qualityLadder?.getState?.();
        if (ladder && swap.gpuWorld.qualityLadder) {
            swap.gpuWorld.qualityLadder.reset(ladder.level);
            if (ladder.override != null) swap.gpuWorld.qualityLadder.setOverride(ladder.override);
        }
        this.gpuWorld = swap.gpuWorld;
        this.worldRendererMode = swap.gpuWorld.backend || 'webgl';
        this._applyDisplayColor();
        return swap;
    }

    _endWorldSwap(swap) {
        const next = swap.gpuWorld;
        if (this.gpuWorld === next && next.isActive?.() && next.frames > 0) {
            // The frame drew on the new canvas in this task: it replaces the
            // old canvas before the page presents, so no frame is skipped.
            this._replaceFxCanvas(swap.canvas);
            this._postFxCanvasVisible = null;
            this._setPostFxCanvasVisible(true);
            swap.previous.dispose?.();
            this._noteWorldBackend(swap.fallback || 'ready (switched from WebGL2 after compiling)');
            return;
        }
        // Not drawn (a Canvas-required frame, or a failure): this frame's
        // Canvas fallback stands and the previous world resumes (a failed
        // WebGPU one stays inactive, so Canvas draws); a healthy next world
        // retries on the next frame.
        if (this.gpuWorld === next) {
            this.gpuWorld = swap.previous;
            this.worldRendererMode = swap.previous.backend || 'webgl';
            this._applyDisplayColor();
        }
        if (next.isActive?.() && this.running && this.gpuWorld === swap.previous) {
            this._worldSwap = { gpuWorld: next, canvas: swap.canvas, previous: null, fallback: swap.fallback };
            return;
        }
        next.dispose?.();
        if (!this.running) return;
        if (swap.fallback && this.gpuWorld === swap.previous) this._dropToCanvasWorld(`${swap.fallback} · WebGL2 fallback failed`);
        else if (!swap.fallback) this._noteWorldBackend('failed to start');
    }

    // An unrecoverable WebGPU world (its `failure`: a frame exception, a
    // validation or out-of-memory error in its frame scope, a destroyed
    // device, a failed rebuild) swaps in reverse to a fresh WebGL2 world on
    // a cloned fx canvas (without WebGL2, the Canvas world for the session).
    // An asynchronous failure, found at a frame's start, left the last good
    // frame presented: the loop holds it (draws nothing) while idle tasks
    // build the WebGL2 world, re-bake the terrain canvas and draw the swap
    // frame (`_stepFallbackPrep`, through `renderNow`), so no loop frame
    // carries that work and the camera resumes with an ordinary step. A frame
    // exception (`inFrame`) left a broken frame in this task: the fallback
    // resolves now and `_loop` renders that frame again in the same task.
    _fallBackFromWebGpu({ inFrame = false } = {}) {
        const failure = this.gpuWorld?.failure;
        if (!failure || this.worldRendererMode !== 'webgpu' || this._worldSwap || this._fallbackPrep || !this.fxCanvas) return;
        const prep = {
            note: `failed in frame: ${failure.summary}`,
            failed: this.gpuWorld,
            stage: 'build',
            startedAt: performance.now(),
            canvas: null,
            next: null,
        };
        this._fallbackPrep = prep;
        try {
            if (inFrame) this._stepFallbackPrep({ now: true });
            else whenIdle(() => this._stepFallbackPrep({ prep }));
        } catch (error) {
            this._failFallbackPrep(prep, error);
        }
    }

    // One idle step of the pending fallback: build the WebGL2 world; re-bake
    // the terrain canvas it uploads; arm the swap and draw it (`renderNow`).
    // `now` (a frame exception, or `renderNow` drawing during the hold) builds
    // and arms in this task and leaves the bake to the frame about to draw.
    // A World that stopped, left for Dashboard or changed world meanwhile
    // drops the pending fallback; the next frame starts it again.
    _stepFallbackPrep({ now = false, prep = this._fallbackPrep } = {}) {
        if (!prep || prep !== this._fallbackPrep) return;
        try {
            if (
                !this.running
                || this._disposed
                || !this._worldModeActive
                || this._worldResourcesSuspended
                || this._contextLost
                || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
                || this.gpuWorld !== prep.failed
            ) {
                this._cancelFallbackPrep();
                return;
            }
            if (performance.now() - prep.startedAt >= WORLD_FALLBACK_PREP_TIMEOUT_MS) {
                throw new Error('World fallback preparation exceeded its 5 s frame hold');
            }
            if (prep.stage === 'build') {
                prep.canvas = this.fxCanvas.cloneNode(false);
                prep.next = createGpuWorldRenderer({ canvas: prep.canvas, enabled: true });
                prep.stage = 'bake';
                if (!now) {
                    whenIdle(() => this._stepFallbackPrep({ prep }));
                    return;
                }
            } else if (prep.stage === 'bake' && !now) {
                this._getTerrainCache();
                prep.stage = 'swap';
                whenIdle(() => this._stepFallbackPrep({ prep }));
                return;
            }
            if (prep.next?.isActive?.()) {
                this._worldSwap = { gpuWorld: prep.next, canvas: prep.canvas, previous: null, fallback: prep.note };
                this._fallbackPrep = null;
            } else {
                this._cancelFallbackPrep();
                this._dropToCanvasWorld(`${prep.note} · WebGL2 unavailable`);
            }
            this._invalidateIdleFrame();
            if (now) return;
            // A hold is not a motion interval; resume with an ordinary step.
            this._lastFrameTime = null;
            this.renderNow();
        } catch (error) {
            this._failFallbackPrep(prep, error);
        }
    }

    _failFallbackPrep(prep, error) {
        if (this._fallbackPrep === prep) this._fallbackPrep = null;
        if (this._worldSwap?.gpuWorld === prep.next) this._worldSwap = null;
        try {
            prep.next?.dispose?.();
        } catch (disposeError) {
            this._reportFrameFailure(disposeError, 'fallback-dispose');
        }
        prep.next = null;
        this._reportFrameFailure(error, `fallback-${prep.stage}`);
        try {
            this._dropToCanvasWorld(`${prep.note} · ${error?.message || error} · Canvas recovery`);
        } catch (recoveryError) {
            this._reportFrameFailure(recoveryError, 'fallback-canvas');
        } finally {
            this._lastFrameTime = null;
            this._invalidateIdleFrame();
            this._startLoop();
        }
    }

    _cancelFallbackPrep() {
        const prep = this._fallbackPrep;
        this._fallbackPrep = null;
        const next = prep?.next;
        if (prep) prep.next = null;
        next?.dispose?.();
    }

    // The Canvas world for the rest of the session (no GPU world at all).
    _dropToCanvasWorld(note) {
        const prep = this._fallbackPrep;
        const swap = this._worldSwap;
        const previous = this.gpuWorld;
        this._fallbackPrep = null;
        this._worldSwap = null;
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this._postFxCanvasVisible = null;
        try {
            this._setPostFxCanvasVisible(false);
            this._applyDisplayColor();
            this._noteWorldBackend(note);
        } finally {
            try {
                prep?.next?.dispose?.();
            } finally {
                try {
                    swap?.gpuWorld?.dispose?.();
                } finally {
                    previous?.dispose?.();
                }
            }
        }
    }

    // Every #worldFxCanvas replacement goes through here: the new element
    // takes the live one's CSS box and App's resize bookkeeping (a resize
    // since the clone would otherwise leave it at a stale box), and App's
    // resize resolves the surfaces from the DOM, so later resizes reach it.
    _replaceFxCanvas(next) {
        const current = this.fxCanvas;
        if (!current || !next || current === next) return;
        next.style.width = current.style.width;
        next.style.height = current.style.height;
        next._claudeVilleDpr = current._claudeVilleDpr;
        next._claudeVilleCssWidth = current._claudeVilleCssWidth;
        next._claudeVilleCssHeight = current._claudeVilleCssHeight;
        current.replaceWith(next);
        this.fxCanvas = next;
    }

    show(canvas) {
        if (this._disposed) {
            console.warn('[IsometricRenderer] show skipped: renderer is disposed');
            return false;
        }
        if (!canvas || typeof canvas.getContext !== 'function') {
            console.warn('[IsometricRenderer] show skipped: invalid canvas element');
            return false;
        }
        if (this.running) {
            return true;
        }

        this.canvas = canvas;
        this.fxCanvas = canvas.parentElement?.querySelector?.('#worldFxCanvas') || null;
        this.overlayCanvas = canvas.parentElement?.querySelector?.('#worldOverlayCanvas') || null;
        // alpha:false matches App.js resize; the sky pass repaints the full
        // viewport opaquely every frame (context attributes are fixed by the
        // first getContext call, so every main-canvas site must agree).
        this.ctx = canvas.getContext('2d', { alpha: false });
        if (!this.ctx) {
            console.warn('[IsometricRenderer] show skipped: failed to get 2d context');
            return false;
        }
        this._resizeAuxiliaryBackingStores(canvas.width, canvas.height);
        if (!this.overlayCtx) {
            console.warn('[IsometricRenderer] show skipped: failed to get overlay 2d context');
            return false;
        }
        // The parity, lifecycle, memory, and reference-hardware gates promote
        // the GPU-resident diorama to the default on a hardware rasterizer; a
        // software one (SwiftShader, llvmpipe) takes the Canvas world.
        // Stage B: a Chromium browser takes WebGPU when `resolveBackend` had
        // its adapter, device and pipelines (still compiling: WebGL2 now, and
        // the switch once ready); Safari and Firefox take WebGL2.
        // `?renderer=canvas` keeps the production fallback, `?renderer=webgl`
        // forces WebGL2 and `?renderer=webgpu` WebGPU (only these skip the
        // probe; an empty or unknown value probes like no parameter), and
        // `?postfx=0` is the allocation-free escape. Any WebGPU failure
        // before or at this synchronous mount lands on WebGL2 first.
        const params = new URLSearchParams(window.location.search);
        const postFxEnabled = params.get('postfx') !== '0';
        const forced = forcedGpuWorldRendererMode(params);
        const chromium = isChromiumBrowser(globalThis.navigator);
        const webgpu = this._resolvedBackend;
        const pendingWebGpu = this._pendingWebGpu;
        this._resolvedBackend = null;
        this._pendingWebGpu = null;
        const raster = forced ? { webgl2: true, softwareRaster: false } : probeWebgl2Raster();
        const requestedMode = resolveGpuWorldRendererMode(params, {
            ...raster,
            webgpu: webgpu?.available === true,
            webgpuSoftware: webgpu?.isFallbackAdapter === true,
            chromium,
        });
        this.gpuWorld = null;
        let webgpuStartFailed = false;
        if (postFxEnabled && requestedMode === 'webgpu' && this.fxCanvas) {
            this.gpuWorld = webgpu.create({ canvas: this.fxCanvas, enabled: true, device: webgpu.device, adapter: webgpu.adapter, pipelines: webgpu.pipelines });
            if (!this.gpuWorld?.isActive?.()) {
                // The canvas already holds a WebGPU context: WebGL2 needs a
                // fresh element in its place.
                console.warn('[IsometricRenderer] WebGPU world failed to start; falling back to WebGL2');
                webgpuStartFailed = true;
                this.gpuWorld?.dispose?.();
                this.gpuWorld = null;
                this._replaceFxCanvas(this.fxCanvas.cloneNode(false));
            }
        } else {
            webgpu?.device?.destroy?.();
        }
        if (!this.gpuWorld && postFxEnabled && (requestedMode === 'webgl' || requestedMode === 'webgpu') && this.fxCanvas) {
            this.gpuWorld = createGpuWorldRenderer({ canvas: this.fxCanvas, enabled: true });
        }
        this.worldRendererMode = this.gpuWorld?.isActive?.() ? (this.gpuWorld.backend || 'webgl') : 'canvas';
        const switchLater = Boolean(pendingWebGpu) && this.worldRendererMode === 'webgl';
        if (pendingWebGpu && !switchLater) releaseWebGpuWorld(pendingWebGpu);
        // §8.1 — one console line naming the backend and why (field reports).
        let webgpuNote = chromium ? 'not requested' : 'not requested (not Chromium)';
        if (chromium && !forced && !raster.softwareRaster && knownNoWebGpuAdapter()) webgpuNote = 'not requested (no adapter on a recent boot)';
        if (webgpuStartFailed) webgpuNote = 'failed to start';
        else if (switchLater) webgpuNote = 'compiling (switches when ready)';
        else if (webgpu) webgpuNote = webgpu.available ? 'ready' : `unavailable: ${webgpu.reason}`;
        this._backendSelection = {
            forced,
            postFxEnabled,
            webglNote: forced ? 'not probed' : (raster.webgl2 ? (raster.softwareRaster ? 'software' : 'hardware') : 'none'),
        };
        this._noteWorldBackend(webgpuNote);
        if (switchLater) this._queueWebGpuSwitch(pendingWebGpu);
        this._applyDisplayColor();
        this.postFx = (!this.gpuWorld && postFxEnabled && this.fxCanvas)
            ? createPostFx({ canvas: this.fxCanvas, enabled: true })
            : null;
        this.postFxFeed = createPostFxFeed();
        this.postFx?.resize?.(canvas.width, canvas.height);
        this.gpuWorld?.resize?.(canvas.width, canvas.height);
        for (const sprite of this.agentSprites.values()) {
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
        }
        this._postFxCanvasVisible = null;
        this._setPostFxCanvasVisible(
            this.gpuWorld?.isActive?.() === true || this.postFx?.isActive?.() === true,
        );
        if (!this.villageDirector) {
            this.villageDirector = new VillageDirector(this.world);
            this.villageDirector.setMotionScale?.(this.motionScale);
            if (this.quotaState) this.villageDirector.setQuotaState?.(this.quotaState);
        }
        this._ensureTrailRenderer();
        this._contextLost = false;
        this.camera = new Camera(canvas);
        // 4.2 — automatic shots keep landmark silhouettes and their plates
        // clear of the frame's top edge and reserved chrome.
        this.camera.setSpriteMetrics((id) => (this.assets ? { dims: this.assets.getDims(id), anchor: this.assets.getAnchor(id), mask: this.assets.getMask?.(id) } : null));
        this.camera.attach();
        // WeatherRenderer draws the foreground weather on the overlay canvas
        // that sits above both Canvas and GPU world bases. The camera anchors
        // its world-locked layers and phases its cells to the art grid.
        this.weatherRenderer?.setSceneContext?.({
            camera: this.camera,
            // 6.7 — open ground the overlay may splash rain on (no building
            // art covers it); static per village, classified once.
            openGroundTiles: () => openGroundTiles(this),
            // W2.3 — baked puddle sites for 2-frame concentric rain rings.
            groundWeatherField: () => this.groundField?.weather || null,
            groundPuddleMask: () => this.groundPuddleMask || null,
            // W2-Fix-B — rings appear only where the ground history has
            // standing water (the same level the resident puddle courses
            // draw); dry ground under the first drops stays ringless.
            puddleLevel: () => this._groundState?.puddles ?? 0,
        });
        // #21 — cinematic director listens for VillageDirector camera cues and
        // drives time-boxed glides on the camera (abort-on-input is in Camera).
        this.cameraDirector?.dispose?.();
        this.stripProfile = document.documentElement?.dataset?.cvProfile === 'strip';
        this.cameraDirector = new CameraDirector(this.camera, { motionScale: this.motionScale, stripProfile: this.stripProfile });
        this.inspectionGlass = new InspectionGlass({ enabled: readGlassSetting() === 'on' });
        this.councilRibbon = new CouncilRibbon();
        this.signageMode = readSignageMode();
        this.buildingRenderer?.setSignageMode?.(this.signageMode);
        this.buildingRenderer?.setTheatreMode?.(Boolean(this.theatreMode));
        this.harborTraffic?.setTheatreMode?.(Boolean(this.theatreMode));
        // #attract — idle attract camera defaults on; honor the persisted toggle.
        let autoCam = true;
        try { autoCam = window.localStorage?.getItem('cv-auto-camera') !== '0'; } catch (_) { /* storage unavailable */ }
        this.cameraDirector.setAutoMode(autoCam);
        this._bindMotionPreference();
        this._setMotionScale(this.motionQuery?.matches ? 0 : 1);
        this.atmosphereState?.installDebugHelper?.();
        if (!this.ritualConductor) {
            this.ritualConductor = new RitualConductor({ motionScale: this.motionScale });
        }

        this.buildingRenderer?.setBuildings(this.world.buildings);
        this.buildingRenderer?.setRitualConductor?.(this.ritualConductor);

        // Create sprites for existing agents
        const initialSubagents = [];
        this._deferPortalRelease = true;
        for (const agent of this.world.agents.values()) {
            this._addAgentSprite(agent);
            if (agent?.parentSessionId || agent?.parentId || agent?.parentAgentId) {
                const sprite = this.agentSprites.get(agent.id);
                if (sprite) initialSubagents.push(sprite);
            }
        }
        this._deferPortalRelease = false;
        this._syncRitualContext();

        this.agentEventStream?.dispose?.();
        this.relationshipState?.dispose?.();
        this.agentEventStream = new AgentEventStream(this.world, {
            shouldEmitToolEvent: (event, agent) => this._canAcceptToolRitual(event, agent),
            shouldEmitEvent: () => this._worldModeActive,
        });
        // D7 — seated and waiting squadmates face a celebrating villager.
        this._unbindSquadNotice?.();
        this._unbindSquadNotice = bindSquadNotice(() => this.agentSprites);
        this._unbindVerifiedOutcomes?.();
        this._unbindVerifiedOutcomes = eventBus.on(VERIFIED_OUTCOME_EVENT, (outcome) => {
            if (!outcome?.agentId) return;
            const sprite = this.agentSprites.get(String(outcome.agentId));
            sprite?.observeVerifiedOutcome?.(outcome);
        });
        this.relationshipState = new RelationshipState(this.world);
        this._replayActiveToolRituals({ force: true });
        this._updateVisitSystems(Date.now());
        this._coldPortalSettled = this.world.agents.size > 0;
        if (initialSubagents.length > PORTAL_COLD_SETTLE_LIMIT && !this.replay?.recorded) {
            this._settlePortalColdBurst(initialSubagents);
        } else {
            this._releasePortalEntries();
        }
        this._installDebugGlobal('__relationshipState', () => this.relationshipState?.getSnapshot?.());
        this._installDebugGlobal('__visitIntents', () => this.visitIntentManager?.debugSnapshot?.() || null);
        this._installDebugGlobal('__visitReservations', () => this.visitTileAllocator?.debug?.() || null);
        this._installDebugGlobal('__agentBehavior', (agentId) => this.agentSprites.get(agentId)?.getBehaviorDebugSnapshot?.() || null);
        this._installDebugGlobal('__buildingCrowds', () => this.visitTileAllocator?.getBuildingLoads?.() || {});
        this._installDebugGlobal('__agentBehaviorStats', () => this._agentBehaviorStats());
        this._installDebugGlobal('__agentCrowds', () => this._crowdStats || this._summarizeCrowdClusters());
        this._installDebugGlobal('__villageDirector', () => this.villageDirector?.getSnapshot?.() || null);
        this._installDebugGlobal('__worldPerformance', () => this.getWorldPerformanceDiagnostics());
        this._installFrameHealthHelper();

        // Subscribe to domain events
        this._unsubscribers.push(
            eventBus.on('audio:evensong', ({ active }) => {
                this._evensongActive = Boolean(active);
                this._invalidateIdleFrame();
            }),
            eventBus.on('agent:added', (agent) => {
                if (!this._worldModeActive || this._visibilityPaused) {
                    this._worldSpritesDirty = true;
                    return;
                }
                this._addAgentSprite(agent);
                this._beginRelationshipArrival(agent);
            }),
            eventBus.on('agent:removed', (agent) => {
                if (!this._worldModeActive || this._visibilityPaused) {
                    this._removeAgentSprite(agent.id);
                    this._worldSpritesDirty = true;
                    return;
                }
                // The sprite usually left the moment the agent departed
                // (agent:updated); this only catches one that never did.
                this._beginAgentDeparture(agent);
            }),
            eventBus.on('agent:updated', (agent) => {
                if (!this._worldModeActive || this._visibilityPaused) {
                    const sprite = this.agentSprites.get(agent.id);
                    if (sprite?.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                    else if (sprite) sprite.agent = agent;
                    // VB-4 — a hidden tab draws no walk-out: the villager
                    // leaves now instead of parading out when the tab returns.
                    if (sprite && agent.isDeparted && this._visibilityPaused) this._removeAgentSprite(agent.id);
                    this._worldSpritesDirty = true;
                    return;
                }
                const sprite = this.agentSprites.get(agent.id);
                if (!sprite) {
                    // The villager already walked out but its session came
                    // back inside the departed grace: it arrives again.
                    if (agent.isDeparted) return;
                    this._addAgentSprite(agent);
                    this._beginRelationshipArrival(agent);
                    return;
                }
                if (sprite.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                else sprite.agent = agent;
                this._markSpritesDirty();
                if (agent.isDeparted) {
                    // No lingering ghost: a departed villager leaves at once.
                    this._beginAgentDeparture(agent);
                } else if (this._isGateTransit(sprite, 'departure')) {
                    // Session returned mid-exit: turn around at the gate.
                    this._returnFromGateDeparture(agent, sprite);
                }
            }),
            eventBus.on('subagent:dispatched', (payload) => {
                this._invalidateIdleFrame();
                this._enqueueSubagentSummonRitual(payload);
            }),
            // Presence changes move plaques and the building's work tier
            // (BuildingSprite reads the payload itself): wake an idle frame.
            eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, (payload) => {
                if (!payload) return;
                this._invalidateIdleFrame();
            }),
            eventBus.on(BUILDING_EVENTS.SELECTED, () => this._invalidateIdleFrame()),
            eventBus.on(BUILDING_EVENTS.DESELECTED, () => this._invalidateIdleFrame()),
            // U-P3 — a Harbor ledger row (sidebar, building panel) focuses
            // its fleet and opens the fleet card. The World may be coming
            // back from the Dashboard this task, so wait one frame.
            eventBus.on(HARBOR_FOCUS_FLEET_EVENT, (query) => {
                if (!query?.project) return;
                requestAnimationFrame(() => {
                    if (this._disposed) return;
                    this._focusFleet(query);
                });
            }),
            // #attract — topbar toggle flips the idle-attract camera live.
            eventBus.on('camera:auto-camera', (payload) => this.cameraDirector?.setAutoMode?.(payload?.enabled !== false)),
            // 10.2 / 10.3 — SET's HDR highlights and the screen's media
            // queries (a window moved to or from an HDR / P3 screen).
            eventBus.on(SIGNAGE_EVENT, ({ mode }) => {
                this.signageMode = mode;
                this.buildingRenderer?.setSignageMode?.(mode);
                this._invalidateIdleFrame();
            }),
            eventBus.on(GLASS_EVENT, ({ mode }) => {
                this.inspectionGlass.setEnabled(mode === 'on');
                eventBus.emit('world:glass-armed', this.inspectionGlass.armed);
                this._invalidateIdleFrame();
            }),
            eventBus.on('world:read-unlock', () => this.setReadLock(false)),
            eventBus.on('world:glass-arm', () => eventBus.emit('world:glass-armed', this.inspectionGlass.toggleArmed())),
            eventBus.on(HDR_HIGHLIGHTS_EVENT, () => this._applyDisplayColor()),
            watchDisplayMedia(() => this._applyDisplayColor()),
            // 4.8 — earned nicknames & W3-D earned patina garnish agent sprites/benches.
            eventBus.on('biography:updated', (payload) => {
                const identityKey = payload?.identityKey;
                if (!identityKey) return;
                this._invalidateIdleFrame();
                const nickname = payload?.biography?.nickname || null;
                this._cacheNickname(identityKey, nickname);
                this._cachePatina(identityKey, payload?.biography || null);
                this._applyNicknames();
            }),
        );

        // Cross-tab nickname refresh: when another tab persists a biography,
        // AgentBiographyService drops its cached copy first (it registered on
        // the channel earlier), so this re-read sees the fresh record.
        if (this.biographyService && this.chronicleStore?.channel?.addEventListener) {
            this._chronicleChannelListener = (event) => {
                const identityKey = event?.data?.identityKey;
                if (this._disposed || event?.data?.type !== 'biography-updated' || !identityKey) return;
                const biographyService = this.biographyService;
                const generation = this._biographyReadGeneration;
                biographyService.getBiography(identityKey).then((biography) => {
                    if (this._disposed || generation !== this._biographyReadGeneration) return;
                    const nickname = biography?.nickname || null;
                    this._cacheNickname(identityKey, nickname);
                    this._cachePatina(identityKey, biography || null);
                    this._applyNicknames();
                    this._invalidateIdleFrame();
                }).catch(() => {});
            };
            this.chronicleStore.channel.addEventListener('message', this._chronicleChannelListener);
        }

        // Click handler for agent selection
        this._onClick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            if (this.councilRibbon?.onClick(screenX, screenY, id => this.frameWorldAgent(id))) return;
            if (this.stripProfile && this._showTouchInfo(e.clientX, e.clientY)) return;
            this._handleClick(worldPos.x, worldPos.y, e.pointerType
                ? e.pointerType !== 'mouse'
                : e.sourceCapabilities?.firesTouchEvents === true);
        };
        canvas.addEventListener('click', this._onClick);

        // Hover handler for buildings + agents. 3.7 — the agent half is a
        // per-pixel hit-test, so it is rAF-throttled to at most one sweep per
        // frame; scalar fields avoid a per-mousemove allocation.
        this._hoveredAgentSprite = null;
        this._agentHoverRafId = null;
        this._agentHoverX = 0;
        this._agentHoverY = 0;
        this._onMouseMoveMain = (e) => {
            this._invalidateIdleFrame();
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            // XP-4 — the lore waits for the agent pass, which picks the plate's
            // text once per frame (a villager wins over the scenery).
            this._hoverLore = this._worldHoverInfo(worldPos.x, worldPos.y);
            this._hoverPoint = { x: screenX, y: screenY };
            this._scheduleAgentHoverTest(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);
        // FP-1b — any pointer input holds 60 fps for a second.
        this._onPointerInputMain = event => {
            this._pointerInputAt = performance.now();
            const glass = this.inspectionGlass;
            if (event.type === 'wheel') return;
            const mouseMove = event.type === 'pointermove' && event.pointerType === 'mouse';
            if (!glass.enabled && !mouseMove) return;
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            if (event.type === 'pointerdown') glass.onPointerDown(x, y, event);
            if (event.type === 'pointermove' && glass.onPointerMove(x, y, event)) {
                // Keep Camera's contact current for a second finger, without panning on the first.
                const contact = this.camera._touchPointers.get(event.pointerId);
                if (contact) Object.assign(contact, { x: event.clientX, y: event.clientY });
                this.camera._clearTouchHold();
                if (this.camera._touchGesture) this.camera._touchGesture.consumed = true;
                event.stopImmediatePropagation();
            }
            if (event.type === 'pointerup' || event.type === 'pointercancel') glass.onPointerUp(x, y, event);
            this._invalidateIdleFrame();
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
            canvas.addEventListener(type, this._onPointerInputMain, { passive: true, capture: true });
        }
        this._onMouseLeaveMain = () => {
            if (this._agentHoverRafId !== null) {
                cancelAnimationFrame(this._agentHoverRafId);
                this._agentHoverRafId = null;
            }
            this._setHoveredAgentSprite(null);
            this.buildingRenderer?.setHovered(null);
            this.villageDirector?.setHoveredBuilding?.(null);
            this.harborTraffic?.setHoveredShip?.(null);
            this.bridgeLanterns?.setHovered?.(null);
            this._hoverLore = null;
            this._hoverPoint = null;
            this._hoverPlate?.hide();
        };
        canvas.addEventListener('mouseleave', this._onMouseLeaveMain);
        this.camera.onTouchStart = this._onMouseLeaveMain;
        this.camera.onTouchLongPress = (x, y) => this._showTouchInfo(x, y);
        this.camera.onTouchDismiss = () => this._dismissTouchInfo();
        this._onKeyDown = (e) => {
            this._handleDebugShortcut(e);
            this._handleWorldKeyboardCommand(e);
        };
        window.addEventListener('keydown', this._onKeyDown);
        this._onReadKeyUp = event => this._releaseWorldKeys(event);
        this._onReadBlur = () => this._releaseWorldKeys();
        window.addEventListener('keyup', this._onReadKeyUp);
        window.addEventListener('blur', this._onReadBlur);
        this._onModeChanged = (mode) => this.setWorldModeActive(mode !== 'dashboard');
        this._unsubscribers.push(eventBus.on('mode:changed', this._onModeChanged));

        const whisper = document.getElementById('theatreWhisper');
        const enter = () => this._scheduleWhisper(true, 150);
        const leave = () => this._scheduleWhisper(false, 1500);
        whisper?.addEventListener('pointerenter', enter);
        whisper?.addEventListener('pointerleave', leave);
        this._unsubscribers.push(() => {
            whisper?.removeEventListener('pointerenter', enter);
            whisper?.removeEventListener('pointerleave', leave);
        });
        this.running = true;
        this._startLoop();
        return true;
    }

    _handleDebugShortcut(event, { doc } = {}) {
        if (!event || !this._worldModeActive) return false;
        if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        if (shortcutBlocked(event, doc ? { doc } : undefined)) return false;
        if (event.code === 'KeyD') {
            void this._toggleDebugOverlay('toggle');
            return true;
        }
        if (event.code === 'KeyO') {
            void this._toggleDebugOverlay('togglePathDebug');
            return true;
        }
        return false;
    }

    setReadMode(on) {
        const next = Boolean(on);
        if (this._readMode === next) return;
        this._readMode = next;
        this._invalidateIdleFrame();
    }

    getReadMode() {
        return !postcardFrame() && Boolean(this._readMode || this._readLocked);
    }

    _releaseWorldKeys(event) {
        if (!event || event.code === 'KeyB') this.setReadMode(false);
        if (!event) this.inspectionGlass?.onBlur();
        else if (!this.inspectionGlass?.onKeyUp(event)) return;
        this._invalidateIdleFrame();
    }

    setReadLock(locked) {
        this._readLocked = Boolean(locked);
        this.setReadMode(false);
        eventBus.emit('world:read-lock', this._readLocked);
        this._invalidateIdleFrame();
    }

    _scheduleWhisper(visible, delay) {
        clearTimeout(this._whisperTimer);
        this._whisperTimer = setTimeout(() => {
            document.getElementById('theatreWhisper')?.toggleAttribute('data-visible', visible);
        }, delay);
    }

    setTheatreMode(active, instant = false) {
        const root = globalThis.document?.documentElement;
        if (!root || (!active && !root.dataset.cvTheatre && !this.theatreMode)) return;
        this._endTheatreTransition?.();
        this.theatreMode = Boolean(active);
        this.buildingRenderer?.setTheatreMode?.(this.theatreMode);
        this.harborTraffic?.setTheatreMode?.(this.theatreMode);
        const whisper = document.getElementById('theatreWhisper');
        clearTimeout(this._whisperTimer);
        whisper?.toggleAttribute('data-visible', active);
        if (active) {
            this.setReadLock(false);
            this._scheduleWhisper(false, 4000);
        }
        const bar = document.getElementById('topbar');
        const settle = () => {
            this._endTheatreTransition?.();
            if (active) root.dataset.cvTheatre = 'settled';
            else delete root.dataset.cvTheatre;
        };
        if (instant || this.motionScale === 0) settle();
        else {
            root.dataset.cvTheatre = 'leaving';
            if (!active) {
                bar?.getBoundingClientRect();
                root.dataset.cvTheatre = 'returning';
            }
            const ended = event => {
                if (event.target === bar && event.propertyName === 'transform') settle();
            };
            const timer = setTimeout(settle, 140);
            bar?.addEventListener('transitionend', ended);
            this._endTheatreTransition = () => {
                clearTimeout(timer);
                bar?.removeEventListener('transitionend', ended);
                this._endTheatreTransition = null;
            };
        }
        this.retoldScrubber?.setTheatreMode(active);
        eventBus.emit('world:theatre', active);
        this._invalidateIdleFrame();
    }

    get restZoom() {
        return this.camera?._directorGlide?.toZoom ?? this.camera?.restZoomTarget ?? this.camera?.zoom;
    }

    frameWorldAgent(id) {
        const sprite = this.agentSprites.get(id);
        if (!sprite || sprite.agent?.isDeparted) return false;
        if (isAttentionStatus(sprite.agent?.status) && this.cameraDirector?.frameAttention([sprite])) return true;
        this.camera.noteUserInput?.();
        return this.camera.glideToWorld({ minX: sprite.x, maxX: sprite.x, minY: sprite.y - 60, maxY: sprite.y },
            { owner: 'user', maxZoom: this.camera.shotTier?.('medium') || 2, userAdjustedOnComplete: true });
    }

    _clearCouncilFocus() {
        this.focusedSquadIds = null;
        this.councilRibbon?.clear();
        this._invalidateIdleFrame();
    }

    _refreshCouncilFocus() {
        const selected = this.selectedAgent;
        const sprites = this.agentSprites;
        let lead = sprites.get(selected?.id);
        const ancestors = new Set();
        while (lead && !ancestors.has(lead.agent.id)) {
            ancestors.add(lead.agent.id);
            const parent = sprites.get(lead.agent.rootSessionId) || sprites.get(lead.agent.parentSessionId);
            if (!parent || parent === lead || parent.agent.isDeparted) break;
            lead = parent;
        }
        if (!lead || lead.agent.isDeparted) return this._clearCouncilFocus();
        const members = new Set([lead.agent.id]);
        const children = [];
        // Some providers only supply a parent. Walk until nested children have all joined.
        let previous;
        do {
            previous = members.size;
            for (const sprite of sprites.values()) {
                const a = sprite.agent;
                if (a.isDeparted || members.has(a.id)) continue;
                if (!members.has(a.parentSessionId) && !members.has(a.rootSessionId)) continue;
                members.add(a.id);
                children.push(sprite);
            }
        } while (members.size > previous);
        if (!children.length || !members.has(selected?.id)) return this._clearCouncilFocus();
        this.focusedSquadIds = members;
        this.councilRibbon.setSquad({ lead, children, selectedId: selected.id });
        this._invalidateIdleFrame();
    }

    _updateGlassCutaway(now = Date.now()) {
        const glass = this.inspectionGlass;
        const buildings = this.buildingRenderer;
        if (!buildings) return;
        if (!glass?.enabled || postcardFrame()) {
            buildings.setGlassCutawayTarget?.(null, { resolved: true });
            buildings._updateInspection?.();
            return;
        }
        const zoom = this.restZoom;
        const center = glass.getCenter();
        const point = center && zoom >= 2 && this.camera?.screenToWorld?.(center.x, center.y);
        const type = point && buildings.hitTest?.(point.x, point.y)?.type;
        const cutawayEligible = Boolean(type && (getBuildingApertureProfile(type) || buildings.supportsCutaway?.(type)));
        const model = buildings.getApertureModel?.() || null;
        // Real user selection only — never treat The Glass's own cutaway
        // (`trigger: 'glass'` / `source: 'glass'`) as a selection cutaway.
        const selectionCutawayActive = Boolean(
            buildings._selectedBuildingType
            && model
            && (model.trigger === 'selection' || (model.trigger == null && model.source !== 'glass'))
        );
        const cut = glass.updateCutaway({
            buildingId: cutawayEligible ? type : null,
            zoom,
            selectionCutawayActive,
            nowMs: now,
        });
        // InspectionGlass.updateCutaway is the single owner of the 300ms dwell
        // and 400ms exit state machine; forward the resolved target cleanly.
        if (typeof buildings.setGlassCutawayTarget === 'function') {
            buildings.setGlassCutawayTarget(cut.buildingId || null, { resolved: true });
            buildings._updateInspection?.();
            return;
        }
        // Fallback for pre-W5-B unit-test doubles without `setGlassCutawayTarget`.
        if (!selectionCutawayActive && 'model' in buildings) {
            buildings.model = cut.buildingId ? { buildingType: cut.buildingId, source: cut.source } : null;
        }
    }

    // 10.2 / 10.3 — the world renderer's display path from the stored HDR
    // setting and the media queries (DisplayColor.resolveDisplayColor picks
    // the path; WebGL and Canvas never present HDR). SET reads the status.
    // The overlay's reserved-hue P3 inks follow the live gamut query.
    _applyDisplayColor() {
        const media = readDisplayMedia();
        const hdrMode = readHdrHighlights();
        setOverlayInksP3(media.colorGamutP3);
        const world = this.gpuWorld;
        // A WebGPU backend learns on its first HDR configure whether the
        // canvas tone-maps (Safari's opt-in does not) and reports it here.
        if (world) world.onDisplayChange = () => this._publishDisplayStatus(hdrMode, media);
        world?.setDisplayColor?.({ hdrMode, ...media });
        this._publishDisplayStatus(hdrMode, media);
        this._invalidateIdleFrame();
    }

    _publishDisplayStatus(hdrMode, media) {
        publishDisplayStatus({
            backend: this.worldRendererMode,
            hdrMode,
            ...media,
            toneMappingSupported: this.gpuWorld?.toneMappingSupported !== false,
        });
    }

    _toggleDebugOverlay(method) {
        if (this.debugOverlay) {
            this.debugOverlay[method]?.();
            this._invalidateIdleFrame();
            return Promise.resolve(true);
        }
        if (!this._debugOverlayModulePromise) {
            this._debugOverlayModulePromise = import('./DebugOverlay.js');
        }
        return this._debugOverlayModulePromise.then((module) => {
            if (this._disposed || !module.DebugOverlay) return false;
            if (!this.debugOverlay) this.debugOverlay = new module.DebugOverlay();
            this.debugOverlay[method]?.();
            this._invalidateIdleFrame();
            return true;
        }).catch((error) => {
            console.warn('[IsometricRenderer] Debug overlay unavailable:', error.message);
            this._debugOverlayModulePromise = null;
            return false;
        });
    }

    hide() {
        if (this._disposed) return;
        this._disposed = true;
        this._biographyReadGeneration++;
        this._worldResourceGeneration++;
        this.running = false;
        this._stopLoop();
        this.postFx?.dispose?.();
        this.postFx = null;
        this.gpuWorld?.dispose?.();
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this.worldBackendReason = null;
        this.worldBackendNotes = null;
        this.releaseResolvedBackend();
        this._cancelFallbackPrep();
        this._worldSwap?.gpuWorld?.dispose?.();
        this._worldSwap = null;
        this.postFxFeed?.dispose?.();
        this.postFxFeed = null;
        this._setPostFxCanvasVisible(false);
        if (this.camera) {
            this.camera.detach();
        }
        this.cameraDirector?.dispose?.();
        this.cameraDirector = null;
        this._offscreenCueState?.dispose?.();
        this._unbindMotionPreference();
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._unsubscribers = [];
        if (this.canvas) {
            this.canvas.removeEventListener('click', this._onClick);
            this.canvas.removeEventListener('mousemove', this._onMouseMoveMain);
            for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
                this.canvas.removeEventListener(type, this._onPointerInputMain, { capture: true });
            }
            this.canvas.removeEventListener('mouseleave', this._onMouseLeaveMain);
        }
        this._hoverPlate?.dispose();
        this._hoverPlate = null;
        if (this._agentHoverRafId !== null) {
            cancelAnimationFrame(this._agentHoverRafId);
            this._agentHoverRafId = null;
        }
        this._setHoveredAgentSprite(null);
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
        this._fleetCard?.close();
        this._fleetCard = null;
        window.removeEventListener('keyup', this._onReadKeyUp);
        window.removeEventListener('blur', this._onReadBlur);
        this.setReadMode(false);
        if (this._chronicleChannelListener && this.chronicleStore?.channel?.removeEventListener) {
            this.chronicleStore.channel.removeEventListener('message', this._chronicleChannelListener);
        }
        this._chronicleChannelListener = null;
        this.setTheatreMode(false, true);
        this._clearCouncilFocus();
        this.setReadLock(false);
        this.postcardStudio?.destroy();
        this.retoldScrubber?.destroy();
        this._onModeChanged = null;
        this.chronicler?.destroy?.();
        this._sortedSprites = [];
        this._allSpritesSnapshot.length = 0;
        this._visibleSortedSprites.length = 0;
        this._visibleSpriteCandidates.clear();
        this._overlayPrioritizedSprites.length = 0;
        this._overlayBubbleSprites.length = 0;
        this._overlayBubbleOrder.length = 0;
        this._overlayBubbleBaseRects.length = 0;
        if (this._thoughtSeated) this._thoughtSeated.length = 0;
        this._agentLabelHitRects.length = 0;
        this._overlayNameRects.length = 0;
        this._overlayReservedRects.length = 0;
        this._overlayBubbleOccupiedRects.length = 0;
        this._overlayNameGrid.buckets.clear();
        this._overlayBubbleGrid.buckets.clear();
        this._overlayClusterGrid.buckets.clear();
        this._spritesNeedSort = true;
        this._suspendWorldModeResources();
        this.agentSprites.clear();
        this._nicknames.clear();
        this._patinaByIdentity?.clear?.();
        this._benchClaimsByIdentity?.clear?.();
        this._benchPatinaBySeat?.clear?.();
        this._restSeatBackProps?.clear?.();
        this._seatedSeatByAgent?.clear?.();
        this._allyNodCooldowns?.clear?.();
        this._childTrimById?.clear?.();
        this._workflowRibbons?.byAgentId?.clear?.();
        this._workflowRibbons?.byParentId?.clear?.();
        AgentSprite.releaseSharedCaches?.();
        this.compositor?.dispose?.();
        this.gateTransits.clear();
        this.particleSystem.clear();
        this.buildingRenderer?.dispose?.();
        this.releaseVolatileCaches();
        this.trailRenderer?.dispose?.();
        this.trailRenderer = null;
        this.agentEventStream?.dispose?.();
        this._unbindSquadNotice?.();
        this._unbindSquadNotice = null;
        this._unbindVerifiedOutcomes?.();
        this._unbindVerifiedOutcomes = null;
        releaseCouncilRingState(this.relationshipState);
        this.relationshipState?.dispose?.();
        if (this._harborSemanticsTimer) clearInterval(this._harborSemanticsTimer);
        this._harborSemanticsTimer = null;
        this.harborTraffic?.dispose?.();
        this.landmarkActivity?.dispose?.();
        this.chronicleMonuments?.dispose?.();
        if (this._deferredChronicleBanners) this._deferredChronicleBanners.length = 0;
        this.ritualConductor?.dispose?.();
        this.villageDirector?.dispose?.();
        if (getActiveMarkGovernor() === this.markGovernor) setActiveMarkGovernor(null);
        this._releaseFrameHealthHelper();
        this._releaseDebugGlobals();
        this.agentEventStream = null;
        this.relationshipState = null;
        this.ritualConductor = null;
        this.villageDirector = null;
        this.visitIntentManager?.dispose?.();
        this.visitTileAllocator?.dispose?.();
        this._crowdBumpCooldowns.clear();
        this._pairBuckets.clear();
        this._pairIds.clear();
        this._pairIdentityRanks.clear();
        this._pairDuplicatePairs.clear();
        this._pairColumnPool.length = 0;
        this._pairBucketPool.length = 0;
        if (this._orcaPools) {
            this._orcaPools.agents.length = 0;
            this._orcaPools.obstacles.length = 0;
            this._orcaPools.seenSet.clear();
        }
        this.foliageRenderer?.clear?.();
        this._atmosphereEffectSpriteCache.clear();
        this.weatherRenderer?.dispose?.();
        this.skyRenderer?.releaseCache?.();
        this.atmosphereState?.dispose?.();
        // SeasonalAmbience holds no resources today; the optional chain keeps
        // the lifecycle hook in place if a dispose method lands.
        this.seasonalAmbience?.dispose?.();
        this.overlayCtx = null;
        this.overlayCanvas = null;
        this.fxCanvas = null;
    }

    _startLoop() {
        if (
            !this.running
            || this._disposed
            || this.frameId !== null
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this._contextLost
            || this._frameFailureStats.paused
        ) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        this.frameId = requestAnimationFrame(frameTime => this._loop(frameTime));
    }

    _stopLoop() {
        this._cancelFrameFailureRecovery();
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        resetFramePacing(this._framePacing);
        this._fpsFrames = 0;
        this._fpsWindowStart = null;
        eventBus.emit('fps:updated', null);
    }

    setWorldModeActive(active) {
        const nextActive = Boolean(active);
        if (this._worldModeActive === nextActive) {
            if (!nextActive) this._suspendWorldModeResources({ deferShade: true });
            else void this._beginWorldModeResume();
            return;
        }
        if (!nextActive) {
            this.setTheatreMode(false, true);
            this.setReadLock(false);
            this._clearCouncilFocus();
            this.inspectionGlass?.onBlur();
            this.inspectionGlass?.setArmed(false);
            eventBus.emit('world:glass-armed', false);
            this.postcardStudio?.close();
        }
        this._worldModeActive = nextActive;
        this._lastFrameTime = performance.now();
        if (nextActive) {
            void this._beginWorldModeResume();
        } else {
            this._worldResourceGeneration++;
            this._stopLoop();
            this._suspendWorldModeResources({ deferShade: true });
        }
    }

    pauseForVisibility() {
        this._visibilityPaused = true;
        this._worldResourceGeneration++;
        this._stopLoop();
        if (this._worldResourcesSuspended) this.assets?.suspend?.();
        this.releaseVolatileCaches({ deferShade: true });
    }

    resumeFromVisibility({ active = true } = {}) {
        this._visibilityPaused = false;
        this._worldModeActive = Boolean(active);
        this._lastFrameTime = performance.now();
        if (this._worldModeActive) {
            void this._beginWorldModeResume();
        } else {
            this._worldResourceGeneration++;
            this._stopLoop();
            this._suspendWorldModeResources();
        }
    }

    // A lost 2D World context. App reloads the page on a real GPU-process
    // crash (it blanks every accelerated canvas, module caches included);
    // this in-place path serves a crash App may not reload for
    // (`canvasFallback`: a second one within its window, which also drops the
    // GPU world for the Canvas world) and a synthetic loss. The loss only
    // stops the loop (resizing a DOM canvas to zero here would stop the
    // browser restoring it); the restore runs a Dashboard trip: drop every
    // World resource, rebuild them all.
    handleContextLost() {
        this._contextLost = true;
        this._worldResourceGeneration++;
        this._stopLoop();
        this.releaseVolatileCaches();
    }

    handleContextRestored({ canvasFallback = false } = {}) {
        this._contextLost = false;
        this._resumeFrameFailures();
        this._lastFrameTime = performance.now();
        if (canvasFallback && this.worldRendererMode !== 'canvas') {
            // A session policy, not a WebGPU outcome: the note sits in the
            // selection slot (the webgpu/webgl2 slots keep what they said).
            this._backendSessionNote = 'GPU process crashed twice in 2 min: Canvas world, no reload';
            this._dropToCanvasWorld(this.worldBackendNotes?.webgpu ?? 'not probed');
        }
        if (!this._worldModeActive) return Promise.resolve(false);
        this._suspendWorldModeResources({ keepSurfaces: true });
        return this._beginWorldModeResume();
    }

    _releaseWorldShade() {
        clearTimeout(this._shadeReleaseTimer);
        this._shadeReleaseTimer = null;
        releaseFrameShade(this);
        releaseShadeField(this);
    }

    releaseVolatileCaches({ deferShade = false } = {}) {
        if (deferShade && this._shadeFieldState?.ready) {
            this._shadeReleaseTimer ??= setTimeout(() => this._releaseWorldShade(), SHADE_SUSPEND_GRACE_MS);
        } else {
            this._releaseWorldShade();
        }
        this._releaseTerrainArtifactWork();
        releaseCanvasBackingStore(this.terrainCache);
        this.terrainCache = null;
        this._terrainResident = null;
        this.terrainCacheKey = '';
        this._cancelTerrainRestage();
        this.terrainCacheBounds = null;
        this.terrainCacheMeta = null;
        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        releaseCanvasBackingStore(this._fastVignetteStamp);
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        releaseCanvasBackingStore(this._poolLayer);
        releaseCanvasBackingStore(this._poolShadeLayer);
        this._poolLayer = null;
        this._poolShadeLayer = null;
        this._poolLayerRect = null;
        releaseCanvasMap(this.lightGradientCache);
        this.lightFadeColorCache?.clear?.();
        this.lightColorRgbCache?.clear?.();
        this.skyRenderer?.releaseCache?.();
        this.trailRenderer?.pause?.();
        this.weatherRenderer?.dispose?.();
        // The water mask is a viewport-sized volatile surface like the rest of
        // this list; `fillWater` rebuilds it on the next frame. Without this it
        // survived context loss, which the lifecycle smoke reports as leaked
        // volatile pixels.
        this.postFxFeed?.dispose?.();
        releaseCanvasBackingStore(this._semanticGroundCanvas);
        this._semanticGroundCanvas = null;
        this._semanticGroundKey = null;
        // 0.2 — the ground-cue stamp atlas (and the pooled records that point
        // at it) rebuilds from the first painted cue after release.
        releaseCanvasBackingStore(this._groundCueRecorder?.atlas?.canvas);
        this._groundCueRecorder = null;
        this._groundCueRecords = null;
        releaseCanvasBackingStore(this._gpuAgentFrameAtlas);
        this._gpuAgentFrameAtlas = null;
        releaseCanvasBackingStore(this._gpuAgentMaterialAtlas);
        this._gpuAgentMaterialAtlas = null;
        releaseCanvasBackingStore(this._gpuAgentEmissiveAtlas);
        this._gpuAgentEmissiveAtlas = null;
        this._gpuAgentMaterialAtlasState = null;
        this._gpuAgentEmissiveAtlasState = null;
        this._gpuAgentAlbedoTextureUpdates = [];
        this._gpuAgentMaterialTextureUpdates = [];
        this._gpuAgentEmissiveTextureUpdates = [];
        this._gpuAgentFrameAtlasSignature = '';
        this._gpuAgentFrameAtlasRevision = 0;
        this._gpuAgentAtlasSlots?.clear?.();
        this._gpuAgentAtlasFrameKeys?.clear?.();
        this._gpuAgentAtlasPoses?.clear?.();
        this._gpuAgentAtlasNextSlot = 0;
        this._gpuAgentAtlasRosterSignature = '';
        this._gpuAgentAtlasUpdatedAt = 0;
        for (const entry of this._gpuPackedMaterialSidecars?.values?.() || []) {
            releaseCanvasBackingStore(entry?.canvas);
        }
        this._gpuPackedMaterialSidecars?.clear?.();
        releaseCanvasBackingStore(this._gpuTerrainMaterialSidecar?.canvas);
        this._gpuTerrainMaterialSidecar = null;
    }

    _ensureTrailRenderer() {
        if (this.trailRenderer) return;
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            sprites: this.agentSprites,
            motionScale: this.motionScale,
            surfaceAt: (worldX, worldY) => this._trailSurfaceAt(worldX, worldY),
        });
    }

    // `keepSurfaces` (a context restore): the viewport canvases stay sized, so
    // the page's loading bands show through the cleared surfaces while the
    // resources rebuild, never a black 0x0 opaque canvas.
    _suspendWorldModeResources({ keepSurfaces = false, deferShade = false } = {}) {
        this._cancelFrameFailureRecovery();
        // Always forward suspension so an in-flight decoded-asset reload is
        // aborted even when the renderer already released its own surfaces.
        this.assets?.suspend?.();
        if (this._worldResourcesSuspended) return;
        this.releaseVolatileCaches({ deferShade });
        for (const sprite of this.agentSprites.values()) sprite?.releaseRenderResources?.();
        AgentSprite.releaseSharedCaches?.();
        this.compositor?.releaseCache?.();
        this.foliageRenderer?.releaseCache?.();
        this._atmosphereEffectSpriteCache.clear();
        const staticSprites = new Set(
            this._staticPropDrawables.map(drawable => drawable?.payload?.sprite).filter(Boolean),
        );
        for (const sprite of staticSprites) sprite.releaseCache?.();
        this.postFxFeed?.dispose?.();
        this.postFx?.suspend?.();
        this.gpuWorld?.suspend?.();
        if (!keepSurfaces) {
            releaseCanvasBackingStore(this.fxCanvas);
            releaseCanvasBackingStore(this.canvas);
            // The UI surface is as volatile as the world backing store; keeping it
            // alive in Dashboard mode would retain a full-screen alpha canvas.
            releaseCanvasBackingStore(this.overlayCanvas);
        }
        this._worldResourcesSuspended = true;
    }

    _beginWorldModeResume() {
        if (
            this._disposed
            || !this.running
            || !this._worldModeActive
            || this._contextLost
            || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) return Promise.resolve(false);

        clearTimeout(this._shadeReleaseTimer);
        this._shadeReleaseTimer = null;
        const generation = this._worldResourceGeneration;
        if (this._worldResumePromise && this._worldResumeGeneration === generation) {
            return this._worldResumePromise;
        }
        if (this._worldResourcesSuspended) this._stopLoop();
        const operation = Promise.resolve()
            .then(() => this._resumeWorldModeResources(generation))
            .then((ready) => {
                if (
                    !ready
                    || this._disposed
                    || !this.running
                    || !this._worldModeActive
                    || generation !== this._worldResourceGeneration
                    || this._contextLost
                    || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
                ) return false;
                this._resumeFrameFailures();
                if (this._worldSpritesDirty) this._reconcileSpritesWithWorld();
                this.invalidateViewportCaches();
                this._startLoop();
                return this.frameId !== null;
            })
            .catch((err) => {
                if (
                    !this._disposed
                    && this._worldModeActive
                    && generation === this._worldResourceGeneration
                ) {
                    this._worldResumeFailures++;
                    console.error('[IsometricRenderer] World asset resume failed:', err);
                }
                return false;
            });
        const wrapped = operation.finally(() => {
            if (this._worldResumePromise === wrapped) {
                this._worldResumePromise = null;
                this._worldResumeGeneration = null;
            }
            if (generation === this._worldResourceGeneration && this.frameId === null) {
                this._startLoop();
            }
        });
        this._worldResumePromise = wrapped;
        this._worldResumeGeneration = generation;
        return wrapped;
    }

    async _resumeWorldModeResources(generation = this._worldResourceGeneration) {
        if (this._disposed || !this.running || !this._worldModeActive) return false;
        if (!this._worldResourcesSuspended) {
            this.trailRenderer?.resume?.();
            return true;
        }
        if (this.assets?.resume) {
            const assetsReadyPromise = this.assets.resume();
            this._prepareTerrainArtifactRead();
            const assetsReady = await assetsReadyPromise;
            if (!assetsReady) return false;
        }
        if (
            this._disposed
            || !this.running
            || !this._worldModeActive
            || this._contextLost
            || generation !== this._worldResourceGeneration
        ) return false;
        if (!this._worldResourcesSuspended) return true;
        const width = Math.round(
            (this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || 0)
            * (this.canvas?._claudeVilleDpr || 1),
        );
        const height = Math.round(
            (this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || 0)
            * (this.canvas?._claudeVilleDpr || 1),
        );
        if (this.canvas && width > 0 && height > 0) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            if (this.ctx) SpriteRenderer.disableSmoothing(this.ctx);
            this._resizeAuxiliaryBackingStores(width, height);
        }
        this.postFx?.resume?.();
        this.gpuWorld?.resume?.();
        for (const sprite of this.agentSprites.values()) {
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
        }
        this.trailRenderer?.resume?.();
        this._worldResourcesSuspended = false;
        this.camera?.onViewportResize?.();
        return true;
    }

    _reconcileSpritesWithWorld() {
        const liveIds = new Set(this.world?.agents?.keys?.() || []);
        for (const agentId of Array.from(this.agentSprites.keys())) {
            if (!liveIds.has(agentId)) this._removeAgentSprite(agentId);
        }
        const prevDefer = this._deferPortalRelease;
        this._deferPortalRelease = true;
        try {
            for (const agent of this.world?.agents?.values?.() || []) {
                if (agent.isDeparted) {
                    // Departed while world mode was inactive: walk out now, and
                    // never spawn a sprite for one that already left.
                    if (this.agentSprites.has(agent.id)) this._beginAgentDeparture(agent);
                    continue;
                }
                this._addAgentSprite(agent);
            }
        } finally {
            this._deferPortalRelease = prevDefer;
        }
        if (!this._deferPortalRelease) this._releasePortalEntries();
        this._worldSpritesDirty = false;
    }

    // VB-4 — the first frame after a gap of over 10 s (a hidden tab, a sleeping
    // laptop, a long Dashboard visit) settles the world at once instead of
    // replaying it. A body whose session ended over 30 s ago leaves with no
    // walk and no fade; a session that arrived while nothing was drawn, or
    // one still queued at or walking in through the gate (nobody watched that
    // walk either), stands at its destination. Departures in their first
    // 30 s still walk out. `_loop` calls this before it stamps the frame.
    _settleAfterFrameGap(now) {
        const lastFrameAt = this._lastLoopFrameTime;
        if (!Number.isFinite(lastFrameAt) || now - lastFrameAt <= LONG_FRAME_GAP_MS) return;
        if (this._worldSpritesDirty) this._reconcileSpritesWithWorld();
        if (this.replay?.recorded) return;
        const wallNow = Date.now();
        for (const [agentId, sprite] of Array.from(this.agentSprites)) {
            const transit = this.gateTransits.get(agentId);
            const agent = this.world?.agents?.get?.(agentId) || null;
            if (!agent || agent.isDeparted || sprite._archiveAnim || sprite.leaving || transit?.type === 'departure') {
                const leftAt = Number(agent?.departedAt ?? sprite.agent?.departedAt) || transit?.since || null;
                if (!leftAt || wallNow - leftAt > STALE_TRANSIT_MS) this._removeAgentSprite(agentId, { fade: false });
                continue;
            }
            if (Number(sprite.addedAt) >= lastFrameAt || sprite.isArrivalPending?.() || transit?.type === 'arrival') {
                this.gateTransits.delete(agentId);
                if (this._gateEntryQueue?.length) this._gateEntryQueue = this._gateEntryQueue.filter(entry => entry.sprite !== sprite);
                if (this._portalEntryQueue?.length) this._portalEntryQueue = this._portalEntryQueue.filter(entry => entry.sprite !== sprite);
                this.arrivalDeparture?.arrivals?.delete(agentId);
                this.arrivalDeparture?.dispatches?.delete(agentId);
                sprite.settleAtDestination?.();
            }
        }
        this._markSpritesDirty();
    }

    _markSpritesDirty() {
        this._spritesNeedSort = true;
        this._invalidateIdleFrame();
    }

    _snapshotAllSprites() {
        const sprites = this._allSpritesSnapshot;
        sprites.length = 0;
        for (const sprite of this.agentSprites.values()) sprites.push(sprite);
        return sprites;
    }

    _agentVisibleOnScreen(sprite, viewport = this._screenViewport(), margin = AGENT_SCREEN_CULL_MARGIN) {
        if (!sprite || !viewport || !this.camera) return true;
        const point = this.camera.worldToScreen(sprite.x, sprite.y);
        return point.x >= -margin
            && point.x <= viewport.width + margin
            && point.y >= -margin
            && point.y <= viewport.height + margin;
    }

    _snapshotSortedSprites() {
        const viewport = this._screenViewport();
        const candidates = this._visibleSpriteCandidates;
        candidates.clear();
        let rosterOrder = 0;
        for (const sprite of this.agentSprites.values()) {
            sprite._rendererRosterOrder = rosterOrder++;
            if (this._agentVisibleOnScreen(sprite, viewport)) candidates.add(sprite);
        }

        // Retain the previous visible order so the common case only needs a
        // monotonicity scan. Remove sprites that left the apron in place, then
        // append newly-visible sprites before repairing the near-sorted list.
        const visible = this._visibleSortedSprites;
        let next = 0;
        for (let i = 0; i < visible.length; i++) {
            const sprite = visible[i];
            if (!candidates.has(sprite)) {
                sprite._occludedByWorld = false;
                sprite._behindBuilding = false;
                sprite._behindBuildingDrawable = null;
                if (sprite._worldOccluders) sprite._worldOccluders.length = 0;
                continue;
            }
            visible[next++] = sprite;
            candidates.delete(sprite);
        }
        visible.length = next;
        for (const sprite of this.agentSprites.values()) {
            if (candidates.has(sprite)) visible.push(sprite);
        }

        let ordered = true;
        for (let i = 1; i < visible.length; i++) {
            const previous = visible[i - 1];
            const current = visible[i];
            if (
                previous.y > current.y
                || (previous.y === current.y && previous._rendererRosterOrder > current._rendererRosterOrder)
            ) {
                ordered = false;
                break;
            }
        }
        if (!ordered) {
            // Agent motion is continuous, so the previous frame is almost
            // sorted. Insertion repair is linear for unchanged relative order
            // and moves only sprites that actually crossed in Y.
            for (let i = 1; i < visible.length; i++) {
                const sprite = visible[i];
                let insertAt = i;
                while (insertAt > 0) {
                    const previous = visible[insertAt - 1];
                    if (
                        previous.y < sprite.y
                        || (
                            previous.y === sprite.y
                            && previous._rendererRosterOrder <= sprite._rendererRosterOrder
                        )
                    ) break;
                    visible[insertAt] = visible[insertAt - 1];
                    insertAt--;
                }
                visible[insertAt] = sprite;
            }
        }
        this._sortedSprites = visible;
        this._spritesNeedSort = false;
        return visible;
    }

    _enumeratePropDrawables() {
        if (this._shouldUseFastStaticProps()) {
            return this._enumerateFastPropDrawables();
        }
        return this._enumerateVisibleStaticPropDrawables();
    }

    _buildStaticPropDrawables() {
        return buildStaticPropDrawables(
            this.treePropSprites,
            this.boulderPropSprites,
            this.districtPropSprites
        );
    }

    _buildStaticPropFastDrawables() {
        return (this._staticPropSprites || []).map((sprite) => ({
            sprite,
            // A column-sliced prop has no single depth; its slices always draw.
            columns: sprite.occlusionColumns?.map((column) => this._cachedPropDepthDrawable(sprite, 'column', column)) || null,
            whole: sprite.occlusionColumns ? null : this._cachedPropDepthDrawable(sprite),
            back: sprite.splitForOcclusion ? this._cachedPropDepthDrawable(sprite, 'back') : null,
            front: sprite.splitForOcclusion ? this._cachedPropDepthDrawable(sprite, 'front') : null,
        }));
    }

    _enumerateVisibleStaticPropDrawables() {
        const viewport = this._screenViewport();
        if (!viewport || !this.camera) return this._staticPropDrawables;
        const out = this._staticPropVisibleFrameDrawables;
        out.length = 0;
        for (const drawable of this._staticPropDrawables || []) {
            const sprite = drawable?.payload?.sprite;
            if (!sprite || this._propVisibleOnScreen(sprite, viewport)) out.push(drawable);
        }
        return out;
    }

    _cachedPropDepthDrawable(sprite, part = 'whole', column = null) {
        const kind = part === 'whole' ? 'prop' : `prop-${part}`;
        return createDepthDrawable(kind, propPartSortY(sprite, part, column), { sprite, part, column }, (ctx, zoom, _context, payload) => {
            payload?.sprite?.drawCachedPart?.(ctx, payload.part || 'whole', zoom, payload.column);
        });
    }

    _shouldUseFastStaticProps() {
        if ((this.camera?.zoom || 1) < FAST_PROP_MIN_ZOOM) return false;
        return this._screenWidth() * this._screenHeight() >= FAST_PROP_CSS_PIXELS;
    }

    _enumerateFastPropDrawables() {
        const out = this._staticPropFastFrameDrawables;
        out.length = 0;
        const viewport = this._screenViewport();
        for (const record of this._staticPropFastDrawables || []) {
            if (!this._propVisibleOnScreen(record.sprite, viewport)) continue;
            if (record.columns) {
                for (const column of record.columns) out.push(column);
            } else if (record.sprite?.splitForOcclusion) {
                if (record.back) out.push(record.back);
                if (record.front) out.push(record.front);
            } else if (record.whole) {
                out.push(record.whole);
            }
        }
        return out;
    }

    _propVisibleOnScreen(prop, viewport) {
        if (!prop || !viewport || !this.camera) return true;
        const bounds = prop.bounds || { left: -48, right: 48, top: -96, bottom: 24 };
        const topLeft = this.camera.worldToScreen(prop.x + bounds.left, prop.y + bounds.top);
        const bottomRight = this.camera.worldToScreen(prop.x + bounds.right, prop.y + bounds.bottom);
        const left = Math.min(topLeft.x, bottomRight.x);
        const right = Math.max(topLeft.x, bottomRight.x);
        const top = Math.min(topLeft.y, bottomRight.y);
        const bottom = Math.max(topLeft.y, bottomRight.y);
        return right >= -FAST_PROP_SCREEN_MARGIN
            && left <= viewport.width + FAST_PROP_SCREEN_MARGIN
            && bottom >= -FAST_PROP_SCREEN_MARGIN
            && top <= viewport.height + FAST_PROP_SCREEN_MARGIN;
    }

    _bindMotionPreference() {
        if (this._motionPreferenceBound || !this.motionQuery || !this._onMotionPreferenceChange) return;
        if (this.motionQuery.addEventListener) {
            this.motionQuery.addEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery.addListener) {
            this.motionQuery.addListener(this._onMotionPreferenceChange);
        } else {
            return;
        }
        this._motionPreferenceBound = true;
    }

    _unbindMotionPreference() {
        if (!this._motionPreferenceBound || !this.motionQuery || !this._onMotionPreferenceChange) return;
        if (this.motionQuery.removeEventListener) {
            this.motionQuery.removeEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery.removeListener) {
            this.motionQuery.removeListener(this._onMotionPreferenceChange);
        }
        this._motionPreferenceBound = false;
    }

    _setMotionScale(scale) {
        this._invalidateIdleFrame();
        this.motionScale = scale;
        this.buildingRenderer?.setMotionScale(scale);
        this.ritualConductor?.setMotionScale(scale);
        this.arrivalDeparture?.setMotionScale(scale);
        this.trailRenderer?.setMotionScale(scale);
        this.chronicler?.setMotionScale(scale);
        this.villageDirector?.setMotionScale(scale);
        this.harborTraffic?.setMotionScale(scale);
        this.landmarkActivity?.setMotionScale(scale);
        this.camera?.setReducedMotion?.(scale <= 0);
        this.cameraDirector?.setMotionScale?.(scale);
        this.particleSystem.setMotionEnabled(scale > 0);
        for (const sprite of this.agentSprites.values()) {
            sprite.setMotionScale(scale);
        }
        if (scale <= 0) {
            const departures = [];
            for (const [agentId, transit] of this.gateTransits.entries()) {
                if (transit.type === 'departure') {
                    departures.push(agentId);
                } else {
                    const sprite = this.agentSprites.get(agentId);
                    sprite?.setTilePosition?.(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY);
                    this.gateTransits.delete(agentId);
                }
            }
            for (const agentId of departures) this._finishGateDeparture(agentId);
        }
    }

    get motionTimeMs() {
        return this._motionClock?.elapsedMs ?? 0;
    }

    setQuotaState(state) {
        // The Hourglass Belfry reads both accounts, so it takes the whole usage.
        (this.isleLandmarks ||= new IsleLandmarks(this)).setUsage(state);
        const quota = state?.quota || state || null;
        this.quotaState = quota;
        this.buildingRenderer?.setQuotaState?.(quota);
        this.villageDirector?.setQuotaState?.(quota);
    }

    setCameraPose({ x, y, camX, camY, zoom } = {}) {
        if (!this.camera) return false;
        // An explicit pose (scenario metadata, capture tooling) ends any glide
        // in flight, such as the opening shot, instead of being overwritten.
        this.camera.abortDirectorGlide?.();
        const nextZoom = Number(zoom);
        if (Number.isFinite(nextZoom) && nextZoom > 0) {
            this.camera.zoom = this.camera.resolveRestingZoom?.(nextZoom)
                ?? Math.max(this.camera.minZoom || 1, Math.min(this.camera.maxZoom || 3, nextZoom));
            this.camera._zoomAnimation = null;
        }

        const centerX = Number.isFinite(Number(x)) ? Number(x) : Number(camX);
        const centerY = Number.isFinite(Number(y)) ? Number(y) : Number(camY);
        if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
            const viewportWidth = this.camera.canvas?._claudeVilleCssWidth
                || this.camera.canvas?.clientWidth
                || this.camera.canvas?.width
                || 0;
            const viewportHeight = this.camera.canvas?._claudeVilleCssHeight
                || this.camera.canvas?.clientHeight
                || this.camera.canvas?.height
                || 0;
            this.camera.stopFollow?.();
            this.camera.x = -centerX + viewportWidth / (2 * this.camera.zoom);
            this.camera.y = -centerY + viewportHeight / (2 * this.camera.zoom);
        }

        this.camera._clampToBounds?.();
        if (this._worldModeActive) this._startLoop();
        return {
            x: this.camera.x,
            y: this.camera.y,
            zoom: this.camera.zoom,
        };
    }

    _cameraAgentFrameWeight(sprite) {
        const agent = sprite?.agent;
        if (!agent) return 0;
        let weight = 0;
        switch (agent.status) {
            case AgentStatus.ERRORED:
            case AgentStatus.RATE_LIMITED:
            case AgentStatus.WAITING_ON_USER:
                weight = 4;
                break;
            case AgentStatus.WAITING:
                weight = 3;
                break;
            case AgentStatus.WORKING:
                weight = 2;
                break;
            default:
                weight = 0;
        }
        if (sprite?.moving) weight += 1;
        if (agent.currentTool) weight += 1;
        return weight;
    }

    _agentBuildingFramePoint(agent) {
        const type = normalizeBuildingType(
            agent?.targetBuildingType
            || agent?.lastKnownBuildingType
            || agent?.buildingType
            || agent?.building,
        );
        if (!type) return null;
        const building = this.world?.buildings?.get?.(type);
        const center = building ? buildingCenterToWorld(building) : null;
        return Number.isFinite(center?.x) && Number.isFinite(center?.y) ? center : null;
    }

    _worldBoxForCameraPoints(points) {
        const finite = (points || []).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (!finite.length) return null;
        const xs = finite.map(p => p.x);
        const ys = finite.map(p => p.y);
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    }

    _contentFrameBox() {
        const activePoints = [];
        const settledAgentPoints = [];
        const snapshot = this.villageDirector?.getSnapshot?.() || null;
        for (const cohort of snapshot?.workCohorts || []) {
            if (Number.isFinite(cohort?.center?.x) && Number.isFinite(cohort?.center?.y)) {
                activePoints.push({ x: cohort.center.x, y: cohort.center.y });
            }
        }
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || sprite._archiveAnim || sprite.agent?.isDeparted || this._isGateTransit(sprite, 'departure')) {
                continue;
            }
            const enteringAtGate = Boolean(sprite.isArrivalPending?.() || this._isGateTransit(sprite, 'arrival'));
            const hasPoint = Number.isFinite(sprite.x) && Number.isFinite(sprite.y);
            if (hasPoint && !enteringAtGate) {
                settledAgentPoints.push({ x: sprite.x, y: sprite.y });
            }
            if (this._cameraAgentFrameWeight(sprite) > 0) {
                const buildingPoint = this._agentBuildingFramePoint(sprite.agent);
                if (buildingPoint) activePoints.push(buildingPoint);
                if (hasPoint && !enteringAtGate) activePoints.push({ x: sprite.x, y: sprite.y });
            }
        }

        const hotBuildingPoints = [];
        const buildingSignals = snapshot?.buildingSignals || [];
        for (const signal of buildingSignals.slice(0, 3)) {
            if ((Number(signal?.heat) || 0) < 0.18) continue;
            if (Number.isFinite(signal?.center?.x) && Number.isFinite(signal?.center?.y)) {
                hotBuildingPoints.push({ x: signal.center.x, y: signal.center.y });
            }
        }

        if (activePoints.length) {
            return this._worldBoxForCameraPoints([...activePoints, ...hotBuildingPoints.slice(0, 2)]);
        }
        if (hotBuildingPoints.length) return this._worldBoxForCameraPoints(hotBuildingPoints);
        if (settledAgentPoints.length) return this._worldBoxForCameraPoints(settledAgentPoints);

        const buildingPoints = [];
        if (this.world?.buildings) {
            for (const building of this.world.buildings.values()) {
                const center = buildingCenterToWorld(building);
                if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) {
                    buildingPoints.push(center);
                }
            }
        }
        return this._worldBoxForCameraPoints(buildingPoints);
    }

    // Densest active district cluster sized to fit the medium shot scale (z2 at
    // 1920 × 1080 and 1440 × 900) for the opening establishing shot. Excludes
    // walkers entering at the gate or Portal so live boots never drift SW.
    _openingContentFrameBox() {
        const snapshot = this.villageDirector?.getSnapshot?.() || null;
        const clusters = new Map();
        const addCluster = (key, center, weight, extraPoint = null) => {
            if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) return;
            const entry = clusters.get(key) || { key, center: { x: center.x, y: center.y }, weight: 0, points: [] };
            entry.weight += weight;
            if (extraPoint && Number.isFinite(extraPoint.x) && Number.isFinite(extraPoint.y)) {
                entry.points.push(extraPoint);
            }
            clusters.set(key, entry);
        };

        for (const cohort of snapshot?.workCohorts || []) {
            if (!cohort?.type || !cohort?.center) continue;
            const weight = (Number(cohort.working) || 0) * 3 + (Number(cohort.waiting) || 0) * 2 + (Number(cohort.total) || 0);
            addCluster(`b:${cohort.type}`, cohort.center, Math.max(1, weight));
        }
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || sprite._archiveAnim || sprite.agent?.isDeparted || this._isGateTransit(sprite, 'departure')) {
                continue;
            }
            const weight = this._cameraAgentFrameWeight(sprite);
            if (!(weight > 0)) continue;
            const enteringAtGate = Boolean(sprite.isArrivalPending?.() || this._isGateTransit(sprite, 'arrival'));
            const point = !enteringAtGate && Number.isFinite(sprite.x) && Number.isFinite(sprite.y)
                ? { x: sprite.x, y: sprite.y }
                : null;
            const bType = normalizeBuildingType(
                sprite.agent?.targetBuildingType
                || sprite.agent?.lastKnownBuildingType
                || sprite.agent?.buildingType
                || sprite.agent?.building,
            );
            const buildingPoint = this._agentBuildingFramePoint(sprite.agent);
            if (bType && buildingPoint) {
                addCluster(`b:${bType}`, buildingPoint, weight, point);
            } else if (point) {
                addCluster(`a:${sprite.agent?.id || clusters.size}`, point, weight, point);
            }
        }
        for (const signal of (snapshot?.buildingSignals || []).slice(0, 3)) {
            if ((Number(signal?.heat) || 0) < 0.18 || !signal?.type || !signal?.center) continue;
            addCluster(`b:${signal.type}`, signal.center, Number(signal.heat) || 0.2);
        }

        const ranked = [...clusters.values()].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
        if (!ranked.length) return this._contentFrameBox();

        const camera = this.camera;
        const w = camera?._viewportWidth?.() || 0;
        const h = camera?._viewportHeight?.() || 0;
        const mediumZoom = camera?.shotZoom?.('medium') || camera?.tierZoom?.(2) || 2;
        const padPx = 96;
        const maxW = w > 0 ? Math.max(160, (w - padPx * 2) / mediumZoom) : Infinity;
        const maxH = h > 0 ? Math.max(160, (h - padPx * 2) / mediumZoom) : Infinity;

        const lead = ranked[0];
        const box = {
            minX: lead.center.x - 40,
            maxX: lead.center.x + 40,
            minY: lead.center.y - 60,
            maxY: lead.center.y + 40,
        };
        const tryMerge = (pt, rx = 40, ryUp = 60, ryDown = 40) => {
            const minX = Math.min(box.minX, pt.x - rx);
            const maxX = Math.max(box.maxX, pt.x + rx);
            const minY = Math.min(box.minY, pt.y - ryUp);
            const maxY = Math.max(box.maxY, pt.y + ryDown);
            if ((maxX - minX) <= maxW && (maxY - minY) <= maxH) {
                box.minX = minX;
                box.maxX = maxX;
                box.minY = minY;
                box.maxY = maxY;
                return true;
            }
            return false;
        };
        for (const pt of lead.points) tryMerge(pt, 20, 76, 6);
        for (const cluster of ranked.slice(1)) {
            if (tryMerge(cluster.center)) {
                for (const pt of cluster.points) tryMerge(pt, 20, 76, 6);
            }
        }
        return box;
    }

    // Frame the camera on live work first (fallback: hot buildings, all agents,
    // building centers, then map core) so ClaudeVille opens on the village story
    // rather than a diluted all-sprite overview.
    frameContent() {
        if (!this.camera) return;
        const targetBox = this._contentFrameBox();
        if (!targetBox) {
            this.camera.centerOnMap();
            this.camera._userAdjusted = false;
            return;
        }

        // #45/8.3 — the first World paint opens on the whole island. The flag
        // is set only when the shot actually starts (5.7), so a failed attempt
        // (e.g. missing viewport) retries on the next re-frame.
        if (!this._didEstablishingShot && this.playOpeningShot({ targetBox: this._openingContentFrameBox() })) return;

        // 5.7/8.1/4.1 — later re-frames (relayout, the F key) glide in the
        // director vocabulary and settle on the default frame tier (3, or the
        // closest rung that fits, DPR-2 half rungs included), land-weighted
        // (4.2); a box spanning most of the island widens to the survey shot
        // (`scales.survey`, z1 on the DPR-1 ultrawide) instead of being cropped.
        const maxZoom = this.camera.defaultFrameTier;
        const minZoom = this.camera.frameTierFloorForBox(targetBox);
        if (this.camera.glideToWorld(targetBox, { owner: 'system', maxZoom, minZoom })) return;
        this.camera.fitToWorldBox(targetBox, { maxZoom, minZoom });
        this.camera._userAdjusted = false;
    }

    // 8.3 — the opening shot: whole island at the survey tier, hold, then one
    // move onto the content box or an authored pose (scenario metadata). Never
    // fights a follow that already owns the frame.
    playOpeningShot({ targetBox = null, targetPose = null } = {}) {
        if (this._didEstablishingShot || !this.camera || this.camera.followTarget) return false;
        const started = this.camera.establishingShot(this._fullIslandWorldBox(), { targetBox, targetPose });
        if (started) this._didEstablishingShot = true;
        return started;
    }

    // #45 — the full island's axis-aligned world box, framing the whole iso
    // diamond for the opening overview hold.
    _fullIslandWorldBox() {
        const corners = [
            tileToWorld(0, 0),
            tileToWorld(MAP_SIZE, 0),
            tileToWorld(MAP_SIZE, MAP_SIZE),
            tileToWorld(0, MAP_SIZE),
        ];
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    }

    // 0.5/0.3 — one `world:first-frame` per World activation: the page opening
    // ('boot') and every return from Dashboard ('return'). The shell keeps the
    // world canvases transparent over the container's stepped bands until it
    // fires, so nothing black, half-built or at a stale pose is ever shown.
    // `_firstFrameReason` starts as 'boot-pending': frames drawn before
    // App._openWorld has applied the opening pose (playOpeningShot,
    // frameContent, or a scenario's `opening: false`) never report. It is a
    // reason string while armed and null once reported.
    armFirstFrameSignal(reason = 'return') {
        // A Dashboard return that lands before the opening keeps the boot gate.
        if (this._firstFrameReason === 'boot-pending' && reason !== 'boot') return;
        this._firstFrameReason = reason;
        this._revealSnapshotPending = null;
        this.camera?.setPresented?.(false);
        // A static scene may skip idle frames; the armed frame has to draw.
        this._invalidateIdleFrame();
    }

    // Snapshot in the render task (WebGL's drawing buffer expires after it),
    // then publish after GPU completion and the tiny readback, or the bounded
    // null fallback. Keep the activation armed so a backend swap cannot pass it.
    _signalFirstFrame() {
        const reason = this._firstFrameReason;
        if (!reason || reason === 'boot-pending' || this._revealSnapshotPending) return;
        const horizonY = this._horizonScreenFraction();
        const snapshot = this._revealSnapshotPending = {
            reason, horizonY, cell: this._revealCell(),
            sky: this._lastAtmosphere?.sky?.palette || null,
        };
        let pending;
        try {
            pending = this._sampleFrameBands(4, horizonY, true);
        } catch {
            pending = null;
        }
        Promise.resolve(pending).catch(() => null).then(measured => {
            // A Dashboard trip/re-arm or renderer teardown supersedes this
            // snapshot; it must never reveal a different activation.
            if (this._revealSnapshotPending !== snapshot || this._disposed) return;
            this._revealSnapshotPending = null;
            this._firstFrameReason = null;
            this.camera?.setPresented?.(true);
            eventBus.emit('world:first-frame', {
                ...snapshot, sea: measured?.sea || null, bands: measured?.bands || null,
            });
            this._scheduleTerrainArtifactWrite();
        });
    }

    // The sea horizon's screen fraction; 0 when it is at or above the top edge.
    _horizonScreenFraction() {
        const height = this._screenHeight();
        const y = this.camera?.worldToScreen?.(0, OCEAN_HORIZON_WORLD_Y)?.y;
        if (!(height > 0) || !Number.isFinite(y)) return 0;
        return Math.max(0, Math.min(1, y / height));
    }

    // The reveal bands dither on one art texel at the current zoom (CSS px).
    _revealCell() {
        return Math.max(1, Math.round(this.camera?.zoom || 1));
    }

    // The fx canvas is read through the World renderer's readout when it has
    // one: the WebGPU HDR canvas (rgba16float) cannot be drawn into a 2D
    // canvas, so it hands over an SDR copy of the frame this task presented.
    _sampleFrameBands(count, horizonY, asyncReadback = false) {
        let fx = this.fxCanvas;
        let readout = null;
        if (fx && fx.style.display !== 'none') {
            if (asyncReadback) {
                readout = this.gpuWorld?.snapshotReadoutSurface
                    ? this.gpuWorld.snapshotReadoutSurface(REVEAL_SAMPLE_W, REVEAL_SAMPLE_H)
                    : snapshotWebglFence((this.gpuWorld || this.postFx)?.gl);
                // A missing GPU fence/readout is an unreadable whole frame,
                // not a partial measurement of just the two Canvas layers.
                if (!readout) return Promise.resolve(null);
                fx = readout.surface || fx;
            } else if (this.gpuWorld?.readoutSurface) {
                fx = this.gpuWorld.readoutSurface(REVEAL_SAMPLE_W, REVEAL_SAMPLE_H);
            }
        }
        const surfaces = [this.canvas, fx, this.overlayCanvas];
        return asyncReadback
            ? sampleRevealBandsAsync(surfaces, { count, horizonY, ...readout })
            : sampleRevealBands(surfaces, { count, horizonY });
    }

    // 0.3 (c) — the World is about to be suspended for Dashboard: draw one
    // frame now and measure it as `count` stepped bands, which the container
    // holds until the return's first frame. Null when the World cannot draw.
    captureFrameBands(count = 8) {
        if (!this.renderNow()) return null;
        const horizonY = this._horizonScreenFraction();
        const measured = this._sampleFrameBands(count, horizonY);
        return measured ? { ...measured, horizonY, cell: this._revealCell() } : null;
    }

    // XP-5 — one postcard frame of this view, composited and saved as a PNG.
    strikePostcard(options) {
        return strikePostcard(this, options);
    }

    // 0.3 (b) — draw one frame synchronously, outside the loop. The resize
    // closure calls it after reallocating the canvases (which clears them), so
    // a cleared backing store never presents. Nothing draws before the loop's
    // first frame (which runs the first update). Returns whether it drew.
    // A failed WebGPU world's pending fallback resolves here and the frame
    // draws on it, never on the failed world's Canvas stand-in.
    renderNow() {
        if (
            !this.running
            || this._disposed
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this._contextLost
            || this._frameFailureStats.paused
            || !this.camera
            || !this._lastAtmosphere
        ) return false;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
        const previousFreshOutput = this._forceFreshGpuOutput;
        this._forceFreshGpuOutput = true;
        try {
            this._stepFallbackPrep({ now: true });
            const swap = this._worldSwap?.fallback ? this._beginWorldSwap() : null;
            let painted;
            try {
                painted = this._render(0);
            } finally {
                if (swap) this._endWorldSwap(swap);
            }
            if (painted === false) {
                this._recordFrameSuccess();
                return false;
            }
            this._recordIdleRenderState();
            this.presentGeneration += 1;
            this._signalFirstFrame();
            this._recordFrameSuccess();
        } catch (error) {
            this._reportFrameFailure(error, 'render');
            return false;
        } finally {
            this._forceFreshGpuOutput = previousFreshOutput;
        }
        return true;
    }


    applyScenarioMetadata(metadata = {}) {
        if (!metadata || typeof metadata !== 'object') return false;
        this._scenarioMetadata = JSON.parse(JSON.stringify(metadata));

        const atmosphere = metadata.atmosphere || {};
        const motionScale = Number(
            atmosphere.motion?.motionScale
            ?? metadata.motionScale
            ?? (metadata.reducedMotion ? 0 : NaN)
        );
        if (Number.isFinite(motionScale)) {
            this._setMotionScale(this.replay && this.motionQuery?.matches ? 0 : Math.max(0, Math.min(1, motionScale)));
        }

        const clock = atmosphere.clock || null;
        const hour = Number(clock?.hours);
        if (!this.replay && Number.isFinite(hour)) {
            const minutes = Number(clock?.minutes);
            const seconds = Number(clock?.seconds);
            const hourValue = hour
                + (Number.isFinite(minutes) ? minutes / 60 : 0)
                + (Number.isFinite(seconds) ? seconds / 3600 : 0);
            this.atmosphereState?.setHour?.(hourValue);
            this.atmosphereState?.setTimelineMode?.('fixed');
        }

        if (atmosphere.weather) {
            this.atmosphereState?.setWeather?.(atmosphere.weather);
        }

        const camera = metadata.camera || {};
        const centerTile = camera.centerTile || null;
        if (centerTile) {
            const tileX = Number(centerTile.tileX);
            const tileY = Number(centerTile.tileY);
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                const center = tileToWorld(tileX, tileY);
                this.setCameraPose({ x: center.x, y: center.y, zoom: camera.zoom });
            }
        } else if (camera.zoom != null) {
            this.setCameraPose({ zoom: camera.zoom });
        }

        this.setPinnedAgentIds(metadata.pinnedAgentIds || []);

        if (metadata.selectedAgentId) {
            this.selectAgentById(metadata.selectedAgentId);
            if (this.selectedAgent && this.onAgentSelect) this.onAgentSelect(this.selectedAgent);
        }

        const selectedBuildingType = metadata.selectedBuildingType || metadata.selectedBuilding || null;
        if (selectedBuildingType) {
            const building = this._getBuildingByType(selectedBuildingType);
            if (building) {
                this.villageDirector?.setSelectedBuilding?.(building);
                eventBus.emit(BUILDING_EVENTS.SELECTED, building);
            }
        }

        if (metadata.replayActive === true) {
            this.villageDirector?.setReplayActive?.(true);
        }
        if (metadata.releaseParade) {
            this.villageDirector?.triggerReleaseParade?.(metadata.releaseParade);
        }

        return true;
    }

    _getBuildingByType(type) {
        const normalized = normalizeBuildingType(type);
        return normalized ? this.world?.buildings?.get?.(normalized) || null : null;
    }

    get laneTiles() {
        return this._laneTiles;
    }

    _allocateVisitTile(request = {}) {
        const building = request.building || this._getBuildingByType(request.intent?.building);
        const agentId = request.agent?.id || request.sprite?.agent?.id || request.intent?.agentId || null;
        const hasCustomCandidates = Array.isArray(request.candidates) && request.candidates.length > 0;
        if (
            agentId
            && building
            && !building.restSeats
            && !building.commandQueue
            && !hasCustomCandidates
            && !request.role
            && this._batchVisitAllocations?.size > 0
        ) {
            const cached = this._batchVisitAllocations.get(agentId);
            const reqType = normalizeBuildingType(building.type || request.intent?.building);
            const reqIntentId = request.intent?.id || null;
            if (
                cached
                && cached.buildingType === reqType
                && (cached.intentId === reqIntentId || !cached.intentId || !reqIntentId)
                && cached.allocation?.reservationId
                && this.visitTileAllocator?.reservations?.has?.(cached.allocation.reservationId)
            ) {
                this._batchVisitAllocations.delete(agentId);
                return cached.allocation;
            }
        }
        return this.visitTileAllocator?.allocate?.({
            ...request,
            building,
        }) || null;
    }

    // A subagent still at work (not finished, not an omp advisor, which lives
    // as long as its parent): its parent waits on it (AgentSprite._waitsForPint).
    // A finished child's own crew counts too, at any depth: a Codex or nested
    // Claude grandchild still holds its lead.
    _hasLiveSubagents(agentId, seen = new Set([agentId])) {
        for (const childId of this.relationshipState?.parentToChildren?.get(agentId) || []) {
            if (seen.has(childId)) continue;
            seen.add(childId);
            const child = this.world?.agents?.get(childId);
            if (!child || child.isDeparted || child.isAdvisor) continue;
            if (child.status !== AgentStatus.COMPLETED || this._hasLiveSubagents(childId, seen)) return true;
        }
        return false;
    }

    // AG-5 — the sprite of this lead's first live child observed waiting on
    // the operator or errored, else null: the lead stands up for it
    // (AgentSprite._risenForChild). Reads the child's own status only.
    _blockedChildSprite(agentId) {
        for (const childId of this.relationshipState?.parentToChildren?.get(agentId) || []) {
            const child = this.world?.agents?.get(childId);
            if (!child || child.isDeparted) continue;
            if (child.status !== AgentStatus.WAITING_ON_USER && child.status !== AgentStatus.ERRORED) continue;
            const sprite = this.agentSprites.get(childId);
            if (sprite && !sprite.leaving) return sprite;
        }
        return null;
    }

    // W4.9 — the local hour of the atmosphere clock (fractional; `setHour`
    // pins it): the one clock the daypart table (DayRoutine) reads.
    _dayHour() {
        const clock = this._lastAtmosphere?.clock ?? this.atmosphereState?.snapshot?.()?.clock;
        const minute = Number(clock?.minuteOfDay);
        if (Number.isFinite(minute)) return minute / 60;
        const now = new Date();
        return now.getHours() + now.getMinutes() / 60;
    }

    // W4.3 — a routine leg (`role`, e.g. 'stroll') over its cap gets no
    // destination, so `scenicVisits` counts only strolls that can happen.
    _getAmbientDestination({ agent, recentBuildings = [], cycle = 0, role = null, routineCap = null } = {}) {
        if (!agent?.id) return null;
        const allocator = this.visitTileAllocator;
        if (role && allocator?.routineHolders
            && allocator.routineHolders(role, Date.now(), agent.id) >= allocator.routineCap(role, routineCap)) return null;
        const seed = Math.abs(Math.floor(this._tileNoise(agent.id.length + cycle * 7, cycle + String(agent.id).charCodeAt(0)) * 100000));
        const recent = new Set(recentBuildings);
        const provider = String(agent.provider || '').toLowerCase();
        const model = String(agent.model || '').toLowerCase();
        const sprite = this.agentSprites.get(agent.id);
        const sourceTile = sprite?._screenToTile?.(sprite.x, sprite.y) || agent.position || null;
        const hour = this._dayHour();
        const weighted = AMBIENT_SCENIC_POINTS
            .map((point, index) => {
                let score = index * 0.1 + ((seed + index * 17) % 37);
                if (sourceTile) score += Math.hypot((sourceTile.tileX || 0) - point.tileX, (sourceTile.tileY || 0) - point.tileY) * 1.4;
                // W4.9 — the daypart tilts the pick (golden hour to the shore).
                score += scenicScoreBias(hour, point);
                if (recent.has(`ambient:${point.id}`)) score += 80;
                if (provider === 'gemini' && point.tags?.includes('portal')) score -= 12;
                if (provider === 'codex' && point.tags?.includes('forge')) score -= 10;
                if (provider === 'claude' && point.tags?.includes('command')) score -= 8;
                if (provider === 'kimi' && point.tags?.includes('portal')) score -= 10;
                if (provider === 'opencode' && point.tags?.includes('portal')) score -= 8;
                if (model.includes('deepseek') && point.tags?.includes('archive')) score -= 10;
                if (model.includes('glm') && point.tags?.includes('archive')) score -= 10;
                if (agent.teamName && point.district === 'civic') score -= 6;
                if (agent.isSubagent && point.tags?.includes('command')) score -= 7;
                if (this.pathfinder && !this.pathfinder.isWalkable(Math.round(point.tileX), Math.round(point.tileY))) score += 1000;
                return { point, score };
            })
            .sort((a, b) => a.score - b.score);
        const point = weighted[0]?.point;
        if (!point || weighted[0].score >= 1000) return null;
        this.behaviorMetrics.scenicVisits++;
        return {
            type: `ambient:${point.id}`,
            label: point.reason,
            district: point.district || 'ambient',
            capacity: { ambient: 1, work: 1 },
            routeViaRoads: true,
            visitTiles: [{
                tileX: point.tileX,
                tileY: point.tileY,
                slotId: `ambient:${point.id}`,
                scenic: true,
                reason: point.reason,
            }],
            containsVisitPoint: (tileX, tileY) => Math.hypot(Number(tileX) - point.tileX, Number(tileY) - point.tileY) <= 0.8,
        };
    }

    // W5-C — slow-tick grouped visit-slot batch dispatch via
    // `VisitTileAllocator.allocateBuildingBatch`, running Hungarian / ε-auction,
    // 15% hysteresis, and squad formation anchors live across each building.
    _dispatchVisitSlotBatches(agents, now = Date.now(), { includePending = false } = {}) {
        const allocator = this.visitTileAllocator;
        if (!allocator || typeof allocator.allocateBuildingBatch !== 'function') return 0;
        const cache = this._batchVisitAllocations || (this._batchVisitAllocations = new Map());
        for (const [cachedAgentId, entry] of cache.entries()) {
            if (
                !entry?.allocation?.reservationId
                || (now - entry.at) > 2000
                || !allocator.reservations?.has?.(entry.allocation.reservationId)
            ) {
                cache.delete(cachedAgentId);
            }
        }

        const groupsByBuilding = this._visitBatchGroups || (this._visitBatchGroups = new Map());
        groupsByBuilding.clear();

        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            if (!agent?.id || agent.isDeparted || agent.status === AgentStatus.WAITING_ON_USER) continue;
            const sprite = this.agentSprites?.get?.(agent.id) || null;
            if (sprite) {
                if (
                    sprite.leaving
                    || sprite._archiveAnim
                    || sprite.chatting
                    || sprite.chatPartner
                    || (!includePending && sprite.isArrivalPending?.())
                ) {
                    continue;
                }
            }

            const intent = this.visitIntentManager?.getIntentForAgent?.(agent.id, now) || null;
            if (!intent && (agent.status === AgentStatus.IDLE || agent.status === AgentStatus.COMPLETED)) continue;
            if (
                !intent
                && sprite?.visitRole
                && (
                    sprite.visitRole === 'rest'
                    || sprite.visitRole === 'queue'
                    || sprite.visitRole === 'stroll'
                    || sprite.visitRole === 'errand'
                    || sprite.visitRole === 'winddown'
                )
            ) {
                continue;
            }

            const rawType = intent?.building
                || (agent.status === AgentStatus.WORKING
                    ? (sprite?._lastBuildingType || agent.targetBuildingType || agent.lastKnownBuildingType)
                    : null);
            const buildingType = normalizeBuildingType(rawType);
            if (!buildingType) continue;

            const building = this._getBuildingByType(buildingType);
            if (!building || building.restSeats || building.commandQueue) continue;

            // Respect AgentSprite's 5s arrival commitment cooldown so batch
            // pre-allocation never steals a settled visitor's current slot early.
            const arrivedAt = sprite?.behavior?.arrivedAt;
            if (
                intent
                && intent.priority < 90
                && buildingType !== sprite?.behavior?.building
                && arrivedAt != null
                && (now - arrivedAt) < 5000
                && Number(intent.priority) <= Number(sprite?._lastIntentSnapshot?.priority ?? 0)
            ) {
                continue;
            }

            const existingId = allocator.agentReservationIds?.get?.(agent.id) || null;
            const existing = existingId ? allocator.reservations?.get?.(existingId) || null : null;
            const hasFreshSlot = Boolean(
                existing
                && existing.expiresAt > now
                && existing.buildingType === buildingType
                && !existing.line
            );
            const intentChanged = Boolean(intent?.id && sprite && intent.id !== sprite._lastIntentId);
            const buildingChanged = Boolean(sprite && sprite._lastBuildingType !== buildingType);
            const readyToRepick = Boolean(sprite && !sprite.moving && !(sprite.waitTimer > 0));
            if (hasFreshSlot && !intentChanged && !buildingChanged && !readyToRepick && !includePending) {
                continue;
            }

            let group = groupsByBuilding.get(buildingType);
            if (!group) {
                group = { building, requests: [] };
                groupsByBuilding.set(buildingType, group);
            }
            group.requests.push({ agent, sprite, building, intent });
        }

        let dispatched = 0;
        for (const [buildingType, group] of groupsByBuilding.entries()) {
            const results = allocator.allocateBuildingBatch(buildingType, group.requests, {
                building: group.building,
                now,
            });
            dispatched += group.requests.length;
            if (!Array.isArray(results)) continue;
            for (let i = 0; i < group.requests.length; i++) {
                const allocated = results[i];
                const req = group.requests[i];
                if (!allocated?.reservationId || !req?.agent?.id) continue;
                cache.set(req.agent.id, {
                    buildingType,
                    intentId: req.intent?.id || null,
                    allocation: allocated,
                    at: now,
                });
            }
        }
        groupsByBuilding.clear();
        return dispatched;
    }

    _updateVisitSystems(now = Date.now()) {
        const agents = Array.from(this.world?.agents?.values?.() || []);
        this._activeAgentsSnapshot = agents;
        this.visitIntentManager?.reconcile?.(agents, now);
        this.visitTileAllocator?.updateContext?.({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });
        this._dispatchVisitSlotBatches(agents, now);
        // 3.13 — feed allocator occupancy into domain congestion state.
        // Building.updateVisitLoad emits 'building:congestion' on level
        // transitions; sprites read building.congestion directly per frame.
        const buildingLoads = this.visitTileAllocator?.getBuildingLoads?.();
        if (buildingLoads) this.world?.applyVisitLoads?.(buildingLoads, now);
        return agents;
    }

    _agentBehaviorStats() {
        const intents = this.visitIntentManager?.snapshot?.()?.intents || [];
        const reservations = this.visitTileAllocator?.snapshot?.() || {};
        const byBuilding = {};
        const byState = {};
        for (const sprite of this.agentSprites.values()) {
            const snap = sprite.getBehaviorDebugSnapshot?.();
            if (!snap) continue;
            if (snap.building) byBuilding[snap.building] = (byBuilding[snap.building] || 0) + 1;
            if (snap.behaviorState) byState[snap.behaviorState] = (byState[snap.behaviorState] || 0) + 1;
        }
        const intentSources = {};
        for (const intent of intents) {
            intentSources[intent.source] = (intentSources[intent.source] || 0) + 1;
        }
        const derivedMetrics = {
            ...this.behaviorMetrics,
            parentCoherentChildren: intents.filter((intent) => intent.reason === 'follow-parent-work').length,
            handoffIntents: intents.filter((intent) => intent.source === 'handoff').length,
        };
        return {
            agentCount: this.agentSprites.size,
            metricsScope: 'since renderer start',
            byBuilding,
            byState,
            intentSources,
            behaviorMetrics: derivedMetrics,
            rollingBehavior: this.behaviorTelemetry?.metrics || null,
            ritualOverflow: this.ritualConductor?.getOverflowCount?.() || 0,
            allocatorMetrics: reservations.metrics || {},
            reservationCount: reservations.reservationCount || 0,
            buildingCrowds: reservations.buildings || {},
            crowd: this._crowdStats || this._summarizeCrowdClusters(),
            localAvoidance: { ...this._localAvoidanceMetrics },
            orca: this.getCrowdOrcaDiagnostics(),
            labelAuction: this.getLabelAuctionDiagnostics(),
        };
    }

    _syncRitualContext() {
        this.ritualConductor?.setContext?.({
            world: this.world,
            agentSprites: this.agentSprites,
            isAgentVisible: (agentId) => {
                const sprite = this.agentSprites.get(agentId);
                return Boolean(sprite && !sprite.isArrivalPending?.() && !this._isGateTransit(sprite, 'departure'));
            },
        });
    }

    _canAcceptToolRitual(event) {
        if (!this._worldModeActive) return false;
        return this.ritualConductor?.canAccept?.(event) ?? true;
    }

    // Mirror active pose-bearing rituals onto agent sprites each frame so
    // tool-heavy states read on the character (reading / typing / thinking).
    _syncToolRitualPoses() {
        const renderMode = this._lastRenderStats?.quality?.agentRenderMode || 'full';
        if (renderMode === 'minimal') {
            if (this._lastRitualPoseMode !== 'minimal') {
                for (const sprite of this.agentSprites.values()) {
                    sprite.setToolRitualPose?.(null);
                }
            }
            this._lastRitualPoseMode = 'minimal';
            return;
        }
        if (renderMode === 'compact' && this._ritualSyncFrame % 2 !== 0) return;
        this._lastRitualPoseMode = renderMode;
        const poses = this.ritualConductor?.getAgentPoses?.() || null;
        for (const [agentId, sprite] of this.agentSprites) {
            sprite.setToolRitualPose?.(poses?.get(agentId) || null);
        }
    }

    // Re-trigger ritual admission when a WORKING villager arrives at its
    // building (events emitted mid-walk are rejected by RitualConductor.canAccept).
    _enqueueArrivalRitual(sprite) {
        if (!this._worldModeActive || !this.ritualConductor || !sprite?.agent) return;
        const agent = sprite.agent;
        if (agent.status !== AgentStatus.WORKING || !agent.currentTool) return;
        const building = sprite._lastBuildingType
            || agent.targetBuildingType
            || agent.lastKnownBuildingType
            || null;
        if (!building) return;
        this._syncRitualContext();
        this.ritualConductor.enqueue({
            agentId: agent.id,
            provider: agent.provider || null,
            tool: agent.currentTool,
            input: agent.currentToolInput || null,
            ts: Date.now(),
            building,
        });
    }

    _enqueueSubagentSummonRitual(payload) {
        if (!this._worldModeActive || !this.ritualConductor) return;
        const parentId = payload?.parentId;
        if (!parentId) return;
        // Defensive fallback: AgentEventStream._onAdded should already enrich
        // the dispatched payload, but if subagent_type was added to the world
        // agent after the event fired, surface it here so the ritual label
        // ("SUMMON: code-reviewer") still resolves.
        const childAgent = payload?.childId ? this.world?.agents?.get?.(payload.childId) : null;
        const childAgentName = payload?.childAgentName
            || childAgent?.agentName
            || childAgent?.name
            || null;
        const childSubagentType = payload?.childSubagentType
            || childAgent?.subagent_type
            || childAgent?.subagentType
            || null;
        const targetName = childAgentName || childSubagentType || null;
        this.ritualConductor.enqueue({
            agentId: parentId,
            tool: 'Task',
            input: null,
            ts: payload?.ts || Date.now(),
            building: 'portal',
            childAgentName,
            childSubagentType,
            commandLifecycle: {
                kind: 'spawn',
                targetAgentId: payload?.childId || null,
                targetName,
            },
        });
    }

    _replayActiveToolRituals({ force = false } = {}) {
        const renderMode = this._lastRenderStats?.quality?.agentRenderMode || 'full';
        if (!force && renderMode !== 'full' && this._ritualSyncFrame % 4 !== 0) return 0;
        this._syncRitualContext();
        return this.agentEventStream?.emitInitialToolEvents?.({
            force,
            shouldEmit: (event, agent) => this._canAcceptToolRitual(event, agent),
        }) || 0;
    }

    _handleWorldKeyboardCommand(event) {
        if (!event || !this._worldModeActive || !this.camera) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        if (this._isKeyboardEditTarget(activeElement)) return;
        if (this._isModalOpen()) return;
        // #7 — inside the fleet card the keyboard belongs to the card.
        if (isInFleetCard(activeElement)) return;
        if (event.defaultPrevented) return;
        const blocked = shortcutBlocked(event);
        if (event.code === 'KeyB') {
            if (blocked) return;
            if (event.shiftKey) this.setReadLock(!this._readLocked);
            else this.setReadMode(true);
            event.preventDefault();
            return;
        }

        if (!blocked && event.code === 'KeyH' && !this.stripProfile) {
            this.setTheatreMode(!this.theatreMode);
        } else if (!blocked && event.code === 'KeyG' && this.inspectionGlass?.onKeyDown(event)) {
            this._invalidateIdleFrame();
        } else if (!blocked && event.code === 'KeyC') {
            if (this.focusedSquadIds) this._clearCouncilFocus();
            else this._refreshCouncilFocus();
        } else if (!blocked && event.code === 'KeyP' && event.shiftKey) {
            this.togglePostcardStudio?.();
        } else if (event.code === 'Escape') {
            if (this.postcardStudio?.isOpen()) this.postcardStudio.close();
            else if (this.focusedSquadIds) this._clearCouncilFocus();
            else if (this._readLocked) this.setReadLock(false);
            else if (this.selectedAgent) {
                this.selectAgentById(null);
                this.onAgentSelect?.(null);
            } else if (this.theatreMode) this.setTheatreMode(false);
            else return;
        } else {
            return this._handleCameraKeyboardCommand(event, activeElement);
        }
        event.preventDefault();
    }

    _handleCameraKeyboardCommand(event, activeElement) {
        // Tab cycles agents only while focus rests on the World itself; from
        // the top bar or any other control it moves focus as usual (7.6).
        if (event.code === 'Tab') {
            if (!this._worldOwnsFocus(activeElement)) return;
            if (this._cycleAgentSelection(event.shiftKey ? -1 : 1)) event.preventDefault();
            return;
        }

        const panDeltas = {
            ArrowLeft: { x: KEYBOARD_PAN_STEP, y: 0 },
            ArrowRight: { x: -KEYBOARD_PAN_STEP, y: 0 },
            ArrowUp: { x: 0, y: KEYBOARD_PAN_STEP },
            ArrowDown: { x: 0, y: -KEYBOARD_PAN_STEP },
        };
        const delta = panDeltas[event.code];
        if (delta) {
            this.camera.abortDirectorGlide?.();
            this.camera.stopFollow();
            this.camera.noteUserInput?.();
            this.camera.x += delta.x / Math.max(0.1, this.camera.zoom || 1);
            this.camera.y += delta.y / Math.max(0.1, this.camera.zoom || 1);
            this.camera._clampToBounds?.();
            event.preventDefault();
            return;
        }

        if (event.code === 'Equal' || event.code === 'NumpadAdd') {
            if (this._zoomByKeyboard(1)) event.preventDefault();
            return;
        }
        if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
            if (this._zoomByKeyboard(-1)) event.preventDefault();
            return;
        }
        if (event.code === 'KeyF') {
            // C6 — an explicit frame command is a genuine operator action: it
            // hands Ambient back without touching the auto idle clock.
            this.camera.revokeClaim?.('navigation');
            this.camera.stopFollow();
            this.frameContent();
            event.preventDefault();
            return;
        }
        if (event.code === 'KeyR') {
            this.villageDirector?.toggleReplay?.();
            event.preventDefault();
            return;
        }
        // XP-5 — P strikes a postcard of the current view (Postcard.js).
        if (event.code === 'KeyP' && !event.shiftKey && !event.repeat) {
            this.strikePostcard();
            event.preventDefault();
            return;
        }
    }

    _isKeyboardEditTarget(element) {
        if (!element) return false;
        const tagName = String(element.tagName || '').toUpperCase();
        return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || element.isContentEditable;
    }

    _worldOwnsFocus(element) {
        if (typeof document === 'undefined') return true;
        if (!element || element === document.body || element === document.documentElement) return true;
        if (element === this.canvas) return true;
        // The World dock and its popover live inside #characterMode (9.1), but
        // their controls are ordinary Tab stops: only the World surface itself
        // turns Tab into agent cycling.
        if (element.closest?.('#worldDock, [popover], button, a[href], [role="button"]')) return false;
        if (isInFleetCard(element)) return false;
        return Boolean(document.getElementById('characterMode')?.contains?.(element));
    }

    _isModalOpen() {
        if (this.modal?.overlay?.style?.display === 'flex') return true;
        // An open auto popover (World controls) owns the keyboard: Escape must
        // reach its light-dismiss close request instead of being cancelled here.
        if (typeof document === 'undefined') return false;
        try {
            return Boolean(document.querySelector('[popover]:not([popover="manual"]):popover-open'));
        } catch {
            return false;
        }
    }

    _cycleAgentSelection(direction = 1) {
        const ids = Array.from(this.agentSprites.entries())
            .filter(([, sprite]) => sprite && !this._isGateTransit(sprite, 'departure') && !sprite.isArrivalPending?.())
            .map(([id]) => id);
        if (!ids.length) return false;
        const currentIndex = this.selectedAgent?.id ? ids.indexOf(this.selectedAgent.id) : -1;
        const nextIndex = currentIndex >= 0
            ? (currentIndex + direction + ids.length) % ids.length
            : (direction < 0 ? ids.length - 1 : 0);
        this.selectAgentById(ids[nextIndex]);
        this.onAgentSelect?.(this.selectedAgent || null);
        return Boolean(this.selectedAgent);
    }

    _zoomByKeyboard(direction = 1) {
        const camera = this.camera;
        if (!camera) return false;
        if (typeof camera.zoomByStep === 'function') return camera.zoomByStep(direction);
        const steps = Array.isArray(camera.zoomSteps) && camera.zoomSteps.length
            ? camera.zoomSteps
            : [camera.minZoom || 1, camera.maxZoom || 3];
        const zoom = camera.zoom || 1;
        const currentIndex = steps.reduce((bestIndex, step, index) => (
            Math.abs(step - zoom) < Math.abs(steps[bestIndex] - zoom) ? index : bestIndex
        ), 0);
        const nextIndex = Math.max(0, Math.min(steps.length - 1, currentIndex + direction));
        const targetZoom = steps[nextIndex];
        if (targetZoom === zoom) return false;
        camera.abortDirectorGlide?.();
        camera.noteUserInput?.();
        camera._setZoomAboutCenter?.(targetZoom);
        return true;
    }

    invalidateViewportCaches() {
        this._invalidateIdleFrame();
        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        releaseCanvasBackingStore(this._fastVignetteStamp);
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        releaseCanvasBackingStore(this._poolLayer);
        releaseCanvasBackingStore(this._poolShadeLayer);
        this._poolLayer = null;
        this._poolShadeLayer = null;
        this._poolLayerRect = null;
        releaseCanvasMap(this.lightGradientCache);
        this.skyRenderer?.releaseCache?.();
        this.trailRenderer?.releaseCache?.();
    }

    _screenDpr() {
        return this.canvas?._claudeVilleDpr || 1;
    }

    _screenWidth() {
        return this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || this.canvas?.width || 0;
    }

    _screenHeight() {
        return this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || this.canvas?.height || 0;
    }

    _screenViewport() {
        const width = this._screenWidth();
        const height = this._screenHeight();
        return {
            width,
            height,
            _claudeVilleCssWidth: width,
            _claudeVilleCssHeight: height,
            _claudeVilleDpr: this._screenDpr(),
        };
    }

    _resetScreenTransform(ctx) {
        const dpr = this._screenDpr();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
    }

    _resizeAuxiliaryBackingStores(width, height) {
        const backingWidth = Math.max(0, Math.round(Number(width) || 0));
        const backingHeight = Math.max(0, Math.round(Number(height) || 0));
        for (const surface of [this.fxCanvas, this.overlayCanvas]) {
            if (!surface) continue;
            if (surface.width !== backingWidth) surface.width = backingWidth;
            if (surface.height !== backingHeight) surface.height = backingHeight;
            surface._claudeVilleDpr = this.canvas?._claudeVilleDpr || 1;
            surface._claudeVilleCssWidth = this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || 0;
            surface._claudeVilleCssHeight = this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || 0;
        }
        // 10.3 — on a P3 screen the overlay is display-p3 from its first
        // getContext (App's resize or here; attributes never change later),
        // and its reserved status and C4 hues draw as their P3 variants.
        this.overlayCtx = this.overlayCanvas?.getContext?.('2d', overlayContextAttributes()) || null;
        if (this.overlayCtx) installP3OverlayInks(this.overlayCtx);
        if (this.overlayCtx) SpriteRenderer.disableSmoothing(this.overlayCtx);
        if (backingWidth > 0 && backingHeight > 0) {
            this.postFx?.resize?.(backingWidth, backingHeight);
            this.gpuWorld?.resize?.(backingWidth, backingHeight);
        }
    }

    _setPostFxCanvasVisible(active) {
        const visible = Boolean(active);
        if (this._postFxCanvasVisible === visible) return;
        this._postFxCanvasVisible = visible;
        if (this.fxCanvas) this.fxCanvas.style.display = visible ? 'block' : 'none';
    }

    _addAgentSprite(agent) {
        const existing = this.agentSprites.get(agent.id);
        if (existing) {
            if (existing.applyAgentUpdate) existing.applyAgentUpdate(agent);
            else existing.agent = agent;
            if (this._isGateTransit(existing, 'departure')) {
                this._returnFromGateDeparture(agent, existing);
            }
            this._markSpritesDirty();
            return;
        }
        if (!this.agentSprites.has(agent.id)) {
            const sprite = new WorldAgentSprite(agent, {
                pathfinder: this.pathfinder,
                bridgeTiles: this.bridgeTiles,
                assets: this.assets,
                compositor: this.compositor,
                getIntentForAgent: (agentId) => this.visitIntentManager?.getIntentForAgent?.(agentId) || null,
                getBuilding: (type) => this._getBuildingByType(type),
                getBridgeLift: (tileX, tileY) => this.getBridgeLift(tileX, tileY) || supportHeight(tileX, tileY, this.surfaceRegistry),
                allocateVisitTile: (request) => this._allocateVisitTile(request),
                releaseVisitReservation: (agentId) => this.visitTileAllocator?.release?.(agentId),
                renewVisitReservation: (agentId) => this.visitTileAllocator?.renew?.(agentId),
                getAmbientDestination: (request) => this._getAmbientDestination(request),
                getDayHour: () => this._dayHour(),
                hasLiveSubagents: (agentId) => this._hasLiveSubagents(agentId),
                getBlockedChild: (agentId) => this._blockedChildSprite(agentId),
                getRoadTiles: () => this.pathTiles,
                getRoutingContext: () => ({
                    laneTiles: this.laneTiles,
                    ...this.visitTileAllocator.getCongestionSnapshot(),
                }),
                getTileType: (tileX, tileY) => this._surfaceMaterialAt(tileX, tileY),
                motionClock: this._motionClock,
                getSpeakerTag: (name) => this._speakerTagFor(name),
                getSnowBucket: () => this.propWinter?.bucket || 0,
                onArrive: (arrived) => this._enqueueArrivalRitual(arrived),
                onCelebrationArrived: (celebrant, _pending, until) => notifySquadWatchers(celebrant, this.agentSprites.values(), until),
                isPointWalkable: (x, y) => this._isWorldPointWalkable(x, y),
                // VB-15 — _beginAgentGateArrival places it below.
                deferInitialTarget: true,
            });
            sprite.setMotionScale(this.motionScale);
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
            sprite.addedAt = performance.now();
            // Registered first: the gate entry queue lets in live sprites only.
            this.agentSprites.set(agent.id, sprite);
            this._beginAgentGateArrival(agent, sprite);
            this._primeNickname(sprite);
            this._markSpritesDirty();
        }
    }

    /** 4.8 / W3-D — push cached earned nicknames and patina onto every live sprite. */
    _applyNicknames() {
        if (!this._nicknames) return;
        for (const sprite of this.agentSprites.values()) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            sprite.setNickname?.(identityKey ? this._nicknames.get(identityKey) || null : null);
            sprite._patina = identityKey ? this._patinaByIdentity?.get(identityKey) || null : null;
        }
    }

    _cachePatina(identityKey, biography) {
        if (!identityKey) return;
        this._patinaByIdentity ||= new Map();
        this._benchClaimsByIdentity ||= new Map();
        this._benchPatinaBySeat ||= new Map();
        const collaborators = this.affinityService?.collaboratorsFor?.(identityKey) ?? [];
        const patina = biography ? patinaFor(biography, collaborators) : null;
        this._patinaByIdentity.delete(identityKey);
        if (patina) this._patinaByIdentity.set(identityKey, patina);
        const bench = patina?.theirBench?.seatId ? patina.theirBench : null;
        this._benchClaimsByIdentity.delete(identityKey);
        if (bench) this._benchClaimsByIdentity.set(identityKey, bench);
        rebuildBenchPatina(this);
        this._pruneNicknameCache?.();
    }

    _cacheNickname(identityKey, nickname) {
        if (!identityKey) return;
        this._nicknames.delete(identityKey);
        if (nickname) this._nicknames.set(identityKey, nickname);
        this._pruneNicknameCache();
    }

    _pruneNicknameCache() {
        const overNicknames = (this._nicknames?.size || 0) > NICKNAME_CACHE_LIMIT;
        const overPatina = (this._patinaByIdentity?.size || 0) > NICKNAME_CACHE_LIMIT;
        const overBench = (this._benchClaimsByIdentity?.size || 0) > NICKNAME_CACHE_LIMIT;
        if (!overNicknames && !overPatina && !overBench) return;
        const liveIdentityKeys = new Set();
        for (const sprite of this.agentSprites?.values?.() || []) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            if (identityKey) liveIdentityKeys.add(identityKey);
        }
        if (overNicknames) {
            for (const identityKey of this._nicknames.keys()) {
                if (this._nicknames.size <= NICKNAME_CACHE_LIMIT) break;
                if (!liveIdentityKeys.has(identityKey)) this._nicknames.delete(identityKey);
            }
        }
        if (overPatina) {
            for (const identityKey of this._patinaByIdentity.keys()) {
                if (this._patinaByIdentity.size <= NICKNAME_CACHE_LIMIT) break;
                if (!liveIdentityKeys.has(identityKey)) this._patinaByIdentity.delete(identityKey);
            }
        }
        if (overBench) {
            let benchChanged = false;
            for (const identityKey of this._benchClaimsByIdentity.keys()) {
                if (this._benchClaimsByIdentity.size <= NICKNAME_CACHE_LIMIT) break;
                if (!liveIdentityKeys.has(identityKey)) {
                    this._benchClaimsByIdentity.delete(identityKey);
                    benchChanged = true;
                }
            }
            if (benchChanged) rebuildBenchPatina(this);
        }
    }

    /** 4.8 — seed a new sprite's nickname from its persisted biography. */
    _primeNickname(sprite) {
        if (!this.biographyService || !sprite?.agent) return;
        const identityKey = AgentBiography.identityKeyFor(sprite.agent);
        if (!identityKey) return;
        if (this._nicknames.has(identityKey)) {
            const nickname = this._nicknames.get(identityKey);
            this._cacheNickname(identityKey, nickname);
            sprite.setNickname?.(nickname);
            if (this._patinaByIdentity?.has(identityKey)) {
                sprite._patina = this._patinaByIdentity.get(identityKey) || null;
            }
            return;
        }
        const biographyService = this.biographyService;
        const generation = this._biographyReadGeneration;
        const agentId = sprite.agent.id;
        biographyService.getBiography(identityKey).then((biography) => {
            if (
                this._disposed
                || generation !== this._biographyReadGeneration
                || this.agentSprites.get(agentId) !== sprite
                || AgentBiography.identityKeyFor(sprite.agent) !== identityKey
            ) return;
            const nickname = biography?.nickname || null;
            this._cachePatina(identityKey, biography || null);
            sprite._patina = this._patinaByIdentity.get(identityKey) || null;
            if (!nickname) return;
            this._cacheNickname(identityKey, nickname);
            sprite.setNickname?.(nickname);
        }).catch(() => {});
    }

    /**
     * 2.4 — affinity-driven proximity: the warmest 'allies' pairs of idle
     * villagers share a plaza preference (same 30 s TTL mechanism as
     * parent/child clustering), so long-standing collaborators idle together
     * while strangers keep their default spread.
     */
    _applyAffinityProximity(now = Date.now()) {
        this._allyTetherPairs = [];
        const snapshot = this.affinityService?.getSnapshot?.();
        if (!snapshot?.size) return;
        const spriteByIdentity = new Map();
        for (const sprite of this.agentSprites.values()) {
            if (sprite.agent?.status !== AgentStatus.IDLE) continue;
            if (sprite.isArrivalPending?.() || this._isGateTransit(sprite)) continue;
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            if (identityKey && !spriteByIdentity.has(identityKey)) {
                spriteByIdentity.set(identityKey, sprite);
            }
        }
        if (spriteByIdentity.size < 2) return;
        const pairs = [];
        for (const affinity of snapshot.values()) {
            if (affinity?.tier?.(now) !== 'allies') continue;
            const a = spriteByIdentity.get(affinity.identityA);
            const b = spriteByIdentity.get(affinity.identityB);
            if (!a || !b || a === b) continue;
            pairs.push({ a, b, score: affinity.decayedScore?.(now) || 0 });
        }
        if (!pairs.length) return;
        pairs.sort((x, y) => y.score - x.score);
        const top = pairs.slice(0, MAX_AFFINITY_PROXIMITY_PAIRS);
        // Hold the warmest idle pairs so the frame renderer can draw their
        // tethers; the sprite refs stay live, so endpoints track movement.
        this._allyTetherPairs = top;
        for (const { a, b } of top) {
            const tileA = worldToTile(a.x, a.y);
            const tileB = worldToTile(b.x, b.y);
            const midX = (tileA.tileX + tileB.tileX) / 2;
            const midY = (tileA.tileY + tileB.tileY) / 2;
            a.setFamilyPlazaPreference?.(midX, midY);
            b.setFamilyPlazaPreference?.(midX, midY);
        }
    }

    _parentSpriteFor(agent, { requireWorldAgent = false } = {}) {
        const parentId = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (requireWorldAgent && parentId && !this.world?.agents?.has?.(parentId)) return null;
        return parentId ? this.agentSprites.get(parentId) : null;
    }

    _beginRelationshipArrival(agent) {
        if (this.replay?.recorded) return false;
        const sprite = this.agentSprites.get(agent?.id);
        if (!sprite || !this.arrivalDeparture) return false;
        const parentSprite = this._parentSpriteFor(agent);
        const now = performance.now();
        if (parentSprite) {
            // 6.3 — the dispatch comet flies 2–3 tiles from the parent to a
            // free visit tile, so the arc reads and the bodies never stack.
            // Reduced motion lands the child on the same tile without a comet.
            const landing = this._subagentLandingTile(agent, parentSprite);
            if (landing) sprite.setTilePosition?.(landing.tileX, landing.tileY);
            const started = this.arrivalDeparture.beginSubagentDispatch(parentSprite, sprite, {
                now,
                onLanded: () => this._resolveLandingOverlap(sprite),
            });
            // The pending state dropped any reservation; hold the landing visit
            // tile for the child so its first visit pick keeps it there instead
            // of walking back into its parent's cluster.
            if (landing?.building && landing.tile) {
                this.visitTileAllocator?.allocate?.({ agent, sprite, building: landing.building, candidates: [landing.tile] });
            }
            if (started || this.motionScale <= 0) {
                this.gateTransits.delete(agent.id);
                if (this._portalEntryQueue?.length) {
                    this._portalEntryQueue = this._portalEntryQueue.filter(entry => entry.sprite !== sprite);
                }
                if (!started) this._resolveLandingOverlap(sprite);
                this._markSpritesDirty();
                return true;
            }
            return false;
        }
        // 6.2 — top-level sessions keep the gate walk-in: _beginAgentGateArrival
        // placed the body outside the gate, the materialize beat plays there,
        // and the walk resumes when the body lands. Reduced motion leaves the
        // body inside the gate with the static rune notch only.
        const started = this.arrivalDeparture.beginAgentArrival(agent, sprite, {
            now,
            onLanded: () => {
                if (this.agentSprites.get(agent.id) !== sprite || sprite.leaving) return;
                if (this._isGateTransit(sprite, 'departure')) return;
                this._walkInThroughGate(agent, sprite);
                this._markSpritesDirty();
            },
        });
        if (started) this._markSpritesDirty();
        return Boolean(started);
    }

    // Where a dispatched child lands: a free tile 2–3 tiles from its parent.
    // Building visit tiles in that band come first (the child lands where work
    // happens); otherwise a walkable tile on a 2.5-tile ring. A tile is free
    // when no live body stands within 0.9 tiles and no other agent holds a
    // visit reservation on it.
    _subagentLandingTile(agent, parentSprite) {
        const parentTile = typeof parentSprite?._screenToTile === 'function'
            ? parentSprite._screenToTile(parentSprite.x, parentSprite.y)
            : null;
        if (!parentTile || !Number.isFinite(parentTile.tileX) || !Number.isFinite(parentTile.tileY)) return null;
        const bodies = [];
        for (const other of this.agentSprites.values()) {
            if (!other || other.agent?.id === agent?.id || other.leaving) continue;
            const tile = other._screenToTile?.(other.x, other.y);
            if (tile && Number.isFinite(tile.tileX) && Number.isFinite(tile.tileY)) bodies.push(tile);
        }
        const reservations = this.visitTileAllocator?.reservations;
        const clearance = this._ensureWalkClearance?.();
        const isFree = (tileX, tileY) => {
            if (clearance) {
                if (!clearance.isTileClear(tileX, tileY)) return false;
            } else if (this.pathfinder && (!this.pathfinder.isWalkable(Math.round(tileX), Math.round(tileY)) || inVillageMasonry(tileX, tileY))) {
                return false;
            }
            for (const body of bodies) {
                const dx = body.tileX - tileX;
                const dy = body.tileY - tileY;
                if (dx * dx + dy * dy < 0.81) return false;
            }
            if (reservations) {
                for (const reservation of reservations.values()) {
                    if (reservation.agentId === agent?.id) continue;
                    const dx = reservation.tileX - tileX;
                    const dy = reservation.tileY - tileY;
                    if (dx * dx + dy * dy < 0.36) return false;
                }
            }
            return true;
        };
        const jitter = this._gateJitter(agent, 'land-side', 1) + 0.5;
        // The child joins its parent's work, so the parent's building wins a
        // tie; any building's visit tile in the band beats open ground.
        const parentBuilding = parentSprite.getBehaviorDebugSnapshot?.()?.building || null;
        let best = null;
        let bestScore = Infinity;
        for (const building of this.world?.buildings?.values?.() || []) {
            for (const tile of building?.visitTiles || []) {
                const tileX = Number(tile?.tileX);
                const tileY = Number(tile?.tileY);
                if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
                const dist = Math.hypot(tileX - parentTile.tileX, tileY - parentTile.tileY);
                if (dist < 2 || dist > 3.25) continue;
                if (!isFree(tileX, tileY)) continue;
                const score = Math.abs(dist - 2.5)
                    + (building.type === parentBuilding ? 0 : 1)
                    + ((this._gateJitter(agent, `land:${tileX},${tileY}`, 1) + 0.5) * 0.3);
                if (score < bestScore) {
                    best = { tileX, tileY, building, tile };
                    bestScore = score;
                }
            }
        }
        if (best) return best;
        const steps = 12;
        const first = Math.floor(jitter * steps) % steps;
        for (const radius of [2.5, 2, 3]) {
            for (let i = 0; i < steps; i++) {
                const angle = ((first + i) % steps) / steps * Math.PI * 2;
                const tileX = parentTile.tileX + Math.cos(angle) * radius;
                const tileY = parentTile.tileY + Math.sin(angle) * radius;
                if (isFree(tileX, tileY)) return { tileX, tileY };
            }
        }
        return null;
    }

    // After a dispatched child lands, a body that walked onto its tile during
    // the flight sends the child to its own visit instead of stacking.
    _resolveLandingOverlap(sprite) {
        if (!sprite || sprite.leaving || this.agentSprites.get(sprite.agent?.id) !== sprite) return;
        for (const other of this.agentSprites.values()) {
            if (other === sprite || other.leaving || other.isArrivalPending?.()) continue;
            if (Math.hypot(other.x - sprite.x, other.y - sprite.y) < 20) {
                if (sprite.retargetVisit?.()) this._markSpritesDirty();
                return;
            }
        }
    }

    _beginRelationshipDeparture(agent) {
        const sprite = this.agentSprites.get(agent?.id);
        const parentSprite = this._parentSpriteFor(agent, { requireWorldAgent: true });
        const now = performance.now();

        if (parentSprite) {
            const childPoint = sprite
                ? { x: sprite.x, y: sprite.y }
                : { x: parentSprite.x, y: parentSprite.y };
            const merge = sprite
                ? this.arrivalDeparture?.beginSubagentMerge?.(
                    agent,
                    childPoint,
                    parentSprite,
                    { now },
                )
                : null;
            if (!merge) {
                this.arrivalDeparture?.recordSubagentCompletion?.(
                    agent,
                    childPoint,
                    parentSprite,
                    { now },
                );
            }
            if (sprite) this._removeAgentSprite(agent.id);
            return true;
        }

        const lastTile = sprite && typeof sprite._screenToTile === 'function'
            ? sprite._screenToTile(sprite.x, sprite.y)
            : (agent?.position ? {
                tileX: agent.position.tileX ?? agent.position.x,
                tileY: agent.position.tileY ?? agent.position.y,
            } : null);

        // Orphan subagent: parent vanished mid-flight. Animate a return wisp to
        // the Portal Gate instead of fading in place at the child's last tile.
        const parentRef = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (parentRef) {
            const portalScreenPoint = this._tileToWorld(PORTAL_SPAWN_TILE.tileX, PORTAL_SPAWN_TILE.tileY);
            this.arrivalDeparture?.recordOrphanReturn?.(agent, lastTile, portalScreenPoint, { now });
            if (sprite) this._removeAgentSprite(agent.id);
            return true;
        }

        // EF-2 — a body that walks out takes the column at the gate, whose
        // residue is its sigil; without motion the sigil lands where it stands.
        if (this.motionScale <= 0) this.arrivalDeparture?.recordDeparture?.(agent, lastTile, { now, parentAlive: false });
        return false;
    }

    _gateJitter(agent, axis = 'x', amount = 0.18) {
        const seed = String(agent?.id || '') + axis;
        let hash = 0;
        for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
        const unit = ((hash >>> 0) / 4294967295) - 0.5;
        return unit * amount;
    }

    _beginAgentGateArrival(agent, sprite) {
        if (!sprite) return;
        if (this.replay?.recorded) {
            sprite.setTilePosition(agent.position.tileX, agent.position.tileY);
            return;
        }

        // Subagents emerge from the Portal Gate through a two-lane release
        // queue (matching the village gate queue) so simultaneous arrivals
        // never stack on PORTAL_SPAWN_TILE; with motion, mid-session dispatch
        // comets (6.3) relocate them beside the parent instead.
        const parentRef = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (parentRef) {
            if (this.motionScale <= 0) {
                sprite.setTilePosition?.(
                    PORTAL_SPAWN_TILE.tileX + this._gateJitter(agent, 'portal-x', 0.32),
                    PORTAL_SPAWN_TILE.tileY + this._gateJitter(agent, 'portal-y', 0.22),
                );
                return;
            }
            sprite.setTilePosition?.(PORTAL_SPAWN_TILE.tileX, PORTAL_SPAWN_TILE.tileY);
            this._walkInThroughPortal(agent, sprite);
            return;
        }

        if (this.motionScale <= 0) {
            sprite.setTilePosition?.(
                VILLAGE_GATE.inside.tileX + this._gateJitter(agent, 'arrival-x', 0.32),
                VILLAGE_GATE.inside.tileY + this._gateJitter(agent, 'arrival-y', 0.22),
            );
            return;
        }

        sprite.setTilePosition?.(
            VILLAGE_GATE.outside.tileX + this._gateJitter(agent, 'outside-x', 0.28),
            VILLAGE_GATE.outside.tileY + this._gateJitter(agent, 'outside-y', 0.18),
        );
        this._walkInThroughGate(agent, sprite);
    }

    // 7.4 — the walk-in joins the gate entry queue; a clear gate mouth lets
    // it in at once, otherwise it waits hidden (pending) for its turn.
    _walkInThroughGate(agent, sprite) {
        const queue = this._gateEntryQueue ||= [];
        if (!queue.some(entry => entry.sprite === sprite)) queue.push({ agent, sprite });
        sprite.setArrivalState?.('pending');
        this._releaseGateEntries();
    }

    // Lets the head of the gate entry queue in through the first gate lane
    // whose entry point has no visible body within GATE_ENTRY_GAP_PX (the
    // body just let in blocks its own lane). An entry whose villager left,
    // departs or is shown by someone else drops.
    _releaseGateEntries() {
        const queue = this._gateEntryQueue;
        while (queue?.length) {
            const { agent, sprite } = queue[0];
            const live = this.agentSprites.get(agent.id);
            if (live !== sprite || sprite.leaving || sprite._archiveAnim || !sprite.isArrivalPending?.() || this._isGateTransit(sprite, 'departure')) {
                queue.shift();
                if (sprite._archiveAnim || live !== sprite) this.gateTransits.delete(agent.id);
                continue;
            }
            const lane = GATE_ENTRY_LANES.find(entry => this._gateLaneClear(entry));
            if (!lane) return;
            queue.shift();
            sprite.setTilePosition?.(lane.tileX, lane.outsideY);
            sprite.walkStraightToTile?.(lane.tileX, lane.insideY);
            this.gateTransits.set(agent.id, { type: 'arrival', gate: true, lane, since: Date.now() });
            this._markSpritesDirty();
        }
    }

    // True when no visible body stands within `gapPx` of the lane's entry
    // point. Parallel arrival lanes ignore bodies already walking in on a
    // different lane of the same gate so two files enter abreast even when
    // lane entries sit closer than GATE_ENTRY_GAP_PX (21.5 px at the arch).
    _gateLaneClear(lane, { gapPx = GATE_ENTRY_GAP_PX, portal = false } = {}) {
        const entry = tileToWorld(lane.tileX, lane.outsideY);
        const gapSq = gapPx * gapPx;
        for (const other of this.agentSprites.values()) {
            if (other.isArrivalPending?.() || other._archiveAnim) continue;
            const transit = this.gateTransits?.get?.(other.agent?.id);
            if (transit?.type === 'arrival' && transit.lane && transit.lane !== lane && Boolean(transit.portal) === Boolean(portal)) {
                continue;
            }
            const dx = other.x - entry.x;
            const dy = other.y - entry.y;
            if (dx * dx + dy * dy < gapSq) return false;
        }
        return true;
    }

    // 7.4 — subagent Portal arrivals join a two-lane release queue so fleets
    // emerge spaced by at least PORTAL_ENTRY_GAP_PX instead of piling on one
    // tile.
    _walkInThroughPortal(agent, sprite) {
        const queue = this._portalEntryQueue ||= [];
        if (!queue.some(entry => entry.sprite === sprite)) {
            queue.push({ agent, sprite, queuedAt: Date.now() });
        }
        sprite.setArrivalState?.('pending');
        if (!this._deferPortalRelease) this._releasePortalEntries();
    }

    _releasePortalEntries(now = Date.now()) {
        const queue = this._portalEntryQueue;
        if (!queue?.length) return;
        // Cold-load burst arriving on the first populated snapshot: count both
        // still-queued subagents and any already-released Portal arrivals from
        // the same cold burst so the > PORTAL_COLD_SETTLE_LIMIT threshold
        // settles consistently from 5 on both init and snapshot paths.
        if (!this._coldPortalSettled && !this.replay?.recorded) {
            const liveBurst = [];
            const seenBurst = new Set();
            for (const [agentId, transit] of this.gateTransits.entries()) {
                if (transit?.type !== 'arrival' || !transit.portal) continue;
                const sprite = this.agentSprites.get(agentId);
                if (!sprite || sprite.leaving || sprite._archiveAnim) {
                    this.gateTransits.delete(agentId);
                    continue;
                }
                if (!seenBurst.has(sprite)) {
                    seenBurst.add(sprite);
                    liveBurst.push(sprite);
                }
            }
            for (const entry of queue) {
                const live = this.agentSprites.get(entry.agent?.id);
                if (live === entry.sprite && !entry.sprite.leaving && !entry.sprite._archiveAnim
                    && entry.sprite.isArrivalPending?.() && !this._isGateTransit(entry.sprite, 'departure')
                    && !seenBurst.has(entry.sprite)) {
                    seenBurst.add(entry.sprite);
                    liveBurst.push(entry.sprite);
                }
            }
            if (liveBurst.length > PORTAL_COLD_SETTLE_LIMIT) {
                this._coldPortalSettled = true;
                this._updateVisitSystems(now);
                this._settlePortalColdBurst(liveBurst);
                return;
            }
        }
        while (queue.length) {
            const entry = queue[0];
            const { agent, sprite } = entry;
            const live = this.agentSprites.get(agent.id);
            if (live !== sprite || sprite.leaving || sprite._archiveAnim || !sprite.isArrivalPending?.() || this._isGateTransit(sprite, 'departure')) {
                queue.shift();
                if (sprite._archiveAnim || live !== sprite) this.gateTransits.delete(agent.id);
                continue;
            }
            if (!Number.isFinite(entry.queuedAt)) entry.queuedAt = now;
            if (now - entry.queuedAt >= PORTAL_QUEUE_MAX_WAIT_MS) {
                queue.shift();
                this.gateTransits.delete(agent.id);
                this.arrivalDeparture?.dispatches?.delete?.(agent.id);
                sprite.settleAtDestination?.();
                this._markSpritesDirty();
                continue;
            }
            const lane = PORTAL_ENTRY_LANES.find(l => this._gateLaneClear(l, { gapPx: PORTAL_ENTRY_GAP_PX, portal: true }));
            if (!lane) return;
            queue.shift();
            sprite.setTilePosition?.(lane.tileX, lane.outsideY);
            sprite.walkStraightToTile?.(lane.tileX, lane.insideY);
            this.gateTransits.set(agent.id, { type: 'arrival', gate: true, portal: true, lane, since: now });
            this._markSpritesDirty();
        }
    }

    // Settle a cold-load burst of > 4 subagents directly at their allocated
    // destinations so the initial fleet never forms a Portal pile-up.
    _settlePortalColdBurst(sprites) {
        if (!sprites?.length) return;
        const settledSet = new Set(sprites);
        if (this._portalEntryQueue?.length) {
            this._portalEntryQueue = this._portalEntryQueue.filter(entry => !settledSet.has(entry.sprite));
        }
        const burstAgents = [];
        for (const sprite of sprites) {
            if (!sprite || sprite.leaving) continue;
            const agentId = sprite.agent?.id;
            if (agentId) {
                this.gateTransits.delete(agentId);
                this.arrivalDeparture?.dispatches?.delete?.(agentId);
            }
            if (sprite.agent) burstAgents.push(sprite.agent);
        }
        if (burstAgents.length > 0) {
            this._dispatchVisitSlotBatches(burstAgents, Date.now(), { includePending: true });
        }
        for (const sprite of sprites) {
            if (!sprite || sprite.leaving) continue;
            sprite.settleAtDestination?.();
        }
        this.visitTileAllocator?.updateContext?.({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });
        this._markSpritesDirty();
    }

    _beginAgentGateDeparture(agent) {
        const sprite = this.agentSprites.get(agent.id);
        if (!sprite || this.motionScale <= 0) {
            this._removeAgentSprite(agent.id);
            return;
        }

        sprite.selected = false;
        // Walk out as the villager it was, not as the grey departed tableau.
        sprite.leaving = true;
        sprite.walkToTile?.(
            VILLAGE_GATE.outside.tileX + this._gateJitter(agent, 'depart-x', 0.30),
            VILLAGE_GATE.outside.tileY + this._gateJitter(agent, 'depart-y', 0.20),
        );
        this.gateTransits.set(agent.id, { type: 'departure', since: Date.now() });
        this._markSpritesDirty();
    }

    // A villager leaves the moment its agent departs; the exit runs once.
    // Subagents merge back into their parent, orphans return to the Portal
    // Gate, and top-level sessions walk out through the village gate.
    _beginAgentDeparture(agent) {
        if (this.replay?.recorded) return this._removeAgentSprite(agent.id, { fade: false });
        const sprite = this.agentSprites.get(agent?.id);
        if (!sprite || sprite._archiveAnim || this._isGateTransit(sprite, 'departure')) return;
        const handled = this._beginRelationshipDeparture(agent);
        if (!handled) this._beginAgentGateDeparture(agent);
    }

    // EF-2 — a walk out has reached the gate's arch mouth: the column takes
    // the body home from its own captured silhouette, so the body goes in
    // this frame with no fade. Without a column (reduced motion, six at the
    // gate already) the sigil lands here alone and the body keeps its fade.
    _finishGateDeparture(agentId) {
        const sprite = this.agentSprites.get(agentId);
        if (!sprite) return;
        const now = performance.now();
        const column = this.arrivalDeparture?.beginDeparture?.(sprite.agent, sprite, { now }) || null;
        if (!column) {
            const tile = typeof sprite._screenToTile === 'function' ? sprite._screenToTile(sprite.x, sprite.y) : null;
            this.arrivalDeparture?.recordDeparture?.(sprite.agent, tile, { now });
        }
        this._removeAgentSprite(agentId, { fade: !column });
    }

    // Session came back while its villager was still walking to the gate:
    // turn around where it stands instead of popping back to the gate.
    _returnFromGateDeparture(agent, sprite) {
        this.gateTransits.delete(agent.id);
        sprite.leaving = false;
        sprite.retargetVisit?.();
        this._markSpritesDirty();
    }

    _removeAgentSprite(agentId, { fade = true } = {}) {
        const sprite = this.agentSprites.get(agentId);
        if (!sprite) return;
        if (this.selectedAgent?.id === agentId) {
            this.selectedAgent = null;
            this.camera?.stopFollow?.();
        }
        this.gateTransits.delete(agentId);
        if (this._gateEntryQueue?.length) {
            this._gateEntryQueue = this._gateEntryQueue.filter(entry => entry.sprite !== sprite);
        }
        if (this._portalEntryQueue?.length) {
            this._portalEntryQueue = this._portalEntryQueue.filter(entry => entry.sprite !== sprite);
        }
        this.visitTileAllocator?.release?.(agentId);
        // Archive fade: defer the actual sprite disposal by
        // ARCHIVE_FADE_DURATION_MS so AgentSprite.draw() fade alpha + sparkle
        // puff can play. The sprite stays in agentSprites and is collected by
        // _pruneArchiveFadedSprites(). Reduced motion (motionScale === 0)
        // short-circuits to immediate disposal — there is no fade to play —
        // and so does a departure long over when the world is shown again
        // (`fade: false`, VB-4).
        const motionScale = this.motionScale ?? 1;
        if (fade && motionScale > 0 && !sprite._archiveAnim) {
            sprite._archiveAnim = {
                startedAt: Date.now(),
                total: ARCHIVE_FADE_DURATION_MS,
                agent: sprite.agent,
            };
            sprite.selected = false;
            this._markSpritesDirty();
            return;
        }
        sprite.releaseRenderResources?.();
        this.agentSprites.delete(agentId);
        this._markSpritesDirty();
    }

    // Sweep archive-fading sprites whose fade window has elapsed.
    // Called once per frame from `_update`.
    _pruneArchiveFadedSprites(nowMs = Date.now()) {
        let removed = false;
        for (const [agentId, sprite] of this.agentSprites) {
            const anim = sprite._archiveAnim;
            if (!anim) continue;
            if (nowMs - anim.startedAt >= anim.total) {
                this.gateTransits.delete(agentId);
                sprite.releaseRenderResources?.();
                this.agentSprites.delete(agentId);
                removed = true;
            }
        }
        if (removed) this._markSpritesDirty();
    }

    _isGateTransit(sprite, type = null) {
        const transit = this.gateTransits.get(sprite?.agent?.id);
        return Boolean(transit && (!type || transit.type === type));
    }

    _isInGateChannelZone(sprite) {
        if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return false;
        const halfW = TILE_WIDTH * 0.5;
        const halfH = TILE_HEIGHT * 0.5;
        const tx = (sprite.x / halfW + sprite.y / halfH) * 0.5;
        const ty = (sprite.y / halfH - sprite.x / halfW) * 0.5;
        return Math.abs(tx - VILLAGE_GATE.tileX) <= 1.2 && ty >= 36.6 && ty <= 40.2;
    }

    _isGateChannelTransit(sprite) {
        const transit = this.gateTransits.get(sprite?.agent?.id);
        if (!transit) return false;
        if (transit.gate) return true;
        // Departing villagers stay inside ORCA throughout their walk across the
        // village and only switch to gate-channel transit once physically in the gate channel.
        if (transit.type === 'departure') {
            if (!Number.isFinite(sprite?.x) || !Number.isFinite(sprite?.y)) return true;
            return this._isInGateChannelZone(sprite);
        }
        return false;
    }

    _updateGateDoorState(now = performance.now()) {
        for (const [agentId] of this.gateTransits) {
            const sprite = this.agentSprites.get(agentId);
            if (!sprite || sprite._archiveAnim) this.gateTransits.delete(agentId);
        }
        const wasOpen = this.gateDoorsOpen;
        const wantOpen = this.gateTransits.size > 0 || this._hasAgentNearGate();
        if (wantOpen) this._gateDoorsOpenUntilMs = now + 1500; // 1.5s grace timer
        this.gateDoorsOpen = wantOpen || now < this._gateDoorsOpenUntilMs;
        // The gatehouse and its threshold glow paint from caches (the gate's
        // depth slices share one), so a door flip must repaint them.
        if (this.gateDoorsOpen !== wasOpen) {
            for (const sprite of this._gateDoorStateSprites) sprite.invalidateCache();
        }
    }

    // 5.2 — steps the flora props' winter state from the season and the C-W2
    // snow bucket (called once a frame after the ground state). A step drops
    // the derived images and repaints the sorted flora props; the `cache`
    // layer ones and the bridge rebake with the terrain, whose key already
    // carries the season and the snow bucket.
    _syncPropWinter() {
        if (!this.propWinter.sync(this._currentSeasonToken(), this._groundState?.snowCover)) return;
        for (const sprite of this._winterPropSprites || []) sprite.invalidateCache();
    }

    _winterPropOpts(id) {
        const image = this.propWinter.image(id);
        return image ? { image } : NO_PROP_OPTS;
    }

    // Note: when motionScale=0, _beginAgentGateArrival short-circuits BEFORE
    // adding to gateTransits, so doors stay closed during reduced-motion
    // spawns. This mirrors the no-walk policy: if the agent doesn't visibly
    // walk in, the doors don't visibly open.
    _hasAgentNearGate() {
        const minTileX = 17;
        const maxTileX = 21;
        const minTileY = 38;
        const maxTileY = 39.5;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            if (tile.tileX >= minTileX && tile.tileX <= maxTileX
                && tile.tileY >= minTileY && tile.tileY <= maxTileY) {
                return true;
            }
        }
        return false;
    }

    _surfaceHidesBody(surface, sprite) {
        if (!surface || surface.h <= 0) return false;
        const h = sprite._currentBridgeLift?.() || 0;
        // Upright cutout height at the pointer, measured from the lifted foot.
        const bodyH = Math.max(h, sprite.y - surface.y);
        return surface.d > 2 * sprite.y + bodyH / 2;
    }

    _handleClick(worldX, worldY, touch = false) {
        if (!this.agentSprites.size && !this.buildingRenderer) return;
        this._invalidateIdleFrame();

        let clicked = null;
        const surface = pickSurfaceAtWorld(worldX, worldY);

        // Per-pixel agent hit test (sorted: most front first)
        const sorted = Array.from(this.agentSprites.values())
            .sort((a, b) => b.y - a.y);            // front-most first
        for (const sprite of sorted) {
            if (this._isGateTransit(sprite, 'departure')) continue;
            if (sprite.hitTest(worldX, worldY) && !this._surfaceHidesBody(surface, sprite)) {
                clicked = sprite;
                break;
            }
        }

        // 4.4 / 4.7 — a selectable building instrument (a Forge result tile, a
        // task-board plan tab) selects the session it belongs to through the
        // ordinary selection flow, so the panel opens that session's existing
        // detail record. Agents still win: a body in front of a tile is the
        // thing the operator clicked.
        if (!clicked) {
            const instrument = this.buildingRenderer?.hitTestInstrument?.(worldX, worldY) ?? null;
            const instrumentAgent = instrument?.agentId
                ? (this.agentSprites.get(instrument.agentId)?.agent
                    || this.world?.agents?.get?.(instrument.agentId)
                    || null)
                : null;
            if (instrumentAgent) {
                this.selectAgentById(instrumentAgent.id);
                if (this.onAgentSelect) this.onAgentSelect(instrumentAgent);
                return;
            }
        }
        // Exact instruments and buildings keep their precedence.
        // Only a miss gains the finger-sized margin around a selectable body.
        if (!clicked && touch && !this.buildingRenderer?.hitTest(worldX, worldY)) {
            const radius = 22 / this.camera.zoom;
            let nearest = radius * radius;
            for (const sprite of sorted) {
                if (this._isGateTransit(sprite, 'departure') || sprite.isArrivalPending() || this._surfaceHidesBody(surface, sprite)) continue;
                const box = sprite._bodyBox;
                const x = sprite._placeX ?? sprite.x;
                const y = sprite._placeY ?? sprite.y;
                const dx = Math.max(x + (box?.left ?? -17) - worldX, 0, worldX - x - (box?.right ?? 17));
                const dy = Math.max(y + (box?.top ?? -58) - worldY, 0, worldY - y - Math.max(box?.bottom ?? 3, 4));
                const distance = dx * dx + dy * dy;
                if (distance < nearest) {
                    nearest = distance;
                    clicked = sprite;
                }
            }
        }

        // U-P3 — a ship opens its fleet card and leaves the selection alone:
        // the operator is reading cargo, not dismissing the agent.
        if (!clicked) {
            const ship = this.harborTraffic?.hitTestShip?.(worldX, worldY) ?? null;
            if (ship) {
                this._openFleetCard({ project: ship.project, branch: ship.branch || '', shipId: ship.id });
                return;
            }
        }
        this._closeFleetCard();

        // Deselect all
        for (const sprite of this.agentSprites.values()) sprite.selected = false;

        if (clicked) {
            clicked.selected = true;
            this.selectedAgent = clicked.agent;
            this.camera.followAgent(clicked);
            if (this.onAgentSelect) this.onAgentSelect(clicked.agent);
            return;
        }

        this.selectedAgent = null;
        this.camera.stopFollow();
        if (this.onAgentSelect) this.onAgentSelect(null);

        // No agent hit; fall through to building selection. Renderer state for
        // building selection is owned downstream; we only emit.
        const building = this.buildingRenderer?.hitTest(worldX, worldY) ?? null;
        if (building) {
            eventBus.emit(BUILDING_EVENTS.SELECTED, building);
        } else {
            eventBus.emit(BUILDING_EVENTS.DESELECTED);
        }
    }

    // 3.7 — rAF-throttled agent hover hit-test. The mousemove handler records
    // the latest world position; at most one front-most-first per-pixel sweep
    // (same geometry and skip rule as _handleClick) runs per frame.
    _scheduleAgentHoverTest(worldX, worldY) {
        this._agentHoverX = worldX;
        this._agentHoverY = worldY;
        if (this._agentHoverRafId !== null) return;
        this._agentHoverRafId = requestAnimationFrame(() => {
            this._agentHoverRafId = null;
            if (this._disposed) return;
            const hit = this._applyAgentHover(this._agentHoverX, this._agentHoverY);
            const plate = this._hoverPlateContent(hit, this._hoverLore);
            if (this._hoverPoint) this._ensureHoverPlate()?.update(plate.text, this._hoverPoint, plate.target, plate.key ?? plate.text);
        });
    }

    // XP-4 — what is under the resting pointer now: the plate re-reads it when
    // it reveals and while the scene moves beneath a still pointer, so a
    // villager that walked off takes its plate with it.
    _sampleHoverPlate() {
        const point = this._hoverPoint;
        if (!point || !this.camera) return null;
        const world = this.camera.screenToWorld(point.x, point.y);
        const lore = this._worldHoverInfo(world.x, world.y);
        this._hoverLore = lore;
        return this._hoverPlateContent(this._applyAgentHover(world.x, world.y), lore);
    }

    _refreshHoverPlate(now = performance.now()) {
        const plate = this._hoverPlate;
        if (!plate?.tracking || !this._hoverPoint || now - (this._hoverPlateSampledAt || 0) < HOVER_PLATE_RESAMPLE_MS) return;
        this._hoverPlateSampledAt = now;
        const sample = this._sampleHoverPlate();
        if (sample) plate.update(sample.text, this._hoverPoint, sample.target, sample.key ?? sample.text);
    }

    _applyAgentHover(worldX, worldY) {
        const surface = pickSurfaceAtWorld(worldX, worldY);
        let hit = null;
        if (this.agentSprites.size) {
            const sorted = Array.from(this.agentSprites.values())
                .sort((a, b) => b.y - a.y);            // front-most first
            for (const sprite of sorted) {
                if (this._isGateTransit(sprite, 'departure')) continue;
                if (sprite.hitTest(worldX, worldY) && !this._surfaceHidesBody(surface, sprite)) {
                    hit = sprite;
                    break;
                }
            }
        }
        this._setHoveredAgentSprite(hit);
        if (hit) {
            // Agents win over buildings/ships/monuments, same precedence as
            // _handleClick: suppress the hover the synchronous pass applied.
            this.buildingRenderer?.setHovered(null);
            this.villageDirector?.setHoveredBuilding?.(null);
            this.harborTraffic?.setHoveredShip?.(null);
        }
        return hit;
    }

    _ensureHoverPlate() {
        const host = this.canvas?.parentElement;
        if (!host) return null;
        this._hoverPlate ||= new WorldHoverPlate({
            host,
            reservedRects: getReservedRects,
            resample: () => this._sampleHoverPlate(),
        });
        return this._hoverPlate;
    }

    // An arrival proves the building only where the body stands on one of
    // that building's visit tiles (a chat approach records an arrival too,
    // wherever the partner stood).
    _standsOnVisitTile(sprite, buildingType) {
        const building = sprite._buildingForType?.(buildingType);
        const tiles = building?.visitTiles;
        if (!Array.isArray(tiles) || !tiles.length) return false;
        const at = worldToTile(sprite.x, sprite.y);
        return tiles.some((tile) => tile
            && Math.abs(Number(tile.tileX) - at.tileX) <= 0.5
            && Math.abs(Number(tile.tileY) - at.tileY) <= 0.5);
    }

    _screenRectForWorld(left, top, right, bottom) {
        const a = this.camera.worldToScreen(left, top);
        const b = this.camera.worldToScreen(right, bottom);
        return { left: a.x, top: a.y, right: b.x, bottom: b.y };
    }

    // XP-4 — the plate's text and the screen rect it must not cover. A
    // villager gets its `name · building · tool · age` line beside its body,
    // the building only once it has arrived there and stands still, and a
    // second line naming where its last words came from (dialogueSourceLabel:
    // source, excerpt, redaction, held), never the words themselves. Else the
    // scenery's lore beside the scenery's own bounds.
    _hoverPlateContent(hit, lore = null) {
        if (!hit) return { text: lore?.text || '', target: lore?.target || null, key: lore?.key ?? null };
        const box = hit._bodyBox;
        const anchorY = hit._visualAnchorY?.() ?? hit.y;
        const target = box
            ? this._screenRectForWorld(hit.x + box.left, anchorY + box.top, hit.x + box.right, anchorY + Math.max(box.bottom, 4))
            : null;
        const behavior = hit.behavior;
        const arrived = !hit.moving && hit._lastBuildingType
            && behavior?.arrivedAt != null && behavior.building === hit._lastBuildingType
            && this._standsOnVisitTile(hit, hit._lastBuildingType);
        const line = villagerHoverLine(hit.agent, { buildingType: arrived ? hit._lastBuildingType : null });
        const entry = hit._activitySnapshot;
        const source = entry?.text && entry.source ? dialogueSourceLabel(entry) : '';
        return { text: source ? `${line}\n${source}` : line, target, key: `agent:${hit.agent?.id ?? ''}` };
    }

    _setHoveredAgentSprite(sprite) {
        if (this._hoveredAgentSprite === sprite) return;
        this._invalidateIdleFrame();
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(false);
        this._hoveredAgentSprite = sprite || null;
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(true);
    }

    // The scenery under a world point as `{ text, target }`: its lore and the
    // screen rect the plate keeps clear of (the hit's drawn bounds where it
    // has them, else a pointer-sized box round the hit), or null for bare ground.
    _worldHoverInfo(worldX, worldY) {
        const hoveredBuilding = this.buildingRenderer?.hitTest(worldX, worldY) ?? null;
        this.buildingRenderer?.setHovered(hoveredBuilding);
        this.villageDirector?.setHoveredBuilding?.(hoveredBuilding);
        const hoveredShip = hoveredBuilding
            ? null
            : (this.harborTraffic?.hitTestShip?.(worldX, worldY) ?? null);
        this.harborTraffic?.setHoveredShip?.(hoveredShip ? hoveredShip.id : null);
        const bridgeLantern = (hoveredBuilding || hoveredShip)
            ? null
            : (this.bridgeLanterns?.hitTest?.(worldX, worldY, Date.now()) ?? null);
        this.bridgeLanterns?.setHovered?.(bridgeLantern);
        const tokenItem = (hoveredBuilding || hoveredShip || bridgeLantern)
            ? null
            : (this.landmarkActivity?.hitTestTokenItem?.(worldX, worldY) ?? null);
        // D5 — a repo standing stone tells its lifetime count and tier.
        const repoStone = (hoveredBuilding || hoveredShip || bridgeLantern || tokenItem)
            ? null
            : (this.chronicleMonuments?.repoStones?.hitTest?.(worldX, worldY) ?? null);
        // The Hourglass Belfry reads out both accounts' quota windows.
        const belfry = (hoveredBuilding || hoveredShip || bridgeLantern || tokenItem || repoStone)
            ? null
            : (this.isleLandmarks?.hitTestBelfry?.(worldX, worldY) ?? null);
        const text = hoveredBuilding
            ? this._buildingVisitorTooltip(hoveredBuilding)
            : (hoveredShip
                ? this.harborTraffic.shipTooltip(hoveredShip)
                : (bridgeLantern
                    ? this.bridgeLanterns.tooltipFor(bridgeLantern, Date.now())
                    : (tokenItem
                        ? this.landmarkActivity.tokenItemTooltip(tokenItem)
                        : (repoStone
                            ? this.chronicleMonuments.repoStones.tooltipFor(repoStone)
                            : (belfry ? this.isleLandmarks.belfryTooltip() : '')))));
        if (!text) return null;
        const key = hoveredBuilding ? `building:${hoveredBuilding.type}`
            : hoveredShip ? `ship:${hoveredShip.id}`
                : repoStone ? `stone:${repoStone.worldX},${repoStone.worldY}`
                    : belfry ? 'belfry' : `lore:${text}`;
        // Drawn bounds where the hit has them (buildings, ships, repo stones,
        // the belfry tower); small marks (lanterns, token items) take the pad.
        const bounds = hoveredBuilding ? this.buildingRenderer?.worldBounds?.(hoveredBuilding)
            : hoveredShip ? this.harborTraffic?.shipWorldBounds?.(hoveredShip)
                : repoStone ? this.chronicleMonuments?.repoStones?.worldBounds?.(repoStone)
                    : belfry ? this.isleLandmarks?.belfryWorldBounds?.() : null;
        if (bounds) return { text, key, target: this._screenRectForWorld(bounds.left, bounds.top, bounds.right, bounds.bottom) };
        const point = this.camera.worldToScreen(worldX, worldY);
        const pad = HOVER_PLATE_POINTER_PAD;
        return { text, key, target: { left: point.x - pad, top: point.y - pad, right: point.x + pad, bottom: point.y + pad } };
    }

    // ─── U-P3 fleet card ────────────────────────────────────────────────
    _agentNameFor(id) {
        const agent = this.world?.agents?.get?.(id) || this.agentSprites.get(id)?.agent || null;
        return agent?.name || '';
    }

    _openFleetCard(query, { focus = false } = {}) {
        const harbor = this.harborTraffic;
        const host = this.canvas?.parentElement;
        if (!harbor || !host) return;
        const model = harbor.fleetCardModel(query, { agentName: id => this._agentNameFor(id) });
        if (!model) return;
        this._fleetCard ||= new HarborFleetCard({
            host,
            onSelectAgent: (id) => {
                const agent = this.world?.agents?.get?.(id) || this.agentSprites.get(id)?.agent;
                if (agent) emitAgentSelected(agent);
            },
            onSelectLane: (lane) => this._openFleetCard({ ...lane, shipId: null }),
            onClose: () => { this._fleetCardQuery = null; },
        });
        this._fleetCardQuery = query;
        this._fleetCardVersion = harbor._stateVersion;
        this._fleetCard.open(model, query, { focus });
        this._updateFleetCard();
        this._invalidateIdleFrame();
    }

    _closeFleetCard() {
        this._fleetCard?.close();
    }

    // Each frame the card follows its fleet on screen; when the harbor's
    // state changes it re-reads its data (a push departs, a commit docks).
    _updateFleetCard() {
        const card = this._fleetCard;
        const query = this._fleetCardQuery;
        const harbor = this.harborTraffic;
        if (!card?.isOpen || !query || !harbor) return;
        if (harbor._stateVersion !== this._fleetCardVersion) {
            this._fleetCardVersion = harbor._stateVersion;
            const model = harbor.fleetCardModel(query, { agentName: id => this._agentNameFor(id) });
            if (!model) {
                card.close();
                return;
            }
            card.refresh(model);
        }
        const anchor = harbor.fleetAnchor(query);
        const point = anchor ? this.camera.worldToScreen(anchor.x, anchor.y) : null;
        if (point) card.position(point, getReservedRects());
    }

    // A ledger row: glide to the fleet (medium scale) and open its card,
    // focused, so the keyboard lands inside it.
    _focusFleet(query) {
        const anchor = this.harborTraffic?.fleetAnchor?.(query);
        if (anchor && this.camera) {
            this.camera.noteSelectionInput?.();
            const box = { minX: anchor.x - 200, maxX: anchor.x + 200, minY: anchor.y - 150, maxY: anchor.y + 90 };
            const pose = this.camera._poseForWorldBox?.(box, { maxZoom: 2, minZoom: 1 });
            if (pose) this.camera.glideToPose(pose, { owner: 'system' });
        }
        this._openFleetCard({ ...query, shipId: null }, { focus: true });
    }

    _showTouchInfo(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const world = this.camera.screenToWorld(clientX - rect.left, clientY - rect.top);
        // A held finger reads the same plate as mouse hover, ships included
        // (a tap still opens the fleet card). The agent pass uses the same
        // front-most/arrival filters, and a villager wins over the scenery.
        const lore = this._worldHoverInfo(world.x, world.y);
        const plate = this._hoverPlateContent(this._applyAgentHover(world.x, world.y), lore);
        this._onMouseLeaveMain();
        if (!plate.text) return false;
        return this._ensureHoverPlate()?.showNow(plate.text, { x: clientX - rect.left, y: clientY - rect.top }, { target: plate.target }) || false;
    }

    _dismissTouchInfo() {
        this._hoverPlate?.hide();
    }

    _buildingVisitorTooltip(building) {
        if (!building?.type) return '';
        const type = building.type;
        const stats = this.visitTileAllocator?.snapshot?.()?.buildings?.[type] || null;
        const intents = this.visitIntentManager?.snapshot?.()?.intents
            ?.filter((intent) => intent.building === type)
            ?.slice(0, 4) || [];
        const label = building.shortLabel || building.label || type;
        const enRoute = stats ? Math.max(0, (stats.reserved || 0) - (stats.occupied || 0)) : intents.length;
        const count = stats ? `${stats.occupied} visiting, ${enRoute} en route` : `${intents.length} active`;
        if (!this.debugOverlay?.enabled) return `${label}: ${count}`;
        const reasons = intents.map((intent) => intent.reason).filter(Boolean);
        return reasons.length ? `${label}: ${count} - ${reasons.join(', ')}` : `${label}: ${count}`;
    }

    _invalidateIdleFrame() {
        this._idleFrameDirty = true;
    }

    _requiresFreshGpuOutput() {
        return Boolean(
            this._forceFreshGpuOutput
            || this._firstFrameReason
            || this._revealSnapshotPending
            || this._idleFrameDirty
            || this._worldSwap
            || this._contextLost
            || this.gpuWorld?.hasPendingGpuQueries?.()
            || this.gpuWorld?._readbackPending
        );
    }

    _cameraIdleStable() {
        const camera = this.camera;
        if (!camera) return false;
        if (
            camera.dragging
            || camera.followTarget
            || camera._momentum
            || camera._snapZoom
            || camera._zoomAnimation
            || camera._directorGlide
            || camera._idleDrift
            || camera._villageTour
            || camera._followEase
            || camera.isDirectorGliding?.()
        ) return false;
        const last = this._idleLastRenderCamera;
        return camera.x === last.x && camera.y === last.y && camera.zoom === last.zoom;
    }

    _hasTimedIdleTransition(now = Date.now()) {
        if (this.debugOverlay?.enabled || this.debugOverlay?.pathDebugEnabled) return true;
        // AgentSprite.update owns routing, dwelling, reservation renewal, chat
        // convergence and movement even under reduced motion. Only departed
        // tableaux are truly static enough to stop advancing.
        for (const sprite of this.agentSprites.values()) {
            if (!sprite.agent?.isDeparted) return true;
            if (sprite._archiveAnim || sprite.moving || sprite.chatting || sprite.chatPartner) return true;
        }
        if (this.gateTransits.size || this.gateDoorsOpen || now < this._gateDoorsOpenUntilMs) return true;
        const arrival = this.arrivalDeparture;
        if (
            arrival?.arrivals?.size
            || arrival?.dispatches?.size
            || arrival?.merges?.size
            || arrival?.sigils?.length
            || arrival?.completionCues?.length
            || arrival?.orphanReturns?.length
        ) return true;
        if (this.ritualConductor?.rituals?.length || this.particleSystem?.particles?.length) return true;

        if (now >= this._chronicleNextUpdateAt) return true;

        const director = this.villageDirector;
        if (
            director?.replayActive
            || director?.scenes?.length
            || director?._recoveries?.size
            || director?._pendingBiographyBanners?.length
            || director?.presenceExpiryDue?.(now)
            || director?.toolEvents?.length
        ) return true;
        const harbor = this.harborTraffic;
        if (
            harbor?._hasTimedLifecycle
            || harbor?.storageTransfers?.size
            || harbor?.harborCrates?.size
            || harbor?.state?.pushEvents?.size
            || harbor?._pendingRepoSummaries?.length
        ) return true;

        // The live clock changes sky, light and deterministic weather. Under
        // reduced motion (the only state that skips) the atmosphere reads it in
        // whole seconds (FP-2, WorldFrameRenderer), so the scene is timeless
        // until the second the last painted frame used has passed.
        if (
            !this.atmosphereState?._frozenDate
            && !Number.isFinite(this.atmosphereState?._hourOverride)
            && (this.replay?.replayClock.now ?? (now - (now % 1000))) !== this._idleLastRenderClockMs
        ) {
            return true;
        }
        const atmosphere = this._lastAtmosphere;
        const weather = atmosphere?.weather;
        const weatherProgress = Number(weather?.transitionProgress);
        if (
            !atmosphere
            || (weather?.timelineMode === 'auto' && weatherProgress > 0 && weatherProgress < 1)
            || (
                weather?.previousType !== weather?.nextType
                && weatherProgress > 0
                && weatherProgress < 1
            )
            || (Number(weather?.precipitation) || 0) > 0.001
            || (Number(this._surfaceWetness) || 0) > 0.001
        ) return true;
        return false;
    }

    _pendingIdleResourceWork() {
        const assets = this.assets;
        const pending = Boolean(
            this._worldResumePromise
            || this._chronicleUpdatePromise
            || assets?._loadPromise
            || assets?._materialLoadPromise
            || assets?._characterLoads?.size
            || assets?._derivedArtQueue?.size
            || this.gpuWorld?.hasPendingGpuQueries?.()
            || this._firstFrameReason
            || this._revealSnapshotPending
        );
        if (pending) {
            this._idleResourceWorkObserved = true;
            return true;
        }
        // Resource completion can change drawable pixels without a domain
        // event. Force exactly one post-completion frame before becoming idle.
        if (this._idleResourceWorkObserved) {
            this._idleResourceWorkObserved = false;
            return true;
        }
        return false;
    }

    _canSkipIdleFrame(now = Date.now()) {
        // FP-2 — a resident world skips only after its byte gate confirmed the
        // static scene: the last rendered frame staged exactly the inputs it
        // had already presented, so nothing this predicate cannot see was
        // still changing. Every changed input renders and re-confirms.
        if (this.gpuWorld?.isActive?.() && this.gpuWorld.lastFrameReused !== true) return false;
        return this.motionScale <= 0
            && !this.inspectionGlass?.isActive() && !this.inspectionGlass?.cutawayBuildingId
            && !this._idleFrameDirty
            && this._cameraIdleStable()
            && !this._hasTimedIdleTransition(now)
            && !this._pendingIdleResourceWork();
    }

    _recordIdleRenderState() {
        this._worldFramePresented = true;
        this._idleLastRenderClockMs = this._atmosphereClockMs;
        const camera = this.camera;
        if (camera) {
            this._idleLastRenderCamera.x = camera.x;
            this._idleLastRenderCamera.y = camera.y;
            this._idleLastRenderCamera.zoom = camera.zoom;
        }
        this._idleFrameDirty = false;
    }

    // FP-1b — ambient-only frames wait for the 30 fps cadence (FramePacing.js
    // `ambientFrame`). The verdict on the last frame (walkers, comets,
    // strikes, moments, a camera that moved) holds until the next one; what
    // can change between frames, the camera's own easing and the pointer, is
    // read at the tick.
    _ambientTick(tickMs) {
        if (!AMBIENT_FRAME_PACING || !this._ambientHint) return false;
        return ambientFrame({ cameraMoving: this._cameraEasing(), msSinceInput: tickMs - this._pointerInputAt });
    }

    _noteAmbientFrame() {
        const momentPlaying = takeLiveMoment();
        if (!AMBIENT_FRAME_PACING) return;
        try {
            const arrival = this.arrivalDeparture;
            this._ambientHint = ambientFrame({
                fastWalker: this._fastWalkerOnScreen(),
                cameraMoving: this._cameraMovedSinceAmbientFrame() || this._cameraEasing(),
                cometInFlight: Boolean(arrival?.dispatches?.size || arrival?.merges?.size || arrival?.orphanReturns?.length),
                strikeActive: this._frameStrikeActive === true,
                momentPlaying,
            });
        } catch {
            this._ambientHint = false;
        }
    }

    // A body in view (the render's own visible set) walking or running above
    // the stroll rung.
    _fastWalkerOnScreen() {
        const sprites = this._visibleSortedSprites;
        for (let index = 0; index < sprites.length; index++) {
            const sprite = sprites[index];
            if (sprite?.moving && (sprite._running || sprite._gaitSpeed > SPEED_RUNGS[0])) return true;
        }
        return false;
    }

    _cameraEasing() {
        const camera = this.camera;
        return Boolean(camera && (
            camera.dragging
            || camera._momentum
            || camera._snapZoom
            || camera._zoomAnimation
            || camera._directorGlide
            || camera._villageTour
            || camera._followEase
            || camera.isDirectorGliding?.()
        ));
    }

    // A follow spring or a soft follow moves the camera without an easing
    // flag; the idle breath (`_idleDrift`) is ambient.
    _cameraMovedSinceAmbientFrame() {
        const camera = this.camera;
        if (!camera) return false;
        const last = this._ambientCamera;
        const moved = !camera._idleDrift && (
            !(Math.abs(camera.x - last.x) <= 0.01)
            || !(Math.abs(camera.y - last.y) <= 0.01)
            || camera.zoom !== last.zoom
        );
        last.x = camera.x;
        last.y = camera.y;
        last.zoom = camera.zoom;
        return moved;
    }

    _loop(frameTime) {
        if (!this.running) return;
        this.frameId = null;
        if (!this._worldModeActive || this._contextLost) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        // FP-1a: at most 60 fps on every backend (FP-1b: 30 for an ambient-only
        // frame). A tick the cap holds only re-arms rAF: no update, clock,
        // envelope or FPS sample.
        const tickMs = Number.isFinite(frameTime) ? frameTime : performance.now();
        if (!admitFrame(this._framePacing, tickMs, this._ambientTick(tickMs))) {
            this._startLoop();
            return;
        }
        let now = 0;
        let frameGapMs = 0;
        let perf = null;
        let updateToken = null;
        let renderToken = null;
        let stage = 'pacing';
        let updateMs = 0;
        let renderMs = 0;
        let updateStart = 0;
        let renderStart = 0;
        try {
            now = performance.now();
            updateStart = now;
            renderStart = now;
            frameGapMs = Number.isFinite(this._lastFrameTime) ? now - this._lastFrameTime : 0;
            const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
            // Only uninterrupted rAF timestamps are display-interval samples,
            // and the ladder hears the paced interval (FP-5): never under the
            // 60 fps period, so a frame the cap held is not a missed frame.
            const presentIntervalMs = this._framePacing.intervalMs;
            if (this._lastFrameTime === this._lastLoopFrameTime && presentIntervalMs !== null) {
                this.gpuWorld?.notePresentInterval?.(presentIntervalMs);
            }
            this._settleAfterFrameGap(now); // VB-4: no parade after a long gap
            this._lastLoopFrameTime = now;
            this._lastFrameTime = now;
            stage = 'fallback-prep';
            this._fallBackFromWebGpu();
            if (this._fallbackPrep) {
                const prep = this._fallbackPrep;
                if (now - prep.startedAt < WORLD_FALLBACK_PREP_TIMEOUT_MS) return;
                this._failFallbackPrep(prep, new Error('World fallback preparation exceeded its 5 s frame hold'));
            }
            if (this._frameFailureStats.paused) return;
            stage = 'clock';
            advanceMotionClock(this._motionClock, dt, this.motionScale ?? 1);
            // Keep the film at real playback speed across a missed frame.
            // Scene motion still uses its short, clamped stride delta.
            if (this._worldFramePresented && this.replay && !this.retoldScrubber?.paused) {
                this.replay.advanceReplay((frameGapMs || dt) * (this.retoldScrubber?.speed || 1), this.motionScale <= 0);
                const clock = this.replay.replayClock;
                if (this.retoldScrubber && clock && clock.now !== this._scrubClockMs) {
                    this._scrubClockMs = clock.now;
                    this.retoldScrubber.update({ progress: clock.playhead / clock.duration, clockMs: clock.now });
                }
            }
            stage = 'idle';
            const skipIdlePaint = this._canSkipIdleFrame(Date.now());
            this.waterFrame = virtualFramesFor(this.motionTimeMs) * WATER_FRAME_STEP;
            perf = getClientPerfMetrics();
            stage = 'update';
            if (perf?.enabled) updateToken = perf.beginRenderStage('world-update');
            this._update(dt);
            const afterUpdate = performance.now();
            updateMs = afterUpdate - updateStart;
            if (updateToken) {
                perf.endRenderStage(updateToken);
                updateToken = null;
            }
            if (skipIdlePaint && !this._requiresFreshGpuOutput()) {
                stage = 'telemetry';
                this._recordFrameEnvelope(updateMs, 0, afterUpdate - updateStart, frameGapMs, null);
                if (this._performanceSamples) this._recordPerformanceSample(updateMs, 0, afterUpdate - updateStart);
                this._trackFps(now);
                this._recordFrameSuccess();
                return;
            }
            stage = 'render';
            renderStart = afterUpdate;
            if (perf?.enabled) renderToken = perf.beginRenderStage('world-render');
            // Stage B — a WebGPU world that finished compiling after a
            // WebGL2 mount takes over at this frame when it draws it; a
            // failed WebGPU world hands over to its WebGL2 fallback the same way.
            const worldSwap = this._beginWorldSwap();
            let painted;
            try {
                const allowTerrainArtifactWait = !this._worldFramePresented
                    && this._worldResourceGeneration === 0
                    && (this._firstFrameReason === 'boot' || this._firstFrameReason === 'boot-pending');
                painted = this._render(dt, allowTerrainArtifactWait);
            } finally {
                if (worldSwap) this._endWorldSwap(worldSwap);
            }
            // A WebGPU frame that failed mid-render left only the Canvas
            // atmosphere under the overlay (its records were the GPU's): the
            // same frame renders again on the WebGL2 fallback (or, without
            // WebGL2, on the Canvas world) in this task, so the page never
            // presents the broken one.
            if (painted !== false && !worldSwap && this.worldRendererMode === 'webgpu' && this.gpuWorld?.failure) {
                this._fallBackFromWebGpu({ inFrame: true });
                const fallbackSwap = this._beginWorldSwap();
                if (fallbackSwap) {
                    try {
                        painted = this._render(0);
                    } finally {
                        this._endWorldSwap(fallbackSwap);
                    }
                } else if (this.worldRendererMode === 'canvas') {
                    painted = this._render(0);
                }
            }
            const afterRender = performance.now();
            renderMs = afterRender - renderStart;
            if (painted !== false) {
                this._recordIdleRenderState();
                this.presentGeneration += 1;
                this._signalFirstFrame();
            }
            if (renderToken) {
                perf.endRenderStage(renderToken);
                renderToken = null;
            }
            this._recordFrameEnvelope(updateMs, renderMs, afterRender - updateStart, frameGapMs, null);
            if (this._performanceSamples) {
                this._recordPerformanceSample(updateMs, renderMs, afterRender - updateStart);
            }
            stage = 'telemetry';
            this._trackFps(now);
            this._recordFrameSuccess();
        } catch (error) {
            const failedAt = performance.now();
            if (stage === 'update') {
                updateMs = failedAt - updateStart;
            } else if (stage === 'render') {
                updateMs = renderStart - updateStart;
                renderMs = failedAt - renderStart;
            }
            this._reportFrameFailure(error, stage, now);
            this._recordFrameEnvelope(updateMs, renderMs, failedAt - updateStart, frameGapMs, stage);
        } finally {
            this._noteAmbientFrame();
            try {
                if (updateToken) perf?.endRenderStage?.(updateToken);
                if (renderToken) perf?.endRenderStage?.(renderToken);
            } catch (error) {
                this._reportFrameFailure(error, 'telemetry');
            } finally {
                this._startLoop();
            }
        }
    }

    _reportFrameFailure(error, stage, now = performance.now()) {
        const stats = this._frameFailureStats;
        const message = error instanceof Error ? error.message : String(error);
        const changed = stats.lastStage !== stage || stats.lastMessage !== message;
        stats.total++;
        stats.consecutive++;
        stats.lastStage = stage;
        stats.lastMessage = message;
        stats.lastAt = now;
        stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
        this._invalidateIdleFrame();
        if (stage === 'render') this._resetContextAfterFrameFailure();
        const tripped = !stats.paused && stats.consecutive >= WORLD_FRAME_MAX_CONSECUTIVE_FAILURES;
        if (tripped) {
            stats.paused = true;
            this._frameFailureEpisode = true;
            this._stopLoop();
            this._scheduleFrameFailureRecovery();
        }
        // A changing fault can report sooner, but never at frame rate.
        const reportIntervalMs = changed ? 1000 : WORLD_FRAME_ERROR_REPORT_INTERVAL_MS;
        if (!tripped && now - stats.lastReportedAt < reportIntervalMs) return;
        stats.lastReportedAt = now;
        const detail = {
            stage,
            message: stats.lastMessage,
            total: stats.total,
            consecutive: stats.consecutive,
            paused: stats.paused,
            retrying: this._frameFailureEpisode,
        };
        try { console.error(`[IsometricRenderer] ${stage} frame failed`, error); } catch (_) { /* no-op */ }
        try { eventBus.emit('world:frame-error', detail); } catch (_) { /* keep the frame loop alive */ }
    }

    _resetContextAfterFrameFailure() {
        // A painter can throw with saves and a clip still on either canvas.
        for (const ctx of [this.ctx, this.overlayCtx]) {
            if (!ctx) continue;
            try {
                if (typeof ctx.reset === 'function') ctx.reset();
                else if (ctx.canvas) ctx.canvas.width = ctx.canvas.width;
                if (ctx === this.overlayCtx) this._resetScreenTransform(ctx);
            } catch { /* context recovery is best-effort */ }
        }
    }

    _resumeFrameFailures() {
        this._cancelFrameFailureRecovery();
        this._frameFailureStats.paused = false;
        this._frameFailureStats.consecutive = 0;
    }

    _cancelFrameFailureRecovery() {
        if (this._frameFailureRecoveryTimer != null) {
            clearTimeout(this._frameFailureRecoveryTimer);
            this._frameFailureRecoveryTimer = null;
        }
    }

    _scheduleFrameFailureRecovery() {
        if (
            this._frameFailureRecoveryTimer !== null
            || this._disposed
            || !this.running
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this._contextLost
            || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) return;
        const generation = this._worldResourceGeneration;
        const delay = this._frameFailureRetryMs;
        this._frameFailureRetryMs = Math.min(WORLD_FRAME_RETRY_MAX_MS, delay * 2);
        this._frameFailureRecoveryTimer = setTimeout(() => {
            this._frameFailureRecoveryTimer = null;
            if (generation !== this._worldResourceGeneration) return;
            this.resumeAfterFrameFailure();
        }, delay);
    }

    _recordFrameSuccess() {
        const recovering = this._frameFailureEpisode;
        this._resumeFrameFailures();
        this._frameFailureRetryMs = WORLD_FRAME_RETRY_INITIAL_MS;
        this._frameFailureEpisode = false;
        if (recovering) eventBus.emit('world:frame-recovered', { total: this._frameFailureStats.total });
    }

    resumeAfterFrameFailure() {
        if (
            this._disposed
            || !this.running
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this._contextLost
            || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) return false;
        this._resumeFrameFailures();
        this._invalidateIdleFrame();
        this._lastFrameTime = performance.now();
        this._startLoop();
        return this.frameId !== null;
    }

    // Emit a smoothed FPS reading roughly twice a second; TopBar renders it.
    _trackFps(now) {
        // The first callback establishes the baseline, not a frame interval.
        // Use a null check because a timestamp of zero is valid in tests.
        if (this._fpsWindowStart == null) {
            this._fpsWindowStart = now;
            this._fpsFrames = 0;
            return;
        }
        this._fpsFrames = (this._fpsFrames || 0) + 1;
        const elapsed = now - this._fpsWindowStart;
        if (elapsed >= 500) {
            eventBus.emit('fps:updated', Math.round((this._fpsFrames * 1000) / elapsed));
            // Broadcast the frame's atmosphere snapshot at the same throttled
            // cadence; the ambient audio director listens so sound tracks the
            // same sky the renderer draws (including debug/mood overrides).
            if (this._lastAtmosphere) eventBus.emit('atmosphere:updated', this._lastAtmosphere);
            this._fpsFrames = 0;
            this._fpsWindowStart = now;
        }
    }

    startPerformanceProfile() {
        this._performanceSamples = {
            slots: new Array(600),
            index: 0,
            count: 0,
            capacity: 600,
        };
        this._frameTimingSamples?.clear?.();
        enableFrameEnvelopeRings(this._frameEnvelope);
        return true;
    }

    stopPerformanceProfile() {
        const profile = this.getPerformanceProfile();
        this._performanceSamples = null;
        if (!getClientPerfMetrics()?.enabled) this._frameEnvelope.ringsEnabled = false;
        return profile;
    }

    getPerformanceProfile() {
        return {
            enabled: Boolean(this._performanceSamples),
            samples: this._collectPerformanceSamples(),
            renderTimings: this._snapshotRenderTimings(),
        };
    }

    frameHealth() {
        const gpu = this.gpuWorld?.getDiagnostics?.() || null;
        const postFx = this.postFx?.getDiagnostics?.() || null;
        const gpuMs = Number.isFinite(gpu?.gpuMs)
            ? gpu.gpuMs
            : (Number.isFinite(postFx?.gpuMs) ? postFx.gpuMs : null);
        const qualityLevel = gpu?.qualityLevel ?? postFx?.ladder?.effectiveLevel ?? null;
        const qualityReason = gpu?.qualityReason ?? postFx?.ladder?.lastDecisionReason ?? null;
        return snapshotFrameEnvelope(this._frameEnvelope, {
            gpuMs,
            qualityLevel,
            qualityReason,
        });
    }

    _syncFrameEnvelopeRings() {
        const requested = Boolean(this._performanceSamples || getClientPerfMetrics()?.enabled);
        if (requested) enableFrameEnvelopeRings(this._frameEnvelope);
        else this._frameEnvelope.ringsEnabled = false;
    }

    _recordFrameEnvelope(updateMs, renderMs, totalMs, frameGapMs, failureStage) {
        this._syncFrameEnvelopeRings();
        recordFrameEnvelope(this._frameEnvelope, updateMs, renderMs, totalMs, frameGapMs, failureStage);
    }

    _recordPerformanceSample(updateMs, renderMs, totalMs) {
        const ring = this._performanceSamples;
        if (!ring) return;
        let slot = ring.slots[ring.index];
        if (!slot) {
            slot = {
                updateMs: 0,
                renderMs: 0,
                totalMs: 0,
                agentCount: 0,
                renderMode: null,
            };
            ring.slots[ring.index] = slot;
        }
        slot.updateMs = updateMs;
        slot.renderMs = renderMs;
        slot.totalMs = totalMs;
        slot.agentCount = this.agentSprites.size;
        slot.renderMode = this._lastRenderStats?.quality?.agentRenderMode || null;
        ring.index += 1;
        if (ring.index >= ring.capacity) ring.index = 0;
        if (ring.count < ring.capacity) ring.count += 1;
    }

    _collectPerformanceSamples() {
        const ring = this._performanceSamples;
        if (!ring || ring.count === 0) return [];
        const samples = new Array(ring.count);
        const start = ring.count < ring.capacity ? 0 : ring.index;
        for (let i = 0; i < ring.count; i++) {
            const slot = ring.slots[(start + i) % ring.capacity];
            samples[i] = slot
                ? {
                    updateMs: slot.updateMs,
                    renderMs: slot.renderMs,
                    totalMs: slot.totalMs,
                    agentCount: slot.agentCount,
                    renderMode: slot.renderMode,
                }
                : null;
        }
        return samples;
    }

    _snapshotRenderTimings() {
        const timer = this._frameTimer;
        const rings = this._frameTimingSamples;
        if (!timer && !rings) return this._lastRenderStats?.timings || null;
        const markCount = timer?.markCount || 0;
        const segments = [];
        for (let i = 0; i < markCount; i++) {
            const label = timer.markLabels[i];
            const ring = rings?.get(label);
            segments.push({
                label,
                ms: timer.markMs[i],
                p50: ring ? percentileAtSnapshot(ring.values, 0.5, ring.count) : null,
                p95: ring ? percentileAtSnapshot(ring.values, 0.95, ring.count) : null,
            });
        }
        if (segments.length > 1) {
            segments.sort((a, b) => (Number(b.p95) || 0) - (Number(a.p95) || 0));
        }
        const totalRing = rings?.get('total');
        return {
            totalMs: timer?.lastTotalMs ?? this._lastRenderStats?.timings?.totalMs ?? 0,
            totalP50: totalRing ? percentileAtSnapshot(totalRing.values, 0.5, totalRing.count) : null,
            totalP95: totalRing ? percentileAtSnapshot(totalRing.values, 0.95, totalRing.count) : null,
            segments,
        };
    }

    _updateChatMatching() {
        const senders = new Set();
        const senderMsgKeys = new Map();
        const spriteByRecipient = new Map();

        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            const agent = sprite.agent;
            if (!agent) continue;
            const aliases = [
                agent.name,
                agent.agentName,
                agent.agentId,
                agent.id,
                agentPathAlias(agent),
            ].filter(Boolean);

            for (const alias of aliases) {
                if (!spriteByRecipient.has(alias)) {
                    spriteByRecipient.set(alias, sprite);
                }
            }
        }

        // AP-2 — a recipient an approach already targets stays claimed by it
        // until that approach ends, so a pile of senders naming the same body
        // sends one walker, not a crowd.
        const claims = this._chatApproachClaims ||= new Map();
        for (const [claimed, claimant] of claims) {
            if (claimant.chatPartner !== claimed || !this.agentSprites.has(claimant.agent?.id)) {
                claims.delete(claimed);
            }
        }

        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            const agent = sprite.agent;
            if (!agent) continue;
            if (agent.status === AgentStatus.WORKING && agent.currentToolInput
                && isAgentMessageTool(agent.currentTool, agent.currentToolInput)) {
                const rawInput = typeof agent.currentToolInput === 'string'
                    ? agent.currentToolInput
                    : JSON.stringify(agent.currentToolInput);
                const msgKey = `${agent.currentTool || ''}|${rawInput}`;
                if (sprite._exhaustedChatMsgKey && sprite._exhaustedChatMsgKey !== msgKey) {
                    sprite._exhaustedChatMsgKey = null;
                }
                if (sprite._exhaustedChatMsgKey === msgKey) continue;
                senders.add(sprite);
                senderMsgKeys.set(sprite, msgKey);

                if (sprite.chatPartner) continue;

                const recipient = extractRecipientName(agent.currentToolInput);
                if (!recipient) continue;
                const target = spriteByRecipient.get(recipient);
                const claimant = target ? claims.get(target) : null;
                // AP-2 — start a chat only when the target has no partner and
                // is not chatting (nor under another sender's live approach):
                // a busy recipient is skipped and the sender retries on a later
                // matching pass instead of stacking on it. BR-5 — an approach
                // starts once neither body stands on a bridge deck, landing or
                // the gatehouse apron.
                if (target && target !== sprite && !target.chatPartner && !target.chatting
                    && (!claimant || claimant === sprite)
                    && !sprite.standsOnCrossing?.() && !target.standsOnCrossing?.()
                    && !sprite.standsOnGateApron?.() && !target.standsOnGateApron?.()) {
                    claims.set(target, sprite);
                    sprite._chatStartMsgKey = msgKey;
                    target._chatStartMsgKey = senderMsgKeys.get(target) ?? null;
                    sprite.startChat(target);
                }
            } else if (sprite._exhaustedChatMsgKey) {
                sprite._exhaustedChatMsgKey = null;
            }
        }

        // Clear chat state for agents not using SendMessage
        const now = Date.now();
        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            // AP-2 — a chat that has been one-sided for the grace period ends:
            // the body stops facing a partner that never answered and resumes
            // its route.
            if (sprite.chatting && sprite.chatPartner?.chatPartner !== sprite
                && now - (sprite.chatSinceMs || 0) > ONE_SIDED_CHAT_GRACE_MS) {
                sprite.endChat();
                continue;
            }
            // Cap mutual chats on unchanged static messaging tool calls at
            // MUTUAL_CHAT_MAX_MS so a static SendMessage never traps a pair.
            // Exhaust only when a participant's tool call still matches the
            // key recorded at chat start; a fresh message during an older chat
            // either re-anchors the cap window (same partner) or ends the old
            // chat without exhausting the fresh key.
            if (sprite.chatting && sprite.chatPartner?.chatPartner === sprite
                && sprite.chatSinceMs
                && now - sprite.chatSinceMs > MUTUAL_CHAT_MAX_MS) {
                const partner = sprite.chatPartner;
                const spriteKey = senderMsgKeys.get(sprite) ?? null;
                const partnerKey = senderMsgKeys.get(partner) ?? null;
                const spriteMatches = Boolean(spriteKey && sprite._chatStartMsgKey === spriteKey);
                const partnerMatches = Boolean(partnerKey && partner._chatStartMsgKey === partnerKey);
                if (spriteMatches || partnerMatches) {
                    if (spriteMatches) sprite._exhaustedChatMsgKey = spriteKey;
                    if (partnerMatches) partner._exhaustedChatMsgKey = partnerKey;
                    sprite.endChat();
                    if (partner.chatPartner === sprite) partner.endChat();
                    continue;
                }
                const spriteTarget = spriteKey ? spriteByRecipient.get(extractRecipientName(sprite.agent?.currentToolInput)) : null;
                const partnerTarget = partnerKey ? spriteByRecipient.get(extractRecipientName(partner.agent?.currentToolInput)) : null;
                const freshForOther = (spriteKey && sprite._chatStartMsgKey !== spriteKey && spriteTarget && spriteTarget !== partner)
                    || (partnerKey && partner._chatStartMsgKey !== partnerKey && partnerTarget && partnerTarget !== sprite);
                if (freshForOther) {
                    sprite.endChat();
                    if (partner.chatPartner === sprite) partner.endChat();
                    continue;
                }
                if (spriteKey && sprite._chatStartMsgKey !== spriteKey) {
                    sprite._chatStartMsgKey = spriteKey;
                    sprite.chatSinceMs = now;
                    partner.chatSinceMs = now;
                }
                if (partnerKey && partner._chatStartMsgKey !== partnerKey) {
                    partner._chatStartMsgKey = partnerKey;
                    sprite.chatSinceMs = now;
                    partner.chatSinceMs = now;
                }
            }
            if (sprite.chatPartner && !senders.has(sprite)) {
                // Keep it if the other side is still using SendMessage
                if (senders.has(sprite.chatPartner)) continue;
                const partner = sprite.chatPartner;
                sprite.endChat();
                if (partner.chatPartner === sprite) partner.endChat();
            }
        }
    }

    setPinnedAgentIds(ids) {
        const seen = new Set();
        this._pinnedAgentIds = Array.isArray(ids)
            ? ids.flatMap((id) => {
                const normalized = typeof id === 'string' ? id.trim() : '';
                if (!normalized || seen.has(normalized)) return [];
                seen.add(normalized);
                return [normalized];
            }).slice(0, 2)
            : [];
        this._forwardTaskboardCandidates();
        this._invalidateIdleFrame();
    }

    getPinnedAgentIds() {
        return [...(this._pinnedAgentIds || [])];
    }

    _forwardTaskboardCandidates() {
        this.buildingRenderer?.setTaskboardCandidates?.([
            this.selectedAgent?.id,
            ...(this._pinnedAgentIds || []),
        ].filter(Boolean));
    }

    selectAgentById(agentId) {
        if (this.focusedSquadIds && !this.focusedSquadIds.has(agentId)) this._clearCouncilFocus();
        this._invalidateIdleFrame();
        if (agentId && !this.selectedAgent) this._inspectionPose = this.camera.capturePose();
        for (const sprite of this.agentSprites.values()) {
            sprite.selected = false;
        }
        if (agentId) {
            const sprite = this.agentSprites.get(agentId);
            if (sprite && !this._isGateTransit(sprite, 'departure')) {
                sprite.selected = true;
                this.selectedAgent = sprite.agent;
                this.camera.followAgent(sprite);
                this._forwardTaskboardCandidates();
                return;
            }
        }
        this.selectedAgent = null;
        this._forwardTaskboardCandidates();
        this.camera.stopFollow();
        if (this._inspectionPose && this.camera._lastUserInputAt === this._inspectionPose.inputAt) this.camera.restorePose(this._inspectionPose);
        this._inspectionPose = null;
    }

    _update(dt = 16) {
        this._ritualSyncFrame = (this._ritualSyncFrame + 1) % 1000000;

        // Update camera follow
        if (this.camera) {
            // #attract — let the idle-attract director consider a move before the
            // camera ticks, so any glide it starts advances this same frame.
            this.cameraDirector?.update({
                now: performance.now(),
                dt,
                agentSprites: this.agentSprites,
                snapshot: this.villageDirector?.getSnapshot?.() || null,
                plaqueCounts: this.buildingRenderer?._plaqueCounts || null,
                plaquePatrons: this.buildingRenderer?.plaquePatrons || null,
            });
            // #50 — pass wall-clock time so the camera can measure idle duration
            // for the Ken-Burns drift independently of accumulated dt.
            this.camera.update(dt, performance.now());
            this.camera.updateFollow(dt);
        }
        if (this._fleetCard?.isOpen) this._updateFleetCard();
        this._refreshHoverPlate();

        // Chat matching only depends on session/tool state, not frame-perfect motion.
        this._chatMatchAccumulator += dt;
        let slowSystemsTick = false;
        if (this._chatMatchAccumulator >= 250) {
            this._chatMatchAccumulator = 0;
            slowSystemsTick = true;
            if (!this.replay?.recorded) {
                this._updateChatMatching();
                this.agentEventStream?.reconcileChatPairs?.(this.agentSprites);
            }
        }
        const now = performance.now();
        const chronicleNow = Date.now();
        // Visit allocation and relationship clustering share the same semantic cadence.
        const agents = slowSystemsTick
            ? this._updateVisitSystems(chronicleNow)
            : this._activeAgentsSnapshot;
        if (slowSystemsTick) {
            this.relationshipState?.reconcile?.({ agentSprites: this.agentSprites, now });
            applyTeamPlazaPreferences(this.relationshipState, this.agentSprites);
        }
        this._pruneCrowdBumpCooldowns(now);
        this._releaseGateEntries();
        this._releasePortalEntries();
        if (!this._coldPortalSettled && this.agentSprites.size > 0) this._coldPortalSettled = true;
        // 2.4 — affinity proximity re-evaluates on a slow cadence; warmth
        // changes are gradual, so per-frame work would be wasted.
        this._affinityProximityAccumulator += dt;
        if (this._affinityProximityAccumulator >= AFFINITY_PROXIMITY_INTERVAL_MS) {
            this._affinityProximityAccumulator = 0;
            this._applyAffinityProximity(chronicleNow);
        }
        this.arrivalDeparture?.update?.(now);
        this.chronicler?.update?.(dt, chronicleNow);
        if (chronicleNow >= this._chronicleNextUpdateAt) {
            this._chronicleNextUpdateAt = chronicleNow + 1000;
            this._updateChronicleSystems(chronicleNow);
        }

        // Update agent sprites. Routing, reservations, chat convergence and
        // arrival/departure completion remain global: skipping those off-screen
        // would make villagers jump or arrive in the wrong state when revealed.
        // Particle emission is purely visual, so sprites beyond the generous
        // screen apron advance against a null sink while keeping all state.
        let shouldResort = false;
        const completedDepartures = [];
        const viewport = this._screenViewport();
        const frameMotionTimeMs = this.motionTimeMs;
        const frameLightGrade = this._lastAtmosphere?.lightGrade || null;
        for (const sprite of this.agentSprites.values()) {
            sprite._motionTimeMs = frameMotionTimeMs;
            sprite.overlayLightGrade = frameLightGrade;
            const particleSink = this._agentVisibleOnScreen(sprite, viewport)
                ? this.particleSystem
                : null;
            if (this.replay?.recorded) {
                const position = sprite.agent.position;
                if (position !== sprite._lastRecordedPosition) {
                    sprite.setTilePosition(position.tileX, position.tileY);
                    sprite._lastRecordedPosition = position;
                }
            } else {
                sprite.update(particleSink, dt);
            }
            const transit = this.gateTransits.get(sprite.agent?.id);
            if (transit && !sprite.moving && sprite.hasReachedTarget?.()) {
                if (transit.type === 'departure') {
                    completedDepartures.push(sprite.agent.id);
                } else {
                    this.gateTransits.delete(sprite.agent.id);
                    // 7.4 — through the gate, the villager walks on to its
                    // work instead of loitering in the gate mouth, where the
                    // next arrivals of its file would land on it.
                    if (transit.gate) sprite.waitTimer = 0;
                }
            }
            if (sprite._lastSortedY !== sprite.y) {
                shouldResort = true;
                sprite._lastSortedY = sprite.y;
            }
        }
        for (const agentId of completedDepartures) this._finishGateDeparture(agentId);
        if (shouldResort) {
            this._markSpritesDirty();
        }

        // W5-C — allocation-free 2D ORCA crowd solver with Context Steering,
        // V7 stride lock, WalkClearance walkability clamping, and 10 px final arrival fan.
        const movingSprites = this._movingSprites;
        movingSprites.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite.moving && !sprite.chatting && !this._isGateChannelTransit(sprite)) {
                movingSprites.push(sprite);
            }
        }
        this._applyLocalAvoidance(movingSprites, dt);
        this._crowdStatsAccumulator += dt;
        if (this._crowdStatsAccumulator >= 250 || this.agentSprites.size !== this._lastAgentCount) {
            this._crowdStatsAccumulator = 0;
            this._lastAgentCount = this.agentSprites.size;
            this._crowdStats = this._summarizeCrowdClusters();
            this._sampleBehaviorTelemetry(Date.now());
        }
        this._stationaryOverlapAccumulator += dt;
        if (this._stationaryOverlapAccumulator >= 420) {
            this._stationaryOverlapAccumulator = 0;
            if (!this.replay?.recorded) this._resolveStationaryOverlaps();
        }

        // These consumers need every live position but do not require painter
        // order. Defer Y ordering until the render path has viewport-culled.
        const allSpritesSnapshot = this._snapshotAllSprites();
        this._replayActiveToolRituals();
        this.ritualConductor?.update?.(dt);
        this._syncToolRitualPoses();

        // Ship motion is visual and stays frame-smooth. Git/source semantics
        // only need the existing 250ms application cadence.
        this.harborTraffic?.advance?.(dt);
        const pendingGit = this.replay?.pendingGit;
        if (slowSystemsTick || pendingGit?.length) {
            const harborSources = pendingGit?.length
                ? [...this.world.agents.values(), { gitEvents: pendingGit.splice(0) }] : agents;
            this.harborTraffic?.reconcile?.(harborSources, chronicleNow, this.replay?.recorded ? { incremental: true } : undefined);
            this._harborFailedPushState = this.harborTraffic?.getFailedPushState?.(chronicleNow) || null;
            let activeWorkingCount = 0;
            for (const agent of agents) {
                if (agent?.status === AgentStatus.WORKING) activeWorkingCount++;
            }
            this._activeWorkingCount = activeWorkingCount;
            this.villageDirector?.setHarborState?.(this._harborFailedPushState);
            this.buildingRenderer?.setHarborStatus?.({
                failedPushActive: Boolean(this._harborFailedPushState?.hasFailedPush),
                activeWorkingCount,
            });
            if (this.harborTraffic?.consumeChecksPassFlash?.()) {
                this.buildingRenderer?.triggerWatchtowerChecksFlash?.(Date.now());
            }
            this._syncWave3LiveSystems(agents, allSpritesSnapshot, Date.now());
        }
        // VB-9 — the clock advances every frame; reconcile (four observers per
        // agent and the building counts) runs on the 250 ms tick, where its
        // input `agents` changes, as harborTraffic.reconcile does.
        this.landmarkActivity?.advance?.(dt);
        if (slowSystemsTick) this.landmarkActivity?.reconcile?.(agents, allSpritesSnapshot, chronicleNow);
        const updateNow = Date.now();
        this.villageDirector?.update?.(this, dt, updateNow);
        this.buildingRenderer?.setZoom?.(this.camera?.zoom, this.restZoom);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(allSpritesSnapshot);
        this.buildingRenderer?.update(dt);
        this._updateGlassCutaway(updateNow);
        if (slowSystemsTick && this.focusedSquadIds) this._refreshCouncilFocus();
        this._updateAmbientEffects(dt);
        this._updateChimneySmoke();
        // 6.5 — every pennant and flag steps from this frame's wind and clock.
        setPennantWeather(this._lastAtmosphere?.weather || null, this.motionTimeMs);

        // Reap any agent sprites whose 800ms archive-fade window has expired
        // before the particle update so the next frame draws the final state.
        this._pruneArchiveFadedSprites(Date.now());

        // Seasonal ambience emits drift particles into the shared particle
        // system, capped at ~4 spawns/sec and gated by reduced motion inside
        // SeasonalAmbience.update().
        this.seasonalAmbience?.update?.(dt);

        // W6.2 / W6.3 — the date-seeded ambient events (clock, calendar and
        // the village's own weather only, V3) and the lone cloud's pose.
        this.ambientEvents = ambientEventsForHost(this, updateNow);
        this.ambientLoneCloud = loneCloudPose(
            this.ambientEvents?.frequent,
            this._lastAtmosphere?.effectiveDate?.getTime?.() ?? updateNow,
            this._lastAtmosphere?.weather || null,
            this.ambientLoneCloud || createLoneCloudPose(),
        );

        // Rain splashes at agent feet, gated by weather + reduced motion.
        this._updateRainSplashes(dt);

        // Update particles
        this.particleSystem.update(dt);
    }

    _updateChronicleSystems(now = Date.now()) {
        if (this._chronicleUpdating || this._disposed) return;
        this._chronicleUpdating = true;
        const agents = Array.from(this.world?.agents?.values?.() || []);
        const context = {
            waterTiles: this.waterTiles,
            blockedTiles: this._monumentBlockedTiles(),
        };
        // W6.10 — the calendar turns at most once a local midnight (and holds
        // its turn through a live release reveal).
        const lampsLit = lampsLitAt(this._lastAtmosphere);
        (this.villageCalendar ||= new VillageCalendar()).update(now, {
            lampsLit,
            revealLive: this.chronicleMonuments?.releaseRevealLive?.() === true,
        });
        const pending = Promise.allSettled([
            this.chronicleMonuments?.update?.(agents, context, now),
            this.trailRenderer?.update?.(agents, now, this._lastAtmosphere),
        ]);
        this._chronicleUpdatePromise = pending;
        pending.finally(() => {
            if (this._chronicleUpdatePromise === pending) this._chronicleUpdatePromise = null;
            this._chronicleUpdating = false;
            this._reconcileChronicleBanners(Date.now());
            this._invalidateIdleFrame();
        });
    }

    drainChronicleUpdates() {
        return this._chronicleUpdatePromise || Promise.resolve([]);
    }

    _monumentBlockedTiles() {
        if (this._monumentBlockedTilesCache) return this._monumentBlockedTilesCache;
        const out = new Set();
        const grid = this.walkabilityGrid || [];
        if (!grid.length) {
            this._monumentBlockedTilesCache = out;
            return out;
        }
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (!grid[y * MAP_SIZE + x]) out.add(`${x},${y}`);
            }
        }
        this._monumentBlockedTilesCache = out;
        return out;
    }

    // Walk-blocked ground for a steering step (lane discipline, pair pushes,
    // the bend round standing bodies, fan places): continuous clearance against
    // the walk grid, building footprints (+0.25 tile pad, open floors exempt),
    // walk exclusions, village masonry, and the coast signed-distance curve
    // (off walkable bridges). Precomputed flat boxes keep it allocation-free.
    _ensureWalkClearance() {
        if (this._walkClearance) return this._walkClearance;
        if (!this.world?.buildings && !this.bridgeTiles && !this._coastField && !this.coastField) return null;
        this._walkClearance = createWalkClearance({
            buildings: this.world?.buildings,
            bridgeTiles: this.bridgeTiles,
            pathfinder: this.pathfinder,
            getCoastField: () => this._coastField || this.coastField || null,
        });
        return this._walkClearance;
    }

    _isWorldPointWalkable(x, y) {
        const clearance = this._ensureWalkClearance();
        if (clearance) return clearance.isWorldClear(x, y);
        if (!this.pathfinder) return true;
        const tx = (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) * 0.5;
        const ty = (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) * 0.5;
        return this.pathfinder.isWalkable(Math.round(tx), Math.round(ty))
            && !inVillageMasonry(tx, ty);
    }

    _isSpritePositionWalkable(sprite, x, y) {
        if (!this.pathfinder || typeof sprite?._screenToTile !== 'function') return true;
        if (this.pathfinder.surfaceRegistry) {
            const a = worldToTile(sprite.x, sprite.y), b = worldToTile(x, y);
            if (!this.pathfinder.surfaceSegmentClear(a.tileX, a.tileY, b.tileX, b.tileY)) return false;
        }
        return this._isWorldPointWalkable(x, y);
    }

    // A place `sprite` may stand on: walkable, and covering no fixture
    // (brazier, lantern, well, cart, bench it does not sit on).
    _isSpriteStandable(sprite, x, y) {
        return this._isSpritePositionWalkable(sprite, x, y) && !standsOnFixture(x, y, sprite?._restSeat?.id || null);
    }

    _buildLaneTileIndex() {
        const lanes = new Map();
        if (!this.pathTiles?.size) return lanes;
        const crossings = bridgeCrossingTiles(this.bridgeTiles);
        for (const key of this.pathTiles) {
            if (!this._isRoadLikeTileKey(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            if (this.pathfinder && !this.pathfinder.isWalkable(tile.tileX, tile.tileY)) continue;
            const bridge = this.bridgeTiles?.get?.(key);
            const crossing = crossings.get(key);
            const bridgeLanding = Boolean(crossing?.landing);
            const bridgeAxis = laneAxisForBridgeOrientation(bridge?.orientation || (bridgeLanding ? crossing.info?.orientation : null));
            const axis = bridgeAxis || this._bestRoadAxis(tile.tileX, tile.tileY);
            if (!axis) continue;
            const center = tileToWorld(tile.tileX, tile.tileY);
            const next = tileToWorld(tile.tileX + axis.dx, tile.tileY + axis.dy);
            const vx = next.x - center.x;
            const vy = next.y - center.y;
            const length = Math.hypot(vx, vy);
            if (length <= 0) continue;
            const degree = this._roadNeighborCount(tile.tileX, tile.tileY);
            const material = this._roadMaterialForKey(key);
            const plazaLike = this.townSquareTiles?.has(key) || degree >= 4;
            lanes.set(key, {
                tileKey: key,
                tileX: tile.tileX,
                tileY: tile.tileY,
                tangentX: vx / length,
                tangentY: vy / length,
                perpX: -vy / length,
                perpY: vx / length,
                laneOffset: bridgeLanding
                    ? 0
                    : bridge?.kind === 'landmark'
                    ? bridge.laneOffsetPx ?? LANE_STEERING.bridgeOffsetPx
                    : plazaLike
                    ? LANE_STEERING.plazaOffsetPx
                    : material === 'avenue'
                        ? LANE_STEERING.avenueOffsetPx
                        : LANE_STEERING.dirtOffsetPx,
                bridgeLanding,
                material,
                degree,
                plazaLike,
            });
        }
        return lanes;
    }

    _parseTileKey(key) {
        const comma = String(key).indexOf(',');
        if (comma < 0) return null;
        const tileX = Number(String(key).slice(0, comma));
        const tileY = Number(String(key).slice(comma + 1));
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        return { tileX, tileY };
    }

    _isRoadLikeTileKey(key) {
        return !!(
            this.pathTiles?.has(key) &&
            (
                this.mainAvenueTiles?.has(key) ||
                this.dirtPathTiles?.has(key) ||
                this.commandCenterRoadTiles?.has(key) ||
                this.bridgeTiles?.has?.(key)
            )
        );
    }

    _roadMaterialForKey(key) {
        if (this.bridgeTiles?.has?.(key)) return 'bridge';
        if (this.mainAvenueTiles?.has(key) || this.commandCenterRoadTiles?.has(key)) return 'avenue';
        if (this.dirtPathTiles?.has(key)) return 'dirt';
        return 'path';
    }

    // #42 — surface material under a tile, used to key terrain-aware footfall
    // particles (dirt→dust, cobble→scuff, grass→motes, shallow→splash). Reuses
    // the same tile Sets the terrain bake classifies from, so footfalls match
    // the ground the renderer drew. Bridges read as cobble (planked stone deck);
    // deep water never receives footfalls (agents don't walk it).
    _surfaceMaterialAt(tileX, tileY) {
        const key = `${Math.round(tileX)},${Math.round(tileY)}`;
        if (this.waterTiles?.has(key) && !this.bridgeTiles?.has(key)) {
            return this.deepWaterTiles?.has(key) ? 'deep' : 'shallow';
        }
        if (this.bridgeTiles?.has(key)) return 'cobble';
        if (this.mainAvenueTiles?.has(key) || this.commandCenterRoadTiles?.has(key)) return 'cobble';
        if (this.dirtPathTiles?.has(key) || this.pathTiles?.has(key)) return 'dirt';
        return 'grass';
    }

    _roadNeighborCount(tileX, tileY) {
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (this._isRoadLikeTileKey(`${tileX + dx},${tileY + dy}`)) count++;
            }
        }
        return count;
    }

    _bestRoadAxis(tileX, tileY) {
        const axes = [
            { dx: 1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 1, dy: 1 },
            { dx: 1, dy: -1 },
        ];
        let best = null;
        let bestScore = 0;
        for (const axis of axes) {
            let score = 0;
            if (this._isRoadLikeTileKey(`${tileX + axis.dx},${tileY + axis.dy}`)) score++;
            if (this._isRoadLikeTileKey(`${tileX - axis.dx},${tileY - axis.dy}`)) score++;
            if (score > bestScore) {
                best = axis;
                bestScore = score;
            }
        }
        return best;
    }

    _ensureLaneIntIndex() {
        const lanes = this._laneTiles;
        if (
            this._laneTilesByInt
            && this._laneTilesByIntSource === lanes
            && this._laneTilesByIntSize === (lanes?.size || 0)
        ) {
            return this._laneTilesByInt;
        }
        const byInt = this._laneTilesByInt || (this._laneTilesByInt = new Map());
        byInt.clear();
        if (lanes?.size) {
            for (const lane of lanes.values()) {
                if (!lane || !Number.isFinite(lane.tileX) || !Number.isFinite(lane.tileY)) continue;
                byInt.set(((lane.tileX + 1024) << 12) | (lane.tileY + 1024), lane);
            }
        }
        this._laneTilesByIntSource = lanes || null;
        this._laneTilesByIntSize = lanes?.size || 0;
        return byInt;
    }

    _getCrossingIntSet(crossingMap) {
        if (!crossingMap || !crossingMap.size) return null;
        if (
            this._crossingIntSet
            && this._crossingIntSource === crossingMap
            && this._crossingIntSize === crossingMap.size
        ) {
            return this._crossingIntSet;
        }
        const set = this._crossingIntSet || (this._crossingIntSet = new Set());
        set.clear();
        for (const key of crossingMap.keys()) {
            const comma = String(key).indexOf(',');
            if (comma < 0) continue;
            const tx = Number(String(key).slice(0, comma));
            const ty = Number(String(key).slice(comma + 1));
            if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
            set.add(((tx + 1024) << 12) | (ty + 1024));
        }
        this._crossingIntSource = crossingMap;
        this._crossingIntSize = crossingMap.size;
        return set;
    }

    _laneInfoForSprite(sprite) {
        if (!sprite || !this._laneTiles?.size) return null;
        const sx = sprite.x;
        const sy = sprite.y;
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
        const halfW = TILE_WIDTH * 0.5;
        const halfH = TILE_HEIGHT * 0.5;
        const tileX = (sx / halfW + sy / halfH) * 0.5;
        const tileY = (sy / halfH - sx / halfW) * 0.5;
        const baseX = Math.round(tileX);
        const baseY = Math.round(tileY);
        const byInt = this._ensureLaneIntIndex();
        const direct = byInt.get(((baseX + 1024) << 12) | (baseY + 1024));
        if (direct) return direct;

        let best = null;
        let bestDistSq = 1.15 * 1.15;
        for (let dx = -1; dx <= 1; dx++) {
            const cx = baseX + dx;
            const cxShift = (cx + 1024) << 12;
            for (let dy = -1; dy <= 1; dy++) {
                const candidate = byInt.get(cxShift | (baseY + dy + 1024));
                if (!candidate) continue;
                const ddx = tileX - candidate.tileX;
                const ddy = tileY - candidate.tileY;
                const distSq = ddx * ddx + ddy * ddy;
                if (distSq <= bestDistSq) {
                    best = candidate;
                    bestDistSq = distSq;
                }
            }
        }
        return best;
    }

    _laneSideForSprite(sprite, lane) {
        const vx = Number(sprite?.targetX) - Number(sprite?.x);
        const vy = Number(sprite?.targetY) - Number(sprite?.y);
        const along = vx * lane.tangentX + vy * lane.tangentY;
        if (Math.abs(along) > 0.05) return along >= 0 ? 1 : -1;
        return (this._stableHash(sprite?.agent?.id || sprite?.id || '') % 2) === 0 ? 1 : -1;
    }

    // Zero-allocation check for a same-tier ORCA neighbor lying ahead of `desc`
    // within combined body radius (used to hold cleanly in narrow corridors /
    // bridge landings instead of passing through).
    _findNarrowCorridorBlocker(desc, agents, activeCount, outBlocker) {
        if (!desc || !agents || activeCount <= 1) return null;
        let fx = 0;
        let fy = 0;
        if (desc.hasStep) {
            fx = desc.origX - desc.x;
            fy = desc.origY - desc.y;
        }
        let fLen = Math.hypot(fx, fy);
        if (!(fLen > 1e-6) && Number.isFinite(desc.targetX) && Number.isFinite(desc.targetY)) {
            fx = desc.targetX - desc.x;
            fy = desc.targetY - desc.y;
            fLen = Math.hypot(fx, fy);
        }
        if (!(fLen > 1e-6)) return null;
        fx /= fLen;
        fy /= fLen;

        const ax = desc.x;
        const ay = desc.y;
        const aRad = desc.radius;
        const aSprite = desc.sprite;
        const chatPartner = aSprite?.chatPartner || null;

        let bestOther = null;
        let bestDistSq = Infinity;
        for (let j = 0; j < activeCount; j++) {
            const other = agents[j];
            if (!other || other === desc || !sharesAvoidancePlane(desc, other)) continue;
            if (aSprite && (other.sprite === aSprite || other.sprite === chatPartner)) continue;
            const rx = other.x - ax;
            const ry = other.y - ay;
            const rawDistSq = rx * rx + ry * ry;
            // Stacked bodies (< 6 px) separate actively instead of freezing in yield.
            if (rawDistSq < 36) continue;
            const sy = ry * ORCA_Y_SCALE;
            const distSq = rx * rx + sy * sy;
            const combR = aRad + other.radius;
            // Sustain yield with a 1-stride release margin while holding in
            // `_yieldToLeader` (`wasYielding`) so `_followKnotMs` never resets
            // on the next frame when `_stepStartX` is NaN.
            const effR = desc.wasYielding ? (combR + 4.5) : combR;
            const effRSq = effR * effR;
            let inRange = distSq <= effRSq;
            if (!inRange && desc.hasStep) {
                const srx = other.x - desc.origX;
                const sry = (other.y - desc.origY) * ORCA_Y_SCALE;
                if (srx * srx + sry * sry < combR * combR) inRange = true;
            }
            if (!inRange) continue;
            const rawDist = Math.sqrt(rawDistSq);
            if ((rx * fx + ry * fy) < 0.35 * rawDist) continue;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestOther = other;
            }
        }
        if (!bestOther) return null;

        let sameDirection = false;
        if (!bestOther.planted && !bestOther.sprite?._followYield) {
            const bSpd = Math.hypot(bestOther.vx || 0, bestOther.vy || 0);
            if (bSpd > 1e-3 && ((bestOther.vx * fx + bestOther.vy * fy) / bSpd) > 0.35) {
                sameDirection = true;
            }
        }
        outBlocker.other = bestOther;
        outBlocker.distSq = bestDistSq;
        outBlocker.sameDirection = sameDirection;
        return outBlocker;
    }

    // Zero-allocation pure-perpendicular corridor-width probe: returns the clear
    // away side (+1 or -1) if at least one lateral stride perpendicular to the
    // walker's heading is walkable and clear of neighbors; returns 0 only in a
    // genuine narrow corridor or wall-pinched landing where the walker must yield.
    _hasLateralBypassRoom(desc, blocker, agents, activeCount) {
        const sprite = desc.sprite;
        const other = blocker?.other;
        if (!sprite || !other) return 0;
        let dx = desc.hasStep ? (desc.origX - desc.x) : ((Number.isFinite(desc.targetX) ? desc.targetX : desc.x) - desc.x);
        let dy = desc.hasStep ? (desc.origY - desc.y) : ((Number.isFinite(desc.targetY) ? desc.targetY : desc.y) - desc.y);
        let len = Math.hypot(dx, dy);
        if (!(len > 1e-6)) {
            dx = (Number.isFinite(desc.targetX) ? desc.targetX : desc.x) - desc.x;
            dy = (Number.isFinite(desc.targetY) ? desc.targetY : desc.y) - desc.y;
            len = Math.hypot(dx, dy);
            if (!(len > 1e-6)) return 0;
        }
        const fx = dx / len;
        const fy = dy / len;
        const px = -fy;
        const py = fx;
        const dotPerp = (other.x - desc.x) * px + (other.y - desc.y) * py;
        const awaySide = dotPerp >= 0 ? -1 : 1;
        const probeDist = 4.5;
        const selfR = desc.radius || ORCA_AGENT_RADIUS;

        for (let pass = 0; pass < 2; pass++) {
            const side = pass === 0 ? awaySide : -awaySide;
            const lx = desc.x + px * side * probeDist;
            const ly = desc.y + py * side * probeDist;
            if (!this._isSpritePositionWalkable(sprite, lx, ly)) continue;
            const bdx = other.x - lx;
            const bdy = (other.y - ly) * ORCA_Y_SCALE;
            if (bdx * bdx + bdy * bdy < blocker.distSq) continue;
            let sideClear = true;
            for (let j = 0; j < activeCount; j++) {
                const cand = agents[j];
                if (!cand || cand === desc || cand === other) continue;
                if (!sharesAvoidancePlane(desc, cand)) continue;
                const cdx = cand.x - lx;
                const cdy = (cand.y - ly) * ORCA_Y_SCALE;
                const curDx = cand.x - desc.x;
                const curDy = (cand.y - desc.y) * ORCA_Y_SCALE;
                const nextSq = cdx * cdx + cdy * cdy;
                const curSq = curDx * curDx + curDy * curDy;
                const minSep = (selfR + (cand.radius || ORCA_AGENT_RADIUS)) * 0.85;
                if (nextSq < minSep * minSep && nextSq < curSq) {
                    sideClear = false;
                    break;
                }
            }
            if (sideClear) return side;
        }
        return 0;
    }

    // W5-C — lazy-initialized preallocated pools for the 2D ORCA crowd solver.
    // Reused across frames (zero per-frame heap allocations) and safe on
    // `Object.create(IsometricRenderer.prototype)` test harnesses.
    _ensureOrcaPools() {
        if (this._orcaPools) return this._orcaPools;
        // VisitTileAllocator.js contract: walkers may pass road-edge fixtures
        // (`FIXTURE_FEET` restricts standing/fanning places only, not road
        // transit). Only live wildlife and explicit dynamic obstacles enter
        // ORCA's solid-disc obstacle list so lanterns, stalls, and bridge
        // posts never trap walkers on narrow corridors.
        const obstacles = [];
        const pools = {
            pool: [],
            agents: [],
            activeCount: 0,
            obstacles,
            staticFixtureCount: 0,
            wildlifePool: [],
            seenSet: new Set(),
            scratchSteer: { x: 0, y: 0 },
            scratchBlocker: { other: null, distSq: Infinity, sameDirection: false },
            scratchOutVel: new Float64Array(2),
            scratchPrefVel: new Float64Array(2),
            compatNeighbors: [],
            compatSolveOptions: { dt: 1 / 60, maxSpeed: 60, neighborCount: 0 },
            frameWalkClamps: 0,
            stats: {
                frames: 0,
                agents: 0,
                moving: 0,
                planted: 0,
                obstacles: 0,
                lines: 0,
                totalLines: 0,
                maxAgents: 0,
                strideAdjustments: 0,
                walkClamps: 0,
                waypointAdvances: 0,
                swingArcs: 0,
                poolCapacity: 0,
                tau: ORCA_TAU,
                tauObst: ORCA_TAU_OBST,
                yScale: ORCA_Y_SCALE,
            },
            stepOptions: null,
        };
        // Forward-progress cone (cos 45° ≈ 0.707; relaxed to cos 75° ≈ 0.259
        // when a neighbor lies directly ahead within combined radius): ORCA
        // peels cleanly around neighbors on walkable ground without orbiting
        // waypoints, and yields cleanly on contact frames in narrow corridors
        // when lateral bypass is unwalkable.
        const MIN_FORWARD_DOT = 0.70710678;
        const MAX_LATERAL_SIN = Math.sqrt(1 - MIN_FORWARD_DOT * MIN_FORWARD_DOT);
        const MIN_CLOSE_FORWARD_DOT = 0.25881905;
        const MAX_CLOSE_LATERAL_SIN = Math.sqrt(1 - MIN_CLOSE_FORWARD_DOT * MIN_CLOSE_FORWARD_DOT);
        const strideSteer = (desc, proposedX, proposedY) => {
            const sprite = desc.sprite;
            if (!sprite) {
                pools.scratchSteer.x = proposedX;
                pools.scratchSteer.y = proposedY;
                return pools.scratchSteer;
            }
            if (sprite._stopLookActiveMs > 0) return null;
            if (typeof sprite.steeredPosition === 'function') {
                const blocker = this._findNarrowCorridorBlocker(desc, pools.agents, pools.activeCount, pools.scratchBlocker);
                const inWalkOut = (sprite._followYieldMs || 0) < 0;
                let targetX = proposedX;
                let targetY = proposedY;
                let clampedCloseSide = 0;
                let stepFx = 0;
                let stepFy = 0;
                let stepLen = 0;
                if (desc.hasStep && desc.stepLength > 1e-6) {
                    const stepDx = desc.origX - desc.x;
                    const stepDy = desc.origY - desc.y;
                    stepLen = Math.hypot(stepDx, stepDy);
                    if (stepLen > 1e-6) {
                        stepFx = stepDx / stepLen;
                        stepFy = stepDy / stepLen;
                    }
                    // On the final step into a waypoint (or right after turning
                    // a waypoint corner inside AgentSprite.update), preserve the
                    // sprite's clean waypoint landing when no neighbor blocks ahead.
                    const distToWp = Number.isFinite(desc.targetX) && Number.isFinite(desc.targetY)
                        ? Math.hypot(desc.targetX - desc.x, desc.targetY - desc.y)
                        : Infinity;
                    if (!blocker && distToWp <= Math.max(12, stepLen * 2.5)) {
                        pools.scratchSteer.x = desc.origX;
                        pools.scratchSteer.y = desc.origY;
                        return pools.scratchSteer;
                    }
                    const propDx = proposedX - desc.x;
                    const propDy = proposedY - desc.y;
                    const propLen = Math.hypot(propDx, propDy);
                    if (!(propLen > 1e-6)) {
                        if (blocker && !inWalkOut) {
                            // In open plazas/roads, peel laterally around the
                            // blocker instead of stalling; yield only when
                            // neither lateral side is clear (narrow corridor).
                            const bypassSide = stepLen > 1e-6
                                ? this._hasLateralBypassRoom(desc, blocker, pools.agents, pools.activeCount)
                                : 0;
                            if (bypassSide !== 0) {
                                const bx75 = desc.x + (stepFx * MIN_CLOSE_FORWARD_DOT + (-stepFy * bypassSide) * MAX_CLOSE_LATERAL_SIN) * stepLen;
                                const by75 = desc.y + (stepFy * MIN_CLOSE_FORWARD_DOT + (stepFx * bypassSide) * MAX_CLOSE_LATERAL_SIN) * stepLen;
                                const k75 = sprite.steeredPosition(bx75, by75);
                                if (k75 && this._isSpritePositionWalkable(sprite, k75.x, k75.y)) {
                                    pools.scratchSteer.x = k75.x;
                                    pools.scratchSteer.y = k75.y;
                                    return pools.scratchSteer;
                                }
                                const bx45 = desc.x + (stepFx * MIN_FORWARD_DOT + (-stepFy * bypassSide) * MAX_LATERAL_SIN) * stepLen;
                                const by45 = desc.y + (stepFy * MIN_FORWARD_DOT + (stepFx * bypassSide) * MAX_LATERAL_SIN) * stepLen;
                                const k45 = sprite.steeredPosition(bx45, by45);
                                if (k45 && this._isSpritePositionWalkable(sprite, k45.x, k45.y)) {
                                    pools.scratchSteer.x = k45.x;
                                    pools.scratchSteer.y = k45.y;
                                    return pools.scratchSteer;
                                }
                            }
                            if (this._isSpritePositionWalkable(sprite, desc.x, desc.y)) {
                                desc.yieldHold = true;
                                desc.yieldKind = blocker.sameDirection ? true : 'knot';
                                pools.frameWalkClamps++;
                                return null;
                            }
                        }
                        pools.scratchSteer.x = desc.origX;
                        pools.scratchSteer.y = desc.origY;
                        return pools.scratchSteer;
                    }
                    if (stepLen > 1e-6) {
                        const ox = propDx / propLen;
                        const oy = propDy / propLen;
                        const dot = ox * stepFx + oy * stepFy;
                        const minDot = blocker ? MIN_CLOSE_FORWARD_DOT : MIN_FORWARD_DOT;
                        const maxSin = blocker ? MAX_CLOSE_LATERAL_SIN : MAX_LATERAL_SIN;
                        if (dot < minDot) {
                            const cross = stepFx * oy - stepFy * ox;
                            const side = Math.abs(cross) > 1e-6
                                ? (cross > 0 ? 1 : -1)
                                : ((this._stableHash(desc.id || '') & 1) ? 1 : -1);
                            const cdx = stepFx * minDot + (-stepFy * side) * maxSin;
                            const cdy = stepFy * minDot + (stepFx * side) * maxSin;
                            targetX = desc.x + cdx * stepLen;
                            targetY = desc.y + cdy * stepLen;
                            if (blocker) clampedCloseSide = side;
                        }
                    }
                }
                const kept = sprite.steeredPosition(targetX, targetY);
                if (kept && this._isSpritePositionWalkable(sprite, kept.x, kept.y)) {
                    pools.scratchSteer.x = kept.x;
                    pools.scratchSteer.y = kept.y;
                    return pools.scratchSteer;
                }
                // If a 75° close peel hit a corridor wall, try a 45° peel, or the
                // opposite clear lateral side in open space, before yielding.
                if (blocker && stepLen > 1e-6) {
                    if (clampedCloseSide !== 0) {
                        const altX = desc.x + (stepFx * MIN_FORWARD_DOT + (-stepFy * clampedCloseSide) * MAX_LATERAL_SIN) * stepLen;
                        const altY = desc.y + (stepFy * MIN_FORWARD_DOT + (stepFx * clampedCloseSide) * MAX_LATERAL_SIN) * stepLen;
                        const kept45 = sprite.steeredPosition(altX, altY);
                        if (kept45 && this._isSpritePositionWalkable(sprite, kept45.x, kept45.y)) {
                            pools.scratchSteer.x = kept45.x;
                            pools.scratchSteer.y = kept45.y;
                            return pools.scratchSteer;
                        }
                    }
                    const bypassSide = this._hasLateralBypassRoom(desc, blocker, pools.agents, pools.activeCount);
                    if (bypassSide !== 0 && bypassSide !== clampedCloseSide) {
                        const ox75 = desc.x + (stepFx * MIN_CLOSE_FORWARD_DOT + (-stepFy * bypassSide) * MAX_CLOSE_LATERAL_SIN) * stepLen;
                        const oy75 = desc.y + (stepFy * MIN_CLOSE_FORWARD_DOT + (stepFx * bypassSide) * MAX_CLOSE_LATERAL_SIN) * stepLen;
                        const k75 = sprite.steeredPosition(ox75, oy75);
                        if (k75 && this._isSpritePositionWalkable(sprite, k75.x, k75.y)) {
                            pools.scratchSteer.x = k75.x;
                            pools.scratchSteer.y = k75.y;
                            return pools.scratchSteer;
                        }
                        const ox45 = desc.x + (stepFx * MIN_FORWARD_DOT + (-stepFy * bypassSide) * MAX_LATERAL_SIN) * stepLen;
                        const oy45 = desc.y + (stepFy * MIN_FORWARD_DOT + (stepFx * bypassSide) * MAX_LATERAL_SIN) * stepLen;
                        const k45 = sprite.steeredPosition(ox45, oy45);
                        if (k45 && this._isSpritePositionWalkable(sprite, k45.x, k45.y)) {
                            pools.scratchSteer.x = k45.x;
                            pools.scratchSteer.y = k45.y;
                            return pools.scratchSteer;
                        }
                    }
                }
                // Narrow-corridor / bridge-landing yield: when ORCA's steered step
                // is unwalkable AND a neighbor lies ahead within combined radius,
                // hold cleanly on the contact frame (`_followYield`) instead of
                // marching straight through the neighbor (bounded by `_yieldToLeader`
                // knot timeout so opposing walkers never deadlock).
                if (blocker && !inWalkOut && this._isSpritePositionWalkable(sprite, desc.x, desc.y)) {
                    desc.yieldHold = true;
                    desc.yieldKind = blocker.sameDirection ? true : 'knot';
                    pools.frameWalkClamps++;
                    return null;
                }
                // No neighbor blocking ahead (or escaping unwalkable start / knot walk-out):
                // try AgentSprite's own stepped position BEFORE screen-axis crab fallbacks.
                if (desc.hasStep && this._isSpritePositionWalkable(sprite, desc.origX, desc.origY)) {
                    pools.scratchSteer.x = desc.origX;
                    pools.scratchSteer.y = desc.origY;
                    pools.frameWalkClamps++;
                    return pools.scratchSteer;
                }
                const keptX = sprite.steeredPosition(targetX, desc.y);
                if (keptX && this._isSpritePositionWalkable(sprite, keptX.x, keptX.y)) {
                    pools.scratchSteer.x = keptX.x;
                    pools.scratchSteer.y = keptX.y;
                    pools.frameWalkClamps++;
                    return pools.scratchSteer;
                }
                const keptY = sprite.steeredPosition(desc.x, targetY);
                if (keptY && this._isSpritePositionWalkable(sprite, keptY.x, keptY.y)) {
                    pools.scratchSteer.x = keptY.x;
                    pools.scratchSteer.y = keptY.y;
                    pools.frameWalkClamps++;
                    return pools.scratchSteer;
                }
                // Always keep AgentSprite's own stepped position when escaping an
                // unwalkable wall edge rather than rewinding back onto it.
                if (desc.hasStep) {
                    pools.scratchSteer.x = desc.origX;
                    pools.scratchSteer.y = desc.origY;
                    pools.frameWalkClamps++;
                    return pools.scratchSteer;
                }
                pools.frameWalkClamps++;
                return null;
            }
            if (this._isSpritePositionWalkable(sprite, proposedX, proposedY)) {
                pools.scratchSteer.x = proposedX;
                pools.scratchSteer.y = proposedY;
                return pools.scratchSteer;
            }
            if (this._isSpritePositionWalkable(sprite, proposedX, desc.y)) {
                pools.scratchSteer.x = proposedX;
                pools.scratchSteer.y = desc.y;
                pools.frameWalkClamps++;
                return pools.scratchSteer;
            }
            if (this._isSpritePositionWalkable(sprite, desc.x, proposedY)) {
                pools.scratchSteer.x = desc.x;
                pools.scratchSteer.y = proposedY;
                pools.frameWalkClamps++;
                return pools.scratchSteer;
            }
            pools.frameWalkClamps++;
            return null;
        };
        const isWalkable = (desc, x, y) => {
            const sprite = desc.sprite;
            // If a stepped sprite fell back to its own `origX/origY` (e.g.
            // stepping out of a wall edge or crossing a narrow bridge), do not
            // reject it back to `_stepStartX/_stepStartY`.
            if (desc.hasStep && Math.abs(x - desc.origX) < 1e-6 && Math.abs(y - desc.origY) < 1e-6) {
                return true;
            }
            return !sprite || this._isSpritePositionWalkable(sprite, x, y);
        };
        pools.stepOptions = {
            dt: 1 / 60,
            integrate: true,
            contextSteering: true,
            arrivalRadius: 0.05,
            queryCells: 1,
            strideSteer,
            isWalkable,
        };
        this._orcaPools = pools;
        return pools;
    }

    _acquireOrcaDescriptor(pools, index) {
        let desc = pools.pool[index];
        if (!desc) {
            desc = {
                id: '',
                sprite: null,
                x: 0,
                y: 0,
                startX: 0,
                startY: 0,
                vx: 0,
                vy: 0,
                targetX: NaN,
                targetY: NaN,
                gaitSpeed: 45,
                radius: ORCA_AGENT_RADIUS,
                planted: false,
                surfaceTier: 0,
                swingActive: false,
                swingRadius: ORCA_SWING_RADIUS,
                swingX: NaN,
                swingY: NaN,
                swingOffsetX: NaN,
                swingOffsetY: NaN,
                direction: 's',
                hasStep: false,
                stepLength: 0,
                origX: 0,
                origY: 0,
                wasYielding: false,
                yieldHold: false,
                yieldKind: false,
            };
            pools.pool[index] = desc;
            pools.stats.poolCapacity = pools.pool.length;
        }
        return desc;
    }

    _populateOrcaObstacles(pools, extraObstacles = null) {
        const obstacles = pools.obstacles;
        const includeFixtures = this._disableStaticOrcaFixtures !== true;
        obstacles.length = includeFixtures ? pools.staticFixtureCount : 0;
        let wildlifeIdx = 0;

        const wildlife = this.wildlifeRenderer;
        const livestock = wildlife?._livestockPoses;
        if (Array.isArray(livestock)) {
            for (let i = 0; i < livestock.length; i++) {
                const pose = livestock[i];
                if (!pose || !pose.route || !(pose.alpha > 0.05)) continue;
                if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
                let obs = pools.wildlifePool[wildlifeIdx];
                if (!obs) {
                    obs = { x: 0, y: 0, radius: 10, tau: ORCA_TAU_OBST, surfaceTier: 0, kind: 'wildlife' };
                    pools.wildlifePool[wildlifeIdx] = obs;
                }
                wildlifeIdx++;
                obs.x = pose.x;
                obs.y = pose.y;
                obs.radius = 10;
                obs.surfaceTier = 0;
                obstacles.push(obs);
            }
        }
        const deer = wildlife?._deerPose;
        if (deer && deer.walking && deer.alpha > 0.05) {
            const dx = Number.isFinite(deer.x)
                ? deer.x
                : (Number.isFinite(deer.tileX) && Number.isFinite(deer.tileY)
                    ? (deer.tileX - deer.tileY) * (TILE_WIDTH * 0.5)
                    : NaN);
            const dy = Number.isFinite(deer.y)
                ? deer.y
                : (Number.isFinite(deer.tileX) && Number.isFinite(deer.tileY)
                    ? (deer.tileX + deer.tileY) * (TILE_HEIGHT * 0.5)
                    : NaN);
            if (Number.isFinite(dx) && Number.isFinite(dy)) {
                let obs = pools.wildlifePool[wildlifeIdx];
                if (!obs) {
                    obs = { x: 0, y: 0, radius: 11, tau: ORCA_TAU_OBST, surfaceTier: 0, kind: 'wildlife' };
                    pools.wildlifePool[wildlifeIdx] = obs;
                }
                wildlifeIdx++;
                obs.x = dx;
                obs.y = dy;
                obs.radius = 11;
                obs.surfaceTier = 0;
                obstacles.push(obs);
            }
        }
        if (Array.isArray(extraObstacles)) {
            for (let i = 0; i < extraObstacles.length; i++) {
                if (extraObstacles[i]) obstacles.push(extraObstacles[i]);
            }
        }
        return obstacles;
    }

    _fillOrcaDescriptor(desc, sprite, forcePlanted, dtSec, fallbackIdx) {
        const hasSteerFn = typeof sprite.steeredPosition === 'function';
        const planted = forcePlanted
            || sprite.planted === true
            || sprite.moving === false
            || sprite.chatting === true
            || sprite._stopLookActiveMs > 0
            || Boolean(sprite.isArrivalPending?.())
            || (hasSteerFn && !Number.isFinite(sprite._stepStartX));

        const hasStep = !planted
            && Number.isFinite(sprite._stepStartX)
            && Number.isFinite(sprite._stepStartY)
            && Number(sprite._stepLength) > 0;
        const baseX = hasStep ? sprite._stepStartX : (Number.isFinite(sprite.x) ? sprite.x : 0);
        const baseY = hasStep ? sprite._stepStartY : (Number.isFinite(sprite.y) ? sprite.y : 0);
        const origX = Number.isFinite(sprite.x) ? sprite.x : baseX;
        const origY = Number.isFinite(sprite.y) ? sprite.y : baseY;

        let gaitSpeed = 45;
        if (Number.isFinite(sprite.gaitSpeed) && sprite.gaitSpeed > 0) {
            gaitSpeed = sprite.gaitSpeed;
        } else if (Number.isFinite(sprite._gaitSpeed) && sprite._gaitSpeed > 0) {
            gaitSpeed = sprite._gaitSpeed <= 10 ? sprite._gaitSpeed * 60 : sprite._gaitSpeed;
        } else if (hasStep) {
            gaitSpeed = sprite._stepLength / dtSec;
        } else if (Number.isFinite(sprite.maxSpeed) && sprite.maxSpeed > 0) {
            gaitSpeed = sprite.maxSpeed;
        }

        let tx = Number(sprite.targetX);
        let ty = Number(sprite.targetY);
        // Fold road/bridge lane lateral bias into Context Steering desired target.
        if (
            !planted
            && Number.isFinite(tx)
            && Number.isFinite(ty)
            && this._laneTiles?.size > 0
            && !sprite.chatPartner
            && !sprite.chatting
        ) {
            const toTargetDist = Math.hypot(tx - baseX, ty - baseY);
            if (toTargetDist > LANE_STEERING.arrivalDistancePx) {
                const lane = this._laneInfoForSprite(sprite);
                if (lane) {
                    const side = this._laneSideForSprite(sprite, lane);
                    const centerX = (lane.tileX - lane.tileY) * (TILE_WIDTH * 0.5);
                    const centerY = (lane.tileX + lane.tileY) * (TILE_HEIGHT * 0.5);
                    const currentOffset = (baseX - centerX) * lane.perpX + (baseY - centerY) * lane.perpY;
                    const desiredOffset = lane.laneOffset * side;
                    const correction = desiredOffset - currentOffset;
                    if (Math.abs(correction) >= LANE_STEERING.minimumCorrectionPx) {
                        const nudge = Math.max(-6, Math.min(6, correction));
                        tx += lane.perpX * nudge;
                        ty += lane.perpY * nudge;
                        this._markLaneDiscipline(sprite, lane.tileKey, side, desiredOffset);
                        if (this._localAvoidanceMetrics) this._localAvoidanceMetrics.laneCorrections++;
                    } else {
                        this._markLaneDiscipline(sprite, lane.tileKey, side, desiredOffset);
                    }
                } else {
                    delete sprite._laneDiscipline;
                }
            } else {
                delete sprite._laneDiscipline;
            }
        }

        let vx = 0;
        let vy = 0;
        if (!planted) {
            if (Number.isFinite(sprite._orcaVx) && Number.isFinite(sprite._orcaVy)) {
                vx = sprite._orcaVx;
                vy = sprite._orcaVy;
            } else if (hasStep) {
                vx = (origX - baseX) / dtSec;
                vy = (origY - baseY) / dtSec;
            } else if (Number.isFinite(sprite.vx) && Number.isFinite(sprite.vy)) {
                vx = sprite.vx;
                vy = sprite.vy;
            } else if (Number.isFinite(tx) && Number.isFinite(ty)) {
                const dx = tx - baseX;
                const dy = ty - baseY;
                const dist = Math.hypot(dx, dy);
                if (dist > 1e-4) {
                    vx = (dx / dist) * gaitSpeed;
                    vy = (dy / dist) * gaitSpeed;
                }
            }
        }

        const poseCell = sprite._poseCell;
        const swingActive = sprite.swingActive === true
            || (sprite.activePose === 'strike'
                && Number.isFinite(sprite.poseFrame)
                && Number.isFinite(sprite.contactFrame)
                && Math.abs(sprite.poseFrame - sprite.contactFrame) <= 1)
            || (poseCell?.source === 'strip' && poseCell?.group === 'strike');

        desc.id = this._spriteStableId(sprite, fallbackIdx);
        desc.sprite = sprite;
        desc.x = baseX;
        desc.y = baseY;
        desc.startX = baseX;
        desc.startY = baseY;
        desc.vx = vx;
        desc.vy = vy;
        desc.targetX = tx;
        desc.targetY = ty;
        desc.gaitSpeed = gaitSpeed;
        desc.radius = Number.isFinite(sprite.orcaRadius) && sprite.orcaRadius > 0
            ? sprite.orcaRadius
            : (Number.isFinite(sprite.radius) && sprite.radius > 0 ? sprite.radius : ORCA_AGENT_RADIUS);
        desc.planted = planted;
        const support = worldToTile(baseX, baseY);
        desc.supportH = sprite.getBridgeLift?.(support.tileX, support.tileY) ?? 0;
        desc.surfaceTier = Number.isFinite(sprite.surfaceTier)
            ? sprite.surfaceTier
            : (Number.isFinite(sprite.agent?.surfaceTier) ? sprite.agent.surfaceTier : 0);
        desc.swingActive = swingActive;
        desc.swingRadius = Number.isFinite(sprite.swingRadius) && sprite.swingRadius > 0
            ? sprite.swingRadius
            : ORCA_SWING_RADIUS;
        desc.swingX = Number.isFinite(sprite.swingX) ? sprite.swingX : NaN;
        desc.swingY = Number.isFinite(sprite.swingY) ? sprite.swingY : NaN;
        desc.swingOffsetX = Number.isFinite(sprite.swingOffsetX) ? sprite.swingOffsetX : NaN;
        desc.swingOffsetY = Number.isFinite(sprite.swingOffsetY) ? sprite.swingOffsetY : NaN;
        // SpriteSheet.DIRECTIONS is ['s','se','e','ne','n','nw','w','sw'],
        // whereas CrowdOrca.DIR_X/Y is compass E..NE; always pass short direction
        // name so strike-swing discs align on all 8 facings.
        desc.direction = typeof sprite.direction === 'number'
            ? (DIRECTIONS[sprite.direction] || 's')
            : (sprite.direction || 's');
        desc.hasStep = hasStep;
        desc.stepLength = hasStep ? sprite._stepLength : 0;
        desc.origX = origX;
        desc.origY = origY;
        desc.wasYielding = false;
        desc.yieldHold = false;
        desc.yieldKind = false;
        return desc;
    }

    _markLaneDiscipline(sprite, tileKey, side, offsetPx) {
        const mark = sprite._laneDisciplineMark ||= { tileKey: '', side: 0, offsetPx: 0 };
        mark.tileKey = tileKey;
        mark.side = side;
        mark.offsetPx = offsetPx;
        sprite._laneDiscipline = mark;
    }

    // V7 — steering proposes a position; the body keeps its stride. A sprite
    // that stepped this refresh takes the proposal's course at its own step
    // length (AgentSprite.steeredPosition), so crowd nudges never break the
    // 4.5 px walk frame; one that did not step (a start beat, a pivot, a
    // stop, a look at a landmark) is not moved at all, so nothing skates.
    // Null = leave it.
    _strideKeptSteer(sprite, proposed) {
        if (sprite?._stopLookActiveMs > 0) return null;
        if (typeof sprite?.steeredPosition !== 'function') return proposed;
        return sprite.steeredPosition(proposed.x, proposed.y);
    }

    // W5-C — allocation-free 2D ORCA crowd step (`CrowdOrca.stepCrowdOrca`).
    // Replaces legacy reactive avoidance, follow-gap queues, landing hops, and
    // stack fans while preserving V7 stride lock, WalkClearance walkability,
    // planted immobility, and 10 px final arrival fanning.
    _stepOrcaCrowd(movingSprites, dt = 16, extraObstacles = null) {
        const pools = this._ensureOrcaPools();
        const metrics = this._localAvoidanceMetrics || (this._localAvoidanceMetrics = {
            laneCorrections: 0,
            separationPushes: 0,
            zeroDistancePairs: 0,
            progressClamps: 0,
            orcaFrames: 0,
            orcaLines: 0,
            strideAdjustments: 0,
            walkClamps: 0,
            waypointAdvances: 0,
        });
        const agents = pools.agents;
        const seen = pools.seenSet;
        agents.length = 0;
        seen.clear();
        pools.frameWalkClamps = 0;

        const dtMs = Math.max(1, Math.min(100, Number(dt) || 16.67));
        const dtSec = dtMs / 1000;
        let activeCount = 0;
        let movingCount = 0;
        let plantedCount = 0;
        let swingArcCount = 0;

        if (movingSprites?.length) {
            for (let i = 0; i < movingSprites.length; i++) {
                const sprite = movingSprites[i];
                if (!sprite || seen.has(sprite)) continue;
                seen.add(sprite);
                const wasYielding = Boolean(sprite._followYield);
                // Clear legacy reactive queue flags cleanly (re-asserted below if still blocked).
                sprite._followGap = false;
                sprite._followYield = false;
                const desc = this._acquireOrcaDescriptor(pools, activeCount);
                this._fillOrcaDescriptor(desc, sprite, false, dtSec, activeCount);
                desc.wasYielding = wasYielding;
                agents[activeCount++] = desc;
                if (desc.planted) plantedCount++;
                else movingCount++;
                if (desc.swingActive) swingArcCount++;
            }
        }

        if (this.agentSprites?.size > 0) {
            for (const sprite of this.agentSprites.values()) {
                if (!sprite || seen.has(sprite)) continue;
                // Keep walkers already inside the gate channel as solid ORCA
                // obstacles so approaching crowds don't pile at the gatehouse;
                // skip only hidden arrival-pending or archive-fading sprites.
                if (sprite.isArrivalPending?.() || sprite._archiveAnim) continue;
                seen.add(sprite);
                const desc = this._acquireOrcaDescriptor(pools, activeCount);
                this._fillOrcaDescriptor(desc, sprite, true, dtSec, activeCount);
                agents[activeCount++] = desc;
                plantedCount++;
                if (desc.swingActive) swingArcCount++;
            }
        }

        pools.activeCount = activeCount;

        // Sustain narrow-corridor contact-frame yield for sprites holding in
        // AgentSprite._yieldToLeader ONLY while their blocker remains ahead and
        // no clear perpendicular lateral bypass exists (bounded by _yieldToLeader's knot timeout).
        for (let i = 0; i < activeCount; i++) {
            const desc = agents[i];
            const sprite = desc.sprite;
            if (!desc.wasYielding || !desc.planted || !sprite || !sprite.moving) continue;
            if ((sprite._followYieldMs || 0) < 0) continue;
            const blocker = this._findNarrowCorridorBlocker(desc, agents, activeCount, pools.scratchBlocker);
            if (!blocker) continue;
            if (this._hasLateralBypassRoom(desc, blocker, agents, activeCount) === 0) {
                sprite._followYield = blocker.sameDirection ? true : 'knot';
            }
        }

        const obstacles = this._populateOrcaObstacles(pools, extraObstacles);
        let lines = 0;
        let adjustments = 0;
        let waypointAdvances = 0;

        if (movingCount > 0) {
            pools.stepOptions.dt = dtSec;
            lines = stepCrowdOrca(agents, dtSec, obstacles, pools.stepOptions);

            const obstructRadius = ORCA_AGENT_RADIUS * 2.0;
            const obstructRadiusSq = obstructRadius * obstructRadius;
            const halfW = TILE_WIDTH * 0.5;
            const halfH = TILE_HEIGHT * 0.5;

            for (let i = 0; i < activeCount; i++) {
                const desc = agents[i];
                const sprite = desc.sprite;
                if (!sprite) continue;
                if (desc.planted || isAgentPlanted(desc)) {
                    sprite._orcaVx = 0;
                    sprite._orcaVy = 0;
                    if (Number.isFinite(sprite.vx)) sprite.vx = 0;
                    if (Number.isFinite(sprite.vy)) sprite.vy = 0;
                    continue;
                }

                let finalX;
                let finalY;
                if (desc.yieldHold) {
                    // Narrow-corridor contact-frame yield: hold at pre-step start
                    // and pause AgentSprite's walk stride cleanly via `_followYield`.
                    finalX = desc.startX;
                    finalY = desc.startY;
                    sprite._followYield = desc.yieldKind || 'knot';
                } else {
                    // Never rewind a sprite that already stepped in AgentSprite.update()
                    // back to its pre-step start when ORCA declined to integrate.
                    const stepMoved = desc.hasStep && Number.isFinite(sprite._stepStartX)
                        ? Math.hypot(desc.x - sprite._stepStartX, desc.y - sprite._stepStartY)
                        : 1;
                    finalX = desc.hasStep && stepMoved < 1e-5 ? desc.origX : desc.x;
                    finalY = desc.hasStep && stepMoved < 1e-5 ? desc.origY : desc.y;
                }

                // Store actual realized velocity rather than raw unclamped solver velocity.
                const refStartX = desc.hasStep && Number.isFinite(sprite._stepStartX) ? sprite._stepStartX : desc.startX;
                const refStartY = desc.hasStep && Number.isFinite(sprite._stepStartY) ? sprite._stepStartY : desc.startY;
                const realVx = (finalX - refStartX) / dtSec;
                const realVy = (finalY - refStartY) / dtSec;
                sprite._orcaVx = realVx;
                sprite._orcaVy = realVy;
                if (Number.isFinite(sprite.vx)) sprite.vx = realVx;
                if (Number.isFinite(sprite.vy)) sprite.vy = realVy;

                if (Math.hypot(finalX - desc.origX, finalY - desc.origY) > 0.001) {
                    adjustments++;
                }
                sprite.x = finalX;
                sprite.y = finalY;

                // Advance past an obstructed or bypassed non-crossing intermediate
                // waypoint as soon as the line to the next waypoint is walkable so
                // walkers never backtrack or orbit a waypoint they already passed.
                if (Array.isArray(sprite.waypoints) && sprite.waypoints.length > 1) {
                    const distToWp = Math.hypot(sprite.targetX - sprite.x, sprite.targetY - sprite.y);
                    let shouldAdvance = distToWp <= 14;
                    if (!shouldAdvance) {
                        for (let j = 0; j < activeCount; j++) {
                            if (j === i) continue;
                            const other = agents[j];
                            if (!other.planted || !sharesAvoidancePlane(desc, other)) continue;
                            const dx = sprite.targetX - other.x;
                            const dy = (sprite.targetY - other.y) * ORCA_Y_SCALE;
                            if (dx * dx + dy * dy < obstructRadiusSq) {
                                shouldAdvance = true;
                                break;
                            }
                        }
                    }
                    if (shouldAdvance) {
                        const nextWp = sprite.waypoints[1];
                        const crossingMap = sprite._crossingTiles?.();
                        let onCrossing = false;
                        if (crossingMap?.size) {
                            const wtx = Math.round((sprite.targetX / halfW + sprite.targetY / halfH) * 0.5);
                            const wty = Math.round((sprite.targetY / halfH - sprite.targetX / halfW) * 0.5);
                            const crossingInts = this._getCrossingIntSet(crossingMap);
                            onCrossing = Boolean(crossingInts?.has(((wtx + 1024) << 12) | (wty + 1024)));
                        }
                        if (!onCrossing && nextWp && sprite._isScreenSegmentWalkable?.(sprite.x, sprite.y, nextWp.x, nextWp.y)) {
                            sprite.waypoints.shift();
                            sprite.targetX = nextWp.x;
                            sprite.targetY = nextWp.y;
                            waypointAdvances++;
                        }
                    }
                }
            }
        }

        const stats = pools.stats;
        stats.frames++;
        stats.agents = activeCount;
        stats.moving = movingCount;
        stats.planted = plantedCount;
        stats.obstacles = obstacles.length;
        stats.lines = lines;
        stats.totalLines += lines;
        if (activeCount > stats.maxAgents) stats.maxAgents = activeCount;
        stats.strideAdjustments += adjustments;
        stats.walkClamps += pools.frameWalkClamps;
        stats.waypointAdvances += waypointAdvances;
        stats.swingArcs = swingArcCount;
        stats.poolCapacity = pools.pool.length;

        metrics.orcaFrames = (metrics.orcaFrames || 0) + 1;
        metrics.orcaLines = (metrics.orcaLines || 0) + lines;
        metrics.strideAdjustments = (metrics.strideAdjustments || 0) + adjustments;
        metrics.walkClamps = (metrics.walkClamps || 0) + pools.frameWalkClamps;
        metrics.waypointAdvances = (metrics.waypointAdvances || 0) + waypointAdvances;
        if (adjustments > 0) {
            metrics.separationPushes = (metrics.separationPushes || 0) + adjustments;
            this._markSpritesDirty();
        }

        if (movingSprites?.length) {
            this._fanArrivals(movingSprites);
        }
        return lines;
    }

    _applyLocalAvoidance(movingSprites, dt = 16, extraObstacles = null) {
        return this._stepOrcaCrowd(movingSprites, dt, extraObstacles);
    }

    getCrowdOrcaDiagnostics() {
        const stats = this._orcaPools?.stats;
        if (!stats) {
            return {
                frames: 0,
                agents: 0,
                moving: 0,
                planted: 0,
                obstacles: 0,
                lines: 0,
                totalLines: 0,
                maxAgents: 0,
                strideAdjustments: 0,
                walkClamps: 0,
                waypointAdvances: 0,
                swingArcs: 0,
                poolCapacity: 0,
                tau: ORCA_TAU,
                tauObst: ORCA_TAU_OBST,
                yScale: ORCA_Y_SCALE,
            };
        }
        return { ...stats };
    }

    // W5-C — thin ORCA-backed compatibility delegate for direct standing-avoidance
    // callers; live simulation runs all planted + moving bodies inside `_stepOrcaCrowd`.
    _steerAroundStanding(movingSprites, headings) {
        if (!movingSprites?.length || !this.agentSprites?.size) return 0;
        const pools = this._ensureOrcaPools();
        const neighbors = pools.compatNeighbors;
        neighbors.length = 0;
        let poolIdx = 0;
        const dtSec = 1 / 60;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || !this._isPlanted(sprite) || this._isGateTransit(sprite, 'departure')) continue;
            const desc = this._acquireOrcaDescriptor(pools, poolIdx++);
            this._fillOrcaDescriptor(desc, sprite, true, dtSec, poolIdx - 1);
            neighbors.push(desc);
        }
        if (!neighbors.length) return 0;

        let steered = 0;
        const obstructRadius = ORCA_AGENT_RADIUS * 2.0;
        const obstructRadiusSq = obstructRadius * obstructRadius;
        const solveOpts = pools.compatSolveOptions;
        solveOpts.dt = dtSec;
        solveOpts.neighborCount = neighbors.length;

        for (let i = 0; i < movingSprites.length; i++) {
            const walker = movingSprites[i];
            if (!walker || this._isPlanted(walker)) continue;
            const stop = this._fanStopOf(walker);
            if (stop.reach <= PERFORMING_FAN.approachPx) continue;

            const desc = this._acquireOrcaDescriptor(pools, poolIdx);
            this._fillOrcaDescriptor(desc, walker, false, dtSec, poolIdx);
            const heading = headings?.get?.(walker) || null;
            const desVx = heading ? heading.x * desc.gaitSpeed : desc.vx;
            const desVy = heading ? heading.y * desc.gaitSpeed : desc.vy;
            solveOpts.maxSpeed = desc.gaitSpeed;

            computePreferredVelocity(
                desc,
                desVx,
                desVy,
                desc.gaitSpeed,
                neighbors,
                null,
                pools.scratchPrefVel,
                solveOpts,
            );
            solveOrcaVelocity(
                desc,
                pools.scratchPrefVel[0],
                pools.scratchPrefVel[1],
                neighbors,
                null,
                pools.scratchOutVel,
                solveOpts,
            );

            let outVx = pools.scratchOutVel[0];
            let outVy = pools.scratchOutVel[1];
            const hLen = Math.hypot(desVx, desVy);
            if (hLen > 1e-6) {
                const hx = desVx / hLen;
                const hy = desVy / hLen;
                const along = outVx * hx + outVy * hy;
                const lateral = -outVx * hy + outVy * hx;
                // When already inside the planted body's disc dead-on, peel out
                // along the Context Steering starboard tangent instead of reversing.
                if (along < 0 && Math.abs(lateral) < desc.gaitSpeed * 0.5) {
                    const pLat = -pools.scratchPrefVel[0] * hy + pools.scratchPrefVel[1] * hx;
                    const sideSign = pLat < -1e-6 ? -1 : 1;
                    outVx = (-hy * sideSign) * desc.gaitSpeed;
                    outVy = (hx * sideSign) * desc.gaitSpeed;
                }
            }

            const proposedX = desc.x + outVx * dtSec;
            const proposedY = desc.y + outVy * dtSec;
            pools.scratchSteer.x = proposedX;
            pools.scratchSteer.y = proposedY;
            const kept = this._strideKeptSteer(walker, pools.scratchSteer);
            if (
                !kept
                || Math.hypot(kept.x - walker.x, kept.y - walker.y) <= 0.001
                || !this._isSpritePositionWalkable(walker, kept.x, kept.y)
            ) continue;

            walker.x = kept.x;
            walker.y = kept.y;
            walker._orcaVx = outVx;
            walker._orcaVy = outVy;

            if (Array.isArray(walker.waypoints) && walker.waypoints.length > 1) {
                let targetObstructed = false;
                for (let j = 0; j < neighbors.length; j++) {
                    const body = neighbors[j];
                    const dx = walker.targetX - body.x;
                    const dy = (walker.targetY - body.y) * ORCA_Y_SCALE;
                    if (dx * dx + dy * dy < obstructRadiusSq) {
                        targetObstructed = true;
                        break;
                    }
                }
                if (targetObstructed) {
                    const nextWp = walker.waypoints[1];
                    const crossingMap = walker._crossingTiles?.();
                    let onCrossing = false;
                    if (crossingMap?.size) {
                        const halfW = TILE_WIDTH * 0.5;
                        const halfH = TILE_HEIGHT * 0.5;
                        const wtx = Math.round((walker.targetX / halfW + walker.targetY / halfH) * 0.5);
                        const wty = Math.round((walker.targetY / halfH - walker.targetX / halfW) * 0.5);
                        const crossingInts = this._getCrossingIntSet(crossingMap);
                        onCrossing = Boolean(crossingInts?.has(((wtx + 1024) << 12) | (wty + 1024)));
                    }
                    if (!onCrossing && nextWp && walker._isScreenSegmentWalkable?.(kept.x, kept.y, nextWp.x, nextWp.y)) {
                        walker.waypoints.shift();
                        walker.targetX = nextWp.x;
                        walker.targetY = nextWp.y;
                    }
                }
            }
            steered++;
        }
        return steered;
    }

    // 7.4 — the fan ring's places around an anchor, in visit-slot order: the
    // first villager keeps the anchor, the next ones stand beside it (east and
    // west first, the stable hash picking the side), then in front, behind and
    // on the corners. Whole texels, so a standing body stays on the grid.
    _fanRingPlace(anchor, index, hashKey, scale = 1) {
        if (index <= 0) return { x: Math.round(anchor.x), y: Math.round(anchor.y) };
        const side = this._stableHash(hashKey) % 2 ? 1 : -1;
        const [ux, uy] = FAN_RING_PLACES[(index - 1) % FAN_RING_PLACES.length];
        return {
            x: Math.round(anchor.x + ux * side * PERFORMING_FAN.radiusXPx * scale),
            y: Math.round(anchor.y + uy * PERFORMING_FAN.radiusYPx * scale),
        };
    }

    // The anchor of the fan `occupant` stands in: its recorded anchor while it
    // still stands on that anchor's ring, else its own foot. A body keeps
    // `_fanAnchor` after it walks on, and fanning round a stale anchor aimed
    // a walker's last leg straight across the island (over water and baked
    // fixtures such as the well) to a ring by some old stop.
    _fanAnchorOf(occupant) {
        const anchor = occupant._fanAnchor;
        if (anchor && Math.abs(occupant.x - anchor.x) <= PERFORMING_FAN.radiusXPx * 2 + 1
            && Math.abs(occupant.y - anchor.y) <= PERFORMING_FAN.radiusYPx * 2 + 1) return anchor;
        return occupant;
    }

    // The first walkable ring place around `anchor` for `sprite` whose body
    // box is clear of every other standing body and claimed place; offsets
    // that land inside a building footprint, wall, or water are rejected by
    // `_isSpriteStandable` and fall back to outer clear neighbours before
    // relaxing to `stackClear`.
    _freeFanPlace(sprite, anchor, startIndex, taken, hashKey) {
        const boxClear = (place) => !taken.some(other => other !== sprite
            && Math.abs(other.x - place.x) < PERFORMING_FAN.overlapXPx
            && Math.abs(other.y - place.y) < PERFORMING_FAN.overlapYPx);
        const stackClear = (place) => !taken.some(other => other !== sprite
            && Math.hypot(other.x - place.x, other.y - place.y) < PERFORMING_FAN.stackPx);
        const standable = (place, scale) => this._isSpriteStandable(sprite, place.x, place.y)
            && (scale <= 1 || this._isSpritePositionWalkable(sprite, (anchor.x + place.x) * 0.5, (anchor.y + place.y) * 0.5));
        for (const clear of [boxClear, stackClear]) {
            for (const scale of [1, 2]) {
                for (let index = startIndex; index <= FAN_RING_PLACES.length; index++) {
                    const place = this._fanRingPlace(anchor, index, hashKey, scale);
                    if (clear(place) && standable(place, scale)) return place;
                }
            }
        }
        return null;
    }

    // 7.4 — a walker on its last leg (a visit, or a chat approach) whose stop
    // lands inside a villager already standing there (performing, talking,
    // seated, queued), or on the stop of a walker that lands first, takes the
    // next place on that body's fan ring, so it walks into the fan instead of
    // onto a body.
    _fanArrivals(movingSprites) {
        const standing = this._fanStanding ||= [];
        standing.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite && this._isPlanted(sprite)) standing.push(sprite);
        }
        const arrivals = this._fanArrivalOrder ||= [];
        arrivals.length = 0;
        const stopScratch = this._fanStopScratch ||= { x: 0, y: 0, reach: 0 };
        for (const sprite of movingSprites) {
            if (this._isGateChannelTransit(sprite)) continue;
            // A seat (7.1) or petitioner place (7.2) is an exact point: never re-aimed.
            if (FAN_EXEMPT_ROLES.has(sprite.visitRole)) continue;
            const stop = this._fanStopOf(sprite, stopScratch);
            if (stop.reach <= PERFORMING_FAN.approachPx) {
                sprite._fanReach = stop.reach;
                arrivals.push(sprite);
            }
        }
        if (!arrivals.length) return;
        // The nearer stop lands first and keeps its place.
        arrivals.sort((a, b) => a._fanReach - b._fanReach);
        const landing = this._fanLanding ||= [];
        landing.length = 0;
        for (const sprite of arrivals) {
            const stop = this._fanStopOf(sprite, stopScratch);
            const building = sprite._lastBuildingType;
            const fanned = sprite._fanTarget && sprite._fanTarget.x === stop.x && sprite._fanTarget.y === stop.y;
            if (fanned || !(stop.reach > PERFORMING_FAN.minApproachPx)) {
                landing.push({ x: stop.x, y: stop.y, building });
                continue;
            }
            const occupant = standing.find(other => other !== sprite
                && Math.abs(other.x - stop.x) < PERFORMING_FAN.overlapXPx
                && Math.abs(other.y - stop.y) < PERFORMING_FAN.overlapYPx)
                || landing.find(other => Math.abs(other.x - stop.x) < PERFORMING_FAN.overlapXPx
                    && Math.abs(other.y - stop.y) < PERFORMING_FAN.overlapYPx);
            // A stop on a fixture or failing continuous clearance fans onto a clear neighbour.
            if (!occupant && this._isSpriteStandable(sprite, stop.x, stop.y)) {
                landing.push({ x: stop.x, y: stop.y, building });
                continue;
            }
            const anchor = occupant ? this._fanAnchorOf(occupant) : { x: stop.x, y: stop.y };
            const place = this._freeFanPlace(sprite, anchor, 1, [...standing, ...landing], `${building}|${anchor.x | 0},${anchor.y | 0}`);
            if (!place) {
                landing.push({ x: stop.x, y: stop.y, building });
                continue;
            }
            const last = sprite.waypoints?.length ? sprite.waypoints.length - 1 : -1;
            if (last >= 0) sprite.waypoints[last] = { ...sprite.waypoints[last], x: place.x, y: place.y };
            if (last <= 0) {
                sprite.targetX = place.x;
                sprite.targetY = place.y;
            }
            sprite._fanTarget = place;
            sprite._fanAnchor = { x: anchor.x, y: anchor.y };
            landing.push({ x: place.x, y: place.y, building });
            this._localAvoidanceMetrics.fannedArrivals = (this._localAvoidanceMetrics.fannedArrivals || 0) + 1;
        }
    }

    // Where a walker will stop (its route's last point) and how far it still
    // walks to get there. Past PERFORMING_FAN.approachPx the walk is not summed
    // further: `reach` then only says "farther than that", and x/y are unset.
    _fanStopOf(sprite, out = (this._fanStopScratch ||= { x: 0, y: 0, reach: 0 })) {
        const tx = Number(sprite.targetX);
        const ty = Number(sprite.targetY);
        let reach = Math.hypot(tx - sprite.x, ty - sprite.y);
        const route = sprite.waypoints;
        if (!(route?.length > 1)) {
            out.x = tx;
            out.y = ty;
            out.reach = reach;
            return out;
        }
        for (let index = 1; index < route.length; index++) {
            if (reach > PERFORMING_FAN.approachPx) {
                out.x = NaN;
                out.y = NaN;
                out.reach = reach;
                return out;
            }
            reach += Math.hypot(route[index].x - route[index - 1].x, route[index].y - route[index - 1].y);
        }
        const final = route[route.length - 1];
        out.x = Number(final.x);
        out.y = Number(final.y);
        out.reach = reach;
        return out;
    }

    _forEachNearbySpritePair(sprites, cellSize, visitor) {
        const size = Math.max(1, Number(cellSize) || PAIR_BUCKET_DEFAULT_PX);
        const buckets = this._pairBuckets;
        const columns = this._pairColumnPool;
        const pool = this._pairBucketPool;
        const ids = this._pairIds;
        const identityRanks = this._pairIdentityRanks;
        const duplicatePairs = this._pairDuplicatePairs;
        buckets.clear();
        ids.clear();
        identityRanks.clear();
        duplicatePairs.clear();
        for (let index = 0; index < columns.length; index++) columns[index].clear();
        for (let index = 0; index < pool.length; index++) pool[index].sprites.length = 0;
        let columnCount = 0;
        let bucketCount = 0;
        for (let index = 0; index < sprites.length; index++) {
            const sprite = sprites[index];
            if (!sprite) continue;
            const repeated = ids.has(sprite);
            ids.set(sprite, this._spriteStableId(sprite, index));
            if (repeated) continue;
            const cellX = Math.floor(sprite.x / size);
            const cellY = Math.floor(sprite.y / size);
            let column = buckets.get(cellX);
            if (!column) {
                column = columns[columnCount] || (columns[columnCount] = new Map());
                columnCount++;
                buckets.set(cellX, column);
            }
            let bucket = column.get(cellY);
            if (!bucket) {
                bucket = pool[bucketCount] || (pool[bucketCount] = { cellX: 0, cellY: 0, rank: 0, sprites: [] });
                bucket.cellX = cellX;
                bucket.cellY = cellY;
                bucket.rank = bucketCount++;
                column.set(cellY, bucket);
            }
            bucket.sprites.push(sprite);
        }
        let duplicateIdentities = false;
        for (let index = 0; index < bucketCount; index++) {
            const entries = pool[index].sprites;
            for (let entry = 0; entry < entries.length; entry++) {
                const sprite = entries[entry];
                const id = ids.get(sprite);
                let rank = identityRanks.get(id);
                if (rank === undefined) {
                    rank = identityRanks.size;
                    identityRanks.set(id, rank);
                } else {
                    duplicateIdentities = true;
                }
                ids.set(sprite, rank);
            }
        }

        // Earlier insertion ranks already visited the reverse neighborhood.
        // Keep the old ox/oy and sprite order: separation steering is ordered.
        for (let index = 0; index < bucketCount; index++) {
            const bucket = pool[index];
            for (let ox = -1; ox <= 1; ox++) {
                if (!Number.isFinite(bucket.cellX) && ox !== -1) continue;
                const column = buckets.get(bucket.cellX + ox);
                if (!column) continue;
                for (let oy = -1; oy <= 1; oy++) {
                    if (!Number.isFinite(bucket.cellY) && oy !== -1) continue;
                    const other = column.get(bucket.cellY + oy);
                    if (!other || other.rank < bucket.rank) continue;
                    for (let ai = 0; ai < bucket.sprites.length; ai++) {
                        const a = bucket.sprites[ai];
                        const idA = ids.get(a);
                        const start = other === bucket ? ai + 1 : 0;
                        for (let bi = start; bi < other.sprites.length; bi++) {
                            const b = other.sprites[bi];
                            const idB = ids.get(b);
                            if (a === b || idA === idB) continue;
                            // Normal rosters have one sprite per identity. If an
                            // identity repeats, retain the old first-pair rule.
                            if (duplicateIdentities) {
                                const pair = Math.min(idA, idB) * identityRanks.size + Math.max(idA, idB);
                                if (duplicatePairs.has(pair)) continue;
                                duplicatePairs.set(pair, true);
                            }
                            if (visitor(a, b) === false) return false;
                        }
                    }
                }
            }
        }
        return true;
    }

    _spriteStableId(sprite, fallbackIndex = 0) {
        return String(
            sprite?.agent?.id ||
            sprite?.id ||
            `${Math.round(Number(sprite?.x) || 0)}:${Math.round(Number(sprite?.y) || 0)}:${fallbackIndex}`
        );
    }

    _stableHash(value) {
        const text = String(value || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    _emptyCrowdStats() {
        return {
            agentCount: 0,
            visibleAgents: 0,
            movingAgents: 0,
            clusterCellSize: CROWD_CLUSTER_TILE_SIZE,
            minClusterSize: 3,
            denseClusterCount: 0,
            maxClusterSize: 0,
            congestedAgents: 0,
            clusters: [],
        };
    }

    _sampleBehaviorTelemetry(now) {
        const telemetry = this.behaviorTelemetry;
        if (!telemetry?.beginSample(now, this.visitTileAllocator?.metrics)) return;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || this._isGateTransit(sprite, 'departure') || sprite.isArrivalPending?.()) continue;
            const behavior = sprite.behavior;
            // Residence begins at an observed arrival, not when a route is
            // assigned. Walkers and scenic/rest/queue stops remain outside the
            // nine buildings; this is not the semantic work/light population.
            const arrived = !sprite.moving && behavior?.visitStartedAt != null;
            const destination = arrived ? behavior.building : null;
            telemetry.observeAgent(
                sprite.agent?.id,
                destination,
                destination,
                Boolean(sprite.moving),
                sprite._thoughtFiltered === true, // filtered by the thought budget
                sprite.bubbleSlot ?? null,
                Number(sprite.bubbleLateral) || 0,
            );
        }
        telemetry.endSample();
    }

    _summarizeCrowdClusters() {
        const entries = [];
        let visibleAgents = 0;
        let movingAgents = 0;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || this._isGateTransit(sprite, 'departure') || sprite.isArrivalPending?.()) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            if (!tile || !Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) continue;
            visibleAgents++;
            if (sprite.moving) movingAgents++;
            entries.push({
                agentId: sprite.agent?.id ?? null,
                tileX: tile.tileX,
                tileY: tile.tileY,
                moving: !!sprite.moving,
                status: sprite.agent?.status || 'unknown',
                provider: sprite.agent?.provider || 'unknown',
                teamName: sprite.agent?.teamName || null,
            });
        }

        // W7.11 — the director's work cohorts fold into the same clusters:
        // one aura and one tab per working building.
        const summary = summarizeCrowdClusterEntries(entries, {
            cellSize: CROWD_CLUSTER_TILE_SIZE,
            topLimit: CROWD_CLUSTER_TOP_LIMIT,
            includeDominantProvider: true,
            includeStatusCounts: true,
            cohorts: this.villageDirector?.getSnapshot?.()?.workCohorts || null,
        });

        return {
            agentCount: this.agentSprites.size,
            visibleAgents,
            movingAgents,
            clusterCellSize: CROWD_CLUSTER_TILE_SIZE,
            minClusterSize: summary.minClusterSize,
            denseClusterCount: summary.clusters.length,
            maxClusterSize: summary.maxClusterSize,
            congestedAgents: summary.congestedAgents,
            clusters: summary.clusters,
        };
    }

    _resolveStationaryOverlaps() {
        const now = Date.now();
        const candidates = Array.from(this.agentSprites.values()).filter((sprite) => (
            sprite &&
            !sprite.moving &&
            !sprite.chatting &&
            !sprite.chatPartner &&
            !sprite.selected &&
            !this._isGateTransit(sprite, 'departure') &&
            !sprite.isArrivalPending?.() &&
            !FAN_EXEMPT_ROLES.has(sprite.visitRole) &&
            this._canStationaryRetarget(sprite, now)
        ));
        this.behaviorMetrics.stationaryOverlapChecks++;
        const threshold = this.agentSprites.size >= 50 ? 26 : 24;
        const maxRetargets = this.agentSprites.size >= 50 ? 5 : 2;
        let retargets = 0;
        this._forEachNearbySpritePair(candidates, threshold + 8, (a, b) => {
            if (retargets >= maxRetargets) return false;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.hypot(dx, dy);
            // 7.4 — an exact stack (dist 0) is an overlap too; the stable
            // hash settles which of the two moves when neither rerouted last.
            if (dist >= threshold) return true;
            const aSnap = a.getBehaviorDebugSnapshot?.();
            const bSnap = b.getBehaviorDebugSnapshot?.();
            const sameBuilding = aSnap?.building && aSnap.building === bSnap?.building;
            if (!sameBuilding && dist > 14) return true;
            const aRerouted = aSnap?.behavior?.lastRerouteAt || 0;
            const bRerouted = bSnap?.behavior?.lastRerouteAt || 0;
            const loser = aRerouted === bRerouted
                ? (this._stableHash(`${this._spriteStableId(a)}|${this._spriteStableId(b)}`) % 2 ? a : b)
                : aRerouted < bRerouted ? a : b;
            if (loser.retargetVisit?.()) {
                retargets++;
                this.behaviorMetrics.stationaryRetargets++;
            }
            return retargets < maxRetargets;
        });
    }

    // 7.4 — a body on its feet at one point: standing, or a walker that has
    // not stepped (a start beat, a pivot, giving way) or stopped to look at a
    // landmark.
    _isPlanted(sprite) {
        return !sprite.moving || !Number.isFinite(sprite._stepStartX) || sprite._stopLookActiveMs > 0;
    }

    _canStationaryRetarget(sprite, now = Date.now()) {
        const snap = sprite.getBehaviorDebugSnapshot?.();
        const state = snap?.behaviorState;
        if (['performing', 'cooldown', 'chatting', 'chat-approach', 'blocked'].includes(state)) return false;
        if (String(snap?.building || '').startsWith('ambient:') && state === 'lingering') return false;
        const arrivedAt = Number(snap?.behavior?.arrivedAt || 0);
        if (arrivedAt && now - arrivedAt < 2500) return false;
        return true;
    }

    _pruneCrowdBumpCooldowns(now = performance.now()) {
        for (const [key, expiresAt] of this._crowdBumpCooldowns) {
            if (expiresAt <= now) this._crowdBumpCooldowns.delete(key);
        }
        while (this._crowdBumpCooldowns.size > CROWD_BUMP_COOLDOWN_LIMIT) {
            this._crowdBumpCooldowns.delete(this._crowdBumpCooldowns.keys().next().value);
        }
    }

    _emitCrowdBumpFeedback(a, b, overlap = 0) {
        const now = performance.now();
        // FP-8 — the sorted pair key without an array, a sort and a join
        // (the default sort's code-unit order is `<` on the two strings).
        const idA = String(a.agent?.id || a.x);
        const idB = String(b.agent?.id || b.x);
        const key = idA <= idB ? `${idA}|${idB}` : `${idB}|${idA}`;
        if ((this._crowdBumpCooldowns.get(key) || 0) > now) return;
        while (this._crowdBumpCooldowns.size >= CROWD_BUMP_COOLDOWN_LIMIT) {
            this._crowdBumpCooldowns.delete(this._crowdBumpCooldowns.keys().next().value);
        }
        this._crowdBumpCooldowns.set(key, now + 650);
        a.bumpFlash = Math.max(a.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        b.bumpFlash = Math.max(b.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        if (this.motionScale > 0) {
            // 0.6 — the bump sorts with the nearer of the two bodies.
            this.particleSystem.spawn('crowdBump', (a.x + b.x) / 2, (a.y + b.y) / 2 + 6, 2, {
                sortY: Math.max(a._depthSortY ?? a.y, b._depthSortY ?? b.y),
            });
        }
    }

    _updateAmbientEffects(dt = 16) {
        if (!this.motionScale || this.ambientEmitters.length === 0) return;

        const maxParticles = this.particleSystem.maxParticles || 240;
        const activeParticles = this.particleSystem.particles.length || 0;
        if (activeParticles > maxParticles - 40) return;

        const particleBudget = Math.max(0.22, 1 - activeParticles / maxParticles);
        let spawned = 0;
        for (const emitter of this.ambientEmitters) {
            if (spawned >= 1) break;
            const localBudget = this._ambientEmitterBudget(emitter);
            const frameScale = Math.max(0, Math.min(3, dt / 16));
            const chance = 1 - Math.pow(1 - Math.max(0, Math.min(1, emitter.chance * particleBudget * localBudget)), frameScale);
            if (Math.random() < chance) {
                // 0.6 — the mote rises 18 px over its emitter's ground point.
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y - 18, 1, { sortY: emitter.y });
                spawned++;
            }
        }
    }

    // 6.7 — chimney smoke rides its own interval (not the one-ambient-spawn
    // cap above): gated by working presence (V8 isWorkingVisitor, via
    // BuildingSprite.getWorkingPresence), wind-leaned, flattened by rain.
    _updateChimneySmoke() {
        if (!this.motionScale || !this.chimneySmoke) return;
        this.chimneySmoke.update({
            now: this.motionTimeMs,
            timeMs: this.motionTimeMs,
            buildings: this.world?.buildings,
            assets: this.assets,
            presence: this.buildingRenderer?.getWorkingPresence?.() || null,
            particleSystem: this.particleSystem,
            atmosphere: this._lastAtmosphere,
            heatFor: type => (type === 'forge' ? this.buildingRenderer?._forgeGlowIntensity?.() ?? 0 : 0),
            sortYFor: (building, localY, localX) => this.buildingRenderer?.particleSortY?.(building, localY, localX) ?? null,
        });
    }

    // Reduced motion: the chimneys that would be smoking show a static wisp.
    // `lightGrade` is passed only for the ungraded resident overlay.
    _drawChimneySmokeStatic(ctx, lightGrade = null) {
        if (this.motionScale > 0 || !this.chimneySmoke) return;
        this.chimneySmoke.drawStatic(ctx, {
            buildings: this.world?.buildings,
            assets: this.assets,
            presence: this.buildingRenderer?.getWorkingPresence?.() || null,
            atmosphere: this._lastAtmosphere,
            lightGrade,
            weather: this._lastAtmosphere?.weather || null,
        });
    }

    // Weather→agent response: while rain or storm is active, tiny splash
    // particles pop at agent feet. Atmospheric only — accumulator-rate spawns
    // capped per frame, skipped when the shared particle pool is near its
    // budget, and switched off entirely under reduced motion (motionScale 0).
    _updateRainSplashes(dt = 16) {
        if (!this.motionScale || this.agentSprites.size === 0) {
            this._rainSplashAccumulator = 0;
            return;
        }
        const weather = this._lastAtmosphere?.weather || null;
        const raining = weather && (weather.type === 'rain' || weather.type === 'storm');
        if (!raining) {
            this._rainSplashAccumulator = 0;
            return;
        }

        const maxParticles = this.particleSystem.maxParticles || 240;
        if ((this.particleSystem.particles.length || 0) > maxParticles - 60) return;

        const intensity = Math.max(0, Math.min(1, Number(weather.intensity) || 0));
        const stormBoost = weather.type === 'storm' ? 1.5 : 1;
        const agentWeight = Math.min(this.agentSprites.size, 16);
        const splashesPerSecond = (0.4 + intensity * 0.8) * stormBoost * agentWeight * this.motionScale;
        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        this._rainSplashAccumulator += splashesPerSecond * (frameDt / 1000);

        const spawns = Math.min(3, Math.floor(this._rainSplashAccumulator));
        if (spawns <= 0) return;
        this._rainSplashAccumulator -= spawns;

        const sprites = Array.from(this.agentSprites.values());
        for (let i = 0; i < spawns; i++) {
            const sprite = sprites[Math.floor(Math.random() * sprites.length)];
            if (!sprite || sprite.isArrivalPending?.()) continue;
            // Feet sit ~7px below the sprite anchor (matches footstep dust).
            this.particleSystem.spawn('rainSplash', sprite.x, sprite.y + 7, 1, {
                spread: 5,
                sortY: sprite._depthSortY ?? sprite.y,
            });
        }
    }

    _ambientEmitterBudget(emitter) {
        const nearHarbor = emitter.tileX >= 30 && emitter.tileY >= 15 && emitter.tileY <= 25;
        const nearCommand = emitter.tileX >= 16 && emitter.tileX <= 24 && emitter.tileY >= 16 && emitter.tileY <= 23;
        if (nearCommand) return 0.9;
        if (nearHarbor) return 0.45;
        return 0.65;
    }

    _render(dt = 16, allowTerrainArtifactWait = false) {
        // #2 — reset the mark governor once per frame before any draw pass runs.
        // Region size scales with zoom so a "screen region" stays roughly fixed
        // in screen pixels regardless of the integer zoom level.
        this.markGovernor.beginFrame({
            regionSize: 200 / (this.camera?.zoom || 1),
            motionScale: this.motionScale,
        });
        this._syncSemanticSummary();
        const buildings = this.buildingRenderer;
        const glassCut = buildings?.getApertureModel?.();
        if (postcardFrame() && glassCut?.source === 'glass') {
            buildings._apertureModel = null;
            try { return renderWorldFrame(this, dt, allowTerrainArtifactWait); }
            finally { buildings._apertureModel = glassCut; }
        }
        return renderWorldFrame(this, dt, allowTerrainArtifactWait);
    }

    _syncSemanticSummary() {
        const el = document.getElementById('worldSemanticSummary');
        if (!el) return;
        const agents = Array.from(this.agentSprites.values()).map(sprite => sprite.agent).filter(Boolean);
        const counts = bucketCounts(agents);
        const selected = this.selectedAgent?.name ? ` Selected ${this.selectedAgent.name}.` : '';
        const text = `Village: ${agents.length} agents. ${counts.needsYou} need you, ${counts.errors} errored, ${counts.quota} quota-limited, ${counts.watchlist} waiting, ${counts.working} working.${selected}`;
        if (text !== this._semanticSummaryText) { this._semanticSummaryText = text; el.textContent = text; }
    }

    _reconcileHarborWhileWorldStopped(now = Date.now()) {
        if (this._disposed || !this.harborTraffic) return false;
        if (this.frameId != null) return false;
        if (typeof document !== 'undefined' && document.hidden) return false;
        const agents = Array.from(this.world?.agents?.values?.() || []);
        this.harborTraffic.reconcile(agents, now);
        this._harborFailedPushState = this.harborTraffic.getFailedPushState?.(now) || null;
        const repos = this.harborTraffic.getPendingRepoSummaries?.() ?? [];
        const signature = this._harborPendingReposSignature(repos);
        if (signature === this._harborPendingSignature) return true;
        this._harborPendingSignature = signature;
        eventBus.emit('harbor:updated', repos);
        return true;
    }

    _harborPendingReposSignature(repos = []) {
        if (!Array.isArray(repos) || repos.length === 0) return '';
        return repos
            .map(repo => [
                repo.project || repo.projectPath || repo.path || repo.name || '',
                repo.branch || '',
                repo.pendingCommits ?? repo.count ?? repo.pending ?? '',
                repo.failedPushes ?? '',
                Math.floor((Number(repo.latestEventTime) || 0) / 1000),
                Math.floor((Number(repo.oldestCommitTime) || 0) / 60_000),
                repo.profile?.accent || '',
            ].join(':'))
            .sort()
            .join('|');
    }

    _drawFamiliarMotesForFamilies(ctx, _sortedSprites, atmosphere = null) {
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return;
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            drawFamiliarMotes(ctx, {
                parentSprite,
                childSprites,
                childAgents: departedChildren,
                zoom: this.camera?.zoom || 1,
                now,
                motionScale: this.motionScale,
                lighting: atmosphere?.lighting,
            });
        }
    }

    _enumerateFamiliarMoteDrawables(atmosphere = null) {
        const drawables = this._familiarMoteDrawables;
        drawables.length = 0;
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return drawables;
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            if (!childSprites.length && !departedChildren.length) continue;
            drawables.push({
                kind: 'familiar-motes',
                sortY: parentSprite.y - 50,
                draw: (ctx, zoom) => drawFamiliarMotes(ctx, {
                    parentSprite,
                    childSprites,
                    childAgents: departedChildren,
                    zoom,
                    now,
                    motionScale: this.motionScale,
                    lighting: atmosphere?.lighting,
                }),
            });
        }
        return drawables;
    }

    // Returns `{ body, annotation }`. Annotation LOD (labels, bubbles, name
    // tags) follows scene pressure as a whole-village policy so viewport
    // culling cannot visibly change label style while the camera pans.
    // Body LOD (the 28px compact silhouette in AgentSprite) is gated on the
    // population/viewport thresholds only: pressure is fed by crowd-cell
    // congestion that steps every time a walker crosses a cell boundary, and
    // letting it drive body size made whole villages flicker to mini size.
    _agentRenderMode(viewport = this._screenViewport(), _visibleSprites = this._snapshotSortedSprites()) {
        // Pressure does not depend on painter order, so the reusable unsorted
        // snapshot preserves the previous semantics without a full sort.
        const sprites = this._snapshotAllSprites();
        const count = sprites.length;
        const zoom = this.camera?.zoom || 1;
        let projectedArea = 0;
        for (const sprite of _visibleSprites) {
            const point = this.camera.worldToScreen(sprite.x, sprite.y);
            if (point.x < -60 * zoom || point.x > viewport.width + 60 * zoom
                || point.y < 0 || point.y > viewport.height + 100 * zoom) continue;
            projectedArea += AGENT_BODY_AREA_W * AGENT_BODY_AREA_H * zoom * zoom;
        }
        const overlayArea = Math.max(count * (zoom >= 3 ? 3900 : 2100), projectedArea);
        const collisions = Number(this._crowdStats?.congestedAgents) || 0;
        const pressure = Math.max(
            calculateScenePressure({ sprites, viewport, zoom, overlayArea, collisions }),
            collisions >= 5 && collisions > count / 2 ? 0.5 : 0,
        );
        const pressureMode = annotationModeForPressure(pressure, this._annotationMode || 'full');
        this._annotationMode = pressureMode;
        const body = agentBodyRenderMode(count, viewport, zoom);
        const annotation = body === 'minimal' || pressureMode === 'minimal'
            ? 'minimal'
            : body === 'compact' || pressureMode === 'compact'
                ? 'compact'
                : 'full';
        return { body, annotation };
    }

    _createRectGrid(cellSize = AGENT_OVERLAY_GRID_CELL) {
        return {
            cellSize,
            generation: 0,
            buckets: new Map(),
            touchedBuckets: [],
            seen: new Set(),
        };
    }

    _beginRectGridFrame(grid) {
        for (const bucket of grid.touchedBuckets) bucket.items.length = 0;
        grid.touchedBuckets.length = 0;
        grid.seen.clear();
        grid.generation++;
        if (grid.generation < 1000000000) return;
        grid.generation = 1;
        grid.buckets.clear();
    }

    _insertRectGridItem(grid, rect, item = rect) {
        if (!grid || !rect) return;
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const key = (x + 32768) * 65536 + y + 32768;
                let bucket = grid.buckets.get(key);
                if (!bucket) {
                    bucket = { generation: grid.generation, items: [] };
                    grid.buckets.set(key, bucket);
                } else if (bucket.generation !== grid.generation) {
                    bucket.generation = grid.generation;
                    bucket.items.length = 0;
                }
                if (bucket.items.length === 0) grid.touchedBuckets.push(bucket);
                bucket.items.push(item);
            }
        }
    }

    _rectGridHasOverlap(grid, rect) {
        if (!grid || !rect) return false;
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (this._rectsOverlap(rect, item.rect || item)) return true;
                }
            }
        }
        return false;
    }

    _rectListHasOverlap(items, rect) {
        for (const item of items) {
            if (this._rectsOverlap(rect, item.rect || item)) return true;
        }
        return false;
    }

    _firstRectGridOverlap(grid, rect) {
        if (!grid || !rect) return null;
        const seen = grid.seen;
        seen.clear();
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        let first = null;
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    if (!this._rectsOverlap(rect, item.rect || item)) continue;
                    if (!first || item.order < first.order) first = item;
                }
            }
        }
        return first;
    }

    // W5-C — lazy-initialized shared 96 px OverlayOccupancyGrid & reusable
    // ThoughtColumn candidate pool (zero per-frame allocations).
    _ensureOverlayAuctionPools() {
        if (!this._overlayOccupancyGrid) {
            this._overlayOccupancyGrid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
        }
        if (!this._attentionOccupancyGrid) {
            this._attentionOccupancyGrid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
        }
        if (!this._thoughtCandidatePool) {
            this._thoughtCandidatePool = createThoughtCandidatePool(LABEL_MAX_SPEAKERS);
        }
        if (!this._labelAuctionStats) {
            this._labelAuctionStats = {
                frames: 0,
                plaques: 0,
                attention: 0,
                speakers: 0,
                placed: 0,
                filtered: 0,
                iterations: 0,
                totalPlaced: 0,
                totalFiltered: 0,
            };
        }
        if (!this._labelAuctionOptions) {
            this._labelAuctionOptions = {
                pad: 2,
                viewport: null,
                reservedRects: null,
                reserveInGrid: true,
                outRects: this._thoughtCandidatePool.rects,
                outStats: this._thoughtCandidatePool.stats,
            };
        }
        return {
            grid: this._overlayOccupancyGrid,
            attentionGrid: this._attentionOccupancyGrid,
            pool: this._thoughtCandidatePool,
            stats: this._labelAuctionStats,
            auctionOptions: this._labelAuctionOptions,
        };
    }

    getLabelAuctionDiagnostics() {
        const stats = this._labelAuctionStats;
        return stats
            ? { ...stats, gridCellSize: this._overlayOccupancyGrid?.cellSize ?? OVERLAY_GRID_CELL }
            : {
                frames: 0,
                plaques: 0,
                attention: 0,
                speakers: 0,
                placed: 0,
                filtered: 0,
                iterations: 0,
                totalPlaced: 0,
                totalFiltered: 0,
                gridCellSize: OVERLAY_GRID_CELL,
            };
    }

    _reconcileChronicleBanners(now = Date.now()) {
        const list = this.chronicleMonuments?._activeBanners;
        if (!Array.isArray(list)) return null;
        const deferred = this._deferredChronicleBanners || (this._deferredChronicleBanners = []);
        const maxSimultaneous = 2;
        const seenText = new Set();
        let write = 0;
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (!b || Number(b.expiresAt || 0) <= now) continue;
            const key = b.text || `${b.tier || ''}:${b.project || ''}`;
            if (seenText.has(key)) continue;
            seenText.add(key);
            if (write < maxSimultaneous) {
                list[write++] = b;
            } else if (deferred.length < 12) {
                deferred.push(b);
            }
        }
        list.length = write;
        while (list.length < maxSimultaneous && deferred.length > 0) {
            const next = deferred.shift();
            if (!next) continue;
            const key = next.text || `${next.tier || ''}:${next.project || ''}`;
            if (seenText.has(key)) continue;
            seenText.add(key);
            const dur = Math.max(2000, (Number(next.expiresAt || 0) - Number(next.startedAt || 0)) || 6000);
            next.startedAt = now;
            next.expiresAt = now + dur;
            list.push(next);
        }
        return list;
    }

    _reserveRectClampedInGrid(grid, rect, layer, tag, minX, minY, maxX, maxY) {
        if (!grid || !rect) return false;
        const rawL = rect.left !== undefined ? rect.left : rect.x;
        const rawT = rect.top !== undefined ? rect.top : rect.y;
        const rawR = rect.right !== undefined ? rect.right : (rawL + rect.w);
        const rawB = rect.bottom !== undefined ? rect.bottom : (rawT + rect.h);
        if (!Number.isFinite(rawL) || !Number.isFinite(rawT) || !Number.isFinite(rawR) || !Number.isFinite(rawB)) {
            return false;
        }
        const l = rawL < minX ? minX : rawL;
        const t = rawT < minY ? minY : rawT;
        const r = rawR > maxX ? maxX : rawR;
        const b = rawB > maxY ? maxY : rawB;
        if (r <= l || b <= t) return false;
        grid.reserve(l, t, r, b, layer, tag);
        return true;
    }

    _assignAgentOverlaySlots(sprites, zoom = this.camera?.zoom || 1, { agentRenderMode = 'full' } = {}) {
        const occ = this._ensureOverlayAuctionPools();
        const sharedGrid = occ.grid;
        const attentionGrid = occ.attentionGrid;
        sharedGrid.beginFrame();
        attentionGrid.beginFrame();

        const nameGrid = this._overlayNameGrid;
        const bubbleGrid = this._overlayBubbleGrid;
        const nameRects = this._overlayNameRects;
        const reservedRects = this._overlayReservedRects;
        nameRects.length = 0;
        reservedRects.length = 0;
        // Action labels retain a cap because they are secondary detail.
        const actionLabelCap = agentRenderMode === 'minimal'
            ? 3
            : agentRenderMode === 'compact'
                ? 4
                : Infinity;
        let actionLabels = 0;
        // Cull before priority sorting or allocating any label geometry. The
        // input is normally already the visible painter snapshot, but keeping
        // this guard here makes the layout contract safe for other callers.
        const viewport = this._screenViewport();
        const prioritized = this._overlayPrioritizedSprites;
        prioritized.length = 0;
        for (const sprite of sprites || []) {
            if (sprite.agent && this._agentVisibleOnScreen(sprite, viewport)) prioritized.push(sprite);
        }
        const now = performance.now();
        for (const sprite of prioritized) this._noteLabelToolChange(sprite, now);
        prioritized.sort((a, b) => this._agentLabelPriority(b, now) - this._agentLabelPriority(a, now));
        // A direct scan is faster for small visible sets. Above that, the grid
        // bounds each query to spatial neighbours instead of the full crowd.
        const useSpatialGrid = prioritized.length > 32;
        this._beginRectGridFrame(nameGrid);
        this._beginRectGridFrame(bubbleGrid);
        let attentionTag = 0;
        const reserve = (rect) => {
            if (useSpatialGrid) {
                this._insertRectGridItem(nameGrid, rect);
                this._insertRectGridItem(bubbleGrid, rect);
            } else {
                nameRects.push(rect);
                reservedRects.push(rect);
            }
            if (rect && rect.w > 0 && rect.h > 0) {
                sharedGrid.reserve(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, OVERLAY_LAYER_ATTENTION, attentionTag++);
            }
        };
        const collides = rect => (useSpatialGrid
            ? this._rectGridHasOverlap(nameGrid, rect)
            : this._rectListHasOverlap(nameRects, rect))
            || (rect && sharedGrid.overlapsMaxLayer(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, OVERLAY_LAYER_PLAQUE, 0));

        // Layer 1 (OVERLAY_LAYER_PLAQUE): reserve visible painted building plaques
        // in both the screen-space attention grid and the shared world-space overlay grid.
        const plaqueAvoid = this._plaqueAvoidScreenRects || (this._plaqueAvoidScreenRects = []);
        plaqueAvoid.length = 0;
        let plaqueCount = 0;
        if (this.buildingRenderer?.plaqueWorldRects?.length) {
            const hasProj = typeof this.camera?.worldToScreen === 'function';
            for (let i = 0; i < this.buildingRenderer.plaqueWorldRects.length; i++) {
                const worldRect = this.buildingRenderer.plaqueWorldRects[i];
                if (!worldRect) continue;
                sharedGrid.reserve(
                    worldRect.left,
                    worldRect.top,
                    worldRect.right,
                    worldRect.bottom,
                    OVERLAY_LAYER_PLAQUE,
                    plaqueCount,
                );
                if (hasProj) {
                    const topLeft = this.camera.worldToScreen(worldRect.left, worldRect.top);
                    const bottomRight = this.camera.worldToScreen(worldRect.right, worldRect.bottom);
                    const screenPlaque = {
                        left: topLeft.x,
                        top: topLeft.y,
                        right: bottomRight.x,
                        bottom: bottomRight.y,
                    };
                    plaqueAvoid.push(screenPlaque);
                    attentionGrid.reserve(
                        screenPlaque.left,
                        screenPlaque.top,
                        screenPlaque.right,
                        screenPlaque.bottom,
                        OVERLAY_LAYER_PLAQUE,
                        plaqueCount,
                    );
                }
                plaqueCount++;
            }
        }
        occ.stats.plaques = plaqueCount;

        // Layer 2 (OVERLAY_LAYER_ATTENTION): attention plates laid out first from
        // live status against the shared occupancy grid; every other label yields to them.
        const readMode = this.getReadMode();
        const effectiveTheatre = Boolean(this.theatreMode && !readMode);
        const lens = this.inspectionGlass?.getCenter();
        this._attentionLayout = layoutAttentionPlates(this.overlayCtx, {
            // Every agent, not the visible snapshot: off-view action-needed
            // agents get an edge plate instead of vanishing (T1 truth).
            sprites: this.agentSprites.values(),
            camera: this.camera,
            viewport,
            // V8 — chrome over the world (the World dock) is occluded screen.
            reserved: getReservedRects(),
            avoid: plaqueAvoid,
            occupancyGrid: attentionGrid,
            state: this._attentionState || (this._attentionState = {}),
            dwellNow: now,
            hoveredAgentId: this._hoveredAgentSprite?.agent.id,
            hoveredAttentionKey: this._hoverPoint ? attentionKeyAt(this._attentionLayout, this._hoverPoint.x, this._hoverPoint.y) : null,
            selectedAgentId: this.selectedAgent?.id,
            attentionHold: Boolean(this.cameraDirector?.attentionFrame?.hold && !this.cameraDirector.attentionFrame.hold.done),
            readMode,
            theatreMode: effectiveTheatre,
            glassScreen: lens ? { cx: lens.x, cy: lens.y } : null,
            // Ages default to the shared 1 Hz tick (`elapsedTickNow`), so a
            // plate and the card beside it always print the same second.
        });
        const attentionWorldRects = this._attentionWorldRects;
        attentionWorldRects.length = 0;
        for (const rect of attentionScreenRects(this._attentionLayout)) {
            const worldRect = this._screenRectToWorld(rect);
            if (!worldRect) continue;
            attentionWorldRects.push(worldRect);
            reserve(worldRect);
            this.markGovernor.reserve(worldRect, 'primary', 'attention');
        }
        occ.stats.attention = attentionWorldRects.length;
        // S4/S5 — building ledgers and assay furniture give way to T1.
        if (this.buildingRenderer) this.buildingRenderer.attentionWorldRects = attentionWorldRects;

        // Deduplicate & cap active Harbor/Chronicle milestone banners (e.g.
        // Maiden Voyage) at 2 simultaneous so multi-repo bursts never stack 4-6
        // deep over the harbor or world labels, and reserve visible banner rects
        // in the shared world occupancy grid so thoughts never draw over them.
        const activeBanners = this._reconcileChronicleBanners(Date.now());
        if (activeBanners?.length && typeof this.camera?.worldToScreen === 'function' && viewport?.width > 0) {
            const bannerNow = Date.now();
            const edgeMargin = 8;
            const bgH = 18;
            for (let i = 0; i < activeBanners.length; i++) {
                const banner = activeBanners[i];
                if (!banner || Number(banner.expiresAt || 0) <= bannerNow) continue;
                const pos = tileToWorld(banner.tileX, banner.tileY);
                const anchor = this.camera.worldToScreen(pos.x, pos.y);
                const tier = banner.tier || 'maiden';
                const lift = tier === 'flagship' ? -84 : tier === 'ribbon' ? -56 : -48;
                const bgW = String(banner.text || '').length * 8 + 16;
                const maxLeft = Math.max(edgeMargin, viewport.width - edgeMargin - bgW);
                const maxTop = Math.max(edgeMargin, viewport.height - edgeMargin - bgH);
                const left = Math.max(edgeMargin, Math.min(maxLeft, Math.round(anchor.x - bgW / 2)));
                const top = Math.max(edgeMargin, Math.min(maxTop, Math.round(anchor.y + lift - bgH)));
                const worldRect = this._screenRectToWorld({ left, top, right: left + bgW, bottom: top + bgH });
                if (worldRect && worldRect.w > 0 && worldRect.h > 0) {
                    sharedGrid.reserve(worldRect.x, worldRect.y, worldRect.x + worldRect.w, worldRect.y + worldRect.h, OVERLAY_LAYER_ATTENTION, attentionTag++);
                }
            }
        }

        const focusId = this.selectedAgent?.id || this.cameraDirector?.attentionFrame?.focusedAgentId;
        const routineZoom = (this.restZoom ?? zoom) >= ROUTINE_NAME_MIN_ZOOM;
        const perRegion = zoom >= ROUTINE_NAME_DETAIL_ZOOM ? ROUTINE_NAMES_PER_REGION_DETAIL : ROUTINE_NAMES_PER_REGION;
        const regionCounts = this._overlayRegionCounts;
        regionCounts.clear();
        for (const sprite of prioritized) {
            const attention = isAttentionStatus(sprite.agent.status);
            const focused = sprite.selected || sprite.agent.id === focusId;
            const primary = focused || attention;
            sprite.theatreMode = effectiveTheatre;
            sprite.decisionFocusMuted = Boolean(focusId && sprite.agent.id !== focusId);
            sprite.decisionFocusRoutine = sprite.decisionFocusMuted && !primary;
            sprite.readVerb = readMode && !primary ? sprite.readToolVerb || 'OTHER' : null;

            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;
            sprite.labelPlate = false;
            sprite.labelShiftX = 0;
            sprite.labelShiftY = 0;
            sprite.gpuActionOverlay = false;
            sprite.labelAlpha = 1;
            sprite.foldedIntoBuilding = false;
            sprite.plateOffFrame = false;

            // T2 — selected, camera-focused and hovered agents wear the plate.
            // A hovered action-needed agent is already named by its T1 plate.
            if (focused || (sprite.hovered && !attention)) {
                sprite.labelPlate = true;
                sprite.overlaySlot = 0;
                sprite.nameTagSlot = 0;
                sprite.gpuActionOverlay = true;
                // S13 — clamped inside the canvas while the body is in view;
                // no plate at all once the body has left the frame.
                if (!this._clampIdentityPlate(sprite, viewport, zoom)) {
                    sprite.plateOffFrame = true;
                    sprite.overlaySlot = null;
                    sprite.nameTagSlot = null;
                    continue;
                }
                // Check T2 plate against Layer 1 building plaques and step clear when possible.
                let t2Slot = 0;
                let t2Rect = this._agentIdentityRect(sprite, t2Slot);
                while (
                    t2Slot + 1 < READ_MODE_NAME_SLOTS
                    && sharedGrid.overlapsMaxLayer(t2Rect.x, t2Rect.y, t2Rect.x + t2Rect.w, t2Rect.y + t2Rect.h, OVERLAY_LAYER_PLAQUE, 0)
                ) {
                    t2Slot++;
                    t2Rect = this._agentIdentityRect(sprite, t2Slot);
                }
                sprite.overlaySlot = t2Slot;
                sprite.nameTagSlot = t2Slot;
                reserve(t2Rect);
                continue;
            }
            // T1 owns the identity of every action-needed agent.
            if (attention || effectiveTheatre) continue;
            // A name the operator gave the session (Claude Code `/rename`)
            // always shows: past decision focus, the zoom gate, the region
            // cap and the crowd fold, offset rather than dropped on overlap.
            const userNamed = sprite.agent.userNamed === true;
            if (sprite.decisionFocusRoutine && !userNamed) {
                sprite.labelAlpha = 0;
                continue;
            }
            // W-F16 — a body hidden behind a building, gate or wall carries no
            // routine name or action marks on the occluder's face.
            if (sprite._occludedByWorld || sprite._behindBuilding) {
                sprite.labelAlpha = 0;
                continue;
            }
            if (sprite.agent?.currentTool && actionLabels < actionLabelCap) {
                sprite.gpuActionOverlay = true;
                actionLabels++;
            }
            // Plan 6.2 — the name waits for the walk-in to land.
            if (sprite.isArrivalPending?.()) continue;

            // T4 — routine names: top-N per screen region at z >= 1.6 (every
            // name while READ is held), dropped rather than offset.
            let regionKey = null;
            if (!readMode && !userNamed) {
                if (!routineZoom) continue;
                const point = this.camera.worldToScreen(sprite.x, sprite.y);
                regionKey = `${Math.floor(point.x / ROUTINE_NAME_REGION_PX)},${Math.floor(point.y / ROUTINE_NAME_REGION_PX)}`;
                if ((regionCounts.get(regionKey) || 0) >= perRegion) continue;
            }
            const slotCap = readMode || userNamed ? READ_MODE_NAME_SLOTS : 1;
            let slot = 0;
            let rect = this._agentIdentityRect(sprite, slot);
            // 3.4 — Canvas bodies paint names in depth order, so a label under
            // a prop's front band would be covered; the resident overlay is not.
            const propCheck = !sprite.gpuWorldEnabled;
            // Plan 2.5 — a routine name never crosses another body: if it
            // would, it is dropped (identity stays one hover away).
            while (slot < slotCap && (collides(rect)
                || this._nameRectHitsOtherBody(rect, sprite, prioritized)
                || (propCheck && this._nameSlotRectHitsProp(rect, sprite.y)))) {
                slot++;
                if (slot < slotCap) rect = this._agentIdentityRect(sprite, slot);
            }
            if (slot >= slotCap) {
                if (!userNamed) continue;
                slot = 0;
                rect = this._agentIdentityRect(sprite, slot);
            }
            sprite.overlaySlot = slot;
            reserve(rect);
            if (regionKey) regionCounts.set(regionKey, (regionCounts.get(regionKey) || 0) + 1);
        }

        const bubbleSprites = this._overlayBubbleSprites;
        bubbleSprites.length = 0;
        for (const sprite of prioritized) {
            // W3.4 — a speaker hidden behind a building keeps its thought; the
            // column is lifted above the occluding building's crown.
            if (sprite.decisionFocusMuted) {
                this._clearThoughtPlacement(sprite);
                continue;
            }
            bubbleSprites.push(sprite);
        }
        // Layer 3 (OVERLAY_LAYER_THOUGHT): solve ThoughtColumn placement over
        // the shared 96 px occupancy grid via deterministic ε-auction.
        this._assignAgentBubbleSlots(
            bubbleSprites,
            zoom,
            reservedRects,
            sharedGrid,
            now,
        );
    }

    _screenRectToWorld(rect) {
        const camera = this.camera;
        if (!camera?.screenToWorld || !rect) return null;
        const topLeft = camera.screenToWorld(rect.left, rect.top);
        const bottomRight = camera.screenToWorld(rect.right, rect.bottom);
        return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
    }

    // W5-C / W3.1 — shared-grid ThoughtColumn ε-auction placement.
    // Reserves Layer 1 static plaques + Layer 2 attention plates in the shared
    // 96 px OverlayOccupancyGrid, then solves Layer 3 thoughts (<= 24 speakers x
    // 30 candidates) via `SlotAuction.solveLabelAuction` with sticky prior -2
    // bonus, boundsViolation * 1000, 150ms lower-priority-only hold, and zero
    // per-frame heap allocations.
    _assignAgentBubbleSlots(
        sprites,
        zoom = this.camera?.zoom || 1,
        reservedLabels = [],
        occupiedGrid = null,
        now = performance.now(),
        options = null,
    ) {
        const occ = this._ensureOverlayAuctionPools();
        const externalSharedGrid = occupiedGrid instanceof OverlayOccupancyGrid;
        const grid = externalSharedGrid ? occupiedGrid : occ.grid;
        const pool = occ.pool;
        const useMergeSpatialGrid = occupiedGrid !== false && Boolean(this._overlayClusterGrid);
        const pad = Number.isFinite(options?.pad) ? options.pad : 2;
        const budget = Number.isInteger(options?.budget)
            ? Math.max(0, Math.min(LABEL_MAX_SPEAKERS, options.budget))
            : THOUGHT_BUDGET;
        const shortlistLimit = Math.max(THOUGHT_SHORTLIST, budget);

        const s = 1 / (zoom || 1);
        const viewport = typeof this._screenViewport === 'function' ? this._screenViewport() : null;
        const hasView = Boolean(viewport?.width > 0 && viewport?.height > 0
            && this.camera?.worldToScreen && this.camera?.screenToWorld);
        let viewWorld = null;
        let reservedWorld = null;
        if (hasView) {
            const topLeft = this.camera.screenToWorld(THOUGHT_EDGE_MARGIN, THOUGHT_EDGE_MARGIN);
            const bottomRight = this.camera.screenToWorld(viewport.width - THOUGHT_EDGE_MARGIN, viewport.height - THOUGHT_EDGE_MARGIN);
            viewWorld = {
                left: topLeft.x,
                top: topLeft.y,
                right: bottomRight.x,
                bottom: bottomRight.y,
            };
            const reserved = getReservedRects();
            if (reserved?.length) {
                reservedWorld = [];
                for (const rect of reserved) {
                    const worldRect = this._screenRectToWorld(rect);
                    if (worldRect && worldRect.w > 0 && worldRect.h > 0) reservedWorld.push(worldRect);
                }
            }
        }

        const order = this._overlayBubbleOrder || (this._overlayBubbleOrder = []);
        order.length = 0;
        const frame = this._thoughtFrame = (this._thoughtFrame || 0) + 1;
        for (const sprite of sprites || []) {
            if (!sprite?.agent) continue;
            sprite._thoughtFrame = frame;
            if (hasView && !this._thoughtSpeakerOnScreen(sprite, viewport, zoom)) {
                this._clearThoughtPlacement(sprite);
                continue;
            }
            if (this._spriteWantsBubble(sprite)) order.push(sprite);
            else this._clearThoughtPlacement(sprite);
        }
        // Focus first, then a column still inside its seat hold, then the
        // freshest line; the id breaks ties so the order cannot flicker.
        for (const sprite of order) {
            sprite._thoughtRank = sprite.selected ? 3 : sprite.hovered ? 2
                : (sprite._thoughtSeatedAt && now - sprite._thoughtSeatedAt < THOUGHT_MIN_SEAT_MS ? 1 : 0);
        }
        order.sort((a, b) => {
            const delta = b._thoughtRank - a._thoughtRank;
            if (delta !== 0) return delta;
            const fresh = (b._dialogueDisplayUntil || 0) - (a._dialogueDisplayUntil || 0);
            if (fresh !== 0) return fresh;
            return String(a.agent.id) < String(b.agent.id) ? -1 : 1;
        });

        const calm = order.length <= THOUGHT_CALM_SPEAKERS;
        let prepared = 0;
        for (const sprite of order) {
            sprite._thoughtHistoryLimit = calm || sprite._thoughtRank >= 2 ? THOUGHT_HISTORY_LIMIT : 0;
            if (prepared < shortlistLimit && this._prepareThought(sprite, s)) {
                order[prepared++] = sprite;
                continue;
            }
            this._clearThoughtPlacement(sprite);
            if (prepared >= shortlistLimit) sprite._thoughtFiltered = true;
        }
        order.length = prepared;

        const baseRects = this._overlayBubbleBaseRects || (this._overlayBubbleBaseRects = []);
        baseRects.length = 0;
        let minSpeakerX = Infinity;
        let minSpeakerY = Infinity;
        let maxSpeakerX = -Infinity;
        let maxSpeakerY = -Infinity;
        for (const sprite of order) {
            const rects = this._thoughtCandidateRects(sprite, 0, s);
            const home = rects.home;
            home.x = rects.body.x;
            home.y = rects.body.y;
            home.w = rects.body.w;
            home.h = rects.body.h;
            baseRects.push(home);
            if (sprite.x < minSpeakerX) minSpeakerX = sprite.x;
            if (sprite.x > maxSpeakerX) maxSpeakerX = sprite.x;
            if (sprite.y < minSpeakerY) minSpeakerY = sprite.y;
            if (sprite.y > maxSpeakerY) maxSpeakerY = sprite.y;
        }

        // W3.7 — merge before placement, so a member folded into an identical
        // ×N thought reserves nothing.
        if (this._overlayClusterGrid) {
            this._mergeIdenticalClusterBubbles(order, baseRects, useMergeSpatialGrid);
        }

        const hasLayeredContext = externalSharedGrid
            || Boolean(options?.plaques || options?.attentionPlates);
        const researchHoldMs = hasLayeredContext ? THOUGHT_RESEARCH_MS : THOUGHT_LEGACY_RESEARCH_MS;

        // Populate standalone shared grid when called directly (not from `_assignAgentOverlaySlots`).
        if (!externalSharedGrid) {
            grid.beginFrame();
            const clampMargin = 1024;
            const cMinX = Number.isFinite(minSpeakerX) ? minSpeakerX - clampMargin : -2048;
            const cMinY = Number.isFinite(minSpeakerY) ? minSpeakerY - clampMargin : -2048;
            const cMaxX = Number.isFinite(maxSpeakerX) ? maxSpeakerX + clampMargin : 2048;
            const cMaxY = Number.isFinite(maxSpeakerY) ? maxSpeakerY + clampMargin : 2048;

            let plaqueTag = 0;
            if (Array.isArray(options?.plaques)) {
                for (let i = 0; i < options.plaques.length; i++) {
                    if (this._reserveRectClampedInGrid(grid, options.plaques[i], OVERLAY_LAYER_PLAQUE, plaqueTag, cMinX, cMinY, cMaxX, cMaxY)) {
                        plaqueTag++;
                    }
                }
            }
            occ.stats.plaques = plaqueTag;

            let attnTag = 0;
            if (Array.isArray(options?.attentionPlates) && options.attentionPlates.length > 0) {
                const first = options.attentionPlates[0];
                if (first && (first.left !== undefined || first.w !== undefined)) {
                    for (let i = 0; i < options.attentionPlates.length; i++) {
                        if (this._reserveRectClampedInGrid(grid, options.attentionPlates[i], OVERLAY_LAYER_ATTENTION, attnTag, cMinX, cMinY, cMaxX, cMaxY)) {
                            attnTag++;
                        }
                    }
                } else {
                    attnTag = reserveAttentionPlates(grid, options.attentionPlates, viewWorld, null, pad);
                }
            }
            const legacyLayer = hasLayeredContext ? OVERLAY_LAYER_ATTENTION : OVERLAY_LAYER_THOUGHT;
            if (Array.isArray(reservedLabels)) {
                for (let i = 0; i < reservedLabels.length; i++) {
                    const tag = hasLayeredContext ? attnTag : -1;
                    if (this._reserveRectClampedInGrid(grid, reservedLabels[i], legacyLayer, tag, cMinX, cMinY, cMaxX, cMaxY)) {
                        if (hasLayeredContext) attnTag++;
                    }
                }
            }
            if (occupiedGrid && typeof occupiedGrid === 'object' && occupiedGrid.buckets instanceof Map) {
                const seenLegacy = occupiedGrid.seen || new Set();
                seenLegacy.clear();
                for (const bucket of occupiedGrid.buckets.values()) {
                    if (!bucket || bucket.generation !== occupiedGrid.generation) continue;
                    for (const item of bucket.items) {
                        if (seenLegacy.has(item)) continue;
                        seenLegacy.add(item);
                        const tag = hasLayeredContext ? attnTag : -1;
                        if (this._reserveRectClampedInGrid(grid, item.rect || item, legacyLayer, tag, cMinX, cMinY, cMaxX, cMaxY)) {
                            if (hasLayeredContext) attnTag++;
                        }
                    }
                }
            }
            occ.stats.attention = attnTag;
        }

        // Select cohort (all focused + up to `budget` non-focused unmerged speakers)
        // and honor the 150ms hold ONLY when blocked by a strictly lower-priority
        // thought (never overlapping Layer 1 plaques or Layer 2 attention/names).
        const cohortSprites = this._auctionCohortSprites || (this._auctionCohortSprites = []);
        const overflowSprites = this._auctionOverflowSprites || (this._auctionOverflowSprites = []);
        cohortSprites.length = 0;
        overflowSprites.length = 0;

        let placedCount = 0;
        let nonFocusedAdmitted = 0;

        const commitPlacement = (sprite, chosen, chosenClampX, committed, wasClamped, reserveBody = true, priorityTag = 0) => {
            if (chosen !== committed || (chosenClampX !== 0) !== wasClamped) {
                sprite._bubbleBlockedSince = 0;
                sprite._bubbleBetterSince = 0;
            }
            sprite._bubbleCandidate = chosen;
            sprite._bubbleClamped = chosenClampX !== 0;
            sprite.bubbleClampX = chosenClampX;
            const rects = this._thoughtCandidateRects(sprite, chosen, s, chosenClampX);
            if (reserveBody) {
                grid.reserve(rects.body.x, rects.body.y, rects.body.x + rects.body.w, rects.body.y + rects.body.h, OVERLAY_LAYER_THOUGHT, priorityTag);
            }
            if (rects.leader) {
                grid.reserve(rects.v.x, rects.v.y, rects.v.x + rects.v.w, rects.v.y + rects.v.h, OVERLAY_LAYER_THOUGHT, priorityTag);
            }
            if (rects.horizontal) {
                grid.reserve(rects.h.x, rects.h.y, rects.h.x + rects.h.w, rects.h.y + rects.h.h, OVERLAY_LAYER_THOUGHT, priorityTag);
            }
            sprite.bubbleSlot = THOUGHT_CANDIDATE_SLOT[chosen];
            sprite.bubbleLateral = THOUGHT_CANDIDATE_LATERAL[chosen] * (sprite._thoughtSide || 1);
            if (!sprite._thoughtSeatedAt) sprite._thoughtSeatedAt = now;
            placedCount++;
        };

        const rectsOverlapGrid = (rects) => {
            if (grid.overlaps(rects.body.x, rects.body.y, rects.body.x + rects.body.w, rects.body.y + rects.body.h, pad)) {
                return true;
            }
            if (rects.leader && grid.overlaps(rects.v.x, rects.v.y, rects.v.x + rects.v.w, rects.v.y + rects.v.h, pad)) {
                return true;
            }
            return rects.horizontal && grid.overlaps(rects.h.x, rects.h.y, rects.h.x + rects.h.w, rects.h.y + rects.h.h, pad);
        };

        const rectsOverlapHardOrHigher = (rects, spPriority) => {
            if (grid.overlapsHardOrPriority(rects.body.x, rects.body.y, rects.body.x + rects.body.w, rects.body.y + rects.body.h, spPriority, pad)) {
                return true;
            }
            if (rects.leader && grid.overlapsHardOrPriority(rects.v.x, rects.v.y, rects.v.x + rects.v.w, rects.v.y + rects.v.h, spPriority, pad)) {
                return true;
            }
            return rects.horizontal && grid.overlapsHardOrPriority(rects.h.x, rects.h.y, rects.h.x + rects.h.w, rects.h.y + rects.h.h, spPriority, pad);
        };

        for (let i = 0; i < order.length; i++) {
            const sprite = order[i];
            if (sprite.bubbleMergedInto) {
                sprite.bubbleSlot = null;
                sprite.bubbleLateral = 0;
                sprite.bubbleClampX = 0;
                sprite._bubbleClamped = false;
                sprite._bubbleCandidate = null;
                continue;
            }
            if (sprite.bubbleMergedCount > 1) this._layoutThoughtColumns(sprite);
            const focused = sprite._thoughtRank >= 2;
            if (!focused && nonFocusedAdmitted >= budget) {
                overflowSprites.push(sprite);
                continue;
            }

            const stickyKey = (sprite.selected ? 1 : 0) | (sprite.bubbleOccluded ? 2 : 0);
            if (sprite._bubbleStickyKey !== stickyKey) {
                sprite._bubbleStickyKey = stickyKey;
                sprite._bubbleCandidate = null;
                sprite._bubbleClamped = false;
            }

            const spPriority = (sprite._thoughtRank || 0) * 10000;
            const committed = sprite._bubbleCandidate ?? null;
            const wasClamped = Boolean(sprite._bubbleClamped);
            if (committed !== null) {
                const committedClampX = wasClamped && viewWorld ? this._thoughtClampX(sprite, committed, s, viewWorld) : 0;
                const committedRects = this._thoughtCandidateRects(sprite, committed, s, committedClampX);
                const outOfBounds = this._thoughtBoundsViolationArea(committedRects.body, viewWorld, reservedWorld) > 0;
                const blockedByHardOrHigher = rectsOverlapHardOrHigher(committedRects, spPriority);
                if (!outOfBounds && !blockedByHardOrHigher && rectsOverlapGrid(committedRects)) {
                    if (!sprite._bubbleBlockedSince) sprite._bubbleBlockedSince = now;
                    if (now - sprite._bubbleBlockedSince < researchHoldMs) {
                        commitPlacement(sprite, committed, committedClampX, committed, wasClamped, true, spPriority);
                        if (!focused) nonFocusedAdmitted++;
                        continue;
                    }
                } else if (!outOfBounds) {
                    sprite._bubbleBlockedSince = 0;
                }
            }

            if (cohortSprites.length < LABEL_MAX_SPEAKERS) {
                cohortSprites.push(sprite);
                if (!focused) nonFocusedAdmitted++;
            } else {
                overflowSprites.push(sprite);
            }
        }

        // Solve Layer 3 ThoughtColumn placement via deterministic ε-auction.
        let auctionIterations = 0;
        let filteredCount = 0;
        if (cohortSprites.length > 0) {
            const activeSpeakers = pool.activeSpeakers;
            activeSpeakers.length = 0;

            for (let i = 0; i < cohortSprites.length; i++) {
                const sprite = cohortSprites[i];
                const spDesc = pool.descriptors[i];
                resetThoughtCandidateSlots(spDesc);
                const committed = sprite._bubbleCandidate ?? null;
                const wasClamped = Boolean(sprite._bubbleClamped);
                let holdForReturn = false;
                if (committed !== null && !sprite._bubbleBlockedSince && (wasClamped || committed > 0)) {
                    const returnLimit = wasClamped ? THOUGHT_CANDIDATE_COUNT : committed;
                    let betterFree = false;
                    for (let c = 0; c < returnLimit; c++) {
                        const r = this._thoughtCandidateRects(sprite, c, s, 0);
                        if (!rectsOverlapGrid(r) && this._thoughtBoundsViolationArea(r.body, viewWorld, reservedWorld) === 0) {
                            betterFree = true;
                            break;
                        }
                    }
                    if (!betterFree) {
                        sprite._bubbleBetterSince = 0;
                        holdForReturn = true;
                    } else if (!sprite._bubbleBetterSince) {
                        sprite._bubbleBetterSince = now;
                        holdForReturn = true;
                    } else if (now - sprite._bubbleBetterSince < THOUGHT_RETURN_MS) {
                        holdForReturn = true;
                    }
                }

                spDesc.id = String(sprite.agent.id);
                // Tier-based priority: strictly higher tiers (selected > hovered >
                // seated > normal) can never be evicted by lower tiers, while
                // equal-tier peers bid cooperatively in the ε-auction to pack cleanly.
                spDesc.priority = (sprite._thoughtRank || 0) * 10000;
                spDesc.priorCandidate = committed !== null && !sprite._bubbleBlockedSince ? committed : -1;

                const side = sprite._thoughtSide || 1;
                for (let c = 0; c < THOUGHT_CANDIDATE_COUNT; c++) {
                    let clampX = 0;
                    let rects = this._thoughtCandidateRects(sprite, c, s, 0);
                    if (viewWorld) {
                        const neededClamp = this._thoughtClampX(sprite, c, s, viewWorld);
                        if (neededClamp !== 0) {
                            clampX = neededClamp;
                            rects = this._thoughtCandidateRects(sprite, c, s, clampX);
                        }
                    }
                    spDesc._clampX[c] = clampX;

                    const cand = spDesc.candidates[c];
                    cand.left = rects.body.x;
                    cand.top = rects.body.y;
                    cand.right = rects.body.x + rects.body.w;
                    cand.bottom = rects.body.y + rects.body.h;

                    const slot = THOUGHT_CANDIDATE_SLOT[c];
                    const lateral = THOUGHT_CANDIDATE_LATERAL[c] * side;
                    let cost = thoughtCandidateCost(c, lateral, slot);
                    if (clampX !== 0) cost += 12;
                    if (holdForReturn && c === committed) cost = -0.5;
                    if (
                        (rects.leader && grid.overlaps(rects.v.x, rects.v.y, rects.v.x + rects.v.w, rects.v.y + rects.v.h, pad))
                        || (rects.horizontal && grid.overlaps(rects.h.x, rects.h.y, rects.h.x + rects.h.w, rects.h.y + rects.h.h, pad))
                    ) {
                        cost = 1e6;
                    }
                    cand.cost = cost;
                }
                activeSpeakers.push(spDesc);
            }

            const auctionOptions = occ.auctionOptions;
            auctionOptions.pad = pad;
            auctionOptions.viewport = viewWorld;
            auctionOptions.reservedRects = reservedWorld;
            auctionOptions.reserveInGrid = true;
            auctionOptions.outRects = pool.rects;
            auctionOptions.outStats = pool.stats;

            solveLabelAuction(grid, activeSpeakers, pool.assignments, auctionOptions);
            auctionIterations = pool.stats.iterations;

            for (let i = 0; i < cohortSprites.length; i++) {
                const sprite = cohortSprites[i];
                const spDesc = pool.descriptors[i];
                const committed = sprite._bubbleCandidate ?? null;
                const wasClamped = Boolean(sprite._bubbleClamped);
                const focused = sprite._thoughtRank >= 2;
                let chosen = pool.assignments[i];
                let chosenClampX = chosen >= 0 ? spDesc._clampX[chosen] : 0;

                if (chosen >= 0) {
                    // `solveLabelAuction` already reserved `rects.body` in `grid`.
                    commitPlacement(sprite, chosen, chosenClampX, committed, wasClamped, false, spDesc.priority);
                    continue;
                }

                if (focused) {
                    // Focused speaker falls back to the least-overlapping candidate.
                    let leastScore = Infinity;
                    let least = 0;
                    let leastClampX = 0;
                    for (let c = 0; c < THOUGHT_CANDIDATE_COUNT; c++) {
                        const r0 = this._thoughtCandidateRects(sprite, c, s, 0);
                        const ov0 = grid.overlapArea(r0.body.x, r0.body.y, r0.body.x + r0.body.w, r0.body.y + r0.body.h, 0)
                            + (r0.leader ? grid.overlapArea(r0.v.x, r0.v.y, r0.v.x + r0.v.w, r0.v.y + r0.v.h, 0) : 0)
                            + (r0.horizontal ? grid.overlapArea(r0.h.x, r0.h.y, r0.h.x + r0.h.w, r0.h.y + r0.h.h, 0) : 0);
                        const b0 = this._thoughtBoundsViolationArea(r0.body, viewWorld, reservedWorld);
                        const sc0 = ov0 + b0 * 1000;
                        if (sc0 < leastScore) {
                            leastScore = sc0;
                            least = c;
                            leastClampX = 0;
                        }
                        if (viewWorld) {
                            const cx = this._thoughtClampX(sprite, c, s, viewWorld);
                            if (cx !== 0) {
                                const rc = this._thoughtCandidateRects(sprite, c, s, cx);
                                const ovc = grid.overlapArea(rc.body.x, rc.body.y, rc.body.x + rc.body.w, rc.body.y + rc.body.h, 0)
                                    + (rc.leader ? grid.overlapArea(rc.v.x, rc.v.y, rc.v.x + rc.v.w, rc.v.y + rc.v.h, 0) : 0)
                                    + (rc.horizontal ? grid.overlapArea(rc.h.x, rc.h.y, rc.h.x + rc.h.w, rc.h.y + rc.h.h, 0) : 0);
                                const bc = this._thoughtBoundsViolationArea(rc.body, viewWorld, reservedWorld);
                                const scc = ovc + bc * 1000;
                                if (scc < leastScore) {
                                    leastScore = scc;
                                    least = c;
                                    leastClampX = cx;
                                }
                            }
                        }
                    }
                    commitPlacement(sprite, least, leastClampX, committed, wasClamped, true, spDesc.priority);
                    continue;
                }

                this._clearThoughtPlacement(sprite);
                sprite._thoughtFiltered = true;
                filteredCount++;
            }
        }

        // Backfill any unused budget slots from overflow sprites when cohort speakers
        // were completely blocked, else mark overflow speakers filtered cleanly.
        for (let i = 0; i < overflowSprites.length; i++) {
            const sprite = overflowSprites[i];
            if (placedCount < budget) {
                let found = -1;
                let foundClampX = 0;
                for (let c = 0; c < THOUGHT_CANDIDATE_COUNT; c++) {
                    const r = this._thoughtCandidateRects(sprite, c, s, 0);
                    if (!rectsOverlapGrid(r) && this._thoughtBoundsViolationArea(r.body, viewWorld, reservedWorld) === 0) {
                        found = c;
                        break;
                    }
                }
                if (found < 0 && viewWorld) {
                    for (let c = 0; c < THOUGHT_CANDIDATE_COUNT; c++) {
                        const cx = this._thoughtClampX(sprite, c, s, viewWorld);
                        if (cx === 0) continue;
                        const r = this._thoughtCandidateRects(sprite, c, s, cx);
                        if (!rectsOverlapGrid(r) && this._thoughtBoundsViolationArea(r.body, viewWorld, reservedWorld) === 0) {
                            found = c;
                            foundClampX = cx;
                            break;
                        }
                    }
                }
                if (found >= 0) {
                    commitPlacement(sprite, found, foundClampX, sprite._bubbleCandidate ?? null, Boolean(sprite._bubbleClamped), true);
                    continue;
                }
            }
            this._clearThoughtPlacement(sprite);
            sprite._thoughtFiltered = true;
            filteredCount++;
        }

        const stats = occ.stats;
        stats.frames++;
        stats.speakers = order.length;
        stats.placed = placedCount;
        stats.filtered = filteredCount;
        stats.iterations = auctionIterations;
        stats.totalPlaced += placedCount;
        stats.totalFiltered += filteredCount;

        // A speaker that left the visible set drops its placement and seat
        // instead of carrying them stale until it returns.
        const seated = this._thoughtSeated || (this._thoughtSeated = []);
        for (const sprite of seated) {
            if (sprite._thoughtFrame !== frame) this._clearThoughtPlacement(sprite);
        }
        seated.length = 0;
        for (const sprite of order) {
            if (sprite.bubbleSlot != null) seated.push(sprite);
        }
    }

    // Builds the sprite's thread and columns for this frame; false = no thought.
    _prepareThought(sprite, s) {
        sprite.bubbleMergedCount = 1;
        sprite.bubbleMergedInto = null;
        sprite._thoughtFiltered = false;
        if (!this._spriteWantsBubble(sprite)) return false;
        const thread = typeof sprite._activityThread === 'function' ? sprite._activityThread() : THOUGHT_NO_THREAD;
        const clock = Boolean(sprite._shouldUseLongWaitClock?.());
        if (!thread.length && !clock) return false;
        // The painter consumes this thread, so it is built once per frame.
        sprite._statusThread = thread;
        sprite._statusClock = clock;
        if (!sprite._thoughtRects) {
            sprite._thoughtRects = {
                body: { x: 0, y: 0, w: 0, h: 0 },
                v: { x: 0, y: 0, w: 0, h: 0 },
                h: { x: 0, y: 0, w: 0, h: 0 },
                home: { x: 0, y: 0, w: 0, h: 0 },
                leader: false,
                horizontal: false,
            };
        }
        if (sprite._thoughtSideFor !== sprite.agent.id) {
            const id = String(sprite.agent.id);
            let hash = 0;
            for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
            sprite._thoughtSideFor = sprite.agent.id;
            sprite._thoughtSide = (hash & 1) ? 1 : -1;
        }
        this._layoutThoughtColumns(sprite);
        sprite._thoughtAnchorX = sprite.x;
        sprite.bubbleOccluded = Boolean((sprite._occludedByWorld || sprite._behindBuilding) && !sprite.selected);
        if (sprite.bubbleOccluded && this._thoughtOccluderBase(sprite, s)) return true;
        sprite.bubbleBaseY = typeof sprite._headTopY === 'function'
            ? (typeof sprite._labelTopY === 'function' ? sprite._labelTopY(sprite._headTopY()) : sprite._headTopY())
            : sprite.y;
        sprite.bubbleAnchorDy = THOUGHT_LEADER_TIP;
        return true;
    }

    // EF-4 — the speaker tag a displaced head carries, told apart across the
    // live roster (ThoughtColumn.speakerTagsFor). The names are re-read at
    // most once a second and the table rebuilt only when one came, went or
    // changed, so a tag holds while the roster holds.
    _speakerTagFor(name) {
        const now = Date.now();
        const table = this._speakerTags || (this._speakerTags = { checkedAt: -Infinity, signature: null, tags: new Map() });
        if (!(now - table.checkedAt < 1000)) {
            table.checkedAt = now;
            const names = [];
            for (const sprite of this.agentSprites.values()) names.push(sprite.agent?.name || sprite.agent?.displayName || '');
            const signature = names.join('\n');
            if (signature !== table.signature) {
                table.signature = signature;
                table.tags = speakerTagsFor(names);
            }
        }
        return table.tags.get(name) ?? speakerTagFor(name);
    }

    _layoutThoughtColumns(sprite) {
        const thread = sprite._statusThread || THOUGHT_NO_THREAD;
        const clock = sprite._statusClock === true;
        const chip = !clock && Boolean(sprite.thoughtRepoAccent?.());
        const tagLength = clock ? 0 : (sprite.thoughtSpeakerTag?.() || '').length;
        const merged = sprite.bubbleMergedCount || 1;
        const history = sprite._thoughtHistoryLimit ?? THOUGHT_HISTORY_LIMIT;
        sprite._thoughtColumn = layoutThoughtColumn(sprite._thoughtColumn || createThoughtColumn(), thread, clock, chip, 0, merged, history);
        sprite._thoughtColumnTagged = layoutThoughtColumn(sprite._thoughtColumnTagged || createThoughtColumn(), thread, clock, chip, tagLength, merged, history);
    }

    _clearThoughtPlacement(sprite) {
        sprite.bubbleSlot = null;
        sprite.bubbleLateral = 0;
        sprite.bubbleClampX = 0;
        sprite._bubbleClamped = false;
        sprite.bubbleOccluded = false;
        sprite.bubbleMergedCount = 1;
        sprite.bubbleMergedInto = null;
        sprite._bubbleCandidate = null;
        sprite._bubbleBlockedSince = 0;
        sprite._bubbleBetterSince = 0;
        sprite._thoughtSeatedAt = 0;
        sprite._thoughtFiltered = false;
    }

    // Speakers wholly outside the visible canvas skip thought slots so they
    // never burn THOUGHT_BUDGET or draw off-screen clipped bubbles.
    _thoughtSpeakerOnScreen(sprite, viewport, zoom) {
        const point = this.camera.worldToScreen(sprite.x, sprite.y);
        const box = sprite._bodyBox;
        const bodyLeft = point.x + (box ? box.left : -12) * zoom;
        const bodyRight = point.x + (box ? box.right : 12) * zoom;
        const bodyTop = point.y + (box ? box.top : -48) * zoom;
        const bodyBottom = point.y + (box ? box.bottom : 0) * zoom;
        return bodyRight > 0 && bodyLeft < viewport.width && bodyBottom > 0 && bodyTop < viewport.height;
    }

    // W3.4 — the base and leader landing for a speaker the depth pass hid
    // behind a split building: the tail tip sits THOUGHT_CROWN_GAP px above the
    // building's highest opaque row and the leader lands on the roofline in the
    // speaker's own column. False when the building's mask is unknown.
    _thoughtOccluderBase(sprite, s) {
        const drawable = sprite._behindBuildingDrawable;
        const id = drawable?.entry?.id;
        const assets = this.assets;
        if (!id || !assets?.getDims) return false;
        const crowns = this._thoughtCrowns || (this._thoughtCrowns = new Map());
        let crown = crowns.get(id);
        if (!crown) {
            const dims = assets.getDims(id);
            const mask = assets.getMask?.(id);
            if (!dims || !mask) return false;
            const first = mask.indexOf(1);
            crown = { w: dims.w, h: dims.h, mask, firstRow: first >= 0 ? Math.floor(first / dims.w) : 0 };
            crowns.set(id, crown);
        }
        const [ax, ay] = assets.getAnchor(id);
        const left = drawable.wx - ax;
        const top = drawable.wy - ay;
        const column = Math.max(0, Math.min(crown.w - 1, Math.round(sprite.x - left)));
        let roof = crown.firstRow;
        for (let row = crown.firstRow; row < crown.h; row++) {
            if (crown.mask[row * crown.w + column]) {
                roof = row;
                break;
            }
        }
        sprite.bubbleBaseY = top + crown.firstRow - (THOUGHT_CROWN_GAP + THOUGHT_LEADER_TIP) * s;
        sprite.bubbleAnchorDy = Math.round((top + roof - sprite.bubbleBaseY) / s);
        return true;
    }

    // World rects of candidate `index`: the column body, plus the leader's
    // vertical and horizontal runs (each three px wide with their outline).
    _thoughtCandidateRects(sprite, index, s, clampX = 0) {
        const lateral = THOUGHT_CANDIDATE_LATERAL[index] * (sprite._thoughtSide || 1);
        const slot = THOUGHT_CANDIDATE_SLOT[index];
        const occluded = sprite.bubbleOccluded === true;
        const column = lateral !== 0 || clampX !== 0 || occluded ? sprite._thoughtColumnTagged : sprite._thoughtColumn;
        const shiftX = thoughtLateralShift(column, lateral) + clampX;
        const slotShift = -slot * THOUGHT_STACK_STEP;
        const anchorX = sprite._thoughtAnchorX;
        const baseY = sprite.bubbleBaseY;
        const rects = sprite._thoughtRects;
        const body = rects.body;
        body.x = anchorX + (shiftX + column.left) * s;
        body.y = baseY + (slotShift + column.top) * s;
        body.w = column.width * s;
        body.h = column.height * s;
        rects.leader = lateral !== 0 || clampX !== 0 || slot !== 0 || occluded;
        rects.horizontal = false;
        if (!rects.leader) return rects;
        const geo = thoughtLeader(this._thoughtLeaderScratch || (this._thoughtLeaderScratch = {}), column, shiftX, slotShift, sprite.bubbleAnchorDy);
        const v = rects.v;
        v.x = anchorX + (geo.x - 1) * s;
        v.y = baseY + Math.min(geo.fromY, geo.toY) * s;
        v.w = 3 * s;
        v.h = (Math.abs(geo.toY - geo.fromY) + 1) * s;
        if (geo.x !== 0) {
            const h = rects.h;
            rects.horizontal = true;
            h.x = anchorX + (Math.min(geo.x, 0) - 1) * s;
            h.y = baseY + (geo.toY - 1) * s;
            h.w = (Math.abs(geo.x) + 3) * s;
            h.h = 3 * s;
        }
        return rects;
    }

    // Horizontal screen-px shift required to keep candidate `index` inside
    // `[viewWorld.left, viewWorld.right]`, or 0 when it already fits.
    _thoughtClampX(sprite, index, s, viewWorld) {
        if (!viewWorld) return 0;
        const unclamped = this._thoughtCandidateRects(sprite, index, s, 0).body;
        if (unclamped.x >= viewWorld.left && unclamped.x + unclamped.w <= viewWorld.right) return 0;
        const lateral = THOUGHT_CANDIDATE_LATERAL[index] * (sprite._thoughtSide || 1);
        const column = sprite._thoughtColumnTagged;
        const baseLeft = sprite._thoughtAnchorX + (thoughtLateralShift(column, lateral) + column.left) * s;
        const width = column.width * s;
        if (baseLeft < viewWorld.left) return Math.ceil((viewWorld.left - baseLeft) / s);
        if (baseLeft + width > viewWorld.right) {
            const targetLeft = Math.max(viewWorld.left, viewWorld.right - width);
            return Math.floor((targetLeft - baseLeft) / s);
        }
        return 0;
    }

    // World area of `body` that falls outside `viewWorld` or overlaps any
    // reserved chrome rect (`getReservedRects()`). Zero means fully in bounds
    // and clear of chrome.
    _thoughtBoundsViolationArea(body, viewWorld, reservedWorld) {
        let penalty = 0;
        if (viewWorld) {
            const viewRect = {
                x: viewWorld.left,
                y: viewWorld.top,
                w: Math.max(0, viewWorld.right - viewWorld.left),
                h: Math.max(0, viewWorld.bottom - viewWorld.top),
            };
            const inside = rectIntersectionArea(body, viewRect);
            const total = Math.max(0, body.w * body.h);
            if (inside < total) penalty += total - inside;
        }
        if (reservedWorld?.length) {
            for (const chrome of reservedWorld) penalty += rectIntersectionArea(body, chrome);
        }
        return penalty;
    }

    _thoughtRectHits(rect, grid, occupied, useSpatialGrid) {
        return useSpatialGrid ? this._rectGridHasOverlap(grid, rect) : this._rectListHasOverlap(occupied, rect);
    }

    _thoughtRectsCollide(rects, grid, occupied, useSpatialGrid) {
        if (this._thoughtRectHits(rects.body, grid, occupied, useSpatialGrid)) return true;
        if (rects.leader && this._thoughtRectHits(rects.v, grid, occupied, useSpatialGrid)) return true;
        return rects.horizontal && this._thoughtRectHits(rects.h, grid, occupied, useSpatialGrid);
    }

    _thoughtOverlapArea(rects, grid, occupied, useSpatialGrid) {
        let area = this._rectOverlapArea(rects.body, grid, occupied, useSpatialGrid);
        if (rects.leader) area += this._rectOverlapArea(rects.v, grid, occupied, useSpatialGrid);
        if (rects.horizontal) area += this._rectOverlapArea(rects.h, grid, occupied, useSpatialGrid);
        return area;
    }

    _rectOverlapArea(rect, grid, occupied, useSpatialGrid) {
        let area = 0;
        if (!useSpatialGrid) {
            for (const item of occupied) area += rectIntersectionArea(rect, item.rect || item);
            return area;
        }
        const seen = grid.seen;
        seen.clear();
        const size = grid.cellSize;
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        for (let x = Math.floor(rect.x / size); x <= x1; x++) {
            for (let y = Math.floor(rect.y / size); y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    area += rectIntersectionArea(rect, item.rect || item);
                }
            }
        }
        return area;
    }

    // False when no candidate is free and the speaker may not overlap: only a
    // focused speaker falls back to the least-overlapping candidate.
    _placeThought(
        sprite,
        s,
        now,
        grid,
        occupied,
        useSpatialGrid,
        mayOverlap = true,
        viewWorld = null,
        reservedWorld = null,
    ) {
        const stickyKey = (sprite.selected ? 1 : 0) | (sprite.bubbleOccluded ? 2 : 0);
        if (sprite._bubbleStickyKey !== stickyKey) {
            sprite._bubbleStickyKey = stickyKey;
            sprite._bubbleCandidate = null;
            sprite._bubbleClamped = false;
        }
        const committed = sprite._bubbleCandidate ?? null;
        const wasClamped = Boolean(sprite._bubbleClamped);
        let chosen = -1;
        let chosenClampX = 0;
        const candidateFree = (rects) => !this._thoughtRectsCollide(rects, grid, occupied, useSpatialGrid)
            && this._thoughtBoundsViolationArea(rects.body, viewWorld, reservedWorld) === 0;
        if (committed !== null) {
            const committedClampX = wasClamped && viewWorld ? this._thoughtClampX(sprite, committed, s, viewWorld) : 0;
            const committedRects = this._thoughtCandidateRects(sprite, committed, s, committedClampX);
            const outOfBounds = this._thoughtBoundsViolationArea(committedRects.body, viewWorld, reservedWorld) > 0;
            if (!outOfBounds) {
                const blocked = this._thoughtRectsCollide(committedRects, grid, occupied, useSpatialGrid);
                if (!blocked) {
                    chosen = committed;
                    chosenClampX = committedClampX;
                    sprite._bubbleBlockedSince = 0;
                } else {
                    if (!sprite._bubbleBlockedSince) sprite._bubbleBlockedSince = now;
                    // A brief crossing holds the column still.
                    if (now - sprite._bubbleBlockedSince < THOUGHT_RESEARCH_MS) {
                        chosen = committed;
                        chosenClampX = committedClampX;
                    }
                }
            }
            // A cheaper unclamped candidate that has stayed free long enough wins back.
            const returnLimit = wasClamped ? THOUGHT_CANDIDATE_COUNT : committed;
            if (chosen === committed && returnLimit > 0 && !sprite._bubbleBlockedSince) {
                let better = -1;
                for (let index = 0; index < returnLimit; index++) {
                    if (!candidateFree(this._thoughtCandidateRects(sprite, index, s, 0))) continue;
                    better = index;
                    break;
                }
                if (better < 0) sprite._bubbleBetterSince = 0;
                else if (!sprite._bubbleBetterSince) sprite._bubbleBetterSince = now;
                else if (now - sprite._bubbleBetterSince >= THOUGHT_RETURN_MS) {
                    chosen = better;
                    chosenClampX = 0;
                }
            }
        }
        if (chosen < 0) {
            let leastScore = Infinity;
            let least = 0;
            let leastClampX = 0;
            // Pass 1: unclamped candidates (home first, then inward lateral
            // slots because outward slots fail viewport bounds).
            for (let index = 0; index < THOUGHT_CANDIDATE_COUNT; index++) {
                const rects = this._thoughtCandidateRects(sprite, index, s, 0);
                if (candidateFree(rects)) {
                    chosen = index;
                    chosenClampX = 0;
                    break;
                }
                if (!mayOverlap) continue;
                const overlap = this._thoughtOverlapArea(rects, grid, occupied, useSpatialGrid);
                const bounds = this._thoughtBoundsViolationArea(rects.body, viewWorld, reservedWorld);
                const score = overlap + bounds * 1000;
                if (score < leastScore) {
                    leastScore = score;
                    least = index;
                    leastClampX = 0;
                }
            }
            // Pass 2: if no unclamped slot stays inside the viewport, clamp
            // horizontally while keeping the leader anchored to the speaker.
            if (chosen < 0 && viewWorld) {
                for (let index = 0; index < THOUGHT_CANDIDATE_COUNT; index++) {
                    const clampX = this._thoughtClampX(sprite, index, s, viewWorld);
                    if (clampX === 0) continue;
                    const rects = this._thoughtCandidateRects(sprite, index, s, clampX);
                    if (candidateFree(rects)) {
                        chosen = index;
                        chosenClampX = clampX;
                        break;
                    }
                    if (!mayOverlap) continue;
                    const overlap = this._thoughtOverlapArea(rects, grid, occupied, useSpatialGrid);
                    const bounds = this._thoughtBoundsViolationArea(rects.body, viewWorld, reservedWorld);
                    const score = overlap + bounds * 1000;
                    if (score < leastScore) {
                        leastScore = score;
                        least = index;
                        leastClampX = clampX;
                    }
                }
            }
            if (chosen < 0) {
                if (!mayOverlap) return false;
                chosen = least;
                chosenClampX = leastClampX;
            }
        }
        if (chosen !== committed || (chosenClampX !== 0) !== wasClamped) {
            sprite._bubbleBlockedSince = 0;
            sprite._bubbleBetterSince = 0;
        }
        sprite._bubbleCandidate = chosen;
        sprite._bubbleClamped = chosenClampX !== 0;
        sprite.bubbleClampX = chosenClampX;
        const rects = this._thoughtCandidateRects(sprite, chosen, s, chosenClampX);
        if (useSpatialGrid) {
            this._insertRectGridItem(grid, rects.body);
            if (rects.leader) this._insertRectGridItem(grid, rects.v);
            if (rects.horizontal) this._insertRectGridItem(grid, rects.h);
        } else {
            occupied.push(rects.body);
            if (rects.leader) occupied.push(rects.v);
            if (rects.horizontal) occupied.push(rects.h);
        }
        // Telemetry samples these: they change only with the committed placement.
        sprite.bubbleSlot = THOUGHT_CANDIDATE_SLOT[chosen];
        sprite.bubbleLateral = THOUGHT_CANDIDATE_LATERAL[chosen] * (sprite._thoughtSide || 1);
        return true;
    }

    // 3.8 — identical-bubble merge. Within one bubble-slot cluster (sprites
    // whose slot-0 bubble rects transitively overlap), agents showing the
    // identical head line collapse into the deterministic-first sprite's
    // bubble, which draws an inline gold ×N (AgentSprite._drawThoughtHead); the others skip
    // their own. Merges never cross cluster boundaries and the representative
    // comes from the stable `order` sort, so membership cannot flicker. Slot
    // assignment above is left untouched: merged members keep their slots, so
    // unmerged neighbours never reshuffle frame to frame.
    _mergeIdenticalClusterBubbles(order, baseRects, useSpatialGrid = true) {
        const clusters = this._overlayBubbleClusters;
        const clusterGrid = this._overlayClusterGrid;
        this._beginRectGridFrame(clusterGrid);
        let clusterCount = 0;
        for (let i = 0; i < order.length; i++) {
            const sprite = order[i];
            if (sprite.selected) continue; // selected agents never merge
            const rect = baseRects[i];
            let cluster = useSpatialGrid ? this._firstRectGridOverlap(clusterGrid, rect) : null;
            if (!useSpatialGrid) {
                for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
                    const candidate = clusters[clusterIndex];
                    if (!this._rectsOverlap(rect, candidate.rect)) continue;
                    cluster = candidate;
                    break;
                }
            }
            if (!cluster) {
                cluster = clusters[clusterCount] || {
                    rect: { x: 0, y: 0, w: 0, h: 0 },
                    members: [],
                    order: 0,
                };
                clusters[clusterCount] = cluster;
                cluster.order = clusterCount;
                cluster.rect.x = rect.x;
                cluster.rect.y = rect.y;
                cluster.rect.w = rect.w;
                cluster.rect.h = rect.h;
                cluster.members.length = 0;
                clusterCount++;
            } else {
                // Union rect so transitively-overlapping sprites join one cluster.
                const x1 = Math.max(cluster.rect.x + cluster.rect.w, rect.x + rect.w);
                const y1 = Math.max(cluster.rect.y + cluster.rect.h, rect.y + rect.h);
                cluster.rect.x = Math.min(cluster.rect.x, rect.x);
                cluster.rect.y = Math.min(cluster.rect.y, rect.y);
                cluster.rect.w = x1 - cluster.rect.x;
                cluster.rect.h = y1 - cluster.rect.y;
            }
            cluster.members.push(sprite);
            // A union can enter new cells. Old bucket references are harmless;
            // overlap is always rechecked against the current union rect.
            if (useSpatialGrid) this._insertRectGridItem(clusterGrid, cluster.rect, cluster);
        }
        for (let i = clusterCount; i < this._overlayBubbleClusterCount; i++) {
            clusters[i].members.length = 0;
        }
        this._overlayBubbleClusterCount = clusterCount;
        const groups = this._overlayBubbleGroups;
        for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
            const cluster = clusters[clusterIndex];
            if (cluster.members.length < 2) continue;
            groups.clear();
            for (const sprite of cluster.members) {
                const key = this._bubbleMergeKey(sprite);
                if (!key) continue;
                const representative = groups.get(key);
                if (!representative) {
                    groups.set(key, sprite);
                    continue;
                }
                representative.bubbleMergedCount++;
                sprite.bubbleMergedInto = representative;
            }
            this._foldRoutineClusterNames(cluster);
        }
        groups.clear();
    }

    // F5 — under annotation pressure, a slot-0 crowd delegates routine
    // identities to the occupancy chip on the building they are visiting.
    // Primary and recent agents remain named; selection/hover therefore also
    // expands an individual immediately. Calm (`full`) scenes keep every name.
    _foldRoutineClusterNames(cluster) {
        if (!this._annotationMode || this._annotationMode === 'full' || cluster.members.length <= 5) return;
        for (const sprite of cluster.members) {
            if (!this._isRoutineFoldCandidate(sprite)) continue;
            const buildingType = sprite._foldBuildingType;
            if (!buildingType) continue;
            let building = null;
            for (const candidate of this.buildingRenderer?.buildings || []) {
                if (candidate.type !== buildingType) continue;
                building = candidate;
                break;
            }
            const occupancy = building
                ? this.buildingRenderer?._buildingOccupancyInfo?.(building)
                : null;
            if (!occupancy || occupancy.count <= 0) continue;
            sprite.foldedIntoBuilding = true;
            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;
            // Canvas labels are invoked from AgentSprite even without a slot;
            // zero alpha suppresses that fallback. The GPU overlay admits
            // routine labels only when a slot survives.
            sprite.labelAlpha = 0;
        }
    }

    _isRoutineFoldCandidate(sprite) {
        if (!sprite || sprite.selected || sprite.hovered || sprite.agent?.userNamed) return false;
        const status = sprite.agent?.status;
        if ([AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status)) {
            return false;
        }
        const spawnAge = performance.now() - (sprite.addedAt || 0);
        // A burst must not grant twelve seconds of overlapping names to the whole crowd.
        if (this.agentSprites.size < 24 && spawnAge >= 0 && spawnAge < 12000) return false;
        return true;
    }

    // W3.7 — merge identity is everything the column will draw: every row's
    // text, accent, confidence, shape and provenance badge, plus the
    // attribution (repo chip accent, speaker tag) and whether the column is
    // lifted over a roof. Two speakers whose older lines differ never merge,
    // so no thread is lost. The long-wait clock has no ×N path and never merges.
    _bubbleMergeKey(sprite) {
        if (sprite._statusClock) return null;
        const thread = sprite._statusThread;
        if (!thread?.length) return null;
        const fallback = sprite._statusVisual?.()?.color || '';
        const trim = sprite._providerTrimColor?.() || '';
        let key = `${sprite.thoughtRepoAccent?.() || ''}|${sprite.thoughtSpeakerTag?.() || ''}|${sprite.bubbleOccluded ? 1 : 0}`;
        const rows = Math.min(thread.length, (sprite._thoughtHistoryLimit ?? THOUGHT_HISTORY_LIMIT) + 1);
        for (let i = 0; i < rows; i++) {
            const entry = thread[i];
            const accent = entry.accent || (i === 0 ? fallback : trim);
            key += `|${entry.text}|${accent}|${entry.confidence ?? ''}|${entry.shape || ''}|${entry.badge || ''}`;
        }
        return key;
    }

    _spriteWantsBubble(sprite) {
        if (!sprite || sprite.chatting) return false;
        if (sprite.isArrivalPending?.()) return false;
        // T1 — an action-needed agent's head space belongs to its beacon and
        // attention plate; the Activity Panel carries its words.
        if (isAttentionStatus(sprite.agent?.status)) return false;
        // A silent villager draws nothing, so it must not reserve a slot and
        // push a speaking neighbour into a higher one. Reads the snapshot the
        // sprite already computed rather than rebuilding its activity thread.
        const hasSpeech = sprite._activitySnapshot?.text
            && (!sprite._activityBubbleVisible || sprite._activityBubbleVisible());
        if (!hasSpeech && !sprite._shouldUseLongWaitClock?.()) return false;
        return true;
    }

    // Routine-name admission order: a recent tool change or a fresh arrival
    // earns the slot first, then ordinary work, then everyone else.
    _agentLabelPriority(sprite, now = performance.now()) {
        if (sprite.selected) return 1000;
        // Operator-named sessions claim their name space before routine ones.
        if (sprite.agent?.userNamed) return 900;
        const status = sprite.agent?.status;
        const age = now - (sprite.addedAt || 0);
        const recentSpawn = age >= 0 && age < 12000;
        const toolAge = now - (sprite._labelToolChangedAt || -Infinity);
        const recentTool = toolAge >= 0 && toolAge < LABEL_TOOL_CHANGE_MS;
        if (status === AgentStatus.WORKING && (recentSpawn || recentTool)) return 760;
        if (recentSpawn || recentTool) return 620;
        if (status === AgentStatus.WORKING) return 520;
        if (status === AgentStatus.WAITING) return 360;
        return 120;
    }

    _noteLabelToolChange(sprite, now = performance.now()) {
        const tool = sprite.agent?.currentTool || '';
        if (sprite._labelToolKey === tool) return;
        // The first observation is not a change: an agent that was already
        // mid-tool when it came into view has no claim on "recent".
        if (sprite._labelToolKey !== undefined && tool) sprite._labelToolChangedAt = now;
        sprite._labelToolKey = tool;
    }

    // Every drawn identity label (T2 plate or T4 name), in world units, so the
    // building plaques step aside from them — and, one frame on, the ledgers
    // and landmark chits drawn in the depth pass (S12).
    _collectAgentLabelHitRects(sprites) {
        const out = this._agentLabelHitRects;
        out.length = 0;
        for (const sprite of sprites) {
            if (!sprite.agent) continue;
            if (sprite.overlaySlot != null) out.push(this._agentIdentityRect(sprite, sprite.overlaySlot || 0));
            if (sprite.bubbleSlot != null && !sprite.bubbleMergedInto && sprite._thoughtRects?.body?.w > 0) {
                out.push(sprite._thoughtRects.body);
            }
            // VQ-14 — a T1 body is as hard an obstacle as its plate: a plaque
            // steps aside (or stands down) rather than cover the pose the
            // plate points at (the HARBOR plaque over the Pharos lookout).
            const box = sprite._bodyBox;
            if (!box || !isAttentionStatus(sprite.agent.status)) continue;
            const x = sprite._placeX ?? sprite.x;
            const y = sprite._visualAnchorY?.() ?? sprite.y;
            out.push({ x: x + box.left, y: y + box.top, w: box.right - box.left, h: box.bottom - box.top });
        }
        for (const rect of this._attentionWorldRects) out.push(rect);
        if (this.buildingRenderer) this.buildingRenderer.identityWorldRects = out;
        return out;
    }

    _agentIdentityText(sprite) {
        const baseName = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        if (sprite.labelPlate) return sprite.nickname ? `${baseName} ${sprite.nickname}` : baseName;
        return sprite.readVerb || baseName;
    }

    // World rect of the T2 plate or T4 name under the feet (screen-fixed
    // pixels divided back into the world), matching AgentSprite's paint.
    _agentIdentityRect(sprite, slot = 0) {
        const zoom = this.camera?.zoom || 1;
        const s = 1 / zoom;
        const plate = Boolean(sprite.labelPlate);
        const width = identityLabelWidth(this._agentIdentityText(sprite), { plate });
        const height = plate ? IDENTITY_LABEL.plateHeight : IDENTITY_LABEL.textHeight;
        const labelTop = typeof sprite.identityLabelTopPx === 'function'
            ? sprite.identityLabelTopPx(zoom)
            : identityLabelTop(zoom);
        const shiftX = plate ? Math.round(sprite.labelShiftX || 0) : 0;
        const top = labelTop + (plate ? Math.round(sprite.labelShiftY || 0) : 0) + slot * IDENTITY_LABEL.slotStep;
        const pad = 2;
        return {
            x: sprite.x + (shiftX - width / 2 - pad) * s,
            y: sprite.y + (top - pad) * s,
            w: (width + pad * 2) * s,
            h: (height + pad * 2) * s,
            slot,
        };
    }

    // S13 — the T2 plate stays inside the visible canvas: a body at the edge
    // keeps its plate whole (shifted along the edge), never cut by the frame
    // or the Activity Panel beside it. Screen px, applied by AgentSprite.
    // Returns false when no part of the body is in the canvas: a plate held
    // at the edge for an unseen body would be an orphan.
    _clampIdentityPlate(sprite, viewport, zoom) {
        if (!this.camera?.worldToScreen || !viewport?.width) return true;
        const point = this.camera.worldToScreen(sprite.x, sprite.y);
        const box = sprite._bodyBox;
        const bodyLeft = point.x + (box ? box.left : -12) * zoom;
        const bodyRight = point.x + (box ? box.right : 12) * zoom;
        const bodyTop = point.y + (box ? box.top : -48) * zoom;
        const bodyBottom = point.y + (box ? box.bottom : 0) * zoom;
        if (bodyRight <= 0 || bodyLeft >= viewport.width || bodyBottom <= 0 || bodyTop >= viewport.height) return false;
        const width = identityLabelWidth(this._agentIdentityText(sprite), { plate: true });
        const top = point.y + (typeof sprite.identityLabelTopPx === 'function' ? sprite.identityLabelTopPx(zoom) : identityLabelTop(zoom));
        const left = point.x - Math.round(width / 2);
        const margin = 4;
        let shiftX = 0;
        if (left < margin) shiftX = margin - left;
        else if (left + width > viewport.width - margin) shiftX = viewport.width - margin - (left + width);
        let shiftY = 0;
        const bottom = top + IDENTITY_LABEL.plateHeight;
        if (bottom > viewport.height - margin) shiftY = viewport.height - margin - bottom;
        sprite.labelShiftX = Math.round(shiftX);
        sprite.labelShiftY = Math.round(shiftY);
        return true;
    }

    // True when a T4 name rect (world units) crosses the drawn body of any
    // other visible villager.
    _nameRectHitsOtherBody(rect, owner, sprites) {
        for (const other of sprites) {
            if (other === owner) continue;
            const box = other._bodyBox;
            if (!box) continue;
            const left = other.x + box.left;
            const top = other.y + box.top;
            if (rect.x < left + (box.right - box.left)
                && rect.x + rect.w > left
                && rect.y < top + (box.bottom - box.top)
                && rect.y + rect.h > top) return true;
        }
        return false;
    }

    // 3.4 — coarse world-space index over static prop footprints (trees,
    // boulders, district props), keyed by NAME_SLOT_PROP_CELL cells. Built once
    // at init: props never move, so the name-tag slot clamp pays only a few
    // cell lookups per candidate rect instead of scanning every prop per frame.
    // A prop's "footprint" here is its occlusion FRONT band (splitY..bottom):
    // the only part that can draw over an agent's name tag. Full bounds would
    // blanket whole districts (wall segments span hundreds of world px).
    _buildPropFootprintIndex(props) {
        const index = new Map();
        for (const prop of props || []) {
            const bounds = prop?.bounds;
            if (!bounds) continue;
            const bandTop = Number.isFinite(bounds.splitY) ? bounds.splitY : bounds.bottom - 14;
            const rect = {
                x: prop.x + bounds.left,
                y: prop.y + bandTop,
                w: bounds.right - bounds.left,
                h: bounds.bottom - bandTop,
                // Occlusion front parts sort at prop.y; only props in front of
                // the agent can cover its tag (see _nameSlotRectHitsProp).
                baseY: prop.y,
            };
            if (rect.w <= 0 || rect.h <= 0) continue;
            const x0 = Math.floor(rect.x / NAME_SLOT_PROP_CELL);
            const x1 = Math.floor((rect.x + rect.w) / NAME_SLOT_PROP_CELL);
            const y0 = Math.floor(rect.y / NAME_SLOT_PROP_CELL);
            const y1 = Math.floor((rect.y + rect.h) / NAME_SLOT_PROP_CELL);
            for (let cx = x0; cx <= x1; cx++) {
                for (let cy = y0; cy <= y1; cy++) {
                    const key = `${cx},${cy}`;
                    let bucket = index.get(key);
                    if (!bucket) {
                        bucket = [];
                        index.set(key, bucket);
                    }
                    bucket.push(rect);
                }
            }
        }
        return index;
    }

    // True when a candidate name-tag rect overlaps the front band of a static
    // prop that draws IN FRONT of the agent (baseY > spriteY, matching the
    // depth sort). Props behind the agent draw under the tag and stay allowed.
    _nameSlotRectHitsProp(rect, spriteY) {
        const index = this._propFootprintIndex;
        if (!index || !index.size) return false;
        const x0 = Math.floor(rect.x / NAME_SLOT_PROP_CELL);
        const x1 = Math.floor((rect.x + rect.w) / NAME_SLOT_PROP_CELL);
        const y0 = Math.floor(rect.y / NAME_SLOT_PROP_CELL);
        const y1 = Math.floor((rect.y + rect.h) / NAME_SLOT_PROP_CELL);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = index.get(`${cx},${cy}`);
                if (!bucket) continue;
                for (const propRect of bucket) {
                    if (propRect.baseY <= spriteY) continue;
                    if (this._rectsOverlap(rect, propRect)) return true;
                }
            }
        }
        return false;
    }

    _rectsOverlap(a, b) {
        return a.x < b.x + b.w
            && a.x + a.w > b.x
            && a.y < b.y + b.h
            && a.y + a.h > b.y;
    }

    _drawTerrain(ctx, profileMark = null) {
        SpriteRenderer.disableSmoothing(ctx);
        const cached = this._getTerrainCache();
        if (cached) {
            ctx.drawImage(cached.canvas, cached.bounds.x, cached.bounds.y, cached.bounds.w, cached.bounds.h);
        } else {
            this._drawStaticTerrainSurface(ctx);
        }
        // SD-3 — the sun's lift on the bare terrain, before anything lies on it.
        drawSunLift(ctx);
        profileMark?.('terrain-surface');
        this._drawDynamicWaterHighlights(ctx);
        profileMark?.('water-highlights');
        this._drawWeatherPuddles(ctx);
        profileMark?.('weather-puddles');
        this._drawSurfaceWetnessMarks(ctx, 'ground');
        profileMark?.('surface-wetness');
    }

    _getVisibleTileBounds(margin = 5) {
        return this.camera.getViewportTileBounds(margin);
    }

    // Season token for the live atmosphere, using SeasonalAmbience's shared
    // month→season mapping so the baked ground and the drift particles agree.
    _currentSeasonToken() {
        const atmosphere = this._lastAtmosphere ?? this.atmosphereState?.snapshot?.() ?? null;
        return seasonTokenForAtmosphere(atmosphere) || 'summer';
    }

    // BI-2 — the woods' weekly stage for the same date (a frozen
    // PHENOLOGY_STAGES row; summer without one): the canopies and the
    // ground's leaf litter follow it.
    _currentPhenology() {
        return phenologyForAtmosphere(this._lastAtmosphere ?? this.atmosphereState?.snapshot?.() ?? null);
    }

    // C2 — screen-space spawn anchors for SeasonalAmbience drift. 'canopy'
    // returns visible tree-canopy tops (leaves/petals fall from them), 'flower'
    // returns visible flower tiles (butterflies rise from them). Memoized per
    // frame (keyed on waterFrame) so ~4 spawns/s don't re-scan the scenery each
    // time. Returns [] when nothing of that kind is on screen → the caller falls
    // back to viewport-random spawning.
    _seasonalDriftAnchors(kind) {
        const frameToken = this.waterFrame;
        if (this._driftAnchorFrame !== frameToken || !this._driftAnchorCache) {
            this._driftAnchorFrame = frameToken;
            this._driftAnchorCache = { canopy: null, flower: null };
        }
        const cache = this._driftAnchorCache;
        if (cache[kind]) return cache[kind];
        const points = kind === 'flower'
            ? this._collectFlowerAnchors()
            : this._collectCanopyAnchors();
        cache[kind] = points;
        return points;
    }

    _collectCanopyAnchors() {
        const out = [];
        const camera = this.camera;
        if (!camera) return out;
        const vp = this._screenViewport();
        const zoom = camera.zoom || 1;
        for (const tree of this.treePropSprites || []) {
            const wx = (tree.tileX - tree.tileY) * TILE_WIDTH / 2;
            const wy = (tree.tileX + tree.tileY) * TILE_HEIGHT / 2;
            const p = camera.worldToScreen(wx, wy);
            if (p.x < -20 || p.y < -20 || p.x > vp.width + 20 || p.y > vp.height + 20) continue;
            // Up onto the canopy: 60 % of the sprite's height (30 texels on a
            // 51-px oak, the crown of a tall woodland tree, plan 5.5); `lift`
            // is that height in world px, down to the tree's ground line.
            const lift = Math.round(-(tree.bounds?.top ?? -50) * 0.6);
            out.push({ x: p.x, y: p.y - lift * zoom, lift });
            if (out.length >= 48) break;
        }
        return out;
    }

    _collectFlowerAnchors() {
        const out = [];
        const camera = this.camera;
        if (!camera || !this.flowerTiles) return out;
        const vp = this._screenViewport();
        for (const key of this.flowerTiles.keys()) {
            const comma = key.indexOf(',');
            if (comma < 0) continue;
            const tileX = Number(key.slice(0, comma));
            const tileY = Number(key.slice(comma + 1));
            const wx = (tileX - tileY) * TILE_WIDTH / 2;
            const wy = (tileX + tileY) * TILE_HEIGHT / 2;
            const p = camera.worldToScreen(wx, wy);
            if (p.x < -20 || p.y < -20 || p.x > vp.width + 20 || p.y > vp.height + 20) continue;
            out.push({ x: p.x, y: p.y - 6 });
            if (out.length >= 48) break;
        }
        return out;
    }

    // B.2 — `allowResident` (the resident GPU path): once the GPU holds this
    // bake's texture the CPU canvas is released (`releaseTerrainCanvas`) and a
    // same-size GPU-resident stand-in answers instead. The Canvas path, a lost
    // context or an evicted texture re-bakes the canvas synchronously (the
    // coast passes dominate; ~285 ms was measured on a loaded host), so the
    // canvas stays while a WebGPU switch is pending (`releaseTerrainCanvas`).
    _getTerrainCache({ allowResident = false, prepareCold = false } = {}) {
        const bounds = this._terrainCacheBounds();
        const meta = this._getTerrainCacheMeta(bounds);
        if (!meta.singleSurfaceWithinBudget) {
            this._releaseTerrainArtifactWork();
            releaseCanvasBackingStore(this.terrainCache);
            this.terrainCache = null;
            this.terrainCacheKey = '';
            this._cancelTerrainRestage();
            this._emitTerrainCacheLimitWarning(meta);
            return null;
        }
        const dpr = 1;
        // C1 — a season token keyed into the cache so the ground decals rebake
        // only when the season actually changes (four discrete values), never
        // per frame. Stored for the GroundBake decals to branch on; the tree
        // canopies (5.1) drop their images once when it changes.
        const season = this._currentSeasonToken();
        this._terrainSeason = season;
        // BI-2 — the weekly stage keys the bake (the water reflections mirror
        // the canopies, GroundBake's litter reads it), and the canopies
        // rebuild once when it changes.
        this._terrainPhenology = this._currentPhenology();
        this.foliageRenderer.setSeason(season, this._terrainPhenology);
        const key = this._terrainBakeKey(bounds, dpr, season);
        // EY-5 — a restage for another key (the clock scrubbed back to the
        // shown stage) never outlives the return to it.
        if (this._terrainRestage && this._terrainRestage.key !== key) this._cancelTerrainRestage();
        if (this.terrainCache && this.terrainCacheKey === key) {
            return { canvas: this.terrainCache, bounds };
        }
        if (allowResident && this._terrainResident?.key === key) {
            return { canvas: this._terrainResident, bounds, resident: true };
        }
        const staged = !prepareCold && !this._forceFreshGpuOutput && this._stageTerrainOffFrame(key, bounds, dpr, season, allowResident);
        if (staged) return staged;
        this._terrainResident = null;
        const ready = this._terrainArtifactRead?.ready;
        if (ready?.key && ready.key === this._persistedTerrainKey(bounds, dpr, season)) {
            this._cancelTerrainRestage();
            this._discardTerrainArtifactWrite();
            releaseCanvasBackingStore(this.terrainCache);
            Object.assign(this, ready.host);
            this.terrainCache = ready.canvas;
            this.terrainCacheBounds = bounds;
            this.terrainCacheKey = key;
            this.terrainCacheBaseKey = this._terrainBakeKey(bounds, dpr, season, false);
            this._terrainArtifactRead = null;
            this._terrainArtifactStats.hits++;
            this._terrainArtifactStats.state = 'hit';
            return { canvas: this.terrainCache, bounds };
        }
        if (prepareCold) {
            const job = this._terrainRestage ||= { key, bounds, dpr, season, fields: {}, cold: true };
            this._stepTerrainRestage(job);
            return this.terrainCache ? { canvas: this.terrainCache, bounds } : null;
        }
        // Capture and recovery callers need a complete canvas before returning.
        this._discardTerrainArtifactRead();
        this._discardTerrainArtifactWrite();
        this._cancelTerrainRestage();

        releaseCanvasBackingStore(this.terrainCache);

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bounds.w * dpr));
        canvas.height = Math.max(1, Math.round(bounds.h * dpr));
        const cacheCtx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(cacheCtx);
        cacheCtx.setTransform(dpr, 0, 0, dpr, -bounds.x * dpr, -bounds.y * dpr);

        this._drawStaticTerrainSurface(cacheCtx);

        this.terrainCache = canvas;
        this.terrainCacheBounds = bounds;
        this.terrainCacheKey = key;
        this.terrainCacheBaseKey = this._terrainBakeKey(bounds, dpr, season, false);
        this._landTerrainBake(cacheCtx, canvas, bounds, dpr, season);
        return { canvas, bounds };
    }

    _landTerrainBake(cacheCtx, canvas, bounds, dpr, season) {
        this._terrainArtifactStats.bakes++;
        this._terrainArtifactStats.misses++;
        this._terrainArtifactStats.state = 'baked';
        if (this._terrainSpritesLanded(cacheCtx, bounds)) {
            this._queueTerrainArtifactWrite(canvas, bounds, dpr, season);
        } else {
            this._terrainArtifactStats.state = 'unlanded';
            this._retryTerrainBake();
        }
    }

    // EY-5 — a change of the winter ground's stage alone (a snow bucket, a
    // frost quarter rising or melting: the passes' `baseRevision` keys are
    // unchanged) never bakes in the frame once the World has presented. The
    // current terrain keeps presenting while the next one is prepared in idle
    // slices (each pass's `prepare` stepper, then one surface step per
    // slice) and swapped in whole; a stage that moved on meanwhile is dropped
    // and prepared again. Anything else, a missing surface or a ready artifact
    // takes the synchronous bake as before.
    _stageTerrainOffFrame(key, bounds, dpr, season, allowResident) {
        const presented = this.terrainCache ? { canvas: this.terrainCache, bounds: this.terrainCacheBounds || bounds }
            : allowResident && this._terrainResident ? { canvas: this._terrainResident, bounds, resident: true } : null;
        if (!presented || !this._worldFramePresented || this._terrainArtifactRead?.ready
            || this.terrainCacheBaseKey !== this._terrainBakeKey(bounds, dpr, season, false)) {
            this._cancelTerrainRestage();
            return null;
        }
        if (this._terrainRestage?.key !== key) {
            this._cancelTerrainRestage();
            const job = { key, bounds: { ...bounds }, dpr, season, prepare: null, steps: null, canvas: null, ctx: null, fields: {} };
            this._terrainRestage = job;
            whenIdle(() => this._stepTerrainRestage(job));
        }
        return presented;
    }

    _cancelTerrainRestage() {
        const job = this._terrainRestage;
        if (!job) return;
        this._terrainRestage = null;
        releaseCanvasBackingStore(job.canvas);
    }

    // One idle slice of a restage: one prepare band or one surface step. The
    // passes' renderer fields (TERRAIN_STAGED_FIELDS) stay the job's own
    // between slices and publish with its canvas, so frames in between draw
    // the shown terrain with its own water and ground fields. A slice first
    // checks the job still matches the wanted terrain.
    _stepTerrainRestage(job) {
        if (this._terrainRestage !== job || this._disposed) return;
        if (this._terrainBakeKey(job.bounds, job.dpr, this._currentSeasonToken()) !== job.key) {
            this._cancelTerrainRestage();
            this._invalidateIdleFrame?.();
            return;
        }
        const previousMotionScale = this.motionScale;
        const live = {};
        for (const field of TERRAIN_STAGED_FIELDS) {
            live[field] = this[field];
            if (field in job.fields) this[field] = job.fields[field];
        }
        try {
            this.motionScale = 0;
            if (!job.prepare) {
                job.prepare = (this._terrainBakePasses || []).map(pass => pass.prepare?.(this)).filter(Boolean);
            } else if (job.prepare.length) {
                if (job.prepare[0]()) job.prepare.shift();
            } else if (!job.steps) {
                const { bounds, dpr } = job;
                job.canvas = document.createElement('canvas');
                job.canvas.width = Math.max(1, Math.round(bounds.w * dpr));
                job.canvas.height = Math.max(1, Math.round(bounds.h * dpr));
                job.ctx = job.canvas.getContext('2d');
                SpriteRenderer.disableSmoothing(job.ctx);
                job.ctx.setTransform(dpr, 0, 0, dpr, -bounds.x * dpr, -bounds.y * dpr);
                job.steps = this._terrainSurfaceSteps(job.ctx);
            } else if (job.steps.length) {
                job.steps.shift()();
            }
        } finally {
            this.motionScale = previousMotionScale;
            for (const field of TERRAIN_STAGED_FIELDS) {
                if (field in job.fields || this[field] !== live[field]) job.fields[field] = this[field];
                this[field] = live[field];
            }
        }
        if (!job.steps || job.steps.length) {
            if (!job.cold) whenIdle(() => this._stepTerrainRestage(job));
            return;
        }
        this._terrainRestage = null;
        if (this._terrainBakeKey(job.bounds, job.dpr, this._currentSeasonToken()) !== job.key) {
            releaseCanvasBackingStore(job.canvas);
            this._invalidateIdleFrame?.();
            return;
        }
        Object.assign(this, job.fields);
        this._discardTerrainArtifactRead();
        this._discardTerrainArtifactWrite();
        releaseCanvasBackingStore(this.terrainCache);
        this._terrainResident = null;
        this.terrainCache = job.canvas;
        this.terrainCacheBounds = job.bounds;
        this.terrainCacheKey = job.key;
        this.terrainCacheBaseKey = this._terrainBakeKey(job.bounds, job.dpr, job.season, false);
        if (!job.cold) this._terrainRestages = (this._terrainRestages || 0) + 1;
        this._landTerrainBake(job.ctx, job.canvas, job.bounds, job.dpr, job.season);
        this._invalidateIdleFrame?.();
    }

    // Did the bake's sprite layers land? Each landmark bridge and baked
    // district prop (the farm among them) must read back its opaque centre
    // texel as drawn. A failed bake lost all of them at once (CoastBake
    // `paintCoast`), so half the probes passing is enough: a later sprite or
    // contact shadow may cover an earlier one's texel. Nothing to probe
    // passes. The bake is one texel per world pixel.
    _terrainSpritesLanded(ctx, bounds) {
        const sprites = [];
        for (const span of this.bridgeSpans || []) {
            const placement = this._bridgeSpritePlacement(span);
            if (placement) sprites.push(placement);
        }
        for (const prop of DISTRICT_PROPS) {
            if (prop.layer !== 'cache') continue;
            const img = this.propWinter?.image(prop.id) || this.assets?.get?.(prop.id);
            if (!img) continue;
            const [anchorX, anchorY] = this.assets.getAnchor(prop.id);
            const { x, y } = tileToWorldElevated(prop.tileX, prop.tileY);
            sprites.push({
                img, x: Math.round(x - anchorX), y: Math.round(y - anchorY),
            });
        }
        let probed = 0;
        let landed = 0;
        for (const { img, x, y } of sprites) {
            const texel = opaqueCentreTexel(img);
            if (!texel) continue;
            probed++;
            const [r, g, b] = ctx.getImageData(x + texel.x - bounds.x, y + texel.y - bounds.y, 1, 1).data;
            if (Math.abs(r - texel.rgb[0]) + Math.abs(g - texel.rgb[1]) + Math.abs(b - texel.rgb[2]) <= 12) landed++;
        }
        return landed * 2 >= probed;
    }

    // Rebake once TERRAIN_BAKE_RETRY_MS has passed: the retry count keys the
    // bake (`_terrainBakeKey`), so the next frame bakes and re-uploads it.
    _retryTerrainBake() {
        console.warn(`[IsometricRenderer] terrain bake lost its sprite layers; not stored, rebaking in ${TERRAIN_BAKE_RETRY_MS / 1000} s`);
        clearTimeout(this._terrainBakeRetryTimer);
        this._terrainBakeRetryTimer = setTimeout(() => {
            if (this._disposed) return;
            this._terrainBakeRetry = (this._terrainBakeRetry || 0) + 1;
            this._invalidateIdleFrame();
        }, TERRAIN_BAKE_RETRY_MS);
    }

    // B.2 — drop the terrain bake's CPU canvas once the GPU holds its upload.
    // Not while a WebGPU switch is compiling or armed: the new world starts
    // without the texture and would re-bake in the swap frame (a visible
    // freeze and a camera step mid-glide); it uploads the kept canvas instead,
    // and the first frame after the swap releases it.
    releaseTerrainCanvas() {
        const canvas = this.terrainCache;
        if (!canvas || this._pendingWebGpu || this._worldSwap) return;
        this._terrainResident = { width: canvas.width, height: canvas.height, gpuResident: true, key: this.terrainCacheKey };
        if (this._terrainArtifactWrite?.canvas === canvas) this._terrainArtifactWrite.ownsCanvas = true;
        else releaseCanvasBackingStore(canvas);
        this.terrainCache = null;
    }

    _persistedTerrainInputs(bounds, dpr, season) {
        const atmosphere = this._lastAtmosphere ?? this.atmosphereState?.snapshot?.();
        const ground = this._groundState ?? groundStateForAtmosphere(atmosphere);
        return { assetVersion: this.assets?.assetVersion, bounds, dpr, season,
            elevationRevision: this.surfaceRegistry?.revision,
            sceneryRevision: this._terrainSceneryRevision || 0,
            substrateRevision: this.gpuWorld?.substrateRevision ?? 0,
            snowBucket: snowBucketOf(ground?.snowCover), frost: frostQuarterOf(ground),
            frostRising: frostRisingOf(ground),
            phenology: phenologyForAtmosphere(atmosphere).id,
            // GW — 'weather' in the key exactly when this backend's bake holds the field.
            groundWeather: groundWeatherWanted(this, frostQuarterOf(ground)) };
    }

    _persistedTerrainKey(bounds, dpr, season) {
        if (!this._terrainArtifactConfigHash || !terrainArtifactInputsSettled(this)) return null;
        return terrainArtifactKey({ ...this._persistedTerrainInputs(bounds, dpr, season), configHash: this._terrainArtifactConfigHash });
    }

    _prepareTerrainArtifactRead() {
        this._terrainArtifactStats ||= { reads: 0, hits: 0, misses: 0, bakes: 0, writes: 0, state: 'unavailable' };
        if (this._disposed || !globalThis.indexedDB || !globalThis.crypto?.subtle) return;
        this._terrainArtifactNeedsRead = false;
        const generation = this._terrainArtifactGeneration || 0;
        this._terrainArtifactConfigPromise ||= Promise.resolve()
            .then(() => terrainContentHash(terrainArtifactConfiguration(this), true)).catch(() => null);
        const boot = this._terrainArtifactBoot;
        this._terrainArtifactBoot = null;
        this._terrainArtifactPreparationPending = true;
        this._terrainArtifactStats.state = 'prefetching';
        const candidate = Promise.resolve(boot).then(early => {
            this._terrainArtifactStore ||= early?.store || new TerrainArtifactStore();
            return early ? early.prefetched : this._terrainArtifactStore.prefetchLatest();
        }).catch(() => null);
        this._terrainArtifactPreparation = Promise.all([this._terrainArtifactConfigPromise, candidate]).then(([configHash, prefetched]) => {
            if (generation !== (this._terrainArtifactGeneration || 0) || this._disposed) return;
            this._terrainArtifactConfigHash = configHash;
            this._terrainArtifactPrefetch = prefetched;
            this._terrainArtifactPreparationPending = false;
            // Later releases already have settled configuration and atmosphere
            // inputs. Verify their candidate while decoded sources reload;
            // publication still requires the frame's settled-source/key gate.
            // Boot has no frame atmosphere yet and never keys on defaults.
            if (this._lastAtmosphere && !this.terrainCache && !this._terrainResident) {
                const bounds = this._terrainCacheBounds();
                const key = terrainArtifactKey({ ...this._persistedTerrainInputs(bounds, 1, this._currentSeasonToken()), configHash });
                if (key && this._getTerrainCacheMeta(bounds).singleSurfaceWithinBudget) this._readTerrainArtifact(key, bounds);
            }
        });
    }

    _readTerrainArtifact(key, bounds) {
        if (!this._terrainArtifactStore || this._terrainArtifactRead?.key === key) return;
        this._discardTerrainArtifactRead();
        const read = this._terrainArtifactRead = { key, ready: null, settled: false };
        const prefetched = this._terrainArtifactPrefetch;
        this._terrainArtifactPrefetch = undefined;
        this._terrainArtifactStats.reads++;
        this._terrainArtifactStats.state = 'reading';
        this._terrainArtifactReadPromise = this._terrainArtifactStore.get(key, prefetched).then(artifact => {
            if (this._terrainArtifactRead !== read || this._disposed) return;
            read.settled = true;
            if (!artifact) { this._terrainArtifactStats.state = 'miss'; return; }
            const current = terrainArtifactKey({ ...this._persistedTerrainInputs(bounds, 1, this._currentSeasonToken()),
                configHash: this._terrainArtifactConfigHash });
            if (current !== key) { this._terrainArtifactStats.state = 'miss'; return; }
            if (artifact.dpr !== 1 || ['x', 'y', 'w', 'h'].some(k => artifact.bounds[k] !== bounds[k])) {
                this._terrainArtifactStore.delete(key);
                return;
            }
            const host = { world: this.world };
            try {
                read.ready = { key, host, canvas: restoreTerrainArtifact(host, artifact) };
                this._terrainArtifactStats.state = 'ready';
            } catch {
                this._terrainArtifactStore.delete(key);
                this._terrainArtifactStats.state = 'miss';
            }
        }).catch(() => {
            if (this._terrainArtifactRead !== read) return;
            read.settled = true;
            this._terrainArtifactStats.state = 'miss';
        });
    }

    _prepareTerrainArtifactFrame(allowWait = false) {
        if (!this._terrainArtifactReadAllowsBake(allowWait)) return false;
        // Hold presentation while the live loop advances one cold-bake slice per frame.
        // Explicit renderNow captures can still finish the surface in their own task.
        if (!this.terrainCache && !this._terrainResident && !this._forceFreshGpuOutput
            && typeof requestAnimationFrame === 'function') {
            if (!this._getTerrainCacheMeta().singleSurfaceWithinBudget) return true;
            return Boolean(this._getTerrainCache({ prepareCold: true }));
        }
        return true;
    }

    _terrainArtifactReadAllowsBake(allowWait) {
        if (this._disposed || !globalThis.indexedDB || !globalThis.crypto?.subtle || !terrainArtifactInputsSettled(this)) return true;
        if (this._terrainArtifactNeedsRead) this._prepareTerrainArtifactRead();
        const bounds = this._terrainCacheBounds();
        if (!this._getTerrainCacheMeta(bounds).singleSurfaceWithinBudget) return true;
        const season = this._currentSeasonToken();
        const bakeKey = this._terrainBakeKey(bounds, 1, season);
        if ((this.terrainCache && this.terrainCacheKey === bakeKey) || this._terrainResident?.key === bakeKey) return true;
        const key = this._persistedTerrainKey(bounds, 1, season);
        const candidate = this._terrainArtifactPrefetch;
        // A known empty/mismatching early lookup never postpones a frame.
        const canWait = allowWait && !this._worldFramePresented
            && candidate !== null && (!key || candidate === undefined || candidate.key === key)
            && (!this._terrainArtifactRead || this._terrainArtifactRead.key === key);
        if (key && !this._terrainArtifactPreparationPending) this._readTerrainArtifact(key, bounds);
        const read = this._terrainArtifactRead;
        if (read?.ready || read?.settled || (!read && !this._terrainArtifactPreparationPending)
            || (!key && !this._terrainArtifactPreparationPending) || !canWait) return true;
        const now = performance.now();
        // Lifetime deadline: changing inputs or restarting a lookup cannot
        // extend the first-frame hold. A timeout bakes in this same frame.
        this._terrainArtifactWaitDeadline ??= now + 250;
        return now >= this._terrainArtifactWaitDeadline;
    }

    _queueTerrainArtifactWrite(canvas, bounds, dpr, season) {
        if (!this._terrainArtifactStore || !terrainArtifactInputsSettled(this)) return;
        // The arrays are immutable once this bake completes. Keep references to
        // this bake, so a later season/revision cannot change the idle snapshot.
        const host = { world: this.world, groundField: this.groundField, groundPuddleMask: this.groundPuddleMask,
            groundBakeMs: this.groundBakeMs, groundWinterBakeMs: this.groundWinterBakeMs,
            _coastField: this._coastField, _coastBake: this._coastBake };
        this._terrainArtifactWrite = { canvas, host, bounds: { ...bounds }, dpr,
            inputs: this._persistedTerrainInputs(bounds, dpr, season), config: this._terrainArtifactConfigPromise,
            ownsCanvas: false, cancelled: false, scheduled: false, artifact: null };
        this._scheduleTerrainArtifactWrite();
    }

    _canPersistTerrainArtifact(write) {
        return this._terrainArtifactWrite === write && !write.cancelled && !this._disposed
            && this._worldModeActive && !this._worldResourcesSuspended
            && !this._firstFrameReason && !this._revealSnapshotPending;
    }

    _scheduleTerrainArtifactWrite() {
        const write = this._terrainArtifactWrite;
        if (!write || write.scheduled || !this._canPersistTerrainArtifact(write)) return;
        write.scheduled = true;
        whenIdle(async () => {
            try {
                if (this._canPersistTerrainArtifact(write)) {
                    this._terrainArtifactWritePromise = this._persistTerrainArtifact(write);
                    await this._terrainArtifactWritePromise;
                }
            } finally {
                write.scheduled = false;
                this._scheduleTerrainArtifactWrite();
            }
        });
    }

    async _persistTerrainArtifact(write) {
        try {
            if (!this._canPersistTerrainArtifact(write)) return false;
            if (!write.artifact) {
                try {
                    // The reveal has published before this idle readback. Keep
                    // extraction separate from hashing/IDB in the next slice.
                    write.artifact = captureTerrainArtifact(write.canvas, write.bounds, write.dpr, captureTerrainArtifactFields(write.host), terrainArtifactManifest(write.inputs));
                } finally {
                    if (write.ownsCanvas) releaseCanvasBackingStore(write.canvas);
                    write.canvas = null;
                    write.host = null;
                }
                if (!write.artifact) this._discardTerrainArtifactWrite();
                return false;
            }
            const configHash = await write.config;
            if (!this._canPersistTerrainArtifact(write)) return false;
            const key = terrainArtifactKey({ ...write.inputs, configHash });
            const saved = key && await this._terrainArtifactStore.put(key, write.artifact,
                () => this._canPersistTerrainArtifact(write));
            if (!this._canPersistTerrainArtifact(write)) return false;
            if (saved) this._terrainArtifactStats.writes++;
            this._discardTerrainArtifactWrite();
            return Boolean(saved);
        } catch {
            if (this._terrainArtifactWrite === write) this._discardTerrainArtifactWrite();
            return false;
        }
    }

    _discardTerrainArtifactRead() {
        releaseCanvasBackingStore(this._terrainArtifactRead?.ready?.canvas);
        this._terrainArtifactRead = null;
    }

    _discardTerrainArtifactWrite() {
        const write = this._terrainArtifactWrite;
        if (!write) return;
        write.cancelled = true;
        if (write.ownsCanvas) releaseCanvasBackingStore(write.canvas);
        write.canvas = null;
        write.host = null;
        write.artifact = null;
        this._terrainArtifactWrite = null;
    }

    _releaseTerrainArtifactWork() {
        this._terrainArtifactGeneration = (this._terrainArtifactGeneration || 0) + 1;
        this._discardTerrainArtifactRead();
        this._discardTerrainArtifactWrite();
        this._terrainArtifactPrefetch = undefined;
        this._terrainArtifactPreparationPending = false;
        this._terrainArtifactNeedsRead = true;
    }

    // B.2 — the resident stand-in no longer has a texture behind it (context
    // loss, eviction): the next terrain request re-bakes the canvas.
    dropTerrainResident() {
        this._terrainResident = null;
        this._discardTerrainArtifactRead();
        this._prepareTerrainArtifactRead();
    }

    // 0.3 — the bake is keyed only on what changes its pixels: the cache
    // bounds, asset availability, the season and its BI-2 stage (the water
    // reflections mirror the canopies; GroundBake's base re-keys only on the
    // litter's `ground` part), the scenery revision and each registered bake
    // pass's own revision. Time of day is owned by the grade
    // (C2) on both backends and nothing in the bake reads the camera, so a
    // phase boundary or a zoom step reuses the 26 MB surface instead of
    // rebaking and re-uploading it.
    // `staged` false: each pass's `baseRevision` where it has one (EY-5,
    // the key without the winter ground's stage).
    _terrainBakeKey(bounds, dpr, season, staged = true) {
        let passes = '';
        for (const pass of this._terrainBakePasses || []) {
            const revision = !staged && pass.baseRevision ? pass.baseRevision(this) : pass.revision?.(this) ?? 0;
            passes += `${pass.id}:${revision},`;
        }
        return `${bounds.x},${bounds.y},${bounds.w},${bounds.h}@${dpr}|${this.assets ? 'assets' : 'fallback'}|season:${season}|stage:${this._currentPhenology().id}|scenery:${this._terrainSceneryRevision || 0}|passes:${passes}|retry:${this._terrainBakeRetry || 0}`;
    }

    // The plug-in point for later terrain bakes (splat ground, coast field).
    // A pass is `{ id, stage, draw(ctx, renderer), revision?(renderer) }`:
    // `stage` is 'ground' (after the tile stamps), 'coast' (right after the
    // ground: water, shore and the land-only island cliff, before bridges,
    // foundations and props draw over them) or 'finish' (last). Its revision
    // joins the cache key, so a pass rebakes only when its own inputs change.
    // Passes paint at 1 texel per world pixel and must not read phase, weather
    // or the camera: the grade owns time of day.
    registerTerrainBakePass(pass) {
        if (!pass?.id || typeof pass.draw !== 'function') return () => {};
        const passes = this._terrainBakePasses || (this._terrainBakePasses = []);
        const index = passes.findIndex(entry => entry.id === pass.id);
        if (index >= 0) passes[index] = pass;
        else passes.push(pass);
        return () => {
            const at = passes.indexOf(pass);
            if (at >= 0) passes.splice(at, 1);
        };
    }

    _runTerrainBakePasses(ctx, stage) {
        for (const pass of this._terrainBakePasses || []) {
            if (pass.stage === stage) pass.draw(ctx, this);
        }
    }

    _drawStaticTerrainSurface(ctx) {
        const previousMotionScale = this.motionScale;
        try {
            this.motionScale = 0;
            for (const step of this._terrainSurfaceSteps(ctx)) step();
        } finally {
            this.motionScale = previousMotionScale;
        }
    }

    // The static terrain surface in order, one step each (EY-5: a restage
    // runs one per idle slice).
    _terrainSurfaceSteps(ctx) {
        return [
            // 3.2 — GroundBake paints every land texel (class field, C1 ramps,
            // AO, thresholds, yards, decals) in one cached image.
            () => this._runTerrainBakePasses(ctx, 'ground'),
            // The far-row haze multiplies the ground only: water, foam and wet
            // sand stay exact CoastBake colours, which the resident water
            // cycles match by ungraded albedo (3.1, 3.6); baked props, bridges
            // and foundations take 1.6's aerial haze like every sprite.
            () => this._bakeAtmosphericPerspective(ctx),
            // 3.4/3.5 — CoastBake: one continuous coast field paints wet sand,
            // foam and every water pixel, then the stratified cliff under land
            // edge tiles only (the sea meets the cached outer ocean).
            () => this._runTerrainBakePasses(ctx, 'coast'),
            () => this._drawTerrainOverlayTiles(ctx),
            () => this._drawLandmarkBridgeSpans(ctx),
            () => this.buildingRenderer?.drawGroundFoundations?.(ctx),
            () => this._drawAmbientGroundProps(ctx),
            () => this._runTerrainBakePasses(ctx, 'finish'),
        ];
    }

    // Atmospheric perspective: a faint top-to-bottom cool-lighter wash baked into
    // the terrain cache so far rows (low tileY, high on screen) read hazier than
    // near rows (high tileY, low on screen) — the painterly "distant things recede"
    // trick at zero per-frame cost. Clipped to the world diamond, multiply-blended,
    // ~8% at the far apex fading to 0 across the near half. No motion (baked).
    // 0.10 — on the pixel grammar: six flat horizontal courses on a 2 world-px
    // cell, each the old profile's colour at its centre, with a 4x4 ordered
    // dither only in a two-cell band at each seam. No gradient.
    _bakeAtmosphericPerspective(ctx) {
        const points = this._worldDiamondPoints();
        const topY = points[0].y;       // far apex (tileY≈0)
        const bottomY = points[2].y;    // near apex (tileY≈MAP_SIZE)
        if (!(bottomY > topY) || typeof document === 'undefined') return;
        const CELL = 2;
        const COURSES = TERRAIN_HAZE_COURSES.length;
        const SEAM_CELLS = 2;
        const rows = Math.ceil((bottomY - topY) / CELL);
        if (this._perspectiveTile?.height !== rows) {
            // Cool, high-value haze tint at half strength: multiply leaves the
            // near rows nearly untouched and cools the far rows. The course
            // colours live in GroundBake (TERRAIN_HAZE_COURSES), where W6.11's
            // grass gust stops are hazed to match this cache.
            const colours = TERRAIN_HAZE_COURSES;
            const seam = SEAM_CELLS / Math.max(1, rows / COURSES);
            const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
            const tile = this._perspectiveTile || document.createElement('canvas');
            tile.width = 4;
            tile.height = rows;
            const tctx = tile.getContext('2d');
            const image = tctx.createImageData(4, rows);
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < 4; x++) {
                    const order = bayer[(y % 4) * 4 + x] / 16 - 0.5;
                    const q = ((y + 0.5) / rows) * COURSES + order * seam;
                    const rgb = colours[Math.max(0, Math.min(COURSES - 1, Math.floor(q)))];
                    const offset = (y * 4 + x) * 4;
                    image.data[offset] = rgb[0];
                    image.data[offset + 1] = rgb[1];
                    image.data[offset + 2] = rgb[2];
                    image.data[offset + 3] = 255;
                }
            }
            tctx.putImageData(image, 0, 0);
            this._perspectiveTile = tile;
        }
        const pattern = ctx.createPattern(this._perspectiveTile, 'repeat-x');
        if (!pattern) return;
        pattern.setTransform?.(new DOMMatrix([CELL, 0, 0, CELL, 0, topY]));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.clip();
        ctx.globalCompositeOperation = 'multiply';
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = pattern;
        ctx.fillRect(points[3].x, topY, points[1].x - points[3].x, bottomY - topY);
        ctx.restore();
    }

    _buildTerraceProps() {
        const sprites = [], images = new Map();
        const stairIds = {
            ne: 'prop.terraceStair.ne',
            nw: 'prop.terraceStair.nw',
            se: 'prop.terraceStair.se',
            sw: 'prop.terraceStair.sw',
        };
        const cornerIds = {
            inner: 'prop.terraceCorner.inner',
            outer: 'prop.terraceCorner.outer',
        };
        const add = (id, x, y, w, h, anchor, materialClass = 'stone') => {
            if (!images.has(id)) {
                let image = this.assets?.get?.(id);
                if (!image && !this.assets?.getEntry?.(id) && typeof Image !== 'undefined') {
                    image = new Image();
                    image.onload = () => { if (!this._disposed) this._invalidateIdleFrame(); };
                    image.src = new URL(`../../../assets/sprites/props/${id}.png`, import.meta.url).href;
                }
                images.set(id, image);
            }
            sprites.push(new TerraceProp(this, id, x, y, images.get(id), w, h, anchor, materialClass));
        };
        for (const surface of this.surfaceRegistry.surfaces) {
            const { tx, ty } = tileCoords(surface.tile);
            if (surface.kind === 'stair') {
                const [, a, b] = surface.plane16;
                const dir = a > 0 ? 'se' : a < 0 ? 'nw' : b > 0 ? 'sw' : 'ne';
                // The baked tread midpoint lies 4 px above its local base at y=31.
                add(stairIds[dir], tx, ty, 64, 48, 27);
            } else if (surface.route && surface.id === 2) {
                const h = planeHeight(surface.plane16);
                const east = supportHeight(tx + 1, ty, this.surfaceRegistry) >= h, south = supportHeight(tx, ty + 1, this.surfaceRegistry) >= h;
                const outer = !east && !south;
                const inner = east && south && supportHeight(tx + 1, ty + 1, this.surfaceRegistry) < h;
                // Align the 8 px coping to the raised lip (the PNG base is y=20).
                if (outer || inner) add(outer ? cornerIds.outer : cornerIds.inner, tx + 0.375, ty + 0.375, 32, 32, 12);
            }
        }
        for (const spill of this.surfaceRegistry.spills) {
            const { tx, ty } = tileCoords(spill.lower[0]);
            add('prop.lagoonSpillway', tx, ty, 64, 96, 82, 'water');
        }
        return sprites;
    }

    _buildDistrictPropSprites() {
        if (!this.sprites) return [];
        const sprites = this._buildVillageWallSprites();
        sprites.push(...this._buildBridgeNearRailSprites());
        const gateOrigin = this._tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
        const gateSprite = new StaticPropSprite({
            tileX: VILLAGE_GATE.tileX,
            tileY: VILLAGE_GATE.tileY,
            id: VILLAGE_GATE.id,
            bounds: VILLAGE_GATE_BOUNDS,
            // The gatehouse runs 9 tiles along +tileX, so its ends sit ~140 px
            // of world Y apart: one sortY put trees behind its east half in
            // front of it. Slices sort against the wall line itself (slope
            // TILE_HEIGHT / TILE_WIDTH along +tileX): whatever stands north of
            // it paints first, whatever stands south of it paints after.
            occlusionColumns: lineOcclusionColumns({
                left: VILLAGE_GATE_BOUNDS.left,
                right: VILLAGE_GATE_BOUNDS.right,
                width: VILLAGE_GATE_OCCLUSION_COLUMN_PX,
                originY: gateOrigin.y,
                slope: TILE_HEIGHT / TILE_WIDTH,
            }),
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this._drawVillageGatehouse(ctx, x, y),
            channels: {
                occluder: (ctx, x, y) => this._drawVillageGatehouse(ctx, x, y, 'surface'),
                emissive: (ctx, x, y) => this._drawVillageGatehouse(ctx, x, y, 'emissive'),
            },
        });
        gateSprite.emitterGate = () => (this._wallLanternsLit === true ? 1 : 0);
        this._gateDoorStateSprites = [gateSprite];
        this._lampGlassSprites = [gateSprite];
        sprites.push(gateSprite);
        // The two wall lanterns flanking the arch (VillageWall's bracket
        // lantern), lit with the rest of the village's lamps.
        const gateLanterns = this._villageGateLanternSprites();
        (this._wallLanternSprites ||= []).push(...gateLanterns);
        sprites.push(...gateLanterns);
        sprites.push(...this._buildVillageWallTerminalSprites());
        sprites.push(...this._buildWatchtowerBeaconBuoySprites());
        sprites.push(...DISTRICT_PROPS
            .filter((prop) => prop.layer === 'sorted' && !prop.landmark)
            .filter((prop) => prop.walkBlock === true || !this.scenery.isBlockedForTallScenery(prop.tileX, prop.tileY, this.sceneryClearTiles, this.bridgeTiles))
            .map((prop) => {
                const entry = this.assets?.getEntry?.(prop.id);
                // 2.9 — precomputed so the per-frame drawFn does no lookup work:
                // land props get a contact shadow, water-surface props none.
                const contactShadow = !this.waterTiles.has(`${Math.floor(prop.tileX)},${Math.floor(prop.tileY)}`);
                const channels = {};
                for (const channel of ['material', 'occluder']) {
                    if (entry?.[channel + 'Sidecar'] === true) {
                        channels[channel] = (ctx, x, y) => this.sprites.drawCompanion(ctx, prop.id, channel, x, y);
                    }
                }
                return new StaticPropSprite({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    id: prop.id,
                    bounds: this._assetPropBounds(prop.id),
                    splitForOcclusion: false,
                    materialClass: entry?.materialClass || null,
                    channels,
                    drawFn: (ctx, x, y) => {
                        if (contactShadow) this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                        this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
                    },
                });
            }));
        // BI-6 — the live reed and cattail clumps (DISTRICT_PROPS layer 'live'):
        // their cache-era placements, kept whole (no tall-scenery filter).
        sprites.push(...buildReedSprites(this));
        // W8.5b — the isle landmarks (the windmill and the Hourglass Belfry):
        // walkBlock placements, so they skip the tall-scenery tile filter
        // above, which their own block would trip.
        sprites.push(...(this.isleLandmarks ||= new IsleLandmarks(this)).buildSprites());
        // W6.10 / W8.4b — the calendar's prop dressing: fixed sprites that
        // paint only inside their date window (VillageCalendar), the authored
        // `prop.festival.*` art blitted like any sorted district prop.
        sprites.push(...(this.villageCalendar ||= new VillageCalendar()).buildPropSprites({
            sprites: {
                draw: (ctx, id, x, y, tile) => {
                    this._drawPropContactShadow(ctx, x, y, id, tile.tileX, tile.tileY);
                    this.sprites?.drawSprite(ctx, id, x, y, this._winterPropOpts(id));
                },
                bounds: (id) => this._assetPropBounds(id),
                materialClass: (id) => this.assets?.getEntry?.(id)?.materialClass || null,
            },
        }));
        // 7.1 / W1-D 1.6 / W3-D — rest-seat furniture: authored oak trestle sheets
        // (with night-only candle emissives on the lamp clock), pier kerbs, and earned bench patina.
        this._restSeatBackProps = new Map();
        const restSeatSprites = buildRestSeatPropSprites({
            assets: this.assets,
            lampsLit: () => this.villageLampsLit(),
            patinaForSeat: (seatId) => this._benchPatinaBySeat?.get(seatId) || null,
        });
        for (const propSprite of restSeatSprites) {
            const match = /^rest-seat\.[^.]+\.(.+)\.back$/.exec(propSprite.id || '');
            if (match) this._restSeatBackProps.set(match[1], propSprite);
        }
        sprites.push(...restSeatSprites);
        const fountain = DISTRICT_PROPS.find(prop => prop.id === 'prop.plazaFountain' && prop.district === 'civic');
        if (fountain && this.assets?.has?.('prop.plazaFountainWater')) {
            sprites.push(new FountainWaterSprite(this, fountain));
        }
        // The Tavern's arches and beam, over the drinkers on its floor.
        sprites.push(...buildTavernArcadeSprites({ building: this.world?.buildings?.get?.('tavern'), assets: this.assets }));
        return sprites;
    }

    _buildBridgeNearRailSprites() {
        if (!this.bridgeSpans?.length || !this.assets) return [];
        const sprites = [];
        for (const span of this.bridgeSpans) {
            const rail = span.nearRail;
            if (!rail) continue;
            const walk = this._bridgeWalk(span);
            if (span.id === 'central-river-bridge') {
                const parapet = buildCentralBridgeParapetSprite({
                    span,
                    assets: this.assets,
                    propWinter: this.propWinter,
                    bridgeWalk: walk,
                    bridgeLightsLit: (s) => this.bridgeLightsLit?.(s) === true,
                });
                if (parapet) sprites.push(parapet);
                continue;
            }
            const segmentCount = Math.max(1, span.lengthTiles * 2);
            for (let i = 0; i < segmentCount; i++) {
                const t0 = i / segmentCount;
                const t1 = (i + 1) / segmentCount;
                const midT = (t0 + t1) / 2;
                const quad = this._bridgeNearRailQuad(span, t0, t1);
                const propWorld = this._bridgePoint(span, midT, span.halfWidth, 0);
                const propTile = worldToTile(propWorld.x, propWorld.y);
                const localQuad = quad.map((point) => ({
                    x: point.x - propWorld.x,
                    y: point.y - propWorld.y,
                }));
                const xs = localQuad.map((point) => point.x);
                const ys = localQuad.map((point) => point.y);
                const slice = new StaticPropSprite({
                    tileX: propTile.tileX,
                    tileY: propTile.tileY,
                    id: `bridge.rail.${span.id}.${i}`,
                    bounds: {
                        left: Math.floor(Math.min(...xs)),
                        right: Math.ceil(Math.max(...xs)),
                        top: Math.floor(Math.min(...ys)),
                        bottom: Math.ceil(Math.max(...ys)),
                        splitY: 0,
                    },
                    splitForOcclusion: false,
                    sortY: propWorld.y,
                    drawFn: (ctx) => {
                        const clipQuad = this._bridgeNearRailQuad(span, t0, t1);
                        const placement = this._bridgeSpritePlacement(span);
                        if (!placement) return;
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(clipQuad[0].x, clipQuad[0].y);
                        for (let q = 1; q < clipQuad.length; q++) {
                            ctx.lineTo(clipQuad[q].x, clipQuad[q].y);
                        }
                        ctx.closePath();
                        ctx.clip();
                        ctx.drawImage(
                            placement.img,
                            placement.x,
                            placement.y,
                            placement.dims.w,
                            placement.dims.h
                        );
                        ctx.restore();
                    },
                });
                // Past the deck's camera-side end a body stands in front of
                // what the band repaints: DrawablePass (`bridgeDeckSortY`)
                // sorts a body on that walk after the last slice.
                slice.bridgeWalk = walk;
                sprites.push(slice);
            }
        }
        return sprites;
    }

    // Where a body on the bridge stands in front of the near-rail slices, in
    // tile space: the deck's walk column (the walkable centre line, lanes
    // included) from the landing tile before the deck to the landing tile
    // after it. Without a measured deck the band repaints planks and end
    // posts, so that is the whole walk. With one (`deckProfile`) the band
    // holds only the rail, which stands in front of every body on the deck:
    // only a body as near as the deck's camera-side end (`minY`, the ground Y
    // of the walk line at the profile's last stair top; `end` is the span's
    // larger tile coordinate) stands in front of the rail's end, on the
    // stairs and the landing, and the column runs on past them (`to`
    // unbounded), so every body on it keeps its ground order: a depth
    // threshold, not a tile one, never lets a file just past it paint over a
    // nearer file just short of it.
    _bridgeWalk(span) {
        const start = worldToTile(span.start.x, span.start.y);
        const end = worldToTile(span.end.x, span.end.y);
        const eastWest = span.orientation === 'EW';
        const a = eastWest ? start.tileX : start.tileY;
        const b = eastWest ? end.tileX : end.tileY;
        const line = eastWest ? start.tileY : start.tileX;
        const profile = span.deckProfile;
        const stairTop = profile
            ? (eastWest ? span.centerTile.x : span.centerTile.y) + profile[profile.length - 2][0]
            : null;
        // The span overhangs its first and last deck tile by 0.45, so 1.05
        // more reaches the far edge of each landing tile.
        return {
            axis: eastWest ? 'x' : 'y',
            line,
            from: Math.min(a, b) - 1.05,
            to: stairTop == null ? Math.max(a, b) + 1.05 : Infinity,
            halfWidth: 0.5,
            minY: stairTop == null
                ? -Infinity
                : (eastWest ? tileToWorld(stairTop, line) : tileToWorld(line, stairTop)).y,
        };
    }

    _bridgeNearRailQuad(span, t0, t1) {
        const rail = span.nearRail;
        return [
            this._bridgeRailPoint(span, t0, rail.inner, rail.top),
            this._bridgeRailPoint(span, t1, rail.inner, rail.top),
            this._bridgeRailPoint(span, t1, rail.outer, -rail.bottom),
            this._bridgeRailPoint(span, t0, rail.outer, -rail.bottom),
        ];
    }

    // A corner of the near-rail band, `height` px over its base line: the
    // sine arch (`_bridgePoint`), or on a measured span the rail's own lift
    // profile (`nearRail.lift`, [along, px] pairs like `deckProfile`: the
    // rail curves more than the deck it stands on), else the deck profile.
    _bridgeRailPoint(span, t, crossOffset, height) {
        const profile = span.nearRail.lift || span.deckProfile;
        if (!profile) return this._bridgePoint(span, t, crossOffset, height);
        const x = span.start.x + (span.end.x - span.start.x) * t;
        const y = span.start.y + (span.end.y - span.start.y) * t;
        const tile = worldToTile(x, y);
        const along = span.orientation === 'EW' ? tile.tileX - span.centerTile.x : tile.tileY - span.centerTile.y;
        return {
            x: x + span.crossUnit.x * crossOffset,
            y: y + span.crossUnit.y * crossOffset - bridgeProfileAt(profile, along) - height,
        };
    }

    // The two curtain runs (VillageWall), each one cached image with its 2.3
    // surface channel, and the fixtures its layout places as their own small
    // props: the bracket lanterns on some piers and the sentry brazier on one
    // pier's lookout (lit with the village's lamplight, so the runs' caches
    // never repaint for it), and the barrel store at the wall stair's foot.
    _buildVillageWallSprites() {
        const out = [];
        const lanterns = [];
        const braziers = [];
        for (const route of VILLAGE_WALL_ROUTES) {
            for (let i = 0; i < route.points.length - 1; i++) {
                const startTile = route.points[i];
                const endTile = route.points[i + 1];
                const visualEndTile = this._villageWallVisualEndTile(route, startTile, endTile);
                const midTile = {
                    tileX: (startTile.tileX + visualEndTile.tileX) / 2,
                    tileY: (startTile.tileY + visualEndTile.tileY) / 2,
                };
                const start = this._tileToWorld(startTile.tileX, startTile.tileY);
                const end = this._tileToWorld(visualEndTile.tileX, visualEndTile.tileY);
                const mid = this._tileToWorld(midTile.tileX, midTile.tileY);
                const localStart = { x: start.x - mid.x, y: start.y - mid.y };
                const localEnd = { x: end.x - mid.x, y: end.y - mid.y };
                const wallBounds = this._villageWallBounds(localStart, localEnd);
                // The west run meets the gatehouse's west stub at its end, the
                // east run the east stub at its start: open there (no end
                // face, no ink), so the curtain reads as one wall.
                const options = {
                    piers: true,
                    ivy: true,
                    seed: VILLAGE_WALL_SEEDS[route.id] ?? 331 + i,
                    openStart: route.id === 'east' && i === 0,
                    openEnd: route.id === 'west' && i === route.points.length - 2,
                    // The west run rises from the island's west tip at a
                    // corner turret.
                    startTurret: route.id === 'west' && i === 0,
                };
                const sortY = Math.max(start.y, end.y) - 14;
                out.push(new StaticPropSprite({
                    tileX: midTile.tileX,
                    tileY: midTile.tileY,
                    id: `village.wall.${route.id}.${i}`,
                    bounds: wallBounds,
                    splitForOcclusion: false,
                    sortY,
                    materialClass: 'stone',
                    drawFn: (ctx, x, y) => this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i, options),
                    channels: {
                        occluder: (ctx, x, y) => this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i, { ...options, channel: 'surface' }),
                    },
                }));
                const fixtures = this._villageWallFixtureSprites(route.id, i, start, end, options, sortY);
                lanterns.push(...fixtures.lanterns);
                braziers.push(...fixtures.braziers);
                out.push(...fixtures.stores);
            }
        }
        this._wallLanternSprites = lanterns;
        this._wallBrazierSprites = braziers;
        out.push(...lanterns, ...braziers);
        return out;
    }

    // The fixtures of one run, from the painter's own layout, each sorted
    // just after its run (they stand in front of or on its stone):
    // - a bracket lantern on each lantern pier, a prop standing on the ground
    //   under its glass;
    // - the sentry brazier (`pier.brazier`) on its pier's lookout crown,
    //   cold by day and burning on the lamps clock (`_wallLanternsLit`),
    //   its flame a `lamps` fixture light (`_villageWallLanternLightSources`);
    // - the barrel store (`prop.barrelStack`) on the verge at the wall foot
    //   beside the stair: outside the curtain, where no walk node reaches
    //   (`_wallMassNodes` closes the row under the wall and the verge holds
    //   none), clear of the lantern feet and the ivy curtains.
    _villageWallFixtureSprites(routeId, index, start, end, { seed, startTurret = false }, wallSortY) {
        const S = WALL_SPEC;
        const x1 = Math.round(start.x);
        const y1 = Math.round(start.y);
        const x2 = Math.round(end.x);
        const y2 = Math.round(end.y);
        const slope = (y2 - y1) / Math.max(1, x2 - x1);
        // The painter's lattice: a point d px before (negative) the base line
        // at height h, in screen column c, lands on row yb(c) - d - h.
        const yb = (c) => y1 + Math.floor((c - x1) * slope + 0.5);
        const layout = wallRunLayout({ x1, x2, seed, piers: true, ivy: true, startTurret });
        const arm = S.lanternArmH;
        const lanterns = [];
        const braziers = [];
        for (const pier of layout.piers) {
            const cu = pier.u0 + Math.floor(S.pier.width / 2);
            if (pier.brazier) braziers.push(this._villageWallBrazierSprite(routeId, index, pier, cu, yb, wallSortY));
            if (!pier.lantern) continue;
            // The arm tip stands `pier.project + lanternReach` in front of
            // the base line under the pier's centre; its foot is the ground
            // there (the lattice row yb(c) - d).
            const d = -(S.pier.project + S.lanternReach);
            const c = cu + d;
            const fx = c;
            const fy = yb(c) - d;
            const tile = worldToTile(fx, fy);
            const sprite = new StaticPropSprite({
                tileX: tile.tileX,
                tileY: tile.tileY,
                id: `village.wallLantern.${routeId}.${index}.${pier.n}`,
                bounds: { left: -5, right: 8, top: -arm - 3, bottom: 2, splitY: 0 },
                sortY: wallSortY + 0.5,
                materialClass: 'metal',
                drawFn: (ctx) => drawWallLantern(ctx, fx, fy - arm, { lit: this._wallLanternsLit === true }),
                channels: {
                    emissive: (ctx) => drawWallLantern(ctx, fx, fy - arm, { lit: this._wallLanternsLit === true, emissive: true }),
                },
            });
            sprite.lanternFoot = { x: fx, y: fy, height: arm - 7 };
            lanterns.push(sprite);
        }
        const store = this._villageWallStoreSprite(routeId, index, layout, x1, x2, yb, wallSortY);
        return { lanterns, braziers, stores: store ? [store] : [] };
    }

    // The sentry brazier: the tripod's front foot one row behind the front
    // lip of the lookout crown's top face (h walk + merlonH + 3; the splayed
    // back feet then land on its 4 rows), the cold sheet by day and the lit
    // one while the lamps burn; its emissive channel is the lit sheet's
    // flame sidecar. The light's ground foot is the verge in front of the
    // pier, straight under the flame, so its pool and the courses it warms
    // fall on the face the camera sees.
    _villageWallBrazierSprite(routeId, index, pier, cu, yb, wallSortY) {
        const S = WALL_SPEC;
        const crownTop = S.walk + S.merlonH + 3;
        const depth = 1;
        const fx = cu + depth;
        const standY = yb(fx) - depth - crownTop;
        const fy = yb(fx) + S.pier.project + 1;
        const tile = worldToTile(fx, fy);
        let sprite = null;
        const flame = (ctx) => {
            if (this._wallLanternsLit !== true) return;
            const glow = this.assets?.getCompanion?.(WALL_BRAZIER.litId, 'emissive') || null;
            // Repaint once more when the sidecar lands after a lit bake.
            sprite.flamePending = !glow;
            if (!glow) return;
            const [ax, ay] = this.assets.getAnchor(WALL_BRAZIER.litId);
            ctx.drawImage(glow, fx - ax, standY - ay);
        };
        sprite = new StaticPropSprite({
            tileX: tile.tileX,
            tileY: tile.tileY,
            id: `village.wallBrazier.${routeId}.${index}.${pier.n}`,
            bounds: { left: -17, right: 17, top: standY - fy - 30, bottom: 2, splitY: 0 },
            sortY: wallSortY + 0.5,
            materialClass: 'metal',
            drawFn: (ctx) => this.sprites?.drawSprite(ctx, this._wallLanternsLit === true ? WALL_BRAZIER.litId : WALL_BRAZIER.id, fx, standY),
            channels: { emissive: flame },
        });
        sprite.lanternFoot = { x: fx, y: fy, height: fy - (standY - WALL_BRAZIER.flame) };
        sprite.flamePending = false;
        return sprite;
    }

    // The barrel store at the wall foot: a `prop.barrelStack` on the verge
    // just left of the stair's foot (else right of its pier), its back
    // clear of the plinth, its top clear of the ivy curtains and 32 px from
    // any lantern's foot. A run with no stair, or no clear place, has none.
    _villageWallStoreSprite(routeId, index, layout, x1, x2, yb, wallSortY) {
        const S = WALL_SPEC;
        const id = 'prop.barrelStack';
        const stair = layout.piers.find((pier) => pier.stair);
        if (!stair || !this.assets?.getDims?.(id)) return null;
        const half = 16;
        const s0 = stair.u0 - WALL_STAIR.steps * WALL_STAIR.run;
        const clear = (u) => u - half > x1 + 30 && u + half < x2 - 30
            && layout.piers.every((pier) => !pier.lantern || Math.abs(pier.u0 + S.pier.width / 2 - u) > 32 + half)
            && layout.piers.every((pier) => pier.u1 + 2 < u - half || pier.u0 - 2 > u + half)
            && layout.ivySprites.every((slot) => slot.u1 + 2 < u - half || slot.u0 - 2 > u + half);
        const u = [s0 - half - 4, s0 - half - 20, stair.u1 + half + 6, stair.u1 + half + 22].find(clear);
        if (u === undefined) return null;
        // Foot 9 rows before the base line: the group's back (4 rows behind
        // its anchor) stands in front of the plinth's 2-px batter.
        const d = -9;
        const fx = u + d;
        const fy = yb(fx) - d;
        const tile = worldToTile(fx, fy);
        return new StaticPropSprite({
            tileX: tile.tileX,
            tileY: tile.tileY,
            id: `village.wallStore.${routeId}.${index}`,
            bounds: this._assetPropBounds(id),
            splitForOcclusion: false,
            sortY: wallSortY + 0.5,
            materialClass: 'timber',
            drawFn: (ctx) => {
                this._drawPropContactShadow(ctx, fx, fy, id, tile.tileX, tile.tileY);
                this.sprites?.drawSprite(ctx, id, fx, fy, this._winterPropOpts(id));
            },
        });
    }

    // The wall lanterns' and sentry braziers' fixture lights while the
    // village's lamps are lit; a change of state repaints the lantern and
    // brazier props (glass or fire lit or cold) and the gatehouse and sea
    // tower, whose lamp glass is lit with them.
    _villageWallLanternLightSources(lighting = null) {
        const lit = lanternLit(lighting);
        if (lit !== this._wallLanternsLit) {
            this._wallLanternsLit = lit;
            for (const sprite of this._wallLanternSprites || []) sprite.invalidateCache();
            for (const sprite of this._wallBrazierSprites || []) sprite.invalidateCache();
            for (const sprite of this._lampGlassSprites || []) sprite.invalidateCache();
        }
        if (!lit) return [];
        for (const sprite of this._wallBrazierSprites || []) {
            if (sprite.flamePending && this.assets?.getCompanion?.(WALL_BRAZIER.litId, 'emissive')) {
                sprite.flamePending = false;
                sprite.invalidateCache();
            }
        }
        const core = sourceEnergyFor(lighting).core;
        const record = (sprite, fire) => wallLanternLight({
            id: sprite.id,
            fx: sprite.lanternFoot.x,
            fy: sprite.lanternFoot.y,
            height: sprite.lanternFoot.height,
            lighting,
            core,
            fire,
        });
        return [
            ...(this._wallLanternSprites || []).map((sprite) => record(sprite, false)),
            ...(this._wallBrazierSprites || []).map((sprite) => record(sprite, true)),
        ];
    }

    _villageWallVisualEndTile(route, startTile, endTile) {
        if (route?.id !== 'east') return endTile;
        const towerTile = this._villageWallSeaTowerTile(endTile, startTile);
        const dx = Number(endTile.tileX) - Number(startTile.tileX);
        const dy = Number(endTile.tileY) - Number(startTile.tileY);
        const length = Math.max(0.1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        return {
            tileX: towerTile.tileX - ux * 0.42,
            tileY: towerTile.tileY - uy * 0.42,
        };
    }

    // Decorative beacon buoys flanking the Pharos Lighthouse on the sea-line.
    // Authored tile positions live in WATCHTOWER_BEACON_BUOY_TILES
    // (config-near-call-site by design); they're picked to land on open water
    // away from the harbor anchorages declared in HarborTraffic.js.
    _buildWatchtowerBeaconBuoySprites() {
        const id = 'prop.harborBeaconBuoy';
        if (!this.assets?.has?.(id) || !this.sprites) return [];
        const out = [];
        for (const buoy of WATCHTOWER_BEACON_BUOY_TILES) {
            out.push(new StaticPropSprite({
                tileX: buoy.tileX,
                tileY: buoy.tileY,
                id,
                bounds: this._assetPropBounds(id, 0.58),
                splitForOcclusion: false,
                drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, id, x, y),
            }));
        }
        return out;
    }

    _buildVillageWallTerminalSprites() {
        if (!this.assets?.has?.(VILLAGE_WALL_SEA_TOWER_SPRITE_ID)) return [];
        const route = VILLAGE_WALL_ROUTES.find((candidate) => candidate.id === 'east');
        if (!route || route.points.length < 2) return [];
        const endTile = route.points[route.points.length - 1];
        const prevTile = route.points[route.points.length - 2];
        const towerTile = this._villageWallSeaTowerTile(endTile, prevTile);
        const world = this._tileToWorld(towerTile.tileX, towerTile.tileY);
        const id = VILLAGE_WALL_SEA_TOWER_SPRITE_ID;
        // One whole sprite at every zoom, sorted after the east run: the run
        // ends inside its drum (_villageWallVisualEndTile) and sorts at that
        // end's world Y - 14, about the tower's foot - 21. A split back half
        // would sort at the foot - 60, before the run, and the curtain's
        // parapet would paint over the upper drum (the slow prop path below
        // FAST_PROP_MIN_ZOOM, and any zoom with a villager near). No villager
        // stands between the two: the drum and the wall are masonry
        // (inVillageMasonry) and the sea lies beyond. The bounds' 0.66 split
        // only places the name-tag clamp's front band.
        const tower = new StaticPropSprite({
            tileX: towerTile.tileX,
            tileY: towerTile.tileY,
            id,
            bounds: this._assetPropBounds(id, 0.66),
            splitForOcclusion: false,
            sortY: world.y - 8,
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, id, x, y, this._winterPropOpts(id)),
            // The baked 2.3 surface channel, and the lamp room's glass while
            // the village's lamps are lit (a fixture: never a work light).
            channels: {
                occluder: (ctx, x, y) => this.sprites.drawCompanion(ctx, id, 'occluder', x, y),
                emissive: (ctx, x, y) => { if (this._wallLanternsLit === true) this.sprites.drawCompanion(ctx, id, 'emissive', x, y); },
            },
        });
        tower.emitterGate = () => (this._wallLanternsLit === true ? 1 : 0);
        (this._lampGlassSprites ||= []).push(tower);
        return [tower];
    }

    _villageWallSeaTowerTile(endTile, prevTile) {
        const dx = Number(endTile.tileX) - Number(prevTile.tileX);
        const dy = Number(endTile.tileY) - Number(prevTile.tileY);
        const length = Math.max(0.1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        for (const offset of [0.25, 0.55, 0.85, 1.15, 1.45]) {
            const candidate = {
                tileX: endTile.tileX - ux * offset,
                tileY: endTile.tileY - uy * offset,
            };
            const key = `${Math.round(candidate.tileX)},${Math.round(candidate.tileY)}`;
            if (!this.waterTiles?.has?.(key)) return candidate;
        }
        return {
            tileX: endTile.tileX - ux * 1.45,
            tileY: endTile.tileY - uy * 1.45,
        };
    }

    _villageWallBounds(start, end) {
        return {
            left: Math.min(start.x, end.x) - 72,
            right: Math.max(start.x, end.x) + 72,
            top: Math.min(start.y, end.y) - 126,
            bottom: Math.max(start.y, end.y) + 42,
            splitY: Math.min(start.y, end.y) - 42,
        };
    }

    _assetPropBounds(id, splitRatio = 0.58) {
        const dims = this.assets?.getDims?.(id);
        if (!dims) return { left: -32, right: 32, top: -64, bottom: 12, splitY: -18 };
        const [ax, ay] = this.assets?.getAnchor?.(id) || [Math.round(dims.w / 2), dims.h];
        return {
            left: -ax,
            right: dims.w - ax,
            top: -ay,
            bottom: dims.h - ay,
            splitY: -ay + Math.round(dims.h * splitRatio),
        };
    }

    _scaledAssetPropBounds(id, scaleX = 1, scaleY = scaleX, splitRatio = 0.58) {
        const bounds = this._assetPropBounds(id, splitRatio);
        const factorX = Number.isFinite(Number(scaleX)) ? Math.max(0.1, Number(scaleX)) : 1;
        const factorY = Number.isFinite(Number(scaleY)) ? Math.max(0.1, Number(scaleY)) : factorX;
        return {
            left: bounds.left * factorX,
            right: bounds.right * factorX,
            top: bounds.top * factorY,
            bottom: bounds.bottom * factorY,
            splitY: bounds.splitY * factorY,
        };
    }

    _drawScaledSprite(ctx, id, x, y, scaleX = 1, scaleY = scaleX) {
        const img = this.assets?.get?.(id);
        if (!img) return;
        const [ax, ay] = this.assets?.getAnchor?.(id) || [Math.round(img.width / 2), img.height];
        const factorX = Number.isFinite(Number(scaleX)) ? Math.max(0.1, Number(scaleX)) : 1;
        const factorY = Number.isFinite(Number(scaleY)) ? Math.max(0.1, Number(scaleY)) : factorX;
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y));
        ctx.scale(factorX, factorY);
        ctx.drawImage(img, Math.round(-ax), Math.round(-ay));
        ctx.restore();
    }

    // The gatehouse (prop.villageGate, baked at scale 1 from
    // VILLAGE_GATE_GEOMETRY by scripts/sprites/bake-village-gate.mjs): the
    // curtain's two stubs, the door leaves, then the towers and the arch
    // block over them. `channel` paints the same composite's 2.3 surface
    // channel ('surface') or its glass ('emissive': the towers' guard lamps,
    // only while the village's lamps are lit; a fixture, never a work light).
    _drawVillageGatehouse(ctx, originX, originY, channel = null) {
        const id = VILLAGE_GATE.id;
        if (channel === 'emissive') {
            if (this._wallLanternsLit === true) this.sprites?.drawCompanion(ctx, id, 'emissive', originX, originY);
            return;
        }
        const [west, east] = VILLAGE_GATE_GEOMETRY.towerX;
        const halfWidth = VILLAGE_GATE.widthTiles / 2;
        const center = this._tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
        const localPoint = (dx) => {
            const p = this._tileToWorld(VILLAGE_GATE.tileX + dx, VILLAGE_GATE.tileY);
            return { x: p.x - center.x, y: p.y - center.y };
        };
        const surface = channel === 'surface';
        const pass = surface ? { channel: 'surface' } : {};
        // Each stub leaves open the end where it meets its curtain run (the
        // run's own gate-side end is open too), so the courses run on.
        this._drawVillageWallSegment(ctx, originX, originY, localPoint(-halfWidth), localPoint(west - VILLAGE_GATE_STUB_INSET), 0, { ...pass, openStart: true });
        this._drawVillageWallSegment(ctx, originX, originY, localPoint(east + VILLAGE_GATE_STUB_INSET), localPoint(halfWidth), 1, { ...pass, openEnd: true });
        this._drawVillageGateDoors(ctx, originX, originY, surface);
        if (surface) this.sprites?.drawCompanion(ctx, id, 'occluder', originX, originY);
        else this.sprites?.drawSprite(ctx, id, originX, originY, this._winterPropOpts(id));
    }

    // The door leaves under the arch (prop.villageGateDoors): frame 1 while
    // the doors stand open for a villager passing (_updateGateDoorState),
    // frame 0 shut. `surface` paints their 2.3 surface channel.
    _drawVillageGateDoors(ctx, originX, originY, surface = false) {
        const id = VILLAGE_GATE_DOORS_SPRITE_ID;
        const image = surface ? this.assets?.getCompanion?.(id, 'occluder') : this.assets?.get?.(id);
        if (!image) return;
        const frameW = Math.floor(image.width / 2);
        const [ax, ay] = this.assets.getAnchor(id);
        ctx.drawImage(image, this.gateDoorsOpen ? frameW : 0, 0, frameW, image.height,
            Math.round(originX - ax), Math.round(originY - ay), frameW, image.height);
    }

    // The gate's two bracket lanterns on the arch block's face, either side
    // of the arch (VILLAGE_GATE_GEOMETRY.lanternX): VillageWall's lantern,
    // each a prop standing on the ground under its arm tip, the arm reaching
    // back up-right into the face.
    _villageGateLanternSprites() {
        const G = VILLAGE_GATE_GEOMETRY;
        const arm = WALL_SPEC.lanternArmH;
        const reach = WALL_SPEC.lanternReach;
        return G.lanternX.map((dx, k) => {
            const base = this._tileToWorld(VILLAGE_GATE.tileX + dx, VILLAGE_GATE.tileY + G.blockHalfDepth);
            const fx = Math.round(base.x) - reach;
            const fy = Math.round(base.y) + Math.floor(reach / 2);
            const tile = worldToTile(fx, fy);
            const sprite = new StaticPropSprite({
                tileX: tile.tileX,
                tileY: tile.tileY,
                id: `village.gateLantern.${k}`,
                bounds: { left: -5, right: 8, top: -arm - 3, bottom: 2, splitY: 0 },
                materialClass: 'metal',
                drawFn: (ctx) => drawWallLantern(ctx, fx, fy - arm, { lit: this._wallLanternsLit === true }),
                channels: {
                    emissive: (ctx) => drawWallLantern(ctx, fx, fy - arm, { lit: this._wallLanternsLit === true, emissive: true }),
                },
            });
            sprite.lanternFoot = { x: fx, y: fy, height: arm - 7 };
            return sprite;
        });
    }

    // One run of the stone curtain (VillageWall.paintWallRun) between two
    // local points of a prop drawn at (originX, originY). The gatehouse
    // stubs call it bare; the full runs pass `{ piers, ivy, seed }`, and an
    // ivy run hangs the `prop.wallIvyCurtain` sheet at its layout's slots.
    // The paint is memoized per run, snow bucket and ivy sheet, so the
    // albedo cache and the surface channel (`channel: 'surface'`) share one
    // rasterization.
    _drawVillageWallSegment(ctx, originX, originY, start, end, phase = 0, options = {}) {
        const out = this._villageWallPaint(originX + start.x, originY + start.y, originX + end.x, originY + end.y, phase, options);
        if (!out) return null;
        ctx.drawImage(options.channel === 'surface' ? out.surface : out.albedo, out.left, out.top);
        return out;
    }

    _villageWallPaint(ax, ay, bx, by, phase = 0, { piers = false, ivy = false, seed = null, endFace = true, openStart = false, openEnd = false, startTurret = false } = {}) {
        const snowBucket = this.propWinter?.bucket || 0;
        const x1 = Math.round(ax);
        const y1 = Math.round(ay);
        const x2 = Math.round(bx);
        const y2 = Math.round(by);
        const runSeed = seed ?? (phase + 1) * 977;
        const ivyImage = ivy ? this.assets?.get?.(WALL_IVY_SPRITE.id) || null : null;
        const key = `${x1},${y1},${x2},${y2}|${runSeed}|${piers ? 1 : 0}${ivy ? 1 : 0}${endFace ? 1 : 0}${openStart ? 1 : 0}${openEnd ? 1 : 0}${startTurret ? 1 : 0}|${snowBucket}|${ivyImage ? 1 : 0}`;
        const cache = this._wallPaintCache || (this._wallPaintCache = new Map());
        if (cache.has(key)) return cache.get(key);
        if (cache.size > 24) cache.clear();
        const out = paintWallRun({ x1, y1, x2, y2, seed: runSeed, piers, ivy, endFace, snowBucket, openStart, openEnd, startTurret, ivyImage });
        cache.set(key, out);
        return out;
    }

    _terrainCacheBounds() {
        if (this.terrainCacheBounds) return this.terrainCacheBounds;
        const points = this._worldDiamondPoints();
        const minX = Math.floor(Math.min(...points.map(p => p.x)) - TERRAIN_CACHE_MARGIN);
        const maxX = Math.ceil(Math.max(...points.map(p => p.x)) + TERRAIN_CACHE_MARGIN);
        const minY = Math.floor(Math.min(...points.map(p => p.y)) - TERRAIN_CACHE_MARGIN);
        const maxY = Math.ceil(Math.max(...points.map(p => p.y)) + TERRAIN_CACHE_MARGIN);
        this.terrainCacheBounds = {
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
        };
        return this.terrainCacheBounds;
    }

    _getTerrainCacheMeta(bounds = this._terrainCacheBounds()) {
        if (this.terrainCacheMeta?.bounds === bounds) return this.terrainCacheMeta;
        const chunksX = Math.ceil(MAP_SIZE / TERRAIN_CACHE_CHUNK_SIZE);
        const chunksY = Math.ceil(MAP_SIZE / TERRAIN_CACHE_CHUNK_SIZE);
        const chunks = [];
        for (let chunkY = 0; chunkY < chunksY; chunkY++) {
            for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                const tileX = chunkX * TERRAIN_CACHE_CHUNK_SIZE;
                const tileY = chunkY * TERRAIN_CACHE_CHUNK_SIZE;
                chunks.push({
                    key: `${chunkX},${chunkY}`,
                    chunkX,
                    chunkY,
                    tileX,
                    tileY,
                    tileWidth: Math.min(TERRAIN_CACHE_CHUNK_SIZE, MAP_SIZE - tileX),
                    tileHeight: Math.min(TERRAIN_CACHE_CHUNK_SIZE, MAP_SIZE - tileY),
                });
            }
        }
        const singleSurfacePixels = Math.max(1, Math.round(bounds.w)) * Math.max(1, Math.round(bounds.h));
        this.terrainCacheMeta = {
            bounds,
            mapSize: MAP_SIZE,
            strategy: singleSurfacePixels <= TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS
                ? 'single-surface'
                : 'uncached-over-budget',
            chunkSize: TERRAIN_CACHE_CHUNK_SIZE,
            chunksX,
            chunksY,
            chunkCount: chunks.length,
            chunks,
            singleSurfacePixels,
            maxSingleSurfacePixels: TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS,
            singleSurfaceWithinBudget: singleSurfacePixels <= TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS,
        };
        return this.terrainCacheMeta;
    }

    _emitTerrainCacheLimitWarning(meta) {
        const key = `${meta.mapSize}:${meta.singleSurfacePixels}`;
        if (this._terrainCacheLimitWarningKey === key) return;
        this._terrainCacheLimitWarningKey = key;
        console.warn(
            `[IsometricRenderer] terrain cache ${meta.singleSurfacePixels}px exceeds ${meta.maxSingleSurfacePixels}px; ` +
            `using uncached static terrain until chunked caches are implemented.`
        );
    }

    getTerrainCacheDiagnostics() {
        const meta = this._getTerrainCacheMeta();
        return {
            strategy: meta.strategy,
            mapSize: meta.mapSize,
            chunkSize: meta.chunkSize,
            chunksX: meta.chunksX,
            chunksY: meta.chunksY,
            chunkCount: meta.chunkCount,
            singleSurfacePixels: meta.singleSurfacePixels,
            maxSingleSurfacePixels: meta.maxSingleSurfacePixels,
            singleSurfaceWithinBudget: meta.singleSurfaceWithinBudget,
            retainedPixels: canvasPixelCount(this.terrainCache),
            artifact: { ...this._terrainArtifactStats, pendingWritePixels: canvasPixelCount(this._terrainArtifactWrite?.canvas),
                readyPixels: canvasPixelCount(this._terrainArtifactRead?.ready?.canvas) },
        };
    }

    // 3.12 — the Canvas water on the resident grammar: the mood copy of the
    // baked water (3.4), then its state (CanvasWaterState: the sunlit course,
    // swell caps and paws, crests, current, swash, rings, caustics, specks,
    // reflection ripple, the Lighthouse sheen, the sun/moon path and the 2.9
    // lamp columns).
    _drawDynamicWaterHighlights(ctx) {
        const atmosphere = this._replaySea?.atmosphere ?? this._lastAtmosphere;
        drawCanvasWaterMood(ctx, this, atmosphere);
        drawCanvasWaterState(ctx, this, atmosphere);
    }

    _drawWeatherPuddles(ctx) {
        const reactions = this._atmosphereReactions || {};
        const alphaBase = reactions.puddleAlpha || 0;
        if (alphaBase <= 0.025) return;
        const { startX, endX, startY, endY } = this._getVisibleTileBounds(2);
        const pulseFrame = this.motionScale ? this.waterFrame : STATIC_WATER_SHIMMER;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                if ((x + y) % 2 !== 0) continue;
                const key = `${x},${y}`;
                const eligible = this.townSquareTiles?.has(key)
                    || this.mainAvenueTiles?.has(key)
                    || this.pathTiles?.has(key)
                    || this.dirtPathTiles?.has(key);
                if (!eligible || this._isVisualWaterTile(x, y, key) || this.bridgeTiles?.has(key)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                if (seed < 0.58) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const pulse = this.motionScale ? (Math.sin(pulseFrame * 1.4 + seed * 7.1) + 1) / 2 : 0.55;
                const warm = reactions.warmGlint || 0;
                const alpha = Math.min(0.18, alphaBase * (0.18 + seed * 0.22 + pulse * 0.12));
                ctx.fillStyle = warm > 0.12
                    ? `rgba(255, 214, 148, ${alpha * 0.72})`
                    : `rgba(180, 230, 235, ${alpha})`;
                ctx.beginPath();
                ctx.ellipse(
                    Math.round(screenX + (seed - 0.5) * 18),
                    Math.round(screenY + 2 + (seed - 0.5) * 5),
                    7 + seed * 8,
                    2.4 + seed * 2.2,
                    -0.18 + seed * 0.32,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
                if (seed > 0.74) {
                    this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.rainSplash, {
                        x: screenX + (seed - 0.5) * 18,
                        y: screenY - 1 + (seed - 0.5) * 5,
                        alpha: Math.min(0.22, alphaBase * (0.22 + pulse * 0.18)),
                        scale: 0.58 + seed * 0.28,
                        rotation: -0.18 + seed * 0.34,
                    });
                }
            }
        }
        this._drawShorePuddles(ctx, reactions, alphaBase, pulseFrame);
        ctx.restore();
    }

    // Wet-cobble shore sheen: after rain the low shore tiles glisten with a
    // cool puddle film that warms toward gold at dawn/dusk. Tiles come from the
    // deterministic SceneryEngine subset so the sheen never strobes; per-frame
    // cost is only the pulse, and `STATIC_WATER_SHIMMER` carries the reduced-
    // motion path with a steady sheen.
    _drawShorePuddles(ctx, reactions, alphaBase, pulseFrame) {
        if (!this.wetShoreTiles?.size) return;
        const { startX, endX, startY, endY } = this._getVisibleTileBounds(2);
        const warm = reactions.warmGlint || 0;
        const night = reactions.nightReflection || 0;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.wetShoreTiles.has(key)) continue;
                if (this._isVisualWaterTile(x, y, key) || this.bridgeTiles?.has(key)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const pulse = this.motionScale ? (Math.sin(pulseFrame * 1.2 + seed * 6.3) + 1) / 2 : 0.55;
                const alpha = Math.min(0.16, alphaBase * (0.14 + seed * 0.2 + pulse * 0.1) * (1 + night * 0.2));
                ctx.fillStyle = warm > 0.12
                    ? `rgba(255, 208, 142, ${alpha * 0.7})`
                    : `rgba(168, 222, 230, ${alpha})`;
                ctx.beginPath();
                ctx.ellipse(
                    Math.round(screenX + (seed - 0.5) * 16),
                    Math.round(screenY + 3 + (seed - 0.5) * 4),
                    6 + seed * 7,
                    2.1 + seed * 1.8,
                    -0.16 + seed * 0.3,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
            }
        }
    }

    _drawSurfaceWetnessMarks(ctx, layer = 'ground') {
        const wetness = this._atmosphereReactions?.surfaceWetness || 0;
        if (wetness <= 0.03) return;

        const sparseTiles = (tiles, stride, salt) => {
            const points = [];
            if (!tiles) return points;
            let index = 0;
            for (const key of tiles) {
                if ((index++ % stride) !== 0) continue;
                const iso = isoFromTileKey(key);
                if (!iso) continue;
                points.push({
                    x: iso.x,
                    y: iso.y,
                    seed: ((iso.tileX * 13 + iso.tileY * 7 + salt) % 10) / 10,
                });
            }
            return points;
        };

        const docks = [];
        if (this.bridgeTiles?.size && (layer === 'ground' || layer === 'all')) {
            for (const [key, info] of this.bridgeTiles) {
                if (info?.kind !== 'dock') continue;
                const iso = isoFromTileKey(key);
                if (!iso) continue;
                docks.push({
                    x: iso.x,
                    y: iso.y,
                    seed: ((iso.tileX * 17 + iso.tileY * 5) % 10) / 10,
                });
            }
        }

        const roofs = [];
        if ((layer === 'roofs' || layer === 'all') && this.world?.buildings) {
            for (const building of this.world.buildings.values()) {
                const type = String(building?.type || '');
                if (type === 'watchfire') continue;
                const pos = building.position;
                if (!pos || !Number.isFinite(pos.tileX) || !Number.isFinite(pos.tileY)) continue;
                const iso = isoFromTile(
                    pos.tileX + (Number(building.width) || 1) / 2,
                    pos.tileY + (Number(building.height) || 1) / 2,
                );
                if (!iso) continue;
                roofs.push({
                    x: iso.x,
                    y: iso.y - 22,
                    seed: ((iso.tileX * 11 + iso.tileY * 3) % 10) / 10,
                });
            }
        }

        const footings = [];
        if (layer === 'ground' || layer === 'all') {
            for (const route of VILLAGE_WALL_ROUTES) {
                for (const point of route.points) {
                    const iso = isoFromTile(point.tileX, point.tileY);
                    if (!iso) continue;
                    footings.push({
                        x: iso.x,
                        y: iso.y + 10,
                        seed: 0.62,
                    });
                }
            }
        }

        const marks = collectDampMarks({
            roads: layer === 'roofs' ? [] : sparseTiles(this.pathTiles, 7, 2),
            docks: layer === 'roofs' ? [] : docks,
            roofs,
            footings: layer === 'roofs' ? [] : footings,
            wetness,
            layer,
        });
        if (!marks.length) return;

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.globalCompositeOperation = 'screen';
        for (const mark of marks) {
            if (mark.alpha <= 0.01) continue;
            // 3.2 — one instrument per fact: where an admitted source lays its
            // own coloured reflection, the anonymous damp fleck steps aside
            // instead of competing with it.
            if (this._wetReflectionCovers(mark.x, mark.y)) continue;
            const cool = mark.material === 'dock' || mark.material === 'stone';
            ctx.fillStyle = cool
                ? `rgba(168, 214, 224, ${mark.alpha})`
                : `rgba(196, 220, 228, ${mark.alpha})`;
            const x = Math.round(mark.x);
            const y = Math.round(mark.y);
            ctx.fillRect(x - 2, y, 5, 1);
            if (mark.seed > 0.55) ctx.fillRect(x, y - 1, 1, 2);
        }
        ctx.restore();
    }

    _getAtmosphereEffectSprite(id) {
        if (!id || !this.assets?.has?.(id)) return null;
        const cached = this._atmosphereEffectSpriteCache.get(id);
        if (cached) return cached;
        const img = this.assets.get(id);
        if (!img) return null;
        const dims = this.assets.getDims(id) || { w: img.width, h: img.height };
        const sprite = { img, dims };
        this._atmosphereEffectSpriteCache.set(id, sprite);
        return sprite;
    }

    _drawAtmosphereEffectSprite(ctx, id, {
        x,
        y,
        alpha = 1,
        scale = 1,
        scaleX = null,
        scaleY = null,
        rotation = 0,
        flipX = false,
    } = {}) {
        const sprite = this._getAtmosphereEffectSprite(id);
        if (!sprite || alpha <= 0.005) return false;
        const sx = (scaleX ?? scale) * (flipX ? -1 : 1);
        const sy = scaleY ?? scale;
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(Math.round(x), Math.round(y));
        if (rotation) ctx.rotate(rotation);
        ctx.scale(sx, sy);
        ctx.drawImage(sprite.img, Math.round(-sprite.dims.w / 2), Math.round(-sprite.dims.h / 2));
        ctx.restore();
        return true;
    }

    // Structures that sit on the baked ground and water: dock/causeway decks
    // and plank crossings. Land and water surfaces themselves come from the
    // GroundBake and CoastBake passes.
    _drawTerrainOverlayTiles(ctx) {
        const tiles = [];
        for (const [key, bInfo] of this.bridgeTiles || []) {
            const tile = this._parseTileKey(key);
            if (tile) tiles.push({ ...tile, bInfo });
        }
        // Row-major, as the per-tile loop drew them, so decks overlap alike.
        tiles.sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX);
        let farmBridgeDrawn = false;
        for (const { tileX, tileY, bInfo } of tiles) {
            const screenX = (tileX - tileY) * TILE_WIDTH / 2;
            const screenY = (tileX + tileY) * TILE_HEIGHT / 2;
            if (bInfo?.kind === 'dock') {
                if (bInfo.style === 'causeway') {
                    const seed = this.terrainSeed[tileY * MAP_SIZE + tileX] || 0;
                    this._drawHarborCausewayTile(ctx, screenX, screenY, bInfo.orientation || 'EW', seed);
                } else {
                    const orientation = (bInfo.orientation || 'EW').toLowerCase();
                    if (this.sprites) this.sprites.drawSprite(ctx, `dock.${orientation}`, screenX, screenY);
                }
            } else if (bInfo?.kind === 'plank') {
                // W1-C 1.5 — north-farm-bridge renders once as the cohesive
                // inked farm footbridge (`bridge.landmark.farm.ew`, mirrored
                // horizontally onto integer texels for its NS span) when the
                // asset is present; falls back to per-tile mirrored `bridge.ew`.
                if (bInfo.bridgeId === 'north-farm-bridge' && this.assets?.has?.('bridge.landmark.farm.ew')) {
                    if (!farmBridgeDrawn) {
                        farmBridgeDrawn = true;
                        const spanCenter = tileToWorld(3, 7.5);
                        this._drawMirroredPlankSprite(ctx, 'bridge.landmark.farm.ew', spanCenter.x, spanCenter.y, true);
                    }
                    continue;
                }
                // 2.8 — single-file plank crossings use the per-tile
                // bridge.${orientation} asset (the pond plank's bridge.ew),
                // mirroring the dock tile path. An NS plank mirrors bridge.ew
                // horizontally onto integer texels when no bridge.ns exists.
                const orientation = (bInfo.orientation || 'EW').toLowerCase();
                if (this.sprites) {
                    const spriteId = `bridge.${orientation}`;
                    if (this.assets?.has?.(spriteId)) {
                        this.sprites.drawSprite(ctx, spriteId, screenX, screenY);
                    } else if (orientation === 'ns' && this.assets?.has?.('bridge.ew')) {
                        this._drawMirroredPlankSprite(ctx, 'bridge.ew', screenX, screenY);
                    }
                }
            }
        }
    }

    _mirroredPlankPlacement(id, wx, wy, useWinter) {
        const img = (useWinter ? this.propWinter?.image?.(id) : null) || this.assets?.get?.(id);
        if (!img) return null;
        const dims = this.assets.getDims(id) || { w: img.width, h: img.height };
        const [ax, ay] = this.assets.getAnchor(id);
        return { id, img, dims, x: Math.round(wx) - Math.round(ax), y: Math.round(wy - ay) };
    }

    _drawMirroredPlankSprite(ctx, id, wx, wy, useWinter = false) {
        const placement = this._mirroredPlankPlacement(id, wx, wy, useWinter);
        if (!placement) return;
        const tx = Math.round(wx);
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.translate(tx, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(placement.img, tx - placement.x - placement.dims.w, placement.y);
        ctx.restore();
    }

    _litFarmBridgePlacement() {
        const id = 'bridge.landmark.farm.ew';
        if (this.bridgeTiles?.get?.('3,7')?.bridgeId !== 'north-farm-bridge' || !this.assets?.has?.(id)
            || !this.bridgeLightsLit({ start: tileToWorld(3, 5), end: tileToWorld(3, 10) })) return null;
        const mid = tileToWorld(3, 7.5);
        return this._mirroredPlankPlacement(id, mid.x, mid.y, true);
    }

    _drawHarborCausewayTile(ctx, screenX, screenY, orientation = 'EW', seed = 0) {
        const halfW = TILE_WIDTH * 0.50;
        const halfH = TILE_HEIGHT * 0.35;
        const lift = 2;
        ctx.save();
        ctx.translate(screenX, screenY - lift);

        ctx.globalAlpha = 0.78;
        ctx.fillStyle = 'rgba(29, 20, 14, 0.52)';
        ctx.beginPath();
        ctx.moveTo(0, -halfH + 4);
        ctx.lineTo(halfW + 5, 2);
        ctx.lineTo(0, halfH + 7);
        ctx.lineTo(-halfW - 5, 2);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 0.98;
        ctx.fillStyle = '#aa8859';
        ctx.strokeStyle = '#2b1b12';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, -halfH);
        ctx.lineTo(halfW, 0);
        ctx.lineTo(0, halfH);
        ctx.lineTo(-halfW, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#e0c488';
        ctx.lineWidth = 1;
        const cross = orientation === 'NS'
            ? [[-17, -8, 15, 8], [-10, -13, 22, 3], [-22, -2, 10, 14]]
            : [[-19, 6, 13, -10], [-9, 12, 23, -4], [-24, -2, 7, -16]];
        for (const [x1, y1, x2, y2] of cross) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.48;
        ctx.strokeStyle = '#5f3d22';
        ctx.lineWidth = 1.2;
        for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(-halfW + 8, side * 2);
            ctx.lineTo(halfW - 8, side * -2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.86;
        ctx.strokeStyle = '#46311f';
        ctx.lineWidth = 1.2;
        for (const side of [-1, 1]) {
            const bob = this.motionScale ? Math.sin(this.waterFrame * 1.8 + seed * 8 + side) * 0.5 : 0;
            ctx.beginPath();
            ctx.moveTo(side * (halfW - 4), -1 + bob);
            ctx.lineTo(side * (halfW - 7), -14 + bob);
            ctx.stroke();
        }

        ctx.restore();
    }

    _buildBridgeSpans() {
        if (!this.bridgeTiles?.size) return [];

        const spans = [];
        const visited = new Set();
        const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const isBridgeDeck = (key, bridgeInfo) => {
            const info = this.bridgeTiles.get(key);
            return info?.kind === 'landmark'
                && info.orientation === bridgeInfo.orientation
                && (info.bridgeId || null) === (bridgeInfo.bridgeId || null);
        };

        for (const [key, info] of this.bridgeTiles.entries()) {
            if (visited.has(key) || info?.kind !== 'landmark') continue;

            const orientation = info?.orientation || 'EW';
            const queue = [key];
            const tiles = [];
            visited.add(key);

            while (queue.length) {
                const current = queue.shift();
                const comma = current.indexOf(',');
                const x = Number(current.slice(0, comma));
                const y = Number(current.slice(comma + 1));
                tiles.push({ x, y });

                for (const [dx, dy] of directions) {
                    const next = `${x + dx},${y + dy}`;
                    if (visited.has(next) || !isBridgeDeck(next, info)) continue;
                    visited.add(next);
                    queue.push(next);
                }
            }

            if (tiles.length) {
                spans.push(this._bridgeSpanFromTiles(tiles, orientation, info));
            }
        }

        return spans.sort((a, b) => a.depth - b.depth);
    }

    _bridgeSpanFromTiles(tiles, orientation, info = {}) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        for (const tile of tiles) {
            minX = Math.min(minX, tile.x);
            maxX = Math.max(maxX, tile.x);
            minY = Math.min(minY, tile.y);
            maxY = Math.max(maxY, tile.y);
        }

        const isEastWest = orientation === 'EW';
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const startTile = isEastWest
            ? { x: minX - 0.45, y: centerY }
            : { x: centerX, y: minY - 0.45 };
        const endTile = isEastWest
            ? { x: maxX + 0.45, y: centerY }
            : { x: centerX, y: maxY + 0.45 };
        const axisVector = isEastWest
            ? { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 }
            : { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };
        const crossVector = isEastWest
            ? { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 }
            : { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };
        const crossLength = Math.hypot(crossVector.x, crossVector.y) || 1;
        const axisLength = Math.hypot(axisVector.x, axisVector.y) || 1;
        const lengthTiles = isEastWest ? maxX - minX + 1 : maxY - minY + 1;
        const crossTiles = isEastWest ? maxY - minY + 1 : maxX - minX + 1;

        return {
            id: info.bridgeId || null,
            style: info.style || 'civic',
            orientation,
            start: this._tileToScreen(startTile.x, startTile.y),
            end: this._tileToScreen(endTile.x, endTile.y),
            axisUnit: { x: axisVector.x / axisLength, y: axisVector.y / axisLength },
            crossUnit: { x: crossVector.x / crossLength, y: crossVector.y / crossLength },
            halfWidth: Math.max(34, Math.min(54, 24 + crossTiles * 8)),
            deckRise: info.deckRise || 0,
            deckProfile: info.deckProfile || null,
            nearRail: info.nearRail || null,
            laneOffsetPx: info.laneOffsetPx ?? null,
            treeExclusion: info.treeExclusion !== false,
            underDeckShadow: info.underDeckShadow !== false,
            centerTile: { x: centerX, y: centerY },
            lengthTiles,
            depth: (centerX + centerY) * TILE_HEIGHT / 2,
        };
    }

    _tileToScreen(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _drawLandmarkBridgeSpans(ctx) {
        if (!this.bridgeSpans?.length) return;

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        for (const span of this.bridgeSpans) {
            this._drawLandmarkBridgeSpan(ctx, span);
        }
        ctx.restore();
    }

    _bridgePoint(span, t, crossOffset = 0, verticalLift = 0, drop = 0) {
        const arch = Math.sin(Math.PI * t);
        const x = span.start.x + (span.end.x - span.start.x) * t + span.crossUnit.x * crossOffset;
        const y = span.start.y + (span.end.y - span.start.y) * t + span.crossUnit.y * crossOffset - arch * span.deckRise - verticalLift + drop;
        return { x, y };
    }

    getBridgeLift(tileX, tileY) {
        if (!this.bridgeSpans?.length) return 0;
        const point = this._tileToScreen(tileX, tileY);
        for (const span of this.bridgeSpans) {
            if (span.deckProfile) {
                const lift = this._bridgeProfileLift(span, tileX, tileY);
                if (lift > 0) return lift;
                continue;
            }
            const dx = point.x - span.start.x;
            const dy = point.y - span.start.y;
            const axisLength = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) || 1;
            const along = dx * span.axisUnit.x + dy * span.axisUnit.y;
            const cross = dx * span.crossUnit.x + dy * span.crossUnit.y;
            if (along < 0 || along > axisLength || Math.abs(cross) > span.halfWidth) continue;
            return Math.sin(Math.PI * along / axisLength) * span.deckRise;
        }
        return 0;
    }

    // A span's art-measured deck (`deckProfile`, scenery.js BRIDGE_HINTS):
    // [along, lift] pairs, `along` in tiles from the span's centre along its
    // axis (+ toward the larger tile coordinate), `lift` in px, linear between
    // points and 0 past the first and last, so the stairs ramp the feet
    // onto the planks. The lift holds across the walk column (half a tile
    // either side of the centre line) and fades to 0 a tile out, so a body
    // turning off the stairs onto the bank steps down rather than drops.
    _bridgeProfileLift(span, tileX, tileY) {
        const eastWest = span.orientation === 'EW';
        const across = Math.abs(eastWest ? tileY - span.centerTile.y : tileX - span.centerTile.x);
        if (across >= 1) return 0;
        const lift = bridgeProfileAt(span.deckProfile, eastWest ? tileX - span.centerTile.x : tileY - span.centerTile.y);
        return across <= 0.5 ? lift : lift * (1 - across) * 2;
    }

    // The busiest walk keeps a clear verge: no trunk within
    // AVENUE_TREE_CLEARANCE tiles of a busy-walk tile (the authored avenue
    // network; a paved lane keeps its trees).
    _nearMainAvenue(tileX, tileY) {
        const reach = AVENUE_TREE_CLEARANCE;
        for (let y = Math.floor(tileY - reach); y <= Math.floor(tileY + reach); y++) {
            for (let x = Math.floor(tileX - reach); x <= Math.floor(tileX + reach); x++) {
                if (!this.busyWalkTiles?.has(`${x},${y}`)) continue;
                const dx = tileX - Math.max(x, Math.min(tileX, x + 1));
                const dy = tileY - Math.max(y, Math.min(tileY, y + 1));
                if (dx * dx + dy * dy < reach * reach) return true;
            }
        }
        return false;
    }

    _isInBridgeTreeExclusion(tileX, tileY) {
        if (!this.bridgeSpans?.length) return false;
        const p = this._tileToScreen(tileX, tileY);
        for (const span of this.bridgeSpans) {
            if (span.treeExclusion === false) continue;
            const dx = p.x - span.start.x;
            const dy = p.y - span.start.y;
            const axisLength = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) || 1;
            const along = dx * span.axisUnit.x + dy * span.axisUnit.y;
            const cross = Math.abs(dx * span.crossUnit.x + dy * span.crossUnit.y);
            const rampPad = 40;
            const crossPad = span.halfWidth + 8;
            if (along >= -rampPad && along <= axisLength + rampPad && cross <= crossPad) {
                return true;
            }
        }
        return false;
    }

    _bridgeSidePoints(span, crossOffset, verticalLift = 0, drop = 0, steps = 14) {
        const points = [];
        for (let i = 0; i <= steps; i++) {
            points.push(this._bridgePoint(span, i / steps, crossOffset, verticalLift, drop));
        }
        return points;
    }

    _traceBridgeRibbon(ctx, leftPoints, rightPoints) {
        ctx.beginPath();
        ctx.moveTo(leftPoints[0].x, leftPoints[0].y);
        for (let i = 1; i < leftPoints.length; i++) ctx.lineTo(leftPoints[i].x, leftPoints[i].y);
        for (let i = rightPoints.length - 1; i >= 0; i--) ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
        ctx.closePath();
    }

    // Bridge/water contact: a tight multiply shadow pooling under the deck.
    // Baked with the span; no motion.
    _drawBridgeUnderDeckWaterShadow(ctx, span) {
        if (span.underDeckShadow === false) return;
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        this._traceBridgeRibbon(
            ctx,
            this._bridgeSidePoints(span, -span.halfWidth - 2, 0, 20, 10),
            this._bridgeSidePoints(span, span.halfWidth + 2, 0, 20, 10)
        );
        ctx.fillStyle = 'rgba(52, 74, 86, 0.42)';
        ctx.fill();
        ctx.restore();
    }

    _bridgeSpriteId(span) {
        const orientation = (span.orientation || 'EW').toLowerCase();
        const style = span.style || 'civic';
        return `bridge.landmark.${style}.${orientation}`;
    }

    _bridgeSpritePlacement(span) {
        if (!this.assets) return null;
        const spriteId = this._bridgeSpriteId(span);
        if (this.assets.has && !this.assets.has(spriteId)) return null;
        const img = this.propWinter.image(spriteId) || this.assets.get(spriteId);
        const dims = this.assets.getDims(spriteId);
        if (!img || !dims) return null;
        const [anchorX, anchorY] = this.assets.getAnchor(spriteId);
        const midX = (span.start.x + span.end.x) / 2;
        const midY = (span.start.y + span.end.y) / 2;
        return {
            img,
            dims,
            x: Math.round(midX - anchorX),
            y: Math.round(midY - anchorY),
        };
    }

    _drawLandmarkBridgeSpan(ctx, span) {
        this._drawBridgeUnderDeckWaterShadow(ctx, span);
        const placement = this._bridgeSpritePlacement(span);
        if (!placement) return;
        ctx.drawImage(
            placement.img,
            placement.x,
            placement.y,
            placement.dims.w,
            placement.dims.h
        );
    }

    _worldDiamondPoints() {
        const last = MAP_SIZE - 1;
        return [
            { x: 0, y: -WORLD_EDGE_PAD_Y },
            { x: last * TILE_WIDTH / 2 + WORLD_EDGE_PAD_X, y: last * TILE_HEIGHT / 2 },
            { x: 0, y: last * TILE_HEIGHT + WORLD_EDGE_PAD_Y },
            { x: -last * TILE_WIDTH / 2 - WORLD_EDGE_PAD_X, y: last * TILE_HEIGHT / 2 },
        ];
    }

    // 3.4 — the outer ocean beyond the island: one cached, quarter-resolution
    // canvas of dithered depth bands (deepest at the island, lighter only
    // toward the horizon, three static swell rows), scaled nearest-neighbour
    // with the camera. Rebaked by CoastBake only when the quantized grade,
    // water mood, horizon haze or glint bucket changes; one drawImage per
    // frame replaces the old per-frame gradients and animated swells. On the
    // resident path the 2D canvas is ungraded, so the palette arrives
    // pre-graded; Canvas grades the whole frame afterwards.
    _drawDistantSeaHorizon(ctx, atmosphere, { gpuGraded = false } = {}) {
        if (this.replay && !gpuGraded) {
            // Recolor the baked sea strip and its water chunks together. The
            // sky and the procedural swell continue at the frame clock.
            const second = Math.floor(this.replay.replayClock.playhead / 1000);
            if (this._replaySea?.second !== second) this._replaySea = { second, atmosphere };
            atmosphere = this._replaySea.atmosphere;
        }
        drawOuterOcean(ctx, this, atmosphere, { gpuGraded });
    }

    _waterOpenness(tileX, tileY) {
        const meta = this._waterMetaAt(tileX, tileY);
        if (Number.isFinite(Number(meta?.openness))) return Number(meta.openness);
        let waterNeighbors = 0;
        let checks = 0;
        for (let y = tileY - 1; y <= tileY + 1; y++) {
            for (let x = tileX - 1; x <= tileX + 1; x++) {
                if (x === tileX && y === tileY) continue;
                checks++;
                if (this.waterTiles.has(`${x},${y}`)) waterNeighbors++;
            }
        }
        return checks ? waterNeighbors / checks : 0;
    }

    _isOpenSeaTile(tileX, tileY, openness = null) {
        const key = `${tileX},${tileY}`;
        if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) return false;
        if (!this.deepWaterTiles.has(key)) return false;
        const open = openness ?? this._waterOpenness(tileX, tileY);
        if (open < 0.62) return false;
        const region = this._waterRegionAt(tileX, tileY, key);
        const profile = this._waterProfileAt(tileX, tileY, key);
        return region === 'openSea' || region === 'sea' || profile === 'openSea';
    }

    _drawFishSchools(ctx) {
        this.wildlifeRenderer.drawFishSchools(ctx);
    }

    _drawWaterfowl(ctx) {
        this.wildlifeRenderer.drawWaterfowl(ctx);
    }

    _drawLandBirds(ctx) {
        this.wildlifeRenderer.drawLandBirds(ctx);
    }

    _drawOpenSeaGulls(ctx) {
        this.wildlifeRenderer.drawOpenSeaGulls(ctx);
    }

    _drawSkyCanopy(ctx, atmosphere = null, dt = 16, motionScale = null) {
        const canvas = this._screenViewport();
        if (!canvas || !this.skyRenderer) return;
        ctx.save();
        this._resetScreenTransform(ctx);
        this.skyRenderer.drawCanopy(ctx, { canvas, camera: this.camera, atmosphere, dt, motionScale });
        ctx.restore();
    }

    _tileToWorld(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _familiarMoteLightSources(lighting = null) {
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return [];
        const sources = [];
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            sources.push(...familiarMoteLightSources({
                parentSprite,
                childSprites,
                childAgents: departedChildren,
                now,
                motionScale: this.motionScale,
                lighting,
            }));
        }
        return sources;
    }

    // Shared fixture gate for cached emission and light records, without
    // importing BuildingSprite into the terrain/emitter helper graph.
    villageLampsLit() {
        return lampsLitAt(this._lastAtmosphere);
    }

    // D4 — the Lamplighter's Round: `(tileX, tileY) => lit` for this
    // atmosphere snapshot. Clock and fixed geography only (never agent
    // state); reduced motion keeps the shared lamp clock.
    lampRoundLit() {
        const atmosphere = this._lastAtmosphere;
        const motionScale = this.motionScale ?? 1;
        const cached = this._lampRoundCache;
        if (cached && cached.atmosphere === atmosphere && cached.motionScale === motionScale) return cached.lit;
        const lit = lampRoundFor(atmosphere, { motionScale });
        this._lampRoundCache = { atmosphere, motionScale, lit };
        return lit;
    }

    // The street lamps and braziers already caught on the round.
    _litLanternGlowSources() {
        const lit = this.lampRoundLit();
        return this._lanternGlowSources().filter(source => lit(source.tileX, source.tileY));
    }

    _lanternGroundLightSources(lighting = null) {
        if (!this.villageLampsLit()) return [];
        const energy = sourceEnergyFor(lighting);
        const core = energy.core;
        const reach = fixturePoolReach(energy);
        // V5 — a village lantern or brazier stands on its tile (the flame
        // source sits 10 px above it), its flame 16 (brazier) / 24 (lantern)
        // world px up: the pool lands around the foot, and the post, the
        // walls and the bodies around it light by their height and facing.
        return this._litLanternGlowSources().map((source) => {
            const isBrazier = source.fixture === 'brazier';
            const foot = { x: source.x, y: source.y + 10 };
            const height = isBrazier ? 16 : 24;
            return normalizeLightSource({
                id: `village.${source.fixture}.${source.tileX}.${source.tileY}`,
                kind: 'point',
                role: 'fixture',
                x: foot.x,
                y: foot.y - height,
                ground: foot,
                height,
                fire: isBrazier,
                color: isBrazier ? '#ffa94a' : '#ffc95e',
                radius: Math.round(Math.min(isBrazier ? BRAZIER_POOL_RADIUS : STREET_LAMP_POOL_RADIUS, SOURCE_HALO_RADIUS_CAP) * reach),
                intensity: (isBrazier ? 0.94 : 0.82) * core,
            });
        }).concat(this._hearthLightSources(lighting));
    }

    // W6.9 / W6.10 — the hearths (gatehouse guard rooms, lake shrine), the
    // calendar's lit bonfire and the bridges' painted flames (BR-6): fixtures
    // on the village lamp clock (LightSourceRegistry.hearthLightSources) that
    // never read occupancy, so no work building lights without a working visitor.
    _hearthLightSources(lighting = null) {
        const lampsLit = lampsLitAt(this._lastAtmosphere);
        if (!lampsLit) return [];
        const extra = [
            ...(this.villageCalendar?.lightFixtures?.() || []),
            ...(this.isleLandmarks?.lightFixtures?.() || []),
        ];
        // D4 — each hearth catches on the round with the lamps.
        const lit = this.lampRoundLit();
        const caught = row => lit(row.tileX, row.tileY);
        const lights = hearthLightSources({
            lampsLit,
            core: sourceEnergyFor(lighting).core,
            // BR-6 — a bridge's lights catch together (bridgeLightsLit).
            extra: [...extra.filter(caught), ...this._bridgeLightFixtures()],
            fixtures: HEARTH_FIXTURES.filter(caught),
        });
        for (const light of lights) {
            const tile = worldToTile(light.ground);
            const h = supportHeight(tile.tileX, tile.tileY, this.surfaceRegistry);
            light.y -= h;
            light.origin.y -= h;
            light.ground.y -= h;
        }
        return lights;
    }

    // BR-6 / C2 — the light points a bridge sprite declares in its manifest
    // entry, `lights: [{ at: [x, y], height, radius? }]` in sprite px from
    // the PNG's top-left (like `anchor`): `at` is a painted flame, `height`
    // the px down to where its post stands (the light's foot, where its pool
    // lands, as a street lamp's). The points belong to the art, so they live
    // with the sprite, not its BRIDGE_HINTS entry, and sit wherever
    // `_bridgeSpritePlacement` draws it: a new bridge sprite (the trestle's
    // end-post lanterns) lights by manifest data alone. Rows for
    // `_hearthLightSources`' extras: steady all night, and only once the
    // bridge has caught on the round.
    _bridgeLightFixtures() {
        const out = [];
        for (const span of this.bridgeSpans || []) {
            const spriteId = this._bridgeSpriteId(span);
            const lights = this.assets?.getEntry?.(spriteId)?.lights;
            if (!Array.isArray(lights) || !lights.length || !this.bridgeLightsLit(span)) continue;
            const placement = this._bridgeSpritePlacement(span);
            if (!placement) continue;
            lights.forEach((light, index) => {
                const [sx, sy] = Array.isArray(light?.at) ? light.at : [];
                if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
                const height = Math.max(0, Number(light.height) || 0);
                const foot = worldToTile(placement.x + sx, placement.y + sy + height);
                out.push({
                    id: `bridge-light:${span.id || spriteId}:${index}`,
                    tileX: foot.tileX,
                    tileY: foot.tileY,
                    height,
                    radius: Math.min(Number(light.radius) || BRIDGE_LIGHT_POOL_RADIUS, SOURCE_HALO_RADIUS_CAP),
                    intensity: BRIDGE_LIGHT_INTENSITY,
                    color: BRIDGE_LIGHT_COLOR,
                });
            });
        }
        const farm = this._litFarmBridgePlacement();
        const farmLights = farm && this.assets.getEntry?.(farm.id)?.lights;
        if (Array.isArray(farmLights)) {
            farmLights.forEach((light, index) => {
                const [sx, sy] = Array.isArray(light?.at) ? light.at : [];
                if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
                const height = Math.max(0, Number(light.height) || 0);
                const wx = farm.x + farm.dims.w - 1 - sx;
                const wy = farm.y + sy + height;
                const foot = worldToTile(wx, wy);
                out.push({
                    id: `bridge-light:north-farm-bridge:${index}`,
                    tileX: foot.tileX,
                    tileY: foot.tileY,
                    height,
                    radius: Math.min(Number(light.radius) || BRIDGE_LIGHT_POOL_RADIUS, SOURCE_HALO_RADIUS_CAP),
                    intensity: BRIDGE_LIGHT_INTENSITY,
                    color: BRIDGE_LIGHT_COLOR,
                });
            });
        }
        return out;
    }

    // BR-6 — a bridge's lights (its declared light points and its flame
    // sidecar, EmitterCuts) burn while the village lamps are lit and the
    // Lamplighter's Round has reached the bridge's middle: one held step for
    // the whole bridge, so its flames and pools never disagree.
    bridgeLightsLit(span) {
        if (!span || !this.villageLampsLit()) return false;
        const middle = worldToTile((span.start.x + span.end.x) / 2, (span.start.y + span.end.y) / 2);
        return this.lampRoundLit()(middle.tileX, middle.tileY) === true;
    }

    _attentionLightSources() {
        const ledger = signalBuckets(this.world);
        const sources = [];
        for (const [bucket, style] of Object.entries(ATTENTION_LIGHT_STYLES)) {
            for (const agent of ledger[bucket]) {
                const sprite = this.agentSprites.get(agent.id);
                if (!sprite || sprite.isArrivalPending?.()) continue;
                // V5 / 2.5 — the attention light stands on its owner's foot
                // (V7's one placement value), 4 world px up, and lights only
                // that owner's ground and body (`ownerId` -> V9 owner slot).
                const foot = {
                    x: Number.isFinite(sprite._placeX) ? sprite._placeX : sprite.x,
                    y: Number.isFinite(sprite._placeY) ? sprite._placeY : sprite.y,
                };
                sources.push({
                    ...normalizeLightSource({
                        id: `attention:${bucket}:${agent.id}`,
                        kind: 'point',
                        role: 'attention',
                        x: foot.x,
                        y: foot.y - ATTENTION_LIGHT_HEIGHT,
                        ground: foot,
                        height: ATTENTION_LIGHT_HEIGHT,
                        ownerId: agent.id,
                        radius: style.radius,
                        color: style.color,
                        intensity: style.intensity,
                        priority: GPU_ATTENTION_LIGHT_PRIORITY,
                    }),
                    attention: bucket,
                });
            }
        }
        return sources;
    }

    setVisualBeat(beat) {
        this._visualBeat = beat || null;
        this.ritualConductor?.setVisualBeat?.(this._visualBeat);
        this.chimneySmoke?.setVisualBeat?.(this._visualBeat);
        this.wildlifeRenderer?.setVisualBeat?.(this._visualBeat);
        setRestSeatVisualBeat(this._visualBeat);
    }

    _trailSurfaceAt(worldX, worldY) {
        const classes = this.groundField?.CLASS || GROUND_CLASS;
        const cls = this.groundField?.classAt?.(worldX, worldY);
        if (cls === classes.WATER) return 'water';
        if (cls === classes.SAND) {
            const coastField = this._coastField || this.coastField;
            const dist = coastField?.signedDistanceAtWorld?.(worldX, worldY);
            // CoastBake WET_SAND_DITHER is -0.27 tiles on land; keep swash tolerance to +0.65.
            if (Number.isFinite(dist) && dist >= -0.27 && dist <= 0.65) return 'wet-shore';
            return 'sand';
        }
        return 'land';
    }

    _syncWave3LiveSystems(agents, allSprites, now) {
        const weather = this._lastAtmosphere?.weather || null;
        const lightGrade = this._lastAtmosphere?.lightGrade || null;
        const hasMotionTime = Number.isFinite(this.motionTimeMs);
        const motionTimeMs = hasMotionTime ? this.motionTimeMs : null;
        const archive = this.world?.buildings?.get?.('archive');
        const archivePoint = archive ? buildingCenterToWorld(archive) : null;
        this._seatedSeatByAgent ||= new Map();
        this._allyNodCooldowns ||= new Map();

        // 1. Live-only compaction rites (never backfill on first sight).
        if (!this._compactionsPrimedOnce && agents.length > 0) {
            this._compactionsPrimedOnce = true;
            this.arrivalDeparture?.primeCompactions?.(agents);
        } else if (this.arrivalDeparture) {
            for (const agent of agents) {
                if (!agent?.compactions?.length) continue;
                const sprite = this.agentSprites?.get?.(agent.id);
                if (sprite) {
                    this.arrivalDeparture.observeAgentCompactions(agent, sprite, {
                        archivePoint,
                        wallNow: now,
                    });
                }
            }
        }

        // 2. Weather/clock/grade refs on sprites + physical sit/leave bench patina observation.
        const liveIds = new Set();
        for (const sprite of allSprites) {
            const agent = sprite?.agent;
            if (!agent?.id) continue;
            liveIds.add(agent.id);
            sprite._weather = weather;
            sprite._weatherDate = this._lastAtmosphere?.effectiveDate || null;
            sprite.overlayLightGrade = lightGrade;
            if (hasMotionTime) sprite._motionTimeMs = motionTimeMs;
            const seatId = sprite._seatedSeat?.()?.id || null;
            if (this._evensongActive && archivePoint && !seatId && !sprite.moving && !sprite.chatting
                && sprite.animState === 'idle' && !isAgentDeparted(agent) && !sprite.isArrivalPending?.()) {
                sprite._setFacingGoal?.(dirFromVelocity(archivePoint.x - sprite.x,
                    archivePoint.y - (sprite._visualAnchorY?.() ?? sprite.y)));
            }
            if (!this._seatedSeatByAgent.has(agent.id)) {
                // First sighting baseline: never double-count an already-seated villager on reload.
                this._seatedSeatByAgent.set(agent.id, seatId);
            } else {
                const prevSeat = this._seatedSeatByAgent.get(agent.id) || null;
                if (seatId !== prevSeat) {
                    this._seatedSeatByAgent.set(agent.id, seatId);
                    const repoColorIndex = agent.projectPath ? (repoProfile(agent.projectPath)?.pennantIndex ?? 0) : 0;
                    this.biographyService?.observeRestSeat?.(agent, seatId, repoColorIndex);
                }
            }
        }
        for (const id of this._seatedSeatByAgent.keys()) {
            if (!liveIds.has(id)) this._seatedSeatByAgent.delete(id);
        }

        // 3. Carried artifacts (EFFECT_BUDGET['carried-artifacts']) & workflow ribbons.
        const level = this.gpuWorld?._compositeQualityLevel
            ?? (this.postFx?.isActive?.() === true ? (this.postFx?.ladder?.effectiveLevel ?? 0) : 0);
        const artifactBudget = effectBudgetMode('carried-artifacts', level);
        const zoom = this.camera?.zoom || 1;
        const camera = this.camera;
        const canvas = camera?.canvas;
        const centre = camera ? {
            x: -camera.x + (canvas?._claudeVilleCssWidth || canvas?.clientWidth || 0) / (2 * zoom),
            y: -camera.y + (canvas?._claudeVilleCssHeight || canvas?.clientHeight || 0) / (2 * zoom),
        } : null;
        const mends = this.agentEventStream?._mends || null;
        const artifactCandidates = [];
        for (const sprite of allSprites) {
            sprite.carriedArtifact = null;
            if (!sprite?.agent?.id) continue;
            const resolved = resolveCarriedArtifact(sprite.agent, {
                now,
                mendLedger: mends,
                casualStroll: sprite.visitRole === 'stroll'
                    || sprite.visitRole === 'errand'
                    || sprite.visitRole === 'winddown',
                idleWalk: sprite.agent.status === AgentStatus.IDLE && Boolean(sprite.moving),
            });
            if (resolved) {
                artifactCandidates.push({
                    id: sprite.agent.id,
                    sprite,
                    x: sprite.x,
                    y: sprite.y,
                    moving: sprite.moving,
                    selected: sprite.selected,
                    artifact: resolved,
                });
            }
        }
        const admittedArtifacts = selectCarriedArtifacts(artifactCandidates, {
            budget: artifactBudget,
            zoom,
            centre,
        });
        for (const entry of admittedArtifacts) {
            if (entry.sprite) entry.sprite.carriedArtifact = entry.artifact;
        }
        this._workflowRibbons = assignWorkflowRibbons(agents);
        const ribbonsByAgentId = this._workflowRibbons?.byAgentId || null;
        for (const sprite of allSprites) {
            if (!sprite) continue;
            const id = sprite.agent?.id;
            sprite.workflowRibbon = id != null && ribbonsByAgentId
                ? ribbonsByAgentId.get(String(id)) || null
                : null;
        }

        // 4. Passing PairAffinity ally nod (quiet 1px head dip with 30 s pair cooldown).
        if (this._allyNodCooldowns.size) {
            for (const [pairKey, expiry] of this._allyNodCooldowns) {
                if (expiry <= now) this._allyNodCooldowns.delete(pairKey);
            }
        }
        if (this.motionScale > 0 && allSprites.length >= 2) {
            const nodNow = hasMotionTime ? motionTimeMs : now;
            let collaboratorsByKey = null;
            for (let i = 0; i < allSprites.length; i++) {
                const a = allSprites[i];
                if (!a?.agent) continue;
                const keyA = AgentBiography.identityKeyFor(a.agent);
                if (!keyA) continue;
                for (let j = i + 1; j < allSprites.length; j++) {
                    const b = allSprites[j];
                    if (!b?.agent) continue;
                    if (!a.moving && !b.moving) continue;
                    const dx = a.x - b.x;
                    const dy = a.y - b.y;
                    if (dx * dx + dy * dy > 38 * 38) continue;
                    const keyB = AgentBiography.identityKeyFor(b.agent);
                    if (!keyB || keyB === keyA) continue;
                    const pairKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
                    if (now < (this._allyNodCooldowns.get(pairKey) || 0)) continue;
                    let isAlly = false;
                    if (typeof this.affinityService?.collaboratorsFor === 'function') {
                        collaboratorsByKey ||= new Map();
                        let collaborators = collaboratorsByKey.get(keyA);
                        if (!collaborators) {
                            collaborators = this.affinityService.collaboratorsFor(keyA, now) || [];
                            collaboratorsByKey.set(keyA, collaborators);
                        }
                        isAlly = collaborators.some(other => other?.identityKey === keyB && other?.tier === 'allies');
                    } else if (typeof a._patina?.allyNodEligible === 'function') {
                        isAlly = a._patina.allyNodEligible(keyB);
                    }
                    if (!isAlly) continue;
                    this._allyNodCooldowns.set(pairKey, now + 30_000);
                    a.triggerAllyNod?.(nodNow);
                    b.triggerAllyNod?.(nodNow);
                }
            }
        }
    }

    _admitFrameReportCairns(sortedSprites, zoom = this.camera?.zoom || 1) {
        for (const sprite of this.agentSprites?.values?.() || []) {
            if (sprite) sprite._cairnSpec = null;
        }
        for (const sprite of sortedSprites || []) {
            if (sprite) sprite._cairnSpec = null;
        }
        if (Number(zoom) < ARTIFACT_MIN_ZOOM || !sortedSprites?.length) return [];

        const childTrims = this._childTrimById ||= new Map();
        const spriteById = new Map();
        for (const sprite of this.agentSprites?.values?.() || []) {
            if (sprite?.agent?.id) spriteById.set(sprite.agent.id, sprite);
        }
        for (const sprite of sortedSprites) {
            if (sprite?.agent?.id && !spriteById.has(sprite.agent.id)) {
                spriteById.set(sprite.agent.id, sprite);
            }
        }

        const agentsById = new Map();
        for (const agent of this.world?.agents?.values?.() || []) {
            if (agent?.id) agentsById.set(agent.id, agent);
        }
        for (const [id, sprite] of spriteById) {
            if (!agentsById.has(id) && sprite?.agent) agentsById.set(id, sprite.agent);
        }

        const squadsByParent = new Map();
        const ensureSquad = (parentId) => {
            let entry = squadsByParent.get(parentId);
            if (!entry) {
                entry = {
                    outstandingIds: new Set(),
                    completedLiveIds: new Set(),
                    departedOrRetainedIds: new Set(),
                    returnedOrder: [],
                    returnedSeen: new Set(),
                };
                squadsByParent.set(parentId, entry);
            }
            return entry;
        };
        const recordReturned = (entry, childId) => {
            if (!entry.returnedSeen.has(childId)) {
                entry.returnedSeen.add(childId);
                entry.returnedOrder.push(childId);
            }
        };

        const retainedChildIds = new Set();
        for (const agent of agentsById.values()) {
            const parentId = agent.parentSessionId || agent.parentId || null;
            if (!parentId) continue;
            const childSprite = spriteById.get(agent.id) || null;
            const trim = childSprite?._providerTrimColor?.() || null;
            if (trim) childTrims.set(agent.id, trim);
            retainedChildIds.add(agent.id);

            const entry = ensureSquad(parentId);
            if (isAgentDeparted(agent)) {
                entry.departedOrRetainedIds.add(agent.id);
                recordReturned(entry, agent.id);
            } else if (agent.status === AgentStatus.COMPLETED) {
                entry.completedLiveIds.add(agent.id);
                recordReturned(entry, agent.id);
            } else {
                entry.outstandingIds.add(agent.id);
            }
        }

        const returnedByParent = this.relationshipState?._returnedByParent;
        if (returnedByParent && typeof returnedByParent.entries === 'function') {
            for (const [parentId, childIds] of returnedByParent.entries()) {
                const entry = ensureSquad(parentId);
                for (const childId of childIds || []) {
                    retainedChildIds.add(childId);
                    if (entry.outstandingIds.has(childId) || entry.completedLiveIds.has(childId)) continue;
                    entry.departedOrRetainedIds.add(childId);
                    recordReturned(entry, childId);
                }
            }
        }

        const rollupRows = this.relationshipState?.getSquadRollups?.()
            || this.relationshipState?.getSnapshot?.()?.squads
            || [];
        const rollupByParent = new Map();
        for (const row of rollupRows) {
            if (row?.parentId) rollupByParent.set(row.parentId, row);
        }

        for (const childId of childTrims.keys()) {
            if (!retainedChildIds.has(childId)) childTrims.delete(childId);
        }

        const gov = this.markGovernor || getActiveMarkGovernor();
        const doorCounts = new Map();
        const admittedCairns = [];
        let viewCount = 0;

        for (const sprite of sortedSprites) {
            if (viewCount >= CAIRN_VIEW_CAP) break;
            const agent = sprite?.agent;
            if (!agent?.id || sprite.moving || isAgentDeparted(agent) || sprite.isArrivalPending?.()) continue;
            const entry = squadsByParent.get(agent.id);
            const rollup = rollupByParent.get(agent.id);
            if (!entry && !rollup) continue;

            const completedLive = entry ? entry.completedLiveIds.size : 0;
            const departedOrRetained = entry ? entry.departedOrRetainedIds.size : 0;
            const returned = completedLive + Math.max(departedOrRetained, Number(rollup?.returned) || 0);
            const liveOutstanding = entry ? entry.outstandingIds.size : 0;
            const rollupOutstanding = Math.max(0, (Number(rollup?.out) || 0) - completedLive);
            const outstanding = Math.max(liveOutstanding, rollupOutstanding);
            if (returned + outstanding <= 0) continue;

            // Keep returnedTrims index-aligned with returned units (never strip null trims).
            const returnedTrims = [];
            if (entry) {
                for (const childId of entry.returnedOrder) {
                    const childSprite = spriteById.get(childId) || null;
                    returnedTrims.push(childSprite?._providerTrimColor?.() || childTrims.get(childId) || null);
                }
            }
            while (returnedTrims.length < returned) returnedTrims.push(null);

            const footX = Number.isFinite(sprite._placeX) ? sprite._placeX : sprite.x;
            const footY = Number.isFinite(sprite._placeY) ? sprite._placeY : sprite.y;
            const doorKey = nearestBuildingDoorKey(this.world?.buildings, footX, footY);
            const doorCount = doorKey ? (doorCounts.get(doorKey) || 0) : 0;
            if (doorKey && doorCount >= CAIRN_DOOR_ZONE_CAP) continue;

            const dirName = typeof sprite.direction === 'string'
                ? sprite.direction
                : (DIRECTIONS[sprite.direction] || '');
            const west = /w$/.test(dirName);

            const admitted = admitReportCairn({
                id: agent.id,
                returned,
                outstanding,
                returnedTrims,
                footX,
                footY,
                west,
                governor: gov,
                viewCount,
                doorCount,
            });
            if (!admitted) continue;
            sprite._cairnSpec = admitted;
            admittedCairns.push(admitted);
            viewCount += 1;
            if (doorKey) doorCounts.set(doorKey, doorCount + 1);
        }
        return admittedCairns;
    }

    // NL-4 (look `nl4`, CarriedLantern.js) — marks this frame's lantern
    // carriers (`sprite.lanternCarried`, read by the body's draw: every
    // eligible body, whatever the camera) and returns one small fixture light
    // per carrier that keeps a pool: EFFECT_BUDGET `carried-lanterns` (FULL
    // 24, REDUCED 12, MINIMAL 0; NE v0.67.1 L) nearest the view centre, with
    // moving carriers prioritised ahead of standing ones (priority 0 vs -1)
    // within lightRoleRank 4. The light's foot is the carrier's foot (no 2.8
    // cast on its own carrier), it never breathes (`fire` false), and status
    // never enters: only presence, place, the lamp clock and the round at its
    // tile.

    _carriedLanternLightSources(lighting) {
        const sprites = this.agentSprites;
        if (!sprites?.size) return [];
        for (const sprite of sprites.values()) sprite.lanternCarried = false;
        const strength = lookStrength('nl4');
        if (!(strength > 0) || !this.villageLampsLit()) return [];
        const candidates = [];
        for (const [id, sprite] of sprites) candidates.push(lanternCandidate(id, sprite, worldToTile));
        const camera = this.camera;
        const canvas = camera?.canvas;
        const zoom = camera?.zoom || 1;
        const centre = camera ? {
            x: -camera.x + (canvas?._claudeVilleCssWidth || canvas?.clientWidth || 0) / (2 * zoom),
            y: -camera.y + (canvas?._claudeVilleCssHeight || canvas?.clientHeight || 0) / (2 * zoom),
        } : null;
        const carriers = selectLanternCarriers(candidates, {
            strength,
            lampsLit: true,
            roundLit: this.lampRoundLit(),
            centre,
        });
        const level = this.gpuWorld?._compositeQualityLevel
            ?? (this.postFx?.isActive?.() === true ? (this.postFx?.ladder?.effectiveLevel ?? 0) : 0);
        const pools = effectBudgetMode('carried-lanterns', level);
        const core = sourceEnergyFor(lighting).core;
        const out = [];
        carriers.forEach((carrier, index) => {
            carrier.sprite.lanternCarried = true;
            if (index >= pools) return;
            const foot = { x: carrier.x, y: carrier.y };
            out.push(normalizeLightSource({
                id: `${LANTERN_ID_PREFIX}${carrier.id}`,
                kind: 'point',
                role: 'fixture',
                x: foot.x,
                y: foot.y - LANTERN_HEIGHT,
                ground: foot,
                height: LANTERN_HEIGHT,
                color: LANTERN_COLOR,
                radius: lanternPoolRadius(strength, carrier.crowded),
                intensity: lanternIntensity(strength, core),
                priority: carrier.sprite?.moving === true ? 0 : -1, // NE v0.67.1 L
            }));
        });
        return out;
    }

    _computeFrameLightSources(atmosphere = null, now = performance.now()) {
        const lighting = atmosphere?.lighting || null;
        const energy = sourceEnergyFor(lighting);
        const reach = Number.isFinite(Number(energy.reach)) ? Number(energy.reach) : 1;
        const gain = Number.isFinite(Number(energy.gain)) ? Number(energy.gain) : 1;
        const building = this.buildingRenderer?.getLightSources?.(lighting) || [];
        // V3 — council rings and talk arcs are the relationship status
        // grammar (drawn as ground cues); they throw no light, so no pool,
        // column or cast ever restates agent state on the ground.
        const attention = this._attentionLightSources();
        const ambient = [
            ...attention,
            ...building,
            ...this._familiarMoteLightSources(lighting),
            ...(this.arrivalDeparture?.getLightSources?.({ now }) || []),
            ...this._lanternGroundLightSources(lighting),
            ...this._villageWallLanternLightSources(lighting),
            ...(this.bridgeLanterns?.getLightSources?.(lighting) || []),
            // 5.3 — moored and sailing ships' lamps (fixtures, budget-capped).
            ...(this.harborTraffic?.lampLightSources?.(energy.core) || []),
            // NL-4 — last, so no feed or admission cap ever trades a street
            // lamp or an attention light for a lantern.
            ...this._carriedLanternLightSources(lighting),
        ];
        // 2.6 — fire sources (forge door and spill, torches, village and gate
        // braziers) breathe in stepped 140 ms quanta on the one motion clock;
        // windows, lamps and attention lights never do. NE P2.2 — non-attention
        // sources also take the source-energy bucket's reach and gain after
        // authored caps. Each record is fresh this frame (and `building` shares
        // these objects), so each multiply lands exactly once.
        const motionTimeMs = this.motionTimeMs;
        for (const light of ambient) {
            if (light.attention) continue;
            if (light.fire) {
                light.intensity *= fireBreath(motionTimeMs, light.fireGroup || light.id, this.motionScale, fireBreathDepth(light.radius));
            }
            if (reach !== 1 && Number.isFinite(light.radius)) light.radius *= reach;
            if (gain !== 1 && Number.isFinite(light.intensity)) light.intensity *= gain;
        }
        // 3.2 — plan the wet source reflections here, before any ground pass
        // draws, so the neutral damp marks can stand aside for them in the
        // same frame instead of one frame later.
        this._wetReflectionPlan = this._planWetSourceReflections(ambient);
        return { building, ambient };
    }

    // 3.2 (Canvas/hybrid half) — at most CANVAS_WET_REFLECTION_CAP admitted
    // sources lay a stepped patch of their own hue on genuinely wet ground.
    // The receiver test is the authored road/quay tile set, not a guess from
    // brightness: a lantern over grass or timber gets nothing. Cached stamps
    // and a world-quantized origin keep the pattern still while the camera
    // pans, matching the resident shader's world-grid dither.
    _planWetSourceReflections(sources) {
        const wetness = clampUnit(this._atmosphereReactions?.surfaceWetness ?? 0);
        if (wetness <= 0.05 || !sources?.length) return null;
        if (!this.pathTiles?.size && !this.bridgeTiles?.size) return null;
        const ranked = [];
        for (const light of sources) {
            if (light.attention) continue;
            if (light.kind && light.kind !== 'point' && light.kind !== 'spark') continue;
            if (!Number.isFinite(light.x) || !Number.isFinite(light.y)) continue;
            const tiles = this._wetGroundTilesNear(light.x, light.y);
            if (!tiles.length) continue;
            ranked.push({ light, tiles });
            if (ranked.length >= CANVAS_WET_REFLECTION_CAP * 3) break;
        }
        if (!ranked.length) return null;
        ranked.sort((a, b) => (
            (Number(b.light.priority) || 0) - (Number(a.light.priority) || 0)
            || (Number(b.light.intensity) || 0) - (Number(a.light.intensity) || 0)
            || String(a.light.id || '').localeCompare(String(b.light.id || ''))
        ));
        ranked.length = Math.min(ranked.length, CANVAS_WET_REFLECTION_CAP);
        return { wetness, entries: ranked };
    }

    _wetGroundTilesNear(worldX, worldY) {
        const out = [];
        const origin = worldToTile(worldX, worldY);
        if (!origin) return out;
        const baseX = Math.round(origin.tileX);
        const baseY = Math.round(origin.tileY);
        for (let dy = 0; dy <= WET_REFLECTION_TILE_REACH; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const tileX = baseX + dx + dy;
                const tileY = baseY - dx + dy;
                const key = `${tileX},${tileY}`;
                const wet = this.pathTiles?.has(key)
                    || this.bridgeTiles?.get(key)?.kind === 'dock';
                if (!wet) continue;
                const iso = isoFromTile(tileX, tileY);
                if (iso) out.push(iso);
            }
        }
        return out;
    }

    // World-space test used by the damp-mark pass: does a planned reflection
    // already carry this patch of wet ground? Half a tile of slack keeps a
    // fleck from sitting on the reflection's own stepped edge.
    _wetReflectionCovers(worldX, worldY) {
        const plan = this._wetReflectionPlan;
        if (!plan) return false;
        for (const entry of plan.entries) {
            const light = entry.light;
            const halfWidth = light.radius * 0.30 + TILE_WIDTH / 2;
            const reach = light.radius * 0.40 + TILE_HEIGHT / 2;
            const drop = worldY - light.y;
            if (drop < -TILE_HEIGHT / 2 || drop > reach) continue;
            if (Math.abs(worldX - light.x) <= halfWidth) return true;
        }
        return false;
    }

    // Screen-space additive pass, drawn with the light glow stamps so both
    // consume the same exposure envelope. The reflection is always dimmer than
    // the core it comes from and is clipped to the wet tiles it belongs to.
    _drawWetSourceReflections(ctx, canvas, atmosphere = null) {
        const plan = this._wetReflectionPlan;
        if (!plan) return;
        const core = sourceEnergyFor(atmosphere?.lighting).core;
        if (core <= 0.2) return;
        const zoom = this.camera?.zoom || 1;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const entry of plan.entries) {
            const light = entry.light;
            const p = this.camera.worldToScreen(light.x, light.y);
            if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
            const width = Math.max(6, Math.round(light.radius * 0.52 * zoom));
            const height = Math.max(4, Math.round(light.radius * 0.40 * zoom));
            const stamp = this._getWetReflectionStamp(light.color, width, height, plan.wetness);
            ctx.beginPath();
            for (const tile of entry.tiles) {
                const c = this.camera.worldToScreen(tile.x, tile.y);
                ctx.moveTo(c.x, c.y - (TILE_HEIGHT / 2) * zoom);
                ctx.lineTo(c.x + (TILE_WIDTH / 2) * zoom, c.y);
                ctx.lineTo(c.x, c.y + (TILE_HEIGHT / 2) * zoom);
                ctx.lineTo(c.x - (TILE_WIDTH / 2) * zoom, c.y);
                ctx.closePath();
            }
            ctx.save();
            ctx.clip();
            ctx.globalAlpha = this._quantizedAlpha(
                Math.min(0.34, 0.30 * plan.wetness * core * (Number(light.intensity) || 1)),
            );
            // Quantize the origin to two screen pixels so the stepped courses
            // stay locked to the world grid instead of crawling under a pan.
            const x = Math.round((p.x - width / 2) / 2) * 2;
            const y = Math.round(p.y / 2) * 2;
            ctx.drawImage(stamp, x, y, width, height);
            ctx.restore();
        }
        ctx.restore();
    }

    _getWetReflectionStamp(color, width, height, wetness) {
        const wetBucket = Math.round(clampUnit(wetness) * 4);
        const key = `${color}|${width}x${height}|w${wetBucket}`;
        const cached = this.lightGradientCache.get(key);
        if (cached) {
            this.lightGradientCache.delete(key);
            this.lightGradientCache.set(key, cached);
            return cached;
        }
        const stamp = document.createElement('canvas');
        stamp.width = Math.max(1, width);
        stamp.height = Math.max(1, height);
        const stampCtx = stamp.getContext('2d');
        SpriteRenderer.disableSmoothing(stampCtx);
        // Three stepped courses of the source's own hue, brightest directly
        // under the source and broken on a 2 px ordered pattern. No gradient:
        // the palette contract wants courses, not a smooth wash.
        const courses = [
            { at: 0, span: Math.max(1, Math.round(height * 0.34)), alpha: 0.9, step: 1 },
            { at: Math.round(height * 0.34), span: Math.max(1, Math.round(height * 0.33)), alpha: 0.58, step: 2 },
            { at: Math.round(height * 0.67), span: Math.max(1, height - Math.round(height * 0.67)), alpha: 0.3, step: 3 },
        ];
        for (const course of courses) {
            stampCtx.fillStyle = this._withAlpha(color, course.alpha);
            for (let y = course.at; y < course.at + course.span; y++) {
                const inset = Math.round(width * 0.08 * course.step);
                for (let x = inset; x < width - inset; x += 2) {
                    if (((x + y * 2) & 3) === 0) continue;
                    stampCtx.fillRect(x, y, 2, 1);
                }
            }
        }
        const stampPixels = canvasPixelCount(stamp);
        if (stampPixels <= MAX_LIGHT_GRADIENT_STAMP_PIXELS) {
            let retainedPixels = canvasMapPixelCount(this.lightGradientCache);
            while (
                this.lightGradientCache.size > 0 &&
                (this.lightGradientCache.size >= 240 ||
                    retainedPixels + stampPixels > MAX_LIGHT_GRADIENT_CACHE_PIXELS)
            ) {
                const oldestKey = this.lightGradientCache.keys().next().value;
                const oldest = this.lightGradientCache.get(oldestKey);
                retainedPixels -= canvasPixelCount(oldest);
                releaseCanvasBackingStore(oldest);
                this.lightGradientCache.delete(oldestKey);
            }
            this.lightGradientCache.set(key, stamp);
        }
        return stamp;
    }

    _ambientLightSources(atmosphere = null) {
        if (this._frameLightSources?.ambient) return this._frameLightSources.ambient;
        const { ambient } = this._computeFrameLightSources(atmosphere);
        return ambient;
    }

    // 1.4 / 3.4 Canvas parity — called from the Canvas terrain pass with the
    // world transform applied, over the whole visible rect below the sea
    // horizon (island and sea), so the sea carries the island's shadows.
    // Motion time matches the resident composite's clock.
    _drawCloudShadowCourses(ctx, atmosphere = null, perfNow = 0) {
        const m = ctx.getTransform?.();
        const width = ctx.canvas?.width || 0;
        const height = ctx.canvas?.height || 0;
        if (!m || !(m.a > 0) || !(m.d > 0) || !width || !height) return false;
        const x0 = -m.e / m.a;
        const x1 = (width - m.e) / m.a;
        const y0 = Math.max(OCEAN_HORIZON_WORLD_Y, -m.f / m.d);
        const y1 = (height - m.f) / m.d;
        if (!(y1 > y0)) return false;
        return drawCloudShadowCourses(ctx, {
            coast: this._coastBake,
            atmosphere,
            region: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
            timeMs: this.motionTimeMs ?? perfNow,
            reducedMotion: !((this.motionScale ?? 1) > 0),
            lone: this.ambientLoneCloud,
        });
    }

    _drawAtmosphere(ctx, atmosphere = null, dt = 16, ambientLightSources = null, profileMark = null) {
        const canvas = this._screenViewport();
        if (this._shouldUseFastAtmosphere()) {
            this._drawFastAtmosphereWash(
                ctx,
                canvas,
                atmosphere,
                dt,
                ambientLightSources,
                profileMark,
            );
            return;
        }
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        // C2 — grade the finished world layer with the evaluated grade: the
        // night desaturation, the cached ambient multiply (with its stepped
        // vignette) and the lift floor, in the resident shader's order.
        const { grade } = canvasGradeFor(atmosphere);
        drawCanvasGradeSaturation(ctx, canvas.width, canvas.height, grade);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(this._getAtmosphereVignette(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        ctx.restore();
        drawCanvasGradeGain(ctx, canvas.width, canvas.height, grade);
        drawCanvasGradeLift(ctx, canvas.width, canvas.height, grade);
        drawCanvasGradeGamma(ctx, canvas.width, canvas.height, grade);
        profileMark?.('atmosphere-grade');

        // 3.2 — source-coloured wet reflections come before the halos: the
        // patch below a lamp belongs to the ground, the halo to the air.
        this._drawWetSourceReflections(ctx, canvas, atmosphere);
        // 1.2 — stepped multiplicative pools at the real emitters, shared with
        // the fast path, landed once through the pool layer.
        const pools = this._beginPoolLayer(ctx, canvas);
        this._drawLightGlowStamps(pools, canvas, atmosphere, ambientLightSources);
        this._drawLanternGlows(pools, canvas, atmosphere);
        this._landPoolLayer(ctx);
        profileMark?.('atmosphere-lights');

        ctx.restore();
    }

    // 1.2 — the light pools, extracted so both the full atmosphere path and
    // the fast-atmosphere wash stamp them. Each pool is a cached `color-dodge`
    // stamp in three dithered art-pixel courses: it multiplies the graded
    // surface in the light's hue (texture shows through) instead of pasting a
    // screen-blended disc. `maxCount` bounds the stamp count; the fast path
    // pre-selects the nearest lights and passes them in. `ctx` is the pool
    // layer from `_beginPoolLayer`.
    _drawLightGlowStamps(ctx, canvas, atmosphere = null, ambientLightSources = null, maxCount = Infinity) {
        if (!this.buildingRenderer) return;
        // `localLightPhase` stays the admission gate (no lamps at noon); 3.1's
        // exposure envelope spill share is the pool energy, as on the GPU.
        // Action-needed lights stay outside the envelope (their own stepped,
        // capped course), as on the GPU.
        const localLightPhase = localLightPhaseForLighting(atmosphere?.lighting);
        if (localLightPhase <= 0.04) return;
        const spill = sourceEnergyFor(atmosphere?.lighting).spill;
        let drawn = 0;
        for (const light of ambientLightSources || this._ambientLightSources(atmosphere)) {
            if (drawn >= maxCount) break;
            if (light.kind && !['point', 'spark', 'orbit'].includes(light.kind)) continue;
            // V5 — Canvas parity is the ground courses only: the stamp lands
            // on the light's foot with the same height term and aperture lobe
            // as the resident loop (no facing, rim or occlusion here).
            const foot = light.ground || light;
            const p = this.camera.worldToScreen(foot.x, foot.y);
            if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
            const radius = light.radius * this.camera.zoom;
            const energy = (light.attention ? 1 : spill) * (light.intensity || 1);
            const stamp = this._getLightGlowStamp(light, radius, energy, atmosphere);
            this._stampPool(ctx, stamp, p.x, p.y);
            drawn++;
        }
    }

    // 1.2 — Canvas pools land like the resident sum-then-cap: every stamp's
    // dodge block is drawn into one pool layer with `lighten` (the strongest
    // course wins, so overlapping lamps never compound into a bleached white
    // disc) and its multiply block, when it has one, into a white shade
    // layer with `darken`. The shade lands with `multiply`, then the pools
    // with `color-dodge`. Only the stamped rectangle is reset and composited.
    _poolLayerCanvas(key, canvas, fill) {
        let layer = this[key];
        if (layer && layer.width === canvas.width && layer.height === canvas.height) return layer;
        releaseCanvasBackingStore(layer);
        layer = document.createElement('canvas');
        layer.width = canvas.width;
        layer.height = canvas.height;
        if (fill) {
            const layerCtx = layer.getContext('2d');
            layerCtx.fillStyle = fill;
            layerCtx.fillRect(0, 0, layer.width, layer.height);
        }
        this[key] = layer;
        this._poolLayerRect = null;
        return layer;
    }

    _beginPoolLayer(ctx, canvas) {
        const dodge = this._poolLayerCanvas('_poolLayer', canvas, null).getContext('2d');
        const shade = this._poolLayerCanvas('_poolShadeLayer', canvas, '#ffffff').getContext('2d');
        const stale = this._poolLayerRect;
        const transform = ctx.getTransform();
        for (const layerCtx of [dodge, shade]) {
            layerCtx.setTransform(1, 0, 0, 1, 0, 0);
            layerCtx.globalCompositeOperation = 'source-over';
            if (stale) {
                if (layerCtx === shade) {
                    layerCtx.fillStyle = '#ffffff';
                    layerCtx.fillRect(stale.x0, stale.y0, stale.x1 - stale.x0, stale.y1 - stale.y0);
                } else {
                    layerCtx.clearRect(stale.x0, stale.y0, stale.x1 - stale.x0, stale.y1 - stale.y0);
                }
            }
            layerCtx.setTransform(transform);
            layerCtx.imageSmoothingEnabled = false;
        }
        dodge.globalCompositeOperation = 'lighten';
        shade.globalCompositeOperation = 'darken';
        this._poolLayerRect = null;
        this._poolShadeUsed = false;
        const pools = this._poolLayerContexts || (this._poolLayerContexts = {});
        pools.dodge = dodge;
        pools.shade = shade;
        return pools;
    }

    _stampPool(pools, stamp, x, y) {
        const cells = stamp._poolCells || stamp.width;
        const rows = stamp._poolRows || stamp.height;
        const width = cells * stamp._poolCellPx;
        const height = rows * stamp._poolCellPx;
        const left = Math.round(x - width / 2);
        const top = Math.round(y - height / 2);
        pools.dodge.drawImage(stamp, 0, 0, cells, rows, left, top, width, height);
        if (stamp._poolShade) {
            pools.shade.drawImage(stamp, cells, 0, cells, rows, left, top, width, height);
            this._poolShadeUsed = true;
        }
        const m = pools.dodge.getTransform();
        const x0 = Math.max(0, Math.floor(left * m.a + m.e));
        const y0 = Math.max(0, Math.floor(top * m.d + m.f));
        const x1 = Math.min(pools.dodge.canvas.width, Math.ceil((left + width) * m.a + m.e));
        const y1 = Math.min(pools.dodge.canvas.height, Math.ceil((top + height) * m.d + m.f));
        if (x1 <= x0 || y1 <= y0) return;
        const rect = this._poolLayerRect;
        this._poolLayerRect = rect
            ? { x0: Math.min(rect.x0, x0), y0: Math.min(rect.y0, y0), x1: Math.max(rect.x1, x1), y1: Math.max(rect.y1, y1) }
            : { x0, y0, x1, y1 };
    }

    _landPoolLayer(ctx) {
        const rect = this._poolLayerRect;
        if (!rect || !this._poolLayer) return;
        const w = rect.x1 - rect.x0;
        const h = rect.y1 - rect.y0;
        this._maskPoolLayers(rect);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        if (this._poolShadeUsed) {
            ctx.globalCompositeOperation = 'multiply';
            ctx.drawImage(this._poolShadeLayer, rect.x0, rect.y0, w, h, rect.x0, rect.y0, w, h);
        }
        ctx.globalCompositeOperation = 'color-dodge';
        ctx.drawImage(this._poolLayer, rect.x0, rect.y0, w, h, rect.x0, rect.y0, w, h);
        ctx.restore();
    }

    // V5 — both pool layers keep only the frame's ground receivers
    // (`poolReceiverMask`: open water, wall faces, roofs and static props
    // drop out; villagers lay their own bodies back in), as the resident
    // light loop's receivers do. The mask is one texel per world px — the
    // pools' own art-pixel grid.
    _maskPoolLayers(rect) {
        const pools = this._poolLayerContexts;
        if (!pools?.dodge) return;
        const dpr = this._screenDpr?.() || 1;
        const topLeft = this.camera.screenToWorld(rect.x0 / dpr, rect.y0 / dpr);
        const bottomRight = this.camera.screenToWorld(rect.x1 / dpr, rect.y1 / dpr);
        const mask = poolReceiverMask(this, {
            x0: Math.min(topLeft.x, bottomRight.x),
            y0: Math.min(topLeft.y, bottomRight.y),
            x1: Math.max(topLeft.x, bottomRight.x),
            y1: Math.max(topLeft.y, bottomRight.y),
        });
        if (!mask) return;
        for (const layerCtx of [pools.dodge, pools.shade]) {
            if (!layerCtx) continue;
            layerCtx.save();
            layerCtx.setTransform(1, 0, 0, 1, 0, 0);
            layerCtx.imageSmoothingEnabled = false;
            layerCtx.globalCompositeOperation = 'destination-in';
            this.camera.applyTransform(layerCtx);
            layerCtx.drawImage(mask.canvas, mask.x, mask.y);
            layerCtx.restore();
        }
    }

    // C3 — torchlight at the baked lantern/brazier props, as the same stepped
    // multiplicative pools as every other emitter (1.2). Energy tracks the
    // beacon (night) factor x the envelope spill; braziers breathe in the 2.6
    // fire quanta (the same beat and id as their light record), lanterns hold
    // steady, and reduced motion holds every one at 1.
    // Only runs in the full atmosphere path (the fast path drops them by
    // design — that's E3's territory). `ctx` is the pool layer.
    _drawLanternGlows(ctx, canvas, atmosphere = null) {
        if (!lampsLitAt(atmosphere || this._lastAtmosphere)) return;
        const nightFactor = this._lanternNightFactor(atmosphere);
        if (nightFactor <= 0.05) return;
        const spill = sourceEnergyFor(atmosphere?.lighting).spill;
        const sources = this._litLanternGlowSources();
        if (!sources.length) return;

        const zoom = this.camera?.zoom || 1;
        const radius = Math.max(9, Math.round(14 * zoom));
        const motionTimeMs = this.motionTimeMs;
        const light = this._lanternPoolLight || (this._lanternPoolLight = {
            id: 'prop-lantern', kind: 'point', color: '#ffd56a', radius: 14,
        });

        for (const src of sources) {
            const p = this.camera.worldToScreen(src.x, src.y);
            if (p.x < -radius || p.y < -radius || p.x > canvas.width + radius || p.y > canvas.height + radius) continue;
            const breath = src.fixture === 'brazier'
                ? fireBreath(motionTimeMs, `village.brazier.${src.tileX}.${src.tileY}`, this.motionScale)
                : 1;
            const stamp = this._getLightGlowStamp(light, radius, nightFactor * spill * breath, atmosphere);
            this._stampPool(ctx, stamp, p.x, p.y);
        }
        // The hearths' smaller, dimmer pools (never breathing: no fire here
        // but the bonfire, which holds its static frame).
        const hearthRadius = Math.max(7, Math.round(10 * zoom));
        const hearthLight = this._hearthPoolLight || (this._hearthPoolLight = {
            id: 'prop-hearth', kind: 'point', color: HEARTH_TONE, radius: 10,
        });
        for (const src of this._hearthLightSources(atmosphere?.lighting)) {
            const p = this.camera.worldToScreen(src.ground.x, src.ground.y);
            if (p.x < -hearthRadius || p.y < -hearthRadius || p.x > canvas.width + hearthRadius || p.y > canvas.height + hearthRadius) continue;
            const stamp = this._getLightGlowStamp(hearthLight, hearthRadius, nightFactor * spill * 0.6, atmosphere);
            this._stampPool(ctx, stamp, p.x, p.y);
        }
    }

    // Night factor from the atmosphere's beacon intensity (0 in daylight, rising
    // through dusk to full at night); falls back to inverse ambient light.
    _lanternNightFactor(atmosphere = null) {
        const lighting = atmosphere?.lighting || this._lastAtmosphere?.lighting || null;
        if (!lighting) return 0;
        const beacon = Number(lighting.beaconIntensity);
        if (Number.isFinite(beacon)) return Math.max(0, Math.min(1, beacon));
        const ambient = Number(lighting.ambientLight);
        return Number.isFinite(ambient) ? Math.max(0, Math.min(1, 1 - ambient)) : 0;
    }

    // World-space lantern/brazier positions gathered once from the scenery
    // config (prop.lantern / prop.runeBrazier across the ambient, district, and
    // scenic-point prop sets), lifted to the flame. Memoized — the prop layout
    // never changes at runtime.
    _lanternGlowSources() {
        if (this._lanternGlowSourcesCache) return this._lanternGlowSourcesCache;
        const out = [];
        const push = (tileX, tileY, fixture = 'lantern') => {
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2 - 10; // lift onto the flame
            out.push({ x, y, fixture, tileX, tileY });
        };
        for (const prop of AMBIENT_GROUND_PROPS) {
            if (prop.type === 'lantern') push(prop.tileX, prop.tileY);
        }
        for (const prop of DISTRICT_PROPS) {
            if (prop.id === 'prop.lantern') push(prop.tileX, prop.tileY);
            if (prop.id === 'prop.runeBrazier' || prop.id === 'prop.plazaBrazier') push(prop.tileX, prop.tileY, 'brazier');
        }
        for (const prop of SCENIC_POINT_PROPS) {
            if (prop.id === 'prop.lantern') push(prop.tileX, prop.tileY);
            if (prop.id === 'prop.runeBrazier' || prop.id === 'prop.plazaBrazier') push(prop.tileX, prop.tileY, 'brazier');
        }
        this._lanternGlowSourcesCache = out;
        return out;
    }

    _shouldUseFastAtmosphere() {
        const cssPixels = this._screenWidth() * this._screenHeight();
        return cssPixels >= FAST_ATMOSPHERE_CSS_PIXELS && (this.camera?.zoom || 1) >= 1.5;
    }

    _drawFastAtmosphereWash(
        ctx,
        canvas,
        atmosphere = null,
        dt = 16,
        ambientLightSources = null,
        profileMark = null,
    ) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        // E1 (fast path) — the same C2 grade as the cached overlay path: the
        // desaturation and lift fills around a small quarter-size multiply
        // stamp (5.1) whose stepped vignette survives the nearest stretch.
        const { grade } = canvasGradeFor(atmosphere);
        drawCanvasGradeSaturation(ctx, canvas.width, canvas.height, grade);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._getFastVignetteStamp(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        ctx.restore();
        drawCanvasGradeGain(ctx, canvas.width, canvas.height, grade);
        drawCanvasGradeLift(ctx, canvas.width, canvas.height, grade);
        drawCanvasGradeGamma(ctx, canvas.width, canvas.height, grade);
        profileMark?.('atmosphere-grade');

        // 3.2 — the fast path keeps the same capped, cached wet reflections.
        this._drawWetSourceReflections(ctx, canvas, atmosphere);
        // E3 — restore light glows on the fast path (previously dropped exactly
        // when zoomed into a building at night), capped at the ~12 nearest.
        this._drawFastPathLightGlows(ctx, canvas, atmosphere, ambientLightSources);
        profileMark?.('atmosphere-lights');

        ctx.restore();
    }

    // 5.1 — quarter-size cached multiply overlay for the fast atmosphere path.
    // The radial vignette uses the same formulas as _getAtmosphereVignette in
    // the stamp's own coordinate space, so the stretched blit matches the
    // full-size overlay's shape at a fraction of the blit cost.
    _getFastVignetteStamp(canvas, atmosphere = null) {
        const width = Math.max(1, Math.round(canvas.width / 4));
        const height = Math.max(1, Math.round(canvas.height / 4));
        const cacheKey = `${width}x${height}|${canvasGradeOverlayKey(atmosphere)}`;
        if (this._fastVignetteStamp && this._fastVignetteStampKey === cacheKey) {
            return this._fastVignetteStamp;
        }

        releaseCanvasBackingStore(this._fastVignetteStamp);
        const stamp = document.createElement('canvas');
        stamp.width = width;
        stamp.height = height;
        const stampCtx = stamp.getContext('2d');
        const grade = canvasGradeFor(atmosphere);
        const gradeBase = gradeColorForCanvas(grade.base);
        const gradeEdge = gradeColorForCanvas(grade.edge);
        stampCtx.fillStyle = gradeBase;
        stampCtx.fillRect(0, 0, width, height);
        const vignette = stampCtx.createRadialGradient(
            width * 0.5,
            height * 0.46,
            Math.min(width, height) * 0.18,
            width * 0.5,
            height * 0.5,
            Math.max(width, height) * 0.72,
        );
        addSteppedVignetteStops(vignette, (alpha) => this._withAlpha(gradeEdge, this._quantizedAlpha(alpha)), grade.edgeAlpha);
        stampCtx.fillStyle = vignette;
        stampCtx.fillRect(0, 0, width, height);

        this._fastVignetteStamp = stamp;
        this._fastVignetteStampKey = cacheKey;
        return stamp;
    }

    // E3 — pick the nearest visible lights to the viewport centre (after
    // culling) and stamp them via the shared additive helper. No new cache
    // surfaces; reuses _getLightGlowStamp.
    _drawFastPathLightGlows(ctx, canvas, atmosphere = null, ambientLightSources = null) {
        if (!this.buildingRenderer) return;
        const sources = ambientLightSources || this._ambientLightSources(atmosphere);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const visible = [];
        for (const light of sources) {
            if (light.kind && !['point', 'spark', 'orbit'].includes(light.kind)) continue;
            const p = this.camera.worldToScreen(light.x, light.y);
            if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
            visible.push({ light, d2: (p.x - cx) ** 2 + (p.y - cy) ** 2 });
        }
        if (!visible.length) return;
        visible.sort((a, b) => (
            Number(Boolean(b.light.attention)) - Number(Boolean(a.light.attention))
            || (Number(b.light.priority) || 0) - (Number(a.light.priority) || 0)
            || a.d2 - b.d2
        ));
        let protectedCount = 0;
        while (protectedCount < visible.length && visible[protectedCount].light.attention) protectedCount++;
        const nearest = visible.slice(0, Math.max(12, protectedCount)).map(v => v.light);
        const pools = this._beginPoolLayer(ctx, canvas);
        this._drawLightGlowStamps(pools, canvas, atmosphere, nearest);
        this._landPoolLayer(ctx);
    }

    // 1.2 — one cached stepped `color-dodge` pool stamp per light, zoom (the
    // art-pixel cell), energy and grade bucket. The stamp is one texel per art
    // pixel and is drawn nearest-neighbour at `cell` CSS px per texel.
    _getLightGlowStamp(light, radius, energy = 1, atmosphere = null) {
        const { grade } = canvasGradeFor(atmosphere);
        const cell = Math.max(1, Math.round(this.camera?.zoom || 1));
        const ambientTint = grade.ambientTint || [1, 1, 1];
        // V5 — each course clamps the graded plaza under the receiver ceiling.
        const receiver = gradedPoolReceiver(grade);
        // V5 — the ground course of a raised light (its height beyond the
        // resident 24 px band, a facade aperture's at its spill) and of a
        // facade aperture (its face's half-space lobe), as on the GPU.
        const height = groundCourseHeight(light) * (this.camera?.zoom || 1);
        const normal = Array.isArray(light.normal) ? light.normal : null;
        const key = [
            lightSourceCacheKey(light, 'pool'),
            Math.round(radius),
            cell,
            this._quantizedAlpha(energy),
            ambientTint.map(channel => Math.round(channel * 32)).join(','),
            Math.round((grade.poolGain ?? 1) * 32),
            receiver ? receiver.map(channel => Math.round(channel * 64)).join(',') : '',
            Math.round(height),
            normal ? normal.map(value => Math.round(value * 8)).join(',') : '',
            light.attention || light.role === 'attention' ? 'attention' : 'ambient',
        ].join('|');
        const cached = this.lightGradientCache.get(key);
        if (cached) {
            this.lightGradientCache.delete(key);
            this.lightGradientCache.set(key, cached);
            return cached;
        }

        const stamp = buildPoolDodgeStamp({
            rgb: this._parseLightColor(light.color),
            radius,
            cell,
            energy: this._quantizedAlpha(energy),
            ambientTint,
            poolGain: grade.poolGain ?? 1,
            receiver,
            height,
            normal,
            attention: light.attention === true || light.role === 'attention',
        });
        const stampPixels = canvasPixelCount(stamp);
        if (stampPixels <= MAX_LIGHT_GRADIENT_STAMP_PIXELS) {
            let retainedPixels = canvasMapPixelCount(this.lightGradientCache);
            while (
                this.lightGradientCache.size > 0 &&
                (this.lightGradientCache.size >= 240 ||
                    retainedPixels + stampPixels > MAX_LIGHT_GRADIENT_CACHE_PIXELS)
            ) {
                const oldestKey = this.lightGradientCache.keys().next().value;
                const oldest = this.lightGradientCache.get(oldestKey);
                retainedPixels -= canvasPixelCount(oldest);
                releaseCanvasBackingStore(oldest);
                this.lightGradientCache.delete(oldestKey);
            }
            this.lightGradientCache.set(key, stamp);
        }
        return stamp;
    }

    _getAtmosphereVignette(canvas, atmosphere = null) {
        const dpr = this._screenDpr();
        const cacheKey = `${canvas.width}x${canvas.height}@${dpr}|${canvasGradeOverlayKey(atmosphere)}`;
        if (this.atmosphereVignetteCache && this.atmosphereVignetteCacheKey === cacheKey) {
            return this.atmosphereVignetteCache;
        }

        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        const overlay = document.createElement('canvas');
        overlay.width = Math.max(1, Math.round(canvas.width * dpr));
        overlay.height = Math.max(1, Math.round(canvas.height * dpr));
        const overlayCtx = overlay.getContext('2d');
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // E1 — the overlay is a brightness *multiplier*, blitted with a
        // `multiply` composite in _drawAtmosphere. Every pixel is an opaque
        // multiplier colour: near-white leaves the scene untouched, darker/warm
        // values grade it. Painting the opaque base first, then a
        // transparent→dark radial, keeps the whole overlay opaque while
        // darkening toward the edges (the vignette).
        const grade = canvasGradeFor(atmosphere);
        const gradeBase = gradeColorForCanvas(grade.base);
        const gradeEdge = gradeColorForCanvas(grade.edge);
        overlayCtx.fillStyle = gradeBase;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const vignette = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            Math.min(canvas.width, canvas.height) * 0.18,
            canvas.width * 0.5,
            canvas.height * 0.5,
            Math.max(canvas.width, canvas.height) * 0.72,
        );
        addSteppedVignetteStops(vignette, (alpha) => this._withAlpha(gradeEdge, this._quantizedAlpha(alpha)), grade.edgeAlpha);
        overlayCtx.fillStyle = vignette;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        this.atmosphereVignetteCache = overlay;
        this.atmosphereVignetteCacheKey = cacheKey;
        return overlay;
    }

    ambientDiagnostics() {
        return ambientDebugSnapshot(this);
    }

    getWorldPerformanceDiagnostics() {
        const liveSpriteCanvases = new Set();
        for (const sprite of this.agentSprites.values()) {
            if (sprite?.spriteCanvas) liveSpriteCanvases.add(sprite.spriteCanvas);
        }
        let liveSpriteCanvasPixels = 0;
        for (const canvas of liveSpriteCanvases) liveSpriteCanvasPixels += canvasPixelCount(canvas);
        return {
            frameFailures: {
                ...(this._frameFailureStats || {}),
                byStage: { ...(this._frameFailureStats?.byStage || {}) },
                reportIntervalMs: WORLD_FRAME_ERROR_REPORT_INTERVAL_MS,
                maxConsecutive: WORLD_FRAME_MAX_CONSECUTIVE_FAILURES,
            },
            boundedState: {
                lightFadeColors: this.lightFadeColorCache?.size || 0,
                lightFadeColorLimit: LIGHT_FADE_COLOR_CACHE_LIMIT,
                lightFadeColorEvictions: this._lightFadeColorCacheEvictions || 0,
                lightColorRgbEntries: this.lightColorRgbCache?.size || 0,
                lightColorRgbLimit: LIGHT_COLOR_RGB_CACHE_LIMIT,
                lightColorRgbEvictions: this._lightColorRgbCacheEvictions || 0,
                crowdBumpCooldowns: this._crowdBumpCooldowns?.size || 0,
                crowdBumpCooldownLimit: CROWD_BUMP_COOLDOWN_LIMIT,
                nicknames: this._nicknames?.size || 0,
                nicknameLimit: NICKNAME_CACHE_LIMIT,
                liveSpriteCanvases: liveSpriteCanvases.size,
                liveSpriteCanvasPixels,
            },
            waterDescriptors: {
                total: this._waterTileDescriptors?.length || 0,
                canvasWater: this._canvasWater?.stats || null,
            },
            harbor: this.harborTraffic?.getDiagnostics?.() || null,
            trails: this.trailRenderer?.getDiagnostics?.() || null,
            events: this.agentEventStream?.getDiagnostics?.() || null,
            landmarks: this.landmarkActivity?.getDiagnostics?.() || null,
            monuments: this.chronicleMonuments?.getDiagnostics?.() || null,
            visits: this.visitIntentManager?.getDiagnostics?.() || null,
            allocator: this.visitTileAllocator?.getDiagnostics?.() || null,
            orca: this.getCrowdOrcaDiagnostics(),
            labelAuction: this.getLabelAuctionDiagnostics(),
            behavior: this.behaviorTelemetry?.metrics || null,
            ambient: this.ambientDiagnostics(),
            relationships: this.relationshipState?.getDiagnostics?.() || null,
            council: getCouncilRingDiagnostics(this.relationshipState),
            pathfinder: this.pathfinder?.getDiagnostics?.() || null,
            gpuWorld: this.gpuWorld?.getDiagnostics?.() || null,
            worldRendererMode: this.worldRendererMode,
            worldBackendReason: this.worldBackendReason,
        };
    }

    getDiagnostics() {
        return {
            orca: this.getCrowdOrcaDiagnostics(),
            labelAuction: this.getLabelAuctionDiagnostics(),
            allocator: this.visitTileAllocator?.getDiagnostics?.() || null,
            crowd: this._crowdStats || this._summarizeCrowdClusters(),
            performance: this.getWorldPerformanceDiagnostics(),
        };
    }

    getCanvasBudget() {
        const sky = this.skyRenderer?.getCanvasBudget?.() || {};
        const trail = this.trailRenderer?.getCanvasBudget?.() || {};
        const postFxFeed = this.postFxFeed?.getCanvasBudget?.() || {};
        const postFxResources = this.postFx?.getResourceAccounting?.() || gpuResourceAccounting();
        const gpuWorldResources = this.gpuWorld?.getResourceAccounting?.() || {
            textures: {},
            attachments: {},
            buffers: {},
        };
        const gpuResources = gpuResourceAccounting({
            textures: {
                ...Object.fromEntries(Object.entries(postFxResources.textures || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.textures || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
            attachments: {
                ...Object.fromEntries(Object.entries(postFxResources.attachments || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.attachments || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
            buffers: {
                ...Object.fromEntries(Object.entries(postFxResources.buffers || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.buffers || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
        });
        const volatile = {
            terrain: canvasPixelCount(this.terrainCache),
            sky: sky.volatilePixels || 0,
            trail: trail.volatilePixels || 0,
            postFxMask: postFxFeed.volatilePixels || 0,
            atmosphere: canvasPixelCount(this.atmosphereVignetteCache),
            lightGradients: canvasMapPixelCount(this.lightGradientCache),
            gpuAgentAtlas: canvasPixelCount(this._gpuAgentFrameAtlas),
            gpuAgentMaterialAtlas: canvasPixelCount(this._gpuAgentMaterialAtlas),
            gpuAgentEmissiveAtlas: canvasPixelCount(this._gpuAgentEmissiveAtlas),
            semanticGround: canvasPixelCount(this._semanticGroundCanvas),
            groundCueAtlas: canvasPixelCount(this._groundCueRecorder?.atlas?.canvas),
            shadeField: canvasPixelCount(this._shadeFieldState?.canvas),
        };
        const volatilePixels = Object.values(volatile).reduce((sum, value) => sum + value, 0);
        const visibleCanvasPixels = canvasPixelCount(this.canvas);
        const overlayCanvasPixels = canvasPixelCount(this.overlayCanvas);
        const retainedAssetPixels = this.foliageRenderer?.getRetainedPixels?.() || 0;
        const shadeBufferBytes = shadeFieldBufferBytes(this);
        const resources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: visibleCanvasPixels + overlayCanvasPixels,
            volatileCanvasPixels: volatilePixels,
            retainedCanvasPixels: retainedAssetPixels,
            gpu: gpuResources,
            cpuDerivedEstimates: { 'shadeField.buffers': shadeBufferBytes },
        });
        return {
            budgets: CANVAS_BUDGET,
            dpr: this._screenDpr(),
            running: this.running,
            worldModeActive: this._worldModeActive,
            worldResourcesSuspended: this._worldResourcesSuspended,
            worldResumeInFlight: this._worldResumePromise !== null,
            worldResumeFailures: this._worldResumeFailures,
            rafPending: this.frameId !== null,
            visibleCanvasPixels,
            volatile,
            volatilePixels,
            shadeFieldBufferBytes: shadeBufferBytes,
            retainedAssetPixels,
            domCanvasPixels: canvasPixelCount(this.fxCanvas) + overlayCanvasPixels,
            resources,
            cacheCounts: {
                lightGradients: this.lightGradientCache?.size || 0,
                lightFadeColors: this.lightFadeColorCache?.size || 0,
                lightColorRgb: this.lightColorRgbCache?.size || 0,
                fantasyForestTrees: this.foliageRenderer?.cacheSize || 0,
            },
            cacheStats: {
                assets: this.assets?.cacheStats?.() || null,
                compositor: this.compositor?.cacheStats?.() || null,
                agentSprites: AgentSprite.sharedCacheStats?.() || null,
            },
            gpu: this.gpuWorld?.getDiagnostics?.() || null,
            terrainCache: this.getTerrainCacheDiagnostics(),
            runtime: this.getWorldPerformanceDiagnostics(),
        };
    }

    _drawAtmosphereDebug(ctx, atmosphere) {
        if (!atmosphere) return;
        const lighting = atmosphere.lighting || {};
        const motion = atmosphere.motion || {};
        const clock = atmosphere.clock || {};
        const weather = atmosphere.weather || {};
        const reactions = atmosphere.reactions || {};
        const lines = [
            `ATM ${atmosphere.phase} ${(atmosphere.phaseProgress || 0).toFixed(2)}`,
            `CLOCK ${clock.label || '--:--'}:${String(clock.seconds ?? 0).padStart(2, '0')}  MIN ${Math.floor(clock.minuteOfDay ?? 0)}`,
            `WX ${weather.type || 'clear'} ${(weather.intensity || 0).toFixed(2)} R${(weather.precipitation || 0).toFixed(2)} F${(weather.fog || 0).toFixed(2)}  WIND ${motion.windX ?? 0}`,
            `LIGHT A${(lighting.ambientLight ?? 1).toFixed(2)} S${(lighting.shadowAlpha ?? 0).toFixed(2)} B${(lighting.lightBoost ?? 1).toFixed(2)}`,
            `REACT P${(reactions.puddleAlpha || 0).toFixed(2)} W${(reactions.windowWarmth || 0).toFixed(2)} G${(reactions.warmGlint || 0).toFixed(2)}`,
            `MOTION D${motion.driftEnabled ? 1 : 0} P${motion.particleEnabled ? 1 : 0}`,
            `RITUALS ${(this.ritualConductor?.getSnapshot?.() || []).length} OVER ${this.ritualConductor?.getOverflowCount?.() || 0}`,
            `SKY ${atmosphere.cacheKey}`,
        ];
        const panelHeight = 16 + lines.length * 14;
        ctx.save();
        ctx.font = WORLD_BODY_FONT_11;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(4, 10, 18, 0.72)';
        ctx.fillRect(12, 58, 520, panelHeight);
        ctx.fillStyle = 'rgba(142, 204, 255, 0.48)';
        ctx.fillRect(12, 58, 520, 1);
        ctx.fillRect(12, 58 + panelHeight - 1, 520, 1);
        ctx.fillRect(12, 59, 1, panelHeight - 2);
        ctx.fillRect(531, 59, 1, panelHeight - 2);
        ctx.fillStyle = '#cce9ff';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 20, 77 + i * 14);
        }
        ctx.restore();
    }

    _quantizedAlpha(value) {
        return Math.max(
            0,
            Math.min(1, Math.round((Number(value) || 0) * LIGHT_COLOR_QUANTIZATION_STEPS) / LIGHT_COLOR_QUANTIZATION_STEPS),
        );
    }

    _quantizedColorMix(value) {
        return Math.max(
            0,
            Math.min(1, Math.round((Number(value) || 0) * LIGHT_COLOR_MIX_STEPS) / LIGHT_COLOR_MIX_STEPS),
        );
    }

    _cacheLightFadeColor(key, value) {
        if (!this.lightFadeColorCache.has(key) && this.lightFadeColorCache.size >= LIGHT_FADE_COLOR_CACHE_LIMIT) {
            this.lightFadeColorCache.delete(this.lightFadeColorCache.keys().next().value);
            this._lightFadeColorCacheEvictions++;
        }
        this.lightFadeColorCache.set(key, value);
        return value;
    }

    // Cache `color` → rgba(r,g,b,a) strings keyed by `${color}|${alpha}` so the
    // light pass doesn't re-parse colors per frame.
    _withAlpha(color, alpha) {
        const normalizedColor = String(color || '#ffffff');
        const normalizedAlpha = this._quantizedAlpha(alpha);
        const key = `${normalizedColor}|${normalizedAlpha}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        const [r, g, b] = this._parseLightColor(normalizedColor);
        const out = `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
        return this._cacheLightFadeColor(key, out);
    }

    // Mix a colour toward white by `t` (0 = unchanged, 1 = white). Used for the
    // hot light-glow cores; memoized in the shared colour cache.
    _mixToWhite(color, t) {
        const normalizedColor = String(color || '#ffffff');
        const mixAmount = this._quantizedColorMix(t);
        const key = `mw|${normalizedColor}|${mixAmount}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        const [r, g, b] = this._parseLightColor(normalizedColor);
        const mix = (c) => Math.round(c + (255 - c) * mixAmount);
        const out = `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
        return this._cacheLightFadeColor(key, out);
    }

    _parseLightColor(color) {
        const key = String(color || '#ffffff');
        const cached = this.lightColorRgbCache.get(key);
        if (cached) return cached;
        let rgb = [255, 255, 255];
        if (key.startsWith('#') && key.length === 7) {
            rgb = [
                parseInt(key.slice(1, 3), 16),
                parseInt(key.slice(3, 5), 16),
                parseInt(key.slice(5, 7), 16),
            ];
        } else {
            const match = key.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (match) rgb = [+match[1], +match[2], +match[3]];
        }
        if (this.lightColorRgbCache.size >= LIGHT_COLOR_RGB_CACHE_LIMIT) {
            this.lightColorRgbCache.delete(this.lightColorRgbCache.keys().next().value);
            this._lightColorRgbCacheEvictions++;
        }
        this.lightColorRgbCache.set(key, rgb);
        return rgb;
    }

    _drawAmbientGroundProps(ctx) {
        ctx.save();
        if (this.sprites) {
            for (const prop of AMBIENT_GROUND_PROPS) {
                const { x, y } = tileToWorldElevated(prop.tileX, prop.tileY);
                const id = `prop.${prop.type}`;
                this._drawPropContactShadow(ctx, x, y, id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, id, x, y, this._winterPropOpts(id));
            }
            for (const prop of DISTRICT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const { x, y } = tileToWorldElevated(prop.tileX, prop.tileY);
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
            }
            // #41 — scenic-point storytelling props baked alongside the other
            // cache props so each loiter spot reads as an inhabited place.
            for (const prop of SCENIC_POINT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const { x, y } = tileToWorldElevated(prop.tileX, prop.tileY);
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
            }
        }
        ctx.restore();
    }

    // 2.9 — prop contact shadow: a small soft ellipse at the prop's anchor so
    // props ground like buildings do. Land tiles only — water-surface props
    // (buoys, lilypads) take no shadow.
    _drawPropContactShadow(ctx, x, y, id, tileX, tileY) {
        if (this.waterTiles?.has(`${Math.floor(tileX)},${Math.floor(tileY)}`)) return;
        const dims = this.assets?.getDims?.(id);
        const halfW = Math.min(16, Math.max(6, (dims?.w || 24) * 0.22));
        ctx.save();
        ctx.fillStyle = 'rgba(16, 20, 12, 0.24)';
        ctx.beginPath();
        ctx.ellipse(Math.round(x), Math.round(y + 1), halfW, halfW * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

}
