// Wave 4 (Spec 04 §4.11) — Chronicle Illustrated Tapestry PNG builder.
//
// Deterministic 1200x1600 canvas composition summarizing one Chronicle day with
// ZERO PII by construction:
//   - Band 0 (0..1600)    24 px carved walnut border + corner ornaments
//   - Band 1 (48..128)    Masthead (`CLAUDEVILLE CHRONICLE · THU 19 NOV 2026`)
//   - Band 2 (152..800)   1152x648 label-free diorama slot
//   - Band 3 (824..896)   2x Sun-arc ribbon slot (1152x72)
//   - Band 4 (920..1100)  6-stat ledger (integer over fixed label)
//   - Band 5 (1124..1340) 24-hour Loom frieze slot (12x2 panels; graceful empty
//                         warp grid before Wave 6 Loom wires in)
//   - Band 6 (1364..1552) Cast sprite busts with ZERO captions
//
// ZERO PII GUARD: every single `ctx.fillText` call flows exclusively through
// `tapestryText(ctx, text, x, y)`, which accepts ONLY:
//   1. a frozen structural label from `TAPESTRY_ALLOWED_LABELS`,
//   2. a formatted uppercase date (`THU 19 NOV 2026`) or masthead
//      (`CLAUDEVILLE CHRONICLE · THU 19 NOV 2026`), or
//   3. a pure formatted integer (`/^\d[\d,]*$/`).
// Any other string (agent name, repo name, branch, path, prompt, commit
// message) throws synchronously before touching the canvas context.

import { ART_RAMPS, EFFECT_COLORS, PENNANT_PALETTE } from '../../config/artPalette.js';
import {
    THEME,
    WORLD_BODY_FONT_22,
    WORLD_DISPLAY_FONT_8,
    WORLD_DISPLAY_FONT_16,
} from '../../config/theme.js';

export const TAPESTRY_WIDTH = 1200;
export const TAPESTRY_HEIGHT = 1600;
export const TAPESTRY_BORDER_PX = 24;

export const TAPESTRY_BANDS = Object.freeze({
    border: Object.freeze({ x: 0, y: 0, width: 1200, height: 1600, inset: 24 }),
    masthead: Object.freeze({ x: 24, y: 48, width: 1152, height: 80 }),
    diorama: Object.freeze({ x: 24, y: 152, width: 1152, height: 648 }),
    sunArc: Object.freeze({ x: 24, y: 824, width: 1152, height: 72 }),
    ledger: Object.freeze({ x: 24, y: 920, width: 1152, height: 180 }),
    loom: Object.freeze({ x: 24, y: 1124, width: 1152, height: 216 }),
    cast: Object.freeze({ x: 24, y: 1364, width: 1152, height: 188 }),
});

export const TAPESTRY_LEDGER_LABELS = Object.freeze([
    'COMMITS',
    'PUSHES',
    'MENDS',
    'TURNS',
    'HOURS',
    'VILLAGERS',
]);

export const TAPESTRY_ALLOWED_LABELS = Object.freeze(new Set([
    'CLAUDEVILLE CHRONICLE',
    ...TAPESTRY_LEDGER_LABELS,
    'EVENTS',
    'WAITS',
    'ERRORS',
    'RELEASES',
    'COMPACTIONS',
]));

export const TAPESTRY_DATE_RE = /^(MON|TUE|WED|THU|FRI|SAT|SUN) \d{1,2} (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{4}$/;
export const TAPESTRY_MASTHEAD_RE = /^CLAUDEVILLE CHRONICLE · (MON|TUE|WED|THU|FRI|SAT|SUN) \d{1,2} (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{4}$/;
export const TAPESTRY_INT_RE = /^\d[\d,]*$/;

const WEEKDAYS = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const MONTHS = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

const PALETTE = Object.freeze({
    ground: '#18120e',
    field: '#211913',
    walnutDark: '#24160c',
    walnutMid: '#3b2616',
    walnutBevel: '#5c3d22',
    outline: '#0e0906',
    brass: '#b8893f',
    gold: '#ebb754',
    parchment: '#eadfc8',
    parchmentDim: '#b8aa8f',
    linenWarp: '#32261c',
    linenThread: '#473627',
    selvedge: '#5c3d22',
    skyNight: ART_RAMPS.deepWater[0],
    skyDawn: '#6b4d57',
    skyDay: ART_RAMPS.deepWater[2],
    skyDusk: '#7a5240',
});

/**
 * Return true iff `value` is strictly allowed on a Chronicle Tapestry:
 * a frozen structural label, a formatted uppercase date / masthead, or a
 * non-negative comma-grouped integer.
 */
export function isAllowedTapestryText(value) {
    if (typeof value !== 'string' || !value.length) return false;
    if (/[\r\n\t]/.test(value)) return false;
    if (TAPESTRY_ALLOWED_LABELS.has(value)) return true;
    if (TAPESTRY_INT_RE.test(value)) return true;
    if (TAPESTRY_DATE_RE.test(value) || TAPESTRY_MASTHEAD_RE.test(value)) {
        const dayMatch = value.match(/(?:MON|TUE|WED|THU|FRI|SAT|SUN) (\d{1,2}) /);
        const day = dayMatch ? Number(dayMatch[1]) : 0;
        return day >= 1 && day <= 31;
    }
    return false;
}

/**
 * Sole permitted text drawing gate for Chronicle Tapestry. Throws on ANY
 * string outside the zero-PII allowlist so no agent name, repo name, branch,
 * path, or prompt can ever reach `ctx.fillText`.
 */
export function tapestryText(ctx, text, x, y) {
    const normalized = (typeof text === 'number' && Number.isInteger(text) && text >= 0)
        ? formatTapestryInt(text)
        : text;
    if (typeof normalized !== 'string' || !isAllowedTapestryText(normalized)) {
        throw new Error(`ChronicleTapestry zero-PII guard rejected text: ${JSON.stringify(text)}`);
    }
    ctx.fillText(normalized, Math.round(x), Math.round(y));
    return normalized;
}

function resolveDate(dateOrKey) {
    if (dateOrKey instanceof Date && !Number.isNaN(dateOrKey.getTime())) {
        return new Date(dateOrKey.getFullYear(), dateOrKey.getMonth(), dateOrKey.getDate());
    }
    if (typeof dateOrKey === 'string') {
        const match = dateOrKey.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        const parsed = new Date(dateOrKey);
        if (!Number.isNaN(parsed.getTime())) {
            return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
        }
    }
    if (typeof dateOrKey === 'number' && Number.isFinite(dateOrKey)) {
        const d = new Date(dateOrKey);
        if (!Number.isNaN(d.getTime())) {
            return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        }
    }
    return new Date(2026, 0, 1);
}

/** Locale-independent uppercase date: e.g. `THU 19 NOV 2026`. */
export function formatTapestryDate(dateOrKey) {
    const d = resolveDate(dateOrKey);
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Locale-independent masthead: `CLAUDEVILLE CHRONICLE · THU 19 NOV 2026`. */
export function formatTapestryMasthead(dateOrKey) {
    return `CLAUDEVILLE CHRONICLE · ${formatTapestryDate(dateOrKey)}`;
}

/** Locale-independent non-negative integer formatting matching `/^\d[\d,]*$/`. */
export function formatTapestryInt(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Zero-PII download file name: `claudeville-chronicle-YYYY-MM-DD.png`. */
export function tapestryFileName(dateOrKey) {
    const d = resolveDate(dateOrKey);
    const pad2 = (v) => String(v).padStart(2, '0');
    return `claudeville-chronicle-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.png`;
}

function nonNegInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const COVERAGE_QUARTERS = 96;

function isTruthyCoverageFlag(value) {
    if (value === null || value === undefined || value === false || value === 0) return false;
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        return trimmed !== '' && trimmed !== '0' && trimmed !== 'false';
    }
    return Boolean(value);
}

/**
 * Decode a Chronicle coverage mask into 96 quarter-hour flags (0/1), matching
 * `ChronicleStore` (24-char big-endian hex) and `ChroniclePanel.decodeCoverageMask`
 * (96-char bitstring, BigInt, 12-byte Uint8Array, 3-word Uint32Array,
 * 24-hour or 96-quarter arrays, or `{ bits | mask | quarters | hours }`).
 * Returns null when coverage is missing or unrecognized.
 */
export function decodeTapestryCoverage(coverage) {
    if (coverage === null || coverage === undefined) return null;
    const raw = (typeof coverage === 'object' && !Array.isArray(coverage) && !ArrayBuffer.isView(coverage))
        ? (coverage.bits ?? coverage.mask ?? coverage.quarters ?? coverage.hours ?? null)
        : coverage;
    if (raw === null || raw === undefined) return null;

    const quarters = new Uint8Array(COVERAGE_QUARTERS);
    if (typeof raw === 'bigint') {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) quarters[q] = Number((raw >> BigInt(q)) & 1n);
        return quarters;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (/^[01]{96}$/.test(trimmed)) {
            for (let q = 0; q < COVERAGE_QUARTERS; q++) quarters[q] = trimmed.charCodeAt(q) === 49 ? 1 : 0;
            return quarters;
        }
        const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
        if (/^[0-9a-fA-F]{1,24}$/.test(hex)) {
            const bits = BigInt(`0x${hex}`);
            for (let q = 0; q < COVERAGE_QUARTERS; q++) quarters[q] = Number((bits >> BigInt(q)) & 1n);
            return quarters;
        }
        return null;
    }
    if ((raw instanceof Uint32Array || Array.isArray(raw)) && raw.length === 3) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) {
            const word = Number(raw[q >> 5]) >>> 0;
            quarters[q] = (word >>> (q & 31)) & 1;
        }
        return quarters;
    }
    if ((raw instanceof Uint8Array || Array.isArray(raw)) && raw.length === 12) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) {
            const byte = Number(raw[q >> 3]) & 0xff;
            quarters[q] = (byte >> (q & 7)) & 1;
        }
        return quarters;
    }
    if ((Array.isArray(raw) || ArrayBuffer.isView(raw)) && raw.length === COVERAGE_QUARTERS) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) quarters[q] = isTruthyCoverageFlag(raw[q]) ? 1 : 0;
        return quarters;
    }
    if ((Array.isArray(raw) || ArrayBuffer.isView(raw)) && raw.length === 24) {
        for (let h = 0; h < 24; h++) {
            const covered = isTruthyCoverageFlag(raw[h]) ? 1 : 0;
            for (let q = 0; q < 4; q++) quarters[h * 4 + q] = covered;
        }
        return quarters;
    }
    return null;
}

/** Collapse a decoded 96-quarter coverage mask into 24 hour flags (0/1), or null. */
export function decodeTapestryCoverageHours(coverage) {
    const quarters = decodeTapestryCoverage(coverage);
    if (!quarters) return null;
    const hours = new Uint8Array(24);
    for (let h = 0; h < 24; h++) {
        const base = h * 4;
        hours[h] = (quarters[base] || quarters[base + 1] || quarters[base + 2] || quarters[base + 3]) ? 1 : 0;
    }
    return hours;
}

/**
 * Pure integer-only stat rollup. Strips all string identities (names, repos,
 * branches, paths, prompts) and produces strictly non-negative integer counts.
 */
export function extractTapestryStats({ summary = null, events, roster = null, cast = [], coverage = null } = {}) {
    const hasExplicitEvents = Array.isArray(events);
    const list = hasExplicitEvents ? events : [];
    const distinctHours = new Set();
    const distinctAgents = new Set();
    let commits = 0;
    let pushes = 0;
    let mends = 0;
    let turns = 0;

    for (const ev of list) {
        if (!ev || typeof ev !== 'object') continue;
        const kind = String(ev.kind || ev.type || '').toLowerCase();
        if (kind === 'commit') commits++;
        else if (kind === 'push' && !ev.outcome) pushes++;
        else if (kind === 'mended') mends++;
        else if (kind === 'completed') turns++;
        if (ev.agentId || ev.agentName) distinctAgents.add(String(ev.agentId || ev.agentName));
        const ts = Number(ev.ts);
        if (Number.isFinite(ts)) distinctHours.add(new Date(ts).getHours());
    }

    const coverageHours = decodeTapestryCoverageHours(coverage);
    let coveredHours = 0;
    if (coverageHours) {
        for (let h = 0; h < 24; h++) {
            if (coverageHours[h]) coveredHours++;
        }
    }

    let villagers;
    if (summary?.villagers != null) {
        villagers = nonNegInt(summary.villagers);
    } else if (summary?.agentCount != null) {
        villagers = nonNegInt(summary.agentCount);
    } else if (Array.isArray(roster)) {
        villagers = roster.length;
    } else if (Array.isArray(summary?.roster)) {
        villagers = summary.roster.length;
    } else if (Array.isArray(summary?.agents)) {
        villagers = Math.max(summary.agents.length, distinctAgents.size);
    } else if (hasExplicitEvents) {
        villagers = distinctAgents.size;
    } else {
        villagers = Array.isArray(cast) ? cast.length : 0;
    }

    return Object.freeze({
        commits: summary?.commits != null ? nonNegInt(summary.commits) : commits,
        pushes: summary?.pushes != null ? nonNegInt(summary.pushes) : pushes,
        mends: summary?.mends != null ? nonNegInt(summary.mends) : mends,
        turns: summary?.completed != null
            ? nonNegInt(summary.completed)
            : (summary?.turns != null ? nonNegInt(summary.turns) : turns),
        hours: summary?.hours != null
            ? Math.min(24, nonNegInt(summary.hours))
            : (coveredHours > 0 ? coveredHours : distinctHours.size),
        villagers,
    });
}

function drawWalnutBorder(ctx) {
    const W = TAPESTRY_WIDTH;
    const H = TAPESTRY_HEIGHT;
    const B = TAPESTRY_BORDER_PX;

    // Base background & inner parchment-walnut field.
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = PALETTE.field;
    ctx.fillRect(B, B, W - B * 2, H - B * 2);

    // 24 px carved walnut border around all four sides.
    ctx.fillStyle = PALETTE.walnutMid;
    ctx.fillRect(0, 0, W, B);
    ctx.fillRect(0, H - B, W, B);
    ctx.fillRect(0, B, B, H - B * 2);
    ctx.fillRect(W - B, B, B, H - B * 2);

    // Outer & inner dark outline rules + bevel courses.
    ctx.fillStyle = PALETTE.outline;
    ctx.fillRect(0, 0, W, 2);
    ctx.fillRect(0, H - 2, W, 2);
    ctx.fillRect(0, 0, 2, H);
    ctx.fillRect(W - 2, 0, 2, H);

    ctx.fillStyle = PALETTE.walnutBevel;
    ctx.fillRect(2, 2, W - 4, 2);
    ctx.fillRect(2, 2, 2, H - 4);
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(2, H - 4, W - 4, 2);
    ctx.fillRect(W - 4, 2, 2, H - 4);

    // Carved brass inlay hairline inside the 24 px frame.
    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(10, 10, W - 20, 2);
    ctx.fillRect(10, H - 12, W - 20, 2);
    ctx.fillRect(10, 10, 2, H - 20);
    ctx.fillRect(W - 12, 10, 2, H - 20);

    // Inner frame lip.
    ctx.fillStyle = PALETTE.outline;
    ctx.fillRect(B - 2, B - 2, W - (B - 2) * 2, 2);
    ctx.fillRect(B - 2, H - B, W - (B - 2) * 2, 2);
    ctx.fillRect(B - 2, B - 2, 2, H - (B - 2) * 2);
    ctx.fillRect(W - B, B - 2, 2, H - (B - 2) * 2);

    // Four stepped brass corner medallions (pixel ornaments).
    const corners = [
        [4, 4],
        [W - 20, 4],
        [4, H - 20],
        [W - 20, H - 20],
    ];
    for (const [cx, cy] of corners) {
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(cx, cy, 16, 16);
        ctx.fillStyle = PALETTE.brass;
        ctx.fillRect(cx + 2, cy + 2, 12, 12);
        ctx.fillStyle = PALETTE.walnutDark;
        ctx.fillRect(cx + 4, cy + 4, 8, 8);
        ctx.fillStyle = PALETTE.gold;
        ctx.fillRect(cx + 6, cy + 6, 4, 4);
    }
}

function drawMasthead(ctx, masthead, textDrawn) {
    const band = TAPESTRY_BANDS.masthead;
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(band.x, band.y, band.width, band.height);
    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);

    // Stepped ornamental end-caps flanking the masthead title.
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(band.x + 24, band.y + 38, 28, 4);
    ctx.fillRect(band.x + band.width - 52, band.y + 38, 28, 4);

    ctx.font = WORLD_DISPLAY_FONT_16;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PALETTE.gold;
    textDrawn.push(tapestryText(ctx, masthead, band.x + band.width / 2, band.y + band.height / 2));
}

function drawDioramaSlot(ctx, diorama) {
    const band = TAPESTRY_BANDS.diorama;
    ctx.fillStyle = PALETTE.outline;
    ctx.fillRect(band.x, band.y, band.width, band.height);

    if (diorama && diorama.width && diorama.height) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(diorama, 0, 0, diorama.width, diorama.height, band.x, band.y, band.width, band.height);
    } else {
        // Serene label-free horizon tapestry placeholder when no live snapshot is attached.
        ctx.fillStyle = PALETTE.skyNight;
        ctx.fillRect(band.x + 2, band.y + 2, band.width - 4, 240);
        ctx.fillStyle = PALETTE.skyDawn;
        ctx.fillRect(band.x + 2, band.y + 242, band.width - 4, 140);
        ctx.fillStyle = ART_RAMPS.grass[1];
        ctx.fillRect(band.x + 2, band.y + 382, band.width - 4, 160);
        ctx.fillStyle = ART_RAMPS.deepWater[1];
        ctx.fillRect(band.x + 2, band.y + 542, band.width - 4, band.height - 544);
    }

    // Crisp 2 px brass inner frame around the 1152x648 diorama.
    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);
    ctx.fillRect(band.x, band.y, 2, band.height);
    ctx.fillRect(band.x + band.width - 2, band.y, 2, band.height);
}

function drawSunArcSlot(ctx, sunArc, events, coverage) {
    const band = TAPESTRY_BANDS.sunArc;
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(band.x, band.y, band.width, band.height);

    if (sunArc && sunArc.width && sunArc.height) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sunArc, 0, 0, sunArc.width, sunArc.height, band.x, band.y, band.width, band.height);
    } else {
        // 24 hour columns at 2x (48 px wide x 72 px tall -> 1152x72 exact).
        const colW = 48;
        const hourCommits = new Uint16Array(24);
        const hourPushes = new Uint16Array(24);
        const hourIncidents = new Uint16Array(24);
        const hourObserved = new Uint8Array(24);

        for (const ev of Array.isArray(events) ? events : []) {
            const ts = Number(ev?.ts);
            if (!Number.isFinite(ts)) continue;
            const h = new Date(ts).getHours();
            hourObserved[h] = 1;
            const kind = String(ev.kind || ev.type || '').toLowerCase();
            if (kind === 'commit') hourCommits[h]++;
            else if (kind === 'push' && !ev.outcome) hourPushes[h]++;
            else if (kind === 'waiting' || kind === 'errored' || kind === 'rate_limited') hourIncidents[h]++;
        }
        const coverageHours = decodeTapestryCoverageHours(coverage);
        if (coverageHours) {
            for (let h = 0; h < 24; h++) {
                if (coverageHours[h]) hourObserved[h] = 1;
            }
        }

        for (let h = 0; h < 24; h++) {
            const cx = band.x + h * colW;
            const sky = (h < 5 || h >= 21)
                ? PALETTE.skyNight
                : (h < 8 ? PALETTE.skyDawn : (h < 18 ? PALETTE.skyDay : PALETTE.skyDusk));
            ctx.fillStyle = hourObserved[h] ? sky : PALETTE.linenWarp;
            ctx.fillRect(cx + 1, band.y + 4, colW - 2, band.height - 8);

            // Bare warp lines on uncovered hours.
            if (!hourObserved[h]) {
                ctx.fillStyle = PALETTE.linenThread;
                for (let wx = cx + 6; wx < cx + colW - 2; wx += 8) {
                    ctx.fillRect(wx, band.y + 6, 2, band.height - 12);
                }
            }
            // Brass ticks for commits/pushes, status pip for wait/error (zero text).
            if (hourCommits[h] > 0) {
                ctx.fillStyle = PALETTE.gold;
                ctx.fillRect(cx + 10, band.y + 42, 6, 22);
            }
            if (hourPushes[h] > 0) {
                ctx.fillStyle = EFFECT_COLORS.success;
                ctx.fillRect(cx + 22, band.y + 24, 6, 40);
            }
            if (hourIncidents[h] > 0) {
                ctx.fillStyle = THEME.waitingOnUser;
                ctx.fillRect(cx + 34, band.y + 12, 6, 6);
            }
        }
    }

    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);
}

function drawLedgerBand(ctx, stats, repoColors, textDrawn) {
    const band = TAPESTRY_BANDS.ledger;
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(band.x, band.y, band.width, band.height);
    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);

    const items = [
        { label: 'COMMITS', value: stats.commits },
        { label: 'PUSHES', value: stats.pushes },
        { label: 'MENDS', value: stats.mends },
        { label: 'TURNS', value: stats.turns },
        { label: 'HOURS', value: stats.hours },
        { label: 'VILLAGERS', value: stats.villagers },
    ];
    const colW = band.width / items.length; // 192 px exact

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < items.length; i++) {
        const colX = band.x + i * colW;
        const centerX = colX + colW / 2;
        if (i > 0) {
            ctx.fillStyle = PALETTE.walnutBevel;
            ctx.fillRect(Math.round(colX), band.y + 24, 2, band.height - 48);
        }

        // Integer count above fixed structural label.
        ctx.font = WORLD_BODY_FONT_22;
        ctx.fillStyle = items[i].value > 0 ? PALETTE.parchment : PALETTE.parchmentDim;
        textDrawn.push(tapestryText(ctx, formatTapestryInt(items[i].value), centerX, band.y + 68));

        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = PALETTE.gold;
        textDrawn.push(tapestryText(ctx, items[i].label, centerX, band.y + 118));
    }

    // Repos appear strictly as pennant colour swatches along the ledger foot — never names.
    const swatches = (Array.isArray(repoColors) ? repoColors : [])
        .filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c))
        .slice(0, 12);
    if (swatches.length) {
        const swW = 16;
        const swGap = 8;
        const total = swatches.length * swW + (swatches.length - 1) * swGap;
        const startX = Math.round(band.x + (band.width - total) / 2);
        for (let i = 0; i < swatches.length; i++) {
            ctx.fillStyle = PALETTE.outline;
            ctx.fillRect(startX + i * (swW + swGap) - 1, band.y + 148, swW + 2, 12);
            ctx.fillStyle = swatches[i];
            ctx.fillRect(startX + i * (swW + swGap), band.y + 149, swW, 10);
        }
    }
}

function drawLoomBand(ctx, loom) {
    const band = TAPESTRY_BANDS.loom;
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(band.x, band.y, band.width, band.height);

    // 12x2 panels of 96x72 -> 1152 wide, 144 tall + 16 gap + 28 top/bottom selvedge = 216 px.
    const panelW = 96;
    const panelH = 72;
    const rowGap = 16;
    const padY = Math.floor((band.height - (panelH * 2 + rowGap)) / 2);

    if (loom && !Array.isArray(loom) && loom.width && loom.height) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(loom, 0, 0, loom.width, loom.height, band.x, band.y, band.width, band.height);
    } else {
        const panels = Array.isArray(loom) ? loom : [];
        for (let idx = 0; idx < 24; idx++) {
            const col = idx % 12;
            const row = Math.floor(idx / 12);
            const px = band.x + col * panelW;
            const py = band.y + padY + row * (panelH + rowGap);
            const panel = panels[idx] || null;
            if (panel && panel.width && panel.height) {
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(panel, 0, 0, panel.width, panel.height, px, py, panelW, panelH);
            } else {
                // Graceful empty warp grid before Wave 6 Loom wires in:
                // 2 px top/bottom selvedge + vertical warp threads every 4 px.
                ctx.fillStyle = PALETTE.linenWarp;
                ctx.fillRect(px + 1, py, panelW - 2, panelH);
                ctx.fillStyle = PALETTE.selvedge;
                ctx.fillRect(px + 1, py, panelW - 2, 2);
                ctx.fillRect(px + 1, py + panelH - 2, panelW - 2, 2);
                ctx.fillStyle = PALETTE.linenThread;
                for (let wx = px + 4; wx < px + panelW - 2; wx += 4) {
                    ctx.fillRect(wx, py + 2, 1, panelH - 4);
                }
            }
        }
    }

    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);
}

function drawCastBand(ctx, cast) {
    const band = TAPESTRY_BANDS.cast;
    ctx.fillStyle = PALETTE.walnutDark;
    ctx.fillRect(band.x, band.y, band.width, band.height);
    ctx.fillStyle = PALETTE.brass;
    ctx.fillRect(band.x, band.y, band.width, 2);
    ctx.fillRect(band.x, band.y + band.height - 2, band.width, 2);

    // Strictly visual sprite busts — ZERO captions, ZERO names, ZERO text calls.
    const entries = (Array.isArray(cast) ? cast : []).filter(Boolean).slice(0, 12);
    if (!entries.length) return;

    const bustSize = 72;
    const framePad = 4;
    const cellW = bustSize + framePad * 2;
    const gap = entries.length > 10 ? 12 : 16;
    const totalW = entries.length * cellW + (entries.length - 1) * gap;
    const startX = Math.round(band.x + (band.width - totalW) / 2);
    const topY = Math.round(band.y + (band.height - cellW) / 2);

    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const cx = startX + i * (cellW + gap);
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(cx, topY, cellW, cellW);
        ctx.fillStyle = PALETTE.walnutMid;
        ctx.fillRect(cx + 2, topY + 2, cellW - 4, cellW - 4);
        ctx.fillStyle = PALETTE.brass;
        ctx.fillRect(cx + 2, topY + 2, cellW - 4, 2);

        const img = entry.canvas || entry.image || entry.bust || null;
        const bx = cx + framePad;
        const by = topY + framePad;
        if (img && img.width && img.height) {
            const sx = Number.isFinite(entry.sx) ? entry.sx : 0;
            const sy = Number.isFinite(entry.sy) ? entry.sy : 0;
            const sw = Number.isFinite(entry.sw) ? entry.sw : img.width;
            const sh = Number.isFinite(entry.sh) ? entry.sh : img.height;
            ctx.drawImage(img, sx, sy, sw, sh, bx, by, bustSize, bustSize);
        } else {
            // Silent pawn silhouette when no sprite bust surface is supplied.
            const trim = (typeof entry.trimColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.trimColor))
                ? entry.trimColor
                : PENNANT_PALETTE[i % PENNANT_PALETTE.length];
            ctx.fillStyle = PALETTE.outline;
            ctx.fillRect(bx + 24, by + 12, 24, 24);
            ctx.fillRect(bx + 14, by + 36, 44, 28);
            ctx.fillStyle = trim;
            ctx.fillRect(bx + 26, by + 14, 20, 20);
            ctx.fillRect(bx + 16, by + 38, 40, 24);
        }
    }
}

/**
 * Render a deterministic 1200x1600 Chronicle Illustrated Tapestry.
 * Every text draw routes strictly through `tapestryText()`.
 */
export function renderChronicleTapestry({
    date = null,
    dateKey = null,
    summary = null,
    events,
    roster = null,
    diorama = null,
    sunArc = null,
    loom = null,
    cast = [],
    coverage = null,
    repoColors = [],
    canvas = null,
    ctx = null,
    documentRef = globalThis.document,
} = {}) {
    let targetCanvas = canvas;
    let targetCtx = ctx;
    if (!targetCtx) {
        if (!targetCanvas) {
            if (!documentRef || typeof documentRef.createElement !== 'function') {
                throw new Error('renderChronicleTapestry requires a canvas, ctx, or documentRef');
            }
            targetCanvas = documentRef.createElement('canvas');
        }
        targetCanvas.width = TAPESTRY_WIDTH;
        targetCanvas.height = TAPESTRY_HEIGHT;
        targetCtx = targetCanvas.getContext('2d');
    } else if (targetCanvas) {
        targetCanvas.width = TAPESTRY_WIDTH;
        targetCanvas.height = TAPESTRY_HEIGHT;
    }

    const effectiveDate = date ?? dateKey ?? '2026-11-19';
    const dateLabel = formatTapestryDate(effectiveDate);
    const masthead = formatTapestryMasthead(effectiveDate);
    const stats = extractTapestryStats({ summary, events, roster, cast, coverage });
    const effectiveCast = stats.villagers > 0 ? cast : [];
    const textDrawn = [];

    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    drawWalnutBorder(targetCtx);
    drawMasthead(targetCtx, masthead, textDrawn);
    drawDioramaSlot(targetCtx, diorama);
    drawSunArcSlot(targetCtx, sunArc, Array.isArray(events) ? events : [], coverage);
    drawLedgerBand(targetCtx, stats, repoColors, textDrawn);
    drawLoomBand(targetCtx, loom);
    drawCastBand(targetCtx, effectiveCast);
    targetCtx.restore();

    return {
        canvas: targetCanvas,
        width: TAPESTRY_WIDTH,
        height: TAPESTRY_HEIGHT,
        dateLabel,
        masthead,
        stats,
        textDrawn,
        fileName: tapestryFileName(effectiveDate),
    };
}
