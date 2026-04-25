import { MAP_SIZE } from '../../config/constants.js';
import {
    WATER_POLYLINES,
    WATER_BASINS,
    BRIDGE_HINTS,
    HARBOR_DOCK_TILES,
    TREE_CLUSTERS,
    BOULDERS,
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
        this.shoreTiles = new Set();
        this.bridgeTiles = new Map(); // key -> { orientation: 'NS' | 'EW' }
        this.bushTiles = new Map();    // key -> { variant: 0..2 }
        this.grassTuftTiles = new Map(); // key -> { variant: 0..1 }
        this.smallRockTiles = new Set();
        this.treeProps = [];           // { tileX, tileY, variant, scale }
        this.boulderProps = [];        // { tileX, tileY, variant, scale }

        this._buildingFootprints = this._collectBuildingFootprints();

        this._generateWater();
        this._generateShorelines();
        // Bridges, vegetation, rocks come in later tasks; left empty for now.
    }

    // --- Public accessors -------------------------------------------------

    getWaterTiles() { return this.waterTiles; }
    getDeepWaterTiles() { return this.deepWaterTiles; }
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

    _generateWater() {
        for (const poly of WATER_POLYLINES) {
            this._rasterizePolyline(poly);
        }
        for (const basin of WATER_BASINS) {
            this._rasterizeBasin(basin);
        }
    }

    _rasterizePolyline({ kind, width, points }) {
        if (!points || points.length < 2) return;
        const deepRatio = kind === 'moat' ? 0.5 : 0;

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
                    this.waterTiles.add(key);
                    if (deepRatio && d <= localWidth * deepRatio) {
                        this.deepWaterTiles.add(key);
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

    _rasterizeBasin({ kind, centerX, centerY, radiusX, radiusY, edgeNoise = 0.15 }) {
        const deepRatio = kind === 'moat' ? 0.64 : 0;
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
                    this.waterTiles.add(key);
                    if (deepRatio && d <= deepRatio + noise * 0.35) {
                        this.deepWaterTiles.add(key);
                    }
                }
            }
        }
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

    generateBridges(pathTiles) {
        // 1. Authored hints — always placed if the tile is water.
        for (const hint of BRIDGE_HINTS) {
            const key = `${hint.tileX},${hint.tileY}`;
            if (!this.waterTiles.has(key)) continue;
            this._addBridgeSpan(hint.tileX, hint.tileY, hint.orientation);
        }
        this._addHarborDocks();
        if (this.bridgeTiles.size > 0) return;

        // 2. Auto-place where any path tile lies on water.
        for (const key of pathTiles) {
            if (!this.waterTiles.has(key)) continue;
            if (this.bridgeTiles.has(key)) continue;
            const comma = key.indexOf(',');
            const tileX = Number(key.slice(0, comma));
            const tileY = Number(key.slice(comma + 1));
            this.bridgeTiles.set(key, {
                orientation: this._inferOrientation(tileX, tileY),
            });
        }
    }

    _addHarborDocks() {
        for (const dock of HARBOR_DOCK_TILES) {
            const key = `${dock.tileX},${dock.tileY}`;
            if (!this.waterTiles.has(key)) continue;
            if (this._buildingFootprints.has(key)) continue;
            this.bridgeTiles.set(key, {
                orientation: dock.orientation || this._inferOrientation(dock.tileX, dock.tileY),
                kind: 'dock',
            });
        }
    }

    _addBridgeSpan(tileX, tileY, forcedOrientation) {
        const orientation = forcedOrientation || this._inferOrientation(tileX, tileY);
        const spanAxis = orientation === 'EW' ? [1, 0] : [0, 1];
        const bridgeLine = [[tileX, tileY]];
        this._addBridgeTile(tileX, tileY, orientation);

        for (const direction of [-1, 1]) {
            for (let step = 1; step <= 4; step++) {
                const nx = tileX + spanAxis[0] * step * direction;
                const ny = tileY + spanAxis[1] * step * direction;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) break;
                const key = `${nx},${ny}`;
                if (this._buildingFootprints.has(key)) break;
                if (!this.waterTiles.has(key)) break;
                this._addBridgeTile(nx, ny, orientation);
                bridgeLine.push([nx, ny]);
            }
        }

        // Make authored city crossings read as landmark bridges rather than
        // single-file planks. Only widen over existing water so land, building
        // footprints, and authored shore shapes keep control.
        const crossAxis = orientation === 'EW' ? [0, 1] : [1, 0];
        for (const [bx, by] of bridgeLine) {
            for (const direction of [-1, 1]) {
                const nx = bx + crossAxis[0] * direction;
                const ny = by + crossAxis[1] * direction;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const key = `${nx},${ny}`;
                if (this._buildingFootprints.has(key)) continue;
                if (!this.waterTiles.has(key)) continue;
                this._addBridgeTile(nx, ny, orientation);
            }
        }
    }

    _addBridgeTile(tileX, tileY, orientation) {
        const key = `${tileX},${tileY}`;
        this.bridgeTiles.set(key, { orientation });
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
                if (this.waterTiles.has(key)) continue;
                if (this.shoreTiles.has(key)) continue;
                if (pathTiles.has(key)) continue;
                if (bridgeTiles.has(key)) continue;
                if (this._buildingFootprints.has(key)) continue;

                const noise = this.tileNoise(x + 109, y + 67);
                if (noise >= BUSH_DENSITY.min && noise < BUSH_DENSITY.max) {
                    const variant = Math.floor(this.tileNoise(x + 7, y + 13) * 3);
                    this.bushTiles.set(key, { variant });
                } else if (noise >= GRASS_TUFT_DENSITY.min && noise < GRASS_TUFT_DENSITY.max) {
                    this.grassTuftTiles.set(key, { variant: Math.floor(this.tileNoise(x + 21, y + 5) * 2) });
                }
            }
        }
    }

    generateTrees(pathTiles, bridgeTiles) {
        for (const cluster of TREE_CLUSTERS) {
            const r = cluster.radius;
            const r2 = r * r;
            for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
                for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
                    const tx = cluster.centerX + dx;
                    const ty = cluster.centerY + dy;
                    if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) continue;
                    if (dx * dx + dy * dy > r2) continue;
                    const key = `${tx},${ty}`;
                    if (this.waterTiles.has(key)) continue;
                    if (this.shoreTiles.has(key)) continue;
                    if (pathTiles.has(key)) continue;
                    if (bridgeTiles.has(key)) continue;
                    if (this._buildingFootprints.has(key)) continue;
                    if (this.bushTiles.has(key)) continue;

                    const noise = this.tileNoise(tx + 251, ty + 137);
                    if (noise > 1 - cluster.density) {
                        const jx = (this.tileNoise(tx + 11, ty + 3) - 0.5) * 0.6;
                        const jy = (this.tileNoise(tx + 5, ty + 19) - 0.5) * 0.6;
                        const variant = Math.floor(this.tileNoise(tx + 41, ty + 91) * 3);
                        const scale = 0.85 + this.tileNoise(tx + 17, ty + 71) * 0.4;
                        this.treeProps.push({ tileX: tx + 0.5 + jx, tileY: ty + 0.5 + jy, variant, scale });
                    }
                }
            }
        }
    }

    generateBoulders(pathTiles, bridgeTiles) {
        for (const b of BOULDERS) {
            const tx = Math.floor(b.tileX);
            const ty = Math.floor(b.tileY);
            const key = `${tx},${ty}`;
            if (this.waterTiles.has(key)) continue;
            if (pathTiles.has(key)) continue;
            if (bridgeTiles.has(key)) continue;
            if (this._buildingFootprints.has(key)) continue;
            this.boulderProps.push({ ...b });
        }
    }

    getWalkabilityGrid(pathTiles) {
        const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                const idx = y * MAP_SIZE + x;
                if (this._buildingFootprints.has(key)) continue; // 0
                if (this.waterTiles.has(key) && !this.bridgeTiles.has(key)) continue; // 0
                grid[idx] = 1;
            }
        }
        return grid;
    }
}
