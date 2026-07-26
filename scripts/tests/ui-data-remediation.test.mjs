import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../../claudeville/src/application/SessionWatcher.js';
import { truncateText } from '../../claudeville/src/presentation/shared/Formatters.js';
import {
    getModelVisualIdentity,
    providerBaseSpriteId,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

test('truncateText never exceeds its requested length', () => {
    const text = 'abcdefghijk';
    for (let max = 0; max <= 8; max++) {
        const value = truncateText(text, max);
        assert.ok(value.length <= max, `max ${max} returned ${value.length} characters`);
    }
    assert.equal(truncateText(text, 0), '');
    assert.equal(truncateText(text, 1), '…');
    assert.equal(truncateText(text, 5), 'abcd…');
    assert.equal(truncateText('short', 8), 'short');
});

test('unknown Gemini models use the same provider-base sprite as World mode', () => {
    assert.equal(providerBaseSpriteId('gemini-2.5-pro', 'gemini'), 'agent.gemini.base');
    assert.equal(
        getModelVisualIdentity('gemini-2.5-pro', null, 'gemini').spriteId,
        'agent.gemini.base',
    );
});

test('ClaudeDataSource preserves a failed session request as a rejection', async () => {
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    globalThis.window = { location: { origin: 'http://localhost:4000' } };
    globalThis.fetch = async () => {
        throw new Error('offline');
    };
    try {
        const { ClaudeDataSource } = await import(
            `../../claudeville/src/infrastructure/ClaudeDataSource.js?test=${Date.now()}`
        );
        await assert.rejects(() => new ClaudeDataSource().getSessions(), /offline/);
    } finally {
        globalThis.window = previousWindow;
        globalThis.fetch = previousFetch;
    }
});

test('failed session polls never reconcile an authoritative empty list', async () => {
    const messages = [];
    let sessionsMode = 'failure';
    const watcher = new SessionWatcher(
        { handleWebSocketMessage: message => messages.push(message) },
        { connect() {}, disconnect() {}, isConnected: false },
        {
            getSessions: async () => {
                if (sessionsMode === 'failure') throw new Error('offline');
                return sessionsMode;
            },
            getUsage: async () => null,
        },
    );
    watcher.running = true;
    const originalError = console.error;
    console.error = () => {};
    try {
        await watcher._runPoll(0, new AbortController().signal);
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(messages, []);

        sessionsMode = [{ sessionId: 'recovered' }];
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(messages, [{ sessions: [{ sessionId: 'recovered' }] }]);
    } finally {
        console.error = originalError;
        watcher.running = false;
    }
});
