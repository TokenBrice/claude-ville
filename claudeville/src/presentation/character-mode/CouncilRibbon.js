// Wave 4 (Spec 04 §4.10) — Council Focus (`C`) ribbon and flat dimming scrim.
//
// Self-contained Canvas-overlay bottom-center 44 px tall Council Focus ribbon:
//   - Lead cell: 44x44 with brass frame + 32x32 nearest-neighbour portrait +
//     3 px status underline + 4-letter pixel verb (`EDIT`, `TEST`, `READ`,
//     `WAIT`, `EXEC`, `PLAN`, `IDLE`).
//   - Child cells: up to 8 cells of 40x44 + exact `+N` overflow cell when
//     `children.length > 8`.
//   - Stacks 4 px above any reserved bottom Retold scrubber rect and publishes
//     its own reserved box via `publishReservedBox` so the caption band clears
//     it cleanly.
//   - `hitTest(x, y)` returns the clicked agent id so clicking glides to that
//     squad member while keeping Council Focus active.
//   - `drawCouncilScrim` paints flat `#0e0906` (`alpha 0.28` day / `0.18`
//     night) with nearest-neighbour `destination-out` pose-cell holes for
//     visible non-occluded squad members (`!_occludedByWorld && !_behindBuilding`).
//
// All ribbon verbs and `+N` overflow badges are drawn as crisp 4x5 pixel
// bitmap stamps via `fillRect` (zero subpixel text AA, zero font FOUT, and
// complete stand-down during `postcardFrame()`).

import { STATUS_VISUALS, THEME } from '../../config/theme.js';
import { getReservedRect, publishReservedBox } from '../shared/ReservedRects.js';
import { LABEL_INK, WALNUT } from './WorldLabelKit.js';
import { postcardFrame } from './Postcard.js';

export const RIBBON_HEIGHT = 44;
export const LEAD_CELL_W = 44;
export const CHILD_CELL_W = 40;
export const OVERFLOW_CELL_W = 40;
export const MAX_VISIBLE_CHILDREN = 8;
export const PORTRAIT_SIZE = 32;
export const STATUS_UNDERLINE_H = 3;
export const RIBBON_STACK_GAP = 4;
export const RIBBON_BOTTOM_MARGIN = 10;

export const COUNCIL_RIBBON_RESERVED_NAME = 'council-ribbon';
export const RETOLD_SCRUBBER_RESERVED_NAME = 'retold-scrubber';

export const SCRIM_COLOR = '#0e0906';
export const SCRIM_ALPHA_DAY = 0.28;
export const SCRIM_ALPHA_NIGHT = 0.18;

export const COUNCIL_VERBS = Object.freeze([
    'EDIT', 'TEST', 'READ', 'WAIT', 'EXEC', 'PLAN', 'IDLE', 'DONE', 'FAIL', 'CHAT',
]);

const CANONICAL_VERB_SET = new Set(COUNCIL_VERBS);

// Crisp 4x5 pixel bitmap glyphs (`1` = ink pixel) for 4-letter verbs and `+N` overflow.
const PIXEL_FONT_4X5 = Object.freeze({
    A: ['0110', '1001', '1111', '1001', '1001'],
    B: ['1110', '1001', '1110', '1001', '1110'],
    C: ['0111', '1000', '1000', '1000', '0111'],
    D: ['1110', '1001', '1001', '1001', '1110'],
    E: ['1111', '1000', '1110', '1000', '1111'],
    F: ['1111', '1000', '1110', '1000', '1000'],
    G: ['0111', '1000', '1011', '1001', '0111'],
    H: ['1001', '1001', '1111', '1001', '1001'],
    I: ['1110', '0100', '0100', '0100', '1110'],
    J: ['0011', '0001', '0001', '1001', '0110'],
    K: ['1001', '1010', '1100', '1010', '1001'],
    L: ['1000', '1000', '1000', '1000', '1111'],
    M: ['1001', '1111', '1111', '1001', '1001'],
    N: ['1001', '1101', '1011', '1001', '1001'],
    O: ['0110', '1001', '1001', '1001', '0110'],
    P: ['1110', '1001', '1110', '1000', '1000'],
    Q: ['0110', '1001', '1001', '1011', '0111'],
    R: ['1110', '1001', '1110', '1010', '1001'],
    S: ['0111', '1000', '0110', '0001', '1110'],
    T: ['1111', '0100', '0100', '0100', '0100'],
    U: ['1001', '1001', '1001', '1001', '0110'],
    V: ['1001', '1001', '1001', '0110', '0110'],
    W: ['1001', '1001', '1111', '1111', '1001'],
    X: ['1001', '1001', '0110', '1001', '1001'],
    Y: ['1001', '1001', '0110', '0100', '0100'],
    Z: ['1111', '0010', '0100', '1000', '1111'],
    0: ['0110', '1001', '1011', '1101', '0110'],
    1: ['0100', '1100', '0100', '0100', '1110'],
    2: ['1110', '0001', '0110', '1000', '1111'],
    3: ['1110', '0001', '0110', '0001', '1110'],
    4: ['1001', '1001', '1111', '0001', '0001'],
    5: ['1111', '1000', '1110', '0001', '1110'],
    6: ['0111', '1000', '1110', '1001', '0110'],
    7: ['1111', '0001', '0010', '0100', '0100'],
    8: ['0110', '1001', '0110', '1001', '0110'],
    9: ['0110', '1001', '0111', '0001', '1110'],
    '+': ['0000', '0100', '1110', '0100', '0000'],
    '-': ['0000', '0000', '1110', '0000', '0000'],
});

const GLYPH_W = 4;
const GLYPH_H = 5;
const GLYPH_GAP = 1;

function drawPixelStampText(ctx, text, centerX, topY, color, scale = 1) {
    const str = String(text || '').toUpperCase();
    if (!str.length) return;
    const step = Math.max(1, Math.round(scale));
    const totalW = (str.length * GLYPH_W + Math.max(0, str.length - 1) * GLYPH_GAP) * step;
    const startX = Math.round(centerX - totalW / 2);
    const startY = Math.round(topY);
    ctx.fillStyle = color;
    for (let i = 0; i < str.length; i++) {
        const glyph = PIXEL_FONT_4X5[str[i]];
        if (!glyph) continue;
        const gx = startX + i * (GLYPH_W + GLYPH_GAP) * step;
        for (let row = 0; row < GLYPH_H; row++) {
            const bits = glyph[row];
            for (let col = 0; col < GLYPH_W; col++) {
                if (bits[col] === '1') {
                    ctx.fillRect(gx + col * step, startY + row * step, step, step);
                }
            }
        }
    }
}

function memberStatus(member) {
    return String(member?.status ?? member?.agent?.status ?? 'idle').toLowerCase();
}

export function statusColorForMember(member) {
    const status = memberStatus(member);
    return STATUS_VISUALS[status]?.color || THEME.idle;
}

/**
 * Derive the 4-letter Council Ribbon verb (`EDIT`, `TEST`, `READ`, `WAIT`,
 * `EXEC`, `PLAN`, `IDLE`) from a squad member's live status or active tool.
 */
export function councilVerbFor(member) {
    if (!member) return 'IDLE';
    const explicit = String(member.verb || member.councilVerb || '').trim().toUpperCase();
    if (CANONICAL_VERB_SET.has(explicit)) return explicit;

    const status = memberStatus(member);
    if (status === 'waiting_on_user' || status === 'waiting' || status === 'rate_limited') return 'WAIT';
    if (status === 'idle') return 'IDLE';
    if (status === 'completed') return 'DONE';
    if (status === 'errored') return 'FAIL';
    if (status === 'chatting') return 'CHAT';

    const raw = String(
        member.readToolVerb
        || member.toolVerb
        || member.currentTool
        || member.agent?.currentTool
        || member.toolCategory
        || '',
    ).trim().toLowerCase();

    if (/edit|write|patch|modify|notebook|create_file|replace/.test(raw)) return 'EDIT';
    if (/test|verify|check|spec|jest|vitest|pytest|assert/.test(raw)) return 'TEST';
    if (/read|search|grep|glob|find|list|inspect|browse|fetch|web|view/.test(raw)) return 'READ';
    if (/plan|task|delegate|spawn|team|coord|orchestr|report|todo/.test(raw)) return 'PLAN';
    if (/wait|ask|watch|monitor|sleep|poll/.test(raw)) return 'WAIT';
    if (/run|exec|shell|bash|cmd|term|command|git|build|debug/.test(raw)) return 'EXEC';
    return status === 'working' ? 'EXEC' : 'IDLE';
}

function resolveMemberId(member) {
    return member?.id ?? member?.agent?.id ?? null;
}

function resolveReservedBottom(reservedBottomRect, reservedRects) {
    if (reservedBottomRect && Number.isFinite(reservedBottomRect.top)) {
        return reservedBottomRect;
    }
    if (Array.isArray(reservedRects)) {
        const scrubber = reservedRects.find((r) => r && r.name === RETOLD_SCRUBBER_RESERVED_NAME && Number.isFinite(r.top));
        if (scrubber) return scrubber;
    }
    const published = getReservedRect(RETOLD_SCRUBBER_RESERVED_NAME);
    if (published && Number.isFinite(published.top)) return published;
    return null;
}

/**
 * Compute exact integer screen layout `{ x, y, width, height, rect, cells, overflowCount }`
 * for the bottom-center 44 px Council Focus ribbon, stacked 4 px above any
 * reserved bottom Retold scrubber rect.
 */
export function layoutCouncilRibbon({
    lead = null,
    children = [],
    viewport = null,
    reservedBottomRect = null,
    reservedRects = null,
    selectedId = null,
} = {}) {
    if (!lead || !viewport) return null;
    const vw = Number(viewport.width);
    const vh = Number(viewport.height);
    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return null;

    const childList = Array.isArray(children) ? children.filter(Boolean) : [];
    const visibleChildren = childList.slice(0, MAX_VISIBLE_CHILDREN);
    const overflowCount = Math.max(0, childList.length - MAX_VISIBLE_CHILDREN);

    const width = LEAD_CELL_W
        + visibleChildren.length * CHILD_CELL_W
        + (overflowCount > 0 ? OVERFLOW_CELL_W : 0);
    const height = RIBBON_HEIGHT;
    const x = Math.round((vw - width) / 2);

    const bottomScrubber = resolveReservedBottom(reservedBottomRect, reservedRects);
    const rawY = bottomScrubber
        ? Math.round(bottomScrubber.top - RIBBON_STACK_GAP - height)
        : Math.round(vh - RIBBON_BOTTOM_MARGIN - height);
    const y = Math.max(0, rawY);

    const cells = [];
    let cursorX = x;

    const leadId = resolveMemberId(lead);
    cells.push(Object.freeze({
        kind: 'lead',
        agentId: leadId,
        member: lead,
        x: cursorX,
        y,
        width: LEAD_CELL_W,
        height,
        portraitRect: Object.freeze({
            x: cursorX + Math.floor((LEAD_CELL_W - PORTRAIT_SIZE) / 2),
            y: y + 2,
            width: PORTRAIT_SIZE,
            height: PORTRAIT_SIZE,
        }),
        underlineRect: Object.freeze({
            x: cursorX + Math.floor((LEAD_CELL_W - PORTRAIT_SIZE) / 2),
            y: y + 34,
            width: PORTRAIT_SIZE,
            height: STATUS_UNDERLINE_H,
        }),
        verb: councilVerbFor(lead),
        statusColor: statusColorForMember(lead),
        selected: selectedId !== null && leadId === selectedId,
    }));
    cursorX += LEAD_CELL_W;

    for (let i = 0; i < visibleChildren.length; i++) {
        const child = visibleChildren[i];
        const childId = resolveMemberId(child);
        cells.push(Object.freeze({
            kind: 'child',
            agentId: childId,
            member: child,
            x: cursorX,
            y,
            width: CHILD_CELL_W,
            height,
            portraitRect: Object.freeze({
                x: cursorX + Math.floor((CHILD_CELL_W - PORTRAIT_SIZE) / 2),
                y: y + 2,
                width: PORTRAIT_SIZE,
                height: PORTRAIT_SIZE,
            }),
            underlineRect: Object.freeze({
                x: cursorX + Math.floor((CHILD_CELL_W - PORTRAIT_SIZE) / 2),
                y: y + 34,
                width: PORTRAIT_SIZE,
                height: STATUS_UNDERLINE_H,
            }),
            verb: councilVerbFor(child),
            statusColor: statusColorForMember(child),
            selected: selectedId !== null && childId === selectedId,
        }));
        cursorX += CHILD_CELL_W;
    }

    if (overflowCount > 0) {
        cells.push(Object.freeze({
            kind: 'overflow',
            agentId: null,
            member: null,
            overflowCount,
            label: `+${overflowCount}`,
            x: cursorX,
            y,
            width: OVERFLOW_CELL_W,
            height,
        }));
    }

    const rect = Object.freeze({
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        width,
        height,
    });

    return Object.freeze({
        x,
        y,
        width,
        height,
        rect,
        cells: Object.freeze(cells),
        overflowCount,
    });
}

/**
 * Hit-test `(x, y)` in viewport CSS pixels against a computed Council Ribbon
 * layout. Returns the clicked member's `agentId`, or `null` for misses and the
 * non-selectable `+N` overflow cell.
 */
export function hitTestCouncilRibbon(layout, x, y) {
    if (!layout || !Array.isArray(layout.cells)) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let i = 0; i < layout.cells.length; i++) {
        const cell = layout.cells[i];
        if (x >= cell.x && x < cell.x + cell.width && y >= cell.y && y < cell.y + cell.height) {
            return cell.agentId ?? null;
        }
    }
    return null;
}

function drawMemberPortrait(ctx, cell) {
    const { x, y, width, height } = cell.portraitRect;
    // Recessed dark portrait niche.
    ctx.fillStyle = WALNUT.shade;
    ctx.fillRect(x, y, width, height);

    const member = cell.member;
    const portrait = member?.portraitCanvas || member?.portrait || null;
    const pose = member?._poseCell || member?.poseCell || null;

    ctx.imageSmoothingEnabled = false;
    if (portrait && portrait.width && portrait.height) {
        ctx.drawImage(portrait, 0, 0, portrait.width, portrait.height, x, y, width, height);
        return;
    }
    if (pose?.canvas && pose.sw > 0 && pose.sh > 0) {
        ctx.drawImage(pose.canvas, pose.sx, pose.sy, pose.sw, pose.sh, x, y, width, height);
        return;
    }

    // Fallback silent pixel pawn bust when sprite assets have not loaded yet.
    const trim = member?.trimColor || cell.statusColor || LABEL_INK.brass;
    ctx.fillStyle = LABEL_INK.outline;
    ctx.fillRect(x + 11, y + 6, 10, 10);
    ctx.fillRect(x + 7, y + 16, 18, 12);
    ctx.fillStyle = trim;
    ctx.fillRect(x + 12, y + 7, 8, 8);
    ctx.fillRect(x + 8, y + 17, 16, 10);
}

function paintRibbonCell(ctx, cell) {
    const { x, y, width, height } = cell;
    // Outer outline + walnut body.
    ctx.fillStyle = WALNUT.outline;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = WALNUT.fill;
    ctx.fillRect(x + 1, y + 1, width - 2, height - 2);

    if (cell.kind === 'lead') {
        // Brass frame around the 44x44 lead cell.
        ctx.fillStyle = LABEL_INK.brass;
        ctx.fillRect(x + 1, y + 1, width - 2, 1);
        ctx.fillRect(x + 1, y + height - 2, width - 2, 1);
        ctx.fillRect(x + 1, y + 1, 1, height - 2);
        ctx.fillRect(x + width - 2, y + 1, 1, height - 2);
        ctx.fillStyle = LABEL_INK.gold;
        ctx.fillRect(x + 1, y + 1, width - 2, 1);
    } else {
        ctx.fillStyle = cell.selected ? LABEL_INK.gold : WALNUT.bevel;
        ctx.fillRect(x + 1, y + 1, width - 2, 1);
        ctx.fillStyle = WALNUT.shade;
        ctx.fillRect(x + 1, y + height - 2, width - 2, 1);
    }

    if (cell.kind === 'overflow') {
        drawPixelStampText(
            ctx,
            cell.label,
            x + Math.floor(width / 2),
            y + Math.floor((height - GLYPH_H * 2) / 2),
            LABEL_INK.gold,
            cell.label.length <= 3 ? 2 : 1,
        );
        return;
    }

    drawMemberPortrait(ctx, cell);

    // 3 px status underline.
    const ul = cell.underlineRect;
    ctx.fillStyle = cell.statusColor;
    ctx.fillRect(ul.x, ul.y, ul.width, ul.height);

    // 4-letter verb directly beneath the status underline (crisp 4x5 pixel glyphs).
    drawPixelStampText(
        ctx,
        cell.verb,
        x + Math.floor(width / 2),
        y + 37,
        cell.kind === 'lead' || cell.selected ? LABEL_INK.gold : LABEL_INK.text,
        1,
    );
}

let cachedScrimCanvas = null;

function obtainScrimSurface(width, height, options) {
    if (options.scrimCanvas) {
        const c = options.scrimCanvas;
        if (c.width !== width) c.width = width;
        if (c.height !== height) c.height = height;
        return c;
    }
    if (typeof options.createCanvas === 'function') {
        return options.createCanvas(width, height);
    }
    if (options.direct) return null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        if (!cachedScrimCanvas) cachedScrimCanvas = document.createElement('canvas');
        if (cachedScrimCanvas.width !== width) cachedScrimCanvas.width = width;
        if (cachedScrimCanvas.height !== height) cachedScrimCanvas.height = height;
        return cachedScrimCanvas;
    }
    if (typeof OffscreenCanvas === 'function') {
        if (!cachedScrimCanvas) cachedScrimCanvas = new OffscreenCanvas(width, height);
        if (cachedScrimCanvas.width !== width) cachedScrimCanvas.width = width;
        if (cachedScrimCanvas.height !== height) cachedScrimCanvas.height = height;
        return cachedScrimCanvas;
    }
    return null;
}

function resolveMemberHoleRect(member, pose, options) {
    if (member.screenRect) {
        const r = member.screenRect;
        return { x: r.x, y: r.y, w: r.width ?? r.w, h: r.height ?? r.h };
    }
    if (Number.isFinite(member.screenX) && Number.isFinite(member.screenY)) {
        const scale = Number(options.zoom ?? member.zoom ?? pose.drawScale ?? 1) || 1;
        return {
            x: member.screenX,
            y: member.screenY,
            w: Number.isFinite(member.screenW) ? member.screenW : pose.sw * scale,
            h: Number.isFinite(member.screenH) ? member.screenH : pose.sh * scale,
        };
    }
    const camera = options.camera || null;
    const zoom = Number(options.zoom ?? camera?.zoom ?? 1) || 1;
    const scale = (Number(pose.drawScale) || 1) * zoom;
    if (camera && typeof camera.worldToScreen === 'function' && Number.isFinite(pose.dx) && Number.isFinite(pose.dy)) {
        const pt = camera.worldToScreen(pose.dx, pose.dy);
        return { x: pt.x, y: pt.y, w: pose.sw * scale, h: pose.sh * scale };
    }
    if (Number.isFinite(pose.dx) && Number.isFinite(pose.dy)) {
        return { x: pose.dx * zoom, y: pose.dy * zoom, w: pose.sw * scale, h: pose.sh * scale };
    }
    return null;
}

/**
 * Draw the Council Focus flat dimming scrim (`#0e0906`, alpha `0.28` day /
 * `0.18` night) with nearest-neighbour `destination-out` pose-cell holes for
 * visible non-occluded squad members (`!_occludedByWorld && !_behindBuilding`).
 */
export function drawCouncilScrim(ctx, viewport, squadMembers = [], isNight = false, options = {}) {
    if (!ctx || !viewport || postcardFrame()) {
        return { drawn: false, alpha: 0, holesCut: 0 };
    }
    const width = Math.max(0, Math.round(Number(viewport.width) || 0));
    const height = Math.max(0, Math.round(Number(viewport.height) || 0));
    if (!width || !height) return { drawn: false, alpha: 0, holesCut: 0 };

    const alpha = isNight ? SCRIM_ALPHA_NIGHT : SCRIM_ALPHA_DAY;
    const scratch = obtainScrimSurface(width, height, options);
    const targetCtx = scratch ? scratch.getContext('2d') : ctx;
    if (!targetCtx) return { drawn: false, alpha: 0, holesCut: 0 };

    let holesCut = 0;
    targetCtx.save();
    if (scratch) targetCtx.clearRect(0, 0, width, height);
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.globalAlpha = alpha;
    targetCtx.fillStyle = SCRIM_COLOR;
    targetCtx.fillRect(0, 0, width, height);

    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.globalAlpha = 1;
    targetCtx.imageSmoothingEnabled = false;

    for (const member of Array.isArray(squadMembers) ? squadMembers : []) {
        if (!member || member._occludedByWorld || member._behindBuilding) continue;
        const pose = member._poseCell || member.poseCell || null;
        if (!pose?.canvas || !(pose.sw > 0) || !(pose.sh > 0)) continue;
        const dst = resolveMemberHoleRect(member, pose, options);
        if (!dst || !(dst.w > 0) || !(dst.h > 0)) continue;
        targetCtx.drawImage(
            pose.canvas,
            pose.sx || 0,
            pose.sy || 0,
            pose.sw,
            pose.sh,
            Math.round(dst.x),
            Math.round(dst.y),
            Math.round(dst.w),
            Math.round(dst.h),
        );
        holesCut++;
    }
    targetCtx.restore();

    if (scratch) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, 0, 0, width, height);
        ctx.restore();
    }

    return { drawn: true, alpha, holesCut };
}

export class CouncilRibbon {
    constructor({ publishBox = publishReservedBox } = {}) {
        this._publishBox = typeof publishBox === 'function' ? publishBox : () => {};
        this._lead = null;
        this._children = [];
        this._selectedId = null;
        this._layout = null;
    }

    get active() {
        return this.isActive();
    }

    isActive() {
        return Boolean(this._lead);
    }

    getLayout() {
        return this._layout;
    }

    setSquad({ lead = null, children = [], selectedId = null } = {}) {
        this._lead = lead || null;
        this._children = Array.isArray(children) ? children.filter(Boolean) : [];
        this._selectedId = selectedId;
        if (!this._lead) {
            this._layout = null;
            this._publishBox(COUNCIL_RIBBON_RESERVED_NAME, null);
        }
        return this.isActive();
    }

    clear() {
        this._lead = null;
        this._children = [];
        this._selectedId = null;
        this._layout = null;
        this._publishBox(COUNCIL_RIBBON_RESERVED_NAME, null);
    }

    dispose() {
        this.clear();
    }

    layout(viewport, { reservedBottomRect = null, reservedRects = null, publish = true } = {}) {
        const next = layoutCouncilRibbon({
            lead: this._lead,
            children: this._children,
            viewport,
            reservedBottomRect,
            reservedRects,
            selectedId: this._selectedId,
        });
        this._layout = next;
        if (publish) {
            this._publishBox(COUNCIL_RIBBON_RESERVED_NAME, next ? next.rect : null);
        }
        return next;
    }

    draw(ctx, viewport, options = {}) {
        if (postcardFrame()) {
            this._publishBox(COUNCIL_RIBBON_RESERVED_NAME, null);
            return null;
        }
        const box = this.layout(viewport, options);
        if (!box || !ctx) return box;

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (let i = 0; i < box.cells.length; i++) {
            paintRibbonCell(ctx, box.cells[i]);
        }
        ctx.restore();
        return box;
    }

    hitTest(x, y) {
        return hitTestCouncilRibbon(this._layout, x, y);
    }

    /**
     * Handle a click at `(x, y)`. If a lead or child cell is hit, calls
     * `onSelect(agentId, { keepCouncilFocus: true })` and keeps Council Focus
     * active.
     */
    onClick(x, y, onSelect = null) {
        const agentId = this.hitTest(x, y);
        if (!agentId) return null;
        this._selectedId = agentId;
        if (typeof onSelect === 'function') {
            onSelect(agentId, { keepCouncilFocus: true });
        }
        return agentId;
    }
}
