import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import {
    COAST_ANCHORAGE_SLOTS,
    COMMIT_LAGOON_SQUAD_ANCHORAGES,
    BERTHS,
    HARBOR_LANE_NODES,
    HARBOR_PIER_DECKS,
    HARBOR_SEA_EXITS,
    HARBOR_SLOT_FILL_ORDER,
    HARBOR_WATER_MASK,
    buildDockLayoutFresh,
    composeWaterPath,
    composeWaterRouteTiles,
    harborHullClearance,
    harborWaterField,
    hullClearsPiers,
    hullScreenBox,
    routeSeaTile,
} from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { reduceHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborState.js';

// Phase 3.2 / 3.3 lint: the water field, the lane graph and every route and
// mooring the harbor can produce stay on navigable water (P-D4, P-D5).

const field = harborWaterField();
const onMap = (p) => p.tileX >= 0 && p.tileY >= 0 && p.tileX < MAP_SIZE && p.tileY < MAP_SIZE;

function sample(route, step = 0.1) {
    const out = [];
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1];
        const b = route[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY) / step));
        for (let k = 0; k <= n; k++) out.push({ tileX: a.tileX + (b.tileX - a.tileX) * k / n, tileY: a.tileY + (b.tileY - a.tileY) * k / n });
    }
    return out;
}

// Every point of a route at least `clear` from land, past `ends` tiles from
// either end (a mooring may sit tighter than a lane).
function assertOnWater(route, label, clear = 0.3, ends = 0.6) {
    const points = sample(route);
    let along = 0;
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].tileX - points[i - 1].tileX, points[i].tileY - points[i - 1].tileY);
    for (let i = 0; i < points.length; i++) {
        if (i) along += Math.hypot(points[i].tileX - points[i - 1].tileX, points[i].tileY - points[i - 1].tileY);
        const c = field.clearance(points[i].tileX, points[i].tileY);
        assert.ok(c > 0.05, `${label}: point (${points[i].tileX.toFixed(2)}, ${points[i].tileY.toFixed(2)}) is on land`);
        if (along > ends && total - along > ends) {
            assert.ok(c >= clear, `${label}: point (${points[i].tileX.toFixed(2)}, ${points[i].tileY.toFixed(2)}) only ${c.toFixed(2)} from land`);
        }
    }
}

const SLOT_STARTS = COAST_ANCHORAGE_SLOTS.map(slot => ({ name: slot.name, tileX: slot.tileX + (slot.leadDx || 0), tileY: slot.tileY + (slot.leadDy || 0), zone: slot.zone || 'coast' }));

test('the baked water mask is the map, and buildings, piers and the islet are land', () => {
    assert.equal(HARBOR_WATER_MASK.length, MAP_SIZE);
    for (const row of HARBOR_WATER_MASK) assert.equal(row.length, MAP_SIZE);
    for (const building of BUILDING_DEFS) {
        const cx = building.x + building.width / 2;
        const cy = building.y + building.height / 2;
        assert.equal(field.clearance(cx, cy), 0, `${building.type} footprint reads as water`);
    }
    for (const deck of HARBOR_PIER_DECKS) {
        assert.equal(field.clearance((deck.x0 + deck.x1) / 2, (deck.y0 + deck.y1) / 2), 0, `${deck.name} pier deck reads as water`);
    }
    assert.equal(field.clearance(20.2, 6.6), 0, 'the world ash islet reads as water');
    assert.ok(field.clearance(45, -8) >= 2, 'off the map is open sea');
});

test('every lane node is on open water and every node reaches every horizon exit', () => {
    const { nodes, edges, byId } = field.lanes;
    assert.equal(nodes.length, HARBOR_LANE_NODES.length, 'a lane node fell on land');
    for (const node of nodes) assert.ok(field.clearance(node.tileX, node.tileY) >= 0.45, `${node.id} clearance ${field.clearance(node.tileX, node.tileY).toFixed(2)}`);
    for (const exit of HARBOR_SEA_EXITS) {
        const seen = new Set([byId.get(exit)]);
        const queue = [byId.get(exit)];
        while (queue.length) for (const { to } of edges[queue.shift()]) if (!seen.has(to)) { seen.add(to); queue.push(to); }
        for (const node of nodes) assert.ok(seen.has(byId.get(node.id)), `${node.id} cannot reach ${exit}`);
    }
});

test('every departure route stays on water and ends past the north-east horizon', () => {
    const starts = [
        ...SLOT_STARTS,
        ...COMMIT_LAGOON_SQUAD_ANCHORAGES.map(a => ({ ...a, zone: 'commit-lagoon' })),
        ...BERTHS.map((b, i) => ({ ...b, name: `berth ${i}`, zone: 'harbor' })),
    ];
    for (const start of starts) {
        const from = field.nearestClear(start, 0.6);
        for (let routeIndex = 0; routeIndex < 3; routeIndex++) {
            const route = composeWaterRouteTiles(from, { departWaterZone: start.zone, departRouteIndex: routeIndex });
            assertOnWater(route, `${start.name} route ${routeIndex}`, 0.35);
            const end = route[route.length - 1];
            assert.ok(end.tileY < 0, `${start.name} route ${routeIndex} ends on the map at (${end.tileX}, ${end.tileY})`);
            assert.ok(onMap(routeSeaTile(route)), 'the finale anchors on the map');
        }
    }
});

test('lagoon and coast transfers, arrivals and returns stay on water', () => {
    const moorings = [...SLOT_STARTS, ...COMMIT_LAGOON_SQUAD_ANCHORAGES].map(tile => field.nearestClear(tile, 0.6));
    for (const a of moorings) {
        for (const b of moorings) {
            if (a === b) continue;
            assertOnWater(composeWaterPath(a, b), `(${a.tileX.toFixed(1)},${a.tileY.toFixed(1)}) → (${b.tileX.toFixed(1)},${b.tileY.toFixed(1)})`, 0.35);
        }
    }
});

// Fleets of 1–20 commits on 1–3 branches in every anchorage, with failed and
// rejected squads beside them: every hull moors on water with its clearance.
test('every fleet formation moors on water, clear of land, piers and each other', () => {
    const T = Date.parse('2026-10-15T10:00:00Z');
    for (let fleets = 1; fleets <= HARBOR_SLOT_FILL_ORDER.length + 2; fleets += 3) {
        for (const size of [1, 3, 4, 9, 20]) {
            const events = [];
            for (let r = 0; r < fleets; r++) {
                const project = `/w/fleet-${r}`;
                for (let c = 0; c < size; c++) {
                    const branch = ['main', 'feat/a', 'feat/b'][c % 3];
                    events.push({ id: `c-${r}-${c}`, type: 'commit', project, branch, targetRef: branch, sha: `${r}`.padStart(8, '0') + `${c}`.padStart(32, '0'), label: `c ${r} ${c}`, timestamp: T + (r * 50 + c) * 1000, success: true, status: 'success' });
                }
                if (r % 3 === 1) events.push({ id: `p-${r}`, type: 'push', project, branch: 'feat/a', targetRef: 'feat/a', timestamp: T + (r * 50 + size) * 1000 + 500, success: false, stderr: 'fatal: unable to access' });
            }
            const state = reduceHarborTrafficState(null, events, { now: T + 3_600_000, motionScale: 0 });
            const layout = buildDockLayoutFresh(state);
            const leads = [...layout.byShipId.values()].filter(meta => meta.visualLeadId === meta.id);
            for (const meta of leads) {
                const c = field.clearance(meta.tileX, meta.tileY);
                assert.ok(c >= 0.5, `${fleets} fleets × ${size}: ${meta.id} at ${meta.anchorageName} (${meta.tileX.toFixed(2)}, ${meta.tileY.toFixed(2)}) is ${c.toFixed(2)} from land`);
                assert.ok(c >= Math.min(meta.clearance, harborHullClearance({})) - 1e-6);
            }
            for (let i = 0; i < leads.length; i++) {
                for (let j = i + 1; j < leads.length; j++) {
                    const d = Math.hypot(leads[i].x - leads[j].x, leads[i].y - leads[j].y);
                    assert.ok(d >= 20, `${fleets} fleets × ${size}: ${leads[i].id} and ${leads[j].id} moor ${d.toFixed(1)} px apart`);
                }
            }
        }
    }
});

test('the pier berths fill first, and their fleets moor in the pier channels', () => {
    const T = Date.parse('2026-10-15T10:00:00Z');
    const events = [0, 1, 2, 3].flatMap(r => [0, 1, 2].map(c => ({ id: `c-${r}-${c}`, type: 'commit', project: `/w/pier-${r}`, branch: 'main', targetRef: 'main', sha: `${r}${c}`.padStart(40, '0'), label: `c ${r}${c}`, timestamp: T + (r * 10 + c) * 1000, success: true, status: 'success' })));
    const state = reduceHarborTrafficState(null, events, { now: T + 60_000, motionScale: 0 });
    const layout = buildDockLayoutFresh(state);
    for (const meta of layout.byShipId.values()) {
        assert.match(meta.anchorageName, /Pier Berth$/);
        assert.equal(meta.moorHeading, 'nw');
        // In line on its berth's channel (past the pier heads when the
        // channel is full or too narrow for the hull), body clear of every
        // pier on screen.
        const slot = COAST_ANCHORAGE_SLOTS.find(item => item.name === meta.anchorageName);
        assert.ok(meta.tileX > 32.5, `${meta.id} at x ${meta.tileX.toFixed(2)}`);
        assert.ok(Math.abs(meta.tileY - slot.tileY) < 0.3, `${meta.id} off its channel line at y ${meta.tileY.toFixed(2)}`);
        assert.ok(hullClearsPiers(meta, meta), `${meta.id} overlaps a pier on screen`);
        for (const deck of HARBOR_PIER_DECKS) {
            const inside = meta.tileX >= deck.x0 && meta.tileX <= deck.x1 && meta.tileY >= deck.y0 - 0.3 && meta.tileY <= deck.y1 + 0.3;
            assert.ok(!inside, `${meta.id} moors on the ${deck.name} pier`);
        }
    }
});

test('every anchorage buoy floats in open water', () => {
    for (const slot of COAST_ANCHORAGE_SLOTS) {
        const c = field.clearance(slot.tileX, slot.tileY);
        assert.ok(c >= 0.5, `${slot.name} buoy at (${slot.tileX}, ${slot.tileY}) is ${c.toFixed(2)} from land`);
    }
});

test('a big fleet at a pier berth moors in line past the pier heads, bow in', () => {
    const T = Date.parse('2026-10-15T10:00:00Z');
    const events = Array.from({ length: 14 }, (_, c) => ({ id: `big-${c}`, type: 'commit', project: '/w/big', branch: 'main', targetRef: 'main', sha: `${c + 1}`.padStart(40, '0'), label: `c ${c}`, timestamp: T + c * 1000, success: true, status: 'success' }));
    events.push(...[0, 1].map(c => ({ id: `small-${c}`, type: 'commit', project: '/w/small', branch: 'main', targetRef: 'main', sha: `${c + 50}`.padStart(40, '0'), label: `s ${c}`, timestamp: T + 30_000 + c * 1000, success: true, status: 'success' })));
    const state = reduceHarborTrafficState(null, events, { now: T + 60_000, motionScale: 0 });
    const leads = [...buildDockLayoutFresh(state).byShipId.values()].filter(meta => meta.visualLeadId === meta.id);
    const big = leads.find(meta => meta.project === '/w/big' || meta.id.startsWith('big-'));
    const slot = COAST_ANCHORAGE_SLOTS.find(item => item.name === big.anchorageName);
    assert.ok(slot.pier, 'the busiest repo holds a pier berth');
    assert.equal(big.moorHeading, 'nw');
    assert.ok(Math.abs(big.tileY - slot.tileY) < 0.3, 'on its channel line');
    assert.ok(hullClearsPiers(big, big), 'its body clears the piers');
});

// Acceptance (Phase 4's 103-ship / 9-repo load): at z1 (world px) no moored
// hull body overlaps a pier deck, the quay or a waterside wall, and no two
// hull bodies overlap anywhere; pier fleets keep to their channel line.
test('under load no hull body overlaps a pier, a wall or another hull on screen', () => {
    const T = Date.parse('2026-10-15T10:00:00Z');
    const events = [];
    const repos = 9;
    let seq = 0;
    for (let r = 0; r < repos; r++) {
        const project = `/w/load-${r}`;
        const branches = 1 + (r % 3);
        for (let b = 0; b < branches; b++) {
            const branch = b === 0 ? 'main' : `feat/${r}-${b}`;
            const count = [2, 4, 9, 18, 3, 6, 15, 1, 11][(r + b) % 9];
            for (let c = 0; c < count; c++) {
                seq += 1;
                events.push({ id: `l-${r}-${b}-${c}`, type: 'commit', project, branch, targetRef: branch, sha: seq.toString(16).padStart(40, '0'), label: `l ${seq}`, timestamp: T + seq * 1000, success: true, status: 'success' });
            }
            if ((r + b) % 4 === 1) events.push({ id: `lp-${r}-${b}`, type: 'push', project, branch, targetRef: branch, timestamp: T + seq * 1000 + 500, success: false, stderr: 'fatal: unable to access' });
        }
    }
    const state = reduceHarborTrafficState(null, events, { now: T + 3_600_000, motionScale: 0 });
    const leads = [...buildDockLayoutFresh(state).byShipId.values()].filter(meta => meta.visualLeadId === meta.id);
    assert.ok(leads.length >= 25, `only ${leads.length} hulls drawn`);
    for (const meta of leads) {
        assert.ok(hullClearsPiers(meta, meta), `${meta.id} (${meta.anchorageName}) overlaps a pier, the quay or a wall at (${meta.tileX.toFixed(2)}, ${meta.tileY.toFixed(2)})`);
        const slot = COAST_ANCHORAGE_SLOTS.find(item => item.name === meta.anchorageName);
        if (slot?.pier) assert.ok(Math.abs(meta.tileY - slot.tileY) < 0.3, `${meta.id} strays off the ${slot.name} line at (${meta.tileX.toFixed(2)}, ${meta.tileY.toFixed(2)})`);
    }
    for (let i = 0; i < leads.length; i++) {
        const a = hullScreenBox(leads[i], leads[i]);
        for (let j = i + 1; j < leads.length; j++) {
            const b = hullScreenBox(leads[j], leads[j]);
            const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
            assert.ok(!overlap, `${leads[i].id} (${leads[i].anchorageName}) and ${leads[j].id} (${leads[j].anchorageName}) overlap on screen`);
        }
    }
});
