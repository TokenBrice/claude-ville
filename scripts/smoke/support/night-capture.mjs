// NE P0.2 — shared night/dusk capture readiness helper.
// Imported helper; not directly executable.
//
// The GPU quality ladder boots at MINIMAL and climbs, and simulated villagers
// need ~20 s to walk to their work buildings and light their rooms. For dusk
// and night captures, pin the ladder to FULL (`setOverride(0)`) and poll
// `renderer.buildingRenderer._roomSlotsByType` until working counts hold
// identical across two polls 1 s apart with no working visitors still routing
// (capped at 25 s; fixed-wait fallback only when no room-slot signal exists).
// Day and dawn captures skip the wait so they stay as fast as they are.

export const NIGHT_POLL_INTERVAL_MS = 1_000;
export const NIGHT_SETTLE_CAP_MS = 25_000;
export const NIGHT_FALLBACK_WAIT_MS = 20_000;
export const SIGNAL_GRACE_POLLS = 2;

export function isNightOrDuskPhase(phase) {
  return phase === 'night' || phase === 'dusk';
}

export function workingCountsKey(working) {
  if (!working || typeof working !== 'object') return '';
  return Object.keys(working)
    .sort()
    .map(type => `${type}:${Number(working[type]) || 0}`)
    .join(',');
}

export function isRoomStateStable(previous, current) {
  if (!previous?.hasSignal || !current?.hasSignal) return false;
  if ((previous.routingTotal || 0) !== 0 || (current.routingTotal || 0) !== 0) return false;
  return workingCountsKey(previous.working) === workingCountsKey(current.working);
}

/**
 * Pure async settle loop driven by injected callbacks (unit-tested without
 * Playwright, and wrapped by `prepareNightCapture(page)` below).
 */
export async function settleNightCapture(
  { readState, pinFull, wait, now = () => Date.now() },
  {
    force = false,
    skipSettle = false,
    pollIntervalMs = NIGHT_POLL_INTERVAL_MS,
    capMs = NIGHT_SETTLE_CAP_MS,
    fallbackWaitMs = NIGHT_FALLBACK_WAIT_MS,
    gracePolls = SIGNAL_GRACE_POLLS,
  } = {},
) {
  const initial = await readState();
  const isNight = force || isNightOrDuskPhase(initial?.phase);
  if (!isNight) {
    return {
      phase: initial?.phase ?? null,
      pinned: false,
      ladderLevel: initial?.ladderLevel ?? null,
      postFxLevel: initial?.postFxLevel ?? null,
      settled: true,
      reason: 'day',
      waitedMs: 0,
      polls: 0,
      workingTotal: initial?.workingTotal ?? 0,
      routingTotal: initial?.routingTotal ?? 0,
      working: initial?.working ?? null,
    };
  }

  await pinFull();
  const startedAt = now();
  let state = await readState();

  if (skipSettle) {
    return {
      phase: state?.phase ?? initial?.phase ?? null,
      pinned: true,
      ladderLevel: state?.ladderLevel ?? null,
      postFxLevel: state?.postFxLevel ?? null,
      settled: true,
      reason: 'pinned-only',
      waitedMs: Math.max(0, Math.round(now() - startedAt)),
      polls: 1,
      workingTotal: state?.workingTotal ?? 0,
      routingTotal: state?.routingTotal ?? 0,
      working: state?.working ?? null,
    };
  }

  let polls = 1;
  let noSignalPolls = state?.hasSignal ? 0 : 1;
  let previous = state?.hasSignal ? state : null;

  for (;;) {
    const elapsed = Math.max(0, now() - startedAt);
    if (!state?.hasSignal && noSignalPolls >= gracePolls) {
      const remaining = Math.min(fallbackWaitMs, Math.max(0, capMs - elapsed));
      if (remaining > 0) await wait(remaining);
      state = await readState();
      return {
        phase: state?.phase ?? initial?.phase ?? null,
        pinned: true,
        ladderLevel: state?.ladderLevel ?? null,
        postFxLevel: state?.postFxLevel ?? null,
        settled: false,
        reason: 'fallback-wait',
        waitedMs: Math.max(0, Math.round(now() - startedAt)),
        polls,
        workingTotal: state?.workingTotal ?? 0,
        routingTotal: state?.routingTotal ?? 0,
        working: state?.working ?? null,
      };
    }

    if (elapsed >= capMs) {
      return {
        phase: state?.phase ?? initial?.phase ?? null,
        pinned: true,
        ladderLevel: state?.ladderLevel ?? null,
        postFxLevel: state?.postFxLevel ?? null,
        settled: false,
        reason: 'cap',
        waitedMs: Math.max(0, Math.round(elapsed)),
        polls,
        workingTotal: state?.workingTotal ?? 0,
        routingTotal: state?.routingTotal ?? 0,
        working: state?.working ?? null,
      };
    }

    const stepMs = Math.min(pollIntervalMs, Math.max(0, capMs - elapsed));
    await wait(stepMs);
    state = await readState();
    polls += 1;

    if (!state?.hasSignal) {
      noSignalPolls += 1;
      previous = null;
      continue;
    }

    noSignalPolls = 0;
    if (isRoomStateStable(previous, state)) {
      return {
        phase: state.phase ?? initial?.phase ?? null,
        pinned: true,
        ladderLevel: state.ladderLevel ?? null,
        postFxLevel: state.postFxLevel ?? null,
        settled: true,
        reason: 'stable',
        waitedMs: Math.max(0, Math.round(now() - startedAt)),
        polls,
        workingTotal: state.workingTotal ?? 0,
        routingTotal: state.routingTotal ?? 0,
        working: state.working ?? null,
      };
    }
    previous = state;
  }
}

export function pinQualityLadderFull(page) {
  return page.evaluate(() => {
    const r = window.__claudeVilleApp?.renderer;
    r?.gpuWorld?.qualityLadder?.setOverride?.(0);
    if (typeof r?.postFx?.setLevelOverride === 'function') {
      r.postFx.setLevelOverride(0);
    } else {
      r?.postFx?.ladder?.setOverride?.(0);
    }
    return {
      ladderLevel: r?.gpuWorld?.qualityLadder?.getLevel?.() ?? null,
      postFxLevel: r?.postFx?.ladder?.getLevel?.() ?? null,
    };
  });
}

export function readNightCaptureState(page) {
  return page.evaluate(() => {
    const r = window.__claudeVilleApp?.renderer;
    const atm = r?.atmosphereState || window.__claudeVilleAtmosphere;
    const phase = atm?.snapshot?.()?.phase ?? r?._lastAtmosphere?.phase ?? null;
    const ladderLevel = r?.gpuWorld?.qualityLadder?.getLevel?.() ?? null;
    const postFxLevel = r?.postFx?.ladder?.getLevel?.() ?? null;
    const slots = r?.buildingRenderer?._roomSlotsByType;
    if (!(slots instanceof Map) || slots.size === 0) {
      return {
        hasSignal: false,
        phase,
        ladderLevel,
        postFxLevel,
        working: null,
        workingTotal: 0,
        routingTotal: 0,
      };
    }
    const working = {};
    let workingTotal = 0;
    let routingTotal = 0;
    for (const [type, slot] of slots) {
      const w = Number(slot?.working) || 0;
      const rt = Number(slot?.routing) || 0;
      working[type] = w;
      workingTotal += w;
      routingTotal += rt;
    }
    return {
      hasSignal: true,
      phase,
      ladderLevel,
      postFxLevel,
      working,
      workingTotal,
      routingTotal,
    };
  });
}

/**
 * NE P0.2 — prepare a Playwright page before a World screenshot.
 * On dusk/night (or with `force: true`), pins FULL quality and polls
 * `_roomSlotsByType` until working visitors reach their rooms (capped at 25 s).
 * On day/dawn, returns immediately with current phase and ladderLevel.
 */
export function prepareNightCapture(page, options = {}) {
  return settleNightCapture(
    {
      readState: () => readNightCaptureState(page),
      pinFull: () => pinQualityLadderFull(page),
      wait: ms => page.waitForTimeout(ms),
    },
    options,
  );
}
