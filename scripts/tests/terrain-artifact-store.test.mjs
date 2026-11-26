import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { getCoastField, captureCoastArtifact } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    TERRAIN_ARTIFACT_AGGREGATE_BYTES, TERRAIN_ARTIFACT_MAX_BYTES, TERRAIN_ARTIFACT_PITCH, TERRAIN_ARTIFACT_SCHEMA, TERRAIN_BAKE_ALGORITHM_VERSION,
    TerrainArtifactStore, captureTerrainArtifactFields, manifestMatchesKey, terrainArtifactKey, terrainArtifactManifest, validTerrainArtifact,
} from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';

// Requests deliver asynchronously; writes enqueued from onsuccess remain in
// the same transaction, and oncomplete runs only after every request settles.
function fakeIndexedDB({ omitGetAllSuccess = false } = {}) {
    const databases = new Map();
    return {
        records(name, store) { return databases.get(name).stores.get(store); },
        open(name) {
            const request = {};
            queueMicrotask(() => {
                const fresh = !databases.has(name);
                if (fresh) databases.set(name, { stores: new Map() });
                const state = databases.get(name);
                request.result = {
                    close() {},
                    createObjectStore(id, options = {}) { state.stores.set(id, new Map()); state[id] = options; },
                    transaction(ids, mode = 'readonly') {
                        ids = Array.isArray(ids) ? ids : [ids];
                        const working = new Map(ids.map(id => [id, mode === 'readwrite'
                            ? new Map(state.stores.get(id)) : state.stores.get(id)]));
                        let pending = 0;
                        let finished = false;
                        const tx = {};
                        const complete = () => setImmediate(() => {
                            if (pending || finished) return;
                            finished = true;
                            if (mode === 'readwrite') for (const [id, rows] of working) state.stores.set(id, rows);
                            tx.oncomplete?.();
                        });
                        const enqueue = (operation, deliver = true) => {
                            const req = {};
                            pending++;
                            queueMicrotask(() => {
                                try {
                                    req.result = structuredClone(operation());
                                    if (deliver) req.onsuccess?.({ target: req });
                                } catch (error) {
                                    req.error = tx.error = error;
                                    req.onerror?.({ target: req });
                                    finished = true;
                                    tx.onabort?.();
                                } finally { pending--; complete(); }
                            });
                            return req;
                        };
                        tx.objectStore = id => {
                            const rows = working.get(id);
                            return {
                                get: key => enqueue(() => rows.get(key)),
                                getAll: () => enqueue(() => [...rows.values()], !omitGetAllSuccess),
                                put: (value, key = value[state[id]?.keyPath]) => enqueue(() => {
                                    rows.set(key, structuredClone(value));
                                    return key;
                                }),
                                delete: key => enqueue(() => { rows.delete(key); }),
                            };
                        };
                        complete();
                        return tx;
                    },
                };
                if (fresh) request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
}

function artifactFixture(value = 17) {
    const w = MAP_SIZE * TILE_WIDTH;
    const h = MAP_SIZE * TILE_HEIGHT;
    const count = w / 2 * h;
    const source = { world: { buildings: new Map() }, waterTiles: new Set() };
    const field = getCoastField(source);
    source._coastBake = { key: field.key, fieldMs: field.buildMs, bakeMs: 1, coast: null, waterFields: null };
    return { schema: TERRAIN_ARTIFACT_SCHEMA, manifest: terrainArtifactManifest(), bounds: { x: 0, y: 0, w: 2, h: 2 }, dpr: 1, width: 2, height: 2,
        rgba: new Uint8ClampedArray([value, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
        ground: { field: { bounds: { x: -w / 2, y: -TILE_HEIGHT / 2, w, h }, cols: w / 2, rows: h, texelW: 2,
            classes: new Uint8Array(count),
            weather: { data: new Uint8Array(count * 4), cols: w / 2, rows: h, x0: -w / 2, y0: -TILE_HEIGHT / 2, texelW: 2 } }, puddleMask: { data: new Uint8Array(count), cols: w / 2, rows: h,
            x0: -w / 2, y0: -TILE_HEIGHT / 2, texelW: 2, revision: 'ground' }, groundBakeMs: 3 },
        coast: captureCoastArtifact(source) };
}

function fixture(options, storeOptions = {}) {
    const indexedDB = fakeIndexedDB(options);
    const name = 'terrain-test';
    return { indexedDB, name, store: new TerrainArtifactStore({ indexedDB, name, storage: null, ...storeOptions }) };
}

test('store round trip preserves RGBA and every semantic field', async () => {
    const { store } = fixture();
    const artifact = artifactFixture();
    artifact.ground.field.classes[19] = 4;
    artifact.ground.puddleMask.data[21] = 231;
    assert.equal(await store.put('summer', artifact), true);
    const restored = await store.get('summer');
    assert.deepEqual(restored, artifact);
    restored.rgba[0] = 99;
    assert.equal((await store.get('summer')).rgba[0], 17, 'readers cannot mutate persisted bytes');
});

test('third entry evicts the least recently read entry, not the oldest write', async () => {
    const { store, indexedDB, name } = fixture();
    assert.equal(await store.put('a', artifactFixture(1)), true);
    assert.equal(await store.put('b', artifactFixture(2)), true);
    assert.equal((await store.get('a')).rgba[0], 1);
    assert.equal(await store.put('c', artifactFixture(3)), true);
    assert.equal(await store.get('b'), null);
    assert.equal((await store.get('a')).rgba[0], 1);
    assert.equal((await store.get('c')).rgba[0], 3);
    assert.equal(indexedDB.records(name, 'artifacts').size, 2);
    assert.equal(indexedDB.records(name, 'lru').size, 2);
});

for (const [label, corrupt] of [
    ['RGBA byte', entry => { entry.artifact.rgba[0] ^= 1; }],
    ['semantic byte', entry => { entry.artifact.ground.puddleMask.data[4] ^= 1; }],
    ['missing field', entry => { delete entry.artifact.ground.puddleMask; }],
    ['weather byte', entry => { entry.artifact.ground.field.weather.data[7] ^= 1; }],
    ['schema-1 artifact without its weather field', entry => { entry.artifact.schema = 1; delete entry.artifact.ground.field.weather; }],
    ['schema-2 artifact without its v3 manifest', entry => { entry.artifact.schema = 2; delete entry.artifact.manifest; }],
    ['2×1 ground pitch', entry => { entry.artifact.manifest.groundPitch = 2; }],
    ['oversize entry', entry => { entry.bytes = TERRAIN_ARTIFACT_MAX_BYTES + 1; }],
]) {
    test(`${label} is rejected and deleted together with its LRU row`, async () => {
        const { store, indexedDB, name } = fixture();
        assert.equal(await store.put('bad', artifactFixture()), true);
        corrupt(indexedDB.records(name, 'artifacts').get('bad'));
        assert.equal(await store.get('bad'), null);
        assert.equal(indexedDB.records(name, 'artifacts').has('bad'), false);
        assert.equal(indexedDB.records(name, 'lru').has('bad'), false);
    });
}

test('early candidate is the most recent LRU entry and only the exact requested key can consume it', async () => {
    const { store } = fixture();
    assert.equal(await store.put('summer', artifactFixture(1)), true);
    assert.equal(await store.put('winter', artifactFixture(2)), true);
    await store.get('summer');
    const candidate = await store.prefetchLatest();
    assert.equal(candidate.key, 'summer');
    assert.equal((await store.get('summer', candidate)).rgba[0], 1);
    const unrelated = { key: 'wrong', get entry() { throw new Error('mismatched candidate was inspected'); } };
    assert.equal(await store.get('missing', unrelated), null);
    assert.equal((await store.get('winter', candidate)).rgba[0], 2, 'the other stored key remains available');
});

test('put is false when IndexedDB is unavailable', async () => {
    const store = new TerrainArtifactStore({ indexedDB: null });
    assert.equal(await store.put('terrain', artifactFixture()), false);
    assert.equal(await store.get('terrain'), null);
    assert.equal(await store.prefetchLatest(), null);
});

test('an empty completed transaction is not a successful put', async () => {
    const { store, indexedDB, name } = fixture({ omitGetAllSuccess: true });
    assert.equal(await store.put('terrain', artifactFixture()), false);
    assert.equal(indexedDB.records(name, 'artifacts').has('terrain'), false);
});

// GW — the saved-bake key says whether the bake holds the ground weather
// field (IsometricRenderer passes GroundBake.groundWeatherWanted per backend).
test('GW: Canvas with gw1 on saves and restores a field-less bake; a GPU session misses it and saves its own with the field', async () => {
    const { terrainArtifactKey } = await import('../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js');
    const { groundWeatherWanted } = await import('../../claudeville/src/presentation/character-mode/GroundBake.js');
    const { resetLookStrengths, setLookStrength } = await import('../../claudeville/src/presentation/character-mode/LookStrengths.js');
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'autumn', sceneryRevision: 0, snowBucket: 0, frost: 0,
        phenology: 'fall-4', bounds: { x: 0, y: 0, w: 2, h: 2 }, dpr: 1 };
    const keyFor = (mode) => terrainArtifactKey({ ...inputs, groundWeather: groundWeatherWanted({ worldRendererMode: mode }, inputs.frost) });
    try {
        for (const id of ['gw1', 'gw2', 'gw3']) setLookStrength(id, 0);
        const today = terrainArtifactKey({ ...inputs, groundWeather: false });
        assert.equal(keyFor('canvas'), today, 'looks 0: Canvas key byte-identical to today');
        assert.equal(keyFor('webgl'), today, 'looks 0: GPU key byte-identical to today');
        setLookStrength('gw1', 0.5);
        const { store } = fixture();
        const canvasKey = keyFor('canvas');
        const gpuKey = keyFor('webgl');
        assert.equal(canvasKey, today, 'Canvas with gw1 on: the field-less key');
        assert.notEqual(gpuKey, canvasKey);
        const bare = artifactFixture(5);
        delete bare.ground.field.weather;
        assert.equal(await store.put(canvasKey, bare), true, 'Canvas saves its field-less bake');
        assert.ok(await store.get(canvasKey), 'and restores it on the next Canvas boot');
        assert.equal(await store.get(gpuKey), null, 'a GPU session misses it by key');
        assert.equal(await store.put(gpuKey, bare), false, 'a field-less bake is never saved under the field key');
        const withField = artifactFixture(6);
        assert.equal(await store.put(gpuKey, withField), true, 'the GPU rebake saves under its own key with the field');
        assert.ok((await store.get(gpuKey)).ground.field.weather, 'and restores with the field');
        // A backend that changes after its key was computed (WebGPU fails, the
        // renderer falls back to Canvas): the new key is the Canvas one, and a
        // bake whose contents disagree with its key is deleted, never restored.
        assert.notEqual(keyFor('canvas'), gpuKey);
        assert.equal(await store.put(canvasKey, withField), false, 'a field bake never lands under a field-less key');
    } finally {
        resetLookStrengths();
    }
});

// ---- TerrainArtifactStore v3 (W1-A: schema 3, manifest, aggregate byte LRU) ----

// An artifact with a one-cell coast (water fields and all), so the v3
// substrate planes and the coast-texel rule can be exercised.
function coastArtifactFixture(value = 9, { texels = false } = {}) {
    const artifact = artifactFixture(value);
    const source = { world: { buildings: new Map() }, waterTiles: new Set(['0,0']), waterMeta: new Map([['0,0', { region: 'sea' }]]) };
    const field = getCoastField(source);
    source._coastBake = { key: field.key, fieldMs: field.buildMs, bakeMs: 3,
        coast: { x: 0, y: 0, cols: 2, rows: 1, classes: new Uint8Array([4, 4]), depth: new Float32Array([0.7, 0.8]),
            caps: new Uint8Array([4, 4]), outer: new Uint8Array([1, 1]), baked: null, mirrorAccents: [] },
        waterFields: { key: field.key, revision: 'water-r1', x: 0, y: 0, cols: 2, rows: 1, cycleOffset: new Uint8Array([4, 5]),
            coastField: new Uint8Array([128, 1, 128, 1]), mirrorStops: new Uint8Array([2, 3, 2, 3]),
            ...(texels ? { texels: new Uint8Array(8) } : {}), bakeMs: 5 } };
    artifact.coast = captureCoastArtifact(source);
    return { artifact, source };
}

const record = (at, rgb = [10, 20, 30], alpha = 200) => [at & 255, (at >>> 8) & 255, (at >>> 16) & 255, at >>> 24, ...rgb, alpha];

test('v3: the manifest names the 1x1 ground pitch, the 2x1 weather and coast pitches and the contract revisions', () => {
    assert.equal(TERRAIN_ARTIFACT_SCHEMA, 3);
    assert.deepEqual(TERRAIN_ARTIFACT_PITCH, { groundPitch: 1, weatherPitch: 2, coastPitch: 2 });
    assert.equal(TERRAIN_ARTIFACT_AGGREGATE_BYTES, 100_663_296);
    assert.equal(TERRAIN_ARTIFACT_MAX_BYTES, 100_663_296);
    assert.notEqual(TERRAIN_BAKE_ALGORITHM_VERSION, 'cv0.66-terrain-16', 'stale 2x1 bakes must never restore');
    const manifest = terrainArtifactManifest();
    assert.equal(manifest.groundPitch, 1);
    assert.equal(manifest.substrateRevision, 0);
    assert.equal(typeof manifest.elevationRevision, 'string');
    assert.equal(validTerrainArtifact(artifactFixture()), true);
    for (const broken of [{ weatherPitch: 1 }, { coastPitch: 1 }, { elevationRevision: '' }, { substrateRevision: 2 }]) {
        assert.equal(validTerrainArtifact({ ...artifactFixture(), manifest: { ...manifest, ...broken } }), false, JSON.stringify(broken));
    }
});

test('v3: the persistent key carries the pitches and revisions, and an artifact restores only under its own', async () => {
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'summer', sceneryRevision: 0, snowBucket: 0, frost: 0,
        phenology: 'summer', bounds: { x: 0, y: 0, w: 2, h: 2 }, dpr: 1, groundWeather: true };
    const key = terrainArtifactKey(inputs);
    const parts = JSON.parse(key);
    assert.deepEqual(parts.slice(0, 8), [3, TERRAIN_BAKE_ALGORITHM_VERSION, 'pitch', 1, 2, 2, manifestOf().elevationRevision, 0]);
    assert.notEqual(terrainArtifactKey({ ...inputs, substrateRevision: 1 }), key);
    assert.notEqual(terrainArtifactKey({ ...inputs, elevationRevision: 'e2' }), key);
    assert.equal(terrainArtifactKey({ ...inputs, substrateRevision: 2 }), null);
    assert.equal(terrainArtifactKey({ ...inputs, elevationRevision: '' }), null);
    const artifact = artifactFixture(4);
    assert.equal(manifestMatchesKey(key, artifact), true);
    const otherKey = terrainArtifactKey({ ...inputs, elevationRevision: 'e2' });
    assert.equal(manifestMatchesKey(otherKey, artifact), false);
    const { store } = fixture();
    assert.equal(await store.put(otherKey, artifact), false, 'never saved under a key naming another manifest');
    assert.equal(await store.put(key, artifact), true);
    assert.equal((await store.get(key)).rgba[0], 4);
});
function manifestOf() { return terrainArtifactManifest(); }

test('v3: LRU rows store the exact byte size and schema of each entry', async () => {
    const { store } = fixture();
    const artifact = artifactFixture(3);
    assert.equal(await store.put('a', artifact), true);
    const [row] = await store.rows();
    assert.equal(row.key, 'a');
    assert.equal(row.schema, 3);
    assert.ok(Number.isInteger(row.bytes) && row.bytes > 1_000_000, `bytes ${row.bytes}`);
    await store.get('a');
    const [touched] = await store.rows();
    assert.equal(touched.bytes, row.bytes, 'a read keeps the size in the LRU row');
    assert.ok(touched.used > row.used);
});

test('v3: the aggregate byte cap evicts older entries even under the count limit', async () => {
    const probe = fixture();
    await probe.store.put('size', artifactFixture(1));
    const [{ bytes }] = await probe.store.rows();
    // Room for one and a half entries: the second write must evict the first.
    const { store, indexedDB, name } = fixture({}, { aggregateBytes: Math.floor(bytes * 1.5), entryBytes: bytes * 2 });
    assert.equal(await store.put('a', artifactFixture(1)), true);
    assert.equal(await store.put('b', artifactFixture(2)), true);
    assert.equal(await store.get('a'), null, 'the older entry no longer fits beside the newest');
    assert.equal((await store.get('b')).rgba[0], 2);
    assert.equal(indexedDB.records(name, 'artifacts').size, 1);
    assert.deepEqual((await store.rows()).map(row => row.key), ['b']);
    // With room for two, both stay; a third evicts the least recently read.
    const roomy = fixture({}, { aggregateBytes: bytes * 2 + 64, entryBytes: bytes * 2 });
    assert.equal(await roomy.store.put('a', artifactFixture(1)), true);
    assert.equal(await roomy.store.put('b', artifactFixture(2)), true);
    assert.equal(roomy.indexedDB.records(roomy.name, 'artifacts').size, 2);
});

test('v3: schema-2 and size-less rows are purged in the next write, never prefetched', async () => {
    const { store, indexedDB, name } = fixture();
    assert.equal(await store.put('live', artifactFixture(5)), true);
    const artifacts = indexedDB.records(name, 'artifacts');
    const lru = indexedDB.records(name, 'lru');
    const legacy = artifactFixture(6);
    legacy.schema = 2;
    delete legacy.manifest;
    artifacts.set('legacy', { artifact: legacy, bytes: 10, checksum: 'x' });
    lru.set('legacy', { key: 'legacy', used: Date.now() + 1e6 });
    artifacts.set('sizeless', { artifact: legacy, bytes: 10, checksum: 'x' });
    lru.set('sizeless', { key: 'sizeless', used: Date.now() + 2e6, schema: 3 });
    const candidate = await store.prefetchLatest();
    assert.equal(candidate.key, 'live', 'the newest stale rows are skipped');
    assert.equal(await store.put('next', artifactFixture(7)), true);
    // A committed write replaces the stores: read them afresh.
    assert.equal(indexedDB.records(name, 'artifacts').has('legacy'), false);
    assert.equal(indexedDB.records(name, 'lru').has('legacy'), false);
    assert.equal(indexedDB.records(name, 'artifacts').has('sizeless'), false);
    assert.equal(indexedDB.records(name, 'lru').has('sizeless'), false);
    assert.deepEqual((await store.rows()).map(row => row.key).sort(), ['live', 'next']);
});

test('v3: an oversized candidate is refused without deleting the last usable key', async () => {
    const probe = fixture();
    const small = artifactFixture(1);
    delete small.ground.field.weather;
    await probe.store.put('small', small);
    const [{ bytes }] = await probe.store.rows();
    const { store } = fixture({}, { aggregateBytes: bytes + 1024, entryBytes: bytes + 1024 });
    const kept = artifactFixture(2);
    delete kept.ground.field.weather;
    assert.equal(await store.put('kept', kept), true);
    assert.equal(await store.put('kept', artifactFixture(3)), false, 'the larger bake under the same key is refused');
    assert.equal(await store.put('other', artifactFixture(4)), false);
    assert.equal((await store.get('kept')).rgba[0], 2, 'the last usable entry survives');
    assert.deepEqual((await store.rows()).map(row => row.key), ['kept']);
});

test('v3: a failed write holds persistence off instead of retrying every draw', async () => {
    let now = 1_000;
    const { store } = fixture({}, { now: () => now });
    const db = await store._open();
    const original = db.transaction;
    let transactions = 0;
    db.transaction = (...args) => { transactions++; if (args[1] === 'readwrite') throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); return original(...args); };
    assert.equal(await store.put('a', artifactFixture(1)), false);
    const attempts = transactions;
    assert.equal(await store.put('a', artifactFixture(1)), false);
    assert.equal(transactions, attempts, 'no transaction while backed off');
    db.transaction = original;
    now += 6 * 60 * 1000;
    assert.equal(await store.put('a', artifactFixture(1)), true, 'writes resume after the back-off');
});

test('v3: the storage estimate is an advisory preflight', async () => {
    const tight = fixture({}, { storage: { estimate: async () => ({ quota: 1_000, usage: 900 }) }, aggregateBytes: 1_000 });
    assert.equal(await tight.store.put('a', artifactFixture(1)), false, 'a quota that cannot hold it even when empty refuses');
    const roomy = fixture({}, { storage: { estimate: async () => ({ quota: 1e12, usage: 0 }) } });
    assert.equal(await roomy.store.put('a', artifactFixture(1)), true);
    const unknown = fixture({}, { storage: { estimate: async () => { throw new Error('no'); } } });
    assert.equal(await unknown.store.put('a', artifactFixture(1)), true, 'an unavailable estimate never blocks');
});

test('v3: memoized coast texels are dropped at capture and rejected in a stored artifact', () => {
    const { artifact, source } = coastArtifactFixture(1, { texels: true });
    assert.equal(validTerrainArtifact(artifact), false, 'cached waterFields.texels are disallowed');
    const renderer = { ...source, groundField: null };
    // The capture path strips them (rebuilt from coastField / mirrorStops at upload).
    const ground = artifactFixture().ground;
    Object.assign(renderer, {
        groundField: { ...ground.field, bounds: ground.field.bounds },
        groundPuddleMask: ground.puddleMask,
    });
    const fields = captureTerrainArtifactFields(renderer);
    assert.equal(fields.coast.bake.waterFields.texels, undefined);
    assert.ok(source._coastBake.waterFields.texels, 'the live bake keeps its memo');
    assert.equal(validTerrainArtifact({ ...artifact, coast: fields.coast }), true);
});

test('v3: substrate revision 1 requires exposure and sorted, exposed, opaque contact records', () => {
    const { artifact } = coastArtifactFixture(2);
    const v1 = { ...artifact, manifest: { ...artifact.manifest, substrateRevision: 1 } };
    const withPlanes = (exposure, contacts) => ({ ...v1, coast: { ...v1.coast, bake: { ...v1.coast.bake, exposure, contacts } } });
    // Two cells (2x1 cells = 4x2 px): cell 0 exposes its top-left and
    // bottom-right pixels, cell 1 only its top-right.
    const exposure = new Uint8Array([0b1001, 0b0010]);
    const at = (x, y) => y * 4 + x;
    assert.equal(validTerrainArtifact(v1), false, 'revision 1 without its planes');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array([...record(at(0, 0)), ...record(at(3, 0))]))), true);
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array(0))), true, 'no contacts at all');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array([...record(at(3, 0)), ...record(at(0, 0))]))), false, 'unsorted');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array([...record(at(0, 0)), ...record(at(0, 0))]))), false, 'duplicate');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array(record(at(1, 0))))), false, 'not exposed water');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array(record(at(0, 0), [1, 2, 3], 0)))), false, 'zero coverage');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array(record(4 * 2)))), false, 'out of range');
    assert.equal(validTerrainArtifact(withPlanes(new Uint8Array(1), new Uint8Array(0))), false, 'exposure sized to the coast');
    assert.equal(validTerrainArtifact(withPlanes(exposure, new Uint8Array(7))), false, '8-byte records');
    // Revision 0 omits both planes.
    assert.equal(validTerrainArtifact({ ...artifact, coast: { ...artifact.coast, bake: { ...artifact.coast.bake, exposure } } }), false);
});
