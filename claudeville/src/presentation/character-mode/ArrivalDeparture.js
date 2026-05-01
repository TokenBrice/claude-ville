import { tileToWorld } from './Projection.js';

const ARRIVAL_MS = 3000;
const DISPATCH_MS = 600;
const MERGE_MS = 400;
const DEPARTURE_SIGIL_MS = 12000;
const REDUCED_SIGIL_MS = 6000;
const SUBAGENT_COMPLETION_MS = 2200;
const REDUCED_COMPLETION_MS = 3600;
const MAX_SIGILS = 6;
const MAX_COMPLETION_CUES = 8;

const PROVIDER_COLORS = {
    claude: '#a78bfa',
    codex: '#4ade80',
    gemini: '#60a5fa',
    git: '#f6cf60',
    kimi: '#ff9f7a',
    default: '#f2d36b',
};

const PROVIDER_INITIALS = {
    claude: 'C',
    codex: 'X',
    gemini: 'G',
    git: '#',
    kimi: 'K',
    default: '?',
};

const COMMAND_ARRIVAL = { tileX: 16, tileY: 24 };
const COMMAND_APPROACH = { tileX: 11, tileY: 29 };
const HARBOR_ARRIVAL = { tileX: 31, tileY: 27 };
const HARBOR_APPROACH = { tileX: 39, tileY: 31 };

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

function providerInitial(provider) {
    return PROVIDER_INITIALS[String(provider || '').toLowerCase()] || PROVIDER_INITIALS.default;
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function mix(a, b, t) {
    return a + (b - a) * t;
}

function pointOnPath(start, end, t, lift = 0) {
    const eased = easeOutCubic(Math.max(0, Math.min(1, t)));
    return {
        x: mix(start.x, end.x, eased),
        y: mix(start.y, end.y, eased) - Math.sin(Math.PI * eased) * lift,
    };
}

function hasGitActivity(agent) {
    return Array.isArray(agent?.gitEvents) && agent.gitEvents.length > 0;
}

function hasHarborActivity(agent) {
    if (!agent) return false;
    if (hasGitActivity(agent)) return true;
    return agent.targetBuildingType === 'harbor'
        || agent.lastKnownBuildingType === 'harbor'
        || agent.currentBuildingType === 'harbor';
}

function arrivalModeForAgent(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    if (hasHarborActivity(agent)) return 'boat';
    if (provider === 'claude' || provider.includes('claude')) return 'carriage';
    return 'boat';
}

export class ArrivalDepartureController {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale === 0 ? 0 : 1;
        this.arrivals = new Map();
        this.dispatches = new Map();
        this.merges = new Map();
        this.sigils = [];
        this.completionCues = [];
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    beginAgentArrival(agent, sprite, { parentAlive = false, now = nowMs() } = {}) {
        if (!agent || !sprite || parentAlive) return null;
        if (this.motionScale === 0) {
            sprite.setArrivalState?.('visible');
            return null;
        }

        const mode = arrivalModeForAgent(agent);
        const start = tileToScreen(mode === 'boat' ? HARBOR_APPROACH : COMMAND_APPROACH);
        const end = tileToScreen(mode === 'boat' ? HARBOR_ARRIVAL : COMMAND_ARRIVAL);
        sprite.setArrivalState?.('pending');
        sprite.x = end.x;
        sprite.y = end.y;
        this.arrivals.set(agent.id, {
            id: agent.id,
            agent,
            sprite,
            mode,
            start,
            end,
            startedAt: now,
            duration: ARRIVAL_MS,
            color: providerColor(agent.provider),
        });
        return this.arrivals.get(agent.id);
    }

    beginSubagentDispatch(parentSprite, childSprite, { now = nowMs() } = {}) {
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
            start: { x: parentSprite.x, y: parentSprite.y - 34 },
            end: { x: childSprite.x, y: childSprite.y - 20 },
            startedAt: now,
            duration: DISPATCH_MS,
            color: providerColor(childSprite.agent?.provider),
        });
        return this.dispatches.get(childId);
    }

    beginSubagentMerge(childAgent, childPoint, parentSprite, { now = nowMs() } = {}) {
        if (!childAgent || !childPoint || !parentSprite) return null;
        if (this.motionScale === 0) return null;

        this.merges.set(childAgent.id, {
            id: childAgent.id,
            start: { x: childPoint.x, y: childPoint.y - 20 },
            end: { x: parentSprite.x, y: parentSprite.y - 34 },
            startedAt: now,
            duration: MERGE_MS,
            color: providerColor(childAgent.provider),
        });
        return this.merges.get(childAgent.id);
    }

    recordSubagentCompletion(childAgent, childPoint, parentSprite, { now = nowMs() } = {}) {
        if (!childAgent || !parentSprite) return null;
        const anchor = childPoint && Number.isFinite(childPoint.x) && Number.isFinite(childPoint.y)
            ? { x: childPoint.x, y: childPoint.y - 20 }
            : { x: parentSprite.x, y: parentSprite.y - 34 };
        const cue = {
            id: `${childAgent.id || 'subagent'}:${Math.round(now)}`,
            agentId: childAgent.id || null,
            parentId: parentSprite.agent?.id || null,
            start: anchor,
            end: { x: parentSprite.x, y: parentSprite.y - 34 },
            x: parentSprite.x,
            y: parentSprite.y - 34,
            startedAt: now,
            duration: this.motionScale === 0 ? REDUCED_COMPLETION_MS : SUBAGENT_COMPLETION_MS,
            color: providerColor(childAgent.provider),
            initial: providerInitial(childAgent.provider),
        };
        this.completionCues.push(cue);
        if (this.completionCues.length > MAX_COMPLETION_CUES) {
            this.completionCues.splice(0, this.completionCues.length - MAX_COMPLETION_CUES);
        }
        return cue;
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
            initial: providerInitial(agent.provider),
        };
        this.sigils.push(sigil);
        if (this.sigils.length > MAX_SIGILS) this.sigils.splice(0, this.sigils.length - MAX_SIGILS);
        return sigil;
    }

    update(now = nowMs()) {
        for (const [id, arrival] of this.arrivals.entries()) {
            const progress = this.motionScale === 0 ? 1 : (now - arrival.startedAt) / arrival.duration;
            if (progress >= 1) {
                arrival.sprite.setArrivalState?.('visible');
                this.arrivals.delete(id);
            }
        }
        for (const [id, dispatch] of this.dispatches.entries()) {
            const progress = this.motionScale === 0 ? 1 : (now - dispatch.startedAt) / dispatch.duration;
            if (progress >= 1) {
                dispatch.childSprite.setArrivalState?.('visible');
                this.dispatches.delete(id);
            }
        }
        for (const [id, merge] of this.merges.entries()) {
            if ((now - merge.startedAt) / merge.duration >= 1) this.merges.delete(id);
        }
        this.sigils = this.sigils.filter(sigil => now - sigil.startedAt <= sigil.duration);
        this.completionCues = this.completionCues.filter(cue => now - cue.startedAt <= cue.duration);
    }

    draw(ctx, { zoom = 1, now = nowMs(), lighting = null } = {}) {
        if (!ctx) return;
        for (const arrival of this.arrivals.values()) this._drawArrival(ctx, arrival, zoom, now);
        for (const dispatch of this.dispatches.values()) this._drawWisp(ctx, dispatch, zoom, now, lighting);
        for (const merge of this.merges.values()) this._drawWisp(ctx, merge, zoom, now, lighting);
        for (const sigil of this.sigils) drawDepartureSigil(ctx, sigil, { zoom, now, motionScale: this.motionScale, lighting });
        for (const cue of this.completionCues) drawSubagentCompletionCue(ctx, cue, { zoom, now, motionScale: this.motionScale, lighting });
    }

    getLightSources({ now = nowMs() } = {}) {
        const sources = [];
        for (const arrival of this.arrivals.values()) {
            const progress = (now - arrival.startedAt) / arrival.duration;
            const point = pointOnPath(arrival.start, arrival.end, progress, arrival.mode === 'boat' ? 4 : 0);
            sources.push({
                id: `arrival:${arrival.id}`,
                kind: 'point',
                x: point.x,
                y: point.y,
                color: arrival.color,
                radius: 42,
                alpha: 0.18,
                intensity: 0.18,
            });
        }
        for (const dispatch of this.dispatches.values()) {
            sources.push(wispLightSource(dispatch, `dispatch:${dispatch.id}`, now));
        }
        for (const merge of this.merges.values()) {
            sources.push(wispLightSource(merge, `merge:${merge.id}`, now));
        }
        for (const sigil of this.sigils) {
            sources.push({
                id: `departure:${sigil.id}`,
                kind: 'point',
                x: sigil.x,
                y: sigil.y,
                color: sigil.color,
                radius: 48,
                alpha: 0.24,
                intensity: 0.22,
                ttl: sigil.duration,
                createdAt: sigil.startedAt,
            });
        }
        for (const cue of this.completionCues) {
            const progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - cue.startedAt) / cue.duration));
            const point = pointOnPath(cue.start, cue.end, progress, 10);
            sources.push({
                id: `subagent-complete:${cue.id}`,
                kind: 'spark',
                x: point.x,
                y: point.y,
                color: cue.color,
                radius: 34,
                alpha: this.motionScale === 0 ? 0.26 : 0.26 * (1 - progress * 0.55),
                intensity: this.motionScale === 0 ? 0.24 : 0.28 * (1 - progress * 0.45),
                ttl: cue.duration,
                createdAt: cue.startedAt,
            });
        }
        return sources;
    }

    _drawArrival(ctx, arrival, zoom, now) {
        const progress = Math.max(0, Math.min(1, (now - arrival.startedAt) / arrival.duration));
        const point = pointOnPath(arrival.start, arrival.end, progress, arrival.mode === 'boat' ? 8 : 0);
        if (arrival.mode === 'boat') {
            drawBoat(ctx, point, arrival.color, zoom);
        } else {
            drawCarriage(ctx, point, arrival.color, zoom);
        }
    }

    _drawWisp(ctx, item, zoom, now, lighting) {
        const progress = Math.max(0, Math.min(1, (now - item.startedAt) / item.duration));
        const point = pointOnPath(item.start, item.end, progress, 24);
        const lightBoost = lighting?.lightBoost ?? 1;
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        ctx.globalAlpha = Math.min(1, 0.74 * lightBoost);
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.42;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + Math.sin(progress * Math.PI) * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

function wispLightSource(item, id, now) {
    const progress = Math.max(0, Math.min(1, (now - item.startedAt) / item.duration));
    const point = pointOnPath(item.start, item.end, progress, 24);
    return {
        id,
        kind: 'spark',
        x: point.x,
        y: point.y,
        color: item.color,
        radius: 30,
        alpha: 0.24,
        intensity: 0.28,
        ttl: item.duration,
        createdAt: item.startedAt,
    };
}

export function drawSubagentCompletionCue(ctx, cue, {
    zoom = 1,
    now = nowMs(),
    motionScale = 1,
    lighting = null,
} = {}) {
    if (!ctx || !cue) return;
    const age = now - cue.startedAt;
    const progress = Math.max(0, Math.min(1, age / cue.duration));
    const scale = 1 / (zoom || 1);
    const point = motionScale === 0
        ? cue.end
        : pointOnPath(cue.start, cue.end, progress, 10);
    const lightBoost = lighting?.lightBoost ?? 1;
    const alpha = motionScale === 0 ? 0.74 : Math.max(0, 0.74 * (1 - progress));
    if (alpha <= 0) return;

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = Math.min(1, alpha * lightBoost);
    ctx.fillStyle = cue.color;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = Math.min(1, (alpha + 0.12) * lightBoost);
    ctx.strokeStyle = '#fff3bf';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(10, -2);
    ctx.lineTo(0, 9);
    ctx.lineTo(-10, -2);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#21160f';
    ctx.font = 'bold 7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cue.initial || '?', 0, -1);
    ctx.restore();
}

export function drawDepartureSigil(ctx, sigil, {
    zoom = 1,
    now = nowMs(),
    motionScale = 1,
    lighting = null,
} = {}) {
    if (!ctx || !sigil) return;
    const age = now - sigil.startedAt;
    const progress = Math.max(0, Math.min(1, age / sigil.duration));
    const alpha = motionScale === 0 ? (age <= REDUCED_SIGIL_MS ? 0.45 : 0) : 0.45 * (1 - progress);
    if (alpha <= 0) return;
    const lightBoost = lighting?.lightBoost ?? 1;
    const scale = 1 / (zoom || 1);

    ctx.save();
    ctx.translate(sigil.x, sigil.y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = Math.min(1, alpha * lightBoost);
    ctx.fillStyle = sigil.color;
    ctx.beginPath();
    ctx.ellipse(0, -3, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff3bf';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(10, -3);
    ctx.lineTo(0, 9);
    ctx.lineTo(-10, -3);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#21160f';
    ctx.font = 'bold 8px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sigil.initial || '?', 0, -3);
    ctx.restore();
}

function drawBoat(ctx, point, color, zoom) {
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
    ctx.fillStyle = 'rgba(28, 18, 10, 0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-16, 2);
    ctx.lineTo(12, 2);
    ctx.lineTo(18, -5);
    ctx.lineTo(-12, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(-2, -22, 3, 18);
    ctx.beginPath();
    ctx.moveTo(1, -21);
    ctx.lineTo(13, -10);
    ctx.lineTo(1, -7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawCarriage(ctx, point, color, zoom) {
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
    ctx.fillStyle = 'rgba(43, 28, 16, 0.94)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(-14, -15, 28, 16, 3);
    } else {
        ctx.rect(-14, -15, 28, 16);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(-7, -11, 5, 5);
    ctx.fillRect(3, -11, 5, 5);
    ctx.strokeStyle = '#21160f';
    ctx.beginPath();
    ctx.arc(-9, 3, 5, 0, Math.PI * 2);
    ctx.arc(9, 3, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

export { arrivalModeForAgent, hasHarborActivity, providerColor, providerInitial, tileToScreen };
