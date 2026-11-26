// Wave 3 Lane W3-C — Carried Artifacts, Report Cairn & Workflow Ribbons
// (Spec 04 §2.2, §2.4, §3.5).
//
// Pure code-drawn 6×6 pixel-art artifact stamps on ART_RAMPS / EFFECT_COLORS
// palette colors (row-string + cached tiny canvas grammar like
// CarriedLantern.js — zero gradients, zero arcs, zero generated art).
//
// Truthful by construction (V8):
// - Never draw any artifact on casual strolls, idle walks, or stale states.
// - Walking bodies at z >= 2 carry the artifact in the trailing hand (strictly
//   opposite CarriedLantern's facing hand) and suppress the floating tool glyph
//   via the one-of rule.
// - Standing bodies set the artifact down at x = -s*15..-s*9, bottom at y = +2.
// - Report cairns stand at x = -s*22..-s*17, bottom at y = +2, admitted via
//   MarkGovernor.reserve(rect, MarkTier.AMBIENT, 'cairn:' + id) with facing-side
//   fallback +s*17..+s*22, and show every exact unit up to 5 (5×14) or a single
//   5×6 bound bundle above 5 (never 5 units standing for "many").
// - Workflow ribbons key on workflowId, else provider:parentSessionId:workflowName
//   (never bare workflowName alone), capped at 2 concurrent ribbons per parent.

import { ART_RAMPS, EFFECT_COLORS } from '../../config/artPalette.js';
import { MarkTier } from './MarkGovernor.js';

export const ARTIFACT_SIZE = 6;
export const ARTIFACT_MIN_ZOOM = 1.6;
export const ARTIFACT_ONE_OF_ZOOM = 2;

// Mirror of LANTERN_SET_DOWN ({ x: 9, y: 2 }): for facing sign s (+1 east, -1 west),
// the set-down artifact spans x = -s*15 .. -s*9, bottom at y = +2.
export const ARTIFACT_SET_DOWN = Object.freeze({ minOffset: 9, maxOffset: 15, bottomY: 2 });

export const CAIRN_WIDTH = 5;
export const CAIRN_UNIT_STRIDE = 3;
export const CAIRN_MAX_EXACT_UNITS = 5;
export const CAIRN_MAX_EXACT_HEIGHT = 14; // 5 * 3 - 1 = 14 (5x14)
export const CAIRN_BUNDLE_WIDTH = 5;
export const CAIRN_BUNDLE_HEIGHT = 6;
export const CAIRN_MIN_OFFSET = 17;
export const CAIRN_MAX_OFFSET = 22;
export const CAIRN_BOTTOM_Y = 2;
export const CAIRN_VIEW_CAP = 6;
export const CAIRN_DOOR_ZONE_CAP = 2;

export const MAX_WORKFLOW_RIBBONS_PER_PARENT = 2;
export const WORKFLOW_LABEL_MAX_CHARS = 32;

export const ARTIFACT_KINDS = Object.freeze([
    'billet',
    'scroll',
    'letter',
    'proof',
    'brokenProof',
    'plan',
    'orders',
]);

// All stamp pixels come strictly from ART_RAMPS and EFFECT_COLORS.
const PALETTE = Object.freeze({
    // Iron / stone outline & body
    K: ART_RAMPS.stone[0],
    S: ART_RAMPS.stone[2],
    L: ART_RAMPS.stone[4],
    // Ember billet glow
    E: ART_RAMPS.emissive[0],
    G: ART_RAMPS.emissive[1],
    // Parchment / timber
    T: ART_RAMPS.timber[1],
    P: ART_RAMPS.sand[2],
    Q: ART_RAMPS.sand[4],
    // Cream / ivory
    C: ART_RAMPS.blossomIvory[3],
    I: ART_RAMPS.blossomIvory[2],
    W: EFFECT_COLORS.peak,
    // Wax seals & ink
    V: EFFECT_COLORS.magic[0],
    M: EFFECT_COLORS.magic[1],
    R: ART_RAMPS.clothCrimson[1],
    F: EFFECT_COLORS.failure,
    O: EFFECT_COLORS.failureOutline,
    // Brass / gold check & ribbon
    B: ART_RAMPS.trimGold[1],
    Y: ART_RAMPS.trimGold[2],
    // Slate plan lines
    N: ART_RAMPS.slate[0],
    U: ART_RAMPS.slate[2],
    A: ART_RAMPS.slate[3],
});

// Pure 6×6 row-string pixel art stamps (every row exactly 6 chars, 6 rows).
const ARTIFACT_ROWS = Object.freeze({
    // Ember iron billet (Edit / Write)
    billet: Object.freeze([
        '.KKKK.',
        'KSGGSK',
        'KGEESK',
        'KSEESK',
        'KSSSSK',
        '.KKKK.',
    ]),
    // Rolled parchment scroll (Read / Grep / Glob)
    scroll: Object.freeze([
        '.TTTT.',
        'TQQQQT',
        'TPPRPT',
        'TQQQQT',
        'TPPPPT',
        '.TTTT.',
    ]),
    // Violet-wax letter (Web / MCP)
    letter: Object.freeze([
        'KKKKKK',
        'KQQQQK',
        'KQVMPK',
        'KQMVPk'.replace('k', 'K'),
        'KPPPPK',
        'KKKKKK',
    ]),
    // Whole cream proof chit (exit 0 verified pass)
    proof: Object.freeze([
        '.KKKK.',
        'KWWWWK',
        'KWWYCK',
        'KWYBCK',
        'KCCCCK',
        '.KKKK.',
    ]),
    // Broken proof chit: 1, 2, or 3 visible edge notches + crack (exit != 0)
    brokenProof1: Object.freeze([
        '.KKK..',
        'KWWFK.',
        'KWWFCK',
        'KCCFCK',
        'KCCCCK',
        '.KKKK.',
    ]),
    brokenProof2: Object.freeze([
        '.KK...',
        'KWFK..',
        'KWWFC.',
        'KCCFK.',
        'KCCFK.',
        '.KKK..',
    ]),
    brokenProof3: Object.freeze([
        '.KK...',
        'KWF...',
        'KWFK..',
        '.KFC..',
        'KCFK..',
        '.KK...',
    ]),
    // Folded plan sheet (active plan / composing with plan)
    plan: Object.freeze([
        'NNNN..',
        'NCCUN.',
        'NCUCCN',
        'NCAACN',
        'NCCUCN',
        'NNNNNN',
    ]),
    // Sealed wax delegate orders (spawning / delegating subagent)
    orders: Object.freeze([
        '.TTTT.',
        'TQQQQT',
        'TQRYQT',
        'TQRRQT',
        'TPPPPT',
        '.TTTT.',
    ]),
});

// 5×6 bound report bundle (used when returned + outstanding > 5; never 5 units for "many").
const CAIRN_BUNDLE_ROWS = Object.freeze([
    '.TTT.',
    'TQQQT',
    'TBBBT',
    'TPPPT',
    'TBBBT',
    '.TTT.',
]);

const EDIT_WRITE_TOOLS = new Set([
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'edit_file',
    'write_file',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'apply_patch',
]);

const READ_SEARCH_TOOLS = new Set([
    'Read',
    'Grep',
    'Glob',
    'read_file',
    'view_file',
    'view_file_outline',
    'view_code_item',
    'grep_search',
    'find_by_name',
    'list_dir',
]);

const WEB_MCP_TOOLS = new Set([
    'WebFetch',
    'WebSearch',
    'search_web',
    'read_url_content',
]);

const DELEGATE_TOOLS = new Set([
    'Agent',
    'Task',
    'SendMessage',
    'invoke_subagent',
    'delegate_task',
    'spawn_agent',
    'send_message',
]);

const PLAN_TOOLS = new Set([
    'TodoWrite',
    'EnterPlanMode',
    'ExitPlanMode',
    'update_plan',
]);

const PROOF_FRESH_MS = 90_000;

const stampCache = new Map();
let bundleCanvasCache = null;

function clampNotches(notches) {
    const n = Math.round(Number(notches) || 1);
    return Math.max(1, Math.min(3, n));
}

function stampKey(kind, notches = 1) {
    if (kind === 'brokenProof') return `brokenProof${clampNotches(notches)}`;
    return kind;
}

/** Pure row-string lookup for any artifact stamp (always 6×6). */
export function artifactStampRows(kind, { notches = 1 } = {}) {
    const key = stampKey(kind, notches);
    return ARTIFACT_ROWS[key] || null;
}

/** Pure palette lookup for a row-string code. */
export function artifactPaletteColor(code) {
    return PALETTE[code] || null;
}

function paintRows(rows, colorFor) {
    if (typeof document === 'undefined' || !rows?.length) return null;
    const canvas = document.createElement('canvas');
    canvas.width = rows[0].length;
    canvas.height = rows.length;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        for (let x = 0; x < row.length; x++) {
            const colour = colorFor(row[x]);
            if (!colour) continue;
            ctx.fillStyle = colour;
            ctx.fillRect(x, y, 1, 1);
        }
    }
    return canvas;
}

/**
 * Cached 6×6 pixel-art canvas for a carried artifact stamp.
 * Returns null in headless Node environments without `document`, or for unknown kinds.
 */
export function carriedArtifactStamp(kind, { notches = 1 } = {}) {
    const key = stampKey(kind, notches);
    if (stampCache.has(key)) return stampCache.get(key);
    const rows = ARTIFACT_ROWS[key];
    if (!rows) return null;
    const canvas = paintRows(rows, code => PALETTE[code] || null);
    if (!canvas) return null;
    canvas.__cvGroundKey = `carried-artifact:${key}`;
    stampCache.set(key, canvas);
    return canvas;
}

/** Cached 5×6 bound report bundle canvas (for cairns with total > 5). */
export function reportCairnBundleStamp() {
    if (bundleCanvasCache) return bundleCanvasCache;
    const canvas = paintRows(CAIRN_BUNDLE_ROWS, code => PALETTE[code] || null);
    if (!canvas) return null;
    canvas.__cvGroundKey = 'report-cairn:bundle';
    bundleCanvasCache = canvas;
    return canvas;
}

function isWebOrMcpTool(toolName) {
    if (!toolName) return false;
    if (WEB_MCP_TOOLS.has(toolName)) return true;
    return toolName.startsWith('mcp__') || toolName.startsWith('mcp_');
}

function isStaleOrInactive(agent) {
    if (!agent || agent.isDeparted) return true;
    if (agent.signalStale === true) return true;
    const freshness = agent.freshness?.state;
    if (freshness === 'stale' || freshness === 'unavailable') return true;
    const status = String(agent.status || '').toLowerCase();
    if (!status || status === 'idle' || status === 'completed') return true;
    return false;
}

/**
 * Resolve which carried artifact an agent honestly holds right now, or null.
 * Never returns an artifact for casual strolls, idle walks, or stale states.
 */
export function resolveCarriedArtifact(agent, {
    casualStroll = false,
    idleWalk = false,
    mendLedger = null,
    now = Date.now(),
} = {}) {
    if (casualStroll || idleWalk || isStaleOrInactive(agent)) return null;

    const tool = String(agent.currentTool || agent.pendingTool || '').trim();

    // 1. Delegating / spawning subagents -> sealed wax orders.
    if (DELEGATE_TOOLS.has(tool)) {
        return { kind: 'orders', notches: 0 };
    }

    // 2. Plan tools or active plan mode without a concrete file/web tool -> folded plan sheet.
    if (PLAN_TOOLS.has(tool)) {
        return { kind: 'plan', notches: 0 };
    }

    // 3. Concrete tool legs.
    if (EDIT_WRITE_TOOLS.has(tool)) {
        return { kind: 'billet', notches: 0 };
    }
    if (READ_SEARCH_TOOLS.has(tool)) {
        return { kind: 'scroll', notches: 0 };
    }
    if (isWebOrMcpTool(tool)) {
        return { kind: 'letter', notches: 0 };
    }

    // 4. Recent verified shell result (proof chit / notched broken proof chit).
    const latest = Array.isArray(agent.lastResults) ? agent.lastResults[0] : null;
    if (latest && latest.exitCode !== null && latest.exitCode !== undefined && Number.isFinite(Number(latest.exitCode))) {
        const completedAt = Number(latest.completedAt);
        const fresh = !Number.isFinite(completedAt) || Math.abs(now - completedAt) <= PROOF_FRESH_MS;
        if (fresh) {
            const exitCode = Number(latest.exitCode);
            if (exitCode === 0) {
                return { kind: 'proof', notches: 0 };
            }
            const realFailure = latest.exitCodeSource === 'exit'
                || (latest.exitCodeSource === 'flag' && (agent.provider === 'omp' || agent.provider === 'kimi'));
            if (realFailure) {
                const streak = mendLedger && typeof mendLedger.failureStreakFor === 'function'
                    ? mendLedger.failureStreakFor(agent.id, { now })
                    : 1;
                return { kind: 'brokenProof', notches: clampNotches(streak || 1) };
            }
        }
    }

    // 5. Active plan while composing (working with plan mode or active todos, no tool leg).
    const status = String(agent.status || '').toLowerCase();
    if (status === 'working' && !tool) {
        const hasPlan = agent.permissionMode === 'plan'
            || (Array.isArray(agent.todos) && agent.todos.some(todo => todo?.status !== 'completed'));
        if (hasPlan) return { kind: 'plan', notches: 0 };
        if (Array.isArray(agent.backgroundPending?.kinds) && agent.backgroundPending.kinds.includes('agent')) {
            return { kind: 'orders', notches: 0 };
        }
    }

    return null;
}

/**
 * Spec 04 §2.2 — walking trailing-hand anchor (strictly opposite CarriedLantern's
 * facing hand). Uses `anchors.trailingWrist` from anchors.json when supplied,
 * else the body-box heuristic:
 *   x = bounds.minX + width * (west ? 0.72 : 0.28)
 *   y = bounds.minY + height * 0.62
 */
export function artifactWalkingAnchor({ bounds = null, west = false, anchors = null } = {}) {
    const wrist = anchors?.trailingWrist || (west ? anchors?.eastWrist : anchors?.westWrist) || null;
    if (wrist && Number.isFinite(Number(wrist.x)) && Number.isFinite(Number(wrist.y))) {
        return { x: Number(wrist.x), y: Number(wrist.y) };
    }
    const minX = Number(bounds?.minX) || 0;
    const minY = Number(bounds?.minY) || 0;
    const width = Number(bounds?.width ?? ((Number(bounds?.maxX) || 0) - minX)) || 0;
    const height = Number(bounds?.height ?? ((Number(bounds?.maxY) || 0) - minY)) || 0;
    return {
        x: minX + width * (west ? 0.72 : 0.28),
        y: minY + height * 0.62,
    };
}

/**
 * Spec 04 §2.2 — standing set-down rectangle in world texels.
 * For facing sign s = +1 (east) / -1 (west):
 *   x spans -s*15 .. -s*9 (east: [-15, -9]; west: [+9, +15]), bottom at y = +2.
 */
export function artifactSetDownRect({ footX = 0, footY = 0, west = false } = {}) {
    const s = west ? -1 : 1;
    const x0 = footX + Math.min(-s * ARTIFACT_SET_DOWN.maxOffset, -s * ARTIFACT_SET_DOWN.minOffset);
    const y0 = footY + ARTIFACT_SET_DOWN.bottomY - ARTIFACT_SIZE;
    return {
        x: Math.round(x0),
        y: Math.round(y0),
        w: ARTIFACT_SIZE,
        h: ARTIFACT_SIZE,
    };
}

/**
 * Spec 04 §2.4 — One-of rule: a body walking a real leg at z >= 2 shows its
 * carried artifact and NOT its tool glyph; the glyph returns when it stands.
 */
export function shouldSuppressToolGlyphForArtifact({ walking = false, zoom = 1, hasArtifact = false } = {}) {
    return Boolean(walking && Number(zoom) >= ARTIFACT_ONE_OF_ZOOM && hasArtifact);
}

/**
 * Spec 04 §2.4 — Zoom-tier & EFFECT_BUDGET['carried-artifacts'] admission,
 * nearest view centre first. Draws only at z >= 1.6 (DISTRICT / CLOSE).
 */
export function selectCarriedArtifacts(candidates, {
    budget = 48,
    zoom = 2,
    centre = null,
} = {}) {
    const cap = Math.max(0, Math.floor(Number(budget) || 0));
    if (cap <= 0 || Number(zoom) < ARTIFACT_MIN_ZOOM || !Array.isArray(candidates) || !candidates.length) {
        return [];
    }
    const cx = Number(centre?.x) || 0;
    const cy = Number(centre?.y) || 0;
    const eligible = [];
    for (const candidate of candidates) {
        if (!candidate || !candidate.artifact) continue;
        if (!Number.isFinite(Number(candidate.x)) || !Number.isFinite(Number(candidate.y))) continue;
        eligible.push({
            ...candidate,
            d: Math.hypot(Number(candidate.x) - cx, Number(candidate.y) - cy),
        });
    }
    eligible.sort((a, b) => a.d - b.d || String(a.id || '').localeCompare(String(b.id || '')));
    return eligible.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Report Cairn (Spec 04 §2.2)
// ---------------------------------------------------------------------------

/** Exact copy for hover, READ and The Glass (e.g. "7 back · 3 out"). */
export function formatCairnLabel(returned = 0, outstanding = 0) {
    const r = Math.max(0, Math.trunc(Number(returned) || 0));
    const o = Math.max(0, Math.trunc(Number(outstanding) || 0));
    if (r > 0 && o > 0) return `${r} back · ${o} out`;
    if (r > 0) return `${r} back`;
    if (o > 0) return `${o} out`;
    return '';
}

/**
 * Spec 04 §2.2 — Cairn exactness:
 * - returned + outstanding <= 5: exact mode, 5 texels wide, 3 texels/unit (max 5×14),
 *   every unit explicitly represented (returned filled scrolls sealed in child's model
 *   trim, followed by outstanding hollow chalk outlines).
 * - returned + outstanding > 5: bundle mode, ONE 5×6 bound bundle (never 5 units
 *   standing for "many") plus exact `label` ("7 back · 3 out") for hover/READ/Glass.
 */
export function reportCairnSpec({ returned = 0, outstanding = 0, returnedTrims = [] } = {}) {
    const r = Math.max(0, Math.trunc(Number(returned) || 0));
    const o = Math.max(0, Math.trunc(Number(outstanding) || 0));
    const total = r + o;
    if (total <= 0) return null;
    const label = formatCairnLabel(r, o);
    if (total > CAIRN_MAX_EXACT_UNITS) {
        return {
            mode: 'bundle',
            width: CAIRN_BUNDLE_WIDTH,
            height: CAIRN_BUNDLE_HEIGHT,
            returned: r,
            outstanding: o,
            total,
            units: [],
            label,
        };
    }
    const trims = Array.isArray(returnedTrims) ? returnedTrims : [];
    const units = [];
    for (let i = 0; i < r; i++) {
        units.push({
            state: 'returned',
            trim: typeof trims[i] === 'string' && trims[i] ? trims[i] : ART_RAMPS.trimGold[1],
        });
    }
    for (let i = 0; i < o; i++) {
        units.push({
            state: 'outstanding',
            trim: null,
        });
    }
    return {
        mode: 'exact',
        width: CAIRN_WIDTH,
        height: total * CAIRN_UNIT_STRIDE - 1,
        returned: r,
        outstanding: o,
        total,
        units,
        label,
    };
}

/**
 * Spec 04 §2.2 — Cairn admission via MarkGovernor.
 * Primary slot: x = -s*22 .. -s*17, bottom at y = +2.
 * Fallback slot (facing side): x = +s*17 .. +s*22, bottom at y = +2.
 * Returns null if both collide (count never moves to a different mark).
 */
export function admitReportCairn({
    id = '',
    footX = 0,
    footY = 0,
    west = false,
    returned = 0,
    outstanding = 0,
    returnedTrims = [],
    governor = null,
} = {}) {
    const spec = reportCairnSpec({ returned, outstanding, returnedTrims });
    if (!spec) return null;
    const s = west ? -1 : 1;
    const primaryLeft = Math.round(footX + Math.min(-s * CAIRN_MAX_OFFSET, -s * CAIRN_MIN_OFFSET));
    const fallbackLeft = Math.round(footX + Math.min(s * CAIRN_MIN_OFFSET, s * CAIRN_MAX_OFFSET));
    const top = Math.round(footY + CAIRN_BOTTOM_Y - spec.height);
    const primaryRect = { x: primaryLeft, y: top, w: spec.width, h: spec.height };
    const fallbackRect = { x: fallbackLeft, y: top, w: spec.width, h: spec.height };
    const key = `cairn:${id}`;

    if (governor && typeof governor.reserve === 'function') {
        if (governor.reserve(primaryRect, MarkTier.AMBIENT, key)) {
            return { ...spec, rect: primaryRect, side: 'trailing', key };
        }
        if (governor.reserve(fallbackRect, MarkTier.AMBIENT, key)) {
            return { ...spec, rect: fallbackRect, side: 'facing', key };
        }
        return null;
    }
    return { ...spec, rect: primaryRect, side: 'trailing', key };
}

/**
 * Draw an admitted report cairn on the world art-pixel grid (`fillRect` only).
 */
export function drawReportCairn(ctx, cairn) {
    if (!ctx || !cairn?.rect) return;
    const ox = Math.round(cairn.rect.x);
    const bottomY = Math.round(cairn.rect.y + cairn.rect.h);
    if (cairn.mode === 'bundle') {
        const stamp = reportCairnBundleStamp();
        if (stamp) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(stamp, ox, bottomY - CAIRN_BUNDLE_HEIGHT);
            return;
        }
        for (let y = 0; y < CAIRN_BUNDLE_ROWS.length; y++) {
            const row = CAIRN_BUNDLE_ROWS[y];
            for (let x = 0; x < row.length; x++) {
                const colour = PALETTE[row[x]];
                if (!colour) continue;
                ctx.fillStyle = colour;
                ctx.fillRect(ox + x, bottomY - CAIRN_BUNDLE_HEIGHT + y, 1, 1);
            }
        }
        return;
    }
    // Exact mode: bottom-up stack of units (each unit 5×2 with 1-texel gap = 3 texel stride).
    for (let index = 0; index < cairn.units.length; index++) {
        const unit = cairn.units[index];
        const uy = bottomY - 2 - index * CAIRN_UNIT_STRIDE;
        if (unit.state === 'returned') {
            // Filled parchment scroll (5×2) with 1×2 child model trim seal at centre.
            ctx.fillStyle = ART_RAMPS.sand[3];
            ctx.fillRect(ox, uy, CAIRN_WIDTH, 2);
            ctx.fillStyle = ART_RAMPS.timber[1];
            ctx.fillRect(ox, uy, 1, 2);
            ctx.fillRect(ox + CAIRN_WIDTH - 1, uy, 1, 2);
            ctx.fillStyle = unit.trim || ART_RAMPS.trimGold[1];
            ctx.fillRect(ox + 2, uy, 1, 2);
        } else {
            // Hollow chalk outline for an outstanding child.
            ctx.fillStyle = ART_RAMPS.blossomIvory[2];
            ctx.fillRect(ox, uy, CAIRN_WIDTH, 1);
            ctx.fillRect(ox, uy + 1, 1, 1);
            ctx.fillRect(ox + CAIRN_WIDTH - 1, uy + 1, 1, 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Workflow Ribbon Reader (Spec 04 §3.5)
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Spec 04 §3.5 — Strip control characters, collapse runs of whitespace, and
 * truncate at 32 characters followed by an ellipsis (`…`).
 */
export function sanitizeWorkflowLabel(name) {
    if (typeof name !== 'string') return null;
    const clean = name.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    if (clean.length <= WORKFLOW_LABEL_MAX_CHARS) return clean;
    return `${clean.slice(0, WORKFLOW_LABEL_MAX_CHARS)}…`;
}

/**
 * Spec 04 §3.5 — Workflow group key:
 * - `agent.workflowId` if non-empty string.
 * - Else if `agent.workflowName` AND `agent.parentSessionId` are non-empty:
 *   `${agent.provider || 'unknown'}:${agent.parentSessionId}:${agent.workflowName}`.
 * - NEVER bare `workflowName` alone. Returns null otherwise.
 */
export function workflowGroupKey(agent) {
    const workflowId = typeof agent?.workflowId === 'string' ? agent.workflowId.trim() : '';
    if (workflowId) return workflowId;
    const workflowName = typeof agent?.workflowName === 'string' ? agent.workflowName.trim() : '';
    const parentSessionId = typeof agent?.parentSessionId === 'string' ? agent.parentSessionId.trim() : '';
    if (workflowName && parentSessionId) {
        const provider = typeof agent?.provider === 'string' && agent.provider.trim()
            ? agent.provider.trim().toLowerCase()
            : 'unknown';
        return `${provider}:${parentSessionId}:${workflowName}`;
    }
    return null;
}

/**
 * Spec 04 §3.5 — Assign workflow ribbon slots per parent, capped at 2 concurrent
 * ribbons per parent (slot 0, slot 1, or null for 3rd+).
 * Returns `{ byAgentId: Map, byParentId: Map }` with exact run count and label
 * (e.g. `"3 runs"`) for READ and The Glass.
 */
export function assignWorkflowRibbons(agents = []) {
    const byParentGroups = new Map();
    const entries = [];

    for (const agent of Array.isArray(agents) ? agents : []) {
        if (!agent || agent.isDeparted) continue;
        const key = workflowGroupKey(agent);
        if (!key) continue;
        const parentId = typeof agent.parentSessionId === 'string' && agent.parentSessionId.trim()
            ? agent.parentSessionId.trim()
            : (typeof agent.rootSessionId === 'string' && agent.rootSessionId.trim()
                ? agent.rootSessionId.trim()
                : '__root__');
        let groups = byParentGroups.get(parentId);
        if (!groups) {
            groups = new Map();
            byParentGroups.set(parentId, groups);
        }
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                label: sanitizeWorkflowLabel(agent.workflowName),
                firstAt: Number(agent.turnStartedAt || agent.lastSessionActivity || 0) || 0,
            });
        }
        entries.push({ agent, key, parentId });
    }

    const byParentId = new Map();
    const slotByParentAndKey = new Map();
    for (const [parentId, groups] of byParentGroups.entries()) {
        const ordered = [...groups.values()].sort((a, b) => (a.firstAt - b.firstAt) || a.key.localeCompare(b.key));
        const runCount = ordered.length;
        const runCountLabel = runCount === 1 ? '1 run' : `${runCount} runs`;
        const slotMap = new Map();
        ordered.forEach((group, index) => {
            slotMap.set(group.key, index < MAX_WORKFLOW_RIBBONS_PER_PARENT ? index : null);
        });
        slotByParentAndKey.set(parentId, slotMap);
        byParentId.set(parentId, {
            parentId,
            keys: ordered.map(g => g.key),
            runCount,
            runCountLabel,
        });
    }

    const byAgentId = new Map();
    for (const { agent, key, parentId } of entries) {
        const id = agent.id ?? agent.sessionId;
        if (id == null) continue;
        const parentSummary = byParentId.get(parentId);
        const slot = slotByParentAndKey.get(parentId)?.get(key) ?? null;
        byAgentId.set(String(id), {
            key,
            parentId,
            slot,
            runCount: parentSummary.runCount,
            runCountLabel: parentSummary.runCountLabel,
            label: sanitizeWorkflowLabel(agent.workflowName),
        });
    }

    return { byAgentId, byParentId };
}
