import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  parseJsonLines,
  readTailLines,
} = require('../../claudeville/adapters/shared.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeville-tail-cache-'));
const file = path.join(dir, 'session.jsonl');

try {
  const original = Array.from({ length: 6_000 }, (_, index) => `line-${index}`).join('\n') + '\n';
  fs.writeFileSync(file, original);

  assert.equal(readTailLines(file, 50).length, 50);
  assert.equal(readTailLines(file, 500).length, 500);
  assert.equal(readTailLines(file, 5_000).length, 5_000);
  assert.deepEqual(readTailLines(file, 2), ['line-5998', 'line-5999']);

  const afterOverlappingReads = getTailCacheDiagnostics();
  assert.equal(afterOverlappingReads.entries, 1, 'one file must retain one shared tail state');
  assert.ok(afterOverlappingReads.estimatedBytes <= afterOverlappingReads.byteLimit);

  fs.appendFileSync(file, 'line-6000\n');
  assert.deepEqual(readTailLines(file, 2), ['line-5999', 'line-6000']);

  fs.writeFileSync(file, 'rotated-0\nrotated-1\n');
  assert.deepEqual(readTailLines(file, 5), ['rotated-0', 'rotated-1']);

  fs.writeFileSync(file, 'alpha-\u{1F642}\nbeta-\u00e9\ngamma-\u03bb\n');
  assert.deepEqual(
    readTailLines(file, 3, { chunkBytes: 3, maxBytes: 1024 }),
    ['alpha-\u{1F642}', 'beta-\u00e9', 'gamma-\u03bb'],
    'backward chunk reads must preserve split UTF-8 code points',
  );

  const prefix = Buffer.from('partial-', 'utf8');
  const smile = Buffer.from('\u{1F642}', 'utf8');
  fs.writeFileSync(file, Buffer.concat([prefix, smile.subarray(0, 1)]));
  readTailLines(file, 1, { chunkBytes: 2, maxBytes: 1024 });
  fs.appendFileSync(file, Buffer.concat([smile.subarray(1), Buffer.from('\n')]));
  assert.deepEqual(
    readTailLines(file, 1, { chunkBytes: 2, maxBytes: 1024 }),
    ['partial-\u{1F642}'],
    'incremental polling must retain an incomplete UTF-8 suffix as bytes',
  );

  const boundaryFile = path.join(dir, 'tail-boundary.jsonl');
  fs.writeFileSync(boundaryFile, `${'x'.repeat(1024)}\n{"id":1}\n{"id":2}\n`);
  const boundedTail = readTailLines(boundaryFile, 10, { chunkBytes: 64, maxBytes: 128 });
  assert.deepEqual(parseJsonLines(boundedTail, { source: 'tail-boundary', file: boundaryFile }), [{ id: 1 }, { id: 2 }]);
  assert.equal(getJsonlDiagnostics()['tail-boundary'].skippedLines, 0,
    'a bounded tail must discard its truncated first line before JSON parsing');

  const exactBoundaryFile = path.join(dir, 'tail-exact-boundary.jsonl');
  const exactTail = '{"id":1}\n{"id":2}\n';
  fs.writeFileSync(exactBoundaryFile, `older\n${exactTail}`);
  assert.deepEqual(
    readTailLines(exactBoundaryFile, 10, { chunkBytes: 64, maxBytes: Buffer.byteLength(exactTail) }),
    ['{"id":1}', '{"id":2}'],
    'a bounded tail must retain the first record when its window starts exactly after a newline',
  );

  for (let index = 0; index < 9; index++) {
    const pendingFile = path.join(dir, `large-pending-${index}.jsonl`);
    fs.writeFileSync(pendingFile, 'p'.repeat(4 * 1024 * 1024));
    readTailLines(pendingFile, 1);
  }
  const afterLargePendingReads = getTailCacheDiagnostics();
  assert.ok(afterLargePendingReads.entries <= 8,
    'large incomplete records must be evicted by the shared byte budget');
  assert.ok(afterLargePendingReads.estimatedBytes <= afterLargePendingReads.byteLimit,
    'incomplete record buffers must be included in tail-cache byte accounting');

  console.log('tail cache smoke passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
