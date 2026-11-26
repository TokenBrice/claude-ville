// Evensong (spec §5.5): a pure, deterministic evening tune composed at 21:00
// from the day's verified work. Zero randomness, zero wall-clock reads, zero
// repo strings retained in the score.
//
// Form: 16 bars of 4/4 at 72 bpm (~53.3 s). Bars 1–14 trace the day from its
// first verified commit/push/release to 21:00 across 112 eighth-note slots;
// bars 15–16 are the close (the songbook's plagal tag when everything is
// mended, or a held degree-2 suspension over the tonic when an error remains
// open at 21:00). Band: lead, bass and comp (`engine`) only, 3 dB under the
// normal Town band, no percussion.

import {
    ALLOWED_KEYS,
    CHORDS,
    RANGES,
    cadenceKit,
    chordPitchClasses,
    deepFreeze,
    musicKey,
    tonicChord,
} from './ScoreKit.js';

export const EVENSONG_BPM = 72;
export const EVENSONG_BEATS_PER_BAR = 4;
export const EVENSONG_BARS = 16;
export const EVENSONG_DAY_BARS = 14;
export const EVENSONG_SLOTS_PER_BAR = 8;
export const EVENSONG_TOTAL_SLOTS = EVENSONG_DAY_BARS * EVENSONG_SLOTS_PER_BAR; // 112
export const EVENSONG_MAX_NOTES_PER_BAR = 4;
export const EVENSONG_MAX_LEAP_STEPS = 2;
export const EVENSONG_GAIN_DB = -3;
export const EVENSONG_VOICES = Object.freeze(['lead', 'bass', 'engine']);

const EPS = 1e-6;
const QUICK_PAIR_SEC = 0.3; // ScoreKit / score-analyzer S1 threshold
const SHORT_NOTE_MAX_BEATS = 1;
const MIN_COMMIT_BEATS = 0.5;
const MAX_COMMIT_BEATS = 2;
const EVENSONG_END_HOUR = 21;
const EVENSONG_END_MINUTE = EVENSONG_END_HOUR * 60; // 1260

const PENTATONIC_STEPS = Object.freeze({
    major: Object.freeze([0, 2, 4, 7, 9]),
    minor: Object.freeze([0, 3, 5, 7, 10]),
});

const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']);
const NOTE_PC = Object.freeze({
    ...Object.fromEntries(NOTE_NAMES.map((name, pc) => [name, pc])),
    'A#': 10,
    Db: 1,
    Eb: 3,
    Gb: 6,
    Ab: 8,
});

const VERIFIED_KINDS = new Set(['commit', 'push', 'release']);
const FAILED_PUSH_OUTCOMES = new Set(['rejected', 'failed', 'cancelled', 'canceled', 'error']);
const KIND_PRIORITY = Object.freeze({ release: 3, push: 2, commit: 1 });

const mod12 = n => ((n % 12) + 12) % 12;
const pcOfSemi = semi => mod12(9 + semi); // semitones from A4 → pitch class (C = 0)

function transposeChordName(name, shift) {
    const match = /^([A-G][#b]?)(.*)$/.exec(name);
    if (!match) return null;
    const [, root, suffix] = match;
    const moved = `${NOTE_NAMES[mod12(NOTE_PC[root] + shift)]}${suffix}`;
    return CHORDS[moved] ? moved : null;
}

/**
 * Normalize a key input from ScoreKit `{ tonic, mode }`, MusicalScale
 * `phaseKey` `{ tonicPc, mode }`, or a phase name (`'day'|'night'|...`) into
 * a canonical `{ tonic, mode }` accepted by `ScoreKit`.
 */
export function normalizeEvensongKey(key) {
    if (typeof key === 'string') {
        const lower = key.toLowerCase();
        return lower === 'night'
            ? { tonic: 'A', mode: 'minor' }
            : { tonic: 'A', mode: 'major' };
    }
    if (key && typeof key === 'object') {
        const mode = key.mode === 'minor' ? 'minor' : 'major';
        if (typeof key.tonic === 'string' && NOTE_PC[key.tonic] != null) {
            return { tonic: key.tonic, mode };
        }
        if (Number.isFinite(Number(key.tonicPc))) {
            const pc = mod12(Math.round(Number(key.tonicPc)));
            return { tonic: NOTE_NAMES[pc], mode };
        }
    }
    return { tonic: 'A', mode: 'minor' };
}

/**
 * All pentatonic pitches (semitones from A4) for `key` inside the lead
 * voice's playable range (`RANGES.lead`), sorted ascending.
 */
export function pentatonicScaleInRange(key) {
    const norm = normalizeEvensongKey(key);
    const { tonicPc, mode } = musicKey(norm);
    const steps = PENTATONIC_STEPS[mode];
    const pcs = new Set(steps.map(step => mod12(tonicPc + step)));
    const low = RANGES.lead.low;
    const high = mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high;
    const scale = [];
    for (let semi = low; semi <= high; semi++) {
        if (pcs.has(pcOfSemi(semi))) scale.push(semi);
    }
    return scale;
}

function pentatonicDegreeOf(semi, key) {
    const norm = normalizeEvensongKey(key);
    const { tonicPc, mode } = musicKey(norm);
    const offset = mod12(pcOfSemi(semi) - tonicPc);
    return PENTATONIC_STEPS[mode].indexOf(offset);
}

// Map (degree 0..4, highOctave boolean) → semitone inside RANGES.lead.
// Every pitch class appears at least once in [-12..-1] and once in [0..11],
// so repos 6..10 always sound cleanly an octave (+12) above repos 1..5.
function slotTargetSemi(key, degree, highOctave) {
    const norm = normalizeEvensongKey(key);
    const { tonicPc, mode } = musicKey(norm);
    const targetPc = mod12(tonicPc + PENTATONIC_STEPS[mode][((degree % 5) + 5) % 5]);
    const highLimit = mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high;
    let lowSemi = RANGES.lead.low;
    while (pcOfSemi(lowSemi) !== targetPc) lowSemi++;
    if (highOctave && lowSemi + 12 <= highLimit) return lowSemi + 12;
    return lowSemi;
}

function keyChords(key) {
    const norm = normalizeEvensongKey(key);
    const { tonicPc, mode } = musicKey(norm);
    const shift = mod12(tonicPc - 9);
    const I = tonicChord(norm);
    const V = transposeChordName('E', shift) || I;
    if (mode === 'minor') {
        const iv = transposeChordName('Dm', shift) || I;
        const VI = transposeChordName('F', shift) || I;
        const VII = transposeChordName('G', shift) || I;
        const III = transposeChordName('C', shift) || I;
        return { I, IV: iv, V, palette: [I, VI, iv, III, VII] };
    }
    const IV = transposeChordName('D', shift) || I;
    const vi = transposeChordName('F#m', shift) || I;
    const ii = transposeChordName('Bm', shift) || I;
    return { I, IV, V, palette: [I, IV, vi, ii] };
}

function rootBassFor(chordName) {
    const voicing = CHORDS[chordName];
    if (!voicing) return -24;
    let semi = voicing[0];
    while (semi > -17) semi -= 12;
    while (semi < RANGES.bass.low) semi += 12;
    if (semi > RANGES.bass.high) semi -= 12;
    return semi;
}

function chordBassOptions(chordName) {
    const voicing = CHORDS[chordName];
    if (!voicing) return [-24];
    const pcs = [...new Set(voicing.map(pcOfSemi))];
    const out = [];
    for (let s = RANGES.bass.low; s <= Math.min(RANGES.bass.high, -12); s++) {
        if (pcs.includes(pcOfSemi(s))) out.push(s);
    }
    return out.length ? out : [rootBassFor(chordName)];
}

function parseClockMinutes(value) {
    if (typeof value !== 'string') return null;
    const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(value);
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    const ss = match[3] != null ? Number(match[3]) : 0;
    if (hh < 0 || hh > 24 || mm < 0 || mm >= 60 || ss < 0 || ss >= 60) return null;
    return hh * 60 + mm + ss / 60;
}

function extractEventTime(ev) {
    if (ev == null || typeof ev !== 'object') return null;
    if (Number.isFinite(Number(ev.minuteOfDay))) {
        return { unit: 'minute', value: Number(ev.minuteOfDay) };
    }
    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) {
        return { unit: 'ms', value: ev.ts };
    }
    if (typeof ev.ts === 'string' && ev.ts.trim()) {
        const numeric = Number(ev.ts);
        if (Number.isFinite(numeric)) return { unit: 'ms', value: numeric };
        const parsed = Date.parse(ev.ts);
        if (Number.isFinite(parsed)) return { unit: 'ms', value: parsed };
    }
    if (ev.timestamp != null && Number.isFinite(Number(ev.timestamp))) {
        return { unit: 'ms', value: Number(ev.timestamp) };
    }
    if (typeof ev.time === 'string') {
        const mins = parseClockMinutes(ev.time);
        if (mins != null) return { unit: 'minute', value: mins };
    }
    return null;
}

function normalizeKind(ev) {
    return String(ev?.kind ?? ev?.type ?? '').trim().toLowerCase();
}

function isVerifiedWorkEvent(ev, kind) {
    if (!VERIFIED_KINDS.has(kind)) return false;
    if (ev?.verified === false) return false;
    if (kind === 'push') {
        const outcome = String(ev?.outcome ?? '').trim().toLowerCase();
        if (outcome && FAILED_PUSH_OUTCOMES.has(outcome)) return false;
    }
    return true;
}

function explicitSlot(ev) {
    for (const field of ['repoSlot', 'pennantSlot', 'pennantIndex', 'slot']) {
        if (ev?.[field] != null && ev[field] !== '') {
            const n = Number(ev[field]);
            if (Number.isInteger(n) && n >= 0) return n;
        }
    }
    return null;
}

function rawRepoIdentifier(ev) {
    for (const field of ['repo', 'project', 'repoRoot', 'projectPath']) {
        const v = ev?.[field];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

function rawAgentIdentifier(ev) {
    for (const field of ['agentSlot', 'agentId', 'agentName', 'agent']) {
        const v = ev?.[field];
        if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
}

/**
 * Pure event ingestion: sorts chronologically, assigns anonymous integer
 * `repoSlot` and `agentSlot` values in deterministic first-seen order, and
 * retains ZERO repo/agent strings.
 */
function ingestDayEvents(dayEvents) {
    if (!Array.isArray(dayEvents) || !dayEvents.length) return [];
    const staged = [];
    for (let i = 0; i < dayEvents.length; i++) {
        const ev = dayEvents[i];
        if (!ev || typeof ev !== 'object') continue;
        const kind = normalizeKind(ev);
        if (!kind) continue;
        const time = extractEventTime(ev);
        staged.push({
            index: i,
            kind,
            verified: isVerifiedWorkEvent(ev, kind),
            time,
            explicitRepoSlot: explicitSlot(ev),
            rawRepo: rawRepoIdentifier(ev),
            rawAgent: rawAgentIdentifier(ev),
        });
    }
    staged.sort((a, b) => {
        const ta = a.time ? a.time.value : 0;
        const tb = b.time ? b.time.value : 0;
        if (ta !== tb) return ta - tb;
        return a.index - b.index;
    });

    // Assign anonymous repo slots in chronological first-seen order without
    // colliding with any explicitly supplied numeric slots.
    const usedExplicit = new Set(staged.map(e => e.explicitRepoSlot).filter(s => s != null));
    const repoMap = new Map();
    let nextAutoSlot = 0;
    const allocSlot = () => {
        while (usedExplicit.has(nextAutoSlot)) nextAutoSlot++;
        return nextAutoSlot++;
    };
    const agentMap = new Map();
    let nextAgentSlot = 0;

    return staged.map(item => {
        let repoSlot = item.explicitRepoSlot;
        if (repoSlot == null) {
            if (item.rawRepo != null) {
                if (!repoMap.has(item.rawRepo)) repoMap.set(item.rawRepo, allocSlot());
                repoSlot = repoMap.get(item.rawRepo);
            } else {
                repoSlot = 0;
            }
        }
        let agentSlot = null;
        if (item.rawAgent != null) {
            if (!agentMap.has(item.rawAgent)) agentMap.set(item.rawAgent, nextAgentSlot++);
            agentSlot = agentMap.get(item.rawAgent);
        }
        return {
            index: item.index,
            kind: item.kind,
            verified: item.verified,
            time: item.time,
            repoSlot,
            agentSlot,
        };
    });
}

function computeTimeBounds(verifiedEvents) {
    const timed = verifiedEvents.filter(e => e.time != null);
    if (!timed.length) return { unit: 'index', start: 0, end: Math.max(1, verifiedEvents.length - 1) };
    const unit = timed[0].time.unit;
    const vals = timed.filter(e => e.time.unit === unit).map(e => e.time.value);
    const first = Math.min(...vals);
    const last = Math.max(...vals);
    if (unit === 'minute') {
        const end = EVENSONG_END_MINUTE > first ? EVENSONG_END_MINUTE : Math.max(last, first);
        return { unit, start: first, end };
    }
    // `ms`: compute 21:00 local time on the day of `first` (never reads wall clock).
    const anchor = new Date(first);
    anchor.setHours(EVENSONG_END_HOUR, 0, 0, 0);
    const endOfDay = anchor.getTime();
    const end = endOfDay > first ? endOfDay : Math.max(last, first);
    return { unit, start: first, end };
}

function eventToSlot(ev, indexInVerified, totalVerified, bounds) {
    if (bounds.unit === 'index') {
        if (totalVerified <= 1) return 0;
        const frac = indexInVerified / (totalVerified - 1);
        return Math.min(EVENSONG_TOTAL_SLOTS - 1, Math.floor(frac * EVENSONG_TOTAL_SLOTS));
    }
    if (!ev.time || ev.time.unit !== bounds.unit) return 0;
    const span = bounds.end - bounds.start;
    if (!(span > 0)) return 0;
    const frac = Math.max(0, Math.min(1, (ev.time.value - bounds.start) / span));
    return Math.min(EVENSONG_TOTAL_SLOTS - 1, Math.floor(frac * EVENSONG_TOTAL_SLOTS));
}

function hasOpenFailureAtEvensong(ingested, bounds) {
    const open = [];
    for (const ev of ingested) {
        if (bounds.unit !== 'index' && ev.time && ev.time.unit === bounds.unit && ev.time.value > bounds.end + EPS) {
            continue;
        }
        if (ev.kind === 'errored') {
            open.push({ agentSlot: ev.agentSlot, repoSlot: ev.repoSlot });
        } else if (ev.kind === 'mended' || ev.kind === 'resolved') {
            if (ev.agentSlot != null) {
                let matched = false;
                for (let i = open.length - 1; i >= 0; i--) {
                    if (open[i].agentSlot === ev.agentSlot) {
                        open.splice(i, 1);
                        matched = true;
                    }
                }
                if (!matched) {
                    for (let i = open.length - 1; i >= 0; i--) {
                        if (open[i].repoSlot === ev.repoSlot) open.splice(i, 1);
                    }
                }
            } else if (ev.repoSlot != null) {
                let matched = false;
                for (let i = open.length - 1; i >= 0; i--) {
                    if (open[i].repoSlot === ev.repoSlot) {
                        open.splice(i, 1);
                        matched = true;
                    }
                }
                if (!matched && open.length) open.length = 0;
            } else {
                open.length = 0;
            }
        }
    }
    return open.length > 0;
}

// Thin one bar's slot-deduped events to at most EVENSONG_MAX_NOTES_PER_BAR (4),
// keeping pushes first, preferring distinct repos, and maximizing rhythmic spacing.
function thinBarCandidates(candidates) {
    if (candidates.length <= EVENSONG_MAX_NOTES_PER_BAR) {
        return [...candidates].sort((a, b) => a.pos - b.pos);
    }
    const remaining = [...candidates].sort((a, b) => a.pos - b.pos);
    const chosen = [];
    const chosenRepos = new Set();

    const pickBest = (pool) => {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i];
            const minGap = chosen.length
                ? Math.min(...chosen.map(x => Math.abs(x.pos - c.pos)))
                : (c.pos === 0 ? 10 : 8 - c.pos);
            const score = minGap * 100 - c.pos;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        return pool[bestIdx];
    };

    // Priority 1: pushes (prefer distinct repos, then spacing).
    while (chosen.length < EVENSONG_MAX_NOTES_PER_BAR) {
        const pushes = remaining.filter(c => c.kind === 'push');
        if (!pushes.length) break;
        const fresh = pushes.filter(c => !chosenRepos.has(c.repoSlot));
        const picked = pickBest(fresh.length ? fresh : pushes);
        chosen.push(picked);
        chosenRepos.add(picked.repoSlot);
        remaining.splice(remaining.indexOf(picked), 1);
    }

    // Priority 2: remaining events, preferring distinct repos, then widest spacing.
    while (chosen.length < EVENSONG_MAX_NOTES_PER_BAR && remaining.length) {
        const fresh = remaining.filter(c => !chosenRepos.has(c.repoSlot));
        const picked = pickBest(fresh.length ? fresh : remaining);
        chosen.push(picked);
        chosenRepos.add(picked.repoSlot);
        remaining.splice(remaining.indexOf(picked), 1);
    }

    return chosen.sort((a, b) => a.pos - b.pos);
}

// Quick same-pitch pair predicate: covers BOTH ScoreKit's 0.3 s threshold AND
// Evensong's stricter rule forbidding consecutive same-pitch notes separated
// by <= 1 beat or where both notes are short (<= 1 beat).
function isForbiddenSamePitchPair(prev, cur, bpm = EVENSONG_BPM) {
    if (!prev || prev.pitch !== cur.pitch) return false;
    const ioiBeats = cur.start - prev.start;
    const beatSec = 60 / bpm;
    if (ioiBeats * beatSec < QUICK_PAIR_SEC - EPS) return true;
    if (ioiBeats <= SHORT_NOTE_MAX_BEATS + EPS) return true;
    if (prev.dur <= SHORT_NOTE_MAX_BEATS + EPS && cur.dur <= SHORT_NOTE_MAX_BEATS + EPS) return true;
    return false;
}

function foldIndexToward(scale, rawIdx, prevIdx) {
    if (prevIdx == null) return rawIdx;
    const targetPc = pcOfSemi(scale[rawIdx]);
    const samePc = [];
    for (let i = 0; i < scale.length; i++) {
        if (pcOfSemi(scale[i]) === targetPc) samePc.push(i);
    }
    const center = (scale.length - 1) / 2;
    let best = samePc[0];
    let bestDist = Infinity;
    for (const idx of samePc) {
        const d = Math.abs(idx - prevIdx);
        const better = d < bestDist
            || (d === bestDist && Math.abs(idx - rawIdx) < Math.abs(best - rawIdx))
            || (d === bestDist && Math.abs(idx - rawIdx) === Math.abs(best - rawIdx)
                && Math.abs(idx - center) < Math.abs(best - center));
        if (better) {
            best = idx;
            bestDist = d;
        }
    }
    if (bestDist <= EVENSONG_MAX_LEAP_STEPS) return best;
    const dir = Math.sign(best - prevIdx) || (prevIdx < center ? 1 : -1);
    return Math.max(0, Math.min(scale.length - 1, prevIdx + dir * EVENSONG_MAX_LEAP_STEPS));
}

function indicesForDegrees(scale, key, degrees) {
    const allowed = new Set(degrees);
    const out = [];
    for (let i = 0; i < scale.length; i++) {
        if (allowed.has(pentatonicDegreeOf(scale[i], key))) out.push(i);
    }
    return out;
}

function pickSpecialIndex(scale, key, degrees, preferredDegree, prevNote, curStart, curDur, preferredOctaveHigh, avoidIndices = null) {
    const candidates = indicesForDegrees(scale, key, degrees);
    const prevIdx = prevNote ? prevNote.scaleIdx : null;
    const center = preferredOctaveHigh ? Math.floor(scale.length * 0.65) : Math.floor(scale.length * 0.35);

    const eligible = candidates.filter(idx => {
        if (prevIdx != null && Math.abs(idx - prevIdx) > EVENSONG_MAX_LEAP_STEPS) return false;
        if (prevNote && isForbiddenSamePitchPair(prevNote, { pitch: scale[idx], start: curStart, dur: curDur })) {
            return false;
        }
        return true;
    });

    const preferred = avoidIndices && avoidIndices.size
        ? eligible.filter(idx => !avoidIndices.has(idx))
        : eligible;

    const pool = preferred.length
        ? preferred
        : eligible.length
            ? eligible
            : candidates.filter(idx => prevIdx == null || Math.abs(idx - prevIdx) <= EVENSONG_MAX_LEAP_STEPS);

    const finalPool = pool.length ? pool : candidates;
    let best = finalPool[0];
    let bestScore = Infinity;
    for (const idx of finalPool) {
        const deg = pentatonicDegreeOf(scale[idx], key);
        const prefPenalty = deg === preferredDegree ? 0 : 0.6;
        const distPenalty = prevIdx != null ? Math.abs(idx - prevIdx) * 0.35 : Math.abs(idx - center) * 0.25;
        const centerPenalty = Math.abs(idx - center) * 0.05;
        const score = prefPenalty + distPenalty + centerPenalty;
        if (score < bestScore - EPS) {
            bestScore = score;
            best = idx;
        }
    }
    return best;
}

function checkParallelsBetween(upperPrev, upperCur, lowerPrev, lowerCur) {
    if (upperPrev == null || upperCur == null || lowerPrev == null || lowerCur == null) return false;
    if (mod12(upperCur) === mod12(upperPrev) || mod12(lowerCur) === mod12(lowerPrev)) return false;
    const prevCls = mod12(upperPrev - lowerPrev);
    const curCls = mod12(upperCur - lowerCur);
    return (curCls === 0 || curCls === 7) && curCls === prevCls;
}

function pickCommitBarHarmony(barNotes, palette, prevChord, prevBass, prevMelAtBass, barIndex) {
    const melPcs = barNotes.map(n => pcOfSemi(n.semi));
    const downbeatMel = barNotes[0]?.semi ?? null;
    const CLASH = new Set([1, 6, 11]);

    // Prefer tonic on opening bar and bar 14 (pre-close) when consonant.
    let bestChord = palette[0];
    let bestScore = -Infinity;
    for (let i = 0; i < palette.length; i++) {
        const name = palette[i];
        const info = chordPitchClasses(name);
        if (!info) continue;
        let score = 0;
        for (const pc of melPcs) {
            if (info.pcs.includes(pc)) score += 3;
            if (info.pcs.some(tone => CLASH.has(mod12(pc - tone)))) score -= 4;
        }
        if (downbeatMel != null && info.pcs.includes(pcOfSemi(downbeatMel))) score += 2;
        if (name === prevChord) score -= 1.8;
        if ((barIndex === 0 || barIndex === EVENSONG_DAY_BARS - 1) && i === 0) score += 2.5;
        if (!melPcs.length) {
            // Gentle contemplative cycle during resting bars.
            const restTarget = palette[barIndex % palette.length];
            if (name === restTarget) score += 2;
        }
        if (score > bestScore + EPS) {
            bestScore = score;
            bestChord = name;
        }
    }

    // Pick a gentle two-half-note bass line ([root, 2], [companion, 2]) in
    // RANGES.bass avoiding parallel fifths/octaves and same-pitch repeats.
    const root = rootBassFor(bestChord);
    const options = [root, ...chordBassOptions(bestChord).filter(s => s !== root)];
    let firstBass = root;
    for (const cand of options) {
        if (downbeatMel != null && cand > downbeatMel) continue;
        if (checkParallelsBetween(prevMelAtBass, downbeatMel, prevBass, cand)) continue;
        firstBass = cand;
        break;
    }
    const midMel = barNotes.find(n => n.start % EVENSONG_BEATS_PER_BAR >= 2 - EPS)?.semi ?? downbeatMel;
    const secondOptions = options
        .filter(s => s !== firstBass)
        .sort((a, b) => Math.abs(a - firstBass) - Math.abs(b - firstBass));
    let secondBass = secondOptions[0] ?? firstBass;
    for (const cand of secondOptions) {
        if (midMel != null && cand > midMel) continue;
        if (checkParallelsBetween(downbeatMel, midMel, firstBass, cand)) continue;
        secondBass = cand;
        break;
    }
    return { chord: bestChord, bassNotes: [[firstBass, 2], [secondBass, 2]], lastBass: secondBass };
}

function buildClose(normKey, hasOpenFailure, lastDayNote) {
    const tonic = tonicChord(normKey);
    const tonicBass = rootBassFor(tonic);
    if (hasOpenFailure) {
        // Suspension: scale degree 2 (+2 semitones above tonic) held over the
        // tonic for bar 15, letting it hang unresolved into bar 16. No tag.
        const { tonicPc, mode } = musicKey(normKey);
        const deg2Pc = mod12(tonicPc + 2);
        const high = mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high;
        const candidates = [];
        for (let s = RANGES.lead.low; s <= high; s++) {
            if (pcOfSemi(s) === deg2Pc) candidates.push(s);
        }
        const ref = lastDayNote ? lastDayNote.pitch : 0;
        let deg2Semi = candidates[0];
        let bestDist = Infinity;
        for (const s of candidates) {
            const d = Math.abs(s - ref);
            if (d < bestDist || (d === bestDist && Math.abs(s) < Math.abs(deg2Semi))) {
                bestDist = d;
                deg2Semi = s;
            }
        }
        return {
            kind: 'suspension',
            chords: [tonic, tonic],
            melody: [[deg2Semi, 4], [null, 4]],
            bass: [[tonicBass, 4], [tonicBass, 4]],
            tag: null,
            ritard: 1,
            firstSemi: deg2Semi,
        };
    }

    const { tag } = cadenceKit(normKey, EVENSONG_BEATS_PER_BAR);
    return {
        kind: 'plagal',
        chords: tag.chords.map(entry => (Array.isArray(entry) ? [...entry] : entry)),
        melody: tag.melody.map(note => [...note]),
        bass: tag.bass.map(note => [...note]),
        tag,
        ritard: tag.ritard ?? 1.15,
        firstSemi: tag.melody.find(([semi]) => semi != null)?.[0] ?? null,
    };
}

/**
 * Pure, deterministic Evensong composer (spec §5.5).
 * Returns `null` when the day has no verified commit, push, or release event.
 */
export function composeEvensong(dayEvents, key = { tonic: 'A', mode: 'minor' }) {
    const ingested = ingestDayEvents(dayEvents);
    const verified = ingested.filter(e => e.verified);
    if (!verified.length) return null;

    const normKey = normalizeEvensongKey(key);
    const family = normKey.mode === 'minor' ? 'night' : 'day';
    const scale = pentatonicScaleInRange(normKey);
    const bounds = computeTimeBounds(verified);
    const openFailure = hasOpenFailureAtEvensong(ingested, bounds);
    const harmonyPalette = keyChords(normKey);

    // 1. Place verified events onto the 112 eighth-note slots (bars 0..13),
    //    keeping at most one event per slot (release > push > commit).
    const barSlots = Array.from({ length: EVENSONG_DAY_BARS }, () => new Map());
    const releaseByBar = new Map();
    const distinctRepos = new Set();
    let commitCount = 0;
    let pushCount = 0;
    let releaseCount = 0;

    verified.forEach((ev, idx) => {
        distinctRepos.add(ev.repoSlot);
        if (ev.kind === 'commit') commitCount++;
        else if (ev.kind === 'push') pushCount++;
        else if (ev.kind === 'release') releaseCount++;

        const slot = eventToSlot(ev, idx, verified.length, bounds);
        const bar = Math.floor(slot / EVENSONG_SLOTS_PER_BAR);
        const pos = slot % EVENSONG_SLOTS_PER_BAR;

        if (ev.kind === 'release') {
            if (!releaseByBar.has(bar)) releaseByBar.set(bar, { bar, pos: 0, kind: 'release', repoSlot: ev.repoSlot });
            return;
        }
        const existing = barSlots[bar].get(pos);
        if (!existing || KIND_PRIORITY[ev.kind] > KIND_PRIORITY[existing.kind]) {
            barSlots[bar].set(pos, { bar, pos, kind: ev.kind, repoSlot: ev.repoSlot });
        }
    });

    // 2. Thin each non-release bar to <= 4 notes, preferring distinct repos,
    //    and compute exact durations (0.5..2 beats for commits/pushes, 4 beats
    //    for releases) before assigning pitches sequentially.
    const plannedBars = [];
    const flatNotes = [];

    for (let bar = 0; bar < EVENSONG_DAY_BARS; bar++) {
        if (releaseByBar.has(bar)) {
            const rel = releaseByBar.get(bar);
            const note = {
                bar,
                pos: 0,
                start: bar * EVENSONG_BEATS_PER_BAR,
                dur: EVENSONG_BEATS_PER_BAR,
                kind: 'release',
                repoSlot: rel.repoSlot,
                semi: null,
                scaleIdx: null,
            };
            plannedBars.push({ bar, kind: 'release', notes: [note] });
            flatNotes.push(note);
            continue;
        }

        const selected = thinBarCandidates([...barSlots[bar].values()]);
        const notes = [];
        for (let i = 0; i < selected.length; i++) {
            const ev = selected[i];
            const nextBoundary = i + 1 < selected.length ? selected[i + 1].pos : EVENSONG_SLOTS_PER_BAR;
            const availSlots = Math.max(1, nextBoundary - ev.pos);
            const durSlots = Math.min(MAX_COMMIT_BEATS * 2, Math.max(MIN_COMMIT_BEATS * 2, availSlots));
            const note = {
                bar,
                pos: ev.pos,
                start: bar * EVENSONG_BEATS_PER_BAR + ev.pos * 0.5,
                dur: durSlots * 0.5,
                kind: ev.kind,
                repoSlot: ev.repoSlot,
                semi: null,
                scaleIdx: null,
            };
            notes.push(note);
            flatNotes.push(note);
        }
        const barKind = notes.some(n => n.kind === 'push') ? 'push' : (notes.length ? 'commit' : 'rest');
        plannedBars.push({ bar, kind: barKind, notes });
    }

    // Determine close first pitch early so the very end of bar 14 never forms
    // a quick same-pitch pair into bar 15 (for either plagal tag or suspension).
    const plagalFirstSemi = openFailure
        ? null
        : (cadenceKit(normKey, EVENSONG_BEATS_PER_BAR).tag.melody.find(([s]) => s != null)?.[0] ?? null);
    const { tonicPc: closeTonicPc } = musicKey(normKey);
    const suspensionPc = mod12(closeTonicPc + 2);

    // 3. Assign pitches sequentially with leap folding (<= 2 scale steps) and
    //    zero forbidden quick same-pitch pairs.
    const tonicFifthIndices = indicesForDegrees(scale, normKey, [0, 3]);
    // Boundary indices whose only {1, 5} within <= 2 steps is themselves: avoid
    // landing on them right before another push/release so it always has a fresh {1, 5}.
    const trappedSpecialIndices = new Set(
        tonicFifthIndices.filter(idx => !tonicFifthIndices.some(other => other !== idx && Math.abs(other - idx) <= EVENSONG_MAX_LEAP_STEPS)),
    );
    let prevNote = null;

    for (let i = 0; i < flatNotes.length; i++) {
        const cur = flatNotes[i];
        const next = flatNotes[i + 1] ?? null;
        const nextIsSpecial = Boolean(next && (next.kind === 'push' || next.kind === 'release'));
        const highOctave = ((cur.repoSlot % 10) + 10) % 10 >= 5;
        let idx;

        if (cur.kind === 'release') {
            // Held fifth: prefer scale degree 5 in melody (over tonic 1 in bass),
            // alternating to degree 1 if consecutive releases or boundary needs it.
            const prefer = prevNote && pentatonicDegreeOf(prevNote.pitch, normKey) === 3 ? 0 : 3;
            idx = pickSpecialIndex(
                scale, normKey, [0, 3], prefer, prevNote, cur.start, cur.dur, highOctave,
                nextIsSpecial ? trappedSpecialIndices : null,
            );
            if (prevNote && isForbiddenSamePitchPair(prevNote, { pitch: scale[idx], start: cur.start, dur: cur.dur })) {
                idx = idx + 1 < scale.length ? idx + 1 : idx - 1;
            }
        } else if (cur.kind === 'push') {
            // Push: melody lands on degree 1 (beats 2..4 over I) or degree 5
            // (beats 0..2 over V, consonant with both V and I).
            const prefer = cur.pos < 4 ? 3 : 0;
            idx = pickSpecialIndex(
                scale, normKey, [0, 3], prefer, prevNote, cur.start, cur.dur, highOctave,
                nextIsSpecial ? trappedSpecialIndices : null,
            );
            // Absolute S1 safety guard if an extreme boundary left no non-repeating {1, 5}.
            if (prevNote && isForbiddenSamePitchPair(prevNote, { pitch: scale[idx], start: cur.start, dur: cur.dur })) {
                idx = idx + 1 < scale.length ? idx + 1 : idx - 1;
            }
        } else {
            const degree = ((cur.repoSlot % 5) + 5) % 5;
            const targetSemi = slotTargetSemi(normKey, degree, highOctave);
            const rawIdx = scale.indexOf(targetSemi);
            idx = foldIndexToward(scale, rawIdx, prevNote ? prevNote.scaleIdx : null);

            // Prevent forbidden quick same-pitch pair: move up one pentatonic
            // step (or down one step if at top of range).
            if (prevNote && isForbiddenSamePitchPair(prevNote, { pitch: scale[idx], start: cur.start, dur: cur.dur })) {
                idx = idx + 1 < scale.length ? idx + 1 : idx - 1;
            }

            // Lookahead 1: if the very next note is a push or release and
            // landing here leaves no non-same-pitch {1, 5} within 2 steps,
            // nudge one step inward so the special note stays on 1 or 5 cleanly.
            if (nextIsSpecial) {
                const hasEscape = tonicFifthIndices.some(ti => (
                    Math.abs(ti - idx) <= EVENSONG_MAX_LEAP_STEPS
                    && !isForbiddenSamePitchPair(
                        { pitch: scale[idx], start: cur.start, dur: cur.dur },
                        { pitch: scale[ti], start: next.start, dur: next.dur },
                    )
                ));
                if (!hasEscape) {
                    const inward = idx === 0 ? 1 : idx - 1;
                    if (
                        (prevNote == null || Math.abs(inward - prevNote.scaleIdx) <= EVENSONG_MAX_LEAP_STEPS)
                        && !isForbiddenSamePitchPair(prevNote, { pitch: scale[inward], start: cur.start, dur: cur.dur })
                    ) {
                        idx = inward;
                    }
                }
            }
        }

        // Guard bar-14 final beat into bar-15 close against quick same-pitch pair.
        const closeStartBeat = EVENSONG_DAY_BARS * EVENSONG_BEATS_PER_BAR;
        const collidesClose = i === flatNotes.length - 1
            && (closeStartBeat - cur.start) <= SHORT_NOTE_MAX_BEATS + EPS
            && (
                (plagalFirstSemi != null && scale[idx] === plagalFirstSemi)
                || (openFailure && pcOfSemi(scale[idx]) === suspensionPc)
            );
        if (collidesClose) {
            const alts = [idx + 1, idx - 1, idx + 2, idx - 2].filter(c => (
                c >= 0 && c < scale.length
                && (plagalFirstSemi == null || scale[c] !== plagalFirstSemi)
                && (!openFailure || pcOfSemi(scale[c]) !== suspensionPc)
                && (prevNote == null || Math.abs(c - prevNote.scaleIdx) <= EVENSONG_MAX_LEAP_STEPS)
                && !isForbiddenSamePitchPair(prevNote, { pitch: scale[c], start: cur.start, dur: cur.dur })
            ));
            if (alts.length) idx = alts[0];
        }

        cur.scaleIdx = idx;
        cur.semi = scale[idx];
        prevNote = { pitch: cur.semi, start: cur.start, dur: cur.dur, scaleIdx: idx };
    }

    // 4. Materialize melody, chords, bass, and release fifth harmony for bars 0..13.
    const chords = [];
    const melody = [];
    const bass = [];
    const releaseHarmony = [];
    const pushBars = [];
    const releaseBars = [];

    let prevChord = null;
    let prevBass = null;
    let prevMelAtBass = null;

    for (const plan of plannedBars) {
        const { bar, kind, notes } = plan;

        // Melody bar (exact 4 beats, bar-aligned).
        if (kind === 'release') {
            releaseBars.push(bar);
            const melSemi = notes[0].semi;
            melody.push([melSemi, EVENSONG_BEATS_PER_BAR]);

            // Complementary 1 or 5 for explicit held fifth documentation/voicing.
            const deg = pentatonicDegreeOf(melSemi, normKey);
            const compDeg = deg === 3 ? 0 : 3;
            const compSemi = slotTargetSemi(normKey, compDeg, false);
            releaseHarmony.push([compSemi, EVENSONG_BEATS_PER_BAR]);

            chords.push(harmonyPalette.I);
            const tonicBass = rootBassFor(harmonyPalette.I);
            bass.push([tonicBass, EVENSONG_BEATS_PER_BAR]);
            prevChord = harmonyPalette.I;
            prevBass = tonicBass;
            prevMelAtBass = melSemi;
            continue;
        }

        releaseHarmony.push([null, EVENSONG_BEATS_PER_BAR]);

        if (!notes.length) {
            melody.push([null, EVENSONG_BEATS_PER_BAR]);
        } else {
            let cursorSlots = 0;
            for (const n of notes) {
                if (n.pos > cursorSlots) {
                    melody.push([null, (n.pos - cursorSlots) * 0.5]);
                }
                melody.push([n.semi, n.dur]);
                cursorSlots = n.pos + Math.round(n.dur * 2);
            }
            if (cursorSlots < EVENSONG_SLOTS_PER_BAR) {
                melody.push([null, (EVENSONG_SLOTS_PER_BAR - cursorSlots) * 0.5]);
            }
        }

        if (kind === 'push') {
            pushBars.push(bar);
            chords.push([harmonyPalette.V, harmonyPalette.I]);
            const vBass = rootBassFor(harmonyPalette.V);
            const iBass = rootBassFor(harmonyPalette.I);
            bass.push([vBass, 2], [iBass, 2]);
            prevChord = harmonyPalette.I;
            prevBass = iBass;
            prevMelAtBass = notes[notes.length - 1]?.semi ?? null;
        } else {
            const { chord, bassNotes, lastBass } = pickCommitBarHarmony(
                notes,
                harmonyPalette.palette,
                prevChord,
                prevBass,
                prevMelAtBass,
                bar,
            );
            chords.push(chord);
            bass.push(...bassNotes);
            prevChord = chord;
            prevBass = lastBass;
            prevMelAtBass = notes[notes.length - 1]?.semi ?? null;
        }
    }

    // 5. Append Close (bars 15–16, indices 14..15).
    const close = buildClose(normKey, openFailure, prevNote);
    chords.push(...close.chords);
    melody.push(...close.melody);
    bass.push(...close.bass);
    releaseHarmony.push([null, EVENSONG_BEATS_PER_BAR], [null, EVENSONG_BEATS_PER_BAR]);

    const noteCount = melody.filter(([semi]) => semi != null).length;

    return deepFreeze({
        name: 'evensong',
        title: 'Evensong',
        kind: 'evensong',
        family,
        key: normKey,
        bpm: EVENSONG_BPM,
        beatsPerBar: EVENSONG_BEATS_PER_BAR,
        bars: EVENSONG_BARS,
        dayBars: EVENSONG_DAY_BARS,
        engine: 'arp8',
        feel: 'straight',
        voices: EVENSONG_VOICES,
        gainDb: EVENSONG_GAIN_DB,
        percussion: null,
        chords,
        melody,
        bass,
        releaseHarmony,
        tag: close.tag,
        close: {
            kind: close.kind,
            openFailure,
            ritard: close.ritard,
        },
        meta: {
            verifiedEvents: verified.length,
            noteCount,
            commitCount,
            pushCount,
            releaseCount,
            pushBars,
            releaseBars,
            repoCount: distinctRepos.size,
            openFailure,
        },
    });
}

/**
 * The 4-note fallback Evensong motto (spec §5.5 kill criteria):
 * first repo, busiest repo, last repo, then the cadence (tonic if mended,
 * degree-2 suspension if an error remains open at 21:00).
 * Pure, deterministic; returns `null` when the day has no verified work.
 */
export function composeEvensongMotto(dayEvents, key = { tonic: 'A', mode: 'minor' }) {
    const ingested = ingestDayEvents(dayEvents);
    const verified = ingested.filter(e => e.verified);
    if (!verified.length) return null;

    const normKey = normalizeEvensongKey(key);
    const family = normKey.mode === 'minor' ? 'night' : 'day';
    const scale = pentatonicScaleInRange(normKey);
    const bounds = computeTimeBounds(verified);
    const openFailure = hasOpenFailureAtEvensong(ingested, bounds);
    const palette = keyChords(normKey);

    const firstSlot = verified[0].repoSlot;
    const lastSlot = verified[verified.length - 1].repoSlot;

    const counts = new Map();
    const firstSeen = new Map();
    verified.forEach((ev, idx) => {
        counts.set(ev.repoSlot, (counts.get(ev.repoSlot) || 0) + 1);
        if (!firstSeen.has(ev.repoSlot)) firstSeen.set(ev.repoSlot, idx);
    });
    let busiestSlot = firstSlot;
    let maxCount = -1;
    for (const [slot, count] of counts.entries()) {
        const better = count > maxCount
            || (count === maxCount && firstSeen.get(slot) < firstSeen.get(busiestSlot))
            || (count === maxCount && firstSeen.get(slot) === firstSeen.get(busiestSlot) && slot < busiestSlot);
        if (better) {
            maxCount = count;
            busiestSlot = slot;
        }
    }

    const slots = [firstSlot, busiestSlot, lastSlot];
    const indices = [];

    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const degree = ((slot % 5) + 5) % 5;
        const highOctave = ((slot % 10) + 10) % 10 >= 5;
        const targetSemi = slotTargetSemi(normKey, degree, highOctave);
        const rawIdx = scale.indexOf(targetSemi);
        const prevIdx = i > 0 ? indices[i - 1] : null;
        let idx = foldIndexToward(scale, rawIdx, prevIdx);
        if (prevIdx != null && idx === prevIdx) {
            idx = idx + 1 < scale.length ? idx + 1 : idx - 1;
        }
        indices.push(idx);
    }

    // 4th note: cadence (tonic degree 1 if mended, degree 2 suspension if open error).
    const { tonicPc, mode } = musicKey(normKey);
    const cadencePc = openFailure ? mod12(tonicPc + 2) : tonicPc;
    const highLimit = mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high;
    const cadenceSemis = [];
    for (let s = RANGES.lead.low; s <= highLimit; s++) {
        if (pcOfSemi(s) === cadencePc) cadenceSemis.push(s);
    }

    const prevSemi = scale[indices[2]];
    let cadenceSemi = cadenceSemis[0];
    let bestDist = Infinity;
    for (const s of cadenceSemis) {
        const d = Math.abs(s - prevSemi);
        if (d < bestDist || (d === bestDist && Math.abs(s) < Math.abs(cadenceSemi))) {
            bestDist = d;
            cadenceSemi = s;
        }
    }

    // If the 3rd note landed on the exact cadence pitch, nudge the 3rd note
    // (keeping <= 2 steps from note 2 and != note 2) so the cadence resolves freshly.
    if (scale[indices[2]] === cadenceSemi) {
        const alt = [indices[2] + 1, indices[2] - 1, indices[2] + 2, indices[2] - 2].find(c => (
            c >= 0 && c < scale.length
            && c !== indices[1]
            && Math.abs(c - indices[1]) <= EVENSONG_MAX_LEAP_STEPS
            && scale[c] !== cadenceSemi
        ));
        if (alt != null) indices[2] = alt;
    }

    const melody = [
        [scale[indices[0]], 2],
        [scale[indices[1]], 2],
        [scale[indices[2]], 2],
        [cadenceSemi, 2],
    ];
    const chords = openFailure
        ? [palette.I, palette.I]
        : [palette.I, [palette.IV, palette.I]];
    const iBass = rootBassFor(palette.I);
    const ivBass = rootBassFor(palette.IV);
    const bass = openFailure
        ? [[iBass, 4], [iBass, 4]]
        : [[iBass, 4], [ivBass, 2], [iBass, 2]];

    return deepFreeze({
        name: 'evensong-motto',
        title: 'Evensong Motto',
        kind: 'motto',
        family,
        key: normKey,
        bpm: EVENSONG_BPM,
        beatsPerBar: EVENSONG_BEATS_PER_BAR,
        bars: 2,
        engine: 'arpQ',
        feel: 'straight',
        voices: EVENSONG_VOICES,
        gainDb: EVENSONG_GAIN_DB,
        percussion: null,
        chords,
        melody,
        bass,
        close: {
            kind: openFailure ? 'suspension' : 'plagal',
            openFailure,
            ritard: 1,
        },
        mottoSlots: {
            first: firstSlot,
            busiest: busiestSlot,
            last: lastSlot,
        },
        meta: {
            verifiedEvents: verified.length,
            noteCount: 4,
            repoCount: counts.size,
            openFailure,
        },
    });
}

function voiceTimeline(notes) {
    const out = [];
    let at = 0;
    for (const entry of notes || []) {
        const [pitch, beats] = entry;
        if (pitch != null) out.push({ start: at, dur: beats, pitch });
        at += beats;
    }
    return { line: out, total: at };
}

function checkBarAlignment(notes, expectedBars, beatsPerBar, label, errors) {
    const expectedTotal = expectedBars * beatsPerBar;
    let at = 0;
    const barSums = new Array(expectedBars).fill(0);
    for (let i = 0; i < notes.length; i++) {
        const entry = notes[i];
        if (!Array.isArray(entry) || entry.length < 2) {
            errors.push(`${label}: malformed note entry at index ${i}`);
            continue;
        }
        const [, beats] = entry;
        if (!(typeof beats === 'number' && Number.isFinite(beats) && beats > 0)) {
            errors.push(`${label}: non-positive duration ${beats} at beat ${at}`);
            continue;
        }
        const startBar = Math.floor(at / beatsPerBar + EPS);
        const end = at + beats;
        const endBar = Math.floor((end - EPS) / beatsPerBar);
        if (startBar !== endBar) {
            errors.push(`${label}: note crosses bar line at beat ${at} (dur ${beats})`);
        } else if (startBar >= 0 && startBar < expectedBars) {
            barSums[startBar] += beats;
        }
        at = end;
    }
    if (Math.abs(at - expectedTotal) > EPS) {
        errors.push(`${label}: total duration ${at} beats, expected ${expectedTotal}`);
    }
    for (let b = 0; b < expectedBars; b++) {
        if (Math.abs(barSums[b] - beatsPerBar) > EPS) {
            errors.push(`${label}: bar ${b + 1} sums to ${barSums[b]} beats, expected ${beatsPerBar}`);
        }
    }
}

/**
 * Validate every Evensong grammar invariant (spec §5.5):
 *   - zero quick same-pitch pairs in every melodic voice
 *   - every lead note inside the lead voice's playable range
 *   - at most 4 notes per bar in bars 1–14
 *   - zero consecutive melodic leaps exceeding 2 scale steps
 *   - exact bar durations (4 beats per bar across all 16 bars, total 64 beats)
 *   - zero percussion voices, -3 dB trim metadata
 * Returns `{ ok, errors }`.
 */
export function validateEvensongGrammar(score) {
    const errors = [];
    if (!score || typeof score !== 'object') {
        return { ok: false, errors: ['score must be an object'] };
    }

    const bpm = Number(score.bpm);
    const bpb = Number(score.beatsPerBar);
    if (bpm !== EVENSONG_BPM) errors.push(`bpm is ${score.bpm}, expected ${EVENSONG_BPM}`);
    if (bpb !== EVENSONG_BEATS_PER_BAR) errors.push(`beatsPerBar is ${score.beatsPerBar}, expected ${EVENSONG_BEATS_PER_BAR}`);

    // Band metadata: lead, bass, engine ONLY, -3 dB trim, zero percussion.
    const voices = Array.isArray(score.voices) ? score.voices : [];
    const forbiddenPerc = voices.filter(v => v === 'percussion' || v === 'groove');
    if (forbiddenPerc.length) errors.push(`percussion voices forbidden: ${forbiddenPerc.join(', ')}`);
    if (score.percussion != null) errors.push('score.percussion must be null');
    if (
        voices.length !== EVENSONG_VOICES.length
        || !EVENSONG_VOICES.every(v => voices.includes(v))
    ) {
        errors.push(`voices must be exactly [${EVENSONG_VOICES.join(', ')}], got [${voices.join(', ')}]`);
    }
    if (score.gainDb !== EVENSONG_GAIN_DB) {
        errors.push(`gainDb is ${score.gainDb}, expected ${EVENSONG_GAIN_DB}`);
    }

    // Chords check (16 bars, all valid ScoreKit chords).
    if (!Array.isArray(score.chords) || score.chords.length !== EVENSONG_BARS) {
        errors.push(`chords length is ${score.chords?.length}, expected ${EVENSONG_BARS}`);
    } else {
        score.chords.forEach((entry, bar) => {
            const parts = Array.isArray(entry) ? entry : [entry];
            if (!parts.length) errors.push(`bar ${bar + 1}: empty chord entry`);
            for (const name of parts) {
                if (!CHORDS[name]) errors.push(`bar ${bar + 1}: unknown chord ${JSON.stringify(name)}`);
            }
        });
    }

    if (!Array.isArray(score.melody)) {
        errors.push('melody must be an array');
        return { ok: false, errors };
    }
    if (!Array.isArray(score.bass)) {
        errors.push('bass must be an array');
        return { ok: false, errors };
    }

    // Exact bar durations: 4 beats per bar across all 16 bars, total 64 beats.
    const effectiveBpb = bpb > 0 ? bpb : EVENSONG_BEATS_PER_BAR;
    checkBarAlignment(score.melody, EVENSONG_BARS, effectiveBpb, 'melody', errors);
    checkBarAlignment(score.bass, EVENSONG_BARS, effectiveBpb, 'bass', errors);
    if (Array.isArray(score.counterNotes)) {
        checkBarAlignment(score.counterNotes, EVENSONG_BARS, effectiveBpb, 'counterNotes', errors);
    }

    const normKey = normalizeEvensongKey(score.key);
    const scale = pentatonicScaleInRange(normKey);
    const scaleIndex = new Map(scale.map((semi, idx) => [semi, idx]));
    const leadLow = RANGES.lead.low;
    const leadHigh = normKey.mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high;

    const lead = voiceTimeline(score.melody).line;
    const low = voiceTimeline(score.bass).line;

    // Lead range check.
    for (const note of lead) {
        if (note.pitch < leadLow || note.pitch > leadHigh) {
            errors.push(`lead pitch ${note.pitch} at beat ${note.start} outside ${leadLow}..${leadHigh}`);
        }
    }
    // Bass range check.
    for (const note of low) {
        if (note.pitch < RANGES.bass.low || note.pitch > RANGES.bass.high) {
            errors.push(`bass pitch ${note.pitch} at beat ${note.start} outside ${RANGES.bass.low}..${RANGES.bass.high}`);
        }
    }

    // Quick same-pitch pairs in every melodic voice.
    const voiceLines = [['melody', lead], ['bass', low]];
    if (Array.isArray(score.counterNotes)) {
        voiceLines.push(['counterNotes', voiceTimeline(score.counterNotes).line]);
    }
    for (const [voiceName, line] of voiceLines) {
        for (let i = 1; i < line.length; i++) {
            if (isForbiddenSamePitchPair(line[i - 1], line[i], bpm > 0 ? bpm : EVENSONG_BPM)) {
                errors.push(`${voiceName}: quick same-pitch pair on ${line[i].pitch} at beat ${line[i].start}`);
            }
        }
    }

    // Bars 1–14: at most 4 notes per bar, pentatonic scale membership, and
    // consecutive leaps <= 2 pentatonic scale steps.
    const dayBeatEnd = EVENSONG_DAY_BARS * effectiveBpb;
    const perBarCounts = new Array(EVENSONG_DAY_BARS).fill(0);
    const dayLead = [];
    const closeLead = [];

    for (const note of lead) {
        if (note.start < dayBeatEnd - EPS) {
            const bar = Math.floor(note.start / effectiveBpb + EPS);
            if (bar >= 0 && bar < EVENSONG_DAY_BARS) perBarCounts[bar]++;
            dayLead.push(note);
        } else {
            closeLead.push(note);
        }
    }

    for (let bar = 0; bar < EVENSONG_DAY_BARS; bar++) {
        if (perBarCounts[bar] > EVENSONG_MAX_NOTES_PER_BAR) {
            errors.push(`bar ${bar + 1}: ${perBarCounts[bar]} notes exceeds max ${EVENSONG_MAX_NOTES_PER_BAR}`);
        }
    }

    for (let i = 0; i < dayLead.length; i++) {
        const note = dayLead[i];
        if (!scaleIndex.has(note.pitch)) {
            errors.push(`bar ${Math.floor(note.start / effectiveBpb) + 1}: pitch ${note.pitch} not in ${normKey.tonic} ${normKey.mode} pentatonic`);
            continue;
        }
        if (i > 0 && scaleIndex.has(dayLead[i - 1].pitch)) {
            const steps = Math.abs(scaleIndex.get(note.pitch) - scaleIndex.get(dayLead[i - 1].pitch));
            if (steps > EVENSONG_MAX_LEAP_STEPS) {
                errors.push(`leap of ${steps} scale steps (${dayLead[i - 1].pitch} -> ${note.pitch}) at beat ${note.start}, max ${EVENSONG_MAX_LEAP_STEPS}`);
            }
        }
    }

    // Close (bars 15–16): consecutive leaps inside the close <= 5 semitones
    // (the span of 2 pentatonic steps, satisfied by both the plagal tag and suspension).
    for (let i = 1; i < closeLead.length; i++) {
        const semis = Math.abs(closeLead[i].pitch - closeLead[i - 1].pitch);
        if (semis > 5) {
            errors.push(`close leap of ${semis} semitones (${closeLead[i - 1].pitch} -> ${closeLead[i].pitch}) at beat ${closeLead[i].start}`);
        }
    }

    return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Live wiring (W6.3): the trigger's constants and the day's own ledger.

// The soft chime (ActionableRouting HOUR_CHIME_SOFT) that calls Evensong in.
export const EVENSONG_CHIME_HOUR = EVENSONG_END_HOUR;
// Queued at the chime, Evensong starts in the breath after the band's
// current visit; a day whose breath comes later than this has no Evensong.
export const EVENSONG_QUEUE_CAP_MS = 4 * 60 * 1000;

const LEDGER_KINDS = new Set(['commit', 'push', 'release', 'errored', 'mended']);
const LEDGER_LIMIT = 1024;

/** The local calendar day of `date` as `YYYY-MM-DD` (the clock's `localDate`). */
export function evensongDayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day's verified work as Evensong reads it, kept by the band director
 * from the facts it already hears (`outcome:verified`, the watchtower's
 * errors and mends). Each entry is reduced at once to its kind, its local
 * minute and anonymous integers (the repo's pennant slot, the agent's hash
 * slot): no repo or agent string is ever kept. `record(fact, at)` takes the
 * fact's own time (never reads the clock); `events(day)` returns that local
 * day's entries in `composeEvensong`'s input shape. FIFO-capped, deduplicated.
 */
export function createEvensongDayLedger({ limit = LEDGER_LIMIT } = {}) {
    let entries = [];
    const seen = new Set();
    return {
        record({ kind, repoSlot = null, agentSlot = null } = {}, at) {
            const name = String(kind || '').toLowerCase();
            if (!LEDGER_KINDS.has(name)) return false;
            const when = at instanceof Date ? at : new Date(Number(at));
            const day = evensongDayKey(when);
            if (!day) return false;
            const repo = Number.isInteger(repoSlot) && repoSlot >= 0 ? repoSlot : null;
            const agent = Number.isInteger(agentSlot) && agentSlot >= 0 ? agentSlot : null;
            const key = `${name}|${when.getTime()}|${repo}|${agent}`;
            if (seen.has(key)) return false;
            seen.add(key);
            entries.push(Object.freeze({
                day,
                key,
                kind: name,
                minuteOfDay: when.getHours() * 60 + when.getMinutes() + when.getSeconds() / 60,
                ...(repo != null ? { repoSlot: repo } : {}),
                ...(agent != null ? { agentSlot: agent } : {}),
            }));
            while (entries.length > limit) seen.delete(entries.shift().key);
            return true;
        },
        events(day) {
            return entries
                .filter(entry => entry.day === day)
                .map(({ day: _day, key: _key, ...event }) => event);
        },
        clear() {
            entries = [];
            seen.clear();
        },
        get size() {
            return entries.length;
        },
    };
}

export { ALLOWED_KEYS };
