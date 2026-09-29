// C5 world label kit (plan 5.1–5.6): the shared materials of every in-world
// label tier. Everything here paints in whole screen pixels — callers either
// work in CSS-pixel screen space or have already cancelled camera zoom — so a
// label never stretches with the world and never lands on a half pixel.
//
//   T1  attention plate + body beacon   AttentionPlates.js
//   T2  selected / hovered name plate   AgentSprite (paintNamePlate)
//   T3  carved district plaque          BuildingSprite (paintWalnutBoard)
//   T4  routine name, text only         AgentSprite (paintOutlinedText)
//   T5  +N crowd tab                    CrowdClusterOverlay (paintWalnutBoard)
//
// Static by construction: nothing here animates, so reduced motion is
// pixel-identical.

import { EVENT_SHAPES } from '../shared/EventShapes.js';

export const LABEL_INK = Object.freeze({
    text: '#f3e2bd',
    textDim: '#bfae8f',
    outline: '#120c08',
    plate: '#1c130c',
    plateOutline: '#0e0906',
    gold: '#f2c75c',
    brass: '#b8893f',
});

// Carved walnut board (T3 plaques, T5 crowd tabs).
export const WALNUT = Object.freeze({
    fill: '#3b2616',
    bevel: '#5c3d22',
    shade: '#24160c',
    outline: '#0e0906',
    nail: '#8a6a3c',
    text: '#e9c46a',
    count: '#f3e2bd',
    divider: '#24160c',
});

// T2 plate / T4 name geometry in screen pixels, shared by AgentSprite (which
// paints it) and IsometricRenderer (which admits it) so every reservation is
// the rectangle actually drawn. Both sit just under the feet.
export const IDENTITY_LABEL = Object.freeze({
    charWidth: 7,          // Departure Mono 11 px advance
    maxTextWidth: 140,
    textHeight: 12,        // outline + 8 cap rows + 2 descent rows + outline
    textBaseline: 9,       // from the label top
    plateHeight: 15,
    plateBaseline: 11,
    platePadLeft: 7,       // outline + 2 px trim bar + 4 px pad
    platePadRight: 6,      // 5 px pad + outline
    slotStep: 13,          // READ-hold stacking only
});

// Screen pixels from the feet to the label top: clears the ground marks
// (contact shadow, and the ring when one is drawn) by a 2 px gap. The marks
// grow with the world while the label does not. `markDepth` is in world
// texels below the feet (AgentGroundMarks.groundMarkDepth); the default is
// the plain contact shadow of an ordinary body.
export const IDENTITY_LABEL_GAP = 2;
export function identityLabelTop(zoom = 1, markDepth = 6) {
    return Math.ceil((Number(markDepth) || 0) * (zoom || 1)) + IDENTITY_LABEL_GAP;
}

export function identityLabelWidth(text, { plate = false } = {}) {
    const textWidth = Math.min(IDENTITY_LABEL.maxTextWidth, String(text || '').length * IDENTITY_LABEL.charWidth);
    return plate
        ? textWidth + IDENTITY_LABEL.platePadLeft + IDENTITY_LABEL.platePadRight
        : textWidth + 2;
}

const OUTLINE_TAPS = Object.freeze([
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
]);

// Moves the current origin onto a whole device pixel, so screen-fixed pixel
// geometry anchored at a fractional world point never straddles two pixels.
export function snapScreenOrigin(ctx) {
    const t = ctx.getTransform();
    if (!t.a || !t.d) return;
    ctx.translate((Math.round(t.e) - t.e) / t.a, (Math.round(t.f) - t.f) / t.d);
}

// T4 grammar: an 8-tap one-pixel outline, then the fill. Callers set font,
// textAlign and an 'alphabetic' baseline; x/y must be whole screen pixels.
export function paintOutlinedText(ctx, text, x, y, fill = LABEL_INK.text, outline = LABEL_INK.outline) {
    ctx.fillStyle = outline;
    for (const [dx, dy] of OUTLINE_TAPS) ctx.fillText(text, x + dx, y + dy);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
}

// Square board with a lit top row, a shaded bottom row, a one-pixel dark
// outline and, when asked, four nail heads. No curves, no glow, no alpha.
export function paintWalnutBoard(ctx, left, top, width, height, { nails = false, lit = false } = {}) {
    const x = Math.round(left);
    const y = Math.round(top);
    const w = Math.max(3, Math.round(width));
    const h = Math.max(3, Math.round(height));
    ctx.fillStyle = WALNUT.outline;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = WALNUT.fill;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = lit ? '#7a5530' : WALNUT.bevel;
    ctx.fillRect(x + 1, y + 1, w - 2, 1);
    ctx.fillStyle = WALNUT.shade;
    ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
    if (nails && w >= 12 && h >= 9) {
        ctx.fillStyle = WALNUT.nail;
        ctx.fillRect(x + 2, y + 3, 1, 1);
        ctx.fillRect(x + w - 3, y + 3, 1, 1);
        ctx.fillRect(x + 2, y + h - 4, 1, 1);
        ctx.fillRect(x + w - 3, y + h - 4, 1, 1);
    }
}

// An authored 8×8 EventShapes motif with a one-pixel dark silhouette
// outline, baked once per (motif, colour, step, device scale) and blitted in
// device pixels. `x`/`y` are the top-left of the 8×8 motif (not the padded
// 16×16 grid) in the caller's current units; the drawn box is
// (8 * step + 2) square, starting one pixel up and left.
const MOTIF_STAMPS = new Map();
const MOTIF_STAMP_LIMIT = 96;

function motifRows(id) {
    const rows = EVENT_SHAPES[id];
    return rows ? rows.slice(4, 12).map(row => row.slice(4, 12)) : null;
}

function bakeOutlinedMotif(id, color, outline, step, scale) {
    const rows = motifRows(id);
    if (!rows) return null;
    const unit = Math.max(1, Math.round(scale));
    const size = 8 * step + 2;
    const canvas = document.createElement('canvas');
    canvas.width = size * unit;
    canvas.height = size * unit;
    const stamp = canvas.getContext('2d');
    const fill = (px, py, w, h) => stamp.fillRect(px * unit, py * unit, w * unit, h * unit);
    stamp.fillStyle = outline;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if (rows[row][col] !== '1') continue;
            fill(col * step, row * step, step + 2, step + 2);
        }
    }
    stamp.fillStyle = color;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if (rows[row][col] !== '1') continue;
            fill(1 + col * step, 1 + row * step, step, step);
        }
    }
    return { canvas, size, unit };
}

// The cached stamp for (motif, colour, outline, step) at a device `scale`:
// `{ canvas, size, unit }`, `canvas` in device pixels (`size * unit` square).
// T1 — the resident path samples the same stamp as a GPU mark record.
export function outlinedMotifStamp(id, { step = 1, color = LABEL_INK.text, outline = LABEL_INK.outline, scale = 1 } = {}) {
    const key = `${id}|${color}|${outline}|${step}|${Math.round(scale * 100)}`;
    let stamp = MOTIF_STAMPS.get(key);
    if (!stamp) {
        stamp = bakeOutlinedMotif(id, color, outline, Math.max(1, Math.round(step)), scale);
        if (!stamp) return null;
        if (MOTIF_STAMPS.size >= MOTIF_STAMP_LIMIT) {
            const oldest = MOTIF_STAMPS.keys().next().value;
            MOTIF_STAMPS.delete(oldest);
        }
        stamp.key = key;
        MOTIF_STAMPS.set(key, stamp);
    }
    return stamp;
}

export function drawOutlinedMotif(ctx, id, x, y, { step = 1, color = LABEL_INK.text, outline = LABEL_INK.outline } = {}) {
    const transform = ctx.getTransform();
    const scale = Math.abs(transform.a) || 1;
    const stamp = outlinedMotifStamp(id, { step, color, outline, scale });
    if (!stamp) return;
    const deviceX = Math.round((x - 1) * transform.a + transform.e);
    const deviceY = Math.round((y - 1) * transform.d + transform.f);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(stamp.canvas, deviceX, deviceY);
    ctx.restore();
}

// Cached text widths: measureText once per (font, text) instead of per frame.
const WIDTH_CACHE = new Map();
const WIDTH_CACHE_LIMIT = 512;

export function measureLabelText(ctx, text) {
    const key = `${ctx.font}|${text}`;
    let width = WIDTH_CACHE.get(key);
    if (width === undefined) {
        width = Math.ceil(ctx.measureText(text).width);
        if (WIDTH_CACHE.size >= WIDTH_CACHE_LIMIT) WIDTH_CACHE.clear();
        WIDTH_CACHE.set(key, width);
    }
    return width;
}

// Clip text to `maxWidth` pixels with a trailing ellipsis, measured once.
export function fitLabelText(ctx, text, maxWidth) {
    const value = String(text || '');
    if (measureLabelText(ctx, value) <= maxWidth) return value;
    let end = value.length;
    while (end > 1 && measureLabelText(ctx, `${value.slice(0, end)}…`) > maxWidth) end--;
    return `${value.slice(0, end)}…`;
}

if (typeof document !== 'undefined' && document.fonts?.ready) {
    // Widths measured against a fallback face before the bitmap fonts load
    // would misplace every cell for the life of the page.
    document.fonts.ready.then(() => WIDTH_CACHE.clear());
}
