// The listener's output (plan 7.7, UX-10). Pure numbers; the engine builds
// the nodes (AudioEngine.js).
//
//   speakers    the mix as made
//   headphones  placement narrowed: every voice's pan × HEADPHONE_PAN_SCALE
//   mono        the whole program folded to (L + R) / 2 in both ears before
//               the limiter, lifted by the fold compensation measured on the
//               probe's scenes, so mono is as loud as stereo (≤ 0.5 LU)

export const OUTPUT_MODES = Object.freeze(['speakers', 'headphones', 'mono']);
export const DEFAULT_OUTPUT = 'speakers';

export const HEADPHONE_PAN_SCALE = 0.6;
// Mono fold compensation (dB): what the program loses when folded to
// (L + R) / 2, measured on the probe's `listening` scene (the Town band
// with an arrival and a needs-you; BS.1770 LUFS-I stereo vs folded): the
// v0.47.1 band folds with 0.13 LU lost (its seats pan inside ±0.4 and its
// S/M sits near −14 dB), 0.23 LU through the engine's limiter (mono at
// 1.2 dB read +0.97 LU over speakers); Signals' cues fold to −0.15. The
// Village's wide world beds, which lost 1.1–1.4 LU, are gone.
export const MONO_FOLD_COMP_DB = 0.2;

export const WIDTH_TAU_SEC = 0.1;

export function normalizeOutput(mode) {
    return OUTPUT_MODES.includes(mode) ? mode : DEFAULT_OUTPUT;
}

/** The stage settings of one output mode. */
export function outputSettings(mode) {
    const output = normalizeOutput(mode);
    return Object.freeze({
        output,
        panScale: output === 'headphones' ? HEADPHONE_PAN_SCALE : 1,
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
