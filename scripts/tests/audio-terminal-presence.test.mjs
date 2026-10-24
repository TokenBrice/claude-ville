import test from 'node:test';
import assert from 'node:assert/strict';

import { TERMINAL_PRESENCE_MS, TerminalPresence } from '../../claudeville/src/presentation/shared/audio/TerminalPresence.js';

const NOW = 10_000_000;

test('an answered prompt marks that session present for 90 s, and only that session (SND-4)', () => {
    const presence = new TerminalPresence();
    presence.observe({ id: 'a', status: 'waiting_on_user' }, NOW);
    presence.observe({ id: 'b', status: 'waiting_on_user' }, NOW);
    assert.equal(presence.actedRecently('a', NOW), false, 'a first sight is a baseline');
    assert.equal(presence.observe({ id: 'a', status: 'working' }, NOW + 5_000), NOW + 5_000);
    assert.equal(presence.actedRecently('a', NOW + 5_000 + TERMINAL_PRESENCE_MS - 1), true);
    assert.equal(presence.actedRecently('a', NOW + 5_000 + TERMINAL_PRESENCE_MS), false);
    assert.equal(presence.actedRecently('b', NOW + 6_000), false, 'answering one terminal says nothing of another');
    assert.equal(TERMINAL_PRESENCE_MS, 90_000);
});

test('a new user turn is presence; an old or unchanged one is not (SND-4)', () => {
    const presence = new TerminalPresence();
    presence.observe({ id: 'a', status: 'waiting', turnStartedAt: NOW - 600_000 }, NOW);
    assert.equal(presence.observe({ id: 'a', status: 'waiting', turnStartedAt: NOW - 600_000 }, NOW + 1_000), null);
    assert.equal(presence.observe({ id: 'a', status: 'working', turnStartedAt: NOW + 2_000 }, NOW + 3_000), NOW + 2_000);
    assert.equal(presence.actedRecently('a', NOW + 3_000), true);
    // A turn the transcript window only now shows, but that began long ago.
    presence.observe({ id: 'b', status: 'idle', turnStartedAt: null }, NOW);
    assert.equal(presence.observe({ id: 'b', status: 'working', turnStartedAt: NOW - TERMINAL_PRESENCE_MS }, NOW), null);
});

test('stale observations, sub-agents, errors and limits are not presence (SND-4)', () => {
    const presence = new TerminalPresence();
    presence.observe({ id: 'stale', status: 'waiting_on_user' }, NOW);
    assert.equal(presence.observe({ id: 'stale', status: 'working' }, NOW + 1_000, { audible: false }), null);
    presence.observe({ id: 'child', status: 'waiting_on_user', parentSessionId: 'p' }, NOW);
    assert.equal(presence.observe({ id: 'child', status: 'working', parentSessionId: 'p', turnStartedAt: NOW }, NOW + 1_000), null);
    presence.observe({ id: 'err', status: 'errored' }, NOW);
    assert.equal(presence.observe({ id: 'err', status: 'working' }, NOW + 1_000), null, 'a retry after an error is not an answer');
    presence.observe({ id: 'quota', status: 'rate_limited' }, NOW);
    assert.equal(presence.observe({ id: 'quota', status: 'working' }, NOW + 1_000), null);
    presence.observe({ id: 'gone', status: 'waiting_on_user' }, NOW);
    presence.observe({ id: 'gone', status: 'waiting_on_user' }, NOW + 500);
    assert.equal(presence.observe({ id: 'gone', status: 'idle' }, NOW + 1_000), null, 'a wait that ends at rest was not answered');
    assert.deepEqual(presence.present(NOW + 1_000), []);
});

test('a forgotten session starts again from a baseline (SND-4)', () => {
    const presence = new TerminalPresence();
    presence.observe({ id: 'a', status: 'waiting_on_user' }, NOW);
    presence.observe({ id: 'a', status: 'working' }, NOW + 1_000);
    assert.deepEqual(presence.present(NOW + 1_000), ['a']);
    presence.forget('a');
    assert.equal(presence.actedRecently('a', NOW + 1_000), false);
    assert.equal(presence.observe({ id: 'a', status: 'working' }, NOW + 2_000), null);
});
