import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEA_SKY_WEIGHT, SEA_STATE } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { createSeaState, resolveSeaState, seaStateFor } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const strip = text => text.replace(/\s+/g, ' ');

test('SEA-2 / SEA-3: the GLSL and WGSL twins take the sky and set the sea state alike', () => {
    const glsl = strip(read('gpu/GpuWorldRenderer.js'));
    const water = strip(read('gpu/wgsl/water.js'));
    const openSea = strip(read('gpu/wgsl/openSea.js'));
    const scene = strip(read('gpu/wgsl/scene.js'));
    // The streak lattice: the same integer hashes, rows and lead on both.
    for (const src of [glsl, water]) {
        assert.ok(src.includes('waterLatticeHash(vec2(seg, row) + vec2(401.0, 19.0)) >= density') || src.includes('waterLatticeHash(vec2f(seg, row) + vec2f(401.0, 19.0)) >= density'));
        assert.ok(src.includes('${SEA_STATE.streakLength[0].toFixed(1)} + floor(waterLatticeHash(vec2(seg, row) + vec2(409.0, 23.0)) * ${SEA_STATE.streakLength[1].toFixed(1)})')
            || src.includes('${SEA_STATE.streakLength[0].toFixed(1)} + floor(waterLatticeHash(vec2f(seg, row) + vec2f(409.0, 23.0)) * ${SEA_STATE.streakLength[1].toFixed(1)})'));
        assert.ok(src.includes('float x = p.x - u_seaState.z;') || src.includes('let x = p.x - frame.seaState.z;'));
    }
    // The sky's hue at the water's own value, guarded against an absent sky.
    assert.ok(glsl.includes('return clamp(mix(c, sky * (l / ls), w), 0.0, 1.0);'));
    assert.ok(water.includes('return clamp(mix(c, sky * (l / ls), w), vec3f(0.0), vec3f(1.0));'));
    assert.ok(glsl.includes('if (ls < 0.01) return c;') && water.includes('if (ls < 0.01) { return c; }'));
    // Only lit slopes, static caps and calm lanes take it; never foam.
    assert.ok(glsl.includes('float take = !whitecap && (litSlope || cap > 0.0) ? u_seaState.x : 0.0;'));
    assert.ok(openSea.includes('if (!whitecap && (litSlope || cap > 0.0)) { take = frame.seaState.x; }'));
    assert.ok(glsl.includes('vec3 sky = inSunRoad(texelPx, u_glint, u_camera.z) ? u_seaSky : u_waterSky.rgb;'));
    assert.ok(openSea.includes('if (inSunRoad(texelPx, frame.glint, frame.cameraScale)) { sky = frame.seaSky; }'));
    // In-map open water: the cool sky only, laid after the grade under the dynamic V6 cap.
    assert.ok(glsl.includes('color = capSaturation(seaSkyHue(color, u_waterSky.rgb, seaSkyTake), waterMaxSat());'));
    assert.ok(scene.includes('color = capSaturation(seaSkyHue(color, frame.waterSky.rgb, seaSkyTake), waterMaxSat());'));
    // Calm: no caps, no deep dashes on open water, in both passes and dialects.
    assert.ok(glsl.includes('float cap = calm ? 0.0 : swellCap(cell, s, near, paw);'));
    assert.ok(openSea.includes('if (!calm) { cap = swellCap(cell, s, near, paw); }'));
    assert.ok(glsl.includes('} else if (stop >= 2 && !(openWater && seaCalm())) {'));
    assert.ok(water.includes('} else if (stop >= 2 && !(openWater && seaCalm())) {'));
    assert.ok(FRAME_UNIFORM_LAYOUT.fields.some(field => field.name === 'seaState'));
});

test('SEA-3: the knot wind sets calm, breeze, fresh and storm, with hysteresis', () => {
    assert.equal(seaStateFor({ type: 'fog', windX: 0.1 }, 1), 0);
    assert.equal(seaStateFor({ type: 'clear', windX: 0.35 }, 1), 1);
    assert.equal(seaStateFor({ type: 'partly-cloudy', windX: 0.55 }, 1), 1);
    assert.equal(seaStateFor({ type: 'rain', windX: -0.9 }, 1), 2);
    assert.equal(seaStateFor({ type: 'storm', windX: -1.3 }, 1), 3);
    // Hysteresis: a calm sea stays calm a little past the threshold.
    assert.equal(seaStateFor({ type: 'clear', windX: SEA_STATE.calm + SEA_STATE.hysteresis / 2 }, 1, 0), 0);
    assert.equal(seaStateFor({ type: 'clear', windX: SEA_STATE.calm + SEA_STATE.hysteresis / 2 }, 1, 1), 1);
    // A weaker look reaches less of the ladder.
    assert.equal(seaStateFor({ type: 'overcast', windX: 0.75 }, 0.5), 1);
});

test('SEA-2 / SEA-3: off at 0 and at MINIMAL; the sky fades with night; streaks hold under reduced motion', () => {
    const feed = { timeMs: 100000, atmosphere: { weather: { type: 'rain', windX: -0.9 } } };
    try {
        setLookStrength('sea2', 0);
        setLookStrength('sea3', 0);
        assert.deepEqual(Array.from(resolveSeaState(feed, POST_FX_LEVELS.FULL, 0).uniform), [0, -1, 0, 0]);
        setLookStrength('sea2', 1);
        setLookStrength('sea3', 1);
        assert.deepEqual(Array.from(resolveSeaState(feed, POST_FX_LEVELS.MINIMAL, 0).uniform), [0, -1, 0, 0]);
        assert.equal(resolveSeaState(feed, POST_FX_LEVELS.FULL, 0).uniform[0], Math.round(SEA_SKY_WEIGHT * 32) / 32, 'stepped in 1/32');
        assert.equal(resolveSeaState(feed, POST_FX_LEVELS.FULL, 1).uniform[0], 0, 'night unchanged');
        const state = createSeaState();
        resolveSeaState({ ...feed, timeMs: 100000 }, POST_FX_LEVELS.FULL, 0, state);
        assert.equal(state.uniform[1], 2);
        assert.ok(state.uniform[3] < 0, 'a west wind leads the streaks west');
        resolveSeaState({ ...feed, timeMs: 101000 }, POST_FX_LEVELS.FULL, 0, state);
        const moved = state.uniform[2];
        assert.ok(moved > 0 && moved % 1 === 0, 'whole px steps');
        assert.ok(Math.abs(moved - (SEA_STATE.streakWrap - 3)) < 1e-9, 'one px per two 6 Hz ticks, downwind');
        resolveSeaState({ ...feed, timeMs: 109000, reducedMotion: true }, POST_FX_LEVELS.FULL, 0, state);
        assert.equal(state.uniform[2], moved, 'reduced motion holds the streaks');
    } finally {
        resetLookStrengths();
    }
});

// r2 (D3) — under reduced motion the state still follows the weather.
test('SEA-3: a reduced-motion sea follows fog, then rain, then storm', () => {
    setLookStrength('sea3', 1);
    const state = createSeaState();
    const at = (weather, timeMs) => resolveSeaState({ timeMs, reducedMotion: true, atmosphere: { weather } }, POST_FX_LEVELS.FULL, 0, state).uniform[1];
    assert.equal(at({ type: 'fog', windX: 0.1 }, 1000), 0);
    assert.equal(at({ type: 'rain', windX: -0.9 }, 1000), 2, 'a held clock still reads the rain');
    assert.equal(at({ type: 'storm', windX: -1.3 }, 1000), 3);
    assert.equal(state.uniform[2], 0, 'the streaks hold still');
    resetLookStrengths();
});
