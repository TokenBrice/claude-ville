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
//   - Never hijack a fresh manual view or active follow. Once the operator has
//     gone idle, the camera may gently re-enter automatic framing.
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

// #attract — continuous idle cinematographer. When enabled and the operator has
// sat idle, resolve a single weighted "action frame" from VillageDirector scenes
// and live agents. The camera centers that frame only when the current view no
// longer carries the story, avoiding the previous one-agent-at-a-time tour.
const MANUAL_CUE_GRACE_MS = 8000;
const ATTRACT_ENGAGE_MS = 18000; // genuine input-free time before auto framing resumes
const ATTRACT_DWELL_MS = 6500;   // minimum hold before changing story target
const ATTRACT_REFRESH_MS = 2800; // fastest same-target correction for moving clusters
const ATTRACT_GLIDE_MS = 1800;
const ATTRACT_MAX_ZOOM = 2;
const ATTRACT_PAD_PX = 150;
const ATTRACT_PREEMPT_SCORE = 18;
const ATTRACT_CENTER_DEADZONE = 0.15;
const ATTRACT_VISIBILITY_MARGIN = 0.12;
const ACTION_CLUSTER_RADIUS = 260;
const ACTIVE_AGENT_THRESHOLD = 24;

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function boxAround(x, y, half) {
    return { minX: x - half, minY: y - half, maxX: x + half, maxY: y + half };
}

function boxForPoints(points, pad) {
    if (!points?.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function finitePoint(point, extra = {}) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, ...extra };
}

function validBox(box) {
    return box
        && Number.isFinite(box.minX)
        && Number.isFinite(box.minY)
        && Number.isFinite(box.maxX)
        && Number.isFinite(box.maxY)
        && box.maxX >= box.minX
        && box.maxY >= box.minY;
}

function boxCenter(box) {
    return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

function candidate({ key, kind, score, box = null, points = null, pad = 96, grade = null, paddingPx = ATTRACT_PAD_PX } = {}) {
    const frameBox = validBox(box) ? box : boxForPoints(points || [], pad);
    if (!key || !validBox(frameBox)) return null;
    return {
        key,
        kind: kind || key.split(':')[0],
        score: Number(score) || 0,
        box: frameBox,
        center: boxCenter(frameBox),
        grade,
        paddingPx,
    };
}

function agentWeight(agent, sprite) {
    let weight = 0;
    switch (agent?.status) {
        case AgentStatus.ERRORED: weight = 108; break;
        case AgentStatus.RATE_LIMITED: weight = 98; break;
        case AgentStatus.WAITING_ON_USER: weight = 94; break;
        case AgentStatus.WAITING: weight = 68; break;
        case AgentStatus.WORKING: weight = 52; break;
        case AgentStatus.COMPLETED: weight = 12; break;
        case AgentStatus.IDLE: weight = 8; break;
        default: weight = 6; break;
    }
    if (sprite?.moving) weight += 16;
    if (agent?.currentTool) weight += 18;
    return weight;
}

function clusterPoints(points, radius = ACTION_CLUSTER_RADIUS) {
    const clusters = [];
    const sorted = [...points].sort((a, b) => b.weight - a.weight);
    for (const point of sorted) {
        let best = null;
        let bestDist = Infinity;
        for (const cluster of clusters) {
            const dist = Math.hypot(point.x - cluster.x, point.y - cluster.y);
            if (dist < bestDist) {
                best = cluster;
                bestDist = dist;
            }
        }
        if (!best || bestDist > radius) {
            clusters.push({
                x: point.x,
                y: point.y,
                weight: point.weight,
                points: [point],
            });
            continue;
        }
        best.points.push(point);
        best.weight += point.weight;
        best.x = best.points.reduce((sum, p) => sum + p.x * p.weight, 0) / best.weight;
        best.y = best.points.reduce((sum, p) => sum + p.y * p.weight, 0) / best.weight;
    }
    for (const cluster of clusters) {
        cluster.radius = cluster.points.reduce((max, p) => Math.max(max, Math.hypot(p.x - cluster.x, p.y - cluster.y)), 0);
    }
    return clusters.sort((a, b) => b.weight - a.weight);
}

function clusterKey(prefix, cluster) {
    const ids = cluster.points
        .map(point => point.id)
        .filter(Boolean)
        .sort()
        .slice(0, 6)
        .join('|');
    return `${prefix}:${cluster.points.length}:${ids || Math.round(cluster.x)}:${Math.round(cluster.y)}`;
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
        this._focusScore = 0;
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
            this._focusScore = 0;
        }
    }

    dispose() {
        this._off?.();
        this._off = null;
        this._lastFiredAt.clear();
        this._activeKind = null;
        this._focusKey = null;
        this._focusScore = 0;
    }

    _handleCue(cue) {
        const camera = this.camera;
        if (!camera || !cue || !cue.box) return;
        const kind = cue.kind;
        const priority = CUE_PRIORITY[kind] || 1;

        const now = nowMs();
        const idleFor = camera.getUserIdleMs ? camera.getUserIdleMs(now) : Infinity;

        // Yield to the operator: never fight a fresh manual view or active follow.
        if (camera.followTarget || (camera._cameraOwner === 'user' && idleFor < MANUAL_CUE_GRACE_MS)) return;

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
            owner: `cue:${kind}`,
        });
        if (!started) return;
        this._lastFiredAt.set(kind, now);
        this._activeKind = kind;
    }

    // #attract — called every frame by the renderer. When auto-mode is on and the
    // operator has been idle, keep the viewport centered on the strongest current
    // action frame. Reduced motion still participates; Camera cuts instead of
    // gliding.
    update({ now = nowMs(), agentSprites = null, snapshot = null } = {}) {
        const camera = this.camera;
        if (!this.autoMode || !camera) return;
        if (camera.followTarget) return;               // never fight a manual follow
        if (camera.isDirectorGliding?.()) return;      // one move at a time
        const idleFor = camera.getUserIdleMs ? camera.getUserIdleMs(now) : Infinity;
        if (idleFor < ATTRACT_ENGAGE_MS) return;       // operator may still be looking

        const candidates = this._scoreActionFrames(agentSprites, snapshot);
        if (!candidates.length) return;

        const pick = this._selectActionFrame(candidates, now);
        if (!pick) return;

        const started = camera.glideToWorld(pick.box, {
            duration: ATTRACT_GLIDE_MS,
            maxZoom: ATTRACT_MAX_ZOOM,
            paddingPx: pick.paddingPx || ATTRACT_PAD_PX,
            grade: pick.grade || null,
            owner: 'idle-auto',
        });
        if (!started) return;
        this._focusKey = pick.key;
        this._focusScore = pick.score;
        this._lastAutoMoveAt = now;
    }

    _selectActionFrame(candidates, now) {
        const top = candidates[0];
        const focused = this._focusKey ? candidates.find(item => item.key === this._focusKey) : null;
        const dwellElapsed = now - this._lastAutoMoveAt;
        const dwellMet = dwellElapsed >= ATTRACT_DWELL_MS;
        const referenceScore = focused?.score ?? this._focusScore ?? 0;
        const strongerStory = !focused || top.score >= referenceScore + ATTRACT_PREEMPT_SCORE;
        const pick = (!dwellMet && focused && !strongerStory) ? focused : top;
        const sameTarget = pick.key === this._focusKey;

        if (!dwellMet && !strongerStory && !sameTarget) return null;
        if (sameTarget && dwellElapsed < ATTRACT_REFRESH_MS) return null;

        if (this._isFrameComfortable(pick.box)) {
            this._focusKey = pick.key;
            this._focusScore = pick.score;
            return null;
        }
        return pick;
    }

    _isFrameComfortable(box) {
        const camera = this.camera;
        const w = camera?._viewportWidth?.() || camera?.canvas?.clientWidth || 0;
        const h = camera?._viewportHeight?.() || camera?.canvas?.clientHeight || 0;
        if (!camera?.worldToScreen || !w || !h || !validBox(box)) return false;
        const a = camera.worldToScreen(box.minX, box.minY);
        const b = camera.worldToScreen(box.maxX, box.maxY);
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        const margin = Math.max(96, Math.min(180, Math.min(w, h) * ATTRACT_VISIBILITY_MARGIN));
        const visible = minX >= margin && maxX <= w - margin && minY >= margin && maxY <= h - margin;
        const center = boxCenter(box);
        const screenCenter = camera.worldToScreen(center.x, center.y);
        const centerClose = Math.abs(screenCenter.x - w / 2) <= w * ATTRACT_CENTER_DEADZONE
            && Math.abs(screenCenter.y - h / 2) <= h * ATTRACT_CENTER_DEADZONE;
        return visible && centerClose;
    }

    // Rank frame-worthy action frames. The result is intentionally scene-shaped:
    // incidents and handoffs can include multiple points, building heat can win
    // over a lone worker, and active agent clusters hold the view steady.
    _scoreActionFrames(agentSprites, snapshot) {
        const out = [];

        const incidentPoints = [];
        for (const incident of (snapshot?.incidents || [])) {
            const agentPoint = finitePoint(incident.agent);
            const centerPoint = finitePoint(incident.center);
            if (agentPoint) incidentPoints.push(agentPoint);
            if (centerPoint) incidentPoints.push(centerPoint);
        }
        if (incidentPoints.length) {
            out.push(candidate({
                key: 'incidents',
                kind: 'incident',
                score: 112 + Math.min(24, incidentPoints.length * 4),
                points: incidentPoints,
                pad: 96,
                grade: { vignette: 0.4, worldTint: '#c0392b' },
            }));
        }

        const releaseCenter = finitePoint(snapshot?.releaseParade?.center);
        if (releaseCenter) {
            out.push(candidate({
                key: `release:${snapshot.releaseParade.id || snapshot.releaseParade.label || 'active'}`,
                kind: 'release',
                score: 82,
                box: boxAround(releaseCenter.x, releaseCenter.y, 132),
                grade: { vignette: 0.30, worldTint: '#f5c451' },
            }));
        }

        for (const handoff of (snapshot?.handoffs || [])) {
            const points = [finitePoint(handoff.from), finitePoint(handoff.to)].filter(Boolean);
            if (!points.length) continue;
            out.push(candidate({
                key: `handoff:${handoff.id || handoff.agentId || ''}:${handoff.targetAgentId || handoff.childId || ''}`,
                kind: 'handoff',
                score: 80 - Math.min(12, (Number(handoff.progress) || 0) * 12),
                points,
                pad: 108,
                grade: { vignette: 0.20, worldTint: '#7ac8d8' },
            }));
        }

        for (const team of (snapshot?.teams || [])) {
            const center = finitePoint(team);
            if (!center) continue;
            const memberCount = Array.isArray(team.members) ? team.members.length : 0;
            out.push(candidate({
                key: `team:${team.id || team.label || Math.round(center.x)}`,
                kind: 'team',
                score: 62 + Math.min(28, memberCount * 5),
                box: boxAround(center.x, center.y, Math.max(110, (Number(team.radius) || 0) + 82)),
                grade: { vignette: 0.18, worldTint: '#c084fc' },
            }));
        }

        for (const signal of (snapshot?.buildingSignals || [])) {
            const center = finitePoint(signal.center);
            if (!center) continue;
            const counts = signal.counts || {};
            const occupied = Number(counts.occupied || 0);
            const score = 54
                + (Number(signal.heat) || 0) * 36
                + Number(counts.errored || 0) * 20
                + Number(counts.waiting || 0) * 11
                + Number(counts.working || 0) * 5
                + (signal.recentTools?.length || 0) * 6;
            out.push(candidate({
                key: `building:${signal.type || signal.label || Math.round(center.x)}`,
                kind: 'building',
                score,
                box: boxAround(center.x, center.y, 126 + Math.min(86, occupied * 12)),
                grade: Number(counts.errored || 0) > 0
                    ? { vignette: 0.26, worldTint: '#c0392b' }
                    : null,
                paddingPx: 164,
            }));
        }

        for (const life of (snapshot?.lifecycle || [])) {
            const center = finitePoint(life.center);
            if (!center) continue;
            const arrival = life.kind === 'arrival';
            out.push(candidate({
                key: `life:${life.kind || 'event'}:${life.agentId || life.id || Math.round(center.x)}`,
                kind: 'lifecycle',
                score: arrival ? 56 : 42,
                box: boxAround(center.x, center.y, arrival ? 100 : 82),
                grade: arrival ? { vignette: 0.18, worldTint: '#7fc7c0' } : null,
            }));
        }

        if (agentSprites) {
            const points = [];
            for (const sprite of agentSprites.values()) {
                const agent = sprite?.agent;
                if (!agent || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
                const weight = agentWeight(agent, sprite);
                points.push({ id: agent.id, x: sprite.x, y: sprite.y, weight });
            }
            this._pushAgentClusterFrames(out, points);
        }

        return out
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
    }

    _pushAgentClusterFrames(out, points) {
        if (!points.length) return;
        const activePoints = points.filter(point => point.weight >= ACTIVE_AGENT_THRESHOLD);
        const storyPoints = activePoints.length ? activePoints : points.map(point => ({ ...point, weight: Math.max(6, point.weight * 0.35) }));
        const clusters = clusterPoints(storyPoints).slice(0, 3);
        for (const cluster of clusters) {
            const active = activePoints.length > 0;
            const box = boxForPoints(cluster.points, active ? 112 : 96);
            if (!validBox(box)) continue;
            out.push(candidate({
                key: clusterKey(active ? 'agents' : 'idle-agents', cluster),
                kind: active ? 'agent-cluster' : 'agent-overview',
                score: (active ? 46 : 24)
                    + Math.min(active ? 44 : 20, cluster.weight / (active ? 5 : 3))
                    + Math.min(14, cluster.points.length * 2),
                box,
                paddingPx: active ? 150 : 176,
            }));
        }

        if (activePoints.length >= 2) {
            const box = boxForPoints(activePoints, 132);
            const spread = Math.max(box.maxX - box.minX, box.maxY - box.minY);
            const totalWeight = activePoints.reduce((sum, point) => sum + point.weight, 0);
            out.push(candidate({
                key: `active-fleet:${activePoints.length}:${activePoints.map(point => point.id).sort().slice(0, 8).join('|')}`,
                kind: 'active-fleet',
                score: 50
                    + Math.min(34, totalWeight / 9)
                    + Math.min(12, activePoints.length * 2)
                    - Math.max(0, (spread - 780) / 32),
                box,
                paddingPx: 170,
            }));
        }
    }
}
