import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AMBIENT_TIERS,
    ambientEventsForHost,
    buildAmbientSchedule,
    createAmbientScheduler,
} from '../../claudeville/src/presentation/character-mode/AmbientEvents.js';

const FAIR = Object.freeze({ type: 'clear', nextType: 'clear', cloudCover: 0.1, transitionProgress: 0.4, precipitation: 0 });
const DAY = Object.freeze({ weather: FAIR, phase: 'day', season: 'autumn', motionScale: 1, level: 0, calm: false });

function sweep(scheduler, start, minutes, ctx) {
    const out = [];
    for (let t = start; t < start + minutes * 60000; t += 10000) {
        const r = scheduler.at(t, ctx);
        out.push(JSON.stringify(r));
    }
    return out;
}

test('a date always yields the same schedule and the same live events', () => {
    const date = new Date(2026, 9, 9, 12, 0, 0);
    assert.deepEqual(
        JSON.parse(JSON.stringify(buildAmbientSchedule(date).frequent.map(s => [s.startMs, s.capMs, s.seed]))),
        JSON.parse(JSON.stringify(buildAmbientSchedule(new Date(2026, 9, 9, 3, 0, 0)).frequent.map(s => [s.startMs, s.capMs, s.seed]))),
    );
    assert.deepEqual(sweep(createAmbientScheduler(), date.getTime(), 60, DAY), sweep(createAmbientScheduler(), date.getTime(), 60, DAY));
    assert.notDeepEqual(
        buildAmbientSchedule(date).frequent[0].startMs - buildAmbientSchedule(date).dayStartMs,
        buildAmbientSchedule(new Date(2026, 9, 10)).frequent[0].startMs - buildAmbientSchedule(new Date(2026, 9, 10)).dayStartMs,
    );
});

test('tiers keep their cadence and never run two events at once', () => {
    const schedule = buildAmbientSchedule(new Date(2026, 6, 1));
    for (const tier of AMBIENT_TIERS) {
        const slots = schedule[tier];
        for (let i = 1; i < slots.length; i++) assert.ok(slots[i - 1].capMs <= slots[i].startMs, `${tier} slots overlap`);
    }
    for (let i = 1; i < schedule.frequent.length - 1; i++) {
        const gap = (schedule.frequent[i + 1].startMs - schedule.frequent[i].startMs) / 1000;
        assert.ok(gap >= 120 && gap <= 360, `frequent gap ${gap}s`);
    }
    for (let i = 1; i < schedule.occasional.length - 1; i++) {
        const gap = (schedule.occasional[i + 1].startMs - schedule.occasional[i].startMs) / 1000;
        assert.ok(gap >= 1200 && gap <= 3600, `occasional gap ${gap}s`);
    }
    assert.ok(schedule.rare.length <= 3);
    const scheduler = createAmbientScheduler();
    let live = 0;
    for (let t = schedule.dayStartMs; t < schedule.dayEndMs; t += 10000) {
        const r = scheduler.at(t, DAY);
        for (const tier of AMBIENT_TIERS) {
            const event = r[tier];
            if (!event) continue;
            live++;
            assert.equal(event.tier, tier);
            assert.ok(event.endMs > event.startMs);
        }
    }
    assert.ok(live > 0, 'a fair day schedules frequent events');
});

test('reduced motion holds every tier; calm holds the set-piece tiers', () => {
    const scheduler = createAmbientScheduler();
    const start = new Date(2026, 9, 9, 10, 0, 0).getTime();
    for (let t = start; t < start + 3600000; t += 10000) {
        const held = scheduler.at(t, { ...DAY, motionScale: 0 });
        for (const tier of AMBIENT_TIERS) {
            assert.equal(held[tier], null);
            assert.equal(held.held[tier], 'reduced-motion');
        }
        const calm = scheduler.at(t, { ...DAY, calm: true });
        assert.equal(calm.occasional, null);
        assert.equal(calm.rare, null);
    }
});

test('a storm or the night keeps fair-weather kinds off', () => {
    const scheduler = createAmbientScheduler();
    const start = new Date(2026, 9, 9, 10, 0, 0).getTime();
    for (let t = start; t < start + 3600000; t += 10000) {
        const storm = scheduler.at(t, { ...DAY, weather: { ...FAIR, type: 'storm', cloudCover: 0.95 } });
        assert.equal(storm.frequent, null);
        const night = scheduler.at(t, { ...DAY, phase: 'night' });
        assert.notEqual(night.frequent?.kind, 'lone-cloud');
    }
});

test('the host adapter reads no agent state: any roster gives the same events', () => {
    const atmosphere = { effectiveDate: new Date(2026, 9, 9, 14, 0, 0), weather: FAIR, phase: 'day', clock: { date: new Date(2026, 9, 9, 14, 0, 0) } };
    const empty = { _lastAtmosphere: atmosphere, motionScale: 1, world: { agents: new Map() } };
    const crowd = {
        _lastAtmosphere: atmosphere,
        motionScale: 1,
        world: { agents: new Map(Array.from({ length: 40 }, (_, i) => [`a${i}`, { id: `a${i}`, status: 'working' }])) },
        agentSprites: new Map([['a0', {}]]),
    };
    assert.deepEqual(
        JSON.parse(JSON.stringify(ambientEventsForHost(empty))),
        JSON.parse(JSON.stringify(ambientEventsForHost(crowd))),
    );
});
