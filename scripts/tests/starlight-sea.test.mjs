import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { canvasSeaMarkRgb, COAST_PALETTE, OCEAN_HORIZON_WORLD_Y } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { createWaterFx, resolveStarlight, resolveWaterFx } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { SEA_SWELL_GLSL, STARLIGHT_DENSITY, STARLIGHT_HOLD } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { WATER_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/water.js';
import { FRAME_UNIFORM_LAYOUT, createUniformViews, writeFrameUniforms } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';

const snapshot = (day, hour = 23) => createAtmosphereSnapshot({
    now: new Date(2026, 9, day, 12), hourOverride: hour,
    weatherOverride: 'clear', timelineMode: 'fixed',
});
const density = (a, level = 0) => resolveStarlight(a, a.weather, a.lightGrade, a.lighting.moonFill, level);

test('night starlight multiplies only the clock, star visibility, weather and moon terms', () => {
    const a = { sky: { starsAlpha: 0.7 } };
    const weather = { type: 'clear', cloudCover: 0.2 };
    const grade = { night: 0.8 };
    const at = (moon, level = 0, w = weather, g = grade) => resolveStarlight(a, w, g, moon, level);
    assert.equal(at(0.1), 0.8 * 0.7 * 0.8 * 0.9 * 0.9);
    assert.equal(at(1), 0);
    assert.equal(at(0, 2), 0, 'MINIMAL drops sparkle rather than adding another static layer');
    assert.equal(at(0, 3), 0);
    assert.equal(at(0, 1), at(0), 'REDUCED keeps sparse sparkle');
    for (const type of ['rain', 'storm']) assert.equal(at(0, 0, { ...weather, type }), 0);
    assert.equal(at(0, 0, { ...weather, cloudCover: 1 }), 0);
    assert.equal(at(0, 0, weather, { night: 0 }), 0);
    assert.equal(resolveStarlight({ sky: { starsAlpha: 0 } }, weather, grade, 0, 0), 0);
});

test('October new moon leaves glints, full moon hands over to the path, noon stays unchanged', () => {
    const newMoon = snapshot(9);
    const fullMoon = snapshot(26);
    assert.ok(density(newMoon) > 0.15, 'new-moon clear night admits sparkle');
    assert.ok(density(fullMoon) < density(newMoon) * 0.1, 'full moon admits fewer than a tenth');
    assert.equal(density(snapshot(9, 12)), 0);
    const feed = { atmosphere: newMoon, weather: newMoon.weather, motionScale: 1, reducedMotion: true };
    const out = createWaterFx();
    const water = resolveWaterFx(feed, { zoom: 1 }, 0, newMoon.lightGrade, newMoon.lighting.moonFill, 1568, out);
    assert.equal(water, out, 'existing reusable result owns the scalar');
    assert.equal(water.fx[0], 0, 'reduced motion holds the water frame');
    assert.equal(water.starlight, density(newMoon), 'held tips retain their night density');
    resolveWaterFx(feed, { zoom: 1 }, 2, newMoon.lightGrade, newMoon.lighting.moonFill, 1568, out);
    assert.equal(out.starlight, 0, 'reused state clears when the budget sheds');
});

function helper(source) {
    return source.match(/(?:bool starlightAt|fn starlightAt)[^{]+\{([\s\S]*?)\n\}/)[1];
}
function normalized(source) {
    return helper(source).replace(/\b(?:let|float|vec2)\s+/g, 'const ')
        .replace(/vec2f\(/g, 'vec2(').replace(/[{}\s]/g, '');
}

test('GLSL and WGSL starlight hash, cap gate, tips and held cadence are identical', () => {
    assert.equal(normalized(WATER_WGSL), normalized(SEA_SWELL_GLSL));
    assert.ok(helper(SEA_SWELL_GLSL).includes(`${STARLIGHT_DENSITY.toFixed(2)} * strength`));
    assert.ok(helper(SEA_SWELL_GLSL).includes(`seed * ${STARLIGHT_HOLD.toFixed(1)}`));
    const canvas = readFileSync(new URL('../../claudeville/src/presentation/character-mode/CanvasWaterState.js', import.meta.url), 'utf8');
    assert.match(canvas, /resolveStarlight\(atmosphere, weather, grade, atmosphere\?\.lighting\?\.moonFill/);
    assert.match(canvas, /fx\.deepTick \+ Math\.floor\(seed \* STARLIGHT_HOLD\)/);
    assert.match(canvas, /hash12\(cx \+ 311 \+ life \* 7, y \+ 47 \+ life \* 3\) >= STARLIGHT_DENSITY \* fx\.starlight/);
    assert.match(canvas, /if \(riseMap\[p\] <= 0\) continue/);
    assert.match(canvas, /let colour = palette\.classes\[CLS_CREST\]/);
    assert.match(canvas, /canvasSeaMarkRgb\(renderer, 'crest', x, y, true\)/);
});

test('the appended WebGPU scalar stages without shifting the existing frame fields', () => {
    const last = FRAME_UNIFORM_LAYOUT.fields.at(-1);
    assert.equal(last.name, 'starlight');
    const cloudLone = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'cloudLone');
    assert.equal(last.offset, cloudLone.offset + 16);
    const views = createUniformViews(FRAME_UNIFORM_LAYOUT.size);
    writeFrameUniforms(views, { starlight: 0.375 });
    assert.equal(views.f32[last.offset / 4], 0.375);
});

test('Canvas named crest keeps its own water stop and takes the same horizon haze', () => {
    const water = Array.from({ length: COAST_PALETTE.stops.length + 2 }, (_, i) => [20 + i, 40 + i, 60 + i]);
    const palette = {
        water,
        graded: { water: water.map(rgb => rgb.map(c => c / 255)), haze: [40 / 255, 60 / 255, 80 / 255], horizon: [0.3, 0.4, 0.5] },
        preimage: rgb => rgb,
    };
    const spec = { palette, hazeRows: 30, shades: new Map() };
    const renderer = { _outerOcean: { spec, stripRows: 400 } };
    const far = OCEAN_HORIZON_WORLD_Y + 500;
    const crest = water.at(-1);
    assert.equal(canvasSeaMarkRgb(renderer, 'crest', 0, far, true), (crest[0] << 16) | (crest[1] << 8) | crest[2]);
    const trough = water.at(-2);
    assert.equal(canvasSeaMarkRgb(renderer, 999, 0, far, true), (trough[0] << 16) | (trough[1] << 8) | trough[2], 'numeric stops keep their old clamp');
    assert.equal(canvasSeaMarkRgb(renderer, 'crest', 0, OCEAN_HORIZON_WORLD_Y, true), 0x283c50, 'haze covers starlight at the horizon as on GPU');
    assert.equal(canvasSeaMarkRgb(null, 'crest', 0, far, true), -1);
});
