import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FROST_FALLBACK_SUN,
    FROST_MELT_ELEVATIONS,
    frostMeltQuarter,
    frostQuarterOf,
    frostSunFor,
    groundOptionsFor,
    groundStateAt,
    isFrostMonth,
} from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { FROST_SHADE, frostHolds, frostShadeField } from '../../claudeville/src/presentation/character-mode/FrostMelt.js';
import { normalizeTimelineKnots } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { terrainArtifactKey } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';

// BI-5 — frost mornings from November to February that melt by the real
// sun (the snapshot's `atmosphere.solar`), in quarters, from the sunny side.

const CLEAR = normalizeTimelineKnots([{ minute: 0, type: 'clear' }]);
const deg = Math.PI / 180;

// A real-sun stand-in for `atmosphere.solar` at 44.8° N: declination from
// the day of the year, the hour angle from solar noon (minutes of the day).
function solarAt(date, minute, noon = 700) {
    const day = Math.round((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    const decl = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * deg;
    const lat = 44.8 * deg;
    const hour = (minute - noon) / 4 * deg;
    const elevationDeg = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour)) / deg;
    const halfDay = Math.acos(-Math.tan(lat) * Math.tan(decl)) / deg * 4;
    return { sunriseMinute: noon - halfDay, solarNoonMinute: noon, sunsetMinute: noon + halfDay, elevationDeg };
}

function frostAt(date, minute, knots = CLEAR, noon = 700) {
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minute / 60), minute % 60);
    const sun = frostSunFor({ solar: solarAt(at, minute, noon) });
    return groundStateAt(at, { timelineKnots: knots, sun }).frost;
}

test('the melt clock steps down with the sun, never with fixed hours', () => {
    const sun = (elevationDeg) => ({ sunriseMinute: 420, solarNoonMinute: 700, elevationDeg });
    assert.equal(frostMeltQuarter(sun(0), 22 * 60 + 5), 4, 'the night rimes from 22:00');
    assert.equal(frostMeltQuarter(sun(0), 3 * 60), 4);
    assert.equal(frostMeltQuarter(sun(-2), 419), 4, 'whole until sunrise');
    const steps = [0, ...FROST_MELT_ELEVATIONS];
    for (let i = 0; i < steps.length; i++) {
        assert.equal(frostMeltQuarter(sun(steps[i] + 0.01), 500), 4 - i, `at ${steps[i]}°`);
    }
    assert.equal(frostMeltQuarter(sun(12), 700), 0, 'gone at solar noon, however low the sun');
    assert.equal(frostMeltQuarter(sun(5), 15 * 60), 0, 'never back in the afternoon');
    // The same clock minute under a later sunrise is an earlier stage.
    assert.equal(frostMeltQuarter({ sunriseMinute: 480, solarNoonMinute: 760, elevationDeg: 0 }, 470), 4);
    assert.equal(frostMeltQuarter({ sunriseMinute: 400, solarNoonMinute: 680, elevationDeg: 6 }, 470), 2);
});

test('frost lies from November to February after a clear night, read at sunrise', () => {
    assert.deepEqual([...Array(12).keys()].filter(isFrostMonth), [0, 1, 10, 11]);
    assert.equal(frostAt(new Date(2026, 9, 20), 180), 0, 'October');
    assert.equal(frostAt(new Date(2026, 10, 3), 180), 4, '3 November');
    assert.equal(frostAt(new Date(2027, 1, 20), 180), 4, 'February');
    assert.equal(frostAt(new Date(2027, 2, 5), 180), 0, 'March');
    assert.equal(frostAt(new Date(2026, 10, 20), 21 * 60), 0, 'no rime before 22:00');
    // A cloudy night lays none; a clear night clouding over after sunrise
    // still melts by the sun; rain falling now (overcast's drizzle too)
    // melts it.
    const cloudy = normalizeTimelineKnots([{ minute: 0, type: 'overcast' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 180, cloudy), 0);
    const clouding = normalizeTimelineKnots([{ minute: 0, type: 'clear' }, { minute: 480, type: 'clear' }, { minute: 500, type: 'partly-cloudy' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 530, clouding), frostAt(new Date(2026, 11, 15), 530));
    assert.ok(frostAt(new Date(2026, 11, 15), 530, clouding) > 0);
    const shower = normalizeTimelineKnots([{ minute: 0, type: 'clear' }, { minute: 480, type: 'clear' }, { minute: 500, type: 'rain' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 530, shower), 0);
});

test('a frosty morning steps 4 → 0 once, slower under the low December sun', () => {
    const melt = (date) => {
        let last = 4;
        const steps = [];
        for (let minute = 0; minute < 13 * 60; minute += 5) {
            const q = frostAt(date, minute);
            assert.ok(q <= last, `${date.toDateString()} ${minute}: ${last} → ${q}`);
            if (q !== last) steps.push([minute, q]);
            last = q;
        }
        assert.equal(last, 0);
        assert.deepEqual(steps.map(([, q]) => q), [3, 2, 1, 0]);
        return steps;
    };
    const november = melt(new Date(2026, 10, 20));
    const december = melt(new Date(2026, 11, 21));
    // Each step comes later on the solstice: the sun rises later and lower.
    for (let i = 0; i < 4; i++) assert.ok(december[i][0] > november[i][0], `step ${i}`);
    // The rime lingers in the shade (quarter 1) for over an hour in December.
    assert.ok(december[3][0] - december[2][0] >= 60);
});

test('the snapshot carries its sun into the ground state, with a fallback day', () => {
    const solar = { sunriseMinute: 427, solarNoonMinute: 701, elevationDeg: 5.6 };
    assert.deepEqual(frostSunFor({ solar }), { sunriseMinute: 427, solarNoonMinute: 701, elevationDeg: 5.6 });
    assert.deepEqual(groundOptionsFor({ solar, timeline: null }).sun, frostSunFor({ solar }));
    const fallback = frostSunFor({ clock: { minuteOfDay: FROST_FALLBACK_SUN.solarNoonMinute } });
    assert.equal(fallback.sunriseMinute, FROST_FALLBACK_SUN.sunriseMinute);
    assert.equal(Math.round(fallback.elevationDeg), FROST_FALLBACK_SUN.noonElevationDeg);
    assert.equal(frostSunFor({ clock: { minuteOfDay: 300 } }).elevationDeg, 0);
    // The terrain keys carry the quarter.
    assert.equal(frostQuarterOf({ frost: 3 }), 3);
    assert.equal(frostQuarterOf({ frost: 9 }), 4);
    assert.equal(frostQuarterOf(null), 0);
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'winter', sceneryRevision: 0, snowBucket: 0, bounds: { x: 0, y: 0, w: 1, h: 1 }, dpr: 1 };
    for (const frost of [0, 1, 2, 3, 4]) assert.ok(terrainArtifactKey({ ...inputs, frost }), `frost ${frost}`);
    for (const frost of [5, -1, 0.5, true]) assert.equal(terrainArtifactKey({ ...inputs, frost }), null);
});

test('shade keeps the rime at every quarter and the open lawn melts in nested patches', () => {
    // Node has no canvas, so the casts are absent: the walls' AO is the shade.
    const cols = 64;
    const rows = 64;
    const aoBuf = new Uint8Array(cols * rows);
    for (let row = 20; row < 30; row++) for (let col = 10; col < 14; col++) aoBuf[row * cols + col] = 200;
    const field = frostShadeField({ world: { buildings: new Map() }, treePropSprites: [] }, { cols, rows, x0: 0, y0: 0, texelW: 2, aoBuf });
    assert.equal(field.shade[25 * cols + 12], FROST_SHADE.WALL);
    assert.equal(field.shade[5 * cols + 50], FROST_SHADE.OPEN);
    for (const quarter of [1, 2, 3]) assert.ok(frostHolds(quarter, field, 12, 25, 0.99), `wall lee at ${quarter}`);
    assert.equal(frostHolds(4, field, 50, 5, 0.99), true);
    assert.equal(frostHolds(0, field, 12, 25, 0), false);
    assert.equal(frostHolds(1, field, 60, 60, 0.01), false, 'the open lawn far from shade is clear at 1');
    for (let order = 0; order <= 1; order += 0.05) {
        for (const [col, row] of [[60, 60], [16, 25], [20, 40]]) {
            for (const quarter of [1, 2]) {
                if (frostHolds(quarter, field, col, row, order)) assert.ok(frostHolds(quarter + 1, field, col, row, order), 'nested');
            }
        }
    }
    // Beside the shade the rime outlasts the open lawn (the sunny side goes first).
    const order = 0.5;
    assert.equal(frostHolds(2, field, 60, 60, order), false);
    assert.equal(frostHolds(2, field, 15, 24, order), true);
});
