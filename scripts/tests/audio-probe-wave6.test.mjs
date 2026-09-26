import test from 'node:test';
import assert from 'node:assert/strict';

import {
    arrangementSwitch, automationCurve, bandStep, breathsPerWindow, coveredSec, earlyReturns, judgeDuty, judgeIsleArm, judgeStemBalance,
    loopsPerPieceHour, musicInWindows, nightDarker, perHourMax, spearman,
} from '../audio/lib/checks.mjs';
import { densityTrack, noteRows, percussionPerBar, visitRows } from '../audio/lib/probe-wave6.mjs';

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

test('music inside a forbidden window counts seconds and starts', () => {
    assert.equal(coveredSec([{ from: 0, to: 10 }, { from: 5, to: 15 }, { from: 20, to: 25 }], 2, 22), 15);
    const j = musicInWindows([{ from: 100, to: 130 }], [{ from: 0, to: 90, why: 'rain' }, { from: 120, to: 200, why: 'resting' }], [100]);
    assert.equal(j.overlapSec, 10);
    assert.equal(j.starts, 0);
    assert.equal(j.pass, false);
    assert.equal(musicInWindows([{ from: 100, to: 130 }], [{ from: 0, to: 90 }]).pass, true);
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

test('per-hour counts and D1 duty bands', () => {
    const j = perHourMax([10, 20, 3700, 3710, 3720], 0, 7200, 2);
    assert.deepEqual(j.perHour, [2, 3]);
    assert.equal(j.pass, false);
    assert.equal(judgeDuty(0.08, 'busy').pass, true);
    assert.equal(judgeDuty(0.05, 'busy').pass, false);
    assert.equal(judgeDuty(0.21, 'light').pass, false);
    assert.equal(judgeDuty(0.03, 'deepNight').pass, true);
    assert.equal(judgeDuty(null, 'night').pass, false);
});

test('visits and sounding notes drop a Village visit released before its first note', () => {
    const marks = [
        { preset: 'village', kind: 'start', t: 10, what: 'fragment', name: 'a', reason: 'fragment:busy' },
        { preset: 'village', kind: 'note', t: 10.2, seat: 'lead', midi: 69 },
        { preset: 'village', kind: 'end', t: 18 },
        { preset: 'village', kind: 'start', t: 40, what: 'occasion', name: 'noon', reason: 'occasion:noon' },
        { preset: 'village', kind: 'cancel', t: 39.5 },
        { preset: 'village', kind: 'note', t: 40.1, seat: 'lead', midi: 71 },
        { preset: 'village', kind: 'start', t: 60, what: 'fragment', name: 'b', reason: 'fragment:light' },
        { preset: 'village', kind: 'note', t: 60.5, seat: 'lead', midi: 73 },
    ];
    const v = visitRows(marks, 90, 'village');
    assert.deepEqual(v.visits.map(x => [x.name, x.from, x.to]), [['a', 10, 18], ['b', 60, 90]]);
    assert.deepEqual(noteRows(marks).map(n => n.midi), [69, 73]);
});

test('percussion is counted per bar of the song grid against the density the director fed', () => {
    const marks = [
        { preset: 'townBand', kind: 'call:setWorkshopDensity', t: 0, arg: { forge: 0.5, archive: 0.3 } },
        { preset: 'townBand', kind: 'loop', t: 1, barSec: 2, band: 1 },
        { preset: 'townBand', kind: 'call:setWorkshopDensity', t: 4.5, arg: {} },
        { preset: 'townBand', kind: 'chunk', t: 9, barSec: 2, band: 1 },
        { preset: 'townBand', kind: 'perc', t: 1.5 }, { preset: 'townBand', kind: 'perc', t: 2.9 }, { preset: 'townBand', kind: 'perc', t: 3.2 },
    ];
    const density = densityTrack(marks);
    assert.equal(density(3), 0.8);
    assert.equal(density(5), 0);
    const bars = percussionPerBar(marks, density, { from: 0, to: 13 });
    assert.deepEqual(bars.map(b => [b.from, b.onsets, b.density]), [[1, 2, 0.8], [3, 1, 0.8], [5, 0, 0], [7, 0, 0], [9, 0, 0], [11, 0, 0]]);
});
