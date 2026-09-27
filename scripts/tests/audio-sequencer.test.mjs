import test from 'node:test';
import assert from 'node:assert/strict';

import { Sequencer, engineFigure, nearestVoicing, renditionScore } from '../../claudeville/src/presentation/shared/audio/music/Sequencer.js';
import { voicingFor } from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';
import {
    PIECES, PLAYLISTS, cadenceKit, chordPitchClasses, musicKey, piece as scorePiece,
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

// The written chord over a whole beat, or null when a split bar changes
// chord inside that beat (a 3/4 or 6/8 bar splits at 1.5 or 3 beats).
function writtenChordAtBeat(piece, beat) {
    const bpb = piece.beatsPerBar || 4;
    const entry = piece.chords[Math.floor(beat / bpb)];
    if (!Array.isArray(entry)) return entry;
    const at = beat % bpb;
    if (at < bpb / 2 && at + 1 > bpb / 2) return null;
    return entry[at >= bpb / 2 ? 1 : 0];
}

test('Town band: the MusicClock follows the piece\'s key and written chords through every pass; nowPlaying names the piece and its players', () => {
    for (const piece of PIECES) {
        const night = piece.family === 'night';
        const keyframe = night ? 'night' : 'noon';
        const { seq, ctx, engine, marks } = startSequencer('townBand', {
            piece: piece.name, phase: night ? 'night' : 'day', keyframe,
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
                assert.deepEqual(snapshot.key, musicKey(piece.key), `${piece.name} key`);
                assert.equal(playing.title, piece.title);
                const beat = (playing.bar - 1) * bpb + snapshot.beat - 1;
                if (playing.bar >= piece.chords.length - 1) return; // colour and tag bars
                const written = writtenChordAtBeat(piece, beat);
                if (written == null) return;
                assert.deepEqual(snapshot.chord, chordPitchClasses(written), `${piece.name} beat ${beat}`);
                checked++;
            },
        });
        assert.ok(checked > 10, `${piece.name}: ${checked} beats checked`);
        // The piece's own players sound it (C4), and the Now line names them.
        const seats = voicingFor({ keyframe, piece: piece.name }).seats;
        for (const seat of ['lead', 'counter']) {
            const heard = new Set(notes(marks).filter(m => m.seat === seat && m.segment === 'pass').map(m => m.instrument));
            assert.deepEqual([...heard], [seats[seat].instrument], `${piece.name} ${seat}`);
        }
        const loop = marks.find(m => m.kind === 'loop');
        assert.deepEqual([loop.lead, loop.counter], [seats.lead.instrument, seats.counter.instrument], `${piece.name} now line`);
        seq.stop();
        assert.equal(engine.musicClock.playing(ctx.currentTime), false, 'stop clears the clock');
    }
});

function noteKeys(piece, windows) {
    const { seq, ctx, marks } = startSequencer('townBand', { piece });
    drive(seq, ctx, { seconds: 70, ...windows });
    seq.stop();
    return notes(marks, 0, 60).map(m => `${m.t.toFixed(6)}@${m.seat}:${m.midi}`).sort();
}

test('the window size never changes the notes: per-window emission is exact', () => {
    const piece = PLAYLISTS.day[0];
    const reference = noteKeys(piece, { step: 0.25, horizon: 1.5 });
    assert.ok(reference.length > 10);
    assert.deepEqual(noteKeys(piece, { step: 1, horizon: 1.5 }), reference, '1 s ticks');
    assert.deepEqual(noteKeys(piece, { step: 0.05, horizon: 0.3 }), reference, 'short horizon');
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

test('no identical rendition of a piece comes back within an hour of the Town band; the rotation is a shuffle bag', () => {
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
    // C7: each round plays the whole day playlist once, the rounds in
    // different orders, and no piece twice in a row (a round boundary too).
    const order = marks.filter(m => m.kind === 'start' && m.what === 'piece').map(m => m.piece);
    const size = PLAYLISTS.day.length;
    const rounds = [];
    for (let i = 0; i + size <= order.length; i += size) rounds.push(order.slice(i, i + size));
    assert.ok(rounds.length >= 3, order.join(' '));
    for (const round of rounds) assert.deepEqual([...round].sort(), [...PLAYLISTS.day].sort(), order.join(' '));
    assert.notDeepEqual(rounds[1], rounds[0], order.join(' '));
    for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1], order.join(' '));
    // A true breath before every next first note.
    for (const breath of marks.filter(m => m.kind === 'breath')) {
        const next = notes(marks, breath.t).find(Boolean);
        if (next) assert.ok(next.t >= breath.until - 0.0071, `breath ${next.t - breath.t} s`);
    }
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

test('6/8 compiles on the eighth: half bars on the dotted quarters, the jig comp in threes, a tag from the kit', () => {
    const tag = cadenceKit({ tonic: 'D', mode: 'major' }, 6).tag;
    const jig = scorePiece({
        name: 'testJig', family: 'day', bpm: 200, beatsPerBar: 6, feel: 'lilt',
        chords: [['D', 'G'], 'D'],
        melody: [[5, 1], [9, 1], [12, 1], [9, 2], [7, 1], [5, 3], [null, 3]],
        counterNotes: [[-3, 6], [-3, 6]],
        bass: [[-19, 3], [-14, 3], [-19, 6]],
        grammar: ['s1'],
        variations: { s1: [{ melody: [[5, 3], [9, 3], [5, 6]] }] },
    });
    const score = renditionScore(jig, [0]);
    assert.equal(score.bars, 2);
    assert.deepEqual(score.timeline.map(c => [c.beat, c.name]), [[0, 'D'], [3, 'G'], [6, 'D']]);
    // A lilt swings eighths of a quarter-note beat; the 6/8 eighths stay even.
    assert.deepEqual(score.lead.map(n => n.beats), [1, 1, 1, 2, 1, 3]);
    const voicing = [-19, -15, -12];
    const figure = engineFigure('jig', voicing, 0, 6, 6, 0);
    assert.deepEqual(figure.map(n => [n.beat, n.semi]), [[0, -19], [1, -12], [2, -15], [3, -19], [4, -12], [5, -15]]);
    assert.ok(figure[0].vel > figure[1].vel && figure[3].vel > figure[4].vel, 'each dotted quarter leans');
    assert.deepEqual([...new Set(engineFigure('block2', voicing, 0, 6, 6, 0).map(n => n.beat))], [0, 3]);
    // The kit's tag closes a 6/8 piece in two bars on the tonic.
    assert.deepEqual(tag.chords, [['D', 'G'], 'D']);
    for (const line of [tag.melody, tag.bass]) assert.equal(line.reduce((s, [, b]) => s + b, 0), 12);
});

test('a chord strike keeps the comp at its level: a held player\'s tones share one tone-beat, a rung player\'s ring as struck', () => {
    const voicing = [-19, -15, -12];
    for (const [pattern, bpb] of [['block2', 4], ['waltz', 3]]) {
        const rung = engineFigure(pattern, voicing, 0, bpb, bpb, 0);
        const held = engineFigure(pattern, voicing, 0, bpb, bpb, 0, { held: true });
        assert.deepEqual(held.map(n => [n.beat, n.semi, n.beats]), rung.map(n => [n.beat, n.semi, n.beats]), pattern);
        for (const beat of new Set(held.map(n => n.beat))) {
            const strike = held.filter(n => n.beat === beat);
            const struck = rung.filter(n => n.beat === beat);
            assert.ok(strike.length > 1, `${pattern} strikes a chord`);
            // Held: Σ vel² · beats is one tone of one beat at the struck velocity.
            const energy = strike.reduce((s, n) => s + n.vel ** 2 * n.beats, 0);
            assert.ok(Math.abs(energy - struck[0].vel ** 2) < 1e-9, `${pattern} at ${beat}: ${energy}`);
            assert.ok(struck.every(n => n.vel === struck[0].vel), `${pattern} rung tones at one velocity`);
        }
    }
});
