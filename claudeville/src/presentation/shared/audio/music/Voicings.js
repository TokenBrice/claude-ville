// Voicing tables (MUSL-6): which instrument plays each score voice, in which
// seat, at what level. The score (`bgm/BgmSongbook.js`) is voicing-agnostic;
// the sequencer looks every note up here. A voicing has one table per preset
// (Town band, Village): the same band seated for a stage or for a square.
//
// `chip` is the only voicing for now: the console timbres the village has
// always had, with the Wave-0 fixes (night flute lead, bass held to the next
// root, MUSL-2 stem gains) and the Wave-1 seats. Its lead and counter seats
// send into the Island Air, which replaced the per-voice feedback echo
// (ENG-6 table: lead 0.18, counter 0.12; bass, arp and hats stay dry).
//
// Seat:  `{ filter: [type, hz], pan, air? }` — one persistent bus per seat.
// Voice: `{ seat, timbre?, gain, env, attack?, release?, transpose?,
//          length: { scale, min }, vibrato? }`
//   env 'hold'  — exponential attack, hold, exponential release;
//   env 'pluck' — 8 ms attack, exponential decay over the note;
//   env 'swell' — slow setTarget swell and a 7τ tail (the night pad);
//   env 'tick'  — a noise hat (4 ms up, 35 ms down).
//   length — sounding seconds = max(min, beats · beatSec · scale).
//   vibrato — on notes of ≥ minBeats written beats that sound > minSec.

const freezeAll = (value) => {
    if (value && typeof value === 'object') {
        for (const inner of Object.values(value)) freezeAll(inner);
        Object.freeze(value);
    }
    return value;
};

export const VOICINGS = freezeAll({
    chip: {
        townBand: {
            seats: {
                lead: { filter: ['lowpass', 2800], pan: 0.1, air: 0.18 },
                counter: { filter: ['lowpass', 1800], pan: -0.35, air: 0.12 },
                arp: { filter: ['lowpass', 1800], pan: 0.38 },
                bass: { filter: ['lowpass', 800], pan: 0 },
                perc: { filter: ['highpass', 3500], pan: 0.22 },
            },
            voices: {
                lead: {
                    seat: 'lead', timbre: 'pulse25', gain: 0.05, env: 'hold', attack: 0.012, release: 0.05,
                    length: { scale: 0.9, min: 0 },
                    vibrato: { minBeats: 2, minSec: 0.6, rate: 5.4, cents: 8, rise: 0.3 },
                },
                // The night lead: a music box, a flute strike an octave up
                // with a long natural decay.
                bell: {
                    seat: 'lead', timbre: 'flute', gain: 0.042, env: 'pluck', transpose: 12,
                    length: { scale: 1, min: 1.4 },
                },
                counter: {
                    seat: 'counter', timbre: 'pulse12', gain: 0.027, env: 'hold', attack: 0.012, release: 0.05,
                    length: { scale: 0.95, min: 0 },
                },
                arp: { seat: 'arp', timbre: 'pulse12', gain: 0.051, env: 'pluck', length: { scale: 1, min: 0 } },
                pad: { seat: 'counter', timbre: 'triangle', gain: 0.007, env: 'swell', length: { scale: 1, min: 0 } },
                bass: {
                    seat: 'bass', timbre: 'triangle', gain: 0.022, env: 'hold', attack: 0.012, release: 0.05,
                    length: { scale: 0.92, min: 0 },
                },
                hat: { seat: 'perc', noise: 'white', gain: 0.005, env: 'tick', accent: 1.4 },
            },
        },
        village: {
            seats: {
                melody: { filter: ['lowpass', 2600], pan: 0.1, air: 0.18 },
                chords: { filter: ['lowpass', 1700], pan: -0.35, air: 0.12 },
                arp: { filter: ['lowpass', 1700], pan: 0.38 },
                bass: { filter: ['lowpass', 800], pan: 0 },
            },
            voices: {
                // The timbre is the tune's (`lead` / `leadAlt`), carried on the note.
                melody: {
                    seat: 'melody', gain: 0.042, env: 'hold', attack: 0.015, release: 0.07,
                    length: { scale: 0.92, min: 0.05 },
                    vibrato: { minBeats: 1.5, minSec: 0.5, rate: 5.2, cents: 9, rise: 0.35 },
                },
                bass: {
                    seat: 'bass', timbre: 'triangle', gain: 0.055, env: 'hold', attack: 0.015, release: 0.07,
                    length: { scale: 0.99, min: 0.05 },
                },
                arp: { seat: 'arp', timbre: 'pulse12', gain: 0.015, env: 'pluck', length: { scale: 0.92, min: 0.05 } },
                chords: { seat: 'chords', timbre: 'pulse12', gain: 0.012, env: 'pluck', length: { scale: 0.92, min: 0.05 } },
            },
        },
    },
});

export const DEFAULT_VOICING = 'chip';

export function voicingFor(name, preset) {
    const voicing = VOICINGS[name] || VOICINGS[DEFAULT_VOICING];
    const table = voicing[preset];
    if (!table) throw new Error(`voicing ${name} has no ${preset} table`);
    return table;
}
