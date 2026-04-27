const ARRIVAL_MS = 3000;
const DISPATCH_MS = 600;
const MERGE_MS = 400;
const DEPARTURE_SIGIL_MS = 12000;
const REDUCED_SIGIL_MS = 6000;
const MAX_SIGILS = 6;

const PROVIDER_COLORS = {
    claude: '#a78bfa',
    codex: '#4ade80',
    gemini: '#60a5fa',
    git: '#f6cf60',
    default: '#f2d36b',
};

const PROVIDER_INITIALS = {
    claude: 'C',
    codex: 'X',
    gemini: 'G',
    git: '#',
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
    return {
        x: (tile.tileX - tile.tileY) * 32,
        y: (tile.tileX + tile.tileY) * 16,
    };
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

function hasHarborActivity(agent) {
    return Array.isArray(agent?.gitEvents) && agent.gitEvents.length > 0;
}

export class ArrivalDepartureController {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale === 0 ? 0 : 1;
        this.arrivals = new Map();
        this.dispatches = new Map();
        this.merges = new Map();
        this.sigils = [];
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

        const mode = hasHarborActivity(agent) ? 'boat' : 'carriage';
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
        if (this.motionScale === 0) {
            childSprite.setArrivalState?.('visible');
            return null;
        }

        childSprite.setArrivalState?.('pending');
        this.dispatches.set(childSprite.agent.id, {
            id: childSprite.agent.id,
            parentSprite,
            childSprite,
            start: { x: parentSprite.x, y: parentSprite.y - 34 },
            end: { x: childSprite.x, y: childSprite.y - 20 },
            startedAt: now,
            duration: DISPATCH_MS,
            color: providerColor(childSprite.agent?.provider),
        });
        return this.dispatches.get(childSprite.agent.id);
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
    }

    draw(ctx, { zoom = 1, now = nowMs(), lighting = null } = {}) {
        if (!ctx) return;
        for (const arrival of this.arrivals.values()) this._drawArrival(ctx, arrival, zoom, now);
        for (const dispatch of this.dispatches.values()) this._drawWisp(ctx, dispatch, zoom, now, lighting);
        for (const merge of this.merges.values()) this._drawWisp(ctx, merge, zoom, now, lighting);
        for (const sigil of this.sigils) drawDepartureSigil(ctx, sigil, { zoom, now, motionScale: this.motionScale, lighting });
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

export { providerColor, providerInitial, tileToScreen };
