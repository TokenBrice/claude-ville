import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
    canvasFramePreimage,
    canvasGradeGammaAlpha,
    canvasGradeRgb,
    canvasWaterPreimage,
    drawCanvasGradeGamma,
    applyWaterSky,
} from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import {
    capSaturation,
    evaluateGrade,
    waterMaxSaturation,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { waterMoodFor, waterSurfaceRgb } from '../../claudeville/src/presentation/character-mode/CoastBake.js';

const CLEAR = { type: 'clear', cloudCover: 0.08 };
const rgb01 = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

function pureGammaGrade(gamma) {
    return {
        exposure: 1,
        saturation: 1,
        gain: [1, 1, 1],
        lift: [0, 0, 0],
        gamma: [gamma, gamma, gamma],
        shadowTint: [1, 1, 1],
        highlightTint: [1, 1, 1],
        purkinje: [1, 1, 1],
    };
}

test('NE P2.5: canvasGradeGammaAlpha quantises to 1/32, zeroes below 0.02 and clamps to 0.85', () => {
    assert.equal(canvasGradeGammaAlpha({ gamma: [1.0, 1.0, 1.0] }), 0);
    assert.equal(canvasGradeGammaAlpha({ gamma: [0.97, 0.97, 0.97] }), 0);
    assert.equal(canvasGradeGammaAlpha({ gamma: [1.01, 1.01, 1.01] }), 0, 'blue hour 1.01 -> 0.0145 < 0.02 -> no-op');
    assert.equal(canvasGradeGammaAlpha({ gamma: [1.10, 1.10, 1.10] }), 5 / 32, 'night 1.10 -> 0.145 -> 5/32');
    assert.equal(canvasGradeGammaAlpha({ gamma: [1.08, 1.08, 1.08] }), 4 / 32, 'golden hour 1.08 -> 0.116 -> 4/32');
    const extreme = canvasGradeGammaAlpha({ gamma: [2.5, 2.5, 2.5] });
    assert.ok(extreme <= 0.85 && extreme > 0.8, `clamped extreme alpha ${extreme}`);
    assert.equal(Math.round(extreme * 32), extreme * 32, 'quantised to 1/32');
});

test('NE P2.5: canvasGradeRgb matches c^gamma within +-0.02 on [0.08, 0.65] for gamma 1.10', () => {
    const grade = pureGammaGrade(1.10);
    let maxErr = 0;
    for (let step = 8; step <= 65; step++) {
        const c = step / 100;
        const graded = canvasGradeRgb([c, c, c], grade);
        const exact = c ** 1.10;
        for (let ch = 0; ch < 3; ch++) {
            const err = Math.abs(graded[ch] - exact);
            if (err > maxErr) maxErr = err;
            assert.ok(err <= 0.02, `c=${c.toFixed(2)}: canvas ${graded[ch].toFixed(5)} vs c^1.10 ${exact.toFixed(5)} (err ${err.toFixed(5)})`);
        }
    }
    assert.ok(maxErr <= 0.01, `expected tight <= 0.01 fit on [0.08, 0.65], got ${maxErr.toFixed(5)}`);
});

test('NE P2.5: canvasUngradeRgb (via canvasFramePreimage) inverts canvasGradeRgb exactly', () => {
    const grades = [
        pureGammaGrade(1.10),
        { ...evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.7 }), gamma: [1.10, 1.10, 1.10] },
        { ...evaluateGrade({ minuteOfDay: 2 * 60, weather: CLEAR, moonFill: 0 }), gamma: [1.10, 1.10, 1.10] },
        evaluateGrade({ minuteOfDay: 18 * 60, weather: CLEAR, moonFill: 0 }),
        pureGammaGrade(1.20),
    ];
    const samples = [
        [0.08, 0.12, 0.18],
        [0.25, 0.42, 0.31],
        [0.50, 0.50, 0.50],
        [0.65, 0.58, 0.45],
        ...ART_RAMPS.deepWater.map(rgb01),
        ...ART_RAMPS.grass.slice(1, 4).map(rgb01),
        ...ART_RAMPS.road.slice(1, 4).map(rgb01),
    ];
    for (const grade of grades) {
        for (const x of samples) {
            const graded = canvasGradeRgb(x, grade);
            const roundTrip = canvasFramePreimage(graded, grade, { postFx: false });
            for (let ch = 0; ch < 3; ch++) {
                assert.ok(
                    Math.abs(roundTrip[ch] - x[ch]) < 1e-6,
                    `round-trip mismatch at gamma=${grade.gamma[0]} ch=${ch}: got ${roundTrip[ch]}, want ${x[ch]}`,
                );
            }
        }
    }
    // Water preimage stays exact through the gamma self-blit as well.
    const night = { ...evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.7 }), gamma: [1.10, 1.10, 1.10] };
    const mood = waterMoodFor({ lightGrade: night, weather: CLEAR });
    const maxS = waterMaxSaturation(mood);
    for (const hex of [...ART_RAMPS.deepWater, ...ART_RAMPS.shallowWater]) {
        const surface = waterSurfaceRgb(rgb01(hex), mood, 0);
        const preimage = canvasWaterPreimage(surface, night, { postFx: false, sky: mood });
        const landed = canvasGradeRgb(preimage, night);
        const expected = capSaturation(applyWaterSky(canvasGradeRgb(surface, night), mood), maxS);
        for (let ch = 0; ch < 3; ch++) {
            assert.ok(Math.abs(landed[ch] - expected[ch]) < 1e-6, `${hex} ch=${ch}: landed ${landed[ch]} vs ${expected[ch]}`);
        }
    }
});

test('NE P2.5: noon and blue hour are exact no-ops; night draws one multiply self-blit', () => {
    const noon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: CLEAR, moonFill: 0 });
    const blueHour = evaluateGrade({ minuteOfDay: 19.75 * 60, weather: CLEAR, moonFill: 0.5 });
    const night = { ...evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0.7 }), gamma: [1.10, 1.10, 1.10] };

    assert.equal(canvasGradeGammaAlpha(noon), 0);
    assert.equal(canvasGradeGammaAlpha(blueHour), 0);

    const makeMockCtx = () => {
        const ops = [];
        const canvas = { width: 1280, height: 720 };
        return {
            ops,
            canvas,
            globalCompositeOperation: 'source-over',
            globalAlpha: 1,
            imageSmoothingEnabled: true,
            save() { ops.push({ op: 'save' }); },
            restore() { ops.push({ op: 'restore' }); },
            setTransform(...args) { ops.push({ op: 'setTransform', args }); },
            drawImage(...args) {
                ops.push({
                    op: 'drawImage',
                    source: args[0],
                    args: args.slice(1),
                    composite: this.globalCompositeOperation,
                    alpha: this.globalAlpha,
                });
            },
        };
    };

    for (const [label, grade] of [['noon', noon], ['blue-hour', blueHour]]) {
        const ctx = makeMockCtx();
        drawCanvasGradeGamma(ctx, 640, 360, grade);
        assert.equal(ctx.ops.length, 0, `${label} must be a complete no-op`);
    }

    const nightCtx = makeMockCtx();
    drawCanvasGradeGamma(nightCtx, 640, 360, night);
    const drawOps = nightCtx.ops.filter(o => o.op === 'drawImage');
    assert.equal(drawOps.length, 1, 'night draws exactly one self-blit');
    assert.equal(drawOps[0].source, nightCtx.canvas, 'blits the canvas onto itself');
    assert.equal(drawOps[0].composite, 'multiply');
    assert.equal(drawOps[0].alpha, 5 / 32);
    assert.equal(nightCtx.ops[0].op, 'save');
    assert.equal(nightCtx.ops.at(-1).op, 'restore');

    // Verify both Canvas grade call sites in IsometricRenderer invoke drawCanvasGradeGamma after drawCanvasGradeLift.
    const iso = readFileSync(new URL('../../claudeville/src/presentation/character-mode/IsometricRenderer.js', import.meta.url), 'utf8');
    const calls = iso.match(/drawCanvasGradeLift\(ctx, canvas\.width, canvas\.height, grade\);\s*drawCanvasGradeGamma\(ctx, canvas\.width, canvas\.height, grade\);/g) || [];
    assert.equal(calls.length, 2, 'both Canvas grade paths (_drawAtmosphere and _drawFastAtmosphereWash) apply drawCanvasGradeGamma');
});
