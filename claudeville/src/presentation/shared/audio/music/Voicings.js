// Voicing tables (MUSL-6): who plays each seat of the band, in which
// register, at what level, in which chair of the square. The score
// (`bgm/BgmSongbook.js`) is voicing-agnostic: the sequencer maps each score
// voice to a seat (`SCORE_SEAT`) and plays it on the seat's instrument
// (`Instruments.js`). Pure; importable from Node.
//
// Two voices (D2): the Isle Band — the island's own acoustic players, the
// default — and Chip, the restored console waves, a one-click Town band
// voicing.
//
// One arrangement per (voice, keyframe, weather, season, piece), compiled
// once and memoised; the working band only admits seats. Precedence (C4):
// the keyframe row (MUSL-8, 6.8: the day coloured by instrumentation and
// register at the eight grade keyframes) → the piece's own `arrangement`
// (the Isle Band only: its players replace the row's lead, counter, engine
// and descant; the row's global `bright` and `tempoScale` still apply) →
// the season (the cadence colour) → the weather's re-dress on top (MUS-16,
// 6.9): rain and snow soften attacks and change the comp's figure (let-ring
// chords, a high glitter), a storm thins the band to a drone. A piece's
// players keep their instruments in every weather; only the keyframe rows
// (Chip, or no piece) swap colours (rain's whistle, snow's music box, a harp
// comp). At a night keyframe a piece's players then play NIGHT_BRIGHT
// darker (6.3). Chip stays keyframe-based. The sequencer applies a changed
// arrangement at the next chunk boundary and `tempoScale` only at a piece
// start.
//
// Seat fields:
//   instrument   an `INSTRUMENTS` name
//   octaveShift  semitones (whole octaves) on the written pitch; the night
//                lead plays at most at its written octave (MUSL-4: ≤ A5)
//   stemLu       the MUSL-2 stem target re the lead stem (`STEM_TARGETS`)
//   gainDb       the seat fader: stemLu + the instrument's calibration trim
//                (Instruments normalises every role phrase to one reference
//                loudness, so the trim is what the probe's stem gate measured)
//   pan, air     the seat's chair and its Island Air send (MUSL-5)
//   bright, soft note options: 1/0 = as built; lower bright darkens, soft
//                slows the attack (rain and snow)
//   figure       engine/bass: 'written' | 'sustain' (let-ring chords instead
//                of the pattern) | 'glitter' (quiet sixteenths) | 'drone'
//   kit          percussion: building voice (brush/shaker/lowTom/rim) →
//                instrument, the weather's colour (rain-stick, sleigh)
//   steps        groove only: the band's own pattern, see GROOVE_STEPS

import { PIECES } from '../bgm/BgmSongbook.js';

export const VOICES = Object.freeze(['isle', 'chip']);
export const DEFAULT_VOICE = 'isle';
// DayArc's rows, which are GradeEvaluator's GRADE_KEYFRAMES.
export const KEYFRAMES = Object.freeze(['deep-night', 'pre-dawn', 'sunrise', 'morning', 'noon', 'golden-hour', 'blue-hour', 'night']);
export const WEATHERS = Object.freeze(['clear', 'rain', 'storm', 'snow', 'fog']);
export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const BANDS = Object.freeze(['rest', 'light', 'steady', 'full']);
export const SEATS = Object.freeze(['lead', 'counter', 'bass', 'engine', 'percussion', 'descant', 'groove']);
export const PERCUSSION_VOICES = Object.freeze(['brush', 'shaker', 'lowTom', 'rim']);

// Score voice → seat.
export const SCORE_SEAT = Object.freeze({
    lead: 'lead', bell: 'lead', melody: 'lead',
    counter: 'counter', pad: 'counter', chords: 'counter',
    engine: 'engine', arp: 'engine',
    bass: 'bass',
    percussion: 'percussion', hat: 'percussion', perc: 'percussion',
    descant: 'descant',
});

// MUSL-2: the melody is the loudest stem; every admitted layer ≥ FLOOR_LU.
export const STEM_TARGETS = Object.freeze({
    lead: Object.freeze({ lu: 0, tol: 0 }),
    bass: Object.freeze({ lu: -3.5, tol: 1.5 }),
    counter: Object.freeze({ lu: -6, tol: 2 }),
    engine: Object.freeze({ lu: -8, tol: 2 }),
    descant: Object.freeze({ lu: -7, tol: 2 }),
    percussion: Object.freeze({ lu: -14, tol: 3 }),
    groove: Object.freeze({ lu: -14, tol: 3 }),
});
export const FLOOR_LU = -15;
// MUSL-4 / 6.3: the night lead never sounds above A5 (MIDI 81).
export const NIGHT_LEAD_CEILING_MIDI = 81;
// 6.3: a piece's players carry the day's 2–5 kHz into the night (they are
// the piece's, not the night row's harps and box), so at a night keyframe
// every pitched seat of a piece's arrangement plays this much darker than
// arranged, after the row and the weather: a baked player's low-pass falls
// from 12 kHz to 3.1 kHz at bright 1 (from 3.1 kHz to 1.8 kHz at an
// arranged 0.6), a live wave (fiddle, concertina, whistle) tilts two
// quarter steps (the probe's isleband gate measured 0.6 short for the
// dulcimer's and the lute's pieces). Keyframe rows (Chip, or no piece) are
// dark as written.
export const NIGHT_BRIGHT = 0.5;
// 6.3: the harp and the dulcimer carry the night's 2–5 kHz (the dulcimer
// rings at 2.8 kHz); at a night keyframe a piece's harp or dulcimer never
// plays brighter than this (a 1.6 kHz low-pass), whichever seat it holds.
export const NIGHT_DARK_BRIGHT = 0.25;
const NIGHT_DARK = new Set(['harp', 'dulcimer']);

const NIGHT_KEYS = new Set(['deep-night', 'pre-dawn', 'blue-hour', 'night']);

// C4: each piece's own Isle Band players, by piece name.
const PIECE_ARRANGEMENTS = new Map(PIECES.filter(p => p.arrangement).map(p => [p.name, p.arrangement]));

// Calibration: seat fader = stem target + trim. Keys `day:|night:` +
// `seat:instrument` first, then `seat:instrument`, then `instrument`.
// Instruments levels every instrument's role phrase at vel 1 to
// INSTRUMENT_REFERENCE_LUFS (the chip lead at today's 0.05), so a trim is
// what the probe's stem gate (`audio:probe --only musicstems`, Town band
// band 3, day pieces at noon, night pieces at 22:30) measured off target:
// the written parts are sparser or denser than the reference phrase (long
// descant notes, the night pieces' quarter-note engines, a reel's busy
// bass under the lead) and the night seats are darkened.
const TRIM_DB = Object.freeze({
    isle: Object.freeze({
        upright: -2,
        'counter:harp': 1.4,
        'descant:whistle': 1.6,
        'night:descant:harp': 4.5,
        'night:percussion:brushes': 4.4,
        // The pieces' own leads (C4), each against its band's bass, counter
        // and kit: the lute's and the dulcimer's day tunes ring over their
        // bands, the marimba's march and the concertina's reel sit under;
        // at night the darkened dulcimer's sparse tune sits far under, the
        // harp's and the fiddle's a little.
        'day:lead:lute': -2,
        'lead:dulcimer': -1,
        'day:lead:marimba': 1.5,
        'day:lead:concertina': 0.8,
        'night:lead:dulcimer': 6,
        'night:lead:harp': 1.5,
        'night:lead:fiddle': 0.8,
        // The darkened night fiddle's long counter notes.
        'night:counter:fiddle': 1.5,
        // The pieces' comps: the lute's and the dulcimer's rung arpeggios
        // and block chords ring over the reference eighths; the harp's
        // block chords and waltz by day; at night the dulcimer's waltz and
        // the marimba's quarters sit under.
        'day:engine:lute': -3.8,
        'day:engine:dulcimer': -4.8,
        'day:engine:harp': -1.5,
        'night:engine:dulcimer': 1.5,
        'night:engine:marimba': 2,
        // The fiddle's long descant notes, darkened further at night.
        'descant:fiddle': 2,
        'night:descant:fiddle': 5,
        // The full band's brushes over the workshop kit (MUSL-3: heard
        // entering at the full band).
        'groove:brushes': 1.5,
    }),
    chip: Object.freeze({
        chipBass: -0.5,
        chipArp: 1,
        'night:engine:chipArp': 3,
        'counter:chipTri': -1,
        'descant:chipPulse12': 4.5,
        // The chip kit and its full-band groove are one hat: the kit sits a
        // dB back so the groove is heard entering (MUSL-3).
        'percussion:chipHat': -1,
        'descant:chipTri': 5.7,
        'night:percussion:chipHat': 4,
    }),
});

// MUSL-1/5 chairs. Pitched seats pan at the seat (zero per-note panners).
const SEAT_PAN = Object.freeze({ lead: 0.1, counter: -0.35, bass: 0, engine: 0.38, percussion: 0.22, descant: -0.18 });
// The reed and the bow lead a little further off centre, and the descant's
// whistle and harp sit wide of the counter: the darkened night band
// narrows (the probe's isleband gate measured S/M under −16 dB at night).
const PAN_OVERRIDE = Object.freeze({
    'lead:musicBox': 0.15,
    'lead:concertina': 0.15,
    'lead:fiddle': 0.15,
    'counter:harp': -0.32,
    'engine:harp': 0.32,
    'descant:harp': -0.28,
    'descant:whistle': -0.4,
    'descant:fiddle': -0.32,
});
// Island Air sends per instrument (MUSL-1 seat sends on the ENG-6 scale:
// bass nearly dry, the music box wettest; Chip keeps the Wave-2 sends).
const AIR = Object.freeze({
    whistle: 0.18, lute: 0.2, harp: 0.28, upright: 0.05, marimba: 0.18, musicBox: 0.32,
    fiddle: 0.16, concertina: 0.14, dulcimer: 0.22,
    brushes: 0.14, brush: 0.14, shaker: 0.14, lowTom: 0.08, rim: 0.1,
    chipPulse25: 0.18, chipPulse12: 0.12, chipArp: 0, chipTri: 0.12, chipFlute: 0.22, chipBass: 0, chipHat: 0,
});

const KIT_CLEAR = Object.freeze({ brush: 'brush', shaker: 'shaker', lowTom: 'lowTom', rim: 'rim' });
// Night: no hard rim clicks under the lullaby.
const KIT_NIGHT = Object.freeze({ brush: 'brush', shaker: 'shaker', lowTom: 'lowTom', rim: 'brush' });
// Rain: the rain-stick colour — shakers and brushes, nothing struck hard.
const KIT_RAIN = Object.freeze({ brush: 'brush', shaker: 'shaker', lowTom: 'brush', rim: 'shaker' });
// Snow: a sleigh colour carried by the shaker (bells stay cue-only, S1).
const KIT_SNOW = Object.freeze({ brush: 'shaker', shaker: 'shaker', lowTom: 'brush', rim: 'shaker' });
const KIT_CHIP = Object.freeze({ brush: 'chipHat', shaker: 'chipHat', lowTom: 'chipHat', rim: 'chipHat' });

// The band's own groove seat (MUSL-3's full row: "+ brushes and a
// descant"): the workshop kit plays from the light band as the village works
// (6.9); at the full band, by day, the players' brushes join it on the song
// grid. Steps: [quarter of a beat in the bar, length in beats, velocity]
// per beats-per-bar; `brushes` swishes on notes ≥ 0.4 s and taps under that
// (MUSL-1: swish on 1 and 3, tap on 2 and 4; in 3/4 one swish a bar and in
// 6/8, whose beat is the eighth, a swish on 1 and taps on the second dotted
// quarter and its last eighth, their lone swish at full weight so the bar
// carries the 4/4 groove's level). Chip: the hat on the eighths, the
// offbeats softer.
const GROOVE_STEPS = Object.freeze({
    isle: Object.freeze({
        4: Object.freeze([[0, 1.6, 0.8], [4, 0.25, 1], [8, 1.6, 0.8], [12, 0.25, 1]].map(Object.freeze)),
        3: Object.freeze([[0, 1.6, 1], [4, 0.25, 1], [8, 0.25, 0.9]].map(Object.freeze)),
        6: Object.freeze([[0, 2.4, 1], [12, 0.5, 1], [20, 0.5, 0.9]].map(Object.freeze)),
    }),
    chip: Object.freeze({
        4: Object.freeze([0, 2, 4, 6, 8, 10, 12, 14].map(step => Object.freeze([step, 0.25, step % 4 === 0 ? 1 : 0.7]))),
        3: Object.freeze([0, 2, 4, 6, 8, 10].map(step => Object.freeze([step, 0.25, step % 4 === 0 ? 1 : 0.7]))),
        6: Object.freeze([0, 4, 8, 12, 16, 20].map(step => Object.freeze([step, 0.5, step % 12 === 0 ? 1 : 0.7]))),
    }),
});

// ── Keyframe rows (MUSL-8) ──
// Each row: seat → [instrument, octaveShift?, overrides?]; `bright` darkens
// the whole row, `tempoScale` applies at a piece start. The seat set is the
// same in every row, so each band always adds the same player.
const ISLE_TOWN = Object.freeze({
    // The box, a harp and a soft lute under it; everything dark.
    'deep-night': { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.66 }], engine: ['lute', 0, { bright: 0.6 }], descant: ['harp', 0, { bright: 0.6 }], bright: 0.75 },
    // The marimba wakes under the box.
    'pre-dawn': { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.6 }], engine: ['marimba', 0, { bright: 0.6 }], descant: ['harp', 0, { bright: 0.6 }], bright: 0.85 },
    // Whistle over harp.
    sunrise: { lead: ['whistle'], counter: ['harp'], engine: ['marimba'], descant: ['whistle'], bright: 0.9 },
    // The full day band.
    morning: { lead: ['whistle'], counter: ['lute'], engine: ['marimba'], descant: ['whistle'] },
    noon: { lead: ['whistle'], counter: ['lute'], engine: ['marimba'], descant: ['whistle'] },
    // Whistle and lute warm; the harp takes the engine; tempo ×0.9; the
    // whole band keeps its written register (MUS-13).
    'golden-hour': { lead: ['whistle', 0, { bright: 0.8 }], counter: ['lute'], engine: ['harp'], descant: ['lute'], tempoScale: 0.9 },
    // The music box and the harp enter over the lute.
    'blue-hour': { lead: ['musicBox'], counter: ['lute', 0, { bright: 0.6 }], engine: ['harp', 0, { bright: 0.6 }], descant: ['harp', 0, { bright: 0.6 }], bright: 0.9 },
    // The waltz: box over two harps, darkened (6.3: the harp carries the
    // night's 2–5 kHz; the box and the upright are dark as built).
    night: { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.5 }], engine: ['harp', 0, { bright: 0.5 }], descant: ['harp', 0, { bright: 0.5 }] },
});

// Chip restored (MUSL-2/5): pulse lead by day, the flute at its written
// octave by night (MUS-14: no pulse12 lead at night), the triangle pad.
const CHIP_TOWN = Object.freeze({
    'deep-night': { lead: ['chipFlute', 0, { bright: 0.6 }], counter: ['chipTri'], engine: ['chipTri'], descant: ['chipTri'], bright: 0.8 },
    'pre-dawn': { lead: ['chipFlute'], counter: ['chipTri'], engine: ['chipArp', 0, { bright: 0.6 }], descant: ['chipTri'], bright: 0.85 },
    sunrise: { lead: ['chipPulse25', 0, { bright: 0.85 }], counter: ['chipPulse12'], engine: ['chipArp'], descant: ['chipTri'] },
    morning: { lead: ['chipPulse25'], counter: ['chipPulse12'], engine: ['chipArp'], descant: ['chipPulse12'] },
    noon: { lead: ['chipPulse25'], counter: ['chipPulse12'], engine: ['chipArp'], descant: ['chipPulse12'] },
    'golden-hour': { lead: ['chipPulse25', 0, { bright: 0.75 }], counter: ['chipPulse12'], engine: ['chipTri'], descant: ['chipTri'], tempoScale: 0.9 },
    'blue-hour': { lead: ['chipFlute'], counter: ['chipPulse12', 0, { bright: 0.7 }], engine: ['chipTri'], descant: ['chipTri'], bright: 0.9 },
    night: { lead: ['chipFlute'], counter: ['chipTri'], engine: ['chipArp', 0, { bright: 0.7 }], descant: ['chipTri'], bright: 0.85 },
});

const ROWS = Object.freeze({ isle: ISLE_TOWN, chip: CHIP_TOWN });

// Stems per seat that differ from the default target by instrument: the
// harp engine sits at MUSL-1's harp level (−8…−9); the night percussion
// sits further back (below).
const STEM_OVERRIDE = Object.freeze({
    'engine:harp': -8.5,
});

// MUS-16 season rows: the cadence colour in the last two bars (winter's
// I → I6 rather than MUS-16's Imaj7, whose G♯ clashes with the cue roles'
// A). The players are the piece's and the keyframe's.
const SEASON_ROWS = Object.freeze({
    spring: { colourRow: 'add9' },
    summer: { colourRow: null },
    autumn: { colourRow: 'borrowedIv' },
    winter: { colourRow: 'sixth' },
});

/**
 * The arrangement weather for an atmosphere weather (`{ type }` or a type
 * string) in a season: winter precipitation falls as snow; overcast and
 * partly cloudy skies play the clear arrangement.
 */
export function arrangementWeatherFor(weather, season = 'summer') {
    const type = typeof weather === 'string' ? weather : weather?.type;
    if (type === 'rain' || type === 'storm') return season === 'winter' ? 'snow' : type;
    if (type === 'snow' || type === 'fog') return type;
    return 'clear';
}

const bandIndex = (band) => {
    if (typeof band === 'string') {
        const index = BANDS.indexOf(band);
        return index < 0 ? 2 : index;
    }
    const n = Math.round(Number(band));
    return Number.isFinite(n) ? Math.min(BANDS.length - 1, Math.max(0, n)) : 2;
};

const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);

function trimFor(voice, night, seat, instrument) {
    const table = TRIM_DB[voice];
    return table[`${night ? 'night' : 'day'}:${seat}:${instrument}`] ?? table[`${seat}:${instrument}`] ?? table[instrument] ?? 0;
}

function makeSeat(voice, night, seat, instrument, { octaveShift = 0, bright = 1, soft = 0, figure, kit, steps, stemLu } = {}) {
    const lu = stemLu ?? STEM_OVERRIDE[`${seat}:${instrument}`] ?? STEM_TARGETS[seat].lu;
    const out = {
        instrument,
        octaveShift,
        gainDb: Math.round((lu + trimFor(voice, night, seat, instrument)) * 100) / 100,
        stemLu: lu,
        pan: PAN_OVERRIDE[`${seat}:${instrument}`] ?? SEAT_PAN[seat],
        air: AIR[instrument] ?? 0,
        bright,
        soft,
    };
    if (figure) out.figure = figure;
    if (kit) out.kit = kit;
    if (steps) out.steps = steps;
    return out;
}

function compile(voice, keyframe, weather, season, pieceName) {
    const row = ROWS[voice][keyframe];
    const night = NIGHT_KEYS.has(keyframe);
    const rowBright = row.bright ?? 1;
    // C4: the piece's own players take the Isle Band's seats; the row's
    // global brightness still darkens them.
    const own = pieceName ? PIECE_ARRANGEMENTS.get(pieceName) : null;
    const specs = {};
    for (const seat of ['lead', 'counter', 'engine', 'descant']) {
        const [instrument, octaveShift = 0, over = {}] = own?.[seat] ?? row[seat];
        specs[seat] = { instrument, octaveShift, bright: rowBright * (over.bright ?? 1), soft: 0, figure: seat === 'engine' ? 'written' : undefined };
    }
    specs.bass = { instrument: voice === 'chip' ? 'chipBass' : 'upright', octaveShift: 0, bright: 1, soft: 0, figure: 'written' };
    specs.percussion = {
        instrument: voice === 'chip' ? 'chipHat' : 'brushes',
        octaveShift: 0,
        // Night: a dark, soft brushed backbeat (the Isle's brushes sit
        // in 3–5 kHz); the chip hat is a high-passed tick, left as built.
        bright: voice === 'isle' && night ? 0.4 : 1,
        soft: voice === 'isle' && night ? 0.3 : 0,
        kit: voice === 'chip' ? KIT_CHIP : night ? KIT_NIGHT : KIT_CLEAR,
        stemLu: night ? -15 : undefined,
    };
    if (!night) {
        specs.groove = {
            instrument: voice === 'chip' ? 'chipHat' : 'brushes',
            octaveShift: 0,
            bright: 1,
            soft: 0,
            steps: GROOVE_STEPS[voice],
        };
    }

    // Season: the cadence colour.
    const seasonRow = SEASON_ROWS[season];

    // Weather (MUS-16).
    let maxBand = BANDS.length - 1;
    let airAdd = 0;
    const soften = (amount, brightScale) => {
        for (const spec of Object.values(specs)) {
            spec.soft = Math.max(spec.soft, amount);
            spec.bright *= brightScale;
        }
    };
    // The keyframe rows swap colours with the weather; a piece's own players
    // keep their instruments (C4) and take only the figure, softness and air.
    const swap = !own;
    const rainLead = voice === 'isle' ? 'whistle' : 'chipFlute';
    const padEngine = voice === 'isle' ? 'harp' : 'chipTri';
    if (weather === 'rain' || weather === 'storm') {
        // Rain: a flute-like lead by day, the engine rings chords instead
        // of its pattern, shakers and brushes, softer attacks, wetter.
        if (swap && !night) specs.lead.instrument = rainLead;
        if (swap) specs.engine.instrument = padEngine;
        specs.engine.figure = 'sustain';
        if (specs.percussion && voice === 'isle') specs.percussion.kit = KIT_RAIN;
        soften(weather === 'storm' ? 0.7 : 0.5, weather === 'storm' ? 0.7 : 0.85);
        airAdd = 0.08;
        if (weather === 'storm') {
            // Storm: the tune over a bass drone and the counter, no drums.
            specs.bass.figure = 'drone';
            maxBand = Math.min(maxBand, 1);
            delete specs.percussion;
            delete specs.groove;
        }
    } else if (weather === 'snow') {
        // Snow: the music box by day at its written octave, a quiet
        // sixteenth glitter an octave up, the sleigh colour.
        if (swap) {
            if (!night) specs.lead.instrument = voice === 'isle' ? 'musicBox' : 'chipFlute';
            specs.lead.octaveShift = 0;
            specs.engine.instrument = voice === 'isle' ? 'harp' : 'chipArp';
        }
        specs.engine.octaveShift = 12;
        specs.engine.figure = 'glitter';
        specs.engine.bright *= 0.7;
        specs.engine.stemLu = -9;
        if (specs.percussion && voice === 'isle') specs.percussion.kit = KIT_SNOW;
        soften(0.4, 0.9);
        airAdd = 0.05;
    } else if (weather === 'fog') {
        // Fog: a long air and a veiled lead.
        specs.lead.bright *= 0.6;
        airAdd = 0.12;
    }
    if (night) {
        // MUSL-4: the night lead never climbs above its written octave (A5);
        // 6.3: a piece's players darken with the night (NIGHT_BRIGHT), the
        // harp and the dulcimer to NIGHT_DARK_BRIGHT at most.
        specs.lead.octaveShift = Math.min(0, specs.lead.octaveShift);
        if (own) {
            for (const seat of ['lead', 'counter', 'engine', 'descant']) {
                const spec = specs[seat];
                spec.bright *= NIGHT_BRIGHT;
                if (NIGHT_DARK.has(spec.instrument)) spec.bright = Math.min(spec.bright, NIGHT_DARK_BRIGHT);
            }
        }
    }

    const seats = {};
    for (const seat of SEATS) {
        const spec = specs[seat];
        if (!spec) continue;
        const { instrument, stemLu, ...rest } = spec;
        const built = makeSeat(voice, night, seat, instrument, { ...rest, stemLu });
        built.bright = Math.round(built.bright * 1000) / 1000;
        built.air = Math.min(0.6, Math.round((built.air + (built.air > 0 ? airAdd : 0)) * 1000) / 1000);
        seats[seat] = built;
    }

    // Band admission: rest lead + bass; light the counter and the workshop
    // percussion; steady the engine; full the descant (and the band's
    // groove by day). The seats never depend on the band.
    const order = [['lead', 'bass'], ['counter', 'percussion'], ['engine'], ['descant', 'groove']];
    const admittedByBand = [];
    let admitted = [];
    for (let b = 0; b < BANDS.length; b++) {
        if (b <= maxBand) admitted = [...admitted, ...order[b].filter(seat => seats[seat])];
        admittedByBand.push(Object.freeze(admitted));
    }

    return {
        key: `${voice}|${keyframe}|${weather}|${season}|${pieceName ?? ''}`,
        voice,
        keyframe,
        weather,
        season,
        piece: pieceName,
        night,
        maxBand,
        tempoScale: row.tempoScale ?? 1,
        colourRow: seasonRow.colourRow,
        seats: freezeAll(seats),
        admittedByBand: Object.freeze(admittedByBand),
    };
}

function freezeAll(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const inner of Object.values(value)) freezeAll(inner);
        Object.freeze(value);
    }
    return value;
}

const cache = new Map();

/**
 * The band for a moment: `{ key, voice, keyframe, weather, season, piece,
 * night, band, maxBand, tempoScale, colourRow, seats, admitted }`. `piece`
 * (a piece name) seats that piece's own Isle Band players (C4); Chip and an
 * unknown or absent piece play the keyframe row. `seats` holds every seat
 * of the arrangement (the same object for every band of one arrangement);
 * `admitted` the seats that play at `band` (0..3 or a `BANDS` name), capped
 * by the arrangement (a storm's). Unknown inputs fall back to the default
 * (isle, noon, clear, summer, steady, no piece).
 */
export function voicingFor({ voice = DEFAULT_VOICE, keyframe = 'noon', weather = 'clear', season = 'summer', band = 2, piece = null } = {}) {
    const v = pick(voice, VOICES, DEFAULT_VOICE);
    const k = pick(keyframe, KEYFRAMES, 'noon');
    const s = pick(season, SEASONS, 'summer');
    const w = WEATHERS.includes(weather) ? weather : arrangementWeatherFor(weather, s);
    const p = v === 'isle' && PIECE_ARRANGEMENTS.has(piece) ? piece : null;
    const id = `${v}|${k}|${w}|${s}|${p ?? ''}`;
    let arrangement = cache.get(id);
    if (!arrangement) {
        arrangement = compile(v, k, w, s, p);
        cache.set(id, arrangement);
    }
    const b = Math.min(bandIndex(band), arrangement.maxBand);
    const { admittedByBand, ...rest } = arrangement;
    return Object.freeze({ ...rest, band: b, admitted: admittedByBand[b] });
}
