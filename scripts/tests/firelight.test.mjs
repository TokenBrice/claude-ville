import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FIRELIGHT_DARK_SHARE, FIRELIGHT_PILOT_LANDMARK, resolveFirelight } from '../../claudeville/src/presentation/character-mode/gpu/Firelight.js';
import { GPU_LANDMARK_IDS } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { buildEmitterCut, emitterNightCarry } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';

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
    ['NE P1.3: nightCarry derived from poolGain',
        'float nightCarry = clamp((u_poolGain - 0.15) / 1.05, 0.0, 1.0);',
        'let nightCarry = clamp((frame.poolGain - 0.15) / 1.05, 0.0, 1.0);'],
    ['NE P1.3: night emitter base lifts off dark glass toward authored emissive colour',
        'vec3 emitterBase = max(poolAlbedo, emissionColor * (clamp(0.5 + 0.5 * emissive, 0.0, 1.0) * nightCarry)); color = mix(color, emitterBase, emitterWeight);',
        'let emitterBase = max(poolAlbedo, emissionColor * (clamp(0.5 + 0.5 * emissive, 0.0, 1.0) * nightCarry)); color = mix(color, emitterBase, emitterWeight);'],
    ['NE P1.3: emitter landing lifts from 0.42 by day to 0.62 at night',
        'color += emission * (0.42 + 0.20 * nightCarry);',
        'color += emission * (0.42 + 0.20 * nightCarry);'],
    ['NE P3.4: villager moonlight rim condition',
        'if (recvClass == 2 && !reflectRecord && albedo.a >= 0.75 && nightCarry > 0.15 && recvH > 8.0) {',
        'if (recvClass == 2 && !reflectRecord && albedoRgba.a >= 0.75 && nightCarry > 0.15 && recvH > 8.0) {'],
    ['NE P3.4: villager moonlight rim colour mix and 0.50 luma cap',
        'vec3 moonRimColor = mix(color, vec3(0.70, 0.82, 1.0), 0.34 * nightCarry); float rimY = dot(moonRimColor, GRADE_LUMA); if (rimY > 0.50) moonRimColor *= 0.50 / rimY; if (dot(moonRimColor, GRADE_LUMA) > dot(color, GRADE_LUMA)) color = moonRimColor;',
        'var moonRimColor = mix(color, vec3f(0.70, 0.82, 1.0), 0.34 * nightCarry); let rimY = dot(moonRimColor, GRADE_LUMA); if (rimY > 0.50) { moonRimColor *= 0.50 / rimY; } if (dot(moonRimColor, GRADE_LUMA) > dot(color, GRADE_LUMA)) { color = moonRimColor; }'],
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

const CLEAR = { type: 'clear', intensity: 0.18, cloudCover: 0.08 };
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function rgb01ToLstar([r, g, b]) {
    const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

test('NE P1.3: day emitter landing stays 0.42 with nightCarry 0; night lifts dark panes to authored emissive colour', () => {
    const noon = evaluateGrade({ minuteOfDay: 12 * 60, weather: CLEAR, moonFill: 0 });
    const night = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.7 });
    assert.equal(noon.poolGain, 0.15);
    assert.equal(emitterNightCarry(noon), 0);
    assert.equal(0.42 + 0.20 * emitterNightCarry(noon), 0.42, 'day landing weight stays 0.42');
    assert.equal(emitterNightCarry(night), 1);
    assert.ok(Math.abs((0.42 + 0.20 * emitterNightCarry(night)) - 0.62) < 1e-12, 'night landing weight reaches 0.62');

    // Command dark slate glass (#36323b) + authored amber emissive (#ffcf7a, a=124/255).
    const poolAlbedo = [54 / 255, 50 / 255, 59 / 255];
    const emissionColor = [255 / 255, 207 / 255, 122 / 255];
    const emissive = (124 / 255) * 2;
    const liftScaleDay = Math.min(1, Math.max(0, 0.5 + 0.5 * emissive)) * emitterNightCarry(noon);
    assert.deepEqual(
        poolAlbedo.map((a, ch) => Math.max(a, emissionColor[ch] * liftScaleDay)),
        poolAlbedo,
        'day emitterBase is identical to poolAlbedo',
    );
    const liftScaleNight = Math.min(1, Math.max(0, 0.5 + 0.5 * emissive)) * emitterNightCarry(night);
    const emitterBaseNight = poolAlbedo.map((a, ch) => Math.max(a, emissionColor[ch] * liftScaleNight));
    const landedRaw = emitterBaseNight.map((b, ch) => b + emissionColor[ch] * emissive * 0.62);
    const peak = Math.max(1, ...landedRaw);
    const landed = landedRaw.map(v => v / peak);
    const L = rgb01ToLstar(landed);
    assert.ok(L >= 78, `lit Command pane L* ${L.toFixed(1)} >= 78`);
});

test('NE P3.4: villager moonlight rim is absent by day and capped at 0.50 luma at night', () => {
    for (const hour of [10, 12, 15, 17]) {
        const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: CLEAR, moonFill: 0 });
        assert.ok(emitterNightCarry(grade) <= 0.15, `hour ${hour}: nightCarry ${emitterNightCarry(grade)} <= 0.15 keeps moon rim off`);
    }
    const night = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.7 });
    const nightCarry = emitterNightCarry(night);
    assert.ok(nightCarry > 0.15, 'night activates moonlight rim');

    const applyMoonRim = (color) => {
        const mixT = 0.34 * nightCarry;
        let rim = [0.70, 0.82, 1.0].map((target, ch) => color[ch] * (1 - mixT) + target * mixT);
        const rimY = luma(rim);
        if (rimY > 0.50) rim = rim.map(v => v * (0.50 / rimY));
        return luma(rim) > luma(color) ? rim : color;
    };
    const darkContour = [0.08, 0.09, 0.13];
    const lifted = applyMoonRim(darkContour);
    assert.ok(luma(lifted) > luma(darkContour) + 0.15, 'dark contour separates cleanly at night');
    assert.ok(luma(lifted) <= 0.50 + 1e-9);
    const brightContour = [0.55, 0.48, 0.36];
    assert.ok(luma(applyMoonRim(brightContour)) <= 0.50 || applyMoonRim(brightContour) === brightContour,
        'moonlight rim never exceeds 0.50 or darkens a brighter lamp-lit contour');
    const midContour = [0.46, 0.44, 0.42];
    assert.ok(Math.abs(luma(applyMoonRim(midContour)) - 0.50) < 1e-6, 'mid contour caps at 0.50 so NEEDS YOU stays brightest');
    // nl2 stays at 0.5 per plan P3.4.
    resetLookStrengths();
    assert.equal(resolveFirelight()[0], 0.5);
});

test('NE P1.3 / P1.5: Canvas buildEmitterCut matches the GPU formula at day and night', () => {
    const previousDocument = globalThis.document;
    const makeMockCanvas = (w = 0, h = 0, pixels = null) => {
        const canvas = {
            width: w,
            height: h,
            _data: pixels ? new Uint8ClampedArray(pixels) : new Uint8ClampedArray(w * h * 4),
        };
        canvas.getContext = () => ({
            clearRect() { canvas._data.fill(0); },
            drawImage(src) {
                canvas._data = new Uint8ClampedArray(src._data);
            },
            getImageData(_x, _y, width, height) {
                return { width, height, data: new Uint8ClampedArray(canvas._data) };
            },
            createImageData(width, height) {
                return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(imageData) {
                canvas._data = new Uint8ClampedArray(imageData.data);
            },
        });
        return canvas;
    };
    globalThis.document = { createElement: () => makeMockCanvas() };
    try {
        // Pixel 0: Forge-like sub-unit contribution (alpha 88 -> contribution 0.690 < 1, pins P1.5).
        // Pixel 1: Command slate glass + warm amber emissive (alpha 124 -> contribution 0.973).
        const albedoPx = [
            60, 48, 44, 255,
            54, 50, 59, 255,
        ];
        const emissivePx = [
            255, 160, 64, 88,
            255, 207, 122, 124,
        ];
        const albedo = makeMockCanvas(2, 1, albedoPx);
        const emissive = makeMockCanvas(2, 1, emissivePx);

        const expectedGpuPixel = (idx, poolGain) => {
            const o = idx * 4;
            const nightCarry = Math.max(0, Math.min(1, (poolGain - 0.15) / 1.05));
            const contribution = 2 * emissivePx[o + 3] / 255;
            const lift = Math.max(0, Math.min(1, 0.5 + 0.5 * contribution)) * nightCarry;
            const landing = (0.42 + 0.20 * nightCarry) * contribution;
            const rgb = [0, 1, 2].map((ch) => {
                const base = albedoPx[o + ch] / 255;
                const em = emissivePx[o + ch] / 255;
                return Math.max(base, em * lift) + landing * em;
            });
            const peak = Math.max(1, ...rgb);
            return [
                ...rgb.map(v => Math.round(v / peak * 255)),
                Math.round(Math.min(1, contribution) * (albedoPx[o + 3] / 255) * 255),
            ];
        };

        const dayCut = buildEmitterCut(albedo, emissive, { poolGain: 0.15 });
        const nightCut = buildEmitterCut(albedo, emissive, { poolGain: 1.20 });
        for (const [label, cut, poolGain] of [['day', dayCut, 0.15], ['night', nightCut, 1.20]]) {
            for (const px of [0, 1]) {
                const got = Array.from(cut.canvas._data.slice(px * 4, px * 4 + 4));
                const want = expectedGpuPixel(px, poolGain);
                assert.deepEqual(got, want, `${label} px ${px}: Canvas cut matches GPU formula`);
            }
        }
        // Explicitly verify P1.5: pixel 0 (contribution 0.69 < 1) uses 0.42 * contribution, not 0.42 * 1.
        const oldBuggyDayR = Math.round(((60 / 255) + 0.42 * 1 * (255 / 255)) * 255);
        assert.ok(dayCut.canvas._data[0] < oldBuggyDayR - 20,
            `day px 0 red ${dayCut.canvas._data[0]} drops below buggy max(1, contribution) ${oldBuggyDayR}`);
        // Explicitly verify P1.3: Command pane lifts at night to L* >= 78.
        const nightCmdRgb = Array.from(nightCut.canvas._data.slice(4, 7)).map(v => v / 255);
        assert.ok(rgb01ToLstar(nightCmdRgb) >= 78,
            `Canvas night Command pane L* ${rgb01ToLstar(nightCmdRgb).toFixed(1)} >= 78`);
    } finally {
        globalThis.document = previousDocument;
    }
});
