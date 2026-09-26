import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HELD_NOTE_HZ,
    HELD_UNDER_BED_LU,
    HeldNote,
    LOW_UNDER_OPEN_DB,
    RESOLVED_HZ,
    heldNoteGain,
} from '../../claudeville/src/presentation/shared/audio/layers/HeldNote.js';

// BS.1770 loudness of the pair (D at g, A at LOW_UNDER_OPEN_DB under it, both
// output channels, with the −0.7 dB measured pair weighting).
const r = Math.pow(10, LOW_UNDER_OPEN_DB / 20);
const pairLufs = g => -0.691 + 10 * Math.log10(g * g * (1 + r * r)) - 0.7;

test('the held note sits 8 LU under the bed it is measured against, by loudness', () => {
    for (const bed of [-70, -66, -58, -50]) {
        assert.ok(Math.abs(pairLufs(heldNoteGain(bed)) - (bed - HELD_UNDER_BED_LU)) < 0.01);
    }
    // A bed 10 LU louder lifts the note 10 dB; no reading falls back to anchor A.
    assert.ok(Math.abs(20 * Math.log10(heldNoteGain(-56) / heldNoteGain(-66)) - 10) < 1e-9);
    assert.equal(heldNoteGain(null), heldNoteGain(-66));
});

// A minimal Web Audio stand-in that records every AudioParam event.
class Param {
    constructor(value = 0) { this.value = value; this.events = []; }
    setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; }
    setTargetAtTime(v, t, tau) { this.events.push(['target', v, t, tau]); }
    exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); }
    linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); }
    cancelAndHoldAtTime(t) { this.events.push(['hold', t]); }
    cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}
class Node {
    constructor(extra = {}) { Object.assign(this, extra); }
    connect(to) { return to; }
    disconnect() {}
}
function fakeEngine({ bed = -60 } = {}) {
    const oscillators = [];
    const ctx = {
        currentTime: 0,
        createGain: () => new Node({ gain: new Param(1) }),
        createOscillator: () => {
            const osc = new Node({ frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
            oscillators.push(osc);
            return osc;
        },
    };
    return {
        context: ctx,
        oscillators,
        now: () => ctx.currentTime,
        bedLoudness: () => bed,
        busInput: (name, director) => {
            assert.equal(name, 'signalBed');
            assert.equal(director, 'ambient');
            return new Node();
        },
        stopGroup: () => ctx.currentTime + 0.08,
    };
}

// The two voiced sines are the oscillators set to A3 and D4 (the others drift them).
const voiced = engine => engine.oscillators.filter(osc => osc.frequency.events[0]?.[0] === 'set');

test('answering resolves D to C♯ by day and C at night, then releases; other closes only fade', () => {
    for (const [phase, hz] of [['day', RESOLVED_HZ.day], ['night', RESOLVED_HZ.night]]) {
        const engine = fakeEngine();
        const note = new HeldNote(engine, { director: 'ambient' });
        note.start();
        const [low, open] = voiced(engine);
        assert.deepEqual([low.frequency.events[0][1], open.frequency.events[0][1]], [HELD_NOTE_HZ.low, HELD_NOTE_HZ.open]);
        note.setState({ open: true, phase });
        assert.equal(note.snapshot().state, 'open');
        engine.context.currentTime = 10;
        note.setState({ open: false, reason: 'answered', phase });
        assert.equal(note.state, 'resolving');
        const glide = open.frequency.events.find(event => event[0] === 'exp');
        assert.deepEqual(glide, ['exp', hz, 11.2]);
        // Silent within 5 s of the answer; the A never moves.
        assert.ok(note._silentAt <= 15);
        assert.equal(low.frequency.events.length, 1);
        engine.context.currentTime = 16;
        note.setState({ open: false });
        assert.equal(note.state, 'closed');
    }

    const engine = fakeEngine();
    const note = new HeldNote(engine);
    note.start();
    note.setState({ open: true });
    note.setState({ open: false, reason: 'music' });
    assert.equal(note.state, 'fading');
    assert.equal(voiced(engine)[1].frequency.events.some(event => event[0] === 'exp'), false);
});

test('a wait reopened mid-resolution returns to D and rises again', () => {
    const engine = fakeEngine();
    const note = new HeldNote(engine);
    note.start();
    note.setState({ open: true });
    engine.context.currentTime = 5;
    note.setState({ open: false, reason: 'answered' });
    engine.context.currentTime = 5.5;
    note.setState({ open: true });
    assert.equal(note.state, 'open');
    const open = voiced(engine)[1];
    assert.deepEqual(open.frequency.events.at(-1).slice(0, 2), ['target', HELD_NOTE_HZ.open]);
});
