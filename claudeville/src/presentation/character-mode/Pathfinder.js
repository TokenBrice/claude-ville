import { MAP_SIZE } from '../../config/constants.js';
import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../config/buildings.js';
import { AMBIENT_SCENIC_POINTS } from '../../config/scenery.js';
import { APPROACH_FILES, COMMAND_QUEUE, PORTAL_SPAWN_TILE, REST_SEATS, REST_STANDS, VILLAGE_GATE } from '../../config/townPlan.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const TILE_WEIGHTS = Object.freeze({
    bridge: 0.55,
    dock: 0.62,
    plaza: 0.68,
    road: 0.65,
    lane: 0.58,
    avoid: 1.35,
    standing: 2.5,
    congestionStep: 0.16,
    congestionMax: 1.2,
});

// Four shared profiles, not a unique set of weights per session.
export const ROUTE_PERSONALITIES = Object.freeze([
    Object.freeze({ road: 0.65 * 0.92, plaza: 0.68 * 1.08, lane: 0.58 * 0.92, bridgePreference: 0 }),
    Object.freeze({ road: 0.65 * 1.08, plaza: 0.68 * 0.92, lane: 0.58 * 1.08, bridgePreference: 1 }),
    Object.freeze({ road: 0.65 * 0.96, plaza: 0.68 * 1.04, lane: 0.58 * 1.08, bridgePreference: 0 }),
    Object.freeze({ road: 0.65 * 1.04, plaza: 0.68 * 0.96, lane: 0.58 * 0.92, bridgePreference: 1 }),
]);

export function routePersonalityFor(id) {
    const value = String(id || '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return (hash >>> 0) % ROUTE_PERSONALITIES.length;
}

// W0.2 — numeric routing grid. Every search runs on flat tile indices
// (idx = tileY * MAP_N + tileX) over preallocated typed arrays; no `${x},${y}`
// string is built inside a search. The string-keyed Sets and Maps callers pass
// (roads, lanes, bridges, crowd snapshots) are folded into the typed layers
// once per distinct content, never per query.
const MAP_N = MAP_SIZE;
const CELLS = MAP_N * MAP_N;
const DIR_COUNT = DIRS.length;
const DIR_OFFSET = Int32Array.from(DIRS, ([dx, dy]) => dy * MAP_N + dx);
const DIR_LENGTH = Float64Array.from(DIRS, ([dx, dy]) => (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1));
const DIR_OPPOSITE = Int8Array.from(DIRS, ([dx, dy]) => DIRS.findIndex(([ox, oy]) => ox === -dx && oy === -dy));
// (dy + 1) * 3 + (dx + 1) → the DIRS index of that unit step (-1 for none),
// so a straight-line walk can test each step against stepMask.
const STEP_DIR = Int8Array.from({ length: 9 }, (_, cell) => DIRS.findIndex(([dx, dy]) => dx === (cell % 3) - 1 && dy === Math.floor(cell / 3) - 1));
const MASK_DIRS = Array.from({ length: 256 }, (_, mask) => DIRS.map((_, dir) => dir).filter(dir => mask & (1 << dir)));
const OCTILE_DIAGONAL_EXTRA = Math.SQRT2 - 1;
const IndexArray = CELLS <= 0xffff ? Uint16Array : Uint32Array;
const SlotArray = CELLS <= 0x7fff ? Int16Array : Int32Array;

// staticFlags bits. Bit 0 follows the walk grid; bits 1..6 are the authored
// route layers (each loaded from one caller collection, see `_syncStatic`);
// bit 7 is reserved for Wave 6 terrace stairs (`tierGrid`).
const FLAG_WALK = 1;
const FLAG_BRIDGE = 2;
const FLAG_DOCK = 4;
const FLAG_PLAZA = 8;
const FLAG_ROAD = 16;
const FLAG_LANE = 32;
const FLAG_AVOID = 64;
const FLAG_STAIR = 128;
// FLAG_WALK in each byte of a 32-bit word of staticFlags.
const WALK_WORD = FLAG_WALK * 0x01010101;
const STATIC_ROLE_FLAGS = Object.freeze([FLAG_BRIDGE, FLAG_DOCK, FLAG_PLAZA, FLAG_ROAD, FLAG_LANE, FLAG_AVOID]);
const RICH_ROUTE_FLAGS = FLAG_DOCK | FLAG_PLAZA | FLAG_ROAD | FLAG_LANE;
const CROWD_STANDING = 1;
const CROWD_CONGESTION = 2;

// 2D Gaussian congestion field: radius 2, sigma 1.15, peak-normalised so a
// lone crowded tile keeps its legacy cost and its neighbours share a falloff
// (a crowded bridge deck raises its approaches, which splits a crowd across
// the other crossing). congestionCost = min(1.2, congestionBlur * 0.16).
const CONGESTION_RADIUS = 2;
const CONGESTION_SIGMA = 1.15;
const CONGESTION_KERNEL = (() => {
    const size = CONGESTION_RADIUS * 2 + 1;
    const kernel = new Float32Array(size * size);
    for (let dy = -CONGESTION_RADIUS; dy <= CONGESTION_RADIUS; dy++) {
        for (let dx = -CONGESTION_RADIUS; dx <= CONGESTION_RADIUS; dx++) {
            kernel[(dy + CONGESTION_RADIUS) * size + dx + CONGESTION_RADIUS] = Math.exp(-(dx * dx + dy * dy) / (2 * CONGESTION_SIGMA * CONGESTION_SIGMA));
        }
    }
    return kernel;
})();

const PATH_CACHE_LIMIT = 384;
// Distinct bridge-map contents keyed before the unweighted cache restarts.
const BRIDGE_MAP_CODE_LIMIT = 1024;
export const FLOW_REBUILD_WINDOW_MS = 2000;
export const FLOW_TRACE_STEP_LIMIT = 128;

// The 16 fixed semantic sinks. Their seed tiles come from the town config, so
// the Pathfinder needs no renderer hook; VisitTileAllocator re-registers the
// building sinks from the live buildings it is handed (`setSinkTiles`).
export const SINK_NAMES = Object.freeze([
    'command', 'taskboard', 'forge', 'mine', 'archive', 'tavern', 'portal', 'watchtower', 'harbor',
    'command-queue',
    'rest:tavern-garden', 'rest:plaza-steps', 'rest:harbor-pier',
    'village-gate',
    'north-island',
    'portal-exit',
]);
export const SINK_COUNT = SINK_NAMES.length;
export const SINK_IDS = Object.freeze(Object.fromEntries(SINK_NAMES.map((name, index) => [name, index])));
export const BUILDING_SINK_TYPES = Object.freeze(SINK_NAMES.slice(0, 9));

// A landmark's sink: every place a visitor of it may be sent (visit slots,
// entrance, outer ring and approach file).
export function buildingSinkTiles(type, visitTiles = null) {
    const def = BUILDING_DEFS.find((entry) => entry.type === type);
    const base = Array.isArray(visitTiles) && visitTiles.length ? visitTiles : (def?.visitTiles || []);
    return [
        ...base,
        def?.entrance || null,
        ...(VISIT_OVERFLOW_TILES[type] || []),
        ...(APPROACH_FILES[type] || []),
    ].filter(Boolean);
}

export function defaultSinkTiles() {
    const sinks = BUILDING_SINK_TYPES.map((type) => buildingSinkTiles(type));
    sinks.push([...COMMAND_QUEUE.slots, ...COMMAND_QUEUE.overflow]);
    sinks.push([...REST_SEATS.filter((seat) => seat.building === 'tavern'), ...(REST_STANDS.tavern?.tiles || [])]);
    sinks.push(REST_SEATS.filter((seat) => seat.building !== 'tavern' && seat.occluder !== 'pier'));
    sinks.push(REST_SEATS.filter((seat) => seat.occluder === 'pier'));
    sinks.push([VILLAGE_GATE.inside, VILLAGE_GATE.outside]);
    sinks.push(AMBIENT_SCENIC_POINTS.filter((point) => point.district === 'north' || point.district === 'farm'));
    sinks.push([PORTAL_SPAWN_TILE]);
    return sinks;
}

// FNV-1a over bytes: the occupancy fingerprint shared with VisitTileAllocator.
export function fnv1a32(...arrays) {
    let hash = 0x811c9dc5;
    for (const bytes of arrays) {
        if (!bytes) continue;
        for (let index = 0; index < bytes.length; index++) {
            hash ^= bytes[index] & 0xff;
            hash = Math.imul(hash, 0x01000193);
        }
    }
    return hash >>> 0;
}

export function fnv1aString(value, seed = 0x811c9dc5) {
    let hash = seed;
    const text = String(value);
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function mix32(value) {
    let h = value >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

function combineKey(hash, value) {
    return Math.imul((hash ^ mix32(value)) >>> 0, 0x01000193) >>> 0;
}

// `${x},${y}` → flat index, or -1 for a malformed or off-map key.
export function tileKeyIndex(key) {
    if (typeof key !== 'string') return -1;
    const comma = key.indexOf(',');
    if (comma <= 0) return -1;
    const tileX = Number(key.slice(0, comma));
    const tileY = Number(key.slice(comma + 1));
    if (!Number.isInteger(tileX) || !Number.isInteger(tileY)) return -1;
    if (tileX < 0 || tileX >= MAP_N || tileY < 0 || tileY >= MAP_N) return -1;
    return tileY * MAP_N + tileX;
}

// Exact compare of a collection against the key sequence (and bridge info)
// its hash memo was taken from: an unchanged collection still holds the
// same key strings in the same insertion order, so this costs one iteration
// and a reference compare per key, with no parsing or hashing. Each
// collection shape keeps its own loop so every iteration site stays
// monomorphic (~2 ns a key).
function sameCollectionContent(collection, memo) {
    if (memo.isMap) return sameBridgeInfo(collection, memo.keys, memo.info);
    return collection instanceof Map ? sameMapKeys(collection, memo.keys) : sameSetKeys(collection, memo.keys);
}

function sameSetKeys(collection, keys) {
    let slot = 0;
    for (const key of collection) {
        if (key !== keys[slot]) return false;
        slot++;
    }
    return slot === keys.length;
}

function sameMapKeys(collection, keys) {
    let slot = 0;
    for (const key of collection.keys()) {
        if (key !== keys[slot]) return false;
        slot++;
    }
    return slot === keys.length;
}

function sameBridgeInfo(collection, keys, info) {
    let slot = 0;
    for (const key of collection.keys()) {
        if (key !== keys[slot]) return false;
        const value = collection.get(key);
        if (value?.bridgeId !== info[slot * 2] || value?.kind !== info[slot * 2 + 1]) return false;
        slot++;
    }
    return slot === keys.length;
}

const NEUTRAL_POLICY = Object.freeze({
    road: TILE_WEIGHTS.road,
    plaza: TILE_WEIGHTS.plaza,
    lane: TILE_WEIGHTS.lane,
    prefActive: false,
    prefCode: 0,
    kappa: 1,
    minWeight: Math.min(TILE_WEIGHTS.bridge, TILE_WEIGHTS.lane),
});

const HEUR_OCTILE = 1;
const HEUR_FIELD = 2;

export class Pathfinder {
    // `clock` drives the crowd rebuild windows: wall-clock milliseconds by
    // default, the clock VisitTileAllocator buckets its congestion snapshots
    // on, so a new window's crowd always finds its sinks free to rebuild.
    constructor(grid, { clock = null, surfaceRegistry = null } = {}) {
        this.surfaceRegistry = surfaceRegistry;
        // Keep the flat grid's dense slots. Only a second walkable floor on
        // the same tile needs another slot in the heap and integration fields.
        const nodeTiles = Array.from({ length: CELLS }, (_, tile) => tile);
        const ids = new Array(CELLS).fill(0);
        this._layers = new Map();
        this._links = new Map();
        this._inclines = new Set();
        for (const surface of surfaceRegistry?.surfaces || []) {
            if (!surface.walk) continue;
            const tile = surface.tile;
            const layers = this._layers.get(tile);
            const node = layers ? nodeTiles.length : tile;
            if (layers) {
                nodeTiles.push(tile);
                layers.push(node);
            } else this._layers.set(tile, [node]);
            ids[node] = surface.id;
            if (surface.plane16[1] || surface.plane16[2]) this._inclines.add(node);
        }
        this._nodeTiles = nodeTiles.length > CELLS ? Uint32Array.from(nodeTiles) : null;
        this._surfaceIds = surfaceRegistry && Uint16Array.from(ids);
        this._nodeCount = nodeTiles.length;
        this._surfaceHeights = surfaceRegistry && Float32Array.from(nodeTiles, (tile, node) =>
            surfaceRegistry.heightAt(tile % MAP_N, Math.floor(tile / MAP_N), ids[node]) ?? 0);
        for (const link of surfaceRegistry?.links || []) {
            const a = this._nodeFor(...link.from), b = this._nodeFor(...link.to);
            this._links.set(a * this._nodeCount + b, true);
            if (link.bidirectional || !this._links.has(b * this._nodeCount + a))
                this._links.set(b * this._nodeCount + a, link.bidirectional);
        }
        const nodes = this._nodeCount;
        const NodeArray = nodes > 65535 ? Uint32Array : IndexArray;
        const ParentArray = nodes > 32767 ? Int32Array : SlotArray;
        this._clock = typeof clock === 'function' ? clock : Date.now;
        this._perfNow = () => (globalThis.performance?.now?.() ?? Date.now());

        // Static layers (rebuilt when the walk grid or an authored route
        // collection changes). tierGrid is Wave 6 E2's terrace tier: all 0
        // (one grade) until terraces land; a tier change is a stair edge.
        this.staticFlags = new Uint8Array(CELLS);
        this.bridgeIdGrid = new Uint8Array(CELLS);
        this.baseCostLayer = new Float32Array(CELLS);
        this.tierGrid = new Uint8Array(CELLS);
        this.stepMask = new Uint8Array(CELLS);
        // Dynamic two-second crowd fields, keyed by their FNV-1a fingerprint.
        this.standingGrid = new Uint8Array(CELLS);
        this.congestionRaw = new Uint8Array(CELLS);
        this.congestionBlur = new Float32Array(CELLS);
        // Sink registry: integrated cost to each sink's nearest seed.
        this.sinkIntegration = new Float32Array(SINK_COUNT * nodes).fill(Infinity);
        this._sinkViews = Array.from({ length: SINK_COUNT }, (_, sink) => this.sinkIntegration.subarray(sink * nodes, (sink + 1) * nodes));
        this.sinkOf = new Uint8Array(nodes);
        // One preallocated indexed binary min-heap shared by every search.
        // heapIdx doubles as the BFS queue and trace scratch, heapPos as the
        // BFS parent link and heapCost as A*'s per-tile f score.
        this.heapIdx = new NodeArray(nodes);
        this.heapPos = new ParentArray(nodes);
        this.heapCost = new Float32Array(nodes);
        this.visited = new Uint8Array(nodes);
        this._heapSize = 0;

        this._targets = new Int32Array(9);
        this._targetCount = 0;
        this._lastLookupKind = 0;
        this._policy = { road: 0, plaza: 0, lane: 0, prefActive: false, prefCode: 0, kappa: 1, minWeight: 1 };
        this._samplePolicy = { road: 0, plaza: 0, lane: 0, prefActive: false, prefCode: 0, kappa: 1, minWeight: 1 };

        this._sinkSeeds = defaultSinkTiles().map((tiles) => this._seedIndices(tiles));
        this._sinkSeedVersion = new Uint32Array(SINK_COUNT);
        this._sinkBuilt = new Uint8Array(SINK_COUNT);
        this._sinkStaticKey = new Uint32Array(SINK_COUNT);
        this._sinkCrowdKey = new Uint32Array(SINK_COUNT);
        this._sinkBuiltSeedVersion = new Uint32Array(SINK_COUNT);
        this._sinkBuiltTopology = new Uint32Array(SINK_COUNT);
        this._sinkBuiltWindow = new Float64Array(SINK_COUNT);
        this._refreshSinkOf();

        this._roleHash = new Uint32Array(STATIC_ROLE_FLAGS.length);
        this._standingHash = 0;
        this._congestionHash = 0;
        // Crowd inputs re-read only while (object, supplied version) holds;
        // an unversioned collection is re-read on every lookup.
        this._standingRef = null;
        this._standingVersion = '';
        this._congestionRef = null;
        this._congestionVersion = '';
        // Content hashes of versioned route collections, per (object, version).
        this._collectionHashes = new WeakMap();
        this._bridgeCodes = new Map();
        this._bridgeIds = [];
        // Bridge-map content hash → small code for the unweighted cache key.
        this._bridgeMapCodes = new Map();
        this._bridgeMapSeq = 0;
        this._baseCostStaticKey = -1;
        this._primary = null;
        this._topologyVersion = 0;

        this._pathCache = new Map();
        // In-place grid edit guard (`_syncGrid`): word views of a 0/1 byte
        // grid and of staticFlags, whose bit 0 is the walk bit.
        this._flagWords = CELLS % 4 === 0 ? new Uint32Array(this.staticFlags.buffer, 0, CELLS >> 2) : null;
        this._gridWords = null;
        this._syncedGrid = null;
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
        this._rebuildTopology();
        this._resetStats();
    }

    _resetStats() {
        this._cacheHits = 0;
        this._cacheMisses = 0;
        this._flow = {
            lookups: 0,
            lookupMs: 0,
            maxLookupMs: 0,
            traceMs: 0,
            guidedMs: 0,
            adhocMs: 0,
            sinkLookups: 0,
            traceHits: 0,
            guidedSearches: 0,
            adhocSearches: 0,
            unweightedSearches: 0,
            staleFieldFallbacks: 0,
            rebuilds: 0,
            rebuildMs: 0,
            lastRebuildMs: 0,
            maxRebuildMs: 0,
            deferredRebuilds: 0,
            crowdIngests: 0,
            crowdChanges: 0,
            staticLoads: 0,
        };
    }

    _buildWalkableList(grid) {
        const tiles = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (grid[y * MAP_SIZE + x] === 1 && this._surfaceWalkable(y * MAP_SIZE + x)) tiles.push({ tileX: x, tileY: y });
            }
        }
        return tiles;
    }

    _surfaceWalkable(index) {
        const floors = this.surfaceRegistry?.getTileSurfacesByIndex(index);
        return !floors?.length || floors.some(s => s.walk);
    }

    _tileFor(node) {
        return this._nodeTiles ? this._nodeTiles[node] : node;
    }

    _nodeFor(tile, id, hint) {
        if (tile < 0) return -1;
        if (id == null && this.surfaceRegistry && this._layers.has(tile)) {
            const legacy = this.surfaceRegistry.resolveLegacySurface(tile % MAP_N, Math.floor(tile / MAP_N), hint);
            if (!legacy) return -1;
            tile = legacy.tile;
            id = legacy.surfaceId;
        }
        const layers = this._layers.get(tile);
        if (layers) return layers.find(node => this._surfaceIds[node] === id) ?? -1;
        return id == null || id === 0 ? tile : -1;
    }

    _waypoint(node) {
        const tile = this._tileFor(node);
        const point = { tileX: tile % MAP_N, tileY: Math.floor(tile / MAP_N) };
        if (this.surfaceRegistry) point.surfaceId = this._surfaceIds[node];
        return point;
    }

    _surfaceStep(from, to) {
        const linked = this._links.get(from * this._nodeCount + to);
        return linked ?? (this._surfaceIds[from] === this._surfaceIds[to]
            && this._surfaceHeights[from] === this._surfaceHeights[to]
            && !this._inclines.has(from) && !this._inclines.has(to));
    }

    _edges(node, reverse = false) {
        if (this._outgoing) return (reverse ? this._incoming : this._outgoing)[node];
        return MASK_DIRS[reverse && this._incomingMask ? this._incomingMask[node] : this.stepMask[node]];
    }

    _neighbor(node, edge) {
        return this._outgoing ? Math.floor(edge / 8) : node + DIR_OFFSET[edge];
    }

    // Visit each cell that the actual foot segment enters. Bresenham alone
    // can miss a short visit to the lower bank beside a stair landing.
    surfaceSegmentClear(x0, y0, x1, y1, startId, endId) {
        if (!this.surfaceRegistry) return true;
        let x = Math.round(x0), y = Math.round(y0);
        const endX = Math.round(x1), endY = Math.round(y1);
        if (!(Math.min(x, y, endX, endY) >= 0 && Math.max(x, y, endX, endY) < MAP_N)) return false;
        const dx = x1 - x0, dy = y1 - y0;
        const sx = Math.sign(dx), sy = Math.sign(dy);
        let node = y * MAP_N + x;
        if (this._outgoing) {
            node = this._nodeFor(node, startId);
            if (node < 0) return false;
        }
        while (x !== endX || y !== endY) {
            const crossX = x === endX ? Infinity : (x + 0.5 * sx - x0) / dx;
            const crossY = y === endY ? Infinity : (y + 0.5 * sy - y0) / dy;
            const nx = crossX <= crossY ? x + sx : x;
            const ny = crossY <= crossX ? y + sy : y;
            const tile = ny * MAP_N + nx;
            const dir = STEP_DIR[(ny - y + 1) * 3 + nx - x + 1];
            if (this._outgoing) {
                let next = -1;
                for (const edge of this._outgoing[node]) {
                    if ((edge & 7) !== dir) continue;
                    const dest = Math.floor(edge / 8);
                    if (next < 0 || this._surfaceIds[dest] === endId) next = dest;
                }
                if (next < 0) return false;
                node = next;
            } else {
                if (!(this.stepMask[node] & (1 << dir))) return false;
                node = tile;
            }
            x = nx; y = ny;
        }
        return endId == null || this._surfaceIds[node] === endId;
    }

    _stepLength(from, to, dir) {
        const rise = this._surfaceHeights && this._surfaceHeights[to] - this._surfaceHeights[from];
        return rise ? Math.hypot(DIR_LENGTH[dir], rise / 32) : DIR_LENGTH[dir];
    }

    // Walk bit + per-tile legal step mask under findPath's step rule: an
    // in-bounds walkable neighbour; a diagonal needs both axis neighbours
    // walkable (no corner cut across water or a wall); a tier change needs
    // an orthogonal stair pair. Directed surfaces also keep incoming steps.
    _rebuildTopology() {
        this._snapshotGrid();
        const flags = this.staticFlags;
        const grid = this.grid;
        for (let index = 0; index < CELLS; index++) {
            if (grid?.[index] === 1 && this._surfaceWalkable(index)) flags[index] |= FLAG_WALK;
            else flags[index] &= ~FLAG_WALK;
        }
        const mask = this.stepMask;
        const tier = this.tierGrid;
        for (let y = 0; y < MAP_N; y++) {
            for (let x = 0; x < MAP_N; x++) {
                const index = y * MAP_N + x;
                if (!(flags[index] & FLAG_WALK)) {
                    mask[index] = 0;
                    continue;
                }
                let bits = 0;
                for (let dir = 0; dir < DIR_COUNT; dir++) {
                    const dx = DIRS[dir][0];
                    const dy = DIRS[dir][1];
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= MAP_N || ny < 0 || ny >= MAP_N) continue;
                    const next = ny * MAP_N + nx;
                    if (!(flags[next] & FLAG_WALK)) continue;
                    if (dx !== 0 && dy !== 0 && (!(flags[y * MAP_N + nx] & FLAG_WALK) || !(flags[ny * MAP_N + x] & FLAG_WALK))) continue;
                    if (tier[next] !== tier[index]) {
                        const stair = dx === 0 || dy === 0
                            ? Math.abs(tier[next] - tier[index]) === 1 && (flags[next] & FLAG_STAIR) && (flags[index] & FLAG_STAIR)
                            : false;
                        if (!stair) continue;
                    }
                    bits |= 1 << dir;
                }
                mask[index] = bits;
            }
        }
        if (this.surfaceRegistry) {
            const multi = this._nodeCount > CELLS;
            this._incomingMask = new Uint8Array(CELLS);
            this._outgoing = multi && Array.from({ length: this._nodeCount }, () => []);
            this._incoming = multi && Array.from({ length: this._nodeCount }, () => []);
            const physicalMask = mask.slice();
            mask.fill(0);
            for (let from = 0; from < this._nodeCount; from++) {
                const tile = this._tileFor(from);
                for (const dir of MASK_DIRS[physicalMask[tile]]) {
                    const [dx, dy] = DIRS[dir];
                    const dest = tile + DIR_OFFSET[dir];
                    const axisClear = axis => (this._layers.get(axis) || [axis]).some(n => this._surfaceStep(from, n));
                    if (dx && dy && !(axisClear(tile + dx) && axisClear(tile + dy * MAP_N))) continue;
                    for (const to of this._layers.get(dest) || [dest]) {
                        if (!this._surfaceStep(from, to)) continue;
                        if (multi) {
                            this._outgoing[from].push(to * 8 + dir);
                            this._incoming[to].push(from * 8 + DIR_OPPOSITE[dir]);
                        }
                        if (from === tile && to === dest) {
                            mask[tile] |= 1 << dir;
                            this._incomingMask[dest] |= 1 << DIR_OPPOSITE[dir];
                        }
                    }
                }
            }
        }
        this._topologyVersion = (this._topologyVersion + 1) >>> 0;
    }

    sampleWalkable(rng) {
        return this.walkableTiles[Math.min(this.walkableTiles.length - 1, Math.floor(rng * this.walkableTiles.length))];
    }

    nearestWalkable(tileX, tileY, maxRadius = 8) {
        const originX = Math.round(tileX);
        const originY = Math.round(tileY);
        if (this.isWalkable(originX, originY)) return { tileX: originX, tileY: originY };

        let best = null;
        let bestDistance = Infinity;
        const radiusLimit = Math.max(1, Math.floor(maxRadius));
        for (let radius = 1; radius <= radiusLimit; radius++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const nx = originX + dx;
                    const ny = originY + dy;
                    if (!this.isWalkable(nx, ny)) continue;
                    const distance = dx * dx + dy * dy;
                    if (distance < bestDistance) {
                        best = { tileX: nx, tileY: ny };
                        bestDistance = distance;
                    }
                }
            }
            if (best) return best;
        }

        return null;
    }

    _cacheResult(key, value) {
        if (this._pathCache.size >= PATH_CACHE_LIMIT) {
            this._pathCache.delete(this._pathCache.keys().next().value);
        }
        // The cache owns both the array and its waypoint objects. AgentSprite
        // may stitch or trim the returned route, so sharing either would let a
        // caller corrupt every later lookup for the same endpoints.
        this._pathCache.set(key, this._copyPath(value));
    }

    _copyPath(path) {
        return Array.isArray(path)
            ? path.map(tile => ({ ...tile }))
            : [];
    }

    getDiagnostics() {
        const flow = this._flow;
        return {
            cacheEntries: this._pathCache.size,
            cacheLimit: PATH_CACHE_LIMIT,
            cacheHits: this._cacheHits,
            cacheMisses: this._cacheMisses,
            sinkCount: SINK_COUNT,
            memoryBytes: this.getMemoryFootprint(),
            flow: {
                lookups: flow.lookups,
                avgLookupMs: flow.lookups ? flow.lookupMs / flow.lookups : 0,
                maxLookupMs: flow.maxLookupMs,
                avgTraceLookupMs: flow.traceHits ? flow.traceMs / flow.traceHits : 0,
                avgGuidedLookupMs: flow.guidedSearches ? flow.guidedMs / flow.guidedSearches : 0,
                avgAdhocLookupMs: flow.adhocSearches ? flow.adhocMs / flow.adhocSearches : 0,
                sinkLookups: flow.sinkLookups,
                traceHits: flow.traceHits,
                guidedSearches: flow.guidedSearches,
                adhocSearches: flow.adhocSearches,
                unweightedSearches: flow.unweightedSearches,
                staleFieldFallbacks: flow.staleFieldFallbacks,
                // Share of weighted lookups served by a fresh sink field, and
                // of those answered by the O(8) trace alone.
                sinkHitRate: flow.lookups ? flow.sinkLookups / flow.lookups : 0,
                traceHitRate: flow.sinkLookups ? flow.traceHits / flow.sinkLookups : 0,
                rebuilds: flow.rebuilds,
                rebuildMs: flow.rebuildMs,
                avgRebuildMs: flow.rebuilds ? flow.rebuildMs / flow.rebuilds : 0,
                lastRebuildMs: flow.lastRebuildMs,
                maxRebuildMs: flow.maxRebuildMs,
                deferredRebuilds: flow.deferredRebuilds,
                crowdIngests: flow.crowdIngests,
                crowdChanges: flow.crowdChanges,
                staticLoads: flow.staticLoads,
                crowdFingerprint: (this._standingHash ^ mix32(this._congestionHash)) >>> 0,
            },
        };
    }

    // Bytes held by the routing grid's typed arrays.
    getMemoryFootprint() {
        let bytes = 0;
        for (const array of [
            this.staticFlags, this.bridgeIdGrid, this.baseCostLayer, this.tierGrid, this.stepMask,
            this.standingGrid, this.congestionRaw, this.congestionBlur,
            this.sinkIntegration, this.sinkOf,
            this.heapIdx, this.heapPos, this.heapCost, this.visited, this._targets,
            this._sinkSeedVersion, this._sinkBuilt, this._sinkStaticKey, this._sinkCrowdKey,
            this._sinkBuiltSeedVersion, this._sinkBuiltTopology, this._sinkBuiltWindow, this._roleHash,
            ...this._sinkSeeds,
        ]) bytes += array.byteLength;
        return bytes;
    }

    // A new (or in-place edited) walk grid starts a fresh routing context, as
    // at construction: the walk bits and step mask rebuild, the authored
    // route layers and crowd inputs reload from their collections on the
    // next lookup, and every cached route and sink field is dropped. Terrace
    // tiers and stairs (`setTierGrid`) and the sink seeds carry over.
    setGrid(grid) {
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
        this._pathCache.clear();
        this._bridgeMapCodes.clear();
        this._bridgeMapSeq = 0;
        this._cacheHits = 0;
        this._cacheMisses = 0;
        this._resetRouteLayers();
        this._rebuildTopology();
    }

    _resetRouteLayers() {
        const flags = this.staticFlags;
        for (let index = 0; index < CELLS; index++) flags[index] &= FLAG_STAIR;
        this.bridgeIdGrid.fill(0);
        this._roleHash.fill(0);
        this._baseCostStaticKey = -1;
        this._standingRef = null;
        this._standingVersion = '';
        this._congestionRef = null;
        this._congestionVersion = '';
        this._primary = null;
        this._sinkBuilt.fill(0);
    }

    // A caller may write into the grid array it handed over without calling
    // setGrid. Every routing lookup (findPath, sinkCostAt,
    // sampleFlowDirection) first compares that array with the walk bits it
    // was built from and resyncs on any difference, so a tile blocked in
    // place is never routed through. A 0/1 byte grid compares as 400 32-bit
    // words against the walk bit of staticFlags (no copy kept); any other
    // array compares tile by tile.
    _snapshotGrid() {
        const grid = this.grid;
        this._syncedGrid = grid;
        this._surfaceGridSnapshot = this.surfaceRegistry ? Uint8Array.from(grid, v => Number(v === 1)) : null;
        this._surfaceWords = this._surfaceGridSnapshot && new Uint32Array(this._surfaceGridSnapshot.buffer);
        this._gridWords = null;
        if (!(grid instanceof Uint8Array) || grid.length !== CELLS || CELLS % 4 !== 0 || grid.byteOffset % 4 !== 0) return;
        for (let index = 0; index < CELLS; index++) if (grid[index] > 1) return;
        this._gridWords = new Uint32Array(grid.buffer, grid.byteOffset, CELLS >> 2);
    }

    _syncGrid() {
        const grid = this.grid;
        if (!grid) return false;
        if (grid !== this._syncedGrid) {
            this.setGrid(grid);
            return true;
        }
        const words = this._gridWords;
        if (words) {
            const flagWords = this._surfaceWords || this._flagWords;
            for (let index = 0; index < words.length; index++) {
                if (words[index] !== (flagWords[index] & WALK_WORD)) {
                    this.setGrid(grid);
                    return true;
                }
            }
            return false;
        }
        const flags = this.staticFlags;
        for (let index = 0; index < CELLS; index++) {
            if ((grid[index] === 1) !== (this._surfaceGridSnapshot ? this._surfaceGridSnapshot[index] === 1 : (flags[index] & FLAG_WALK) !== 0)) {
                this.setGrid(grid);
                return true;
            }
        }
        return false;
    }

    // Wave 6 E2 — terrace tiers (0..2) and their stair tiles. Every tier is 0
    // until terraces land, which keeps today's step rule.
    setTierGrid(tiers, stairTiles = null) {
        for (let index = 0; index < CELLS; index++) {
            this.tierGrid[index] = Math.max(0, Math.min(255, Math.round(Number(tiers?.[index]) || 0)));
            this.staticFlags[index] &= ~FLAG_STAIR;
        }
        for (const tile of stairTiles || []) {
            const index = this._tileIndex(tile?.tileX, tile?.tileY);
            if (index >= 0) this.staticFlags[index] |= FLAG_STAIR;
        }
        this._pathCache.clear();
        this._rebuildTopology();
    }

    // Reads the walk bit the step mask was built from, so a walkability
    // answer and a route always agree on the same grid snapshot.
    isWalkable(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;
        return (this.staticFlags[tileY * MAP_SIZE + tileX] & FLAG_WALK) !== 0;
    }

    _tileIndex(tileX, tileY) {
        const x = Math.round(Number(tileX));
        const y = Math.round(Number(tileY));
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= MAP_N || y < 0 || y >= MAP_N) return -1;
        return y * MAP_N + x;
    }

    // VB-15 — keeps only the walk nodes a body can reach from `from` (the
    // village gate) under findPath's own step rule, so a sealed pocket (the
    // shore tile under the pier lantern, the north shore behind the farm)
    // leaves the grid: no spawn, snap or nearest-walkable fallback lands
    // where every route fails. Closes the nodes in place and returns their
    // count.
    keepReachableFrom(from) {
        const start = from ? this.nearestWalkable(from.tileX, from.tileY, 8) : null;
        if (!start) return 0;
        const reached = this.visited;
        const queue = this.heapIdx;
        reached.fill(0);
        let tail = 0;
        const seed = this._nodeFor(start.tileY * MAP_N + start.tileX, from.surfaceId, from);
        if (seed < 0) return 0;
        queue[tail++] = seed;
        reached[queue[0]] = 1;
        for (let head = 0; head < tail; head++) {
            const current = queue[head];
            for (const edge of this._edges(current)) {
                const next = this._neighbor(current, edge);
                if (reached[next]) continue;
                reached[next] = 1;
                queue[tail++] = next;
            }
        }
        let closed = 0;
        for (let index = 0; index < CELLS; index++) {
            if (this.grid[index] === 1 && !reached[index] && !this._layers.get(index)?.some(n => reached[n])) {
                this.grid[index] = 0;
                closed++;
            }
        }
        if (closed) this.setGrid(this.grid);
        return closed;
    }

    // Returns an array of {tileX, tileY} waypoints from `from` exclusive to `to` inclusive.
    // Empty array if unreachable. If straight-line works (no obstacles between centers
    // sampled at tile granularity), returns the single waypoint [to].
    findPath(from, to, bridgeTiles, options = null) {
        this._syncGrid();
        let fx = Math.round(from.tileX);
        let fy = Math.round(from.tileY);
        const pathOptions = this._normalizePathOptions(options, bridgeTiles);

        // Guard: if the start tile is unwalkable (e.g., agent currently
        // straddling a shore tile due to floating-point drift), search the
        // 8 cardinal and diagonal neighbors for a walkable foothold and recurse from
        // there. Prevents agents from getting permanently stuck.
        if (!this.isWalkable(fx, fy)) {
            if (from.surfaceId != null) return [];
            const nearest = this.nearestWalkable(fx, fy, 8);
            if (nearest) {
                const sub = this.findPath(nearest, to, bridgeTiles, options);
                if (sub.length > 0) return [this._waypoint(this._nodeFor(nearest.tileY * MAP_N + nearest.tileX)), ...sub];
            }
            console.warn('[Pathfinder] stuck: no walkable tile near', fx, fy);
            return [];
        }

        const tx = Math.round(to.tileX);
        const ty = Math.round(to.tileY);
        if (!this._collectTargets(tx, ty)) return [];
        const startIdx = this._nodeFor(fy * MAP_N + fx, from.surfaceId, from);
        if (startIdx < 0 || (to.surfaceId != null && !this.isWalkable(tx, ty))) return [];
        if (this.isWalkable(tx, ty)) {
            const end = this._nodeFor(ty * MAP_N + tx, to.surfaceId, to);
            if (end < 0) return [];
            this._targets[0] = end;
        }
        const startTile = this._tileFor(startIdx);
        fx = startTile % MAP_N;
        fy = Math.floor(startTile / MAP_N);
        if (this._nodeCount > CELLS && this._isTarget(startIdx)) return [this._waypoint(startIdx)];

        if ((pathOptions.weighted || this._nodeCount > CELLS) && !this._isTarget(startIdx)) {
            const t0 = this._perfNow();
            const weightedResult = this._findWeightedPath(startIdx, bridgeTiles, pathOptions);
            const ms = this._perfNow() - t0;
            const flow = this._flow;
            flow.lookups++;
            flow.lookupMs += ms;
            if (ms > flow.maxLookupMs) flow.maxLookupMs = ms;
            if (this._lastLookupKind === 1) flow.traceMs += ms;
            else if (this._lastLookupKind === 2) flow.guidedMs += ms;
            else flow.adhocMs += ms;
            if (weightedResult.length > 0 || this._nodeCount > CELLS) return weightedResult;
        }

        const targetTile = this._targetCount === 1 ? this._tileFor(this._targets[0]) : null;
        return this._findUnweightedPath(fx, fy, targetTile == null ? tx : targetTile % MAP_N,
            targetTile == null ? ty : Math.floor(targetTile / MAP_N), bridgeTiles, pathOptions.routeVersion);
    }

    // Target candidates into `_targets`: the tile itself when walkable, else
    // its walkable 8-neighbours (a blocked target never resolves further).
    _collectTargets(tileX, tileY) {
        let count = 0;
        if (this.isWalkable(tileX, tileY)) {
            this._targets[count++] = tileY * MAP_N + tileX;
        } else {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = tileX + dx;
                    const ny = tileY + dy;
                    if (this.isWalkable(nx, ny)) this._targets[count++] = ny * MAP_N + nx;
                }
            }
        }
        this._targetCount = count;
        return count;
    }

    _isTarget(index) {
        const targets = this._targets;
        for (let i = 0; i < this._targetCount; i++) if (targets[i] === index) return true;
        return false;
    }

    // Unweighted trips: the straight tile line when every step is a legal
    // stepMask edge, else BFS. Cached under a numeric key (start tile, target
    // tile, bridge-map content).
    _findUnweightedPath(fx, fy, tx, ty, bridgeTiles, routeVersion = '') {
        const startIdx = fy * MAP_N + fx;
        const cacheKey = this._unweightedCacheKey(startIdx, tx, ty, bridgeTiles, routeVersion);
        if (cacheKey >= 0) {
            const cached = this._pathCache.get(cacheKey);
            if (cached) {
                this._cacheHits++;
                return this._copyPath(cached);
            }
        }
        this._cacheMisses++;
        this._flow.unweightedSearches++;

        // Fast path: if a tile-step line from `from` to `to` never crosses a blocked tile,
        // skip BFS entirely.
        for (let i = 0; i < this._targetCount; i++) {
            const target = this._targets[i];
            const targetX = target % MAP_N;
            const targetY = (target - targetX) / MAP_N;
            const lineTiles = this._lineWalkableTiles(fx, fy, targetX, targetY);
            if (lineTiles) {
                const fastTiles = lineTiles.slice(1);
                const crossesBridge = fastTiles.some((t) => (this.surfaceRegistry && t.surfaceId !== this._surfaceIds[startIdx]) || bridgeTiles?.has(`${t.tileX},${t.tileY}`));
                const fastResult = crossesBridge
                    ? this._lookahead(this._simplify(fastTiles, bridgeTiles), bridgeTiles)
                    : [this._waypoint(target)];
                if (cacheKey >= 0) this._cacheResult(cacheKey, fastResult);
                return fastResult;
            }
        }

        // BFS — typed queue (heapIdx), parent links (heapPos), no strings.
        const visited = this.visited;
        const queue = this.heapIdx;
        const parent = this.heapPos;
        const mask = this.stepMask;
        visited.fill(0);
        parent.fill(-1);
        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;
        visited[startIdx] = 1;
        let foundIdx = -1;
        while (head < tail) {
            const cur = queue[head++];
            if (this._isTarget(cur)) {
                foundIdx = cur;
                break;
            }
            const bits = mask[cur];
            for (let dir = 0; dir < DIR_COUNT; dir++) {
                // Corner-cut guard: diagonal step requires both axis-aligned neighbors walkable.
                if (!(bits & (1 << dir))) continue;
                const idx = cur + DIR_OFFSET[dir];
                if (visited[idx]) continue;
                visited[idx] = 1;
                parent[idx] = cur;
                queue[tail++] = idx;
            }
        }
        if (foundIdx === -1) {
            const first = this._targets[0];
            console.warn('[Pathfinder] no path from', fx, fy, 'to nearest of', this._targetCount, 'candidates; closest:', JSON.stringify({ tileX: first % MAP_N, tileY: Math.floor(first / MAP_N) }));
            return [];
        }

        // Reconstruct path from to -> from.
        const tiles = [];
        let cur = foundIdx;
        while (cur !== -1 && cur !== startIdx) {
            tiles.push(this._waypoint(cur));
            cur = parent[cur];
        }
        tiles.reverse();
        const result = this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
        if (cacheKey >= 0) this._cacheResult(cacheKey, result);
        return result;
    }

    // The bridge map enters by content (deck ids and kinds included), never
    // by object identity, so a map edited in place keys a fresh route.
    _unweightedCacheKey(startIdx, tx, ty, bridgeTiles, routeVersion) {
        if (tx < -512 || tx > 511 || ty < -512 || ty > 511) return -1;
        let mapCode = 0;
        if (bridgeTiles && typeof bridgeTiles === 'object' && typeof bridgeTiles.keys !== 'function') return -1;
        if (bridgeTiles?.size) {
            const hash = this._collectionHash(bridgeTiles, true, routeVersion);
            mapCode = this._bridgeMapCodes.get(hash);
            if (!mapCode) {
                if (this._bridgeMapSeq >= BRIDGE_MAP_CODE_LIMIT) {
                    this._bridgeMapCodes.clear();
                    this._bridgeMapSeq = 0;
                    this._pathCache.clear();
                }
                mapCode = ++this._bridgeMapSeq;
                this._bridgeMapCodes.set(hash, mapCode);
            }
        }
        return ((mapCode * CELLS + startIdx) * 1024 + (ty + 512)) * 1024 + (tx + 512);
    }

    // Weighted trips. A target that is a sink seed traces that sink's flow
    // field (O(8) per step); a trace that settles on another seed of the
    // same sink re-runs as an A* guided by the field (an exact, consistent
    // heuristic). Any other target — or a sink whose crowd field is stale
    // inside its rebuild window — runs a numeric octile A*. Returns [] when
    // no weighted route exists (findPath then takes the unweighted search).
    _findWeightedPath(startIdx, bridgeTiles, pathOptions) {
        const staticMask = this._syncStatic(bridgeTiles, pathOptions);
        const crowdMask = this._syncCrowd(pathOptions);
        const staticKey = this._contextStaticKey(staticMask);
        const crowdKey = this._contextCrowdKey(crowdMask);
        const primary = this._notePrimary(staticMask, crowdMask, staticKey, crowdKey);
        const policy = this._resolvePolicy(this._policy, pathOptions.weights, pathOptions.preferredBridgeId);
        const flow = this._flow;

        let tiles = null;
        this._lastLookupKind = 3;
        if (primary && this._targetCount === 1) {
            const target = this._targets[0];
            const sink = this.sinkOf[target] - 1;
            if (sink >= 0) {
                if (this._ensureSink(sink, staticMask, crowdMask, staticKey, crowdKey)) {
                    flow.sinkLookups++;
                    tiles = this._traceToTarget(sink, startIdx, target, policy, staticMask, crowdMask);
                    if (tiles) {
                        flow.traceHits++;
                        this._lastLookupKind = 1;
                    } else {
                        flow.guidedSearches++;
                        this._lastLookupKind = 2;
                        tiles = this._search(startIdx, policy, staticMask, crowdMask, HEUR_FIELD, sink);
                    }
                } else {
                    flow.staleFieldFallbacks++;
                }
            }
        }
        if (!tiles) {
            flow.adhocSearches++;
            this._lastLookupKind = 3;
            tiles = this._search(startIdx, policy, staticMask, crowdMask, HEUR_OCTILE, -1);
        }
        if (!tiles || tiles.length === 0) return [];
        return this._nodeCount > CELLS ? tiles : this._simplify(tiles, bridgeTiles);
    }

    // ---- Static route layers -------------------------------------------------

    // Folds the caller's authored collections into staticFlags. Each layer
    // keeps the content hash it was loaded from, so per-sprite copies of the
    // same plaza set, or the same bridge map passed twice, never reload,
    // while a collection edited in place (same object, same size, other
    // tiles) always does. `routeVersion`, when a caller supplies one, is the
    // collections' revision and lets an unchanged (object, revision) pair
    // skip re-hashing.
    _syncStatic(bridgeTiles, pathOptions) {
        const version = pathOptions.routeVersion;
        return this._syncStaticRole(0, bridgeTiles, pathOptions.bridgeTiles, version)
            | this._syncStaticRole(1, pathOptions.dockTiles, null, version)
            | this._syncStaticRole(2, pathOptions.plazaTiles, null, version)
            | this._syncStaticRole(3, pathOptions.roadTiles, pathOptions.preferredTiles, version)
            | this._syncStaticRole(4, pathOptions.laneTiles, null, version)
            | this._syncStaticRole(5, pathOptions.avoidTiles, null, version);
    }

    // One layer from up to two collections (a bridge map passed as argument
    // and option, roads and preferred tiles); returns its flag when present.
    _syncStaticRole(role, first, second, version) {
        const a = first?.size ? first : null;
        const b = second?.size && second !== a ? second : null;
        if (!a && !b) return 0;
        const withInfo = role === 0;
        const ha = a ? this._collectionHash(a, withInfo, version) : 0;
        const hb = b ? this._collectionHash(b, withInfo, version) : 0;
        const hash = !a ? hb : (!b || ha === hb ? ha : (combineKey(ha ^ hb, Math.min(ha, hb)) || 1));
        if (this._roleHash[role] !== hash) this._loadStaticRole(role, a, b, hash);
        return STATIC_ROLE_FLAGS[role];
    }

    // Order-independent content hash of a tile collection (its bridge ids
    // and kinds too, `withInfo`). Object identity and size alone never vouch
    // for content: the memo keeps the key sequence (and bridge info) it was
    // hashed from, and a later call reuses its hash only after an exact
    // compare against that snapshot, or, when the caller supplies a
    // revision, for the same object at the same revision.
    _collectionHash(collection, withInfo, version = '') {
        const size = collection.size;
        const isMap = withInfo && collection instanceof Map;
        const memo = this._collectionHashes.get(collection);
        if (memo && memo.size === size && memo.isMap === isMap) {
            if (version && memo.version === version) return memo.hash;
            if (sameCollectionContent(collection, memo)) {
                memo.version = version;
                return memo.hash;
            }
        }
        const keys = new Array(size);
        const info = isMap ? new Array(size * 2) : null;
        let sum = 0;
        let xor = 0;
        let slot = 0;
        for (const key of collection.keys()) {
            const index = tileKeyIndex(key);
            let entry = index >= 0 ? mix32(index + 1) : mix32(fnv1aString(key) | 0x80000000);
            if (isMap) {
                const value = collection.get(key);
                const bridgeId = value?.bridgeId;
                const kind = value?.kind;
                if (bridgeId) entry = mix32(entry ^ fnv1aString(bridgeId));
                if (kind) entry = mix32(entry ^ fnv1aString(kind, 0x9e3779b9));
                info[slot * 2] = bridgeId;
                info[slot * 2 + 1] = kind;
            }
            keys[slot++] = key;
            sum = (sum + entry) >>> 0;
            xor = (xor ^ mix32(entry + 0x7f4a7c15)) >>> 0;
        }
        const hash = combineKey(combineKey(sum, xor), size) || 1;
        this._collectionHashes.set(collection, { version, size, isMap, keys, info, hash });
        return hash;
    }

    _loadStaticRole(role, first, second, hash) {
        const flag = STATIC_ROLE_FLAGS[role];
        const flags = this.staticFlags;
        for (let index = 0; index < CELLS; index++) flags[index] &= ~flag;
        if (role === 0) this.bridgeIdGrid.fill(0);
        for (const collection of [first, second]) {
            if (!collection) continue;
            const isMap = collection instanceof Map;
            for (const key of collection.keys()) {
                const index = tileKeyIndex(key);
                if (index < 0) continue;
                flags[index] |= flag;
                if (role === 0 && isMap && !this.bridgeIdGrid[index]) {
                    const bridgeId = collection.get(key)?.bridgeId;
                    if (bridgeId) this.bridgeIdGrid[index] = this._bridgeCode(bridgeId);
                }
            }
        }
        if (role === 0) {
            const ids = [...this._bridgeCodes.keys()].sort();
            const riverIds = ids.filter((id) => id.includes('river'));
            this._bridgeIds = riverIds.length >= 2 ? riverIds : ids;
        }
        this._roleHash[role] = hash;
        this._baseCostStaticKey = -1;
        this._flow.staticLoads++;
    }

    _bridgeCode(bridgeId) {
        let code = this._bridgeCodes.get(bridgeId);
        if (!code) {
            if (this._bridgeCodes.size >= 254) return 255;
            code = this._bridgeCodes.size + 1;
            this._bridgeCodes.set(bridgeId, code);
        }
        return code;
    }

    _contextStaticKey(staticMask) {
        let key = combineKey(0x811c9dc5, staticMask);
        for (let role = 0; role < STATIC_ROLE_FLAGS.length; role++) {
            if (staticMask & STATIC_ROLE_FLAGS[role]) key = combineKey(key, this._roleHash[role]);
        }
        return key;
    }

    _contextCrowdKey(crowdMask) {
        let key = combineKey(0x01000193, crowdMask);
        if (crowdMask & CROWD_STANDING) key = combineKey(key, this._standingHash);
        if (crowdMask & CROWD_CONGESTION) key = combineKey(key, this._congestionHash);
        return key;
    }

    // Sink fields serve one routing context: the latest long trip's (roads,
    // lanes, plazas or docks) once any arrives, else the latest weighted
    // trip's. Local trips over a bare grid never displace it; they take A*.
    _notePrimary(staticMask, crowdMask, staticKey, crowdKey) {
        const rich = (staticMask & RICH_ROUTE_FLAGS) !== 0;
        const primary = this._primary;
        if (!primary || rich || !primary.rich) {
            if (!primary) {
                this._primary = { rich, staticMask, crowdMask, staticKey, crowdKey };
            } else {
                primary.rich = rich || primary.rich;
                primary.staticMask = staticMask;
                primary.crowdMask = crowdMask;
                primary.staticKey = staticKey;
                primary.crowdKey = crowdKey;
            }
            return true;
        }
        return primary.staticKey === staticKey && primary.crowdKey === crowdKey
            && primary.staticMask === staticMask && primary.crowdMask === crowdMask;
    }

    // ---- Dynamic crowd fields ------------------------------------------------

    // A supplied `standingVersion` / `congestionVersion` (VisitTileAllocator's
    // snapshot fingerprints) is authoritative: the same object at the same
    // version is not re-read, and a bumped version re-reads it even when the
    // caller mutated that object in place. An unversioned collection may have
    // changed in place at any time, so it is re-read on every lookup; the
    // occupancy fingerprint still keeps unchanged content from rebuilding.
    _syncCrowd(pathOptions) {
        let mask = 0;
        const standing = pathOptions.standingTiles;
        if (standing?.size) {
            mask |= CROWD_STANDING;
            const version = pathOptions.standingVersion;
            if (!version || standing !== this._standingRef || version !== this._standingVersion) {
                this._standingRef = standing;
                this._standingVersion = version;
                this._loadStanding(standing);
            }
        }
        const congestion = pathOptions.congestionTiles;
        if (congestion?.size) {
            mask |= CROWD_CONGESTION;
            const version = pathOptions.congestionVersion;
            if (!version || congestion !== this._congestionRef || version !== this._congestionVersion) {
                this._congestionRef = congestion;
                this._congestionVersion = version;
                this._loadCongestion(congestion);
            }
        }
        return mask;
    }

    _loadStanding(standing) {
        const grid = this.standingGrid;
        grid.fill(0);
        for (const key of standing.keys()) {
            const index = tileKeyIndex(key);
            if (index >= 0) grid[index] = 1;
        }
        this._flow.crowdIngests++;
        const hash = fnv1a32(grid);
        if (hash !== this._standingHash) {
            this._standingHash = hash;
            this._flow.crowdChanges++;
        }
    }

    _loadCongestion(congestion) {
        const raw = this.congestionRaw;
        raw.fill(0);
        for (const [key, value] of congestion.entries()) {
            const index = tileKeyIndex(key);
            const count = Number(value);
            if (index < 0 || !Number.isFinite(count) || count <= 0) continue;
            raw[index] = Math.min(255, Math.max(1, Math.round(count)));
        }
        this._flow.crowdIngests++;
        const hash = fnv1a32(raw);
        if (hash === this._congestionHash) return;
        this._congestionHash = hash;
        this._flow.crowdChanges++;
        // Sparse splat of the Gaussian kernel around each crowded tile.
        const blur = this.congestionBlur;
        blur.fill(0);
        const size = CONGESTION_RADIUS * 2 + 1;
        for (let index = 0; index < CELLS; index++) {
            const count = raw[index];
            if (!count) continue;
            const x = index % MAP_N;
            const y = (index - x) / MAP_N;
            for (let dy = -CONGESTION_RADIUS; dy <= CONGESTION_RADIUS; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= MAP_N) continue;
                for (let dx = -CONGESTION_RADIUS; dx <= CONGESTION_RADIUS; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= MAP_N) continue;
                    blur[ny * MAP_N + nx] += count * CONGESTION_KERNEL[(dy + CONGESTION_RADIUS) * size + dx + CONGESTION_RADIUS];
                }
            }
        }
    }

    congestionCostAt(tileX, tileY) {
        const index = this._tileIndex(tileX, tileY);
        return index < 0 ? 0 : Math.min(TILE_WEIGHTS.congestionMax, this.congestionBlur[index] * TILE_WEIGHTS.congestionStep);
    }

    // ---- Personality policy and costs ---------------------------------------

    _resolvePolicy(out, weights, preferredBridgeId) {
        const w = weights || TILE_WEIGHTS;
        out.road = Number.isFinite(w.road) ? w.road : TILE_WEIGHTS.road;
        out.plaza = Number.isFinite(w.plaza) ? w.plaza : TILE_WEIGHTS.plaza;
        out.lane = Number.isFinite(w.lane) ? w.lane : TILE_WEIGHTS.lane;
        out.prefActive = !!preferredBridgeId;
        out.prefCode = preferredBridgeId ? (this._bridgeCodes.get(preferredBridgeId) || -1) : 0;
        const bridgeFactor = out.prefActive ? 0.92 : 1;
        // κ scales a neutral sink field into a consistent lower bound for
        // this policy's costs; minWeight does the same for octile distance.
        out.kappa = Math.max(0, Math.min(1,
            out.road / TILE_WEIGHTS.road,
            out.plaza / TILE_WEIGHTS.plaza,
            out.lane / TILE_WEIGHTS.lane,
            bridgeFactor));
        out.minWeight = Math.max(0, Math.min(1, TILE_WEIGHTS.bridge * bridgeFactor, TILE_WEIGHTS.dock, out.road, out.plaza, out.lane));
        return out;
    }

    // Personality for sampleFlowDirection: a ROUTE_PERSONALITIES bucket (its
    // alternate bridge picked from the loaded crossings, as AgentSprite does),
    // a weights object, or null for the neutral field's own weights.
    _personalityPolicy(personality) {
        if (personality == null) return NEUTRAL_POLICY;
        if (typeof personality === 'number') {
            const bucket = Math.max(0, Math.min(ROUTE_PERSONALITIES.length - 1, Math.floor(personality) || 0));
            const weights = ROUTE_PERSONALITIES[bucket];
            const ids = this._bridgeIds;
            const preferred = ids.length ? ids[weights.bridgePreference % ids.length] : '';
            return this._resolvePolicy(this._samplePolicy, weights, preferred);
        }
        const weights = personality.weights || personality;
        return this._resolvePolicy(this._samplePolicy, weights, personality.preferredBridgeId || '');
    }

    _tileWeight(index, staticMask, policy) {
        const flags = this.staticFlags[index] & staticMask;
        let weight = 1;
        if (flags & FLAG_BRIDGE) {
            const code = this.bridgeIdGrid[index];
            weight = TILE_WEIGHTS.bridge * (policy.prefActive && code ? (code === policy.prefCode ? 0.92 : 1.08) : 1);
        } else if (flags & FLAG_DOCK) weight = TILE_WEIGHTS.dock;
        else if (flags & FLAG_PLAZA) weight = policy.plaza;
        else if (flags & FLAG_ROAD) weight = policy.road;
        if ((flags & FLAG_LANE) && !(flags & FLAG_PLAZA) && policy.lane < weight) weight = policy.lane;
        if (flags & FLAG_AVOID) weight += TILE_WEIGHTS.avoid;
        return weight;
    }

    // Cost of stepping from `from` (weight `fromWeight`) onto `to` along
    // `dir`: distance × the cheaper surface, a soft standing-body cost unless
    // `to` is a goal, and the blurred crowd cost of the tile entered.
    _stepCost(from, fromWeight, to, dir, staticMask, crowdMask, policy, goal) {
        const length = this._stepLength(from, to, dir);
        to = this._tileFor(to);
        const toWeight = this._tileWeight(to, staticMask, policy);
        let cost = length * (fromWeight < toWeight ? fromWeight : toWeight);
        if ((crowdMask & CROWD_STANDING) && !goal && this.standingGrid[to]) cost += TILE_WEIGHTS.standing;
        if (crowdMask & CROWD_CONGESTION) {
            const blur = this.congestionBlur[to];
            if (blur > 0) cost += length * Math.min(TILE_WEIGHTS.congestionMax, blur * TILE_WEIGHTS.congestionStep);
        }
        return cost;
    }

    _ensureBaseCost(staticMask, staticKey) {
        if (this._baseCostStaticKey === staticKey) return;
        const base = this.baseCostLayer;
        for (let index = 0; index < CELLS; index++) base[index] = this._tileWeight(index, staticMask, NEUTRAL_POLICY);
        this._baseCostStaticKey = staticKey;
    }

    // ---- Sink registry --------------------------------------------------------

    _seedIndices(tiles) {
        const seen = new Set();
        for (const tile of tiles || []) {
            const index = this._tileIndex(tile?.tileX ?? tile?.x, tile?.tileY ?? tile?.y);
            const node = this._nodeFor(index, tile?.surfaceId, tile);
            if (node >= 0) seen.add(node);
        }
        return this.heapIdx.constructor.from([...seen].sort((a, b) => a - b));
    }

    // A tile in several sinks belongs to the smallest (the tightest field).
    _refreshSinkOf() {
        const owner = this.sinkOf;
        owner.fill(0);
        for (let sink = 0; sink < SINK_COUNT; sink++) {
            const seeds = this._sinkSeeds[sink];
            for (let i = 0; i < seeds.length; i++) {
                const current = owner[seeds[i]];
                if (!current || seeds.length < this._sinkSeeds[current - 1].length) owner[seeds[i]] = sink + 1;
            }
        }
    }

    _resolveSinkId(sink) {
        if (typeof sink === 'string') return SINK_IDS[sink] ?? -1;
        const id = Math.floor(Number(sink));
        return Number.isInteger(id) && id >= 0 && id < SINK_COUNT ? id : -1;
    }

    // Replaces a sink's seed tiles (a matched destination set). Returns true
    // when the content changed; the field then rebuilds on its next use.
    setSinkTiles(sink, tiles) {
        const id = this._resolveSinkId(sink);
        if (id < 0) return false;
        const seeds = this._seedIndices(tiles);
        const current = this._sinkSeeds[id];
        if (current.length === seeds.length && current.every((value, i) => value === seeds[i])) return false;
        this._sinkSeeds[id] = seeds;
        this._sinkSeedVersion[id] = (this._sinkSeedVersion[id] + 1) >>> 0;
        this._refreshSinkOf();
        return true;
    }

    getSinkTiles(sink) {
        const id = this._resolveSinkId(sink);
        if (id < 0) return [];
        return Array.from(this._sinkSeeds[id], index => this._waypoint(index));
    }

    // The sink a tile seeds (the smallest when several do), else -1.
    sinkIdAt(tileX, tileY, surfaceId) {
        const index = this._nodeFor(this._tileIndex(tileX, tileY), surfaceId);
        return index < 0 ? -1 : this.sinkOf[index] - 1;
    }

    // Integrated walk cost from a tile to the sink's nearest seed under the
    // current routing context (canal- and crowd-aware); Infinity when the
    // sink is unknown or unreachable from the tile.
    sinkCostAt(sink, tileX, tileY, surfaceId) {
        this._syncGrid();
        const id = this._resolveSinkId(sink);
        const index = this._nodeFor(this._tileIndex(tileX, tileY), surfaceId);
        if (id < 0 || index < 0) return Infinity;
        if (!this._ensurePrimarySink(id) && !this._sinkBuilt[id]) return Infinity;
        return this._sinkViews[id][index];
    }

    // O(8) personality lookup: the DIRS index of the best next step toward
    // the sink from (tileX, tileY), or -1 at a seed or with no route. It scores
    // each legal, strictly-descending neighbour by its integrated cost plus
    // this personality's step cost; ties keep the lowest direction index.
    sampleFlowDirection(sink, tileX, tileY, personality = null, surfaceId) {
        this._syncGrid();
        const id = this._resolveSinkId(sink);
        const index = this._nodeFor(this._tileIndex(tileX, tileY), surfaceId);
        if (id < 0 || index < 0) return -1;
        if (!this._ensurePrimarySink(id) && !this._sinkBuilt[id]) return -1;
        const primary = this._primary;
        const edge = this._flowDirection(id, index, this._personalityPolicy(personality), primary?.staticMask || 0, primary?.crowdMask || 0);
        return edge < 0 ? -1 : edge & 7;
    }

    _ensurePrimarySink(id) {
        const primary = this._primary;
        const staticMask = primary?.staticMask || 0;
        const crowdMask = primary?.crowdMask || 0;
        return this._ensureSink(id, staticMask, crowdMask, this._contextStaticKey(staticMask), this._contextCrowdKey(crowdMask));
    }

    // Fresh field → true. A structural change (walk grid, seeds, route
    // layers) rebuilds at once; a crowd change rebuilds a sink at most once
    // per FLOW_REBUILD_WINDOW_MS window (aligned like the allocator's
    // congestion buckets; callers take A* meanwhile), and an unchanged
    // occupancy fingerprint never rebuilds.
    _ensureSink(sink, staticMask, crowdMask, staticKey, crowdKey) {
        const structural = !this._sinkBuilt[sink]
            || this._sinkStaticKey[sink] !== staticKey
            || this._sinkBuiltSeedVersion[sink] !== this._sinkSeedVersion[sink]
            || this._sinkBuiltTopology[sink] !== this._topologyVersion;
        if (!structural && this._sinkCrowdKey[sink] === crowdKey) return true;
        const window = Math.floor(Number(this._clock()) / FLOW_REBUILD_WINDOW_MS);
        if (!structural && window === this._sinkBuiltWindow[sink]) {
            this._flow.deferredRebuilds++;
            return false;
        }
        this._rebuildSink(sink, staticMask, crowdMask, staticKey, crowdKey, window);
        return true;
    }

    // Backward multi-source Dijkstra from every walkable seed (cost 0) over
    // the neutral weights, the standing cost and the congestion field.
    _rebuildSink(sink, staticMask, crowdMask, staticKey, crowdKey, window) {
        const t0 = this._perfNow();
        this._ensureBaseCost(staticMask, staticKey);
        const field = this._sinkViews[sink];
        const base = this.baseCostLayer;
        const flags = this.staticFlags;
        const visited = this.visited;
        const standing = (crowdMask & CROWD_STANDING) ? this.standingGrid : null;
        const blur = (crowdMask & CROWD_CONGESTION) ? this.congestionBlur : null;
        field.fill(Infinity);
        visited.fill(0);
        this.heapPos.fill(-1);
        this._heapSize = 0;
        const seeds = this._sinkSeeds[sink];
        for (let i = 0; i < seeds.length; i++) {
            const seed = seeds[i];
            if (!(flags[this._tileFor(seed)] & FLAG_WALK) || field[seed] === 0) continue;
            field[seed] = 0;
            this._heapPush(field, seed);
        }
        while (this._heapSize > 0) {
            const v = this._heapPop(field);
            visited[v] = 1;
            const tile = this._tileFor(v);
            const costV = field[v];
            const weightV = base[tile];
            // Entering v: a standing body there costs unless v is a seed.
            const standingCost = standing && costV !== 0 && standing[tile] ? TILE_WEIGHTS.standing : 0;
            const crowd = blur && blur[tile] > 0 ? Math.min(TILE_WEIGHTS.congestionMax, blur[tile] * TILE_WEIGHTS.congestionStep) : 0;
            for (const edge of this._edges(v, true)) {
                const dir = edge & 7;
                const u = this._neighbor(v, edge);
                if (visited[u]) continue;
                const length = this._stepLength(u, v, dir);
                const weightU = base[this._tileFor(u)];
                const next = costV + length * (weightU < weightV ? weightU : weightV) + standingCost + length * crowd;
                if (next < field[u]) {
                    field[u] = next;
                    if (this.heapPos[u] < 0) this._heapPush(field, u);
                    else this._heapDecrease(field, u);
                }
            }
        }
        this._sinkBuilt[sink] = 1;
        this._sinkStaticKey[sink] = staticKey;
        this._sinkCrowdKey[sink] = crowdKey;
        this._sinkBuiltSeedVersion[sink] = this._sinkSeedVersion[sink];
        this._sinkBuiltTopology[sink] = this._topologyVersion;
        this._sinkBuiltWindow[sink] = window;
        const ms = this._perfNow() - t0;
        const flow = this._flow;
        flow.rebuilds++;
        flow.rebuildMs += ms;
        flow.lastRebuildMs = ms;
        if (ms > flow.maxRebuildMs) flow.maxRebuildMs = ms;
    }

    _flowDirection(sink, index, policy, staticMask, crowdMask) {
        const field = this._sinkViews[sink];
        const here = field[index];
        if (!(here > 0) || here === Infinity) return -1;
        const fromWeight = this._tileWeight(this._tileFor(index), staticMask, policy);
        let best = -1;
        let bestScore = Infinity;
        for (const edge of this._edges(index)) {
            const dir = edge & 7;
            const next = this._neighbor(index, edge);
            const remaining = field[next];
            if (!(remaining < here)) continue;
            const score = remaining + this._stepCost(index, fromWeight, next, dir, staticMask, crowdMask, policy, remaining === 0);
            if (score < bestScore) {
                bestScore = score;
                best = edge;
            }
        }
        return best;
    }

    // Follows the flow field from start; tiles (start exclusive, target
    // inclusive) when it lands on `target`, else null (another seed, a dead
    // end or the step cap).
    _traceToTarget(sink, startIdx, target, policy, staticMask, crowdMask) {
        const field = this._sinkViews[sink];
        if (!(field[startIdx] < Infinity)) return null;
        const scratch = this.heapIdx;
        let cur = startIdx;
        let steps = 0;
        while (cur !== target) {
            if (steps >= FLOW_TRACE_STEP_LIMIT || field[cur] === 0) return null;
            const dir = this._flowDirection(sink, cur, policy, staticMask, crowdMask);
            if (dir < 0) return null;
            cur = this._neighbor(cur, dir);
            scratch[steps++] = cur;
        }
        const tiles = new Array(steps);
        for (let i = 0; i < steps; i++) {
            const index = scratch[i];
            tiles[i] = this._waypoint(index);
        }
        return tiles;
    }

    // ---- A* ------------------------------------------------------------------

    // Both bounds are consistent, so their max is: κ × the sink field (exact
    // up to the personality's ±8%) steers the long haul across canals, and
    // octile distance to the goal itself sharpens the last few tiles among a
    // sink's other seeds.
    _heuristic(index, mode, policy, sink) {
        const octile = this._octileToTargets(index, policy);
        if (mode === HEUR_FIELD) {
            const remaining = this._sinkViews[sink][index];
            if (remaining === Infinity) return Infinity;
            const field = policy.kappa * remaining;
            return field > octile ? field : octile;
        }
        return octile;
    }

    _octileToTargets(index, policy) {
        index = this._tileFor(index);
        const x = index % MAP_N;
        const y = (index - x) / MAP_N;
        let best = Infinity;
        for (let i = 0; i < this._targetCount; i++) {
            const target = this._tileFor(this._targets[i]);
            const tx = target % MAP_N;
            const dx = Math.abs(tx - x);
            const dy = Math.abs((target - tx) / MAP_N - y);
            const octile = (dx > dy ? dx : dy) + OCTILE_DIAGONAL_EXTRA * (dx < dy ? dx : dy);
            if (octile < best) best = octile;
        }
        return policy.minWeight * best;
    }

    // A* toward `_targets` with a consistent heuristic (octile × the
    // cheapest surface, or κ × a sink field). heapCost holds f per tile, so
    // g = f − h. Returns tiles (start exclusive) or null.
    _search(startIdx, policy, staticMask, crowdMask, mode, sink) {
        const f = this.heapCost;
        const visited = this.visited;
        const heapPos = this.heapPos;
        f.fill(Infinity);
        visited.fill(0);
        heapPos.fill(-1);
        this._heapSize = 0;
        const startH = this._heuristic(startIdx, mode, policy, sink);
        if (startH === Infinity) return null;
        f[startIdx] = startH;
        this._heapPush(f, startIdx);
        let found = -1;
        while (this._heapSize > 0) {
            const cur = this._heapPop(f);
            visited[cur] = 1;
            if (this._isTarget(cur)) {
                found = cur;
                break;
            }
            const g = f[cur] - this._heuristic(cur, mode, policy, sink);
            const fromWeight = this._tileWeight(this._tileFor(cur), staticMask, policy);
            for (const edge of this._edges(cur)) {
                const dir = edge & 7;
                const next = this._neighbor(cur, edge);
                if (visited[next]) continue;
                const h = this._heuristic(next, mode, policy, sink);
                if (h === Infinity) continue;
                const score = g + this._stepCost(cur, fromWeight, next, dir, staticMask, crowdMask, policy, this._isTarget(next)) + h;
                if (score < f[next]) {
                    f[next] = score;
                    if (heapPos[next] < 0) this._heapPush(f, next);
                    else this._heapDecrease(f, next);
                }
            }
        }
        if (found < 0) return null;
        return this._reconstruct(found, startIdx, policy, staticMask, crowdMask, mode, sink);
    }

    // Walks back from the goal over closed tiles, each step to the
    // neighbour whose g + step cost explains this tile's g (strictly lower g,
    // so the walk always ends at the start).
    _reconstruct(found, startIdx, policy, staticMask, crowdMask, mode, sink) {
        const f = this.heapCost;
        const visited = this.visited;
        const scratch = this.heapIdx;
        let count = 0;
        let cur = found;
        let g = f[cur] - this._heuristic(cur, mode, policy, sink);
        while (cur !== startIdx) {
            scratch[count++] = cur;
            if (count > this._nodeCount) return null;
            let best = -1;
            let bestValue = Infinity;
            let bestG = Infinity;
            for (const edge of this._edges(cur, true)) {
                const dir = edge & 7;
                const prev = this._neighbor(cur, edge);
                if (!visited[prev]) continue;
                const prevG = f[prev] - this._heuristic(prev, mode, policy, sink);
                if (!(prevG < g)) continue;
                // The step prev → cur runs along the opposite direction.
                const value = prevG + this._stepCost(prev, this._tileWeight(this._tileFor(prev), staticMask, policy), cur, DIR_OPPOSITE[dir], staticMask, crowdMask, policy, this._isTarget(cur));
                if (value < bestValue) {
                    bestValue = value;
                    best = prev;
                    bestG = prevG;
                }
            }
            if (best < 0) return null;
            cur = best;
            g = bestG;
        }
        const tiles = new Array(count);
        for (let i = 0; i < count; i++) {
            const index = scratch[count - 1 - i];
            tiles[i] = this._waypoint(index);
        }
        return tiles;
    }

    // Indexed binary min-heap over tile indices keyed by `keys[tile]`.
    _heapPush(keys, tile) {
        let index = this._heapSize++;
        const heap = this.heapIdx;
        const pos = this.heapPos;
        const key = keys[tile];
        while (index > 0) {
            const parent = (index - 1) >> 1;
            const parentTile = heap[parent];
            if (keys[parentTile] <= key) break;
            heap[index] = parentTile;
            pos[parentTile] = index;
            index = parent;
        }
        heap[index] = tile;
        pos[tile] = index;
    }

    _heapDecrease(keys, tile) {
        const heap = this.heapIdx;
        const pos = this.heapPos;
        let index = pos[tile];
        const key = keys[tile];
        while (index > 0) {
            const parent = (index - 1) >> 1;
            const parentTile = heap[parent];
            if (keys[parentTile] <= key) break;
            heap[index] = parentTile;
            pos[parentTile] = index;
            index = parent;
        }
        heap[index] = tile;
        pos[tile] = index;
    }

    _heapPop(keys) {
        const heap = this.heapIdx;
        const pos = this.heapPos;
        const root = heap[0];
        pos[root] = -1;
        const size = --this._heapSize;
        if (size > 0) {
            const last = heap[size];
            const key = keys[last];
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                if (left >= size) break;
                const right = left + 1;
                const child = right < size && keys[heap[right]] < keys[heap[left]] ? right : left;
                const childTile = heap[child];
                if (keys[childTile] >= key) break;
                heap[index] = childTile;
                pos[childTile] = index;
                index = child;
            }
            heap[index] = last;
            pos[last] = index;
        }
        return root;
    }

    // ---- Legacy string-keyed helpers (tests and route descriptions) --------

    _tileTravelWeight(tileX, tileY, bridgeTiles, pathOptions) {
        const key = `${tileX},${tileY}`;
        let weight = 1;
        const weights = pathOptions.weights || TILE_WEIGHTS;
        if (bridgeTiles?.has(key) || pathOptions.bridgeTiles?.has(key)) {
            const info = bridgeTiles?.get?.(key) || pathOptions.bridgeTiles?.get?.(key);
            const preference = pathOptions.preferredBridgeId && info?.bridgeId
                ? (info.bridgeId === pathOptions.preferredBridgeId ? 0.92 : 1.08)
                : 1;
            weight = TILE_WEIGHTS.bridge * preference;
        } else if (pathOptions.dockTiles?.has(key)) weight = TILE_WEIGHTS.dock;
        else if (pathOptions.plazaTiles?.has(key)) weight = weights.plaza ?? TILE_WEIGHTS.plaza;
        else if (pathOptions.roadTiles?.has(key) || pathOptions.preferredTiles?.has(key)) weight = weights.road ?? TILE_WEIGHTS.road;
        if (pathOptions.laneTiles?.has(key) && !pathOptions.plazaTiles?.has(key)) {
            weight = Math.min(weight, weights.lane ?? TILE_WEIGHTS.lane);
        }
        if (pathOptions.avoidTiles?.has(key)) weight += TILE_WEIGHTS.avoid;
        const congestion = Number(pathOptions.congestionTiles?.get?.(key) || 0);
        if (congestion > 0) {
            weight += Math.min(TILE_WEIGHTS.congestionMax, congestion * TILE_WEIGHTS.congestionStep);
        }
        return weight;
    }

    _normalizePathOptions(options, bridgeTiles) {
        const roadTiles = this._normalizeTileSet(options?.roadTiles);
        const preferredTiles = this._normalizeTileSet(options?.preferredTiles);
        const plazaTiles = this._normalizeTileSet(options?.plazaTiles);
        const dockTiles = this._normalizeTileSet(options?.dockTiles);
        const laneTiles = this._normalizeTileSet(options?.laneTiles);
        const avoidTiles = this._normalizeTileSet(options?.avoidTiles);
        const standingTiles = this._normalizeTileSet(options?.standingTiles);
        // W0.2 — no sorted standing string: the crowd layers key on their
        // FNV-1a occupancy fingerprint instead.
        const standingVersion = String(options?.standingVersion || '');
        const congestionTiles = this._normalizeTileWeights(options?.congestionTiles);
        const optionBridgeTiles = this._normalizeTileSet(options?.bridgeTiles);
        const bridgeCount = optionBridgeTiles?.size || bridgeTiles?.size || 0;
        const weighted = (
            (roadTiles?.size || 0) +
            (preferredTiles?.size || 0) +
            (plazaTiles?.size || 0) +
            (dockTiles?.size || 0) +
            (laneTiles?.size || 0) +
            (avoidTiles?.size || 0) +
            (standingTiles?.size || 0) +
            (congestionTiles?.size || 0) +
            bridgeCount
        ) > 0;
        return {
            weighted: !!options?.preferRoads || weighted,
            cacheKey: options?.cacheKey || '',
            congestionVersion: String(options?.congestionVersion || options?.crowdVersion || ''),
            standingVersion,
            // Revision of the authored route collections (roads, lanes,
            // plazas, docks, avoid tiles, bridges); optional.
            routeVersion: String(options?.routeVersion || ''),
            roadTiles,
            preferredTiles,
            plazaTiles,
            dockTiles,
            laneTiles,
            avoidTiles,
            standingTiles,
            congestionTiles,
            bridgeTiles: optionBridgeTiles,
            personalityBucket: Math.max(0, Math.min(3, Math.floor(Number(options?.personalityBucket) || 0))),
            preferredBridgeId: options?.preferredBridgeId || '',
            weights: options?.weights || (options?.personalityBucket != null
                ? ROUTE_PERSONALITIES[Math.max(0, Math.min(3, Math.floor(Number(options.personalityBucket) || 0)))]
                : TILE_WEIGHTS),
        };
    }

    _normalizeTileSet(input) {
        if (!input) return null;
        if (input instanceof Set) return input;
        if (input instanceof Map) return input;
        if (!Array.isArray(input)) return null;
        const out = new Set();
        for (const tile of input) {
            if (typeof tile === 'string') {
                out.add(tile);
                continue;
            }
            const tileX = Number(tile?.tileX ?? tile?.x);
            const tileY = Number(tile?.tileY ?? tile?.y);
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) out.add(`${Math.round(tileX)},${Math.round(tileY)}`);
        }
        return out;
    }

    _normalizeTileWeights(input) {
        if (!input) return null;
        if (input instanceof Map) return input.size ? input : null;
        const out = new Map();
        const add = (tile, weight = 1) => {
            if (typeof tile === 'string') {
                const value = Number(weight);
                if (Number.isFinite(value) && value > 0) out.set(tile, value);
                return;
            }
            const tileX = Number(tile?.tileX ?? tile?.x);
            const tileY = Number(tile?.tileY ?? tile?.y);
            const value = Number(tile?.weight ?? tile?.pressure ?? tile?.count ?? weight);
            if (Number.isFinite(tileX) && Number.isFinite(tileY) && Number.isFinite(value) && value > 0) {
                out.set(`${Math.round(tileX)},${Math.round(tileY)}`, value);
            }
        };

        if (input instanceof Map) {
            for (const [key, value] of input.entries()) add(key, value);
        } else if (Array.isArray(input)) {
            for (const entry of input) {
                if (Array.isArray(entry)) add(entry[0], entry[1]);
                else add(entry, 1);
            }
        } else if (typeof input === 'object') {
            for (const [key, value] of Object.entries(input)) add(key, value);
        }

        return out.size > 0 ? out : null;
    }

    _pathOptionsCacheKey(pathOptions) {
        if (!pathOptions.weighted) return '';
        const standingSuffix = pathOptions.standingVersion ? `:s${pathOptions.standingVersion}` : '';
        const policyKey = `:p${pathOptions.personalityBucket}:${pathOptions.preferredBridgeId}:c${pathOptions.congestionVersion}${standingSuffix}`;
        const weightsKey = pathOptions.weights ? `:${pathOptions.weights.road}:${pathOptions.weights.plaza}:${pathOptions.weights.lane}` : '';
        if (pathOptions.cacheKey) return `|${pathOptions.cacheKey}${policyKey}${weightsKey}`;
        return `|weighted:${pathOptions.roadTiles?.size || 0}:${pathOptions.preferredTiles?.size || 0}:${pathOptions.plazaTiles?.size || 0}:${pathOptions.dockTiles?.size || 0}:${pathOptions.laneTiles?.size || 0}:${pathOptions.avoidTiles?.size || 0}:${pathOptions.standingTiles?.size || 0}:${pathOptions.congestionTiles?.size || 0}:${pathOptions.bridgeTiles?.size || 0}${policyKey}${weightsKey}`;
    }

    describeRoute(tiles, options = null) {
        const list = Array.isArray(tiles) ? tiles : [];
        const pathOptions = this._normalizePathOptions(options, options?.bridgeTiles || null);
        let roadSteps = 0;
        let bridgeSteps = 0;
        let laneSteps = 0;
        let congestion = 0;
        for (const tile of list) {
            const tileX = Math.round(Number(tile?.tileX ?? tile?.x));
            const tileY = Math.round(Number(tile?.tileY ?? tile?.y));
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const key = `${tileX},${tileY}`;
            if (pathOptions.roadTiles?.has(key) || pathOptions.preferredTiles?.has(key)) roadSteps++;
            if (pathOptions.bridgeTiles?.has(key)) bridgeSteps++;
            if (pathOptions.laneTiles?.has(key)) laneSteps++;
            congestion += Number(pathOptions.congestionTiles?.get?.(key) || 0);
        }
        return {
            steps: list.length,
            roadSteps,
            bridgeSteps,
            laneSteps,
            congestion,
            roadShare: list.length ? roadSteps / list.length : 0,
        };
    }

    _lineWalkable(x0, y0, x1, y1) {
        return !!this._lineWalkableTiles(x0, y0, x1, y1);
    }

    // The Bresenham tile line from (x0, y0) to (x1, y1), or null when any
    // step on it is not a legal stepMask edge. That one test covers every
    // step rule the searches use: the next tile is walkable, a diagonal
    // never cuts a blocked corner, and a terrace tier change only happens
    // across an orthogonal stair pair. The straight-line shortcut and
    // `_lookahead` both walk this, so neither can skip a terrace edge.
    _lineWalkableTiles(x0, y0, x1, y1) {
        if (!this.surfaceSegmentClear(x0, y0, x1, y1)) return null;
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        const mask = this.stepMask;
        let err = dx - dy;
        let cx = x0;
        let cy = y0;
        const tiles = [];
        while (true) {
            if (!this.isWalkable(cx, cy)) return null;
            tiles.push(this._waypoint(cy * MAP_N + cx));
            if (cx === x1 && cy === y1) return tiles;
            const e2 = 2 * err;
            let stepX = 0;
            let stepY = 0;
            if (e2 > -dy) { err -= dy; stepX = sx; }
            if (e2 < dx) { err += dx; stepY = sy; }
            const dir = STEP_DIR[(stepY + 1) * 3 + stepX + 1];
            if (dir < 0 || !(mask[cy * MAP_N + cx] & (1 << dir))) return null;
            cx += stepX;
            cy += stepY;
        }
    }

    _isBridgeCrossingTile(tile, bridgeTiles) {
        if (!tile || !bridgeTiles?.size) return false;
        const key = `${tile.tileX},${tile.tileY}`;
        if (!bridgeTiles.has(key)) return false;
        const info = bridgeTiles.get?.(key);
        return !info || info.kind !== 'dock';
    }

    _simplify(tiles, bridgeTiles) {
        if (tiles.length <= 1) return tiles;
        const out = [];
        let prevDir = null;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const prev = tiles[i - 1];
            const next = tiles[i + 1];
            const onBridge = bridgeTiles?.has(`${t.tileX},${t.tileY}`);
            const bridgeLanding = !onBridge && (
                this._isBridgeCrossingTile(prev, bridgeTiles)
                || this._isBridgeCrossingTile(next, bridgeTiles)
            );
            if (!next) {
                out.push(t); // always include final destination
                break;
            }
            const dir = `${Math.sign(next.tileX - t.tileX)},${Math.sign(next.tileY - t.tileY)}`;
            if (onBridge || bridgeLanding || t.surfaceId !== prev?.surfaceId || t.surfaceId !== next.surfaceId || dir !== prevDir) {
                out.push(t);
            }
            prevDir = dir;
        }
        return out;
    }

    _lookahead(tiles, bridgeTiles) {
        if (tiles.length <= 2) return tiles;
        const out = [tiles[0]];
        let i = 0;
        while (i < tiles.length - 1) {
            // Find the furthest waypoint reachable via a clear straight line from tiles[i].
            let j = tiles.length - 1;
            while (j > i + 1) {
                // Never skip over bridge deck or landing tiles — they must remain explicit waypoints.
                const hasBridge = tiles.slice(i + 1, j).some((t, offset) => {
                    const idx = i + 1 + offset;
                    return t.surfaceId !== tiles[i].surfaceId || t.surfaceId !== tiles[j].surfaceId
                        || bridgeTiles?.has(`${t.tileX},${t.tileY}`)
                        || this._isBridgeCrossingTile(tiles[idx - 1], bridgeTiles)
                        || this._isBridgeCrossingTile(tiles[idx + 1], bridgeTiles);
                });
                if (!hasBridge && this._lineWalkable(
                    tiles[i].tileX, tiles[i].tileY,
                    tiles[j].tileX, tiles[j].tileY,
                )) break;
                j--;
            }
            out.push(tiles[j]);
            i = j;
        }
        return out;
    }
}
