import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const { OmpAdapter, parseOmpTranscript } = require('../../claudeville/adapters/omp.js');
const { clearTailCache, readFailures } = require('../../claudeville/adapters/shared.js');

function captureFileIo(action, { onRead = null } = {}) {
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, stat: fs.statSync, readdir: fs.readdirSync };
  const descriptors = new Map();
  const files = new Map();
  const counts = { bytes: 0, fileStats: 0, directoryReads: 0 };
  fs.openSync = function (filePath, ...args) {
    const fd = original.open.call(this, filePath, ...args);
    descriptors.set(fd, String(filePath));
    return fd;
  };
  fs.closeSync = function (fd) {
    descriptors.delete(fd);
    return original.close.call(this, fd);
  };
  fs.readSync = function (fd, ...args) {
    const bytes = original.read.call(this, fd, ...args);
    const filePath = descriptors.get(fd);
    counts.bytes += bytes;
    if (filePath) {
      const entry = files.get(filePath) || { bytes: 0, reads: 0, furthestRead: 0 };
      entry.bytes += bytes;
      entry.reads += 1;
      entry.furthestRead = Math.max(entry.furthestRead, Number(args[3] || 0) + bytes);
      files.set(filePath, entry);
      if (bytes > 0) onRead?.(filePath);
    }
    return bytes;
  };
  fs.statSync = function (filePath, ...args) {
    if (String(filePath).endsWith('.jsonl')) counts.fileStats += 1;
    return original.stat.call(this, filePath, ...args);
  };
  fs.readdirSync = function (...args) {
    counts.directoryReads += 1;
    return original.readdir.apply(this, args);
  };
  try {
    return { value: action(), files, ...counts };
  } finally {
    fs.openSync = original.open;
    fs.closeSync = original.close;
    fs.readSync = original.read;
    fs.statSync = original.stat;
    fs.readdirSync = original.readdir;
  }
}

function stamp(filePath, at) {
  fs.utimesSync(filePath, new Date(at), new Date(at));
}

function fixtureRecords(id, at, text = 'Observed answer.') {
  return [
    { type: 'session', id, timestamp: new Date(at).toISOString(), cwd: '/workspace/fixture' },
    assistantMessage(`${id}-answer`, new Date(at).toISOString(), [{ type: 'text', text }], { input: 10, output: 2 }),
  ];
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function assistantMessage(id, timestamp, content, usage = null) {
  return {
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'assistant',
      content,
      ...(usage ? { usage } : {}),
    },
  };
}

test('OMP transcript projects the latest user prompt and reconstructed todo checklist', () => {
  const prompt = ` ${'Latest OMP prompt '.repeat(20)} `;
  const parsed = parseOmpTranscript([
    {
      type: 'session',
      id: '01900000-0000-7000-8000-000000000010',
      timestamp: '2026-08-12T10:00:00.000Z',
      cwd: '/workspace/fixture',
      git: { branch: 'feature/omp-todos' },
    },
    { type: 'message', timestamp: '2026-08-12T10:00:01.000Z', message: {
      role: 'user', content: [{ type: 'text', text: prompt }],
    } },
    { type: 'message', timestamp: '2026-08-12T10:00:02.000Z', message: {
      role: 'user', content: [{ type: 'text', text: '<system-reminder>Not a user prompt.</system-reminder>' }],
    } },
    assistantMessage('todo-init', '2026-08-12T10:00:03.000Z', [
      { type: 'toolCall', id: 'todo-init-call', name: 'todo', arguments: {
        op: 'init',
        list: [
          { phase: 'Implementation', items: ['Inspect OMP', 'Project checklist', 'Remove this item'] },
          { phase: 'Verification', items: ['Verify bounds', 'Check ordering', 'Confirm counts'] },
        ],
      } },
      { type: 'toolCall', id: 'todo-done-call', name: 'todo', arguments: {
        op: 'done', task: 'Inspect OMP',
      } },
      { type: 'toolCall', id: 'todo-start-call', name: 'todo', arguments: {
        op: 'start', task: 'Project checklist',
      } },
      { type: 'toolCall', id: 'todo-drop-call', name: 'todo', arguments: {
        op: 'drop', task: 'Remove this item',
      } },
    ]),
  ], {
    filePath: '/nonexistent/omp-fixture.jsonl',
    now: Date.parse('2026-08-12T10:01:00.000Z'),
    fileMtimeMs: Date.parse('2026-08-12T10:00:03.000Z'),
  });

  assert.equal(parsed.session.lastPrompt, prompt.trim().slice(0, 200));
  assert.deepEqual(parsed.session.todos, [
    { subject: 'Inspect OMP', status: 'completed', phase: 'Implementation' },
    { subject: 'Project checklist', status: 'in_progress', phase: 'Implementation' },
    { subject: 'Verify bounds', status: 'pending', phase: 'Verification' },
    { subject: 'Check ordering', status: 'pending', phase: 'Verification' },
    { subject: 'Confirm counts', status: 'pending', phase: 'Verification' },
  ]);
  assert.equal(parsed.session.todos.length, 5);
  assert.equal(parsed.session.todos.filter(todo => todo.status === 'completed').length, 1);
  assert.equal(parsed.session.gitBranch, 'feature/omp-todos');
});

test('OMP adapter discovers parent and nested agent transcripts with details and usage', () => {
  const tmpRoot = makeTempDir('claudeville-omp-');
  const projectDir = path.join(tmpRoot, '-workspace-fixture');
  const parentId = '01900000-0000-7000-8000-000000000001';
  const childId = '01900000-0000-7000-8000-000000000002';
  const glmChildId = '01900000-0000-7000-8000-000000000003';
  const parentPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}.jsonl`);
  const childPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}`, 'ReviewWorker.jsonl');
  const glmChildPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}`, 'GlmWorker.jsonl');
  const now = Date.parse('2026-08-12T10:01:00.000Z');

  writeJsonl(parentPath, [
    { type: 'title', title: 'OMP parent', updatedAt: '2026-08-12T10:00:00.000Z' },
    { type: 'session', id: parentId, timestamp: '2026-08-12T10:00:00.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', model: 'openai-codex/gpt-5.6-luna', timestamp: '2026-08-12T10:00:00.010Z' },
    assistantMessage('parent-assistant', '2026-08-12T10:00:20.000Z', [
      { type: 'text', text: 'Parent completed the task.' },
      { type: 'toolCall', id: 'call-parent', name: 'task', arguments: { prompt: 'Review the fixture' } },
    ], { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, totalTokens: 154, reasoningTokens: 5 }),
    { type: 'message', id: 'parent-tool-result', timestamp: '2026-08-12T10:00:21.000Z', message: {
      role: 'toolResult', toolCallId: 'call-parent', toolName: 'task',
      content: [{ type: 'text', text: 'done' }], details: { status: 'success' },
    } },
  ]);
  writeJsonl(childPath, [
    { type: 'title', title: '', updatedAt: '2026-08-12T10:00:30.000Z' },
    { type: 'session', id: childId, timestamp: '2026-08-12T10:00:30.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', model: 'kimi-code/k3', timestamp: '2026-08-12T10:00:30.010Z' },
    assistantMessage('child-assistant', '2026-08-12T10:00:40.000Z', [
      { type: 'text', text: 'Review finished.' },
      { type: 'toolCall', id: 'call-child', name: 'read', arguments: { path: '/workspace/fixture/index.js' } },
    ], { input: 10, output: 6, cacheRead: 2, cacheWrite: 0, totalTokens: 18, reasoningTokens: 0 }),
  ]);
  // Observed z.AI order: model_change carries the prefixed string, then each
  // assistant message overwrites the presented model with the bare id.
  writeJsonl(glmChildPath, [
    { type: 'title', title: '', updatedAt: '2026-08-12T10:00:45.000Z' },
    { type: 'session', id: glmChildId, timestamp: '2026-08-12T10:00:45.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', id: 'glm-model-change', parentId: null, model: 'zai/glm-5.3-flash', timestamp: '2026-08-12T10:00:46.000Z' },
    { type: 'message', id: 'glm-assistant', timestamp: '2026-08-12T10:00:50.000Z', message: {
      role: 'assistant', provider: 'zai', model: 'glm-5.3-flash',
      content: [{ type: 'text', text: 'GLM review finished.' }],
      usage: { input: 8, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 13, reasoningTokens: 0 },
    } },
  ]);

  const adapter = new OmpAdapter({ rootDir: tmpRoot, now: () => now });
  try {
    const sessions = adapter.getActiveSessions(2 * 60 * 1000);
    const parent = sessions.find(session => session.sessionId === `omp-${parentId}`);
    const child = sessions.find(session => session.sessionId === `omp-${childId}`);

    assert.ok(parent);
    assert.equal(parent.provider, 'omp');
    assert.equal(parent.model, 'openai-codex/gpt-5.6-luna');
    assert.equal(parent.project, '/workspace/fixture');
    assert.equal(parent.lastTool, 'task');
    assert.equal(parent.lastToolInput, 'Review the fixture');
    assert.equal(parent.lastMessage, 'Parent completed the task.');
    assert.deepEqual(parent.tokenUsage, {
      input: 100, output: 20, cacheRead: 30, cacheCreate: 4, cacheWrite: 4,
      totalInput: 100, totalOutput: 20, reasoningTokens: 5, reasoningInOutput: false, turnCount: 1,
    });

    assert.ok(child);
    assert.equal(child.agentType, 'sub-agent');
    assert.equal(child.agentName, 'ReviewWorker');
    assert.equal(child.parentSessionId, `omp-${parentId}`);
    assert.equal(child.underlyingProvider, 'kimi-code');

    const glmChild = sessions.find(session => session.sessionId === `omp-${glmChildId}`);
    assert.ok(glmChild);
    assert.equal(glmChild.provider, 'omp');
    assert.equal(glmChild.model, 'glm-5.3-flash');
    assert.equal(glmChild.underlyingProvider, 'zai');

    const detail = adapter.getSessionDetail(`omp-${parentId}`, '/workspace/fixture');
    assert.equal(detail.provider, 'omp');
    assert.equal(detail.sessionId, `omp-${parentId}`);
    assert.equal(detail.toolHistory.length, 1);
    assert.deepEqual(detail.toolHistory[0], {
      tool: 'task', detail: 'Review the fixture', ts: Date.parse('2026-08-12T10:00:20.000Z'),
    });
    assert.deepEqual(detail.messages, [{
      role: 'assistant', text: 'Parent completed the task.', ts: Date.parse('2026-08-12T10:00:20.000Z'),
    }]);
    assert.deepEqual(adapter.getWatchPaths(), [{
      type: 'directory', path: tmpRoot, recursive: true, filter: '.jsonl',
    }]);
  } finally {
    adapter.shutdown();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('OMP thinking level changes become the session reasoning effort', () => {
  const sessionRecord = {
    type: 'session',
    id: '01900000-0000-7000-8000-000000000020',
    timestamp: '2026-08-12T10:00:00.000Z',
    cwd: '/workspace/fixture',
  };
  const options = {
    filePath: '/nonexistent/omp-thinking.jsonl',
    now: Date.parse('2026-08-12T10:01:00.000Z'),
    fileMtimeMs: Date.parse('2026-08-12T10:00:04.000Z'),
  };

  const parsed = parseOmpTranscript([
    sessionRecord,
    { type: 'thinking_level_change', timestamp: '2026-08-12T10:00:01.000Z', thinkingLevel: 'low' },
    { type: 'thinking_level_change', timestamp: '2026-08-12T10:00:02.000Z', thinkingLevel: null },
    { type: 'thinking_level_change', timestamp: '2026-08-12T10:00:03.000Z', thinkingLevel: 'high' },
    { type: 'thinking_level_change', timestamp: '2026-08-12T10:00:04.000Z', thinkingLevel: 'max' },
  ], options);

  // The latest level wins, and a null level never clears the previous one.
  assert.equal(parsed.session.reasoningEffort, 'max');

  const silent = parseOmpTranscript([sessionRecord], options);
  assert.equal(silent.session.reasoningEffort, null);
});

test('OMP inactive nested details reduce only the selected transcript, not historical tails', () => {
  const root = makeTempDir('claudeville-omp-inactive-detail-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const old = now - 10 * 60 * 1000;
  const parentId = '01900000-0000-7000-8000-000000000201';
  const childId = '01900000-0000-7000-8000-000000000202';
  const childPath = path.join(root, 'project', `2026-09-01T00-00-00-000Z_${parentId}`, 'ReviewWorker.jsonl');
  const histories = [];
  for (let index = 0; index < 20; index++) {
    const filePath = path.join(root, 'history', `history-${index}.jsonl`);
    writeJsonl(filePath, fixtureRecords(`historical-${index}`, old, 'Historical result. '.repeat(10_000)));
    stamp(filePath, old);
    histories.push(filePath);
  }
  const records = fixtureRecords(childId, old, 'Review completed.');
  records.push(assistantMessage('child-read', new Date(old + 1).toISOString(), [
    { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: '/workspace/fixture/index.js' } },
  ]));
  writeJsonl(childPath, records);
  stamp(childPath, old);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    assert.deepEqual(adapter.getActiveSessions(120_000), []);
    const before = adapter.getPerfStats();
    const measured = captureFileIo(() => adapter.getSessionDetail(`omp-${childId}`));
    const expected = parseOmpTranscript(records, { filePath: childPath, childAgentName: 'ReviewWorker', fileMtimeMs: old, now }).detail;
    assert.deepEqual(measured.value, expected);
    const after = adapter.getPerfStats();
    assert.equal(after.reducedMisses - before.reducedMisses, 1);
    assert.ok(after.lastDetailHeaderFiles <= histories.length + 1);
    for (const filePath of histories) {
      assert.ok((measured.files.get(filePath)?.furthestRead || 0) <= 4096, 'unrelated transcript reads stay in the identity header');
    }
    assert.ok(measured.bytes <= after.detailDiscoveryByteLimit + 2 * fs.statSync(childPath).size);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP unknown detail polls stay bounded and do no transcript IO until discovery changes', () => {
  const root = makeTempDir('claudeville-omp-negative-detail-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    const limit = adapter.getPerfStats().detailDiscoveryFileLimit;
    for (let index = 0; index < limit + 10; index++) {
      writeJsonl(path.join(root, `history-${index}.jsonl`), fixtureRecords(`history-${index}`, now - 600_000));
    }
    const first = captureFileIo(() => adapter.getSessionDetail('omp-newly-created', '/workspace/fixture'));
    assert.deepEqual(first.value.messages, []);
    assert.deepEqual(first.value.toolHistory, []);
    const perf = adapter.getPerfStats();
    assert.ok(perf.lastDetailHeaderFiles <= perf.detailDiscoveryFileLimit);
    assert.ok(first.bytes <= perf.detailDiscoveryByteLimit);
    assert.equal(perf.reducedMisses, 0);
    const repeated = captureFileIo(() => {
      for (let index = 0; index < 5; index++) {
        assert.deepEqual(adapter.getSessionDetail('omp-newly-created').messages, []);
      }
    });
    assert.equal(repeated.bytes, 0);
    assert.equal(repeated.fileStats, 0);
    assert.equal(repeated.directoryReads, 0);

    const filePath = path.join(root, 'newly-created.jsonl');
    writeJsonl(filePath, fixtureRecords('newly-created', now, 'Newly visible answer.'));
    stamp(root, now + 1_000);
    const found = adapter.getSessionDetail('omp-newly-created');
    assert.equal(found.sessionId, 'omp-newly-created');
    assert.equal(found.messages[0].text, 'Newly visible answer.');
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP transcript appends retain resolved detail mappings beyond the active window', () => {
  const root = makeTempDir('claudeville-omp-retained-detail-');
  let now = Date.parse('2026-09-01T12:00:00.000Z');
  const selected = path.join(root, 'project', 'SelectedWorker.jsonl');
  const active = path.join(root, 'project', 'ActiveWorker.jsonl');
  writeJsonl(selected, fixtureRecords('selected', now, 'Selected answer.'));
  writeJsonl(active, fixtureRecords('active', now));
  stamp(selected, now);
  stamp(active, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    adapter.getActiveSessions(120_000);
    const initial = adapter.getSessionDetail('omp-selected');
    now += 130_000;
    fs.appendFileSync(active, `${JSON.stringify(assistantMessage('active-next', new Date(now).toISOString(), 'Active answer.'))}\n`);
    stamp(active, now);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: active });
    assert.deepEqual(adapter.getActiveSessions(120_000).map(session => session.sessionId), ['omp-active']);
    const retained = adapter.getSessionDetail('omp-selected');
    assert.deepEqual(retained, initial);
    assert.equal(adapter.getPerfStats().lastDetailHeaderFiles, 0);

    fs.appendFileSync(selected, `${JSON.stringify(assistantMessage('selected-next', new Date(now).toISOString(), 'Selected updated.'))}\n`);
    stamp(selected, now);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: selected });
    const updated = adapter.getSessionDetail('omp-selected');
    assert.equal(updated.messages.at(-1).text, 'Selected updated.');
    assert.equal(adapter.getPerfStats().lastDetailHeaderFiles, 0);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP unchanged active passes avoid transcript IO and historical stats while presentation ages live', () => {
  const root = makeTempDir('claudeville-omp-warm-pass-');
  let now = Date.parse('2026-09-01T12:00:00.000Z');
  const activePath = path.join(root, 'project', 'ActiveWorker.jsonl');
  const otherPath = path.join(root, 'project', 'OtherWorker.jsonl');
  for (let index = 0; index < 40; index++) {
    const filePath = path.join(root, 'history', `${index}.jsonl`);
    writeJsonl(filePath, fixtureRecords(`history-${index}`, now - 600_000));
    stamp(filePath, now - 600_000);
  }
  writeJsonl(activePath, fixtureRecords('active', now, 'Current answer.'));
  writeJsonl(otherPath, fixtureRecords('other', now, 'Other answer.'));
  stamp(activePath, now);
  stamp(otherPath, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    const cold = captureFileIo(() => adapter.getActiveSessions(120_000));
    assert.equal(adapter.getPerfStats().lastBytesRead, cold.bytes);
    clearTailCache('omp');
    const warm = captureFileIo(() => adapter.getActiveSessions(120_000));
    assert.deepEqual(warm.value, cold.value);
    assert.equal(warm.bytes, 0);
    assert.equal(warm.directoryReads, 0);
    assert.equal(warm.fileStats, 2);
    assert.equal(adapter.getPerfStats().lastBytesRead, 0);
    assert.equal(adapter.getPerfStats().lastLinesParsed, 0);

    fs.appendFileSync(activePath, `${JSON.stringify(assistantMessage('appended', new Date(now).toISOString(), 'Appended answer.', { input: 7, output: 3 }))}\n`);
    stamp(activePath, now);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: activePath });
    const appended = captureFileIo(() => adapter.getActiveSessions(120_000));
    const current = appended.value.find(session => session.sessionId === 'omp-active');
    assert.equal(current.lastMessage, 'Appended answer.');
    assert.equal(current.tokenUsage.input, 17);
    assert.equal(current.tokenUsage.output, 5);
    assert.equal(current.tokenUsage.turnCount, 2);
    assert.deepEqual([...appended.files.keys()], [activePath]);
    assert.equal(adapter.getPerfStats().lastBytesRead, appended.bytes);

    now += 91_000;
    const aged = adapter.getActiveSessions(120_000);
    assert.equal(aged.find(session => session.sessionId === 'omp-active').dialogue, null);
    assert.equal(adapter.getPerfStats().lastBytesRead, 0);
    now += 30_000;
    assert.deepEqual(adapter.getActiveSessions(120_000), []);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP retries a mid-read append without failing the provider pass or returning empty details', () => {
  const root = makeTempDir('claudeville-omp-read-append-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const filePath = path.join(root, 'project', 'Worker.jsonl');
  writeJsonl(filePath, fixtureRecords('append-race', now, 'Earlier answer.'));
  stamp(filePath, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  const failuresBefore = readFailures.count;
  const appendOnceDuringRead = (action, id, text) => {
    let appended = false;
    return captureFileIo(action, { onRead: readPath => {
      if (readPath !== filePath || appended) return;
      appended = true;
      fs.appendFileSync(filePath, `${JSON.stringify(assistantMessage(id, new Date(now).toISOString(), text))}\n`);
    } }).value;
  };
  try {
    const sessions = appendOnceDuringRead(() => adapter.getActiveSessions(120_000), 'summary-append', 'Summary appended during read.');
    assert.deepEqual(sessions.map(session => session.sessionId), ['omp-append-race']);
    assert.equal(sessions[0].lastMessage, 'Summary appended during read.');
    assert.equal(readFailures.count, failuresBefore);

    const detail = appendOnceDuringRead(() => adapter.getSessionDetail('omp-append-race'), 'detail-append', 'Detail appended during read.');
    assert.equal(detail.sessionId, 'omp-append-race');
    assert.equal(detail.messages.at(-1).text, 'Detail appended during read.');
    assert.equal(readFailures.count, failuresBefore);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP keeps a repeatedly changing transcript eligible and serves stale cached detail until it settles', () => {
  const root = makeTempDir('claudeville-omp-busy-read-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const filePath = path.join(root, 'project', 'Worker.jsonl');
  writeJsonl(filePath, fixtureRecords('busy-race', now, 'Earlier answer.'));
  stamp(filePath, now);
  const registry = require('../../claudeville/adapters/index.js');
  const adapter = registry.adapters.find(candidate => candidate.provider === 'omp');
  const original = { sessionsDir: adapter.sessionsDir, now: adapter.now };
  adapter.sessionsDir = root;
  adapter.now = () => now;
  const failuresBefore = readFailures.count;
  let revision = 0;
  const appendDuringRead = readPath => {
    if (readPath !== filePath) return;
    revision += 1;
    fs.appendFileSync(filePath, `${JSON.stringify(assistantMessage(`busy-${revision}`, new Date(now).toISOString(), `Busy answer ${revision}.`))}\n`);
  };
  try {
    adapter.getActiveSessions(120_000);
    const initial = registry.getSessionDetailByProvider('omp', 'omp-busy-race');
    assert.equal(initial.messages[0].text, 'Earlier answer.');
    assert.equal(initial.freshness.state, 'fresh');
    fs.appendFileSync(filePath, `${JSON.stringify(assistantMessage('before-race', new Date(now).toISOString(), 'Before race.'))}\n`);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    const busy = captureFileIo(() => adapter.getActiveSessions(120_000), { onRead: appendDuringRead });
    assert.deepEqual(busy.value, []);
    assert.equal(readFailures.count, failuresBefore);
    // No further dirty event or reconciliation is needed after the writer settles.
    const settled = adapter.getActiveSessions(120_000);
    assert.deepEqual(settled.map(session => session.sessionId), ['omp-busy-race']);
    assert.equal(settled[0].lastMessage, `Busy answer ${revision}.`);

    assert.throws(() => captureFileIo(() => adapter.getSessionDetail('omp-busy-race'), { onRead: appendDuringRead }),
      error => error instanceof Error && error.code === undefined);
    const stale = captureFileIo(() => registry.getSessionDetailByProvider('omp', 'omp-busy-race', undefined, { force: true }), {
      onRead: appendDuringRead,
    }).value;
    assert.equal(stale.freshness.state, 'stale');
    assert.deepEqual(stale.messages, initial.messages);
    assert.equal(readFailures.count, failuresBefore);
    const detail = registry.getSessionDetailByProvider('omp', 'omp-busy-race');
    assert.equal(detail.freshness.state, 'fresh');
    assert.equal(detail.messages.at(-1).text, `Busy answer ${revision}.`);
  } finally {
    adapter.shutdown();
    adapter.sessionsDir = original.sessionsDir;
    adapter.now = original.now;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const prune of ['file', 'directory']) {
  test(`OMP forgets a ${prune} pruned mid-read without aborting other sessions`, () => {
    const root = makeTempDir('claudeville-omp-read-prune-');
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    const projectDir = path.join(root, 'pruned-project');
    const filePath = path.join(projectDir, 'Worker.jsonl');
    const survivorPath = path.join(root, 'surviving-project', 'Worker.jsonl');
    writeJsonl(filePath, fixtureRecords('pruned', now));
    writeJsonl(survivorPath, fixtureRecords('survivor', now, 'Surviving answer.'));
    stamp(filePath, now);
    stamp(survivorPath, now);
    const adapter = new OmpAdapter({ rootDir: root, now: () => now });
    const failuresBefore = readFailures.count;
    let pruned = false;
    try {
      const result = captureFileIo(() => adapter.getActiveSessions(120_000), { onRead: readPath => {
        if (readPath !== filePath || pruned) return;
        pruned = true;
        if (prune === 'file') fs.unlinkSync(filePath);
        else {
          fs.renameSync(projectDir, path.join(root, '.pruned-project'));
          fs.writeFileSync(projectDir, 'Pruned directory.');
        }
      } });
      assert.deepEqual(result.value.map(session => session.sessionId), ['omp-survivor']);
      assert.equal(result.value[0].lastMessage, 'Surviving answer.');
      assert.equal(readFailures.count, failuresBefore);
      assert.deepEqual(adapter.getSessionDetail('omp-pruned').messages, []);
    } finally {
      adapter.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('OMP append parsing carries split Unicode records and invalidates rewrites and rotations', () => {
  const root = makeTempDir('claudeville-omp-append-boundaries-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const filePath = path.join(root, 'project', 'Worker.jsonl');
  const records = fixtureRecords('original', now, 'Earlier answer.');
  writeJsonl(filePath, records);
  stamp(filePath, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    adapter.getActiveSessions(120_000);
    const appended = assistantMessage('unicode', new Date(now).toISOString(), 'A completed café 🌳.');
    const bytes = Buffer.from(`${JSON.stringify(appended)}\n`);
    const split = bytes.indexOf(Buffer.from('🌳')) + 2;
    fs.appendFileSync(filePath, bytes.subarray(0, split));
    stamp(filePath, now + 1_000);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    assert.equal(adapter.getActiveSessions(120_000)[0].lastMessage, 'Earlier answer.');
    fs.appendFileSync(filePath, bytes.subarray(split));
    stamp(filePath, now + 2_000);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    assert.equal(adapter.getActiveSessions(120_000)[0].lastMessage, 'A completed café 🌳.');
    assert.equal(adapter.getSessionDetail('omp-original').messages.at(-1).text, 'A completed café 🌳.');

    const rewritten = fs.readFileSync(filePath, 'utf8').replace('Earlier answer.', 'Changed answer.');
    fs.writeFileSync(filePath, rewritten);
    stamp(filePath, now + 2_000);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    assert.equal(adapter.getSessionDetail('omp-original').messages[0].text, 'Changed answer.');

    const replacement = path.join(root, 'replacement.jsonl');
    writeJsonl(replacement, fixtureRecords('replacement', now, 'Replacement answer.'));
    stamp(replacement, now);
    fs.renameSync(replacement, filePath);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    assert.deepEqual(adapter.getSessionDetail('omp-original').messages, []);
    assert.equal(adapter.getSessionDetail('omp-replacement').messages[0].text, 'Replacement answer.');
    fs.unlinkSync(filePath);
    adapter.invalidateCachesForDirty({ kind: 'transcript', path: filePath });
    assert.deepEqual(adapter.getSessionDetail('omp-replacement').messages, []);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP topology discovers exact new nested paths and reconciles missed file events', () => {
  const root = makeTempDir('claudeville-omp-topology-');
  let now = Date.parse('2026-09-01T12:00:00.000Z');
  const firstPath = path.join(root, 'project', 'FirstWorker.jsonl');
  writeJsonl(firstPath, fixtureRecords('first', now));
  stamp(firstPath, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    assert.deepEqual(adapter.getActiveSessions(120_000).map(session => session.sessionId), ['omp-first']);
    const nestedPath = path.join(root, 'project', 'new-parent', 'new-child', 'Worker.jsonl');
    writeJsonl(nestedPath, fixtureRecords('nested', now));
    stamp(nestedPath, now);
    adapter.invalidateCachesForDirty({ kind: 'discovery', path: nestedPath });
    assert.deepEqual(new Set(adapter.getActiveSessions(120_000).map(session => session.sessionId)), new Set(['omp-first', 'omp-nested']));

    const missedPath = path.join(root, 'project', 'missed-parent', 'MissedWorker.jsonl');
    writeJsonl(missedPath, fixtureRecords('missed', now));
    stamp(missedPath, now);
    fs.unlinkSync(firstPath);
    now += 30_001;
    assert.deepEqual(new Set(adapter.getActiveSessions(120_000).map(session => session.sessionId)), new Set(['omp-nested', 'omp-missed']));
    assert.equal(adapter.getSessionDetail('omp-missed').messages[0].text, 'Observed answer.');
    assert.deepEqual(adapter.getSessionDetail('omp-first').messages, []);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP discovery over the transcript cap keeps the newest sessions instead of the first-listed history', () => {
  const root = makeTempDir('claudeville-omp-capped-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const historyDir = path.join(root, 'a-project', '2026-08-01T00-00-00-000Z_01900000-0000-7000-8000-000000000401');
  fs.mkdirSync(historyDir, { recursive: true });
  for (let index = 0; index < 4100; index++) fs.writeFileSync(path.join(historyDir, `Worker${index}.jsonl`), '');
  const sessionName = '2026-09-01T11-00-00-000Z_01900000-0000-7000-8000-000000000402';
  const parentPath = path.join(root, 'b-project', `${sessionName}.jsonl`);
  const childPath = path.join(root, 'b-project', sessionName, 'LiveWorker.jsonl');
  writeJsonl(parentPath, fixtureRecords('live-parent', now));
  writeJsonl(childPath, fixtureRecords('live-child', now));
  stamp(parentPath, now);
  stamp(childPath, now);
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    const sessions = adapter.getActiveSessions(120_000);
    assert.deepEqual(new Set(sessions.map(session => session.sessionId)), new Set(['omp-live-parent', 'omp-live-child']));
    assert.equal(adapter.getPerfStats().knownTranscripts, 4096);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP cold detail discovery prioritizes recently modified inactive workers over old history', () => {
  const root = makeTempDir('claudeville-omp-recent-detail-');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const recent = now - 180_000;
  const old = now - 24 * 60 * 60 * 1000;
  const parentId = '01900000-0000-7000-8000-000000000301';
  const selectedId = 'recent-inactive';
  const selectedPath = path.join(root, 'z-project', `2026-09-01T00-00-00-000Z_${parentId}`, 'ReviewWorker.jsonl');
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  const warmAdapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    const historyCount = adapter.getPerfStats().detailDiscoveryFileLimit + 8;
    for (let index = 0; index < historyCount; index++) {
      const filePath = path.join(root, 'a-history', `${index}.jsonl`);
      writeJsonl(filePath, fixtureRecords(`history-${index}`, old));
      stamp(filePath, old);
    }
    writeJsonl(selectedPath, fixtureRecords(selectedId, recent, 'Recent inactive answer.'));
    stamp(selectedPath, recent);
    const cold = captureFileIo(() => adapter.getSessionDetail(`omp-${selectedId}`));
    assert.equal(cold.value.sessionId, `omp-${selectedId}`);
    assert.equal(cold.value.messages[0].text, 'Recent inactive answer.');
    assert.deepEqual([...cold.files.keys()], [selectedPath]);
    assert.equal(adapter.getPerfStats().lastDetailHeaderFiles, 1);
    assert.equal(adapter.getPerfStats().detailCappedLookups, 0);
    assert.ok(adapter.getPerfStats().lastDetailMetadataStats <= adapter.getPerfStats().knownTranscripts);

    const missing = captureFileIo(() => adapter.getSessionDetail('omp-missing-after-recent'));
    assert.deepEqual(missing.value.messages, []);
    assert.equal(missing.fileStats, 0, 'discovery reuses the metadata already observed by the cold lookup');
    assert.equal(adapter.getPerfStats().lastDetailMetadataStats, 0);
    const repeated = captureFileIo(() => adapter.getSessionDetail('omp-missing-after-recent'));
    assert.equal(repeated.bytes, 0);
    assert.equal(repeated.fileStats, 0);

    assert.deepEqual(warmAdapter.getActiveSessions(120_000), []);
    const warmed = captureFileIo(() => warmAdapter.getSessionDetail(`omp-${selectedId}`));
    assert.deepEqual(warmed.value, cold.value);
    assert.deepEqual([...warmed.files.keys()], [selectedPath]);
    assert.equal(warmAdapter.getPerfStats().lastDetailMetadataStats, 0);
    assert.ok(warmed.fileStats <= 3, 'only the matched transcript is statted after an active metadata pass');
  } finally {
    adapter.shutdown();
    warmAdapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP every collected session remains directly detail-resolvable after aging into residency', () => {
  const root = makeTempDir('claudeville-omp-all-retained-details-');
  let now = Date.parse('2026-09-01T12:00:00.000Z');
  const observedAt = now;
  const fixtures = new Map();
  for (const id of ['first', 'second', 'third']) {
    const filePath = path.join(root, 'project', `${id}Worker.jsonl`);
    const records = fixtureRecords(id, now, `${id} completed answer.`);
    writeJsonl(filePath, records);
    stamp(filePath, now);
    fixtures.set(`omp-${id}`, { filePath, records });
  }
  const adapter = new OmpAdapter({ rootDir: root, now: () => now });
  try {
    const collected = adapter.getActiveSessions(120_000);
    assert.deepEqual(new Set(collected.map(session => session.sessionId)), new Set(fixtures.keys()));
    adapter.getActiveSessions(120_000);
    now += 130_000;
    assert.deepEqual(adapter.getActiveSessions(120_000), []);
    for (const session of collected) {
      const fixture = fixtures.get(session.sessionId);
      const expected = parseOmpTranscript(fixture.records, { filePath: fixture.filePath, now, fileMtimeMs: observedAt }).detail;
      const measured = captureFileIo(() => adapter.getSessionDetail(session.sessionId));
      assert.deepEqual(measured.value, expected);
      assert.deepEqual([...measured.files.keys()], [fixture.filePath]);
      assert.equal(adapter.getPerfStats().lastDetailHeaderFiles, 0);
      assert.equal(adapter.getPerfStats().lastDetailMetadataStats, 0);
    }
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
