#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = buildOpenCodeFixture();
if (fixture) {
  process.env.CLAUDEVILLE_OPENCODE_STATE_DIR = fixture.stateDir;
  process.env.CLAUDEVILLE_OPENCODE_CONFIG_DIR = fixture.configDir;
  process.env.CLAUDEVILLE_OPENCODE_DB = fixture.dbPath;
}

const {
  getSessionDetailByProvider,
  isKnownSessionDetailProvider,
  normalizeDetail,
  normalizeSession,
} = require('../../claudeville/adapters');
const { OpenCodeAdapter } = require('../../claudeville/adapters/opencode');

const now = Date.now();

const rawSession = {
  sessionId: 123,
  provider: 'codex',
  project: '/tmp/claude-ville',
  model: '',
  status: '',
  lastActivity: String(now),
  tokens: { input_tokens: 10, output_tokens: 2 },
};

const normalizedSession = normalizeSession(rawSession);
assert.equal(normalizedSession.sessionId, '123');
assert.equal(normalizedSession.provider, 'codex');
assert.equal(normalizedSession.model, 'codex');
assert.equal(normalizedSession.status, 'active');
assert.equal(normalizedSession.lastActivity, now);
assert.deepEqual(normalizedSession.gitEvents, []);
assert.deepEqual(normalizedSession.tokenUsage, rawSession.tokens);

const normalizedOpenCodeSession = normalizeSession({
  sessionId: 'opencode-fixture',
  provider: 'opencode',
  model: '',
  lastActivity: String(now),
});
assert.equal(normalizedOpenCodeSession.provider, 'opencode');
assert.equal(normalizedOpenCodeSession.model, 'opencode');

const normalizedDetail = normalizeDetail({
  sessionId: 123,
  provider: 'gemini',
  toolHistory: null,
  messages: 'not-array',
  usage: { input: 1, output: 2 },
}, { project: '/tmp/project' });
assert.equal(normalizedDetail.sessionId, '123');
assert.equal(normalizedDetail.provider, 'gemini');
assert.equal(normalizedDetail.project, '/tmp/project');
assert.deepEqual(normalizedDetail.toolHistory, []);
assert.deepEqual(normalizedDetail.messages, []);
assert.deepEqual(normalizedDetail.tokenUsage, { input: 1, output: 2 });

assert.equal(isKnownSessionDetailProvider('claude'), true);
assert.equal(isKnownSessionDetailProvider('git'), true);
assert.equal(isKnownSessionDetailProvider('opencode'), true);
assert.equal(isKnownSessionDetailProvider('unknown-provider'), false);

const gitDetail = getSessionDetailByProvider('git', 'git-repo-fixture', '/tmp/project');
assert.equal(gitDetail.provider, 'git');
assert.equal(gitDetail.sessionId, 'git-repo-fixture');
assert.equal(gitDetail.project, '/tmp/project');
assert.deepEqual(gitDetail.toolHistory, []);
assert.deepEqual(gitDetail.messages, []);
assert.equal(typeof gitDetail.reason, 'string');

if (fixture) {
  const adapter = new OpenCodeAdapter();
  assert.equal(adapter.isAvailable(), true);

  const sessions = adapter.getActiveSessions(10 * 60 * 1000);
  const parent = sessions.find((session) => session.sessionId === 'opencode-ses_parent');
  const child = sessions.find((session) => session.sessionId === 'opencode-ses_child');

  assert.ok(parent);
  assert.equal(parent.provider, 'opencode');
  assert.equal(parent.model, 'deepseek/deepseek-v4-pro');
  assert.equal(parent.agentName, 'build');
  assert.equal(parent.agentType, 'main');
  assert.equal(parent.project, '/tmp/claude-ville');
  assert.equal(parent.lastTool, 'Bash');
  assert.equal(parent.lastToolInput, 'Commit fixture');
  assert.equal(parent.lastMessage, 'Done.');
  assert.equal(parent.tokenUsage.input, 100);
  assert.equal(parent.tokenUsage.output, 20);
  assert.equal(parent.tokenUsage.cacheRead, 400);
  assert.equal(parent.tokenUsage.contextWindow, 520);
  assert.equal(parent.tokenUsage.contextWindowMax, 1000000);
  assert.equal(parent.gitEvents.length, 1);
  assert.equal(parent.gitEvents[0].type, 'commit');
  assert.equal(parent.gitEvents[0].success, true);

  assert.ok(child);
  assert.equal(child.agentType, 'sub-agent');
  assert.equal(child.parentSessionId, 'opencode-ses_parent');
  assert.equal(child.model, 'deepseek/deepseek-v4-flash');
  assert.equal(child.lastTool, 'TodoWrite');
  assert.equal(child.tokenUsage.contextWindowMax, 256000);

  const detail = adapter.getSessionDetail('opencode-ses_parent', '/tmp/claude-ville');
  assert.equal(detail.provider, 'opencode');
  assert.equal(detail.sessionId, 'opencode-ses_parent');
  assert.equal(detail.toolHistory.length, 1);
  assert.equal(detail.toolHistory[0].tool, 'Bash');
  assert.equal(detail.messages.at(-1).text, 'Done.');
  assert.equal(detail.tokenUsage.reportedCost, 0.01);

  const registryDetail = getSessionDetailByProvider('opencode', 'opencode-ses_parent', '/tmp/claude-ville', { force: true });
  assert.equal(registryDetail.provider, 'opencode');
  assert.equal(registryDetail.sessionId, 'opencode-ses_parent');

  runOpenCodeCliFallbackFixture(fixture);

  fs.rmSync(fixture.root, { recursive: true, force: true });
} else {
  console.log('opencode adapter fixture skipped: node:sqlite unavailable');
}

console.log('adapter fixture normalization checks passed');

function buildOpenCodeFixture() {
  let sqlite = null;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return null;
  }
  if (!sqlite?.DatabaseSync) return null;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-opencode-fixture-'));
  const stateDir = path.join(root, 'state');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });

  const dbPath = path.join(stateDir, 'opencode.db');
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        sandboxes text NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_archived integer,
        agent text,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL
      );
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);

    const now = Date.now();
    db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)').run(
      'proj_fixture',
      '/tmp/claude-ville',
      now,
      now,
      '{}',
    );

    const insertSession = db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
        agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(
      'ses_parent',
      'proj_fixture',
      null,
      'parent',
      '/tmp/claude-ville',
      'Fixture parent',
      '1.15.3',
      now - 5000,
      now,
      'build',
      JSON.stringify({ id: 'deepseek-v4-pro', providerID: 'deepseek' }),
      0.01,
      100,
      20,
      3,
      400,
      0,
    );
    insertSession.run(
      'ses_child',
      'proj_fixture',
      'ses_parent',
      'child',
      '/tmp/claude-ville',
      'Fixture child',
      '1.15.3',
      now - 4000,
      now - 1000,
      'deepseekV4-flash',
      JSON.stringify({ id: 'deepseek-v4-flash', providerID: 'deepseek', variant: 'default' }),
      0.002,
      12,
      4,
      0,
      30,
      0,
    );

    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
    insertMessage.run('msg_user', 'ses_parent', now - 4500, now - 4500, JSON.stringify({ role: 'user' }));
    insertPart.run('prt_user', 'msg_user', 'ses_parent', now - 4400, now - 4400, JSON.stringify({ type: 'text', text: 'Please commit.' }));
    insertMessage.run('msg_assistant', 'ses_parent', now - 3000, now, JSON.stringify({ role: 'assistant' }));
    insertPart.run('prt_tool', 'msg_assistant', 'ses_parent', now - 2500, now - 2000, JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_fixture',
      state: {
        status: 'completed',
        input: { description: 'Commit fixture', command: 'git commit -m "fixture"' },
        metadata: { exit: 0 },
        time: { end: now - 2000 },
      },
    }));
    insertPart.run('prt_step', 'msg_assistant', 'ses_parent', now - 1500, now - 1500, JSON.stringify({
      type: 'step-finish',
      tokens: { total: 520 },
    }));
    insertPart.run('prt_text', 'msg_assistant', 'ses_parent', now - 1000, now - 900, JSON.stringify({ type: 'text', text: 'Done.' }));

    insertMessage.run('msg_child', 'ses_child', now - 2000, now - 1000, JSON.stringify({ role: 'assistant' }));
    insertPart.run('prt_child_tool', 'msg_child', 'ses_child', now - 1500, now - 1000, JSON.stringify({
      type: 'tool',
      tool: 'todowrite',
      state: { status: 'pending', input: { description: 'Update todos' } },
    }));
  } finally {
    db.close();
  }

  return { root, stateDir, configDir, dbPath };
}

function runOpenCodeCliFallbackFixture(fixture) {
  try {
    execFileSync('sqlite3', ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
  } catch {
    console.log('opencode sqlite3 CLI fallback fixture skipped: sqlite3 unavailable');
    return;
  }

  const script = `
    const assert = require('node:assert/strict');
    const { OpenCodeAdapter } = require('./claudeville/adapters/opencode');
    const adapter = new OpenCodeAdapter();
    assert.equal(adapter.isAvailable(), true);
    const sessions = adapter.getActiveSessions(10 * 60 * 1000);
    const parent = sessions.find((session) => session.sessionId === 'opencode-ses_parent');
    assert.ok(parent);
    assert.equal(parent.model, 'deepseek/deepseek-v4-pro');
    assert.equal(parent.lastTool, 'Bash');
    assert.equal(parent.tokenUsage.contextWindow, 520);
    assert.equal(parent.gitEvents.length, 1);
    const detail = adapter.getSessionDetail('opencode-ses_parent', '/tmp/claude-ville');
    assert.equal(detail.toolHistory[0].tool, 'Bash');
  `;

  execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      CLAUDEVILLE_OPENCODE_STATE_DIR: fixture.stateDir,
      CLAUDEVILLE_OPENCODE_CONFIG_DIR: fixture.configDir,
      CLAUDEVILLE_OPENCODE_DB: fixture.dbPath,
      CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY: 'cli',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
}
