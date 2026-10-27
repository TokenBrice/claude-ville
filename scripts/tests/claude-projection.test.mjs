import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { MODEL_REVISION } from '../../claudeville/src/config/models.generated.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'claude');

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude projects provider records, turn timing, and a canonical working set', () => {
  const root = makeTempDir('claudeville-claude-projection-');
  try {
    const project = path.join(root, 'work', 'projection');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'secret\n');
    fs.symlinkSync(outside, path.join(project, 'link-outside'));

    const now = Date.now();
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [
      { sessionId: 'projection-all', project, timestamp: now, model: 'claude-fable-5-1', display: 'Projection fixture' },
      { sessionId: 'projection-minimal', project, timestamp: now - 1, model: 'claude-sonnet-4-5', display: 'Minimal fixture' },
    ]);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'all-records.jsonl'), path.join(projectDir, 'projection-all.jsonl'));
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'minimal.jsonl'), path.join(projectDir, 'projection-minimal.jsonl'));

    const childScript = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { decorateSessionPresentation } = require('./claudeville/adapters/sessionPresentation');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000);
      const all = sessions.find(session => session.sessionId === 'projection-all');
      const minimal = sessions.find(session => session.sessionId === 'projection-minimal');
      process.stdout.write(JSON.stringify({ all, minimal: decorateSessionPresentation(minimal) }));
    `;
    const output = execFileSync(process.execPath, ['-e', childScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    });
    const { all, minimal } = JSON.parse(output);

    assert.deepEqual(all.cost, {
      usd: 12.34,
      source: 'provider',
      rateMatch: null,
      rateRevision: MODEL_REVISION,
      unknownModel: false,
    });
    assert.equal(all.estimatedCost, 12.34);
    assert.equal(all.linesAdded, 27);
    assert.equal(all.linesRemoved, 9);
    assert.equal(all.lastTurnDurationMs, 12345);
    assert.equal(all.lastPrompt.length, 200);
    assert.equal(all.todos.length, 13);
    assert.deepEqual(all.todos[1], { subject: 'Task 2', status: 'in_progress', phase: null });
    assert.equal(all.gitBranch, 'feature/transcript-projection');
    assert.equal(all.hookErrors, 2);
    assert.deepEqual(all.modelHistory.map(item => item.effort), ['low', 'high']);
    assert.ok(all.modelHistory.length <= 8);
    assert.equal(all.contextWindowMax, 1_000_000);
    assert.equal(all.tokenUsage.contextWindowMax, 1_000_000);
    assert.equal(all.signalSource, 'transcript');
    assert.equal(all.turnStartedAt, Date.parse('2026-09-01T10:00:00.000Z'));
    assert.deepEqual(all.workingSet.map(item => [item.path, item.op, item.source]), [
      ['~/outside/secret.js', 'write', 'transcript'],
      ['src/new.js', 'write', 'transcript'],
      ['src/index.js', 'write', 'transcript'],
      ['README.md', 'read', 'transcript'],
    ]);
    assert.ok(all.workingSet.every(item => Number.isFinite(item.at)));

    assert.equal(minimal.cost.source, 'estimate');
    assert.equal(minimal.cost.unknownModel, false);
    assert.ok(minimal.estimatedCost > 0);
    assert.equal(minimal.lastPrompt, null);
    assert.deepEqual(minimal.todos, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PV-1: `api-request-blob` copies carry `message.role` and no timestamp, and
// subagent files hold them without `isSidechain`. Only user and assistant
// records are turns.
test('Claude api-request records never become turns', () => {
  const root = makeTempDir('claudeville-claude-blob-');
  try {
    const project = path.join(root, 'work', 'blob');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'blob-main', 'subagents'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'api-request-blob.jsonl'), path.join(projectDir, 'blob-main.jsonl'));
    fs.copyFileSync(
      path.join(FIXTURE_ROOT, 'api-request-blob-child.jsonl'),
      path.join(projectDir, 'blob-main', 'subagents', 'agent-blobchild.jsonl'),
    );
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [
      { sessionId: 'blob-main', project, timestamp: Date.now(), display: 'Blob fixture' },
    ]);

    const childScript = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000);
      const main = sessions.find(session => session.sessionId === 'blob-main');
      const child = sessions.find(session => session.sessionId === 'subagent-blobchild');
      const detail = adapter.getSessionDetail('blob-main', ${JSON.stringify(project)});
      process.stdout.write(JSON.stringify({ main, child, detail }));
      adapter.shutdown();
    `;
    const { main, child, detail } = JSON.parse(execFileSync(process.execPath, ['-e', childScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    }));

    // A closed turn stays closed behind the copies a later request writes.
    assert.equal(main.turnState, 'awaiting_input');
    assert.equal(main.signalCertainty, 'observed');
    assert.deepEqual(main.sendMessages.map(edge => [edge.recipient, edge.ts]), [
      ['researcher', '2026-09-01T13:03:05.000Z'],
    ]);
    assert.deepEqual(detail.toolHistory.map(row => [row.tool, row.ts]), [
      ['Agent', '2026-09-01T13:00:05.000Z'],
      ['SendMessage', '2026-09-01T13:03:05.000Z'],
    ]);
    assert.ok(detail.messages.length > 0);
    assert.ok(detail.messages.every(message => ['user', 'assistant'].includes(message.role) && message.ts));

    // A subagent's pending tool stays pending behind its unflagged copies.
    assert.equal(child.turnState, 'tool_pending');
    assert.equal(child.pendingTool, 'Bash');
    assert.equal(child.pendingSince, Date.parse('2026-09-01T13:00:45.000Z'));
    assert.equal(child.agentName, 'Survey the parser');
    assert.equal(child.subagentKind, 'Explore');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PV-2 (Q2): a lead that closes its turn while its own background crew
// works is waiting on that crew, not on you. Real shapes: an async `Agent`
// launch, a `run_in_background` build, a watch ended by `TaskStop`, a queued
// `<task-notification>` and its delivery as a user record.
test('PV-2: a closed turn waits on its own background crew until the crew reports back', async () => {
  const { resolveAgentStatus } = await import('../../claudeville/src/domain/services/StatusResolver.js');
  const root = makeTempDir('claudeville-claude-crew-');
  try {
    const project = path.join(root, 'work', 'crew');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    fs.mkdirSync(project, { recursive: true });
    const lines = fs.readFileSync(path.join(FIXTURE_ROOT, 'background-crew.jsonl'), 'utf8')
      .replaceAll('__PROJECT__', project).trimEnd().split('\n');
    const mainFile = path.join(projectDir, 'crew-main.jsonl');
    const childFile = path.join(projectDir, 'crew-main', 'subagents', 'agent-crewchild.jsonl');
    fs.mkdirSync(path.dirname(childFile), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'background-crew-child.jsonl'), childFile);
    const now = Date.parse('2026-09-01T14:02:10.000Z');
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [
      { sessionId: 'crew-main', project, timestamp: now, display: 'Crew fixture' },
    ]);

    const childScript = `
      const fs = require('fs');
      Date.now = () => ${now};
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const lines = ${JSON.stringify(lines)};
      const adapter = new ClaudeAdapter();
      const at = (count, childAgeMs = 0) => {
        fs.writeFileSync(${JSON.stringify(mainFile)}, lines.slice(0, count).join('\\n') + '\\n');
        const childAt = (${now} - childAgeMs) / 1000;
        fs.utimesSync(${JSON.stringify(childFile)}, childAt, childAt);
        const main = adapter.getActiveSessions(2 * 60 * 1000).find(session => session.sessionId === 'crew-main');
        return { turnState: main.turnState, awaitingSince: main.awaitingSince, backgroundPending: main.backgroundPending };
      };
      const cuts = {
        closed: at(10),
        childQuiet: at(10, 10 * 60 * 1000),
        queuedNotice: at(11),
        crewHome: at(15),
      };
      adapter.shutdown();
      process.stdout.write(JSON.stringify(cuts));
    `;
    const cuts = JSON.parse(execFileSync(process.execPath, ['-e', childScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    }));
    const status = cut => resolveAgentStatus({ status: 'active', lastActivity: now, ...cut }, { now });

    // The agent and the build are out; the watch was stopped.
    assert.equal(cuts.closed.turnState, 'awaiting_input');
    assert.deepEqual(cuts.closed.backgroundPending, {
      count: 2, kinds: ['agent', 'bash'], since: Date.parse('2026-09-01T14:00:02.000Z'),
    });
    assert.equal(status(cuts.closed), 'working', 'waiting on crew is working-family, never COMPLETED');
    // An agent counts only while its own transcript is active.
    assert.deepEqual(cuts.childQuiet.backgroundPending, {
      count: 1, kinds: ['bash'], since: Date.parse('2026-09-01T14:00:04.000Z'),
    });
    // The queued notice already ends the build, before the lead reads it.
    assert.equal(cuts.queuedNotice.turnState, 'awaiting_input');
    assert.deepEqual(cuts.queuedNotice.backgroundPending?.kinds, ['agent']);
    // With the crew home, the closed turn is the user's move again.
    assert.equal(cuts.crewHome.turnState, 'awaiting_input');
    assert.equal(cuts.crewHome.backgroundPending, null);
    assert.equal(status(cuts.crewHome), 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
