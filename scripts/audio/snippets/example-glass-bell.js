// Example snippet: a prototype "glass bell" arrival voice, rendered through
// the shipped engine master chain (cue bus → fade → master volume² → 6.2 kHz
// tone → limiter → destination) so its numbers compare 1:1 with the baseline
// cue renders.
//
//   node scripts/audio/audio-capture.mjs snippet \
//     --snippet scripts/audio/snippets/example-glass-bell.js --seconds 5 --offline
//
// API: default export receives
//   { context, destination, engine, modules, mark, seconds, offline }
// `destination` is the tapped/rendered output; connect there to bypass the
// shipped master chain, or to engine.cueBus / engine.ambienceBus to go through it.

export default async function glassBell({ context, engine, mark }) {
    const strike = (t, hz, pan) => {
        const out = context.createStereoPanner();
        out.pan.value = pan;
        out.connect(engine.cueBus);
        // Inharmonic glass partials with independent decays.
        for (const [ratio, gain, decay] of [[1, 0.03, 1.8], [2.76, 0.012, 0.9], [5.4, 0.005, 0.4]]) {
            const osc = context.createOscillator();
            const env = context.createGain();
            osc.frequency.value = hz * ratio;
            env.gain.setValueAtTime(0.0001, t);
            env.gain.exponentialRampToValueAtTime(gain, t + 0.004);
            env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
            osc.connect(env).connect(out);
            osc.start(t);
            osc.stop(t + decay + 0.05);
        }
    };
    const t0 = context.currentTime + 0.5;
    mark('glass A3→E4 (left)', { t: t0, kind: 'event' });
    strike(t0, 220, -0.6);
    strike(t0 + 0.22, 329.63, -0.6);
    mark('glass A3→E4 (right)', { t: t0 + 2, kind: 'event' });
    strike(t0 + 2, 220, 0.6);
    strike(t0 + 2.22, 329.63, 0.6);
}
