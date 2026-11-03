// EF-6 — snow on the still. A body that has stood in one place a long while
// in lying snow holds one course of it on its level tops (hat brims, hoods,
// crowns, pauldrons), never on a staff tip, a mote or a 45° stick; the course
// keeps the body's own light; it clears the moment the body moves; and only
// weather and the body's own stillness drive it, never its status.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { snowCapTexels, SNOW_CAP_MIN_RUN } from '../../claudeville/src/presentation/character-mode/Compositor.js';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

const W = 24;
const H = 20;
const INK = [18, 12, 8];

function cell() {
    const data = new Uint8ClampedArray(W * H * 4);
    const put = (x, y, [r, g, b], a = 255) => data.set([r, g, b, a], (y * W + x) * 4);
    // A hat brim: an ink top edge, one coloured course (lit left, shaded
    // right), an ink underside, closed by ink ends.
    for (let x = 3; x <= 16; x++) {
        put(x, 8, INK);
        put(x, 10, INK);
        put(x, 9, x === 3 || x === 16 ? INK : x <= 9 ? [0x5a, 0x66, 0x80] : [0x2f, 0x32, 0x51]);
    }
    // The baked rim: half-alpha ink just above the brim.
    for (let x = 4; x <= 15; x++) put(x, 7, [28, 20, 16], 128);
    // A staff rising past the brim, one texel wide.
    for (let y = 2; y < H; y++) put(19, y, [0x7a, 0x55, 0x30]);
    // A floating mote.
    for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3]]) put(x, y, [0xf2, 0xd3, 0x6b]);
    // A wand held at 45°.
    for (let k = 0; k < 4; k++) put(20 + k, 12 - k, [0x7a, 0x55, 0x30]);
    return data;
}

test('the snow course lies on the level brim under its ink edge, never on a staff, a mote or a 45° stick', () => {
    const texels = snowCapTexels(cell(), W, H);
    assert.deepEqual(texels.map(([x, y]) => [x, y]), Array.from({ length: 12 }, (_, i) => [4 + i, 9]));
    // The lit half of the course takes the top snow stop, the shaded half the next.
    for (const [x, , color] of texels) assert.equal(color, x <= 9 ? ART_RAMPS.snow[4] : ART_RAMPS.snow[3]);
    assert.ok(SNOW_CAP_MIN_RUN >= 3);
});

test('a cell with no level top holds no snow', () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 4; y < H; y++) data.set([0x7a, 0x55, 0x30, 255], (y * W + 10) * 4);
    assert.deepEqual(snowCapTexels(data, W, H), []);
    assert.deepEqual(snowCapTexels(new Uint8ClampedArray(W * H * 4), W, H), []);
});

function still(overrides = {}) {
    return {
        _stillSince: Date.now() - 6 * 60 * 1000,
        getSnowBucket: () => 1,
        _onOpenFloor: false,
        agent: { status: 'working' },
        ...overrides,
    };
}

test('snow settles only on a body still six minutes in lying snow, from zoom 2, whatever its status', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const settled = (host, zoom = 2) => AgentSprite.prototype._snowSettled.call(host, zoom);
    assert.equal(settled(still()), true);
    assert.equal(settled(still(), 3), true);
    assert.equal(settled(still(), 1), false, 'the overview shows the body as it is');
    assert.equal(settled(still({ _stillSince: Date.now() - 6 * 60 * 1000 + 1 })), false);
    assert.equal(settled(still({ _stillSince: null })), false);
    assert.equal(settled(still({ getSnowBucket: () => 0 })), false);
    assert.equal(settled(still({ getSnowBucket: null })), false);
    assert.equal(settled(still({ _onOpenFloor: true })), false, 'a roof keeps it off');
    assert.equal(settled(still({ agent: { status: 'idle', isDeparted: true } })), false);
    for (const status of ['working', 'waiting', 'idle', 'waiting_on_user', 'errored', 'rate_limited']) {
        assert.equal(settled(still({ agent: { status } })), true, `${status} must not change the weather`);
    }
});

test('stillness starts over the moment the body steps or is moved', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const body = { x: 10, y: 20, moving: false };
    const track = () => AgentSprite.prototype._trackStillness.call(body);
    track();
    track();
    const since = body._stillSince;
    assert.equal(since, Date.now());
    t.mock.timers.tick(60_000);
    track();
    assert.equal(body._stillSince, since, 'standing keeps its start');
    body.moving = true;
    track();
    assert.equal(body._stillSince, null, 'a step clears it');
    body.moving = false;
    track();
    assert.equal(body._stillSince, Date.now());
    body.x = 11;
    track();
    assert.equal(body._stillSince, null, 'a relocation without walking clears it too');
});

test('the resident snow record rides its own body frame, pose cadence and light', () => {
    const body = { alpha: 0.5, poseKey: 'idle:1:', urgentPose: false, bakedGear: false };
    const stamp = { width: 12, height: 1, __cvSnowX: 4, __cvSnowY: 9, __cvSnowKey: 'profile|snow:base:92,552,92,92' };
    const calls = [];
    const host = {
        agent: { id: 'a' },
        _gpuFrameRecord: body,
        _snowCap: { cell: { sx: 92, sy: 552, sw: 92, sh: 92 }, source: null, dx: 100, dy: 200, frame: body },
        _snowCapCell: (...args) => {
            calls.push(args);
            return stamp;
        },
    };
    const record = AgentSprite.prototype._snowCapRecord.call(host);
    assert.equal(record.id, 'agent:a:snow-cap');
    assert.deepEqual([record.x, record.y, record.sw, record.sh], [104, 209, 12, 1]);
    assert.equal(record.source, stamp);
    assert.equal(record.alpha, body.alpha);
    assert.equal(record.poseKey, body.poseKey);
    assert.equal(record.urgentPose, body.urgentPose);
    assert.equal(record.material, materialClassId('fabric'));
    assert.equal(record.emissive, 0);
    assert.equal(calls[0][2], null, 'no baked gear to clear');
    body.bakedGear = true;
    body.urgentPose = true;
    const geared = AgentSprite.prototype._snowCapRecord.call(host);
    assert.equal(calls[1][2], host._snowCap, 'baked front gear is cleared from the course');
    assert.equal(geared.urgentPose, true);
    // A state left by an earlier frame (a LOD or impostor frame since) is never shown.
    host._gpuFrameRecord = { ...body };
    assert.equal(AgentSprite.prototype._snowCapRecord.call(host), null);
});
