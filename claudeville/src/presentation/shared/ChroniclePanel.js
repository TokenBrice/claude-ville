import {
    ChronicleEventKind,
    chronicleDateFromKey,
    chronicleDateKey,
    chronicleDateWindow,
    summarizeDay,
} from '../../application/ChronicleLog.js';
import {
    DIURNAL_BANDS,
    DIURNAL_BAND_LABELS,
    diurnalBandForMinute,
    diurnalBandForTimestamp,
    resolveDiurnalBands,
} from '../../application/ChronicleScenario.js';
import { THEME } from '../../config/theme.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { Appearance } from '../../domain/value-objects/Appearance.js';
import { solarDayFor } from '../character-mode/SolarClock.js';
import { AvatarCanvas } from '../dashboard-mode/AvatarCanvas.js';
import { buildBookOfLivesViewModel } from './ActivityPanel.js';
import { providerPresentation } from './AgentPresentation.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatNumber } from './Formatters.js';

// The day's recap, told the way the village would tell it. Reads the
// ChronicleLog day book and renders a 24h Sun-Arc ribbon, a short ledger,
// and a diurnal-chaptered timeline, so looking away for an hour no longer
// costs you the whole hour.

export const CHRONICLE_COMPACTED_KIND = ChronicleEventKind.COMPACTED ?? 'compacted';
export const CHRONICLE_RELEASE_KIND = ChronicleEventKind.RELEASE ?? 'release';
export const SUN_ARC_HEIGHT = 36;
export const COVERAGE_QUARTERS = 96;
export { DIURNAL_BANDS, DIURNAL_BAND_LABELS };

const KIND_GLYPH = {
    [ChronicleEventKind.ARRIVED]: '→',
    [ChronicleEventKind.DEPARTED]: '←',
    [ChronicleEventKind.COMPLETED]: '✦',
    [ChronicleEventKind.WAITING]: '?',
    [ChronicleEventKind.RESOLVED]: '✓',
    [ChronicleEventKind.ERRORED]: '!',
    [ChronicleEventKind.RATE_LIMITED]: '~',
    [ChronicleEventKind.COMMIT]: '◆',
    [ChronicleEventKind.PUSH]: '▲',
    [ChronicleEventKind.MENDED]: '◇',
    [CHRONICLE_COMPACTED_KIND]: '≡',
    [CHRONICLE_RELEASE_KIND]: '★',
};

const REASON_TEXT = {
    question: 'asked a question',
    approval: 'awaited approval',
    plan_review: 'awaited plan review',
};

const TIMELINE_LABELS = Object.freeze({
    arrived: 'arrival',
    departed: 'departure',
    completed: 'completed turn',
    waiting: 'wait',
    resolved: 'resolution',
    errored: 'error',
    'rate limited': 'rate limit',
    commit: 'commit',
    push: 'push',
    mended: 'mend',
    compacted: 'compaction',
    release: 'release',
});

// Stepped Keep-at-Night palette for the 36 px Sun-Arc canvas (no gradients).
const SUN_ARC_SKY = Object.freeze({
    night: Object.freeze({ top: '#131724', bottom: '#1b2234' }),
    dawn: Object.freeze({ top: '#423d59', bottom: '#9b6d6c' }),
    day: Object.freeze({ top: '#3b5d78', bottom: '#5f849c' }),
    dusk: Object.freeze({ top: '#3b3754', bottom: '#8f5f55' }),
});
const SUN_ARC_INK = Object.freeze({
    linen: '#2c241c',
    linenWarp: '#3c3126',
    seam: '#0b0908',
    grid: '#3a2c20',
    horizon: '#5a4330',
    arcNight: '#97876e',
    arcDay: '#f2c75c',
    brass: '#b8893f',
    gold: '#f2c75c',
    goldHi: '#ffe08a',
});

function humanizeTimelineKind(kind) {
    const normalized = String(kind ?? 'event')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
    if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();
    return normalized || 'event';
}

function pluralizeTimelineLabel(value) {
    const words = value.split(' ');
    const last = words.pop() || 'event';
    let plural = last;
    if (/(s|x|z|ch|sh)$/i.test(last)) {
        plural = `${last}es`;
    } else if (/[^aeiou]y$/i.test(last)) {
        plural = `${last.slice(0, -1)}ies`;
    } else {
        plural = `${last}s`;
    }
    return [...words, plural].join(' ');
}

export const CHRONICLE_TIMELINE_PAGE_SIZE = 100;
export const HALL_OF_LIVES_CHAPTER_LIMIT = 3;

/** XP-2 — the separate window that replays one recorded day. */
export function retoldVillageHref(pathname, dateKey) {
    return `${pathname || '/'}?retold=${encodeURIComponent(dateKey)}`;
}

// A lineage is a durable identity: a named villager or a project lead
// (provider x repo). Session-scoped rows are not lineages.
function hallLineage(identityKey) {
    const match = /^(named|project):([a-z0-9-]+):(.+)$/.exec(identityKey);
    if (!match) return null;
    const [, scope, provider, slugName] = match;
    return { scope, provider, slugName };
}

/**
 * XP-8 — the Hall of Lives: every remembered lineage, most recently seen
 * first. A memory, not a leaderboard: rows carry no stats, totals or ranks,
 * and the order is last seen only.
 */
export function buildHallOfLives(records = [], { now = Date.now() } = {}) {
    return (Array.isArray(records) ? records : [])
        .map(record => {
            const identityKey = String(record?.identityKey || '');
            const lineage = hallLineage(identityKey);
            const biography = lineage ? AgentBiography.fromRecord(record) : null;
            if (!biography) return null;
            const book = buildBookOfLivesViewModel(record, { now });
            const providerLabel = providerPresentation(lineage.provider).badge.label;
            return {
                identityKey,
                scope: lineage.scope,
                provider: lineage.provider,
                // The name the lineage last wore; a legacy row keeps its slug.
                name: biography.displayName || lineage.slugName,
                role: lineage.scope === 'named' ? `${providerLabel} villager` : `${providerLabel} project lead`,
                nickname: biography.nickname || '',
                lastSeenAt: book.lastSeenAt,
                firstSeenLabel: book.firstSeenLabel,
                lastSeenLabel: book.lastReturnedLabel,
                chapters: book.visibleChapters.slice(-HALL_OF_LIVES_CHAPTER_LIMIT).reverse(),
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.identityKey.localeCompare(b.identityKey));
}

const CHRONICLE_EXPORT_MIME = {
    markdown: 'text/markdown;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
};

const CHRONICLE_READ_FAILURE_EVENT = 'chronicle:read-failed';
const CHRONICLE_EXPORT_FAILURE_EVENT = 'chronicle:export-failed';

function clockTime(ts) {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function eventText(event) {
    const who = event.agentName || 'someone';
    const where = event.project ? ` · ${event.project}` : '';
    const detailLabel = event.count !== undefined ? event.eventLabel : event.label;
    switch (event.kind) {
        case ChronicleEventKind.ARRIVED: return `${who} arrived${where}`;
        case ChronicleEventKind.DEPARTED: return `${who} left${where}`;
        case ChronicleEventKind.COMPLETED: return `${who} finished a turn${where}`;
        case ChronicleEventKind.WAITING: {
            const reason = REASON_TEXT[event.reason];
            const tool = event.tool ? ` (${event.tool})` : '';
            return `${who} ${reason || 'waited for you'}${tool}${where}`;
        }
        case ChronicleEventKind.RESOLVED:
            return `${who} was answered after ${duration(event.waitedMs || 0)}${where}`;
        case ChronicleEventKind.ERRORED: return `${who} hit an error${where}`;
        case ChronicleEventKind.RATE_LIMITED: return `${who} hit the rate limit${where}`;
        case ChronicleEventKind.COMMIT: return `${who} committed ${detailLabel || 'a change'}${where}`;
        case ChronicleEventKind.PUSH: {
            if (!event.outcome) return `${who} pushed ${detailLabel || ''}${where}`.trim();
            const what = event.outcome === 'rejected' ? 'was rejected' : event.outcome === 'cancelled' ? 'was cancelled' : 'failed';
            return `${who}'s push ${what}${detailLabel ? ` (${detailLabel})` : ''}${where}`;
        }
        case ChronicleEventKind.MENDED: {
            const was = Number.isFinite(Number(event.failedExit)) && event.failedExit !== null ? ` (was exit ${event.failedExit})` : '';
            return `${who} mended ${detailLabel || 'a failing command'}${was}${where}`;
        }
        case CHRONICLE_COMPACTED_KIND: {
            const detail = detailLabel ? ` (${detailLabel})` : '';
            return `${who} compacted context${detail}${where}`;
        }
        case CHRONICLE_RELEASE_KIND:
            return `${who} released ${detailLabel || 'a version'}${where}`;
        default: return `${who} ${event.kind}${where}`;
    }
}

/**
 * Decode an optional 96-bit quarter-hour coverage mask into a 96-byte array
 * of 0/1 flags. Returns null when coverage is unknown/missing so callers can
 * render missing hours honestly as uncovered linen.
 */
export function decodeCoverageMask(coverage) {
    if (coverage === null || coverage === undefined) return null;
    const raw = (typeof coverage === 'object' && !Array.isArray(coverage) && !ArrayBuffer.isView(coverage))
        ? (coverage.bits ?? coverage.mask ?? coverage.quarters ?? null)
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
    if (raw instanceof Uint32Array || (Array.isArray(raw) && raw.length === 3)) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) {
            const word = Number(raw[q >> 5]) >>> 0;
            quarters[q] = (word >>> (q & 31)) & 1;
        }
        return quarters;
    }
    if (raw instanceof Uint8Array || (Array.isArray(raw) && raw.length === 12)) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) {
            const byte = Number(raw[q >> 3]) & 0xff;
            quarters[q] = (byte >> (q & 7)) & 1;
        }
        return quarters;
    }
    if ((Array.isArray(raw) || ArrayBuffer.isView(raw)) && raw.length === COVERAGE_QUARTERS) {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) quarters[q] = raw[q] ? 1 : 0;
        return quarters;
    }
    if ((Array.isArray(raw) || ArrayBuffer.isView(raw)) && raw.length === 24) {
        for (let h = 0; h < 24; h++) {
            const covered = raw[h] ? 1 : 0;
            for (let q = 0; q < 4; q++) quarters[h * 4 + q] = covered;
        }
        return quarters;
    }
    return null;
}

/** Encode a 96-quarter truthy array or BigInt into a 12-byte coverage mask. */
export function encodeCoverageMask(input) {
    const bytes = new Uint8Array(12);
    if (typeof input === 'bigint') {
        for (let q = 0; q < COVERAGE_QUARTERS; q++) {
            if ((input >> BigInt(q)) & 1n) bytes[q >> 3] |= 1 << (q & 7);
        }
        return bytes;
    }
    if (Array.isArray(input) || ArrayBuffer.isView(input)) {
        const limit = Math.min(COVERAGE_QUARTERS, input.length);
        for (let q = 0; q < limit; q++) {
            if (input[q]) bytes[q >> 3] |= 1 << (q & 7);
        }
    }
    return bytes;
}

/** Resolve diurnal band boundaries for a Chronicle day (supplied solar times or date's real sun). */
export function resolveChronicleSolar({ dateKey = null, solar } = {}) {
    if (solar !== undefined) return resolveDiurnalBands({ solar });
    if (typeof dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        try {
            const day = solarDayFor(chronicleDateFromKey(dateKey));
            return resolveDiurnalBands({ solar: day });
        } catch {
            return resolveDiurnalBands();
        }
    }
    return resolveDiurnalBands();
}

function sunAltitudeAtMinute(minuteOfDay, bands) {
    const sunrise = bands.sunriseMinute;
    const sunset = bands.sunsetMinute;
    const daySpan = Math.max(60, sunset - sunrise);
    if (minuteOfDay >= sunrise && minuteOfDay <= sunset) {
        return Math.sin(((minuteOfDay - sunrise) / daySpan) * Math.PI);
    }
    const nightSpan = Math.max(60, 1440 - daySpan);
    const sinceSunset = minuteOfDay > sunset
        ? minuteOfDay - sunset
        : (1440 - sunset) + minuteOfDay;
    return -Math.sin((sinceSunset / nightSpan) * Math.PI);
}

/**
 * Pure 24-hour Sun-Arc Ribbon data model for ChroniclePanel and tests.
 * Unknown/missing coverage is represented honestly as uncovered (`covered: false`).
 */
export function buildSunArcModel({
    dateKey = chronicleDateKey(),
    events = [],
    coverage = null,
    sky = null,
    solar,
} = {}) {
    const bands = resolveChronicleSolar({ dateKey, solar });
    const coverageBits = decodeCoverageMask(coverage);
    const hours = Array.from({ length: 24 }, (_, hour) => {
        const midpoint = hour * 60 + 30;
        const quarters = coverageBits
            ? [
                coverageBits[hour * 4],
                coverageBits[hour * 4 + 1],
                coverageBits[hour * 4 + 2],
                coverageBits[hour * 4 + 3],
            ]
            : [0, 0, 0, 0];
        const coveredQuarters = quarters[0] + quarters[1] + quarters[2] + quarters[3];
        const skyCode = Array.isArray(sky)
            ? (sky[hour] ?? null)
            : (sky && typeof sky === 'object' ? (sky[hour] ?? null) : null);
        return {
            hour,
            band: diurnalBandForMinute(midpoint, bands),
            covered: coveredQuarters > 0,
            coveredQuarters,
            quarters,
            sunAltitude: sunAltitudeAtMinute(midpoint, bands),
            commits: 0,
            pushes: 0,
            releases: 0,
            brassTicks: 0,
            waits: 0,
            errors: 0,
            rateLimits: 0,
            compactions: 0,
            totalEvents: 0,
            hasWait: false,
            hasError: false,
            hasRateLimit: false,
            statusPip: null,
            skyCode,
            firstTs: null,
        };
    });

    for (const event of orderedEvents(events)) {
        if (!event || typeof event !== 'object') continue;
        const ts = Number(event.ts);
        if (!Number.isFinite(ts)) continue;
        const hour = new Date(ts).getHours();
        const slot = hours[hour];
        if (!slot) continue;
        slot.totalEvents += 1;
        if (slot.firstTs === null || ts < slot.firstTs) slot.firstTs = ts;
        const kind = timelineKind(event);
        if (kind === ChronicleEventKind.COMMIT) {
            slot.commits += 1;
            slot.brassTicks += 1;
        } else if (kind === ChronicleEventKind.PUSH) {
            slot.pushes += 1;
            slot.brassTicks += 1;
        } else if (kind === CHRONICLE_RELEASE_KIND) {
            slot.releases += 1;
            slot.brassTicks += 1;
        } else if (kind === ChronicleEventKind.WAITING) {
            slot.waits += 1;
            slot.hasWait = true;
        } else if (kind === ChronicleEventKind.ERRORED) {
            slot.errors += 1;
            slot.hasError = true;
        } else if (kind === ChronicleEventKind.RATE_LIMITED) {
            slot.rateLimits += 1;
            slot.hasRateLimit = true;
        } else if (kind === CHRONICLE_COMPACTED_KIND) {
            slot.compactions += 1;
        }
    }

    for (const slot of hours) {
        if (slot.hasError) slot.statusPip = 'errored';
        else if (slot.hasRateLimit) slot.statusPip = 'rate_limited';
        else if (slot.hasWait) slot.statusPip = 'waiting';
    }

    return {
        dateKey,
        bands,
        hasCoverage: Boolean(coverageBits),
        hours,
    };
}

/**
 * Group Day Book entries into contiguous diurnal chapters (`Night`, `Dawn`,
 * `Day`, `Dusk`) while preserving chronological (or newest-first) order.
 */
export function groupEventsIntoDiurnalChapters(events = [], {
    dateKey = chronicleDateKey(),
    solar,
    newestFirst = false,
    fold = true,
} = {}) {
    const bands = resolveChronicleSolar({ dateKey, solar });
    const base = fold ? foldTimeline(events) : orderedEvents(events);
    const rows = newestFirst ? [...base].reverse() : base;
    const chapters = [];
    let current = null;

    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const ts = Number(row.ts);
        const hour = Number.isFinite(ts) ? new Date(ts).getHours() : 0;
        const band = Number.isFinite(ts) ? diurnalBandForTimestamp(ts, bands) : 'night';
        const kind = timelineKind(row);
        const entry = {
            ...row,
            kind,
            band,
            hour,
            glyph: KIND_GLYPH[kind] || '·',
        };
        if (!current || current.band !== band) {
            current = {
                id: `${band}-${chapters.length}`,
                band,
                label: DIURNAL_BAND_LABELS[band] || band,
                hours: [],
                firstTs: Number.isFinite(ts) ? ts : null,
                lastTs: Number.isFinite(ts) ? ts : null,
                count: 0,
                entries: [],
            };
            chapters.push(current);
        }
        current.entries.push(entry);
        current.count += 1;
        if (!current.hours.includes(hour)) current.hours.push(hour);
        if (Number.isFinite(ts)) {
            if (current.firstTs === null || ts < current.firstTs) current.firstTs = ts;
            if (current.lastTs === null || ts > current.lastTs) current.lastTs = ts;
        }
    }

    return { dateKey, bands, chapters };
}

/** Map a click/pointer x offset across the Sun-Arc width into an integer hour 0..23. */
export function sunArcHourFromOffset(offsetX, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const clamped = Math.max(0, Math.min(safeWidth - 1e-6, Number(offsetX) || 0));
    return Math.max(0, Math.min(23, Math.floor((clamped / safeWidth) * 24)));
}

/** Paint the 36 px Sun-Arc Ribbon onto a 2D canvas or rendering context (pixel-exact). */
export function drawSunArcRibbon(canvasOrCtx, model, {
    width = null,
    height = SUN_ARC_HEIGHT,
    selectedHour = null,
    hoverHour = null,
} = {}) {
    const isCanvas = typeof canvasOrCtx?.getContext === 'function';
    const ctx = isCanvas ? canvasOrCtx.getContext('2d') : canvasOrCtx;
    if (!ctx || typeof ctx.fillRect !== 'function' || !model?.hours?.length) return false;

    const w = Math.max(24, Math.floor(Number(width ?? canvasOrCtx?.width) || 648));
    const h = Math.max(24, Math.floor(Number(height ?? canvasOrCtx?.height) || SUN_ARC_HEIGHT));
    if (isCanvas) {
        if (canvasOrCtx.width !== w) canvasOrCtx.width = w;
        if (canvasOrCtx.height !== h) canvasOrCtx.height = h;
    }
    ctx.imageSmoothingEnabled = false;

    const horizonY = Math.floor(h * 0.56);
    const colStart = hour => Math.floor((hour * w) / 24);

    // 1. Hour columns: covered quarters paint diurnal sky; uncovered stay bare linen.
    for (let hour = 0; hour < 24; hour++) {
        const slot = model.hours[hour];
        const x0 = colStart(hour);
        const x1 = colStart(hour + 1);
        const colW = Math.max(1, x1 - x0);
        const sky = SUN_ARC_SKY[slot.band] || SUN_ARC_SKY.night;

        for (let q = 0; q < 4; q++) {
            const qx0 = x0 + Math.floor((q * colW) / 4);
            const qx1 = x0 + Math.floor(((q + 1) * colW) / 4);
            const qw = Math.max(1, qx1 - qx0);
            if (slot.quarters[q]) {
                ctx.fillStyle = sky.top;
                ctx.fillRect(qx0, 0, qw, horizonY);
                ctx.fillStyle = sky.bottom;
                ctx.fillRect(qx0, horizonY, qw, h - horizonY);
            } else {
                ctx.fillStyle = SUN_ARC_INK.linen;
                ctx.fillRect(qx0, 0, qw, h);
                ctx.fillStyle = SUN_ARC_INK.linenWarp;
                for (let wx = qx0 + ((4 - (qx0 % 4)) % 4); wx < qx1; wx += 4) {
                    ctx.fillRect(wx, 0, 1, h);
                }
            }
        }
    }

    // 2. Subtle horizon rule and 6-hour column dividers.
    ctx.fillStyle = SUN_ARC_INK.horizon;
    ctx.fillRect(0, horizonY, w, 1);
    ctx.fillStyle = SUN_ARC_INK.grid;
    for (let hour = 1; hour < 24; hour++) {
        const x = colStart(hour);
        const major = hour % 6 === 0;
        ctx.fillRect(x, major ? 0 : h - 4, 1, major ? h : 4);
    }

    // 3. Pixel-stepped sun-arc curve across the 24 hours.
    const amp = Math.max(4, Math.floor(h * 0.34));
    for (let hour = 0; hour < 24; hour++) {
        const slot = model.hours[hour];
        const x0 = colStart(hour);
        const x1 = colStart(hour + 1);
        const y = Math.max(2, Math.min(h - 3, Math.round(horizonY - slot.sunAltitude * amp)));
        ctx.fillStyle = slot.sunAltitude >= 0 ? SUN_ARC_INK.arcDay : SUN_ARC_INK.arcNight;
        ctx.fillRect(x0 + 1, y, Math.max(1, x1 - x0 - 2), 1);
    }

    // 4. Brass ticks for commits/pushes/releases and status pips for waits/errors.
    for (let hour = 0; hour < 24; hour++) {
        const slot = model.hours[hour];
        const x0 = colStart(hour);
        const x1 = colStart(hour + 1);
        const colW = Math.max(1, x1 - x0);

        if (slot.brassTicks > 0) {
            const ticks = [];
            for (let i = 0; i < Math.min(2, slot.releases); i++) ticks.push({ height: 11, color: SUN_ARC_INK.goldHi, crown: true });
            for (let i = 0; i < Math.min(3, slot.pushes); i++) ticks.push({ height: 9, color: SUN_ARC_INK.gold, crown: false });
            for (let i = 0; i < Math.min(4, slot.commits); i++) ticks.push({ height: 6, color: SUN_ARC_INK.brass, crown: false });
            const visible = ticks.slice(0, Math.max(1, Math.min(4, Math.floor((colW - 2) / 3))));
            const span = visible.length * 3 - 1;
            const startX = x0 + Math.max(1, Math.floor((colW - span) / 2));
            for (let i = 0; i < visible.length; i++) {
                const tick = visible[i];
                const tx = startX + i * 3;
                const ty = Math.max(1, h - 1 - tick.height);
                ctx.fillStyle = tick.color;
                ctx.fillRect(tx, ty, 2, tick.height);
                if (tick.crown && tx > x0 && tx + 2 < x1) {
                    ctx.fillRect(tx - 1, ty, 4, 1);
                }
            }
        }

        const pips = [];
        if (slot.hasError) pips.push(THEME.error);
        if (slot.hasRateLimit) pips.push(THEME.rateLimited);
        if (slot.hasWait) pips.push(THEME.waitingOnUser);
        if (pips.length) {
            const pipSize = 3;
            const span = pips.length * (pipSize + 1) - 1;
            const px = x0 + Math.max(1, Math.floor((colW - span) / 2));
            for (let i = 0; i < pips.length; i++) {
                const x = px + i * (pipSize + 1);
                ctx.fillStyle = SUN_ARC_INK.seam;
                ctx.fillRect(x - 1, 2, pipSize + 2, pipSize + 2);
                ctx.fillStyle = pips[i];
                ctx.fillRect(x, 3, pipSize, pipSize);
            }
        }
    }

    // 5. Active/hover column highlight.
    for (const [targetHour, color] of [[hoverHour, SUN_ARC_INK.brass], [selectedHour, SUN_ARC_INK.goldHi]]) {
        if (!Number.isInteger(targetHour) || targetHour < 0 || targetHour > 23) continue;
        const x0 = colStart(targetHour);
        const colW = Math.max(1, colStart(targetHour + 1) - x0);
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, colW, 1);
        ctx.fillRect(x0, h - 1, colW, 1);
        ctx.fillRect(x0, 0, 1, h);
        ctx.fillRect(x0 + colW - 1, 0, 1, h);
    }

    return true;
}

function timelineKind(event) {
    const value = event?.kind ?? event?.type;
    return String(value ?? 'event').trim() || 'event';
}

function timelineKindLabel(kind, count = 1) {
    const normalized = humanizeTimelineKind(kind);
    const singular = TIMELINE_LABELS[normalized.toLowerCase()] || normalized;
    return Number(count) > 1 ? pluralizeTimelineLabel(singular) : singular;
}

function timelineMinute(ts) {
    const value = Number(ts);
    return Number.isFinite(value) ? Math.floor(value / 60_000) : null;
}

/** Fold same-kind events within each minute into deterministic chronological rows. */
export function foldTimeline(events = []) {
    const rows = [];
    // Folding is per minute and kind across the whole minute, not just over
    // adjacent rows: a burst stays one row per kind even when another kind is
    // interleaved. Each folded row keeps the position of its first member, so
    // the timeline order stays chronological and deterministic.
    const folded = new Map();
    for (const event of orderedEvents(events)) {
        if (!event || typeof event !== 'object') continue;
        const kind = timelineKind(event);
        const minute = timelineMinute(event.ts);
        const foldKey = minute === null ? null : `${minute}\u0000${kind}`;
        const previous = foldKey === null ? undefined : folded.get(foldKey);
        if (previous) {
            previous.count++;
            previous.label = timelineKindLabel(kind, previous.count);
            if (previous.project !== event.project) previous.project = null;
            continue;
        }
        const row = {
            ...event,
            kind,
            count: 1,
            label: timelineKindLabel(kind),
        };
        if (event.label !== undefined) row.eventLabel = event.label;
        rows.push(row);
        if (foldKey !== null) folded.set(foldKey, row);
    }
    return rows;
}

// `raw` is the number behind a formatted value; zeros recede to --ink-4.
function ledgerRow(label, value, raw = value) {
    const zero = Number(raw) === 0;
    return el('div', { className: zero ? ['chronicle__stat', 'chronicle__stat--zero'] : 'chronicle__stat' }, [
        el('span', { className: 'chronicle__stat-label' }, label),
        el('span', { className: 'chronicle__stat-value' }, String(value)),
    ]);
}

// One line, fixed shape: `Fri 25 Sep 2026`.
function chronicleDayHeading(date) {
    const part = options => date.toLocaleDateString('en-US', options);
    return `${part({ weekday: 'short' })} ${date.getDate()} ${part({ month: 'short' })} ${date.getFullYear()}`;
}

function openingLine(summary, isToday = true) {
    if (!summary.agents.length) {
        return isToday
            ? 'A quiet day. Nothing has passed through the village yet.'
            : 'No Chronicle entries were recorded on this day.';
    }
    const since = summary.firstTs ? `From ${clockTime(summary.firstTs)}` : (isToday ? 'Today' : 'That day');
    const agents = `${summary.agents.length} ${summary.agents.length === 1 ? 'agent' : 'agents'}`;
    const projects = summary.projects.length
        ? ` across ${summary.projects.length} ${summary.projects.length === 1 ? 'project' : 'projects'}`
        : '';
    return `${since}: ${agents}${projects}.`;
}

function orderedEvents(events) {
    return (Array.isArray(events) ? events : [])
        .map((event, index) => ({ event, index }))
        .sort((a, b) => (Number(a.event?.ts) || 0) - (Number(b.event?.ts) || 0) || a.index - b.index)
        .map(({ event }) => event);
}

function markdownCell(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\t/g, ' ')
        // Encode HTML before escaping Markdown punctuation. Entities render as
        // readable prose but cannot become tags in a permissive previewer.
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\|/g, '\\|')
        // Escaping the whole link/image delimiter prevents both inline and
        // reference-style Markdown destinations from becoming active.
        .replace(/!/g, '\\!')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function durationOrZero(ms) {
    return Number(ms) > 0 ? duration(ms) : '0m';
}

function summaryRows(summary) {
    return [
        ['Events', summary.totalEvents],
        ['Agents', summary.agents.length],
        ['Projects', summary.projects.length],
        ['Commits', summary.commits],
        ['Pushes', summary.pushes],
        ['Mended', summary.mends || 0],
        ['Turns done', summary.completed],
        ['Waited on you', summary.waits],
        ['Errors', summary.errors],
        ['Rate limits', summary.rateLimits],
        ['Total wait', durationOrZero(summary.totalWaitMs)],
        ['Longest wait', durationOrZero(summary.longestWaitMs)],
    ];
}

function projectKey(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return String(value.name ?? value.key ?? value.project ?? '').trim();
}

function projectSubtotals(summary, events) {
    const projects = Array.isArray(summary?.projects) ? summary.projects : [];
    const names = [];
    const counts = new Map();
    for (const project of projects) {
        const name = projectKey(project);
        if (!name || counts.has(name)) continue;
        names.push(name);
        counts.set(name, 0);
    }
    for (const event of Array.isArray(events) ? events : []) {
        const name = projectKey(event?.project);
        if (name && counts.has(name)) counts.set(name, counts.get(name) + 1);
    }
    return names.map(name => ({ name, count: counts.get(name) || 0 }));
}

function projectSubtotalNodes(summary, events) {
    const rows = projectSubtotals(summary, events);
    if (!rows.length) return [];
    return [
        el('div', { className: 'chronicle__project-subtotals' }, [
            el('div', { className: 'chronicle__project-heading' }, 'PROJECT SUBTOTALS'),
            ...rows.map(({ name, count }) => el('div', { className: 'chronicle__project-row' }, [
                el('span', { className: 'chronicle__project-name' }, name),
                el('span', { className: 'chronicle__project-count' }, `${formatNumber(count)} ${count === 1 ? 'event' : 'events'}`),
            ])),
        ]),
    ];
}

function spendRows(spend, dateKey) {
    if (spend?.readFailed) return [['Spend ledger', 'Could not read the spend ledger for this day.']];
    if (!spend) return dateKey === chronicleDateKey() ? [] : [
        ['Spend ledger', 'No spend record was saved for this day.'],
    ];
    const rows = [
        ['New tokens', spend.tokens, formatNumber(spend.tokens)],
        ['Cache reads', spend.cacheRead, formatNumber(spend.cacheRead)],
        [spend.costLabel || 'Est. cost', spend.cost, formatCost(spend.cost)],
    ];
    if (spend.largest) rows.push([`Largest ${spend.largest.kind} by new tokens`, spend.largest.key]);
    if (spend.coverageSince) rows.push(['Coverage began', spend.coverageSince, clockTime(spend.coverageSince)]);
    rows.push(['Coverage', 'Activity ClaudeVille observed while open in this browser.']);
    if (spend.historical) {
        rows.push(['Cost basis', 'Recorded cost can include provider-reported costs and API estimates.']);
        rows.push(['Model detail', 'Per-model totals are unavailable for past days.']);
    } else if (spend.subscription) {
        rows.push(['Cost basis', `Your ${spend.subscription} plan bills on quota. API equivalent shows what the observed tokens would cost at API rates.`]);
    }
    return rows;
}

/** Build paste-ready prose and tables for one retained Chronicle day. */
export function buildChronicleMarkdown({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const isToday = dateKey === chronicleDateKey();
    const lines = [
        `# Chronicle — ${markdownCell(dateKey)}`,
        '',
        markdownCell(openingLine(daySummary, isToday)),
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        ...summaryRows(daySummary).map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
    ];

    const spending = spendRows(spend, dateKey);
    if (spending.length) {
        lines.push(
            '',
            '## Spend summary',
            '',
            '| Metric | Value |',
            '| --- | ---: |',
            ...spending.map(([label, value, display = value]) => `| ${markdownCell(label)} | ${markdownCell(display)} |`),
        );
    }

    lines.push('', '## Timeline', '', '| Time | Glyph | Event |', '| --- | :---: | --- |');
    if (dayEvents.length) {
        lines.push(...dayEvents.map(event => (
            `| ${markdownCell(clockTime(event.ts))} | ${markdownCell(KIND_GLYPH[event.kind] || '·')} | ${markdownCell(eventText(event))} |`
        )));
    } else {
        lines.push('| — | — | No Chronicle entries were recorded on this day. |');
    }

    return `${lines.join('\n')}\n`;
}

/** Escape one CSV cell, including Excel formula-injection protection. */
export function csvEscapeCell(value) {
    const text = value == null ? '' : String(value);
    // Spreadsheet applications may trim tabs, newlines, and other leading
    // controls before deciding whether a cell is a formula. Detect the first
    // visible character after that prefix, while preserving the original text
    // inside the CSV cell.
    const normalized = text.replace(/^[\s\p{C}]*/u, '');
    // A leading apostrophe makes Excel treat formula-like text as a literal.
    const safe = /^[=+\-@]/.test(normalized) ? `'${text}` : text;
    return /[",\r\n\t]/.test(safe)
        ? `"${safe.replace(/"/g, '""')}"`
        : safe;
}

/** Build a spreadsheet-friendly CSV with summary and event rows. */
export function buildChronicleCsv({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const rows = [[
        'row_type', 'date', 'time', 'glyph', 'event', 'kind', 'agent', 'provider',
        'project', 'reason', 'tool', 'waited_ms', 'metric', 'value',
    ]];

    for (const [metric, value] of summaryRows(daySummary)) {
        rows.push(['summary', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const [metric, value] of spendRows(spend, dateKey)) {
        rows.push(['spend', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const event of dayEvents) {
        rows.push([
            'event',
            dateKey,
            clockTime(event.ts),
            KIND_GLYPH[event.kind] || '·',
            eventText(event),
            event.kind,
            event.agentName,
            event.provider,
            event.project,
            event.reason,
            event.tool,
            event.waitedMs,
            '',
            '',
        ]);
    }

    return `${rows.map(row => row.map(csvEscapeCell).join(',')).join('\r\n')}\r\n`;
}

function downloadText(text, filename, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let link = null;
    try {
        link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.append(link);
        link.click();
    } finally {
        link?.remove();
        URL.revokeObjectURL(url);
    }
}

export class ChroniclePanel {
    constructor({
        modal,
        chronicleLog,
        spendLedger = null,
        usageGetter = null,
        toast = null,
        liveHistory = true,
        onExportTapestry = null,
        solarProvider = null,
    }) {
        this.modal = modal;
        // XP-2 — a retold window reads the live book, so only the live
        // Chronicle may offer a day to watch (simulator samples never do).
        this.liveHistory = liveHistory;
        this._viewSeq = 0;
        this.log = chronicleLog;
        this.spendLedger = spendLedger;
        this.usageGetter = usageGetter;
        this.toast = toast;
        this.onExportTapestry = typeof onExportTapestry === 'function' ? onExportTapestry : null;
        this.solarProvider = typeof solarProvider === 'function' ? solarProvider : null;
        this._request = null;
        this._dateReadSeq = 0;
        this._selectedDateKey = null;
        this._selectedSpend = null;
        this._selectedPage = null;
        this._selectedHour = null;
        this._avatars = [];
        this._destroyed = false;
    }

    async open() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        this._request = request;
        const dateKey = chronicleDateKey();
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && this.modal.isRequestCurrent(request)
            ) {
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load today\'s Chronicle.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || !this.modal.isRequestCurrent(request)
        ) return;
        if (!this.modal.open('Village Chronicle', '', { wide: true, request })) return;
        this._selectedDateKey = dateKey;
        this._selectedSpend = page.spend;
        this._renderPage(page, dateKey, request);
    }

    async _readDayMeta(dateKey) {
        const readKey = async (key) => {
            if (typeof this.log?.readMeta === 'function') return this.log.readMeta(key);
            if (typeof this.log?.store?.getMeta === 'function') return this.log.store.getMeta(key, null);
            return null;
        };
        const [coverage, sky] = await Promise.all([
            readKey(`coverage:${dateKey}`).catch(() => null),
            readKey(`sky:${dateKey}`).catch(() => null),
        ]);
        return { coverage: coverage ?? null, sky: sky ?? null };
    }

    async _readPage(dateKey) {
        const [page, spend, replayable, meta] = await Promise.all([
            this._readTimelinePage(dateKey),
            this._readSpend(dateKey),
            // XP-2 — only a day with trail samples can be retold.
            this.liveHistory
                ? Promise.resolve(this.log.hasTrailSamples?.(dateKey)).then(Boolean, () => false)
                : false,
            this._readDayMeta(dateKey),
        ]);
        return { ...page, spend, replayable, coverage: meta.coverage, sky: meta.sky };
    }

    async _readTimelinePage(dateKey) {
        if (typeof this.log.readDayPage === 'function') {
            return this.log.readDayPage(dateKey, { limit: CHRONICLE_TIMELINE_PAGE_SIZE });
        }
        const all = await this.log.readDay(dateKey);
        return {
            events: all.slice(-CHRONICLE_TIMELINE_PAGE_SIZE).reverse(),
            summary: summarizeDay(all),
            totalCount: all.length,
        };
    }

    async _showDate(dateKey, request) {
        if (!dateKey || request !== this._request) return;
        const readSeq = ++this._dateReadSeq;
        const viewSeq = ++this._viewSeq;
        if (dateKey === this._selectedDateKey) return;
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && readSeq === this._dateReadSeq
                && viewSeq === this._viewSeq
                && this.modal.isRequestCurrent(request)
            ) {
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load that Chronicle day.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || readSeq !== this._dateReadSeq
            || viewSeq !== this._viewSeq
            || !this.modal.isRequestCurrent(request)
        ) return;
        // Commit only after the read has succeeded and is still the current
        // request. The rendered controls then receive the same committed key.
        this._selectedDateKey = dateKey;
        this._selectedSpend = page.spend;
        this._renderPage(page, dateKey, request);
    }

    _reportFailure(eventName, message, details = {}) {
        if (this.toast?.show) {
            this.toast.show(message, 'warning');
            return;
        }
        eventBus.emit(eventName, { message, ...details });
    }

    async _readSpend(dateKey) {
        const historical = dateKey !== chronicleDateKey();
        let record;
        try {
            record = await this.spendLedger?.readDay(dateKey);
        } catch {
            return { readFailed: true };
        }
        if (!record) return null;
        const subscription = historical ? null : this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());
        return {
            ...record,
            historical,
            subscription: onPlan ? subscription : null,
            costLabel: historical ? 'Recorded cost' : onPlan ? 'API equivalent' : 'Est. cost',
        };
    }

    async _readExportData(dateKey) {
        const selectedDateKey = dateKey || chronicleDateKey();
        const [events, spend, meta] = await Promise.all([
            typeof this.log.readDay === 'function' ? this.log.readDay(selectedDateKey)
                : this._readTimelinePage(selectedDateKey).then(page => page.events),
            selectedDateKey === this._selectedDateKey ? this._selectedSpend : this._readSpend(selectedDateKey),
            selectedDateKey === this._selectedDateKey && this._selectedPage
                ? { coverage: this._selectedPage.coverage ?? null, sky: this._selectedPage.sky ?? null }
                : this._readDayMeta(selectedDateKey),
        ]);
        const dayEvents = Array.isArray(events) ? events : [];
        return {
            dateKey: selectedDateKey,
            events: dayEvents,
            summary: summarizeDay(dayEvents),
            spend,
            coverage: meta.coverage ?? null,
            sky: meta.sky ?? null,
        };
    }

    async _exportTapestry() {
        if (this._destroyed || typeof this.onExportTapestry !== 'function') return null;
        const dateKey = this._selectedDateKey || chronicleDateKey();
        const request = this._request;
        const readSeq = this._dateReadSeq;
        try {
            const data = await this._readExportData(dateKey);
            if (this._destroyed || request !== this._request || readSeq !== this._dateReadSeq
                || (this._selectedDateKey && dateKey !== this._selectedDateKey)
                || (this.modal?.isRequestCurrent && !this.modal.isRequestCurrent(request))) return null;
            return await this.onExportTapestry({
                dateKey: data.dateKey,
                events: data.events,
                summary: data.summary,
                coverage: data.coverage,
                sky: data.sky,
            });
        } catch (error) {
            this._reportFailure(
                CHRONICLE_EXPORT_FAILURE_EVENT,
                'Could not export the Chronicle as Tapestry PNG.',
                { format: 'tapestry', dateKey, error },
            );
            return null;
        }
    }

    async _export(format) {
        if (this._destroyed) return;
        const dateKey = this._selectedDateKey || chronicleDateKey();
        const request = this._request;
        const readSeq = this._dateReadSeq;
        try {
            const data = await this._readExportData(dateKey);
            // A date change during the read must never download the wrong day.
            if (this._destroyed || request !== this._request || readSeq !== this._dateReadSeq
                || dateKey !== this._selectedDateKey || !this.modal.isRequestCurrent(request)) return;
            const isCsv = format === 'csv';
            const text = isCsv ? buildChronicleCsv(data) : buildChronicleMarkdown(data);
            const extension = isCsv ? 'csv' : 'md';
            downloadText(text, `chronicle-${dateKey}.${extension}`, CHRONICLE_EXPORT_MIME[isCsv ? 'csv' : 'markdown']);
        } catch (error) {
            const formatLabel = format === 'csv' ? 'CSV' : 'Markdown';
            this._reportFailure(
                CHRONICLE_EXPORT_FAILURE_EVENT,
                `Could not export the Chronicle as ${formatLabel}.`,
                { format, dateKey, error },
            );
        }
    }

    _renderPage(page, dateKey, request) {
        const { events, summary, totalCount, spend, replayable, coverage = null, sky = null } = page;
        this._selectedPage = page;
        this._selectedHour = null;
        const content = this.modal.contentEl;
        if (content) {
            this._releaseAvatars();
            replaceChildren(content, [this._tabs('day', request), ...this._render(events, summary, {
                newestFirst: true,
                totalCount,
                dateKey,
                spend,
                replayable,
                coverage,
                sky,
                onDateChange: nextDate => this._showDate(nextDate, request),
            })]);
        }
    }

    // XP-8 — two tabs: the selected day, and the lineages the village remembers.
    _tabs(active, request) {
        const tab = (key, text) => {
            const button = el('button', {
                className: ['chronicle__tab', ...(key === active ? ['chronicle__tab--active'] : [])],
                text,
            });
            button.type = 'button';
            button.setAttribute('aria-pressed', String(key === active));
            if (key !== active) {
                button.addEventListener('click', () => (key === 'hall'
                    ? this._showHall(request)
                    : this._showDayBook(request)));
            }
            return button;
        };
        return el('div', { className: 'chronicle__tabs', ariaLabel: 'Chronicle view' }, [
            tab('day', 'Day book'),
            tab('hall', 'Hall of Lives'),
        ]);
    }

    _showDayBook(request) {
        // A pending Hall read must not reopen the Hall after this switch.
        this._viewSeq++;
        if (this._selectedPage && this.modal?.isRequestCurrent(request)) {
            this._renderPage(this._selectedPage, this._selectedDateKey, request);
        }
    }

    async _showHall(request) {
        if (this._destroyed || request !== this._request) return;
        // The view sequence also drops a pending date render; the date read
        // sequence (which guards exports) moves only with the date.
        const viewSeq = ++this._viewSeq;
        let records;
        try {
            records = typeof this.log.readBiographies === 'function' ? await this.log.readBiographies() : [];
        } catch (error) {
            if (!this._destroyed && request === this._request && viewSeq === this._viewSeq
                && this.modal.isRequestCurrent(request)) {
                this._reportFailure(CHRONICLE_READ_FAILURE_EVENT, 'Could not load the Hall of Lives.', { error });
            }
            return;
        }
        if (this._destroyed || request !== this._request || viewSeq !== this._viewSeq
            || !this.modal.isRequestCurrent(request)) return;
        const content = this.modal.contentEl;
        if (!content) return;
        this._releaseAvatars();
        replaceChildren(content, [this._tabs('hall', request), ...this._renderHall(buildHallOfLives(records))]);
    }

    _renderHall(lives) {
        const nodes = [el('p', { className: 'chronicle__opening' }, lives.length
            ? 'The lineages the village remembers, most recently seen first.'
            : 'The village remembers no lineages yet.')];
        if (lives.length) {
            nodes.push(el('ul', { className: 'chronicle__lives' }, lives.map(life => this._lifeNode(life))));
        }
        nodes.push(el('p', { className: 'chronicle__note' },
            'A lineage is a named villager or a project lead, one per provider and repository. '
            + 'The village forgets a lineage 180 days after it was last seen.'));
        return nodes;
    }

    _lifeNode(life) {
        const avatar = new AvatarCanvas({
            id: life.identityKey,
            provider: life.provider,
            model: null,
            effort: null,
            appearance: Appearance.fromIdentityKey(life.identityKey),
        }, 'niche');
        this._avatars.push(avatar);
        const chapters = life.chapters.length
            ? el('ul', { className: 'chronicle__life-chapters' }, life.chapters.map(chapter => (
                el('li', { className: 'chronicle__life-chapter' }, [
                    el('span', { className: 'chronicle__life-chapter-copy' }, chapter.copy),
                    el('span', { className: 'chronicle__life-chapter-date' }, chapter.dateLabel),
                ])
            )))
            : el('p', { className: 'chronicle__life-empty' }, 'No chapters recorded yet.');
        return el('li', { className: 'chronicle__life' }, [
            el('div', { className: 'chronicle__life-bust' }, [avatar.canvas]),
            el('div', { className: 'chronicle__life-body' }, [
                el('div', { className: 'chronicle__life-heading' }, [
                    el('span', { className: 'chronicle__life-name' }, life.name),
                    ...(life.nickname ? [el('span', { className: 'chronicle__life-nickname' }, life.nickname)] : []),
                ]),
                el('div', { className: 'chronicle__life-meta' },
                    `${life.role} · first seen ${life.firstSeenLabel} · last seen ${life.lastSeenLabel}`),
                chapters,
            ]),
        ]);
    }

    _releaseAvatars() {
        for (const avatar of this._avatars) avatar.destroy();
        this._avatars = [];
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._dateReadSeq++;
        this.modal?.invalidateRequest?.(this._request);
        this._request = null;
        this._selectedSpend = null;
        this._selectedPage = null;
        this._releaseAvatars();
        this.modal = null;
        this.log = null;
        this.spendLedger = null;
        this.usageGetter = null;
        this.toast = null;
        this.onExportTapestry = null;
        this.solarProvider = null;
    }

    _spendNodes(spend, dateKey) {
        const rows = spendRows(spend, dateKey);
        const stats = spend && !spend.readFailed ? rows.splice(0, 3) : [];
        const nodes = stats.length ? [el('div', { className: 'chronicle__ledger' }, stats.map(
            ([label, value, display]) => ledgerRow(label.toUpperCase(), display, value),
        ))] : [];
        for (const [label, value, display = value] of rows) {
            nodes.push(el('p', { className: 'chronicle__note' }, `${label} · ${display}`));
        }
        return nodes;
    }

    _datePicker(dateKey, onDateChange, replayable = false) {
        const retentionDays = Number(this.log?.retentionDays) || 14;
        const window = chronicleDateWindow(Date.now(), retentionDays);
        const shiftDate = offset => {
            const shifted = chronicleDateFromKey(dateKey);
            shifted.setDate(shifted.getDate() + offset);
            return chronicleDateKey(shifted);
        };
        const previousKey = shiftDate(-1);
        const nextKey = shiftDate(1);
        // 7.6 — one line of text controls: PREVIOUS · the day · NEXT · TODAY.
        // No native date field: the retention window is a couple of weeks,
        // and the stepped buttons walk all of it.
        const previousButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Previous',
            title: 'Show the previous retained Chronicle day',
            ariaLabel: 'Show previous Chronicle day',
        });
        previousButton.type = 'button';
        previousButton.disabled = dateKey <= window.min;
        previousButton.addEventListener('click', () => onDateChange?.(previousKey));

        const nextButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Next',
            title: 'Show the next Chronicle day',
            ariaLabel: 'Show next Chronicle day',
        });
        nextButton.type = 'button';
        nextButton.disabled = dateKey >= window.max;
        nextButton.addEventListener('click', () => onDateChange?.(nextKey));

        const todayButton = el('button', {
            className: ['chronicle__date-button', 'chronicle__today-button'],
            text: 'Today',
            title: 'Return to today\'s Chronicle',
            ariaLabel: 'Show today\'s Chronicle',
        });
        todayButton.type = 'button';
        todayButton.addEventListener('click', () => onDateChange?.(window.max));

        const markdownButton = el('button', {
            className: 'chronicle__export-button',
            text: 'Markdown',
            title: 'Download the selected day as Markdown',
            ariaLabel: 'Download selected Chronicle day as Markdown',
        });
        markdownButton.type = 'button';
        markdownButton.addEventListener('click', () => this._export('markdown'));
        const csvButton = el('button', {
            className: 'chronicle__export-button',
            text: 'CSV',
            title: 'Download the selected day as CSV',
            ariaLabel: 'Download selected Chronicle day as CSV',
        });
        csvButton.type = 'button';
        csvButton.addEventListener('click', () => this._export('csv'));
        const tapestryAvailable = typeof this.onExportTapestry === 'function';
        const tapestryButton = el('button', {
            className: ['chronicle__export-button', 'chronicle__tapestry-button'],
            text: 'Tapestry PNG',
            title: tapestryAvailable
                ? 'Export this Chronicle day as an illustrated Tapestry PNG'
                : 'Tapestry PNG export is not available in this view',
            ariaLabel: 'Export selected Chronicle day as Tapestry PNG',
        });
        tapestryButton.type = 'button';
        tapestryButton.disabled = !tapestryAvailable;
        if (tapestryAvailable) {
            tapestryButton.addEventListener('click', () => this._exportTapestry());
        }
        const actions = [tapestryButton, markdownButton, csvButton];
        if (replayable) {
            // XP-2 — the recorded day plays in its own window, chipped RETOLD.
            const watchButton = el('button', {
                className: ['chronicle__export-button', 'chronicle__watch-button'],
                text: 'Watch this day',
                title: 'Replay this recorded day in a separate window',
                ariaLabel: 'Watch this Chronicle day in a separate window',
            });
            watchButton.type = 'button';
            watchButton.addEventListener('click', () => {
                window.open(retoldVillageHref(location.pathname, dateKey), '_blank', 'noopener');
            });
            actions.unshift(watchButton);
        }
        const heading = chronicleDayHeading(chronicleDateFromKey(dateKey));
        return el('div', { className: 'chronicle__date-controls' }, [
            el('div', { className: 'chronicle__date-navigation' }, [
                previousButton,
                el('span', { className: 'chronicle__date-heading' }, heading),
                nextButton,
                todayButton,
            ]),
            el('span', { className: 'chronicle__export-actions' }, actions),
        ]);
    }

    _scrollToHour(hour, band = null) {
        const container = this.modal?.contentEl;
        if (!container || typeof container.querySelector !== 'function') return false;
        const previousTargets = typeof container.querySelectorAll === 'function'
            ? container.querySelectorAll('.chronicle__entry--target')
            : [];
        for (const node of previousTargets) node.classList?.remove?.('chronicle__entry--target');
        const target = container.querySelector(`.chronicle__entry[data-chronicle-hour="${hour}"]`)
            || (band ? container.querySelector(`.chronicle__chapter[data-chronicle-band="${band}"]`) : null);
        if (!target) return false;
        target.classList?.add?.('chronicle__entry--target');
        target.scrollIntoView?.({ behavior: 'auto', block: 'start' });
        return true;
    }

    _sunArcNode(model) {
        const readout = el('span', { className: 'chronicle__sun-arc-readout' },
            model.hasCoverage ? 'Click an hour to jump' : 'Unrecorded hours shown as bare linen');
        const canvas = el('canvas', {
            className: 'chronicle__sun-arc-canvas',
            ariaLabel: '24-hour diurnal sun-arc ribbon; click an hour to jump to its Day Book entries',
            dataset: { dateKey: model.dateKey },
        });
        canvas.width = 648;
        canvas.height = SUN_ARC_HEIGHT;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('tabindex', '0');

        let hoverHour = null;
        const describeHour = (hour) => {
            const slot = model.hours[hour];
            if (!slot) return '';
            const hh = String(hour).padStart(2, '0');
            const parts = [`${hh}:00 ${DIURNAL_BAND_LABELS[slot.band] || slot.band}`];
            if (!slot.covered) parts.push('uncovered');
            if (slot.commits) parts.push(`${slot.commits} ${slot.commits === 1 ? 'commit' : 'commits'}`);
            if (slot.pushes) parts.push(`${slot.pushes} ${slot.pushes === 1 ? 'push' : 'pushes'}`);
            if (slot.releases) parts.push(`${slot.releases} ${slot.releases === 1 ? 'release' : 'releases'}`);
            if (slot.waits) parts.push(`${slot.waits} ${slot.waits === 1 ? 'wait' : 'waits'}`);
            if (slot.errors) parts.push(`${slot.errors} ${slot.errors === 1 ? 'error' : 'errors'}`);
            return parts.join(' · ');
        };
        const repaint = () => {
            const width = Math.max(240, Math.round(canvas.clientWidth || canvas.width || 648));
            drawSunArcRibbon(canvas, model, {
                width,
                height: SUN_ARC_HEIGHT,
                selectedHour: this._selectedHour,
                hoverHour,
            });
        };
        const selectHour = (hour) => {
            this._selectedHour = hour;
            canvas.dataset.selectedHour = String(hour);
            readout.textContent = describeHour(hour);
            repaint();
            this._scrollToHour(hour, model.hours[hour]?.band || null);
        };
        const hourFromEvent = (event) => {
            const rect = typeof canvas.getBoundingClientRect === 'function'
                ? canvas.getBoundingClientRect()
                : { left: 0, width: canvas.width || 648 };
            return sunArcHourFromOffset((Number(event?.clientX) || 0) - rect.left, rect.width || canvas.width || 648);
        };
        canvas.addEventListener('pointermove', (event) => {
            const next = hourFromEvent(event);
            if (next === hoverHour) return;
            hoverHour = next;
            readout.textContent = describeHour(next);
            repaint();
        });
        canvas.addEventListener('pointerleave', () => {
            hoverHour = null;
            readout.textContent = this._selectedHour !== null
                ? describeHour(this._selectedHour)
                : (model.hasCoverage ? 'Click an hour to jump' : 'Unrecorded hours shown as bare linen');
            repaint();
        });
        canvas.addEventListener('click', (event) => selectHour(hourFromEvent(event)));
        canvas.addEventListener('keydown', (event) => {
            const current = this._selectedHour ?? 12;
            if (event.key === 'ArrowRight') {
                event.preventDefault?.();
                selectHour((current + 1) % 24);
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault?.();
                selectHour((current + 23) % 24);
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault?.();
                selectHour(current);
            }
        });
        repaint();

        return el('section', { className: 'chronicle__sun-arc', ariaLabel: '24-hour sun arc' }, [
            el('div', { className: 'chronicle__sun-arc-header' }, [
                el('span', { className: 'chronicle__sun-arc-title' }, '24H SUN ARC'),
                readout,
            ]),
            canvas,
            el('div', { className: 'chronicle__sun-arc-scale' }, [
                el('span', {}, '00'),
                el('span', {}, '06'),
                el('span', {}, '12'),
                el('span', {}, '18'),
                el('span', {}, '24'),
            ]),
        ]);
    }

    _render(events, summary, {
        newestFirst = false,
        totalCount = events.length,
        dateKey = chronicleDateKey(),
        onDateChange = null,
        spend = null,
        replayable = false,
        coverage = null,
        sky = null,
        solar = undefined,
    } = {}) {
        const isToday = dateKey === chronicleDateKey();
        const resolvedSolar = solar !== undefined ? solar : this.solarProvider?.(dateKey);
        const sunArcModel = buildSunArcModel({
            dateKey,
            events,
            coverage,
            sky,
            solar: resolvedSolar,
        });
        const nodes = [
            this._datePicker(dateKey, onDateChange, replayable),
            el('p', { className: 'chronicle__opening' }, openingLine(summary, isToday)),
            this._sunArcNode(sunArcModel),
        ];

        nodes.push(el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('COMMITS', summary.commits),
            ledgerRow('PUSHES', summary.pushes),
            ledgerRow('TURNS DONE', summary.completed),
            ledgerRow('WAITED ON YOU', summary.waits),
            ledgerRow('ERRORS', summary.errors),
            ledgerRow('RATE LIMITS', summary.rateLimits),
        ]));
        nodes.push(...projectSubtotalNodes(summary, events));

        nodes.push(...this._spendNodes(spend, dateKey));

        if (summary.longestWaitMs > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Longest wait for you: ${duration(summary.longestWaitMs)}.`));
        }

        if (!events.length) {
            nodes.push(el('p', { className: 'chronicle__note' },
                isToday
                    ? 'The day book fills as agents work — it records only what happens while ClaudeVille is open.'
                    : 'Choose another date to continue browsing the retained Chronicle.'));
            return nodes;
        }

        // Newest first: the recap answers "what did I miss" before "how did the
        // day start", while same-minute bursts stay on one intelligible row,
        // grouped into diurnal chapters matching the Sun-Arc sky bands.
        const { chapters } = groupEventsIntoDiurnalChapters(events, {
            dateKey,
            solar: resolvedSolar,
            newestFirst,
            fold: true,
        });
        nodes.push(el('div', { className: 'chronicle__chapters' }, chapters.map(chapter => (
            el('section', {
                className: ['chronicle__chapter', `chronicle__chapter--${chapter.band}`],
                dataset: { chronicleBand: chapter.band },
            }, [
                el('div', { className: 'chronicle__chapter-header' }, [
                    el('span', { className: 'chronicle__chapter-title' }, chapter.label.toUpperCase()),
                    el('span', { className: 'chronicle__chapter-meta' },
                        `${chapter.count} ${chapter.count === 1 ? 'entry' : 'entries'}`),
                ]),
                el('ul', { className: 'chronicle__timeline' }, chapter.entries.map(row => {
                    const text = row.count > 1
                        ? `${row.label} ×${row.count}${row.project ? ` · ${row.project}` : ''}`
                        : eventText(row);
                    return el('li', {
                        className: `chronicle__entry chronicle__entry--${row.kind}`,
                        dataset: { chronicleHour: row.hour, chronicleBand: row.band },
                    }, [
                        el('span', { className: 'chronicle__time' }, clockTime(row.ts)),
                        el('span', { className: 'chronicle__glyph' }, row.glyph),
                        el('span', { className: 'chronicle__text' }, text),
                    ]);
                })),
            ])
        ))));
        const omitted = Math.max(0, totalCount - events.length);
        if (omitted > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Showing the newest ${events.length} of ${totalCount} events.`));
        }

        return nodes;
    }
}
