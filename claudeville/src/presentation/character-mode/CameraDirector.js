import { BUILDING_DEFS, normalizeBuildingType } from '../../config/buildings.js';
import { COMMAND_QUEUE } from '../../config/townPlan.js';
import { TILE_HALF_WIDTH, buildingCenterToWorld, tileToWorld } from './Projection.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { attentionCandidateBounds, fitAttentionFrame } from './AttentionFraming.js';

const SCORE_INTERVAL_MS = 3000;
const ORDINARY_IDLE_MS = 30000;
const USER_IDLE_MS = 45000;
const SELECTED_AGENT_GRACE_MS = 45000;
const MANUAL_EVENT_GRACE_MS = 30000;
const FOCUS_DWELL_MS = 40000;
// W5.2 (PI-P6) — calm Auto: an ordinary move waits 45 s after the last move
// (cue or ordinary). Cues keep their own cooldowns below.
const ORDINARY_MOVE_COOLDOWN_MS = 45000;
const GLOBAL_EVENT_COOLDOWN_MS = 15000;

const CENTRAL_RADIUS = 260;
const CENTRAL_FALLOFF_RADIUS = 360;
const FOCUS_NEIGHBOR_RADIUS = 320;
const ORDINARY_MAX_DISTANCE = 720;
const SPARSE_AGENT_LIMIT = 3;
// W5.2 — the comfort dead zone: the share of the frame a subject's centre may
// stray from the anchor before a move is worth it. Ordinary Auto widens to
// 0.26; the Ambient schedule keeps 0.18 and cues 0.22.
const ORDINARY_DEADZONE_SHARE = 0.26;
const AMBIENT_DEADZONE_SHARE = 0.18;
const EVENT_DEADZONE_SHARE = 0.22;
// W5.2 — Auto leaves a frame alone that already shows the village: when at
// least 80 % of the live bodies stand inside its inner 80 % (a 10 % inset on
// every side), no ordinary move runs.
const VILLAGE_SHOWN_SHARE = 0.8;
const VILLAGE_SHOWN_INSET = 0.1;

const GROUP_BOX_PAD = 135;
const SPARSE_BOX_PAD = 170;
const LONE_AGENT_BOX_PAD = 160;

// 5.1 — Ambient broadcast pacing. Holds are measured from the moment a shot
// SETTLES, so the real gap between two moves is a hold plus the glide that
// follows it; AMBIENT_MOVE_GAP_MS is the hard floor no chapter may undercut.
const AMBIENT_HOLD_MIN_MS = 20000;
const AMBIENT_HOLD_MAX_MS = 30000;
const AMBIENT_MOVE_GAP_MS = 18000;
const AMBIENT_CHAPTERS_PER_WIDE = 2;
const AMBIENT_WIDE_PADDING_PX = 200;
// 4.1/4.2 — a cohort or chapter shot frames its subject, not the Director's
// padded district box (which stays the comfort test): each member's body
// (the tallest stands 76 texels over its feet, plus its contact shadow) and
// the district's building, with a little air, so the medium scale can hold it.
const AMBIENT_SUBJECT_BODY = Object.freeze({ side: 20, up: 76, down: 6 });
const AMBIENT_SUBJECT_PADDING_PX = 32;
// 4.2 — a cohort shot frames the bodies actually at its building: folded on
// its footprint or visit tiles (`_foldBuildingType`), or standing or arriving
// on its apron, within the footprint's long side plus three tiles of its
// centre. A member chatting or walking at another building is not in the shot.
const AMBIENT_COHORT_APRON_TILES = 3;
const BUILDING_SPAN_TILES = new Map(BUILDING_DEFS.map(def => [def.type, Math.max(def.width || 1, def.height || 1)]));
const BUILDING_CENTER_BY_TYPE = new Map(BUILDING_DEFS.map(def => [def.type, buildingCenterToWorld(def)]));
const COMMAND_QUEUE_HEAD = COMMAND_QUEUE?.slots?.[0]
    ? tileToWorld(COMMAND_QUEUE.slots[0].tileX, COMMAND_QUEUE.slots[0].tileY)
    : (BUILDING_CENTER_BY_TYPE.get('command') || null);
// Long lateral moves in the ambient motion family (8.1: easeInOutSine, the
// distance-scaled duration ×2.2). 4.1/M8 — shots are sized by visible world
// area: the wide rests at `scales.wide` (z2 at 5120 × 1440 DPR 1) and
// cohorts and chapters at `scales.medium` at most (z3 there); ordinary Auto
// rests up to the Auto rest, `Camera.autoRestTier()` (relaxed 2026-11-23,
// operator decision).
// 5.2 — the chapter's bars stay up this long after the move settles.
const AMBIENT_CHAPTER_LETTERBOX_MS = 3000;

// 4.3 — `A` holds the attention set after its glide lands: a soft follow of
// the included bodies (and where the moving ones are headed) for up to 12 s,
// ending once every one of them has stood still for 1.5 s.
const ATTENTION_HOLD_MAX_MS = 12000;
const ATTENTION_HOLD_SETTLE_MS = 1500;
const ATTENTION_HOLD_PADDING_PX = 32;
// Fast enough to keep ahead of a working walk at z3 (≈ 270 screen px/s).
const ATTENTION_HOLD_MAX_SPEED_PX_PER_MS = 0.6;
const ATTENTION_HOLD_STIFFNESS_MS = 600;

const ORDINARY_PADDING_PX = 80;
const EVENT_PADDING_PX = Object.freeze({
    incident: 140,
    release: 140,
    arrival: 120,
    push: 140,
    default: 140,
});

const EVENT_KIND_COOLDOWN_MS = Object.freeze({
    incident: 30000,
    release: 45000,
    arrival: 60000,
    push: 60000,
    default: 45000,
});

const ACTION_WEIGHT = Object.freeze({
    [AgentStatus.ERRORED]: 18,
    [AgentStatus.RATE_LIMITED]: 17,
    [AgentStatus.WAITING_ON_USER]: 15,
    [AgentStatus.WAITING]: 11,
    [AgentStatus.WORKING]: 8,
    [AgentStatus.COMPLETED]: 1,
    [AgentStatus.IDLE]: 0,
});

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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
    return {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
    };
}

function boxForPoints(points, pad = GROUP_BOX_PAD) {
    const finite = (points || []).filter(point => (
        Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ));
    if (!finite.length) return null;
    const xs = finite.map(point => point.x);
    const ys = finite.map(point => point.y);
    return {
        minX: Math.min(...xs) - pad,
        minY: Math.min(...ys) - pad,
        maxX: Math.max(...xs) + pad,
        maxY: Math.max(...ys) + pad,
    };
}

function agentActionWeight(agent) {
    const statusWeight = ACTION_WEIGHT[agent?.status] ?? 0;
    return statusWeight
        + (agent?.currentTool ? 5 : 0)
        + (agent?.moving ? 3 : 0);
}

function valuesOfAgentSprites(agentSprites) {
    if (!agentSprites) return [];
    if (typeof agentSprites.values === 'function') return [...agentSprites.values()];
    if (Array.isArray(agentSprites)) return agentSprites;
    return [];
}

// The world box of an Ambient subject's bodies standing at `points`.
function ambientSubjectBox(points) {
    const finite = (points || []).filter(point => finiteNumber(point?.x) != null && finiteNumber(point?.y) != null);
    if (!finite.length) return null;
    const xs = finite.map(point => Number(point.x));
    const ys = finite.map(point => Number(point.y));
    return {
        minX: Math.min(...xs) - AMBIENT_SUBJECT_BODY.side,
        maxX: Math.max(...xs) + AMBIENT_SUBJECT_BODY.side,
        minY: Math.min(...ys) - AMBIENT_SUBJECT_BODY.up,
        maxY: Math.max(...ys) + AMBIENT_SUBJECT_BODY.down,
    };
}

// 4.3 — destination points for a walking, pending, or gate-entering attention
// sprite so `A` frames where the agent is headed on the initial glide and never
// recoils once the walk begins.
function attentionSpriteDestinations(sprite) {
    if (!sprite) return [];
    const points = [];
    const path = Array.isArray(sprite.waypoints) ? sprite.waypoints : [];
    const end = path.length ? path[path.length - 1] : { x: sprite.targetX, y: sprite.targetY };
    const endX = finiteNumber(end?.x);
    const endY = finiteNumber(end?.y);
    if (endX != null && endY != null) {
        const distinctTarget = finiteNumber(sprite.x) != null && finiteNumber(sprite.y) != null
            ? Math.hypot(endX - sprite.x, endY - sprite.y) > 2
            : false;
        if (sprite.moving || distinctTarget) points.push({ x: endX, y: endY });
    }
    if (sprite.isArrivalPending?.() || sprite._straightWalk) {
        const status = sprite.agent?.status;
        if (status === AgentStatus.WAITING_ON_USER && COMMAND_QUEUE_HEAD) {
            points.push(COMMAND_QUEUE_HEAD);
        } else {
            const bType = sprite.agent?.targetBuildingType || sprite.agent?.lastKnownBuildingType || 'command';
            const bCenter = BUILDING_CENTER_BY_TYPE.get(bType) || COMMAND_QUEUE_HEAD;
            if (bCenter) points.push(bCenter);
        }
    }
    return points;
}

function spriteInAttentionTransit(sprite) {
    if (!sprite) return false;
    if (sprite.moving || sprite.isArrivalPending?.() || sprite._straightWalk) return true;
    const tx = finiteNumber(sprite.targetX);
    const ty = finiteNumber(sprite.targetY);
    if (tx != null && ty != null && finiteNumber(sprite.x) != null && finiteNumber(sprite.y) != null) {
        if (Math.hypot(tx - sprite.x, ty - sprite.y) > 2) return true;
    }
    return Array.isArray(sprite.waypoints) && sprite.waypoints.length > 0;
}

// 4.3 — the world box the `A` hold keeps in view: every held body with its
// plate, and for a walking or pending body the same footprint at its destination.
function attentionHoldBox(sprites) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const extend = (point) => {
        const bounds = attentionCandidateBounds(point);
        box.minX = Math.min(box.minX, bounds.minX);
        box.minY = Math.min(box.minY, bounds.minY);
        box.maxX = Math.max(box.maxX, bounds.maxX);
        box.maxY = Math.max(box.maxY, bounds.maxY);
    };
    for (const sprite of sprites) {
        extend({ x: sprite.x, y: sprite.y });
        for (const dest of attentionSpriteDestinations(sprite)) extend(dest);
    }
    return box;
}

export function collectLiveAgents(agentSprites, { includePending = false } = {}) {
    const agents = [];
    for (const sprite of valuesOfAgentSprites(agentSprites)) {
        if (!sprite || sprite._archiveAnim || sprite.agent?.isDeparted || (!includePending && sprite.isArrivalPending?.())) continue;
        const source = sprite.agent;
        const id = String(source?.id || '');
        const x = finiteNumber(sprite.x);
        const y = finiteNumber(sprite.y);
        if (!id || x == null || y == null) continue;
        agents.push({
            id,
            x,
            y,
            status: source?.status || '',
            awaitingSince: source?.awaitingSince ?? null,
            currentTool: source?.currentTool || null,
            moving: Boolean(sprite.moving),
        });
    }
    return agents.sort((a, b) => a.id.localeCompare(b.id));
}

export function scoreAgentCandidates(agents) {
    const candidates = [];
    for (const agent of agents || []) {
        let nearbyCount = 0;
        let centrality = 0;

        for (const other of agents) {
            if (other.id === agent.id) continue;
            const distance = Math.hypot(other.x - agent.x, other.y - agent.y);
            if (distance <= CENTRAL_RADIUS) {
                nearbyCount += 1;
                centrality += 1 + (CENTRAL_RADIUS - distance) / CENTRAL_RADIUS * 0.6;
            } else if (distance <= CENTRAL_FALLOFF_RADIUS) {
                centrality += (CENTRAL_FALLOFF_RADIUS - distance)
                    / Math.max(1, CENTRAL_FALLOFF_RADIUS - CENTRAL_RADIUS)
                    * 0.5;
            }
        }

        const action = agentActionWeight(agent);
        const score = centrality * 10 + nearbyCount * 4 + action + 1;
        candidates.push({
            agentId: agent.id,
            x: agent.x,
            y: agent.y,
            score,
            nearbyCount,
            centrality,
            action,
        });
    }

    return candidates.sort((a, b) => (
        b.score - a.score
        || b.nearbyCount - a.nearbyCount
        || a.agentId.localeCompare(b.agentId)
    ));
}

export function selectFocus(previousFocus, candidates, now = nowMs()) {
    const top = candidates?.[0] || null;
    if (!top) return null;

    const current = previousFocus
        ? candidates.find(candidate => candidate.agentId === previousFocus.agentId)
        : null;

    if (!previousFocus || !current) {
        return focusFromCandidate(top, now);
    }

    if (top.agentId === current.agentId) {
        return {
            ...previousFocus,
            score: current.score,
            nearbyCount: current.nearbyCount,
        };
    }

    const dwellElapsed = now - (previousFocus.selectedAt ?? -Infinity);
    const hasContextGain = top.nearbyCount >= current.nearbyCount + 2;
    const hasScoreGain = top.score >= Math.max(current.score + 8, current.score * 1.3);
    if (dwellElapsed >= FOCUS_DWELL_MS || hasContextGain || hasScoreGain) {
        return focusFromCandidate(top, now);
    }

    return {
        ...previousFocus,
        score: current.score,
        nearbyCount: current.nearbyCount,
    };
}

function focusFromCandidate(candidate, now) {
    return {
        agentId: candidate.agentId,
        selectedAt: now,
        score: candidate.score,
        nearbyCount: candidate.nearbyCount,
    };
}

export function buildFocusBox(focusAgentId, agents, { includeAll = false } = {}) {
    const focus = (agents || []).find(agent => agent.id === focusAgentId) || null;
    if (!focus && !includeAll) return null;

    const points = includeAll
        ? [...(agents || [])]
        : [focus, ...(agents || []).filter(agent => (
            agent.id !== focus.id
            && Math.hypot(agent.x - focus.x, agent.y - focus.y) <= FOCUS_NEIGHBOR_RADIUS
        ))];

    if (!points.length) return null;
    const pad = includeAll
        ? SPARSE_BOX_PAD
        : points.length > 1
            ? GROUP_BOX_PAD
            : LONE_AGENT_BOX_PAD;
    return boxForPoints(points, pad);
}

// W5.2 — the share of `points` (feet, world px) standing inside the frame's
// inner region (`inset` of the width and height trimmed from every side);
// `toScreen(x, y)` maps a world point to canvas CSS px.
export function shareInInnerFrame(points, toScreen, width, height, inset = VILLAGE_SHOWN_INSET) {
    if (!points?.length || typeof toScreen !== 'function' || !(width > 0) || !(height > 0)) return 0;
    const minX = width * inset;
    const maxX = width * (1 - inset);
    const minY = height * inset;
    const maxY = height * (1 - inset);
    let inside = 0;
    for (const point of points) {
        const screen = toScreen(point.x, point.y);
        if (screen && screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) inside += 1;
    }
    return inside / points.length;
}

// W5.2 — true when the frame already shows the village: ≥ 80 % of the live
// bodies' feet stand in its inner 80 %. Ordinary Auto then has nothing to add.
export function frameShowsVillage(points, toScreen, width, height) {
    return shareInInnerFrame(points, toScreen, width, height) >= VILLAGE_SHOWN_SHARE;
}

// 5.1 — the wide composition: every active district in one frame. Districts
// come from the Director's work cohorts, so a district with nobody working is
// never part of the shot.
export function ambientWideBox(cohorts, pad = AMBIENT_WIDE_PADDING_PX) {
    const points = [];
    for (const cohort of cohorts || []) {
        if (!validBox(cohort?.box)) continue;
        points.push(
            { x: cohort.box.minX, y: cohort.box.minY },
            { x: cohort.box.maxX, y: cohort.box.maxY },
        );
    }
    return points.length ? boxForPoints(points, pad) : null;
}

// Which districts the wide shot promises. Returning "to the same wide" means
// returning to the saved pose while this key is unchanged.
export function ambientWideKey(cohorts) {
    return (cohorts || []).map(cohort => cohort.type).sort().join(',');
}

// Counts, never percentages, and never a fact the snapshot did not carry.
export function ambientWideCaption(cohorts) {
    let working = 0;
    let waiting = 0;
    for (const cohort of cohorts || []) {
        working += Number(cohort?.working) || 0;
        waiting += Number(cohort?.waiting) || 0;
    }
    const parts = [`Village · ${working} working`];
    if (waiting > 0) parts.push(`${waiting} waiting`);
    return parts.join(' · ');
}

export function ambientCohortCaption(cohort) {
    if (!cohort) return null;
    const parts = [`${cohort.label} · ${Number(cohort.working) || 0} working`];
    if ((Number(cohort.waiting) || 0) > 0) parts.push(`${cohort.waiting} waiting`);
    return parts.join(' · ');
}

// W4.2 (§4.6) — Village Strip (/strip/) framing and Promenade Rail schedule.
const STRIP_RAIL_HEIGHT_PX = 18;
const PROMENADE_GROUND_LIFT_SHARE = 0.12;
const PROMENADE_DRIFT_AMPLITUDE_TEXELS = 48;
const PROMENADE_DRIFT_SPEED_TEXELS_PER_SEC = 4;
const PROMENADE_ATTENTION_CYCLE_MS = 20000;

export const PROMENADE_STATIONS = Object.freeze(
    BUILDING_DEFS
        .filter((def) => def?.entrance && Number.isFinite(def.entrance.tileX) && Number.isFinite(def.entrance.tileY))
        .map((def) => {
            const world = tileToWorld(def.entrance.tileX, def.entrance.tileY);
            return Object.freeze({
                type: def.type,
                label: def.shortLabel || def.label || def.type,
                x: world.x,
                y: world.y,
            });
        })
        .sort((a, b) => a.x - b.x || a.y - b.y || a.type.localeCompare(b.type)),
);

const PROMENADE_STATION_BY_TYPE = new Map(PROMENADE_STATIONS.map((station) => [station.type, station]));

export const PROMENADE_PLAZA_REST = Object.freeze({
    type: 'plaza',
    label: 'PLAZA',
    x: 16,
    y: 600,
});

export function stripZoomForDpr(dpr) {
    const value = Number(dpr);
    return Number.isFinite(value) && value >= 2 ? 0.5 : 1;
}

function triangleWave(
    elapsedMs,
    amplitude = PROMENADE_DRIFT_AMPLITUDE_TEXELS,
    speedPerSec = PROMENADE_DRIFT_SPEED_TEXELS_PER_SEC,
) {
    const amp = Math.max(0, Number(amplitude) || 0);
    const speed = Math.max(0, Number(speedPerSec) || 0);
    if (amp === 0 || speed === 0) return 0;
    const periodSec = (4 * amp) / speed;
    const rawSec = Math.max(0, Number(elapsedMs) || 0) / 1000;
    const phase = ((rawSec % periodSec) + periodSec) % periodSec;
    const quarter = periodSec / 4;
    let value;
    if (phase < quarter) {
        value = phase * speed;
    } else if (phase < 3 * quarter) {
        value = 2 * amp - phase * speed;
    } else {
        value = phase * speed - 4 * amp;
    }
    const rounded = Math.round(value);
    if (rounded === 0) return 0;
    return Math.max(-amp, Math.min(amp, rounded));
}

export function promenadeTargetPose({
    station,
    stripHeight = 240,
    zoom = 1,
    elapsedMs = 0,
    reducedMotion = false,
} = {}) {
    const safeZoom = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1;
    const safeHeight = Number.isFinite(Number(stripHeight)) ? Number(stripHeight) : 240;
    const rows = Math.max(1, (safeHeight - STRIP_RAIL_HEIGHT_PX) / safeZoom);
    const drift = reducedMotion
        ? 0
        : triangleWave(elapsedMs, PROMENADE_DRIFT_AMPLITUDE_TEXELS, PROMENADE_DRIFT_SPEED_TEXELS_PER_SEC);
    const baseX = Number.isFinite(Number(station?.x)) ? Number(station.x) : PROMENADE_PLAZA_REST.x;
    const baseY = Number.isFinite(Number(station?.y)) ? Number(station.y) : PROMENADE_PLAZA_REST.y;
    const x = baseX + drift;
    const y = Math.round(baseY - PROMENADE_GROUND_LIFT_SHARE * rows);
    return {
        x,
        y,
        cx: x,
        cy: y,
        zoom: safeZoom,
        rows,
        drift,
    };
}

function occupiedPromenadeTypes({ agentSprites, snapshot, plaqueCounts, plaquePatrons }) {
    const occupied = new Set();
    const mark = (rawType) => {
        const type = normalizeBuildingType(rawType);
        if (type && PROMENADE_STATION_BY_TYPE.has(type)) occupied.add(type);
    };
    const addCountEntries = (counts) => {
        if (!counts) return;
        const entries = typeof counts.entries === 'function' ? counts.entries() : Object.entries(counts);
        for (const [type, raw] of entries) {
            const count = typeof raw === 'object' && raw !== null
                ? Number(raw.count ?? raw.occupied ?? 0)
                : Number(raw || 0);
            if (count > 0) mark(type);
        }
    };
    addCountEntries(plaqueCounts ?? snapshot?.plaqueCounts);
    addCountEntries(plaquePatrons ?? snapshot?.plaquePatrons);

    for (const cohort of snapshot?.workCohorts || []) {
        const count = Number(cohort?.total ?? cohort?.working ?? 0);
        if (count > 0 || (cohort?.agentIds?.length || 0) > 0) mark(cohort?.type);
    }
    for (const signal of snapshot?.buildingSignals || []) {
        const c = signal?.counts;
        if (!c) continue;
        const count = Number(c.occupied ?? 0)
            || (Number(c.working || 0) + Number(c.waiting || 0) + Number(c.errored || 0));
        if (count > 0) mark(signal?.type);
    }
    for (const sprite of valuesOfAgentSprites(agentSprites)) {
        const agent = sprite?.agent;
        if (!agent || agent.isDeparted || sprite._archiveAnim || sprite.isArrivalPending?.()) continue;
        if (sprite.visitRole === 'rest') {
            const restType = sprite._seatedSeat?.()?.building
                || sprite._restBuilding
                || sprite._foldBuildingType
                || sprite._lastBuildingType
                || agent.targetBuildingType
                || 'tavern';
            mark(restType);
            continue;
        }
        if (sprite.visitRole === 'queue') {
            const own = String(agent.targetBuildingType || agent.lastKnownBuildingType || '').trim();
            if (own && own !== 'command') mark(own);
            else mark('command');
            continue;
        }
        const fold = sprite._foldBuildingType || null;
        const route = sprite._lastBuildingType || null;
        const passing = Boolean(sprite.moving && fold && route && route !== fold);
        const type = (passing ? route : fold)
            || route
            || agent.targetBuildingType
            || agent.lastKnownBuildingType
            || agent.buildingType
            || agent.building
            || null;
        if (type) mark(type);
    }
    return occupied;
}

function nextOccupiedStationIndex(currentIndex, occupiedTypes) {
    if (!occupiedTypes || occupiedTypes.size === 0 || !PROMENADE_STATIONS.length) return -1;
    const count = PROMENADE_STATIONS.length;
    const start = currentIndex >= 0 ? (currentIndex + 1) % count : 0;
    for (let step = 0; step < count; step++) {
        const index = (start + step) % count;
        if (occupiedTypes.has(PROMENADE_STATIONS[index].type)) return index;
    }
    return -1;
}

function collectPromenadeAttentionAgents(agentSprites, snapshot) {
    const isActionNeeded = (status) => (
        status === AgentStatus.WAITING_ON_USER
        || status === AgentStatus.ERRORED
        || status === AgentStatus.RATE_LIMITED
    );
    let agents = collectLiveAgents(agentSprites, { includePending: true })
        .filter((agent) => isActionNeeded(agent.status));
    if (!agents.length && Array.isArray(snapshot?.attentionAgents)) {
        agents = snapshot.attentionAgents
            .filter((agent) => (
                agent
                && agent.id
                && isActionNeeded(agent.status)
                && finiteNumber(agent.x) != null
                && finiteNumber(agent.y) != null
            ))
            .map((agent) => ({
                id: String(agent.id),
                x: Number(agent.x),
                y: Number(agent.y),
                status: agent.status,
                awaitingSince: agent.awaitingSince ?? null,
            }));
    }
    return agents.sort((a, b) => {
        const ageA = Number.isFinite(a.awaitingSince) && a.awaitingSince > 0 ? a.awaitingSince : Infinity;
        const ageB = Number.isFinite(b.awaitingSince) && b.awaitingSince > 0 ? b.awaitingSince : Infinity;
        return ageA - ageB || a.id.localeCompare(b.id);
    });
}

export class CameraDirector {
    constructor(camera, { motionScale = 1, stripProfile = false } = {}) {
        this.camera = camera;
        this.motionScale = motionScale === 0 ? 0 : 1;
        this.autoMode = true;
        this.stripProfile = Boolean(stripProfile);

        this._focus = null;
        this._lastScoreAt = -Infinity;
        this._lastMoveAt = -Infinity;
        this._lastEventMoveAt = -Infinity;
        this._lastEventKindAt = new Map();
        this._latestSnapshot = null;
        // 5.1 — Ambient scheduler state. Non-null only while the explicit
        // control holds the frame; a revoked claim clears it and nothing
        // re-arms it on a timer (except the /strip/ Promenade Rail's 45 s
        // user-idle pause, tracked in `_promenadePaused`).
        this._ambient = null;
        this._promenadePaused = null;

        this._onCue = (cue) => this._handleCue(cue);
        this._unsubscribers = [
            eventBus.on('village:camera-cue', this._onCue),
        ];
    }

    setCamera(camera) {
        this.camera = camera;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    setAutoMode(on) {
        this.autoMode = Boolean(on);
        if (!this.autoMode) this._focus = null;
    }

    setStripProfile(enabled) {
        const next = Boolean(enabled);
        if (this.stripProfile === next) return;
        this.stripProfile = next;
        this._promenadePaused = null;
        if (this._ambient) {
            this._ambient.promenade = next ? this._createPromenadeState() : null;
        }
    }

    isStripProfile() {
        return this.stripProfile;
    }

    getPromenadeState() {
        if (!this.stripProfile) return null;
        const prom = this._ambient?.promenade || null;
        return {
            active: this.isAmbient(),
            paused: Boolean(this._promenadePaused),
            mode: prom?.mode || 'none',
            station: prom?.station || null,
            stationIndex: prom?.stationIndex ?? this._promenadePaused?.stationIndex ?? -1,
            attentionAgentId: prom?.attentionAgentId || null,
            zoom: prom?.zoom ?? stripZoomForDpr(this.camera?._dpr?.() || this.camera?.canvas?._claudeVilleDpr || 1),
        };
    }

    _createPromenadeState() {
        return {
            mode: 'none',
            stationIndex: -1,
            stationKey: '',
            station: null,
            anchor: null,
            settledAt: -Infinity,
            lastDrift: 0,
            attentionAgentId: null,
            attentionStartedAt: -Infinity,
            attentionSettledAt: -Infinity,
            zoom: stripZoomForDpr(this.camera?._dpr?.() || this.camera?.canvas?._claudeVilleDpr || 1),
        };
    }

    // C6 — enter/leave Ambient. Entry is only ever an explicit operator act:
    // this method has exactly one caller, the World's Ambient control.
    setAmbient(on) {
        const camera = this.camera;
        if (!camera?.claimOwner) return false;
        if (!on) {
            this._ambient = null;
            this._promenadePaused = null;
            camera.releaseOwner('ambient');
            return false;
        }
        const claim = camera.claimOwner('ambient');
        if (!claim) return false;
        camera.stopFollow();
        this._focus = null;
        this.attentionFrame = null;
        this._promenadePaused = null;
        this._ambient = {
            epoch: claim.epoch,
            phase: 'none',
            chapters: 0,
            subjectType: null,
            subjectIds: null,
            shotKey: '',
            caption: null,
            wide: null,
            wideKey: '',
            holdUntil: 0,
            holdExtended: false,
            lastMoveAt: -Infinity,
            settled: true,
            staticFrame: false,
            seenChapters: new Set(),
            promenade: this.stripProfile ? this._createPromenadeState() : null,
        };
        return true;
    }

    isAmbient() {
        return this.camera?.owner === 'ambient' && Boolean(this._ambient);
    }

    // The factual caption the frame renderer draws while Ambient owns the shot.
    getAmbientCaption() {
        if (!this.isAmbient()) return null;
        return this._ambient.caption || null;
    }

    frameAttention(agentSprites) {
        const camera = this.camera;
        if (!camera) return null;
        const candidates = collectLiveAgents(agentSprites, { includePending: true }).filter(agent =>
            agent.status === AgentStatus.WAITING_ON_USER
            || agent.status === AgentStatus.ERRORED
            || agent.status === AgentStatus.RATE_LIMITED);
        if (!candidates.length) {
            this.attentionFrame = null;
            return null;
        }
        // Chrome panels are flex siblings: the canvas is already the usable viewport.
        const pixelScale = camera.tierZoom?.(1) || 1;
        const viewport = {
            width: camera._viewportWidth() / pixelScale,
            height: camera._viewportHeight() / pixelScale,
        };
        const rawTiers = this._attentionTiers();
        // 4.3 — a walking or arrival-pending body is framed with where it is
        // headed, using the hold's exact 32 CSS px padding and capping transit
        // shots at medium so landing never recoils 1 → 3 → 1.
        const sprites = new Map(valuesOfAgentSprites(agentSprites).map(sprite => [String(sprite?.agent?.id || ''), sprite]));
        let hasTransit = false;
        const framed = candidates.map((candidate) => {
            const sprite = sprites.get(candidate.id);
            if (!sprite) return candidate;
            if (spriteInAttentionTransit(sprite)) hasTransit = true;
            const dests = attentionSpriteDestinations(sprite);
            return dests.length ? { ...candidate, bounds: attentionHoldBox([sprite]) } : candidate;
        });
        const mediumTier = camera.shotTier?.('medium');
        const capped = hasTransit && Number.isFinite(mediumTier)
            ? rawTiers.filter(tier => tier <= mediumTier + 1e-6)
            : rawTiers;
        const tiers = capped.length ? capped : rawTiers;
        const frame = fitAttentionFrame(framed, viewport, {
            padding: ATTENTION_HOLD_PADDING_PX / pixelScale,
            zooms: tiers,
        });
        camera.noteUserInput();
        camera.glideToWorld({
            minX: frame.center.x, maxX: frame.center.x,
            minY: frame.center.y, maxY: frame.center.y,
        }, { maxZoom: frame.zoom, paddingPx: 0, owner: 'user', userAdjustedOnComplete: true });
        this.attentionFrame = {
            ...frame,
            tiers,
            focusedAgentId: frame.included[0] || frame.excluded[0],
            inputAt: camera._lastUserInputAt,
            // 4.3 — the hold starts when the glide lands (_updateAttentionHold).
            hold: { startedAt: null, stillSince: null, done: false },
        };
        return this.attentionFrame;
    }

    // 4.1 — `A` tries the close, medium and wide scales, then tier 1 (the
    // whole island on the ultrawide, where the wide is z2) before it would
    // leave an action-needed agent out of the shot.
    _attentionTiers() {
        const camera = this.camera;
        const scales = ['close', 'medium', 'wide'].map(name => camera?.shotTier?.(name)).filter(Number.isFinite);
        if (!scales.length) return [3, 2, 1];
        return [...new Set([...scales, 1])].sort((a, b) => b - a);
    }

    // 4.3 — hold the attention set after its glide lands. Each update, until
    // genuine input, soft-follow the included bodies (each moving body's box
    // extended to where it is headed) on the operator's own frame: owner
    // 'user', pans preferred, never zooming in. The hold ends once every
    // included body has stood still 1.5 s, after 12 s, or the moment anything
    // else takes the frame (input clears the frame in update(); a follow, `F`
    // or Ambient change the owner). A body the frame can no longer
    // hold moves to `excluded`, never silently. Reduced motion never follows:
    // it re-cuts once, when the set settles.
    _updateAttentionHold(now, dt, agentSprites) {
        const frame = this.attentionFrame;
        const hold = frame?.hold;
        const camera = this.camera;
        if (!hold || hold.done || !camera) return;
        if (camera.owner !== 'user' || camera._cameraOwner !== 'user' || camera.followTarget) {
            hold.done = true;
            return;
        }
        // The attention glide is still landing.
        if (camera.isDirectorGliding?.()) return;
        hold.startedAt ??= now;
        const sprites = this._attentionHoldSprites(agentSprites);
        if (!sprites.length) {
            hold.done = true;
            return;
        }
        if (sprites.some(sprite => sprite.moving || sprite.isArrivalPending?.())) hold.stillSince = null;
        else hold.stillSince ??= now;
        const settled = hold.stillSince != null && now - hold.stillSince >= ATTENTION_HOLD_SETTLE_MS;
        const expired = now - hold.startedAt >= ATTENTION_HOLD_MAX_MS;
        if (this.motionScale <= 0 || camera._reducedMotion) {
            if (settled || expired) {
                this._followAttentionSet(sprites, dt);
                hold.done = true;
            }
            return;
        }
        if (expired) {
            hold.done = true;
            return;
        }
        const moved = this._followAttentionSet(sprites, dt);
        if (settled && !moved) hold.done = true;
    }

    // The included sprites still in the village, oldest decision first.
    _attentionHoldSprites(agentSprites) {
        const byId = new Map();
        for (const sprite of valuesOfAgentSprites(agentSprites)) {
            const id = String(sprite?.agent?.id || '');
            if (id) byId.set(id, sprite);
        }
        const sprites = [];
        for (const id of this.attentionFrame.included) {
            const sprite = byId.get(id);
            if (!sprite || sprite._archiveAnim || sprite.agent?.isDeparted) continue;
            if (finiteNumber(sprite.x) == null || finiteNumber(sprite.y) == null) continue;
            sprites.push(sprite);
        }
        return sprites;
    }

    _followAttentionSet(sprites, dt) {
        const camera = this.camera;
        const frame = this.attentionFrame;
        const minTier = Math.min(...frame.tiers);
        const fitZoom = camera.tierZoom?.(minTier) || 1;
        const width = camera._viewportWidth();
        const height = camera._viewportHeight();
        const fits = box => (box.maxX - box.minX) * fitZoom + ATTENTION_HOLD_PADDING_PX * 2 <= width
            && (box.maxY - box.minY) * fitZoom + ATTENTION_HOLD_PADDING_PX * 2 <= height;
        const members = [...sprites];
        let box = attentionHoldBox(members);
        // Overflow: the newest decisions leave the held set first, into the
        // excluded count the overlay states.
        while (members.length > 1 && !fits(box)) {
            const id = String(members.pop().agent?.id || '');
            frame.included = frame.included.filter(included => included !== id);
            frame.excluded = [...frame.excluded, id];
            box = attentionHoldBox(members);
        }
        return camera.softFollowWorldBox(box, {
            dt,
            paddingPx: ATTENTION_HOLD_PADDING_PX,
            maxZoom: frame.zoom,
            minZoom: minTier,
            owner: 'user',
            preferPan: true,
            allowZoomIn: false,
            maxSpeedPxPerMs: ATTENTION_HOLD_MAX_SPEED_PX_PER_MS,
            stiffnessMs: ATTENTION_HOLD_STIFFNESS_MS,
        });
    }

    dispose() {
        for (const unsubscribe of this._unsubscribers.splice(0)) {
            unsubscribe?.();
        }
        if (this._ambient) {
            this.camera?.releaseOwner?.('ambient');
            this._ambient = null;
        }
        this._promenadePaused = null;
        this._focus = null;
        this.attentionFrame = null;
        this._latestSnapshot = null;
        this._lastEventKindAt.clear();
    }

    update(frame = {}) {
        const { now = nowMs(), dt = 16, agentSprites = null, snapshot = null } = frame;
        this._latestSnapshot = snapshot || null;
        if (this.attentionFrame && this.attentionFrame.inputAt !== this.camera?._lastUserInputAt) {
            this.attentionFrame = null;
        }
        if (this.attentionFrame) this._updateAttentionHold(now, dt, agentSprites);
        // C6 — Ambient owns the frame exclusively while its claim stands; the
        // timed Auto policy below never runs against it. A revoked claim (any
        // genuine input) drops the schedule and hands Auto back untouched; in
        // the /strip/ profile, the Promenade Rail pauses for USER_IDLE_MS (45 s)
        // before resuming.
        if (this._ambient && this.camera?.owner !== 'ambient') {
            if (this.stripProfile) {
                const prevProm = this._ambient.promenade || null;
                this._ambient = null;
                this._pausePromenade(now, prevProm?.stationIndex ?? -1);
                return;
            }
            this._ambient = null;
        }
        if (this.stripProfile) {
            if (this._ambient) this._updatePromenade(now, frame);
            else if (this._promenadePaused) this._updatePromenadePause(now, frame);
            return;
        }
        if (this._ambient) {
            this._updateAmbient(now, agentSprites, snapshot);
            return;
        }
        if (!this.autoMode || this.motionScale <= 0 || !this.camera) return;
        if (now - this._lastScoreAt < SCORE_INTERVAL_MS) return;
        if (!this._canCameraMove(now, { snapshot, ordinary: true })) return;

        this._lastScoreAt = now;
        const agents = collectLiveAgents(agentSprites);
        if (!agents.length) {
            this._focus = null;
            return;
        }
        // W5.2 — a frame that already shows the village is left alone.
        if (this._frameShowsVillage(agents)) return;

        const candidates = scoreAgentCandidates(agents);
        const nextFocus = selectFocus(this._focus, candidates, now);
        if (!nextFocus) return;
        this._focus = nextFocus;

        const includeAll = agents.length <= SPARSE_AGENT_LIMIT;
        const box = this._ordinaryFocusBox(nextFocus.agentId, agents, { includeAll });
        if (!validBox(box) || this._isFrameComfortable(box, { ordinary: true })) return;
        if (now - this._lastMoveAt < ORDINARY_MOVE_COOLDOWN_MS) return;

        const distance = this._distanceFromCurrentCenter(boxCenter(box));
        if (distance > ORDINARY_MAX_DISTANCE) return;

        const options = this._ordinaryGlideOptions(agents);
        if (!this._wouldMoveEnough(box, options)) return;
        if (!this._canCameraMove(now, { snapshot, ordinary: true })) return;

        if (this.camera.glideToWorld(box, options)) {
            this._lastMoveAt = now;
            this._lastScoreAt = now;
        }
    }

    // 5.1 — the broadcast: a wide shot of the active districts, a patient
    // lateral move to the busiest real work cohort, an earned chapter, then a
    // return to the same wide. Nothing here rotates on a clock for its own
    // sake: every replacement shot has to be a different real subject, and a
    // subject that is already comfortably framed is left alone.
    _updateAmbient(now, agentSprites, snapshot) {
        const camera = this.camera;
        const state = this._ambient;
        const cohorts = (snapshot?.workCohorts || []).filter(cohort => validBox(cohort?.box));

        // Reduced motion: one static overview with the same counts, no moves.
        if (this.motionScale <= 0 || camera._reducedMotion) {
            this._ambientStaticOverview(state, cohorts, agentSprites);
            return;
        }

        if (camera.isDirectorGliding()) {
            state.settled = false;
            return;
        }
        if (!state.settled) {
            state.settled = true;
            state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
            state.holdExtended = false;
            // The wide is the return address; only a wide shot may set it.
            if (state.phase === 'wide') {
                state.wide = camera.capturePose();
                state.wideEpoch = camera.inputEpoch;
            }
            return;
        }

        this._refreshAmbientCaption(state, cohorts);
        if (now - state.lastMoveAt < AMBIENT_MOVE_GAP_MS) return;

        const chapter = this._earnedAmbientChapter(snapshot, state);
        if (chapter && state.phase !== 'chapter' && state.chapters < AMBIENT_CHAPTERS_PER_WIDE) {
            if (this._startAmbientChapter(state, chapter, now)) return;
        }
        if (now < state.holdUntil) return;

        if (state.phase === 'none'
            || state.phase === 'chapter'
            || state.chapters >= AMBIENT_CHAPTERS_PER_WIDE
            || !cohorts.length) {
            this._startAmbientWide(state, cohorts, agentSprites, now);
            return;
        }
        this._startAmbientCohort(state, cohorts, now, agentSprites);
    }

    // Reduced motion holds exactly one composition: the overview, cut to once,
    // with live counts in the caption and no camera move ever after.
    _ambientStaticOverview(state, cohorts, agentSprites) {
        state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
        if (state.staticFrame) return;
        const box = this._ambientWideBoxOrAgents(cohorts, agentSprites);
        if (!validBox(box)) return;
        // Under reduced motion glideToWorld cuts directly — this is the cut,
        // at the wide shot scale like the moving broadcast's wide.
        const started = this.camera.glideToWorld(box, this._ambientGlideOptions('ambient:wide', {
            paddingPx: AMBIENT_WIDE_PADDING_PX,
            composition: { x: 0.5, y: 0.55 },
            wide: true,
            bodies: collectLiveAgents(agentSprites),
        }));
        if (!started) return;
        state.staticFrame = true;
        state.phase = 'wide';
        state.chapters = 0;
        state.shotKey = `wide:${ambientWideKey(cohorts)}`;
    }

    _ambientWideBoxOrAgents(cohorts, agentSprites) {
        const box = ambientWideBox(cohorts);
        if (validBox(box)) return box;
        // No cohort is working: the honest wide is still the live village, and
        // an empty village yields no box at all, so nothing moves.
        const agents = collectLiveAgents(agentSprites);
        return agents.length ? buildFocusBox(null, agents, { includeAll: true }) : null;
    }

    // Live counts on the shot already on screen. Text only — a caption never
    // becomes a reason to move the camera.
    _refreshAmbientCaption(state, cohorts) {
        if (state.phase === 'wide') {
            state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
            return;
        }
        if (state.phase !== 'cohort') return;
        const cohort = cohorts.find(entry => entry.type === state.subjectType);
        if (cohort) state.caption = { text: ambientCohortCaption(cohort), kind: 'cohort' };
    }

    _extendAmbientHold(state, now) {
        if (!state.holdExtended) {
            state.holdExtended = true;
            state.holdUntil = now + (AMBIENT_HOLD_MAX_MS - AMBIENT_HOLD_MIN_MS);
            return;
        }
        state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
    }

    _ambientGlideOptions(owner, { paddingPx, composition, letterboxHoldMs = 0, wide = false, bodies = null }) {
        const camera = this.camera;
        // MB-1 — where the wide and medium shot scales coincide (both z2 on
        // the 2268 × 1350 world of a 2508 × 1398 window) the broadcast had no
        // establishing shot and never zoomed: its wide steps out to the
        // survey (z1 there, the opening's scale), so the tour opens on the
        // whole island and dollies in to its cohorts. Elsewhere it is today's.
        const mediumTier = camera?.shotTier?.('medium') ?? 2;
        const surveyTier = camera?.shotTier?.('survey');
        const plainWide = camera?.shotTier?.('wide') ?? 1;
        const wideTier = plainWide === mediumTier && Number.isFinite(surveyTier) && surveyTier < plainWide
            ? surveyTier
            : plainWide;
        const base = {
            motion: 'ambient',
            paddingPx,
            owner,
            composition,
            letterboxHoldMs,
            letterbox: letterboxHoldMs > 0,
            // Ambient's composition survives a relayout instead of being
            // re-framed to content behind the broadcast's back.
            userAdjustedOnComplete: true,
        };
        // 4.1 — the wide is a fixed shot scale: the active village at
        // `scales.wide` (or the survey, above) from wherever the camera
        // stands. 4.2 — as the
        // establishing shot it keeps landmark crowns and plates whole, never
        // at the expense of a villager (`bodies`) it already shows whole.
        if (wide) return { ...base, maxZoom: wideTier, minZoom: wideTier, keepLandmarks: true, bodies };
        // Leaving the wide for a cohort or chapter is the one ambient zoom: a
        // single step in to `scales.medium` at the end of the pan (8.1).
        // Between cohorts Ambient pans; it does not drum the zoom.
        const tier = camera?.currentZoomTier?.();
        const fromWide = !Number.isFinite(tier) || tier <= wideTier;
        return {
            ...base,
            maxZoom: camera?.shotTier?.('medium') ?? 2,
            minZoom: Math.min(1, camera?.shotTier?.('wide') ?? 1),
            preferPan: true,
            allowZoomIn: fromWide,
            zoomHysteresis: fromWide ? 0 : 1.35,
        };
    }

    _startAmbientWide(state, cohorts, agentSprites, now) {
        const camera = this.camera;
        const key = ambientWideKey(cohorts);
        const options = this._ambientGlideOptions('ambient:wide', {
            paddingPx: AMBIENT_WIDE_PADDING_PX,
            composition: { x: 0.5, y: 0.55 },
            wide: true,
            bodies: collectLiveAgents(agentSprites),
        });

        // The same wide, exactly: the saved pose, while the districts and the
        // input epoch it was composed for still stand.
        const canReturn = state.wide
            && state.wideKey === key
            && state.wideEpoch === camera.inputEpoch;
        let started = canReturn && camera.glideToPose(state.wide, {
            owner: 'ambient:wide',
            motion: 'ambient',
        });

        if (!started) {
            const box = this._ambientWideBoxOrAgents(cohorts, agentSprites);
            if (!validBox(box)) {
                this._extendAmbientHold(state, now);
                return false;
            }
            if (state.phase === 'wide' && this._isFrameComfortable(box)) {
                this._extendAmbientHold(state, now);
                return false;
            }
            if (!this._wouldMoveEnough(box, options)) {
                state.phase = 'wide';
                state.chapters = 0;
                state.wideKey = key;
                state.wide = camera.capturePose();
                state.wideEpoch = camera.inputEpoch;
                state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
                this._extendAmbientHold(state, now);
                return false;
            }
            started = camera.glideToWorld(box, options);
            if (started) {
                state.wide = null;
                state.wideKey = key;
            }
        }
        if (!started) {
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'wide';
        state.chapters = 0;
        state.subjectType = null;
        state.subjectIds = null;
        state.shotKey = `wide:${key}`;
        state.caption = { text: ambientWideCaption(cohorts), kind: 'wide' };
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    _startAmbientCohort(state, cohorts, now, agentSprites = null) {
        // Cohorts arrive busiest-first and every one of them has live work, so
        // the broadcast never travels to an empty building to fill time.
        const candidate = cohorts.find(cohort => cohort.type !== state.subjectType) || null;
        if (!candidate) {
            this._extendAmbientHold(state, now);
            return false;
        }
        const shotKey = `cohort:${candidate.contextKey}`;
        const options = this._ambientGlideOptions('ambient:cohort', {
            paddingPx: AMBIENT_SUBJECT_PADDING_PX,
            composition: { x: 0.5, y: 0.5 },
        });
        // A comfortable frame, or the same real context as the shot already on
        // screen, is not worth a move.
        if (state.shotKey === shotKey || this._isFrameComfortable(candidate.box)) {
            this._extendAmbientHold(state, now);
            return false;
        }
        const cohortSubject = this._cohortSubject(candidate, agentSprites);
        const subject = cohortSubject?.box || candidate.box;
        if (!this._wouldMoveEnough(subject, options) || !this.camera.glideToWorld(subject, options)) {
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'cohort';
        state.chapters += 1;
        state.subjectType = candidate.type;
        state.subjectIds = cohortSubject?.ids || [];
        state.shotKey = shotKey;
        state.caption = { text: ambientCohortCaption(candidate), kind: 'cohort' };
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    // 4.1/4.2 — the bodies of the members standing at the district's building
    // (see AMBIENT_COHORT_APRON_TILES), with the building; the building alone
    // when none of them is there yet. `ids` are the shot's cohort, published on
    // the Ambient state as `subjectIds` once the move starts.
    _cohortSubject(cohort, agentSprites) {
        const ids = new Set(cohort.agentIds || []);
        const center = cohort.center;
        const span = BUILDING_SPAN_TILES.get(cohort.type) ?? 1;
        const radius = (span + AMBIENT_COHORT_APRON_TILES) * TILE_HALF_WIDTH;
        const present = valuesOfAgentSprites(agentSprites).filter((sprite) => {
            if (!ids.has(String(sprite?.agent?.id || ''))) return false;
            if (!Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return false;
            const fold = sprite._foldBuildingType || null;
            if (fold) return fold === cohort.type;
            return Boolean(center) && Math.hypot(sprite.x - center.x, sprite.y - center.y) <= radius;
        });
        const box = ambientSubjectBox([...present.map(sprite => ({ x: sprite.x, y: sprite.y })), center]);
        return box ? { box, ids: present.map(sprite => String(sprite.agent.id)).sort() } : null;
    }

    // 5.2 — one chapter per real incident identity. Concurrent incidents reach
    // this as a single chapter carrying an exact count, so a storm cannot queue
    // a parade of shots.
    _earnedAmbientChapter(snapshot, state) {
        const chapter = snapshot?.incidentChapter;
        if (!chapter?.id || !validBox(chapter.box)) return null;
        if (state.seenChapters.has(chapter.id)) return null;
        return chapter;
    }

    _startAmbientChapter(state, chapter, now) {
        const camera = this.camera;
        state.seenChapters.add(chapter.id);
        const caption = { text: chapter.caption, kind: 'chapter', chapterId: chapter.id };

        // Save the return address before leaving it: pose plus input epoch.
        if (!state.wide || state.wideEpoch !== camera.inputEpoch) {
            state.wide = camera.capturePose();
            state.wideEpoch = camera.inputEpoch;
        }

        const options = this._ambientGlideOptions('ambient:chapter', {
            paddingPx: AMBIENT_SUBJECT_PADDING_PX,
            composition: { x: 0.5, y: 0.5 },
            letterboxHoldMs: AMBIENT_CHAPTER_LETTERBOX_MS,
        });
        const subject = ambientSubjectBox([chapter.center]) || chapter.box;
        // Already in frame: the chapter is its caption, not a pointless move.
        if (this._isFrameComfortable(chapter.box, { event: true })
            || !this._wouldMoveEnough(subject, options)
            || !camera.glideToWorld(subject, options)) {
            state.caption = caption;
            this._extendAmbientHold(state, now);
            return false;
        }
        state.phase = 'chapter';
        state.chapters += 1;
        state.subjectType = null;
        state.subjectIds = null;
        state.shotKey = `chapter:${chapter.id}`;
        state.caption = caption;
        state.lastMoveAt = now;
        state.settled = false;
        return true;
    }

    // W4.2 (§4.6) — Promenade Rail pause/resume on operator pan or zoom (45 s).
    _pausePromenade(now, stationIndex = -1) {
        const camera = this.camera;
        const rawIdle = typeof camera?.getUserIdleMs === 'function' ? camera.getUserIdleMs(now) : NaN;
        const cameraClockAligned = Number.isFinite(rawIdle) && rawIdle >= -1000 && rawIdle < USER_IDLE_MS;
        this._promenadePaused = {
            pausedAtNow: now,
            inputEpoch: camera?.inputEpoch ?? 0,
            lastUserInputAt: camera?._lastUserInputAt ?? null,
            cameraClockAligned,
            stationIndex,
        };
    }

    _updatePromenadePause(now, frame) {
        const camera = this.camera;
        const pause = this._promenadePaused;
        if (!camera || !pause) return;

        // Refresh the 45 s timer if the operator panned or zoomed again while paused.
        const currentEpoch = camera.inputEpoch ?? 0;
        const currentInputAt = camera._lastUserInputAt ?? null;
        if (currentEpoch !== pause.inputEpoch || currentInputAt !== pause.lastUserInputAt) {
            this._pausePromenade(now, pause.stationIndex);
            return;
        }

        if (camera.dragging || camera._momentum || camera._zoomAnimation || camera._snapZoom || camera.followTarget) {
            pause.pausedAtNow = now;
            return;
        }

        const idleMs = pause.cameraClockAligned && typeof camera.getUserIdleMs === 'function'
            ? camera.getUserIdleMs(now)
            : (now - pause.pausedAtNow);
        if (idleMs < USER_IDLE_MS) return;

        const resumeIndex = pause.stationIndex;
        this._promenadePaused = null;
        if (!this.setAmbient(true)) return;
        if (this._ambient?.promenade) {
            this._ambient.promenade.stationIndex = resumeIndex;
        }
        this._updatePromenade(now, frame);
    }

    // W4.2 (§4.6) — Promenade Rail schedule inside Ambient mode for /strip/.
    // Owner stays `'ambient'`, motion stays `'ambient'` (shipped `glideToPose`).
    _updatePromenade(now, frame) {
        const camera = this.camera;
        const state = this._ambient;
        if (!camera || !state) return;

        const prom = state.promenade || (state.promenade = this._createPromenadeState());
        const reducedMotion = this.motionScale <= 0 || Boolean(camera._reducedMotion);
        const dpr = camera._dpr?.() || camera.canvas?._claudeVilleDpr || 1;
        const zoom = stripZoomForDpr(dpr);
        const viewportH = camera._viewportHeight?.() || camera.canvas?.clientHeight || 0;
        const stripHeight = viewportH > 0 ? viewportH + STRIP_RAIL_HEIGHT_PX : 240;
        prom.zoom = zoom;

        if (camera.dragging || camera._momentum || camera._zoomAnimation || camera._snapZoom || camera.followTarget) {
            return;
        }

        // Attention override: glide to oldest action-needed agent with the same
        // 0.12 * rows ground-line framing; cycle every 20 s when several exist.
        const attention = collectPromenadeAttentionAgents(frame.agentSprites, frame.snapshot);
        if (attention.length > 0) {
            this._updatePromenadeAttention(state, prom, attention, { now, stripHeight, zoom, reducedMotion });
            return;
        }

        if (prom.mode === 'attention') {
            prom.mode = 'station';
            prom.attentionAgentId = null;
            prom.attentionStartedAt = -Infinity;
            prom.attentionSettledAt = -Infinity;
            state.holdUntil = Math.min(state.holdUntil, now);
        }

        if (camera.isDirectorGliding?.()) {
            state.settled = false;
            return;
        }

        const occupied = occupiedPromenadeTypes(frame);

        if (prom.mode === 'none') {
            this._startPromenadeStation(state, prom, occupied, { now, stripHeight, zoom, reducedMotion });
            return;
        }

        if (!state.settled) {
            state.settled = true;
            state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
            state.holdExtended = false;
            prom.settledAt = now;
            prom.lastDrift = 0;
            return;
        }

        // Reduced motion keeps the initial static frame with zero drift.
        if (reducedMotion) return;

        this._applyPromenadeDrift(prom, { now, stripHeight, zoom });

        if (now - state.lastMoveAt < AMBIENT_MOVE_GAP_MS) return;
        if (now < state.holdUntil) return;

        this._startPromenadeStation(state, prom, occupied, { now, stripHeight, zoom, reducedMotion });
    }

    _updatePromenadeAttention(state, prom, attention, { now, stripHeight, zoom, reducedMotion }) {
        const camera = this.camera;
        const currentIndex = prom.mode === 'attention'
            ? attention.findIndex((agent) => agent.id === prom.attentionAgentId)
            : -1;

        if (prom.mode !== 'attention' || currentIndex === -1) {
            this._glidePromenadeAttention(state, prom, attention[0], { now, stripHeight, zoom, reducedMotion });
            return;
        }

        if (camera.isDirectorGliding?.()) {
            state.settled = false;
            return;
        }

        if (!state.settled) {
            state.settled = true;
            prom.settledAt = now;
            prom.attentionSettledAt = now;
            prom.lastDrift = 0;
            return;
        }

        const cycleAnchor = Number.isFinite(prom.attentionSettledAt)
            ? prom.attentionSettledAt
            : prom.attentionStartedAt;
        if (attention.length > 1 && now - cycleAnchor >= PROMENADE_ATTENTION_CYCLE_MS) {
            const next = attention[(currentIndex + 1) % attention.length];
            this._glidePromenadeAttention(state, prom, next, { now, stripHeight, zoom, reducedMotion });
            return;
        }

        const current = attention[currentIndex];
        prom.anchor = { x: current.x, y: current.y };
        if (!reducedMotion) {
            this._applyPromenadeDrift(prom, { now, stripHeight, zoom });
        }
    }

    _glidePromenadeAttention(state, prom, target, { now, stripHeight, zoom, reducedMotion }) {
        const pose = promenadeTargetPose({
            station: { x: target.x, y: target.y },
            stripHeight,
            zoom,
            elapsedMs: 0,
            reducedMotion,
        });
        const started = this.camera.glideToPose(pose, {
            owner: 'ambient',
            motion: 'ambient',
        });
        if (!started) return false;
        const gliding = Boolean(this.camera.isDirectorGliding?.());
        prom.mode = 'attention';
        prom.attentionAgentId = target.id;
        prom.attentionStartedAt = now;
        prom.attentionSettledAt = gliding ? -Infinity : now;
        prom.anchor = { x: target.x, y: target.y };
        prom.settledAt = now;
        prom.lastDrift = 0;
        state.phase = 'promenade-attention';
        state.subjectType = null;
        state.subjectIds = [target.id];
        state.shotKey = `promenade:attention:${target.id}`;
        state.caption = { text: `Attention · ${target.id}`, kind: 'attention', agentId: target.id };
        state.lastMoveAt = now;
        state.settled = !gliding;
        state.holdUntil = now + PROMENADE_ATTENTION_CYCLE_MS;
        state.holdExtended = false;
        return true;
    }

    _startPromenadeStation(state, prom, occupied, { now, stripHeight, zoom, reducedMotion }) {
        const nextIndex = nextOccupiedStationIndex(prom.stationIndex, occupied);
        const isPlaza = nextIndex < 0;
        const station = isPlaza ? PROMENADE_PLAZA_REST : PROMENADE_STATIONS[nextIndex];
        const nextKey = isPlaza ? 'plaza' : station.type;

        if (prom.mode === 'station' && prom.stationKey === nextKey && prom.anchor) {
            this._extendAmbientHold(state, now);
            return false;
        }

        const pose = promenadeTargetPose({
            station,
            stripHeight,
            zoom,
            elapsedMs: 0,
            reducedMotion,
        });
        const started = this.camera.glideToPose(pose, {
            owner: 'ambient',
            motion: 'ambient',
        });
        if (!started) {
            this._extendAmbientHold(state, now);
            return false;
        }
        const gliding = Boolean(this.camera.isDirectorGliding?.());
        prom.mode = 'station';
        prom.stationIndex = nextIndex;
        prom.stationKey = nextKey;
        prom.station = station;
        prom.anchor = { x: station.x, y: station.y };
        prom.settledAt = now;
        prom.lastDrift = 0;
        state.phase = 'promenade';
        state.subjectType = isPlaza ? null : station.type;
        state.subjectIds = null;
        state.shotKey = `promenade:${nextKey}`;
        state.caption = { text: station.label, kind: 'promenade', station: nextKey };
        state.lastMoveAt = now;
        state.settled = !gliding;
        state.holdUntil = now + AMBIENT_HOLD_MIN_MS;
        state.holdExtended = false;
        return true;
    }

    _applyPromenadeDrift(prom, { now, stripHeight, zoom }) {
        const camera = this.camera;
        if (!prom.anchor || typeof camera?._setCenter !== 'function') return;
        const elapsedMs = Math.max(0, now - prom.settledAt);
        const target = promenadeTargetPose({
            station: prom.anchor,
            stripHeight,
            zoom,
            elapsedMs,
            reducedMotion: false,
        });
        if (target.drift === prom.lastDrift) return;
        const restingZoom = camera.resolveRestingZoom ? camera.resolveRestingZoom(target.zoom) : target.zoom;
        camera._setCenter(target.cx, target.cy, restingZoom);
        prom.lastDrift = target.drift;
    }

    _handleCue(cue) {
        // Honor motionScale like update() does: without this guard event cues
        // slipped through under reduced motion and hard-cut the camera
        // (glideToWorld cuts directly when the camera has reduced motion on).
        // The static fallback for an event reframe is no move at all.
        if (this.stripProfile || !this.autoMode || this.motionScale <= 0 || !this.camera || !cue || !validBox(cue.box)) return;
        const now = nowMs();
        const kind = String(cue.kind || 'default');
        // Attention cohorts inform edge cues; only the explicit A command frames them.
        if (kind === 'incident') return;
        // C6 — Ambient composes its own chapters from the Director snapshot;
        // the timed cue policy must not glide underneath it.
        if (this.camera.owner === 'ambient') return;
        if (!this._canCameraMove(now, { snapshot: this._latestSnapshot, event: true })) return;
        if (now - this._lastEventMoveAt < GLOBAL_EVENT_COOLDOWN_MS) return;

        const kindCooldown = EVENT_KIND_COOLDOWN_MS[kind] || EVENT_KIND_COOLDOWN_MS.default;
        if (now - (this._lastEventKindAt.get(kind) ?? -Infinity) < kindCooldown) return;
        if (this._isFrameComfortable(cue.box, { event: true })) return;

        const options = this._eventGlideOptions(kind, cue.letterbox === true);
        if (!this._wouldMoveEnough(cue.box, options)) return;
        if (!this._canCameraMove(now, { snapshot: this._latestSnapshot, event: true })) return;

        if (this.camera.glideToWorld(cue.box, options)) {
            this._focus = null;
            this._lastMoveAt = now;
            this._lastScoreAt = now;
            this._lastEventMoveAt = now;
            this._lastEventKindAt.set(kind, now);
        }
    }

    _canCameraMove(now, { snapshot = null, ordinary = false, event = false } = {}) {
        const camera = this.camera;
        if (!camera) return false;
        if (this.attentionFrame?.inputAt === camera._lastUserInputAt) return false;
        if (
            camera.followTarget
            || camera.dragging
            || camera._momentum
            || camera._zoomAnimation
            || camera._snapZoom
            || camera.isDirectorGliding?.()
        ) return false;

        const idleFor = camera.getUserIdleMs ? camera.getUserIdleMs(now) : Infinity;
        if (snapshot?.selectedAgentId && idleFor < SELECTED_AGENT_GRACE_MS) return false;

        if (event) {
            return camera._cameraOwner !== 'user' || idleFor >= MANUAL_EVENT_GRACE_MS;
        }

        if (ordinary) {
            const requiredIdle = camera._cameraOwner === 'user' ? USER_IDLE_MS : ORDINARY_IDLE_MS;
            return idleFor >= requiredIdle;
        }

        return true;
    }

    // Build a medium-friendly subject box around the densest active focus so
    // ordinary Auto holds zoom 2 at 1080p/1440×900 instead of pulling out to
    // zoom 1 while off-frame districts remain covered by edge tallies.
    _ordinaryFocusBox(focusAgentId, agents, { includeAll = false } = {}) {
        const focus = (agents || []).find(agent => agent.id === focusAgentId) || null;
        if (!focus && !includeAll) return null;
        const camera = this.camera;
        const w = camera?._viewportWidth?.() || camera?.canvas?.clientWidth || 0;
        const h = camera?._viewportHeight?.() || camera?.canvas?.clientHeight || 0;
        const capTier = this._currentMaxZoom();
        const zoom = camera?.tierZoom?.(capTier) || camera?.zoom || 1;
        const maxW = w > 0 ? Math.max(120, (w - ORDINARY_PADDING_PX * 2) / zoom) : Infinity;
        const maxH = h > 0 ? Math.max(120, (h - ORDINARY_PADDING_PX * 2) / zoom) : Infinity;

        if (includeAll && agents?.length) {
            const allBox = ambientSubjectBox(agents);
            if (allBox && (allBox.maxX - allBox.minX) <= maxW && (allBox.maxY - allBox.minY) <= maxH) {
                return allBox;
            }
        }
        const seed = focus || agents?.[0];
        if (!seed) return null;
        const box = ambientSubjectBox([seed]);
        if (!box) return null;
        const neighbors = (agents || [])
            .filter(agent => agent.id !== seed.id && Math.hypot(agent.x - seed.x, agent.y - seed.y) <= FOCUS_NEIGHBOR_RADIUS)
            .sort((a, b) => Math.hypot(a.x - seed.x, a.y - seed.y) - Math.hypot(b.x - seed.x, b.y - seed.y));
        for (const neighbor of neighbors) {
            const nb = ambientSubjectBox([neighbor]);
            if (!nb) continue;
            const minX = Math.min(box.minX, nb.minX);
            const maxX = Math.max(box.maxX, nb.maxX);
            const minY = Math.min(box.minY, nb.minY);
            const maxY = Math.max(box.maxY, nb.maxY);
            if ((maxX - minX) <= maxW && (maxY - minY) <= maxH) {
                box.minX = minX;
                box.maxX = maxX;
                box.minY = minY;
                box.maxY = maxY;
            }
        }
        return box;
    }

    // 8.1 — glide durations come from CameraCurves (screen distance and zoom
    // ratio), so the options carry only framing.
    _ordinaryGlideOptions(bodies = null) {
        return {
            maxZoom: this._currentMaxZoom(),
            minZoom: Math.min(1, this.camera?.shotTier?.('wide') ?? 1),
            paddingPx: ORDINARY_PADDING_PX,
            owner: 'idle-auto',
            composition: { x: 0.5, y: 0.55 },
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
            // MB-1 (D8) — the policy above is unchanged; the frame it lands
            // on keeps landmark crowns whole (the Belfry's glasses included),
            // never at the expense of a villager it already shows whole.
            keepLandmarks: true,
            bodies,
        };
    }

    // 5.7 — release and incident cues carry their own letterbox; a cue never
    // grades the world (V3).
    _eventGlideOptions(kind, letterbox = false) {
        return {
            maxZoom: this._currentMaxZoom(),
            minZoom: Math.min(1, this.camera?.shotTier?.('wide') ?? 1),
            paddingPx: EVENT_PADDING_PX[kind] || EVENT_PADDING_PX.default,
            letterbox,
            owner: `cue:${kind}`,
            composition: { x: 0.5, y: kind === 'release' ? 0.56 : 0.53 },
            preferPan: true,
            allowZoomIn: false,
            zoomHysteresis: 1.35,
        };
    }

    // 4.1/M8 (relaxed 2026-11-23, operator decision) — the automatic cap: the
    // current resting tier, never closer than the medium shot scale (z2 at
    // 1920 × 1080 and 1440 × 900 DPR 1). With `allowZoomIn: false`, AUTO keeps
    // a settled or user-chosen medium view instead of pulling back to wide, and
    // never zooms in uninvited beyond medium.
    _currentMaxZoom() {
        const medium = this.camera?.autoRestTier?.() ?? this.camera?.shotTier?.('medium') ?? 2;
        const tier = this.camera?.currentZoomTier?.();
        return Number.isFinite(tier) ? Math.min(medium, tier) : medium;
    }

    _distanceFromCurrentCenter(point) {
        const current = this.camera?.currentCenterWorld?.();
        if (!current || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return 0;
        return Math.hypot(point.x - current.x, point.y - current.y);
    }

    _wouldMoveEnough(box, options) {
        const camera = this.camera;
        const pose = camera?._poseForWorldBox?.(box, options);
        if (!pose) return true;
        const zoom = Math.max(0.1, Number(camera.zoom) || 1);
        const screenDistance = Math.hypot(pose.x - camera.x, pose.y - camera.y) * zoom;
        const zoomDistance = Math.abs((pose.zoom || zoom) - zoom);
        return screenDistance >= 120 || zoomDistance >= 0.05;
    }

    // `ordinary` widens the centring dead zone for ordinary Auto (W5.2); the
    // Ambient schedule keeps 0.18 and cues 0.22.
    _isFrameComfortable(box, { event = false, ordinary = false } = {}) {
        const camera = this.camera;
        const w = camera?._viewportWidth?.() || camera?.canvas?.clientWidth || 0;
        const h = camera?._viewportHeight?.() || camera?.canvas?.clientHeight || 0;
        if (!camera?.worldToScreen || !w || !h || !validBox(box)) return false;

        const corners = [
            camera.worldToScreen(box.minX, box.minY),
            camera.worldToScreen(box.maxX, box.minY),
            camera.worldToScreen(box.maxX, box.maxY),
            camera.worldToScreen(box.minX, box.maxY),
        ];
        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        const margin = event
            ? Math.max(80, Math.min(160, Math.min(w, h) * 0.10))
            : Math.max(110, Math.min(190, Math.min(w, h) * 0.13));
        const visible = Math.min(...xs) >= margin
            && Math.max(...xs) <= w - margin
            && Math.min(...ys) >= margin
            && Math.max(...ys) <= h - margin;

        const center = boxCenter(box);
        const screenCenter = camera.worldToScreen(center.x, center.y);
        const anchorX = 0.5;
        const anchorY = event ? 0.53 : 0.55;
        const deadzoneShare = event ? EVENT_DEADZONE_SHARE : ordinary ? ORDINARY_DEADZONE_SHARE : AMBIENT_DEADZONE_SHARE;
        const deadzoneX = w * deadzoneShare;
        const deadzoneY = h * deadzoneShare;
        const centered = Math.abs(screenCenter.x - w * anchorX) <= deadzoneX
            && Math.abs(screenCenter.y - h * anchorY) <= deadzoneY;

        return visible && centered;
    }

    // W5.2 — does the frame already show ≥ 80 % of the live bodies in its
    // inner 80 %?
    _frameShowsVillage(agents) {
        const camera = this.camera;
        const w = camera?._viewportWidth?.() || camera?.canvas?.clientWidth || 0;
        const h = camera?._viewportHeight?.() || camera?.canvas?.clientHeight || 0;
        if (!camera?.worldToScreen || !w || !h) return false;
        return frameShowsVillage(agents, (x, y) => camera.worldToScreen(x, y), w, h);
    }
}
