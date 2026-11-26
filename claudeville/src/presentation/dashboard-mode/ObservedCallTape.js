// 7.12 + 9.8 + W4.4 — the LAST 5 MIN / LAST 10 MIN observed-call tape and the
// 24h project hours strip.
//
// A browser-local ring of 40 x 15 s buckets per agent, fed only by what this
// tab saw on `agent:added` / `agent:updated`. Nothing is backfilled into live
// blocks.
// - Per bucket it counts calls that change things (`act`: write / run / task)
//   and calls that look (`look`: read / search / other), drawn as up to three
//   stacked 3x3 blocks, act first, in the parchment ink ramp: an abacus, never
//   a chart, and never hue.
// - An exception status this tab saw (needs you, error, quota) paints a 4x2
//   band under the baseline in that status token, over exactly the buckets in
//   which the status held.
// - W4.4 (§4.9 / C4): `TAPE_PITCH = 4`. While tab age < 5 min the row tape
//   occupies 80 px (20 buckets, header `LAST 5 MIN`); from 5 min onward it
//   expands to 160 px (40 buckets, header `LAST 10 MIN`). A crisp 1 px brass
//   rule marks the bucket where the tab opened (`openedAt`). Left of the rule,
//   ghost ticks at 40 % contrast draw strictly from already-cached transcript
//   entries (zero extra fetches); unobserved buckets stay blank linen (never
//   zero dots).
// - 9.11 — the selected detail draws the same cells at exactly 3x, with the
//   fetched transcript's calls as 1 px ticks on the same time axis.

import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { bucketForStatus } from '../../domain/services/SignalLedger.js';
import { STATUS_VISUALS } from '../../config/theme.js';

export const TAPE_BUCKETS = 40;
export const TAPE_SHORT_BUCKETS = 20;
export const TAPE_BUCKET_MS = 15_000;
export const TAPE_WINDOW_MS = TAPE_BUCKETS * TAPE_BUCKET_MS;
export const TAPE_SHORT_WINDOW_MS = TAPE_SHORT_BUCKETS * TAPE_BUCKET_MS; // 5 min
export const TAPE_PITCH = 4; // a 3 px block and a 1 px gap per bucket
export const TAPE_WIDTH = TAPE_BUCKETS * TAPE_PITCH; // 160
export const TAPE_SHORT_WIDTH = TAPE_SHORT_BUCKETS * TAPE_PITCH; // 80
export const TAPE_HEIGHT = 16;
export const TAPE_MAX_BLOCKS = 3;
export const STRIP_SCALE = 3;
export const STRIP_WIDTH = TAPE_WIDTH * STRIP_SCALE; // 480
// 9.11 — transcript ticks hang in their own lane above the 3x tape, so a
// full column's third observed block can never touch an 8 px act tick.
export const STRIP_TICK_LANE = 8;
export const STRIP_HEIGHT = STRIP_TICK_LANE + TAPE_HEIGHT * STRIP_SCALE; // 56

export const CELL_LOOK = 1;
export const CELL_ACT = 2;

// W4.4 (§4.9) — 24h Project Hours Strip: 24 cells of 6x8 px with 1 px gaps.
export const HOURS_PER_DAY = 24;
export const HOUR_CELL_W = 6;
export const HOUR_CELL_H = 8;
export const HOUR_CELL_GAP = 1;
export const HOUR_CELL_PITCH = HOUR_CELL_W + HOUR_CELL_GAP;
export const HOURS_STRIP_WIDTH = HOURS_PER_DAY * HOUR_CELL_PITCH - HOUR_CELL_GAP; // 167
export const HOURS_STRIP_HEIGHT = HOUR_CELL_H; // 8

// Tape rows at 1x: blocks stand on the baseline (row 12), stacked upward at a
// 4 px pitch; the status band fills rows 14-15.
const BLOCK = 3;
const BASELINE_Y = TAPE_HEIGHT - 4;
const BAND_Y = BASELINE_Y + 2;
const GHOST_ACT_H = 7;
const GHOST_LOOK_H = 4;

// Parchment ink ramp (reset.css --ink-*, --line-1, --brass, --gold); canvas
// cannot read CSS custom properties per paint without a style recalc.
export const TAPE_INK = Object.freeze({
    act: '#d9c9a3',
    look: '#8c7c64',
    ghostAct: 'rgba(217, 201, 163, 0.4)',
    ghostLook: 'rgba(140, 124, 100, 0.4)',
    brass: '#b8893f',
    sail: '#f2c75c',
    baseline: '#3a2c20',
});

// The SignalLedger exception buckets, in lane rank order, and their status
// tokens (canonical in config/theme.js STATUS_VISUALS).
const STATUS_RANK = Object.freeze({ needsYou: 0, errors: 1, quota: 2 });
export const TAPE_STATUS_INK = Object.freeze({
    needsYou: STATUS_VISUALS.waiting_on_user.color,
    errors: STATUS_VISUALS.errored.color,
    quota: STATUS_VISUALS.rate_limited.color,
});

const UNOBSERVED = Object.freeze({ observed: false, act: 0, look: 0, status: null });

const ACT_CATEGORIES = new Set(['write', 'exec', 'task']);

export function callClass(tool) {
    return ACT_CATEGORIES.has(toolCategory(tool)) ? CELL_ACT : CELL_LOOK;
}

/**
 * W4.4 (§4.9 / C4) — active row-tape span from tab age.
 * Under 5 min: 80 px (20 buckets, `LAST 5 MIN`).
 * 5 min and older: 160 px (40 buckets, `LAST 10 MIN`).
 */
export function tapeSpanForAge(ageMs) {
    const long = Number(ageMs) >= TAPE_SHORT_WINDOW_MS;
    const buckets = long ? TAPE_BUCKETS : TAPE_SHORT_BUCKETS;
    return {
        buckets,
        width: buckets * TAPE_PITCH,
        windowMs: buckets * TAPE_BUCKET_MS,
        header: long ? 'LAST 10 MIN' : 'LAST 5 MIN',
        tier: long ? '10m' : '5m',
    };
}

/**
 * Column x of the 1 px brass rule separating unobserved (left) and observed
 * (right) buckets, or null once the rule has scrolled off (or nothing is
 * observed).
 */
export function openedRuleColumn(cells, scale = 1) {
    if (!Array.isArray(cells) || !cells.length) return null;
    const firstObserved = cells.findIndex(cell => cell?.observed);
    if (firstObserved <= 0) return null;
    return firstObserved * TAPE_PITCH * scale - scale;
}

function callKey(agent) {
    const tool = agent?.currentTool;
    if (!tool) return '';
    return `${tool}\u001f${agent?.currentToolInput || ''}`;
}

function bucketIndex(at) {
    return Math.floor(at / TAPE_BUCKET_MS);
}

function exceptionStatus(status) {
    const bucket = bucketForStatus(status);
    return Object.hasOwn(STATUS_RANK, bucket) ? bucket : null;
}

export class ObservedCallTapeStore {
    constructor({ now = () => Date.now() } = {}) {
        this._now = now;
        this.openedAt = now();
        this._agents = new Map();
    }

    /** Active row-tape geometry and header for the tab's age at `at`. */
    span(at = this._now()) {
        return tapeSpanForAge(Math.max(0, at - this.openedAt));
    }

    /**
     * Record what this tab saw of one agent at `at`: a call when the in-flight
     * tool call changed, and the start or end of an exception status. Returns
     * true when the tape changed.
     */
    observe(agent, at = this._now()) {
        const id = String(agent?.id ?? '');
        if (!id) return false;
        let record = this._agents.get(id);
        if (!record) {
            record = { lastKey: '', buckets: new Map(), spans: [], revision: 0 };
            this._agents.set(id, record);
        }
        const statusChanged = this._observeStatus(record, exceptionStatus(agent?.status), at);
        const key = callKey(agent);
        const called = Boolean(key) && key !== record.lastKey;
        record.lastKey = key;
        const bucket = bucketIndex(at);
        if (called) {
            const counts = record.buckets.get(bucket) || { act: 0, look: 0 };
            if (callClass(agent.currentTool) === CELL_ACT) counts.act++;
            else counts.look++;
            record.buckets.set(bucket, counts);
        }
        if (!called && !statusChanged) return false;
        this._prune(record, bucket);
        record.revision++;
        return true;
    }

    // One span per observed exception: open while the status holds, closed at
    // the first observation that the status changed.
    _observeStatus(record, status, at) {
        const last = record.spans.at(-1);
        const open = last && last.to === null ? last : null;
        if ((open?.status || null) === status) return false;
        if (open) open.to = at;
        if (status) record.spans.push({ status, from: at, to: null });
        return true;
    }

    _prune(record, bucket) {
        const oldest = bucket - TAPE_BUCKETS;
        for (const index of record.buckets.keys()) {
            if (index <= oldest) record.buckets.delete(index);
        }
        while (record.spans.length && record.spans[0].to !== null && bucketIndex(record.spans[0].to) <= oldest) {
            record.spans.shift();
        }
    }

    forget(agentId) {
        this._agents.delete(String(agentId));
    }

    /**
     * Oldest -> newest cells for `buckets` (default 40 = 10 min) ending at
     * `at`: `{ observed, act, look, status }`, where `status` is the
     * highest-ranked exception (`needsYou` | `errors` | `quota`) seen during
     * the bucket.
     */
    cells(agentId, at = this._now(), { buckets = TAPE_BUCKETS } = {}) {
        const count = Math.max(1, Math.trunc(Number(buckets) || TAPE_BUCKETS));
        const record = this._agents.get(String(agentId));
        const newest = bucketIndex(at);
        const first = newest - (count - 1);
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            const bucket = first + i;
            if ((bucket + 1) * TAPE_BUCKET_MS <= this.openedAt) {
                out[i] = UNOBSERVED;
                continue;
            }
            const counts = record?.buckets.get(bucket);
            out[i] = { observed: true, act: counts?.act || 0, look: counts?.look || 0, status: null };
        }
        for (const span of record?.spans || []) {
            const from = Math.max(first, bucketIndex(span.from));
            const to = Math.min(newest, bucketIndex(span.to ?? at));
            for (let bucket = from; bucket <= to; bucket++) {
                const cell = out[bucket - first];
                if (!cell.observed) continue;
                if (!cell.status || STATUS_RANK[span.status] < STATUS_RANK[cell.status]) cell.status = span.status;
            }
        }
        return out;
    }

    /** Cheap change key: repaint only when span, boundary or record changed. */
    signature(agentId, at = this._now()) {
        return `${this.span(at).tier}:${bucketIndex(at)}:${this._agents.get(String(agentId))?.revision || 0}`;
    }

    /**
     * Whether any agent in `agentIds` has observed tape data worth showing in
     * the row column: at least one recorded call or exception span in the
     * current window once observation has crossed at least one 15 s bucket
     * (or spanned 2+ distinct buckets). A fresh tab stays compact until then.
     */
    hasObservedActivity(agentIds, at = this._now()) {
        const newest = bucketIndex(at);
        const oldest = newest - (TAPE_BUCKETS - 1);
        const elapsed = (at - this.openedAt) >= TAPE_BUCKET_MS;
        for (const rawId of agentIds || []) {
            const record = this._agents.get(String(rawId));
            if (!record) continue;
            let activeBuckets = 0;
            for (const [bucket, counts] of record.buckets) {
                if (bucket < oldest || bucket > newest) continue;
                if ((bucket + 1) * TAPE_BUCKET_MS <= this.openedAt) continue;
                if ((counts?.act || 0) > 0 || (counts?.look || 0) > 0) {
                    if (elapsed) return true;
                    activeBuckets++;
                    if (activeBuckets >= 2) return true;
                }
            }
            for (const span of record.spans) {
                const from = Math.max(oldest, bucketIndex(span.from));
                const to = Math.min(newest, bucketIndex(span.to ?? at));
                if (from > to) continue;
                if (elapsed || to > from) return true;
                if (activeBuckets >= 1 && !record.buckets.has(from)) return true;
            }
        }
        return false;
    }

    title(at = this._now()) {
        const since = new Date(this.openedAt);
        const hh = String(since.getHours()).padStart(2, '0');
        const mm = String(since.getMinutes()).padStart(2, '0');
        const span = this.span(at);
        return `Tool calls this tab observed (${span.header.toLowerCase()}, brass rule marks tab open at ${hh}:${mm}), one column per 15 s · a block per call: bright = write/run/task, dim = read/search · band = needs you, error or quota while observed · faint ticks left of rule = cached transcript calls · blank = not observed`;
    }
}

/**
 * Paint tape cells at an integer `scale` on whole pixels.
 * Unobserved buckets remain blank linen (never zero dots). When the tab opened
 * within the window, a crisp 1 px brass rule separates unobserved space on the
 * left from observed buckets on the right, and optional `ghostTicks` (from
 * cached `transcriptTicks`) paint at 40 % contrast strictly left of the rule.
 */
export function paintTapeCells(ctx, cells, scale = 1, { ghostTicks = null } = {}) {
    const s = scale;
    const pitch = TAPE_PITCH * s;
    const firstObserved = Array.isArray(cells) ? cells.findIndex(cell => cell?.observed) : -1;
    const ruleX = firstObserved > 0 ? firstObserved * pitch - s : null;
    const ghostLimitX = firstObserved === -1
        ? (cells?.length || 0) * pitch
        : (ruleX !== null ? ruleX : 0);

    if (Array.isArray(ghostTicks) && ghostTicks.length && ghostLimitX > 0) {
        const byColumn = new Map();
        for (const tick of ghostTicks) {
            const x = Math.floor(Number(tick?.x));
            if (!Number.isFinite(x) || x < 0) continue;
            const px = x * s;
            if (px >= ghostLimitX) continue;
            const prev = byColumn.get(px) || 0;
            if ((tick.cls || CELL_LOOK) > prev) byColumn.set(px, tick.cls || CELL_LOOK);
        }
        for (const [px, cls] of byColumn) {
            const act = cls === CELL_ACT;
            const h = (act ? GHOST_ACT_H : GHOST_LOOK_H) * s;
            ctx.fillStyle = act ? TAPE_INK.ghostAct : TAPE_INK.ghostLook;
            ctx.fillRect(px, BASELINE_Y * s - h, s, h);
        }
    }

    for (let i = 0; i < (cells?.length || 0); i++) {
        const x = i * pitch;
        const cell = cells[i];
        if (!cell?.observed) continue;
        ctx.fillStyle = TAPE_INK.baseline;
        ctx.fillRect(x, BASELINE_Y * s, pitch, s);
        const act = Math.min(TAPE_MAX_BLOCKS, cell.act);
        const blocks = act + Math.min(TAPE_MAX_BLOCKS - act, cell.look);
        for (let k = 0; k < blocks; k++) {
            ctx.fillStyle = k < act ? TAPE_INK.act : TAPE_INK.look;
            ctx.fillRect(x, (BASELINE_Y - BLOCK - (BLOCK + 1) * k) * s, BLOCK * s, BLOCK * s);
        }
        if (cell.status) {
            ctx.fillStyle = TAPE_STATUS_INK[cell.status];
            ctx.fillRect(x, BAND_Y * s, pitch, 2 * s);
        }
    }

    if (ruleX !== null) {
        ctx.fillStyle = TAPE_INK.brass;
        ctx.fillRect(ruleX, 0, s, TAPE_HEIGHT * s);
    }
}

/** Paint the row tape onto its 80x16 or 160x16 canvas. */
export function paintTape(canvas, cells, { ghostTicks = null } = {}) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    const width = Number(canvas.width) || ((cells?.length || TAPE_BUCKETS) * TAPE_PITCH);
    const height = Number(canvas.height) || TAPE_HEIGHT;
    ctx.clearRect(0, 0, width, height);
    paintTapeCells(ctx, cells, 1, { ghostTicks });
}

function entryTime(entry) {
    const raw = entry?.ts;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 9.11 + W4.4 — place fetched transcript calls on the tape's axis. `x` is the
 * column inside the window ending with the bucket that holds `at`;
 * `coveredFrom` is the column of the oldest fetched call (the fetch returns a
 * contiguous tail, so nothing before it is known), or null.
 */
export function transcriptTicks(entries, at, { buckets = TAPE_BUCKETS, width = STRIP_WIDTH } = {}) {
    const count = Math.max(1, Math.trunc(Number(buckets) || TAPE_BUCKETS));
    const spanMs = count * TAPE_BUCKET_MS;
    const pxWidth = Math.max(1, Math.trunc(Number(width) || STRIP_WIDTH));
    const start = (bucketIndex(at) - (count - 1)) * TAPE_BUCKET_MS;
    const ticks = [];
    let oldest = Infinity;
    for (const entry of entries || []) {
        const ts = entryTime(entry);
        if (ts === null) continue;
        oldest = Math.min(oldest, ts);
        if (ts < start || ts >= start + spanMs) continue;
        ticks.push({ x: Math.floor(((ts - start) * pxWidth) / spanMs), cls: callClass(entry.tool) });
    }
    const coveredFrom = oldest === Infinity || oldest >= start + spanMs
        ? null
        : Math.max(0, Math.floor(((oldest - start) * pxWidth) / spanMs));
    return { ticks, coveredFrom };
}

/**
 * Map already-cached transcript entries onto the 1x row tape's pixel axis for
 * ghost-tick rendering left of `openedAt`. Never triggers a network request.
 */
export function ghostTicksForTape(entries, at, { buckets = TAPE_BUCKETS } = {}) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const count = Math.max(1, Math.trunc(Number(buckets) || TAPE_BUCKETS));
    return transcriptTicks(entries, at, { buckets: count, width: count * TAPE_PITCH }).ticks;
}

// Transcript ticks hang from a 1 px rail along the top edge, over the span the
// fetched transcript covers, inside STRIP_TICK_LANE; the observed blocks stand
// on the baseline of the 3x tape below it (third block top at lane + 3 px).
const TICK_ACT_H = 8;
const TICK_LOOK_H = 5;

/**
 * Paint the 480 x 56 session strip. Returns `{ drawn, coveredFrom }`: the
 * ticks inside the window and the column where the fetched transcript begins.
 */
export function paintSessionStrip(canvas, cells, entries, at) {
    const { ticks, coveredFrom } = transcriptTicks(entries, at);
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return { drawn: ticks.length, coveredFrom };
    ctx.clearRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT);
    if (coveredFrom !== null) {
        ctx.fillStyle = TAPE_INK.baseline;
        ctx.fillRect(coveredFrom, 0, STRIP_WIDTH - coveredFrom, 1);
    }
    for (const tick of ticks) {
        const act = tick.cls === CELL_ACT;
        ctx.fillStyle = act ? TAPE_INK.act : TAPE_INK.look;
        ctx.fillRect(tick.x, 0, 1, act ? TICK_ACT_H : TICK_LOOK_H);
    }
    ctx.save();
    ctx.translate(0, STRIP_TICK_LANE);
    paintTapeCells(ctx, cells, STRIP_SCALE);
    ctx.restore();
    return { drawn: ticks.length, coveredFrom };
}

// ─── W4.4 (§4.9) · 24h Project Hours Strip ─────────────────────────────

function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDayHours() {
    return Array.from({ length: HOURS_PER_DAY }, (_, hour) => ({
        hour,
        act: 0,
        look: 0,
        commits: 0,
        pushes: 0,
    }));
}

function isVerifiedGitEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.inferred === true) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected' || status === 'cancelled' || status === 'canceled') return false;
    return event.type === 'commit' || event.type === 'push';
}

export class ProjectHoursLedger {
    constructor({ now = () => Date.now() } = {}) {
        this._now = now;
        const start = now();
        this.openedAt = start;
        this._dayKey = localDayKey(start);
        this._covered = new Array(HOURS_PER_DAY).fill(false);
        this._projects = new Map();
        this._lastCallByAgent = new Map();
        this._seenOutcomes = new Set();
        this._revision = 0;
        this.cover(start);
    }

    _syncDay(at) {
        const key = localDayKey(at);
        if (key === this._dayKey) return;
        this._dayKey = key;
        this._covered = new Array(HOURS_PER_DAY).fill(false);
        this._projects.clear();
        this._seenOutcomes.clear();
        this._revision++;
    }

    _projectBucket(projectKey) {
        const key = String(projectKey || '_unknown');
        let record = this._projects.get(key);
        if (!record) {
            record = { hours: emptyDayHours(), revision: 0 };
            this._projects.set(key, record);
        }
        return record;
    }

    /** Mark the local hour of `at` as covered by this browser tab. */
    cover(at = this._now()) {
        const ts = Number(at);
        if (!Number.isFinite(ts)) return;
        this._syncDay(ts);
        const hour = new Date(ts).getHours();
        if (!this._covered[hour]) {
            this._covered[hour] = true;
            this._revision++;
        }
    }

    /** Record observed agent activity and verified git events for `projectKey`. */
    observeAgent(projectKey, agent, at = this._now()) {
        const ts = Number(at);
        if (!Number.isFinite(ts) || !agent?.id) return false;
        this.cover(ts);
        const hour = new Date(ts).getHours();
        const id = String(agent.id);
        let changed = false;

        const key = callKey(agent);
        const prevKey = this._lastCallByAgent.get(id) || '';
        this._lastCallByAgent.set(id, key);
        if (key && key !== prevKey) {
            const record = this._projectBucket(projectKey);
            if (callClass(agent.currentTool) === CELL_ACT) record.hours[hour].act++;
            else record.hours[hour].look++;
            record.revision++;
            changed = true;
        }

        if (Array.isArray(agent.gitEvents)) {
            for (const event of agent.gitEvents) {
                if (!isVerifiedGitEvent(event)) continue;
                const eventTs = Number(event.ts || event.completedAt || event.timestamp);
                if (!Number.isFinite(eventTs) || eventTs <= 0) continue;
                if (localDayKey(eventTs) !== this._dayKey) continue;
                const eventHour = new Date(eventTs).getHours();
                if (!this._covered[eventHour]) continue;
                const dedupeId = `${projectKey}|${event.type}|${event.id || event.sha || eventTs}`;
                if (this._seenOutcomes.has(dedupeId)) continue;
                this._seenOutcomes.add(dedupeId);
                const record = this._projectBucket(projectKey);
                if (event.type === 'commit') record.hours[eventHour].commits++;
                else if (event.type === 'push') record.hours[eventHour].pushes++;
                record.revision++;
                changed = true;
            }
        }
        return changed;
    }

    /** Record a verified commit or push directly (e.g. from `outcome:verified`). */
    recordOutcome(projectKey, kind, at = this._now(), outcomeId = null) {
        const ts = Number(at);
        if (!Number.isFinite(ts) || (kind !== 'commit' && kind !== 'push')) return false;
        this.cover(ts);
        const hour = new Date(ts).getHours();
        const key = String(projectKey || '_unknown');
        if (outcomeId != null) {
            const dedupeId = `${key}|${kind}|${outcomeId}`;
            if (this._seenOutcomes.has(dedupeId)) return false;
            this._seenOutcomes.add(dedupeId);
        }
        const record = this._projectBucket(key);
        if (kind === 'commit') record.hours[hour].commits++;
        else record.hours[hour].pushes++;
        record.revision++;
        return true;
    }

    forget(agentId) {
        this._lastCallByAgent.delete(String(agentId));
    }

    /** 24 hour cells for today: uncovered hours carry `covered: false`. */
    hoursFor(projectKey, at = this._now()) {
        const ts = Number(at);
        if (Number.isFinite(ts)) this._syncDay(ts);
        const record = this._projects.get(String(projectKey || '_unknown'));
        return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
            const covered = this._covered[hour];
            const stats = record?.hours[hour];
            if (!covered) {
                return { hour, covered: false, act: 0, look: 0, commits: 0, pushes: 0 };
            }
            return {
                hour,
                covered: true,
                act: stats?.act || 0,
                look: stats?.look || 0,
                commits: stats?.commits || 0,
                pushes: stats?.pushes || 0,
            };
        });
    }

    signature(projectKey, at = this._now()) {
        const ts = Number(at);
        if (Number.isFinite(ts)) this._syncDay(ts);
        const record = this._projects.get(String(projectKey || '_unknown'));
        return `${this._dayKey}:${this._revision}:${record?.revision || 0}`;
    }
}

function activityBarHeight(count) {
    if (count <= 0) return 0;
    if (count === 1) return 2;
    if (count <= 4) return 3;
    if (count <= 11) return 4;
    return 5;
}

/**
 * Paint 24 crisp 6x8 px cells for today's project hours strip:
 * - uncovered hours: blank linen (zero fill)
 * - covered hours: 1 px baseline, ink for observed act/look, 2x2 brass pip for
 *   verified commit, 3x4 pixel sail mark for verified push.
 */
export function paintHoursStrip(ctx, hours) {
    if (!ctx || !Array.isArray(hours)) return;
    for (let h = 0; h < HOURS_PER_DAY && h < hours.length; h++) {
        const cell = hours[h];
        if (!cell?.covered) continue;
        const x = h * HOUR_CELL_PITCH;
        // Covered-hour baseline
        ctx.fillStyle = TAPE_INK.baseline;
        ctx.fillRect(x, HOUR_CELL_H - 1, HOUR_CELL_W, 1);

        // Observed activity ink (act on left 3 px, look on right 3 px)
        const actH = activityBarHeight(cell.act || 0);
        const lookH = activityBarHeight(cell.look || 0);
        if (actH > 0) {
            ctx.fillStyle = TAPE_INK.act;
            ctx.fillRect(x, HOUR_CELL_H - 1 - actH, lookH > 0 ? 3 : HOUR_CELL_W, actH);
        }
        if (lookH > 0) {
            ctx.fillStyle = TAPE_INK.look;
            ctx.fillRect(actH > 0 ? x + 3 : x, HOUR_CELL_H - 1 - lookH, actH > 0 ? 3 : HOUR_CELL_W, lookH);
        }

        // Verified commit: 2x2 brass pip in upper-left of the 6x8 cell
        if ((cell.commits || 0) > 0) {
            ctx.fillStyle = TAPE_INK.brass;
            ctx.fillRect(x, 1, 2, 2);
        }

        // Verified push: crisp 3x4 triangular pixel sail mark in upper-right
        if ((cell.pushes || 0) > 0) {
            ctx.fillStyle = TAPE_INK.sail;
            ctx.fillRect(x + 3, 0, 1, 4); // mast
            ctx.fillRect(x + 4, 1, 1, 2); // sail mid
            ctx.fillRect(x + 5, 2, 1, 1); // sail tip
        }
    }
}

export function paintHoursStripCanvas(canvas, hours) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    const width = Number(canvas.width) || HOURS_STRIP_WIDTH;
    const height = Number(canvas.height) || HOURS_STRIP_HEIGHT;
    ctx.clearRect(0, 0, width, height);
    paintHoursStrip(ctx, hours);
}
