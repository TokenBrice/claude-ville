import { TILE_HALF_HEIGHT, TILE_HALF_WIDTH, worldToTile } from './Projection.js';
import { frontEdgeFoot, landmarkFootprint } from './FootprintField.js';
import { normalizeMaterialMetadata } from './MaterialRegistry.js';

function finiteSortY(value) {
    return Number.isFinite(value) ? value : 0;
}

const KIND_ORDER = Object.freeze({
    'building-back': 10,
    'prop-back': 20,
    prop: 30,
    'prop-column': 30,
    'harbor-hulls': 40,
    'harbor-traffic': 40,
    'bridge-lantern': 45,
    agent: 50,
    'landmark-activity': 60,
    'chronicle-monument': 70,
    'familiar-motes': 80,
    'building-front': 90,
    'building-column': 90,
    building: 95,
    // 0.6 — a particle paints after every other kind at an equal sortY, as
    // the resident LEQUAL test shows it over the records sharing its depth.
    particle: 100,
});
const EMPTY_SEMANTICS = Object.freeze({});

/**
 * Shared depth drawable contract for World mode overlap rendering.
 *
 * Shape:
 * - kind: stable category for diagnostics and special-case consumers.
 * - sortY: finite world-space Y used for painter ordering.
 * - drawFallback(ctx, zoom, context): current Canvas-2D implementation.
 * - buildGpuRecord(context): optional additive GPU-record seam.
 * - hitArea: optional future hit-test metadata.
 * - payload: original source object for legacy consumers.
 */
export function createDepthDrawable(kind, sortY, payload, drawFallback, semantics = EMPTY_SEMANTICS) {
    return initializeDepthDrawable({}, kind, sortY, payload, drawFallback, semantics);
}

function drawDepthDrawableFallback(ctx, zoom, context) {
    this._drawFallback?.call(undefined, ctx, zoom, context, this.payload, this);
}

function buildDepthDrawableGpuRecord(context = {}) {
    if (typeof this._gpuBuilder === 'function') {
        return this._gpuBuilder.call(undefined, context, this.payload, this);
    }
    return context.spriteRenderer?.buildGpuRecordForDrawable?.(this, context) ?? null;
}

function initializeDepthDrawable(drawable, kind, sortY, payload, drawFallback, semantics = EMPTY_SEMANTICS) {
    const materialSource = drawableMaterialSource(payload, semantics);
    const materialId = drawableMaterialId(payload, semantics, materialSource);
    let material = drawable._material;
    if (
        !material
        || drawable._materialSource !== materialSource
        || drawable._materialId !== materialId
        || drawable._materialClass !== (semantics?.materialClass ?? materialSource.materialClass)
        || drawable._elevation !== (semantics?.elevation ?? materialSource.elevation)
        || drawable._emissive !== (semantics?.emissive ?? materialSource.emissive)
        || drawable._occluder !== (semantics?.occluder ?? materialSource.occluder)
        || drawable._atlasFrame !== (semantics?.atlasFrame ?? materialSource.atlasFrame)
    ) {
        material = drawableMaterialMetadata(payload, semantics, materialSource, materialId);
        drawable._material = material;
        drawable._materialSource = materialSource;
        drawable._materialId = materialId;
        drawable._materialClass = semantics?.materialClass ?? materialSource.materialClass;
        drawable._elevation = semantics?.elevation ?? materialSource.elevation;
        drawable._emissive = semantics?.emissive ?? materialSource.emissive;
        drawable._occluder = semantics?.occluder ?? materialSource.occluder;
        drawable._atlasFrame = semantics?.atlasFrame ?? materialSource.atlasFrame;
    }
    const gpuBuilder = semantics?.buildGpuRecord || payload?.buildGpuRecord || null;
    // Every mutable/public field is assigned on every checkout. In particular,
    // category-only fields are reset here so a wrapper reused for another kind
    // cannot retain scene policy from its previous entity.
    drawable.kind = kind;
    drawable.sortY = finiteSortY(sortY);
    drawable.sortBand = Number.isFinite(Number(semantics?.sortBand))
        ? Number(semantics.sortBand)
        : KIND_ORDER[kind] ?? 50;
    drawable.stableKey = payloadStableKey(payload);
    drawable.salience = normalizeSalience(semantics?.salience ?? payload?.salience);
    drawable.materialId = material.materialId;
    drawable.materialClass = material.materialClass;
    drawable.elevation = material.elevation;
    drawable.emissive = material.emissive;
    drawable.occluder = material.occluder;
    drawable.atlasFrame = material.atlasFrame;
    drawable.hitArea = payload?.hitArea || null;
    drawable.payload = payload;
    drawable._drawFallback = drawFallback || null;
    drawable.drawFallback = drawDepthDrawableFallback;
    drawable.draw = drawDepthDrawableFallback;
    drawable._gpuBuilder = gpuBuilder;
    drawable.gpuReady = typeof gpuBuilder === 'function';
    drawable.buildGpuRecord = buildDepthDrawableGpuRecord;
    drawable.sceneCategory = null;
    drawable.overlayBand = 0;
    drawable.sequence = 0;
    return drawable;
}

function drawAgent(ctx, zoom, context, sprite) {
    sprite?.setGpuWorldEnabled?.(context.gpuWorldActive === true);
    sprite?.draw?.(ctx, zoom, context.agentRenderMode || 'full');
}

function drawBuilding(ctx, zoom, context, drawable) {
    context.buildingRenderer?.drawDrawable?.(ctx, drawable);
}

function drawProp(ctx, zoom, context, payload) {
    payload?.sprite?.drawPart?.(ctx, payload.part || 'whole', zoom, payload.column);
}


function drawChronicleMonument(ctx, zoom, context, drawable) {
    context.chronicleMonuments?.draw?.(ctx, drawable, zoom, context.renderNow);
}


function drawFamiliarMotes(ctx, zoom, context, drawable) {
    drawable?.draw?.(ctx, zoom, context);
}

function drawSceneCategory(ctx, zoom, context, payload, drawable) {
    drawable.sceneCategory?.canvasFallback(ctx, payload, zoom, context);
}

// 3.8 / M23 — a scene category the backend resolved native (the registry
// marks its entry) emits its commands as V9 records from its own depth
// drawable, so they land in painter order with every other record. Other
// categories return nothing here and replay on the overlay.
function sceneCategoryGpuRecords(context, payload, drawable) {
    if (drawable.sceneNative !== true) return null;
    return drawable.sceneCategory?.emitSceneCommands?.(payload, context) ?? null;
}

const _framePools = new WeakMap();
const _sceneCategorySemantics = new WeakMap();

function sceneCategorySemantics(category) {
    let semantics = _sceneCategorySemantics.get(category);
    if (!semantics) {
        semantics = { sortBand: category.sortBand, buildGpuRecord: sceneCategoryGpuRecords };
        _sceneCategorySemantics.set(category, semantics);
    } else {
        semantics.sortBand = category.sortBand;
    }
    return semantics;
}

function pooledDepthDrawable(target, kind, sortY, payload, drawFallback, semantics) {
    let pool = _framePools.get(target);
    if (!pool) {
        pool = {
            byEntity: new WeakMap(),
            stableCurrent: new Map(),
            stablePrevious: new Map(),
            fallback: [],
            fallbackCursor: 0,
            generation: 0,
        };
        _framePools.set(target, pool);
    }
    let drawable = null;
    const entity = payload?.building || payload?.agent || payload?.sprite || null;
    const poolKey = payload?.column != null
        ? (payload.kind === kind && payload.poolKey ? payload.poolKey : `${kind}:${payload.column.index}`)
        : kind;
    if (entity && (typeof entity === 'object' || typeof entity === 'function')) {
        let byKind = pool.byEntity.get(entity);
        if (!byKind) {
            byKind = new Map();
            pool.byEntity.set(entity, byKind);
        }
        drawable = byKind.get(poolKey);
        if (!drawable) {
            drawable = {};
            byKind.set(poolKey, drawable);
        }
    } else {
        const stableKey = payloadStableKey(payload);
        if (stableKey) {
            let byKind = pool.stableCurrent.get(stableKey);
            if (!byKind) {
                byKind = new Map();
                pool.stableCurrent.set(stableKey, byKind);
            }
            drawable = byKind.get(poolKey);
            if (!drawable) {
                drawable = pool.stablePrevious.get(stableKey)?.get(poolKey) || {};
                byKind.set(poolKey, drawable);
            }
        } else {
            const index = pool.fallbackCursor++;
            drawable = pool.fallback[index] || (pool.fallback[index] = {});
        }
    }
    if (drawable && drawable._poolGeneration === pool.generation) {
        const index = pool.fallbackCursor++;
        drawable = pool.fallback[index] || (pool.fallback[index] = {});
    }
    drawable._poolGeneration = pool.generation;
    return initializeDepthDrawable(drawable, kind, sortY, payload, drawFallback, semantics);
}

export function propDepthDrawable(sprite, part = 'whole', column = null) {
    const kind = part === 'whole' ? 'prop' : `prop-${part}`;
    return createDepthDrawable(kind, propPartSortY(sprite, part, column), { sprite, part, column }, drawProp);
}

export function propPartSortY(sprite, part = 'whole', column = null) {
    if (part === 'column') return column.sortY;
    if (part === 'back') return sprite.propBackSortY();
    if (part === 'front') return sprite.propFrontSortY();
    return sprite.sortY ?? sprite.y;
}

export function appendDepthSortedDrawables(target, {
    buildingDrawables = [],
    propDrawables = [],
    agentSprites = [],
    sceneCategoryFrame = null,
    chronicleMonumentDrawables = [],
    familiarDrawables = [],
    particles = null,
    sprites = null,
    assets = null,
    zoom = 1,
} = {}) {
    const pool = _framePools.get(target);
    if (pool) {
        pool.fallbackCursor = 0;
        pool.generation += 1;
        const previous = pool.stablePrevious;
        pool.stablePrevious = pool.stableCurrent;
        pool.stableCurrent = previous;
        pool.stableCurrent.clear();
    }
    for (const drawable of buildingDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, drawable.kind, drawable.sortY, drawable, drawBuilding));
    }
    const resolvedAssets = assets || sprites?.assets || null;
    const splitBuildings = collectSplitBuildings(buildingDrawables, resolvedAssets);
    const allBuildings = collectAllBuildings(buildingDrawables);
    const columnBuildings = collectColumnBuildings(buildingDrawables, resolvedAssets);
    const bridgeRails = _bridgeRailScratch;
    bridgeRails.length = 0;
    for (const drawable of propDrawables) {
        // 7.1 — a rest seat's back and front slices bracket their sitter. A
        // sitter standing behind a split building sorts just before its back
        // half (agentSortY), so the seat's slices move there with it, keeping
        // back < body < front.
        const sprite = drawable.payload?.sprite;
        if (sprite?.bracketsSitter) {
            const behind = behindSplitSortY(sprite.x, sprite.y, splitBuildings, sprites);
            const own = propPartSortY(sprite, drawable.payload.part, drawable.payload.column);
            drawable.sortY = behind == null ? own : behind + (own - sprite.y) / 8;
        }
        if (sprite?.bridgeWalk) bridgeRails.push(drawable);
        pushDepthDrawable(target, drawable);
    }
    for (const sprite of agentSprites) {
        pushDepthDrawable(target, pooledDepthDrawable(target, 'agent', agentSortY(sprite, splitBuildings, allBuildings, bridgeRails, sprites), sprite, drawAgent));
    }
    if (agentSprites.length) {
        updateAgentWorldOcclusion({
            agentSprites,
            buildingDrawables,
            propDrawables,
            sprites,
            assets: resolvedAssets,
            zoom,
        });
    }
    bridgeRails.length = 0;
    for (const entry of sceneCategoryFrame?.entries || []) {
        const category = entry.category;
        for (const item of entry.items) {
            // 3.8 — a hull on the water behind a building (the Harbor on its
            // piers) records `behindBuilding` for its marks pass; legacy split
            // buildings also sort it before the back half, while column-sorted
            // buildings naturally depth-sort it by column.
            let sortY = item?.sortY;
            if (category.behindSplitBuildings === true && item) {
                const split = behindSplit(item.x, item.y, splitBuildings, sprites);
                const columnOcc = split ? null : behindColumnBuilding(item.x, item.y, columnBuildings, sortY);
                // Read by the category's own marks pass (flags, plates): the
                // depth verdict plus the building that sorts over the item,
                // so the marks pass can test whether its silhouette actually
                // covers the hull on screen before hiding them.
                item.behindBuilding = split != null || columnOcc != null;
                item.behindBuildingDrawable = split?.drawable ?? columnOcc?.drawable ?? null;
                if (split != null) sortY = split.backSortY - 0.5;
            }
            const drawable = pooledDepthDrawable(
                target,
                category.id,
                sortY,
                item,
                drawSceneCategory,
                sceneCategorySemantics(category),
            );
            drawable.sceneCategory = category;
            drawable.sceneNative = entry.native === true;
            drawable.overlayBand = category.overlayBand;
            pushDepthDrawable(target, drawable);
        }
    }
    for (const drawable of chronicleMonumentDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, 'chronicle-monument', drawable.sortY, drawable, drawChronicleMonument));
    }
    for (const drawable of familiarDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, drawable.kind || 'familiar-motes', drawable.sortY, drawable, drawFamiliarMotes));
    }
    appendParticleDrawables(target, particles);
    const activePool = _framePools.get(target);
    for (let index = activePool?.fallbackCursor || 0; index < (activePool?.fallback.length || 0); index++) {
        clearPooledDrawable(activePool.fallback[index]);
    }
    target.sort(compareDepthDrawables);
}

// W-F16 — a legacy split building paints its back half at the back footprint
// depth and its front half at the front. `behindSplit` is strictly bounded to
// the building's FootprintField front-edge geometry (and confirmed via opaque
// `sprites.hitTest` when available) so a neighbouring building can never steal
// a villager standing in another building's yard.
const _splitBuildingScratch = [];
function collectSplitBuildings(buildingDrawables, assets = null) {
    const out = _splitBuildingScratch;
    out.length = 0;
    for (const drawable of buildingDrawables) {
        if (drawable?.kind !== 'building-back' || !drawable.building) continue;
        const building = drawable.building;
        const front = buildingDrawables.find(entry => entry?.kind === 'building-front' && entry.building === building);
        if (!front) continue;
        const x0 = Number(building.x ?? building.position?.tileX);
        const y0 = Number(building.y ?? building.position?.tileY);
        const width = Number(building.width) || 1;
        const height = Number(building.height) || 1;
        const x1 = x0 + width;
        const y1 = y0 + height;
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
        const fp = landmarkFootprint(building);
        const id = drawable.entry?.id || null;
        const dims = id ? assets?.getDims?.(id) : null;
        const anchor = id ? assets?.getAnchor?.(id) : null;
        const spriteLeft = dims && Array.isArray(anchor) ? Math.round(drawable.wx - anchor[0]) : null;
        const spriteTop = dims && Array.isArray(anchor) ? Math.round(drawable.wy - anchor[1]) : null;
        out.push({
            drawable,
            building,
            fp,
            id,
            backSortY: drawable.sortY,
            frontSortY: front.sortY,
            x0,
            y0,
            x1,
            y1,
            left: fp.left.x,
            right: fp.right.x,
            spriteLeft,
            spriteTop,
            spriteRight: spriteLeft != null ? spriteLeft + dims.w : null,
            spriteBottom: spriteTop != null ? spriteTop + dims.h : null,
        });
    }
    return out;
}

const _allBuildingScratch = [];
function collectAllBuildings(buildingDrawables) {
    const out = _allBuildingScratch;
    out.length = 0;
    for (const drawable of buildingDrawables) {
        const building = drawable?.building;
        if (!building || out.includes(building)) continue;
        out.push(building);
    }
    return out;
}

const _columnBuildingScratch = [];
const _columnBuildingPool = [];
const _columnBuildingByBuilding = new Map();

function collectColumnBuildings(buildingDrawables, assets = null) {
    const out = _columnBuildingScratch;
    out.length = 0;
    const byBuilding = _columnBuildingByBuilding;
    byBuilding.clear();
    let cursor = 0;
    for (const drawable of buildingDrawables) {
        if (drawable?.kind !== 'building-column' || !drawable.building || !drawable.column) continue;
        let entry = byBuilding.get(drawable.building);
        if (!entry) {
            const id = drawable.entry?.id || null;
            const dims = id ? assets?.getDims?.(id) : null;
            const anchor = id ? assets?.getAnchor?.(id) : null;
            const left = dims && Array.isArray(anchor) ? Math.round(drawable.wx - anchor[0]) : drawable.column.worldLeft;
            const top = dims && Array.isArray(anchor) ? Math.round(drawable.wy - anchor[1]) : -Infinity;
            entry = _columnBuildingPool[cursor];
            if (!entry) {
                entry = {
                    building: null,
                    drawable: null,
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    columns: [],
                };
                _columnBuildingPool[cursor] = entry;
            }
            cursor++;
            entry.building = drawable.building;
            entry.drawable = drawable;
            entry.left = left;
            entry.right = dims ? left + dims.w : drawable.column.worldRight;
            entry.top = top;
            entry.bottom = dims ? top + dims.h : Infinity;
            entry.columns.length = 0;
            byBuilding.set(drawable.building, entry);
            out.push(entry);
        }
        entry.columns.push(drawable);
        if (drawable.column.worldLeft < entry.left) entry.left = drawable.column.worldLeft;
        if (drawable.column.worldRight > entry.right) entry.right = drawable.column.worldRight;
    }
    byBuilding.clear();
    for (let i = cursor; i < _columnBuildingPool.length; i++) {
        const stale = _columnBuildingPool[i];
        stale.building = null;
        stale.drawable = null;
        stale.columns.length = 0;
    }
    return out;
}

function behindColumnBuilding(x, y, columnBuildings, itemSortY = null) {
    if (!columnBuildings.length || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const depth = Number.isFinite(itemSortY) ? itemSortY : y;
    for (const entry of columnBuildings) {
        if (x < entry.left || x > entry.right || y < entry.top || y > entry.bottom + 12) continue;
        for (const colDrawable of entry.columns) {
            const col = colDrawable.column;
            if (x >= col.worldLeft && x < col.worldRight && colDrawable.sortY > depth) {
                return entry;
            }
        }
    }
    return null;
}

// The legacy split building a point at (x, y) stands behind (bounded to its
// FootprintField front-edge geometry and confirmed by opaque sprite overlap
// when `sprites.hitTest` is available), else null.
function behindSplit(x, y, splitBuildings, sprites = null) {
    if (!splitBuildings.length || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const split of splitBuildings) {
        if (!(y > split.backSortY && y <= split.frontSortY)) continue;
        if (x < split.left || x > split.right) continue;
        const frontY = frontEdgeFoot(split.fp, x).y - TILE_HALF_HEIGHT;
        if (y > frontY) continue;
        const tile = worldToTile(x, y);
        // A body on a landmark's open floor (the Tavern's veranda) stands in
        // the building, not behind it: it paints between the halves.
        if (split.building?.isOpenFloor?.(tile.tileX, tile.tileY)) continue;
        // Lower-bound tile check keeps neighbouring yards out of this building.
        if (tile.tileX < split.x0 - 2 || tile.tileY < split.y0 - 2) continue;
        if (tile.tileX >= split.x1 || tile.tileY >= split.y1) continue;
        if (split.spriteLeft != null) {
            if (x < split.spriteLeft - 12 || x > split.spriteRight + 12 || y < split.spriteTop || y > split.spriteBottom + 12) continue;
        }
        if (typeof sprites?.hitTest === 'function' && split.id && split.spriteLeft != null) {
            const hit = sprites.hitTest(split.id, x, y - 6, split.spriteLeft, split.spriteTop)
                || sprites.hitTest(split.id, x, y - 20, split.spriteLeft, split.spriteTop)
                || sprites.hitTest(split.id, x, y - 34, split.spriteLeft, split.spriteTop);
            if (!hit) continue;
        }
        return split;
    }
    return null;
}

// True when (x, y) stands on any building's open floor (Building.openFloor).
function onOpenFloor(x, y, buildings) {
    if (!buildings.length || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const tile = worldToTile(x, y);
    return buildings.some((building) => building?.isOpenFloor?.(tile.tileX, tile.tileY) === true);
}

// The back-half depth such a point takes, else null.
function behindSplitSortY(x, y, splitBuildings, sprites = null) {
    const split = behindSplit(x, y, splitBuildings, sprites);
    return split ? split.backSortY - 0.5 : null;
}

// A landmark bridge's near-rail slices (IsometricRenderer
// `_buildBridgeNearRailSprites`) repaint the bridge image inside a band at the
// camera-side handrail, sorted at the deck's near edge. On a measured deck
// (`deckProfile`) the band holds only the rail beam, and a body on the deck
// is lifted onto the planks behind it: it keeps its ground Y, sorts before
// the slices, and the rail crosses the near file's legs. A body on the walk
// at least as near as the deck's camera-side end (the slice's `bridgeWalk`
// `minY`, IsometricRenderer `_bridgeWalk`: the stairs and the landing) stands
// in front of the rail's end: it sorts just after the bridge's last slice.
// The threshold is a depth, so every body on the walk keeps its ground order.
// Without a measured deck the band also repaints planks and end posts, so
// the whole deck column and both landing tiles take the rule. A
// body anywhere else (the bank by the end posts, the water under the arch)
// keeps its ground Y, so the rail still covers what stands behind it.
const _bridgeRailScratch = [];

function onBridgeWalk(tileX, tileY, walk) {
    if (!walk) return false;
    const along = walk.axis === 'x' ? tileX : tileY;
    const across = walk.axis === 'x' ? tileY : tileX;
    return Math.abs(across - walk.line) < walk.halfWidth && along >= walk.from && along <= walk.to;
}

// The sortY that keeps `sprite` over the near-rail slices among
// `railDrawables` (prop drawables whose sprite carries `bridgeWalk`), else
// null. A prop paints before a body at an equal sortY, so the body takes the
// last slice's sortY plus a hundredth that grows with its ground Y.
function bridgeDeckSortY(sprite, railDrawables) {
    if (!railDrawables?.length || !Number.isFinite(sprite?.x) || !Number.isFinite(sprite?.y)) return null;
    const tile = worldToTile(sprite.x, sprite.y);
    let top = -Infinity;
    for (const drawable of railDrawables) {
        const walk = drawable?.payload?.sprite?.bridgeWalk;
        if (onBridgeWalk(tile.tileX, tile.tileY, walk) && sprite.y >= walk.minY) top = Math.max(top, drawable.sortY);
    }
    if (!(top > sprite.y)) return null;
    return top + 0.01 * Math.max(0, 1 - (top - sprite.y) / 1024);
}

// The painter sortY the sprite was sorted at this frame is kept on the
// sprite (`_depthSortY`), so the particles it emits (footfalls, sweat, motes)
// sort with the body that owns them, behind a building with it.
function agentSortY(sprite, splitBuildings, allBuildings, bridgeRails, sprites = null) {
    sprite._onOpenFloor = onOpenFloor(sprite.x, sprite.y, allBuildings);
    const split = behindSplit(sprite.x, sprite.y, splitBuildings, sprites);
    sprite._splitBehindBuilding = split != null;
    sprite._splitBehindDrawable = split ? split.drawable : null;
    sprite._behindBuilding = split != null;
    // W3.4 — the occluding building, so the overlay can lift this body's
    // thought above its crown while the body itself stays hidden.
    sprite._behindBuildingDrawable = split ? split.drawable : null;
    sprite._depthSortY = split ? split.backSortY - 0.5 : (bridgeDeckSortY(sprite, bridgeRails) ?? sprite.y);
    return sprite._depthSortY;
}

const DEFAULT_AGENT_OCCLUSION_BOX = Object.freeze({ left: -10, right: 10, top: -44, bottom: -2 });
const OCCLUSION_GRID_X = Object.freeze([0.25, 0.5, 0.75]);
const OCCLUSION_GRID_Y = Object.freeze([0.2, 0.5, 0.8]);

export function isWorldOccluderPropId(id) {
    if (typeof id !== 'string' || !id) return false;
    return id === 'prop.villageGate'
        || id === 'prop.villageWallSeaTower'
        || id.startsWith('village.wall.');
}

const _worldOccluderScratch = [];
const _worldOccluderPool = [];
const _worldOccluderColumnPool = [];
const _occluderByBuilding = new Map();
const _occluderByProp = new Map();
const _clipRangeRaw = [];
const _clipRangePairPool = [];

function compareClipRange(a, b) {
    return a[0] - b[0];
}

function acquireWorldOccluder(index) {
    let occ = _worldOccluderPool[index];
    if (!occ) {
        occ = {
            kind: '',
            id: '',
            drawable: null,
            image: null,
            mask: null,
            dx: 0,
            dy: 0,
            w: 0,
            h: 0,
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            columns: null,
            _colList: [],
            sortY: 0,
            rowStart: 0,
        };
        _worldOccluderPool[index] = occ;
    }
    return occ;
}

function acquireOccluderColumn(index, worldLeft, worldRight, sortY) {
    let col = _worldOccluderColumnPool[index];
    if (!col) {
        col = { worldLeft: 0, worldRight: 0, sortY: 0 };
        _worldOccluderColumnPool[index] = col;
    }
    col.worldLeft = worldLeft;
    col.worldRight = worldRight;
    col.sortY = sortY;
    return col;
}

function collectWorldOccluders(buildingDrawables, propDrawables, assets, zoom) {
    const occluders = _worldOccluderScratch;
    occluders.length = 0;
    const byBuilding = _occluderByBuilding;
    const byProp = _occluderByProp;
    byBuilding.clear();
    byProp.clear();
    let occCursor = 0;
    let colCursor = 0;
    for (const drawable of buildingDrawables || []) {
        const building = drawable?.building;
        const id = drawable?.entry?.id;
        if (!building || !id) continue;
        if (drawable.kind === 'building-back') continue;
        let occ = byBuilding.get(building);
        if (!occ) {
            const dims = assets?.getDims?.(id);
            const anchor = assets?.getAnchor?.(id);
            const mask = assets?.getMask?.(id) || null;
            if (!dims || !Array.isArray(anchor) || !mask) continue;
            const dx = Math.round(drawable.wx - anchor[0]);
            const dy = Math.round(drawable.wy - anchor[1]);
            occ = acquireWorldOccluder(occCursor++);
            occ.kind = 'building';
            occ.id = id;
            occ.drawable = drawable;
            occ.image = assets?.get?.(id) || null;
            occ.mask = mask;
            occ.dx = dx;
            occ.dy = dy;
            occ.w = dims.w;
            occ.h = dims.h;
            occ.left = dx;
            occ.right = dx + dims.w;
            occ.top = dy;
            occ.bottom = dy + dims.h;
            occ._colList.length = 0;
            occ.columns = null;
            occ.sortY = drawable.sortY;
            occ.rowStart = drawable.kind === 'building-front' ? (drawable.horizonY || 0) : 0;
            byBuilding.set(building, occ);
            occluders.push(occ);
        }
        if (drawable.kind === 'building-column' && drawable.column) {
            if (!occ.columns) occ.columns = occ._colList;
            occ.columns.push(acquireOccluderColumn(
                colCursor++,
                drawable.column.worldLeft,
                drawable.column.worldRight,
                drawable.sortY,
            ));
            if (drawable.sortY > occ.sortY) occ.sortY = drawable.sortY;
        } else if (drawable.sortY > occ.sortY) {
            occ.sortY = drawable.sortY;
        }
    }
    for (const drawable of propDrawables || []) {
        const sprite = drawable?.payload?.sprite;
        if (!sprite || !isWorldOccluderPropId(sprite.id)) continue;
        const part = drawable.payload?.part || 'whole';
        if (part === 'back') continue;
        let occ = byProp.get(sprite);
        if (!occ) {
            const alphaMask = typeof sprite.getAlphaMask === 'function' ? sprite.getAlphaMask(zoom) : null;
            if (!alphaMask?.mask) continue;
            occ = acquireWorldOccluder(occCursor++);
            occ.kind = 'prop';
            occ.id = sprite.id;
            occ.drawable = drawable;
            occ.image = alphaMask.canvas || null;
            occ.mask = alphaMask.mask;
            occ.dx = alphaMask.x;
            occ.dy = alphaMask.y;
            occ.w = alphaMask.w;
            occ.h = alphaMask.h;
            occ.left = alphaMask.x;
            occ.right = alphaMask.x + alphaMask.w;
            occ.top = alphaMask.y;
            occ.bottom = alphaMask.y + alphaMask.h;
            occ._colList.length = 0;
            occ.columns = null;
            occ.sortY = drawable.sortY;
            occ.rowStart = 0;
            byProp.set(sprite, occ);
            occluders.push(occ);
        }
        if (part === 'column' && drawable.payload?.column) {
            const col = drawable.payload.column;
            if (!occ.columns) occ.columns = occ._colList;
            const worldLeft = Number.isFinite(col.left) ? Math.round(sprite.x + col.left) : occ.left;
            const worldRight = Number.isFinite(col.right) ? Math.round(sprite.x + col.right) : occ.right;
            occ.columns.push(acquireOccluderColumn(colCursor++, worldLeft, worldRight, col.sortY));
            if (col.sortY > occ.sortY) occ.sortY = col.sortY;
        } else if (drawable.sortY > occ.sortY) {
            occ.sortY = drawable.sortY;
        }
    }
    byBuilding.clear();
    byProp.clear();
    return occluders;
}

function clearWorldOccluderScratch() {
    for (let i = 0; i < _worldOccluderScratch.length; i++) {
        const occ = _worldOccluderScratch[i];
        occ.drawable = null;
        occ.image = null;
        occ.mask = null;
        occ._colList.length = 0;
        occ.columns = null;
    }
    _worldOccluderScratch.length = 0;
}

function occluderPointOpaque(occ, px, py, agentDepth, sprites) {
    if (px < occ.left || px >= occ.right || py < occ.top || py >= occ.bottom) return false;
    if (occ.columns) {
        let colSortY = null;
        for (let i = 0; i < occ.columns.length; i++) {
            const col = occ.columns[i];
            if (px >= col.worldLeft && px < col.worldRight) {
                colSortY = col.sortY;
                break;
            }
        }
        if (!(colSortY > agentDepth)) return false;
    } else if (!(occ.sortY > agentDepth)) {
        return false;
    }
    const lx = Math.floor(px - occ.dx);
    const ly = Math.floor(py - occ.dy);
    if (ly < occ.rowStart || lx < 0 || lx >= occ.w || ly < 0 || ly >= occ.h) return false;
    if (occ.kind === 'building' && typeof sprites?.hitTest === 'function') {
        return sprites.hitTest(occ.id, px, py, occ.dx, occ.dy);
    }
    return occ.mask[ly * occ.w + lx] === 1;
}

function occluderClipRanges(occ, agentDepth, boxLeft, boxRight, outRanges, rangePool) {
    if (!occ.columns) return null;
    const raw = _clipRangeRaw;
    raw.length = 0;
    let rawCount = 0;
    for (let i = 0; i < occ.columns.length; i++) {
        const col = occ.columns[i];
        if (!(col.sortY > agentDepth)) continue;
        if (col.worldRight <= boxLeft || col.worldLeft >= boxRight) continue;
        let pair = _clipRangePairPool[rawCount];
        if (!pair) {
            pair = [0, 0];
            _clipRangePairPool[rawCount] = pair;
        }
        pair[0] = col.worldLeft;
        pair[1] = col.worldRight;
        raw.push(pair);
        rawCount++;
    }
    outRanges.length = 0;
    if (rawCount === 0) return outRanges;
    if (rawCount > 1) raw.sort(compareClipRange);
    let outCount = 0;
    let first = rangePool[outCount];
    if (!first) {
        first = [0, 0];
        rangePool[outCount] = first;
    }
    first[0] = raw[0][0];
    first[1] = raw[0][1];
    outRanges.push(first);
    outCount++;
    for (let i = 1; i < rawCount; i++) {
        const next = raw[i];
        const last = outRanges[outCount - 1];
        if (next[0] <= last[1] + 1) {
            if (next[1] > last[1]) last[1] = next[1];
        } else {
            let slot = rangePool[outCount];
            if (!slot) {
                slot = [0, 0];
                rangePool[outCount] = slot;
            }
            slot[0] = next[0];
            slot[1] = next[1];
            outRanges.push(slot);
            outCount++;
        }
    }
    raw.length = 0;
    return outRanges;
}

/**
 * Sets `sprite._occludedByWorld`, `sprite._worldOccluders`, and syncs
 * `sprite._behindBuilding` / `sprite._behindBuildingDrawable` from opaque-pixel
 * occlusion against buildings, the village gate, and wall props that sort after
 * the villager.
 */
export function updateAgentWorldOcclusion({
    agentSprites = [],
    buildingDrawables = [],
    propDrawables = [],
    sprites = null,
    assets = null,
    zoom = 1,
} = {}) {
    const resolvedAssets = assets || sprites?.assets || null;
    const occluders = collectWorldOccluders(buildingDrawables, propDrawables, resolvedAssets, zoom);
    for (const sprite of agentSprites || []) {
        if (!sprite) continue;
        const hits = sprite._worldOccluders || (sprite._worldOccluders = []);
        hits.length = 0;
        const hitPool = sprite._worldOccluderPool || (sprite._worldOccluderPool = []);
        let hitCount = 0;
        if (
            sprite._onOpenFloor
            || sprite.isArrivalPending?.()
            || !Number.isFinite(sprite.x)
            || !Number.isFinite(sprite.y)
        ) {
            sprite._occludedByWorld = false;
            sprite._behindBuilding = false;
            sprite._behindBuildingDrawable = null;
            for (let i = 0; i < hitPool.length; i++) {
                hitPool[i].image = null;
                hitPool[i].drawable = null;
            }
            continue;
        }
        const box = sprite._bodyBox || DEFAULT_AGENT_OCCLUSION_BOX;
        const cx = Number.isFinite(sprite._placeX) ? sprite._placeX : sprite.x;
        const lift = typeof sprite._currentBridgeLift === 'function' ? (sprite._currentBridgeLift() || 0) : 0;
        const cy = Number.isFinite(sprite._placeY) ? sprite._placeY : (sprite.y - lift);
        const boxLeft = cx + box.left;
        const boxRight = cx + box.right;
        const boxTop = cy + box.top;
        const boxBottom = cy + box.bottom;
        const boxW = Math.max(1, boxRight - boxLeft);
        const boxH = Math.max(1, boxBottom - boxTop);
        const agentDepth = Number.isFinite(sprite._depthSortY) ? sprite._depthSortY : sprite.y;

        let pointHitMask = 0;
        let firstBuildingDrawable = null;
        for (let oi = 0; oi < occluders.length; oi++) {
            const occ = occluders[oi];
            if (!(occ.sortY > agentDepth)) continue;
            if (boxRight <= occ.left || boxLeft >= occ.right || boxBottom <= occ.top || boxTop >= occ.bottom) continue;
            let occHit = false;
            for (let yi = 0; yi < 3; yi++) {
                const py = boxTop + boxH * OCCLUSION_GRID_Y[yi];
                for (let xi = 0; xi < 3; xi++) {
                    const px = boxLeft + boxW * OCCLUSION_GRID_X[xi];
                    if (occluderPointOpaque(occ, px, py, agentDepth, sprites)) {
                        pointHitMask |= 1 << (yi * 3 + xi);
                        occHit = true;
                    }
                }
            }
            if (!occHit && sprite.selected) {
                // Selected villager: check top/bottom corners too so partial
                // overlap behind a roof gable still receives the masked x-ray.
                occHit = occluderPointOpaque(occ, boxLeft + boxW * 0.5, boxTop + boxH * 0.08, agentDepth, sprites)
                    || occluderPointOpaque(occ, boxLeft + boxW * 0.5, boxTop + boxH * 0.92, agentDepth, sprites)
                    || occluderPointOpaque(occ, boxLeft + boxW * 0.12, boxTop + boxH * 0.5, agentDepth, sprites)
                    || occluderPointOpaque(occ, boxLeft + boxW * 0.88, boxTop + boxH * 0.5, agentDepth, sprites);
            }
            if (!occHit) continue;
            let hitEntry = hitPool[hitCount];
            if (!hitEntry) {
                hitEntry = {
                    kind: '',
                    image: null,
                    dx: 0,
                    dy: 0,
                    w: 0,
                    h: 0,
                    rowStart: 0,
                    clipRanges: null,
                    drawable: null,
                    _ranges: [],
                    _rangePool: [],
                };
                hitPool[hitCount] = hitEntry;
            }
            const clipRanges = occluderClipRanges(
                occ,
                agentDepth,
                boxLeft - 24,
                boxRight + 24,
                hitEntry._ranges,
                hitEntry._rangePool,
            );
            if (clipRanges && !clipRanges.length) continue;
            hitEntry.kind = occ.kind;
            hitEntry.image = occ.image;
            hitEntry.dx = occ.dx;
            hitEntry.dy = occ.dy;
            hitEntry.w = occ.w;
            hitEntry.h = occ.h;
            hitEntry.rowStart = occ.rowStart || 0;
            hitEntry.clipRanges = clipRanges;
            hitEntry.drawable = occ.drawable;
            hits.push(hitEntry);
            hitCount++;
            if (!firstBuildingDrawable && occ.kind === 'building') {
                firstBuildingDrawable = occ.drawable;
            }
        }
        for (let i = hitCount; i < hitPool.length; i++) {
            hitPool[i].image = null;
            hitPool[i].drawable = null;
        }
        let coveredCount = 0;
        for (let bit = 0; bit < 9; bit++) {
            if (pointHitMask & (1 << bit)) coveredCount++;
        }
        const headAndChest = Boolean((pointHitMask & (1 << 1)) && (pointHitMask & (1 << 4)));
        const occluded = coveredCount >= 4 || headAndChest;
        sprite._occludedByWorld = occluded;
        sprite._behindBuilding = occluded || Boolean(sprite._splitBehindBuilding);
        sprite._behindBuildingDrawable = firstBuildingDrawable || sprite._splitBehindDrawable || null;
    }
    clearWorldOccluderScratch();
}

// 0.6 — on Canvas each live world particle joins the depth stream as a small
// drawable at its spawn sortY, so a building front or a nearer body covers
// it exactly as the resident depth test does. The wrappers are pooled per
// target and carry only what sorting, culling and painting read.
const _particlePools = new WeakMap();

function drawParticleDrawable(ctx, zoom, context) {
    this.payload?.draw?.(ctx, context?.particleMotionEnabled !== false);
}

function noGpuRecord() {
    return null;
}

function appendParticleDrawables(target, particles) {
    let pool = _particlePools.get(target);
    if (!pool) {
        pool = [];
        _particlePools.set(target, pool);
    }
    const count = particles?.length || 0;
    for (let index = 0; index < count; index++) {
        let drawable = pool[index];
        if (!drawable) {
            drawable = {
                kind: 'particle',
                sortY: 0,
                sortBand: KIND_ORDER.particle,
                stableKey: '',
                salience: 'ambient',
                materialId: 'material.default',
                materialClass: 'unlit',
                elevation: null,
                emissive: null,
                occluder: null,
                atlasFrame: null,
                hitArea: null,
                payload: null,
                draw: drawParticleDrawable,
                drawFallback: drawParticleDrawable,
                buildGpuRecord: noGpuRecord,
                gpuReady: false,
                sceneCategory: null,
                overlayBand: 0,
                sequence: 0,
            };
            pool[index] = drawable;
        }
        const particle = particles[index];
        drawable.sortY = finiteSortY(particle.sortY ?? particle.y);
        drawable.payload = particle;
        pushDepthDrawable(target, drawable);
    }
    for (let index = count; index < pool.length; index++) pool[index].payload = null;
}

function clearPooledDrawable(drawable) {
    drawable.kind = null;
    drawable.stableKey = '';
    drawable.hitArea = null;
    drawable.payload = null;
    drawable._drawFallback = null;
    drawable._gpuBuilder = null;
    drawable.sceneCategory = null;
    drawable.sceneNative = false;
    drawable.elevation = null;
    drawable.emissive = null;
    drawable.occluder = null;
    drawable.atlasFrame = null;
    drawable._material = null;
    drawable._materialSource = null;
    drawable._elevation = null;
    drawable._emissive = null;
    drawable._occluder = null;
    drawable._atlasFrame = null;
}

export function drawDepthSortedDrawables(ctx, drawables, context = {}) {
    const zoom = context.zoom || 1;
    const paintCounts = context.paintCounts;
    // On the resident path this context is the hidden pre-composite canvas
    // under the opaque GPU island. Scene categories render there as records
    // or replay once on the overlay (drawSceneCategoryOverlays).
    for (const drawable of drawables) {
        if (paintCounts) {
            paintCounts.lower[drawable.kind] ??= 0;
            paintCounts.upper[drawable.kind] ??= 0;
        }
        if (
            context.gpuWorldActive
            && (drawable.kind?.startsWith?.('building') || drawable.kind?.startsWith?.('prop'))
        ) {
            continue;
        }
        // A scene category on the resident path is either native (records)
        // or replayed on the overlay: never painted on this hidden canvas.
        if (context.gpuWorldActive && drawable.sceneCategory) continue;
        if (drawable.draw) {
            drawable.draw(ctx, zoom, context);
            if (paintCounts) paintCounts.lower[drawable.kind] += 1;
        }
    }
}

// Legacy selective-draw helper retained for non-category callers. Scene backend
// fallback must use drawSceneCategoryOverlays() so policy stays in the registry.
export function drawDepthSortedDrawableKinds(ctx, drawables, kinds, context = {}) {
    const accepted = kinds || [];
    if (!accepted.size && !accepted.length) return;
    const zoom = context.zoom || 1;
    for (const drawable of drawables || []) {
        if (accepted instanceof Set ? !accepted.has(drawable?.kind) : !accepted.includes(drawable?.kind)) continue;
        drawable.draw?.(ctx, zoom, context);
    }
}

// Replays only categories selected by the registry's backend-policy resolution.
// overlayBand orders whole categories on the ungraded transparent canvas; the
// canonical depth-pass order is retained within the same band.
export function drawSceneCategoryOverlays(ctx, drawables, resolution, context = {}) {
    const accepted = resolution?.overlayCategoryIds;
    if (!(accepted instanceof Set) || !accepted.size) return;
    const selected = _sceneOverlayBuffer;
    selected.length = 0;
    for (let index = 0; index < (drawables || []).length; index++) {
        const drawable = drawables[index];
        if (!drawable?.sceneCategory || !accepted.has(drawable.sceneCategory.id)) continue;
        selected.push(drawable);
    }
    selected.sort(compareOverlayBands);
    const zoom = context.zoom || 1;
    const paintCounts = context.paintCounts?.upper;
    // Categories read this to take the C2 grade themselves: nothing grades
    // this canvas after the draw, unlike the Canvas depth pass.
    context.ungradedOverlay = true;
    for (const drawable of selected) {
        if (drawable.draw) {
            drawable.draw(ctx, zoom, context);
            if (paintCounts) paintCounts[drawable.kind] = (paintCounts[drawable.kind] || 0) + 1;
        }
    }
}

const _sceneOverlayBuffer = [];

function compareOverlayBands(a, b) {
    return a.overlayBand - b.overlayBand;
}

// Converts the already-sorted stream without reordering painter semantics.
// Package 6 can batch only consecutive compatible records after this seam.
export function buildGpuRecordsFromDrawables(drawables, context = {}) {
    const records = [];
    for (let drawOrder = 0; drawOrder < (drawables || []).length; drawOrder++) {
        const drawable = drawables[drawOrder];
        const built = drawable?.buildGpuRecord?.(context);
        if (!built) continue;
        const candidates = Array.isArray(built) ? built : [built];
        for (const record of candidates) {
            if (!record) continue;
            records.push({
                kind: drawable.kind,
                sortY: drawable.sortY,
                sortBand: drawable.sortBand,
                stableKey: drawable.stableKey,
                salience: drawable.salience,
                materialId: drawable.materialId,
                materialClass: drawable.materialClass,
                elevation: drawable.elevation,
                emissive: drawable.emissive,
                occluder: drawable.occluder,
                atlasFrame: drawable.atlasFrame,
                ...record,
                drawOrder,
            });
        }
    }
    return records;
}

export function cullDepthSortedDrawables(drawables, camera, viewport, margin = 180, collectDiagnostics = true) {
    const rect = worldViewportRect(camera, viewport, margin, _viewportRect);
    if (!rect) {
        return collectDiagnostics
            ? { enabled: false, input: drawables.length, drawn: drawables.length, culled: 0 }
            : null;
    }

    let writeIndex = 0;
    const byKind = collectDiagnostics ? {} : null;
    for (let i = 0; i < drawables.length; i++) {
        const drawable = drawables[i];
        if (drawableVisibleInRect(drawable, rect)) {
            drawables[writeIndex++] = drawable;
            continue;
        }
        if (byKind) {
            const kind = drawable.kind || 'unknown';
            byKind[kind] = (byKind[kind] || 0) + 1;
        }
    }
    const input = drawables.length;
    drawables.length = writeIndex;
    return collectDiagnostics ? {
        enabled: true,
        input,
        drawn: writeIndex,
        culled: input - writeIndex,
        byKind,
    } : null;
}

export function summarizeDrawableLayers(drawables, culling = null) {
    const byKind = {};
    const byMaterial = {};
    let gpuReady = 0;
    let emissive = 0;
    let occluders = 0;
    for (const drawable of drawables || []) {
        const kind = drawable?.kind || 'unknown';
        byKind[kind] = (byKind[kind] || 0) + 1;
        const materialClass = drawable?.materialClass || 'unlit';
        byMaterial[materialClass] = (byMaterial[materialClass] || 0) + 1;
        if (drawable?.gpuReady) gpuReady++;
        if ((drawable?.emissive?.strength || 0) > 0) emissive++;
        if (drawable?.occluder?.mode && drawable.occluder.mode !== 'none') occluders++;
    }
    return {
        total: drawables?.length || 0,
        byKind,
        byMaterial,
        gpuReady,
        emissive,
        occluders,
        culling,
    };
}

function pushDepthDrawable(target, drawable) {
    drawable.sequence = target.length;
    drawable.sortBand = Number.isFinite(Number(drawable.sortBand))
        ? Number(drawable.sortBand)
        : KIND_ORDER[drawable.kind] ?? 50;
    target.push(drawable);
}

function compareDepthDrawables(a, b) {
    return (a.sortY - b.sortY)
        || (a.sortBand - b.sortBand)
        || String(a.kind || '').localeCompare(String(b.kind || ''))
        || String(a.stableKey || '').localeCompare(String(b.stableKey || ''))
        || ((a.sequence || 0) - (b.sequence || 0));
}

const _viewportRect = { left: 0, right: 0, top: 0, bottom: 0 };

function worldViewportRect(camera, viewport, margin, rect) {
    if (!camera || typeof camera.screenToWorld !== 'function' || !viewport?.width || !viewport?.height) return null;
    const a = camera.screenToWorld(-margin, -margin);
    const b = camera.screenToWorld(viewport.width + margin, viewport.height + margin);
    rect.left = Math.min(a.x, b.x);
    rect.right = Math.max(a.x, b.x);
    rect.top = Math.min(a.y, b.y);
    rect.bottom = Math.max(a.y, b.y);
    return rect;
}

function drawableVisibleInRect(drawable, rect) {
    const point = drawablePoint(drawable, _drawablePoint);
    if (!point) return true;
    const radius = drawableRadius(drawable);
    return point.x >= rect.left - radius
        && point.x <= rect.right + radius
        && point.y >= rect.top - radius
        && point.y <= rect.bottom + radius;
}

const _drawablePoint = { x: 0, y: 0 };

function drawablePoint(drawable, point) {
    const payload = drawable?.payload || drawable;
    if (Number.isFinite(Number(payload?.wx)) && Number.isFinite(Number(payload?.wy))) {
        point.x = Number(payload.wx);
        point.y = Number(payload.wy);
        return point;
    }
    if (Number.isFinite(Number(payload?.x)) && Number.isFinite(Number(payload?.y))) {
        point.x = Number(payload.x);
        point.y = Number(payload.y);
        return point;
    }
    if (Number.isFinite(Number(drawable?.x)) && Number.isFinite(Number(drawable?.y))) {
        point.x = Number(drawable.x);
        point.y = Number(drawable.y);
        return point;
    }
    if (Number.isFinite(Number(payload?.payload?.x)) && Number.isFinite(Number(payload?.payload?.y))) {
        point.x = Number(payload.payload.x);
        point.y = Number(payload.payload.y);
        return point;
    }
    return null;
}

function drawableRadius(drawable) {
    const kind = drawable?.kind || '';
    if (kind.startsWith('building')) return 260;
    if (kind === 'harbor-traffic' || kind === 'harbor-hulls') return 180;
    if (kind === 'agent') return 80;
    if (kind.includes('prop')) return 150;
    return 120;
}

function payloadStableKey(payload) {
    return payload?.id
        || payload?.entry?.id
        || payload?.building?.type
        || payload?.agent?.id
        || payload?.squadKey
        || payload?.payload?.id
        || payload?.payload?.squadKey
        || payload?.payload?.project
        || '';
}

function normalizeSalience(value) {
    return value === 'primary' || value === 'recent' || value === 'working'
        ? value
        : 'ambient';
}

function drawableMaterialSource(payload, semantics) {
    const entry = payload?.entry || payload?.sprite?.entry || null;
    return semantics?.material || payload?.material || entry || EMPTY_SEMANTICS;
}

function drawableMaterialId(payload, semantics, source) {
    const entry = payload?.entry || payload?.sprite?.entry || null;
    return semantics?.materialId
        || source.materialId
        || entry?.id
        || payload?.sprite?.id
        || payload?.id
        || 'material.default';
}

function drawableMaterialMetadata(payload, semantics, source, materialId) {
    return normalizeMaterialMetadata(source, {
        materialId,
        materialClass: semantics?.materialClass ?? source.materialClass,
        elevation: semantics?.elevation ?? source.elevation,
        emissive: semantics?.emissive ?? source.emissive,
        occluder: semantics?.occluder ?? source.occluder,
        atlasFrame: semantics?.atlasFrame ?? source.atlasFrame,
    });
}
