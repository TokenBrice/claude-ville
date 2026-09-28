// The village's shared cue score.
//
// `CueKit` publishes the ACTUAL scheduled note times of every admitted cue
// here; visual accents read the same score, so a mark lands on the note that
// carries it instead of on a pulse of its own. Both directions are honest and
// both are supported:
//
//   * sound leads — the recovery bracket closes on the first bell and its
//     diamond appears on the octave; one council notch lands per gathered
//     member on successive bells;
//   * the body leads — an arriving villager's foot rune is up to three seconds
//     after the scene event that admitted the cue, so the accent declares its
//     draw time with `scheduleAccent()` and the bells are scheduled to land on
//     it.
//
// Silence is not a special case. With no audio context the score is published
// on the monotonic clock immediately, so every accent still appears; nothing in
// the world ever waits for sound. Governor aggregation keeps the representative
// identity: the score belongs to the cue that actually sounded, never to the
// collapsed announcement.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { AURORA_FIGURE, HOUR_FIGURE } from './Motifs.js';

// P2 caps: eight admitted scores and forty note accents live at once. Expired
// beats are dropped, never replayed after a hidden tab.
const MAX_SCORES = 8;
const MAX_ACCENTS = 40;
const SCORE_TTL_MS = 4000;
const ACCENT_TTL_MS = 4000;
// How long a declared accent stays available to anchor a cue that has not been
// admitted yet. One event dispatch is enough; this is the safety margin.
const ANCHOR_TTL_MS = 400;
// An accent snaps onto a note only when the note is this close: a visual is
// never moved far enough to lie about when its fact happened.
const SNAP_WINDOW_MS = 200;
// The furthest ahead a body accent may pull a cue's notes.
const MAX_ANCHOR_LEAD_MS = 3500;
const MAX_LAG_SAMPLES = 16;

const COUNCIL_NOTE_SPACING_MS = 280;

// Fixed note offsets, in milliseconds from the cue's first note. These are the
// offsets CueKit synthesises with — one table, so a published time can never
// disagree with the bell that plays. They are the offsets with no music; while
// music plays CueKit moves routine and outcome notes onto the band's grid and
// publishes the notes it really struck.
const NOTE_OFFSETS_MS = Object.freeze({
    arrival: Object.freeze([0, 220]),
    departure: Object.freeze([0, 240]),
    recovery: Object.freeze([0, 200]),
    aurora: Object.freeze(AURORA_FIGURE.notes.map(note => note.atMs)),
    // Signal: the cracked bell's fall (its grace strike sits inside the start
    // lead, an ornament, not a note); three escapement ticks slowing down;
    // the Signals-only answer.
    distress: Object.freeze([0, 400]),
    limit: Object.freeze([0, 260, 620]),
    answered: Object.freeze([0]),
    // Outcomes (C4 tiers: Minor one onset, Medium two, Major ≤ 2.5 s).
    turnDone: Object.freeze([0]),
    subagentReturn: Object.freeze([0, 60]),
    toolFailed: Object.freeze([0, 110]),
    pushFailed: Object.freeze([0, 110]),
    commit: Object.freeze([0]),
    push: Object.freeze([0, 140]),
    release: Object.freeze([0, 120, 240, 360, 720]),
    dispatch: Object.freeze([0]),
    // Scenery: the lantern goes out; relit is two notes.
    linkLost: Object.freeze([0]),
    linkRestored: Object.freeze([0, 180]),
});

// The ship's bell (needs-you, S1): strikes at 0 and 150 ms, the pair repeated
// every 650 ms. Ladder L2 rings one pair, L1 two, L3 and L4 three.
const SHIP_PAIR_MS = 150;
const SHIP_REPEAT_MS = 650;
// An errors reminder at L3 rings the cracked bell's figure twice.
const ERROR_REPEAT_MS = 1200;
// Hour count (D7): the great bell stands for six; single strikes ≥ 1 s apart.
const HOUR_COUNT_START_MS = 4200;
const HOUR_GREAT_BELL_GAP_MS = 1800;
const HOUR_STRIKE_GAP_MS = 1400;
// The return digest: ≤ 5 notes, 220 ms apart (≤ 1.2 s).
export const DIGEST_MAX_NOTES = 5;
const DIGEST_SPACING_MS = 220;

// The note a body-led accent claims, for cues whose visual mark belongs to a
// moving body rather than to the moment the cue was admitted. The release
// peal lands its closing chord on the crown's cream frame.
export const CUE_ACCENT_NOTE = Object.freeze({
    arrival: 1,
    departure: 1,
    release: 4,
});

export function councilBellCount(teamSize) {
    const size = Number(teamSize);
    if (!Number.isFinite(size)) return 3;
    return Math.max(2, Math.min(5, Math.round(size)));
}

/** A ladder level 1–4 (L1 = entry) from a cue payload. */
export function ladderLevel(level) {
    const n = Math.round(Number(level));
    return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
}

// Families stop climbing: errors hold at L3, quota stops at L2 (SIG-2).
const FAMILY_TOP_LEVEL = Object.freeze({ needsYou: 4, errors: 3, quota: 2 });

/** The entry kind a reminder family rings, and the level it may ring at. */
export function reminderVoice({ family, level } = {}) {
    const top = FAMILY_TOP_LEVEL[family] ?? FAMILY_TOP_LEVEL.needsYou;
    const kind = family === 'errors' ? 'distress' : family === 'quota' ? 'limit' : 'summons';
    return { kind, level: Math.min(top, ladderLevel(level ?? 2)) };
}

export function shipBellPairs(level) {
    const L = ladderLevel(level);
    return L === 2 ? 1 : L >= 3 ? 3 : 2;
}

/** The 12-hour count for an hour 0–23 (noon and midnight are 12). */
export function hourCount(hour) {
    const h = Math.trunc(Number(hour));
    return Number.isFinite(h) ? (((h % 12) + 11) % 12) + 1 : 12;
}

// Whether an hour cue counts: only when asked, never soft or at night.
export function hourCounts({ count = false, soft = false, phase = 'day' } = {}) {
    return Boolean(count) && !soft && phase !== 'night';
}

function hourOffsets(cue) {
    const offsets = HOUR_FIGURE.notes.map(note => note.atMs);
    if (!hourCounts(cue)) return offsets;
    const h = hourCount(cue.hour);
    let at = HOUR_COUNT_START_MS;
    let singles = h;
    if (h >= 6) {
        offsets.push(at);
        at += HOUR_GREAT_BELL_GAP_MS;
        singles = h - 6;
    }
    for (let i = 0; i < singles; i++) {
        offsets.push(at);
        at += HOUR_STRIKE_GAP_MS;
    }
    return offsets;
}

function signalOffsets(kind, level) {
    if (kind === 'summons') {
        const offsets = [];
        for (let k = 0; k < shipBellPairs(level); k++) {
            offsets.push(k * SHIP_REPEAT_MS, k * SHIP_REPEAT_MS + SHIP_PAIR_MS);
        }
        return offsets;
    }
    if (kind === 'distress' && ladderLevel(level) >= 3) {
        const figure = NOTE_OFFSETS_MS.distress;
        return [...figure, ...figure.map(ms => ms + ERROR_REPEAT_MS)];
    }
    return [...NOTE_OFFSETS_MS[kind]];
}

// The note times of one cue kind, relative to its first note, with no music.
// Council length follows the real team size, the needs-you figure its ladder
// level, a reminder its family's entry voice at its level, the hour its count
// and the digest its notes.
export function cueNoteOffsetsMs(kind, cue = {}) {
    if (kind === 'council') {
        const count = councilBellCount(cue.teamSize);
        const offsets = new Array(count);
        for (let i = 0; i < count; i++) offsets[i] = i * COUNCIL_NOTE_SPACING_MS;
        return offsets;
    }
    if (kind === 'summons') return signalOffsets(kind, cue.level);
    if (kind === 'reminder') {
        const voice = reminderVoice(cue);
        return signalOffsets(voice.kind, voice.level);
    }
    if (kind === 'hourBell') return hourOffsets(cue);
    if (kind === 'digest') {
        const count = Math.min(DIGEST_MAX_NOTES, Array.isArray(cue.notes) ? cue.notes.length : 0);
        if (!count) return null;
        return Array.from({ length: count }, (_, i) => i * DIGEST_SPACING_MS);
    }
    const fixed = NOTE_OFFSETS_MS[kind];
    return fixed ? [...fixed] : null;
}

// One identity for a cue's score, kept through governor aggregation: the agent
// it belongs to, or the team a council gathering belongs to.
export function cueScoreKey(cue = {}) {
    return cue.agentId ?? cue.teamName ?? null;
}

export function cueSourceEventId(cue = {}) {
    if (cue.sourceEventId) return String(cue.sourceEventId);
    const key = cueScoreKey(cue);
    return `${cue.kind}:${key ?? 'world'}`;
}

function nowMs() {
    return performance.now();
}

const state = {
    scores: [],
    accents: [],
    // 8.3 — cues a sounding director has admitted but not yet scheduled
    // (outcomes wait out their aggregation window): `{ kind, key, until }`.
    expected: [],
    diagnostics: {
        published: 0,
        silent: 0,
        anchored: 0,
        snapped: 0,
        dropped: 0,
        notesDrawn: 0,
        lastLagMs: null,
        maxLagMs: 0,
        lags: [],
    },
};

// A score lives until its own last note is this far past: the notes are the
// contract, and one clock (the caller's) decides everything. A hidden tab
// therefore returns to dropped beats, never to a queue that replays.
function scoreExpired(score, now) {
    return now > score.notes[score.notes.length - 1].atMs + SCORE_TTL_MS;
}

function pruneScores(now) {
    for (let i = state.scores.length - 1; i >= 0; i--) {
        if (scoreExpired(state.scores[i], now)) state.scores.splice(i, 1);
    }
    while (state.scores.length > MAX_SCORES) {
        state.scores.shift();
        state.diagnostics.dropped++;
    }
}

function pruneAccents(now) {
    for (let i = state.accents.length - 1; i >= 0; i--) {
        if (now - state.accents[i].declaredAt > ACCENT_TTL_MS) state.accents.splice(i, 1);
    }
    while (state.accents.length > MAX_ACCENTS) {
        state.accents.shift();
        state.diagnostics.dropped++;
    }
}

function findScore(kind, key, now) {
    for (let i = state.scores.length - 1; i >= 0; i--) {
        const score = state.scores[i];
        if (score.kind !== kind) continue;
        if (key != null && score.key !== key) continue;
        if (scoreExpired(score, now)) continue;
        return score;
    }
    return null;
}

function recordLag(lagMs) {
    const diagnostics = state.diagnostics;
    diagnostics.notesDrawn++;
    diagnostics.lastLagMs = lagMs;
    if (lagMs > diagnostics.maxLagMs) diagnostics.maxLagMs = lagMs;
    diagnostics.lags.push(lagMs);
    if (diagnostics.lags.length > MAX_LAG_SAMPLES) diagnostics.lags.shift();
}

/**
 * Publish one admitted cue's real note times. `startMs` is the first note on
 * the monotonic (`performance.now`) clock; `silent` marks a score that will not
 * sound, whose notes are therefore already due. `pitches[i]` is note i's
 * struck fundamental (Hz; an array for a chord, melody first; null when
 * unpitched), published with its time for the score analyzers.
 */
export function publishCueScore({
    kind,
    agentId = null,
    teamName = null,
    sourceEventId = null,
    startMs = nowMs(),
    offsetsMs = null,
    pitches = null,
    silent = false,
} = {}) {
    const offsets = Array.isArray(offsetsMs) ? offsetsMs : null;
    if (!kind || !offsets?.length) return null;
    const now = nowMs();
    const key = agentId ?? teamName ?? null;
    const score = {
        kind,
        key,
        agentId: agentId ?? null,
        sourceEventId: sourceEventId || cueSourceEventId({ kind, agentId, teamName }),
        notes: offsets.map(offset => ({ atMs: startMs + offset, drawnAtMs: null })),
        silent: Boolean(silent),
        publishedAt: now,
    };
    state.scores.push(score);
    // The expected cue has its notes now.
    state.expected = state.expected.filter(entry => !(entry.kind === score.kind
        && (entry.key == null || score.key == null || entry.key === score.key)));
    pruneScores(now);
    state.diagnostics.published++;
    if (score.silent) state.diagnostics.silent++;

    eventBus.emit('audio:cue-scheduled', {
        kind: score.kind,
        agentId: score.agentId,
        sourceEventId: score.sourceEventId,
        notes: score.notes.map((note, i) => notePitch(note.atMs, pitches?.[i])),
        silent: score.silent,
    });
    return score;
}

// `{ atMs, hz }`, plus `chordHz` (the other struck pitches) for a chord.
function notePitch(atMs, pitch) {
    const list = (Array.isArray(pitch) ? pitch : [pitch]).filter(Number.isFinite);
    const out = { atMs, hz: list[0] ?? null };
    if (list.length > 1) out.chordHz = list.slice(1);
    return out;
}

/**
 * Has note `index` of this cue's score arrived? With no admitted score the
 * accent is already due — a silent village draws the same marks at once —
 * unless a sounding director expects the cue (`expectCueScore`). The first
 * frame a note reads due records its lag for the score diagnostics.
 */
export function cueNoteDue(kind, key, index, now = nowMs()) {
    // A cue still expected is newer than any score on record (publishing
    // clears its expectation), so its peak waits even past an older score.
    if (cueExpected(kind, key, now)) return false;
    const score = findScore(kind, key, now);
    if (!score) return true;
    const noteIndex = Math.max(0, Math.min(score.notes.length - 1, Math.trunc(Number(index) || 0)));
    const note = score.notes[noteIndex];
    if (now < note.atMs) return false;
    if (note.drawnAtMs == null) {
        note.drawnAtMs = now;
        recordLag(now - note.atMs);
    }
    return true;
}

// 8.3 — a director that will SOUND a cue it has admitted but not yet
// scheduled declares it here (an outcome waits out its aggregation window
// before CueKit scores it), so a moment's peak waits for the note instead of
// landing before the bell exists. Bounded by `withinMs`; never declared on a
// muted route, so silence never waits. A published score of the same kind and
// key clears it.
const MAX_EXPECTED = 16;
export function expectCueScore(kind, key = null, withinMs = 0, now = nowMs()) {
    if (!kind || !(withinMs > 0)) return;
    state.expected = state.expected.filter(entry => entry.until > now);
    state.expected.push({ kind, key: key ?? null, until: now + withinMs });
    if (state.expected.length > MAX_EXPECTED) state.expected.shift();
}

function cueExpected(kind, key, now) {
    for (const entry of state.expected) {
        if (entry.kind !== kind || entry.until <= now) continue;
        if (key == null || entry.key == null || entry.key === key) return true;
    }
    return false;
}

/** How many notes the live score for this cue has, or 0 when none is admitted. */
export function cueNoteCount(kind, key, now = nowMs()) {
    return findScore(kind, key, now)?.notes.length || 0;
}

/** The scheduled time of one note, or null when no score is admitted. */
export function cueNoteTime(kind, key, index, now = nowMs()) {
    const score = findScore(kind, key, now);
    if (!score) return null;
    const noteIndex = Math.max(0, Math.min(score.notes.length - 1, Math.trunc(Number(index) || 0)));
    return score.notes[noteIndex].atMs;
}

/**
 * Declare when a visual accent will be drawn and get the frame time to draw it.
 *
 * When the cue already sounds, the accent snaps onto the nearest note within
 * `SNAP_WINDOW_MS`. When the cue has not been admitted yet, the declaration
 * anchors it: `anchoredCueDelayMs` schedules the carrying note to sound at the
 * accent's own time. Either way the returned time is never later than the one
 * asked for by more than the snap window, and never waits on sound.
 *
 * @param {string|null} agentId the accent's agent (or team) identity
 * @param {number} atMs monotonic time the accent would otherwise be drawn
 * @param {string} kind cue kind the accent belongs to
 * @param {number} [now] the declaring frame's monotonic clock
 * @returns {number} monotonic time to draw the accent
 */
export function scheduleAccent(agentId, atMs, kind, now = nowMs()) {
    const requested = Number.isFinite(Number(atMs)) ? Number(atMs) : now;
    pruneAccents(now);
    if (state.accents.length >= MAX_ACCENTS) {
        state.diagnostics.dropped++;
        return requested;
    }

    const noteIndex = CUE_ACCENT_NOTE[kind] ?? 0;
    const score = findScore(kind, agentId ?? null, now);
    let at = requested;
    if (score) {
        let best = null;
        for (const note of score.notes) {
            const distance = Math.abs(note.atMs - requested);
            if (distance <= SNAP_WINDOW_MS && (best == null || distance < Math.abs(best - requested))) {
                best = note.atMs;
            }
        }
        if (best != null) {
            at = best;
            state.diagnostics.snapped++;
        }
    }

    state.accents.push({
        kind,
        key: agentId ?? null,
        noteIndex,
        atMs: at,
        declaredAt: now,
        anchored: !score,
    });
    return at;
}

/**
 * The delay a cue's synthesis needs so its carrying note lands on an accent
 * already declared for the same body. Returns `baseDelayMs` when no accent is
 * waiting, when the accent is sooner than the base delay, or when it is beyond
 * `MAX_ANCHOR_LEAD_MS` — the sound follows the body, never the reverse.
 */
export function anchoredCueDelayMs(kind, key, offsetsMs, baseDelayMs = 0, leadMs = 0, now = nowMs()) {
    const base = Math.max(0, Number(baseDelayMs) || 0);
    const noteIndex = CUE_ACCENT_NOTE[kind];
    if (noteIndex == null || !Array.isArray(offsetsMs) || !offsetsMs.length) return base;
    pruneAccents(now);
    for (let i = state.accents.length - 1; i >= 0; i--) {
        const accent = state.accents[i];
        if (accent.kind !== kind || accent.key !== (key ?? null)) continue;
        if (!accent.anchored || now - accent.declaredAt > ANCHOR_TTL_MS) continue;
        const offset = offsetsMs[Math.min(noteIndex, offsetsMs.length - 1)] || 0;
        const wanted = accent.atMs - now - Math.max(0, Number(leadMs) || 0) - offset;
        if (wanted <= base || wanted > MAX_ANCHOR_LEAD_MS) return base;
        state.diagnostics.anchored++;
        return wanted;
    }
    return base;
}

/**
 * Live score state for the audio debug readout: how many scores and accents are
 * resident, and how far behind their scheduled notes the drawn accents landed.
 */
export function cueScoreDiagnostics() {
    const now = nowMs();
    pruneScores(now);
    pruneAccents(now);
    const diagnostics = state.diagnostics;
    return {
        scores: state.scores.length,
        accents: state.accents.length,
        published: diagnostics.published,
        silent: diagnostics.silent,
        anchored: diagnostics.anchored,
        snapped: diagnostics.snapped,
        dropped: diagnostics.dropped,
        notesDrawn: diagnostics.notesDrawn,
        lastLagMs: diagnostics.lastLagMs,
        maxLagMs: diagnostics.maxLagMs,
        lags: [...diagnostics.lags],
        caps: { scores: MAX_SCORES, accents: MAX_ACCENTS },
    };
}

export function resetCueScore() {
    state.scores = [];
    state.accents = [];
    state.expected = [];
    state.diagnostics = {
        published: 0,
        silent: 0,
        anchored: 0,
        snapped: 0,
        dropped: 0,
        notesDrawn: 0,
        lastLagMs: null,
        maxLagMs: 0,
        lags: [],
    };
}
