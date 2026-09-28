// 2.2 — the world-locked footprint field. One RG8 texel per 4x4 world px over
// the island: R = the tallest occluder standing on that ground texel, in world
// px (0-255), G = its landmark id (GPU_LANDMARK_IDS, 0 = none). Buildings fill
// their BUILDING_DEFS footprint diamond at the landmark's height; trees and
// props taller than 12 world px stand as small diamonds at their own height;
// bodies are never in it. The resident light loop marches from a receiver's
// ground point to a light's foot through this field (V5, V9 unit 6), so a
// brazier behind a building wing leaves a stepped shadow on the street while
// a window never shadows its own facade. Baked once per map/scenery revision.

import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { tileToWorld } from './Projection.js';

export const FOOTPRINT_CELL = 4;
// World px of margin around the map diamond (harbor piers, the lighthouse
// promontory and shore props sit on its rim).
const FOOTPRINT_MARGIN = 128;
const PROP_MIN_HEIGHT = 12;
const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampHeight(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

/** The field's world rect: origin (top-left texel corner), size in texels. */
export function footprintFieldRect(mapSize = MAP_SIZE) {
    const originX = -mapSize * HALF_W - FOOTPRINT_MARGIN;
    const originY = -FOOTPRINT_MARGIN;
    const width = Math.ceil((mapSize * TILE_WIDTH + FOOTPRINT_MARGIN * 2) / FOOTPRINT_CELL);
    const height = Math.ceil((mapSize * TILE_HEIGHT + FOOTPRINT_MARGIN * 2) / FOOTPRINT_CELL);
    return { originX, originY, width, height, cell: FOOTPRINT_CELL };
}

/**
 * A landmark's footprint in world px: its four corners and the analytic
 * receiver geometry V9 carries (the front, camera-nearest, corner).
 */
export function landmarkFootprint(building) {
    const position = building?.position || building || {};
    const tileX = finite(position.tileX ?? position.x);
    const tileY = finite(position.tileY ?? position.y);
    const width = Math.max(1, finite(building?.width, 1));
    const depth = Math.max(1, finite(building?.height, 1));
    return {
        tileX,
        tileY,
        width,
        depth,
        back: tileToWorld(tileX, tileY),
        right: tileToWorld(tileX + width, tileY),
        front: tileToWorld(tileX + width, tileY + depth),
        left: tileToWorld(tileX, tileY + depth),
    };
}

/**
 * The foot of a facade point: straight down the screen onto the line of the
 * footprint's front edges under `x` (extended past the side corners for art
 * that overhangs the footprint), with the ground-plane normal of the face it
 * lies on (left face SW-facing, right face SE-facing).
 */
export function frontEdgeFoot(footprint, x) {
    const { front } = footprint;
    const onLeft = x <= front.x;
    return {
        x,
        y: front.y - Math.abs(x - front.x) * (HALF_H / HALF_W),
        normal: onLeft ? [-Math.SQRT1_2, Math.SQRT1_2] : [Math.SQRT1_2, Math.SQRT1_2],
    };
}
/** A landmark's occluding height (world px): its art above the footprint's back corner. */
export function landmarkHeight(building, assets, footprint = landmarkFootprint(building)) {
    const id = `building.${building?.type}`;
    const dims = assets?.getDims?.(id);
    const anchor = assets?.getAnchor?.(id);
    if (!dims?.h || !anchor) return 96;
    const centre = tileToWorld(
        footprint.tileX + footprint.width / 2,
        footprint.tileY + footprint.depth / 2,
    );
    const top = centre.y - finite(anchor[1]);
    return clampHeight(Math.max(16, footprint.back.y - top));
}

function stampDiamond(data, rect, cx, cy, halfW, halfH, height, landmark) {
    if (height <= 0 || halfW <= 0 || halfH <= 0) return;
    const { originX, originY, width, height: rows, cell } = rect;
    const x0 = Math.max(0, Math.floor((cx - halfW - originX) / cell));
    const x1 = Math.min(width - 1, Math.floor((cx + halfW - originX) / cell));
    const y0 = Math.max(0, Math.floor((cy - halfH - originY) / cell));
    const y1 = Math.min(rows - 1, Math.floor((cy + halfH - originY) / cell));
    const h = clampHeight(height);
    for (let ty = y0; ty <= y1; ty++) {
        const wy = originY + (ty + 0.5) * cell;
        for (let tx = x0; tx <= x1; tx++) {
            const wx = originX + (tx + 0.5) * cell;
            if (Math.abs(wx - cx) / halfW + Math.abs(wy - cy) / halfH > 1) continue;
            const index = (ty * width + tx) * 2;
            if (h > data[index]) {
                data[index] = h;
                data[index + 1] = landmark;
            }
        }
    }
}

/**
 * Bake the field. `buildings` are BuildingSprite buildings (type, position,
 * width, height), `landmarkIds` maps a type to its V9 landmark id, `props`
 * StaticPropSprites (x, y, bounds). Pure apart from `assets` lookups.
 */
export function buildFootprintField({ buildings = [], props = [], assets = null, landmarkIds = {}, mapSize = MAP_SIZE } = {}) {
    const rect = footprintFieldRect(mapSize);
    const data = new Uint8Array(rect.width * rect.height * 2);
    for (const prop of props) {
        const bounds = prop?.bounds;
        const tall = -finite(bounds?.top, 0);
        if (!(tall > PROP_MIN_HEIGHT)) continue;
        const span = Math.max(8, finite(bounds?.right, 16) - finite(bounds?.left, -16));
        const halfW = Math.max(4, Math.min(12, span * 0.2));
        stampDiamond(data, rect, finite(prop.x), finite(prop.y), halfW, halfW / 2, tall, 0);
    }
    for (const building of buildings) {
        if (!building?.type) continue;
        const footprint = landmarkFootprint(building);
        const height = landmarkHeight(building, assets, footprint);
        // The footprint is a diamond in tile space; in world px it is the
        // quadrilateral back-right-front-left. Rasterize it exactly by testing
        // tile coordinates of each texel centre.
        const { originX, originY, width, height: rows, cell } = rect;
        const x0 = Math.max(0, Math.floor((footprint.left.x - originX) / cell));
        const x1 = Math.min(width - 1, Math.floor((footprint.right.x - originX) / cell));
        const y0 = Math.max(0, Math.floor((footprint.back.y - originY) / cell));
        const y1 = Math.min(rows - 1, Math.floor((footprint.front.y - originY) / cell));
        const landmark = Math.max(0, Math.min(255, Math.round(finite(landmarkIds[building.type], 0))));
        const h = clampHeight(height);
        for (let ty = y0; ty <= y1; ty++) {
            const wy = originY + (ty + 0.5) * cell;
            for (let tx = x0; tx <= x1; tx++) {
                const wx = originX + (tx + 0.5) * cell;
                const tileX = (wy / HALF_H + wx / HALF_W) / 2;
                const tileY = (wy / HALF_H - wx / HALF_W) / 2;
                if (tileX < footprint.tileX || tileX > footprint.tileX + footprint.width) continue;
                if (tileY < footprint.tileY || tileY > footprint.tileY + footprint.depth) continue;
                const index = (ty * width + tx) * 2;
                if (h >= data[index]) {
                    data[index] = h;
                    data[index + 1] = landmark;
                }
            }
        }
    }
    return { ...rect, data };
}

/**
 * The renderer's field, rebuilt only when the map or scenery revision moves
 * (building set, prop set, asset version). Returns
 * `{ originX, originY, width, height, cell, data, revision }` or null.
 */
export function footprintFieldFor(renderer, landmarkIds = {}) {
    const buildings = renderer?.buildingRenderer?.buildings || [];
    const props = renderer?._staticPropSprites || [];
    const assets = renderer?.assets || renderer?.buildingRenderer?.assets || null;
    if (!buildings.length && !props.length) return null;
    let key = `${assets?.assetVersion ?? ''}|${props.length}|`;
    for (const building of buildings) {
        const position = building?.position || building || {};
        key += `${building?.type}:${position.tileX ?? position.x},${position.tileY ?? position.y},${building?.width}x${building?.height};`;
    }
    const cached = renderer._footprintField;
    if (cached && cached.key === key) return cached;
    const field = buildFootprintField({ buildings, props, assets, landmarkIds });
    field.key = key;
    field.revision = (cached?.revision || 0) + 1;
    renderer._footprintField = field;
    return field;
}
