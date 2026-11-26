import * as palette from '../../config/artPalette.js';
import * as townPlan from '../../config/townPlan.js';
import * as scenery from '../../config/scenery.js';
import * as buildings from '../../config/buildings.js';
import * as grounding from '../../config/buildingGrounding.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import {
    GROUND_COLOR_TEXEL_W, GROUND_FIELD_TEXEL_W, captureGroundArtifact, groundWeatherLooksOn, restoreGroundArtifact, validGroundArtifact,
} from './GroundBake.js';
import { frostShadeKey } from './FrostMelt.js';
import { lookStrength } from './LookStrengths.js';
import { captureCoastArtifact, restoreCoastArtifact, validCoastArtifact, coastArtifactInputsSettled } from './CoastBake.js';

// Bump on ANY GroundBake, CoastBake or static terrain-pass pixel change.
// cv0.62-terrain-6: retires bakes stored without their sprite layers (CoastBake
// `paintCoast`'s settling read).
// cv0.62-terrain-8: the ground weather field's shelter and sun shade sit on
// the drawn building bases (GroundBake `buildSunOccluders`), its drying order
// leaning on the sun shade over the noise.
// cv0.64-terrain-9: snow under the open Task board (EY-3, the eaves' shelter
// share), the night's rising rime (EY-5), the contact AO of Command,
// Tavern and Forge on the authored plinth edges (EN-3) and rain under the
// open Task board.
// cv0.65-terrain-10: C-03 clustered water-tinted reflections, Harbor submerged
// pier pilings + foam meniscus collars, scalloped NW/NE back-shores and shingle.
// cv0.65-terrain-11: C-02 clustered seam-dithered meadow turf, guarded road &
// warm-limestone plaza ramps, varied paving (drift 0.32 / AO cap 0.68) with
// recessed plaza kerbs and Archive/Portal plinth AO, World Ash/woodland tree
// root contact AO, and 4-stop winter snow relief.
// cv0.65-terrain-12: C-01 CoastBake.withLampLayers skips `gate: 'lamps'`
// overlays (Pharos beacon) in daytime static reflection sheets while keeping
// night MIRROR_LAMP_GROUP accents.
// cv0.66-terrain-14: the visual overhaul — clearly blue daytime water ramps,
// wider depth bounds and the SE cliff corner return (CoastBake), meadow
// cluster passes and grass contrast, cooler roads and warmer plazas with
// kerbs, retired wattle and the baked Command watchfire/guardpost/ruins
// (GroundBake, IsometricRenderer), new roads, bridges and props.
// cv0.66-terrain-15: remove east Forge footbridge and its road, switch the
// north farm bridge to a mirrored plank span, move the Hourglass Belfry off
// the north bridge to the Archive's north-east lagoon lawn, remove cottages.
// cv0.66-terrain-16: calmer shallow water (shallowWater stops 0-1 at 25 %
// less chroma) and narrower DEPTH_BOUNDS 0.42..3.40 (CoastBake).
// visual-terrain-v3.1 (W1.1, X-5): the 1×1 colour-lattice ground bake —
// paving as stone units, 3 px kerbs, calm meadow sweeps, inline OA-T3
// stamps, E1 footings — so no stale 2×1 artifact ever restores.
// visual-terrain-v3.2 (W2.4): four-season turf ramps (grassDormant /
// grassSpring), autumn reeds/meadows, winter trampled avenue crowns, lagoon
// rim ice, and dawn dew sites — busting pre-Wave-2 saved terrain.
export const TERRAIN_BAKE_ALGORITHM_VERSION = 'visual-terrain-v3.2';
export const TERRAIN_ARTIFACT_DB = 'claudeville-terrain-artifacts';
// The ceiling of one entry, and (schema 3) of all stored entries together:
// at most ENTRY_LIMIT entries whose bytes sum to TERRAIN_ARTIFACT_AGGREGATE_BYTES.
export const TERRAIN_ARTIFACT_MAX_BYTES = 96 * 1024 * 1024;
export const TERRAIN_ARTIFACT_AGGREGATE_BYTES = 100_663_296;
// Artifact schema. 2: the ground field may carry the RGBA8 weather field
// (GroundWeatherField.js; only while a GW look reads it, keyed 'weather').
// 3: the artifact names the pitches its planes were baked at and the
// elevation / substrate contract revisions (`manifest`, also in the key),
// may carry the substrate planes under `coast.bake`, never the memoized
// coast texels. Older schemas fail validation, are purged and rebake.
export const TERRAIN_ARTIFACT_SCHEMA = 3;
const SCHEMA = TERRAIN_ARTIFACT_SCHEMA;
// v3 — the pitches (world px per stored texel along x) of the persisted
// planes: the ground colour (the terrain RGBA), the ground weather / puddle /
// class field, and the coast lattice.
export const TERRAIN_ARTIFACT_PITCH = Object.freeze({ groundPitch: GROUND_COLOR_TEXEL_W, weatherPitch: GROUND_FIELD_TEXEL_W, coastPitch: 2 });
// v3 — the elevation contract baked in ('e1': E1 bake-owned footings) and
// the substrate revision (0: legacy painted contact; 1: reconstructed
// contact, whose `coast.bake.exposure` / `contacts` planes are required).
export const TERRAIN_ELEVATION_REVISION = 'e1';
export const TERRAIN_SUBSTRATE_REVISION = 0;
// A failed write (quota, abort) holds persistence off this long: the frame
// keeps its in-memory terrain and never retries on every draw.
const WRITE_BACKOFF_MS = 5 * 60 * 1000;
// The IndexedDB version stays 1: its object stores never changed, and a
// version bump would rerun `onupgradeneeded` over the existing stores.
const DB_VERSION = 1;
const ENTRY_LIMIT = 2;
const TERRAIN_ID = /^(terrain\.|building\.|prop\.|veg\.|bridge\.|dock\.|village\.)/;
const encoder = new TextEncoder();

// Typed buffers are hashed as bytes, not expanded into multi-million-item JSON.
function contentTree(value, allowFunctions, pending) {
    if (value === undefined) return ['undefined'];
    if (typeof value === 'function') {
        if (!allowFunctions) throw new Error('Non-serializable terrain artifact');
        return ['function', String(value)];
    }
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const leaf = [value.constructor.name, value.byteLength, null];
        pending.push(sha256(bytes).then(hash => { leaf[2] = hash; }));
        return leaf;
    }
    if (value instanceof Set) return ['set', contentTree([...value], allowFunctions, pending)];
    if (value instanceof Map) return ['map', contentTree([...value], allowFunctions, pending)];
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) out.push(contentTree(item, allowFunctions, pending));
        return out;
    }
    if (value && typeof value === 'object') {
        const out = [];
        for (const key of Object.keys(value).sort()) out.push([key, contentTree(value[key], allowFunctions, pending)]);
        return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite terrain value');
    return value;
}

async function sha256(bytes) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function terrainContentHash(value, allowFunctions = false) {
    const pending = [];
    const tree = contentTree(value, allowFunctions, pending);
    await Promise.all(pending);
    return sha256(encoder.encode(JSON.stringify(tree)));
}

/** The v3 manifest a captured artifact carries (and its key names). */
export function terrainArtifactManifest({ elevationRevision = TERRAIN_ELEVATION_REVISION, substrateRevision = TERRAIN_SUBSTRATE_REVISION } = {}) {
    return { ...TERRAIN_ARTIFACT_PITCH, elevationRevision, substrateRevision };
}

export function terrainArtifactKey({ assetVersion, configHash, season, sceneryRevision, snowBucket, frost, bounds, dpr,
    algorithmVersion = TERRAIN_BAKE_ALGORITHM_VERSION, phenology, frostPatches = lookStrength('gw3'),
    groundWeather = groundWeatherLooksOn(frost), frostRising = false,
    elevationRevision = TERRAIN_ELEVATION_REVISION, substrateRevision = TERRAIN_SUBSTRATE_REVISION }) {
    // BI-2 — `phenology`: the woods' weekly stage id (SeasonalAmbience
    // PHENOLOGY_STAGES; the litter and the water reflections follow it).
    // GW-3 — `frostPatches`: the frost-patch look's strength, keyed only
    // when a frost is baked in.
    if (typeof phenology !== 'string' || !phenology) return null;
    if (!assetVersion || !configHash || !['spring', 'summer', 'autumn', 'winter'].includes(season)
        || !Number.isInteger(sceneryRevision) || sceneryRevision < 0
        || !Number.isInteger(snowBucket) || snowBucket < 0 || snowBucket > 4
        || !Number.isInteger(frost) || frost < 0 || frost > 4 || !algorithmVersion || !Number.isFinite(dpr) || dpr <= 0
        || !bounds || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(bounds[k])) || bounds.w <= 0 || bounds.h <= 0
        || typeof elevationRevision !== 'string' || !elevationRevision || (substrateRevision !== 0 && substrateRevision !== 1)) return null;
    // v3 — the manifest's pitches and revisions sit right after the
    // algorithm (manifestMatchesKey reads them back).
    const P = TERRAIN_ARTIFACT_PITCH;
    const key = [SCHEMA, algorithmVersion, 'pitch', P.groundPitch, P.weatherPitch, P.coastPitch, elevationRevision, substrateRevision,
        String(assetVersion), configHash, season, sceneryRevision, snowBucket, frost,
        bounds.x, bounds.y, bounds.w, bounds.h, dpr, phenology, frost > 0 ? frostPatches : 0];
    // EY-5 — the night's rising rime (quarters 1–3) bakes apart from the melt.
    const rising = frostRising === true && frost > 0 && frost < 4;
    if (rising) key.push('rising');
    // SD-1 — a melting frost baked in the sundial's shade (FrostMelt
    // `frostShadeKey`); nothing is added with the look off, so today's keys hold.
    const shade = rising ? '' : frostShadeKey(frost);
    if (shade) key.push(shade);
    // GW-1 / GW-2 / GW-3 — a bake that carries the ground weather field
    // (any of its looks on); nothing is added at looks 0.
    if (groundWeather) key.push('weather');
    return JSON.stringify(key);
}

export function terrainArtifactInputsSettled(renderer) {
    const assets = renderer.assets;
    if (!assets?.assetVersion || !assets.manifest || !assets._decodedLoaded || assets._suspended || assets._disposed
        || (assets._materialAssetsEnabled && !assets._materialDecodedLoaded)) return false;
    // Decode commits happen only after eager non-character sheets/layers settle.
    // A missing/evicted required source is not a different persistent key.
    for (const [id] of assets._entryById || []) {
        if (TERRAIN_ID.test(id) && !assets.has(id, { request: false })) return false;
    }
    for (const key of assets._evictedOptionalEntries?.keys?.() || []) {
        if (!key.startsWith('companion:') || TERRAIN_ID.test(key.split(':').slice(2).join(':'))) return false;
    }
    if (assets._optionalReloads?.size) return false;
    if (assets._optionalLoadMisses?.some(miss => TERRAIN_ID.test(miss.id)) || !coastArtifactInputsSettled(renderer)) return false;
    const passes = renderer._terrainBakePasses;
    return passes?.length === 3 && passes[0].id === 'ground-splat' && passes[1].id === 'coast-field' && passes[2].id === 'coast-reflections';
}

export function terrainArtifactConfiguration(renderer) {
    const manifest = renderer.assets?.manifest;
    const scene = {};
    for (const key of ['terrainSeed', 'waterTiles', 'shoreTiles', 'wetShoreTiles', 'deepWaterTiles', 'lagoonWaterTiles', 'waterMeta',
        'harborWaterApronTiles', 'bridgeTiles', 'pathTiles', 'townSquareTiles', 'mainAvenueTiles', 'dirtPathTiles',
        'commandCenterRoadTiles', 'yardTiles', 'yardClearTiles', 'frontageSpurs', 'featureTiles', 'bushTiles', 'grassTuftTiles', 'flowerTiles',
        'bridgeSpans']) {
        scene[key] = renderer[key];
    }
    scene.avenueTiles = renderer.avenueTiles instanceof Set ? [...renderer.avenueTiles].sort() : null;
    scene.buildings = [...renderer.world?.buildings || []].map(([id, building]) => [id, {
        type: building.type, position: { tileX: building.position.tileX, tileY: building.position.tileY },
        width: building.width, height: building.height, entrance: building.entrance, district: building.district,
        visitTiles: building.visitTiles, walkExclusion: building.walkExclusion, scenery: building.scenery,
    }]);
    scene.props = (renderer._staticPropSprites || []).map(prop => ({ id: prop.id, tileX: prop.tileX, tileY: prop.tileY,
        x: prop.x, y: prop.y, tree: prop.tree, bounds: prop.bounds }));
    // Ground textures, sprite dimensions/anchors, seasonal vegetation, bridges,
    // fixture layers and emissive atlas fallbacks all reach the static passes.
    // Characters/equipment/accessories/statusOverlays are actor-only;
    // atmosphere and luts paint/grade after the bake, never into its fields.
    // Atlas metadata is included because its frame rectangles locate emissive
    // reflection samples; assetVersion covers the referenced PNG bytes.
    return { palette, townPlan, scenery, buildings, grounding, geometry: { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT }, scene,
        manifest: { style: manifest?.style, materialContract: manifest?.materialContract, atlases: manifest?.atlases,
            buildings: manifest?.buildings, props: manifest?.props, vegetation: manifest?.vegetation,
            terrain: manifest?.terrain, bridges: manifest?.bridges },
        atlasMetadata: renderer.assets?.atlasMetadata };
}

export function captureTerrainArtifactFields(renderer) {
    const ground = captureGroundArtifact(renderer);
    const coast = captureCoastArtifact(renderer);
    if (!ground || !coast) return null;
    // v3 — the memoized coast texture (coastFieldTexels) is never persisted:
    // it is rebuilt from coastField / mirrorStops at upload.
    if (coast.bake?.coast) delete coast.bake.coast.contactFoot;
    const water = coast.bake?.waterFields;
    if (water?.texels !== undefined) {
        const { texels, ...rest } = water;
        coast.bake = { ...coast.bake, waterFields: rest };
    }
    return { ground, coast };
}

export function captureTerrainArtifact(canvas, bounds, dpr, fields, manifest = terrainArtifactManifest({ substrateRevision: fields?.coast?.bake?.exposure ? 1 : 0 })) {
    if (!fields || !canvas?.width || !canvas.height) return null;
    return { schema: SCHEMA, manifest: { ...manifest }, bounds: { ...bounds }, dpr, width: canvas.width, height: canvas.height,
        rgba: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, ...fields };
}

function validManifest(manifest) {
    const P = TERRAIN_ARTIFACT_PITCH;
    return Boolean(manifest) && manifest.groundPitch === P.groundPitch && manifest.weatherPitch === P.weatherPitch
        && manifest.coastPitch === P.coastPitch && typeof manifest.elevationRevision === 'string' && manifest.elevationRevision.length > 0
        && (manifest.substrateRevision === 0 || manifest.substrateRevision === 1);
}

// v3 substrate planes under `coast.bake`. Revision 0 omits both. Revision 1
// requires `exposure` (one byte per coast cell; low nibble = the exposed
// water quarter-pixels, bit (x & 1) + 2·(y & 1) in coast-local px) and
// `contacts` (8-byte records: LE u32 coast-local px index
// y·(2·cols) + x, straight sRGB R, G, B, coverage 1–255), strictly
// ascending, in range and only on exposed water; an empty coast has both
// planes empty.
export function validTerrainSubstrate(manifest, coastArtifact) {
    const bake = coastArtifact?.bake;
    const exposure = bake?.exposure;
    const contacts = bake?.contacts;
    if (manifest?.substrateRevision !== 1) return exposure === undefined && contacts === undefined;
    const coast = bake?.coast;
    const cells = coast ? coast.cols * coast.rows : 0;
    if (!(exposure instanceof Uint8Array) || exposure.length !== cells
        || !(contacts instanceof Uint8Array) || contacts.length % 8 !== 0) return false;
    if (exposure.some(byte => byte > 15)) return false;
    if (!coast) return contacts.length === 0;
    const stride = coast.cols * 2;
    const limit = stride * coast.rows * 2;
    let last = -1;
    for (let o = 0; o < contacts.length; o += 8) {
        const at = (contacts[o] | (contacts[o + 1] << 8) | (contacts[o + 2] << 16) | (contacts[o + 3] << 24)) >>> 0;
        if (at <= last || at >= limit || contacts[o + 7] === 0) return false;
        const x = at % stride;
        const y = (at - x) / stride;
        if (!(exposure[(y >> 1) * coast.cols + (x >> 1)] & (1 << ((x & 1) + 2 * (y & 1))))) return false;
        last = at;
    }
    return true;
}

export function validTerrainArtifact(artifact) {
    return artifact?.schema === SCHEMA && validManifest(artifact.manifest)
        && Number.isInteger(artifact.width) && Number.isInteger(artifact.height)
        && artifact.width > 0 && artifact.height > 0 && artifact.width * artifact.height <= 7_000_000
        && Number.isFinite(artifact.dpr) && artifact.dpr > 0
        && artifact.bounds && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(artifact.bounds[key]))
        && artifact.bounds.w > 0 && artifact.bounds.h > 0
        && artifact.width === Math.max(1, Math.round(artifact.bounds.w * artifact.dpr))
        && artifact.height === Math.max(1, Math.round(artifact.bounds.h * artifact.dpr))
        && artifact.rgba instanceof Uint8ClampedArray && artifact.rgba.length === artifact.width * artifact.height * 4
        && validGroundArtifact(artifact.ground) && validCoastArtifact(artifact.coast)
        && artifact.coast.bake?.coast?.contactFoot === undefined
        && artifact.coast.bake?.waterFields?.texels === undefined
        && validTerrainSubstrate(artifact.manifest, artifact.coast);
}

export function restoreTerrainArtifact(renderer, artifact) {
    if (!validTerrainArtifact(artifact)) throw new Error('Invalid terrain artifact');
    const restored = { world: renderer.world };
    // Resolve every building before publishing any semantic state.
    restoreCoastArtifact(restored, artifact.coast);
    restoreGroundArtifact(restored, artifact.ground);
    const canvas = document.createElement('canvas');
    try {
        canvas.width = artifact.width;
        canvas.height = artifact.height;
        canvas.getContext('2d').putImageData(new ImageData(artifact.rgba, artifact.width, artifact.height), 0, 0);
        Object.assign(renderer, restored);
        return canvas;
    } catch (error) {
        canvas.width = canvas.height = 0;
        throw error;
    }
}

// GW — a saved bake holds the ground weather field exactly when its key says
// 'weather' (the key is backend-aware: IsometricRenderer passes
// GroundBake.groundWeatherWanted). A mismatch is never saved and never
// restored: it is deleted and the frame rebakes.
export function weatherMatchesKey(key, artifact) {
    let parts;
    try { parts = JSON.parse(key); } catch { return true; }
    if (!Array.isArray(parts)) return true;
    return parts.includes('weather') === Boolean(artifact?.ground?.field?.weather);
}

// v3 — an artifact is restored only under the key that names its manifest
// (pitches and revisions); a key that is not a v3 key array is not checked.
export function manifestMatchesKey(key, artifact) {
    let parts;
    try { parts = JSON.parse(key); } catch { return true; }
    if (!Array.isArray(parts) || parts[2] !== 'pitch') return true;
    const m = artifact?.manifest;
    return Boolean(m) && parts[3] === m.groundPitch && parts[4] === m.weatherPitch && parts[5] === m.coastPitch
        && parts[6] === m.elevationRevision && parts[7] === m.substrateRevision;
}

function artifactBytes(value) {
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + artifactBytes(item), 0);
    return typeof value === 'string' ? value.length * 2 : 8;
}

function requested(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function committed(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
}

// A stored LRU row: { key, used, bytes, schema }. A row without its exact
// byte size or of another schema is stale: purged in the next write's own
// transaction and never prefetched.
const liveRow = (row, limit) => typeof row?.key === 'string' && Number.isFinite(row.used)
    && row.schema === SCHEMA && Number.isFinite(row.bytes) && row.bytes > 0 && row.bytes <= limit;

export class TerrainArtifactStore {
    // `entryBytes` / `aggregateBytes`: the per-entry and all-entries ceilings
    // (the constants by default; tests narrow them). `storage`: the
    // StorageManager whose estimate is an advisory preflight.
    constructor({ indexedDB = globalThis.indexedDB, name = TERRAIN_ARTIFACT_DB, storage = globalThis.navigator?.storage,
        entryBytes = TERRAIN_ARTIFACT_MAX_BYTES, aggregateBytes = TERRAIN_ARTIFACT_AGGREGATE_BYTES, now = () => Date.now() } = {}) {
        this.indexedDB = indexedDB;
        this.name = name;
        this.storage = storage;
        this.entryBytes = entryBytes;
        this.aggregateBytes = aggregateBytes;
        this._now = now;
        this._opening = null;
        this._writeBlockedUntil = 0;
    }

    _open() {
        if (!this.indexedDB || !globalThis.crypto?.subtle) return Promise.resolve(null);
        if (this._opening) return this._opening;
        this._opening = new Promise(resolve => {
            let settled = false;
            const finish = db => {
                if (settled) { db?.close(); return; }
                settled = true;
                clearTimeout(timer);
                resolve(db);
            };
            const timer = setTimeout(() => finish(null), 1500);
            try {
                const request = this.indexedDB.open(this.name, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    db.createObjectStore('artifacts');
                    db.createObjectStore('lru', { keyPath: 'key' });
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => { db.close(); this._opening = null; };
                    finish(db);
                };
                request.onerror = () => finish(null);
            } catch { finish(null); }
        });
        return this._opening;
    }

    async delete(key) {
        try {
            const db = await this._open();
            if (!db) return false;
            const tx = db.transaction(['artifacts', 'lru'], 'readwrite');
            const done = committed(tx);
            tx.objectStore('artifacts').delete(key);
            tx.objectStore('lru').delete(key);
            return await done;
        } catch { return false; }
    }

    // Read ahead before assets or the frame's season/snow inputs are known.
    // Keep this unverified candidate out of rendering; get checks the exact
    // settled key before digesting its large typed fields. Only a live row
    // (this schema, its exact size within the budget) is a candidate.
    async prefetchLatest() {
        try {
            const db = await this._open();
            if (!db) return null;
            const rows = await requested(db.transaction('lru', 'readonly').objectStore('lru').getAll());
            const newest = rows.filter(row => liveRow(row, this.entryBytes)).sort((a, b) => b.used - a.used)[0];
            if (!newest) return null;
            const entry = await requested(db.transaction('artifacts', 'readonly').objectStore('artifacts').get(newest.key));
            if (!entry || !Number.isFinite(entry.bytes) || entry.bytes > this.entryBytes || entry.bytes !== newest.bytes
                || !validTerrainArtifact(entry.artifact) || artifactBytes(entry.artifact) !== entry.bytes) {
                await this.delete(newest.key);
                return null;
            }
            return { key: newest.key, entry };
        } catch { return null; }
    }

    async get(key, prefetched = null) {
        if (!key) return null;
        try {
            const db = await this._open();
            if (!db) return null;
            const entry = prefetched?.key === key ? prefetched.entry
                : await requested(db.transaction('artifacts', 'readonly').objectStore('artifacts').get(key));
            if (!entry) { await this.delete(key); return null; }
            if (!Number.isFinite(entry.bytes) || entry.bytes > this.entryBytes || !validTerrainArtifact(entry.artifact)
                || !weatherMatchesKey(key, entry.artifact) || !manifestMatchesKey(key, entry.artifact)
                || artifactBytes(entry.artifact) !== entry.bytes || await terrainContentHash(entry.artifact) !== entry.checksum) {
                await this.delete(key);
                return null;
            }
            const tx = db.transaction('lru', 'readwrite');
            const done = committed(tx);
            const lru = tx.objectStore('lru');
            lru.getAll().onsuccess = event => {
                const rows = event.target.result;
                if (!rows.some(row => row.key === key)) return;
                const used = Math.max(this._now(), ...rows.map(row => row.used).filter(Number.isFinite)) + 1;
                lru.put({ key, used, bytes: entry.bytes, schema: SCHEMA });
            };
            await done;
            return entry.artifact;
        } catch { await this.delete(key); return null; }
    }

    // Advisory preflight: refuse only when the origin's quota could not hold
    // the candidate even after this store gave back its whole budget.
    async _quotaAllows(bytes) {
        if (typeof this.storage?.estimate !== 'function') return true;
        try {
            const { quota, usage } = await this.storage.estimate();
            if (!Number.isFinite(quota) || !Number.isFinite(usage)) return true;
            return quota - usage + this.aggregateBytes >= bytes;
        } catch { return true; }
    }

    // One readwrite transaction: write the candidate, purge stale rows
    // (another schema, no exact size), then walk the live rows newest first
    // and keep them only while both the entry count and the cumulative bytes
    // (candidate included) stay within budget; everything older goes. An
    // oversized candidate is refused before the transaction, so it never
    // costs the last usable entry. A quota failure or abort keeps the frame's
    // in-memory terrain and holds writes off for WRITE_BACKOFF_MS.
    async put(key, artifact, canWrite = () => true) {
        if (!key || !canWrite() || this._now() < this._writeBlockedUntil) return false;
        try {
            const db = await this._open();
            if (!db || !canWrite()) return false;
            if (!validTerrainArtifact(artifact) || !weatherMatchesKey(key, artifact) || !manifestMatchesKey(key, artifact)) {
                await this.delete(key);
                return false;
            }
            const bytes = artifactBytes(artifact);
            if (bytes > this.entryBytes || bytes > this.aggregateBytes) return false;
            if (!await this._quotaAllows(bytes)) return false;
            const checksum = await terrainContentHash(artifact);
            if (!canWrite()) return false;
            const tx = db.transaction(['artifacts', 'lru'], 'readwrite');
            const done = committed(tx);
            const records = tx.objectStore('artifacts');
            const lru = tx.objectStore('lru');
            let written = false;
            lru.getAll().onsuccess = event => {
                if (!canWrite()) { tx.abort(); return; }
                const rows = event.target.result;
                const used = Math.max(this._now(), ...rows.map(row => row.used).filter(Number.isFinite)) + 1;
                records.put({ artifact, bytes, checksum, schema: SCHEMA }, key);
                lru.put({ key, used, bytes, schema: SCHEMA });
                const live = [];
                for (const row of rows) {
                    if (row.key === key) continue;
                    if (liveRow(row, this.entryBytes)) live.push(row);
                    else { records.delete(row.key); lru.delete(row.key); }
                }
                live.sort((a, b) => b.used - a.used);
                let count = 1;
                let total = bytes;
                let open = true;
                for (const row of live) {
                    if (open && count < ENTRY_LIMIT && total + row.bytes <= this.aggregateBytes) {
                        count++;
                        total += row.bytes;
                        continue;
                    }
                    open = false;
                    records.delete(row.key);
                    lru.delete(row.key);
                }
                written = true;
            };
            await done;
            return written;
        } catch {
            this._writeBlockedUntil = this._now() + WRITE_BACKOFF_MS;
            return false;
        }
    }

    // The stored entries' LRU rows (diagnostics and tests).
    async rows() {
        try {
            const db = await this._open();
            if (!db) return [];
            return await requested(db.transaction('lru', 'readonly').objectStore('lru').getAll());
        } catch { return []; }
    }
}
