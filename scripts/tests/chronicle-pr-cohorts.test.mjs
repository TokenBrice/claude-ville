import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { MonumentRules, compareMonumentStanding } from '../../claudeville/src/application/MonumentRules.js';
import { HarborTraffic, reduceHarborTrafficState, snapshotHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { COHORT_REACH_TILES, summarizeCrowdClusterEntries } from '../../claudeville/src/presentation/character-mode/CrowdClusters.js';
import { drawCrowdClusterAuras, drawCrowdClusterBadges } from '../../claudeville/src/presentation/character-mode/CrowdClusterOverlay.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { BUILDING_ACCENTS_RGB } from '../../claudeville/src/config/theme.js';

const require = createRequire(import.meta.url);
const { parseGitEventsFromCommand } = require('../../claudeville/adapters/gitEvents.js');

const rules = new MonumentRules();
const T0 = 1_800_000_000_000;

function commit(message, sha = message) {
    return { type: 'commit', subject: message, sha, project: '/repos/claude-ville', ts: T0 };
}

test('W7.9: docs, test and upkeep commits plant in their districts', () => {
    const cases = [
        ['docs: explain the harbor', 'archive', 'docs'],
        ['test: cover the quay', 'taskboard', 'test'],
        ['chore: bump deps', 'harbor', 'upkeep'],
        ['build(deps): pin node', 'harbor', 'upkeep'],
        ['ci: cache npm', 'harbor', 'upkeep'],
        ['feat: add gulls', 'forge', 'feature'],
        ['fix: mend the bridge', 'taskboard', 'fix'],
        ['perf: faster tide', 'mine', 'performance'],
    ];
    for (const [message, district, kind] of cases) {
        const record = rules.buildRecord(commit(message), { now: T0 });
        assert.equal(record?.district, district, message);
        assert.equal(record.kind, kind, message);
        assert.ok(record.lore.length > 0, message);
    }
    assert.equal(rules.classify(commit('style: tabs')), null);
    assert.equal(rules.classify(commit('chore: bump')).weight, 'minor');
});

test('W7.9: a merged PR takes its title type district, else the harbor', () => {
    const typed = rules.classify({ type: 'pr-merge', title: 'docs: harbor guide', url: 'https://github.com/o/r/pull/7', project: '/r' });
    assert.equal(typed.district, 'archive');
    assert.equal(typed.kind, 'docs');
    const bare = rules.classify({ type: 'pr-merge', url: 'https://github.com/o/r/pull/12', project: '/r', success: true });
    assert.equal(bare.district, 'harbor');
    assert.equal(bare.kind, 'merge');
    assert.equal(bare.label, 'PR #12');
    assert.equal(bare.dedupKey, 'pr-merge:/r:https://github.com/o/r/pull/12');
    assert.equal(rules.classify({ type: 'pr-merge', project: '/r', success: false }), null);
    assert.equal(rules.classify({ type: 'pr-merge', project: '/r', exitCode: 1 }), null);
    // The adapter's forge event carries the action the Chronicle forwards.
    const [merge] = parseGitEventsFromCommand('gh pr merge 12 --squash', { ts: T0, success: true });
    assert.equal(merge.type, 'pr');
    assert.equal(merge.action, 'merge');
});

test('W7.9: upkeep never outranks a release in the ledger newest three or the cap', () => {
    const release = { id: 'r', kind: 'release', plantedAt: T0 };
    const chores = [1, 2, 3, 4, 5, 6].map(n => ({ id: `c${n}`, kind: 'upkeep', plantedAt: T0 + n * 1000 }));
    const ledger = [...chores, release].sort(compareMonumentStanding).slice(0, 3);
    assert.equal(ledger[0].id, 'r');
    assert.deepEqual(ledger.slice(1).map(row => row.id), ['c6', 'c5']);
    const capped = MonumentRules.applyDistrictCap([...chores, release]);
    assert.ok(capped.visible.some(record => record.id === 'r'));
    assert.equal(capped.foundingLayer, true);
    // Non-upkeep kinds keep the plain newest-first order.
    const fixes = [{ id: 'a', kind: 'fix', plantedAt: T0 }, { id: 'b', kind: 'test', plantedAt: T0 + 1 }];
    assert.deepEqual(fixes.sort(compareMonumentStanding).map(row => row.id), ['b', 'a']);
});

const PR_URL = 'https://github.com/o/cv/pull/12';
const prCreate = { id: 'git-pr-create', type: 'pr', action: 'create', project: '/r/cv', timestamp: T0, url: PR_URL, status: 'success' };
const prMerge = { id: 'git-pr-merge', type: 'pr', action: 'merge', project: '/r/cv', timestamp: T0 + 70_000, url: PR_URL, status: 'success' };

function ships(state) {
    return [...state.ships.values()];
}

test('W7.9: gh pr create moors a PR cutter at the outer roadstead', () => {
    let state = reduceHarborTrafficState(null, [prCreate], { now: T0 + 1000 });
    const [ship] = ships(state);
    assert.equal(ship.prShip, true);
    assert.equal(ship.isInbound, true, 'rides the inbound cutter hull');
    assert.equal(ship.status, 'arriving');
    assert.equal(ship.arrivingKind, 'pr');
    assert.equal(ship.label, 'PR #12');
    assert.ok(ship.inboundRoadsteadTile.tileX > 37, 'moors in the outer roadstead');
    state = reduceHarborTrafficState(state, [], { now: T0 + 60_000 });
    assert.equal(ships(state)[0].status, 'anchored');
    // A second open PR moors on its own anchorage.
    const other = { ...prCreate, id: 'git-pr-create-2', url: 'https://github.com/o/cv/pull/13' };
    state = reduceHarborTrafficState(state, [prCreate, other], { now: T0 + 61_000 });
    const [a, b] = ships(state);
    assert.notDeepEqual(a.inboundRoadsteadTile, b.inboundRoadsteadTile);
    // A failed create sails nothing; reduced motion moors it at once.
    assert.equal(reduceHarborTrafficState(null, [{ ...prCreate, status: 'failed' }], { now: T0 + 1000 }).ships.size, 0);
    assert.equal(ships(reduceHarborTrafficState(null, [prCreate], { now: T0 + 1000, motionScale: 0 }))[0].status, 'anchored');
});

test('W7.9: gh pr merge sails the moored cutter in to the quay, then it retires', () => {
    let state = reduceHarborTrafficState(null, [prCreate], { now: T0 + 1000 });
    state = reduceHarborTrafficState(state, [], { now: T0 + 60_000 });
    const moorTile = ships(state)[0].inboundRoadsteadTile;
    state = reduceHarborTrafficState(state, [prCreate, prMerge], { now: T0 + 71_000 });
    assert.equal(state.ships.size, 1, 'the same cutter, not a second hull');
    const [ship] = ships(state);
    assert.equal(ship.status, 'arriving');
    assert.equal(ship.arrivingKind, 'pr-merge');
    assert.deepEqual(ship.prFromTile, moorTile, 'sails from its mooring');
    assert.ok(Number.isInteger(ship.berthIndex) && ship.berthIndex >= 0);
    state = reduceHarborTrafficState(state, [], { now: T0 + 95_000 });
    assert.equal(ships(state)[0].status, 'anchored', 'tied up at the quay');
    state = reduceHarborTrafficState(state, [], { now: T0 + 95_000 + 11 * 60_000 });
    assert.equal(state.ships.size, 0);
    // A merge with no moored cutter still brings one in, from the sea.
    const lone = ships(reduceHarborTrafficState(null, [prMerge], { now: T0 + 71_000 }))[0];
    assert.equal(lone.arrivingKind, 'pr-merge');
    assert.equal(lone.prFromTile, null);
});

test('W7.9: a moored PR outlives the replay window, then expires', () => {
    const state = reduceHarborTrafficState(null, [prCreate], { now: T0 + 30 * 60_000 });
    assert.equal(ships(state)[0].status, 'anchored', 'an hour-old PR appears already moored');
    assert.equal(reduceHarborTrafficState(state, [], { now: T0 + 3 * 60 * 60_000 }).ships.size, 0);
    assert.equal(reduceHarborTrafficState(null, [prCreate], { now: T0 + 3 * 60 * 60_000 }).ships.size, 0);
});

test('W7.9: PR cutter labels and summaries use pull identity, never event IDs or commit badges', () => {
    const cases = [
        [{ url: 'https://github.com/o/cv/pull/13', branch: 'feature/harbor' }, 'PR #13'],
        [{ url: 'https://github.com/o/cv/pull/13/?tab=files#diff' }, 'PR #13'],
        [{ url: '', branch: 'feature/harbor', title: 'Improve the harbor' }, 'PR feature/harbor'],
        [{ url: '', title: 'Improve the harbor' }, 'PR Improve the harbor'],
        [{ url: '' }, 'PR'],
    ];
    for (const [details, expected] of cases) {
        const harbor = new HarborTraffic();
        harbor.setMotionScale(0);
        harbor.reconcile([{
            id: 'qa-agent',
            projectPath: prCreate.project,
            gitEvents: [{ ...prCreate, id: 'qa-pr-create-13', ...details }],
        }], T0 + 1000);
        const [ship] = ships(harbor.state);
        assert.equal(ship.status, 'anchored');
        assert.equal(ship.label, expected);
        assert.equal(snapshotHarborTrafficState(harbor.state).ships[0].label, expected);
        assert.ok(harbor.shipTooltip(ship).endsWith(` - ${expected}`));

        // Exercise the rendered hover text, not just the reducer's stored label.
        const positioned = { ...ship, x: 100, y: 100, elapsed: 60_000 };
        const hover = recordingCtx();
        harbor._drawHoverCargoLabel(hover.ctx, positioned, 1);
        assert.deepEqual(hover.calls.texts, [expected]);

        // The always-visible identity plate used to fall through to event IDs.
        const pennant = recordingCtx();
        harbor._drawCommitPennant(pennant.ctx, positioned, 1);
        assert.equal(pennant.calls.texts.length, 1);
        assert.ok(pennant.calls.texts[0].startsWith('PR'));
        if (expected === 'PR #13' || expected === 'PR') {
            assert.deepEqual(pennant.calls.texts, [expected]);
        }
        assert.ok(!pennant.calls.texts[0].includes('qa-pr'));

        const badge = recordingCtx();
        harbor._drawShipTierBadge(badge.ctx, positioned);
        assert.deepEqual(badge.calls.texts, [], 'a PR cutter carries no 2+ commit badge');
        assert.deepEqual(badge.calls.fills, [], 'no empty commit-badge plate either');
    }
});

test('W7.9: a merge URL upgrades an unnumbered cutter to its PR number', () => {
    let state = reduceHarborTrafficState(null, [{ ...prCreate, url: '', title: 'Improve the harbor' }], {
        now: T0 + 1000,
        motionScale: 0,
    });
    assert.equal(ships(state)[0].label, 'PR Improve the harbor');
    state = reduceHarborTrafficState(state, [prMerge], { now: T0 + 71_000, motionScale: 0 });
    assert.equal(state.ships.size, 1);
    assert.equal(ships(state)[0].label, 'PR #12');
    assert.equal(snapshotHarborTrafficState(state).ships[0].label, 'PR #12');
    assert.ok(new HarborTraffic().shipTooltip(ships(state)[0]).endsWith(' - PR #12'));
});

// Cohort auras: the director's work cohorts fold into crowd clusters.
function forgeCohort(ids) {
    const center = tileToWorld(20, 20);
    return { type: 'forge', agentIds: ids, center: { x: center.x, y: center.y }, working: ids.length, total: ids.length };
}

function entry(id, tileX, tileY, extra = {}) {
    return { agentId: id, tileX, tileY, moving: false, status: 'working', provider: 'claude', ...extra };
}

test('W7.11: a work cohort is one cluster per building with an exact count', () => {
    const entries = [
        entry('a', 19, 20), entry('b', 21, 21), entry('c', 20.5, 22),
        entry('d', 23.9, 20, { status: 'waiting' }),
        // A walking member and one far from the building stay out.
        entry('e', 20, 19, { moving: true }),
        entry('f', 20 + COHORT_REACH_TILES + 3, 20),
        // A plaza crowd of three elsewhere stays a cell cluster.
        entry('p1', 4.1, 4.1), entry('p2', 4.5, 4.2), entry('p3', 4.3, 4.9),
    ];
    const cohort = forgeCohort(['a', 'b', 'c', 'd', 'e', 'f']);
    const { clusters } = summarizeCrowdClusterEntries(entries, { cellSize: 4, includeStatusCounts: true, cohorts: [cohort] });
    const cohorts = clusters.filter(cluster => cluster.kind === 'cohort');
    assert.equal(cohorts.length, 1, 'one aura for the building');
    assert.equal(cohorts[0].id, 'cohort:forge');
    assert.equal(cohorts[0].building, 'forge');
    assert.equal(cohorts[0].count, 4);
    assert.deepEqual(cohorts[0].agentIds, ['a', 'b', 'c', 'd']);
    assert.deepEqual(cohorts[0].statuses, { working: 3, waiting: 1 });
    const cells = clusters.filter(cluster => cluster.kind !== 'cohort');
    assert.equal(cells.length, 1);
    assert.equal(cells[0].count, 3);
    // Every body is in at most one cluster: no doubled aura or tab.
    const total = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
    assert.equal(total, 7);
    // Without cohorts the summary is the old cell grammar.
    const plain = summarizeCrowdClusterEntries(entries, { cellSize: 4 });
    assert.ok(plain.clusters.every(cluster => !cluster.kind));
    // A lone member is not a cohort aura.
    const lone = summarizeCrowdClusterEntries([entry('a', 20, 20)], { cohorts: [forgeCohort(['a'])] });
    assert.equal(lone.clusters.length, 0);
});

function recordingCtx() {
    const calls = { fills: [], texts: [] };
    const ctx = {
        globalAlpha: 1, fillStyle: '', font: '', textAlign: '', textBaseline: '',
        save() {}, restore() {}, translate() {}, scale() {}, setTransform() {},
        getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
        fillRect() { calls.fills.push(this.fillStyle); },
        fillText(text) { calls.texts.push(text); },
        measureText(text) { return { width: String(text).length * 8 }; },
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
    };
    return { ctx, calls };
}

test('W7.11: the cohort aura paints in its district material and takes one tab', () => {
    const entries = [entry('a', 19, 20), entry('b', 21, 21), entry('c', 20.5, 22)];
    const crowdStats = summarizeCrowdClusterEntries(entries, { includeStatusCounts: true, cohorts: [forgeCohort(['a', 'b', 'c'])] });
    const ground = recordingCtx();
    drawCrowdClusterAuras(ground.ctx, { crowdStats });
    assert.ok(ground.calls.fills.includes(`rgba(${BUILDING_ACCENTS_RGB.forge}, 1)`), 'forge accent pool');
    // One named member (an overlay slot) leaves an exact +2 on one tab.
    const sprites = new Map(entries.map((item) => {
        const world = tileToWorld(item.tileX, item.tileY);
        return [item.agentId, { agent: { id: item.agentId, status: 'working' }, x: world.x, y: world.y, overlaySlot: item.agentId === 'a' ? 0 : null }];
    }));
    const overlay = recordingCtx();
    drawCrowdClusterBadges(overlay.ctx, { crowdStats, agentSprites: sprites, zoom: 1 });
    assert.deepEqual(overlay.calls.texts, ['+2']);
});
