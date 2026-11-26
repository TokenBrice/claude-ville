import { TILE_HALF_WIDTH, TILE_HALF_HEIGHT } from './Projection.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { BUILDING_ACCENTS_RGB, STATUS_VISUALS, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { worldToTile } from './Projection.js';
import { isAttentionStatus } from './AttentionPlates.js';
import { paintWalnutBoard, snapScreenOrigin } from './WorldLabelKit.js';
import { fillPixelEllipse } from './PixelShapes.js';
import { ringDots } from './EffectStamps.js';

// Crowd cluster group visuals: when CrowdClusters reports a dense group
// (3+ agents in a cell), draw one subtle shared ground aura under the group
// and an "×N" count badge above it so swarms stay readable.
//
// W7.11 (SW-P14) — a VillageDirector work cohort is a cluster of this same
// system (`kind: 'cohort'`, one per working building, CrowdClusters): the
// same pool + ringDots aura in its building's district material instead of a
// status hue, and the same T5 tab, so there is never a second aura or a
// doubled tab for one crowd.
//
// Pulse band: static (no repeating motion), matching council rings. Alpha is
// modulated only by the slow-changing lighting boost, so there is no
// motionScale gate.
//
// 3.9 — the ground auras are AMBIENT tier in the mark governor (the first to
// dim in a busy region); under reduced motion the governor degrades to its
// static alpha cap with no region culling, per the governor contract. The
// count badges stay untiered: they are the density summary that must remain
// precisely when a region overflows.
//
// Hot path: called every frame. No per-cluster object/array/gradient
// allocations; colors are constant strings modulated via ctx.globalAlpha.

const AURA_FILL = 'rgba(246, 218, 130, 1)';
const AURA_STROKE = 'rgba(214, 169, 81, 1)';
const BADGE_PANEL = 'rgba(20, 14, 10, 0.85)';
const BADGE_BORDER = 'rgba(214, 169, 81, 0.8)';
const BADGE_TEXT = '#f6da82';
const BADGE_FONT = WORLD_DISPLAY_FONT_8;
const BADGE_HEIGHT = 13;
const BADGE_CHAR_WIDTH = 8;
const BADGE_PADDING_X = 8;

const STATUS_AURA_FALLBACK = Object.freeze({
    fill: AURA_FILL,
    stroke: AURA_STROKE,
    badge: BADGE_BORDER,
});

function auraFromHex(hex, badgeAlpha = 0.8) {
    const value = parseInt(String(hex || '').replace(/^#/, ''), 16);
    if (!Number.isFinite(value)) return STATUS_AURA_FALLBACK;
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    const rim = `${Math.round(r * 0.78)}, ${Math.round(g * 0.78)}, ${Math.round(b * 0.78)}`;
    return Object.freeze({
        fill: `rgba(${r}, ${g}, ${b}, 1)`,
        stroke: `rgba(${rim}, 1)`,
        badge: `rgba(${rim}, ${badgeAlpha})`,
    });
}

// Derived directly from STATUS_VISUALS (theme.js / DESIGN.md) so the
// standard's status pips, and the ground pool of every actionable crowd,
// stay locked to the single canonical status palette.
export const STATUS_AURA = Object.freeze(Object.fromEntries(
    Object.entries(STATUS_VISUALS).map(([status, visual]) => [status, auraFromHex(visual.color)]),
));

// The statuses that tint the ground: a crowd that needs the operator (needs
// you, errored, rate limited) or is stalled (waiting) pools in its exact
// STATUS_VISUALS hue.
export const GROUND_SIGNAL_STATUSES = Object.freeze([
    AgentStatus.WAITING_ON_USER,
    AgentStatus.ERRORED,
    AgentStatus.RATE_LIMITED,
    AgentStatus.WAITING,
]);

// Every calm crowd (working, idle, completed, chatting) pools in one warm
// neutral brass instead. At the ground pool's 7–12% alpha over green turf,
// working green and idle sky read as green-on-green mush and parchment
// vanished; one brass ground lets an actionable hue stand out on its own,
// while the standard's pips still name each calm status in its own hue.
export const CALM_GROUND_HEX = '#c8b58a';
export const CALM_GROUND_AURA = auraFromHex(CALM_GROUND_HEX);

export const GROUND_AURA = Object.freeze(Object.fromEntries(
    Object.keys(STATUS_AURA).map((status) => [
        status,
        GROUND_SIGNAL_STATUSES.includes(status) ? STATUS_AURA[status] : CALM_GROUND_AURA,
    ]),
));

const PIP_RADIUS = 3;
const PIP_GAP = 4;
const PIP_ROW_HEIGHT = 8;
const STANDARD_PADDING_TOP = 3;
const MAX_PIPS = 3;

const _badgeTextCache = new Map();

function badgeText(count) {
    let text = _badgeTextCache.get(count);
    if (!text) {
        text = `+${count}`;
        _badgeTextCache.set(count, text);
    }
    return text;
}

// Pick up to MAX_PIPS status categories present in a cluster, ranked by share
// (count desc, then status key for a stable order). Returns aura entries so the
// standard's pips reuse the same heraldic palette as the ground aura.
function topStatusPips(statuses) {
    if (!statuses) return null;
    const keys = Object.keys(statuses);
    if (keys.length === 0) return null;
    keys.sort((a, b) => (statuses[b] - statuses[a]) || a.localeCompare(b));
    const pips = [];
    for (let i = 0; i < keys.length && pips.length < MAX_PIPS; i++) {
        pips.push(statusAura(keys[i]));
    }
    return pips;
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

const _cohortAuraCache = new Map();

// A cohort's ground material: its building's district accent, the rim one
// step darker (whole-texel fills, no new hue).
function cohortAura(type) {
    let aura = _cohortAuraCache.get(type);
    if (!aura) {
        const rgb = BUILDING_ACCENTS_RGB[type];
        if (!rgb) return STATUS_AURA_FALLBACK;
        const [r, g, b] = String(rgb).split(',').map(part => Number(part.trim()) || 0);
        const rim = `${Math.round(r * 0.78)}, ${Math.round(g * 0.78)}, ${Math.round(b * 0.78)}`;
        aura = Object.freeze({ fill: `rgba(${rgb}, 1)`, stroke: `rgba(${rim}, 1)`, badge: `rgba(${rim}, 0.8)` });
        _cohortAuraCache.set(type, aura);
    }
    return aura;
}

function clusterAura(cluster) {
    if (cluster.kind === 'cohort') return cohortAura(cluster.building);
    return GROUND_AURA[cluster.dominantStatus] || STATUS_AURA_FALLBACK;
}

// Ground pass: one faint scanline isometric ellipse per dense cluster, rimmed
// with a dotted ring (pixel grammar: whole-texel fills, no AA path), drawn with
// the other pre-sprite relationship layers so agents render on top of it.
export function drawCrowdClusterAuras(ctx, { crowdStats, lighting = null } = {}) {
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    const boost = lightBoost(lighting);
    const governor = getActiveMarkGovernor();
    const fillAlpha = Math.min(0.12, 0.07 * boost);
    const strokeAlpha = Math.min(0.3, 0.18 * boost);

    ctx.save();
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const x = clusterWorldX(cluster);
        const y = clusterWorldY(cluster) + 4;
        const gate = governor
            ? governor.admit(MarkTier.AMBIENT, x, y)
            : { draw: true, alpha: 1 };
        if (!gate.draw) continue;
        const rx = auraRadiusX(cluster);
        const aura = clusterAura(cluster);

        ctx.globalAlpha = fillAlpha * gate.alpha;
        fillPixelEllipse(ctx, x, y, rx, rx * 0.5, aura.fill);
        ctx.globalAlpha = strokeAlpha * gate.alpha;
        ringDots(ctx, x, y, rx, { count: Math.round(rx / 5), dot: 2, color: aura.stroke });
    }
    ctx.restore();
}

// Overlay pass: a heraldic standard above each dense cluster, drawn after the
// depth-sorted sprite pass so it stays readable over the crowd. Shows the total
// "×N" count plus up to 3 status pips (working/waiting/errored, …) so hidden
// overflow agents are summarized by colour rather than silently dropped. Scaled
// by 1/zoom so the standard keeps a constant on-screen size. Static — no motion,
// so the prefers-reduced-motion rendering is identical.
const _namedPerCell = new Map();
const _cohortOfAgent = new Map();
const _ownedPerCell = new Map();
// A body's head-chip column: its drawn body plus the screen-fixed chip slot
// above the head (chat bubble, TALK scroll, status emote, …), in world px.
const CHIP_SLOT_SCREEN_H = 30;
const CHIP_SLOT_SCREEN_HALF_W = 14;
const BADGE_BODY_GAP = 4;
const _badgeSpans = [];
const _badgeClear = { y: 0 };

// 0.8 — the `+N` tab must never sit on a body: over a crowd it read as that
// one body wearing the tab on top of its own chip. Keep the tab at its
// height and slide it sideways to the free x nearest the cluster centre,
// clear of every body column its band crosses; when the cluster is packed
// wall to wall across its aura, lift it just above the tallest column so the
// count stays visible. Scratch arrays are reused (hot path).
function badgeClearX(cx, cy, bw, bh, s, reach, agentSprites) {
    const spans = _badgeSpans;
    spans.length = 0;
    const top = cy - bh / 2;
    const bottom = cy + bh / 2;
    let highest = top;
    for (const sprite of agentSprites?.values?.() || []) {
        if (!sprite || sprite.agent?.isDeparted || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        if (Math.abs(sprite.x - cx) > reach + bw) continue;
        const box = sprite._bodyBox;
        const headTop = typeof sprite._headTopY === 'function' ? sprite._headTopY() : sprite.y - 58;
        const columnTop = headTop - CHIP_SLOT_SCREEN_H * s;
        const columnBottom = sprite.y + (box ? box.bottom : 3);
        if (columnTop >= bottom || columnBottom <= top) continue;
        const half = Math.max(CHIP_SLOT_SCREEN_HALF_W * s, box ? Math.max(-box.left, box.right) : 17);
        const pad = bw / 2 + BADGE_BODY_GAP * s;
        spans.push(sprite.x - half - pad, sprite.x + half + pad);
        if (columnTop < highest) highest = columnTop;
    }
    _badgeClear.y = cy;
    if (!spans.length) return cx;
    let best = NaN;
    for (let c = -1; c < spans.length; c++) {
        const x = c < 0 ? cx : spans[c];
        if (Math.abs(x - cx) > reach) continue;
        if (Number.isFinite(best) && Math.abs(x - cx) >= Math.abs(best - cx)) continue;
        let free = true;
        for (let i = 0; i < spans.length; i += 2) {
            if (x > spans[i] && x < spans[i + 1]) { free = false; break; }
        }
        if (free) best = x;
    }
    if (Number.isFinite(best)) return best;
    _badgeClear.y = highest - bh / 2 - BADGE_BODY_GAP * s;
    return cx;
}

// W4-A (Spec 04 §4.2 T5) — `plaqueDrawnTypes` (the building types whose
// walnut chit or Carved Motif tally painted last frame) and
// `plaqueBuildingByAgentId` (each counted agent's plaque building, the
// fold/route/target derivation of `_plaqueCountsByType`) come from the
// building renderer's last label pass. A member already shown by such a
// count is owned there: `hidden = count - named - owned`, and the tab draws
// only while hidden > 0. A named member is never also owned. Layer 0
// (`theatreMode`) draws no `+N` tab at all.
export function drawCrowdClusterBadges(ctx, {
    crowdStats,
    zoom = 1,
    agentSprites,
    cellSize = 4,
    plaqueDrawnTypes = null,
    plaqueBuildingByAgentId = null,
    theatreMode = false,
} = {}) {
    if (theatreMode) return;
    // At dense load remembered residents share one exact building count.
    const staleGroups = new Map();
    for (const sprite of agentSprites?.values?.() || []) {
        sprite.staleGrouped = false;
        if (agentSprites.size < 24 || !sprite.agent?.resident || sprite.observation?.state !== 'stale'
            || sprite.selected || sprite.hovered || ['waiting_on_user', 'errored', 'rate_limited'].includes(sprite.agent.status)) continue;
        const building = sprite._lastBuildingType || sprite.agent.lastKnownBuildingType;
        if (!building) continue;
        let group = staleGroups.get(building);
        if (!group) { group = { count: 0, x: 0, y: 0 }; staleGroups.set(building, group); }
        group.count++;
        group.x += sprite.x;
        group.y += sprite.y;
        sprite.staleGrouped = true;
    }
    if (ctx && staleGroups.size) {
        ctx.save();
        ctx.font = BADGE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const group of staleGroups.values()) {
            const text = `${group.count} stale`;
            const width = BADGE_PADDING_X + text.length * BADGE_CHAR_WIDTH;
            ctx.save();
            ctx.translate(group.x / group.count, group.y / group.count - 56);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            ctx.fillStyle = BADGE_PANEL;
            ctx.fillRect(-width / 2, -BADGE_HEIGHT / 2, width, BADGE_HEIGHT);
            ctx.fillStyle = BADGE_TEXT;
            ctx.fillText(text, 0, 0);
            ctx.restore();
        }
        ctx.restore();
    }
    const clusters = crowdStats?.clusters;
    if (!ctx || !clusters || clusters.length === 0) return;

    // T5 (plan 5.2/C5) — the tab counts the members the world is not already
    // naming: routine names admitted this frame, T2 plates and T1 attention
    // plates are excluded, so `+N` is exactly the unnamed remainder.
    const named = _namedPerCell;
    named.clear();
    // A cohort member is counted against its cohort's tab, not its cell's.
    const cohortOf = _cohortOfAgent;
    cohortOf.clear();
    for (let i = 0; i < clusters.length; i++) {
        const ids = clusters[i].kind === 'cohort' ? clusters[i].agentIds : null;
        if (ids) for (let j = 0; j < ids.length; j++) cohortOf.set(ids[j], clusters[i].id);
    }
    const owned = _ownedPerCell;
    owned.clear();
    const ownership = plaqueDrawnTypes?.size > 0 && typeof plaqueBuildingByAgentId?.get === 'function';
    for (const sprite of agentSprites?.values?.() || []) {
        if (!Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        const shown = sprite.overlaySlot != null || sprite.selected || isAttentionStatus(sprite.agent?.status);
        // Exact subtraction: a member the world already names is counted
        // once, as named; else its plaque building's painted count owns it.
        const building = !shown && ownership ? plaqueBuildingByAgentId.get(sprite.agent?.id) : null;
        const isOwned = Boolean(building) && plaqueDrawnTypes.has(building);
        if (!shown && !isOwned) continue;
        let key = cohortOf.get(sprite.agent?.id);
        if (!key) {
            const tile = worldToTile(sprite.x, sprite.y);
            key = `${Math.floor(tile.tileX / cellSize)},${Math.floor(tile.tileY / cellSize)}`;
        }
        if (shown) named.set(key, (named.get(key) || 0) + 1);
        else owned.set(key, (owned.get(key) || 0) + 1);
    }
    const s = 1 / (zoom || 1);
    ctx.save();
    ctx.font = BADGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const hidden = (cluster.count || 0) - (named.get(cluster.id) || 0) - (owned.get(cluster.id) || 0);
        if (hidden <= 0) continue;
        const text = badgeText(hidden);
        const pips = topStatusPips(cluster.statuses);
        const pipCount = pips ? pips.length : 0;
        const countWidth = BADGE_PADDING_X + text.length * BADGE_CHAR_WIDTH;
        const pipRowWidth = pipCount > 0
            ? pipCount * PIP_RADIUS * 2 + (pipCount - 1) * PIP_GAP
            : 0;
        const w = Math.max(countWidth, pipRowWidth + BADGE_PADDING_X);
        const h = pipCount > 0
            ? BADGE_HEIGHT + STANDARD_PADDING_TOP + PIP_ROW_HEIGHT
            : BADGE_HEIGHT;
        const x = badgeClearX(
            clusterWorldX(cluster),
            clusterWorldY(cluster) - auraRadiusX(cluster) * 0.5 - 12,
            w * s,
            h * s,
            s,
            auraRadiusX(cluster),
            agentSprites,
        );
        const y = _badgeClear.y;
        const aura = statusAura(cluster.dominantStatus);

        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        snapScreenOrigin(ctx);
        paintWalnutBoard(ctx, -Math.round(w / 2), -Math.round(h / 2), Math.round(w), Math.round(h));

        const countY = pipCount > 0 ? -Math.round(h / 2) + BADGE_HEIGHT / 2 : 0;
        ctx.fillStyle = BADGE_TEXT;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, 0, Math.round(countY) + 4);
        ctx.textBaseline = 'middle';

        if (pipCount > 0) {
            // Square pixel pips: a 1 px status-stroke border around the fill.
            const size = PIP_RADIUS * 2;
            const pipY = Math.round(h / 2 - PIP_ROW_HEIGHT / 2) - PIP_RADIUS;
            let pipX = Math.round(-pipRowWidth / 2);
            for (let p = 0; p < pipCount; p++) {
                const pip = pips[p];
                ctx.fillStyle = pip.stroke;
                ctx.fillRect(pipX, pipY, size, size);
                ctx.fillStyle = pip.fill;
                ctx.fillRect(pipX + 1, pipY + 1, size - 2, size - 2);
                pipX += size + PIP_GAP;
            }
        }
        ctx.restore();
    }
    ctx.restore();
}
