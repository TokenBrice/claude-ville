import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CUE_LANES,
    CueGovernor,
    collapseCueBurst,
    compareCuePriority,
    cueLifecycleDecision,
    updateQuietFloor,
} from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { cricketLevel } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';

test('an urgent cue preempts a routine cue', () => {
    const urgent = { kind: 'summons', lane: CUE_LANES.NEEDS_YOU };
    const routine = { kind: 'arrival', lane: CUE_LANES.ROUTINE };

    assert.ok(compareCuePriority(urgent, routine) < 0);
    assert.equal([routine, urgent].sort(compareCuePriority)[0], urgent);
});

test('six routine cues in one aggregation window become one honest result', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'arrival',
        lane: CUE_LANES.ROUTINE,
        agentId: `agent-${index}`,
        at: 1000 + index * 20,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].eventKind, 'aggregate');
    assert.equal(collapsed[0].aggregateCount, 6);
    assert.equal(collapsed[0].agentId, null);
    assert.match(collapsed[0].label, /6 arrivals/);
});

test('urgent cues never collapse', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'summons',
        lane: CUE_LANES.NEEDS_YOU,
        agentId: `agent-${index}`,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 6);
    assert.ok(collapsed.every(cue => cue.kind === 'summons'));
});

test('provider-voiced council cues bypass burst aggregation', () => {
    const cues = [
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'claude', aggregate: false },
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'codex', aggregate: false },
    ];

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map(cue => cue.provider), ['claude', 'codex']);
});

test('quiet floor requires sustained calm and sustained activity without flutter', () => {
    let state = updateQuietFloor(undefined, {
        calm: true,
        now: 0,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: true,
        now: 9999,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'active');

    state = updateQuietFloor(state, {
        calm: true,
        now: 10000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 11000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: true,
        now: 12000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 13000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: false,
        now: 15999,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 16000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'active');
});

test('hidden lifecycle suppresses ambience but permits summons without a return backlog', () => {
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.SCENERY,
        hidden: true,
    }), 'suppress');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.NEEDS_YOU,
        hidden: true,
    }), 'play');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.ROUTINE,
        returning: true,
    }), 'discard');
});

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Short windows keep the timing real without slowing the suite: a 20 ms
// routine window and an 80 ms team hold stand in for 180 ms and 600 ms.
function recordingGovernor(options = {}) {
    const governor = new CueGovernor({
        maxPerMinute: 6,
        minSpacingMs: 4000,
        aggregationWindowMs: 20,
        teamHoldMs: 80,
        ...options,
    });
    const events = [];
    const play = (cue, stage = {}) => {
        if (stage.prepare) {
            events.push({ stage: 'prepare', kind: cue.kind });
            return () => events.push({ stage: 'cancel', kind: cue.kind });
        }
        events.push({
            stage: stage.announceOnly ? 'announce' : 'play',
            kind: cue.eventKind || cue.kind,
            label: cue.label ?? null,
            replaces: cue.replaces ?? null,
        });
        return true;
    };
    return { governor, events, play };
}

const arrival = (agentId, teamName = null) => ({
    kind: 'arrival',
    lane: CUE_LANES.ROUTINE,
    agentId,
    teamName,
    cooldownMs: 0,
});

const ceremony = (kind, supersedes, lane = CUE_LANES.ROUTINE) => ({
    kind,
    lane,
    cooldownMs: 0,
    aggregate: false,
    supersedes,
});

test('a team arrival burst is held until its gathering replaces it', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a', 'blue'), play);
    governor.submit(arrival('b', 'blue'), play);
    await wait(40);
    assert.equal(events.some(event => event.stage === 'announce'), false, 'past the plain window, still held');

    assert.equal(governor.submit(ceremony('council', ['a', 'b']), play), true);
    await wait(100);

    assert.deepEqual(events.map(event => `${event.stage}:${event.kind}`), [
        'prepare:arrival',
        'cancel:arrival',
        'play:council',
    ]);
    assert.deepEqual(
        { count: events[2].replaces.count, parts: events[2].replaces.parts },
        { count: 2, parts: '2 arrivals' },
    );
    assert.equal(governor.snapshot().ceremonies.superseded, 1);
    governor.destroy();
});

test('a ceremony replaces a just-announced aggregate and releases its unsounded notes', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a'), play);
    governor.submit(arrival('b'), play);
    await wait(40);
    assert.equal(events.at(-1).stage, 'announce');
    assert.equal(events.at(-1).kind, 'aggregate');

    // Inside the spacing window the council would be refused without supersedes.
    assert.equal(governor.submit(ceremony('council', ['a', 'b', 'c']), play), true);
    assert.deepEqual(events.slice(-2).map(event => `${event.stage}:${event.kind}`), [
        'cancel:arrival',
        'play:council',
    ]);
    assert.deepEqual(events.at(-1).replaces, {
        kind: 'aggregate',
        agentId: null,
        label: 'Routine activity: 2 arrivals',
        count: 2,
        parts: '2 arrivals',
    });
    governor.destroy();
});

test('a ceremony never absorbs parts that belong to someone else', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a', 'blue'), play);
    governor.submit(arrival('stranger'), play);
    governor.submit(ceremony('council', ['a']), play);
    await wait(100);

    const council = events.find(event => event.kind === 'council');
    assert.equal(council.replaces, null);
    assert.equal(events.some(event => event.stage === 'cancel'), false);
    assert.equal(events.at(-1).stage, 'announce');
    governor.destroy();
});

test('a ceremony bypasses the spacing rule once but never the per-minute budget', () => {
    const { governor, events, play } = recordingGovernor({ maxPerMinute: 2 });
    const scenery = (kind, extra = {}) => ({
        kind,
        lane: CUE_LANES.SCENERY,
        cooldownMs: 0,
        aggregate: false,
        ...extra,
    });
    assert.equal(governor.submit(scenery('hourBell'), play), true);
    assert.equal(governor.submit(scenery('aurora'), play), false, 'spacing refuses a plain cue');
    assert.equal(governor.submit(scenery('aurora', { supersedes: [] }), play), true);
    assert.equal(governor.submit(scenery('aurora', { supersedes: [] }), play), false, 'budget still applies');
    assert.deepEqual(events.map(event => event.kind), ['hourBell', 'aurora']);
    governor.destroy();
});

test('crickets fall silent as rain arrives and stop in a storm', () => {
    const midnight = { phase: 'night', phaseProgress: 0.5, season: 'summer' };
    assert.equal(cricketLevel({ ...midnight, precipitation: 0 }), 1);
    assert.ok(cricketLevel({ ...midnight, precipitation: 0.5 }) <= 0.5);
    assert.equal(cricketLevel({ ...midnight, precipitation: 0.6, storm: 0.8 }), 0);
    assert.equal(cricketLevel({ ...midnight, phase: 'day' }), 0);
});
