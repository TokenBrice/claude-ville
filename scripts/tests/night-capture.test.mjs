import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NIGHT_FALLBACK_WAIT_MS,
  NIGHT_POLL_INTERVAL_MS,
  NIGHT_SETTLE_CAP_MS,
  isNightOrDuskPhase,
  isRoomStateStable,
  settleNightCapture,
  workingCountsKey,
} from '../smoke/support/night-capture.mjs';

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms) => { t += ms; },
  };
}

test('isNightOrDuskPhase matches only dusk and night', () => {
  assert.equal(isNightOrDuskPhase('night'), true);
  assert.equal(isNightOrDuskPhase('dusk'), true);
  assert.equal(isNightOrDuskPhase('day'), false);
  assert.equal(isNightOrDuskPhase('dawn'), false);
  assert.equal(isNightOrDuskPhase(null), false);
});

test('workingCountsKey sorts building types deterministically', () => {
  assert.equal(workingCountsKey({ forge: 2, archive: 1, command: 0 }), 'archive:1,command:0,forge:2');
  assert.equal(workingCountsKey(null), '');
});

test('isRoomStateStable requires signal, zero routing, and matching working counts', () => {
  const settled = { hasSignal: true, working: { command: 2, forge: 1 }, routingTotal: 0 };
  const routing = { hasSignal: true, working: { command: 2, forge: 1 }, routingTotal: 1 };
  const changed = { hasSignal: true, working: { command: 3, forge: 1 }, routingTotal: 0 };
  const missing = { hasSignal: false, working: null, routingTotal: 0 };

  assert.equal(isRoomStateStable(settled, { ...settled }), true);
  assert.equal(isRoomStateStable(routing, routing), false);
  assert.equal(isRoomStateStable(routing, settled), false);
  assert.equal(isRoomStateStable(settled, changed), false);
  assert.equal(isRoomStateStable(missing, settled), false);
});

test('settleNightCapture skips wait and pinning during day or dawn', async () => {
  const clock = makeClock();
  let pinned = 0;
  const result = await settleNightCapture({
    readState: async () => ({
      hasSignal: true,
      phase: 'day',
      ladderLevel: 2,
      postFxLevel: null,
      working: { command: 0 },
      workingTotal: 0,
      routingTotal: 3,
    }),
    pinFull: async () => { pinned += 1; },
    ...clock,
  });

  assert.equal(pinned, 0);
  assert.equal(result.pinned, false);
  assert.equal(result.reason, 'day');
  assert.equal(result.waitedMs, 0);
  assert.equal(result.ladderLevel, 2);
});

test('settleNightCapture pins FULL and waits until routing finishes and working counts hold for 1 s', async () => {
  const clock = makeClock();
  let pinned = 0;
  let ladderLevel = 2;
  const sequence = [
    // Initial check
    { hasSignal: true, phase: 'night', working: { command: 0, forge: 0 }, workingTotal: 0, routingTotal: 4 },
    // Poll 1 right after pinning: workers walking, working counts unchanged at 0
    { hasSignal: true, phase: 'night', working: { command: 0, forge: 0 }, workingTotal: 0, routingTotal: 4 },
    // Poll 2 (1 s): still 0 working, still routing — must NOT settle early
    { hasSignal: true, phase: 'night', working: { command: 0, forge: 0 }, workingTotal: 0, routingTotal: 4 },
    // Poll 3 (2 s): some arrived, some still walking
    { hasSignal: true, phase: 'night', working: { command: 2, forge: 0 }, workingTotal: 2, routingTotal: 2 },
    // Poll 4 (3 s): all arrived, routingTotal === 0
    { hasSignal: true, phase: 'night', working: { command: 2, forge: 2 }, workingTotal: 4, routingTotal: 0 },
    // Poll 5 (4 s): identical working counts 1 s later with routingTotal === 0 -> stable
    { hasSignal: true, phase: 'night', working: { command: 2, forge: 2 }, workingTotal: 4, routingTotal: 0 },
  ];
  let idx = 0;

  const result = await settleNightCapture({
    readState: async () => ({ ...sequence[Math.min(idx++, sequence.length - 1)], ladderLevel, postFxLevel: null }),
    pinFull: async () => { pinned += 1; ladderLevel = 0; },
    ...clock,
  });

  assert.equal(pinned, 1);
  assert.equal(result.pinned, true);
  assert.equal(result.ladderLevel, 0);
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'stable');
  assert.equal(result.waitedMs, 4 * NIGHT_POLL_INTERVAL_MS);
  assert.equal(result.workingTotal, 4);
  assert.equal(result.routingTotal, 0);
});

test('settleNightCapture settles empty or waiting-only scenes in one poll interval at dusk', async () => {
  const clock = makeClock();
  let ladderLevel = 1;
  const result = await settleNightCapture({
    readState: async () => ({
      hasSignal: true,
      phase: 'dusk',
      ladderLevel,
      postFxLevel: null,
      working: { command: 0, forge: 0 },
      workingTotal: 0,
      routingTotal: 0,
    }),
    pinFull: async () => { ladderLevel = 0; },
    ...clock,
  });

  assert.equal(result.settled, true);
  assert.equal(result.reason, 'stable');
  assert.equal(result.ladderLevel, 0);
  assert.equal(result.waitedMs, NIGHT_POLL_INTERVAL_MS);
});

test('settleNightCapture enforces the 25 s cap when visitors never settle', async () => {
  const clock = makeClock();
  let ladderLevel = 2;
  let tick = 0;
  const result = await settleNightCapture({
    readState: async () => ({
      hasSignal: true,
      phase: 'night',
      ladderLevel,
      postFxLevel: null,
      working: { command: tick++ % 2 },
      workingTotal: 1,
      routingTotal: 1,
    }),
    pinFull: async () => { ladderLevel = 0; },
    ...clock,
  });

  assert.equal(result.settled, false);
  assert.equal(result.reason, 'cap');
  assert.equal(result.ladderLevel, 0);
  assert.equal(result.waitedMs, NIGHT_SETTLE_CAP_MS);
});

test('settleNightCapture falls back to a fixed wait only when no room-slot signal exists', async () => {
  const clock = makeClock();
  let ladderLevel = 2;
  const result = await settleNightCapture({
    readState: async () => ({
      hasSignal: false,
      phase: 'night',
      ladderLevel,
      postFxLevel: null,
      working: null,
      workingTotal: 0,
      routingTotal: 0,
    }),
    pinFull: async () => { ladderLevel = 0; },
    ...clock,
  });

  assert.equal(result.settled, false);
  assert.equal(result.reason, 'fallback-wait');
  assert.equal(result.ladderLevel, 0);
  // 1 s grace poll + 20 s fixed fallback = 21 s (within 25 s cap).
  assert.equal(result.waitedMs, NIGHT_POLL_INTERVAL_MS + NIGHT_FALLBACK_WAIT_MS);
});

test('settleNightCapture supports skipSettle and force options', async () => {
  const clock = makeClock();
  let ladderLevel = 2;
  const result = await settleNightCapture({
    readState: async () => ({
      hasSignal: true,
      phase: 'day',
      ladderLevel,
      postFxLevel: null,
      working: { command: 0 },
      workingTotal: 0,
      routingTotal: 2,
    }),
    pinFull: async () => { ladderLevel = 0; },
    ...clock,
  }, { force: true, skipSettle: true });

  assert.equal(result.pinned, true);
  assert.equal(result.ladderLevel, 0);
  assert.equal(result.reason, 'pinned-only');
  assert.equal(result.waitedMs, 0);
});
