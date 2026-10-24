// D qw — a per-kind moment counter for Shift-D, so fire rates can be read.
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../claudeville/src/domain/services/VerifiedOutcome.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { momentTally, noteMoment, resetMomentTally } from '../../claudeville/src/presentation/character-mode/MomentTally.js';
import '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';

test('the tally counts each kind since load and resets', () => {
    resetMomentTally(1000);
    noteMoment('arrival');
    noteMoment('arrival');
    noteMoment('');
    noteMoment('mend');
    assert.deepEqual(momentTally(), { since: 1000, counts: { arrival: 2, mend: 1 } });
    resetMomentTally(2000);
    assert.deepEqual(momentTally(), { since: 2000, counts: {} });
});

test('chits and celebrations reach the tally from their own owners', (t) => {
    resetMomentTally();
    const buildings = new Map([['taskboard', { position: { tileX: 10, tileY: 10 }, width: 4, height: 4, entrance: { tileX: 12, tileY: 13 } }]]);
    const activity = new LandmarkActivity({ world: { buildings } });
    t.after(() => activity.dispose());
    activity._observeToolResult({ id: 'r1', agentId: 'a', tool: 'Bash', exitCode: 1, completedAt: 1, building: 'taskboard' });
    activity._observeToolResult({ id: 'r2', agentId: 'a', tool: 'Bash', exitCode: 0, completedAt: 2, building: 'taskboard' });
    eventBus.emit(VERIFIED_OUTCOME_EVENT, { kind: 'commit', agentId: 'a', project: '/r', at: Date.now() });
    eventBus.emit(VERIFIED_OUTCOME_EVENT, { kind: 'milestone', agentId: null, project: '/r', at: Date.now() });
    assert.deepEqual(momentTally().counts, { 'celebrate:commit': 1, 'chit:fail': 1, 'chit:pass': 1 });
});
