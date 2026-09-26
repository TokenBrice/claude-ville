import assert from 'node:assert/strict';
import test from 'node:test';

import {
    D1_DUTY,
    EARNED_RULES,
    OccasionClock,
    URGENT_QUIET_MS,
    WAIT_LIMIT_MS,
    dutyBandFor,
} from '../../claudeville/src/presentation/shared/audio/OccasionClock.js';
import { rngStream } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const SEC = 1000;
const MIN = 60 * SEC;
// 2026-09-26 00:00 local: the tests key days on the local calendar.
const DAY0 = new Date(2026, 8, 26).getTime();
const at = (hh, mm = 0, day = 0) => DAY0 + day * 24 * 60 * MIN + (hh * 60 + mm) * MIN;

// The round-2 day fragments (MUSL §D1) and their nominal lengths; an
// occasion lasts 68.5 s like the Millbrook dawn occasion.
const FRAGMENTS = [
    { id: 'willowbrook-call-home', source: 'willowbrook', sec: 11.43, motif: 'call' },
    { id: 'willowbrook-b', source: 'willowbrook', sec: 5.71 },
    { id: 'willowbrook-a2', source: 'willowbrook', sec: 11.43 },
    { id: 'millbrook-b', source: 'millbrook', sec: 6.67 },
    { id: 'millbrook-a-close', source: 'millbrook', sec: 13.33 },
    { id: 'hearthfire-a-close', source: 'hearthfire', sec: 8.18 },
    { id: 'isle-call-home', source: 'isle', sec: 6.07, motif: 'call' },
    { id: 'lanternway-b-night', source: 'lanternway', sec: 17.14, night: true },
    // A songbook-sized pool: more day cells than a busy hour plays.
    ...Array.from({ length: 24 }, (_, i) => ({ id: `cell-${i}`, source: `song-${i % 6}`, sec: 9 })),
];
const OCCASION_SEC = 68.5;
const lengthOf = (decision) => (decision.kind === 'fragment'
    ? FRAGMENTS.find(cell => cell.id === decision.cellRef)?.sec ?? 9
    : OCCASION_SEC);

// Island input for a minute of the equinox day (AtmosphereState's phases).
function island(now, extra = {}) {
    const minute = Math.floor((now - DAY0) / MIN) % 1440;
    let phase = 'night';
    let phaseProgress = 0;
    if (minute >= 330 && minute < 420) { phase = 'dawn'; phaseProgress = (minute - 330) / 90; }
    else if (minute >= 420 && minute < 1050) { phase = 'day'; phaseProgress = (minute - 420) / 630; }
    else if (minute >= 1050 && minute < 1200) { phase = 'dusk'; phaseProgress = (minute - 1050) / 150; }
    const keyframe = minute >= 120 && minute < 270 ? 'deep-night' : (minute >= 270 && minute < 360 ? 'pre-dawn' : 'other');
    return { phase, phaseProgress, minuteOfDay: minute, keyframe, working: 6, ...extra };
}

// A 1 Hz director over [from, to): plays what the clock asks, reports spans.
function simulate(clock, from, to, inputAt = island, onTick = null) {
    const log = [];
    for (let now = from; now < to; now += SEC) {
        onTick?.(now, clock);
        const input = inputAt(now);
        const decision = clock.decide(now, input);
        if (decision?.action === 'start') {
            const startsAtMs = now + 150;
            clock.started(now, decision, { startsAtMs, endsAtMs: startsAtMs + lengthOf(decision) * SEC });
            log.push({ at: now, ...decision, input });
        } else if (decision?.action === 'stop') {
            clock.ended(now + 400);
            log.push({ at: now, ...decision, input });
        }
    }
    return log;
}

const newClock = (seed = 'test', ledger = { firstOccasion: true, welcomeDay: '2026-09-26' }) => (
    new OccasionClock({ rng: rngStream(`occasion.${seed}`), ledger, fragments: FRAGMENTS })
);

test('a busy working day (09:00–18:00) plays fragments inside D1 busy duty, plus the noon occasion once', () => {
    for (const seed of ['a', 'b', 'c']) {
        const clock = newClock(seed);
        clock.noteEnable(at(9));
        const hourly = [];
        const log = [];
        for (let hour = 9; hour < 18; hour++) {
            log.push(...simulate(clock, at(hour), at(hour + 1)));
            hourly.push(clock.dutyLastHour(at(hour + 1)));
        }
        const starts = log.filter(entry => entry.action === 'start');
        assert.ok(starts.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0));
        assert.deepEqual(starts.filter(entry => entry.kind === 'occasion').map(entry => entry.occasion), ['noon']);
        // The first hour starts from silence; every later hour is a full one.
        for (const [i, duty] of hourly.entries()) {
            assert.ok(duty <= D1_DUTY.busy.maxDuty, `${seed} hour ${9 + i}: ${duty}`);
            if (i > 0) assert.ok(duty >= D1_DUTY.busy.minDuty, `${seed} hour ${9 + i}: ${duty}`);
        }
        // One fragment every 2–3 min, except where the hour's duty cap holds
        // one back behind the noon occasion (fragments yield first).
        const fragments = starts.filter(entry => entry.kind === 'fragment');
        const noonAt = starts.find(entry => entry.occasion === 'noon').at;
        for (let i = 1; i < starts.length; i++) {
            if (starts[i].kind !== 'fragment' || starts[i - 1].kind !== 'fragment') continue;
            if (starts[i].at > noonAt && starts[i].at < noonAt + 60 * MIN) continue;
            const gap = (starts[i].at - starts[i - 1].at) / SEC;
            assert.ok(gap >= 110 && gap <= 180, `${seed} gap ${gap}`);
        }
        // No cell is heard twice within an hour.
        for (let i = 1; i < fragments.length; i++) {
            const previous = fragments.slice(0, i).findLast(entry => entry.cellRef === fragments[i].cellRef);
            if (previous) assert.ok(fragments[i].at - previous.at >= 60 * MIN, `${seed} ${fragments[i].cellRef} again after ${(fragments[i].at - previous.at) / MIN} min`);
        }
        // Never the same song twice in a row.
        const sources = fragments.map(entry => FRAGMENTS.find(cell => cell.id === entry.cellRef).source);
        for (let i = 1; i < sources.length; i++) assert.notEqual(sources[i], sources[i - 1], `${seed} ${sources[i]} back to back`);
    }
});

test('an occasion released before its first note is deferred, not spent', () => {
    const clock = new OccasionClock({ rng: rngStream('occasion.unheard'), ledger: null, fragments: FRAGMENTS });
    clock.noteEnable(at(9));
    const first = clock.decide(at(9), island(at(9)));
    assert.equal(first.occasion, 'first');
    // The sequencer places it 1.5 s ahead; the rain is known a tick later.
    clock.started(at(9), first, { startsAtMs: at(9) + 1500, endsAtMs: at(9) + 70 * SEC });
    clock.takeLedgerChange();
    assert.deepEqual(clock.decide(at(9) + SEC, island(at(9), { raining: true, playing: true })), { action: 'stop', reason: 'rain' });
    clock.ended(at(9) + 2 * SEC);
    assert.equal(clock.takeLedgerChange(), true);
    assert.equal(clock.ledger.firstOccasion, false);
    assert.equal(clock.dutyLastHour(at(9, 1)), 0);
    const later = at(9, 1);
    assert.equal(clock.decide(later, island(later))?.occasion, 'first');
});

test('a piece played whole as an occasion keeps its fragments out of the next hour', () => {
    const clock = new OccasionClock({
        rng: rngStream('occasion.source'),
        ledger: { firstOccasion: true, welcomeDay: '2026-09-26' },
        fragments: FRAGMENTS,
        occasions: { noon: { piece: 'millbrook' } },
    });
    clock.noteEnable(at(11, 50));
    const log = simulate(clock, at(11, 50), at(12, 50));
    assert.equal(log[0].occasion, 'noon');
    const cells = log.filter(e => e.kind === 'fragment').map(e => FRAGMENTS.find(c => c.id === e.cellRef).source);
    assert.ok(cells.length > 10);
    assert.ok(!cells.includes('millbrook'), cells.join(','));
});

test('the hard zeros hold: resting, rain, a long wait and an urgent cue start nothing', () => {
    const clock = newClock('zeros');
    clock.noteEnable(at(9));
    let urgentAt = null;
    const input = (now) => {
        const minute = (now - at(9)) / MIN;
        return island(now, {
            resting: minute >= 10 && minute < 25,
            raining: minute >= 30 && minute < 45,
            oldestWaitMs: minute >= 50 && minute < 65 ? WAIT_LIMIT_MS + (minute - 50) * MIN : 0,
        });
    };
    const log = simulate(clock, at(9), at(10, 30), input, (now) => {
        if ((now - at(9)) % (7 * MIN) === 0) { clock.noteUrgent(now); urgentAt = now; }
        if (urgentAt !== null && now - urgentAt < URGENT_QUIET_MS) {
            const decision = clock.decide(now, input(now));
            assert.ok(decision?.action !== 'start', 'no start within 5 s of an urgent cue');
        }
    });
    for (const entry of log.filter(e => e.action === 'start')) {
        assert.ok(!entry.input.resting && !entry.input.raining && entry.input.oldestWaitMs < WAIT_LIMIT_MS);
    }
    assert.ok(log.some(e => e.action === 'start'), 'music returns between the zeros');
});

test('music already playing is released when a hard zero becomes true', () => {
    const clock = newClock('release');
    clock.noteEnable(at(12));
    // The noon occasion starts at once.
    const start = clock.decide(at(12), island(at(12)));
    assert.equal(start.occasion, 'noon');
    clock.started(at(12), start, { startsAtMs: at(12), endsAtMs: at(12) + OCCASION_SEC * SEC });
    assert.equal(clock.decide(at(12) + 5 * SEC, island(at(12))), null);
    assert.deepEqual(clock.decide(at(12) + 6 * SEC, island(at(12), { raining: true })), { action: 'stop', reason: 'rain' });
    // Asked once; the release is in flight.
    assert.equal(clock.decide(at(12) + 7 * SEC, island(at(12), { raining: true })), null);
    clock.ended(at(12) + 7 * SEC);

    const again = newClock('urgent');
    const noon = again.decide(at(12), island(at(12)));
    again.started(at(12), noon, { startsAtMs: at(12), endsAtMs: at(12) + OCCASION_SEC * SEC });
    again.noteUrgent(at(12) + 20 * SEC);
    assert.deepEqual(again.decide(at(12) + 20 * SEC, island(at(12))), { action: 'stop', reason: 'urgent' });

    const wait = newClock('wait');
    const tune = wait.decide(at(12), island(at(12)));
    wait.started(at(12), tune, { startsAtMs: at(12), endsAtMs: at(12) + OCCASION_SEC * SEC });
    assert.deepEqual(wait.decide(at(12) + 30 * SEC, island(at(12), { oldestWaitMs: WAIT_LIMIT_MS })), { action: 'stop', reason: 'wait' });
});

test('a phase occasion is deferred through rain, not dropped, and never outlives its phase', () => {
    const rainy = newClock('defer');
    rainy.noteEnable(at(11, 40));
    const log = simulate(rainy, at(11, 40), at(14), now => island(now, { raining: now < at(13, 10) }));
    const noon = log.filter(e => e.occasion === 'noon');
    assert.equal(noon.length, 1);
    assert.ok(noon[0].at >= at(13, 10) && noon[0].at < at(13, 11));

    const washedOut = newClock('lost');
    washedOut.noteEnable(at(11, 40));
    const lost = simulate(washedOut, at(11, 40), at(18, 30), now => island(now, { raining: now < at(17, 35) }));
    assert.ok(!lost.some(e => e.occasion === 'noon'), 'noon is over once the day phase ends');
    assert.ok(lost.some(e => e.occasion === 'dusk'), 'dusk keeps its own occasion');
});

test('night and deep night stay under their D1 caps', () => {
    const clock = newClock('night');
    clock.noteEnable(at(22));
    const log = simulate(clock, at(22), at(4, 30, 1), now => island(now, { working: 1 }));
    assert.deepEqual(log.filter(e => e.kind === 'occasion').map(e => e.occasion), ['night']);
    assert.ok(clock.dutyLastHour(at(0, 0, 1)) <= D1_DUTY.night.maxDuty);
    assert.ok(clock.dutyLastHour(at(4, 0, 1)) <= D1_DUTY.deepNight.maxDuty);
    assert.ok(log.filter(e => e.kind === 'fragment').every(e => e.cellRef === 'lanternway-b-night'));
    assert.equal(dutyBandFor(island(at(3, 0, 1))).name, 'deepNight');
});

test('the first-ever enable plays one full occasion; the welcome is once per calendar day', () => {
    const clock = new OccasionClock({ rng: rngStream('occasion.first'), ledger: null, fragments: FRAGMENTS });
    clock.noteEnable(at(9));
    const first = clock.decide(at(9), island(at(9)));
    assert.equal(first.occasion, 'first');
    clock.started(at(9), first, { startsAtMs: at(9), endsAtMs: at(9) + OCCASION_SEC * SEC });
    clock.ended(at(9) + OCCASION_SEC * SEC);
    assert.equal(clock.ledger.firstOccasion, true);

    // A re-enable the same day is not welcomed again; the next day is.
    const later = new OccasionClock({ rng: rngStream('occasion.first2'), ledger: clock.ledger, fragments: FRAGMENTS });
    later.noteEnable(at(15));
    assert.equal(later.snapshot(at(15)).pending.length, 0);
    const tomorrow = new OccasionClock({ rng: rngStream('occasion.first3'), ledger: clock.ledger, fragments: FRAGMENTS });
    tomorrow.noteEnable(at(9, 0, 1));
    assert.equal(tomorrow.decide(at(9, 0, 1), island(at(9, 0, 1))).occasion, 'welcome');

    // A first enable inside noon's window plays the noon tune once, not twice.
    const atNoon = new OccasionClock({ rng: rngStream('occasion.first4'), ledger: null, fragments: FRAGMENTS });
    atNoon.noteEnable(at(12, 10));
    const log = simulate(atNoon, at(12, 10), at(13));
    assert.deepEqual(log.filter(e => e.kind === 'occasion').map(e => e.occasion), ['first']);
});

test('earned occasions: the release follows the gold peal and expires; a return needs 20 min away', () => {
    const clock = newClock('earned');
    clock.noteEnable(at(10));
    clock.noteRelease(at(10, 1));
    assert.notEqual(clock.decide(at(10, 1), island(at(10, 1)))?.occasion, 'release');
    const release = clock.decide(at(10, 1) + EARNED_RULES.release.afterMs, island(at(10, 1)));
    assert.equal(release.occasion, 'release');
    assert.equal(release.reason, 'occasion:release');

    const stale = newClock('stale');
    stale.noteEnable(at(10));
    stale.noteRelease(at(10, 1));
    const late = at(10, 1) + EARNED_RULES.release.afterMs + EARNED_RULES.release.expiresMs + SEC;
    for (let now = at(10, 1); now < late; now += SEC) stale.decide(now, island(now, { raining: true }));
    assert.notEqual(stale.decide(late, island(late))?.occasion, 'release');

    const back = newClock('return');
    back.noteEnable(at(10));
    back.noteReturn(at(10, 5), 5 * MIN);
    assert.deepEqual(back.snapshot(at(10, 5)).pending, []);
    back.noteReturn(at(10, 6), 25 * MIN);
    assert.equal(back.decide(at(10, 6), island(at(10, 6))).occasion, 'return');
});
