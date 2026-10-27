// The WebSocket client's own link truth: the resync watchdog (VB-8), the
// server identity handshake (EN-4) and link liveness (EN-2). Fake timers and a
// fake socket drive it; nothing here opens a network connection.

import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.closed = false;
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
        this.closed = true;
        this.readyState = FakeWebSocket.CLOSED;
    }
}

async function harness(t) {
    const saved = {
        window: globalThis.window,
        WebSocket: globalThis.WebSocket,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        dateNow: Date.now,
        random: Math.random,
        warn: console.warn,
        log: console.log,
    };
    let now = 1_800_000_000_000;
    const timers = [];
    const schedule = (callback, delay, repeat) => {
        const timer = { callback, delay, repeat, at: now + delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    globalThis.WebSocket = FakeWebSocket;
    globalThis.setTimeout = (callback, delay) => schedule(callback, delay, false);
    globalThis.setInterval = (callback, delay) => schedule(callback, delay, true);
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    globalThis.clearInterval = timer => { if (timer) timer.cleared = true; };
    Date.now = () => now;
    Math.random = () => 0;
    console.warn = () => {};
    console.log = () => {};
    FakeWebSocket.instances = [];

    const events = { state: [], serverChanged: [] };
    const unsubscribe = [
        eventBus.on('ws:state', payload => events.state.push(payload)),
        eventBus.on('ws:server-changed', payload => events.serverChanged.push(payload)),
    ];
    const { WebSocketClient } = await import(
        `../../claudeville/src/infrastructure/WebSocketClient.js?liveness=${Math.random()}-${timers.length}-${Date.now()}`
    );
    const client = new WebSocketClient();
    t.after(() => {
        client.disconnect();
        for (const off of unsubscribe) off();
        globalThis.window = saved.window;
        globalThis.WebSocket = saved.WebSocket;
        globalThis.setTimeout = saved.setTimeout;
        globalThis.clearTimeout = saved.clearTimeout;
        globalThis.setInterval = saved.setInterval;
        globalThis.clearInterval = saved.clearInterval;
        Date.now = saved.dateNow;
        Math.random = saved.random;
        console.warn = saved.warn;
        console.log = saved.log;
    });

    // Advance the fake clock, firing due timers in order (intervals re-arm).
    const advance = (ms) => {
        const until = now + ms;
        for (;;) {
            const due = timers
                .filter(timer => !timer.cleared && timer.at <= until)
                .sort((left, right) => left.at - right.at)[0];
            if (!due) break;
            now = due.at;
            if (due.repeat) due.at += due.delay;
            else due.cleared = true;
            due.callback();
        }
        now = until;
    };
    const connect = () => {
        client.connect();
        const socket = FakeWebSocket.instances.at(-1);
        socket.open();
        return socket;
    };
    const pending = (delay) => timers.filter(timer => !timer.cleared && timer.delay === delay);
    return { client, events, advance, connect, pending, timers, get now() { return now; } };
}

const identity = (version, bootId) => ({ version, bootId });

test('EN-4: the first server identity is remembered silently; a new one is announced once', async (t) => {
    const { events, connect } = await harness(t);
    const socket = connect();
    socket.message({ type: 'init', seq: 1, sessions: [], teams: [], server: identity('0.58.0', 'aaaa') });
    socket.message({ type: 'update', seq: 2, sessions: [], teams: [], server: identity('0.58.0', 'aaaa') });
    assert.deepEqual(events.serverChanged, []);

    // A restart with the same version (a dev restart): announced, versionChanged false.
    socket.message({ type: 'init', seq: 1, sessions: [], teams: [], server: identity('0.58.0', 'bbbb') });
    socket.message({ type: 'update', seq: 2, sessions: [], teams: [], server: identity('0.58.0', 'bbbb') });
    assert.equal(events.serverChanged.length, 1);
    assert.deepEqual(events.serverChanged[0], {
        from: identity('0.58.0', 'aaaa'),
        to: identity('0.58.0', 'bbbb'),
        versionChanged: false,
    });

    // An upgrade: compared with the code this page runs, not the last restart.
    socket.message({ type: 'init', seq: 1, sessions: [], teams: [], server: identity('0.60.0', 'cccc') });
    assert.equal(events.serverChanged.length, 2);
    assert.deepEqual(events.serverChanged[1].from, identity('0.58.0', 'aaaa'));
    assert.equal(events.serverChanged[1].versionChanged, true);

    // Frames from an older server carry no identity and are never a mismatch.
    socket.message({ type: 'update', seq: 3, sessions: [], teams: [] });
    socket.message({ type: 'update', seq: 4, sessions: [], teams: [], server: {} });
    assert.equal(events.serverChanged.length, 2);
});

test('VB-8: an unanswered resync is re-sent once, then the socket is dropped for a reconnect', async (t) => {
    const { client, advance, connect, pending } = await harness(t);
    const socket = connect();
    socket.message({ type: 'init', seq: 7, sessions: [], teams: [] });
    socket.message({ type: 'update-delta', deltaVersion: 2, baseSeq: 6, seq: 8, patch: [] });
    const resyncs = () => socket.sent.filter(message => message.type === 'resync').length;
    assert.equal(resyncs(), 1);
    assert.equal(pending(10_000).length, 1, 'a resync arms its reply watchdog');

    // Deltas keep failing while the request is outstanding; they never pile up requests.
    socket.message({ type: 'update-delta', deltaVersion: 2, baseSeq: 6, seq: 9, patch: [] });
    assert.equal(resyncs(), 1);

    advance(10_000);
    assert.equal(resyncs(), 2, 'the first miss re-sends the request');
    assert.equal(socket.closed, false);

    advance(10_000);
    assert.equal(socket.closed, true, 'the second miss drops the socket');
    assert.equal(client.ws, null);
    assert.equal(client.state.state, 'reconnecting');
    assert.equal(client.state.lastErrorCode, 'resync-timeout');
    assert.equal(pending(10_000).length, 0);
});

test('VB-8: a full snapshot answers the resync and disarms its watchdog', async (t) => {
    const { advance, connect, pending } = await harness(t);
    const socket = connect();
    socket.message({ type: 'init', seq: 7, sessions: [], teams: [] });
    socket.message({ type: 'update-delta', deltaVersion: 2, baseSeq: 6, seq: 8, patch: [] });
    assert.equal(pending(10_000).length, 1);
    socket.message({ type: 'init', seq: 9, sessions: [], teams: [], scanning: true });
    assert.equal(pending(10_000).length, 0);
    advance(60_000);
    assert.equal(socket.sent.filter(message => message.type === 'resync').length, 1);
    assert.equal(socket.closed, false);
});

test('VB-8: a server snapshot-error reconnects instead of waiting', async (t) => {
    const { client, connect } = await harness(t);
    const socket = connect();
    socket.message({ type: 'snapshot-error', code: 'snapshot-unavailable' });
    assert.equal(socket.closed, true);
    assert.equal(client.state.state, 'reconnecting');
    assert.equal(client.state.lastErrorCode, 'snapshot-unavailable');
});
