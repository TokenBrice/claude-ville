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
import { WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { cueNoteCount, cueNoteDue, cueNoteTime } from '../shared/audio/CueScore.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { LABEL_INK, measureLabelText } from './WorldLabelKit.js';

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
// 8.3 — moments peak on the score's notes. A cue gate holds a moment's clock
// on the last frame before its peak until its carrying note is due, and on the
// last follow frame until the cue's last note is due, so the cream frame lands
// on a bell of the cue that carries it. The carrying note is the cue's first
// note the moment can still reach without cutting its anticipation below the
// C4 floor (a peal that started while its moment was still being staged lands
// the peak on its next strike, never ahead of the moment's cue for the eye); a
// note that is due a little before the natural peak pulls the peak in. With no
// admitted score `cueNoteDue` is already true: silence draws on the moment's
// own envelope, and reduced motion never gates (it shows only the residue).
// ---------------------------------------------------------------------------

const CUE_MIN_ANTICIPATION_MS = 120;
const CUE_MAX_PULL_MS = 80;
// A moment never waits longer than this for its note: the visual owns the
// fact, the bell only times it. It covers a dispatch/return batch (closed
// 560 ms after its last fact, at most 1.5 s after its first) plus CueKit's lead
// less the comet's own 650 ms run-up.
export const CUE_MAX_HOLD_MS = 1500;
const CUE_LOG_MAX = 32;
const cueLog = [];

function monotonicNow() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * One moment's cue gate. `kind` is the CueKit kind that carries the moment
 * (`arrival`, `dispatch`, `subagentReturn`, `release`, `pushFailed`); `key` is
 * the score key (the agent id, or null for any score of that kind).
 */
export function createCueGate(kind, key = null) {
    return {
        kind,
        key: key ?? null,
        openedAt: monotonicNow(),
        shift: 0,
        held: 0,
        note: 0,
        noteFixed: false,
        peakOpen: false,
        residueOpen: false,
        logged: false,
    };
}

// The carrying note: the first note of the live score that sounds at or after
// moment time `pullFrom` (moment time t now, a note at `atMs` sounds at
// t + atMs - now). Fixed once found; with no reachable note, the last one.
function carryingNote(gate, t, pullFrom, now) {
    if (gate.noteFixed) return gate.note;
    const count = cueNoteCount(gate.kind, gate.key, now);
    if (!count) return 0;
    for (let i = 0; i < count; i++) {
        const atMs = cueNoteTime(gate.kind, gate.key, i, now);
        if (atMs != null && t + (atMs - now) >= pullFrom) {
            gate.note = i;
            gate.noteFixed = true;
            return i;
        }
    }
    gate.note = count - 1;
    return gate.note;
}

/**
 * The moment age to draw at, with the peak (at `peakAt` ms) gated on its
 * carrying note and the residue (at `residueAt` ms, or null for none) gated on
 * the cue's last note. Idempotent within a frame; call it from both update and
 * draw.
 */
export function cueGatedAge(gate, age, peakAt, residueAt = null, { reduced = false } = {}) {
    const raw = Number(age) || 0;
    if (!gate || reduced) return raw;
    const now = monotonicNow();
    let t = raw - gate.shift;
    if (!gate.peakOpen) {
        const pullFrom = Math.max(CUE_MIN_ANTICIPATION_MS, peakAt - CUE_MAX_PULL_MS);
        if (t >= peakAt) {
            const note = carryingNote(gate, t, pullFrom, now);
            if (gate.held >= CUE_MAX_HOLD_MS || cueNoteDue(gate.kind, gate.key, note, now)) {
                openPeak(gate, now);
            } else {
                gate.held = t - (peakAt - 1) + gate.held;
                gate.shift = raw - (peakAt - 1);
                t = peakAt - 1;
            }
        } else if (t >= pullFrom) {
            // The carrying note is already sounding: land the cream frame on it now.
            const note = carryingNote(gate, t, pullFrom, now);
            const noteAt = gate.noteFixed ? cueNoteTime(gate.kind, gate.key, note, now) : null;
            if (noteAt != null && noteAt <= now && cueNoteDue(gate.kind, gate.key, note, now)) {
                gate.shift = raw - peakAt;
                t = peakAt;
                openPeak(gate, now);
            }
        } else {
            carryingNote(gate, t, pullFrom, now);
        }
    }
    if (gate.peakOpen && !gate.residueOpen && Number.isFinite(residueAt) && t >= residueAt) {
        const last = Math.max(0, cueNoteCount(gate.kind, gate.key, now) - 1);
        if (gate.held >= CUE_MAX_HOLD_MS || cueNoteDue(gate.kind, gate.key, last, now)) {
            gate.residueOpen = true;
        } else {
            gate.held = t - (residueAt - 1) + gate.held;
            gate.shift = raw - (residueAt - 1);
            t = residueAt - 1;
        }
    }
    return t;
}

function openPeak(gate, now) {
    gate.peakOpen = true;
    if (gate.logged) return;
    gate.logged = true;
    cueLog.push({ kind: gate.kind, key: gate.key, note: gate.note, peakAt: now, noteAt: cueNoteTime(gate.kind, gate.key, gate.note, now) });
    if (cueLog.length > CUE_LOG_MAX) cueLog.shift();
}

// Peak frames against their notes (monotonic ms; `noteAt` null = no score).
export function recentCuePeaks() {
    return cueLog.slice();
}

// ---------------------------------------------------------------------------
// V8 — moment staging. The renderer sets the frame's stage (camera, CSS
// viewport, the chrome's reserved rects, the building sprites, the actors)
// once per frame before any moment draws. `resolveMomentAnchor` is then the
// only way a C4 moment picks where it stands: never under chrome or outside
// the safe area, never behind a building footprint sorted in front of it. A
// moment that cannot stand where it happened slides along its building's own
// screen column (an actor's own column when it has no building); when no spot
// in that column is clear it becomes a screen-fixed edge plate.
// ---------------------------------------------------------------------------

// CSS px held clear inside every viewport edge.
export const MOMENT_SAFE_MARGIN = 8;
// World texels a building column reaches above the sprite's first opaque row.
const COLUMN_HEADROOM = 48;
// World texels an actor-only moment may rise above the feet to clear a roof.
const ACTOR_COLUMN_LIFT = 112;
const PEAK_LOG_MAX = 96;
const DEFAULT_EXTENT = Object.freeze({ left: -12, top: -40, right: 12, bottom: 8 });
const EMPTY = Object.freeze([]);

const stage = {
    camera: null,
    viewport: null,
    reserved: EMPTY,
    occluders: EMPTY,
    // T3 plaque boards (world rects) the label pass painted last frame; they
    // paint over every moment, so a moment treats them as solid.
    plaques: EMPTY,
    actors: null,
    plates: [],
    frame: 0,
};
const peakLog = [];
let occluderSource = null;
let occluderList = EMPTY;
let rowScratch = new Uint8Array(512);

/**
 * Set the frame's stage. `camera` needs `worldToScreen` and `zoom`;
 * `viewport` is the CSS-px world canvas; `reserved` the V8 reserved rects in
 * the same space; `buildings` the building renderer (`enumerateDrawables`,
 * `assets`, and `plaqueWorldRects`, the plaque boards its last label pass
 * painted); `actors` a Map of agent id → sprite.
 */
export function setMomentStage({ camera = null, viewport = null, reserved = null, buildings = null, actors = null } = {}) {
    stage.camera = typeof camera?.worldToScreen === 'function' && camera.zoom > 0 ? camera : null;
    stage.viewport = viewport?.width > 0 && viewport?.height > 0 ? viewport : null;
    stage.reserved = Array.isArray(reserved) ? reserved : EMPTY;
    stage.occluders = buildingOccluders(buildings);
    stage.plaques = Array.isArray(buildings?.plaqueWorldRects) ? buildings.plaqueWorldRects : EMPTY;
    stage.actors = actors || null;
    stage.plates.length = 0;
    stage.frame++;
}

export function clearMomentStage() {
    stage.camera = null;
    stage.viewport = null;
    stage.reserved = EMPTY;
    stage.occluders = EMPTY;
    stage.plaques = EMPTY;
    stage.actors = null;
    stage.plates.length = 0;
    occluderSource = null;
    occluderList = EMPTY;
}

// Front and whole building sprites as world-space alpha masks, rebuilt only
// when the building renderer rebuilds its drawables.
function buildingOccluders(buildings) {
    const drawables = buildings?.enumerateDrawables?.();
    const assets = buildings?.assets;
    if (!Array.isArray(drawables) || !assets) return EMPTY;
    if (drawables === occluderSource) return occluderList;
    const list = [];
    for (const d of drawables) {
        const id = d?.entry?.id;
        const dims = id ? assets.getDims?.(id) : null;
        const mask = id ? assets.getMask?.(id) : null;
        if (!dims || !mask) continue;
        const [ax, ay] = assets.getAnchor?.(id) || [dims.w / 2, dims.h];
        const first = mask.indexOf(1);
        list.push({
            type: d.building?.type || null,
            front: d.kind !== 'building-back',
            left: Math.round(d.wx - ax),
            top: Math.round(d.wy - ay),
            w: dims.w,
            h: dims.h,
            rowStart: d.kind === 'building-front' ? d.horizonY : 0,
            rowEnd: d.kind === 'building-back' ? d.horizonY : dims.h,
            firstRow: first >= 0 ? Math.floor(first / dims.w) : 0,
            ground: d.wy,
            sortY: d.sortY,
            mask,
        });
    }
    occluderSource = drawables;
    occluderList = list;
    return list;
}

// A building's own screen column in world texels: its sprite's x-span, the
// first opaque row, the ground, and its front depth.
function buildingColumn(building) {
    const type = typeof building === 'string' ? building : building?.type;
    if (!type) return null;
    let column = null;
    for (const occ of stage.occluders) {
        if (occ.type !== type) continue;
        if (!column) {
            column = { type, left: occ.left, right: occ.left + occ.w, top: occ.top + occ.firstRow, ground: occ.ground, sortY: occ.sortY };
        }
        if (occ.front) column.sortY = occ.sortY;
    }
    return column;
}

function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// CSS px a moment keeps clear around a plaque board.
const PLAQUE_CLEAR_PX = 2;

function padRect(rect, pad) {
    return { left: rect.left - pad, top: rect.top - pad, right: rect.right + pad, bottom: rect.bottom + pad };
}

// World rect → CSS-px screen rect under the staged camera.
function toScreenRect(rect) {
    const a = stage.camera.worldToScreen(rect.left, rect.top);
    const b = stage.camera.worldToScreen(rect.right, rect.bottom);
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}

/**
 * Whether a world rect is clear for a moment: inside the safe area, off every
 * reserved rect and T3 plaque board, and on no opaque pixel of a building
 * sorted in front of `depthY`. True when no stage is set (headless callers
 * draw where asked).
 */
export function momentRectClear(rect, { depthY = rect?.bottom ?? 0 } = {}) {
    if (!rect || !stage.camera || !stage.viewport) return true;
    const screen = toScreenRect(rect);
    const m = MOMENT_SAFE_MARGIN;
    if (screen.left < m || screen.top < m || screen.right > stage.viewport.width - m
        || screen.bottom > stage.viewport.height - m) return false;
    for (const chrome of stage.reserved) if (rectsOverlap(screen, chrome)) return false;
    const pad = PLAQUE_CLEAR_PX / stage.camera.zoom;
    for (const plaque of stage.plaques) if (rectsOverlap(rect, padRect(plaque, pad))) return false;
    const x0 = Math.floor(rect.left);
    const x1 = Math.ceil(rect.right) - 1;
    const y0 = Math.floor(rect.top);
    const y1 = Math.ceil(rect.bottom) - 1;
    for (const occ of stage.occluders) {
        if (!occ.front || !(occ.sortY > depthY)) continue;
        if (occupiedRows(occ, x0, x1, y0, y1, null, y0)) return false;
    }
    return true;
}

// Mark (in `rows`, indexed from `base`) every world row in [y0, y1] where the
// occluder has an opaque pixel inside columns [x0, x1]; with no array, return
// on the first such row.
function occupiedRows(occ, x0, x1, y0, y1, rows, base) {
    const lx0 = Math.max(0, x0 - occ.left);
    const lx1 = Math.min(occ.w - 1, x1 - occ.left);
    if (lx0 > lx1) return false;
    const ly0 = Math.max(occ.rowStart, y0 - occ.top);
    const ly1 = Math.min(occ.rowEnd - 1, y1 - occ.top);
    let any = false;
    for (let ly = ly0; ly <= ly1; ly++) {
        const row = ly * occ.w;
        for (let lx = lx0; lx <= lx1; lx++) {
            if (occ.mask[row + lx] !== 1) continue;
            if (!rows) return true;
            rows[occ.top + ly - base] = 1;
            any = true;
            break;
        }
    }
    return any;
}

/**
 * V8 — where a C4 moment stands this frame.
 *
 * `worldPoint` is the moment's own point (the feet, the slip, the crown's
 * seat); `extent` its largest frame as world-texel offsets from that point
 * ({ left, top, right, bottom }). `building` (a type or building) names the
 * place whose screen column the moment may slide along; `actorId` names the
 * agent (a column above its feet when there is no building, and the far end
 * of the residue thread). `depthY` is the moment's depth (default: the
 * building's front sort, else the point). `id`/`kind`/`tier`/`phase` feed the
 * peak log (`recentMomentPeaks`).
 *
 * Returns `{ x, y, dy, mode, side, rect, screen }`: draw at (x, y) in `place`
 * or `column` mode; in `edge` mode draw nothing in the world and queue an
 * edge plate (`queueMomentEdgePlate`) on `side`.
 */
export function resolveMomentAnchor(worldPoint, {
    building = null,
    actorId = null,
    extent = null,
    depthY = null,
    id = null,
    kind = null,
    tier = 'medium',
    phase = null,
} = {}) {
    const x = Number(worldPoint?.x) || 0;
    const y = Number(worldPoint?.y) || 0;
    const box = extent || DEFAULT_EXTENT;
    const anchor = { x, y, dy: 0, mode: 'place', side: null, rect: null, screen: null, actorId, id, kind, tier, depthY: null };
    if (!stage.camera || !stage.viewport) return anchor;
    const column = building ? buildingColumn(building) : null;
    const depth = Number.isFinite(depthY) ? depthY : column ? column.sortY : y;
    anchor.depthY = depth;
    const natural = { left: x + box.left, top: y + box.top, right: x + box.right, bottom: y + box.bottom };
    anchor.rect = natural;
    anchor.screen = toScreenRect(natural);
    if (!momentRectClear(natural, { depthY: depth })) {
        const dy = columnOffset(natural, depth, column);
        const moved = dy == null ? null : { ...natural, top: natural.top + dy, bottom: natural.bottom + dy };
        if (moved && momentRectClear(moved, { depthY: depth })) {
            anchor.mode = 'column';
            anchor.dy = dy;
            anchor.y = y + dy;
            anchor.rect = moved;
            anchor.screen = toScreenRect(moved);
        } else {
            anchor.mode = 'edge';
            anchor.side = edgeSide(anchor.screen);
        }
    }
    if (phase === 'peak' && anchor.mode !== 'edge') logPeak(anchor, anchor.screen);
    return anchor;
}

// The nearest vertical offset (world texels) at which `rect` is clear inside
// its column (the building's, else the actor's above its feet), or null. Rows
// are resolved once each: off the safe band, under chrome crossing the
// column, or on a front-sorted building's opaque pixels.
function columnOffset(rect, depth, column) {
    const viewport = stage.viewport;
    const screen = toScreenRect(rect);
    const m = MOMENT_SAFE_MARGIN;
    // The column is vertical: a moment beyond the side edges cannot slide in.
    if (screen.left < m || screen.right > viewport.width - m) return null;
    const height = rect.bottom - rect.top;
    const minTop = column ? Math.min(rect.top, column.top - COLUMN_HEADROOM) : rect.top - ACTOR_COLUMN_LIFT;
    const maxBottom = column ? Math.max(rect.bottom, column.ground) : rect.bottom;
    const base = Math.floor(minTop);
    const span = Math.ceil(maxBottom) - base;
    if (span <= 0) return null;
    if (rowScratch.length < span) rowScratch = new Uint8Array(span * 2);
    const rows = rowScratch;
    rows.fill(0, 0, span);
    const zoom = stage.camera.zoom;
    const offsetY = stage.camera.worldToScreen(0, 0).y;
    const safeTop = m;
    const safeBottom = viewport.height - m;
    for (let i = 0; i < span; i++) {
        const sy0 = (base + i) * zoom + offsetY;
        const sy1 = sy0 + zoom;
        if (sy0 < safeTop - 0.001 || sy1 > safeBottom + 0.001) rows[i] = 1;
    }
    for (const chrome of stage.reserved) {
        if (!(chrome.left < screen.right && chrome.right > screen.left)) continue;
        const r0 = Math.floor((chrome.top - offsetY) / zoom) - base;
        const r1 = Math.ceil((chrome.bottom - offsetY) / zoom) - base;
        for (let i = Math.max(0, r0); i < Math.min(span, r1); i++) rows[i] = 1;
    }
    // Plaque boards crossing the column block their rows at every depth.
    const pad = PLAQUE_CLEAR_PX / zoom;
    for (const plaque of stage.plaques) {
        if (!(plaque.left - pad < rect.right && plaque.right + pad > rect.left)) continue;
        const r0 = Math.floor(plaque.top - pad) - base;
        const r1 = Math.ceil(plaque.bottom + pad) - base;
        for (let i = Math.max(0, r0); i < Math.min(span, r1); i++) rows[i] = 1;
    }
    const x0 = Math.floor(rect.left);
    const x1 = Math.ceil(rect.right) - 1;
    for (const occ of stage.occluders) {
        if (!occ.front || !(occ.sortY > depth)) continue;
        occupiedRows(occ, x0, x1, base, base + span - 1, rows, base);
    }
    // Nearest clear window of `need` rows to the natural top (upward first on
    // a tie): a running count of blocked rows makes each window O(1).
    const need = Math.ceil(height);
    const naturalTop = Math.floor(rect.top) - base;
    const maxStart = span - need;
    if (maxStart < 0) return null;
    const blockedBefore = new Uint16Array(span + 1);
    for (let i = 0; i < span; i++) blockedBefore[i + 1] = blockedBefore[i] + rows[i];
    const clearAt = start => start >= 0 && start <= maxStart
        && blockedBefore[start + need] - blockedBefore[start] === 0;
    for (let d = 1; d <= span; d++) {
        if (clearAt(naturalTop - d)) return -d;
        if (clearAt(naturalTop + d)) return d;
    }
    return null;
}

function edgeSide(screen) {
    const viewport = stage.viewport;
    const cx = (screen.left + screen.right) / 2;
    const cy = (screen.top + screen.bottom) / 2;
    const over = {
        top: -cy,
        bottom: cy - viewport.height,
        left: -cx,
        right: cx - viewport.width,
    };
    let side = null;
    let best = 0;
    for (const key of ['top', 'bottom', 'left', 'right']) {
        if (over[key] > best) { best = over[key]; side = key; }
    }
    if (side) return side;
    // In view but nowhere clear (under chrome, or buried behind a building):
    // the nearest edge.
    const near = {
        top: cy,
        bottom: viewport.height - cy,
        left: cx,
        right: viewport.width - cx,
    };
    return Object.keys(near).reduce((a, b) => (near[b] < near[a] ? b : a));
}

function logPeak(anchor, rect) {
    const last = peakLog[peakLog.length - 1];
    if (last && last.frame === stage.frame && last.id === anchor.id) return;
    peakLog.push({
        id: anchor.id,
        kind: anchor.kind,
        tier: anchor.tier,
        mode: anchor.mode,
        side: anchor.side,
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        world: anchor.rect ? { ...anchor.rect } : null,
        depthY: anchor.depthY ?? null,
        viewport: { width: stage.viewport.width, height: stage.viewport.height },
        zoom: stage.camera.zoom,
        at: monotonicNow(),
        frame: stage.frame,
    });
    if (peakLog.length > PEAK_LOG_MAX) peakLog.shift();
}

// Every peak frame staged recently (screen rects in CSS px), for QA probes.
export function recentMomentPeaks() {
    return peakLog.slice();
}

// ---------------------------------------------------------------------------
// 10.2 — the verified-success cream peak frame at the mark gain. The overlay
// cannot present HDR, so on the resident path the renderer arms the overlay
// context for the frame (`armPeakMarks`) and a verified-success moment's one
// peak frame routes its cream texels through `peakMarkSink`: each run is
// cleared from the overlay (what the overlay drew there before goes, as the
// cream covered it; what it draws later stays on top) and kept as a
// backing-px rect that the GPU mark pass draws as a role-2 record once the
// overlay is drawn (`takePeakMarks`, WorldFrameRenderer). Only whole texels
// on whole backing pixels qualify — an integer device scale and offset, full
// alpha, source-over — so the GPU pixels are the overlay's exactly; anything
// else, the Canvas renderer, follow frames, residues and every other
// moment's cream draw on the overlay as before.
// ---------------------------------------------------------------------------

const peakMarks = { ctx: null, rects: [] };

function whole(value) {
    return Math.abs(value - Math.round(value)) < 1e-6;
}

/** Arm `ctx` (the overlay) for this frame's peak marks, or disarm with null. */
export function armPeakMarks(ctx = null) {
    peakMarks.ctx = ctx;
    peakMarks.rects.length = 0;
}

/** This frame's peak-mark rects in backing px (`{ left, top, width, height }`), in draw order. */
export function takePeakMarks() {
    return peakMarks.rects;
}

/**
 * Where a verified-success peak frame's cream texels go on `ctx`: a
 * `fill(x, y, width, height)` in the context's user space that hands each
 * whole-texel run to the GPU and clears it from the overlay (a run off the
 * texel grid is filled as usual, in the caller's fillStyle), or null when
 * the context is not armed or its transform does not put whole texels on
 * whole backing pixels — draw as usual then.
 */
export function peakMarkSink(ctx) {
    if (!ctx || ctx !== peakMarks.ctx) return null;
    if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== 'source-over') return null;
    const t = ctx.getTransform();
    if (t.b !== 0 || t.c !== 0 || !(t.a > 0) || !(t.d > 0)) return null;
    if (!whole(t.a) || !whole(t.d) || !whole(t.e) || !whole(t.f)) return null;
    const a = Math.round(t.a);
    const d = Math.round(t.d);
    const e = Math.round(t.e);
    const f = Math.round(t.f);
    return (x, y, width, height) => {
        if (!whole(x) || !whole(y) || !whole(width) || !whole(height)) {
            ctx.fillRect(x, y, width, height);
            return;
        }
        peakMarks.rects.push({ left: a * Math.round(x) + e, top: d * Math.round(y) + f, width: a * Math.round(width), height: d * Math.round(height) });
        ctx.clearRect(x, y, width, height);
    };
}

// ---------------------------------------------------------------------------
// Edge plates and the residue thread.
// ---------------------------------------------------------------------------

const EDGE_PLATE_H = 17;
const EDGE_WORD_PAD = 4;
const EDGE_ARROW_CELL = 11;
const EDGE_ARROW = Object.freeze(['..###..', '..###..', '..###..', '#######', '.#####.', '..###..', '...#...']);
// The plate row under the T1 edge plates, and the band held above the
// lower-third caption (AttentionPlates keeps the same clearance).
const EDGE_TOP_ROW = MOMENT_SAFE_MARGIN + EDGE_PLATE_H + 4;
const EDGE_CAPTION_CLEAR = 100;
const EDGE_STACK_STEP = EDGE_PLATE_H + 4;

/**
 * Queue a screen-fixed edge plate for a moment whose anchor resolved to
 * `edge`: the family colour cell with a stepped arrow pointing past the frame
 * and one word; `peak` fills the cell cream for the moment's one peak frame.
 * `peakMark` (a verified-success moment) hands that cream cell to the GPU as
 * a role-2 mark (`peakMarkSink`). Drawn by `drawMomentEdgePlates` after the
 * world pass.
 */
export function queueMomentEdgePlate(anchor, { word = '', color = PEAK, peak = false, peakMark = false, ctx = null } = {}) {
    if (!anchor || anchor.mode !== 'edge' || !stage.viewport) return null;
    if (stage.plates.some(plate => plate.id != null && plate.id === anchor.id)) return null;
    let textWidth = String(word).length * 8;
    if (ctx) {
        ctx.save();
        ctx.font = WORLD_DISPLAY_FONT_8;
        textWidth = measureLabelText(ctx, String(word));
        ctx.restore();
    }
    const width = 2 + EDGE_WORD_PAD * 2 + EDGE_ARROW_CELL + Math.ceil(textWidth);
    const rect = edgePlateRect(anchor.side, anchor.screen, width);
    const plate = { id: anchor.id, side: anchor.side, word: String(word), color, peak: Boolean(peak), peakMark: Boolean(peak && peakMark), rect };
    stage.plates.push(plate);
    if (peak) logPeak(anchor, rect);
    return plate;
}

function edgePlateRect(side, screen, width) {
    const W = stage.viewport.width;
    const H = stage.viewport.height;
    const m = MOMENT_SAFE_MARGIN;
    const cx = screen ? (screen.left + screen.right) / 2 : W / 2;
    const cy = screen ? (screen.top + screen.bottom) / 2 : H / 2;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
    let rect;
    if (side === 'top' || side === 'bottom') {
        const left = clamp(Math.round(cx - width / 2), m, W - m - width);
        const top = side === 'top' ? EDGE_TOP_ROW : H - EDGE_CAPTION_CLEAR - EDGE_PLATE_H;
        rect = { left, top, right: left + width, bottom: top + EDGE_PLATE_H };
    } else {
        const top = clamp(Math.round(cy - EDGE_PLATE_H / 2), EDGE_TOP_ROW + EDGE_STACK_STEP, H - EDGE_CAPTION_CLEAR - EDGE_PLATE_H * 2 - 4);
        const left = side === 'left' ? m : W - m - width;
        rect = { left, top, right: left + width, bottom: top + EDGE_PLATE_H };
    }
    // Off the chrome, off the plaque boards, and off every plate already
    // queued this frame.
    const plaques = stage.camera
        ? stage.plaques.map(plaque => padRect(toScreenRect(plaque), PLAQUE_CLEAR_PX))
        : EMPTY;
    for (let guard = 0; guard < 8; guard++) {
        const hit = stage.reserved.find(chrome => rectsOverlap(rect, chrome))
            || plaques.find(plaque => rectsOverlap(rect, plaque))
            || stage.plates.find(plate => rectsOverlap(rect, plate.rect))?.rect;
        if (!hit) break;
        const down = side !== 'bottom' && (hit.top + hit.bottom) / 2 < H / 2;
        const top = down ? hit.bottom + 4 : hit.top - 4 - EDGE_PLATE_H;
        rect = { ...rect, top, bottom: top + EDGE_PLATE_H };
    }
    return rect;
}

/** Draw this frame's moment edge plates. `ctx` in CSS-pixel screen space. */
export function drawMomentEdgePlates(ctx) {
    if (!ctx || !stage.plates.length) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = WORLD_DISPLAY_FONT_8;
    for (const plate of stage.plates) {
        const { rect } = plate;
        const width = rect.right - rect.left;
        ctx.fillStyle = LABEL_INK.plateOutline;
        ctx.fillRect(rect.left, rect.top, width, EDGE_PLATE_H);
        ctx.fillStyle = plate.peak ? PEAK : plate.color;
        const sink = plate.peakMark ? peakMarkSink(ctx) : null;
        if (sink) sink(rect.left + 1, rect.top + 1, width - 2, EDGE_PLATE_H - 2);
        else ctx.fillRect(rect.left + 1, rect.top + 1, width - 2, EDGE_PLATE_H - 2);
        const x0 = rect.left + 1 + EDGE_WORD_PAD;
        const y0 = rect.top + 5;
        const size = EDGE_ARROW.length;
        ctx.fillStyle = LABEL_INK.plate;
        for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
                const cell = plate.side === 'bottom' ? EDGE_ARROW[row][col]
                    : plate.side === 'top' ? EDGE_ARROW[size - 1 - row][col]
                        : plate.side === 'right' ? EDGE_ARROW[col][row]
                            : EDGE_ARROW[size - 1 - col][row];
                if (cell === '#') ctx.fillRect(x0 + col, y0 + row, 1, 1);
            }
        }
        ctx.fillText(plate.word, x0 + EDGE_ARROW_CELL, rect.top + 13);
    }
    ctx.restore();
}

/**
 * The residue thread (V8): when the actor is not the place and both stand on
 * screen, one dotted curve in the family colour from the actor's head to the
 * moment. Draw it in the residue phase only. World space.
 */
export function drawMomentThread(ctx, anchor, { color = PEAK, targetLift = 0 } = {}) {
    if (!ctx || !anchor || anchor.mode === 'edge' || anchor.actorId == null) return false;
    if (!stage.camera || !stage.viewport || !stage.actors?.get) return false;
    const sprite = stage.actors.get(anchor.actorId);
    if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return false;
    const ax = sprite.x;
    const ay = sprite.y - 28;
    const bx = anchor.x;
    const by = anchor.y - targetLift;
    if (Math.hypot(bx - ax, by - ay) < 24) return false;
    const onScreen = (px, py) => {
        const p = stage.camera.worldToScreen(px, py);
        return p.x >= MOMENT_SAFE_MARGIN && p.y >= MOMENT_SAFE_MARGIN
            && p.x <= stage.viewport.width - MOMENT_SAFE_MARGIN && p.y <= stage.viewport.height - MOMENT_SAFE_MARGIN
            && !stage.reserved.some(chrome => p.x >= chrome.left && p.x <= chrome.right && p.y >= chrome.top && p.y <= chrome.bottom);
    };
    if (!onScreen(ax, sprite.y) || !onScreen(bx, by)) return false;
    const lift = Math.min(40, Math.abs(bx - ax) * 0.25 + 12);
    // Legible at every zoom on the pixel grammar: each dot is at least 2 CSS
    // px (whole texels), spaced four dots apart, over a one-dot ink shadow so
    // it reads on grass, cobble and water alike.
    const dot = Math.max(1, Math.ceil(2 / stage.camera.zoom));
    const step = dot * 4;
    const cy = Math.min(ay, by) - lift;
    dottedCurve(ctx, ax, ay + dot, (ax + bx) / 2, cy + dot, bx, by + dot, { step, dot, color: LABEL_INK.plateOutline, end: true });
    dottedCurve(ctx, ax, ay, (ax + bx) / 2, cy, bx, by, { step, dot, color, end: true });
    return true;
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

// Eight 2-texel spokes around the texel corner (x, y), lit on the side facing
// the upper-left key (the N/S spokes' west column, the W/E spokes' north row,
// the NE/SW diagonals' west texel), each ending in a 4×4 jewel (corners cut,
// a cream glint at its upper-left, its lower-right edge one stop down).
// `core` fills a 6×6 octagon at the centre (its upper-left half lit, the
// middle 2×2 in the `core` tone); `inner` > 0 opens a gap round the centre
// instead (the spokes opening outward). `outline` rims the figure with a
// 1-texel ink (every empty texel touching it) so the gold reads over timber,
// slate or sail alike. `fade` < 1 drops texels on a world-locked 4×4 Bayer
// order (ink included), so the figure dissolves in whole texels, never
// translucent. `peakMark` (the verified-success peak frame, 10.2) hands its
// cream texels to `peakMarkSink`. The figure is laid into a texel mask first
// and filled once per texel.
const CROWN_EMPTY = 0;
const CROWN_INK = 1;
const CROWN_SHADE = 2;
const CROWN_BODY = 3;
const CROWN_LIT = 4;
const CROWN_JEWEL = 5;
const CROWN_GLINT = 6;
const CROWN_CORE = 7;
const CROWN_BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
// The farthest texel from the centre corner: a jewel overhangs its spoke by
// two texels, then one texel of ink.
export const CROWN_OVERHANG = 3;
let crownMask = new Uint8Array(4096);

export function crown(ctx, x, y, { radius = 12, inner = 0, ramp = GOLD_RAMP, jewel = null, core = null, outline = null, fade = 1, peakMark = false } = {}) {
    const cx = snap(x);
    const cy = snap(y);
    const r = Math.max(inner + 3, Math.round(radius));
    const d = Math.max(2, Math.round(r * 0.72));
    const dInner = Math.round(inner * 0.72);
    // Mask bounds: the overhang plus one texel of margin (the ink scan never
    // leaves the mask).
    const reach = r + CROWN_OVERHANG + 1;
    const left = cx - reach;
    const top = cy - reach;
    const w = reach * 2;
    const h = reach * 2;
    if (crownMask.length < w * h) crownMask = new Uint8Array(w * h * 2);
    const mask = crownMask;
    mask.fill(CROWN_EMPTY, 0, w * h);
    // Texel (i, j) relative to the centre corner: i, j ∈ {-1, 0} is the
    // middle 2×2.
    const put = (i, j, cls) => {
        mask[(cy + j - top) * w + (cx + i - left)] = cls;
    };
    for (let k = inner; k < r; k++) {
        // Axis spokes: N and S (west column lit), W and E (north row lit).
        for (const j of [-1 - k, k]) {
            put(-1, j, CROWN_LIT);
            put(0, j, CROWN_BODY);
        }
        for (const i of [-1 - k, k]) {
            put(i, -1, CROWN_LIT);
            put(i, 0, CROWN_BODY);
        }
    }
    for (let k = dInner; k < d; k++) {
        // Diagonal staircases, two texels a row.
        put(k, -1 - k, CROWN_LIT);
        put(k + 1, -1 - k, CROWN_BODY);
        put(-2 - k, k, CROWN_LIT);
        put(-1 - k, k, CROWN_BODY);
        put(k, k, CROWN_BODY);
        put(k + 1, k, CROWN_SHADE);
        put(-1 - k, -1 - k, CROWN_BODY);
        put(-2 - k, -1 - k, CROWN_BODY);
    }
    if (core) {
        for (let j = -3; j <= 2; j++) {
            for (let i = -3; i <= 2; i++) {
                const px = i + 0.5;
                const py = j + 0.5;
                if (Math.abs(px) + Math.abs(py) > 4) continue;
                put(i, j, px + py < 0 ? CROWN_LIT : CROWN_BODY);
            }
        }
        for (let j = -1; j <= 0; j++) for (let i = -1; i <= 0; i++) put(i, j, CROWN_CORE);
    }
    // Jewels: 4×4, corners cut, top-left corner (i0, j0).
    const gem = (i0, j0) => {
        for (let b = 0; b < 4; b++) {
            for (let a = 0; a < 4; a++) {
                if ((a === 0 || a === 3) && (b === 0 || b === 3)) continue;
                const edge = a === 3 || b === 3;
                put(i0 + a, j0 + b, a === 1 && b === 1 ? CROWN_GLINT : edge ? CROWN_BODY : CROWN_JEWEL);
            }
        }
    };
    gem(-2, -r - 2);
    gem(-2, r - 2);
    gem(-r - 2, -2);
    gem(r - 2, -2);
    gem(d - 2, -d - 2);
    gem(-d - 2, -d - 2);
    gem(d - 2, d - 2);
    gem(-d - 2, d - 2);
    if (outline) {
        // Ink every empty texel with a lit 8-neighbour.
        for (let row = 1; row < h - 1; row++) {
            for (let col = 1; col < w - 1; col++) {
                const at = row * w + col;
                if (mask[at] !== CROWN_EMPTY) continue;
                if (mask[at - w - 1] > CROWN_INK || mask[at - w] > CROWN_INK || mask[at - w + 1] > CROWN_INK
                    || mask[at - 1] > CROWN_INK || mask[at + 1] > CROWN_INK
                    || mask[at + w - 1] > CROWN_INK || mask[at + w] > CROWN_INK || mask[at + w + 1] > CROWN_INK) {
                    mask[at] = CROWN_INK;
                }
            }
        }
    }
    if (fade < 1) {
        const keep = Math.round(Math.max(0, fade) * 16);
        for (let row = 0; row < h; row++) {
            const wy = (top + row) & 3;
            for (let col = 0; col < w; col++) {
                if (CROWN_BAYER4[(wy << 2) | ((left + col) & 3)] >= keep) mask[row * w + col] = CROWN_EMPTY;
            }
        }
    }
    const tones = [null, outline, ramp[0], ramp[1], ramp[2], jewel || ramp[2], PEAK, core];
    const sink = peakMark ? peakMarkSink(ctx) : null;
    for (let cls = CROWN_INK; cls <= CROWN_CORE; cls++) {
        if (!tones[cls]) continue;
        ctx.fillStyle = tones[cls];
        const fill = sink && tones[cls] === PEAK ? sink : null;
        for (let row = 0; row < h; row++) {
            const base = row * w;
            for (let col = 0; col < w; col++) {
                if (mask[base + col] !== cls) continue;
                let end = col + 1;
                while (end < w && mask[base + end] === cls) end++;
                if (fill) fill(left + col, top + row, end - col, 1);
                else ctx.fillRect(left + col, top + row, end - col, 1);
                col = end;
            }
        }
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

// 3.8 — the V wake a moving hull throws, as two arms on the art grid
// trailing from the bow (x, y) opposite the heading (dirX, dirY, world px).
// The arms open ±`halfAngle` in ground space (the Kelvin wedge, ~19.5°) and
// are projected back to the 2:1 iso plane. The first `hold` px (bow to
// stern, mostly under the hull) stay fresh; past them each arm ages out in
// three stepped courses: the crest colour `thick` rows deep, then the foam
// colour `thick` rows deep, then one foam row at ALPHA_QUANTA[1], gone at
// `length`. Opaque courses keep the wake legible against the water at z3;
// it reads as water closing behind the hull with no animation (the shape
// rides with the ship; reduced motion needs no other frame).
export function wakeV(ctx, x, y, dirX, dirY, {
    length = 24,
    hold = 0,
    halfAngle = 0.34,
    color = '#91b2a8',
    crest = null,
    thick = 1,
} = {}) {
    let gx = Number(dirX) || 0;
    let gy = (Number(dirY) || 0) * 2;
    const len = Math.hypot(gx, gy);
    if (len < 1e-6) return;
    gx /= -len;
    gy /= -len;
    const steps = Math.max(4, Math.round(length));
    const fresh = Math.max(0, Math.min(steps - 3, Math.round(hold)));
    const baseAlpha = ctx.globalAlpha;
    for (const side of [-1, 1]) {
        const cs = Math.cos(halfAngle * side);
        const sn = Math.sin(halfAngle * side);
        const ax = gx * cs - gy * sn;
        const ay = (gx * sn + gy * cs) * 0.5;
        let lastX = NaN;
        let lastY = NaN;
        for (let s = 1; s <= steps; s++) {
            const age = s <= fresh ? 0 : 1 + Math.min(2, Math.floor((s - fresh - 1) * 3 / (steps - fresh)));
            const px = snap(x + ax * s);
            const py = snap(y + ay * s);
            if (px === lastX && py === lastY) continue;
            lastX = px;
            lastY = py;
            ctx.globalAlpha = baseAlpha * (age < 3 ? ALPHA_QUANTA[0] : ALPHA_QUANTA[1]);
            ctx.fillStyle = age < 2 && crest ? crest : color;
            rect(ctx, px, py, 1, age < 3 ? thick : 1);
        }
    }
    ctx.globalAlpha = baseAlpha;
}

function hash32(value) {
    let h = (value | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}
