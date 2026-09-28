import test from 'node:test';
import assert from 'node:assert/strict';

import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
  GRADE_KEYFRAMES,
  applyGradeToRgb,
  evaluateGrade,
  gradeKeysAt,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';

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

test('blue hour is bluer than night and never darker; the day arc is monotone', () => {
  const [noon, golden, blue, night, deep] = [12.5, 18, 19.75, 22, 2].map(hour => scriptAt(hour));
  assert.ok(blue.RB <= -15, `blue-hour R−B ${blue.RB.toFixed(1)}`);
  assert.ok(noon.Y > golden.Y && golden.Y > blue.Y, 'noon > golden > blue');
  assert.ok(blue.Y >= night.Y && night.Y >= deep.Y, 'blue >= night >= deep night');
});

test('the sea stays cool at every hour', () => {
  const sea = SAMPLES.filter(sample => sample.water);
  for (let hour = 0; hour < 24; hour += 0.5) {
    const { RB } = scriptAt(hour, sea);
    assert.ok(RB < 0, `sea R−B ${RB.toFixed(1)} at ${hour}h`);
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
