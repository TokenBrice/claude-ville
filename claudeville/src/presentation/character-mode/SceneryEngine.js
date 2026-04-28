import { MAP_SIZE } from '../../config/constants.js';
import {
    WATER_POLYLINES,
    WATER_BASINS,
    BRIDGE_HINTS,
    HARBOR_DOCK_TILES,
    TREE_CLUSTERS,
    BOULDERS,
    VEGETATION_DISTRICTS,
    SHORELINE_VEGETATION,
    SCENERY_CLEARINGS,
    BUSH_DENSITY,
    GRASS_TUFT_DENSITY,
} from '../../config/scenery.js';

const CARDINAL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class SceneryEngine {
    constructor({ world, terrainSeed, tileNoise }) {
        this.world = world;
        this.terrainSeed = terrainSeed;
        this.tileNoise = tileNoise; // (x, y) -> [0, 1]

        this.waterTiles = new Set();
        this.deepWaterTiles = new Set();
        this.lagoonWaterTiles = new Set(); // river-kind basin/polyline water tiles
        this.waterMeta = new Map(); // key -> { source, kind, region, depth, surface, weatherProfile }
        this.shoreTiles = new Set();
        this.bridgeTiles = new Map(); // key -> { orientation: 'NS' | 'EW' }
        this.bushTiles = new Map();    // key -> { variant: 0..2 }
        this.grassTuftTiles = new Map(); // key -> { variant: 0..1 }
        this.smallRockTiles = new Set();
        this.treeProps = [];           // { tileX, tileY, variant, scale }
        this.boulderProps = [];        // { tileX, tileY, variant, scale }

        this._buildingFootprints = this._collectBuildingFootprints();
        this._buildingWalkBlocks = this._collectBuildingWalkBlocks();
        this._buildingSceneryZones = this._collectBuildingSceneryZones();

        this._generateWater();
        this._generateShorelines();
        // Bridges, vegetation, rocks come in later tasks; left empty for now.
    }

    // --- Public accessors -------------------------------------------------

    getWaterTiles() { return this.waterTiles; }
    getDeepWaterTiles() { return this.deepWaterTiles; }
    getLagoonWaterTiles() { return this.lagoonWaterTiles; }
    getWaterMeta() { return this.waterMeta; }
    getShoreTiles() { return this.shoreTiles; }
    getBridgeTiles() { return this.bridgeTiles; }
    getBushTiles() { return this.bushTiles; }
    getGrassTuftTiles() { return this.grassTuftTiles; }
    getTreeProps() { return this.treeProps; }
    getBoulderProps() { return this.boulderProps; }

    // --- Generation -------------------------------------------------------

    _collectBuildingFootprints() {
        const set = new Set();
        if (!this.world?.buildings) return set;
        for (const b of this.world.buildings.values()) {
            const x0 = Math.floor(b.position.tileX);
            const y0 = Math.floor(b.position.tileY);
            for (let dx = 0; dx < b.width; dx++) {
                for (let dy = 0; dy < b.height; dy++) {
                    set.add(`${x0 + dx},${y0 + dy}`);
                }
            }
        }
        return set;
    }

    _collectBuildingWalkBlocks() {
        const set = new Set(this._buildingFootprints);
        if (!this.world?.buildings) return set;
        for (const b of this.world.buildings.values()) {
            const rects = typeof b.walkExclusionRects === 'function'
                ? b.walkExclusionRects()
                : [];
            for (const rect of rects) {
                for (let x = rect.x0; x <= rect.x1; x++) {
                    for (let y = rect.y0; y <= rect.y1; y++) {
                        set.add(`${x},${y}`);
                    }
                }
            }
        }
        return set;
    }

    _collectBuildingSceneryZones() {
        const zones = [];
        if (!this.world?.buildings) return zones;
        for (const b of this.world.buildings.values()) {
            const x0 = b.position.tileX;
            const y0 = b.position.tileY;
            const padding = b.scenery?.excludePadding || {};
            const clearance = b.scenery?.tallPropClearance ?? 0;
            const padX = Math.max(padding.x ?? 0, clearance);
            const padY = Math.max(padding.y ?? 0, clearance);
            zones.push({
                type: b.type,
                footprint: {
                    x0,
                    y0,
                    x1: x0 + b.width,
                    y1: y0 + b.height,
                },
                padded: {
                    x0: x0 - padX,
                    y0: y0 - padY,
                    x1: x0 + b.width + padX,
                    y1: y0 + b.height + padY,
                },
                sightline: b.scenery?.sightline || null,
            });
        }
        return zones;
    }

    _generateWater() {
        for (const poly of WATER_POLYLINES) {
            this._rasterizePolyline(poly);
        }
        for (const basin of WATER_BASINS) {
            this._rasterizeBasin(basin);
        }
    }

    _rasterizePolyline({ kind, width, points, region = null, surface = null, weatherProfile = null }) {
        if (!points || points.length < 2) return;
        const deepRatio = kind === 'moat' ? 0.5 : kind === 'river' ? 0.32 : 0;

        // Bounding box (inclusive), padded by width.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        const pad = Math.ceil(width) + 1;
        const x0 = Math.max(0, Math.floor(minX - pad));
        const x1 = Math.min(MAP_SIZE - 1, Math.ceil(maxX + pad));
        const y0 = Math.max(0, Math.floor(minY - pad));
        const y1 = Math.min(MAP_SIZE - 1, Math.ceil(maxY + pad));

        for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
                const key = `${tx},${ty}`;
                if (this._buildingFootprints.has(key)) continue;
                const d = this._distanceToPolyline(tx + 0.5, ty + 0.5, points);
                // Soften edges with per-tile noise so the bank isn't too clean.
                const noise = this.tileNoise(tx + 53, ty + 19);
                const localWidth = width + (noise - 0.5) * 0.45;
                if (d <= localWidth) {
                    this._markWaterTile(key, {
                        source: 'polyline',
                        kind,
                        region: region || this._defaultWaterRegion(kind),
                        depth: 'shallow',
                        surface: surface || this._defaultWaterSurface(kind),
                        weatherProfile: weatherProfile || this._defaultWaterWeatherProfile(kind),
                    });
                    if (kind === 'river') this.lagoonWaterTiles.add(key);
                    if (deepRatio && d <= localWidth * deepRatio) {
                        this.deepWaterTiles.add(key);
                        this._markWaterTile(key, { depth: 'deep' });
                    }
                }
            }
        }
    }

    _distanceToPolyline(x, y, points) {
        let best = Infinity;
        for (let i = 0; i < points.length - 1; i++) {
            const d = this._distanceToSegment(x, y, points[i], points[i + 1]);
            if (d < best) best = d;
        }
        return best;
    }

    _distanceToSegment(x, y, [ax, ay], [bx, by]) {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(x - ax, y - ay);
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        return Math.hypot(x - cx, y - cy);
    }

    _rasterizeBasin({ kind, centerX, centerY, radiusX, radiusY, edgeNoise = 0.15, region = null, surface = null, weatherProfile = null }) {
        const deepRatio = kind === 'moat' ? 0.64 : kind === 'river' ? 0.40 : 0;
        const x0 = Math.max(0, Math.floor(centerX - radiusX - 1));
        const x1 = Math.min(MAP_SIZE - 1, Math.ceil(centerX + radiusX + 1));
        const y0 = Math.max(0, Math.floor(centerY - radiusY - 1));
        const y1 = Math.min(MAP_SIZE - 1, Math.ceil(centerY + radiusY + 1));

        for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
                const key = `${tx},${ty}`;
                if (this._buildingFootprints.has(key)) continue;
                const nx = (tx + 0.5 - centerX) / radiusX;
                const ny = (ty + 0.5 - centerY) / radiusY;
                const d = nx * nx + ny * ny;
                const noise = (this.tileNoise(tx + 313, ty + 197) - 0.5) * edgeNoise;
                if (d <= 1 + noise) {
                    this._markWaterTile(key, {
                        source: 'basin',
                        kind,
                        region: region || this._defaultWaterRegion(kind),
                        depth: 'shallow',
                        surface: surface || this._defaultWaterSurface(kind),
                        weatherProfile: weatherProfile || this._defaultWaterWeatherProfile(kind),
                    });
                    if (kind === 'river') this.lagoonWaterTiles.add(key);
                    if (deepRatio && d <= deepRatio + noise * 0.35) {
                        this.deepWaterTiles.add(key);
                        this._markWaterTile(key, { depth: 'deep' });
                    }
                }
            }
        }
    }

    _markWaterTile(key, meta = {}) {
        this.waterTiles.add(key);
        const current = this.waterMeta.get(key) || {};
        this.waterMeta.set(key, {
            ...current,
            ...meta,
        });
    }

    _defaultWaterRegion(kind) {
        if (kind === 'river') return 'lagoon';
        if (kind === 'moat') return 'moat';
        return kind || 'water';
    }

    _defaultWaterSurface(kind) {
        if (kind === 'river') return 'current';
        if (kind === 'moat') return 'surf';
        return 'calm';
    }

    _defaultWaterWeatherProfile(kind) {
        if (kind === 'river') return 'lagoon';
        if (kind === 'moat') return 'openSea';
        return 'water';
    }

    _generateShorelines() {
        for (const key of this.waterTiles) {
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            for (const [dx, dy] of CARDINAL_DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const nKey = `${nx},${ny}`;
                if (!this.waterTiles.has(nKey) && !this._buildingFootprints.has(nKey)) {
                    this.shoreTiles.add(nKey);
                }
            }
        }
    }

    _keyFor(tileX, tileY) {
        return `${Math.floor(tileX)},${Math.floor(tileY)}`;
    }

    isBlockedForFlatScenery(tileX, tileY, pathTiles, bridgeTiles) {
        const key = this._keyFor(tileX, tileY);
        return this.waterTiles.has(key)
            || pathTiles.has(key)
            || bridgeTiles.has(key)
            || this._buildingWalkBlocks.has(key);
    }

    isBlockedForTallScenery(tileX, tileY, pathTiles, bridgeTiles) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return true;
        if (this.isBlockedForFlatScenery(tileX, tileY, pathTiles, bridgeTiles)) return true;
        return !this.clearsBuildingSightlines(tileX, tileY);
    }

    clearsBuildingSightlines(tileX, tileY) {
        const x = Number.isInteger(tileX) ? tileX + 0.5 : tileX;
        const y = Number.isInteger(tileY) ? tileY + 0.5 : tileY;
        for (const zone of this._buildingSceneryZones) {
            if (this._pointInRect(x, y, zone.padded)) return false;
            if (zone.sightline && this._pointInRect(x, y, zone.sightline)) return false;
        }
        return true;
    }

    getBuildingSceneryZones() {
        return this._buildingSceneryZones;
    }

    _pointInRect(x, y, rect) {
        return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
    }

    _isBlockedForScenery(key, pathTiles, bridgeTiles) {
        const comma = key.indexOf(',');
        const x = Number(key.slice(0, comma));
        const y = Number(key.slice(comma + 1));
        return this.isBlockedForFlatScenery(x, y, pathTiles, bridgeTiles);
    }

    _distanceToWater(tileX, tileY) {
        const maxDistance = SHORELINE_VEGETATION.maxWaterDistance ?? 1;
        for (let distance = 1; distance <= maxDistance; distance++) {
            for (let dy = -distance; dy <= distance; dy++) {
                for (let dx = -distance; dx <= distance; dx++) {
                    if (Math.abs(dx) + Math.abs(dy) !== distance) continue;
                    if (this.waterTiles.has(`${tileX + dx},${tileY + dy}`)) {
                        return distance;
                    }
                }
            }
        }
        return Infinity;
    }

    _districtBias(tileX, tileY, field) {
        let bias = 0;
        for (const district of VEGETATION_DISTRICTS) {
            const dx = tileX + 0.5 - district.centerX;
            const dy = tileY + 0.5 - district.centerY;
            const distance = Math.hypot(dx, dy);
            if (distance > district.radius) continue;
            const falloff = 1 - distance / district.radius;
            bias += (district[field] ?? 0) * falloff;
        }
        return bias;
    }

    _shorelineBias(tileX, tileY, field) {
        if (this._distanceToWater(tileX, tileY) === Infinity) return 0;
        return SHORELINE_VEGETATION[field] ?? 0;
    }

    _clearingBias(tileX, tileY) {
        let bias = 0;
        for (const clearing of SCENERY_CLEARINGS) {
            const dx = tileX + 0.5 - clearing.centerX;
            const dy = tileY + 0.5 - clearing.centerY;
            const distance = Math.hypot(dx, dy);
            if (distance > clearing.radius) continue;
            const falloff = 1 - distance / clearing.radius;
            bias += (clearing.strength ?? 0) * falloff;
        }
        return bias;
    }

    _nearPathNegativeSpace(tileX, tileY, pathTiles, bridgeTiles) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const key = `${tileX + dx},${tileY + dy}`;
                if (bridgeTiles.has(key)) return 0.24;
                if (pathTiles.has(key)) return 0.08;
            }
        }
        return 0;
    }

    _passesFlatPropSpacing(tileX, tileY, kind) {
        const stride = kind === 'bush' ? 3 : 2;
        const cellX = Math.floor(tileX / stride);
        const cellY = Math.floor(tileY / stride);
        return this.tileNoise(cellX + (kind === 'bush' ? 401 : 503), cellY + 607) > 0.24;
    }

    _passesTreeSpacing(tileX, tileY) {
        for (const tree of this.treeProps) {
            const dx = tree.tileX - (tileX + 0.5);
            const dy = tree.tileY - (tileY + 0.5);
            if ((dx * dx + dy * dy) < 1.45) return false;
        }
        return true;
    }

    generateBridges() {
        // Authored crossings only. Other water/path overlaps stay non-walkable.
        for (const hint of BRIDGE_HINTS) {
            const key = `${hint.tileX},${hint.tileY}`;
            if (!this.waterTiles.has(key)) continue;
            this._addBridgeSpan(hint.tileX, hint.tileY, hint.orientation, hint);
        }
        this._addHarborDocks();
    }

    _addBridgeSpan(tileX, tileY, forcedOrientation, meta = {}) {
        const orientation = forcedOrientation || this._inferOrientation(tileX, tileY);
        const spanAxis = orientation === 'EW' ? [1, 0] : [0, 1];
        const bridgeLine = [[tileX, tileY]];
        this._addBridgeTile(tileX, tileY, orientation, meta);

        for (const direction of [-1, 1]) {
            for (let step = 1; step <= 4; step++) {
                const nx = tileX + spanAxis[0] * step * direction;
                const ny = tileY + spanAxis[1] * step * direction;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) break;
                const key = `${nx},${ny}`;
                if (this._buildingFootprints.has(key)) break;
                if (!this.waterTiles.has(key)) break;
                this._addBridgeTile(nx, ny, orientation, meta);
                bridgeLine.push([nx, ny]);
            }
        }

        // Make authored city crossings read as landmark bridges rather than
        // single-file planks. Only widen over existing water so land, building
        // footprints, and authored shore shapes keep control.
        const crossAxis = orientation === 'EW' ? [0, 1] : [1, 0];
        const widthRadius = Math.max(0, Math.floor(meta.widthRadius ?? 1));
        const walkableRadius = Math.max(0, Math.min(widthRadius, Math.floor(meta.walkableRadius ?? widthRadius)));
        for (const [bx, by] of bridgeLine) {
            for (let offset = -widthRadius; offset <= widthRadius; offset++) {
                if (offset === 0) continue;
                const nx = bx + crossAxis[0] * offset;
                const ny = by + crossAxis[1] * offset;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const key = `${nx},${ny}`;
                if (this._buildingFootprints.has(key)) continue;
                if (!this.waterTiles.has(key)) continue;
                this._addBridgeTile(nx, ny, orientation, {
                    ...meta,
                    walkable: Math.abs(offset) <= walkableRadius,
                });
            }
        }
    }

    _addBridgeTile(tileX, tileY, orientation, meta = {}) {
        const key = `${tileX},${tileY}`;
        this.bridgeTiles.set(key, {
            orientation,
            kind: 'landmark',
            bridgeId: meta.id || null,
            style: meta.style || 'civic',
            walkable: meta.walkable !== false,
        });
    }

    _addHarborDocks() {
        for (const dock of HARBOR_DOCK_TILES) {
            const { tileX, tileY, orientation = 'EW', style = 'causeway' } = dock;
            if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) continue;
            const key = `${tileX},${tileY}`;
            if (this._buildingFootprints.has(key)) continue;
            if (!this.waterTiles.has(key)) continue;
            this.bridgeTiles.set(key, { orientation, kind: 'dock', style });
        }
    }

    _inferOrientation(tileX, tileY) {
        // EW bridge if water extends left/right; NS if it extends up/down.
        const eastWater = this.waterTiles.has(`${tileX + 1},${tileY}`);
        const westWater = this.waterTiles.has(`${tileX - 1},${tileY}`);
        const northWater = this.waterTiles.has(`${tileX},${tileY - 1}`);
        const southWater = this.waterTiles.has(`${tileX},${tileY + 1}`);
        const ew = (eastWater ? 1 : 0) + (westWater ? 1 : 0);
        const ns = (northWater ? 1 : 0) + (southWater ? 1 : 0);
        return ew >= ns ? 'EW' : 'NS';
    }

    generateFlatVegetation(pathTiles, bridgeTiles) {
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                if (this._isBlockedForScenery(key, pathTiles, bridgeTiles)) continue;

                const noise = this.tileNoise(x + 109, y + 67);
                const clearing = this._clearingBias(x, y) + this._nearPathNegativeSpace(x, y, pathTiles, bridgeTiles);
                const bushMax = Math.min(0.42, BUSH_DENSITY.max
                    + this._districtBias(x, y, 'bushBoost')
                    + this._shorelineBias(x, y, 'bushBoost')
                    - clearing);
                const grassMax = Math.min(0.58, GRASS_TUFT_DENSITY.max
                    + this._districtBias(x, y, 'grassBoost')
                    + this._shorelineBias(x, y, 'grassBoost')
                    - clearing * 0.7);
                if (noise >= BUSH_DENSITY.min && noise < bushMax && this._passesFlatPropSpacing(x, y, 'bush')) {
                    const variant = Math.floor(this.tileNoise(x + 7, y + 13) * 3);
                    this.bushTiles.set(key, { variant });
                } else if (noise >= GRASS_TUFT_DENSITY.min && noise < grassMax && this._passesFlatPropSpacing(x, y, 'grass')) {
                    this.grassTuftTiles.set(key, { variant: Math.floor(this.tileNoise(x + 21, y + 5) * 2) });
                }
            }
        }
    }

    generateTrees(pathTiles, bridgeTiles) {
        for (const cluster of TREE_CLUSTERS) {
            const rx = cluster.radiusX ?? cluster.radius;
            const ry = cluster.radiusY ?? cluster.radius;
            for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
                for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
                    const tx = cluster.centerX + dx;
                    const ty = cluster.centerY + dy;
                    if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) continue;
                    if (((dx * dx) / (rx * rx)) + ((dy * dy) / (ry * ry)) > 1) continue;
                    const key = `${tx},${ty}`;
                    if (this.isBlockedForTallScenery(tx, ty, pathTiles, bridgeTiles)) continue;
                    if (this.bushTiles.has(key)) continue;
                    if (!this._passesTreeSpacing(tx, ty)) continue;

                    const noise = this.tileNoise(tx + 251, ty + 137);
                    const districtBoost = this._districtBias(tx, ty, 'treeBoost');
                    const shorelineBoost = this._shorelineBias(tx, ty, 'treeBoost');
                    const authoredClearing = this._clearingBias(tx, ty);
                    if (authoredClearing >= 0.62) continue;
                    const clearing = authoredClearing + this._nearPathNegativeSpace(tx, ty, pathTiles, bridgeTiles);
                    const density = Math.min(0.78, Math.max(0.05, cluster.density + districtBoost + shorelineBoost - clearing));
                    if (noise > 1 - density) {
                        const jx = (this.tileNoise(tx + 11, ty + 3) - 0.5) * 0.6;
                        const jy = (this.tileNoise(tx + 5, ty + 19) - 0.5) * 0.6;
                        if (this.isBlockedForTallScenery(tx + 0.5 + jx, ty + 0.5 + jy, pathTiles, bridgeTiles)) continue;
                        const variantNoise = this.tileNoise(tx + 41, ty + 91);
                        const palmNoise = this.tileNoise(tx + 73, ty + 211);
                        const northernCanopy = ty <= 13;
                        const palmBias = cluster.palmBias ?? (ty > 13 ? 0.42 : 0);
                        const shorelinePalm = this._distanceToWater(tx, ty) !== Infinity ? 0.34 : 0;
                        const villagePalm = ty >= 14 && ty <= 30 ? 0.30 : 0;
                        const isPalm = palmNoise < Math.min(0.98, palmBias + shorelinePalm + villagePalm);
                        const isNorthwestJungle = tx <= 20 && ty <= 13;
                        const isBroadleaf = !isPalm && isNorthwestJungle && variantNoise > 0.28;
                        const variant = isPalm
                            ? 2
                            : isBroadleaf
                            ? 3
                            : northernCanopy
                            ? (variantNoise > 0.72 ? 0 : 1)
                            : Math.floor(variantNoise * 3);
                        const scaleNoise = this.tileNoise(tx + 17, ty + 71);
                        const scale = isPalm
                            ? 0.96 + scaleNoise * 0.34
                            : northernCanopy
                            ? 1.02 + scaleNoise * 0.34
                            : 0.85 + scaleNoise * 0.4;
                        this.treeProps.push({
                            tileX: tx + 0.5 + jx,
                            tileY: ty + 0.5 + jy,
                            variant,
                            scale,
                            canopy: (northernCanopy && !isPalm) || isBroadleaf,
                            tropical: isPalm || isBroadleaf,
                            seed: variantNoise,
                        });
                    }
                }
            }
        }
    }

    generateBoulders(pathTiles, bridgeTiles) {
        for (const b of BOULDERS) {
            const large = (b.scale ?? 1) >= 1;
            const blocked = large
                ? this.isBlockedForTallScenery(b.tileX, b.tileY, pathTiles, bridgeTiles)
                : this.isBlockedForFlatScenery(b.tileX, b.tileY, pathTiles, bridgeTiles);
            if (blocked) continue;
            this.boulderProps.push({ ...b });
        }
    }

    getWalkabilityGrid() {
        const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                const idx = y * MAP_SIZE + x;
                if (this._buildingWalkBlocks.has(key)) continue; // 0
                const bridge = this.bridgeTiles.get(key);
                if (this.waterTiles.has(key) && (!bridge || bridge.walkable === false)) continue; // 0
                grid[idx] = 1;
            }
        }
        return grid;
    }
}
