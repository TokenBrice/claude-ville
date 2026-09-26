// The day arc and the seasons as one table (plan 4.5; AMB-11, AMB-12).
//
// One row per C2 grade keyframe (GradeEvaluator.GRADE_KEYFRAMES): the world
// stratum is interpolated between the same two keys, with the same eased
// weight and the same seasonal sunrise/sunset shifts, as the picture. The
// director's 1 Hz tick reads it; layers get levels and rates, never phase
// names. Weather physics stay in the layers and the director's weather law;
// this table owns place and time only. Pure; importable from Node.
//
// Row fields (level fields are each layer's own linear `setLevel` scale):
//   sea       SeaLayer level (0.65 ≈ A − 4 on a clear day, AMB-1: ground by
//             day, forward by night)
//   wind      diurnal factor on the weather's breeze (nights are stiller)
//   birds     BirdsLayer loudness (the density is `rates`)
//   rates     phrases per minute by species (BirdsLayer.setCast), before
//             season and weather; the owl is the night's one voice
//   crickets  chorus level before season and weather (AMB-8 edges fall out
//             of the blue-hour → night → deep-night → pre-dawn keys)
//   dark      murmur darkness (4.7): 0 day … 1 night, never a level cut
//
// Night is darker and quieter than day (Decisions): no songbirds, a stiller
// wind and a sea only +1…+2 dB forward, so the crickets are its 2–5 kHz.

import { gradeKeysAt } from '../../character-mode/GradeEvaluator.js';
import { seasonShiftFor } from '../../character-mode/AtmosphereState.js';
import { clamp01 } from './AudioEngine.js';

export const ARC_SPECIES = Object.freeze(['blackbird', 'robin', 'sparrow', 'wren', 'dove', 'owl']);
const SONGBIRDS = ARC_SPECIES.filter(name => name !== 'owl');

const row = ({ rates = {}, ...levels }) => Object.freeze({
    ...levels,
    rates: Object.freeze(Object.fromEntries(ARC_SPECIES.map(name => [name, rates[name] ?? 0]))),
});

// AMB-11's cast and rates (AMB-7): dawn 26/min (blackbird .4, robin .3,
// wren .18, sparrow .12), day 5/min (sparrow .4, dove .22, blackbird .2,
// wren .18), dusk 5/min (blackbird .55, robin .25, dove .2), night owl 0.9.
export const DAY_ARC = Object.freeze({
    'deep-night': row({ sea: 0.86, wind: 0.45, birds: 0.5, rates: { owl: 0.5 }, crickets: 0.3, dark: 1 }),
    'pre-dawn': row({ sea: 0.68, wind: 0.5, birds: 0.25, rates: { robin: 3, blackbird: 2, owl: 0.2 }, crickets: 0.06, dark: 0.85 }),
    sunrise: row({ sea: 0.65, wind: 0.75, birds: 0.14, rates: { blackbird: 10.4, robin: 7.8, wren: 4.7, sparrow: 3.1 }, crickets: 0, dark: 0.25 }),
    morning: row({ sea: 0.65, wind: 0.9, birds: 0.25, rates: { sparrow: 4, blackbird: 2.6, robin: 1.6, wren: 1.9, dove: 1.9 }, crickets: 0, dark: 0 }),
    noon: row({ sea: 0.65, wind: 1, birds: 0.3, rates: { sparrow: 2, dove: 1.1, blackbird: 1, wren: 0.9 }, crickets: 0, dark: 0 }),
    'golden-hour': row({ sea: 0.66, wind: 0.9, birds: 0.3, rates: { blackbird: 2.75, robin: 1.25, dove: 1 }, crickets: 0, dark: 0.15 }),
    'blue-hour': row({ sea: 0.7, wind: 0.7, birds: 0.25, rates: { blackbird: 1.2, robin: 0.8, owl: 0.3 }, crickets: 0.2, dark: 0.6 }),
    night: row({ sea: 0.9, wind: 0.5, birds: 0.5, rates: { owl: 0.9 }, crickets: 0.6, dark: 1 }),
});

// Season modifiers (AMB-11): songbird density, the cricket chorus, a wind
// floor and the winter swell. Winter keeps only the robin (at a quarter of
// the chorus) and no crickets; the owl sings all year.
export const SEASON_ARC = Object.freeze({
    spring: Object.freeze({ songbirds: 1.2, crickets: 0.45, windFloor: 0, sea: 1 }),
    summer: Object.freeze({ songbirds: 1, crickets: 1, windFloor: 0, sea: 1 }),
    autumn: Object.freeze({ songbirds: 0.7, crickets: 0.55, windFloor: 0.03, sea: 1 }),
    winter: Object.freeze({ songbirds: 0.25, crickets: 0, windFloor: 0, sea: 1.1, robinOnly: true }),
});

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The world stratum's targets at a minute of the day (0..1440) in a season:
 * `{ key, sea, wind, windFloor, birds, rates, crickets, dark }`, the two
 * grade keys' rows eased like the grade and the season applied.
 */
export function dayArcAt({ minuteOfDay = 12 * 60, season = 'summer' } = {}) {
    const { from, to, t } = gradeKeysAt(minuteOfDay, seasonShiftFor(season));
    const a = DAY_ARC[from.name];
    const b = DAY_ARC[to.name];
    const mod = SEASON_ARC[season] ?? SEASON_ARC.summer;
    const rates = {};
    for (const name of ARC_SPECIES) rates[name] = lerp(a.rates[name], b.rates[name], t);
    if (mod.robinOnly) {
        const songs = SONGBIRDS.reduce((sum, name) => sum + rates[name], 0);
        for (const name of SONGBIRDS) rates[name] = 0;
        rates.robin = songs * mod.songbirds;
    } else {
        for (const name of SONGBIRDS) rates[name] *= mod.songbirds;
    }
    return {
        key: `${from.name}>${to.name}`,
        sea: clamp01(lerp(a.sea, b.sea, t) * mod.sea),
        wind: lerp(a.wind, b.wind, t),
        windFloor: mod.windFloor,
        birds: lerp(a.birds, b.birds, t),
        rates,
        crickets: lerp(a.crickets, b.crickets, t) * mod.crickets,
        dark: clamp01(lerp(a.dark, b.dark, t)),
    };
}

/**
 * Bird phrase rates under the weather (AMB-7): rain thins them, a storm
 * silences them.
 */
export function weatherBirdRates(rates, { precipitation = 0, storm = 0 } = {}) {
    const wet = (1 - 0.95 * clamp01(precipitation)) * (1 - clamp01(storm));
    const out = {};
    for (const name of ARC_SPECIES) out[name] = (rates?.[name] ?? 0) * wet;
    return out;
}

/**
 * The cricket chorus under the weather (AMB-8): light drizzle leaves it,
 * steady rain silences it (gone by precipitation 1/3), a storm stops it.
 */
export function cricketLevel(arcCrickets, { precipitation = 0, storm = 0 } = {}) {
    if (storm > 0) return 0;
    const p = clamp01(precipitation);
    const wet = p > 0.08 ? Math.max(0, 1 - 3 * p) : 1;
    return clamp01(arcCrickets) * wet;
}

/**
 * Air temperature (°C) for the chorus's Dolbear rate (AMB-8): summer nights
 * cool from 21 °C as they go on, spring and autumn sit at 13, winter at 4.
 */
export function cricketTemperature(season = 'summer', nightProgress = 0) {
    if (season === 'summer') return 21 - 4 * clamp01(nightProgress);
    if (season === 'winter') return 4;
    return 13;
}
