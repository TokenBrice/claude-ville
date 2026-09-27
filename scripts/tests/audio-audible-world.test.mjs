import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LINK_LOST_AFTER_MS,
    LinkHealth,
    audibleAgents,
    digestNotes,
    waitState,
} from '../../claudeville/src/presentation/shared/audio/AudibleWorld.js';

const NOW = 5_000_000;

function world(agents) {
    return { agents: new Map(agents.map(agent => [agent.id, agent])) };
}

test('a stale working agent is not audible', () => {
    const village = world([
        { id: 'live', status: 'working', signalObservedAt: NOW - 1_000 },
        { id: 'stale', status: 'working', signalStale: true },
        { id: 'resident', status: 'working', resident: true },
        { id: 'aged', status: 'working', freshness: { state: 'stale' } },
    ]);
    assert.deepEqual(audibleAgents(village, NOW).map(agent => agent.id), ['live']);
});

test('a wait that only went stale is unheard, not answered', () => {
    assert.deepEqual(waitState(world([
        { id: 'q', status: 'waiting_on_user', awaitingSince: NOW - 60_000 },
        { id: 'e', status: 'errored', signalStale: true },
    ]), NOW), { waiting: 1, unheard: 1, family: 'needsYou' });
    assert.deepEqual(waitState(world([{ id: 'e', status: 'errored', signalStale: true }]), NOW),
        { waiting: 0, unheard: 1, family: null });
});

test('a socket loss is declared once, after ten seconds without a break', () => {
    const link = new LinkHealth();
    link.observe('ws:state', { state: 'live' }, 0);
    link.observe('ws:disconnected', {}, 1_000);
    link.observe('ws:state', { state: 'reconnecting' }, 2_000);
    assert.equal(link.dueAt(), 1_000 + LINK_LOST_AFTER_MS);
    assert.equal(link.check(1_000 + LINK_LOST_AFTER_MS - 1), null);
    assert.equal(link.check(1_000 + LINK_LOST_AFTER_MS), 'lost');
    assert.equal(link.check(60_000), null);
    link.observe('ws:disconnected', {}, 61_000);
    assert.equal(link.check(120_000), null);
    assert.equal(link.observe('ws:state', { state: 'live' }, 121_000), 'restored');
    assert.equal(link.observe('ws:state', { state: 'live' }, 122_000), null);
});

test('reconnect flutter, a cold start and a live polling fallback are not losses', () => {
    const flutter = new LinkHealth();
    flutter.observe('ws:state', { state: 'live' }, 0);
    flutter.observe('ws:disconnected', {}, 1_000);
    flutter.observe('ws:state', { state: 'live' }, 9_000);
    assert.equal(flutter.check(30_000), null);

    const cold = new LinkHealth();
    cold.observe('ws:state', { state: 'syncing' }, 0);
    cold.observe('ws:disconnected', {}, 1_000);
    assert.equal(cold.check(60_000), null);

    const polling = new LinkHealth();
    polling.observe('ws:state', { state: 'live' }, 0);
    polling.observe('ws:disconnected', {}, 1_000);
    polling.observe('watcher:state', { state: 'polling' }, 1_100);
    polling.observe('watcher:state', { ok: true, at: 3_000 }, 3_000);
    assert.equal(polling.check(60_000), null);
    polling.observe('watcher:state', { ok: false, code: 'poll-failed' }, 61_000);
    assert.equal(polling.check(61_000 + LINK_LOST_AFTER_MS), 'lost');
});

test('the digest phrase is past first and the open wait last', () => {
    assert.deepEqual(
        digestNotes({ awayMs: 90_000, summary: { errorAgentCount: 1, waitingAgents: 1, pushes: 2 } }),
        ['gold', 'gold', 'red', 'amber'],
    );
    assert.deepEqual(digestNotes({ summary: { completed: 1, commits: 1, rateLimitAgentCount: 1 } }),
        ['gold', 'stone', 'amber']);
});

test('the digest phrase keeps five notes, two per family, dropping good news before bad and never the wait', () => {
    const notes = digestNotes({ summary: { pushes: 9, completed: 9, errorAgentCount: 9, waitingAgents: 9 } });
    assert.deepEqual(notes, ['gold', 'red', 'red', 'amber', 'amber']);
});

test('an empty digest is no phrase', () => {
    assert.deepEqual(digestNotes({ awayMs: 90_000, summary: {} }), []);
    assert.deepEqual(digestNotes(null), []);
});
