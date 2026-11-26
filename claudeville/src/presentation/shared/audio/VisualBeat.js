// Scheduled marks use AudioContext seconds. All public times are monotonic
// milliseconds except phaseBiasFor, the bridge for the wall-clock gestures.
import { monotonicTimeForAudioTime } from './cues/CueKit.js';

export const PULL_IN_MAX_MS = 80;
export const HOLD_MAX_MS = 250;
export const VISUAL_LEAD_MS = 8;
export const HIT_RING = 32;
export const CLOCK_RESYNC_MS = 1000;
export const LOCK_TOLERANCE = 0.125;
export const UNCOUPLED = new Set(['watchtower']);

export function createVisualBeat({ engine, sequencer, musicClock, perfNow = () => performance.now(), isEnabled = () => true }) {
    const ctx = engine.context;
    const rings = new Map();
    const cadences = [];
    const counts = { hits: 0, locked: 0, held: 0, pulled: 0, missed: 0, maxErrMs: 0 };
    let disposed = false;
    let sampledAt = -Infinity;
    let offset;
    let wallOffset;

    function resync() {
        sampledAt = perfNow();
        const sample = monotonicTimeForAudioTime(engine, 0, () => sampledAt);
        offset = Math.abs(sample - offset) <= 20 ? offset + 0.1 * (sample - offset) : sample;
        wallOffset = Date.now() - sampledAt;
    }

    function active() {
        if (disposed || ctx?.state !== 'running' || sequencer.preset !== 'townBand'
            || !isEnabled() || !musicClock.playing(ctx.currentTime)) return false;
        if (perfNow() - sampledAt >= CLOCK_RESYNC_MS) resync();
        return true;
    }

    ctx?.addEventListener?.('statechange', resync);
    const unsubscribe = sequencer.observe(mark => {
        if (!Number.isFinite(mark.t)) return;
        if (mark.kind === 'cadence') {
            cadences.push(mark.t);
            if (cadences.length > HIT_RING) cadences.shift();
        } else if (mark.kind === 'perc' && mark.building && !UNCOUPLED.has(mark.building) && mark.building !== 'tavern') {
            let ring = rings.get(mark.building);
            if (!ring) {
                ring = { hits: [], count: 0 };
                rings.set(mark.building, ring);
            }
            ring.hits.push({ t: mark.t, step: mark.step, index: ring.count++ });
            if (ring.hits.length > HIT_RING) ring.hits.shift();
            counts.hits++;
        }
    });

    const visualTime = t => offset + t * 1000 - VISUAL_LEAD_MS;

    function assignedHit(building, afterMs, slot, of) {
        let first = null;
        for (const hit of rings.get(building)?.hits ?? []) {
            if (hit.index % of === slot && visualTime(hit.t) >= afterMs && (!first || hit.t < first.t)) first = hit;
        }
        return first;
    }

    function contactFor(building, naturalMs, nowMs, slot = 0, of = 1) {
        if (!active()) return naturalMs;
        const after = Math.max(nowMs - VISUAL_LEAD_MS, naturalMs - PULL_IN_MAX_MS);
        const hit = assignedHit(building, after, slot, Math.max(1, of));
        const target = hit ? visualTime(hit.t) : Infinity;
        if (target - naturalMs > HOLD_MAX_MS) {
            counts.missed++;
            return naturalMs;
        }
        counts.locked++;
        if (target > naturalMs) counts.held++;
        if (target < naturalMs) counts.pulled++;
        counts.maxErrMs = Math.max(counts.maxErrMs, Math.abs(target - (offset + hit.t * 1000)));
        return target;
    }

    // Read the sounding MusicClock frame directly: its diagnostic snapshot
    // omits originTime, and the following bar may be past the committed score.
    function gridAt(ms) {
        return musicClock._frameAt((ms - offset + VISUAL_LEAD_MS) / 1000);
    }

    return {
        active,
        nextHit(building, nowMs = perfNow()) {
            if (!active()) return null;
            const hit = assignedHit(building, nowMs - VISUAL_LEAD_MS, 0, 1);
            return hit ? { ms: visualTime(hit.t), step: hit.step } : null;
        },
        contactFor,
        phaseBiasFor(agentId, building, naturalMs, nowMs, slot, of) {
            if (!agentId || !active()) return 0;
            const natural = naturalMs - wallOffset;
            return natural - contactFor(building, natural, nowMs - wallOffset, slot, of);
        },
        barAccent(naturalMs, nowMs) {
            if (!active()) return naturalMs;
            const frame = gridAt(naturalMs);
            if (!frame) return naturalMs;
            const barMs = frame.beatSec * frame.beatsPerBar * 1000;
            const origin = visualTime(frame.originTime);
            const line = origin + Math.round((naturalMs - origin) / barMs) * barMs;
            return Math.abs(line - naturalMs) <= PULL_IN_MAX_MS && gridAt(line) ? line : naturalMs;
        },
        lockedPeriod(periodMs, nowMs) {
            if (!(periodMs > 0) || !active()) return null;
            const frame = gridAt(nowMs);
            if (!frame) return null;
            const sixteenth = frame.beatSec * 250;
            const unit = Math.max(1, Math.round(periodMs / sixteenth)) * sixteenth;
            return Math.abs(unit - periodMs) / periodMs <= LOCK_TOLERANCE
                ? { periodMs: unit, originMs: visualTime(frame.originTime) } : null;
        },
        cadenceNear(nowMs, windowMs) {
            if (!active()) return null;
            let closest = null;
            for (const t of cadences) {
                const ms = visualTime(t);
                const distance = Math.abs(ms - nowMs);
                if (distance <= windowMs && (closest === null || distance < Math.abs(closest - nowMs))) closest = ms;
            }
            return closest;
        },
        stats: () => ({ ...counts }),
        dispose() {
            disposed = true;
            unsubscribe();
            ctx?.removeEventListener?.('statechange', resync);
            rings.clear();
            cadences.length = 0;
        },
    };
}
