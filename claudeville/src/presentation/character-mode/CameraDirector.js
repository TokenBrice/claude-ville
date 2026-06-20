import { eventBus } from '../../domain/events/DomainEvent.js';

// #21 — Director-driven cinematic camera.
//
// The VillageDirector already detects the moments worth framing (a release
// parade at the harbor, a cluster of incidents, a fresh arrival) and emits a
// `village:camera-cue` with the world target and an art-directed grade. This
// module is the policy layer: it decides *whether* to spend a cinematic move on
// a cue, then asks the Camera for a time-boxed cubic-ease glide that aborts the
// instant the operator touches the camera.
//
// Rules of the house:
//   - Never hijack a user who has taken control (camera._userAdjusted) or who
//     is following an agent — the cinema yields to intent.
//   - One move at a time, with a per-kind cooldown so a noisy fleet does not
//     yank the camera around. Higher-priority cues may interrupt a running glide
//     of a lower priority.
//   - Reduced motion is honoured downstream by the Camera (it cuts instead of
//     gliding); the grade pass also collapses to a static tint.

const CUE_PRIORITY = Object.freeze({
    incident: 3, // a cluster of trouble outranks everything
    release: 2,  // the parade is a celebration, mid priority
    arrival: 1,  // a new villager is the gentlest nudge
});

const CUE_PROFILE = Object.freeze({
    incident: { duration: 1500, maxZoom: 2, paddingPx: 120 },
    release: { duration: 1800, maxZoom: 2, paddingPx: 140 },
    arrival: { duration: 1300, maxZoom: 2, paddingPx: 96 },
});

// How long after a move before the same kind may grab the camera again.
const COOLDOWN_MS = Object.freeze({
    incident: 9000,
    release: 14000,
    arrival: 11000,
});

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

export class CameraDirector {
    constructor(camera, { motionScale = 1 } = {}) {
        this.camera = camera;
        this.motionScale = motionScale === 0 ? 0 : 1;
        this._lastFiredAt = new Map();   // kind -> ms
        this._activeKind = null;
        this._onCue = (cue) => this._handleCue(cue);
        this._off = eventBus.on('village:camera-cue', this._onCue);
    }

    setCamera(camera) {
        this.camera = camera;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    dispose() {
        this._off?.();
        this._off = null;
        this._lastFiredAt.clear();
        this._activeKind = null;
    }

    _handleCue(cue) {
        const camera = this.camera;
        if (!camera || !cue || !cue.box) return;
        const kind = cue.kind;
        const priority = CUE_PRIORITY[kind] || 1;

        // Yield to the operator: never fight a manual view or an active follow.
        if (camera._userAdjusted || camera.followTarget) return;

        const now = nowMs();
        const since = now - (this._lastFiredAt.get(kind) || -Infinity);
        if (since < (COOLDOWN_MS[kind] || COOLDOWN_MS.arrival)) return;

        // One glide at a time; only a strictly higher priority may interrupt.
        if (camera.isDirectorGliding?.()) {
            const activePriority = CUE_PRIORITY[this._activeKind] || 0;
            if (priority <= activePriority) return;
        }

        const profile = CUE_PROFILE[kind] || CUE_PROFILE.arrival;
        const started = camera.glideToWorld(cue.box, {
            duration: profile.duration,
            maxZoom: profile.maxZoom,
            paddingPx: profile.paddingPx,
            grade: cue.grade || null,
        });
        if (!started) return;
        this._lastFiredAt.set(kind, now);
        this._activeKind = kind;
    }
}
