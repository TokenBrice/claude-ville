import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FIRELIGHT_DARK_SHARE, FIRELIGHT_PILOT_LANDMARK, resolveFirelight } from '../../claudeville/src/presentation/character-mode/gpu/Firelight.js';
import { GPU_LANDMARK_IDS } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const squash = text => text.replace(/\s+/g, ' ');
const GLSL = squash(read('gpu/GpuWorldRenderer.js'));
const WGSL = squash(read('gpu/wgsl/scene.js'));

test('NL-2 / NL-1: the firelight uniform is nl2 and a 0/1 switch for nl1, zero with both looks at 0', () => {
    assert.equal(FIRELIGHT_PILOT_LANDMARK, GPU_LANDMARK_IDS.command);
    try {
        setLookStrength('nl2', 0);
        setLookStrength('nl1', 0);
        assert.deepEqual([...resolveFirelight()], [0, 0]);
        setLookStrength('nl2', 0.5);
        setLookStrength('nl1', 0.25);
        assert.deepEqual([...resolveFirelight()], [0.5, 1]);
    } finally {
        resetLookStrengths();
    }
    const field = FRAME_UNIFORM_LAYOUT.fields.find(f => f.name === 'firelight');
    assert.equal(field.type, 'vec2f');
    assert.ok(FIRELIGHT_DARK_SHARE > 0 && FIRELIGHT_DARK_SHARE < 0.1);
});

test('NL-2 / NL-1: at the defaults the firelight uniform is nl2 0.5 and nl1 on', () => {
    resetLookStrengths();
    assert.deepEqual([...resolveFirelight()], [0.5, 1]);
});

// Each pair: the GLSL expression and its WGSL twin, expression for expression.
const TWINS = [
    ['the tuned ramp leaves ground texels to the pools',
        'if (u_firelight.y > 0.5 && recvClass == 0 && recvH <= 16.0 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u) rampPixel = false;',
        'if (frame.firelight.y > 0.5 && recvClass == 0 && recvH <= 16.0 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u) { rampPixel = false; }'],
    ['a low door lights its own reveal',
        'ownJamb = u_firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && rampPixel && recvClass == 1 && lightH <= 40.0 && abs(recvGround.x - light.x) <= 14.0 && recvH <= lightH + 24.0;',
        'ownJamb = frame.firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && rampPixel && recvClass == 1 && lightH <= 40.0 && abs(recvGround.x - light.x) <= 14.0 && recvH <= lightH + 24.0;'],
    ['own low lights', 'bool rampOwnLight = uint(lightMeta.y + 0.5) == ownLandmark && lightH <= 40.0;',
        'let rampOwnLight = u32(lightMeta.y + 0.5) == ownLandmark && lightH <= 40.0;'],
    ['the reveal takes a third of the falloff',
        'falloff *= ownJamb ? 0.35 : clamp(0.30 + 1.4 * ahead / max(length(toReceiver.xy), 1.0), 0.0, 1.0);',
        'falloff *= select(clamp(0.30 + 1.4 * ahead / max(length(toReceiver.xy), 1.0), 0.0, 1.0), 0.35, ownJamb);'],
    ['the reveal response floor', 'if (ownJamb) response = max(response, 0.5);', 'if (ownJamb) { response = max(response, 0.5); }'],
    ['a straight-behind lamp rims opaque texels with nl2',
        'if (albedo.a >= 0.75 && falloff > 0.12 && (lateral || u_firelight.x > 0.0)) {',
        'if (albedoRgba.a >= 0.75 && falloff > 0.12 && (lateral || frame.firelight.x > 0.0)) {'],
    ['the rim reaches higher with nl2 on 1-px outer contour',
        'if (outer && recvH <= lightH + 28.0 + 36.0 * u_firelight.x && falloff >= rimReach)',
        'if (outer && recvH <= lightH + 28.0 + 36.0 * frame.firelight.x && falloff >= rimReach)'],
    ['top rims only on opaque level runs',
        'albedoTexture(uv + vec2(uvStepX, 0.0)).a >= 0.75 && albedoTexture(uv - vec2(uvStepX, 0.0)).a >= 0.75',
        'albedoTexture(uv + vec2f(uvStepX, 0.0)).a >= 0.75 && albedoTexture(uv - vec2f(uvStepX, 0.0)).a >= 0.75'],
    ['the tuned ramp is warm light only, never on Command',
        '!(u_firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && clamp((lightHue.r - lightHue.b) * 1.25, 0.0, 1.0) < 0.5)',
        '!(frame.firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && clamp((lightHue.r - lightHue.b) * 1.25, 0.0, 1.0) < 0.5)'],
    ['the tuned ramp lands a first course from an own light',
        'if (u_firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && rampOwn) course = max(course, step(1.5, rampSteps));',
        'if (frame.firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u && rampOwn) { course = max(course, step(1.5, rampSteps)); }'],
    ['the dark ground share skips Command',
        'recvClass == 0 && u_firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u ?',
        'recvClass == 0 && frame.firelight.y > 0.5 && ownLandmark != ${FIRELIGHT_PILOT_LANDMARK}u),'],
    ['the lift tracks the landed course', 'vec3(ramp.a * 0.25) * step(0.5, course)', 'vec3f(ramp.a * 0.25) * step(0.5, course)'],
    ['diminishing-returns multi-light accumulation on bodies',
        'poolLight = bodyMaxLight + 0.22 * (poolLight - bodyMaxLight);',
        'poolLight = bodyMaxLight + 0.22 * (poolLight - bodyMaxLight);'],
    ['ink-gated dark receivers', '1.0 - smoothstep(0.04, 0.18, albedoLuma)', '1.0 - smoothstep(0.04, 0.18, albedoLuma)'],
    ['the ink-gated body lift', '(0.15 + 0.15 * u_firelight.x) * u_poolGain, (0.045 + 0.055 * u_firelight.x) / max(dot(poolLight, GRADE_LUMA), 0.01)) * inkKeep',
        '(0.15 + 0.15 * frame.firelight.x) * frame.poolGain, (0.045 + 0.055 * frame.firelight.x) / max(dot(poolLight, GRADE_LUMA), 0.01)) * inkKeep'],
    ['the tempered costume-preserving landing share', '0.24 + 0.16 * u_firelight.x', '0.24 + 0.16 * frame.firelight.x'],
    ['the villager-only stepPool inkGuard', 'float poolInkGuard = recvClass == 2 ? 1.0 : 0.0;', 'let poolInkGuard = select(0.0, 1.0, recvClass == 2);'],
    ['the brighter rim', 'rimY = 0.26 + 0.10 * u_firelight.x + (0.1 + 0.02 * u_firelight.x) * rimCourse;',
        'rimY = 0.26 + 0.10 * frame.firelight.x + (0.1 + 0.02 * frame.firelight.x) * rimCourse;'],
];

test('NL-2 / NL-1: every GLSL change has its WGSL twin', () => {
    for (const [label, glsl, wgsl] of TWINS) {
        assert.ok(GLSL.includes(squash(glsl)), `GLSL: ${label}`);
        assert.ok(WGSL.includes(squash(wgsl)), `WGSL: ${label}`);
    }
    assert.ok(GLSL.includes('uniform vec2 u_firelight;'));
    // Summing several lights' ramp shares striped the Archive; it stays out.
    assert.ok(!GLSL.includes('rampSum') && !WGSL.includes('rampSum'));
    assert.ok(GLSL.includes("'u_firelight'"));
});
