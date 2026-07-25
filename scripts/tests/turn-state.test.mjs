// Turn-state derivation and pending-tool classification.
//
// This is the layer everything downstream trusts: get it wrong and the village
// tells the user a confident lie about what their agents are doing. It is also
// pure, so it is cheap to pin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    TurnState,
    WaitReason,
    classifyPendingTool,
    deriveTurnState,
    pendingThresholdMs,
    toEpochMs,
    INSTANT_PENDING_MS,
    VARIABLE_PENDING_MS,
} = require('../../claudeville/adapters/turnState.js');

const NOW = 1_700_000_000_000;

test('a closed turn hands control back to the user', () => {
    const state = deriveTurnState({ turnEnded: true, turnEndedAt: NOW - 5000 }, NOW);
    assert.equal(state.turnState, TurnState.AWAITING_INPUT);
    assert.equal(state.awaitingSince, NOW - 5000);
    assert.equal(state.pendingTool, null);
});

test('no pending tool and no closed turn means the model is working', () => {
    const state = deriveTurnState({ turnEnded: false }, NOW);
    assert.equal(state.turnState, TurnState.WORKING);
    assert.equal(state.awaitingSince, null);
});

test('an unknown transcript stays unknown rather than guessing', () => {
    const state = deriveTurnState({ known: false, turnEnded: true }, NOW);
    assert.equal(state.turnState, TurnState.UNKNOWN);
    assert.equal(state.awaitingSince, null);
});

test('a pending tool outranks a previously closed turn', () => {
    const state = deriveTurnState(
        { turnEnded: true, turnEndedAt: NOW - 60_000, pendingTool: 'Bash', pendingSince: NOW - 1000 },
        NOW,
    );
    assert.equal(state.turnState, TurnState.TOOL_PENDING);
    assert.equal(state.pendingTool, 'Bash');
});

test('ask tools are blocked the instant they are pending', () => {
    const result = classifyPendingTool({ tool: 'AskUserQuestion', pendingForMs: 0 });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, WaitReason.QUESTION);
});

test('plan tools read as a review request, not an approval', () => {
    const result = classifyPendingTool({ tool: 'ExitPlanMode', pendingForMs: 0 });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, WaitReason.PLAN_REVIEW);
});

test('a fast tool pending past the instant threshold is a permission prompt', () => {
    const before = classifyPendingTool({ tool: 'Edit', pendingForMs: INSTANT_PENDING_MS - 1 });
    const after = classifyPendingTool({ tool: 'Edit', pendingForMs: INSTANT_PENDING_MS + 1 });
    assert.equal(before.blocked, false);
    assert.equal(after.blocked, true);
    assert.equal(after.reason, WaitReason.APPROVAL);
});

test('a long-running Bash is not mistaken for a permission prompt', () => {
    // The false-alarm case that matters: builds and test suites run for
    // minutes, and calling that "waiting for you" would train the user to
    // ignore the badge.
    const running = classifyPendingTool({ tool: 'Bash', pendingForMs: 3 * 60_000 });
    assert.equal(running.blocked, false);
    const stuck = classifyPendingTool({ tool: 'Bash', pendingForMs: VARIABLE_PENDING_MS + 1 });
    assert.equal(stuck.blocked, true);
});

test('bypassPermissions means a pending tool is always executing', () => {
    const result = classifyPendingTool({
        tool: 'Edit',
        permissionMode: 'bypassPermissions',
        pendingForMs: 10 * 60_000,
    });
    assert.equal(result.blocked, false);
});

test('acceptEdits silences edit prompts but not Bash', () => {
    const edit = classifyPendingTool({
        tool: 'Write', permissionMode: 'acceptEdits', pendingForMs: 60_000,
    });
    assert.equal(edit.blocked, false);
    const bash = classifyPendingTool({
        tool: 'Bash', permissionMode: 'acceptEdits', pendingForMs: VARIABLE_PENDING_MS + 1,
    });
    assert.equal(bash.blocked, true);
});

test('bypassPermissions never suppresses an explicit question', () => {
    const result = classifyPendingTool({
        tool: 'AskUserQuestion', permissionMode: 'bypassPermissions', pendingForMs: 0,
    });
    assert.equal(result.blocked, true);
});

test('unknown tools get the forgiving threshold', () => {
    assert.equal(pendingThresholdMs('mcp__something__do_a_thing'), VARIABLE_PENDING_MS);
    assert.equal(pendingThresholdMs('Read'), INSTANT_PENDING_MS);
    assert.equal(pendingThresholdMs(null), VARIABLE_PENDING_MS);
});

test('derived state carries the wait reason only when blocked', () => {
    const running = deriveTurnState(
        { pendingTool: 'Bash', pendingSince: NOW - 1000 }, NOW,
    );
    assert.equal(running.waitReason, null);
    assert.equal(running.awaitingSince, null);

    const blocked = deriveTurnState(
        { pendingTool: 'Edit', pendingSince: NOW - 60_000 }, NOW,
    );
    assert.equal(blocked.waitReason, WaitReason.APPROVAL);
    assert.equal(blocked.awaitingSince, NOW - 60_000);
});

test('timestamps parse from ISO strings and numbers alike', () => {
    assert.equal(toEpochMs('2026-07-25T07:39:20.959Z'), Date.parse('2026-07-25T07:39:20.959Z'));
    assert.equal(toEpochMs(NOW), NOW);
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs('not a date'), null);
});
