import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';
import { TOWN_ROAD_ROUTES } from '../../config/townPlan.js';
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
import { TerrainTileset } from './TerrainTileset.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';

const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
const WORLD_EDGE_PAD_X = TILE_WIDTH / 2;
const WORLD_EDGE_PAD_Y = TILE_HEIGHT / 2;
const DISTRICT_WASHES = [
    { x: 20, y: 20, radiusX: 12, radiusY: 8, color: '#5f3e21', alpha: 0.11 },
    { x: 34, y: 19, radiusX: 9, radiusY: 7, color: '#1e5b61', alpha: 0.13 },
    { x: 9, y: 25, radiusX: 9, radiusY: 8, color: '#62471f', alpha: 0.10 },
    { x: 8, y: 8, radiusX: 10, radiusY: 8, color: '#1f4e2a', alpha: 0.12 },
    { x: 30, y: 28, radiusX: 10, radiusY: 8, color: '#243d29', alpha: 0.12 },
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
    // Harbor/lighthouse: keep large piers in authored dock tiles so ships stay legible.
    { tileX: 33.4, tileY: 16.2, type: 'harborCrates' },
    { tileX: 32.5, tileY: 18.3, type: 'harborCrane' },
    { tileX: 38.4, tileY: 20.4, type: 'harborCrates' },
    { tileX: 40.2, tileY: 19.2, type: 'harborCrane' },

    // Forge/mine work yards: ore carts and lanterns clarify production/resource landmarks.
    { tileX: 30.0, tileY: 24.0, type: 'oreCart' },
    { tileX: 33.4, tileY: 25.0, type: 'lantern' },
    { tileX: 6.6, tileY: 30.2, type: 'oreCart' },
    { tileX: 4.2, tileY: 32.8, type: 'lantern' },
    { tileX: 9.0, tileY: 29.4, type: 'runestone' },

    // Civic core: utility props around the square, not scattered through the woods.
    { tileX: 20.4, tileY: 19.6, type: 'well' },
    { tileX: 17.4, tileY: 19.6, type: 'marketStall' },
    { tileX: 25.4, tileY: 21.2, type: 'signpost' },
    { tileX: 21.8, tileY: 14.8, type: 'noticePillar' },
    { tileX: 23.0, tileY: 19.6, type: 'scrollCrates' },

    // Sacred/research edges: fewer, quieter accents near magical buildings.
    { tileX: 12.8, tileY: 10.8, type: 'lantern' },
    { tileX: 18.8, tileY: 9.6, type: 'runestone' },
    { tileX: 6.8, tileY: 8.5, type: 'flowerCart' },
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
        this.minimap = new Minimap();
        this.agentSprites = new Map();
        this._sortedSprites = [];
        this._spritesNeedSort = true;
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
        this.terrainSeed = [];
        this.waterFrame = 0;
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

        // Bridges (Task 5): authored hints + auto-place where roads cross water.
        this.scenery.generateBridges(this.pathTiles);
        this.bridgeTiles = this.scenery.getBridgeTiles();
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
        const plazaHub = command
            ? {
                x: Math.floor(command.position.tileX + command.width / 2),
                y: Math.floor(command.position.tileY + command.height + 2),
            }
            : { x: 20, y: 22 };
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
        this.treePropSprites = this.scenery.getTreeProps().map((t) => {
            // variant 0 → oak, 1 → pine, 2 → willow; size driven by scale threshold.
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

        // Walkability grid + Pathfinder (Task 11)
        this.walkabilityGrid = this.scenery.getWalkabilityGrid(this.pathTiles);
        this.pathfinder = new Pathfinder(this.walkabilityGrid);

        this.commandCenterGroundProps = [];
        this._generateCommandCenterAmbience();
        this.ambientEmitters = [];
        this._generateAmbientEmitters();

        // Event subscriptions
        this._unsubscribers = [];
    }

    _generatePaths() {
        const buildingDefs = Array.from(this.world.buildings.values());
        const command = this._getCommandBuilding();
        const plazaHub = command
            ? {
                x: Math.floor(command.position.tileX + command.width / 2),
                y: Math.floor(command.position.tileY + command.height + 2),
            }
            : { x: 20, y: 22 };
        for (const b of buildingDefs) {
            // Paths around buildings
            for (let x = b.position.tileX - 1; x <= b.position.tileX + b.width; x++) {
                for (let y = b.position.tileY - 1; y <= b.position.tileY + b.height; y++) {
                    if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                        this.pathTiles.add(`${x},${y}`);
                    }
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

    _generateTownSquare(centerX, centerY) {
        for (let x = centerX - 5; x <= centerX + 6; x++) {
            for (let y = centerY - 4; y <= centerY + 4; y++) {
                const dx = (x - centerX) / 5.8;
                const dy = (y - centerY) / 4.4;
                if ((dx * dx + dy * dy) <= 1.1 && this._inMapBounds(x, y)) {
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
            const nearPlaza = Math.abs(x - plazaHubX) <= 4 || Math.abs(y - plazaHubY) <= 3;
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
                this.pathTiles.add(`${x2},${y}`);
                this.mainAvenueTiles.add(`${x2},${y}`);
            }
            return;
        }

        if (y1 === y2) {
            const fromX = Math.min(x1, x2);
            const toX = Math.max(x1, x2);
            for (let x = fromX; x <= toX; x++) {
                this._markCommandRoadTile(x, y1);
                this.pathTiles.add(`${x},${y1}`);
                this.mainAvenueTiles.add(`${x},${y1}`);
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
            this.pathTiles.add(`${x},${y}`);
            this.mainAvenueTiles.add(`${x},${y}`);
        }
    }

    _markCommandRoadTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return;
        const key = `${tileX},${tileY}`;
        this.commandCenterRoadTiles.add(key);
    }

    _generateAmbientEmitters() {
        const emitters = [
            { tileX: 24.5, tileY: 10.5, particleType: 'sparkle', chance: 0.018 },
            { tileX: 24.5, tileY: 9.5, particleType: 'sparkle', chance: 0.012 },
            { tileX: 33, tileY: 25, particleType: 'sparkle', chance: 0.016 },
            { tileX: 11, tileY: 8.5, particleType: 'sparkle', chance: 0.01 },
            { tileX: 28, tileY: 16.5, particleType: 'smoke', chance: 0.012 },
            { tileX: 18.5, tileY: 24.5, particleType: 'leaf', chance: 0.012 },
            { tileX: 20.5, tileY: 24.4, particleType: 'firefly', chance: 0.016 },
            { tileX: 31.8, tileY: 24.6, particleType: 'portalRune', chance: 0.02 },
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
        this._sortedSprites = [];
        this._spritesNeedSort = true;
        this.agentSprites.clear();
        this.particleSystem.clear();
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
        this._render();
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
        this.harborTraffic?.update(this.world.agents.values(), dt);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(this._snapshotSortedSprites());
        this.buildingRenderer?.update(dt);
        this._updateAmbientEffects();

        // Update particles
        this.particleSystem.update();
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

    _render() {
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return;
        if (!canvas.width || !canvas.height) return;

        // Clear
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        ctx.fillStyle = THEME.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Apply camera
        this.camera.applyTransform(ctx);

        // 1. Terrain
        this._drawTerrain(ctx);

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
        const harborDrawables = this.harborTraffic?.enumerateDrawables() ?? [];
        const zoom = this.camera.zoom;
        this._assignAgentOverlaySlots(sortedSprites, zoom);

        const drawables = [];
        for (const d of buildingDrawables) drawables.push({ kind: d.kind, sortY: d.sortY, payload: d });
        for (const sprite of sortedSprites) drawables.push({ kind: 'agent', sortY: sprite.y, payload: sprite });
        for (const d of harborDrawables) drawables.push({ kind: 'harbor-traffic', sortY: d.sortY, payload: d });
        drawables.sort((a, b) => a.sortY - b.sortY);

        for (const item of drawables) {
            if (item.kind === 'agent') {
                item.payload.draw(ctx, zoom);
            } else if (item.kind === 'harbor-traffic') {
                this.harborTraffic.draw(ctx, item.payload, zoom);
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
                        // Sprite is behind the building's front-half — draw tinted silhouette atop.
                        const spriteId = `agent.${sprite.agent.provider || 'claude'}.base`;
                        this.sprites.drawSilhouette(ctx, spriteId, sprite.x, sprite.y);
                    }
                }
            }
        }

        // 5. Particles
        this.particleSystem.draw(ctx);

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
        });

        // Reset transform for UI
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);

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
        this._drawDistrictAtmosphere(cacheCtx);
        this._drawRiverContourLines(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawWaterFoamLines(cacheCtx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
        this._drawAmbientGroundProps(cacheCtx);
        this._drawWorldEdgeRim(cacheCtx);
        this.motionScale = previousMotionScale;

        this.terrainCache = canvas;
        this.terrainCacheBounds = bounds;
        this.terrainCacheKey = key;
        return { canvas, bounds };
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
                if (openness < 0.42) continue;
                const isDeep = this.deepWaterTiles.has(key);
                const harbor = this._isHarborWater(x, y);
                const alpha = Math.min(0.22, (isDeep ? 0.12 : 0.055) * openness + (harbor ? 0.035 : 0));
                ctx.fillStyle = isDeep
                    ? `rgba(0, 9, 28, ${alpha})`
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
                if (openness < 0.56 && !harbor) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const crest = (Math.sin(this.waterFrame * 0.82 + x * 0.42 - y * 0.28 + seed * 2.6) + 1) / 2;
                if (crest < 0.76) continue;
                const isDeep = this.deepWaterTiles.has(key);
                const alpha = Math.min(0.16, (crest - 0.76) * (isDeep ? 0.48 : 0.32) * (0.62 + openness * 0.5));
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const drift = Math.sin(this.waterFrame * 0.45 + seed * 6.28) * 2;
                ctx.strokeStyle = isDeep
                    ? `rgba(94, 184, 238, ${alpha})`
                    : `rgba(154, 231, 238, ${alpha})`;
                ctx.lineWidth = isDeep ? 1.4 : 1;
                ctx.beginPath();
                ctx.moveTo(screenX - TILE_WIDTH * 0.40, screenY - 2 + drift);
                ctx.quadraticCurveTo(
                    screenX - TILE_WIDTH * 0.02,
                    screenY - 8 + drift * 0.35,
                    screenX + TILE_WIDTH * 0.40,
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
            const orientation = (bInfo?.orientation || 'EW').toLowerCase();
            const isDoc = bInfo?.kind === 'dock';
            const bridgeSpriteId = isDoc ? `dock.${orientation}` : `bridge.${orientation}`;
            if (this.sprites) this.sprites.drawSprite(ctx, bridgeSpriteId, screenX, screenY);
        } else if (this.waterTiles.has(key) && !this.terrain) {
            const shimmer = this.motionScale ? Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.055 + 0.055 : STATIC_WATER_SHIMMER;
            ctx.fillStyle = `rgba(185, 229, 224, ${shimmer})`;
            ctx.fill();
        }
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
        return tileX >= 31 && tileX <= 39 && tileY >= 14 && tileY <= 22;
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

    _strokeSegment(ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    _drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY) {
        const isDeep = this.deepWaterTiles.has(`${tileX},${tileY}`);
        ctx.fillStyle = isDeep ? 'rgba(0, 12, 34, 0.32)' : 'rgba(5, 34, 61, 0.18)';
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
        const light = isDeep ? '#5eb8ee' : '#9fe8f2';
        ctx.strokeStyle = this._withAlpha(light, Math.min(0.18, glint + (isDeep ? 0.02 : 0.05)));
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

        if (this.deepWaterTiles.has(key)) {
            fill = seed > 0.5 ? '#041a3f' : '#08285a';
            alpha = 0.54;
        } else if (this.waterTiles.has(key)) {
            fill = seed > 0.5 ? '#0b3d69' : '#13517a';
            alpha = 0.46;
        } else if (this.shoreTiles.has(key)) {
            fill = seed > 0.45 ? '#7a6338' : '#6f5c34';
            alpha = 0.13;
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
            const broad = this._tileNoise(Math.floor(tileX / 5) + 97, Math.floor(tileY / 5) + 131);
            fill = broad > 0.68 ? '#263f24' : broad < 0.26 ? '#3c552d' : '#30482a';
            alpha = 0.10;
        }

        if (!fill || alpha <= 0) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this._withAlpha(fill, alpha);
        this._drawDiamond(ctx, screenX, screenY);
        ctx.fill();

        const allowRegionTint = !this.waterTiles.has(key) && !this.shoreTiles.has(key);
        const regionTone = allowRegionTint ? this._terrainRegionTint(fill, tileX, tileY, seed) : null;
        if (regionTone && regionTone !== fill) {
            const regionAlpha = Math.min(0.08, alpha * 0.45);
            ctx.fillStyle = this._withAlpha(regionTone, regionAlpha);
            this._drawDiamond(ctx, screenX, screenY);
            ctx.fill();
        }

        if (this.waterTiles.has(key) && this.motionScale && seed > 0.72) {
            const shimmer = 0.05 + Math.max(0, Math.sin(this.waterFrame * 2.2 + seed * 10)) * 0.06;
            ctx.strokeStyle = `rgba(132, 211, 240, ${shimmer})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(screenX - 12, screenY - 2);
            ctx.lineTo(screenX + 10, screenY - 6);
            ctx.stroke();
        }
        if (this.waterTiles.has(key)) {
            this._drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.shoreTiles.has(key)) {
            this._drawShoreCrest(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) {
            this._drawPathInsetShadow(ctx, screenX, screenY, seed, tileX, tileY);
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
        if (this.waterTiles.has(key)) return 'terrain.shore-shallow';
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
        if (id === 'terrain.shore-shallow') return this.waterTiles.has(tkey) && !this.deepWaterTiles.has(tkey);
        if (id === 'terrain.grass-shore') return this.shoreTiles.has(tkey);
        if (id === 'terrain.cobble-square') return this.townSquareTiles.has(tkey);
        if (id === 'terrain.grass-cobble') return this.mainAvenueTiles?.has(tkey);
        if (id === 'terrain.grass-dirt') return this.pathTiles.has(tkey) || (this.dirtPathTiles?.has(tkey) ?? false);
        return false;
    }

    _terrainRegionTint(baseColor, tileX, tileY, seed) {
        const broad = this._tileNoise(Math.floor(tileX / 4) + 11, Math.floor(tileY / 4) + 19);
        const wash = this._tileNoise(Math.floor((tileX + tileY) / 7) + 37, Math.floor((tileY - tileX) / 7) + 43);
        if (broad > 0.76) return seed > 0.42 ? '#3a6336' : '#345c33';
        if (broad < 0.18) return seed > 0.54 ? '#2e562f' : '#315931';
        if (wash > 0.82) return '#3d6439';
        if (wash < 0.12) return '#2f5630';
        return baseColor;
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
        skyWash.addColorStop(0, 'rgba(33, 62, 64, 0.18)');
        skyWash.addColorStop(0.42, 'rgba(17, 13, 10, 0)');
        skyWash.addColorStop(1, 'rgba(0, 0, 0, 0.30)');
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
        warmCore.addColorStop(0, 'rgba(237, 181, 80, 0.055)');
        warmCore.addColorStop(0.5, 'rgba(76, 48, 22, 0.025)');
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
        vignette.addColorStop(0.62, 'rgba(18, 11, 8, 0.07)');
        vignette.addColorStop(1, 'rgba(0, 0, 0, 0.44)');
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
