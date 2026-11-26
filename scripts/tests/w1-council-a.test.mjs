import test from 'node:test';
import assert from 'node:assert/strict';
import { DISTRICT_PROPS } from '../../claudeville/src/config/scenery.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { cacheEmitterRecords } from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import {
    captureTerrainArtifactFields, terrainArtifactConfiguration, terrainContentHash,
} from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';
import { loadSpriteManifest } from '../sprites/manifest-utils.mjs';

function canvasDocument(t, paint = () => {}) {
    const original = globalThis.document;
    globalThis.document = { createElement() {
        const ctx = {
            xScale: 1, translate() {}, scale(x) { this.xScale *= x; }, setTransform(a) { this.xScale = a; },
            drawImage: paint, getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {},
        };
        return { getContext: () => ctx };
    } };
    t.after(() => {
        if (original) globalThis.document = original;
        else delete globalThis.document;
    });
}

test('Command column flame follows 23:00 → noon → 22:00 while its motion clock is frozen', t => {
    const renderer = new BuildingSprite({ getAnchor: () => [0, 0],
        get: id => id.endsWith('.brazierFlames') ? { width: 66, height: 40 } : null });
    t.after(() => renderer.dispose());
    renderer.motionScale = 0;
    const entry = loadSpriteManifest().buildings.find(b => b.id === 'building.command');
    const command = { type: 'command' };
    const hasFlame = () => renderer.partDrawsFor(entry, command, 0, 0, 'column', null, [], { sx: 90, sw: 66 })
        .some(draw => draw.name === 'brazierFlames');
    for (const [hour, lit] of [[23, true], [12, false], [22, true]]) {
        renderer.atmosphereState = { clock: { minuteOfDay: hour * 60 } };
        renderer.update(16);
        assert.equal(renderer._partClockMs(), 0);
        assert.equal(hasFlame(), lit);
    }
    renderer.atmosphereState.clock.minuteOfDay = 720;
    assert.equal(hasFlame(), false, 'a capture can change the hour between updates');
});

test('cold live frames advance the pass stepper and publish the key and fields together', t => {
    canvasDocument(t);
    globalThis.requestAnimationFrame = () => {};
    t.after(() => { delete globalThis.requestAnimationFrame; });
    let bands = 0;
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        foliageRenderer: { setSeason() {} },
        _terrainCacheBounds: () => ({ x: 0, y: 0, w: 2, h: 2 }),
        _getTerrainCacheMeta: () => ({ singleSurfaceWithinBudget: true }),
        _currentSeasonToken: () => 'summer',
        _terrainBakePasses: [{ id: 'ground-splat', prepare: () => () => ++bands === 3 }],
        _terrainSurfaceSteps: () => [() => { renderer.groundField = { ready: true }; }, () => {}],
        _landTerrainBake() {}, _invalidateIdleFrame() {},
        _drawStaticTerrainSurface: () => assert.fail('synchronous cold bake'),
    });
    for (let i = 0; i < 6; i++) {
        assert.equal(renderer._prepareTerrainArtifactFrame(), false);
        assert.equal(renderer.terrainCacheKey, undefined);
        assert.equal(renderer.groundField, undefined);
    }
    assert.equal(renderer._prepareTerrainArtifactFrame(), true);
    assert.equal(bands, 3);
    assert.ok(renderer.terrainCacheKey && renderer.terrainCacheBaseKey && renderer.terrainCache);
    assert.equal(renderer.groundField.ready, true);
});

test('north farm flames and light feet use the mirrored plank origin with an asymmetric anchor', t => {
    let masked = false;
    canvasDocument(t, function () {
        if (this.globalCompositeOperation === 'destination-in') {
            assert.equal(this.xScale, 1, 'the already mirrored mask must land without a second flip');
            masked = true;
        }
    });
    const farm = 'bridge.landmark.farm.ew';
    const image = { width: 12, height: 10 };
    const lights = [1, 2, 9, 10].map(x => ({ at: [x, 1], height: 4 }));
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        assets: { get: id => id === farm ? image : null, has: id => id === farm,
            getCompanion: () => image, getAnchor: () => [3, 4], getDims: () => ({ w: 12, h: 10 }),
            getEntry: id => id === farm ? { lights, emissiveSidecar: true } : {} },
        bridgeTiles: new Map([['3,7', { bridgeId: 'north-farm-bridge' }]]),
        bridgeLightsLit: () => true,
    });
    const mid = tileToWorld(3, 7.5);
    let pivot, localX;
    renderer._drawMirroredPlankSprite({ save() {}, restore() {}, translate(x) { pivot = x; },
        scale(x) { assert.equal(x, -1); }, drawImage(_img, x) { localX = x; } }, farm, mid.x, mid.y, true);
    const [record] = cacheEmitterRecords(renderer);
    assert.ok(masked);
    assert.equal(record.x, pivot - localX - image.width);
    const fixtures = renderer._bridgeLightFixtures();
    for (const [i, light] of lights.entries()) {
        const foot = tileToWorld(fixtures[i].tileX, fixtures[i].tileY);
        assert.equal(foot.x, record.x + image.width - 1 - light.at[0]);
        assert.equal(foot.y, record.y + light.at[1] + light.height);
    }
    renderer.bridgeLightsLit = () => false;
    assert.deepEqual(cacheEmitterRecords(renderer), []);
});

test('an individual cistern emitter is admitted before the atlas', t => {
    canvasDocument(t);
    const id = 'prop.archiveCistern';
    const image = { width: 1, height: 1 };
    const renderer = { villageLampsLit: () => true, assets: {
        get: name => name === id ? image : null, getEntry: name => ({ emissiveSidecar: name === id }),
        getAnchor: () => [0, 0], getCompanion: () => image,
    } };
    assert.ok(cacheEmitterRecords(renderer).some(record => record.id.startsWith('cache-emitter:' + id)));
});

test('fountain overlay bakes each frame once, sorts on its basin, and stops under snow', t => {
    const painted = [];
    canvasDocument(t, (_sheet, sx) => painted.push(sx));
    const id = 'prop.plazaFountainWater';
    const basin = DISTRICT_PROPS.find(prop => prop.id === 'prop.plazaFountain');
    const saved = { ...basin };
    Object.assign(basin, { layer: 'sorted', tileX: 16, tileY: 20.55 });
    t.after(() => Object.assign(basin, saved));
    const channels = [];
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        assets: { has: candidate => id === candidate, get: () => ({}), getAnchor: () => [40, 72], getDims: () => ({ w: 80, h: 88 }) },
        sprites: { drawSprite() {}, drawCompanion(_ctx, propId, channel) { channels.push([propId, channel]); } },
        _drawPropContactShadow() {}, _winterPropOpts: () => ({}), waterTiles: new Set(), scenery: { isBlockedForTallScenery: () => false },
        isleLandmarks: { buildSprites: () => [] }, villageCalendar: { buildPropSprites: () => [] },
        _buildVillageWallSprites: () => [], _villageGateLanternSprites: () => [],
        _buildVillageWallTerminalSprites: () => [], _buildWatchtowerBeaconBuoySprites: () => [],
        motionScale: 1,
    });
    renderer.assets.getEntry = propId => propId === basin.id ? { materialSidecar: true, occluderSidecar: true } : {};
    const props = renderer._buildDistrictPropSprites();
    const fountain = props.find(sprite => sprite.id === basin.id);
    const overlay = props.find(sprite => sprite.id === id);
    assert.equal(overlay.sortY, fountain.sortY + 0.5);
    assert.equal(overlay.x, fountain.x);
    const [record] = buildGpuWorldRecords({}, { drawables: [{ kind: 'prop', sprite: fountain }] });
    assert.deepEqual(channels, [[basin.id, 'material'], [basin.id, 'occluder']]);
    assert.equal(record.materialSource, fountain._cacheCanvas.material);
    assert.equal(record.occluderSource, fountain._cacheCanvas.occluder);
    assert.equal(record.surfaceCode, true);
    const frames = [];
    for (let i = 0; i < 8; i++) {
        renderer._motionClock = { elapsedMs: i * 250 };
        frames.push(overlay._getCachedCanvas());
    }
    assert.deepEqual(painted, [0, 80, 160, 240]);
    assert.equal(new Set(frames.map(frame => frame.textureKey)).size, 4);
    for (let i = 0; i < 4; i++) assert.equal(frames[i], frames[i + 4]);
    renderer.motionScale = 0;
    assert.equal(overlay._getCachedCanvas(), frames[0]);
    renderer._groundState = { snowCover: 1 };
    assert.equal(overlay._getCachedCanvas(), null);
    overlay.draw({ drawImage: () => assert.fail('snow-covered stream') });
    overlay.releaseCache();
    assert.ok(frames.every(frame => frame.canvas.width === 0));
});

test('artifact capture drops the coast scratch map and keys avenue membership independent of insertion order', async () => {
    const renderer = { _coastBake: { coast: { contactFoot: new Map([[3, [4]]]) } }, _coastField: {},
        groundField: {}, groundPuddleMask: {}, avenueTiles: new Set(['1,2', '2,3']) };
    const fields = captureTerrainArtifactFields(renderer);
    assert.ok(!('contactFoot' in fields.coast.bake.coast));
    assert.ok(renderer._coastBake.coast.contactFoot.has(3));
    const hash = () => terrainContentHash(terrainArtifactConfiguration(renderer).scene, true);
    const first = await hash();
    renderer.avenueTiles = new Set([...renderer.avenueTiles].reverse());
    assert.equal(await hash(), first);
    renderer.avenueTiles.delete('1,2');
    assert.notEqual(await hash(), first);
});
