import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AURORA_COURSES,
    AURORA_MONTHS,
    AURORA_STEP_MS,
    SkyRenderer,
    auroraGateOpen,
    auroraPhaseIndex,
} from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';
import {
    OKLAB_FROM_LMS_CBRT,
    OKLAB_LMS_FROM_LINEAR_SRGB,
} from '../../claudeville/src/presentation/character-mode/DisplayColor.js';

// W8.8 (AD-P14) — the aurora gate: the meteor gate (night phases, stars ≥
// 0.45, cover ≤ 0.35) in Nov–Feb, from the village clock and weather only.

function clearNight({ month = 0, phase = 'night', starsAlpha = 0.8, cloudCover = 0.1 } = {}) {
    return {
        phase,
        sky: { starsAlpha },
        weather: { type: 'clear', cloudCover },
        effectiveDate: new Date(2027, month, 15, 23, 0, 0),
    };
}

test('the aurora opens on a clear winter night', () => {
    assert.equal(auroraGateOpen(clearNight()), true);
    assert.equal(auroraGateOpen(clearNight({ phase: 'dusk' })), true);
});

test('the aurora keeps to November through February', () => {
    for (let month = 0; month < 12; month++) {
        assert.equal(auroraGateOpen(clearNight({ month })), AURORA_MONTHS.includes(month), `month ${month}`);
    }
    assert.deepEqual([...AURORA_MONTHS].sort((a, b) => a - b), [0, 1, 10, 11]);
});

test('the aurora shares the meteor gate: phase, stars and cover', () => {
    for (const phase of ['day', 'dawn', 'noon', null]) {
        assert.equal(auroraGateOpen(clearNight({ phase })), false, `phase ${phase}`);
    }
    assert.equal(auroraGateOpen(clearNight({ starsAlpha: 0.45 })), true);
    assert.equal(auroraGateOpen(clearNight({ starsAlpha: 0.44 })), false);
    assert.equal(auroraGateOpen(clearNight({ cloudCover: 0.35 })), true);
    assert.equal(auroraGateOpen(clearNight({ cloudCover: 0.36 })), false);
    assert.equal(auroraGateOpen({ ...clearNight(), effectiveDate: null }), false);
    assert.equal(auroraGateOpen({ ...clearNight(), effectiveDate: new Date(Number.NaN) }), false);
    assert.equal(auroraGateOpen(null), false);
});

test('the aurora never answers to the roster or agent state (V3)', () => {
    const agents = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, status: i % 2 ? 'waiting' : 'working' }));
    for (const month of [0, 5]) {
        for (const phase of ['night', 'day']) {
            const base = clearNight({ month, phase });
            const expected = auroraGateOpen(base);
            for (const extra of [
                { agents: [] },
                { agents, attention: { level: 'needs-you', count: 9 } },
                { roster: agents, mood: 'busy', director: { cue: 'release' }, recentEvent: true },
            ]) {
                assert.equal(auroraGateOpen({ ...base, ...extra }), expected, `month ${month} ${phase}`);
            }
        }
    }
});

test('ribbons step A → B → C one at a time and hold without motion', () => {
    for (const ribbon of [0, 1, 2]) {
        assert.equal(auroraPhaseIndex(ribbon, 123456, 0), ribbon);
        assert.equal(auroraPhaseIndex(ribbon, null, 1), ribbon);
        assert.equal(auroraPhaseIndex(ribbon, 987654, -1), ribbon);
    }
    const sample = t => [0, 1, 2].map(ribbon => auroraPhaseIndex(ribbon, t, 1));
    const third = AURORA_STEP_MS / 3;
    let previous = sample(0);
    const seen = [new Set(), new Set(), new Set()];
    for (let k = 1; k <= 9; k++) {
        const current = sample(k * third + 1);
        const changed = current.filter((phase, ribbon) => phase !== previous[ribbon]).length;
        assert.equal(changed, 1, `boundary ${k}: exactly one ribbon steps`);
        current.forEach((phase, ribbon) => {
            if (phase !== previous[ribbon]) assert.equal(phase, (previous[ribbon] + 1) % 3, 'A → B → C → A');
            seen[ribbon].add(phase);
        });
        previous = current;
    }
    for (const phases of seen) assert.equal(phases.size, 3);
});

test('the brightest aurora course stays under OKLab L 0.55', () => {
    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const mul = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
    const okL = (hex) => {
        const rgb = [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
        return mul(OKLAB_FROM_LMS_CBRT, mul(OKLAB_LMS_FROM_LINEAR_SRGB, rgb).map(Math.cbrt))[0];
    };
    const lightness = AURORA_COURSES.map(okL);
    assert.ok(Math.max(...lightness) <= 0.55, `max L ${Math.max(...lightness).toFixed(3)}`);
    for (let i = 1; i < lightness.length; i++) assert.ok(lightness[i] < lightness[i - 1], 'edge → fringe descends');
});

test('NE P3.5: sky plate draws moon and stars once, keeps stars above horizon, 4-course moon glow and screen aurora clear of moon', () => {
    const noopCtx = () => {
        const ops = [];
        return {
            ops,
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: true,
            fillStyle: '',
            save() { ops.push({ op: 'save' }); },
            restore() { ops.push({ op: 'restore' }); },
            beginPath() {},
            rect() {},
            clip() {},
            fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h, alpha: this.globalAlpha }); },
            drawImage(img, x, y, w, h) { ops.push({ op: 'drawImage', img, x, y, w, h, comp: this.globalCompositeOperation, alpha: this.globalAlpha }); },
            createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData(image) { this._image = image; },
        };
    };
    const prevDocument = globalThis.document;
    globalThis.document = {
        createElement: () => {
            const c = { width: 0, height: 0, _ctx: null };
            c.getContext = () => (c._ctx ||= noopCtx());
            return c;
        },
    };
    try {
        const sky = new SkyRenderer({ assets: { has: () => true, get: () => ({ width: 64, height: 32 }), getDims: () => ({ w: 64, h: 64 }) } });
        const canvas = { width: 1280, height: 720 };
        const camera = { worldToScreen: () => ({ x: 0, y: 200 }) };
        // 1. drawCanopy must not draw moon or stars (single pass lives in draw()).
        let canopyMoon = 0;
        let canopyStars = 0;
        const origMoon = sky._drawMoon.bind(sky);
        const origStars = sky._drawStars.bind(sky);
        sky._drawMoon = (...args) => { canopyMoon++; return origMoon(...args); };
        sky._drawStars = (...args) => { canopyStars++; return origStars(...args); };
        const ctxCanopy = noopCtx();
        sky.drawCanopy(ctxCanopy, {
            canvas,
            camera,
            atmosphere: { phase: 'night', sky: { starsAlpha: 0.9, moon: { visible: true, alpha: 0.9, xFrac: 0.4, yFrac: 0.2 } } },
        });
        assert.equal(canopyMoon, 0, 'drawCanopy must not redraw moon');
        assert.equal(canopyStars, 0, 'drawCanopy must not redraw stars');
        sky._drawMoon = origMoon;
        sky._drawStars = origStars;

        // 2. Stars and constellations stay strictly above horizonY - 8 and fade over the bottom 20 %.
        sky._horizonY = 200;
        const ctxStars = noopCtx();
        const drewStars = sky._drawStars(ctxStars, canvas, { dayProgress: 0.1, sky: { starsAlpha: 0.9, palette: {} } });
        assert.equal(drewStars, true);
        const rects = ctxStars.ops.filter(o => o.op === 'fillRect');
        assert.ok(rects.length > 20, 'stars drawn above horizon');
        const ceilingY = Math.min(200 - 8, canvas.height * 0.60);
        for (const r of rects) assert.ok(r.y <= ceilingY + 1, `star y=${r.y} stays above horizon ceiling ${ceilingY}`);
        const topStars = rects.filter(r => r.y < ceilingY * 0.5);
        const bottomStars = rects.filter(r => r.y > ceilingY * 0.85);
        assert.ok(bottomStars.length > 0 && topStars.length > 0);
        const meanAlpha = list => list.reduce((s, o) => s + o.alpha, 0) / list.length;
        assert.ok(meanAlpha(bottomStars) < meanAlpha(topStars) * 0.65, 'bottom 20 % of stars fade toward horizon');

        // Off-frame horizon (default AUTO camera) draws no stars.
        sky._horizonY = -117;
        assert.equal(sky._drawStars(noopCtx(), canvas, { dayProgress: 0.1, sky: { starsAlpha: 0.9, palette: {} } }), false);

        // 3. Moon glow clamps radius to [36, 54] via (horizonY - y) * 1.05 with 4 stepped courses.
        sky._horizonY = 216;
        const ctxGlow = noopCtx();
        sky._drawMoonGlow(ctxGlow, canvas, { xFrac: 0.4, yFrac: 174 / canvas.height, alpha: 1 });
        const glowDraw = ctxGlow.ops.find(o => o.op === 'drawImage');
        assert.ok(glowDraw, 'moon glow draws');
        const expectedR = Math.round(Math.min(54, Math.max(36, (216 - 174) * 1.05)) / 2) * 2;
        assert.equal(glowDraw.img.width, expectedR * 2, `clamped moon glow diameter ${glowDraw.img.width}`);
        assert.equal(glowDraw.comp, 'screen');
        // Verify 4 distinct stepped alpha levels in the baked moon glow stamp.
        const stampAlphas = new Set();
        const smallData = Array.from(sky._glowStamps.values()).at(-1);
        assert.ok(smallData.width >= 72 && smallData.width <= 108);

        // 4. Aurora composites with 'screen' and skips ribbons within |xFrac - moon.xFrac| < 0.14.
        sky._horizonY = 220;
        sky._auroraStamps = () => [{ width: 64, height: 32 }, { width: 64, height: 32 }, { width: 64, height: 32 }];
        const ctxAurora = noopCtx();
        const atmo = { ...clearNight(), sky: { starsAlpha: 0.8, moon: { visible: true, xFrac: 0.40 } } };
        assert.equal(sky._drawAurora(ctxAurora, canvas, atmo, 1, 0), true);
        const auroraDraws = ctxAurora.ops.filter(o => o.op === 'drawImage');
        // Ribbon xFracs are 0.17, 0.48, 0.77; 0.48 is within 0.14 of 0.40 and must be skipped.
        assert.equal(auroraDraws.length, 2, 'middle aurora ribbon near moon is skipped');
        for (const draw of auroraDraws) assert.equal(draw.comp, 'screen', 'aurora composites with screen');
        // With no visible moon, all 3 ribbons draw.
        const ctxAuroraAll = noopCtx();
        assert.equal(sky._drawAurora(ctxAuroraAll, canvas, { ...clearNight(), sky: { starsAlpha: 0.8, moon: { visible: false, xFrac: 0.40 } } }, 1, 0), true);
        assert.equal(ctxAuroraAll.ops.filter(o => o.op === 'drawImage').length, 3, 'all 3 ribbons draw when moon is hidden');
    } finally {
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
    }
});
