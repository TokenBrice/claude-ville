import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIST, resolveMist, resolveOccluderChannel } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { MIST_GLSL } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { MIST_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/atmosphere.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { effectBudgetMode } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { DAWN_MIST_SHARE, mistDensity } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
// Sorted: WGSL's nested select() lists the course mixes in reverse order.
const numbers = text => text.match(/\d+\.\d+/g).sort();
const FOG = { type: 'fog', intensity: 0.85, fog: 0.89 };

// MS-1 — the twins carry the same numbers in the same order, and the same
// call shapes (frame.mist for u_mist).
test('the GLSL and WGSL low mist are twins', () => {
    assert.deepEqual(numbers(MIST_WGSL), numbers(MIST_GLSL.replace(/\/\/.*$/gm, '')));
    for (const fn of ['mistTopAt', 'mistCourseAt', 'mistCourse', 'applyMist']) {
        assert.match(MIST_GLSL, new RegExp(`\\b${fn}\\(`));
        assert.match(MIST_WGSL, new RegExp(`fn ${fn}\\(`));
    }
    const glsl = read('gpu/GpuWorldRenderer.js');
    const scene = read('gpu/wgsl/scene.js');
    const sea = read('gpu/wgsl/openSea.js');
    assert.ok(glsl.includes('mistCourse(recvGround, mistH, mistNear, mistH > 0.5, bayer4(floor(artCell * 0.5)))'));
    assert.ok(scene.includes('mistCourse(recvGround, mistH, mistNear, mistH > 0.5, bayer4(floor(artCell * 0.5)))'));
    assert.ok(glsl.includes('mistCourse(cell + 0.5, crestH, seaMistNear, false, waterBayer4(floor(cell * 0.5)))'));
    assert.ok(sea.includes('mistCourse(cell + 0.5, crestH, seaMistNear, false, waterBayer4(floor(cell * 0.5)))'));
    // A body takes at most the first course, on both backends.
    assert.ok(glsl.includes('if (recvClass == 2) mist = min(mist, 1.0);'));
    assert.ok(scene.includes('if (recvClass == 2) { mist = min(mist, 1.0); }'));
    // Look 0 keeps today's veil verbatim in the else branch.
    assert.ok(glsl.includes('if (u_mist.w > 0.0) {') && glsl.includes('smoothstep(0.18, 0.98, gl_FragCoord.y'));
    assert.ok(FRAME_UNIFORM_LAYOUT.fields.some(field => field.name === 'mist'));
});

test('the mist never lifts past today\'s fog cap and lays no smooth gradient', () => {
    // Today's strongest fog: the top bank course (alpha 0.31) under the
    // veil's 0.06 luma cap.
    assert.ok(MIST.riseShare <= 0.31 && MIST.riseFloor <= 0.06);
    assert.ok(!/smoothstep|fwidth|dFd/.test(MIST_GLSL));
    assert.ok(!/smoothstep|fwidth|dpd/.test(MIST_WGSL));
    // The drift wrap is a common period of both cloud-tile reads.
    for (const axis of [0, 1]) {
        assert.equal(MIST.wrap[axis] % MIST.scaleA[axis], 0);
        assert.equal(MIST.wrap[axis] % MIST.scaleB[axis], 0);
    }
});

test('resolveMist is off at look 0 and at MINIMAL, on at FULL and REDUCED', () => {
    const feed = { mistDensity: 0.75, timeMs: 1000, atmosphere: { weather: FOG } };
    try {
        setLookStrength('ms1', 0);
        assert.deepEqual(Array.from(resolveMist(feed)), [0, 0, 0, 0]);
        setLookStrength('ms1', 0.5);
        assert.equal(effectBudgetMode('low-mist', POST_FX_LEVELS.REDUCED), 'on');
        assert.equal(resolveMist(feed, POST_FX_LEVELS.REDUCED)[3], 0.5);
        assert.deepEqual(Array.from(resolveMist(feed, POST_FX_LEVELS.MINIMAL)), [0, 0, 0, 0]);
        const out = resolveMist(feed, POST_FX_LEVELS.FULL);
        assert.equal(out[0], 0.75);
    } finally {
        resetLookStrengths();
    }
});

test('the mist drifts on the one wind in whole mist cells and holds under reduced motion', () => {
    const weather = { ...FOG, windX: 0.6 };
    const at = (timeMs, extra = {}) => Array.from(resolveMist({ mistDensity: 0.5, timeMs, atmosphere: { weather }, ...extra }));
    try {
        setLookStrength('ms1', 1);
        const a = at(500000);
        const b = at(530000);
        for (const v of [...a.slice(1, 3), ...b.slice(1, 3)]) assert.equal(v % 2, 0, 'whole 2-px cells');
        assert.notDeepEqual(a.slice(1, 3), b.slice(1, 3), 'the drift moves');
        const held = at(600000, { reducedMotion: true });
        assert.deepEqual(held.slice(1, 3), b.slice(1, 3), 'reduced motion holds the drift');
        // The mist reads the surface-coded heights, so it keeps the occluder channel up.
        assert.equal(resolveOccluderChannel({ mistDensity: 0.5, weather: { type: 'clear' } }), true);
        setLookStrength('ms1', 0);
        assert.equal(resolveOccluderChannel({ mistDensity: 0.5, weather: { type: 'clear' } }), false, 'ms1 0: no mist, no occluder channel');
    } finally {
        resetLookStrengths();
    }
});

test('mist density comes from fog weather or the dawn mist, stepped', () => {
    assert.ok(mistDensity({ weather: FOG, phase: 'day' }) > 0.5);
    assert.equal(mistDensity({ weather: { type: 'clear', intensity: 0 }, phase: 'day' }), 0);
    // r6 — with ms2 on (the default) the dawn mist moves in 32nds.
    assert.equal(mistDensity({ weather: { type: 'clear', intensity: 0 }, phase: 'dawn', phaseProgress: 0.5 }), Math.round(DAWN_MIST_SHARE * 32) / 32);
    for (let p = 0; p <= 1; p += 0.05) {
        const d = mistDensity({ weather: { type: 'clear', intensity: 0 }, phase: 'dawn', phaseProgress: p });
        assert.equal(d * 32, Math.round(d * 32), '32nds only');
    }
});
