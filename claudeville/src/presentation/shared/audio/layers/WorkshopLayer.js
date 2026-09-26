// The workshops (plan 5.1–5.5, 5.7, 5.8; FOL-1…FOL-8, SIG-4/11/12/13):
// the village's work, heard at the buildings that draw it. Every non-stale
// working agent is heard at its tool's building as baked material strikes
// (WorkshopVoices.js takes) on that building's gesture grid (k·P_b on the
// Date.now clock, the RitualConductor's). Density, never one sound per call
// (D8): WorkshopModel.js turns tool-start density into an accent rate and
// this layer places what the rate asks for.
//
//   - Accents carry the agent: its slot pitch (two smiths, two anvils) on
//     its own third of the grid. In World an accent waits (one stride at
//     most) for a drawn ritual downbeat at its building — read through the
//     director's `downbeatSource` at scheduling time, never per frame — and
//     strikes on the cream frame; otherwise it strikes on its own grid tick
//     (Dashboard: the de-clumped grid). Accent existence never depends on
//     the drawing (C-FOL-5).
//   - Ghosts carry continuing work: one pitch per building, on the present
//     agents' thirds, under the liveness floor L_b (S7).
//   - The budget arbiter (FOL-4): ≤ 0.8 strikes/s per building (bucket,
//     burst 1.6), ≥ 200 ms between a building's onsets, ≤ 3 strikes in any
//     1 s island-wide (ghosts only while fewer than 2 are in it).
//   - Honesty (S6, FOL-7): the model hands over only non-stale working
//     agents; when an agent or a whole building leaves, its booked strikes
//     (≤ 0.35 s ahead) are stopped before they sound, and its owed accents
//     are forgotten. Nothing plays with `working === 0`.
//
// Level (5.3, C-FOL-3): every strike is placed under a peak ceiling at the
// layer output (the take's measured true peak × the strike gain × the air's
// early reflections): accents at it (the bright voices 2–4.5 dB under by
// day), ghosts 16 dB under, each 6 dB lower when it starts inside another
// strike's loud window from any building (the overlap guard; an accent
// waits a stride rather than lose it). The
// Workshops fader (default −2.4 dB) and the ducks come after.
//
// One persistent chain per building (S8, 5.8): input (placement gain) →
// low-pass (distance; 3.2 kHz at night, 5.5) → the held note's slot →
// StereoPanner → layer out, with an Island Air send (placement air × 0.7)
// taken after the pan inside the layer level (C-AMB-2). Takes are mono, so
// the equal-power StereoPanner places them exactly (the balance gains of the
// sea's lanes exist to keep stereo noise decorrelated). A strike is a
// buffer source + a gain into its chain: 2 node creations. The selected
// agent's accents (5.4) go +4 dB into one focus chain that mirrors its
// building's placement at half the send (drier). The Mine carries the quota
// rumble (5.7): one persistent brown pool lane through an 80–160 Hz band
// into the Mine's chain, silent at level 0.
//
// The Transport places every strike (S4, work horizon 0.35 s). Each booked
// strike is published as `audio:work-scheduled` for the probe; continuous
// textures never caption (C-FOL-7).

import { eventBus } from '../../../../domain/events/DomainEvent.js';
import { BaseLayer } from './BaseLayer.js';
import { holdAt } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { heldSlot } from './HeldNote.js';
import { rngStream } from '../Rng.js';
import { place } from '../SpatialField.js';
import { WORK_HORIZON_SEC } from '../Transport.js';
import { BUILDING_IDS, accentPlan, ghostPlan } from '../WorkshopModel.js';
import { WORKSHOP_VOICES, bakeWorkshopTakes, takeInfo, workshopBankStats } from '../WorkshopVoices.js';

// ------------------------------------------------------------------ budget

// FOL-4 / S7 work budgets.
export const WORK_BUDGET = Object.freeze({
    perBuildingPerSec: 0.8,
    perBuildingBurst: 1.6,
    // Accents and flams may overdraw the bucket this far; a ghost needs this
    // much headroom unless it holds the liveness slot.
    overdraw: 0.6,
    minIoiSec: 0.2,
    globalWindowSec: 1,
    globalMax: 3,
    // Ghosts only while fewer than this many strikes are in the window.
    globalGhostMax: 2,
});

// Co-located accents within this of each other at a pitched building flam
// at their own slot pitches (FOL-4 step 4); elsewhere they merge.
export const FLAM = Object.freeze({ withinSec: 0.02, stepSec: 0.028, gain: 0.6, max: 3, cost: 0.5 });
const FLAM_BUILDINGS = new Set(['forge', 'archive']);
// In World an accent waits this many of its own strides for a drawn
// downbeat before it strikes on its own grid tick (still on its third).
export const ACCENT_WAIT_STRIDES = 2;
// An accent the budget refused tries again a stride later, this many times.
export const ACCENT_RETRIES = 2;

// ------------------------------------------------------------------- level

// The per-strike peak ceiling at the layer output, bus domain (before the
// Workshops fader, PROGRAM_TRIM and the volume). Set in context (probe
// `worklevel`, the FOL reference scenes over the Wave-4 environment): the
// onset-weighted 2–5 kHz share of the program is the binding limit (≤ 1.5 %);
// the stratum then sits ≈ 16 LU under the program with every building's
// accents still rising ≥ 6 dB in their lane.
export const STRIKE_CEILING_DB = -40;
// Ghosts ring well under the accents they carry the time between: they are
// most of the stratum's onsets, so they set its 2–5 kHz share and fill the
// window an accent must rise out of. Their own ceiling sits this far below.
export const GHOST_CEILING_DB = -16;
// The overlap guard: a strike starting inside another's loud window.
export const OVERLAP_GUARD_DB = -6;
// The air's first early reflections add near-coherently on ringing strikes
// (FOL v3 round 2: taps 0.50/0.43/0.36 → ×1.29 of the send).
const EARLY_REFLECTION_SUM = 1.29;
// Every strike is set relative to its ceiling (FOL v3: most strikes sat at
// it), so the ceiling is the level: one accent level island-wide, focus
// exactly FOCUS_DB over it, and the peak bound by construction. Accents ring
// at the ceiling (the Mine's token picks carry their velocity, 0.55–1);
// ghosts carry a velocity (0.8–1), their voice's own gain (a quill or a rope
// under a page or a crate) and ≤ 2 dB of jitter. Round-robin takes and rate
// jitter keep repeats apart.
const MINE_VEL = Object.freeze([0.55, 1]);
const GHOST_VEL = Object.freeze([0.8, 1]);
const GAIN_JITTER_DB = 2;
// Voices whose identity sits in 2–5 kHz — the Forge's slots (A6–F♯7), the
// telescope detents (2.2–2.6 kHz), the rune's glass ticks (3.2–4.4 kHz), the
// chalk stroke and tack tick, the pick's click and pebbles, the flag's
// crack — rise 14–18 dB in their lanes by day, far past
// need, and would carry most of the stratum's presence-band energy at its
// onsets (S7 spectral budget); by day they sit this far under the ceiling
// (at night the shutters' 3.2 kHz low-pass takes that band instead).
export const ACCENT_TRIM_DB = Object.freeze({ forge: -3, observatory: -3, portal: -4.5, taskboard: -2, mine: -4, command: -3.5 });
// Playback-rate jitter (pitched voices keep their slot).
const PITCHED_RATE_JITTER = 0.003;
const UNPITCHED_RATE_JITTER = 0.05;
const PITCHED_BUILDINGS = new Set(['forge']);
// A take's loud window when its info does not say (s).
const DEFAULT_LOUD_SEC = 0.15;

// 5.5: the shutters (3.2 kHz) take the upper half of the parchment page's
// broadband swell, where it rose over the night environment, so its accents
// get that energy back and the Archive is heard at night as by day (FOL-8
// round 2: the page was the next night re-voice candidate).
export const NIGHT_ACCENT_DB = Object.freeze({ archive: 3 });

// 5.4 (SIG-12): the selected agent's accents, +4 dB and half the send.
export const FOCUS_DB = 4;
const FOCUS_SEND = 0.5;

// Air send (S5, FOL v3): 0.7 × the placement's send; the Harbor crate needs
// its dry attack (×0.6 of that).
export const AIR_SCALE = 0.7;
const SEND_TRIM = Object.freeze({ harbor: 0.6 });

// 5.5: work behind shutters at night, level unchanged.
export const NIGHT_LOWPASS_HZ = 3200;
const OPEN_LOWPASS_HZ = 18000;
// 5.8: placement glides (τ) and the default.
export const PLACEMENT_TAU_SEC = 0.25;

// 5.7: the Mine's quota rumble at level 1 (linear, on the brown pool lane).
const RUMBLE_GAIN = 0.5;
const RUMBLE_TAU_SEC = 2;
// Stale or unknown usage silences the rumble at once (≥ 60 dB down in 2 s).
const RUMBLE_SILENCE_TAU_SEC = 0.25;

// Diagnostics caps.
const STRIKE_LOG = 2000;
const PLACEMENT_LOG = 600;
const COST_WINDOW = 240;

const dbToGain = db => Math.pow(10, db / 20);
const gainToDb = gain => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function monotonicMs() {
    return globalThis.performance?.now?.() ?? Date.now();
}

// ------------------------------------------------------------ pure helpers

/** A fresh budget arbiter (FOL-4). */
export function createArbiter() {
    return { buckets: new Map(), lastOnset: new Map(), recent: [] };
}

/**
 * Admit one strike `{ t (audio s), building, kind: 'accent'|'ghost',
 * priority?, flam?, yieldSlot? }` against the budgets, in time order. Commits and
 * returns null when admitted, else the reason: 'ioi' | 'building' | 'global'.
 */
export function admitStrike(arbiter, strike, budget = WORK_BUDGET) {
    const { t, building, kind } = strike;
    const flam = Boolean(strike.flam);
    const ghost = kind === 'ghost';
    const last = arbiter.lastOnset.get(building);
    if (!flam && last != null && t - last < budget.minIoiSec) return 'ioi';
    let bucket = arbiter.buckets.get(building);
    if (!bucket) {
        bucket = { tokens: budget.perBuildingBurst, last: t };
        arbiter.buckets.set(building, bucket);
    }
    const tokens = Math.min(budget.perBuildingBurst, bucket.tokens + Math.max(0, t - bucket.last) * budget.perBuildingPerSec);
    const cost = flam ? FLAM.cost : 1;
    // The liveness floor's strike skips the building bucket (FOL-4 step 3):
    // only the global window may refuse it.
    const need = strike.priority ? -Infinity : ghost ? cost + budget.overdraw : cost - budget.overdraw;
    if (tokens < need) return 'building';
    const from = t - budget.globalWindowSec;
    const recent = arbiter.recent.filter(at => at > from);
    // A strike yields one place in the window to another building whose
    // liveness floor the window has refused (`yieldSlot`).
    const limit = (ghost && !strike.priority ? budget.globalGhostMax : budget.globalMax) - (strike.yieldSlot ? 1 : 0);
    if (recent.length >= limit) return 'global';
    bucket.tokens = Math.max(-budget.overdraw, tokens - cost);
    bucket.last = Math.max(bucket.last, t);
    recent.push(t);
    arbiter.recent = recent;
    if (!flam) arbiter.lastOnset.set(building, Math.max(last ?? -Infinity, t));
    return null;
}

/**
 * The overlap guard (5.3): `guard.loudUntil` is when the loudest strike so
 * far leaves its loud window. Returns whether a strike at `t` starts inside
 * it, then extends the window by this strike's own.
 */
export function overlapGuard(guard, t, loudSec) {
    const guarded = t < guard.loudUntil;
    guard.loudUntil = Math.max(guard.loudUntil, t + Math.max(0, Number(loudSec) || 0));
    return guarded;
}

/**
 * The strike's gain: `level` (0..1, its place under the ceiling) times the
 * gain that puts the take's peak (`truePeak` at unit gain) through `airSend`
 * (its early reflections) exactly at the ceiling, 6 dB lower when guarded;
 * focus lifts the result by FOCUS_DB (5.4). A strike never passes its
 * ceiling unless focused.
 */
export function strikeGain({ level = 1, truePeak = 1, airSend = 0, guarded = false, focused = false, ceilingDb = STRIKE_CEILING_DB }) {
    const eff = Math.max(1e-6, truePeak) * (1 + Math.max(0, airSend) * EARLY_REFLECTION_SUM);
    const cap = dbToGain(ceilingDb + (guarded ? OVERLAP_GUARD_DB : 0)) / eff;
    return cap * Math.max(0, Math.min(1, level)) * (focused ? dbToGain(FOCUS_DB) : 1);
}

/**
 * Place a window's accents in World (FOL-5). `owed` are accents the rate
 * asked for and that have not struck (each `{ at, dueMs, agentId,
 * pitchIndex, slot, verify }`, due on the agent's own third one stride
 * after it was planned). Each drawn downbeat in [fromMs, toMs) takes one
 * owed accent — the downbeat's own agent's first, else the oldest — and
 * strikes on the cream frame, sounding the drawn agent's pitch when it is
 * present. Owed accents falling due in the window strike on their grid
 * tick; any already past are dropped. Mutates `owed`; returns the accents
 * `[{ at, agentId, pitchIndex, slot, verify, downbeatMs }]` in time order.
 */
export function placeAccents({ owed, beats = [], fromMs, toMs, slots = [] }) {
    const out = [];
    const bySlot = new Map(slots.map(slot => [String(slot.agentId), slot]));
    const inWindow = beats
        .filter(beat => Number.isFinite(beat?.atMs) && beat.atMs >= fromMs && beat.atMs < toMs)
        .sort((a, b) => a.atMs - b.atMs);
    for (const beat of inWindow) {
        if (!owed.length) break;
        const key = beat.agentId == null ? null : String(beat.agentId);
        let index = key == null ? -1 : owed.findIndex(item => String(item.agentId) === key);
        if (index < 0) index = 0;
        const [item] = owed.splice(index, 1);
        const drawn = key != null ? bySlot.get(key) : null;
        out.push({
            at: beat.atMs,
            agentId: drawn ? drawn.agentId : item.agentId,
            pitchIndex: drawn ? drawn.pitchIndex : item.pitchIndex,
            slot: drawn ? drawn.slot : item.slot,
            verify: drawn ? drawn.verify : item.verify,
            downbeatMs: beat.atMs,
        });
    }
    for (let i = owed.length - 1; i >= 0; i--) {
        const item = owed[i];
        if (item.dueMs >= toMs) continue;
        owed.splice(i, 1);
        if (item.dueMs >= fromMs) {
            out.push({ at: item.dueMs, agentId: item.agentId, pitchIndex: item.pitchIndex, slot: item.slot, verify: item.verify, downbeatMs: null });
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

/**
 * Coincident accents at one building (FOL-4 step 4): the drawn smiths of
 * one poll share a downbeat. At a pitched building each extra one flams
 * 28 ms later at its own pitch (×0.6, at most 3 in a cluster); elsewhere
 * they merge into the first. `accents` in time order; returns the kept ones
 * with `flam` set on the followers.
 */
export function clusterAccents(accents, building) {
    const out = [];
    let lead = null;
    for (const accent of accents) {
        if (lead && accent.at - lead.at < FLAM.withinSec * 1000) {
            if (!FLAM_BUILDINGS.has(building) || lead.n >= FLAM.max) continue;
            out.push({ ...accent, at: lead.at + FLAM.stepSec * 1000 * lead.n, flam: true });
            lead.n += 1;
            continue;
        }
        lead = { at: accent.at, n: 1 };
        out.push({ ...accent, flam: false });
    }
    return out;
}

/**
 * The liveness floor's stand-by ticks over [fromMs, toMs): every tick
 * k·gridMs of the building's gesture grid (any third: a floor strike the
 * global window refused tries again one gesture later, not a stride). → [at]
 */
export function floorTicks(gridMs, fromMs, toMs) {
    const out = [];
    if (!(gridMs > 0) || !(toMs > fromMs)) return out;
    for (let k = Math.ceil(fromMs / gridMs); k * gridMs < toMs; k++) out.push(k * gridMs);
    return out;
}

/**
 * The liveness floor (FOL-4 step 3, S7): a building silent since `lastMs`
 * for half its window `livenessMs` strikes at its next candidate, as a
 * priority strike (past the building bucket; only the global window can
 * refuse it, and then the next present-third tick tries again).
 */
export function floorDue(lastMs, at, livenessMs) {
    return at - lastMs >= livenessMs / 2;
}

// Candidate order at one instant: accents, then planned ghosts, then the
// floor's stand-by ticks.
function rank(candidate) {
    return candidate.kind === 'accent' ? 0 : candidate.floor ? 2 : 1;
}

// Pairing of the audio clock with performance.now and Date.now for one
// scheduling window (output latency included when the context says it).
function clockPair(ctx) {
    const perfNow = monotonicMs();
    const wallOffset = Date.now() - perfNow;
    let contextTime = ctx.currentTime;
    let performanceTime = perfNow;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp
        && Number.isFinite(stamp.contextTime) && stamp.contextTime > 0
        && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0) {
        contextTime = stamp.contextTime;
        performanceTime = stamp.performanceTime;
    }
    return {
        audioAt: wallMs => contextTime + (wallMs - wallOffset - performanceTime) / 1000,
        monoAt: audioT => performanceTime + (audioT - contextTime) * 1000,
        wallOffset,
    };
}

const sameNumber = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-4);

// ------------------------------------------------------------------- layer

export class WorkshopLayer extends BaseLayer {
    constructor(engine, { downbeatSource = null, ...options } = {}) {
        super(engine, { trim: 1, group: 'workshops', rng: 'work.workshops', ...options });
        this._downbeatSource = typeof downbeatSource === 'function' ? downbeatSource : null;
        this._state = null;
        this._night = false;
        this._phase = 'day';
        this._ghosts = true;
        this._focusId = null;
        this._quota = { level: 0, band: [80, 160] };
        this._placement = Object.fromEntries(BUILDING_IDS.map((id) => {
            const p = place({ building: id });
            return [id, { pan: p.pan, lowpassHz: p.lowpassHz, gain: p.gain, air: p.air }];
        }));
        this._jitter = rngStream('work.workshops.jitter');
        this._resetState();
    }

    _resetState() {
        this._chains = new Map();
        this._focusChain = null;
        this._rumble = null;
        this._arbiter = createArbiter();
        this._guard = { loudUntil: -Infinity };
        this._owed = new Map(BUILDING_IDS.map(id => [id, []]));
        this._lastStrikeMs = new Map();
        // Buildings whose liveness strike the global window refused.
        this._starved = new Set();
        this._round = new Map();
        this._pending = [];
        this._strikes = [];
        this._placementLog = [];
        this._wallCursor = null;
        this._nodeCreations = 0;
        this._overlapGuardHits = 0;
        this._cancelled = 0;
        this._placementWrites = 0;
        this._dropped = { ioi: 0, building: 0, global: 0, late: 0, missing: 0, merged: 0, accentsLost: 0, deferred: 0 };
        this._cost = new Float64Array(COST_WINDOW);
        this._costHead = 0;
        this._costCount = 0;
        this._costMax = 0;
    }

    _start(ctx) {
        for (const id of BUILDING_IDS) this._chains.set(id, this._buildChain(ctx, id, 1));
        this._focusChain = this._buildChain(ctx, null, FOCUS_SEND);
        this._focusChain.building = null;
        this._buildRumble(ctx);
        this._bake();
        this.registerProcess({
            name: 'work.strikes',
            horizon: WORK_HORIZON_SEC,
            schedule: (from, to) => this._schedule(from, to),
            rearm: () => { this._wallCursor = null; },
        });
    }

    // input (placement gain) → low-pass → held slot → pan → out; air send
    // after the pan at the placement's send × 0.7 × `sendScale`.
    _buildChain(ctx, building, sendScale) {
        const p = building ? this._placement[building] : { pan: 0, lowpassHz: null, gain: 1, air: 0 };
        const input = ctx.createGain();
        input.gain.value = p.gain;
        const lowpass = makeFilter(ctx, 'lowpass', this._lowpassFor(p.lowpassHz), { q: 'butterworth' });
        const slot = heldSlot(ctx);
        const pan = ctx.createStereoPanner();
        pan.pan.value = p.pan;
        input.connect(lowpass).connect(slot).connect(pan).connect(this.out);
        this.track(input, lowpass, slot, pan);
        const send = this.airSend(this._sendFor(building, p.air) * sendScale, pan);
        return { building, input, lowpass, pan, send, sendScale };
    }

    _buildRumble(ctx) {
        const mine = this._chains.get('mine');
        const src = this.engine.noiseSource('brown', { rng: rngStream('work.workshops.rumble') });
        if (!src || !mine) return;
        const [lo, hi] = this._quota.band;
        const centre = Math.sqrt(lo * hi);
        const band = makeFilter(ctx, 'bandpass', centre, { q: centre / (hi - lo) });
        const gain = ctx.createGain();
        gain.gain.value = this._quota.level * RUMBLE_GAIN;
        src.connect(band).connect(gain).connect(mine.input);
        src.start(ctx.currentTime);
        this.trackSource(src);
        this.track(band, gain);
        this._rumble = { band, gain };
    }

    _bake() {
        const bank = this.engine.bank;
        if (!bank) return;
        try { bakeWorkshopTakes(bank, { night: this._night }); } catch (error) {
            console.error('[audio] workshop bake failed', error);
        }
    }

    stop() {
        const silentAt = super.stop();
        if (silentAt !== undefined) {
            for (const entry of this._pending) {
                try { entry.src.stop(silentAt + 0.01); } catch { /* already stopped */ }
            }
        }
        const keep = { strikes: this._strikes, placementLog: this._placementLog };
        this._resetState();
        this._strikes = keep.strikes;
        this._placementLog = keep.placementLog;
        return silentAt;
    }

    // ------------------------------------------------------------- inputs

    setDownbeatSource(fn) {
        this._downbeatSource = typeof fn === 'function' ? fn : null;
    }

    // The model's state (WorkshopModel.buildWorkshopState). Agents and
    // buildings that left lose their booked strikes and owed accents.
    setState(state) {
        this._state = state && state.buildings ? state : null;
        const present = new Map();
        for (const id of BUILDING_IDS) {
            const b = this._state?.buildings?.[id];
            present.set(id, b && b.working > 0 ? new Set(b.slots.map(slot => String(slot.agentId))) : null);
        }
        for (const id of BUILDING_IDS) {
            const agents = present.get(id);
            if (!agents) this._starved.delete(id);
            const owed = this._owed.get(id);
            for (let i = owed.length - 1; i >= 0; i--) {
                if (!agents || !agents.has(String(owed[i].agentId))) owed.splice(i, 1);
            }
        }
        this._cancelWhere((entry) => {
            const agents = present.get(entry.building);
            if (!agents) return true;
            return entry.agentId != null && !agents.has(String(entry.agentId));
        });
    }

    setPhase(phase) {
        this._phase = typeof phase === 'string' ? phase : 'day';
        this.setNight(this._phase === 'night');
    }

    setNight(night) {
        const value = Boolean(night);
        if (value === this._night) return;
        this._night = value;
        if (!this.running) return;
        this._bake();
        for (const id of BUILDING_IDS) this._applyLowpass(id, 2);
    }

    setFocus(agentId) {
        this._focusId = agentId == null ? null : String(agentId);
    }

    // D3 quiet mix: false = accents only.
    setGhosts(on) {
        this._ghosts = on !== false;
    }

    // 5.8: one building's placement from the camera (SpatialField). Writes
    // only what changed; a still camera writes nothing.
    setPlacement(buildingId, { pan, lowpassHz = null, gain = 1, air = 0 } = {}, tc = PLACEMENT_TAU_SEC) {
        const current = this._placement[buildingId];
        if (!current) return;
        const next = {
            pan: Math.max(-1, Math.min(1, Number(pan) || 0)),
            lowpassHz: lowpassHz == null ? null : Number(lowpassHz),
            gain: Math.max(0, Number(gain) || 0),
            air: Math.max(0, Number(air) || 0),
        };
        const changed = {
            pan: !sameNumber(current.pan, next.pan),
            lowpassHz: !sameNumber(current.lowpassHz, next.lowpassHz),
            gain: !sameNumber(current.gain, next.gain),
            air: !sameNumber(current.air, next.air),
        };
        if (!changed.pan && !changed.lowpassHz && !changed.gain && !changed.air) return;
        this._placement[buildingId] = next;
        const chain = this._chains.get(buildingId);
        if (!chain || !this.engine.context) return;
        const now = this.engine.now();
        const tau = Math.max(0.01, Number(tc) || PLACEMENT_TAU_SEC);
        const targets = [chain];
        if (this._focusChain?.building === buildingId) targets.push(this._focusChain);
        let writes = 0;
        for (const target of targets) {
            if (changed.pan) { target.pan.pan.setTargetAtTime(next.pan, now, tau); writes++; }
            if (changed.lowpassHz) { target.lowpass.frequency.setTargetAtTime(this._lowpassFor(next.lowpassHz), now, tau); writes++; }
            if (changed.gain) { target.input.gain.setTargetAtTime(next.gain, now, tau); writes++; }
            if (changed.air && target.send) { target.send.gain.setTargetAtTime(this._sendFor(buildingId, next.air) * target.sendScale, now, tau); writes++; }
        }
        this._placementWrites += writes;
        this._placementLog.push({ building: buildingId, at: now, ...next, tc: tau });
        if (this._placementLog.length > PLACEMENT_LOG) this._placementLog.shift();
    }

    // 5.7: the Mine's quota rumble ({ level 0..1, band [lo, hi] Hz }).
    setQuota({ level = 0, band = null } = {}) {
        const value = Math.max(0, Math.min(1, Number(level) || 0));
        this._quota = { level: value, band: Array.isArray(band) && band.length === 2 ? [...band] : this._quota.band };
        if (!this._rumble || !this.engine.context) return;
        const now = this.engine.now();
        const [lo, hi] = this._quota.band;
        const centre = Math.sqrt(lo * hi);
        this._rumble.band.frequency.setTargetAtTime(centre, now, RUMBLE_TAU_SEC);
        this._rumble.gain.gain.setTargetAtTime(value * RUMBLE_GAIN, now, value > 0 ? RUMBLE_TAU_SEC : RUMBLE_SILENCE_TAU_SEC);
    }

    // ------------------------------------------------------------ helpers

    _lowpassFor(lowpassHz) {
        const distance = lowpassHz == null ? OPEN_LOWPASS_HZ : Math.min(OPEN_LOWPASS_HZ, lowpassHz);
        return this._night ? Math.min(distance, NIGHT_LOWPASS_HZ) : distance;
    }

    _sendFor(building, air) {
        return Math.max(0, air) * AIR_SCALE * (SEND_TRIM[building] ?? 1);
    }

    _applyLowpass(building, tau) {
        const chain = this._chains.get(building);
        if (!chain) return;
        const hz = this._lowpassFor(this._placement[building].lowpassHz);
        const now = this.engine.now();
        chain.lowpass.frequency.setTargetAtTime(hz, now, tau);
        if (this._focusChain?.building === building) this._focusChain.lowpass.frequency.setTargetAtTime(hz, now, tau);
    }

    // Point the focus chain at `building` just before a strike at `t`.
    _focusOn(building, t) {
        const chain = this._focusChain;
        if (!chain || chain.building === building) return;
        chain.building = building;
        const p = this._placement[building];
        const at = Math.max(this.engine.now(), t - 0.02);
        for (const param of [chain.pan.pan, chain.lowpass.frequency, chain.input.gain, chain.send?.gain].filter(Boolean)) holdAt(param, at);
        chain.pan.pan.setValueAtTime(p.pan, at);
        chain.lowpass.frequency.setValueAtTime(this._lowpassFor(p.lowpassHz), at);
        chain.input.gain.setValueAtTime(p.gain, at);
        chain.send?.gain.setValueAtTime(this._sendFor(building, p.air) * chain.sendScale, at);
    }

    _cancelWhere(test) {
        const ctx = this.engine.context;
        if (!ctx || !this._pending.length) return;
        const now = ctx.currentTime;
        this._pending = this._pending.filter((entry) => {
            if (entry.t + 2 < now) return false;
            if (entry.t <= now + 0.003 || !test(entry)) return true;
            try { entry.src.stop(); } catch { /* already stopped */ }
            entry.row.cancelled = true;
            this._cancelled++;
            eventBus.emit('audio:work-cancelled', { building: entry.building, agentId: entry.agentId, at: entry.t });
            return false;
        });
    }

    // ---------------------------------------------------------- scheduler

    _schedule(from, to) {
        const ctx = this.engine.context;
        if (!this.running || !ctx) return 0;
        const started = monotonicMs();
        let dropped = 0;
        try {
            dropped = this._scheduleWindow(ctx, from, to);
        } finally {
            const cost = monotonicMs() - started;
            this._cost[this._costHead] = cost;
            this._costHead = (this._costHead + 1) % COST_WINDOW;
            this._costCount = Math.min(COST_WINDOW, this._costCount + 1);
            this._costMax = Math.max(this._costMax, cost);
        }
        return dropped;
    }

    _scheduleWindow(ctx, from, to) {
        const clock = clockPair(ctx);
        const wallFrom = clock.monoAt(from) + clock.wallOffset;
        const wallTo = clock.monoAt(to) + clock.wallOffset;
        // Contiguous wall windows: continue from the last one when it meets
        // this one (clock pairing jitter), else start afresh.
        const cursor = this._wallCursor;
        const fromMs = cursor != null && cursor > wallFrom - 100 && cursor < wallTo ? cursor : wallFrom;
        const toMs = wallTo;
        this._wallCursor = toMs;
        const state = this._state;
        if (!state || !(state.total > 0) || !(toMs > fromMs)) return 0;

        const candidates = [];
        for (const id of BUILDING_IDS) {
            const b = state.buildings?.[id];
            if (!b || !(b.working > 0)) continue;
            const planned = accentPlan(b, this.rng, { fromMs, toMs });
            const owed = this._owed.get(id);
            let accents;
            if (this._downbeatSource) {
                const wait = ACCENT_WAIT_STRIDES * 3 * b.ghostGridMs;
                for (const a of planned) owed.push({ ...a, dueMs: a.at + wait });
                let beats = null;
                try { beats = this._downbeatSource(id, fromMs, toMs); } catch { beats = null; }
                if (typeof beats === 'number') beats = [{ atMs: beats, agentId: null }];
                accents = placeAccents({ owed, beats: Array.isArray(beats) ? beats : [], fromMs, toMs, slots: b.slots });
            } else {
                accents = [
                    ...planned.map(a => ({ ...a, downbeatMs: null })),
                    ...placeAccents({ owed, beats: [], fromMs, toMs, slots: b.slots }),
                ].sort((x, y) => x.at - y.at);
            }
            const clustered = clusterAccents(accents, id);
            this._dropped.merged += accents.length - clustered.length;
            for (const a of clustered) candidates.push({ ...a, building: id, kind: 'accent' });
            if (this._ghosts && b.ghostP > 0) {
                const ghosts = ghostPlan(b, this.rng, {
                    fromMs, toMs,
                    lastStrikeMs: this._lastStrikeMs.get(id) ?? -Infinity,
                    accents: clustered,
                });
                const verify = b.slots.some(slot => slot.verify);
                for (const g of ghosts) candidates.push({ ...g, building: id, kind: 'ghost', verify, downbeatMs: null });
                // The floor (S7) is judged on what actually struck: a planned
                // strike may still be refused, so every grid tick stands by
                // to hold the floor.
                for (const at of floorTicks(b.ghostGridMs, fromMs, toMs)) {
                    candidates.push({ at, building: id, kind: 'ghost', floor: true, verify, downbeatMs: null, agentId: null });
                }
            }
        }
        candidates.sort((a, b) => a.at - b.at || rank(a) - rank(b));
        const now = ctx.currentTime;
        let late = 0;
        for (let c of candidates) {
            const b = state.buildings[c.building];
            if (c.kind === 'ghost') {
                const due = floorDue(this._lastStrikeMs.get(c.building) ?? -Infinity, c.at, b.livenessMs);
                if (c.floor && !due) continue;
                if (due) {
                    // The floor's strike carries an accent the budget refused
                    // earlier, so ghosts never crowd accents out; accents
                    // still waiting for a drawn downbeat keep waiting.
                    // Not into another strike's loud window: the accent would
                    // lose 6 dB there, so the floor strikes a ghost instead.
                    const owed = this._owed.get(c.building);
                    const clear = clock.audioAt(c.at) >= this._guard.loudUntil;
                    const index = clear ? owed.findIndex(item => item.retries > 0) : -1;
                    c = index >= 0
                        ? { ...owed.splice(index, 1)[0], at: c.at, building: c.building, kind: 'accent', priority: true, downbeatMs: null }
                        : { ...c, priority: true };
                }
            }
            const t = clock.audioAt(c.at);
            if (t < Math.max(from, now + 0.005)) { if (!c.floor) late++; continue; }
            const refusal = this._strike(ctx, c, t, clock);
            // A refused accent tries again on its own third a stride later.
            if (refusal && refusal !== 'missing' && c.kind === 'accent' && !c.flam) {
                const retries = (c.retries ?? 0) + 1;
                if (retries <= ACCENT_RETRIES) {
                    this._owed.get(c.building).push({
                        agentId: c.agentId, pitchIndex: c.pitchIndex, slot: c.slot, verify: c.verify,
                        at: c.at, dueMs: c.at + 3 * b.ghostGridMs, retries,
                    });
                } else {
                    this._dropped.accentsLost++;
                }
            }
        }
        this._dropped.late += late;
        return late;
    }

    _strike(ctx, c, t, clock) {
        const b = c.building;
        const accent = c.kind === 'accent';
        const n = (this._round.get(`${b}:${c.kind}`) ?? 0);
        const voiceOverride = b === 'taskboard' && c.verify ? 'chalk' : undefined;
        const opts = { kind: c.kind, pitchIndex: c.pitchIndex ?? 0, variant: n, night: this._night, voice: voiceOverride };
        const info = takeInfo(this.engine.bank, b, opts);
        if (!info?.buffer) { this._dropped.missing++; return 'missing'; }
        // An accent that would start inside another strike's loud window
        // (and lose 6 dB to the guard) waits for its next own-third tick
        // instead, while it has retries left; the floor's never waits.
        if (accent && !c.priority && !c.flam && (c.retries ?? 0) < ACCENT_RETRIES && t < this._guard.loudUntil) {
            this._dropped.deferred++;
            return 'guard';
        }
        const yieldSlot = [...this._starved].some(other => other !== b);
        const refusal = admitStrike(this._arbiter, { t, building: b, kind: c.kind, priority: Boolean(c.priority), flam: Boolean(c.flam), yieldSlot });
        if (refusal) {
            if (c.priority && refusal === 'global') this._starved.add(b);
            if (!c.floor) this._dropped[refusal]++;
            return refusal;
        }
        this._starved.delete(b);
        this._round.set(`${b}:${c.kind}`, n + 1);

        const r = this._jitter;
        const voice = info.voice;
        const velocity = (accent ? (b === 'mine' ? between(r, MINE_VEL) : 1) : between(r, GHOST_VEL)) * (c.flam ? FLAM.gain : 1);
        const jitter = accent ? 1 : dbToGain(-r() * GAIN_JITTER_DB);
        const rate = 1 + (r() - 0.5) * 2 * (PITCHED_BUILDINGS.has(b) ? PITCHED_RATE_JITTER : UNPITCHED_RATE_JITTER);
        const voiceGain = accent ? 1 : Number(WORKSHOP_VOICES?.[b]?.voices?.[voice]?.gain) || 1;
        const focused = accent && this._focusId != null && c.agentId != null && String(c.agentId) === this._focusId;
        const chain = focused ? this._focusChain : this._chains.get(b);
        if (!chain) return null;
        const loudSec = (Number(info.loudSec) || DEFAULT_LOUD_SEC) / rate;
        const guarded = overlapGuard(this._guard, t, loudSec);
        if (guarded) this._overlapGuardHits++;
        // The ceiling is taken on the building's own send even for a focused
        // strike, so focus lifts the direct path by exactly FOCUS_DB.
        const airSend = this._sendFor(b, this._placement[b].air);
        const ceilingDb = STRIKE_CEILING_DB + (accent
            ? (this._night ? NIGHT_ACCENT_DB[b] : ACCENT_TRIM_DB[b]) ?? 0
            : GHOST_CEILING_DB);
        const gain = strikeGain({
            level: Math.pow(velocity, 1.2) * voiceGain * jitter,
            truePeak: Number(info.truePeak) || Number(info.peak) || 1,
            airSend,
            guarded,
            focused,
            ceilingDb,
        });
        if (focused) this._focusOn(b, t);

        const src = ctx.createBufferSource();
        src.buffer = info.buffer;
        src.playbackRate.value = rate;
        const level = ctx.createGain();
        level.gain.value = gain;
        src.connect(level).connect(chain.input);
        this._nodeCreations += 2;
        src.addEventListener('ended', () => {
            try { src.disconnect(); level.disconnect(); } catch { /* already disconnected */ }
        }, { once: true });
        src.start(t);

        const atMs = clock.monoAt(t);
        const row = {
            building: b,
            agentId: accent ? (c.agentId ?? null) : null,
            kind: c.kind,
            variant: voice,
            at: t,
            atMs,
            wallMs: atMs + clock.wallOffset,
            downbeatMs: c.downbeatMs ?? null,
            pitchIndex: accent ? (c.pitchIndex ?? 0) : null,
            slot: accent ? (c.slot ?? null) : null,
            hz: Number.isFinite(info.tone) ? round(info.tone, 1) : null,
            rate: round(rate, 4),
            gainDb: round(gainToDb(gain), 2),
            focused,
            guarded,
            ceilingDb: round(ceilingDb + (guarded ? OVERLAP_GUARD_DB : 0), 2),
            flam: Boolean(c.flam),
            priority: Boolean(c.priority),
        };
        this._lastStrikeMs.set(b, Math.max(this._lastStrikeMs.get(b) ?? -Infinity, c.at));
        this._pending.push({ src, t, building: b, agentId: row.agentId, row });
        if (this._pending.length > 64) this._pending = this._pending.filter(entry => entry.t + 2 > ctx.currentTime);
        this._strikes.push(row);
        if (this._strikes.length > STRIKE_LOG) this._strikes.shift();
        eventBus.emit('audio:work-scheduled', { ...row });
    }

    // -------------------------------------------------------- diagnostics

    snapshot() {
        const costs = Array.from(this._cost.subarray(0, this._costCount)).sort((a, b) => a - b);
        const p95 = costs.length ? costs[Math.min(costs.length - 1, Math.ceil(costs.length * 0.95) - 1)] : 0;
        return {
            running: this.running,
            level: this.level,
            night: this._night,
            phase: this._phase,
            ghosts: this._ghosts,
            focus: this._focusId,
            dashboard: !this._downbeatSource,
            strikes: this._strikes.map(row => ({ ...row })),
            overlapGuardHits: this._overlapGuardHits,
            cancelled: this._cancelled,
            nodeCreations: this._nodeCreations,
            dropped: { ...this._dropped },
            placement: Object.fromEntries(BUILDING_IDS.map(id => [id, { ...this._placement[id] }])),
            placementWrites: this._placementWrites,
            placementLog: this._placementLog.map(row => ({ ...row })),
            quota: { level: this._quota.level, band: [...this._quota.band] },
            bank: workshopBankStats(this.engine.bank),
            scheduleMs: { p95: round(p95, 4), max: round(this._costMax, 4), windows: this._costCount },
        };
    }
}
