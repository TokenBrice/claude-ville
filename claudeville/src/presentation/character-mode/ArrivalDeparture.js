import { tileToWorld } from './Projection.js';
import { SpriteSheet } from './SpriteSheet.js';
import { agentSignature, drawAgentSignature, getModelVisualIdentity, providerPaletteKey } from '../shared/ModelVisualIdentity.js';
import {
    MAGIC_RAMP,
    PEAK,
    STONE_RAMP,
    DUST_TONES,
    chips,
    column,
    comet,
    createCueGate,
    cueGatedAge,
    defineMoment,
    diamond,
    momentPhase,
    quantStep,
    queueMomentEdgePlate,
    resolveMomentAnchor,
    ringDots,
    runeNotch,
    snap,
    steppedDecay,
} from './EffectStamps.js';

// 6.2 — arrival materialize beat (Medium): anticipation column + rune ring,
// one cream silhouette frame, the true body with a 3-step column collapse and
// dust chips, then a static rune notch while the villager walks in the gate.
const ARRIVAL = defineMoment('medium', { anticipation: 200, peak: 80, follow: 520, residue: 2000 });
// 6.3 — dispatch / merge comet (Medium): gather at the sender, a comet flight
// with the child miniature as its head, one cream impact frame, a chip splash.
const COMET_GATHER_MS = 150;
const COMET_FLIGHT_MS = 500;
const COMET_IMPACT_MS = 80;
const COMET_SPLASH_MS = 400;
const COMET_TOTAL_MS = COMET_GATHER_MS + COMET_FLIGHT_MS + COMET_IMPACT_MS + COMET_SPLASH_MS;
const ORPHAN_FLIGHT_MS = 700;
const COMET_LIFT = 24;
const DEPARTURE_SIGIL_MS = 12000;
const REDUCED_SIGIL_MS = 6000;
const SUBAGENT_COMPLETION_MS = 2200;
const REDUCED_COMPLETION_MS = 3600;
const MAX_SIGILS = 6;
const MAX_COMPLETION_CUES = 8;
const MAX_ORPHAN_RETURNS = 6;
const MAX_ARRIVALS = 6;
// 2.5 — snapshot pixels of a child's idle row travel with its dispatch and its
// return. Bounded so the cache can never grow with the session: 24 crops of at
// most 14 px stay far under the 64 KiB the proposal budgeted.
const MINIATURE_PX = 14;
const MAX_MINIATURES = 24;
// Launch/landing heights above the feet, in world texels.
const PARENT_LAUNCH_LIFT = 40;
const ARRIVAL_COLUMN_HEIGHT = 44;
// V8 — each peak frame's largest extent around its own point (world texels):
// the arrival's widest ring step and full column, the dispatch impact's ring
// and the child's cream silhouette, the return's rim ring and its diamond.
const ARRIVAL_EXTENT = Object.freeze({ left: -17, top: -(ARRIVAL_COLUMN_HEIGHT + 4), right: 17, bottom: 9 });
const DISPATCH_IMPACT_EXTENT = Object.freeze({ left: -12, top: -36, right: 12, bottom: 7 });
const RETURN_IMPACT_EXTENT = Object.freeze({ left: -12, top: -(PARENT_LAUNCH_LIFT + 6), right: 12, bottom: 7 });
const ARRIVAL_RESIDUE_AT = ARRIVAL.anticipation + ARRIVAL.peak + ARRIVAL.follow;

const PROVIDER_COLORS = {
    claude: '#a78bfa',
    codex: '#4ade80',
    gemini: '#60a5fa',
    git: '#f6cf60',
    kimi: '#ff9f7a',
    omp: '#f2d36b',
    opencode: '#7cf4c8',
    default: '#f2d36b',
};

// Mirrors PORTAL_SPAWN_TILE in IsometricRenderer.js (Portal Gate footprint
// center). Used as the fallback target when the renderer cannot project a
// screen point for an orphan subagent's return.
const PORTAL_SPAWN_TILE = { tileX: 4, tileY: 32 };

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function tileToScreen(tile) {
    return tileToWorld(tile);
}

function providerColor(provider) {
    return PROVIDER_COLORS[String(provider || '').toLowerCase()] || PROVIDER_COLORS.default;
}

// 2.5 — the child's stable signature (plan 2.4) resolved from the agent record
// alone, so a return still identifies its child after the sprite is disposed.
function agentSignatureFor(agent) {
    if (!agent?.id) return null;
    const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
    const family = identity.spriteId || `agent.${providerPaletteKey(agent)}.base`;
    return agentSignature(agent.id, family);
}

// One miniature standing on (x, y) in world texels: the snapshot crop when one
// was captured while the child was alive, always the signature plate, and an
// exact count when a burst folded. The crop draws 1:1 on the world grid.
function drawChildMiniature(ctx, x, y, { miniature = null, signature = null, accent = '#f2d36b', count = 1, zoom = 1 }) {
    const canvas = miniature?.canvas || null;
    const mark = miniature?.signature || signature || null;
    const tone = miniature?.accent || accent;
    const ox = snap(x);
    const oy = snap(y);
    if (canvas) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, ox - (canvas.width >> 1), oy - canvas.height, canvas.width, canvas.height);
    }
    if (mark) drawAgentSignature(ctx, mark, { x: ox, y: canvas ? oy + 4 : oy, pixel: 1, accent: tone });
    if (count > 1) {
        // Exact child count, never a percentage: C5 label type (PS2P 8 px,
        // screen-fixed, never bold) on a dark backing so the number survives
        // foliage and the night grade.
        const z = Math.max(0.01, zoom || 1);
        const text = `x${count}`;
        ctx.save();
        ctx.translate(ox + 6, oy - 8);
        ctx.scale(1 / z, 1 / z);
        ctx.fillStyle = 'rgba(12, 9, 7, 0.86)';
        ctx.fillRect(0, -6, 6 + text.length * 8, 12);
        ctx.fillStyle = '#eee3cb';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 3, 0);
        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
// Silhouette frame — the body's alpha mask filled cream, cached per sheet and
// facing. Built once from the sprite's composed sheet; null until it loads.
// ---------------------------------------------------------------------------

const SILHOUETTES = new WeakMap();

function bodySilhouette(sprite) {
    if (!sprite || typeof document === 'undefined') return null;
    const source = sprite.spriteCanvas || sprite._composeBaseSheet?.() || null;
    if (!source || !source.width || !source.height) return null;
    const dir = Number.isInteger(sprite.direction) ? sprite.direction : 0;
    let byDir = SILHOUETTES.get(source);
    if (!byDir) {
        byDir = new Map();
        SILHOUETTES.set(source, byDir);
    }
    if (byDir.has(dir)) return byDir.get(dir);
    const sheet = source === sprite.spriteCanvas && sprite.spriteSheet ? sprite.spriteSheet : new SpriteSheet(source);
    const cell = sheet.cell('idle', dir, 0);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, cell.sw);
    canvas.height = Math.max(1, cell.sh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] < 24) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    // S16 — the cream peak frame is the body's 1-texel rim, not a filled
    // blob: keep opaque pixels with a transparent 4-neighbour (or the cell
    // edge) and clear the interior.
    const w = canvas.width;
    const h = canvas.height;
    const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 24;
    const rim = ctx.createImageData(w, h);
    const cream = Number.parseInt(PEAK.slice(1), 16);
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (!opaque(x, y)) continue;
            if (opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1)) continue;
            const i = (y * w + x) * 4;
            rim.data[i] = (cream >> 16) & 0xff;
            rim.data[i + 1] = (cream >> 8) & 0xff;
            rim.data[i + 2] = cream & 0xff;
            rim.data[i + 3] = 255;
        }
    }
    ctx.putImageData(rim, 0, 0);
    const silhouette = { canvas, minX, minY, maxX, maxY };
    byDir.set(dir, silhouette);
    return silhouette;
}

// Draw the cream frame with its feet on (x, y) at the 1:1 body scale (C3/D1).
function drawSilhouette(ctx, silhouette, x, y) {
    if (!silhouette) return;
    const centerX = (silhouette.minX + silhouette.maxX) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(silhouette.canvas, snap(x - centerX), snap(y - silhouette.maxY + 2));
}

// ---------------------------------------------------------------------------
// Comet timeline shared by dispatch, merge and orphan returns.
// ---------------------------------------------------------------------------

function cometPhase(age, flightMs = COMET_FLIGHT_MS) {
    if (age < 0) return { phase: 'gather', t: 0, step: 0 };
    if (age < COMET_GATHER_MS) {
        const t = age / COMET_GATHER_MS;
        return { phase: 'gather', t, step: quantStep(t, 3) };
    }
    const flight = age - COMET_GATHER_MS;
    if (flight < flightMs) return { phase: 'flight', t: flight / flightMs, step: 0 };
    const impact = flight - flightMs;
    if (impact < COMET_IMPACT_MS) return { phase: 'impact', t: impact / COMET_IMPACT_MS, step: 0 };
    const splash = impact - COMET_IMPACT_MS;
    if (splash < COMET_SPLASH_MS) {
        const t = splash / COMET_SPLASH_MS;
        return { phase: 'splash', t, step: quantStep(t, 3) };
    }
    return { phase: 'done', t: 1, step: 0 };
}

function cometDuration(flightMs = COMET_FLIGHT_MS) {
    return COMET_GATHER_MS + flightMs + COMET_IMPACT_MS + COMET_SPLASH_MS;
}

// Launch eased out, landing eased in: the comet leaves quickly and drops in.
function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function pointOnArc(start, end, t, lift = 0) {
    const u = Math.max(0, Math.min(1, t));
    const eased = easeInOutQuad(u);
    return {
        x: start.x + (end.x - start.x) * eased,
        y: start.y + (end.y - start.y) * eased - Math.sin(Math.PI * eased) * lift,
    };
}

function cometHead(item, t) {
    const head = pointOnArc(item.start, item.end, t, COMET_LIFT);
    const prev = pointOnArc(item.start, item.end, Math.max(0, t - 0.06), COMET_LIFT);
    let dx = head.x - prev.x;
    let dy = head.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.01) {
        dx = item.end.x - item.start.x;
        dy = item.end.y - item.start.y;
    }
    return { x: head.x, y: head.y, dx, dy };
}

// S8 — one comet flight frame. The head (the child miniature, or the plus
// stamp without one) is screen-fixed at 2 px per texel at z ≤ 2: world scale
// is the integer 2/zoom, so a z1 flight is a 2×-texel sprite, never a speck.
// The tail is a stepped dot trace of the arc already flown (same scale), so the
// launch point stays readable for the whole flight.
const COMET_TRAIL_DOTS = 7;
const COMET_TRAIL_STEP = 0.05;

function drawCometFlight(ctx, arc, t, { zoom = 1, ramp = MAGIC_RAMP, miniature = null, signature = null } = {}) {
    const scale = Math.max(1, Math.round(2 / Math.max(0.25, Number(zoom) || 1)));
    for (let i = COMET_TRAIL_DOTS; i >= 1; i--) {
        const u = t - i * COMET_TRAIL_STEP;
        if (u < 0) continue;
        const p = pointOnArc(arc.start, arc.end, u, COMET_LIFT);
        const size = (i <= 2 ? 2 : 1) * scale;
        ctx.fillStyle = i <= 2 ? ramp[2] : (i <= 4 ? ramp[1] : ramp[0]);
        ctx.fillRect(snap(p.x) - (size >> 1), snap(p.y - 3 * scale) - (size >> 1), size, size);
    }
    const head = cometHead(arc, t);
    const hasMiniature = Boolean(miniature || signature);
    ctx.save();
    ctx.translate(snap(head.x), snap(head.y));
    ctx.scale(scale, scale);
    comet(ctx, 0, -3, head.dx, head.dy, { length: 5, spacing: 3, ramp, head: !hasMiniature });
    if (hasMiniature) drawChildMiniature(ctx, 0, 4, { miniature, signature, accent: ramp[1] });
    ctx.restore();
}

function hashId(value) {
    const text = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

export class ArrivalDepartureController {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale === 0 ? 0 : 1;
        this.arrivals = new Map();
        this.dispatches = new Map();
        this.merges = new Map();
        this.sigils = [];
        this.completionCues = [];
        this.orphanReturns = [];
        // 2.5 — snapshot crops keyed by child id, captured while the child is
        // alive and reused by its merge or completion return.
        this.miniatures = new Map();
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    // 6.2 — the arrival no longer rides a carriage or boat glyph. The renderer
    // has already placed the sprite at the gate's outside tile; the body stays
    // hidden through the anticipation and the one cream silhouette frame, then
    // `onLanded` hands it back to the gate walk-in. Reduced motion keeps the
    // body where the renderer put it and leaves only the static rune notch.
    beginAgentArrival(agent, sprite, { parentAlive = false, now = nowMs(), onLanded = null } = {}) {
        if (!agent || !sprite || parentAlive) return null;
        this._landArrival(this.arrivals.get(agent.id));
        this.arrivals.delete(agent.id);
        // At most six materialize beats at once (a restart can land two dozen
        // sessions in one frame); the rest simply walk in through the gate.
        if (this.arrivals.size >= MAX_ARRIVALS) return null;
        const point = { x: Number(sprite.x) || 0, y: Number(sprite.y) || 0 };
        const reduced = this.motionScale === 0;
        if (!reduced) sprite.setArrivalState?.('pending');
        const arrival = {
            id: agent.id,
            sprite,
            point,
            startedAt: now,
            reduced,
            landed: reduced,
            onLanded: reduced ? null : onLanded,
            seed: hashId(agent.id),
            silhouette: reduced ? null : bodySilhouette(sprite),
            // 8.3 — the cream frame lands on the arrival's first note.
            cue: reduced ? null : createCueGate('arrival', agent.id),
        };
        this.arrivals.set(agent.id, arrival);
        return reduced ? null : arrival;
    }

    // Truth for label gating: a name must not float over an empty spot. True
    // while the body is still hidden behind an arrival or a dispatch comet.
    isArrivalPending(agentId) {
        if (!agentId) return false;
        const arrival = this.arrivals.get(agentId);
        if (arrival && !arrival.landed) return true;
        const dispatch = this.dispatches.get(agentId);
        return Boolean(dispatch && !dispatch.landed);
    }

    beginSubagentDispatch(parentSprite, childSprite, { now = nowMs(), onLanded = null } = {}) {
        if (!parentSprite || !childSprite) return null;
        const childId = childSprite.agent?.id;
        if (!childId) return null;
        if (this.motionScale === 0) {
            childSprite.setArrivalState?.('visible');
            return null;
        }

        childSprite.setArrivalState?.('pending');
        this.dispatches.set(childId, {
            id: childId,
            parentSprite,
            childSprite,
            start: { x: parentSprite.x, y: parentSprite.y - PARENT_LAUNCH_LIFT },
            end: { x: childSprite.x, y: childSprite.y },
            startedAt: now,
            duration: COMET_TOTAL_MS,
            flightMs: COMET_FLIGHT_MS,
            landed: false,
            seed: hashId(childId),
            // The comet head is the child itself: snapshot pixels plus its 2.4
            // signature. Capture can fail before the sheet loads; update()
            // retries while the dispatch is in flight.
            miniature: this.rememberMiniature(childSprite),
            signature: agentSignatureFor(childSprite.agent),
            silhouette: bodySilhouette(childSprite),
            ramp: MAGIC_RAMP,
            onLanded,
            // 8.3 — the impact frame lands on the dispatch note.
            cue: createCueGate('dispatch', parentSprite.agent?.id ?? null),
        });
        return this.dispatches.get(childId);
    }

    // Snapshot and cache one child's miniature. Returns the cached crop when it
    // exists; a failed capture is never cached, so the next frame retries.
    rememberMiniature(sprite) {
        const id = sprite?.agent?.id;
        if (!id) return null;
        const cached = this.miniatures.get(id);
        if (cached) return cached;
        const captured = sprite.captureMiniature?.(MINIATURE_PX) || null;
        if (!captured) return null;
        if (this.miniatures.size >= MAX_MINIATURES) {
            this.miniatures.delete(this.miniatures.keys().next().value);
        }
        this.miniatures.set(id, captured);
        return captured;
    }

    // 6.3 — the merge mirrors the dispatch in neutral stone: the child gathers
    // where it stood, flies into its parent, one cream rim frame lands, and the
    // parent takes its static receive beat. A return is never gold.
    beginSubagentMerge(childAgent, childPoint, parentSprite, { now = nowMs() } = {}) {
        if (!childAgent || !childPoint || !parentSprite) return null;
        if (this.motionScale === 0) return null;

        this.merges.set(childAgent.id, {
            id: childAgent.id,
            parentSprite,
            origin: { x: childPoint.x, y: childPoint.y },
            start: { x: childPoint.x, y: childPoint.y },
            end: { x: parentSprite.x, y: parentSprite.y },
            startedAt: now,
            duration: COMET_TOTAL_MS,
            flightMs: COMET_FLIGHT_MS,
            landed: false,
            seed: hashId(childAgent.id),
            miniature: this.miniatures.get(childAgent.id) || null,
            signature: agentSignatureFor(childAgent),
            ramp: STONE_RAMP,
            // 8.3 — the impact frame lands on the return's first note.
            cue: createCueGate('subagentReturn', parentSprite.agent?.id ?? null),
        });
        return this.merges.get(childAgent.id);
    }

    recordSubagentCompletion(childAgent, childPoint, parentSprite, { now = nowMs() } = {}) {
        if (!childAgent || !parentSprite) return null;
        const anchor = childPoint && Number.isFinite(childPoint.x) && Number.isFinite(childPoint.y)
            ? { x: childPoint.x, y: childPoint.y }
            : { x: parentSprite.x, y: parentSprite.y };
        const parentId = parentSprite.agent?.id || null;
        const duration = this.motionScale === 0 ? REDUCED_COMPLETION_MS : SUBAGENT_COMPLETION_MS;
        parentSprite.setReceiveBeat?.();
        // A burst folds onto the receiving parent: one returning miniature and
        // an exact child count, never eight portraits stacked on one body.
        const open = parentId
            ? this.completionCues.find(entry => entry.parentId === parentId && now - entry.startedAt < entry.duration)
            : null;
        if (open) {
            open.count += 1;
            open.agentId = childAgent.id || open.agentId;
            open.startedAt = now;
            open.duration = duration;
            open.miniature = this.miniatures.get(childAgent.id) || open.miniature;
            open.signature = agentSignatureFor(childAgent) || open.signature;
            open.color = providerColor(childAgent.provider);
            return open;
        }
        const cue = {
            id: `${childAgent.id || 'subagent'}:${Math.round(now)}`,
            agentId: childAgent.id || null,
            parentId,
            parentSprite,
            start: anchor,
            end: { x: parentSprite.x, y: parentSprite.y },
            x: parentSprite.x,
            y: parentSprite.y,
            startedAt: now,
            duration,
            color: providerColor(childAgent.provider),
            count: 1,
            miniature: this.miniatures.get(childAgent.id) || null,
            signature: agentSignatureFor(childAgent),
        };
        this.completionCues.push(cue);
        if (this.completionCues.length > MAX_COMPLETION_CUES) {
            this.completionCues.splice(0, this.completionCues.length - MAX_COMPLETION_CUES);
        }
        return cue;
    }

    recordOrphanReturn(child, lastTile, portalScreenPoint, { now = nowMs() } = {}) {
        if (!child) return null;
        if (this.motionScale === 0) return null;
        const startTile = lastTile && Number.isFinite(lastTile.tileX) && Number.isFinite(lastTile.tileY)
            ? lastTile
            : (child.position
                ? { tileX: child.position.tileX ?? child.position.x, tileY: child.position.tileY ?? child.position.y }
                : null);
        if (!startTile) return null;
        const start = tileToScreen(startTile);
        const end = portalScreenPoint && Number.isFinite(portalScreenPoint.x) && Number.isFinite(portalScreenPoint.y)
            ? { x: portalScreenPoint.x, y: portalScreenPoint.y }
            : tileToScreen(PORTAL_SPAWN_TILE);
        const entry = {
            id: `${child.id || 'orphan'}:${Math.round(now)}`,
            origin: { x: start.x, y: start.y },
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
            startedAt: now,
            duration: cometDuration(ORPHAN_FLIGHT_MS),
            flightMs: ORPHAN_FLIGHT_MS,
            seed: hashId(child.id),
            ramp: STONE_RAMP,
        };
        this.orphanReturns.push(entry);
        if (this.orphanReturns.length > MAX_ORPHAN_RETURNS) {
            this.orphanReturns.splice(0, this.orphanReturns.length - MAX_ORPHAN_RETURNS);
        }
        return entry;
    }

    recordDeparture(agent, lastTile, { now = nowMs(), parentAlive = false } = {}) {
        if (!agent || parentAlive) return null;
        const tile = lastTile || (agent.position ? { tileX: agent.position.x, tileY: agent.position.y } : null);
        if (!tile) return null;
        const point = tileToScreen(tile);
        const sigil = {
            id: `${agent.id}:${Math.round(now)}`,
            agentId: agent.id,
            provider: agent.provider || 'default',
            x: point.x,
            y: point.y,
            startedAt: now,
            duration: this.motionScale === 0 ? REDUCED_SIGIL_MS : DEPARTURE_SIGIL_MS,
            color: providerColor(agent.provider),
        };
        this.sigils.push(sigil);
        if (this.sigils.length > MAX_SIGILS) this.sigils.splice(0, this.sigils.length - MAX_SIGILS);
        return sigil;
    }

    update(now = nowMs()) {
        for (const [id, arrival] of this.arrivals.entries()) {
            const age = this._arrivalAge(arrival, now);
            if (!arrival.landed) {
                if (!arrival.silhouette) arrival.silhouette = bodySilhouette(arrival.sprite);
                if (age >= ARRIVAL.anticipation + ARRIVAL.peak) this._landArrival(arrival);
            }
            const phase = momentPhase(age, ARRIVAL, { reduced: arrival.reduced });
            if (phase.phase === 'done') this.arrivals.delete(id);
        }
        for (const [id, dispatch] of this.dispatches.entries()) {
            // The character sheet may still be loading when a child is
            // dispatched; keep trying until it leaves as itself.
            if (!dispatch.miniature) dispatch.miniature = this.rememberMiniature(dispatch.childSprite);
            if (!dispatch.silhouette) dispatch.silhouette = bodySilhouette(dispatch.childSprite);
            const age = this.motionScale === 0 ? dispatch.duration : this._cometAge(dispatch, now);
            if (!dispatch.landed && age >= COMET_GATHER_MS + dispatch.flightMs + COMET_IMPACT_MS) {
                dispatch.landed = true;
                dispatch.childSprite.setArrivalState?.('visible');
                this.rememberMiniature(dispatch.childSprite);
                const onLanded = dispatch.onLanded;
                dispatch.onLanded = null;
                if (typeof onLanded === 'function') onLanded();
            }
            if (age >= dispatch.duration) {
                if (!dispatch.landed) dispatch.childSprite.setArrivalState?.('visible');
                this.dispatches.delete(id);
            }
        }
        for (const [id, merge] of this.merges.entries()) {
            const age = this._cometAge(merge, now);
            if (!merge.landed && age >= COMET_GATHER_MS + merge.flightMs) {
                // The return has landed: the parent holds one static receive beat.
                merge.landed = true;
                merge.parentSprite?.setReceiveBeat?.();
            }
            if (age < merge.duration) continue;
            this.miniatures.delete(id);
            this.merges.delete(id);
        }
        this.sigils = this.sigils.filter(sigil => now - sigil.startedAt <= sigil.duration);
        this.completionCues = this.completionCues.filter(cue => now - cue.startedAt <= cue.duration);
        this.orphanReturns = this.orphanReturns.filter(entry => now - entry.startedAt <= entry.duration);
    }

    _landArrival(arrival) {
        if (!arrival || arrival.landed) return;
        arrival.landed = true;
        arrival.sprite?.setArrivalState?.('visible');
        const onLanded = arrival.onLanded;
        arrival.onLanded = null;
        if (typeof onLanded === 'function') onLanded();
    }

    // 8.3 — the moment clocks, held on the notes that carry their peaks.
    _arrivalAge(arrival, now) {
        return cueGatedAge(arrival.cue, now - arrival.startedAt, ARRIVAL.anticipation, ARRIVAL_RESIDUE_AT, { reduced: arrival.reduced });
    }

    _cometAge(item, now) {
        return cueGatedAge(item.cue, now - item.startedAt, COMET_GATHER_MS + item.flightMs, null);
    }

    draw(ctx, { zoom = 1, now = nowMs() } = {}) {
        if (!ctx) return;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'source-over';
        for (const arrival of this.arrivals.values()) this._drawArrival(ctx, arrival, now);
        for (const dispatch of this.dispatches.values()) this._drawDispatch(ctx, dispatch, now, zoom);
        for (const merge of this.merges.values()) this._drawReturn(ctx, merge, now, zoom);
        for (const entry of this.orphanReturns) this._drawReturn(ctx, entry, now, zoom);
        for (const sigil of this.sigils) drawDepartureSigil(ctx, sigil, { now, motionScale: this.motionScale });
        for (const cue of this.completionCues) drawSubagentCompletionCue(ctx, cue, { zoom, now, motionScale: this.motionScale });
        ctx.restore();
    }

    getLightSources({ now = nowMs() } = {}) {
        const sources = [];
        for (const arrival of this.arrivals.values()) {
            if (arrival.reduced) continue;
            const phase = momentPhase(this._arrivalAge(arrival, now), ARRIVAL);
            if (phase.phase === 'residue' || phase.phase === 'done') continue;
            sources.push({
                id: `arrival:${arrival.id}`,
                kind: 'point',
                x: arrival.point.x,
                y: arrival.point.y - ARRIVAL_COLUMN_HEIGHT / 2,
                color: MAGIC_RAMP[1],
                radius: 42,
                alpha: 0.18 * phase.alpha,
                intensity: 0.2 * phase.alpha,
            });
        }
        for (const dispatch of this.dispatches.values()) {
            const source = cometLightSource(dispatch, `dispatch:${dispatch.id}`, now);
            if (source) sources.push(source);
        }
        for (const merge of this.merges.values()) {
            const source = cometLightSource(merge, `merge:${merge.id}`, now);
            if (source) sources.push(source);
        }
        for (const entry of this.orphanReturns) {
            const source = cometLightSource(entry, `orphan-return:${entry.id}`, now);
            if (source) sources.push(source);
        }
        for (const sigil of this.sigils) {
            sources.push({
                id: `departure:${sigil.id}`,
                kind: 'point',
                x: sigil.x,
                y: sigil.y,
                color: MAGIC_RAMP[0],
                radius: 36,
                alpha: 0.16,
                intensity: 0.14,
                ttl: sigil.duration,
                createdAt: sigil.startedAt,
            });
        }
        return sources;
    }

    _drawArrival(ctx, arrival, now) {
        const phase = momentPhase(this._arrivalAge(arrival, now), ARRIVAL, { reduced: arrival.reduced });
        if (phase.phase === 'done') return;
        // 8.1 — V8: the beat stands where the body lands when that spot is
        // clear; else it rises up the actor's own column (without the body's
        // silhouette, which is hidden there); else it is an edge plate.
        const anchor = resolveMomentAnchor(arrival.point, {
            actorId: arrival.id,
            extent: ARRIVAL_EXTENT,
            id: `arrival:${arrival.id}`,
            kind: 'arrival',
            tier: 'medium',
            phase: phase.phase,
        });
        if (anchor.mode === 'edge') {
            if (phase.phase !== 'residue') {
                queueMomentEdgePlate(anchor, { word: 'ARRIVED', color: MAGIC_RAMP[1], peak: phase.phase === 'peak', ctx });
            }
            return;
        }
        const placed = anchor.mode === 'place';
        const x = anchor.x;
        const y = anchor.y;
        switch (phase.phase) {
        case 'anticipation': {
            // The eye gets a cue: a cream rune ring on the ground and a violet
            // column rising out of it in three held steps.
            ringDots(ctx, x, y, 12, { count: 8, dot: 2, color: PEAK, phase: Math.PI / 8 });
            column(ctx, x, y, { height: [12, 24, 36][phase.step], width: 7, ramp: MAGIC_RAMP });
            break;
        }
        case 'peak': {
            // One cream frame: the column at full height with a cream core, and
            // the body as a flat cream silhouette.
            ringDots(ctx, x, y, 12, { count: 8, dot: 2, color: PEAK, phase: Math.PI / 8 });
            column(ctx, x, y, { height: ARRIVAL_COLUMN_HEIGHT, width: 9, ramp: MAGIC_RAMP, core: PEAK });
            if (placed) drawSilhouette(ctx, arrival.silhouette, x, y);
            break;
        }
        case 'follow': {
            // The true body is back; the column sinks into the ground in three
            // steps (a stub at the feet, never a bar across the body) and dust
            // kicks out. The ring dims one ramp step each.
            const ringTone = [MAGIC_RAMP[1], MAGIC_RAMP[0], null][phase.step];
            if (ringTone) ringDots(ctx, x, y, 12 + phase.step * 2, { count: 8, dot: 1, color: ringTone, phase: Math.PI / 8 });
            column(ctx, x, y + 1, { height: [9, 5, 2][phase.step], width: [11, 9, 7][phase.step], ramp: MAGIC_RAMP });
            if (placed) chips(ctx, x, y + 1, phase.t, { count: 6, seed: arrival.seed, spread: 14, lift: 5, tones: DUST_TONES });
            break;
        }
        case 'residue':
            // The rune is a ground mark at the feet: only where they stand.
            if (placed) runeNotch(ctx, x, y, { ramp: MAGIC_RAMP });
            break;
        default:
            break;
        }
    }

    // 8.1 — where a comet's impact and splash stand (V8). Gather and flight
    // follow the bodies themselves.
    _impactAnchor(item, phase, extent, id, kind) {
        return resolveMomentAnchor(item.end, {
            actorId: item.parentSprite?.agent?.id ?? null,
            extent,
            id,
            kind,
            tier: 'medium',
            phase: phase.phase === 'impact' ? 'peak' : phase.phase,
        });
    }

    _drawDispatch(ctx, item, now, zoom) {
        const phase = cometPhase(this._cometAge(item, now), item.flightMs);
        const parent = item.parentSprite;
        switch (phase.phase) {
        case 'gather': {
            // The violet ring contracts at the parent's feet in three steps.
            if (parent) {
                ringDots(ctx, parent.x, parent.y, [14, 10, 6][phase.step], {
                    count: 8, dot: 2, color: item.ramp[phase.step === 2 ? 2 : 1],
                });
            }
            break;
        }
        case 'flight': {
            // Launch from where the parent stands now; land on the child.
            if (parent) item.start = { x: parent.x, y: parent.y - PARENT_LAUNCH_LIFT };
            drawCometFlight(ctx, item, phase.t, { zoom, ramp: item.ramp, miniature: item.miniature, signature: item.signature });
            break;
        }
        case 'impact':
        case 'splash': {
            const anchor = this._impactAnchor(item, phase, DISPATCH_IMPACT_EXTENT, `dispatch:${item.id}`, 'dispatch');
            if (anchor.mode === 'edge') {
                queueMomentEdgePlate(anchor, { word: 'DISPATCH', color: item.ramp[1], peak: phase.phase === 'impact', ctx });
                break;
            }
            const placed = anchor.mode === 'place';
            if (phase.phase === 'impact') {
                ringDots(ctx, anchor.x, anchor.y, 9, { count: 8, dot: 2, color: PEAK });
                if (placed && item.silhouette) drawSilhouette(ctx, item.silhouette, anchor.x, anchor.y);
                else diamond(ctx, anchor.x, anchor.y - 12, 6, { color: PEAK, filled: true });
            } else {
                chips(ctx, anchor.x, anchor.y + 1, phase.t, {
                    count: 6, seed: item.seed, spread: 12, lift: 6, tones: item.ramp,
                });
            }
            break;
        }
        default:
            break;
        }
    }

    // Merge and orphan returns: stone comet from where the child stood.
    _drawReturn(ctx, item, now, zoom) {
        const phase = cometPhase(item.cue ? this._cometAge(item, now) : now - item.startedAt, item.flightMs);
        const parent = item.parentSprite || null;
        if (parent) item.end = { x: parent.x, y: parent.y };
        switch (phase.phase) {
        case 'gather': {
            ringDots(ctx, item.origin.x, item.origin.y, [12, 8, 5][phase.step], {
                count: 8, dot: 2, color: item.ramp[phase.step === 2 ? 2 : 1],
            });
            if (item.miniature || item.signature) {
                drawChildMiniature(ctx, item.origin.x, item.origin.y, { miniature: item.miniature, signature: item.signature, accent: item.ramp[1], zoom });
            }
            break;
        }
        case 'flight': {
            const landing = { x: item.end.x, y: item.end.y - (parent ? PARENT_LAUNCH_LIFT : 0) };
            drawCometFlight(ctx, { start: { x: item.origin.x, y: item.origin.y - 8 }, end: landing }, phase.t, {
                zoom, ramp: item.ramp, miniature: item.miniature, signature: item.signature,
            });
            break;
        }
        case 'impact':
        case 'splash': {
            // One cream rim frame at the receiver, then the chips.
            const lift = parent ? PARENT_LAUNCH_LIFT : 12;
            const anchor = this._impactAnchor(item, phase, RETURN_IMPACT_EXTENT, `return:${item.id}`, 'subagentReturn');
            if (anchor.mode === 'edge') {
                queueMomentEdgePlate(anchor, { word: 'RETURNED', color: item.ramp[1], peak: phase.phase === 'impact', ctx });
                break;
            }
            if (phase.phase === 'impact') {
                ringDots(ctx, anchor.x, anchor.y, 11, { count: 12, dot: 1, color: PEAK });
                diamond(ctx, anchor.x, anchor.y - lift, 4, { color: PEAK });
            } else {
                chips(ctx, anchor.x, anchor.y + 1, phase.t, {
                    count: 5, seed: item.seed, spread: 10, lift: 5, tones: item.ramp,
                });
            }
            break;
        }
        default:
            break;
        }
    }
}

function cometLightSource(item, id, now) {
    const phase = cometPhase(now - item.startedAt, item.flightMs);
    if (phase.phase !== 'flight' && phase.phase !== 'impact') return null;
    const point = phase.phase === 'impact' ? item.end : pointOnArc(item.start, item.end, phase.t, COMET_LIFT);
    return {
        id,
        kind: 'spark',
        x: point.x,
        y: point.y,
        color: item.ramp?.[1] || MAGIC_RAMP[1],
        radius: 30,
        alpha: 0.24,
        intensity: 0.28,
        ttl: item.duration,
        createdAt: item.startedAt,
    };
}

// 2.5/6.3 — a child returned without a live sprite to fly from. Neutral stone
// throughout: the miniature arcs home, lands with one cream frame, then holds
// with the exact count in stepped alpha. Returning is not succeeding.
export function drawSubagentCompletionCue(ctx, cue, {
    zoom = 1,
    now = nowMs(),
    motionScale = 1,
} = {}) {
    if (!ctx || !cue) return;
    const age = now - cue.startedAt;
    if (age < 0 || age > cue.duration) return;
    const parent = cue.parentSprite || null;
    const end = parent ? { x: parent.x, y: parent.y } : cue.end;
    const count = Number(cue.count) || 1;
    const reduced = motionScale === 0;
    const flightEnd = COMET_GATHER_MS + COMET_FLIGHT_MS;
    let point = end;
    if (!reduced && age < flightEnd) {
        const t = Math.max(0, (age - COMET_GATHER_MS) / COMET_FLIGHT_MS);
        const head = cometHead({ start: cue.start, end }, t);
        point = head;
        if (age >= COMET_GATHER_MS) comet(ctx, head.x, head.y - 8, head.dx, head.dy, { length: 3, ramp: STONE_RAMP, head: false });
    }
    const holdAge = reduced ? 0 : Math.max(0, age - flightEnd);
    const holdSpan = Math.max(1, cue.duration - (reduced ? 0 : flightEnd));
    const alpha = reduced ? 0.66 : steppedDecay(holdAge, holdSpan);
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const peakFrame = !reduced && age >= flightEnd && age < flightEnd + COMET_IMPACT_MS;
    diamond(ctx, point.x, point.y - 30, 6, { color: peakFrame ? PEAK : STONE_RAMP[1] });
    drawChildMiniature(ctx, point.x, point.y - 16, {
        miniature: cue.miniature,
        signature: cue.signature,
        accent: STONE_RAMP[1],
        count,
        zoom,
    });
    ctx.restore();
}

// Departure sigil: a static ground mark where a session left — a violet rune
// ring with a stone diamond, fading in four held alpha steps. Reduced motion
// holds one fixed step for its shorter window.
export function drawDepartureSigil(ctx, sigil, {
    now = nowMs(),
    motionScale = 1,
} = {}) {
    if (!ctx || !sigil) return;
    const age = now - sigil.startedAt;
    const alpha = motionScale === 0
        ? (age >= 0 && age <= REDUCED_SIGIL_MS ? 0.66 : 0)
        : steppedDecay(age, sigil.duration);
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ringDots(ctx, sigil.x, sigil.y, 11, { count: 8, dot: 2, color: MAGIC_RAMP[0], phase: Math.PI / 8 });
    diamond(ctx, sigil.x, sigil.y - 7, 5, { color: STONE_RAMP[1], fill: STONE_RAMP[0] });
    ctx.fillStyle = sigil.color || MAGIC_RAMP[1];
    ctx.fillRect(snap(sigil.x) - 1, snap(sigil.y - 7) - 1, 2, 2);
    ctx.restore();
}

export { providerColor, tileToScreen };
