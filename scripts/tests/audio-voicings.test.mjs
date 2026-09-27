import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BANDS,
    FLOOR_LU,
    KEYFRAMES,
    NIGHT_BRIGHT,
    NIGHT_DARK_BRIGHT,
    NIGHT_LEAD_CEILING_MIDI,
    SEASONS,
    STEM_TARGETS,
    VOICES,
    WEATHERS,
    arrangementWeatherFor,
    voicingFor,
} from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { INSTRUMENTS } from '../../claudeville/src/presentation/shared/audio/music/Instruments.js';
import { GRADE_KEYFRAMES } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { PIECES } from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';

const NIGHT_KEYFRAMES = ['deep-night', 'pre-dawn', 'blue-hour', 'night'];
const DAY_KEYFRAMES = KEYFRAMES.filter(k => !NIGHT_KEYFRAMES.includes(k));
// No piece (the keyframe rows) and every piece's own players.
const PIECE_NAMES = [null, ...PIECES.map(p => p.name)];

function* everyArrangement() {
    for (const voice of VOICES) {
        for (const keyframe of KEYFRAMES) {
            for (const weather of WEATHERS) {
                for (const season of SEASONS) {
                    for (const piece of PIECE_NAMES) yield { voice, keyframe, weather, season, piece };
                }
            }
        }
    }
}

// Who plays which admitted seat, in which register (and, with `figure`,
// which figure).
const signature = ({ seats, admitted }, { figure = false } = {}) => admitted
    .map(seat => `${seat}:${seats[seat].instrument}@${seats[seat].octaveShift}${figure ? `/${seats[seat].figure ?? ''}` : ''}`)
    .join(' ');

test('keyframes are the grade keyframes', () => {
    assert.deepEqual([...KEYFRAMES].sort(), GRADE_KEYFRAMES.map(k => k.name).sort());
});

test('every seat and kit plays an instrument the band owns', () => {
    for (const input of everyArrangement()) {
        const { seats, key } = voicingFor(input);
        for (const [seat, { instrument, kit }] of Object.entries(seats)) {
            assert.ok(INSTRUMENTS[instrument], `${key} ${seat}: ${instrument}`);
            for (const name of Object.values(kit ?? {})) assert.ok(INSTRUMENTS[name], `${key} kit: ${name}`);
        }
    }
});

test('every seat of every arrangement meets its MUSL-2 stem target, the lead loudest', () => {
    for (const input of everyArrangement()) {
        for (let band = 0; band < BANDS.length; band++) {
            const v = voicingFor({ ...input, band });
            for (const seat of v.admitted) {
                const { stemLu } = v.seats[seat];
                const target = STEM_TARGETS[seat];
                const where = `${v.key} band ${band} ${seat}`;
                assert.ok(Math.abs(stemLu - target.lu) <= target.tol, `${where}: ${stemLu} vs ${target.lu} ± ${target.tol}`);
                assert.ok(stemLu >= FLOOR_LU, `${where}: under the audibility floor`);
                if (seat !== 'lead') assert.ok(stemLu < v.seats.lead.stemLu, `${where}: louder than the lead`);
            }
        }
    }
});

test('each working band adds a player, day and night, in both voicings', () => {
    for (const voice of VOICES) {
        for (const keyframe of KEYFRAMES) {
            for (const season of SEASONS) {
                const bands = BANDS.map((_, band) => voicingFor({ voice, keyframe, season, band }));
                assert.deepEqual(bands[0].admitted, ['lead', 'bass']);
                for (let b = 1; b < bands.length; b++) {
                    const below = new Set(bands[b - 1].admitted);
                    const added = bands[b].admitted.filter(seat => !below.has(seat));
                    assert.ok(added.length > 0, `${bands[b].key} band ${b} adds no player`);
                    assert.ok(bands[b - 1].admitted.every(seat => bands[b].admitted.includes(seat)));
                    // The band admits players; it never re-seats them.
                    assert.equal(bands[b].seats, bands[0].seats);
                }
            }
        }
    }
});

test('band names and indices agree, and a storm caps the band', () => {
    assert.deepEqual(voicingFor({ band: 'full' }).admitted, voicingFor({ band: 3 }).admitted);
    const storm = voicingFor({ weather: 'storm', band: 3 });
    assert.equal(storm.band, 1);
    assert.ok(!storm.admitted.includes('percussion'));
    assert.equal(storm.seats.bass.figure, 'drone');
});

test('at night the lead sounds at or under A5 and a piece\'s Isle players play darker than by day, its harp and dulcimer darkest', () => {
    for (const piece of PIECES) {
        const top = Math.max(...piece.melody.map(([semi]) => semi).filter(semi => semi !== null));
        for (const voice of VOICES) {
            for (const keyframe of NIGHT_KEYFRAMES) {
                for (const weather of WEATHERS) {
                    const { seats, key } = voicingFor({ voice, keyframe, weather, piece: piece.name });
                    assert.ok(69 + top + seats.lead.octaveShift <= NIGHT_LEAD_CEILING_MIDI, key);
                    if (voice !== 'isle') continue;
                    const day = voicingFor({ voice, keyframe: 'noon', weather, piece: piece.name }).seats;
                    for (const seat of ['lead', 'counter', 'engine', 'descant']) {
                        assert.ok(seats[seat].bright <= NIGHT_BRIGHT * day[seat].bright + 1e-3, `${key} ${seat}`);
                        if (['harp', 'dulcimer'].includes(seats[seat].instrument)) assert.ok(seats[seat].bright <= NIGHT_DARK_BRIGHT, `${key} ${seat}`);
                    }
                }
            }
        }
    }
});

test('every piece has its own players: no two of a family share lead, counter and comp, and the leads spread', () => {
    const players = piece => ['lead', 'counter', 'engine'].map(seat => piece.arrangement[seat][0]);
    for (const [family, minLeads] of [['day', 5], ['night', 4]]) {
        const pieces = PIECES.filter(p => p.family === family);
        const triples = pieces.map(p => players(p).join('/'));
        assert.equal(new Set(triples).size, triples.length, `${family}: ${triples.join(', ')}`);
        assert.ok(new Set(pieces.map(p => p.arrangement.lead[0])).size >= minLeads, `${family} leads`);
    }
    const byName = Object.fromEntries(PIECES.map(p => [p.name, p]));
    assert.deepEqual(players(byName.willowbrook), ['whistle', 'lute', 'marimba']);
    assert.equal(byName.lanternlight.arrangement.lead[0], 'musicBox');
    for (const piece of PIECES) assert.equal(voicingFor({ piece: piece.name }).seats.bass.instrument, 'upright', piece.name);
});

test('a piece\'s players replace the keyframe row\'s; the row still darkens them, the weather re-dresses them without swapping them, Chip keeps its rows', () => {
    for (const piece of PIECES.filter(p => p.family === 'day')) {
        const [lead, , over = {}] = piece.arrangement.lead;
        const noon = voicingFor({ keyframe: 'noon', piece: piece.name });
        assert.equal(noon.seats.lead.instrument, lead, piece.name);
        assert.equal(noon.seats.counter.instrument, piece.arrangement.counter[0], piece.name);
        // Sunrise darkens the whole row (bright 0.9), the piece's players too.
        const sunrise = voicingFor({ keyframe: 'sunrise', piece: piece.name });
        assert.equal(sunrise.seats.lead.instrument, lead);
        assert.ok(Math.abs(sunrise.seats.lead.bright - 0.9 * (over.bright ?? 1)) < 1e-3, piece.name);
        // Rain, a storm and snow keep the piece's instruments on every seat
        // and re-dress only the figure and the attack.
        for (const weather of ['rain', 'storm', 'snow']) {
            const wet = voicingFor({ keyframe: 'noon', weather, piece: piece.name });
            for (const seat of ['lead', 'counter', 'engine', 'descant']) {
                assert.equal(wet.seats[seat].instrument, noon.seats[seat].instrument, `${piece.name} ${weather} ${seat}`);
                assert.ok(wet.seats[seat].soft > noon.seats[seat].soft, `${piece.name} ${weather} ${seat} attack`);
            }
            assert.equal(wet.seats.engine.figure, weather === 'snow' ? 'glitter' : 'sustain');
        }
        // With no piece the row still swaps colours: rain's whistle over a harp.
        const rowRain = voicingFor({ keyframe: 'noon', weather: 'rain' });
        assert.deepEqual([rowRain.seats.lead.instrument, rowRain.seats.engine.instrument], ['whistle', 'harp']);
        for (const keyframe of DAY_KEYFRAMES) {
            assert.deepEqual(voicingFor({ voice: 'chip', keyframe, piece: piece.name }).seats, voicingFor({ voice: 'chip', keyframe }).seats);
        }
    }
    // The season colours the cadence and never swaps the players.
    for (const season of SEASONS) {
        const v = voicingFor({ keyframe: 'noon', season, piece: 'willowbrook' });
        assert.equal(v.seats.lead.instrument, 'whistle', season);
    }
});

test('the keyframes are coloured by instrument or register', () => {
    const byKeyframe = new Map(KEYFRAMES.map(keyframe => [keyframe, signature(voicingFor({ keyframe, band: 3 }))]));
    // MUSL-8's rows: morning and noon are one row, every other differs.
    const rows = KEYFRAMES.filter(k => k !== 'noon').map(k => byKeyframe.get(k));
    assert.equal(new Set(rows).size, rows.length, 'two keyframes share an arrangement');
    assert.equal(byKeyframe.get('morning'), byKeyframe.get('noon'));
    const chipDay = voicingFor({ voice: 'chip', keyframe: 'noon' }).seats.lead.instrument;
    const chipNight = voicingFor({ voice: 'chip', keyframe: 'night' }).seats.lead.instrument;
    assert.notEqual(chipDay, chipNight);
});

test('dusk keeps the whole band in its written register (MUS-13)', () => {
    for (const voice of VOICES) {
        for (const piece of PIECE_NAMES) {
            const { seats, tempoScale } = voicingFor({ voice, keyframe: 'golden-hour', piece });
            assert.ok(tempoScale < 1);
            for (const seat of Object.values(seats)) assert.equal(seat.octaveShift, 0);
        }
    }
});

test('rain and snow re-dress the tune with softer attacks', () => {
    for (const voice of VOICES) {
        for (const keyframe of KEYFRAMES) {
            for (const season of SEASONS) {
                for (const piece of PIECE_NAMES) {
                    const clear = voicingFor({ voice, keyframe, season, band: 3, piece });
                    for (const weather of ['rain', 'snow']) {
                        const wet = voicingFor({ voice, keyframe, season, weather, band: 3, piece });
                        assert.notEqual(signature(wet, { figure: true }), signature(clear, { figure: true }), `${wet.key}: same arrangement as clear`);
                        for (const seat of wet.admitted) {
                            assert.ok(wet.seats[seat].soft > clear.seats[seat].soft, `${wet.key} ${seat} attack not softer`);
                            assert.ok(wet.seats[seat].bright <= clear.seats[seat].bright, `${wet.key} ${seat} brighter`);
                        }
                        if (voice === 'isle') {
                            const kit = Object.values(wet.seats.percussion.kit);
                            assert.ok(!kit.includes('rim') && !kit.includes('lowTom'), `${wet.key}: a hard percussion hit`);
                        }
                    }
                }
            }
        }
    }
});

test('Chip plays chip instruments in every seat', () => {
    for (const keyframe of KEYFRAMES) {
        const chip = voicingFor({ voice: 'chip', keyframe, band: 3, piece: 'willowbrook' });
        assert.ok(Object.values(chip.seats).every(seat => seat.instrument.startsWith('chip')));
    }
});

test('atmosphere weather maps onto the arrangement weathers', () => {
    assert.equal(arrangementWeatherFor({ type: 'rain' }, 'summer'), 'rain');
    assert.equal(arrangementWeatherFor({ type: 'rain' }, 'winter'), 'snow');
    assert.equal(arrangementWeatherFor({ type: 'storm' }, 'winter'), 'snow');
    assert.equal(arrangementWeatherFor('storm', 'autumn'), 'storm');
    assert.equal(arrangementWeatherFor({ type: 'overcast' }, 'summer'), 'clear');
    assert.equal(arrangementWeatherFor({ type: 'partly-cloudy' }), 'clear');
    assert.equal(arrangementWeatherFor({ type: 'fog' }), 'fog');
    assert.equal(voicingFor({ weather: 'overcast' }).weather, 'clear');
});
