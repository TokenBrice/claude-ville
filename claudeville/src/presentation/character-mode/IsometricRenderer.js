import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { TOWN_ROAD_ROUTES } from '../../config/townPlan.js';
import {
    BRIDGE_ACCENT_PROPS,
    DISTRICT_PROPS,
    FOREST_FLOOR_REGIONS,
    MARINE_FISH_SCHOOLS,
    TROPICAL_BROADLEAF_TREES,
    TROPICAL_PALMS,
    TROPICAL_WATERFALLS,
} from '../../config/scenery.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { AgentSprite } from './AgentSprite.js';
import { BuildingSprite } from './BuildingSprite.js';
import { Minimap } from './Minimap.js';
import { SceneryEngine } from './SceneryEngine.js';
import { Pathfinder } from './Pathfinder.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { SkyRenderer } from './SkyRenderer.js';
import { TerrainTileset } from './TerrainTileset.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';
import { LandmarkActivity } from './LandmarkActivity.js';
import { DebugOverlay } from './DebugOverlay.js';

const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
const WORLD_EDGE_PAD_X = TILE_WIDTH / 2;
const WORLD_EDGE_PAD_Y = TILE_HEIGHT / 2;
const GULL_FLIGHT_FRAMES = [
    'prop.gullFlight.up',
    'prop.gullFlight.level',
    'prop.gullFlight.down',
    'prop.gullFlight.level',
];
const GULL_BANK_FRAME = 'prop.gullFlight.bank';
const GULL_ROUTE_SPEED_SCALE = 0.52;
const GULL_LIGHTHOUSE_HOTSPOT = { tileX: 31.4, tileY: 12.2 };
const GULL_OFFMAP_GATEWAYS = [
    { tileX: -4.8, tileY: 24.8 },
    { tileX: 7.2, tileY: -4.6 },
    { tileX: 22.8, tileY: -5.2 },
    { tileX: 43.8, tileY: 4.8 },
    { tileX: 45.2, tileY: 17.6 },
    { tileX: 43.6, tileY: 34.4 },
    { tileX: 28.2, tileY: 44.6 },
    { tileX: 3.8, tileY: 43.8 },
];
const GULL_STAGING_WAYPOINTS = [
    { tileX: 10.8, tileY: 7.8 },
    { tileX: 19.8, tileY: 9.8 },
    { tileX: 27.4, tileY: 8.2 },
    { tileX: 36.0, tileY: 10.4 },
    { tileX: 35.8, tileY: 23.8 },
    { tileX: 23.4, tileY: 24.8 },
    { tileX: 9.8, tileY: 24.8 },
    { tileX: 34.0, tileY: 29.4 },
];
const OPEN_SEA_FLOCK_FORMATION = [
    { side: 0.00, trail: 0.00 },
    { side: -0.42, trail: 0.36 },
    { side: 0.42, trail: 0.36 },
    { side: -0.82, trail: 0.78 },
    { side: 0.82, trail: 0.78 },
    { side: -1.18, trail: 1.22 },
    { side: 1.18, trail: 1.22 },
    { side: -0.30, trail: 1.58 },
    { side: 0.30, trail: 1.58 },
    { side: 0.00, trail: 1.92 },
];
const OPEN_SEA_FLOCK_ROUTES = [
    {
        size: 8,
        altitude: 38,
        phase: 0.02,
        speed: 0.032,
        wingRate: 3.6,
        route: [
            { tileX: 37.2, tileY: 5.4 },
            { tileX: 33.2, tileY: 2.8 },
            { tileX: 28.7, tileY: 4.8 },
            { tileX: 31.8, tileY: 8.8 },
            { tileX: 37.6, tileY: 9.4 },
        ],
    },
    {
        size: 9,
        altitude: 31,
        phase: 0.24,
        speed: 0.026,
        wingRate: 3.1,
        route: [
            { tileX: 38.4, tileY: 6.2 },
            { tileX: 35.6, tileY: 12.6 },
            { tileX: 37.6, tileY: 17.4 },
            { tileX: 35.2, tileY: 24.8 },
            { tileX: 37.5, tileY: 31.4 },
            { tileX: 39.1, tileY: 20.8 },
        ],
    },
    {
        size: 7,
        altitude: 27,
        phase: 0.47,
        speed: 0.038,
        wingRate: 4.0,
        route: [
            { tileX: 31.6, tileY: 24.7 },
            { tileX: 35.6, tileY: 25.6 },
            { tileX: 38.2, tileY: 28.6 },
            { tileX: 36.0, tileY: 32.6 },
            { tileX: 33.0, tileY: 27.4 },
        ],
    },
    {
        size: 8,
        altitude: 24,
        phase: 0.69,
        speed: 0.021,
        wingRate: 2.9,
        route: [
            { tileX: 2.4, tileY: 25.0 },
            { tileX: 9.0, tileY: 24.8 },
            { tileX: 17.2, tileY: 25.2 },
            { tileX: 25.8, tileY: 24.4 },
            { tileX: 32.8, tileY: 24.4 },
            { tileX: 37.8, tileY: 25.8 },
        ],
    },
    {
        size: 6,
        altitude: 34,
        phase: 0.86,
        speed: 0.024,
        wingRate: 3.4,
        route: [
            { tileX: 7.6, tileY: 8.4 },
            { tileX: 12.3, tileY: 5.4 },
            { tileX: 17.4, tileY: 9.8 },
            { tileX: 24.8, tileY: 7.5 },
            { tileX: 31.0, tileY: 5.0 },
            { tileX: 36.8, tileY: 8.2 },
        ],
    },
];
const GULL_BASE_POPULATION = OPEN_SEA_FLOCK_ROUTES.reduce((sum, flock) => sum + flock.size, 0);
const GULL_MAX_POPULATION = GULL_BASE_POPULATION * 3;
const GULL_MIN_ACTIVE_TARGET = Math.max(1, Math.floor(GULL_BASE_POPULATION / 4));
const GULL_MAX_ACTIVE_TARGET = Math.max(GULL_MIN_ACTIVE_TARGET, Math.floor(GULL_MAX_POPULATION / 2));
const BRIDGE_STYLE_PALETTES = {
    civic: {
        shadow: 'rgba(19, 7, 5, 0.36)',
        underStone: '#4c4a42',
        underStoneDark: '#27241f',
        underStoneLight: '#80745e',
        deckDark: '#3d1b13',
        deckEdge: '#4a2015',
        deckA: '#774326',
        deckB: '#c17a42',
        deckC: '#e1a05d',
        railDark: '#2a0f09',
        railMid: '#8e4528',
        rope: '#d3a45e',
        rune: 'rgba(104, 204, 255, 0.72)',
        glow: 'rgba(85, 195, 255, 0.24)',
        moss: 'rgba(86, 126, 60, 0.45)',
    },
    elderwood: {
        shadow: 'rgba(14, 10, 6, 0.38)',
        underStone: '#3f4a3d',
        underStoneDark: '#20281f',
        underStoneLight: '#71805c',
        deckDark: '#332015',
        deckEdge: '#49301c',
        deckA: '#684b29',
        deckB: '#a26c35',
        deckC: '#d0914f',
        railDark: '#26180f',
        railMid: '#7d542b',
        rope: '#c7a35e',
        rune: 'rgba(149, 226, 133, 0.70)',
        glow: 'rgba(112, 207, 102, 0.22)',
        moss: 'rgba(92, 151, 70, 0.54)',
    },
};
const BRIDGE_SPRITE_MIN_WIDTH = 330;
const BRIDGE_SPRITE_MAX_WIDTH = 420;
const DISTRICT_WASHES = [
    { x: 16, y: 22, radiusX: 10, radiusY: 6, color: '#8b5526', alpha: 0.13 },
    { x: 36, y: 20, radiusX: 10, radiusY: 8, color: '#167178', alpha: 0.14 },
    { x: 7, y: 28, radiusX: 7, radiusY: 5, color: '#7d4b25', alpha: 0.10 },
    { x: 14, y: 16, radiusX: 12, radiusY: 6, color: '#476b2c', alpha: 0.11 },
    { x: 20, y: 28, radiusX: 15, radiusY: 6, color: '#5b5228', alpha: 0.11 },
];
const ANCIENT_RUINS = [
    { tileX: 37, tileY: 3, scale: 1.05 },
    { tileX: 2, tileY: 16, scale: 0.82 },
    { tileX: 36, tileY: 34, scale: 0.95 },
];
const COMMAND_CENTER_DECORATION = [
    { type: 'banner', localX: 1.1, localY: -0.9, facing: 'south', phase: 0 },
    { type: 'banner', localX: 4.8, localY: 0.8, facing: 'north', phase: 1.7 },
    { type: 'runestone', localX: -0.6, localY: 1.2, phase: 0.2 },
    { type: 'runestone', localX: 2.2, localY: 0.0, phase: 2.4 },
    { type: 'runestone', localX: 4.8, localY: 2.4, phase: 4.1 },
    { type: 'watchfire', localX: 0.5, localY: 1.0, phase: 0.6 },
    { type: 'watchfire', localX: 5.0, localY: 0.9, phase: 3.5 },
    { type: 'guardpost', localX: -2.2, localY: 1.0 },
    { type: 'guardpost', localX: 4.9, localY: 1.0 },
    { type: 'guardpost', localX: 2.5, localY: -0.2 },
    { type: 'guardpost', localX: 2.5, localY: 2.5 },
];
const AMBIENT_GROUND_PROPS = [
    // Forge/mine work yards: ore carts and lanterns clarify production/resource landmarks.
    { tileX: 24.4, tileY: 29.7, type: 'oreCart' },
    { tileX: 25.4, tileY: 29.6, type: 'lantern' },
    { tileX: 13.3, tileY: 34.7, type: 'oreCart' },
    { tileX: 9.0, tileY: 33.8, type: 'lantern' },
    { tileX: 15.5, tileY: 34.4, type: 'runestone' },
    { tileX: 22.5, tileY: 33.6, type: 'noticePillar' },

    // Civic core: utility props around the square, not scattered through the woods.
    { tileX: 15.3, tileY: 20.4, type: 'well' },
    { tileX: 12.1, tileY: 20.0, type: 'marketStall' },
    { tileX: 17.8, tileY: 19.4, type: 'signpost' },
    { tileX: 19.2, tileY: 16.0, type: 'scrollCrates' },
    { tileX: 23.6, tileY: 16.8, type: 'noticePillar' },

    // Research edges: fewer, quieter accents near knowledge landmarks.
    { tileX: 3.1, tileY: 24.2, type: 'lantern' },
    { tileX: 6.8, tileY: 23.6, type: 'runestone' },
    { tileX: 22.5, tileY: 15.5, type: 'noticePillar' },
    { tileX: 23.6, tileY: 15.8, type: 'scrollCrates' },
    { tileX: 21.8, tileY: 13.4, type: 'runestone' },
    { tileX: 27.4, tileY: 14.0, type: 'lantern' },
    { tileX: 5.6, tileY: 25.8, type: 'runestone' },
    { tileX: 15.0, tileY: 22.2, type: 'runestone' },
];
class StaticPropSprite {
    constructor({ tileX, tileY, drawFn }) {
        this.tileX = tileX;
        this.tileY = tileY;
        this.x = (tileX - tileY) * TILE_WIDTH / 2;
        this.y = (tileX + tileY) * TILE_HEIGHT / 2;
        this.drawFn = drawFn;
    }
    draw(ctx, zoom) {
        this.drawFn(ctx, this.x, this.y, zoom);
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
        this.skyRenderer = new SkyRenderer({ assets: this.assets });
        this.landmarkActivity = new LandmarkActivity({ world: this.world, sprites: this.sprites });
        this.minimap = new Minimap();
        this.agentSprites = new Map();
        this._sortedSprites = [];
        this._spritesNeedSort = true;
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
        this.fantasyForestTreeCache = new Map();
        this.terrainSeed = [];
        this.waterFrame = 0;
        this.openSeaFlockBirds = this._buildOpenSeaFlockBirds();
        this.motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this.motionScale = this.motionQuery?.matches ? 0 : 1;
        this.particleSystem.setMotionEnabled(this.motionScale > 0);
        this._onMotionPreferenceChange = (event) => this._setMotionScale(event.matches ? 0 : 1);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        this.lightFadeColorCache = new Map();
        this.selectedAgent = null;
        this.onAgentSelect = null;
        this._chatMatchAccumulator = 250;

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
        this.harborWaterApronTiles = this._buildHarborWaterApronTiles();

        // Bridges (Task 5): two authored river crossings only.
        this.scenery.generateBridges();
        this.bridgeTiles = this.scenery.getBridgeTiles();
        this.bridgeSpans = this._buildBridgeSpans();
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
            if (t.canopy || t.tropical) {
                return new StaticPropSprite({
                    tileX: t.tileX,
                    tileY: t.tileY,
                    drawFn: (ctx, x, y) => this._drawFantasyForestTree(ctx, x, y, t),
                });
            }
            // variant 0 -> oak, 1 -> pine, 2 -> willow; size driven by scale threshold.
            const species = ['oak', 'pine', 'willow'][(t.variant ?? 0) % 3];
            const size = (t.scale ?? 1) >= 1.0 ? 'large' : 'small';
            const id = `veg.tree.${species}.${size}`;
            return new StaticPropSprite({
                tileX: t.tileX,
                tileY: t.tileY,
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
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
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
            });
        });
        this.districtPropSprites = this._buildDistrictPropSprites();

        // Walkability grid + Pathfinder (Task 11)
        this.walkabilityGrid = this.scenery.getWalkabilityGrid();
        this.pathfinder = new Pathfinder(this.walkabilityGrid);

        this.commandCenterGroundProps = [];
        this._generateCommandCenterAmbience();
        this.ambientEmitters = [];
        this._generateAmbientEmitters();

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
            { tileX: 7.8, tileY: 32.2, particleType: 'portalRune', chance: 0.022 },
            { tileX: 22.4, tileY: 33.1, particleType: 'questPing', chance: 0.014 },
            { tileX: 24.3, tileY: 14.3, particleType: 'archiveMote', chance: 0.022 },
            { tileX: 32.5, tileY: 16.4, particleType: 'beaconMote', chance: 0.014 },
            { tileX: 9.5, tileY: 8.5, particleType: 'firefly', chance: 0.014 },
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
            x: (emitter.tileX - emitter.tileY) * TILE_WIDTH / 2,
            y: (emitter.tileX + emitter.tileY) * TILE_HEIGHT / 2,
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
        this.camera = new Camera(canvas);
        this.camera.attach();
        this._setMotionScale(this.motionQuery?.matches ? 0 : 1);
        if (this.motionQuery?.addEventListener) {
            this.motionQuery.addEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery?.addListener) {
            this.motionQuery.addListener(this._onMotionPreferenceChange);
        }

        this.buildingRenderer?.setBuildings(this.world.buildings);

        // Create sprites for existing agents
        for (const agent of this.world.agents.values()) {
            this._addAgentSprite(agent);
        }

        // Subscribe to domain events
        this._unsubscribers.push(
            eventBus.on('agent:added', (agent) => this._addAgentSprite(agent)),
            eventBus.on('agent:removed', (agent) => {
                this.agentSprites.delete(agent.id);
                this._markSpritesDirty();
            }),
            eventBus.on('agent:updated', (agent) => {
                const sprite = this.agentSprites.get(agent.id);
                if (sprite) {
                    sprite.agent = agent;
                    this._markSpritesDirty();
                }
            }),
        );

        // Minimap
        this.minimap.attach(canvas.parentNode);
        this.minimap.onNavigate = (tileX, tileY) => {
            const screenPos = {
                x: (tileX - tileY) * TILE_WIDTH / 2,
                y: (tileX + tileY) * TILE_HEIGHT / 2,
            };
            this.camera.x = -screenPos.x + canvas.width / (2 * this.camera.zoom);
            this.camera.y = -screenPos.y + canvas.height / (2 * this.camera.zoom);
        };

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
            this.buildingRenderer?.setHovered(this.buildingRenderer.hitTest(worldPos.x, worldPos.y) ?? null);
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);
        this._onKeyDown = (e) => { if (e.code === 'KeyD' && e.shiftKey) this.debugOverlay.toggle(); };
        window.addEventListener('keydown', this._onKeyDown);

        this.running = true;
        this._loop();
    }

    hide() {
        this.running = false;
        if (this.frameId) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        if (this.camera) {
            this.camera.detach();
        }
        if (this.motionQuery?.removeEventListener) {
            this.motionQuery.removeEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery?.removeListener) {
            this.motionQuery.removeListener(this._onMotionPreferenceChange);
        }
        this.minimap.detach();
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._unsubscribers = [];
        if (this.canvas) {
            this.canvas.removeEventListener('click', this._onClick);
            this.canvas.removeEventListener('mousemove', this._onMouseMoveMain);
        }
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        this._sortedSprites = [];
        this._spritesNeedSort = true;
        this.agentSprites.clear();
        this.particleSystem.clear();
        this.fantasyForestTreeCache.clear();
    }

    _markSpritesDirty() {
        this._spritesNeedSort = true;
    }

    _snapshotSortedSprites() {
        if (!this._spritesNeedSort) return this._sortedSprites;
        const agents = Array.from(this.agentSprites.values());
        const trees = this.treePropSprites || [];
        const boulders = this.boulderPropSprites || [];
        this._sortedSprites = [...agents, ...trees, ...boulders];
        this._sortedSprites.sort((a, b) => a.y - b.y);
        this._spritesNeedSort = false;
        return this._sortedSprites;
    }

    _setMotionScale(scale) {
        this.motionScale = scale;
        this.buildingRenderer?.setMotionScale(scale);
        this.harborTraffic?.setMotionScale(scale);
        this.landmarkActivity?.setMotionScale(scale);
        this.particleSystem.setMotionEnabled(scale > 0);
        for (const sprite of this.agentSprites.values()) {
            sprite.setMotionScale(scale);
        }
    }

    _addAgentSprite(agent) {
        if (!this.agentSprites.has(agent.id)) {
            const sprite = new AgentSprite(agent, {
                pathfinder: this.pathfinder,
                bridgeTiles: this.bridgeTiles,
                assets: this.assets,
                compositor: this.compositor,
            });
            sprite.setMotionScale(this.motionScale);
            this.agentSprites.set(agent.id, sprite);
            this._markSpritesDirty();
        }
    }

    _handleClick(worldX, worldY) {
        if (!this.agentSprites.size && !this.buildingRenderer) return;

        let clicked = null;

        // Per-pixel agent hit test (sorted: most front first)
        const sorted = Array.from(this.agentSprites.values())
            .sort((a, b) => b.y - a.y);            // front-most first
        for (const sprite of sorted) {
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
        } else {
            this.selectedAgent = null;
            this.camera.stopFollow();
            if (this.onAgentSelect) this.onAgentSelect(null);
        }
    }

    _loop() {
        if (!this.running) return;
        const now = performance.now();
        const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
        this._lastFrameTime = now;
        this._update(dt);
        this._render(dt);
        this.frameId = requestAnimationFrame(() => this._loop());
    }

    _updateChatMatching() {
        const senders = new Set();
        const spriteByRecipient = new Map();

        for (const sprite of this.agentSprites.values()) {
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
            const agent = sprite.agent;
            if (!agent) continue;
            if (agent.status === AgentStatus.WORKING && agent.currentTool === 'SendMessage' && agent.currentToolInput) {
                senders.add(sprite);

                if (sprite.chatPartner) continue;

                const target = spriteByRecipient.get(agent.currentToolInput);
                if (target && target !== sprite) {
                    sprite.startChat(target);
                }
            }
        }

        // Clear chat state for agents not using SendMessage
        for (const sprite of this.agentSprites.values()) {
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
            if (sprite) {
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

        // Update camera follow
        if (this.camera) this.camera.updateFollow();

        // Chat matching only depends on session/tool state, not frame-perfect motion.
        this._chatMatchAccumulator += dt;
        if (this._chatMatchAccumulator >= 250) {
            this._chatMatchAccumulator = 0;
            this._updateChatMatching();
        }

        // Update agent sprites
        let shouldResort = false;
        for (const sprite of this.agentSprites.values()) {
            sprite.update(this.particleSystem, dt);
            if (sprite._lastSortedY !== sprite.y) {
                shouldResort = true;
                sprite._lastSortedY = sprite.y;
            }
        }
        if (shouldResort) {
            this._markSpritesDirty();
        }

        // Steering separation: push moving agents apart when they overlap in screen space.
        const SEP_RADIUS = 28;   // px — slightly wider than sprite half-width (24)
        const SEP_STRENGTH = 0.8; // px per frame — small enough to never push across a tile
        const movingSprites = Array.from(this.agentSprites.values()).filter(s => s.moving && !s.chatting);
        for (let i = 0; i < movingSprites.length; i++) {
            for (let j = i + 1; j < movingSprites.length; j++) {
                const a = movingSprites[i];
                const b = movingSprites[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= SEP_RADIUS || dist === 0) continue;
                const overlap = (SEP_RADIUS - dist) / SEP_RADIUS;
                const nx = dx / dist;
                const ny = dy / dist;
                const nextAx = a.x + nx * overlap * SEP_STRENGTH;
                const nextAy = a.y + ny * overlap * SEP_STRENGTH;
                const nextBx = b.x - nx * overlap * SEP_STRENGTH;
                const nextBy = b.y - ny * overlap * SEP_STRENGTH;

                if (this._isSpritePositionWalkable(a, nextAx, nextAy)) {
                    a.x = nextAx;
                    a.y = nextAy;
                }
                if (this._isSpritePositionWalkable(b, nextBx, nextBy)) {
                    b.x = nextBx;
                    b.y = nextBy;
                }
            }
        }

        const sortedSnapshot = this._snapshotSortedSprites();
        this.harborTraffic?.update(this.world.agents.values(), dt);
        this.landmarkActivity?.update(this.world.agents.values(), sortedSnapshot, dt);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(sortedSnapshot);
        this.buildingRenderer?.update(dt);
        this._updateAmbientEffects();

        // Update particles
        this.particleSystem.update();
    }

    _isSpritePositionWalkable(sprite, x, y) {
        if (!this.pathfinder || typeof sprite?._screenToTile !== 'function') return true;
        const tile = sprite._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY));
    }

    _updateAmbientEffects() {
        if (!this.motionScale || this.ambientEmitters.length === 0) return;

        const maxParticles = this.particleSystem.maxParticles || 240;
        const activeParticles = this.particleSystem.particles.length || 0;
        if (activeParticles > maxParticles - 40) return;

        const particleBudget = Math.max(0.22, 1 - activeParticles / maxParticles);
        let spawned = 0;
        for (const emitter of this.ambientEmitters) {
            if (spawned >= 1) break;
            const localBudget = this._ambientEmitterBudget(emitter);
            if (Math.random() < emitter.chance * particleBudget * localBudget) {
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y - 18, 1);
                spawned++;
            }
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
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return;
        if (!canvas.width || !canvas.height) return;
        const renderNow = Date.now();

        // Clear
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        this.skyRenderer.draw(ctx, this.camera, canvas, dt, this.motionScale);

        // Apply camera
        this.camera.applyTransform(ctx);

        // 1. Terrain
        this._drawTerrain(ctx);
        this._drawFishSchools(ctx);
        this._drawTropicalWaterfalls(ctx);
        this._drawOpenSeaGulls(ctx);

        // Phase 2.5.5: light reflections — soft, screen-blended overlays over
        // terrain near each building's declared light source. `screen` (vs the
        // earlier `lighter`) keeps the additive feel without saturating to white,
        // and the alpha pulse is intentionally low so the overlays read as gentle
        // glints rather than dominant blobs. Each light may name its own overlay
        // (manifest `lightOverlay`); BuildingSprite falls back to the lighthouse
        // beam when the field is omitted.
        if (this.buildingRenderer && this.assets) {
            const lights = this.buildingRenderer.getLightSources();
            const pulse = 0.10 + 0.05 * Math.sin((this.waterFrame || 0) * 1.27);
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = pulse;
            for (const light of lights) {
                const overlayId = light.overlay || 'atmosphere.light.lighthouse-beam';
                const overlayImg = this.assets.get(overlayId);
                if (!overlayImg) continue;
                const dims = this.assets.getDims(overlayId);
                if (!dims) continue;
                const alpha = light.buildingType === 'watchtower' ? pulse * 1.55 : pulse;
                ctx.globalAlpha = alpha;
                ctx.drawImage(
                    overlayImg,
                    Math.round(light.x - dims.w / 2),
                    Math.round(light.y - dims.h / 2)
                );
            }
            ctx.restore();
        }

        // 2. Building shadows
        this.buildingRenderer?.drawShadows(ctx);

        // 3. Buildings + 4. Agents — interleaved by sortY for proper occlusion
        const buildingDrawables = this.buildingRenderer?.enumerateDrawables() ?? [];
        const sortedSprites = this._snapshotSortedSprites();
        const districtPropSprites = this.districtPropSprites || [];
        const harborDrawables = this.harborTraffic?.enumerateDrawables() ?? [];
        const harborPendingRepos = this.harborTraffic?.getPendingRepoSummaries?.() ?? [];
        const landmarkDrawables = this.landmarkActivity?.enumerateDrawables() ?? [];
        const zoom = this.camera.zoom;
        this._assignAgentOverlaySlots(sortedSprites, zoom);

        const drawables = [];
        for (const d of buildingDrawables) drawables.push({ kind: d.kind, sortY: d.sortY, payload: d });
        for (const sprite of sortedSprites) drawables.push({ kind: 'agent', sortY: sprite.y, payload: sprite });
        for (const sprite of districtPropSprites) drawables.push({ kind: 'district-prop', sortY: sprite.y, payload: sprite });
        for (const d of harborDrawables) drawables.push({ kind: 'harbor-traffic', sortY: d.sortY, payload: d });
        for (const d of landmarkDrawables) drawables.push({ kind: 'landmark-activity', sortY: d.sortY, payload: d });
        drawables.sort((a, b) => a.sortY - b.sortY);

        for (const item of drawables) {
            if (item.kind === 'agent') {
                item.payload.draw(ctx, zoom);
            } else if (item.kind === 'district-prop') {
                item.payload.draw(ctx, zoom);
            } else if (item.kind === 'harbor-traffic') {
                this.harborTraffic.draw(ctx, item.payload, zoom);
            } else if (item.kind === 'landmark-activity') {
                this.landmarkActivity.draw(ctx, item.payload, zoom);
            } else {
                this.buildingRenderer.drawDrawable(ctx, item.payload);
            }
        }

        // X-ray silhouette: draw tinted overlay of any agent passing behind a hero
        // building's front half so the agent stays findable through the obstruction.
        if (this.buildingRenderer && this.assets) {
            for (const d of buildingDrawables) {
                if (d.kind !== 'building-front') continue;
                const dims = this.assets.getDims(d.entry.id);
                if (!dims) continue;
                const [ax, ay] = this.assets.getAnchor(d.entry.id);
                const left = d.wx - ax;
                const top = d.wy - ay;
                const right = left + dims.w;
                const bottom = top + dims.h;
                const backY = d.sortY - dims.h / 2;     // back-half sortY
                const frontY = d.sortY;
                for (const sprite of this.agentSprites.values()) {
                    if (!sprite.selected) continue;
                    const withinSpriteBounds = sprite.x >= left - 12
                        && sprite.x <= right + 12
                        && sprite.y >= top
                        && sprite.y <= bottom + 12;
                    if (withinSpriteBounds && sprite.y >= backY && sprite.y < frontY) {
                        // Sprite is behind the building's front-half — draw the current
                        // animation frame at low alpha. SpriteRenderer.drawSilhouette
                        // would blit the full multi-direction agent sheet here, since
                        // agent.<provider>.base is a 736x920 spritesheet, not one icon.
                        sprite.drawXraySilhouette(ctx);
                    }
                }
            }
        }

        // 5. Particles
        this.particleSystem.draw(ctx);
        this.harborTraffic?.drawFinaleEffects(ctx, renderNow);

        // 6. Screen-space atmosphere, before text overlays. This preserves the
        // diorama mood without lowering final contrast on labels or status badges.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        this._drawAtmosphere(ctx);
        this.camera.applyTransform(ctx);

        // 7. Building bubbles (on top)
        this.buildingRenderer?.drawBubbles(ctx, this.world);

        // 8. Building labels + identity badges (on top, persistent)
        this.buildingRenderer?.drawLabels(ctx, {
            zoom,
            occupiedBoxes: this._collectAgentLabelHitRects(sortedSprites),
            harborPendingRepos,
        });

        // Reset transform for UI
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        this.harborTraffic?.drawScreenSummary(ctx, canvas, this.camera, renderNow);

        // Debug overlay (Shift+D to toggle) — must run in world space with camera transform.
        if (this.debugOverlay?.enabled) {
            this.camera.applyTransform(ctx);
            this.debugOverlay.draw(ctx, {
                walkabilityGrid: this.walkabilityGrid,
                bridgeTiles: this.bridgeTiles,
                agentSprites: this.agentSprites,
                buildings: this.world?.buildings,
                sceneryZones: this.scenery?.getBuildingSceneryZones?.() || [],
                treeProps: this.treePropSprites,
                boulderProps: this.boulderPropSprites,
            });
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // Minimap
        this.minimap.draw(this.world, this.camera, canvas, {
            pathTiles: this.pathTiles,
            waterTiles: this.waterTiles,
            bridgeTiles: this.bridgeTiles,
            selectedAgent: this.selectedAgent,
        });
    }

    _assignAgentOverlaySlots(sprites, zoom = this.camera?.zoom || 1) {
        const compactOccupied = [];
        const nameOccupied = [];
        for (const sprite of sprites) {
            if (!sprite.agent) continue;

            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;

            if (sprite.selected) {
                compactOccupied.push(this._agentCompactSlotRect(sprite, 0));
                nameOccupied.push(this._agentNameSlotRect(sprite, 0));
                sprite.overlaySlot = 0;
                sprite.nameTagSlot = 0;
                continue;
            }

            let compactSlot = 0;
            while (compactSlot < 4 && compactOccupied.some((item) => this._rectsOverlap(this._agentCompactSlotRect(sprite, compactSlot), item))) {
                compactSlot++;
            }
            if (compactSlot >= 4) {
                sprite.overlaySlot = null;
            } else {
                sprite.overlaySlot = compactSlot;
                compactOccupied.push(this._agentCompactSlotRect(sprite, compactSlot));
            }

            if (zoom < 3) {
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
        const offsetY = sprite.y + (20 + slot * 11) * s;
        const pad = 2 * s;
        const halfW = 69 * s;
        const halfH = 7 * s;
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
        const name = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        // Conservative width approximation in canvas space before zoom correction.
        const rawLen = Math.min(name.length, 28);
        return Math.min(190, Math.max(52, rawLen * 6 + 12));
    }

    _estimateNameTagHeight(sprite) {
        const name = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        const lines = name.length > 17 ? 2 : 1;
        return lines === 1 ? 16 : 26;
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
            ctx.drawImage(cached.canvas, cached.bounds.x, cached.bounds.y);
        }
        this._drawDynamicWaterHighlights(ctx);
    }

    _getVisibleTileBounds(margin = 5) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const c1 = this.camera.screenToTile(0, 0);
        const c2 = this.camera.screenToTile(w, 0);
        const c3 = this.camera.screenToTile(0, h);
        const c4 = this.camera.screenToTile(w, h);

        return {
            startX: Math.max(0, Math.min(c1.tileX, c2.tileX, c3.tileX, c4.tileX) - margin),
            endX: Math.min(MAP_SIZE - 1, Math.max(c1.tileX, c2.tileX, c3.tileX, c4.tileX) + margin),
            startY: Math.max(0, Math.min(c1.tileY, c2.tileY, c3.tileY, c4.tileY) - margin),
            endY: Math.min(MAP_SIZE - 1, Math.max(c1.tileY, c2.tileY, c3.tileY, c4.tileY) + margin),
        };
    }

    _getTerrainCache() {
        const bounds = this._terrainCacheBounds();
        const key = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}|${this.assets ? 'assets' : 'fallback'}`;
        if (this.terrainCache && this.terrainCacheKey === key) {
            return { canvas: this.terrainCache, bounds };
        }

        const canvas = document.createElement('canvas');
        canvas.width = bounds.w;
        canvas.height = bounds.h;
        const cacheCtx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(cacheCtx);
        cacheCtx.setTransform(1, 0, 0, 1, -bounds.x, -bounds.y);

        const previousMotionScale = this.motionScale;
        this.motionScale = 0;
        this._drawDioramaBackdrop(cacheCtx);
        this._drawWorldBaseShadow(cacheCtx);

        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                this._drawTile(cacheCtx, x, y);
            }
        }

        this._drawOpenWaterDepthWash(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawStaticOpenSeaStructure(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawDistrictAtmosphere(cacheCtx);
        this._drawRiverContourLines(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawWaterFoamLines(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawOpenSeaSurfBreaks(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawLandmarkBridgeSpans(cacheCtx);
        this._drawAmbientGroundProps(cacheCtx);
        this._drawWorldEdgeRim(cacheCtx);
        this.motionScale = previousMotionScale;

        this.terrainCache = canvas;
        this.terrainCacheBounds = bounds;
        this.terrainCacheKey = key;
        return { canvas, bounds };
    }

    _buildDistrictPropSprites() {
        if (!this.sprites) return [];
        return DISTRICT_PROPS
            .filter((prop) => prop.layer === 'sorted')
            .filter((prop) => !this.scenery.isBlockedForTallScenery(prop.tileX, prop.tileY, this.pathTiles, this.bridgeTiles))
            .map((prop) => new StaticPropSprite({
                tileX: prop.tileX,
                tileY: prop.tileY,
                drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, prop.id, x, y),
            }));
    }

    _terrainCacheBounds() {
        if (this.terrainCacheBounds) return this.terrainCacheBounds;
        const points = this._worldDiamondPoints();
        const margin = 360;
        const minX = Math.floor(Math.min(...points.map(p => p.x)) - margin);
        const maxX = Math.ceil(Math.max(...points.map(p => p.x)) + margin);
        const minY = Math.floor(Math.min(...points.map(p => p.y)) - margin);
        const maxY = Math.ceil(Math.max(...points.map(p => p.y)) + margin);
        this.terrainCacheBounds = {
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
        };
        return this.terrainCacheBounds;
    }

    _drawDynamicWaterHighlights(ctx) {
        if (!this.motionScale) return;
        const { startX, endX, startY, endY } = this._getVisibleTileBounds(3);
        this._drawAnimatedCurrentBands(ctx, startX, endX, startY, endY);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                if (seed <= 0.82) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const shimmer = 0.035 + Math.max(0, Math.sin(this.waterFrame * 2.2 + seed * 10)) * 0.045;
                ctx.strokeStyle = `rgba(132, 211, 240, ${shimmer})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(screenX - 12, screenY - 2);
                ctx.lineTo(screenX + 10, screenY - 6);
                ctx.stroke();
            }
        }
        ctx.restore();
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

    _drawAnimatedCurrentBands(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                const harbor = this._isHarborWater(x, y);
                const openSea = this._isOpenSeaTile(x, y, openness);
                if (openness < 0.56 && !harbor && !openSea) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const crest = (Math.sin(this.waterFrame * 0.82 + x * 0.42 - y * 0.28 + seed * 2.6) + 1) / 2;
                const threshold = openSea ? 0.73 : 0.76;
                if (crest < threshold) continue;
                const isDeep = this.deepWaterTiles.has(key);
                const alpha = Math.min(
                    openSea ? 0.22 : 0.16,
                    (crest - threshold) * (isDeep ? (openSea ? 0.62 : 0.48) : 0.32) * (0.62 + openness * 0.5)
                );
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const drift = Math.sin(this.waterFrame * 0.45 + seed * 6.28) * 2;
                ctx.strokeStyle = isDeep
                    ? `rgba(${openSea ? 118 : 94}, ${openSea ? 201 : 184}, 238, ${alpha})`
                    : `rgba(154, 231, 238, ${alpha})`;
                ctx.lineWidth = openSea ? 1.7 : (isDeep ? 1.4 : 1);
                ctx.beginPath();
                ctx.moveTo(screenX - TILE_WIDTH * (openSea ? 0.48 : 0.40), screenY - 2 + drift);
                ctx.quadraticCurveTo(
                    screenX - TILE_WIDTH * 0.02,
                    screenY - (openSea ? 10 : 8) + drift * 0.35,
                    screenX + TILE_WIDTH * (openSea ? 0.48 : 0.40),
                    screenY - 5 - drift * 0.25
                );
                ctx.stroke();
            }
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
        return {
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2,
        };
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
        return tileX >= 29 && tileX <= 39 && tileY >= 13 && tileY <= 27;
    }

    _isOpenSeaTile(tileX, tileY, openness = null) {
        const key = `${tileX},${tileY}`;
        if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) return false;
        if (!this.deepWaterTiles.has(key)) return false;
        const open = openness ?? this._waterOpenness(tileX, tileY);
        if (open < 0.62) return false;
        const rightSea = tileX >= 33 && tileY <= 27;
        const upperSea = tileX >= 30 && tileY <= 11;
        return rightSea || upperSea;
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
        const light = isDeep ? (openSea ? '#8bd8ff' : '#5eb8ee') : '#9fe8f2';
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

        if (this.deepWaterTiles.has(key)) {
            const openSea = this._isOpenSeaTile(tileX, tileY);
            fill = openSea
                ? (seed > 0.5 ? '#03244a' : '#074276')
                : (seed > 0.5 ? '#075274' : '#0b6c8d');
            alpha = openSea ? 0.58 : 0.48;
        } else if (visualWater) {
            fill = seed > 0.5 ? '#0a8192' : '#0e9aa5';
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
            ctx.strokeStyle = `rgba(188, 253, 246, ${shimmer})`;
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
            if (!this.waterTiles.has(key) || this.deepWaterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
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
        const time = this.motionScale ? this.waterFrame : 0;
        return this.openSeaFlockBirds.map((gull) => {
            const rawCycle = time * gull.speed + gull.cycleOffset;
            const cycleIndex = Math.floor(rawCycle);
            const cyclePhase = rawCycle - cycleIndex;
            if (!this._isGullCycleEnabled(gull, cycleIndex)) return null;
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

            ctx.fillStyle = 'rgba(226, 255, 246, 0.48)';
            ctx.beginPath();
            ctx.ellipse(0, 7, fall.width * 0.46, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        ctx.restore();
    }

    _drawAtmosphere(ctx) {
        const canvas = this.canvas;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        const zoom = this.camera?.zoom || 1;
        ctx.globalAlpha = Math.max(0.32, Math.min(0.72, (3.1 - zoom) / 2.6));
        ctx.drawImage(this._getAtmosphereVignette(canvas), 0, 0);
        ctx.globalAlpha = 1;

        // Building light glows: a gentle radial halo, not a saturated disc. The
        // earlier mix paired full-alpha hex colors with a thin edge fade, which
        // read as opaque "UFO" blobs over the buildings. Capping the pass with a
        // low globalAlpha and adding an inner soft step keeps the warm-light
        // hint without washing out the sprite underneath.
        if (this.buildingRenderer) {
            ctx.save();
            ctx.globalAlpha = zoom < 1 ? 0.12 : 0.18;
            for (const light of this.buildingRenderer.getLightSources()) {
                const p = this.camera.worldToScreen(light.x, light.y);
                if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
                const radius = light.radius * this.camera.zoom;
                const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
                glow.addColorStop(0, this._withAlpha(light.color, 0.55));
                glow.addColorStop(0.42, this._withAlpha(light.color, 0.18));
                glow.addColorStop(1, this._withAlpha(light.color, 0));
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        ctx.restore();
    }

    _getAtmosphereVignette(canvas) {
        const cacheKey = `${canvas.width}x${canvas.height}`;
        if (this.atmosphereVignetteCache && this.atmosphereVignetteCacheKey === cacheKey) {
            return this.atmosphereVignetteCache;
        }

        const overlay = document.createElement('canvas');
        overlay.width = canvas.width;
        overlay.height = canvas.height;
        const overlayCtx = overlay.getContext('2d');
        const skyWash = overlayCtx.createLinearGradient(0, 0, 0, canvas.height);
        skyWash.addColorStop(0, 'rgba(78, 93, 45, 0.14)');
        skyWash.addColorStop(0.42, 'rgba(58, 34, 12, 0)');
        skyWash.addColorStop(1, 'rgba(39, 20, 6, 0.28)');
        overlayCtx.fillStyle = skyWash;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const warmCore = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            0,
            canvas.width * 0.5,
            canvas.height * 0.50,
            Math.max(canvas.width, canvas.height) * 0.58,
        );
        warmCore.addColorStop(0, 'rgba(255, 199, 90, 0.090)');
        warmCore.addColorStop(0.5, 'rgba(128, 76, 22, 0.040)');
        warmCore.addColorStop(1, 'rgba(0, 0, 0, 0)');
        overlayCtx.fillStyle = warmCore;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const vignette = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            Math.min(canvas.width, canvas.height) * 0.18,
            canvas.width * 0.5,
            canvas.height * 0.5,
            Math.max(canvas.width, canvas.height) * 0.72,
        );
        vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vignette.addColorStop(0.62, 'rgba(33, 18, 7, 0.055)');
        vignette.addColorStop(1, 'rgba(23, 11, 4, 0.40)');
        overlayCtx.fillStyle = vignette;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        this.atmosphereVignetteCache = overlay;
        this.atmosphereVignetteCacheKey = cacheKey;
        return overlay;
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
