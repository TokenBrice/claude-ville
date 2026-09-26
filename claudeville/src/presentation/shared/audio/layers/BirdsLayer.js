// Birds by species and hour (AMB-7): a small aviary of syllable grammars —
// blackbird, robin, house sparrow, wren, collared dove and tawny owl — each
// with its own harmonic carrier (never a pure sine), FM where the real bird
// buzzes, AM where it trembles, and a vocabulary of pitch contours. The
// director says who sings and how often (`setCast`, phrases per minute per
// species, already shaped by hour, season and weather); `setLevel` is only
// how loud they are. Phrases land on three persistent perch lanes as
// frequency and gain automation, so a phrase creates no nodes (S8); each
// phrase is placed in a tree (pan, distance low-pass and gain, Island Air
// send) at its first syllable. One renewal process on the Transport draws
// from the layer's own stream (S6): birds never follow agents.

import { BaseLayer } from './BaseLayer.js';
import { rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { distanceAir, distanceGain, distanceLowpassHz } from '../SpatialField.js';
import { renewalProcess } from '../Transport.js';

// Carriers (AMB-7 step 1): harmonic amplitudes from the fundamental up. FM is
// `{ hz, depth }` (depth × the syllable's first pitch), for the buzzing
// sparrow and the reeling wren.
export const SPECIES = Object.freeze({
    blackbird: Object.freeze({ harmonics: Object.freeze([1, 0.14, 0.05, 0.02]), gain: 0.5 }),
    robin: Object.freeze({ harmonics: Object.freeze([1, 0.08, 0.02]), gain: 0.4 }),
    sparrow: Object.freeze({ harmonics: Object.freeze([1, 0.55, 0.32, 0.18, 0.1]), gain: 0.34, fm: Object.freeze({ hz: 85, depth: 0.07 }) }),
    wren: Object.freeze({ harmonics: Object.freeze([1, 0.3, 0.12]), gain: 0.26, fm: Object.freeze({ hz: 120, depth: 0.05 }) }),
    dove: Object.freeze({ harmonics: Object.freeze([1, 0.38, 0.14, 0.05]), gain: 0.22 }),
    owl: Object.freeze({ harmonics: Object.freeze([1, 0.25, 0.08]), gain: 1.1 }),
});
export const BIRD_SPECIES = Object.freeze(Object.keys(SPECIES));

// Where each species sings from, in SpatialField distance units (0.6 is the
// near knee; farther is duller, quieter and wetter). The owl keeps one tree
// on the left all night.
const PERCH = Object.freeze({
    near: 0.45,
    far: 1.5,
    doveNear: 0.7,
    doveFar: 1.1,
    owl: Object.freeze({ distance: 1.25, panMin: -0.7, panMax: -0.3 }),
    pan: 0.75,
});
// Birds sit in trees (ENG-6's 0.3 at mid distance): the distance send × this.
const AIR_SCALE = 1.5;
// Perch lanes: at most three phrases overlap.
const LANES = 3;
// A lane's gap after its last syllable before it takes another phrase.
const LANE_GUARD_SEC = 0.05;
// Envelope (AMB-7 step 3): linear attack ≤ 12 ms, 0.75 at 60 %, 0 at the end.
const ATTACK_SEC = 0.012;
const SUSTAIN_AT = 0.6;
const SUSTAIN = 0.75;
// Peak gain of a full-level syllable before the species gain (the layer's
// level and trim scale it).
const SYLLABLE_GAIN = 0.28;
// Candidate phrases are drawn at least this often (per minute) and thinned to
// the cast's rate, so a dawn after a silent night starts within seconds.
const CANDIDATES_PER_MIN = 6;
// Phrases start only above this level; below it the draws keep running.
const PHRASE_MIN_LEVEL = 0.04;
// Owl tremolo on the last hoot (AMB-7: 7 Hz AM), as gain automation.
const OWL_TREMOLO_HZ = 7;
const OWL_TREMOLO_FLOOR = 0.15;
// Fallback when the director never sets a cast: a light day chorus.
const DEFAULT_CAST = Object.freeze({ sparrow: 2, dove: 1.1, blackbird: 1, wren: 0.9 });

const choose = (rng, list) => list[Math.floor(rng() * list.length)];

/**
 * One phrase of `species` as syllables `{ at, dur, pts, amp, tremolo? }`:
 * `at` seconds from the phrase start, `pts` the pitch contour (Hz,
 * exponential between equally spaced points), `amp` 0..1 before the
 * species gain. Grammars from AMB-7 step 2. Every fundamental sits outside
 * 500–700 Hz (S1: the needs-you register), and every syllable above 2 kHz
 * that lasts over 150 ms glides (S1: no pitch-stable tone above 2 kHz).
 */
export function phraseSyllables(species, rng) {
    const out = [];
    let t = 0;
    const add = (dur, pts, amp, extra = null) => {
        out.push({ at: t, dur, pts, amp, ...extra });
    };
    if (species === 'blackbird') {
        // 3–7 fluty notes of 90–240 ms at 1.5–2.5 kHz, then a 60 % chance of
        // a quiet twittered coda of 3–6 notes at 3.4–4.8 kHz.
        const notes = 3 + Math.floor(rand(rng, 0, 5));
        for (let k = 0; k < notes; k++) {
            const f = rand(rng, 1500, 2500);
            const dur = rand(rng, 0.09, 0.24);
            const shape = choose(rng, ['rise', 'fall', 'arch', 'dip']);
            const pts = shape === 'rise' ? [f, f * 1.25]
                : shape === 'fall' ? [f * 1.2, f * 0.85]
                    : shape === 'arch' ? [f, f * 1.3, f * 0.95]
                        : [f * 1.1, f * 0.85, f * 1.05];
            add(dur, pts, rand(rng, 0.6, 1));
            t += dur + rand(rng, 0.04, 0.12);
        }
        if (rng() < 0.6) {
            const coda = 3 + Math.floor(rand(rng, 0, 4));
            for (let k = 0; k < coda; k++) {
                const f = rand(rng, 3400, 4800);
                add(0.035, [f, f * 0.8], 0.3);
                t += 0.05;
            }
        }
    } else if (species === 'robin') {
        // A cascade of 6–12 short notes alternating high and low.
        const notes = 6 + Math.floor(rand(rng, 0, 7));
        for (let k = 0; k < notes; k++) {
            const f = k % 2 === 0 ? rand(rng, 3600, 5200) : rand(rng, 2400, 3300);
            const dur = rand(rng, 0.04, 0.09);
            add(dur, [f, f * rand(rng, 0.8, 1.2)], rand(rng, 0.5, 1));
            t += dur + rand(rng, 0.03, 0.08);
        }
    } else if (species === 'sparrow') {
        // chilp-chilp: 2–5 buzzy 60 ms chirps, 180–300 ms apart.
        const notes = 2 + Math.floor(rand(rng, 0, 4));
        const f = rand(rng, 3600, 4400);
        for (let k = 0; k < notes; k++) {
            add(0.06, [f * 1.1, f * 0.72, f * 0.8], rand(rng, 0.7, 1));
            t += rand(rng, 0.18, 0.3);
        }
    } else if (species === 'wren') {
        // A reeling trill: 10–19 up-sweeps of 35 ms at 13–17 per second.
        const notes = 10 + Math.floor(rand(rng, 0, 10));
        const f = rand(rng, 3000, 3800);
        const rate = rand(rng, 13, 17);
        for (let k = 0; k < notes; k++) {
            add(0.035, [f * 0.85, f * 1.15], 0.8);
            t += 1 / rate;
        }
    } else if (species === 'dove') {
        // Collared dove, coo-COOO-coo: low enough that even the long middle
        // note's peak stays under 500 Hz.
        const f = rand(rng, 380, 440);
        add(0.22, [f * 1.02, f], 0.6);
        t += 0.32;
        add(0.55, [f * 1.06, f * 1.1, f * 0.98], 1);
        t += 0.7;
        add(0.3, [f, f * 0.95], 0.7);
    } else if (species === 'owl') {
        // Tawny owl: hoo … hu-hu-hu-hooooo, the last hoot wavering.
        const f = rand(rng, 420, 470);
        add(0.5, [f * 1.03, f], 0.9);
        t += 0.5 + rand(rng, 1.8, 3);
        for (let k = 0; k < 3; k++) {
            add(0.09, [f * 0.98, f * 0.95], 0.5);
            t += 0.16;
        }
        add(0.85, [f * 1.02, f * 0.97, f * 1.01, f * 0.94], 0.9, { tremolo: OWL_TREMOLO_HZ });
    }
    return out;
}

/** Phrases per minute per species from a cast, non-finite and negative → 0. */
export function normalizeCast(cast) {
    const rates = {};
    for (const name of BIRD_SPECIES) {
        const n = Number(cast?.[name]);
        rates[name] = Number.isFinite(n) && n > 0 ? n : 0;
    }
    return rates;
}

export class BirdsLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.55, group: 'wildlife', ...options });
        this._rates = normalizeCast(DEFAULT_CAST);
        this._total = sumRates(this._rates);
        this._lanes = [];
        this._owlPan = rand(this.rng, PERCH.owl.panMin, PERCH.owl.panMax);
    }

    // Who sings and how often: `{ blackbird, robin, sparrow, wren, dove,
    // owl }` in phrases per minute (0 = that species is silent). Takes effect
    // from the next candidate phrase.
    setCast(cast) {
        this._rates = normalizeCast(cast);
        this._total = sumRates(this._rates);
    }

    _start(ctx) {
        this._lanes = [];
        for (let i = 0; i < LANES; i++) this._lanes.push(this._buildLane(ctx));
        this.registerProcess(renewalProcess({
            name: 'birds',
            first: () => this._candidateGap(),
            gap: () => this._candidateGap(),
            emit: (at) => this._candidate(at),
        }));
    }

    // One perch: carrier (species wave) with an FM input → envelope → the
    // distance low-pass → pan → direct distance gain → the layer output; the
    // air send taps the pan, so a far bird is quieter but no drier.
    _buildLane(ctx) {
        const osc = ctx.createOscillator();
        const fm = ctx.createOscillator();
        const fmDepth = ctx.createGain();
        const env = ctx.createGain();
        const lowpass = makeFilter(ctx, 'lowpass', ctx.sampleRate / 2 - 100);
        const pan = ctx.createStereoPanner();
        const direct = ctx.createGain();
        osc.frequency.value = 2000;
        fm.frequency.value = 100;
        fmDepth.gain.value = 0;
        env.gain.value = 0;
        fm.connect(fmDepth).connect(osc.frequency);
        osc.connect(env).connect(lowpass).connect(pan).connect(direct).connect(this.out);
        const send = this.airSend(0, pan);
        const t = ctx.currentTime;
        osc.start(t);
        fm.start(t);
        this.trackSource(osc, fm);
        this.track(fmDepth, env, lowpass, pan, direct);
        return { osc, fm, fmDepth, env, lowpass, pan, direct, send, species: null, busyUntil: 0 };
    }

    _candidateGap() {
        const perMin = Math.max(this._total, CANDIDATES_PER_MIN);
        return -Math.log(1 - this.rng()) * (60 / perMin);
    }

    // A candidate becomes a phrase with probability rate/max(rate, floor)
    // (Poisson thinning), of a species drawn by its share of the cast.
    _candidate(t) {
        const total = this._total;
        const accept = this.rng() * Math.max(total, CANDIDATES_PER_MIN) < total;
        if (!accept || this.level <= PHRASE_MIN_LEVEL) return;
        this._phrase(pickSpecies(this._rates, this.rng()), t);
    }

    // A lane is free when its last phrase has ended by `t`; one that must
    // change its carrier must also be silent now (setPeriodicWave acts at
    // once). No free lane: the phrase is not sung.
    _laneFor(species, t) {
        const now = this.engine.now();
        return this._lanes.find(lane => lane.busyUntil + LANE_GUARD_SEC <= t
            && (lane.species === species || lane.busyUntil <= now)) ?? null;
    }

    _phrase(species, t) {
        const ctx = this.engine.context;
        if (!ctx || !this.out) return;
        const lane = this._laneFor(species, t);
        if (!lane) return;
        const recipe = SPECIES[species];
        if (lane.species !== species) {
            lane.osc.setPeriodicWave(this._wave(ctx, species));
            lane.species = species;
        }
        const syllables = phraseSyllables(species, this.rng);
        if (!syllables.length) return;

        let distance;
        let panValue;
        if (species === 'owl') {
            distance = PERCH.owl.distance;
            panValue = this._owlPan;
        } else {
            distance = species === 'dove'
                ? rand(this.rng, PERCH.doveNear, PERCH.doveFar)
                : rand(this.rng, PERCH.near, PERCH.far);
            panValue = rand(this.rng, -PERCH.pan, PERCH.pan);
        }
        lane.pan.pan.setValueAtTime(panValue, t);
        lane.direct.gain.setValueAtTime(distanceGain(distance), t);
        lane.lowpass.frequency.setValueAtTime(distanceLowpassHz(distance) ?? ctx.sampleRate / 2 - 100, t);
        lane.send?.gain.setValueAtTime(distanceAir(distance) * AIR_SCALE, t);
        if (recipe.fm) lane.fm.frequency.setValueAtTime(recipe.fm.hz * rand(this.rng, 0.9, 1.1), t);
        else lane.fmDepth.gain.setValueAtTime(0, t);

        let end = t;
        for (const syl of syllables) {
            const at = t + syl.at;
            this._syllable(lane, recipe, at, syl);
            end = Math.max(end, at + syl.dur);
        }
        lane.busyUntil = end;
    }

    _syllable(lane, recipe, t, { dur, pts, amp, tremolo }) {
        const freq = lane.osc.frequency;
        freq.setValueAtTime(pts[0], t);
        const seg = dur / (pts.length - 1);
        for (let i = 1; i < pts.length; i++) freq.exponentialRampToValueAtTime(pts[i], t + seg * i);
        if (recipe.fm) lane.fmDepth.gain.setValueAtTime(pts[0] * recipe.fm.depth, t);

        const g = lane.env.gain;
        const a = amp * recipe.gain * SYLLABLE_GAIN;
        const attack = Math.min(ATTACK_SEC, dur * 0.25);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(a, t + attack);
        if (tremolo) {
            // Full-depth tremolo riding the same decaying shape.
            const half = 0.5 / tremolo;
            let s = t + attack;
            let low = true;
            while (s + half < t + dur) {
                s += half;
                const shape = s < t + dur * SUSTAIN_AT
                    ? 1 - (1 - SUSTAIN) * (s - t) / (dur * SUSTAIN_AT)
                    : SUSTAIN * (t + dur - s) / (dur * (1 - SUSTAIN_AT));
                g.linearRampToValueAtTime(a * shape * (low ? OWL_TREMOLO_FLOOR : 1), s);
                low = !low;
            }
        } else {
            g.linearRampToValueAtTime(a * SUSTAIN, t + dur * SUSTAIN_AT);
        }
        g.linearRampToValueAtTime(0, t + dur);
    }

    _wave(ctx, species) {
        if (!this._waves) this._waves = new Map();
        let wave = this._waves.get(species);
        if (!wave) {
            const harmonics = SPECIES[species].harmonics;
            const real = new Float32Array(harmonics.length + 1);
            const imag = new Float32Array(harmonics.length + 1);
            harmonics.forEach((amp, i) => { imag[i + 1] = amp; });
            wave = ctx.createPeriodicWave(real, imag);
            this._waves.set(species, wave);
        }
        return wave;
    }

    stop() {
        const silentAt = super.stop();
        this._lanes = [];
        this._waves = null;
        return silentAt;
    }
}

function sumRates(rates) {
    return BIRD_SPECIES.reduce((sum, name) => sum + rates[name], 0);
}

/** The species a uniform draw `u` ∈ [0, 1) picks, weighted by `rates`; null when none sings. */
export function pickSpecies(rates, u) {
    const total = sumRates(rates);
    if (!(total > 0)) return null;
    let rest = u * total;
    let last = null;
    for (const name of BIRD_SPECIES) {
        if (!(rates[name] > 0)) continue;
        last = name;
        rest -= rates[name];
        if (rest < 0) return name;
    }
    return last;
}
