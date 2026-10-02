import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSocketClient } from '../../claudeville/src/infrastructure/WebSocketClient.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const escape = id => id.replace(/~/g, '~0').replace(/\//g, '~1');

function harness(t) {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { protocol: 'http:', host: 'fixture.invalid' } };
    const client = new WebSocketClient();
    const updates = [];
    const resyncs = [];
    client.send = message => resyncs.push(message);
    const unsubscribe = eventBus.on('ws:update', message => updates.push(message));
    t.after(() => {
        unsubscribe();
        client.disconnect();
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });
    const delta = (patch, extra = {}) => client._handleMessage({
        type: 'update-delta', deltaVersion: 2,
        baseSeq: client._seq, seq: client._seq + 1, patch, ...extra,
    });
    return { client, updates, resyncs, delta };
}

test('v2 keyed patches reconstruct activity order without mutating retained snapshots', t => {
    const { client, updates, delta } = harness(t);
    const first = {
        sessionId: 'alpha/~beta',
        taskProgress: { done: 0, total: 2, source: 'exact' },
        tasks: [{ subject: 'First', status: 'pending' }],
        todos: [{ subject: 'Plan', status: 'pending' }],
    };
    const untouched = { sessionId: '__proto__', tokens: { input: 4 } };
    const initial = { type: 'init', seq: 1, sessions: [first, untouched], teams: [] };
    client._handleMessage(initial);
    const retained = structuredClone(initial);
    delta([
        { op: 'replace', path: `/sessionsById/${escape(first.sessionId)}/taskProgress/done`, value: 1 },
        { op: 'replace', path: `/sessionsById/${escape(first.sessionId)}/tasks/0/status`, value: 'completed' },
        { op: 'replace', path: `/sessionsById/${escape(first.sessionId)}/todos/0/status`, value: 'in_progress' },
        { op: 'replace', path: '/sessionOrder/0', value: untouched.sessionId },
        { op: 'replace', path: '/sessionOrder/1', value: first.sessionId },
    ]);
    const changed = updates.at(-1);
    assert.deepEqual(changed.sessions.map(session => session.sessionId), [untouched.sessionId, first.sessionId]);
    assert.equal(changed.sessions[0], untouched);
    assert.notEqual(changed.sessions[1], first);
    assert.equal(changed.sessions[1].taskProgress.done, 1);
    assert.equal(changed.sessions[1].tasks[0].status, 'completed');
    assert.equal(changed.sessions[1].todos[0].status, 'in_progress');
    assert.deepEqual(initial, retained);
    assert.deepEqual(changed.changes, { sessionIds: [first.sessionId], shared: false, order: true });
    assert.equal(Object.hasOwn(initial, 'changes'), false);

    const secondRetained = structuredClone(changed);
    delta([
        { op: 'add', path: '/sessionsById/new', value: { sessionId: 'new', status: 'active' } },
        { op: 'add', path: '/sessionOrder/1', value: 'new' },
        { op: 'remove', path: `/sessionsById/${escape(first.sessionId)}` },
        { op: 'remove', path: '/sessionOrder/2' },
    ]);
    assert.deepEqual(updates.at(-1).sessions.map(session => session.sessionId), [untouched.sessionId, 'new']);
    assert.equal(updates.at(-1).sessions[0], untouched);
    assert.deepEqual(updates.at(-1).changes, { sessionIds: ['new', first.sessionId], shared: false, order: true });
    assert.deepEqual(changed, secondRetained);
});

test('wholesale maps, wholesale order, shared roots and root replacement force full ingestion metadata', t => {
    const { client, updates, delta } = harness(t);
    const session = { sessionId: 'one' };
    client._rememberSnapshot({ seq: 1, sessions: [session] });
    const operations = [
        [{ op: 'replace', path: '/sessionsById', value: { one: session } }],
        [{ op: 'replace', path: '/sessionOrder', value: ['one'] }],
        [{ op: 'replace', path: '/teams', value: [] }],
        [{ op: 'replace', path: '/collisions', value: [] }],
        [{ op: 'replace', path: '/gitEventFields', value: ['type'] }],
        [{ op: 'replace', path: '/gitEventStringTables', value: [] }],
        [{ op: 'replace', path: '/gitEventsById', value: {} }],
        [{ op: 'replace', path: '/usage', value: { provider: 'claude' } }],
    ];
    for (const patch of operations) {
        delta(patch);
        assert.deepEqual(updates.at(-1).changes, { sessionIds: [], shared: true, order: false });
        assert.deepEqual(updates.at(-1).sessions, [session]);
    }
    delta([{ op: 'replace', path: '', value: {
        ...client._state, sessionsById: { replacement: { sessionId: 'replacement' } },
        sessionOrder: ['replacement'],
    } }]);
    assert.deepEqual(updates.at(-1).sessions, [{ sessionId: 'replacement' }]);
    assert.deepEqual(updates.at(-1).changes, { sessionIds: [], shared: true, order: false });
    delta([]);
    assert.deepEqual(updates.at(-1).changes, { sessionIds: [], shared: false, order: false });
});

test('missing ids and invalid patches leave the baseline intact and coalesce resync requests', t => {
    const { client, updates, resyncs, delta } = harness(t);
    const initial = { seq: 10, sessions: [{ sessionId: 'one', taskProgress: { done: 0 } }] };
    client._rememberSnapshot(initial);
    const retained = structuredClone(initial);
    delta([
        { op: 'replace', path: '/sessionsById/one/taskProgress/done', value: 1 },
        { op: 'replace', path: '/sessionOrder/0', value: 'missing' },
    ]);
    assert.equal(client._seq, 10);
    assert.equal(client.state.lastErrorCode, 'patch-failed');
    assert.deepEqual(initial, retained);
    delta([{ op: 'replace', path: '/sessionsById/absent/status', value: 'working' }]);
    delta([], { baseSeq: 9 });
    assert.deepEqual(resyncs, [{ type: 'resync' }]);
    assert.deepEqual(updates, []);

    client._handleMessage({ type: 'update', seq: 20, sessions: [{ sessionId: 'two' }] });
    assert.equal(Object.hasOwn(updates.at(-1), 'changes'), false);
    delta([{ op: 'add', path: '/sessionsById/two/status', value: 'working' }]);
    assert.equal(updates.at(-1).sessions[0].status, 'working');
    assert.equal(client._seq, 21);
    delta([], { baseSeq: 20 });
    assert.deepEqual(resyncs, [{ type: 'resync' }, { type: 'resync' }]);
});

test('incompatible deltas disable delta delivery once per connection without resyncing', t => {
    const previousWindow = globalThis.window;
    const previousWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 3;
        static instances = [];

        constructor() {
            this.readyState = FakeWebSocket.CONNECTING;
            this.sent = [];
            FakeWebSocket.instances.push(this);
        }

        open() {
            this.readyState = FakeWebSocket.OPEN;
            this.onopen?.();
        }

        message(data) {
            this.onmessage?.({ data: JSON.stringify(data) });
        }

        send(data) {
            this.sent.push(JSON.parse(data));
        }

        close() {
            this.readyState = FakeWebSocket.CLOSED;
        }
    }
    globalThis.window = { location: { protocol: 'http:', host: 'fixture.invalid' } };
    globalThis.WebSocket = FakeWebSocket;
    const client = new WebSocketClient();
    const updates = [];
    const unsubscribe = eventBus.on('ws:update', message => updates.push(message));
    t.after(() => {
        unsubscribe();
        client.disconnect();
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousWebSocket === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = previousWebSocket;
    });

    // A reconnect must advertise v2 again, then downgrade independently if needed.
    for (let connection = 0; connection < 2; connection++) {
        client.connect();
        const socket = FakeWebSocket.instances.at(-1);
        socket.open();
        socket.message({
            type: 'init', seq: 1,
            sessions: [{ sessionId: 'one', status: 'idle' }],
        });
        const oldDelta = {
            type: 'update-delta', baseSeq: 1, seq: 2,
            patch: [{ op: 'replace', path: '/sessions/0/status', value: 'working' }],
        };
        const updateCount = updates.length;
        socket.message(oldDelta);
        socket.message(oldDelta);
        assert.equal(updates.length, updateCount);
        assert.deepEqual(socket.sent, [
            { type: 'hello', deltas: true, deltaVersion: 2 },
            { type: 'hello', deltas: false },
        ]);

        const full = {
            type: 'update', seq: 3,
            sessions: [{ sessionId: 'one', status: 'working' }],
        };
        socket.message(full);
        assert.deepEqual(updates.at(-1), full);
        assert.equal(client.state.state, 'live');
        assert.equal(client.state.lastErrorCode, null);

        // Full snapshots must not reset the connection's one-shot downgrade.
        socket.message(oldDelta);
        socket.message({ ...oldDelta, deltaVersion: 1 });
        socket.message({ ...oldDelta, deltaVersion: 3 });
        const laterFull = {
            type: 'update', seq: 7,
            sessions: [{ sessionId: 'two', status: 'idle' }],
        };
        socket.message(laterFull);
        assert.deepEqual(updates.slice(updateCount), [full, laterFull]);
        assert.deepEqual(socket.sent, [
            { type: 'hello', deltas: true, deltaVersion: 2 },
            { type: 'hello', deltas: false },
        ]);
        client.disconnect();
    }
});

test('invalid full-roster ids preserve full delivery but cannot become a delta baseline', t => {
    const { client, updates, resyncs, delta } = harness(t);
    for (const sessions of [
        [{ sessionId: 'same' }, { sessionId: 'same' }],
        [{ sessionId: '' }],
        [{}],
    ]) {
        client._handleMessage({ type: 'update', seq: 1, sessions });
        assert.equal(updates.at(-1).sessions, sessions);
        delta([]);
        assert.equal(client.state.lastErrorCode, 'delta-baseline-mismatch');
    }
    assert.deepEqual(resyncs, [{ type: 'resync' }, { type: 'resync' }, { type: 'resync' }]);
});
