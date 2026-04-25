import { MAP_SIZE } from '../../config/constants.js';
import {
    WATER_POLYLINES,
    BRIDGE_HINTS,
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
        this.grassTuftTiles = new Map();
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
                if (!this.waterTiles.has(nKey)) {
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
            this.bridgeTiles.set(key, {
                orientation: hint.orientation || this._inferOrientation(hint.tileX, hint.tileY),
            });
        }
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
}
