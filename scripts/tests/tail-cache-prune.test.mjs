import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// SV-2: ended sessions leave the shared tail-state cache, live ones stay, and
// the LRU cap keeps working as the backstop. A small byte budget keeps the
// cap check cheap (the production default is 128 MB).
process.env.CLAUDEVILLE_TAIL_STATE_CACHE_MAX_BYTES = String(256 * 1024);
const require = createRequire(import.meta.url);
const {
  getTailCacheDiagnostics,
  pruneTailStates,
  readJsonLines,
  readTailLines,
} = require('../../claudeville/adapters/shared.js');

const dir = makeTempDir('claudeville-tail-prune-');
const maxAgeMs = 12 * 60 * 1000; // the active window plus the 10-minute grace
const minute = 60 * 1000;
const file = name => path.join(dir, name);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('stale tail states leave the cache and live ones survive', () => {
  fs.writeFileSync(file('live.jsonl'), 'live-0\nlive-1\nlive-2\n');
  fs.writeFileSync(file('live-appended.jsonl'), 'appended-0\nappended-1\n');
  fs.writeFileSync(file('ended.jsonl'), 'ended-0\nended-1\n');
  fs.writeFileSync(file('gone.jsonl'), 'gone-0\ngone-1\n');
  fs.writeFileSync(file('parsed.jsonl'), '{"id":1}\n{"id":2}\n{"id":3}\n');
  fs.writeFileSync(file('parsed-ended.jsonl'), '{"id":4}\n{"id":5}\n');

  const now = Date.now();
  const ago = minutes => new Date(now - minutes * minute);
  fs.utimesSync(file('live.jsonl'), ago(1), ago(1));
  fs.utimesSync(file('parsed.jsonl'), ago(1), ago(1));
  fs.utimesSync(file('live-appended.jsonl'), ago(30), ago(30));
  fs.utimesSync(file('ended.jsonl'), ago(30), ago(30));
  fs.utimesSync(file('gone.jsonl'), ago(30), ago(30));
  fs.utimesSync(file('parsed-ended.jsonl'), ago(30), ago(30));
  assert.deepEqual(readTailLines(file('live.jsonl'), 2), ['live-1', 'live-2']);
  assert.deepEqual(readTailLines(file('live-appended.jsonl'), 2), ['appended-0', 'appended-1']);
  assert.deepEqual(readTailLines(file('ended.jsonl'), 2), ['ended-0', 'ended-1']);
  assert.deepEqual(readTailLines(file('gone.jsonl'), 2), ['gone-0', 'gone-1']);
  assert.deepEqual(readJsonLines(file('parsed.jsonl'), { count: 3, source: 'prune-test' }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(readJsonLines(file('parsed-ended.jsonl'), { count: 2, source: 'prune-test' }), [{ id: 4 }, { id: 5 }]);

  // A live session that appended after its last read keeps a fresh file mtime
  // even though the cached entry still carries the old one.
  fs.appendFileSync(file('live-appended.jsonl'), 'appended-2\n');
  fs.rmSync(file('gone.jsonl'));

  const pruned = pruneTailStates(maxAgeMs);
  assert.equal(pruned, 3, 'the ended, parsed-ended and missing files leave');
  const diagnostics = getTailCacheDiagnostics();
  assert.equal(diagnostics.entries, 3, 'both live entries and the appended live entry stay');
  assert.equal(diagnostics.parsed.prunedEntries, 3);
  assert.deepEqual(readTailLines(file('live.jsonl'), 2), ['live-1', 'live-2']);
  const parsedBefore = getTailCacheDiagnostics().parsed.hits;
  assert.deepEqual(readJsonLines(file('parsed.jsonl'), { count: 3, source: 'prune-test' }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.ok(getTailCacheDiagnostics().parsed.hits > parsedBefore, 'a surviving entry still serves without re-reading');
  // A pruned file simply reads in full again; its re-created entry is still
  // stale, so the next prune drops exactly that one entry.
  assert.deepEqual(readTailLines(file('ended.jsonl'), 2), ['ended-0', 'ended-1']);
  assert.equal(pruneTailStates(maxAgeMs), 1, 'only the re-read stale entry leaves again');
});

test('the LRU cap still bounds the cache after pruning', () => {
  pruneTailStates(maxAgeMs);
  for (let index = 0; index < 4; index++) {
    const big = file(`pending-${index}.jsonl`);
    fs.writeFileSync(big, 'p'.repeat(150 * 1024));
    readTailLines(big, 1);
  }
  const diagnostics = getTailCacheDiagnostics();
  assert.ok(diagnostics.entries <= diagnostics.entryLimit, 'the entry cap holds');
  assert.ok(diagnostics.estimatedBytes <= diagnostics.byteLimit, 'the byte cap holds');
  pruneTailStates(maxAgeMs);
  const afterPrune = getTailCacheDiagnostics();
  assert.ok(afterPrune.estimatedBytes <= afterPrune.byteLimit, 'pruning never leaves the budget');
});
