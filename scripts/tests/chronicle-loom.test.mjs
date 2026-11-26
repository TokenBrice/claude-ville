// Wave 6-B — The Loom of Days (`ChronicleLoom.js`) unit, pixel, PNG,
// zero-text guard, and performance verification suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
    ERROR_RESOLVING_KINDS,
    LOOM_BANDS,
    LOOM_EVENT_KIND,
    LOOM_EVENT_WEIGHTS,
    LOOM_GRID,
    LOOM_HOURS_PER_DAY,
    LOOM_MAX_PIPS,
    LOOM_MAX_WAIT_KNOTS,
    LOOM_PANEL_HEIGHT,
    LOOM_PANEL_WIDTH,
    LOOM_QUARTER_WIDTH,
    LOOM_TAPESTRY_BAND,
    LOOM_WAIT_UNIT_MS,
    LOOM_WARP_STRIDE,
    createCoverageMask,
    decodeCoverageBits,
    drawLoomToCanvas,
    encodeLoomPng,
    loomRepoPennant,
    normalizeCoverageBits,
    openErrorsAt,
    renderLoomFrieze,
    renderLoomPanel,
    renderLoomTapestryGrid,
    renderLoomToRgba,
    weaveDay,
} from '../../claudeville/src/presentation/shared/ChronicleLoom.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { PENNANT_PALETTE } from '../../claudeville/src/config/artPalette.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOM_SRC_PATH = path.join(ROOT, 'claudeville/src/presentation/shared/ChronicleLoom.js');

const DAY_KEY = '2026-11-19';
const DAY_START_UTC = Date.UTC(2026, 10, 19, 0, 0, 0);

function atHour(hour, minute = 0, second = 0) {
    return DAY_START_UTC + (hour * 3600 + minute * 60 + second) * 1000;
}

function readRgba(surface, x, y) {
    const o = (y * surface.width + x) * 4;
    return [surface.data[o], surface.data[o + 1], surface.data[o + 2], surface.data[o + 3]];
}

function sliceRegion(surface, x0, y0, w, h) {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * surface.width + x0) * 4;
        out.set(surface.data.subarray(src, src + w * 4), y * w * 4);
    }
    return out;
}

function buildBusyDayFixture() {
    const repos = [
        'claude-ville',
        'harbor-ledger',
        'pixel-atlas',
        'loom-engine',
        'town-band',
        'beacon-watch',
        'archive-index',
        'forge-depth',
    ];
    const agents = Array.from({ length: 12 }, (_, i) => ({
        id: `agent-${String(i + 1).padStart(2, '0')}`,
        provider: ['claude', 'codex', 'gemini', 'kimi'][i % 4],
        model: ['claude-opus-4-6', 'gpt-5.4-codex', 'gemini-3-pro', 'kimi-k2.5'][i % 4],
    }));

    const events = [];
    let seq = 0;
    const pushEvent = (hour, minute, kind, agentIdx, repoIdx, extra = {}) => {
        const a = agents[agentIdx % agents.length];
        events.push({
            id: `ev-${seq++}`,
            ts: atHour(hour, minute),
            localDate: DAY_KEY,
            kind,
            agentId: a.id,
            provider: a.provider,
            model: a.model,
            project: repos[repoIdx % repos.length],
            ...extra,
        });
    };

    for (let h = 0; h < 24; h++) {
        pushEvent(h, 2, LOOM_EVENT_KIND.ARRIVED, h, h);
        pushEvent(h, 55, LOOM_EVENT_KIND.DEPARTED, h + 1, h);

        // Make hour 14 an explicit 12-event overflow hour (all distinct agent+kind).
        if (h === 14) {
            const kinds = [
                LOOM_EVENT_KIND.COMPLETED,
                LOOM_EVENT_KIND.COMPLETED,
                LOOM_EVENT_KIND.RATE_LIMITED,
                LOOM_EVENT_KIND.COMPACTED,
                LOOM_EVENT_KIND.COMMIT,
                LOOM_EVENT_KIND.COMMIT,
                LOOM_EVENT_KIND.WAITING,
                LOOM_EVENT_KIND.ERRORED,
                LOOM_EVENT_KIND.MENDED,
                LOOM_EVENT_KIND.PUSH,
                LOOM_EVENT_KIND.RELEASE,
                LOOM_EVENT_KIND.COMPACTED,
            ];
            for (let i = 0; i < kinds.length; i++) {
                const extra = kinds[i] === LOOM_EVENT_KIND.WAITING ? { waitedMs: 600_000 } : {};
                pushEvent(h, 5 + i * 4, kinds[i], i, i, extra);
            }
            continue;
        }

        // Busy mix across the rest of the day (~11 events/hour).
        pushEvent(h, 6, LOOM_EVENT_KIND.COMMIT, h, h);
        pushEvent(h, 11, LOOM_EVENT_KIND.COMMIT, h, h);
        pushEvent(h, 15, LOOM_EVENT_KIND.COMMIT, h + 2, h + 1);
        pushEvent(h, 20, LOOM_EVENT_KIND.PUSH, h + 3, h + 2);
        pushEvent(h, 24, LOOM_EVENT_KIND.COMPACTED, h + 4, h + 3);
        pushEvent(h, 29, LOOM_EVENT_KIND.WAITING, h + 5, h + 1, { waitedMs: (1 + (h % 8)) * LOOM_WAIT_UNIT_MS });
        pushEvent(h, 35, LOOM_EVENT_KIND.ERRORED, h + 6, h + 4);
        if (h % 2 === 0) {
            pushEvent(h, 40, LOOM_EVENT_KIND.MENDED, h + 6, h + 4);
        }
        pushEvent(h, 44, LOOM_EVENT_KIND.RATE_LIMITED, h + 7, h + 5);
        pushEvent(h, 49, LOOM_EVENT_KIND.COMPLETED, h + 8, h + 6);
        if (h % 6 === 0) {
            pushEvent(h, 52, LOOM_EVENT_KIND.RELEASE, h + 9, h);
        }
    }

    const coverage = createCoverageMask({ all: true });
    const sky = [
        'night:clear:full', 'night:clear:full', 'night:cloud:full', 'night:fog',
        'night:clear:waning-gibbous', 'dawn:clear', 'dawn:cloud', 'day:clear',
        'day:partly', 'day:cloud', 'day:rain', 'day:rain',
        'day:overcast', 'day:clear', 'day:clear', 'day:snow',
        'day:partly', 'golden:clear', 'golden:cloud', 'dusk:clear',
        'dusk:storm', 'night:storm', 'night:clear:crescent', null,
    ];

    return { events, coverage, sky };
}

test('exact §5.4 panel geometry and Tapestry band constants match specification', () => {
    assert.equal(LOOM_PANEL_WIDTH, 96);
    assert.equal(LOOM_PANEL_HEIGHT, 72);
    assert.equal(LOOM_HOURS_PER_DAY, 24);
    assert.equal(LOOM_QUARTER_WIDTH, 24);
    assert.equal(LOOM_WARP_STRIDE, 4);

    assert.equal(LOOM_BANDS.topSelvedge.y, 0);
    assert.equal(LOOM_BANDS.topSelvedge.height, 2);
    assert.equal(LOOM_BANDS.skyBorder.y, 2);
    assert.equal(LOOM_BANDS.skyBorder.height, 10);
    assert.equal(LOOM_BANDS.field.y, 12);
    assert.equal(LOOM_BANDS.field.height, 48);
    assert.equal(LOOM_BANDS.repoPennants.y, 60);
    assert.equal(LOOM_BANDS.repoPennants.height, 10);
    assert.equal(LOOM_BANDS.bottomSelvedge.y, 70);
    assert.equal(LOOM_BANDS.bottomSelvedge.height, 2);
    assert.equal(
        LOOM_BANDS.topSelvedge.height
        + LOOM_BANDS.skyBorder.height
        + LOOM_BANDS.field.height
        + LOOM_BANDS.repoPennants.height
        + LOOM_BANDS.bottomSelvedge.height,
        LOOM_PANEL_HEIGHT,
    );

    assert.equal(LOOM_GRID.cols, 3);
    assert.equal(LOOM_GRID.rows, 2);
    assert.equal(LOOM_GRID.cellWidth, 28);
    assert.equal(LOOM_GRID.cellHeight, 22);
    assert.equal(LOOM_GRID.gapX, 4);
    assert.equal(LOOM_GRID.gapY, 4);
    assert.equal(LOOM_GRID.marginX * 2 + LOOM_GRID.cols * LOOM_GRID.cellWidth + (LOOM_GRID.cols - 1) * LOOM_GRID.gapX, 96);
    assert.equal(LOOM_GRID.rows * LOOM_GRID.cellHeight + (LOOM_GRID.rows - 1) * LOOM_GRID.gapY, 48);
    assert.equal(LOOM_GRID.actorWidth + LOOM_GRID.actorGap + LOOM_GRID.stampSize, 28);

    assert.equal(LOOM_TAPESTRY_BAND.y, 1124);
    assert.equal(LOOM_TAPESTRY_BAND.height, 216);
    assert.equal(LOOM_TAPESTRY_BAND.width, 1152);
    assert.equal(LOOM_TAPESTRY_BAND.cols, 12);
    assert.equal(LOOM_TAPESTRY_BAND.rows, 2);

    assert.deepEqual(LOOM_EVENT_WEIGHTS, {
        release: 6,
        push: 5,
        mended: 4,
        errored: 4,
        erroredResolved: 2,
        commit: 3,
        waiting: 3,
        compacted: 2,
        rate_limited: 2,
        completed: 1,
    });
});

test('density: a 12-event hour draws exactly 5 heaviest cells in time order + 6th slot +7 plate', () => {
    const events = [
        // 12 distinct (agentId, kind) events inside hour 10, deliberately out of weight order.
        { ts: atHour(10, 5), kind: 'completed', agentId: 'a01', project: 'alpha' },          // w1
        { ts: atHour(10, 10), kind: 'commit', agentId: 'a02', project: 'alpha' },            // w3
        { ts: atHour(10, 14), kind: 'compacted', agentId: 'a03', project: 'alpha' },         // w2
        { ts: atHour(10, 18), kind: 'rate_limited', agentId: 'a04', project: 'alpha' },      // w2
        { ts: atHour(10, 22), kind: 'waiting', agentId: 'a05', waitedMs: 600_000 },          // w3 (top 5? let's verify!)
        { ts: atHour(10, 26), kind: 'errored', agentId: 'a06', project: 'beta' },            // w4 (open)
        { ts: atHour(10, 30), kind: 'completed', agentId: 'a07', project: 'beta' },          // w1
        { ts: atHour(10, 34), kind: 'mended', agentId: 'a08', project: 'beta' },             // w4
        { ts: atHour(10, 38), kind: 'push', agentId: 'a09', project: 'beta' },               // w5
        { ts: atHour(10, 42), kind: 'commit', agentId: 'a10', project: 'beta' },             // w3
        { ts: atHour(10, 46), kind: 'release', agentId: 'a11', project: 'gamma' },           // w6
        { ts: atHour(10, 50), kind: 'compacted', agentId: 'a12', project: 'gamma' },         // w2
    ];

    const coverage = createCoverageMask({ hours: [10] });
    const day = weaveDay(events, coverage, null, { utc: true, dateKey: DAY_KEY });
    const panel = day.panels[10];

    assert.equal(panel.totalCoalesced, 12);
    assert.equal(panel.eventCells.length, 5);
    assert.equal(panel.overflowCount, 7);
    assert.equal(panel.cells.length, 6);

    // Top 5 heaviest: release(6, 10:46), push(5, 10:38), errored(4, 10:26),
    // mended(4, 10:34), commit(3, 10:10 — wins weight-3 tie by earliest ts!).
    // Laid out in chronological time order: 10:10 -> 10:26 -> 10:34 -> 10:38 -> 10:46.
    assert.deepEqual(
        panel.eventCells.map(c => [c.agentId, c.kind, c.weight, c.slot, c.col, c.row]),
        [
            ['a02', 'commit', 3, 0, 0, 0],
            ['a06', 'errored', 4, 1, 1, 0],
            ['a08', 'mended', 4, 2, 2, 0],
            ['a09', 'push', 5, 3, 0, 1],
            ['a11', 'release', 6, 4, 1, 1],
        ],
    );

    // 6th slot is the +7 overflow plate at col=2, row=1.
    const plate = panel.cells[5];
    assert.equal(plate.type, 'overflow');
    assert.equal(plate.slot, 5);
    assert.equal(plate.col, 2);
    assert.equal(plate.row, 1);
    assert.equal(plate.count, 7);
    assert.equal(plate.label, '+7');

    // Pixel check: rendered +7 plate differs from an empty 6th slot and from a +9 plate.
    const surface7 = renderLoomPanel(panel);
    const slot5X = LOOM_GRID.marginX + 2 * (LOOM_GRID.cellWidth + LOOM_GRID.gapX);
    const slot5Y = LOOM_BANDS.field.y + 1 * (LOOM_GRID.cellHeight + LOOM_GRID.gapY);
    const plate7Pixels = sliceRegion(surface7, slot5X, slot5Y, LOOM_GRID.cellWidth, LOOM_GRID.cellHeight);

    const events14 = [
        ...events,
        { ts: atHour(10, 52), kind: 'completed', agentId: 'a13' },
        { ts: atHour(10, 54), kind: 'completed', agentId: 'a14' },
    ];
    const surface9 = renderLoomPanel(weaveDay(events14, coverage, null, { utc: true }).panels[10]);
    const plate9Pixels = sliceRegion(surface9, slot5X, slot5Y, LOOM_GRID.cellWidth, LOOM_GRID.cellHeight);
    assert.notDeepEqual(plate7Pixels, plate9Pixels, '+7 and +9 overflow plates render distinct pixel numerals');
});

test('6-event hour fills all 6 slots with zero overflow plate; 7-event hour produces +2', () => {
    const coverage = createCoverageMask({ hours: [9] });
    const six = Array.from({ length: 6 }, (_, i) => ({
        ts: atHour(9, 5 + i * 5),
        kind: 'commit',
        agentId: `agent-${i}`,
    }));
    const day6 = weaveDay(six, coverage, null, { utc: true });
    assert.equal(day6.panels[9].cells.length, 6);
    assert.equal(day6.panels[9].eventCells.length, 6);
    assert.equal(day6.panels[9].overflowCount, 0);
    assert.equal(day6.panels[9].cells.every(c => c.type === 'event'), true);

    const seven = [...six, { ts: atHour(9, 50), kind: 'commit', agentId: 'agent-6' }];
    const day7 = weaveDay(seven, coverage, null, { utc: true });
    assert.equal(day7.panels[9].eventCells.length, 5);
    assert.equal(day7.panels[9].overflowCount, 2);
    assert.equal(day7.panels[9].cells[5].type, 'overflow');
    assert.equal(day7.panels[9].cells[5].label, '+2');
});

test('open vs resolved errors: open errored gets weight 4, resolved/mended error drops to weight 2', () => {
    const events = [
        // a1 errors in hour 8 and is mended in hour 9 -> resolved (weight 2)
        { ts: atHour(8, 10), kind: 'errored', agentId: 'a1' },
        { ts: atHour(9, 5), kind: 'mended', agentId: 'a1' },
        // a2 errors in hour 8 and is resolved in hour 8 -> resolved (weight 2)
        { ts: atHour(8, 12), kind: 'errored', agentId: 'a2' },
        { ts: atHour(8, 25), kind: 'resolved', agentId: 'a2', waitedMs: 0 },
        // a3 errors in hour 8 and never resolves -> open (weight 4)
        { ts: atHour(8, 15), kind: 'errored', agentId: 'a3' },
        // 5 commits (weight 3) in hour 8 to force selection between open (4) vs resolved (2) errors
        { ts: atHour(8, 1), kind: 'commit', agentId: 'c1' },
        { ts: atHour(8, 2), kind: 'commit', agentId: 'c2' },
        { ts: atHour(8, 3), kind: 'commit', agentId: 'c3' },
        { ts: atHour(8, 4), kind: 'commit', agentId: 'c4' },
        { ts: atHour(8, 5), kind: 'commit', agentId: 'c5' },
    ];
    const day = weaveDay(events, createCoverageMask({ hours: [8, 9] }), null, { utc: true });
    const h8 = day.panels[8];
    assert.equal(h8.totalCoalesced, 8);
    assert.equal(h8.overflowCount, 3);
    // Open error (weight 4) MUST beat the commits (weight 3), while resolved errors (weight 2) lose!
    const selectedIds = h8.eventCells.map(c => c.agentId);
    assert.ok(selectedIds.includes('a3'), 'open error (weight 4) is selected');
    assert.ok(!selectedIds.includes('a1'), 'cross-hour mended error (weight 2) yields to commits (weight 3)');
    assert.ok(!selectedIds.includes('a2'), 'resolved error (weight 2) yields to commits (weight 3)');
    assert.equal(day.stats.byKind.erroredOpen, 1);
    assert.equal(day.stats.byKind.erroredResolved, 2);

    // Visually, open error stamp differs from resolved error stamp.
    const openDay = weaveDay([{ ts: atHour(8, 10), kind: 'errored', agentId: 'x' }], createCoverageMask({ hours: [8] }), null, { utc: true });
    const resDay = weaveDay([
        { ts: atHour(8, 10), kind: 'errored', agentId: 'x' },
        { ts: atHour(9, 10), kind: 'mended', agentId: 'x' },
    ], createCoverageMask({ hours: [8, 9] }), null, { utc: true });
    assert.equal(openDay.panels[8].eventCells[0].weight, 4);
    assert.equal(openDay.panels[8].eventCells[0].open, true);
    assert.equal(resDay.panels[8].eventCells[0].weight, 2);
    assert.equal(resDay.panels[8].eventCells[0].open, false);
    assert.notDeepEqual(renderLoomPanel(openDay.panels[8]).data, renderLoomPanel(resDay.panels[8]).data);
});

test('coalescing: same (agentId, kind) in one hour folds into one cell with up to 5 pips then numeral', () => {
    const coverage = createCoverageMask({ hours: [11] });
    const makeCount = (n) => Array.from({ length: n }, (_, i) => ({
        ts: atHour(11, 2 + i),
        kind: 'commit',
        agentId: 'smith',
        project: 'claude-ville',
    }));

    const d1 = weaveDay(makeCount(1), coverage, null, { utc: true });
    const d5 = weaveDay(makeCount(5), coverage, null, { utc: true });
    const d6 = weaveDay(makeCount(6), coverage, null, { utc: true });
    const d14 = weaveDay(makeCount(14), coverage, null, { utc: true });

    assert.equal(d1.panels[11].cells.length, 1);
    assert.equal(d5.panels[11].cells.length, 1);
    assert.equal(d6.panels[11].cells.length, 1);
    assert.equal(d14.panels[11].cells.length, 1);

    assert.equal(d1.panels[11].eventCells[0].pipMode, 'pips');
    assert.equal(d1.panels[11].eventCells[0].pips, 1);
    assert.equal(d1.panels[11].eventCells[0].numeral, null);

    assert.equal(d5.panels[11].eventCells[0].pipMode, 'pips');
    assert.equal(d5.panels[11].eventCells[0].pips, LOOM_MAX_PIPS);
    assert.equal(d5.panels[11].eventCells[0].numeral, null);

    assert.equal(d6.panels[11].eventCells[0].pipMode, 'numeral');
    assert.equal(d6.panels[11].eventCells[0].pips, 0);
    assert.equal(d6.panels[11].eventCells[0].numeral, 6);

    assert.equal(d14.panels[11].eventCells[0].pipMode, 'numeral');
    assert.equal(d14.panels[11].eventCells[0].numeral, 14);

    // Distinct pixel output in the pip/numeral row beneath the 12x12 stamp.
    const subX = LOOM_GRID.marginX + LOOM_GRID.actorWidth + LOOM_GRID.actorGap;
    const subY = LOOM_BANDS.field.y + 15;
    const r1 = sliceRegion(renderLoomPanel(d1.panels[11]), subX, subY, 12, 6);
    const r5 = sliceRegion(renderLoomPanel(d5.panels[11]), subX, subY, 12, 6);
    const r6 = sliceRegion(renderLoomPanel(d6.panels[11]), subX, subY, 12, 6);
    const r14 = sliceRegion(renderLoomPanel(d14.panels[11]), subX, subY, 12, 6);
    assert.notDeepEqual(r1, r5);
    assert.notDeepEqual(r5, r6);
    assert.notDeepEqual(r6, r14);
});

test('waits: <5 min ignored, >=5 min renders bell + 1 knot per 5 min (up to 6 knots, then numeral)', () => {
    const coverage = createCoverageMask({ hours: [12, 13] });

    // Short wait (< 5 min): ignored as cell.
    const shortWait = weaveDay([
        { ts: atHour(12, 5), kind: 'waiting', agentId: 'w0' },
        { ts: atHour(12, 9), kind: 'resolved', agentId: 'w0', waitedMs: 299_999 },
    ], coverage, null, { utc: true });
    assert.equal(shortWait.panels[12].cells.length, 0);

    // Paired ChronicleLog waiting + resolved across hour boundary (12:55 -> 13:10 = 15 min -> 3 knots in hour 12).
    const pairedCrossHour = weaveDay([
        { ts: atHour(12, 55), kind: 'waiting', agentId: 'w1' },
        { ts: atHour(13, 10), kind: 'resolved', agentId: 'w1', waitedMs: 15 * 60 * 1000 },
    ], coverage, null, { utc: true });
    assert.equal(pairedCrossHour.panels[12].cells.length, 1);
    assert.equal(pairedCrossHour.panels[13].cells.length, 0);
    assert.equal(pairedCrossHour.panels[12].eventCells[0].waitKnots, 3);
    assert.equal(pairedCrossHour.panels[12].eventCells[0].pipMode, 'knots');

    // Boundary: 6 knots (30 min) vs 7 knots (35 min -> numeral 7).
    const sixKnots = weaveDay([
        { ts: atHour(12, 10), kind: 'waiting', agentId: 'w6', waitedMs: 6 * LOOM_WAIT_UNIT_MS },
    ], coverage, null, { utc: true });
    const sevenKnots = weaveDay([
        { ts: atHour(12, 10), kind: 'waiting', agentId: 'w7', waitedMs: 7 * LOOM_WAIT_UNIT_MS },
    ], coverage, null, { utc: true });

    assert.equal(sixKnots.panels[12].eventCells[0].waitKnots, LOOM_MAX_WAIT_KNOTS);
    assert.equal(sixKnots.panels[12].eventCells[0].pipMode, 'knots');
    assert.equal(sixKnots.panels[12].eventCells[0].numeral, null);

    assert.equal(sevenKnots.panels[12].eventCells[0].waitKnots, 7);
    assert.equal(sevenKnots.panels[12].eventCells[0].pipMode, 'knot-numeral');
    assert.equal(sevenKnots.panels[12].eventCells[0].numeral, 7);

    const subX = LOOM_GRID.marginX + LOOM_GRID.actorWidth + LOOM_GRID.actorGap;
    const subY = LOOM_BANDS.field.y + 15;
    const px6 = sliceRegion(renderLoomPanel(sixKnots.panels[12]), subX, subY, 12, 6);
    const px7 = sliceRegion(renderLoomPanel(sevenKnots.panels[12]), subX, subY, 12, 6);
    assert.notDeepEqual(px6, px7, '6 knots and numeral 7 render distinctly under the bell stamp');
});

test('arrivals and departures are selvedge border ticks only, never cells', () => {
    const coverage = createCoverageMask({ hours: [7] });
    const events = [];
    for (let i = 0; i < 10; i++) {
        events.push({ ts: atHour(7, i * 5), kind: 'arrived', agentId: `a${i}` });
        events.push({ ts: atHour(7, i * 5 + 2), kind: 'departed', agentId: `d${i}` });
    }
    const day = weaveDay(events, coverage, null, { utc: true });
    const emptyDay = weaveDay([], coverage, null, { utc: true });

    assert.equal(day.panels[7].cells.length, 0);
    assert.equal(day.panels[7].overflowCount, 0);
    assert.equal(day.panels[7].arrivals.length, 10);
    assert.equal(day.panels[7].departures.length, 10);

    const withTicks = renderLoomPanel(day.panels[7]);
    const withoutTicks = renderLoomPanel(emptyDay.panels[7]);

    // Field rows (12..59) must be pixel-identical to an empty panel.
    assert.deepEqual(
        sliceRegion(withTicks, 0, LOOM_BANDS.field.y, LOOM_PANEL_WIDTH, LOOM_BANDS.field.height),
        sliceRegion(withoutTicks, 0, LOOM_BANDS.field.y, LOOM_PANEL_WIDTH, LOOM_BANDS.field.height),
        'arrivals and departures must never paint inside the cell field',
    );
    // Top selvedge (rows 0..1) and bottom selvedge (rows 70..71) MUST differ.
    assert.notDeepEqual(
        sliceRegion(withTicks, 0, 0, LOOM_PANEL_WIDTH, 2),
        sliceRegion(withoutTicks, 0, 0, LOOM_PANEL_WIDTH, 2),
        'arrivals paint ticks on the top selvedge',
    );
    assert.notDeepEqual(
        sliceRegion(withTicks, 0, 70, LOOM_PANEL_WIDTH, 2),
        sliceRegion(withoutTicks, 0, 70, LOOM_PANEL_WIDTH, 2),
        'departures paint ticks on the bottom selvedge',
    );
});

test('coverage & bare warp: null coverage is all bare warp; uncovered quarters show vertical warp every 4 px with no weft', () => {
    // 1. Missing/null coverage treats all 96 quarters as uncovered.
    const dayNull = weaveDay(
        [{ ts: atHour(10, 5), kind: 'release', agentId: 'a1', project: 'claude-ville' }],
        null,
        Array(24).fill('day:clear'),
        { utc: true },
    );
    assert.equal(dayNull.stats.coveredQuarters, 0);
    assert.equal(dayNull.stats.uncoveredQuarters, 96);
    assert.equal(dayNull.panels[10].fullyUncovered, true);

    const bareSurface = renderLoomPanel(dayNull.panels[10]);
    for (let y = 0; y < LOOM_PANEL_HEIGHT; y++) {
        const warpPx = readRgba(bareSurface, 0, y);
        const gapPx = readRgba(bareSurface, 1, y);
        assert.notDeepEqual(warpPx, gapPx, `row ${y}: warp thread column differs from bare gap`);
        for (let x = 0; x < LOOM_PANEL_WIDTH; x++) {
            const px = readRgba(bareSurface, x, y);
            if (x % LOOM_WARP_STRIDE === 0) {
                assert.deepEqual(px, warpPx, `(${x},${y}) must be vertical warp thread`);
            } else {
                assert.deepEqual(px, gapPx, `(${x},${y}) must be bare warp gap (no weft)`);
            }
        }
    }

    // 2. Partial coverage: hour 10 has q0, q1 covered (x=0..47) and q2, q3 uncovered (x=48..95).
    const partialMask = createCoverageMask({ quarters: [10 * 4 + 0, 10 * 4 + 1] });
    const dayPartial = weaveDay(
        [{ ts: atHour(10, 5), kind: 'commit', agentId: 'a1', project: 'claude-ville' }],
        partialMask,
        Array(24).fill('day:clear'),
        { utc: true },
    );
    assert.deepEqual(dayPartial.panels[10].coverage, [true, true, false, false]);
    const partialSurface = renderLoomPanel(dayPartial.panels[10]);

    // Uncovered quarters q2 and q3 (x = 48..95) must be 100% pure bare warp top to bottom.
    assert.deepEqual(
        sliceRegion(partialSurface, 48, 0, 48, LOOM_PANEL_HEIGHT),
        sliceRegion(bareSurface, 48, 0, 48, LOOM_PANEL_HEIGHT),
        'uncovered 24 px quarter bands render pure bare warp across full height',
    );
    // Covered quarters q0 and q1 (x = 0..47) must carry woven sky, linen, and event cell.
    assert.notDeepEqual(
        sliceRegion(partialSurface, 0, 0, 48, LOOM_PANEL_HEIGHT),
        sliceRegion(bareSurface, 0, 0, 48, LOOM_PANEL_HEIGHT),
    );

    // 3. Equivalent coverage mask encodings decode identically.
    const bitString = Array.from({ length: 96 }, (_, i) => (i === 40 || i === 41 ? '1' : '0')).join('');
    const bigIntMask = (1n << 40n) | (1n << 41n);
    const hexMask = bigIntMask.toString(16).padStart(24, '0');
    const boolArr = Array.from({ length: 96 }, (_, i) => i === 40 || i === 41);
    const u32 = new Uint32Array([0, (1 << 8) | (1 << 9), 0]);
    const refBits = normalizeCoverageBits(partialMask);
    assert.deepEqual(normalizeCoverageBits(bitString), refBits);
    assert.deepEqual(normalizeCoverageBits(bigIntMask), refBits);
    assert.deepEqual(normalizeCoverageBits(hexMask), refBits);
    assert.deepEqual(normalizeCoverageBits(boolArr), refBits);
    assert.deepEqual(normalizeCoverageBits(u32), refBits);
});

test('sky border reflects sky codes and uses undyed linen when missing/unknown (V8 honesty)', () => {
    const coverage = createCoverageMask({ all: true });
    const sky = Array(24).fill(null);
    sky[0] = 'night:clear:full';
    sky[6] = 'dawn:clear';
    sky[10] = 'day:clear';
    sky[11] = 'day:rain';
    sky[12] = 'day:snow';
    sky[13] = 'unknown';
    sky[18] = 'golden:clear';
    sky[20] = 'dusk:storm';

    const day = weaveDay([], coverage, sky, { utc: true });
    assert.equal(day.panels[10].sky.known, true);
    assert.equal(day.panels[13].sky.known, false);
    assert.equal(day.panels[14].sky.known, false);

    const skyBand = (h) => sliceRegion(
        renderLoomPanel(day.panels[h]),
        0,
        LOOM_BANDS.skyBorder.y,
        LOOM_PANEL_WIDTH,
        LOOM_BANDS.skyBorder.height,
    );

    // Unknown and missing sky both draw the exact same undyed linen border.
    assert.deepEqual(skyBand(13), skyBand(14));
    // Known skies differ from undyed linen and from each other.
    assert.notDeepEqual(skyBand(10), skyBand(14));
    assert.notDeepEqual(skyBand(10), skyBand(11));
    assert.notDeepEqual(skyBand(11), skyBand(12));
    assert.notDeepEqual(skyBand(0), skyBand(10));
    assert.notDeepEqual(skyBand(6), skyBand(18));
    assert.notDeepEqual(skyBand(18), skyBand(20));
});

test('repo pennants render in order of first activity that hour with pure PENNANT_PALETTE colors', () => {
    const coverage = createCoverageMask({ hours: [15] });
    const events = [
        { ts: atHour(15, 4), kind: 'commit', agentId: 'a1', project: 'zebra-repo' },
        { ts: atHour(15, 10), kind: 'commit', agentId: 'a2', project: 'alpha-repo' },
        { ts: atHour(15, 15), kind: 'push', agentId: 'a1', project: 'zebra-repo' }, // repeat ignored
        { ts: atHour(15, 22), kind: 'commit', agentId: 'a3', project: 'middle-repo' },
    ];
    const day = weaveDay(events, coverage, null, { utc: true });
    const repos = day.panels[15].repos;
    assert.deepEqual(repos.map(r => r.repo), ['zebra-repo', 'alpha-repo', 'middle-repo']);
    for (const r of repos) {
        assert.ok(PENNANT_PALETTE.includes(r.color));
        assert.equal(r.color, loomRepoPennant(r.repo).color);
    }

    // Reversing first-activity order changes the pennant footer pixels.
    const reversed = [
        { ts: atHour(15, 4), kind: 'commit', agentId: 'a3', project: 'middle-repo' },
        { ts: atHour(15, 10), kind: 'commit', agentId: 'a2', project: 'alpha-repo' },
        { ts: atHour(15, 22), kind: 'commit', agentId: 'a1', project: 'zebra-repo' },
    ];
    const p1 = sliceRegion(renderLoomPanel(day.panels[15]), 0, 60, LOOM_PANEL_WIDTH, 10);
    const p2 = sliceRegion(
        renderLoomPanel(weaveDay(reversed, coverage, null, { utc: true }).panels[15]),
        0, 60, LOOM_PANEL_WIDTH, 10,
    );
    assert.notDeepEqual(p1, p2);
});

test('actor miniature uses resolveMiniature callback when provided and falls back to plain slate pawn', () => {
    const coverage = createCoverageMask({ hours: [10] });
    const day = weaveDay(
        [{ ts: atHour(10, 5), kind: 'commit', agentId: 'a1', model: 'claude-opus-4-6' }],
        coverage,
        null,
        { utc: true },
    );

    const pawnSurface = renderLoomPanel(day.panels[10]);
    const throwingSurface = renderLoomPanel(day.panels[10], {
        resolveMiniature: () => { throw new Error('sheet failed to load'); },
    });
    const nullSurface = renderLoomPanel(day.panels[10], {
        resolveMiniature: () => null,
    });
    assert.deepEqual(pawnSurface.data, throwingSurface.data);
    assert.deepEqual(pawnSurface.data, nullSurface.data);

    // Custom 14x16 crimson miniature replaces the pawn inside the left 14 px box.
    const customData = new Uint8ClampedArray(14 * 16 * 4);
    for (let i = 0; i < customData.length; i += 4) {
        customData[i] = 180;
        customData[i + 1] = 60;
        customData[i + 2] = 70;
        customData[i + 3] = 255;
    }
    const customSurface = renderLoomPanel(day.panels[10], {
        resolveMiniature: () => ({ width: 14, height: 16, data: customData }),
    });
    assert.notDeepEqual(
        sliceRegion(customSurface, LOOM_GRID.marginX, LOOM_BANDS.field.y + 3, 14, 16),
        sliceRegion(pawnSurface, LOOM_GRID.marginX, LOOM_BANDS.field.y + 3, 14, 16),
    );
    assert.deepEqual(readRgba(customSurface, LOOM_GRID.marginX + 7, LOOM_BANDS.field.y + 10), [180, 60, 70, 255]);
});

test('determinism & PNG integrity: two independent weaves + PNG renders are byte-identical across all 3 layouts', async () => {
    const fixtureA = buildBusyDayFixture();
    // Independently construct the same events in reversed order to verify order-invariant determinism.
    const fixtureB = {
        events: [...fixtureA.events].reverse().map(e => ({ ...e })),
        coverage: new Uint8Array(fixtureA.coverage),
        sky: [...fixtureA.sky],
    };

    const dayA = weaveDay(fixtureA.events, fixtureA.coverage, fixtureA.sky, { utc: true, dateKey: DAY_KEY });
    const dayB = weaveDay(fixtureB.events, fixtureB.coverage, fixtureB.sky, { utc: true, dateKey: DAY_KEY });
    assert.deepEqual(dayA, dayB);

    const layouts = [
        { layout: 'strip', expectedW: 2304, expectedH: 72 },
        { layout: 'tapestry', expectedW: 1152, expectedH: 216 },
        { layout: 'single-panel', hour: 14, expectedW: 96, expectedH: 72 },
    ];

    let pngjs = null;
    try {
        ({ PNG: pngjs } = await import('pngjs'));
    } catch { /* optional when node_modules is not symlinked */ }

    for (const cfg of layouts) {
        const rgbaA = renderLoomToRgba(dayA, cfg);
        const rgbaB = renderLoomToRgba(dayB, cfg);
        assert.equal(rgbaA.width, cfg.expectedW);
        assert.equal(rgbaA.height, cfg.expectedH);
        assert.equal(Buffer.compare(Buffer.from(rgbaA.data), Buffer.from(rgbaB.data)), 0, `${cfg.layout} RGBA byte-identical`);

        const pngA = encodeLoomPng(rgbaA);
        const pngB = encodeLoomPng(rgbaB);
        assert.equal(Buffer.compare(Buffer.from(pngA), Buffer.from(pngB)), 0, `${cfg.layout} PNG byte-identical`);

        // Verify valid PNG magic header + IHDR dimensions.
        assert.deepEqual([...pngA.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(pngA.buffer, pngA.byteOffset, pngA.byteLength);
        assert.equal(view.getUint32(16), cfg.expectedW);
        assert.equal(view.getUint32(20), cfg.expectedH);

        // If pngjs is installed, round-trip decode and assert 0-bit pixel loss.
        if (pngjs) {
            const decoded = pngjs.sync.read(Buffer.from(pngA));
            assert.equal(decoded.width, cfg.expectedW);
            assert.equal(decoded.height, cfg.expectedH);
            assert.equal(Buffer.compare(decoded.data, Buffer.from(rgbaA.data)), 0, `${cfg.layout} PNG lossless round-trip`);
        }
    }

    // Convenience wrappers agree byte-for-byte with renderLoomToRgba.
    assert.equal(
        Buffer.compare(Buffer.from(renderLoomFrieze(dayA).data), Buffer.from(renderLoomToRgba(dayA, { layout: 'strip' }).data)),
        0,
    );
    assert.equal(
        Buffer.compare(Buffer.from(renderLoomTapestryGrid(dayA).data), Buffer.from(renderLoomToRgba(dayA, { layout: 'tapestry' }).data)),
        0,
    );
    const tightTapestry = renderLoomTapestryGrid(dayA, { padY: 0, rowGap: 0 });
    assert.equal(tightTapestry.width, 1152);
    assert.equal(tightTapestry.height, 144);
});

test('zero-text guard: drawLoomToCanvas produces textCalls === 0 under withPostcardFrame and source has zero text calls', () => {
    const { events, coverage, sky } = buildBusyDayFixture();
    // Add coalesced > 5 count and > 6 wait knots to exercise every pixel-numeral path.
    for (let i = 0; i < 8; i++) {
        events.push({ ts: atHour(10, 1 + i), kind: 'commit', agentId: 'numeral-smith', project: 'claude-ville' });
    }
    events.push({ ts: atHour(10, 30), kind: 'waiting', agentId: 'numeral-waiter', waitedMs: 9 * LOOM_WAIT_UNIT_MS });
    const day = weaveDay(events, coverage, sky, { utc: true, dateKey: DAY_KEY });

    class MockContext2D {
        constructor() {
            this.fillStyle = '';
            this.imageSmoothingEnabled = true;
            this.fillRectCalls = 0;
            this.putImageDataCalls = 0;
        }
        fillRect() { this.fillRectCalls += 1; }
        putImageData() { this.putImageDataCalls += 1; }
        fillText() { throw new Error('fillText must never be called'); }
        strokeText() { throw new Error('strokeText must never be called'); }
    }

    const prevCtx = globalThis.CanvasRenderingContext2D;
    globalThis.CanvasRenderingContext2D = MockContext2D;
    try {
        for (const layout of ['strip', 'tapestry', 'single-panel']) {
            const ctx = new MockContext2D();
            const { result, textCalls, textSites } = withPostcardFrame(
                () => drawLoomToCanvas(ctx, day, { layout, hour: 14, preferFillRect: true }),
                { trace: true },
            );
            assert.equal(textCalls, 0, `${layout}: withPostcardFrame textCalls must be 0`);
            assert.deepEqual(textSites, [], `${layout}: zero textSites`);
            assert.ok(ctx.fillRectCalls > 0, `${layout}: painted pixels via integer fillRect`);
            assert.ok(result.width > 0 && result.height > 0);
        }
    } finally {
        globalThis.CanvasRenderingContext2D = prevCtx;
    }

    // Static hygiene proof: zero text API calls, zero wall-clock/RNG, zero node:* imports.
    const source = fs.readFileSync(LOOM_SRC_PATH, 'utf8');
    const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    assert.equal(/\b(fillText|strokeText|measureText)\b/.test(codeOnly), false, 'no Canvas2D text API calls');
    assert.equal(/\bDate\.now\s*\(/.test(codeOnly), false, 'no Date.now() in pure weaver');
    assert.equal(/\bMath\.random\s*\(/.test(codeOnly), false, 'no Math.random() in pure weaver');
    assert.equal(/from\s+['"]node:/.test(codeOnly), false, 'browser-safe ES module (no node:* imports)');
});

test('performance: full 24-hour busy day weaves and renders RGBA strip well within <= 50 ms cap', () => {
    const { events, coverage, sky } = buildBusyDayFixture();
    // Warm up JIT once before measuring.
    const warm = weaveDay(events, coverage, sky, { utc: true, dateKey: DAY_KEY });
    renderLoomToRgba(warm, { layout: 'strip' });

    const samples = [];
    for (let run = 0; run < 5; run++) {
        const t0 = performance.now();
        const day = weaveDay(events, coverage, sky, { utc: true, dateKey: DAY_KEY });
        const rgba = renderLoomToRgba(day, { layout: 'strip' });
        const elapsed = performance.now() - t0;
        assert.equal(rgba.width, 2304);
        assert.equal(rgba.height, 72);
        samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    const maxMs = samples[samples.length - 1];
    assert.ok(
        medianMs <= 50,
        `expected median weave+render <= 50 ms, got median=${medianMs.toFixed(2)} ms (max=${maxMs.toFixed(2)} ms)`,
    );
});

test('W6-Fix-B craft: canonical openErrorsAt, pure bare warp without horizontal weft, linen backing under cells, ongoing waits, and overflow stats', () => {
    // 1. Canonical openErrorsAt(events, endTs) resolves on mended, resolved, completed, and departed.
    assert.deepEqual([...ERROR_RESOLVING_KINDS], ['mended', 'resolved', 'completed', 'departed']);
    const errEvents = [
        { ts: atHour(9, 10), kind: 'errored', agentId: 'a-mend' },
        { ts: atHour(9, 20), kind: 'mended', agentId: 'a-mend' },
        { ts: atHour(10, 10), kind: 'errored', agentId: 'a-res' },
        { ts: atHour(10, 20), kind: 'resolved', agentId: 'a-res' },
        { ts: atHour(11, 10), kind: 'errored', agentId: 'a-comp' },
        { ts: atHour(11, 20), kind: 'completed', agentId: 'a-comp' },
        { ts: atHour(12, 10), kind: 'errored', agentId: 'a-dep' },
        { ts: atHour(12, 20), kind: 'departed', agentId: 'a-dep' },
        { ts: atHour(13, 10), kind: 'errored', agentId: 'a-open' },
    ];
    assert.deepEqual(
        openErrorsAt(errEvents, atHour(21, 0)).map(e => e.agentId),
        ['a-open'],
        'all four closing kinds close an agent open error',
    );
    assert.deepEqual(
        openErrorsAt(errEvents, atHour(11, 15)).map(e => e.agentId),
        ['a-comp'],
        'cutoff endTs excludes resolutions after endTs',
    );

    // 2. Bare warp has ZERO horizontal weft banding (uniform gap color across all rows 0..71).
    const emptyDay = weaveDay([], null, null, { utc: true, dateKey: DAY_KEY });
    const bare = renderLoomPanel(emptyDay.panels[0]);
    const refGap = readRgba(bare, 1, 0);
    for (let y = 0; y < LOOM_PANEL_HEIGHT; y++) {
        assert.deepEqual(readRgba(bare, 1, y), refGap, `row ${y}: bare warp gap has zero horizontal weft banding`);
    }

    // 3. Event cell placed in a partly covered hour receives woven linen backing even over uncovered quarters.
    const partialCov = createCoverageMask({ quarters: [14 * 4 + 0] });
    const partialDay = weaveDay([
        { ts: atHour(14, 2), kind: 'commit', agentId: 'a1' },
        { ts: atHour(14, 4), kind: 'push', agentId: 'a2' },
        { ts: atHour(14, 6), kind: 'release', agentId: 'a3' },
    ], partialCov, null, { utc: true, dateKey: DAY_KEY });
    const partialSurface = renderLoomPanel(partialDay.panels[14]);
    const slot2X = LOOM_GRID.marginX + 2 * (LOOM_GRID.cellWidth + LOOM_GRID.gapX);
    const slot2Y = LOOM_BANDS.field.y;
    const cornerPx = readRgba(partialSurface, slot2X, slot2Y);
    assert.notDeepEqual(cornerPx, refGap, 'cell footprint over uncovered quarter paints woven linen backing, not bare warp');
    assert.ok(cornerPx[0] >= 180 && cornerPx[1] >= 160 && cornerPx[2] >= 120, 'cell backing uses warm woven linen');

    // 4. Ongoing unresolved long wait (>= 5 min up to endTs) is woven with wait knots.
    const ongoingDay = weaveDay(
        [{ ts: atHour(15, 10), kind: 'waiting', agentId: 'w-live' }],
        createCoverageMask({ hours: [15] }),
        null,
        { utc: true, dateKey: DAY_KEY, endTs: atHour(15, 25) },
    );
    assert.equal(ongoingDay.panels[15].eventCells.length, 1);
    assert.equal(ongoingDay.panels[15].eventCells[0].waitKnots, 3);
    assert.equal(ongoingDay.panels[15].eventCells[0].pipMode, 'knots');

    // 5. Overflow stats distinguish hidden coalesced cells (`overflowCells`) from hidden raw events (`overflowEvents`).
    const overflowInput = [];
    for (let i = 0; i < 7; i++) {
        if (i < 5) {
            overflowInput.push({ ts: atHour(16, i * 5), kind: 'release', agentId: `top-${i}` });
        } else {
            for (let k = 0; k < 3; k++) {
                overflowInput.push({ ts: atHour(16, 30 + i * 3 + k), kind: 'completed', agentId: `low-${i}` });
            }
        }
    }
    const overflowDay = weaveDay(overflowInput, createCoverageMask({ hours: [16] }), null, { utc: true, dateKey: DAY_KEY });
    assert.equal(overflowDay.panels[16].overflowCells, 2);
    assert.equal(overflowDay.panels[16].overflowEvents, 6);
    assert.equal(overflowDay.panels[16].cells[5].label, '+2');
    assert.equal(overflowDay.stats.overflowCells, 2);
    assert.equal(overflowDay.stats.overflowEvents, 6);

    // 6. Shared decodeCoverageBits returns null for missing/invalid input.
    assert.equal(decodeCoverageBits(null), null);
    assert.equal(decodeCoverageBits('not-hex'), null);
    assert.equal(decodeCoverageBits(partialCov).length, 96);
});
