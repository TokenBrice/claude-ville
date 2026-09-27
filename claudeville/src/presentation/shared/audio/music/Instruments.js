// The band's instruments (plan 6.1, MUSL-1, MUSL-5, C5): the Isle Band — a
// breathy wooden whistle; a bowed fiddle and a free-reed concertina;
// Karplus–Strong lute, harp, hammered dulcimer and pizzicato upright; a
// modal marimba and a steel-comb music box; brushes and a small kit — and
// the Chip band's console waves, behind one note API:
//
//   createInstrument(engine, name, { dest, rng })
//     → { name, note(t, hz, dur, vel, { pan, bright, soft }) → end | null,
//         release(at), dispose(at), ready }
//
// `release` silences every sounding note (the instrument plays on after
// it); `dispose` also closes the instrument's persistent nodes (the
// whistle's breath lane, the fiddle's bow lane) for good.
//
// `dur` is the written sounding length in seconds; articulation is the
// instrument's own (the whistle sounds 0.95 of it, the fiddle 0.97 and the
// concertina 0.96, each then released in a few tens of ms; the lute rings
// 0.15 s past it and is damped, the dulcimer 0.5 s past it; the upright is
// muted at 0.96 of it; a harp or dulcimer note with `dur` null or Infinity
// rings out, a fiddle or concertina one holds HOLD_MAX_SEC unless released;
// bars, tines and drums always ring out). `note` returns the time the voice
// has stopped, or null when it cannot sound (no context; a percussion take
// not baked yet).
//   vel     linear velocity, 1 = the instrument's reference level;
//   bright  0..1, 1 = as built; below 1 a per-note low-pass at
//           BRIGHT_MIN_HZ · 15^bright (the live waves tilt their harmonics
//           instead, no node);
//   soft    0..1, 0 = as built; up to SOFT_ATTACK_SEC more attack (the
//           fiddle and concertina: their own softAttack, a slower bow or
//           bellows), and bright × (1 − soft/2) (rain and snow
//           arrangements, MUS-16);
//   pan     percussion only: pitched seats pan at the seat (MUSL-5, no
//           per-note panners).
//
// Level: every instrument at vel 1, bright 1, playing its role phrase (a
// lead line, a counter line, a walking bass, eighth-note engine, a brush
// pattern; the music rows of VOICE_REGISTRY in Loudness.js)
// reads INSTRUMENT_REFERENCE_LUFS, today's chip lead stem; a seat's dB
// fader is then its level relative to the lead (MUSL-2).
//
// Nodes (S8, ≤ 4 per note): a baked note is BufferSource → Gain (+ the
// optional low-pass, + a panner on percussion); the whistle and the fiddle
// are Oscillator → Gain (+ LFO and depth for vibrato), each with one noise
// lane per instance (the whistle's breath, the fiddle's bow hair), opened
// by its first note and kept for its life (a release only silences it),
// whose gain and band the notes automate; the concertina is two detuned
// reed Oscillators → one Gain; chip notes are Oscillator → Gain (+
// vibrato). Each seat's MUSL-1 insert EQ is baked into the takes, and the
// fiddle's body resonances and every live voice's seat low-pass are folded
// into its wave, so seats carry only gain, pan and air.
//
// Bakes (SampleBank client `music`, MEMORY_BUDGET.music): strings, bars,
// tines and drums are rendered as pure DSP into mono buffers, one per root,
// four roots an octave (a note plays its nearest root within ±1.5 st), and
// peak-normalised and trimmed where they fall 60 dB under their peak (S8's
// declick: no source stops above −60 dB). They are queued at
// createInstrument() and baked one per idle slice; nothing waits on them.
// Until its root is resident a pitched note plays a live stand-in (an
// oscillator with the instrument's decay) and percussion is skipped. The
// strings are rendered at a band-limited rate with their loop filters mapped
// from the 48 kHz recipe (the prototype's rate), so the timbre below the
// stored Nyquist is the prototype's; the dulcimer's course sums three
// strings a few cents apart into one take, its shimmer baked in. The music
// box has no clapper or pin strike and no bell doublet: its shimmer is
// shallow, never a beating bell.

import { holdAt } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { rngStream } from '../Rng.js';

export const MUSIC_BANK_CLIENT = 'music';
// The rate the MUSL recipes were tuned at; bakes map their loop filters from it.
export const REFERENCE_RATE = 48000;
// Roots every ROOT_STEP semitones: a note plays within ±1.5 st of one.
export const ROOT_STEP = 3;
export const BRIGHT_MIN_HZ = 800;
export const BRIGHT_SPAN = 15; // bright 1 ↔ 12 kHz; at 1 no filter is built
export const SOFT_ATTACK_SEC = 0.03;
// Stem loudness of a role phrase at vel 1 (LUFS-I, mono at the seat input);
// the chip lead at today's gain. See the calibration note in Loudness.js.
export const INSTRUMENT_REFERENCE_LUFS = -36.9;
// Bakes trim where the take stays this far under its peak (S8).
const TRIM_DB = -60;
const TRIM_FADE_SEC = 0.01;
// Release of a whole instrument (stop, section cut): S8's linear ramp.
const RELEASE_SEC = 0.08;
// Exponential envelopes start from and end on a floor 66 dB under their
// peak, so a source stops only once it is past S8's 60 dB (with margin).
const floorOf = peak => Math.max(peak * 5e-4, 1e-9);
// A setTarget decay stops after this many time constants (−69 dB).
const TAIL_TAUS = 8;
const A4 = 440;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const semiOf = hz => 12 * Math.log2(hz / A4);
export const hzOf = semi => A4 * 2 ** (semi / 12);

const freezeAll = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const inner of Object.values(value)) freezeAll(inner);
        Object.freeze(value);
    }
    return value;
};

// ------------------------------------------------------------------ recipes

// Extended Karplus–Strong strings (MUSL-1): pick position, pluck shape
// (`tri` of triangle, the rest pick-combed noise low-passed by `bright`),
// loop damping, T60 per fundamental, and the seat's insert EQ; `course`
// sums several strings struck together, [cents, amp] each.
const STRINGS = {
    lute: {
        pick: 0.13, bright: 0.42, damp: 0.12, tri: 0.5,
        t60: f0 => clamp(2.6 * (196 / f0) ** 0.35, 1.2, 3.2),
        eq: [['highpass', 85, 0.7], ['peaking', 210, 1, 3], ['lowpass', 4200, 0.5]],
    },
    harp: {
        pick: 0.45, bright: 0.2, damp: 0.04, tri: 0.7,
        t60: f0 => clamp(4.5 * (220 / f0) ** 0.45, 1.6, 6),
        eq: [['highpass', 60, 0.7], ['lowpass', 2400, 0.5]],
    },
    // Baked at the longest ring; a shorter note decays faster through its
    // gain (UPRIGHT_T60 below), the player's mute at 0.96 of the note.
    upright: {
        pick: 0.18, bright: 0.1, damp: 0.45, tri: 0.85,
        t60: () => 3.2,
        eq: [['lowpass', 1600, 0.5], ['peaking', 110, 1, 2]],
    },
    // Hammered dulcimer (C5): a course of three steel strings a few cents
    // apart (the slow shimmer of their beating), struck together near the
    // bridge by one hard hammer (little triangle, bright noise), barely
    // damped in the loop, so it rings long and far brighter than the harp,
    // with a metallic presence lift the lute's wooden body lacks.
    dulcimer: {
        pick: 0.09, bright: 0.65, damp: 0.015, tri: 0.2,
        course: [[-2.4, 0.8], [0, 1], [2.4, 0.8]],
        t60: f0 => clamp(4.2 * (262 / f0) ** 0.45, 2, 4.8),
        eq: [['highpass', 110, 0.7], ['peaking', 2800, 0.8, 4], ['lowpass', 6500, 0.5]],
    },
};
// The upright's ring from the note: 1.6 s for a half note, up to 3.2 s for a whole.
const UPRIGHT_T60 = dur => clamp(1.1 * dur + 0.1, 1.6, 3.2);
// The dulcimer has no dampers: a note rings this long past its written end
// before the player's hand stills the course.
const DULCIMER_RING_SEC = 0.5;

// Modal bars, tines and drums: [ratio, amp, t60, detuneHz]; `glide` bends
// every mode down from +glide (fractional) with τ glideSec (a drum head).
const MODAL = {
    // Rosewood bar, yarn mallet: a 6 ms mallet thump.
    marimba: {
        t1: f0 => clamp(1.3 * (262 / f0) ** 0.6, 0.35, 1.8),
        modes: T => [[1, 1, T], [3.99, 0.22, 0.3 * T], [9.87, 0.07, 0.1 * T]],
        attack: 0.0025, click: { amp: 0.05, sec: 0.006, coef: -0.9 },
        eq: [['lowpass', 5000, 0.5]],
    },
    // Steel comb: the tine and its cantilever partials (1 : 6.267 : 17.55),
    // a soft pluck and a shallow shimmer; no pin click.
    musicBox: {
        t1: f0 => clamp(3.4 * (880 / f0) ** 0.35, 1.8, 4.2),
        modes: T => [[1, 0.85, T], [1, 0.15, 0.8 * T, 0.35], [2, 0.04, 0.3 * T], [6.267, 0.06, 0.12], [17.55, 0.015, 0.03]],
        attack: 0.0012, click: null,
        eq: [['highpass', 280, 0.7], ['lowpass', 4500, 0.5]],
    },
    // A low frame-drum tom: circular-membrane modes, a felt beater, the
    // head's pitch settling 6 % over 40 ms.
    lowTom: {
        t1: () => 0.55,
        modes: T => [[1, 1, T], [1.59, 0.5, 0.55 * T], [2.14, 0.3, 0.36 * T], [2.3, 0.2, 0.27 * T], [2.65, 0.15, 0.22 * T], [2.92, 0.1, 0.18 * T]],
        attack: 0.001, click: { amp: 0.15, sec: 0.004, coef: 0.6 }, glide: 0.06, glideSec: 0.04,
        eq: [['highpass', 45, 0.7]],
    },
    // A rim click on the drum's wooden hoop: short wood modes, no ring.
    rim: {
        t1: () => 0.06,
        modes: T => [[1, 1, T], [1.72, 0.55, 0.65 * T], [2.86, 0.3, 0.42 * T], [4.12, 0.15, 0.25 * T]],
        attack: 0.0004, click: { amp: 0.3, sec: 0.0008, coef: 0.95 },
        eq: [['highpass', 400, 0.7]],
    },
};
const RIM_HZ = 1180;
const RIM_VARIANTS = 2;

// Noise takes: filter chain, envelope ([attackSec, decayTau, seconds]) or a
// loop (flat, crossfaded seam) the note shapes.
const NOISE_TAKES = {
    brushTap: { filters: [['bandpass', 3200, 0.9]], env: [0.002, 0.012, 0.09], variants: 4 },
    swish: { filters: [['bandpass', 5000, 0.5]], loop: 1.0, variants: 2 },
    shaker: { filters: [['bandpass', 6500, 1.2]], env: [0.01, 0.022, 0.14], variants: 4 },
    hat: { filters: [['highpass', 3500, Math.SQRT1_2]], env: [0.004, 0.006, 0.05], variants: 3 },
};
const takeVariants = take => (take === 'rim' ? RIM_VARIANTS : NOISE_TAKES[take].variants);
const SWISH_MIN_SEC = 0.4;
const SWISH_RISE_SEC = 0.1;

// Live waves (PeriodicWave imag rows). A live voice's seat low-pass is
// folded into its wave (the harmonics weighted by the 2nd-order response at
// the note's pitch, one wave per semitone), so it costs no node; so are the
// fiddle's body resonances (C5: each a constant-peak band-pass, summed over
// a floor: an LTI body on a periodic string is exactly a harmonic weight).
const lowpassGain = (f, fc, q) => 1 / Math.sqrt((1 - (f / fc) ** 2) ** 2 + (f / (fc * q)) ** 2);
const bandpassGain = (f, fc, q) => 1 / Math.sqrt(1 + (q * (f / fc - fc / f)) ** 2);
const bodyGain = (f, { floor, peaks }) => peaks.reduce((sum, [fc, q, amp]) => sum + amp * bandpassGain(f, fc, q), floor);
const pulseRow = duty => Array.from({ length: 24 }, (_, k) => (k ? (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) : 0));
const WAVES = {
    whistle: [0, 1, 0.16, 0.085, 0.03, 0.012],
    pulse25: pulseRow(0.25),
    pulse12: pulseRow(0.125),
    flute: [0, 1, 0.22, 0.1, 0.04],
    // MUSL-2's chip bass: the triangle with a 2nd and 3rd harmonic added.
    chipBass: [0, 1, 0.3, 1 / 9, 0.08, 1 / 25, 0, 1 / 49],
    triangle: Array.from({ length: 16 }, (_, k) => (k % 2 ? ((((k - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * k * k) : 0)),
    // The bowed string's Helmholtz motion: a sawtooth, 40 harmonics.
    saw: Array.from({ length: 41 }, (_, k) => (k ? 1 / k : 0)),
    // A free reed: every harmonic, falling slowly (k^−0.85), the even ones
    // weaker: the buzzy, slightly hollow squeezebox tone.
    reed: Array.from({ length: 33 }, (_, k) => (k ? k ** -0.85 * (k % 2 ? 1 : 0.55) : 0)),
};

// Chip voices: today's Town band envelopes and seat low-passes (Voicings
// `chip` before 6.1: lead 2.8 kHz, counter and arp 1.8 kHz, bass 800 Hz).
//   env 'hold'  exponential attack, hold, exponential release;
//   env 'pluck' 8 ms attack, exponential decay over the note;
//   env 'swell' slow setTarget swell and an 8τ tail.
// scale/min: sounding seconds = max(min, dur · scale). lp: f0 → [Hz, Q].
const Q_BUTTERWORTH = Math.SQRT1_2;
const CHIP = {
    chipPulse25: { wave: 'pulse25', lp: () => [2800, Q_BUTTERWORTH], env: 'hold', attack: 0.012, release: 0.05, scale: 0.9, min: 0, vibrato: { minSec: 0.9, rate: 5.4, cents: 8, rise: 0.3 } },
    chipPulse12: { wave: 'pulse12', lp: () => [1800, Q_BUTTERWORTH], env: 'hold', attack: 0.012, release: 0.05, scale: 0.95, min: 0 },
    chipArp: { wave: 'pulse12', lp: () => [1800, Q_BUTTERWORTH], env: 'pluck', scale: 1, min: 0 },
    chipTri: { wave: 'triangle', lp: () => [1800, Q_BUTTERWORTH], env: 'swell', scale: 1, min: 0 },
    chipFlute: { wave: 'flute', lp: () => [2800, Q_BUTTERWORTH], env: 'pluck', scale: 1, min: 1.4 },
    chipBass: { wave: 'chipBass', lp: () => [800, Q_BUTTERWORTH], env: 'hold', attack: 0.012, release: 0.05, scale: 0.99, min: 0 },
};

const SWELL_TAU = 0.4;
const SWELL_RELEASE_TAU = 0.3;
const NOTE_TAIL_SEC = 0.08;

// The whistle (MUSL-1): scoop, chiff and breath (its noise lane), vibrato
// on long notes, the low-pass at min(4.8 kHz, 6·f0), Q 0.3.
const WHISTLE = {
    lp: f0 => [Math.min(4800, 6 * f0), 0.3],
    scale: 0.95, scoopCents: -22, scoopSec: 0.07, attack: 0.045, settle: 0.82, releaseTau: 0.035,
    vibrato: { minSec: 0.55, rate: 5.1, cents: 11, from: 0.28, to: 0.68 },
    lane: { ratio: 3.1, maxHz: 6000, q: 0.7, chiff: 0.22, rest: 0.05, chiffSec: 0.012, tau: 0.025, releaseTau: 0.03 },
};
// The pool's white noise (±0.6·√(32/48) uniform, ICC 0.35, folded to one
// channel) against the prototype's ±1 uniform breath: +7.9 dB. Every noise
// lane (breath, bow hair) is matched the same way.
const LANE_NOISE_MATCH = 2.48;

// A fiddle or concertina note without a written end (dur null or Infinity)
// holds this long unless release() cuts it first.
const HOLD_MAX_SEC = 8;
const heldSec = dur => (dur == null || dur === Infinity ? HOLD_MAX_SEC : Math.max(0, Number(dur) || 0));

// The fiddle (C5): the sawtooth through the body (the main air resonance,
// the main wood resonance, the bridge hill) and a gentle low-pass at
// min(6.5 kHz, 12·f0); a bow attack that grips in 60 ms (soft: up to
// 120 ms more), eases to 0.88 and sustains while the note is held, a 50 ms
// release; vibrato 5.5 Hz joining after 150 ms, full by 450 ms, on notes
// long enough to carry it; a scrape of bow hair on the onset through the
// bow lane, then a faint rosin hiss while the bow moves.
const FIDDLE = {
    wave: 'saw',
    lp: f0 => [Math.min(6500, 12 * f0), 0.5],
    body: { floor: 0.3, peaks: [[280, 2.5, 0.5], [460, 2, 0.9], [2800, 1.2, 0.8]] },
    scale: 0.97, attack: 0.06, softAttack: 0.12, settle: 0.88, settleTau: 0.25, releaseTau: 0.05,
    vibrato: { minSec: 0.35, rate: 5.5, cents: 12, from: 0.15, to: 0.45 },
    lane: { ratio: 4, maxHz: 5000, q: 0.8, chiff: 0.12, rest: 0.025, chiffSec: 0.025, tau: 0.05, releaseTau: 0.05 },
};

// The concertina (C5): two reeds per button, ±7 cents apart (the wet
// musette beat), the reed wave through a gentle low-pass at min(3.6 kHz,
// 9·f0); the bellows swell to 0.8 in 70 ms (soft: up to 140 ms more), then
// on to full with τ 0.2 s, a steady sustain, a 40 ms release.
const CONCERTINA = {
    wave: 'reed',
    lp: f0 => [Math.min(3600, 9 * f0), 0.5],
    detuneCents: 7,
    scale: 0.96, attack: 0.07, softAttack: 0.14, swell: 0.8, swellTau: 0.2, releaseTau: 0.04,
};

// ------------------------------------------------------------------ the table

// kind: pluck | modal | wind | bowed | reed | perc | chip. range: the
// sounding semitones re A4 an instrument plays well (the sequencer folds
// notes into it by octaves; a baked row's roots cover it); null on
// unpitched percussion. level: linear gain of vel 1 (the calibration).
// nodesPerNote: the most a note builds.
const CHIP_RANGE = [-36, 24];
const ROWS = {
    whistle: { kind: 'wind', range: [-12, 19], nodesPerNote: 4, level: 0.02653 },
    lute: { kind: 'pluck', range: [-24, 12], bakeRate: 16000, nodesPerNote: 3, level: 0.07718 },
    harp: { kind: 'pluck', range: [-21, 15], bakeRate: 12000, nodesPerNote: 3, level: 0.0473 },
    upright: { kind: 'pluck', range: [-36, -12], bakeRate: 12000, nodesPerNote: 3, level: 0.0755 },
    marimba: { kind: 'modal', range: [-18, 12], bakeRate: 16000, nodesPerNote: 3, level: 0.05089 },
    musicBox: { kind: 'modal', range: [-9, 15], bakeRate: 16000, nodesPerNote: 3, level: 0.03837 },
    fiddle: { kind: 'bowed', range: [-14, 24], nodesPerNote: 4, level: 0.02758 },
    concertina: { kind: 'reed', range: [-17, 17], nodesPerNote: 3, level: 0.02838 },
    dulcimer: { kind: 'pluck', range: [-17, 19], bakeRate: 16000, nodesPerNote: 3, level: 0.1067 },
    brushes: { kind: 'perc', takes: ['brushTap', 'swish'], bakeRate: 24000, nodesPerNote: 4, pannable: true, level: 0.07982 },
    brush: { kind: 'perc', takes: ['brushTap'], bakeRate: 24000, nodesPerNote: 4, pannable: true, level: 0.2095 },
    shaker: { kind: 'perc', takes: ['shaker'], bakeRate: 24000, nodesPerNote: 4, pannable: true, level: 0.1471 },
    lowTom: { kind: 'perc', range: [-31, -19], bakeRate: 12000, nodesPerNote: 4, pannable: true, level: 0.1283 },
    rim: { kind: 'perc', takes: ['rim'], bakeRate: 16000, nodesPerNote: 4, pannable: true, level: 0.2293 },
    chipPulse25: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 4, level: 0.05 },
    chipPulse12: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 2, level: 0.05669 },
    chipArp: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 2, level: 0.2027 },
    chipTri: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 2, level: 0.03184 },
    chipFlute: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 2, level: 0.0551 },
    chipBass: { kind: 'chip', range: CHIP_RANGE, nodesPerNote: 2, level: 0.02564 },
    chipHat: { kind: 'perc', takes: ['hat'], bakeRate: 24000, nodesPerNote: 4, pannable: true, level: 0.2834 },
};

// Roots cover [lo, hi] in ROOT_STEP-semitone cells, each root central to its cell.
export function rootsOf(range) {
    if (!range) return [];
    const [lo, hi] = range;
    const roots = [];
    for (let r = lo + 1; r - 1 <= hi; r += ROOT_STEP) roots.push(r);
    return roots;
}

export const INSTRUMENTS = freezeAll(Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, {
    name,
    ...row,
    pannable: Boolean(row.pannable),
    range: row.range || null,
    roots: row.bakeRate ? rootsOf(row.range) : [],
    takes: row.takes || null,
    baked: Boolean(row.bakeRate),
}])));

// Short lowercase display names (C5: the Town band's Now line names the
// players), one per instrument; the chip lead and counter pulses read alike.
export const INSTRUMENT_LABELS = Object.freeze({
    whistle: 'whistle',
    lute: 'lute',
    harp: 'harp',
    upright: 'bass',
    marimba: 'marimba',
    musicBox: 'music box',
    fiddle: 'fiddle',
    concertina: 'concertina',
    dulcimer: 'dulcimer',
    brushes: 'brushes',
    brush: 'brush',
    shaker: 'shaker',
    lowTom: 'low tom',
    rim: 'rim',
    chipPulse25: 'chip pulse',
    chipPulse12: 'chip pulse',
    chipArp: 'chip arp',
    chipTri: 'chip triangle',
    chipFlute: 'chip flute',
    chipBass: 'chip bass',
    chipHat: 'chip hat',
});

function rowOf(name) {
    const row = INSTRUMENTS[name];
    if (!row) throw new Error(`Unknown instrument: ${name}`);
    return row;
}

// The root a sounding pitch plays from and its playback rate.
export function rootFor(name, semi) {
    const { roots } = rowOf(name);
    if (!roots.length) return null;
    const first = roots[0];
    const index = clamp(Math.round((semi - first) / ROOT_STEP), 0, roots.length - 1);
    const root = roots[index];
    return { root, rate: 2 ** ((semi - root) / 12) };
}

const rootKey = (name, root) => `music:${name}:${root}`;
// Noise and rim takes are shared by every instrument that plays them.
const takeKey = (take, variant) => `music:take:${take}:${variant}`;

// Every bake an instrument needs: { key, name, root | null, take | null,
// variant, sampleRate }.
export function bakeSpecs(name) {
    const row = rowOf(name);
    if (!row.baked) return [];
    if (row.roots.length) {
        return row.roots.map(root => ({ key: rootKey(name, root), name, root, take: null, variant: 0, sampleRate: row.bakeRate }));
    }
    const specs = [];
    for (const take of row.takes) {
        for (let v = 0; v < takeVariants(take); v++) specs.push({ key: takeKey(take, v), name, root: null, take, variant: v, sampleRate: row.bakeRate });
    }
    return specs;
}

// ------------------------------------------------------------------ DSP (pure)

// RBJ biquad, in place (Direct Form I).
function biquad(x, sr, type, hz, q, gainDb = 0) {
    const w = 2 * Math.PI * Math.min(hz, sr * 0.49) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'highpass') {
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'bandpass') {
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'peaking') {
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    } else {
        throw new Error(`Unknown filter: ${type}`);
    }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < x.length; n++) {
        const x0 = x[n];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        x[n] = y0;
    }
    return x;
}

function applyEq(x, sr, eq) {
    for (const [type, hz, q, gain] of eq) biquad(x, sr, type, hz, q, gain);
    return x;
}

// Peak-normalise, then trim where the take stays TRIM_DB under its peak,
// with a short fade into the cut.
export function finishTake(x, sr) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (!(peak > 0)) return new Float32Array(1);
    const floor = peak * 10 ** (TRIM_DB / 20);
    let last = x.length - 1;
    while (last > 0 && Math.abs(x[last]) < floor) last--;
    const out = x.slice(0, last + 1);
    const k = 1 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    const fade = Math.min(out.length, Math.round(TRIM_FADE_SEC * sr));
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
    return out;
}

// Karplus–Strong at `sr`, with the recipe's 48 kHz loop filters mapped
// onto it: the two-point average becomes a symmetric three-tap FIR matched
// at sr/4, each one-pole keeps its corner (pole^(48k/sr)). The loop length
// subtracts the filters' delay; a first-order allpass carries the fraction.
export function renderString(sr, f0, recipe, rng, seconds = recipe.t60(f0)) {
    const k = REFERENCE_RATE / sr;
    const bright = 1 - (1 - recipe.bright) ** k;
    const damp = recipe.damp > 0 ? recipe.damp ** k : 0;
    const a = (1 - Math.cos(Math.PI * (sr / 4) / REFERENCE_RATE)) / 2;
    const t60 = recipe.t60(f0);
    const len = Math.ceil(seconds * sr);
    const out = new Float32Array(len);
    // Phase delays at the fundamental: the FIR's is 1 sample, the damping
    // one-pole's atan(p·sin ω / (1 − p·cos ω)) / ω; the allpass takes the
    // rest exactly (c = sin(ω(1 − D)/2) / sin(ω(1 + D)/2)).
    const w0 = 2 * Math.PI * f0 / sr;
    const dampDelay = damp > 0 ? Math.atan2(damp * Math.sin(w0), 1 - damp * Math.cos(w0)) / w0 : 0;
    const L = sr / f0 - 1 - dampDelay;
    let Li = Math.floor(L);
    let frac = L - Li;
    if (frac < 0.2) { Li -= 1; frac += 1; }
    const c = Math.sin(w0 * (1 - frac) / 2) / Math.sin(w0 * (1 + frac) / 2);
    const g = 10 ** (-3 / (t60 * f0));
    // Excitation: pick-combed low-passed noise, mixed with the pluck triangle.
    const P = Math.max(1, Math.round(recipe.pick * Li));
    const noise = new Float32Array(Li);
    let lp = 0;
    for (let i = 0; i < Li; i++) { lp += bright * ((rng() * 2 - 1) - lp); noise[i] = lp; }
    const ex = new Float32Array(Li);
    let mean = 0;
    for (let i = 0; i < Li; i++) { ex[i] = noise[i] - (i >= P ? noise[i - P] : 0); mean += ex[i]; }
    mean /= Li;
    let pk = 1e-9;
    for (let i = 0; i < Li; i++) { ex[i] -= mean; pk = Math.max(pk, Math.abs(ex[i])); }
    for (let i = 0; i < Li; i++) ex[i] /= pk;
    if (recipe.tri > 0) {
        const shape = new Float32Array(Li);
        let m = 0;
        for (let i = 0; i < Li; i++) { shape[i] = i < P ? i / P : (Li - i) / (Li - P); m += shape[i]; }
        m /= Li;
        let tp = 1e-9;
        for (let i = 0; i < Li; i++) { shape[i] -= m; tp = Math.max(tp, Math.abs(shape[i])); }
        for (let i = 0; i < Li; i++) ex[i] = recipe.tri * shape[i] / tp + (1 - recipe.tri) * ex[i];
    }
    const line = new Float32Array(Li);
    let idx = 0, apX = 0, apY = 0, p1 = 0, p2 = 0, dl = 0;
    const mid = 1 - 2 * a;
    for (let n = 0; n < len; n++) {
        const d = line[idx];
        const ap = c * d + apX - c * apY;
        apX = d; apY = ap;
        let f = a * ap + mid * p1 + a * p2;
        p2 = p1; p1 = ap;
        if (damp > 0) { dl += (1 - damp) * (f - dl); f = dl; }
        const y = (n < Li ? ex[n] : 0) + g * f;
        line[idx] = y;
        idx = idx + 1 === Li ? 0 : idx + 1;
        out[n] = y;
    }
    return out;
}

// A recipe's strings struck together: one string, or its `course` summed
// (one hammer: every string replays the same excitation draws; detuned by
// its cents, all as long as the root's ring).
function renderCourse(sr, f0, recipe, rng) {
    if (!recipe.course) return renderString(sr, f0, recipe, rng);
    const seconds = recipe.t60(f0);
    const out = new Float32Array(Math.ceil(seconds * sr));
    const tape = [];
    const replay = () => {
        let i = 0;
        return () => (i < tape.length ? tape[i++] : (tape[i++] = rng()));
    };
    for (const [cents, amp] of recipe.course) {
        const x = renderString(sr, f0 * 2 ** (cents / 1200), recipe, replay(), seconds);
        for (let n = 0; n < out.length; n++) out[n] += amp * x[n];
    }
    return out;
}

// A bank of exponentially decaying modes, a soft attack and an optional
// first-difference noise click.
export function renderModal(sr, f0, recipe, rng) {
    const T = recipe.t1(f0);
    const modes = recipe.modes(T);
    const seconds = Math.max(...modes.map(m => m[2])) * 1.05 + 0.01;
    const len = Math.ceil(seconds * sr);
    const out = new Float32Array(len);
    const glide = recipe.glide || 0;
    const glideK = glide ? Math.exp(-1 / (recipe.glideSec * sr)) : 0;
    for (const [ratio, amp, t60, det = 0] of modes) {
        const f = f0 * ratio + det;
        if (f * (1 + glide) > sr * 0.45) continue;
        const w = 2 * Math.PI * f / sr;
        const k = Math.exp(-6.907755 / (t60 * sr));
        let ph = rng() * 2 * Math.PI;
        let e = amp;
        let bend = glide;
        const n1 = Math.min(len, Math.ceil(t60 * 1.05 * sr));
        for (let n = 0; n < n1; n++) {
            out[n] += e * Math.sin(ph);
            ph += w * (1 + bend);
            bend *= glideK;
            e *= k;
        }
    }
    if (recipe.click) {
        const n1 = Math.max(1, Math.round(recipe.click.sec * sr));
        let prev = 0;
        for (let n = 0; n < n1 && n < len; n++) {
            const v = rng() * 2 - 1;
            out[n] += recipe.click.amp * (v - recipe.click.coef * prev) * (1 - n / n1);
            prev = v;
        }
    }
    const na = Math.max(1, Math.round(recipe.attack * sr));
    for (let n = 0; n < na && n < len; n++) out[n] *= n / na;
    return out;
}

function renderNoiseTake(sr, take, rng) {
    const spec = NOISE_TAKES[take];
    if (spec.loop) {
        const seam = Math.round(0.03 * sr);
        const n = Math.round(spec.loop * sr);
        const x = new Float32Array(n + seam + Math.round(0.02 * sr));
        for (let i = 0; i < x.length; i++) x[i] = rng() * 2 - 1;
        for (const [type, hz, q] of spec.filters) biquad(x, sr, type, hz, q);
        // Drop the filters' settling, then blend the tail into the head.
        const head = x.length - n - seam;
        const out = x.slice(head, head + n);
        for (let i = 0; i < seam; i++) {
            const w = i / seam;
            out[i] = out[i] * Math.sqrt(w) + x[head + n + i] * Math.sqrt(1 - w);
        }
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
        for (let i = 0; i < n; i++) out[i] /= peak;
        return out;
    }
    const [attack, tau, seconds] = spec.env;
    const x = new Float32Array(Math.ceil(seconds * sr));
    for (let i = 0; i < x.length; i++) {
        const t = i / sr;
        const env = t < attack ? t / attack : Math.exp(-(t - attack) / tau);
        x[i] = (rng() * 2 - 1) * env;
    }
    for (const [type, hz, q] of spec.filters) biquad(x, sr, type, hz, q);
    return finishTake(x, sr);
}

// One bake's samples (pure; seeded by its key).
export function renderBake(spec) {
    const rng = rngStream(`music.take:${spec.key}`);
    const sr = spec.sampleRate;
    if (spec.take === 'rim') return finishTake(applyEq(renderModal(sr, RIM_HZ, MODAL.rim, rng), sr, MODAL.rim.eq), sr);
    if (spec.take) return renderNoiseTake(sr, spec.take, rng);
    const f0 = hzOf(spec.root);
    const string = STRINGS[spec.name];
    if (string) return finishTake(applyEq(renderCourse(sr, f0, string, rng), sr, string.eq), sr);
    const modal = MODAL[spec.name];
    return finishTake(applyEq(renderModal(sr, f0, modal, rng), sr, modal.eq), sr);
}

// ------------------------------------------------------------------ baking

const bankStates = new WeakMap();

function stateOf(bank) {
    let s = bankStates.get(bank);
    if (!s) {
        s = { queue: [], queued: new Set(), busy: false, waiters: [], notes: 0, live: 0, skipped: 0 };
        bankStates.set(bank, s);
    }
    return s;
}

function enqueue(bank, s, spec, { first = false } = {}) {
    if (bank.has(spec.key)) return;
    if (s.queued.has(spec.key)) {
        if (!first) return;
        s.queue = s.queue.filter(q => q.key !== spec.key);
    }
    s.queued.add(spec.key);
    if (first) s.queue.unshift(spec);
    else s.queue.push(spec);
}

// One bake per idle slice (SampleBank.slice, timed in the bank's stats).
function pump(bank, s) {
    if (s.busy || !s.queue.length) return;
    s.busy = true;
    bank.slice(() => {
        s.busy = false;
        const spec = s.queue.shift();
        if (spec) {
            s.queued.delete(spec.key);
            settle(bank, s, spec.key, bakeOne(bank, spec));
        }
        pump(bank, s);
    });
}

function bakeOne(bank, spec) {
    if (bank.has(spec.key)) return true;
    const ctx = bank.engine?.context;
    if (!ctx || typeof ctx.createBuffer !== 'function') return false;
    const data = renderBake(spec);
    const buffer = ctx.createBuffer(1, data.length, spec.sampleRate);
    buffer.copyToChannel(data, 0);
    return bank.adopt(spec.key, MUSIC_BANK_CLIENT, buffer, { pinned: false });
}

function settle(bank, s, key, ok) {
    for (const w of s.waiters) {
        if (!w.keys.delete(key)) continue;
        if (!ok) w.ok = false;
    }
    s.waiters = s.waiters.filter((w) => {
        if (w.keys.size) return true;
        w.resolve(w.ok && w.all.every(k => bank.has(k)));
        return false;
    });
}

// Queue an instrument's bakes (idempotent). Resolves true once all are
// resident, false when any failed or did not fit.
export function bakeInstrument(bank, name) {
    if (!bank || typeof bank.slice !== 'function') return Promise.resolve(false);
    const s = stateOf(bank);
    const pending = bakeSpecs(name).filter(spec => !bank.has(spec.key));
    if (!pending.length) return Promise.resolve(true);
    for (const spec of pending) enqueue(bank, s, spec);
    const all = pending.map(spec => spec.key);
    const promise = new Promise(resolve => s.waiters.push({ keys: new Set(all), all, ok: true, resolve }));
    pump(bank, s);
    return promise;
}

// Resident music bakes and bytes on `bank`, and note counters (diagnostics).
export function instrumentStats(bank) {
    if (!bank) return { bakes: 0, bytes: 0, queued: 0, notes: 0, live: 0, skipped: 0 };
    const s = bankStates.get(bank);
    let bakes = 0;
    for (const name of Object.keys(INSTRUMENTS)) for (const spec of bakeSpecs(name)) if (bank.has(spec.key)) bakes++;
    return {
        bakes,
        bytes: bank.ledger?.clientBytes?.(MUSIC_BANK_CLIENT) ?? 0,
        queued: s?.queue.length ?? 0,
        notes: s?.notes ?? 0,
        live: s?.live ?? 0,
        skipped: s?.skipped ?? 0,
    };
}

// ------------------------------------------------------------------ live waves

const waveCaches = new WeakMap();
const BRIGHT_STEPS = 4;
const PEAK_POINTS = 2048;

// A row's waveform peak: the browser's own normalisation, which the live
// waves apply before their low-pass, as the seat filter did.
const rowPeaks = new Map();
function rowPeak(name) {
    let peak = rowPeaks.get(name);
    if (peak == null) {
        const row = WAVES[name];
        peak = 1e-9;
        for (let i = 0; i < PEAK_POINTS; i++) {
            let v = 0;
            for (let k = 1; k < row.length; k++) v += row[k] * Math.sin(2 * Math.PI * k * i / PEAK_POINTS);
            peak = Math.max(peak, Math.abs(v));
        }
        rowPeaks.set(name, peak);
    }
    return peak;
}

// The harmonic amplitudes of a live wave at `hz`: normalised, weighted by
// the voice's low-pass (lp: f0 → [Hz, Q]) and body (body: { floor, peaks:
// [[Hz, Q, amp]] }) at the semitone's pitch and tilted by k^(−3·(1 −
// bright)) (bright in quarter steps). Pure.
export function liveHarmonics(name, hz, { lp = null, body = null, bright = 1 } = {}) {
    const row = WAVES[name];
    if (!row) throw new Error(`Unknown wave: ${name}`);
    const b = Math.round(clamp(bright, 0, 1) * BRIGHT_STEPS) / BRIGHT_STEPS;
    const f0 = hzOf(Math.round(semiOf(hz)));
    const [fc, q] = lp ? lp(f0) : [0, 0];
    const peak = rowPeak(name);
    return row.map((v, k) => (k
        ? (v / peak) * k ** (-3 * (1 - b)) * (fc ? lowpassGain(k * f0, fc, q) : 1) * (body ? bodyGain(k * f0, body) : 1)
        : 0));
}

// The PeriodicWave for liveHarmonics, cached per context.
function waveFor(ctx, name, hz, opts) {
    if (typeof ctx.createPeriodicWave !== 'function') return null;
    let cache = waveCaches.get(ctx);
    if (!cache) { cache = new Map(); waveCaches.set(ctx, cache); }
    const b = Math.round(clamp(opts.bright ?? 1, 0, 1) * BRIGHT_STEPS) / BRIGHT_STEPS;
    const key = `${name}:${opts.lp || opts.body ? Math.round(semiOf(hz)) : '-'}:${b}:${opts.tag || ''}`;
    let wave = cache.get(key);
    if (!wave) {
        const imag = new Float32Array(liveHarmonics(name, hz, opts));
        wave = ctx.createPeriodicWave(new Float32Array(imag.length), imag, { disableNormalization: true });
        cache.set(key, wave);
    }
    return wave;
}

// ------------------------------------------------------------------ players

const brightHz = bright => BRIGHT_MIN_HZ * BRIGHT_SPAN ** clamp(bright, 0, 1);

function effective(opts) {
    const soft = clamp(Number(opts.soft) || 0, 0, 1);
    const bright = clamp(opts.bright ?? 1, 0, 1) * (1 - soft / 2);
    return { soft, bright, attack: soft * SOFT_ATTACK_SEC };
}

class Instrument {
    constructor(engine, name, { dest, rng }) {
        this.engine = engine;
        this.name = name;
        this.row = rowOf(name);
        this.dest = dest;
        this.rng = typeof rng === 'function' ? rng : rngStream(`music.instrument.${name}`);
        this._voices = new Set();
        this._lane = null;
        const bank = engine?.bank;
        this.ready = this.row.baked ? bakeInstrument(bank, name) : Promise.resolve(true);
    }

    get _ctx() {
        return this.engine?.context ?? null;
    }

    note(t, hz, dur, vel = 1, opts = {}) {
        const ctx = this._ctx;
        if (!ctx || !this.dest || !(hz > 0 || this.row.kind === 'perc')) return null;
        const bank = this.engine.bank;
        const s = bank ? stateOf(bank) : null;
        if (s) s.notes++;
        const kind = this.row.kind;
        if (kind === 'wind') return this._whistle(ctx, t, hz, dur, vel, opts);
        if (kind === 'bowed') return this._fiddle(ctx, t, hz, dur, vel, opts);
        if (kind === 'reed') return this._concertina(ctx, t, hz, dur, vel, opts);
        if (kind === 'chip') return this._chip(ctx, t, hz, dur, vel, opts);
        if (kind === 'perc') return this._perc(ctx, bank, s, t, hz, dur, vel, opts);
        return this._pitched(ctx, bank, s, t, hz, dur, vel, opts);
    }

    // Every sounding note and the noise lane: an 80 ms linear ramp, then the
    // notes stop. The lane stays open, silent, for the next note.
    release(at = this._ctx?.currentTime ?? 0) {
        const ctx = this._ctx;
        if (!ctx) return;
        const t = Math.max(ctx.currentTime, Number(at) || 0);
        for (const voice of this._voices) this._cut(voice, t);
        if (this._lane) {
            holdAt(this._lane.env.gain, t);
            this._lane.env.gain.linearRampToValueAtTime(0, t + RELEASE_SEC);
        }
    }

    // release, and the noise lane stops once silent (the instrument is done).
    dispose(at = this._ctx?.currentTime ?? 0) {
        const ctx = this._ctx;
        if (!ctx) return;
        const t = Math.max(ctx.currentTime, Number(at) || 0);
        this.release(t);
        if (this._lane) {
            for (const src of this._lane.sources) {
                try { src.stop(t + RELEASE_SEC + 0.01); } catch { /* already stopped */ }
            }
            this._lane = null;
        }
    }

    _cut(voice, t) {
        holdAt(voice.env.gain, t);
        voice.env.gain.linearRampToValueAtTime(0, t + RELEASE_SEC);
        for (const src of voice.sources) {
            try { src.stop(t + RELEASE_SEC + 0.01); } catch { /* already stopped */ }
        }
    }

    // Track a voice until its first source ends, then disconnect it.
    _own(sources, env, nodes) {
        const voice = { sources, env };
        this._voices.add(voice);
        sources[0].onended = () => {
            this._voices.delete(voice);
            for (const node of [...sources, ...nodes]) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        };
    }

    // Source → [low-pass] → env → [panner] → seat.
    _chain(ctx, src, env, bright, pan) {
        const nodes = [env];
        let head = src;
        if (bright < 1 && typeof ctx.createBiquadFilter === 'function') {
            const lp = makeFilter(ctx, 'lowpass', brightHz(bright), { q: 'gentle' });
            head.connect(lp);
            head = lp;
            nodes.push(lp);
        }
        head.connect(env);
        if (pan != null && this.row.pannable && typeof ctx.createStereoPanner === 'function') {
            const panner = ctx.createStereoPanner();
            panner.pan.value = clamp(pan, -1, 1);
            env.connect(panner).connect(this.dest);
            nodes.push(panner);
        } else {
            env.connect(this.dest);
        }
        return nodes;
    }

    _pitched(ctx, bank, s, t, hz, dur, vel, opts) {
        const semi = semiOf(hz);
        const { root } = rootFor(this.name, semi);
        const key = rootKey(this.name, root);
        const buffer = bank?.get?.(key) ?? null;
        const { attack, bright } = effective(opts);
        const level = this.row.level * vel;
        const articulation = this._articulation(t, dur);
        if (!buffer) {
            if (bank && s) {
                enqueue(bank, s, bakeSpecs(this.name).find(spec => spec.key === key), { first: true });
                pump(bank, s);
                s.live++;
            }
            return this._standIn(ctx, t, hz, level, attack, articulation);
        }
        const rate = hz / hzOf(root);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const env = ctx.createGain();
        const g = env.gain;
        if (attack > 0) {
            g.setValueAtTime(0, t);
            g.linearRampToValueAtTime(level, t + attack);
        } else {
            g.setValueAtTime(level, t);
        }
        if (articulation.decayTau) g.setTargetAtTime(0, t + attack, articulation.decayTau);
        let end = t + buffer.duration / rate;
        if (articulation.releaseAt != null && articulation.releaseAt < end) {
            g.setTargetAtTime(0, articulation.releaseAt, articulation.tau);
            end = Math.min(end, articulation.releaseAt + articulation.tau * TAIL_TAUS);
        }
        const nodes = this._chain(ctx, src, env, bright, null);
        src.start(t);
        src.stop(end + 0.01);
        this._own([src], env, nodes);
        return end + 0.01;
    }

    // When and how a pitched note is damped: { releaseAt, tau, decayTau }.
    _articulation(t, dur) {
        const finite = Number.isFinite(dur) && dur > 0;
        if (this.name === 'lute') return finite ? { releaseAt: t + dur + 0.15, tau: 0.12 } : {};
        if (this.name === 'harp') return finite ? { releaseAt: t + dur, tau: 0.25 } : {};
        if (this.name === 'dulcimer') return finite ? { releaseAt: t + dur + DULCIMER_RING_SEC, tau: 0.3 } : {};
        if (this.name === 'upright') {
            if (!finite) return {};
            // Extra decay (dB/s) from the baked 3.2 s ring down to the note's.
            const extra = 60 / UPRIGHT_T60(dur) - 60 / STRINGS.upright.t60();
            return { releaseAt: t + 0.96 * dur, tau: 0.07, decayTau: extra > 0 ? 8.685889 / extra : 0 };
        }
        return {};
    }

    // Until a root is baked: an oscillator with the instrument's decay.
    _standIn(ctx, t, hz, level, attack, articulation) {
        const f0 = hz;
        const ring = STRINGS[this.name]?.t60(f0) ?? MODAL[this.name]?.t1(f0) ?? 1;
        let end = t + ring;
        if (articulation.releaseAt != null) end = Math.min(end, articulation.releaseAt + articulation.tau * TAIL_TAUS);
        const osc = ctx.createOscillator();
        osc.type = this.row.kind === 'modal' ? 'sine' : 'triangle';
        osc.frequency.value = f0;
        const env = ctx.createGain();
        const g = env.gain;
        const peak = level * STAND_IN_GAIN;
        g.setValueAtTime(floorOf(peak), t);
        g.exponentialRampToValueAtTime(peak, t + Math.max(0.003, attack));
        g.exponentialRampToValueAtTime(floorOf(peak), end);
        osc.connect(env).connect(this.dest);
        osc.start(t);
        osc.stop(end + 0.01);
        this._own([osc], env, [env]);
        return end + 0.01;
    }

    _perc(ctx, bank, s, t, hz, dur, vel, opts) {
        const { attack, bright } = effective(opts);
        const level = this.row.level * vel;
        let key;
        let swish = false;
        let rate = 1;
        if (this.row.roots.length) {
            const semi = hz > 0 ? semiOf(hz) : this.row.roots[Math.floor(this.row.roots.length / 2)];
            const { root } = rootFor(this.name, semi);
            key = rootKey(this.name, root);
            rate = 2 ** ((semi - root) / 12);
        } else {
            swish = this.name === 'brushes' && Number.isFinite(dur) && dur >= SWISH_MIN_SEC;
            const take = this.name === 'brushes' ? (swish ? 'swish' : 'brushTap') : this.row.takes[0];
            key = takeKey(take, Math.floor(this.rng() * takeVariants(take)));
        }
        const buffer = bank?.get?.(key) ?? null;
        if (!buffer) {
            if (bank && s) {
                const spec = bakeSpecs(this.name).find(sp => sp.key === key);
                if (spec) enqueue(bank, s, spec, { first: true });
                pump(bank, s);
                s.skipped++;
            }
            return null;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const env = ctx.createGain();
        const g = env.gain;
        let end;
        let offset = 0;
        if (swish) {
            // Linear rise, then τ = dur/4 (MUSL-1); the loop outlasts it.
            src.loop = true;
            offset = this.rng() * buffer.duration;
            g.setValueAtTime(0, t);
            g.linearRampToValueAtTime(level, t + SWISH_RISE_SEC + attack);
            g.setTargetAtTime(0, t + SWISH_RISE_SEC + attack + 0.02, dur / 4);
            end = t + SWISH_RISE_SEC + attack + 0.02 + TAIL_TAUS * (dur / 4);
        } else {
            if (attack > 0) {
                g.setValueAtTime(0, t);
                g.linearRampToValueAtTime(level, t + attack);
            } else {
                g.setValueAtTime(level, t);
            }
            end = t + buffer.duration / rate;
        }
        const nodes = this._chain(ctx, src, env, bright, opts.pan);
        src.start(t, offset);
        src.stop(end + 0.01);
        this._own([src], env, nodes);
        return end + 0.01;
    }

    _whistle(ctx, t, hz, dur, vel, opts) {
        const W = WHISTLE;
        const { attack, bright } = effective(opts);
        const sec = Math.max(0.05, (Number(dur) || 0) * W.scale);
        const level = this.row.level * vel;
        const osc = ctx.createOscillator();
        const wave = waveFor(ctx, 'whistle', hz, { lp: W.lp, bright, tag: this.name });
        if (wave && typeof osc.setPeriodicWave === 'function') osc.setPeriodicWave(wave);
        osc.frequency.value = hz;
        osc.detune.setValueAtTime(W.scoopCents, t);
        osc.detune.linearRampToValueAtTime(0, t + W.scoopSec);
        const env = ctx.createGain();
        const g = env.gain;
        const end = t + sec;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(level, t + W.attack + attack);
        g.setTargetAtTime(W.settle * level, t + W.attack + attack + 0.005, Math.max(0.1, sec * 0.6));
        g.setTargetAtTime(0, end, W.releaseTau);
        const stopAt = end + W.releaseTau * TAIL_TAUS;
        const sources = [osc];
        const nodes = [env];
        if (sec >= W.vibrato.minSec) this._delayedVibrato(ctx, osc, t, stopAt, W.vibrato, sources, nodes);
        osc.connect(env).connect(this.dest);
        osc.start(t);
        osc.stop(stopAt);
        this._own(sources, env, nodes);
        this._laneNote(ctx, t, hz, end, level, W.lane);
        return stopAt;
    }

    // The fiddle (C5): one bowed string, the bow lane's scrape on its onset.
    _fiddle(ctx, t, hz, dur, vel, opts) {
        const F = FIDDLE;
        const { soft, bright } = effective(opts);
        const attack = F.attack + soft * F.softAttack;
        const sec = Math.max(attack + 0.02, heldSec(dur) * F.scale);
        const level = this.row.level * vel;
        const osc = ctx.createOscillator();
        const wave = waveFor(ctx, F.wave, hz, { lp: F.lp, body: F.body, bright, tag: this.name });
        if (wave && typeof osc.setPeriodicWave === 'function') osc.setPeriodicWave(wave);
        osc.frequency.value = hz;
        const env = ctx.createGain();
        const g = env.gain;
        const end = t + sec;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(level, t + attack);
        g.setTargetAtTime(F.settle * level, t + attack, F.settleTau);
        g.setTargetAtTime(0, end, F.releaseTau);
        const stopAt = end + F.releaseTau * TAIL_TAUS;
        const sources = [osc];
        const nodes = [env];
        if (sec >= F.vibrato.minSec) this._delayedVibrato(ctx, osc, t, stopAt, F.vibrato, sources, nodes);
        osc.connect(env).connect(this.dest);
        osc.start(t);
        osc.stop(stopAt);
        this._own(sources, env, nodes);
        this._laneNote(ctx, t, hz, end, level, F.lane);
        return stopAt;
    }

    // The concertina (C5): the button's two reeds, ±detuneCents, into one
    // bellows envelope.
    _concertina(ctx, t, hz, dur, vel, opts) {
        const C = CONCERTINA;
        const { soft, bright } = effective(opts);
        const attack = C.attack + soft * C.softAttack;
        const sec = Math.max(attack + 0.02, heldSec(dur) * C.scale);
        const level = this.row.level * vel;
        const wave = waveFor(ctx, C.wave, hz, { lp: C.lp, bright, tag: this.name });
        const env = ctx.createGain();
        const g = env.gain;
        const end = t + sec;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(C.swell * level, t + attack);
        g.setTargetAtTime(level, t + attack, C.swellTau);
        g.setTargetAtTime(0, end, C.releaseTau);
        const stopAt = end + C.releaseTau * TAIL_TAUS;
        const sources = [-1, 1].map((side) => {
            const osc = ctx.createOscillator();
            if (wave && typeof osc.setPeriodicWave === 'function') osc.setPeriodicWave(wave);
            osc.frequency.value = hz;
            osc.detune.value = side * C.detuneCents;
            osc.connect(env);
            osc.start(t);
            osc.stop(stopAt);
            return osc;
        });
        env.connect(this.dest);
        this._own(sources, env, [env]);
        return stopAt;
    }

    // Vibrato that joins late: depth 0 until `from`, full `cents` by `to`.
    _delayedVibrato(ctx, osc, t, stopAt, vib, sources, nodes) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = vib.rate;
        depth.gain.setValueAtTime(0, t);
        depth.gain.setValueAtTime(0, t + vib.from);
        depth.gain.linearRampToValueAtTime(vib.cents, t + vib.to);
        lfo.connect(depth).connect(osc.detune);
        lfo.start(t);
        lfo.stop(stopAt);
        sources.push(lfo);
        nodes.push(depth);
    }

    // The noise lane (the whistle's breath, the fiddle's bow hair): one per
    // instance, opened by its first note (a player that never plays holds no
    // lane) and kept, silent between notes, until dispose(); each note moves
    // its band and chiffs its gain (L: the recipe's `lane`).
    _openLane(ctx, at, L) {
        const src = this.engine?.noiseSource?.('white', { rng: this.rng });
        if (!src || typeof ctx.createBiquadFilter !== 'function') return null;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = L.q;
        bp.channelCount = 1;
        bp.channelCountMode = 'explicit';
        const env = ctx.createGain();
        env.gain.value = 0;
        src.connect(bp).connect(env).connect(this.dest);
        src.onended = () => {
            for (const node of [src, bp, env]) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        };
        src.start(at);
        return { sources: [src], env, bp };
    }

    _laneNote(ctx, t, hz, end, level, L) {
        if (!this._lane) this._lane = this._openLane(ctx, t, L);
        const lane = this._lane;
        if (!lane) return;
        const g = level * LANE_NOISE_MATCH;
        lane.bp.frequency.setValueAtTime(Math.min(L.maxHz, L.ratio * hz), t);
        holdAt(lane.env.gain, t);
        lane.env.gain.linearRampToValueAtTime(L.chiff * g, t + L.chiffSec);
        lane.env.gain.setTargetAtTime(L.rest * g, t + L.chiffSec + 0.002, L.tau);
        lane.env.gain.setTargetAtTime(0, end, L.releaseTau);
    }

    _chip(ctx, t, hz, dur, vel, opts) {
        const C = CHIP[this.name];
        const { attack: soft, bright } = effective(opts);
        const sec = Math.max(C.min, (Number(dur) || 0) * C.scale);
        const level = this.row.level * vel;
        const osc = ctx.createOscillator();
        const wave = waveFor(ctx, C.wave, hz, { lp: C.lp, bright, tag: this.name });
        if (wave && typeof osc.setPeriodicWave === 'function') osc.setPeriodicWave(wave);
        osc.frequency.value = hz;
        const env = ctx.createGain();
        const g = env.gain;
        let stopAt;
        const floor = floorOf(level);
        g.setValueAtTime(floor, t);
        if (C.env === 'pluck') {
            g.exponentialRampToValueAtTime(level, t + 0.008 + soft);
            g.exponentialRampToValueAtTime(floor, t + Math.max(sec, 0.02 + soft));
            stopAt = t + Math.max(sec, 0.02 + soft) + NOTE_TAIL_SEC;
        } else if (C.env === 'swell') {
            g.setTargetAtTime(level, t, SWELL_TAU);
            g.setTargetAtTime(0, t + Math.max(0.05, sec - SWELL_TAU), SWELL_RELEASE_TAU);
            stopAt = t + Math.max(0.05, sec - SWELL_TAU) + SWELL_RELEASE_TAU * TAIL_TAUS;
        } else {
            const a = C.attack + soft;
            g.exponentialRampToValueAtTime(level, t + a);
            g.setValueAtTime(level, t + Math.max(a + 0.008, sec - C.release));
            g.exponentialRampToValueAtTime(floor, t + Math.max(a + 0.02, sec));
            stopAt = t + Math.max(a + 0.02, sec) + NOTE_TAIL_SEC;
        }
        const sources = [osc];
        const nodes = [env];
        const vib = C.vibrato;
        if (vib && sec >= vib.minSec) {
            const lfo = ctx.createOscillator();
            const depth = ctx.createGain();
            lfo.frequency.value = vib.rate;
            depth.gain.setValueAtTime(0, t);
            depth.gain.linearRampToValueAtTime(vib.cents, t + vib.rise);
            lfo.connect(depth).connect(osc.detune);
            lfo.start(t);
            lfo.stop(stopAt);
            sources.push(lfo);
            nodes.push(depth);
        }
        osc.connect(env).connect(this.dest);
        osc.start(t);
        osc.stop(stopAt);
        this._own(sources, env, nodes);
        return stopAt;
    }
}

// The stand-in's level against the baked voice (a triangle or sine carries
// its loudness in the fundamental; the baked takes are peak-normalised).
const STAND_IN_GAIN = 0.5;

export function createInstrument(engine, name, { dest = null, rng = null } = {}) {
    return new Instrument(engine, name, { dest, rng });
}
