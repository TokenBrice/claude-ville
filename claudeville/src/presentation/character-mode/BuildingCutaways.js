// Wave 5-B — Lifted-Roof Bayer Cutaways & Living Interiors (§5.1–5.3).
//
// Pure state machines, deterministic Bayer peel masks, and integer pixel-art
// interior painters for:
//   - 4-Layer Bayer Cutaway Peel (`CutawayPeelController`, `buildBayerPeelMask`)
//   - §5.1 Command — Miniature War Table (`buildCommandWarTableState`, `drawCommandWarTable`)
//   - §5.2 Archive — 5 Repo Directory Bays & Compaction Shelf (`buildArchiveCutawayState`, `drawArchiveCutaway`)
//   - §5.3 Harbor — Chart Loft (`buildHarborCutawayState`, `drawHarborCutaway`)
//
// Postcard safety: this module never invokes `fillText` or `strokeText`.
// Overflow counts on Archive and Harbor use integer 3x5 pixel numeral stamps
// (`fillRect`). Sill-bar strings are returned as data and gated strictly on
// `!postcardFrame()` before calling an optional `paintText` delegate.

import { ART_RAMPS, PENNANT_PALETTE } from '../../config/artPalette.js';
import { BUILDING_DEFS, normalizeBuildingType } from '../../config/buildings.js';
import { classifyTool } from '../../domain/services/ToolIdentity.js';
import {
    APERTURE_GLASS_DWELL_MS,
    APERTURE_LAYERS_3,
    APERTURE_LAYERS_4,
    APERTURE_MIN_ZOOM,
    normalizeApertureLayers,
} from './BuildingApertureModel.js';
import { postcardFrame } from './Postcard.js';
import { buildingCenterToWorld } from './Projection.js';
import { repoProfile } from '../shared/RepoColor.js';

// The layer stacks and the 300 ms Glass dwell are BuildingApertureModel's
// (`APERTURE_LAYERS_*`, `APERTURE_GLASS_DWELL_MS`): one definition each.
export const CUTAWAY_LAYERS_4 = APERTURE_LAYERS_4;
export const CUTAWAY_LAYERS_3 = APERTURE_LAYERS_3;
export const CUTAWAY_MIN_ZOOM = APERTURE_MIN_ZOOM; // 2
export const BAYER_PEEL_STEP_MS = 150;
export const BAYER_PEEL_STEPS = 4;
export const BAYER_PEEL_TOTAL_MS = BAYER_PEEL_STEP_MS * BAYER_PEEL_STEPS; // 600 ms

// Canonical 4x4 Bayer rank matrix (row-major, ranks 0..15; matches CoastBake
// and Spec 01 §3).
export const BAYER_4X4 = Object.freeze([
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
]);

export const WAR_TABLE_MAX_PAWNS = 8;
export const ARCHIVE_BAY_COUNT = 5;
export const ARCHIVE_NAMED_BAY_COUNT = 4;
export const ARCHIVE_MAX_SPINES = 12;
export const HARBOR_MAX_LANTERNS = 4;

const PIXEL_OUTLINE_INK = '#0e0906';
const SILL_PLATE_BG = '#1c130c';
const SILL_BRASS_RULE = '#b8893f';

// 3x5 pixel-art bitmap stamps for digits and '+', rendered exclusively with
// `fillRect` (zero Canvas text calls, safe under `withPostcardFrame`).
export const PIXEL_NUMERAL_GLYPHS = Object.freeze({
    '0': Object.freeze(['111', '101', '101', '101', '111']),
    '1': Object.freeze(['010', '110', '010', '010', '111']),
    '2': Object.freeze(['111', '001', '111', '100', '111']),
    '3': Object.freeze(['111', '001', '111', '001', '111']),
    '4': Object.freeze(['101', '101', '111', '001', '001']),
    '5': Object.freeze(['111', '100', '111', '001', '111']),
    '6': Object.freeze(['111', '100', '111', '101', '111']),
    '7': Object.freeze(['111', '001', '001', '010', '010']),
    '8': Object.freeze(['111', '101', '111', '101', '111']),
    '9': Object.freeze(['111', '101', '111', '001', '111']),
    '+': Object.freeze(['000', '010', '111', '010', '000']),
});

/**
 * Draw a pixel-art numeral stamp (digits and optional leading '+') using pure
 * integer `fillRect` calls. Never emits Canvas text calls.
 */
export function drawPixelNumeral(ctx, text, x, y, {
    color = ART_RAMPS.trimGold[3],
    outline = PIXEL_OUTLINE_INK,
    scale = 1,
} = {}) {
    if (!ctx) return { width: 0, height: 0 };
    const value = String(text ?? '');
    const s = Math.max(1, Math.round(scale));
    let cursorX = Math.round(x);
    const startX = cursorX;
    const baseY = Math.round(y);
    for (const ch of value) {
        const glyph = PIXEL_NUMERAL_GLYPHS[ch];
        if (!glyph) continue;
        if (outline) {
            ctx.fillStyle = outline;
            for (let row = 0; row < 5; row++) {
                for (let col = 0; col < 3; col++) {
                    if (glyph[row][col] !== '1') continue;
                    ctx.fillRect(cursorX + (col - 1) * s, baseY + (row - 1) * s, s * 3, s * 3);
                }
            }
        }
        ctx.fillStyle = color;
        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 3; col++) {
                if (glyph[row][col] !== '1') continue;
                ctx.fillRect(cursorX + col * s, baseY + row * s, s, s);
            }
        }
        cursorX += 4 * s;
    }
    return { width: Math.max(0, cursorX - startX - s), height: 5 * s };
}

// ─── Cutaway profiles (§5.1, §5.2, §5.3) ─────────────────────────────────────

export const COMMAND_CUTAWAY_PROFILE = Object.freeze({
    buildingType: 'command',
    minZoom: CUTAWAY_MIN_ZOOM,
    layers: CUTAWAY_LAYERS_4,
    cut: Object.freeze({ x0: 228, x1: 312, top: 181, bottom: 219, slope: -0.52 }),
    legend: Object.freeze({ at: Object.freeze([228, 222]), w: 84, rowH: 8, maxScreenPxAtZ2: 168 }),
    occupant: Object.freeze({ h: 24 }),
    table: Object.freeze({
        center: Object.freeze([270, 184]),
        width: 26,
        height: 10,
        slope: -0.52,
    }),
    slots: Object.freeze([
        Object.freeze({ id: 'front-desk', bay: 'front-desk', at: Object.freeze([246, 202]), pose: 'tinker', facing: 'south-east' }),
        Object.freeze({ id: 'war-table', bay: 'table', at: Object.freeze([270, 190]), pose: 'think', facing: 'south-east' }),
        Object.freeze({ id: 'rear-desk', bay: 'rear-desk', at: Object.freeze([294, 177]), pose: 'gaze', facing: 'south-east' }),
    ]),
});

export const ARCHIVE_CUTAWAY_PROFILE = Object.freeze({
    buildingType: 'archive',
    minZoom: CUTAWAY_MIN_ZOOM,
    layers: CUTAWAY_LAYERS_4,
    // Covers all 5 ground lancets (x 95..181.5) and 5 clerestory lancets along
    // the nave wall at slope +0.50.
    cut: Object.freeze({ x0: 88, x1: 200, top: 82, bottom: 196, slope: 0.5 }),
    legend: Object.freeze({ at: Object.freeze([88, 206]), w: 112, rowH: 8 }),
    occupant: Object.freeze({ h: 24 }),
    bays: Object.freeze([
        Object.freeze({ index: 0, lancetAt: Object.freeze([95, 152]), at: Object.freeze([95, 164]), lecternAt: Object.freeze([95, 164]) }),
        Object.freeze({ index: 1, lancetAt: Object.freeze([115.5, 160.5]), at: Object.freeze([115.5, 172.5]), lecternAt: Object.freeze([115.5, 172.5]) }),
        Object.freeze({ index: 2, lancetAt: Object.freeze([137.5, 172]), at: Object.freeze([137.5, 184]), lecternAt: Object.freeze([137.5, 184]) }),
        Object.freeze({ index: 3, lancetAt: Object.freeze([159.5, 183]), at: Object.freeze([159.5, 195]), lecternAt: Object.freeze([159.5, 195]) }),
        Object.freeze({ index: 4, lancetAt: Object.freeze([181.5, 195]), at: Object.freeze([181.5, 207]), lecternAt: Object.freeze([181.5, 207]), fallback: true }),
    ]),
    // The cabinet stands on the floor in front of bay 0's bookcase, its
    // shelf sheared on the nave wall's +0.5 slope (a spine steps half a texel
    // down per texel along), wholly inside x0..x1.
    compactionShelf: Object.freeze({
        at: Object.freeze([92, 140]),
        spineWidth: 2,
        spineHeight: 6,
        gap: 1,
        slope: 0.5,
        maxSpines: ARCHIVE_MAX_SPINES,
    }),
    // The Loom of Days hangs on the back wall (Wave 6 weaves the panel): a
    // 96 x 72 panel downsampled to 48 x 36, sheared on the +0.5 wall slope.
    // `destRect` anchors the baked iron hooks on aperture.png; `mountOffset`
    // shifts the hanging frame 2 px down/inward so its top-right corner clears
    // the wall-plate beam cleanly. Nothing is painted until a panel exists.
    loomWall: Object.freeze({
        sourceWidth: 96,
        sourceHeight: 72,
        slope: 0.5,
        destRect: Object.freeze({ x: 113, y: 98, width: 48, height: 36 }),
        mountOffset: Object.freeze({ x: 0, y: 2 }),
    }),
});

// The Chart Loft under the oriel's slate hood: a sheared parallelogram on the
// oriel's own SE-facing wall slope (-0.5, rising to the right) that holds the
// whole hood, so the lifted `roof.png` is the entire hood and window wall.
// Rows are counted on the wall: a texel's wall row is `y + 0.5 * (x - x0)`;
// the back wall runs from the cut's top (row 90) to the floor line (row
// 113), the plank floor below it to the sill (row 122, clear of the sign).
export const HARBOR_CUTAWAY_PROFILE = Object.freeze({
    buildingType: 'harbor',
    minZoom: CUTAWAY_MIN_ZOOM,
    layers: CUTAWAY_LAYERS_4,
    cut: Object.freeze({ x0: 133, x1: 167, top: 90, bottom: 122, slope: -0.5 }),
    floor: Object.freeze({ at: Object.freeze([133, 113]), slope: -0.5 }),
    occupant: Object.freeze({ h: 20 }),
    // Occupants stand on the plank floor beside their furniture, never on it:
    // the ledger clerk in front of the wall desk, the navigator left of the
    // chart table.
    slots: Object.freeze([
        Object.freeze({ id: 'chartTable', bay: 'chart-table', at: Object.freeze([152, 110]), pose: 'think', facing: 'south-east' }),
        Object.freeze({ id: 'ledgerDesk', bay: 'ledger-desk', at: Object.freeze([143, 114]), pose: 'tinker', facing: 'south-west' }),
    ]),
    // Furniture tops the live painter draws (centre of the sheared top).
    chartTable: Object.freeze({ at: Object.freeze([161, 101]), width: 10, depth: 3 }),
    ledgerDesk: Object.freeze({ at: Object.freeze([137, 106]), width: 7, depth: 2 }),
    // The pending-commit lantern rack on the back wall: a beam stepping up
    // the wall slope from `at`, four lanterns under it, then the `+N`
    // overflow stamp (up to `+99`), all inside the cut.
    signalRack: Object.freeze({
        at: Object.freeze([135, 95]),
        slope: -0.5,
        spacing: 3,
        lanternWidth: 2,
        lanternHeight: 4,
        maxLanterns: HARBOR_MAX_LANTERNS,
        maxOverflow: 99,
    }),
});

export const BUILDING_CUTAWAY_PROFILES = Object.freeze({
    command: COMMAND_CUTAWAY_PROFILE,
    archive: ARCHIVE_CUTAWAY_PROFILE,
    harbor: HARBOR_CUTAWAY_PROFILE,
});

// ─── 4-Layer Bayer Cutaway Peel State Machine ────────────────────────────────

/**
 * Pure deterministic integer Bayer peel mask (`Uint8Array(width * height)`).
 * Values are strictly `1` (keep roof texel) or `0` (peeled away) — zero
 * smooth alpha fades.
 *
 * Step progression across every 4x4 cell:
 *   step 0 -> 16/16 (100% roof)
 *   step 1 -> 12/16 (75% roof)
 *   step 2 ->  8/16 (50% roof)
 *   step 3 ->  4/16 (25% roof)
 *   step 4 ->  0/16 (0% roof, fully peeled)
 */
export function buildBayerPeelMask(width, height, step) {
    const w = Math.trunc(Number(width));
    const h = Math.trunc(Number(height));
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
        throw new RangeError(`buildBayerPeelMask requires positive integer dimensions, got ${width}x${height}`);
    }
    const clampedStep = Math.max(0, Math.min(BAYER_PEEL_STEPS, Math.trunc(Number(step) || 0)));
    const threshold = clampedStep * 4; // 0, 4, 8, 12, 16
    const mask = new Uint8Array(w * h);
    if (threshold >= 16) return mask;
    if (threshold <= 0) {
        mask.fill(1);
        return mask;
    }
    for (let y = 0; y < h; y++) {
        const rowShift = (y & 3) << 2;
        const rowOffset = y * w;
        for (let x = 0; x < w; x++) {
            const rank = BAYER_4X4[rowShift | (x & 3)];
            mask[rowOffset + x] = rank >= threshold ? 1 : 0;
        }
    }
    return mask;
}

/**
 * Apply a discrete Bayer peel step to an RGBA roof buffer with zero smooth
 * alpha interpolation: kept texels preserve exact source RGBA bytes, peeled
 * texels become `[0, 0, 0, 0]`.
 */
export function applyBayerPeelToRgba(roofRgba, width, height, step) {
    const mask = buildBayerPeelMask(width, height, step);
    const out = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < mask.length; p++) {
        if (mask[p] !== 1) continue;
        const o = p * 4;
        out[o] = roofRgba[o];
        out[o + 1] = roofRgba[o + 1];
        out[o + 2] = roofRgba[o + 2];
        out[o + 3] = roofRgba[o + 3];
    }
    return out;
}

export class CutawayPeelController {
    constructor({
        minZoom = CUTAWAY_MIN_ZOOM,
        glassDwellMs = APERTURE_GLASS_DWELL_MS,
        stepMs = BAYER_PEEL_STEP_MS,
        steps = BAYER_PEEL_STEPS,
    } = {}) {
        this.minZoom = minZoom;
        this.glassDwellMs = glassDwellMs;
        this.stepMs = stepMs;
        this.steps = steps;
        this.reset();
    }

    reset() {
        this._buildingId = null;
        this._layers = CUTAWAY_LAYERS_4;
        this._hasRoofPeel = true;
        this._state = 'closed';
        this._trigger = null;
        this._step = 0;
        this._dwellBuildingId = null;
        this._dwellStartMs = null;
        this._transitionStartMs = null;
        this._transitionOriginStep = 0;
        this._lastNow = 0;
    }

    update({
        buildingId = null,
        selected = false,
        zoom = 1,
        glassHover = false,
        now = 0,
        reducedMotion = false,
        layers = CUTAWAY_LAYERS_4,
        minZoom = this.minZoom,
    } = {}) {
        const t = Number.isFinite(Number(now)) ? Number(now) : 0;
        this._lastNow = t;

        const targetId = buildingId ? String(buildingId) : null;
        const stack = normalizeApertureLayers(layers);
        const layerSpec = stack
            ? { layers: stack.layers, hasRoofPeel: stack.hasRoof }
            : { layers: CUTAWAY_LAYERS_4, hasRoofPeel: true };

        // Track continuous Glass dwell on the same building.
        let dwellMs = 0;
        if (glassHover && targetId) {
            if (this._dwellBuildingId !== targetId || this._dwellStartMs === null) {
                this._dwellBuildingId = targetId;
                this._dwellStartMs = t;
            }
            dwellMs = Math.max(0, t - this._dwellStartMs);
        } else {
            this._dwellBuildingId = null;
            this._dwellStartMs = null;
        }

        // Both triggers need inspection zoom: The Glass never opens a
        // cutaway below z 2, however long it dwells (R8).
        const atZoom = Number(zoom) >= minZoom;
        const selectionTrigger = Boolean(targetId && selected && atZoom);
        const glassTrigger = Boolean(targetId && glassHover && atZoom && dwellMs >= this.glassDwellMs);
        const trigger = selectionTrigger ? 'selection' : (glassTrigger ? 'glass-dwell' : null);

        // Switching target building resets any prior peel cleanly.
        if (targetId && this._buildingId && targetId !== this._buildingId) {
            this._step = 0;
            this._state = 'closed';
            this._transitionStartMs = null;
            this._transitionOriginStep = 0;
        }

        if (trigger) {
            this._buildingId = targetId;
            this._layers = layerSpec.layers;
            this._hasRoofPeel = layerSpec.hasRoofPeel;
            this._trigger = trigger;

            if (reducedMotion || !this._hasRoofPeel) {
                this._step = this.steps;
                this._state = 'open';
                this._transitionStartMs = t;
                this._transitionOriginStep = this.steps;
            } else {
                if (this._state !== 'opening' && this._state !== 'open') {
                    this._state = 'opening';
                    this._transitionStartMs = t;
                    this._transitionOriginStep = this._step;
                }
                const elapsed = Math.max(0, t - (this._transitionStartMs ?? t));
                const advanced = Math.floor(elapsed / this.stepMs);
                this._step = Math.min(this.steps, this._transitionOriginStep + advanced);
                this._state = this._step >= this.steps ? 'open' : 'opening';
            }
        } else {
            this._trigger = null;
            if (this._step === 0 || reducedMotion || !this._hasRoofPeel) {
                this._step = 0;
                this._state = 'closed';
                this._transitionStartMs = null;
                this._transitionOriginStep = 0;
                if (!targetId) this._buildingId = null;
            } else {
                if (this._state !== 'closing') {
                    this._state = 'closing';
                    this._transitionStartMs = t;
                    this._transitionOriginStep = this._step;
                }
                const elapsed = Math.max(0, t - (this._transitionStartMs ?? t));
                const retreated = Math.floor(elapsed / this.stepMs);
                this._step = Math.max(0, this._transitionOriginStep - retreated);
                if (this._step <= 0) {
                    this._step = 0;
                    this._state = 'closed';
                    this._transitionStartMs = null;
                    this._transitionOriginStep = 0;
                }
            }
        }

        const elapsedMs = this._transitionStartMs === null ? 0 : Math.max(0, t - this._transitionStartMs);
        return this.snapshot({ dwellMs, elapsedMs });
    }

    snapshot({ dwellMs = 0, elapsedMs = 0 } = {}) {
        const roofCoverage = (this.steps - this._step) / this.steps;
        const isOpen = this._state === 'opening' || this._state === 'open' || this._step > 0;
        const visibleLayers = [];
        if (this._hasRoofPeel) {
            if (isOpen) {
                visibleLayers.push(...this._layers.slice(1));
                if (this._step < this.steps) visibleLayers.push('roof');
            }
        } else if (isOpen) {
            visibleLayers.push(...this._layers);
        }
        return {
            buildingId: this._buildingId,
            layers: this._layers,
            hasRoofPeel: this._hasRoofPeel,
            state: this._state,
            trigger: this._trigger,
            step: this._step,
            roofCoverage,
            visibleLayers,
            isOpen,
            fullyOpen: this._step >= this.steps,
            dwellMs,
            elapsedMs,
        };
    }
}

// ─── §5.1 Command — Miniature War Table ──────────────────────────────────────

/**
 * Exact island landmark dot projection from real building world centers (§5.1):
 *   tx = round((x + 864) / 1440 * 25)
 *   ty = round((y - 352) / 600 * 9)
 */
export function projectWarTableDot(x, y) {
    return {
        tx: Math.round(((Number(x) + 864) / 1440) * 25),
        ty: Math.round(((Number(y) - 352) / 600) * 9),
    };
}

function buildWarTableLandmarks() {
    const map = {};
    for (const def of BUILDING_DEFS) {
        const center = buildingCenterToWorld({
            position: { tileX: def.x, tileY: def.y },
            width: def.width,
            height: def.height,
        });
        const { tx, ty } = projectWarTableDot(center.x, center.y);
        map[def.type] = Object.freeze({
            type: def.type,
            label: def.shortLabel || def.label,
            worldCenter: Object.freeze({ x: center.x, y: center.y }),
            tx,
            ty,
        });
    }
    return Object.freeze(map);
}

export const WAR_TABLE_LANDMARKS = buildWarTableLandmarks();

export function warTableTexelToSprite(tx, ty, table = COMMAND_CUTAWAY_PROFILE.table) {
    const dx = tx - (table.width - 1) / 2;
    const dy = ty - (table.height - 1) / 2;
    return {
        x: Math.round(table.center[0] + dx),
        y: Math.round(table.center[1] + dy + dx * table.slope),
    };
}

/**
 * Single 11 px Command sill bar line (§5.1):
 * e.g. `3 WORKING · 1 WAITING · +2` (fits 168 px at z2).
 */
export function formatCommandSillBar({ working = 0, waiting = 0, overflow = 0 } = {}) {
    const w = Math.max(0, Math.floor(Number(working) || 0));
    const wait = Math.max(0, Math.floor(Number(waiting) || 0));
    const extra = Math.max(0, Math.floor(Number(overflow) || 0));
    const base = `${w} WORKING · ${wait} WAITING`;
    return extra > 0 ? `${base} · +${extra}` : base;
}

function isLiveChild(child) {
    if (!child || typeof child !== 'object') return false;
    if (child.returned === true || child.departed === true || child.alive === false) return false;
    const status = String(child.status || '').toLowerCase();
    return status !== 'returned' && status !== 'departed' && status !== 'removed';
}

function isErroredChild(child) {
    if (!child || typeof child !== 'object') return false;
    if (child.errored === true) return true;
    const status = String(child.status || '').toLowerCase();
    return status === 'error' || status === 'errored';
}

function childIdOf(child) {
    return String(child?.agentId || child?.id || '');
}

function liveChildrenForLead(lead, allAgents) {
    const leadId = childIdOf(lead);
    const collected = [];
    const seen = new Set();
    const pushIfLive = (candidate) => {
        if (!isLiveChild(candidate)) return;
        const cid = childIdOf(candidate);
        if (!cid || cid === leadId || seen.has(cid)) return;
        seen.add(cid);
        collected.push(candidate);
    };
    if (Array.isArray(lead?.children)) {
        for (const child of lead.children) pushIfLive(child);
    }
    if (leadId && Array.isArray(allAgents)) {
        for (const agent of allAgents) {
            if (!agent) continue;
            const parentId = String(agent.parentSessionId || agent.rootSessionId || agent.leadId || '');
            if (parentId === leadId) pushIfLive(agent);
        }
    }
    return collected;
}

function resolveLandmarkForAgent(agent, buildingLookup) {
    const raw = (typeof buildingLookup === 'function' ? buildingLookup(agent) : null)
        || agent?.building
        || agent?.currentBuilding
        || agent?.targetBuilding
        || null;
    const type = normalizeBuildingType(raw);
    return type && WAR_TABLE_LANDMARKS[type] ? WAR_TABLE_LANDMARKS[type] : null;
}

/**
 * Build pure presentation state for Command's Miniature War Table (§5.1).
 *
 * One table, one muster: the first presented lead with live children owns the
 * table; up to 8 live child pawns stand on their real building dots (3x5
 * upright, or 5x3 prone on error; returned children removed). Remaining pawns
 * and other leads are counted in the single-line sill bar.
 */
export function buildCommandWarTableState({
    presentedSessions = [],
    allAgents = [],
    buildingLookup = null,
    maxPawns = WAR_TABLE_MAX_PAWNS,
    table = COMMAND_CUTAWAY_PROFILE.table,
} = {}) {
    const cap = Math.max(0, Math.floor(Number(maxPawns) || 0));
    const sessions = Array.isArray(presentedSessions) ? presentedSessions : [];
    const agents = Array.isArray(allAgents) ? allAgents : [];

    let ownerLead = null;
    let ownerChildren = [];
    let otherLeadsWithChildren = 0;
    const crews = [];

    for (const session of sessions) {
        const kids = liveChildrenForLead(session, agents);
        if (!kids.length) continue;
        crews.push(kids);
        if (!ownerLead) {
            ownerLead = session;
            ownerChildren = kids;
        } else {
            otherLeadsWithChildren++;
        }
    }

    // The sill bar counts the people the hall presents: every presented
    // session and every mustered crew (the table's and the leads beyond it),
    // each once, by its resolved status (a lead waiting on its crew in Poll
    // is still a working session).
    let workingCount = 0;
    let waitingCount = 0;
    const counted = new Set();
    const tally = (entry, preferFlags) => {
        const id = childIdOf(entry);
        if (id && counted.has(id)) return;
        if (id) counted.add(id);
        const status = String(entry?.status || '').toLowerCase();
        const isWorking = (preferFlags && entry?.working === true) || status === 'working';
        const isWaiting = !isWorking && ((preferFlags && entry?.waiting === true)
            || status === 'waiting' || status === 'waiting_on_user');
        if (isWorking) workingCount++;
        if (isWaiting) waitingCount++;
    };
    for (const session of sessions) tally(session, true);
    for (const crew of crews) for (const child of crew) tally(child, false);

    const allPawns = [];
    for (const child of ownerChildren) {
        const landmark = resolveLandmarkForAgent(child, buildingLookup);
        if (!landmark) continue;
        const errored = isErroredChild(child);
        const spritePos = warTableTexelToSprite(landmark.tx, landmark.ty, table);
        allPawns.push({
            agentId: childIdOf(child),
            building: landmark.type,
            tx: landmark.tx,
            ty: landmark.ty,
            spriteX: spritePos.x,
            spriteY: spritePos.y,
            width: errored ? 5 : 3,
            height: errored ? 3 : 5,
            orientation: errored ? 'prone' : 'upright',
            errored,
            trimColor: child.trimColor || child.modelTrim || child.color || ART_RAMPS.trimGold[2],
            outlineColor: PIXEL_OUTLINE_INK,
        });
    }

    const pawns = allPawns.slice(0, cap);
    const pawnOverflow = Math.max(0, allPawns.length - pawns.length);
    const sillOverflow = pawnOverflow + otherLeadsWithChildren;
    const sillBar = formatCommandSillBar({
        working: workingCount,
        waiting: waitingCount,
        overflow: sillOverflow,
    });

    return {
        table,
        landmarks: Object.values(WAR_TABLE_LANDMARKS),
        ownerLeadId: ownerLead ? childIdOf(ownerLead) : null,
        totalLiveChildren: allPawns.length,
        pawns,
        pawnOverflow,
        otherLeadsWithChildren,
        workingCount,
        waitingCount,
        sillOverflow,
        sillBar,
    };
}

/**
 * Paint Command's Miniature War Table (sheared 26x10 tabletop, 9 landmark dots,
 * up to 8 pixel pawns, and postcard-gated sill bar).
 */
export function drawCommandWarTable(ctx, state, {
    localPoint = (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
    paintText = null,
} = {}) {
    if (!ctx || !state) return { drawnPawns: 0, sillBarDrawn: false };
    const table = state.table || COMMAND_CUTAWAY_PROFILE.table;

    // 1. Sheared 26x10 tabletop parallelogram (column-by-column integer steps).
    const halfW = (table.width - 1) / 2;
    const halfH = (table.height - 1) / 2;
    for (let col = 0; col < table.width; col++) {
        const dx = col - halfW;
        const shear = dx * table.slope;
        const x = Math.round(table.center[0] + dx);
        const topY = Math.round(table.center[1] - halfH + shear);
        const p = localPoint(x, topY);
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(p.x, p.y - 1, 1, table.height + 2);
        ctx.fillStyle = (col === 0 || col === table.width - 1) ? ART_RAMPS.timber[1] : ART_RAMPS.timber[2];
        ctx.fillRect(p.x, p.y, 1, table.height);
        ctx.fillStyle = ART_RAMPS.plaza[1];
        if (col >= 1 && col <= table.width - 2) {
            ctx.fillRect(p.x, p.y + 1, 1, Math.max(1, table.height - 2));
        }
    }

    // 2. Nine 1-texel landmark dots.
    ctx.fillStyle = ART_RAMPS.ashlar[8];
    for (const landmark of state.landmarks || []) {
        const sp = warTableTexelToSprite(landmark.tx, landmark.ty, table);
        const p = localPoint(sp.x, sp.y);
        ctx.fillRect(p.x, p.y, 1, 1);
    }

    // 3. Up to 8 pawns (3x5 upright or 5x3 prone on error).
    const pawns = (state.pawns || []).slice(0, WAR_TABLE_MAX_PAWNS);
    for (const pawn of pawns) {
        const p = localPoint(pawn.spriteX, pawn.spriteY);
        const pw = pawn.width;
        const ph = pawn.height;
        const left = p.x - Math.floor(pw / 2);
        const top = p.y - ph + 1;
        // 1px dark silhouette outline.
        ctx.fillStyle = pawn.outlineColor || PIXEL_OUTLINE_INK;
        ctx.fillRect(left - 1, top - 1, pw + 2, ph + 2);
        // Trim body.
        ctx.fillStyle = pawn.trimColor || ART_RAMPS.trimGold[2];
        ctx.fillRect(left, top, pw, ph);
        // Specular cap pip (head on upright 3x5, side cap on prone 5x3).
        ctx.fillStyle = ART_RAMPS.ashlar[8];
        if (pawn.orientation === 'prone') {
            ctx.fillRect(left, top + 1, 1, 1);
        } else {
            ctx.fillRect(left + 1, top, 1, 1);
        }
    }

    // 4. Sill bar (strictly gated off during postcardFrame()).
    let sillBarDrawn = false;
    if (!postcardFrame() && state.sillBar) {
        const legend = COMMAND_CUTAWAY_PROFILE.legend;
        const origin = localPoint(legend.at[0], legend.at[1]);
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(origin.x - 1, origin.y - 1, legend.w + 2, legend.rowH + 2);
        ctx.fillStyle = SILL_PLATE_BG;
        ctx.fillRect(origin.x, origin.y, legend.w, legend.rowH);
        ctx.fillStyle = SILL_BRASS_RULE;
        ctx.fillRect(origin.x, origin.y, legend.w, 1);
        if (typeof paintText === 'function') {
            paintText(ctx, state.sillBar, origin.x + 2, origin.y + legend.rowH - 1, {
                maxWidth: legend.w - 4,
                fontPx: 11,
                color: ART_RAMPS.trimGold[3],
            });
        }
        sillBarDrawn = true;
    }

    return { drawnPawns: pawns.length, sillBarDrawn };
}

// ─── §5.2 Archive — 5 Repo Directory Bays & Compaction Shelf ────────────────

/**
 * Exact FNV-1a + murmur3 fmix32 avalanche used by `RepoColor.js`.
 */
export function hashDirectoryName(input) {
    const text = String(input || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/**
 * Extract the top-level directory segment from a repo-relative workingSet path.
 * Root files without a directory return `null` (routed to the 5th fallback bay).
 */
export function topLevelDirectoryOf(filePath) {
    const raw = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!raw) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return parts[0];
}

/**
 * Assign top-level directory names into Archive's 5 bays (§5.2):
 *   - Bays 0..3: named top-level directories via stable hash (`hash % 4`) with
 *     deterministic hash-order linear probing (same strategy as `RepoColor`).
 *   - Bay 4 (5th bay): always `"everything else"`.
 */
export function assignArchiveBays(directories = []) {
    const unique = [...new Set(
        (Array.isArray(directories) ? directories : [])
            .map((dir) => String(dir || '').trim())
            .filter(Boolean),
    )];

    const ordered = unique
        .map((name) => ({ name, hash: hashDirectoryName(name) }))
        .sort((a, b) => (a.hash - b.hash) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const slots = [null, null, null, null];
    const dirToBay = new Map();
    const overflowDirectories = [];

    for (const { name, hash } of ordered) {
        const home = hash % ARCHIVE_NAMED_BAY_COUNT;
        let placed = -1;
        for (let step = 0; step < ARCHIVE_NAMED_BAY_COUNT; step++) {
            const candidate = (home + step) % ARCHIVE_NAMED_BAY_COUNT;
            if (slots[candidate] === null) {
                placed = candidate;
                break;
            }
        }
        if (placed >= 0) {
            slots[placed] = name;
            dirToBay.set(name, placed);
        } else {
            overflowDirectories.push(name);
            dirToBay.set(name, ARCHIVE_NAMED_BAY_COUNT);
        }
    }

    const bays = ARCHIVE_CUTAWAY_PROFILE.bays.map((geom, index) => ({
        index,
        lancetAt: geom.lancetAt,
        at: geom.at,
        lecternAt: geom.lecternAt,
        directory: index < ARCHIVE_NAMED_BAY_COUNT ? slots[index] : null,
        label: index < ARCHIVE_NAMED_BAY_COUNT ? (slots[index] || '') : 'everything else',
        isFallback: index === ARCHIVE_NAMED_BAY_COUNT,
    }));

    return {
        bays,
        dirToBay,
        overflowDirectories,
    };
}

function newestWorkingSetPath(agent) {
    const list = agent?.workingSet;
    if (!Array.isArray(list) || !list.length) return null;
    let bestPath = null;
    let bestTime = -Infinity;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (typeof item === 'string' && item.trim()) {
            // Later array items win when timestamps are absent.
            if (bestTime <= i) {
                bestTime = i;
                bestPath = item.trim();
            }
        } else if (item && typeof item === 'object') {
            const p = String(item.path || item.file || '').trim();
            if (!p) continue;
            const ts = Number(item.updatedAt ?? item.timestamp ?? item.at ?? i);
            const rank = Number.isFinite(ts) ? ts : i;
            if (rank >= bestTime) {
                bestTime = rank;
                bestPath = p;
            }
        }
    }
    return bestPath;
}

function isSameLocalDay(timestampMs, referenceDate) {
    const ms = Number(timestampMs);
    if (!Number.isFinite(ms)) return false;
    const d = new Date(ms);
    return d.getFullYear() === referenceDate.getFullYear()
        && d.getMonth() === referenceDate.getMonth()
        && d.getDate() === referenceDate.getDate();
}

function resolveBusiestRepo(agents) {
    const counts = new Map();
    for (const agent of agents) {
        const repo = String(agent?.repoRoot || agent?.projectPath || agent?.repo || '').trim();
        if (!repo) continue;
        counts.set(repo, (counts.get(repo) || 0) + 1);
    }
    let bestRepo = null;
    let bestCount = -1;
    for (const [repo, count] of counts.entries()) {
        if (count > bestCount || (count === bestCount && repo < bestRepo)) {
            bestRepo = repo;
            bestCount = count;
        }
    }
    return bestRepo;
}

/**
 * Build pure state for Archive's 5 Repo Directory Bays, Compaction Shelf,
 * and Loom of Days wall hook (§5.2).
 */
export function buildArchiveCutawayState({
    agents = [],
    directories = null,
    busiestRepo = null,
    compactions = [],
    chronicleEvents = [],
    now = new Date(Date.now()),
    loomPanel = null,
} = {}) {
    const refDate = now instanceof Date ? now : new Date(now);
    const readerAgents = Array.isArray(agents) ? agents : [];
    const repo = busiestRepo || resolveBusiestRepo(readerAgents);

    // Gather top-level directories from explicit list or busiest repo's workingSets.
    const dirList = [];
    if (Array.isArray(directories)) {
        dirList.push(...directories);
    } else {
        for (const agent of readerAgents) {
            const agentRepo = String(agent?.repoRoot || agent?.projectPath || agent?.repo || '').trim();
            if (repo && agentRepo && agentRepo !== repo) continue;
            for (const entry of Array.isArray(agent?.workingSet) ? agent.workingSet : []) {
                const p = typeof entry === 'string' ? entry : (entry?.path || entry?.file || '');
                const top = topLevelDirectoryOf(p);
                if (top) dirList.push(top);
            }
        }
    }

    const bayAssignment = assignArchiveBays(dirList);

    // Position each reader at the bay of its newest workingSet path.
    const readers = readerAgents.map((agent) => {
        const newestPath = newestWorkingSetPath(agent);
        const topDir = topLevelDirectoryOf(newestPath);
        const bayIndex = topDir && bayAssignment.dirToBay.has(topDir)
            ? bayAssignment.dirToBay.get(topDir)
            : ARCHIVE_NAMED_BAY_COUNT;
        const bay = bayAssignment.bays[bayIndex];
        return {
            agentId: childIdOf(agent),
            bayIndex,
            directory: topDir,
            newestPath,
            at: bay.at,
            lecternAt: bay.lecternAt,
        };
    });

    // Compaction shelf: merge `compactions[]` and `compacted` Chronicle events
    // occurring today (cleared at local midnight), capped at 12 spines.
    const todayCompactions = [];
    const seenKeys = new Set();
    const collectCompaction = (item) => {
        if (!item || typeof item !== 'object') return;
        const ts = item.timestamp ?? item.at ?? item.time;
        if (!isSameLocalDay(ts, refDate)) return;
        const agentId = String(item.agentId || item.sessionId || '');
        const dedupeKey = item.id ? `id:${item.id}` : `${agentId}@${ts}`;
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);
        todayCompactions.push({
            id: item.id || dedupeKey,
            agentId,
            timestamp: Number(ts),
            trimColor: item.trimColor || item.modelTrim || item.color || ART_RAMPS.trimGold[1],
            width: ARCHIVE_CUTAWAY_PROFILE.compactionShelf.spineWidth,
            height: ARCHIVE_CUTAWAY_PROFILE.compactionShelf.spineHeight,
        });
    };

    for (const c of Array.isArray(compactions) ? compactions : []) collectCompaction(c);
    for (const ev of Array.isArray(chronicleEvents) ? chronicleEvents : []) {
        const kind = String(ev?.kind || '').toLowerCase();
        if (kind === 'compacted') collectCompaction(ev);
    }
    todayCompactions.sort((a, b) => a.timestamp - b.timestamp);

    const maxSpines = ARCHIVE_CUTAWAY_PROFILE.compactionShelf.maxSpines;
    const spines = todayCompactions.slice(0, maxSpines);
    const spineOverflow = Math.max(0, todayCompactions.length - spines.length);

    return {
        busiestRepo: repo,
        bays: bayAssignment.bays,
        dirToBay: bayAssignment.dirToBay,
        overflowDirectories: bayAssignment.overflowDirectories,
        readers,
        compactionShelf: {
            ...ARCHIVE_CUTAWAY_PROFILE.compactionShelf,
            totalToday: todayCompactions.length,
            spines,
            overflow: spineOverflow,
        },
        loomWall: {
            ...ARCHIVE_CUTAWAY_PROFILE.loomWall,
            panel: loomPanel || null,
        },
        // Bay names are text: strictly gated to sill bar / READ / The Glass.
        bayNames: bayAssignment.bays.map((bay) => bay.label).filter(Boolean),
    };
}

/**
 * The sheared footprint of the Compaction Shelf: spine `i`'s top-left and the
 * `+N` stamp's origin, stepping down the nave wall's +0.5 slope.
 */
export function archiveShelfGeometry(shelf = ARCHIVE_CUTAWAY_PROFILE.compactionShelf) {
    const sw = shelf.spineWidth || 2;
    const stepX = sw + (shelf.gap ?? 1);
    const slope = Number(shelf.slope) || 0;
    const [ax, ay] = shelf.at;
    const rise = (x) => Math.round(slope * (x - ax));
    const spineAt = (i) => {
        const x = ax + 1 + i * stepX;
        return { x, y: ay + rise(x) };
    };
    const boardX1 = ax + ARCHIVE_MAX_SPINES * stepX + 1;
    const stampX = boardX1 + 2;
    return { sw, sh: shelf.spineHeight || 6, stepX, slope, rise, spineAt, boardX0: ax, boardX1, stamp: { x: stampX, y: ay + rise(stampX) + 1 } };
}

const ARCHIVE_LOOM_DOWNSAMPLE_CACHE = new WeakMap();

function loomBandBoundsForRow(y, srcH) {
    if (srcH === 72) {
        if (y < 2) return [0, 1];
        if (y < 12) return [2, 11];
        if (y < 60) return [12, 59];
        if (y < 70) return [60, 69];
        return [70, 71];
    }
    return [0, srcH - 1];
}

/**
 * Crisp pixel-art-preserving 2x2 downsampler for the Archive rear-wall Loom
 * panel (96x72 -> 48x36). Within each source block, picks the exact source
 * texel with highest local contrast against its band-clamped 4x4 neighborhood
 * (with a chroma tie-breaker) so actor silhouettes, stamps, `+N` numerals,
 * pennants, and bare-warp threads stay legible without blended anti-aliasing.
 * Grading-invariant across day, dusk, and C2 night lighting.
 */
export function downsampleLoomPanel2x(srcData, srcW, srcH, dstW = 48, dstH = 36) {
    const w = Math.max(1, Math.trunc(Number(dstW) || 48));
    const h = Math.max(1, Math.trunc(Number(dstH) || 36));
    const sw = Math.max(1, Math.trunc(Number(srcW) || 96));
    const sh = Math.max(1, Math.trunc(Number(srcH) || 72));
    const out = new Uint8ClampedArray(w * h * 4);
    if (!srcData || srcData.length < sw * sh * 4) return out;

    for (let dy = 0; dy < h; dy++) {
        const sy0 = Math.floor((dy * sh) / h);
        const sy1 = Math.max(sy0 + 1, Math.min(sh, Math.floor(((dy + 1) * sh) / h)));
        const [bandMinY, bandMaxY] = loomBandBoundsForRow(sy0, sh);
        const ny0 = Math.max(bandMinY, sy0 - 1);
        const ny1 = Math.min(bandMaxY, sy1);

        for (let dx = 0; dx < w; dx++) {
            const sx0 = Math.floor((dx * sw) / w);
            const sx1 = Math.max(sx0 + 1, Math.min(sw, Math.floor(((dx + 1) * sw) / w)));
            const dstOffset = (dy * w + dx) * 4;

            // Gather opaque pixels in the 2x2 block and test fast-path uniformity.
            let firstO = -1;
            let uniform = true;
            let opaqueCount = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                const rowBase = sy * sw * 4;
                for (let sx = sx0; sx < sx1; sx++) {
                    const o = rowBase + sx * 4;
                    if (srcData[o + 3] <= 0) continue;
                    opaqueCount += 1;
                    if (firstO < 0) {
                        firstO = o;
                    } else if (
                        srcData[o] !== srcData[firstO]
                        || srcData[o + 1] !== srcData[firstO + 1]
                        || srcData[o + 2] !== srcData[firstO + 2]
                    ) {
                        uniform = false;
                    }
                }
            }
            if (opaqueCount === 0) continue;
            if (uniform) {
                out[dstOffset] = srcData[firstO];
                out[dstOffset + 1] = srcData[firstO + 1];
                out[dstOffset + 2] = srcData[firstO + 2];
                out[dstOffset + 3] = srcData[firstO + 3];
                continue;
            }

            // Compute band-clamped local 4x4 neighborhood mean RGB.
            const nx0 = Math.max(0, sx0 - 1);
            const nx1 = Math.min(sw - 1, sx1);
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            let nCount = 0;
            for (let ny = ny0; ny <= ny1; ny++) {
                const nRow = ny * sw * 4;
                for (let nx = nx0; nx <= nx1; nx++) {
                    const no = nRow + nx * 4;
                    if (srcData[no + 3] <= 0) continue;
                    sumR += srcData[no];
                    sumG += srcData[no + 1];
                    sumB += srcData[no + 2];
                    nCount += 1;
                }
            }
            const meanR = nCount > 0 ? sumR / nCount : 128;
            const meanG = nCount > 0 ? sumG / nCount : 128;
            const meanB = nCount > 0 ? sumB / nCount : 128;

            // Pick the highest-contrast actual source texel (zero color blending).
            let bestO = firstO;
            let bestScore = -1;
            for (let sy = sy0; sy < sy1; sy++) {
                const rowBase = sy * sw * 4;
                for (let sx = sx0; sx < sx1; sx++) {
                    const o = rowBase + sx * 4;
                    if (srcData[o + 3] <= 0) continue;
                    const r = srcData[o];
                    const g = srcData[o + 1];
                    const b = srcData[o + 2];
                    const dr = r - meanR;
                    const dg = g - meanG;
                    const db = b - meanB;
                    const contrast2 = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
                    const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
                    const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
                    const chroma = maxC - minC;
                    const score = contrast2 + chroma * chroma * 0.25;
                    if (score > bestScore) {
                        bestScore = score;
                        bestO = o;
                    }
                }
            }

            out[dstOffset] = srcData[bestO];
            out[dstOffset + 1] = srcData[bestO + 1];
            out[dstOffset + 2] = srcData[bestO + 2];
            out[dstOffset + 3] = srcData[bestO + 3];
        }
    }

    return out;
}

function createLoomDownsampleCanvas(width, height, rgba) {
    let canvas = null;
    if (globalThis.document?.createElement) {
        canvas = globalThis.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
    } else if (typeof globalThis.OffscreenCanvas === 'function') {
        canvas = new globalThis.OffscreenCanvas(width, height);
    }
    const cctx = canvas?.getContext?.('2d');
    if (!cctx) return null;
    if (typeof cctx.putImageData === 'function' && typeof ImageData === 'function') {
        cctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        return canvas;
    }
    if (typeof cctx.fillRect === 'function') {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const o = (y * width + x) * 4;
                if (rgba[o + 3] <= 0) continue;
                cctx.fillStyle = `#${((1 << 24) | (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]).toString(16).slice(1)}`;
                cctx.fillRect(x, y, 1, 1);
            }
        }
        return canvas;
    }
    return null;
}

function resolveDownsampledLoomSurface(panel, srcW, srcH, dstW, dstH, wantCanvas) {
    const version = Number(panel?._cvPixelVersion) || 0;
    const key = `${srcW}x${srcH}->${dstW}x${dstH}|v${version}`;
    const cached = ARCHIVE_LOOM_DOWNSAMPLE_CACHE.get(panel);
    if (cached && cached.key === key && (!wantCanvas || cached.canvas)) {
        return cached;
    }

    let srcData = null;
    if (panel?.data && panel.data.length >= srcW * srcH * 4 && typeof panel.getContext !== 'function') {
        srcData = panel.data;
    } else if (typeof panel?.getContext === 'function') {
        try {
            const pctx = panel.getContext('2d');
            if (typeof pctx?.getImageData === 'function') {
                const img = pctx.getImageData(0, 0, srcW, srcH);
                if (img?.data?.length >= srcW * srcH * 4) srcData = img.data;
            }
        } catch {
            srcData = null;
        }
        if (!srcData && panel?._loomRgba?.data?.length >= srcW * srcH * 4) {
            srcData = panel._loomRgba.data;
        }
    }
    if (!srcData) return null;

    const data = downsampleLoomPanel2x(srcData, srcW, srcH, dstW, dstH);
    const canvas = wantCanvas ? createLoomDownsampleCanvas(dstW, dstH, data) : null;
    const entry = { key, width: dstW, height: dstH, data, canvas };
    if (panel && typeof panel === 'object') ARCHIVE_LOOM_DOWNSAMPLE_CACHE.set(panel, entry);
    return entry;
}

/**
 * Paint Archive's interior: the Loom of Days panel (only once Wave 6 hands
 * one over, crisply downsampled to 48x36 and sheared on the +0.5 wall), the
 * Compaction Shelf (up to 12 2x6 spines along the same slope + pixel numeral
 * stamp for overflow), and strictly postcard-gated bay names (ONLY when
 * `showBayNames` is true AND `!postcardFrame()`). The lecterns are baked art
 * (`interior.png`), drawn over the readers.
 */
export function drawArchiveCutaway(ctx, state, {
    localPoint = (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
    showBayNames = false,
    paintText = null,
} = {}) {
    if (!ctx || !state) return { drawnSpines: 0, overflowStamped: false, bayNamesDrawn: false, loomDrawn: false };

    // 1. The Loom of Days: nothing until a panel exists; then the 96 x 72
    //    panel crisply downsampled to 48 x 36, shifted by `mountOffset` so its
    //    top-right corner clears the wall-plate beam cleanly, sheared one texel
    //    column at a time down the +0.5 rear-wall slope inside the cut mask.
    const loom = state.loomWall || ARCHIVE_CUTAWAY_PROFILE.loomWall;
    let loomDrawn = false;
    const panel = loom?.panel || null;
    const hasZeroDim = Boolean(panel && (panel.width === 0 || panel.height === 0));
    if (panel && !hasZeroDim) {
        const dest = loom.destRect;
        const mountOffset = loom.mountOffset || ARCHIVE_CUTAWAY_PROFILE.loomWall.mountOffset || { x: 0, y: 0 };
        const slope = Number(loom.slope) || 0;
        const srcW = Number(panel.width) > 0 ? Number(panel.width) : loom.sourceWidth;
        const srcH = Number(panel.height) > 0 ? Number(panel.height) : loom.sourceHeight;
        const scaleX = srcW / dest.width;
        const isRgbaBuffer = Boolean(panel.data && panel.data.length >= srcW * srcH * 4 && typeof panel.getContext !== 'function');
        const canDrawImage = !isRgbaBuffer && typeof ctx.drawImage === 'function';
        if (canDrawImage || isRgbaBuffer) {
            if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
            const top = localPoint(dest.x + (mountOffset.x || 0), dest.y + (mountOffset.y || 0));
            ctx.fillStyle = PIXEL_OUTLINE_INK;
            for (let col = -1; col <= dest.width; col++) {
                const y = top.y + Math.round(slope * col);
                ctx.fillRect(top.x + col, y - 1, 1, dest.height + 2);
            }
            const downsampled = resolveDownsampledLoomSurface(panel, srcW, srcH, dest.width, dest.height, canDrawImage);
            if (canDrawImage) {
                if (downsampled?.canvas) {
                    for (let col = 0; col < dest.width; col++) {
                        const y = top.y + Math.round(slope * col);
                        ctx.drawImage(downsampled.canvas, col, 0, 1, dest.height, top.x + col, y, 1, dest.height);
                    }
                } else {
                    for (let col = 0; col < dest.width; col++) {
                        const y = top.y + Math.round(slope * col);
                        ctx.drawImage(panel, Math.floor(col * scaleX), 0, 1, srcH, top.x + col, y, 1, dest.height);
                    }
                }
            } else {
                const data = downsampled?.data || downsampleLoomPanel2x(panel.data, srcW, srcH, dest.width, dest.height);
                for (let col = 0; col < dest.width; col++) {
                    const y0 = top.y + Math.round(slope * col);
                    let row = 0;
                    while (row < dest.height) {
                        const o = (row * dest.width + col) * 4;
                        const a = data[o + 3];
                        if (a <= 0) {
                            row += 1;
                            continue;
                        }
                        const r = data[o];
                        const g = data[o + 1];
                        const b = data[o + 2];
                        let run = 1;
                        while (row + run < dest.height) {
                            const no = ((row + run) * dest.width + col) * 4;
                            if (data[no + 3] <= 0 || data[no] !== r || data[no + 1] !== g || data[no + 2] !== b) break;
                            run += 1;
                        }
                        ctx.fillStyle = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
                        ctx.fillRect(top.x + col, y0 + row, 1, run);
                        row += run;
                    }
                }
            }
            loomDrawn = true;
        }
    }

    // 2. Compaction Shelf: the board and up to 12 spines down the +0.5 slope.
    const shelf = state.compactionShelf || {};
    const geometry = archiveShelfGeometry({ ...ARCHIVE_CUTAWAY_PROFILE.compactionShelf, ...shelf });
    const spines = (shelf.spines || []).slice(0, ARCHIVE_MAX_SPINES);
    const shelfY = shelf.at?.[1] ?? ARCHIVE_CUTAWAY_PROFILE.compactionShelf.at[1];
    for (let x = geometry.boardX0; x <= geometry.boardX1; x++) {
        const p = localPoint(x, shelfY + geometry.rise(x) + geometry.sh);
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(p.x, p.y, 1, 3);
        ctx.fillStyle = ART_RAMPS.timber[2];
        ctx.fillRect(p.x, p.y + 1, 1, 1);
    }
    for (let i = 0; i < spines.length; i++) {
        const spine = spines[i];
        const at = geometry.spineAt(i);
        const p = localPoint(at.x, at.y);
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(p.x - 1, p.y - 1, geometry.sw + 2, geometry.sh + 1);
        ctx.fillStyle = spine.trimColor || ART_RAMPS.trimGold[1];
        ctx.fillRect(p.x, p.y, geometry.sw, geometry.sh);
    }

    let overflowStamped = false;
    if ((shelf.overflow || 0) > 0) {
        const stamp = localPoint(geometry.stamp.x, geometry.stamp.y);
        drawPixelNumeral(ctx, `+${Math.min(99, shelf.overflow)}`, stamp.x, stamp.y, {
            color: ART_RAMPS.trimGold[3],
        });
        overflowStamped = true;
    }

    // 4. Bay names strictly gated to sill bar / READ / The Glass (NEVER in postcardFrame()).
    let bayNamesDrawn = false;
    if (showBayNames && !postcardFrame() && state.bayNames?.length) {
        const legend = ARCHIVE_CUTAWAY_PROFILE.legend;
        const origin = localPoint(legend.at[0], legend.at[1]);
        const line = state.bayNames.join(' · ');
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(origin.x - 1, origin.y - 1, legend.w + 2, legend.rowH + 2);
        ctx.fillStyle = SILL_PLATE_BG;
        ctx.fillRect(origin.x, origin.y, legend.w, legend.rowH);
        ctx.fillStyle = SILL_BRASS_RULE;
        ctx.fillRect(origin.x, origin.y, legend.w, 1);
        if (typeof paintText === 'function') {
            paintText(ctx, line, origin.x + 2, origin.y + legend.rowH - 1, {
                maxWidth: legend.w - 4,
                fontPx: 11,
                color: ART_RAMPS.ashlar[8],
            });
        }
        bayNamesDrawn = true;
    }

    return { drawnSpines: spines.length, overflowStamped, bayNamesDrawn, loomDrawn };
}

// ─── §5.3 Harbor — Chart Loft ────────────────────────────────────────────────

function classifiesToHarbor(agent, classifyToolFn) {
    if (!agent || typeof agent !== 'object') return false;
    if (agent.currentTool) {
        const result = classifyToolFn(agent.currentTool, agent.toolInput || agent.input || {});
        return result?.building === 'harbor';
    }
    return normalizeBuildingType(agent.building || agent.currentBuilding) === 'harbor';
}

function pendingCountOf(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    for (const key of ['pendingCommits', 'commits', 'count', 'pending']) {
        if (entry[key] !== undefined) return Math.max(0, Math.floor(Number(entry[key]) || 0));
    }
    return 1;
}

function repoColorForPending(entry, index) {
    if (typeof entry?.color === 'string' && entry.color) return entry.color;
    if (typeof entry?.accent === 'string' && entry.accent) return entry.accent;
    const key = entry?.repoRoot || entry?.projectPath || entry?.repo || entry?.name;
    if (key) return repoProfile(key).accent;
    return PENNANT_PALETTE[index % PENNANT_PALETTE.length];
}

/**
 * Build pure state for Harbor's Chart Loft (§5.3):
 *   - 2 agent slots (`chartTable` pose `think`, `ledgerDesk` pose `tinker`) for
 *     agents whose current tool classifies to Harbor.
 *   - Signal rack (no body): up to 4 hanging lanterns in each pending repo's
 *     pennant color + overflow count for pixel numeral stamp. Zero added text.
 */
export function buildHarborCutawayState({
    agents = [],
    harborPendingRepos = [],
    classifyToolFn = classifyTool,
} = {}) {
    const harborAgents = (Array.isArray(agents) ? agents : [])
        .filter((agent) => classifiesToHarbor(agent, classifyToolFn));

    const slots = HARBOR_CUTAWAY_PROFILE.slots.map((slotDef, index) => {
        const occupant = harborAgents[index] || null;
        return {
            id: slotDef.id,
            bay: slotDef.bay,
            at: slotDef.at,
            pose: slotDef.pose,
            facing: slotDef.facing,
            agentId: occupant ? childIdOf(occupant) : null,
            occupant,
        };
    });

    const pending = [];
    for (const entry of Array.isArray(harborPendingRepos) ? harborPendingRepos : []) {
        const commits = pendingCountOf(entry);
        if (commits <= 0) continue;
        pending.push({
            repo: String(entry.repoRoot || entry.projectPath || entry.repo || entry.name || `repo-${pending.length}`),
            pendingCommits: commits,
            color: repoColorForPending(entry, pending.length),
        });
    }

    const lanterns = pending.slice(0, HARBOR_MAX_LANTERNS);
    const lanternOverflow = Math.max(0, pending.length - lanterns.length);

    return {
        slots,
        slotOverflow: Math.max(0, harborAgents.length - slots.length),
        signalRack: {
            ...HARBOR_CUTAWAY_PROFILE.signalRack,
            totalPendingRepos: pending.length,
            lanterns,
            overflow: lanternOverflow,
        },
        hasText: false,
    };
}

/**
 * The signal rack's sheared footprint: the beam's row at a column, each
 * lantern's top-left, and the `+N` stamp origin (all on the wall slope).
 */
export function harborRackGeometry(rack = HARBOR_CUTAWAY_PROFILE.signalRack) {
    const slope = Number(rack.slope) || 0;
    const spacing = rack.spacing || 3;
    const beamWidth = Math.max(8, (rack.maxLanterns || HARBOR_MAX_LANTERNS) * spacing + 2);
    const [ax, ay] = rack.at;
    const beamY = (x) => ay + Math.round(slope * (x - ax));
    const x1 = ax + beamWidth - 1;
    const lanternAt = (i) => {
        const x = ax + 1 + i * spacing;
        return { x, y: beamY(x) + 2 };
    };
    const stampX = x1 + 3;
    return { slope, spacing, beamWidth, x0: ax, x1, beamY, lanternAt, stamp: { x: stampX, y: beamY(stampX) + 1 } };
}

// A sheared table top: `width` columns down the wall slope from its centre,
// `depth` rows each, outlined; `fill(col, row)` picks a colour.
function drawShearedTop(ctx, localPoint, { at, width, depth }, slope, fill) {
    const x0 = at[0] - Math.floor(width / 2);
    for (let col = -1; col <= width; col++) {
        const x = x0 + col;
        const y = at[1] + Math.round(slope * (x - at[0]));
        const p = localPoint(x, y);
        ctx.fillStyle = PIXEL_OUTLINE_INK;
        ctx.fillRect(p.x, p.y - 1, 1, depth + 2);
        if (col < 0 || col >= width) continue;
        for (let row = 0; row < depth; row++) {
            ctx.fillStyle = fill(col, row);
            ctx.fillRect(p.x, p.y + row, 1, 1);
        }
    }
}

/**
 * Paint Harbor's Chart Loft (zero text). `layer: 'wall'` is the signal rack
 * on the back wall (drawn before the occupants, who stand in front of it);
 * `layer: 'props'` the chart table and ledger desk tops (drawn after the
 * occupants and the baked legs); `'all'` both. The rack hangs up to 4
 * pennant-coloured lanterns, one per pending repo, and the `+N` stamp —
 * every texel inside the sheared cut.
 */
export function drawHarborCutaway(ctx, state, {
    localPoint = (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
    layer = 'all',
} = {}) {
    if (!ctx || !state) return { drawnLanterns: 0, overflowStamped: false };
    const profile = HARBOR_CUTAWAY_PROFILE;
    let drawnLanterns = 0;
    let overflowStamped = false;

    if (layer === 'all' || layer === 'wall') {
        const rack = { ...profile.signalRack, ...(state.signalRack || {}) };
        const geometry = harborRackGeometry(rack);
        const lanterns = (rack.lanterns || []).slice(0, HARBOR_MAX_LANTERNS);
        const lw = rack.lanternWidth || 2;
        const lh = rack.lanternHeight || 4;
        for (let x = geometry.x0 - 1; x <= geometry.x1 + 1; x++) {
            const p = localPoint(x, geometry.beamY(x));
            ctx.fillStyle = PIXEL_OUTLINE_INK;
            ctx.fillRect(p.x, p.y - 1, 1, 3);
            if (x < geometry.x0 || x > geometry.x1) continue;
            ctx.fillStyle = ART_RAMPS.slate[2];
            ctx.fillRect(p.x, p.y, 1, 1);
        }
        for (let i = 0; i < lanterns.length; i++) {
            const lantern = lanterns[i];
            const at = geometry.lanternAt(i);
            const p = localPoint(at.x, at.y);
            ctx.fillStyle = PIXEL_OUTLINE_INK;
            ctx.fillRect(p.x - 1, p.y - 1, lw + 2, lh + 2);
            ctx.fillStyle = lantern.color || PENNANT_PALETTE[i % PENNANT_PALETTE.length];
            ctx.fillRect(p.x, p.y, lw, lh);
            ctx.fillStyle = ART_RAMPS.emissive[2];
            ctx.fillRect(p.x, p.y + 1, 1, 1);
        }
        drawnLanterns = lanterns.length;
        if ((rack.overflow || 0) > 0) {
            const stamp = localPoint(geometry.stamp.x, geometry.stamp.y);
            drawPixelNumeral(ctx, `+${Math.min(rack.maxOverflow || 99, rack.overflow)}`, stamp.x, stamp.y, {
                color: ART_RAMPS.emissive[2],
            });
            overflowStamped = true;
        }
    }

    if (layer === 'all' || layer === 'props') {
        const slope = Number(profile.cut.slope) || 0;
        // Chart table: an oak top with a pinned sea chart.
        drawShearedTop(ctx, localPoint, profile.chartTable, slope, (col, row) => {
            if (col === 0 || col === profile.chartTable.width - 1) return ART_RAMPS.timber[2];
            if (row === profile.chartTable.depth - 1) return ART_RAMPS.timber[1];
            return (col + row) % 4 === 1 ? ART_RAMPS.shallowWater[1] : ART_RAMPS.sand[3];
        });
        // Ledger desk: a darker slant top with an open ledger.
        drawShearedTop(ctx, localPoint, profile.ledgerDesk, slope, (col, row) => {
            if (row === profile.ledgerDesk.depth - 1) return ART_RAMPS.timber[0];
            return col >= 2 && col <= 4 ? ART_RAMPS.sand[4] : ART_RAMPS.timber[1];
        });
    }

    return { drawnLanterns, overflowStamped };
}
