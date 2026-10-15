import test from 'node:test';
import assert from 'node:assert/strict';

import { HARBOR_ANCHORAGE_VERSION, COAST_ANCHORAGE_SLOTS, HARBOR_SLOT_FILL_ORDER } from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { HarborTraffic, reduceHarborTrafficState, snapshotHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { hullSprites } from './support/harbor-sim.mjs';

// D2 — a harbor laid out before the pier berths re-claims them once, most
// active repos first, and its ships sail over instead of jumping.

const T = Date.parse('2026-10-15T10:00:00Z');
const PIERS = HARBOR_SLOT_FILL_ORDER.slice(0, 4);

function commits(project, count, base) {
    return Array.from({ length: count }, (_, i) => ({ id: `${project}-${i}`, type: 'commit', project, branch: 'main', targetRef: 'main', sha: `${project.length}${i}${base}`.padStart(40, '0').slice(-40), label: `c ${i}`, timestamp: base + i * 1000, success: true, status: 'success' }));
}

// A state as v1 left it: repos on the lagoon and coast slots (0, 1, 2, 3),
// no anchorage version.
function legacyState() {
    const events = [
        ...commits('/w/quiet', 1, T),
        ...commits('/w/busy', 6, T + 10_000),
        ...commits('/w/mid', 3, T + 20_000),
        ...commits('/w/small', 2, T + 30_000),
    ];
    const state = reduceHarborTrafficState(null, events, { now: T + 60_000, motionScale: 0 });
    const legacy = { ...state, repoAnchorages: new Map([['/w/quiet', 0], ['/w/busy', 1], ['/w/mid', 2], ['/w/small', 3]]) };
    delete legacy.anchorageVersion;
    return legacy;
}

test('a pre-D2 state re-claims the pier berths once, most active repo first', () => {
    const migrated = reduceHarborTrafficState(legacyState(), [], { now: T + 61_000, motionScale: 0 });
    assert.equal(migrated.anchorageVersion, HARBOR_ANCHORAGE_VERSION);
    const slots = migrated.repoAnchorages;
    assert.equal(slots.get('/w/busy'), PIERS[0]);
    assert.equal(slots.get('/w/mid'), PIERS[1]);
    assert.equal(slots.get('/w/small'), PIERS[2]);
    assert.equal(slots.get('/w/quiet'), PIERS[3]);
    assert.equal(new Set(slots.values()).size, slots.size, 'no two repos share a slot');
    // Sticky after that: a second pass and a new repo move nobody.
    const again = reduceHarborTrafficState(migrated, commits('/w/new', 1, T + 70_000), { now: T + 71_000, motionScale: 0 });
    for (const project of ['/w/busy', '/w/mid', '/w/small', '/w/quiet']) assert.equal(again.repoAnchorages.get(project), slots.get(project));
    assert.equal(COAST_ANCHORAGE_SLOTS[again.repoAnchorages.get('/w/new')].pier, undefined, 'the overflow repo takes the coast');
    assert.equal(snapshotHarborTrafficState(again).anchorageVersion, HARBOR_ANCHORAGE_VERSION);
});

test('a current state is never re-claimed', () => {
    const current = reduceHarborTrafficState(null, commits('/w/a', 2, T), { now: T + 5000, motionScale: 0 });
    const moved = { ...current, repoAnchorages: new Map([['/w/a', 2]]) };
    const after = reduceHarborTrafficState(moved, [], { now: T + 6000, motionScale: 0 });
    assert.equal(after.repoAnchorages.get('/w/a'), 2);
});

test('migrated fleets sail to the piers without a jump', () => {
    const harbor = new HarborTraffic({ sprites: hullSprites() });
    const legacy = legacyState();
    harbor.state = reduceHarborTrafficState(legacy, [], { now: T + 61_000, motionScale: 1 });
    // First frames on the legacy layout, then the migrated one lands.
    const legacyHarbor = { ...harbor.state, repoAnchorages: legacy.repoAnchorages };
    harbor.state = legacyHarbor;
    harbor._dockLayout = null;
    harbor._refreshRenderWindow(T + 61_000);
    const last = new Map();
    let maxStep = 0;
    for (let t = 0; t < 40_000; t += 33) {
        const now = T + 61_000 + t;
        if (t === 990) {
            harbor.state = reduceHarborTrafficState(legacy, [], { now, motionScale: 1 });
            harbor._dockLayout = null;
            harbor._refreshRenderWindow(now);
        }
        harbor.advance(33);
        for (const item of harbor.enumerateHullDrawables(now)) {
            const prev = last.get(item.id);
            if (prev) maxStep = Math.max(maxStep, Math.hypot(item.x - prev.x, item.y - prev.y));
            last.set(item.id, { x: item.x, y: item.y });
        }
    }
    assert.ok(maxStep <= 6.5, `a migrated hull jumped ${maxStep.toFixed(1)} px`);
    for (const payload of harbor._shipHitEntries) assert.match(payload.anchorageName, /Pier Berth$/, `${payload.id} still moors at ${payload.anchorageName}`);
});
