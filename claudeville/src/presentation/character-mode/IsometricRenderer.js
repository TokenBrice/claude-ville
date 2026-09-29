import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { INCIDENT_COLORS_RGB, THEME, WORLD_BODY_FONT_11 } from '../../config/theme.js';
import { drawPixelFlame, fillPixelEllipse, fillTileDiamond } from './PixelShapes.js';
import { normalizeBuildingType } from '../../config/buildings.js';
import { inVillageMasonry, PORTAL_SPAWN_TILE, TOWN_ROAD_ROUTES, VILLAGE_GATE, VILLAGE_GATE_BOUNDS, VILLAGE_GATE_GEOMETRY, VILLAGE_WALL_ROUTES, YARD_MATERIALS } from '../../config/townPlan.js';
import {
    AMBIENT_GROUND_PROPS,
    AMBIENT_SCENIC_POINTS,
    ANCIENT_RUINS,
    DISTRICT_PROPS,
    SCENIC_POINT_PROPS,
    WATCHTOWER_BEACON_BUOY_TILES,
} from '../../config/scenery.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { Camera } from './Camera.js';
import { createMotionClock, advanceMotionClock, virtualFramesFor } from './MotionClock.js';
import {
    createFrameEnvelope,
    recordFrameEnvelope,
    enableFrameEnvelopeRings,
    snapshotFrameEnvelope,
    getClientPerfMetrics,
    percentileAtSnapshot,
} from '../shared/ClientPerfMetrics.js';
import { getReservedRects } from '../shared/ReservedRects.js';
import { HDR_HIGHLIGHTS_EVENT, overlayContextAttributes, publishDisplayStatus, readHdrHighlights } from '../shared/DisplaySettings.js';
import { installP3OverlayInks, readDisplayMedia, setOverlayInksP3, watchDisplayMedia } from './DisplayColor.js';
import { CameraDirector } from './CameraDirector.js';
import { ParticleSystem } from './ParticleSystem.js';
import { AgentSprite, drawFamiliarMotes, familiarMoteLightSources } from './AgentSprite.js';
import { BuildingSprite, SOURCE_HALO_RADIUS_CAP } from './BuildingSprite.js';

import { SceneryEngine } from './SceneryEngine.js';
import { Pathfinder } from './Pathfinder.js';
import { constrainSteeringToTarget, laneAxisForBridgeOrientation } from './MovementSteering.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { SkyRenderer } from './SkyRenderer.js';
import { AtmosphereState, sourceEnergyFor } from './AtmosphereState.js';
import { WeatherRenderer } from './WeatherRenderer.js';
import { WildlifeRenderer } from './WildlifeRenderer.js';
import { FoliageRenderer } from './FoliageRenderer.js';
import { PropWinter, WINTER_PROPS } from './PropWinter.js';
import { WALL_SPEC, drawWallLantern, lanternLit, paintWallRun, wallLanternLight, wallRunLayout } from './VillageWall.js';
import { SeasonalAmbience, seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { ChimneySmoke } from './ChimneySmoke.js';
import { setPennantWeather } from './PixelPennant.js';
import { openGroundTiles } from './AmbientGround.js';
import { installGroundBake } from './GroundBake.js';
import { OCEAN_HORIZON_WORLD_Y, drawCanvasWaterMood, drawOuterOcean, registerCoastBake } from './CoastBake.js';
import { drawCanvasWaterState } from './CanvasWaterState.js';
import { REVEAL_SAMPLE_H, REVEAL_SAMPLE_W, sampleRevealBands } from './RevealBands.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';
import { BridgeLanterns } from './BridgeLanterns.js';
import { LandmarkActivity } from './LandmarkActivity.js';
import { AgentEventStream } from './AgentEventStream.js';
import { RelationshipState } from './RelationshipState.js';
import { RitualConductor } from './RitualConductor.js';
import { VisitIntentManager } from './VisitIntentManager.js';
import VisitTileAllocator, { standsOnFixture } from './VisitTileAllocator.js';
import { getPulsePriority } from './PulsePolicy.js';
import { annotationModeForPressure, calculateScenePressure, getActiveMarkGovernor, MarkGovernor, setActiveMarkGovernor } from './MarkGovernor.js';
import { fireBreath, fireBreathDepth, groundCourseHeight, lightSourceCacheKey, normalizeLightSource } from './LightSourceRegistry.js';
import { applyTeamPlazaPreferences, getCouncilRingDiagnostics, releaseCouncilRingState } from './CouncilRing.js';
import { ArrivalDepartureController } from './ArrivalDeparture.js';
import { extractRecipientName } from '../../domain/services/RecipientResolver.js';
import { bucketCounts, buckets as signalBuckets } from '../../domain/services/SignalLedger.js';
import { BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { ChronicleMonuments } from './ChronicleMonuments.js';
import { TrailRenderer } from './TrailRenderer.js';
import { Chronicler } from './Chronicler.js';
import { VillageDirector } from './VillageDirector.js';
import { tileToWorld, worldToTile, buildingCenterToWorld } from './Projection.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';
import { attentionScreenRects, isAttentionStatus, layoutAttentionPlates } from './AttentionPlates.js';
import { IDENTITY_LABEL, identityLabelTop, identityLabelWidth } from './WorldLabelKit.js';
import { StaticPropSprite, buildStaticPropDrawables, lineOcclusionColumns } from './StaticPropDrawables.js';
import { buildRestSeatPropSprites } from './RestSeats.js';
import { createDepthDrawable, propPartSortY } from './DrawablePass.js';
import {
    renderWorldFrame,
    collectDampMarks,
    isoFromTileKey,
    isoFromTile,
} from './WorldFrameRenderer.js';
import { createPostFx } from './postfx/PostFx.js';
import { createPostFxFeed } from './postfx/PostFxFeed.js';
import { createGpuWorldRenderer, probeWebgl2Raster } from './gpu/GpuWorldRenderer.js';
import {
    GPU_ATTENTION_LIGHT_PRIORITY,
    forcedGpuWorldRendererMode,
    isChromiumBrowser,
    localLightPhaseForLighting,
    resolveGpuWorldRendererMode,
    shouldProbeWebGpu,
} from './gpu/GpuWorldPolicy.js';
import { NEUTRAL_GRADE } from './GradeEvaluator.js';
import { poolReceiverMask } from './CanvasPoolMask.js';
import {
    buildPoolDodgeStamp,
    drawCanvasGradeLift,
    drawCanvasGradeSaturation,
    gradedPoolReceiver,
} from './CanvasGrade.js';
import { drawCloudShadowCourses } from './CloudShadowCourses.js';
import {
    CANVAS_BUDGET,
    canvasMapPixelCount,
    canvasPixelCount,
    gpuResourceAccounting,
    releaseCanvasBackingStore,
    releaseCanvasMap,
    unifiedRendererResourceAccounting,
} from './CanvasBudget.js';

const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
const LIGHT_FADE_COLOR_CACHE_LIMIT = 1024;
const LIGHT_COLOR_RGB_CACHE_LIMIT = 256;
const LIGHT_COLOR_QUANTIZATION_STEPS = 32;
const LIGHT_COLOR_MIX_STEPS = 16;
const NICKNAME_CACHE_LIMIT = 256;
const WORLD_FRAME_ERROR_REPORT_INTERVAL_MS = 5000;
const WORLD_FRAME_MAX_CONSECUTIVE_FAILURES = 3;
const DEBUG_GLOBAL_OWNERS = new WeakMap();

// Stage B (webgpu contract §8.1) — the default WebGPU world (module, hardware
// adapter, device, every pipeline) resolves from the moment App has loaded
// this module (`IsometricRenderer.prewarmBackend`, beside the asset fetch),
// so on a warm shader cache it is ready by the mount. One still compiling at
// the mount (a cold cache: the first boot after a WGSL, browser or driver
// change) never delays the first frame: the World mounts WebGL2 and switches
// to WebGPU once it is ready and the reveal is done (`_queueWebGpuSwitch`).
// `?renderer=webgpu` waits for it instead.
let earlyWebGpu = null;

function wantsWebGpu(params) {
    const softwareRaster = !forcedGpuWorldRendererMode(params) && probeWebgl2Raster().softwareRaster;
    return shouldProbeWebGpu(params, {
        chromium: isChromiumBrowser(globalThis.navigator),
        gpu: Boolean(globalThis.navigator?.gpu),
        softwareRaster,
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
            return value;
        });
    return entry;
}

function releaseWebGpuWorld(entry) {
    entry?.promise.then(value => value?.device?.destroy?.());
}

// Work kept off the frame (a WebGPU failure's WebGL2 build and terrain
// re-bake): an idle task, or the next task where idle callbacks are missing.
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
const FAST_PROP_AGENT_MARGIN = 36;
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
const LANE_STEERING = Object.freeze({
    correctionPx: 0.55,
    denseCorrectionPx: 0.42,
    arrivalDistancePx: 18,
    minimumCorrectionPx: 0.18,
    avenueOffsetPx: 4.4,
    dirtOffsetPx: 3.4,
    plazaOffsetPx: 2.2,
});
const LOCAL_AVOIDANCE = Object.freeze({
    radiusPx: 28,
    denseRadiusPx: 26,
    strengthPx: 0.8,
    denseStrengthPx: 0.62,
    bucketPx: 40,
});
// 7.4 — foot traffic. Of two walkers within engagePx whose courses agree
// (heading dot > headingDot), the trailing one walks one V7 rung down until
// the gap opens to releasePx: a loose file, never a stack. A walker about to
// come closer than yieldPx to a walker ahead of it (inside its aheadDot
// cone, on a course within 90°: mergeDot) that is walking or giving way
// itself plants and lets the other draw ahead (AgentSprite._yieldToLeader)
// until the gap is back to releasePx; the trigger leads the pair's closing
// speed by closingFrames refreshes. Within lookAheadPx of a corner a
// walker's course is already its next leg.
const FOLLOW_GAP = Object.freeze({
    engagePx: 22,
    releasePx: 24,
    yieldPx: 20.5,
    closingFrames: 2,
    lookAheadPx: 20,
    headingDot: 0.7,
    mergeDot: 0,
    aheadDot: 0.5,
    chainSteps: 12,
});
// 7.4 — a walker bends its course around a villager standing in its way
// (performing, talking, seated, queued): inside this 2:1-ish clearance
// ellipse (the body box |dx| < 14, |dy| < 8 plus two steps' margin) it is
// pushed out along the ellipse normal at up to strength × the local-avoidance
// push. The standing body never moves; a walker coming to stand beside that
// body, or on its last lastLegPx, walks straight in.
const STANDING_CLEARANCE = Object.freeze({ xPx: 28, yPx: 18, strength: 2.5, lastLegPx: 10 });
// 7.4 — villagers at one building fan on a 2:1 ring in visit-slot order
// instead of standing inside one another. The plan's ±6 × ±3 px ring left
// neighbours 6–12 px apart: still one body box (|dx| < 14, |dy| < 8 world
// px) and one clump on screen, so the ring is sized to the body box instead:
// ±16 px across, ±8 px deep, the places beside the anchor first. A walker
// whose stop lands on a standing body re-aims at a ring place while it is
// still more than minApproachPx out (a re-picked visit that would walk a
// fanned body back onto the anchor re-aims too), so it walks into the fan;
// a body that stops inside another's box anyway (a chat approach stops
// wherever it reaches its partner) steps onto the nearest free ring place
// within settleHopPx; bodies already stacked (closer than stackPx) settle
// onto the ring.
const PERFORMING_FAN = Object.freeze({
    radiusXPx: 16,
    radiusYPx: 8,
    overlapXPx: 14,
    overlapYPx: 8,
    stackPx: 3,
    settleHopPx: 12,
    minApproachPx: 1,
    approachPx: 40,
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
// through the arch along -tileY, from `outsideY` to `insideY`, 0.45 tile
// either side of the arch's axis (tile column 19.1): 26 world px between
// the files, both inside the arch.
const GATE_ENTRY_GAP_PX = FOLLOW_GAP.releasePx;
const GATE_ENTRY_LANES = Object.freeze([
    Object.freeze({ tileX: 18.65, outsideY: 39.35, insideY: 37.6 }),
    Object.freeze({ tileX: 19.55, outsideY: 39.35, insideY: 37.6 }),
]);

// C2 — the Canvas fallback grades with the same evaluated grade as the
// resident and hybrid paths. A multiply overlay carries the ambient (exposure
// x gain, with the split tone folded to its mid-weight), the stepped edge and
// the vignette; `_drawAtmosphere` adds the desaturation and lift fills.
function canvasGradeFor(atmosphere = null) {
    const grade = atmosphere?.lightGrade || NEUTRAL_GRADE;
    const base = [0, 1, 2].map(channel => Math.min(1, grade.exposure * grade.gain[channel]
        * Math.sqrt(grade.shadowTint[channel] * grade.highlightTint[channel])));
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
// Full-mode speech/status bubble de-collision. Bubbles are drawn per sprite at
// a fixed head offset, so clustered agents pile unreadably; these drive the
// rect-overlap slot search that stacks bubbles and caps how many render.
const AGENT_BUBBLE_SLOT_CAP = 3;
// Floor for the reservation estimate (short status labels).
const AGENT_BUBBLE_EST_WIDTH = 104;
// Departure Mono advance at the anchored 11 px body size, plus bubble padding.
// Measured against the sprite's own layout, not guessed: AgentSprite adds 18px
// of horizontal padding around the measured text at this size.
const AGENT_BUBBLE_CHAR_WIDTH = 7;
const AGENT_BUBBLE_PADDING = 18;
// Mirrors STATUS_BUBBLE_MAIN_MAX_WIDTH.anchored in AgentSprite.js, which is
// where the text is actually truncated to fit.
const AGENT_BUBBLE_MAX_WIDTH = 232;
const AGENT_BUBBLE_HEIGHT = 22;
// Bubble centre above the head (AgentSprite._drawBubble anchors at the
// label top and lifts 18 screen px), not a fixed height above the feet.
const AGENT_BUBBLE_HEAD_OFFSET = 18;
// Vertical step per stacked slot, in screen pixels; must match AgentSprite
// STATUS_BUBBLE_STACK_STEP so assigned slots line up with the drawn offset.
const AGENT_BUBBLE_STACK_STEP = 24;
const ATMOSPHERE_EFFECT_ASSETS = Object.freeze({
    rainSplash: 'atmosphere.rain.splash',
});
// Archive fade: keep the sprite in the draw loop for this many ms after
// `agent:removed` so the sibling AgentSprite fade/sparkle animation can play.
const ARCHIVE_FADE_DURATION_MS = 800;
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

export class IsometricRenderer {
    constructor(world, options = {}) {
        this.world = world;
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
        this.visitIntentManager = new VisitIntentManager({ world: this.world });
        this.visitTileAllocator = new VisitTileAllocator();
        this.atmosphereState = new AtmosphereState();
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
        this._pairIds = new Map();
        this._pairVisited = new Set();
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
        this._laneTiles = new Map();
        this._staticPropDrawables = [];
        this._drawables = [];
        this._familiarMoteDrawables = [];
        this._harborPendingSignature = '';
        this._contextLost = false;
        this._disposed = false;
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
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
        // ChronicleMonuments takes `assets` and `particles` as optional
        // injections and silently falls back to a vector path without them.
        // They were never passed, so every monument in the village drew as
        // antialiased ellipses while the four authored PixelLab sprites sat
        // unused — smooth curves in a world that is hard pixel steps everywhere
        // else. Wire both.
        this.chronicleMonuments = new ChronicleMonuments({
            store: this.chronicleStore,
            assets: this.assets,
            particles: this.particleSystem,
            // 8.2 — the release crown rides the release's own sloop.
            harbor: this.harborTraffic,
        });
        // 6.7 — the Chronicle dressing layers read the planter's lifetime ledger;
        // 8.2 (M16) — the Harbor's day pennant reads the release records.
        if (this.buildingRenderer) {
            this.buildingRenderer.chronicleDressing = this.chronicleMonuments.planter.dressing;
            this.buildingRenderer.releaseDay = this.chronicleMonuments;
        }
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            sprites: this.agentSprites,
            motionScale: this.motionScale,
        });
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
        this._chronicleNextUpdateAt = 0;
        this._chronicleUpdating = false;
        this._chronicleUpdatePromise = null;
        this._worldModeActive = true;
        this._worldResourcesSuspended = false;
        this._worldResourceGeneration = 0;
        this._worldResumePromise = null;
        this._worldResumeFailures = 0;
        // 0.3 — the boot reveal waits for the opening pose (App._openWorld).
        this._firstFrameReason = 'boot-pending';
        this._worldSpritesDirty = false;
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
        this.dirtPathTiles = new Set();
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
        this.bridgeLanterns = new BridgeLanterns({ renderer: this });
        this.bridgeSpans = this._buildBridgeSpans();
        this._waterTileDescriptors = this._buildWaterTileDescriptors();
        for (const key of this.bridgeTiles.keys()) {
            this.pathTiles.add(key);
        }
        this._generateFrontageSpurs();
        // Re-classify so newly-pathified bridge and spur tiles take their
        // material. _classifyRoadMaterials *adds* to mainAvenueTiles and
        // dirtPathTiles, so clear first to keep the two sets exclusive.
        this.mainAvenueTiles.clear();
        this.dirtPathTiles.clear();
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
                splitForOcclusion: size === 'large',
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y, this._winterPropOpts(id)); },
            });
        });
        this.districtPropSprites = this._buildDistrictPropSprites();
        this._staticPropSprites = [
            ...this.treePropSprites,
            ...this.boulderPropSprites,
            ...this.districtPropSprites,
        ];
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

        // Walkability grid + Pathfinder (Task 11)
        this.walkabilityGrid = this.scenery.getWalkabilityGrid();
        this.pathfinder = new Pathfinder(this.walkabilityGrid);
        this.visitTileAllocator.updateContext({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });

        this.commandCenterGroundProps = [];
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
        this._generateTownSquare(plazaHub.x, plazaHub.y);
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
        const push = (x, y) => { if (this._inMapBounds(x, y)) keys.push(`${x},${y}`); };
        if (dy) for (let x = x0; x <= x1; x++) push(x, dy > 0 ? y1 + 1 : y0 - 1);
        if (dx) for (let y = y0; y <= y1; y++) push(dx > 0 ? x1 + 1 : x0 - 1, y);
        if (dx && dy) push(dx > 0 ? x1 + 1 : x0 - 1, dy > 0 ? y1 + 1 : y0 - 1);
        return keys;
    }

    // 3.3 — every door connects to the road network by a short worn spur
    // (the yard ring used to do this implicitly). Runs once water is known:
    // a breadth-first walk from the entrance over dry, unbuilt tiles to the
    // nearest authored road, plaza or bridge tile. Spur tiles are real path
    // tiles, so routing and the painted ground agree.
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
                if (!this.roadMaterialTiles.has(key)) this.roadMaterialTiles.set(key, 'dirt');
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
            this._addRoadPolyline(route.points, route.width || 1, route.material || 'dirt');
        }
    }

    _addRoadPolyline(points = [], width = 1, material = 'dirt') {
        if (points.length < 2) return;
        for (let i = 0; i < points.length - 1; i++) {
            this._addRoadSegment(points[i], points[i + 1], width, material);
        }
    }

    _addRoadSegment(from, to, width = 1, material = 'dirt') {
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
        this._addRoadPolyline([[18, 38], [20, 38], [21, 38], [20, 39], [18, 39]], 1, 'dirt');
        for (let x = 18; x <= 21; x++) {
            for (let y = 38; y <= 39; y++) {
                if (!this._inMapBounds(x, y)) continue;
                const key = `${x},${y}`;
                this.pathTiles.add(key);
                this._markRoadMaterial(key, 'dirt');
            }
        }
    }

    // Records the authored material of a route tile. Where routes cross the
    // paved one wins (avenue > dock > dirt), so material changes only at
    // junctions; `_classifyRoadMaterials` turns this into the tile sets.
    _markRoadMaterial(key, material) {
        const current = this.roadMaterialTiles.get(key);
        const rank = (m) => (m === 'avenue' ? 3 : m === 'dock' ? 2 : m ? 1 : 0);
        if (rank(material) > rank(current)) this.roadMaterialTiles.set(key, material);
        if (material === 'avenue') {
            this.commandCenterRoadTiles.add(key);
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
        for (let x = centerX - 4; x <= centerX + 5; x++) {
            for (let y = centerY - 3; y <= centerY + 3; y++) {
                const dx = (x - centerX) / 4.4;
                const dy = (y - centerY) / 2.8;
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

    // 3.3 — material follows the authored route that laid the tile (see
    // `_markRoadMaterial`), so it changes only at junctions: no noise field,
    // no (x + y) stripe. Tiles around the plaza hub, bridges and paved yards
    // are avenue; yards, frontage spurs and fallback links are earth.
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
            const yard = material ? null : this.yardTiles?.get(key);
            const paved = material === 'avenue' || material === 'dock' || nearPlaza
                || this.bridgeTiles?.has(key)
                || Boolean(yard && YARD_MATERIALS[yard]?.paved);
            if (paved) this.mainAvenueTiles.add(key);
            else this.dirtPathTiles.add(key);
        }
    }

    _generateTerrainFeatures() {
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                if (this.waterTiles.has(key) || this.sceneryClearTiles.has(key)) continue;
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

        // Guard-posts mark the plaza's west approach and the northern gate. The
        // ceremonial entrance itself is the Command sprite's gate steps and
        // braziers (row southY), so nothing is placed on them.
        this.commandCenterGroundProps.push(
            { tileX: cx - 2.2, tileY: southY + 0.6, type: 'guardpost', phase: 2.8 },
            { tileX: cx + w + 2.2, tileY: northY + 0.4, type: 'guardpost', phase: 3.9 },
        );

        // Watchfires around ceremonial paths for subtle pulse signals.
        if (this._inMapBounds(cx - 3.5, southY + 0.4)) {
            this.commandCenterGroundProps.push({ tileX: cx - 3.5, tileY: southY + 0.4, type: 'watchfire', phase: 1.35 });
        }
        if (this._inMapBounds(cx + w + 2.4, cy + 0.9)) {
            this.commandCenterGroundProps.push({ tileX: cx + w + 2.4, tileY: cy + 0.9, type: 'watchfire', phase: 4.7 });
        }
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
            { tileX: 4.8, tileY: 32.2, particleType: 'portalRune', chance: 0.022 },
            { tileX: 22.4, tileY: 33.1, particleType: 'questPing', chance: 0.014 },
            { tileX: 8.5, tileY: 16.8, particleType: 'archiveMote', chance: 0.022 },
            { tileX: 23.4, tileY: 17.8, particleType: 'sparkle', chance: 0.012 },
            { tileX: 32.5, tileY: 16.4, particleType: 'beaconMote', chance: 0.014 },
        ];

        for (const prop of this.commandCenterGroundProps) {
            if (prop.type === 'watchfire') {
                emitters.push({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    particleType: 'torch',
                    chance: 0.022,
                });
            }
        }

        this.ambientEmitters = emitters.map(emitter => ({
            ...emitter,
            ...tileToWorld(emitter.tileX, emitter.tileY),
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
        const prep = { note: `failed in frame: ${failure.summary}`, failed: this.gpuWorld, stage: 'build', canvas: null, next: null };
        this._fallbackPrep = prep;
        if (inFrame) this._stepFallbackPrep({ now: true });
        else whenIdle(() => this._stepFallbackPrep({ prep }));
    }

    // One idle step of the pending fallback: build the WebGL2 world; re-bake
    // the terrain canvas it uploads; arm the swap and draw it (`renderNow`).
    // `now` (a frame exception, or `renderNow` drawing during the hold) builds
    // and arms in this task and leaves the bake to the frame about to draw.
    // A World that stopped, left for Dashboard or changed world meanwhile
    // drops the pending fallback; the next frame starts it again.
    _stepFallbackPrep({ now = false, prep = this._fallbackPrep } = {}) {
        if (!prep || prep !== this._fallbackPrep) return;
        if (
            !this.running
            || this._disposed
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this.gpuWorld !== prep.failed
        ) {
            this._cancelFallbackPrep();
            return;
        }
        if (prep.stage === 'build') {
            prep.stage = 'bake';
            prep.canvas = this.fxCanvas.cloneNode(false);
            prep.next = createGpuWorldRenderer({ canvas: prep.canvas, enabled: true });
            if (!now) {
                whenIdle(() => this._stepFallbackPrep({ prep }));
                return;
            }
        } else if (prep.stage === 'bake' && !now) {
            prep.stage = 'swap';
            this._getTerrainCache();
            whenIdle(() => this._stepFallbackPrep({ prep }));
            return;
        }
        this._fallbackPrep = null;
        if (prep.next?.isActive?.()) {
            this._worldSwap = { gpuWorld: prep.next, canvas: prep.canvas, previous: null, fallback: prep.note };
        } else {
            prep.next?.dispose?.();
            this._dropToCanvasWorld(`${prep.note} · WebGL2 unavailable`);
        }
        this._invalidateIdleFrame();
        if (now) return;
        // The hold is no frame interval: the next loop frame steps the camera
        // and the clock as an ordinary one (`_loop`'s first-frame dt).
        this._lastFrameTime = null;
        this.renderNow();
    }

    _cancelFallbackPrep() {
        this._fallbackPrep?.next?.dispose?.();
        this._fallbackPrep = null;
    }

    // The Canvas world for the rest of the session (no GPU world at all).
    _dropToCanvasWorld(note) {
        this._cancelFallbackPrep();
        this._worldSwap?.gpuWorld?.dispose?.();
        this._worldSwap = null;
        this.gpuWorld?.dispose?.();
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this._postFxCanvasVisible = null;
        this._setPostFxCanvasVisible(false);
        this._applyDisplayColor();
        this._noteWorldBackend(note);
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
        });
        // #21 — cinematic director listens for VillageDirector camera cues and
        // drives time-boxed glides on the camera (abort-on-input is in Camera).
        this.cameraDirector?.dispose?.();
        this.cameraDirector = new CameraDirector(this.camera, { motionScale: this.motionScale });
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
        for (const agent of this.world.agents.values()) {
            this._addAgentSprite(agent);
        }
        this._syncRitualContext();

        this.agentEventStream?.dispose?.();
        this.relationshipState?.dispose?.();
        this.agentEventStream = new AgentEventStream(this.world, {
            shouldEmitToolEvent: (event, agent) => this._canAcceptToolRitual(event, agent),
            shouldEmitEvent: () => this._worldModeActive,
        });
        this.relationshipState = new RelationshipState(this.world);
        this._replayActiveToolRituals({ force: true });
        this._updateVisitSystems(Date.now());
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
            eventBus.on('agent:added', (agent) => {
                if (!this._worldModeActive) {
                    this._worldSpritesDirty = true;
                    return;
                }
                this._addAgentSprite(agent);
                this._beginRelationshipArrival(agent);
            }),
            eventBus.on('agent:removed', (agent) => {
                if (!this._worldModeActive) {
                    this._removeAgentSprite(agent.id);
                    this._worldSpritesDirty = true;
                    return;
                }
                // The sprite usually left the moment the agent departed
                // (agent:updated); this only catches one that never did.
                this._beginAgentDeparture(agent);
            }),
            eventBus.on('agent:updated', (agent) => {
                if (!this._worldModeActive) {
                    const sprite = this.agentSprites.get(agent.id);
                    if (sprite?.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                    else if (sprite) sprite.agent = agent;
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
            // #attract — topbar toggle flips the idle-attract camera live.
            eventBus.on('camera:auto-camera', (payload) => this.cameraDirector?.setAutoMode?.(payload?.enabled !== false)),
            // 10.2 / 10.3 — SET's HDR highlights and the screen's media
            // queries (a window moved to or from an HDR / P3 screen).
            eventBus.on(HDR_HIGHLIGHTS_EVENT, () => this._applyDisplayColor()),
            watchDisplayMedia(() => this._applyDisplayColor()),
            // 4.8 — earned nicknames garnish agent name tags.
            eventBus.on('biography:updated', (payload) => {
                const identityKey = payload?.identityKey;
                if (!identityKey) return;
                this._invalidateIdleFrame();
                const nickname = payload?.biography?.nickname || null;
                this._cacheNickname(identityKey, nickname);
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
            this._handleClick(worldPos.x, worldPos.y);
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
            const hoveredBuilding = this.buildingRenderer?.hitTest(worldPos.x, worldPos.y) ?? null;
            this.buildingRenderer?.setHovered(hoveredBuilding);
            this.villageDirector?.setHoveredBuilding?.(hoveredBuilding);
            const monument = hoveredBuilding ? null : this.chronicleMonuments?.hitTest?.(worldPos.x, worldPos.y, Date.now());
            // 3.6 — harbor lore: hovering a ship surfaces its commit subject.
            const hoveredShip = (hoveredBuilding || monument)
                ? null
                : (this.harborTraffic?.hitTestShip?.(worldPos.x, worldPos.y) ?? null);
            this.harborTraffic?.setHoveredShip?.(hoveredShip ? hoveredShip.id : null);
            const bridgeLantern = (hoveredBuilding || monument || hoveredShip)
                ? null
                : (this.bridgeLanterns?.hitTest?.(worldPos.x, worldPos.y, Date.now()) ?? null);
            this.bridgeLanterns?.setHovered?.(bridgeLantern);
            const tokenItem = (hoveredBuilding || monument || hoveredShip || bridgeLantern)
                ? null
                : (this.landmarkActivity?.hitTestTokenItem?.(worldPos.x, worldPos.y) ?? null);
            canvas.title = hoveredBuilding
                ? this._buildingVisitorTooltip(hoveredBuilding)
                : (monument
                    ? this.chronicleMonuments.tooltipFor(monument, Date.now())
                    : (hoveredShip
                        ? this.harborTraffic.shipTooltip(hoveredShip)
                        : (bridgeLantern
                            ? this.bridgeLanterns.tooltipFor(bridgeLantern, Date.now())
                            : (tokenItem ? this.landmarkActivity.tokenItemTooltip(tokenItem) : ''))));
            this._scheduleAgentHoverTest(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);
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
            canvas.title = '';
        };
        canvas.addEventListener('mouseleave', this._onMouseLeaveMain);
        this._onKeyDown = (e) => {
            if (e.code === 'KeyD' && e.shiftKey) void this._toggleDebugOverlay('toggle');
            if (e.code === 'KeyP' && e.shiftKey) void this._toggleDebugOverlay('togglePathDebug');
            this._handleWorldKeyboardCommand(e);
        };
        window.addEventListener('keydown', this._onKeyDown);
        this._onReadKeyUp = (event) => {
            if (event.code === 'KeyB') this.setReadMode(false);
        };
        this._onReadBlur = () => this.setReadMode(false);
        window.addEventListener('keyup', this._onReadKeyUp);
        window.addEventListener('blur', this._onReadBlur);
        this._onModeChanged = (mode) => this.setWorldModeActive(mode !== 'dashboard');
        this._unsubscribers.push(eventBus.on('mode:changed', this._onModeChanged));

        this.running = true;
        this._startLoop();
        return true;
    }

    setReadMode(on) {
        const next = Boolean(on);
        if (this._readMode === next) return;
        this._readMode = next;
        this._invalidateIdleFrame();
    }

    getReadMode() {
        return Boolean(this._readMode);
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
            this.canvas.removeEventListener('mouseleave', this._onMouseLeaveMain);
            this.canvas.title = '';
        }
        if (this._agentHoverRafId !== null) {
            cancelAnimationFrame(this._agentHoverRafId);
            this._agentHoverRafId = null;
        }
        this._setHoveredAgentSprite(null);
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
        window.removeEventListener('keyup', this._onReadKeyUp);
        window.removeEventListener('blur', this._onReadBlur);
        this.setReadMode(false);
        if (this._chronicleChannelListener && this.chronicleStore?.channel?.removeEventListener) {
            this.chronicleStore.channel.removeEventListener('message', this._chronicleChannelListener);
        }
        this._chronicleChannelListener = null;
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
        AgentSprite.releaseSharedCaches?.();
        this.compositor?.dispose?.();
        this.gateTransits.clear();
        this.particleSystem.clear();
        this.buildingRenderer?.dispose?.();
        this.releaseVolatileCaches();
        this.trailRenderer?.dispose?.();
        this.trailRenderer = null;
        this.agentEventStream?.dispose?.();
        releaseCouncilRingState(this.relationshipState);
        this.relationshipState?.dispose?.();
        this.harborTraffic?.dispose?.();
        this.landmarkActivity?.dispose?.();
        this.chronicleMonuments?.dispose?.();
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
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this._fpsFrames = 0;
        this._fpsWindowStart = null;
        eventBus.emit('fps:updated', null);
    }

    setWorldModeActive(active) {
        const nextActive = Boolean(active);
        if (this._worldModeActive === nextActive) {
            if (!nextActive) this._suspendWorldModeResources();
            return;
        }
        this._worldModeActive = nextActive;
        this._lastFrameTime = performance.now();
        if (nextActive) {
            void this._beginWorldModeResume();
        } else {
            this._worldResourceGeneration++;
            this._stopLoop();
            this._suspendWorldModeResources();
        }
    }

    pauseForVisibility() {
        this._worldResourceGeneration++;
        this._stopLoop();
        if (this._worldResourcesSuspended) this.assets?.suspend?.();
        this.releaseVolatileCaches();
    }

    resumeFromVisibility({ active = true } = {}) {
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

    releaseVolatileCaches() {
        releaseCanvasBackingStore(this.terrainCache);
        this.terrainCache = null;
        this.terrainCacheKey = '';
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
        });
    }

    // `keepSurfaces` (a context restore): the viewport canvases stay sized, so
    // the page's loading bands show through the cleared surfaces while the
    // resources rebuild, never a black 0x0 opaque canvas.
    _suspendWorldModeResources({ keepSurfaces = false } = {}) {
        // Always forward suspension so an in-flight decoded-asset reload is
        // aborted even when the renderer already released its own surfaces.
        this.assets?.suspend?.();
        if (this._worldResourcesSuspended) return;
        this.releaseVolatileCaches();
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

        const generation = ++this._worldResourceGeneration;
        this._stopLoop();
        const operation = Promise.resolve()
            .then(() => this._resumeWorldModeResources())
            .then((ready) => {
                if (
                    !ready
                    || this._disposed
                    || !this.running
                    || !this._worldModeActive
                    || generation !== this._worldResourceGeneration
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
            if (this._worldResumePromise === wrapped) this._worldResumePromise = null;
        });
        this._worldResumePromise = wrapped;
        return wrapped;
    }

    async _resumeWorldModeResources() {
        if (!this._worldResourcesSuspended) {
            this.trailRenderer?.resume?.();
            return true;
        }
        if (this.assets?.resume) {
            const assetsReady = await this.assets.resume();
            if (!assetsReady) return false;
        }
        if (this._disposed || !this._worldModeActive || !this._worldResourcesSuspended) return false;
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
        for (const agent of this.world?.agents?.values?.() || []) {
            if (agent.isDeparted) {
                // Departed while world mode was inactive: walk out now, and
                // never spawn a sprite for one that already left.
                if (this.agentSprites.has(agent.id)) this._beginAgentDeparture(agent);
                continue;
            }
            this._addAgentSprite(agent);
        }
        this._worldSpritesDirty = false;
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
            if (!candidates.has(sprite)) continue;
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
        const agents = this._snapshotSortedSprites();
        const viewport = this._screenViewport();
        for (const record of this._staticPropFastDrawables || []) {
            if (!this._propVisibleOnScreen(record.sprite, viewport)) continue;
            if (record.columns) {
                for (const column of record.columns) out.push(column);
            } else if (record.sprite?.splitForOcclusion && this._propIntersectsAgentBand(record.sprite, agents)) {
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

    _propIntersectsAgentBand(prop, agents) {
        const bounds = prop?.bounds;
        if (!bounds || !agents?.length) return false;
        const left = prop.x + bounds.left - FAST_PROP_AGENT_MARGIN;
        const right = prop.x + bounds.right + FAST_PROP_AGENT_MARGIN;
        const top = prop.y + bounds.top - FAST_PROP_AGENT_MARGIN;
        const bottom = prop.y + bounds.bottom + FAST_PROP_AGENT_MARGIN;
        for (const sprite of agents) {
            if (!sprite || this._isGateTransit(sprite, 'departure')) continue;
            if (sprite.x < left || sprite.x > right || sprite.y < top || sprite.y > bottom) continue;
            return true;
        }
        return false;
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
            for (const agentId of departures) this._removeAgentSprite(agentId);
        }
    }

    get motionTimeMs() {
        return this._motionClock?.elapsedMs ?? 0;
    }

    setQuotaState(state) {
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
        const allAgentPoints = [];
        for (const sprite of this.agentSprites.values()) {
            if (Number.isFinite(sprite?.x) && Number.isFinite(sprite?.y)) {
                const point = { x: sprite.x, y: sprite.y };
                allAgentPoints.push(point);
                if (this._cameraAgentFrameWeight(sprite) > 0) {
                    activePoints.push(point);
                    const buildingPoint = this._agentBuildingFramePoint(sprite.agent);
                    if (buildingPoint) activePoints.push(buildingPoint);
                }
            }
        }

        const hotBuildingPoints = [];
        const buildingSignals = this.villageDirector?.getSnapshot?.()?.buildingSignals || [];
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
        if (allAgentPoints.length) return this._worldBoxForCameraPoints(allAgentPoints);

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
        if (!this._didEstablishingShot && this.playOpeningShot({ targetBox })) return;

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
        this.camera?.setPresented?.(false);
        // A static scene may skip idle frames; the armed frame has to draw.
        this._invalidateIdleFrame();
    }

    // Runs right after a render, in the same task, so the bands it measures
    // are the frame the compositor is about to present (the WebGL surface
    // does not preserve its drawing buffer past that task).
    _signalFirstFrame() {
        const reason = this._firstFrameReason;
        if (!reason || reason === 'boot-pending') return;
        this._firstFrameReason = null;
        this.camera?.setPresented?.(true);
        const horizonY = this._horizonScreenFraction();
        const measured = this._sampleFrameBands(4, horizonY);
        eventBus.emit('world:first-frame', {
            reason,
            sky: this._lastAtmosphere?.sky?.palette || null,
            sea: measured?.sea || null,
            horizonY,
            bands: measured?.bands || null,
            cell: this._revealCell(),
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
    _sampleFrameBands(count, horizonY) {
        let fx = this.fxCanvas;
        if (fx && fx.style.display !== 'none' && this.gpuWorld?.readoutSurface) {
            fx = this.gpuWorld.readoutSurface(REVEAL_SAMPLE_W, REVEAL_SAMPLE_H);
        }
        return sampleRevealBands([this.canvas, fx, this.overlayCanvas], { count, horizonY });
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
        try {
            this._stepFallbackPrep({ now: true });
            const swap = this._worldSwap?.fallback ? this._beginWorldSwap() : null;
            try {
                this._render(0);
            } finally {
                if (swap) this._endWorldSwap(swap);
            }
        } catch (error) {
            this._reportFrameFailure(error, 'render');
            return false;
        }
        this._recordIdleRenderState();
        this._signalFirstFrame();
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
            this._setMotionScale(Math.max(0, Math.min(1, motionScale)));
        }

        const clock = atmosphere.clock || null;
        const hour = Number(clock?.hours);
        if (Number.isFinite(hour)) {
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

    _allocateVisitTile(request = {}) {
        const building = request.building || this._getBuildingByType(request.intent?.building);
        return this.visitTileAllocator?.allocate?.({
            ...request,
            building,
        }) || null;
    }

    _getAmbientDestination({ agent, recentBuildings = [], cycle = 0 } = {}) {
        if (!agent?.id) return null;
        const seed = Math.abs(Math.floor(this._tileNoise(agent.id.length + cycle * 7, cycle + String(agent.id).charCodeAt(0)) * 100000));
        const recent = new Set(recentBuildings);
        const provider = String(agent.provider || '').toLowerCase();
        const model = String(agent.model || '').toLowerCase();
        const sprite = this.agentSprites.get(agent.id);
        const sourceTile = sprite?._screenToTile?.(sprite.x, sprite.y) || agent.position || null;
        const weighted = AMBIENT_SCENIC_POINTS
            .map((point, index) => {
                let score = index * 0.1 + ((seed + index * 17) % 37);
                if (sourceTile) score += Math.hypot((sourceTile.tileX || 0) - point.tileX, (sourceTile.tileY || 0) - point.tileY) * 1.4;
                if (recent.has(`ambient:${point.id}`)) score += 80;
                if (provider === 'gemini' && point.tags?.includes('observatory')) score -= 12;
                if (provider === 'codex' && point.tags?.includes('forge')) score -= 10;
                if (provider === 'claude' && point.tags?.includes('command')) score -= 8;
                if (provider === 'kimi' && point.tags?.includes('portal')) score -= 10;
                if (provider === 'opencode' && point.tags?.includes('portal')) score -= 8;
                if (model.includes('deepseek') && point.tags?.includes('observatory')) score -= 10;
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

    _updateVisitSystems(now = Date.now()) {
        const agents = Array.from(this.world?.agents?.values?.() || []);
        this._activeAgentsSnapshot = agents;
        this.visitIntentManager?.reconcile?.(agents, now);
        this.visitTileAllocator?.updateContext?.({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });
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
            ritualOverflow: this.ritualConductor?.getOverflowCount?.() || 0,
            allocatorMetrics: reservations.metrics || {},
            reservationCount: reservations.reservationCount || 0,
            buildingCrowds: reservations.buildings || {},
            crowd: this._crowdStats || this._summarizeCrowdClusters(),
            localAvoidance: { ...this._localAvoidanceMetrics },
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
        if (event.code === 'KeyB') {
            this.setReadMode(true);
            event.preventDefault();
            return;
        }

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
            if (this._zoomByKeyboard(1)) { this.camera.abortDirectorGlide?.(); this.camera.noteUserInput?.(); event.preventDefault(); }
            return;
        }
        if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
            if (this._zoomByKeyboard(-1)) { this.camera.abortDirectorGlide?.(); this.camera.noteUserInput?.(); event.preventDefault(); }
            return;
        }
        if (event.code === 'KeyF') {
            // C6 — an explicit frame command is a genuine operator action: it
            // hands Ambient/replay back without touching the auto idle clock.
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
        if (event.code === 'Escape') {
            this.selectAgentById(null);
            this.onAgentSelect?.(null);
            event.preventDefault();
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
        const steps = Array.isArray(camera?.zoomSteps) && camera.zoomSteps.length
            ? camera.zoomSteps
            : [camera?.minZoom || 1, camera?.maxZoom || 3];
        const zoom = camera?.zoom || 1;
        const currentIndex = steps.reduce((bestIndex, step, index) => (
            Math.abs(step - zoom) < Math.abs(steps[bestIndex] - zoom) ? index : bestIndex
        ), 0);
        const nextIndex = Math.max(0, Math.min(steps.length - 1, currentIndex + direction));
        const targetZoom = steps[nextIndex];
        if (!camera || targetZoom === zoom) return false;
        camera.stopFollow();
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
            const sprite = new AgentSprite(agent, {
                pathfinder: this.pathfinder,
                bridgeTiles: this.bridgeTiles,
                assets: this.assets,
                compositor: this.compositor,
                getIntentForAgent: (agentId) => this.visitIntentManager?.getIntentForAgent?.(agentId) || null,
                getBuilding: (type) => this._getBuildingByType(type),
                getBridgeLift: (tileX, tileY) => this.getBridgeLift(tileX, tileY),
                allocateVisitTile: (request) => this._allocateVisitTile(request),
                releaseVisitReservation: (agentId) => this.visitTileAllocator?.release?.(agentId),
                renewVisitReservation: (agentId) => this.visitTileAllocator?.renew?.(agentId),
                getAmbientDestination: (request) => this._getAmbientDestination(request),
                getRoadTiles: () => this.pathTiles,
                getTileType: (tileX, tileY) => this._surfaceMaterialAt(tileX, tileY),
                motionClock: this._motionClock,
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

    /** 4.8 — push cached earned nicknames onto every live sprite. */
    _applyNicknames() {
        if (!this._nicknames) return;
        for (const sprite of this.agentSprites.values()) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            sprite.setNickname?.(identityKey ? this._nicknames.get(identityKey) || null : null);
        }
    }

    _cacheNickname(identityKey, nickname) {
        if (!identityKey) return;
        this._nicknames.delete(identityKey);
        if (nickname) this._nicknames.set(identityKey, nickname);
        this._pruneNicknameCache();
    }

    _pruneNicknameCache() {
        if (this._nicknames.size <= NICKNAME_CACHE_LIMIT) return;
        const liveIdentityKeys = new Set();
        for (const sprite of this.agentSprites.values()) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            if (identityKey) liveIdentityKeys.add(identityKey);
        }
        for (const identityKey of this._nicknames.keys()) {
            if (this._nicknames.size <= NICKNAME_CACHE_LIMIT) break;
            if (!liveIdentityKeys.has(identityKey)) this._nicknames.delete(identityKey);
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
        const isFree = (tileX, tileY) => {
            if (this.pathfinder && !this.pathfinder.isWalkable(Math.round(tileX), Math.round(tileY))) return false;
            for (const body of bodies) {
                if (Math.hypot(body.tileX - tileX, body.tileY - tileY) < 0.9) return false;
            }
            if (reservations) {
                for (const reservation of reservations.values()) {
                    if (reservation.agentId === agent?.id) continue;
                    if (Math.hypot(reservation.tileX - tileX, reservation.tileY - tileY) < 0.6) return false;
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

        this.arrivalDeparture?.recordDeparture?.(agent, lastTile, { now, parentAlive: false });
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

        // Subagents step out of the Portal Gate toward their parent; with
        // motion, the dispatch comet (6.3) relocates them beside the parent.
        const parentRef = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (parentRef) {
            const parentSprite = this.agentSprites.get(parentRef);
            const parentTile = parentSprite && typeof parentSprite._screenToTile === 'function'
                ? parentSprite._screenToTile(parentSprite.x, parentSprite.y)
                : null;
            const intent = this.visitIntentManager?.getIntentForAgent?.(parentRef) || null;
            const intentBuilding = intent?.building ? this._getBuildingByType(intent.building) : null;
            const intentVisitTile = intentBuilding && typeof intentBuilding.primaryVisitTile === 'function'
                ? intentBuilding.primaryVisitTile()
                : null;
            const destination = parentTile || intentVisitTile || null;

            sprite.setTilePosition?.(
                PORTAL_SPAWN_TILE.tileX + this._gateJitter(agent, 'portal-x', 0.32),
                PORTAL_SPAWN_TILE.tileY + this._gateJitter(agent, 'portal-y', 0.22),
            );
            if (this.motionScale <= 0 || !destination) {
                return;
            }
            sprite.walkToTile?.(destination.tileX, destination.tileY);
            this.gateTransits.set(agent.id, { type: 'arrival' });
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
            if (live !== sprite || sprite.leaving || !sprite.isArrivalPending?.() || this._isGateTransit(sprite, 'departure')) {
                queue.shift();
                continue;
            }
            const lane = GATE_ENTRY_LANES.find(entry => this._gateLaneClear(entry));
            if (!lane) return;
            queue.shift();
            sprite.setTilePosition?.(lane.tileX, lane.outsideY);
            sprite.walkStraightToTile?.(lane.tileX, lane.insideY);
            this.gateTransits.set(agent.id, { type: 'arrival', gate: true });
            this._markSpritesDirty();
        }
    }

    // True when no visible body stands within GATE_ENTRY_GAP_PX of the gate
    // lane's entry point.
    _gateLaneClear(lane) {
        const entry = tileToWorld(lane.tileX, lane.outsideY);
        for (const other of this.agentSprites.values()) {
            if (other.isArrivalPending?.()) continue;
            if (Math.hypot(other.x - entry.x, other.y - entry.y) < GATE_ENTRY_GAP_PX) return false;
        }
        return true;
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
        this.gateTransits.set(agent.id, { type: 'departure' });
        this._markSpritesDirty();
    }

    // A villager leaves the moment its agent departs; the exit runs once.
    // Subagents merge back into their parent, orphans return to the Portal
    // Gate, and top-level sessions walk out through the village gate.
    _beginAgentDeparture(agent) {
        const sprite = this.agentSprites.get(agent?.id);
        if (!sprite || sprite._archiveAnim || this._isGateTransit(sprite, 'departure')) return;
        const handled = this._beginRelationshipDeparture(agent);
        if (!handled) this._beginAgentGateDeparture(agent);
    }

    // Session came back while its villager was still walking to the gate:
    // turn around where it stands instead of popping back to the gate.
    _returnFromGateDeparture(agent, sprite) {
        this.gateTransits.delete(agent.id);
        sprite.leaving = false;
        sprite.retargetVisit?.();
        this._markSpritesDirty();
    }

    _removeAgentSprite(agentId) {
        const sprite = this.agentSprites.get(agentId);
        if (!sprite) return;
        if (this.selectedAgent?.id === agentId) {
            this.selectedAgent = null;
            this.camera?.stopFollow?.();
        }
        this.gateTransits.delete(agentId);
        this.visitTileAllocator?.release?.(agentId);
        // Archive fade: defer the actual sprite disposal by
        // ARCHIVE_FADE_DURATION_MS so AgentSprite.draw() fade alpha + sparkle
        // puff can play. The sprite stays in agentSprites and is collected by
        // _pruneArchiveFadedSprites(). Reduced motion (motionScale === 0)
        // short-circuits to immediate disposal — there is no fade to play.
        const motionScale = this.motionScale ?? 1;
        if (motionScale > 0 && !sprite._archiveAnim) {
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

    _updateGateDoorState(now = performance.now()) {
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

    _handleClick(worldX, worldY) {
        if (!this.agentSprites.size && !this.buildingRenderer) return;
        this._invalidateIdleFrame();

        let clicked = null;

        // Per-pixel agent hit test (sorted: most front first)
        const sorted = Array.from(this.agentSprites.values())
            .sort((a, b) => b.y - a.y);            // front-most first
        for (const sprite of sorted) {
            if (this._isGateTransit(sprite, 'departure')) continue;
            if (sprite.hitTest(worldX, worldY)) {
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
            // 4.7 — selecting a district monument opens its stone ledger. It is
            // an inspection of the record, not a session selection.
            const monument = this.chronicleMonuments?.hitTest?.(worldX, worldY, Date.now()) ?? null;
            if (monument) {
                this.chronicleMonuments.setSelectedMonument?.(monument.id);
                for (const sprite of this.agentSprites.values()) sprite.selected = false;
                this.selectedAgent = null;
                if (this.onAgentSelect) this.onAgentSelect(null);
                eventBus.emit(BUILDING_EVENTS.DESELECTED);
                return;
            }
            this.chronicleMonuments?.setSelectedMonument?.(null);
        }

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
            this._applyAgentHover(this._agentHoverX, this._agentHoverY);
        });
    }

    _applyAgentHover(worldX, worldY) {
        let hit = null;
        if (this.agentSprites.size) {
            const sorted = Array.from(this.agentSprites.values())
                .sort((a, b) => b.y - a.y);            // front-most first
            for (const sprite of sorted) {
                if (this._isGateTransit(sprite, 'departure')) continue;
                if (sprite.hitTest(worldX, worldY)) {
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
            // Hovering a villager surfaces where its line actually came from,
            // so the provenance badge on the bubble is legible rather than
            // merely decorative.
            if (this.canvas) this.canvas.title = hit.dialogueTooltip?.() || '';
        }
    }

    _setHoveredAgentSprite(sprite) {
        if (this._hoveredAgentSprite === sprite) return;
        this._invalidateIdleFrame();
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(false);
        this._hoveredAgentSprite = sprite || null;
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(true);
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
            || director?.buildingPresence?.size
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

        // The live clock continuously changes sky, light and deterministic
        // weather. A frozen date or explicit hour is required before the scene
        // can be considered timeless.
        if (!this.atmosphereState?._frozenDate && !Number.isFinite(this.atmosphereState?._hourOverride)) {
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
            || this.gpuWorld?.pendingGpuQueries?.length
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
        return this.motionScale <= 0
            && !this._idleFrameDirty
            && this._cameraIdleStable()
            && !this._hasTimedIdleTransition(now)
            && !this._pendingIdleResourceWork();
    }

    _recordIdleRenderState() {
        const camera = this.camera;
        if (camera) {
            this._idleLastRenderCamera.x = camera.x;
            this._idleLastRenderCamera.y = camera.y;
            this._idleLastRenderCamera.zoom = camera.zoom;
        }
        this._idleFrameDirty = false;
    }

    _loop(frameTime) {
        if (!this.running) return;
        this.frameId = null;
        if (!this._worldModeActive || this._contextLost) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const now = performance.now();
        const frameGapMs = Number.isFinite(this._lastFrameTime) ? now - this._lastFrameTime : 0;
        const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
        // 0.1 — the resident ladder's pacing sample: the gap between rAF
        // timestamps (vsync-aligned frame begin times, steadier than callback
        // wall time). A gap across a pause or resume — anything that reset
        // `_lastFrameTime` outside this loop — is not a display interval.
        const vsyncTime = Number.isFinite(frameTime) ? frameTime : now;
        if (this._lastFrameTime === this._lastLoopFrameTime && Number.isFinite(this._lastVsyncTime)) {
            this.gpuWorld?.notePresentInterval?.(vsyncTime - this._lastVsyncTime);
        }
        this._lastVsyncTime = vsyncTime;
        this._lastLoopFrameTime = now;
        this._lastFrameTime = now;
        // A failed WebGPU world starts its WebGL2 fallback; while that builds
        // off the frame the loop holds the last presented frame (no update,
        // no render), and the swap then dirties the idle frame, so a
        // reduced-motion session swaps too.
        this._fallBackFromWebGpu();
        if (this._fallbackPrep) {
            this._startLoop();
            return;
        }
        if (this._canSkipIdleFrame(Date.now())) {
            this._recordFrameEnvelope(0, 0, 0, frameGapMs, null);
            if (this._performanceSamples) this._recordPerformanceSample(0, 0, 0);
            this._trackFps(now);
            this._frameFailureStats.consecutive = 0;
            this._startLoop();
            return;
        }
        advanceMotionClock(this._motionClock, dt, this.motionScale ?? 1);
        this.waterFrame = virtualFramesFor(this.motionTimeMs) * WATER_FRAME_STEP;
        const perf = getClientPerfMetrics();
        let updateToken = null;
        let renderToken = null;
        let stage = 'update';
        let updateMs = 0;
        let renderMs = 0;
        const updateStart = now;
        let renderStart = now;
        try {
            if (perf?.enabled) updateToken = perf.beginRenderStage('world-update');
            this._update(dt);
            const afterUpdate = performance.now();
            updateMs = afterUpdate - updateStart;
            if (updateToken) {
                perf.endRenderStage(updateToken);
                updateToken = null;
            }
            stage = 'render';
            renderStart = afterUpdate;
            if (perf?.enabled) renderToken = perf.beginRenderStage('world-render');
            // Stage B — a WebGPU world that finished compiling after a
            // WebGL2 mount takes over at this frame when it draws it; a
            // failed WebGPU world hands over to its WebGL2 fallback the same way.
            const worldSwap = this._beginWorldSwap();
            try {
                this._render(dt);
            } finally {
                if (worldSwap) this._endWorldSwap(worldSwap);
            }
            // A WebGPU frame that failed mid-render left only the Canvas
            // atmosphere under the overlay (its records were the GPU's): the
            // same frame renders again on the WebGL2 fallback (or, without
            // WebGL2, on the Canvas world) in this task, so the page never
            // presents the broken one.
            if (!worldSwap && this.worldRendererMode === 'webgpu' && this.gpuWorld?.failure) {
                this._fallBackFromWebGpu({ inFrame: true });
                const fallbackSwap = this._beginWorldSwap();
                if (fallbackSwap) {
                    try {
                        this._render(0);
                    } finally {
                        this._endWorldSwap(fallbackSwap);
                    }
                } else if (this.worldRendererMode === 'canvas') {
                    this._render(0);
                }
            }
            const afterRender = performance.now();
            renderMs = afterRender - renderStart;
            this._recordIdleRenderState();
            this._signalFirstFrame();
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
            this._frameFailureStats.consecutive = 0;
        } catch (error) {
            const failedAt = performance.now();
            if (stage === 'update') {
                updateMs = failedAt - updateStart;
            } else if (stage === 'render') {
                updateMs = renderStart - updateStart;
                renderMs = failedAt - renderStart;
            }
            this._recordFrameEnvelope(updateMs, renderMs, failedAt - updateStart, frameGapMs, stage);
            this._reportFrameFailure(error, stage, now);
        } finally {
            if (updateToken) perf?.endRenderStage?.(updateToken);
            if (renderToken) perf?.endRenderStage?.(renderToken);
            this._startLoop();
        }
    }

    _reportFrameFailure(error, stage, now = performance.now()) {
        const stats = this._frameFailureStats;
        stats.total++;
        stats.consecutive++;
        stats.lastStage = stage;
        stats.lastMessage = error instanceof Error ? error.message : String(error);
        stats.lastAt = now;
        stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
        if (stage === 'render') this._resetContextAfterFrameFailure();
        const tripped = !stats.paused && stats.consecutive >= WORLD_FRAME_MAX_CONSECUTIVE_FAILURES;
        if (tripped) {
            stats.paused = true;
        }
        if (!tripped && now - stats.lastReportedAt < WORLD_FRAME_ERROR_REPORT_INTERVAL_MS) return;
        stats.lastReportedAt = now;
        const detail = {
            stage,
            message: stats.lastMessage,
            total: stats.total,
            consecutive: stats.consecutive,
            paused: stats.paused,
        };
        try { console.error(`[IsometricRenderer] ${stage} frame failed`, error); } catch (_) { /* no-op */ }
        try { eventBus.emit('world:frame-error', detail); } catch (_) { /* keep the frame loop alive */ }
    }

    _resetContextAfterFrameFailure() {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            if (typeof ctx.reset === 'function') {
                ctx.reset();
                return;
            }
            const canvas = this.canvas;
            if (canvas && canvas.width > 0 && canvas.height > 0) {
                canvas.width = canvas.width;
                this.ctx = canvas.getContext('2d', { alpha: false });
            }
        } catch { /* context recovery is best-effort */ }
    }

    _resumeFrameFailures() {
        this._frameFailureStats.paused = false;
        this._frameFailureStats.consecutive = 0;
    }

    resumeAfterFrameFailure() {
        if (this._disposed || !this.running) return false;
        this._resumeFrameFailures();
        this._lastFrameTime = performance.now();
        this._startLoop();
        return true;
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
            ].filter(Boolean);

            for (const alias of aliases) {
                if (!spriteByRecipient.has(alias)) {
                    spriteByRecipient.set(alias, sprite);
                }
            }
        }

        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            const agent = sprite.agent;
            if (!agent) continue;
            if (agent.status === AgentStatus.WORKING && agent.currentTool === 'SendMessage' && agent.currentToolInput) {
                senders.add(sprite);

                if (sprite.chatPartner) continue;

                const recipient = extractRecipientName(agent.currentToolInput);
                if (!recipient) continue;
                const target = spriteByRecipient.get(recipient);
                if (target && target !== sprite) {
                    sprite.startChat(target);
                }
            }
        }

        // Clear chat state for agents not using SendMessage
        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
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
            });
            // #50 — pass wall-clock time so the camera can measure idle duration
            // for the Ken-Burns drift independently of accumulated dt.
            this.camera.update(dt, performance.now());
            this.camera.updateFollow(dt);
        }

        // Chat matching only depends on session/tool state, not frame-perfect motion.
        this._chatMatchAccumulator += dt;
        let slowSystemsTick = false;
        if (this._chatMatchAccumulator >= 250) {
            this._chatMatchAccumulator = 0;
            slowSystemsTick = true;
            this._updateChatMatching();
            this.agentEventStream?.reconcileChatPairs?.(this.agentSprites);
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
        for (const sprite of this.agentSprites.values()) {
            const particleSink = this._agentVisibleOnScreen(sprite, viewport)
                ? this.particleSystem
                : null;
            sprite.update(particleSink, dt);
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
        for (const agentId of completedDepartures) this._removeAgentSprite(agentId);
        if (shouldResort) {
            this._markSpritesDirty();
        }

        // Steering separation: keep lane corrections and local nudges conservative
        // so AgentSprite remains the source of target ownership and arrival state.
        const movingSprites = this._movingSprites;
        movingSprites.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite.moving && !sprite.chatting && !this._isGateTransit(sprite, 'departure')) {
                movingSprites.push(sprite);
            }
        }
        this._applyLaneDiscipline(movingSprites, dt);
        this._applyLocalAvoidance(movingSprites, dt);
        this._crowdStatsAccumulator += dt;
        if (this._crowdStatsAccumulator >= 250 || this.agentSprites.size !== this._lastAgentCount) {
            this._crowdStatsAccumulator = 0;
            this._lastAgentCount = this.agentSprites.size;
            this._crowdStats = this._summarizeCrowdClusters();
        }
        const walkerStopped = this._settleLandings(movingSprites);
        this._stationaryOverlapAccumulator += dt;
        if (this._stationaryOverlapAccumulator >= 420) {
            this._stationaryOverlapAccumulator = 0;
            this._resolveStationaryOverlaps();
        } else if (walkerStopped) {
            // 7.4 — two bodies that land on one point the same refresh
            // settle onto the fan ring at once, not up to 420 ms later.
            this._fanStacks();
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
        if (slowSystemsTick) {
            this.harborTraffic?.reconcile?.(agents, chronicleNow);
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
        }
        this.landmarkActivity?.update?.(agents, allSpritesSnapshot, dt, chronicleNow);
        const updateNow = Date.now();
        this.villageDirector?.update?.(this, dt, updateNow);
        this.buildingRenderer?.setZoom?.(this.camera?.zoom);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(allSpritesSnapshot);
        this.buildingRenderer?.update(dt);
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
        const pending = Promise.allSettled([
            this.chronicleMonuments?.update?.(agents, context, now),
            this.trailRenderer?.update?.(agents, now, this._lastAtmosphere),
        ]);
        this._chronicleUpdatePromise = pending;
        pending.finally(() => {
            if (this._chronicleUpdatePromise === pending) this._chronicleUpdatePromise = null;
            this._chronicleUpdating = false;
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
    // the bend round standing bodies): the walk grid's nearest node
    // (buildings, water, `walkBlock` props such as the well and its cart,
    // the masonry's closed nodes), and the village's stone itself at a
    // body's half-width of reach (townPlan `inVillageMasonry`), which is
    // finer than the one-tile grid round the gate towers' drums. A step that
    // fails keeps the walker where it is; its own path step still moves it.
    _isSpritePositionWalkable(sprite, x, y) {
        if (!this.pathfinder || typeof sprite?._screenToTile !== 'function') return true;
        const tile = sprite._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY))
            && !inVillageMasonry(tile.tileX, tile.tileY);
    }

    // A place `sprite` may stand on: walkable, and covering no fixture
    // (brazier, lantern, well, cart, bench it does not sit on).
    _isSpriteStandable(sprite, x, y) {
        return this._isSpritePositionWalkable(sprite, x, y) && !standsOnFixture(x, y, sprite?._restSeat?.id || null);
    }

    _buildLaneTileIndex() {
        const lanes = new Map();
        if (!this.pathTiles?.size) return lanes;
        for (const key of this.pathTiles) {
            if (!this._isRoadLikeTileKey(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            if (this.pathfinder && !this.pathfinder.isWalkable(tile.tileX, tile.tileY)) continue;
            const bridgeAxis = laneAxisForBridgeOrientation(this.bridgeTiles?.get?.(key)?.orientation);
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
                laneOffset: plazaLike
                    ? LANE_STEERING.plazaOffsetPx
                    : material === 'avenue'
                        ? LANE_STEERING.avenueOffsetPx
                        : LANE_STEERING.dirtOffsetPx,
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

    _laneInfoForSprite(sprite) {
        if (!sprite || !this._laneTiles?.size) return null;
        const tile = worldToTile(sprite.x, sprite.y);
        if (!tile || !Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) return null;
        const roundedKey = `${Math.round(tile.tileX)},${Math.round(tile.tileY)}`;
        const direct = this._laneTiles.get(roundedKey);
        if (direct) return direct;

        let best = null;
        let bestDistance = Infinity;
        const baseX = Math.round(tile.tileX);
        const baseY = Math.round(tile.tileY);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const candidate = this._laneTiles.get(`${baseX + dx},${baseY + dy}`);
                if (!candidate) continue;
                const distance = Math.hypot(tile.tileX - candidate.tileX, tile.tileY - candidate.tileY);
                if (distance < bestDistance) {
                    best = candidate;
                    bestDistance = distance;
                }
            }
        }
        return bestDistance <= 1.15 ? best : null;
    }

    _laneSideForSprite(sprite, lane) {
        const vx = Number(sprite?.targetX) - Number(sprite?.x);
        const vy = Number(sprite?.targetY) - Number(sprite?.y);
        const along = vx * lane.tangentX + vy * lane.tangentY;
        if (Math.abs(along) > 0.05) return along >= 0 ? 1 : -1;
        return (this._stableHash(sprite?.agent?.id || sprite?.id || '') % 2) === 0 ? 1 : -1;
    }

    _applyLaneDiscipline(movingSprites, dt = 16) {
        if (!movingSprites?.length || !this._laneTiles?.size) return;
        const dense = this.agentSprites.size >= 50;
        const frameScale = Math.max(0, Math.min(2.5, dt / 16));
        const maxCorrection = (dense ? LANE_STEERING.denseCorrectionPx : LANE_STEERING.correctionPx) * frameScale;
        let corrections = 0;
        for (const sprite of movingSprites) {
            if (!sprite || sprite.chatPartner || sprite.chatting || sprite.isArrivalPending?.()) continue;
            // 7.4 — a walker abreast of another on its course keeps its line
            // while local avoidance opens the pair (see _applyLocalAvoidance).
            if (this._abreastWalkers?.has(sprite)) continue;
            const targetDistance = Math.hypot(
                Number(sprite.targetX) - Number(sprite.x),
                Number(sprite.targetY) - Number(sprite.y),
            );
            if (!Number.isFinite(targetDistance) || targetDistance <= LANE_STEERING.arrivalDistancePx) {
                delete sprite._laneDiscipline;
                continue;
            }
            const lane = this._laneInfoForSprite(sprite);
            if (!lane) {
                delete sprite._laneDiscipline;
                continue;
            }
            const side = this._laneSideForSprite(sprite, lane);
            const center = tileToWorld(lane.tileX, lane.tileY);
            const currentOffset = (sprite.x - center.x) * lane.perpX + (sprite.y - center.y) * lane.perpY;
            const desiredOffset = lane.laneOffset * side;
            const correction = desiredOffset - currentOffset;
            if (Math.abs(correction) < LANE_STEERING.minimumCorrectionPx) {
                sprite._laneDiscipline = { tileKey: lane.tileKey, side, offsetPx: desiredOffset };
                continue;
            }
            const step = Math.max(-maxCorrection, Math.min(maxCorrection, correction));
            const constrained = constrainSteeringToTarget({
                x: sprite.x,
                y: sprite.y,
                nextX: sprite.x + lane.perpX * step,
                nextY: sprite.y + lane.perpY * step,
                targetX: sprite.targetX,
                targetY: sprite.targetY,
            });
            const steered = this._strideKeptSteer(sprite, constrained);
            if (!steered) continue;
            if (!this._isSpritePositionWalkable(sprite, steered.x, steered.y)) continue;
            if (Math.hypot(steered.x - sprite.x, steered.y - sprite.y) <= 0.001) continue;
            sprite.x = steered.x;
            sprite.y = steered.y;
            sprite._laneDiscipline = { tileKey: lane.tileKey, side, offsetPx: desiredOffset };
            if (constrained.constrained) this._localAvoidanceMetrics.progressClamps++;
            corrections++;
        }
        if (corrections > 0) {
            this._localAvoidanceMetrics.laneCorrections += corrections;
            this._markSpritesDirty();
        }
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

    _applyLocalAvoidance(movingSprites, dt = 16) {
        // Trailing walker -> the slowest gait among the walkers it trails;
        // and, for giving way, its smallest gap and that nearest leader.
        const following = this._followGapNext ||= new Map();
        const followGaps = this._followGapDistances ||= new Map();
        const yieldLeaders = this._followYieldLeaders ||= new Map();
        // Walkers abreast of one on the same course: lane discipline leaves
        // them where they are next refresh, so it never squeezes the pair
        // into one lane side while the push opens it.
        const abreast = this._abreastWalkers ||= new Set();
        following.clear();
        followGaps.clear();
        yieldLeaders.clear();
        abreast.clear();
        if (!movingSprites?.length) {
            this._settleFollowGaps(following, followGaps);
            return;
        }
        const headings = this._travelHeadings ||= new Map();
        const courses = this._travelCourses ||= new Map();
        headings.clear();
        courses.clear();
        for (const sprite of movingSprites) {
            const heading = this._travelHeading(sprite);
            if (!heading) continue;
            headings.set(sprite, heading);
            courses.set(sprite, this._travelCourse(sprite, heading));
        }
        const dense = this.agentSprites.size >= 50;
        const radius = dense ? LOCAL_AVOIDANCE.denseRadiusPx : LOCAL_AVOIDANCE.radiusPx;
        const frameScale = Math.max(0, Math.min(2.5, dt / 16));
        const baseStrength = (dense ? LOCAL_AVOIDANCE.denseStrengthPx : LOCAL_AVOIDANCE.strengthPx) * frameScale;
        let pushes = 0;
        let zeroDistancePairs = 0;
        this._forEachNearbySpritePair(movingSprites, LOCAL_AVOIDANCE.bucketPx, (a, b) => {
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            let dist = Math.hypot(dx, dy);
            // 7.4 — a loose file: of two walkers on one course, the trailing
            // one walks a V7 rung below its leader (AgentSprite._speedForState)
            // until the gap opens to releasePx. Of two walkers merging or
            // crossing at under 90° (mergeDot) closer than yieldPx, the one
            // behind gives way the same way. A pair reads whichever of its
            // current headings and look-ahead courses agree more.
            const headingA = headings.get(a);
            const headingB = headings.get(b);
            let courseA = courses.get(a);
            let courseB = courses.get(b);
            let courseDot = -1;
            if (headingA && headingB) {
                const headingDot = headingA.x * headingB.x + headingA.y * headingB.y;
                courseDot = courseA.x * courseB.x + courseA.y * courseB.y;
                if (headingDot > courseDot) {
                    courseDot = headingDot;
                    courseA = headingA;
                    courseB = headingB;
                }
            }
            const sameCourse = courseDot > FOLLOW_GAP.headingDot;
            if (courseDot > FOLLOW_GAP.mergeDot && dist < FOLLOW_GAP.releasePx) {
                const lead = dx * (courseA.x + courseB.x) + dy * (courseA.y + courseB.y);
                const leadsA = lead > 0 || (lead === 0 && this._spriteStableId(a) < this._spriteStableId(b));
                const trailing = leadsA ? b : a;
                const leader = leadsA ? a : b;
                const files = sameCourse && (dist < FOLLOW_GAP.engagePx || trailing._followGap);
                // Only a walker ahead (inside the trailing one's 60° cone, not
                // abreast) is given way to, until the gap is back to
                // releasePx; the trigger leads the closing speed by
                // closingFrames, so the gap never dips under yieldPx. A leader
                // planted for its own reasons (a start beat, a pivot, a look
                // at a landmark) is walked around instead; one that is giving
                // way itself holds its file.
                // The leader is ahead along the trailing walker's heading or
                // its look-ahead course, whichever points at it more.
                const toLeaderX = leadsA ? dx : -dx;
                const toLeaderY = leadsA ? dy : -dy;
                const trailingHeading = headings.get(trailing);
                const trailingCourse = courses.get(trailing);
                const ahead = Math.max(
                    toLeaderX * trailingHeading.x + toLeaderY * trailingHeading.y,
                    toLeaderX * trailingCourse.x + toLeaderY * trailingCourse.y,
                );
                const leaderPlanted = this._isPlanted(leader);
                const leaderWalks = !leaderPlanted || leader._followYield;
                const leaderAlong = leaderPlanted ? 0 : (leader._gaitSpeed || 0) * courseDot;
                const closing = Math.max(0, (trailing._gaitSpeed || 0) - leaderAlong);
                const trigger = trailing._followYield
                    ? FOLLOW_GAP.releasePx
                    : FOLLOW_GAP.yieldPx + closing * FOLLOW_GAP.closingFrames;
                // A walker never plants to give way on a fixture: it walks on
                // (one rung down, in file) until it is off it.
                const givesWay = leaderWalks && ahead >= FOLLOW_GAP.aheadDot * dist && dist < trigger
                    && !standsOnFixture(trailing.x, trailing.y);
                if (sameCourse && dist < FOLLOW_GAP.engagePx && ahead < FOLLOW_GAP.aheadDot * dist) {
                    abreast.add(a);
                    abreast.add(b);
                }
                // A walker catching up with its own chat partner is meant to reach it.
                if ((files || givesWay) && trailing.chatPartner !== leader) {
                    const leaderGait = leader._gaitSpeed > 0 ? leader._gaitSpeed : Infinity;
                    following.set(trailing, Math.min(following.get(trailing) ?? Infinity, leaderGait));
                    if (givesWay && !(followGaps.get(trailing) <= dist)) {
                        followGaps.set(trailing, dist);
                        yieldLeaders.set(trailing, leader);
                    }
                }
            }
            if (dist >= radius) return true;

            let nx;
            let ny;
            if (dist <= 0.001) {
                const angle = (this._stableHash(`${a.agent?.id || a.x}|${b.agent?.id || b.x}`) % 628) / 100;
                nx = Math.cos(angle);
                ny = Math.sin(angle);
                dist = 0;
                zeroDistancePairs++;
            } else {
                nx = dx / dist;
                ny = dy / dist;
            }

            const overlap = dist > 0 ? (radius - dist) / radius : 1;
            const sameLane = a._laneDiscipline?.tileKey && a._laneDiscipline.tileKey === b._laneDiscipline?.tileKey;
            const opposingLanes = sameLane && a._laneDiscipline.side !== b._laneDiscipline.side;
            const strength = baseStrength * (opposingLanes ? 0.55 : 1);
            // Steering never pushes a walker back along its own course. Of a
            // file (one course) only the push's lateral and forward parts
            // reach the proposal; the gap belongs to the follow rung. Walkers
            // on crossing or opposed courses sidestep by the backward part.
            const sidestep = !sameCourse;
            const pushA = this._forwardOnlyPush(nx * overlap * strength, ny * overlap * strength, headingA, sidestep);
            const pushB = this._forwardOnlyPush(-nx * overlap * strength, -ny * overlap * strength, headingB, sidestep);
            const nextA = constrainSteeringToTarget({
                x: a.x,
                y: a.y,
                nextX: a.x + pushA.x,
                nextY: a.y + pushA.y,
                targetX: a.targetX,
                targetY: a.targetY,
            });
            const nextB = constrainSteeringToTarget({
                x: b.x,
                y: b.y,
                nextX: b.x + pushB.x,
                nextY: b.y + pushB.y,
                targetX: b.targetX,
                targetY: b.targetY,
            });

            let moved = false;
            const keptA = this._strideKeptSteer(a, nextA);
            if (
                keptA
                && Math.hypot(keptA.x - a.x, keptA.y - a.y) > 0.001
                && this._isSpritePositionWalkable(a, keptA.x, keptA.y)
            ) {
                a.x = keptA.x;
                a.y = keptA.y;
                if (nextA.constrained) this._localAvoidanceMetrics.progressClamps++;
                moved = true;
            }
            const keptB = this._strideKeptSteer(b, nextB);
            if (
                keptB
                && Math.hypot(keptB.x - b.x, keptB.y - b.y) > 0.001
                && this._isSpritePositionWalkable(b, keptB.x, keptB.y)
            ) {
                b.x = keptB.x;
                b.y = keptB.y;
                if (nextB.constrained) this._localAvoidanceMetrics.progressClamps++;
                moved = true;
            }
            if (moved) {
                pushes++;
                this._emitCrowdBumpFeedback(a, b, overlap);
            }
            return true;
        });
        pushes += this._steerAroundStanding(movingSprites, headings, baseStrength * STANDING_CLEARANCE.strength);
        if (pushes > 0) {
            this._localAvoidanceMetrics.separationPushes += pushes;
            this._markSpritesDirty();
        }
        if (zeroDistancePairs > 0) {
            this._localAvoidanceMetrics.zeroDistancePairs += zeroDistancePairs;
        }
        this._settleFollowGaps(following, followGaps);
        this._fanArrivals(movingSprites);
    }

    // 7.4 — walkers bend around villagers standing in their way. Returns the
    // number of walkers steered.
    _steerAroundStanding(movingSprites, headings, strength) {
        const standing = this._standingObstacles ||= [];
        standing.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite && this._isPlanted(sprite) && !this._isGateTransit(sprite, 'departure')) standing.push(sprite);
        }
        if (!standing.length) return 0;
        const { xPx, yPx, lastLegPx } = STANDING_CLEARANCE;
        let steered = 0;
        for (const walker of movingSprites) {
            if (!walker || this._isPlanted(walker)) continue;
            const stop = this._fanStopOf(walker);
            if (stop.reach <= lastLegPx) continue;
            let px = 0;
            let py = 0;
            for (const body of standing) {
                const ex = (walker.x - body.x) / xPx;
                const ey = (walker.y - body.y) / yPx;
                const e = Math.hypot(ex, ey);
                if (e >= 1) continue;
                // A walker coming to stand beside this body (its fan place,
                // box-clear by construction) walks straight in while it is
                // no nearer the body than that place. A chat approach stops
                // wherever it reaches its partner, so it always steers, unless
                // it was re-aimed onto a fan place (it then walks on to it).
                const standsBeside = !walker.chatPartner || walker._routeEndFanPlace?.();
                if (standsBeside && e >= Math.hypot((stop.x - body.x) / xPx, (stop.y - body.y) / yPx)) continue;
                // Out along the ellipse normal; a walker standing exactly on
                // the body takes the stable hash angle.
                let gx = ex / xPx;
                let gy = ey / yPx;
                let g = Math.hypot(gx, gy);
                if (!(g > 1e-9)) {
                    const angle = (this._stableHash(`${this._spriteStableId(walker)}|${this._spriteStableId(body)}`) % 628) / 100;
                    gx = Math.cos(angle);
                    gy = Math.sin(angle);
                    g = 1;
                }
                const weight = (1 - e) * strength / g;
                px += gx * weight;
                py += gy * weight;
            }
            if (!px && !py) continue;
            const push = this._forwardOnlyPush(px, py, headings.get(walker), true);
            const next = constrainSteeringToTarget({
                x: walker.x,
                y: walker.y,
                nextX: walker.x + push.x,
                nextY: walker.y + push.y,
                targetX: walker.targetX,
                targetY: walker.targetY,
            });
            const kept = this._strideKeptSteer(walker, next);
            if (
                !kept
                || Math.hypot(kept.x - walker.x, kept.y - walker.y) <= 0.001
                || !this._isSpritePositionWalkable(walker, kept.x, kept.y)
            ) continue;
            walker.x = kept.x;
            walker.y = kept.y;
            if (next.constrained) this._localAvoidanceMetrics.progressClamps++;
            steered++;
        }
        return steered;
    }

    // 7.4 — a walker's course: toward its current waypoint, else its last step.
    _travelHeading(sprite) {
        let hx = Number(sprite.targetX) - sprite.x;
        let hy = Number(sprite.targetY) - sprite.y;
        let length = Math.hypot(hx, hy);
        if (!(length > 0.5)) {
            hx = sprite.x - Number(sprite._stepStartX);
            hy = sprite.y - Number(sprite._stepStartY);
            length = Math.hypot(hx, hy);
        }
        return length > 1e-6 ? { x: hx / length, y: hy / length } : null;
    }

    // 7.4 — the course the file rule reads: within lookAheadPx of a corner it
    // is already the next leg, so two walkers about to share a leg (one
    // coming back from a hairpin, one merging) sort out who gives way before
    // they meet on it.
    _travelCourse(sprite, heading) {
        const next = sprite.waypoints?.length > 1 ? sprite.waypoints[1] : null;
        if (!next || Math.hypot(Number(sprite.targetX) - sprite.x, Number(sprite.targetY) - sprite.y) > FOLLOW_GAP.lookAheadPx) {
            return heading;
        }
        const hx = Number(next.x) - sprite.x;
        const hy = Number(next.y) - sprite.y;
        const length = Math.hypot(hx, hy);
        return length > 1e-6 ? { x: hx / length, y: hy / length } : heading;
    }

    // A steering push without its part back along the walker's course. With
    // `sidestep`, that part turns into a sidestep instead: along the push's
    // own lateral side, or (dead ahead) to the walker's right, so two walkers
    // meeting head-on pass each other on opposite sides.
    _forwardOnlyPush(px, py, heading, sidestep = false) {
        if (!heading) return { x: px, y: py };
        const along = px * heading.x + py * heading.y;
        if (along >= 0) return { x: px, y: py };
        const lx = px - along * heading.x;
        const ly = py - along * heading.y;
        if (!sidestep) return { x: lx, y: ly };
        const lateral = Math.hypot(lx, ly);
        const sx = lateral > 1e-6 ? lx / lateral : -heading.y;
        const sy = lateral > 1e-6 ? ly / lateral : heading.x;
        return { x: lx - along * sx, y: ly - along * sy };
    }

    // The follow marks live on the sprite only while it trails someone:
    // `_followGap` is the leader's gait (px per 16.67 ms), or true when the
    // leader has not stepped; `_followYield` is set while the gap is under
    // yieldPx.
    _settleFollowGaps(following, followGaps) {
        const holders = this._followGapHolders ||= new Set();
        for (const sprite of holders) {
            if (!following.has(sprite)) {
                sprite._followGap = false;
                sprite._followYield = false;
            }
        }
        holders.clear();
        for (const [sprite, leaderGait] of following) {
            sprite._followGap = Number.isFinite(leaderGait) ? leaderGait : true;
            sprite._followYield = followGaps.has(sprite);
            holders.add(sprite);
        }
        // A wait is a 'file' when its chain of leaders ends at a walker that
        // steps (it ends by itself, however long the queue), else a 'knot'
        // (a planted head, or a ring of walkers waiting on each other),
        // which AgentSprite times out.
        const leaders = this._followYieldLeaders;
        for (const sprite of holders) {
            if (!sprite._followYield) continue;
            let leader = leaders?.get(sprite);
            let steps = 0;
            while (leader?._followYield && holders.has(leader) && steps++ < FOLLOW_GAP.chainSteps) {
                leader = leaders.get(leader);
            }
            const walks = leader && !leader._followYield && !this._isPlanted(leader);
            sprite._followYield = walks ? 'file' : 'knot';
        }
    }

    // 7.4 — the fan ring's places around an anchor, in visit-slot order: the
    // first villager keeps the anchor, the next ones stand beside it (east and
    // west first, the stable hash picking the side), then in front, behind and
    // on the corners. Whole texels, so a standing body stays on the grid.
    _fanRingPlace(anchor, index, hashKey) {
        if (index <= 0) return { x: Math.round(anchor.x), y: Math.round(anchor.y) };
        const side = this._stableHash(hashKey) % 2 ? 1 : -1;
        const [ux, uy] = FAN_RING_PLACES[(index - 1) % FAN_RING_PLACES.length];
        return {
            x: Math.round(anchor.x + ux * side * PERFORMING_FAN.radiusXPx),
            y: Math.round(anchor.y + uy * PERFORMING_FAN.radiusYPx),
        };
    }

    // The anchor of the fan `occupant` stands in: its recorded anchor while it
    // still stands on that anchor's ring, else its own foot. A body keeps
    // `_fanAnchor` after it walks on, and fanning round a stale anchor aimed
    // a walker's last leg straight across the island (over water and baked
    // fixtures such as the well) to a ring by some old stop.
    _fanAnchorOf(occupant) {
        const anchor = occupant._fanAnchor;
        if (anchor && Math.abs(occupant.x - anchor.x) <= PERFORMING_FAN.radiusXPx + 1
            && Math.abs(occupant.y - anchor.y) <= PERFORMING_FAN.radiusYPx + 1) return anchor;
        return occupant;
    }

    // The first walkable ring place around `anchor` for `sprite` whose body
    // box is clear of every other standing body and claimed place; failing
    // that, the first one at least stackPx from all of them.
    _freeFanPlace(sprite, anchor, startIndex, taken, hashKey) {
        const boxClear = (place) => !taken.some(other => other !== sprite
            && Math.abs(other.x - place.x) < PERFORMING_FAN.overlapXPx
            && Math.abs(other.y - place.y) < PERFORMING_FAN.overlapYPx);
        const stackClear = (place) => !taken.some(other => other !== sprite
            && Math.hypot(other.x - place.x, other.y - place.y) < PERFORMING_FAN.stackPx);
        for (const clear of [boxClear, stackClear]) {
            for (let index = startIndex; index <= FAN_RING_PLACES.length; index++) {
                const place = this._fanRingPlace(anchor, index, hashKey);
                if (clear(place) && this._isSpriteStandable(sprite, place.x, place.y)) return place;
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
        for (const sprite of movingSprites) {
            if (this._isGateTransit(sprite, 'departure')) continue;
            // A seat (7.1) or petitioner place (7.2) is an exact point: never re-aimed.
            if (FAN_EXEMPT_ROLES.has(sprite.visitRole)) continue;
            const stop = this._fanStopOf(sprite);
            if (stop.reach <= PERFORMING_FAN.approachPx) arrivals.push(sprite);
        }
        if (!arrivals.length) return;
        // The nearer stop lands first and keeps its place.
        arrivals.sort((a, b) => this._fanStopOf(a).reach - this._fanStopOf(b).reach);
        const landing = this._fanLanding ||= [];
        landing.length = 0;
        for (const sprite of arrivals) {
            const stop = this._fanStopOf(sprite);
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
            // A stop on a fixture fans around that stop like one on a body.
            if (!occupant && !standsOnFixture(stop.x, stop.y, sprite._restSeat?.id || null)) {
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
    _fanStopOf(sprite) {
        const tx = Number(sprite.targetX);
        const ty = Number(sprite.targetY);
        let reach = Math.hypot(tx - sprite.x, ty - sprite.y);
        const route = sprite.waypoints;
        if (!(route?.length > 1)) return { x: tx, y: ty, reach };
        for (let index = 1; index < route.length; index++) {
            if (reach > PERFORMING_FAN.approachPx) return { x: NaN, y: NaN, reach };
            reach += Math.hypot(route[index].x - route[index - 1].x, route[index].y - route[index - 1].y);
        }
        const final = route[route.length - 1];
        return { x: Number(final.x), y: Number(final.y), reach };
    }

    _forEachNearbySpritePair(sprites, cellSize, visitor) {
        const size = Math.max(1, Number(cellSize) || LOCAL_AVOIDANCE.bucketPx);
        const buckets = this._pairBuckets;
        const ids = this._pairIds;
        const visited = this._pairVisited;
        buckets.clear();
        ids.clear();
        visited.clear();
        for (let index = 0; index < sprites.length; index++) {
            const sprite = sprites[index];
            if (!sprite) continue;
            ids.set(sprite, this._spriteStableId(sprite, index));
            const key = `${Math.floor(sprite.x / size)},${Math.floor(sprite.y / size)}`;
            const bucket = buckets.get(key) || [];
            bucket.push(sprite);
            buckets.set(key, bucket);
        }

        for (const [key, bucket] of buckets.entries()) {
            const [cellX, cellY] = key.split(',').map(Number);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    const other = buckets.get(`${cellX + ox},${cellY + oy}`);
                    if (!other) continue;
                    for (const a of bucket) {
                        for (const b of other) {
                            if (a === b) continue;
                            const idA = ids.get(a);
                            const idB = ids.get(b);
                            if (!idA || !idB || idA === idB) continue;
                            const pairKey = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
                            if (visited.has(pairKey)) continue;
                            visited.add(pairKey);
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
                tileX: tile.tileX,
                tileY: tile.tileY,
                moving: !!sprite.moving,
                status: sprite.agent?.status || 'unknown',
                provider: sprite.agent?.provider || 'unknown',
                teamName: sprite.agent?.teamName || null,
            });
        }

        const summary = summarizeCrowdClusterEntries(entries, {
            cellSize: CROWD_CLUSTER_TILE_SIZE,
            topLimit: CROWD_CLUSTER_TOP_LIMIT,
            includeDominantProvider: true,
            includeStatusCounts: true,
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
        this._fanStacks();
    }

    // 7.4 — a body on its feet at one point: standing, or a walker that has
    // not stepped (a start beat, a pivot, giving way) or stopped to look at a
    // landmark.
    _isPlanted(sprite) {
        return !sprite.moving || !Number.isFinite(sprite._stepStartX) || sprite._stopLookActiveMs > 0;
    }

    // 7.4 — a villager that stopped this refresh (arrived, or began a chat
    // wherever its approach reached its partner) inside a standing body's
    // box steps onto the nearest box-clear place of that body's fan ring, on
    // the refresh it lands, when that place is within settleHopPx. Seated,
    // queued and selected bodies never move. Returns true when anyone
    // stopped.
    _settleLandings(movingSprites) {
        const previous = this._walkersLastRefresh ||= new Set();
        const landed = this._landedSprites ||= [];
        landed.length = 0;
        for (const sprite of previous) {
            if (!sprite.moving || sprite.chatting) landed.push(sprite);
        }
        previous.clear();
        for (const sprite of movingSprites) previous.add(sprite);
        if (!landed.length) return false;
        const standing = this._fanStanding ||= [];
        standing.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite && this._isPlanted(sprite)) standing.push(sprite);
        }
        const boxHit = (other, x, y) => Math.abs(other.x - x) < PERFORMING_FAN.overlapXPx
            && Math.abs(other.y - y) < PERFORMING_FAN.overlapYPx;
        for (const sprite of landed) {
            if (sprite.moving || sprite.selected || FAN_EXEMPT_ROLES.has(sprite.visitRole)) continue;
            if (!this.agentSprites.has(sprite.agent?.id) || this._isGateTransit(sprite, 'departure')) continue;
            const occupant = standing.find(other => other !== sprite && boxHit(other, sprite.x, sprite.y));
            // A body that stopped on a fixture steps off it the same way.
            if (!occupant && !standsOnFixture(sprite.x, sprite.y, sprite._restSeat?.id || null)) continue;
            const anchor = occupant ? this._fanAnchorOf(occupant) : { x: sprite.x, y: sprite.y };
            const hashKey = `${occupant?._lastBuildingType || sprite._lastBuildingType}|${anchor.x | 0},${anchor.y | 0}`;
            let best = null;
            let bestHop = PERFORMING_FAN.settleHopPx;
            for (let index = 1; index <= FAN_RING_PLACES.length; index++) {
                const place = this._fanRingPlace(anchor, index, hashKey);
                const hop = Math.hypot(place.x - sprite.x, place.y - sprite.y);
                if (hop > bestHop) continue;
                if (standing.some(other => other !== sprite && boxHit(other, place.x, place.y))) continue;
                if (!this._isSpriteStandable(sprite, place.x, place.y)) continue;
                best = place;
                bestHop = hop;
            }
            if (!best) continue;
            sprite.x = best.x;
            sprite.y = best.y;
            sprite.targetX = best.x;
            sprite.targetY = best.y;
            sprite._fanAnchor = { x: anchor.x, y: anchor.y };
            this._localAvoidanceMetrics.settledLandings = (this._localAvoidanceMetrics.settledLandings || 0) + 1;
            this._markSpritesDirty();
        }
        return true;
    }

    // 7.4 — villagers performing at one building, or talking there, that
    // stand stacked (closer than stackPx, two bodies reading as one) settle
    // onto the fan ring in visit-slot order: the first keeps the anchor, the
    // rest take ring places (talkers then turn to their partner on their own,
    // `_faceChatPartner`). A later arrival walks into the ring on its own
    // (_fanArrivals), so this meets only bodies that stopped together.
    _fanStacks() {
        const standing = [];
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || sprite.moving || !sprite._lastBuildingType) continue;
            if (sprite.chatPartner && !sprite.chatting) continue;
            if (this._isGateTransit(sprite, 'departure') || sprite.isArrivalPending?.()) continue;
            standing.push(sprite);
        }
        let fanned = 0;
        const visited = new Set();
        for (const seed of standing) {
            if (visited.has(seed)) continue;
            visited.add(seed);
            const stack = [seed];
            for (let index = 0; index < stack.length; index++) {
                for (const other of standing) {
                    if (visited.has(other) || other._lastBuildingType !== seed._lastBuildingType) continue;
                    if (Math.hypot(other.x - stack[index].x, other.y - stack[index].y) >= PERFORMING_FAN.stackPx) continue;
                    visited.add(other);
                    stack.push(other);
                }
            }
            if (stack.length < 2) continue;
            const performing = stack.filter(sprite => sprite.chatting || ['performing', 'cooldown']
                .includes(sprite.getBehaviorDebugSnapshot?.()?.behaviorState));
            if (performing.length < 2) continue;
            performing.sort((a, b) => (a._lastVisitMeta?.slotIndex ?? Infinity) - (b._lastVisitMeta?.slotIndex ?? Infinity)
                || this._spriteStableId(a).localeCompare(this._spriteStableId(b)));
            const anchor = { x: performing[0].x, y: performing[0].y };
            const taken = standing.filter(sprite => !performing.includes(sprite) || sprite === performing[0]);
            const hashKey = `${seed._lastBuildingType}|${anchor.x | 0},${anchor.y | 0}`;
            for (let index = 1; index < performing.length; index++) {
                const sprite = performing[index];
                if (sprite.selected || FAN_EXEMPT_ROLES.has(sprite.visitRole)) continue;
                const place = this._freeFanPlace(sprite, anchor, 1, taken, hashKey);
                if (!place) continue;
                sprite.x = place.x;
                sprite.y = place.y;
                sprite.targetX = place.x;
                sprite.targetY = place.y;
                sprite._fanAnchor = anchor;
                taken.push(place);
                fanned++;
            }
        }
        if (fanned) {
            this._localAvoidanceMetrics.fannedStacks = (this._localAvoidanceMetrics.fannedStacks || 0) + fanned;
            this._markSpritesDirty();
        }
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
        const key = [a.agent?.id || a.x, b.agent?.id || b.x].sort().join('|');
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
            now: performance.now(),
            timeMs: this.motionTimeMs,
            buildings: this.world?.buildings,
            assets: this.assets,
            presence: this.buildingRenderer?.getWorkingPresence?.() || null,
            particleSystem: this.particleSystem,
            atmosphere: this._lastAtmosphere,
            heatFor: type => (type === 'forge' ? this.buildingRenderer?._forgeGlowIntensity?.() ?? 0 : 0),
            sortYFor: (building, localY) => this.buildingRenderer?.particleSortY?.(building, localY) ?? null,
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

    _render(dt = 16) {
        // #2 — reset the mark governor once per frame before any draw pass runs.
        // Region size scales with zoom so a "screen region" stays roughly fixed
        // in screen pixels regardless of the integer zoom level.
        this.markGovernor.beginFrame({
            regionSize: 200 / (this.camera?.zoom || 1),
            motionScale: this.motionScale,
        });
        this._syncSemanticSummary();
        renderWorldFrame(this, dt);
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

    _assignAgentOverlaySlots(sprites, zoom = this.camera?.zoom || 1, { agentRenderMode = 'full' } = {}) {
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
        const reserve = (rect) => {
            if (useSpatialGrid) {
                this._insertRectGridItem(nameGrid, rect);
                this._insertRectGridItem(bubbleGrid, rect);
            } else {
                nameRects.push(rect);
                reservedRects.push(rect);
            }
        };
        const collides = rect => (useSpatialGrid
            ? this._rectGridHasOverlap(nameGrid, rect)
            : this._rectListHasOverlap(nameRects, rect));

        // T1 — attention plates are laid out first, from live status, and
        // every other label yields to them. Their rects are PRIMARY in the
        // mark governor, so ambient marks in the region dim around them.
        this._attentionLayout = layoutAttentionPlates(this.overlayCtx, {
            // Every agent, not the visible snapshot: off-view action-needed
            // agents get an edge plate instead of vanishing (T1 truth).
            sprites: this.agentSprites.values(),
            camera: this.camera,
            viewport,
            // V8 — chrome over the world (the World dock) is occluded screen.
            reserved: getReservedRects(),
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
        // S4/S5 — building ledgers and assay furniture give way to T1.
        if (this.buildingRenderer) this.buildingRenderer.attentionWorldRects = attentionWorldRects;

        const focusId = this.selectedAgent?.id || this.cameraDirector?.attentionFrame?.focusedAgentId;
        const readMode = this.getReadMode();
        const routineZoom = zoom >= ROUTINE_NAME_MIN_ZOOM;
        const perRegion = zoom >= ROUTINE_NAME_DETAIL_ZOOM ? ROUTINE_NAMES_PER_REGION_DETAIL : ROUTINE_NAMES_PER_REGION;
        const regionCounts = this._overlayRegionCounts;
        regionCounts.clear();
        for (const sprite of prioritized) {
            const attention = isAttentionStatus(sprite.agent.status);
            const focused = sprite.selected || sprite.agent.id === focusId;
            const primary = focused || attention;
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
                reserve(this._agentIdentityRect(sprite, 0));
                continue;
            }
            // T1 owns the identity of every action-needed agent.
            if (attention) continue;
            if (sprite.decisionFocusRoutine) {
                sprite.labelAlpha = 0;
                continue;
            }
            // W-F16 — a body the depth pass hid behind a building carries no
            // routine name or action marks on the building's face.
            if (sprite._behindBuilding) {
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
            if (!readMode) {
                if (!routineZoom) continue;
                const point = this.camera.worldToScreen(sprite.x, sprite.y);
                regionKey = `${Math.floor(point.x / ROUTINE_NAME_REGION_PX)},${Math.floor(point.y / ROUTINE_NAME_REGION_PX)}`;
                if ((regionCounts.get(regionKey) || 0) >= perRegion) continue;
            }
            const slotCap = readMode ? READ_MODE_NAME_SLOTS : 1;
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
            if (slot >= slotCap) continue;
            sprite.overlaySlot = slot;
            reserve(rect);
            if (regionKey) regionCounts.set(regionKey, (regionCounts.get(regionKey) || 0) + 1);
        }

        const bubbleSprites = this._overlayBubbleSprites;
        bubbleSprites.length = 0;
        for (const sprite of prioritized) {
            if (sprite.decisionFocusMuted || (sprite._behindBuilding && !sprite.selected)) continue;
            if (agentRenderMode === 'full' || sprite.gpuActionOverlay || sprite.selected) bubbleSprites.push(sprite);
        }
        this._assignAgentBubbleSlots(
            bubbleSprites,
            zoom,
            useSpatialGrid ? null : reservedRects,
            useSpatialGrid ? bubbleGrid : false,
        );
    }

    _screenRectToWorld(rect) {
        const camera = this.camera;
        if (!camera?.screenToWorld || !rect) return null;
        const topLeft = camera.screenToWorld(rect.left, rect.top);
        const bottomRight = camera.screenToWorld(rect.right, rect.bottom);
        return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
    }

    // Crowd bubble de-collision. Reuses the overlay-slot rect-overlap technique:
    // register each intended bubble rect and, when it overlaps an already-placed
    // one, stack it into the next free slot above; past the cap, suppress it to
    // an ellipsis dot so at most AGENT_BUBBLE_SLOT_CAP full bubbles render per
    // cluster. Deterministic priority (selected, then label priority, then stable
    // id) keeps slots from flickering frame to frame. Pure layout, no motion.
    _assignAgentBubbleSlots(
        sprites,
        zoom = this.camera?.zoom || 1,
        reservedLabels = [],
        occupiedGrid = null,
    ) {
        // Names and thoughts share one reservation plane even though their
        // anchors are deliberately below and above the character respectively.
        // This prevents one villager's thought from covering another's name.
        const useSpatialGrid = occupiedGrid !== false;
        const grid = useSpatialGrid ? (occupiedGrid || this._overlayBubbleGrid) : null;
        const occupied = this._overlayBubbleOccupiedRects;
        occupied.length = 0;
        if (useSpatialGrid && !occupiedGrid) {
            this._beginRectGridFrame(grid);
            for (const rect of reservedLabels) this._insertRectGridItem(grid, rect);
        } else if (!useSpatialGrid) {
            for (const rect of reservedLabels) occupied.push(rect);
        }
        const order = this._overlayBubbleOrder;
        order.length = 0;
        for (const sprite of sprites || []) {
            if (sprite.agent && this._spriteWantsBubble(sprite)) order.push(sprite);
        }
        order.sort((a, b) => {
            const delta = this._agentLabelPriority(b) - this._agentLabelPriority(a);
            if (delta !== 0) return delta;
            return String(a.agent.id) < String(b.agent.id) ? -1 : 1;
        });
        // 3.8 — each sprite's slot-0 rect, kept for the identical-bubble merge
        // pass below (same allocation envelope the slot loop already has).
        const baseRects = this._overlayBubbleBaseRects;
        baseRects.length = 0;
        for (const sprite of order) {
            sprite.bubbleSlot = 0;
            sprite.bubbleSuppressed = false;
            // 3.8 — merge flags reset per frame; groups are rebuilt after slots.
            sprite.bubbleMergedCount = 1;
            sprite.bubbleMergedInto = null;
            const baseRect = this._agentBubbleSlotRect(sprite, 0);
            baseRects.push(baseRect);
            let slot = 0;
            let rect = baseRect;
            const slotCap = sprite.selected ? 8 : AGENT_BUBBLE_SLOT_CAP;
            while (
                slot < slotCap &&
                (useSpatialGrid
                    ? this._rectGridHasOverlap(grid, rect)
                    : this._rectListHasOverlap(occupied, rect))
            ) {
                slot++;
                rect = this._agentBubbleSlotRect(sprite, slot);
            }
            if (slot >= slotCap && !sprite.selected) {
                sprite.bubbleSuppressed = true;
            } else {
                sprite.bubbleSlot = slot;
                if (useSpatialGrid) this._insertRectGridItem(grid, rect);
                else occupied.push(rect);
            }
        }
        this._mergeIdenticalClusterBubbles(order, baseRects, useSpatialGrid);
    }

    // 3.8 — identical-bubble merge. Within one bubble-slot cluster (sprites
    // whose slot-0 bubble rects transitively overlap), agents showing the
    // identical head line collapse into the deterministic-first sprite's
    // bubble, which draws a ×N chip (AgentSprite._drawBubble); the others skip
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
        if (!sprite || sprite.selected || sprite.hovered) return false;
        const status = sprite.agent?.status;
        if ([AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status)) {
            return false;
        }
        const spawnAge = performance.now() - (sprite.addedAt || 0);
        // A burst must not grant twelve seconds of overlapping names to the whole crowd.
        if (this.agentSprites.size < 24 && spawnAge >= 0 && spawnAge < 12000) return false;
        return true;
    }

    // Merge identity = the head line the bubble will actually draw (same text,
    // same resolved accent, same confidence, so the low-confidence '?' variant
    // never merges with the confident one). Sprites without a drawable head —
    // or showing the long-wait clock bubble, which has no ×N chip path —
    // never merge.
    _bubbleMergeKey(sprite) {
        // Layout already reads the sprite's current activity snapshot. Reusing
        // it avoids rebuilding/pruning the complete activity thread solely to
        // derive a merge key.
        const archiveProgress = sprite._archiveFadeProgress?.();
        const head = archiveProgress > 0 && archiveProgress < 1
            ? { text: 'FINAL', accent: sprite._statusVisual?.()?.color || '#f2d36b' }
            : sprite._activitySnapshot;
        if (!head || !head.text) return null;
        if (sprite._shouldUseLongWaitClock?.()) return null;
        const accent = head.accent || sprite._statusVisual?.()?.color || '';
        return `${head.text}|${accent}|${head.confidence ?? ''}`;
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
        if (!sprite._activitySnapshot?.text && !sprite._shouldUseLongWaitClock?.()) return false;
        return true;
    }

    _agentBubbleSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const halfW = (this._agentBubbleWidth(sprite) / 2) * s;
        const halfH = (AGENT_BUBBLE_HEIGHT / 2) * s;
        const headY = typeof sprite._headTopY === 'function'
            ? (typeof sprite._labelTopY === 'function' ? sprite._labelTopY(sprite._headTopY()) : sprite._headTopY())
            : sprite.y;
        const centerY = headY - (AGENT_BUBBLE_HEAD_OFFSET + slot * AGENT_BUBBLE_STACK_STEP) * s;
        return {
            x: sprite.x - halfW,
            y: centerY - halfH,
            w: halfW * 2,
            h: halfH * 2,
        };
    }

    // Reservation width for de-collision. Dialogue lines are real model text of
    // varying length, so a single fixed estimate would under-reserve for long
    // lines and let bubbles overlap. Estimating from character count at the
    // anchored 11px body font keeps this allocation-free and off the
    // measureText path, while STATUS_BUBBLE_MAIN_MAX_WIDTH caps it exactly as
    // the sprite's own pixel truncation does.
    _agentBubbleWidth(sprite) {
        const text = sprite?._activitySnapshot?.text;
        if (!text) return AGENT_BUBBLE_EST_WIDTH;
        const estimate = text.length * AGENT_BUBBLE_CHAR_WIDTH + AGENT_BUBBLE_PADDING;
        return Math.min(AGENT_BUBBLE_MAX_WIDTH, Math.max(AGENT_BUBBLE_EST_WIDTH, estimate));
    }

    // Routine-name admission order: a recent tool change or a fresh arrival
    // earns the slot first, then ordinary work, then everyone else.
    _agentLabelPriority(sprite, now = performance.now()) {
        if (sprite.selected) return 1000;
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
            if (!sprite.agent || sprite.overlaySlot == null) continue;
            out.push(this._agentIdentityRect(sprite, sprite.overlaySlot || 0));
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
            // 51-px oak, the crown of a tall woodland tree, plan 5.5).
            out.push({ x: p.x, y: p.y - Math.round(-(tree.bounds?.top ?? -50) * 0.6) * zoom });
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
    _getTerrainCache({ allowResident = false } = {}) {
        const bounds = this._terrainCacheBounds();
        const meta = this._getTerrainCacheMeta(bounds);
        if (!meta.singleSurfaceWithinBudget) {
            releaseCanvasBackingStore(this.terrainCache);
            this.terrainCache = null;
            this.terrainCacheKey = '';
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
        this.foliageRenderer.setSeason(season);
        const key = this._terrainBakeKey(bounds, dpr, season);
        if (this.terrainCache && this.terrainCacheKey === key) {
            return { canvas: this.terrainCache, bounds };
        }
        if (allowResident && this._terrainResident?.key === key) {
            return { canvas: this._terrainResident, bounds, resident: true };
        }
        this._terrainResident = null;

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
        return { canvas, bounds };
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
        releaseCanvasBackingStore(canvas);
        this.terrainCache = null;
    }

    // B.2 — the resident stand-in no longer has a texture behind it (context
    // loss, eviction): the next terrain request re-bakes the canvas.
    dropTerrainResident() {
        this._terrainResident = null;
    }

    // 0.3 — the bake is keyed only on what changes its pixels: the cache
    // bounds, asset availability, the season, the scenery revision and each
    // registered bake pass's own revision. Time of day is owned by the grade
    // (C2) on both backends and nothing in the bake reads the camera, so a
    // phase boundary or a zoom step reuses the 26 MB surface instead of
    // rebaking and re-uploading it.
    _terrainBakeKey(bounds, dpr, season) {
        let passes = '';
        for (const pass of this._terrainBakePasses || []) {
            passes += `${pass.id}:${pass.revision?.(this) ?? 0},`;
        }
        return `${bounds.x},${bounds.y},${bounds.w},${bounds.h}@${dpr}|${this.assets ? 'assets' : 'fallback'}|season:${season}|scenery:${this._terrainSceneryRevision || 0}|passes:${passes}`;
    }

    // Anything that changes what the static terrain paints (scenery edits, a
    // re-authored tileset) calls this once; the next frame rebakes.
    invalidateTerrainBake() {
        this._terrainSceneryRevision = (this._terrainSceneryRevision || 0) + 1;
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

            // 3.2 — GroundBake paints every land texel (class field, C1 ramps,
            // AO, thresholds, yards, decals) in one cached image.
            this._runTerrainBakePasses(ctx, 'ground');
            // The far-row haze multiplies the ground only: water, foam and wet
            // sand stay exact CoastBake colours, which the resident water
            // cycles match by ungraded albedo (3.1, 3.6); baked props, bridges
            // and foundations take 1.6's aerial haze like every sprite.
            this._bakeAtmosphericPerspective(ctx);
            // 3.4/3.5 — CoastBake: one continuous coast field paints wet sand,
            // foam and every water pixel, then the stratified cliff under land
            // edge tiles only (the sea meets the cached outer ocean).
            this._runTerrainBakePasses(ctx, 'coast');
            this._drawTerrainOverlayTiles(ctx);
            this._drawLandmarkBridgeSpans(ctx);
            this.buildingRenderer?.drawGroundFoundations?.(ctx);
            this._drawAmbientGroundProps(ctx);
            this._runTerrainBakePasses(ctx, 'finish');
        } finally {
            this.motionScale = previousMotionScale;
        }
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
        const COURSES = 6;
        const SEAM_CELLS = 2;
        const rows = Math.ceil((bottomY - topY) / CELL);
        if (this._perspectiveTile?.height !== rows) {
            // Cool, high-value haze tint at half strength: multiply leaves the
            // near rows untouched (white → 1×) and cools the far rows.
            const stops = [[0, [196, 214, 232]], [0.5, [232, 240, 248]], [1, [255, 255, 255]]];
            const profile = (t) => {
                const k = t < 0.5 ? 0 : 1;
                const [t0, c0] = stops[k];
                const [t1, c1] = stops[k + 1];
                const f = (t - t0) / (t1 - t0);
                return c0.map((c, i) => Math.round(255 - (255 - (c + (c1[i] - c) * f)) * 0.5));
            };
            const colours = Array.from({ length: COURSES }, (_, course) => profile((course + 0.5) / COURSES));
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
            .filter((prop) => prop.layer === 'sorted')
            .filter((prop) => !this.scenery.isBlockedForTallScenery(prop.tileX, prop.tileY, this.sceneryClearTiles, this.bridgeTiles))
            .map((prop) => {
                const dims = this.assets?.getDims?.(prop.id);
                // 2.9 — precomputed so the per-frame drawFn does no lookup work:
                // land props get a contact shadow, water-surface props none.
                const contactShadow = !this.waterTiles.has(`${Math.floor(prop.tileX)},${Math.floor(prop.tileY)}`);
                return new StaticPropSprite({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    id: prop.id,
                    bounds: this._assetPropBounds(prop.id),
                    splitForOcclusion: Boolean(dims && dims.h >= 56),
                    drawFn: (ctx, x, y) => {
                        if (contactShadow) this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                        this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
                    },
                });
            }));
        // 7.1 — rest-seat furniture: back and front slices around each seat.
        sprites.push(...buildRestSeatPropSprites());
        return sprites;
    }

    _buildBridgeNearRailSprites() {
        if (!this.bridgeSpans?.length || !this.assets) return [];
        const sprites = [];
        for (const span of this.bridgeSpans) {
            const rail = span.nearRail;
            if (!rail) continue;
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
                sprites.push(new StaticPropSprite({
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
                }));
            }
        }
        return sprites;
    }

    _bridgeNearRailQuad(span, t0, t1) {
        const rail = span.nearRail;
        return [
            this._bridgePoint(span, t0, rail.inner, rail.top),
            this._bridgePoint(span, t1, rail.inner, rail.top),
            this._bridgePoint(span, t1, rail.outer, -rail.bottom),
            this._bridgePoint(span, t0, rail.outer, -rail.bottom),
        ];
    }

    // The two curtain runs (VillageWall), each one cached image with its 2.3
    // surface channel, and the bracket lanterns on some of their piers as
    // their own small props (their glass follows the village's lamplight,
    // so the runs' caches never repaint for it).
    _buildVillageWallSprites() {
        const out = [];
        const lanterns = [];
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
                lanterns.push(...this._villageWallLanternSprites(route.id, i, start, end, options, sortY));
            }
        }
        this._wallLanternSprites = lanterns;
        out.push(...lanterns);
        return out;
    }

    // The lantern piers of one run (the painter's own layout), each lantern
    // a prop standing on the ground under its glass, sorted just after its
    // run.
    _villageWallLanternSprites(routeId, index, start, end, { seed, startTurret = false }, wallSortY) {
        const x1 = Math.round(start.x);
        const y1 = Math.round(start.y);
        const x2 = Math.round(end.x);
        const y2 = Math.round(end.y);
        const slope = (y2 - y1) / Math.max(1, x2 - x1);
        const layout = wallRunLayout({ x1, x2, seed, piers: true, ivy: true, startTurret });
        const arm = WALL_SPEC.lanternArmH;
        const out = [];
        for (const pier of layout.piers) {
            if (!pier.lantern) continue;
            // The arm tip stands `pier.project + lanternReach` in front of
            // the base line under the pier's centre; its foot is the ground
            // there (the lattice row yb(c) - d).
            const d = -(WALL_SPEC.pier.project + WALL_SPEC.lanternReach);
            const c = pier.u0 + Math.floor(WALL_SPEC.pier.width / 2) + d;
            const fx = c;
            const fy = y1 + Math.floor((c - x1) * slope + 0.5) - d;
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
            out.push(sprite);
        }
        return out;
    }

    // The wall lanterns' fixture lights while the village's lamps are lit;
    // a change of state repaints the lantern props (glass lit or unlit) and
    // the gatehouse and sea tower, whose lamp glass is lit with them.
    _villageWallLanternLightSources(lighting = null) {
        const lit = lanternLit(lighting);
        if (lit !== this._wallLanternsLit) {
            this._wallLanternsLit = lit;
            for (const sprite of this._wallLanternSprites || []) sprite.invalidateCache();
            for (const sprite of this._lampGlassSprites || []) sprite.invalidateCache();
        }
        if (!lit) return [];
        const core = sourceEnergyFor(lighting).core;
        return (this._wallLanternSprites || []).map((sprite) => wallLanternLight({
            id: sprite.id,
            fx: sprite.lanternFoot.x,
            fy: sprite.lanternFoot.y,
            height: sprite.lanternFoot.height,
            lighting,
            core,
        }));
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
        const tower = new StaticPropSprite({
            tileX: towerTile.tileX,
            tileY: towerTile.tileY,
            id,
            bounds: this._assetPropBounds(id, 0.66),
            splitForOcclusion: true,
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
    // stubs call it bare; the full runs pass `{ piers, ivy, seed }`. The
    // paint is memoized per run and snow bucket, so the albedo cache and the
    // surface channel (`channel: 'surface'`) share one rasterization.
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
        const key = `${x1},${y1},${x2},${y2}|${runSeed}|${piers ? 1 : 0}${ivy ? 1 : 0}${endFace ? 1 : 0}${openStart ? 1 : 0}${openEnd ? 1 : 0}${startTurret ? 1 : 0}|${snowBucket}`;
        const cache = this._wallPaintCache || (this._wallPaintCache = new Map());
        if (cache.has(key)) return cache.get(key);
        if (cache.size > 24) cache.clear();
        const out = paintWallRun({ x1, y1, x2, y2, seed: runSeed, piers, ivy, endFace, snowBucket, openStart, openEnd, startTurret });
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
        };
    }

    // 3.12 — the Canvas water on the resident grammar: the mood copy of the
    // baked water (3.4), then its state (CanvasWaterState: the sunlit course,
    // swell caps and paws, crests, current, swash, rings, caustics, specks,
    // reflection ripple, the Lighthouse sheen, the sun/moon path and the 2.9
    // lamp columns).
    _drawDynamicWaterHighlights(ctx) {
        drawCanvasWaterMood(ctx, this, this._lastAtmosphere);
        drawCanvasWaterState(ctx, this, this._lastAtmosphere);
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
                // 2.8 — single-file plank crossings use the per-tile bridge.ew/ns
                // assets, mirroring the dock tile path.
                const orientation = (bInfo.orientation || 'EW').toLowerCase();
                if (this.sprites) this.sprites.drawSprite(ctx, `bridge.${orientation}`, screenX, screenY);
            }
        }
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
            nearRail: info.nearRail || null,
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

    _isInBridgeTreeExclusion(tileX, tileY) {
        if (!this.bridgeSpans?.length) return false;
        const p = this._tileToScreen(tileX, tileY);
        for (const span of this.bridgeSpans) {
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

    _lanternGroundLightSources(lighting = null) {
        const beaconIntensity = Math.max(0, Math.min(1, Number(lighting?.beaconIntensity) || 0));
        if (beaconIntensity <= 0.05) return [];
        const core = sourceEnergyFor(lighting).core;
        // V5 — a village lantern or brazier stands on its tile (the flame
        // source sits 10 px above it), its flame 16 (brazier) / 24 (lantern)
        // world px up: the pool lands around the foot, and the post, the
        // walls and the bodies around it light by their height and facing.
        return this._lanternGlowSources().map((source) => {
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
                radius: Math.min(isBrazier ? 62 : 52, SOURCE_HALO_RADIUS_CAP),
                intensity: (isBrazier ? 0.94 : 0.82) * core,
            });
        });
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

    _computeFrameLightSources(atmosphere = null, now = performance.now()) {
        const lighting = atmosphere?.lighting || null;
        const building = this.buildingRenderer?.getLightSources?.(lighting) || [];
        // V3 — council rings and talk arcs are the relationship status
        // grammar (drawn as ground cues); they throw no light, so no pool,
        // column or cast ever restates agent state on the ground.
        const ambient = [
            ...this._attentionLightSources(),
            ...building,
            ...this._familiarMoteLightSources(lighting),
            ...(this.arrivalDeparture?.getLightSources?.({ now }) || []),
            ...this._lanternGroundLightSources(lighting),
            ...this._villageWallLanternLightSources(lighting),
            ...(this.bridgeLanterns?.getLightSources?.(lighting) || []),
        ];
        // 2.6 — fire sources (forge door and spill, torches, village and gate
        // braziers) breathe in stepped 140 ms quanta on the one motion clock;
        // windows, lamps and attention lights never do. Each record is fresh
        // this frame, so the multiply lands exactly once.
        const motionTimeMs = this.motionTimeMs;
        for (const light of ambient) {
            if (light.fire && !light.attention) {
                light.intensity *= fireBreath(motionTimeMs, light.fireGroup || light.id, this.motionScale, fireBreathDepth(light.radius));
            }
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
            atmosphere,
            region: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
            timeMs: this.motionTimeMs ?? perfNow,
            reducedMotion: !((this.motionScale ?? 1) > 0),
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
        drawCanvasGradeLift(ctx, canvas.width, canvas.height, grade);
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
        const nightFactor = this._lanternNightFactor(atmosphere);
        if (nightFactor <= 0.05) return;
        const spill = sourceEnergyFor(atmosphere?.lighting).spill;
        const sources = this._lanternGlowSources();
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
            if (prop.id === 'prop.runeBrazier') push(prop.tileX, prop.tileY, 'brazier');
        }
        for (const prop of SCENIC_POINT_PROPS) {
            if (prop.id === 'prop.lantern') push(prop.tileX, prop.tileY);
            if (prop.id === 'prop.runeBrazier') push(prop.tileX, prop.tileY, 'brazier');
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
        drawCanvasGradeLift(ctx, canvas.width, canvas.height, grade);
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

    getWorldPerformanceDiagnostics() {
        const liveSpriteCanvases = new Set();
        for (const sprite of this.agentSprites.values()) {
            if (sprite?.spriteCanvas) liveSpriteCanvases.add(sprite.spriteCanvas);
        }
        let liveSpriteCanvasPixels = 0;
        for (const canvas of liveSpriteCanvases) liveSpriteCanvasPixels += canvasPixelCount(canvas);
        return {
            frameFailures: {
                ...this._frameFailureStats,
                byStage: { ...this._frameFailureStats.byStage },
                reportIntervalMs: WORLD_FRAME_ERROR_REPORT_INTERVAL_MS,
                maxConsecutive: WORLD_FRAME_MAX_CONSECUTIVE_FAILURES,
            },
            boundedState: {
                lightFadeColors: this.lightFadeColorCache?.size || 0,
                lightFadeColorLimit: LIGHT_FADE_COLOR_CACHE_LIMIT,
                lightFadeColorEvictions: this._lightFadeColorCacheEvictions,
                lightColorRgbEntries: this.lightColorRgbCache?.size || 0,
                lightColorRgbLimit: LIGHT_COLOR_RGB_CACHE_LIMIT,
                lightColorRgbEvictions: this._lightColorRgbCacheEvictions,
                crowdBumpCooldowns: this._crowdBumpCooldowns.size,
                crowdBumpCooldownLimit: CROWD_BUMP_COOLDOWN_LIMIT,
                nicknames: this._nicknames.size,
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
            relationships: this.relationshipState?.getDiagnostics?.() || null,
            council: getCouncilRingDiagnostics(this.relationshipState),
            pathfinder: this.pathfinder?.getDiagnostics?.() || null,
            gpuWorld: this.gpuWorld?.getDiagnostics?.() || null,
            worldRendererMode: this.worldRendererMode,
            worldBackendReason: this.worldBackendReason,
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
        };
        const volatilePixels = Object.values(volatile).reduce((sum, value) => sum + value, 0);
        const visibleCanvasPixels = canvasPixelCount(this.canvas);
        const overlayCanvasPixels = canvasPixelCount(this.overlayCanvas);
        const retainedAssetPixels = this.foliageRenderer?.getRetainedPixels?.() || 0;
        const resources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: visibleCanvasPixels + overlayCanvasPixels,
            volatileCanvasPixels: volatilePixels,
            retainedCanvasPixels: retainedAssetPixels,
            gpu: gpuResources,
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

    _drawAncientRuins(ctx) {
        const pulse = this.motionScale ? (Math.sin(this.waterFrame * 1.7) + 1) / 2 : 0.45;
        for (const ruin of ANCIENT_RUINS) {
            if (this.waterTiles.has(`${Math.floor(ruin.tileX)},${Math.floor(ruin.tileY)}`)) continue;
            const x = (ruin.tileX - ruin.tileY) * TILE_WIDTH / 2;
            const y = (ruin.tileX + ruin.tileY) * TILE_HEIGHT / 2;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(ruin.scale, ruin.scale);
            ctx.fillStyle = 'rgba(59, 53, 42, 0.62)';
            ctx.fillRect(-18, -28, 8, 31);
            ctx.fillRect(10, -24, 8, 27);
            ctx.fillRect(-18, -30, 36, 7);
            ctx.fillStyle = 'rgba(163, 147, 104, 0.35)';
            ctx.fillRect(-15, -25, 3, 24);
            ctx.fillRect(13, -21, 3, 22);
            ctx.strokeStyle = `rgba(201, 242, 107, ${0.08 + pulse * 0.14})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(0, -11, 14, Math.PI * 1.08, Math.PI * 1.92);
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawAmbientGroundProps(ctx) {
        ctx.save();
        this._drawAncientRuins(ctx);
        if (this.sprites) {
            for (const prop of AMBIENT_GROUND_PROPS) {
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                const id = `prop.${prop.type}`;
                this._drawPropContactShadow(ctx, x, y, id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, id, x, y, this._winterPropOpts(id));
            }
            for (const prop of DISTRICT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
            }
            // #41 — scenic-point storytelling props baked alongside the other
            // cache props so each loiter spot reads as an inhabited place.
            for (const prop of SCENIC_POINT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y, this._winterPropOpts(prop.id));
            }
        }

        for (const prop of this.commandCenterGroundProps) {
            const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
            const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
            if (prop.type === 'watchfire') this._drawCommandWatchfire(ctx, x, y, prop.phase || 0);
            else if (prop.type === 'guardpost') this._drawCommandGuardpost(ctx, x, y);
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

    _drawCommandWatchfire(ctx, x, y, phase = 0) {
        const flicker = this.motionScale ? Math.max(0, Math.sin(this.waterFrame * 7 + phase)) : 0.5;
        ctx.fillStyle = 'rgba(44, 30, 17, 0.6)';
        ctx.fillRect(x - 2, y - 12, 4, 10);

        // Ember bed reads as a pixel pool; the flame uses the shared taper.
        fillPixelEllipse(ctx, x, y - 12, 8 + flicker * 2, 4,
            `rgba(255, 132, 37, ${(0.12 + flicker * 0.08).toFixed(3)})`);
        drawPixelFlame(ctx, x, y - 11, 8 + flicker * 4, 3, {
            outer: `rgba(255, 132, 37, ${(0.62 + flicker * 0.24).toFixed(3)})`,
            inner: `rgba(255, 216, 122, ${(0.72 + flicker * 0.20).toFixed(3)})`,
            tip: `rgba(255, 245, 210, ${(0.60 + flicker * 0.24).toFixed(3)})`,
            lean: this.motionScale ? Math.sin(this.waterFrame * 2.1 + phase) * 1.2 : 0,
        });
    }

    _drawCommandGuardpost(ctx, x, y) {
        ctx.fillStyle = 'rgba(64, 45, 27, 0.85)';
        ctx.fillRect(x - 1.2, y - 11, 2.4, 11);
        ctx.fillStyle = 'rgba(154, 116, 59, 0.72)';
        ctx.fillRect(x - 7, y - 4, 14, 2.8);
        ctx.fillRect(x - 2, y - 8, 4, 1.5);
        ctx.fillStyle = 'rgba(230, 206, 146, 0.26)';
        ctx.beginPath();
        ctx.arc(x, y - 11, 1.4, 0, Math.PI * 2);
        ctx.fill();
    }

}
