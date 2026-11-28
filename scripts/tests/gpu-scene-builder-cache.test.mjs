import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildGpuWorldRecords,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import {
    buildStableGpuBatches,
    normalizeGpuRecord,
    validGpuRecord,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

function fakeImage(width, height, tag) {
    return { width, height, tag };
}

function createMockAssets({
    assetVersion = 'v1',
    pilotReady = true,
    atlasResident = true,
} = {}) {
    const counts = {
        resolveMaterialChannels: 0,
        getMaterialMetadata: 0,
        getAtlasFrame: 0,
        getEntry: 0,
        getEntryById: new Map(),
    };
    const atlasPages = {
        albedo: fakeImage(2048, 2048, 'atlas:albedo'),
        material: fakeImage(2048, 2048, 'atlas:material'),
        emissive: fakeImage(2048, 2048, 'atlas:emissive'),
        occluder: fakeImage(2048, 2048, 'atlas:occluder'),
    };
    const images = new Map([
        ['prop.lantern', fakeImage(32, 48, 'albedo:prop.lantern')],
        ['prop.plazaBrazier', fakeImage(40, 48, 'albedo:prop.plazaBrazier')],
        ['prop.barrel', fakeImage(32, 32, 'albedo:prop.barrel')],
        ['prop.oak_bench', fakeImage(48, 32, 'albedo:prop.oak_bench')],
        ['fantasy.tree', fakeImage(64, 96, 'albedo:fantasy.tree')],
        ['building.forge', fakeImage(256, 232, 'albedo:building.forge')],
    ]);
    const companions = new Map([
        ['prop.lantern:emissive', fakeImage(32, 48, 'emissive:prop.lantern')],
        ['prop.lantern:material', fakeImage(32, 48, 'material:prop.lantern')],
        ['building.forge:material', fakeImage(256, 232, 'material:building.forge')],
        ['building.forge:emissive', fakeImage(256, 232, 'emissive:building.forge')],
    ]);

    return {
        assetVersion,
        _loadGeneration: 1,
        derivedArtGeneration: 1,
        pilotReady,
        counts,
        atlasPage: channel => (atlasResident ? atlasPages[channel] || null : null),
        get: id => images.get(id) || null,
        getDims: id => {
            const img = images.get(id);
            return img ? { w: img.width, h: img.height } : null;
        },
        getAnchor: id => {
            const img = images.get(id);
            return img ? [Math.floor(img.width / 2), img.height] : null;
        },
        getEntry(id) {
            counts.getEntry++;
            counts.getEntryById.set(id, (counts.getEntryById.get(id) || 0) + 1);
            const img = images.get(id);
            if (!img) return null;
            return {
                id,
                atlasFrame: id === 'prop.lantern' || id === 'building.forge'
                    ? { atlas: 'world-pilot', key: id }
                    : null,
            };
        },
        getAtlas: (atlasId, channel) => (atlasId === 'world-pilot' ? atlasPages[channel] || null : null),
        getAtlasFrame(id) {
            counts.getAtlasFrame++;
            if (id === 'prop.lantern') return { atlas: 'world-pilot', key: id, rect: { x: 16, y: 16, w: 32, h: 48 } };
            if (id === 'building.forge') return { atlas: 'world-pilot', key: id, rect: { x: 64, y: 64, w: 256, h: 232 } };
            return null;
        },
        getCompanion: (id, channel) => companions.get(`${id}:${channel}`) || null,
        getMaterialMetadata(id) {
            counts.getMaterialMetadata++;
            if (id === 'prop.lantern') return { materialClass: 'lantern_flame', emissive: 0.9 };
            if (id === 'fantasy.tree') return { materialClass: 'foliage', emissive: 0 };
            if (id === 'building.forge') return { materialClass: 'stone', emissive: 0.4 };
            return { materialClass: 'wood', emissive: 0 };
        },
        resolveMaterialChannels(id, frameKey = null) {
            counts.resolveMaterialChannels++;
            const mat = companions.get(`${id}:material`) || null;
            const em = companions.get(`${id}:emissive`) || null;
            return {
                id,
                frameKey: frameKey || id,
                origin: mat || em ? 'sidecar' : 'none',
                layout: mat || em ? 'sidecar' : 'none',
                albedo: images.get(id) || null,
                material: mat,
                emissive: em,
                occluder: null,
                atlas: null,
                revision: `${this.assetVersion}::${this._loadGeneration}::${id}`,
                ready: this.pilotReady,
            };
        },
        setImage(id, img) { images.set(id, img); },
    };
}

function makePropSprite({
    id = 'prop.barrel',
    width = 32,
    height = 32,
    tileX = 4,
    tileY = 6,
    x = 120,
    y = 180,
    supportH = 0,
    emissiveGate = 1,
    hasEmissiveGate = false,
    canvasTag = 'prop:canvas',
    splitForOcclusion = false,
    splitY = -16,
    ownEmissive = null,
} = {}) {
    let canvas = fakeImage(width, height, canvasTag);
    let gate = emissiveGate;
    const sprite = {
        id,
        tileX,
        tileY,
        x,
        y,
        supportH,
        splitForOcclusion,
        bounds: { top: -height, bottom: 0, splitY },
        _gpuCacheRevision: 1,
        _getCachedCanvas() {
            return {
                canvas,
                x: Math.round(this.x - canvas.width / 2),
                y: Math.round(this.y - canvas.height),
                emissive: ownEmissive,
            };
        },
        columnSourceSpan(column, cached) {
            const sx = Math.max(0, Math.round(column.left - cached.x));
            const right = Math.min(cached.canvas.width, Math.round(column.right - cached.x));
            return { sx, sw: Math.max(0, right - sx) };
        },
        swapCanvas(next) {
            canvas = next;
        },
        invalidateCache() {
            this._gpuCacheRevision++;
        },
        setGate(next) {
            gate = next;
        },
    };
    if (hasEmissiveGate) {
        sprite.emitterGate = () => gate;
    }
    return sprite;
}

function createMockRenderer(assets, overrides = {}) {
    return {
        assets,
        camera: { zoom: 1, x: 0, y: 0 },
        _gpuAtlasResident: true,
        ...overrides,
    };
}

const NORMALIZED_FIELDS = [
    'id', 'textureKey', 'source', 'textureRevision', 'sourceKind',
    'x', 'y', 'width', 'height', 'sx', 'sy', 'sw', 'sh',
    'alpha', 'material', 'emissive', 'emissiveGate', 'daytimeEmitter',
    'elevation', 'occluder', 'flags', 'depthSortY', 'depthKey', 'writesDepth',
    'blend', 'sequence', 'pageable', 'footY', 'frontCornerX', 'frontCornerY',
    'ownerSlot', 'landmarkId', 'paletteRamp', 'recolorRow', 'meta',
    'sidecarKey', 'sidecarRevision', 'materialRevision', 'emissiveRevision',
    'materialSource', 'emissiveSource', 'occluderSource',
    'textureUpdates', 'materialTextureUpdates', 'emissiveTextureUpdates', 'occluderTextureUpdates',
    'pageLayer', 'supportH', 'sublayerRank', 'surfaceSource', 'surfaceKey', 'surfaceOffset',
];

function stripPreFlags(record) {
    const copy = { ...record };
    delete copy.prenormalized;
    delete copy.pageableNormalized;
    return copy;
}

test('static prop descriptor cache hits across frames and invalidates on every revision axis', () => {
    const assets = createMockAssets();
    const renderer = createMockRenderer(assets, { _gpuAtlasResident: false });
    // prop.lantern is a pilot prop, so it resolves channels + metadata on build.
    const lantern = makePropSprite({
        id: 'prop.lantern', width: 32, height: 48, hasEmissiveGate: true, emissiveGate: 0.85,
    });
    const drawables = [{ kind: 'prop', sortY: 180, payload: { sprite: lantern } }];

    const first = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(first.length, 1);
    const metaCalls1 = assets.counts.getMaterialMetadata;
    const channelCalls1 = assets.counts.resolveMaterialChannels;
    assert.equal(metaCalls1, 1);
    assert.equal(channelCalls1, 1);

    // Second frame with unchanged sprite & revisions: descriptor cache hit!
    const second = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(second.length, 1);
    assert.equal(assets.counts.getMaterialMetadata, metaCalls1, 'cached prop must not re-query material metadata');
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls1, 'cached prop must not re-resolve channels');
    assert.deepEqual(second[0], first[0]);

    // 1. Live per-frame fields compose on cache hit without busting descriptor cache.
    lantern.setGate(0.25);
    drawables[0].sortY = 240;
    const third = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(assets.counts.getMaterialMetadata, metaCalls1, 'live sortY/gate changes must still hit descriptor cache');
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls1);
    assert.notEqual(third[0].depthKey, first[0].depthKey, 'updated sortY must update painter depthKey');
    assert.equal(third[0].emissiveGate, 0.25, 'updated emitterGate must update live emissiveGate');

    // 2. sprite.invalidateCache() (_gpuCacheRevision bump) invalidates descriptor cache.
    lantern.invalidateCache();
    buildGpuWorldRecords(renderer, { drawables });
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls1 + 1, '_gpuCacheRevision change must rebuild descriptor');

    // 3. Swapping cached canvas invalidates descriptor cache.
    const channelCalls2 = assets.counts.resolveMaterialChannels;
    lantern.swapCanvas(fakeImage(32, 48, 'prop:canvas:v2'));
    const fourth = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls2 + 1, 'new cached canvas must rebuild descriptor');
    assert.equal(fourth[0].source.tag, 'prop:canvas:v2');

    // 4. Asset version / loadGeneration / derivedArtGeneration bumps invalidate descriptor cache.
    const channelCalls3 = assets.counts.resolveMaterialChannels;
    assets.assetVersion = 'v2';
    buildGpuWorldRecords(renderer, { drawables });
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls3 + 1, 'assetVersion change must rebuild descriptor');

    const channelCalls4 = assets.counts.resolveMaterialChannels;
    assets._loadGeneration++;
    buildGpuWorldRecords(renderer, { drawables });
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls4 + 1, '_loadGeneration change must rebuild descriptor');

    const channelCalls5 = assets.counts.resolveMaterialChannels;
    assets.derivedArtGeneration++;
    buildGpuWorldRecords(renderer, { drawables });
    assert.equal(assets.counts.resolveMaterialChannels, channelCalls5 + 1, 'derivedArtGeneration change must rebuild descriptor');

    // 5. Atlas policy switch (atlasProp) invalidates descriptor cache.
    assert.equal(fourth[0].sourceKind, 'individual');
    renderer._gpuAtlasResident = true;
    const atlasRec = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'))[0];
    assert.equal(atlasRec.sourceKind, 'atlas', 'atlas policy switch must invalidate cached prop descriptor');
    assert.equal(atlasRec.textureKey, 'world-pilot');

    // 6. Async pilot channel readiness retries until ready, then caches.
    const asyncAssets = createMockAssets({ pilotReady: false });
    const asyncRenderer = createMockRenderer(asyncAssets, { _gpuAtlasResident: false });
    const brazier = makePropSprite({ id: 'prop.lantern', width: 32, height: 48 });
    const asyncDrawables = [{ kind: 'prop', sortY: 180, payload: { sprite: brazier } }];
    buildGpuWorldRecords(asyncRenderer, { drawables: asyncDrawables });
    assert.equal(asyncAssets.counts.resolveMaterialChannels, 1);
    buildGpuWorldRecords(asyncRenderer, { drawables: asyncDrawables });
    assert.equal(asyncAssets.counts.resolveMaterialChannels, 2, 'pending pilot channels must retry');
    asyncAssets.pilotReady = true;
    buildGpuWorldRecords(asyncRenderer, { drawables: asyncDrawables });
    assert.equal(asyncAssets.counts.resolveMaterialChannels, 3);
    buildGpuWorldRecords(asyncRenderer, { drawables: asyncDrawables });
    assert.equal(asyncAssets.counts.resolveMaterialChannels, 3, 'once ready, pilot prop caches cleanly');
});

test('cached pilot props follow atlas metadata and channels loaded after first presentation', () => {
    const assets = createMockAssets();
    const getFrame = assets.getAtlasFrame.bind(assets);
    let metadataReady = false;
    assets.getAtlasFrame = id => metadataReady ? getFrame(id) : null;
    const getPage = assets.getAtlas;
    const pages = new Map([['albedo', getPage('world-pilot', 'albedo')]]);
    assets.getAtlas = (id, channel) => id === 'world-pilot' ? pages.get(channel) : null;
    const renderer = createMockRenderer(assets);
    const sprite = makePropSprite({ id: 'prop.lantern' });
    const drawables = [{ kind: 'prop', sortY: 180, payload: { sprite } }];
    const record = () => buildGpuWorldRecords(renderer, { drawables }).find(r => r.id.startsWith('prop:'));

    assert.equal(record().sourceKind, 'individual');
    metadataReady = true;
    assert.equal(record().sourceKind, 'atlas');
    assert.equal(record().emissiveSource, null);
    for (const channel of ['material', 'emissive']) {
        const image = getPage('world-pilot', channel);
        pages.set(channel, image);
        assert.equal(record()[channel + 'Source'], image);
        pages.delete(channel);
        assert.equal(record()[channel + 'Source'], null);
    }
});

test('split prop parts and columns cache independently and compose live depth', () => {
    const assets = createMockAssets();
    const renderer = createMockRenderer(assets, { _gpuAtlasResident: false });
    const bench = makePropSprite({
        id: 'prop.lantern', width: 48, height: 32, splitForOcclusion: true, splitY: -12,
    });
    const drawables = [
        { kind: 'prop', sortY: 200, payload: { sprite: bench, part: 'back' } },
        { kind: 'prop', sortY: 210, payload: { sprite: bench, part: 'front' } },
        { kind: 'prop', sortY: 215, payload: { sprite: bench, part: 'column', column: { left: 96, right: 112, index: 0 } } },
        { kind: 'prop', sortY: 220, payload: { sprite: bench, part: 'column', column: { left: 112, right: 144, index: 1 } } },
    ];
    const r1 = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(r1.length, 4);
    assert.equal(r1[0].sy, 0);
    assert.ok(r1[1].sy > 0 && r1[0].sh + r1[1].sh === 32, 'back and front split halves partition full height');
    assert.equal(r1[2].sw, 16);
    assert.equal(r1[3].sw, 32);

    const calls = assets.counts.resolveMaterialChannels;
    drawables[1].sortY = 230;
    const r2 = buildGpuWorldRecords(renderer, { drawables }).filter(r => r.id.startsWith('prop:'));
    assert.equal(assets.counts.resolveMaterialChannels, calls, 'all split parts and columns hit cache independently');
    assert.notEqual(r2[1].depthKey, r1[1].depthKey, 'live sortY updates front half depthKey on cache hit');
    assert.equal(r2[0].depthKey, r1[0].depthKey);
});

test('multi-column building memoizes per-building asset resolution once per frame and preserves column order', () => {
    const assets = createMockAssets();
    const renderer = createMockRenderer(assets, { _gpuAtlasResident: false });
    const entry = { id: 'building.forge', material: {} };
    const building = { type: 'forge' };
    const drawables = [0, 1, 2, 3, 4, 5].map(col => ({
        kind: 'building-column',
        sortY: 200 + col * 4,
        payload: {
            kind: 'building-column',
            entry,
            building,
            wx: 100,
            wy: 200,
            column: { sx: col * 32, sw: 32, dx: col * 32, index: col },
        },
    }));

    const records = buildGpuWorldRecords(renderer, { drawables })
        .filter(r => r.id.startsWith('building.forge'));
    assert.equal(records.length, 6, 'all 6 building columns emitted');
    assert.equal(assets.counts.resolveMaterialChannels, 1, '6 columns resolve material channels once per building');
    assert.equal(assets.counts.getEntryById.get('building.forge'), 1, '6 columns resolve building manifest entry once');
    for (let col = 0; col < 6; col++) {
        assert.equal(records[col].sx, col * 32, `column ${col} sx preserved in exact order`);
        assert.equal(records[col].sw, 32);
    }
});

test('every finalized GpuSceneBuilder record matches normalizeGpuRecord field-for-field and preserves ordering', () => {
    const assets = createMockAssets();
    const terrainImg = fakeImage(1024, 512, 'terrain');
    const hazeImg = fakeImage(256, 256, 'haze');
    const barrel = makePropSprite({ id: 'prop.barrel', width: 32, height: 32 });
    const lantern = makePropSprite({ id: 'prop.lantern', width: 32, height: 48, hasEmissiveGate: true, emissiveGate: 0.7 });
    const tree = makePropSprite({ id: 'fantasy.tree', width: 64, height: 96 });
    const agentImg = fakeImage(32, 48, 'agent:frame');

    const renderer = createMockRenderer(assets, {
        _gpuAtlasResident: true,
        terrainCacheKey: 'terrain-v1',
        _getTerrainCache: () => ({ canvas: terrainImg, bounds: { x: -512, y: 0, w: 1024, h: 512 } }),
        _hazeField: { canvas: hazeImg, x: -512, y: 0, w: 1024, h: 512, key: 'haze-1' },
        _gpuHazeStrength: 0.35,
    });

    const drawables = [
        { kind: 'building', sortY: 160, payload: { kind: 'building', entry: { id: 'building.forge', material: {} }, building: { type: 'forge' }, wx: 80, wy: 160 } },
        { kind: 'prop', sortY: 180, payload: { sprite: barrel } },
        { kind: 'prop', sortY: 190, payload: { sprite: lantern } },
        { kind: 'prop', sortY: 200, payload: { sprite: tree } },
        {
            kind: 'agent',
            sortY: 210,
            payload: {
                agent: { id: 'agent-1', provider: 'claude' },
                x: 200,
                y: 210,
                getGpuWorldRecords: () => [{
                    id: 'agent:agent-1:body',
                    textureKey: 'agent:1',
                    source: agentImg,
                    textureRevision: 1,
                    x: 184, y: 162, width: 32, height: 48,
                    sx: 0, sy: 0, sw: 32, sh: 48,
                }],
            },
        },
    ];

    const records = buildGpuWorldRecords(renderer, { drawables });
    assert.ok(records.length >= 6, `expected at least 6 records, got ${records.length}`);
    assert.equal(records[0].id, 'terrain:static', 'terrain:static must remain first');
    assert.equal(records[1].id, 'ground:haze', 'ground:haze follows terrain');

    let seenStanding = false;
    let prenormalizedCount = 0;
    let pageableNormalizedCount = 0;
    let agentCount = 0;

    for (let index = 0; index < records.length; index++) {
        const rec = records[index];
        const isGround = rec.id === 'terrain:static' || rec.id.startsWith('ground:');
        if (!isGround) seenStanding = true;
        else assert.equal(seenStanding, false, `ground record ${rec.id} must precede standing drawables`);

        if (rec.id.startsWith('agent:')) {
            agentCount++;
            assert.notEqual(rec.prenormalized, true, 'agent records stay un-flagged for WaterReflections spread safety');
            assert.notEqual(rec.pageableNormalized, true, 'agent records stay un-flagged');
            continue;
        }
        if (rec.prenormalized === true) {
            prenormalizedCount++;
            assert.notEqual(rec.pageableNormalized, true, 'record cannot be both prenormalized and pageableNormalized');
        } else if (rec.pageableNormalized === true) {
            pageableNormalizedCount++;
        } else {
            continue;
        }
        assert.equal(validGpuRecord(rec), true, `${rec.id} must satisfy validGpuRecord`);
        const expected = normalizeGpuRecord(stripPreFlags(rec), index);
        for (const field of NORMALIZED_FIELDS) {
            assert.deepEqual(rec[field], expected[field], `${rec.id} field '${field}' must match normalizeGpuRecord`);
        }
    }

    assert.equal(agentCount, 1);
    assert.ok(prenormalizedCount >= 4, `expected >= 4 prenormalized records, got ${prenormalizedCount}`);
    assert.ok(pageableNormalizedCount >= 2, `expected >= 2 pageableNormalized records, got ${pageableNormalizedCount}`);

    // Verify WebGL2 buildStableGpuBatches still invokes pager on pageableNormalized records!
    const pagedIds = [];
    const pageObj = { key: 'albedo-page' };
    buildStableGpuBatches(records, [], [], rec => {
        if (rec.id.startsWith('prop:')) {
            pagedIds.push(rec.id);
            rec.pageLayer = 0;
            rec.pageX = 0;
            rec.pageY = 0;
            return pageObj;
        }
        return null;
    });
    assert.ok(pagedIds.includes('prop:prop.barrel:whole'), 'pageableNormalized prop must still enter WebGL2 albedo paging');
    assert.ok(pagedIds.includes('prop:fantasy.tree:whole'), 'pageableNormalized tree must still enter WebGL2 albedo paging');
});

test('cached prop hits still compose live seat relation, surface registration, and harbor mirrorSource', () => {
    const assets = createMockAssets();
    const surfaceImg = fakeImage(256, 232, 'surface:forge');
    assets.getSidecar = (id, channel) => (
        id === 'building.forge' && channel === 'surface' ? surfaceImg : null
    );
    const forgeProp = makePropSprite({ id: 'forge-open-front', width: 48, height: 48, x: 100, y: 200 });
    const renderer = createMockRenderer(assets, {
        _gpuAtlasResident: false,
        gpuWorld: { frontierEnabled: true },
        harborWaterApronTiles: new Set(),
        waterMeta: new Map(),
    });
    const drawable = {
        kind: 'prop',
        sortY: 200,
        buildingId: 'building.forge',
        surfaceCrop: { x: 120, y: 160 },
        payload: { sprite: forgeProp, buildingId: 'building.forge', surfaceCrop: { x: 120, y: 160 } },
    };
    const r1 = buildGpuWorldRecords(renderer, { drawables: [drawable] }).filter(r => r.id.startsWith('prop:'));
    assert.equal(r1.length, 1);
    assert.equal(r1[0].surfaceSource, surfaceImg, 'Frontier surface registration attaches on first emission');
    assert.equal(r1[0].surfaceKey, 'building.forge');
    assert.equal(r1[0].mirrorSource, undefined);

    // Move surfaceCrop and tag tile into harbor apron on cache hit: live surface registration
    // and mirrorSource must reflect the new frame state without stale cached values.
    drawable.surfaceCrop = { x: 140, y: 170 };
    drawable.payload.surfaceCrop = drawable.surfaceCrop;
    drawable.sortY = 225;
    const x = r1[0].x + r1[0].width / 2;
    const y = r1[0].footY;
    const tile = `${Math.round(y / 32 + x / 64)},${Math.round(y / 32 - x / 64)}`;
    renderer.harborWaterApronTiles.add(tile);
    const r2 = buildGpuWorldRecords(renderer, { drawables: [drawable] }).filter(r => r.id.startsWith('prop:'));
    assert.equal(r2.length, 1);
    assert.equal(r2[0].surfaceSource, surfaceImg, 'surface registration composes live on cache hit');
    assert.deepEqual(r2[0].surfaceOffset, [140, 170], 'updated surfaceCrop updates surfaceOffset on hit');
    assert.equal(r2[0].mirrorSource, true, 'harbor apron mirrorSource composes live on hit');
    assert.notEqual(r2[0].depthKey, r1[0].depthKey, 'updated sortY updates depthKey on hit');
});
