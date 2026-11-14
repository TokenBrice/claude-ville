import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { GROUND_WET_STEPS, GROUND_WET_SURFACES } from '../../claudeville/src/presentation/character-mode/GroundWeatherField.js';
import {
    GROUND_WET,
    GROUND_WET_GLSL,
    GROUND_WET_MIRROR_GLSL,
    GROUND_WET_UNIFORMS_GLSL,
    GROUND_WET_WGSL,
} from '../../claudeville/src/presentation/character-mode/gpu/GroundWetShader.js';
import {
    createPuddleUniforms,
    resolveGroundWeather,
    resolveLights,
    resolvePuddles,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { normalizeTimelineKnots } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

// GW-1 / GW-2 — wet ground read from the ground weather field, and the lamps
// mirrored in puddles and wet paving, on both GPU backends.

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const GLSL = `${GROUND_WET_UNIFORMS_GLSL}\n${GROUND_WET_GLSL}\n${GROUND_WET_MIRROR_GLSL}`;
const numbers = (source) => (source.match(/-?\d+\.\d{4}/g) || []).join(',');
const functions = (source, re) => [...source.matchAll(re)].map(m => m[1]).sort();

test('the GLSL and WGSL twins carry the same functions and the same numbers', () => {
    const glslFns = functions(GLSL, /^(?:bool|vec[34]|ivec2|float)\s+(\w+)\(/gm);
    const wgslFns = functions(GROUND_WET_WGSL, /^fn\s+(\w+)\(/gm);
    assert.deepEqual(glslFns, wgslFns);
    assert.deepEqual(glslFns, ['applyGroundMirror', 'applyGroundWet', 'applyWetSheen', 'groundCode', 'groundFieldCell',
        'groundFieldOn', 'groundFieldTexel', 'groundLand', 'groundMirrorAt', 'groundMirrorColumn', 'groundPaving',
        'groundSheenTop', 'groundWetAt', 'groundWetStep', 'puddleByte']);
    assert.equal(numbers(GLSL), numbers(GROUND_WET_WGSL), 'every constant in the same order');
    for (const value of Object.values(GROUND_WET)) assert.ok(numbers(GLSL).includes(value.toFixed(4)), `GROUND_WET ${value}`);
});

test('both scene shaders wire the field the same way', () => {
    const glsl = read('gpu/GpuWorldRenderer.js');
    const wgsl = read('gpu/wgsl/scene.js');
    for (const [source, uniform] of [[glsl, 'u_groundWeather'], [wgsl, 'frame.groundWeather']]) {
        assert.ok(source.includes('applyGroundWet(color, px)'), 'the wet step inside applyMaterialWeather');
        assert.ok(source.includes('applyWetSheen(color, v_world)'), 'the sheen after the grade');
        assert.ok(source.includes('applyGroundMirror(color, groundMirror)'), 'the mirror after the pools');
        assert.ok(source.includes(`${uniform}.y > 0.0 && ${uniform}.z > 0.5 && recvH < 0.5`), 'the mirror gate');
        assert.ok(source.includes('groundMirrorColumn(light.xy, lightH, recvGround)'));
        assert.equal((source.match(/puddleByte\(cell\)/g) || []).length, 2, 'both puddle reads take the field A');
    }
});

test('a wet step lands exactly on a darker stop of the texel\'s own ramp', () => {
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const keys = ['grass', 'sand', 'dirt', 'road', 'plaza', 'plaza', 'road', 'dirt', 'dirt'];
    assert.equal(GROUND_WET_STEPS.length, GROUND_WET_SURFACES * 5);
    keys.forEach((key, surface) => {
        const ramp = ART_RAMPS[key].map(hex);
        const steps = 1;
        for (let stop = 1; stop < 5; stop++) {
            const wet = ramp[stop].map((v, i) => Math.round(v * GROUND_WET_STEPS[surface * 5 + stop][i]));
            const target = ramp[Math.max(0, stop - steps)];
            wet.forEach((v, i) => assert.ok(Math.abs(v - target[i]) <= 1, `${key} stop ${stop}`));
        }
    });
});

test('the field binds only with a look on, a field, and wet or puddled ground; the level steps with the history', () => {
    const weather = { data: new Uint8Array(16), cols: 2, rows: 2, x0: -1, y0: -1, texelW: 2 };
    const mask = { data: new Uint8Array(4), cols: 2, rows: 2, x0: -1, y0: -1, texelW: 2, revision: 'k' };
    Object.defineProperty(mask, 'weather', { value: weather, enumerable: false });
    const feed = { puddleMask: mask, groundWetness: 0.375, wetness: 0.375, puddles: 0.2, weather: { precipitation: 0 } };
    try {
        setLookStrength('gw1', 0);
        setLookStrength('gw2', 0);
        assert.deepEqual([...resolveGroundWeather(feed)], [0, 0, 0, 0], 'looks at 0');
        let puddles = resolvePuddles(feed, createPuddleUniforms());
        assert.equal(puddles.format, 'r8');
        assert.equal(puddles.mask, mask, 'looks at 0: the R8 mask as today');
        setLookStrength('gw1', 0.5);
        assert.deepEqual([...resolveGroundWeather(feed)], [0.5, 0, 1, 0.375], 'the history wetness');
        // Live precipitation never sets the level: drizzle (0.04) and falling
        // snow leave a dry history dry, rain wets the street only as the
        // history fills.
        assert.deepEqual([...resolveGroundWeather({ ...feed, weather: { precipitation: 0.04 }, wetness: 0.04 })], [0.5, 0, 1, 0.375], 'drizzle: the history level');
        assert.deepEqual([...resolveGroundWeather({ ...feed, groundWetness: 0, puddles: 0, weather: { precipitation: 0.7 }, wetness: 0.7 })], [0, 0, 0, 0], 'rain over a dry history: not yet wet');
        puddles = resolvePuddles(feed, createPuddleUniforms());
        assert.equal(puddles.format, 'rgba8');
        assert.equal(puddles.mask, weather, 'the field takes the puddle unit');
        assert.equal(puddles.textureKey, 'ground:weather-field');
        assert.equal(puddles.revision, 'k');
        assert.deepEqual([...resolveGroundWeather({ ...feed, groundWetness: 0, puddles: 0 })], [0, 0, 0, 0], 'dry ground: no field');
        assert.deepEqual([...resolveGroundWeather(feed, undefined, 2)], [0, 0, 0, 0], 'MINIMAL sheds the field (EFFECT_BUDGET wet-ground)');
        assert.equal(resolvePuddles(feed, createPuddleUniforms(), 2).format, 'r8');
        assert.deepEqual([...resolveGroundWeather({ ...feed, puddleMask: { ...mask } })], [0, 0, 0, 0], 'no field: off');
    } finally {
        resetLookStrengths();
    }
});

test('the wet level follows the ground history of the frame\'s own atmosphere: drizzle and snow stay dry', () => {
    resetLookStrengths();
    setLookStrength('gw1', 1);
    const weather = { data: new Uint8Array(16), cols: 2, rows: 2, x0: -1, y0: -1, texelW: 2 };
    const mask = { data: new Uint8Array(4), cols: 2, rows: 2, x0: -1, y0: -1, texelW: 2, revision: 'k' };
    Object.defineProperty(mask, 'weather', { value: weather, enumerable: false });
    const level = (date, type, precipitation) => resolveGroundWeather({
        puddleMask: mask, wetness: precipitation, puddles: 0, weather: { precipitation },
        atmosphere: { effectiveDate: date, timeline: { mode: 'auto', knots: normalizeTimelineKnots([{ minute: 0, type }]) } },
    })[3];
    assert.equal(level(new Date(2026, 4, 12, 15), 'overcast', 0.04), 0, 'a day of overcast drizzle');
    assert.equal(level(new Date(2027, 0, 12, 15), 'rain', 0.7), 0, 'January: precipitation falls as snow');
    assert.equal(level(new Date(2026, 4, 12, 15), 'rain', 0.7), 1, 'a day of rain: the history is full');
    resetLookStrengths();
});

test('a carried lantern never takes a wet reflection, so fixed lamps keep their slots', () => {
    resetLookStrengths();
    const lamp = (id, x) => ({ id, x, y: 400, footX: x, footY: 420, radiusWorld: 64, intensity: 1, height: 20, role: 2, r: 255, g: 190, b: 120, night: true, priority: 2 });
    const feed = {
        wetness: 0.8,
        lighting: { ambientLight: 0.15, beaconIntensity: 0.85, moonFill: 0.9, sunDirIso: { x: -0.7, y: -0.7 }, sunWarmth: 0,
            sourceEnergy: { core: 1.2, spill: 0.8, bloom: 0.6, bucket: 'night' } },
        lights: [lamp('carried-lantern:a', 700), lamp('carried-lantern:b', 760), ...Array.from({ length: 9 }, (_, i) => lamp(`lamp${i}`, 800 + i * 40))],
    };
    const camera = { zoom: 1, x: -400, y: -100, renderOffsetX: -400, renderOffsetY: -100, renderOffsetGpuX: -400, renderOffsetGpuY: -100, _dpr: () => 1 };
    for (const gw2 of [0, 1]) {
        setLookStrength('gw2', gw2);
        const frame = resolveLights(feed, camera, 0, { width: 1680, height: 1032 });
        const rows = 256 * 4;
        const flagged = frame.bins.admitted.map((light, i) => [light.id, frame.records[3 * rows + i * 4 + 2]]);
        assert.ok(flagged.length >= 9, `admitted ${flagged.length}`);
        for (const [id, flags] of flagged) if (id.startsWith('carried-lantern:')) assert.equal(flags & 9, 0, `${id} at gw2 ${gw2}`);
        const fixed = flagged.filter(([id]) => !id.startsWith('carried-lantern:'));
        assert.equal(fixed.filter(([, flags]) => flags & 1).length, 8, `streak slots at gw2 ${gw2}`);
        assert.equal(fixed.filter(([, flags]) => flags & 8).length, gw2 ? fixed.length : 0, `mirrors at gw2 ${gw2}`);
    }
    resetLookStrengths();
});

test('GW-2 mirrors every admitted fixed light at FULL, 8 at REDUCED; the 3.2 streak keeps 8 / 4', () => {
    try {
        setLookStrength('gw2', 0);
        const feed = { wetness: 0.5, lights: [], lighting: {} };
        assert.equal(resolveLights(feed, null, 0).wetReflectionCount, 8);
        assert.equal(resolveLights(feed, null, 1).wetReflectionCount, 4);
        assert.equal(resolveLights(feed, null, 0).groundMirrorCount, 0, 'gw2 0: no mirrors');
        setLookStrength('gw2', 1);
        assert.equal(resolveLights(feed, null, 0).wetReflectionCount, 8, 'the streak budget is unchanged');
        assert.ok(resolveLights(feed, null, 0).groundMirrorCount >= 64);
        assert.equal(resolveLights(feed, null, 1).groundMirrorCount, 8);
        assert.equal(resolveLights(feed, null, 2).groundMirrorCount, 0, 'MINIMAL sheds them');
    } finally {
        resetLookStrengths();
    }
});

test('GW-1: the wet level and the puddle level ease over a minute at each bucket edge, wetting and drying, as a pure function of the clock', async () => {
    const { easedGroundState, GROUND_EASE_MINUTES } = await import('../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js');
    const knots = normalizeTimelineKnots([{ minute: 0, type: 'clear' }, { minute: 719, type: 'clear' }, { minute: 720, type: 'rain' },
        { minute: 840, type: 'rain' }, { minute: 841, type: 'clear' }, { minute: 1439, type: 'clear' }]);
    const at = (ms) => easedGroundState({ effectiveDate: new Date(ms), timeline: { mode: 'auto', knots } });
    const start = new Date(2026, 4, 12, 11, 50).getTime();
    let prev = at(start);
    let maxWet = 0;
    let maxPuddles = 0;
    let wetted = false;
    let dried = false;
    for (let ms = start + 10000; ms <= new Date(2026, 4, 12, 17, 0).getTime(); ms += 10000) {
        const s = at(ms);
        maxWet = Math.max(maxWet, Math.abs(s.wetness - prev.wetness));
        maxPuddles = Math.max(maxPuddles, Math.abs(s.puddles - prev.puddles));
        if (s.wetness > 0.9) wetted = true;
        if (wetted && s.wetness < 0.05) dried = true;
        prev = s;
    }
    assert.ok(wetted && dried, 'the walk covers a rain onset and a drying spell');
    // 10 s of a 1-minute ease: at most a sixth of any bucket step (the
    // largest is under 0.7 in rain).
    assert.ok(maxWet <= 0.7 * (10 / 60 / GROUND_EASE_MINUTES) + 1e-6, `wet level step ${maxWet}`);
    assert.ok(maxPuddles <= 1 * (10 / 60 / GROUND_EASE_MINUTES) + 1e-6, `puddle step ${maxPuddles}`);
    // Pure: the same instant gives the same answer.
    const t = new Date(2026, 4, 12, 12, 10, 30).getTime();
    assert.deepEqual(at(t), at(t));
});
