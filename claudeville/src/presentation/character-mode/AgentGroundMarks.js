// Pixel ground vocabulary for villagers (plan 2.3 / 2.5, contract C3).
//
// Every body stands on exactly one baked contact shadow. Action-needed states
// (waiting on you, errored, rate-limited) carry Tier-A solid status rings;
// routine WORKING (emerald split arc) and WAITING (outlined amber dashed arc)
// carry static Tier-B ground marks admitted under MarkGovernor WORKING tier,
// while IDLE stands on shadow-only feet (relaxed 2026-11-23, operator
// decision). Selected villagers carry a 2-texel Tier-A palette-gold ring with
// a #140e0a keyline (brighter than the 1-texel cream hover ring). Under
// non-idle states without a status ring, W7.4 keeps the quiet 1-texel repo
// course hugging the contact shadow.
//
// All marks are cached stamps rasterised on the world texel grid (hard 1-texel
// edges, no anti-aliasing, no gradients). The Canvas fallback blits them with
// drawImage; the resident GPU renderers receive the same canvases as ground
// records, so all three backends paint identical pixels. Static band: nothing
// here animates, and reduced motion sees the same frame.

import { ART_RAMPS, EFFECT_COLORS, RESERVED_STATUS } from '../../config/artPalette.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { frameCastLighting, pointCastFor, rasterizeCourses, villagerCastLighting, villagerCastStamps } from './RakingLight.js';
import { LABEL_INK } from './WorldLabelKit.js';

// Warm near-black shared with the body rim (plan 2.4).
const SHADOW_RGB = [26, 20, 16];
const KEYLINE_RGB = [20, 14, 10]; // #140e0a dark ink keyline
const SHADOW_OUTER_ALPHA = 96;    // ~0.38 — firmer outer grounding course (relaxed 2026-11-23, operator decision)
const SHADOW_CORE_ALPHA = 188;    // ~0.74 — firmer boot contact grounding (relaxed 2026-11-23, operator decision)
const KEYLINE_ALPHA = 150;        // dark course beneath a ring, lifts it off pale ground
const SELECTED_KEYLINE_ALPHA = 240;
const ROUTINE_KEYLINE_ALPHA = 225;

const SHADOW_MIN_WIDTH = 14;
const SHADOW_MAX_WIDTH = 40;
// Contact shadow is ~0.84x the body's content width; rings sit just outside it
// (relaxed 2026-11-23, operator decision).
const SHADOW_WIDTH_RATIO = 0.84;
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
const HOVER_RING_ALPHA = 225;

// Tier-A palette gold for selection (outer gleam L=0.74, inner body S=0.68)
// and quieter parchment cream for 1-texel hover.
export const SELECTED_RING_GOLD = ART_RAMPS.trimGold[3];
export const SELECTED_RING_GOLD_INNER = EFFECT_COLORS.success;
export const HOVER_RING_COLOR = LABEL_INK.text;

// Feet sit at the anchor; the shadow centre rides one texel below it.
export const GROUND_MARK_FOOT_Y = 1;

const ACTION_NEEDED_RING = Object.freeze({
    [AgentStatus.WAITING_ON_USER]: RESERVED_STATUS.needsYou,
    [AgentStatus.ERRORED]: RESERVED_STATUS.error,
    [AgentStatus.RATE_LIMITED]: RESERVED_STATUS.rateLimited,
});

const ROUTINE_STATUS_RING = Object.freeze({
    [AgentStatus.WORKING]: Object.freeze({ kind: 'working', color: RESERVED_STATUS.working }),
    [AgentStatus.WAITING]: Object.freeze({ kind: 'waiting', color: RESERVED_STATUS.waiting }),
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
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

// SD-2 — the sun trail as a stamp of its own (RakingLight's `clip` twin),
// painted over the bare contact stamp: the resident scene hides it texel by
// texel wherever the shade field already shades the ground. Inside the
// contact's ellipse it keeps only what the trail adds over the contact course
// (the stronger still wins, never a sum), so the pair reads as the one stamp
// above in the sun and as the bare contact in a building's shade.
export function sunTrailStamp(width, cast) {
    const w = evenWidth(width);
    const key = `trail|${w}|${cast.key}`;
    const cached = STAMP_CACHE.get(key);
    if (cached) return cached;
    const trail = villagerCastStamps(w, cast);
    const raster = trail.length ? rasterizeCourses(trail, cast.color) : null;
    if (!raster) return null;
    pruneCastStamps(cast.key);
    const h = Math.max(5, Math.round(w * SHADOW_ASPECT) | 1);
    const outer = ellipseMask(w, h);
    const core = ellipseMask(w, h, 3, 1.5);
    const canvas = raster.canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // The contact box (top-left at the feet's -w/2, -h/2) on the raster.
    const left = -Math.floor(w / 2) - raster.offsetX;
    const top = -Math.floor(h / 2) - raster.offsetY;
    const image = ctx.getImageData(left, top, w, h);
    for (let i = 0; i < outer.length; i++) {
        if (!outer[i]) continue;
        const contact = (core[i] ? SHADOW_CORE_ALPHA : SHADOW_OUTER_ALPHA) / 255;
        const alpha = image.data[i * 4 + 3] / 255;
        image.data[i * 4 + 3] = alpha > contact ? Math.round(255 * (1 - (1 - alpha) / (1 - contact))) : 0;
    }
    ctx.putImageData(image, left, top);
    canvas.__cvGroundKey = key;
    canvas.__anchorX = -raster.offsetX;
    canvas.__anchorY = -raster.offsetY;
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
        if (!/^(?:shadow|trail)\|/.test(key) || key.split('|').length < 3 || key.endsWith(`|${castKey}`)) continue;
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
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

export function routineStatusRing(status) {
    return ROUTINE_STATUS_RING[status] || null;
}

function quantizeRoutineAlpha(alpha) {
    if (!Number.isFinite(alpha)) return 235;
    if (alpha >= 0.65) return 235;
    if (alpha >= 0.35) return 185;
    return 140;
}

// 2-texel Tier-A gold selection ring with a full 1-texel #140e0a outer keyline
// (relaxed 2026-11-23, operator decision). Brighter and bolder than hover.
export function selectedRingStamp(width, outerColor = SELECTED_RING_GOLD, innerColor = SELECTED_RING_GOLD_INNER) {
    const w = Math.max(8, Math.round((Number(width) || 0) / 2) * 2);
    const key = `selected2|${w}|${outerColor}|${innerColor}`;
    const cached = STAMP_CACHE.get(key);
    if (cached) return cached;
    const h = Math.max(7, Math.round(w * RING_ASPECT) | 1);
    const cw = w + 2;
    const ch = h + 2;
    const canvas = makeCanvas(cw, ch);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.createImageData(cw, ch);
    const inside = ellipseMask(w, h);
    const outerLit = new Uint8Array(w * h);
    const innerLit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (!inside[index]) continue;
            const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
                || !inside[index - 1] || !inside[index + 1]
                || !inside[index - w] || !inside[index + w];
            if (edge) outerLit[index] = 1;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (!inside[index] || outerLit[index]) continue;
            const touchesOuter = (x > 0 && outerLit[index - 1])
                || (x + 1 < w && outerLit[index + 1])
                || (y > 0 && outerLit[index - w])
                || (y + 1 < h && outerLit[index + w]);
            if (touchesOuter) innerLit[index] = 1;
        }
    }
    const outerRgb = hexRgb(outerColor);
    const innerRgb = hexRgb(innerColor);
    const hasOuter = (ex, ey) => ex >= 0 && ex < w && ey >= 0 && ey < h && outerLit[ey * w + ex] === 1;
    const isInside = (ex, ey) => ex >= 0 && ex < w && ey >= 0 && ey < h && inside[ey * w + ex] === 1;
    for (let cy = 0; cy < ch; cy++) {
        const ey = cy - 1;
        for (let cx = 0; cx < cw; cx++) {
            const ex = cx - 1;
            const outIdx = cy * cw + cx;
            if (hasOuter(ex, ey)) {
                setPixel(image.data, outIdx, outerRgb, 255);
            } else if (ex >= 0 && ex < w && ey >= 0 && ey < h && innerLit[ey * w + ex]) {
                setPixel(image.data, outIdx, innerRgb, 255);
            } else if (!isInside(ex, ey) && (hasOuter(ex - 1, ey) || hasOuter(ex + 1, ey) || hasOuter(ex, ey - 1) || hasOuter(ex, ey + 1))) {
                setPixel(image.data, outIdx, KEYLINE_RGB, SELECTED_KEYLINE_ALPHA);
            }
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas.__cvGroundKey = key;
    canvas.__anchorX = Math.floor(cw / 2);
    canvas.__anchorY = Math.floor(ch / 2);
    STAMP_CACHE.set(key, canvas);
    return canvas;
}

// Static ground arcs for routine states (relaxed 2026-11-23, operator
// decision): a sage/emerald split arc under WORKING and an outlined amber
// dashed arc under WAITING, both framed by a 1-texel #140e0a outline.
export function statusArcStamp(kind, width, color, alpha = 235) {
    const w = Math.max(8, Math.round((Number(width) || 0) / 2) * 2);
    const a = Math.max(1, Math.min(255, Math.round(Number(alpha) || 235)));
    const key = `arc|${kind}|${w}|${color}|${a}`;
    const cached = STAMP_CACHE.get(key);
    if (cached) return cached;
    const h = Math.max(7, Math.round(w * RING_ASPECT) | 1);
    const cw = w + 2;
    const ch = h + 2;
    const canvas = makeCanvas(cw, ch);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.createImageData(cw, ch);
    const inside = ellipseMask(w, h);
    const lit = new Uint8Array(cw * ch);
    const rx = w / 2;
    const ry = h / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (!inside[index]) continue;
            const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
                || !inside[index - 1] || !inside[index + 1]
                || !inside[index - w] || !inside[index + w];
            if (!edge) continue;
            const theta = Math.atan2((y + 0.5 - ry) / ry, (x + 0.5 - rx) / rx);
            let keep = false;
            if (kind === 'working') {
                // Two balanced left/right arcs cradling the boots, open at top/bottom.
                keep = Math.abs(Math.cos(theta)) >= 0.36;
            } else if (kind === 'waiting') {
                // Eight symmetric crisp dashes around the ellipse.
                const sector = Math.floor((((theta + Math.PI) / (2 * Math.PI)) * 16) + 0.5) % 16;
                keep = sector % 2 === 0;
            }
            if (keep) lit[(y + 1) * cw + (x + 1)] = 1;
        }
    }
    const rgb = hexRgb(color);
    const outlineAlpha = Math.min(ROUTINE_KEYLINE_ALPHA, a);
    for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
            const index = y * cw + x;
            if (lit[index]) {
                setPixel(image.data, index, rgb, a);
            } else {
                const touches = (x > 0 && lit[index - 1])
                    || (x + 1 < cw && lit[index + 1])
                    || (y > 0 && lit[index - cw])
                    || (y + 1 < ch && lit[index + cw]);
                if (touches) setPixel(image.data, index, KEYLINE_RGB, outlineAlpha);
            }
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas.__cvGroundKey = key;
    canvas.__anchorX = Math.floor(cw / 2);
    canvas.__anchorY = Math.floor(ch / 2);
    STAMP_CACHE.set(key, canvas);
    return canvas;
}

// Which rings a body's ground carries, in paint order (pure, so the priority
// is testable without a canvas). Action-needed rings always win; static
// WORKING split arcs and WAITING dashed arcs sit below them (when admitted by
// MarkGovernor WORKING tier), IDLE carries nothing, and the W7.4 repo course
// stays available for non-idle states without a status mark. Selection and
// hover sit outside all of them.
export function groundRingPlan({
    status = null,
    selected = false,
    hovered = false,
    repo = null,
    routineStatus = true,
} = {}) {
    const plan = [];
    const statusColor = actionNeededRingColor(status);
    const routine = routineStatus ? routineStatusRing(status) : null;
    if (statusColor) {
        plan.push({ kind: 'status', pad: STATUS_RING_PAD, color: statusColor });
    } else if (routine) {
        plan.push({ kind: routine.kind, pad: STATUS_RING_PAD, color: routine.color });
    } else if (repo && status !== AgentStatus.IDLE) {
        plan.push({ kind: 'repo', pad: REPO_RING_PAD, color: repo });
    }
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
export function resolveGroundMarks({
    x,
    y,
    contentWidth,
    status,
    selected = false,
    hovered = false,
    accent,
    trim,
    repo = null,
    routineStatus = true,
    routineAlpha = null,
    owner = null,
}) {
    const cx = x;
    const cy = y + GROUND_MARK_FOOT_Y;
    const shadowW = contactShadowWidth(contentWidth);
    const marks = [];
    const push = (stamp, kind, sunCast = false) => {
        if (!stamp) return;
        marks.push({
            kind,
            stamp,
            x: cx - (stamp.__anchorX ?? Math.floor(stamp.width / 2)),
            y: cy - (stamp.__anchorY ?? Math.floor(stamp.height / 2)),
            sunCast,
        });
    };
    // SD-1 — the frame's cast, or its twin for a body in the sun or in shade.
    // SD-2 — a `clip` twin lays its trail as a second stamp over the contact.
    const cast = villagerCastLighting(cx, cy);
    const pointCast = pointCastFor(owner, cx, cy, shadowW, cast);
    const clipTrail = cast?.clip === true && !pointCast;
    push(contactShadowStamp(shadowW, clipTrail ? cast.base : cast, pointCast), 'shadow');
    if (clipTrail) push(sunTrailStamp(shadowW, cast), 'cast', true);
    const arcAlpha = quantizeRoutineAlpha(routineAlpha);
    for (const ring of groundRingPlan({ status, selected, hovered, repo, routineStatus })) {
        const width = shadowW + ring.pad;
        if (ring.kind === 'repo') {
            push(ringStamp('repo', width, ring.color, REPO_RING_ALPHA, REPO_KEYLINE_ALPHA), 'repo');
        } else if (ring.kind === 'status') {
            push(ringStamp('status', width, ring.color), 'status');
        } else if (ring.kind === 'working' || ring.kind === 'waiting') {
            push(statusArcStamp(ring.kind, width, ring.color, arcAlpha), ring.kind);
        } else if (ring.kind === 'selected') {
            push(selectedRingStamp(width), 'selected');
        } else {
            push(ringStamp('hover', width, HOVER_RING_COLOR, HOVER_RING_ALPHA), 'hover');
        }
    }
    return marks;
}

// Texels from the feet anchor down to the lowest row of the ground marks
// resolveGroundMarks would lay out (contact core or ring; the raking-light
// trail is a cast, not a mark), so labels under the feet can clear them.
export function groundMarkDepth({
    contentWidth,
    status = null,
    selected = false,
    hovered = false,
    repo = null,
    routineStatus = true,
} = {}) {
    const shadowW = contactShadowWidth(contentWidth);
    const shadowH = Math.max(5, Math.round(evenWidth(shadowW) * SHADOW_ASPECT) | 1);
    let depth = Math.ceil(shadowH / 2);
    for (const ring of groundRingPlan({ status, selected, hovered, repo, routineStatus })) {
        const w = Math.max(8, Math.round((shadowW + ring.pad) / 2) * 2);
        const h = Math.max(7, Math.round(w * RING_ASPECT) | 1);
        const extra = (ring.kind === 'selected' || ring.kind === 'working' || ring.kind === 'waiting') ? 2 : 1;
        depth = Math.max(depth, Math.ceil((h + extra) / 2));
    }
    return GROUND_MARK_FOOT_Y + depth;
}

export function drawGroundMarks(ctx, marks) {
    if (!ctx || !marks?.length) return;
    for (const mark of marks) ctx.drawImage(mark.stamp, mark.x, mark.y);
}

// Selected-agent chevron: a 9x6 downward marker floating above the head on
// the art-pixel grid. Two texels per pixel with a 1-texel dark halo below zoom
// 1.75 so it survives the overview; one texel at detail zoom (widened
// 2026-11-23, operator decision).
export const CHEVRON_ROWS = Object.freeze([
    'ooooooooo',
    'ohhhhhhho',
    '.ogggggo.',
    '..ogggo..',
    '...ogo...',
    '....o....',
]);
const CHEVRON_GAP = 2;

export function selectionChevronUnit(zoom) {
    return (Number(zoom) || 1) < 1.75 ? 2 : 1;
}

export function selectionChevronClearance(zoom) {
    const unit = selectionChevronUnit(zoom);
    return (CHEVRON_ROWS.length + CHEVRON_GAP) * unit + (unit > 1 ? 1 : 0);
}

export function drawSelectionChevron(ctx, x, headTopY, zoom, lift = 0, colors = {}) {
    if (!ctx || !Number.isFinite(headTopY)) return;
    const unit = selectionChevronUnit(zoom);
    const gold = colors.gold || SELECTED_RING_GOLD_INNER;
    const goldHi = colors.goldHi || SELECTED_RING_GOLD;
    const ink = colors.ink || '#140e0a';
    const halfCols = Math.floor(CHEVRON_ROWS[0].length / 2);
    const left = Math.round(x) - halfCols * unit;
    const top = Math.round(headTopY) - (CHEVRON_ROWS.length + CHEVRON_GAP) * unit - Math.round(lift) * unit;
    ctx.save();
    if (unit > 1) {
        // 1-world-texel dark halo below zoom 1.75 so the chevron pops at overview zoom.
        ctx.fillStyle = ink;
        for (let row = 0; row < CHEVRON_ROWS.length; row++) {
            const line = CHEVRON_ROWS[row];
            for (let col = 0; col < line.length; col++) {
                if (line[col] === '.') continue;
                ctx.fillRect(left + col * unit - 1, top + row * unit - 1, unit + 2, unit + 2);
            }
        }
    }
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
