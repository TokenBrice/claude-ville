import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ISLAND_MAP,
    place,
    resolveCueSpot,
} from '../../claudeville/src/presentation/shared/audio/SpatialField.js';

const VIEWPORT = { viewportW: 1600, viewportH: 900 };

test('a centred sound is centred, full level, unfiltered and nearly dry', () => {
    const centre = place({ screenX: 800, screenY: 450, ...VIEWPORT });
    assert.equal(centre.pan, 0);
    assert.equal(centre.gain, 1);
    assert.equal(centre.lowpassHz, null);
    assert.equal(centre.air, 0.12);

    // The forge sits at the island's middle on the Dashboard map.
    const forge = place({ building: 'forge' });
    assert.ok(Math.abs(forge.pan) < 0.05);
    assert.equal(forge.gain, 1);
    assert.equal(forge.lowpassHz, null);
});

test('off-screen right is panned no further than 0.75, dull, faint and wetter', () => {
    const far = place({ screenX: 1600 * 2.5, screenY: 450, ...VIEWPORT });
    assert.equal(far.pan, 0.75);
    assert.ok(far.lowpassHz < 3000);
    assert.ok(far.lowpassHz >= 900);
    assert.ok(far.gain >= 0.12 && far.gain < 0.5);
    assert.ok(far.air > place({ screenX: 1200, screenY: 450, ...VIEWPORT }).air);
    assert.ok(far.air <= 0.42);
});

test('distance falls off monotonically, and a vertical offset reads farther than a horizontal one', () => {
    let previous = place({ screenX: 0.5 });
    for (let x = 0.55; x <= 4; x += 0.05) {
        const next = place({ screenX: x });
        assert.ok(next.gain <= previous.gain);
        assert.ok((next.lowpassHz ?? Infinity) <= (previous.lowpassHz ?? Infinity));
        assert.ok(next.air >= previous.air);
        previous = next;
    }
    const across = place({ screenX: 0.9, screenY: 0.5 });
    const down = place({ screenX: 0.5, screenY: 0.9 });
    assert.ok(down.distance > across.distance);
    assert.ok(down.gain < across.gain);
});

test('signal cues are never filtered or distance-attenuated, and stay close to the centre', () => {
    for (const target of [
        { screenX: 0.5 },
        { screenX: -3, screenY: 4 },
        { screenX: 1600 * 3, screenY: -900, ...VIEWPORT },
        { building: 'portal' },
        null,
    ]) {
        const signal = place(target, { kind: 'signal' });
        assert.equal(signal.lowpassHz, null);
        assert.equal(signal.gain, 1);
        assert.ok(Math.abs(signal.pan) <= 0.3);
        assert.ok(signal.air <= 0.12);
    }
});

test('the Dashboard island map keeps every building on its side within ±0.75', () => {
    const pans = Object.values(ISLAND_MAP);
    assert.ok(pans.length >= 9);
    assert.ok(pans.every(pan => Math.abs(pan) <= 0.75));
    assert.ok(ISLAND_MAP.portal < ISLAND_MAP.archive && ISLAND_MAP.archive < 0);
    assert.ok(ISLAND_MAP.harbor > 0 && ISLAND_MAP.watchtower > ISLAND_MAP.harbor);
    // The legacy name for the watchtower lands on the same place.
    assert.equal(place({ building: 'lighthouse' }).pan, ISLAND_MAP.watchtower);
    // A screen point in Dashboard has no camera behind it: it sounds from the centre.
    assert.equal(place({ screenX: 0 }, { dashboard: true }).pan, 0);
});

test('a live sprite off the screen keeps its distance', () => {
    const renderer = {
        agentSprites: new Map([['ada', { x: 5000, y: 300 }]]),
        camera: {
            worldToScreen: (x, y) => ({ x, y }),
            _viewportWidth: () => 1600,
            _viewportHeight: () => 900,
        },
    };
    const spot = resolveCueSpot({}, { agentId: 'ada', dashboard: false, renderer });
    assert.deepEqual(spot, { screenX: 5000, screenY: 300, ...VIEWPORT });
    const placed = place(spot);
    assert.equal(placed.pan, 0.75);
    assert.ok(placed.lowpassHz < 3000);

    const dash = resolveCueSpot({ agent: { id: 'ada', lastKnownBuildingType: 'mine' } }, {
        agentId: 'ada',
        dashboard: true,
        renderer,
    });
    assert.deepEqual(dash, { building: 'mine' });
});
