import * as palette from '../../config/artPalette.js';
import * as townPlan from '../../config/townPlan.js';
import * as scenery from '../../config/scenery.js';
import * as buildings from '../../config/buildings.js';
import * as grounding from '../../config/buildingGrounding.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { captureGroundArtifact, groundWeatherLooksOn, restoreGroundArtifact, validGroundArtifact } from './GroundBake.js';
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
// share), the night's rising rime (EY-5) and the contact AO of Command,
// Tavern and Forge seated at the painted plinth (EN-3).
export const TERRAIN_BAKE_ALGORITHM_VERSION = 'cv0.64-terrain-9';
export const TERRAIN_ARTIFACT_DB = 'claudeville-terrain-artifacts';
export const TERRAIN_ARTIFACT_MAX_BYTES = 96 * 1024 * 1024;
// Artifact schema. 2: the ground field may carry the RGBA8 weather field
// (GroundWeatherField.js; only while a GW look reads it, keyed 'weather');
// a schema-1 artifact fails validation and rebakes.
const SCHEMA = 2;
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

export function terrainArtifactKey({ assetVersion, configHash, season, sceneryRevision, snowBucket, frost, bounds, dpr,
    algorithmVersion = TERRAIN_BAKE_ALGORITHM_VERSION, phenology, frostPatches = lookStrength('gw3'),
    groundWeather = groundWeatherLooksOn(frost), frostRising = false }) {
    // BI-2 — `phenology`: the woods' weekly stage id (SeasonalAmbience
    // PHENOLOGY_STAGES; the litter and the water reflections follow it).
    // GW-3 — `frostPatches`: the frost-patch look's strength, keyed only
    // when a frost is baked in.
    if (typeof phenology !== 'string' || !phenology) return null;
    if (!assetVersion || !configHash || !['spring', 'summer', 'autumn', 'winter'].includes(season)
        || !Number.isInteger(sceneryRevision) || sceneryRevision < 0
        || !Number.isInteger(snowBucket) || snowBucket < 0 || snowBucket > 4
        || !Number.isInteger(frost) || frost < 0 || frost > 4 || !algorithmVersion || !Number.isFinite(dpr) || dpr <= 0
        || !bounds || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(bounds[k])) || bounds.w <= 0 || bounds.h <= 0) return null;
    const key = [SCHEMA, algorithmVersion, String(assetVersion), configHash, season, sceneryRevision, snowBucket, frost,
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
        'bridgeSpans', 'commandCenterGroundProps']) {
        scene[key] = renderer[key];
    }
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
    return ground && coast ? { ground, coast } : null;
}

export function captureTerrainArtifact(canvas, bounds, dpr, fields) {
    if (!fields || !canvas?.width || !canvas.height) return null;
    return { schema: SCHEMA, bounds: { ...bounds }, dpr, width: canvas.width, height: canvas.height,
        rgba: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, ...fields };
}

export function validTerrainArtifact(artifact) {
    return artifact?.schema === SCHEMA && Number.isInteger(artifact.width) && Number.isInteger(artifact.height)
        && artifact.width > 0 && artifact.height > 0 && artifact.width * artifact.height <= 7_000_000
        && Number.isFinite(artifact.dpr) && artifact.dpr > 0
        && artifact.bounds && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(artifact.bounds[key]))
        && artifact.bounds.w > 0 && artifact.bounds.h > 0
        && artifact.width === Math.max(1, Math.round(artifact.bounds.w * artifact.dpr))
        && artifact.height === Math.max(1, Math.round(artifact.bounds.h * artifact.dpr))
        && artifact.rgba instanceof Uint8ClampedArray && artifact.rgba.length === artifact.width * artifact.height * 4
        && validGroundArtifact(artifact.ground) && validCoastArtifact(artifact.coast);
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

export class TerrainArtifactStore {
    constructor({ indexedDB = globalThis.indexedDB, name = TERRAIN_ARTIFACT_DB } = {}) {
        this.indexedDB = indexedDB;
        this.name = name;
        this._opening = null;
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
    // settled key before digesting its large typed fields.
    async prefetchLatest() {
        try {
            const db = await this._open();
            if (!db) return null;
            const rows = await requested(db.transaction('lru', 'readonly').objectStore('lru').getAll());
            const newest = rows.filter(row => typeof row.key === 'string' && Number.isFinite(row.used))
                .sort((a, b) => b.used - a.used)[0];
            if (!newest) return null;
            const entry = await requested(db.transaction('artifacts', 'readonly').objectStore('artifacts').get(newest.key));
            if (!entry || !Number.isFinite(entry.bytes) || entry.bytes > TERRAIN_ARTIFACT_MAX_BYTES
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
            if (!Number.isFinite(entry.bytes) || entry.bytes > TERRAIN_ARTIFACT_MAX_BYTES || !validTerrainArtifact(entry.artifact)
                || !weatherMatchesKey(key, entry.artifact)
                || artifactBytes(entry.artifact) !== entry.bytes || await terrainContentHash(entry.artifact) !== entry.checksum) {
                await this.delete(key);
                return null;
            }
            const tx = db.transaction('lru', 'readwrite');
            const done = committed(tx);
            const lru = tx.objectStore('lru');
            lru.getAll().onsuccess = event => {
                const rows = event.target.result;
                if (rows.some(row => row.key === key)) lru.put({ key, used: Math.max(Date.now(), ...rows.map(row => row.used)) + 1 });
            };
            await done;
            return entry.artifact;
        } catch { await this.delete(key); return null; }
    }

    async put(key, artifact, canWrite = () => true) {
        if (!key || !canWrite()) return false;
        try {
            const db = await this._open();
            if (!db || !canWrite()) return false;
            if (!validTerrainArtifact(artifact) || !weatherMatchesKey(key, artifact)) { await this.delete(key); return false; }
            const bytes = artifactBytes(artifact);
            if (bytes > TERRAIN_ARTIFACT_MAX_BYTES) { await this.delete(key); return false; }
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
                const used = Math.max(Date.now(), ...rows.map(row => row.used)) + 1;
                const newest = { key, used };
                records.put({ artifact, bytes, checksum }, key);
                lru.put(newest);
                const ordered = [...rows.filter(row => row.key !== key), newest].sort((a, b) => b.used - a.used);
                for (const row of ordered.slice(ENTRY_LIMIT)) { records.delete(row.key); lru.delete(row.key); }
                written = true;
            };
            await done;
            return written;
        } catch { return false; }
    }
}
