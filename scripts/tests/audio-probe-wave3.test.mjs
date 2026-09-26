import test from 'node:test';
import assert from 'node:assert/strict';

import {
    beatingDepthDb, captionExpected, expectedLadder, heldNoteRise, judgeCaptionParity, judgeCluster, judgeDiscrimination,
    judgeHeldTrim, judgeLadder, judgeWakes, phaseLockedPairs, quickSamePitchOpening, waitAudibleWindows,
} from '../audio/lib/checks.mjs';
import { wallToAudio } from '../audio/lib/probe-wave3.mjs';

const at = (xs) => xs.map(([atSec, level]) => ({ atSec, level }));

test('the D6 ladder: needs-you climbs to L4 twice then one L2 every 30 min; errors hold at L3; quota plays one L2', () => {
    assert.deepEqual(expectedLadder('needsYou', 3700), at([[0, 1], [120, 2], [360, 3], [900, 4], [1800, 4], [3600, 2]]));
    assert.deepEqual(expectedLadder('errors', 3700), at([[0, 1], [120, 2], [360, 3], [900, 3], [1800, 3], [3600, 2]]));
    assert.deepEqual(expectedLadder('quota', 3700), at([[0, 1], [120, 2]]));
    assert.deepEqual(expectedLadder('needsYou', 400), at([[0, 1], [120, 2], [360, 3]]));
});

test('ladder calls match their schedule within one late tick, never early, and keep the S7 caps', () => {
    const expected = expectedLadder('needsYou', 1000);
    const onTime = [{ atSec: 0, level: 1 }, { atSec: 121, level: 2, reminder: true }, { atSec: 361, level: 3, reminder: true }, { atSec: 902, level: 4, reminder: true }];
    assert.equal(judgeLadder(onTime, expected).pass, true);
    // A reminder 10 s late is both missing and unexpected.
    const late = onTime.map(c => (c.level === 3 ? { ...c, atSec: 370 } : c));
    const j = judgeLadder(late, expected);
    assert.equal(j.pass, false);
    assert.deepEqual(j.missing.map(m => m.level), [3]);
    assert.deepEqual(j.extra.map(e => e.atSec), [370]);
    // The wrong level at the right time does not match.
    assert.equal(judgeLadder(onTime.map(c => (c.level === 4 ? { ...c, level: 3 } : c)), expected).pass, false);
    // Reminders closer than 120 s break the cap even when the list matches;
    // the entry call is not a reminder and never counts against it.
    const crowded = judgeLadder([{ atSec: 0, level: 1 }, { atSec: 10, level: 2, reminder: true }, { atSec: 100, level: 3, reminder: true }], at([[0, 1], [10, 2], [100, 3]]));
    assert.equal(crowded.minGapSec, 90);
    assert.equal(crowded.pass, false);
    assert.equal(judgeLadder([{ atSec: 0, level: 1 }, { atSec: 120, level: 2, reminder: true }], at([[0, 1], [120, 2]])).minGapSec, null);
});

test('more than twelve reminders in a rolling hour break the cap', () => {
    const calls = Array.from({ length: 13 }, (_, i) => ({ atSec: i * 121, level: 2, reminder: true }));
    const j = judgeLadder(calls, calls.map(c => ({ atSec: c.atSec, level: 2 })));
    assert.equal(j.perHour, 13);
    assert.equal(j.pass, false);
});

test('a hidden-tab reminder must be heard within 60 s of its due time', () => {
    assert.equal(judgeWakes([100, 400], [101, 459]).pass, true);
    const j = judgeWakes([100, 400], [101, 461]);
    assert.equal(j.pass, false);
    assert.equal(j.rows[1].heard, null);
    assert.equal(judgeWakes([], []).pass, false);
});

test('a cluster rings at the loudness of one call and keeps every caption', () => {
    const agents = ['a', 'b', 'c'];
    assert.equal(judgeCluster({ oneMaxLufs: -22, manyMaxLufs: -21.1, agents, captionedAgents: agents }).pass, true);
    assert.equal(judgeCluster({ oneMaxLufs: -22, manyMaxLufs: -20.8, agents, captionedAgents: agents }).pass, false);
    assert.deepEqual(judgeCluster({ oneMaxLufs: -22, manyMaxLufs: -22, agents, captionedAgents: ['a', 'b'] }).missing, ['c']);
});

test('two same-kind urgent scores for different agents sharing two note times are phase-locked', () => {
    const lead = { kind: 'summons', agentId: 'a', notes: [10, 10.15, 10.65] };
    assert.deepEqual(phaseLockedPairs([lead, { kind: 'summons', agentId: 'b', notes: [10.002, 10.151, 11] }]).map(p => p.hits), [2]);
    // One shared strike (a flock tick on the lead's downbeat) is not a copy.
    assert.equal(phaseLockedPairs([lead, { kind: 'summons', agentId: 'b', notes: [10.002] }]).length, 0);
    assert.equal(phaseLockedPairs([lead, { kind: 'summons', agentId: 'b', notes: [10.01, 10.16] }]).length, 0);
    assert.equal(phaseLockedPairs([lead, { kind: 'distress', agentId: 'b', notes: [10, 10.15] }]).length, 0);
});

// A band curve on a 0.1 s hop: `level(t)` in dB.
const curve = (from, to, level) => Array.from({ length: Math.round((to - from) * 10) }, (_, i) => [from + i / 10, level(from + i / 10)]);

test('the held note must rise 6 dB within 6 s of the wait and fall back within 5 s of the answer', () => {
    const good = curve(0, 60, t => (t >= 12 && t < 42 ? 10 : 0));
    const j = heldNoteRise(good, 10, 40);
    assert.equal(j.preDb, 0);
    // The step lands 2 s in; the judge reads it at the end of its 1 s window.
    assert.ok(j.riseAtSec >= 2 && j.riseAtSec <= 3, `rise ${j.riseAtSec}`);
    assert.ok(j.backAtSec >= 2 && j.backAtSec <= 3, `back ${j.backAtSec}`);
    assert.equal(j.pass, true);
    assert.equal(heldNoteRise(curve(0, 60, t => (t >= 17 ? 10 : 0)), 10, 40).pass, false);
    assert.equal(heldNoteRise(curve(0, 60, t => (t >= 12 && t < 47 ? 10 : 0)), 10, 40).pass, false);
    assert.equal(heldNoteRise(curve(0, 60, t => (t >= 12 ? 4 : 0)), 10, 40).pass, false);
});

test('beating depth is the envelope swing, robust to one stray block', () => {
    assert.equal(beatingDepthDb(Array(50).fill(-40)), 0);
    const swing = Array.from({ length: 200 }, (_, i) => -40 + 2 * Math.sin(i / 5));
    assert.ok(Math.abs(beatingDepthDb(swing) - 4) < 0.1);
    assert.ok(beatingDepthDb([...Array(200).fill(-40), -70]) < 0.1);
});

test('a wait is audible only if every 10 s window holds the rise until the answer', () => {
    assert.equal(waitAudibleWindows(curve(0, 100, t => (t >= 10 ? 8 : 0)), 5, 95).pass, true);
    const gap = waitAudibleWindows(curve(0, 100, t => (t >= 10 && (t < 50 || t >= 60) ? 8 : 0)), 5, 95);
    assert.equal(gap.pass, false);
    assert.ok(gap.worstRiseDb < 6);
});

test('captions per setting: signals always, events per setting and sound, scenery only for everything with sound, the digest never', () => {
    for (const setting of ['auto', 'signals', 'events', 'all']) for (const on of [true, false]) assert.equal(captionExpected('reminder', setting, on), true);
    assert.equal(captionExpected('push', 'auto', false), false);
    assert.equal(captionExpected('push', 'auto', true), true);
    assert.equal(captionExpected('arrival', 'signals', true), false);
    assert.equal(captionExpected('arrival', 'events', false), true);
    assert.equal(captionExpected('hourBell', 'all', false), false);
    assert.equal(captionExpected('hourBell', 'events', true), false);
    assert.equal(captionExpected('hourBell', 'all', true), true);
    assert.equal(captionExpected('digest', 'all', true), false);
});

test('caption parity fails on a caption shown against its setting, a caption missing, or a caption for a silent cue', () => {
    const row = { kind: 'push', setting: 'auto', soundOn: true, played: true, shown: true, heard: true };
    assert.equal(judgeCaptionParity([row]).pass, true);
    assert.equal(judgeCaptionParity([{ ...row, soundOn: false, heard: null }]).pass, false);
    assert.equal(judgeCaptionParity([{ ...row, shown: false }]).pass, false);
    assert.equal(judgeCaptionParity([{ ...row, heard: false }]).pass, false);
    // A cue that never played has nothing to caption.
    assert.equal(judgeCaptionParity([{ ...row, played: false, shown: false }]).pass, true);
});

test('discrimination gates signal pairs at 2 of 3 dimensions and reports the urgent minimum', () => {
    const row = (signal, other, n) => ({ signal, other, n, dims: ['contour', 'rhythm', 'timbre'].slice(0, n), sameOpening: false });
    const stratum = { 'needs you': 'signal', error: 'signal', 'rate limit': 'signal', oak: 'outcome', arrival: 'routine' };
    const opts = { stratum, urgent: ['needs you', 'error', 'rate limit'], needsYou: 'needs you' };
    const rows = [row('needs you', 'error', 3), row('needs you', 'rate limit', 2), row('error', 'rate limit', 3), row('needs you', 'oak', 2), row('error', 'arrival', 3)];
    const j = judgeDiscrimination(rows, opts);
    assert.equal(j.pass, true);
    assert.equal(j.urgentMin, 2);
    assert.equal(j.outcomeFull, 0);
    assert.deepEqual(j.outcomeNot3, ['oak 2/3 (contour+rhythm)']);
    const bad = judgeDiscrimination([...rows, row('rate limit', 'arrival', 1)], opts);
    assert.equal(bad.pass, false);
    assert.deepEqual(bad.failures, ['rate limit vs arrival 1/3']);
});

test('only a quick opening on one pitch is the needs-you figure', () => {
    assert.equal(quickSamePitchOpening([{ ms: 0, hz: 659.3 }, { ms: 150, hz: 659.3 }]), true);
    assert.equal(quickSamePitchOpening([{ ms: 0, hz: 220 }, { ms: 1400, hz: 220 }]), false);
    assert.equal(quickSamePitchOpening([{ ms: 0, hz: 329.6 }, { ms: 110, hz: 220 }]), false);
    assert.equal(quickSamePitchOpening([{ ms: 0, hz: null }, { ms: 60, hz: null }]), false);
    assert.equal(quickSamePitchOpening([{ ms: 0, hz: 659.3 }]), false);
});

test('the ladder holds its entry trim: L2 at least 4 LU under L1 and L3 inside the GR limit', () => {
    const calls = [{ level: 1, margin: 11, grDb: 1, trimDb: 2 }, { level: 2, margin: 6.5, grDb: 0.5, trimDb: 2 }, { level: 3, margin: 11.5, grDb: 2.5, trimDb: 2 }];
    assert.equal(judgeHeldTrim(calls).pass, true);
    assert.deepEqual(judgeHeldTrim(calls.map(c => (c.level === 2 ? { ...c, trimDb: 4 } : c))).failures, ['trim re-taken']);
    assert.deepEqual(judgeHeldTrim(calls.map(c => (c.level === 2 ? { ...c, margin: 8 } : c))).failures, ['L2 not 4 LU under L1']);
    assert.deepEqual(judgeHeldTrim(calls.map(c => (c.level === 3 ? { ...c, grDb: 3.6 } : c))).failures, ['L3 GR > 3 dB']);
    assert.equal(judgeHeldTrim(calls.slice(0, 2)).pass, false);
});

test('a page-clock time maps to audio time through the last context state before it', () => {
    const states = [{ t: 0, wall: 0, state: 'running' }, { t: 35, wall: 35, state: 'suspended' }, { t: 35, wall: 130, state: 'running' }, { t: 40, wall: 135, state: 'suspended' }];
    assert.equal(wallToAudio(states, 20), 20);
    assert.equal(wallToAudio(states, 100), 35);
    assert.equal(wallToAudio(states, 132), 37);
    assert.equal(wallToAudio(states, 500), 40);
});
