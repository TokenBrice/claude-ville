// Small DSP kernels shared by the metric libraries (pure Node): an in-place
// radix-2 FFT, RBJ biquads run over a whole signal, the mid channel and the
// biquad magnitude response.

// In-place radix-2 FFT of (re, im); `inverse` scales by 1/n.
export function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inverse ? 2 : -2) * Math.PI / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
}

// RBJ biquad over a whole signal. type: 'lp' | 'hp' | 'bp' (0 dB peak).
export function biquad(x, type, f0, fs, Q = Math.SQRT1_2) {
    const w = 2 * Math.PI * f0 / fs;
    const c = Math.cos(w);
    const a = Math.sin(w) / (2 * Q);
    let b0;
    let b1;
    let b2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'bp') { b0 = a; b1 = 0; b2 = -a; }
    else throw new Error(`biquad type ${type}`);
    const a0 = 1 + a;
    const a1 = -2 * c;
    const a2 = 1 - a;
    const y = new Float64Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}

export function midOf(L, R) {
    const m = new Float64Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
    return m;
}

// |H(e^jw)|² of a normalised biquad [b0, b1, b2, a1, a2].
export function biquadMag2([b0, b1, b2, a1, a2], w) {
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2;
    const ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2;
    const di = -(a1 * s1 + a2 * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
}

// Welch PSD summed over the given channels, Hann `n`, `overlap` hop fraction.
export function welch(channels, { n = 8192, hop = n / 2, start = 0, end = channels[0].length } = {}) {
    const psd = new Float64Array(n / 2 + 1);
    const win = hann(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let frames = 0;
    for (let s = Math.max(0, start); s + n <= end; s += hop) {
        for (const ch of channels) {
            for (let i = 0; i < n; i++) { re[i] = ch[s + i] * win[i]; im[i] = 0; }
            fft(re, im);
            for (let k = 0; k <= n / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
        }
        frames++;
    }
    for (let k = 0; k <= n / 2; k++) psd[k] /= Math.max(1, frames);
    return psd;
}

export const round = (x, d = 1) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
