import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MATERIAL_CLASS_IDS,
    companionPathFor,
    defaultChannelPixel,
    normalizeMaterialMetadata,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    buildGpuRecordsFromDrawables,
    createDepthDrawable,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import {
    BUILDING_MATERIAL_REGISTRY,
    getBuildingMaterial,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { SpriteRenderer } from '../../claudeville/src/presentation/character-mode/SpriteRenderer.js';
import { AssetManager } from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import {
    packFrames,
    stableJson,
} from '../sprites/atlas-packing.mjs';

test('material class ids and generated default pixels stay stable', () => {
    assert.deepEqual(MATERIAL_CLASS_IDS, {
        unlit: 0,
        stone: 1,
        timber: 2,
        metal: 3,
        foliage: 4,
        fabric: 5,
        earth: 6,
        cobble: 7,
        water: 8,
        'glass-rune': 9,
        fire: 10,
    });
    assert.deepEqual(defaultChannelPixel('material', 'water', 128), [8, 0, 0, 128]);
    assert.deepEqual(defaultChannelPixel('emissive', 'fire', 255), [0, 0, 0, 0]);
    assert.deepEqual(defaultChannelPixel('occluder', 'stone', 128), [0, 128, 0, 128]);
});

test('missing companion declarations stay absent and true uses deterministic paths', () => {
    const entry = { id: 'building.command' };
    assert.equal(companionPathFor(entry, 'emissive', 'assets/sprites/buildings/building.command/base.png'), null);
    assert.equal(
        companionPathFor(
            { ...entry, emissiveSidecar: true },
            'emissive',
            'assets/sprites/buildings/building.command/base.png',
        ),
        'assets/sprites/buildings/building.command/base.emissive.png',
    );
    assert.equal(
        companionPathFor({ ...entry, emissiveSidecar: 'custom/glow.png' }, 'emissive', 'ignored.png'),
        'custom/glow.png',
    );
});

test('material normalization supplies safe non-emissive defaults', () => {
    const defaults = normalizeMaterialMetadata({ id: 'prop.unknown' });
    assert.equal(defaults.materialId, 'prop.unknown');
    assert.equal(defaults.materialClass, 'unlit');
    assert.equal(defaults.emissive.strength, 0);
    assert.equal(defaults.occluder.mode, 'alpha-silhouette');
    assert.deepEqual(defaults.elevation, { base: 0, top: 0, unit: 'sprite-px' });
});

test('all nine building pilots expose named emissive material sources', () => {
    const expected = [
        'archive', 'command', 'forge', 'harbor', 'mine',
        'portal', 'taskboard', 'tavern', 'watchtower',
    ];
    assert.deepEqual(Object.keys(BUILDING_MATERIAL_REGISTRY).sort(), expected);
    const sourceIds = [];
    for (const type of expected) {
        const material = getBuildingMaterial(type);
        assert.equal(material.materialId, `building.${type}`);
        assert.notEqual(material.materialClass, 'unlit');
        assert.ok(material.emissive.sources.length >= 1);
        sourceIds.push(...material.emissive.sources.map((source) => source.id));
    }
    assert.equal(new Set(sourceIds).size, sourceIds.length);
});

test('drawable Canvas fallback is preserved while GPU records are additive', () => {
    const calls = [];
    const payload = {
        id: 'building.command',
        entry: {
            id: 'building.command',
            materialClass: 'stone',
            elevation: { base: 0, top: 208, unit: 'sprite-px' },
        },
    };
    const drawable = createDepthDrawable(
        'building',
        Number.NaN,
        payload,
        (ctx, zoom, context, source) => calls.push({ ctx, zoom, context, source }),
        {
            salience: 'primary',
            buildGpuRecord: () => ({ type: 'sprite-quad', assetId: 'building.command' }),
        },
    );
    const ctx = {};
    const context = { frame: 1 };
    drawable.draw(ctx, 2, context);
    assert.deepEqual(calls, [{ ctx, zoom: 2, context, source: payload }]);
    assert.equal(drawable.sortY, 0);
    assert.equal(drawable.materialClass, 'stone');
    assert.equal(drawable.salience, 'primary');
    assert.deepEqual(buildGpuRecordsFromDrawables([drawable]), [{
        kind: 'building',
        sortY: 0,
        sortBand: 95,
        stableKey: 'building.command',
        salience: 'primary',
        materialId: 'building.command',
        materialClass: 'stone',
        elevation: { base: 0, top: 208, unit: 'sprite-px' },
        emissive: { strength: 0, sources: [] },
        occluder: { mode: 'alpha-silhouette', strength: 1 },
        atlasFrame: null,
        type: 'sprite-quad',
        assetId: 'building.command',
        drawOrder: 0,
    }]);
});

test('SpriteRenderer GPU placement matches Canvas integer anchor rounding', () => {
    const drawCalls = [];
    const assets = {
        get: () => ({ width: 32, height: 32 }),
        getDims: () => ({ w: 32, h: 32 }),
        getAnchor: () => [16, 28],
        getEntry: () => ({ id: 'prop.lantern', materialClass: 'metal' }),
        getAtlasFrame: () => ({ atlas: 'world-pilot', key: 'prop.lantern', rect: { x: 2, y: 2, w: 32, h: 32 } }),
        getMaterialChannels: () => ({ albedo: {}, material: null, emissive: null, occluder: null }),
    };
    const renderer = new SpriteRenderer(assets);
    renderer.drawSprite({
        globalAlpha: 1,
        drawImage: (...args) => drawCalls.push(args),
    }, 'prop.lantern', 100.4, 75.6);
    const record = renderer.buildGpuRecord('prop.lantern', 100.4, 75.6);
    assert.equal(drawCalls.length, 1);
    assert.deepEqual(drawCalls[0].slice(1), [84, 48]);
    assert.deepEqual(record.destination, { x: 84, y: 48, w: 32, h: 32 });
    assert.equal(record.sampling, 'nearest');
    assert.equal(record.materialClass, 'metal');
    assert.equal(record.material, MATERIAL_CLASS_IDS.metal);
    assert.deepEqual({ sx: record.sx, sy: record.sy, sw: record.sw, sh: record.sh }, {
        sx: 0, sy: 0, sw: 32, sh: 32,
    });
});

test('SpriteRenderer addresses character atlas frames in frame-local coordinates', () => {
    const atlas = { width: 2048, height: 2048 };
    const assets = {
        assetVersion: 'fixture',
        get: () => ({ width: 736, height: 920 }),
        getDims: () => ({ w: 736, h: 920 }),
        getAnchor: () => [46, 80],
        getEntry: () => ({
            id: 'agent.claude.opus',
            materialClass: 'fabric',
            atlasFrame: { atlas: 'world-pilot', keyPrefix: 'agent.claude.opus' },
        }),
        getAtlasFrame: () => ({
            atlas: 'world-pilot',
            key: 'agent.claude.opus/walk/s/0',
            rect: { x: 400, y: 700, w: 92, h: 92 },
        }),
        getAtlas: (_id, channel) => channel === 'albedo' ? atlas : null,
        getMaterialChannels: () => ({}),
    };
    const record = new SpriteRenderer(assets).buildGpuRecord('agent.claude.opus', 100, 100, {
        frameKey: 'walk/s/0',
        sourceRect: { x: 184, y: 276, w: 92, h: 92 },
    });
    assert.equal(record.source, atlas);
    assert.deepEqual({ sx: record.sx, sy: record.sy, sw: record.sw, sh: record.sh }, {
        sx: 400, sy: 700, sw: 92, sh: 92,
    });
    assert.deepEqual(record.destination, { x: 54, y: 20, w: 92, h: 92 });
});

test('AssetManager optional material misses never enter the albedo placeholder set', async () => {
    const manager = new AssetManager({ materialAssets: true });
    manager._entriesCache = [{ id: 'prop.test', emissiveSidecar: true }];
    manager._entryById.set('prop.test', manager._entriesCache[0]);
    manager.manifest = { atlases: [] };
    manager.dimensions.set('prop.test', { w: 16, h: 16 });
    manager._loadOptionalImage = async () => ({ img: null, ok: false, reason: 'fixture missing' });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await manager._decodeMaterialAssets({
            signal: new AbortController().signal,
            generation: manager._loadGeneration,
        }), true);
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(manager.getCompanion('prop.test', 'emissive'), null);
    assert.equal(manager.missing.has('prop.test'), false);
    assert.equal(manager.materialDebugSnapshot().optionalMisses.length, 1);
    manager.dispose();
    assert.equal(manager.cacheStats().atlasImages, 0);
});

test('atlas packing and canonical metadata are deterministic', () => {
    const frames = [
        { key: 'small', w: 8, h: 8 },
        { key: 'wide', w: 20, h: 6 },
        { key: 'tall', w: 6, h: 20 },
    ];
    const first = packFrames(structuredClone(frames), { maxWidth: 32, padding: 1, powerOfTwo: true });
    const second = packFrames(structuredClone(frames).reverse(), { maxWidth: 32, padding: 1, powerOfTwo: true });
    assert.equal(stableJson(first), stableJson(second));
    assert.equal(first.width, 32);
    assert.equal(first.height, 32);
    assert.equal(first.frames[0].key, 'tall');
    assert.equal(
        stableJson({ z: 1, a: { y: 2, x: 3 } }),
        stableJson({ a: { x: 3, y: 2 }, z: 1 }),
    );
});

// EN-2 — Command's oak gate, iron straps, gilt crest and braziers, and the
// Tavern's oak arcade, bar and half-timbering, carry their own classes in the
// committed world atlas (they were all stone), and the roof slate stays stone.
test('Command and Tavern facades carry timber and metal in the world atlas', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { PNG } = createRequire(import.meta.url)('pngjs');
    const root = new URL('../../claudeville/assets/sprites/', import.meta.url);
    const atlas = JSON.parse(readFileSync(new URL('atlases/world-pilot.json', root)));
    const material = PNG.sync.read(readFileSync(new URL('atlases/world-pilot.material.png', root)));
    const count = (id) => {
        const { rect } = atlas.frames[id];
        const classes = {};
        for (let y = 0; y < rect.h; y++) {
            for (let x = 0; x < rect.w; x++) {
                const i = ((rect.y + y) * material.width + rect.x + x) * 4;
                if (material.data[i + 3]) classes[material.data[i]] = (classes[material.data[i]] || 0) + 1;
            }
        }
        return classes;
    };
    const command = count('building.command');
    const tavern = count('building.tavern');
    assert.ok(command[MATERIAL_CLASS_IDS.timber] > 1000, 'Command oak gate leaves are timber');
    assert.ok(command[MATERIAL_CLASS_IDS.metal] > 500, 'Command straps, crest and braziers are metal');
    assert.ok(command[MATERIAL_CLASS_IDS.stone] > 30000, 'Command masonry and roofs stay stone');
    assert.ok(tavern[MATERIAL_CLASS_IDS.timber] > 15000, 'the Tavern oak is timber');
    assert.ok(tavern[MATERIAL_CLASS_IDS.stone] > 15000, 'the Tavern ashlar, plaster and slate stay stone');
    assert.ok(command[MATERIAL_CLASS_IDS.fabric] > 400, 'the Command wall banners are fabric');
    for (const cls of ['foliage', 'glass-rune', 'fire']) {
        assert.equal(command[MATERIAL_CLASS_IDS[cls]] ?? 0, 0, `no ${cls} on Command (roof-snow exclusions unchanged)`);
    }
    for (const cls of ['foliage', 'fabric', 'glass-rune', 'fire']) {
        assert.equal(tavern[MATERIAL_CLASS_IDS[cls]] ?? 0, 0, `no ${cls} on the Tavern (roof-snow exclusions unchanged)`);
    }
    // The banners hang on walls: no roof (surface face 3) texel takes fabric.
    const occluder = PNG.sync.read(readFileSync(new URL('buildings/building.command/base.occluder.png', root)));
    const sidecar = PNG.sync.read(readFileSync(new URL('buildings/building.command/base.material.png', root)));
    for (let p = 0; p < sidecar.width * sidecar.height; p++) {
        if (sidecar.data[p * 4 + 3] && sidecar.data[p * 4] === MATERIAL_CLASS_IDS.fabric) {
            assert.notEqual(occluder.data[p * 4 + 2] >> 6, 3, 'a banner texel on the roof');
        }
    }
});

// EN-2 — the ramp edits: no facade fitting keeps the ashlar mauve or the
// plum oak, except the texels the roof guard holds (a recolour there would
// move the roof class or snow-cap mask: the Tavern fascia).
test('Command and Tavern fittings sit on the oak and iron ramps', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { PNG } = createRequire(import.meta.url)('pngjs');
    const { facadeAlbedo } = await import('../sprites/paint-facade-materials.mjs');
    const root = new URL('../../claudeville/assets/sprites/buildings/', import.meta.url);
    const read = (type, name) => PNG.sync.read(readFileSync(new URL(`building.${type}/${name}`, root)));
    for (const type of ['command', 'tavern']) {
        const albedo = read(type, 'base.png');
        const material = read(type, 'base.material.png');
        const unguarded = facadeAlbedo(albedo, material);
        const guarded = facadeAlbedo(albedo, material, { occluder: read(type, 'base.occluder.png'), emissive: read(type, 'base.emissive.png') });
        assert.equal(guarded.changed, 0, `${type}: fittings still off the oak/iron ramps`);
        assert.ok(unguarded.changed <= (type === 'tavern' ? 110 : 0), `${type}: only the guarded fascia keeps its colour (${unguarded.changed})`);
    }
});

// NE v0.67.1 E — brighter lamp heads and fires: boosted prop.lantern, Forge,
// and Mine emissive sidecars match world-pilot.emissive.png and the
// emissive-sidecars rule while daytime remains low/unlit.
test('NE v0.67.1 E: boosted lantern, Forge, and Mine emissive sidecars match world-pilot atlas while daytime stays gated', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { PNG } = createRequire(import.meta.url)('pngjs');
    const { ART_RAMPS } = await import('../../claudeville/src/config/artPalette.js');
    const { SOURCE_ENERGY_BUCKETS } = await import('../../claudeville/src/presentation/character-mode/AtmosphereState.js');
    const { lampsLitAt } = await import('../../claudeville/src/presentation/character-mode/BuildingSprite.js');
    const { PROP_SIDECAR_RULES, hexToRgb } = await import('../sprites/emissive-sidecars.mjs');
    const { loadSpriteManifest } = await import('../sprites/manifest-utils.mjs');

    const root = new URL('../../claudeville/assets/sprites/', import.meta.url);
    const readPng = (rel) => PNG.sync.read(readFileSync(new URL(rel, root)));
    const manifest = loadSpriteManifest();
    assert.notEqual(manifest.style.assetVersion, '2026-11-23-harbor-v1-restored', 'assetVersion bumped for E sidecar PNG changes');

    // W1-C 1.4 prop.lantern (32x44): 48 lit texels on ART_RAMPS.emissive inside [14,7,6,8] at alpha 200.
    const lanternRule = PROP_SIDECAR_RULES['prop.lantern'];
    assert.deepEqual(lanternRule.rect, [14, 7, 6, 8]);
    assert.equal(lanternRule.alpha, 200);
    const rampRgb = ART_RAMPS.emissive.map(hexToRgb);
    const lanternAlbedo = readPng('props/prop.lantern.png');
    const lanternEmissive = readPng('props/prop.lantern.emissive.png');
    const [rx, ry, rw, rh] = lanternRule.rect;
    let lanternLit = 0;
    for (let y = 0; y < lanternEmissive.height; y++) {
        for (let x = 0; x < lanternEmissive.width; x++) {
            const i = (y * lanternEmissive.width + x) * 4;
            const a = lanternEmissive.data[i + 3];
            const inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
            if (!inside) {
                assert.equal(a, 0, `prop.lantern emissive outside head rect at ${x},${y}`);
                continue;
            }
            lanternLit++;
            assert.ok(lanternAlbedo.data[i + 3] >= a, `prop.lantern alpha inside albedo at ${x},${y}`);
            assert.equal(a, 200, `prop.lantern alpha 200 at ${x},${y}`);
            const expectedRgb = rampRgb[lanternRule.stops[y - ry][x - rx]];
            assert.deepEqual([lanternEmissive.data[i], lanternEmissive.data[i + 1], lanternEmissive.data[i + 2]], expectedRgb,
                `prop.lantern ramp stop at ${x},${y}`);
        }
    }
    assert.equal(lanternLit, 48);

    // Forge (alphas 175 & 210) and Mine (alphas 145, 155, 200).
    const alphaHistogram = (png) => {
        const counts = {};
        for (let i = 3; i < png.data.length; i += 4) {
            const a = png.data[i];
            if (a > 0) counts[a] = (counts[a] || 0) + 1;
        }
        return counts;
    };
    const forgeEmissive = readPng('buildings/building.forge/base.emissive.png');
    const mineEmissive = readPng('buildings/building.mine/base.emissive.png');
    assert.deepEqual(alphaHistogram(forgeEmissive), { 175: 127, 210: 1741 });
    assert.deepEqual(alphaHistogram(mineEmissive), { 145: 724, 155: 705, 200: 100 });

    // Re-baked world-pilot.emissive.png matches all three sidecars pixel-for-pixel.
    const atlas = JSON.parse(readFileSync(new URL('atlases/world-pilot.json', root), 'utf8'));
    const atlasEmissive = readPng('atlases/world-pilot.emissive.png');
    for (const [key, sidecar] of [
        ['prop.lantern', lanternEmissive],
        ['building.forge', forgeEmissive],
        ['building.mine', mineEmissive],
    ]) {
        const { rect } = atlas.frames[key];
        assert.deepEqual([rect.w, rect.h], [sidecar.width, sidecar.height], `${key} atlas frame size`);
        for (let y = 0; y < rect.h; y++) {
            for (let x = 0; x < rect.w; x++) {
                const si = (y * sidecar.width + x) * 4;
                const ai = ((rect.y + y) * atlasEmissive.width + rect.x + x) * 4;
                for (let ch = 0; ch < 4; ch++) {
                    assert.equal(atlasEmissive.data[ai + ch], sidecar.data[si + ch], `${key} atlas emissive matches sidecar at ${x},${y} ch ${ch}`);
                }
            }
        }
    }

    // Daytime stays gated: street lamps are off by day and daylight core energy stays 0.14.
    assert.equal(lampsLitAt({ clock: { minuteOfDay: 12 * 60 } }), false, 'street lanterns stay off at noon');
    assert.equal(SOURCE_ENERGY_BUCKETS.daylight.core, 0.14, 'daylight core energy stays unchanged at 0.14');
});
