import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { resolveAgentStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { resolveObservation } from '../../claudeville/src/presentation/character-mode/ObservationCertainty.js';

const home = makeTempDir('claudeville-lineage-');
process.env.HOME = home;
process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
const state = name => path.join(home, '.local', 'state', name + '-cc-mcp');
for (const name of ['codex', 'glm', 'deepseek']) process.env['CLAUDEVILLE_' + name.toUpperCase() + '_STATE_DIR'] = state(name);
const require = createRequire(import.meta.url);
const { adapters, getAllSessions, invalidateSessionCaches } = require('../../claudeville/adapters');
const { mcpProcessParent, readLinuxProcess } = require('../../claudeville/adapters/shared');
const { hookOverlay } = require('../../claudeville/adapters/hooks');
const { SessionResidency } = require('../../claudeville/services/sessionResidency');
const claude = adapters.find(a => a.provider === 'claude');
const proc = new Map();
claude.readProcess = pid => proc.get(pid) ?? null;
const fixture = file => fs.readFileSync(fileURLToPath(new URL('../adapters/fixtures/lineage/' + file, import.meta.url)), 'utf8');
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const write = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n') + '\n');
};
const registry = pid => path.join(home, '.claude', 'sessions', pid + '.json');
const project = path.join(home, 'fixture');
const transcript = id => path.join(home, '.claude', 'projects', project.replaceAll('/', '-'), id + '.jsonl');
const now = Date.now();
const old = now - 20 * 60_000;
const threshold = 120_000;
const scan = () => getAllSessions(threshold, { force: true });
const find = (all, id) => all.find(s => s.sessionId === id || s.agentId === id);
const source = rows(fixture('claude/lead.jsonl')).map(row => ({ ...row, timestamp: old, cwd: project }));
for (const pid of [4101, 4102, 4103]) {
  const rec = JSON.parse(fixture('claude/sessions/' + pid + '.json'));
  rec.statusUpdatedAt = old + 1;
  write(registry(pid), [rec]);
  write(transcript(rec.sessionId), pid === 4101 ? source : [source[0]]);
  if (rec.status !== 'idle') fs.utimesSync(transcript(rec.sessionId), old / 1000, old / 1000);
  proc.set(pid, { start: rec.procStart, parentPid: 1 });
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('cold discovery, wait privacy, process exit and idle cutoffs use the registry', () => {
  // Waiting has a history entry. The busy lead is discovered from its transcript alone.
  write(path.join(home, '.claude', 'history.jsonl'), [{ sessionId: 'waiting', project, timestamp: old }]);
  let all = scan();
  const busy = find(all, 'lead');
  assert.equal(busy?.resident, false);
  assert.equal(resolveObservation(busy, now).state, 'fresh');
  assert.equal(busy.signalSource, 'registry');
  assert.equal(busy.signalCertainty, 'observed');
  assert.equal(resolveAgentStatus(busy), 'working');
  assert.ok(Math.abs(busy.lastActivity - old) < 2);
  const waiting = find(all, 'waiting');
  assert.equal(waiting.resident, false);
  assert.equal(resolveObservation(waiting, now).state, 'fresh');
  assert.equal(resolveAgentStatus(waiting), 'waiting_on_user');
  assert.equal(waiting.waitReason, 'approval');
  assert.equal(waiting.pendingTool, null);
  assert.doesNotMatch(JSON.stringify(waiting), /private fixture command/);
  assert.equal(find(all, 'idle').turnState, 'awaiting_input');

  const rec = JSON.parse(fs.readFileSync(registry(4102)));
  for (const [waitingFor, waitReason] of [['approve plan: secret', 'plan_review'], ['input needed: secret', 'question']]) {
    write(registry(4102), [{ ...rec, waitingFor }]);
    assert.equal(find(scan(), 'waiting').waitReason, waitReason);
  }
  const residency = new SessionResidency({ registrySettled: session => claude.registrySettled(session) });
  residency.merge(all);
  fs.utimesSync(transcript('idle'), old / 1000, old / 1000);
  proc.set(4102, { dead: true });
  assert.equal(claude.registryProcessChanged(), true);
  all = scan();
  assert.ok(find(all, 'waiting').sessionEndedAt >= now);
  assert.equal(find(scan(), 'waiting').sessionEndedAt, find(all, 'waiting').sessionEndedAt);
  assert.equal(find(all, 'waiting').waitReason, null);
  assert.equal(find(all, 'idle'), undefined);
  assert.deepEqual(residency.merge([]), []);
});

test('a registry exit survives pid file removal until resume or the active window expires', t => {
  const id = 'recent-exit';
  const rec = { sessionId: id, pid: 4130, procStart: '20', status: 'busy', statusUpdatedAt: now };
  const file = registry(rec.pid);
  write(transcript(id), [source[0]]);
  write(file, [rec]);
  proc.set(rec.pid, { start: rec.procStart });
  assert.equal(find(scan(), id).turnState, 'working');
  proc.set(rec.pid, { dead: true });
  const exit = find(scan(), id).sessionEndedAt;
  assert.ok(exit >= now);
  fs.unlinkSync(file);
  assert.equal(find(scan(), id).sessionEndedAt, exit);

  let clock = exit + 1000;
  t.mock.method(Date, 'now', () => clock);
  write(transcript(id), [{ ...source[0], timestamp: clock }]);
  assert.equal(find(scan(), id).sessionEndedAt, null, 'a later transcript turn supersedes the exit');
  write(file, [{ ...rec, procStart: '21', statusUpdatedAt: clock }]);
  proc.set(rec.pid, { start: '21' });
  assert.equal(find(scan(), id).signalSource, 'registry');
  assert.equal(find(scan(), id).sessionEndedAt, null, 'a resumed process has a new start time');
  proc.set(rec.pid, { dead: true });
  assert.equal(find(scan(), id).sessionEndedAt, clock);
  fs.unlinkSync(file);
  clock += threshold;
  assert.equal(find(scan(), id).sessionEndedAt, clock - threshold);
  clock++;
  scan();
  assert.equal(claude.registry.has(id), false);
});

test('a newer registry observation keeps pending hook details for the same turn', () => {
  const id = 'hook-and-registry';
  const rec = { sessionId: id, pid: 4131, procStart: '25', status: 'waiting',
    waitingFor: 'approve plan: registry private text', statusUpdatedAt: now };
  proc.set(rec.pid, { start: rec.procStart });
  write(registry(rec.pid), [rec]);
  write(transcript(id), [source[0]]);
  hookOverlay.ingest({ sessionId: id, provider: 'claude', kind: 'PermissionRequest', ts: now - 100,
    tool: 'Bash', input: { command: 'npm test token=secret' } });
  scan();
  const waiting = find(getAllSessions(threshold, { overlayOnly: true }), id);
  assert.equal(waiting.waitReason, 'plan_review');
  assert.equal(waiting.signalSource, 'registry');
  assert.equal(waiting.signalObservedAt, now);
  assert.equal(waiting.pendingTool, 'Bash');
  assert.equal(waiting.promptDetail, 'npm test token=[REDACTED]');
  assert.doesNotMatch(JSON.stringify(waiting), /registry private text|token=secret/);

  write(transcript(id), [{ ...source[0], timestamp: now - 50 }]);
  const laterTurn = find(scan(), id);
  assert.equal(laterTurn.pendingTool, null);
  assert.equal(laterTurn.promptDetail, undefined);
  write(transcript(id), [source[0]]);
  write(registry(rec.pid), [{ ...rec, status: 'idle' }]);
  const settled = find(scan(), id);
  assert.equal(settled.turnState, 'awaiting_input');
  assert.equal(settled.pendingTool, null);
  assert.equal(settled.promptDetail, undefined);

  write(registry(rec.pid), [{ ...rec, status: 'busy' }]);
  hookOverlay.ingest({ sessionId: id, provider: 'claude', kind: 'PreToolUse', ts: now - 10,
    tool: 'Read', input: { file_path: 'notes.txt' } });
  const busy = find(scan(), id);
  assert.equal(busy.turnState, 'working');
  assert.equal(busy.waitReason, null);
  assert.equal(busy.pendingTool, 'Read');
  assert.equal(busy.promptDetail, 'notes.txt');
  write(transcript(id), [source[0], { type: 'assistant', timestamp: now - 20, message: { role: 'assistant',
    content: [{ type: 'tool_use', id: 'real', name: 'Edit', input: { file_path: 'recorded.txt' } }] } }]);
  const recorded = find(scan(), id);
  assert.equal(recorded.pendingTool, 'Edit');
  assert.equal(recorded.lastToolInput, 'recorded.txt');
  assert.equal(recorded.promptDetail, undefined);
});

test('malformed, stale and unavailable registry observations yield to transcript tool evidence', () => {
  const id = 'other';
  const row = { pid: 4120, procStart: '10', sessionId: id, status: 'waiting', waitingFor: 'approve Edit: secret', statusUpdatedAt: old + 10 };
  const call = { type: 'assistant', timestamp: old + 5, message: { role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'fixture.txt' } }] } };
  write(transcript(id), [source[0], call]);
  proc.set(row.pid, { start: '10', parentPid: 1 });
  write(registry(row.pid), [row]);
  const waiting = find(scan(), id);
  assert.equal(waiting.signalSource, 'registry');
  assert.equal(waiting.waitReason, 'approval');
  assert.equal(waiting.pendingTool, 'Read');
  assert.equal(waiting.lastToolInput, 'fixture.txt');
  for (const change of [{ status: 'paused' }, { procStart: '99' }, { pid: 4121 }, { statusUpdatedAt: old },
    { statusUpdatedAt: null }, { waitingFor: 'unknown: secret' }]) {
    write(registry(row.pid), [{ ...row, ...change }]);
    // None of these records identifies a new exit.
    const session = find(scan(), id);
    assert.equal(session.signalSource, 'transcript', JSON.stringify(change));
    assert.equal(session.waitReason, null);
  }
  proc.delete(row.pid);
  write(registry(row.pid), [row]);
  assert.equal(find(scan(), id).signalSource, 'transcript');
  fs.writeFileSync(registry(row.pid), '{');
  assert.equal(find(scan(), id).signalSource, 'transcript');
});

test('all three fleets join by launch result or validated ancestry, across scoped refreshes', () => {
  const journal = rows(fixture('codex-cc-mcp/journal.jsonl')).map(row => ({ ...row, ts: now - 1000 + row.ts }));
  write(path.join(state('codex'), 'journal.jsonl'), journal);
  const eventsFile = path.join(state('codex'), 'jobs', 'codex_fixture_run', 'events.jsonl');
  write(eventsFile, rows(fixture('codex-cc-mcp/jobs/codex_fixture_run/events.jsonl')));
  const rollout = 'rollout-2026-11-19T12-00-00-thread-run.jsonl';
  for (const id of ['thread-run', 'thread-done', 'thread-crash', 'thread-plain']) {
    const file = path.join(home, '.codex', 'sessions', '2026', '11', '19', rollout.replace('thread-run', id));
    write(file, rows(fixture('codex/' + rollout).replaceAll('thread-run', id)));
    if (id === 'thread-crash') fs.utimesSync(file, old / 1000, old / 1000);
  }
  // The GLM owner's parent is the registry lead. DeepSeek reaches a separate team config.
  for (const [provider, prefix, owner, parent] of [['glm', 'glm', 505, 4101], ['deepseek', 'ds', 506, 4107]]) {
    proc.set(owner, { start: String(owner), parentPid: parent });
    write(path.join(state(provider), 'journal.jsonl'), [{ event: 'started', ts: now - 100,
      job_id: prefix + '_abc_00000001', session_id: prefix + 'th_abc_00000001', kind: 'ask',
      cwd: project, label: provider, owner_pid: owner, owner_start: String(owner) }]);
  }
  proc.set(4107, { start: '200', parentPid: 1 });
  write(path.join(home, '.claude', 'teams', 'test', 'config.json'), [{
    leadSessionId: 'team-lead', leadProcess: { pid: 4107, procStart: '200' },
  }]);
  const all = scan();
  for (const [id, parent] of [['thread-run', 'lead'], ['glmth_abc_00000001', 'lead'], ['dsth_abc_00000001', 'team-lead']]) {
    const session = find(all, id);
    assert.equal(session.parentSessionId, parent);
    assert.equal(session.agentType, 'sub-agent');
    assert.equal(session.subagentKind, 'mcp');
  }
  assert.equal(find(all, 'thread-run').agentName, 'Survey');
  assert.equal(find(all, 'thread-plain').subagentKind, null);
  assert.equal(find(all, 'thread-done').parentSessionId, null, 'shared cwd does not identify a launcher');
  assert.equal(find(all, 'thread-done').turnState, 'awaiting_input');
  assert.equal(find(all, 'thread-done').apiError, null);
  assert.equal(resolveAgentStatus(find(all, 'thread-crash')), 'errored');

  // Results published after the child can link it on a Claude-only refresh.
  const [prompt, call, result] = source.map(row => JSON.parse(JSON.stringify(row).replaceAll('codex_fixture_run', 'codex_fixture_crash')));
  write(transcript('lead'), [...source, prompt, result, call]);
  invalidateSessionCaches({ dirty: { provider: 'claude', kind: 'transcript', path: transcript('lead') } });
  assert.equal(find(getAllSessions(threshold), 'thread-crash').parentSessionId, 'lead');

  for (const status of ['failed', 'timeout']) {
    write(path.join(state('codex'), 'journal.jsonl'), [...journal, { ...journal.at(-1), status, error_kind: null }]);
    const failed = find(scan(), 'thread-crash');
    assert.equal(failed.apiError.kind, status);
    assert.equal(resolveAgentStatus(failed), 'errored');
  }

  fs.unlinkSync(registry(4101));
  fs.unlinkSync(transcript('lead'));
  proc.clear();
  const after = scan();
  assert.equal(find(after, 'lead'), undefined);
  assert.equal(find(after, 'glmth_abc_00000001').parentSessionId, 'lead');
  assert.equal(find(after, 'thread-run').parentSessionId, 'lead');

  // A symlinked job directory cannot supply launch evidence for a plain rollout.
  const dir = path.dirname(eventsFile);
  fs.renameSync(dir, dir + '-outside');
  fs.symlinkSync(dir + '-outside', dir, 'dir');
  write(path.join(dir + '-outside', 'events.jsonl'), [{ type: 'thread.started', thread_id: 'thread-plain' }]);
  const rotated = scan();
  assert.equal(find(rotated, 'thread-plain').subagentKind, null);
  assert.equal(find(rotated, 'thread-run').parentSessionId, 'lead', 'a previously joined thread survives lost journal evidence');
  assert.equal(find(rotated, 'thread-run').agentName, 'Survey');
});

test('selected GLM and DeepSeek detail carries the latest three validated jobs without a transcript', () => {
  for (const [provider, name, prefix] of [['zai', 'glm', 'glm'], ['deepseek', 'deepseek', 'ds']]) {
    const threadId = prefix + 'th_xyz_00000042';
    const records = [];
    for (const i of [1, 2, 3, 4]) {
      const job_id = prefix + '_xyz_0000000' + i;
      records.push({ event: 'started', ts: old + i * 1000, session_id: threadId, job_id,
        kind: i === 1 ? 'ask' : 'continue', model: 'fixture-' + i, effort: 'high' });
      if (i < 4) records.push({ event: 'finished', job_id, session_id: threadId, ts: old + i * 1000 + 250,
        status: i === 3 ? 'failed' : 'succeeded', duration_s: 0.25 });
    }
    records.push({ ...records.at(-1), job_id: '../forged', model: 'forged' });
    write(path.join(state(name), 'journal.jsonl'), records);
    const adapter = adapters.find(a => a.provider === provider);
    const detail = adapter.getSessionDetail(provider + '-' + threadId, project);
    assert.deepEqual(detail.jobs.map(j => j.model), ['fixture-4', 'fixture-3', 'fixture-2']);
    assert.deepEqual(detail.jobs[0], { kind: 'continue', model: 'fixture-4', effort: 'high',
      startedAt: old + 4000, endedAt: null, status: null, durationMs: null });
    assert.equal(detail.jobs[1].status, 'failed');
    assert.equal(detail.jobs[1].endedAt, old + 3250);
    assert.equal(detail.jobs[1].durationMs, 250);
  }
});


for (const [name, provider, prefix] of [['codex', 'codex', 'cx'], ['glm', 'zai', 'glm'], ['deepseek', 'deepseek', 'ds']]) {
  test(name + ' keeps the last verified fleet job through a concurrent append or rotation', t => {
    const id = prefix + 'th_abc_00000047';
    const job_id = prefix + '_abc_00000047';
    const journal = path.join(state(name), 'journal.jsonl');
    const started = { event: 'started', session_id: id, job_id, ts: now - 500, label: 'Survey' };
    const finished = { event: 'finished', session_id: id, job_id, ts: now - 200, status: 'crashed' };
    write(journal, [started, finished]);
    if (name === 'codex') {
      const rollout = 'rollout-2026-11-19T12-00-00-thread-run.jsonl';
      const file = path.join(home, '.codex', 'sessions', '2026', '11', '19', rollout.replace('thread-run', id));
      write(file, rows(fixture('codex/' + rollout).replaceAll('thread-run', id)));
      fs.utimesSync(file, old / 1000, old / 1000);
    }
    const adapter = adapters.find(a => a.provider === provider);
    const session = () => find(adapter.getActiveSessions(threshold, { force: true }), id);
    assert.equal(session().apiError.kind, 'crashed');
    let onOpen;
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', function (file, ...args) {
      if (file === journal && onOpen) {
        const change = onOpen;
        onOpen = null;
        change();
      }
      return open.call(this, file, ...args);
    });
    for (const change of ['append', 'rotate']) {
      fs.appendFileSync(journal, '\n');
      const updated = { ...finished, status: 'failed', label: change };
      onOpen = change === 'append'
        ? () => fs.appendFileSync(journal, JSON.stringify(updated) + '\n')
        : () => fs.renameSync(journal + '.next', journal);
      if (change === 'rotate') write(journal + '.next', [started, updated]);
      const retained = session();
      assert.equal(onOpen, null, 'the journal changed during the read');
      assert.equal(retained?.agentName, change === 'append' ? 'Survey' : 'append');
      assert.equal(retained.apiError.kind, change === 'append' ? 'crashed' : 'failed');
      const refreshed = session();
      assert.equal(refreshed.agentName, change);
      assert.equal(refreshed.apiError.kind, 'failed');
    }
  });
}

test('a quiet running Codex rollout stays listed while its events file grows during a read', t => {
  const job_id = 'codex_event_append';
  const thread = 'quiet-events';
  const journal = path.join(state('codex'), 'journal.jsonl');
  const events = path.join(state('codex'), 'jobs', job_id, 'events.jsonl');
  const rollout = 'rollout-2026-11-19T12-00-00-thread-run.jsonl';
  const file = path.join(home, '.codex', 'sessions', '2026', '11', '19', rollout.replace('thread-run', thread));
  const start = readLinuxProcess(process.pid)?.start;
  if (!start) return t.skip('requires Linux process start ticks');
  write(file, rows(fixture('codex/' + rollout).replaceAll('thread-run', thread)));
  fs.utimesSync(file, old / 1000, old / 1000);
  write(journal, [{ event: 'started', ts: old, job_id, pid: process.pid, pid_start: start, label: 'Quiet' }]);
  write(events, [{ type: 'thread.started', thread_id: thread }]);
  const codex = adapters.find(a => a.provider === 'codex');
  const poll = () => find(codex.getActiveSessions(threshold, { force: true }), thread);
  assert.equal(poll()?.agentName, 'Quiet');

  const open = fs.openSync;
  const change = t.mock.method(fs, 'openSync', function (target, ...args) {
    if (target === events) {
      change.mock.restore();
      fs.appendFileSync(events, '{"type":"turn.started"}\n');
    }
    return open.call(this, target, ...args);
  });
  assert.equal(poll()?.agentName, 'Quiet');
  assert.match(fs.readFileSync(events, 'utf8'), /turn\.started/);
  assert.equal(poll()?.agentName, 'Quiet');
  write(events, []);
  assert.equal(poll(), undefined, 'a verified empty event head clears the match');
});

test('the process chain must match both the owner and the lead start ticks', () => {
  const owner = { ownerPid: 17, ownerStart: '88' };
  const leads = new Map([['12:21', 'team-lead']]);
  const processes = new Map([[17, { start: '88', parentPid: 16 }], [16, { start: '65', parentPid: 12 }],
    [12, { start: '21', parentPid: 1 }]]);
  const parent = () => mcpProcessParent(owner, leads, pid => processes.get(pid));
  assert.equal(parent(), 'team-lead');
  processes.get(17).start = '89';
  assert.equal(parent(), null);
  processes.get(17).start = '88';
  processes.get(12).start = '23';
  assert.equal(parent(), null);
  processes.delete(16);
  assert.equal(parent(), null);
});
