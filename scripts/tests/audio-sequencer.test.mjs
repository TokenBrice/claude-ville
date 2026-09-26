import test from 'node:test';
import assert from 'node:assert/strict';

import { Sequencer, nearestVoicing } from '../../claudeville/src/presentation/shared/audio/music/Sequencer.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';
import {
    FRAGMENTS, PIECES, PLAYLISTS, chordPitchClasses,
} from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';

// ── a minimal offline audio graph: enough to schedule ──

class FakeParam {
    constructor(value = 0) { this.value = value; }
    setValueAtTime() { return this; }
    setTargetAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    setValueCurveAtTime() { return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
}

class FakeNode {
    constructor() {
        for (const name of ['gain', 'pan', 'frequency', 'detune', 'Q', 'playbackRate', 'offset']) this[name] = new FakeParam(1);
    }
    connect(node) { return node; }
    disconnect() {}
    setPeriodicWave() {}
    start() {}
    stop() {}
}

function makeEngine() {
    const node = () => new FakeNode();
    const ctx = {
        currentTime: 0,
        sampleRate: 48000,
        createGain: node,
        createStereoPanner: node,
        createBiquadFilter: node,
        createOscillator: node,
        createBufferSource: node,
        createPeriodicWave: () => ({}),
        createBuffer: (channels, length, sampleRate) => ({
            length, sampleRate, numberOfChannels: channels, getChannelData: () => new Float32Array(length),
        }),
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
        groupInput: node,
        stopGroup: () => ctx.currentTime,
        airSendFrom: node,
        wave: () => null,
        noiseSource: node,
    };
    return { engine, ctx };
}

// Drives the sequencer the way the Transport does: a tick every `step`
// seconds hands it the window [cursor, now + horizon).
function drive(seq, ctx, { seconds, step = 0.25, horizon = 1.5, onTick = null, until = null }) {
    let cursor = ctx.currentTime;
    const end = ctx.currentTime + seconds;
    for (let now = ctx.currentTime; now < end; now += step) {
        ctx.currentTime = now;
        seq.schedule(Math.max(cursor, now), now + horizon);
        cursor = now + horizon;
        onTick?.(now);
        if (until?.()) break;
    }
}

function startSequencer(preset, { piece = null, phase = 'day', band = null, keyframe = 'noon' } = {}) {
    setRngSeed('music-test');
    const { engine, ctx } = makeEngine();
    const seq = new Sequencer(engine, { preset });
    const marks = [];
    seq.observe(mark => marks.push(mark));
    if (piece || band != null) assert.equal(seq.pin({ piece, band }), true);
    seq.setPhase(phase);
    seq.setArrangement({ weather: 'clear', season: 'summer', keyframe });
    seq.start();
    seq.setLevel(1, 0.1);
    return { seq, ctx, engine, marks };
}

const notes = (marks, from = -Infinity, to = Infinity) => marks.filter(m => m.kind === 'note' && m.t >= from && m.t < to);

function writtenChordAtBeat(piece, beat) {
    const bpb = piece.beatsPerBar || 4;
    const entry = piece.chords[Math.floor(beat / bpb)];
    return Array.isArray(entry) ? entry[beat % bpb >= bpb / 2 ? 1 : 0] : entry;
}

test('Town band: the MusicClock chord follows the written chords through every pass, and the bar nowPlaying shows', () => {
    for (const piece of PIECES) {
        const night = piece.family === 'night';
        const { seq, ctx, engine, marks } = startSequencer('townBand', {
            piece: piece.name, phase: night ? 'night' : 'day', keyframe: night ? 'night' : 'noon',
        });
        const bpb = piece.beatsPerBar || 4;
        let checked = 0;
        drive(seq, ctx, {
            seconds: 150,
            until: () => marks.some(m => m.kind === 'pieceEnd'),
            onTick(now) {
                const playing = seq.nowPlaying;
                const loop = [...marks].reverse().find(m => m.kind === 'loop' && m.t <= now);
                if (!playing || !loop) return;
                const inPass = [...marks].reverse().find(m => ['loop', 'chunk', 'pieceEnd'].includes(m.kind) && m.t <= now);
                if (inPass.segment && inPass.segment !== 'pass') return;
                const snapshot = engine.musicClock.snapshot(now);
                assert.equal(snapshot.bar, playing.bar, `${piece.name} bar at ${now}`);
                const beat = (playing.bar - 1) * bpb + snapshot.beat - 1;
                if (playing.bar >= piece.chords.length - 1) return; // colour and tag bars
                assert.deepEqual(snapshot.chord, chordPitchClasses(writtenChordAtBeat(piece, beat)), `${piece.name} beat ${beat}`);
                checked++;
            },
        });
        assert.ok(checked > 10, `${piece.name}: ${checked} beats checked`);
        seq.stop();
        assert.equal(engine.musicClock.playing(ctx.currentTime), false, 'stop clears the clock');
    }
});

function noteKeys(preset, piece, windows) {
    const { seq, ctx, marks } = startSequencer(preset, { piece });
    if (preset === 'village') seq.playFragment(null, { reason: 'test' });
    drive(seq, ctx, { seconds: 70, ...windows });
    seq.stop();
    return notes(marks, 0, 60).map(m => `${m.t.toFixed(6)}@${m.seat}:${m.midi}`).sort();
}

test('the window size never changes the notes: per-window emission is exact', () => {
    for (const [preset, piece] of [['townBand', PLAYLISTS.day[0]], ['village', null]]) {
        const reference = noteKeys(preset, piece, { step: 0.25, horizon: 1.5 });
        assert.ok(reference.length > 10);
        assert.deepEqual(noteKeys(preset, piece, { step: 1, horizon: 1.5 }), reference, `${preset} 1 s ticks`);
        assert.deepEqual(noteKeys(preset, piece, { step: 0.05, horizon: 0.3 }), reference, `${preset} short horizon`);
    }
});

test('a stalled window drops its late notes and never smears them onto now', () => {
    const { seq, ctx, marks } = startSequencer('townBand', { piece: PLAYLISTS.day[0] });
    drive(seq, ctx, { seconds: 5 });
    const before = marks.length;
    ctx.currentTime += 3;
    const dropped = seq.schedule(ctx.currentTime, ctx.currentTime + 1.5);
    assert.ok(dropped > 0, 'the notes of the gap are counted');
    assert.deepEqual(notes(marks.slice(before)).filter(m => m.t < ctx.currentTime), [], 'no note was placed in the past');
    seq.stop();
});

test('a band change and an arrangement change land on the next four-bar boundary', () => {
    const { seq, ctx, marks } = startSequencer('townBand', { piece: PLAYLISTS.day[0] });
    let askedAt = null;
    drive(seq, ctx, {
        seconds: 60,
        onTick(now) {
            if (askedAt === null && now >= 6) {
                seq.setBand(0);
                seq.setArrangement({ weather: 'rain' });
                askedAt = now;
            }
        },
    });
    const chunks = marks.filter(m => m.kind === 'loop' || m.kind === 'chunk');
    const first = chunks.find(m => m.band === 0);
    assert.ok(first.t > askedAt, 'never retroactive');
    const beats = (first.t - first.t0) / first.beatSec;
    assert.ok(Math.abs(beats / 16 - Math.round(beats / 16)) < 1e-9, 'on a four-bar boundary');
    assert.ok(first.t - askedAt <= 16 * first.beatSec + 1.5, 'within one chunk plus the horizon');
    const switched = marks.find(m => m.kind === 'arrangement');
    assert.equal(switched.weather, 'rain');
    assert.equal(switched.t, first.t, 'the arrangement lands on the same boundary');
    assert.deepEqual(notes(marks, first.t).filter(m => m.seat !== 'lead' && m.seat !== 'bass'), [], 'band 0 is the tune and the bass');
    seq.stop();
});

test('percussion: none while no building works, hits on the grid once they do', () => {
    const piece = PIECES.find(p => p.percussion && Object.keys(p.percussion).length && p.family === 'day');
    const { seq, ctx, marks } = startSequencer('townBand', { piece: piece.name, band: 3 });
    drive(seq, ctx, { seconds: 30 });
    // The workshop kit (the band's own groove is not the village's work).
    const kit = m => m.kind === 'perc' && !m.groove;
    assert.equal(marks.filter(kit).length, 0, 'working === 0 → zero workshop percussion');
    seq.setWorkshopDensity(Object.fromEntries(Object.keys(piece.percussion).map(b => [b, 1])));
    const from = ctx.currentTime + 1.5;
    drive(seq, ctx, { seconds: 40 });
    const hits = marks.filter(m => kit(m) && m.t >= from);
    assert.ok(hits.length > 0);
    const loop = marks.find(m => m.kind === 'loop');
    const sixteenth = loop.beatSec / 4;
    for (const hit of hits) {
        const steps = (hit.t - loop.t0) / sixteenth;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, 'on the song grid');
    }
    seq.stop();
});

test('the waiting cadence turns phrase ends deceptive while someone waits and lands home after the answer', () => {
    const piece = PIECES.find(p => p.phraseEnds?.length >= 2 && p.family === 'day');
    const { seq, ctx, marks, engine } = startSequencer('townBand', { piece: piece.name });
    seq.setWaiting(true);
    let answered = false;
    const heard = [];
    drive(seq, ctx, {
        seconds: 200,
        until: () => marks.some(m => m.kind === 'cadence' && m.type === 'home'),
        onTick() {
            const cadences = marks.filter(m => m.kind === 'cadence');
            // What the clock says at each cadence bar, while its frame is live.
            for (const m of cadences.slice(heard.length)) heard.push(engine.musicClock.chordAt(m.t + 0.01));
            if (!answered && cadences.length >= 2) {
                seq.setWaiting(false);
                answered = true;
            }
        },
    });
    const cadences = marks.filter(m => m.kind === 'cadence');
    assert.ok(cadences.slice(0, 2).every(m => m.type === 'deceptive'), cadences.map(m => m.type).join(' '));
    assert.equal(cadences.at(-1).type, 'home');
    // The deceptive bar sounds its written alternative in the clock.
    const end = piece.phraseEnds.find(e => e.bar + 1 === cadences[0].bar);
    assert.deepEqual(heard[0], chordPitchClasses(end.chord));
    seq.stop();
});

test('no identical rendition of a piece comes back within an hour of the Town band', () => {
    const { seq, ctx, marks } = startSequencer('townBand');
    drive(seq, ctx, { seconds: 3600, step: 1 });
    const seen = new Map();
    for (const m of marks.filter(x => x.kind === 'rendition')) {
        assert.ok(!seen.has(m.key) || m.t - seen.get(m.key) >= 3600, `${m.key} again after ${m.t - seen.get(m.key)} s`);
        seen.set(m.key, m.t);
    }
    // Rotation: no piece restarts within 6 min of its end (4 min in a small set).
    const ends = new Map();
    for (const m of marks) {
        if (m.kind === 'pieceEnd' && m.what === 'piece') ends.set(m.piece, m.t);
        if (m.kind === 'start' && m.what === 'piece' && ends.has(m.piece)) {
            const gap = PLAYLISTS.day.length >= 4 ? 360 : 240;
            assert.ok(m.t - ends.get(m.piece) >= gap - 1e-6, `${m.piece} back after ${m.t - ends.get(m.piece)} s`);
        }
    }
    // A true breath before every next first note.
    for (const breath of marks.filter(m => m.kind === 'breath')) {
        const next = notes(marks, breath.t).find(Boolean);
        if (next) assert.ok(next.t >= breath.until - 0.0071, `breath ${next.t - breath.t} s`);
    }
    seq.stop();
});

test('Village plays nothing until asked, then one closed fragment with its reason', () => {
    const { seq, ctx, marks } = startSequencer('village');
    drive(seq, ctx, { seconds: 20 });
    assert.equal(notes(marks).length, 0);
    const fragment = FRAGMENTS.find(f => !f.night);
    const started = seq.playFragment(fragment.id, { reason: 'fragment: busy village' });
    assert.equal(started.ok, true);
    assert.equal(seq.playFragment(null).ok, false, 'one at a time');
    drive(seq, ctx, { seconds: 30, until: () => !seq.busy });
    const played = notes(marks);
    assert.ok(played.length > 0);
    assert.ok(played[0].t >= started.startsAt - 0.0071);
    assert.ok(played.at(-1).t < started.endsAt);
    const start = marks.find(m => m.kind === 'start');
    assert.equal(start.reason, 'fragment: busy village');
    assert.ok(marks.some(m => m.kind === 'end'));
    seq.stop();
});

test('a faded release ends the visit at the fade and nothing sounds after it', () => {
    const { seq, ctx, marks } = startSequencer('village');
    const started = seq.playOccasion('noon', { reason: 'noon' });
    assert.equal(started.ok, true);
    drive(seq, ctx, { seconds: 8 });
    assert.equal(seq.release({ reason: 'rain', fadeSec: 0.4 }), true);
    const placed = marks.length;
    drive(seq, ctx, { seconds: 10 });
    assert.equal(seq.busy, false);
    assert.equal(seq.nowPlaying, null);
    assert.deepEqual(notes(marks.slice(placed)), [], 'nothing is placed after the release');
    assert.equal(marks.filter(m => m.kind === 'end').at(-1).reason, 'rain');
    seq.stop();
});

test('nearest-inversion comp moves a few semitones per change inside its window', () => {
    let prev = null;
    let total = 0;
    let changes = 0;
    for (const name of ['A', 'E', 'F#m', 'D', 'A', 'D', 'Bm', 'E', 'A']) {
        const { semis, moves } = nearestVoicing(name, prev);
        assert.ok(semis[0] >= -17 && semis.at(-1) <= -3, `${name} ${semis}`);
        if (prev) {
            total += moves;
            changes++;
        }
        prev = semis;
    }
    assert.ok(total / changes <= 4, `mean ${total / changes}`);
});
