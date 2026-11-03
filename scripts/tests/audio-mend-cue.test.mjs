// EF-5 — a mend rings. A verified `mended` outcome (the same failing command
// passing again, D2) is one aggregated outcome fact. The Town band sounds it
// as the commit's soft-mallet bar reached by one resolving step, on the
// commit's lane and tier; Signals captions it without a sound.
import test from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME_AGGREGATE_MS, OutcomeRouter, verifiedOutcomeFact } from '../../claudeville/src/application/OutcomeSignals.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { CueGovernor, outcomeTier } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { resetCueScore } from '../../claudeville/src/presentation/shared/audio/CueScore.js';
import { CueKit, laneForCueKind } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { clashesWithChord, guardSemi, noteHz } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { SignalDirector } from '../../claudeville/src/presentation/shared/audio/SignalDirector.js';
import { formatCueCaption } from '../../claudeville/src/presentation/shared/Toast.js';

const semiOf = hz => Math.round(12 * Math.log2(hz / noteHz(0)));

test('a verified mend is an outcome fact, and mends landing together are one with the exact count', () => {
    assert.deepEqual(verifiedOutcomeFact({ kind: 'mended', project: 'claude-ville', agentId: 'a', at: 1 }),
        { kind: 'mended', agentId: 'a', repo: 'claude-ville', version: null });
    let now = 0;
    const timers = [];
    const emitted = [];
    const router = new OutcomeRouter({
        emit: outcome => emitted.push(outcome),
        now: () => now,
        setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
        clearTimer() {},
    });
    for (const agentId of ['a', 'b']) router.submit({ kind: 'mended', agentId });
    now = OUTCOME_AGGREGATE_MS - 1;
    assert.equal(emitted.length, 0, 'held for the 1.5 s window');
    now = OUTCOME_AGGREGATE_MS;
    for (const timer of timers.filter(entry => entry.at <= now)) timer.fn();
    assert.deepEqual(emitted.map(({ kind, count }) => ({ kind, count })), [{ kind: 'mended', count: 2 }]);
});

test('a mend speaks on the commit\'s lane and tier', () => {
    assert.equal(laneForCueKind('mended'), laneForCueKind('commit'));
    assert.equal(outcomeTier('mended'), outcomeTier('commit'));
});

// A sounding engine on a frozen audio clock with the real MusicClock.
function soundingEngine(now = 100.01) {
    const param = (value = 1) => ({
        value,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
    });
    const node = (extra = {}) => ({ connect: next => next, disconnect() {}, ...extra });
    const engine = {
        clock: now,
        started: true,
        musicClock: new MusicClock(),
        now: () => engine.clock,
        connectVoice: () => ({ output: node(), dispose() {} }),
        bedLoudness: () => null,
        releaseVoice() {},
        duck: () => ({ cancel() {} }),
        context: {
            sampleRate: 48000,
            get currentTime() { return engine.clock; },
            createGain: () => node({ gain: param() }),
            createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }),
            createOscillator: () => node({ frequency: param(440), type: 'sine', start() {}, stop() {} }),
        },
    };
    return engine;
}

async function mendNotes(engine, payload = {}) {
    resetCueScore();
    const kit = new CueKit(engine, new CueGovernor({ maxPerMinute: 60, minSpacingMs: 0 }));
    const scores = [];
    const off = eventBus.on('audio:cue-scheduled', score => scores.push(score));
    try {
        kit._playAccepted({ kind: 'mended', lane: laneForCueKind('mended'), agentId: 'a-mend', preset: 'townBand', ...payload });
        await new Promise(resolve => { queueMicrotask(resolve); });
    } finally {
        off();
    }
    assert.equal(scores.length, 1);
    return scores[0].notes;
}

const band = (chord, mode = 'major') => ({
    source: 'townBand',
    key: { tonicPc: 9, mode },
    originTime: 90,
    beatSec: 0.5,
    beatsPerBar: 4,
    chords: [{ time: 90, ...chord }],
    until: 200,
});

test('with no music a mend steps from B5 down onto the commit\'s A5 bar', async () => {
    for (const phase of ['day', 'night']) {
        const notes = await mendNotes(soundingEngine(), { phase });
        assert.deepEqual(notes.map(note => semiOf(note.hz)), [14, 12], phase);
        assert.deepEqual(notes.map(note => Math.round(note.atMs - notes[0].atMs)), [0, 170]);
    }
});

test('over the band the step lands on the guarded bar and never folds into one pitch', async () => {
    const chords = [
        { rootPc: 9, pcs: [9, 1, 4] }, // A
        { rootPc: 2, pcs: [2, 5, 9], mode: 'minor' }, // Dm, the night's iv: B against F
        { rootPc: 11, pcs: [11, 3, 6] }, // B, the day's V of V
        { rootPc: 4, pcs: [4, 8, 11] }, // E
        { rootPc: 5, pcs: [5, 9, 0], mode: 'minor' }, // F, the night's VI
    ];
    for (const { mode = 'major', ...chord } of chords) {
        const engine = soundingEngine();
        engine.musicClock.publish(band(chord, mode));
        const [step, bar] = (await mendNotes(engine, { phase: mode === 'minor' ? 'night' : 'day' })).map(note => semiOf(note.hz));
        assert.equal(bar, guardSemi(12, chord), `the bar is the commit's A5 under the guard (${chord.rootPc})`);
        assert.ok(step - bar === 2 || step - bar === 3, `one step above the bar over ${chord.rootPc}: ${step} → ${bar}`);
        assert.equal(clashesWithChord(step, chord), false);
    }
});

test('Signals captions a mend without a sound; the Town band sounds it', () => {
    const engine = Object.freeze({ context: null, started: false });
    const governor = new CueGovernor({ minSpacingMs: 0 });
    const kit = new CueKit(engine, governor);
    const submitted = [];
    const play = kit.play.bind(kit);
    kit.play = (kind, payload = {}) => {
        submitted.push({ kind, announceOnly: payload.announceOnly === true, preset: payload.preset ?? null });
        return play(kind, payload);
    };
    const signals = new SignalDirector({ engine, cues: { kit, governor } });
    let townBand = null;
    try {
        signals._playOutcome({ kind: 'mended', agentId: 'a', count: 1 });
        signals.destroy();
        townBand = new BgmDirector({ engine, cues: { kit, governor } });
        townBand.running = true;
        townBand._playOutcome({ kind: 'mended', agentId: 'b', count: 1 });
        assert.deepEqual(submitted, [
            { kind: 'mended', announceOnly: true, preset: null },
            { kind: 'mended', announceOnly: false, preset: 'townBand' },
        ]);
    } finally {
        townBand?.stop();
        signals.destroy();
        governor.destroy();
    }
});

test('the caption keeps the Chronicle\'s words for a mend', () => {
    assert.equal(formatCueCaption({ kind: 'mended', agentId: 'a', label: 'Rowan' }), 'Rowan mended a failing command');
    assert.equal(formatCueCaption({ kind: 'mended', count: 3 }), '3 failing commands mended');
});
