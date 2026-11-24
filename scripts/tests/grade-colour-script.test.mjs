import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
  GRADE_AMBIENT_FLOOR,
  GRADE_EXPOSURE_FLOOR,
  GRADE_KEYFRAMES,
  WATER_DAY_MAX_SATURATION,
  WATER_MAX_SATURATION,
  WATER_NIGHT_MAX_SATURATION,
  applyGradeToRgb,
  capSaturation,
  evaluateGrade,
  gradeKeysAt,
  waterMaxSaturation,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { AtmosphereState, sourceEnergyEnvelope } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { canvasGradeGain, canvasGradeMultiply, canvasGradeRgb } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { aerialHazeStart, aerialPerspectiveStrength, clearDayHazeWeight, clearNightHazeWeight, hasActiveBloomEmitters, isDaytimeHighEnergyBuilding } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { resolveAtmosphereCourses } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

// V6 — the colour script, asserted on the C1 ramps in rough island
// proportions (grass-majority land, landmarks, a sea share), graded through
// the CPU mirror of the shader grade. The pinned capture series is the visual
// acceptance; this is the deterministic floor under it.
const ISLAND_SHARE = {
  grass: 30, dirt: 8, road: 6, plaza: 6, sand: 4, foliage: 12,
  stone: 10, timber: 5, slate: 6, deepWater: 8, shallowWater: 5,
};
const CLEAR = { type: 'clear', cloudCover: 0.08 };

function rgb01(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
}

const SAMPLES = Object.entries(ISLAND_SHARE).flatMap(([ramp, share]) => ART_RAMPS[ramp].map(hex => ({
  rgb: rgb01(hex),
  weight: share / ART_RAMPS[ramp].length,
  water: ramp === 'deepWater' || ramp === 'shallowWater',
})));

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const saturation = (c) => {
  const max = Math.max(...c);
  return max > 0 ? (max - Math.min(...c)) / max : 0;
};

// Frame metrics in the evidence notes' units (0..255): mean luma Y, mean
// saturation S, mean R−B, the key (top 15 % luma) and fill (bottom 30 %) R−B.
function scriptAt(hour, samples = SAMPLES) {
  const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: CLEAR, moonFill: 0 });
  const pixels = samples
    .map(sample => ({ c: applyGradeToRgb(sample.rgb, grade), weight: sample.weight }))
    .sort((a, b) => luma(a.c) - luma(b.c));
  const total = pixels.reduce((sum, pixel) => sum + pixel.weight, 0);
  const fill = [];
  const key = [];
  let seen = 0;
  for (const pixel of pixels) {
    if (seen < total * 0.30) fill.push(pixel);
    seen += pixel.weight;
    if (seen > total * 0.85) key.push(pixel);
  }
  const mean = (list, f) => list.reduce((sum, p) => sum + f(p.c) * p.weight, 0)
    / list.reduce((sum, p) => sum + p.weight, 0);
  const redMinusBlue = c => (c[0] - c[2]) * 255;
  return {
    Y: mean(pixels, c => luma(c) * 255),
    S: mean(pixels, saturation),
    RB: mean(pixels, redMinusBlue),
    key: mean(key, redMinusBlue),
    fill: mean(fill, redMinusBlue),
  };
}

test('the eight key names stay: the audio arrangement couples to them', () => {
  assert.deepEqual(GRADE_KEYFRAMES.map(key => key.name), [
    'deep-night', 'pre-dawn', 'sunrise', 'morning', 'noon', 'golden-hour', 'blue-hour', 'night',
  ]);
});

test('golden hour is a low sun: more colourful than noon, amber key, cool fill', () => {
  const noon = scriptAt(12.5);
  const golden = scriptAt(18);
  assert.ok(golden.S >= noon.S * 1.15, `golden S ${golden.S.toFixed(3)} vs noon ${noon.S.toFixed(3)}`);
  assert.ok(golden.key >= 55, `golden key R−B ${golden.key.toFixed(1)}`);
  assert.ok(golden.fill <= -8, `golden fill R−B ${golden.fill.toFixed(1)}`);
});

test('golden saturation stays inside the maintainer band (M17)', () => {
  const golden = GRADE_KEYFRAMES.find(key => key.name === 'golden-hour');
  assert.ok(golden.saturation >= 1.12 && golden.saturation <= 1.20);
});

test('sunrise is rose and mist, not a second golden hour', () => {
  const sunrise = scriptAt(6);
  const golden = scriptAt(18);
  assert.ok(sunrise.key <= golden.key * 0.6, `sunrise key ${sunrise.key.toFixed(1)} vs golden ${golden.key.toFixed(1)}`);
  assert.ok(sunrise.fill <= -5, `sunrise fill R−B ${sunrise.fill.toFixed(1)}`);
});

test('blue hour is bluer than night and never darker; the day arc is strictly monotone into Opus P night', () => {
  const [noon, golden, blue, night, deep] = [12.5, 18, 19.75, 22, 2].map(hour => scriptAt(hour));
  const stormDeepGrade = evaluateGrade({ minuteOfDay: 2 * 60, weather: { type: 'storm', intensity: 0.9, cloudCover: 0.97 }, moonFill: 0 });
  const stormDeepY = SAMPLES.reduce((sum, s) => sum + luma(applyGradeToRgb(s.rgb, stormDeepGrade)) * 255 * s.weight, 0)
    / SAMPLES.reduce((sum, s) => sum + s.weight, 0);
  assert.ok(blue.RB <= -15, `blue-hour R−B ${blue.RB.toFixed(1)}`);
  assert.ok(noon.Y > golden.Y && golden.Y > blue.Y, 'noon > golden > blue');
  assert.ok(blue.Y > night.Y && night.Y > deep.Y && deep.Y > stormDeepY,
    `strict arc blue(${blue.Y.toFixed(1)}) > night(${night.Y.toFixed(1)}) > deep(${deep.Y.toFixed(1)}) > storm-0200(${stormDeepY.toFixed(1)})`);
  // NE P2.1 (operator-chosen Opus P night, 2026-11-24): moonlit cobble (`road[2]`) sits in ~55-65 luma under full moonlight (down from velvet 78-88), while darkest grass stays >= 34.
  const moonlitGrade = evaluateGrade({ minuteOfDay: 22.5 * 60, weather: CLEAR, moonFill: 0.83 });
  const cobbleY = luma(applyGradeToRgb(rgb01(ART_RAMPS.road[2]), moonlitGrade)) * 255;
  const darkGrassY = luma(applyGradeToRgb(rgb01(ART_RAMPS.grass[0]), moonlitGrade)) * 255;
  assert.ok(cobbleY >= 55 && cobbleY <= 65, `moonlit cobble luma ${cobbleY.toFixed(1)} in [55, 65]`);
  assert.ok(darkGrassY >= 34, `darkest grass luma ${darkGrassY.toFixed(1)} >= 34`);
});

test('the sea stays cool at every hour', () => {
  const sea = SAMPLES.filter(sample => sample.water);
  for (let hour = 0; hour < 24; hour += 0.5) {
    const { RB } = scriptAt(hour, sea);
    assert.ok(RB < 0, `sea R−B ${RB.toFixed(1)} at ${hour}h`);
  }
  // V6 / NE v0.67.1 S water saturation cap: 0.44 by day, 0.52 on clear nights,
  // blending back to 0.37 in storm.
  assert.ok(WATER_DAY_MAX_SATURATION >= 0.42 && WATER_DAY_MAX_SATURATION <= 0.46);
  assert.equal(WATER_NIGHT_MAX_SATURATION, 0.52);
  assert.equal(waterMaxSaturation({ night: 0, storm: 0 }), WATER_DAY_MAX_SATURATION);
  assert.equal(waterMaxSaturation({ night: 1, storm: 0 }), WATER_NIGHT_MAX_SATURATION);
  assert.equal(waterMaxSaturation({ night: 0, storm: 1 }), WATER_MAX_SATURATION);
  assert.equal(waterMaxSaturation({ night: 1, storm: 1 }), WATER_MAX_SATURATION);
  const stormGrade = evaluateGrade({ minuteOfDay: 14 * 60, weather: { type: 'storm', intensity: 0.9, cloudCover: 0.97 }, moonFill: 0 });
  const nightGrade = evaluateGrade({ minuteOfDay: 23 * 60, weather: CLEAR, moonFill: 0.5 });
  for (const sample of sea) {
    const stormSat = saturation(capSaturation(applyGradeToRgb(sample.rgb, stormGrade), waterMaxSaturation({ night: 0, storm: 1 })));
    const nightSat = saturation(capSaturation(applyGradeToRgb(sample.rgb, nightGrade), waterMaxSaturation({ night: 1, storm: 0 })));
    assert.ok(stormSat <= WATER_MAX_SATURATION + 1e-6, `storm water S ${stormSat.toFixed(3)} stays quiet`);
    assert.ok(nightSat <= WATER_NIGHT_MAX_SATURATION + 1e-6, `clear-night water S ${nightSat.toFixed(3)} stays inside night cap`);
  }
});

test('gold arrives late: the afternoon holds noon until the approach', () => {
  const golden = GRADE_KEYFRAMES.find(key => key.name === 'golden-hour');
  const at = hour => gradeKeysAt(hour * 60);
  assert.equal(at(15).to, golden);
  assert.ok(at(15).t < 0.2, `15:00 is ${Math.round(at(15).t * 100)} % golden`);
  assert.ok(at(17.5).t > 0.9, `17:30 is ${Math.round(at(17.5).t * 100)} % golden`);
  assert.ok(at(17.5).t < 1 && at(17).t < at(17.5).t, 'still easing in');
});

test('EY-4: falling snow wears a pearl grade, lighter and softer than rain; 0 restores rain, a storm stays a storm', () => {
  const rain = { type: 'rain', precipitation: 0.7, intensity: 0.7, cloudCover: 0.85, fog: 0.18 };
  const storm = { ...rain, type: 'storm' };
  const ambient = grade => luma(grade.ambientTint);
  for (const minuteOfDay of [12 * 60, 18 * 60 + 30, 22 * 60]) {
    const today = evaluateGrade({ minuteOfDay, weather: rain });
    assert.deepEqual(evaluateGrade({ minuteOfDay, weather: rain, snowfall: 0 }), today);
    const half = evaluateGrade({ minuteOfDay, weather: rain, snowfall: 0.5 });
    const snow = evaluateGrade({ minuteOfDay, weather: rain, snowfall: 1 });
    const clear = evaluateGrade({ minuteOfDay, weather: CLEAR });
    assert.ok(ambient(today) < ambient(half) && ambient(half) < ambient(snow), String(minuteOfDay));
    assert.ok(ambient(snow) < ambient(clear), String(minuteOfDay));
    assert.ok(snow.saturation > today.saturation);
    assert.deepEqual(evaluateGrade({ minuteOfDay, weather: storm, snowfall: 1 }), evaluateGrade({ minuteOfDay, weather: storm }));
  }
  // The snapshot: settling snow (a winter rain knot) takes the row at the
  // look strength; the same knot in May, or ey4 at 0, keeps today's rain.
  const snapshotGrade = month => {
    const state = new AtmosphereState({ nowProvider: () => new Date(2027, month, 12, 12) });
    state.setTimelineKnots([{ ...rain, minute: 0 }]);
    return state.update().lightGrade;
  };
  try {
    const may = snapshotGrade(4);
    const january = snapshotGrade(0);
    setLookStrength('ey4', 0);
    assert.ok(ambient(january) > ambient(snapshotGrade(0)) + 0.04);
    assert.equal(ambient(snapshotGrade(4)), ambient(may));
    // The memo keys on the exact strength: a faint snow row never lingers at 0.
    setLookStrength('ey4', 0.02);
    const faint = ambient(snapshotGrade(0));
    setLookStrength('ey4', 0);
    assert.ok(faint > ambient(snapshotGrade(0)));
  } finally {
    resetLookStrengths();
  }
});

test('clearly sunny daylight: bright warm-key noon, distinct crisp morning, wide clear-vs-overcast gap, and Canvas gain pass', () => {
  const morning = evaluateGrade({ minuteOfDay: 8.5 * 60, weather: CLEAR, moonFill: 0 });
  const noon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: CLEAR, moonFill: 0 });
  const overcast = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: { type: 'overcast', intensity: 0.68, cloudCover: 0.86 }, moonFill: 0 });
  const night = evaluateGrade({ minuteOfDay: 23 * 60, weather: CLEAR, moonFill: 0 });
  // Toned back 2026-11-24 (operator decision: too bright) from 1.16 / 1.06 / 0.10.
  assert.ok(noon.exposure >= 1.06 && noon.exposure <= 1.10, `noon exposure ${noon.exposure}`);
  assert.ok(morning.exposure >= 1.04 && morning.exposure < noon.exposure, `morning ${morning.exposure} < noon ${noon.exposure}`);
  assert.ok(noon.vignetteAlpha <= 0.18 && morning.vignetteAlpha <= 0.14, 'lightened daytime vignette');
  assert.ok(noon.highlightTint[0] > noon.highlightTint[2] && noon.shadowTint[2] > noon.shadowTint[0], 'warm key over cool fill');
  assert.ok(overcast.exposure <= 1.02, `overcast flattens clear exposure boost (${overcast.exposure})`);
  const noonY = SAMPLES.reduce((s, p) => s + luma(applyGradeToRgb(p.rgb, noon)) * 255 * p.weight, 0) / SAMPLES.reduce((s, p) => s + p.weight, 0);
  const overcastY = SAMPLES.reduce((s, p) => s + luma(applyGradeToRgb(p.rgb, overcast)) * 255 * p.weight, 0) / SAMPLES.reduce((s, p) => s + p.weight, 0);
  assert.ok(noonY - overcastY >= 18, `clear noon (${noonY.toFixed(1)}) - overcast noon (${overcastY.toFixed(1)}) >= 18`);
  // CanvasGrade gain pass lifts exposure > 1 at noon and is a no-op at night/overcast/neutral.
  assert.ok(canvasGradeGain(noon).some(g => g > 1.08), 'Canvas noon gain > 1');
  assert.deepEqual(canvasGradeGain(night), [1, 1, 1], 'Canvas night gain is a no-op');
  assert.deepEqual(canvasGradeGain({ ...noon, exposure: 1 }), [1, 1, 1], 'Canvas neutral exposure skips color-dodge');
  assert.ok(luma(canvasGradeRgb([0.5, 0.5, 0.5], noon)) > 0.54, 'Canvas gain pass lifts mid-grey past 0.5');
  assert.deepEqual(canvasGradeMultiply(noon), [1, 1, 1], 'noon multiply caps at 1 while gain carries excess');
  // Clear-daylight haze lightens only in clear daytime air; overcast/default, storm and fog equal base exactly (clear nights use clearNightHazeWeight, tested below).
  assert.equal(clearDayHazeWeight(0, 1, 0.08), 1);
  assert.equal(clearDayHazeWeight(0, 0, 0.08), 0, 'night weight is 0');
  assert.equal(clearDayHazeWeight(0.34, 1, 1), 0, 'storm weight is 0');
  assert.equal(aerialHazeStart(0, 1), 0.30);
  assert.equal(aerialHazeStart(0, 0), 0.55);
  assert.equal(aerialHazeStart(0.9, 1), 0.55);
  assert.equal(aerialPerspectiveStrength(1, 0, 0), 0.14, 'default/overcast equals base');
  assert.equal(aerialPerspectiveStrength(1, 0.34, 0), 0.14 * 1.34, 'storm equals base');
  assert.equal(aerialPerspectiveStrength(1, 0, 1), 0.06, 'clear day drops haze');
  assert.ok(aerialPerspectiveStrength(1, 0.9, 1) >= 0.26, 'fog raises haze monotonically');
  // Daylight sourceEnergy keeps base core/bloom; daytime bloom gates on working buildings only.
  const dayEnergy = sourceEnergyEnvelope(12 * 60);
  assert.equal(dayEnergy.core, 0.14);
  assert.equal(dayEnergy.bloom, 0.12);
  assert.equal(isDaytimeHighEnergyBuilding('forge', true, 1), true);
  assert.equal(isDaytimeHighEnergyBuilding('forge', false, 1), false);
  assert.equal(isDaytimeHighEnergyBuilding('portal', true, 1), true);
  assert.equal(isDaytimeHighEnergyBuilding('archive', true, 1), false);
  assert.equal(hasActiveBloomEmitters([{ emissiveSource: {}, records: [{ daytimeEmitter: true, emissiveGate: 1 }] }]), true);
  assert.equal(hasActiveBloomEmitters([{ emissiveSource: {}, records: [{ daytimeEmitter: false, emissiveGate: 1 }] }]), false);
});

test('NE v0.67.1 B: night and deep-night highlightTint drops green bias to [0.92, 0.97, 1.04]; day unchanged', () => {
  const byName = name => GRADE_KEYFRAMES.find(key => key.name === name);
  assert.deepEqual(byName('night').highlightTint, [0.92, 0.97, 1.04]);
  assert.deepEqual(byName('deep-night').highlightTint, [0.92, 0.97, 1.04]);
  assert.deepEqual(byName('noon').highlightTint, [1.10, 1.06, 0.94]);
  // Pale unlit plaster/stone (luma > 0.38) shifts silver-blue with less green than the old [0.96, 1.04, 1.02].
  const nightGrade = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.78 });
  const oldNightGrade = { ...nightGrade, highlightTint: [0.96, 1.04, 1.02] };
  const paleStone = [0.76, 0.76, 0.73];
  const now = applyGradeToRgb(paleStone, nightGrade);
  const old = applyGradeToRgb(paleStone, oldNightGrade);
  assert.ok(now[2] > now[1] && now[1] > now[0], `silver-blue highlight order (${now.map(v => v.toFixed(3))})`);
  assert.ok(now[1] / now[2] < old[1] / old[2], 'green-to-blue ratio drops on pale highlights');
});

test('NE v0.67.1 D: deep-night exposure steps to 0.51; clear/rain 02:00 stay off floor, storm stays darker than clear, day unchanged', () => {
  const deepKey = GRADE_KEYFRAMES.find(key => key.name === 'deep-night');
  const nightKey = GRADE_KEYFRAMES.find(key => key.name === 'night');
  const noonKey = GRADE_KEYFRAMES.find(key => key.name === 'noon');
  assert.equal(deepKey.exposure, 0.51);
  assert.equal(nightKey.exposure, 0.58);
  assert.equal(noonKey.exposure, 1.08);
  const rain = { type: 'rain', intensity: 0.82, cloudCover: 0.92 };
  const storm = { type: 'storm', intensity: 0.9, cloudCover: 0.97 };
  const clear02 = evaluateGrade({ minuteOfDay: 2 * 60, weather: CLEAR, moonFill: 0 });
  const rain02 = evaluateGrade({ minuteOfDay: 2 * 60, weather: rain, moonFill: 0 });
  const storm02 = evaluateGrade({ minuteOfDay: 2 * 60, weather: storm, moonFill: 0 });
  assert.equal(clear02.exposure, 0.51, 'clear 02:00 exposure unclamped');
  assert.equal(rain02.exposure, 0.51, 'rain 02:00 exposure unclamped');
  assert.ok(clear02.exposure > GRADE_EXPOSURE_FLOOR && luma(clear02.ambientTint) > GRADE_AMBIENT_FLOOR);
  assert.ok(luma(rain02.ambientTint) > GRADE_AMBIENT_FLOOR, 'rain 02:00 stays above ambient floor');
  assert.ok(luma(storm02.ambientTint) >= GRADE_AMBIENT_FLOOR - 1e-6, 'storm 02:00 stays readable at floor');
  assert.ok(luma(storm02.ambientTint) < luma(clear02.ambientTint), 'storm 02:00 ambient stays below clear 02:00');
  const weightedY = grade => SAMPLES.reduce((sum, s) => sum + luma(applyGradeToRgb(s.rgb, grade)) * 255 * s.weight, 0)
    / SAMPLES.reduce((sum, s) => sum + s.weight, 0);
  assert.ok(weightedY(storm02) < weightedY(clear02), `storm 02:00 (${weightedY(storm02).toFixed(2)}) < clear 02:00 (${weightedY(clear02).toFixed(2)})`);
  for (const rgb of [[0.34, 0.46, 0.22], [0.58, 0.55, 0.50], [0.30, 0.36, 0.46]]) {
    assert.ok(luma(applyGradeToRgb(rgb, storm02)) < luma(applyGradeToRgb(rgb, clear02)), 'storm 02:00 midtone strictly darker than clear');
  }
});

test('NE v0.67.1 R: night weather desaturation eases to 45 % weight while day weather stays unchanged', () => {
  const rain = { type: 'rain', intensity: 0.82, cloudCover: 0.92 };
  const storm = { type: 'storm', intensity: 0.9, cloudCover: 0.97 };
  const clearNight = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0 });
  const rainNight = evaluateGrade({ minuteOfDay: 22 * 60, weather: rain, moonFill: 0 });
  const snowNight = evaluateGrade({ minuteOfDay: 22 * 60, weather: rain, moonFill: 0, snowfall: 1 });
  const stormNight = evaluateGrade({ minuteOfDay: 22 * 60, weather: storm, moonFill: 0 });
  const expectedRainNightSat = clearNight.saturation * (1 + (0.74 - 1) * 0.45);
  assert.ok(Math.abs(rainNight.saturation - expectedRainNightSat) < 1e-9, `22:00 rain sat ${rainNight.saturation} === ${expectedRainNightSat}`);
  assert.ok(rainNight.saturation > clearNight.saturation * 0.74, 'night rain keeps more colour than daytime full weight');
  assert.ok(clearNight.saturation > snowNight.saturation && snowNight.saturation > rainNight.saturation && rainNight.saturation > stormNight.saturation,
    'night saturation ordering clear > snow > rain > storm holds');
  // Daytime (night = 0): weather desaturation weight stays 100 % (unchanged).
  const clearNoon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: CLEAR, moonFill: 0 });
  const rainNoon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: rain, moonFill: 0 });
  const stormNoon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: storm, moonFill: 0 });
  assert.ok(Math.abs(rainNoon.saturation - clearNoon.saturation * 0.74) < 1e-9, 'noon rain keeps full 0.74 multiplier');
  assert.ok(Math.abs(stormNoon.saturation - clearNoon.saturation * 0.62) < 1e-9, 'noon storm keeps full 0.62 multiplier');
});

test('NE v0.67.1 S: clear-night water cap rises to 0.52 while day stays 0.44 and storm stays 0.37', () => {
  assert.equal(WATER_DAY_MAX_SATURATION, 0.44);
  assert.equal(WATER_NIGHT_MAX_SATURATION, 0.52);
  assert.equal(WATER_MAX_SATURATION, 0.37);
  assert.equal(waterMaxSaturation({ night: 0, storm: 0 }), 0.44);
  assert.equal(waterMaxSaturation({ night: 1, storm: 0 }), 0.52);
  assert.equal(waterMaxSaturation({ night: 0, storm: 1 }), 0.37);
  assert.equal(waterMaxSaturation({ night: 1, storm: 1 }), 0.37);
  assert.ok(Math.abs(waterMaxSaturation({ night: 0.5, storm: 0 }) - 0.48) < 1e-9);
  assert.ok(Math.abs(waterMaxSaturation({ night: 1, storm: 0.5 }) - 0.445) < 1e-9);
  // Clear-night deep water gains chroma over the old 0.37 cap at identical luma.
  const nightGrade = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.78 });
  const rawDeep = applyGradeToRgb(rgb01(ART_RAMPS.deepWater[1]), nightGrade);
  const oldCapped = capSaturation(rawDeep, WATER_MAX_SATURATION);
  const newCapped = capSaturation(rawDeep, waterMaxSaturation({ night: 1, storm: 0 }));
  assert.ok(saturation(newCapped) > saturation(oldCapped), 'clear-night water is richer than under 0.37');
  assert.ok(Math.abs(luma(newCapped) - luma(oldCapped)) < 1e-6, 'luma stays invariant under saturation cap');
});

test('NE v0.67.1 C: clear nights shed overcast haze (0.06 strength, 0.35 start, haze*4 desat); day, blue hour, overcast, storm and fog unchanged', () => {
  assert.equal(clearNightHazeWeight(0, 1, 0.08), 1, 'crisp clear night reaches 1');
  assert.equal(clearNightHazeWeight(0, 0, 0.08), 0, 'day weight is 0');
  assert.equal(clearNightHazeWeight(0, 0.5, 0.08), 0, 'blue-hour gate stays 0');
  assert.equal(clearNightHazeWeight(0.05, 1, 0.08), 0, 'foggy night stays 0');
  assert.equal(clearNightHazeWeight(0, 1, 0.35), 0, 'cloudy night stays 0');
  assert.ok(Math.abs(aerialPerspectiveStrength(0.5, 0, 0, 1) - 0.08) < 1e-12);
  assert.ok(Math.abs(aerialPerspectiveStrength(1, 0, 0, 1) - 0.06) < 1e-12);
  assert.ok(Math.abs(aerialPerspectiveStrength(2, 0, 0, 1) - 0.03) < 1e-12);
  assert.ok(Math.abs(aerialPerspectiveStrength(3, 0, 0, 1) - 0.01) < 1e-12);
  assert.equal(aerialHazeStart(0, 0, 1), 0.35);
  assert.equal(aerialHazeStart(0, 1, 0), 0.30, 'clear day start unchanged');
  assert.equal(aerialHazeStart(0.9, 0, 1), 0.55, 'fog keeps 0.55 start');
  const clearNightGrade = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.78 });
  const noonGrade = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: CLEAR, moonFill: 0 });
  const nightClear = resolveAtmosphereCourses(0, { zoom: 1 }, { atmosphere: { weather: { type: 'clear', fog: 0, cloudCover: 0.08 } } }, clearNightGrade);
  assert.equal(nightClear.aerialHaze, 0.06);
  assert.equal(nightClear.hazeStart, 0.35);
  const nightOvercast = resolveAtmosphereCourses(0, { zoom: 1 }, { atmosphere: { weather: { type: 'overcast', fog: 0, cloudCover: 0.86 } } }, clearNightGrade);
  assert.equal(nightOvercast.aerialHaze, 0.14);
  assert.equal(nightOvercast.hazeStart, 0.55);
  const nightStorm = resolveAtmosphereCourses(0, { zoom: 1 }, { atmosphere: { weather: { type: 'storm', fog: 0.34, cloudCover: 1 } } }, clearNightGrade);
  assert.equal(nightStorm.hazeStart, 0.55);
  assert.ok(Math.abs(nightStorm.aerialHaze - 0.14 * 1.34) < 1e-9);
  const dayClear = resolveAtmosphereCourses(0, { zoom: 1 }, { atmosphere: { weather: { type: 'clear', fog: 0, cloudCover: 0.08 } } }, noonGrade);
  assert.equal(dayClear.aerialHaze, 0.06);
  assert.equal(dayClear.hazeStart, 0.30);
  // WGSL/GLSL twin parity: clearAir at hazeStart 0.35 caps desaturation at haze * 4.0.
  const glsl = readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js', import.meta.url), 'utf8');
  const wgsl = readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/wgsl/atmosphere.js', import.meta.url), 'utf8');
  assert.ok(glsl.includes('float clearAir = clamp((0.55 - hazeStart) / 0.25, 0.0, 1.0);'));
  assert.ok(wgsl.includes('let clearAir = clamp((0.55 - hazeStart) / 0.25, 0.0, 1.0);'));
  assert.ok(glsl.includes('min(1.0, haze * mix(8.0, 3.0, clearAir))'));
  assert.ok(wgsl.includes('min(1.0, haze * mix(8.0, 3.0, clearAir))'));
});
