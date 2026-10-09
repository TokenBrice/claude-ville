import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    WAIT_AGE_STEPS_MS,
    oldestActionable,
    waitAgeTier,
} from '../../claudeville/src/domain/services/SignalLedger.js';
import { formatWaitAge } from '../../claudeville/src/presentation/shared/Formatters.js';
import { candleWaxTexels } from '../../claudeville/src/presentation/character-mode/RestSeats.js';
import { layoutAttentionPlates, offFrameTallyText } from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';

// Living Isle W5.4–W5.6: one wait-age ladder, the Command plaque's attention
// cell, the HUD's oldest wait and the off-frame tally tab.

const MIN = 60_000;
const ctx = { font: '', save() {}, restore() {}, measureText: text => ({ width: String(text).length * 7 }) };
const camera = { worldToScreen: (x, y) => ({ x, y: y + 300 }) };
const viewport = { width: 1600, height: 900 };

function sprite(id, status, x, since = null, extra = {}) {
    return { x, y: 0, agent: { id, name: id, status, statusSince: since }, ...extra };
}

test('the wait-age ladder steps at exactly 1, 5 and 15 minutes; an unknown age has no rung', () => {
    assert.deepEqual(WAIT_AGE_STEPS_MS, [MIN, 5 * MIN, 15 * MIN]);
    const cases = [
        [0, 0], [MIN - 1, 0],
        [MIN, 1], [5 * MIN - 1, 1],
        [5 * MIN, 2], [15 * MIN - 1, 2],
        [15 * MIN, 3], [24 * 60 * MIN, 3],
    ];
    for (const [age, tier] of cases) assert.equal(waitAgeTier(age), tier, `age ${age}`);
    for (const unknown of [null, undefined, NaN, Infinity, -1, '120000']) assert.equal(waitAgeTier(unknown), null);
});

test('petitioner candles step their wax on the same ladder', () => {
    assert.equal(candleWaxTexels(MIN - 1), 12);
    assert.equal(candleWaxTexels(MIN), 9);
    assert.equal(candleWaxTexels(5 * MIN - 1), 9);
    assert.equal(candleWaxTexels(5 * MIN), 6);
    assert.equal(candleWaxTexels(15 * MIN - 1), 6);
    assert.equal(candleWaxTexels(15 * MIN), 3);
    assert.equal(candleWaxTexels(null), 3);
});

test('T1 beacons grow by rung: 2×, then a ringed 2× medallion from 5 min, then 3× from 15 min', () => {
    const now = 10_000_000;
    const layout = layoutAttentionPlates(ctx, {
        sprites: [
            sprite('fresh', AgentStatus.WAITING_ON_USER, 100, now - 30_000),
            sprite('one', AgentStatus.WAITING_ON_USER, 400, now - 2 * MIN),
            sprite('five', AgentStatus.ERRORED, 700, now - 6 * MIN),
            sprite('fifteen', AgentStatus.RATE_LIMITED, 1000, now - 16 * MIN),
            sprite('unknown', AgentStatus.ERRORED, 1300),
        ],
        camera, viewport, now,
    });
    const beacons = layout.beacons.map(beacon => ({
        x: (beacon.left + beacon.right) / 2,
        size: beacon.right - beacon.left,
        step: beacon.step,
        ring: beacon.ring,
    })).sort((a, b) => a.x - b.x);
    assert.deepEqual(beacons.map(({ size, step, ring }) => [size, step, ring]), [
        [18, 2, false], [18, 2, false], [26, 2, true], [26, 3, false], [18, 2, false],
    ]);
    // Notch rows: none below a minute or for an unknown age, one per rung above
    // the first; each notched status cell is exactly one notch column wider.
    const plates = Object.fromEntries(layout.plates.map(plate => [plate.ids[0], plate]));
    assert.equal(plates.fresh.tier, 0);
    assert.equal(plates.one.tier, 1);
    assert.equal(plates.five.tier, 2);
    assert.equal(plates.fifteen.tier, 3);
    assert.equal(plates.unknown.tier, null);
    const wordCell = id => plates[id].widths.wordCell - 7 * plates[id].word.length;
    assert.equal(wordCell('one') - wordCell('fresh'), 6);
    assert.equal(wordCell('unknown'), wordCell('fresh'));
});

test('the HUD oldest wait is the smallest known anchor among actionable agents, at minute grain', () => {
    const agents = [
        { id: 'unknown', status: AgentStatus.WAITING_ON_USER },
        { id: 'young', status: AgentStatus.WAITING_ON_USER, awaitingSince: 9_000 },
        { id: 'old', status: AgentStatus.ERRORED, lastSessionActivity: 2_000 },
        { id: 'older-but-working', status: AgentStatus.WORKING, lastSessionActivity: 1_000 },
    ];
    assert.equal(oldestActionable(agents).id, 'old');
    assert.equal(oldestActionable([agents[0], agents[3]]), null);
    assert.equal(oldestActionable([]), null);

    assert.equal(formatWaitAge(0), '<1m');
    assert.equal(formatWaitAge(MIN - 1), '<1m');
    assert.equal(formatWaitAge(12 * MIN + 59_000), '12m');
    assert.equal(formatWaitAge(125 * MIN), '2h5m');
    assert.equal(formatWaitAge(120 * MIN), '2h');
    assert.equal(formatWaitAge(27 * 60 * MIN), '1d3h');
});

function commandPlaque(sprites) {
    const building = Object.create(BuildingSprite.prototype);
    building.agentSprites = sprites;
    building._plaqueCountsByType();
    const measure = attention => building._measurePlaque(ctx, { type: 'command' }, { motif: true }, {
        count: 0, zoom: 1, isHovered: false, isLandmark: true, scaleMode: 'screen-fixed', attention,
    });
    return { attention: building.plaqueAttention, measure };
}

test('the Command plaque attention cell is absent at zero and carries the exact actionable count', () => {
    const quiet = commandPlaque([sprite('w', AgentStatus.WORKING, 0), sprite('i', AgentStatus.IDLE, 0)]);
    assert.equal(quiet.attention, null);
    const bare = quiet.measure(null);
    assert.deepEqual(quiet.measure(quiet.attention), bare);
    assert.equal('attention' in bare, false);

    const busy = commandPlaque([
        sprite('e1', AgentStatus.ERRORED, 0),
        sprite('q1', AgentStatus.RATE_LIMITED, 0),
        sprite('n1', AgentStatus.WAITING_ON_USER, 0, null, { visitRole: 'queue' }),
        sprite('n2', AgentStatus.WAITING_ON_USER, 0),
        sprite('gone', AgentStatus.WAITING_ON_USER, 0, null, { agent: { id: 'gone', status: AgentStatus.WAITING_ON_USER, isDeparted: true } }),
        sprite('arriving', AgentStatus.ERRORED, 0, null, { isArrivalPending: () => true }),
        sprite('w', AgentStatus.WORKING, 0),
    ]);
    assert.equal(busy.attention.count, 4);
    // The lead bucket follows SignalLedger precedence: needs-you first.
    assert.equal(busy.attention.bucket, 'needsYou');
    assert.equal(busy.attention.motif, 'needs-you');
    const plaque = busy.measure(busy.attention);
    assert.equal(plaque.attentionText, '4');
    assert.equal(plaque.width - bare.width, plaque.attentionCell);
    assert.equal(plaque.height, bare.height);

    const errorsOnly = commandPlaque([sprite('e1', AgentStatus.ERRORED, 0), sprite('q1', AgentStatus.RATE_LIMITED, 0)]);
    assert.equal(errorsOnly.attention.bucket, 'errors');
    assert.equal(errorsOnly.attention.count, 2);
});

test('off-frame tally text counts each silent status truthfully', () => {
    assert.equal(offFrameTallyText([AgentStatus.WORKING, AgentStatus.IDLE, AgentStatus.WORKING]), '2 working · 1 idle');
    assert.equal(offFrameTallyText([AgentStatus.COMPLETED, AgentStatus.WAITING]), '1 waiting · 1 done');
    assert.equal(offFrameTallyText(['active', 'bogus']), '1 working · 1 idle');
});

test('one tally tab per side for silent agents wholly beyond the frame; T1 keeps its slot', () => {
    const now = 10_000_000;
    const offLeft = (id, status, y = 0) => ({ ...sprite(id, status, -300), y });
    const layout = layoutAttentionPlates(ctx, {
        sprites: [
            offLeft('a', AgentStatus.WORKING),
            offLeft('b', AgentStatus.WORKING),
            offLeft('c', AgentStatus.IDLE),
            // Action-needed agents beyond the frame get T1 edge plates, never a tally.
            offLeft('n', AgentStatus.WAITING_ON_USER),
            // In view, or arriving: not tallied.
            sprite('here', AgentStatus.WORKING, 800),
            { ...sprite('gate', AgentStatus.WORKING, -300), isArrivalPending: () => true },
            { ...sprite('far-right', AgentStatus.WAITING, 2400) },
        ],
        camera, viewport, now,
    });
    const tabs = Object.fromEntries(layout.tallies.map(tab => [tab.side, tab]));
    assert.deepEqual(Object.keys(tabs).sort(), ['left', 'right']);
    assert.equal(tabs.left.text, '2 working · 1 idle');
    assert.equal(tabs.left.members, 3);
    assert.equal(tabs.right.text, '1 waiting');
    const edge = layout.plates.find(plate => plate.side === 'left');
    assert.ok(edge, 'the waiting agent keeps its T1 edge plate');
    for (const tab of layout.tallies) {
        for (const plate of layout.plates) {
            const r = plate.rect;
            const overlap = tab.rect.left < r.right && tab.rect.right > r.left && tab.rect.top < r.bottom && tab.rect.bottom > r.top;
            assert.equal(overlap, false, `${tab.side} tab clears the ${plate.word} plate`);
        }
        assert.ok(tab.rect.left >= 0 && tab.rect.right <= viewport.width && tab.rect.top >= 0 && tab.rect.bottom <= viewport.height);
    }

    const none = layoutAttentionPlates(ctx, { sprites: [sprite('here', AgentStatus.WORKING, 800)], camera, viewport, now });
    assert.deepEqual(none.tallies, []);
});
