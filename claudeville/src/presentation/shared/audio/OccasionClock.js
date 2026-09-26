// The occasion clock (plan 6.6; SCN-3, SOTA-4, MUSL-7, MUS-7; decision D1):
// when the Village plays music. Music is an event, never wallpaper: a whole
// tune means dawn, noon, dusk, night, something shipped, you're back, or the
// first time this profile ever turned sound on; between them only a closed
// 2–4 bar fragment now and then, sparser when the village is busy and at
// night. Nothing starts while the village rests, in rain or a storm, within
// 5 s of an urgent cue, over a wait of 6 min or more, or behind the blurred
// window's quiet mix; music already playing when one of those becomes true
// is released. So music itself is a peripheral all-clear.
//
// Pure: no timers, no clock reads. `now` is ms on whatever clock the caller
// keeps (the director passes Date.now(), which the probe virtualizes); the
// local calendar is derived from it only to key the once-per-day ledger.
// Randomness is the caller's seeded stream. The director asks once per 1 Hz
// tick, plays what the answer names and reports back what actually started.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// While at least this many audible agents work, the day plays fragments only.
export const BUSY_WORKING = 3;
// The S7 hard zeros.
export const URGENT_QUIET_MS = 5000;
export const WAIT_LIMIT_MS = 6 * MINUTE_MS;
// Duty is measured over the rolling hour of started spans, as heard: each
// span runs from its first note to its last note's end plus the ring-out in
// the air (the round-2 day fragments: 8.97 s of notes, ≈ 11.5 s heard).
export const DUTY_WINDOW_MS = HOUR_MS;
export const RING_OUT_SEC = 2.5;
// What one fragment costs the duty budget before it plays.
export const FRAGMENT_ESTIMATE_SEC = 12;
// A refusal from the sequencer (busy, stopped) is asked again this much later.
export const RETRY_MS = 4000;
// Fragments that state the signature motif, per rolling hour: the S7 budget
// is ≤ 6 statements an hour across cues, fragments and chimes, and the hour
// phrase and the arrival quote spend the rest.
export const MOTIF_FRAGMENTS_PER_HOUR = 2;
// A fragment is not heard again within this long (MUS-18 re-hearing over
// music-on windows): the least recently played cell goes next, and none cut
// from a piece that played whole as an occasion in this window.
export const FRAGMENT_REHEAR_MS = HOUR_MS;

// D1 (MUSL round 2's revised duty; binding). `gapSec` is the seeded silence
// from the end of the last music to the next fragment; `maxDuty` is a hard
// cap on the rolling hour that drops fragments first (occasions are always
// allowed once per phase); `minDuty` is the band's floor where D1 states one.
// Busy: 110–160 s of silence after a ≈ 9 s fragment is one every 2–2.8 min,
// ≈ 8 % of the hour heard (≈ 6.3 % on notes alone).
export const D1_DUTY = Object.freeze({
    busy: Object.freeze({ name: 'busy', minDuty: 0.06, maxDuty: 0.10, gapSec: Object.freeze([110, 160]) }),
    light: Object.freeze({ name: 'light', minDuty: 0, maxDuty: 0.20, gapSec: Object.freeze([60, 110]) }),
    night: Object.freeze({ name: 'night', minDuty: 0, maxDuty: 0.08, gapSec: Object.freeze([240, 360]) }),
    deepNight: Object.freeze({ name: 'deepNight', minDuty: 0, maxDuty: 0.03, gapSec: Object.freeze([720, 1080]) }),
});

// One full occasion per phase (SCN-3), deferred rather than dropped: each
// opens at its moment and stays due until its phase is over.
//   dawn   progress ≥ 0.1 of the dawn phase
//   noon   from 11:50 through the rest of the day phase
//   dusk   progress ≥ 0.2 of the dusk phase (golden hour)
//   night  21:00 until deep night (02:00): the waltz
export const PHASE_OCCASIONS = Object.freeze(['dawn', 'noon', 'dusk', 'night']);
export const OCCASION_RULES = Object.freeze({
    dawn: Object.freeze({ phase: 'dawn', fromProgress: 0.1 }),
    noon: Object.freeze({ phase: 'day', fromMinute: 11 * 60 + 50 }),
    dusk: Object.freeze({ phase: 'dusk', fromProgress: 0.2 }),
    night: Object.freeze({ phase: 'night', fromMinute: 21 * 60, untilMinute: 2 * 60 }),
});

// Earned occasions: when each becomes due after its event and how long it
// may wait for a hard zero to clear. The release follows the gold peal
// (≤ 2.5 s); a return needs 20 min away; the welcome is part of an enable.
export const EARNED_RULES = Object.freeze({
    release: Object.freeze({ afterMs: 2500, expiresMs: MINUTE_MS }),
    return: Object.freeze({ afterMs: 0, expiresMs: 5 * MINUTE_MS, minAwayMs: 20 * MINUTE_MS }),
    first: Object.freeze({ afterMs: 0, expiresMs: Infinity }),
    welcome: Object.freeze({ afterMs: 0, expiresMs: 2 * MINUTE_MS }),
});
const EARNED_ORDER = Object.freeze(['release', 'return', 'first', 'welcome']);
// The island's day turns over in the small hours, so a night occasion that
// runs past midnight belongs to the evening it started in.
const ISLAND_DAY_OFFSET_MS = 4 * HOUR_MS;

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar date of `now` (ms) as `YYYY-MM-DD`. */
export function calendarDayKey(now) {
    const date = new Date(now);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The island day of `now`: the calendar date four hours earlier. */
export function islandDayKey(now) {
    return calendarDayKey(now - ISLAND_DAY_OFFSET_MS);
}

/** The D1 duty row for one tick's input. */
export function dutyBandFor({ phase = 'day', keyframe = null, working = 0 } = {}) {
    if (phase === 'night') return keyframe === 'deep-night' ? D1_DUTY.deepNight : D1_DUTY.night;
    return Number(working) >= BUSY_WORKING ? D1_DUTY.busy : D1_DUTY.light;
}

/** Whether a phase occasion's moment has come at this input. */
export function occasionOpen(name, { phase, phaseProgress = 0, minuteOfDay = 12 * 60, keyframe = null } = {}) {
    const rule = OCCASION_RULES[name];
    if (!rule || phase !== rule.phase) return false;
    if (rule.fromProgress !== undefined) return Number(phaseProgress) >= rule.fromProgress;
    const minute = Number(minuteOfDay);
    if (rule.untilMinute !== undefined) {
        if (keyframe === 'deep-night' || keyframe === 'pre-dawn') return false;
        return minute >= rule.fromMinute || minute < rule.untilMinute;
    }
    return minute >= rule.fromMinute;
}

/** The first hard zero that holds, or null (S7, D1). */
export function hardZero({ resting = false, raining = false, quiet = false, oldestWaitMs = 0 } = {}, now, lastUrgentAt) {
    if (quiet) return 'quiet';
    if (resting) return 'resting';
    if (raining) return 'rain';
    if (Number(oldestWaitMs) >= WAIT_LIMIT_MS) return 'wait';
    if (Number.isFinite(lastUrgentAt) && now - lastUrgentAt < URGENT_QUIET_MS) return 'urgent';
    return null;
}

function normalLedger(ledger) {
    const source = ledger && typeof ledger === 'object' ? ledger : {};
    return {
        firstOccasion: source.firstOccasion === true,
        welcomeDay: typeof source.welcomeDay === 'string' ? source.welcomeDay : null,
        islandDay: typeof source.islandDay === 'string' ? source.islandDay : null,
        occasions: Array.isArray(source.occasions)
            ? source.occasions.filter(name => PHASE_OCCASIONS.includes(name))
            : [],
    };
}

const lerp = (range, u) => range[0] + (range[1] - range[0]) * u;

export class OccasionClock {
    /**
     * @param {object} [options]
     * @param {() => number} [options.rng] seeded uniform [0, 1)
     * @param {object|null} [options.ledger] the persisted once-per-day record
     * @param {Array<{ id: string, source?: string, night?: boolean, motif?: string|null }>} [options.fragments]
     *   the songbook's fragment cells; without them a fragment names no cell
     *   and the sequencer picks one
     * @param {object|null} [options.occasions] the songbook's OCCASIONS, so a
     *   piece played whole keeps its cells out of the next hour
     */
    constructor({ rng = Math.random, ledger = null, fragments = [], occasions = null } = {}) {
        this._rng = typeof rng === 'function' ? rng : Math.random;
        this._ledger = normalLedger(ledger);
        this._fragments = Array.isArray(fragments) ? fragments.filter(cell => cell?.id) : [];
        // The songbook's OCCASIONS (kind → { piece } or { day, night }), so a
        // whole-tune occasion keeps its own cells out of the next hour.
        this._occasionBook = occasions && typeof occasions === 'object' ? occasions : {};
        this._pending = new Map(); // earned occasion → { eligibleAt, expiresAt }
        this._spans = []; // { startMs, endMs } of started music
        this._current = null; // { ...start, startMs, endMs, stopping }
        this._starts = []; // the last 24 starts, for the snapshot
        this._cellPlayedAt = new Map(); // fragment id → last start (ms)
        this._piecePlayedAt = new Map(); // piece played whole → last start (ms)
        this._lastSource = null; // the song the last music came from
        this._motifStarts = [];
        this._lastEndMs = null;
        this._gapDraw = this._rng();
        this._lastUrgentAt = -Infinity;
        this._retryAt = -Infinity;
        this._blocked = null;
        this._band = D1_DUTY.light;
        this._lastInput = null;
        this._ledgerDirty = false;
    }

    /** The persistable record (a copy). */
    get ledger() {
        return { ...this._ledger, occasions: [...this._ledger.occasions] };
    }

    // ── events ──

    /** A director start (enable, rebuild): the first-ever occasion or today's welcome. */
    noteEnable(now) {
        this._lastEndMs = now;
        if (!this._ledger.firstOccasion) this._queue('first', now);
        else if (this._ledger.welcomeDay !== calendarDayKey(now)) this._queue('welcome', now);
    }

    noteUrgent(now) {
        this._lastUrgentAt = now;
    }

    /** The gold peal of a verified release. */
    noteRelease(now) {
        this._queue('release', now);
    }

    /** The operator came back after `awayMs` (the resume and the digest both say so). */
    noteReturn(now, awayMs) {
        if (!(Number(awayMs) >= EARNED_RULES.return.minAwayMs) || this._pending.has('return')) return;
        const recent = this._starts.some(entry => entry.occasion === 'return'
            && now - entry.at < EARNED_RULES.return.expiresMs);
        if (!recent) this._queue('return', now);
    }

    _queue(name, now) {
        const rule = EARNED_RULES[name];
        this._pending.set(name, { eligibleAt: now + rule.afterMs, expiresAt: now + rule.afterMs + rule.expiresMs });
    }

    // ── the decision ──

    /**
     * What the Village music should do now.
     * @param {number} now ms
     * @param {object} input `{ phase, phaseProgress, minuteOfDay, keyframe,
     *   working, resting, raining, quiet, oldestWaitMs, playing }`; `playing`
     *   is the sequencer's own word that a rendition is committed or sounding
     * @returns {null | { action: 'start', kind: 'occasion'|'fragment',
     *   occasion: string|null, cellRef: string|null, reason: string }
     *   | { action: 'stop', reason: string }}
     */
    decide(now, input = {}) {
        this._band = dutyBandFor(input);
        this._lastInput = input;
        for (const [name, entry] of this._pending) {
            if (now > entry.expiresAt) this._pending.delete(name);
        }
        const current = this._current;
        const playing = input.playing ?? Boolean(current && now < current.endMs);
        if (current && !playing) this.ended(now);

        const zero = hardZero(input, now, this._lastUrgentAt);
        this._blocked = zero;
        if (playing) {
            if (!this._current || this._current.stopping) return null;
            // An urgent cue during the music releases it, as does any hard
            // zero that became true while it played.
            const urgentDuring = this._lastUrgentAt >= this._current.startMs;
            const reason = zero ?? (urgentDuring ? 'urgent' : null);
            if (!reason) return null;
            this._current.stopping = true;
            // Released before its first note: nothing was heard.
            if (now < this._current.startMs) this._current.unheard = true;
            return { action: 'stop', reason };
        }
        if (zero || now < this._retryAt) return null;

        for (const name of EARNED_ORDER) {
            const entry = this._pending.get(name);
            if (entry && now >= entry.eligibleAt) return this._start('occasion', name, `occasion:${name}`);
        }
        this._rollDay(now);
        for (const name of PHASE_OCCASIONS) {
            if (this._ledger.occasions.includes(name)) continue;
            if (occasionOpen(name, input)) return this._start('occasion', name, `occasion:${name}`);
        }
        if (now < this.nextFragmentAt(now)) return null;
        if (this.dutyLastHour(now) + FRAGMENT_ESTIMATE_SEC / 3600 > this._band.maxDuty) return null;
        const night = input.phase === 'night';
        return {
            ...this._start('fragment', null, `fragment:${this._band.name}`),
            cellRef: this._pickCell(now, night),
        };
    }

    _start(kind, occasion, reason) {
        return { action: 'start', kind, occasion, cellRef: null, reason };
    }

    _rollDay(now) {
        const day = islandDayKey(now);
        if (this._ledger.islandDay === day) return;
        this._ledger.islandDay = day;
        this._ledger.occasions = [];
    }

    // A seeded cell of the right family, and none that states the motif once
    // the hour's motif budget is spent. Then, each rule kept while any cell
    // still passes it: no cell heard in the last hour, no song that played
    // whole as an occasion this hour, never the song that just played; the
    // least recently played goes first, a seeded draw among equals.
    _pickCell(now, night) {
        if (!this._fragments.length) return null;
        this._motifStarts = this._motifStarts.filter(at => now - at < HOUR_MS);
        const motifSpent = this._motifStarts.length >= MOTIF_FRAGMENTS_PER_HOUR;
        const family = this._fragments.filter(cell => Boolean(cell.night) === night);
        let choices = (family.length ? family : this._fragments).filter(cell => !(motifSpent && cell.motif));
        if (!choices.length) return null;
        const playedAt = cell => this._cellPlayedAt.get(cell.id) ?? -Infinity;
        const narrow = (keep) => {
            const kept = choices.filter(keep);
            if (kept.length) choices = kept;
        };
        narrow(cell => now - playedAt(cell) >= FRAGMENT_REHEAR_MS);
        narrow(cell => now - (this._piecePlayedAt.get(cell.source) ?? -Infinity) >= FRAGMENT_REHEAR_MS);
        narrow(cell => !cell.source || cell.source !== this._lastSource);
        const oldest = Math.min(...choices.map(playedAt));
        const ties = choices.filter(cell => playedAt(cell) === oldest);
        return ties[Math.min(ties.length - 1, Math.floor(this._rng() * ties.length))].id;
    }

    // ── reports ──

    /**
     * The sequencer accepted `decision`; it sounds over [startsAtMs, endsAtMs].
     */
    started(now, decision, { startsAtMs = now, endsAtMs = now } = {}) {
        if (!decision || decision.action !== 'start') return;
        const startMs = Number.isFinite(startsAtMs) ? startsAtMs : now;
        const endMs = Math.max(startMs, Number.isFinite(endsAtMs) ? endsAtMs : startMs);
        const { kind, occasion, cellRef, reason } = decision;
        // What this start spends, so a release before its first note can
        // give it back (deferred, not dropped).
        const undo = {
            ledger: this.ledger,
            pending: new Map(this._pending),
            cellPlayedAt: new Map(this._cellPlayedAt),
            piecePlayedAt: new Map(this._piecePlayedAt),
            motifStarts: [...this._motifStarts],
            lastSource: this._lastSource,
            lastEndMs: this._lastEndMs,
        };
        this._current = { kind, occasion, cellRef, reason, startMs, endMs, stopping: false, unheard: false, undo };
        if (kind === 'occasion') this._ledgerDirty = true;
        this._spans.push({ startMs, endMs: endMs + RING_OUT_SEC * 1000 });
        this._starts.push({ at: startMs, kind, occasion, cellRef, reason });
        if (this._starts.length > 24) this._starts.shift();
        if (occasion && this._pending.has(occasion)) this._pending.delete(occasion);
        const today = calendarDayKey(now);
        if (occasion === 'first') {
            this._ledger.firstOccasion = true;
            this._ledger.welcomeDay = today;
            this._pending.delete('welcome');
            // It plays the phase's own tune, so the phase occasion open now
            // is spent with it rather than repeated right after.
            this._rollDay(now);
            for (const name of PHASE_OCCASIONS) {
                if (occasionOpen(name, this._lastInput ?? {}) && !this._ledger.occasions.includes(name)) {
                    this._ledger.occasions.push(name);
                }
            }
        } else if (occasion === 'welcome') {
            this._ledger.welcomeDay = today;
        } else if (PHASE_OCCASIONS.includes(occasion)) {
            this._rollDay(now);
            if (!this._ledger.occasions.includes(occasion)) this._ledger.occasions.push(occasion);
        }
        const cell = cellRef ? this._fragments.find(entry => entry.id === cellRef) : null;
        if (cell?.motif || occasion === 'welcome') this._motifStarts.push(startMs);
        const spec = kind === 'occasion' ? this._occasionSpec(occasion) : null;
        const played = cellRef ?? spec?.fragment ?? null;
        if (played) this._cellPlayedAt.set(played, startMs);
        if (spec?.piece) this._piecePlayedAt.set(spec.piece, startMs);
        this._lastSource = cell?.source ?? spec?.piece
            ?? this._fragments.find(entry => entry.id === spec?.fragment)?.source ?? null;
    }

    // What an occasion plays (`{ piece }` whole, or a `{ fragment }`), as the
    // sequencer resolves it: day or night by the phase, 'first' as the
    // phase's own occasion unless the songbook names one.
    _occasionSpec(occasion) {
        const input = this._lastInput ?? {};
        const phaseKind = { dawn: 'dawn', day: 'noon', dusk: 'dusk', night: 'night' }[input.phase] ?? 'noon';
        const entry = this._occasionBook[occasion] ?? (occasion === 'first' ? this._occasionBook[phaseKind] : null);
        if (!entry) return null;
        if (!entry.day && !entry.night) return entry;
        return (input.phase === 'night' ? entry.night : entry.day) ?? entry.day ?? entry.night ?? null;
    }

    // A start released before its first note is given back: its occasion is
    // due again, the ledger and the cell history are as they were, and it
    // counts toward no duty.
    _restore(current) {
        const { undo } = current;
        this._ledger = normalLedger(undo.ledger);
        this._pending = undo.pending;
        this._cellPlayedAt = undo.cellPlayedAt;
        this._piecePlayedAt = undo.piecePlayedAt;
        this._motifStarts = undo.motifStarts;
        this._lastSource = undo.lastSource;
        this._lastEndMs = undo.lastEndMs;
        const span = this._spans[this._spans.length - 1];
        if (span && span.startMs === current.startMs) this._spans.pop();
        const start = this._starts[this._starts.length - 1];
        if (start && start.at === current.startMs) this._starts.pop();
        this._current = null;
        if (current.kind === 'occasion') this._ledgerDirty = true;
    }

    /** True once after the persistable ledger changed (the caller writes it). */
    takeLedgerChange() {
        const dirty = this._ledgerDirty;
        this._ledgerDirty = false;
        return dirty;
    }

    /** The sequencer refused (busy, stopped): ask again a little later. */
    refused(now) {
        this._retryAt = now + RETRY_MS;
    }

    /** The music ended (or was released) at `now`. */
    ended(now) {
        const current = this._current;
        if (!current) return;
        if (current.unheard) {
            this._restore(current);
            return;
        }
        const endMs = Math.max(current.startMs, Math.min(current.endMs, now));
        // A rendition that ran its course rings out; a released one ends
        // with its fade, which the caller's `now` already includes.
        const heardEndMs = now >= current.endMs ? current.endMs + RING_OUT_SEC * 1000 : endMs;
        const span = this._spans[this._spans.length - 1];
        if (span && span.startMs === current.startMs) span.endMs = heardEndMs;
        this._current = null;
        this._lastEndMs = endMs;
        this._gapDraw = this._rng();
    }

    // ── reading ──

    /** When the next fragment may start (ms), duty cap aside. */
    nextFragmentAt(now) {
        const from = this._lastEndMs ?? now;
        if (this._lastEndMs === null) this._lastEndMs = now;
        return from + lerp(this._band.gapSec, this._gapDraw) * 1000;
    }

    /** Share (0..1) of the rolling hour before `now` that music was playing. */
    dutyLastHour(now) {
        const from = now - DUTY_WINDOW_MS;
        this._spans = this._spans.filter(span => span.endMs > from || span === this._spans[this._spans.length - 1]);
        let ms = 0;
        for (const span of this._spans) {
            const end = Math.min(span.endMs, now);
            const start = Math.max(span.startMs, from);
            if (end > start) ms += end - start;
        }
        return ms / DUTY_WINDOW_MS;
    }

    snapshot(now) {
        const current = this._current;
        return {
            band: this._band.name,
            dutyLastHour: this.dutyLastHour(now),
            nextFragmentAt: current ? null : this.nextFragmentAt(now),
            pending: [...this._pending.keys()],
            playing: current ? { ...current } : null,
            last: this._starts.length ? { ...this._starts[this._starts.length - 1] } : null,
            starts: this._starts.map(entry => ({ ...entry })),
            blocked: this._blocked,
            ledger: this.ledger,
        };
    }
}
