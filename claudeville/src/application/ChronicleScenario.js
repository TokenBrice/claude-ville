// Replay offsets use elapsed milliseconds from local midnight, including DST.
import { dayBounds, chronicleDateKey } from './ChronicleLog.js';
import { VILLAGE_GATE } from '../config/townPlan.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { readRecordedDay, RECORDED_TRAIL_INTERVAL_MS } from '../infrastructure/ChronicleStore.js';

const DAY_MINUTES = 24 * 60;
const SUNRISE_KEY_MINUTE = 6 * 60;
const BLUE_HOUR_KEY_MINUTE = 19 * 60 + 45;
const PIN_COALESCE_WINDOW_MS = 15 * 60_000;
const MAX_EVENT_PINS = 20;

export const DIURNAL_BANDS = Object.freeze(['night', 'dawn', 'day', 'dusk']);
export const DIURNAL_BAND_LABELS = Object.freeze({
    night: 'Night',
    dawn: 'Dawn',
    day: 'Day',
    dusk: 'Dusk',
});

// Authored baseline solar boundaries matching AtmosphereState.js PHASES.
export const AUTHORED_DIURNAL_BANDS = Object.freeze({
    dawnStart: 5 * 60 + 30,
    dayStart: 7 * 60,
    duskStart: 17 * 60 + 30,
    nightStart: 20 * 60,
    sunriseMinute: 6 * 60,
    sunsetMinute: 18 * 60 + 45,
});

const NOTABLE_PIN_PRIORITY = Object.freeze({
    release: 6,
    push: 5,
    errored: 4,
    rate_limited: 3,
    waiting: 3,
    mended: 3,
    commit: 2,
    compacted: 2,
});

const PIN_KIND_LABEL = Object.freeze({
    release: 'Release',
    push: 'Push',
    errored: 'Error',
    rate_limited: 'Rate limit',
    waiting: 'Wait',
    mended: 'Mend',
    commit: 'Commit',
    compacted: 'Compaction',
});

const STATUS = new Map([
    ['completed', AgentStatus.COMPLETED],
    ['waiting', AgentStatus.WAITING_ON_USER],
    ['errored', AgentStatus.ERRORED],
    ['rate_limited', AgentStatus.RATE_LIMITED],
    ['resolved', AgentStatus.IDLE],
]);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Resolve four diurnal sky band boundaries (local minutes 0..1440) from
 * supplied solar times, day shifts, or authored defaults.
 */
export function resolveDiurnalBands({ solar = null } = {}) {
    if (solar && typeof solar === 'object') {
        const hasExplicit = [solar.dawnStart, solar.dayStart, solar.duskStart, solar.nightStart]
            .every(value => Number.isFinite(Number(value)));
        if (hasExplicit) {
            const dawnStart = clamp(Math.round(Number(solar.dawnStart)), 0, DAY_MINUTES - 90);
            const dayStart = clamp(Math.round(Number(solar.dayStart)), dawnStart + 15, DAY_MINUTES - 60);
            const duskStart = clamp(Math.round(Number(solar.duskStart)), dayStart + 30, DAY_MINUTES - 15);
            const nightStart = clamp(Math.round(Number(solar.nightStart)), duskStart + 15, DAY_MINUTES);
            const sunriseMinute = Number.isFinite(Number(solar.sunriseMinute))
                ? clamp(Number(solar.sunriseMinute), dawnStart, dayStart)
                : Math.round((dawnStart + dayStart) / 2);
            const sunsetMinute = Number.isFinite(Number(solar.sunsetMinute))
                ? clamp(Number(solar.sunsetMinute), duskStart, nightStart)
                : Math.round((duskStart + nightStart) / 2);
            return Object.freeze({ dawnStart, dayStart, duskStart, nightStart, sunriseMinute, sunsetMinute });
        }

        if (Number.isFinite(Number(solar.sunriseShift)) && Number.isFinite(Number(solar.sunsetShift))) {
            const sr = clamp(Number(solar.sunriseShift), -120, 180);
            const ss = clamp(Number(solar.sunsetShift), -270, 180);
            const dawnStart = clamp(Math.round(AUTHORED_DIURNAL_BANDS.dawnStart + sr), 0, 720);
            const dayStart = clamp(Math.round(AUTHORED_DIURNAL_BANDS.dayStart + sr), dawnStart + 15, 780);
            const duskStart = clamp(Math.round(AUTHORED_DIURNAL_BANDS.duskStart + ss), dayStart + 60, DAY_MINUTES - 30);
            const nightStart = clamp(Math.round(AUTHORED_DIURNAL_BANDS.nightStart + ss), duskStart + 15, DAY_MINUTES);
            const sunriseMinute = Number.isFinite(Number(solar.sunriseMinute))
                ? Number(solar.sunriseMinute)
                : clamp(SUNRISE_KEY_MINUTE + sr, dawnStart, dayStart);
            const sunsetMinute = Number.isFinite(Number(solar.sunsetMinute))
                ? Number(solar.sunsetMinute)
                : clamp(BLUE_HOUR_KEY_MINUTE + ss - 50, duskStart, nightStart);
            return Object.freeze({ dawnStart, dayStart, duskStart, nightStart, sunriseMinute, sunsetMinute });
        }

        if (Number.isFinite(Number(solar.sunriseMinute)) && Number.isFinite(Number(solar.sunsetMinute))) {
            const sunrise = clamp(Number(solar.sunriseMinute), 60, 720);
            const sunset = clamp(Number(solar.sunsetMinute), Math.max(sunrise + 120, 780), DAY_MINUTES - 30);
            const civilDawn = Number.isFinite(Number(solar.civilDawnMinute))
                ? clamp(Number(solar.civilDawnMinute), 0, sunrise)
                : clamp(sunrise - 30, 0, sunrise);
            const civilDusk = Number.isFinite(Number(solar.civilDuskMinute))
                ? clamp(Number(solar.civilDuskMinute), sunset, DAY_MINUTES)
                : clamp(sunset + 45, sunset, DAY_MINUTES);
            const dawnStart = clamp(Math.round(civilDawn), 0, Math.round(sunrise));
            const dayStart = clamp(Math.round(sunrise + 60), dawnStart + 15, Math.round(sunset) - 60);
            const duskStart = clamp(Math.round(sunset - 45), dayStart + 30, Math.round(sunset));
            const nightStart = clamp(Math.round(civilDusk + 15), duskStart + 15, DAY_MINUTES);
            return Object.freeze({
                dawnStart,
                dayStart,
                duskStart,
                nightStart,
                sunriseMinute: sunrise,
                sunsetMinute: sunset,
            });
        }
    }
    return AUTHORED_DIURNAL_BANDS;
}

export function diurnalBandForMinute(minuteOfDay, bands = AUTHORED_DIURNAL_BANDS) {
    const resolved = bands || AUTHORED_DIURNAL_BANDS;
    const minute = (((Number(minuteOfDay) || 0) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    if (minute >= resolved.dawnStart && minute < resolved.dayStart) return 'dawn';
    if (minute >= resolved.dayStart && minute < resolved.duskStart) return 'day';
    if (minute >= resolved.duskStart && minute < resolved.nightStart) return 'dusk';
    return 'night';
}

export function diurnalBandForTimestamp(ts, bands = AUTHORED_DIURNAL_BANDS) {
    const date = new Date(Number(ts) || 0);
    return diurnalBandForMinute(date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60, bands);
}

function formatClockHHMM(ts) {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function localMinuteToOffsetMs(lower, upper, minuteOfDay) {
    const span = Math.max(1, upper - lower);
    if (minuteOfDay <= 0) return 0;
    if (minuteOfDay >= DAY_MINUTES) return span;
    const start = new Date(lower);
    const hours = Math.floor(minuteOfDay / 60);
    const minutes = Math.round(minuteOfDay % 60);
    const target = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hours, minutes, 0, 0).getTime();
    return clamp(target - lower, 0, span);
}

/**
 * Derive Retold chapter metadata and clickable 24-hour scrubber pins from a
 * recorded day's diurnal bands and notable events. Pure and deterministic.
 */
export function buildRetoldChapters({ lower, upper }, { events = [] } = {}, { solar = null } = {}) {
    const startMs = Number(lower) || 0;
    const endMs = Math.max(startMs + 1, Number(upper) || startMs + 1);
    const spanMs = endMs - startMs;
    const bands = resolveDiurnalBands({ solar });

    const segments = [
        { id: 'night-early', band: 'night', label: DIURNAL_BAND_LABELS.night, startMin: 0, endMin: bands.dawnStart },
        { id: 'dawn', band: 'dawn', label: DIURNAL_BAND_LABELS.dawn, startMin: bands.dawnStart, endMin: bands.dayStart },
        { id: 'day', band: 'day', label: DIURNAL_BAND_LABELS.day, startMin: bands.dayStart, endMin: bands.duskStart },
        { id: 'dusk', band: 'dusk', label: DIURNAL_BAND_LABELS.dusk, startMin: bands.duskStart, endMin: bands.nightStart },
        { id: 'night-late', band: 'night', label: DIURNAL_BAND_LABELS.night, startMin: bands.nightStart, endMin: DAY_MINUTES },
    ];

    const chapters = segments.map(segment => {
        const segStart = localMinuteToOffsetMs(startMs, endMs, segment.startMin);
        const segEnd = localMinuteToOffsetMs(startMs, endMs, segment.endMin);
        return {
            id: segment.id,
            band: segment.band,
            label: segment.label,
            startMinute: segment.startMin,
            endMinute: segment.endMin,
            startMs: segStart,
            endMs: segEnd,
            clockMs: startMs + segStart,
            progress: clamp(segStart / spanMs, 0, 1),
            eventCount: 0,
            hasActivity: false,
            firstActivityMs: null,
        };
    });

    const inDayEvents = (Array.isArray(events) ? events : [])
        .filter(row => row && Number.isFinite(Number(row.ts)) && row.ts >= startMs && row.ts <= endMs)
        .sort((a, b) => a.ts - b.ts);

    for (const row of inDayEvents) {
        const offset = row.ts - startMs;
        const chapter = chapters.find((seg, index) => (
            index === chapters.length - 1
                ? offset >= seg.startMs && offset <= seg.endMs
                : offset >= seg.startMs && offset < seg.endMs
        ));
        if (chapter) {
            chapter.eventCount += 1;
            chapter.hasActivity = true;
            if (chapter.firstActivityMs === null) chapter.firstActivityMs = offset;
        }
    }

    const chapterPins = chapters
        .filter(chapter => chapter.id !== 'night-early' || chapter.hasActivity)
        .map(chapter => ({
            id: `chapter:${chapter.id}`,
            type: 'chapter',
            kind: 'chapter',
            band: chapter.band,
            label: `${chapter.label} · ${formatClockHHMM(chapter.clockMs)}`,
            shortLabel: chapter.label,
            ts: chapter.startMs,
            clockMs: chapter.clockMs,
            hour: new Date(chapter.clockMs).getHours(),
            progress: chapter.progress,
            count: chapter.eventCount,
            priority: 10,
        }));

    // Coalesce bursts of same-kind notable events so the track stays legible.
    const coalesced = [];
    const lastByKind = new Map();
    for (const row of inDayEvents) {
        const kind = String(row.kind || '').trim();
        const priority = NOTABLE_PIN_PRIORITY[kind];
        if (!priority) continue;
        const offset = row.ts - startMs;
        const previous = lastByKind.get(kind);
        if (previous && offset - previous.lastTs <= PIN_COALESCE_WINDOW_MS) {
            previous.count += 1;
            previous.lastTs = offset;
            continue;
        }
        const band = diurnalBandForTimestamp(row.ts, bands);
        const pin = {
            id: `event:${kind}:${offset}`,
            type: 'event',
            kind,
            band,
            shortLabel: PIN_KIND_LABEL[kind] || kind,
            ts: offset,
            lastTs: offset,
            clockMs: row.ts,
            hour: new Date(row.ts).getHours(),
            progress: clamp(offset / spanMs, 0, 1),
            count: 1,
            priority,
        };
        coalesced.push(pin);
        lastByKind.set(kind, pin);
    }

    const selectedEventPins = coalesced.length <= MAX_EVENT_PINS
        ? coalesced
        : [...coalesced]
            .sort((a, b) => b.priority - a.priority || b.count - a.count || a.ts - b.ts)
            .slice(0, MAX_EVENT_PINS)
            .sort((a, b) => a.ts - b.ts);

    const eventPins = selectedEventPins.map(({ lastTs: _lastTs, priority: _priority, ...pin }) => ({
        ...pin,
        label: `${formatClockHHMM(pin.clockMs)} · ${pin.shortLabel}${pin.count > 1 ? ` ×${pin.count}` : ''}`,
    }));

    const pins = [
        ...chapterPins.map(({ priority: _priority, ...pin }) => pin),
        ...eventPins,
    ].sort((a, b) => a.ts - b.ts || (a.type === 'chapter' ? -1 : 1) - (b.type === 'chapter' ? -1 : 1));

    return { chapters, pins, bands, lower: startMs, upper: endMs, spanMs };
}

export async function loadChronicleScenario(dateKey) {
    const bounds = dayBounds(dateKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || chronicleDateKey(bounds.lower) !== dateKey) {
        throw Object.assign(new Error('Invalid Chronicle date'), { code: 'retold-date-invalid' });
    }
    let rows;
    try {
        rows = await readRecordedDay(bounds);
    } catch (cause) {
        throw Object.assign(new Error('Could not read recorded day', { cause }), { code: 'retold-read-failed' });
    }
    if (!rows.samples.some(hasTile)) return null;
    const scenario = buildChronicleScenario(bounds, rows);
    return {
        ...bounds,
        dateKey,
        scenario,
        chapters: scenario.chapters,
        pins: scenario.pins,
    };
}

function hasTile(row) {
    return row?.agentId && Number.isFinite(row.tileX) && Number.isFinite(row.tileY);
}

export function buildChronicleScenario({ lower, upper }, { events, samples }, { solar = null } = {}) {
    const observations = [];
    const dayEvents = [];
    for (const row of events) {
        if (row.ts >= lower && row.ts <= upper) {
            observations.push(row);
            dayEvents.push(row);
        }
    }
    // Also accept raw captures. Keep the first observed tile per interval
    // without materializing or sorting a full day's one-second samples.
    const byAgent = new Map();
    for (const row of samples) {
        if (!hasTile(row) || !Number.isFinite(row.ts) || row.ts < lower || row.ts > upper) continue;
        let bins = byAgent.get(row.agentId);
        if (!bins) {
            bins = new Map();
            byAgent.set(row.agentId, bins);
        }
        const bin = Math.floor((row.ts - lower) / RECORDED_TRAIL_INTERVAL_MS);
        const first = bins.get(bin);
        if (!first || row.ts < first.ts) bins.set(bin, row);
    }
    for (const bins of byAgent.values()) for (const row of bins.values()) observations.push(row);
    observations.sort((a, b) => a.ts - b.ts);

    const timeline = [];
    const present = new Map();
    for (const row of observations) {
        const agentId = row.agentId;
        const ts = row.ts - lower;
        const git = row.kind === 'push' || row.kind === 'commit';
        if (git) {
            const gitEvent = {
                id: row.gitKey || row.id, type: row.kind, project: row.project, provider: row.provider,
                label: row.label, sha: row.sha, sessionId: agentId,
            };
            if (row.outcome) gitEvent.status = row.outcome;
            else if (row.gitKey?.endsWith(':landed')) gitEvent.success = true;
            timeline.push({ ts, agentId, event: 'git:event', gitEvent });
        }
        if (!agentId || row.provider === 'git') continue;
        const previous = present.get(agentId);
        if (row.kind === 'departed' || (row.kind === 'completed' && row.sessionEndedAt)) {
            if (previous) timeline.push({ ts, agentId, event: 'agent:remove' });
            present.set(agentId, null);
            continue;
        }
        // The capture loop can sample a departed session during its grace period.
        if (previous === null && row.kind !== 'arrived') continue;
        const sample = !row.kind;
        const position = sample ? { tileX: row.tileX, tileY: row.tileY } : null;
        const status = STATUS.get(row.kind);
        if (!previous) {
            const agent = {
                id: agentId, name: row.agentName || agentId, provider: row.provider || 'unknown',
                projectPath: row.project || null, model: row.model || 'unknown',
                position: position || VILLAGE_GATE.inside, status: status || AgentStatus.IDLE,
                tokens: null,
            };
            timeline.push({ ts, event: 'agent:add', agent });
            present.set(agentId, { ...agent, gateArrival: sample ? null : agent });
        } else {
            if (sample && previous.gateArrival) {
                // The first retained tile identifies this visit's body before it leaves the gate.
                for (const key of ['model', 'provider']) {
                    if (row[key] && previous.gateArrival[key] === 'unknown') {
                        if (previous[key] === 'unknown') previous[key] = row[key];
                        previous.gateArrival[key] = previous[key];
                    }
                }
                previous.gateArrival = null;
            }
            const update = {};
            if (position && (position.tileX !== previous.position.tileX || position.tileY !== previous.position.tileY)) update.position = position;
            if (row.model && row.model !== previous.model) update.model = row.model;
            if (row.provider && row.provider !== previous.provider) update.provider = row.provider;
            if (row.agentName && row.agentName !== previous.name) update.name = row.agentName;
            if (row.project && row.project !== previous.projectPath) update.projectPath = row.project;
            if (status && status !== previous.status) update.status = status;
            if (Object.keys(update).length) {
                timeline.push({ ts, agentId, event: 'agent:observed', update });
                Object.assign(previous, update);
            }
        }
    }

    const retoldMeta = buildRetoldChapters({ lower, upper }, { events: dayEvents }, { solar });
    // Keep enumerable keys strictly `['agents', 'timeline']` for serialized
    // replay budgets and contract tests while exposing chapter/pin metadata.
    const scenario = { agents: [], timeline };
    Object.defineProperties(scenario, {
        chapters: { value: retoldMeta.chapters, enumerable: false, configurable: true },
        pins: { value: retoldMeta.pins, enumerable: false, configurable: true },
    });
    return scenario;
}
