import test from 'node:test';
import assert from 'node:assert/strict';

import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit, laneForCueKind } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import {
    clashesWithChord,
    degreeSemi,
    guardSemi,
    noteHz,
    roleSemi,
} from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { resetCueScore } from '../../claudeville/src/presentation/shared/audio/CueScore.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const cents = (a, b) => 1200 * Math.log2(a / b);
const semis = names => names.map(name => {
    const m = /^([A-G])(#?)(-?\d)$/.exec(name);
    return { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
});

function fakeParam(value = 1) {
    return {
        value,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
    };
}
const fakeNode = (extra = {}) => ({ connect: node => node, disconnect() {}, ...extra });

// A sounding engine on a frozen audio clock with the real MusicClock.
function soundingEngine(now = 100) {
    const engine = {
        clock: now,
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
    return engine;
}

// Every note the kit publishes for one cue: `{ atMs, hz, chordHz? }`.
async function publishedNotes(engine, kind, payload = {}) {
    resetCueScore();
    const kit = new CueKit(engine, new CueGovernor({ maxPerMinute: 60, minSpacingMs: 0 }));
    const scores = [];
    const off = eventBus.on('audio:cue-scheduled', score => scores.push(score));
    try {
        kit._playAccepted({ kind, lane: laneForCueKind(kind), agentId: `a-${kind}`, ...payload });
        await new Promise(resolve => { queueMicrotask(resolve); });
    } finally {
        off();
    }
    assert.equal(scores.length, 1, `${kind} publishes one score`);
    return scores[0].notes;
}

const assertPitches = (notes, names, what) => {
    assert.equal(notes.length, names.length, `${what}: note count`);
    semis(names).forEach((semi, i) => {
        assert.ok(Math.abs(cents(notes[i].hz, noteHz(semi))) < 0.01, `${what}: note ${i} is ${names[i]} (${notes[i].hz} Hz)`);
    });
};

const offsetsOf = notes => notes.map(note => Math.round(note.atMs - notes[0].atMs));

// A 4/4 frame at 120 bpm from t = 90 with one chord.
const frame = (chord, overrides = {}) => ({
    source: 'townBand',
    key: { tonicPc: 9, mode: 'major' },
    originTime: 90,
    beatSec: 0.5,
    beatsPerBar: 4,
    chords: [{ time: 90, ...chord }],
    until: 200,
    ...overrides,
});
const E_MAJOR = { rootPc: 4, pcs: [4, 8, 11] };
const F_MAJOR = { rootPc: 5, pcs: [5, 9, 0] };

test('with no music every routine cue rings today\'s pitches at today\'s offsets, by day and at night', async () => {
    for (const phase of ['day', 'night']) {
        const third = phase === 'night' ? 'C4' : 'C#4';
        const high = phase === 'night' ? 'C5' : 'C#5';
        const engine = soundingEngine();
        const arrival = await publishedNotes(engine, 'arrival', { phase });
        assertPitches(arrival, ['A3', 'E4'], `${phase} arrival`);
        assert.deepEqual(offsetsOf(arrival), [0, 220]);
        const departure = await publishedNotes(engine, 'departure', { phase });
        assertPitches(departure, ['E4', 'A3'], `${phase} departure`);
        assert.deepEqual(offsetsOf(departure), [0, 240]);
        const recovery = await publishedNotes(engine, 'recovery', { phase });
        assertPitches(recovery, [third, 'A4'], `${phase} recovery`);
        assert.deepEqual(offsetsOf(recovery), [0, 200]);
        const council = await publishedNotes(engine, 'council', { phase, teamSize: 5, teamName: 't' });
        assertPitches(council, ['A3', 'E4', 'A4', third, high], `${phase} council`);
        assert.deepEqual(offsetsOf(council), [0, 280, 560, 840, 1120]);
    }
});

test('a chord role follows the sounding chord in the register the cue was written in', () => {
    // Under E major the arrival's rising fifth is E3 → B3; under D it is D4 → A4.
    assert.deepEqual([roleSemi('root', E_MAJOR), roleSemi('fifth', E_MAJOR)], semis(['E3', 'B3']));
    assert.deepEqual([roleSemi('root', { rootPc: 2, pcs: [2, 6, 9] }), roleSemi('fifth', { rootPc: 2, pcs: [2, 6, 9] })], semis(['D4', 'A4']));
    // A minor chord gives the role its minor third.
    assert.equal(roleSemi('third', { rootPc: 6, pcs: [6, 9, 1] }), semis(['A3'])[0]);
    for (const chord of [E_MAJOR, F_MAJOR, { rootPc: 11, pcs: [11, 2, 6] }]) {
        for (const role of ['root', 'third', 'fifth', 'octave', 'high']) {
            assert.equal(clashesWithChord(roleSemi(role, chord), chord), false, `${role} over ${chord.rootPc}`);
        }
    }
});

test('the clash guard moves only a semitone or tritone contact, to the nearest chord tone', () => {
    // E4 against F major (F–E is a semitone) → F4; A4 is a chord tone and stays.
    assert.equal(guardSemi(semis(['E4'])[0], F_MAJOR), semis(['F4'])[0]);
    assert.equal(guardSemi(semis(['A4'])[0], F_MAJOR), semis(['A4'])[0]);
    // B against F is a tritone: the nearest chord tone is C, a semitone up.
    assert.equal(guardSemi(semis(['B3'])[0], F_MAJOR), semis(['C4'])[0]);
    // A non-chord tone with no semitone or tritone contact stays (B over A
    // major); one that rubs a chord tone moves (D against C♯ → C♯).
    assert.equal(guardSemi(semis(['B4'])[0], { rootPc: 9, pcs: [9, 1, 4] }), semis(['B4'])[0]);
    assert.equal(guardSemi(semis(['D4'])[0], { rootPc: 9, pcs: [9, 1, 4] }), semis(['C#4'])[0]);
});

test('while music plays a routine cue lands on the grid, its notes on sixteenths and chord tones', async () => {
    const engine = soundingEngine(100.01);
    engine.musicClock.publish(frame(E_MAJOR));
    const notes = await publishedNotes(engine, 'recovery', { phase: 'day' });
    const sixteenthMs = 125;
    for (const offset of offsetsOf(notes)) assert.equal(offset % sixteenthMs, 0, `offset ${offset} on a sixteenth`);
    for (const note of notes) {
        const semi = Math.round(12 * Math.log2(note.hz / 440));
        assert.equal(clashesWithChord(semi, E_MAJOR), false);
    }
});

test('signal cues keep their fixed pitches and never wait for the grid', async () => {
    const idle = soundingEngine(100.01);
    const calm = await publishedNotes(idle, 'summons', {});
    const band = soundingEngine(100.01);
    band.musicClock.publish(frame(F_MAJOR)); // E5 against F is a semitone
    const over = await publishedNotes(band, 'summons', {});
    assertPitches(over, ['E5', 'E5', 'E5', 'E5'], 'needs-you over music');
    assert.deepEqual(offsetsOf(over), [0, 150, 650, 800]);
    assert.ok(Math.abs(over[0].atMs - calm[0].atMs) < 5, 'no added latency');
    assertPitches(await publishedNotes(band, 'distress', {}), ['E4', 'A3'], 'the cracked bell over music');
});

test('motif quotes: the aurora is Willowbrook\'s call, the hour the cell\'s answer on the tower', async () => {
    const engine = soundingEngine();
    assertPitches(await publishedNotes(engine, 'aurora', { phase: 'day' }), ['A4', 'C#5', 'E5', 'C#5'], 'aurora');
    assertPitches(await publishedNotes(engine, 'aurora', { phase: 'night' }), ['A4', 'C5', 'E5', 'C5'], 'aurora night');
    const hour = await publishedNotes(engine, 'hourBell', { phase: 'day', hour: 15 });
    assertPitches(hour, ['E4', 'C#4', 'B3', 'A3'], 'hour phrase');
    const noon = await publishedNotes(engine, 'hourBell', { phase: 'day', hour: 12, count: true });
    assertPitches(noon.slice(4), ['A2', 'A3', 'A3', 'A3', 'A3', 'A3', 'A3'], 'noon count');
    // A key degree is the scale step of the key the band plays in.
    assert.equal(degreeSemi(3, { tonicPc: 9, mode: 'minor' }), semis(['C5'])[0]);
});
