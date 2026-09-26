// Shared pitch vocabulary: note frequencies, the village key per phase, and
// the provider bell voicings.
//
// The village is in A — major while the sun is up, minor at night — and
// every tune in the songbook is written in it. Cues take fixed pitches from
// the key's tonic triad (`cueTones`). That keeps them in key, not out of every
// clash: over music a cue can still rub against the sounding chord, which the
// MusicClock publishes for the chord-relative cue resolver (plan 3.5).

const A4 = 440;

export function noteHz(semitonesFromA4) {
    return A4 * Math.pow(2, semitonesFromA4 / 12);
}

// The village key by phase: `{ tonicPc, mode }` (pitch classes, C = 0).
const PHASE_KEYS = Object.freeze({
    dawn: Object.freeze({ tonicPc: 9, mode: 'major' }),
    day: Object.freeze({ tonicPc: 9, mode: 'major' }),
    dusk: Object.freeze({ tonicPc: 9, mode: 'major' }),
    night: Object.freeze({ tonicPc: 9, mode: 'minor' }),
});

export function phaseKey(phase) {
    return PHASE_KEYS[phase] || PHASE_KEYS.day;
}

// The tonic triad of a key: `{ rootPc, pcs }`, root first.
export function tonicTriad({ tonicPc, mode } = PHASE_KEYS.day) {
    const third = mode === 'minor' ? 3 : 4;
    return { rootPc: tonicPc, pcs: [tonicPc, (tonicPc + third) % 12, (tonicPc + 7) % 12] };
}

function bellPartial(ratio, gain, decay) {
    return Object.freeze({ ratio, gain, decay });
}

// Provider voices keep the fundamental on the cue pitch, then add partials
// for colour: integer harmonics for the named providers (so two providers
// ringing together stay consonant), a single inharmonic 2.756 bell partial
// for the default. Register and recipe make each house recognizable without
// samples.
const BELL_VOICINGS = Object.freeze({
    default: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2.756, 0.3, 0.5),
        ]),
    }),
    claude: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.3, 0.5),
            bellPartial(4, 0.14, 0.34),
        ]),
    }),
    codex: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.22, 0.42),
            bellPartial(5, 0.1, 0.27),
        ]),
    }),
    gemini: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.24, 0.5),
            bellPartial(5, 0.1, 0.28),
        ]),
    }),
    grok: Object.freeze({
        register: 0.5,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.24, 0.44),
            bellPartial(4, 0.12, 0.32),
        ]),
    }),
    kimi: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(4, 0.2, 0.38),
            bellPartial(6, 0.08, 0.24),
        ]),
    }),
    omp: Object.freeze({
        register: 0.5,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.28, 0.5),
            bellPartial(3, 0.16, 0.4),
        ]),
    }),
    opencode: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(4, 0.18, 0.36),
            bellPartial(5, 0.1, 0.27),
        ]),
    }),
    deepseek: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.2, 0.43),
            bellPartial(6, 0.08, 0.24),
        ]),
    }),
    zai: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.26, 0.48),
            bellPartial(6, 0.09, 0.25),
        ]),
    }),
});

function providerFamily(provider) {
    const key = String(provider || '').toLowerCase();
    if (key.includes('deepseek')) return 'deepseek';
    if (key.includes('zai') || key.includes('glm') || key.includes('zhipu')) return 'zai';
    if (key.includes('opencode')) return 'opencode';
    if (key === 'omp' || key.includes('open-model')) return 'omp';
    if (key.includes('codex') || key.includes('openai') || key.includes('gpt')) return 'codex';
    if (key.includes('gemini')) return 'gemini';
    if (key.includes('grok')) return 'grok';
    if (key.includes('kimi')) return 'kimi';
    if (key.includes('claude') || key.includes('anthropic')) return 'claude';
    return 'default';
}

export function bellVoicingForProvider(provider) {
    return BELL_VOICINGS[providerFamily(provider)] || BELL_VOICINGS.default;
}

// The cue pitch set of a triad `{ rootPc, pcs }` in the register the cues
// were written in: the root sits at or above A (A2, A3, A4 for the tonic).
// The chord-relative resolver of plan 3.5 grows from here.
export function chordCueTones({ rootPc, pcs }) {
    const root = (((rootPc - 9) % 12) + 12) % 12;
    const third = pcs.includes((rootPc + 3) % 12) && !pcs.includes((rootPc + 4) % 12) ? 3 : 4;
    return {
        low: noteHz(root - 24),
        root: noteHz(root - 12),
        third: noteHz(root - 12 + third),
        fifth: noteHz(root - 5),
        octave: noteHz(root),
        high: noteHz(root + third),
    };
}

// One-shot cue pitches for a phase: the tonic triad of the phase key — A2,
// A3, C♯4 (C4 at night), E4, A4, C♯5 (C5).
export function cueTones(phase) {
    return chordCueTones(tonicTriad(phaseKey(phase)));
}
