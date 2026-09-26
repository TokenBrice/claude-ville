import test from 'node:test';
import assert from 'node:assert/strict';

import { Sequencer } from '../../claudeville/src/presentation/shared/audio/music/Sequencer.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';
import {
    PIECES, VILLAGE_TUNES, chordPitchClasses,
} from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';

// ── a minimal offline audio graph: enough to schedule, and to hear onsets ──

class FakeParam {
    constructor(value = 0) { this.value = value; }
    setValueAtTime() { return this; }
    setTargetAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
}

class FakeNode {
    constructor(ctx) {
        this.ctx = ctx;
        this.gain = new FakeParam(1);
        this.pan = new FakeParam(0);
        this.frequency = new FakeParam(440);
        this.detune = new FakeParam(0);
        this.Q = new FakeParam(1);
    }
    connect(node) { return node; }
    disconnect() {}
    setPeriodicWave() {}
    start(t) {
        if (this.isOscillator && !this.isLfo) {
            this.ctx.onsets.push({ t, hz: this.frequency.value, scheduledAt: this.ctx.currentTime });
        }
        if (this.isNoise) this.ctx.hats.push(t);
    }
    stop() {}
}

function makeEngine() {
    const ctx = {
        currentTime: 0,
        onsets: [],
        hats: [],
        createGain() { return new FakeNode(ctx); },
        createStereoPanner() { return new FakeNode(ctx); },
        createBiquadFilter() { return new FakeNode(ctx); },
        createOscillator() {
            const node = new FakeNode(ctx);
            node.isOscillator = true;
            Object.defineProperty(node, 'type', {
                set(value) { if (value === 'sine') node.isLfo = true; },
                get() { return 'custom'; },
            });
            return node;
        },
    };
    const processes = new Set();
    const engine = {
        context: ctx,
        musicClock: new MusicClock(),
        transport: {
            register(proc) { processes.add(proc); proc.rearm?.(ctx.currentTime); return proc; },
            unregister(proc) { processes.delete(proc); },
        },
        now: () => ctx.currentTime,
        groupInput: () => new FakeNode(ctx),
        stopGroup: () => ctx.currentTime,
        airSendFrom: () => new FakeNode(ctx),
        wave: () => null,
        noiseSource() {
            const node = new FakeNode(ctx);
            node.isNoise = true;
            return node;
        },
    };
    return { engine, ctx };
}

// Drives the sequencer the way the Transport does: a tick every `step`
// seconds hands it the window [cursor, now + horizon). `onTick(now)` runs after
// each window, at the audio time the window was scheduled from.
function drive(seq, ctx, { seconds, step = 0.25, horizon = 1.5, onTick = null, until = null }) {
    let cursor = ctx.currentTime;
    const end = ctx.currentTime + seconds;
    for (let now = ctx.currentTime; now < end; now += step) {
        ctx.currentTime = now;
        const from = Math.max(cursor, now);
        seq.schedule(from, now + horizon);
        cursor = now + horizon;
        onTick?.(now);
        if (until?.()) break;
    }
}

function startSequencer(preset, { piece, phase = 'day' } = {}) {
    setRngSeed('music-test');
    const { engine, ctx } = makeEngine();
    const seq = new Sequencer(engine, { preset });
    const marks = [];
    seq.observe(mark => marks.push(mark));
    if (piece) assert.equal(seq.pin({ piece }), true);
    seq.setPhase(phase);
    seq.start();
    seq.setLevel(1, 0.1);
    return { seq, ctx, engine, marks };
}

const latest = (marks, t, kinds) => {
    let found = null;
    for (const mark of marks) if (kinds.includes(mark.kind) && mark.t <= t + 1e-9) found = mark;
    return found;
};

function townBandChordAtBeat(piece, beat) {
    const entry = piece.chords[Math.floor(beat / 4)];
    return Array.isArray(entry) ? entry[beat % 4 >= 2 ? 1 : 0] : entry;
}

test('Town band: the MusicClock chord matches the song at every beat of every piece, and the bar nowPlaying shows', () => {
    for (const piece of PIECES) {
        const phase = piece.family === 'night' ? 'night' : 'day';
        const { seq, ctx, engine, marks } = startSequencer('townBand', { piece: piece.name, phase });
        const beatSec = 60 / piece.bpm;
        const totalBeats = piece.chords.length * 4;
        let checkedBeats = 0;
        let checkedBars = 0;
        drive(seq, ctx, {
            seconds: 3 + 2 * totalBeats * beatSec,
            onTick(now) {
                // Every beat point that sounds in this tick.
                const loop = latest(marks, now + 0.25, ['loop']);
                if (!loop) return;
                for (let b = 0; b < totalBeats; b++) {
                    const t = loop.loopStart + b * beatSec;
                    if (t < now || t >= now + 0.25) continue;
                    assert.deepEqual(engine.musicClock.chordAt(t), chordPitchClasses(townBandChordAtBeat(piece, b)),
                        `${piece.name} beat ${b}`);
                    checkedBeats++;
                }
                const playing = seq.nowPlaying;
                if (!playing) return;
                const snapshot = engine.musicClock.snapshot(now);
                assert.equal(playing.piece, piece.name);
                assert.equal(snapshot.bar, playing.bar, `${piece.name} bar at ${now}`);
                const barChord = piece.chords[playing.bar - 1];
                const expected = Array.isArray(barChord) ? barChord[snapshot.beat >= 3 ? 1 : 0] : barChord;
                assert.deepEqual(snapshot.chord, chordPitchClasses(expected));
                checkedBars++;
            },
        });
        assert.ok(checkedBeats >= totalBeats, `${piece.name}: every beat of a loop checked (${checkedBeats})`);
        assert.ok(checkedBars > 0);
        seq.stop();
        assert.equal(engine.musicClock.playing(ctx.currentTime), false, 'stop clears the clock');
    }
});

test('Village: the MusicClock chord matches the tune at every beat of every section of every tune', () => {
    for (const tune of VILLAGE_TUNES) {
        const phase = tune.mode === 'minor' ? 'night' : 'day';
        const { seq, ctx, engine, marks } = startSequencer('village', { piece: tune.name, phase });
        const beatSec = 60 / tune.bpm; // day and night play at written tempo
        const tonic = tune.sections.A.chords[0];
        const checked = new Set();
        drive(seq, ctx, {
            seconds: 120,
            until: () => marks.some(mark => mark.kind === 'songEnd' && mark.t < ctx.currentTime),
            onTick(now) {
                // Every beat point of every section (and of the rest after
                // the song) that sounds in this tick.
                const spans = marks.filter(mark => mark.kind === 'section' || mark.kind === 'songEnd');
                spans.forEach((span, i) => {
                    // The next mark is always known 1.5 s before it sounds.
                    const next = Math.min(spans[i + 1]?.t ?? Infinity, now + 0.25);
                    for (let k = 0; span.t + k * beatSec < next - 1e-6; k++) {
                        const t = span.t + k * beatSec;
                        if (t < now || t >= now + 0.25) continue;
                        checked.add(`${span.t}:${k}`);
                        if (span.kind === 'songEnd') {
                            assert.deepEqual(engine.musicClock.chordAt(t), chordPitchClasses(tonic), 'idle after the song');
                            assert.equal(engine.musicClock.playing(t), false);
                            continue;
                        }
                        const expected = span.step === 'pickup' || span.step === 'outro'
                            ? tonic
                            : tune.sections[span.step].chords[Math.floor(k / 4)];
                        assert.deepEqual(engine.musicClock.chordAt(t), chordPitchClasses(expected),
                            `${tune.name} ${span.step} beat ${k}`);
                    }
                });
            },
        });
        const steps = marks.filter(mark => mark.kind === 'section').map(mark => mark.step);
        assert.deepEqual([steps[0], steps.at(-1)], ['pickup', 'outro'], `${tune.name} performed whole`);
        // pickup 4 + four sections × 16 + outro 6 beats.
        assert.ok(checked.size >= 4 + 4 * 16 + 6, `${tune.name}: ${checked.size} beats checked`);
        seq.stop();
    }
});

function onsetsFor(preset, piece, phase, windows) {
    const { seq, ctx } = startSequencer(preset, { piece, phase });
    drive(seq, ctx, { seconds: 70, ...windows });
    seq.stop();
    // Every run has committed at least up to 70 s.
    return ctx.onsets.filter(o => o.t < 70).map(o => `${o.t.toFixed(6)}@${o.hz.toFixed(3)}`).sort();
}

test('the window size never changes the notes: per-window emission is exact', () => {
    for (const [preset, piece, phase] of [['townBand', 'cobblemarket', 'day'], ['village', 'lanternway', 'night']]) {
        const reference = onsetsFor(preset, piece, phase, { step: 0.25, horizon: 1.5 });
        assert.ok(reference.length > 100);
        assert.deepEqual(onsetsFor(preset, piece, phase, { step: 1, horizon: 1.5 }), reference, `${piece} 1 s ticks`);
        assert.deepEqual(onsetsFor(preset, piece, phase, { step: 0.05, horizon: 0.3 }), reference, `${piece} short horizon`);
    }
});

test('a stalled window drops its late notes and never smears them onto now', () => {
    const { seq, ctx } = startSequencer('townBand', { piece: 'millwheel' });
    drive(seq, ctx, { seconds: 5 });
    const before = ctx.onsets.length;
    // The tab stalls 3 s: the next window opens at now, past the cursor.
    ctx.currentTime += 3;
    const dropped = seq.schedule(ctx.currentTime, ctx.currentTime + 1.5);
    assert.ok(dropped > 0, 'the notes of the gap are counted');
    const late = ctx.onsets.slice(before).filter(o => o.t < o.scheduledAt);
    assert.deepEqual(late, [], 'no note was placed in the past');
    seq.stop();
});

test('a Town band section change lands on the next four-bar boundary', () => {
    const { seq, ctx, marks } = startSequencer('townBand', { piece: 'millwheel' });
    let askedAt = null;
    drive(seq, ctx, {
        seconds: 40,
        onTick(now) {
            if (askedAt === null && now >= 6) {
                seq.setSection('rest');
                askedAt = now;
            }
        },
    });
    const chunks = marks.filter(mark => mark.kind === 'loop' || mark.kind === 'chunk');
    const firstRest = chunks.find(mark => mark.section === 'rest');
    assert.ok(firstRest.t > askedAt, 'never retroactive');
    assert.ok(chunks.filter(mark => mark.t < firstRest.t).every(mark => mark.section === 'steady'));
    const beats = (firstRest.t - firstRest.loopStart) / firstRest.beatSec;
    assert.ok(Math.abs(beats / 16 - Math.round(beats / 16)) < 1e-9, 'on a four-bar boundary');
    assert.ok(firstRest.t - askedAt <= 16 * firstRest.beatSec + 1.5, 'within one chunk plus the horizon');
    seq.stop();
});

test('Village: a phase-family change sends the tune to its outro at the next section', () => {
    const { seq, ctx, marks } = startSequencer('village', { phase: 'day' });
    let switched = false;
    drive(seq, ctx, {
        seconds: 90,
        until: () => marks.some(mark => mark.kind === 'songEnd'),
        onTick() {
            if (!switched && marks.some(mark => mark.kind === 'section' && mark.step !== 'pickup')) {
                seq.setPhase('night');
                switched = true;
            }
        },
    });
    const steps = marks.filter(mark => mark.kind === 'section').map(mark => mark.step);
    assert.equal(steps[0], 'pickup');
    assert.ok(steps.length <= 4, `${steps.join(' ')}`);
    assert.equal(steps.at(-1), 'outro');
    seq.stop();
});
