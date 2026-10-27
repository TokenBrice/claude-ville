import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// SV-5: a rescan that observes a session exactly as before keeps its
// freshness, so a delta never reports an unchanged villager as changed. A
// changed session is stamped anew, and a failed provider's sessions are
// retained (stale) counted from its last successful observation.
const require = createRequire(import.meta.url);

test('freshness carries over only while a session is observed unchanged', (t) => {
  const home = makeTempDir('claudeville-session-freshness-');
  const originalHome = process.env.HOME;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  process.env.HOME = home;
  process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const registry = require('../../claudeville/adapters/index.js');
  let rows = [
    { sessionId: 'steady', lastActivity: now, lastMessage: 'same', lastResults: [{ id: 'r1', tool: 'Bash', completedAt: now, source: 'transcript', exitCode: 0 }] },
    { sessionId: 'busy', lastActivity: now, lastMessage: 'first' },
  ];
  let fail = false;
  for (const adapter of registry.adapters) {
    adapter.isAvailable = () => adapter.provider === 'claude';
    adapter.getActiveSessions = () => {
      if (fail) throw new Error('read failed');
      return rows.map(row => ({ ...row, provider: 'claude', turnState: 'working' }));
    };
  }
  const scan = () => new Map(registry.getAllSessions(10 * 60 * 1000, { force: true }).map(session => [session.sessionId, session]));

  const first = scan();
  const t0 = now;
  assert.deepEqual(first.get('steady').freshness, { state: 'fresh', observedAt: t0, ageMs: 0 });

  now += 3_000;
  rows = rows.map(row => (row.sessionId === 'busy' ? { ...row, lastMessage: 'second' } : row));
  const second = scan();
  assert.equal(second.get('steady').freshness.observedAt, t0, 'an unchanged session keeps its first stamp');
  assert.deepEqual(second.get('steady').freshness, first.get('steady').freshness);
  assert.equal(second.get('busy').freshness.observedAt, now, 'a changed session is stamped anew');
  const lastSuccess = now;

  now += 5_000;
  fail = true;
  const failed = scan();
  for (const id of ['steady', 'busy']) {
    assert.equal(failed.get(id).freshness.state, 'stale');
    assert.equal(failed.get(id).freshness.observedAt, lastSuccess, 'stale sessions count from the last successful scan');
    assert.equal(failed.get(id).freshness.ageMs, 5_000);
  }

  now += 61_000;
  assert.equal(scan().size, 0, 'retention still ends one minute after the last successful scan');
  fail = false;
  now += 1_000;
  assert.deepEqual(scan().get('steady').freshness, { state: 'fresh', observedAt: now, ageMs: 0 }, 'a recovered provider stamps anew');
});
