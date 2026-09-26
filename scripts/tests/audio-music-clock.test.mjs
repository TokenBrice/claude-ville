import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { CUE_ROLES, noteHz, phaseKey, roleSemi, tonicTriad } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';

const cents = (a, b) => 1200 * Math.log2(a / b);
const hzFromA4 = semi => 440 * 2 ** (semi / 12);

// The cue pitches every cue used before the clock existed: A2, A3, C♯4 (C4 at
// night), E4, A4, C♯5 (C5).
const LEGACY_CUE_SEMIS = {
    day: { low: -24, root: -12, third: -8, fifth: -5, octave: 0, high: 4 },
    night: { low: -24, root: -12, third: -9, fifth: -5, octave: 0, high: 3 },
};

const frame = (overrides = {}) => ({
    source: 'townBand',
    key: { tonicPc: 9, mode: 'major' },
    originTime: 10,
    beatSec: 0.5,
    beatsPerBar: 4,
    chords: [
        { time: 10, rootPc: 9, pcs: [9, 1, 4] },
        { time: 12, rootPc: 4, pcs: [4, 8, 11] },
    ],
    until: 14,
    ...overrides,
});

test('an idle clock reproduces the legacy cue pitches to the cent, by day and at night', () => {
    const clock = new MusicClock();
    for (const phase of ['dawn', 'day', 'dusk', 'night']) {
        clock.setPhase(phase);
        const legacy = LEGACY_CUE_SEMIS[phase === 'night' ? 'night' : 'day'];
        assert.deepEqual(Object.keys(legacy).sort(), [...CUE_ROLES].sort());
        for (const [role, semi] of Object.entries(legacy)) {
            const fromClock = noteHz(roleSemi(role, clock.chordAt(123.4)));
            const fromPhase = noteHz(roleSemi(role, tonicTriad(phaseKey(phase))));
            assert.ok(Math.abs(cents(fromClock, hzFromA4(semi))) < 0.01, `${phase} ${role} (clock)`);
            assert.ok(Math.abs(cents(fromPhase, hzFromA4(semi))) < 0.01, `${phase} ${role} (phase)`);
        }
        assert.equal(clock.keyAt(123.4).mode, phase === 'night' ? 'minor' : 'major');
    }
});

test('a published frame answers inside its span and the idle key outside it', () => {
    const clock = new MusicClock();
    clock.setPhase('night');
    clock.publish(frame());
    assert.deepEqual(clock.chordAt(9.99), { rootPc: 9, pcs: [9, 0, 4] }, 'before: idle A minor');
    assert.deepEqual(clock.chordAt(10), { rootPc: 9, pcs: [9, 1, 4] });
    assert.deepEqual(clock.chordAt(11.999), { rootPc: 9, pcs: [9, 1, 4] });
    assert.deepEqual(clock.chordAt(12), { rootPc: 4, pcs: [4, 8, 11] });
    assert.equal(clock.keyAt(13).mode, 'major');
    assert.deepEqual(clock.chordAt(14), { rootPc: 9, pcs: [9, 0, 4] }, 'after until: idle again');
    clock.clear('townBand');
    assert.equal(clock.playing(11), false);
});

test('publishing the next chunk ahead keeps the chunk still sounding', () => {
    const clock = new MusicClock();
    clock.publish(frame());
    clock.publish(frame({
        chords: [{ time: 14, rootPc: 2, pcs: [2, 6, 9] }],
        until: 18,
    }));
    assert.deepEqual(clock.chordAt(13).rootPc, 4, 'the earlier chunk still answers');
    assert.deepEqual(clock.chordAt(14).rootPc, 2);
    assert.equal(clock.snapshot(15).bar, 3, 'bars count from the frame origin');
});

test('nextGrid snaps to the coarsest division that fits the wait, never past the committed music', () => {
    const clock = new MusicClock();
    assert.equal(clock.nextGrid(11.1, { maxWaitSec: 1 }), 11.1, 'no music: no grid');
    clock.publish(frame());
    // beat 0.5 s, bar 2 s: a 1 s wait fits the beat, not the bar.
    assert.equal(clock.nextGrid(11.1, { maxWaitSec: 1 }), 11.5);
    assert.equal(clock.nextGrid(10.3, { maxWaitSec: 2 }), 12);
    assert.equal(clock.nextGrid(10.3, { maxWaitSec: 0.25 }), 10.5, 'eighth');
    assert.equal(clock.nextGrid(10.3, { maxWaitSec: 0.1 }), 10.3, 'nothing fits');
    assert.equal(clock.nextGrid(12, { maxWaitSec: 1 }), 12, 'on the grid already');
    assert.equal(clock.nextGrid(13.9, { maxWaitSec: 2 }), 13.9, 'the next bar is past `until`');
});
