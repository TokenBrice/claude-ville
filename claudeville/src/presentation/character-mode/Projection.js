import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';

import { VILLAGE_SURFACES, supportHeight, projectSurface, screenRayToTile } from './SurfaceProjection.js';

export const TILE_HALF_WIDTH = TILE_WIDTH / 2;
export const TILE_HALF_HEIGHT = TILE_HEIGHT / 2;

function tileArgs(tileOrX, tileY) {
    if (tileOrX && typeof tileOrX === 'object') {
        return {
            tileX: tileOrX.tileX ?? tileOrX.x ?? 0,
            tileY: tileOrX.tileY ?? tileOrX.y ?? 0,
        };
    }
    return { tileX: tileOrX, tileY };
}

function pointArgs(pointOrX, y) {
    if (pointOrX && typeof pointOrX === 'object') {
        return { x: pointOrX.x ?? 0, y: pointOrX.y ?? 0 };
    }
    return { x: pointOrX, y };
}

export function tileToWorld(tileOrX, tileY) {
    const tile = tileArgs(tileOrX, tileY);
    return {
        x: (tile.tileX - tile.tileY) * TILE_HALF_WIDTH,
        y: (tile.tileX + tile.tileY) * TILE_HALF_HEIGHT,
    };
}

export const worldTileX = (x, y) => (x / TILE_HALF_WIDTH + y / TILE_HALF_HEIGHT) / 2;
export const worldTileY = (x, y) => (y / TILE_HALF_HEIGHT - x / TILE_HALF_WIDTH) / 2;

export function worldToTile(pointOrX, y) {
    const point = pointArgs(pointOrX, y);
    return {
        tileX: worldTileX(point.x, point.y),
        tileY: worldTileY(point.x, point.y),
    };
}

export function tileToWorldElevated(tx, ty, surfaceId, registry = VILLAGE_SURFACES) {
    const h = supportHeight(tx, ty, registry, surfaceId);
    if (h === null) return null;
    const { x, y } = projectSurface(tx, ty, h);
    return { x, y };
}

export function pickSurfaceAtWorld(wx, wy, registry = VILLAGE_SURFACES, waterTiles) {
    const [lo, hi] = registry.heightRange;
    const near = screenRayToTile(wx, wy, hi), far = screenRayToTile(wx, wy, waterTiles ? Math.min(-1, lo) : lo);
    const candidates = [];
    for (let y = Math.max(0, Math.round(far.v)); y <= Math.min(MAP_SIZE - 1, Math.round(near.v)); y++) {
        for (let x = Math.max(0, Math.round(far.u)); x <= Math.min(MAP_SIZE - 1, Math.round(near.u)); x++) {
            candidates.push(y * MAP_SIZE + x);
        }
    }
    return registry.pickTopSurface(wx, wy, candidates, { includeImplicitGround: true, includeFaces: true, waterTiles });
}

// Anonymous rectangles describe plan geometry (including the War Table map).
// A semantic landmark stands on the village surface at its footprint centre.
export function buildingCenterToWorld(building, registry = building?.type ? VILLAGE_SURFACES : null) {
    const position = building?.position || building || {};
    const width = building?.width ?? 1;
    const height = building?.height ?? 1;
    return tileToWorldElevated(
        (position.tileX ?? position.x ?? 0) + width / 2,
        (position.tileY ?? position.y ?? 0) + height / 2,
        undefined, registry,
    );
}

export function mapWorldCorners(mapSize = MAP_SIZE) {
    const maxTile = mapSize - 1;
    return [
        { x: 0, y: 0 },
        { x: maxTile * TILE_HALF_WIDTH, y: maxTile * TILE_HALF_HEIGHT },
        { x: -maxTile * TILE_HALF_WIDTH, y: maxTile * TILE_HALF_HEIGHT },
        { x: 0, y: maxTile * TILE_HEIGHT },
    ];
}
