import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const ACTIVE_THRESHOLD_MS = 120_000;

function request(port, pathname, event = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: event ? 'POST' : 'GET',
      agent: false,
      headers: {
        host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-claudeville-ingest-token': process.env.CLAUDEVILLE_INGEST_TOKEN,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('Hook-cache request timed out')));
    req.end(event ? JSON.stringify(event) : undefined);
  });
}

class Socket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.destroyed = false;
    this.messages = [];
  }

  write(frame) {
    if ((frame[0] & 0xf) !== 1) return true;
    const marker = frame[1] & 0x7f;
    const offset = marker === 127 ? 10 : marker === 126 ? 4 : 2;
    this.messages.push(JSON.parse(frame.subarray(offset).toString('utf8')));
    return true;
  }

  end() { this.writable = false; }
  destroy() { this.destroyed = true; }
}

test('cached hook folds preserve provider freshness, transcript precedence and expiry', async (t) => {
  const home = makeTempDir('claudeville-server-hook-cache-');
  const originalHome = process.env.HOME;
  const originalGit = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  let now = 1_800_000_000_000;
  process.env.HOME = home;
  process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
  t.mock.method(Date, 'now', () => now);
  const registry = require('../../claudeville/adapters/index.js');
  const { hookOverlay, HOOK_MERGE_WINDOW_MS, HOOK_WAIT_RETENTION_MS } = require('../../claudeville/adapters/hooks.js');
  let row = { provider: 'claude', sessionId: 'claude-cache-session', lastActivity: now, turnState: 'working', lastMessage: 'original transcript' };
  for (const adapter of registry.adapters) {
    t.mock.method(adapter, 'isAvailable', () => adapter.provider === 'claude');
    t.mock.method(adapter, 'getActiveSessions', () => [{ ...row }]);
    if (typeof adapter.invalidateCachesForDirty === 'function') {
      t.mock.method(adapter, 'invalidateCachesForDirty', () => {});
    } else {
      adapter.invalidateCachesForDirty = () => {};
      t.after(() => { delete adapter.invalidateCachesForDirty; });
    }
  }
  const collect = (options) => registry.getAllSessions(ACTIVE_THRESHOLD_MS, options)[0];
  const ingest = (kind) => hookOverlay.ingest({ provider: 'claude', sessionId: 'cache-session', kind, tool: 'Bash', input: { command: 'npm test token=secret' } });
  try {
    await t.test('an overlay crossing the list TTL changes lifecycle but not observation freshness', () => {
      const original = collect({ force: true });
      now += 2_500;
      ingest('PreToolUse');
      row = { ...row, lastMessage: 'not scanned yet' };
      const hooked = collect({ overlayOnly: true });
      assert.equal(hooked.turnState, 'tool_pending');
      assert.equal(hooked.signalSource, 'hook');
      assert.equal(hooked.promptDetail, 'npm test token=[REDACTED]');
      assert.equal(hooked.lastMessage, 'original transcript');
      assert.deepEqual(hooked.freshness, original.freshness);
      const reconciled = collect();
      assert.equal(reconciled.lastMessage, 'not scanned yet', 'Overlay folds must not renew the provider cache TTL');
      assert.equal(reconciled.freshness.observedAt, now);
    });

    await t.test('merge-window expiry restores the unoverlaid cached transcript', () => {
      const beforeExpiry = collect({ overlayOnly: true });
      assert.equal(beforeExpiry.turnState, 'tool_pending');
      now += HOOK_MERGE_WINDOW_MS;
      const expired = collect({ overlayOnly: true });
      assert.equal(expired.turnState, 'working');
      assert.equal(expired.signalSource, 'transcript');
      assert.equal(expired.pendingTool, null);
      assert.deepEqual(expired.freshness, beforeExpiry.freshness);
    });

    await t.test('approval remains stale until its existing bounded retention expires', () => {
      ingest('PermissionRequest');
      const approved = collect({ overlayOnly: true });
      assert.equal(approved.waitReason, 'approval');
      now += HOOK_MERGE_WINDOW_MS;
      const stale = collect({ overlayOnly: true });
      assert.equal(stale.waitReason, 'approval');
      assert.equal(stale.signalStale, true);
      assert.deepEqual(stale.freshness, approved.freshness);
      now += HOOK_WAIT_RETENTION_MS - HOOK_MERGE_WINDOW_MS;
      const expired = collect({ overlayOnly: true });
      assert.equal(expired.signalSource, 'transcript');
      assert.equal(expired.waitReason, null);
      assert.deepEqual(expired.freshness, approved.freshness);
    });

    await t.test('filesystem dirtiness wins over overlay-only collection and closes a resolved wait', () => {
      ingest('PermissionRequest');
      assert.equal(collect({ overlayOnly: true }).waitReason, 'approval');
      now += 10;
      row = { ...row, turnState: 'awaiting_input', awaitingSince: now, lastActivity: now, lastMessage: 'tool resolved' };
      registry.invalidateSessionCaches({ provider: 'claude', dirty: { kind: 'transcript', sessionId: row.sessionId } });
      const resolved = collect({ overlayOnly: true });
      assert.equal(resolved.turnState, 'awaiting_input');
      assert.equal(resolved.signalSource, 'transcript');
      assert.equal(resolved.waitReason, null);
      assert.equal(resolved.lastMessage, 'tool resolved');
      assert.equal(resolved.freshness.observedAt, now);
    });

    await t.test('a reconciliation still replaces cached provider observations', () => {
      now += 30_000;
      row = { ...row, lastMessage: 'reconciled transcript', lastActivity: now };
      registry.invalidateSessionCaches({ dirty: { kind: 'reconcile' } });
      const refreshed = collect({ overlayOnly: true });
      assert.equal(refreshed.lastMessage, 'reconciled transcript');
      assert.equal(refreshed.freshness.observedAt, now);
    });

    await t.test('HTTP hooks reach REST and WebSocket immediately while transcript reconciliation is backed off', async (tt) => {
      tt.mock.timers.enable({ apis: ['setTimeout'] });
      const originalToken = process.env.CLAUDEVILLE_INGEST_TOKEN;
      process.env.CLAUDEVILLE_INGEST_TOKEN = 'hook-cache-fixture';
      let runtime;
      let server;
      let socket;
      tt.after(async () => {
        try {
          const closed = server?.listening ? once(server, 'close') : null;
          runtime?.shutdownRuntime({ reason: 'hook-cache-http-test', exitProcess: false });
          server?.closeAllConnections();
          if (closed) await closed;
        } finally {
          if (socket) {
            runtime?._wireTest.wsClients.delete(socket);
            socket.destroy();
          }
          tt.mock.timers.reset();
          tt.mock.restoreAll();
          if (originalToken === undefined) delete process.env.CLAUDEVILLE_INGEST_TOKEN; else process.env.CLAUDEVILLE_INGEST_TOKEN = originalToken;
        }
      });
      let liveRows = ['codex', 'gemini'].map(provider => ({
        provider,
        sessionId: `${provider}-http-hook-session`,
        sourceSessionId: 'http-hook-session',
        lastActivity: now,
        turnState: 'working',
        lastMessage: `HTTP original ${provider}`,
      }));
      let adapterPasses = 0;
      let adapterInvalidations = 0;
      for (const adapter of registry.adapters) {
        tt.mock.method(adapter, 'isAvailable', () => ['codex', 'gemini'].includes(adapter.provider));
        tt.mock.method(adapter, 'getActiveSessions', () => {
          adapterPasses++;
          return liveRows.filter(session => session.provider === adapter.provider).map(session => ({ ...session }));
        });
        tt.mock.method(adapter, 'invalidateCachesForDirty', () => { adapterInvalidations++; });
        tt.mock.method(adapter, 'getWatchPaths', () => []);
      }
      tt.mock.method(registry.adapters.find(adapter => adapter.provider === 'claude'), 'getTeams', () => []);
      registry.invalidateSessionCaches({ dirty: { kind: 'reconcile' } });
      runtime = require('../../claudeville/server.js');
      const wire = runtime._wireTest;
      const listen = http.Server.prototype.listen;
      try {
        // Exercise the real HTTP routes on an ephemeral loopback listener.
        http.Server.prototype.listen = function (...args) {
          if (args[0] === 4000) args[0] = 0;
          return listen.apply(this, args);
        };
        server = runtime.startServer();
      } finally {
        http.Server.prototype.listen = listen;
      }
      {
        await new Promise((resolve, reject) => {
          server.once('listening', resolve);
          server.once('error', reject);
        });
        const port = server.address().port;
        assert.notEqual(port, 4000);
        const get = async (pathname) => {
          const response = await request(port, pathname);
          assert.equal(response.status, 200);
          return response.payload;
        };
        const hook = async (provider, kind) => {
          now++;
          const response = await request(port, '/api/ingest/hook', {
            provider, sessionId: 'http-hook-session', kind, tool: 'Bash',
          });
          assert.equal(response.status, 202);
        };
        const find = (payload, provider) => payload.sessions.find(session => session.provider === provider);
        const original = await get('/api/sessions');
        socket = new Socket();
        wire.wsClients.add(socket);
        wire.sendInitialData(socket, { scanning: false });
        wire.broadcastUpdate({ force: true, reason: 'http-hook-baseline' });
        const beforeOverlay = { adapterPasses, adapterInvalidations };

        await hook('codex', 'PermissionRequest');
        tt.mock.timers.tick(0);
        const approved = await get('/api/sessions');
        assert.equal(find(approved, 'codex').waitReason, 'approval');
        assert.equal(find(approved, 'gemini').waitReason, null);
        assert.equal(approved.scanning, false);
        assert.deepEqual(find(approved, 'codex').freshness, find(original, 'codex').freshness);
        wire.broadcastUpdate({ reason: 'http-hook-approval' });
        assert.equal(find(socket.messages.at(-1), 'codex').waitReason, 'approval');

        await hook('codex', 'PostToolUse');
        tt.mock.timers.tick(0);
        const resolved = await get('/api/sessions');
        assert.equal(find(resolved, 'codex').waitReason, null);
        wire.broadcastUpdate({ reason: 'http-hook-resolution' });
        assert.equal(find(socket.messages.at(-1), 'codex').waitReason, null);
        assert.equal(adapterPasses - beforeOverlay.adapterPasses, 0);
        assert.equal(adapterInvalidations - beforeOverlay.adapterInvalidations, 0);

        // Match the first-WebSocket reconciliation: its transcript timer is
        // pending, but hooks must reach both browser surfaces without delay.
        wire.markProviderDataDirty({ kind: 'reconcile', reason: 'first-websocket-client' }, null, { coalesce: false });
        wire.broadcastUpdate({ reason: 'pending-transcript-reconciliation' });
        const pending = (await get('/api/perf')).dirty;
        assert.ok(pending.nextScanAt > now);
        const beforeDeferredOverlay = { adapterPasses, adapterInvalidations };
        liveRows = liveRows.map(session => ({
          ...session,
          turnState: 'awaiting_input',
          awaitingSince: now + 300,
          lastActivity: now + 300,
          lastMessage: 'resolved transcript after deferred scan',
        }));
        await hook('codex', 'PermissionRequest');
        const framesBeforeDeferredHook = socket.messages.length;
        tt.mock.timers.tick(0);
        assert.equal(socket.messages.length, framesBeforeDeferredHook + 1);
        const broadcastApproved = socket.messages.at(-1);
        assert.equal(find(broadcastApproved, 'codex').waitReason, 'approval');
        assert.equal(find(broadcastApproved, 'codex').lastMessage, 'HTTP original codex');
        assert.equal(broadcastApproved.scanning, true);
        assert.deepEqual(find(broadcastApproved, 'codex').freshness, find(original, 'codex').freshness);
        assert.ok(now < pending.nextScanAt, 'Hook delivery must precede the transcript backoff');
        const staleApproved = await get('/api/sessions');
        assert.equal(find(staleApproved, 'codex').waitReason, 'approval');
        assert.equal(find(staleApproved, 'codex').lastMessage, 'HTTP original codex');
        assert.equal(staleApproved.scanning, true);
        assert.equal(staleApproved.staleAt, pending.staleAt);
        assert.deepEqual(find(staleApproved, 'codex').freshness, find(original, 'codex').freshness);
        await hook('gemini', 'PermissionRequest');
        tt.mock.timers.tick(0);
        assert.equal(find(socket.messages.at(-1), 'gemini').waitReason, 'approval');
        const bothApproved = await get('/api/sessions');
        assert.equal(find(bothApproved, 'codex').waitReason, 'approval');
        assert.equal(find(bothApproved, 'gemini').waitReason, 'approval');
        await hook('codex', 'PostToolUse');
        tt.mock.timers.tick(0);
        assert.equal(find(socket.messages.at(-1), 'codex').waitReason, null);
        assert.equal(find(socket.messages.at(-1), 'gemini').waitReason, 'approval');
        const staleResolved = await get('/api/sessions');
        assert.equal(find(staleResolved, 'codex').waitReason, null);
        assert.equal(find(staleResolved, 'gemini').waitReason, 'approval');
        assert.equal(adapterPasses - beforeDeferredOverlay.adapterPasses, 0);
        assert.equal(adapterInvalidations - beforeDeferredOverlay.adapterInvalidations, 0);
        const stillPending = (await get('/api/perf')).dirty;
        assert.equal(stillPending.providerDataDirty, true);
        assert.equal(stillPending.nextScanAt, pending.nextScanAt);
        assert.equal(stillPending.snapshotGeneration, pending.snapshotGeneration);
        assert.ok(stillPending.generation > stillPending.snapshotGeneration);

        now += 300;
        tt.mock.timers.tick(300);
        const reconciled = await get('/api/sessions');
        assert.equal(reconciled.scanning, false);
        for (const provider of ['codex', 'gemini']) {
          assert.equal(find(reconciled, provider).waitReason, null);
          assert.equal(find(reconciled, provider).signalSource, 'transcript');
          assert.equal(find(reconciled, provider).lastMessage, 'resolved transcript after deferred scan');
          assert.equal(find(reconciled, provider).freshness.observedAt, now);
          assert.equal(find(socket.messages.at(-1), provider).waitReason, null);
        }
        assert.ok(adapterPasses > beforeDeferredOverlay.adapterPasses, 'The deferred provider pass must still run');
      }
    });
  } finally {
    t.mock.restoreAll();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalGit === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT; else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = originalGit;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
