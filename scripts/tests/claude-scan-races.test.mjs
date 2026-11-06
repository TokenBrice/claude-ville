import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// Regression tests for the SV-1 settle() commit rule: an async transcript
// scan that raced a producer — a truncation that ends the stream early, or a
// rewrite of bytes the scan had already read or inherited — must be
// discarded so the next poll rescans, never committed as if the file had
// only grown. A small async threshold keeps the fixtures kilobytes instead
// of the 8 MiB production default.
const tmpHome = makeTempDir('claudeville-scan-races-');
const previousHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
process.env.CLAUDEVILLE_TRANSCRIPT_ASYNC_THRESHOLD_BYTES = String(64 * 1024);
const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');

const stamp = new Date().toISOString();
const project = path.join(tmpHome, 'workspace', 'race');
const projectDir = path.join(tmpHome, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projectDir, { recursive: true });
const adapter = new ClaudeAdapter();
test.after(() => {
  adapter.shutdown();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const usageLine = (sessionId, value) => JSON.stringify({
  type: 'assistant',
  sessionId,
  uuid: `usage-${value}`,
  timestamp: stamp,
  cwd: project,
  message: { role: 'assistant', usage: { input_tokens: value, output_tokens: 1 }, content: [] },
});
const paddingLines = count => Array.from({ length: count }, (_, index) => JSON.stringify({
  type: 'progress',
  data: `${index}`.padStart(8, '0') + 'x'.repeat(1024),
}));
const content = lines => lines.join('\n') + '\n';
const transcript = sessionId => path.join(projectDir, `${sessionId}.jsonl`);
const stats = () => ({ ...adapter.getPerfStats().transcriptAggregate });

async function settleScans() {
  const deadline = Date.now() + 30_000;
  while (adapter.getPerfStats().transcriptAggregate.pending > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(adapter.getPerfStats().transcriptAggregate.pending, 0, 'the async scans must settle');
}

// Reads one transcript through the adapter with fs.createReadStream wrapped,
// so the mutation can race the async scan the way a live producer would.
async function raceScan(sessionId, mutate) {
  const file = transcript(sessionId);
  assert.ok(fs.statSync(file).size > 64 * 1024, 'the transcript must exceed the async threshold');
  const originalCreateReadStream = fs.createReadStream;
  let intercepted = false;
  try {
    fs.createReadStream = (filename, options) => {
      const stream = originalCreateReadStream(filename, options);
      if (filename === file && !intercepted) {
        intercepted = true;
        mutate(stream, file);
      }
      return stream;
    };
    adapter.getSessionDetail(sessionId, project);
    await settleScans();
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
}

test('a stream that ends early on a truncated file never commits', async () => {
  const sessionId = 'short-read';
  fs.writeFileSync(transcript(sessionId), content([usageLine(sessionId, 10), ...paddingLines(300)]));
  const before = stats();
  await raceScan(sessionId, (stream, file) => {
    // The file empties before the stream opens, so the scan of [0, size)
    // reads zero bytes and ends without an error; the producer then regrows
    // past the original size before settle stats the file.
    fs.truncateSync(file, 0);
    stream.prependOnceListener('end', () => {
      fs.writeFileSync(file, content([usageLine(sessionId, 10), ...paddingLines(300), usageLine(sessionId, 7)]));
    });
  });
  assert.equal(stats().staleAsyncScans - before.staleAsyncScans, 1, 'the short read is discarded');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 0, 'nothing commits');
  adapter.getSessionDetail(sessionId, project);
  await settleScans();
  const detail = adapter.getSessionDetail(sessionId, project);
  assert.equal(detail.tokenUsage.totalInput, 17, 'the regrown transcript is scanned in full: 10 + 7');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 1, 'exactly the recovery scan commits');
});

test('a rewritten base guard during an async append discards the scan', async () => {
  const sessionId = 'append-rewrite';
  fs.writeFileSync(transcript(sessionId), content([usageLine(sessionId, 10)]));
  assert.equal(adapter.getSessionDetail(sessionId, project).tokenUsage.totalInput, 10,
    'the small base scans synchronously');
  fs.appendFileSync(transcript(sessionId), content(paddingLines(300)));
  const before = stats();
  const oldLine = usageLine(sessionId, 10);
  const newLine = usageLine(sessionId, 90);
  assert.equal(Buffer.byteLength(newLine), Buffer.byteLength(oldLine),
    'same-length records keep every later offset stable');
  await raceScan(sessionId, (stream, file) => {
    stream.prependOnceListener('end', () => {
      // The guarded base (the first record) is rewritten in place while the
      // append scan streams the padding, then one more record is appended.
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, Buffer.from(newLine), 0, Buffer.byteLength(newLine), 0);
      fs.closeSync(fd);
      fs.appendFileSync(file, content([usageLine(sessionId, 7)]));
    });
  });
  assert.equal(stats().staleAsyncScans - before.staleAsyncScans, 1, 'the scan of a rewritten base is discarded');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 0, 'the stale base never commits');
  adapter.getSessionDetail(sessionId, project);
  await settleScans();
  const detail = adapter.getSessionDetail(sessionId, project);
  assert.equal(detail.tokenUsage.totalInput, 97, 'the rewritten transcript is scanned in full: 90 + 7');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 1, 'exactly the recovery scan commits');
});

test('a head rewrite that raced a full scan does not commit', async () => {
  const sessionId = 'head-rewrite';
  fs.writeFileSync(transcript(sessionId), content([usageLine(sessionId, 10), ...paddingLines(300)]));
  const before = stats();
  await raceScan(sessionId, (stream, file) => {
    stream.prependOnceListener('end', () => {
      fs.writeFileSync(file, content([usageLine(sessionId, 90), ...paddingLines(300), usageLine(sessionId, 7)]));
    });
  });
  assert.equal(stats().staleAsyncScans - before.staleAsyncScans, 1, 'the scan of replaced head bytes is discarded');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 0, 'nothing commits');
  adapter.getSessionDetail(sessionId, project);
  await settleScans();
  const detail = adapter.getSessionDetail(sessionId, project);
  assert.equal(detail.tokenUsage.totalInput, 97, 'the rewritten transcript is scanned in full: 90 + 7');
});

test('a short first chunk followed by a head rewrite does not commit', async () => {
  const sessionId = 'short-head';
  const original = content([usageLine(sessionId, 10), ...paddingLines(300)]);
  fs.writeFileSync(transcript(sessionId), original);
  const before = stats();
  await raceScan(sessionId, (stream, file) => {
    // The producer truncates to one byte before the stream reads, then
    // regrows the file on the first chunk: the stream still receives the
    // whole requested range, but its first chunk carries a single byte.
    fs.truncateSync(file, 1);
    stream.prependOnceListener('data', () => {
      fs.writeFileSync(file, original);
    });
    stream.prependOnceListener('end', () => {
      // A same-length rewrite lands inside the 256-byte head window without
      // touching its first byte, and one more record is appended.
      fs.writeFileSync(file, content([usageLine(sessionId, 90), ...paddingLines(300), usageLine(sessionId, 7)]));
    });
  });
  assert.equal(stats().staleAsyncScans - before.staleAsyncScans, 1, 'the scan behind the head rewrite is discarded');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 0, 'nothing commits');
  adapter.getSessionDetail(sessionId, project);
  await settleScans();
  const detail = adapter.getSessionDetail(sessionId, project);
  assert.equal(detail.tokenUsage.totalInput, 97, 'the rewritten transcript is scanned in full: 90 + 7');
});

test('a rewrite inside the scanned tail window does not commit', async () => {
  const sessionId = 'tail-rewrite';
  const paddings = paddingLines(300);
  fs.writeFileSync(transcript(sessionId), content([usageLine(sessionId, 10), ...paddings]));
  const before = stats();
  await raceScan(sessionId, (stream, file) => {
    stream.prependOnceListener('end', () => {
      const rewritten = paddings.slice();
      rewritten[299] = rewritten[299].replaceAll('x', 'y');
      fs.writeFileSync(file, content([usageLine(sessionId, 10), ...rewritten, usageLine(sessionId, 7)]));
    });
  });
  assert.equal(stats().staleAsyncScans - before.staleAsyncScans, 1, 'the scan behind a moved boundary is discarded');
  assert.equal(stats().asyncCompletions - before.asyncCompletions, 0, 'nothing commits');
  adapter.getSessionDetail(sessionId, project);
  await settleScans();
  const detail = adapter.getSessionDetail(sessionId, project);
  assert.equal(detail.tokenUsage.totalInput, 17, 'the rewritten transcript is scanned in full: 10 + 7');
});
