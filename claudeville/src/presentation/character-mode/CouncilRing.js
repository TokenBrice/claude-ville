import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { THEME } from '../../config/theme.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { tileToWorld, worldToTile } from './Projection.js';

const MAX_TALK_ARCS = 8;
const COMMAND_PLAZA = { tileX: 16, tileY: 21 };
const TEAM_GATHER_COOLDOWN_MS = 5 * 60 * 1000;
const TEAM_GATHER_RADIUS_TILES = 12;
const _lastTeamGatherEmittedAt = new Map();
const _commandPlazaVisitTiles = (BUILDING_DEFS.find(def => def.type === 'command')?.visitTiles || []).map(tile => ({ ...tile }));

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

function isIdleSprite(sprite) {
    return sprite?.agent?.status === AgentStatus.IDLE;
}

export function applyTeamPlazaPreferences(relationship, agentSprites) {
    const snapshot = relationshipSnapshot(relationship);
    if (!snapshot?.teamToMembers || !agentSprites) return;

    const preferredIds = new Set();
    for (const memberIds of snapshot.teamToMembers.values()) {
        const idle = memberIds
            .map(id => agentSprites.get(id))
            .filter(isIdleSprite);
        if (idle.length < 2) continue;
        for (const sprite of idle) preferredIds.add(sprite.agent.id);
    }

    for (const sprite of agentSprites.values()) {
        sprite.setTeamPlazaPreference?.(preferredIds.has(sprite.agent?.id));
    }

    if (snapshot.parentToChildren) {
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            if (!childIds || childIds.size < 2) continue;
            const parent = agentSprites.get(parentId);
            if (!parent || !isIdleSprite(parent)) continue;
            const parentTile = worldToTile(parent.x, parent.y);
            for (const childId of childIds) {
                const child = agentSprites.get(childId);
                if (!child || !isIdleSprite(child)) continue;
                if (typeof child.setFamilyPlazaPreference === 'function') {
                    child.setFamilyPlazaPreference(parentTile.tileX, parentTile.tileY);
                }
            }
        }
    }

    applyTeamGatherChoreography(snapshot, agentSprites);
}

export function applyTeamGatherChoreography(snapshot, agentSprites, { now = performance.now() } = {}) {
    const data = relationshipSnapshot(snapshot);
    if (!data?.teamToMembers || !agentSprites) return;

    for (const [teamName, memberIds] of data.teamToMembers.entries()) {
        const last = _lastTeamGatherEmittedAt.get(teamName) || 0;
        if (now - last < TEAM_GATHER_COOLDOWN_MS) continue;

        const idle = [];
        let blocked = false;
        for (const id of memberIds) {
            const sprite = agentSprites.get(id);
            if (!sprite) continue;
            if (sprite.agent?.status === AgentStatus.WAITING_ON_USER) { blocked = true; break; }
            if (!isIdleSprite(sprite)) continue;
            if (sprite.isArrivalPending?.()) continue;
            idle.push(sprite);
        }
        if (blocked || idle.length < 2) continue;

        let maxDist = 0;
        for (let i = 0; i < idle.length && maxDist <= TEAM_GATHER_RADIUS_TILES; i++) {
            const a = worldToTile(idle[i].x, idle[i].y);
            for (let j = i + 1; j < idle.length; j++) {
                const b = worldToTile(idle[j].x, idle[j].y);
                const d = Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);
                if (d > maxDist) maxDist = d;
                if (maxDist > TEAM_GATHER_RADIUS_TILES) break;
            }
        }
        if (maxDist > TEAM_GATHER_RADIUS_TILES) continue;

        const cx = idle.reduce((sum, s) => sum + s.x, 0) / idle.length;
        const cy = idle.reduce((sum, s) => sum + s.y, 0) / idle.length;
        const centroidTile = worldToTile(cx, cy);
        const sorted = idle
            .map(sprite => ({ sprite, angle: Math.atan2(sprite.y - cy, sprite.x - cx) }))
            .sort((a, b) => a.angle - b.angle);

        const slotCount = _commandPlazaVisitTiles.length || 1;
        const centroidArc = sorted.map((entry, index) => {
            const slotIndex = index % slotCount;
            const tile = _commandPlazaVisitTiles[slotIndex] || COMMAND_PLAZA;
            return {
                agentId: entry.sprite.agent.id,
                angle: entry.angle,
                slotIndex,
                tileX: tile.tileX,
                tileY: tile.tileY,
            };
        });

        _lastTeamGatherEmittedAt.set(teamName, now);
        eventBus.emit('team:gather', {
            teamName,
            members: sorted.map(entry => entry.sprite.agent.id),
            plazaTile: { tileX: centroidTile.tileX, tileY: centroidTile.tileY },
            centroidArc,
        });
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

export function drawFamilyTethers(ctx, {
    relationship,
    agentSprites,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    projectIsoToScreen = null, // reserved; world transform already applied by caller
} = {}) {
    void projectIsoToScreen;
    const snapshot = relationshipSnapshot(relationship);
    if (!ctx || !snapshot?.parentToChildren || !agentSprites) return;

    const boost = lightBoost(lighting);
    const flicker = motionScale === 0 ? 1 : 0.85 + 0.15 * Math.sin(now * 0.003);
    const alpha = Math.min(0.28, Math.max(0.18, 0.22 * boost * flicker));
    const dashOffset = motionScale === 0 ? 0 : -(Math.floor(now * 0.06) % 9);

    for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
        const parent = agentSprites.get(parentId);
        if (!parent || parent.isArrivalPending?.()) continue;
        const trim = parent._providerTrimColor?.() || parent.providerTrimColor || '#8b8b9e';
        const stroke = rgba(trim, alpha);

        for (const childId of childIds) {
            const child = agentSprites.get(childId);
            if (!child || child.isArrivalPending?.()) continue;

            const start = { x: parent.x, y: parent.y - 6 };
            const end = { x: child.x, y: child.y - 6 };
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1) continue;
            const control = {
                x: (start.x + end.x) / 2,
                y: (start.y + end.y) / 2 - Math.min(28, dist * 0.18),
            };

            ctx.save();
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1 / (zoom || 1);
            ctx.setLineDash([3 / (zoom || 1), 6 / (zoom || 1)]);
            ctx.lineDashOffset = dashOffset / (zoom || 1);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
            ctx.stroke();
            ctx.restore();
        }
    }
}

/**
 * Warm tethers between idle allies that the village has long paired up.
 * Unlike family tethers (which read the live relationship snapshot), this
 * takes a precomputed list of `{ a, b }` sprite pairs from the renderer's
 * affinity proximity pass, so no per-frame affinity scan happens here.
 */
export function drawAllyTethers(ctx, {
    pairs,
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
} = {}) {
    if (!ctx || !Array.isArray(pairs) || !pairs.length) return;

    const boost = lightBoost(lighting);
    const pulse = motionScale === 0 ? 1 : 0.78 + 0.22 * Math.sin(now * 0.0026);
    const alpha = Math.min(0.26, Math.max(0.16, 0.2 * boost * pulse));
    const stroke = rgba(THEME.ally || '#f0b27a', alpha);

    for (const pair of pairs) {
        const a = pair?.a;
        const b = pair?.b;
        if (!a || !b || a === b) continue;
        if (a.isArrivalPending?.() || b.isArrivalPending?.()) continue;

        const start = { x: a.x, y: a.y - 4 };
        const end = { x: b.x, y: b.y - 4 };
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) continue;
        const control = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - Math.min(22, dist * 0.16),
        };

        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2 / (zoom || 1);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
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
