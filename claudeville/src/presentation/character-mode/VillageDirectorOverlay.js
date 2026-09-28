import { drawEventShape } from '../shared/EventShapes.js';
import { BUILDING_ACCENTS_RGB, INCIDENT_COLORS_RGB, WORLD_BODY_FONT_11 } from '../../config/theme.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { pulseBand01 } from './PulsePolicy.js';
import { TRAIL_ALPHA_STEPS, drawAgedTrailDots } from './TrailRenderer.js';
import { attentionCandidateBounds } from './AttentionFraming.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { cueNoteDue } from '../shared/audio/CueScore.js';

const TAU = Math.PI * 2;

const BUILDING_COLORS = BUILDING_ACCENTS_RGB;

const INCIDENT_COLORS = INCIDENT_COLORS_RGB;

function clamp(value, min = 0, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function rgba(rgb, alpha) {
    return `rgba(${rgb}, ${clamp(alpha)})`;
}

function parseTintRgb(grade) {
    const match = String(grade?.worldTint || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return null;
    return {
        r: clamp(parts[0] ?? 255, 0, 255),
        g: clamp(parts[1] ?? 255, 0, 255),
        b: clamp(parts[2] ?? 255, 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3]) : 1,
    };
}

// #3 — Grade authority. Lerp an `r, g, b` overlay string toward the active
// `grade.worldTint` so director halos pick up the time-of-day cast. Pure color
// transform with no time component — identical under reduced motion.
function gradeRgbUncached(rgbString, grade) {
    const tint = parseTintRgb(grade);
    if (!tint) return rgbString;
    const parts = String(rgbString || '').split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return rgbString;
    const w = clamp(tint.a, 0, 1);
    if (w <= 0) return rgbString;
    const r = Math.round(parts[0] + (tint.r - parts[0]) * w);
    const g = Math.round(parts[1] + (tint.g - parts[1]) * w);
    const b = Math.round(parts[2] + (tint.b - parts[2]) * w);
    return `${r}, ${g}, ${b}`;
}

// 5.8 — gradeRgb runs for nearly every overlay mark each frame while the tint
// string barely changes, so memoize on (rgb, worldTint). Bounded: cleared when
// it outgrows the mark-color × distinct-tint working set.
const GRADE_RGB_CACHE_LIMIT = 128;
const _gradeRgbCache = new Map();

function gradeRgb(rgbString, grade) {
    const tintText = String(grade?.worldTint || '');
    if (!tintText) return rgbString;
    const key = `${rgbString}|${tintText}`;
    const cached = _gradeRgbCache.get(key);
    if (cached !== undefined) return cached;
    const resolved = gradeRgbUncached(rgbString, grade);
    if (_gradeRgbCache.size >= GRADE_RGB_CACHE_LIMIT) _gradeRgbCache.clear();
    _gradeRgbCache.set(key, resolved);
    return resolved;
}

function signalColor(type) {
    return BUILDING_COLORS[type] || '226, 232, 240';
}

function incidentColor(kind) {
    return INCIDENT_COLORS[kind] || '250, 204, 21';
}

// 3.9 — overlay cadences ride the shared PulsePolicy bands instead of private
// sine speeds (`0.5 + Math.sin(now / speed) * 0.5`). pulseBand01 returns 0.5
// under reduced motion — the same static mid-value the legacy cadence used.
function motionPulse(now, scale, phase = 0, band = 'intrinsic') {
    return pulseBand01(band, now, scale, phase);
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function agentTrailColor(point = {}) {
    if (point.status === 'errored') return '248, 113, 113';
    if (point.status === 'waiting_on_user' || point.status === 'rate_limited') return '250, 204, 21';
    if (point.status === 'waiting') return '251, 146, 60';
    const palette = [
        '125, 211, 252',
        '134, 239, 172',
        '216, 180, 254',
        '94, 234, 212',
        '244, 196, 93',
    ];
    return palette[hashText(point.teamName || point.provider || point.id) % palette.length];
}

// S19 — the one ring grammar: a one-texel iso ellipse outline on the world
// texel grid (snapped fillRect runs, no anti-aliasing, no fill wash). Static:
// the caller never animates the radius, so reduced motion is identical.
function drawIsoRing(ctx, x, y, radius, rgb, alpha, skew = 0.45) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(alpha > 0)) return;
    const rx = Math.max(2, Math.round(radius));
    const ry = Math.max(1, Math.round(radius * skew));
    const cx = Math.round(x);
    const cy = Math.round(y);
    const half = dy => Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)));
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgba(rgb, alpha);
    for (let dy = -ry; dy <= ry; dy++) {
        const h = half(dy);
        if (Math.abs(dy) === ry) {
            ctx.fillRect(cx - h, cy + dy, h * 2 + 1, 1);
            continue;
        }
        // Span from this row's edge in to the next row outward, so the stair
        // stays connected on the flat top and bottom arcs.
        const outer = half(dy < 0 ? dy - 1 : dy + 1);
        const run = Math.max(1, h - outer);
        ctx.fillRect(cx - h, cy + dy, run, 1);
        ctx.fillRect(cx + h - run + 1, cy + dy, run, 1);
    }
    ctx.restore();
}

// The selected (or hovered) building's ring — the selection mark, drawn once
// in the district colour. Unselected buildings carry no halo: their activity
// reads from the plaque count, windows and pennant, not a pulsing wash.
function drawSignalHalo(ctx, signal, grade = null, { alpha = 0.72 } = {}) {
    if (!signal?.center) return;
    const rgb = gradeRgb(signalColor(signal.type), grade);
    const heat = clamp(signal.heat ?? 0.35);
    drawIsoRing(ctx, signal.center.x, signal.center.y + 4, 30 + heat * 24, rgb, alpha);
}

function drawReplay(ctx, samples, now, selectedAgentId = null) {
    if (!samples?.length) return;
    const byAgent = new Map();
    for (const sample of samples) {
        const age = now - sample.ts;
        if (age < 0 || age > 60_000) continue;
        for (const point of sample.points || []) {
            if (!point?.id) continue;
            let list = byAgent.get(point.id);
            if (!list) {
                list = [];
                byAgent.set(point.id, list);
            }
            list.push({ ...point, ts: sample.ts });
        }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const points of byAgent.values()) {
        if (points.length < 2) continue;
        const latest = points.at(-1);
        const rgb = agentTrailColor(latest);
        const selected = latest?.id && latest.id === selectedAgentId;
        // 3.10 — the replay run shares the hour-trail vocabulary
        // (TrailRenderer.drawAgedTrailDots: whole-texel dots, stepped alpha);
        // the tick marks + tail diamond below stay replay-only "live mode"
        // extras, also whole texels.
        drawAgedTrailDots(ctx, points, {
            now,
            maxAgeMs: 60_000,
            baseAlpha: selected ? 0.5 : 0.18,
            dot: selected ? 2 : 1,
            step: selected ? 4 : 3,
            rgbForPoint: () => rgb,
        });

        const tickEvery = selected ? 2 : 4;
        const tick = selected ? 2 : 1;
        for (let i = Math.max(0, points.length - 16); i < points.length; i += tickEvery) {
            const p = points[i];
            const alpha = (selected ? 0.8 : 0.42) * steppedFreshness(now - p.ts);
            ctx.fillStyle = rgba(rgb, (selected ? 0.52 : 0.24) * alpha);
            ctx.fillRect(Math.round(p.x) - (tick >> 1), Math.round(p.y) - 2 - (tick >> 1), tick, tick);
        }

        // The live head: a small texel diamond (rows never overlap, so the
        // screen blend lands once per texel).
        const tail = points.at(-1);
        ctx.fillStyle = rgba(rgb, 0.12 + 0.35 * steppedFreshness(now - tail.ts));
        const tx = Math.round(tail.x);
        const ty = Math.round(tail.y) - 2;
        const half = selected ? 2 : 1;
        for (let row = -half; row <= half; row++) {
            const span = half - Math.abs(row) + (selected ? 2 : 1);
            ctx.fillRect(tx - span, ty + row, span * 2 + 1, 1);
        }
    }
    ctx.restore();
}

// 1 while fresh, then down in TRAIL_ALPHA_STEPS whole steps across the
// replay's minute: stepped, never a smooth ramp.
function steppedFreshness(ageMs) {
    const fresh = 1 - clamp(ageMs / 60_000);
    return Math.max(1, Math.ceil(fresh * TRAIL_ALPHA_STEPS)) / TRAIL_ALPHA_STEPS;
}

function drawSignalRoutes(ctx, selected, { alphaScale = 1, dash = [6, 7], lineWidth = 1.2, grade = null } = {}) {
    if (!selected?.routes?.length) return;
    const rgb = gradeRgb(signalColor(selected.type), grade);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    for (const route of selected.routes) {
        if (!route?.from || !route?.to) continue;
        ctx.strokeStyle = rgba(rgb, (route.status === 'working' ? 0.40 : 0.24) * alphaScale);
        ctx.beginPath();
        const midX = (route.from.x + route.to.x) / 2;
        const midY = Math.min(route.from.y, route.to.y) - 26;
        ctx.moveTo(route.from.x, route.from.y - 4);
        ctx.quadraticCurveTo(midX, midY, route.to.x, route.to.y + 6);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
}

// S19 — teams carry no ground ring or aura wash: the council ring and the
// team trim on the robes already say who belongs together, and the ring
// grammar is reserved for selection and incidents.

function drawIncidents(ctx, incidents, grade = null) {
    if (!incidents?.length) return;
    // 3.9 — incidents are PRIMARY: the action-demanding reads the operator
    // must never lose. PRIMARY bypasses region culling by contract; the admit
    // call is kept for symmetry with the other governor clients. One static
    // pixel ring in the incident colour, at full strength while it holds.
    const governor = getActiveMarkGovernor();
    for (const incident of incidents) {
        const center = incident.agent || incident.center;
        if (!center) continue;
        if (governor && !governor.admit(MarkTier.PRIMARY, center.x, center.y).draw) continue;
        const rgb = gradeRgb(incidentColor(incident.kind), grade);
        const intensity = clamp(incident.intensity ?? 0.7, 0.2, 1);
        const fade = 1 - clamp(incident.progress ?? 0);
        drawIsoRing(ctx, center.x, center.y - 6, 24 + intensity * 32, rgb, 0.8 * fade, 0.44);
    }
}

// The handoff's message identity while it travels the arc.
function drawScrollMote(ctx, x, y, rgb, alpha, scale = 1) {
    const step = Math.max(1, Math.round(scale));
    drawEventShape(ctx, 'message-scroll', x - 8 * step, y - 8 * step, step, rgba(rgb, alpha));
}

// A five-step relief diamond: the mark that lands on the recovery cue's
// octave. Integer rows keep it on the pixel grid at every zoom.
function drawReliefDiamond(ctx, x, y, rgb, alpha) {
    const widths = [1, 3, 5, 7, 5, 3, 1];
    const left = Math.round(x);
    const top = Math.round(y) - 3;
    ctx.fillStyle = rgba(rgb, alpha);
    for (let row = 0; row < widths.length; row++) {
        const width = widths[row];
        ctx.fillRect(left - ((width - 1) / 2), top + row, width, 1);
    }
}

// Recovery is an incident closure, never a successful tool outcome. Its two
// marks are the two notes of the recovery cue: the bracket closes on the first
// bell, the relief diamond lifts on the octave. With no cue admitted — muted,
// budget-suppressed, or reduced motion — both are due at once, so a silent
// village still sees the whole closure.
function drawRecoveries(ctx, recoveries, motionScale, grade = null) {
    if (!recoveries?.length) return;
    const rgb = gradeRgb('134, 239, 172', grade);
    // 3.9 — recovery beats are SECONDARY: a welcome release of tension, but
    // never more important than a live incident or selection nearby.
    const governor = getActiveMarkGovernor();
    const noteNow = performance.now();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const recovery of recoveries) {
        const center = recovery.center;
        if (!center || !Number.isFinite(center.x)) continue;
        const gate = governor
            ? governor.admit(MarkTier.SECONDARY, center.x, center.y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        const progress = clamp(recovery.progress ?? 0);
        const fade = (motionScale ? (1 - progress) : 1) * gate.alpha;
        if (fade <= 0.02) continue;
        const agentId = recovery.agentId ?? null;
        if (motionScale && !cueNoteDue('recovery', agentId, 0, noteNow)) continue;
        // The relief lifts as it fades, echoing the agent straightening up.
        const lift = motionScale ? progress * 12 : 0;
        const y = center.y - 16 - lift;
        drawEventShape(ctx, 'incident-bracket', center.x - 8, y - 8, 1, rgba(rgb, fade));
        if (!motionScale || cueNoteDue('recovery', agentId, 1, noteNow)) {
            drawReliefDiamond(ctx, center.x, y - 11, rgb, fade);
        }
    }
    ctx.restore();
}

// Handoff arcs leave and land at mid-body of the 1:1 villager (plan 2.1:
// 48–75 texels tall), not at the knees of the old 1.65× giant.
const HANDOFF_LIFT = 28;
// Below this sender→receiver distance (texels) the bodies overlap and the
// whole flight would sit on them as an extra chip, so only the arc draws.
const HANDOFF_MIN_TRAVEL = 48;

function drawHandoffs(ctx, handoffs, now, motionScale, grade = null, wallNow = 0) {
    if (!handoffs?.length) return;
    const handoffRgb = gradeRgb('244, 196, 93', grade);
    // 3.9 — handoff arcs are SECONDARY (below incidents/selection, above
    // ambient halos).
    const governor = getActiveMarkGovernor();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // SM-7 — at most one chip per body. The scroll mote only travels: once it
    // lands it is absorbed into the receiver, whose own TALK prop or chat
    // bubble is that body's one chip (the old landing spark and the landed
    // mote were two more scrolls on it). Only the newest in-flight handoff to
    // a receiver standing apart from its sender carries a mote; every arc
    // still draws.
    const chipped = new Set();
    const newestFirst = [...handoffs].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const handoff of newestFirst) {
        const from = handoff.from;
        const to = handoff.to;
        if (!from || !to) continue;
        const gate = governor
            ? governor.admit(MarkTier.SECONDARY, from.x, from.y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        const fade = (1 - clamp(handoff.progress ?? 0)) * gate.alpha;
        const pulse = motionPulse(now, motionScale, ((handoff.startedAt || 0) / 1000) % TAU, 'working');
        // Baton travel along the arc: 0 at parent, 1 at child. Reduced motion
        // pins it at the terminus: a static arc with no mote.
        // 5.8 — the director stamps `startedAt` on Date.now() while `now` here
        // is performance.now(); mixing the two pinned the baton at the parent
        // forever. Wall-clock math uses the snapshot's Date.now-domain clock.
        const wall = Number.isFinite(wallNow) && wallNow > 0 ? wallNow : now;
        const t = motionScale ? clamp((wall - (handoff.startedAt || wall)) / 1100) : 1;
        // #28 — transient parent→child lean over arc 0–0.4: the source endpoint
        // nudges toward the child as if the parent steps in to pass the baton,
        // then settles back. Purely a draw-time offset — the sprite x/y the
        // director reported are read, never mutated.
        const lean = motionScale ? Math.sin(clamp(t / 0.4) * Math.PI) * 6 : 0;
        const leanX = (to.x - from.x);
        const leanY = (to.y - from.y);
        const leanLen = Math.hypot(leanX, leanY) || 1;
        const fromX = from.x + (leanX / leanLen) * lean;
        const fromY = (from.y - HANDOFF_LIFT) + (leanY / leanLen) * lean;
        ctx.strokeStyle = rgba(handoffRgb, 0.38 * fade);
        ctx.lineWidth = 1.2 + pulse * 0.8;
        ctx.setLineDash([4, 5]);
        const midX = (fromX + to.x) / 2;
        const midY = Math.min(fromY, to.y - HANDOFF_LIFT) - 22;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.quadraticCurveTo(midX, midY, to.x, to.y - HANDOFF_LIFT);
        ctx.stroke();
        ctx.setLineDash([]);
        if (t >= 1 || Math.hypot(to.x - from.x, to.y - from.y) < HANDOFF_MIN_TRAVEL) continue;
        const bodyId = to.id ?? `${Math.round(to.x)},${Math.round(to.y)}`;
        if (chipped.has(bodyId)) continue;
        chipped.add(bodyId);
        const inv = 1 - t;
        const x = inv * inv * fromX + 2 * inv * t * midX + t * t * to.x;
        const y = inv * inv * fromY + 2 * inv * t * midY + t * t * (to.y - HANDOFF_LIFT);
        drawScrollMote(ctx, x, y, handoffRgb, fade);
    }
    ctx.restore();
}

function drawReleaseParade(ctx, parade, now, motionScale, grade = null) {
    // Biography milestones and sub-agent returns ride the same scene slot but
    // are never a parade: they earn only the neutral lower-third caption.
    if (!parade?.center || parade.kind !== 'parade') return;
    // 3.9 — the release parade is SECONDARY (a celebration, not an alert).
    const governor = getActiveMarkGovernor();
    const gate = governor
        ? governor.admit(MarkTier.SECONDARY, parade.center.x, parade.center.y)
        : { draw: true, alpha: 1 };
    if (!gate.draw) return;
    const fadeIn = clamp((parade.progress || 0) / 0.18);
    const fadeOut = 1 - clamp(((parade.progress || 0) - 0.78) / 0.22);
    const alpha = clamp(Math.min(fadeIn, fadeOut)) * gate.alpha;
    if (alpha <= 0.02) return;
    const pulse = motionPulse(now, motionScale, 2.7, 'recent');
    const x = parade.center.x;
    const y = parade.center.y - 60;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = rgba(gradeRgb('94, 234, 212', grade), 0.32 * alpha);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 92, y + 38);
    ctx.quadraticCurveTo(x - 18, y - 14 - pulse * 8, x + 92, y + 28);
    ctx.stroke();
    ctx.strokeStyle = rgba(gradeRgb('244, 196, 93', grade), 0.28 * alpha);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 78, y + 50);
    ctx.quadraticCurveTo(x + 8, y + 4 + pulse * 6, x + 108, y + 44);
    ctx.stroke();
    ctx.restore();
}

export function drawVillageDirectorGround(ctx, snapshot, now = Date.now(), grade = null) {
    if (!ctx || !snapshot) return;
    drawReplay(ctx, snapshot.replaySamples, now, snapshot.selectedAgentId);
    // S19 — the ring is the selection mark: only the selected building wears
    // one (hover keeps the footprint and the lit plaque).
    if (snapshot.hoverBuildingSignal) {
        drawSignalRoutes(ctx, snapshot.hoverBuildingSignal, { alphaScale: 0.52, dash: [3, 9], lineWidth: 1, grade });
    }
    if (snapshot.selectedBuildingSignal) {
        drawSignalHalo(ctx, { ...snapshot.selectedBuildingSignal, heat: Math.max(0.52, snapshot.selectedBuildingSignal.heat || 0) }, grade);
        drawSignalRoutes(ctx, snapshot.selectedBuildingSignal, { grade });
    }
    drawIncidents(ctx, snapshot.incidents, grade);
    drawRecoveries(ctx, snapshot.recoveries, snapshot.motionScale, grade);
    drawReleaseParade(ctx, snapshot.releaseParade, snapshot.perfNow || now, snapshot.motionScale, grade);
}

// World-space director marks only. Every word the director used to float as
// a world pill now has a screen-fixed home (plan 5.1/5.5): incidents are T1
// attention plates drawn from live status (AttentionPlates.js), the release
// parade is the lower-third caption, and the selected/hovered building is the
// plaque's own selected/hover state. Arrival and departure are the 6.2
// ArrivalDeparture stamps; they carry no ring here (S19).
export function drawVillageDirectorOverlays(ctx, snapshot, now = Date.now(), grade = null) {
    if (!ctx || !snapshot) return;
    drawHandoffs(ctx, snapshot.handoffs, now, snapshot.motionScale, grade, snapshot.now);
}

export function drawVillageDirectorScreen(ctx, snapshot, viewport) {
    if (!ctx || !snapshot || !viewport) return;
    if (!snapshot.replayActive) return;
    ctx.save();
    ctx.font = WORLD_BODY_FONT_11;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const y = Math.max(76, Math.round(viewport.height - 34));
    const text = `REPLAY 60S · ${snapshot.replayAgentCount || 0} AGENTS`;
    const width = Math.ceil(ctx.measureText(text).width) + 18;
    const x = 18;
    ctx.fillStyle = 'rgba(18, 24, 28, 0.78)';
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.58)';
    ctx.fillRect(x, y - 12, width, 22);
    ctx.strokeRect(x + 0.5, y - 11.5, width - 1, 21);
    ctx.fillStyle = '#dff7ff';
    ctx.fillText(text, x + 9, y + 4);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// 5.7 — offscreen-event edge indicator. When the village director fires a
// camera cue (incident / release / arrival) whose moment sits outside the
// viewport — including cues the CameraDirector dropped (cooldown, user camera
// ownership, reduced motion) — a small marker docks at the screen edge on the
// event's side and fades over ~8s. Clicking the marker glides the camera to
// the cue box. This restores spatial awareness without reviving the removed
// minimap. Reduced motion: no band pulse (static alpha, age fade only) and
// the click reframes with a cut (Camera's own RM path), so the indicator is
// fully static-safe.
const EDGE_CUE_TTL_MS = 8000;
const EDGE_CUE_LIMIT = 4;
const EDGE_MARKER_MARGIN = 26;
const EDGE_ONSCREEN_INSET = 24;
const EDGE_HIT_SIZE = 26;
const EDGE_FALLBACK_TINT = '242, 211, 107';

function edgeCueState(renderer) {
    if (!renderer._offscreenCueState) {
        renderer._offscreenCueState = {
            cues: [],
            hitRects: [],
            unsubscribe: null,
            clickHandler: null,
            dispose: null,
        };
    }
    return renderer._offscreenCueState;
}

function edgeTintRgb(cue) {
    const match = String(cue?.tint || '').match(/^#([0-9a-f]{6})$/i);
    if (!match) return EDGE_FALLBACK_TINT;
    const n = Number.parseInt(match[1], 16);
    return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}

function wireEdgeCues(renderer) {
    if (!renderer?.canvas?.addEventListener) return null;
    const state = edgeCueState(renderer);
    if (state.unsubscribe) return state;
    state.unsubscribe = eventBus.on('village:camera-cue', (cue) => {
        if (!cue?.box) return;
        const existing = state.cues.findIndex(entry => entry.kind === (cue.kind || 'default'));
        if (existing >= 0) state.cues.splice(existing, 1);
        state.cues.push({
            kind: cue.kind || 'default',
            box: cue.box,
            tint: cue.tint || null,
            letterbox: cue.letterbox === true,
            ts: Date.now(),
        });
        while (state.cues.length > EDGE_CUE_LIMIT) state.cues.shift();
    });
    state.clickHandler = (event) => {
        for (let i = state.hitRects.length - 1; i >= 0; i--) {
            const hit = state.hitRects[i];
            if (event.offsetX < hit.left || event.offsetX > hit.right) continue;
            if (event.offsetY < hit.top || event.offsetY > hit.bottom) continue;
            const index = state.cues.indexOf(hit.cue);
            if (index >= 0) state.cues.splice(index, 1);
            renderer.camera?.glideToWorld?.(hit.cue.box, {
                duration: 3200,
                paddingPx: 220,
                letterbox: hit.cue.letterbox,
                owner: `cue:${hit.cue.kind}`,
                composition: { x: 0.5, y: 0.53 },
                preferPan: true,
                allowZoomIn: false,
            });
            event.stopImmediatePropagation?.();
            event.preventDefault?.();
            return;
        }
    };
    renderer.canvas.addEventListener('click', state.clickHandler, true);
    state.dispose = () => {
        state.unsubscribe?.();
        state.unsubscribe = null;
        if (state.clickHandler) {
            renderer.canvas?.removeEventListener?.('click', state.clickHandler, true);
            state.clickHandler = null;
        }
        state.cues.length = 0;
        state.hitRects.length = 0;
        if (renderer._offscreenCueState === state) delete renderer._offscreenCueState;
    };
    return state;
}

export function drawOffscreenCueEdges(ctx, renderer, viewport, now = Date.now()) {
    if (!ctx || !renderer || !viewport) return;
    const state = wireEdgeCues(renderer);
    if (!state) return;
    state.hitRects.length = 0;
    const attention = renderer.cameraDirector?.attentionFrame;
    if (attention && attention.inputAt === renderer.camera?._lastUserInputAt) {
        let count = 0;
        let waiting = 0;
        let point = null;
        for (const sprite of renderer.agentSprites.values()) {
            const status = sprite.agent?.status;
            if (sprite.agent?.isDeparted || sprite._archiveAnim
                || (status !== 'waiting_on_user' && status !== 'errored' && status !== 'rate_limited')) continue;
            const box = attentionCandidateBounds(sprite);
            const top = renderer.camera.worldToScreen(box.minX, box.minY);
            const bottom = renderer.camera.worldToScreen(box.maxX, box.maxY);
            if (top.x < 16 || top.y < 16 || bottom.x > viewport.width - 16 || bottom.y > viewport.height - 16) {
                count++;
                if (status === 'waiting_on_user') waiting++;
                if (!point) point = { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 };
            }
        }
        if (count) {
            const dx = point.x - viewport.width / 2;
            const dy = point.y - viewport.height / 2;
            const arrow = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? '←' : '→') : (dy < 0 ? '↑' : '↓');
            const noun = waiting === count ? 'waiting' : 'need attention';
            const text = `${count} ${noun} outside view ${arrow}`;
            ctx.save();
            ctx.font = WORLD_BODY_FONT_11;
            const width = ctx.measureText(text).width + 20;
            const x = Math.max(16, Math.min(viewport.width - width - 16, point.x - width / 2));
            const y = Math.max(24, Math.min(viewport.height - 40, point.y));
            ctx.fillStyle = '#201e24';
            ctx.fillRect(x, y - 16, width, 26);
            ctx.fillStyle = '#f2d36b';
            ctx.fillText(text, x + 10, y + 1);
            ctx.restore();
        }
    }
    if (!state.cues.length) return;
    const camera = renderer.camera;
    if (typeof camera?.worldToScreen !== 'function') return;
    const w = Number(viewport.width) || 0;
    const h = Number(viewport.height) || 0;
    if (!(w > 0) || !(h > 0)) return;
    const motionScale = renderer.motionScale ?? 1;
    // All marker math is canvas-relative: worldToScreen, the click handler's
    // offsetX/Y, and this dock rect share one coordinate space. The sidebar,
    // topbar, and activity panel are flex siblings of the canvas, never
    // overlays, so the canvas rect alone is the visible world area.
    const visRight = w - EDGE_ONSCREEN_INSET;
    const visBottom = h - EDGE_ONSCREEN_INSET;
    const dockRight = w - EDGE_MARKER_MARGIN;
    const dockBottom = h - EDGE_MARKER_MARGIN;

    ctx.save();
    for (let i = state.cues.length - 1; i >= 0; i--) {
        const cue = state.cues[i];
        const age = now - cue.ts;
        if (!Number.isFinite(age) || age >= EDGE_CUE_TTL_MS || age < 0) {
            state.cues.splice(i, 1);
            continue;
        }
        const cx = (cue.box.minX + cue.box.maxX) / 2;
        const cy = (cue.box.minY + cue.box.maxY) / 2;
        const p = camera.worldToScreen(cx, cy);
        // Onscreen moments need no indicator: either the camera glided there
        // or the event is already in the visible frame.
        if (p.x >= EDGE_ONSCREEN_INSET && p.x <= visRight
            && p.y >= EDGE_ONSCREEN_INSET && p.y <= visBottom) continue;

        const ex = Math.max(EDGE_MARKER_MARGIN, Math.min(dockRight, p.x));
        const ey = Math.max(EDGE_MARKER_MARGIN, Math.min(dockBottom, p.y));
        const fade = 1 - age / EDGE_CUE_TTL_MS;
        const pulse = motionScale > 0 ? 0.74 + 0.26 * pulseBand01('alert', now, motionScale, i * 1.3) : 1;
        const alpha = clamp(fade * pulse);
        if (alpha <= 0.02) continue;
        const rgb = edgeTintRgb(cue);
        const angle = Math.atan2(p.y - ey, p.x - ex);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(21, 18, 15, 0.82)';
        ctx.beginPath();
        ctx.arc(ex, ey, 7, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = rgba(rgb, 0.9);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // Outward chevron pointing at the offscreen moment.
        ctx.fillStyle = rgba(rgb, 0.95);
        ctx.beginPath();
        ctx.moveTo(ex + Math.cos(angle) * 9, ey + Math.sin(angle) * 9);
        ctx.lineTo(ex + Math.cos(angle + 2.5) * 4, ey + Math.sin(angle + 2.5) * 4);
        ctx.lineTo(ex + Math.cos(angle - 2.5) * 4, ey + Math.sin(angle - 2.5) * 4);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        state.hitRects.push({
            cue,
            left: ex - EDGE_HIT_SIZE / 2,
            right: ex + EDGE_HIT_SIZE / 2,
            top: ey - EDGE_HIT_SIZE / 2,
            bottom: ey + EDGE_HIT_SIZE / 2,
        });
    }
    ctx.restore();
}
