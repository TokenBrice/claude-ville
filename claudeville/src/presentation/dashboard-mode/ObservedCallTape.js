// 7.12 — LAST 10 MIN observed-call tape.
//
// A browser-local ring of 40 x 15 s buckets per agent, fed only by tool-call
// transitions this tab actually saw on `agent:updated`. Nothing is backfilled:
// buckets that ended before observation began are drawn hatched ("not
// observed"), empty observed buckets stay blank. Height encodes call class,
// never hue — tall for calls that change things (write / run / task), short
// for calls that look (read / search / other).

import { toolCategory } from '../../domain/services/ToolIdentity.js';

export const TAPE_BUCKETS = 40;
export const TAPE_BUCKET_MS = 15_000;
export const TAPE_WIDTH = TAPE_BUCKETS * 3; // 2 px bar + 1 px gap per bucket
export const TAPE_HEIGHT = 12;

export const CELL_EMPTY = 0;
export const CELL_LOOK = 1;
export const CELL_ACT = 2;
export const CELL_UNOBSERVED = 3;

const ACT_CATEGORIES = new Set(['write', 'exec', 'task']);

// Parchment ink ramp (reset.css --ink-2/3/4, --line-1); canvas cannot read
// CSS custom properties per paint without a style recalc.
const TAPE_INK = Object.freeze({
    act: '#bfae8f',
    look: '#8c7c64',
    hatch: '#4a3b2c',
    baseline: '#3a2c20',
});

export function callClass(tool) {
    return ACT_CATEGORIES.has(toolCategory(tool)) ? CELL_ACT : CELL_LOOK;
}

function callKey(agent) {
    const tool = agent?.currentTool;
    if (!tool) return '';
    return `${tool}\u001f${agent?.currentToolInput || ''}`;
}

export class ObservedCallTapeStore {
    constructor({ now = () => Date.now() } = {}) {
        this._now = now;
        this.openedAt = now();
        this._agents = new Map();
    }

    /** Record a call when the agent's in-flight tool call changed. */
    observe(agent, at = this._now()) {
        const id = String(agent?.id ?? '');
        if (!id) return false;
        let record = this._agents.get(id);
        if (!record) {
            record = { lastKey: '', buckets: new Map() };
            this._agents.set(id, record);
        }
        const key = callKey(agent);
        const changed = Boolean(key) && key !== record.lastKey;
        record.lastKey = key;
        if (!changed) return false;
        const bucket = Math.floor(at / TAPE_BUCKET_MS);
        const cls = callClass(agent.currentTool);
        if ((record.buckets.get(bucket) || 0) < cls) record.buckets.set(bucket, cls);
        const oldest = bucket - TAPE_BUCKETS;
        for (const index of record.buckets.keys()) {
            if (index <= oldest) record.buckets.delete(index);
        }
        return true;
    }

    forget(agentId) {
        this._agents.delete(String(agentId));
    }

    /** Oldest → newest cells for the 10 minutes ending at `at`. */
    cells(agentId, at = this._now()) {
        const record = this._agents.get(String(agentId));
        const newest = Math.floor(at / TAPE_BUCKET_MS);
        const out = new Uint8Array(TAPE_BUCKETS);
        for (let i = 0; i < TAPE_BUCKETS; i++) {
            const bucket = newest - (TAPE_BUCKETS - 1) + i;
            if ((bucket + 1) * TAPE_BUCKET_MS <= this.openedAt) out[i] = CELL_UNOBSERVED;
            else out[i] = record?.buckets.get(bucket) || CELL_EMPTY;
        }
        return out;
    }

    /** Cheap change key: repaint only when a boundary passed or a call landed. */
    signature(agentId, at = this._now()) {
        const record = this._agents.get(String(agentId));
        let calls = 0;
        if (record) for (const [bucket, cls] of record.buckets) calls += bucket * 3 + cls;
        return `${Math.floor(at / TAPE_BUCKET_MS)}:${record?.buckets.size || 0}:${calls}`;
    }

    title() {
        const since = new Date(this.openedAt);
        const hh = String(since.getHours()).padStart(2, '0');
        const mm = String(since.getMinutes()).padStart(2, '0');
        return `Observed tool calls since ${hh}:${mm} (this tab) · tall = write/run/task, short = read/search · hatched = not observed`;
    }
}

/** Paint cells onto a TAPE_WIDTH x TAPE_HEIGHT canvas on whole pixels. */
export function paintTape(canvas, cells) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, TAPE_WIDTH, TAPE_HEIGHT);
    const base = TAPE_HEIGHT - 1;
    for (let i = 0; i < cells.length; i++) {
        const x = i * 3;
        const cell = cells[i];
        if (cell === CELL_UNOBSERVED) {
            ctx.fillStyle = TAPE_INK.hatch;
            for (let y = 0; y < TAPE_HEIGHT; y++) {
                for (let dx = 0; dx < 3; dx++) {
                    if ((x + dx + y) % 4 === 0) ctx.fillRect(x + dx, y, 1, 1);
                }
            }
            continue;
        }
        ctx.fillStyle = TAPE_INK.baseline;
        ctx.fillRect(x, base, 3, 1);
        if (cell === CELL_ACT) {
            ctx.fillStyle = TAPE_INK.act;
            ctx.fillRect(x, base - 9, 2, 10);
        } else if (cell === CELL_LOOK) {
            ctx.fillStyle = TAPE_INK.look;
            ctx.fillRect(x, base - 4, 2, 5);
        }
    }
}
