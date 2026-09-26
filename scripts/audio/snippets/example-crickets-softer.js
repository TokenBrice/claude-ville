// Example TARGET snippet (A/B a change against a baseline target):
//
//   node scripts/audio/audio-capture.mjs layer-crickets-night \
//     --snippet scripts/audio/snippets/example-crickets-softer.js \
//     --name layer-crickets-night-softer
//
// When a snippet is combined with a catalog target, `before(api)` runs before
// the AmbientAudioController is constructed (patch prototypes here — modules
// imported from the same URL are the same instances the app uses) and the
// default export runs right after audio starts.
//
// This one prototypes a softer, sparser chirrup: the shipped `_chirrup` (a
// chirrup at audio time `t`, drawn from the layer's own seeded stream) with
// its pulse peak lowered from 0.05 to 0.035 and always three pulses. Render
// the baseline target without the snippet and compare the two JSON sidecars
// (LUFS-I, 4 kHz band, onsets per minute).

export async function before() {
    const { CricketsLayer } = await import('/src/presentation/shared/audio/layers/CricketsLayer.js');
    const { MIN_GAIN, rand } = await import('/src/presentation/shared/audio/AudioEngine.js');
    CricketsLayer.prototype._chirrup = function softerChirrup(voice, filter, t) {
        const ctx = this.engine.context;
        if (!ctx) return;
        const startAt = t;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = voice.hz * rand(this.rng, 0.98, 1.02);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(MIN_GAIN, t);
        for (let i = 0; i < 3; i++) {
            gain.gain.exponentialRampToValueAtTime(0.035, t + 0.006);
            gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.028);
            t += 0.045;
        }
        osc.connect(gain).connect(filter);
        osc.start(startAt);
        osc.stop(t + 0.05);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); } catch { /* gone */ }
        };
    };
}

export default async function afterStart({ mark }) {
    mark('softer crickets active');
}
