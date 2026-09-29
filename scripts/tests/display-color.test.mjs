import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HDR_CAP_MARK_HUE,
    HDR_EMITTER_COURSE_LUMA,
    HDR_HIGHLIGHT_MODES,
    HDR_MARKS_ABOVE_EMITTER,
    P3_LUMA,
    SRGB_LUMA,
    SRGB_TO_P3,
    P3_RESERVED_HUES,
    hdrGainTable,
    installP3OverlayInks,
    p3RoleInk,
    resolveDisplayColor,
    setOverlayInksP3,
    srgbLuminance,
} from '../../claudeville/src/presentation/character-mode/DisplayColor.js';
import { P3_VARIANTS } from '../../claudeville/src/config/p3Variants.js';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

test('action-needed marks always sit HDR_MARKS_ABOVE_EMITTER above the brightest emitter course, in every mode', () => {
    for (const mode of HDR_HIGHLIGHT_MODES) {
        const gains = hdrGainTable(mode);
        assert.equal(gains.emitter.length, HDR_EMITTER_COURSE_LUMA.length);
        for (let course = 1; course < gains.emitter.length; course++) {
            assert.ok(gains.emitter[course] >= gains.emitter[course - 1], `${mode}: courses step up`);
        }
        assert.equal(Math.max(...gains.emitter), gains.emitterPeak);
        if (mode === 'off') {
            assert.deepEqual([...gains.emitter, gains.mark], [1, 1, 1, 1]);
        } else {
            assert.ok(gains.mark >= gains.emitterPeak + HDR_MARKS_ABOVE_EMITTER - 1e-12, `${mode}: marks above emitters`);
            assert.ok(gains.emitter[0] > 1, `${mode}: the first course already gains`);
        }
    }
    // M1: subtle = emitters up to 1.5x, marks 2.0x; full = 1.35 / 1.65 / 2.0x, marks 2.5x.
    close(hdrGainTable('subtle').emitterPeak, 1.5, 'subtle peak');
    close(hdrGainTable('subtle').mark, 2.0, 'subtle marks');
    hdrGainTable('full').emitter.forEach((gain, index) => close(gain, [1.35, 1.65, 2.0][index], `full course ${index}`));
    close(hdrGainTable('full').mark, 2.5, 'full marks');
    assert.equal(hdrGainTable('bogus').mode, 'subtle', 'an unknown stored mode reads as the default');
});

test('the emitter cap keeps every lifted emitter under the NEEDS YOU mark and never below its SDR light', () => {
    const needsYou = srgbLuminance(HDR_CAP_MARK_HUE);
    close(srgbLuminance('#ffffff'), 1, 'SDR white');
    for (const mode of HDR_HIGHLIGHT_MODES) {
        const gains = hdrGainTable(mode);
        // The roles composite lifts an emitter by min(course gain, cap / Y).
        // A composite pixel's Y is at most SDR white, so a cap at or above 1
        // only ever shortens a gain, never takes it below 1.
        assert.ok(gains.emitterCap >= 1, `${mode}: the cap never dims an emitter below its SDR value`);
        if (mode === 'off') continue;
        const markLight = needsYou * gains.mark;
        assert.ok(gains.emitterCap < markLight, `${mode}: the cap sits under the NEEDS YOU mark (${gains.emitterCap} < ${markLight})`);
    }
});

test('only the WebGPU presenter on a high-dynamic-range screen with the setting on takes the HDR path', () => {
    const hdr = options => resolveDisplayColor(options).hdr;
    assert.equal(hdr({ backend: 'webgpu', hdrMode: 'subtle', dynamicRangeHigh: true }), true);
    assert.equal(hdr({ backend: 'webgpu', hdrMode: 'full', dynamicRangeHigh: true }), true);
    assert.equal(hdr({ backend: 'webgpu', hdrMode: 'off', dynamicRangeHigh: true }), false, 'setting off');
    assert.equal(hdr({ backend: 'webgpu', hdrMode: 'subtle', dynamicRangeHigh: false }), false, 'SDR screen');
    assert.equal(hdr({ backend: 'webgpu', hdrMode: 'subtle', dynamicRangeHigh: true, toneMappingSupported: false }), false, 'no canvas tone mapping');
    assert.equal(hdr({ backend: 'webgl', hdrMode: 'full', dynamicRangeHigh: true }), false, 'WebGL2 has no drawing-buffer tone mapping');
    assert.equal(hdr({ backend: 'canvas', hdrMode: 'full', dynamicRangeHigh: true }), false);
    // The SDR path applies no gain at all.
    assert.deepEqual(resolveDisplayColor({ backend: 'webgpu', hdrMode: 'full', dynamicRangeHigh: false }).gains.emitter, [1, 1, 1]);
    // P3 follows the gamut query on either GPU backend, never Canvas.
    assert.equal(resolveDisplayColor({ backend: 'webgl', colorGamutP3: true }).p3, true);
    assert.equal(resolveDisplayColor({ backend: 'webgpu', colorGamutP3: true }).p3, true);
    assert.equal(resolveDisplayColor({ backend: 'canvas', colorGamutP3: true }).p3, false);
    assert.equal(resolveDisplayColor({ backend: 'webgpu', colorGamutP3: false }).p3, false);
});

test('the sRGB to Display P3 matrix is colorimetrically identical: white stays white and luminance is kept', () => {
    const apply = rgb => SRGB_TO_P3.map(row => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
    apply([1, 1, 1]).forEach(value => close(value, 1, 'white'));
    const samples = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.8, 0.2, 0.05], [0.12, 0.4, 0.33]];
    for (const rgb of samples) {
        const p3 = apply(rgb);
        close(P3_LUMA.reduce((sum, weight, index) => sum + weight * p3[index], 0), SRGB_LUMA.reduce((sum, weight, index) => sum + weight * rgb[index], 0), `Y of ${rgb}`);
        for (const value of p3) assert.ok(value >= -1e-9 && value <= 1 + 1e-9, 'sRGB sits inside P3');
    }
});

test('a display-p3 overlay draws reserved hues as their P3 variants only while the window is on a P3 screen', () => {
    class FakeContext {
        constructor(colorSpace) { this._space = colorSpace; this._fill = '#000000'; this._stroke = '#000000'; }
        getContextAttributes() { return { colorSpace: this._space }; }
        get fillStyle() { return this._fill; }
        set fillStyle(value) { this._fill = value; }
        get strokeStyle() { return this._stroke; }
        set strokeStyle(value) { this._stroke = value; }
    }
    const [reserved, variant] = Object.entries(P3_VARIANTS)[0];
    const p3 = new FakeContext('display-p3');
    assert.equal(installP3OverlayInks(p3), true);
    setOverlayInksP3(true);
    p3.fillStyle = reserved;
    assert.equal(p3.fillStyle, variant);
    p3.strokeStyle = reserved.toUpperCase();
    assert.equal(p3.strokeStyle, variant);
    p3.fillStyle = '#123456';
    assert.equal(p3.fillStyle, '#123456', 'a non-reserved colour is untouched');
    const srgb = new FakeContext('srgb');
    assert.equal(installP3OverlayInks(srgb), false);
    srgb.fillStyle = reserved;
    assert.equal(srgb.fillStyle, reserved, 'an sRGB overlay never takes a P3 variant');
    // The window moved to an sRGB screen: the display-p3 context keeps its
    // colour space, so the reserved hue must go back to its own sRGB string.
    setOverlayInksP3(false);
    p3.fillStyle = reserved;
    assert.equal(p3.fillStyle, reserved, 'an sRGB screen draws the reserved hue itself');
    setOverlayInksP3(true);
    p3.fillStyle = reserved;
    assert.equal(p3.fillStyle, variant, 'back on a P3 screen the variant returns');
    setOverlayInksP3(false);
});

test('P3_VARIANTS are the GPU role mapping of today\'s reserved hues (stale: node scripts/world/generate-p3-variants.mjs)', () => {
    assert.deepEqual(Object.keys(P3_VARIANTS), [...P3_RESERVED_HUES], 'a retuned or added reserved hue needs a regenerated variant');
    for (const [hex, css] of Object.entries(P3_VARIANTS)) assert.equal(css, p3RoleInk(hex), `${hex} no longer matches the shaders' role chroma`);
});
