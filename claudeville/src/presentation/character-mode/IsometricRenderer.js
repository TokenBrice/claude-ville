import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';
import { COMMAND_CENTER_DECORATION, normalizeBuildingType } from '../../config/buildings.js';
import { PORTAL_SPAWN_TILE, TOWN_ROAD_ROUTES, VILLAGE_GATE, VILLAGE_GATE_BOUNDS, VILLAGE_WALL_ROUTES } from '../../config/townPlan.js';
import {
    AMBIENT_GROUND_PROPS,
    AMBIENT_SCENIC_POINTS,
    ANCIENT_RUINS,
    BRIDGE_ACCENT_PROPS,
    BRIDGE_STYLE_PALETTES,
    DISTRICT_PROPS,
    DISTRICT_WASHES,
    FOREST_FLOOR_REGIONS,
    GULL_BANK_FRAME,
    GULL_FLIGHT_FRAMES,
    GULL_LIGHTHOUSE_HOTSPOT,
    GULL_OFFMAP_GATEWAYS,
    GULL_ROUTE_SPEED_SCALE,
    GULL_STAGING_WAYPOINTS,
    LAND_BIRD_ROUTES,
    CALM_WATER_FAUNA,
    SHORE_FAUNA,
    MARINE_FISH_SCHOOLS,
    OPEN_SEA_FLOCK_FORMATION,
    OPEN_SEA_FLOCK_ROUTES,
    TROPICAL_BROADLEAF_TREES,
    TROPICAL_PALMS,
    TROPICAL_WATERFALLS,
    WATCHTOWER_BEACON_BUOY_TILES,
    WATCHTOWER_GULL_FALLBACK_TILE,
    WATCHTOWER_GULL_ORBIT,
} from '../../config/scenery.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { AgentSprite, drawFamiliarMotes, familiarMoteLightSources } from './AgentSprite.js';
import { BuildingSprite } from './BuildingSprite.js';

import { SceneryEngine } from './SceneryEngine.js';
import { Pathfinder } from './Pathfinder.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { SkyRenderer } from './SkyRenderer.js';
import { AtmosphereState } from './AtmosphereState.js';
import { WeatherRenderer } from './WeatherRenderer.js';
import { SeasonalAmbience } from './SeasonalAmbience.js';
import { TerrainTileset } from './TerrainTileset.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';
import { LandmarkActivity } from './LandmarkActivity.js';
import { DebugOverlay } from './DebugOverlay.js';
import { AgentEventStream } from './AgentEventStream.js';
import { RelationshipState } from './RelationshipState.js';
import { RitualConductor } from './RitualConductor.js';
import { VisitIntentManager } from './VisitIntentManager.js';
import VisitTileAllocator from './VisitTileAllocator.js';
import { getPulsePriority } from './PulsePolicy.js';
import { lightSourceCacheKey, normalizeLightSource } from './LightSourceRegistry.js';
import {
    applyTeamPlazaPreferences,
    relationshipLightSources,
} from './CouncilRing.js';
import { ArrivalDepartureController } from './ArrivalDeparture.js';
import { extractRecipientName } from '../../domain/services/RecipientResolver.js';
import { BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { ChronicleMonuments } from './ChronicleMonuments.js';
import { TrailRenderer } from './TrailRenderer.js';
import { Chronicler } from './Chronicler.js';
import { VillageDirector } from './VillageDirector.js';
import { tileToWorld, worldToTile, buildingCenterToWorld } from './Projection.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';
import { buildStaticPropDrawables } from './StaticPropDrawables.js';
import { createDepthDrawable, propDepthDrawable } from './DrawablePass.js';
import { renderWorldFrame } from './WorldFrameRenderer.js';
import {
    CANVAS_BUDGET,
    canvasMapPixelCount,
    canvasPixelCount,
    releaseCanvasBackingStore,
    releaseCanvasMap,
} from './CanvasBudget.js';

const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
const MAX_LIGHT_GRADIENT_CACHE_PIXELS = CANVAS_BUDGET.maxLightCachePixels;
const MAX_LIGHT_GRADIENT_STAMP_PIXELS = Math.floor(MAX_LIGHT_GRADIENT_CACHE_PIXELS / 5);
const FAST_ATMOSPHERE_BACKING_PIXELS = 800_000;
const FAST_PROP_BACKING_PIXELS = 800_000;
const FAST_PROP_MIN_ZOOM = 1.5;
const FAST_PROP_AGENT_MARGIN = 36;
const FAST_PROP_SCREEN_MARGIN = 96;
const TERRAIN_CACHE_MARGIN = 360;
const TERRAIN_CACHE_CHUNK_SIZE = 16;
const TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS = CANVAS_BUDGET.maxWorldCachePixels;
const ACTIVE_BUILDING_EMITTER_GATE = 'active-building-agents';
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
const AGENT_RENDER_COMPACT_COUNT = 80;
const AGENT_RENDER_COMPACT_ZOOM = 2.2;
const AGENT_RENDER_COMPACT_CSS_PIXELS = 1_450_000;
const AGENT_RENDER_COMPACT_CANVAS_PIXELS = 1_900_000;
const AGENT_RENDER_MINIMAL_COUNT = 96;
const AGENT_RENDER_MINIMAL_CSS_PIXELS = 1_700_000;
const AGENT_RENDER_MINIMAL_CANVAS_PIXELS = 1_700_000;
const CROWD_CLUSTER_TILE_SIZE = 4;
const CROWD_CLUSTER_TOP_LIMIT = 12;
const AGENT_NAME_TAG_MAX_WIDTH = 152;
const AGENT_NAME_TAG_MIN_WIDTH = 40;
// Must track the real name-tag pill in AgentSprite._drawNameTag: Departure Mono
// at NAME_TAG_FONT_PX (11) is ~7px/char monospace, and NAME_TAG_PADDING_X is 20.
// The old 4.5/9 estimate was ~60% of the real width, so the de-overlap rects
// were too narrow and horizontally-close name tags collided on the same slot.
const AGENT_NAME_TAG_CHAR_WIDTH = 7;
const AGENT_NAME_TAG_PADDING_X = 20;
const AGENT_NAME_TAG_SINGLE_HEIGHT = 16;
const AGENT_NAME_TAG_DOUBLE_HEIGHT = 23;
const AGENT_COMPACT_NAME_MAX_WIDTH = 180;
const AGENT_COMPACT_NAME_MIN_WIDTH = 54;
const AGENT_COMPACT_NAME_CHAR_WIDTH = 5.5;
const AGENT_COMPACT_NAME_EXTRA_WIDTH = 38;
const AGENT_COMPACT_NAME_HEIGHT = 17;
const AGENT_COMPACT_NAME_SLOT_BASE_Y = 22;
const AGENT_COMPACT_NAME_SLOT_STEP_Y = 12;
const WATER_TOKENS = {
    lagoon: {
        shallow: 'rgb(10,180,190)',
        deep: 'rgb(22,152,160)',
        glint: '120, 230, 200',
        rainRipple: '210, 255, 242',
        fogWash: '205, 238, 228',
        wake: '206, 252, 236',
    },
    river: {
        shallow: 'rgb(12,136,166)',
        deep: 'rgb(8,92,126)',
        glint: '150, 226, 236',
        rainRipple: '202, 242, 250',
        fogWash: '202, 232, 232',
        wake: '198, 238, 246',
    },
    sea: {
        shallow: '#0e9aa5',
        deep: '#074276',
        glint: '132, 211, 240',
        rainRipple: '188, 226, 244',
        fogWash: '190, 220, 232',
        wake: '224, 249, 255',
    },
    harbor: {
        shallow: '#0a8192',
        deep: '#075274',
        glint: '154, 218, 224',
        rainRipple: '202, 236, 242',
        fogWash: '198, 226, 226',
        wake: '216, 246, 246',
    },
    water: {
        shallow: '#0e9aa5',
        deep: '#0b6c8d',
        glint: '188, 253, 246',
        rainRipple: '210, 245, 255',
        fogWash: '205, 232, 236',
        wake: '220, 248, 250',
    },
};
const ATMOSPHERE_EFFECT_ASSETS = Object.freeze({
    fogWisp: 'atmosphere.fog.wisp.low',
    rainSplash: 'atmosphere.rain.splash',
    rainRipple: 'atmosphere.water.ripple.rain',
    shoreFoam: 'atmosphere.water.foam.corner',
    harborWake: 'atmosphere.water.harbor.wake',
});
// Archive fade: keep the sprite in the draw loop for this many ms after
// `agent:removed` so the sibling AgentSprite fade/sparkle animation can play.
const ARCHIVE_FADE_DURATION_MS = 800;
// 2.4 — affinity proximity: how often ally pairs are re-evaluated, and how
// many warm pairs get a shared plaza preference per pass (keeps idle
// drift bounded in dense worlds).
const AFFINITY_PROXIMITY_INTERVAL_MS = 5000;
const MAX_AFFINITY_PROXIMITY_PAIRS = 6;
const GULL_BASE_POPULATION = OPEN_SEA_FLOCK_ROUTES.reduce((sum, flock) => sum + flock.size, 0);
const GULL_MAX_POPULATION = GULL_BASE_POPULATION * 3;
const GULL_MIN_ACTIVE_TARGET = Math.max(1, Math.floor(GULL_BASE_POPULATION / 4));
const GULL_MAX_ACTIVE_TARGET = Math.max(GULL_MIN_ACTIVE_TARGET, Math.floor(GULL_MAX_POPULATION / 2));
const BRIDGE_SPRITE_MIN_WIDTH = 390;
const BRIDGE_SPRITE_MAX_WIDTH = 500;
const VILLAGE_WOOD_PALETTE = Object.freeze({
    shadow: 'rgba(28, 15, 7, 0.34)',
    outline: '#1b1009',
    deep: '#2b170c',
    dark: '#3f2412',
    mid: '#6e421f',
    light: '#a96d34',
    cut: '#d09652',
    rope: '#c9a15d',
    ropeDark: '#7f5b2b',
    moss: '#4f7b3d',
    tealDark: '#1f4c51',
    teal: '#347b83',
    tealLight: '#6fb1a9',
    lantern: '#ffd56a',
    glow: 'rgba(255, 202, 94, 0.26)',
});
const VILLAGE_STONE_PALETTE = Object.freeze({
    light: '#cfc6b3',
    mid: '#bdb6a8',
    shadow: '#a59e8d',
    mortar: '#5b574e',
    moss: '#4f7b3d',
    outline: '#1b1009',
});
const VILLAGE_WALL_SEA_TOWER_SPRITE_ID = 'prop.villageWallSeaTower';
class StaticPropSprite {
    constructor({ tileX, tileY, drawFn, id = null, bounds = null, splitForOcclusion = false, sortY = null }) {
        this.tileX = tileX;
        this.tileY = tileY;
        const world = tileToWorld(tileX, tileY);
        this.x = world.x;
        this.y = world.y;
        this.sortY = Number.isFinite(Number(sortY)) ? Number(sortY) : this.y;
        this.drawFn = drawFn;
        this.id = id;
        this.bounds = bounds || { left: -32, right: 32, top: -64, bottom: 12, splitY: -18 };
        this.splitForOcclusion = splitForOcclusion;
        this._cacheCanvas = null;
    }
    draw(ctx, zoom) {
        this.drawFn(ctx, this.x, this.y, zoom);
    }
    drawPart(ctx, part, zoom) {
        if (!this.splitForOcclusion || part === 'whole') {
            this.draw(ctx, zoom);
            return;
        }
        const { left, right, top, bottom, splitY } = this.bounds;
        const clipTop = part === 'back' ? top : splitY;
        const clipBottom = part === 'back' ? splitY : bottom;
        if (clipBottom <= clipTop) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
            Math.floor(this.x + left) - 2,
            Math.floor(this.y + clipTop) - 2,
            Math.ceil(right - left) + 4,
            Math.ceil(clipBottom - clipTop) + 4
        );
        ctx.clip();
        this.draw(ctx, zoom);
        ctx.restore();
    }
    drawCached(ctx, zoom) {
        const cached = this._getCachedCanvas(zoom);
        if (!cached) {
            this.draw(ctx, zoom);
            return;
        }
        ctx.drawImage(cached.canvas, cached.x, cached.y);
    }
    drawCachedPart(ctx, part, zoom) {
        if (!this.splitForOcclusion || part === 'whole') {
            this.drawCached(ctx, zoom);
            return;
        }
        const { left, right, top, bottom, splitY } = this.bounds;
        const clipTop = part === 'back' ? top : splitY;
        const clipBottom = part === 'back' ? splitY : bottom;
        if (clipBottom <= clipTop) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
            Math.floor(this.x + left) - 2,
            Math.floor(this.y + clipTop) - 2,
            Math.ceil(right - left) + 4,
            Math.ceil(clipBottom - clipTop) + 4
        );
        ctx.clip();
        this.drawCached(ctx, zoom);
        ctx.restore();
    }
    _getCachedCanvas(zoom) {
        if (this._cacheCanvas) return this._cacheCanvas;
        if (typeof document === 'undefined') return null;
        const pad = 8;
        const { left, right, top, bottom } = this.bounds;
        const width = Math.max(1, Math.ceil(right - left + pad * 2));
        const height = Math.max(1, Math.ceil(bottom - top + pad * 2));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        SpriteRenderer.disableSmoothing(ctx);
        ctx.translate(-(this.x + left - pad), -(this.y + top - pad));
        this.drawFn(ctx, this.x, this.y, zoom);
        this._cacheCanvas = {
            canvas,
            x: Math.floor(this.x + left - pad),
            y: Math.floor(this.y + top - pad),
        };
        return this._cacheCanvas;
    }
    propBackSortY() {
        return this.sortY + Math.min(-8, this.bounds.splitY);
    }
    propFrontSortY() {
        return this.sortY + Math.max(0, this.bounds.bottom * 0.25);
    }
}

export class IsometricRenderer {
    constructor(world, options = {}) {
        this.world = world;
        this.assets = options.assets || null;
        this.sprites = this.assets ? new SpriteRenderer(this.assets) : null;
        this.terrain = this.assets ? new TerrainTileset(this.assets) : null;
        this.compositor = this.assets ? new Compositor(this.assets) : null;
        this.canvas = null;
        this.ctx = null;
        this.camera = null;
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
        this.agentSprites = new Map();
        this.gateTransits = new Map();
        this.gateDoorsOpen = false;
        this._gateDoorsOpenUntilMs = 0;
        this._sortedSprites = [];
        this._movingSprites = [];
        this._pairBuckets = new Map();
        this._pairIds = new Map();
        this._pairVisited = new Set();
        this._spritesNeedSort = true;
        this._laneTiles = new Map();
        this._staticPropDrawables = [];
        this._drawables = [];
        this._familiarMoteDrawables = [];
        this._harborPendingSignature = '';
        this._contextLost = false;
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
        this.terrainCacheMeta = null;
        this._terrainCacheLimitWarningKey = '';
        this.fantasyForestTreeCache = new Map();
        this.terrainSeed = [];
        this.waterFrame = 0;
        this.openSeaFlockBirds = this._buildOpenSeaFlockBirds();
        this.motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this.motionScale = this.motionQuery?.matches ? 0 : 1;
        this.ritualConductor = new RitualConductor({ motionScale: this.motionScale });
        this.arrivalDeparture = new ArrivalDepartureController({ motionScale: this.motionScale });
        this.chronicleMonuments = new ChronicleMonuments({ store: this.chronicleStore });
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            motionScale: this.motionScale,
        });
        this.chronicler = new Chronicler({
            assets: this.assets,
            sprites: this.sprites,
            motionScale: this.motionScale,
        });
        this.particleSystem.setMotionEnabled(this.motionScale > 0);
        this._onMotionPreferenceChange = (event) => this._setMotionScale(event.matches ? 0 : 1);
        this._motionPreferenceBound = false;
        this._bindMotionPreference();
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        this.lightGradientCache = new Map();
        this.lightFadeColorCache = new Map();
        this._frameLightSources = null;
        this.selectedAgent = null;
        this.onAgentSelect = null;
        this._chatMatchAccumulator = 250;
        this._crowdBumpCooldowns = new Map();
        this._stationaryOverlapAccumulator = 0;
        this._rainSplashAccumulator = 0;
        this._localAvoidanceMetrics = {
            laneCorrections: 0,
            separationPushes: 0,
            zeroDistancePairs: 0,
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
        this._chroniclerPauseUntil = 0;
        this._chronicleNextUpdateAt = 0;
        this._chronicleUpdating = false;
        this._worldModeActive = true;
        this._worldSpritesDirty = false;
        this._onModeChanged = null;

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
        });
        this.waterTiles = this.scenery.getWaterTiles();
        this.shoreTiles = this.scenery.getShoreTiles();
        this.deepWaterTiles = this.scenery.getDeepWaterTiles();
        this.lagoonWaterTiles = this.scenery.getLagoonWaterTiles();
        this.waterMeta = this.scenery.getWaterMeta?.() || new Map();
        this.harborWaterApronTiles = this._buildHarborWaterApronTiles();

        // Bridges (Task 5): two authored river crossings only.
        this.scenery.generateBridges();
        this.bridgeTiles = this.scenery.getBridgeTiles();
        this.bridgeSpans = this._buildBridgeSpans();
        this._waterTileDescriptors = this._buildWaterTileDescriptors();
        this._shoreWaterEdgeDescriptors = this._buildShoreWaterEdgeDescriptors();
        this._visibleWaterFrame = [];
        this._visibleShoreFrame = [];
        this._visibleWaterCullKey = '';
        this._visibleShoreCullKey = '';
        for (const key of this.bridgeTiles.keys()) {
            this.pathTiles.add(key);
        }
        // Re-classify so newly-pathified bridge tiles inherit avenue style.
        // CRITICAL: _classifyRoadMaterials *adds* to mainAvenueTiles and
        // dirtPathTiles without clearing them, so a tile could end up in
        // BOTH sets and break _drawTile's mutually-exclusive styling.
        // Clear first.
        this.mainAvenueTiles.clear();
        this.dirtPathTiles.clear();
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);

        // Now that bridges are in pathTiles, generate terrain features so
        // bridges don't get tagged with reeds/flowers/stones/mushrooms.
        this.featureTiles = new Map();
        this._generateTerrainFeatures();

        // Flat vegetation (bushes, grass tufts) — populated after terrain features
        // so noise samples don't compete and after bridges so they're skipped.
        this.scenery.generateFlatVegetation(this.pathTiles, this.bridgeTiles);
        this.bushTiles = this.scenery.getBushTiles();
        this.grassTuftTiles = this.scenery.getGrassTuftTiles();
        this.flowerTiles = this.scenery.getFlowerTiles();

        // Trees (Y-sorted props)
        this.scenery.generateTrees(this.pathTiles, this.bridgeTiles);
        const generatedTrees = this.scenery.getTreeProps();
        const canPlaceAuthoredTree = (p) => !this.scenery.isBlockedForTallScenery(
            p.tileX,
            p.tileY,
            this.pathTiles,
            this.bridgeTiles,
        );
        const authoredPalms = TROPICAL_PALMS.filter(canPlaceAuthoredTree).map((p) => ({
            ...p,
            variant: 2,
            tropical: true,
        }));
        const authoredBroadleafTrees = TROPICAL_BROADLEAF_TREES.filter(canPlaceAuthoredTree).map((p) => ({
            ...p,
            variant: 3,
            tropical: true,
            canopy: true,
        }));
        this.treePropSprites = [...generatedTrees, ...authoredPalms, ...authoredBroadleafTrees]
            .filter((t) => !this._isInBridgeTreeExclusion(t.tileX, t.tileY))
            .map((t) => {
            // Deterministic per-tree phase seed for wind sway. Anchored to
            // tile coordinates + variant so the visual offset is stable across
            // reloads but each tree drifts on its own phase.
            const swaySeed = this._windSwaySeed(t);
            if (t.canopy || t.tropical) {
                const bounds = this._fantasyTreePropBounds(t);
                return new StaticPropSprite({
                    tileX: t.tileX,
                    tileY: t.tileY,
                    id: 'fantasy.tree',
                    bounds,
                    splitForOcclusion: true,
                    drawFn: (ctx, x, y) => this._withTreeSway(
                        ctx,
                        swaySeed,
                        () => this._drawFantasyForestTree(ctx, x, y, t),
                    ),
                });
            }
            // variant 0 -> oak, 1 -> pine, 2 -> willow; size driven by scale threshold.
            const species = ['oak', 'pine', 'willow'][(t.variant ?? 0) % 3];
            const size = (t.scale ?? 1) >= 1.0 ? 'large' : 'small';
            const id = `veg.tree.${species}.${size}`;
            return new StaticPropSprite({
                tileX: t.tileX,
                tileY: t.tileY,
                id,
                bounds: this._assetPropBounds(id),
                splitForOcclusion: true,
                drawFn: (ctx, x, y) => this._withTreeSway(
                    ctx,
                    swaySeed,
                    () => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
                ),
            });
        });

        // Boulders (Y-sorted props)
        this.scenery.generateBoulders(this.pathTiles, this.bridgeTiles);
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
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
            });
        });
        this.districtPropSprites = this._buildDistrictPropSprites();
        this._staticPropSprites = [
            ...this.treePropSprites,
            ...this.boulderPropSprites,
            ...this.districtPropSprites,
        ];
        this._staticPropDrawables = this._buildStaticPropDrawables();
        this._staticPropFastDrawables = this._buildStaticPropFastDrawables();
        this._staticPropFastFrameDrawables = [];
        this._staticPropVisibleFrameDrawables = [];

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
        // Latest building presence tiers, refreshed via building:active-agents
        // and consulted by gated emitters. Map<type, { count, recencyScore, tier }>.
        this._buildingPresenceMap = new Map();
        // Per-emitter interval timestamps for gated/intervaled emitters.
        this._emitterIntervalLastMs = new Map();

        // Event subscriptions
        this._unsubscribers = [];
        this.debugOverlay = new DebugOverlay();
    }

    _generatePaths() {
        const buildingDefs = Array.from(this.world.buildings.values());
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        for (const b of buildingDefs) {
            // Paths around buildings
            for (let x = b.position.tileX - 1; x <= b.position.tileX + b.width; x++) {
                for (let y = b.position.tileY - 1; y <= b.position.tileY + b.height; y++) {
                    if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                        this.pathTiles.add(`${x},${y}`);
                    }
                }
            }
            for (const tile of this._buildingApproachTiles(b)) {
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

    _waterTokenAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const region = this._waterRegionAt(tileX, tileY, key);
        if (region === 'openSea') return WATER_TOKENS.sea;
        return WATER_TOKENS[region] || WATER_TOKENS.water;
    }

    _isLagoonWaterTile(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        return meta?.region === 'lagoon' || meta?.weatherProfile === 'lagoon' || this.lagoonWaterTiles?.has(key);
    }

    _buildWaterTileDescriptors() {
        const descriptors = [];
        if (!this.waterTiles?.size) return descriptors;
        for (const key of this.waterTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const { tileX: x, tileY: y } = tile;
            const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
            const openness = this._waterOpenness(x, y);
            const profile = this._waterProfileAt(x, y, key);
            const token = this._waterTokenAt(x, y, key);
            descriptors.push({
                x,
                y,
                key,
                seed,
                screenX: (x - y) * TILE_WIDTH / 2,
                screenY: (x + y) * TILE_HEIGHT / 2,
                edge: this._waterEdgeMask(x, y),
                openness,
                profile,
                token,
                isDeep: this.deepWaterTiles.has(key),
                isHarbor: this._isHarborWater(x, y),
                isLagoon: this._isLagoonWaterTile(x, y, key),
                isOpenSea: this._isOpenSeaTile(x, y, openness),
            });
        }
        return descriptors;
    }

    _buildShoreWaterEdgeDescriptors() {
        const descriptors = [];
        if (!this.shoreTiles?.size) return descriptors;
        for (const key of this.shoreTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const { tileX: x, tileY: y } = tile;
            const edge = this._shoreWaterEdgeMask(x, y);
            if (!edge) continue;
            const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
            const adjacent = this._firstAdjacentWaterMeta(x, y);
            descriptors.push({
                x,
                y,
                key,
                seed,
                edge,
                screenX: (x - y) * TILE_WIDTH / 2,
                screenY: (x + y) * TILE_HEIGHT / 2,
                adjacent,
                token: adjacent ? this._waterTokenAt(adjacent.x, adjacent.y, adjacent.key) : WATER_TOKENS.water,
                profile: adjacent ? this._waterProfileAt(adjacent.x, adjacent.y, adjacent.key) : 'water',
            });
        }
        return descriptors;
    }

    _visibleWaterTileDescriptors(bounds) {
        const out = this._visibleWaterFrame;
        if (!bounds || !this._waterTileDescriptors?.length) {
            out.length = 0;
            this._visibleWaterCullKey = '';
            return out;
        }
        const { startX, endX, startY, endY } = bounds;
        const key = `${startX},${endX},${startY},${endY}|${this._waterTileDescriptors.length}`;
        if (key === this._visibleWaterCullKey) return out;
        this._visibleWaterCullKey = key;
        out.length = 0;
        for (const tile of this._waterTileDescriptors) {
            if (tile.x >= startX && tile.x <= endX && tile.y >= startY && tile.y <= endY) out.push(tile);
        }
        return out;
    }

    _visibleShoreWaterEdgeDescriptors(bounds) {
        const out = this._visibleShoreFrame;
        if (!bounds || !this._shoreWaterEdgeDescriptors?.length) {
            out.length = 0;
            this._visibleShoreCullKey = '';
            return out;
        }
        const { startX, endX, startY, endY } = bounds;
        const key = `${startX},${endX},${startY},${endY}|${this._shoreWaterEdgeDescriptors.length}`;
        if (key === this._visibleShoreCullKey) return out;
        this._visibleShoreCullKey = key;
        out.length = 0;
        for (const tile of this._shoreWaterEdgeDescriptors) {
            if (tile.x >= startX && tile.x <= endX && tile.y >= startY && tile.y <= endY) out.push(tile);
        }
        return out;
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
        const radius = Math.max(0, Math.floor(width / 2));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(fromX + (toX - fromX) * t);
            const y = Math.round(fromY + (toY - fromY) * t);
            for (let ox = -radius; ox <= radius; ox++) {
                for (let oy = -radius; oy <= radius; oy++) {
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

    _markRoadMaterial(key, material) {
        if (material === 'avenue' || material === 'dock') {
            this.mainAvenueTiles.add(key);
        } else {
            this.dirtPathTiles.add(key);
        }
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

    _classifyRoadMaterials(plazaHubX, plazaHubY) {
        for (const key of this.pathTiles) {
            if (this.townSquareTiles.has(key)) continue;
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            const dx = (x - plazaHubX) / 4.2;
            const dy = (y - plazaHubY) / 3.0;
            const nearPlaza = (dx * dx + dy * dy) <= 1.0;
            const routeNoise = this._tileNoise(x + 73, y + 29);
            if (this.commandCenterRoadTiles?.has(key) || nearPlaza || routeNoise > 0.72) {
                this.mainAvenueTiles.add(key);
            } else if (routeNoise < 0.34 || ((x + y) % 5 === 0)) {
                this.dirtPathTiles.add(key);
            }
        }
    }

    _generateTerrainFeatures() {
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                if (this.waterTiles.has(key) || this.pathTiles.has(key)) continue;
                const noise = this._tileNoise(x + 41, y + 17);
                if (this.shoreTiles.has(key) && noise > 0.46) {
                    this.featureTiles.set(key, 'reeds');
                } else if (noise < 0.045) {
                    this.featureTiles.set(key, 'flowers');
                } else if (noise > 0.948) {
                    this.featureTiles.set(key, 'stones');
                } else if (noise > 0.918 && this._tileNoise(x - 9, y + 23) > 0.62) {
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

        // Reinforce the command footprint with clear ceremonial markers.
        for (const prop of COMMAND_CENTER_DECORATION) {
            const tileX = cx + prop.localX;
            const tileY = cy + prop.localY;
            if (!this._inMapBounds(tileX, tileY)) continue;
            this.commandCenterGroundProps.push({
                ...prop,
                tileX,
                tileY,
            });
        }

        // Hard guardrails at the approach mouths and northern shoulder.
        this.commandCenterRoadTiles.add(`${southGateX},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY - 1}`);

        // Reinforce the ceremonial entrance and northern gate with visible guard-posts.
        this.commandCenterGroundProps.push(
            { tileX: southGateX - 0.35, tileY: southY + 0.2, type: 'guardpost', phase: 0.2 },
            { tileX: southGateX + 0.25, tileY: southY + 0.2, type: 'guardpost', phase: 1.1 },
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
            { tileX: 33.0, tileY: 19.5, particleType: 'smoke', chance: 0.012 },
            { tileX: 13.4, tileY: 34.3, particleType: 'mineDust', chance: 0.016 },
            { tileX: 13.4, tileY: 34.0, particleType: 'firefly', chance: 0.014 },
            { tileX: 27.8, tileY: 29.2, particleType: 'forgeEmber', chance: 0.02 },
            { tileX: 4.8, tileY: 32.2, particleType: 'portalRune', chance: 0.022 },
            { tileX: 22.4, tileY: 33.1, particleType: 'questPing', chance: 0.014 },
            { tileX: 8.5, tileY: 16.8, particleType: 'archiveMote', chance: 0.022 },
            { tileX: 23.4, tileY: 17.8, particleType: 'sparkle', chance: 0.012 },
            { tileX: 32.5, tileY: 16.4, particleType: 'beaconMote', chance: 0.014 },
            { tileX: 9.5, tileY: 8.5, particleType: 'firefly', chance: 0.014 },
            // Building-activity gated smoke plumes. Roof anchors raise the
            // spawn point (worldY -= 22) above each building footprint and
            // the active-building gate tells _updateAmbientEffects
            // to consult the presence map (occupied/busy => spawn ~every 600ms).
            { tileX: 28, tileY: 27, particleType: 'smoke', intervalMs: 600,
              gatedBy: ACTIVE_BUILDING_EMITTER_GATE, building: 'forge', worldYOffset: -22 },
            { tileX: 12, tileY: 32, particleType: 'smoke', intervalMs: 600,
              gatedBy: ACTIVE_BUILDING_EMITTER_GATE, building: 'mine', worldYOffset: -22 },
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

    show(canvas) {
        if (!canvas || typeof canvas.getContext !== 'function') {
            console.warn('[IsometricRenderer] show skipped: invalid canvas element');
            return;
        }
        if (this.running) {
            this.hide();
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        if (!this.ctx) {
            console.warn('[IsometricRenderer] show skipped: failed to get 2d context');
            return;
        }
        if (!this.villageDirector) {
            this.villageDirector = new VillageDirector(this.world);
            this.villageDirector.setMotionScale?.(this.motionScale);
            if (this.quotaState) this.villageDirector.setQuotaState?.(this.quotaState);
        }
        this._ensureTrailRenderer();
        this._contextLost = false;
        this.camera = new Camera(canvas);
        this.camera.attach();
        // Re-arm SkyRenderer aurora/shooting-star event wiring; mode toggles
        // detach in hide() and would otherwise leave these subscriptions dead.
        this.skyRenderer?.attach?.();
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
        if (typeof window !== 'undefined') {
            window.__relationshipState = () => this.relationshipState?.getSnapshot?.();
            window.__visitIntents = () => this.visitIntentManager?.debugSnapshot?.() || null;
            window.__visitReservations = () => this.visitTileAllocator?.debug?.() || null;
            window.__agentBehavior = (agentId) => this.agentSprites.get(agentId)?.getBehaviorDebugSnapshot?.() || null;
            window.__buildingCrowds = () => this.visitTileAllocator?.snapshot?.()?.buildings || {};
            window.__agentBehaviorStats = () => this._agentBehaviorStats();
            window.__agentCrowds = () => this._crowdStats || this._summarizeCrowdClusters();
            window.__villageDirector = () => this.villageDirector?.getSnapshot?.() || null;
        }

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
                const handled = this._beginRelationshipDeparture(agent);
                if (!handled) this._beginAgentGateDeparture(agent);
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
                if (sprite) {
                    if (sprite.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                    else sprite.agent = agent;
                    this._markSpritesDirty();
                }
            }),
            eventBus.on('subagent:dispatched', (payload) => {
                this._enqueueSubagentSummonRitual(payload);
            }),
            // Cache the latest building presence tiers so per-frame emitter
            // gating (forge/mine smoke) can read tier === 'occupied'|'busy'
            // without hot-path enumeration of agent sprites.
            eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, (payload) => {
                if (!payload) return;
                this._buildingPresenceMap = new Map(Object.entries(payload));
            }),
            // 4.8 — earned nicknames garnish agent name tags.
            eventBus.on('biography:updated', (payload) => {
                const identityKey = payload?.identityKey;
                if (!identityKey) return;
                const nickname = payload?.biography?.nickname || null;
                if (nickname) this._nicknames.set(identityKey, nickname);
                else this._nicknames.delete(identityKey);
                this._applyNicknames();
            }),
        );

        // Cross-tab nickname refresh: when another tab persists a biography,
        // AgentBiographyService drops its cached copy first (it registered on
        // the channel earlier), so this re-read sees the fresh record.
        if (this.biographyService && this.chronicleStore?.channel?.addEventListener) {
            this._chronicleChannelListener = (event) => {
                const identityKey = event?.data?.identityKey;
                if (event?.data?.type !== 'biography-updated' || !identityKey) return;
                this.biographyService.getBiography(identityKey).then((biography) => {
                    const nickname = biography?.nickname || null;
                    if (nickname) this._nicknames.set(identityKey, nickname);
                    else this._nicknames.delete(identityKey);
                    this._applyNicknames();
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

        // Hover handler for buildings
        this._onMouseMoveMain = (e) => {
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
            canvas.title = hoveredBuilding
                ? this._buildingVisitorTooltip(hoveredBuilding)
                : (monument
                    ? this.chronicleMonuments.tooltipFor(monument, Date.now())
                    : (hoveredShip ? this.harborTraffic.shipTooltip(hoveredShip) : ''));
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);
        this._onMouseLeaveMain = () => {
            this.buildingRenderer?.setHovered(null);
            this.villageDirector?.setHoveredBuilding?.(null);
            this.harborTraffic?.setHoveredShip?.(null);
            canvas.title = '';
        };
        canvas.addEventListener('mouseleave', this._onMouseLeaveMain);
        this._onKeyDown = (e) => {
            if (e.code === 'KeyD' && e.shiftKey) this.debugOverlay.toggle();
            if (e.code === 'KeyP' && e.shiftKey) this.debugOverlay.togglePathDebug();
            this._handleWorldKeyboardCommand(e);
        };
        window.addEventListener('keydown', this._onKeyDown);
        this._onModeChanged = (mode) => this.setWorldModeActive(mode !== 'dashboard');
        eventBus.on('mode:changed', this._onModeChanged);
        this._triggerReleaseParadeForVersion();

        this.running = true;
        this._startLoop();
    }

    hide() {
        this.running = false;
        this._stopLoop();
        if (this.camera) {
            this.camera.detach();
        }
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
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
        if (this._chronicleChannelListener && this.chronicleStore?.channel?.removeEventListener) {
            this.chronicleStore.channel.removeEventListener('message', this._chronicleChannelListener);
        }
        this._chronicleChannelListener = null;
        if (this._onModeChanged) {
            eventBus.off('mode:changed', this._onModeChanged);
            this._onModeChanged = null;
        }
        this.chronicler?.destroy?.();
        this._sortedSprites = [];
        this._spritesNeedSort = true;
        this.agentSprites.clear();
        this.gateTransits.clear();
        this.particleSystem.clear();
        this.buildingRenderer?.dispose?.();
        this.releaseVolatileCaches();
        this.trailRenderer?.dispose?.();
        this.trailRenderer = null;
        this.agentEventStream?.dispose?.();
        this.relationshipState?.dispose?.();
        this.ritualConductor?.dispose?.();
        this.villageDirector?.dispose?.();
        this.agentEventStream = null;
        this.relationshipState = null;
        this.ritualConductor = null;
        this.villageDirector = null;
        if (typeof window !== 'undefined' && window.__relationshipState) {
            delete window.__relationshipState;
        }
        if (typeof window !== 'undefined') {
            delete window.__visitIntents;
            delete window.__visitReservations;
            delete window.__agentBehavior;
            delete window.__buildingCrowds;
            delete window.__agentBehaviorStats;
            delete window.__agentCrowds;
            delete window.__villageDirector;
        }
        this.visitIntentManager?.dispose?.();
        this.visitTileAllocator?.updateContext?.({ agentSprites: [] });
        this.fantasyForestTreeCache.clear();
        this.weatherRenderer?.dispose?.();
        this.skyRenderer?.detach?.();
        this.skyRenderer?.releaseCache?.();
        this.atmosphereState?.dispose?.();
        // SeasonalAmbience holds no resources today; the optional chain keeps
        // the lifecycle hook in place if a dispose method lands.
        this.seasonalAmbience?.dispose?.();
    }

    _startLoop() {
        if (!this.running || this.frameId !== null || !this._worldModeActive || this._contextLost) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        this.frameId = requestAnimationFrame(() => this._loop());
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
        if (this._worldModeActive === nextActive) return;
        this._worldModeActive = nextActive;
        this._lastFrameTime = performance.now();
        if (nextActive) {
            if (this._worldSpritesDirty) this._reconcileSpritesWithWorld();
            this.invalidateViewportCaches();
            this._startLoop();
        } else {
            this._stopLoop();
            this.releaseVolatileCaches();
        }
    }

    pauseForVisibility() {
        this._stopLoop();
        this.releaseVolatileCaches();
    }

    resumeFromVisibility({ active = true } = {}) {
        this._worldModeActive = Boolean(active);
        this._lastFrameTime = performance.now();
        if (this._worldModeActive) this._startLoop();
    }

    handleContextLost() {
        this._contextLost = true;
        this._stopLoop();
        this.releaseVolatileCaches();
    }

    handleContextRestored() {
        this.ctx = this.canvas?.getContext?.('2d') || null;
        this._contextLost = false;
        this.invalidateViewportCaches();
        this.camera?.onViewportResize?.();
        this._lastFrameTime = performance.now();
        if (this._worldModeActive) this._startLoop();
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
        releaseCanvasMap(this.lightGradientCache);
        this.lightFadeColorCache?.clear?.();
        this.skyRenderer?.releaseCache?.();
        this.trailRenderer?.pause?.();
        this.weatherRenderer?.dispose?.();
    }

    _ensureTrailRenderer() {
        if (this.trailRenderer) return;
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            motionScale: this.motionScale,
        });
    }

    _reconcileSpritesWithWorld() {
        const liveIds = new Set(this.world?.agents?.keys?.() || []);
        for (const agentId of Array.from(this.agentSprites.keys())) {
            if (!liveIds.has(agentId)) this._removeAgentSprite(agentId);
        }
        for (const agent of this.world?.agents?.values?.() || []) {
            this._addAgentSprite(agent);
        }
        this._worldSpritesDirty = false;
    }

    _markSpritesDirty() {
        this._spritesNeedSort = true;
    }

    _snapshotSortedSprites() {
        if (!this._spritesNeedSort) return this._sortedSprites;
        const agents = Array.from(this.agentSprites.values());
        this._sortedSprites = agents;
        this._sortedSprites.sort((a, b) => a.y - b.y);
        this._spritesNeedSort = false;
        return this._sortedSprites;
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
            whole: this._cachedPropDepthDrawable(sprite),
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

    _cachedPropDepthDrawable(sprite, part = 'whole') {
        const kind = part === 'whole' ? 'prop' : `prop-${part}`;
        const sortY = part === 'back'
            ? sprite.propBackSortY()
            : part === 'front'
                ? sprite.propFrontSortY()
                : sprite.sortY ?? sprite.y;
        return createDepthDrawable(kind, sortY, { sprite, part }, (ctx, zoom, _context, payload) => {
            payload?.sprite?.drawCachedPart?.(ctx, payload.part || 'whole', zoom);
        });
    }

    _shouldUseFastStaticProps() {
        if ((this.camera?.zoom || 1) < FAST_PROP_MIN_ZOOM) return false;
        return canvasPixelCount(this.canvas) >= FAST_PROP_BACKING_PIXELS;
    }

    _enumerateFastPropDrawables() {
        const out = this._staticPropFastFrameDrawables;
        out.length = 0;
        const agents = this._snapshotSortedSprites();
        const viewport = this._screenViewport();
        for (const record of this._staticPropFastDrawables || []) {
            if (!this._propVisibleOnScreen(record.sprite, viewport)) continue;
            if (record.sprite?.splitForOcclusion && this._propIntersectsAgentBand(record.sprite, agents)) {
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

    setQuotaState(state) {
        const quota = state?.quota || state || null;
        this.quotaState = quota;
        this.buildingRenderer?.setQuotaState?.(quota);
        this.villageDirector?.setQuotaState?.(quota);
    }

    setCameraPose({ x, y, camX, camY, zoom } = {}) {
        if (!this.camera) return false;
        const nextZoom = Number(zoom);
        if (Number.isFinite(nextZoom) && nextZoom > 0) {
            this.camera.zoom = Math.max(this.camera.minZoom || 1, Math.min(this.camera.maxZoom || 3, nextZoom));
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

    // Frame the camera on the active agents (fallback: building centers, then
    // map core) so opening ClaudeVille in a small pane shows the live village
    // at a glance. Leaves the camera in auto-frame state until the user pans/zooms.
    frameContent() {
        if (!this.camera) return;
        const points = [];
        for (const sprite of this.agentSprites.values()) {
            if (Number.isFinite(sprite?.x) && Number.isFinite(sprite?.y)) {
                points.push({ x: sprite.x, y: sprite.y });
            }
        }
        if (points.length === 0 && this.world?.buildings) {
            for (const building of this.world.buildings.values()) {
                const center = buildingCenterToWorld(building);
                if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) {
                    points.push(center);
                }
            }
        }
        if (points.length === 0) {
            this.camera.centerOnMap();
            this.camera._userAdjusted = false;
            return;
        }
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        this.camera.fitToWorldBox({
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        });
        this.camera._userAdjusted = false;
    }

    _triggerReleaseParadeForVersion() {
        if (typeof document === 'undefined') return false;
        const version = document.querySelector('.topbar__version')?.textContent || '';
        return this.villageDirector?.triggerReleaseParadeOnceForVersion?.(version) || false;
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
        this.visitIntentManager?.update?.(agents, now);
        this.visitTileAllocator?.updateContext?.({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });
        // 3.13 — feed allocator occupancy into domain congestion state.
        // Building.updateVisitLoad emits 'building:congestion' on level
        // transitions; sprites read building.congestion directly per frame.
        const buildingLoads = this.visitTileAllocator?.snapshot?.()?.buildings;
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

        if (event.code === 'Tab') {
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
            this.camera.stopFollow();
            this.camera._userAdjusted = true;
            this.camera.x += delta.x / Math.max(0.1, this.camera.zoom || 1);
            this.camera.y += delta.y / Math.max(0.1, this.camera.zoom || 1);
            this.camera._clampToBounds?.();
            event.preventDefault();
            return;
        }

        if (event.code === 'Equal' || event.code === 'NumpadAdd') {
            if (this._zoomByKeyboard(1)) { this.camera._userAdjusted = true; event.preventDefault(); }
            return;
        }
        if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
            if (this._zoomByKeyboard(-1)) { this.camera._userAdjusted = true; event.preventDefault(); }
            return;
        }
        if (event.code === 'KeyF') {
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

    _isModalOpen() {
        return this.modal?.overlay?.style?.display === 'flex';
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
        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
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

    _addAgentSprite(agent) {
        const existing = this.agentSprites.get(agent.id);
        if (existing) {
            if (existing.applyAgentUpdate) existing.applyAgentUpdate(agent);
            else existing.agent = agent;
            if (this._isGateTransit(existing, 'departure')) {
                this.gateTransits.delete(agent.id);
                this._beginAgentGateArrival(agent, existing);
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
                allocateVisitTile: (request) => this._allocateVisitTile(request),
                releaseVisitReservation: (agentId) => this.visitTileAllocator?.release?.(agentId),
                renewVisitReservation: (agentId) => this.visitTileAllocator?.renew?.(agentId),
                getAmbientDestination: (request) => this._getAmbientDestination(request),
                getRoadTiles: () => this.pathTiles,
            });
            sprite.setMotionScale(this.motionScale);
            sprite.addedAt = performance.now();
            this._beginAgentGateArrival(agent, sprite);
            this.agentSprites.set(agent.id, sprite);
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

    /** 4.8 — seed a new sprite's nickname from its persisted biography. */
    _primeNickname(sprite) {
        if (!this.biographyService || !sprite?.agent) return;
        const identityKey = AgentBiography.identityKeyFor(sprite.agent);
        if (!identityKey) return;
        if (this._nicknames.has(identityKey)) {
            sprite.setNickname?.(this._nicknames.get(identityKey));
            return;
        }
        this.biographyService.getBiography(identityKey).then((biography) => {
            const nickname = biography?.nickname || null;
            if (!nickname) return;
            this._nicknames.set(identityKey, nickname);
            this.agentSprites.get(sprite.agent?.id)?.setNickname?.(nickname);
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
        const portalScreenPoint = this._tileToWorld(PORTAL_SPAWN_TILE.tileX, PORTAL_SPAWN_TILE.tileY);
        const started = parentSprite
            ? this.arrivalDeparture.beginSubagentDispatch(parentSprite, sprite, {
                now: performance.now(),
                portalScreenPoint,
            })
            : this.arrivalDeparture.beginAgentArrival(agent, sprite, { parentAlive: false, now: performance.now() });
        if (started || this.motionScale <= 0) {
            this.gateTransits.delete(agent.id);
            this._markSpritesDirty();
            return true;
        }
        return false;
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

        // Subagents step out of the Portal Gate toward their parent rather than
        // riding the carriage/boat arrival used for top-level sessions.
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
        sprite.walkToTile?.(
            VILLAGE_GATE.inside.tileX + this._gateJitter(agent, 'inside-x', 0.42),
            VILLAGE_GATE.inside.tileY + this._gateJitter(agent, 'inside-y', 0.28),
        );
        this.gateTransits.set(agent.id, { type: 'arrival' });
    }

    _beginAgentGateDeparture(agent) {
        const sprite = this.agentSprites.get(agent.id);
        if (!sprite || this.motionScale <= 0) {
            this._removeAgentSprite(agent.id);
            return;
        }

        sprite.selected = false;
        sprite.walkToTile?.(
            VILLAGE_GATE.outside.tileX + this._gateJitter(agent, 'depart-x', 0.30),
            VILLAGE_GATE.outside.tileY + this._gateJitter(agent, 'depart-y', 0.20),
        );
        this.gateTransits.set(agent.id, { type: 'departure' });
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
        const wantOpen = this.gateTransits.size > 0 || this._hasAgentNearGate();
        if (wantOpen) {
            this.gateDoorsOpen = true;
            this._gateDoorsOpenUntilMs = now + 1500; // 1.5s grace timer
            return;
        }
        if (now < this._gateDoorsOpenUntilMs) {
            this.gateDoorsOpen = true;
            return;
        }
        this.gateDoorsOpen = false;
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

    _loop() {
        if (!this.running) return;
        this.frameId = null;
        if (!this._worldModeActive || this._contextLost) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const now = performance.now();
        const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
        this._lastFrameTime = now;
        this._update(dt);
        this._render(dt);
        this._trackFps(now);
        this._startLoop();
    }

    // Emit a smoothed FPS reading roughly twice a second; TopBar renders it.
    _trackFps(now) {
        this._fpsFrames = (this._fpsFrames || 0) + 1;
        if (!this._fpsWindowStart) this._fpsWindowStart = now;
        const elapsed = now - this._fpsWindowStart;
        if (elapsed >= 500) {
            eventBus.emit('fps:updated', Math.round((this._fpsFrames * 1000) / elapsed));
            this._fpsFrames = 0;
            this._fpsWindowStart = now;
        }
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

    selectAgentById(agentId) {
        for (const sprite of this.agentSprites.values()) {
            sprite.selected = false;
        }
        if (agentId) {
            const sprite = this.agentSprites.get(agentId);
            if (sprite && !this._isGateTransit(sprite, 'departure')) {
                sprite.selected = true;
                this.selectedAgent = sprite.agent;
                this.camera.followAgent(sprite);
                return;
            }
        }
        this.selectedAgent = null;
        this.camera.stopFollow();
    }

    _update(dt = 16) {
        this.waterFrame += WATER_FRAME_STEP * this.motionScale;
        this._ritualSyncFrame = (this._ritualSyncFrame + 1) % 1000000;

        // Update camera follow
        if (this.camera) {
            this.camera.update(dt);
            this.camera.updateFollow(dt);
        }

        // Chat matching only depends on session/tool state, not frame-perfect motion.
        this._chatMatchAccumulator += dt;
        if (this._chatMatchAccumulator >= 250) {
            this._chatMatchAccumulator = 0;
            this._updateChatMatching();
            this.agentEventStream?.reconcileChatPairs?.(this.agentSprites);
        }
        const now = performance.now();
        const chronicleNow = Date.now();
        const agents = this._updateVisitSystems(chronicleNow);
        this.relationshipState?.update?.({ agentSprites: this.agentSprites, now });
        applyTeamPlazaPreferences(this.relationshipState, this.agentSprites);
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

        // Update agent sprites
        let shouldResort = false;
        const completedDepartures = [];
        for (const sprite of this.agentSprites.values()) {
            sprite.update(this.particleSystem, dt);
            const transit = this.gateTransits.get(sprite.agent?.id);
            if (transit && !sprite.moving && sprite.hasReachedTarget?.()) {
                if (transit.type === 'departure') {
                    completedDepartures.push(sprite.agent.id);
                } else {
                    this.gateTransits.delete(sprite.agent.id);
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
        this._stationaryOverlapAccumulator += dt;
        if (this._stationaryOverlapAccumulator >= 420) {
            this._stationaryOverlapAccumulator = 0;
            this._resolveStationaryOverlaps();
        }

        const sortedSnapshot = this._snapshotSortedSprites();
        this._replayActiveToolRituals();
        this.ritualConductor?.update?.(dt);
        this._syncToolRitualPoses();

        this.harborTraffic?.update(agents, dt);
        this.landmarkActivity?.update(agents, sortedSnapshot, dt);
        const updateNow = Date.now();
        const failedPushState = this.harborTraffic?.getFailedPushState?.(updateNow) || null;
        const activeWorkingCount = agents.filter(agent => agent?.status === AgentStatus.WORKING).length;
        this.villageDirector?.setHarborState?.(failedPushState);
        this.villageDirector?.update?.(this, dt, updateNow);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(sortedSnapshot);
        this.buildingRenderer?.setHarborStatus?.({
            failedPushActive: Boolean(failedPushState?.hasFailedPush),
            activeWorkingCount,
        });
        this.buildingRenderer?.update(dt);
        this._updateAmbientEffects(dt);

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
        if (this._chronicleUpdating) return;
        this._chronicleUpdating = true;
        const agents = Array.from(this.world?.agents?.values?.() || []);
        const context = {
            waterTiles: this.waterTiles,
            blockedTiles: this._monumentBlockedTiles(),
        };
        Promise.allSettled([
            this.chronicleMonuments?.update?.(agents, context, now),
            this.trailRenderer?.update?.(agents, now, this._lastAtmosphere),
        ]).finally(() => {
            this._chronicleUpdating = false;
        });
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

    _isSpritePositionWalkable(sprite, x, y) {
        if (!this.pathfinder || typeof sprite?._screenToTile !== 'function') return true;
        const tile = sprite._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY));
    }

    _buildLaneTileIndex() {
        const lanes = new Map();
        if (!this.pathTiles?.size) return lanes;
        for (const key of this.pathTiles) {
            if (!this._isRoadLikeTileKey(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const axis = this._bestRoadAxis(tile.tileX, tile.tileY);
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
            const nextX = sprite.x + lane.perpX * step;
            const nextY = sprite.y + lane.perpY * step;
            if (!this._isSpritePositionWalkable(sprite, nextX, nextY)) continue;
            sprite.x = nextX;
            sprite.y = nextY;
            sprite._laneDiscipline = { tileKey: lane.tileKey, side, offsetPx: desiredOffset };
            corrections++;
        }
        if (corrections > 0) {
            this._localAvoidanceMetrics.laneCorrections += corrections;
            this._markSpritesDirty();
        }
    }

    _applyLocalAvoidance(movingSprites, dt = 16) {
        if (!movingSprites?.length) return;
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
            const nextAx = a.x + nx * overlap * strength;
            const nextAy = a.y + ny * overlap * strength;
            const nextBx = b.x - nx * overlap * strength;
            const nextBy = b.y - ny * overlap * strength;

            let moved = false;
            if (this._isSpritePositionWalkable(a, nextAx, nextAy)) {
                a.x = nextAx;
                a.y = nextAy;
                moved = true;
            }
            if (this._isSpritePositionWalkable(b, nextBx, nextBy)) {
                b.x = nextBx;
                b.y = nextBy;
                moved = true;
            }
            if (moved) {
                pushes++;
                this._emitCrowdBumpFeedback(a, b, overlap);
            }
            return true;
        });
        if (pushes > 0) {
            this._localAvoidanceMetrics.separationPushes += pushes;
            this._markSpritesDirty();
        }
        if (zeroDistancePairs > 0) {
            this._localAvoidanceMetrics.zeroDistancePairs += zeroDistancePairs;
        }
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
            if (dist <= 0 || dist >= threshold) return true;
            const aSnap = a.getBehaviorDebugSnapshot?.();
            const bSnap = b.getBehaviorDebugSnapshot?.();
            const sameBuilding = aSnap?.building && aSnap.building === bSnap?.building;
            if (!sameBuilding && dist > 14) return true;
            const loser = (aSnap?.behavior?.lastRerouteAt || 0) <= (bSnap?.behavior?.lastRerouteAt || 0) ? a : b;
            if (loser.retargetVisit?.()) {
                retargets++;
                this.behaviorMetrics.stationaryRetargets++;
            }
            return retargets < maxRetargets;
        });
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

    _emitCrowdBumpFeedback(a, b, overlap = 0) {
        const now = performance.now();
        const key = [a.agent?.id || a.x, b.agent?.id || b.x].sort().join('|');
        if ((this._crowdBumpCooldowns.get(key) || 0) > now) return;
        this._crowdBumpCooldowns.set(key, now + 650);
        a.bumpFlash = Math.max(a.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        b.bumpFlash = Math.max(b.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        if (this.motionScale > 0) {
            this.particleSystem.spawn('crowdBump', (a.x + b.x) / 2, (a.y + b.y) / 2 + 6, 2);
        }
    }

    _updateAmbientEffects(dt = 16) {
        if (!this.motionScale || this.ambientEmitters.length === 0) return;

        const maxParticles = this.particleSystem.maxParticles || 240;
        const activeParticles = this.particleSystem.particles.length || 0;
        if (activeParticles > maxParticles - 40) return;

        const particleBudget = Math.max(0.22, 1 - activeParticles / maxParticles);
        let spawned = 0;
        const now = performance.now();
        for (const emitter of this.ambientEmitters) {
            // Active-building emitters use interval timing and
            // are not subject to the single-spawn-per-frame cap below.
            if (emitter.gatedBy === ACTIVE_BUILDING_EMITTER_GATE) {
                const presence = emitter.building
                    ? this._buildingPresenceMap?.get(emitter.building)
                    : null;
                const tier = presence?.tier;
                if (tier !== 'occupied' && tier !== 'busy') continue;
                const interval = Math.max(120, emitter.intervalMs || 600);
                const last = this._emitterIntervalLastMs.get(emitter) || 0;
                if (now - last < interval) continue;
                this._emitterIntervalLastMs.set(emitter, now);
                const yOffset = Number.isFinite(emitter.worldYOffset) ? emitter.worldYOffset : -18;
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y + yOffset, 1);
                continue;
            }

            if (spawned >= 1) continue;
            const localBudget = this._ambientEmitterBudget(emitter);
            const frameScale = Math.max(0, Math.min(3, dt / 16));
            const chance = 1 - Math.pow(1 - Math.max(0, Math.min(1, emitter.chance * particleBudget * localBudget)), frameScale);
            if (Math.random() < chance) {
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y - 18, 1);
                spawned++;
            }
        }
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
            this.particleSystem.spawn('rainSplash', sprite.x, sprite.y + 7, 1, { spread: 5 });
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
        renderWorldFrame(this, dt);
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

    _agentRenderMode(viewport = this._screenViewport(), sprites = this._snapshotSortedSprites()) {
        const count = sprites?.length || 0;
        if (count < 50) return 'full';
        const zoom = this.camera?.zoom || 1;
        const cssPixels = Math.max(0, (viewport?.width || 0) * (viewport?.height || 0));
        const backingPixels = canvasPixelCount(this.canvas);
        if (
            count >= AGENT_RENDER_MINIMAL_COUNT &&
            (cssPixels >= AGENT_RENDER_MINIMAL_CSS_PIXELS || backingPixels >= AGENT_RENDER_MINIMAL_CANVAS_PIXELS)
        ) {
            return 'minimal';
        }
        if (
            count >= AGENT_RENDER_COMPACT_COUNT &&
            (zoom <= AGENT_RENDER_COMPACT_ZOOM ||
                cssPixels >= AGENT_RENDER_COMPACT_CSS_PIXELS ||
                backingPixels >= AGENT_RENDER_COMPACT_CANVAS_PIXELS)
        ) {
            return 'compact';
        }
        return 'full';
    }

    _assignAgentOverlaySlots(sprites, zoom = this.camera?.zoom || 1, { agentRenderMode = 'full' } = {}) {
        if (agentRenderMode === 'minimal') {
            for (const sprite of sprites) {
                sprite.overlaySlot = null;
                sprite.nameTagSlot = sprite.selected ? 0 : null;
                sprite.labelAlpha = this._agentLabelAlpha(sprite, zoom);
            }
            return;
        }

        const compactOccupied = [];
        const nameOccupied = [];
        const compactLabelCap = agentRenderMode === 'compact' ? 36 : Infinity;
        let compactLabels = 0;
        const prioritized = sprites
            .filter((sprite) => sprite.agent)
            .sort((a, b) => this._agentLabelPriority(b) - this._agentLabelPriority(a));

        for (const sprite of prioritized) {
            if (!sprite.agent) continue;

            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;
            sprite.labelAlpha = this._agentLabelAlpha(sprite, zoom);

            if (sprite.selected) {
                compactOccupied.push(this._agentCompactSlotRect(sprite, 0));
                nameOccupied.push(this._agentNameSlotRect(sprite, 0));
                sprite.overlaySlot = 0;
                sprite.nameTagSlot = 0;
                compactLabels++;
                continue;
            }

            let compactSlot = 0;
            while (compactSlot < 4 && compactOccupied.some((item) => this._rectsOverlap(this._agentCompactSlotRect(sprite, compactSlot), item))) {
                compactSlot++;
            }
            if (compactSlot >= 4 || compactLabels >= compactLabelCap) {
                sprite.overlaySlot = null;
            } else {
                sprite.overlaySlot = compactSlot;
                compactOccupied.push(this._agentCompactSlotRect(sprite, compactSlot));
                compactLabels++;
            }

            if (agentRenderMode !== 'full' || zoom < 3) {
                if (sprite.overlaySlot === null) continue;
                sprite.nameTagSlot = null;
                continue;
            }

            let nameSlot = 0;
            while (nameSlot < 7 && nameOccupied.some((item) => this._rectsOverlap(this._agentNameSlotRect(sprite, nameSlot), item))) {
                nameSlot++;
            }
            if (nameSlot >= 7) {
                sprite.nameTagSlot = null;
            } else {
                sprite.nameTagSlot = nameSlot;
                nameOccupied.push(this._agentNameSlotRect(sprite, nameSlot));
            }
        }
    }

    _agentLabelPriority(sprite) {
        if (sprite.selected) return 1000;
        const status = sprite.agent?.status;
        const age = performance.now() - (sprite.addedAt || 0);
        const recentSpawn = age >= 0 && age < 12000;
        if (status === AgentStatus.WORKING && recentSpawn) return 760;
        if (recentSpawn) return 620;
        if (status === AgentStatus.WORKING) return 520;
        if (status === AgentStatus.WAITING) return 360;
        return 120;
    }

    _agentLabelAlpha(sprite, zoom) {
        return 1;
    }

    _collectAgentLabelHitRects(sprites) {
        const zoom = this.camera?.zoom || 1;
        const out = [];
        for (const sprite of sprites) {
            if (!sprite.agent) continue;

            const usesNameTag = (sprite.selected || zoom >= 3) && sprite.nameTagSlot != null;
            if (usesNameTag) {
                out.push(this._agentNameSlotRect(sprite, sprite.nameTagSlot || 0));
                continue;
            }
            if (sprite.overlaySlot == null) continue;
            out.push(this._agentCompactSlotRect(sprite, sprite.overlaySlot || 0));
        }
        return out;
    }

    _agentImpostorSlotRect(sprite) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const halfW = 11 * s;
        const halfH = 13 * s;
        return {
            x: sprite.x - halfW,
            y: sprite.y - 17 * s,
            w: halfW * 2,
            h: halfH * 2,
        };
    }

    _agentCompactSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const offsetX = sprite.x;
        const offsetY = sprite.y + (AGENT_COMPACT_NAME_SLOT_BASE_Y + slot * AGENT_COMPACT_NAME_SLOT_STEP_Y) * s;
        const pad = 2 * s;
        const halfW = (this._estimateCompactNameTagWidth(sprite) / 2) * s;
        const halfH = (AGENT_COMPACT_NAME_HEIGHT / 2) * s;
        return {
            x: offsetX - halfW - pad,
            y: offsetY - halfH - pad,
            w: halfW * 2 + pad * 2,
            h: halfH * 2 + pad * 2,
        };
    }

    _agentNameSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const offsetY = sprite.y + (38 + this._nameTagSlotYOffset(slot)) * s;
        const anchorX = sprite.x;
        const pad = 2 * s;
        const width = this._estimateNameTagWidth(sprite) * s;
        const height = this._estimateNameTagHeight(sprite) * s;
        return {
            x: anchorX - width / 2 - pad,
            y: offsetY - height / 2 - pad,
            w: width + pad * 2,
            h: height + pad * 2,
            slot,
        };
    }

    _nameTagSlotYOffset(slot) {
        const offsets = [0, -10, 10, -18, 18, -26, 26, -34];
        return offsets[Math.min(slot, offsets.length - 1)];
    }

    _estimateNameTagWidth(sprite) {
        const baseName = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        // Match the real pill: nickname renders as a suffix on the full tag.
        const fullName = sprite.nickname ? `${baseName} ${sprite.nickname}` : baseName;
        const rawLen = Math.min(fullName.length, 28);
        return Math.min(
            AGENT_NAME_TAG_MAX_WIDTH,
            Math.max(AGENT_NAME_TAG_MIN_WIDTH, rawLen * AGENT_NAME_TAG_CHAR_WIDTH + AGENT_NAME_TAG_PADDING_X),
        );
    }

    _estimateNameTagHeight(sprite) {
        const baseName = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        const fullName = sprite.nickname ? `${baseName} ${sprite.nickname}` : baseName;
        // The real pill wraps to two lines once it exceeds ~MAX_WIDTH (≈21 chars
        // at 7px/char), matching AgentSprite._nameTagLayout.
        const lines = fullName.length > 21 ? 2 : 1;
        return lines === 1 ? AGENT_NAME_TAG_SINGLE_HEIGHT : AGENT_NAME_TAG_DOUBLE_HEIGHT;
    }

    _estimateCompactNameTagWidth(sprite) {
        const name = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        const rawLen = Math.min(name.length, 24);
        return Math.min(
            AGENT_COMPACT_NAME_MAX_WIDTH,
            Math.max(AGENT_COMPACT_NAME_MIN_WIDTH, rawLen * AGENT_COMPACT_NAME_CHAR_WIDTH + AGENT_COMPACT_NAME_EXTRA_WIDTH),
        );
    }

    _rectsOverlap(a, b) {
        return a.x < b.x + b.w
            && a.x + a.w > b.x
            && a.y < b.y + b.h
            && a.y + a.h > b.y;
    }

    _drawTerrain(ctx) {
        SpriteRenderer.disableSmoothing(ctx);
        const cached = this._getTerrainCache();
        if (cached) {
            ctx.drawImage(cached.canvas, cached.bounds.x, cached.bounds.y, cached.bounds.w, cached.bounds.h);
        } else {
            this._drawStaticTerrainSurface(ctx);
        }
        this._drawDynamicWaterHighlights(ctx);
        this._drawWeatherPuddles(ctx);
        this._drawStaticBuildingSmoke(ctx);
    }

    // Static fallback: when motionScale === 0 the particle system is disabled,
    // so we draw a single deterministic puff per occupied building.
    _drawStaticBuildingSmoke(ctx) {
        if (this.motionScale > 0) return;
        if (!this.ambientEmitters?.length) return;
        ctx.save();
        for (const emitter of this.ambientEmitters) {
            if (emitter.gatedBy !== ACTIVE_BUILDING_EMITTER_GATE) continue;
            const presence = emitter.building
                ? this._buildingPresenceMap?.get(emitter.building)
                : null;
            const tier = presence?.tier;
            if (tier !== 'occupied' && tier !== 'busy') continue;
            const yOffset = Number.isFinite(emitter.worldYOffset) ? emitter.worldYOffset : -18;
            const cx = emitter.x;
            const cy = emitter.y + yOffset;
            ctx.globalAlpha = tier === 'busy' ? 0.40 : 0.28;
            ctx.fillStyle = '#888888';
            ctx.beginPath();
            ctx.ellipse(cx, cy, 6, 3.2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha *= 0.6;
            ctx.beginPath();
            ctx.ellipse(cx + 2, cy - 4, 4.5, 2.4, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _getVisibleTileBounds(margin = 5) {
        return this.camera.getViewportTileBounds(margin);
    }

    _getTerrainCache() {
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
        const key = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}@${dpr}|${this.assets ? 'assets' : 'fallback'}`;
        if (this.terrainCache && this.terrainCacheKey === key) {
            return { canvas: this.terrainCache, bounds };
        }

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

    _drawStaticTerrainSurface(ctx) {
        const previousMotionScale = this.motionScale;
        try {
            this.motionScale = 0;
            this._drawDioramaBackdrop(ctx);
            this._drawWorldBaseShadow(ctx);

            for (let y = 0; y < MAP_SIZE; y++) {
                for (let x = 0; x < MAP_SIZE; x++) {
                    this._drawTile(ctx, x, y);
                }
            }

            this._drawOpenWaterDepthWash(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawStaticOpenSeaStructure(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawDistrictAtmosphere(ctx);
            this._drawRiverContourLines(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawWaterFoamLines(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawOpenSeaSurfBreaks(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawLandmarkBridgeSpans(ctx);
            this._drawAmbientGroundProps(ctx);
            this._drawWorldEdgeRim(ctx);
        } finally {
            this.motionScale = previousMotionScale;
        }
    }

    _buildDistrictPropSprites() {
        if (!this.sprites) return [];
        const sprites = this._buildVillageWallSprites();
        sprites.push(new StaticPropSprite({
            tileX: VILLAGE_GATE.tileX,
            tileY: VILLAGE_GATE.tileY,
            id: VILLAGE_GATE.id,
            bounds: VILLAGE_GATE_BOUNDS,
            splitForOcclusion: true,
            drawFn: (ctx, x, y) => this._drawVillageGatehouse(ctx, x, y),
        }));
        sprites.push(...this._buildVillageWallTerminalSprites());
        sprites.push(...this._buildWatchtowerBeaconBuoySprites());
        sprites.push(...DISTRICT_PROPS
            .filter((prop) => prop.layer === 'sorted')
            .filter((prop) => !this.scenery.isBlockedForTallScenery(prop.tileX, prop.tileY, this.pathTiles, this.bridgeTiles))
            .map((prop) => {
                const dims = this.assets?.getDims?.(prop.id);
                return new StaticPropSprite({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    id: prop.id,
                    bounds: this._assetPropBounds(prop.id),
                    splitForOcclusion: Boolean(dims && dims.h >= 56),
                    drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, prop.id, x, y),
                });
            }));
        return sprites;
    }

    _buildVillageWallSprites() {
        const out = [];
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
                out.push(new StaticPropSprite({
                    tileX: midTile.tileX,
                    tileY: midTile.tileY,
                    id: `village.wall.${route.id}.${i}`,
                    bounds: wallBounds,
                    splitForOcclusion: false,
                    sortY: Math.max(start.y, end.y) - 14,
                    drawFn: (ctx, x, y) => {
                        const isLastSegment = i === route.points.length - 2;
                        const isFirstSegment = i === 0;
                        let footingExtent = null;
                        if (route.id === 'west' && isLastSegment) {
                            footingExtent = { side: 'end', distance: 30, dither: 32 };
                        } else if (route.id === 'east' && isFirstSegment) {
                            footingExtent = { side: 'start', distance: 24, dither: 32 };
                        }
                        this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i, footingExtent);
                    },
                }));
            }
        }
        return out;
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
        return [new StaticPropSprite({
            tileX: towerTile.tileX,
            tileY: towerTile.tileY,
            id: VILLAGE_WALL_SEA_TOWER_SPRITE_ID,
            bounds: this._assetPropBounds(VILLAGE_WALL_SEA_TOWER_SPRITE_ID, 0.66),
            splitForOcclusion: true,
            sortY: world.y - 8,
            drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, VILLAGE_WALL_SEA_TOWER_SPRITE_ID, x, y),
        })];
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

    _drawVillageGatehouse(ctx, originX, originY) {
        const centerTileX = VILLAGE_GATE.tileX;
        const tileY = VILLAGE_GATE.tileY;
        const halfWidth = VILLAGE_GATE.widthTiles / 2;
        const towerHalf = 3.18;
        const sideStubInset = 0.3;
        const center = this._tileToWorld(centerTileX, tileY);
        const localPoint = (tileX) => {
            const p = this._tileToWorld(tileX, tileY);
            return { x: p.x - center.x, y: p.y - center.y };
        };
        const leftEnd = localPoint(centerTileX - halfWidth);
        const leftInner = localPoint(centerTileX - towerHalf - sideStubInset);
        const rightInner = localPoint(centerTileX + towerHalf + sideStubInset);
        const rightEnd = localPoint(centerTileX + halfWidth);
        const leftTower = localPoint(centerTileX - towerHalf);
        const rightTower = localPoint(centerTileX + towerHalf);

        this._drawVillageWallSegment(ctx, originX, originY, leftEnd, leftInner, 0);
        this._drawVillageWallSegment(ctx, originX, originY, rightInner, rightEnd, 1);

        const leftBase = { x: originX + leftTower.x, y: originY + leftTower.y };
        const rightBase = { x: originX + rightTower.x, y: originY + rightTower.y };
        this._drawVillageGateThreshold(ctx, leftBase, rightBase);
        this._drawVillageGateTower(ctx, leftBase.x, leftBase.y, -1);
        this._drawVillageGateTower(ctx, rightBase.x, rightBase.y, 1);
        this._drawVillageGateArch(ctx, leftBase, rightBase);
        this._drawVillageGateDoors(ctx, leftBase, rightBase);
        this._drawGateBrazier(ctx, leftBase.x - 9, leftBase.y + 13);
        this._drawGateBrazier(ctx, rightBase.x + 9, rightBase.y + 13);
    }

    _drawVillageGateThreshold(ctx, leftBase, rightBase) {
        // Threshold is now painted by the road tile renderer via the gate-avenue
        // route in townPlan.js. Tower foot shadows are drawn inside
        // _drawVillageGateTower. This method is intentionally a no-op; the
        // call site in _drawVillageGatehouse is kept for future hooks.
    }

    // Iron fire-basket flanking the gate mouth — frames the coastal gate with
    // warm light. Gentle flicker when motion is on; steady under reduced motion.
    _drawGateBrazier(ctx, x, y) {
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.fillStyle = '#3a2a1a';
        ctx.fillRect(Math.round(x - 2), Math.round(y - 18), 4, 18);
        ctx.fillStyle = '#4a4a52';
        ctx.beginPath();
        ctx.moveTo(Math.round(x - 7), Math.round(y - 18));
        ctx.lineTo(Math.round(x + 7), Math.round(y - 18));
        ctx.lineTo(Math.round(x + 4), Math.round(y - 24));
        ctx.lineTo(Math.round(x - 4), Math.round(y - 24));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#1a1410';
        ctx.lineWidth = 1;
        ctx.stroke();
        const flick = this.motionScale ? (Math.sin(this.waterFrame * 3.2 + x) * 0.5 + 0.5) : 0.5;
        const fh = 10 + flick * 5;
        ctx.fillStyle = 'rgba(255, 140, 36, 0.96)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x - 5), Math.round(y - 24));
        ctx.lineTo(Math.round(x), Math.round(y - 24 - fh));
        ctx.lineTo(Math.round(x + 5), Math.round(y - 24));
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 224, 130, 0.96)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x - 2.5), Math.round(y - 24));
        ctx.lineTo(Math.round(x), Math.round(y - 24 - fh * 0.6));
        ctx.lineTo(Math.round(x + 2.5), Math.round(y - 24));
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(x, y - 26, 2, x, y - 26, 34);
        glow.addColorStop(0, 'rgba(255, 175, 75, 0.50)');
        glow.addColorStop(1, 'rgba(255, 175, 75, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(Math.round(x - 36), Math.round(y - 60), 72, 72);
        ctx.restore();
    }

    _drawVillageGateTower(ctx, x, y, side = 1) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const w = 64;
        const hStone = 64;
        const hWood = 42;
        const roofH = 36;
        const outward = side >= 0 ? 1 : -1;
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Foot shadow (single ellipse, integrated with threshold)
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = stone.outline;
        ctx.beginPath();
        ctx.ellipse(Math.round(x), Math.round(y + 14), w / 2 + 14, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Side face peek (3D depth on outward side, stone material)
        const sideDepth = 14 * outward;
        const sideDrop = 8;
        const stoneTop = y - hStone;
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };

        if (outward > 0) {
            trace(
                { x: x + w / 2, y: stoneTop },
                { x: x + w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x + w / 2 + sideDepth, y: y + sideDrop },
                { x: x + w / 2, y },
            );
        } else {
            trace(
                { x: x - w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x - w / 2, y: stoneTop },
                { x: x - w / 2, y },
                { x: x - w / 2 + sideDepth, y: y + sideDrop },
            );
        }
        ctx.fillStyle = stone.shadow;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Stone foundation front face — solid base with mortared courses
        const stoneLeft = x - w / 2;
        const stoneRight = x + w / 2;
        ctx.fillStyle = stone.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Mottled stone blocks (light/mid alternation)
        const courseH = 16;
        for (let row = 0; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = -offset; col < w; col += 24) {
                const sx = stoneLeft + col;
                const ex = Math.min(stoneLeft + col + 24, stoneRight);
                if (ex <= stoneLeft) continue;
                const seed = this._tileNoise(row * 13 + 7, col + side * 31);
                ctx.fillStyle = seed > 0.55 ? stone.light : stone.shadow;
                ctx.fillRect(Math.round(Math.max(stoneLeft, sx)), Math.round(rowY),
                             Math.round(ex - Math.max(stoneLeft, sx)), courseH);
            }
        }

        // Mortar lines (horizontal courses)
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        for (let row = 1; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            ctx.beginPath();
            ctx.moveTo(Math.round(stoneLeft), Math.round(rowY));
            ctx.lineTo(Math.round(stoneRight), Math.round(rowY));
            ctx.stroke();
        }

        // Mortar verticals (offset per course for brick-like pattern)
        for (let row = 0; row < 4; row++) {
            const rowY1 = stoneTop + row * courseH;
            const rowY2 = rowY1 + courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = 24 - offset; col < w; col += 24) {
                const cx = stoneLeft + col;
                ctx.beginPath();
                ctx.moveTo(Math.round(cx), Math.round(rowY1));
                ctx.lineTo(Math.round(cx), Math.round(rowY2));
                ctx.stroke();
            }
        }

        // Re-stroke perimeter to keep outline crisp
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Archer slit centered on stone front
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(stoneTop + hStone / 2 - 11), 8, 22);

        // Moss tuft at base
        ctx.fillStyle = stone.moss;
        ctx.fillRect(Math.round(stoneRight - 18), Math.round(y - 4), 14, 4);
        ctx.fillRect(Math.round(stoneLeft + 4), Math.round(y - 4), 10, 3);

        // Floor band — visible structural transition between stone and wood
        const woodTop = stoneTop - hWood;
        const bandH = 6;
        ctx.fillStyle = wood.deep;
        ctx.fillRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);

        // Wood-frame upper — vertical planks matching wall plank rule
        ctx.fillStyle = wood.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);

        // Plank lines (vertical)
        ctx.strokeStyle = '#2c190d';
        ctx.lineWidth = 1;
        for (let plank = stoneLeft + 8; plank < stoneRight; plank += 12) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Highlight planks (subtle warm streaks)
        ctx.strokeStyle = 'rgba(214, 151, 78, 0.4)';
        for (let plank = stoneLeft + 14; plank < stoneRight; plank += 24) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Narrow window slit in wood
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(woodTop + 10), 8, 16);

        // Eave shadow under roof
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, 3);

        // Teal pitched roof — front gable
        const roofLeft = stoneLeft - 8;
        const roofRight = stoneRight + 8;
        const ridgeY = woodTop - roofH;
        trace(
            { x: roofLeft, y: woodTop },
            { x: x, y: ridgeY },
            { x: roofRight, y: woodTop },
        );
        ctx.fillStyle = wood.teal;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Roof shadow side (the half away from the light)
        const lightSide = outward > 0 ? -1 : 1; // light comes from the inward side
        if (lightSide < 0) {
            trace(
                { x: roofLeft, y: woodTop },
                { x: x, y: ridgeY },
                { x: x, y: woodTop },
            );
        } else {
            trace(
                { x: x, y: ridgeY },
                { x: roofRight, y: woodTop },
                { x: x, y: woodTop },
            );
        }
        ctx.fillStyle = 'rgba(20, 63, 67, 0.46)';
        ctx.fill();

        // Ridge highlight
        ctx.strokeStyle = wood.tealLight;
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.round(x), Math.round(ridgeY + 2));
            ctx.lineTo(Math.round(x + i * 8), Math.round(woodTop - 4));
            ctx.stroke();
        }

        // Ridge cap accent
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 2), Math.round(ridgeY - 4), 4, 6);

        ctx.restore();
    }

    _drawVillageGateArch(ctx, leftBase, rightBase) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const lintelInset = 22;
        const lintelHeight = 26;
        const start = { x: leftBase.x + ux * lintelInset, y: leftBase.y + uy * lintelInset - 110 };
        const end = { x: rightBase.x - ux * lintelInset, y: rightBase.y - uy * lintelInset - 110 };
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Lintel main beam
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };
        trace(
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
            { x: end.x, y: end.y + lintelHeight },
            { x: start.x, y: start.y + lintelHeight },
        );
        ctx.fillStyle = wood.mid;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Top edge highlight
        ctx.strokeStyle = wood.cut;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + 1));
        ctx.stroke();

        // Bottom shadow line
        ctx.strokeStyle = '#3f2412';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + lintelHeight - 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + lintelHeight - 1));
        ctx.stroke();

        // Iron straps (two evenly spaced)
        ctx.fillStyle = '#2c190d';
        for (const t of [0.32, 0.68]) {
            const sx = start.x + (end.x - start.x) * t;
            const sy = start.y + (end.y - start.y) * t;
            ctx.fillRect(Math.round(sx - 1.5), Math.round(sy), 3, lintelHeight);
        }

        // Corbel brackets at each end (carved support pieces)
        for (const corbel of [
            { x: start.x, dir: 1 },
            { x: end.x, dir: -1 },
        ]) {
            const cy = start.y + lintelHeight;
            trace(
                { x: corbel.x, y: cy },
                { x: corbel.x, y: cy + 12 },
                { x: corbel.x + corbel.dir * 12, y: cy },
            );
            ctx.fillStyle = wood.deep;
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Plaque mounted on the lintel
        const plaqueWidth = Math.min(96, length * 0.42);
        const plaqueHeight = 14;
        const plaqueY = start.y + lintelHeight + 2;
        ctx.fillStyle = wood.deep;
        ctx.fillRect(Math.round(mid.x - plaqueWidth / 2), Math.round(plaqueY), plaqueWidth, plaqueHeight);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(mid.x - plaqueWidth / 2), Math.round(plaqueY), plaqueWidth, plaqueHeight);
        // Plaque text
        ctx.fillStyle = wood.cut;
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CLAUDEVILLE', Math.round(mid.x), Math.round(plaqueY + plaqueHeight / 2 + 1));

        // Hanging chain
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(mid.x), Math.round(plaqueY + plaqueHeight));
        ctx.lineTo(Math.round(mid.x), Math.round(plaqueY + plaqueHeight + 14));
        ctx.stroke();

        // Iron lantern body
        const lanternX = mid.x;
        const lanternY = plaqueY + plaqueHeight + 14;
        ctx.fillStyle = '#2c190d';
        ctx.fillRect(Math.round(lanternX - 7), Math.round(lanternY), 14, 16);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.round(lanternX - 7), Math.round(lanternY), 14, 16);
        // Lantern flame core
        ctx.fillStyle = wood.lantern;
        ctx.fillRect(Math.round(lanternX - 4), Math.round(lanternY + 3), 8, 10);
        // Lantern bars
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(lanternX), Math.round(lanternY));
        ctx.lineTo(Math.round(lanternX), Math.round(lanternY + 16));
        ctx.moveTo(Math.round(lanternX - 7), Math.round(lanternY + 8));
        ctx.lineTo(Math.round(lanternX + 7), Math.round(lanternY + 8));
        ctx.stroke();
        // Glow halo
        ctx.fillStyle = wood.glow;
        ctx.beginPath();
        ctx.ellipse(Math.round(lanternX), Math.round(lanternY + 8), 22, 12, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _drawVillageGateDoors(ctx, leftBase, rightBase) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const lintelInset = 22;
        const lintelHeight = 26;
        const doorTopPad = 2;
        const doorBottomLift = 14;

        // Lintel-aligned anchors (must match _drawVillageGateArch math exactly).
        const lintelStart = { x: leftBase.x + ux * lintelInset, y: leftBase.y + uy * lintelInset - 110 };
        const lintelEnd = { x: rightBase.x - ux * lintelInset, y: rightBase.y - uy * lintelInset - 110 };

        // Door corners: trapezoid following the iso slope.
        const tl = { x: lintelStart.x, y: lintelStart.y + lintelHeight + doorTopPad };
        const tr = { x: lintelEnd.x, y: lintelEnd.y + lintelHeight + doorTopPad };
        const bl = { x: lintelStart.x, y: leftBase.y - doorBottomLift };
        const br = { x: lintelEnd.x, y: rightBase.y - doorBottomLift };
        const tc = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
        const bc = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
        const isoAngle = Math.atan2(uy, ux);

        const trace = (...pts) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(pts[0].x), Math.round(pts[0].y));
            for (const p of pts.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };
        const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        if (this.gateDoorsOpen) {
            // Open state: thin strips tucked against the inner jambs.
            const tuck = 7;
            // Left leaf strip: along the left edge of the opening.
            trace(
                tl,
                { x: tl.x + ux * tuck, y: tl.y + uy * tuck },
                { x: bl.x + ux * tuck, y: bl.y + uy * tuck },
                bl,
            );
            ctx.fillStyle = '#2c190d';
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            // Right leaf strip.
            trace(
                { x: tr.x - ux * tuck, y: tr.y - uy * tuck },
                tr,
                br,
                { x: br.x - ux * tuck, y: br.y - uy * tuck },
            );
            ctx.fillStyle = '#2c190d';
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.2;
            ctx.stroke();

            // Warm interior glow at the threshold midline (rotated with the iso slope).
            const glowRadius = Math.max(8, length / 2 - lintelInset);
            ctx.fillStyle = wood.glow;
            ctx.beginPath();
            ctx.ellipse(Math.round(bc.x), Math.round(bc.y), glowRadius, 16, isoAngle, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 212, 142, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(bc.x), Math.round(bc.y - 6),
                Math.max(6, glowRadius - 4), 10, isoAngle, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Closed state: two trapezoidal leaves following the iso slope.
            trace(tl, tc, bc, bl);
            ctx.fillStyle = '#3f2412';
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            trace(tc, tr, br, bc);
            ctx.fillStyle = '#3f2412';
            ctx.fill();
            ctx.stroke();

            // Iron bands at vertical fractions, sloping with the iso projection.
            ctx.strokeStyle = '#2c190d';
            ctx.lineWidth = 3;
            for (const t of [0.22, 0.78]) {
                const bandLeft = lerp(tl, bl, t);
                const bandRight = lerp(tr, br, t);
                ctx.beginPath();
                ctx.moveTo(Math.round(bandLeft.x), Math.round(bandLeft.y));
                ctx.lineTo(Math.round(bandRight.x), Math.round(bandRight.y));
                ctx.stroke();
            }

            // Plank lines per leaf, sloping with the door axis.
            ctx.strokeStyle = '#2c190d';
            ctx.lineWidth = 0.6;
            // Left leaf planks
            for (const f of [0.25, 0.5, 0.75]) {
                const plankTop = lerp(tl, tc, f);
                const plankBot = lerp(bl, bc, f);
                ctx.beginPath();
                ctx.moveTo(Math.round(plankTop.x), Math.round(plankTop.y + 2));
                ctx.lineTo(Math.round(plankBot.x), Math.round(plankBot.y - 2));
                ctx.stroke();
            }
            // Right leaf planks
            for (const f of [0.25, 0.5, 0.75]) {
                const plankTop = lerp(tc, tr, f);
                const plankBot = lerp(bc, br, f);
                ctx.beginPath();
                ctx.moveTo(Math.round(plankTop.x), Math.round(plankTop.y + 2));
                ctx.lineTo(Math.round(plankBot.x), Math.round(plankBot.y - 2));
                ctx.stroke();
            }

            // Center seam.
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(tc.x), Math.round(tc.y));
            ctx.lineTo(Math.round(bc.x), Math.round(bc.y));
            ctx.stroke();

            // Ring handles near the center seam at mid-height per leaf.
            ctx.fillStyle = '#9aa0a6';
            for (const dir of [-1, 1]) {
                const top = lerp(tc, dir < 0 ? tl : tr, 0.18);
                const bot = lerp(bc, dir < 0 ? bl : br, 0.18);
                const handle = lerp(top, bot, 0.5);
                ctx.beginPath();
                ctx.arc(Math.round(handle.x), Math.round(handle.y), 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        ctx.restore();
    }

    _drawVillageWallSegment(ctx, originX, originY, start, end, phase = 0, footingExtent = null) {
        const palette = VILLAGE_WOOD_PALETTE;
        const x1 = Math.round(originX + start.x);
        const y1 = Math.round(originY + start.y);
        const x2 = Math.round(originX + end.x);
        const y2 = Math.round(originY + end.y);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        let nx = -uy;
        let ny = ux;
        if (ny < 0) {
            nx *= -1;
            ny *= -1;
        }
        const wallHeight = 68;
        const capWidth = 17;
        const capLift = 6;
        const faceTop1 = { x: x1, y: y1 - wallHeight };
        const faceTop2 = { x: x2, y: y2 - wallHeight };
        const capBack1 = { x: faceTop1.x + nx * capWidth, y: faceTop1.y + ny * capWidth - capLift };
        const capBack2 = { x: faceTop2.x + nx * capWidth, y: faceTop2.y + ny * capWidth - capLift };
        const shadowDrop = 14;
        const postStep = 18;
        const stakeWidth = 9;
        const stakeHeight = 18;
        const offset = (phase % 2) * 5;

        const traceQuad = (a, b, c, d) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(a.x), Math.round(a.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y));
            ctx.lineTo(Math.round(c.x), Math.round(c.y));
            ctx.lineTo(Math.round(d.x), Math.round(d.y));
            ctx.closePath();
        };

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        ctx.globalAlpha = 0.32;
        ctx.fillStyle = palette.shadow;
        traceQuad(
            { x: x1 - nx * 7, y: y1 + shadowDrop },
            { x: x2 - nx * 7, y: y2 + shadowDrop },
            { x: x2 + nx * 11, y: y2 + shadowDrop + 8 },
            { x: x1 + nx * 11, y: y1 + shadowDrop + 8 },
        );
        ctx.fill();
        ctx.globalAlpha = 1;

        traceQuad({ x: x1, y: y1 }, { x: x2, y: y2 }, faceTop2, faceTop1);
        const faceGradient = ctx.createLinearGradient(0, Math.min(y1, y2) - wallHeight, 0, Math.max(y1, y2));
        faceGradient.addColorStop(0, palette.light);
        faceGradient.addColorStop(0.46, palette.mid);
        faceGradient.addColorStop(1, palette.deep);
        ctx.fillStyle = faceGradient;
        ctx.fill();
        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 3;
        ctx.stroke();

        traceQuad(faceTop1, faceTop2, capBack2, capBack1);
        ctx.fillStyle = palette.dark;
        ctx.fill();
        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = palette.rope;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(faceTop1.x + nx * 2), Math.round(faceTop1.y + ny * 2 - 2));
        ctx.lineTo(Math.round(faceTop2.x + nx * 2), Math.round(faceTop2.y + ny * 2 - 2));
        ctx.stroke();

        ctx.save();
        traceQuad({ x: x1, y: y1 }, { x: x2, y: y2 }, faceTop2, faceTop1);
        ctx.clip();
        for (let d = 8 + offset; d < length; d += 13) {
            const baseX = x1 + ux * d;
            const baseY = y1 + uy * d;
            const plankNoise = Math.floor(d / 13) % 3;
            ctx.strokeStyle = plankNoise === 0 ? '#2c190d' : '#593317';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(baseX), Math.round(baseY - 4));
            ctx.lineTo(Math.round(baseX), Math.round(baseY - wallHeight + 7 + plankNoise * 2));
            ctx.stroke();
            if (plankNoise === 1) {
                ctx.strokeStyle = 'rgba(219, 151, 76, 0.35)';
                ctx.beginPath();
                ctx.moveTo(Math.round(baseX + ux * 2), Math.round(baseY - 8));
                ctx.lineTo(Math.round(baseX + ux * 2), Math.round(baseY - wallHeight + 12));
                ctx.stroke();
            }
        }
        for (const row of [22, 39]) {
            ctx.strokeStyle = palette.dark;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(Math.round(x1), Math.round(y1 - row));
            ctx.lineTo(Math.round(x2), Math.round(y2 - row));
            ctx.stroke();
            ctx.strokeStyle = palette.rope;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(Math.round(x1), Math.round(y1 - row - 2));
            ctx.lineTo(Math.round(x2), Math.round(y2 - row - 2));
            ctx.stroke();
        }
        ctx.restore();

        for (let d = 7 + offset; d < length - 2; d += postStep) {
            const half = stakeWidth / 2;
            const a = { x: x1 + ux * (d - half), y: y1 + uy * (d - half) - wallHeight };
            const b = { x: x1 + ux * (d + half), y: y1 + uy * (d + half) - wallHeight };
            const cadence = Math.floor(d / postStep);
            const tip = { x: x1 + ux * d, y: y1 + uy * d - wallHeight - stakeHeight - (cadence % 4 === 0 ? 8 : cadence % 2 ? 4 : 0) };
            ctx.beginPath();
            ctx.moveTo(Math.round(a.x), Math.round(a.y + 8));
            ctx.lineTo(Math.round(a.x), Math.round(a.y));
            ctx.lineTo(Math.round(tip.x), Math.round(tip.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y + 8));
            ctx.closePath();
            ctx.fillStyle = cadence % 2 ? palette.mid : palette.dark;
            ctx.fill();
            ctx.strokeStyle = palette.outline;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        if (footingExtent) {
            this._drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, footingExtent);
        }

        for (let d = 32 + offset; d < length - 12; d += 72) {
            const p = { x: x1 + ux * d, y: y1 + uy * d };
            const w = 13;
            const h = wallHeight + 17;
            ctx.fillStyle = palette.deep;
            ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - h + 7), w, h);
            ctx.strokeStyle = palette.outline;
            ctx.lineWidth = 2;
            ctx.strokeRect(Math.round(p.x - w / 2), Math.round(p.y - h + 7), w, h);
            ctx.fillStyle = palette.tealDark;
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x - 10), Math.round(p.y - h + 7));
            ctx.lineTo(Math.round(p.x), Math.round(p.y - h - 8));
            ctx.lineTo(Math.round(p.x + 10), Math.round(p.y - h + 7));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        for (let d = 18 + offset; d < length - 8; d += 38) {
            const p = { x: x1 + ux * d, y: y1 + uy * d };
            ctx.strokeStyle = palette.ropeDark;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x - nx * 6), Math.round(p.y - 18 - ny * 6));
            ctx.lineTo(Math.round(p.x + nx * 6), Math.round(p.y - 18 + ny * 6));
            ctx.moveTo(Math.round(p.x - nx * 6), Math.round(p.y - 36 - ny * 6));
            ctx.lineTo(Math.round(p.x + nx * 6), Math.round(p.y - 36 + ny * 6));
            ctx.stroke();
        }

        for (let d = 24 + offset; d < length - 12; d += 74) {
            const p = { x: x1 + ux * d, y: y1 + uy * d - 30 };
            ctx.fillStyle = palette.moss;
            ctx.fillRect(Math.round(p.x - 3), Math.round(p.y), 9, 3);
            ctx.fillStyle = '#d8c79a';
            ctx.fillRect(Math.round(p.x + 6), Math.round(p.y + 4), 2, 2);
            ctx.fillRect(Math.round(p.x - 7), Math.round(p.y + 11), 2, 2);
        }

        // Trailing ivy down the wall face — breaks up the bare planks.
        for (let d = 58 + offset; d < length - 16; d += 116) {
            const ix = x1 + ux * d;
            const iy = y1 + uy * d;
            ctx.strokeStyle = 'rgba(74, 110, 46, 0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(Math.round(ix), Math.round(iy - wallHeight + 10));
            for (let k = 0; k <= 5; k++) {
                ctx.lineTo(Math.round(ix + Math.sin(k * 1.3 + d) * 4), Math.round(iy - wallHeight + 10 + k * 9));
            }
            ctx.stroke();
            ctx.fillStyle = 'rgba(96, 140, 60, 0.92)';
            for (let k = 1; k <= 4; k++) {
                const yy = iy - wallHeight + 12 + k * 11;
                const xx = ix + Math.sin(k * 1.3 + d) * 4;
                ctx.fillRect(Math.round(xx - 2), Math.round(yy), 3, 2);
                ctx.fillRect(Math.round(xx + 1), Math.round(yy + 3), 3, 2);
            }
        }

        // Low shrubs tucked against the wall footing.
        for (let d = 30 + offset; d < length - 10; d += 52) {
            const sx = x1 + ux * d + nx * 4;
            const sy = y1 + uy * d + ny * 4 + 4;
            ctx.fillStyle = 'rgba(44, 76, 30, 0.95)';
            ctx.beginPath();
            ctx.ellipse(Math.round(sx), Math.round(sy), 7, 4, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(74, 116, 50, 0.92)';
            ctx.beginPath();
            ctx.ellipse(Math.round(sx - 2), Math.round(sy - 1), 4, 2.5, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // Mounted torches — warm pools of light along the palisade. Gentle
        // flicker when motion is enabled; steady glow under reduced motion.
        for (let d = 50 + offset * 2; d < length - 18; d += 92) {
            const bx = x1 + ux * d;
            const topY = y1 + uy * d - wallHeight + 9;
            ctx.fillStyle = palette.dark;
            ctx.fillRect(Math.round(bx - 2), Math.round(topY), 4, 11);
            const flick = this.motionScale ? (Math.sin(this.waterFrame * 3 + d) * 0.5 + 0.5) : 0.5;
            const fh = 7 + flick * 3;
            ctx.fillStyle = 'rgba(255, 150, 40, 0.95)';
            ctx.beginPath();
            ctx.moveTo(Math.round(bx - 3), Math.round(topY));
            ctx.lineTo(Math.round(bx), Math.round(topY - fh));
            ctx.lineTo(Math.round(bx + 3), Math.round(topY));
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 226, 130, 0.95)';
            ctx.beginPath();
            ctx.moveTo(Math.round(bx - 1.5), Math.round(topY));
            ctx.lineTo(Math.round(bx), Math.round(topY - fh * 0.6));
            ctx.lineTo(Math.round(bx + 1.5), Math.round(topY));
            ctx.closePath();
            ctx.fill();
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            const glow = ctx.createRadialGradient(bx, topY - 2, 1, bx, topY - 2, 22);
            glow.addColorStop(0, 'rgba(255, 180, 80, 0.40)');
            glow.addColorStop(1, 'rgba(255, 180, 80, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(Math.round(bx - 24), Math.round(topY - 26), 48, 48);
            ctx.restore();
        }

        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1), Math.round(y1));
        ctx.lineTo(Math.round(x2), Math.round(y2));
        ctx.stroke();
        ctx.restore();
    }

    _drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, extent) {
        const stone = VILLAGE_STONE_PALETTE;
        // Footing is painted as a strip at the wall base on the side closest to the gate.
        const fullDist = Math.min(extent.distance ?? 30, length - 32); // stay clear of the last watchpost
        const ditherDist = extent.dither ?? 32;
        if (fullDist <= 0) return;

        // Determine which end of the segment is gate-adjacent.
        const fromEnd = extent.side === 'end';
        const startD = fromEnd ? length - fullDist : 0;
        const endD = fromEnd ? length : fullDist;
        const ditherStartD = fromEnd ? startD - ditherDist : endD;
        const ditherEndD = fromEnd ? startD : endD + ditherDist;

        const footingHeight = 18; // px, drops below the wall face
        const stoneY = (d) => ({
            x: x1 + ux * d,
            y: y1 + uy * d,
        });

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Full footing block
        const a = stoneY(startD);
        const b = stoneY(endD);
        ctx.fillStyle = stone.mid;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight));
        ctx.lineTo(Math.round(a.x), Math.round(a.y + footingHeight));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Mortar line across the middle of the footing
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y + footingHeight / 2));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight / 2));
        ctx.stroke();

        // Vertical mortar joints (offset between courses)
        for (let d = startD + 16; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.stroke();
        }
        for (let d = startD + 28; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight));
            ctx.stroke();
        }

        // Moss tufts on top edge of footing (only inside the full block)
        ctx.fillStyle = stone.moss;
        for (let d = startD + 8; d < endD; d += 28) {
            const p = stoneY(d);
            ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - 2), 8, 3);
        }

        // Dither cubes — fade out over half a tile
        const cubeCount = 4;
        for (let i = 0; i < cubeCount; i++) {
            const t = (i + 1) / (cubeCount + 1);
            const d = fromEnd ? startD - t * ditherDist : endD + t * ditherDist;
            const size = Math.max(2, Math.round(footingHeight * (1 - t)));
            const p = stoneY(d);
            ctx.fillStyle = stone.mid;
            ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y + footingHeight - size), size, size);
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(Math.round(p.x - size / 2), Math.round(p.y + footingHeight - size), size, size);
        }

        ctx.restore();
    }

    _fantasyTreePropBounds(tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        return {
            left: -cached.anchorX,
            right: cached.canvas.width - cached.anchorX,
            top: -cached.anchorY,
            bottom: cached.canvas.height - cached.anchorY,
            splitY: -cached.anchorY + Math.round(cached.canvas.height * 0.58),
        };
    }

    // Deterministic per-tree phase for wind sway. Mixes tile position and
    // variant into [0, 2π) so neighbouring trees don't pulse in lockstep.
    _windSwaySeed(tree) {
        const tx = Number(tree?.tileX) || 0;
        const ty = Number(tree?.tileY) || 0;
        const variant = Number(tree?.variant) || 0;
        const n = Math.sin(tx * 12.9898 + ty * 78.233 + variant * 7.131) * 43758.5453;
        return (n - Math.floor(n)) * Math.PI * 2;
    }

    // Apply a small horizontal offset to a tree drawFn based on the current
    // atmosphere wind. Clamped to ±2 px so pixel-art sprites do not shimmer;
    // skipped under reduced motion (motionScale === 0).
    _withTreeSway(ctx, seed, drawFn) {
        if (typeof drawFn !== 'function') return;
        const motionScale = this.motionScale ?? 1;
        const windX = Number(this._lastAtmosphere?.motion?.windX) || 0;
        if (motionScale <= 0 || windX === 0) {
            drawFn();
            return;
        }
        const t = (typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now()) * 0.001;
        let dx = Math.sin(t + seed) * windX * 1.5;
        if (dx > 2) dx = 2;
        else if (dx < -2) dx = -2;
        const offset = Math.round(dx);
        if (offset === 0) {
            drawFn();
            return;
        }
        ctx.save();
        ctx.translate(offset, 0);
        drawFn();
        ctx.restore();
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

    _drawDynamicWaterHighlights(ctx) {
        const bounds = this._getVisibleTileBounds(3);
        const waterTiles = this._visibleWaterTileDescriptors(bounds);
        const shoreEdges = this._visibleShoreWaterEdgeDescriptors(bounds);
        this._drawPhaseWaterTint(ctx, waterTiles);
        this._drawWeatherWaterRipples(ctx, waterTiles);
        this._drawWaterFogEdgeWash(ctx, shoreEdges);
        this._drawHarborWakeWaterDescriptors(ctx);
        this._drawNightWaterReflections(ctx, waterTiles);
        if (!this.motionScale) return;
        this._drawAnimatedCurrentBands(ctx, waterTiles);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of waterTiles) {
            if (tile.seed <= 0.82) continue;
            // B7: in storms, increase shimmer t frequency for lagoon tiles.
            const stormFreqMult = tile.isLagoon && this._stormIntensity
                ? 1 + 0.5 * this._stormIntensity
                : 1;
            const shimmerT = this.waterFrame * 2.2 * stormFreqMult + tile.seed * 10;
            const shimmer = 0.035 + Math.max(0, Math.sin(shimmerT)) * 0.045;
            const warm = this._atmosphereReactions?.warmGlint || 0;
            const glintColor = warm > 0.15 ? '255, 212, 142' : tile.token.glint;
            ctx.strokeStyle = `rgba(${glintColor}, ${shimmer * (1 + warm * 0.42)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tile.screenX - 12, tile.screenY - 2);
            ctx.lineTo(tile.screenX + 10, tile.screenY - 6);
            ctx.stroke();
        }
        this._drawShorelineReflectionShimmer(ctx, shoreEdges);
        ctx.restore();
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
        ctx.restore();
    }

    _getAtmosphereEffectSprite(id) {
        if (!id || !this.assets?.has?.(id)) return null;
        const img = this.assets.get(id);
        if (!img) return null;
        const dims = this.assets.getDims(id) || { w: img.width, h: img.height };
        return { img, dims };
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

    _waterWeatherState(atmosphere = null) {
        const wx = atmosphere?.weather || {};
        const type = wx.type || 'clear';
        const intensity = Math.max(0, Math.min(1, Number(wx.intensity) || 0));
        const precipitation = Math.max(0, Math.min(1, Number(wx.precipitation ?? (type === 'rain' || type === 'storm' ? intensity : 0)) || 0));
        const storm = type === 'storm' || (type === 'rain' && intensity > 0.72);
        return {
            rain: precipitation,
            storm: storm ? intensity : 0,
            fog: type === 'fog' ? intensity : Math.max(0, Math.min(1, Number(wx.fog) || 0)),
            windX: Number(wx.windX) || atmosphere?.motion?.windX || 1,
            reactions: atmosphere?.reactions || {},
            phase: atmosphere?.phase || 'day',
        };
    }

    _drawWeatherWaterRipples(ctx, waterTiles) {
        const weather = this._waterWeather || {};
        const reactions = weather.reactions || {};
        const rain = weather.rain || 0;
        if (rain <= 0.08 || !waterTiles?.length) return;

        // Stamp the manifest-driven rain ripple sprite for a small random
        // fraction of visible water tiles per frame. The WeatherRenderer
        // self-throttles per tile (2s) so the global ripple budget stays
        // bounded. Skipped under reduced motion.
        const stampRipples = (this.motionScale ?? 1) > 0
            && typeof this.weatherRenderer?.maybeStampWaterRipple === 'function';

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const rippleScale = reactions.waterRippleScale || rain;
        const stride = rain > 0.65 ? 2 : 3;
        for (const tile of waterTiles) {
            const localStride = tile.profile === 'openSea' ? stride + 1 : tile.profile === 'harbor' ? stride : Math.max(1, stride - 1);
            if (((tile.x * 3 + tile.y * 5 + Math.floor(tile.seed * 11)) % localStride) !== 0) continue;
            if (stampRipples && Math.random() < 1 / 30) {
                this.weatherRenderer.maybeStampWaterRipple(ctx, tile.x, tile.y, tile.screenX, tile.screenY);
            }
            const phase = (this.motionScale ? this.waterFrame : STATIC_WATER_SHIMMER) * (1.8 + rain * 1.3) + tile.seed * 6.28;
            const pulse = (Math.sin(phase) + 1) / 2;
            const profileScale = tile.profile === 'openSea' ? 0.72 : tile.profile === 'harbor' ? 0.90 : 1.14;
            const radius = (4 + pulse * (5 + rain * 5)) * profileScale * (0.76 + rippleScale * 0.36);
            const nightReflection = reactions.nightReflection || 0;
            const alpha = (0.030 + rain * 0.078) * (1 - pulse * 0.45) * (tile.profile === 'openSea' ? 0.72 : 1) * (1 + nightReflection * 0.18);
            if (this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.rainRipple, {
                x: tile.screenX + (tile.seed - 0.5) * 18,
                y: tile.screenY - 2 + (tile.seed - 0.5) * 8,
                alpha: Math.min(0.28, alpha * 1.9),
                scaleX: (0.62 + pulse * 0.38) * profileScale,
                scaleY: (0.52 + pulse * 0.20) * profileScale,
                rotation: -0.18,
                flipX: tile.seed > 0.5,
            })) {
                continue;
            }
            ctx.strokeStyle = `rgba(${tile.token.rainRipple}, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(
                Math.round(tile.screenX + (tile.seed - 0.5) * 18),
                Math.round(tile.screenY - 2 + (tile.seed - 0.5) * 8),
                radius,
                radius * 0.38,
                -0.18,
                0,
                Math.PI * 2,
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawWaterFogEdgeWash(ctx, shoreEdges) {
        const fogAlpha = this._waterWeather?.reactions?.waterFogAlpha || this._waterWeather?.fog * 0.24 || 0;
        if (fogAlpha <= 0.025 || !shoreEdges?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of shoreEdges) {
            const profileAlpha = tile.profile === 'openSea' ? 0.54 : tile.profile === 'harbor' ? 1.05 : 1.16;
            ctx.strokeStyle = `rgba(${tile.token.fogWash}, ${Math.min(0.20, fogAlpha * profileAlpha * (0.34 + tile.seed * 0.44))})`;
            ctx.lineWidth = 2;
            this._strokeInsetDiamondEdges(ctx, tile.screenX, tile.screenY, tile.edge, 3 + tile.seed * 4);
            if (tile.seed > 0.58) {
                this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.fogWisp, {
                    x: tile.screenX + (tile.seed - 0.5) * 24,
                    y: tile.screenY - 5 + (tile.seed - 0.5) * 8,
                    alpha: Math.min(0.22, fogAlpha * profileAlpha * (0.24 + tile.seed * 0.20)),
                    scaleX: 0.42 + tile.seed * 0.24,
                    scaleY: 0.34 + tile.seed * 0.12,
                    rotation: -0.20 + tile.seed * 0.24,
                    flipX: tile.seed > 0.5,
                });
            }
        }
        ctx.restore();
    }

    // Phase-coupled water palette. Tint base water toward the active phase
    // palette's horizon (warm dusk/dawn) or zenith-darkened (night). At noon
    // both reactions are ~0 so this method is a near-noop and water stays teal.
    _drawPhaseWaterTint(ctx, waterTiles) {
        const reactions = this._atmosphereReactions || {};
        const warmGlint = reactions.warmGlint || 0;
        const nightReflection = reactions.nightReflection || 0;
        const warmActive = warmGlint > 0.05;
        const nightActive = nightReflection > 0.10;
        if ((!warmActive && !nightActive) || !waterTiles?.length) return;
        const palette = this._lastAtmosphere?.sky?.palette;
        if (!palette) return;
        const cap = THEME.waterTint?.alphaCap ?? 0.22;
        const tints = [];
        if (warmActive && palette.horizon) {
            const horizonMix = THEME.waterTint?.horizonMix ?? 0.55;
            tints.push({
                color: palette.horizon,
                alpha: Math.min(cap, warmGlint * horizonMix),
            });
        }
        if (nightActive && palette.zenith) {
            // Halve the zenith RGB to darken (palette.zenith * 0.5).
            const zenithMix = THEME.waterTint?.zenithMix ?? 0.45;
            tints.push({
                color: this._halfHex(palette.zenith),
                alpha: Math.min(cap, nightReflection * zenithMix),
            });
        }
        if (!tints.length) return;
        ctx.save();
        // source-over: this is a base tint, not an additive highlight.
        for (const tile of waterTiles) {
            for (const tint of tints) {
                ctx.fillStyle = this._withAlpha(tint.color, tint.alpha);
                this._drawDiamond(ctx, tile.screenX, tile.screenY);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    // Halve a #rrggbb hex toward black; used for night water zenith darkening.
    _halfHex(hex) {
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex;
        const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * 0.5)));
        const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * 0.5)));
        const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * 0.5)));
        const hh = (n) => n.toString(16).padStart(2, '0');
        return `#${hh(r)}${hh(g)}${hh(b)}`;
    }

    _drawNightWaterReflections(ctx, waterTiles) {
        const nightReflection = this._atmosphereReactions?.nightReflection || 0;
        if (nightReflection <= 0.05 || !waterTiles?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of waterTiles) {
            if (tile.seed < 0.46) continue;
            if (tile.profile === 'lagoon' && tile.seed < 0.68) continue;
            const width = 8 + tile.seed * (tile.profile === 'openSea' ? 20 : 14);
            const alpha = Math.min(0.16, nightReflection * (0.032 + tile.seed * 0.052));
            ctx.strokeStyle = `rgba(${tile.token.glint}, ${alpha})`;
            ctx.lineWidth = tile.profile === 'openSea' ? 1.4 : 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(tile.screenX - width), Math.round(tile.screenY - 7 + tile.seed * 3));
            ctx.lineTo(Math.round(tile.screenX + width * 0.72), Math.round(tile.screenY - 10 - tile.seed * 2));
            ctx.stroke();
        }
        ctx.restore();
    }

    _firstAdjacentWaterMeta(tileX, tileY) {
        const candidates = [
            [tileX, tileY - 1],
            [tileX + 1, tileY],
            [tileX, tileY + 1],
            [tileX - 1, tileY],
        ];
        for (const [x, y] of candidates) {
            const key = `${x},${y}`;
            if (this.waterTiles.has(key)) return { x, y, key, meta: this._waterMetaAt(x, y, key) };
        }
        return null;
    }

    _drawHarborWakeWaterDescriptors(ctx) {
        const descriptors = this.harborTraffic?.enumerateWakeDescriptors?.(Date.now()) || [];
        if (!descriptors.length) return;
        const roughness = this._waterWeather?.storm || 0;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const wake of descriptors.slice(0, 16)) {
            const alpha = Math.min(0.22, (wake.alpha ?? 0.12) * (1 + roughness * 0.28));
            if (alpha <= 0.01) continue;
            const token = WATER_TOKENS[wake.waterRegion] || WATER_TOKENS.harbor;
            const dx = wake.x - (wake.tailX ?? wake.x - 1);
            const dy = wake.y - (wake.tailY ?? wake.y);
            const wakeRotation = wake.type === 'departing' ? Math.atan2(dy, dx) * 0.55 : -0.18;
            const drewWakeSprite = this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.harborWake, {
                x: wake.type === 'departing' ? wake.x - dx * 0.42 : wake.x,
                y: wake.type === 'departing' ? wake.y - dy * 0.42 + 5 : wake.y + 4,
                alpha: alpha * 0.70,
                scaleX: wake.type === 'departing' ? 0.54 + (wake.spread || 0) * 0.24 : 0.48,
                scaleY: wake.type === 'departing' ? 0.44 + (wake.progress || 0) * 0.18 : 0.36,
                rotation: wakeRotation,
                flipX: dx < 0,
            });
            if (drewWakeSprite) continue;
            ctx.strokeStyle = `rgba(${token.wake}, ${alpha})`;
            ctx.fillStyle = `rgba(${token.wake}, ${alpha * 0.24})`;
            ctx.lineWidth = wake.type === 'departing' ? 1.6 : 1;
            if (wake.type === 'departing') {
                const len = Math.max(1, Math.hypot(dx, dy));
                const ux = dx / len;
                const uy = dy / len;
                const px = -uy;
                const py = ux;
                const spread = 10 + (wake.spread || 0) * 18;
                const back = 18 + (wake.progress || 0) * 22;
                ctx.beginPath();
                ctx.moveTo(wake.x - ux * 8 + px * 5, wake.y - uy * 8 + py * 5);
                ctx.quadraticCurveTo(wake.x - ux * back, wake.y - uy * back, wake.x - ux * (back + 18) + px * spread, wake.y - uy * (back + 18) + py * spread * 0.55);
                ctx.moveTo(wake.x - ux * 8 - px * 5, wake.y - uy * 8 - py * 5);
                ctx.quadraticCurveTo(wake.x - ux * back, wake.y - uy * back, wake.x - ux * (back + 18) - px * spread, wake.y - uy * (back + 18) - py * spread * 0.55);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.ellipse(Math.round(wake.x), Math.round(wake.y + 4), wake.radiusX || 30, wake.radiusY || 13, -0.18, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawShorelineReflectionShimmer(ctx, shoreEdges) {
        if (!shoreEdges?.length) return;
        for (const tile of shoreEdges) {
            if (tile.seed < 0.32) continue;
            const frame = this.motionScale ? this.waterFrame : 0;
            const alpha = 0.05 + Math.max(0, Math.sin(frame * 1.9 + tile.seed * 6.28)) * 0.08;
            ctx.strokeStyle = `rgba(197, 252, 236, ${alpha})`;
            ctx.lineWidth = 1;
            this._strokeInsetDiamondEdges(ctx, tile.screenX, tile.screenY, tile.edge, 9);
        }
    }

    _drawOpenWaterDepthWash(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const openness = this._waterOpenness(x, y);
                const openSea = this._isOpenSeaTile(x, y, openness);
                if (openness < 0.42) continue;
                const isDeep = this.deepWaterTiles.has(key);
                const harbor = this._isHarborWater(x, y);
                const alpha = Math.min(
                    openSea ? 0.36 : 0.22,
                    (isDeep ? (openSea ? 0.22 : 0.12) : 0.055) * openness + (harbor ? 0.035 : 0)
                );
                ctx.fillStyle = isDeep
                    ? `rgba(0, ${openSea ? 7 : 9}, ${openSea ? 38 : 28}, ${alpha})`
                    : `rgba(4, 39, 62, ${alpha})`;
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
            for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key) || !this._isHarborWater(x, y)) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.fillStyle = 'rgba(87, 185, 205, 0.045)';
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    _drawStaticOpenSeaStructure(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.fillStyle = `rgba(2, ${28 + Math.floor(seed * 8)}, ${82 + Math.floor(openness * 28)}, ${0.26 + openness * 0.12})`;
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'multiply';
        ctx.lineWidth = 2;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const band = this._tileNoise(Math.floor((x - y) / 2) + 211, Math.floor((x + y) / 3) + 97);
                if (band < 0.52) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const drift = (seed - 0.5) * 4;
                ctx.strokeStyle = `rgba(0, 18, 58, ${0.10 + band * 0.08})`;
                ctx.beginPath();
                ctx.moveTo(screenX - TILE_WIDTH * 0.47, screenY - 4 + drift);
                ctx.quadraticCurveTo(
                    screenX - TILE_WIDTH * 0.05,
                    screenY - 14 + drift * 0.3,
                    screenX + TILE_WIDTH * 0.48,
                    screenY - 8 - drift * 0.2
                );
                ctx.stroke();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'screen';
        ctx.lineWidth = 1.2;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const cap = this._tileNoise(x + 617, y + 389);
                if (cap < 0.82 || openness < 0.78) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const width = TILE_WIDTH * (0.16 + cap * 0.12);
                ctx.strokeStyle = `rgba(224, 249, 255, ${0.12 + seed * 0.10})`;
                ctx.beginPath();
                ctx.moveTo(screenX - width, screenY - 10 + seed * 3);
                ctx.quadraticCurveTo(screenX, screenY - 14, screenX + width, screenY - 11 - seed * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawOpenSeaSurfBreaks(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.5;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                if (seed < 0.18) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = `rgba(229, 253, 255, ${0.18 + seed * 0.14})`;
                this._strokeInsetDiamondEdges(ctx, screenX, screenY, edge, 5 + seed * 5);
            }
        }
        ctx.restore();
    }

    _drawAnimatedCurrentBands(ctx, waterTiles) {
        if (!waterTiles?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (const tile of waterTiles) {
            if (tile.openness < 0.56 && !tile.isHarbor && !tile.isOpenSea) continue;
            const roughness = this._waterWeather?.storm || 0;
            const primary = Math.sin(this.waterFrame * 0.82 + tile.x * 0.42 - tile.y * 0.28 + tile.seed * 2.6);
            const secondary = Math.sin(this.waterFrame * 1.17 - tile.x * 0.24 - tile.y * 0.36 + tile.seed * 5.1);
            const crest = ((primary * 0.72 + secondary * 0.28) + 1) / 2;
            const threshold = (tile.isOpenSea ? 0.73 : 0.76) - roughness * (tile.isOpenSea ? 0.10 : tile.isHarbor ? 0.055 : 0.075);
            if (crest < threshold) continue;
            const alpha = Math.min(
                tile.isOpenSea ? 0.24 + roughness * 0.08 : 0.16 + roughness * 0.04,
                (crest - threshold) * (tile.isDeep ? (tile.isOpenSea ? 0.62 : 0.48) : 0.32) * (0.62 + tile.openness * 0.5) * (1 + roughness * 0.35)
            );
            const drift = Math.sin(this.waterFrame * 0.45 + tile.seed * 6.28) * 2;
            const warm = this._atmosphereReactions?.warmGlint || 0;
            const glintColor = warm > 0.18 ? '255, 210, 136' : tile.token.glint;
            ctx.strokeStyle = `rgba(${glintColor}, ${alpha})`;
            ctx.lineWidth = tile.isOpenSea ? 1.7 + roughness * 0.6 : (tile.isDeep ? 1.4 : 1);
            ctx.beginPath();
            ctx.moveTo(tile.screenX - TILE_WIDTH * (tile.isOpenSea ? 0.48 : 0.40), tile.screenY - 2 + drift);
            ctx.quadraticCurveTo(
                tile.screenX - TILE_WIDTH * 0.02,
                tile.screenY - (tile.isOpenSea ? 10 : 8) + drift * 0.35,
                tile.screenX + TILE_WIDTH * (tile.isOpenSea ? 0.48 : 0.40),
                tile.screenY - 5 - drift * 0.25
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawTile(ctx, tileX, tileY) {
        const screenX = (tileX - tileY) * TILE_WIDTH / 2;
        const screenY = (tileX + tileY) * TILE_HEIGHT / 2;
        const key = `${tileX},${tileY}`;
        const seed = this.terrainSeed[tileY * MAP_SIZE + tileX] || 0;

        if (this.terrain) {
            const sheetId = this._terrainSheetIdAt(tileX, tileY);
            this.terrain.drawTile(ctx, sheetId, tileX, tileY,
                (tx, ty) => this._sameTerrainClass(tileX, tileY, tx, ty));
        } else {
            // Fallback: solid diamond (no-assets defensive path).
            ctx.fillStyle = '#33403c';
            ctx.beginPath();
            ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
            ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
            ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
            ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
            ctx.closePath();
            ctx.fill();
        }

        this._drawTerrainTone(ctx, screenX, screenY, key, seed, tileX, tileY);
        this._drawGroundDecals(ctx, screenX, screenY, key, tileX, tileY);

        if (!this.bridgeTiles?.has(key)) {
            if (this.commandCenterRoadTiles.has(key) && this.pathTiles.has(key)) {
                this._drawCommandApproachRoadDetail(ctx, screenX, screenY, seed, tileX, tileY);
            } else if (!this.waterTiles.has(key)) {
                if (this.bushTiles?.has(key)) {
                    const bInfo = this.bushTiles.get(key);
                    const bushId = ['veg.bush.a', 'veg.bush.b', 'veg.bush.c'][(bInfo?.variant ?? 0) % 3];
                    if (this.sprites) this.sprites.drawSprite(ctx, bushId, screenX, screenY);
                }
                if (this.grassTuftTiles?.has(key)) {
                    const gInfo = this.grassTuftTiles.get(key);
                    const tuftId = ['veg.grassTuft.a', 'veg.grassTuft.b'][(gInfo?.variant ?? 0) % 2];
                    if (this.sprites) this.sprites.drawSprite(ctx, tuftId, screenX, screenY);
                }
                if (this.flowerTiles?.has(key)) {
                    const fInfo = this.flowerTiles.get(key);
                    const flowerId = ['veg.flower.a', 'veg.flower.b', 'veg.flower.c'][(fInfo?.variant ?? 0) % 3];
                    if (this.sprites) this.sprites.drawSprite(ctx, flowerId, screenX, screenY);
                }
                if (this.featureTiles?.get(key) === 'reeds') {
                    const reedId = seed > 0.58 ? 'veg.reed.a' : 'veg.reed.b';
                    if (this.sprites) this.sprites.drawSprite(ctx, reedId, screenX, screenY);
                }
            }
        }

        if (!this.pathTiles.has(key) && this.commandCenterRoadTiles.has(key) && !this.waterTiles.has(key)) {
            this._drawCommandGuardpost(ctx, screenX + (seed - 0.5) * 3, screenY + (seed - 0.5) * 2);
        }

        // Water shimmer / bridge deck
        if (this.bridgeTiles?.has(key)) {
            const bInfo = this.bridgeTiles.get(key);
            const isDoc = bInfo?.kind === 'dock';
            if (isDoc) {
                if (bInfo?.style === 'causeway') {
                    this._drawHarborCausewayTile(ctx, screenX, screenY, bInfo.orientation || 'EW', seed);
                } else {
                    const orientation = (bInfo?.orientation || 'EW').toLowerCase();
                    if (this.sprites) this.sprites.drawSprite(ctx, `dock.${orientation}`, screenX, screenY);
                }
            }
        } else if (this.waterTiles.has(key) && !this.terrain) {
            const shimmer = this.motionScale ? Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.055 + 0.055 : STATIC_WATER_SHIMMER;
            ctx.fillStyle = `rgba(185, 229, 224, ${shimmer})`;
            ctx.fill();
        }
    }

    // Procedural ground micro-detail baked into the terrain cache: pebble/soil
    // flecks on grass, moss in cobble joints, leaf litter under the northern
    // canopy, and worn dirt where grass meets a road. Deterministic — no motion,
    // no per-frame cost. Breaks up the flat terrain diamonds between buildings.
    _drawGroundDecals(ctx, screenX, screenY, key, tileX, tileY) {
        if (this.waterTiles?.has(key)) return;
        if (this.bridgeTiles?.has(key)) return;
        const isPath = this.pathTiles?.has(key);
        const isRoad = isPath || this.commandCenterRoadTiles?.has(key);

        // Place a speck inside the iso diamond; returns null if it would spill out.
        const place = (salt, spanX, spanY) => {
            const u = this._decalRand(tileX, tileY, salt);
            const v = this._decalRand(tileX, tileY, salt + 911);
            const ox = (u - 0.5) * spanX;
            const oy = (v - 0.5) * spanY;
            if (Math.abs(ox) / 30 + Math.abs(oy) / 14 > 0.92) return null;
            return { ox: Math.round(screenX + ox), oy: Math.round(screenY + oy) };
        };

        ctx.save();
        if (isRoad) {
            // Moss creeping into cobble/flagstone joints.
            const mossCount = this._decalRand(tileX, tileY, 17) > 0.55 ? 2 : 1;
            ctx.fillStyle = 'rgba(86, 120, 52, 0.26)';
            for (let i = 0; i < mossCount; i++) {
                const p = place(31 + i * 7, 46, 22);
                if (p) ctx.fillRect(p.ox, p.oy, 2, 1);
            }
        } else {
            // Land grass/dirt: pebble + tonal flecks so each diamond varies.
            const fleckNoise = this._decalRand(tileX, tileY, 3);
            const fleckCount = fleckNoise > 0.72 ? 4 : fleckNoise > 0.4 ? 3 : 2;
            for (let i = 0; i < fleckCount; i++) {
                const p = place(40 + i * 13, 48, 24);
                if (!p) continue;
                const tone = this._decalRand(tileX, tileY, 200 + i);
                ctx.fillStyle = tone > 0.66
                    ? 'rgba(150, 152, 120, 0.20)'   // light pebble
                    : tone > 0.33
                        ? 'rgba(44, 40, 30, 0.24)'  // dark soil pebble
                        : 'rgba(58, 84, 30, 0.20)'; // deep grass fleck
                ctx.fillRect(p.ox, p.oy, tone > 0.85 ? 2 : 1, 1);
            }

            // Leaf litter under the northern canopy.
            if (tileY <= 14 && this._decalRand(tileX, tileY, 71) > 0.62) {
                ctx.fillStyle = this._decalRand(tileX, tileY, 72) > 0.5
                    ? 'rgba(156, 112, 48, 0.22)'
                    : 'rgba(116, 82, 40, 0.20)';
                const p = place(73, 44, 22);
                if (p) ctx.fillRect(p.ox, p.oy, 2, 1);
            }

            // Wildflower dabs — tiny color pops scattered through the grass.
            if (this._decalRand(tileX, tileY, 90) > 0.84) {
                const fc = this._decalRand(tileX, tileY, 91);
                ctx.fillStyle = fc > 0.75 ? 'rgba(246, 234, 122, 0.90)'   // buttercup yellow
                    : fc > 0.50 ? 'rgba(238, 240, 244, 0.88)'             // white daisy
                    : fc > 0.25 ? 'rgba(228, 150, 198, 0.84)'             // pink clover
                    : 'rgba(178, 150, 228, 0.84)';                        // violet
                const p = place(92, 42, 20);
                if (p) {
                    ctx.fillRect(p.ox, p.oy, 1, 1);
                    if (fc > 0.60) ctx.fillRect(p.ox + 1, p.oy, 1, 1);
                    if (fc > 0.90) ctx.fillRect(p.ox, p.oy - 1, 1, 1);
                }
            }

            // Worn dirt where grass meets a road (threshold wear).
            if (this._neighborsRoad(tileX, tileY)) {
                ctx.fillStyle = 'rgba(120, 95, 60, 0.15)';
                ctx.beginPath();
                ctx.ellipse(Math.round(screenX), Math.round(screenY + 2), 13, 6, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    // Deterministic per-tile, per-salt value in [0,1) for decal placement.
    _decalRand(tileX, tileY, salt) {
        let h = (Math.imul(tileX | 0, 73856093) ^ Math.imul(tileY | 0, 19349663) ^ Math.imul(salt | 0, 83492791)) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    _neighborsRoad(tileX, tileY) {
        const p = this.pathTiles;
        if (!p) return false;
        return p.has(`${tileX + 1},${tileY}`)
            || p.has(`${tileX - 1},${tileY}`)
            || p.has(`${tileX},${tileY + 1}`)
            || p.has(`${tileX},${tileY - 1}`);
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
            rise: Math.max(16, Math.min(32, 12 + lengthTiles * 1.9)),
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
        const y = span.start.y + (span.end.y - span.start.y) * t + span.crossUnit.y * crossOffset - arch * span.rise - verticalLift + drop;
        return { x, y };
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
            const rampPad = 96;
            const crossPad = span.halfWidth + 72;
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

    _strokeBridgeCurve(ctx, points) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
    }

    _bridgePalette(span) {
        return BRIDGE_STYLE_PALETTES[span.style] || BRIDGE_STYLE_PALETTES.civic;
    }

    _drawBridgeMasonryCap(ctx, span, t, palette) {
        const left = this._bridgePoint(span, t, -span.halfWidth - 12, 0, 8);
        const right = this._bridgePoint(span, t, span.halfWidth + 12, 0, 8);

        ctx.lineCap = 'round';
        ctx.strokeStyle = palette.underStoneDark;
        ctx.lineWidth = 13;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();

        ctx.strokeStyle = palette.underStone;
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y - 2);
        ctx.lineTo(right.x, right.y - 2);
        ctx.stroke();

        ctx.strokeStyle = palette.underStoneLight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left.x + span.axisUnit.x * 3, left.y - 7);
        ctx.lineTo(right.x + span.axisUnit.x * 3, right.y - 7);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(28, 22, 17, 0.42)';
        ctx.lineWidth = 1.5;
        for (const offset of [-span.halfWidth * 0.55, 0, span.halfWidth * 0.55]) {
            const p = this._bridgePoint(span, t, offset, 0, 2);
            ctx.beginPath();
            ctx.moveTo(p.x - span.axisUnit.x * 5, p.y - span.axisUnit.y * 5);
            ctx.lineTo(p.x + span.axisUnit.x * 5, p.y + span.axisUnit.y * 5);
            ctx.stroke();
        }
    }

    _drawBridgePier(ctx, span, t, palette) {
        for (const offset of [-span.halfWidth * 0.62, span.halfWidth * 0.62]) {
            const top = this._bridgePoint(span, t, offset, 4, 8);
            const foot = { x: top.x - span.axisUnit.x * 2, y: top.y + 35 };
            ctx.strokeStyle = palette.underStoneDark;
            ctx.lineWidth = 9;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(top.x, top.y);
            ctx.lineTo(foot.x, foot.y);
            ctx.stroke();

            ctx.strokeStyle = palette.underStone;
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(top.x - 1, top.y - 2);
            ctx.lineTo(foot.x - 1, foot.y - 2);
            ctx.stroke();

            ctx.strokeStyle = palette.underStoneLight;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(top.x - 3, top.y + 2);
            ctx.lineTo(foot.x - 3, foot.y + 18);
            ctx.stroke();
        }
    }

    _drawBridgeRopeRuns(ctx, span, palette) {
        ctx.strokeStyle = palette.rope;
        ctx.globalAlpha = 0.78;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        for (const side of [-1, 1]) {
            this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, side * (span.halfWidth + 5), 19, 8, 18));
            this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, side * (span.halfWidth + 5), 12, 12, 18));
        }
        ctx.globalAlpha = 1;
    }

    _drawBridgeRuneBands(ctx, span, palette) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = palette.rune;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        for (const t of [0.32, 0.50, 0.68]) {
            const left = this._bridgePoint(span, t, -span.halfWidth + 15, 2);
            const right = this._bridgePoint(span, t, span.halfWidth - 15, 2);
            ctx.beginPath();
            ctx.moveTo(left.x, left.y);
            ctx.lineTo(right.x, right.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawBridgeMoss(ctx, span, palette) {
        ctx.fillStyle = palette.moss;
        for (let i = 0; i < 18; i++) {
            const t = (i + 0.5) / 18;
            const side = i % 2 === 0 ? -1 : 1;
            const p = this._bridgePoint(span, t, side * (span.halfWidth - 8), 0, 1);
            ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 1), 4, 2);
        }
    }

    _drawBridgeAccentSprites(ctx, span, palette) {
        if (!this.sprites || !span.id) return;
        const accents = BRIDGE_ACCENT_PROPS.filter((accent) => accent.bridgeId === span.id);
        for (const accent of accents) {
            const t = Math.max(0.04, Math.min(0.96, accent.t));
            const side = accent.side < 0 ? -1 : 1;
            const p = this._bridgePoint(span, t, side * (span.halfWidth + 16), 20, -2);
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = palette.glow;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y - 16, 13, 17, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            this.sprites.drawSprite(ctx, accent.id, p.x, p.y);
        }
    }

    _bridgeSpriteId(span) {
        const orientation = (span.orientation || 'EW').toLowerCase();
        const style = span.style || 'civic';
        return `bridge.landmark.${style}.${orientation}`;
    }

    _bridgeSpriteTargetWidth(span, dims) {
        const spanLength = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y);
        const footprintWidth = spanLength + span.halfWidth * 2.8;
        return Math.round(Math.max(
            BRIDGE_SPRITE_MIN_WIDTH,
            Math.min(BRIDGE_SPRITE_MAX_WIDTH, footprintWidth, dims.w * 1.8)
        ));
    }

    _drawGeneratedBridgeSpan(ctx, span, palette) {
        if (!this.sprites || !this.assets) return false;
        const spriteId = this._bridgeSpriteId(span);
        const img = this.assets.get(spriteId);
        if (!img) return false;
        const dims = this.assets.getDims(spriteId) || { w: img.width, h: img.height };
        const [anchorX, anchorY] = this.assets.getAnchor(spriteId);
        const targetWidth = this._bridgeSpriteTargetWidth(span, dims);
        const scale = targetWidth / dims.w;
        const targetHeight = Math.round(dims.h * scale);

        const center = this._bridgePoint(span, 0.5, 0, 0, 18);
        ctx.save();
        this._traceBridgeRibbon(
            ctx,
            this._bridgeSidePoints(span, -span.halfWidth - 46, 0, 22, 10),
            this._bridgeSidePoints(span, span.halfWidth + 46, 0, 22, 10)
        );
        ctx.fillStyle = palette.shadow;
        ctx.fill();
        ctx.restore();

        ctx.drawImage(
            img,
            Math.round(center.x - anchorX * scale),
            Math.round(center.y - anchorY * scale),
            targetWidth,
            targetHeight
        );
        this._drawBridgeAccentSprites(ctx, span, palette);
        return true;
    }

    _drawLandmarkBridgeSpan(ctx, span) {
        const palette = this._bridgePalette(span);
        if (this._drawGeneratedBridgeSpan(ctx, span, palette)) return;

        const leftDeck = this._bridgeSidePoints(span, -span.halfWidth);
        const rightDeck = this._bridgeSidePoints(span, span.halfWidth);
        const shadowLeft = this._bridgeSidePoints(span, -span.halfWidth - 7, 0, 15, 10);
        const shadowRight = this._bridgeSidePoints(span, span.halfWidth + 7, 0, 15, 10);
        const railLeft = this._bridgeSidePoints(span, -span.halfWidth - 3, 24, 0, 14);
        const railRight = this._bridgeSidePoints(span, span.halfWidth + 3, 24, 0, 14);
        const centerSeam = this._bridgeSidePoints(span, 0, 0, 0, 14);

        ctx.save();

        this._traceBridgeRibbon(ctx, shadowLeft, shadowRight);
        ctx.fillStyle = palette.shadow;
        ctx.fill();

        for (const t of [0, 1]) {
            this._drawBridgeMasonryCap(ctx, span, t, palette);
        }

        this._drawBridgePier(ctx, span, 0.38, palette);
        this._drawBridgePier(ctx, span, 0.62, palette);

        this._traceBridgeRibbon(ctx, leftDeck, rightDeck);
        const deckGradient = ctx.createLinearGradient(span.start.x, span.start.y - span.rise, span.end.x, span.end.y);
        deckGradient.addColorStop(0, palette.deckA);
        deckGradient.addColorStop(0.24, palette.deckB);
        deckGradient.addColorStop(0.55, palette.deckC);
        deckGradient.addColorStop(1, palette.deckA);
        ctx.fillStyle = deckGradient;
        ctx.fill();
        ctx.strokeStyle = palette.deckDark;
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.globalAlpha = 0.55;
        this._traceBridgeRibbon(
            ctx,
            this._bridgeSidePoints(span, -span.halfWidth + 6, 3, 4, 10),
            this._bridgeSidePoints(span, span.halfWidth - 6, 3, 4, 10)
        );
        ctx.fillStyle = 'rgba(255, 187, 103, 0.22)';
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = 'rgba(52, 25, 15, 0.74)';
        ctx.lineWidth = 2;
        for (let i = 1; i <= span.lengthTiles + 2; i++) {
            const t = i / (span.lengthTiles + 3);
            const a = this._bridgePoint(span, t, -span.halfWidth + 8, 1);
            const b = this._bridgePoint(span, t, span.halfWidth - 8, 1);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        this._drawBridgeRuneBands(ctx, span, palette);
        this._drawBridgeMoss(ctx, span, palette);

        ctx.strokeStyle = palette.deckEdge;
        ctx.lineWidth = 3;
        this._strokeBridgeCurve(ctx, centerSeam);
        this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, -span.halfWidth + 4));
        this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, span.halfWidth - 4));

        const postCount = Math.max(5, Math.min(9, Math.round(span.lengthTiles / 1.35)));
        for (let i = 0; i <= postCount; i++) {
            const t = i / postCount;
            const postLift = 19 + Math.sin(Math.PI * t) * 9;
            for (const side of [-1, 1]) {
                const deck = this._bridgePoint(span, t, side * (span.halfWidth - 1), 0);
                const rail = this._bridgePoint(span, t, side * (span.halfWidth + 4), postLift);
                ctx.strokeStyle = palette.railDark;
                ctx.lineWidth = i === 0 || i === postCount ? 5 : 4;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(deck.x, deck.y + 4);
                ctx.lineTo(rail.x, rail.y);
                ctx.stroke();
                ctx.strokeStyle = palette.railMid;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(deck.x - span.axisUnit.x * 1.5, deck.y + 2);
                ctx.lineTo(rail.x - span.axisUnit.x * 1.5, rail.y + 1);
                ctx.stroke();
            }
        }

        this._drawBridgeRopeRuns(ctx, span, palette);

        ctx.strokeStyle = palette.railDark;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        this._strokeBridgeCurve(ctx, railLeft);
        this._strokeBridgeCurve(ctx, railRight);
        ctx.strokeStyle = palette.railMid;
        ctx.lineWidth = 2;
        this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, -span.halfWidth - 4, 27, 0, 14));
        this._strokeBridgeCurve(ctx, this._bridgeSidePoints(span, span.halfWidth + 2, 27, 0, 14));

        for (const t of [0, 1]) {
            for (const side of [-1, 1]) {
                const base = this._bridgePoint(span, t, side * (span.halfWidth + 7), 0, 5);
                ctx.fillStyle = palette.railDark;
                ctx.beginPath();
                ctx.arc(base.x, base.y - 14, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = palette.deckC;
                ctx.beginPath();
                ctx.arc(base.x - 1, base.y - 16, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        this._drawBridgeAccentSprites(ctx, span, palette);
        ctx.restore();
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

    _drawWorldBaseShadow(ctx) {
        const points = this._worldDiamondPoints();
        ctx.save();
        ctx.translate(0, 34);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.46)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
        ctx.shadowBlur = 48;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.fill();

        ctx.translate(0, 18);
        ctx.fillStyle = 'rgba(30, 17, 9, 0.22)';
        ctx.shadowColor = 'rgba(83, 50, 18, 0.28)';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawWorldEdgeRim(ctx) {
        const points = this._worldDiamondPoints();
        ctx.save();
        const sideGradient = ctx.createLinearGradient(0, points[0].y, 0, points[2].y + 44);
        sideGradient.addColorStop(0, 'rgba(87, 62, 31, 0.10)');
        sideGradient.addColorStop(0.55, 'rgba(44, 28, 16, 0.34)');
        sideGradient.addColorStop(1, 'rgba(13, 9, 7, 0.62)');
        ctx.fillStyle = sideGradient;
        ctx.beginPath();
        ctx.moveTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.lineTo(points[2].x, points[2].y + 38);
        ctx.lineTo(points[1].x - 26, points[1].y + 24);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(points[2].x, points[2].y);
        ctx.lineTo(points[3].x, points[3].y);
        ctx.lineTo(points[3].x + 26, points[3].y + 24);
        ctx.lineTo(points[2].x, points[2].y + 38);
        ctx.closePath();
        ctx.fill();

        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(238, 191, 94, 0.24)';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.stroke();

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.52)';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y + 2);
        ctx.lineTo(points[1].x - 2, points[1].y + 1);
        ctx.lineTo(points[2].x, points[2].y - 1);
        ctx.lineTo(points[3].x + 2, points[3].y + 1);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    // Distant sea + horizon beyond the island. Drawn per-frame in world space,
    // BEHIND the terrain (which is opaque over it), so it only fills the void
    // around and below the diamond — turning the flat edge into a coastline.
    // Phase-tinted: the top fades out of the sky's own horizon colour so sea
    // and sky meet seamlessly. Static under reduced motion (pure gradient).
    _drawDistantSeaHorizon(ctx, atmosphere) {
        const points = this._worldDiamondPoints();
        const equatorY = points[1].y;          // diamond's widest screen row
        const seaTop = equatorY - 60;          // horizon a touch above the equator
        const seaBottom = points[2].y + 560;   // deep into the void below the south wall
        const leftX = points[3].x - 1400;
        const rightX = points[1].x + 1400;

        const phase = atmosphere?.phase || 'day';
        const deep = phase === 'night'
            ? { shallow: '#1a3a5e', deep: '#0a1c34' }
            : phase === 'dusk'
                ? { shallow: '#6a6390', deep: '#3b3860' }
                : phase === 'dawn'
                    ? { shallow: '#6f8fb8', deep: '#445e8a' }
                    : { shallow: '#5aa0c8', deep: '#2f6e9b' };
        const horizon = atmosphere?.sky?.palette?.horizon || '#8fb9cf';

        ctx.save();
        const grad = ctx.createLinearGradient(0, seaTop, 0, seaBottom);
        grad.addColorStop(0, horizon);
        grad.addColorStop(0.16, deep.shallow);
        grad.addColorStop(1, deep.deep);
        ctx.fillStyle = grad;
        ctx.fillRect(leftX, seaTop, rightX - leftX, seaBottom - seaTop);

        // Soft horizon haze band where sea meets sky.
        const haze = ctx.createLinearGradient(0, seaTop - 30, 0, seaTop + 30);
        haze.addColorStop(0, 'rgba(255, 255, 255, 0)');
        haze.addColorStop(0.5, phase === 'night' ? 'rgba(120, 150, 190, 0.18)' : 'rgba(240, 250, 255, 0.34)');
        haze.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = haze;
        ctx.fillRect(leftX, seaTop - 30, rightX - leftX, 60);

        // A few faint distant swell lines for depth (skipped under reduced motion
        // only for the drift; the static lines themselves stay).
        ctx.strokeStyle = phase === 'night' ? 'rgba(150, 180, 215, 0.10)' : 'rgba(235, 248, 255, 0.16)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
            const ly = seaTop + 40 + i * 70;
            ctx.beginPath();
            ctx.moveTo(leftX, ly);
            ctx.lineTo(rightX, ly);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawDioramaBackdrop(ctx) {
        const points = this._worldDiamondPoints();
        const gradient = ctx.createLinearGradient(0, points[0].y - 80, 0, points[2].y + 120);
        gradient.addColorStop(0, 'rgba(33, 58, 59, 0.16)');
        gradient.addColorStop(0.42, 'rgba(77, 52, 26, 0.08)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
        ctx.save();
        ctx.translate(0, 12);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y - 44);
        ctx.lineTo(points[1].x + 78, points[1].y + 18);
        ctx.lineTo(points[2].x, points[2].y + 86);
        ctx.lineTo(points[3].x - 78, points[3].y + 18);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawDistrictAtmosphere(ctx) {
        const zoom = this.camera?.zoom || 1;
        const intensity = Math.max(0.38, Math.min(1, (3.4 - zoom) / 2.2));
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        for (const wash of DISTRICT_WASHES) {
            const x = (wash.x - wash.y) * TILE_WIDTH / 2;
            const y = (wash.x + wash.y) * TILE_HEIGHT / 2;
            const radius = Math.max(wash.radiusX * TILE_WIDTH, wash.radiusY * TILE_HEIGHT);
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
            gradient.addColorStop(0, this._withAlpha(wash.color, wash.alpha * intensity));
            gradient.addColorStop(0.62, this._withAlpha(wash.color, wash.alpha * 0.38 * intensity));
            gradient.addColorStop(1, this._withAlpha(wash.color, 0));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.ellipse(x, y, wash.radiusX * TILE_WIDTH / 2, wash.radiusY * TILE_HEIGHT / 2, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = `rgba(247, 205, 116, ${0.04 * intensity})`;
        ctx.lineWidth = 1;
        const points = this._worldDiamondPoints();
        for (let i = 1; i <= 4; i++) {
            const inset = i * 34;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y + inset);
            ctx.lineTo(points[1].x - inset * 0.7, points[1].y + inset * 0.34);
            ctx.lineTo(points[2].x, points[2].y - inset);
            ctx.lineTo(points[3].x + inset * 0.7, points[3].y + inset * 0.34);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawRiverContourLines(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = this.deepWaterTiles.has(key) ? 'rgba(5, 19, 42, 0.42)' : 'rgba(124, 205, 232, 0.30)';
                ctx.lineWidth = this.deepWaterTiles.has(key) ? 2 : 1;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }
        ctx.restore();
    }

    _drawWaterFoamLines(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                ctx.strokeStyle = `rgba(221, 249, 255, ${0.18 + seed * 0.09})`;
                ctx.lineWidth = this.deepWaterTiles.has(key) ? 1.4 : 1;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }

        if (this.bridgeTiles) {
            for (const [key, info] of this.bridgeTiles.entries()) {
                if (info?.kind !== 'dock') continue;
                const comma = key.indexOf(',');
                const x = Number(key.slice(0, comma));
                const y = Number(key.slice(comma + 1));
                if (x < startX || x > endX || y < startY || y > endY) continue;
                const edge = this._dockWaterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = 'rgba(238, 252, 238, 0.28)';
                ctx.lineWidth = 1.6;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }
        ctx.restore();
    }

    _waterEdgeMask(tileX, tileY) {
        let mask = 0;
        if (!this.waterTiles.has(`${tileX},${tileY - 1}`)) mask |= 1;
        if (!this.waterTiles.has(`${tileX + 1},${tileY}`)) mask |= 2;
        if (!this.waterTiles.has(`${tileX},${tileY + 1}`)) mask |= 4;
        if (!this.waterTiles.has(`${tileX - 1},${tileY}`)) mask |= 8;
        return mask;
    }

    _shoreWaterEdgeMask(tileX, tileY) {
        let mask = 0;
        if (this._isOpenWaterTile(tileX, tileY - 1)) mask |= 1;
        if (this._isOpenWaterTile(tileX + 1, tileY)) mask |= 2;
        if (this._isOpenWaterTile(tileX, tileY + 1)) mask |= 4;
        if (this._isOpenWaterTile(tileX - 1, tileY)) mask |= 8;
        return mask;
    }

    _dockWaterEdgeMask(tileX, tileY) {
        let mask = 0;
        if (this._isOpenWaterTile(tileX, tileY - 1)) mask |= 1;
        if (this._isOpenWaterTile(tileX + 1, tileY)) mask |= 2;
        if (this._isOpenWaterTile(tileX, tileY + 1)) mask |= 4;
        if (this._isOpenWaterTile(tileX - 1, tileY)) mask |= 8;
        return mask;
    }

    _isOpenWaterTile(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        return this.waterTiles.has(key) && !this.bridgeTiles?.has(key);
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

    _isHarborWater(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        const region = this._waterRegionAt(tileX, tileY, key);
        return region === 'harbor' || this._waterProfileAt(tileX, tileY, key) === 'harbor';
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

    _strokeDiamondEdges(ctx, screenX, screenY, mask) {
        const top = { x: screenX, y: screenY - TILE_HEIGHT / 2 };
        const right = { x: screenX + TILE_WIDTH / 2, y: screenY };
        const bottom = { x: screenX, y: screenY + TILE_HEIGHT / 2 };
        const left = { x: screenX - TILE_WIDTH / 2, y: screenY };
        if (mask & 1) this._strokeSegment(ctx, left, top);
        if (mask & 2) this._strokeSegment(ctx, top, right);
        if (mask & 4) this._strokeSegment(ctx, right, bottom);
        if (mask & 8) this._strokeSegment(ctx, bottom, left);
    }

    _strokeInsetDiamondEdges(ctx, screenX, screenY, mask, inset = 6) {
        const top = { x: screenX, y: screenY - TILE_HEIGHT / 2 + inset * 0.45 };
        const right = { x: screenX + TILE_WIDTH / 2 - inset, y: screenY };
        const bottom = { x: screenX, y: screenY + TILE_HEIGHT / 2 - inset * 0.45 };
        const left = { x: screenX - TILE_WIDTH / 2 + inset, y: screenY };
        if (mask & 1) this._strokeSegment(ctx, left, top);
        if (mask & 2) this._strokeSegment(ctx, top, right);
        if (mask & 4) this._strokeSegment(ctx, right, bottom);
        if (mask & 8) this._strokeSegment(ctx, bottom, left);
    }

    _strokeSegment(ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    _drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY) {
        const isDeep = this.deepWaterTiles.has(`${tileX},${tileY}`);
        const openSea = this._isOpenSeaTile(tileX, tileY);
        const token = this._waterTokenAt(tileX, tileY);
        ctx.fillStyle = isDeep
            ? `rgba(0, ${openSea ? 8 : 12}, ${openSea ? 42 : 34}, ${openSea ? 0.42 : 0.32})`
            : 'rgba(5, 34, 61, 0.18)';
        ctx.beginPath();
        ctx.moveTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + 2);
        ctx.closePath();
        ctx.fill();

        const glint = this.motionScale
            ? 0.04 + Math.max(0, Math.sin(this.waterFrame * 1.6 + tileX * 0.7 - tileY * 0.4 + seed * 5)) * 0.09
            : 0.055;
        const light = `rgb(${token.glint})`;
        ctx.strokeStyle = this._withAlpha(light, Math.min(openSea ? 0.22 : 0.18, glint + (isDeep ? 0.02 : 0.05)));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 18 + seed * 6, screenY - 6);
        ctx.lineTo(screenX + 3 + seed * 10, screenY - 10);
        ctx.stroke();
    }

    _drawShoreCrest(ctx, screenX, screenY, seed, tileX, tileY) {
        const adjacentWater = this.waterTiles.has(`${tileX},${tileY - 1}`)
            || this.waterTiles.has(`${tileX + 1},${tileY}`)
            || this.waterTiles.has(`${tileX},${tileY + 1}`)
            || this.waterTiles.has(`${tileX - 1},${tileY}`);

        // B1: foam wash only where the adjacent water is lagoon-kind.
        if (adjacentWater) {
            const adjacentLagoon = this._isLagoonWaterTile(tileX, tileY - 1)
                || this._isLagoonWaterTile(tileX + 1, tileY)
                || this._isLagoonWaterTile(tileX, tileY + 1)
                || this._isLagoonWaterTile(tileX - 1, tileY);
            if (adjacentLagoon) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const drewFoamSprite = this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.shoreFoam, {
                    x: screenX + (seed - 0.5) * 10,
                    y: screenY - 2 + (seed - 0.5) * 5,
                    alpha: 0.18 + seed * 0.10,
                    scaleX: 0.68 + seed * 0.24,
                    scaleY: 0.58 + seed * 0.18,
                    rotation: -0.45 + seed * 0.9,
                    flipX: seed > 0.5,
                });
                if (!drewFoamSprite) {
                    const foamRadius = TILE_WIDTH * 0.7;
                    const foamGrad = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, foamRadius);
                    foamGrad.addColorStop(0, 'rgba(220, 240, 250, 0.22)');
                    foamGrad.addColorStop(1, 'rgba(220, 240, 250, 0)');
                    ctx.fillStyle = foamGrad;
                    ctx.beginPath();
                    ctx.arc(screenX, screenY, foamRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        ctx.fillStyle = adjacentWater
            ? `rgba(226, 190, 102, ${0.08 + seed * 0.06})`
            : `rgba(87, 70, 36, ${0.07 + seed * 0.04})`;
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2 + 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2 - 5, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2 - 3);
        ctx.lineTo(screenX - TILE_WIDTH / 2 + 5, screenY);
        ctx.closePath();
        ctx.fill();
    }

    _drawPathInsetShadow(ctx, screenX, screenY, seed, tileX, tileY) {
        const isSquare = this.townSquareTiles.has(`${tileX},${tileY}`);
        ctx.strokeStyle = isSquare
            ? `rgba(26, 18, 11, ${0.10 + seed * 0.04})`
            : `rgba(20, 13, 7, ${0.08 + seed * 0.035})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 18, screenY + 1);
        ctx.lineTo(screenX, screenY + 9);
        ctx.lineTo(screenX + 18, screenY + 1);
        ctx.stroke();
    }

    _drawTerrainTone(ctx, screenX, screenY, key, seed, tileX, tileY) {
        let fill = null;
        let alpha = 0;
        const visualWater = this._isVisualWaterTile(tileX, tileY, key);

        const isLagoon = this._isLagoonWaterTile(tileX, tileY, key);
        const waterToken = visualWater ? this._waterTokenAt(tileX, tileY, key) : null;
        if (this.deepWaterTiles.has(key)) {
            const openSea = this._isOpenSeaTile(tileX, tileY);
            if (isLagoon) {
                // Stable cached base; weather-specific water response lives in dynamic passes.
                fill = waterToken.deep;
                alpha = 0.48;
            } else {
                fill = seed > 0.5 ? waterToken.deep : (openSea ? '#03244a' : '#0b6c8d');
                alpha = openSea ? 0.58 : 0.48;
            }
        } else if (visualWater) {
            if (isLagoon) {
                // Stable cached base; weather-specific water response lives in dynamic passes.
                fill = waterToken.shallow;
            } else {
                fill = seed > 0.5 ? waterToken.shallow : WATER_TOKENS.water.shallow;
            }
            alpha = this.waterTiles.has(key) ? 0.42 : 0.54;
        } else if (this.shoreTiles.has(key)) {
            fill = seed > 0.45 ? '#c29a55' : '#ad8346';
            alpha = 0.15;
        } else if (this.townSquareTiles.has(key)) {
            fill = '#2d2219';
            alpha = 0.09;
        } else if (this.mainAvenueTiles?.has(key)) {
            fill = '#3a2a18';
            alpha = 0.07;
        } else if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) {
            fill = '#2f2818';
            alpha = 0.055;
        } else {
            const forestFloor = this._forestFloorAt(tileX, tileY);
            if (forestFloor) {
                const mix = this._tileNoise(tileX + 709, tileY + 431);
                fill = mix > 0.56 ? forestFloor.accent : forestFloor.base;
                alpha = 0.18 + forestFloor.strength * 0.20;
            } else {
                const broad = this._tileNoise(Math.floor(tileX / 5) + 97, Math.floor(tileY / 5) + 131);
                fill = broad > 0.68 ? '#537339' : broad < 0.26 ? '#6d8742' : '#5d7c3c';
                alpha = 0.11;
            }
        }

        if (!fill || alpha <= 0) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this._withAlpha(fill, alpha);
        this._drawDiamond(ctx, screenX, screenY);
        ctx.fill();

        const allowRegionTint = !visualWater && !this.shoreTiles.has(key);
        const regionTone = allowRegionTint ? this._terrainRegionTint(fill, tileX, tileY, seed) : null;
        if (regionTone && regionTone !== fill) {
            const regionAlpha = Math.min(0.08, alpha * 0.45);
            ctx.fillStyle = this._withAlpha(regionTone, regionAlpha);
            this._drawDiamond(ctx, screenX, screenY);
            ctx.fill();
        }

        const forestFloor = allowRegionTint ? this._forestFloorAt(tileX, tileY) : null;
        if (forestFloor) {
            this._drawForestFloorTexture(ctx, screenX, screenY, seed, forestFloor);
        }

        if (visualWater && this.motionScale && seed > 0.72) {
            const shimmer = 0.05 + Math.max(0, Math.sin(this.waterFrame * 2.2 + seed * 10)) * 0.06;
            // A3: warm tropical teal shimmer for lagoon, cool blue-white for sea.
            ctx.strokeStyle = isLagoon
                ? `rgba(120, 230, 200, ${shimmer})`
                : `rgba(188, 253, 246, ${shimmer})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(screenX - 12, screenY - 2);
            ctx.lineTo(screenX + 10, screenY - 6);
            ctx.stroke();
        }
        if (visualWater) {
            this._drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.shoreTiles.has(key)) {
            this._drawShoreCrest(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) {
            this._drawPathInsetShadow(ctx, screenX, screenY, seed, tileX, tileY);
        }
        ctx.restore();
    }

    _forestFloorAt(tileX, tileY) {
        let strongest = null;
        for (const region of FOREST_FLOOR_REGIONS) {
            const dx = (tileX + 0.5 - region.centerX) / region.radiusX;
            const dy = (tileY + 0.5 - region.centerY) / region.radiusY;
            const distance = dx * dx + dy * dy;
            if (distance > 1) continue;
            const edge = 1 - distance;
            const ragged = (this._tileNoise(tileX + 593, tileY + 277) - 0.5) * 0.18;
            const strength = Math.max(0, Math.min(1, (edge + ragged) * region.strength));
            if (strength <= 0.05) continue;
            if (!strongest || strength > strongest.strength) {
                strongest = {
                    base: region.base,
                    accent: region.accent,
                    strength,
                };
            }
        }
        return strongest;
    }

    _drawForestFloorTexture(ctx, screenX, screenY, seed, forestFloor) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgba(34, 52, 12, ${0.035 + forestFloor.strength * 0.075})`;
        this._drawDiamond(ctx, screenX, screenY);
        ctx.fill();

        if (seed > 0.34) {
            ctx.globalCompositeOperation = 'screen';
            ctx.lineCap = 'round';
            ctx.lineWidth = 1;
            const alpha = 0.035 + forestFloor.strength * 0.07;
            ctx.strokeStyle = `rgba(209, 236, 104, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(screenX - 17 + seed * 5, screenY - 3);
            ctx.quadraticCurveTo(screenX - 5, screenY - 9 - seed * 2, screenX + 14 - seed * 3, screenY - 6);
            ctx.stroke();
        }

        if (seed > 0.78) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(252, 216, 118, ${0.09 + forestFloor.strength * 0.06})`;
            ctx.fillRect(Math.round(screenX - 2), Math.round(screenY - 9), 2, 2);
            ctx.fillStyle = `rgba(153, 221, 82, ${0.11 + forestFloor.strength * 0.08})`;
            ctx.fillRect(Math.round(screenX + 7), Math.round(screenY - 4), 2, 1);
        }
        ctx.restore();
    }

    _drawFantasyForestTree(ctx, x, y, tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(
            cached.canvas,
            Math.round(x - cached.anchorX),
            Math.round(y - cached.anchorY)
        );
        ctx.restore();
    }

    _getFantasyForestTreeCache(tree) {
        const scaleBucket = Math.round((tree.scale ?? 1) * 100);
        const seedBucket = Math.round((tree.seed ?? 0.5) * 100);
        const variant = tree.variant ?? 1;
        const key = `${variant}:${scaleBucket}:${seedBucket}`;
        const existing = this.fantasyForestTreeCache.get(key);
        if (existing) return existing;

        const scale = scaleBucket / 100;
        const seed = seedBucket / 100;
        const baseWidth = variant === 3 ? 104 : variant === 2 ? 96 : variant === 1 ? 72 : 92;
        const topHeight = variant === 3 ? 92 : variant === 2 ? 100 : variant === 1 ? 82 : 84;
        const bottomPad = 16;
        const padding = 8;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(baseWidth * scale) + padding * 2;
        canvas.height = Math.ceil((topHeight + bottomPad) * scale) + padding * 2;
        const anchorX = Math.round(canvas.width / 2);
        const anchorY = Math.round(topHeight * scale) + padding;
        const cacheCtx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(cacheCtx);
        cacheCtx.translate(anchorX, anchorY);
        cacheCtx.scale(scale, scale);
        this._drawFantasyForestTreeBody(cacheCtx, seed, variant);

        const cached = { canvas, anchorX, anchorY };
        this.fantasyForestTreeCache.set(key, cached);
        return cached;
    }

    _drawFantasyForestTreeBody(ctx, seed, variant) {
        ctx.fillStyle = `rgba(6, 15, 8, ${0.24 + seed * 0.10})`;
        ctx.beginPath();
        ctx.ellipse(0, 2, 20, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        if (variant === 3) {
            this._drawJungleBroadleafSilhouette(ctx, seed);
        } else if (variant === 2) {
            this._drawPalmSilhouette(ctx, seed);
        } else if (variant === 1) {
            this._drawPineSilhouette(ctx, seed);
        } else {
            this._drawOakSilhouette(ctx, seed);
        }
    }

    _drawJungleBroadleafSilhouette(ctx, seed) {
        ctx.save();
        const trunkLean = (seed - 0.5) * 8;
        ctx.fillStyle = '#503016';
        ctx.beginPath();
        ctx.moveTo(-5, 2);
        ctx.lineTo(5, 2);
        ctx.lineTo(8 + trunkLean * 0.35, -46);
        ctx.lineTo(-2 + trunkLean * 0.35, -46);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(28, 16, 8, 0.28)';
        ctx.fillRect(-5, -38, 3, 40);

        const crownX = trunkLean;
        const crownY = -54;
        const leafColors = ['#7ccf45', '#5faf3a', '#3f8d35', '#9bd857'];
        const leaves = [
            { x: -25, y: -8, rx: 30, ry: 12, a: -0.32 },
            { x: 23, y: -10, rx: 32, ry: 12, a: 0.28 },
            { x: -14, y: -24, rx: 25, ry: 13, a: -0.76 },
            { x: 14, y: -27, rx: 27, ry: 13, a: 0.72 },
            { x: -2, y: -34, rx: 24, ry: 12, a: -0.08 },
            { x: -30, y: 6, rx: 21, ry: 10, a: 0.16 },
            { x: 30, y: 4, rx: 22, ry: 10, a: -0.14 },
        ];

        ctx.fillStyle = 'rgba(13, 29, 12, 0.76)';
        for (const leaf of leaves) {
            this._traceBroadLeaf(ctx, crownX + leaf.x + 3, crownY + leaf.y + 5, leaf.rx, leaf.ry, leaf.a);
            ctx.fill();
        }
        for (let i = 0; i < leaves.length; i++) {
            const leaf = leaves[i];
            ctx.fillStyle = leafColors[(i + Math.floor(seed * 4)) % leafColors.length];
            this._traceBroadLeaf(ctx, crownX + leaf.x, crownY + leaf.y, leaf.rx, leaf.ry, leaf.a);
            ctx.fill();
            ctx.strokeStyle = 'rgba(229, 242, 111, 0.16)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(crownX, crownY - 2);
            ctx.lineTo(crownX + leaf.x * 0.72, crownY + leaf.y * 0.72);
            ctx.stroke();
        }

        ctx.fillStyle = '#d49a35';
        ctx.beginPath();
        ctx.arc(crownX - 3, crownY - 1, 3, 0, Math.PI * 2);
        ctx.arc(crownX + 5, crownY + 1, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _traceBroadLeaf(ctx, x, y, radiusX, radiusY, angle) {
        ctx.beginPath();
        ctx.ellipse(x, y, radiusX, radiusY, angle, 0, Math.PI * 2);
        ctx.closePath();
    }

    _drawPalmSilhouette(ctx, seed) {
        const lean = (seed - 0.5) * 12;
        ctx.save();
        ctx.translate(lean * 0.18, 0);

        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#3d2517';
        ctx.beginPath();
        ctx.moveTo(-4, 1);
        ctx.quadraticCurveTo(-8 + lean * 0.18, -33, lean, -69);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#7a4d26';
        ctx.beginPath();
        ctx.moveTo(-1, -1);
        ctx.quadraticCurveTo(-5 + lean * 0.18, -34, lean + 2, -68);
        ctx.stroke();

        const crownX = lean;
        const crownY = -72;
        ctx.fillStyle = '#172414';
        for (let i = 0; i < 7; i++) {
            const angle = -Math.PI * 0.96 + i * (Math.PI * 1.92 / 6);
            this._tracePalmFrond(ctx, crownX + 2, crownY + 4, angle, 39 + (i % 2) * 7, 15);
            ctx.fill();
        }

        const greens = ['#91d34f', '#69b844', '#4a973a', '#2f7532'];
        for (let i = 0; i < 8; i++) {
            const angle = -Math.PI * 0.98 + i * (Math.PI * 1.96 / 7);
            ctx.fillStyle = greens[(i + Math.floor(seed * 4)) % greens.length];
            this._tracePalmFrond(ctx, crownX, crownY, angle, 40 + ((i + 1) % 3) * 8, 13 + (i % 2) * 3);
            ctx.fill();
            ctx.strokeStyle = 'rgba(231, 247, 111, 0.20)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(crownX, crownY);
            ctx.lineTo(crownX + Math.cos(angle) * 28, crownY + Math.sin(angle) * 12);
            ctx.stroke();
        }

        ctx.fillStyle = '#c58a32';
        ctx.beginPath();
        ctx.arc(crownX - 3, crownY + 2, 3, 0, Math.PI * 2);
        ctx.arc(crownX + 4, crownY + 3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _tracePalmFrond(ctx, x, y, angle, length, width) {
        const tipX = x + Math.cos(angle) * length;
        const tipY = y + Math.sin(angle) * length * 0.52;
        const normalX = -Math.sin(angle);
        const normalY = Math.cos(angle) * 0.52;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(
            x + Math.cos(angle) * length * 0.42 + normalX * width,
            y + Math.sin(angle) * length * 0.26 + normalY * width,
            tipX,
            tipY
        );
        ctx.quadraticCurveTo(
            x + Math.cos(angle) * length * 0.38 - normalX * width * 0.54,
            y + Math.sin(angle) * length * 0.24 - normalY * width * 0.54,
            x,
            y
        );
        ctx.closePath();
    }

    _drawPineSilhouette(ctx, seed) {
        const trunkHeight = 30;
        ctx.fillStyle = '#4a2919';
        ctx.fillRect(-4, -trunkHeight, 8, trunkHeight + 5);
        ctx.fillStyle = '#24130d';
        ctx.fillRect(-4, -trunkHeight, 2, trunkHeight + 4);

        const layers = [
            { y: -70, w: 22, h: 22, color: seed > 0.45 ? '#3f8b42' : '#34783b' },
            { y: -54, w: 30, h: 25, color: seed > 0.50 ? '#2f7437' : '#286832' },
            { y: -36, w: 38, h: 27, color: seed > 0.35 ? '#255d31' : '#1f542e' },
            { y: -17, w: 45, h: 25, color: '#1b4528' },
        ];

        for (const layer of layers) {
            ctx.fillStyle = '#102216';
            this._tracePineLayer(ctx, layer.y + 3, layer.w + 3, layer.h);
            ctx.fill();
            ctx.fillStyle = layer.color;
            this._tracePineLayer(ctx, layer.y, layer.w, layer.h);
            ctx.fill();
            ctx.strokeStyle = 'rgba(158, 214, 91, 0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-layer.w * 0.34, layer.y + layer.h * 0.34);
            ctx.lineTo(0, layer.y + 3);
            ctx.lineTo(layer.w * 0.28, layer.y + layer.h * 0.30);
            ctx.stroke();
        }
    }

    _tracePineLayer(ctx, y, width, height) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width * 0.52, y + height);
        ctx.lineTo(width * 0.18, y + height - 4);
        ctx.lineTo(width * 0.30, y + height + 4);
        ctx.lineTo(0, y + height - 2);
        ctx.lineTo(-width * 0.30, y + height + 4);
        ctx.lineTo(-width * 0.18, y + height - 4);
        ctx.lineTo(-width * 0.52, y + height);
        ctx.closePath();
    }

    _drawOakSilhouette(ctx, seed) {
        ctx.fillStyle = '#55311d';
        ctx.fillRect(-5, -31, 10, 36);
        ctx.fillStyle = '#2d170e';
        ctx.fillRect(-5, -30, 3, 33);

        const crowns = [
            { x: -17, y: -48, r: 18, color: '#2e6d34' },
            { x: 3, y: -57, r: 22, color: seed > 0.45 ? '#438342' : '#367a3b' },
            { x: 20, y: -43, r: 17, color: '#285f32' },
            { x: -3, y: -34, r: 22, color: '#24582f' },
        ];

        for (const crown of crowns) {
            ctx.fillStyle = '#102214';
            ctx.beginPath();
            ctx.ellipse(crown.x, crown.y + 4, crown.r * 1.05, crown.r * 0.82, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = crown.color;
            ctx.beginPath();
            ctx.ellipse(crown.x, crown.y, crown.r, crown.r * 0.78, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(180, 222, 99, 0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-14, -56);
        ctx.quadraticCurveTo(1, -67, 16, -55);
        ctx.stroke();
    }

    _drawFishSchools(ctx) {
        if (!this.motionScale || !this.sprites || !MARINE_FISH_SCHOOLS.length) return;
        const visible = this._getVisibleTileBounds(2);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const fish of MARINE_FISH_SCHOOLS.slice(0, 12)) {
            const baseX = Math.floor(fish.tileX);
            const baseY = Math.floor(fish.tileY);
            if (baseX < visible.startX || baseX > visible.endX || baseY < visible.startY || baseY > visible.endY) continue;
            const key = `${baseX},${baseY}`;
            const isLagoon = this.lagoonWaterTiles?.has(key);
            if (!this.waterTiles.has(key) || (this.deepWaterTiles.has(key) && !isLagoon) || this.bridgeTiles?.has(key)) continue;
            if (this._isHarborLabelZone(baseX, baseY)) continue;

            const swim = Math.sin(this.waterFrame * 1.4 + fish.phase) * (fish.radius ?? 0.25);
            const drift = Math.cos(this.waterFrame * 0.9 + fish.phase) * 0.12;
            const tileX = fish.tileX + swim;
            const tileY = fish.tileY + drift;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            this.sprites.drawSprite(ctx, fish.id, x, y, { alpha: 0.48 });
        }
        ctx.restore();
    }

    // Calm-water ducks + shoreline herons. Ducks drift on lagoon water with a
    // gentle paddle; herons stand at the shore with a small bob. Reduced motion
    // freezes both in place (still readable).
    _drawWaterfowl(ctx) {
        if (!this.sprites) return;
        const visible = this._getVisibleTileBounds(2);
        ctx.save();
        for (const duck of CALM_WATER_FAUNA) {
            const bx = Math.floor(duck.tileX);
            const by = Math.floor(duck.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            if (!this.waterTiles.has(`${bx},${by}`) || this.bridgeTiles?.has(`${bx},${by}`)) continue;
            const swim = this.motionScale ? Math.sin(this.waterFrame * 0.7 + duck.phase) * (duck.radius ?? 0.15) : 0;
            const drift = this.motionScale ? Math.cos(this.waterFrame * 0.5 + duck.phase) * 0.06 : 0;
            const tileX = duck.tileX + swim;
            const tileY = duck.tileY + drift;
            this.sprites.drawSprite(ctx, duck.id, (tileX - tileY) * TILE_WIDTH / 2, (tileX + tileY) * TILE_HEIGHT / 2);
        }
        for (const heron of SHORE_FAUNA) {
            const bx = Math.floor(heron.tileX);
            const by = Math.floor(heron.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            const bob = this.motionScale ? Math.sin(this.waterFrame * 0.4 + heron.tileX) * 0.5 : 0;
            const x = (heron.tileX - heron.tileY) * TILE_WIDTH / 2;
            const y = (heron.tileX + heron.tileY) * TILE_HEIGHT / 2 + bob;
            this.sprites.drawSprite(ctx, heron.id, x, y);
        }
        ctx.restore();
    }

    // Songbirds flitting on small looping flight paths between the trees of the
    // inhabited belt — the land analogue of the sea gulls. Wing frames cycle
    // when motion is on; a single gliding frame is shown under reduced motion.
    _drawLandBirds(ctx) {
        if (!this.sprites || !LAND_BIRD_ROUTES.length) return;
        if (!this._landBirdRoutes) {
            this._landBirdRoutes = LAND_BIRD_ROUTES.map((r) => ({
                route: this._normalizeGullRoute(r.points),
                speed: r.speed ?? 0.018,
                altitude: r.altitude ?? 26,
                phase: r.phase ?? 0,
                wingRate: r.wingRate ?? 6,
            }));
        }
        const visible = this._getVisibleTileBounds(3);
        ctx.save();
        for (const bird of this._landBirdRoutes) {
            const progress = this.motionScale
                ? ((this.waterFrame * bird.speed + bird.phase) % 1 + 1) % 1
                : bird.phase % 1;
            const p = this._pointOnGullRoute(bird.route, progress);
            const bx = Math.floor(p.tileX);
            const by = Math.floor(p.tileY);
            if (bx < visible.startX - 2 || bx > visible.endX + 2 || by < visible.startY - 2 || by > visible.endY + 2) continue;
            const gx = (p.tileX - p.tileY) * TILE_WIDTH / 2;
            const gy = (p.tileX + p.tileY) * TILE_HEIGHT / 2;
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.ellipse(gx, gy, 4, 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            let frame = 'prop.songbird';
            if (this.motionScale) {
                const f = Math.floor(this.waterFrame * bird.wingRate + bird.phase * 11) % 4;
                frame = f === 0 ? 'prop.songbird.up' : f === 2 ? 'prop.songbird.down' : 'prop.songbird';
            }
            this.sprites.drawSprite(ctx, frame, gx, gy - bird.altitude);
        }
        ctx.restore();
    }

    _isHarborLabelZone(tileX, tileY) {
        return tileX >= 31 && tileX <= 38 && tileY >= 18 && tileY <= 23;
    }

    _buildOpenSeaFlockBirds() {
        const birds = [];

        const waveCount = Math.max(1, Math.ceil(GULL_MAX_POPULATION / GULL_BASE_POPULATION));
        for (let wave = 0; wave < waveCount; wave++) {
            OPEN_SEA_FLOCK_ROUTES.forEach((flock, flockIndex) => {
                const route = this._normalizeGullRoute(flock.route);
                const count = Math.max(1, flock.size || OPEN_SEA_FLOCK_FORMATION.length);
                for (let member = 0; member < count; member++) {
                    const formation = OPEN_SEA_FLOCK_FORMATION[member % OPEN_SEA_FLOCK_FORMATION.length];
                    const seed = (wave + 1) * 31.41 + (flockIndex + 1) * 23.17 + member * 8.31;
                    const activeSpan = 0.70 + ((Math.sin(seed * 1.37) + 1) / 2) * 0.18;
                    birds.push({
                        route,
                        wave,
                        flockIndex,
                        altitude: flock.altitude + ((member + wave) % 4) * 2.8 + wave * 1.4,
                        phase: flock.phase + member * 0.011,
                        memberPhase: seed,
                        sideOffset: formation.side + Math.sin(seed) * 0.10,
                        trailOffset: formation.trail + Math.cos(seed * 0.73) * 0.08,
                        speed: flock.speed * GULL_ROUTE_SPEED_SCALE * (0.82 + wave * 0.07 + (member % 3) * 0.018),
                        wingRate: flock.wingRate * (0.92 + (member % 4) * 0.045),
                        alpha: 0.66 + (member % 3) * 0.08,
                        activeSpan,
                        cycleOffset: ((seed * 0.61803398875) % 1 + 1) % 1,
                        entryIndex: (flockIndex + member + wave * 2) % GULL_OFFMAP_GATEWAYS.length,
                        exitIndex: (flockIndex * 3 + member * 2 + wave) % GULL_OFFMAP_GATEWAYS.length,
                        waypointIndex: (flockIndex + member + wave) % GULL_STAGING_WAYPOINTS.length,
                        orbitRadiusX: 1.55 + ((Math.sin(seed * 0.43) + 1) / 2) * 1.10,
                        orbitRadiusY: 1.05 + ((Math.cos(seed * 0.61) + 1) / 2) * 0.75,
                        orbitStart: seed * 0.27,
                        orbitTurns: 0.72 + ((member + wave) % 3) * 0.22,
                        orbitDirection: (member + flockIndex + wave) % 2 === 0 ? 1 : -1,
                    });
                }
            });
        }

        return birds;
    }

    _normalizeGullRoute(points = []) {
        const routePoints = points.map((point) => ({
            tileX: point.tileX,
            tileY: point.tileY,
        }));
        const cumulative = [0];
        let totalLength = 0;

        for (let i = 0; i < routePoints.length; i++) {
            const from = routePoints[i];
            const to = routePoints[(i + 1) % routePoints.length];
            const length = Math.max(0.001, Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY));
            totalLength += length;
            cumulative.push(totalLength);
        }

        return {
            points: routePoints,
            cumulative,
            totalLength: Math.max(0.001, totalLength),
        };
    }

    _pointOnGullRoute(route, progress) {
        const normalized = ((progress % 1) + 1) % 1;
        const distance = normalized * route.totalLength;
        let segmentIndex = 0;
        for (let i = 0; i < route.points.length; i++) {
            if (distance >= route.cumulative[i] && distance <= route.cumulative[i + 1]) {
                segmentIndex = i;
                break;
            }
        }

        const from = route.points[segmentIndex];
        const to = route.points[(segmentIndex + 1) % route.points.length];
        const startDistance = route.cumulative[segmentIndex];
        const segmentLength = Math.max(0.001, route.cumulative[segmentIndex + 1] - startDistance);
        const t = (distance - startDistance) / segmentLength;
        const dx = to.tileX - from.tileX;
        const dy = to.tileY - from.tileY;
        const length = Math.max(0.001, Math.hypot(dx, dy));

        return {
            tileX: from.tileX + dx * t,
            tileY: from.tileY + dy * t,
            tangentX: dx / length,
            tangentY: dy / length,
        };
    }

    _loopingPick(list, index) {
        return list[((index % list.length) + list.length) % list.length];
    }

    _gullUnitNoise(seed) {
        const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
        return value - Math.floor(value);
    }

    _gullActiveTarget(cycleIndex) {
        const range = GULL_MAX_ACTIVE_TARGET - GULL_MIN_ACTIVE_TARGET;
        return GULL_MIN_ACTIVE_TARGET + Math.floor(this._gullUnitNoise(cycleIndex + 19.37) * (range + 1));
    }

    _isGullCycleEnabled(gull, cycleIndex) {
        const target = this._gullActiveTarget(cycleIndex);
        const rank = this._gullUnitNoise(gull.memberPhase + cycleIndex * 7.31 + gull.wave * 13.7);
        return rank <= Math.min(1, target / (GULL_MAX_POPULATION * 0.72));
    }

    _gullVisitsLighthouse(gull, cycleIndex) {
        return this._gullUnitNoise(gull.memberPhase + cycleIndex * 5.17 + gull.flockIndex * 2.11) < 0.58;
    }

    _lerpPoint(from, to, t) {
        return {
            tileX: from.tileX + (to.tileX - from.tileX) * t,
            tileY: from.tileY + (to.tileY - from.tileY) * t,
        };
    }

    _quadraticPoint(from, control, to, t) {
        const a = this._lerpPoint(from, control, t);
        const b = this._lerpPoint(control, to, t);
        return this._lerpPoint(a, b, t);
    }

    _gullGateway(gull, cycleIndex, kind) {
        const bias = kind === 'exit' ? 3 : 0;
        const baseIndex = kind === 'exit' ? gull.exitIndex : gull.entryIndex;
        return this._loopingPick(GULL_OFFMAP_GATEWAYS, baseIndex + cycleIndex * (kind === 'exit' ? 3 : 2) + bias);
    }

    _gullStagingPoint(gull, cycleIndex, kind) {
        const waypoint = this._loopingPick(
            GULL_STAGING_WAYPOINTS,
            gull.waypointIndex + cycleIndex * (kind === 'exit' ? 2 : 1)
        );
        const routePoint = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.19 + (kind === 'exit' ? 0.37 : 0)) % 1 + 1) % 1
        );
        const mix = kind === 'exit' ? 0.42 : 0.58;
        return {
            tileX: waypoint.tileX * mix + routePoint.tileX * (1 - mix),
            tileY: waypoint.tileY * mix + routePoint.tileY * (1 - mix),
        };
    }

    _gullOrbitPoint(gull, travelT) {
        const angle = gull.orbitStart + travelT * Math.PI * 2 * gull.orbitTurns * gull.orbitDirection;
        const wobble = Math.sin(angle * 1.7 + gull.memberPhase) * 0.18;
        return {
            tileX: GULL_LIGHTHOUSE_HOTSPOT.tileX + Math.cos(angle) * (gull.orbitRadiusX + wobble),
            tileY: GULL_LIGHTHOUSE_HOTSPOT.tileY + Math.sin(angle) * (gull.orbitRadiusY + wobble * 0.65),
        };
    }

    _gullJourneyPoint(gull, cycleIndex, t) {
        const entry = this._gullGateway(gull, cycleIndex, 'entry');
        const exit = this._gullGateway(gull, cycleIndex, 'exit');
        const inbound = this._gullStagingPoint(gull, cycleIndex, 'entry');
        const outbound = this._gullStagingPoint(gull, cycleIndex, 'exit');
        const openWaterMid = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.23 + 0.18) % 1 + 1) % 1
        );
        if (!this._gullVisitsLighthouse(gull, cycleIndex)) {
            if (t < 0.32) {
                return this._quadraticPoint(entry, inbound, inbound, t / 0.32);
            }
            if (t < 0.68) {
                return this._quadraticPoint(inbound, openWaterMid, outbound, (t - 0.32) / 0.36);
            }
            return this._quadraticPoint(outbound, outbound, exit, (t - 0.68) / 0.32);
        }

        const orbitStart = this._gullOrbitPoint(gull, 0);
        const orbitEnd = this._gullOrbitPoint(gull, 1);

        if (t < 0.28) {
            return this._quadraticPoint(entry, inbound, inbound, t / 0.28);
        }
        if (t < 0.44) {
            return this._quadraticPoint(inbound, this._lerpPoint(inbound, orbitStart, 0.55), orbitStart, (t - 0.28) / 0.16);
        }
        if (t < 0.60) {
            return this._gullOrbitPoint(gull, (t - 0.44) / 0.16);
        }
        return this._quadraticPoint(orbitEnd, outbound, exit, (t - 0.60) / 0.40);
    }

    _openSeaGullPositions() {
        const reducedMotion = !this.motionScale;
        const time = this.motionScale ? this.waterFrame : 0;
        return this.openSeaFlockBirds.map((gull) => {
            const rawCycle = time * gull.speed + gull.cycleOffset;
            const cycleIndex = Math.floor(rawCycle);
            // Under reduced motion every gull becomes a deterministic
            // in-flight snapshot — fold cycleOffset back into the active
            // window so birds whose offset > activeSpan still render, and
            // skip the population gate so each route keeps at least one
            // visible bird.
            const cyclePhase = reducedMotion
                ? (gull.cycleOffset % gull.activeSpan)
                : (rawCycle - cycleIndex);
            if (!reducedMotion && !this._isGullCycleEnabled(gull, cycleIndex)) return null;
            if (cyclePhase > gull.activeSpan) return null;

            const journeyT = cyclePhase / gull.activeSpan;
            const routePoint = this._gullJourneyPoint(gull, cycleIndex, journeyT);
            const turnProbe = this._gullJourneyPoint(gull, cycleIndex, Math.min(1, journeyT + 0.006));
            const dx = turnProbe.tileX - routePoint.tileX;
            const dy = turnProbe.tileY - routePoint.tileY;
            const tangentLength = Math.max(0.001, Math.hypot(dx, dy));
            const tangentX = dx / tangentLength;
            const tangentY = dy / tangentLength;
            const sideX = -tangentY;
            const sideY = tangentX;
            const spread = 1 + (this.motionScale ? Math.sin(time * 0.9 + gull.memberPhase) * 0.10 : 0);
            const wander = this.motionScale ? Math.sin(time * 0.72 + gull.memberPhase) * 0.08 : 0;
            const tileX = routePoint.tileX + sideX * gull.sideOffset * spread + tangentX * wander;
            const tileY = routePoint.tileY + sideY * gull.sideOffset * spread + tangentY * wander;
            const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
            const bob = this.motionScale ? Math.sin(time * 1.1 + gull.memberPhase) * 2.4 : 0;
            const screenVx = (dx - dy) * TILE_WIDTH / 2;
            const screenVy = (dx + dy) * TILE_HEIGHT / 2;
            const orbiting = this._gullVisitsLighthouse(gull, cycleIndex)
                && journeyT >= 0.44
                && journeyT <= 0.60;
            const turn = orbiting
                ? gull.orbitDirection * 0.6
                : sideX * dx + sideY * dy;
            const flapFrame = this.motionScale
                ? Math.floor(time * gull.wingRate + gull.memberPhase) % GULL_FLIGHT_FRAMES.length
                : 1;
            const banking = this.motionScale
                && Math.abs(turn + Math.sin(time * 0.55 + gull.memberPhase) * 0.42) > 0.36
                && flapFrame === 1;

            return {
                ...gull,
                tileX,
                tileY,
                x: (tileX - tileY) * TILE_WIDTH / 2,
                y: waterY - gull.altitude + bob,
                waterY,
                wing: this.motionScale ? Math.sin(time * 3.2 + gull.memberPhase) * 1.7 : 0.6,
                frameId: banking ? GULL_BANK_FRAME : GULL_FLIGHT_FRAMES[flapFrame],
                fallbackFrameId: 'prop.gullFlight',
                facing: screenVx < 0 ? -1 : 1,
                screenSpeed: Math.hypot(screenVx, screenVy),
            };
        }).filter(Boolean);
    }

    _isGullFlightTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) {
            return tileX >= -6 && tileX <= MAP_SIZE + 5 && tileY >= -6 && tileY <= MAP_SIZE + 5;
        }

        const lighthouseDx = (tileX - GULL_LIGHTHOUSE_HOTSPOT.tileX) / 4.2;
        const lighthouseDy = (tileY - GULL_LIGHTHOUSE_HOTSPOT.tileY) / 3.0;
        if ((lighthouseDx * lighthouseDx + lighthouseDy * lighthouseDy) <= 1) return true;

        const key = `${tileX},${tileY}`;
        if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) return false;
        if (this._isHarborLabelZone(tileX, tileY)) return false;
        const openness = this._waterOpenness(tileX, tileY);
        if (this._isOpenSeaTile(tileX, tileY, openness)) return true;
        const eastSea = tileX >= 31 && tileY <= 34;
        const crossMapWater = tileY >= 22 && tileY <= 27;
        const northLagoonRun = tileY <= 11 && tileX >= 6;
        const broadLightWater = tileX >= 5 && tileX <= 35 && tileY <= 18;
        if (openness >= 0.38 && (eastSea || crossMapWater || northLagoonRun || broadLightWater)) return true;
        return this.deepWaterTiles.has(key) && openness >= 0.50;
    }

    _isGullInVisibleBounds(gull, bounds) {
        const tileX = Math.floor(gull.tileX);
        const tileY = Math.floor(gull.tileY);
        return tileX >= bounds.startX - 6
            && tileX <= bounds.endX + 6
            && tileY >= bounds.startY - 6
            && tileY <= bounds.endY + 6;
    }

    _drawGullShadow(ctx, gull) {
        const altitudeFade = Math.max(0.035, 0.18 - gull.altitude * 0.0032);
        const shadowWidth = Math.max(5, 15 - gull.altitude * 0.12);
        const shadowHeight = Math.max(2, 5 - gull.altitude * 0.035);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = altitudeFade * gull.alpha;
        ctx.fillStyle = 'rgba(7, 18, 30, 0.32)';
        ctx.beginPath();
        ctx.ellipse(Math.round(gull.x), Math.round(gull.waterY - 2), shadowWidth, shadowHeight, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawGullSprite(ctx, gull) {
        const frameId = this.assets?.get(gull.frameId) ? gull.frameId : gull.fallbackFrameId;
        const img = this.assets?.get(frameId);
        if (!img) return false;
        const [anchorX, anchorY] = this.assets.getAnchor(frameId);
        ctx.save();
        ctx.globalAlpha *= gull.alpha;
        ctx.translate(Math.round(gull.x), Math.round(gull.y));
        ctx.scale(gull.facing, 1);
        ctx.drawImage(img, Math.round(-anchorX), Math.round(-anchorY));
        ctx.restore();
        return true;
    }

    _drawOpenSeaGulls(ctx) {
        if (!this.openSeaFlockBirds.length) return;
        const gulls = this._openSeaGullPositions();
        const visible = this._getVisibleTileBounds(5);
        const visibleGulls = gulls.filter((gull) => {
            const tileX = Math.floor(gull.tileX);
            const tileY = Math.floor(gull.tileY);
            return this._isGullInVisibleBounds(gull, visible)
                && this._isGullFlightTile(tileX, tileY);
        });

        // Single guardian gull orbiting the Pharos Lighthouse beacon. 30s
        // loop, low altitude; falls back to a held pose under reduced motion
        // so the silhouette still reads near the watchtower.
        const watchtowerGull = this._watchtowerGullPosition();
        if (watchtowerGull && this._isGullInVisibleBounds(watchtowerGull, visible)) {
            visibleGulls.push(watchtowerGull);
        }

        if (this.sprites) {
            ctx.save();
            for (const gull of visibleGulls) {
                this._drawGullShadow(ctx, gull);
            }
            for (const gull of visibleGulls) {
                if (!this._drawGullSprite(ctx, gull)) {
                    this.sprites.drawSprite(ctx, 'prop.gullFlight', gull.x, gull.y, { alpha: gull.alpha });
                }
            }
            ctx.restore();
            return;
        }

        ctx.save();
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        for (const gull of visibleGulls) {
            const span = 9;
            const lift = 4.2 + gull.wing;
            ctx.globalAlpha = 0.72;
            ctx.strokeStyle = 'rgba(22, 34, 44, 0.36)';
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(gull.x - span, gull.y + 1);
            ctx.lineTo(gull.x, gull.y - lift + 1);
            ctx.lineTo(gull.x + span, gull.y + 1);
            ctx.stroke();
            ctx.globalAlpha = 0.82;
            ctx.strokeStyle = 'rgba(235, 244, 232, 0.88)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(gull.x - span, gull.y);
            ctx.lineTo(gull.x, gull.y - lift);
            ctx.lineTo(gull.x + span, gull.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Watchtower beacon gull. Single bird looping the Pharos Lighthouse at
    // WATCHTOWER_GULL_ORBIT. Reduced motion (motionScale === 0) pins the gull
    // at the start-of-orbit anchor so the silhouette remains.
    _watchtowerGullPosition() {
        if (!this.assets?.has?.('prop.gullFlight')) return null;
        const motionScale = this.motionScale ?? 1;
        let tileX;
        let tileY;
        let facing = 1;
        let frameId = 'prop.gullFlight.level';
        if (motionScale <= 0) {
            tileX = WATCHTOWER_GULL_FALLBACK_TILE.tileX;
            tileY = WATCHTOWER_GULL_FALLBACK_TILE.tileY;
        } else {
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const t = (now % WATCHTOWER_GULL_ORBIT.periodMs) / WATCHTOWER_GULL_ORBIT.periodMs;
            const angle = t * Math.PI * 2;
            tileX = WATCHTOWER_GULL_ORBIT.centerTileX + Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
            tileY = WATCHTOWER_GULL_ORBIT.centerTileY + Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
            const tangentX = -Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
            const tangentY = Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
            const screenVx = (tangentX - tangentY) * TILE_WIDTH / 2;
            facing = screenVx < 0 ? -1 : 1;
            const flapIndex = Math.floor(now * 0.006) % GULL_FLIGHT_FRAMES.length;
            frameId = GULL_FLIGHT_FRAMES[flapIndex];
        }
        const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
        return {
            tileX,
            tileY,
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: waterY - WATCHTOWER_GULL_ORBIT.altitudePx,
            waterY,
            altitude: WATCHTOWER_GULL_ORBIT.altitudePx,
            alpha: 0.92,
            wing: 0.6,
            frameId,
            fallbackFrameId: 'prop.gullFlight',
            facing,
            screenSpeed: 0,
        };
    }

    _drawDiamond(ctx, screenX, screenY) {
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
    }

    // Map a tile's class to the appropriate Wang tileset id.
    // Priority: water (deep > shallow) > shore > town square > main avenue > path > grass.
    _terrainSheetIdAt(x, y) {
        const key = `${x},${y}`;
        if (this.deepWaterTiles.has(key)) return 'terrain.shallow-deep';
        if (this._isVisualWaterTile(x, y, key)) return 'terrain.shore-shallow';
        if (this.shoreTiles.has(key)) return 'terrain.grass-shore';
        if (this.townSquareTiles.has(key)) return 'terrain.cobble-square';
        if (this.mainAvenueTiles?.has(key)) return 'terrain.grass-cobble';
        if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) return 'terrain.grass-dirt';
        // Pure grass: any tileset works since mask = 0 paints the lower (grass) variant.
        return 'terrain.grass-dirt';
    }

    // True if the neighbour tile (tx, ty) belongs to the same "upper" class
    // as the tileset chosen for the origin tile (originX, originY).
    _sameTerrainClass(originX, originY, tx, ty) {
        const id = this._terrainSheetIdAt(originX, originY);
        const tkey = `${tx},${ty}`;
        if (id === 'terrain.shallow-deep') return this.deepWaterTiles.has(tkey);
        if (id === 'terrain.shore-shallow') return this._isVisualWaterTile(tx, ty, tkey) && !this.deepWaterTiles.has(tkey);
        if (id === 'terrain.grass-shore') return this.shoreTiles.has(tkey);
        if (id === 'terrain.cobble-square') return this.townSquareTiles.has(tkey);
        if (id === 'terrain.grass-cobble') return this.mainAvenueTiles?.has(tkey);
        if (id === 'terrain.grass-dirt') return this.pathTiles.has(tkey) || (this.dirtPathTiles?.has(tkey) ?? false);
        return false;
    }

    _terrainRegionTint(baseColor, tileX, tileY, seed) {
        const broad = this._tileNoise(Math.floor(tileX / 4) + 11, Math.floor(tileY / 4) + 19);
        const wash = this._tileNoise(Math.floor((tileX + tileY) / 7) + 37, Math.floor((tileY - tileX) / 7) + 43);
        if (broad > 0.76) return seed > 0.42 ? '#6e873e' : '#5f7f39';
        if (broad < 0.18) return seed > 0.54 ? '#557438' : '#617b3b';
        if (wash > 0.82) return '#718a43';
        if (wash < 0.12) return '#59783a';
        return baseColor;
    }

    _drawTropicalWaterfalls(ctx) {
        if (!TROPICAL_WATERFALLS.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (const fall of TROPICAL_WATERFALLS) {
            const x = (fall.tileX - fall.tileY) * TILE_WIDTH / 2;
            const y = (fall.tileX + fall.tileY) * TILE_HEIGHT / 2;
            const scale = fall.scale ?? 1;
            const shimmer = this.motionScale
                ? Math.sin(this.waterFrame * 5.2 + (fall.phase ?? 0)) * 2.5
                : 0;

            ctx.save();
            ctx.translate(x, y);
            ctx.scale(scale, scale);

            ctx.fillStyle = 'rgba(91, 68, 39, 0.68)';
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.58, 2);
            ctx.lineTo(-fall.width * 0.28, -fall.height * 0.66);
            ctx.lineTo(0, -fall.height - 10);
            ctx.lineTo(fall.width * 0.42, -fall.height * 0.58);
            ctx.lineTo(fall.width * 0.58, 4);
            ctx.lineTo(0, 12);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = 'rgba(180, 126, 66, 0.42)';
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.42, -4);
            ctx.lineTo(-fall.width * 0.18, -fall.height * 0.62);
            ctx.lineTo(5, -fall.height - 4);
            ctx.lineTo(fall.width * 0.34, -fall.height * 0.50);
            ctx.lineTo(fall.width * 0.42, -3);
            ctx.closePath();
            ctx.fill();

            const stream = ctx.createLinearGradient(0, -fall.height, 0, 8);
            stream.addColorStop(0, 'rgba(202, 255, 250, 0.88)');
            stream.addColorStop(0.52, 'rgba(71, 211, 229, 0.72)');
            stream.addColorStop(1, 'rgba(216, 255, 250, 0.46)');
            ctx.fillStyle = stream;
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.16 + shimmer, -fall.height + 2);
            ctx.bezierCurveTo(-fall.width * 0.30, -fall.height * 0.54, -fall.width * 0.14, -fall.height * 0.28, -fall.width * 0.22, 4);
            ctx.lineTo(fall.width * 0.18, 6);
            ctx.bezierCurveTo(fall.width * 0.24, -fall.height * 0.28, fall.width * 0.12, -fall.height * 0.58, fall.width * 0.18 + shimmer, -fall.height + 2);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(235, 255, 246, 0.72)';
            ctx.lineWidth = 1.2;
            for (let i = -1; i <= 1; i++) {
                ctx.beginPath();
                ctx.moveTo(i * 8 + shimmer * 0.35, -fall.height * 0.86);
                ctx.bezierCurveTo(i * 4 - shimmer, -fall.height * 0.56, i * 7 + shimmer, -fall.height * 0.24, i * 5, 2);
                ctx.stroke();
            }

            // A2: animated expanding ripple ring in the pool.
            if (this.motionScale) {
                const poolBaseRadius = fall.width * 0.46;
                const t = (this.waterFrame % 60) / 60;
                const ringR = t * poolBaseRadius * 1.25;
                const ringAlpha = 0.45 * (1 - t);
                ctx.save();
                ctx.strokeStyle = `rgba(226, 255, 246, ${ringAlpha})`;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.ellipse(0, 7, ringR, ringR * (8 / (fall.width * 0.46)), 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
            // Static pool fill.
            ctx.fillStyle = 'rgba(226, 255, 246, 0.48)';
            ctx.beginPath();
            ctx.ellipse(0, 7, fall.width * 0.46, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        ctx.restore();
    }

    _drawSkyCanopy(ctx, atmosphere = null, dt = 16) {
        const canvas = this._screenViewport();
        if (!canvas || !this.skyRenderer) return;
        ctx.save();
        this._resetScreenTransform(ctx);
        this.skyRenderer.drawCanopy(ctx, { canvas, camera: this.camera, atmosphere, dt });
        ctx.restore();
    }

    _drawEmptyStateWorldCue(ctx) {
        const visibleAgentCount = Array.from(this.agentSprites.values())
            .filter(sprite => !this._isGateTransit(sprite, 'departure'))
            .length;
        if (visibleAgentCount !== 0) return;

        const viewport = this._screenViewport();
        if (!viewport.width || !viewport.height) return;
        const cardWidth = 536;
        const cardHeight = 166;
        const x = Math.round((viewport.width - cardWidth) / 2);
        const y = Math.round(viewport.height * 0.5 - cardHeight / 2);
        const rows = [
            ['Forge', 'Code work'],
            ['Archive', 'Reading/search'],
            ['Harbor', 'Commit ships'],
            ['Mine', 'Token usage'],
        ];

        ctx.save();
        this._resetScreenTransform(ctx);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#121822';
        ctx.fillRect(x, y, cardWidth, cardHeight);
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.72)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cardWidth, cardHeight);
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#f5e6a8';
        ctx.font = '12px "Press Start 2P", monospace';
        ctx.fillText('THE VILLAGE AWAITS', x + 24, y + 22, cardWidth - 48);
        ctx.font = '13px monospace';
        ctx.fillStyle = '#d6e7ee';
        ctx.fillText('Start an AI coding session to summon a villager.', x + 24, y + 52, cardWidth - 48);
        ctx.font = '12px monospace';
        for (let i = 0; i < rows.length; i++) {
            const [label, value] = rows[i];
            const rowY = y + 86 + i * 18;
            ctx.fillStyle = '#8bd7ff';
            ctx.fillText(label, x + 24, rowY, 92);
            ctx.fillStyle = '#d6e7ee';
            ctx.fillText(value, x + 120, rowY, cardWidth - 144);
        }
        ctx.restore();
    }

    _tileToWorld(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _chroniclerWorldPosition(a, b) {
        if (!this.motionScale) {
            const point = this._tileToWorld(a.tileX, a.tileY);
            return { ...point, facing: 1 };
        }
        const loopMs = 16000;
        const pauseMs = 6000;
        const movingMs = (loopMs - pauseMs * 2) / 2;
        const t = (performance.now() % loopMs);
        let progress = 0;
        let from = a;
        let to = b;
        if (t < pauseMs) {
            progress = 0;
        } else if (t < pauseMs + movingMs) {
            progress = (t - pauseMs) / movingMs;
        } else if (t < pauseMs + movingMs + pauseMs) {
            progress = 1;
        } else {
            from = b;
            to = a;
            progress = (t - pauseMs - movingMs - pauseMs) / movingMs;
        }
        const ease = progress * progress * (3 - 2 * progress);
        const tileX = from.tileX + (to.tileX - from.tileX) * ease;
        const tileY = from.tileY + (to.tileY - from.tileY) * ease;
        const point = this._tileToWorld(tileX, tileY);
        return {
            ...point,
            facing: to.tileX >= from.tileX ? 1 : -1,
        };
    }

    _drawChroniclerScaffold(ctx, x, y, facing = 1) {
        const bob = this.motionScale ? Math.sin(this.waterFrame * 2.1) * 1.2 : 0;
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y + bob));
        ctx.scale(facing >= 0 ? 1 : -1, 1);
        ctx.fillStyle = 'rgba(16, 22, 32, 0.24)';
        ctx.beginPath();
        ctx.ellipse(0, 5, 11, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c9b27a';
        ctx.fillRect(-5, -22, 10, 21);
        ctx.fillStyle = '#f3dfb1';
        ctx.fillRect(-4, -31, 8, 8);
        ctx.fillStyle = '#5f4a2f';
        ctx.fillRect(-7, -25, 4, 18);
        ctx.fillRect(3, -25, 4, 18);
        ctx.fillStyle = '#8bd7ff';
        ctx.globalAlpha = 0.42;
        ctx.fillRect(5, -19, 5, 7);
        ctx.restore();
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

    _villageGateLightSources(lighting = null) {
        if (!VILLAGE_GATE) return [];
        const center = this._tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
        const lanternX = center.x;
        // The lantern body draws at base.y - 54 (start.y - 110 + lintelHeight 26
        // + 2 plaque margin + plaqueHeight 14 + chain 14 = base.y - 54). Light
        // source center sits at the lantern body's middle (lanternY + 8 ≈
        // base.y - 46). Earlier value of -96 floated the halo above the lintel.
        const lanternY = center.y - 46;
        const phaseBoost = Math.max(0.6, lighting?.lightBoost ?? 1);
        return [normalizeLightSource({
            id: 'gate.lantern',
            kind: 'point',
            x: lanternX,
            y: lanternY,
            radius: 84,
            color: '#ffd56a',
            intensity: phaseBoost,
            buildingType: 'village.gate',
        })];
    }

    _computeFrameLightSources(atmosphere = null, now = performance.now()) {
        const lighting = atmosphere?.lighting || null;
        const building = this.buildingRenderer?.getLightSources?.(lighting) || [];
        const ambient = [
            ...building,
            ...relationshipLightSources({
                relationship: this.relationshipState,
                agentSprites: this.agentSprites,
                lighting,
            }),
            ...this._familiarMoteLightSources(lighting),
            ...(this.arrivalDeparture?.getLightSources?.({ now }) || []),
            ...this._villageGateLightSources(lighting),
        ];
        return { building, ambient };
    }

    _ambientLightSources(atmosphere = null) {
        if (this._frameLightSources?.ambient) return this._frameLightSources.ambient;
        const { ambient } = this._computeFrameLightSources(atmosphere);
        return ambient;
    }

    _drawAtmosphere(ctx, atmosphere = null, dt = 16, ambientLightSources = null) {
        const canvas = this._screenViewport();
        if (this._shouldUseFastAtmosphere()) {
            this._drawFastAtmosphereWash(ctx, canvas, atmosphere, dt);
            return;
        }
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        const zoom = this.camera?.zoom || 1;
        const grade = atmosphere?.grade || {};
        const zoomAlpha = Math.max(0.16, Math.min(0.46, (3.1 - zoom) / 3.2));
        ctx.globalAlpha = this._quantizedAlpha(Math.min(0.72, zoomAlpha + (grade.overlayAlpha || 0)));
        ctx.drawImage(this._getAtmosphereVignette(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        this.weatherRenderer?.drawForeground(ctx, { canvas, atmosphere, dt });

        // Building light glows: a gentle radial halo, not a saturated disc. The
        // earlier mix paired full-alpha hex colors with a thin edge fade, which
        // read as opaque "UFO" blobs over the buildings. Capping the pass with a
        // low globalAlpha and adding an inner soft step keeps the warm-light
        // hint without washing out the sprite underneath.
        if (this.buildingRenderer) {
            ctx.save();
            const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
            ctx.globalAlpha = this._quantizedAlpha((zoom < 1 ? 0.12 : 0.18) * glowScale);
            for (const light of ambientLightSources || this._ambientLightSources(atmosphere)) {
                if (light.kind && !['point', 'spark', 'orbit', 'arc'].includes(light.kind)) continue;
                const p = this.camera.worldToScreen(light.x, light.y);
                if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
                const radius = light.radius * this.camera.zoom;
                const stamp = this._getLightGlowStamp(light, radius, glowScale * (light.intensity || 1), atmosphere);
                ctx.drawImage(stamp, p.x - radius, p.y - radius, radius * 2, radius * 2);
            }
            ctx.restore();
        }

        ctx.restore();
    }

    _shouldUseFastAtmosphere() {
        const backingPixels = canvasPixelCount(this.canvas);
        return backingPixels >= FAST_ATMOSPHERE_BACKING_PIXELS && (this.camera?.zoom || 1) >= 1.5;
    }

    _drawFastAtmosphereWash(ctx, canvas, atmosphere = null, dt = 16) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const zoom = this.camera?.zoom || 1;
        const grade = atmosphere?.grade || {};
        const zoomAlpha = Math.max(0.16, Math.min(0.46, (3.1 - zoom) / 3.2));
        const alpha = this._quantizedAlpha(Math.min(0.38, (zoomAlpha + (grade.overlayAlpha || 0)) * 0.42));
        if (alpha > 0.01) {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = grade.worldTint || 'rgba(160, 215, 245, 0.05)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const phase = atmosphere?.phase || 'day';
            const wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
            if (phase === 'night') {
                wash.addColorStop(0, 'rgba(44, 78, 126, 0.16)');
                wash.addColorStop(1, 'rgba(2, 6, 14, 0.28)');
            } else if (phase === 'dawn') {
                wash.addColorStop(0, 'rgba(85, 132, 178, 0.10)');
                wash.addColorStop(1, 'rgba(85, 111, 137, 0.14)');
            } else if (phase === 'dusk') {
                wash.addColorStop(0, 'rgba(73, 89, 139, 0.12)');
                wash.addColorStop(1, 'rgba(32, 31, 63, 0.20)');
            } else {
                wash.addColorStop(0, 'rgba(175, 222, 248, 0.05)');
                wash.addColorStop(1, 'rgba(18, 36, 52, 0.07)');
            }
            ctx.globalAlpha = Math.min(0.24, alpha * 0.75);
            ctx.fillStyle = wash;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.globalAlpha = 1;
        this.weatherRenderer?.drawForeground(ctx, { canvas, atmosphere, dt });
        ctx.restore();
    }

    _getLightGlowStamp(light, radius, glowScale = 1, atmosphere = null) {
        const dpr = this._screenDpr();
        const phaseBucket = atmosphere?.cacheKey || 'fallback';
        const key = [
            lightSourceCacheKey(light, phaseBucket),
            Math.round(radius),
            this._quantizedAlpha(glowScale),
            dpr,
        ].join('|');
        const cached = this.lightGradientCache.get(key);
        if (cached) {
            this.lightGradientCache.delete(key);
            this.lightGradientCache.set(key, cached);
            return cached;
        }

        const size = Math.max(2, Math.ceil(radius * 2));
        const stampDpr = Math.max(
            0.1,
            Math.min(dpr, Math.sqrt(MAX_LIGHT_GRADIENT_STAMP_PIXELS / Math.max(1, size * size))),
        );
        const stamp = document.createElement('canvas');
        stamp.width = Math.max(1, Math.round(size * stampDpr));
        stamp.height = Math.max(1, Math.round(size * stampDpr));
        const stampPixels = canvasPixelCount(stamp);
        const shouldCache = stampPixels <= MAX_LIGHT_GRADIENT_STAMP_PIXELS;
        if (shouldCache) {
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
        }
        const stampCtx = stamp.getContext('2d');
        stampCtx.setTransform(stampDpr, 0, 0, stampDpr, 0, 0);
        const glow = stampCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        glow.addColorStop(0, this._withAlpha(light.color, this._quantizedAlpha(0.55 * glowScale)));
        glow.addColorStop(0.42, this._withAlpha(light.color, this._quantizedAlpha(0.18 * glowScale)));
        glow.addColorStop(1, this._withAlpha(light.color, 0));
        stampCtx.fillStyle = glow;
        stampCtx.beginPath();
        stampCtx.arc(radius, radius, radius, 0, Math.PI * 2);
        stampCtx.fill();
        if (shouldCache) this.lightGradientCache.set(key, stamp);
        return stamp;
    }

    _drawLighthouseBeam(ctx, light, atmosphere = null) {
        const signal = (typeof this.harborTraffic?.getActivePushSignal === 'function'
            ? this.harborTraffic.getActivePushSignal()
            : null) || { state: 'idle' };
        const stateName = typeof signal.state === 'string' ? signal.state : 'idle';
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        if (this._beamSignalState !== stateName) {
            this._beamPrevSignalState = this._beamSignalState || 'idle';
            this._beamSignalState = stateName;
            this._beamSignalSince = now;
            this._beamPrevAngle = (typeof this._beamLastIdleAngle === 'number')
                ? this._beamLastIdleAngle
                : -0.34;
        }
        const transitionElapsed = Math.max(0, now - (this._beamSignalSince || now));
        const reducedMotion = this.motionScale <= 0;

        const beaconIntensity = atmosphere?.lighting?.beaconIntensity ?? 0.5;
        const phase = this.motionScale ? this.waterFrame * 0.11 : 0.65;
        const sweep = Math.sin(phase) * 0.28;
        const baseAlpha = (light.alpha ?? 0.12) * (0.45 + beaconIntensity * 0.85) * (light.intensity || 1);
        const length = light.length || 360;
        const farWidth = light.width || 92;
        const nearWidth = Math.max(8, farWidth * 0.13);
        const defaultColor = light.color;

        let primaryAngle = -0.34 + sweep;
        let secondaryAngle = Math.PI - 0.34 + sweep;
        let color = defaultColor;
        let alpha = baseAlpha;
        let lockedSingleBeam = false;

        if (stateName === 'departing' && signal.departingTile) {
            const target = this._tileToWorld(signal.departingTile.tileX, signal.departingTile.tileY);
            const targetAngle = Math.atan2(target.y - light.y, target.x - light.x);
            const lockDuration = 600;
            const t = reducedMotion ? 1 : Math.min(1, transitionElapsed / lockDuration);
            const prev = (typeof this._beamPrevAngle === 'number') ? this._beamPrevAngle : targetAngle;
            const delta = Math.atan2(Math.sin(targetAngle - prev), Math.cos(targetAngle - prev));
            primaryAngle = prev + delta * t;
            secondaryAngle = primaryAngle + Math.PI;
            lockedSingleBeam = true;
            color = (typeof signal.accent === 'string' && signal.accent) ? signal.accent : defaultColor;
        } else if (stateName === 'failed' || stateName === 'rejected') {
            const fallback = stateName === 'failed' ? '#ff755d' : '#ffd34a';
            color = (typeof signal.accent === 'string' && signal.accent) ? signal.accent : fallback;
            if (reducedMotion) {
                alpha = baseAlpha * 0.7;
            } else {
                const strobeOn = Math.floor(transitionElapsed / 200) % 2 === 0;
                alpha = strobeOn ? baseAlpha : 0;
            }
        } else if (stateName === 'untethered') {
            alpha = baseAlpha * 0.4;
            if (this.weatherRenderer && typeof this.weatherRenderer.nudgeFogIntensity === 'function' && !reducedMotion) {
                this.weatherRenderer.nudgeFogIntensity(0.15);
            }
        } else if (stateName === 'pulsing') {
            if (reducedMotion) {
                alpha = baseAlpha * 0.85;
            } else {
                const pulseT = (transitionElapsed % 1500) / 1500;
                const pulse = 0.7 + (Math.sin(pulseT * Math.PI * 2) * 0.5 + 0.5) * 0.3;
                alpha = baseAlpha * pulse;
            }
        }

        if (stateName !== 'departing') {
            this._beamLastIdleAngle = primaryAngle;
        }

        // Punch the beam through fog/rain/storm so it stays legible when the
        // sky is occluded. Multipliers cap at 1.5× alpha and 1.25× bloom; a
        // faint volumetric cone wedge is added at 0.4 alpha to read as light
        // scattering through precipitation. Stacks above the push-signal hue
        // work, inside the same `screen` composite block.
        const weather = atmosphere?.weather;
        let weatherBoost = 1;
        let bloomScale = 1;
        let fogConeAlpha = 0;
        if (weather && (weather.type === 'fog' || weather.type === 'rain' || weather.type === 'storm')) {
            const intensity = Math.max(0, Math.min(1, Number(weather.intensity) || 0));
            if (intensity > 0) {
                weatherBoost = Math.min(1.5, 1 + intensity * 0.6);
                bloomScale = 1 + intensity * 0.25;
                fogConeAlpha = 0.4 * intensity;
            }
        }
        const finalAlpha = alpha * weatherBoost;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 1;
        if (finalAlpha > 0) {
            this._drawBeamWedge(
                ctx, light.x, light.y, primaryAngle, length,
                nearWidth, farWidth, color, finalAlpha, bloomScale,
            );
            if (!lockedSingleBeam) {
                this._drawBeamWedge(
                    ctx, light.x, light.y, secondaryAngle, length * 0.72,
                    nearWidth, farWidth * 0.72, color, finalAlpha * 0.55, bloomScale,
                );
            }
            if (fogConeAlpha > 0) {
                this._drawBeamFogCone(
                    ctx, light.x, light.y, primaryAngle, length,
                    farWidth, fogConeAlpha,
                );
                if (!lockedSingleBeam) {
                    this._drawBeamFogCone(
                        ctx, light.x, light.y, secondaryAngle, length * 0.72,
                        farWidth * 0.72, fogConeAlpha * 0.55,
                    );
                }
            }
        }
        ctx.restore();
    }

    // Faint volumetric cone wedge added on top of the existing beam pass when
    // fog/rain/storm intensity is non-zero. Mirrors the wedge geometry of
    // _drawBeamWedge but uses a white→transparent gradient at low alpha to
    // read as scattered light through weather.
    _drawBeamFogCone(ctx, x, y, angle, length, farWidth, alpha) {
        if (alpha <= 0) return;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const px = -dy;
        const py = dx;
        const farX = x + dx * length;
        const farY = y + dy * length;
        const wedgeWidth = farWidth * 1.10;
        const gradient = ctx.createLinearGradient(x, y, farX, farY);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${this._quantizedAlpha(alpha * 0.85)})`);
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(farX + px * wedgeWidth * 0.5, farY + py * wedgeWidth * 0.5);
        ctx.lineTo(farX - px * wedgeWidth * 0.5, farY - py * wedgeWidth * 0.5);
        ctx.closePath();
        ctx.fill();
    }

    _drawBeamWedge(ctx, x, y, angle, length, nearWidth, farWidth, color, alpha, bloomScale = 1) {
        if (alpha <= 0) return;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const px = -dy;
        const py = dx;
        const farX = x + dx * length;
        const farY = y + dy * length;
        const gradient = ctx.createLinearGradient(x, y, farX, farY);
        gradient.addColorStop(0, this._withAlpha(color, this._quantizedAlpha(alpha * 0.35)));
        gradient.addColorStop(0.58, this._withAlpha(color, this._quantizedAlpha(alpha)));
        gradient.addColorStop(1, this._withAlpha(color, 0));

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x + px * nearWidth * 0.5, y + py * nearWidth * 0.5);
        ctx.lineTo(farX + px * farWidth * 0.5, farY + py * farWidth * 0.5);
        ctx.lineTo(farX - px * farWidth * 0.5, farY - py * farWidth * 0.5);
        ctx.lineTo(x - px * nearWidth * 0.5, y - py * nearWidth * 0.5);
        ctx.closePath();
        ctx.fill();

        // `bloomScale` widens the radial bloom radius under fog/rain/storm
        // so the head of the beam reads through the precipitation.
        const bloomRadius = farWidth * 0.75 * bloomScale;
        const bloom = ctx.createRadialGradient(farX, farY, 0, farX, farY, bloomRadius);
        bloom.addColorStop(0, this._withAlpha(color, this._quantizedAlpha(alpha * 0.28)));
        bloom.addColorStop(1, this._withAlpha(color, 0));
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.ellipse(farX, farY, farWidth * 0.72 * bloomScale, farWidth * 0.22 * bloomScale, angle, 0, Math.PI * 2);
        ctx.fill();
    }

    _getAtmosphereVignette(canvas, atmosphere = null) {
        const dpr = this._screenDpr();
        const cacheKey = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere?.cacheKey || 'fallback'}`;
        if (this.atmosphereVignetteCache && this.atmosphereVignetteCacheKey === cacheKey) {
            return this.atmosphereVignetteCache;
        }

        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        const overlay = document.createElement('canvas');
        overlay.width = Math.max(1, Math.round(canvas.width * dpr));
        overlay.height = Math.max(1, Math.round(canvas.height * dpr));
        const overlayCtx = overlay.getContext('2d');
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const grade = atmosphere?.grade || {};
        const phase = atmosphere?.phase || 'day';

        overlayCtx.fillStyle = grade.worldTint || 'rgba(160, 215, 245, 0.05)';
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const skyWash = overlayCtx.createLinearGradient(0, 0, 0, canvas.height);
        if (phase === 'night') {
            skyWash.addColorStop(0, 'rgba(44, 78, 126, 0.18)');
            skyWash.addColorStop(0.46, 'rgba(20, 39, 74, 0.04)');
            skyWash.addColorStop(1, 'rgba(3, 8, 19, 0.34)');
        } else if (phase === 'dawn') {
            skyWash.addColorStop(0, 'rgba(85, 132, 178, 0.12)');
            skyWash.addColorStop(0.45, 'rgba(226, 187, 160, 0.04)');
            skyWash.addColorStop(1, 'rgba(85, 111, 137, 0.18)');
        } else if (phase === 'dusk') {
            skyWash.addColorStop(0, 'rgba(73, 89, 139, 0.14)');
            skyWash.addColorStop(0.45, 'rgba(179, 139, 160, 0.05)');
            skyWash.addColorStop(1, 'rgba(32, 31, 63, 0.26)');
        } else {
            skyWash.addColorStop(0, 'rgba(175, 222, 248, 0.06)');
            skyWash.addColorStop(0.42, 'rgba(92, 159, 209, 0)');
            skyWash.addColorStop(1, 'rgba(60, 111, 150, 0.08)');
        }
        overlayCtx.fillStyle = skyWash;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const atmosphericCore = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            0,
            canvas.width * 0.5,
            canvas.height * 0.50,
            Math.max(canvas.width, canvas.height) * 0.58,
        );
        atmosphericCore.addColorStop(0, phase === 'day'
            ? 'rgba(220, 245, 255, 0.050)'
            : phase === 'night'
                ? 'rgba(90, 134, 190, 0.060)'
                : 'rgba(199, 195, 220, 0.055)');
        atmosphericCore.addColorStop(0.55, phase === 'night'
            ? 'rgba(28, 56, 98, 0.035)'
            : 'rgba(88, 135, 178, 0.025)');
        atmosphericCore.addColorStop(1, 'rgba(0, 0, 0, 0)');
        overlayCtx.fillStyle = atmosphericCore;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const vignette = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            Math.min(canvas.width, canvas.height) * 0.18,
            canvas.width * 0.5,
            canvas.height * 0.5,
            Math.max(canvas.width, canvas.height) * 0.72,
        );
        const vignetteAlpha = this._quantizedAlpha(grade.vignetteAlpha ?? 0.18);
        vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vignette.addColorStop(0.62, phase === 'night'
            ? `rgba(4, 12, 26, ${vignetteAlpha * 0.20})`
            : `rgba(19, 45, 66, ${vignetteAlpha * 0.12})`);
        vignette.addColorStop(1, phase === 'night'
            ? `rgba(2, 6, 14, ${vignetteAlpha})`
            : `rgba(18, 36, 52, ${vignetteAlpha * 0.62})`);
        overlayCtx.fillStyle = vignette;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        this.atmosphereVignetteCache = overlay;
        this.atmosphereVignetteCacheKey = cacheKey;
        return overlay;
    }

    getCanvasBudget() {
        const sky = this.skyRenderer?.getCanvasBudget?.() || {};
        const trail = this.trailRenderer?.getCanvasBudget?.() || {};
        const volatile = {
            terrain: canvasPixelCount(this.terrainCache),
            sky: sky.volatilePixels || 0,
            trail: trail.volatilePixels || 0,
            atmosphere: canvasPixelCount(this.atmosphereVignetteCache),
            lightGradients: canvasMapPixelCount(this.lightGradientCache),
        };
        const volatilePixels = Object.values(volatile).reduce((sum, value) => sum + value, 0);
        return {
            budgets: CANVAS_BUDGET,
            dpr: this._screenDpr(),
            running: this.running,
            worldModeActive: this._worldModeActive,
            rafPending: this.frameId !== null,
            visibleCanvasPixels: canvasPixelCount(this.canvas),
            volatile,
            volatilePixels,
            retainedAssetPixels: canvasMapPixelCount(this.fantasyForestTreeCache),
            domCanvasPixels: 0,
            cacheCounts: {
                lightGradients: this.lightGradientCache?.size || 0,
                fantasyForestTrees: this.fantasyForestTreeCache?.size || 0,
            },
            terrainCache: this.getTerrainCacheDiagnostics(),
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
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(4, 10, 18, 0.72)';
        ctx.fillRect(12, 58, 520, panelHeight);
        ctx.strokeStyle = 'rgba(142, 204, 255, 0.48)';
        ctx.strokeRect(12.5, 58.5, 520, panelHeight);
        ctx.fillStyle = '#cce9ff';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 20, 66 + i * 14);
        }
        ctx.restore();
    }

    _quantizedAlpha(value) {
        return Math.max(0, Math.min(1, Math.round((Number(value) || 0) * 1000) / 1000));
    }

    // Cache `color` → rgba(r,g,b,a) strings keyed by `${color}|${alpha}` so the
    // light pass doesn't re-parse colors per frame.
    _withAlpha(color, alpha) {
        const key = `${color}|${alpha}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        let r = 255, g = 255, b = 255;
        if (color.startsWith('#') && color.length === 7) {
            r = parseInt(color.slice(1, 3), 16);
            g = parseInt(color.slice(3, 5), 16);
            b = parseInt(color.slice(5, 7), 16);
        } else {
            const m = color.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
        }
        const out = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        this.lightFadeColorCache.set(key, out);
        return out;
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
                this.sprites.drawSprite(ctx, `prop.${prop.type}`, x, y);
            }
            for (const prop of DISTRICT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                this.sprites.drawSprite(ctx, prop.id, x, y);
            }
        }

        for (const prop of this.commandCenterGroundProps) {
            const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
            const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
            if (prop.type === 'banner') this._drawCommandBanner(ctx, x, y, prop.facing || 'north', prop.phase || 0);
            else if (prop.type === 'runestone') this._drawCommandRune(ctx, x, y, prop.phase || 0);
            else if (prop.type === 'watchfire') this._drawCommandWatchfire(ctx, x, y, prop.phase || 0);
            else if (prop.type === 'guardpost') this._drawCommandGuardpost(ctx, x, y);
        }
        ctx.restore();
    }

    _drawCommandApproachRoadDetail(ctx, screenX, screenY, seed, tileX, tileY) {
        const sweep = (tileX + tileY + seed * 8) * 0.35;
        ctx.strokeStyle = `rgba(255, 224, 126, ${0.16 + Math.sin(this.waterFrame * 0.8 + sweep) * 0.05 + 0.06})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 9, screenY - 1 + Math.sin(sweep) * 0.8);
        ctx.lineTo(screenX + 9, screenY - 2 - Math.sin(sweep) * 0.7);
        ctx.stroke();
        if (this.motionScale > 0 && ((tileX + tileY + seed) % 2.8) < 1.2) {
            ctx.fillStyle = 'rgba(255, 191, 91, 0.18)';
            ctx.beginPath();
            ctx.arc(screenX, screenY - 4, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }

        if (this.motionScale > 0 && ((tileX + tileY) % 8 === 0)) {
            const x = screenX + ((seed - 0.5) * 4);
            const y = screenY + ((seed - 0.5) * 2);
            this._drawCommandGuardpost(ctx, x, y);
        }
    }

    _drawCommandBanner(ctx, x, y, facing = 'north', phase = 0) {
        const poleOffset = facing === 'south' ? 1 : -1;
        const clothPulse = this.motionScale ? (Math.sin(this.waterFrame * 3 + phase) + 1) / 2 : 0.5;
        ctx.fillStyle = 'rgba(43, 29, 16, 0.9)';
        ctx.fillRect(x - 1, y - 16, 2, 16);
        ctx.beginPath();
        ctx.moveTo(x + 2, y - 18 - poleOffset * 2);
        ctx.quadraticCurveTo(x + 2 + (facing === 'north' ? -6 : 6), y - 14 - poleOffset * 2, x + (facing === 'north' ? -20 : 20), y - 7);
        ctx.lineTo(x + (facing === 'north' ? -13 : 13), y - 4);
        ctx.lineTo(x + 2, y - 9);
        ctx.closePath();
        const alpha = 0.19 + clothPulse * 0.12;
        ctx.fillStyle = `rgba(218, 189, 95, ${alpha})`;
        ctx.fill();
        ctx.fillStyle = `rgba(154, 112, 38, ${alpha + 0.03})`;
        ctx.beginPath();
        ctx.arc(x + (facing === 'north' ? -10 : 10), y - 6, 2, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawCommandRune(ctx, x, y, phase = 0) {
        const glow = this.motionScale ? 0.14 + Math.sin(this.waterFrame * 4 + phase) * 0.06 : 0.12;
        ctx.strokeStyle = `rgba(152, 234, 255, ${0.45 + glow})`;
        ctx.lineWidth = 1;
        const size = 8;
        const ox = Math.sin(phase + this.waterFrame) * 0.6;
        ctx.beginPath();
        ctx.moveTo(x - size + ox, y - 4);
        ctx.lineTo(x - size * 0.3 + ox, y + 4);
        ctx.lineTo(x + size * 0.3 + ox, y - 2);
        ctx.lineTo(x + size + ox, y + 3);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = `rgba(186, 243, 255, ${0.2 + glow})`;
        ctx.fill();
    }

    _drawCommandWatchfire(ctx, x, y, phase = 0) {
        const flicker = this.motionScale ? Math.max(0, Math.sin(this.waterFrame * 7 + phase)) : 0.5;
        ctx.fillStyle = 'rgba(44, 30, 17, 0.6)';
        ctx.fillRect(x - 2, y - 12, 4, 10);

        const radius = 8 + flicker * 2;
        const outer = `rgba(255, 132, 37, ${0.12 + flicker * 0.08})`;
        const inner = `rgba(255, 216, 122, ${0.20 + flicker * 0.16})`;
        ctx.fillStyle = outer;
        ctx.beginPath();
        ctx.ellipse(x, y - 12, radius, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = inner;
        ctx.beginPath();
        ctx.moveTo(x - 2, y - 17 - flicker * 3);
        ctx.lineTo(x + 2, y - 17 - flicker * 3);
        ctx.lineTo(x, y - 4);
        ctx.closePath();
        ctx.fill();
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

    _drawPathLantern(ctx, x, y) {
        const glow = this.motionScale ? 0.16 + Math.max(0, Math.sin(this.waterFrame * 7 + x)) * 0.12 : 0.2;
        ctx.fillStyle = `rgba(242, 211, 107, ${glow})`;
        ctx.beginPath();
        ctx.arc(x, y - 17, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#4c321f';
        ctx.fillRect(x - 1, y - 18, 2, 19);
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(x - 3, y - 22, 6, 5);
    }

    _drawSignpost(ctx, x, y) {
        ctx.fillStyle = '#4b3020';
        ctx.fillRect(x - 1, y - 16, 3, 19);
        ctx.fillStyle = '#9a6a3b';
        ctx.fillRect(x - 13, y - 16, 24, 6);
        ctx.fillStyle = '#d8b96d';
        ctx.fillRect(x - 10, y - 14, 15, 1.5);
    }

    _drawRunestone(ctx, x, y) {
        ctx.fillStyle = '#303447';
        ctx.beginPath();
        ctx.moveTo(x - 8, y + 2);
        ctx.lineTo(x - 6, y - 18);
        ctx.lineTo(x, y - 25);
        ctx.lineTo(x + 7, y - 17);
        ctx.lineTo(x + 8, y + 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(118, 216, 255, 0.65)';
        ctx.beginPath();
        ctx.moveTo(x - 3, y - 15);
        ctx.lineTo(x + 3, y - 15);
        ctx.moveTo(x, y - 20);
        ctx.lineTo(x, y - 8);
        ctx.stroke();
    }

    _drawScrollCrates(ctx, x, y) {
        ctx.fillStyle = '#5a3a22';
        ctx.fillRect(x - 13, y - 9, 12, 9);
        ctx.fillStyle = '#7c5530';
        ctx.fillRect(x + 1, y - 7, 11, 7);
        ctx.fillStyle = '#ead8a6';
        ctx.fillRect(x - 6, y - 13, 14, 4);
        ctx.fillStyle = '#8d663c';
        ctx.fillRect(x - 2, y - 13, 2, 4);
    }

    _drawSmallOreCart(ctx, x, y) {
        ctx.fillStyle = '#211914';
        ctx.fillRect(x - 12, y - 7, 22, 9);
        ctx.fillStyle = '#8c5f34';
        ctx.fillRect(x - 10, y - 10, 18, 7);
        ctx.fillStyle = '#f5c85b';
        ctx.fillRect(x - 5, y - 12, 3, 3);
        ctx.fillRect(x + 2, y - 13, 2, 2);
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(x - 7, y + 2, 2.5, 0, Math.PI * 2);
        ctx.arc(x + 6, y + 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawVillageWell(ctx, x, y) {
        ctx.fillStyle = 'rgba(40, 28, 19, 0.42)';
        ctx.beginPath();
        ctx.ellipse(x, y + 2, 18, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5d4630';
        ctx.beginPath();
        ctx.ellipse(x, y - 2, 14, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#172f3b';
        ctx.beginPath();
        ctx.ellipse(x, y - 4, 9, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#8a6a3d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 11, y - 6);
        ctx.lineTo(x - 11, y - 25);
        ctx.moveTo(x + 11, y - 6);
        ctx.lineTo(x + 11, y - 25);
        ctx.moveTo(x - 13, y - 25);
        ctx.lineTo(x + 13, y - 25);
        ctx.stroke();
        ctx.fillStyle = '#9b2f24';
        ctx.beginPath();
        ctx.moveTo(x - 17, y - 25);
        ctx.lineTo(x, y - 35);
        ctx.lineTo(x + 17, y - 25);
        ctx.closePath();
        ctx.fill();
    }

    _drawMarketStall(ctx, x, y) {
        ctx.fillStyle = 'rgba(35, 23, 16, 0.4)';
        ctx.beginPath();
        ctx.ellipse(x, y + 2, 20, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5b351f';
        ctx.fillRect(x - 16, y - 10, 32, 9);
        ctx.fillStyle = '#d8b96d';
        ctx.fillRect(x - 12, y - 14, 24, 4);
        ctx.fillStyle = '#a83c2a';
        for (let i = -12; i < 12; i += 8) {
            ctx.fillRect(x + i, y - 18, 5, 8);
        }
        ctx.fillStyle = '#f6da82';
        ctx.fillRect(x - 2, y - 6, 4, 3);
        ctx.fillStyle = '#89b95f';
        ctx.fillRect(x + 7, y - 7, 4, 3);
    }

    _drawFlowerCart(ctx, x, y) {
        ctx.fillStyle = '#6b4225';
        ctx.fillRect(x - 14, y - 9, 24, 8);
        ctx.fillStyle = '#241811';
        ctx.beginPath();
        ctx.arc(x - 9, y, 2.5, 0, Math.PI * 2);
        ctx.arc(x + 8, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        const colors = ['#f6da82', '#e58da4', '#a7d982'];
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = colors[i % colors.length];
            ctx.fillRect(x - 12 + i * 3, y - 13 - (i % 2), 2, 2);
        }
    }

    _drawNoticePillar(ctx, x, y) {
        ctx.fillStyle = '#4a321f';
        ctx.fillRect(x - 2, y - 24, 4, 24);
        ctx.fillStyle = '#d8b96d';
        ctx.fillRect(x - 14, y - 22, 28, 10);
        ctx.strokeStyle = '#342116';
        ctx.strokeRect(x - 14.5, y - 22.5, 29, 11);
        ctx.fillStyle = '#7a1f1f';
        ctx.beginPath();
        ctx.arc(x - 6, y - 17, 2, 0, Math.PI * 2);
        ctx.arc(x + 6, y - 17, 2, 0, Math.PI * 2);
        ctx.fill();
    }


}
