import { MAP_SIZE } from '../../config/constants.js';
import { inVillageMasonry } from '../../config/townPlan.js';
import { TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from './Projection.js';

// Continuous clearance around building footprints, walk exclusions, masonry
// and shoreline curves. Replaces nearest-tile Math.round() walkability checks
// so steering, bridge lane offsets and arrival fans cannot intrude into walls,
// steps or river water.
export const FOOTPRINT_CLEARANCE_PAD = 0.25;
export const COAST_CLEARANCE_SD = -0.15;

function buildingOrigin(building) {
    const x0 = Number(building?.position?.tileX ?? building?.x);
    const y0 = Number(building?.position?.tileY ?? building?.y);
    const width = Math.max(1, Math.floor(Number(building?.width) || 1));
    const height = Math.max(1, Math.floor(Number(building?.height) || 1));
    return { x0, y0, width, height };
}

function normalizeRects(building, rawRects) {
    if (!Array.isArray(rawRects) || !rawRects.length) return [];
    const { x0: bx, y0: by } = buildingOrigin(building);
    const out = [];
    for (const rect of rawRects) {
        if (!rect || typeof rect !== 'object') continue;
        if (Number.isFinite(rect.x0) && Number.isFinite(rect.y0)
            && Number.isFinite(rect.x1) && Number.isFinite(rect.y1)) {
            out.push({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 });
            continue;
        }
        const rx = Number.isFinite(rect.x) ? Math.floor(rect.x) : Math.floor(bx + (Number(rect.dx) || 0));
        const ry = Number.isFinite(rect.y) ? Math.floor(rect.y) : Math.floor(by + (Number(rect.dy) || 0));
        const w = Math.max(1, Math.floor(Number(rect.width) || 1));
        const h = Math.max(1, Math.floor(Number(rect.height) || 1));
        out.push({ x0: rx, y0: ry, x1: rx + w - 1, y1: ry + h - 1 });
    }
    return out;
}

function buildingOpenFloors(building) {
    if (typeof building?.openFloorRects === 'function') return building.openFloorRects();
    return normalizeRects(building, building?.openFloor);
}

function buildingWalkExclusions(building) {
    if (typeof building?.walkExclusionRects === 'function') return building.walkExclusionRects();
    return normalizeRects(building, building?.walkExclusion);
}

/**
 * Returns minimal solid (non-openFloor) integer-tile rectangles `{ x0, y0, x1, y1 }`
 * (half-open `[x0, x1) × [y0, y1)`) for a building footprint.
 */
export function extractSolidBuildingBoxes(building) {
    const { x0, y0, width, height } = buildingOrigin(building);
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [];
    const openFloors = buildingOpenFloors(building);
    if (!openFloors.length) {
        return [{ x0, y0, x1: x0 + width, y1: y0 + height }];
    }
    const isOpen = (ix, iy) => openFloors.some((r) => ix >= r.x0 && ix <= r.x1 && iy >= r.y0 && iy <= r.y1);
    const rows = [];
    for (let dy = 0; dy < height; dy++) {
        const iy = y0 + dy;
        let runStart = -1;
        for (let dx = 0; dx <= width; dx++) {
            const solid = dx < width && !isOpen(x0 + dx, iy);
            if (solid && runStart < 0) {
                runStart = x0 + dx;
            } else if (!solid && runStart >= 0) {
                rows.push({ x0: runStart, y0: iy, x1: x0 + dx, y1: iy + 1 });
                runStart = -1;
            }
        }
    }
    // Merge adjacent rows with identical horizontal spans.
    const merged = [];
    for (const row of rows) {
        const prev = merged.find((box) => box.x0 === row.x0 && box.x1 === row.x1 && box.y1 === row.y0);
        if (prev) prev.y1 = row.y1;
        else merged.push(row);
    }
    return merged;
}

function toBuildingList(buildings) {
    if (!buildings) return [];
    if (Array.isArray(buildings)) return buildings;
    if (typeof buildings.values === 'function') return Array.from(buildings.values());
    return [];
}

/**
 * Precomputes flat typed-array clearance boxes and a walkable-bridge bitmask
 * so per-step continuous walkability checks allocate nothing at runtime.
 */
export function createWalkClearance({
    buildings = null,
    bridgeTiles = null,
    pathfinder = null,
    getCoastField = null,
    pad = FOOTPRINT_CLEARANCE_PAD,
    coastSdLimit = COAST_CLEARANCE_SD,
} = {}) {
    const buildingList = toBuildingList(buildings);
    const padded = [];
    const strict = [];
    for (const building of buildingList) {
        const solidBoxes = extractSolidBuildingBoxes(building);
        for (const box of solidBoxes) {
            // Solid tiles `[x0..x1-1] × [y0..y1-1]` occupy `[x0-0.5, x1-0.5] × [y0-0.5, y1-0.5]`,
            // padded outward by `pad`.
            padded.push(
                box.x0 - 0.5 - pad,
                box.y0 - 0.5 - pad,
                box.x1 - 0.5 + pad,
                box.y1 - 0.5 + pad,
            );
            // Also guard the strict half-open footprint `[x0, x1) × [y0, y1)` so open-front
            // buildings without a front walkExclusion (e.g. Harbor's quay apron) never admit
            // positions inside their wall footprint.
            strict.push(box.x0, box.y0, box.x1, box.y1);
        }
        for (const rect of buildingWalkExclusions(building)) {
            padded.push(
                rect.x0 - 0.5 - pad,
                rect.y0 - 0.5 - pad,
                rect.x1 + 0.5 + pad,
                rect.y1 + 0.5 + pad,
            );
        }
    }

    const paddedBoxes = Float32Array.from(padded);
    const strictBoxes = Float32Array.from(strict);
    const bridgeMask = new Uint8Array(MAP_SIZE * MAP_SIZE);
    if (bridgeTiles && typeof bridgeTiles.entries === 'function') {
        for (const [key, info] of bridgeTiles.entries()) {
            if (!info || info.walkable === false) continue;
            const comma = key.indexOf(',');
            if (comma < 0) continue;
            const bx = Number(key.slice(0, comma));
            const by = Number(key.slice(comma + 1));
            if (bx >= 0 && by >= 0 && bx < MAP_SIZE && by < MAP_SIZE) {
                bridgeMask[by * MAP_SIZE + bx] = 1;
            }
        }
    }

    function isTileClearOfBuildings(tx, ty) {
        for (let i = 0; i < paddedBoxes.length; i += 4) {
            if (tx >= paddedBoxes[i] && tx <= paddedBoxes[i + 2]
                && ty >= paddedBoxes[i + 1] && ty <= paddedBoxes[i + 3]) {
                return false;
            }
        }
        for (let i = 0; i < strictBoxes.length; i += 4) {
            if (tx >= strictBoxes[i] && tx < strictBoxes[i + 2]
                && ty >= strictBoxes[i + 1] && ty < strictBoxes[i + 3]) {
                return false;
            }
        }
        return true;
    }

    function isTileClear(tx, ty) {
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
        const rx = Math.round(tx);
        const ry = Math.round(ty);
        if (pathfinder && !pathfinder.isWalkable(rx, ry)) return false;
        if (inVillageMasonry(tx, ty)) return false;
        if (!isTileClearOfBuildings(tx, ty)) return false;
        const onBridge = rx >= 0 && ry >= 0 && rx < MAP_SIZE && ry < MAP_SIZE
            && bridgeMask[ry * MAP_SIZE + rx] === 1;
        if (!onBridge && typeof getCoastField === 'function') {
            const coast = getCoastField();
            if (coast?.signedDistance && coast.signedDistance(tx, ty) > coastSdLimit) {
                return false;
            }
        }
        return true;
    }

    function isWorldClear(wx, wy) {
        const tx = (wx / TILE_HALF_WIDTH + wy / TILE_HALF_HEIGHT) * 0.5;
        const ty = (wy / TILE_HALF_HEIGHT - wx / TILE_HALF_WIDTH) * 0.5;
        return isTileClear(tx, ty);
    }

    return {
        pad,
        coastSdLimit,
        paddedBoxes,
        strictBoxes,
        bridgeMask,
        isTileClearOfBuildings,
        isTileClear,
        isWorldClear,
    };
}
