import test from 'node:test';
import assert from 'node:assert/strict';

import { GRADE_KEYFRAMES } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import {
    ARC_SPECIES,
    DAY_ARC,
    cricketLevel,
    cricketTemperature,
    dayArcAt,
    weatherBirdRates,
} from '../../claudeville/src/presentation/shared/audio/DayArc.js';

const minuteOf = name => GRADE_KEYFRAMES.find(key => key.name === name).minute;
// Spring has no sunrise/sunset shift: its keys sit on the authored minutes.
const at = (name, season = 'spring') => dayArcAt({ minuteOfDay: minuteOf(name), season });
const songs = rates => ARC_SPECIES.filter(name => name !== 'owl').reduce((sum, name) => sum + rates[name], 0);

test('the arc has one row per grade keyframe and lands on it at the key', () => {
    assert.deepEqual(Object.keys(DAY_ARC).sort(), GRADE_KEYFRAMES.map(key => key.name).sort());
    for (const key of GRADE_KEYFRAMES) {
        const arc = at(key.name);
        assert.ok(arc.key.startsWith(`${key.name}>`), `${key.name}: ${arc.key}`);
        assert.equal(arc.sea, DAY_ARC[key.name].sea);
    }
});

test('night is darker and stiller than noon: no songbirds, a calmer wind, the sea forward', () => {
    const noon = at('noon');
    for (const name of ['night', 'deep-night']) {
        const night = at(name);
        assert.equal(songs(night.rates), 0, name);
        assert.ok(night.rates.owl > 0, `${name}: the owl`);
        assert.ok(night.wind < noon.wind, `${name}: wind`);
        assert.ok(night.sea >= noon.sea, `${name}: sea`);
        assert.equal(night.dark, 1);
    }
    assert.equal(noon.dark, 0);
    assert.equal(noon.crickets, 0);
    assert.ok(at('night').crickets > at('deep-night').crickets);
});

test('the dawn chorus is the densest song of the day and thins toward noon', () => {
    const rate = name => songs(at(name).rates);
    assert.ok(rate('sunrise') > rate('morning'));
    assert.ok(rate('morning') > rate('noon'));
    assert.ok(rate('sunrise') >= 3 * rate('noon'));
    // Golden hour belongs to the blackbird.
    const golden = at('golden-hour').rates;
    assert.ok(ARC_SPECIES.every(name => golden.blackbird >= golden[name]));
});

test('the arc moves smoothly: no minute-to-minute jump in any target', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
        let prev = dayArcAt({ minuteOfDay: 0, season });
        for (let minute = 1; minute <= 1440; minute++) {
            const next = dayArcAt({ minuteOfDay: minute, season });
            for (const field of ['sea', 'wind', 'birds', 'crickets', 'dark']) {
                assert.ok(Math.abs(next[field] - prev[field]) < 0.02, `${season} ${minute} ${field}`);
            }
            assert.ok(Math.abs(songs(next.rates) - songs(prev.rates)) < 0.5, `${season} ${minute} rates`);
            prev = next;
        }
    }
});

test('seasons: winter keeps only the robin and no crickets; summer dawns come early', () => {
    const winterDawn = at('sunrise', 'winter');
    assert.ok(winterDawn.rates.robin > 0);
    assert.equal(songs(winterDawn.rates), winterDawn.rates.robin);
    assert.ok(songs(winterDawn.rates) < songs(at('sunrise', 'spring').rates) / 3);
    assert.equal(dayArcAt({ minuteOfDay: 23 * 60, season: 'winter' }).crickets, 0);
    assert.ok(songs(at('sunrise', 'spring').rates) > songs(at('sunrise', 'autumn').rates));

    // The keys follow the season's sunrise shift, like the picture.
    const early = 5 * 60 + 30;
    assert.match(dayArcAt({ minuteOfDay: early, season: 'summer' }).key, /^sunrise>/);
    assert.match(dayArcAt({ minuteOfDay: early, season: 'winter' }).key, /^pre-dawn>/);
});

test('crickets: drizzle leaves the chorus, steady rain silences it, a storm stops it', () => {
    assert.equal(cricketLevel(1), 1);
    assert.equal(cricketLevel(1, { precipitation: 0.05 }), 1);
    assert.ok(cricketLevel(1, { precipitation: 0.2 }) < 0.5);
    assert.equal(cricketLevel(1, { precipitation: 0.4 }), 0);
    assert.equal(cricketLevel(1, { precipitation: 0, storm: 0.3 }), 0);
    assert.equal(cricketLevel(at('noon').crickets), 0);
});

test('birds thin in rain and fall silent in a storm; the night cools the chorus', () => {
    const noon = at('noon').rates;
    assert.ok(songs(weatherBirdRates(noon, { precipitation: 0.6 })) < songs(noon) / 2);
    assert.equal(songs(weatherBirdRates(noon, { storm: 1 })), 0);
    assert.ok(cricketTemperature('summer', 1) < cricketTemperature('summer', 0));
    assert.ok(cricketTemperature('winter') < cricketTemperature('autumn'));
});
