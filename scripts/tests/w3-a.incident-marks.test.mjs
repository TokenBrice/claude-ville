import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { layoutAttentionPlates } from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';

// T1 (plan 5.1): action-needed agents stay unmissable. Layout is pure given a
// measuring context and a camera, so it runs in plain Node.
const ctx = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
const camera = { worldToScreen: (x, y) => ({ x, y: y + 300 }) };
const viewport = { width: 1600, height: 900 };

function sprite(id, status, x, since = null) {
    return { x, y: 0, agent: { id, name: id, status, statusSince: since } };
}

test('every action-needed agent gets a beacon and a plate; quiet agents get neither', () => {
    const now = 100_000;
    const layout = layoutAttentionPlates(ctx, {
        sprites: [
            sprite('w', AgentStatus.WAITING_ON_USER, 100, now - 13_000),
            sprite('e', AgentStatus.ERRORED, 600),
            sprite('q', AgentStatus.RATE_LIMITED, 1100, now - 5_000),
            sprite('k', AgentStatus.WORKING, 1400),
            sprite('i', AgentStatus.IDLE, 1500),
        ],
        camera, viewport, now,
    });
    assert.equal(layout.count, 3);
    assert.equal(layout.beacons.length, 3);
    const byName = Object.fromEntries(layout.plates.map(plate => [plate.text, plate]));
    assert.equal(byName.w.word, 'NEEDS YOU');
    assert.equal(byName.w.age, '13s');
    assert.equal(byName.e.word, 'ERROR');
    assert.equal(byName.q.word, 'LIMIT');
    // Rate limit shows its age.
    assert.equal(byName.q.age, '5s');
});

test('three or more colliding plates collapse to one exact group plate; each body keeps its beacon', () => {
    const now = 100_000;
    const sprites = Array.from({ length: 9 }, (_, index) =>
        sprite(`Wait ${index + 1}`, AgentStatus.WAITING_ON_USER, 400 + index * 6, now - (20_000 - index * 1000)));
    const layout = layoutAttentionPlates(ctx, { sprites, camera, viewport, now });
    assert.equal(layout.beacons.length, 9);
    assert.equal(layout.plates.length, 1);
    assert.equal(layout.plates[0].members, 9);
    assert.equal(layout.plates[0].text, '9 · oldest Wait 1');
    assert.equal(layout.plates[0].age, '20s');
});

test('stacked plates never overlap, and an arriving agent has no plate yet', () => {
    const sprites = [
        sprite('a', AgentStatus.ERRORED, 400),
        sprite('b', AgentStatus.ERRORED, 430),
        { ...sprite('c', AgentStatus.ERRORED, 900), isArrivalPending: () => true },
    ];
    const layout = layoutAttentionPlates(ctx, { sprites, camera, viewport });
    assert.equal(layout.plates.length, 2);
    const [a, b] = layout.plates.map(plate => plate.rect);
    const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    assert.equal(overlap, false);
});
