// Wave 4 W4-A (Spec 04 §2.3, §4.2) — building signage, extracted from
// BuildingSprite. Pure helpers plus two painters; BuildingSprite keeps the
// orchestration (`drawLabels`, its collision state and its world pass) and
// delegates here.
//
//   - T3 plaque geometry and paint (`measurePlaque`, `paintPlaque`): the
//     walnut board with its 17 px head band `motif · NAME │ count`, the
//     Tavern patron cell, the Command attention cell and the ledger/muster
//     rows. The compact chit is that head band with no rows (R14).
//   - Sign siting: every landmark's authored `sign.at` (BuildingVisualRegistry,
//     the 12 × 14 `signBoxFor` box world:validate-buildings measures). The
//     chit column stands over it on the first of three rungs whose board does
//     not land on a foreign mask (another landmark's alpha or the World Ash):
//       P0 crown  board bottom 7 px above roofY, post into the roof
//       P1 eave   board top 6 px below roofY, no post
//       P2 lintel board bottom 4 px above sign.y, no post
//     with roofY the first opaque row of the building's own mask inside
//     columns sign.x ± 16 (cached per mask).
//   - Carved Motifs (`signageMode: 'motifs'`): a world-space iron bracket and
//     10 × 10 walnut-framed district emblem at `sign.at`, graded like the
//     building, with the live tally under it — 2 × 2 brass pips 1 apart up to
//     five, a 3 × 5 pixel numeral from six. Walnut and brass only, no status
//     hue and no text call: the frame is the baked `prop.carvedMotifs` cell
//     when that sheet is resident, else the identical pixels drawn from the
//     same deterministic recipe (scripts/sprites/bake-carved-motifs.mjs).

import { BUILDING_DEFS } from '../../config/buildings.js';
import { STATUS_VISUALS, WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { ART_RAMPS } from '../../config/artPalette.js';
import { WORLD_TREE } from '../../config/scenery.js';
import { EVENT_SHAPES } from '../shared/EventShapes.js';
import {
    LABEL_INK,
    WALNUT,
    drawOutlinedMotif,
    fitLabelText,
    measureLabelText,
    paintWalnutBoard,
    snapScreenOrigin,
} from './WorldLabelKit.js';
import { tileToWorld } from './Projection.js';
import { gradeTone } from './EffectStamps.js';
import { getBuildingSignAnchor, signBoxFor } from './BuildingVisualRegistry.js';

// T3 plaque geometry (screen pixels): 5 px pads, a 17-row head band holding
// the motif, 8 px Press Start 2P name and 11 px Departure Mono count, and
// 12-row ledger lines (harbor commits, READ verbs, Command muster lines).
export const PLAQUE_PAD = 5;
export const PLAQUE_HEAD_H = 17;
export const PLAQUE_ROW_H = 12;
// W7.5 — the muster line's carved ▸ (3 px, a space either side) and its row
// budget: up to three squads, else two and one exact `+N squads` line.
export const PLAQUE_MUSTER_ARROW_W = 3;
export const PLAQUE_MUSTER_MAX_ROWS = 3;
export const DISTRICT_MOTIFS = Object.freeze(Object.fromEntries(
    BUILDING_DEFS
        .map((building) => [building.type, `district-${building.type}`])
        .filter(([, motif]) => Boolean(EVENT_SHAPES[motif])),
));
// W5.5a — the Command plaque's attention cell takes the lead actionable
// bucket (SignalLedger precedence: needs-you, error, limit) in the T1 plate's
// status hue and motif, so it reads as the same mark the plates carry.
export const PLAQUE_ATTENTION = Object.freeze({
    needsYou: Object.freeze({ motif: 'needs-you', color: STATUS_VISUALS.waiting_on_user.color }),
    errors: Object.freeze({ motif: 'alert', color: STATUS_VISUALS.errored.color }),
    quota: Object.freeze({ motif: 'limit-gate', color: STATUS_VISUALS.rate_limited.color }),
});
export const PLAQUE_ATTENTION_GAP = 4;
// AG-1 — the Tavern's patron cell carries the district's own tankard motif.
export const PATRON_MOTIF = 'district-tavern';

// §4.2 — the Settings value (`claudeville.world.signage`). Pure Stage is no
// value: it is what Theatre (`H`) and postcards show.
export const SIGNAGE_MODES = Object.freeze(['compact', 'motifs']);
export const SIGNAGE_DEFAULT_MODE = 'compact';

export function normalizeSignageMode(value) {
    return value === 'motifs' ? 'motifs' : SIGNAGE_DEFAULT_MODE;
}

// R1 — OVERVIEW `z < 1.6` (ROUTINE_NAME_MIN_ZOOM) drops the Harbor ledger and
// Command muster rows; DISTRICT `z >= 1.6` keeps them. Read on the camera's
// rest tier, never on a glide's instantaneous zoom.
export const SIGNAGE_DISTRICT_ZOOM = 1.6;

export function isDistrictZoom(restZoom) {
    return Number(restZoom) >= SIGNAGE_DISTRICT_ZOOM;
}

// §2.3 ladder gaps (screen px) and the roof band half-width (texels).
export const PLAQUE_CROWN_GAP = 7;
export const PLAQUE_EAVE_GAP = 6;
export const PLAQUE_LINTEL_GAP = 4;
export const ROOF_BAND_HALF = 16;
// foreign(rect): >= 12 px² of another landmark's or the World Ash's mask.
export const FOREIGN_MIN_PX2 = 12;
export const WORLD_ASH_ID = 'veg.tree.ash.world';
// The world ash sheet's own anchor (FoliageRenderer `ash.world`: 240 × 271,
// the trunk planted at the bottom-centre texel).
const WORLD_ASH_ANCHOR = Object.freeze([120, 270]);

// ─── Plaque measurement and paint ────────────────────────────────────────────

// A label fit when the host has no metrics cache (bare test stubs): the same
// ellipsis rule as BuildingSprite._labelMetrics.
function fallbackLabelMetrics(ctx, _building, { text, maxTextWidth }) {
    let displayText = text;
    if (ctx.measureText(displayText).width > maxTextWidth) {
        while (displayText.length > 1 && ctx.measureText(`${displayText}…`).width > maxTextWidth) {
            displayText = displayText.slice(0, -1);
        }
        if (displayText.length < text.length) displayText = `${displayText}…`;
    }
    return { displayText, width: ctx.measureText(displayText).width };
}

/**
 * Plaque geometry in screen pixels (before the 1/zoom counter-scale).
 * `labelMetrics(ctx, building, opts)` is the host's cached title fit.
 */
export function measurePlaque(ctx, building, attempt, {
    count,
    zoom,
    isHovered,
    isLandmark,
    scaleMode,
    attention = null,
    patrons = null,
} = {}, labelMetrics = fallbackLabelMetrics) {
    const motif = attempt.motif ? DISTRICT_MOTIFS[building.type] || null : null;
    ctx.save();
    ctx.font = WORLD_DISPLAY_FONT_8;
    const title = attempt.text
        ? labelMetrics(ctx, building, {
            text: attempt.text,
            labelFont: WORLD_DISPLAY_FONT_8,
            maxTextWidth: attempt.maxTextWidth,
            zoom,
            isHovered,
            isLandmark,
            scaleMode,
        })
        : { displayText: '', width: 0 };
    ctx.font = WORLD_BODY_FONT_11;
    const countText = count > 0 && !attempt.hideCount ? String(count) : '';
    const countWidth = countText ? measureLabelText(ctx, countText) : 0;
    // W7.5 — a muster row keeps its exact `· out ▸ returned` tail whole
    // and shortens only the parent's name to make room.
    const rowMaxWidth = attempt.rowMaxWidth || 180;
    const rows = (attempt.rows || []).map(row => {
        // U-P4 — a ledger row's count is a tail that never truncates:
        // only the name shrinks to make room for it.
        if (row.tail) {
            const tailText = ` ${row.tail}`;
            const tailWidth = Math.round(measureLabelText(ctx, tailText));
            const label = fitLabelText(ctx, row.label, Math.max(0, rowMaxWidth - (row.profile ? 8 : 0) - tailWidth));
            return { ...row, label, tailText, tailWidth };
        }
        if (!row.muster) return { ...row, label: fitLabelText(ctx, row.label, rowMaxWidth) };
        const musterLeft = ` · ${row.muster.out} `;
        const musterRight = ` ${row.muster.returned}`;
        const leftWidth = Math.round(measureLabelText(ctx, musterLeft));
        const tailWidth = leftWidth + PLAQUE_MUSTER_ARROW_W + Math.round(measureLabelText(ctx, musterRight));
        const label = fitLabelText(ctx, row.label, Math.max(0, rowMaxWidth - (row.profile ? 8 : 0) - tailWidth));
        return { ...row, label, musterLeft, musterRight, leftWidth, tailWidth };
    });
    const rowsWidth = rows.reduce((max, row) => Math.max(max, Math.round(measureLabelText(ctx, row.label)) + (row.profile ? 8 : 0) + (row.tailWidth || 0)), 0);
    const attentionText = attention?.count > 0 ? String(attention.count) : '';
    const attentionWidth = attentionText ? measureLabelText(ctx, attentionText) : 0;
    const patronText = patrons?.count > 0 ? String(patrons.count) : '';
    const patronAge = patronText && patrons.age ? ` · ${patrons.age}` : '';
    const patronWidth = patronText ? Math.round(measureLabelText(ctx, patronText)) : 0;
    const patronAgeWidth = patronAge ? Math.round(measureLabelText(ctx, patronAge)) : 0;
    ctx.restore();
    const titleWidth = Math.round(title.width);
    const motifWidth = motif ? 8 + 5 : 0;
    let headWidth = PLAQUE_PAD + motifWidth + titleWidth + (titleWidth ? PLAQUE_PAD : 0);
    if (!titleWidth && motif) headWidth = PLAQUE_PAD + 8 + PLAQUE_PAD;
    const countCell = countText ? 1 + PLAQUE_PAD + countWidth + PLAQUE_PAD : 0;
    // W5.5a — `COMMAND │ 7 │ ⟡3`: a status-hue cell at the head band's
    // right end, the lead bucket's motif and the exact actionable count in
    // plate ink. Absent at zero, so the plaque is then unchanged.
    const attentionCell = attentionText ? PLAQUE_PAD + 8 + PLAQUE_ATTENTION_GAP + attentionWidth + PLAQUE_PAD : 0;
    const patronCell = patronText ? 1 + PLAQUE_PAD + 8 + PLAQUE_ATTENTION_GAP + patronWidth + patronAgeWidth + PLAQUE_PAD : 0;
    const width = Math.max(headWidth + countCell + patronCell + attentionCell, rowsWidth + PLAQUE_PAD * 2) + 2;
    const height = PLAQUE_HEAD_H + (rows.length ? rows.length * PLAQUE_ROW_H + 3 : 0);
    const plaque = {
        motif,
        title: title.displayText,
        titleWidth,
        countText,
        headWidth,
        rows,
        width,
        height,
    };
    if (attentionText) {
        plaque.attention = attention;
        plaque.attentionText = attentionText;
        plaque.attentionCell = attentionCell;
    }
    if (patronText) {
        plaque.patronText = patronText;
        plaque.patronAge = patronAge;
        plaque.patronWidth = patronWidth;
        plaque.patronCell = patronCell;
        plaque.patronCellLeft = headWidth + countCell;
        plaque.patronFull = Boolean(patrons.full);
    }
    return plaque;
}

/**
 * Paints a measured plaque centred on world (x, y), counter-scaled by
 * `labelScale` so it stays screen-fixed. `poleBottom` (world y, or null)
 * runs the one-pixel post from the board's foot into the roof. `quiet` is
 * kept for callers of the old G7-2 dimmed board; the label pass no longer
 * sets it (§4.2: an empty landmark has no chit at rest, so the dim board is
 * retired).
 */
export function paintPlaque(ctx, plaque, { x, y, labelScale, poleBottom, isHovered, isSelected, isLandmark, alert, accent, quiet = false }) {
    const { width, height } = plaque;
    const lit = isHovered || isSelected;
    const dim = quiet && !lit && !alert && !plaque.countText && !plaque.rows.length
        && !plaque.patronCell && !plaque.attention;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(labelScale, labelScale);
    snapScreenOrigin(ctx);
    const left = -Math.round(width / 2);
    const top = -Math.round(height / 2);
    const postTop = top + height;
    // The post: one screen pixel from the board's foot into the roof.
    const postBottom = Number.isFinite(poleBottom) ? Math.round((poleBottom - y) / labelScale) : postTop;
    if (postBottom > postTop) {
        ctx.fillStyle = WALNUT.outline;
        ctx.fillRect(-1, postTop, 3, postBottom - postTop);
        ctx.fillStyle = WALNUT.bevel;
        ctx.fillRect(0, postTop, 1, postBottom - postTop);
    }
    if (isSelected) {
        ctx.fillStyle = LABEL_INK.gold;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
    }
    paintWalnutBoard(ctx, left, top, width, height, { nails: (isLandmark && !dim) || lit, lit });
    // A verified failed push on the watchtower carries a red left rail;
    // nothing else on a plaque claims an outcome.
    if (alert) {
        ctx.fillStyle = '#e06c5b';
        ctx.fillRect(left + 1, top + 1, 2, height - 2);
    }
    let cursor = left + 1 + PLAQUE_PAD;
    if (plaque.motif) {
        drawOutlinedMotif(ctx, plaque.motif, cursor, top + 4, {
            color: lit ? '#ffe7a3' : dim ? LABEL_INK.textDim : accent,
            outline: WALNUT.outline,
        });
        cursor += 8 + 5;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (plaque.title) {
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = lit ? '#ffe7a3' : dim ? LABEL_INK.textDim : WALNUT.text;
        ctx.fillText(plaque.title, cursor, top + 13);
    }
    if (plaque.countText) {
        const dividerX = left + 1 + plaque.headWidth;
        ctx.fillStyle = WALNUT.divider;
        ctx.fillRect(dividerX, top + 2, 1, PLAQUE_HEAD_H - 4);
        ctx.font = WORLD_BODY_FONT_11;
        ctx.fillStyle = WALNUT.count;
        ctx.fillText(plaque.countText, dividerX + 1 + PLAQUE_PAD, top + 12);
    }
    if (plaque.patronCell) {
        // AG-1 — after the head band and any work count: a divider, the
        // tankard in the district accent, the count in count ink and the
        // oldest wait in dim ink; at seat capacity the cell fills with the
        // accent and its marks take plate ink.
        const cellLeft = left + 1 + plaque.patronCellLeft;
        const full = plaque.patronFull;
        if (full) {
            ctx.fillStyle = accent;
            ctx.fillRect(cellLeft + 1, top + 1, plaque.patronCell - 1, PLAQUE_HEAD_H - 2);
        } else {
            ctx.fillStyle = WALNUT.divider;
            ctx.fillRect(cellLeft, top + 2, 1, PLAQUE_HEAD_H - 4);
        }
        const motifX = cellLeft + 1 + PLAQUE_PAD;
        drawOutlinedMotif(ctx, PATRON_MOTIF, motifX, top + 4, {
            color: full ? LABEL_INK.plate : accent,
            outline: full ? 'transparent' : WALNUT.outline,
        });
        const textX = motifX + 8 + PLAQUE_ATTENTION_GAP;
        ctx.font = WORLD_BODY_FONT_11;
        ctx.fillStyle = full ? LABEL_INK.plate : WALNUT.count;
        ctx.fillText(plaque.patronText, textX, top + 12);
        if (plaque.patronAge) {
            ctx.fillStyle = full ? LABEL_INK.plate : LABEL_INK.textDim;
            ctx.fillText(plaque.patronAge, textX + plaque.patronWidth, top + 12);
        }
    }
    if (plaque.attention) {
        // Right-aligned inside the outline, over the head band's bevel
        // and shade rows like the T1 plate's status cell.
        const cellLeft = left + width - 1 - plaque.attentionCell;
        ctx.fillStyle = plaque.attention.color;
        ctx.fillRect(cellLeft, top + 1, plaque.attentionCell, PLAQUE_HEAD_H - 2);
        drawOutlinedMotif(ctx, plaque.attention.motif, cellLeft + PLAQUE_PAD, top + 4, {
            color: LABEL_INK.plate,
            outline: 'transparent',
        });
        ctx.font = WORLD_BODY_FONT_11;
        ctx.fillStyle = LABEL_INK.plate;
        ctx.fillText(plaque.attentionText, cellLeft + PLAQUE_PAD + 8 + PLAQUE_ATTENTION_GAP, top + 12);
    }
    if (plaque.rows.length) {
        ctx.fillStyle = WALNUT.shade;
        ctx.fillRect(left + 2, top + PLAQUE_HEAD_H - 1, width - 4, 1);
        ctx.font = WORLD_BODY_FONT_11;
        plaque.rows.forEach((row, index) => {
            const baseline = top + PLAQUE_HEAD_H + 1 + index * PLAQUE_ROW_H + 9;
            let rowX = left + 1 + PLAQUE_PAD;
            if (row.profile) {
                // Repo swatch: a 3×3 pixel diamond in the repo accent.
                ctx.fillStyle = row.profile.accent || WALNUT.text;
                ctx.fillRect(rowX + 1, baseline - 6, 1, 3);
                ctx.fillRect(rowX, baseline - 5, 3, 1);
                rowX += 8;
            }
            ctx.fillStyle = row.color || WALNUT.count;
            ctx.fillText(row.label, rowX, baseline);
            if (row.tailText) {
                ctx.fillStyle = row.tailColor || WALNUT.count;
                ctx.fillText(row.tailText, rowX + Math.round(measureLabelText(ctx, row.label)), baseline);
            }
            if (row.musterLeft) {
                // `· 6 ▸ 2` in count ink; the ▸ is a 3×5 carved
                // triangle (Departure Mono has no U+25B8).
                let tailX = rowX + Math.round(measureLabelText(ctx, row.label));
                ctx.fillStyle = WALNUT.count;
                ctx.fillText(row.musterLeft, tailX, baseline);
                tailX += row.leftWidth;
                ctx.fillRect(tailX, baseline - 6, 1, 5);
                ctx.fillRect(tailX + 1, baseline - 5, 1, 3);
                ctx.fillRect(tailX + 2, baseline - 4, 1, 1);
                ctx.fillText(row.musterRight, tailX + PLAQUE_MUSTER_ARROW_W, baseline);
            }
        });
    }
    ctx.restore();
}

// True when a painted plaque shows every member its building counts: the
// work count cell (or there is no work count) and the patron cell (or there
// are no patrons). A ledger plaque hides its head count, so it owns nobody
// and its crowd keeps its `+N` (§4.2 T5, exact subtraction).
export function plaqueShowsCounts(plaque, { count = 0, patrons = 0 } = {}) {
    if (!plaque) return false;
    const workShown = !(count > 0) || Boolean(plaque.countText);
    const patronsShown = !(patrons > 0) || Boolean(plaque.patronText);
    return workShown && patronsShown;
}

// ─── Sign siting ─────────────────────────────────────────────────────────────

// The first opaque row of `mask` (w × h, 1 = opaque) inside the columns
// [signX - 16, signX + 16], or null when the band is empty.
export function roofRowFor(mask, w, h, signX) {
    if (!mask || !(w > 0) || !(h > 0)) return null;
    const x0 = Math.max(0, Math.floor(signX - ROOF_BAND_HALF));
    const x1 = Math.min(w - 1, Math.floor(signX + ROOF_BAND_HALF));
    if (x1 < x0) return null;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) if (mask[row + x]) return y;
    }
    return null;
}

/**
 * The §2.3 rungs for a board `boardW × boardH` (world units) over the sign
 * column: `{ level, x, y, poleBottom }` with (x, y) the board's centre and
 * `poleBottom` the post's foot (null: no post). `roofY` and `signY` are world
 * rows; gaps are screen px, so they scale by `labelScale`.
 */
export function signChitRungs({ signX, signY, roofY, boardH, labelScale = 1 }) {
    const half = boardH / 2;
    const rungs = [];
    if (Number.isFinite(roofY)) {
        rungs.push({ level: 'P0', x: signX, y: roofY - PLAQUE_CROWN_GAP * labelScale - half, poleBottom: roofY + 2 * labelScale });
        rungs.push({ level: 'P1', x: signX, y: roofY + PLAQUE_EAVE_GAP * labelScale + half, poleBottom: null });
    }
    if (Number.isFinite(signY)) {
        rungs.push({ level: 'P2', x: signX, y: signY - PLAQUE_LINTEL_GAP * labelScale - half, poleBottom: null });
    }
    return rungs;
}

// Summed-area table of a 0/1 mask: (w + 1) × (h + 1), so any rectangle's
// opaque count is four reads.
export function maskIntegral(mask, w, h) {
    const stride = w + 1;
    const sat = new Int32Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
        let run = 0;
        const row = y * w;
        const out = (y + 1) * stride;
        const above = y * stride;
        for (let x = 0; x < w; x++) {
            run += mask[row + x] ? 1 : 0;
            sat[out + x + 1] = sat[above + x + 1] + run;
        }
    }
    return sat;
}

// Opaque texels of a world-space mask entry `{ left, top, w, h, sat }` under
// the world rect `rect` ({ left, top, right, bottom }), whole texels.
export function maskTexelsIn(entry, rect) {
    const x0 = Math.max(0, Math.floor(rect.left - entry.left));
    const y0 = Math.max(0, Math.floor(rect.top - entry.top));
    const x1 = Math.min(entry.w, Math.ceil(rect.right - entry.left));
    const y1 = Math.min(entry.h, Math.ceil(rect.bottom - entry.top));
    if (x1 <= x0 || y1 <= y0) return 0;
    const stride = entry.w + 1;
    const sat = entry.sat;
    return sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];
}

/**
 * foreign(rect): true when `rect` (world) covers >= 12 px² of any foreign
 * mask — every entry whose `type` is not `ownType` (other landmarks, the
 * World Ash). At zoom z one texel is z² px².
 */
export function foreignArea(rect, entries, ownType) {
    let texels = 0;
    for (const entry of entries || []) {
        if (!entry || entry.type === ownType) continue;
        if (rect.right <= entry.left || rect.left >= entry.left + entry.w
            || rect.bottom <= entry.top || rect.top >= entry.top + entry.h) continue;
        texels += maskTexelsIn(entry, rect);
    }
    return texels;
}

export function isForeignRect(rect, entries, ownType, zoom = 1) {
    const z = Number(zoom) > 0 ? Number(zoom) : 1;
    return foreignArea(rect, entries, ownType) * z * z >= FOREIGN_MIN_PX2;
}

// A world mask entry for an alpha mask placed with its top-left at
// (left, top). `type` names the owner (a building type, or 'world-ash').
export function worldMaskEntry(type, mask, w, h, left, top) {
    if (!mask || !(w > 0) || !(h > 0) || mask.length < w * h) return null;
    return { type, left, top, w, h, sat: maskIntegral(mask, w, h) };
}

// The world ash's resting top-left in world space: its tile (scenery.js
// WORLD_TREE) projected, minus the sheet anchor.
export function worldAshOrigin(anchor = WORLD_ASH_ANCHOR) {
    const foot = tileToWorld(WORLD_TREE.tileX, WORLD_TREE.tileY);
    return { left: Math.round(foot.x - anchor[0]), top: Math.round(foot.y - anchor[1]) };
}

// An alpha mask (1 = alpha > 16, the AssetManager threshold) read from a
// drawable image once, or null without a DOM canvas (Node tests pass masks).
export function alphaMaskFromImage(image) {
    const w = image?.width | 0;
    const h = image?.height | 0;
    if (!(w > 0) || !(h > 0)) return null;
    let canvas = null;
    if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
    if (!ctx) return null;
    try {
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 16 ? 1 : 0;
        return mask;
    } catch {
        return null;
    }
}

// The sign anchor of `building` in world space, or null (no authored sign).
export function signWorldPoint(type, center, anchor) {
    const at = getBuildingSignAnchor(type);
    if (!at || !center || !Array.isArray(anchor)) return null;
    return {
        x: Math.round(center.x - anchor[0]) + at[0],
        y: Math.round(center.y - anchor[1]) + at[1],
        at,
    };
}

// ─── Carved Motifs ───────────────────────────────────────────────────────────

const CARVED_CELL = 16;
// The baked cell's anchor is [8, 14]: the cell's origin is one row above and
// eight columns left of `sign.at`, so its arm runs along sign.y and its board
// fills `signBoxFor(at)` exactly.
export const CARVED_CELL_OFFSET = Object.freeze([-8, -1]);
// Joined dynamically until the W4 integrator merges the manifest entry for
// the baked sheet (as InspectionGlass does for its rim stamp): no manifest
// entry, no resident sheet, so the bracket draws its recipe pixels.
export const CARVED_MOTIF_SHEET_ID = 'prop.carvedMotifs';
export const CARVED_MOTIF_ORDER = Object.freeze(BUILDING_DEFS.map((building) => building.type));
const CARVED_INK = '#060402';
const TALLY_WALNUT = ART_RAMPS.timber[0];
const TALLY_BRASS = ART_RAMPS.trimGold[1];
export const TALLY_PIP_MAX = 5;
// The tally plate hangs one texel under the board's ink rim.
const TALLY_GAP = 2;

// The baker's recipe (scripts/sprites/bake-carved-motifs.mjs `paintCell`),
// as `{ x, y, color }` texels of one 16 × 16 cell. Cached per type.
const carvedCellCache = new Map();

export function carvedMotifTexels(type) {
    if (carvedCellCache.has(type)) return carvedCellCache.get(type);
    const padded = EVENT_SHAPES[`district-${type}`];
    if (!padded) {
        carvedCellCache.set(type, null);
        return null;
    }
    const cell = new Array(CARVED_CELL * CARVED_CELL).fill(null);
    const set = (x, y, color) => {
        if (x < 0 || y < 0 || x >= CARVED_CELL || y >= CARVED_CELL) return;
        cell[y * CARVED_CELL + x] = color;
    };
    const SLATE = ART_RAMPS.slate;
    const TIMBER = ART_RAMPS.timber;
    const OCHRE = ART_RAMPS.clothOchre;
    const GOLD_MID = ART_RAMPS.trimGold[1];
    // 1. Wrought-iron flange, the 2-texel arm, its scroll tip, the knee and
    //    the two hanging rings.
    for (let y = 1; y <= 6; y++) set(1, y, y <= 3 ? SLATE[2] : SLATE[1]);
    for (let x = 2; x <= 13; x++) {
        set(x, 1, SLATE[2]);
        set(x, 2, SLATE[1]);
    }
    set(14, 1, SLATE[1]);
    set(2, 3, SLATE[1]);
    set(5, 3, SLATE[2]);
    set(10, 3, SLATE[2]);
    // 2. The 10 × 10 walnut-framed board, lit top/left rim, shaded bottom/right.
    for (let y = 4; y <= 13; y++) {
        for (let x = 3; x <= 12; x++) {
            const rim = y === 4 || y === 13 || x === 3 || x === 12;
            if (rim) set(x, y, (y === 4 || x === 3) ? TIMBER[2] : TIMBER[0]);
            else set(x, y, TIMBER[1]);
        }
    }
    set(5, 4, SLATE[1]);
    set(10, 4, SLATE[1]);
    // 3. The 8 × 8 district emblem in bas-relief brass and ochre.
    const grid = padded.slice(4, 12).map((row) => row.slice(4, 12));
    const bit = (gx, gy) => gx >= 0 && gx < 8 && gy >= 0 && gy < 8 && grid[gy][gx] === '1';
    for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
            if (!bit(gx, gy)) continue;
            const litEdge = !bit(gx, gy - 1) || !bit(gx - 1, gy);
            const shadeEdge = !bit(gx, gy + 1) && !bit(gx + 1, gy);
            let tone = OCHRE[1];
            if (litEdge && gy <= 3) tone = GOLD_MID;
            else if (shadeEdge) tone = OCHRE[0];
            set(4 + gx, 5 + gy, tone);
        }
    }
    // 4. The selective 1-texel ink: every empty texel 4-adjacent to mass.
    const opaque = (x, y) => x >= 0 && y >= 0 && x < CARVED_CELL && y < CARVED_CELL && cell[y * CARVED_CELL + x] !== null;
    const ink = [];
    for (let y = 0; y < CARVED_CELL; y++) {
        for (let x = 0; x < CARVED_CELL; x++) {
            if (opaque(x, y)) continue;
            if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) ink.push([x, y]);
        }
    }
    for (const [x, y] of ink) set(x, y, CARVED_INK);
    const texels = [];
    for (let y = 0; y < CARVED_CELL; y++) {
        for (let x = 0; x < CARVED_CELL; x++) {
            const color = cell[y * CARVED_CELL + x];
            if (color) texels.push({ x, y, color });
        }
    }
    const frozen = Object.freeze(texels);
    carvedCellCache.set(type, frozen);
    return frozen;
}

// Horizontal runs of one colour, the fewest fills for a texel list.
function texelRuns(texels) {
    const runs = [];
    let current = null;
    for (const { x, y, color } of texels) {
        if (current && current.y === y && current.color === color && current.x + current.w === x) {
            current.w++;
            continue;
        }
        current = { x, y, w: 1, color };
        runs.push(current);
    }
    return runs;
}

const carvedRunCache = new Map();
function carvedMotifRuns(type) {
    if (carvedRunCache.has(type)) return carvedRunCache.get(type);
    const texels = carvedMotifTexels(type);
    const runs = texels ? Object.freeze(texelRuns(texels)) : null;
    carvedRunCache.set(type, runs);
    return runs;
}

// 3 × 5 pixel numerals, brass on walnut (no font, no text call).
export const PIXEL_DIGITS = Object.freeze({
    0: ['###', '#.#', '#.#', '#.#', '###'],
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['###', '..#', '###', '#..', '###'],
    3: ['###', '..#', '.##', '..#', '###'],
    4: ['#.#', '#.#', '###', '..#', '..#'],
    5: ['###', '#..', '###', '..#', '###'],
    6: ['###', '#..', '###', '#.#', '###'],
    7: ['###', '..#', '.#.', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'],
    9: ['###', '#.#', '###', '..#', '###'],
});

/**
 * The live tally plate under a sign as `{ w, h, rects }` (rects relative to
 * the plate's top-left, `{ x, y, w, h, color }`): a walnut plate with a
 * one-texel ink rim; one 2 × 2 brass pip per agent, 1 apart, up to five;
 * from six the exact count in 3 × 5 brass numerals. Null at zero.
 */
export function carvedTallyRects(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return null;
    const rects = [];
    let innerW;
    let innerH;
    if (n <= TALLY_PIP_MAX) {
        innerW = n * 3 - 1;
        innerH = 2;
    } else {
        const digits = String(n);
        innerW = digits.length * 4 - 1;
        innerH = 5;
    }
    // rim 1 + walnut pad 1 on every side
    const w = innerW + 4;
    const h = innerH + 4;
    rects.push({ x: 0, y: 0, w, h, color: CARVED_INK });
    rects.push({ x: 1, y: 1, w: w - 2, h: h - 2, color: TALLY_WALNUT });
    if (n <= TALLY_PIP_MAX) {
        for (let i = 0; i < n; i++) rects.push({ x: 2 + i * 3, y: 2, w: 2, h: 2, color: TALLY_BRASS, pip: true });
    } else {
        const digits = String(n);
        for (let d = 0; d < digits.length; d++) {
            const glyph = PIXEL_DIGITS[digits[d]];
            for (let row = 0; row < 5; row++) {
                let start = -1;
                for (let col = 0; col <= 3; col++) {
                    const on = col < 3 && glyph[row][col] === '#';
                    if (on && start < 0) start = col;
                    if (!on && start >= 0) {
                        rects.push({ x: 2 + d * 4 + start, y: 2 + row, w: col - start, h: 1, color: TALLY_BRASS, digit: true });
                        start = -1;
                    }
                }
            }
        }
    }
    return { w, h, rects, pips: n <= TALLY_PIP_MAX ? n : 0, numeral: n > TALLY_PIP_MAX ? String(n) : '' };
}

/**
 * Draws one Carved Motif bracket in world space at the sign anchor `(x, y)`
 * (world texels, whole), with the live `tally` under it. `grade` (a C2
 * light grade, or null where the pass is graded afterwards) tones every ink.
 * `image` is the resident `prop.carvedMotifs` sheet, used only when no grade
 * must be applied per ink. Returns true when a tally was painted.
 */
export function drawCarvedMotifBracket(ctx, { x, y, type, tally = 0, grade = null, image = null }) {
    if (!ctx || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const ox = Math.round(x) + CARVED_CELL_OFFSET[0];
    const oy = Math.round(y) + CARVED_CELL_OFFSET[1];
    const tone = grade ? (color) => gradeTone(color, grade) : (color) => color;
    const frame = CARVED_MOTIF_ORDER.indexOf(type);
    ctx.save();
    ctx.globalAlpha = 1;
    if (!grade && image && frame >= 0 && image.width >= (frame + 1) * CARVED_CELL) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, frame * CARVED_CELL, 0, CARVED_CELL, CARVED_CELL, ox, oy, CARVED_CELL, CARVED_CELL);
    } else {
        const runs = carvedMotifRuns(type);
        if (runs) {
            for (const run of runs) {
                ctx.fillStyle = tone(run.color);
                ctx.fillRect(ox + run.x, oy + run.y, run.w, 1);
            }
        }
    }
    let painted = false;
    const plate = carvedTallyRects(tally);
    if (plate) {
        const box = signBoxFor([Math.round(x), Math.round(y)]);
        const left = Math.round(x) - Math.floor(plate.w / 2);
        const top = box.top + box.h + TALLY_GAP - 1;
        for (const rect of plate.rects) {
            ctx.fillStyle = tone(rect.color);
            ctx.fillRect(left + rect.x, top + rect.y, rect.w, rect.h);
        }
        painted = true;
    }
    ctx.restore();
    return painted;
}

// The world rect a bracket and its tally can paint (for column clipping and
// visibility): the cell plus the widest tally plate.
export function carvedBracketBounds(x, y, tally = 0) {
    const ox = Math.round(x) + CARVED_CELL_OFFSET[0];
    const oy = Math.round(y) + CARVED_CELL_OFFSET[1];
    const plate = carvedTallyRects(tally);
    let left = ox;
    let right = ox + CARVED_CELL;
    let bottom = oy + CARVED_CELL;
    if (plate) {
        const box = signBoxFor([Math.round(x), Math.round(y)]);
        const plateLeft = Math.round(x) - Math.floor(plate.w / 2);
        left = Math.min(left, plateLeft);
        right = Math.max(right, plateLeft + plate.w);
        bottom = Math.max(bottom, box.top + box.h + TALLY_GAP - 1 + plate.h);
    }
    return { left, top: oy, right, bottom };
}
