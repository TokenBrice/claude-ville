import test from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeSongbook,
    checkPassage,
    cueClash,
    identicalRenditionGap,
    motifStatements,
    parallelPerfects,
    phraseReheard,
    quickPairs,
    renditions,
    timeline,
    tonalReheard,
} from '../audio/score-analyzer.mjs';
import * as BOOK from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit, laneForCueKind } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { resetCueScore } from '../../claudeville/src/presentation/shared/audio/CueScore.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const line = notes => timeline(notes);

test('parallel fifths and octaves are found on consecutive bass onsets, and only there', () => {
    // A/D fifth → B/E fifth: both voices move up a step.
    assert.deepEqual(parallelPerfects(line([[0, 2], [2, 2]]), line([[-19, 2], [-17, 2]])).map(p => p.interval), ['fifth']);
    // A/A octave → D/D octave, the bass leaping down, the tune up: contrary octaves count too.
    assert.deepEqual(parallelPerfects(line([[0, 2], [5, 2]]), line([[-24, 2], [-31, 2]])).map(p => p.interval), ['octave']);
    // Fifth → sixth, a held tune over a moving bass, a bass octave leap under a held tune: clean.
    assert.equal(parallelPerfects(line([[0, 2], [4, 2]]), line([[-19, 2], [-17, 2]])).length, 0);
    assert.equal(parallelPerfects(line([[7, 4]]), line([[-24, 2], [-17, 2]])).length, 0);
    assert.equal(parallelPerfects(line([[0, 2], [0, 2]]), line([[-24, 2], [-12, 2]])).length, 0);
    // A rest in the tune breaks the chain.
    assert.equal(parallelPerfects(line([[0, 2], [null, 2], [2, 2]]), line([[-19, 2], [-17, 2], [-17, 2]])).length, 0);
});

test('a passage check reports parallels, crossings, ranges, bar sums and unknown chords', () => {
    const failures = [];
    checkPassage('planted', {
        chords: ['A', 'Xm'],
        melody: [[0, 4], [7, 4]],
        bass: [[-24, 4], [-17, 3]],
        counterNotes: [[4, 8]],
    }, { beatsPerBar: 4, fail: msg => failures.push(msg) });
    const text = failures.join('\n');
    assert.match(text, /parallel octaves/);
    assert.match(text, /bass sums to 7 beats/);
    assert.match(text, /unknown chord Xm/);
    assert.match(text, /counter above melody/);
});

test('a quick same-pitch pair — the needs-you figure — fails, a slower repeat does not', () => {
    const notes = line([[7, 0.25], [7, 0.75], [4, 1], [4, 1]]);
    // At 84 bpm a sixteenth is 179 ms; a quarter 714 ms.
    assert.deepEqual(quickPairs(notes, 60 / 84).map(q => q.at), [0.25]);
});

test('cue clash counts semitone, major-seventh and tritone contact with the sounding chord', () => {
    const chords = [{ t: 0, pcs: [9, 1, 4] }, { t: 2, pcs: [2, 6, 9] }]; // A, then D
    const cues = [{ t: 0.5, midi: 69 }, { t: 1, midi: 70 }, { t: 3, midi: 68 }, { t: 3.5, midi: 74 }];
    const result = cueClash(cues, chords);
    assert.equal(result.checked, 4);
    assert.equal(result.clashes, 2); // B♭ over A, G♯ over D (tritone)
    assert.equal(result.pct, 50);
});

const rendition = (t0, piece, bars, jitter = 0, beatSec = 0.5) => bars.flatMap((pitches, bar) => pitches.map((midi, k) => ({
    t: t0 + (bar * 4 + k) * beatSec + (k % 2 ? jitter : -jitter), dur: beatSec, midi, seat: 'lead', piece, bar,
})));

test('identical renditions are found through humanization jitter; a varied one and interludes are not', () => {
    const a = [[69, 73, 76, 73], [71, 68, 71, 71]];
    const b = [[69, 73, 76, 73], [71, 68, 71, 73]];
    const interlude = t0 => rendition(t0, 'willowbrook', [[69, 76, 76, 76]]).map(n => ({ ...n, segment: 'interlude' }));
    const notes = [
        ...rendition(0, 'willowbrook', a),
        ...interlude(20),
        ...rendition(1800, 'willowbrook', a, 0.006),
        ...interlude(1820),
        ...rendition(2400, 'willowbrook', b),
    ];
    const list = renditions(notes, { beatSec: { willowbrook: 0.5 } });
    assert.equal(list.length, 3); // the interludes are not renditions
    const gap = identicalRenditionGap(list);
    assert.equal(gap.pairs.length, 1);
    assert.ok(Math.abs(gap.minGapSec - 1800) < 0.05, `gap ${gap.minGapSec}`);
});

test('tonal re-hearing counts a stretch heard again ≥ 30 s later, inside music-on windows only', () => {
    const phrase = t0 => [69, 73, 76, 74, 71, 69, 73, 76, 74, 71, 69, 73, 76, 74, 71, 69, 73, 76, 74, 71]
        .map((midi, i) => ({ t: t0 + i * 0.5, dur: 0.5, midi, seat: 'lead' }));
    const novel = t0 => [60, 62, 64, 65, 67, 60, 62, 64, 65, 67, 60, 62, 64, 65, 67, 60, 62, 64, 65, 67]
        .map((midi, i) => ({ t: t0 + i * 0.5, dur: 0.5, midi, seat: 'lead' }));
    const notes = [...phrase(0), ...novel(20), ...phrase(40)];
    const all = tonalReheard(notes, [{ from: 0, to: 30 }, { from: 40, to: 50 }]);
    assert.equal(all.windows, 6); // five in 0–30 s, one in 40–50 s
    assert.equal(all.reheard, 1);
    // The repeat outside music-on is not counted.
    assert.equal(tonalReheard(notes, [{ from: 0, to: 30 }]).reheard, 0);
});

test('phrase re-hearing counts a 4-note gram heard again ≥ 20 s later', () => {
    const gram = t0 => [69, 73, 76, 73].map((midi, i) => ({ t: t0 + i * 0.5, dur: 0.5, midi, seat: 'lead' }));
    const notes = [...gram(0), ...gram(10), ...gram(40)];
    const result = phraseReheard(notes, [{ from: 0, to: 60 }]);
    assert.equal(result.reheard, 1); // the gram at 10 s is too soon; the one at 40 s counts
});

test('motif statements: the call and the home phrase in the key, not the same shape elsewhere', () => {
    const at = (t0, midis, piece = 'fragment') => midis.map((midi, i) => ({ t: t0 + i * 0.4, dur: 0.4, midi, seat: 'lead', piece }));
    const notes = [
        ...at(0, [69, 73, 76, 73]), // A C♯ E C♯: the call
        ...at(10, [76, 73, 71, 69]), // E C♯ B A: home
        ...at(20, [71, 75, 78, 75]), // the call's shape on B: not the motif
        ...at(30, [76, 72, 71, 69]), // E C B A: home in minor
        ...at(40, [69, 73, 76, 73], 'willowbrook'),
    ];
    const all = motifStatements(notes);
    assert.deepEqual(all.at.map(s => `${s.figure}:${s.mode}`), ['call:major', 'home:major', 'home:minor', 'call:major']);
    assert.equal(motifStatements(notes, { excludePieces: ['willowbrook'] }).count, 3);
});

test('the songbook passes the composition gate', () => {
    const { failures, pieces } = analyzeSongbook();
    assert.deepEqual(failures, []);
    assert.ok(pieces.length >= 11);
});

test('the gate fails a waiting cadence that would have to move the tune', async () => {
    const book = await import('../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js');
    const [first, ...rest] = book.PIECES;
    // V → V: the arrival's A is not a tone of E, so the melody could not stay.
    const bad = { ...first, phraseEnds: first.phraseEnds.map(end => ({ ...end, chord: 'E' })) };
    const { failures } = analyzeSongbook({ ...book, PIECES: [bad, ...rest] });
    assert.ok(failures.some(msg => msg === `${first.name}: arrival melody 0 is not in E`), failures.join('\n'));
});

test('the gate holds a piece to a key its family allows, and to that key\'s tonic', () => {
    const [first, ...rest] = BOOK.PIECES;
    const bad = { ...first, key: { tonic: 'E', mode: 'minor' } };
    const { failures } = analyzeSongbook({ ...BOOK, PIECES: [bad, ...rest] });
    assert.ok(failures.includes(`${first.name}: key {"tonic":"E","mode":"minor"} is not allowed for ${first.family}`), failures.join('\n'));
    const moved = { ...first, key: { tonic: 'D', mode: 'major' } };
    const { failures: tonicFailures } = analyzeSongbook({ ...BOOK, PIECES: [moved, ...rest] });
    assert.ok(tonicFailures.some(msg => msg.startsWith(`${first.name}: tag does not end home on D`)), tonicFailures.join('\n'));
});

test('the cadence kit gives every allowed key and meter a tag and a waiting cadence inside the gate', () => {
    for (const [family, keys] of Object.entries(BOOK.ALLOWED_KEYS)) {
        const night = family === 'night';
        for (const key of keys) {
            const tonic = BOOK.tonicChord(key);
            const { tonicPc } = BOOK.musicKey(key);
            for (const meter of BOOK.METERS) {
                const where = `${tonic} in ${meter}`;
                const failures = [];
                const fail = msg => failures.push(msg);
                const opts = { beatsPerBar: meter, bpm: meter === 6 ? 180 : 80, night, fail };
                const { tag, deceptive } = BOOK.cadenceKit(key, meter);
                assert.equal(tag.chords.length, 2, where);
                assert.equal(tag.chords[1], tonic, where);
                checkPassage(`${where} tag`, tag, opts);
                checkPassage(`${where} home`, { chords: [tonic], ...deceptive.home }, opts);
                // The deceptive chord (vi, VI) holds the tonic, so the arrival's
                // melody may stay.
                const turn = BOOK.chordPitchClasses(deceptive.chord);
                assert.ok(turn?.pcs.includes(tonicPc), `${where}: ${deceptive.chord}`);
                checkPassage(`${where} deceptive`, { chords: [deceptive.chord], bass: deceptive.bass, melody: [[null, meter]] }, opts);
                assert.deepEqual(failures, [], where);
            }
        }
    }
});

// Every note the kit publishes for one cue, on a sounding engine with a
// frozen clock (as audio-cue-roles.test.mjs drives it).
function fakeParam(value = 1) {
    return {
        value, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {},
    };
}
const fakeNode = (extra = {}) => ({ connect: node => node, disconnect() {}, ...extra });
async function publishedNotes(kind) {
    const engine = {
        clock: 100,
        started: true,
        musicClock: new MusicClock(),
        now: () => engine.clock,
        connectVoice: () => ({ output: fakeNode(), dispose() {} }),
        bedLoudness: () => null,
        releaseVoice() {},
        duck: () => ({ cancel() {} }),
        context: {
            sampleRate: 48000,
            get currentTime() { return engine.clock; },
            createGain: () => fakeNode({ gain: fakeParam() }),
            createBiquadFilter: () => fakeNode({ type: 'lowpass', frequency: fakeParam(350), Q: fakeParam(1), gain: fakeParam(0) }),
            createOscillator: () => fakeNode({ frequency: fakeParam(440), type: 'sine', start() {}, stop() {} }),
        },
    };
    resetCueScore();
    const kit = new CueKit(engine, new CueGovernor({ maxPerMinute: 60, minSpacingMs: 0 }));
    const scores = [];
    const off = eventBus.on('audio:cue-scheduled', score => scores.push(score));
    try {
        kit._playAccepted({ kind, lane: laneForCueKind(kind), agentId: `a-${kind}` });
        await new Promise(resolve => { queueMicrotask(resolve); });
    } finally {
        off();
    }
    assert.equal(scores.length, 1, `${kind} publishes one score`);
    return scores[0].notes;
}

test('every allowed key\'s scale holds the pitch classes the signal cues strike', async () => {
    const heard = new Set();
    for (const kind of ['summons', 'distress', 'limit', 'answered']) {
        for (const note of await publishedNotes(kind)) heard.add((((Math.round(12 * Math.log2(note.hz / 440)) + 9) % 12) + 12) % 12);
    }
    assert.deepEqual([...heard].sort((a, b) => a - b), [...BOOK.SIGNAL_PITCH_CLASSES].sort((a, b) => a - b));
    for (const [family, keys] of Object.entries(BOOK.ALLOWED_KEYS)) {
        assert.ok(keys.length > 0, family);
        for (const key of keys) {
            for (const pc of heard) assert.ok(BOOK.scalePitchClasses(key).includes(pc), `${family} ${key.tonic} ${key.mode}: pitch class ${pc}`);
        }
    }
});
