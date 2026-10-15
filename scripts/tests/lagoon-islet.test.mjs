import test from 'node:test';
import assert from 'node:assert/strict';

import { WORLD_TREE } from '../../claudeville/src/config/scenery.js';
import {
    COMMIT_LAGOON_SQUAD_ANCHORAGES,
    clearOfWorldTreeIslet,
    composeWaterRouteTiles,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

// The world ash's islet stands in the Commit Lagoon's mouth: no lagoon ship
// may moor on it or sail across it.

const { centerX, centerY, radiusX, radiusY } = WORLD_TREE.islet;
// Normalised reach from the islet's centre (1 = its shore).
const reach = ({ tileX, tileY }) => {
    const world = tileToWorld(tileX, tileY);
    return Math.hypot((world.x - centerX) / radiusX, (world.y - centerY) / radiusY);
};

function sampled(route) {
    const out = [];
    for (let index = 0; index + 1 < route.length; index++) {
        const a = route[index];
        const b = route[index + 1];
        for (let t = 0; t <= 1; t += 0.05) out.push({ tileX: a.tileX + (b.tileX - a.tileX) * t, tileY: a.tileY + (b.tileY - a.tileY) * t });
    }
    return out;
}

test('every lagoon anchorage lies clear of the islet', () => {
    for (const anchorage of COMMIT_LAGOON_SQUAD_ANCHORAGES) {
        assert.ok(reach(anchorage) > 1.2, `${anchorage.name} reach ${reach(anchorage).toFixed(2)}`);
    }
});

test('a tile on the islet is pushed off it; one in open water is untouched', () => {
    const onIslet = { tileX: 20.2, tileY: 6.8 };
    assert.ok(reach(onIslet) < 1);
    assert.ok(reach(clearOfWorldTreeIslet(onIslet)) > 1.1);
    const open = { tileX: 8, tileY: 8.5 };
    assert.deepEqual(clearOfWorldTreeIslet(open), open);
});

test('no lagoon departure crosses the islet, from any anchorage, on any route band', () => {
    for (const anchorage of COMMIT_LAGOON_SQUAD_ANCHORAGES) {
        for (let routeIndex = 0; routeIndex < 3; routeIndex++) {
            for (const squad of [[0, 1], [0, 3], [2, 3]]) {
                const ship = { departWaterZone: 'commit-lagoon', departRouteIndex: routeIndex, departSquadIndex: squad[0], departSquadCount: squad[1] };
                const route = composeWaterRouteTiles({ tileX: anchorage.tileX, tileY: anchorage.tileY }, ship);
                const nearest = Math.min(...sampled(route).map(reach));
                assert.ok(nearest > 1.05, `${anchorage.name} route ${routeIndex}: comes within ${nearest.toFixed(2)} of the islet`);
            }
        }
    }
});

// Phase 3.3 — lagoon routes leave by the lane graph: none may cross the
// (14,7) spit or any other land tile of the water mask, from any lagoon
// mooring, on any route, and every inbound passage stays in the water too.
test('no lagoon route crosses land: every sample lies on a water tile', async () => {
    const { HARBOR_WATER_MASK, COAST_ANCHORAGE_SLOTS, composeWaterPath, harborWaterField } = await import('../../claudeville/src/presentation/character-mode/HarborLayout.js');
    const water = ({ tileX, tileY }) => tileX < 0 || tileY < 0 || tileX >= 40 || tileY >= 40
        || HARBOR_WATER_MASK[Math.floor(tileY)][Math.floor(tileX)] === '~';
    const field = harborWaterField();
    const moorings = [
        ...COMMIT_LAGOON_SQUAD_ANCHORAGES,
        ...COAST_ANCHORAGE_SLOTS.filter(slot => slot.zone === 'commit-lagoon').map(slot => ({ ...slot, tileY: slot.tileY + (slot.leadDy || 0) })),
    ];
    for (const anchorage of moorings) {
        const start = field.nearestClear(anchorage, 0.6);
        for (let routeIndex = 0; routeIndex < 3; routeIndex++) {
            const route = composeWaterRouteTiles(start, { departWaterZone: 'commit-lagoon', departRouteIndex: routeIndex });
            for (const point of sampled(route)) assert.ok(water(point), `${anchorage.name} route ${routeIndex} crosses land at (${point.tileX.toFixed(2)}, ${point.tileY.toFixed(2)})`);
            const inbound = composeWaterPath({ tileX: 36.6, tileY: 17.6 }, start);
            for (const point of sampled(inbound)) assert.ok(water(point), `inbound to ${anchorage.name} crosses land at (${point.tileX.toFixed(2)}, ${point.tileY.toFixed(2)})`);
        }
    }
});
