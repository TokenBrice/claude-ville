// VB-14 — `agent.lastActive` is the last WebSocket touch: every message
// stamps it on every agent, so it orders agents by message processing, not by
// what their sessions did. Ranking and scene identity read the session's own
// `lastSessionActivity`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { prioritizedChatPairs } from '../../claudeville/src/presentation/character-mode/CouncilRing.js';
import { VillageDirector } from '../../claudeville/src/presentation/character-mode/VillageDirector.js';

const TOUCH = 2_000_000;

test('talk arcs go to the pairs whose sessions acted last, not the last touched', () => {
    // The live shape: one message touched everyone, the quiet pair last.
    const agents = {
        busyA: { lastSessionActivity: 1_900_000, lastActive: TOUCH },
        busyB: { lastSessionActivity: 1_800_000, lastActive: TOUCH },
        quietA: { lastSessionActivity: 1_000_000, lastActive: TOUCH + 5 },
        quietB: { lastSessionActivity: 1_100_000, lastActive: TOUCH + 5 },
    };
    const sprites = new Map(Object.entries(agents).map(([id, agent]) => [id, { agent: { id, ...agent } }]));
    const pairs = [{ aId: 'quietA', bId: 'quietB' }, { aId: 'busyA', bId: 'busyB' }];
    assert.deepEqual(prioritizedChatPairs(pairs, sprites).map(pair => pair.aId), ['busyA', 'quietA']);
});

test('a standing incident keeps its scene id and start across message touches', () => {
    const director = new VillageDirector({ buildings: new Map() });
    const agent = {
        id: 'stuck', name: 'Stuck', status: AgentStatus.ERRORED, building: 'command',
        x: 0, y: 0, lastSessionActivity: 1_500_000, lastActive: TOUCH,
    };
    const first = director._incidentScenes([agent], TOUCH);
    const later = director._incidentScenes([{ ...agent, lastActive: TOUCH + 2_000 }], TOUCH + 2_000);
    assert.equal(first.length, 1);
    assert.equal(first[0].startedAt, 1_500_000);
    assert.equal(later[0].id, first[0].id, 'a message touch is not a new incident');
    director.dispose();
});
