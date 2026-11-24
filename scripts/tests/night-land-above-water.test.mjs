import test from 'node:test';
import assert from 'node:assert/strict';

import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { applyWaterMood, waterMoodFor } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    applyGradeToRgb,
    capSaturation,
    evaluateGrade,
    waterMaxSaturation,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';

// NE P2.4 (G1 F4) — land must stay perceptually brighter than the night sea
// so daytime water-ramp lifts cannot silently invert the island/sea separation
// again. Water stops pass through CoastBake.applyWaterMood -> applyGradeToRgb
// -> capSaturation; land stops (C1 grass, road, plaza) pass through
// applyGradeToRgb.
const CLEAR = { type: 'clear', cloudCover: 0.08 };

const rgb01 = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function cieLStar(rgb) {
    const y = 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

const LAND_STOPS = [...ART_RAMPS.grass, ...ART_RAMPS.road, ...ART_RAMPS.plaza].map(rgb01);
const WATER_STOPS = [...ART_RAMPS.deepWater, ...ART_RAMPS.shallowWater].map(rgb01);

const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;

function nightSeparationAt(hour, moonFill = 0.5) {
    const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: CLEAR, moonFill });
    const mood = waterMoodFor({ lightGrade: grade, weather: CLEAR });
    const maxS = waterMaxSaturation(mood);
    const landMeanL = mean(LAND_STOPS.map(rgb => cieLStar(applyGradeToRgb(rgb, grade))));
    const waterMeanL = mean(WATER_STOPS.map(rgb => cieLStar(
        capSaturation(applyGradeToRgb(applyWaterMood(rgb, mood), grade), maxS),
    )));
    return { landMeanL, waterMeanL, delta: landMeanL - waterMeanL, mood };
}

test('NE P2.4: land mean L* sits above water mean L* at 22:00 and 02:00', () => {
    // Measured +7.69 (02:00, new moon) to +8.60 L* (22:00, moon 0.7) with the
    // NE P2.1 grade and the P2.4 18% night water (2026-11-24); the floor sits
    // about 1 L* under the smallest, so a lighter sea or a darker land fails.
    const MIN_MARGIN = 6.5;
    for (const hour of [22, 2]) {
        for (const moonFill of [0, 0.5, 0.7]) {
            const { landMeanL, waterMeanL, delta, mood } = nightSeparationAt(hour, moonFill);
            assert.equal(mood.night, 1, `${hour}:00 should be full water night mood`);
            assert.ok(
                landMeanL > waterMeanL + MIN_MARGIN,
                `${hour}:00 (moon=${moonFill}): land L* ${landMeanL.toFixed(2)} must exceed water L* ${waterMeanL.toFixed(2)} + ${MIN_MARGIN} (delta ${delta.toFixed(2)})`,
            );
        }
    }
});

test('NE P2.4: blue hour water mood stays below the 0.5 smoothstep knee (byte-identical)', () => {
    const blue = evaluateGrade({ minuteOfDay: 19.75 * 60, weather: CLEAR, moonFill: 0.5 });
    const mood = waterMoodFor({ lightGrade: blue, weather: CLEAR });
    assert.ok(mood.night <= 0.5, `blue hour water night mood ${mood.night} <= 0.5`);
    for (const rgb of WATER_STOPS) {
        const l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        const k = mood.night * 0.55;
        const legacy = [0.78, 0.94, 1.10].map((tone, i) => Math.max(0, Math.min(1, (rgb[i] + (l * tone - rgb[i]) * k) * (1 - mood.night * 0.1))));
        assert.deepEqual(applyWaterMood(rgb, mood), legacy, 'blue-hour water mood must stay byte-identical');
    }
});
