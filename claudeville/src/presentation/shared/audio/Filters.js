// Honest filters (ENG-16, plan S8). Web Audio's lowpass/highpass `Q` is a
// resonance in dB, not the textbook linear Q, so a "gentle" Q of 0.4 written
// as a raw number is really a +0.4 dB resonance (a slightly peaked filter)
// where the author meant linear 0.4 (−8 dB in Web Audio terms). Every biquad
// in audio code is made here, so a Q always means what its author wrote:
//   lowpass / highpass        q: 'butterworth' (0.7071, flat, −3 dB at fc),
//                             'gentle' (0.5, no peak), or a linear number;
//                             converted to dB (20·log10 q).
//   bandpass / peaking /
//   notch / allpass           q: linear, passed through ('butterworth' and
//                             'gentle' name the same linear values).
//   lowshelf / highshelf      Q ignored; `gain` in dB.

export const Q_BUTTERWORTH = Math.SQRT1_2;
export const Q_GENTLE = 0.5;

const DB_Q_TYPES = new Set(['lowpass', 'highpass']);
const GAIN_TYPES = new Set(['peaking', 'lowshelf', 'highshelf']);
const SHELF_TYPES = new Set(['lowshelf', 'highshelf']);

function linearQ(q) {
    if (q === 'butterworth') return Q_BUTTERWORTH;
    if (q === 'gentle') return Q_GENTLE;
    const n = Number(q);
    if (!Number.isFinite(n) || n <= 0) throw new RangeError(`Invalid filter Q: ${q}`);
    return n;
}

export function makeFilter(ctx, type, hz, { q = 'butterworth', gain = 0 } = {}) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = hz;
    if (DB_Q_TYPES.has(type)) {
        filter.Q.value = 20 * Math.log10(linearQ(q));
    } else if (!SHELF_TYPES.has(type)) {
        filter.Q.value = linearQ(q);
    }
    if (GAIN_TYPES.has(type)) filter.gain.value = gain;
    return filter;
}
