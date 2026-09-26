// One priority arbiter for every one-shot cue. Urgent state signals sound
// immediately (a same-lane burst becomes one call and a flock); ladder
// reminders keep their own caps; outcomes share the routine budget with a
// reserve; routine/scenery bursts share a short aggregation window so a
// busy poll becomes one intelligible answer instead of a wall of beeps.

import { REMINDER_CAPS } from './UrgencyLadder.js';

export const CUE_LANES = Object.freeze({
    NEEDS_YOU: 'needsYou',
    ERRORS: 'errors',
    QUOTA: 'quota',
    // The signal stratum's non-urgent voices: ladder reminders, the Signals
    // `answered` strike and the link cues. They play while the page is away
    // (through the wake) and never enter the routine budget.
    REMINDER: 'reminder',
    OUTCOME: 'outcome',
    ROUTINE: 'routine',
    SCENERY: 'scenery',
});

export const URGENT_CUE_LANES = Object.freeze([
    CUE_LANES.NEEDS_YOU,
    CUE_LANES.ERRORS,
    CUE_LANES.QUOTA,
]);

const LANE_PRIORITY = Object.freeze({
    [CUE_LANES.NEEDS_YOU]: 6,
    [CUE_LANES.ERRORS]: 5,
    [CUE_LANES.QUOTA]: 4,
    [CUE_LANES.REMINDER]: 3,
    [CUE_LANES.OUTCOME]: 2,
    [CUE_LANES.ROUTINE]: 2,
    [CUE_LANES.SCENERY]: 1,
});

// Outcome tiers (C4, plan 3.4): Minor one onset, Medium two, Major ≤ 2.5 s
// and one active globally. A cue may name its own `tier`.
export const OUTCOME_TIERS = Object.freeze({
    turnDone: 'minor',
    subagentReturn: 'minor',
    dispatch: 'minor',
    toolFailed: 'medium',
    commit: 'medium',
    push: 'medium',
    pushFailed: 'medium',
    release: 'major',
});

export function outcomeTier(kind) {
    return OUTCOME_TIERS[kind] ?? null;
}

// Outcomes share the routine cues' per-minute budget; this many of it are
// reserved for outcomes, so routine chatter can never starve them (S7).
export const OUTCOME_RESERVED_PER_MINUTE = 2;
// The span a Major outcome holds the stage when it names none (C4: ≤ 2.5 s).
const MAJOR_ACTIVE_MS = 2500;

// Same-lane urgent cues this close to the first become its flock (SIG-10):
// the first rings at once, up to MAX_FLOCK followers add one soft strike
// each, and every one of them keeps its caption.
export const URGENT_CLUSTER_WINDOW_MS = 400;
export const MAX_FLOCK = 4;

function isSignalLane(lane) {
    return isUrgentCueLane(lane) || lane === CUE_LANES.REMINDER;
}

const KIND_LABELS = Object.freeze({
    arrival: ['arrival', 'arrivals'],
    departure: ['departure', 'departures'],
    recovery: ['recovery', 'recoveries'],
    council: ['council gathering', 'council gatherings'],
    hourBell: ['hour bell', 'hour bells'],
    aurora: ['chronicle milestone', 'chronicle milestones'],
    thunder: ['thunder cue', 'thunder cues'],
});

export function lanePriority(lane) {
    return LANE_PRIORITY[lane] || 0;
}

export function isUrgentCueLane(lane) {
    return URGENT_CUE_LANES.includes(lane);
}

export function compareCuePriority(a, b) {
    return lanePriority(b?.lane) - lanePriority(a?.lane);
}

// "5 arrivals" / "4 arrivals, 1 departure": the count a caption must keep,
// whether it heads an aggregate or follows the ceremony that absorbed it.
function partsLabel(cues) {
    const counts = new Map();
    for (const cue of cues) counts.set(cue.kind, (counts.get(cue.kind) || 0) + 1);
    const parts = [];
    for (const [kind, count] of counts) {
        const labels = KIND_LABELS[kind] || [kind, `${kind} cues`];
        parts.push(`${count} ${count === 1 ? labels[0] : labels[1]}`);
    }
    return parts.join(', ');
}

function aggregateLabel(cues) {
    return `Routine activity: ${partsLabel(cues)}`;
}

// Pure burst collapse. Urgent and explicitly provider-voiced cues are never
// merged. Eligible routine/scenery entries become one honest representative.
export function collapseCueBurst(cues) {
    const source = Array.isArray(cues) ? cues.filter(Boolean) : [];
    const bypass = source.filter(cue => (
        isUrgentCueLane(cue.lane) || cue.aggregate === false
    ));
    const routine = source.filter(cue => (
        !isUrgentCueLane(cue.lane) && cue.aggregate !== false
    ));
    if (!routine.length) return bypass.sort(compareCuePriority);

    const representative = [...routine].sort(compareCuePriority)[0];
    const aggregate = routine.length === 1
        ? representative
        : {
            ...representative,
            eventKind: 'aggregate',
            agentId: null,
            label: aggregateLabel(routine),
            aggregateCount: routine.length,
        };
    return [...bypass, aggregate].sort(compareCuePriority);
}

export function updateQuietFloor(state = {}, {
    calm = false,
    now = 0,
    enterAfterMs = 30000,
    leaveAfterMs = 4000,
} = {}) {
    const current = state.mode === 'resting' ? 'resting' : 'active';
    if (current === 'active') {
        const calmSince = calm ? (state.calmSince ?? now) : null;
        if (calm && now - calmSince >= enterAfterMs) {
            return { mode: 'resting', calmSince, activeSince: null };
        }
        return { mode: 'active', calmSince, activeSince: null };
    }

    const activeSince = calm ? null : (state.activeSince ?? now);
    if (!calm && now - activeSince >= leaveAfterMs) {
        return { mode: 'active', calmSince: null, activeSince };
    }
    return { mode: 'resting', calmSince: state.calmSince ?? null, activeSince };
}

// Away from the page only the signal stratum plays (through the wake);
// everything else describes a moment the listener is not in.
export function cueLifecycleDecision({ lane, hidden = false, returning = false } = {}) {
    if (returning) return 'discard';
    if (hidden && !isSignalLane(lane)) return 'suppress';
    return 'play';
}

// A routine burst that carries a team member's arrival is held this long so
// the gathering it belongs to can arrive and take its place (SCN-6: the
// renderer's `team:gather` trails the members' arrivals by ~200 ms).
const TEAM_HOLD_MS = 600;

function holdsForTeam(cue) {
    return cue?.kind === 'arrival' && Boolean(cue.teamName);
}

// A ceremony absorbs parts only when every one of them is an agent it names.
function coveredBy(cues, agentIds) {
    return cues.length > 0
        && cues.every(cue => cue.agentId != null && agentIds.has(String(cue.agentId)));
}

// The caption identity a routine cue was (or would have been) announced with,
// so a ceremony can replace that caption rather than stack beside it.
function captionOf(cue) {
    return {
        kind: cue?.eventKind || cue?.kind || null,
        agentId: cue?.agentId ?? null,
        label: cue?.label ?? null,
    };
}

export class CueGovernor {
    constructor({
        maxPerMinute = 6,
        minSpacingMs = 4000,
        aggregationWindowMs = 180,
        teamHoldMs = TEAM_HOLD_MS,
        outcomeReservePerMinute = OUTCOME_RESERVED_PER_MINUTE,
    } = {}) {
        this.maxPerMinute = maxPerMinute;
        this.outcomeReservePerMinute = outcomeReservePerMinute;
        this.minSpacingMs = minSpacingMs;
        this.aggregationWindowMs = aggregationWindowMs;
        this.teamHoldMs = teamHoldMs;
        this._lastByKind = new Map();
        this._recent = [];
        this._routine = [];
        this._routineTimer = null;
        this._routineStartedAt = 0;
        this._routineWindowMs = aggregationWindowMs;
        this._preparedRoutine = null;
        // The last announced routine burst, kept while it still blocks the
        // spacing rule: a ceremony arriving inside that span replaces it.
        this._announced = null;
        this._urgentUntil = 0;
        this._ceremonies = { superseded: 0, last: null };
        // The live same-lane urgent burst per lane: { until, followers }.
        this._clusters = new Map();
        // Heard ladder reminders (ms), for the S7 backstop caps.
        this._reminders = [];
        this._majorUntil = 0;
    }

    // `outcome` spends the shared per-minute budget without the spacing rule;
    // routine and scenery cues keep the spacing rule and may use all but the
    // outcome reserve.
    allow(kind, cooldownMs = 15000, { budget = true, key = kind, bypassSpacing = false, outcome = false } = {}) {
        const now = Date.now();
        const last = this._lastByKind.get(key) || 0;
        if (now - last < cooldownMs) return false;

        if (budget) {
            this._recent = this._recent.filter(entry => now - entry.at < 60000);
            if (this._recent.length >= this.maxPerMinute) return false;
            if (!outcome) {
                const routine = this._recent.filter(entry => !entry.outcome);
                if (routine.length >= this.maxPerMinute - this.outcomeReservePerMinute) return false;
                const newest = routine[routine.length - 1];
                if (!bypassSpacing && newest && now - newest.at < this.minSpacingMs) return false;
            }
            this._recent.push({ at: now, outcome });
        }

        this._lastByKind.set(key, now);
        return true;
    }

    submit(cue, play) {
        if (!cue?.lane || typeof play !== 'function') return false;
        if (isUrgentCueLane(cue.lane)) return this._submitUrgent(cue, play);

        // Routine information is momentary. Drop it during an urgent voice
        // instead of delaying it until the state it described has gone stale.
        // A reminder in that span is spent, not queued (SIG-2).
        if (Date.now() < this._urgentUntil) return false;
        if (cue.lane === CUE_LANES.REMINDER) return this._submitReminder(cue, play);
        if (cue.lane === CUE_LANES.OUTCOME) return this._submitOutcome(cue, play);
        if (Array.isArray(cue.supersedes)) return this._submitCeremony(cue, play);
        if (cue.aggregate === false) {
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: cue.budget !== false })) {
                return false;
            }
            play(cue);
            return true;
        }
        const queued = { ...cue, play };
        if (!this._routine.length) {
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: cue.budget !== false })) {
                return false;
            }
            this._routineStartedAt = Date.now();
            this._routineWindowMs = holdsForTeam(cue)
                ? Math.max(this.aggregationWindowMs, this.teamHoldMs)
                : this.aggregationWindowMs;
            this._prepare(queued);
            this._routine.push(queued);
            this._armFlush();
            return true;
        }

        const extend = holdsForTeam(cue) && this._routineWindowMs < this.teamHoldMs;
        if (extend) this._routineWindowMs = this.teamHoldMs;
        const preempts = compareCuePriority(queued, this._preparedRoutine?.cue) < 0;
        if (preempts || extend) {
            const lead = preempts ? queued : this._preparedRoutine.cue;
            this._cancelPreparedRoutine();
            this._prepare(lead);
        }
        this._routine.push(queued);
        if (extend) this._armFlush();
        return true;
    }

    // The first urgent cue of a lane rings at once. Same-lane urgents inside
    // its micro-window join it as flock strikes (`flock: true`,
    // `clusterIndex` 1…MAX_FLOCK), then as captions only: one call at the
    // loudness of one call, every agent still named (SIG-10).
    _submitUrgent(cue, play) {
        const now = Date.now();
        const key = cue.agentId == null ? cue.kind : `${cue.kind}:${cue.agentId}`;
        const cluster = this._clusters.get(cue.lane);
        if (cluster && now < cluster.until) {
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: false, key })) return false;
            cluster.followers += 1;
            if (cluster.followers <= MAX_FLOCK) play({ ...cue, flock: true, clusterIndex: cluster.followers });
            else play(cue, { announceOnly: true });
            return true;
        }
        this.clearRoutine();
        if (!this.allow(cue.kind, cue.cooldownMs, { budget: false, key })) return false;
        this._clusters.set(cue.lane, { until: now + URGENT_CLUSTER_WINDOW_MS, followers: 0 });
        this._urgentUntil = now + Math.max(0, Number(cue.guardMs) || 3000);
        play(cue);
        return true;
    }

    // The ladder spaces its reminders itself (UrgencyLadder.js); the S7 caps
    // are held here too, so no second source can out-talk them.
    _submitReminder(cue, play) {
        const now = Date.now();
        const capped = cue.kind === 'reminder';
        if (capped) {
            this._reminders = this._reminders.filter(at => now - at < REMINDER_CAPS.windowMs);
            const last = this._reminders[this._reminders.length - 1];
            if (last != null && now - last < REMINDER_CAPS.minGapMs) return false;
            if (this._reminders.length >= REMINDER_CAPS.perHour) return false;
        }
        const key = cue.cooldownKey ?? cue.kind;
        if (!this.allow(cue.kind, capped ? 0 : cue.cooldownMs, { budget: false, key })) return false;
        if (capped) this._reminders.push(now);
        if (Number(cue.guardMs) > 0) this._urgentUntil = Math.max(this._urgentUntil, now + Number(cue.guardMs));
        play(cue);
        return true;
    }

    // Outcomes never aggregate here (Minor kinds are counted upstream); they
    // spend the shared budget, and one Major holds the stage at a time.
    _submitOutcome(cue, play) {
        const now = Date.now();
        const major = (cue.tier ?? outcomeTier(cue.kind)) === 'major';
        if (major && now < this._majorUntil) return false;
        if (!this.allow(cue.kind, cue.cooldownMs, {
            budget: cue.budget !== false,
            key: cue.cooldownKey ?? cue.kind,
            outcome: true,
        })) return false;
        if (major) this._majorUntil = now + Math.max(0, Number(cue.activeMs) || MAJOR_ACTIVE_MS);
        play(cue);
        return true;
    }

    // A ceremony (`supersedes: agentIds[]`) is one sound for a moment its
    // parts already announced. It bypasses the spacing rule once — the parts
    // are why that rule would refuse it — but never the per-minute budget, and
    // it absorbs a pending or just-announced aggregate made only of its agents.
    _submitCeremony(cue, play) {
        if (!this.allow(cue.kind, cue.cooldownMs, {
            budget: cue.budget !== false,
            bypassSpacing: true,
        })) return false;
        const replaces = this._absorb(cue.kind, cue.supersedes);
        play(replaces ? { ...cue, replaces } : cue);
        return true;
    }

    _absorb(kind, agentIds) {
        const ids = new Set(agentIds.filter(id => id != null && id !== '').map(String));
        if (!ids.size) return null;

        if (coveredBy(this._routine, ids)) {
            const parts = this._routine;
            const caption = captionOf(collapseCueBurst(parts)[0]);
            this.clearRoutine();
            return this._recordCeremony(kind, parts, caption);
        }

        const announced = this._announced;
        if (announced && Date.now() >= announced.until) this._announced = null;
        else if (announced && coveredBy(announced.cues, ids)) {
            this._announced = null;
            // Notes still ahead of the audio clock are released; a note that
            // has already sounded rings out.
            if (typeof announced.cancel === 'function') announced.cancel();
            return this._recordCeremony(kind, announced.cues, announced.caption);
        }
        return null;
    }

    _recordCeremony(kind, parts, caption) {
        const count = parts.length;
        const label = partsLabel(parts);
        this._ceremonies = {
            superseded: this._ceremonies.superseded + 1,
            last: { kind, count, parts: label, at: Date.now() },
        };
        return { ...caption, count, parts: label };
    }

    _remainingWindowMs() {
        return Math.max(0, this._routineWindowMs - (Date.now() - this._routineStartedAt));
    }

    _prepare(cue) {
        this._preparedRoutine = {
            cue,
            cancel: cue.play(cue, { prepare: true, delayMs: this._remainingWindowMs() }),
        };
    }

    _armFlush() {
        clearTimeout(this._routineTimer);
        this._routineTimer = setTimeout(() => this._flushRoutine(), this._remainingWindowMs());
    }

    _flushRoutine() {
        const queued = this._routine;
        this._routine = [];
        this._routineTimer = null;
        const cue = collapseCueBurst(queued)[0];
        const prepared = this._preparedRoutine;
        this._preparedRoutine = null;
        this._routineStartedAt = 0;
        this._routineWindowMs = this.aggregationWindowMs;
        if (!cue || !prepared) return;
        prepared.cue.play(cue, { announceOnly: true });
        this._announced = {
            cues: queued,
            caption: captionOf(cue),
            cancel: prepared.cancel,
            until: Date.now() + this.minSpacingMs,
        };
    }

    clearRoutine() {
        clearTimeout(this._routineTimer);
        this._cancelPreparedRoutine();
        this._routineTimer = null;
        this._routine = [];
        this._routineStartedAt = 0;
        this._routineWindowMs = this.aggregationWindowMs;
        this._announced = null;
    }

    _cancelPreparedRoutine() {
        const cancel = this._preparedRoutine?.cancel;
        this._preparedRoutine = null;
        if (typeof cancel === 'function') cancel();
    }

    snapshot() {
        const last = this._ceremonies.last;
        return {
            ceremonies: {
                superseded: this._ceremonies.superseded,
                last: last ? { ...last } : null,
            },
        };
    }

    destroy() {
        this.clearRoutine();
        this._recent = [];
        this._urgentUntil = 0;
        this._majorUntil = 0;
        this._reminders = [];
        this._clusters.clear();
        this._lastByKind.clear();
    }
}
