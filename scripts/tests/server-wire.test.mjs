import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);

function applyPatch(document, patch) {
  let result = structuredClone(document);
  for (const operation of patch) {
    const parts = operation.path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (operation.path === '') {
      assert.notEqual(operation.op, 'remove');
      result = structuredClone(operation.value);
      continue;
    }
    let parent = result;
    for (const part of parts.slice(0, -1)) {
      assert.ok(Object.hasOwn(parent, part), `Missing patch parent ${part}`);
      parent = parent[part];
    }
    const key = parts.at(-1);
    if (Array.isArray(parent)) {
      const index = Number(key);
      assert.ok(Number.isInteger(index) && index >= 0);
      if (operation.op === 'remove') parent.splice(index, 1);
      else if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else parent[index] = structuredClone(operation.value);
    } else if (operation.op === 'remove') {
      delete parent[key];
    } else {
      Object.defineProperty(parent, key, { value: structuredClone(operation.value), configurable: true, enumerable: true, writable: true });
    }
  }
  return result;
}

function coreState(message) {
  const { sessions, gitEventFields, gitEventStringTables, gitEventsById, collisions, teams, usage } = message;
  return { sessions, gitEventFields, gitEventStringTables, gitEventsById, collisions, teams, usage };
}

function reconstruct(keyed) {
  const { sessionsById, sessionOrder, ...shared } = keyed;
  return { sessions: sessionOrder.map(id => {
    assert.ok(Object.hasOwn(sessionsById, id), `Missing keyed session ${id}`);
    return sessionsById[id];
  }), ...shared };
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

test('v2 keyed updates reconstruct the full roster and survive fresh resync baselines', async (t) => {
  const home = makeTempDir('claudeville-server-wire-');
  const originalHome = process.env.HOME;
  const originalGit = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  process.env.HOME = home;
  process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
  Date.now = () => now;
  const registry = require('../../claudeville/adapters/index.js');
  let rows = [
    { sessionId: 'claude-slash/id', lastActivity: now, lastMessage: 'first' },
    { sessionId: 'claude-tilde~id', lastActivity: now - 10, lastMessage: 'second' },
  ];
  for (const adapter of registry.adapters) {
    adapter.isAvailable = () => adapter.provider === 'claude';
    adapter.getActiveSessions = () => rows.map(row => ({ ...row, provider: 'claude', turnState: 'working' }));
    adapter.invalidateCachesForDirty = () => {};
  }
  registry.adapters.find(adapter => adapter.provider === 'claude').getTeams = () => [];
  const runtime = require('../../claudeville/server.js');
  const wire = runtime._wireTest;
  const modern = new Socket();
  const peer = new Socket();
  const legacy = new Socket();
  wire.wsClients.add(modern);
  wire.wsClients.add(peer);
  wire.wsClients.add(legacy);
  wire.handleTextMessage(modern, JSON.stringify({ type: 'hello', deltas: true, deltaVersion: 2 }));
  wire.handleTextMessage(peer, JSON.stringify({ type: 'hello', deltas: true, deltaVersion: 2 }));
  wire.handleTextMessage(legacy, JSON.stringify({ type: 'hello', deltas: true }));
  try {
    wire.sendInitialData(modern, { scanning: false });
    wire.sendInitialData(peer, { scanning: false });
    wire.sendInitialData(legacy, { scanning: false });
    wire.broadcastUpdate({ force: true, reason: 'test-baseline' });
    let previous = modern.messages.at(-1);
    let keyed = wire.keyedBroadcastState(coreState(previous));

    const update = (nextRows) => {
      rows = nextRows;
      now += 300;
      wire.markProviderDataDirty({ provider: 'claude', kind: 'transcript', reason: 'fixture-append' }, null, { coalesce: false });
      wire.broadcastUpdate({ force: true, reason: 'test-transition' });
      const message = modern.messages.at(-1);
      assert.deepEqual(peer.messages.at(-1), message);
      const full = legacy.messages.at(-1);
      assert.equal(full.type, 'update');
      assert.equal(full.seq, message.seq);
      assert.ok(message.seq > previous.seq);
      if (message.type === 'update-delta') {
        assert.equal(message.deltaVersion, 2);
        assert.equal(message.baseSeq, previous.seq);
        keyed = applyPatch(keyed, message.patch);
        assert.deepEqual(reconstruct(keyed), coreState(full));
      } else {
        assert.equal(message.type, 'update');
        assert.deepEqual(coreState(message), coreState(full));
        keyed = wire.keyedBroadcastState(coreState(full));
      }
      previous = message;
      return message;
    };

    await t.test('reordering edits order rather than replacing another identity', () => {
      const message = update([{ ...rows[1], lastActivity: now + 1, lastMessage: 'changed second' }, rows[0]]);
      assert.equal(message.type, 'update-delta');
      assert.ok(message.patch.some(op => op.path === '/sessionOrder/0'));
      assert.ok(message.patch.some(op => op.path === '/sessionsById/claude-tilde~0id/lastMessage'));
      assert.equal(message.patch.some(op => op.path.startsWith('/sessions/')), false);
    });

    await t.test('additions, removals and escaped identities preserve exact full content', () => {
      const message = update([{ ...rows[0], lastActivity: now + 1 }, { sessionId: 'claude-new/id~', lastActivity: now, lastMessage: 'new' }]);
      assert.equal(message.type, 'update-delta');
      assert.ok(message.patch.some(op => op.op === 'remove' && op.path === '/sessionsById/claude-slash~1id'));
      assert.ok(message.patch.some(op => op.op === 'add' && op.path === '/sessionsById/claude-new~1id~0'));
    });

    await t.test('fresh init collection replaces both baselines before the next delta', () => {
      rows = rows.map((row, index) => ({ ...row, lastMessage: `resync ${index}` }));
      now += 300;
      wire.markProviderDataDirty({ provider: 'claude', kind: 'transcript', reason: 'resync-append' }, null, { coalesce: false });
      wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
      const fresh = modern.messages.at(-1);
      assert.equal(fresh.type, 'init');
      assert.ok(fresh.seq > previous.seq);
      assert.equal(fresh.sessions[0].lastMessage, 'resync 0');
      assert.equal(fresh.scanning, false);
      assert.equal(fresh.staleAt, null);
      for (const recipient of [peer, legacy]) {
        const replacement = recipient.messages.at(-1);
        assert.equal(replacement.type, 'update');
        assert.equal(replacement.seq, fresh.seq);
        assert.deepEqual(coreState(replacement), coreState(fresh));
      }
      const framesAfterResync = modern.messages.length;
      wire.broadcastUpdate({ force: true, reason: 'unchanged-after-resync' });
      assert.equal(modern.messages.length, framesAfterResync, 'The fresh baseline must not trigger an unchanged update');
      previous = fresh;
      keyed = wire.keyedBroadcastState(coreState(fresh));
      const next = update(rows.map((row, index) => ({ ...row, lastMessage: `after resync ${index}` })));
      assert.equal(next.type, 'update-delta');
      assert.equal(next.baseSeq, fresh.seq);
    });

    await t.test('a fresh resync restarts an already-due full snapshot floor', () => {
      now += 20_000;
      wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
      const fresh = modern.messages.at(-1);
      assert.equal(fresh.type, 'init');
      assert.equal(fresh.scanning, false);
      assert.ok(fresh.seq > previous.seq);
      assert.equal(peer.messages.at(-1).type, 'update');
      assert.equal(peer.messages.at(-1).seq, fresh.seq);
      previous = fresh;
      keyed = wire.keyedBroadcastState(coreState(fresh));
      const next = update(rows.map((row, index) => ({ ...row, lastMessage: `new floor ${index}` })));
      assert.equal(next.type, 'update-delta');
      assert.equal(next.baseSeq, fresh.seq);
    });

    await t.test('an empty forced resync keeps the non-empty canonical roster and leaves peers untouched', () => {
      const preservedRows = rows;
      const baseline = coreState(legacy.messages.at(-1));
      const peerFrames = peer.messages.length;
      const legacyFrames = legacy.messages.length;
      rows = [];
      now += 300;
      wire.markProviderDataDirty({ provider: 'claude', kind: 'transcript', reason: 'temporarily-empty-resync' }, null, { coalesce: false });
      wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
      const stale = modern.messages.at(-1);
      assert.equal(stale.type, 'init');
      assert.equal(stale.seq, previous.seq);
      assert.deepEqual(coreState(stale), baseline);
      assert.equal(stale.scanning, true);
      assert.equal(peer.messages.length, peerFrames);
      assert.equal(legacy.messages.length, legacyFrames);
      rows = preservedRows.map(row => ({ ...row, lastMessage: 'recovered resync' }));
      now += 300;
      wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
      const recovered = modern.messages.at(-1);
      assert.equal(recovered.scanning, false);
      assert.ok(recovered.seq > stale.seq);
      assert.equal(recovered.sessions[0].lastMessage, 'recovered resync');
      previous = recovered;
      keyed = wire.keyedBroadcastState(coreState(recovered));
      const next = update(rows.map(row => ({ ...row, lastMessage: 'after recovered resync' })));
      assert.equal(next.type, 'update-delta');
      assert.equal(next.baseSeq, recovered.seq);
    });

    await t.test('a resync requested during a provider scan cannot replace the roster with an unavailable collect', () => {
      const adapter = registry.adapters.find(candidate => candidate.provider === 'claude');
      const collect = adapter.getActiveSessions;
      const baseline = coreState(legacy.messages.at(-1));
      const peerFrames = peer.messages.length;
      const baselineSeq = previous.seq;
      let stale;
      adapter.getActiveSessions = (...args) => {
        wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
        stale = modern.messages.at(-1);
        assert.equal(stale.type, 'init');
        assert.equal(stale.seq, baselineSeq);
        assert.deepEqual(coreState(stale), baseline);
        assert.equal(stale.scanning, true);
        assert.equal(peer.messages.length, peerFrames);
        return collect(...args);
      };
      try {
        const resumed = update(rows.map(row => ({ ...row, lastMessage: 'scan completed after resync' })));
        assert.ok(stale, 'The fixture must request resync while collection is in progress');
        assert.equal(resumed.type, 'update');
        assert.equal(resumed.scanning, false);
        assert.ok(resumed.seq > stale.seq);
        assert.equal(resumed.sessions[0].lastMessage, 'scan completed after resync');
      } finally {
        adapter.getActiveSessions = collect;
      }
    });

    await t.test('missing or duplicate identities force full and reestablish a safe baseline', () => {
      for (const invalidRows of [
        [{ lastActivity: now, lastMessage: 'missing' }],
        [{ sessionId: '', lastActivity: now, lastMessage: 'empty' }],
        [{ sessionId: 'duplicate', lastActivity: now }, { sessionId: 'duplicate', lastActivity: now - 1 }],
      ]) {
        assert.equal(update(invalidRows).type, 'update');
        assert.equal(keyed, null);
        assert.equal(update([{ sessionId: 'restored', lastActivity: now, lastMessage: 'valid' }]).type, 'update');
        assert.equal(update([{ ...rows[0], lastMessage: 'valid changed' }]).type, 'update-delta');
      }
    });

    await t.test('large patches and the 20-second floor fall back to full updates', () => {
      const detail = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`field${index}`, index]));
      update([{ sessionId: 'large', lastActivity: now, detail }]);
      const changed = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, value + 1]));
      assert.equal(update([{ sessionId: 'large', lastActivity: now, detail: changed }]).type, 'update');
      now += 20_000;
      assert.equal(update([{ ...rows[0], lastMessage: 'snapshot floor' }]).type, 'update');
    });

    await t.test('a patch below the operation limit still falls back to full when its encoding is larger', () => {
      const detail = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, index]));
      update([{ sessionId: 'patch-size', lastActivity: now, detail }]);
      const changed = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, value + 1]));
      const message = update([{ ...rows[0], detail: changed }]);
      assert.equal(message.type, 'update');
      assert.deepEqual(message.sessions[0].detail, changed);
    });

    await t.test('prototype-like identities remain ordinary keyed data', () => {
      const first = { ...coreState(legacy.messages.at(-1)), sessions: [{ sessionId: '__proto__', value: 1 }, { sessionId: 'constructor', value: 2 }] };
      const next = { ...first, sessions: [{ sessionId: 'constructor', value: 3 }, { sessionId: '__proto__', value: 4 }] };
      const patch = wire.createJsonPatch(wire.keyedBroadcastState(first), wire.keyedBroadcastState(next));
      assert.deepEqual(reconstruct(applyPatch(wire.keyedBroadcastState(first), patch)), next);
    });

    await t.test('unnegotiated and non-exact hello versions receive full updates only', () => {
      const unsupported = new Socket();
      wire.wsClients.add(unsupported);
      wire.sendInitialData(unsupported, { scanning: false });
      const hellos = [
        null,
        { type: 'hello', deltas: true, deltaVersion: 1 },
        { type: 'hello', deltas: true, deltaVersion: 3 },
        { type: 'hello', deltas: true, deltaVersion: '2' },
        { type: 'hello', deltas: false, deltaVersion: 2 },
      ];
      for (const [index, hello] of hellos.entries()) {
        if (hello) wire.handleTextMessage(unsupported, JSON.stringify(hello));
        assert.equal(update([{ ...rows[0], lastMessage: `unsupported hello ${index}` }]).type, 'update-delta');
        const message = unsupported.messages.at(-1);
        assert.equal(message.type, 'update');
        assert.deepEqual(coreState(message), coreState(legacy.messages.at(-1)));
      }
      assert.equal(unsupported.messages.some(message => message.type === 'update-delta'), false);
      wire.wsClients.delete(unsupported);
    });

    await t.test('EN-4: every full frame carries the server identity; deltas do not', () => {
      const identity = wire.SERVER_IDENTITY;
      const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(identity.version, pkg.version);
      assert.match(identity.bootId, /^[0-9a-f]{16}$/);
      const fulls = [...modern.messages, ...legacy.messages].filter(message => message.type === 'init' || message.type === 'update');
      assert.ok(fulls.some(message => message.type === 'init') && fulls.some(message => message.type === 'update'));
      for (const message of fulls) assert.deepEqual(message.server, identity);
      const deltas = modern.messages.filter(message => message.type === 'update-delta');
      assert.ok(deltas.length > 0);
      for (const message of deltas) assert.equal(Object.hasOwn(message, 'server'), false);
    });

    await t.test('VB-8: a resync whose fresh collection fails is answered with the retained baseline', () => {
      const adapter = registry.adapters.find(candidate => candidate.provider === 'claude');
      const getTeams = adapter.getTeams;
      const retained = legacy.messages.at(-1);
      const frames = modern.messages.length;
      const peerFrames = peer.messages.length;
      const warn = console.warn;
      adapter.getTeams = () => { throw new Error('teams unreadable'); };
      console.warn = () => {};
      try {
        wire.handleTextMessage(modern, JSON.stringify({ type: 'resync' }));
      } finally {
        adapter.getTeams = getTeams;
        console.warn = warn;
      }
      assert.equal(modern.messages.length, frames + 1, 'a failed resync is answered, not swallowed');
      const reply = modern.messages.at(-1);
      assert.equal(reply.type, 'init');
      assert.equal(reply.seq, retained.seq, 'the retained canonical sequence');
      assert.deepEqual(coreState(reply), coreState(retained));
      assert.equal(reply.scanning, true, 'the reply says it may be stale');
      assert.deepEqual(reply.server, wire.SERVER_IDENTITY);
      assert.equal(peer.messages.length, peerFrames, 'peers keep their baseline');
      previous = reply;
      keyed = wire.keyedBroadcastState(coreState(reply));
      const next = update(rows.map(row => ({ ...row, lastMessage: 'after a failed resync' })));
      assert.equal(next.type, 'update', 'the next broadcast is a full update');
      assert.equal(next.scanning, false);
      assert.equal(next.sessions[0].lastMessage, 'after a failed resync');
    });

    await t.test('EN-9: a heartbeat after a process pause refreshes every socket instead of closing it', () => {
      const sleeper = new Socket();
      wire.wsClients.add(sleeper);
      sleeper._cvLastSeen = now;
      wire.heartbeatTick(now);
      // The process slept 120 s: the next tick runs before any queued pong is read.
      const wake = now + 120_000;
      wire.heartbeatTick(wake);
      assert.equal(wire.wsClients.has(sleeper), true, 'a paused server must not stale-close its clients on wake');
      assert.equal(sleeper.writable, true);
      assert.equal(sleeper._cvLastSeen, wake);
      // Leave the shared sockets as they were: they keep no last-seen time.
      for (const socket of [modern, peer, legacy]) delete socket._cvLastSeen;
      // On-time ticks still close a client that stays silent past 90 s.
      for (const offset of [30_000, 60_000, 90_000]) {
        wire.heartbeatTick(wake + offset);
        assert.equal(wire.wsClients.has(sleeper), true, `still open ${offset / 1000}s after wake`);
      }
      wire.heartbeatTick(wake + 120_000);
      assert.equal(wire.wsClients.has(sleeper), false, 'a silent client is still closed after 90 s');
      assert.equal(sleeper.writable, false);
      for (const socket of [modern, peer, legacy]) assert.equal(wire.wsClients.has(socket), true);
    });

    assert.equal(legacy.messages.some(message => message.type === 'update-delta'), false);
  } finally {
    Date.now = originalNow;
    runtime.shutdownRuntime({ reason: 'wire-test', exitProcess: false });
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalGit === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT; else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = originalGit;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
