// The struck material palette (plan 3.1, S1; CUE-2, SOTA-5). Pure data and
// pure maths: CueKit turns a recipe into nodes, the tests read the same rows.
//
// A recipe is a modal strike: partial rows `[ratio, relGain, t60Frac,
// doubletCents]` — an oscillator at f0·ratio whose envelope rises linearly in
// `attack` to relGain and falls with T60 = D · t60Frac · Dmul; `doubletCents`
// > 0 splits the row into two sines at ±cents (a slow bloom), `doubletHz`
// (by row index) splits by ±Hz instead (a crack's roughness). `strike` is the
// transient: band-passed noise (`rel` puts its centre at f0·rel), `thud` a
// low-passed knock under it. `lp` is the voice low-pass (0 = none).
//
// Material is stratum (S1): signal bells (handbell, cracked), routine chimes
// (the four alloys), outcomes (oak, stone, iron, gold glockenspiel, the tower
// peal) and scenery (tower, glass). Civic and signal bells follow
// campanology: the tower is a major-third bell by day (tierce 1.25) and a
// minor-third bell at night (1.2); the cracked bell is a minor-third bell.

const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze([...row])));

function recipe({ D, attack, lp = 0, partials, doubletHz = null, strike = null, thud = null }) {
    return Object.freeze({
        D,
        attack,
        lp,
        partials: freezeRows(partials),
        doubletHz: doubletHz ? Object.freeze({ ...doubletHz }) : null,
        strike: strike ? Object.freeze({ ...strike }) : null,
        thud: thud ? Object.freeze({ ...thud }) : null,
    });
}

const TOWER_PARTIALS = tierce => [
    [0.5, 0.35, 1.0, 1.0], // hum
    [1, 0.8, 0.55, 1.5],   // prime
    [tierce, 0.5, 0.45, 0], // tierce: the bell's mode
    [1.5, 0.25, 0.3, 0],   // quint
    [2, 0.6, 0.35, 2.0],   // nominal
    [3, 0.2, 0.15, 0],
    [4, 0.12, 0.1, 0],
];
const TOWER_STRIKE = { hz: 0, rel: 2.2, q: 3, dur: 0.004, gain: 0.12 };
const TOWER_THUD = { lp: 800, dur: 0.012, gain: 0.08 };

const HEALED_PARTIALS = tierce => [
    [0.5, 0.3, 0.9, 1.0],
    [1, 0.9, 0.6, 1.2],
    [tierce, 0.35, 0.45, 0],
    [1.5, 0.2, 0.3, 0],
    [2, 0.5, 0.35, 1.5],
    [3, 0.12, 0.15, 0],
];

export const RECIPES = Object.freeze({
    // Routine: small chime, leather mallet — small handbell spectra
    // (1 : 2 : 3 : 4.2). Heard only through an alloy (below).
    chime: recipe({
        D: 1.4, attack: 0.004, lp: 3200,
        partials: [[1, 1.0, 1.0, 1.2], [2.0, 0.12, 0.6, 0], [3.0, 0.18, 0.45, 1.5], [4.2, 0.05, 0.25, 0]],
        strike: { hz: 1500, q: 0.7, dur: 0.005, gain: 0.045 },
    }),
    // Needs-you only: bright bronze handbell, hard clapper, long ring, dry.
    handbell: recipe({
        D: 2.2, attack: 0.0015, lp: 0,
        partials: [[1, 1.0, 1.0, 1.5], [2.0, 0.30, 0.7, 0], [3.0, 0.45, 0.5, 2.0], [4.2, 0.18, 0.3, 0], [5.4, 0.08, 0.18, 0], [6.8, 0.04, 0.1, 0]],
        strike: { hz: 3200, q: 1.8, dur: 0.003, gain: 0.12 },
    }),
    // Recovery: the error's small church bell, healed — no crack, no fracture.
    healedDay: recipe({
        D: 2.2, attack: 0.002, lp: 3200,
        partials: HEALED_PARTIALS(1.25),
        strike: { hz: 1800, q: 1, dur: 0.004, gain: 0.05 },
    }),
    healedNight: recipe({
        D: 2.2, attack: 0.002, lp: 3200,
        partials: HEALED_PARTIALS(1.2),
        strike: { hz: 1800, q: 1, dur: 0.004, gain: 0.05 },
    }),
    // Error: cracked minor-third bell. Prime split ±3.5 Hz (7 Hz beating),
    // nominal ±5 Hz; a soft fracture of noise on the attack. Its weight sits
    // in the nominal and the upper partials, so a low bell still clears the
    // 0.5–4 kHz band over music (S2 band rule).
    cracked: recipe({
        D: 4.0, attack: 0.002, lp: 3200,
        partials: [[0.5, 0.1, 0.9, 0], [1, 0.35, 0.9, 0], [1.2, 0.3, 0.6, 0], [1.5, 0.2, 0.5, 0], [2, 0.9, 0.8, 0], [3, 0.7, 0.6, 0], [4, 0.3, 0.6, 0], [5, 0.2, 0.4, 0]],
        doubletHz: { 1: 3.5, 4: 5 },
        strike: { hz: 2200, q: 3, dur: 0.08, gain: 0.04 },
    }),
    // Scenery and the release peal: the civic tower bell.
    towerDay: recipe({ D: 5.0, attack: 0.002, lp: 4200, partials: TOWER_PARTIALS(1.25), strike: TOWER_STRIKE, thud: TOWER_THUD }),
    towerNight: recipe({ D: 5.0, attack: 0.002, lp: 3600, partials: TOWER_PARTIALS(1.2), strike: TOWER_STRIKE, thud: TOWER_THUD }),
    // Gold (verified success only): glockenspiel bar, hard mallet.
    glock: recipe({
        D: 1.6, attack: 0.001, lp: 0,
        partials: [[1, 1.0, 1.0, 0], [2.76, 0.25, 0.25, 0], [5.40, 0.08, 0.1, 0]],
        strike: { hz: 5000, q: 1, dur: 0.0015, gain: 0.12 },
    }),
    // Sky (aurora, the relit lantern): glass — pure, soft attack, long.
    glass: recipe({
        D: 4.0, attack: 0.04, lp: 3500,
        partials: [[1, 1.0, 1.0, 2.0], [2.0, 0.15, 0.6, 0], [3.0, 0.04, 0.3, 0]],
    }),
    // Red (a command or push failed): dead iron clank, no ring, dry.
    iron: recipe({
        D: 0.35, attack: 0.001, lp: 1400,
        partials: [[1, 1.0, 1.0, 0], [2.76, 0.5, 0.35, 0], [5.4, 0.25, 0.15, 0]],
        thud: { lp: 600, dur: 0.015, gain: 0.35 },
    }),
    // Turn done: oak block knock.
    oak: recipe({
        D: 0.18, attack: 0.001, lp: 3000,
        partials: [[1, 1.0, 1.0, 0], [2.52, 0.35, 0.45, 0], [4.1, 0.12, 0.25, 0]],
        strike: { hz: 2000, q: 1, dur: 0.003, gain: 0.35 },
    }),
});

// The nine materials by name, resolved for a phase (tower and healed bells
// follow campanology: major third by day, minor third at night).
export const MATERIALS = Object.freeze(['chime', 'handbell', 'healed', 'cracked', 'tower', 'glock', 'glass', 'iron', 'oak']);

export function material(name, phase = 'day') {
    const night = phase === 'night';
    if (name === 'tower') return night ? RECIPES.towerNight : RECIPES.towerDay;
    if (name === 'healed') return night ? RECIPES.healedNight : RECIPES.healedDay;
    const found = RECIPES[name];
    if (!found) throw new RangeError(`Unknown material: ${name}`);
    return found;
}

// Unpitched and non-modal voices, as data: the escapement tick (rate limit),
// the stone (sub-agent return), the watchtower horn (L4, only under a call),
// the dispatch whoosh and the lantern going out (link lost).
export const ESCAPEMENT = Object.freeze({
    // Narrow (SIG-1: Q 8): a muted steel click, no bright clapper.
    click: Object.freeze({ hz: 1600, q: 8, dur: 0.006, gain: 0.4 }),
    bodySemi: 12, // A5, a 25 ms wooden body
    bodyGain: 0.9,
    bodyT60: 0.4,
    // The ritardando is in the timing; the level falls only a little.
    levels: Object.freeze([1, 0.9, 0.8]),
    air: 0.08,
});
export const STONE = Object.freeze({
    click: Object.freeze({ hz: 3400, q: 3, dur: 0.0025, gain: 1.4 }),
    modes: Object.freeze([Object.freeze([1900, 0.5]), Object.freeze([3100, 0.3])]),
    t60: 0.03,
});
export const HORN = Object.freeze({
    // A2 + E3 + a detuned A2, sawtooth, low-passed; a 1.4 s swell.
    voices: Object.freeze([Object.freeze([-24, 1, 1]), Object.freeze([-17, 0.6, 1]), Object.freeze([-24, 0.5, 1.004])]),
    lp: 700,
    rise: 0.45,
    hold: 0.9,
    end: 1.4,
});
export const WHOOSH = Object.freeze({ fromHz: 400, toHz: 2400, q: 2, sec: 0.52, peakAt: 0.45 });
export const LANTERN_OUT = Object.freeze({ fromHz: 2000, toHz: 300, q: 1.2, sec: 0.7 });

// Prime-partial peak gains per material at the 0.72 cue stage (palette `G`).
// Registry nominals (Loudness.js) are measured with these.
export const LEVELS = Object.freeze({
    chime: 0.050, healed: 0.050, handbell: 0.063, cracked: 0.100, tower: 0.050, glock: 0.036, glass: 0.030,
    iron: 0.070, oak: 0.060, tick: 0.115, stone: 0.110, horn: 0.008, whoosh: 0.05, lantern: 0.05,
});

// Provider identity: an alloy tint on the routine chime only, register fixed
// (S1, CUE-7). No alloy is bronze: none reuses the handbell's inharmonic
// 4.2 / 5.4 partials, so no provider brings a routine cue near the needs-you.
const ALLOY_TINTS = Object.freeze({
    // Claude: fired clay — hollow, dull, inharmonic.
    clay: (base) => ({
        ...base, D: 1.0, attack: 0.003, lp: 2600,
        partials: [[1, 1.0, 1.0, 0], [2.32, 0.22, 0.45, 0], [3.87, 0.10, 0.3, 0], [5.6, 0.04, 0.2, 0]],
        strike: { hz: 900, q: 1.2, dur: 0.006, gain: 0.07 },
    }),
    // Brass: harmonic, brighter and shorter.
    brass: (base) => ({
        ...base, D: base.D * 0.8,
        partials: [[1, 1.0, 1.0, 1.2], [2.0, 0.19, 0.6, 0], [3.0, 0.27, 0.45, 1.5], [4.0, 0.1, 0.25, 0]],
        strike: { ...base.strike, hz: 2500, gain: base.strike.gain * 1.6 },
    }),
    // Glass: purer and longer, no mallet.
    glass: (base) => ({
        ...base, D: base.D * 1.3, attack: 0.008,
        partials: [[1, 1.0, 1.0, 2.0], [2.0, 0.2, 0.6, 0], [4.0, 0.08, 0.3, 0]],
        strike: null,
    }),
    // Bell-metal: a small church-bell spectrum — hum and tierce under the prime.
    bellmetal: (base, night) => ({
        ...base,
        partials: [[0.5, 0.22, 1.0, 1.0], [1, 1.0, 1.0, 1.2], [night ? 1.2 : 1.25, 0.18, 0.4, 0], [2.0, 0.12, 0.6, 0], [3.0, 0.18, 0.45, 1.5]],
    }),
});
export const ALLOYS = Object.freeze(Object.keys(ALLOY_TINTS));

export function alloyForProvider(provider) {
    const k = String(provider || '').toLowerCase();
    if (k.includes('claude') || k.includes('anthropic')) return 'clay';
    if (/codex|openai|gpt|opencode|zai|glm|zhipu|deepseek/.test(k)) return 'brass';
    if (/gemini|kimi/.test(k)) return 'glass';
    return 'bellmetal';
}

const alloyCache = new Map();
// The routine chime in a provider's alloy, frozen like every recipe.
export function chimeForProvider(provider, phase = 'day') {
    const alloy = alloyForProvider(provider);
    const night = phase === 'night';
    const key = `${alloy}:${night ? 'n' : 'd'}`;
    let tinted = alloyCache.get(key);
    if (!tinted) {
        tinted = recipe(ALLOY_TINTS[alloy](RECIPES.chime, night));
        alloyCache.set(key, tinted);
    }
    return tinted;
}

/**
 * One strike of `r` at fundamental `f0`, as oscillator rows: each partial's
 * frequencies (two for a doublet), its peak gain relative to the prime and
 * its T60. Partials at or above sampleRate / 2.2 are dropped. `endSec` is how
 * long after the strike the last partial is ≥ 66 dB down (1.1 · T60).
 */
export function strikePlan(r, f0, { Dmul = 1, sampleRate = 48000 } = {}) {
    const D = r.D * Dmul;
    const partials = [];
    let endSec = 0;
    r.partials.forEach(([ratio, gain, t60Frac, cents], index) => {
        const t60 = Math.max(0.02, D * t60Frac);
        const centre = f0 * ratio;
        const splitHz = r.doubletHz?.[index];
        const freqs = splitHz
            ? [centre - splitHz, centre + splitHz]
            : cents > 0
                ? [centre * Math.pow(2, -cents / 1200), centre * Math.pow(2, cents / 1200)]
                : [centre];
        const audible = freqs.filter(hz => hz > 0 && hz < sampleRate / 2.2);
        if (!audible.length) return;
        partials.push({ ratio, freqs: audible, gain, t60 });
        endSec = Math.max(endSec, r.attack + 1.1 * t60);
    });
    const transient = r.strike
        ? { hz: r.strike.rel ? f0 * r.strike.rel : r.strike.hz, q: r.strike.q, dur: r.strike.dur, gain: r.strike.gain }
        : null;
    if (transient) endSec = Math.max(endSec, transient.dur * 6);
    if (r.thud) endSec = Math.max(endSec, r.thud.dur * 6);
    return { attack: r.attack, lp: r.lp, partials, transient, thud: r.thud, endSec };
}
