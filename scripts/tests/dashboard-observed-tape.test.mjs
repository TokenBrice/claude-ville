import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ObservedCallTapeStore,
    STRIP_WIDTH,
    TAPE_BUCKET_MS,
    TAPE_BUCKETS,
    TAPE_HEIGHT,
    TAPE_STATUS_INK,
    TAPE_WIDTH,
    paintTapeCells,
    transcriptTicks,
} from '../../claudeville/src/presentation/dashboard-mode/ObservedCallTape.js';

// A bucket-aligned clock well past zero, so "before the tab opened" exists.
const T0 = 1_000_000 * TAPE_BUCKET_MS;
const at = (bucket, offsetMs = 0) => T0 + bucket * TAPE_BUCKET_MS + offsetMs;

function storeAt(ms) {
    let now = ms;
    const store = new ObservedCallTapeStore({ now: () => now });
    return { store, set: (next) => { now = next; } };
}

// Rasterize fillRect calls into a colour grid so the assertions read pixels.
function raster(width, height) {
    const px = Array.from({ length: height }, () => new Array(width).fill(null));
    return {
        px,
        ctx: {
            fillStyle: null,
            fillRect(x, y, w, h) {
                for (let row = y; row < y + h; row++) {
                    for (let col = x; col < x + w; col++) {
                        if (row >= 0 && row < height && col >= 0 && col < width) px[row][col] = this.fillStyle;
                    }
                }
            },
        },
    };
}

test('a fresh tape is a dotted baseline except for what this tab has seen', () => {
    const { store } = storeAt(at(0, 5_000));
    store.observe({ id: 'a', status: 'working', currentTool: 'Edit', currentToolInput: 'x.js' }, at(0, 5_000));
    const cells = store.cells('a', at(0, 6_000));
    assert.equal(cells.length, TAPE_BUCKETS);
    assert.ok(cells.slice(0, -1).every(cell => !cell.observed), 'buckets that ended before the tab opened are not observed');
    assert.deepEqual(cells.at(-1), { observed: true, act: 1, look: 0, status: null });

    const { px, ctx } = raster(TAPE_WIDTH, TAPE_HEIGHT);
    paintTapeCells(ctx, cells, 1);
    assert.equal(px[12].slice(0, 156).filter(Boolean).length, 39, 'one 1 px dot per unobserved bucket');
    assert.ok(px.slice(0, 12).every(row => row.slice(0, 156).every(value => value === null)), 'no full-height hatch');
    assert.equal(px[11][156], '#d9c9a3', 'the observed call stands on the baseline');
});

test('calls count per bucket, act before look, capped at three blocks', () => {
    const { store } = storeAt(at(0));
    const agent = { id: 'a', status: 'working' };
    for (const [tool, input] of [['Read', '1'], ['Read', '1'], ['Grep', '2'], ['Bash', 'ls'], ['Read', '3'], ['Edit', 'y']]) {
        store.observe({ ...agent, currentTool: tool, currentToolInput: input }, at(0, 1_000));
    }
    const cell = store.cells('a', at(0, 2_000)).at(-1);
    assert.equal(cell.act, 2, 'Bash and Edit change things');
    assert.equal(cell.look, 3, 'a repeated in-flight call is counted once');

    const { px, ctx } = raster(TAPE_WIDTH, TAPE_HEIGHT);
    paintTapeCells(ctx, [cell], 1);
    assert.deepEqual([px[11][0], px[7][0], px[3][0]], ['#d9c9a3', '#d9c9a3', '#8c7c64']);
    assert.equal(px[3][3], null, 'blocks are 3 px wide on a 4 px pitch');
});

test('after a waiting -> working cycle the band covers exactly the observed buckets', () => {
    const { store } = storeAt(at(0));
    store.observe({ id: 'a', status: 'working', currentTool: 'Edit', currentToolInput: 'a' }, at(0));
    store.observe({ id: 'a', status: 'waiting_on_user' }, at(10, 7_000));
    store.observe({ id: 'a', status: 'waiting_on_user' }, at(11, 1_000));
    store.observe({ id: 'a', status: 'working', currentTool: 'Edit', currentToolInput: 'b' }, at(14, 2_000));
    const now = at(20);
    const cells = store.cells('a', now);
    const newest = 20;
    const banded = cells
        .map((cell, index) => (cell.status ? newest - (TAPE_BUCKETS - 1) + index : null))
        .filter(bucket => bucket !== null);
    assert.deepEqual(banded, [10, 11, 12, 13, 14]);
    assert.ok(cells.every(cell => !cell.status || cell.status === 'needsYou'));

    const { px, ctx } = raster(TAPE_WIDTH, TAPE_HEIGHT);
    paintTapeCells(ctx, cells, 1);
    const firstBanded = (10 - (newest - (TAPE_BUCKETS - 1))) * 4;
    assert.equal(px[14][firstBanded], TAPE_STATUS_INK.needsYou);
    assert.equal(px[15][firstBanded + 4 * 5 - 1], TAPE_STATUS_INK.needsYou);
    assert.equal(px[14][firstBanded + 4 * 5], null, 'the band stops at the bucket where working was observed');
});

test('a status already held when the tab opened is never backfilled', () => {
    const { store } = storeAt(at(5, 3_000));
    store.observe({ id: 'a', status: 'errored' }, at(5, 3_000));
    const cells = store.cells('a', at(8));
    const statuses = cells.map(cell => cell.status);
    assert.deepEqual(statuses.slice(-4), ['errors', 'errors', 'errors', 'errors']);
    assert.ok(statuses.slice(0, -4).every(status => status === null));
});

test('transcript ticks share the tape axis and mark only the fetched span as covered', () => {
    const now = at(39, 14_999); // newest bucket 39, window [0, 40) buckets
    const entries = [
        { tool: 'Read', ts: at(-3) },                    // before the window
        { tool: 'Edit', ts: at(10) },                    // start of bucket 10
        { tool: 'Grep', ts: new Date(at(20, 7_500)).toISOString() },
        { tool: 'Bash', ts: 'not a time' },
    ];
    const { ticks, coveredFrom } = transcriptTicks(entries, now);
    const perBucket = STRIP_WIDTH / TAPE_BUCKETS;
    assert.deepEqual(ticks.map(tick => tick.x), [10 * perBucket, 20 * perBucket + perBucket / 2]);
    assert.equal(coveredFrom, 0, 'the oldest fetched call predates the window');
    assert.equal(transcriptTicks(entries.slice(1), now).coveredFrom, 10 * perBucket);
    assert.equal(transcriptTicks([], now).coveredFrom, null, 'no transcript, no claim of an empty span');
});
