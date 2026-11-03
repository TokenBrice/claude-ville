import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAtmosphereSnapshot,
    normalizeTimelineKnots,
    weatherHistorySampler,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { PRECIPITATING, rainClearedMinutesAgo } from '../../claudeville/src/presentation/character-mode/GroundState.js';
import {
    AURORA_SHEEN_SHARE,
    SEA_BOW_SHARE,
    SkyRenderer,
    auroraGateOpen,
    auroraSheenNight,
    seaBowWindow,
} from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

// LA-6a / LA-6b (D6) — the sky's rare phenomena on the far sea. Both read the
// village clock and weather only, and both must stay rare: a census over
// simulated years of the village's own timeline reports their fire rates.
const YEARS = [2025, 2026, 2027, 2028];

function census() {
    const out = { skyBows: 0, seaQualify: 0, seaBows: 0, auroraNights: 0, sheenNights: 0, strays: [] };
    for (const year of YEARS) {
        for (let day = new Date(year, 0, 1); day.getFullYear() === year; day = new Date(year, day.getMonth(), day.getDate() + 1)) {
            // A clearing: the minute the timeline's precipitation drops to the
            // ground history's PRECIPITATING; its window's middle is sampled.
            const sample = weatherHistorySampler(day);
            let previous = Number(sample(0).precipitation) || 0;
            for (let minute = 1; minute < 1430; minute++) {
                const precipitation = Number(sample(minute).precipitation) || 0;
                if (previous > PRECIPITATING && precipitation <= PRECIPITATING) {
                    const at = new Date(year, day.getMonth(), day.getDate(), 0, minute + 10);
                    const snapshot = createAtmosphereSnapshot({ now: at });
                    const sun = snapshot.sky.sun;
                    const since = rainClearedMinutesAgo(at);
                    const skyBow = since != null && sun.visible && sun.elevationDeg >= 0 && sun.elevationDeg < 42;
                    const qualifies = skyBow && sun.alpha >= 0.5 && sun.elevationDeg > 0
                        && (snapshot.weather.type === 'clear' || snapshot.weather.type === 'partly-cloudy');
                    if (skyBow) out.skyBows++;
                    if (qualifies) out.seaQualify++;
                    if (seaBowWindow(snapshot)) {
                        out.seaBows++;
                        if (!qualifies) out.strays.push(`bow ${at.toISOString()}`);
                    }
                }
                previous = precipitation;
            }
            // A night: every hour from 17:00 to 07:00 the next morning.
            let aurora = false;
            let sheen = false;
            for (let step = 0; step <= 14; step++) {
                const snapshot = createAtmosphereSnapshot({ now: new Date(year, day.getMonth(), day.getDate(), 17 + step, 0) });
                aurora ||= auroraGateOpen(snapshot);
                if (auroraSheenNight(snapshot)) {
                    sheen = true;
                    if (!auroraGateOpen(snapshot)) out.strays.push(`sheen ${day.toDateString()}`);
                }
            }
            if (aurora) out.auroraNights++;
            if (sheen) out.sheenNights++;
        }
    }
    return out;
}

test('the far-sea phenomena keep rare over simulated years', (t) => {
    const c = census();
    const perYear = n => n / YEARS.length;
    t.diagnostic(`per year over ${YEARS[0]}-${YEARS[YEARS.length - 1]}: sky bows ${perYear(c.skyBows)}, qualifying clearings ${perYear(c.seaQualify)}, sea bows ${perYear(c.seaBows)} (share ${SEA_BOW_SHARE}); aurora nights ${perYear(c.auroraNights)}, sheen nights ${perYear(c.sheenNights)} (share 1/${Math.round(1 / AURORA_SHEEN_SHARE)})`);
    assert.deepEqual(c.strays, [], 'every sea bow is a qualifying clearing, every sheen night an aurora night');
    // A handful of bows a year (each 20 minutes), never more than the sky's own.
    assert.ok(perYear(c.seaBows) >= 2 && perYear(c.seaBows) <= 10, `sea bows ${perYear(c.seaBows)}/yr`);
    assert.ok(c.seaBows <= c.seaQualify && c.seaQualify <= c.skyBows);
    // The sky's aurora opens on most winter nights; the sheen on a few.
    assert.ok(perYear(c.sheenNights) >= 2 && perYear(c.sheenNights) <= 12, `sheen nights ${perYear(c.sheenNights)}/yr`);
    assert.ok(c.sheenNights * 8 <= c.auroraNights, 'the sheen keeps to under one aurora night in eight');
});

function pinned(at, knots) {
    const timelineKnots = normalizeTimelineKnots(knots);
    const snapshot = createAtmosphereSnapshot({ now: at, timelineKnots, timelineMode: 'fixed' });
    snapshot.timeline = { mode: 'fixed', knots: timelineKnots, seedOverride: null };
    return snapshot;
}
const RAIN_TO_CLEAR = [{ minute: 0, type: 'rain' }, { minute: 840, type: 'rain' }, { minute: 930, type: 'clear' }, { minute: 1439, type: 'clear' }];
const CLEAR = [{ minute: 0, type: 'clear' }, { minute: 1439, type: 'clear' }];

// The capture board's poses (agents/research/.../board2/la6a, la6b) force
// these timelines; they must keep opening their gates.
test('the board poses open their gates: a bow on 4 Nov 15:30, a sheen on 17 Dec 22:00', () => {
    const bow = seaBowWindow(pinned(new Date(2026, 10, 4, 15, 30), RAIN_TO_CLEAR));
    assert.ok(bow, 'the forced clearing is a sea-bow clearing');
    assert.ok(bow.since >= 4 && bow.since < 16, `mid-window (since ${bow.since}): the full alpha quantum`);
    assert.equal(seaBowWindow(pinned(new Date(2026, 10, 4, 13, 0), RAIN_TO_CLEAR)), null, 'not while it rains');
    assert.equal(seaBowWindow(pinned(new Date(2026, 10, 4, 15, 50), RAIN_TO_CLEAR)), null, 'not past the 20-minute window');
    assert.equal(auroraSheenNight(pinned(new Date(2026, 11, 17, 22, 0), CLEAR)), true);
    assert.equal(auroraSheenNight(pinned(new Date(2026, 11, 18, 3, 0), CLEAR)), true, 'the sheen holds past midnight: the night is its evening');
    assert.equal(auroraSheenNight(pinned(new Date(2026, 11, 17, 13, 0), CLEAR)), false, 'never by day');
});

test('the far-sea gates never answer to agent state (V3)', () => {
    const agents = Array.from({ length: 24 }, (_, i) => ({ id: `a${i}`, status: i % 2 ? 'waiting' : 'working' }));
    const bowAt = pinned(new Date(2026, 10, 4, 15, 30), RAIN_TO_CLEAR);
    const sheenAt = pinned(new Date(2026, 11, 17, 22, 0), CLEAR);
    for (const extra of [{ agents: [] }, { agents, attention: { level: 'needs-you', count: 9 } }, { roster: agents, mood: 'busy', director: { cue: 'release' } }]) {
        assert.deepEqual(seaBowWindow({ ...bowAt, ...extra }), seaBowWindow(bowAt));
        assert.equal(auroraSheenNight({ ...sheenAt, ...extra }), auroraSheenNight(sheenAt));
    }
});

test('at look strength 0 the far sea holds nothing, even on a bow clearing and a sheen night', () => {
    const fields = { x: -1536, y: -144, cols: 4, rows: 4, coastField: new Uint8Array(32), revision: 'test' };
    const hadDocument = 'document' in globalThis;
    if (!hadDocument) globalThis.document = {};
    try {
        const sky = new SkyRenderer({ assets: { has: () => true, get: () => null } });
        setLookStrength('la6a', 0);
        setLookStrength('la6b', 0);
        for (const atmosphere of [pinned(new Date(2026, 10, 4, 15, 30), RAIN_TO_CLEAR), pinned(new Date(2026, 11, 17, 22, 0), CLEAR)]) {
            assert.equal(sky.farSeaLayers({ atmosphere, waterFields: fields }), null);
        }
    } finally {
        resetLookStrengths();
        if (!hadDocument) delete globalThis.document;
    }
});
