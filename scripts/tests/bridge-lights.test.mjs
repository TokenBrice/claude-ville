// BR-6 / C2 — a bridge sprite's declared light points (its manifest
// `lights`) become static fixture lights at the drawn flames: candle-scale
// pools at the posts' feet, only while the village lamps are lit, the whole
// bridge caught in one step on the Lamplighter's Round, never breathing; its
// flame sidecar redraws over the terrain as an emitter on the same step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { SOURCE_HALO_RADIUS_CAP } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { cacheEmitterRecords } from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';
import { lampSettlingWindows } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { ROUND_SPAN_MIN, roundFraction } from '../../claudeville/src/presentation/character-mode/LamplighterRound.js';
import { tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, spritesRoot } from '../sprites/manifest-utils.mjs';

const CENTRAL_ID = 'bridge.landmark.civic.ns';
const entries = new Map(collectSpriteEntries(loadSpriteManifest()).map((entry) => [entry.id, entry]));
const central = entries.get(CENTRAL_ID);
const date = new Date(2026, 9, 24, 19);
const at = (minuteOfDay) => ({ clock: { minuteOfDay, date } });

// An asset manager over manifest entries: dims, anchor and entry from the
// manifest, a stand-in image for every listed sprite.
function manifestAssets(byId) {
    return {
        has: (id) => byId.has(id),
        get: (id) => (byId.has(id) ? {} : null),
        getEntry: (id) => byId.get(id),
        getDims: (id) => (byId.has(id) ? { w: byId.get(id).width, h: byId.get(id).height } : undefined),
        getAnchor: (id) => byId.get(id)?.anchor ?? [0, 0],
    };
}

// The renderer's real bridge spans (SceneryEngine on the renderer's own
// noise and the real buildings), as static-prop-depth.test.mjs builds them.
function rendererWithBridges(assets = manifestAssets(entries)) {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
    const scenery = new SceneryEngine({
        world: { buildings: new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)])) },
        terrainSeed,
        tileNoise: (x, y) => noise._tileNoise(x, y),
        smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.bridgeTiles = scenery.bridgeTiles;
    renderer.assets = assets;
    renderer.propWinter = { image: () => null };
    renderer.motionScale = 1;
    renderer.bridgeSpans = renderer._buildBridgeSpans();
    return renderer;
}

const bridgeLights = (renderer, lighting = null) => renderer._hearthLightSources(lighting)
    .filter((light) => light.id.startsWith('bridge-light:'));

test('the south bridge declares its four painted candle flames, and only they glow', () => {
    assert.equal(central.lights.length, 4);
    const albedoPath = join(spritesRoot, pathForEntry(central));
    const png = PNG.sync.read(readFileSync(albedoPath));
    const texel = (x, y) => {
        const i = (y * png.width + x) * 4;
        return { rgb: [png.data[i], png.data[i + 1], png.data[i + 2]], a: png.data[i + 3] };
    };
    const gold = (x, y) => {
        const { rgb: [r, g, b], a } = texel(x, y);
        return a > 0 && r === 0xf2 && g === 0xbc && b === 0x57;
    };
    for (const { at: [x, y], height } of central.lights) {
        // `at` sits on the flame: gold flame texels within 2 px of it.
        let flame = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (gold(x + dx, y + dy)) flame++;
        assert.ok(flame >= 3, `${x},${y}: ${flame} gold flame texels nearby`);
        // `height` reaches the post's bottom outline, well below the flame:
        // near-black across the post (two of three columns 2 px apart).
        const dark = [x - 2, x, x + 2].filter((cx) => {
            const { rgb, a } = texel(cx, y + height);
            return a > 0 && Math.max(...rgb) < 0x20;
        });
        assert.ok(height > 24 && dark.length >= 2, `${x},${y} + ${height} lands on the post's foot`);
    }
    // The flame sidecar: every emitting texel lies on a declared flame.
    assert.equal(central.emissiveSidecar, true);
    const sidecar = PNG.sync.read(readFileSync(albedoPath.replace(/\.png$/, '.emissive.png')));
    const perLight = central.lights.map(() => 0);
    for (let y = 0; y < sidecar.height; y++) {
        for (let x = 0; x < sidecar.width; x++) {
            if (!sidecar.data[(y * sidecar.width + x) * 4 + 3]) continue;
            const owner = central.lights.findIndex(({ at }) => Math.abs(x - at[0]) <= 3 && y - at[1] >= -8 && y - at[1] <= 5);
            assert.ok(owner >= 0, `sidecar texel ${x},${y} off every flame`);
            perLight[owner]++;
        }
    }
    for (const count of perLight) assert.ok(count >= 20, `${count} emitting texels on a flame`);
});

test('the declared flames light at their drawn world positions, only while the lamps are lit', () => {
    const renderer = rendererWithBridges();
    renderer._lastAtmosphere = at(12 * 60);
    assert.equal(renderer.villageLampsLit(), false);
    assert.deepEqual(bridgeLights(renderer), [], 'nothing at noon');
    renderer._lastAtmosphere = at(23 * 60);
    const lights = bridgeLights(renderer, { sourceEnergy: { core: 1 } });
    assert.equal(lights.length, central.lights.length);
    // The sprite is drawn with its anchor on the hint tile (18, 24), the
    // deck midpoint's ground point.
    const origin = tileToWorld(18, 24);
    const [anchorX, anchorY] = central.anchor;
    central.lights.forEach(({ at: [sx, sy], height }, index) => {
        const light = lights.find((record) => record.id === `bridge-light:central-river-bridge:${index}`);
        assert.ok(light, `light ${index}`);
        const flame = { x: origin.x - anchorX + sx, y: origin.y - anchorY + sy };
        assert.ok(Math.abs(light.x - flame.x) < 1e-6 && Math.abs(light.y - flame.y) < 1e-6, `light ${index} at the flame`);
        assert.ok(Math.abs(light.ground.x - flame.x) < 1e-6 && Math.abs(light.ground.y - (flame.y + height)) < 1e-6, `light ${index} foot at the post's foot`);
        assert.equal(light.height, height);
        assert.equal(light.role, 'fixture');
        assert.equal(light.ownerId, null);
        // Held steady: no fire breath, candle scale.
        assert.equal(light.fire, false);
        assert.equal(light.fireGroup, null);
        assert.ok(light.radius < 66 && light.radius <= SOURCE_HALO_RADIUS_CAP, `radius ${light.radius}`);
    });
    // The street-lamp pool list carries them (the Canvas pools and the GPU
    // feed both read it).
    renderer._lanternGlowSources = () => [];
    const pools = renderer._lanternGroundLightSources({}).filter((light) => light.id.startsWith('bridge-light:'));
    assert.equal(pools.length, central.lights.length);
});

test('the bridge catches on the Lamplighter\'s Round in one step, flames and pools together', () => {
    const W = lampSettlingWindows();
    const renderer = rendererWithBridges();
    const span = renderer.bridgeSpans.find((entry) => entry.id === 'central-river-bridge');
    const middle = worldToTile((span.start.x + span.end.x) / 2, (span.start.y + span.end.y) / 2);
    const minute = W.duskStart + roundFraction(middle.tileX, middle.tileY) * ROUND_SPAN_MIN;
    renderer._lastAtmosphere = at(minute - 0.05);
    assert.equal(renderer.bridgeLightsLit(span), false);
    assert.equal(bridgeLights(renderer).length, 0, 'the round has not reached the bridge');
    renderer._lastAtmosphere = at(minute + 0.05);
    assert.equal(renderer.bridgeLightsLit(span), true);
    assert.equal(bridgeLights(renderer).length, central.lights.length);
    // Reduced motion keeps the shared lamp clock: lit from the round's start.
    renderer.motionScale = 0;
    renderer._lastAtmosphere = at(minute - 0.05);
    assert.equal(bridgeLights(renderer).length, central.lights.length);
});

test('the flame sidecar redraws over the terrain only while the bridge is lit', () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }) };
    try {
        const sidecar = { width: central.width, height: central.height };
        const assets = { ...manifestAssets(entries), getCompanion: (id, channel) => (id === CENTRAL_ID && channel === 'emissive' ? sidecar : null), assetVersion: 'test' };
        const renderer = rendererWithBridges(assets);
        const flames = () => cacheEmitterRecords(renderer, () => 0).filter((record) => record.id.startsWith('bridge-emitter:'));
        renderer._lastAtmosphere = at(12 * 60);
        assert.deepEqual(flames(), [], 'no record by day: the terrain stands untouched');
        renderer._lastAtmosphere = at(23 * 60);
        const [record] = flames();
        const origin = tileToWorld(18, 24);
        assert.equal(record.x, origin.x - central.anchor[0]);
        assert.equal(record.y, origin.y - central.anchor[1]);
        assert.equal(record.emissiveSource, sidecar);
        assert.equal(record.emissiveGate, 1);
        assert.ok(record.sequence < 0, 'between the terrain and the drawables');
    } finally {
        globalThis.document = previous;
    }
});

test('a new bridge sprite lights by manifest data alone', () => {
    const rustic = {
        id: 'bridge.landmark.rustic.ns',
        width: 224,
        height: 160,
        anchor: [112, 88],
        lights: [{ at: [20, 30], height: 4 }, { at: [200, 120], height: 4, radius: 34 }],
    };
    const renderer = rendererWithBridges(manifestAssets(new Map([...entries, [rustic.id, rustic]])));
    const tiles = [23, 24, 25, 26].map((y) => ({ x: 7, y }));
    const span = renderer._bridgeSpanFromTiles(tiles, 'NS', { bridgeId: 'west-river-plank', style: 'rustic' });
    renderer.bridgeSpans.push(span);
    renderer._lastAtmosphere = at(23 * 60);
    const lights = bridgeLights(renderer).filter((light) => light.id.startsWith('bridge-light:west-river-plank:'));
    assert.equal(lights.length, 2);
    const placement = renderer._bridgeSpritePlacement(span);
    assert.ok(Math.abs(lights[0].x - (placement.x + 20)) < 1e-6 && Math.abs(lights[0].y - (placement.y + 30)) < 1e-6);
    assert.equal(lights[1].radius, 34);
    // A bridge sprite without `lights` throws none.
    const bare = rendererWithBridges(manifestAssets(new Map([[CENTRAL_ID, { ...central, lights: undefined }]])));
    bare._lastAtmosphere = at(23 * 60);
    assert.deepEqual(bridgeLights(bare), []);
});
