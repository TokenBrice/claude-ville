import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AURORA_COURSES,
    AURORA_MONTHS,
    AURORA_STEP_MS,
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
