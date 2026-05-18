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

function validateCapacity(reporter, building) {
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
    const visitCount = Array.isArray(building.visitTiles) ? building.visitTiles.length : 0;
    if (Number(capacity.work) > visitCount) {
        reporter.error(pathFor(building, 'capacity.work'), `work capacity ${capacity.work} exceeds ${visitCount} visit tile(s)`);
    }
    if (building.visitCapacity != null && Number(building.visitCapacity) > visitCount) {
        reporter.error(pathFor(building, 'visitCapacity'), `visitCapacity ${building.visitCapacity} exceeds ${visitCount} visit tile(s)`);
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
        reporter.warn(pathFor(building, 'entrance'), 'entrance is not present in visitTiles');
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

const reporter = createReporter('world building validation');
const {
    BUILDING_DEFS,
} = await loadConfigExports('claudeville/src/config/buildings.js', ['BUILDING_DEFS']);
const {
    MAP_SIZE,
} = await loadConfigExports('claudeville/src/config/constants.js', ['MAP_SIZE']);
const manifestIds = await loadManifestIds();

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
        validateCapacity(reporter, building);
        validateEntrance(reporter, building, MAP_SIZE);
        validateVisitTiles(reporter, building, MAP_SIZE, globalVisitTiles);
        validateWalkExclusions(reporter, building, MAP_SIZE);
    }
    validateSpriteManifest(reporter, BUILDING_DEFS, manifestIds);
}

reporter.finish(`${BUILDING_DEFS.length} building definition(s) checked against ${manifestIds.size} manifest id(s).`);
