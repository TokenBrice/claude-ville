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

// W3 thought plate in the label grammar: a whole-pixel board with 45° stepped
// corners, a one-pixel trim ring in the speaker's model trim and a one-pixel
// dark outline outside it, so a thought reads in the same carved material as
// the plaques. `tail` > 0 hangs a stepped speech notch at `tailX` (relative to
// the plate's centre, clamped inside the corners); `puffs` hangs the two
// thought puffs there instead (reasoning, never a quote). Opaque fill, and
// every texel is painted exactly once, so a caller's globalAlpha (older
// history rows fade) dims the whole plate evenly instead of compounding its
// layers.
const PLATE_NOTCH_HALVES = Object.freeze([3, 3, 2, 2, 1, 0]);
// The thought puffs in the notch's rows below the board, as disjoint
// [row, from, to] column runs from the tail column (row 0 is the board's own
// bottom edge): a 6×4 trim ring with a 4×2 dark core, then a 3×2 bead whose
// foot sits on the tail column, where a displaced head's leader starts. The
// ring trails to the side away from the tail's lean, so puffs and leader read
// as one path to the speaker.
const PUFF_RUNS = Object.freeze({
    outline: Object.freeze([
        [1, -7, -7], [1, -2, -2], [2, -8, -8], [2, -1, -1], [3, -8, -8], [3, -1, 2],
        [4, -7, -7], [4, -2, -1], [4, 3, 3], [5, -6, -3], [5, -1, -1], [5, 3, 3], [6, 0, 2],
    ]),
    trim: Object.freeze([
        [1, -6, -3], [2, -7, -7], [2, -2, -2], [3, -7, -7], [3, -2, -2], [4, -6, -3], [4, 0, 2], [5, 0, 2],
    ]),
    fill: Object.freeze([[2, -6, -3], [3, -6, -3]]),
});
const PUFF_REACH = 9;
export function paintThoughtPlate(ctx, left, top, width, height, {
    trim = LABEL_INK.gold,
    fill = '#221813',
    outline = LABEL_INK.outline,
    tail = 0,
    tailX = 0,
    puffs = false,
} = {}) {
    const x = Math.round(left);
    const y = Math.round(top);
    const w = Math.max(6, Math.round(width));
    const h = Math.max(6, Math.round(height));
    const right = x + w - 1;
    const bottom = y + h - 1;
    const base = y + h;
    // One row from column a to b inclusive; nothing when b < a.
    const run = (a, b, py) => {
        if (b >= a) ctx.fillRect(a, py, b - a + 1, 1);
    };
    // The tail column is a whole pixel: the board's middle column plus the
    // lean, the same column a displaced head's leader runs down.
    const lean = Math.round(tailX);
    const cx = Math.max(x + (puffs ? PUFF_REACH : 5),
        Math.min(right - (puffs ? PUFF_REACH : 5), x + Math.floor(w / 2) + lean));
    const notch = tail > 0 && !puffs;
    const mouth = PLATE_NOTCH_HALVES[0];
    const rows = notch ? Math.min(tail, PLATE_NOTCH_HALVES.length) : 0;
    // Outline: the four edges, the eight corner steps and the notch's sides.
    // A notch takes its mouth out of the bottom edge.
    ctx.fillStyle = outline;
    run(x + 2, right - 2, y - 1);
    run(x + 2, notch ? cx - mouth - 2 : right - 2, base);
    if (notch) run(cx + mouth + 2, right - 2, base);
    ctx.fillRect(x - 1, y + 2, 1, h - 4);
    ctx.fillRect(right + 1, y + 2, 1, h - 4);
    ctx.fillRect(x + 1, y, 1, 1);
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillRect(right - 1, y, 1, 1);
    ctx.fillRect(right, y + 1, 1, 1);
    ctx.fillRect(x + 1, bottom, 1, 1);
    ctx.fillRect(x, bottom - 1, 1, 1);
    ctx.fillRect(right - 1, bottom, 1, 1);
    ctx.fillRect(right, bottom - 1, 1, 1);
    for (let k = 0; k < rows; k++) {
        ctx.fillRect(cx - PLATE_NOTCH_HALVES[k] - 1, base + k, 1, 1);
        ctx.fillRect(cx + PLATE_NOTCH_HALVES[k] + 1, base + k, 1, 1);
    }
    if (notch) ctx.fillRect(cx, base + rows, 1, 1);
    // Trim ring, opened where the notch joins the board.
    ctx.fillStyle = trim;
    run(x + 2, right - 2, y);
    run(x + 2, notch ? cx - mouth : right - 2, bottom);
    if (notch) run(cx + mouth, right - 2, bottom);
    ctx.fillRect(x, y + 2, 1, h - 4);
    ctx.fillRect(right, y + 2, 1, h - 4);
    ctx.fillRect(x + 1, y + 1, 1, 1);
    ctx.fillRect(right - 1, y + 1, 1, 1);
    ctx.fillRect(x + 1, bottom - 1, 1, 1);
    ctx.fillRect(right - 1, bottom - 1, 1, 1);
    for (let k = 0; k < rows; k++) {
        const half = PLATE_NOTCH_HALVES[k];
        ctx.fillRect(cx - half, base + k, 1, 1);
        if (half > 0) ctx.fillRect(cx + half, base + k, 1, 1);
    }
    // Fill, running on down into the notch.
    ctx.fillStyle = fill;
    ctx.fillRect(x + 2, y + 1, w - 4, h - 2);
    ctx.fillRect(x + 1, y + 2, 1, h - 4);
    ctx.fillRect(right - 1, y + 2, 1, h - 4);
    if (notch) run(cx - mouth + 1, cx + mouth - 1, bottom);
    for (let k = 0; k < rows; k++) run(cx - PLATE_NOTCH_HALVES[k] + 1, cx + PLATE_NOTCH_HALVES[k] - 1, base + k);
    if (!puffs) return;
    const side = lean < 0 ? -1 : 1;
    for (const [style, runs] of [[outline, PUFF_RUNS.outline], [trim, PUFF_RUNS.trim], [fill, PUFF_RUNS.fill]]) {
        ctx.fillStyle = style;
        for (const [row, from, to] of runs) {
            const a = cx + from * side;
            const b = cx + to * side;
            run(Math.min(a, b), Math.max(a, b), base + row);
        }
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
    const stamp = canvas.getContext('2d', { willReadFrequently: true });
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
