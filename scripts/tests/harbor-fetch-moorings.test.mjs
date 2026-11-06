import test from 'node:test';
import assert from 'node:assert/strict';

import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import {
    HARBOR_MOORING_CLEARANCE,
    HARBOR_ROADSTEAD_PROP_CLEARANCE,
    HARBOR_ROADSTEAD_PROP_OBSTACLES,
    harborWaterField,
    hullScreenBox,
} from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

// HN-1 (lane 03 harness h2b): concurrent landed fetches fill the
// outer-roadstead anchorages in turn, a row further out each lap, so two
// fetch hulls never anchor on one tile or overlap on screen.

const T = Date.parse('2026-11-05T10:00:00Z');
const S = 1000;
const REPO = '/w/fetch-roadstead';
const agent = (events) => ({ id: 'a', sessionId: 'a', projectPath: REPO, repoRoot: REPO, gitEvents: events });
const fetch = (n, at) => ({
    id: `fetch-${n}`, type: 'fetch', project: `/w/repo-${n}`, repoRoot: `/w/repo-${n}`,
    branch: 'main', targetRef: 'main', ts: at, completedAt: at + S,
    status: 'success', success: true, exitCode: 0,
});
const moorings = (harbor) => [...harbor.state.ships.values()]
    .filter(ship => ship.arrivingKind === 'fetch')
    .map(ship => ship.inboundRoadsteadTile);
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

test('HN-1: concurrent fetches take distinct roadstead moorings, never one tile', () => {
    for (const count of [5, 12]) {
        const harbor = new HarborTraffic({});
        const events = Array.from({ length: count }, (_, n) => fetch(n, T + n * S));
        harbor.reconcile([agent(events)], T + count * S + 500);
        const tiles = moorings(harbor);
        assert.equal(tiles.length, count, `count ${count}`);
        assert.equal(new Set(tiles.map(tile => `${tile.tileX},${tile.tileY}`)).size, count,
            `count ${count}: two fetches share a mooring`);
        for (let i = 0; i < tiles.length; i++) {
            for (let j = i + 1; j < tiles.length; j++) {
                const a = hullScreenBox(tileToWorld(tiles[i].tileX, tiles[i].tileY));
                const b = hullScreenBox(tileToWorld(tiles[j].tileX, tiles[j].tileY));
                assert.ok(!overlap(a, b), `count ${count}: hulls ${i} and ${j} overlap on screen`);
            }
        }
        harbor.dispose();
    }
});

test('HN-1: a fetch and a moored PR cutter share the lattice, not a buoy', () => {
    const harbor = new HarborTraffic({});
    const pr = {
        id: 'git-pr-create', type: 'pr', action: 'create', project: '/w/repo-pr', repoRoot: '/w/repo-pr',
        branch: 'main', targetRef: 'main', ts: T, url: 'https://github.com/o/r/pull/12', status: 'success',
    };
    harbor.reconcile([{ id: 'pr-agent', sessionId: 'pr-agent', projectPath: '/w/repo-pr', repoRoot: '/w/repo-pr', gitEvents: [pr] }], T + S);
    const cutter = [...harbor.state.ships.values()].find(ship => ship.arrivingKind === 'pr');
    const cutterTile = cutter.inboundRoadsteadTile;
    assert.ok(cutterTile, 'the PR cutter moors at the roadstead');

    harbor.reconcile([agent([fetch(0, T + 2 * S)])], T + 3 * S);
    const fetchTile = moorings(harbor)[0];
    assert.notDeepEqual(fetchTile, cutterTile, 'the fetch takes the next free mooring, not the cutter\'s');
    harbor.dispose();
});

test('HN-1: a fetch mooring freed by an expired hull is reused', () => {
    const harbor = new HarborTraffic({});
    const events = Array.from({ length: 4 }, (_, n) => fetch(n, T + n * S));
    harbor.reconcile([agent(events)], T + 5 * S);
    const before = moorings(harbor);
    assert.equal(before.length, 4);
    // The 72 s lifecycles lapse (a tick to anchor, a tick to retire); a
    // later fetch takes the first freed slot.
    harbor.reconcile([], T + 90 * S);
    harbor.reconcile([], T + 92 * S);
    assert.equal(moorings(harbor).length, 0, 'the fetches expired');
    harbor.reconcile([agent([fetch(9, T + 92 * S)])], T + 93 * S);
    const after = moorings(harbor);
    assert.equal(after.length, 1);
    assert.deepEqual(after[0], before[0], 'the new fetch reuses the first freed mooring');
    harbor.dispose();
});

test('review: the shared lattice extends outward at saturation, never wraps onto a buoy', () => {
    // The designed lattice is 4 anchorages × 3 rows; past it the allocator
    // hands out further rows outward, on open water, instead of lapping
    // round onto a moored hull's tile.
    const harbor = new HarborTraffic({});
    const prs = Array.from({ length: 7 }, (_, n) => ({
        id: `pr-create-${n}`, type: 'pr', action: 'create', project: `/w/repo-pr-${n}`, repoRoot: `/w/repo-pr-${n}`,
        branch: 'main', targetRef: 'main', ts: T + (n + 6) * S, completedAt: T + (n + 7) * S,
        status: 'success', success: true, exitCode: 0, url: `https://github.com/o/r/pull/${n + 20}`,
    }));
    harbor.reconcile([agent([...Array.from({ length: 6 }, (_, n) => fetch(n, T + n * S)), ...prs])], T + 14 * S);
    const tiles = [...harbor.state.ships.values()]
        .filter(ship => ship.arrivingKind === 'fetch' || (ship.prShip && ship.arrivingKind === 'pr'))
        .map(ship => ship.inboundRoadsteadTile);
    assert.equal(tiles.length, 13);
    assert.equal(new Set(tiles.map(tile => `${tile.tileX},${tile.tileY}`)).size, 13,
        'two hulls share a mooring');
    const field = harborWaterField();
    for (let i = 0; i < tiles.length; i++) {
        assert.ok(field.clearance(tiles[i].tileX, tiles[i].tileY) >= HARBOR_MOORING_CLEARANCE,
            `mooring ${i} is not on open water`);
        for (let j = i + 1; j < tiles.length; j++) {
            const a = hullScreenBox(tileToWorld(tiles[i].tileX, tiles[i].tileY));
            const b = hullScreenBox(tileToWorld(tiles[j].tileX, tiles[j].tileY));
            assert.ok(!overlap(a, b), `hulls ${i} and ${j} overlap on screen`);
        }
    }
    harbor.dispose();
});

test('review: overflow moorings past the beacon rock keep hull-dimension clearance', () => {
    // The outward rows reach the offshore beacon rock around 70 hulls; every
    // mooring stays distinct, on open water, a hull footprint off the solid
    // props, so no drawn hull ever lies over one.
    const harbor = new HarborTraffic({});
    const prs = Array.from({ length: 80 }, (_, n) => ({
        id: `pr-saturate-${n}`, type: 'pr', action: 'create', project: `/w/repo-saturate-${n}`,
        repoRoot: `/w/repo-saturate-${n}`, branch: 'main', targetRef: 'main',
        ts: T + n * S, completedAt: T + (n + 1) * S, status: 'success', success: true, exitCode: 0,
        url: `https://github.com/o/r/pull/${n + 40}`,
    }));
    harbor.reconcile([agent(prs)], T + 82 * S);
    const tiles = [...harbor.state.ships.values()]
        .filter(ship => ship.prShip && ship.arrivingKind === 'pr')
        .map(ship => ship.inboundRoadsteadTile);
    assert.equal(tiles.length, 80);
    assert.equal(new Set(tiles.map(tile => `${tile.tileX},${tile.tileY}`)).size, 80,
        'two hulls share a mooring');
    const field = harborWaterField();
    for (let i = 0; i < tiles.length; i++) {
        assert.ok(field.clearance(tiles[i].tileX, tiles[i].tileY) >= HARBOR_MOORING_CLEARANCE,
            `mooring ${i} is not on open water`);
        for (const prop of HARBOR_ROADSTEAD_PROP_OBSTACLES) {
            const dx = Math.max(prop.x0 - tiles[i].tileX, 0, tiles[i].tileX - prop.x1);
            const dy = Math.max(prop.y0 - tiles[i].tileY, 0, tiles[i].tileY - prop.y1);
            assert.ok(Math.hypot(dx, dy) >= HARBOR_ROADSTEAD_PROP_CLEARANCE,
                `mooring ${i} sits on the solid prop ${prop.id}`);
        }
        for (let j = i + 1; j < tiles.length; j++) {
            const a = hullScreenBox(tileToWorld(tiles[i].tileX, tiles[i].tileY));
            const b = hullScreenBox(tileToWorld(tiles[j].tileX, tiles[j].tileY));
            assert.ok(!overlap(a, b), `hulls ${i} and ${j} overlap on screen`);
        }
    }
    harbor.dispose();
});
