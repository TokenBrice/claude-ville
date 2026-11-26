// W6.10 (AW-P10) — the village's date-keyed table: the occasions a year of
// always-on viewing can notice, and the static dressing each one lays out.
// Pure data, read by `presentation/character-mode/VillageCalendar.js`, which
// resolves it against the local date (the same local day `localDateKey`
// keys the weather timeline and the ambient schedule on) and rebakes at most
// once a local midnight.
//
// Occasion windows are inclusive local calendar days, month 1-based. Every
// window is a fixed date range, so a pinned clock (`page.clock.install`)
// gives the same dressing on every run.
export const VILLAGE_OCCASIONS = Object.freeze({
    // The winter-solstice week: Dec 21 +/- 3.
    'winter-solstice': Object.freeze({ from: Object.freeze([12, 18]), to: Object.freeze([12, 24]) }),
    // Late December: the door wreaths stay up through the year's end.
    'late-december': Object.freeze({ from: Object.freeze([12, 15]), to: Object.freeze([12, 31]) }),
    // The spring-equinox week: Mar 20 +/- 3.
    'spring-equinox': Object.freeze({ from: Object.freeze([3, 17]), to: Object.freeze([3, 23]) }),
    // Midsummer week: Jun 21 +/- 3.
    midsummer: Object.freeze({ from: Object.freeze([6, 18]), to: Object.freeze([6, 24]) }),
    // Harvest: the whole of October.
    harvest: Object.freeze({ from: Object.freeze([10, 1]), to: Object.freeze([10, 31]) }),
    // The one acknowledgement that a week exists (Date#getDay: 6 Sat, 0 Sun).
    weekend: Object.freeze({ weekdays: Object.freeze([6, 0]) }),
});

// The anchors the Chronicle dressing owns (ChronicleDressingLedger:
// `harbor.bunting`, `forge.billetRack`, `archive.lectern`). A calendar
// dressing never claims one.
export const CHRONICLE_DRESSING_ANCHORS = Object.freeze([
    'harbor.bunting',
    'forge.billetRack',
    'archive.lectern',
]);

// One row per placed dressing. `sprite` names the authored manifest prop a
// row draws (W8.4b, PixelLab art); `stamp` names a code-drawn pixel stamp
// (VillageCalendar.js) for the dressings no sprite-sized art fits: the gate
// garland tied to the gatehouse lanterns and the 7-texel door wreaths.
// `variant` is a stamp's colourway, `anchor` the one place a row claims.
// `part` rows dress a landmark (drawn by BuildingSprite at a sprite-local
// texel); every other row is a sorted prop at its tile. `light` marks the one
// dressing that lights at night: a fixture on the `lamps` clock gate, never
// occupancy (its static flame is code-drawn over the laid logs). `glow`
// marks a stamp whose bulbs burn on the same `lamps` gate (lit tones plus an
// emissive channel) without casting a fixture light.
export const VILLAGE_CALENDAR_DRESSINGS = Object.freeze([
    // Solstice lantern garland swung between the gatehouse's wall lanterns,
    // over the head of the gate avenue; in the equinox week the same swag
    // carries blossom.
    Object.freeze({ id: 'gate-garland-lights', occasion: 'winter-solstice', stamp: 'gateGarland', variant: 'lights', anchor: 'gate.arch', glow: true }),
    Object.freeze({ id: 'gate-garland-blossom', occasion: 'spring-equinox', stamp: 'gateGarland', variant: 'blossom', anchor: 'gate.arch' }),
    // A small decorated pine on the open green at the plaza's east end, in
    // front of the Tavern's west steps: beside its ale barrels, clear of
    // the visit places and paving.
    Object.freeze({ id: 'plaza-pine', occasion: 'winter-solstice', sprite: 'prop.festival.pine', anchor: 'plaza.green', tileX: 24.0, tileY: 17.4 }),
    // Late-December wreaths on the Command and Archive doors (sprite texels).
    Object.freeze({ id: 'command-wreath', occasion: 'late-december', stamp: 'wreath', anchor: 'command.door', part: 'command', at: Object.freeze([131, 132]) }),
    Object.freeze({ id: 'archive-wreath', occasion: 'late-december', stamp: 'wreath', anchor: 'archive.door', part: 'archive', at: Object.freeze([243, 150]) }),
    // Midsummer: a laid bonfire on the open green below the mine path, where
    // the south wildwood meets the gate meadow, lit at night.
    Object.freeze({ id: 'midsummer-bonfire', occasion: 'midsummer', sprite: 'prop.festival.bonfire', anchor: 'forest.south-edge', tileX: 15.3, tileY: 34.0, light: true }),
    // Harvest: pumpkins at both market stalls' feet and a stook at the field
    // edge beside the mine path.
    Object.freeze({ id: 'harvest-pumpkins-avenue', occasion: 'harvest', sprite: 'prop.festival.pumpkins', anchor: 'stall.avenue.foot', tileX: 16.48, tileY: 30.92 }),
    Object.freeze({ id: 'harvest-pumpkins-civic', occasion: 'harvest', sprite: 'prop.festival.pumpkins', anchor: 'stall.civic.foot', tileX: 12.75, tileY: 21.15 }),
    Object.freeze({ id: 'harvest-stook', occasion: 'harvest', sprite: 'prop.festival.stook', anchor: 'field.edge', tileX: 14.2, tileY: 33.6 }),
    // Weekend: the avenue stall runs a side awning out on its west flank,
    // over a produce table, its east post a hand's width off the stall's west
    // post so neither covers the other (in October the stall's pumpkins sit
    // at the table's foot).
    Object.freeze({ id: 'weekend-awning', occasion: 'weekend', sprite: 'prop.festival.produceAwning', anchor: 'stall.avenue.side', tileX: 16.43, tileY: 30.62 }),
]);

// ---------------------------------------------------------------------------
// W6.3 — the sky's own calendar: pure, deterministic astronomical predicates
// the atmosphere snapshot exposes (`atmosphere.skyKeys`) and SkyRenderer keys.
// No clock reads: every predicate takes its instant or its date fields. Each
// is false (null) on an ordinary date, so the sky on those dates — and on
// every pinned capture date — is byte-for-byte the sky without them.

// The mean synodic month and a reference new moon (2000-01-06 18:14 UTC):
// the one lunation clock AtmosphereState's moon and tide read too.
export const SYNODIC_MONTH_DAYS = 29.530588853;
export const REFERENCE_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const DAY_MS = 86400000;
const HALF_MONTH_DAYS = SYNODIC_MONTH_DAYS / 2;

/** Moon age in days (0 new, ~14.77 full) at a UTC instant. */
export function moonAgeDaysAt(utcMs) {
    const age = ((Number(utcMs) - REFERENCE_NEW_MOON_MS) / DAY_MS) % SYNODIC_MONTH_DAYS;
    return (age + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
}

// Lantern Night: a clear evening within a day of the full moon, from the
// start of dusk to local midnight.
export const LANTERN_NIGHT_WINDOW_DAYS = 1;
export const LANTERN_NIGHT_FROM_MINUTE = 17 * 60;
export const LANTERN_NIGHT_MAX_CLOUD_COVER = 0.35;

/**
 * True on a Lantern Night evening: moon age within LANTERN_NIGHT_WINDOW_DAYS
 * of full, phase dusk or night before local midnight (and not before 17:00),
 * clear weather (type `clear`, cloud cover at most 0.35, no precipitation).
 */
export function isLanternNight({ moonAgeDays, phase, minuteOfDay, weatherType, cloudCover = 0, precipitation = 0 } = {}) {
    const age = Number(moonAgeDays);
    if (!Number.isFinite(age) || Math.abs(age - HALF_MONTH_DAYS) > LANTERN_NIGHT_WINDOW_DAYS) return false;
    if (phase !== 'dusk' && phase !== 'night') return false;
    const minute = Number(minuteOfDay);
    if (!Number.isFinite(minute) || minute < LANTERN_NIGHT_FROM_MINUTE || minute >= 24 * 60) return false;
    if (weatherType !== 'clear') return false;
    return (Number(cloudCover) || 0) <= LANTERN_NIGHT_MAX_CLOUD_COVER && !((Number(precipitation) || 0) > 0);
}

// The Solstice Terrace Alignment: the two local calendar days at each
// solstice (month 1-based), and the half hour either side of the real sun's
// transit when the noon sun stands over the Runic Tide-Terrace sundial.
export const SOLSTICE_ALIGNMENT_DAYS = Object.freeze([
    Object.freeze({ kind: 'june', month: 6, days: Object.freeze([20, 21]) }),
    Object.freeze({ kind: 'december', month: 12, days: Object.freeze([21, 22]) }),
]);
export const SOLSTICE_ALIGNMENT_HALF_WINDOW_MIN = 30;

/**
 * The solstice day a local calendar date falls on, `{ kind, month, day }`, or
 * null. `month` is 1-based.
 */
export function solsticeAlignmentDay({ month, day } = {}) {
    const m = Number(month);
    const d = Number(day);
    const row = SOLSTICE_ALIGNMENT_DAYS.find(entry => entry.month === m && entry.days.includes(d));
    return row ? { kind: row.kind, month: m, day: d } : null;
}

/**
 * The solstice alignment flag for a local date and minute: null on any
 * other day; on a solstice day `{ kind, aligned }`, where `aligned` holds
 * within SOLSTICE_ALIGNMENT_HALF_WINDOW_MIN of the real solar noon while the
 * sun is up.
 */
export function solsticeAlignmentAt({ month, day, minuteOfDay, solarNoonMinute, sunUp = true } = {}) {
    const solstice = solsticeAlignmentDay({ month, day });
    if (!solstice) return null;
    const minute = Number(minuteOfDay);
    const noon = Number(solarNoonMinute);
    const aligned = sunUp === true && Number.isFinite(minute) && Number.isFinite(noon)
        && Math.abs(minute - noon) <= SOLSTICE_ALIGNMENT_HALF_WINDOW_MIN;
    return { kind: solstice.kind, aligned };
}

// The 2026–2027 eclipse keys: exact UTC contact times (Espenak / NASA GSFC,
// EclipseWise). A solar key spans the umbra's (an annular eclipse's
// antumbra's) hours on Earth (U1 → U4) and peaks at greatest eclipse at its
// magnitude; a lunar key spans the umbral phase (U1 → U4), full through
// totality (U2 → U3) for a total eclipse and peaking at greatest eclipse for
// a partial one, at its umbral magnitude. The windows are the eclipse's own
// hours; the sky keys them only while the eclipsed body is up over the
// village. A lunar eclipse is seen wherever the moon is up. A solar one is
// seen only near its track: `visibility` lists coarse lat/lon boxes (degrees,
// east and north positive), each with the strongest key it allows: 1 on the
// central path, PARTIAL_SOLAR_CAP across the partial region. A site outside
// every box sees no eclipse. Coarse boxes, not a local circumstances
// prediction.
const utc = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s);
export const PARTIAL_SOLAR_CAP = 0.5;
const box = (latMin, latMax, lonMin, lonMax, cap) => Object.freeze({ lat: Object.freeze([latMin, latMax]), lon: Object.freeze([lonMin, lonMax]), cap });
export const ECLIPSE_SKY_KEYS = Object.freeze([
    Object.freeze({
        id: 'lunar-2026-03-03', body: 'moon', type: 'total', magnitude: 1,
        start: utc(2026, 3, 3, 9, 50, 0), fullFrom: utc(2026, 3, 3, 11, 4, 26), peak: utc(2026, 3, 3, 11, 33, 37),
        fullTo: utc(2026, 3, 3, 12, 2, 45), end: utc(2026, 3, 3, 13, 17, 10),
    }),
    Object.freeze({
        id: 'solar-2026-08-12', body: 'sun', type: 'total', magnitude: 1,
        start: utc(2026, 8, 12, 16, 58, 6), fullFrom: null, peak: utc(2026, 8, 12, 17, 45, 53),
        fullTo: null, end: utc(2026, 8, 12, 18, 34, 5),
        // Totality: east Greenland, western Iceland, northern Spain and the
        // Balearics; partial over the Arctic, Europe, north Africa and
        // north-east North America.
        visibility: Object.freeze([
            box(66, 82, -32, -21, 1),
            box(63, 67, -25, -21.5, 1),
            box(40.5, 44, -10, 0, 1),
            box(38.5, 40.8, -1.5, 4.5, 1),
            box(25, 90, -100, 60, PARTIAL_SOLAR_CAP),
        ]),
    }),
    Object.freeze({
        id: 'lunar-2026-08-28', body: 'moon', type: 'partial', magnitude: 0.93,
        start: utc(2026, 8, 28, 2, 33, 48), fullFrom: null, peak: utc(2026, 8, 28, 4, 12, 52),
        fullTo: null, end: utc(2026, 8, 28, 5, 51, 55),
    }),
    Object.freeze({
        // Annular (magnitude 0.928, so its key peaks a step short of full):
        // antumbral U1 14:03:53 → greatest 15:59:35 → U4 17:55:24 UT.
        id: 'solar-2027-02-06', body: 'sun', type: 'annular', magnitude: 0.928,
        start: utc(2027, 2, 6, 14, 3, 53), fullFrom: null, peak: utc(2027, 2, 6, 15, 59, 35),
        fullTo: null, end: utc(2027, 2, 6, 17, 55, 24),
        // Annularity: Patagonia and Buenos Aires province, the South Atlantic
        // off Uruguay and southern Brazil, and the Gulf of Guinea coast;
        // partial over South America, Antarctica and west and south Africa.
        visibility: Object.freeze([
            box(-45, -40, -73, -64, 1),
            box(-41.5, -37.5, -64, -58, 1),
            box(-37, -33.5, -56, -51.5, 1),
            box(3.5, 7.5, -2, 4.5, 1),
            box(-90, 20, -95, 35, PARTIAL_SOLAR_CAP),
        ]),
    }),
    Object.freeze({
        id: 'solar-2027-08-02', body: 'sun', type: 'total', magnitude: 1,
        start: utc(2027, 8, 2, 8, 23, 16), fullFrom: null, peak: utc(2027, 8, 2, 10, 6, 29),
        fullTo: null, end: utc(2027, 8, 2, 11, 49, 44),
        // Totality: the Strait of Gibraltar, northern Morocco, Algeria and
        // Tunisia, Libya and Egypt (Luxor), the Red Sea, Saudi Arabia and
        // Yemen, the Gulf of Aden and Somalia's horn; partial over Europe,
        // Africa, the Middle East and western and southern Asia.
        visibility: Object.freeze([
            box(34.6, 36.9, -7, -2, 1),
            box(33.4, 36.8, -2, 11.5, 1),
            box(31, 34, 11.5, 25, 1),
            box(25, 32, 24, 33.5, 1),
            box(20, 26, 33, 40.5, 1),
            box(14, 21, 39.5, 47.5, 1),
            box(9.5, 14.5, 46.5, 52.5, 1),
            box(-35, 72, -35, 95, PARTIAL_SOLAR_CAP),
        ]),
    }),
]);
// Keys step in quarters (palette-snapped strength), never a smooth ramp.
export const ECLIPSE_KEY_STEPS = 4;

function eclipseShare(row, t) {
    if (row.fullFrom != null && row.fullTo != null) {
        if (t < row.fullFrom) return (t - row.start) / (row.fullFrom - row.start);
        if (t > row.fullTo) return (row.end - t) / (row.end - row.fullTo);
        return 1;
    }
    if (t <= row.peak) return (t - row.start) / (row.peak - row.start);
    return (row.end - t) / (row.end - row.peak);
}

const inRange = (value, [min, max]) => value >= min && value <= max;

/**
 * The strongest key a solar eclipse allows at a site `{ lat, lon }` (degrees):
 * the largest `cap` among its `visibility` boxes holding the site, 0 outside
 * them all, 1 for a row without boxes (a lunar eclipse) or without a site.
 */
export function eclipseVisibilityCap(row, site = null) {
    if (!row?.visibility) return 1;
    const lat = Number(site?.lat);
    const lon = Number(site?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 1;
    const wrapped = ((lon + 540) % 360) - 180;
    let cap = 0;
    for (const area of row.visibility) {
        if (inRange(lat, area.lat) && inRange(wrapped, area.lon)) cap = Math.max(cap, area.cap);
    }
    return cap;
}

/**
 * The eclipse key at a UTC instant: `{ id, body, type, strength }` with
 * `strength` in quarter steps (the share of the way to full, scaled by the
 * eclipse's magnitude, floored to a quarter, at least 0.25), or null outside
 * every window (end exclusive). A deep partial (0.93) peaks at 0.75. With a
 * `site` (`{ lat, lon }`) a solar key is held to `eclipseVisibilityCap`: none
 * far from the track, at most PARTIAL_SOLAR_CAP in the partial region; a
 * lunar key is the same everywhere.
 */
export function eclipseSkyKeyAt(utcMs, site = null) {
    const t = Number(utcMs);
    if (!Number.isFinite(t)) return null;
    for (const row of ECLIPSE_SKY_KEYS) {
        if (t < row.start || t >= row.end) continue;
        const cap = eclipseVisibilityCap(row, site);
        if (!(cap > 0)) continue;
        const share = Math.min(cap, Math.max(0, Math.min(1, eclipseShare(row, t))) * row.magnitude);
        const strength = Math.max(1, Math.floor(share * ECLIPSE_KEY_STEPS + 1e-9)) / ECLIPSE_KEY_STEPS;
        return { id: row.id, body: row.body, type: row.type, strength };
    }
    return null;
}
