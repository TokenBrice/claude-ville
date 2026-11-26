import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { APPROACH_FILES } from '../../claudeville/src/config/townPlan.js';
import {
    apertureFloorY,
    BUILDING_VISUAL_REGISTRY,
    getBuildingSurfaceAoPairs,
    signBoxFor,
    windowRectBounds,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { apertureCutContains, normalizeApertureLayers } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { OPEN_FRONT_PROFILES, parseArchRows } from '../../claudeville/src/presentation/character-mode/OpenFront.js';
import {
    BUILDING_CUTAWAY_PROFILES,
    HARBOR_MAX_LANTERNS,
    WAR_TABLE_LANDMARKS,
    WAR_TABLE_MAX_PAWNS,
    buildArchiveCutawayState,
    buildHarborCutawayState,
    drawArchiveCutaway,
    drawCommandWarTable,
    drawHarborCutaway,
    warTableTexelToSprite,
} from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import { checkAoMonotonicity, validateSurfaceV1Buffer } from '../sprites/bake-depth-channels.mjs';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { createWalkClearance, FOOTPRINT_CLEARANCE_PAD } from '../../claudeville/src/presentation/character-mode/WalkClearance.js';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, spritesRoot } from '../sprites/manifest-utils.mjs';
import { validateFrameStripParts, validateRoomMasks, validateWindowGeometry } from './building-art-geometry.mjs';
import { loadConfigExports, loadManifestIds } from './config-loader.mjs';
import {
    buildingRect,
    createReporter,
    inTileBounds,
    isFiniteNumber,
    isPositiveNumber,
    rectInsideMap,
    tileKey,
    walkExclusionRect,
} from './validation-utils.mjs';

const REQUIRED_FIELDS = [
    'type',
    'x',
    'y',
    'width',
    'height',
    'label',
    'shortLabel',
    'icon',
    'description',
    'district',
    'visualTier',
    'labelPriority',
    'capacity',
    'entrance',
    'visitTiles',
    'walkExclusion',
];

const CAPACITY_FIELDS = ['work', 'ambient', 'overflow'];
const TERRAIN_CONTACT_MIN_RATIO = 0.35;
const TERRAIN_CONTACT_MAX_RATIO = 1.05;

function validateGroundingProfiles(reporter, buildings, groundingConfig) {
    const profiles = groundingConfig.BUILDING_GROUNDING_PROFILES || {};
    const modes = new Set(groundingConfig.BUILDING_GROUNDING_MODES || []);
    const materials = new Set(groundingConfig.BUILDING_GROUNDING_MATERIALS || []);
    const edges = new Set(groundingConfig.BUILDING_GROUNDING_EDGE_TREATMENTS || []);
    const shadows = new Set(groundingConfig.BUILDING_GROUNDING_SHADOWS || []);
    const buildingTypes = new Set(buildings.map((building) => building.type));

    for (const building of buildings) {
        const path = pathFor(building, 'grounding');
        const profile = profiles[building.type];
        if (!profile || typeof profile !== 'object') {
            reporter.error(path, 'missing grounding profile');
            continue;
        }
        if (!modes.has(profile.mode)) reporter.error(`${path}.mode`, `unsupported mode "${profile.mode}"`);
        if (!materials.has(profile.material)) reporter.error(`${path}.material`, `unsupported material "${profile.material}"`);
        if (!edges.has(profile.edgeTreatment)) reporter.error(`${path}.edgeTreatment`, `unsupported edge treatment "${profile.edgeTreatment}"`);
        if (!shadows.has(profile.shadow)) reporter.error(`${path}.shadow`, `unsupported shadow "${profile.shadow}"`);
        if (profile.mode === 'terrain-apron' && profile.edgeTreatment !== 'broken') {
            reporter.error(path, 'terrain-apron profiles must use broken edges');
        }
        const foundation = profile.foundation;
        if (!foundation || typeof foundation.enabled !== 'boolean') {
            reporter.error(`${path}.foundation`, 'must declare enabled as a boolean');
        } else {
            const validOwners = new Set(['terrain-cache', 'sprite-reference', 'structural-sprite']);
            if (!validOwners.has(foundation.owner)) {
                reporter.error(`${path}.foundation.owner`, `unsupported owner "${foundation.owner}"`);
            }
            if (foundation.enabled && foundation.owner !== 'terrain-cache') {
                reporter.error(`${path}.foundation.owner`, 'enabled foundations must be owned by terrain-cache');
            }
            if (profile.mode === 'terrain-apron' && !foundation.enabled && foundation.owner !== 'sprite-reference') {
                reporter.error(`${path}.foundation.owner`, 'disabled terrain aprons must name sprite-reference ownership');
            }
        }
        const contact = profile.contact;
        if (!contact || typeof contact !== 'object') {
            reporter.error(`${path}.contact`, 'must be an object');
        } else {
            for (const field of ['offsetX', 'offsetY', 'width', 'depth', 'opacity']) {
                if (!isFiniteNumber(contact[field])) reporter.error(`${path}.contact.${field}`, 'must be finite');
            }
            if (Number(contact.width) < 0 || Number(contact.depth) < 0) {
                reporter.error(`${path}.contact`, 'width and depth must be non-negative');
            }
            if (profile.mode === 'terrain-apron') {
                const projectedSpan = (Number(building.width) + Number(building.height)) * 32;
                const contactRatio = Number(contact.width) / projectedSpan;
                if (contactRatio < TERRAIN_CONTACT_MIN_RATIO || contactRatio > TERRAIN_CONTACT_MAX_RATIO) {
                    reporter.error(
                        `${path}.contact.width`,
                        `structure contact spans ${(contactRatio * 100).toFixed(1)}% of the projected footprint; expected ${(TERRAIN_CONTACT_MIN_RATIO * 100).toFixed(0)}-${(TERRAIN_CONTACT_MAX_RATIO * 100).toFixed(0)}%`,
                    );
                }
            }
        }
    }

    for (const type of Object.keys(profiles)) {
        if (!buildingTypes.has(type)) reporter.warn(`grounding.${type}`, 'has no matching BUILDING_DEFS type');
    }
}

function pathFor(building, suffix = '') {
    const type = building?.type || '<missing-type>';
    return suffix ? `building.${type}.${suffix}` : `building.${type}`;
}

function validateRequiredFields(reporter, building) {
    for (const field of REQUIRED_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(building, field)) {
            reporter.error(pathFor(building), `missing required field "${field}"`);
        }
    }
}

function validateScalarFields(reporter, building, mapSize) {
    if (typeof building.type !== 'string' || !building.type.trim()) {
        reporter.error(pathFor(building), 'type must be a non-empty string');
    }
    for (const field of ['label', 'shortLabel', 'icon', 'description', 'district', 'visualTier', 'labelPriority']) {
        if (typeof building[field] !== 'string' || !building[field].trim()) {
            reporter.error(pathFor(building, field), 'must be a non-empty string');
        }
    }
    for (const field of ['x', 'y', 'width', 'height']) {
        if (!isFiniteNumber(building[field])) {
            reporter.error(pathFor(building, field), 'must be a finite number');
        }
    }
    if (!isPositiveNumber(building.width) || !Number.isInteger(Number(building.width))) {
        reporter.error(pathFor(building, 'width'), 'must be a positive integer');
    }
    if (!isPositiveNumber(building.height) || !Number.isInteger(Number(building.height))) {
        reporter.error(pathFor(building, 'height'), 'must be a positive integer');
    }
    const rect = buildingRect(building);
    if (!rectInsideMap(rect, mapSize)) {
        reporter.error(pathFor(building), `footprint ${rect.x0},${rect.y0}..${rect.x1},${rect.y1} is outside 0..${mapSize - 1}`);
    }
}

function validateCapacity(reporter, building, approachFiles) {
    const capacity = building.capacity;
    if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) {
        reporter.error(pathFor(building, 'capacity'), 'must be an object');
        return;
    }
    for (const field of CAPACITY_FIELDS) {
        if (!Number.isInteger(Number(capacity[field])) || Number(capacity[field]) < 0) {
            reporter.error(pathFor(building, `capacity.${field}`), 'must be a non-negative integer');
        }
    }
    const visitTiles = Array.isArray(building.visitTiles) ? building.visitTiles : [];
    const approachKeys = new Set((approachFiles?.[building.type] || []).map((tile) => tileKey(tile.tileX, tile.tileY)));
    const scorableCount = visitTiles.filter((tile) => !approachKeys.has(tileKey(tile.tileX, tile.tileY))).length;
    if (Number(capacity.work) > scorableCount) {
        reporter.error(pathFor(building, 'capacity.work'), `work capacity ${capacity.work} exceeds ${scorableCount} scorable visit tile(s)`);
    }
    if (Number(capacity.ambient) > scorableCount) {
        reporter.error(pathFor(building, 'capacity.ambient'), `ambient capacity ${capacity.ambient} exceeds ${scorableCount} scorable visit tile(s)`);
    }
    if (building.visitCapacity != null && Number(building.visitCapacity) > scorableCount) {
        reporter.error(pathFor(building, 'visitCapacity'), `visitCapacity ${building.visitCapacity} exceeds ${scorableCount} scorable visit tile(s)`);
    }
}

function validateEntrance(reporter, building, mapSize) {
    const entrance = building.entrance;
    if (!entrance || typeof entrance !== 'object') {
        reporter.error(pathFor(building, 'entrance'), 'must be an object');
        return;
    }
    if (!inTileBounds(entrance.tileX, entrance.tileY, mapSize)) {
        reporter.error(pathFor(building, 'entrance'), `tile ${entrance.tileX},${entrance.tileY} is outside 0..${mapSize - 1}`);
    }
    const visitKeys = new Set((building.visitTiles || []).map((tile) => tileKey(tile.tileX, tile.tileY)));
    if (visitKeys.size && !visitKeys.has(tileKey(entrance.tileX, entrance.tileY))) {
        reporter.error(pathFor(building, 'entrance'), 'entrance is not present in visitTiles');
    }
}

function validateFacingPoint(reporter, building, tile, index, mapSize) {
    const point = tile.facingPoint;
    const path = pathFor(building, `visitTiles[${index}].facingPoint`);
    if (!point || typeof point !== 'object') {
        reporter.error(path, 'must be an object');
        return;
    }
    if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
        reporter.error(path, 'x and y must be finite numbers');
        return;
    }
    if (Number(point.x) < 0 || Number(point.x) > mapSize || Number(point.y) < 0 || Number(point.y) > mapSize) {
        reporter.error(path, `point ${point.x},${point.y} is outside rough map bounds 0..${mapSize}`);
    }
    const centerX = Number(building.x) + Number(building.width) / 2;
    const centerY = Number(building.y) + Number(building.height) / 2;
    const distance = Math.hypot(Number(point.x) - centerX, Number(point.y) - centerY);
    const maxExpectedDistance = Math.max(8, Number(building.width) + Number(building.height) + 2);
    if (distance > maxExpectedDistance) {
        reporter.warn(path, `point is ${distance.toFixed(1)} tiles from building center`);
    }
}

function validateVisitTiles(reporter, building, mapSize, globalVisitTiles) {
    if (!Array.isArray(building.visitTiles) || building.visitTiles.length === 0) {
        reporter.error(pathFor(building, 'visitTiles'), 'must be a non-empty array');
        return;
    }
    const localVisitTiles = new Set();
    const rect = buildingRect(building);
    building.visitTiles.forEach((tile, index) => {
        const path = pathFor(building, `visitTiles[${index}]`);
        if (!inTileBounds(tile.tileX, tile.tileY, mapSize)) {
            reporter.error(path, `tile ${tile.tileX},${tile.tileY} is outside 0..${mapSize - 1}`);
        }
        const key = tileKey(tile.tileX, tile.tileY);
        if (localVisitTiles.has(key)) {
            reporter.error(path, `duplicates another visit tile at ${key}`);
        }
        localVisitTiles.add(key);
        const owner = globalVisitTiles.get(key);
        if (owner && owner !== building.type) {
            reporter.error(path, `duplicates ${owner} visit tile at ${key}`);
        } else {
            globalVisitTiles.set(key, building.type);
        }
        if (
            Number(tile.tileX) >= rect.x0
            && Number(tile.tileX) <= rect.x1
            && Number(tile.tileY) >= rect.y0
            && Number(tile.tileY) <= rect.y1
        ) {
            reporter.error(path, 'visit tile sits inside the building footprint');
        }
        validateFacingPoint(reporter, building, tile, index, mapSize);
    });
}

function validateWalkExclusions(reporter, building, mapSize) {
    if (!Array.isArray(building.walkExclusion)) {
        reporter.error(pathFor(building, 'walkExclusion'), 'must be an array');
        return;
    }
    building.walkExclusion.forEach((exclusion, index) => {
        const path = pathFor(building, `walkExclusion[${index}]`);
        if (!exclusion || typeof exclusion !== 'object') {
            reporter.error(path, 'must be an object');
            return;
        }
        if (!isPositiveNumber(exclusion.width) || !Number.isInteger(Number(exclusion.width))) {
            reporter.error(`${path}.width`, 'must be a positive integer');
        }
        if (!isPositiveNumber(exclusion.height) || !Number.isInteger(Number(exclusion.height))) {
            reporter.error(`${path}.height`, 'must be a positive integer');
        }
        const hasAbsolute = isFiniteNumber(exclusion.x) && isFiniteNumber(exclusion.y);
        const hasRelative = isFiniteNumber(exclusion.dx) || isFiniteNumber(exclusion.dy);
        if (!hasAbsolute && !hasRelative) {
            reporter.error(path, 'must specify x/y or dx/dy');
        }
        const rect = walkExclusionRect(building, exclusion);
        if (!rectInsideMap(rect, mapSize)) {
            reporter.error(path, `rect ${rect.x0},${rect.y0}..${rect.x1},${rect.y1} is outside 0..${mapSize - 1}`);
        }
    });
}

function tileInsideRect(tile, rect) {
    return Number(tile.tileX) >= rect.x0
        && Number(tile.tileX) <= rect.x1
        && Number(tile.tileY) >= rect.y0
        && Number(tile.tileY) <= rect.y1;
}

function validateCombinedVisitTiles(reporter, buildings, overflowTiles, approachFiles, mapSize) {
    const buildingTypes = new Set(buildings.map((building) => building.type));
    const claimedTiles = new Map();
    const clearance = createWalkClearance({ buildings, pad: FOOTPRINT_CLEARANCE_PAD });

    for (const type of Object.keys(overflowTiles || {})) {
        if (!buildingTypes.has(type)) {
            reporter.error(`VISIT_OVERFLOW_TILES.${type}`, 'has no matching BUILDING_DEFS type');
        }
    }
    for (const type of Object.keys(approachFiles || {})) {
        if (!buildingTypes.has(type)) {
            reporter.error(`APPROACH_FILES.${type}`, 'has no matching BUILDING_DEFS type');
        }
    }

    for (const building of buildings) {
        const groups = [
            ['visitTiles', building.visitTiles || []],
            ['overflow', overflowTiles?.[building.type] || []],
            ['approach', approachFiles?.[building.type] || []],
        ];
        for (const [group, tiles] of groups) {
            if (!Array.isArray(tiles)) {
                reporter.error(pathFor(building, group), 'must be an array');
                continue;
            }
            tiles.forEach((tile, index) => {
                const path = group === 'visitTiles'
                    ? pathFor(building, `visitTiles[${index}]`)
                    : group === 'overflow'
                        ? `VISIT_OVERFLOW_TILES.${building.type}[${index}]`
                        : `APPROACH_FILES.${building.type}[${index}]`;
                if (!tile || typeof tile !== 'object') {
                    reporter.error(path, 'must be an object');
                    return;
                }
                if (!inTileBounds(tile.tileX, tile.tileY, mapSize)) {
                    reporter.error(path, `tile ${tile.tileX},${tile.tileY} is outside 0..${mapSize - 1}`);
                    return;
                }
                const key = tileKey(tile.tileX, tile.tileY);
                const previous = claimedTiles.get(key);
                if (previous) {
                    reporter.error(path, `duplicates ${previous} at ${key}`);
                } else {
                    claimedTiles.set(key, path);
                }
                let reportedDiscrete = false;
                for (const obstacle of buildings) {
                    if (tileInsideRect(tile, buildingRect(obstacle))) {
                        reporter.error(path, `sits inside ${obstacle.type} building footprint`);
                        reportedDiscrete = true;
                    }
                    for (const exclusion of obstacle.walkExclusion || []) {
                        if (tileInsideRect(tile, walkExclusionRect(obstacle, exclusion))) {
                            reporter.error(path, `sits inside ${obstacle.type} walk exclusion`);
                            reportedDiscrete = true;
                        }
                    }
                }
                if (!reportedDiscrete && !clearance.isTileClearOfBuildings(Number(tile.tileX), Number(tile.tileY))) {
                    reporter.error(path, `tile ${tile.tileX},${tile.tileY} violates ${FOOTPRINT_CLEARANCE_PAD}-tile building footprint/exclusion clearance`);
                }
            });
        }
    }
}

const SLOT_OCCLUSION_ALPHA_THRESHOLD = 128;
const SLOT_OCCLUSION_SAMPLE_OFFSETS_Y = Object.freeze([0, -24]);

function loadBuildingSpritesForOcclusion(buildings, manifest) {
    const entries = new Map(collectSpriteEntries(manifest, ['buildings']).map((entry) => [entry.id, entry]));
    const sprites = [];
    for (const building of buildings) {
        const id = `building.${building.type}`;
        const entry = entries.get(id);
        const relPath = entry ? pathForEntry(entry) : `buildings/${id}/base.png`;
        const fullPath = join(spritesRoot, relPath);
        if (!existsSync(fullPath)) continue;
        const png = PNG.sync.read(readFileSync(fullPath));
        const anchor = Array.isArray(entry?.anchor) ? entry.anchor : [png.width / 2, png.height];
        const center = buildingCenterToWorld(building);
        const left = Math.round(center.x - anchor[0]);
        const top = Math.round(center.y - anchor[1]);
        const x0 = Number(building.x);
        const y0 = Number(building.y);
        const x1 = x0 + Number(building.width);
        const y1 = y0 + Number(building.height);
        const seY = tileToWorld(x1 - 1, y1 - 1).y;
        let minVisitY = Infinity;
        for (const vt of building.visitTiles || []) {
            minVisitY = Math.min(minVisitY, tileToWorld(vt.tileX, vt.tileY).y);
        }
        const anchorSortY = Math.min(minVisitY, seY);
        const backSortY = tileToWorld(x0, y0).y;
        const frontSortY = Math.max(tileToWorld(x1, y1).y, anchorSortY - 0.5);
        const wholeSortY = anchorSortY - 0.5;
        const openFloors = (building.openFloor || []).map((rect) => walkExclusionRect(building, rect));
        sprites.push({
            type: building.type,
            x0,
            y0,
            x1,
            y1,
            left,
            top,
            png,
            splitForOcclusion: entry?.splitForOcclusion === true,
            backSortY,
            frontSortY,
            wholeSortY,
            openFloors,
        });
    }
    return sprites;
}

function spriteAlphaAt(sprite, wx, wy) {
    const lx = Math.round(wx - sprite.left);
    const ly = Math.round(wy - sprite.top);
    if (lx < 0 || ly < 0 || lx >= sprite.png.width || ly >= sprite.png.height) return 0;
    return sprite.png.data[(ly * sprite.png.width + lx) * 4 + 3];
}

function isBehindBuildingSprite(sprite, tileX, tileY, wy) {
    if (wy <= sprite.backSortY) return true;
    if (sprite.splitForOcclusion) {
        return wy <= sprite.frontSortY && tileX < sprite.x1 && tileY < sprite.y1;
    }
    return wy <= sprite.wholeSortY;
}

function validateSlotSpriteOcclusion(reporter, buildings, overflowTiles, approachFiles, manifest) {
    const sprites = loadBuildingSpritesForOcclusion(buildings, manifest);
    for (const building of buildings) {
        const groups = [
            ['visitTiles', building.visitTiles || []],
            ['overflow', overflowTiles?.[building.type] || []],
            ['approach', approachFiles?.[building.type] || []],
        ];
        for (const [group, tiles] of groups) {
            if (!Array.isArray(tiles)) continue;
            tiles.forEach((tile, index) => {
                if (!tile || !isFiniteNumber(tile.tileX) || !isFiniteNumber(tile.tileY)) return;
                const tx = Number(tile.tileX);
                const ty = Number(tile.tileY);
                const path = group === 'visitTiles'
                    ? pathFor(building, `visitTiles[${index}]`)
                    : group === 'overflow'
                        ? `VISIT_OVERFLOW_TILES.${building.type}[${index}]`
                        : `APPROACH_FILES.${building.type}[${index}]`;
                const world = tileToWorld(tx, ty);
                for (const sprite of sprites) {
                    if (sprite.openFloors.some((rect) => tileInsideRect(tile, rect))) continue;
                    if (!isBehindBuildingSprite(sprite, tx, ty, world.y)) continue;
                    const occluded = SLOT_OCCLUSION_SAMPLE_OFFSETS_Y.some(
                        (dy) => spriteAlphaAt(sprite, world.x, world.y + dy) >= SLOT_OCCLUSION_ALPHA_THRESHOLD,
                    );
                    if (occluded) {
                        const relation = sprite.type === building.type ? 'its own' : `building.${sprite.type}`;
                        reporter.error(path, `tile ${tx},${ty} is hidden behind ${relation} sprite alpha`);
                    }
                }
            });
        }
    }
}

// Spec 04 §2.3 — every landmark's authored `sign.at` (sprite-local, the
// bracket bolt over the door) hangs the one `signBoxFor` box: >= 60 % on the
// building's own opaque texels (alpha > 16, the runtime mask threshold), on no
// emissive texel (raw `base.emissive.png` alpha and the registry
// `windowRects` glass alike) and outside every aperture cut. The renderer
// reads the same box (BuildingPlaques), so a green run is the runtime truth.
const SIGN_MIN_OPAQUE = 0.6;
const SIGN_ALPHA_THRESHOLD = 16;

function readSpritePng(type, name) {
    const fullPath = join(spritesRoot, 'buildings', `building.${type}`, name);
    return existsSync(fullPath) ? PNG.sync.read(readFileSync(fullPath)) : null;
}

export function signAnchorReport(type, visual, base, emissive) {
    const at = visual?.sign?.at;
    if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) return { error: '`sign.at` must be a finite sprite-local [x, y]' };
    const box = signBoxFor(at);
    const cut = visual?.aperture?.cut || null;
    const windows = (visual?.windowRects || []).map((rect) => windowRectBounds(rect));
    let opaque = 0;
    let emissiveTexels = 0;
    let windowTexels = 0;
    let cutTexels = 0;
    let outside = 0;
    for (let y = box.top; y < box.top + box.h; y++) {
        for (let x = box.left; x < box.left + box.w; x++) {
            if (x < 0 || y < 0 || x >= base.width || y >= base.height) {
                outside++;
                continue;
            }
            const index = (y * base.width + x) * 4;
            if (base.data[index + 3] > SIGN_ALPHA_THRESHOLD) opaque++;
            if (emissive && x < emissive.width && y < emissive.height
                && emissive.data[(y * emissive.width + x) * 4 + 3] > 0) emissiveTexels++;
            if (windows.some((w) => x >= w.left && x < w.left + w.w && y >= w.top && y < w.top + w.h)) windowTexels++;
            if (cut && apertureCutContains(cut, x + 0.5, y + 0.5)) cutTexels++;
        }
    }
    return { box, opaque: opaque / (box.w * box.h), emissiveTexels, windowTexels, cutTexels, outside };
}

export function validateSignAnchors(reporter, buildings, registry) {
    for (const building of buildings) {
        if (building.labelPriority !== 'landmark') continue;
        const path = `registry.${building.type}.sign.at`;
        const visual = registry[building.type];
        const base = readSpritePng(building.type, 'base.png');
        if (!base) {
            reporter.error(path, 'no base.png to measure the sign box against');
            continue;
        }
        const report = signAnchorReport(building.type, visual, base, readSpritePng(building.type, 'base.emissive.png'));
        if (report.error) {
            reporter.error(path, report.error);
            continue;
        }
        const { box } = report;
        const where = `box ${box.left},${box.top} ${box.w}x${box.h}`;
        if (report.outside) reporter.error(path, `${where} leaves the sprite by ${report.outside} texel(s)`);
        if (report.opaque < SIGN_MIN_OPAQUE) {
            reporter.error(path, `${where} lies ${(report.opaque * 100).toFixed(1)}% on own opaque texels; expected >= ${SIGN_MIN_OPAQUE * 100}%`);
        }
        if (report.emissiveTexels) reporter.error(path, `${where} covers ${report.emissiveTexels} emissive texel(s)`);
        if (report.windowTexels) reporter.error(path, `${where} covers ${report.windowTexels} windowRects glass texel(s)`);
        if (report.cutTexels) reporter.error(path, `${where} enters the aperture cut on ${report.cutTexels} texel(s)`);
    }
}

// W5-B (D6, R9) — which buildings may open, and how: lifted-roof cutaways
// for Command, Archive and Harbor only; open fronts for the Tavern and the
// Forge only. The Mine and the Task board get nothing.
export const CUTAWAY_BUILDINGS = Object.freeze(['command', 'archive', 'harbor']);
export const OPEN_FRONT_BUILDINGS = Object.freeze(['tavern', 'forge']);

function pngAlphaAt(png, x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (!png || ix < 0 || iy < 0 || ix >= png.width || iy >= png.height) return 0;
    return png.data[(iy * png.width + ix) * 4 + 3];
}

/**
 * Spec 04 §5.1–5.3 — every cutaway's layers are registered with base.png
 * (same size, every texel inside the cut on base.png's silhouette, zero
 * semi-alpha, `roof` byte-exact to base.png over the cut) and every slot lies
 * inside its cut parallelogram, below the back-wall floor line, on an opaque
 * floor texel of its aperture layer and on the building itself.
 */
export function cutawayReport(type, aperture, readPng = (name) => readSpritePng(type, name)) {
    const errors = [];
    const stack = normalizeApertureLayers(aperture?.layers);
    if (!stack) return { errors: ['`layers` must be [aperture, interior, foreground] or [roof, aperture, interior, foreground]'] };
    if (!aperture.cut || !Array.isArray(aperture.slots) || !aperture.slots.length) return { errors: ['needs a `cut` and at least one slot'] };
    const base = readPng('base.png');
    if (!base) return { errors: ['no base.png'] };
    const inCut = (x, y) => base.data[(y * base.width + x) * 4 + 3] > 0 && apertureCutContains(aperture.cut, x + 0.5, y + 0.5);
    const layers = {};
    for (const name of stack.layers) {
        const png = readPng(`${name}.png`);
        if (!png) {
            errors.push(`layer ${name}.png is missing`);
            continue;
        }
        layers[name] = png;
        if (png.width !== base.width || png.height !== base.height) {
            errors.push(`layer ${name}.png is ${png.width}x${png.height}, not registered to base.png ${base.width}x${base.height}`);
            continue;
        }
        let semi = 0;
        let outside = 0;
        let roofMismatch = 0;
        for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
                const o = (y * png.width + x) * 4;
                const a = png.data[o + 3];
                const inside = inCut(x, y);
                if (name === stack.roof) {
                    for (let c = 0; c < 4; c++) {
                        if (png.data[o + c] !== (inside ? base.data[o + c] : 0)) {
                            roofMismatch++;
                            break;
                        }
                    }
                    continue;
                }
                if (a === 0) continue;
                if (a !== 255) semi++;
                if (!inside) outside++;
            }
        }
        if (semi) errors.push(`layer ${name}.png has ${semi} semi-transparent texel(s)`);
        if (outside) errors.push(`layer ${name}.png paints ${outside} texel(s) outside the cut`);
        if (roofMismatch) errors.push(`layer ${name}.png differs from base.png's crop over the cut on ${roofMismatch} texel(s)`);
    }
    const floorLayer = layers[stack.aperture];
    let slotsChecked = 0;
    for (const slot of aperture.slots) {
        const at = slot?.at;
        const label = `slot ${slot?.id ?? slotsChecked}`;
        slotsChecked++;
        if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) {
            errors.push(`${label} needs a finite sprite-local \`at\``);
            continue;
        }
        if (!apertureCutContains(aperture.cut, at[0], at[1])) errors.push(`${label} [${at}] lies outside the cut`);
        const floorY = apertureFloorY(aperture, at[0]);
        if (Number.isFinite(floorY) && !(at[1] > floorY)) errors.push(`${label} [${at}] stands above the floor line (y ${floorY.toFixed(2)})`);
        if (floorLayer && pngAlphaAt(floorLayer, at[0], at[1]) !== 255) errors.push(`${label} [${at}] is not on an opaque ${stack.aperture}.png floor texel`);
        if (pngAlphaAt(base, at[0], at[1]) === 0) errors.push(`${label} [${at}] is off base.png's silhouette`);
    }
    return { errors, slots: slotsChecked, layers: stack.layers.length };
}

/**
 * W5 Fix-B (Fable P1-2) — every texel a cutaway's living painter can paint
 * lies inside its cut, on the building: the painters run at full capacity
 * (every war-table pawn upright and prone, twelve shelf spines with a `+99`
 * stamp, a Loom panel, four lanterns with a `+99` stamp, both furniture
 * tops) against a recording context, and each filled rect is checked texel
 * by texel with `apertureCutContains` (pixel centres, the bakers'
 * convention). The sill bar and bay names are legends below the cut, not
 * painters, and are left out.
 */
export function livingPainterReport(type, aperture, readPng = (name) => readSpritePng(type, name)) {
    const base = readPng('base.png');
    if (!base || !aperture?.cut) return null;
    const rects = [];
    const ctx = {
        fillStyle: '#000000',
        globalAlpha: 1,
        fillRect(x, y, w, h) { rects.push({ x, y, w, h, kind: 'fill' }); },
        drawImage(...args) {
            const [dx, dy, dw, dh] = args.length >= 9 ? args.slice(5, 9) : [args[1], args[2], args[0]?.width || 0, args[0]?.height || 0];
            rects.push({ x: dx, y: dy, w: dw, h: dh, kind: 'image' });
        },
        save() {},
        restore() {},
    };
    const profile = BUILDING_CUTAWAY_PROFILES[type];
    if (type === 'command') {
        const pawns = [];
        for (const landmark of Object.values(WAR_TABLE_LANDMARKS)) {
            const at = warTableTexelToSprite(landmark.tx, landmark.ty, profile.table);
            pawns.push({ spriteX: at.x, spriteY: at.y, width: 3, height: 5, orientation: 'upright' });
            pawns.push({ spriteX: at.x, spriteY: at.y, width: 5, height: 3, orientation: 'prone' });
        }
        // Every landmark in both orientations, in batches of the table's cap.
        for (let i = 0; i < pawns.length; i += WAR_TABLE_MAX_PAWNS) {
            drawCommandWarTable(ctx, {
                table: profile.table,
                landmarks: Object.values(WAR_TABLE_LANDMARKS),
                pawns: pawns.slice(i, i + WAR_TABLE_MAX_PAWNS),
                sillBar: null,
            });
        }
    } else if (type === 'archive') {
        const today = Date.now();
        const state = buildArchiveCutawayState({
            agents: [],
            compactions: Array.from({ length: 12 + 99 }, (_, i) => ({ id: `c${i}`, agentId: 'a', timestamp: today })),
            now: new Date(today),
            loomPanel: { width: 96, height: 72 },
        });
        drawArchiveCutaway(ctx, state, { showBayNames: false });
    } else if (type === 'harbor') {
        const state = buildHarborCutawayState({
            agents: [],
            harborPendingRepos: Array.from({ length: HARBOR_MAX_LANTERNS + 99 }, (_, i) => ({ repo: `repo-${i}`, pendingCommits: 1 })),
        });
        drawHarborCutaway(ctx, state, { layer: 'all' });
    } else {
        return null;
    }
    let outside = 0;
    let offArt = 0;
    const first = [];
    for (const rect of rects) {
        for (let y = Math.floor(rect.y); y < Math.floor(rect.y) + Math.ceil(rect.h); y++) {
            for (let x = Math.floor(rect.x); x < Math.floor(rect.x) + Math.ceil(rect.w); x++) {
                if (!apertureCutContains(aperture.cut, x + 0.5, y + 0.5)) {
                    outside++;
                    if (first.length < 3) first.push(`[${x},${y}]`);
                } else if (pngAlphaAt(base, x, y) === 0) {
                    offArt++;
                }
            }
        }
    }
    const errors = [];
    if (outside) errors.push(`living painters paint ${outside} texel(s) outside the cut (first ${first.join(' ')})`);
    if (offArt) errors.push(`living painters paint ${offArt} texel(s) off base.png's silhouette`);
    return { errors, rects: rects.length };
}

export function validateCutaways(reporter, registry = BUILDING_VISUAL_REGISTRY) {
    for (const [type, visual] of Object.entries(registry)) {
        const aperture = visual?.aperture;
        if (aperture && !CUTAWAY_BUILDINGS.includes(type)) {
            reporter.error(`registry.${type}.aperture`, 'D6: only Command, Archive and Harbor open a lifted-roof cutaway');
            continue;
        }
        if (visual?.openFront && !OPEN_FRONT_BUILDINGS.includes(type)) {
            reporter.error(`registry.${type}.openFront`, 'D6: only the Tavern and the Forge are open fronts');
        }
        if (!aperture) continue;
        const report = cutawayReport(type, aperture);
        for (const error of report.errors) reporter.error(`registry.${type}.aperture`, error);
        const living = livingPainterReport(type, aperture);
        for (const error of living?.errors || []) reporter.error(`registry.${type}.aperture`, error);
    }
    for (const type of CUTAWAY_BUILDINGS) {
        if (!registry[type]?.aperture) reporter.error(`registry.${type}.aperture`, 'D6: missing lifted-roof cutaway profile');
    }
}

/**
 * Spec 03 §2 (Wave 5 depth gate) — when `base.surface.png` exists (or the
 * registry declares `surfaceSidecar`): registered to base.png, H16 === 0 and
 * A === 0 outside alpha, normal index B in [0..63], valid bit on every covered
 * texel, and every authored `surfaceAoPairs` crevice at least as occluded as
 * its exposed texel.
 */
export function surfaceSidecarReport(type, visual, readPng = (name) => readSpritePng(type, name)) {
    const surface = readPng('base.surface.png');
    if (!surface) return visual?.surfaceSidecar ? { errors: ['registry declares surfaceSidecar but base.surface.png is missing'] } : null;
    const base = readPng('base.png');
    if (!base) return { errors: ['no base.png'] };
    if (surface.width !== base.width || surface.height !== base.height) {
        return { errors: [`base.surface.png is ${surface.width}x${surface.height}, base.png ${base.width}x${base.height}`] };
    }
    const errors = [];
    const validation = validateSurfaceV1Buffer(surface.data, base.data, surface.width, surface.height);
    if (!validation.ok) errors.push(...validation.errors.slice(0, 4));
    const pairs = getBuildingSurfaceAoPairs(type);
    if (pairs.length) {
        const mono = checkAoMonotonicity({ rgba: surface.data, width: surface.width, height: surface.height, pairs });
        if (!mono.ok) errors.push(`AO not monotonic: ${JSON.stringify(mono.violations)}`);
    } else if (visual?.surfaceSidecar) {
        errors.push('registry declares surfaceSidecar without surfaceAoPairs');
    }
    return { errors, stats: validation.stats };
}

export function validateSurfaceSidecars(reporter, buildings, registry = BUILDING_VISUAL_REGISTRY) {
    for (const building of buildings) {
        const report = surfaceSidecarReport(building.type, registry[building.type]);
        for (const error of report?.errors || []) reporter.error(`building.${building.type}/base.surface.png`, error);
    }
}

// W5-B (D6) — an open front this renderer draws (the Forge): its one
// OpenFront profile's arch rows parse inside the sprite and cover opaque
// texels only; every bay stands off the front arch, on the art, on a
// buildings.js work slot on the building's `openFloor`.
// `bake-forge-openfront.mjs --check` re-derives the profile from the pixels.
export function openFrontReport(type, record, readPng = (name) => readSpritePng(type, name), defs = null) {
    if (!record?.profile || record.drawables !== 'BuildingSprite') return null;
    const profile = OPEN_FRONT_PROFILES[record.profile];
    if (!profile) return { errors: [`unknown OpenFront profile "${record.profile}"`] };
    const base = readPng('base.png');
    if (!base) return { errors: ['no base.png'] };
    const errors = [];
    if (base.width !== profile.nativeSize.width || base.height !== profile.nativeSize.height) {
        errors.push(`base.png is ${base.width}x${base.height}, profile expects ${profile.nativeSize.width}x${profile.nativeSize.height}`);
    }
    const runs = parseArchRows(profile.frontArchRows, base.width, base.height);
    const front = new Uint8Array(base.width * base.height);
    let transparent = 0;
    for (const [y, x, length] of runs) {
        for (let i = x; i < x + length; i++) {
            front[y * base.width + i] = 1;
            if (base.data[(y * base.width + i) * 4 + 3] === 0) transparent++;
        }
    }
    if (!runs.length) errors.push('frontArchRows is empty');
    if (transparent) errors.push(`frontArchRows covers ${transparent} transparent texel(s)`);
    const def = (defs || []).find((candidate) => candidate.type === type) || null;
    for (const bay of profile.bays || []) {
        const [x, y] = bay.at || [];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            errors.push(`bay ${bay.id} needs a sprite-local \`at\``);
            continue;
        }
        if (front[y * base.width + x]) errors.push(`bay ${bay.id} [${x},${y}] stands on the front arch`);
        if (pngAlphaAt(base, x, y) === 0) errors.push(`bay ${bay.id} [${x},${y}] is off base.png's silhouette`);
        if (!def) continue;
        const tile = bay.tile || {};
        const slot = (def.visitTiles || []).find((visit) => visit.tileX === tile.tileX && visit.tileY === tile.tileY);
        if (!slot || slot.role !== 'work') errors.push(`bay ${bay.id} tile (${tile.tileX},${tile.tileY}) is not a work visit tile`);
        const onFloor = (def.openFloor || []).some((rect) => tile.tileX >= def.x + rect.dx && tile.tileX < def.x + rect.dx + rect.width
            && tile.tileY >= def.y + rect.dy && tile.tileY < def.y + rect.dy + rect.height);
        if (!onFloor) errors.push(`bay ${bay.id} tile (${tile.tileX},${tile.tileY}) is not on the building's openFloor`);
        const blocked = (def.walkExclusion || []).some((rect) => tile.tileX >= def.x + (rect.dx || 0) && tile.tileX < def.x + (rect.dx || 0) + rect.width
            && tile.tileY >= def.y + (rect.dy || 0) && tile.tileY < def.y + (rect.dy || 0) + rect.height);
        if (blocked && !onFloor) errors.push(`bay ${bay.id} tile (${tile.tileX},${tile.tileY}) is walk-excluded`);
    }
    return { errors };
}

export function validateOpenFronts(reporter, registry = BUILDING_VISUAL_REGISTRY, defs = null) {
    for (const [type, visual] of Object.entries(registry)) {
        const report = openFrontReport(type, visual?.openFront, undefined, defs);
        for (const error of report?.errors || []) reporter.error(`registry.${type}.openFront`, error);
    }
}

function validateSpriteManifest(reporter, buildings, manifestIds) {
    const expectedIds = new Set(buildings.map((building) => `building.${building.type}`));
    for (const id of expectedIds) {
        if (!manifestIds.has(id)) {
            reporter.error(id, 'missing building sprite entry in manifest.yaml');
        }
    }
    for (const id of manifestIds) {
        if (id.startsWith('building.') && !expectedIds.has(id)) {
            reporter.warn(id, 'manifest has a building sprite with no matching BUILDING_DEFS type');
        }
    }
}

async function main() {
    const reporter = createReporter('world building validation');
    const {
        BUILDING_DEFS,
        VISIT_OVERFLOW_TILES,
    } = await loadConfigExports(
        'claudeville/src/config/buildings.js',
        ['BUILDING_DEFS', 'VISIT_OVERFLOW_TILES'],
    );
    const {
        MAP_SIZE,
    } = await loadConfigExports('claudeville/src/config/constants.js', ['MAP_SIZE']);
    const manifest = loadSpriteManifest();
    const manifestIds = await loadManifestIds();
    const groundingConfig = await loadConfigExports(
        'claudeville/src/config/buildingGrounding.js',
        [
            'BUILDING_GROUNDING_MODES',
            'BUILDING_GROUNDING_MATERIALS',
            'BUILDING_GROUNDING_EDGE_TREATMENTS',
            'BUILDING_GROUNDING_SHADOWS',
            'BUILDING_GROUNDING_PROFILES',
        ],
    );

    if (!Array.isArray(BUILDING_DEFS) || BUILDING_DEFS.length === 0) {
        reporter.error('BUILDING_DEFS', 'must be a non-empty array');
    } else {
        const seenTypes = new Set();
        const globalVisitTiles = new Map();
        for (const building of BUILDING_DEFS) {
            validateRequiredFields(reporter, building);
            if (seenTypes.has(building.type)) {
                reporter.error(pathFor(building), `duplicate building type "${building.type}"`);
            }
            seenTypes.add(building.type);
            validateScalarFields(reporter, building, MAP_SIZE);
            validateCapacity(reporter, building, APPROACH_FILES);
            validateEntrance(reporter, building, MAP_SIZE);
            validateVisitTiles(reporter, building, MAP_SIZE, globalVisitTiles);
            validateWalkExclusions(reporter, building, MAP_SIZE);
        }
        validateCombinedVisitTiles(reporter, BUILDING_DEFS, VISIT_OVERFLOW_TILES, APPROACH_FILES, MAP_SIZE);
        validateSlotSpriteOcclusion(reporter, BUILDING_DEFS, VISIT_OVERFLOW_TILES, APPROACH_FILES, manifest);
        validateSpriteManifest(reporter, BUILDING_DEFS, manifestIds);
        validateGroundingProfiles(reporter, BUILDING_DEFS, groundingConfig);
        validateSignAnchors(reporter, BUILDING_DEFS, BUILDING_VISUAL_REGISTRY);
        validateSurfaceSidecars(reporter, BUILDING_DEFS, BUILDING_VISUAL_REGISTRY);
    }
    // W5-B (D6) — lifted-roof cutaways and calibrated open fronts.
    validateCutaways(reporter, BUILDING_VISUAL_REGISTRY);
    validateOpenFronts(reporter, BUILDING_VISUAL_REGISTRY, BUILDING_DEFS);
    // BL-6 — art geometry: window/room rects on the sidecar glass, room masks
    // (plan 6.3), frame-strip parts well-formed (plan 6.1).
    validateWindowGeometry(reporter, { registry: BUILDING_VISUAL_REGISTRY, spritesRoot });
    validateRoomMasks(reporter, { registry: BUILDING_VISUAL_REGISTRY, spritesRoot });
    validateFrameStripParts(reporter, {
        entries: collectSpriteEntries(manifest, ['buildings']),
        spritesRoot,
    });

    reporter.finish(`${BUILDING_DEFS.length} building definition(s) checked against ${manifestIds.size} manifest id(s).`);
}

// Run as a script; tests import the sign-anchor checks without running it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
