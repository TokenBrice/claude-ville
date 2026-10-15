import test from 'node:test';
import assert from 'node:assert/strict';

import { hullLampStrip, hullRecords, hullStrip } from '../../claudeville/src/presentation/character-mode/HarborHulls.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { hullSprites } from './support/harbor-sim.mjs';

// 5.3 night lamps: the emissive sidecar rides the hull record (not its
// reflection), per view, gated by the village lamp clock.

function spritesWithLamps() {
    const sprites = hullSprites();
    const lamps = new Map();
    const assets = sprites.assets;
    return {
        assets: {
            ...assets,
            getEntry(id) {
                const entry = assets.getEntry(id);
                return entry ? { ...entry, emissiveSidecar: true, emissive: { strength: 0.8 } } : entry;
            },
            getCompanion(id, channel) {
                if (channel !== 'emissive') return null;
                const image = assets.get(id);
                if (!image) return null;
                if (!lamps.has(id)) lamps.set(id, { width: image.width, height: image.height, lamps: true });
                return lamps.get(id);
            },
        },
    };
}

test('an authored view reads the sidecar with the albedo\'s own layout', () => {
    const { assets } = spritesWithLamps();
    const strip = hullStrip(assets, 'prop.harborShip.galleon', 'nw');
    const lamps = hullLampStrip(assets, strip);
    assert.equal(lamps.image, assets.getCompanion('prop.harborShip.galleon', 'emissive'));
    assert.equal(lamps.image.width, strip.image.width, 'same source rect as the albedo');
    assert.equal(lamps.strength, 0.8);
    assert.equal(hullLampStrip(assets, strip), lamps, 'cached per view');
});

test('a hull without a sidecar has no lamps', () => {
    const { assets } = hullSprites();
    assert.equal(hullLampStrip(assets, hullStrip(assets, 'prop.harborShip.skiff', 'sw')), null);
});

test('lit lamps ride the hull record as its emissive channel; the reflection takes none', () => {
    const { assets } = spritesWithLamps();
    const strip = hullStrip(assets, 'prop.harborShip.sloop', 'sw');
    const lamps = hullLampStrip(assets, strip);
    const records = hullRecords({ id: 's', strip, frame: 2, x: 100, y: 200, bob: 0, sink: 0, alpha: 1, lamps, wake: null });
    const hull = records.find(record => record.id === 'harbor:hull:s');
    const reflection = records.find(record => record.reflect);
    assert.equal(hull.emissiveSource, lamps.image);
    assert.equal(hull.emissiveGate, 0.8);
    assert.ok(hull.sidecarKey.includes('lamps'));
    assert.equal(reflection.emissiveSource, undefined);
    const dark = hullRecords({ id: 's', strip, frame: 2, x: 100, y: 200, alpha: 1, lamps: null, wake: null });
    assert.equal(dark.find(record => record.id === 'harbor:hull:s').emissiveSource, undefined);
});

test('the lamp clock lights every hull at night and none by day', () => {
    const harbor = new HarborTraffic({ sprites: spritesWithLamps() });
    const T = Date.parse('2026-10-15T22:00:00Z');
    const agent = { id: 'a', name: 'A', provider: 'claude', sessionId: 's', projectPath: '/w/lamps', gitEvents: [
        { id: 'c1', type: 'commit', project: '/w/lamps', branch: 'main', sha: '1'.padStart(40, '0'), label: 'c', timestamp: T - 60_000, success: true, status: 'success' },
    ] };
    harbor.reconcile([agent], T);
    harbor.setLampsLit(true);
    harbor.advance(16);
    assert.ok(harbor.enumerateHullDrawables(T).every(item => item.pose.lamps));
    harbor.setLampsLit(false);
    harbor.advance(16);
    assert.ok(harbor.enumerateHullDrawables(T + 16).every(item => !item.pose.lamps));
});

test('lamp light is budget-capped, leads and the largest hulls first, and dark by day', () => {
    const harbor = new HarborTraffic({ sprites: spritesWithLamps() });
    const T = Date.parse('2026-10-15T22:00:00Z');
    const agents = Array.from({ length: 8 }, (_, r) => ({ id: `a${r}`, name: `A${r}`, provider: 'claude', sessionId: `s${r}`, projectPath: `/w/lamp-${r}`,
        gitEvents: [0, 1].map(c => ({ id: `l-${r}-${c}`, type: 'commit', project: `/w/lamp-${r}`, branch: c ? 'feat/x' : 'main', sha: `${r}${c}`.padStart(40, '0'), label: 'c', timestamp: T - 60_000 + c, success: true, status: 'success' })) }));
    harbor.reconcile(agents, T);
    harbor.setLampsLit(true);
    harbor.advance(16);
    const items = harbor.enumerateHullDrawables(T);
    assert.ok(items.length > 12);
    const lights = harbor.lampLightSources(1);
    assert.equal(lights.length, 12);
    for (const light of lights) {
        assert.equal(light.role, 'fixture', 'a fixture: it lays a lamp column on the water');
        assert.ok(light.intensity > 0 && light.intensity < 1);
        assert.ok(light.radius <= 24);
    }
    assert.deepEqual(harbor.lampLightSources(0), [], 'no light without source energy');
    harbor.setLampsLit(false);
    assert.deepEqual(harbor.lampLightSources(1), []);
});
