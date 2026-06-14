import { TILE_HALF_WIDTH, TILE_HALF_HEIGHT } from './Projection.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';

// Crowd cluster group visuals: when CrowdClusters reports a dense group
// (3+ agents in a cell), draw one subtle shared ground aura under the group
// and an "×N" count badge above it so swarms stay readable.
//
// Pulse band: static (no repeating motion), matching council rings. Alpha is
// modulated only by the slow-changing lighting boost, so there is no
// motionScale gate and the reduced-motion rendering is identical.
//
// Hot path: called every frame. No per-cluster object/array/gradient
// allocations; colors are constant strings modulated via ctx.globalAlpha.

const AURA_FILL = 'rgba(246, 218, 130, 1)';
const AURA_STROKE = 'rgba(214, 169, 81, 1)';
const BADGE_PANEL = 'rgba(20, 14, 10, 0.85)';
const BADGE_BORDER = 'rgba(214, 169, 81, 0.8)';
const BADGE_TEXT = '#f6da82';
const BADGE_FONT = 'bold 7px "Press Start 2P", monospace';
const BADGE_HEIGHT = 13;
const BADGE_CHAR_WIDTH = 7;
const BADGE_PADDING_X = 8;

const STATUS_AURA_FALLBACK = Object.freeze({
    fill: AURA_FILL,
    stroke: AURA_STROKE,
    badge: BADGE_BORDER,
});

const STATUS_AURA = Object.freeze({
    [AgentStatus.WORKING]: STATUS_AURA_FALLBACK,
    [AgentStatus.IDLE]: STATUS_AURA_FALLBACK,
    [AgentStatus.COMPLETED]: STATUS_AURA_FALLBACK,
    [AgentStatus.WAITING]: Object.freeze({
        fill: 'rgba(111, 179, 217, 1)',
        stroke: 'rgba(91, 150, 190, 1)',
        badge: 'rgba(91, 150, 190, 0.8)',
    }),
    [AgentStatus.WAITING_ON_USER]: Object.freeze({
        fill: 'rgba(111, 179, 217, 1)',
        stroke: 'rgba(91, 150, 190, 1)',
        badge: 'rgba(91, 150, 190, 0.8)',
    }),
    [AgentStatus.RATE_LIMITED]: Object.freeze({
        fill: 'rgba(251, 146, 60, 1)',
        stroke: 'rgba(234, 88, 12, 1)',
        badge: 'rgba(234, 88, 12, 0.82)',
    }),
    [AgentStatus.ERRORED]: Object.freeze({
        fill: 'rgba(239, 68, 68, 1)',
        stroke: 'rgba(185, 28, 28, 1)',
        badge: 'rgba(185, 28, 28, 0.84)',
    }),
});

const _badgeTextCache = new Map();

function badgeText(count) {
    let text = _badgeTextCache.get(count);
    if (!text) {
        text = `×${count}`;
        _badgeTextCache.set(count, text);
    }
    return text;
}

function lightBoost(lighting) {
    return Math.max(0.45, Math.min(1.8, lighting?.lightBoost ?? 1));
}

function clusterWorldX(cluster) {
    return (cluster.tileX - cluster.tileY) * TILE_HALF_WIDTH;
}

function clusterWorldY(cluster) {
    return (cluster.tileX + cluster.tileY) * TILE_HALF_HEIGHT;
}

function auraRadiusX(cluster) {
    return Math.min(120, 56 + (cluster.count || 0) * 4);
}

function statusAura(status) {
    return STATUS_AURA[status] || STATUS_AURA_FALLBACK;
}

// Ground pass: one soft isometric ellipse per dense cluster, drawn with the
// other pre-sprite relationship layers so agents render on top of it.
export function drawCrowdClusterAuras(ctx, { crowdStats, zoom = 1, lighting = null } = {}) {
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    const boost = lightBoost(lighting);
    const fillAlpha = Math.min(0.12, 0.07 * boost);
    const strokeAlpha = Math.min(0.3, 0.18 * boost);

    ctx.save();
    ctx.lineWidth = 1.2 / (zoom || 1);
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const x = clusterWorldX(cluster);
        const y = clusterWorldY(cluster) + 4;
        const rx = auraRadiusX(cluster);
        const ry = rx * 0.5;
        const aura = statusAura(cluster.dominantStatus);

        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = aura.fill;
        ctx.fill();
        ctx.globalAlpha = strokeAlpha;
        ctx.strokeStyle = aura.stroke;
        ctx.stroke();
    }
    ctx.restore();
}

// Overlay pass: a small "×N" pill above each dense cluster, drawn after the
// depth-sorted sprite pass so it stays readable over the crowd. Scaled by
// 1/zoom so the badge keeps a constant on-screen size.
export function drawCrowdClusterBadges(ctx, { crowdStats, zoom = 1 } = {}) {
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    const s = 1 / (zoom || 1);
    ctx.save();
    ctx.font = BADGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const text = badgeText(cluster.count || 0);
        const w = BADGE_PADDING_X + text.length * BADGE_CHAR_WIDTH;
        const x = clusterWorldX(cluster);
        const y = clusterWorldY(cluster) - auraRadiusX(cluster) * 0.5 - 12;
        const aura = statusAura(cluster.dominantStatus);

        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        ctx.fillStyle = BADGE_PANEL;
        ctx.strokeStyle = aura.badge;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w / 2, -BADGE_HEIGHT / 2, w, BADGE_HEIGHT, 4);
        } else {
            ctx.rect(-w / 2, -BADGE_HEIGHT / 2, w, BADGE_HEIGHT);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = BADGE_TEXT;
        ctx.fillText(text, 0, 0.5);
        ctx.restore();
    }
    ctx.restore();
}
