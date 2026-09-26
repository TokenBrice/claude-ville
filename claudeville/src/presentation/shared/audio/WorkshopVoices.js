// Workshop voices (plan 5.2, FOL-2 v3; night per 5.5): the eight material
// recipes the work stratum strikes, baked once into 32 kHz mono takes in
// the SampleBank (client 'workshop', Loudness.js MEMORY_BUDGET).
//
// Every recipe is pure DSP on a Float32Array (a seeded stream per take key,
// so a day's takes are reproducible), peak-normalised to 1 and trimmed where
// it stays 70 dB under its peak. Per building: one accent voice at the
// agent's slot pitch (per-agent slots sound only on accents), a ghost voice
// at the building's single ghost pitch, `variants` round-robin
// micro-variants of each. By day every tone is an A-major pentatonic
// degree, at night an A-minor one (C♯→C, F♯→G; the Portal's glass ticks sit
// ×0.75). Nothing holds a mode in 500–700 Hz beyond 150 ms, no metal sits
// below A6, and nothing plays a quick same-pitch struck pair (the needs-you
// ship's bell) or uses bronze handbell partials.
//
// The layer owns level: a take's measured peaks and loud window come with
// it (takeInfo) so the per-strike ceiling and the overlap guard hold.

import { rngStream } from './Rng.js';

export const WORKSHOP_BAKE_RATE = 32000;
export const WORKSHOP_BANK_CLIENT = 'workshop';

const TAU = Math.PI * 2;
// A take ends where it stays this far under its peak (S8 declick: ≥ 60 dB).
const TRIM_DB = -70;
const TRIM_FADE_SEC = 0.002;
const LOUD_DB = -12;
const RING_DB = -60;

// Semitones above A of each pentatonic degree.
export const PENTATONIC = Object.freeze({
    day: Object.freeze([0, 2, 4, 7, 9]),     // A B C♯ E F♯ (A major)
    night: Object.freeze([0, 3, 5, 7, 10]),  // A C D E G (A minor)
});

const NOTE_OFFSET = Object.freeze({
    C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2,
});

// A = 440 Hz 12-TET; 'C#7' → 2217.46.
export function noteHz(name) {
    const m = /^([A-G]#?)(\d)$/.exec(name);
    if (!m) throw new Error(`Unknown note: ${name}`);
    return 440 * Math.pow(2, (NOTE_OFFSET[m[1]] + 12 * (Number(m[2]) - 4)) / 12);
}

const notes = (...names) => Object.freeze(names.map(noteHz));
const phasePitch = (day, night) => Object.freeze({ day: noteHz(day), night: noteHz(night) });

// Per building:
//   accent        { voice, pitchesDay[], pitchesNight[] } Hz, indexed by the slot's pitchIndex
//   ghostVoices   the ghost voice by round-robin variant (variant mod length); [] = accents only
//   ghostPitch    { day, night } Hz, or null
//   voices        { name: { gain, loudSec, fixedPitch? } } — gain relative to the building's
//                 accent (v3 VARIANT_GAIN), loudSec the v3 loud window; fixedPitch voices keep
//                 their own band whatever the slot
//   extraVoices   voices a caller may ask for by name, baked with the phase set
export const WORKSHOP_VOICES = Object.freeze({
    forge: Object.freeze({
        material: 'steel anvil',
        accent: Object.freeze({ voice: 'ring', pitchesDay: notes('A6', 'E7', 'C#7', 'F#7'), pitchesNight: notes('A6', 'E7', 'C7', 'G7') }),
        ghostVoices: Object.freeze(['ring', 'work', 'ring']),
        ghostPitch: phasePitch('B6', 'D7'),
        voices: Object.freeze({
            ring: Object.freeze({ gain: 1, loudSec: 0.15 }),
            work: Object.freeze({ gain: 0.9, loudSec: 0.1 }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    archive: Object.freeze({
        material: 'parchment and quill',
        accent: Object.freeze({ voice: 'page', pitchesDay: notes('F#7', 'A7', 'E7', 'B7'), pitchesNight: notes('G7', 'A7', 'E7', 'D7') }),
        ghostVoices: Object.freeze(['quill', 'quill', 'page']),
        ghostPitch: phasePitch('A7', 'A7'),
        voices: Object.freeze({
            page: Object.freeze({ gain: 1, loudSec: 0.2 }),
            quill: Object.freeze({ gain: 0.55, loudSec: 0.25, fixedPitch: phasePitch('A7', 'A7') }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    mine: Object.freeze({
        material: 'steel pick on limestone',
        accent: Object.freeze({ voice: 'pick', pitchesDay: notes('C#6', 'E6'), pitchesNight: notes('D6', 'E6') }),
        ghostVoices: Object.freeze([]),
        ghostPitch: null,
        voices: Object.freeze({
            pick: Object.freeze({ gain: 1, loudSec: 0.08 }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    taskboard: Object.freeze({
        material: 'brass tack and chalk on slate',
        accent: Object.freeze({ voice: 'pin', pitchesDay: notes('E6', 'F#6'), pitchesNight: notes('E6', 'G6') }),
        ghostVoices: Object.freeze(['pin']),
        ghostPitch: phasePitch('E6', 'E6'),
        voices: Object.freeze({
            pin: Object.freeze({ gain: 1, loudSec: 0.06 }),
            chalk: Object.freeze({ gain: 0.6, loudSec: 0.13, fixedPitch: phasePitch('F#7', 'E7') }),
        }),
        extraVoices: Object.freeze(['chalk']),
        airSend: 0.7,
        variants: 6,
    }),
    observatory: Object.freeze({
        material: 'brass telescope detents',
        accent: Object.freeze({ voice: 'ratchet', pitchesDay: notes('C#7', 'E7'), pitchesNight: notes('D7', 'C7') }),
        ghostVoices: Object.freeze(['ratchet']),
        ghostPitch: phasePitch('C#7', 'D7'),
        voices: Object.freeze({
            ratchet: Object.freeze({ gain: 1, loudSec: 0.15 }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    portal: Object.freeze({
        material: 'rune-stone breath and glass ticks',
        accent: Object.freeze({ voice: 'rune', pitchesDay: notes('A7'), pitchesNight: notes('E7') }),
        ghostVoices: Object.freeze(['rune']),
        ghostPitch: phasePitch('A7', 'E7'),
        voices: Object.freeze({
            rune: Object.freeze({ gain: 1, loudSec: 0.2 }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    command: Object.freeze({
        material: 'canvas flag',
        accent: Object.freeze({ voice: 'flag', pitchesDay: notes('B6', 'A6'), pitchesNight: notes('C7', 'A6') }),
        ghostVoices: Object.freeze(['flag']),
        ghostPitch: phasePitch('B6', 'C7'),
        voices: Object.freeze({
            flag: Object.freeze({ gain: 1, loudSec: 0.12 }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
    harbor: Object.freeze({
        material: 'rope and oak crate',
        accent: Object.freeze({ voice: 'crate', pitchesDay: notes('F#6', 'E6'), pitchesNight: notes('G6', 'E6') }),
        ghostVoices: Object.freeze(['rope']),
        ghostPitch: phasePitch('A6', 'A6'),
        voices: Object.freeze({
            crate: Object.freeze({ gain: 1, loudSec: 0.1 }),
            rope: Object.freeze({ gain: 0.5, loudSec: 0.35, fixedPitch: phasePitch('A6', 'A6') }),
        }),
        extraVoices: Object.freeze([]),
        airSend: 0.7,
        variants: 6,
    }),
});

// ------------------------------------------------------------ mode tables
// Rows [ratio, gain, tau s] of exponentially decaying sines. `tonalModes()`
// reads the same tables, so the 500–700 Hz rule is tested on what bakes.

// Thick-block steel (not free-bar 1/2.76/5.40: that is the gold glockenspiel),
// a near-doublet on the lowest mode; lowest-mode T60 0.35 s.
const ANVIL_MODES = [[1, 1, 0.05], [1.0037, 0.55, 0.045], [1.52, 0.5, 0.035], [2.21, 0.35, 0.025], [2.93, 0.22, 0.018], [3.61, 0.12, 0.012]];
const ANVIL_TAU_JITTER = 0.15;
const ANVIL_RATIO_JITTER = 0.008;
const ANVIL_DAMP = 0.55;           // the `work` blow: the hot workpiece damps the block
const ANVIL_THUD_HZ = [150, 185];
const ANVIL_THUD_TAU = 0.022;
const PICK_MODES = [[1, 1, 0.022], [1.58, 0.65, 0.016], [2.31, 0.4, 0.011], [3.1, 0.2, 0.007]];
const PICK_RING_HZ = 3300;
const PICK_RING_TAU = 0.02;
const PIN_MODES = [[1, 1, 0.012], [2.31, 0.45, 0.007], [3.2, 0.15, 0.004]];
const DETENT_MODES = [[1, 1, 0.009], [1.47, 0.55, 0.006], [1.93, 0.3, 0.004]];
// The gear ring rings longest of the ratchet: brass, so never below A6
// (v3 had it at 1.6 kHz); A is in both pentatonics.
const GEAR_RING = Object.freeze({ hz: noteHz('A6'), tau: 0.03 });
const KNOCK_MODES = [[1, 1, 0.016], [1.47, 0.6, 0.011], [2.21, 0.3, 0.007]];
const CRATE_BODY_HZ = [190, 240];
// Out of the needs-you register (500–700 Hz): the rope's 4th-order
// high-pass and the page sweep's lowest start.
const ROPE_HIGHPASS_HZ = 800;
const PAGE_SWEEP_FLOOR_HZ = 800;
const CRATE_BODY_MODES = [[1, 0.35, 0.04], [1.93, 0.22, 0.03], [2.97, 0.14, 0.02]];
// v2 had the board mode at 640–700 Hz, τ 25 ms (T60 0.17 s inside the
// needs-you register); moved above 800 Hz like the sea's hull groans.
const CRATE_BOARD_HZ = [820, 880];
const CRATE_BOARD_TAU = 0.025;
// The crate's settle knock lands a fourth under the knock, never on its
// pitch: no quick same-pitch pair.
const CRATE_SETTLE_RATIO = 0.75;
const RUNE_TICK_TAUS = [0.018, 0.012];
// Second glass tick: the next pentatonic degree up (a major third by day,
// a minor third at night).
const RUNE_SECOND = Object.freeze({ day: Math.pow(2, 4 / 12), night: Math.pow(2, 3 / 12) });
const FREQ_JITTER = 0.01;          // tone jitter of the pitched cores per take

// ----------------------------------------------------------------- DSP kit

function coeffs(type, f, q, sr) {
    const w = TAU * Math.min(f, sr * 0.45) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; }
    else if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    const a0 = 1 + alpha;
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
}

// One DSP context per take: sample rate and seeded stream.
function kit(sr, rng) {
    const buf = sec => new Float32Array(Math.max(1, Math.round(sec * sr)));
    const between = (a, b) => a + (b - a) * rng();
    const jit = amt => 1 + (rng() * 2 - 1) * amt;
    const filt = (x, type, f, q = 0.707) => {
        const [b0, b1, b2, a1, a2] = coeffs(type, f, q, sr);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < x.length; i++) {
            const xi = x[i];
            const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = xi; y2 = y1; y1 = y;
            x[i] = y;
        }
        return x;
    };
    // Band-pass whose centre follows fnHz(t s); coefficients every 32 samples.
    const sweepBP = (x, fnHz, q) => {
        let c = coeffs('bp', fnHz(0), q, sr);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < x.length; i++) {
            if ((i & 31) === 0) c = coeffs('bp', fnHz(i / sr), q, sr);
            const xi = x[i];
            const y = c[0] * xi + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
            x2 = x1; x1 = xi; y2 = y1; y1 = y;
            x[i] = y;
        }
        return x;
    };
    const noiseInto = (x, gain = 1) => {
        for (let i = 0; i < x.length; i++) x[i] += gain * (rng() * 2 - 1);
        return x;
    };
    const addInto = (dst, src, at = 0, gain = 1) => {
        const o = Math.round(at * sr);
        for (let i = 0; i < src.length && o + i < dst.length; i++) if (o + i >= 0) dst[o + i] += gain * src[i];
        return dst;
    };
    // Exponentially decaying sine from `at` s (dropped near Nyquist).
    const mode = (dst, f, g, tau, at = 0) => {
        if (f >= Math.min(9500, sr * 0.45) || g <= 0) return;
        const o = Math.round(at * sr);
        const n = Math.min(dst.length - o, Math.round(tau * 7 * sr));
        const ph = rng() * TAU, w = TAU * f / sr, d = Math.exp(-1 / (tau * sr));
        let e = g;
        for (let i = 0; i < n; i++) { dst[o + i] += e * Math.sin(ph + w * i); e *= d; }
    };
    // Short noise burst with an exponential decay (exciter, click).
    const burst = (len, tau) => {
        const x = buf(len);
        const d = Math.exp(-1 / (tau * sr));
        let e = 1;
        for (let i = 0; i < x.length; i++) { x[i] = (rng() * 2 - 1) * e; e *= d; }
        return x;
    };
    const fadeIn = (x, ms) => {
        const n = Math.round(ms * sr / 1000);
        for (let i = 0; i < n && i < x.length; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / n);
        return x;
    };
    const tail = (x, ms) => {
        const n = Math.min(x.length, Math.round(ms * sr / 1000));
        for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
        return x;
    };
    // Limit the first `ms` to `ratio` × the body's peak (crest control, FOL-3 v2).
    const limitHead = (x, ms = 3, ratio = 1) => {
        const n = Math.min(x.length, Math.round(ms * sr / 1000));
        let p0 = 0, p1 = 0;
        for (let i = 0; i < n; i++) p0 = Math.max(p0, Math.abs(x[i]));
        for (let i = n; i < x.length; i++) p1 = Math.max(p1, Math.abs(x[i]));
        if (p1 <= 0 || p0 <= ratio * p1) return x;
        const g = ratio * p1 / p0, xf = Math.round(sr / 1000);
        for (let i = 0; i < n + xf && i < x.length; i++) x[i] *= i < n ? g : g + (1 - g) * ((i - n) / xf);
        return x;
    };
    return { sr, rng, buf, between, jit, filt, sweepBP, noiseInto, addInto, mode, burst, fadeIn, tail, limitHead };
}

// ----------------------------------------------------------------- recipes
// Each: (k, { tone, hard, night }) → Float32Array (not yet normalised).

// FORGE — steel anvil, a tap on the horn (`ring`) or a blow on hot iron
// (`work`: damped modes plus the hammer's low thud).
function anvil(k, { tone, hard, damp }) {
    const x = k.buf(damp > 0.5 ? 0.3 : 0.45);
    for (const [r, g, tau] of ANVIL_MODES) {
        const rr = r === 1 ? 1 : r * k.jit(ANVIL_RATIO_JITTER);
        const gg = g * Math.pow(r, -(1 - hard) * 1.1) * k.jit(0.15) * (1 - 0.72 * damp);
        k.mode(x, tone * rr, gg, tau * k.jit(ANVIL_TAU_JITTER) * (1 - 0.65 * damp));
    }
    k.addInto(x, k.filt(k.burst(0.006, 0.0012), 'hp', 1800), 0, 0.5 * hard);
    if (damp > 0) {
        const thud = k.buf(0.12);
        k.mode(thud, k.between(ANVIL_THUD_HZ[0], ANVIL_THUD_HZ[1]), 1, ANVIL_THUD_TAU);
        k.addInto(thud, k.filt(k.burst(0.05, 0.012), 'lp', 750), 0, 0.9);
        k.addInto(x, thud, 0, 1.3 * damp);
    }
    return k.tail(k.fadeIn(x, 0.4), 20);
}

// ARCHIVE — a parchment page turned: a swish rising to `tone`, paper
// crackle, a soft landing flop.
function page(k, { tone }) {
    const dur = k.between(0.17, 0.26);
    const x = k.noiseInto(k.buf(dur + 0.06));
    const f2 = tone * k.jit(0.02);
    const f1 = Math.max(PAGE_SWEEP_FLOOR_HZ, f2 * (850 / 3100));
    k.sweepBP(x, t => f1 * Math.pow(f2 / f1, Math.min(1, t / dur)), 0.9);
    const d = Math.exp(-1 / (0.0015 * k.sr));
    let g = 0;
    for (let i = 0; i < x.length; i++) {
        if (k.rng() < 380 / k.sr) g += k.between(0.4, 1.2);
        g *= d;
        const t = i / k.sr;
        const env = t < dur * 0.72 ? Math.pow(t / (dur * 0.72), 1.6) : Math.exp(-(t - dur * 0.72) / 0.022);
        x[i] *= env * (0.35 + 0.65 * Math.min(1.2, g));
    }
    k.addInto(x, k.filt(k.burst(0.04, 0.009), 'lp', 420), dur * 0.78, 0.6);
    return k.tail(k.fadeIn(x, 2), 10);
}

// ARCHIVE — quill scratch: 3–5 stick-slip strokes through a narrow band at `tone`.
function quill(k, { tone }) {
    const strokes = 3 + Math.floor(k.rng() * 3);
    const x = k.buf(0.45);
    let t = 0;
    for (let s = 0; s < strokes; s++) {
        const len = k.between(0.025, 0.055);
        const st = k.buf(len);
        let next = 0;
        for (let i = 0; i < st.length; i++) {
            if (i >= next) { st[i] = k.rng() * 2 - 1; next = i + Math.round(k.sr / k.between(150, 260)); }
            st[i] *= Math.pow(Math.sin(Math.PI * i / st.length), 2);
        }
        // The grain stays inside the band (v3 added it after the filter:
        // broadband noise up to Nyquist put the quill's centroid at 7.5 kHz).
        k.noiseInto(st, 0.02);
        k.filt(st, 'bp', tone * k.jit(0.06), 3);
        k.addInto(x, st, t, k.jit(0.25));
        t += len + k.between(0.015, 0.035);
    }
    return k.tail(x, 10);
}

// MINE — steel pick on limestone (v2): a bright chip at `tone`, a short
// 2.6 kHz impact, a faint pick ring and at most two pebbles.
function pick(k, { tone }) {
    const x = k.buf(0.26);
    k.addInto(x, k.filt(k.burst(0.008, 0.0025), 'bp', 2600 * k.jit(0.1), 1.0), 0, 0.4);
    const fs = tone * k.jit(FREQ_JITTER);
    for (const [r, g, tau] of PICK_MODES) k.mode(x, fs * r * k.jit(0.01), g, tau);
    k.mode(x, PICK_RING_HZ * k.jit(0.05), 0.12, PICK_RING_TAU);
    const n = Math.floor(k.rng() * 3);
    let t = k.between(0.035, 0.06);
    for (let j = 0; j < n; j++) {
        k.addInto(x, k.filt(k.burst(0.003, 0.0007), 'bp', k.between(3500, 5000), 2), t, 0.15 * Math.pow(0.7, j));
        t += k.between(0.03, 0.05);
    }
    return k.limitHead(k.tail(k.fadeIn(x, 0.3), 8));
}

// TASK BOARD — brass tack into oak (v3): an oak tock at `tone`, the tack tick, paper.
function pin(k, { tone }) {
    const x = k.buf(0.18);
    const f = tone * k.jit(FREQ_JITTER);
    for (const [r, g, tau] of PIN_MODES) k.mode(x, f * r * k.jit(0.02), g, tau);
    k.addInto(x, k.filt(k.burst(0.004, 0.0008), 'bp', 4500, 3), 0, 0.8);
    k.addInto(x, k.filt(k.burst(0.04, 0.012), 'bp', 2800, 1), 0.005, 0.3);
    return k.limitHead(k.tail(k.fadeIn(x, 0.3), 8));
}

// TASK BOARD — one chalk stroke on slate (v3), 90–130 ms, grainy, band at `tone`.
function chalk(k, { tone }) {
    const len = k.between(0.09, 0.13);
    const x = k.buf(len + 0.02);
    const st = k.noiseInto(k.buf(len));
    let next = 0, amp = 1;
    for (let i = 0; i < st.length; i++) {
        if (i >= next) { amp = k.between(0.35, 1); next = i + Math.round(k.sr / k.between(45, 70)); }
        const t = i / k.sr;
        st[i] *= Math.min(1, t / 0.006) * Math.min(1, (len - t) / 0.025) * amp;
    }
    const fa = tone * k.jit(0.03);
    k.sweepBP(st, t => fa * (1 - 0.14 * t / len), 2.2);
    k.addInto(x, st, 0, 1);
    return k.tail(x, 8);
}

// OBSERVATORY — brass telescope ratchet (v3): 4–5 equal detents 24–32 ms
// apart at `tone`, the last seating harder, and the gear ring.
function ratchet(k, { tone }) {
    const x = k.buf(0.3);
    const n = 4 + Math.floor(k.rng() * 2);
    const fb = tone * k.jit(FREQ_JITTER);
    let t = 0;
    for (let j = 0; j < n; j++) {
        const g = (j === n - 1 ? 1.2 : 0.9) * k.jit(0.12);
        for (const [r, gg, tau] of DETENT_MODES) k.mode(x, fb * r * k.jit(0.01), g * gg, tau, t);
        t += k.between(0.024, 0.032);
    }
    k.mode(x, GEAR_RING.hz * k.jit(0.005), 0.2, GEAR_RING.tau);
    return k.limitHead(k.tail(k.fadeIn(x, 0.3), 8));
}

// PORTAL — rune-stone breath (v3): a 60–90 ms rise 1.2 → 3.5 kHz closed by
// two glass ticks, the first at `tone`, the second a pentatonic step above.
function rune(k, { tone, night }) {
    const rise = k.between(0.06, 0.09);
    const x = k.buf(rise + 0.2);
    const air = k.noiseInto(k.buf(rise + 0.04));
    k.sweepBP(air, t => 1200 * Math.pow(3500 / 1200, Math.min(1, t / rise)), 1.6);
    for (let i = 0; i < air.length; i++) {
        const t = i / k.sr;
        air[i] *= t < rise ? Math.pow(t / rise, 1.5) : Math.exp(-(t - rise) / 0.015);
    }
    k.addInto(x, air, 0, 0.7);
    const f = tone * k.jit(FREQ_JITTER);
    k.mode(x, f, 1, RUNE_TICK_TAUS[0], rise);
    k.mode(x, f * RUNE_SECOND[night ? 'night' : 'day'], 0.7, RUNE_TICK_TAUS[1], rise + k.between(0.018, 0.03));
    return k.tail(k.fadeIn(x, 1.5), 8);
}

// COMMAND — canvas signal flag (v3): a cloth crack centred on `tone`, a
// second flap, three flutters, a low whup as colour.
function flag(k, { tone }) {
    const x = k.buf(0.28);
    const fc = tone * k.jit(0.03);
    k.addInto(x, k.fadeIn(k.filt(k.burst(0.05, 0.008), 'bp', fc, 1.4), 1.2), 0, 1);
    k.addInto(x, k.filt(k.burst(0.012, 0.0025), 'bp', fc * 1.6, 2), 0.002, 0.5);
    k.addInto(x, k.filt(k.burst(0.05, 0.01), 'bp', fc * 0.85, 1.4), k.between(0.04, 0.07), 0.5);
    let t = 0.09;
    for (let j = 0; j < 3; j++) {
        k.addInto(x, k.filt(k.burst(0.02, 0.004), 'bp', k.between(1800, 2600), 1.6), t, 0.22 * Math.pow(0.7, j));
        t += k.between(0.02, 0.028);
    }
    k.addInto(x, k.filt(k.burst(0.04, 0.01), 'lp', 300), 0, 0.12);
    return k.limitHead(k.tail(x, 8));
}

// HARBOR — an oak crate set down (v2): the oak-on-oak knock at `tone`
// carries it; the low body and the board are colour.
function crate(k, { tone }) {
    const x = k.buf(0.3);
    const fb = k.between(CRATE_BODY_HZ[0], CRATE_BODY_HZ[1]);
    for (const [r, g, tau] of CRATE_BODY_MODES) k.mode(x, fb * r * k.jit(0.03), g, tau);
    const k1 = tone * k.jit(FREQ_JITTER);
    for (const [r, g, tau] of KNOCK_MODES) k.mode(x, k1 * r * k.jit(0.01), g, tau);
    k.mode(x, k.between(CRATE_BOARD_HZ[0], CRATE_BOARD_HZ[1]), 0.3, CRATE_BOARD_TAU);
    k.addInto(x, k.filt(k.burst(0.004, 0.001), 'lp', 3500), 0, 0.5);
    const settle = k.buf(0.06);
    k.mode(settle, k1 * CRATE_SETTLE_RATIO, 1, 0.008);
    k.mode(settle, k1 * CRATE_SETTLE_RATIO * 1.47, 0.5, 0.006);
    k.addInto(x, settle, k.between(0.06, 0.09), 0.3);
    return k.limitHead(k.tail(k.fadeIn(x, 0.4), 8));
}

// HARBOR — rope creak (v2): stick-slip pulses gliding 150–190 → 240–300 Hz
// through two wood resonances at `tone` / 2 and `tone`.
function rope(k, { tone }) {
    const dur = k.between(0.28, 0.45);
    const x = k.buf(dur + 0.03);
    const fA = k.between(150, 190), fB = k.between(240, 300);
    let next = 0;
    for (let i = 0; i < x.length; i++) {
        if (i >= next) {
            x[i] = k.between(0.5, 1);
            const t = i / k.sr;
            next = i + Math.max(1, Math.round((k.sr / (fA * Math.pow(fB / fA, Math.min(1, t / dur)))) * k.jit(0.12)));
        }
    }
    const a = k.filt(Float32Array.from(x), 'bp', tone * 0.5 * k.jit(0.02), 6);
    const b = k.filt(Float32Array.from(x), 'bp', tone * k.jit(0.02), 8);
    for (let i = 0; i < x.length; i++) {
        const t = i / k.sr;
        x[i] = (0.55 * a[i] + 0.45 * b[i]) * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, t / dur))), 0.8);
    }
    // The pulses' low harmonics stay out of the needs-you register (500–700 Hz).
    k.filt(k.filt(x, 'hp', ROPE_HIGHPASS_HZ), 'hp', ROPE_HIGHPASS_HZ);
    k.filt(x, 'lp', 3200, 0.6);
    return k.tail(x, 10);
}

const RECIPES = Object.freeze({
    ring: (k, o) => anvil(k, { ...o, damp: 0 }),
    work: (k, o) => anvil(k, { ...o, damp: ANVIL_DAMP }),
    page, quill, pick, pin, chalk, ratchet, rune, flag, crate, rope,
});
// Voices whose takes differ by striking hardness (accent vs ghost pools).
const HARDNESS_VOICES = new Set(['ring', 'work']);
// Voices whose recipe reads the phase beyond their tone.
const PHASE_VOICES = new Set(['rune']);

// Pitched components of a voice at `tone`: [{ lo, hi, tauMax }] (Hz, s) —
// the frequency span a mode can take across takes and its longest decay.
export function tonalModes(voice, tone, { night = false } = {}) {
    const span = (f, jitter) => [f * (1 - jitter), f * (1 + jitter)];
    const rows = (table, f, fj, rj = 0, tj = 0, tauScale = 1) => table.map(([r, , tau]) => {
        const [lo, hi] = span(f * r, fj + (r === 1 ? 0 : rj));
        return { lo, hi, tauMax: tau * tauScale * (1 + tj) };
    });
    switch (voice) {
        case 'ring': return rows(ANVIL_MODES, tone, 0, ANVIL_RATIO_JITTER, ANVIL_TAU_JITTER);
        case 'work': return [
            ...rows(ANVIL_MODES, tone, 0, ANVIL_RATIO_JITTER, ANVIL_TAU_JITTER, 1 - 0.65 * ANVIL_DAMP),
            { lo: ANVIL_THUD_HZ[0], hi: ANVIL_THUD_HZ[1], tauMax: ANVIL_THUD_TAU },
        ];
        case 'pick': return [
            ...rows(PICK_MODES, tone, FREQ_JITTER + 0.01),
            { lo: PICK_RING_HZ * 0.95, hi: PICK_RING_HZ * 1.05, tauMax: PICK_RING_TAU },
        ];
        case 'pin': return rows(PIN_MODES, tone, FREQ_JITTER + 0.02);
        case 'ratchet': return [
            ...rows(DETENT_MODES, tone, FREQ_JITTER + 0.01),
            { lo: GEAR_RING.hz * 0.995, hi: GEAR_RING.hz * 1.005, tauMax: GEAR_RING.tau },
        ];
        case 'rune': {
            const second = RUNE_SECOND[night ? 'night' : 'day'];
            return [
                { lo: tone * (1 - FREQ_JITTER), hi: tone * (1 + FREQ_JITTER), tauMax: RUNE_TICK_TAUS[0] },
                { lo: tone * second * (1 - FREQ_JITTER), hi: tone * second * (1 + FREQ_JITTER), tauMax: RUNE_TICK_TAUS[1] },
            ];
        }
        case 'crate': return [
            ...CRATE_BODY_MODES.map(([r, , tau]) => ({ lo: CRATE_BODY_HZ[0] * r * 0.97, hi: CRATE_BODY_HZ[1] * r * 1.03, tauMax: tau })),
            ...rows(KNOCK_MODES, tone, FREQ_JITTER + 0.01),
            { lo: CRATE_BOARD_HZ[0], hi: CRATE_BOARD_HZ[1], tauMax: CRATE_BOARD_TAU },
            { lo: tone * CRATE_SETTLE_RATIO * (1 - FREQ_JITTER), hi: tone * CRATE_SETTLE_RATIO * (1 + FREQ_JITTER), tauMax: 0.008 },
            { lo: tone * CRATE_SETTLE_RATIO * 1.47 * (1 - FREQ_JITTER), hi: tone * CRATE_SETTLE_RATIO * 1.47 * (1 + FREQ_JITTER), tauMax: 0.006 },
        ];
        // Noise voices: band-passed noise, no decaying mode.
        default: return [];
    }
}

// ------------------------------------------------------------- take specs

const phaseOf = night => (night ? 'night' : 'day');

// The voice a strike uses: the accent voice, or the ghost cycle by variant;
// `voice` overrides with any of the building's voices. null when none.
export function voiceFor(building, { kind = 'accent', variant = 0, voice = null } = {}) {
    const b = WORKSHOP_VOICES[building];
    if (!b) return null;
    if (voice != null) return Object.hasOwn(b.voices, voice) ? voice : null;
    if (kind === 'ghost') {
        const cycle = b.ghostVoices;
        return cycle.length ? cycle[wrap(variant, cycle.length)] : null;
    }
    return b.accent.voice;
}

function wrap(i, n) {
    const k = Math.floor(Number(i) || 0);
    return ((k % n) + n) % n;
}

// Pure description of one take: { key, building, kind, voice, tone, night, variant, hard }, or null.
export function takeSpec(building, { kind = 'accent', pitchIndex = 0, variant = 0, night = false, voice = null } = {}) {
    const b = WORKSHOP_VOICES[building];
    const name = voiceFor(building, { kind, variant, voice });
    if (!b || !name) return null;
    const phase = phaseOf(night);
    const fixed = b.voices[name].fixedPitch;
    let tone;
    if (fixed) tone = fixed[phase];
    else if (kind === 'ghost') tone = b.ghostPitch?.[phase];
    else {
        const pitches = night ? b.accent.pitchesNight : b.accent.pitchesDay;
        tone = pitches[wrap(pitchIndex, pitches.length)];
    }
    if (!(tone > 0)) return null;
    const v = wrap(variant, b.variants);
    const hardPool = HARDNESS_VOICES.has(name) ? (kind === 'ghost' ? 'g' : 'a') : null;
    const spread = b.variants > 1 ? v / (b.variants - 1) : 1;
    const hard = hardPool === 'g' ? 0.55 + 0.2 * spread : 0.8 + 0.2 * spread;
    const parts = ['work', building, name, Math.round(tone)];
    if (hardPool) parts.push(hardPool);
    if (PHASE_VOICES.has(name)) parts.push(phase[0]);
    parts.push(v);
    return { key: parts.join(':'), building, kind, voice: name, tone, night: Boolean(night), variant: v, hard: hardPool ? hard : 1 };
}

// Every take one phase needs (deduplicated by key): accents at each slot
// pitch, the ghost cycle and the extra voices, `variants` each.
export function workshopTakeSpecs({ night = false } = {}) {
    const out = new Map();
    const add = spec => { if (spec && !out.has(spec.key)) out.set(spec.key, spec); };
    for (const [building, b] of Object.entries(WORKSHOP_VOICES)) {
        const pitches = night ? b.accent.pitchesNight : b.accent.pitchesDay;
        for (let v = 0; v < b.variants; v++) {
            for (let p = 0; p < pitches.length; p++) add(takeSpec(building, { kind: 'accent', pitchIndex: p, variant: v, night }));
            add(takeSpec(building, { kind: 'ghost', variant: v, night }));
            for (const voice of b.extraVoices) add(takeSpec(building, { kind: 'accent', variant: v, night, voice }));
        }
    }
    return [...out.values()];
}

// Render a take (pure): peak-normalised, trimmed 70 dB under its peak.
export function renderTake(spec, { sampleRate = WORKSHOP_BAKE_RATE } = {}) {
    const k = kit(sampleRate, rngStream(`work.take:${spec.key}`));
    const raw = RECIPES[spec.voice](k, { tone: spec.tone, hard: spec.hard, night: spec.night });
    return trimAndNormalize(raw, sampleRate);
}

function trimAndNormalize(x, sr) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (!(peak > 0)) return x;
    const floor = peak * Math.pow(10, TRIM_DB / 20);
    let last = x.length - 1;
    while (last > 0 && Math.abs(x[last]) < floor) last--;
    const fade = Math.round(TRIM_FADE_SEC * sr);
    const out = x.slice(0, Math.min(x.length, last + 1 + fade));
    const inv = 1 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    for (let i = 0; i < fade && i < out.length; i++) out[out.length - 1 - i] *= i / fade;
    return out;
}

// 4× oversampled true peak (windowed sinc, 8 taps a side).
const TP_TAPS = 8;
const TP_KERNEL = [1, 2, 3].map((p) => {
    const frac = p / 4;
    const taps = [];
    for (let j = -TP_TAPS + 1; j <= TP_TAPS; j++) {
        const u = j - frac;
        const sinc = Math.sin(Math.PI * u) / (Math.PI * u);
        taps.push([j, sinc * (0.5 + 0.5 * Math.cos(Math.PI * u / (TP_TAPS + 1)))]);
    }
    return taps;
});

// { peak, truePeak, loudSec, ringSec }: sample and true peak (linear), the
// time from onset to the last sample within 12 dB of the peak (the overlap
// guard's loud window) and to the last within 60 dB (its ring).
export function measureTake(x, sampleRate = WORKSHOP_BAKE_RATE) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    let truePeak = peak;
    const half = peak * 0.5;
    for (let i = 0; i < x.length - 1; i++) {
        if (Math.abs(x[i]) < half && Math.abs(x[i + 1]) < half) continue;
        for (const taps of TP_KERNEL) {
            let v = 0;
            for (const [j, w] of taps) { const n = i + j; if (n >= 0 && n < x.length) v += x[n] * w; }
            truePeak = Math.max(truePeak, Math.abs(v));
        }
    }
    const lastAbove = (db) => {
        const floor = peak * Math.pow(10, db / 20);
        let i = x.length - 1;
        while (i > 0 && Math.abs(x[i]) < floor) i--;
        return (i + 1) / sampleRate;
    };
    return { peak, truePeak, loudSec: lastAbove(LOUD_DB), ringSec: lastAbove(RING_DB) };
}

// ------------------------------------------------------------------ baking

const bankStates = new WeakMap();

function stateOf(bank) {
    let s = bankStates.get(bank);
    if (!s) {
        s = { meta: new Map(), queue: [], queued: new Set(), busy: false, waiters: [] };
        bankStates.set(bank, s);
    }
    return s;
}

function enqueue(bank, s, spec) {
    if (s.queued.has(spec.key) || bank.has(spec.key)) return;
    s.queued.add(spec.key);
    s.queue.push(spec);
}

// One take per idle slice (SampleBank.slice: the idle helper with a
// timeout, timed in the bank's stats); nothing waits on it.
function pump(bank, s) {
    if (s.busy || !s.queue.length) return;
    s.busy = true;
    bank.slice(() => {
        s.busy = false;
        const spec = s.queue.shift();
        if (spec) {
            s.queued.delete(spec.key);
            settle(bank, s, spec.key, bakeOne(bank, s, spec));
        }
        pump(bank, s);
    });
}

function bakeOne(bank, s, spec) {
    if (bank.has(spec.key)) return true;
    const ctx = bank.engine?.context;
    if (!ctx || typeof ctx.createBuffer !== 'function') return false;
    const data = renderTake(spec);
    const buffer = ctx.createBuffer(1, data.length, WORKSHOP_BAKE_RATE);
    buffer.copyToChannel(data, 0);
    if (!bank.adopt(spec.key, WORKSHOP_BANK_CLIENT, buffer, { pinned: false })) return false;
    s.meta.set(spec.key, { ...spec, ...measureTake(data), seconds: data.length / WORKSHOP_BAKE_RATE });
    return true;
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

// Queue the phase's takes (idempotent; call after the context runs, and
// again when night changes). Resolves true once every take is resident,
// false when any failed to render or fit, or was evicted meanwhile.
export function bakeWorkshopTakes(bank, { night = false } = {}) {
    if (!bank || typeof bank.slice !== 'function') return Promise.resolve(false);
    const s = stateOf(bank);
    const pending = workshopTakeSpecs({ night }).filter(spec => !bank.has(spec.key));
    if (!pending.length) return Promise.resolve(true);
    for (const spec of pending) enqueue(bank, s, spec);
    const all = pending.map(spec => spec.key);
    const promise = new Promise(resolve => s.waiters.push({ keys: new Set(all), all, ok: true, resolve }));
    pump(bank, s);
    return promise;
}

// The take and its measurements ({ buffer, key, voice, tone, peak,
// truePeak, loudSec, ringSec, seconds, … }), or null when it is not
// resident — then it is queued for an idle bake and the strike is skipped.
export function takeInfo(bank, building, opts = {}) {
    const spec = takeSpec(building, opts);
    if (!spec || !bank) return null;
    const buffer = bank.get(spec.key);
    const s = stateOf(bank);
    const meta = s.meta.get(spec.key);
    if (!buffer || !meta) {
        if (typeof bank.slice === 'function') {
            enqueue(bank, s, spec);
            pump(bank, s);
        }
        return null;
    }
    return { buffer, ...meta };
}

// The take's AudioBuffer, or null (see takeInfo).
export function takeFor(bank, building, opts = {}) {
    return takeInfo(bank, building, opts)?.buffer ?? null;
}

// Resident workshop takes and bytes on `bank` (diagnostics).
export function workshopBankStats(bank) {
    if (!bank) return { takes: 0, bytes: 0, queued: 0 };
    const s = bankStates.get(bank);
    let takes = 0;
    if (s) for (const key of s.meta.keys()) if (bank.has(key)) takes++;
    return { takes, bytes: bank.ledger?.clientBytes?.(WORKSHOP_BANK_CLIENT) ?? 0, queued: s?.queue.length ?? 0 };
}
