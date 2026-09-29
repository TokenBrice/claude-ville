import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POST_FX_LADDER_REASONS as REASONS,
    POST_FX_LEVELS,
    assessPostFxTimings,
    createPostFxLadder,
    latchDisplayPeriod,
} from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import {
    EFFECT_BUDGET,
    effectBudgetMode,
    shedEffectsForLevel,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

const { FULL, REDUCED, MINIMAL, DISABLED } = POST_FX_LEVELS;
const P60 = 1000 / 60;
const P120 = 1000 / 120;

// Drive the ladder frame by frame. `frameAt(now, level)` returns the display
// interval that ends the frame and the timer p25 the renderer would report.
function drive(ladder, frameAt, durationMs, startMs = 0, onFrame = null) {
    let now = startMs;
    const endMs = startMs + durationMs;
    while (now < endMs) {
        const frame = frameAt(now, ladder.getLevel());
        now += frame.intervalMs;
        const metrics = { uploadMs: 0, frameGapMs: frame.intervalMs, intervalMs: frame.intervalMs };
        if (frame.gpuMs === undefined) metrics.shaderCpuMs = 1;
        else metrics.gpuMs = frame.gpuMs;
        const state = ladder.update(metrics, now);
        onFrame?.(state, now);
    }
    return now;
}

const steady = (intervalMs, gpuMs) => () => ({ intervalMs, gpuMs });

// A GPU-side load the ladder can shed: FULL misses, lower levels hold pacing.
const sheddable = (periodMs, gpuMs = 22) => (now, level) => (level === FULL
    ? { intervalMs: periodMs * 2, gpuMs }
    : { intervalMs: periodMs, gpuMs: 4 });

function residentLadder() {
    const ladder = createPostFxLadder({ maxLevel: MINIMAL });
    ladder.reset(MINIMAL);
    return ladder;
}

function bootedLadder(periodMs = P60) {
    const ladder = residentLadder();
    const now = drive(ladder, steady(periodMs, 2), 4000);
    assert.equal(ladder.getLevel(), FULL, 'a healthy boot reaches FULL');
    return { ladder, now };
}

function transitionsOf(ladder, frameAt, durationMs, startMs) {
    const transitions = [];
    let previous = ladder.getLevel();
    const now = drive(ladder, frameAt, durationMs, startMs, (state, at) => {
        if (state.effectiveLevel !== previous) {
            transitions.push({ at, from: previous, to: state.effectiveLevel, reason: state.lastTransitionReason });
            previous = state.effectiveLevel;
        }
    });
    return { transitions, now };
}

test('the display period latches from p5 of the warm-up gaps, snapped to a refresh rate', () => {
    const jittered = (periodMs, count = 60) => Array.from({ length: count }, (_, index) => (
        index % 7 === 3 ? periodMs * 2 : periodMs + (index % 2 ? 0.4 : -0.4)
    ));
    for (const hz of [60, 75, 90, 100, 120, 144, 165, 240]) {
        assert.equal(latchDisplayPeriod(jittered(1000 / hz)).refreshHz, hz);
    }
    // A warm-up that mostly achieves 60 fps on a 120 Hz panel still latches
    // the panel's period: the latch never reads the median of achieved gaps.
    const mostlyHalfRate = [...Array(56).fill(P60), ...Array(4).fill(P120)];
    assert.equal(latchDisplayPeriod(mostlyHalfRate).refreshHz, 120);
    // Stalls and hidden-page gaps never reach the latch.
    assert.equal(latchDisplayPeriod([...Array(59).fill(P60), 400]).refreshHz, 60);
});

test('the latch sets the timer veto budget to half the period', () => {
    for (const periodMs of [P60, P120]) {
        const ladder = residentLadder();
        drive(ladder, steady(periodMs, 1), 1100);
        const state = ladder.getState();
        assert.ok(Math.abs(state.periodMs - periodMs) < 1e-9);
        assert.ok(Math.abs(state.budgetMs - periodMs / 2) < 1e-9);
    }
});

test('boot climbs from MINIMAL to FULL through pacing probes, then holds', () => {
    const ladder = residentLadder();
    let fullAt = null;
    drive(ladder, steady(P60, 2), 4000, 0, (state, now) => {
        if (fullAt === null && state.effectiveLevel === FULL) fullAt = now;
    });
    assert.ok(fullAt !== null && fullAt <= 3000, `FULL within 3 s of boot, reached at ${fullAt}`);
    const { transitions } = transitionsOf(ladder, steady(P60, 2), 120_000, 4000);
    assert.deepEqual(transitions, [], 'a paced display never changes level');
});

test('a contended timer over budget never demotes a paced display', () => {
    const { ladder, now } = bootedLadder();
    const { transitions } = transitionsOf(ladder, steady(P60, 12), 60_000, now);
    assert.deepEqual(transitions, []);
    assert.equal(ladder.getLevel(), FULL);
});

test('missed frames with a healthy timer are main-thread-bound and never demote', () => {
    const { ladder, now } = bootedLadder();
    let frame = 0;
    drive(ladder, () => ({ intervalMs: frame++ % 3 === 0 ? P60 * 2 : P60, gpuMs: 3 }), 10_000, now);
    assert.equal(ladder.getLevel(), FULL);
    assert.equal(ladder.getState().lastDecisionReason, REASONS.MISSING_TIMER_UNDER_BUDGET);
});

test('a steady GPU-bound 60 fps on a 120 Hz panel demotes within 2 s and keeps the latched period', () => {
    const { ladder, now } = bootedLadder(P120);
    const { transitions } = transitionsOf(ladder, sheddable(P120, 12), 5000, now);
    assert.ok(transitions.length >= 1, 'the ladder demotes');
    assert.equal(transitions[0].to, REDUCED);
    assert.equal(transitions[0].reason, REASONS.DEMOTE);
    assert.ok(transitions[0].at - now <= 2000, `demoted ${transitions[0].at - now} ms after the load`);
    const state = ladder.getState();
    assert.equal(state.refreshHz, 120, 'achieved 60 fps never redefines the period');
    assert.ok(Math.abs(state.budgetMs - P120 / 2) < 1e-9);
    assert.equal(ladder.getLevel(), REDUCED, 'the shed helped, so it is kept');
});

test('shedding that does not cut the misses reverts and cools down with exponential backoff', () => {
    const { ladder, now } = bootedLadder();
    const { transitions } = transitionsOf(ladder, steady(P60 * 2, 22), 200_000, now);
    const demotions = transitions.filter(item => item.reason === REASONS.DEMOTE);
    const reverts = transitions.filter(item => item.reason === REASONS.STEP_REVERTED);
    assert.ok(demotions.length >= 3 && reverts.length >= 3);
    assert.ok(demotions[0].at - now <= 2000, 'a real overload still sheds within 2 s');
    for (const revert of reverts) assert.equal(revert.to, FULL);
    assert.ok(transitions.every(item => item.to <= REDUCED), 'no 3-2-1-0 cycling');
    const firstHold = demotions[1].at - reverts[0].at;
    const secondHold = demotions[2].at - reverts[1].at;
    assert.ok(firstHold >= 60_000 && firstHold < 62_000, `first cool-down ${firstHold} ms`);
    assert.ok(secondHold >= 120_000 && secondHold < 122_000, `second cool-down ${secondHold} ms`);
});

test('probes that miss revert with exponential backoff, and the ladder recovers once the load is gone', () => {
    const { ladder, now } = bootedLadder();
    const loaded = transitionsOf(ladder, sheddable(P60), 100_000, now);
    assert.equal(loaded.transitions[0].reason, REASONS.DEMOTE);
    const probes = loaded.transitions.filter(item => item.reason === REASONS.PROBE);
    const reverts = loaded.transitions.filter(item => item.reason === REASONS.PROBE_REVERTED);
    assert.ok(probes.length >= 4 && reverts.length >= 4);
    const waits = reverts.slice(0, 3).map((revert, index) => probes[index + 1].at - revert.at);
    assert.ok(waits[0] >= 8_000 && waits[0] < 8_100, `second probe waits ${waits[0]} ms`);
    assert.ok(waits[1] >= 16_000 && waits[1] < 16_100, `third probe waits ${waits[1]} ms`);
    assert.ok(waits[2] >= 32_000 && waits[2] < 32_100, `fourth probe waits ${waits[2]} ms`);
    for (const revert of reverts) assert.ok(revert.at - probes[reverts.indexOf(revert)].at < 500, 'a failing probe is short');
    assert.equal(ladder.getLevel(), REDUCED);

    const recovery = transitionsOf(ladder, steady(P60, 3), 70_000, loaded.now);
    assert.equal(ladder.getLevel(), FULL, 'the next probe after removal holds');
    assert.equal(recovery.transitions.length, 1);
    assert.equal(recovery.transitions[0].reason, REASONS.PROBE);
});

test('probe-window hitches with a healthy timer do not revert the probe', () => {
    const ladder = residentLadder();
    let frame = 0;
    // Every 20th frame is a 50 ms main-thread hitch: 5 % of a window.
    drive(ladder, () => ({ intervalMs: frame++ % 20 === 19 ? 50 : P60, gpuMs: 2 }), 4500);
    assert.equal(ladder.getLevel(), FULL);
});

test('without a GPU timer the veto is waived: pacing and the shed guard decide alone', () => {
    const noTimer = frameAt => (now, level) => ({ ...frameAt(now, level), gpuMs: undefined });
    const shed = bootedLadder();
    const { transitions } = transitionsOf(shed.ladder, noTimer(sheddable(P60)), 5000, shed.now);
    assert.equal(transitions[0]?.reason, REASONS.DEMOTE);
    assert.ok(transitions[0].at - shed.now <= 2000);
    assert.equal(shed.ladder.getLevel(), REDUCED);

    const stuck = bootedLadder();
    const reverted = transitionsOf(stuck.ladder, noTimer(steady(P60 * 2)), 10_000, stuck.now);
    assert.deepEqual(reverted.transitions.map(item => item.reason), [REASONS.DEMOTE, REASONS.STEP_REVERTED]);
});

test('a Dashboard return resumes the last paced level at once and keeps the latch', () => {
    const { ladder, now } = bootedLadder();
    const resumed = ladder.resume();
    assert.equal(resumed.effectiveLevel, FULL);
    assert.equal(resumed.lastDecisionReason, REASONS.RESUME);
    assert.equal(resumed.refreshHz, 60);
    const { transitions } = transitionsOf(ladder, steady(P60, 2), 1000, now + 5000);
    assert.deepEqual(transitions, [], 'the returned level holds');

    // Suspended mid-probe: the return lands on the level the probe started from.
    const probing = bootedLadder();
    let resumedLevel = null;
    drive(probing.ladder, sheddable(P60), 30_000, probing.now, (state) => {
        if (resumedLevel === null && state.lastDecisionReason === REASONS.PROBE && state.effectiveLevel === FULL) {
            resumedLevel = probing.ladder.resume().effectiveLevel;
        }
    });
    assert.equal(resumedLevel, REDUCED);
});

test('hidden-page gaps are not misses, and a visibility change clears the window', () => {
    const { ladder, now } = bootedLadder();
    let after = drive(ladder, steady(2000, 2), 2000, now);
    after = drive(ladder, steady(P60, 2), 500, after);
    assert.equal(ladder.getState().missShare, 0);
    after = drive(ladder, steady(P60 * 2, 2), 300, after);
    assert.ok(ladder.getState().missShare > 0);
    ladder.clearPacing();
    drive(ladder, steady(P60, 2), 20, after);
    assert.equal(ladder.getState().missShare, 0);
    assert.equal(ladder.getLevel(), FULL);
});

test('a screen or DPR change re-latches the period without changing the level', () => {
    const { ladder, now } = bootedLadder();
    ladder.relatch();
    const { transitions } = transitionsOf(ladder, steady(P120, 2), 1000, now);
    assert.deepEqual(transitions, []);
    const state = ladder.getState();
    assert.equal(state.refreshHz, 120);
    assert.ok(Math.abs(state.budgetMs - P120 / 2) < 1e-9);
});

test('setBudgetMs replaces the timer veto budget until the next latch', () => {
    const { ladder } = bootedLadder();
    assert.equal(ladder.setBudgetMs(5), 5);
    assert.equal(ladder.getState().budgetMs, 5);
});

test('override pins the effective level and survives pacing churn', () => {
    const { ladder, now } = bootedLadder();
    ladder.setOverride(MINIMAL);
    drive(ladder, steady(P60 * 2, 30), 5000, now);
    assert.equal(ladder.getLevel(), MINIMAL);
    ladder.setOverride(null);
    assert.equal(ladder.getLevel(), FULL);
});

test('timing assessment attributes upload, auxiliary upload, shader, GPU, and frame-gap cost', () => {
    const upload = assessPostFxTimings({
        uploadMs: 6,
        auxUploadMs: 1,
        setupCpuMs: 0.5,
        shaderCpuMs: 1,
        gpuMs: 2,
    });
    assert.equal(upload.driver, 'uploadMs');
    assert.equal(upload.score, 10.5);

    // The > 35 ms gap penalty still reaches the veto score.
    const stall = assessPostFxTimings({ uploadMs: 0.2, shaderCpuMs: 0.2, frameGapMs: 140 });
    assert.equal(stall.driver, 'frameGapMs');
    assert.equal(stall.score, 107);
});

test('light admission is a declared row: the night keeps its pools at every level', () => {
    const caps = [FULL, REDUCED, MINIMAL].map(level => effectBudgetMode('light-admission', level));
    assert.equal(caps[0], 128);
    assert.ok(caps[1] >= 24 && caps[1] <= caps[0]);
    assert.ok(caps[2] >= 12 && caps[2] <= caps[1]);
    assert.deepEqual(shedEffectsForLevel(FULL), []);
    assert.deepEqual(
        shedEffectsForLevel(REDUCED).find(effect => effect.id === 'light-admission'),
        { id: 'light-admission', mode: caps[1] },
    );
    assert.deepEqual(
        shedEffectsForLevel(MINIMAL).find(effect => effect.id === 'light-admission'),
        { id: 'light-admission', mode: caps[2] },
    );
    // The minimal-resident override renders MINIMAL's composition.
    assert.deepEqual(shedEffectsForLevel(DISABLED), shedEffectsForLevel(MINIMAL));
});

test('MINIMAL admits no optional GPU pass and no optional resident bytes', () => {
    const rows = Object.values(EFFECT_BUDGET);

    // An effect that keeps bytes resident is a FULL-level luxury...
    for (const effect of rows.filter((row) => row.cost.bytes > 0)) {
        assert.equal(effectBudgetMode(effect.id, POST_FX_LEVELS.FULL), 'on');
    }
    // ...and no optional effect still running at MINIMAL prices any. A
    // substitution that removes time (`gpuMsSavedBand`, e.g. the clustered
    // light walk's tile index) ships at every level with its bytes.
    const residentAtMinimal = rows
        .filter((effect) => !effect.cost.gpuMsSavedBand)
        .filter((effect) => effectBudgetMode(effect.id, POST_FX_LEVELS.MINIMAL) !== 'off')
        .reduce((bytes, effect) => bytes + effect.cost.bytes, 0);
    assert.equal(residentAtMinimal, 0);

    for (const effect of rows) {
        const { gpuMsBand, gpuMsSavedBand, scope } = effect.cost;
        assert.ok(
            Boolean(gpuMsBand) !== Boolean(gpuMsSavedBand),
            `${effect.id} prices either added time or removed time, never both`,
        );
        // Work that a substitution removes is not optional: it ships at every level.
        if (gpuMsSavedBand) {
            assert.ok(
                Object.values(effect.levels).every((mode) => mode === effect.levels.FULL),
                `${effect.id} saves time and can never be shed`,
            );
        }
        // `[0, ceiling]` is an honest noise-floor upper bound; a zero-width band is not a measurement.
        const [low, high] = gpuMsBand || gpuMsSavedBand;
        assert.ok(low >= 0 && high > low, `${effect.id} needs a measured band`);
        assert.ok(
            ['own-pass', 'shared-scene-envelope', 'shared-composite-envelope'].includes(scope),
            `${effect.id} needs a band scope`,
        );
        assert.ok(effect.staticFallback && effect.canvas, `${effect.id} needs both fallbacks`);
    }
});

test('an unknown effect is a programming error, never a silent pass-through', () => {
    assert.throws(() => effectBudgetMode('window-spill', POST_FX_LEVELS.FULL), /unknown effect budget/);
});
