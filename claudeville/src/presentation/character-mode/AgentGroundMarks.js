// Pixel ground vocabulary for villagers (plan 2.3 / 2.5, contract C3).
//
// Every body stands on exactly one baked contact shadow. The ground carries a
// ring only when it means something: the selected agent, the hovered agent,
// and the three action-needed states (waiting on you, errored, rate-limited).
// W7.4 (D2: repo = colour) — under those, a quiet 1-texel course in the
// body's repo accent hugs the contact shadow, so bodies on one project read
// as one work party; any action-needed ring replaces it, and the caller's
// mark governor sheds it first under pressure.
//
// All marks are cached stamps rasterised on the world texel grid (hard 1-texel
// edges, no anti-aliasing, no gradients). The Canvas fallback blits them with
// drawImage; the resident WebGL renderer receives the same canvases as ground
// records, so both backends paint identical pixels. Static band: nothing here
// animates, and reduced motion sees the same frame.

import { RESERVED_STATUS } from '../../config/artPalette.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { frameCastLighting, pointCastFor, rasterizeCourses, villagerCastStamps } from './RakingLight.js';

// Warm near-black shared with the body rim (plan 2.4).
const SHADOW_RGB = [26, 20, 16];
const KEYLINE_RGB = [16, 11, 8];
const SHADOW_OUTER_ALPHA = 66;   // ~0.26 — the soft outer course
const SHADOW_CORE_ALPHA = 118;   // ~0.46 — the dense core under the feet
const KEYLINE_ALPHA = 150;       // dark course beneath a ring, lifts it off pale ground

const SHADOW_MIN_WIDTH = 14;
const SHADOW_MAX_WIDTH = 40;
// Contact shadow is ~0.72x the body's content width; rings sit just outside it.
const SHADOW_WIDTH_RATIO = 0.72;
const SHADOW_ASPECT = 0.38;
const RING_ASPECT = 0.44;
const SELECTED_RING_PAD = 12;
const STATUS_RING_PAD = 6;
const HOVER_RING_PAD = 8;
// The repo course sits one texel outside the contact shadow, inside every
// status, hover and selection ring, at a lighter strength than they do.
const REPO_RING_PAD = 2;
const REPO_RING_ALPHA = 200;
const REPO_KEYLINE_ALPHA = 96;

// Feet sit at the anchor; the shadow centre rides one texel below it.
export const GROUND_MARK_FOOT_Y = 1;

const ACTION_NEEDED_RING = Object.freeze({
    [AgentStatus.WAITING_ON_USER]: RESERVED_STATUS.needsYou,
    [AgentStatus.ERRORED]: RESERVED_STATUS.error,
    [AgentStatus.RATE_LIMITED]: RESERVED_STATUS.rateLimited,
});

const STAMP_CACHE = new Map();

function hexRgb(hex) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return [242, 199, 92];
    const n = Number.parseInt(value, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function makeCanvas(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

// Filled ellipse mask on the texel grid: row-by-row spans rounded to whole
// texels, so the edge is a clean stair, never a partial-alpha fringe.
function ellipseMask(width, height, insetX = 0, insetY = 0) {
    const mask = new Uint8Array(width * height);
    const rx = width / 2 - insetX;
    const ry = height / 2 - insetY;
    if (rx <= 0 || ry <= 0) return mask;
    for (let y = 0; y < height; y++) {
        const yy = (y + 0.5 - height / 2) / ry;
        if (Math.abs(yy) >= 1) continue;
        const half = rx * Math.sqrt(1 - yy * yy);
        const x0 = Math.max(0, Math.round(width / 2 - half));
        const x1 = Math.min(width, Math.round(width / 2 + half));
        for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
    }
    return mask;
}

function setPixel(data, index, rgb, alpha) {
    const offset = index * 4;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = alpha;
}

function evenWidth(value) {
    const width = Math.round((Number(value) || 0) / 2) * 2;
    return Math.max(SHADOW_MIN_WIDTH, Math.min(SHADOW_MAX_WIDTH, width));
}

// Contact-shadow width for a body whose content spans `contentWidth` texels.
export function contactShadowWidth(contentWidth) {
    return evenWidth((Number(contentWidth) || 28) * SHADOW_WIDTH_RATIO);
}

// Two stepped courses: a soft 1-texel outer band and a dense core. 1.5 — at
// golden hour and sunrise a thin raking trail runs from the feet along the
// sun in the violet cast colour (RakingLight), baked into the same stamp per
// sun bucket. 2.8 — at night, with no raking sun, a body inside a lamp's pool
// carries that lamp's point cast (`RakingLight.pointCastFor`) in the same
// stamp instead. The stamp then carries its feet anchor (`__anchorX/Y`), and
// where a trail and the contact overlap the stronger course wins, so nothing
// darkens twice.
const POINT_CAST_STAMP_MAX = 256;

export function contactShadowStamp(width, cast = frameCastLighting(), pointCast = null) {
    const w = evenWidth(width);
    const trail = pointCast ? [] : villagerCastStamps(w, cast);
    const key = pointCast
        ? `shadow|${w}|${pointCast.key}`
        : trail.length ? `shadow|${w}|${cast.key}` : `shadow|${w}`;
    const cached = STAMP_CACHE.get(key);
    if (cached) {
        if (pointCast) {
            STAMP_CACHE.delete(key);
            STAMP_CACHE.set(key, cached);
        }
        return cached;
    }
    if (trail.length) pruneCastStamps(cast.key);
    if (pointCast) prunePointCastStamps();
    const h = Math.max(5, Math.round(w * SHADOW_ASPECT) | 1);
    const outer = ellipseMask(w, h);
    const core = ellipseMask(w, h, 3, 1.5);
    const raster = pointCast || (trail.length ? rasterizeCourses(trail, cast.color) : null);
    // Contact box relative to the feet: top-left at (-w/2, -h/2).
    const cx0 = -Math.floor(w / 2);
    const cy0 = -Math.floor(h / 2);
    const minX = Math.min(cx0, raster ? raster.offsetX : cx0);
    const minY = Math.min(cy0, raster ? raster.offsetY : cy0);
    const maxX = Math.max(cx0 + w, raster ? raster.offsetX + raster.canvas.width : cx0 + w);
    const maxY = Math.max(cy0 + h, raster ? raster.offsetY + raster.canvas.height : cy0 + h);
    const canvas = makeCanvas(maxX - minX, maxY - minY);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (raster) {
        ctx.drawImage(raster.canvas, raster.offsetX - minX, raster.offsetY - minY);
        // The point cast raster stays in RakingLight's LRU; the raking trail
        // raster is this stamp's alone.
        if (!pointCast) releaseCanvasBackingStore(raster.canvas);
    }
    // The stronger of trail and contact course wins under the feet (never a sum).
    const image = ctx.getImageData(cx0 - minX, cy0 - minY, w, h);
    for (let i = 0; i < outer.length; i++) {
        if (!outer[i]) continue;
        const alpha = core[i] ? SHADOW_CORE_ALPHA : SHADOW_OUTER_ALPHA;
        if (image.data[i * 4 + 3] >= alpha) continue;
        setPixel(image.data, i, SHADOW_RGB, alpha);
    }
    ctx.putImageData(image, cx0 - minX, cy0 - minY);
    canvas.__cvGroundKey = key;
    canvas.__anchorX = -minX;
    canvas.__anchorY = -minY;
    STAMP_CACHE.set(key, canvas);
    return canvas;
}

// 2.8 — an LRU over the composed point-cast contact stamps.
function prunePointCastStamps() {
    let count = 0;
    for (const key of STAMP_CACHE.keys()) if (key.includes('|pc|')) count++;
    if (count < POINT_CAST_STAMP_MAX) return;
    for (const [key, canvas] of STAMP_CACHE) {
        if (!key.includes('|pc|')) continue;
        releaseCanvasBackingStore(canvas);
        STAMP_CACHE.delete(key);
        if (--count < POINT_CAST_STAMP_MAX) return;
    }
}

// Keep only the current sun bucket's trail stamps.
function pruneCastStamps(castKey) {
    for (const [key, canvas] of STAMP_CACHE) {
        if (!key.startsWith('shadow|') || key.split('|').length < 3 || key.endsWith(`|${castKey}`)) continue;
        releaseCanvasBackingStore(canvas);
        STAMP_CACHE.delete(key);
    }
}

// A 1-texel ellipse outline in `color`, with a dark keyline course directly
// beneath each lit texel so the ring holds on sunlit grass and pale plaza.
function ringStamp(kind, width, color, alpha = 255, keylineAlpha = KEYLINE_ALPHA) {
    const w = Math.max(8, Math.round((Number(width) || 0) / 2) * 2);
    const key = `${kind}|${w}|${color}|${alpha}|${keylineAlpha}`;
    const cached = STAMP_CACHE.get(key);
    if (cached) return cached;
    const h = Math.max(7, Math.round(w * RING_ASPECT) | 1);
    const canvas = makeCanvas(w, h + 1);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h + 1);
    const inside = ellipseMask(w, h);
    const rgb = hexRgb(color);
    const lit = new Uint8Array(w * (h + 1));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (!inside[index]) continue;
            const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
                || !inside[index - 1] || !inside[index + 1]
                || !inside[index - w] || !inside[index + w];
            if (edge) lit[index] = 1;
        }
    }
    for (let y = 0; y <= h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (lit[index]) {
                setPixel(image.data, index, rgb, alpha);
            } else if (y > 0 && lit[index - w] && !(y < h && inside[index])) {
                setPixel(image.data, index, KEYLINE_RGB, keylineAlpha);
            }
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas.__cvGroundKey = key;
    STAMP_CACHE.set(key, canvas);
    return canvas;
}

export function actionNeededRingColor(status) {
    return ACTION_NEEDED_RING[status] || null;
}

// W7.4 — which rings a body's ground carries, in paint order (pure, so the
// priority is testable without a canvas). An action-needed ring always wins
// over the repo course: the course never stacks under NEEDS YOU, ERROR or
// LIMIT. Selection and hover sit outside both.
export function groundRingPlan({ status = null, selected = false, hovered = false, repo = null } = {}) {
    const plan = [];
    const statusColor = actionNeededRingColor(status);
    if (statusColor) plan.push({ kind: 'status', pad: STATUS_RING_PAD, color: statusColor });
    else if (repo) plan.push({ kind: 'repo', pad: REPO_RING_PAD, color: repo });
    if (selected) plan.push({ kind: 'selected', pad: SELECTED_RING_PAD });
    else if (hovered) plan.push({ kind: 'hover', pad: HOVER_RING_PAD });
    return plan;
}

// Resolves the ground mark set for one body. `x`/`y` is the body's placement
// for this frame (V7 `snapBodyPx`: a whole texel at rest, the backing-pixel
// grid while walking), taken as is so shadow, rings and body never part.
// `owner` (the body) keeps its 2.8 lamp choice between frames. `repo` is the
// admitted repo accent or null. Returns stamps plus top-left positions in
// world texels; callers paint them in order.
export function resolveGroundMarks({ x, y, contentWidth, status, selected = false, hovered = false, accent, trim, repo = null, owner = null }) {
    const cx = x;
    const cy = y + GROUND_MARK_FOOT_Y;
    const shadowW = contactShadowWidth(contentWidth);
    const marks = [];
    const push = (stamp, kind) => {
        if (!stamp) return;
        marks.push({
            kind,
            stamp,
            x: cx - (stamp.__anchorX ?? Math.floor(stamp.width / 2)),
            y: cy - (stamp.__anchorY ?? Math.floor(stamp.height / 2)),
        });
    };
    const cast = frameCastLighting();
    push(contactShadowStamp(shadowW, cast, pointCastFor(owner, cx, cy, shadowW, cast)), 'shadow');
    for (const ring of groundRingPlan({ status, selected, hovered, repo })) {
        const width = shadowW + ring.pad;
        if (ring.kind === 'repo') push(ringStamp('repo', width, ring.color, REPO_RING_ALPHA, REPO_KEYLINE_ALPHA), 'repo');
        else if (ring.kind === 'status') push(ringStamp('status', width, ring.color), 'status');
        else if (ring.kind === 'selected') push(ringStamp('selected', width, accent), 'selected');
        else push(ringStamp('hover', width, trim), 'hover');
    }
    return marks;
}

// Texels from the feet anchor down to the lowest row of the ground marks
// resolveGroundMarks would lay out (contact core or ring; the raking-light
// trail is a cast, not a mark), so labels under the feet can clear them.
export function groundMarkDepth({ contentWidth, status = null, selected = false, hovered = false, repo = null } = {}) {
    const shadowW = contactShadowWidth(contentWidth);
    const shadowH = Math.max(5, Math.round(evenWidth(shadowW) * SHADOW_ASPECT) | 1);
    let depth = Math.ceil(shadowH / 2);
    for (const ring of groundRingPlan({ status, selected, hovered, repo })) {
        const w = Math.max(8, Math.round((shadowW + ring.pad) / 2) * 2);
        const h = Math.max(7, Math.round(w * RING_ASPECT) | 1);
        depth = Math.max(depth, Math.ceil((h + 1) / 2));
    }
    return GROUND_MARK_FOOT_Y + depth;
}

export function drawGroundMarks(ctx, marks) {
    if (!ctx || !marks?.length) return;
    for (const mark of marks) ctx.drawImage(mark.stamp, mark.x, mark.y);
}

// Selected-agent chevron: a small downward marker floating above the head on
// the art-pixel grid. Two texels per pixel below zoom 1.75 so it survives the
// overview; one texel at detail zoom. Returns the world height it occupies so
// labels above the head can clear it.
const CHEVRON_ROWS = Object.freeze([
    'ooooooo',
    'ohhhhho',
    '.ogggo.',
    '..ogo..',
    '...o...',
]);
const CHEVRON_GAP = 2;

export function selectionChevronUnit(zoom) {
    return (Number(zoom) || 1) < 1.75 ? 2 : 1;
}

export function selectionChevronClearance(zoom) {
    return (CHEVRON_ROWS.length + CHEVRON_GAP) * selectionChevronUnit(zoom);
}

export function drawSelectionChevron(ctx, x, headTopY, zoom, lift = 0, colors = {}) {
    if (!ctx || !Number.isFinite(headTopY)) return;
    const unit = selectionChevronUnit(zoom);
    const gold = colors.gold || '#f2c75c';
    const goldHi = colors.goldHi || '#ffe08a';
    const ink = colors.ink || '#140e0a';
    const left = Math.round(x) - 3 * unit;
    const top = Math.round(headTopY) - (CHEVRON_ROWS.length + CHEVRON_GAP) * unit - Math.round(lift) * unit;
    ctx.save();
    for (let row = 0; row < CHEVRON_ROWS.length; row++) {
        const line = CHEVRON_ROWS[row];
        for (let col = 0; col < line.length; col++) {
            const cell = line[col];
            if (cell === '.') continue;
            ctx.fillStyle = cell === 'o' ? ink : cell === 'h' ? goldHi : gold;
            ctx.fillRect(left + col * unit, top + row * unit, unit, unit);
        }
    }
    ctx.restore();
}
