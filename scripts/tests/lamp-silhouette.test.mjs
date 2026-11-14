import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LAMP_SILHOUETTE_MAX_HEIGHT,
    POINT_CAST_CAP,
    lampSilhouetteFor,
    pointCastFor,
    setFramePointCastLights,
    setLampSilhouetteMode,
} from '../../claudeville/src/presentation/character-mode/RakingLight.js';
import {
    LAMP_SHADOW_TIP,
    bucketCast,
    rasterSilhouette,
    silhouetteGeometry,
} from '../../claudeville/src/presentation/character-mode/LampSilhouette.js';
import { EFFECT_BUDGET, effectBudgetMode } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

const night = { rake: 0 };
const lamp = (id, x, y, extra = {}) => ({ id, role: 'fixture', x, y, ground: { x, y }, radius: 70, intensity: 0.8, height: 24, ...extra });

test('NL-3: with the mode off a body keeps its stepped trail and records no silhouette', () => {
    setLampSilhouetteMode(false);
    setFramePointCastLights([lamp('lamp', 0, 0)], 1);
    const body = { gpuWorldEnabled: true };
    // A minimal canvas, so the trail rasterizes as it does in the browser.
    const previous = globalThis.document;
    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
                putImageData() {},
            }),
        }),
    };
    try {
        const stamp = pointCastFor(body, 20, 6, 20, night);
        assert.ok(stamp?.canvas, 'the body throws its stepped trail');
        assert.ok(stamp.canvas.width > 0 && stamp.canvas.height > 0);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
    assert.equal(lampSilhouetteFor(body), null);
});

test('NL-3: with the mode on a resident body gets a silhouette instead of the trail, a Canvas body keeps the trail', () => {
    setLampSilhouetteMode(true);
    setFramePointCastLights([lamp('lamp', 0, 0)], 1);
    const resident = { gpuWorldEnabled: true };
    assert.equal(pointCastFor(resident, 20, 6, 20, night), null);
    const cast = lampSilhouetteFor(resident);
    assert.ok(cast && cast.height === 24 && cast.distance > 0 && cast.room > 0);
    const canvasBody = { gpuWorldEnabled: false };
    pointCastFor(canvasBody, 20, 6, 20, night);
    assert.equal(lampSilhouetteFor(canvasBody), null);
    setLampSilhouetteMode(false);
});

test('NL-3: windows throw no silhouette and a carried lantern casts nothing, by rule', () => {
    setLampSilhouetteMode(true);
    setFramePointCastLights([
        lamp('window', 0, 0, { role: 'aperture', height: LAMP_SILHOUETTE_MAX_HEIGHT + 10 }),
        lamp('carried-lantern:x', 30, 0, { radius: 44 }),
    ], 1);
    const body = { gpuWorldEnabled: true };
    assert.equal(pointCastFor(body, 20, 6, 20, night), null);
    assert.equal(lampSilhouetteFor(body), null);
    setLampSilhouetteMode(false);
    // Lanterns throw no trail either.
    setFramePointCastLights([lamp('carried-lantern:x', 0, 0, { radius: 44 })], 1);
    assert.equal(pointCastFor({}, 10, 4, 20, night), null);
    assert.equal(POINT_CAST_CAP, 24);
});

test('NL-3: the shadow points away from the lamp, ends inside the pool and dithers only its tip', () => {
    const cast = { dx: 30, dy: 0, distance: 30, height: 24, room: 70 * 0.85 - 30 - 2 };
    const geometry = silhouetteGeometry(cast, 40);
    assert.ok(geometry.reach <= cast.room + 1e-9);
    // A 10 x 40 solid body standing on (0, 0), the lamp to its west.
    const rect = { x: -5, y: -40, width: 10, height: 40 };
    const texels = [];
    rasterSilhouette({
        footX: 0, footY: 0, rect, top: -40, geometry,
        alphaAt: (bx, by) => (bx >= -5 && bx < 5 && by >= -40 && by <= 0 ? 1 : 0),
        plot: (tx, ty) => texels.push([tx, ty]),
    });
    assert.ok(texels.length > 0);
    assert.ok(texels.every(([tx]) => tx >= -6), 'never toward the lamp');
    assert.ok(Math.max(...texels.map(([tx]) => tx)) <= geometry.reach + 6, 'ends at its reach');
    // The near 1 - TIP of the shadow is solid: no gaps along its axis there.
    const solidEnd = Math.floor(geometry.reach * (1 - LAMP_SHADOW_TIP)) - 1;
    for (let x = 1; x < solidEnd; x++) assert.ok(texels.some(([tx, ty]) => tx === x && ty === 0), `solid at ${x}`);
});

test('NL-3: a body\'s cached silhouette keys on lamp buckets, so a lamp moving under a bucket reuses it', () => {
    const a = bucketCast({ dx: 30, dy: 2, distance: 30.4, height: 24, room: 25.3 });
    const b = bucketCast({ dx: 30, dy: 2.4, distance: 30.9, height: 24, room: 25.9 });
    assert.deepEqual([a.angle, a.distance, a.room], [b.angle, b.distance, b.room]);
    const c = bucketCast({ dx: 0, dy: 30, distance: 30, height: 24, room: 25 });
    assert.notEqual(a.angle, c.angle);
    assert.ok(Math.abs(Math.hypot(a.dx, a.dy) - 1) < 1e-9);
});

test('NL-3: the ladder keeps silhouettes at FULL and REDUCED, trails at MINIMAL', () => {
    assert.ok(EFFECT_BUDGET['lamp-silhouettes']);
    assert.deepEqual([0, 1, 2].map(level => effectBudgetMode('lamp-silhouettes', level)), ['on', 'on', 'off']);
});
