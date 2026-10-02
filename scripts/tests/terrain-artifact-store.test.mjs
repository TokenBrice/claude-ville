import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { getCoastField, captureCoastArtifact } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { TerrainArtifactStore, TERRAIN_ARTIFACT_MAX_BYTES } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';

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
    return { schema: 1, bounds: { x: 0, y: 0, w: 2, h: 2 }, dpr: 1, width: 2, height: 2,
        rgba: new Uint8ClampedArray([value, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
        ground: { field: { bounds: { x: -w / 2, y: -TILE_HEIGHT / 2, w, h }, cols: w / 2, rows: h, texelW: 2,
            classes: new Uint8Array(count) }, puddleMask: { data: new Uint8Array(count), cols: w / 2, rows: h,
            x0: -w / 2, y0: -TILE_HEIGHT / 2, texelW: 2, revision: 'ground' }, groundBakeMs: 3 },
        coast: captureCoastArtifact(source) };
}

function fixture(options) {
    const indexedDB = fakeIndexedDB(options);
    const name = 'terrain-test';
    return { indexedDB, name, store: new TerrainArtifactStore({ indexedDB, name }) };
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
