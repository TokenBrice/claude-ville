// The listener's output (plan 7.7, UX-10, SOTA-14). Pure numbers; the engine
// builds the nodes (AudioEngine.js).
//
//   speakers    the mix as made
//   headphones  placement narrowed: every voice's pan × HEADPHONE_PAN_SCALE,
//               and the world bed's side signal scaled so its interchannel
//               coherence is ≥ 0.4 (a wide decorrelated bed in one ear each
//               tires and disorients on headphones)
//   mono        the whole program folded to (L + R) / 2 in both ears before
//               the limiter, lifted by the fold compensation measured on the
//               probe's scenes, so mono is as loud as stereo (≤ 0.5 LU)
//
// Tone (Warm ↔ Bright): ±4 dB on the circadian 3 kHz shelf, which sits on
// the world and music buses only; cues, work and the held note keep their
// voice.

export const OUTPUT_MODES = Object.freeze(['speakers', 'headphones', 'mono']);
export const DEFAULT_OUTPUT = 'speakers';

export const HEADPHONE_PAN_SCALE = 0.6;
// Side gain for the world bed on headphones. The world bed's ICC on
// speakers is 0.15–0.5 (probe `noise`); with its side scaled by w, a bed of
// coherence c becomes (1 − w² + c(1 + w²)) / (1 + w² + c(1 − w²)), ≥ 0.4 for
// every c ≥ 0 at w ≤ 0.65.
export const HEADPHONE_WORLD_WIDTH = 0.6;
// Make-up for the narrowed bed: its side energy drops, ≈ 0.8 dB of the
// world bed at its measured coherence (≈ 0.45); the bed keeps its level.
export const HEADPHONE_WORLD_MAKEUP_DB = 0.8;
// Mono fold compensation (dB): what the program loses when folded to
// (L + R) / 2, measured on the probe's scenes at Wave 7 (`--only scenes
// --out`, BS.1770 LUFS-I stereo vs folded): anchor 1.37 LU (ICC 0.46),
// village busy 1.09 LU (ICC 0.55).
export const MONO_FOLD_COMP_DB = 1.2;

export const TONE_RANGE_DB = 4;
export const TONE_TAU_SEC = 0.1;

export function normalizeOutput(mode) {
    return OUTPUT_MODES.includes(mode) ? mode : DEFAULT_OUTPUT;
}

/** The stage settings of one output mode. */
export function outputSettings(mode) {
    const output = normalizeOutput(mode);
    return Object.freeze({
        output,
        panScale: output === 'headphones' ? HEADPHONE_PAN_SCALE : 1,
        worldWidth: output === 'headphones' ? HEADPHONE_WORLD_WIDTH : 1,
        worldMakeupDb: output === 'headphones' ? HEADPHONE_WORLD_MAKEUP_DB : 0,
        mono: output === 'mono',
        monoCompDb: output === 'mono' ? MONO_FOLD_COMP_DB : 0,
    });
}

/**
 * A stereo width matrix: L' = a·L + b·R, R' = b·L + a·R keeps the mid and
 * scales the side by `width` (1 = as made, 0 = mono).
 */
export function widthMatrix(width) {
    const w = Math.max(0, Math.min(1, Number(width)));
    const safe = Number.isFinite(w) ? w : 1;
    return { a: (1 + safe) / 2, b: (1 - safe) / 2 };
}

/** Coherence of a bed of coherence `icc` after its side is scaled by `width`. */
export function narrowedIcc(icc, width) {
    const w2 = width * width;
    return (1 - w2 + icc * (1 + w2)) / (1 + w2 + icc * (1 - w2));
}

/** Tone (−1…+1) → shelf dB. */
export function toneDb(tone) {
    const v = Math.max(-1, Math.min(1, Number(tone)));
    return Number.isFinite(v) ? v * TONE_RANGE_DB : 0;
}
