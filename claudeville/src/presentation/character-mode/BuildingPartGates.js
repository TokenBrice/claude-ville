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
//
// Every frame is a function of (gate truth, the motion clock), so the Canvas
// blit and the GPU record read the same answer.

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
    if (!rest || (kind !== 'work' && kind !== 'door')) return null;
    return { kind, type: rest };
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
    }

    // `workingIdsByType`: Map<type, Set<agentId>> of isWorkingVisitor bodies.
    // `roomSlotsByType`: Map<type, { assignment }> (BuildingSprite 6.3 slots).
    // `timeMs`: the one motion clock (frozen under reduced motion).
    update({ workingIdsByType = null, roomSlotsByType = null, timeMs = 0, motion = true } = {}) {
        this._timeMs = Number(timeMs) || 0;
        this._motion = motion !== false;
        this._roomSlots = roomSlotsByType;
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
}
