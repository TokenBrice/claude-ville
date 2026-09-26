// Wall-clock view of a tapped capture, and the cue-over-bed margin on it.
// Pure Node, no dependencies; used by probe.mjs.

// Lay a tapped capture on the page's wall clock. `chunkTimes` lists each
// recorder chunk as [audio-clock frame, frames, main-thread arrival ms], in
// PCM order (init.js `__harTap.collect()`). The arrival lag (arrival − audio
// time) is smallest when the message was not delayed, so each chunk takes the
// minimum lag over the next `lookaheadSec` of arrivals: message delays are
// transient, clock drift is slow, and a suspension raises the lag for good.
// Wall time the context did not render stays zero — silence, which is what
// the listener heard. Returns seconds relative to `wall0` (arrival clock, s).
export function wallTimeline({ sampleRate: sr, chunkTimes }, pcm, { lookaheadSec = 2 } = {}) {
    const chunks = chunkTimes.map(([frame, frames, wall]) => ({ frame, frames, wall: wall / 1000 }));
    if (!chunks.length) return { L: new Float32Array(0), R: new Float32Array(0), sr, wall0: 0, chunks };
    for (const c of chunks) c.lag = c.wall - (c.frame + c.frames) / sr;
    for (let i = 0; i < chunks.length; i++) {
        let lag = Infinity;
        for (let j = i; j < chunks.length && chunks[j].wall <= chunks[i].wall + lookaheadSec; j++) lag = Math.min(lag, chunks[j].lag);
        chunks[i].start = chunks[i].frame / sr + lag;
    }
    const wall0 = chunks[0].start;
    let n = 0;
    for (const c of chunks) n = Math.max(n, Math.round((c.start - wall0) * sr) + c.frames);
    const L = new Float32Array(n), R = new Float32Array(n);
    let src = 0;
    for (const c of chunks) {
        const dst = Math.round((c.start - wall0) * sr);
        L.set(pcm.L.subarray(src, src + c.frames), dst);
        R.set(pcm.R.subarray(src, src + c.frames), dst);
        src += c.frames;
    }
    return { L, R, sr, wall0, chunks };
}

// Cue vs the bed before it. `momentary` is [[blockEnd s, LUFS], ...] (400 ms
// blocks, analyze.mjs `loudness().momentaryCurve`). The cue is the max over
// blocks centred in [t, t + cueWindowSec]; the bed is the energy mean of the
// blocks that end inside (t − bedWindowSec, t], silence counted as zero
// energy, floored at `silenceFloorLufs` so a cue over pure silence scores
// against that floor rather than −∞.
export function marginAt(momentary, t, { bedWindowSec, cueWindowSec, silenceFloorLufs }) {
    let cueMax = -Infinity, preE = 0, preN = 0;
    for (const [end, v] of momentary) {
        const center = end - 0.2;
        if (center >= t && center <= t + cueWindowSec) cueMax = Math.max(cueMax, v);
        if (end > t - bedWindowSec && end <= t) {
            preE += Number.isFinite(v) ? Math.pow(10, (v + 0.691) / 10) : 0;
            preN++;
        }
    }
    const bed = preN && preE > 0 ? -0.691 + 10 * Math.log10(preE / preN) : -Infinity;
    return {
        cueMax,
        bed,
        margin: Number.isFinite(cueMax) ? cueMax - Math.max(bed, silenceFloorLufs) : -Infinity,
    };
}
