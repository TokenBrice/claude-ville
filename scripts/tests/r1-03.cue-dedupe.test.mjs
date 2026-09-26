import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AudioDirector } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';

function directorWithoutAudio() {
    const director = new AudioDirector({
        engine: { context: null, started: false },
    });
    // Exercise the agent dedupe independently of the four-second spacing gate.
    director.cueKit.governor.minSpacingMs = 0;
    return director;
}

function captureCues() {
    const cues = [];
    const unsubscribe = eventBus.on('audio:cue-played', cue => cues.push(cue));
    return { cues, unsubscribe };
}

// One actionable entry reaches audio through two events whose order depends on
// subscriber order. The voice follows the agent's bucket in either order.
const ACTIONABLE_CASES = [
    { status: 'errored', kind: 'distress', name: 'Ada' },
    { status: 'rate_limited', kind: 'limit', name: 'Bram' },
    { status: 'waiting_on_user', kind: 'summons', name: 'Cora' },
];

function emitWatchtower(agentId, status) {
    // The watchtower only reports incidents; a question has no tower event.
    if (status === 'waiting_on_user') return;
    eventBus.emit('distress:watchtower', { agentId, kind: status });
}

function emitAttention(agentId, status, name) {
    eventBus.emit('attention:raised', {
        agentId,
        status,
        agent: { id: agentId, name, status },
        reason: status,
        waitingCount: 1,
        oldestWaitMs: 0,
    });
}

for (const { status, kind, name } of ACTIONABLE_CASES) {
    for (const order of ['watchtower first', 'attention first']) {
        test(`${status} spends one ${kind} cue with the ${order}`, () => {
            const director = directorWithoutAudio();
            const capture = captureCues();
            const agentId = `agent-${status}`;
            try {
                if (order === 'watchtower first') {
                    emitWatchtower(agentId, status);
                    emitAttention(agentId, status, name);
                } else {
                    emitAttention(agentId, status, name);
                    emitWatchtower(agentId, status);
                }

                assert.equal(capture.cues.length, 1);
                assert.equal(capture.cues[0].kind, kind);
                assert.equal(capture.cues[0].agentId, agentId);
            } finally {
                capture.unsubscribe();
                director.destroy();
            }
        });
    }
}

test('an attention event without a status reads the agent status from the world', () => {
    const world = { agents: new Map([['agent-world', { id: 'agent-world', status: 'rate_limited' }]]) };
    const director = new AudioDirector({ engine: { context: null, started: false }, world });
    const capture = captureCues();
    try {
        eventBus.emit('attention:raised', { agentId: 'agent-world' });
        assert.equal(capture.cues.length, 1);
        assert.equal(capture.cues[0].kind, 'limit');
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});

test('a recovered agent that fails again inside the dedupe window is heard again', () => {
    const director = directorWithoutAudio();
    const capture = captureCues();
    try {
        eventBus.emit('distress:watchtower', { agentId: 'agent-flap', kind: 'errored' });
        eventBus.emit('distress:watchtower', { agentId: 'agent-flap', kind: 'recovered' });
        eventBus.emit('distress:watchtower', { agentId: 'agent-flap', kind: 'rate_limited' });

        assert.deepEqual(
            capture.cues.filter(cue => cue.kind !== 'recovery').map(cue => cue.kind),
            ['distress', 'limit'],
        );
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});

test('governor-approved cues emit the four-field contract without audio', () => {
    const director = directorWithoutAudio();
    const capture = captureCues();
    try {
        eventBus.emit('attention:raised', {
            agentId: 'agent-caption',
            agent: { id: 'agent-caption', name: 'Cora' },
            waitingCount: 3,
            oldestWaitMs: 90_000,
        });

        assert.equal(capture.cues.length, 1);
        assert.deepEqual(Object.keys(capture.cues[0]).sort(), ['agentId', 'at', 'kind', 'label']);
        assert.equal(capture.cues[0].kind, 'summons');
        assert.equal(capture.cues[0].agentId, 'agent-caption');
        assert.equal(capture.cues[0].label, 'Cora');
        assert.equal(Number.isFinite(capture.cues[0].at), true);
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});
