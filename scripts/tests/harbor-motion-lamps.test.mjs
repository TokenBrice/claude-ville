import test from 'node:test';
import assert from 'node:assert/strict';

import { drawHullFallback, hullLampStrip, hullRecords, hullStrip, keepTopLampPerFrame } from '../../claudeville/src/presentation/character-mode/HarborHulls.js';
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

test('M05-5 riding lights: only each frame\'s topmost lamp survives the anchor strip', () => {
    // Two 6-px frames, 8 rows: frame 0 has a masthead lamp (row 1) and a stern
    // lamp (row 6); frame 1 has one lamp only (kept whole).
    const width = 12;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    const lit = (x, y) => { data[(y * width + x) * 4 + 3] = 255; };
    lit(3, 1); lit(4, 1); lit(1, 6); lit(2, 6); lit(9, 4);
    keepTopLampPerFrame(data, width, height, 6);
    const alpha = (x, y) => data[(y * width + x) * 4 + 3];
    assert.equal(alpha(3, 1), 255);
    assert.equal(alpha(4, 1), 255);
    assert.equal(alpha(1, 6), 0);
    assert.equal(alpha(2, 6), 0);
    assert.equal(alpha(9, 4), 255);
});

test('M05-5 riding lights: a moored hull shows its anchor light, a hull under way every lamp', () => {
    const harbor = new HarborTraffic({ sprites: spritesWithLamps() });
    const T = Date.parse('2026-10-15T22:00:00Z');
    const agent = { id: 'a', name: 'A', provider: 'claude', sessionId: 's', projectPath: '/w/ride', gitEvents: [
        { id: 'r1', type: 'commit', project: '/w/ride', branch: 'main', sha: '2'.padStart(40, '0'), label: 'c', timestamp: T - 60_000, success: true, status: 'success' },
    ] };
    harbor.reconcile([agent], T);
    harbor.setLampsLit(true);
    harbor.advance(16);
    const moored = harbor.enumerateHullDrawables(T);
    assert.ok(moored.length > 0);
    for (const item of moored) {
        assert.equal(item.pose.lamps.anchor, true, 'a docked hull rides at anchor');
        assert.ok(item.pose.lamps.key.endsWith(':anchor'), 'its own sidecar texture');
    }
    // The choice reads the ship's own motion only: the same hull under way
    // lights its full strip.
    harbor._shipUnderWay = () => true;
    harbor.advance(16);
    for (const item of harbor.enumerateHullDrawables(T + 16)) assert.notEqual(item.pose.lamps.anchor, true);
});

test('moored hull waterline collars cache per livery without per-frame allocations or texture re-uploads', () => {
    const origDoc = globalThis.document;
    let canvasesCreated = 0;
    let getImageDataCalls = 0;
    function makeCanvas(w = 0, h = 0) {
        canvasesCreated++;
        const canvas = { width: w, height: h, _pixels: new Uint8ClampedArray(w * h * 4) };
        const ensure = () => {
            const need = canvas.width * canvas.height * 4;
            if (!canvas._pixels || canvas._pixels.length !== need) canvas._pixels = new Uint8ClampedArray(need);
        };
        const ctx = {
            save() {},
            restore() {},
            drawImage(src, sx = 0, sy = 0, sw = src.width, sh = src.height) {
                ensure();
                if (!src?._pixels) return;
                for (let y = 0; y < Math.min(sh, canvas.height); y++) {
                    for (let x = 0; x < Math.min(sw, canvas.width); x++) {
                        const si = ((sy + y) * src.width + (sx + x)) * 4;
                        const di = (y * canvas.width + x) * 4;
                        canvas._pixels[di] = src._pixels[si];
                        canvas._pixels[di + 1] = src._pixels[si + 1];
                        canvas._pixels[di + 2] = src._pixels[si + 2];
                        canvas._pixels[di + 3] = src._pixels[si + 3];
                    }
                }
            },
            getImageData(sx = 0, sy = 0, sw = canvas.width, sh = canvas.height) {
                getImageDataCalls++;
                ensure();
                return { width: sw, height: sh, data: new Uint8ClampedArray(canvas._pixels) };
            },
            createImageData(iw, ih) {
                return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
            },
            putImageData(img) {
                ensure();
                canvas._pixels = new Uint8ClampedArray(img.data);
            },
        };
        canvas.getContext = () => ctx;
        return canvas;
    }
    globalThis.document = { createElement: () => makeCanvas(0, 0) };
    try {
        // Six liveried skiffs sharing strip.key with distinct strip.liveryKey & image canvases.
        const strips = Array.from({ length: 6 }, (_, i) => {
            const img = makeCanvas(16 * 5, 16);
            // Paint opaque waterline pixels across x = 4..11 on anchorY = 14 for frame 2.
            for (let x = 4; x <= 11; x++) {
                const idx = (14 * img.width + (2 * 16 + x)) * 4;
                img._pixels[idx] = 80 + i * 10;
                img._pixels[idx + 1] = 50;
                img._pixels[idx + 2] = 30;
                img._pixels[idx + 3] = 255;
            }
            return {
                spriteId: 'prop.harborShip.skiff',
                key: 'prop.harborShip.skiff@nw',
                liveryKey: `prop.harborShip.skiff@nw#livery-${i}`,
                image: img,
                frameWidth: 16,
                frameHeight: 16,
                frameOffset: 0,
                anchorX: 8,
                anchorY: 14,
            };
        });
        const firstPass = strips.map((strip, i) => {
            const recs = hullRecords({ id: `s-${i}`, strip, frame: 2, x: 100 + i * 20, y: 200, bob: 0, sink: 0, alpha: 1, wake: null });
            return recs.find(r => r.id === `ground:collar:s-${i}`);
        });
        for (let i = 0; i < strips.length; i++) {
            assert.ok(firstPass[i], `collar built for livery ${i}`);
            assert.equal(firstPass[i].textureKey, `harbor-collar:${strips[i].liveryKey}|c2`);
        }
        assert.equal(new Set(firstPass.map(r => r.textureKey)).size, 6, 'each livery gets a distinct collar textureKey');

        const allocsAfterWarm = canvasesCreated;
        const readsAfterWarm = getImageDataCalls;
        // Second and third frames across all six liveries must reuse cached collars with zero allocations.
        for (let frame = 0; frame < 2; frame++) {
            for (let i = 0; i < strips.length; i++) {
                const recs = hullRecords({ id: `s-${i}`, strip: strips[i], frame: 2, x: 100 + i * 20, y: 200, bob: 0, sink: 0, alpha: 1, wake: null });
                const collar = recs.find(r => r.id === `ground:collar:s-${i}`);
                assert.equal(collar.source, firstPass[i].source, `livery ${i} reuses cached collar canvas`);
            }
        }
        assert.equal(canvasesCreated, allocsAfterWarm, 'zero per-frame collar canvas allocations');
        assert.equal(getImageDataCalls, readsAfterWarm, 'zero per-frame getImageData calls');

        // Canvas fallback path also reuses cached collars across liveries.
        const drawCtx = { save() {}, restore() {}, drawImage() {}, globalAlpha: 1 };
        const allocsBeforeFallback = canvasesCreated;
        for (let i = 0; i < strips.length; i++) {
            drawHullFallback(drawCtx, { id: `s-${i}`, strip: strips[i], frame: 2, x: 100 + i * 20, y: 200, bob: 0, sink: 0, alpha: 1, wake: null, reflect: false });
        }
        assert.equal(canvasesCreated, allocsBeforeFallback, 'drawHullFallback reuses cached collars per livery');
    } finally {
        globalThis.document = origDoc;
    }
});
