import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { THEME } from '../../config/theme.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { tileToWorld } from './Projection.js';

const MAX_TALK_ARCS = 8;
const COMMAND_PLAZA = { tileX: 16, tileY: 21 };

function tileToScreen(tile) {
    return tileToWorld(tile);
}

function relationshipSnapshot(relationship) {
    if (!relationship) return null;
    return typeof relationship.getSnapshot === 'function' ? relationship.getSnapshot() : relationship;
}

function rgba(hex, alpha) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return text;
    const r = parseInt(text.slice(1, 3), 16);
    const g = parseInt(text.slice(3, 5), 16);
    const b = parseInt(text.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightBoost(lighting) {
    return Math.max(0.45, Math.min(1.8, lighting?.lightBoost ?? 1));
}

function sortedSpritesForTeam(memberIds, agentSprites) {
    const sprites = [];
    for (const id of memberIds || []) {
        const sprite = agentSprites?.get?.(id);
        if (sprite && !sprite.isArrivalPending?.()) sprites.push(sprite);
    }
    return sprites.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
}

export function applyTeamPlazaPreferences(relationship, agentSprites) {
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot?.teamToMembers || !agentSprites) return;

    const preferredIds = new Set();
    for (const memberIds of snapshot.teamToMembers.values()) {
        const idle = memberIds
            .map(id => agentSprites.get(id))
            .filter(sprite => sprite?.agent?.status === AgentStatus.IDLE);
        if (idle.length < 2) continue;
        for (const sprite of idle) preferredIds.add(sprite.agent.id);
    }

    for (const sprite of agentSprites.values()) {
        sprite.setTeamPlazaPreference?.(preferredIds.has(sprite.agent?.id));
    }
}

export function drawCouncilRings(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
} = {}) {
    const snapshot = relationshipSnapshot(relationship);
    if (!ctx || !snapshot?.teamToMembers || !agentSprites) return;

    const boost = lightBoost(lighting);
    const plaza = tileToScreen(COMMAND_PLAZA);
    const shimmer = motionScale === 0 ? 1 : 0.84 + Math.sin(now * 0.002) * 0.16;

    for (const [teamName, memberIds] of snapshot.teamToMembers.entries()) {
        const sprites = sortedSpritesForTeam(memberIds, agentSprites);
        if (sprites.length < 2) continue;

        const color = getTeamColor(teamName);
        ctx.save();
        ctx.strokeStyle = rgba(color.accent, Math.min(0.42, 0.26 * boost * shimmer));
        ctx.lineWidth = 1.4 / (zoom || 1);
        ctx.setLineDash([]);
        ctx.beginPath();

        const points = sprites.map(sprite => ({ x: sprite.x, y: sprite.y - 3 }));
        const centroid = points.reduce(
            (acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }),
            { x: 0, y: 0 },
        );
        const anchor = {
            x: (centroid.x * 0.75) + (plaza.x * 0.25),
            y: (centroid.y * 0.75) + (plaza.y * 0.25),
        };

        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const next = points[(i + 1) % points.length];
            const mid = {
                x: (point.x + next.x) / 2,
                y: (point.y + next.y) / 2,
            };
            const control = {
                x: mid.x + (anchor.x - mid.x) * 0.18,
                y: mid.y + (anchor.y - mid.y) * 0.18 - 8,
            };
            if (i === 0) ctx.moveTo(point.x, point.y);
            ctx.quadraticCurveTo(control.x, control.y, next.x, next.y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }
}

function prioritizedChatPairs(pairs, agentSprites) {
    return [...(pairs || [])]
        .sort((a, b) => {
            const aTime = Math.max(
                agentSprites?.get?.(a.aId)?.agent?.lastActive || 0,
                agentSprites?.get?.(a.bId)?.agent?.lastActive || 0,
            );
            const bTime = Math.max(
                agentSprites?.get?.(b.aId)?.agent?.lastActive || 0,
                agentSprites?.get?.(b.bId)?.agent?.lastActive || 0,
            );
            return bTime - aTime;
        })
        .slice(0, MAX_TALK_ARCS);
}

export function drawTalkArcs(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
} = {}) {
    const snapshot = relationshipSnapshot(relationship);
    if (!ctx || !snapshot?.chatPairs || !agentSprites) return;

    const boost = lightBoost(lighting);
    const shimmer = motionScale === 0 ? 1 : 0.55 + 0.2 * Math.sin(now * 0.004);
    const alpha = Math.min(0.95, shimmer * boost);

    for (const pair of prioritizedChatPairs(snapshot.chatPairs, agentSprites)) {
        const a = agentSprites.get(pair.aId);
        const b = agentSprites.get(pair.bId);
        if (!a || !b || a.isArrivalPending?.() || b.isArrivalPending?.()) continue;

        const start = { x: a.x, y: a.y - 18 };
        const end = { x: b.x, y: b.y - 18 };
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        const control = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - Math.min(60, dist * 0.35),
        };

        ctx.save();
        ctx.strokeStyle = rgba(THEME.chatting || '#f2d36b', alpha);
        ctx.lineWidth = 1.4 / (zoom || 1);
        if (motionScale === 0) ctx.setLineDash([2 / (zoom || 1), 4 / (zoom || 1)]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
        ctx.stroke();
        ctx.restore();
    }
}

export function relationshipLightSources({ relationship, agentSprites, lighting = null } = {}) {
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot || !agentSprites) return [];
    const sources = [];
    const boost = lightBoost(lighting);

    for (const [teamName, memberIds] of snapshot.teamToMembers?.entries?.() || []) {
        const sprites = sortedSpritesForTeam(memberIds, agentSprites);
        if (sprites.length < 2) continue;
        const color = getTeamColor(teamName);
        const center = sprites.reduce(
            (acc, sprite) => ({ x: acc.x + sprite.x / sprites.length, y: acc.y + sprite.y / sprites.length }),
            { x: 0, y: 0 },
        );
        sources.push({
            id: `council:${teamName}`,
            kind: 'orbit',
            x: center.x,
            y: center.y,
            color: color.accent,
            radius: 74,
            alpha: 0.24,
            intensity: 0.25 * boost,
        });
    }

    for (const pair of prioritizedChatPairs(snapshot.chatPairs, agentSprites)) {
        const a = agentSprites.get(pair.aId);
        const b = agentSprites.get(pair.bId);
        if (!a || !b) continue;
        sources.push({
            id: `talk:${pair.aId}:${pair.bId}`,
            kind: 'arc',
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2 - 18,
            endpoints: [{ x: a.x, y: a.y - 18 }, { x: b.x, y: b.y - 18 }],
            color: THEME.chatting || '#f2d36b',
            radius: 56,
            alpha: 0.22,
            intensity: 0.22 * boost,
        });
    }

    return sources;
}
