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
// This one prototypes a softer, even chirp: the shipped `_chirp` (one chirp
// at audio time `t`, gain automation on the individual's persistent voice)
// with its pulse peak at 0.7 × the voice's own and always three pulses.
// Render the baseline target without the snippet and compare the two JSON
// sidecars (LUFS-I, 4 kHz band, onsets per minute).

export async function before() {
    const { CricketsLayer } = await import('/src/presentation/shared/audio/layers/CricketsLayer.js');
    const base = CricketsLayer.prototype._chirp;
    CricketsLayer.prototype._chirp = function softerChirp(voice, t) {
        return base.call(this, { ...voice, amp: voice.amp * 0.7, pulses: 3 }, t);
    };
}

export default async function afterStart({ mark }) {
    mark('softer crickets active');
}
