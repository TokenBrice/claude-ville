import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { ChronicleLog } from '../../claudeville/src/application/ChronicleLog.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const require = createRequire(import.meta.url);
const { parseOmpTranscript } = require('../../claudeville/adapters/omp.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');
const { HookOverlay, mergeOverlay, HOOK_EXPIRY_MS, HOOK_WAIT_RETENTION_MS } = require('../../claudeville/adapters/hooks.js');
const fixtureAt = Date.parse('2026-09-01T12:00:07.000Z');
const records = fs.readFileSync(new URL('../adapters/fixtures/omp/tool-results-session-exit.jsonl', import.meta.url), 'utf8')
    .replaceAll('__PROJECT__', '/fixture/project').trim().split('\n').map(line => JSON.parse(line));
const parse = (input = records) => parseOmpTranscript(input, {
    filePath: '/nonexistent/omp-outcomes.jsonl', fileMtimeMs: fixtureAt, now: fixtureAt,
}).session;

function fakeStore() {
    const rows = [];
    return {
        rows,
        async put(_name, row) { rows.push(row); },
        async queryRange() { return [...rows].sort((a, b) => a.ts - b.ts); },
    };
}

function liveSession(id = 'omp-live') {
    return { sessionId: id, provider: 'omp', agentName: 'Fixture', project: '/fixture/project',
        model: 'openai-codex/gpt-6.1-sol', turnState: 'working', lastTool: 'read',
        lastActivity: fixtureAt, sessionEndedAt: null };
}

test('OMP publishes only paired observed results, preserving unknown exits and stable call identity', () => {
    const session = normalizeSession(parse());
    assert.equal(session.sessionEndedAt, fixtureAt);
    assert.equal(session.turnState, 'awaiting_input');
    assert.equal(session.pendingTool, null);
    assert.deepEqual(session.lastResults.map(result => [result.tool, result.detail, result.exitCode, result.durationMs]), [
        ['read', 'example.js', null, 3000],
        ['bash', 'npm test', 1, 2000],
        ['bash', 'npm run build', 0, 1000],
    ]);
    assert.deepEqual(session.lastResults.map(result => result.completedAt), [fixtureAt - 2000, fixtureAt - 3000, fixtureAt - 4000]);
    assert.ok(session.lastResults.every(result => result.source === 'transcript'));
    assert.deepEqual(parse().lastResults, session.lastResults);
    assert.equal(session.lastResults.some(result => /call-open|outside-tail/.test(result.id)), false);
    assert.equal(normalizeSession({ sessionId: 'no-end', provider: 'claude' }).sessionEndedAt, null);
    assert.equal(normalizeSession({ sessionId: 'bad-end', sessionEndedAt: 'not-a-time' }).sessionEndedAt, null);
});

test('OMP result history keeps the existing five-result cap and never completes a missing call', () => {
    const input = [records[0]];
    for (let index = 0; index < 8; index++) {
        const timestamp = fixtureAt + index * 100;
        input.push({ type: 'message', timestamp, message: { role: 'assistant', content: [
            { type: 'toolCall', id: `call-${index}`, name: 'bash', arguments: { command: `echo ${index}` } },
        ] } });
        input.push({ type: 'message', timestamp: timestamp + 50, message: {
            role: 'toolResult', toolCallId: `call-${index}`, isError: false,
        } });
    }
    input.push({ type: 'message', timestamp: fixtureAt + 900, message: {
        role: 'toolResult', toolCallId: 'outside-tail', isError: true,
    } });
    const session = parse(input);
    assert.equal(session.lastResults.length, 5);
    assert.deepEqual(session.lastResults.map(result => result.detail), ['echo 7', 'echo 6', 'echo 5', 'echo 4', 'echo 3']);
    assert.ok(session.lastResults.every(result => result.durationMs === 50 && result.exitCode === 0));
});

test('a resumed OMP session clears the explicit end and old unfinished calls', () => {
    const resumed = parse([...records, { type: 'message', timestamp: fixtureAt + 1000, message: {
        role: 'user', content: [{ type: 'text', text: 'Continue the synthetic task.' }],
    } }]);
    assert.equal(resumed.sessionEndedAt, null);
    assert.equal(resumed.turnState, 'working');
    assert.equal(resumed.pendingTool, null);
    assert.equal(resumed.turnStartedAt, fixtureAt + 1000);
    assert.deepEqual(resumed.lastResults, parse().lastResults);
});

test('Claude SessionEnd remains explicit beyond ordinary overlay expiry and clears on resume', () => {
    let now = fixtureAt;
    const hooks = new HookOverlay({ now: () => now });
    const transcript = { ...liveSession('claude-live'), provider: 'claude', turnStartedAt: fixtureAt - 1000,
        turnState: 'awaiting_input', awaitingSince: fixtureAt };
    hooks.ingest({ provider: 'claude', sessionId: transcript.sessionId, kind: 'SessionEnd', ts: now });
    assert.equal(mergeOverlay(transcript, hooks.overlayFor(transcript.sessionId), now).sessionEndedAt, fixtureAt);
    now += HOOK_EXPIRY_MS + 1;
    assert.equal(mergeOverlay(transcript, hooks.overlayFor(transcript.sessionId), now).sessionEndedAt, fixtureAt);
    hooks.ingest({ provider: 'claude', sessionId: transcript.sessionId, kind: 'PostToolUse', ts: now });
    assert.equal(hooks.overlayFor(transcript.sessionId).sessionEndedAt, fixtureAt);
    const newerTurn = { ...transcript, turnState: 'working', turnStartedAt: now };
    assert.equal(mergeOverlay(newerTurn, hooks.overlayFor(transcript.sessionId), now).sessionEndedAt, null);
    hooks.ingest({ provider: 'claude', sessionId: transcript.sessionId, kind: 'SessionStart', ts: now });
    assert.equal(hooks.overlayFor(transcript.sessionId).sessionEndedAt, null);
    assert.equal(mergeOverlay(transcript, hooks.overlayFor(transcript.sessionId), now).sessionEndedAt, null);
    hooks.ingest({ provider: 'claude', sessionId: transcript.sessionId, kind: 'Stop', ts: now });
    assert.equal(hooks.overlayFor(transcript.sessionId).sessionEndedAt, null);
    hooks.ingest({ provider: 'claude', sessionId: transcript.sessionId, kind: 'SessionEnd', ts: now });
    now += HOOK_WAIT_RETENTION_MS;
    assert.equal(hooks.overlayFor(transcript.sessionId), null);
});

test('explicit session end immediately emits gate departure and one terminal Chronicle completion; resume re-arrives', async () => {
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => fixtureAt });
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    const removed = [];
    const unsubscribe = eventBus.on('agent:removed', agent => removed.push(agent));
    try {
        await log.flush();
        const session = liveSession();
        manager.handleWebSocketMessage({ sessions: [session] });
        const original = world.agents.get(session.sessionId);
        const ended = { ...session, sessionEndedAt: fixtureAt + 1, lastResults: parse().lastResults };
        manager.handleWebSocketMessage({ sessions: [ended] });
        assert.equal(world.agents.size, 0);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].sessionEndedAt, ended.sessionEndedAt);
        assert.deepEqual(removed[0].lastResults, ended.lastResults);
        manager.handleWebSocketMessage({ sessions: [ended] });
        assert.equal(world.agents.size, 0);
        assert.equal(removed.length, 1);
        await log.flush();
        const completion = store.rows.filter(row => row.kind === 'completed');
        assert.equal(completion.length, 1);
        assert.equal(completion[0].ts, ended.sessionEndedAt);
        assert.equal(store.rows.some(row => row.kind === 'departed'), false);
        manager.handleWebSocketMessage({ sessions: [{ ...session, turnStartedAt: fixtureAt + 2 }] });
        assert.equal(world.agents.size, 1);
        assert.notStrictEqual(world.agents.get(session.sessionId), original);
        assert.equal(world.agents.get(session.sessionId).sessionEndedAt, null);
        await log.flush();
        assert.equal(store.rows.filter(row => row.kind === 'arrived').length, 2);
    } finally {
        unsubscribe();
        manager.stop();
        await log.stop();
    }
});

test('an ended transcript at boot never creates a body; absence without end still uses grace', () => {
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => fixtureAt });
    try {
        manager.handleWebSocketMessage({ sessions: [{ ...liveSession(), sessionEndedAt: fixtureAt }] });
        assert.equal(world.agents.size, 0);
        manager.handleWebSocketMessage({ sessions: [liveSession()] });
        manager.handleWebSocketMessage({ sessions: [] });
        assert.equal(world.agents.size, 1);
        assert.equal(world.agents.get('omp-live').departedAt, fixtureAt);
    } finally {
        manager.stop();
    }
});

test('a session ending before Chronicle replay settles retains its arrival and terminal completion', async () => {
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => fixtureAt });
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    try {
        manager.handleWebSocketMessage({ sessions: [liveSession()] });
        manager.handleWebSocketMessage({ sessions: [{ ...liveSession(), sessionEndedAt: fixtureAt }] });
        await log.flush();
        assert.equal(store.rows.filter(row => row.kind === 'arrived').length, 1);
        assert.equal(store.rows.filter(row => row.kind === 'completed').length, 1);
        assert.equal(log._presentIds.has('omp-live'), false);
    } finally {
        manager.stop();
        await log.stop();
    }
});

test('Chronicle replay treats explicit session completion as removal, allowing a fresh arrival', async () => {
    const store = fakeStore();
    store.rows.push({ id: 'arrived', kind: 'arrived', agentId: 'omp-live', ts: fixtureAt - 1 },
        { id: 'ended', kind: 'completed', agentId: 'omp-live', ts: fixtureAt, sessionEndedAt: fixtureAt });
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => fixtureAt });
    const log = new ChronicleLog({ store }).start();
    try {
        await log.flush();
        manager.handleWebSocketMessage({ sessions: [liveSession()] });
        await log.flush();
        assert.equal(store.rows.filter(row => row.kind === 'arrived').length, 2);
    } finally {
        manager.stop();
        await log.stop();
    }
});
