// 7.12 + 9.8 — the LAST 10 MIN observed-call tape.
//
// A browser-local ring of 40 x 15 s buckets per agent, fed only by what this
// tab saw on `agent:added` / `agent:updated`. Nothing is backfilled.
// - Per bucket it counts calls that change things (`act`: write / run / task)
//   and calls that look (`look`: read / search / other), drawn as up to three
//   stacked 3x3 blocks, act first, in the parchment ink ramp: an abacus, never
//   a chart, and never hue.
// - An exception status this tab saw (needs you, error, quota) paints a 4x2
//   band under the baseline in that status token, over exactly the buckets in
//   which the status held.
// - A bucket that ended before observation began is one 1 px dot on the
//   baseline ("not observed"), so a fresh tab reads as a dotted rule plus the
//   calls it has seen, not as a loading bar.
// 9.11 — the selected detail draws the same cells at exactly 3x, with the
// fetched transcript's calls as 1 px ticks on the same time axis.

import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { bucketForStatus } from '../../domain/services/SignalLedger.js';
import { STATUS_VISUALS } from '../../config/theme.js';

export const TAPE_BUCKETS = 40;
export const TAPE_BUCKET_MS = 15_000;
export const TAPE_WINDOW_MS = TAPE_BUCKETS * TAPE_BUCKET_MS;
export const TAPE_PITCH = 4; // a 3 px block and a 1 px gap per bucket
export const TAPE_WIDTH = TAPE_BUCKETS * TAPE_PITCH; // 160
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

// Tape rows at 1x: blocks stand on the baseline (row 12), stacked upward at a
// 4 px pitch; the status band fills rows 14-15.
const BLOCK = 3;
const BASELINE_Y = TAPE_HEIGHT - 4;
const BAND_Y = BASELINE_Y + 2;

// Parchment ink ramp (reset.css --ink-*, --line-1); canvas cannot read CSS
// custom properties per paint without a style recalc.
const TAPE_INK = Object.freeze({
    act: '#d9c9a3',
    look: '#8c7c64',
    dot: '#4a3b2c',
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
     * Oldest → newest cells for the 10 minutes ending at `at`:
     * `{ observed, act, look, status }`, where `status` is the highest-ranked
     * exception (`needsYou` | `errors` | `quota`) seen during the bucket.
     */
    cells(agentId, at = this._now()) {
        const record = this._agents.get(String(agentId));
        const newest = bucketIndex(at);
        const first = newest - (TAPE_BUCKETS - 1);
        const out = new Array(TAPE_BUCKETS);
        for (let i = 0; i < TAPE_BUCKETS; i++) {
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

    /** Cheap change key: repaint only when a boundary passed or the record changed. */
    signature(agentId, at = this._now()) {
        return `${bucketIndex(at)}:${this._agents.get(String(agentId))?.revision || 0}`;
    }

    title() {
        const since = new Date(this.openedAt);
        const hh = String(since.getHours()).padStart(2, '0');
        const mm = String(since.getMinutes()).padStart(2, '0');
        return `Tool calls this tab observed since ${hh}:${mm}, one column per 15 s · a block per call: bright = write/run/task, dim = read/search · band = needs you, error or quota while observed · dotted = before this tab was watching`;
    }
}

/** Paint tape cells at an integer `scale` on whole pixels. */
export function paintTapeCells(ctx, cells, scale = 1) {
    const s = scale;
    const pitch = TAPE_PITCH * s;
    for (let i = 0; i < cells.length; i++) {
        const x = i * pitch;
        const cell = cells[i];
        if (!cell.observed) {
            ctx.fillStyle = TAPE_INK.dot;
            ctx.fillRect(x, BASELINE_Y * s, s, s);
            continue;
        }
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
}

/** Paint the row tape onto its TAPE_WIDTH x TAPE_HEIGHT canvas. */
export function paintTape(canvas, cells) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, TAPE_WIDTH, TAPE_HEIGHT);
    paintTapeCells(ctx, cells, 1);
}

function entryTime(entry) {
    const raw = entry?.ts;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 9.11 — place fetched transcript calls on the tape's axis. `x` is the strip
 * column (1 px = 1.25 s) inside the 10 minutes ending with the bucket that
 * holds `at`; `coveredFrom` is the column of the oldest fetched call (the
 * fetch returns a contiguous tail, so nothing before it is known), or null.
 */
export function transcriptTicks(entries, at) {
    const start = (bucketIndex(at) - (TAPE_BUCKETS - 1)) * TAPE_BUCKET_MS;
    const ticks = [];
    let oldest = Infinity;
    for (const entry of entries || []) {
        const ts = entryTime(entry);
        if (ts === null) continue;
        oldest = Math.min(oldest, ts);
        if (ts < start || ts >= start + TAPE_WINDOW_MS) continue;
        ticks.push({ x: Math.floor(((ts - start) * STRIP_WIDTH) / TAPE_WINDOW_MS), cls: callClass(entry.tool) });
    }
    const coveredFrom = oldest === Infinity || oldest >= start + TAPE_WINDOW_MS
        ? null
        : Math.max(0, Math.floor(((oldest - start) * STRIP_WIDTH) / TAPE_WINDOW_MS));
    return { ticks, coveredFrom };
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
