import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POST_FX_LEVELS,
    assessPostFxTimings,
    createPostFxLadder,
} from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';

function run(ladder, metrics, frames, startMs = 0, stepMs = 16) {
    let now = startMs;
    for (let i = 0; i < frames; i++) {
        now += stepMs;
        ladder.update(metrics, now);
    }
    return now;
}

test('healthy timings keep the ladder at FULL', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 1, cpuMs: 0.5 }, 300);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('sustained over-budget frames degrade exactly one level at the threshold', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 5, cpuMs: 1 }, 59);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL, 'must not degrade before 60 frames');
    run(ladder, { uploadMs: 5, cpuMs: 1 }, 1, 59 * 16);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED);
});

test('a brief spike resets the over-budget counter (hysteresis)', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 5, cpuMs: 1 }, 59);
    run(ladder, { uploadMs: 1, cpuMs: 0.2 }, 1, 59 * 16);
    run(ladder, { uploadMs: 5, cpuMs: 1 }, 59, 60 * 16);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('persistent stalls walk the ladder to DISABLED', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 8, cpuMs: 2 }, 60 * 3);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.DISABLED);
});

test('frame-gap stalls degrade even when instrumented timings look healthy', () => {
    const ladder = createPostFxLadder();
    // Software-GL producer flushes: upload/cpu read tiny while the real frame
    // gap collapses to ~7 FPS. The gap excess must count against the budget.
    run(ladder, { uploadMs: 0.5, cpuMs: 0.2, frameGapMs: 140 }, 60, 0, 140);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED);
    assert.equal(ladder.getState().lastDegradationReason, 'sustained-frameGapMs');
});

test('healthy frames probe one level up only after the probe window', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 5, cpuMs: 1 }, 60);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED);
    let now = 60 * 16;
    now = run(ladder, { uploadMs: 1, cpuMs: 0.2 }, 200, now);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED, '3.2s healthy is inside the probe window');
    run(ladder, { uploadMs: 1, cpuMs: 0.2 }, 140, now);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL, 'healthy past 5s must recover a level');
});

test('override pins the effective level and survives metric churn', () => {
    const ladder = createPostFxLadder();
    ladder.setOverride(POST_FX_LEVELS.MINIMAL);
    run(ladder, { uploadMs: 20, cpuMs: 10 }, 120);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.MINIMAL);
    ladder.setOverride(null);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('timing assessment attributes upload, auxiliary upload, shader, GPU, and frame-gap cost', () => {
    const upload = assessPostFxTimings({ uploadMs: 6, auxUploadMs: 1, setupCpuMs: 0.5, shaderCpuMs: 1, gpuMs: 2 });
    assert.equal(upload.driver, 'uploadMs');
    assert.equal(upload.score, 10.5);

    const stall = assessPostFxTimings({ uploadMs: 0.2, shaderCpuMs: 0.2, frameGapMs: 140 });
    assert.equal(stall.driver, 'frameGapMs');
    assert.equal(stall.score, 107);
});

test('degradation diagnostics retain the concrete bottleneck reason', () => {
    const ladder = createPostFxLadder({ probeMs: 32 });
    run(ladder, { uploadMs: 6, shaderCpuMs: 0.5 }, 60);
    const degraded = ladder.getState();
    assert.equal(degraded.level, POST_FX_LEVELS.REDUCED);
    assert.equal(degraded.lastDecisionReason, 'degrade:sustained-uploadMs');
    assert.equal(degraded.lastDegradationReason, 'sustained-uploadMs');
    assert.equal(degraded.lastTransitionMetrics.driver, 'uploadMs');

    run(ladder, { uploadMs: 0.2, shaderCpuMs: 0.2 }, 3, 60 * 16);
    const recovered = ladder.getState();
    assert.equal(recovered.level, POST_FX_LEVELS.FULL);
    assert.equal(recovered.lastDecisionReason, 'healthy-recovery');
    assert.equal(recovered.lastDegradationReason, 'sustained-uploadMs', 'recovery must not erase the last degradation cause');
});
