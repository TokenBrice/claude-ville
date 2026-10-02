import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { GROUND_CLASS, restoreGroundArtifact, captureGroundArtifact, validGroundArtifact } from '../../claudeville/src/presentation/character-mode/GroundBake.js';
import { getCoastField, restoreCoastArtifact, captureCoastArtifact, validCoastArtifact } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { TerrainArtifactStore, terrainArtifactKey, terrainArtifactInputsSettled, terrainContentHash, terrainArtifactConfiguration } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const inputs = { assetVersion: 'art-v1', configHash: 'config-v1', season: 'summer', sceneryRevision: 0, snowBucket: 0, frost: 0,
    bounds: { x: -1600, y: -100, w: 3200, h: 2000 }, dpr: 1 };

for (const [name, change] of [
    ['assetVersion', { assetVersion: 'art-v2' }], ['configHash', { configHash: 'config-v2' }], ['season', { season: 'winter' }],
    ['sceneryRevision', { sceneryRevision: 1 }], ['snowBucket', { snowBucket: 1 }], ['frost', { frost: 1 }],
    ['algorithmVersion', { algorithmVersion: 'next-bake' }], ['DPR', { dpr: 2 }],
    ...['x', 'y', 'w', 'h'].map(key => [`bounds.${key}`, { bounds: { ...inputs.bounds, [key]: inputs.bounds[key] + 2 } }]),
]) {
    test(`persistent terrain key invalidates ${name}`, () => {
        assert.notEqual(terrainArtifactKey(inputs), terrainArtifactKey({ ...inputs, ...change }));
    });
}

test('key excludes clock/readiness generations but refuses missing deterministic inputs', () => {
    assert.equal(terrainArtifactKey(inputs), terrainArtifactKey({ ...inputs, time: 123, sheetsReady: 2, generation: 8 }));
    for (const missing of ['assetVersion', 'configHash', 'season', 'bounds', 'dpr']) assert.equal(terrainArtifactKey({ ...inputs, [missing]: undefined }), null);
    assert.equal(terrainArtifactKey({ ...inputs, snowBucket: 5 }), null);
});

test('terrain content digest covers config values and every byte of typed fields', async () => {
    const base = { terrain: new Uint8Array([0, 1, 2, 3]), town: { seed: 9 } };
    assert.equal(await terrainContentHash(base), await terrainContentHash({ town: { seed: 9 }, terrain: new Uint8Array([0, 1, 2, 3]) }));
    assert.notEqual(await terrainContentHash(base), await terrainContentHash({ ...base, terrain: new Uint8Array([0, 1, 2, 4]) }));
    assert.notEqual(await terrainContentHash(base), await terrainContentHash({ ...base, town: { seed: 10 } }));
});

function groundFixture() {
    const w = MAP_SIZE * TILE_WIDTH;
    const h = MAP_SIZE * TILE_HEIGHT;
    const classes = new Uint8Array(w / 2 * h);
    classes[0] = GROUND_CLASS.GRASS;
    classes[classes.length - 1] = GROUND_CLASS.ROAD;
    return { field: { bounds: { x: -w / 2, y: -TILE_HEIGHT / 2, w, h }, cols: w / 2, rows: h, texelW: 2, classes },
        puddleMask: { data: new Uint8Array(classes.length), cols: w / 2, rows: h, x0: -w / 2, y0: -TILE_HEIGHT / 2, texelW: 2, revision: 'sites' },
        groundBakeMs: 12, groundWinterBakeMs: 4 };
}

test('restored ground preserves class and puddle fields and boundary semantics', () => {
    const ground = groundFixture();
    ground.puddleMask.data[19] = 221;
    const renderer = {};
    restoreGroundArtifact(renderer, structuredClone(ground));
    assert.deepEqual(captureGroundArtifact(renderer), ground);
    const { x, y, w, h } = ground.field.bounds;
    assert.equal(renderer.groundField.classAt(x, y), GROUND_CLASS.GRASS);
    assert.equal(renderer.groundField.classAt(x + w - 0.01, y + h - 0.01), GROUND_CLASS.ROAD);
    for (const [wx, wy] of [[x - 0.01, y], [x + w, y], [x, y - 0.01], [x, y + h]]) assert.equal(renderer.groundField.classAt(wx, wy), GROUND_CLASS.NONE);
    assert.equal(validGroundArtifact({ ...ground, puddleMask: { ...ground.puddleMask, data: new Uint8Array(4) } }), false);
});

test('coast rehydration preserves interpolation, depths, water buffers and live mirror owners', () => {
    const oldBuilding = { type: 'harbor' };
    const source = { world: { buildings: new Map([['harbor-id', oldBuilding]]) }, waterTiles: new Set(['0,0']), waterMeta: new Map([['0,0', { region: 'sea' }]]) };
    const field = getCoastField(source);
    source._coastBake = { key: field.key, fieldMs: field.buildMs, bakeMs: 3, reflectMs: 4,
        coast: { x: 0, y: 0, cols: 1, rows: 1, classes: new Uint8Array([4]), depth: new Float32Array([0.73]),
            caps: new Uint8Array([5]), outer: new Uint8Array([1]), baked: null, reflect: new Uint8Array([2]),
            covered: new Uint8Array([1]), mirrorBase: new Uint8Array([2, 3, 0, 0]),
            mirrorAccents: [{ building: oldBuilding, type: 'harbor', texels: [
                { building: oldBuilding, at: 0, x: 0, y: 0, sx: undefined, sy: undefined, lamp: true, rgb: [0.4, 2.5, 3] },
                { building: oldBuilding, at: 1, x: 1, y: 0, sx: 1, sy: 2, lamp: false, rgb: [4, 5, 6] },
            ] }] },
        waterFields: { key: field.key, revision: 'water-r1', x: 0, y: 0, cols: 1, rows: 1, cycleOffset: new Uint8Array([4]),
            coastField: new Uint8Array([128, 1]), mirrorStops: new Uint8Array([2, 3]), texels: new Uint8Array([128, 1, 2, 3]), bakeMs: 5 } };
    const snapshot = captureCoastArtifact(source);
    assert.equal(validCoastArtifact(snapshot), true);
    const newBuilding = { type: 'harbor' };
    const target = { world: { buildings: new Map([['harbor-id', newBuilding]]) } };
    restoreCoastArtifact(target, structuredClone(snapshot));
    assert.deepEqual(captureCoastArtifact(target), snapshot);
    for (const [u, v] of [[-20, -20], [0.21, 0.67], [MAP_SIZE - 1, MAP_SIZE - 1], [100, 100]]) {
        assert.equal(target.coastField.signedDistance(u, v), field.signedDistance(u, v));
        assert.equal(target.coastField.depthCapAt(u, v), field.depthCapAt(u, v));
        assert.equal(target.coastField.isWater(u, v), field.isWater(u, v));
    }
    assert.equal(validCoastArtifact({ ...snapshot, bake: { ...snapshot.bake, waterFields: null } }), false);
    const brokenWindow = structuredClone(snapshot);
    delete brokenWindow.bake.coast.mirrorAccents[0].texels[1].sx;
    assert.equal(validCoastArtifact(brokenWindow), false, 'window room gates require sheet coordinates');
    const brokenLamp = structuredClone(snapshot);
    brokenLamp.bake.coast.mirrorAccents[0].texels[0].sy = 'missing';
    assert.equal(validCoastArtifact(brokenLamp), false, 'lamp coordinates may be absent, not malformed');
    const unresolved = { world: { buildings: new Map() } };
    assert.throws(() => restoreCoastArtifact(unresolved, snapshot), /Unresolved/);
    assert.equal(unresolved.coastField, undefined, 'a failed restore must not publish partial semantics');
});

test('only settled real terrain sources may consume a persistent artifact', () => {
    const assets = { assetVersion: 'v1', manifest: {}, _decodedLoaded: true, _materialAssetsEnabled: true, _materialDecodedLoaded: true,
        _entryById: new Map([['terrain.grass-dirt', {}], ['agent.coder', {}]]), has: id => id === 'terrain.grass-dirt' };
    const renderer = { assets, _terrainBakePasses: [{ id: 'ground-splat' }, { id: 'coast-field' }, { id: 'coast-reflections' }] };
    assert.equal(terrainArtifactInputsSettled(renderer), true);
    assets._materialDecodedLoaded = false;
    assert.equal(terrainArtifactInputsSettled(renderer), false);
    assets._materialDecodedLoaded = true;
    assets.has = () => false;
    assert.equal(terrainArtifactInputsSettled(renderer), false);
    assets.has = () => true;
    assets._evictedOptionalEntries = new Map([['companion:emissive:building.harbor', {}]]);
    assert.equal(terrainArtifactInputsSettled(renderer), false);
});

test('configuration digest covers each terrain manifest section and resolved atlas frame metadata', async () => {
    const renderer = { assets: { manifest: {}, atlasMetadata: new Map() }, world: { buildings: new Map() } };
    const original = await terrainContentHash(terrainArtifactConfiguration(renderer), true);
    for (const section of ['style', 'materialContract', 'atlases', 'buildings', 'props', 'vegetation', 'terrain', 'bridges']) {
        renderer.assets.manifest = { [section]: { value: 'changed' } };
        assert.notEqual(await terrainContentHash(terrainArtifactConfiguration(renderer), true), original, section);
    }
    renderer.assets.manifest = {};
    renderer.assets.atlasMetadata.set('world', { frames: { 'building.harbor': { x: 2, y: 4, w: 8, h: 8 } } });
    assert.notEqual(await terrainContentHash(terrainArtifactConfiguration(renderer), true), original);
});

function terrainFrameFixture(t, { matchingCandidate = true, presented = false } = {}) {
    const originals = ['document', 'ImageData', 'indexedDB'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    t.after(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    const canvas = () => {
        const output = { width: 0, height: 0, pixels: null };
        output.getContext = () => ({
            setTransform() {},
            putImageData(image) { output.pixels = image.data.slice(); },
            getImageData() { return { data: output.pixels }; },
        });
        return output;
    };
    globalThis.document = { createElement: canvas };
    globalThis.ImageData = class {
        constructor(data, width, height) { Object.assign(this, { data, width, height }); }
    };
    globalThis.indexedDB = {};
    let now = 100;
    t.mock.method(performance, 'now', () => now);
    let resolve;
    let reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const bounds = { x: 0, y: 0, w: 2, h: 2 };
    const configHash = 'configuration';
    let season = 'summer';
    const key = terrainArtifactKey({ ...inputs, bounds, configHash, season });
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        world: { buildings: new Map() },
        assets: { assetVersion: inputs.assetVersion, manifest: {}, _decodedLoaded: true, _entryById: new Map() },
        foliageRenderer: { setSeason() {} },
        _groundState: { snowCover: 0, frost: false },
        _terrainBakePasses: [{ id: 'ground-splat' }, { id: 'coast-field' }, { id: 'coast-reflections' }],
        _terrainArtifactConfigHash: configHash,
        _terrainArtifactPrefetch: { key: matchingCandidate ? key : 'a different season' },
        _terrainArtifactStats: { reads: 0, hits: 0, misses: 0, bakes: 0, writes: 0, state: 'reading' },
        _terrainArtifactStore: { get: () => result, delete: async () => true },
        _terrainCacheBounds: () => bounds,
        _getTerrainCacheMeta: () => ({ singleSurfaceWithinBudget: true }),
        _currentSeasonToken: () => season,
        _queueTerrainArtifactWrite() {},
        _drawStaticTerrainSurface(ctx) {
            ctx.putImageData(new ImageData(new Uint8ClampedArray([99, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]), 2, 2), 0, 0);
        },
    });
    if (presented) renderer._recordIdleRenderState();
    const source = { world: renderer.world, waterTiles: new Set() };
    const field = getCoastField(source);
    source._coastBake = { key: field.key, fieldMs: field.buildMs, bakeMs: 1, coast: null, waterFields: null };
    const artifact = { schema: 1, bounds, dpr: 1, width: 2, height: 2,
        rgba: new Uint8ClampedArray([17, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
        ground: groundFixture(), coast: captureCoastArtifact(source) };
    return {
        renderer, artifact, resolve, reject,
        setNow(value) { now = value; },
        setSeason(value) { season = value; },
        frame(allowWait = true) {
            if (!renderer._prepareTerrainArtifactFrame(allowWait)) return null;
            return renderer._getTerrainCache().canvas.getContext('2d').getImageData().data;
        },
        diagnostics: () => renderer.getTerrainCacheDiagnostics().artifact,
    };
}

const settleIO = () => new Promise(resolve => setImmediate(resolve));

test('the first terrain frame bakes at the 250ms deadline, even if storage never settles', t => {
    const f = terrainFrameFixture(t);
    assert.equal(f.frame(), null);
    f.setNow(349);
    assert.equal(f.frame(), null);
    f.setNow(350);
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
    assert.equal(f.diagnostics().hits, 0);
});

test('a known candidate mismatch bakes immediately without holding the frame', t => {
    const f = terrainFrameFixture(t, { matchingCandidate: false });
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

test('changed settled inputs cancel a pending first-frame hold and bake in that frame', t => {
    const f = terrainFrameFixture(t);
    assert.equal(f.frame(), null);
    f.setSeason('winter');
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

test('a matching first-frame hit restores pixels and semantic accessors without a bake', async t => {
    const f = terrainFrameFixture(t);
    assert.equal(f.frame(), null);
    f.resolve(f.artifact);
    await settleIO();
    assert.deepEqual(f.frame(), f.artifact.rgba);
    assert.equal(f.renderer.groundField.classAt(f.artifact.ground.field.bounds.x, f.artifact.ground.field.bounds.y), GROUND_CLASS.GRASS);
    assert.equal(f.diagnostics().hits, 1);
    assert.equal(f.diagnostics().bakes, 0);
});

test('a storage error ends the hold and bakes in the next frame without waiting for its deadline', async t => {
    const f = terrainFrameFixture(t);
    assert.equal(f.frame(), null);
    f.reject(new Error('storage failed'));
    await settleIO();
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

test('terrain reads never withhold after a presented frame', t => {
    const f = terrainFrameFixture(t, { presented: true });
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

test('capture/renderNow frames do not opt into a storage hold', t => {
    const f = terrainFrameFixture(t);
    assert.equal(f.frame(false)[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

test('unavailable storage never withholds a terrain frame', t => {
    const f = terrainFrameFixture(t);
    delete globalThis.indexedDB;
    assert.equal(f.frame()[0], 99);
    assert.equal(f.diagnostics().bakes, 1);
});

function terrainWriteFixture(t) {
    const f = terrainFrameFixture(t);
    const idle = [];
    const idleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
    globalThis.requestIdleCallback = callback => { idle.push(callback); };
    t.after(() => {
        if (idleDescriptor) Object.defineProperty(globalThis, 'requestIdleCallback', idleDescriptor);
        else delete globalThis.requestIdleCallback;
    });
    const renderer = f.renderer;
    delete renderer._queueTerrainArtifactWrite;
    restoreGroundArtifact(renderer, f.artifact.ground);
    restoreCoastArtifact(renderer, f.artifact.coast);
    let finishReveal;
    let published = 0;
    let reads = 0;
    const saved = [];
    const reveal = new Promise(resolve => { finishReveal = resolve; });
    t.after(eventBus.on('world:first-frame', () => { published++; }));
    Object.assign(renderer, {
        _worldModeActive: true,
        _worldResourcesSuspended: false,
        _firstFrameReason: 'boot-pending',
        _terrainArtifactConfigPromise: Promise.resolve(renderer._terrainArtifactConfigHash),
        _invalidateIdleFrame() {},
        _horizonScreenFraction: () => 0.3,
        _revealCell: () => 1,
        _sampleFrameBands: () => reveal,
    });
    renderer._terrainArtifactStore.put = async (key, artifact, canWrite) => {
        await terrainContentHash(artifact);
        if (!canWrite()) return false;
        saved.push({ key, artifact: structuredClone(artifact) });
        return true;
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').putImageData(new ImageData(f.artifact.rgba, 2, 2), 0, 0);
    const getContext = canvas.getContext;
    canvas.getContext = () => {
        const context = getContext();
        const getImageData = context.getImageData;
        context.getImageData = () => { reads++; return getImageData(); };
        return context;
    };
    renderer.terrainCache = canvas;
    renderer._queueTerrainArtifactWrite(canvas, f.artifact.bounds, 1, 'summer');
    renderer.releaseTerrainCanvas();
    return {
        renderer, canvas, idle, saved, rgba: f.artifact.rgba,
        finishReveal, published: () => published, reads: () => reads,
        async runIdle() { assert.ok(idle.length, 'an idle slice is scheduled'); await idle.shift()(); },
    };
}

test('terrain artifact extraction waits for published first-frame reveal, then saves in separate idle slices', async t => {
    const f = terrainWriteFixture(t);
    assert.equal(f.idle.length, 0, 'boot-pending cannot schedule artifact work');
    f.renderer.armFirstFrameSignal('boot');
    f.renderer._signalFirstFrame();
    await settleIO();
    assert.equal(f.reads(), 0);
    assert.equal(f.idle.length, 0, 'an unresolved reveal snapshot cannot schedule artifact work');
    assert.equal(f.canvas.width, 2, 'the existing pending write still owns the released CPU canvas');
    f.finishReveal({ bands: [{ top: 0, color: '#102030' }] });
    await settleIO();
    assert.equal(f.published(), 1);
    assert.equal(f.reads(), 0, 'publication itself does no pixel extraction');
    await f.runIdle();
    assert.equal(f.reads(), 1);
    assert.equal(f.saved.length, 0, 'hashing/storage wait for another idle slice');
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
    await f.runIdle();
    assert.deepEqual(f.saved[0].artifact.rgba, f.rgba);
    assert.equal(f.renderer._terrainArtifactStats.writes, 1);
    assert.equal(f.renderer._terrainArtifactWrite, null);
    assert.equal(f.idle.length, 0);
});

test('a re-armed reveal blocks an already-scheduled artifact readback until its publication', async t => {
    const f = terrainWriteFixture(t);
    f.renderer.armFirstFrameSignal('boot');
    f.renderer._signalFirstFrame();
    f.finishReveal(null);
    await settleIO();
    f.renderer.armFirstFrameSignal('return');
    await f.runIdle();
    assert.equal(f.reads(), 0);
    assert.equal(f.idle.length, 0);
    f.renderer._signalFirstFrame();
    await settleIO();
    assert.equal(f.published(), 2);
    await f.runIdle();
    await f.runIdle();
    assert.equal(f.renderer._terrainArtifactStats.writes, 1);
});

test('World release cancels pending artifact extraction and zeros its owned canvas', async t => {
    const f = terrainWriteFixture(t);
    f.renderer.armFirstFrameSignal('boot');
    f.renderer._signalFirstFrame();
    f.finishReveal(null);
    await settleIO();
    f.renderer._worldModeActive = false;
    f.renderer._worldResourcesSuspended = true;
    f.renderer._releaseTerrainArtifactWork();
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
    await f.runIdle();
    assert.equal(f.reads(), 0);
    assert.equal(f.saved.length, 0);
    assert.equal(f.renderer._terrainArtifactWrite, null);
    assert.equal(f.idle.length, 0);
});

test('World release between extraction and hashing cancels the remaining artifact write', async t => {
    const f = terrainWriteFixture(t);
    f.renderer.armFirstFrameSignal('boot');
    f.renderer._signalFirstFrame();
    f.finishReveal(null);
    await settleIO();
    await f.runIdle();
    f.renderer._worldModeActive = false;
    f.renderer._worldResourcesSuspended = true;
    f.renderer._releaseTerrainArtifactWork();
    await f.runIdle();
    assert.equal(f.reads(), 1);
    assert.equal(f.saved.length, 0);
    assert.equal(f.renderer._terrainArtifactWrite, null);
    assert.equal(f.idle.length, 0);
});

test('an artifact write cancelled during database opening never starts a storage transaction', async t => {
    const f = terrainFrameFixture(t);
    let finishOpen;
    let transactions = 0;
    let eligible = true;
    const store = new TerrainArtifactStore();
    store._open = () => new Promise(resolve => { finishOpen = resolve; });
    const pending = store.put('cancelled-write', f.artifact, () => eligible);
    eligible = false;
    finishOpen({ transaction() { transactions++; throw new Error('cancelled writes cannot open transactions'); } });
    assert.equal(await pending, false);
    assert.equal(transactions, 0);
});
