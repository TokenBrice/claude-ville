// The one musical clock (S4, MUS-1). Whichever band plays publishes what is
// sounding — key, chord timeline, tempo and bar grid, all in AudioContext
// seconds — so cues and the bed can join the music instead of ringing over it.
// With no music it answers the phase key's tonic triad, the pitches the cues
// use today.
//
// A frame is `{ source, key: { tonicPc, mode }, originTime, beatSec,
// beatsPerBar, chords: [{ time, rootPc, pcs }], until }`: `originTime` is
// bar 1 beat 1 of the grid, `chords` sorted by time, `until` the end of what
// the source has committed. A source publishes once per chunk or section,
// ahead of time; the frame it replaces keeps answering until the new one
// starts, so the chunk still sounding never loses its chord.

import { phaseKey, tonicTriad } from './MusicalScale.js';

// Tolerance for grid and chord-boundary comparisons (float rounding of
// `origin + beat · beatSec`), far below one sample.
const EPS = 1e-6;
// Frames kept per source: the one sounding and the ones queued ahead.
const MAX_FRAMES = 4;
// Grid divisions, coarsest first, in beats (bar, beat, eighth, sixteenth).
const DIVISIONS = Object.freeze([
    Object.freeze({ name: 'bar', beats: null }),
    Object.freeze({ name: 'beat', beats: 1 }),
    Object.freeze({ name: 'eighth', beats: 0.5 }),
    Object.freeze({ name: 'sixteenth', beats: 0.25 }),
]);

function normalizeFrame(frame) {
    const beatSec = Number(frame?.beatSec);
    const originTime = Number(frame?.originTime);
    const until = Number(frame?.until);
    if (!frame?.source || !(beatSec > 0) || !Number.isFinite(originTime) || !Number.isFinite(until)) return null;
    const chords = (Array.isArray(frame.chords) ? frame.chords : [])
        .filter(chord => Number.isFinite(chord?.time) && Array.isArray(chord.pcs))
        .map(chord => ({ time: chord.time, rootPc: chord.rootPc, pcs: [...chord.pcs] }))
        .sort((a, b) => a.time - b.time);
    if (!chords.length) return null;
    return {
        source: String(frame.source),
        key: { tonicPc: frame.key?.tonicPc ?? 9, mode: frame.key?.mode === 'minor' ? 'minor' : 'major' },
        originTime,
        beatSec,
        beatsPerBar: Number(frame.beatsPerBar) > 0 ? Number(frame.beatsPerBar) : 4,
        chords,
        start: chords[0].time,
        until,
    };
}

export class MusicClock {
    constructor() {
        this._frames = new Map(); // source → frames sorted by start
        this._idleKey = phaseKey('day');
    }

    // The idle key follows the phase (day major, night minor).
    setPhase(phase) {
        this._idleKey = phaseKey(phase);
    }

    publish(frame) {
        const next = normalizeFrame(frame);
        if (!next) return false;
        const kept = (this._frames.get(next.source) || [])
            .filter(old => old.start < next.start - EPS)
            .map(old => (old.until > next.start ? { ...old, until: next.start } : old));
        kept.push(next);
        this._frames.set(next.source, kept.slice(-MAX_FRAMES));
        return true;
    }

    clear(source) {
        this._frames.delete(String(source));
    }

    // The frame sounding at `t`: the latest-starting one that covers it.
    _frameAt(t) {
        let best = null;
        for (const frames of this._frames.values()) {
            for (const frame of frames) {
                if (frame.start <= t + EPS && t < frame.until - EPS && (!best || frame.start > best.start)) {
                    best = frame;
                }
            }
        }
        return best;
    }

    playing(t) {
        return this._frameAt(t) !== null;
    }

    keyAt(t) {
        const frame = this._frameAt(t);
        return { ...(frame ? frame.key : this._idleKey) };
    }

    // `{ rootPc, pcs }` sounding at `t`; the idle key's tonic triad with no music.
    chordAt(t) {
        const frame = this._frameAt(t);
        if (!frame) return tonicTriad(this._idleKey);
        const { chords } = frame;
        let lo = 0;
        let hi = chords.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (chords[mid].time <= t + EPS) lo = mid;
            else hi = mid - 1;
        }
        const chord = chords[lo];
        return { rootPc: chord.rootPc, pcs: [...chord.pcs] };
    }

    // The first grid point ≥ t on the coarsest division (bar, beat, eighth,
    // sixteenth) whose unit fits in `maxWaitSec`; `t` itself with no music,
    // no fitting division, or a grid point past what the band committed.
    nextGrid(t, { maxWaitSec = 0 } = {}) {
        const frame = this._frameAt(t);
        if (!frame) return t;
        for (const division of DIVISIONS) {
            const unit = (division.beats ?? frame.beatsPerBar) * frame.beatSec;
            if (unit > maxWaitSec + EPS) continue;
            const k = Math.ceil((t - frame.originTime) / unit - EPS);
            const at = frame.originTime + k * unit;
            return at < frame.until - EPS ? at : t;
        }
        return t;
    }

    // Plain JSON for `__claudevilleAudio().musicClock`.
    snapshot(t) {
        const frame = this._frameAt(t);
        const chord = this.chordAt(t);
        if (!frame) return { source: null, key: { ...this._idleKey }, chord };
        const beats = (t - frame.originTime) / frame.beatSec + EPS;
        const barIndex = Math.floor(beats / frame.beatsPerBar);
        return {
            source: frame.source,
            key: { ...frame.key },
            chord,
            bar: barIndex + 1,
            beat: Math.floor(beats - barIndex * frame.beatsPerBar) + 1,
            beatSec: frame.beatSec,
            beatsPerBar: frame.beatsPerBar,
            until: frame.until,
        };
    }
}
