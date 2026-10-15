import test from 'node:test';
import assert from 'node:assert/strict';

import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// A repo with live agents but no ship keeps its berth in state but shows no
// marker or label; they come back (fading) with its next ship.

const T = Date.parse('2026-10-15T10:00:00Z');

test('an empty berth hides its marker, keeps its slot, and shows it again with a ship', () => {
    const harbor = new HarborTraffic();
    harbor.setMotionScale(0);
    const agent = { id: 'a', name: 'A', provider: 'claude', sessionId: 's', projectPath: '/w/quiet', lastActivity: T, gitEvents: [] };
    harbor.reconcile([agent], T);
    const slot = harbor.state.repoAnchorages.get('/w/quiet');
    assert.ok(Number.isInteger(slot), 'the live repo holds its berth');
    const marker = () => harbor._repoAnchorageDrawableCache.find(d => d.payload?.project === '/w/quiet')?.payload;
    assert.equal(marker()?.present, false);
    assert.equal(harbor._markerFade('/w/quiet', false), 0, 'hidden while it has no ships');
    agent.gitEvents = [{ id: 'c1', type: 'commit', project: '/w/quiet', branch: 'main', sha: '1'.padStart(40, '0'), label: 'c', timestamp: T + 1000, success: true, status: 'success' }];
    harbor.reconcile([agent], T + 2000);
    assert.equal(harbor.state.repoAnchorages.get('/w/quiet'), slot, 'same berth');
    assert.equal(marker()?.present, true);
    assert.equal(harbor._markerFade('/w/quiet', true), 1);
});
