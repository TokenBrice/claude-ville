import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// SV-1 / SV-13: a Claude rescan costs what changed. An unchanged rescan of
// twenty 1 MB transcript tails reads nothing and finishes well under 100 ms;
// an append reads (and parses) only the appended bytes. The memo behind it
// must still see every input that lives outside the file.
const tmpHome = makeTempDir('claudeville-scan-budget-');
const previousHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
const { getTailCacheDiagnostics } = require('../../claudeville/adapters/shared.js');
const gitEvents = require('../../claudeville/adapters/gitEvents.js');

const SESSIONS = 20;
const PAIRS = 400; // about 1 MB per transcript
const thresholdMs = 10 * 60 * 1000;
const project = path.join(tmpHome, 'workspace', 'fleet');
const projectDir = path.join(tmpHome, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
const loose = path.join(tmpHome, 'loose');
const commands = ['npm test', 'rg -n foo src', 'git status', 'ls -la', 'node scripts/x.mjs', 'git commit -m "wip"', 'git push origin main'];
const sessionId = index => `${String(index).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const transcript = index => path.join(projectDir, `${sessionId(index)}.jsonl`);
const isoAgo = ms => new Date(Date.now() - ms).toISOString();

function pair(index, step, { cwd = project, command = commands[step % commands.length], output = 'ok '.repeat(300) } = {}) {
  const id = `toolu_${index}_${step}`;
  const timestamp = isoAgo(Math.max(0, (PAIRS - step) * 40));
  return [
    { type: 'assistant', sessionId: sessionId(index), uuid: `a-${index}-${step}`, timestamp, cwd, message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'run' } }] } },
    { type: 'user', sessionId: sessionId(index), uuid: `u-${index}-${step}`, timestamp, cwd, toolUseResult: { stdout: output, stderr: '' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] } },
  ];
}
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

fs.mkdirSync(path.join(project, '.git', 'refs', 'heads'), { recursive: true });
fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.mkdirSync(loose, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const history = [];
for (let index = 0; index < SESSIONS; index++) {
  const rows = [];
  for (let step = 0; step < PAIRS; step++) rows.push(...pair(index, step));
  fs.writeFileSync(transcript(index), jsonl(rows));
  history.push({ display: 'x', timestamp: Date.now(), project, sessionId: sessionId(index) });
}
fs.writeFileSync(path.join(tmpHome, '.claude', 'history.jsonl'), jsonl(history));

const adapter = new ClaudeAdapter();
test.after(() => {
  adapter.shutdown();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function scan() {
  const before = { ...getTailCacheDiagnostics().parsed };
  const aggregateBefore = adapter.getPerfStats().transcriptAggregate.bytesRead;
  const started = process.hrtime.bigint();
  const sessions = adapter.getActiveSessions(thresholdMs);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const after = getTailCacheDiagnostics().parsed;
  return {
    sessions,
    ms,
    tailBytes: after.bytesRead - before.bytesRead,
    headBytes: after.headBytesRead - before.headBytesRead,
    parsedLines: after.parsedLines - before.parsedLines,
    aggregateBytes: adapter.getPerfStats().transcriptAggregate.bytesRead - aggregateBefore,
  };
}
const byId = (sessions, id) => sessions.find(session => session.sessionId === id);
const append = (index, rows) => {
  const text = jsonl(rows);
  fs.appendFileSync(transcript(index), text);
  return Buffer.byteLength(text);
};

test('an unchanged rescan of twenty 1 MB tails reads nothing and stays under 100 ms', () => {
  assert.ok(fs.statSync(transcript(0)).size > 900 * 1024, 'each transcript is about 1 MB');
  const cold = scan();
  assert.equal(cold.sessions.length, SESSIONS);
  assert.ok(cold.tailBytes > SESSIONS * 900 * 1024, 'the cold scan reads every tail once');
  scan();
  const times = [];
  for (let round = 0; round < 3; round++) {
    const warm = scan();
    assert.equal(warm.sessions.length, SESSIONS);
    assert.equal(warm.tailBytes, 0, 'an unchanged rescan reads no tail bytes');
    assert.equal(warm.headBytes, 0);
    assert.equal(warm.aggregateBytes, 0);
    assert.equal(warm.parsedLines, 0, 'an unchanged rescan parses no line');
    times.push(warm.ms);
  }
  assert.ok(Math.min(...times) < 100, `unchanged rescans took ${times.map(ms => ms.toFixed(1)).join(', ')} ms`);
  assert.deepEqual(JSON.parse(JSON.stringify(scan().sessions.map(({ dialogue, ...session }) => session))),
    JSON.parse(JSON.stringify(cold.sessions.map(({ dialogue, ...session }) => session))),
    'memoized sessions match the cold derivation');
});

test('an append reads and parses only the appended bytes, and its result is seen', () => {
  scan();
  const appended = append(3, pair(3, PAIRS, { command: 'npm run lint' }));
  const next = scan();
  assert.ok(next.tailBytes <= appended + 256, `read ${next.tailBytes} tail bytes for a ${appended}-byte append`);
  assert.ok(next.aggregateBytes <= appended, `read ${next.aggregateBytes} aggregate bytes for a ${appended}-byte append`);
  assert.equal(next.parsedLines, 2, 'only the two appended records are parsed');
  assert.equal(next.headBytes, 0);
  const results = byId(next.sessions, sessionId(3)).lastResults;
  assert.equal(results[0].id, `claude:${sessionId(3)}:toolu_3_${PAIRS}`, 'the new result leads lastResults');
  assert.equal(results[0].detail, 'npm run lint');
  assert.equal(scan().tailBytes, 0, 'and the next rescan is free again');
});

test('a git event whose repository was unresolved is resolved once the repository exists', () => {
  const sid = sessionId(5);
  const step = PAIRS + 10;
  append(5, pair(5, step, { cwd: loose, command: 'git commit -m "loose"', output: '[main abc1234] loose\n 1 file changed' }));
  const first = byId(scan().sessions, sid).gitEvents.find(event => event.sourceId === `toolu_5_${step}`);
  assert.ok(first, 'the commit is parsed');
  assert.equal(first.unresolved, true, 'no repository yet');
  fs.mkdirSync(path.join(loose, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(loose, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const second = byId(scan().sessions, sid).gitEvents.find(event => event.sourceId === `toolu_5_${step}`);
  assert.equal(second.unresolved, undefined, 'the unchanged transcript is re-parsed against the new repository');
  assert.equal(second.repoRoot, fs.realpathSync(loose));
});

test('observation state frozen after the parse reaches an unchanged transcript', () => {
  const sid = sessionId(7);
  const step = PAIRS + 20;
  append(7, pair(7, step, { command: 'git push origin main', output: 'To github.com:o/r.git\n   1111111..2222222  main -> main' }));
  const push = byId(scan().sessions, sid).gitEvents.find(event => event.sourceId === `toolu_7_${step}` && event.type === 'push');
  assert.ok(push, 'the push is parsed');
  assert.equal(push.landedShas, undefined);
  const memoHits = adapter.getPerfStats().derivedMemo.hits;
  gitEvents._test.freezeFields(push.id, { landedShas: ['2222222'] });
  const again = scan();
  assert.equal(again.tailBytes, 0, 'the transcript itself is not read again');
  const landed = byId(again.sessions, sid).gitEvents.find(event => event.id === push.id);
  assert.deepEqual(landed.landedShas, ['2222222'], 'a repository scan can still land a parsed push');
  assert.ok(adapter.getPerfStats().derivedMemo.hits > memoHits, 'other derivations stayed memoized');
});

// SV-1 race: a transcript above the async threshold that grows while its
// async scan runs must still commit the scanned range. The appends below land
// while the three first-sight scans are pending (all scheduled synchronously,
// before any stream chunk is read), so every settle sees pure growth.
const RACE_FILES = 3;
const raceTranscript = index => path.join(projectDir, `race-${index}.jsonl`);
const RACE_PAIRS = Math.ceil((9 * 1024 * 1024) / 2400); // about 9 MB per transcript

test('appends during an async scan commit the base instead of restarting from byte zero', async () => {
  const raceFiles = Array.from({ length: RACE_FILES }, (_, index) => raceTranscript(index));
  for (let index = 0; index < RACE_FILES; index++) {
    const rows = [];
    for (let step = 0; step < RACE_PAIRS; step++) rows.push(...pair(30 + index, step));
    fs.writeFileSync(raceFiles[index], jsonl(rows));
    assert.ok(fs.statSync(raceFiles[index]).size > 8 * 1024 * 1024, 'each race transcript exceeds the async threshold');
  }
  const before = { ...adapter.getPerfStats().transcriptAggregate };
  for (let index = 0; index < RACE_FILES; index++) adapter.getSessionDetail(`race-${index}`, project);
  const appended = [];
  for (let index = 0; index < RACE_FILES; index++) {
    const text = jsonl(pair(30 + index, RACE_PAIRS + 1, { command: `echo race-append-${index}` }));
    fs.appendFileSync(raceFiles[index], text);
    appended.push(Buffer.byteLength(text));
  }
  const deadline = Date.now() + 60_000;
  while (adapter.getPerfStats().transcriptAggregate.pending > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(adapter.getPerfStats().transcriptAggregate.pending, 0, 'the async scans must settle');
  const settled = adapter.getPerfStats().transcriptAggregate;
  assert.equal(settled.asyncCompletions - before.asyncCompletions, RACE_FILES, 'each pending scan completes');
  assert.equal(settled.staleAsyncScans - before.staleAsyncScans, 0, 'pure growth must not discard a finished aggregate');
  for (let index = 0; index < RACE_FILES; index++) adapter.getSessionDetail(`race-${index}`, project);
  const after = adapter.getPerfStats().transcriptAggregate;
  const appendedTotal = appended.reduce((sum, bytes) => sum + bytes, 0);
  const initialBytes = raceFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0) - appendedTotal;
  assert.equal(after.incrementalScans - before.incrementalScans, RACE_FILES, 'the appended bytes fold incrementally');
  assert.ok(after.fullScans - before.fullScans <= RACE_FILES,
    `expected at most ${RACE_FILES} full scans, saw ${after.fullScans - before.fullScans}`);
  assert.ok(after.bytesRead - before.bytesRead <= initialBytes + appendedTotal + 4096,
    `read ${after.bytesRead - before.bytesRead} bytes for ${initialBytes} initial plus ${appendedTotal} appended`);
  const detail = adapter.getSessionDetail('race-1', project);
  assert.equal(detail.tokenUsage.totalInput, (RACE_PAIRS + 1) * 10,
    'the committed base plus the appended record count every usage record exactly once');
});
