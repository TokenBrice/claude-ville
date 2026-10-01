// C2 — one grade evaluator (the Opus 5.5 aesthetic plan).
//
// A single pure function turns the real clock, the real weather and the moon
// into the whole world grade. It is evaluated on the CPU (once per atmosphere
// snapshot, memoized by the caller) and consumed by the resident composite,
// the hybrid PostFx pass and the Canvas fallback, so every backend grades the
// island with the same numbers. No DOM, no time source, no agent state: the
// grade follows the clock and the sky only (the "red sky on error" kill stays
// respected).
//
// Output channels are 0..1 floats. The shader convention (GpuWorldPolicy's
// GRADE_GLSL, mirrored by the Canvas fallback) is, per unpremultiplied albedo:
//
//   Lin   = luma(albedo)                               key for the split tone
//   c     = mix(Lin * purkinje, albedo, saturation)  night desaturates toward
//                                                     a Purkinje-blue grey
//   c    *= gain * exposure                          time-of-day ambient
//   c     = lift + c * (1 - lift)                    never pitch black
//   c     = pow(c, gamma)                            mid contrast
//   c    *= mix(mix(1, shadowTint, sh(Lin)), highlightTint, hi(Lin))
//   c    /= max(1, max(c.r, c.g, c.b))               highlight protection
//
// Local light pools and authored emission are added after the grade, so lit
// pixels keep their real colour at night (the emissive exemption).

const DAY_MINUTES = 24 * 60;

// Exposure never falls below this: the darkest storm night keeps readable
// ground ("Do not do: pitch-black nights").
export const GRADE_EXPOSURE_FLOOR = 0.40;
// The weather rows also spend value through `gain`, which the exposure floor
// cannot see. The effective ambient (exposure x luma(gain), what an unlit
// mid-grey becomes) never falls below this: a storm night sits one course
// under a clear deep night (0.53), never at black.
export const GRADE_AMBIENT_FLOOR = 0.42;

// Rec.709 luma weights, shared with the shaders.
const LUMA = [0.2126, 0.7152, 0.0722];

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function smoothstep(t) {
    const x = clamp(t);
    return x * x * (3 - 2 * x);
}

function hexToRgb01(hex) {
    const text = String(hex).replace('#', '');
    return [
        parseInt(text.slice(0, 2), 16) / 255,
        parseInt(text.slice(2, 4), 16) / 255,
        parseInt(text.slice(4, 6), 16) / 255,
    ];
}

function rgb01ToHex(rgb) {
    return `#${rgb.map(channel => Math.round(clamp(channel) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luma(rgb) {
    return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

// A tint whose luma is 1: it moves hue without moving value.
function lumaNormalized(rgb) {
    const l = Math.max(1e-4, luma(rgb));
    return [rgb[0] / l, rgb[1] / l, rgb[2] / l];
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerp3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function mul3(a, b) {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function towardOne3(a, t) {
    return lerp3(a, [1, 1, 1], t);
}

const NEUTRAL = Object.freeze([1, 1, 1]);
// The desaturation target is a moonlit blue-teal: with the cool `gain` it
// carries the night's colour, while the albedo keeps enough of its own hue
// that grass, roofs and water stay identifiable.
const PURKINJE_BLUE = Object.freeze(lumaNormalized([0.93, 1.0, 1.07]));

// The 8 authored daily keys. Minutes are the equinox baseline; the dawn-side
// keys follow the season's sunrise shift and the dusk-side keys its sunset
// shift, so the grade stays in step with the sky and the solar vector.
//
//   exposure/saturation  scalar ambient and colourfulness
//   gain                 per-channel ambient colour (the mid tint)
//   lift                 black floor colour
//   gamma                mid contrast exponent (>1 deepens mids)
//   shadowTint/highlightTint  luminance-keyed split tone, relative to gain
//   purkinje             0..1 weight of the blue-grey desaturation target
//   sunBand              how much of the authored two-course sun band applies
//   daylight             direct-sun share (cloud shadows ride it)
//   night                0..1 night weight (moon term, weather night course)
//   rake                 0..1 raking-sun cast length (RakingLight 1.5)
//   vignetteEdge/Alpha   the stepped edge darkening
//   sky/void/haze        colours for the sky, void and aerial-perspective
//                        consumers
//   approach             optional ease exponent on the segment INTO this key
//                        (t = smoothstep(local) ^ approach): > 1 holds the
//                        previous key longer and arrives late
//
// 1.1 (The Waking Isle) — the authored colour script, contract V6: each key
// has its own identity (rose mist at dawn, clean daylight, an amber key over
// violet shadows at golden hour, a cobalt blue hour, a moonlit night in which
// the lamps give colour back), measured on the fixed `readme-showcase` camera
// and asserted over the C1 ramps by scripts/tests/grade-colour-script.test.mjs.
// The 8 key names are a contract: the audio arrangement couples to them.
export const GRADE_KEYFRAMES = Object.freeze([
    Object.freeze({
        name: 'deep-night', minute: 2 * 60, side: 'night',
        exposure: 0.66, saturation: 0.38,
        gain: [0.86, 0.94, 1.00], lift: [0.024, 0.027, 0.032], gamma: 1.03,
        shadowTint: [0.84, 0.93, 1.10], highlightTint: [0.94, 1.03, 1.03],
        purkinje: 1, sunBand: 0, daylight: 0, night: 1, rake: 0,
        vignetteEdge: [0.74, 0.76, 0.83], vignetteAlpha: 0.44,
        skyTop: '#070b16', skyHorizon: '#141d2e', voidColor: '#0b1218', horizonHaze: '#1a2436',
    }),
    Object.freeze({
        name: 'pre-dawn', minute: 4 * 60 + 30, side: 'dawn',
        exposure: 0.50, saturation: 0.34,
        gain: [0.86, 0.86, 1.00], lift: [0.022, 0.021, 0.028], gamma: 1.05,
        shadowTint: [0.92, 0.90, 1.00], highlightTint: [1.06, 0.98, 0.98],
        purkinje: 0.8, sunBand: 0, daylight: 0, night: 0.85, rake: 0.25,
        vignetteEdge: [0.74, 0.74, 0.84], vignetteAlpha: 0.42,
        skyTop: '#0f1732', skyHorizon: '#46405e', voidColor: '#0e151f', horizonHaze: '#2e3452',
    }),
    // Sunrise is rose and mist (M17), not a second golden hour: a faint rose
    // key over cool, lifted shadows, less saturated and with less value spread
    // than noon, so 06:00 no longer twins 18:00. The long dawn cast comes from
    // the authored `rake`.
    Object.freeze({
        name: 'sunrise', minute: 6 * 60, side: 'dawn',
        exposure: 0.84, saturation: 0.82,
        gain: [1.03, 0.96, 0.97], lift: [0.030, 0.027, 0.040], gamma: 0.97,
        shadowTint: [0.88, 0.92, 1.12], highlightTint: [1.16, 0.99, 0.98],
        purkinje: 0.1, sunBand: 0.8, daylight: 0.55, night: 0.1, rake: 0.875,
        vignetteEdge: [0.80, 0.74, 0.80], vignetteAlpha: 0.34,
        skyTop: '#2e4a7a', skyHorizon: '#e2a98a', voidColor: '#141c26', horizonHaze: '#a88478',
    }),
    Object.freeze({
        name: 'morning', minute: 8 * 60 + 30, side: 'dawn',
        exposure: 0.98, saturation: 0.97,
        gain: [1.00, 1.00, 0.99], lift: [0, 0, 0.006], gamma: 1.0,
        shadowTint: [0.94, 0.96, 1.05], highlightTint: [1.04, 1.02, 0.96],
        purkinje: 0, sunBand: 1, daylight: 1, night: 0, rake: 0.19,
        vignetteEdge: [0.86, 0.89, 0.93], vignetteAlpha: 0.26,
        skyTop: '#4f86b8', skyHorizon: '#b9d3e2', voidColor: '#16222b', horizonHaze: '#9cb6c6',
    }),
    Object.freeze({
        name: 'noon', minute: 12 * 60 + 30, side: 'noon',
        exposure: 1.0, saturation: 1.0,
        gain: [1.02, 1.00, 0.97], lift: [0, 0, 0], gamma: 1.0,
        shadowTint: [0.97, 0.98, 1.03], highlightTint: [1.03, 1.02, 0.98],
        purkinje: 0, sunBand: 1, daylight: 1, night: 0, rake: 0,
        vignetteEdge: [0.86, 0.89, 0.92], vignetteAlpha: 0.24,
        skyTop: '#4a86c0', skyHorizon: '#b8d6e6', voidColor: '#16222b', horizonHaze: '#a2becf',
    }),
    // Golden hour is a low sun: an amber key over violet shadows, more
    // colourful than noon. V6 measures it on land (V6 holds the water at
    // WATER_MAX_SATURATION, so the sea no longer carries the cool fill): the
    // violet lives in the land split tone — a violet shadow tint and a blue
    // lift for the fill, an amber highlight tint for the key and the value
    // spread. The shadow tint's green stays high enough that mid-dark water
    // and grass keep their value, so golden hour stays brighter than blue
    // hour, and exposure keeps the 5120 arc, where the frame is mostly sea,
    // with golden above blue hour. The T1 salience guard (18:00 z1,
    // readme-showcase, DPR 2, ten samples: the old flat split at 0.95 left
    // the T1 plates 18 % of the top-1 % salience, this violet split 26 % at
    // 0.92) keeps exposure from rising further; saturation stays inside M17's
    // 1.12–1.20 band (1.20 cost six salience points). The
    // highlight tint keeps G well under R so lit ground stays amber, never
    // the plates' yellow. The approach holds the afternoon: 15:00 is 13 %
    // golden, gold lands 16:30–17:45.
    Object.freeze({
        name: 'golden-hour', minute: 18 * 60, side: 'dusk', approach: 2.4,
        exposure: 0.95, saturation: 1.15,
        gain: [1.05, 0.97, 0.88], lift: [0.004, 0.000, 0.040], gamma: 1.08,
        shadowTint: [0.72, 0.64, 1.40], highlightTint: [1.36, 1.10, 0.78],
        purkinje: 0, sunBand: 1, daylight: 0.9, night: 0, rake: 1,
        vignetteEdge: [0.78, 0.70, 0.78], vignetteAlpha: 0.32,
        skyTop: '#3f6ea0', skyHorizon: '#f0b27a', voidColor: '#1a1f28', horizonHaze: '#c09878',
    }),
    // Blue hour is a cobalt dusk: bluer than golden hour, never darker than
    // night (the arc stays monotone), keeping more of the albedo's colour than
    // the night key does.
    Object.freeze({
        name: 'blue-hour', minute: 19 * 60 + 45, side: 'dusk',
        exposure: 0.82, saturation: 0.62,
        gain: [0.80, 0.90, 1.10], lift: [0.018, 0.020, 0.034], gamma: 1.02,
        shadowTint: [0.86, 0.90, 1.14], highlightTint: [1.04, 0.98, 1.02],
        purkinje: 0.3, sunBand: 0.2, daylight: 0.1, night: 0.5, rake: 0.375,
        vignetteEdge: [0.74, 0.74, 0.84], vignetteAlpha: 0.40,
        skyTop: '#1c2c52', skyHorizon: '#6a6488', voidColor: '#10171f', horizonHaze: '#3a4262',
    }),
    // Night is moonlit, not grey: the albedo keeps ~40 % of its own colour
    // (grass stays green, water blue) and the moonlight lives in the split
    // tone — an indigo shadow tint and a faint blue-green highlight — so stone
    // reads cool slate-blue and lit grass blue-green. Local light and authored
    // emission (exempt, added after the grade) carry the amber. Night/noon
    // saturation sits between 0.5x and 0.85x, and night is bluer than noon.
    Object.freeze({
        name: 'night', minute: 22 * 60, side: 'night',
        exposure: 0.74, saturation: 0.42,
        gain: [0.86, 0.94, 1.00], lift: [0.024, 0.027, 0.032], gamma: 1.02,
        shadowTint: [0.84, 0.94, 1.10], highlightTint: [0.94, 1.03, 1.03],
        purkinje: 1, sunBand: 0, daylight: 0, night: 1, rake: 0,
        vignetteEdge: [0.76, 0.78, 0.85], vignetteAlpha: 0.42,
        skyTop: '#0a1122', skyHorizon: '#1a2438', voidColor: '#0b1218', horizonHaze: '#1e2a3e',
    }),
]);

// Weather rows, applied after the time key. Tints are the plan's cool
// multiplies (rain #b2c4d6, storm #8e9fb4). At night the multiply keeps its
// hue but spends less value (the night key already owns the darkness); storm
// keeps one extra night course darker.
export const GRADE_WEATHER_ROWS = Object.freeze({
    rain: Object.freeze({ saturation: 0.74, tint: '#b2c4d6', flatten: 0.7, nightCourse: 1 }),
    storm: Object.freeze({ saturation: 0.62, tint: '#8e9fb4', flatten: 0.85, nightCourse: 0.88 }),
    overcast: Object.freeze({ saturation: 0.82, tint: '#c4ccd4', flatten: 0.55, nightCourse: 1 }),
    fog: Object.freeze({ saturation: 0.80, tint: '#dfe3e6', flatten: 0.45, nightCourse: 1 }),
});
const WEATHER_GREY = Object.freeze({
    rain: Object.freeze({ sky: '#5b6674', haze: '#6e7a88', void: '#121a21' }),
    storm: Object.freeze({ sky: '#3a4150', haze: '#4a5262', void: '#0e1419' }),
    overcast: Object.freeze({ sky: '#7a8590', haze: '#8a949e', void: '#141d24' }),
    fog: Object.freeze({ sky: '#9aa4ac', haze: '#aab2b8', void: '#18222a' }),
});

function keyMinutes(key, sunriseShift, sunsetShift) {
    if (key.side === 'dawn') return key.minute + sunriseShift;
    if (key.side === 'dusk') return key.minute + sunsetShift;
    return key.minute;
}

/**
 * The two keys around `minute` and the eased weight between them. Keys are
 * cyclic: deep night (02:00) follows night (22:00) across midnight.
 */
export function gradeKeysAt(minuteOfDay, { sunriseShift = 0, sunsetShift = 0 } = {}) {
    const minute = ((finite(minuteOfDay) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    const keys = GRADE_KEYFRAMES;
    const count = keys.length;
    for (let index = 0; index < count; index++) {
        const from = keys[index];
        const to = keys[(index + 1) % count];
        const start = keyMinutes(from, sunriseShift, sunsetShift);
        let end = keyMinutes(to, sunriseShift, sunsetShift);
        if (end <= start) end += DAY_MINUTES;
        let local = minute;
        if (local < start) local += DAY_MINUTES;
        if (local >= start && local < end) {
            const eased = smoothstep((local - start) / (end - start));
            return { from, to, t: eased ** (to.approach ?? 1) };
        }
    }
    return { from: keys[0], to: keys[0], t: 0 };
}

function weatherWeights(weather) {
    const type = String(weather?.type || 'clear');
    const intensity = clamp(finite(weather?.intensity, 0.6));
    const cloudCover = clamp(finite(weather?.cloudCover, 0));
    const weight = clamp(0.4 + intensity * 0.75);
    return {
        type,
        cloudCover,
        rain: type === 'rain' ? weight : 0,
        storm: type === 'storm' ? weight : 0,
        // Overcast flattening follows real cover (> 0.7), whatever the label.
        overcast: type === 'overcast' ? weight : 0,
        fog: type === 'fog' ? weight : clamp(finite(weather?.fog, 0)) * 0.5,
        flat: clamp((cloudCover - 0.7) / 0.2),
    };
}

/**
 * C2. `minuteOfDay` 0..1440 (fractional allowed), `weather` an atmosphere
 * weather object ({ type, intensity, cloudCover, fog }), `moonPhase` the
 * lunar illumination 0..1 (or `{ illumination }`); `moonFill` (visibility x
 * illumination x cloud transmission, 0 outside night) wins when given.
 * Optional `sunriseShift`/`sunsetShift` (minutes) follow the season.
 */
export function evaluateGrade({
    minuteOfDay = 12 * 60,
    weather = null,
    moonPhase = 0,
    moonFill = null,
    sunriseShift = 0,
    sunsetShift = 0,
} = {}) {
    const { from, to, t } = gradeKeysAt(minuteOfDay, { sunriseShift, sunsetShift });
    let exposure = lerp(from.exposure, to.exposure, t);
    let saturation = lerp(from.saturation, to.saturation, t);
    let gain = lerp3(from.gain, to.gain, t);
    let lift = lerp3(from.lift, to.lift, t);
    let gamma = lerp(from.gamma, to.gamma, t);
    let shadowTint = lerp3(from.shadowTint, to.shadowTint, t);
    let highlightTint = lerp3(from.highlightTint, to.highlightTint, t);
    let purkinjeWeight = lerp(from.purkinje, to.purkinje, t);
    let sunBand = lerp(from.sunBand, to.sunBand, t);
    let daylight = lerp(from.daylight, to.daylight, t);
    let rake = lerp(from.rake, to.rake, t);
    const night = lerp(from.night, to.night, t);
    let vignetteEdge = lerp3(from.vignetteEdge, to.vignetteEdge, t);
    let vignetteAlpha = lerp(from.vignetteAlpha, to.vignetteAlpha, t);
    let skyTop = lerp3(hexToRgb01(from.skyTop), hexToRgb01(to.skyTop), t);
    let skyHorizon = lerp3(hexToRgb01(from.skyHorizon), hexToRgb01(to.skyHorizon), t);
    let voidColor = lerp3(hexToRgb01(from.voidColor), hexToRgb01(to.voidColor), t);
    let horizonHaze = lerp3(hexToRgb01(from.horizonHaze), hexToRgb01(to.horizonHaze), t);

    // Moon: a continuous night term (the three reviewed courses had the same
    // endpoints). A bright moon lifts the ambient and gives back a little
    // colour; a new moon leaves the authored night.
    const illumination = typeof moonPhase === 'object' && moonPhase
        ? clamp(finite(moonPhase.illumination, 0))
        : clamp(finite(moonPhase, 0));
    const moon = moonFill == null
        ? illumination * clamp(1 - clamp(finite(weather?.cloudCover, 0)) * 0.85)
        : clamp(finite(moonFill, 0));
    exposure += 0.05 * moon * night;
    saturation += 0.03 * moon * night;

    const w = weatherWeights(weather);
    for (const kind of ['rain', 'storm', 'overcast', 'fog']) {
        const weight = w[kind];
        if (weight <= 0) continue;
        const row = GRADE_WEATHER_ROWS[kind];
        saturation *= lerp(1, row.saturation, weight);
        const tint = hexToRgb01(row.tint);
        // By day the cool multiply spends its full value; at night it keeps
        // the hue and spends ~40% of the value, so rain nights stay readable.
        const value = lerp(1, luma(tint), lerp(1, 0.4, night));
        const weatherTint = lumaNormalized(tint).map(channel => channel * value);
        gain = mul3(gain, lerp3(NEUTRAL, weatherTint, weight));
        exposure *= lerp(1, row.nightCourse, weight * night);
        // A covered sky flattens the split tone and the sun band.
        shadowTint = towardOne3(shadowTint, row.flatten * weight);
        highlightTint = towardOne3(highlightTint, row.flatten * weight);
        gamma = lerp(gamma, 1, row.flatten * weight);
        rake *= 1 - row.flatten * weight;
        vignetteAlpha = Math.min(0.52, vignetteAlpha + 0.06 * weight);
        const grey = WEATHER_GREY[kind];
        const skyWeight = weight * lerp(0.75, 0.35, night);
        skyTop = lerp3(skyTop, mul3(hexToRgb01(grey.sky), [exposure, exposure, exposure]), skyWeight);
        skyHorizon = lerp3(skyHorizon, mul3(hexToRgb01(grey.haze), [exposure, exposure, exposure]), skyWeight);
        horizonHaze = lerp3(horizonHaze, mul3(hexToRgb01(grey.haze), [exposure, exposure, exposure]), skyWeight);
        voidColor = lerp3(voidColor, hexToRgb01(grey.void), weight * 0.6);
    }
    // Overcast: a covered sun leaves no raking band and no cloud shadows.
    const flat = Math.max(w.flat, w.rain, w.storm);
    sunBand *= 1 - flat;
    const cloudShadow = daylight * clamp((0.85 - w.cloudCover) / 0.15);
    daylight *= 1 - flat * 0.7;
    if (w.flat > 0) {
        shadowTint = towardOne3(shadowTint, w.flat * 0.5);
        highlightTint = towardOne3(highlightTint, w.flat * 0.5);
        rake *= 1 - w.flat * 0.5;
    }

    exposure = Math.max(GRADE_EXPOSURE_FLOOR, exposure);
    exposure = Math.max(exposure, GRADE_AMBIENT_FLOOR / Math.max(0.05, luma(gain)));
    saturation = clamp(saturation, 0, 1.2);
    purkinjeWeight = clamp(purkinjeWeight);
    const purkinje = lerp3(NEUTRAL, PURKINJE_BLUE, purkinjeWeight);

    return {
        key: `${from.name}>${to.name}`,
        lift,
        gamma: [gamma, gamma, gamma],
        gain,
        saturation,
        purkinje,
        shadowTint,
        highlightTint,
        exposure,
        // The effective ambient multiplier (what an unlit mid-grey becomes),
        // for consumers that tint cached sprites instead of running the grade.
        ambientTint: mul3(gain, [exposure, exposure, exposure]).map(channel => clamp(channel)),
        // 1.2 — how hard local light pools multiply the surface: they carry
        // the frame once the ambient has fallen (blue hour, night) and stay a
        // faint accent while daylight or a bright overcast still lights it.
        // 1.1 — the blue-hour key is brighter than before, so the lamps would
        // lose the dusk to it; from the lamplight course on (19:30, the same
        // step the source energy takes) they carry the frame at the lamp
        // course's share. The settling course and the dawn keep the ambient
        // term, so sunrise stays rose mist.
        poolGain: 0.15 + 1.05 * Math.max(
            1 - smoothstep((exposure - 0.55) / 0.35),
            night,
            lampCarry(minuteOfDay, sunriseShift, sunsetShift),
        ),
        sunBand: clamp(sunBand),
        daylight: clamp(daylight),
        cloudShadow: clamp(cloudShadow),
        // 1.5 — how raking the sun is (golden hour, sunrise), authored per
        // key and flattened by cover; RakingLight gates it by `daylight`.
        rake: clamp(rake),
        night: clamp(night),
        vignetteEdge,
        vignetteAlpha: clamp(vignetteAlpha),
        fogColor: horizonHaze.map(channel => clamp(channel)),
        skyTop: rgb01ToHex(skyTop),
        skyHorizon: rgb01ToHex(skyHorizon),
        voidColor: rgb01ToHex(voidColor),
        horizonHaze: rgb01ToHex(horizonHaze),
    };
}

/**
 * The same grade applied to one sRGB colour on the CPU (0..1 channels). The
 * GLSL in GpuWorldPolicy is the authority for pixels; this mirror lets the
 * Canvas fallback and cached-sprite consumers match it.
 */
export function applyGradeToRgb(rgb, grade) {
    const lin = luma(rgb);
    const out = [0, 0, 0];
    const sh = 1 - smoothstep((lin - 0.06) / 0.36);
    const hi = smoothstep((lin - 0.38) / 0.44);
    for (let i = 0; i < 3; i++) {
        let c = lerp(lin * grade.purkinje[i], rgb[i], grade.saturation);
        c *= grade.gain[i] * grade.exposure;
        c = grade.lift[i] + Math.max(0, c) * (1 - grade.lift[i]);
        c = Math.pow(c, grade.gamma[i]);
        c *= lerp(lerp(1, grade.shadowTint[i], sh), grade.highlightTint[i], hi);
        out[i] = c;
    }
    const peak = Math.max(1, out[0], out[1], out[2]);
    return [out[0] / peak, out[1] / peak, out[2] / peak];
}

// V6 — outside the sun and moon path the sea stays cool and quiet at every
// hour: graded water (the outer ocean in CoastBake and the island's water
// material in the resident scene pass) is held at this HSV saturation, so a
// golden or blue-hour frame that is mostly sea never reads as a saturated
// navy slab. Sun glitter, the moon path and lamp reflections are drawn after
// this cap and keep their own colour. 0.37 leaves the composite (haze, cloud
// courses, foam) under V6's 0.40.
export const WATER_MAX_SATURATION = 0.37;

/**
 * Pull `rgb` (0..1) toward its own Rec.709 luma just far enough that its HSV
 * saturation is at most `maxS`: luma and hue are kept, so a cool sea stays
 * cool (the sign of R−B never flips). The GLSL twin is `capSaturation` in
 * GpuWorldPolicy's GRADE_GLSL.
 */
export function capSaturation(rgb, maxS = WATER_MAX_SATURATION) {
    const hi = Math.max(rgb[0], rgb[1], rgb[2]);
    const spread = hi - Math.min(rgb[0], rgb[1], rgb[2]);
    if (hi <= 0 || spread <= maxS * hi) return rgb;
    const y = luma(rgb);
    const k = Math.max(0, Math.min(1, (maxS * y) / Math.max(1e-6, spread - maxS * (hi - y))));
    return [y + (rgb[0] - y) * k, y + (rgb[1] - y) * k, y + (rgb[2] - y) * k];
}

// The clear-noon grade, for feeds and fixtures authored without an
// atmosphere snapshot.
export const NEUTRAL_GRADE = Object.freeze(evaluateGrade({ minuteOfDay: 12 * 60 + 30 }));

/**
 * Blue-hour sequencing: the source-energy course (0 daylight, 1 settling,
 * 2 lamplight, 3 deep night) keyed to the same minutes as the grade keys, so
 * at dusk the ambient falls first (golden hour -> blue hour) and the lamps
 * take over second, and at dawn the ambient rises before the lamps drop.
 */
export function lampCourseAt(minuteOfDay, { sunriseShift = 0, sunsetShift = 0 } = {}) {
    const minute = ((finite(minuteOfDay) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    const at = name => keyMinutes(GRADE_KEYFRAMES.find(key => key.name === name), sunriseShift, sunsetShift);
    const preDawn = at('pre-dawn');
    const sunrise = at('sunrise');
    const golden = at('golden-hour');
    const blue = at('blue-hour');
    if (minute >= blue + 60 || minute < preDawn) return 3;
    if (minute >= blue - 15) return 2;
    if (minute >= (golden + blue) / 2) return 1;
    if (minute < sunrise - 20) return 2;
    if (minute < sunrise + 30) return 1;
    return 0;
}

// The lamps' share of the pool gain: the lamp course's own share from the
// lamplight course on, nothing before it.
function lampCarry(minuteOfDay, sunriseShift, sunsetShift) {
    const course = lampCourseAt(minuteOfDay, { sunriseShift, sunsetShift });
    return course >= 2 ? course / 3 : 0;
}
