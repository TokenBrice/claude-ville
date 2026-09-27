import test from 'node:test';
import assert from 'node:assert/strict';

import {
    arrangementSwitch, automationCurve, bandStep, breathsPerWindow, coveredSec, earlyReturns, judgeIsleArm, judgeStemBalance,
    loopsPerPieceHour, nightDarker, spearman,
} from '../audio/lib/checks.mjs';
import { noteRows, percussionPerBar, visitRows } from '../audio/lib/probe-wave6.mjs';

test('stem balance holds each admitted seat to its MUSL-2 window, the floor and under the lead', () => {
    const seats = { lead: -40, bass: -43.5, counter: -46, engine: -48, percussion: -54 };
    const ok = judgeStemBalance(seats, ['lead', 'bass', 'counter', 'engine', 'percussion']);
    assert.equal(ok.pass, true);
    // Only admitted seats are judged: a silent engine in a band that does
    // not admit it is fine.
    assert.equal(judgeStemBalance({ ...seats, engine: -Infinity }, ['lead', 'bass']).pass, true);
    // An admitted seat that is silent is below the floor.
    const silent = judgeStemBalance({ ...seats, counter: -Infinity }, ['lead', 'counter']);
    assert.equal(silent.pass, false);
    assert.equal(silent.rows[0].aboveFloor, false);
    // Bass louder than its window (the shipped band's +4 LU bass).
    const loud = judgeStemBalance({ ...seats, bass: -36 }, ['lead', 'bass']);
    assert.equal(loud.rows[0].inWindow, false);
    assert.equal(loud.rows[0].underLead, false);
    // A seat with no MUSL-2 window (the descant) answers to the floor and the lead only.
    assert.equal(judgeStemBalance({ lead: -40, descant: -49 }, ['lead', 'descant']).pass, true);
    assert.equal(judgeStemBalance({ lead: -40, descant: -56 }, ['lead', 'descant']).pass, false);
});

test('a working band differs from the one below by onsets or by an octave band', () => {
    const flat = [-40, -40, -40, -40];
    assert.equal(bandStep({ onsets: 100, octaveDb: flat }, { onsets: 130, octaveDb: flat }).pass, true);
    assert.equal(bandStep({ onsets: 100, octaveDb: flat }, { onsets: 129, octaveDb: flat }).pass, false);
    const j = bandStep({ onsets: 100, octaveDb: flat }, { onsets: 105, octaveDb: [-40, -36.9, -40, -40] });
    assert.equal(j.pass, true);
    assert.ok(Math.abs(j.maxOctaveDb - 3.1) < 1e-9);
    // Identical bands (the shipped cobblemarket light ≡ steady) fail.
    assert.equal(bandStep({ onsets: 80, octaveDb: flat }, { onsets: 80, octaveDb: flat }).pass, false);
    // A band that opens a silent octave differs there.
    assert.equal(bandStep({ onsets: 80, octaveDb: [-Infinity, -40] }, { onsets: 80, octaveDb: [-60, -40] }).pass, true);
});

test('the Isle arm and night darkness judge the 6.1 numbers', () => {
    assert.equal(judgeIsleArm({ laptopLossLu: 1.2, sideMidDb: -12, monoLossLu: 0.4 }).pass, true);
    assert.deepEqual(judgeIsleArm({ laptopLossLu: 4, sideMidDb: -18, monoLossLu: 1.2 }).failures, ['laptop', 'S/M', 'mono']);
    assert.equal(nightDarker(-20, -24.5).pass, true);
    assert.equal(nightDarker(-20, -17.1).pass, false);
    assert.equal(nightDarker(null, -20).pass, false);
});

test('the automation curve follows Web Audio envelope semantics', () => {
    // Attack, hold, setTarget release: 7 time constants is ≈ −60.8 dB.
    const env = automationCurve([
        { type: 'set', t: 1, v: 0 },
        { type: 'linear', t: 1.01, v: 1 },
        { type: 'target', t: 2, v: 0, tau: 0.3 },
    ], 1);
    assert.equal(env(0.5), 1);
    assert.equal(env(1), 0);
    assert.ok(Math.abs(env(1.005) - 0.5) < 1e-9);
    assert.equal(env(1.5), 1);
    assert.ok(Math.abs(20 * Math.log10(env(2 + 7 * 0.3))) - 60.8 < 0.1);
    // cancelAndHold freezes the decay where it is.
    const held = automationCurve([
        { type: 'set', t: 0, v: 1 },
        { type: 'target', t: 0, v: 0, tau: 1 },
        { type: 'cancelHold', t: 1 },
    ], 1);
    assert.ok(Math.abs(held(5) - Math.exp(-1)) < 1e-9);
    // An exponential ramp to 0.001 over one second is −60 dB at its end.
    const exp = automationCurve([{ type: 'set', t: 0, v: 1 }, { type: 'exponential', t: 1, v: 0.001 }], 1);
    assert.ok(Math.abs(exp(0.5) - Math.sqrt(0.001)) < 1e-12);
    // cancelScheduledValues drops the release that had not started.
    const cut = automationCurve([{ type: 'set', t: 0, v: 1 }, { type: 'linear', t: 2, v: 0 }, { type: 'cancel', t: 1 }], 1);
    assert.equal(cut(1.5), 1);
});

test('Spearman handles ties and refuses a constant side', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
    assert.ok(Math.abs(spearman([1, 1, 2, 3], [1, 2, 3, 4]) - 0.9486832980505138) < 1e-12);
    assert.equal(spearman([1, 2, 3], [5, 5, 5]), null);
    assert.equal(spearman([1, 2], [1, 2]), null);
});

test('covered seconds are the union of intervals clipped to the window', () => {
    assert.equal(coveredSec([{ from: 0, to: 10 }, { from: 5, to: 15 }, { from: 20, to: 25 }], 2, 22), 15);
    assert.equal(coveredSec([{ from: 30, to: 40 }], 0, 20), 0);
});

test('an arrangement switch lands on the first boundary the band had not committed', () => {
    const boundaries = [10, 18, 26, 34];
    assert.equal(arrangementSwitch([18], boundaries, 12).pass, true);
    // The next boundary was already committed (1 s after the change): the one after is allowed.
    assert.equal(arrangementSwitch([26], boundaries, 17).pass, true);
    // Skipping an uncommitted boundary is late.
    assert.equal(arrangementSwitch([26], boundaries, 12).pass, false);
    // Off the chunk grid.
    assert.equal(arrangementSwitch([19], boundaries, 12).pass, false);
    assert.equal(arrangementSwitch([], boundaries, 12).pass, false);
});

test('a piece may not return within 6 minutes (4 with a small set)', () => {
    const visits = [{ piece: 'a', from: 0, to: 200 }, { piece: 'b', from: 201, to: 400 }, { piece: 'a', from: 401, to: 600 }];
    const j = earlyReturns(visits);
    assert.equal(j.pass, false);
    assert.equal(j.returns[0].gapSec, 201);
    assert.equal(earlyReturns([{ piece: 'a', from: 0, to: 100 }, { piece: 'a', from: 341, to: 400 }], { setSize: 3 }).pass, true);
    assert.equal(earlyReturns([{ piece: 'a', from: 0, to: 100 }, { piece: 'a', from: 341, to: 400 }], { setSize: 5 }).pass, false);
});

test('every ten minutes has a breath or an interlude', () => {
    assert.equal(breathsPerWindow([100, 700, 1300], 0, 1800).pass, true);
    const j = breathsPerWindow([100, 1300], 0, 1800);
    assert.deepEqual(j.empty, [600]);
    assert.equal(breathsPerWindow([], 0, 300).pass, false);
});

test('loops are identical renditions of one piece within a clock hour', () => {
    const r = [];
    for (let i = 0; i < 14; i++) r.push({ piece: 'w', t: i * 200, key: 'same' });
    const j = loopsPerPieceHour(r);
    assert.equal(j.worst.piece, 'w');
    assert.equal(j.worst.loops, 13);
    assert.equal(j.pass, false);
    // Twelve repeats in one hour is the S7 limit.
    assert.equal(loopsPerPieceHour(r.slice(0, 13)).pass, true);
    // The next hour starts its own count; distinct renditions are not loops.
    const twoHours = Array.from({ length: 20 }, (_, i) => ({ piece: 'w', t: i * 360, key: 'k' }));
    assert.equal(loopsPerPieceHour(twoHours).worst.loops, 9);
    assert.equal(loopsPerPieceHour(twoHours.map((x, i) => ({ ...x, key: `k${i}` }))).worst.loops, 0);
});

test('Town band visits run start to end (a new start closes an open visit) and notes are read in their window', () => {
    const marks = [
        { preset: 'townBand', kind: 'start', t: 10, what: 'piece', piece: 'a', name: 'a', reason: 'rotation' },
        { preset: 'townBand', kind: 'note', t: 10.2, seat: 'lead', midi: 69 },
        { preset: 'townBand', kind: 'end', t: 18 },
        { preset: 'townBand', kind: 'breath', t: 18, until: 19.4 },
        { preset: 'townBand', kind: 'start', t: 19.4, what: 'interlude', piece: 'a', name: 'a:interlude', reason: 'interlude' },
        { preset: 'townBand', kind: 'perc', t: 20, building: 'forge', voice: 'brush' },
        { preset: 'townBand', kind: 'start', t: 40, what: 'piece', piece: 'b', name: 'b', reason: 'rotation' },
        { preset: 'townBand', kind: 'note', t: 60.5, seat: 'lead', midi: 73 },
    ];
    const v = visitRows(marks, 90);
    assert.deepEqual(v.visits.map(x => [x.name, x.from, x.to]), [['a', 10, 18], ['a:interlude', 19.4, 40], ['b', 40, 90]]);
    assert.deepEqual(v.pieces.map(x => x.piece), ['a', 'b']);
    assert.deepEqual(v.interludes, [19.4]);
    assert.deepEqual(v.breaths, [{ t: 18, until: 19.4 }]);
    assert.deepEqual(noteRows(marks).map(n => [n.seat, n.midi]), [['lead', 69], ['percussion', null], ['lead', 73]]);
    assert.deepEqual(noteRows(marks, { from: 15, to: 60 }).map(n => n.seat), ['percussion']);
});

test('the kit per bar reads the density the band read at its chunk\'s compile and each hit in units of its building\'s row', () => {
    const rows = { march: { forge: [1, 1, 0.5, 0], archive: [0.25, 0, 0, 0] }, lullaby: { forge: [0.1, 0, 0, 0.1] } };
    const marks = [
        { preset: 'townBand', kind: 'call:setWorkshopDensity', t: 0, arg: { forge: 0.5, archive: 1.3 } },
        { preset: 'townBand', kind: 'loop', t: 1, barSec: 2, band: 1, piece: 'march', segment: 'pass' },
        // Called after the chunk at 9 was compiled (marked): that chunk plays on the density before it.
        { preset: 'townBand', kind: 'chunk', t: 9, barSec: 2, band: 1, piece: 'lullaby', segment: 'pass' },
        { preset: 'townBand', kind: 'call:setWorkshopDensity', t: 8, arg: {} },
        { preset: 'townBand', kind: 'interlude', t: 13, barSec: 2, band: 1, piece: 'march', segment: 'interlude' },
        { preset: 'townBand', kind: 'perc', t: 1.5, building: 'forge' }, { preset: 'townBand', kind: 'perc', t: 2.9, building: 'archive' },
        { preset: 'townBand', kind: 'perc', t: 3.2, building: 'forge' }, { preset: 'townBand', kind: 'perc', t: 9.5, building: 'forge' },
        // The band's groove seat is not the workshop kit.
        { preset: 'townBand', kind: 'perc', t: 9.7, seat: 'groove', groove: true },
    ];
    const bars = percussionPerBar(marks, { from: 0, to: 15, rowsOf: name => rows[name] ?? null });
    assert.deepEqual(bars.map(b => [b.from, b.onsets, b.density, b.capacity]), [
        [1, 2, 1.5, 2.75], [3, 1, 1.5, 2.75], [5, 0, 1.5, 2.75], [7, 0, 1.5, 2.75], [9, 1, 1.5, 0.2], [11, 0, 1.5, 0.2], [13, 0, 0, 0],
    ]);
    // forge's row plays 2.5 hits per bar at density 1, archive's 0.25, the lullaby's forge 0.2.
    assert.deepEqual(bars.map(b => Number(b.level.toFixed(2))), [4.4, 0.4, 0, 0, 5, 0, 0]);
});
