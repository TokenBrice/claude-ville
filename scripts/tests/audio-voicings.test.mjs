import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BANDS,
    FLOOR_LU,
    KEYFRAMES,
    MODES,
    NIGHT_LEAD_CEILING_MIDI,
    SEASONS,
    STEM_TARGETS,
    VOICES,
    WEATHERS,
    arrangementWeatherFor,
    voicingFor,
} from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { INSTRUMENTS } from '../../claudeville/src/presentation/shared/audio/music/Instruments.js';
import { DAY_ARC } from '../../claudeville/src/presentation/shared/audio/DayArc.js';
import { PIECES } from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';

const NIGHT_KEYFRAMES = ['deep-night', 'pre-dawn', 'blue-hour', 'night'];

function* everyArrangement() {
    for (const voice of VOICES) {
        for (const mode of MODES) {
            for (const keyframe of KEYFRAMES) {
                for (const weather of WEATHERS) {
                    for (const season of SEASONS) {
                        yield { voice, mode, keyframe, weather, season };
                    }
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

test('keyframes are the day arc rows', () => {
    assert.deepEqual([...KEYFRAMES].sort(), Object.keys(DAY_ARC).sort());
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

test('each Town band working band adds a player, day and night, in both voicings', () => {
    for (const voice of VOICES) {
        for (const keyframe of KEYFRAMES) {
            for (const season of SEASONS) {
                const bands = BANDS.map((_, band) => voicingFor({ voice, mode: 'townBand', keyframe, season, band }));
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

test('band names and indices agree, and caps hold the band', () => {
    assert.deepEqual(voicingFor({ band: 'full' }).admitted, voicingFor({ band: 3 }).admitted);
    const storm = voicingFor({ weather: 'storm', band: 3 });
    assert.equal(storm.band, 1);
    assert.ok(!storm.admitted.includes('percussion'));
    assert.equal(storm.seats.bass.figure, 'drone');
    assert.deepEqual(voicingFor({ mode: 'village', keyframe: 'deep-night', band: 3 }).admitted, ['lead', 'bass']);
});

test('the night lead sounds at or under A5 on the music box or the flute', () => {
    const nightMax = Math.max(...PIECES
        .filter(piece => piece.family === 'night')
        .flatMap(piece => piece.melody.map(([semi]) => semi).filter(semi => semi !== null)));
    for (const voice of VOICES) {
        for (const mode of MODES) {
            for (const keyframe of NIGHT_KEYFRAMES) {
                for (const weather of WEATHERS) {
                    const { seats, key } = voicingFor({ voice, mode, keyframe, weather });
                    assert.ok(['musicBox', 'chipFlute'].includes(seats.lead.instrument), key);
                    assert.ok(69 + nightMax + seats.lead.octaveShift <= NIGHT_LEAD_CEILING_MIDI, key);
                }
            }
        }
    }
});

test('the keyframes are coloured by instrument or register', () => {
    for (const mode of MODES) {
        const byKeyframe = new Map(KEYFRAMES.map(keyframe => [keyframe, signature(voicingFor({ mode, keyframe, band: 3 }))]));
        // MUSL-8's rows: morning and noon are one row, every other differs.
        const rows = KEYFRAMES.filter(k => k !== 'noon').map(k => byKeyframe.get(k));
        assert.equal(new Set(rows).size, rows.length, `${mode}: two keyframes share an arrangement`);
        assert.equal(byKeyframe.get('morning'), byKeyframe.get('noon'));
    }
    const chipDay = voicingFor({ voice: 'chip', keyframe: 'noon' }).seats.lead.instrument;
    const chipNight = voicingFor({ voice: 'chip', keyframe: 'night' }).seats.lead.instrument;
    assert.notEqual(chipDay, chipNight);
});

test('dusk keeps the whole band in its written register (MUS-13)', () => {
    for (const mode of MODES) {
        const { seats, tempoScale } = voicingFor({ mode, keyframe: 'golden-hour' });
        assert.ok(tempoScale < 1);
        for (const seat of Object.values(seats)) assert.equal(seat.octaveShift, 0);
    }
});

test('rain and snow re-dress the tune with softer attacks', () => {
    for (const voice of VOICES) {
        for (const keyframe of KEYFRAMES) {
            for (const season of SEASONS) {
                const clear = voicingFor({ voice, keyframe, season, band: 3 });
                for (const weather of ['rain', 'snow']) {
                    const wet = voicingFor({ voice, keyframe, season, weather, band: 3 });
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
});

test('Chip is a Town band voicing; Village is the Isle Band without drums', () => {
    for (const keyframe of KEYFRAMES) {
        const village = voicingFor({ voice: 'chip', mode: 'village', keyframe, band: 3 });
        assert.equal(village.voice, 'isle');
        assert.ok(!('percussion' in village.seats));
        assert.ok(!Object.values(village.seats).some(seat => seat.instrument.startsWith('chip')));
        const chip = voicingFor({ voice: 'chip', keyframe, band: 3 });
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
