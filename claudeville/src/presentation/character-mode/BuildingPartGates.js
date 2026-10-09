// Plan 6.1 / 6.2 — the one gate resolver for building parts, doors and
// work-coupled emitter cycles. Gates resolve from existing state only: the
// per-building set of bodies that pass V8's `isWorkingVisitor` (filled by
// BuildingSprite._updateVisitorCounts), so rest-seat (7.1), queue (7.2) and
// inferred-leg visitors never turn a sheave, pump a bellows or open a door.
//
// Gate names (manifest `layers.<name>.gate`):
//   work.<type>  — true while the building has >= 1 working visitor. A
//                  looping part steps its strip at the layer's fps; gated off
//                  (or under reduced motion) it shows `staticFrame`.
//   door.<type>  — the same truth; a one-shot part (`oneShot: true`) plays
//                  its strip forward once when the gate opens (an arrival at
//                  an empty building: closed → ajar → open, one frame per
//                  DOOR_FRAME_MS), holds the last frame while the gate stays
//                  open and plays back to frame 0 when it closes. Reduced
//                  motion jumps straight to the held frame (static).
//   room.<type>.<k> — true while a working visitor holds room k (0-based,
//                  mask R = k + 1) of the building's 6.3 room slots, so a
//                  part that IS a room's glass (the Task board lanterns)
//                  burns for exactly the worker that holds it: N workers
//                  light min(N, rooms). Loops like `work.<type>`.
//   status.<bucket> — W5.3: true while <bucket> (`needsYou`, `errors`,
//                  `quota`) is the lead actionable bucket — SignalLedger
//                  precedence, the TopBar ATTENTION_PARTS lead rule. A status
//                  part is never work-coupled and never animates: open, it
//                  shows frame 1 + SignalLedger.waitAgeTier of the oldest
//                  actionable wait (a hard swap when the tier steps); closed,
//                  its staticFrame. Reduced motion changes nothing.
//   clock.<beat> — W6.8: a FIXTURE gate, never work-coupled: true while the
//                  day-part beat <beat> (AmbientEvents.DAY_PART_BEATS, the
//                  atmosphere clock only) is live. A clock part plays its
//                  `sequence` of strip frames (one per `stepMs`) once when
//                  the beat opens, then holds `staticFrame` until the beat
//                  closes and opens again (the next day). Reduced motion
//                  holds `staticFrame`. Like the `lamps` emitter cycles (the
//                  Pharos lens, the Command braziers), it reads no agent.
//
// Every frame is a function of (gate truth, the motion clock), so the Canvas
// blit and the GPU record read the same answer.

import {
    ACTIONABLE_BUCKETS,
    bucketForStatus,
    isActionableBucket,
    waitAgeTier,
    waitAnchor,
} from '../../domain/services/SignalLedger.js';

export const DOOR_FRAME_MS = 110;

const EMPTY = new Set();

export function parsePartGate(gate) {
    const text = String(gate || '').trim();
    const dot = text.indexOf('.');
    if (dot <= 0) return null;
    const kind = text.slice(0, dot);
    const rest = text.slice(dot + 1);
    if (kind === 'room') {
        const match = /^([a-z]+)\.(\d+)$/.exec(rest);
        return match ? { kind, type: match[1], room: Number(match[2]) } : null;
    }
    if (kind === 'status') return ACTIONABLE_BUCKETS.includes(rest) ? { kind, bucket: rest } : null;
    if (kind === 'clock') return rest ? { kind, beat: rest } : null;
    if (!rest || (kind !== 'work' && kind !== 'door')) return null;
    return { kind, type: rest };
}

/**
 * W5.3 — the attention banner's state for a set of live agents: null when no
 * one needs action, else `{ bucket, tier, count }` — the lead actionable
 * bucket, the wait-age tier (0–3) of the oldest actionable wait with a known
 * anchor (unknown ages hang the shortest drop: the banner never claims a
 * wait it cannot date) and the exact actionable count.
 */
export function attentionBannerState(agents, now = Date.now()) {
    const counts = { needsYou: 0, errors: 0, quota: 0 };
    let total = 0;
    let oldest = 0;
    for (const agent of agents || EMPTY) {
        const bucket = bucketForStatus(agent?.status);
        if (!isActionableBucket(bucket)) continue;
        counts[bucket]++;
        total++;
        const anchor = waitAnchor(agent);
        if (anchor > 0 && (oldest === 0 || anchor < oldest)) oldest = anchor;
    }
    if (!total) return null;
    const bucket = ACTIONABLE_BUCKETS.find(name => counts[name] > 0);
    const tier = oldest > 0 ? (waitAgeTier(now - oldest) ?? 0) : 0;
    return { bucket, tier, count: total };
}

// Looping frame for a stepped clock: frames [loopFrom, frames) at `fps`.
export function loopingPartFrame(layer, timeMs) {
    const frames = Math.max(1, layer?.frames | 0);
    const from = Math.max(0, Math.min(frames - 1, layer?.loopFrom | 0));
    const span = frames - from;
    const fps = Math.max(1, Number(layer?.fps) || 4);
    const step = Math.floor(Math.max(0, Number(timeMs) || 0) * fps / 1000);
    return from + (step % span);
}

export class BuildingPartGates {
    constructor() {
        this._working = new Map();   // type -> Set(agentId) at the last update
        this._oneShots = new Map();  // `${type}:${name}` -> { frame, stepAt }
        this._timeMs = 0;
        this._roomSlots = null; // type -> { assignment: Map<agentId, roomIndex> }
        this._motion = true;
        this._attention = null; // W5.3 — { bucket, tier, count } or null
        this._clockBeats = EMPTY; // W6.8 — live day-part beat ids
        this._sequences = new Map(); // `${type}:${name}` -> { startAt }
    }

    // `workingIdsByType`: Map<type, Set<agentId>> of isWorkingVisitor bodies.
    // `roomSlotsByType`: Map<type, { assignment }> (BuildingSprite 6.3 slots).
    // `timeMs`: the one motion clock (frozen under reduced motion).
    // `attention`: attentionBannerState() for the `status.<bucket>` gates.
    // `clockBeats`: the live day-part beat ids for the `clock.<beat>` gates.
    update({ workingIdsByType = null, roomSlotsByType = null, timeMs = 0, motion = true, attention = null, clockBeats = null } = {}) {
        this._timeMs = Number(timeMs) || 0;
        this._motion = motion !== false;
        this._roomSlots = roomSlotsByType;
        this._attention = attention || null;
        this._clockBeats = clockBeats || EMPTY;
        const next = this._working;
        for (const mine of next.values()) mine.stale = true;
        if (workingIdsByType) {
            for (const [type, ids] of workingIdsByType) {
                let mine = next.get(type);
                if (!mine) {
                    mine = new Set();
                    next.set(type, mine);
                }
                mine.stale = false;
                let arrived = false;
                for (const id of ids || EMPTY) {
                    if (!mine.has(id)) { arrived = true; break; }
                }
                if (arrived) this._arrivalAt(type);
                mine.clear();
                for (const id of ids || EMPTY) mine.add(id);
            }
        }
        for (const mine of next.values()) {
            if (mine.stale) mine.clear();
        }
    }

    isOpen(gate) {
        const parsed = typeof gate === 'string' ? parsePartGate(gate) : gate;
        if (!parsed) return false;
        if (parsed.kind === 'status') return this._attention?.bucket === parsed.bucket;
        if (parsed.kind === 'clock') return this._clockBeats.has(parsed.beat);
        if (parsed.kind === 'room') {
            const assignment = this._roomSlots?.get(parsed.type)?.assignment;
            if (!assignment) return false;
            for (const room of assignment.values()) {
                if (room === parsed.room) return true;
            }
            return false;
        }
        return (this._working.get(parsed.type)?.size || 0) > 0;
    }

    workingCount(type) {
        return this._working.get(type)?.size || 0;
    }

    // An arrival restarts an idle door's one-shot from frame 0, so the open
    // is always seen as three steps, never a pop.
    _arrivalAt(type) {
        for (const [key, state] of this._oneShots) {
            if (!key.startsWith(`${type}:`)) continue;
            if (state.frame === 0) state.stepAt = this._timeMs;
        }
    }

    // The strip frame a layer shows now. `motion === false` → static.
    frameFor(buildingType, name, layer) {
        const frames = Math.max(1, layer?.frames | 0);
        const staticFrame = Math.max(0, Math.min(frames - 1, layer?.staticFrame | 0));
        const parsed = parsePartGate(layer?.gate);
        const open = parsed ? this.isOpen(parsed) : false;
        if (parsed?.kind === 'status') {
            return open ? Math.min(frames - 1, 1 + Math.max(0, this._attention.tier | 0)) : staticFrame;
        }
        if (parsed?.kind === 'clock') return this._clockFrame(`${buildingType}:${name}`, layer, staticFrame, open);
        if (layer?.oneShot) return this._oneShotFrame(`${buildingType}:${name}`, frames, staticFrame, open);
        if (!open || !this._motion) return staticFrame;
        return loopingPartFrame(layer, this._timeMs);
    }

    _oneShotFrame(key, frames, staticFrame, open) {
        const last = frames - 1;
        let state = this._oneShots.get(key);
        if (!state) {
            state = { frame: open ? last : staticFrame, stepAt: this._timeMs };
            this._oneShots.set(key, state);
            return state.frame;
        }
        const target = open ? last : staticFrame;
        if (!this._motion) {
            state.frame = target;
            state.stepAt = this._timeMs;
            return state.frame;
        }
        // One strip frame per DOOR_FRAME_MS toward the target, never more
        // than one per tick, so every frame of the open is shown.
        if (state.frame === target) {
            state.stepAt = this._timeMs;
        } else if (this._timeMs - state.stepAt >= DOOR_FRAME_MS) {
            state.frame += target > state.frame ? 1 : -1;
            state.stepAt = this._timeMs;
        }
        return state.frame;
    }

    _clockFrame(key, layer, staticFrame, open) {
        if (!open) {
            this._sequences.delete(key);
            return staticFrame;
        }
        if (!this._motion) return staticFrame;
        let state = this._sequences.get(key);
        if (!state) {
            state = { startAt: this._timeMs };
            this._sequences.set(key, state);
        }
        const sequence = Array.isArray(layer?.sequence) ? layer.sequence : [];
        const step = Math.floor((this._timeMs - state.startAt) / Math.max(1, Number(layer?.stepMs) || 320));
        return step >= 0 && step < sequence.length ? sequence[step] : staticFrame;
    }
}
