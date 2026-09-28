// 6.1 — the pixel effect kit: the rendering half of the C5 shape grammar
// (`shared/EventShapes.js`) for transient moments, under contract C4 of
// agents/plans/claudeville-opus55-aesthetic-plan.md.
//
// Shape says the family, colour says the outcome, timing says the weight:
//   arrive / depart  -> column        magic violet
//   dispatch / merge -> comet         magic violet; returns in stone
//   verified success -> 8-spoke crown gold (verified only)
//   failure          -> broken bracket red with a dark outline
//   peak frame       -> cream, one frame only
//
// Every stamp draws in WORLD space (camera transform applied) on the art-pixel
// grid: one art pixel is one world texel, every origin is snapped to an integer
// texel, and the only primitive is `fillRect`. No arc, roundRect, stroke,
// gradient, blur, or 1/zoom screen scaling. Callers pass the tone; stamps never
// invent colours.
import { EFFECT_COLORS } from '../../config/artPalette.js';
import { applyGradeToRgb } from './GradeEvaluator.js';

export const MAGIC_RAMP = EFFECT_COLORS.magic;
export const PEAK = EFFECT_COLORS.peak;
export const GOLD = EFFECT_COLORS.success;
export const FAILURE = EFFECT_COLORS.failure;
export const FAILURE_OUTLINE = EFFECT_COLORS.failureOutline;
// Neutral return: the stone role plus one step either side, so a returning
// comet can carry the same 3-tone tail as a violet one without borrowing gold.
export const STONE_RAMP = Object.freeze(['#5f574a', EFFECT_COLORS.returnStone, '#e2d8c2']);
// A gold ramp for the crown: shadow, the verified-success role, cream-gold tip.
export const GOLD_RAMP = Object.freeze(['#8a5a1c', EFFECT_COLORS.success, '#ffe08a']);
// Dust chips kicked up at the feet: the dirt ramp's lit end, never status —
// the overlay is ungraded, so the darker dirt steps vanish on night stone.
export const DUST_TONES = Object.freeze(['#7f6a4a', '#a38a62', '#cdb88e']);

// ---------------------------------------------------------------------------
// Timing envelope (C4)
// ---------------------------------------------------------------------------

// Stepped follow-through: 4 alpha quanta (1, .66, .33, 0) instead of a fade.
export const ALPHA_QUANTA = Object.freeze([1, 0.66, 0.33, 0]);

export const EFFECT_TIERS = Object.freeze({
    minor: Object.freeze({ maxActiveMs: 400, residue: false }),
    medium: Object.freeze({ maxActiveMs: 1200, residue: true }),
    major: Object.freeze({ maxActiveMs: 2500, residue: true, globalLimit: 1 }),
});

// Declare one moment's envelope. Anticipation 120–250 ms, one cream peak frame
// 60–100 ms, stepped follow-through, optional static residue. The tier bounds
// the active part; out-of-contract values are clamped, not trusted.
export function defineMoment(tier, { anticipation = 160, peak = 80, follow = 480, residue = 0 } = {}) {
    const limits = EFFECT_TIERS[tier] || EFFECT_TIERS.minor;
    const a = clampNumber(anticipation, 0, 250);
    const p = clampNumber(peak, 60, 100);
    const f = Math.max(0, Math.min(Number(follow) || 0, limits.maxActiveMs - a - p));
    return Object.freeze({
        tier: EFFECT_TIERS[tier] ? tier : 'minor',
        anticipation: a,
        peak: p,
        follow: f,
        residue: limits.residue ? clampNumber(residue, 0, 6000) : 0,
        active: a + p + f,
    });
}

// Resolve where a moment is at `age` ms. Reduced motion skips straight to the
// residue frame for the residue duration (nothing at all when there is none).
// `step` is the integer quantum inside the phase so callers can key discrete
// frames; `alpha` is already quantized.
export function momentPhase(age, moment, { reduced = false } = {}) {
    const t = Number(age) || 0;
    if (reduced) {
        if (moment.residue > 0 && t >= 0 && t < moment.residue) {
            return { phase: 'residue', t: t / moment.residue, alpha: 1, step: 0 };
        }
        return DONE;
    }
    if (t < 0) return DONE;
    if (t < moment.anticipation) {
        const u = t / Math.max(1, moment.anticipation);
        return { phase: 'anticipation', t: u, alpha: 1, step: quantStep(u, 3) };
    }
    const afterAnticipation = t - moment.anticipation;
    if (afterAnticipation < moment.peak) {
        return { phase: 'peak', t: afterAnticipation / moment.peak, alpha: 1, step: 0 };
    }
    const afterPeak = afterAnticipation - moment.peak;
    if (afterPeak < moment.follow) {
        const u = afterPeak / Math.max(1, moment.follow);
        const step = quantStep(u, 3);
        return { phase: 'follow', t: u, alpha: ALPHA_QUANTA[step], step };
    }
    const afterFollow = afterPeak - moment.follow;
    if (afterFollow < moment.residue) {
        return { phase: 'residue', t: afterFollow / moment.residue, alpha: 1, step: 0 };
    }
    return DONE;
}

const DONE = Object.freeze({ phase: 'done', t: 1, alpha: 0, step: 0 });

// Split [0,1) into `count` equal steps and return the step index.
export function quantStep(t, count) {
    return Math.max(0, Math.min(count - 1, Math.floor((Number(t) || 0) * count)));
}

// Quantize a fraction onto `count` steps (0..1 inclusive endpoints).
export function quantize(t, count) {
    const n = Math.max(1, count);
    return Math.round(Math.max(0, Math.min(1, Number(t) || 0)) * n) / n;
}

// Stepped decay for a long static-band mark (departure sigil and similar):
// holds each alpha quantum for a quarter of `duration`.
export function steppedDecay(age, duration) {
    const u = Math.max(0, Number(age) || 0) / Math.max(1, duration);
    if (u >= 1) return 0;
    return ALPHA_QUANTA[quantStep(u, 3)];
}

// ---------------------------------------------------------------------------
// Moment ledger — one Major globally, success deferral.
// Durations in, clock owned here: callers run on different clocks
// (performance.now vs Date.now) and must never compare them directly.
// ---------------------------------------------------------------------------

const ledger = {
    major: null,
    successHolds: new Map(),
};

function ledgerNow() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

// Claim the single Major slot for `durationMs`. Returns false while another
// Major moment owns it; the same id may re-claim (extend) its own slot.
export function claimMajorMoment(id, durationMs) {
    const now = ledgerNow();
    if (ledger.major && ledger.major.until > now && ledger.major.id !== id) return false;
    ledger.major = { id, until: now + Math.max(0, Number(durationMs) || 0) };
    return true;
}

export function releaseMajorMoment(id) {
    if (ledger.major?.id === id) ledger.major = null;
}

export function majorMomentActive() {
    return Boolean(ledger.major && ledger.major.until > ledgerNow());
}

// A verified failure defers success grammar while it is on screen. The holder
// renews its hold every frame it draws, so a disposed owner lapses on its own.
export function holdSuccessGrammar(ownerKey, durationMs = 250) {
    ledger.successHolds.set(ownerKey, ledgerNow() + Math.max(0, Number(durationMs) || 0));
}

export function releaseSuccessGrammar(ownerKey) {
    ledger.successHolds.delete(ownerKey);
}

export function successGrammarDeferred() {
    const now = ledgerNow();
    for (const [key, until] of ledger.successHolds) {
        if (until > now) return true;
        ledger.successHolds.delete(key);
    }
    return false;
}

// Test and dispose hook: forget every hold and claim.
export function resetMomentLedger() {
    ledger.major = null;
    ledger.successHolds.clear();
}

// ---------------------------------------------------------------------------
// Stamps. All coordinates are world units; one art pixel = 1 world texel.
// ---------------------------------------------------------------------------

export function snap(value) {
    return Math.round(Number(value) || 0);
}

function rect(ctx, x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    ctx.fillRect(x, y, w, h);
}

// A vertical column rising from the ground point (x, y): three nested bands,
// dark outside -> light core, each band a little shorter so the top steps, and
// a checker-dithered cap on the outer band instead of a soft fade.
export function column(ctx, x, y, { height = 40, width = 7, ramp = MAGIC_RAMP, core = null } = {}) {
    const h = Math.max(0, Math.round(height));
    if (h <= 0) return;
    const w = Math.max(3, Math.round(width) | 1);
    const cx = snap(x);
    const base = snap(y);
    const bands = [
        { w, h, color: ramp[0] },
        { w: Math.max(1, w - 2), h: Math.max(0, h - 3), color: ramp[1] },
        { w: Math.max(1, w - 4), h: Math.max(0, h - 6), color: core || ramp[2] },
    ];
    for (let index = 0; index < bands.length; index++) {
        const band = bands[index];
        if (band.h <= 0) continue;
        const left = cx - (band.w >> 1);
        ctx.fillStyle = band.color;
        // Solid body below a 2-texel dithered cap.
        const cap = index === 0 ? Math.min(2, band.h) : 0;
        rect(ctx, left, base - band.h + cap, band.w, band.h - cap);
        for (let row = 0; row < cap; row++) {
            const y0 = base - band.h + row;
            for (let col = (row & 1); col < band.w; col += 2) rect(ctx, left + col, y0, 1, 1);
        }
    }
}

// Dots on an isometric ground ellipse (2:1), `dot`×`dot` texels each.
export function ringDots(ctx, x, y, radius, { count = 8, dot = 2, color = PEAK, phase = 0 } = {}) {
    const r = Math.max(0, Number(radius) || 0);
    const d = Math.max(1, Math.round(dot));
    const half = d >> 1;
    const cx = Number(x) || 0;
    const cy = Number(y) || 0;
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
        const angle = phase + (i / count) * Math.PI * 2;
        rect(ctx, snap(cx + Math.cos(angle) * r) - half, snap(cy + Math.sin(angle) * r * 0.5) - half, d, d);
    }
}

// A comet: a plus-shaped head and a stepped tail trailing opposite `dir`.
// `head: false` draws the tail only (a miniature supplies the head).
export function comet(ctx, x, y, dirX, dirY, { length = 4, ramp = MAGIC_RAMP, head = true, spacing = 2 } = {}) {
    const hx = snap(x);
    const hy = snap(y);
    const mag = Math.hypot(dirX, dirY) || 1;
    const ux = dirX / mag;
    const uy = dirY / mag;
    // Tail first so the head sits on top.
    for (let i = length; i >= 1; i--) {
        const size = i <= Math.ceil(length / 2) ? 2 : 1;
        ctx.fillStyle = i <= 1 ? ramp[2] : (i <= Math.ceil(length / 2) ? ramp[1] : ramp[0]);
        const tx = snap(hx - ux * spacing * (i + 1));
        const ty = snap(hy - uy * spacing * (i + 1));
        rect(ctx, tx - (size >> 1), ty - (size >> 1), size, size);
    }
    if (!head) return;
    ctx.fillStyle = ramp[1];
    rect(ctx, hx - 2, hy - 1, 5, 3);
    rect(ctx, hx - 1, hy - 2, 3, 5);
    ctx.fillStyle = ramp[2];
    rect(ctx, hx - 1, hy - 1, 3, 3);
}

// Eight spokes around (x, y): axis spokes as solid runs, diagonals as 1-texel
// staircases shortened by ~1/sqrt(2) so all eight read the same length, each
// tipped with a lighter 2×2. `inner` leaves a gap around the core.
export function crown(ctx, x, y, { radius = 18, inner = 3, ramp = GOLD_RAMP, tip = null, core = null } = {}) {
    const cx = snap(x);
    const cy = snap(y);
    const r = Math.max(inner + 1, Math.round(radius));
    const diag = Math.max(inner + 1, Math.round(r * 0.72));
    const diagInner = Math.max(1, Math.round(inner * 0.72));
    ctx.fillStyle = ramp[1];
    // Axis spokes (N, S, E, W).
    rect(ctx, cx, cy - r, 1, r - inner);
    rect(ctx, cx, cy + inner + 1, 1, r - inner);
    rect(ctx, cx - r, cy, r - inner, 1);
    rect(ctx, cx + inner + 1, cy, r - inner, 1);
    // Diagonal staircases.
    for (let i = diagInner + 1; i <= diag; i++) {
        rect(ctx, cx + i, cy - i, 1, 1);
        rect(ctx, cx - i, cy - i, 1, 1);
        rect(ctx, cx + i, cy + i, 1, 1);
        rect(ctx, cx - i, cy + i, 1, 1);
    }
    // Tips: 2×2 lighter pixels at every spoke end.
    ctx.fillStyle = tip || ramp[2];
    rect(ctx, cx - 1, cy - r - 1, 2, 2);
    rect(ctx, cx, cy + r, 2, 2);
    rect(ctx, cx - r - 1, cy, 2, 2);
    rect(ctx, cx + r, cy - 1, 2, 2);
    rect(ctx, cx + diag, cy - diag - 1, 2, 2);
    rect(ctx, cx - diag - 1, cy - diag - 1, 2, 2);
    rect(ctx, cx + diag, cy + diag, 2, 2);
    rect(ctx, cx - diag - 1, cy + diag, 2, 2);
    if (core) {
        ctx.fillStyle = core;
        rect(ctx, cx - 1, cy - 2, 3, 5);
        rect(ctx, cx - 2, cy - 1, 5, 3);
    }
}

// A small closed crown for residue: 8 dots on a circle plus a core pixel.
export function crownSeal(ctx, x, y, { radius = 5, ramp = GOLD_RAMP } = {}) {
    const cx = snap(x);
    const cy = snap(y);
    const r = Math.max(2, Math.round(radius));
    const d = Math.max(1, Math.round(r * 0.72));
    ctx.fillStyle = ramp[0];
    rect(ctx, cx - 1, cy - 1, 3, 3);
    ctx.fillStyle = ramp[1];
    rect(ctx, cx, cy - r, 1, 2);
    rect(ctx, cx, cy + r - 1, 1, 2);
    rect(ctx, cx - r, cy, 2, 1);
    rect(ctx, cx + r - 1, cy, 2, 1);
    rect(ctx, cx + d, cy - d, 1, 1);
    rect(ctx, cx - d, cy - d, 1, 1);
    rect(ctx, cx + d, cy + d, 1, 1);
    rect(ctx, cx - d, cy + d, 1, 1);
    ctx.fillStyle = ramp[2];
    rect(ctx, cx, cy, 1, 1);
}

// Outline pass (each rect grown by one texel) then fill pass: a 1-texel dark
// rim that survives any ground without a stroke.
function outlinedRects(ctx, ox, oy, rects, fill, outline) {
    if (outline) {
        ctx.fillStyle = outline;
        for (const [x, y, w, h] of rects) rect(ctx, ox + x - 1, oy + y - 1, w + 2, h + 2);
    }
    ctx.fillStyle = fill;
    for (const [x, y, w, h] of rects) rect(ctx, ox + x, oy + y, w, h);
}

// The incident frame (same family as the Director's `incident-bracket`
// motif): four L-shaped corners framing a (w × h) box centred on (x, y).
// `broken` snaps the top-right corner: its top arm is gone, its side arm is
// short, and the knocked-off piece hangs askew above the gap, so the frame
// reads as cracked open at the top rather than closed. `splitX` pushes the
// left and right corners apart (the halves converge during anticipation).
export function bracket(ctx, x, y, {
    width = 24,
    height = 16,
    broken = true,
    thickness = 2,
    arm = 6,
    color = FAILURE,
    outline = FAILURE_OUTLINE,
    splitX = 0,
} = {}) {
    const w = Math.max(10, Math.round(width));
    const h = Math.max(8, Math.round(height));
    const t = Math.max(1, Math.round(thickness));
    const a = Math.max(t + 2, Math.round(arm));
    const s = Math.round(splitX);
    const left = snap(x) - (w >> 1);
    const top = snap(y) - (h >> 1);
    const rects = [
        // Top-left.
        [-s, 0, a, t], [-s, 0, t, a],
        // Bottom-left.
        [-s, h - t, a, t], [-s, h - a, t, a],
        // Bottom-right.
        [w - a + s, h - t, a, t], [w - t + s, h - a, t, a],
    ];
    if (broken) {
        // Top-right, snapped: a short stub of the side arm stays in place and
        // the broken top arm hangs one step up and out, with a loose chip.
        rects.push([w - t + s, a - 2, t, 2]);
        rects.push([w - a + s + 1, -3, a - 2, t]);
        rects.push([w - a + s - 2, -2, 1, 1]);
    } else {
        rects.push([w - a + s, 0, a, t], [w - t + s, 0, t, a]);
    }
    outlinedRects(ctx, left, top, rects, color, outline);
    return { left: left - s, right: left + w + s, top, bottom: top + h };
}

// A 45° diamond outline of radius r (or filled), one texel wide.
export function diamond(ctx, x, y, radius, { color = EFFECT_COLORS.returnStone, filled = false, fill = null } = {}) {
    const cx = snap(x);
    const cy = snap(y);
    const r = Math.max(1, Math.round(radius));
    if (filled || fill) {
        ctx.fillStyle = fill || color;
        for (let i = 1; i < r; i++) rect(ctx, cx - (r - i) + 1, cy - i, 2 * (r - i) - 1, 1);
        for (let i = 0; i < r; i++) rect(ctx, cx - (r - i) + 1, cy + i, 2 * (r - i) - 1, 1);
    }
    ctx.fillStyle = color;
    for (let i = 0; i <= r; i++) {
        const dx = r - i;
        rect(ctx, cx - dx, cy - i, 1, 1);
        rect(ctx, cx + dx, cy - i, 1, 1);
        rect(ctx, cx - dx, cy + i, 1, 1);
        rect(ctx, cx + dx, cy + i, 1, 1);
    }
}

// Deterministic chips flying out along the ground ellipse and dropping back:
// the kick for dust at the feet or a splash at an impact. `t` in [0,1] is
// quantized to 4 frames so the chips jump like hand-drawn frames.
export function chips(ctx, x, y, t, {
    count = 6,
    seed = 1,
    spread = 12,
    lift = 6,
    tones = DUST_TONES,
    size = 1,
} = {}) {
    const q = quantize(t, 4);
    if (q >= 1) return;
    const cx = Number(x) || 0;
    const cy = Number(y) || 0;
    for (let i = 0; i < count; i++) {
        const h = hash32(seed * 131 + i * 977);
        const angle = ((h % 1000) / 1000) * Math.PI * 2;
        const reach = spread * (0.55 + ((h >>> 10) % 100) / 220);
        const dist = reach * (0.35 + q * 0.65);
        const up = lift * Math.sin(Math.PI * Math.min(1, q + 0.2)) * (0.6 + ((h >>> 17) % 10) / 25);
        const px = snap(cx + Math.cos(angle) * dist);
        const py = snap(cy + Math.sin(angle) * dist * 0.5 - up);
        const s = size + (i % 3 === 0 ? 1 : 0);
        ctx.fillStyle = tones[i % tones.length];
        rect(ctx, px, py, s, i % 2 ? 1 : s);
    }
}

// A short vertical streak (rocket anticipation): `length` texels, lighter head.
export function streak(ctx, x, y, { length = 4, color = GOLD_RAMP[1], head = GOLD_RAMP[2] } = {}) {
    const sx = snap(x);
    const sy = snap(y);
    ctx.fillStyle = color;
    rect(ctx, sx, sy + 1, 1, Math.max(1, length - 1));
    ctx.fillStyle = head;
    rect(ctx, sx, sy, 1, 1);
}

// A tiny ground rune: the static residue of an arrival — a 5-texel diamond on
// the ground ellipse with a lit centre notch.
export function runeNotch(ctx, x, y, { ramp = MAGIC_RAMP } = {}) {
    const cx = snap(x);
    const cy = snap(y);
    ctx.fillStyle = ramp[0];
    rect(ctx, cx - 3, cy, 7, 1);
    rect(ctx, cx - 1, cy - 1, 3, 3);
    ctx.fillStyle = ramp[1];
    rect(ctx, cx - 5, cy, 1, 1);
    rect(ctx, cx + 5, cy, 1, 1);
    rect(ctx, cx, cy - 2, 1, 1);
    rect(ctx, cx, cy + 2, 1, 1);
    ctx.fillStyle = ramp[2];
    rect(ctx, cx, cy, 1, 1);
}

function clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// C2 on the ungraded overlay
// ---------------------------------------------------------------------------

// Albedo marks drawn on the ungraded overlay (chips, crates, cloth) take the
// frame's C2 grade here, so they sit in the world's light instead of floating
// day-bright over a night island. Light tones (flames, lit panes, peaks) are
// emission and must not be passed through. Memoized per frozen grade object.
const _gradeTones = new WeakMap();

export function gradeTone(hex, lightGrade) {
    const text = String(hex || '');
    if (!lightGrade || typeof lightGrade !== 'object' || !/^#[0-9a-f]{6}$/i.test(text)) return text;
    let tones = _gradeTones.get(lightGrade);
    if (!tones) {
        tones = new Map();
        _gradeTones.set(lightGrade, tones);
    }
    let tone = tones.get(text);
    if (tone === undefined) {
        const n = Number.parseInt(text.slice(1), 16);
        const out = applyGradeToRgb([((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255], lightGrade);
        const channel = value => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, '0');
        tone = `#${channel(out[0])}${channel(out[1])}${channel(out[2])}`;
        tones.set(text, tone);
    }
    return tone;
}

// Fill a convex polygon ([[x, y], ...] in world texels) as one snapped
// `fillRect` per texel row, sampling each row at its centre: the pixel-step
// replacement for an AA `fill()` of a wedge, pennant or wing. Uses the
// caller's fillStyle.
export function fillConvex(ctx, points) {
    const n = points?.length || 0;
    if (n < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const y = points[i][1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const top = Math.floor(minY);
    const bottom = Math.ceil(maxY);
    for (let row = top; row < bottom; row++) {
        const sy = row + 0.5;
        let left = Infinity;
        let right = -Infinity;
        for (let i = 0; i < n; i++) {
            const [ax, ay] = points[i];
            const [bx, by] = points[(i + 1) % n];
            if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
                const x = ax + (sy - ay) / (by - ay) * (bx - ax);
                if (x < left) left = x;
                if (x > right) right = x;
            }
        }
        if (right <= left) continue;
        const x0 = Math.round(left);
        rect(ctx, x0, row, Math.round(right) - x0, 1);
    }
}

// A dotted quadratic path on the art grid: `dot`×`dot` texel dots every
// `step` texels of arc length from (x0,y0) through control (cx,cy) to (x1,y1).
// `phase` (texels) marches the dots along the path; `end` adds a 3×3 terminal
// so the direction reads. Replaces dashed AA `quadraticCurveTo` strokes.
export function dottedCurve(ctx, x0, y0, cx, cy, x1, y1, {
    step = 4,
    dot = 1,
    color = EFFECT_COLORS.returnStone,
    phase = 0,
    end = false,
    maxDots = 96,
} = {}) {
    const spacing = Math.max(2, Math.round(step));
    const d = Math.max(1, Math.round(dot));
    const half = d >> 1;
    // Arc length from a fixed 12-segment polyline: plenty for a gentle curve.
    let length = 0;
    let px = x0;
    let py = y0;
    for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        const mt = 1 - t;
        const qx = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
        const qy = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
        length += Math.hypot(qx - px, qy - py);
        px = qx;
        py = qy;
    }
    if (!(length > 0)) return;
    const offset = ((Number(phase) || 0) % spacing + spacing) % spacing;
    const count = Math.min(maxDots, Math.floor((length - offset) / spacing) + 1);
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
        const t = Math.min(1, (offset + i * spacing) / length);
        const mt = 1 - t;
        const qx = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
        const qy = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
        rect(ctx, snap(qx) - half, snap(qy) - half, d, d);
    }
    if (end) rect(ctx, snap(x1) - 1, snap(y1) - 1, 3, 3);
}

// Dots on an elliptical arc in canvas angle convention (0 = east, π/2 = south,
// screen-down): `dot`×`dot` texels spaced about `step` texels apart, sampled at
// even angles. Consecutive dots that snap to the same texel are skipped so a
// translucent arc never double-blends. The pixel-step replacement for an AA
// `ellipse()` stroke or arc gauge; `step` ≤ `dot` reads as a solid pixel arc.
export function ellipseArcDots(ctx, x, y, rx, ry, {
    start = 0,
    end = Math.PI * 2,
    step = 4,
    dot = 2,
    color = PEAK,
    maxDots = 320,
} = {}) {
    const a = Number(rx) || 0;
    const b = Number(ry) || 0;
    if (!(a > 0) || !(b > 0) || !(end > start)) return;
    const d = Math.max(1, Math.round(dot));
    const half = d >> 1;
    const cx = Number(x) || 0;
    const cy = Number(y) || 0;
    // Ramanujan's perimeter, scaled to the swept fraction.
    const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const length = perimeter * (end - start) / (Math.PI * 2);
    const count = Math.min(maxDots, Math.max(2, Math.round(length / Math.max(1, step)) + 1));
    ctx.fillStyle = color;
    let lastX = NaN;
    let lastY = NaN;
    for (let i = 0; i < count; i++) {
        const angle = start + (end - start) * (i / (count - 1));
        const px = snap(cx + Math.cos(angle) * a) - half;
        const py = snap(cy + Math.sin(angle) * b) - half;
        if (px === lastX && py === lastY) continue;
        rect(ctx, px, py, d, d);
        lastX = px;
        lastY = py;
    }
}

// A solid one-texel line on the art grid (DDA, one `fillRect` per texel step,
// `thick` texels tall): the replacement for an AA `lineTo` stroke. Uses the
// caller's fillStyle.
export function pixelLine(ctx, x0, y0, x1, y1, thick = 1) {
    const dx = (Number(x1) || 0) - (Number(x0) || 0);
    const dy = (Number(y1) || 0) - (Number(y0) || 0);
    const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
    const t = Math.max(1, Math.round(thick));
    let lastX = NaN;
    let lastY = NaN;
    for (let s = 0; s <= steps; s++) {
        const px = snap(x0 + dx * s / steps);
        const py = snap(y0 + dy * s / steps);
        if (px === lastX && py === lastY) continue;
        rect(ctx, px, py, 1, t);
        lastX = px;
        lastY = py;
    }
}

function hash32(value) {
    let h = (value | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}
