// 6.7 — where ground-level ambient life may land when it is drawn on the
// ungraded, depth-free overlay above the resident WebGL island: rain splashes
// and fireflies. A tile qualifies only if its ground point (and the few texels
// above it the mark occupies) is not covered by an opaque building pixel, so
// the overlay never paints a splash or a firefly over a wall or a roof.
//
// Everything here is static for a loaded village (tiles, building footprints,
// sprite alpha masks), so it is computed once per host and reused; the result
// is only cached once every building mask has loaded.
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { buildingCenterToWorld } from './Projection.js';
import { getCoastField } from './CoastBake.js';

// Texels above the ground point a mark occupies (splash crown, firefly hover).
const SPLASH_REACH = 4;
const FIREFLY_REACH = 10;
// Grass within this many tiles (Chebyshev) of water is firefly ground.
const FIREFLY_WATER_REACH = 2;
// 3.9 — a splash's ground point must sit this far (tiles of the coast
// field's signed distance) inland: the organic coastline, not the tile
// diamonds, decides where water is, and rain on water draws rings instead.
const SPLASH_SHORE_MARGIN = -0.15;

const cache = new WeakMap();

export function openGroundTiles(host) {
    return classify(host)?.open || EMPTY;
}

export function fireflyGroundTiles(host) {
    return classify(host)?.firefly || EMPTY;
}

const EMPTY = Object.freeze([]);

function classify(host) {
    if (!host?.pathfinder || !host.waterTiles) return null;
    const cached = cache.get(host);
    if (cached) return cached;
    const occluders = buildingOccluders(host);
    if (!occluders) return null;
    const coast = host.waterTiles.size ? getCoastField(host) : null;

    const pathSets = [
        host.pathTiles,
        host.townSquareTiles,
        host.mainAvenueTiles,
        host.dirtPathTiles,
        host.commandCenterRoadTiles,
    ].filter(Boolean);
    const open = [];
    const firefly = [];
    for (let tileY = 0; tileY < MAP_SIZE; tileY++) {
        for (let tileX = 0; tileX < MAP_SIZE; tileX++) {
            const key = `${tileX},${tileY}`;
            if (host.waterTiles.has(key) || host.bridgeTiles?.has?.(key)) continue;
            if (coast && coast.signedDistance(tileX, tileY) > SPLASH_SHORE_MARGIN) continue;
            if (!host.pathfinder.isWalkable(tileX, tileY)) continue;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            if (covered(occluders, x, y, SPLASH_REACH)) continue;
            const tile = Object.freeze({ tileX, tileY, x, y, seed: hashTile(tileX, tileY) });
            open.push(tile);
            if (pathSets.some(set => set.has(key))) continue;
            if (!nearWater(host, tileX, tileY)) continue;
            if (covered(occluders, x, y, FIREFLY_REACH)) continue;
            firefly.push(tile);
        }
    }
    const result = Object.freeze({ open: Object.freeze(open), firefly: Object.freeze(firefly) });
    cache.set(host, result);
    return result;
}

// Opaque base-art footprints of every building, or null while any mask is
// still loading (so the classification is retried instead of cached wrong).
function buildingOccluders(host) {
    const buildings = host.world?.buildings;
    const assets = host.assets;
    if (!buildings || !assets?.getMask) return null;
    const out = [];
    for (const building of buildings.values ? buildings.values() : buildings) {
        const id = `building.${building.type}`;
        const mask = assets.getMask(id);
        const dims = assets.getDims?.(id);
        const anchor = assets.getAnchor?.(id);
        if (!mask || !dims || !anchor) return null;
        const center = buildingCenterToWorld(building);
        out.push({ mask, w: dims.w, h: dims.h, left: Math.round(center.x - anchor[0]), top: Math.round(center.y - anchor[1]) });
    }
    return out;
}

function covered(occluders, x, y, reach) {
    for (const o of occluders) {
        const lx = Math.floor(x - o.left);
        if (lx < 0 || lx >= o.w) continue;
        for (let dy = 0; dy <= reach; dy += 2) {
            const ly = Math.floor(y - dy - o.top);
            if (ly < 0 || ly >= o.h) continue;
            if (o.mask[ly * o.w + lx] === 1) return true;
        }
    }
    return false;
}

function nearWater(host, tileX, tileY) {
    for (let dy = -FIREFLY_WATER_REACH; dy <= FIREFLY_WATER_REACH; dy++) {
        for (let dx = -FIREFLY_WATER_REACH; dx <= FIREFLY_WATER_REACH; dx++) {
            const key = `${tileX + dx},${tileY + dy}`;
            if (host.waterTiles.has(key) && !host.bridgeTiles?.has?.(key)) return true;
        }
    }
    return false;
}

function hashTile(tileX, tileY) {
    let h = Math.imul(tileX + 1, 0x9e3779b1) ^ Math.imul(tileY + 7, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
}
