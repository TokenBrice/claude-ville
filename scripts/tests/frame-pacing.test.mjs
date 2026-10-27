import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AMBIENT_FRAME_PACING,
    AMBIENT_FRAME_PACING_FPS,
    AMBIENT_INPUT_HOLD_MS,
    FRAME_PACING_INTERVAL_MS,
    admitFrame,
    ambientFrame,
    createFramePacing,
    resetFramePacing,
} from '../../claudeville/src/presentation/character-mode/FramePacing.js';
import { createPostFxLadder, POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';

// A seeded stream of rAF tick timestamps on a `hz` panel, with per-tick
// jitter of up to `jitterMs` either side of the vsync.
function ticks(hz, seconds, { jitterMs = 0, seed = 7 } = {}) {
    let state = seed;
    const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
    const out = [];
    for (let index = 0; index * (1000 / hz) < seconds * 1000; index++) {
        out.push(index * (1000 / hz) + (random() * 2 - 1) * jitterMs);
    }
    return out;
}

function run(stream) {
    const pacing = createFramePacing();
    const intervals = [];
    let rendered = 0;
    for (const tick of stream) {
        if (!admitFrame(pacing, tick)) continue;
        rendered++;
        if (pacing.intervalMs !== null) intervals.push(pacing.intervalMs);
    }
    return { rendered, intervals, ticks: stream.length };
}

test('the first tick renders at once and reports no interval', () => {
    const pacing = createFramePacing();
    assert.equal(admitFrame(pacing, 1000), true);
    assert.equal(pacing.intervalMs, null);
});

test('a 240 Hz panel renders every fourth tick at exactly 60 fps, each paced at the 60 Hz period', () => {
    const { rendered, intervals } = run(ticks(240, 10));
    assert.equal(rendered, 600);
    for (const interval of intervals) assert.ok(Math.abs(interval - FRAME_PACING_INTERVAL_MS) < 1e-6, String(interval));
});

test('a 60 Hz display never drops a frame, with vsync jitter or a slightly fast clock', () => {
    for (const [hz, jitterMs, seconds] of [[60, 1.5, 60], [59.94, 0.5, 600], [60.05, 0.5, 600], [30, 1, 60]]) {
        const { rendered, ticks: total } = run(ticks(hz, seconds, { jitterMs }));
        assert.equal(rendered, total, `${hz} Hz ±${jitterMs} ms dropped ${total - rendered} of ${total} ticks`);
    }
});

test('every panel faster than 60 Hz renders at most 61 fps and not much less than 60', () => {
    for (const hz of [75, 90, 100, 120, 144, 165, 240, 360]) {
        const { rendered } = run(ticks(hz, 20, { jitterMs: 0.3 }));
        const fps = rendered / 20;
        assert.ok(fps <= 61, `${hz} Hz rendered ${fps} fps`);
        assert.ok(fps >= 59, `${hz} Hz rendered only ${fps} fps`);
    }
});

test('a skipped tick changes nothing but the tick clock', () => {
    const pacing = createFramePacing();
    admitFrame(pacing, 0);
    const before = { ...pacing };
    assert.equal(admitFrame(pacing, 4.2), false);
    assert.deepEqual({ ...pacing, lastTickMs: before.lastTickMs }, before);
    assert.equal(pacing.lastTickMs, 4.2);
});

test('a late frame reports its real interval, then the cadence catches up within the cap', () => {
    const pacing = createFramePacing();
    admitFrame(pacing, 0);
    // The main thread held the next rAF until the eighth 240 Hz vsync.
    assert.equal(admitFrame(pacing, 33.33), true);
    assert.ok(pacing.intervalMs > FRAME_PACING_INTERVAL_MS * 1.5, 'a real overrun still reads as a miss');
    assert.equal(admitFrame(pacing, 37.5), false);
    assert.equal(admitFrame(pacing, 41.67), true, 'the carried lateness admits the next frame early');
    assert.equal(pacing.intervalMs, FRAME_PACING_INTERVAL_MS);
    assert.equal(admitFrame(pacing, 45.83), false);
    assert.equal(admitFrame(pacing, 54.17), false);
    assert.equal(admitFrame(pacing, 58.33), true, 'then the 60 fps cadence resumes');
});

test('a reset or a clock that ran backwards renders the next tick at once', () => {
    const pacing = createFramePacing();
    admitFrame(pacing, 100);
    resetFramePacing(pacing);
    assert.equal(admitFrame(pacing, 101), true);
    assert.equal(pacing.intervalMs, null);
    assert.equal(admitFrame(pacing, 50), true);
    assert.equal(pacing.intervalMs, null);
});

// FP-5: lane 04's replay. On a 240 Hz panel whose 7 ms frames miss its
// 4.17 ms period, the uncapped loop latched 240 Hz, a 2.08 ms veto budget,
// and flapped FULL <-> REDUCED. Paced intervals latch the 60 Hz period.
function replayLadder({ paced, minutes = 10 }) {
    const vsync = 1000 / 240;
    const ladder = createPostFxLadder({ maxLevel: POST_FX_LEVELS.MINIMAL });
    const pacing = createFramePacing();
    let state = 7;
    const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
    let t = 0;
    let lastTick = 0;
    let frames = 0;
    let busyUntil = 0;
    let changes = 0;
    let level = ladder.getLevel();
    while (t < minutes * 60000) {
        t += vsync;
        if (t < busyUntil) continue;
        let intervalMs = t - lastTick;
        lastTick = t;
        if (paced) {
            if (!admitFrame(pacing, t)) continue;
            intervalMs = pacing.intervalMs;
        }
        frames++;
        // Boot frames are light enough for every vsync; then 6-8 ms of work.
        busyUntil = t + (frames < 90 ? 1 : 7 * (0.85 + 0.3 * random()));
        if (intervalMs === null) continue;
        ladder.update({ uploadMs: 0.5 * (0.6 + 0.8 * random()), gpuMs: 1.8, frameGapMs: intervalMs, intervalMs }, t);
        if (ladder.getLevel() !== level) {
            changes++;
            level = ladder.getLevel();
        }
    }
    return { changes, state: ladder.getState(), level };
}

test('paced intervals latch the 60 Hz period and stop the 240 Hz FULL/REDUCED flapping', () => {
    const uncapped = replayLadder({ paced: false });
    assert.equal(uncapped.state.refreshHz, 240, 'the replay reproduces the uncapped latch');
    assert.ok(uncapped.changes >= 4, `the uncapped replay should flap (changed ${uncapped.changes} times)`);

    const paced = replayLadder({ paced: true });
    assert.equal(paced.state.refreshHz, 60);
    assert.ok(Math.abs(paced.state.budgetMs - FRAME_PACING_INTERVAL_MS / 2) < 1e-6);
    assert.equal(paced.level, POST_FX_LEVELS.FULL);
    assert.ok(paced.changes <= 2, `the boot climb to FULL is the only change (changed ${paced.changes} times)`);
});

// FP-1b: ambient-only frames at 30 fps.
function runAmbient(stream, ambientAt = () => true) {
    const pacing = createFramePacing();
    const intervals = [];
    let rendered = 0;
    for (const tick of stream) {
        if (!admitFrame(pacing, tick, ambientAt(tick))) continue;
        rendered++;
        if (pacing.intervalMs !== null) intervals.push(pacing.intervalMs);
    }
    return { rendered, intervals };
}

test('the ambient switch is on for the review build and ambient frames pace at 30 fps', () => {
    assert.equal(AMBIENT_FRAME_PACING, true);
    assert.equal(AMBIENT_FRAME_PACING_FPS, 30);
    for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
        const { rendered } = runAmbient(ticks(hz, 10, { jitterMs: hz === 60 ? 1.5 : 0 }));
        assert.ok(rendered <= 10 * 31 && rendered >= 10 * 29, `${hz} Hz renders ${rendered / 10} ambient fps`);
    }
});

test('the ladder still hears the 60 Hz display interval at the ambient cadence', () => {
    const { intervals } = runAmbient(ticks(60, 5));
    assert.ok(intervals.length > 100);
    for (const interval of intervals) assert.ok(Math.abs(interval - FRAME_PACING_INTERVAL_MS) < 1e-6);
});

test('a frame that stops being ambient renders at the next 60 fps tick', () => {
    const pacing = createFramePacing();
    const renderedAt = [];
    for (const tick of ticks(240, 2)) {
        if (admitFrame(pacing, tick, tick < 1000)) renderedAt.push(tick);
    }
    const before = renderedAt.filter(tick => tick < 1000);
    const after = renderedAt.filter(tick => tick >= 1000);
    assert.ok(before.length <= 31, `the ambient second rendered ${before.length}`);
    assert.ok(after.length >= 59 && after.length <= 61, `the 60 fps second rendered ${after.length}`);
    assert.ok(after[0] - 1000 <= FRAME_PACING_INTERVAL_MS, 'no 30 fps hold carries past the switch');
    assert.equal(pacing.ambient, false);
});

test('ambientFrame holds 60 fps for every listed cause and for pointer input inside a second', () => {
    assert.equal(ambientFrame({}), true);
    for (const cause of ['fastWalker', 'cameraMoving', 'cometInFlight', 'strikeActive', 'momentPlaying']) {
        assert.equal(ambientFrame({ [cause]: true }), false, cause);
    }
    assert.equal(ambientFrame({ msSinceInput: AMBIENT_INPUT_HOLD_MS - 1 }), false);
    assert.equal(ambientFrame({ msSinceInput: AMBIENT_INPUT_HOLD_MS }), true);
    assert.equal(ambientFrame({ msSinceInput: NaN }), true, 'no input yet');
});

test('a reset forgets the ambient cadence', () => {
    const pacing = createFramePacing();
    admitFrame(pacing, 0, true);
    assert.equal(pacing.ambient, true);
    resetFramePacing(pacing);
    assert.equal(pacing.ambient, false);
});
