import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { applyWaterMood, canvasSeaMarkRgb, COAST_PALETTE, DRY_SAND_NIGHT_SCALE, foamNightScale, OCEAN_HORIZON_WORLD_Y, WATER_FOAM_NIGHT_DIM } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { createWaterFx, resolveStarlight, resolveWaterFx } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import {
    liftMoonPathRgb,
    MOON_PATH_SILVER_TINT,
    MOON_PATH_UNGRADE_MIX,
    SEA_SWELL_GLSL,
    STARLIGHT_DENSITY,
    STARLIGHT_HOLD,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { applyGradeToRgb, evaluateGrade, waterMaxSaturation } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { waterMoodFor } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { OPEN_SEA_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/openSea.js';
import { SCENE_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/scene.js';
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
    // NE P3.3 — moon attenuation keeps a 0.25 floor: 0.25 + 0.75 * darkMoon^2.
    assert.equal(at(0.1), 0.8 * 0.7 * 0.8 * (0.25 + 0.75 * 0.9 * 0.9));
    assert.equal(at(1), 0.8 * 0.7 * 0.8 * 0.25);
    assert.equal(at(0), 0.8 * 0.7 * 0.8);
    assert.equal(at(0, 2), 0, 'MINIMAL drops sparkle rather than adding another static layer');
    assert.equal(at(0, 3), 0);
    assert.equal(at(0, 1), at(0), 'REDUCED keeps sparse sparkle');
    for (const type of ['rain', 'storm']) assert.equal(at(0, 0, { ...weather, type }), 0);
    assert.equal(at(0, 0, { ...weather, cloudCover: 1 }), 0);
    assert.equal(at(0, 0, weather, { night: 0 }), 0);
    assert.equal(resolveStarlight({ sky: { starsAlpha: 0 } }, weather, grade, 0, 0), 0);
});

test('October new moon leaves glints, full moon keeps a 0.25 starlight floor, noon stays unchanged', () => {
    const newMoon = snapshot(9);
    const fullMoon = snapshot(26);
    assert.ok(density(newMoon) > 0.15, 'new-moon clear night admits sparkle');
    assert.ok(density(fullMoon) > 0 && density(fullMoon) < density(newMoon) * 0.4,
        `full moon keeps a faint starlight floor (${density(fullMoon).toFixed(4)} vs ${density(newMoon).toFixed(4)})`);
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
    // NE v0.67.1 F: starlight keeps the un-dimmed crest colour while shoreline foam dims at night.
    assert.match(canvas, /let colour = palette\.starlight/);
    assert.match(canvas, /canvasSeaMarkRgb\(renderer, 'crest', x, y, true\)/);
});

test('the appended WebGPU scalar stages without shifting the existing frame fields', () => {
    const starlight = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'starlight');
    const cloudLone = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'cloudLone');
    assert.equal(starlight.offset, cloudLone.offset + 16);
    // E2-01's sky on the sea, E2-03's swell drift, BI-1's still water and
    // BI-8's surf glow, MS-1's mist and SEA-1's lift are appended after it,
    // so starlight keeps its slot.
    const names = FRAME_UNIFORM_LAYOUT.fields.map(f => f.name);
    assert.deepEqual(names.slice(names.indexOf('starlight')), ['starlight', 'waterSky', 'swellDrift', 'stillWater', 'surfGlow', 'mist', 'seaLift', 'firelight', 'seaState', 'groundWeather', 'mistBurn', 'shadeRect', 'shade', 'mirrorRect', 'mirrorBreak', 'hazeStart', 'dawnShare', 'crestFlash', 'skyFar', 'skyNear', 'faceKey', 'faceExtra', 'planarRect', 'basinParams', 'depthRange', 'frontier']);
    const sky = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'waterSky');
    const drift = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'swellDrift');
    const still = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'stillWater');
    const glow = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'surfGlow');
    assert.ok(still.offset > drift.offset && glow.offset > still.offset, 'appended after the swell drift');
    const views = createUniformViews(FRAME_UNIFORM_LAYOUT.size);
    writeFrameUniforms(views, { starlight: 0.375, waterSky: [0.25, 0.5, 0.75, 0.125], swellDrift: 4097, stillWater: [1, 0.5], surfGlow: 0.25 });
    assert.equal(views.f32[starlight.offset / 4], 0.375);
    assert.deepEqual(Array.from(views.f32.slice(sky.offset / 4, sky.offset / 4 + 4)), [0.25, 0.5, 0.75, 0.125]);
    assert.equal(views.f32[drift.offset / 4], 4097);
    assert.deepEqual(Array.from(views.f32.slice(still.offset / 4, still.offset / 4 + 2)), [1, 0.5]);
    assert.equal(views.f32[glow.offset / 4], 0.25);
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

test('NE P2.4 (relaxes L1-4): the night sea drops 18 % at full night and keeps blue hour byte-identical in all three twins', () => {
    const rgb = [0.19, 0.26, 0.29];
    const l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const expectedAt = (night, scale) => [0.78, 0.94, 1.10].map((tone, i) => (rgb[i] + (l * tone - rgb[i]) * (night * 0.55)) * scale);
    // Full night (n = 1): 1 - 0.1 - 0.08 = 0.82 (18 % drop).
    applyWaterMood(rgb, { night: 1, storm: 0 }).forEach((channel, i) => assert.ok(Math.abs(channel - expectedAt(1, 0.82)[i]) < 1e-9));
    // Mid-transition (n = 0.75): smoothstep(0.5, 1, 0.75) = 0.5 -> 1 - 0.075 - 0.04 = 0.885.
    applyWaterMood(rgb, { night: 0.75, storm: 0 }).forEach((channel, i) => assert.ok(Math.abs(channel - expectedAt(0.75, 0.885)[i]) < 1e-9));
    // Blue hour (n = 0.375) and the smoothstep floor (n = 0.5): byte-identical to 1 - 0.1 * n.
    assert.deepEqual(applyWaterMood(rgb, { night: 0.375, storm: 0 }), expectedAt(0.375, 1 - 0.375 * 0.1));
    assert.deepEqual(applyWaterMood(rgb, { night: 0.5, storm: 0 }), expectedAt(0.5, 1 - 0.5 * 0.1));
    const glsl = readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js', import.meta.url), 'utf8');
    assert.ok(glsl.includes('color *= 1.0 - u_waterMood.x * 0.1 - 0.08 * smoothstep(0.5, 1.0, u_waterMood.x);'));
    assert.ok(WATER_WGSL.includes('color *= 1.0 - frame.waterMood.x * 0.1 - 0.08 * smoothstep(0.5, 1.0, frame.waterMood.x);'));
});

test('NE P3.3: moon glintDash widens to 0.95, uses 0.28 * pow(w, 1.25) and bright stop 2.0 in all three twins', () => {
    const glintBody = (src) => src.match(/(?:float glintDash|fn glintDash)[^{]+\{([\s\S]*?)\n\}/)[1];
    const wgslMoon = glintBody(WATER_WGSL);
    const glslMoon = glintBody(SEA_SWELL_GLSL);
    const canvas = readFileSync(new URL('../../claudeville/src/presentation/character-mode/CanvasWaterState.js', import.meta.url), 'utf8');
    assert.ok(wgslMoon.includes('select(1.0, 0.95, moon)'));
    assert.ok(wgslMoon.includes('0.28 * glint.y * pow(weight, 1.25)'));
    assert.ok(wgslMoon.includes('select(1.0, 2.0, waterHash12(cell + vec2f(5.0, life * 11.0)) < weight * 0.85)'));
    assert.ok(glslMoon.includes('(moon ? 0.95 : 1.0)'));
    assert.ok(glslMoon.includes('0.28 * glint.y * pow(weight, 1.25)'));
    assert.ok(glslMoon.includes('waterHash12(cell + vec2(5.0, life * 11.0)) < weight * 0.85 ? 2.0 : 1.0'));
    assert.match(canvas, /maxHalf = \(baseWidth \+ \(bottom - view\.y0\) \* grow\) \* \(moon \? 0\.95 : 1\)/);
    assert.match(canvas, /half = \(baseWidth \+ \(y \+ 0\.5 - view\.y0\) \* grow\) \* \(moon \? 0\.95 : 1\)/);
    assert.match(canvas, /density \* glint\.strength \* Math\.pow\(weight, 1\.25\)/);
    assert.match(canvas, /colour = tone < weight \* 0\.85 \? hi : lo/);
    // Guard: sun branch (glint.z < 2.5) stays untouched.
    assert.ok(wgslMoon.includes('return select(1.0, 2.0, waterHash12(cell + vec2f(5.0, glintTick * 11.0)) < weight);'));
    assert.ok(glslMoon.includes('return waterHash12(cell + vec2(5.0, glintTick * 11.0)) < weight ? 2.0 : 1.0;'));
});

test('NE P3.3b: moon path lifts out of the night grade only at night and only for moon glints across all twins', () => {
    assert.ok(MOON_PATH_UNGRADE_MIX > 0 && MOON_PATH_UNGRADE_MIX < 1, 'named mix factor in (0, 1)');
    assert.deepEqual([...MOON_PATH_SILVER_TINT], [0.86, 0.92, 1.02]);

    const glsl = readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js', import.meta.url), 'utf8');
    const canvas = readFileSync(new URL('../../claudeville/src/presentation/character-mode/CanvasWaterState.js', import.meta.url), 'utf8');
    const mixLit = MOON_PATH_UNGRADE_MIX.toFixed(2);
    const tintLit = MOON_PATH_SILVER_TINT.map(v => v.toFixed(2)).join(', ');

    // All four GPU sites (open sea + in-map water, WGSL + GLSL) gate on glint.z > 2.5 and waterMood.x > 0.0
    // and apply the named constant mix under capSaturation(..., waterMaxSat()) and seaPathCap(...).
    assert.ok(OPEN_SEA_WGSL.includes(`const MOON_PATH_UNGRADE_MIX: f32 = ${mixLit};`));
    assert.ok(OPEN_SEA_WGSL.includes(`const MOON_PATH_SILVER_TINT: vec3f = vec3f(${tintLit});`));
    assert.ok(OPEN_SEA_WGSL.includes('if (frame.glint.z > 2.5 && frame.waterMood.x > 0.0)'));
    assert.ok(OPEN_SEA_WGSL.includes('c = capSaturation(mix(c, stopColor * MOON_PATH_SILVER_TINT, MOON_PATH_UNGRADE_MIX * frame.waterMood.x), waterMaxSat());'));

    assert.ok(SCENE_WGSL.includes(`const MOON_PATH_UNGRADE_MIX: f32 = ${mixLit};`));
    assert.ok(SCENE_WGSL.includes(`const MOON_PATH_SILVER_TINT: vec3f = vec3f(${tintLit});`));
    assert.ok(SCENE_WGSL.includes('if (frame.glint.z > 2.5 && frame.waterMood.x > 0.0)'));
    assert.ok(SCENE_WGSL.includes('color = capSaturation(mix(color, poolAlbedo * MOON_PATH_SILVER_TINT, MOON_PATH_UNGRADE_MIX * frame.waterMood.x), waterMaxSat());'));

    assert.ok(SEA_SWELL_GLSL.includes(`const float MOON_PATH_UNGRADE_MIX = ${mixLit};`));
    assert.ok(SEA_SWELL_GLSL.includes(`const vec3 MOON_PATH_SILVER_TINT = vec3(${tintLit});`));
    assert.ok(glsl.includes('if (u_glint.z > 2.5 && u_waterMood.x > 0.0)'));
    assert.ok(glsl.includes('color = capSaturation(mix(color, poolAlbedo * MOON_PATH_SILVER_TINT, MOON_PATH_UNGRADE_MIX * u_waterMood.x), waterMaxSat());'));
    assert.ok(glsl.includes('if (u_glint.z > 2.5 && u_waterMood.x > 0.0)'));
    assert.ok(glsl.includes('c = capSaturation(mix(c, stopColor * MOON_PATH_SILVER_TINT, MOON_PATH_UNGRADE_MIX * u_waterMood.x), waterMaxSat());'));

    // Canvas twin: lifts moon stops (indices 4..5, kind 3) only when mood.night > 0, and lays post-grade carved.
    assert.match(canvas, /if \(index >= 4 && mood\.night > 0\)/);
    assert.match(canvas, /liftMoonPathRgb\(graded, raw, mood\.night, waterMaxSaturation\(mood\)\)/);
    assert.match(canvas, /const moonPostGrade = Boolean\(glint && glint\.kind === 3 && mood\.night > 0 && atmosphere\?\.lightGrade\);/);
    assert.match(canvas, /drawCarvedTerrainLayer\(overlayCtx, renderer, state\.path\)/);

    // Numerical contract: night moon stops lift cleanly past L* 55, stay cool silver (B >= G >= R, S <= 0.40, V6 cap, HSL L <= 0.70);
    // day frames (night = 0) and sun stops stay untouched.
    const hex01 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const cieL = c => {
        const lin = c.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
        return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
    };
    const hsvS = c => { const mx = Math.max(...c), mn = Math.min(...c); return mx > 0 ? (mx - mn) / mx : 0; };
    const hslL = c => 0.5 * (Math.max(...c) + Math.min(...c));
    const seaPathCap = c => { const l = hslL(c); return l > 0.70 ? c.map(v => v * 0.70 / l) : c; };
    const clear = { type: 'clear', cloudCover: 0.08, fog: 0, intensity: 0 };

    // Day / golden hour: mood.night is 0, liftMoonPathRgb is a strict no-op.
    for (const hour of [12, 18]) {
        const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: clear, moonFill: 0.86 });
        const mood = waterMoodFor({ lightGrade: grade, weather: clear });
        assert.equal(mood.night, 0, `${hour}:00 has water night mood 0`);
        for (const hex of ART_RAMPS.seaPath) {
            const raw = hex01(hex);
            const graded = applyGradeToRgb(raw, grade);
            assert.deepEqual(liftMoonPathRgb(graded, raw, mood.night, waterMaxSaturation(mood)), graded);
        }
    }

    // Night (22:00 and 02:00): bright moon stop (#c4d6e2) clears L* 55, both stops stay silver & capped.
    for (const hour of [22, 2]) {
        const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: clear, moonFill: 0.86 });
        const mood = waterMoodFor({ lightGrade: grade, weather: clear });
        const maxS = waterMaxSaturation(mood);
        assert.equal(mood.night, 1);
        const [lo, hi] = [ART_RAMPS.seaPath[4], ART_RAMPS.seaPath[5]].map(hex => {
            const raw = hex01(hex);
            const graded = applyGradeToRgb(raw, grade);
            return seaPathCap(liftMoonPathRgb(graded, raw, mood.night, maxS));
        });
        assert.ok(cieL(hi) >= 60, `${hour}:00 bright moon stop L* ${cieL(hi).toFixed(1)} >= 60 (well above strip target 55)`);
        assert.ok(cieL(hi) > cieL(lo), `${hour}:00 bright stop exceeds dim stop`);
        for (const [label, c] of [['lo', lo], ['hi', hi]]) {
            assert.ok(c[2] >= c[1] && c[1] >= c[0], `${hour}:00 ${label} stays cool silver (${c.map(v => v.toFixed(3))})`);
            assert.ok(hsvS(c) <= Math.min(0.40, maxS) + 1e-6, `${hour}:00 ${label} S ${hsvS(c).toFixed(3)} <= ${maxS}`);
            assert.ok(hslL(c) <= 0.70 + 1e-6, `${hour}:00 ${label} HSL L ${hslL(c).toFixed(3)} <= 0.70`);
        }
    }
});

test('NE v0.67.1 F: night dims shoreline foam (k=0.22) and unlit dry sand (s=0.84) while day, starlight, surf glow, lit pools and grass/foliage stay unchanged', () => {
    assert.equal(WATER_FOAM_NIGHT_DIM, 0.22);
    assert.equal(DRY_SAND_NIGHT_SCALE, 0.84);
    assert.equal(foamNightScale({ night: 0 }), 1, 'daytime foam scale is 1');
    assert.equal(foamNightScale({ night: 1 }), 0.78, 'full night dims foam by 22 %');
    assert.equal(foamNightScale({ night: 0.5 }), 0.89);
    // WGSL/GLSL twin parity for foamNightScale, starlight exemption, and isDrySand.
    const glsl = readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js', import.meta.url), 'utf8');
    assert.ok(glsl.includes('return 1.0 - ${WATER_FOAM_NIGHT_DIM.toFixed(2)} * u_waterMood.x;'));
    assert.ok(WATER_WGSL.includes(`return 1.0 - ${WATER_FOAM_NIGHT_DIM.toFixed(2)} * frame.waterMood.x;`));
    assert.ok(glsl.includes('vec3 albedo = whitecap ? WATER_FOAM * foamNightScale() : seaStopRgb(max(stop - lighter, 0.0));'));
    assert.ok(OPEN_SEA_WGSL.includes('var albedo = WATER_FOAM * foamNightScale();'));
    assert.ok(glsl.includes('if (starlightAt(cell, cap, u_starlight, tick)) albedo = WATER_FOAM_CREST;'), 'open-sea starlight stays un-dimmed');
    assert.ok(OPEN_SEA_WGSL.includes('if (starlightAt(cell, cap, frame.starlight, tick)) { albedo = WATER_FOAM_CREST; }'), 'WGSL open-sea starlight stays un-dimmed');
    assert.ok(glsl.includes('if (color.r < color.g || color.r <= color.b + 0.08) return false;'), 'GLSL isDrySand rejects grass/foliage/snow');
    assert.ok(SCENE_WGSL.includes('if (color.r < color.g || color.r <= color.b + 0.08) { return false; }'), 'WGSL isDrySand rejects grass/foliage/snow');
    assert.ok(glsl.includes('if (hasCoast && (sd > 0.0 || sd < -0.75)) return false;'), 'GLSL isDrySand stays in shore band');
    assert.ok(SCENE_WGSL.includes('if (hasCoast && (sd > 0.0 || sd < -0.75)) { return false; }'), 'WGSL isDrySand stays in shore band');
    // Dry sand dim runs AFTER poolAlbedo = sunBase and BEFORE applyTimeGrade, gated on terrainBatch and night > 0.
    for (const [src, poolLine, dimLine, gradeLine] of [
        [glsl, 'vec3 poolAlbedo = sunBase;', 'color *= mix(1.0, ${DRY_SAND_NIGHT_SCALE.toFixed(2)}, u_waterMood.x);', 'color = applyTimeGradeFaced(color, !u_additive, k, refN);'],
        [SCENE_WGSL, 'let poolAlbedo = sunBase;', `color *= mix(1.0, ${DRY_SAND_NIGHT_SCALE.toFixed(2)}, frame.waterMood.x);`, 'color = applyTimeGradeFaced(color, batch.additive == 0u, k, &refN);'],
    ]) {
        const iPool = src.indexOf(poolLine);
        const iDim = src.indexOf(dimLine);
        const iGrade = src.indexOf(gradeLine);
        assert.ok(iPool > 0 && iPool < iDim && iDim < iGrade, 'lit pools retain full poolAlbedo while unlit dry sand dims pre-grade');
    }
    // Hue guard check across C1 ramps: all dry sand stops match (raw & hazed), zero grass/foliage/snow/road stops match even on material 4.
    const hex01 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const farHaze = [226 / 255, 235 / 255, 244 / 255];
    const sandHue = ([r, g, b]) => r >= g && r > b + 0.08;
    for (const hex of ART_RAMPS.sand) {
        const raw = hex01(hex);
        const hazed = raw.map((v, i) => v * farHaze[i]);
        assert.equal(sandHue(raw), true, `raw sand ${hex} passes dry-sand hue gate`);
        assert.equal(sandHue(hazed), true, `far-hazed sand ${hex} passes dry-sand hue gate`);
    }
    for (const rampName of ['grass', 'foliage', 'snow', 'road']) {
        for (const hex of ART_RAMPS[rampName]) {
            const raw = hex01(hex);
            const hazed = raw.map((v, i) => v * farHaze[i]);
            assert.equal(sandHue(raw), false, `raw ${rampName} ${hex} never dims as dry sand`);
            assert.equal(sandHue(hazed), false, `far-hazed ${rampName} ${hex} never dims as dry sand`);
        }
    }
});
