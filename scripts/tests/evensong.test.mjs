import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

import {
    ALLOWED_KEYS,
    EVENSONG_BARS,
    EVENSONG_BEATS_PER_BAR,
    EVENSONG_BPM,
    EVENSONG_CLOSE_LEAP_SEMIS,
    EVENSONG_DAY_BARS,
    EVENSONG_ERROR_CLOSING_KINDS,
    EVENSONG_GAIN_DB,
    EVENSONG_MAX_LEAP_STEPS,
    EVENSONG_MAX_NOTES_PER_BAR,
    EVENSONG_VOICES,
    composeEvensong,
    composeEvensongMotto,
    openErrorsAt,
    pentatonicScaleInRange,
    validateEvensongGrammar,
} from '../../claudeville/src/presentation/shared/audio/bgm/Evensong.js';
import {
    RANGES,
    cadenceKit,
    musicKey,
    tonicChord,
} from '../../claudeville/src/presentation/shared/audio/bgm/ScoreKit.js';
import { phaseKey } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import {
    ERROR_RESOLVING_KINDS as LOOM_ERROR_RESOLVING_KINDS,
    openErrorsAt as loomOpenErrorsAt,
} from '../../claudeville/src/presentation/shared/ChronicleLoom.js';
import { EVENSONG_RELEASE_HARMONY_VEL, compileEvensongEvents } from '../../claudeville/src/presentation/shared/audio/bgm/BandEngine.js';
import { quickPairs, range, timeline, totalBeats } from '../audio/score-analyzer.mjs';
import {
    buildScorecardMarkdown,
    generateSyntheticDays,
    parseChronicleCsv,
    renderPianoRollPng,
} from '../audio/evensong-harness.mjs';

const mod12 = n => ((n % 12) + 12) % 12;
const pcOfSemi = semi => mod12(9 + semi);

function makeDayTs(hour, min = 0, sec = 0) {
    return new Date(2026, 4, 15, hour, min, sec, 0).getTime();
}

function makeSeededRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

describe('Evensong pure score composer', () => {
    it('returns null for silent days with no verified commit, push, or release', () => {
        assert.equal(composeEvensong([], { tonic: 'A', mode: 'minor' }), null);
        assert.equal(composeEvensong(null, { tonic: 'A', mode: 'major' }), null);

        const nonVerified = [
            { ts: makeDayTs(9, 0), kind: 'arrived', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(10, 0), kind: 'waiting', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(10, 15), kind: 'resolved', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(12, 0), kind: 'completed', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(14, 0), kind: 'errored', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(14, 30), kind: 'mended', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(15, 0), kind: 'push', outcome: 'rejected', repoSlot: 0 },
            { ts: makeDayTs(15, 30), kind: 'push', outcome: 'failed', repoSlot: 0 },
            { ts: makeDayTs(16, 0), kind: 'push', outcome: 'cancelled', repoSlot: 0 },
            { ts: makeDayTs(16, 30), kind: 'commit', verified: false, repoSlot: 0 },
            { ts: makeDayTs(18, 0), kind: 'departed', repoSlot: 0, agentId: 'a1' },
        ];
        assert.equal(composeEvensong(nonVerified, { tonic: 'A', mode: 'minor' }), null);
        assert.equal(composeEvensongMotto(nonVerified, { tonic: 'A', mode: 'minor' }), null);
    });

    it('is 100% deterministic with zero Math.random or wall-clock dependence', () => {
        const events = [
            { ts: makeDayTs(9, 15), kind: 'commit', repo: 'alpha' },
            { ts: makeDayTs(11, 30), kind: 'commit', repo: 'beta' },
            { ts: makeDayTs(13, 45), kind: 'push', repo: 'alpha' },
            { ts: makeDayTs(16, 0), kind: 'release', repo: 'beta' },
            { ts: makeDayTs(19, 10), kind: 'commit', repo: 'gamma' },
        ];
        const origRandom = Math.random;
        const origNow = Date.now;
        try {
            Math.random = () => { throw new Error('Math.random forbidden'); };
            Date.now = () => { throw new Error('Date.now forbidden'); };

            const first = composeEvensong(events, { tonic: 'D', mode: 'major' });
            const second = composeEvensong(events, { tonic: 'D', mode: 'major' });
            assert.ok(first);
            assert.deepEqual(first, second);
            assert.equal(JSON.stringify(first), JSON.stringify(second));

            const m1 = composeEvensongMotto(events, { tonic: 'D', mode: 'major' });
            const m2 = composeEvensongMotto(events, { tonic: 'D', mode: 'major' });
            assert.deepEqual(m1, m2);
        } finally {
            Math.random = origRandom;
            Date.now = origNow;
        }
    });

    it('composes a valid 1-commit day and maps repos 6..10 an octave above repos 1..5', () => {
        const key = { tonic: 'A', mode: 'major' };
        const lowDay = composeEvensong([{ ts: makeDayTs(10, 0), kind: 'commit', repoSlot: 2 }], key);
        const highDay = composeEvensong([{ ts: makeDayTs(10, 0), kind: 'commit', repoSlot: 7 }], key);

        assert.ok(lowDay && highDay);
        assert.deepEqual(validateEvensongGrammar(lowDay), { ok: true, errors: [] });
        assert.deepEqual(validateEvensongGrammar(highDay), { ok: true, errors: [] });

        assert.equal(lowDay.bpm, EVENSONG_BPM);
        assert.equal(lowDay.beatsPerBar, EVENSONG_BEATS_PER_BAR);
        assert.equal(lowDay.bars, EVENSONG_BARS);
        assert.equal(totalBeats(lowDay.melody), 64);
        assert.equal(totalBeats(lowDay.bass), 64);
        assert.deepEqual(lowDay.voices, EVENSONG_VOICES);
        assert.equal(lowDay.gainDb, EVENSONG_GAIN_DB);
        assert.equal(lowDay.percussion, null);

        // First commit maps to slot 0 (beat 0), held max 2 beats, then rests through bar 14.
        assert.equal(lowDay.melody[0][1], 2);
        assert.equal(lowDay.melody[1][0], null);
        // Repo slot 7 (mod 5 === 2, >= 5) sounds exactly an octave above repo slot 2.
        assert.equal(highDay.melody[0][0] - lowDay.melody[0][0], 12);
    });

    it('thins a busy 40-commit day to <= 4 notes per bar while preferring distinct repos', () => {
        // Pack 12 commits into bar 1 (morning window) across 6 distinct repos,
        // plus 28 more commits spread through the day (total 40).
        const events = [];
        for (let i = 0; i < 12; i++) {
            events.push({
                ts: makeDayTs(9, i * 4), // all within bar 1 (9:00..9:48 of 9:00..21:00)
                kind: 'commit',
                repoSlot: i < 6 ? i : 0,
            });
        }
        for (let i = 0; i < 28; i++) {
            const totalMin = 10 * 60 + Math.floor((i / 28) * (10.5 * 60));
            events.push({
                ts: makeDayTs(Math.floor(totalMin / 60), totalMin % 60),
                kind: 'commit',
                repoSlot: i % 8,
            });
        }

        const score = composeEvensong(events, { tonic: 'A', mode: 'minor' });
        assert.ok(score);
        assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });

        const lead = timeline(score.melody);
        const perBar = new Array(EVENSONG_DAY_BARS).fill(0);
        for (const n of lead) {
            if (n.start < EVENSONG_DAY_BARS * 4 - 1e-6) {
                perBar[Math.floor(n.start / 4)]++;
            }
        }
        assert.ok(perBar.every(c => c <= EVENSONG_MAX_NOTES_PER_BAR), `bar counts: ${perBar.join(',')}`);
        assert.equal(perBar[0], 4, 'dense bar 1 should thin to exactly 4 notes');

        // Verify bar 1 selected 4 distinct pitches (from distinct repos) rather than 4 repeats.
        const bar1Pitches = new Set(lead.filter(n => n.start < 4).map(n => n.pitch));
        assert.ok(bar1Pitches.size >= 3, `expected distinct repo pitches in bar 1, got ${bar1Pitches.size}`);
    });

    it('writes a V-I cadence in bass/chords and lands melody on 1 or 5 for a push', () => {
        // Minor keys push on the natural minor v (no raised leading tone).
        const cases = [
            { key: { tonic: 'A', mode: 'major' }, V: 'E', I: 'A' },
            { key: { tonic: 'D', mode: 'major' }, V: 'A', I: 'D' },
            { key: { tonic: 'E', mode: 'major' }, V: 'B', I: 'E' },
            { key: { tonic: 'A', mode: 'minor' }, V: 'Em', I: 'Am' },
            { key: { tonic: 'D', mode: 'minor' }, V: 'Am', I: 'Dm' },
            { key: { tonic: 'E', mode: 'minor' }, V: 'Bm', I: 'Em' },
        ];
        for (const { key, V, I } of cases) {
            const events = [
                { ts: makeDayTs(9, 0), kind: 'commit', repoSlot: 1 },
                { ts: makeDayTs(15, 0), kind: 'push', repoSlot: 2 },
                { ts: makeDayTs(19, 0), kind: 'commit', repoSlot: 3 },
            ];
            const score = composeEvensong(events, key);
            assert.ok(score);
            assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
            assert.equal(score.meta.pushBars.length, 1);

            const pushBar = score.meta.pushBars[0];
            assert.deepEqual(score.chords[pushBar], [V, I]);

            // Check bass has 2-beat V then 2-beat I in pushBar.
            const bassNotes = timeline(score.bass).filter(n => n.start >= pushBar * 4 && n.start < (pushBar + 1) * 4);
            assert.equal(bassNotes.length, 2);
            assert.equal(bassNotes[0].dur, 2);
            assert.equal(bassNotes[1].dur, 2);

            // Check melody pitch in pushBar lands on degree 1 or 5.
            const { tonicPc } = musicKey(key);
            const allowedPcs = new Set([tonicPc, mod12(tonicPc + 7)]);
            const pushMel = timeline(score.melody).filter(n => n.start >= pushBar * 4 && n.start < (pushBar + 1) * 4);
            assert.ok(pushMel.length >= 1);
            assert.ok(
                pushMel.some(n => allowedPcs.has(pcOfSemi(n.pitch))),
                `push melody in ${key.tonic} ${key.mode} must land on 1 or 5`,
            );
        }
    });

    it('writes a held fifth (1 and 5) for one full bar on a release', () => {
        const key = { tonic: 'A', mode: 'major' };
        const events = [
            { ts: makeDayTs(9, 0), kind: 'commit', repoSlot: 0 },
            { ts: makeDayTs(15, 0), kind: 'release', repoSlot: 1 },
            { ts: makeDayTs(19, 0), kind: 'commit', repoSlot: 2 },
        ];
        const score = composeEvensong(events, key);
        assert.ok(score);
        assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
        assert.equal(score.meta.releaseBars.length, 1);

        const relBar = score.meta.releaseBars[0];
        assert.equal(score.chords[relBar], tonicChord(key));

        const relMel = timeline(score.melody).filter(n => n.start >= relBar * 4 && n.start < (relBar + 1) * 4);
        const relBass = timeline(score.bass).filter(n => n.start >= relBar * 4 && n.start < (relBar + 1) * 4);
        const relHarm = timeline(score.releaseHarmony).filter(n => n.start >= relBar * 4 && n.start < (relBar + 1) * 4);

        assert.equal(relMel.length, 1);
        assert.equal(relMel[0].dur, 4);
        assert.equal(relBass.length, 1);
        assert.equal(relBass[0].dur, 4);
        assert.equal(relHarm.length, 1);
        assert.equal(relHarm[0].dur, 4);

        const { tonicPc } = musicKey(key);
        const fifthPc = mod12(tonicPc + 7);
        const pcs = new Set([pcOfSemi(relMel[0].pitch), pcOfSemi(relHarm[0].pitch)]);
        assert.ok(pcs.has(tonicPc) && pcs.has(fifthPc), 'release bar must hold both 1 and 5');
        assert.equal(pcOfSemi(relBass[0].pitch), tonicPc, 'release bass holds tonic 1');
    });

    it('closes with degree-2 suspension on open error vs cadenceKit plagal tag when mended', () => {
        const key = { tonic: 'E', mode: 'minor' };
        const base = [
            { ts: makeDayTs(9, 0), kind: 'commit', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(13, 0), kind: 'commit', repoSlot: 1, agentId: 'a2' },
            { ts: makeDayTs(17, 0), kind: 'errored', repoSlot: 1, agentId: 'a2' },
        ];

        // Open error at 21:00 -> degree-2 suspension, no tag.
        const openScore = composeEvensong(base, key);
        assert.ok(openScore);
        assert.deepEqual(validateEvensongGrammar(openScore), { ok: true, errors: [] });
        assert.equal(openScore.close.kind, 'suspension');
        assert.equal(openScore.close.openFailure, true);
        assert.equal(openScore.tag, null);
        assert.deepEqual(openScore.chords.slice(14), ['Em', 'Em']);

        const closeMel = timeline(openScore.melody).filter(n => n.start >= 56);
        assert.equal(closeMel.length, 1);
        assert.equal(closeMel[0].dur, 4);
        const { tonicPc } = musicKey(key);
        assert.equal(pcOfSemi(closeMel[0].pitch), mod12(tonicPc + 2), 'suspension holds scale degree 2');

        // Mended before 21:00 -> songbook plagal tag from cadenceKit(key, 4).tag.
        const mendedScore = composeEvensong([
            ...base,
            { ts: makeDayTs(18, 30), kind: 'mended', repoSlot: 1, agentId: 'a2' },
        ], key);
        assert.ok(mendedScore);
        assert.deepEqual(validateEvensongGrammar(mendedScore), { ok: true, errors: [] });
        assert.equal(mendedScore.close.kind, 'plagal');
        assert.equal(mendedScore.close.openFailure, false);

        const expectedTag = cadenceKit(key, 4).tag;
        assert.deepEqual(mendedScore.tag, expectedTag);
        assert.deepEqual(mendedScore.chords.slice(14), expectedTag.chords);

        // Two open errors, only one resolved -> still open failure.
        const partialMend = composeEvensong([
            ...base,
            { ts: makeDayTs(17, 30), kind: 'errored', repoSlot: 0, agentId: 'a1' },
            { ts: makeDayTs(18, 0), kind: 'resolved', repoSlot: 1, agentId: 'a2' },
        ], key);
        assert.equal(partialMend.close.kind, 'suspension');
        assert.equal(partialMend.tag, null);

        // Resolved then errored again -> open failure.
        const reErrored = composeEvensong([
            ...base,
            { ts: makeDayTs(18, 0), kind: 'resolved', repoSlot: 1, agentId: 'a2' },
            { ts: makeDayTs(19, 30), kind: 'errored', repoSlot: 1, agentId: 'a2' },
        ], key);
        assert.equal(reErrored.close.kind, 'suspension');
    });

    it('satisfies all invariants (0 quick same-pitch pairs, <=2 steps, <=4/bar, range) across 50 seeded varied days', () => {
        const allKeys = [...ALLOWED_KEYS.day, ...ALLOWED_KEYS.night];
        for (let seed = 1; seed <= 50; seed++) {
            const rand = makeSeededRng(seed * 7919 + 17);
            const key = allKeys[seed % allKeys.length];
            const eventCount = 1 + Math.floor(rand() * 48);
            const events = [];
            for (let i = 0; i < eventCount; i++) {
                const minuteOfDay = 8 * 60 + Math.floor(rand() * (12.9 * 60));
                const r = rand();
                const kind = r < 0.72 ? 'commit'
                    : r < 0.85 ? 'push'
                        : r < 0.90 ? 'release'
                            : r < 0.95 ? 'errored' : 'mended';
                events.push({
                    minuteOfDay,
                    kind,
                    repoSlot: Math.floor(rand() * 10),
                    agentSlot: Math.floor(rand() * 4),
                });
            }
            // Guarantee at least one verified commit so every seeded day composes.
            events.push({ minuteOfDay: 9 * 60 + (seed % 45), kind: 'commit', repoSlot: seed % 10, agentSlot: 0 });

            const score = composeEvensong(events, key);
            assert.ok(score, `seed ${seed} must produce a score`);
            const v = validateEvensongGrammar(score);
            assert.deepEqual(v, { ok: true, errors: [] }, `seed ${seed} (${key.tonic} ${key.mode}) failed: ${v.errors.join('; ')}`);

            // Cross-check directly with score-analyzer primitives.
            const lead = timeline(score.melody);
            const low = timeline(score.bass);
            assert.deepEqual(quickPairs(lead, 60 / score.bpm), [], `seed ${seed}: lead quickPairs`);
            assert.deepEqual(quickPairs(low, 60 / score.bpm), [], `seed ${seed}: bass quickPairs`);
            const lr = range(lead);
            assert.ok(lr.low >= RANGES.lead.low && lr.high <= RANGES.lead.high, `seed ${seed}: lead range`);
            const br = range(low);
            assert.ok(br.low >= RANGES.bass.low && br.high <= RANGES.bass.high, `seed ${seed}: bass range`);
        }

        // Stress test: 8 consecutive commits on the exact same repo inside one bar,
        // plus back-to-back pushes and a bar-14 final-eighth commit colliding with the tag.
        const stressEvents = [
            { minuteOfDay: 540, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 545, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 550, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 555, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 560, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 565, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 570, kind: 'push', repoSlot: 0 },
            { minuteOfDay: 575, kind: 'push', repoSlot: 0 },
            { minuteOfDay: 1258, kind: 'commit', repoSlot: 2 }, // right before bar 15
        ];
        for (const key of allKeys) {
            const score = composeEvensong(stressEvents, key);
            assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
        }
    });

    it('supports all day & night ALLOWED_KEYS and MusicalScale phaseKey inputs', () => {
        const events = [
            { minuteOfDay: 540, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 700, kind: 'commit', repoSlot: 3 },
            { minuteOfDay: 860, kind: 'commit', repoSlot: 6 },
            { minuteOfDay: 1020, kind: 'push', repoSlot: 1 },
            { minuteOfDay: 1140, kind: 'release', repoSlot: 4 },
        ];
        const expectedMajor = new Set([0, 2, 4, 7, 9]);
        const expectedMinor = new Set([0, 3, 5, 7, 10]);

        for (const key of [...ALLOWED_KEYS.day, ...ALLOWED_KEYS.night]) {
            const score = composeEvensong(events, key);
            assert.ok(score);
            assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
            const { tonicPc, mode } = musicKey(key);
            const expected = mode === 'minor' ? expectedMinor : expectedMajor;
            const dayNotes = timeline(score.melody).filter(n => n.start < EVENSONG_DAY_BARS * 4 - 1e-6);
            assert.ok(dayNotes.length >= 4);
            for (const n of dayNotes) {
                const rel = mod12(pcOfSemi(n.pitch) - tonicPc);
                assert.ok(expected.has(rel), `${key.tonic} ${key.mode}: pitch ${n.pitch} offset ${rel} not pentatonic`);
            }
        }

        // MusicalScale phaseKey objects (`{ tonicPc, mode }`) work directly.
        const dayPhaseScore = composeEvensong(events, phaseKey('day'));
        const nightPhaseScore = composeEvensong(events, phaseKey('night'));
        assert.equal(dayPhaseScore.key.mode, 'major');
        assert.equal(nightPhaseScore.key.mode, 'minor');
        assert.deepEqual(validateEvensongGrammar(dayPhaseScore), { ok: true, errors: [] });
        assert.deepEqual(validateEvensongGrammar(nightPhaseScore), { ok: true, errors: [] });
    });

    it('composes the 4-note fallback motto (first, busiest, last, cadence)', () => {
        const events = [
            { minuteOfDay: 540, kind: 'commit', repoSlot: 1 }, // first = 1
            { minuteOfDay: 600, kind: 'commit', repoSlot: 4 }, // busiest = 4 (3x)
            { minuteOfDay: 660, kind: 'commit', repoSlot: 4 },
            { minuteOfDay: 720, kind: 'commit', repoSlot: 4 },
            { minuteOfDay: 900, kind: 'commit', repoSlot: 7 }, // last = 7
        ];
        const key = { tonic: 'A', mode: 'major' };
        const motto = composeEvensongMotto(events, key);
        assert.ok(motto);
        assert.equal(motto.bars, 2);
        assert.equal(motto.bpm, EVENSONG_BPM);
        assert.deepEqual(motto.voices, EVENSONG_VOICES);
        assert.equal(motto.gainDb, EVENSONG_GAIN_DB);
        assert.equal(motto.percussion, null);
        assert.deepEqual(motto.mottoSlots, { first: 1, busiest: 4, last: 7 });
        assert.equal(totalBeats(motto.melody), 8);
        assert.equal(totalBeats(motto.bass), 8);

        const lead = timeline(motto.melody);
        assert.equal(lead.length, 4);
        assert.equal(pcOfSemi(lead[3].pitch), musicKey(key).tonicPc, 'mended motto closes on tonic 1');
        assert.deepEqual(quickPairs(lead, 60 / motto.bpm), []);

        // Open error motto closes on degree 2 suspension.
        const openMotto = composeEvensongMotto([
            ...events,
            { minuteOfDay: 1100, kind: 'errored', repoSlot: 4 },
        ], key);
        assert.equal(openMotto.close.kind, 'suspension');
        const openLead = timeline(openMotto.melody);
        assert.equal(openLead.length, 4);
        assert.equal(pcOfSemi(openLead[3].pitch), mod12(musicKey(key).tonicPc + 2));

        // Single-repo motto still avoids repeated pitches and stays in range.
        const singleMotto = composeEvensongMotto([{ minuteOfDay: 600, kind: 'commit', repoSlot: 0 }], key);
        const sLead = timeline(singleMotto.melody);
        assert.equal(sLead.length, 4);
        for (let i = 1; i < sLead.length; i++) {
            assert.notEqual(sLead[i].pitch, sLead[i - 1].pitch);
        }
        const scale = pentatonicScaleInRange(key);
        for (let i = 1; i < sLead.length; i++) {
            assert.ok(Math.abs(scale.indexOf(sLead[i].pitch) - scale.indexOf(sLead[i - 1].pitch)) <= EVENSONG_MAX_LEAP_STEPS);
        }
    });

    it('validateEvensongGrammar rejects broken invariants', () => {
        const valid = composeEvensong([{ minuteOfDay: 600, kind: 'commit', repoSlot: 0 }], { tonic: 'A', mode: 'minor' });
        assert.equal(validateEvensongGrammar(valid).ok, true);

        const clone = () => JSON.parse(JSON.stringify(valid));

        // 1. Quick same-pitch pair
        const badPair = clone();
        badPair.melody = [[0, 0.5], [0, 0.5], [null, 3], ...badPair.melody.slice(2)];
        assert.equal(validateEvensongGrammar(badPair).ok, false);

        // 2. Out-of-range lead note
        const badRange = clone();
        badRange.melody[0] = [19, 2];
        assert.equal(validateEvensongGrammar(badRange).ok, false);

        // 3. More than 4 notes in a day bar
        const badDensity = clone();
        badDensity.melody = [[-12, 0.5], [-9, 0.5], [-7, 0.5], [-5, 0.5], [-2, 0.5], [null, 1.5], ...badDensity.melody.slice(2)];
        assert.equal(validateEvensongGrammar(badDensity).ok, false);

        // 4. Leap > 2 scale steps
        const badLeap = clone();
        badLeap.melody = [[-12, 2], [7, 2], ...badLeap.melody.slice(2)];
        assert.equal(validateEvensongGrammar(badLeap).ok, false);

        // 5. Wrong total duration
        const badDur = clone();
        badDur.melody[0] = [badDur.melody[0][0], 1];
        assert.equal(validateEvensongGrammar(badDur).ok, false);

        // 6. Percussion voice or wrong gainDb
        const badPerc = clone();
        badPerc.voices = ['lead', 'bass', 'engine', 'percussion'];
        assert.equal(validateEvensongGrammar(badPerc).ok, false);

        const badGain = clone();
        badGain.gainDb = 0;
        assert.equal(validateEvensongGrammar(badGain).ok, false);
    });
});

describe('Evensong listening harness CSV privacy & artifacts', () => {
    it('redacts all repo names, agent names, and commit subjects from parsed events, score, PNG, and scorecard', () => {
        const secretRepoA = 'UltraSecretBankingLedger';
        const secretRepoB = 'ClassifiedPayrollVault';
        const secretAgent = 'AgentConfidentialZero';
        const secretSubject = 'rotate-production-master-keys';

        const csv = [
            'row_type,date,time,glyph,event,kind,agent,provider,project,reason,tool,waited_ms,metric,value',
            'summary,2026-05-15,,,,,,,,,,,Commits,3',
            `event,2026-05-15,09:15,◆,"${secretAgent} committed ${secretSubject} · ${secretRepoA}",commit,${secretAgent},claude,${secretRepoA},,,,,`,
            `event,2026-05-15,11:30,◆,"${secretAgent} committed update schema · ${secretRepoB}",commit,${secretAgent},claude,${secretRepoB},,,,,`,
            `event,2026-05-15,14:00,▲,"${secretAgent}'s push was rejected (origin main) · ${secretRepoA}",push,${secretAgent},claude,${secretRepoA},,,,,`,
            `event,2026-05-15,16:45,▲,"${secretAgent} pushed origin main · ${secretRepoB}",push,${secretAgent},claude,${secretRepoB},,,,,`,
        ].join('\r\n');

        const parsed = parseChronicleCsv(csv);
        assert.equal(parsed.repoCount, 2);
        assert.equal(parsed.events.length, 4);
        // Rejected push must be marked failed so it is excluded from verified pushes.
        assert.equal(parsed.events[2].outcome, 'failed');
        assert.equal(parsed.events[3].outcome, undefined);
        // Distinct repos got anonymous integer slots 0 and 1.
        assert.equal(parsed.events[0].repoSlot, 0);
        assert.equal(parsed.events[1].repoSlot, 1);

        const score = composeEvensong(parsed.events, { tonic: 'A', mode: 'minor' });
        assert.ok(score);
        assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
        assert.equal(score.meta.pushCount, 1, 'only the landed push counts as verified');

        const png = renderPianoRollPng(score, { dayLabel: 'DAY 01', lufsI: -34.0 });
        // Valid PNG signature + IHDR dimensions 960x360.
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 960);
        assert.equal(png.readUInt32BE(20), 360);

        const scorecard = buildScorecardMarkdown([{
            day: 'day-01',
            events: score.meta.verifiedEvents,
            notes: score.meta.noteCount,
            key: `${score.key.tonic} ${score.key.mode}`,
            close: score.close.kind,
            grammarOk: true,
            lufsI: -34.0,
            silent: false,
            status: 'PASS',
        }]);

        // Extract inflated PNG IDAT bytes as well as raw strings.
        let idatText = '';
        let off = 8;
        while (off + 8 <= png.length) {
            const len = png.readUInt32BE(off);
            const type = png.toString('ascii', off + 4, off + 8);
            if (type === 'IDAT') idatText = zlib.inflateSync(png.subarray(off + 8, off + 8 + len)).toString('latin1');
            off += 12 + len;
        }

        const serialized = [
            JSON.stringify(parsed),
            JSON.stringify(score),
            scorecard,
            png.toString('latin1'),
            idatText,
        ].join('\n');

        for (const secret of [secretRepoA, secretRepoB, secretAgent, secretSubject]) {
            assert.equal(serialized.includes(secret), false, `privacy leak detected: "${secret}"`);
        }

        // Scorecard has expected blank evaluation row.
        assert.match(scorecard, /\|\s*day-01\s*\|\s*3\s*\|\s*\d+\s*\|\s*\|\s*\|/);
    });

    it('generates 10 deterministic synthetic days that all pass Evensong grammar validation', () => {
        const days = generateSyntheticDays(10, 0x5eed);
        assert.equal(days.length, 10);
        for (const day of days) {
            const score = composeEvensong(day.events, { tonic: 'A', mode: 'minor' });
            assert.ok(score, `${day.id} must compose`);
            assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] }, `${day.id} grammar`);
        }
    });
});

describe('Evensong council fixes (W6 lane C)', () => {
    const timelineOf = notes => {
        const out = [];
        let at = 0;
        for (const [pitch, beats] of notes) {
            if (pitch != null) out.push({ start: at, dur: beats, pitch });
            at += beats;
        }
        return out;
    };

    it('closes an open error on mended, resolved, completed and departed, as the Chronicle Loom does', () => {
        assert.deepEqual([...EVENSONG_ERROR_CLOSING_KINDS], ['mended', 'resolved', 'completed', 'departed']);
        assert.deepEqual([...LOOM_ERROR_RESOLVING_KINDS].sort(), [...EVENSONG_ERROR_CLOSING_KINDS].sort(), 'the same four kinds as the Loom');

        const errored = { ts: makeDayTs(14, 0), kind: 'errored', agentId: 'a1', repo: 'r' };
        assert.equal(openErrorsAt([errored]).length, 1, 'an errored row opens');
        assert.equal(loomOpenErrorsAt([errored]).length, 1, 'Loom openErrorsAt matches');
        for (const kind of EVENSONG_ERROR_CLOSING_KINDS) {
            assert.deepEqual(openErrorsAt([errored, { ts: makeDayTs(15, 0), kind, agentId: 'a1' }]), [], `${kind} closes`);
            assert.equal(loomOpenErrorsAt([errored, { ts: makeDayTs(15, 0), kind, agentId: 'a1' }]).length, 0, `Loom ${kind} closes`);
            assert.equal(openErrorsAt([errored, { ts: makeDayTs(15, 0), kind, agentId: 'a2' }]).length, 1, `another agent's ${kind} does not`);
            assert.equal(openErrorsAt([errored, { ts: makeDayTs(15, 0), kind, agentId: 'a1' }], makeDayTs(14, 30)).length, 1, `${kind} after endTs is ignored`);
        }
        assert.deepEqual(openErrorsAt([{ ...errored, resolved: true }]), [], 'a row stamped resolved never opens');
        assert.deepEqual(openErrorsAt([{ ...errored, open: false }]), []);
        assert.deepEqual(openErrorsAt([errored, { ts: makeDayTs(13, 0), kind: 'departed', agentId: 'a1' }]).length, 1, 'order is chronological');
        assert.ok(Object.isFrozen(openErrorsAt([errored])), 'frozen');
        assert.ok(!JSON.stringify(openErrorsAt([errored])).includes('a1'), 'anonymous slots only');

        // The composer reads the same contract: a departure before 21:00
        // mends the day (plagal), a departure after it does not.
        const work = [{ ts: makeDayTs(10, 0), kind: 'commit', repo: 'r', agentId: 'a1' }, errored];
        assert.equal(composeEvensong([...work, { ts: makeDayTs(18, 0), kind: 'departed', agentId: 'a1' }], { tonic: 'A', mode: 'minor' }).close.kind, 'plagal');
        assert.equal(composeEvensong([...work, { ts: makeDayTs(18, 0), kind: 'completed', agentId: 'a1' }], { tonic: 'A', mode: 'minor' }).close.kind, 'plagal');
        assert.equal(composeEvensong([...work, { ts: makeDayTs(22, 0), kind: 'departed', agentId: 'a1' }], { tonic: 'A', mode: 'minor' }).close.kind, 'suspension');
    });

    it('sounds the held fifth on every release bar: the comp holds releaseHarmony under the lead', () => {
        for (const key of [{ tonic: 'A', mode: 'major' }, { tonic: 'A', mode: 'minor' }, { tonic: 'E', mode: 'minor' }]) {
            const score = composeEvensong([
                { ts: makeDayTs(9, 0), kind: 'commit', repoSlot: 0 },
                { ts: makeDayTs(12, 0), kind: 'release', repoSlot: 1 },
                { ts: makeDayTs(13, 0), kind: 'release', repoSlot: 2 },
                { ts: makeDayTs(19, 0), kind: 'commit', repoSlot: 2 },
            ], key);
            assert.ok(score.meta.releaseBars.length >= 1);
            const { events } = compileEvensongEvents(score);
            const beatSec = 60 / score.bpm;
            const { tonicPc } = musicKey(key);
            const fifth = new Set([tonicPc, mod12(tonicPc + 7)]);
            for (const bar of score.meta.releaseBars) {
                const t0 = bar * 4 * beatSec;
                const held = events.filter(ev => ev.seat === 'engine' && Math.abs(ev.t - t0) < 1e-6 && Math.abs(ev.dur - 4 * beatSec) < 1e-6);
                assert.equal(held.length, 1, `${key.tonic} ${key.mode} bar ${bar + 1}: one held comp tone`);
                assert.equal(held[0].vel, EVENSONG_RELEASE_HARMONY_VEL);
                const lead = events.find(ev => ev.seat === 'lead' && Math.abs(ev.t - t0) < 1e-6);
                const pcs = new Set([pcOfSemi(lead.semi), pcOfSemi(held[0].semi)]);
                assert.deepEqual(pcs, fifth, 'lead and comp sound degrees 1 and 5 together');
            }
        }
        // No release, no held tone.
        const plain = composeEvensong([{ ts: makeDayTs(9, 0), kind: 'commit', repoSlot: 0 }], { tonic: 'A', mode: 'minor' });
        const comp = compileEvensongEvents(plain).events.filter(ev => ev.vel === EVENSONG_RELEASE_HARMONY_VEL && ev.seat === 'engine');
        assert.equal(comp.length, 0);
    });

    it('pushes on the natural minor v with no melody semitone against it, and keeps the bar 14 → 15 leap in reach', () => {
        const allKeys = [...ALLOWED_KEYS.day, ...ALLOWED_KEYS.night];
        let pushBars = 0;
        let approaches = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const rand = makeSeededRng(seed * 104729 + 3);
            const key = allKeys[seed % allKeys.length];
            const events = [];
            const count = 2 + Math.floor(rand() * 56);
            for (let i = 0; i < count; i++) {
                const r = rand();
                events.push({
                    minuteOfDay: 8 * 60 + Math.floor(rand() * 13 * 60),
                    kind: r < 0.62 ? 'commit' : r < 0.86 ? 'push' : r < 0.92 ? 'release' : r < 0.96 ? 'errored' : 'mended',
                    repoSlot: Math.floor(rand() * 10),
                    agentSlot: Math.floor(rand() * 3),
                });
            }
            events.push({ minuteOfDay: 20 * 60 + 50, kind: seed % 2 ? 'push' : 'commit', repoSlot: seed % 10, agentSlot: 0 });
            const score = composeEvensong(events, key);
            const v = validateEvensongGrammar(score);
            assert.deepEqual(v, { ok: true, errors: [] }, `seed ${seed} (${key.tonic} ${key.mode}): ${v.errors.join('; ')}`);
            const lead = timelineOf(score.melody);
            const day = lead.filter(n => n.start < 56);
            const last = day[day.length - 1];
            if (last && Math.floor(last.start / 4) === 13) {
                approaches++;
                assert.ok(Math.abs(lead[day.length].pitch - last.pitch) <= EVENSONG_CLOSE_LEAP_SEMIS, `seed ${seed}: leap into the close`);
            }
            if (key.mode !== 'minor') continue;
            const { tonicPc } = musicKey(key);
            const v5 = mod12(tonicPc + 7);
            for (const bar of score.meta.pushBars) {
                pushBars++;
                const [vName, iName] = score.chords[bar];
                assert.equal(vName, `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'][v5]}m`, 'the natural minor v');
                assert.equal(iName, tonicChord(key));
                const vTones = [v5, mod12(v5 + 3), mod12(v5 + 7)];
                for (const n of lead.filter(n => n.start >= bar * 4 - 1e-9 && n.start < bar * 4 + 2 - 1e-9)) {
                    const pc = pcOfSemi(n.pitch);
                    assert.ok(!vTones.some(t => mod12(pc - t) === 1 || mod12(pc - t) === 11),
                        `seed ${seed} bar ${bar + 1}: ${pc} clashes with v`);
                }
            }
        }
        assert.ok(pushBars > 100, `${pushBars} minor push bars checked`);
        assert.ok(approaches > 100, `${approaches} bar-14 approaches checked`);
    });

    it('validateEvensongGrammar checks the step from bar 14 into the close', () => {
        const score = composeEvensong([
            { minuteOfDay: 9 * 60, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 20 * 60 + 50, kind: 'commit', repoSlot: 1 },
        ], { tonic: 'A', mode: 'minor' });
        assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
        const melody = score.melody.map(n => [...n]);
        // Bars 1–14 occupy beats 0..56; put a far note at the very end of bar 14.
        let at = 0;
        let lastIndex = -1;
        for (let i = 0; i < melody.length; i++) {
            if (at >= 52 && at < 56 && melody[i][0] != null) lastIndex = i;
            at += melody[i][1];
        }
        assert.ok(lastIndex >= 0, 'bar 14 holds a note');
        const closeFirst = timelineOf(score.melody).find(n => n.start >= 56).pitch;
        melody[lastIndex][0] = pentatonicScaleInRange(score.key).find(s => Math.abs(s - closeFirst) > EVENSONG_CLOSE_LEAP_SEMIS);
        const broken = validateEvensongGrammar({ ...score, melody });
        assert.equal(broken.ok, false);
        assert.ok(broken.errors.some(e => /from bar 14 into the close/.test(e)), broken.errors.join('; '));
    });

    it('the listening harness renders the live engine compiler, not a copy', () => {
        const harness = readFileSync(new URL('../audio/evensong-harness.mjs', import.meta.url), 'utf8');
        assert.doesNotMatch(harness, /function compileEvensongEvents/);
        assert.match(harness, /import \{ compileEvensongEvents \} from '..\/..\/claudeville\/src\/presentation\/shared\/audio\/bgm\/BandEngine\.js'/);
    });

    it('holds the minor suspension on degree 2 as its one non-pentatonic note', () => {
        const score = composeEvensong([
            { minuteOfDay: 9 * 60, kind: 'commit', repoSlot: 0 },
            { minuteOfDay: 17 * 60, kind: 'errored', agentSlot: 1 },
        ], { tonic: 'A', mode: 'minor' });
        assert.equal(score.close.kind, 'suspension');
        const close = timelineOf(score.melody).find(n => n.start >= 56);
        assert.equal(pcOfSemi(close.pitch), 11, 'B in A minor');
        assert.ok(!pentatonicScaleInRange(score.key).includes(close.pitch), 'outside the minor pentatonic by design');
        assert.deepEqual(validateEvensongGrammar(score), { ok: true, errors: [] });
    });
});
