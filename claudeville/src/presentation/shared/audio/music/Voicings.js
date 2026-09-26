// Voicing tables (MUSL-6): who plays each seat of the band, in which
// register, at what level, in which chair of the square. The score
// (`bgm/BgmSongbook.js`) is voicing-agnostic: the sequencer maps each score
// voice to a seat (`SCORE_SEAT`) and plays it on the seat's instrument
// (`Instruments.js`). Pure; importable from Node.
//
// Two voices (D2): the Isle Band — the island's own acoustic players, the
// default in both presets — and Chip, the restored console waves, a one-click
// Town band voicing. Village is always the Isle Band.
//
// One arrangement per (voice, mode, keyframe, weather, season), compiled once
// and memoised; the working band only admits seats. The day is coloured by
// instrumentation and register at the eight grade keyframes (MUSL-8, 6.8);
// the weather and the season re-dress the same tunes (MUS-16, 6.9): rain and
// snow soften attacks and swap colours, a storm thins the band to a drone.
// The sequencer applies a changed arrangement at the next chunk boundary and
// `tempoScale` only at a piece start.
//
// Seat fields:
//   instrument   an `INSTRUMENTS` name
//   octaveShift  semitones (whole octaves) on the written pitch; the night
//                lead plays at its written octave (MUSL-4: ≤ A5)
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

export const VOICES = Object.freeze(['isle', 'chip']);
export const DEFAULT_VOICE = 'isle';
export const MODES = Object.freeze(['townBand', 'village']);
// DayArc's rows, which are GradeEvaluator's GRADE_KEYFRAMES.
export const KEYFRAMES = Object.freeze(['deep-night', 'pre-dawn', 'sunrise', 'morning', 'noon', 'golden-hour', 'blue-hour', 'night']);
export const WEATHERS = Object.freeze(['clear', 'rain', 'storm', 'snow', 'fog']);
export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const BANDS = Object.freeze(['rest', 'light', 'steady', 'full']);
export const SEATS = Object.freeze(['lead', 'counter', 'bass', 'engine', 'percussion', 'descant', 'groove']);
export const PERCUSSION_VOICES = Object.freeze(['brush', 'shaker', 'lowTom', 'rim']);

// Score voice → seat, for both the Town band pieces and the fragments.
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

const NIGHT_KEYS = new Set(['deep-night', 'pre-dawn', 'blue-hour', 'night']);
const DAY_KEYS = new Set(['sunrise', 'morning', 'noon', 'golden-hour']);

// Calibration: seat fader = stem target + trim. Keys `day:|night:` +
// `seat:instrument` first, then `seat:instrument`, then `instrument`.
// Instruments levels every instrument's role phrase at vel 1 to
// INSTRUMENT_REFERENCE_LUFS (the chip lead at today's 0.05), so a trim is
// what the probe's stem gate (`audio:probe --only musicstems`, Town band
// band 3, day pieces at noon, night pieces at 22:30) measured off target:
// the written parts are sparser or denser than the reference phrase (long
// descant notes, the night pieces' quarter-note engines) and the night
// seats are darkened.
const TRIM_DB = Object.freeze({
    isle: Object.freeze({
        upright: -2,
        'counter:harp': 1.4,
        'descant:whistle': 1.6,
        'night:descant:harp': 4.5,
        'night:percussion:brushes': 4.4,
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
const PAN_OVERRIDE = Object.freeze({
    'lead:musicBox': 0.15,
    'counter:harp': -0.32,
    'engine:harp': 0.32,
});
// Island Air sends per instrument (MUSL-1 seat sends on the ENG-6 scale:
// bass nearly dry, the music box wettest; Chip keeps the Wave-2 sends).
const AIR = Object.freeze({
    whistle: 0.18, lute: 0.2, harp: 0.28, upright: 0.05, marimba: 0.18, musicBox: 0.32,
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
// grid. Steps: [sixteenth in the bar, length in beats, velocity] per
// beats-per-bar; `brushes` swishes on notes ≥ 0.4 s and taps under that
// (MUSL-1: swish on 1 and 3, tap on 2 and 4). Chip: the hat on the eighths,
// the offbeats softer.
const GROOVE_STEPS = Object.freeze({
    isle: Object.freeze({
        4: Object.freeze([[0, 1.6, 0.8], [4, 0.25, 1], [8, 1.6, 0.8], [12, 0.25, 1]].map(Object.freeze)),
        3: Object.freeze([[0, 1.6, 0.8], [4, 0.25, 1], [8, 0.25, 0.9]].map(Object.freeze)),
    }),
    chip: Object.freeze({
        4: Object.freeze([0, 2, 4, 6, 8, 10, 12, 14].map(step => Object.freeze([step, 0.25, step % 4 === 0 ? 1 : 0.7]))),
        3: Object.freeze([0, 2, 4, 6, 8, 10].map(step => Object.freeze([step, 0.25, step % 4 === 0 ? 1 : 0.7]))),
    }),
});

// ── Keyframe rows (MUSL-8) ──
// Each row: seat → [instrument, octaveShift?, overrides?]; `maxBand` caps
// the working band (Village only: the busker never streams a full band in
// the small hours), `tempoScale` at a piece start. The seat set is the same
// in every row, so each band always adds the same player.
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

// Village: the busker (MUSL-7) — lute tune, darkened harp comp, upright.
// Deep night is the box alone, pre-dawn the box over a harp.
const ISLE_VILLAGE = Object.freeze({
    'deep-night': { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.6 }], engine: ['harp'], descant: ['harp'], bright: 0.75, maxBand: 0 },
    'pre-dawn': { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.6 }], engine: ['harp'], descant: ['harp'], bright: 0.85, maxBand: 1 },
    // The dawn occasion: whistle over harp, growing to the full band.
    sunrise: { lead: ['whistle'], counter: ['harp', 0, { bright: 0.7 }], engine: ['harp'], descant: ['lute'], tempoScale: 0.9 },
    // The busker's lute through MUSL's 2.8 kHz low-pass (LP = 800·15^bright).
    morning: { lead: ['lute', 0, { bright: 0.46 }], counter: ['harp', 0, { bright: 0.7 }], engine: ['marimba'], descant: ['whistle'] },
    noon: { lead: ['lute', 0, { bright: 0.46 }], counter: ['harp', 0, { bright: 0.7 }], engine: ['marimba'], descant: ['whistle'] },
    'golden-hour': { lead: ['whistle', 0, { bright: 0.8 }], counter: ['lute'], engine: ['harp'], descant: ['lute'], tempoScale: 0.85 },
    'blue-hour': { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.7 }], engine: ['lute', 0, { bright: 0.7 }], descant: ['harp'], bright: 0.9, maxBand: 2 },
    night: { lead: ['musicBox'], counter: ['harp', 0, { bright: 0.7 }], engine: ['harp'], descant: ['harp'], bright: 0.85, maxBand: 2 },
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

const ROWS = Object.freeze({
    isle: Object.freeze({ townBand: ISLE_TOWN, village: ISLE_VILLAGE }),
    chip: Object.freeze({ townBand: CHIP_TOWN }),
});

// Stems per seat that differ from the default target by instrument: the
// harp engine sits at MUSL-1's harp level (−8…−9); the night percussion
// sits further back (below).
const STEM_OVERRIDE = Object.freeze({
    'engine:harp': -8.5,
});

// MUS-16 season rows: the cadence colour in the last two bars (winter's
// I → I6 rather than MUS-16's Imaj7, whose G♯ clashes with the cue roles'
// A) and, by day, the lead seat (SOTA-17 as adjudicated by MUSL: spring
// whistle, autumn marimba, winter music box; summer keeps each mode's own
// lead).
const SEASON_ROWS = Object.freeze({
    spring: { colourRow: 'add9', dayLead: { isle: 'whistle' } },
    summer: { colourRow: null, dayLead: {} },
    autumn: { colourRow: 'borrowedIv', dayLead: { isle: 'marimba' } },
    winter: { colourRow: 'sixth', dayLead: { isle: 'musicBox', chip: 'chipFlute' } },
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

function compile(voice, mode, keyframe, weather, season) {
    const row = ROWS[voice][mode][keyframe];
    const night = NIGHT_KEYS.has(keyframe);
    const rowBright = row.bright ?? 1;
    const specs = {};
    for (const seat of ['lead', 'counter', 'engine', 'descant']) {
        const [instrument, octaveShift = 0, over = {}] = row[seat];
        specs[seat] = { instrument, octaveShift, bright: rowBright * (over.bright ?? 1), soft: 0, figure: seat === 'engine' ? 'written' : undefined };
    }
    specs.bass = { instrument: voice === 'chip' ? 'chipBass' : 'upright', octaveShift: 0, bright: 1, soft: 0, figure: 'written' };
    const percussion = mode === 'townBand';
    if (percussion) {
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
    }

    // Season: the day lead and the cadence colour.
    const seasonRow = SEASON_ROWS[season];
    const dayLead = DAY_KEYS.has(keyframe) && seasonRow.dayLead[voice];
    if (dayLead && dayLead !== specs.lead.instrument) {
        const displaced = specs.lead.instrument;
        specs.lead.instrument = dayLead;
        // A marimba lead hands the engine to the harp; a music box lead
        // keeps its written octave like the night box.
        if (specs.engine.instrument === dayLead) specs.engine.instrument = voice === 'isle' ? 'harp' : 'chipTri';
        if (specs.descant.instrument === dayLead) specs.descant.instrument = displaced;
    }

    // Weather (MUS-16).
    let maxBand = row.maxBand ?? BANDS.length - 1;
    let airAdd = 0;
    const soften = (amount, brightScale) => {
        for (const spec of Object.values(specs)) {
            spec.soft = Math.max(spec.soft, amount);
            spec.bright *= brightScale;
        }
    };
    const rainLead = voice === 'isle' ? 'whistle' : 'chipFlute';
    const padEngine = voice === 'isle' ? 'harp' : 'chipTri';
    if (weather === 'rain' || weather === 'storm') {
        // Rain: a flute-like lead by day, the engine rings chords instead
        // of its pattern, shakers and brushes, softer attacks, wetter.
        if (!night) specs.lead.instrument = rainLead;
        specs.engine.instrument = padEngine;
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
        if (!night) specs.lead.instrument = voice === 'isle' ? 'musicBox' : 'chipFlute';
        specs.lead.octaveShift = 0;
        specs.engine.instrument = voice === 'isle' ? 'harp' : 'chipArp';
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

    // Band admission: rest lead + bass; light the counter (and the
    // workshop percussion in Town band); steady the engine; full the
    // descant (and the band's groove by day). The seats never depend on the
    // band.
    const order = [['lead', 'bass'], ['counter', 'percussion'], ['engine'], ['descant', 'groove']];
    const admittedByBand = [];
    let admitted = [];
    for (let b = 0; b < BANDS.length; b++) {
        if (b <= maxBand) admitted = [...admitted, ...order[b].filter(seat => seats[seat])];
        admittedByBand.push(Object.freeze(admitted));
    }

    return {
        key: `${voice}|${mode}|${keyframe}|${weather}|${season}`,
        voice,
        mode,
        keyframe,
        weather,
        season,
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
 * The band for a moment: `{ key, voice, mode, keyframe, weather, season,
 * night, band, maxBand, tempoScale, colourRow, seats, admitted }`. `seats`
 * holds every seat of the arrangement (the same object for every band of
 * one arrangement); `admitted` the seats that play at `band` (0..3 or a
 * `BANDS` name), capped by the arrangement. Chip is a Town band voicing:
 * Village always plays the Isle Band. Unknown inputs fall back to the
 * default (isle, townBand, noon, clear, summer, steady).
 */
export function voicingFor({ voice = DEFAULT_VOICE, mode = 'townBand', keyframe = 'noon', weather = 'clear', season = 'summer', band = 2 } = {}) {
    const m = pick(mode, MODES, 'townBand');
    const v = m === 'village' ? 'isle' : pick(voice, VOICES, DEFAULT_VOICE);
    const k = pick(keyframe, KEYFRAMES, 'noon');
    const s = pick(season, SEASONS, 'summer');
    const w = WEATHERS.includes(weather) ? weather : arrangementWeatherFor(weather, s);
    const id = `${v}|${m}|${k}|${w}|${s}`;
    let arrangement = cache.get(id);
    if (!arrangement) {
        arrangement = compile(v, m, k, w, s);
        cache.set(id, arrangement);
    }
    const b = Math.min(bandIndex(band), arrangement.maxBand);
    const { admittedByBand, ...rest } = arrangement;
    return Object.freeze({ ...rest, band: b, admitted: admittedByBand[b] });
}
