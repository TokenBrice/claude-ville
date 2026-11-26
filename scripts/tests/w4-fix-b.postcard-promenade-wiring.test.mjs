import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { CameraDirector } from '../../claudeville/src/presentation/character-mode/CameraDirector.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { postcardFrame, recordLivingPostcard, withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';

function startRecording() {
    const events = new EventEmitter();
    const controller = new AbortController();
    const scheduled = Promise.withResolvers();
    const state = { now: 0, tick: null, trackStops: 0, recorderStops: 0, draws: [] };
    const ctx = { drawImage() {}, fillRect() {}, fillText() {} };
    const track = { stop() { state.trackStops++; } };
    const canvas = () => ({
        width: 40, height: 40, getContext: () => ctx,
        captureStream: () => ({ getTracks: () => [track] }),
    });
    const renderer = {
        canvas: canvas(),
        renderNow() {
            state.draws.push(postcardFrame());
            return true;
        },
    };
    class Recorder {
        start() { this.state = 'recording'; }
        stop() {
            this.state = 'inactive';
            state.recorderStops++;
            this.onstop();
        }
    }
    const done = recordLivingPostcard(renderer, {
        documentRef: { createElement: canvas }, MediaRecorderCtor: Recorder,
        durationMs: 100, now: () => state.now, save: false,
        signal: controller.signal, eventTarget: events,
        scheduleFrame(tick) {
            state.tick = tick;
            scheduled.resolve();
            return tick;
        },
        cancelFrame() { state.tick = null; },
    });
    return { renderer, state, events, controller, scheduled: scheduled.promise, done };
}

test('studio cancellation and attention between ticks both settle without a further tick', { timeout: 2000 }, async () => {
    const first = startRecording();
    const second = startRecording();
    await Promise.all([first.scheduled, second.scheduled]);
    assert.ok(postcardFrame());
    first.controller.abort();
    assert.equal((await first.done).reason, 'cancelled');
    assert.ok(postcardFrame(), 'overlapping recording still owns its hold');
    second.events.emit('attention:raised');
    assert.equal((await second.done).reason, 'attention-needed');
    assert.equal(postcardFrame(), false);
    for (const { state, events } of [first, second]) {
        assert.equal(state.tick, null);
        assert.equal(state.trackStops, 1);
        assert.equal(state.recorderStops, 1);
        assert.equal(events.listenerCount('attention:raised'), 0);
        assert.equal(events.listenerCount('distress:watchtower'), 0);
    }
});

test('live paints remain in postcard mode between capture ticks until the last frame', async () => {
    const { renderer, state, scheduled, done } = startRecording();
    await scheduled;
    renderer.renderNow();
    withPostcardFrame(() => renderer.renderNow());
    state.now = 50;
    await state.tick();
    renderer.renderNow();
    state.now = 100;
    await state.tick();
    assert.equal((await done).ok, true);
    assert.deepEqual(state.draws, [true, true, true, true, true, false]);
});

test('an exception inside a scheduled capture releases the recording resources and restores the live view', async t => {
    const { state, renderer, scheduled, done } = startRecording();
    await scheduled;
    renderer.renderNow = () => {
        if (postcardFrame()) throw new Error('paint failed');
        state.draws.push(false);
        return true;
    };
    const warn = t.mock.method(console, 'warn', () => {});
    await state.tick();
    assert.equal((await done).reason, 'recording-failed');
    assert.match(warn.mock.calls[0].arguments[1].message, /paint failed/);
    assert.equal(state.trackStops, 1);
    assert.equal(state.recorderStops, 1);
    assert.equal(state.draws.at(-1), false);
    assert.equal(postcardFrame(), false);
});

test('Promenade Rail uses plaque counts and patron tallies, then actual rest seats and standing places', t => {
    const station = (frame) => {
        const camera = new Camera({ clientWidth: 1440, clientHeight: 222, style: {}, addEventListener() {} });
        const director = new CameraDirector(camera, { stripProfile: true });
        t.after(() => director.dispose());
        director.setAmbient(true);
        director.update({ now: 10_000, ...frame });
        return director.getPromenadeState().station.type;
    };
    assert.equal(station({ plaqueCounts: new Map([['mine', 0], ['forge', 2]]) }), 'forge');
    assert.equal(station({ plaquePatrons: { mine: { count: 0 }, tavern: { count: 3, full: true } } }), 'tavern');
    assert.equal(station({ plaquePatrons: new Map([['tavern', 2]]) }), 'tavern');
    const rest = { visitRole: 'rest', _foldBuildingType: 'mine', agent: { id: 'patron', status: 'idle' } };
    assert.equal(station({ agentSprites: [{ ...rest, _seatedSeat: () => ({ building: 'tavern' }) }] }), 'tavern');
    assert.equal(station({ agentSprites: [{ ...rest, _restBuilding: 'tavern' }] }), 'tavern');
});

test('frame failure clears overlay clips and saved state before restoring its backing-pixel transform', () => {
    for (const hasReset of [true, false]) {
        let resetCount = 0;
        let transform;
        const canvas = { get width() { return 1920; }, set width(value) { assert.equal(value, 1920); resetCount++; } };
        const overlayCtx = { canvas, setTransform(...args) { transform = args; } };
        if (hasReset) overlayCtx.reset = () => { resetCount++; };
        const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
            ctx: { reset() {} }, canvas: { _claudeVilleDpr: 2 }, overlayCtx,
        });
        renderer._resetContextAfterFrameFailure();
        assert.equal(resetCount, 1);
        assert.deepEqual(transform, [2, 0, 0, 2, 0, 0]);
        assert.equal(overlayCtx.imageSmoothingEnabled, false);
    }
});

test('momentary READ restores full attention layout in Theatre and releasing it returns to beacons', () => {
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        theatreMode: true,
        camera: { zoom: 1, worldToScreen: (x, y) => ({ x, y }), screenToWorld: (x, y) => ({ x, y }) },
        overlayCtx: { measureText: text => ({ width: text.length * 7 }) },
        agentSprites: new Map([['waiting', { x: 220, y: 220, agent: { id: 'waiting', status: 'waiting_on_user' } }]]),
        _overlayNameRects: [], _overlayReservedRects: [], _overlayRegionCounts: new Map(),
        _attentionWorldRects: [], _overlayPrioritizedSprites: [], _overlayBubbleSprites: [],
        _screenViewport: () => ({ width: 1280, height: 800 }), _beginRectGridFrame() {},
        _assignAgentBubbleSlots() {}, markGovernor: { reserve() {} },
    });
    for (const held of [false, true, false]) {
        renderer.setReadMode(held);
        renderer._assignAgentOverlaySlots([]);
        assert.equal(renderer._attentionLayout.theatre, !held);
        assert.ok(renderer._attentionLayout.plates.length);
    }
});
