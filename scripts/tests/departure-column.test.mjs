// EF-2 — the column takes them home. A walk out that reaches the gate's arch
// mouth ends in the arrival's mirror: the body goes at once and its captured
// silhouette stands flat in violet while the column rises (200 ms), one cream
// rim frame (80 ms), the column sinks with dust (520 ms), and the departure
// sigil is the residue. The light belongs to the column. Reduced motion keeps
// the sigil only, unlit; a frame gap never replays a departure.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ArrivalDepartureController, departureFrame } from '../../claudeville/src/presentation/character-mode/ArrivalDeparture.js';
import { MAGIC_RAMP, PEAK } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const AGENT = Object.freeze({ id: 'lane-05', provider: 'claude' });

function body(id = AGENT.id, { x = 100, y = 200 } = {}) {
    return { agent: { id, provider: 'claude' }, x, y, direction: 2, released: 0, releaseRenderResources() { this.released++; } };
}

function departureLights(controller, now) {
    return controller.getLightSources({ now }).filter(light => String(light.id).startsWith('departure:'));
}

// A recording 2D context: what each frame paints, in order.
function recorder() {
    const calls = [];
    return {
        calls,
        save() {}, restore() {},
        set fillStyle(value) { calls.push(['fill', value]); },
        set globalAlpha(value) { calls.push(['alpha', value]); },
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: false,
        fillRect(...args) { calls.push(['rect', ...args]); },
        drawImage(image) { calls.push(['image', image.id]); },
    };
}

test('the timeline: three rising steps, one cream rim frame, three sinking steps', () => {
    const at = age => departureFrame(age);
    for (const [age, step, height] of [[0, 0, 12], [66, 0, 12], [67, 1, 24], [134, 2, 36], [199, 2, 36]]) {
        const frame = at(age);
        assert.equal(frame.phase, 'anticipation', `${age} ms`);
        assert.equal(frame.step, step, `${age} ms`);
        assert.equal(frame.column.height, height, `${age} ms`);
        assert.equal(frame.body, 'flat', 'the body is its flat violet silhouette while the column rises');
        assert.equal(frame.ring.tone, PEAK);
        assert.equal(frame.dust, false);
    }
    for (const age of [200, 279]) {
        const frame = at(age);
        assert.equal(frame.phase, 'peak');
        assert.equal(frame.body, 'rim', 'one cream rim frame is the body\'s last');
        assert.equal(frame.column.height, 44);
        assert.equal(frame.column.core, PEAK);
    }
    const sink = [280, 454, 627].map(at);
    assert.deepEqual(sink.map(frame => [frame.phase, frame.step]), [['follow', 0], ['follow', 1], ['follow', 2]]);
    assert.deepEqual(sink.map(frame => frame.column.height), [30, 16, 6], 'the column sinks into the stones');
    assert.ok(sink.every(frame => frame.body === null && frame.dust), 'no body after the peak; dust kicks');
    assert.deepEqual(sink.map(frame => frame.ring?.tone ?? null), [MAGIC_RAMP[1], MAGIC_RAMP[0], null]);
    assert.equal(at(799).phase, 'follow');
    assert.equal(at(800).phase, 'done', 'Medium: 800 ms active, under the 1.2 s bound');
    assert.equal(at(-1).phase, 'done');
});

test('the column lays the departure sigil where it stood, dated from its own clock', () => {
    const controller = new ArrivalDepartureController();
    const moment = controller.beginDeparture(AGENT, body(), { now: 1_000 });
    assert.ok(moment);
    assert.deepEqual(moment.point, { x: 100, y: 200 });
    assert.equal(controller.sigils.length, 0, 'no sigil while the column plays');
    controller.update(1_799);
    assert.equal(controller.departures.size, 1);
    controller.update(1_850);
    assert.equal(controller.departures.size, 0);
    assert.equal(controller.sigils.length, 1);
    const [sigil] = controller.sigils;
    assert.equal(sigil.startedAt, 1_800, 'the residue starts when the follow ends, not when update noticed');
    assert.equal(sigil.glow, true);
    assert.deepEqual([sigil.x, sigil.y, sigil.duration], [100, 200, 12_000]);
});

test('a long gap never replays the column or restarts its sigil', () => {
    const controller = new ArrivalDepartureController();
    controller.beginDeparture(AGENT, body(), { now: 1_000 });
    controller.update(1_000 + 60_000);
    assert.equal(controller.departures.size, 0);
    assert.equal(controller.sigils.length, 0, 'its sigil ran out while nothing was drawn');
    assert.deepEqual(departureLights(controller, 61_000), []);
});

test('the light belongs to the column: it rises and sinks with it, then fades with the sigil', () => {
    const controller = new ArrivalDepartureController();
    assert.deepEqual(departureLights(controller, 0), [], 'no light before the column');
    controller.beginDeparture(AGENT, body(), { now: 1_000 });
    const lightAt = now => departureLights(controller, now);
    assert.deepEqual(lightAt(1_000).map(light => [light.y, light.alpha]), [[194, 0.18]], 'the first step, 12 high');
    assert.deepEqual(lightAt(1_200).map(light => light.y), [178], 'the peak column, 44 high');
    assert.deepEqual(lightAt(1_700).map(light => light.y), [197], 'sunk to its last step');
    controller.update(1_800);
    const glow = now => lightAt(now).map(light => Number(light.alpha.toFixed(3)));
    assert.deepEqual(glow(1_800), [0.16], 'the sigil keeps a ground glow, never brighter than the column');
    assert.deepEqual(glow(1_800 + 4_000), [0.106]);
    assert.deepEqual(glow(1_800 + 8_000), [0.053]);
    assert.deepEqual(glow(1_800 + 12_000), [], 'and it ends with the sigil');
    assert.equal(lightAt(1_800)[0].y, 200, 'on the ground where the column sank');
});

test('a column that sinks between update and render hands over with no dropped frame', () => {
    const controller = new ArrivalDepartureController();
    controller.beginDeparture(AGENT, body(), { now: 1_000 });
    controller.update(1_799);
    const light = departureLights(controller, 1_803);
    assert.deepEqual(light.map(entry => Number(entry.alpha.toFixed(3))), [0.16], 'the glow, not a dark frame');
    const ctx = recorder();
    controller.draw(ctx, { now: 1_803 });
    assert.ok(ctx.calls.some(call => call[0] === 'fill' && call[1] === MAGIC_RAMP[0]), 'the sigil, not a blank frame');
    controller.update(1_820);
    assert.equal(`departure:${controller.sigils[0].id}`, light[0].id, 'the same light carries on');
    // A column that has not begun (an earlier clock) lays nothing early.
    const early = new ArrivalDepartureController();
    early.beginDeparture(AGENT, body(), { now: 1_000 });
    const before = recorder();
    early.draw(before, { now: 999 });
    assert.deepEqual(before.calls.filter(call => call[0] === 'rect'), []);
    assert.deepEqual(departureLights(early, 999), []);
});

test('reduced motion keeps the sigil only, unlit', () => {
    const controller = new ArrivalDepartureController({ motionScale: 0 });
    assert.equal(controller.beginDeparture(AGENT, body(), { now: 1_000 }), null);
    const sigil = controller.recordDeparture(AGENT, { tileX: 19, tileY: 39 }, { now: 1_000 });
    assert.equal(sigil.duration, 6_000);
    assert.equal(sigil.glow, false);
    assert.deepEqual(departureLights(controller, 1_000), [], 'no column, so no light');

    const switched = new ArrivalDepartureController();
    switched.beginDeparture(AGENT, body(), { now: 1_000 });
    switched.setMotionScale(0);
    assert.equal(switched.departures.size, 0, 'a rising column stops at once');
    assert.equal(switched.sigils.length, 1);
    assert.equal(switched.sigils[0].glow, false);
});

test('arrival and departure columns share the six-column budget', () => {
    const controller = new ArrivalDepartureController();
    for (let i = 0; i < 6; i++) controller.beginDeparture({ id: `d${i}` }, body(`d${i}`), { now: 1_000 });
    assert.equal(controller.beginDeparture({ id: 'd6' }, body('d6'), { now: 1_000 }), null);
    assert.equal(controller.beginAgentArrival({ id: 'a0' }, body('a0'), { now: 1_000 }), null, 'the gate is full');
    controller.update(1_800);
    assert.ok(controller.beginAgentArrival({ id: 'a0' }, body('a0'), { now: 1_800 }), 'free again once they sink');
});

test('each phase paints the captured silhouette it owns, never the body', () => {
    const controller = new ArrivalDepartureController();
    const moment = controller.beginDeparture(AGENT, body(), { now: 0 });
    moment.flat = { canvas: { id: 'flat' }, minX: 0, maxX: 10, minY: 0, maxY: 30 };
    moment.rim = { canvas: { id: 'rim' }, minX: 0, maxX: 10, minY: 0, maxY: 30 };
    const paints = now => {
        const ctx = recorder();
        controller.draw(ctx, { now });
        return ctx.calls.filter(call => call[0] === 'image').map(call => call[1]);
    };
    assert.deepEqual(paints(0), ['flat']);
    assert.deepEqual(paints(240), ['rim']);
    assert.deepEqual(paints(500), []);
    const ctx = recorder();
    controller.draw(ctx, { now: 240 });
    const fills = ctx.calls.filter(call => call[0] === 'fill').map(call => call[1]);
    assert.ok(fills.includes(PEAK) && fills.includes(MAGIC_RAMP[0]), 'the peak column carries a cream core');
});

// --- The renderer's half: where a walk out ends -----------------------------

function rendererWith(sprites, { motionScale = 1 } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map(sprites.map(sprite => [sprite.agent.id, sprite]));
    renderer.gateTransits = new Map(sprites.map(sprite => [sprite.agent.id, { type: 'departure', since: 0 }]));
    renderer.world = { agents: new Map() };
    renderer.motionScale = motionScale;
    renderer.selectedAgent = null;
    renderer.visitTileAllocator = { release() {} };
    renderer.arrivalDeparture = new ArrivalDepartureController({ motionScale });
    renderer._markSpritesDirty = () => {};
    return renderer;
}

test('a walk out that reaches the gate takes the column and goes in that frame', () => {
    const leaving = body();
    const renderer = rendererWith([leaving]);
    renderer._finishGateDeparture(AGENT.id);
    assert.equal(renderer.arrivalDeparture.departures.size, 1);
    assert.equal(renderer.agentSprites.has(AGENT.id), false, 'no fade: the column paints only what it captured');
    assert.equal(leaving.released, 1);
    assert.equal(leaving._archiveAnim, undefined);
    assert.equal(renderer.arrivalDeparture.sigils.length, 0, 'the sigil is the column\'s residue');
});

test('a seventh column leaves the sigil alone and keeps the fade', () => {
    const leaving = body();
    leaving._screenToTile = () => ({ tileX: 19, tileY: 39.3 });
    const renderer = rendererWith([leaving]);
    for (let i = 0; i < 6; i++) renderer.arrivalDeparture.beginDeparture({ id: `d${i}` }, body(`d${i}`));
    renderer._finishGateDeparture(AGENT.id);
    assert.equal(renderer.arrivalDeparture.departures.has(AGENT.id), false);
    assert.equal(renderer.arrivalDeparture.sigils.length, 1);
    assert.equal(renderer.arrivalDeparture.sigils[0].glow, false);
    assert.ok(leaving._archiveAnim, 'the body keeps its fade');
});

test('the sigil lands at the walk out\'s start only without motion', () => {
    for (const motionScale of [1, 0]) {
        const standing = body();
        standing._screenToTile = () => ({ tileX: 21, tileY: 36 });
        const renderer = rendererWith([standing], { motionScale });
        renderer.gateTransits.clear();
        assert.equal(renderer._beginRelationshipDeparture(standing.agent), false);
        assert.equal(renderer.arrivalDeparture.sigils.length, motionScale ? 0 : 1, `motionScale ${motionScale}`);
    }
});
