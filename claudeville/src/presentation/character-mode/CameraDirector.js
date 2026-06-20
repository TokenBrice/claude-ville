import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';

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

// #attract — continuous "idle attract" cinematographer. When enabled and the
// operator has sat idle, the director tours wherever the action is (trouble
// first, then working villagers), holding each shot before cutting on. It rides
// the same glide primitive and yields the instant the operator touches anything.
const ATTRACT_ENGAGE_MS = 35000; // genuine input-free time before auto-pilot takes over
const ATTRACT_DWELL_MS = 9000;   // hold each shot at least this long before moving on
const ATTRACT_GLIDE_MS = 2200;
const ATTRACT_MAX_ZOOM = 2;
const ATTRACT_PAD_PX = 150;
const ATTRACT_BAND = 12;         // POIs within this score of the top are "comparable" and get toured
const ATTRACT_RECENT = 5;        // don't immediately revisit the last N shots

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function boxAround(x, y, half) {
    return { minX: x - half, minY: y - half, maxX: x + half, maxY: y + half };
}

function boxForPoints(points, pad) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export class CameraDirector {
    constructor(camera, { motionScale = 1 } = {}) {
        this.camera = camera;
        this.motionScale = motionScale === 0 ? 0 : 1;
        this._lastFiredAt = new Map();   // kind -> ms
        this._activeKind = null;
        // #attract — continuous idle-attract cinematographer state.
        this.autoMode = true;
        this._lastAutoMoveAt = -Infinity;
        this._focusKey = null;
        this._recent = [];
        this._onCue = (cue) => this._handleCue(cue);
        this._off = eventBus.on('village:camera-cue', this._onCue);
    }

    setCamera(camera) {
        this.camera = camera;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    setAutoMode(on) {
        this.autoMode = Boolean(on);
        if (!this.autoMode) {
            this._focusKey = null;
            this._recent = [];
        }
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

    // #attract — called every frame by the renderer. When auto-mode is on and the
    // operator has been idle, tour the camera to wherever the action is. Yields to
    // any genuine input (the camera's user-idle clock resets) and to a manual
    // follow; never roams under reduced motion.
    update({ now = nowMs(), agentSprites = null, snapshot = null } = {}) {
        const camera = this.camera;
        if (!this.autoMode || !camera) return;
        if (this.motionScale === 0) return;            // reduced motion: stay put
        if (camera.followTarget) return;               // never fight a manual follow
        if (camera.isDirectorGliding?.()) return;      // one move at a time
        const idleFor = camera.getUserIdleMs ? camera.getUserIdleMs(now) : Infinity;
        if (idleFor < ATTRACT_ENGAGE_MS) return;       // operator may still be looking
        if (now - this._lastAutoMoveAt < ATTRACT_DWELL_MS) return;

        const candidates = this._scorePointsOfInterest(agentSprites, snapshot);
        if (!candidates.length) { this._lastAutoMoveAt = now; return; }

        // Tour the strongest band of POIs round-robin so the camera roams instead
        // of parking; a clearly stronger POI (e.g. an incident) preempts the band.
        const top = candidates[0];
        const band = candidates.filter((c) => c.score >= top.score - ATTRACT_BAND);
        const pick = band.find((c) => !this._recent.includes(c.key)) || band[0];
        if (pick.key === this._focusKey) { this._lastAutoMoveAt = now; return; }

        const started = camera.glideToWorld(pick.box, {
            duration: ATTRACT_GLIDE_MS,
            maxZoom: ATTRACT_MAX_ZOOM,
            paddingPx: ATTRACT_PAD_PX,
            grade: pick.grade || null,
        });
        if (!started) return;
        this._focusKey = pick.key;
        this._recent.push(pick.key);
        if (this._recent.length > ATTRACT_RECENT) this._recent.shift();
        this._lastAutoMoveAt = now;
    }

    // Rank frame-worthy points of interest. Trouble outranks everything; otherwise
    // working villagers are the roam targets. Coords are world-space (sprite.x/y
    // and incident points share the camera's world space).
    _scorePointsOfInterest(agentSprites, snapshot) {
        const out = [];

        const incidentPoints = [];
        for (const incident of (snapshot?.incidents || [])) {
            const p = incident.agent || incident.center;
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) incidentPoints.push({ x: p.x, y: p.y });
        }
        if (incidentPoints.length) {
            out.push({
                key: 'incidents',
                score: 96 + incidentPoints.length,
                box: boxForPoints(incidentPoints, 90),
                grade: { vignette: 0.4, worldTint: '#c0392b' },
            });
        }

        if (agentSprites) {
            for (const sprite of agentSprites.values()) {
                const agent = sprite?.agent;
                if (!agent || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
                let score = 0;
                switch (agent.status) {
                    case AgentStatus.ERRORED: score = 92; break;
                    case AgentStatus.RATE_LIMITED: score = 80; break;
                    case AgentStatus.WAITING_ON_USER: score = 74; break;
                    case AgentStatus.WORKING: score = 44; break;
                    default: continue; // idle / unknown — not worth a dedicated shot
                }
                out.push({ key: `agent:${agent.id}`, score, box: boxAround(sprite.x, sprite.y, 64) });
            }
        }

        out.sort((a, b) => b.score - a.score);
        return out;
    }
}
