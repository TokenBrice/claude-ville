// ClaudeVille v0.69 Lane A — T3 Code Support tests:
// - Centralized T3 SQLite helpers & caching (t3code.js)
// - GLM-5.4 ACP support via T3 DB + standalone JSON fallback + probe filtering + todowrite (glm.js)
// - Antigravity `.db` lock root-vs-subagent filtering, T3 delegate parentConvId, cross-provider
//   keepalive/backgroundPending, non-Linux activeRun survival, and update_steps -> todos (antigravity.js)
// - Claude TodoWrite `content`, TaskCreate/TaskUpdate, task-group mirroring, and T3 lineage/delegates (claude.js)
// - Codex T3 lineage & parent keepalive/backgroundPending (codex.js)
// - Server normalizeTodos + ToolIdentity + CarriedArtifact + RitualConductor parity.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import {
  classifyTool,
  toolActionCategory,
  toolCategory,
  toolIcon,
} from '../../claudeville/src/domain/services/ToolIdentity.js';
import { resolveCarriedArtifact } from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import { RitualConductor } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';
import { resolveAgentStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const { normalizeSession } = require('../../claudeville/adapters/index.js');
const { readFailures } = require('../../claudeville/adapters/shared.js');
const {
  AntigravityAdapter,
  reduceAntigravityTranscript,
} = require('../../claudeville/adapters/antigravity.js');
const {
  projectClaudeExecution,
  _test: claudeTest,
} = require('../../claudeville/adapters/claude.js');
const t3code = require('../../claudeville/adapters/t3code.js');

let nodeSqlite = null;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  // node:sqlite unavailable
}

function writeFile(target, content, mtimeMs = Date.now()) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  const date = new Date(mtimeMs);
  fs.utimesSync(target, date, date);
}

function createFullT3Db(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new nodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_ordinal INTEGER NOT NULL,
      root_node_id TEXT NOT NULL DEFAULT 'node-1',
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL DEFAULT 'pt-1',
      provider_turn_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      driver TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL DEFAULT 'node-1',
      run_attempt_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      parent_item_id TEXT,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      role TEXT NOT NULL,
      streaming INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  return db;
}

function withTempHome(prefix, fn) {
  const tmp = makeTempDir(prefix);
  const savedHome = process.env.HOME;
  const savedRoot = process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
  const savedGlmAcp = process.env.CLAUDEVILLE_GLM_ACP_SESSION_DIR;
  const savedHobotnicaHome = process.env.HOBOTNICA_HOME;
  try {
    process.env.HOME = tmp;
    delete process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
    delete process.env.CLAUDEVILLE_GLM_ACP_SESSION_DIR;
    delete process.env.HOBOTNICA_HOME;
    t3code.clearT3Cache();
    return fn(tmp);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedRoot !== undefined) process.env.CLAUDEVILLE_ANTIGRAVITY_DIR = savedRoot;
    if (savedGlmAcp !== undefined) process.env.CLAUDEVILLE_GLM_ACP_SESSION_DIR = savedGlmAcp;
    if (savedHobotnicaHome === undefined) delete process.env.HOBOTNICA_HOME;
    else process.env.HOBOTNICA_HOME = savedHobotnicaHome;
    t3code.clearT3Cache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── 1. t3code.js helpers & graceful no-op ───────────────

test('t3code.js gracefully no-ops when DB is missing without poisoning readFailures', () => {
  withTempHome('cv-v069-t3-missing-', () => {
    const failuresBefore = readFailures.count;
    assert.equal(t3code.t3StateDbExists(), false);
    assert.deepEqual(t3code.T3_PARENT_PREFIX, {
      claudeAgent: '',
      antigravity: 'antigravity-',
      codex: 'codex-',
      acpRegistry_glm_agent: 'zai-',
    });
    assert.equal(t3code.readT3Lineage('antigravity', ['abc']).size, 0);
    assert.equal(t3code.readT3ActiveDelegates().size, 0);
    assert.equal(t3code.readT3RootThreadState('antigravity', ['abc']).size, 0);
    assert.deepEqual(t3code.readT3AcpGlmSessions(60_000), []);
    assert.equal(readFailures.count, failuresBefore, 'missing DB never increments readFailures');
  });
});

test('t3code.js reads lineage, active delegates, root states, and invalidates cache on DB change', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  withTempHome('cv-v069-t3-helpers-', (tmp) => {
    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const now = Date.parse('2026-11-26T20:00:00Z');
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    const db = createFullT3Db(dbPath);
    const insThread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (?, 'proj-1', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insRun = db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insAtt = db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES (?, ?, ?, 1, ?, ?, ?)`);

    // Root Antigravity parent (unsettled)
    insThread.run('th-parent', 'Main Orch', 'antigravity', 'pt-parent', iso(600_000), iso(120_000), null, null, JSON.stringify({ titleRenamed: true }));
    insRun.run('run-p1', 'th-parent', 1, 'antigravity', 'pt-parent', 'completed', iso(600_000), iso(300_000), JSON.stringify({ startedAt: iso(599_000) }));
    insAtt.run('att-p1', 'th-parent', 'run-p1', 'antigravity', 'pt-parent', JSON.stringify({ nativeThreadId: 'parent-conv-1' }));

    // Settled root, unsettled-after-settled root, archived root, fork (not subagent)
    insThread.run('th-settled', 'Done Thread', 'antigravity', 'pt-s', iso(600_000), iso(300_000), null, null, JSON.stringify({ settledAt: iso(300_000) }));
    insRun.run('run-s1', 'th-settled', 1, 'antigravity', 'pt-s', 'completed', iso(600_000), iso(300_000), JSON.stringify({}));
    insAtt.run('att-s1', 'th-settled', 'run-s1', 'antigravity', 'pt-s', JSON.stringify({ nativeThreadId: 'settled-conv' }));

    insThread.run('th-reopened', 'Reopened Thread', 'antigravity', 'pt-r', iso(600_000), iso(10_000), null, null, JSON.stringify({ settledAt: iso(300_000), unsettledAt: iso(10_000) }));
    insRun.run('run-r1', 'th-reopened', 1, 'antigravity', 'pt-r', 'running', iso(10_000), null, JSON.stringify({ startedAt: iso(9_000) }));
    insAtt.run('att-r1', 'th-reopened', 'run-r1', 'antigravity', 'pt-r', JSON.stringify({ nativeThreadId: 'reopened-conv' }));

    insThread.run('th-archived', 'Archived', 'antigravity', 'pt-a', iso(600_000), iso(300_000), iso(200_000), null, JSON.stringify({}));
    insRun.run('run-a1', 'th-archived', 1, 'antigravity', 'pt-a', 'completed', iso(600_000), iso(300_000), JSON.stringify({}));
    insAtt.run('att-a1', 'th-archived', 'run-a1', 'antigravity', 'pt-a', JSON.stringify({ nativeThreadId: 'archived-conv' }));

    insThread.run('th-fork', 'Forked Thread', 'antigravity', 'pt-f', iso(600_000), iso(10_000), null, null, JSON.stringify({ lineage: { parentThreadId: 'th-parent', relationshipToParent: 'fork' } }));
    insRun.run('run-f1', 'th-fork', 1, 'antigravity', 'pt-f', 'running', iso(10_000), null, JSON.stringify({ startedAt: iso(9_000) }));
    insAtt.run('att-f1', 'th-fork', 'run-f1', 'antigravity', 'pt-f', JSON.stringify({ nativeThreadId: 'fork-conv' }));

    // Active delegates under th-parent: Claude (running) + GLM (queued) + Codex (completed -> excluded)
    insThread.run('th-del-claude', 'Claude Lane', 'claudeAgent', 'pt-dc', iso(50_000), iso(5_000), null, null, JSON.stringify({
      titleRenamed: false,
      lineage: { parentThreadId: 'th-parent', relationshipToParent: 'subagent' },
    }));
    insRun.run('run-dc1', 'th-del-claude', 1, 'claudeAgent', 'pt-dc', 'running', iso(50_000), null, JSON.stringify({ startedAt: iso(49_000) }));
    insAtt.run('att-dc1', 'th-del-claude', 'run-dc1', 'claudeAgent', 'pt-dc', JSON.stringify({ nativeThreadId: 'claude-child-1' }));

    insThread.run('th-del-glm', 'GLM Lane', 'acpRegistry_glm_agent', 'pt-dg', iso(20_000), iso(2_000), null, null, JSON.stringify({
      titleRenamed: true,
      lineage: { parentThreadId: 'th-parent', relationshipToParent: 'subagent' },
    }));
    insRun.run('run-dg1', 'th-del-glm', 1, 'acpRegistry_glm_agent', 'pt-dg', 'queued', iso(20_000), null, JSON.stringify({}));
    insAtt.run('att-dg1', 'th-del-glm', 'run-dg1', 'acpRegistry_glm_agent', 'pt-dg', JSON.stringify({ nativeThreadId: 'glm-child-1' }));

    insThread.run('th-del-done', 'Finished Codex', 'codex', 'pt-dx', iso(90_000), iso(60_000), null, null, JSON.stringify({
      lineage: { parentThreadId: 'th-parent', relationshipToParent: 'subagent' },
    }));
    insRun.run('run-dx1', 'th-del-done', 1, 'codex', 'pt-dx', 'completed', iso(90_000), iso(60_000), JSON.stringify({}));
    insAtt.run('att-dx1', 'th-del-done', 'run-dx1', 'codex', 'pt-dx', JSON.stringify({ nativeThreadId: 'codex-done-1' }));
    db.close();

    // Lineage
    const claudeLineage = t3code.readT3Lineage('claudeAgent', ['claude-child-1']);
    assert.deepEqual(claudeLineage.get('claude-child-1'), {
      parentSessionId: 'antigravity-parent-conv-1',
      parentProvider: 'antigravity',
      parentNative: 'parent-conv-1',
      title: 'Claude Lane',
      titleRenamed: false,
      relationshipToParent: 'subagent',
    });
    const agyLineage = t3code.readT3Lineage('antigravity', ['fork-conv']);
    assert.equal(agyLineage.size, 0, 'fork threads are not subagent lineage');

    // Active delegates grouped by parent session ID
    const delegates = t3code.readT3ActiveDelegates();
    const parentDel = delegates.get('antigravity-parent-conv-1');
    assert.ok(parentDel);
    assert.equal(parentDel.count, 2, 'only active subagents count (not completed, not fork)');
    assert.equal(parentDel.since, now - 49_000, 'earliest startedAt across active children');

    // Root thread states
    const states = t3code.readT3RootThreadState('antigravity', ['parent-conv-1', 'settled-conv', 'reopened-conv', 'archived-conv', 'fork-conv']);
    assert.deepEqual(states.get('parent-conv-1'), {
      settledAt: null, archivedAt: null, deletedAt: null, isSubagent: false, activeRun: false,
    });
    assert.equal(Boolean(states.get('settled-conv').settledAt), true);
    assert.equal(states.get('reopened-conv').settledAt, null, 'newer unsettledAt clears settledAt');
    assert.equal(states.get('reopened-conv').activeRun, true);
    assert.equal(Boolean(states.get('archived-conv').archivedAt), true);
    assert.equal(states.get('fork-conv').isSubagent, false);

    // Mutate DB and verify cache invalidates
    const db2 = new nodeSqlite.DatabaseSync(dbPath);
    db2.prepare("UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ? WHERE run_id = 'run-dc1'").run(iso(1_000));
    db2.close();
    const bump = new Date(now + 5_000);
    fs.utimesSync(dbPath, bump, bump);
    const delegatesAfter = t3code.readT3ActiveDelegates();
    assert.equal(delegatesAfter.get('antigravity-parent-conv-1').count, 1, 'cache invalidated on DB mtime/size update');
  });
});

// ─── 2. GLM-5.4 ACP support (T3 DB + standalone JSON + probe filter + todowrite) ─

test('GlmAdapter merges T3 acpRegistry_glm_agent and standalone JSON, filters 4.9KB probes, and extracts todowrite + uncached tokens', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  const tmp = makeTempDir('cv-v069-glm-acp-');
  try {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const project = path.join(tmp, 'repo');
    const worktree = path.join(tmp, 'wt-glm');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const db = createFullT3Db(dbPath);
    db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?)').run('proj-1', 'ClaudeVille', project);

    // Parent Antigravity thread
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-orch', 'proj-1', 'Lead Orch', 'antigravity', 'pt-orch', ?, ?, ?)`).run(iso(300_000), iso(10_000), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES ('run-orch-1', 'th-orch', 1, 'antigravity', 'pt-orch', 'running', ?, ?)`).run(iso(300_000), JSON.stringify({ startedAt: iso(300_000) }));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES ('att-orch-1', 'th-orch', 'run-orch-1', 1, 'antigravity', 'pt-orch', ?)`).run(JSON.stringify({ nativeThreadId: 'orch-agy-1' }));

    // T3 GLM-5.4 delegate thread (actively running with pending command, todowrite, tokens, workingSet, gitEvent)
    const glmNative1 = '12bd4d2c-439a-43fd-ace2-626d08d96450';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-glm-1', 'proj-1', 'Council 4 (GLM 5.4 high)', 'acpRegistry_glm_agent', 'pt-glm-1', ?, ?, ?)`).run(
      iso(180_000),
      iso(5_000),
      JSON.stringify({
        titleRenamed: true,
        worktreePath: worktree,
        branch: 'feat/glm-acp',
        modelSelection: { instanceId: 'acpRegistry_glm_agent', model: 'glm-5.4', options: [{ id: 'thought_level', value: 'high' }] },
        lineage: { parentThreadId: 'th-orch', relationshipToParent: 'subagent' },
      }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-glm-1', 'th-glm-1', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(5_000),
      JSON.stringify({
        nativeThreadRef: { driver: 'acpRegistry', nativeId: glmNative1, strength: 'strong' },
        contextUsage: { usedTokens: 363719, maxTokens: 1_000_000 },
      }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES ('run-glm-1', 'th-glm-1', 1, 'acpRegistry_glm_agent', 'pt-glm-1', 'running', ?, ?)`).run(
      iso(60_000),
      JSON.stringify({ startedAt: iso(59_000), modelSelection: { model: 'glm-5.4', options: [{ id: 'thought_level', value: 'high' }] } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES ('att-glm-1', 'th-glm-1', 'run-glm-1', 1, 'acpRegistry_glm_agent', 'pt-glm-1', ?)`).run(
      JSON.stringify({ nativeThreadId: glmNative1 }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, ordinal, status, started_at, completed_at, payload_json)
      VALUES ('turn-g1', 'th-glm-1', 'pt-glm-1', 1, 'completed', ?, ?, ?)`).run(
      iso(59_000),
      iso(30_000),
      JSON.stringify({
        turnTokenUsage: { inputTokens: 1_167_119, cachedInputTokens: 1_150_016, outputTokens: 14_630, reasoningTokens: 2_332 },
      }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, ordinal, status, started_at, completed_at, payload_json)
      VALUES ('turn-g2', 'th-glm-1', 'pt-glm-1', 2, 'running', ?, NULL, ?)`).run(
      iso(25_000),
      JSON.stringify({
        turnTokenUsage: { inputTokens: 200_000, cachedInputTokens: 180_000, outputTokens: 5_000, reasoningTokens: 1_000 },
      }),
    );

    const insItem = db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, 'th-glm-1', 'run-glm-1', ?, ?, ?, ?, ?)`);
    insItem.run('it-1', 1, 'reasoning', 'completed', iso(20_000), JSON.stringify({
      type: 'reasoning', text: 'Auditing the GLM ACP adapter integration', startedAt: iso(21_000), completedAt: iso(20_000),
    }));
    insItem.run('it-2', 2, 'dynamic_tool', 'completed', iso(15_000), JSON.stringify({
      type: 'dynamic_tool', toolName: 'Read', input: { path: path.join(worktree, 'src', 'a.js') }, startedAt: iso(16_000), completedAt: iso(15_000),
    }));
    insItem.run('it-3', 3, 'file_change', 'completed', iso(12_000), JSON.stringify({
      type: 'file_change', fileName: path.join(worktree, 'src', 'b.js'), startedAt: iso(13_000), completedAt: iso(12_000),
    }));
    insItem.run('it-4', 4, 'command_execution', 'completed', iso(10_000), JSON.stringify({
      type: 'command_execution',
      input: 'git commit -m "feat: glm acp"',
      output: '[feat/glm-acp 1234567] feat: glm acp\n 1 file changed',
      exitCode: 0,
      startedAt: iso(11_000),
      completedAt: iso(10_000),
      nativeItemRef: { nativeId: 'call_git_1' },
    }));
    insItem.run('it-5', 5, 'dynamic_tool', 'completed', iso(8_000), JSON.stringify({
      type: 'dynamic_tool',
      toolName: 'Task list: Auditing crowd simulation modules',
      input: {
        todos: [
          { content: 'Audit crowd sim', status: 'completed', active_form: 'Auditing crowd sim' },
          { content: 'Check label solvers', status: 'in_progress', active_form: 'Checking label solvers' },
          { content: 'Write report', status: 'pending' },
        ],
      },
      startedAt: iso(8_000),
      completedAt: iso(8_000),
      nativeItemRef: { nativeId: 'call_todo_1' },
    }));
    insItem.run('it-6', 6, 'command_execution', 'in_progress', iso(3_000), JSON.stringify({
      type: 'command_execution',
      input: 'npm run validate:quick',
      startedAt: iso(4_000),
    }));

    db.prepare(`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, created_at, updated_at, payload_json)
      VALUES ('msg-u1', 'th-glm-1', 'run-glm-1', 'user', ?, ?, ?)`).run(
      iso(60_000),
      iso(60_000),
      JSON.stringify({ role: 'user', text: '<t3_code_instructions>internal</t3_code_instructions>\n<user_request>Review the adapter</user_request>' }),
    );

    // Failed T3 GLM thread (tests apiError)
    const glmFailedId = '22222222-3333-4444-8555-666666666666';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-glm-fail', 'proj-1', 'Failed GLM', 'acpRegistry_glm_agent', 'pt-glm-fail', ?, ?, ?)`).run(
      iso(40_000),
      iso(5_000),
      JSON.stringify({ titleRenamed: false, modelSelection: { model: 'glm-5.4', options: [{ id: 'thought_level', value: 'max' }] } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-glm-fail', 'th-glm-fail', 'acpRegistry_glm_agent', 'idle', ?, ?, 'acpRegistry')`).run(
      iso(5_000),
      JSON.stringify({ nativeThreadRef: { nativeId: glmFailedId } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-glm-fail', 'th-glm-fail', 1, 'acpRegistry_glm_agent', 'pt-glm-fail', 'failed', ?, ?, ?)`).run(
      iso(40_000),
      iso(5_000),
      JSON.stringify({ startedAt: iso(39_000), completedAt: iso(5_000) }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('it-err', 'th-glm-fail', 'run-glm-fail', 1, 'error', 'failed', ?, ?)`).run(
      iso(5_000),
      JSON.stringify({ type: 'error', failure: { class: 'usage_limit', code: 429 } }),
    );
    db.close();

    // Standalone ~/.local/state/glm-acp-agent/sessions/:
    // 1. Duplicate of glmNative1 -> MUST be deduped against T3 DB
    // 2. Empty 4.9KB capability probe (only role: 'system') -> MUST be filtered out
    // 3. Real standalone GLM-5.4 session with todowrite -> MUST be discovered
    const acpDir = path.join(tmp, '.local', 'state', 'glm-acp-agent', 'sessions');
    writeFile(path.join(acpDir, `${glmNative1}.json`), JSON.stringify({
      sessionId: glmNative1,
      cwd: worktree,
      model: 'glm-5.4',
      thoughtLevel: 'high',
      updatedAt: iso(4_000),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Review the adapter' },
      ],
    }), now - 4_000);

    const probeId = 'fe0ca711-d080-4191-aa54-1f18b699654a';
    writeFile(path.join(acpDir, `${probeId}.json`), JSON.stringify({
      sessionId: probeId,
      cwd: tmp,
      model: 'glm-5.3',
      thoughtLevel: 'max',
      updatedAt: iso(2_000),
      messages: [{ role: 'system', content: 'System prompt '.repeat(320) }],
    }), now - 2_000);

    const standaloneId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    writeFile(path.join(acpDir, `${standaloneId}.json`), JSON.stringify({
      sessionId: standaloneId,
      cwd: project,
      title: 'Standalone GLM-5.4',
      model: 'glm-5.4',
      thoughtLevel: 'max',
      updatedAt: iso(3_000),
      messages: [
        { role: 'system', content: 'You are GLM.' },
        { role: 'user', content: 'Inspect the build scripts' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Planning build script inspection',
          tool_calls: [
            {
              id: 'call_sa_todo',
              type: 'function',
              function: {
                name: 'todowrite',
                arguments: JSON.stringify({
                  todos: [
                    { content: 'Read package.json', status: 'completed', activeForm: 'Reading package.json' },
                    { content: 'Verify tests', status: 'in_progress', activeForm: 'Verifying tests' },
                  ],
                }),
              },
            },
            {
              id: 'call_sa_cmd',
              type: 'function',
              function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_sa_todo', content: 'ok' },
        { role: 'tool', tool_call_id: 'call_sa_cmd', content: 'Exit code: 0\n\nSTDOUT:\nok\n' },
        { role: 'assistant', content: 'All checks passed.' },
      ],
    }), now - 3_000);

    // Run in isolated child process so STATE_DIR points to a non-existent legacy dir
    const script = `
      const { GlmAdapter } = require('./claudeville/adapters/glm');
      const { normalizeSession } = require('./claudeville/adapters/index');
      const adapter = new GlmAdapter();
      const available = adapter.isAvailable();
      const raw = adapter.getActiveSessions(2 * 60 * 1000);
      const normalized = raw.map(s => normalizeSession(s));
      const detailT3 = adapter.getSessionDetail('zai-${glmNative1}', ${JSON.stringify(worktree)});
      const detailSa = adapter.getSessionDetail('zai-${standaloneId}', ${JSON.stringify(project)});
      const watchPaths = adapter.getWatchPaths({ sessions: raw });
      process.stdout.write(JSON.stringify({ available, raw, normalized, detailT3, detailSa, watchPaths }));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        CLAUDEVILLE_GLM_STATE_DIR: path.join(tmp, 'nonexistent-legacy-glm-mcp'),
      },
      encoding: 'utf8',
    }));

    assert.equal(out.available, true, 'available even without legacy glm-cc-mcp dir');
    assert.equal(out.raw.length, 3, '2 T3 GLM + 1 standalone (deduped duplicate + filtered probe)');
    assert.ok(!out.raw.some(s => s.sessionId === `zai-${probeId}`), 'empty 4.9KB system-only probe filtered out');

    const t3Sess = out.normalized.find(s => s.sessionId === `zai-${glmNative1}`);
    assert.ok(t3Sess);
    assert.equal(t3Sess.provider, 'zai');
    assert.equal(t3Sess.model, 'glm-5.4');
    assert.equal(t3Sess.reasoningEffort, 'high');
    assert.equal(t3Sess.displayModel, 'GLM 5.4 high');
    assert.equal(t3Sess.spriteId, 'agent.zai.glm');
    assert.equal(t3Sess.project, worktree);
    assert.equal(t3Sess.gitBranch, 'feat/glm-acp');
    assert.equal(t3Sess.agentName, 'Council 4 (GLM 5.4 high)');
    assert.equal(t3Sess.userNamed, true);
    assert.equal(t3Sess.parentSessionId, 'antigravity-orch-agy-1');
    assert.equal(t3Sess.agentType, 'sub-agent');
    assert.equal(t3Sess.subagentKind, 'delegate');
    assert.equal(t3Sess.turnState, 'tool_pending');
    assert.equal(t3Sess.pendingTool, 'run_command');
    assert.equal(t3Sess.lastTool, 'run_command');
    assert.equal(t3Sess.lastToolInput, 'npm run validate:quick');
    assert.equal(t3Sess.lastPrompt, 'Review the adapter');
    // Uncached input = (1_167_119 - 1_150_016) + (200_000 - 180_000) = 17_103 + 20_000 = 37_103
    assert.equal(t3Sess.tokenUsage.input, 37_103);
    assert.equal(t3Sess.tokenUsage.cacheRead, 1_330_016);
    assert.equal(t3Sess.tokenUsage.output, 19_630);
    assert.equal(t3Sess.tokenUsage.contextWindow, 363_719);
    assert.equal(t3Sess.tokenUsage.contextWindowMax, 1_000_000);
    assert.equal(t3Sess.todos.length, 3);
    assert.deepEqual(t3Sess.todos[1], { subject: 'Check label solvers', status: 'in_progress', phase: null });
    assert.deepEqual(t3Sess.workingSet.map(w => [w.path, w.op]), [['src/b.js', 'write'], ['src/a.js', 'read']]);
    assert.equal(t3Sess.lastResults.length, 1);
    assert.equal(t3Sess.lastResults[0].exitCode, 0);
    assert.ok(t3Sess.gitEvents.some(e => e.type === 'commit'));
    assert.equal(t3Sess.dialogue?.kind, 'plan');
    assert.equal(t3Sess.dialogue?.text, 'Checking label solvers');

    const failSess = out.normalized.find(s => s.sessionId === `zai-${glmFailedId}`);
    assert.equal(failSess.project, project, 'falls back to projection_projects.workspace_root');
    assert.equal(failSess.turnState, 'awaiting_input');
    assert.deepEqual(failSess.apiError, { kind: 'usage_limit', status: 429, at: failSess.awaitingSince });

    const saSess = out.normalized.find(s => s.sessionId === `zai-${standaloneId}`);
    assert.ok(saSess);
    assert.equal(saSess.model, 'glm-5.4');
    assert.equal(saSess.reasoningEffort, 'max');
    assert.equal(saSess.turnState, 'awaiting_input');
    assert.equal(saSess.todos.length, 2);
    assert.deepEqual(saSess.todos[1], { subject: 'Verify tests', status: 'in_progress', phase: null });
    assert.equal(saSess.lastResults[0]?.exitCode, 0);

    assert.ok(out.detailT3.toolHistory.length >= 4);
    assert.ok(out.detailSa.toolHistory.some(t => t.tool === 'todowrite'));
    assert.ok(out.watchPaths.some(p => p.path === acpDir && p.kind === 'discovery'), 'watches ~/.local/state/glm-acp-agent/sessions');
    assert.ok(!out.watchPaths.some(p => p.path.includes('statev2.sqlite')), 'never fs.watch on statev2.sqlite to avoid watch storms');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 3. Antigravity .db lock root-vs-subagent, T3 delegates, update_steps ─

test('Antigravity .db lock holds only unsettled non-archived root threads, never finished subagents, and tracks cross-provider T3 delegates', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  withTempHome('cv-v069-agy-db-lock-', (tmp) => {
    const now = Date.parse('2026-11-26T21:00:00Z');
    const quietMs = 15 * 60_000; // well past 2 min activeThresholdMs
    const at = (msAgo) => new Date(now - msAgo).toISOString();
    const acpDir = path.join(tmp, '.t3', 'userdata', 'providers', 'antigravity', 'inst1', 'antigravity-acp');
    const transcript = (id) => path.join(acpDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const dbFile = (id) => path.join(acpDir, 'conversations', `${id}.db`);
    const lines = (steps) => `${steps.map(s => JSON.stringify(s)).join('\n')}\n`;

    const ids = {
      rootIdle: '11111111-1111-4111-8111-111111111111',
      nativeFinished: '22222222-2222-4222-8222-222222222222',
      nativeThinking: '33333333-3333-4333-8333-333333333333',
      t3DelFinished: '44444444-4444-4444-8444-444444444444',
      t3DelThinking: '55555555-5555-4555-8555-555555555555',
      rootSettled: '66666666-6666-4666-8666-666666666666',
      rootArchived: '77777777-7777-4777-8777-777777777777',
      rootCrossParent: '88888888-8888-4888-8888-888888888888',
    };

    // rootIdle spawns nativeFinished + nativeThinking, then finishes its own turn
    writeFile(transcript(ids.rootIdle), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 60_000), content: 'Orchestrate work' },
      {
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs + 50_000), model: 'gemini-4-neon-xhigh',
        tool_calls: [
          { name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Done Worker"' } },
          { name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Thinking Worker"' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: at(quietMs + 45_000), content: `{"conversationId":"${ids.nativeFinished}"}` },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: at(quietMs + 44_000), content: `{"conversationId":"${ids.nativeThinking}"}` },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-neon-xhigh', content: 'Standing by.' },
    ]), now - quietMs);

    // nativeFinished: finished turn, even though agy acp keeps its .db locked!
    writeFile(transcript(ids.nativeFinished), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 40_000), content: 'Do research' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-neon-xhigh', content: 'Finished.' },
    ]), now - quietMs);

    // nativeThinking: open turn (silent >2min xhigh think)
    writeFile(transcript(ids.nativeThinking), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs), content: 'Deep analysis' },
    ]), now - quietMs);

    // t3DelFinished: finished T3 delegate under rootIdle, .db still locked!
    writeFile(transcript(ids.t3DelFinished), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 20_000), content: 'Old delegate' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-neon-xhigh', content: 'Done.' },
    ]), now - quietMs);

    // t3DelThinking: active T3 delegate under rootCrossParent, quiet >2min thinking
    writeFile(transcript(ids.t3DelThinking), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs), content: 'Long xhigh think' },
    ]), now - quietMs);

    for (const id of [ids.rootSettled, ids.rootArchived, ids.rootCrossParent]) {
      writeFile(transcript(id), lines([
        { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 10_000), content: 'Work' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-neon-xhigh', content: 'Done.' },
      ]), now - quietMs);
    }

    // Create .db files and POSIX READ locks for ALL of them to test the critical trap!
    const lockLines = Object.values(ids).map((id, idx) => {
      const p = dbFile(id);
      writeFile(p, 'sqlite-dummy', now - quietMs);
      const ino = fs.statSync(p).ino;
      return `${idx + 1}: POSIX  ADVISORY  READ 9001 103:06:${ino} 1073741826 1073742335`;
    });
    const procLocks = `${lockLines.join('\n')}\n`;

    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const db = createFullT3Db(dbPath);
    const insThread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (?, 'proj-1', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insRun = db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`);
    const insAtt = db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES (?, ?, ?, 1, ?, ?, ?)`);

    const add = (tid, title, provider, nativeId, runStatus, payload = {}, archivedAt = null, deletedAt = null, startedMsAgo = quietMs) => {
      insThread.run(tid, title, provider, `pt-${tid}`, at(quietMs + 60_000), at(quietMs), archivedAt, deletedAt, JSON.stringify(payload));
      insRun.run(`run-${tid}`, tid, provider, `pt-${tid}`, runStatus, at(startedMsAgo), runStatus === 'completed' ? at(quietMs) : null, JSON.stringify({ startedAt: at(startedMsAgo) }));
      insAtt.run(`att-${tid}`, tid, `run-${tid}`, provider, `pt-${tid}`, JSON.stringify({ nativeThreadId: nativeId }));
    };

    add('th-root-idle', 'Idle Orchestrator', 'antigravity', ids.rootIdle, 'completed', { titleRenamed: true });
    add('th-del-finished', 'Finished Delegate', 'antigravity', ids.t3DelFinished, 'completed', { lineage: { parentThreadId: 'th-root-idle', relationshipToParent: 'subagent' } });
    add('th-settled', 'Settled Root', 'antigravity', ids.rootSettled, 'completed', { settledAt: at(quietMs) });
    add('th-archived', 'Archived Root', 'antigravity', ids.rootArchived, 'completed', {}, at(quietMs));

    // rootCrossParent has NO lock needed when tested without locks, and owns 2 active T3 delegates:
    // 1 Antigravity delegate (t3DelThinking) + 1 cross-provider Claude delegate
    add('th-cross-parent', 'Cross Parent', 'antigravity', ids.rootCrossParent, 'completed', { settledAt: at(quietMs) });
    add('th-del-thinking', 'Active Agy Delegate', 'antigravity', ids.t3DelThinking, 'running', { lineage: { parentThreadId: 'th-cross-parent', relationshipToParent: 'subagent' } }, null, null, 300_000);
    add('th-del-claude', 'Active Claude Delegate', 'claudeAgent', 'claude-remote-1', 'running', { lineage: { parentThreadId: 'th-cross-parent', relationshipToParent: 'subagent' } }, null, null, 400_000);
    db.close();

    // Test WITH /proc/locks (Linux)
    const adapter = new AntigravityAdapter({ now: () => now, readLocks: () => procLocks });
    const sessions = adapter.getActiveSessions(2 * 60_000);
    const byId = (id) => sessions.find(s => s.sessionId === `antigravity-${id}`);

    assert.ok(byId(ids.rootIdle), 'unsettled root with .db POSIX READ lock stays alive when idle');
    assert.equal(byId(ids.rootIdle).turnState, 'awaiting_input');
    assert.equal(byId(ids.nativeFinished), undefined, 'CRITICAL: finished native subagent with leaked .db lock MUST NOT stay alive');
    assert.ok(byId(ids.nativeThinking), 'actively thinking native subagent of held root stays alive');
    assert.equal(byId(ids.nativeThinking).turnState, 'working');
    assert.equal(byId(ids.t3DelFinished), undefined, 'CRITICAL: finished T3 delegate with .db lock MUST NOT stay alive');
    assert.equal(byId(ids.rootSettled), undefined, 'settled root MUST NOT stay alive via .db lock');
    assert.equal(byId(ids.rootArchived), undefined, 'archived root MUST NOT stay alive via .db lock');

    // Cross-provider parent stays alive via active delegates, with deduplicated count (1 agy + 1 claude = 2)
    const crossParent = byId(ids.rootCrossParent);
    assert.ok(crossParent, 'parent with live cross-provider T3 delegates stays alive');
    assert.deepEqual(crossParent.backgroundPending, {
      count: 2,
      kinds: ['agent'],
      since: now - 900_000, // min of local t3DelThinking turnStartedAt (quietMs = 900_000) and claude startedAt (400_000)
    });
    assert.equal(resolveAgentStatus(crossParent, { now }), AgentStatus.WORKING);

    const agyDel = byId(ids.t3DelThinking);
    assert.ok(agyDel);
    assert.equal(agyDel.parentSessionId, `antigravity-${ids.rootCrossParent}`);
    assert.equal(agyDel.rootSessionId, `antigravity-${ids.rootCrossParent}`);
    assert.equal(agyDel.turnState, 'working');

    // Test WITHOUT /proc/locks (non-Linux): active T3 runs & cross-provider parent STILL stay alive!
    const nonLinux = new AntigravityAdapter({ now: () => now, readLocks: () => '' });
    const nonLinuxSessions = nonLinux.getActiveSessions(2 * 60_000);
    assert.ok(nonLinuxSessions.some(s => s.sessionId === `antigravity-${ids.t3DelThinking}`), 'active T3 run survives silent >2min think without /proc/locks');
    assert.ok(nonLinuxSessions.some(s => s.sessionId === `antigravity-${ids.rootCrossParent}`), 'parent with live T3 delegates survives without /proc/locks');
    assert.ok(!nonLinuxSessions.some(s => s.sessionId === `antigravity-${ids.rootIdle}`), 'idle root without lock evidence drops past window');
  });
});

test('Antigravity reduceAntigravityTranscript parses update_steps into todos, plan dialogue, and summary', () => {
  const now = Date.parse('2026-11-26T21:10:00Z');
  const reduced = reduceAntigravityTranscript([
    {
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(now - 5_000).toISOString(),
      model: 'gemini-4-neon-xhigh',
      tool_calls: [{
        name: 'update_steps',
        args: {
          steps: JSON.stringify([
            { title: 'Inspect T3 schema', status: 'done' },
            { title: 'Wire GLM ACP support', status: 'in_progress' },
            { text: 'Skip legacy path', status: 'skipped' },
            { title: 'Run test suite', status: 'pending' },
          ]),
        },
      }],
    },
  ], { convId: 'conv-steps', fileMtimeMs: now - 5_000 });

  assert.deepEqual(reduced.session.todos, [
    { subject: 'Inspect T3 schema', status: 'completed', phase: null },
    { subject: 'Wire GLM ACP support', status: 'in_progress', phase: null },
    { subject: 'Skip legacy path', status: 'completed', phase: null },
    { subject: 'Run test suite', status: 'pending', phase: null },
  ]);
  assert.equal(reduced.session.lastTool, 'update_steps');
  assert.equal(reduced.session.lastToolInput, 'Wire GLM ACP support (2/4)');
  assert.equal(reduced.session.observedSources.planStep, true);
  assert.ok(reduced.dialogueCandidates.some(d => d.kind === 'plan' && d.text === 'Wire GLM ACP support'));
});

// ─── 4. Claude TodoWrite content, TaskCreate/TaskUpdate, task mirroring, T3 lineage ─

test('Claude projects TodoWrite content, TaskCreate/TaskUpdate, task-group mirroring, and T3 delegate lineage + parent keepalive', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  const tmp = makeTempDir('cv-v069-claude-t3-');
  try {
    const project = path.join(tmp, 'work', 'repo');
    const encoded = project.replaceAll('/', '-');
    const projDir = path.join(tmp, '.claude', 'projects', encoded);
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    // 1. Direct projection unit test for TodoWrite `content` + TaskCreate/TaskUpdate
    const todoContentFile = path.join(projDir, 'todo-content.jsonl');
    writeFile(todoContentFile, `${[
      {
        type: 'assistant',
        timestamp: iso(5_000),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{
            type: 'tool_use',
            id: 't1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Real Claude TodoWrite uses content', status: 'in_progress', activeForm: 'Working' },
                { content: 'Done item', status: 'completed' },
              ],
            },
          }],
        },
      },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);
    const todoProj = claudeTest.getTranscriptProjection(todoContentFile, project, 'claude-sonnet-4-6');
    assert.deepEqual(todoProj.todos, [
      { subject: 'Real Claude TodoWrite uses content', status: 'in_progress', phase: null },
      { subject: 'Done item', status: 'completed', phase: null },
    ]);

    const taskToolsFile = path.join(projDir, 'task-tools.jsonl');
    writeFile(taskToolsFile, `${[
      {
        type: 'assistant',
        timestamp: iso(10_000),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'Create schema' } },
            { type: 'tool_use', id: 'tc2', name: 'TaskCreate', input: { subject: 'Temporary task' } },
            { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
            { type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } },
          ],
        },
      },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);
    const taskProj = claudeTest.getTranscriptProjection(taskToolsFile, project, 'claude-sonnet-4-6');
    assert.deepEqual(taskProj.todos, [{ subject: 'Create schema', status: 'in_progress', phase: null }]);
    assert.equal(Object.hasOwn(taskProj, '_taskItems'), false, 'internal fields stripped');

    // 2. projectClaudeExecution mirrors ~/.claude/tasks/<sessionId> into todos when todos empty
    const mirrored = projectClaudeExecution(
      [{ sessionId: 's-mirror', provider: 'claude', agentType: 'main', todos: [] }],
      [{
        groupName: 's-mirror',
        tasks: [
          { id: '1', subject: 'Audit code', status: 'completed' },
          { id: '2', subject: 'Fix bug', status: 'in_progress' },
        ],
      }],
    )[0];
    assert.deepEqual(mirrored.todos, [
      { subject: 'Audit code', status: 'completed', phase: null },
      { subject: 'Fix bug', status: 'in_progress', phase: null },
    ]);
    const preserved = projectClaudeExecution(
      [{ sessionId: 's-keep', provider: 'claude', agentType: 'main', todos: [{ subject: 'Existing', status: 'pending', phase: null }] }],
      [{ groupName: 's-keep', tasks: [{ id: '1', subject: 'Other', status: 'completed' }] }],
    )[0];
    assert.deepEqual(preserved.todos, [{ subject: 'Existing', status: 'pending', phase: null }], 'never overwrites non-empty todos');

    // 3. Full ClaudeAdapter scan with T3 SQLite: quiet parent kept alive by active T3 delegate + Claude delegate tethered to parent
    const parentId = 'claude-parent-quiet';
    const childId = 'claude-t3-delegate';
    const quietMs = 20 * 60_000;
    writeFile(path.join(tmp, '.claude', 'history.jsonl'), `${[
      { sessionId: parentId, project, timestamp: now - quietMs, model: 'claude-opus-4-6', display: 'Orchestrate' },
      { sessionId: childId, project, timestamp: now - 5_000, model: 'claude-sonnet-4-6', display: 'Delegate task' },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);
    writeFile(path.join(projDir, `${parentId}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: iso(quietMs),
      message: { role: 'assistant', model: 'claude-opus-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Waiting on T3 delegate.' }] },
    })}\n`, now - quietMs);
    writeFile(path.join(projDir, `${childId}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: iso(5_000),
      message: { role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'README.md' } }] },
    })}\n`, now - 5_000);

    const db = createFullT3Db(path.join(tmp, '.t3', 'userdata', 'statev2.sqlite'));
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, created_at, updated_at, payload_json)
      VALUES ('th-cp', 'p1', 'Claude Orch', 'claudeAgent', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES ('run-cp', 'th-cp', 1, 'claudeAgent', 'completed', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, payload_json)
      VALUES ('att-cp', 'th-cp', 'run-cp', 1, 'claudeAgent', ?)`).run(JSON.stringify({ nativeThreadId: parentId }));

    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, created_at, updated_at, payload_json)
      VALUES ('th-cc', 'p1', 'Sub Claude Task', 'claudeAgent', ?, ?, ?)`).run(
      iso(10_000), iso(5_000),
      JSON.stringify({ lineage: { parentThreadId: 'th-cp', relationshipToParent: 'subagent' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run-cc', 'th-cc', 1, 'claudeAgent', 'running', ?, ?)`).run(iso(10_000), JSON.stringify({ startedAt: iso(9_000) }));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, payload_json)
      VALUES ('att-cc', 'th-cc', 'run-cc', 1, 'claudeAgent', ?)`).run(JSON.stringify({ nativeThreadId: childId }));
    db.close();

    const script = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(2 * 60 * 1000);
      const watchPaths = adapter.getWatchPaths({ sessions });
      adapter.shutdown();
      process.stdout.write(JSON.stringify({ sessions, watchPaths }));
    `;
    const { sessions, watchPaths } = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      encoding: 'utf8',
    }));

    const parent = sessions.find(s => s.sessionId === parentId);
    const child = sessions.find(s => s.sessionId === childId);
    assert.ok(parent, 'quiet Claude parent stays active while T3 delegate runs');
    assert.deepEqual(parent.backgroundPending, { count: 1, kinds: ['agent'], since: now - 9_000 });
    assert.ok(child);
    assert.equal(child.parentSessionId, parentId);
    assert.equal(child.agentType, 'sub-agent');
    assert.equal(child.subagentKind, 'delegate');
    assert.equal(child.agentName, 'Sub Claude Task');
    assert.ok(
      watchPaths.some(p => p.path === path.join(projDir, `${childId}.jsonl`)),
      'T3-delegated Claude session watches its top-level transcript, not subagents/agent-null.jsonl',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 5. Codex T3 lineage & parent keepalive ──────────────

test('CodexAdapter tethers T3 delegates and keeps quiet Codex parents alive with backgroundPending', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  const tmp = makeTempDir('cv-v069-codex-t3-');
  try {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const quietMs = 20 * 60_000;
    const dayDir = path.join(tmp, '.codex', 'sessions', '2026', '11', '26');
    const parentUuid = '019a0000-0000-7000-8000-000000000001';
    const childUuid = '019a0000-0000-7000-8000-000000000002';
    const project = path.join(tmp, 'repo');
    fs.mkdirSync(project, { recursive: true });

    writeFile(path.join(dayDir, `rollout-2026-11-26T20-00-00-${parentUuid}.jsonl`), `${[
      { timestamp: iso(quietMs + 10_000), type: 'session_meta', payload: { id: parentUuid, cwd: project, model: 'gpt-5.4' } },
      { timestamp: iso(quietMs), type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - quietMs);

    writeFile(path.join(dayDir, `rollout-2026-11-26T20-19-50-${childUuid}.jsonl`), `${[
      { timestamp: iso(10_000), type: 'session_meta', payload: { id: childUuid, cwd: project, model: 'gpt-5.4' } },
      { timestamp: iso(8_000), type: 'event_msg', payload: { type: 'task_started' } },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);

    const db = createFullT3Db(path.join(tmp, '.t3', 'userdata', 'statev2.sqlite'));
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, created_at, updated_at, payload_json)
      VALUES ('th-xp', 'p1', 'Codex Lead', 'codex', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({ titleRenamed: true }));
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES ('run-xp', 'th-xp', 1, 'codex', 'completed', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, payload_json)
      VALUES ('att-xp', 'th-xp', 'run-xp', 1, 'codex', ?)`).run(JSON.stringify({ nativeThreadId: parentUuid }));

    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, created_at, updated_at, payload_json)
      VALUES ('th-xc', 'p1', 'Codex Subtask', 'codex', ?, ?, ?)`).run(
      iso(10_000), iso(5_000),
      JSON.stringify({ lineage: { parentThreadId: 'th-xp', relationshipToParent: 'subagent' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run-xc', 'th-xc', 1, 'codex', 'running', ?, ?)`).run(iso(10_000), JSON.stringify({ startedAt: iso(9_000) }));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, payload_json)
      VALUES ('att-xc', 'th-xc', 'run-xc', 1, 'codex', ?)`).run(JSON.stringify({ nativeThreadId: childUuid }));
    db.close();

    const script = `
      const { CodexAdapter } = require('./claudeville/adapters/codex');
      const sessions = new CodexAdapter().getActiveSessions(2 * 60 * 1000, { force: true });
      process.stdout.write(JSON.stringify(sessions));
    `;
    const sessions = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      encoding: 'utf8',
    }));

    const parent = sessions.find(s => s.agentId === parentUuid);
    const child = sessions.find(s => s.agentId === childUuid);
    assert.ok(parent, 'quiet Codex parent kept alive by active T3 delegate');
    assert.equal(parent.agentName, 'Codex Lead');
    assert.equal(parent.userNamed, true);
    assert.deepEqual(parent.backgroundPending, { count: 1, kinds: ['agent'], since: now - 9_000 });
    assert.ok(child);
    assert.equal(child.parentSessionId, parent.sessionId);
    assert.equal(child.agentType, 'sub-agent');
    assert.equal(child.subagentKind, 'delegate');
    assert.equal(child.agentName, 'Codex Subtask');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 6. Taskboard normalization + ToolIdentity + CarriedArtifact + RitualConductor ─

test('normalizeSession normalizes todos server-side across all provider formats', () => {
  const normalized = normalizeSession({
    sessionId: 'norm-todos',
    provider: 'antigravity',
    todos: [
      { content: 'From Claude TodoWrite', status: 'in_progress' },
      { subject: 'Done step', status: 'done' },
      { subject: 'Skipped step', status: 'skipped' },
      { subject: 'Running step', status: 'running', phase: 'Phase 1' },
      { subject: '   ', status: 'pending' },
    ],
  });
  assert.deepEqual(normalized.todos, [
    { subject: 'From Claude TodoWrite', status: 'in_progress', phase: null },
    { subject: 'Done step', status: 'completed', phase: null },
    { subject: 'Skipped step', status: 'completed', phase: null },
    { subject: 'Running step', status: 'in_progress', phase: 'Phase 1' },
  ]);
});

test('ToolIdentity, CarriedArtifact, and RitualConductor recognize update_steps, todowrite, and bare update_plan', () => {
  for (const tool of ['update_steps', 'todowrite', 'update_plan']) {
    const classified = classifyTool(tool, {});
    assert.equal(classified?.building, 'taskboard', `${tool} -> taskboard`);
    assert.equal(classified?.reason, 'plan-work', `${tool} -> plan-work`);
    assert.equal(toolCategory(tool), 'task', `${tool} category -> task`);
    assert.equal(toolIcon(tool), '📋', `${tool} icon`);
  }
  assert.equal(toolActionCategory('update_steps'), 'think');
  assert.equal(toolActionCategory('update_plan'), 'think');

  assert.deepEqual(resolveCarriedArtifact({ status: 'working', currentTool: 'update_steps' }), { kind: 'plan', notches: 0 });
  assert.deepEqual(resolveCarriedArtifact({ status: 'working', currentTool: 'todowrite' }), { kind: 'plan', notches: 0 });
  assert.deepEqual(resolveCarriedArtifact({ status: 'working', currentTool: 'update_plan' }), { kind: 'plan', notches: 0 });

  const conductor = new RitualConductor();
  try {
    const pinRitual = conductor.enqueue({
      agentId: 'agy-1',
      tool: 'update_steps',
      building: 'taskboard',
      input: { steps: [{ title: 'Wire GLM ACP', status: 'in_progress' }] },
      ts: 1_000,
    });
    assert.equal(pinRitual?.action, 'pin');
    assert.equal(pinRitual?.taskKey, 'text:wire glm acp');

    const doneRitual = conductor.enqueue({
      agentId: 'agy-2',
      tool: 'update_steps',
      building: 'taskboard',
      input: { steps: [{ title: 'Ship Lane A', status: 'done' }] },
      ts: 2_000,
    });
    assert.equal(doneRitual?.action, 'complete');
    assert.equal(doneRitual?.taskKey, 'text:ship lane a');
  } finally {
    conductor.dispose();
  }
});

// ─── 7. v0.69 Council Fix Lane 1 Regressions ─────────────

test('[P0 #1] T3 query failures (SQLite disabled or incompatible schema) never cache null or break native discovery across all 4 adapters', () => {
  const tmp = makeTempDir('cv-v069-t3-fail-resilience-');
  try {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const project = path.join(tmp, 'work', 'repo');
    fs.mkdirSync(project, { recursive: true });

    // Seed 1 native session for each of the 4 providers.
    // 1. Claude
    const claudeId = 'claude-native-1';
    const claudeProjDir = path.join(tmp, '.claude', 'projects', project.replaceAll('/', '-'));
    writeFile(path.join(tmp, '.claude', 'history.jsonl'), `${JSON.stringify({
      sessionId: claudeId, project, timestamp: now - 5_000, model: 'claude-sonnet-4-6', display: 'Native claude',
    })}\n`, now - 5_000);
    writeFile(path.join(claudeProjDir, `${claudeId}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: iso(5_000),
      message: { role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready.' }] },
    })}\n`, now - 5_000);

    // 2. Codex
    const codexUuid = '019a0000-0000-7000-8000-000000000099';
    writeFile(path.join(tmp, '.codex', 'sessions', '2026', '11', '26', `rollout-2026-11-26T20-00-00-${codexUuid}.jsonl`), `${[
      { timestamp: iso(10_000), type: 'session_meta', payload: { id: codexUuid, cwd: project, model: 'gpt-5.4' } },
      { timestamp: iso(5_000), type: 'event_msg', payload: { type: 'task_started' } },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);

    // 3. GLM standalone ACP JSON
    const glmId = '11111111-2222-4333-8444-555555555555';
    writeFile(path.join(tmp, '.local', 'state', 'glm-acp-agent', 'sessions', `${glmId}.json`), JSON.stringify({
      sessionId: glmId, cwd: project, model: 'glm-5.4', updatedAt: iso(5_000),
      messages: [
        { role: 'user', content: 'Native GLM work' },
        { role: 'assistant', content: 'Working on it.' },
      ],
    }), now - 5_000);

    // 4. Antigravity native CLI
    const agyId = '22222222-3333-4444-8555-666666666666';
    const agyRoot = path.join(tmp, '.gemini', 'antigravity-cli');
    writeFile(path.join(agyRoot, 'history.jsonl'), `${JSON.stringify({
      timestamp: now - 5_000, workspace: project, conversationId: agyId, display: 'Native agy',
    })}\n`, now - 5_000);
    writeFile(path.join(agyRoot, 'brain', agyId, '.system_generated', 'logs', 'transcript.jsonl'), `${JSON.stringify({
      step_index: 0, type: 'USER_INPUT', created_at: iso(5_000), content: 'Native agy',
    })}\n`, now - 5_000);

    // Present a T3 DB file on disk so cachedT3Query actually takes the DB path.
    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    writeFile(dbPath, 'placeholder-for-sqlite-disabled-test', now - 1_000);

    const probeScript = (disableSqlite) => `
      const Module = require('node:module');
      if (${Boolean(disableSqlite)}) {
        const origLoad = Module._load;
        Module._load = function(request, parent, isMain) {
          if (request === 'node:sqlite') throw new Error('ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite disabled');
          return origLoad.apply(this, arguments);
        };
      }
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { CodexAdapter } = require('./claudeville/adapters/codex');
      const { GlmAdapter } = require('./claudeville/adapters/glm');
      const { AntigravityAdapter } = require('./claudeville/adapters/antigravity');
      const t3code = require('./claudeville/adapters/t3code');

      const claude = new ClaudeAdapter();
      const codex = new CodexAdapter();
      const glm = new GlmAdapter();
      const agy = new AntigravityAdapter({ readLocks: () => '' });

      // Call twice so a poisoned null cache on call 1 would crash call 2.
      const runOnce = () => ({
        claude: claude.getActiveSessions(2 * 60 * 1000).map(s => s.sessionId),
        codex: codex.getActiveSessions(2 * 60 * 1000, { force: true }).map(s => s.agentId),
        glm: glm.getActiveSessions(2 * 60 * 1000).map(s => s.sessionId),
        agy: agy.getActiveSessions(2 * 60 * 1000).map(s => s.sessionId),
        delegatesSize: t3code.readT3ActiveDelegates().size,
        lineageSize: t3code.readT3Lineage('antigravity', ['${agyId}']).size,
        rootStateSize: t3code.readT3RootThreadState('antigravity', ['${agyId}']).size,
        activeRunSize: t3code.readT3ActiveRunNativeIds('antigravity').size,
      });

      const first = runOnce();
      const second = runOnce();
      claude.shutdown();
      process.stdout.write(JSON.stringify({ first, second }));
    `;

    // Case A: node:sqlite disabled while statev2.sqlite exists on disk.
    const disabledOut = JSON.parse(execFileSync(process.execPath, ['-e', probeScript(true)], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDEVILLE_GLM_STATE_DIR: path.join(tmp, 'no-mcp') },
      encoding: 'utf8',
    }));
    for (const pass of [disabledOut.first, disabledOut.second]) {
      assert.ok(pass.claude.includes(claudeId), 'Claude discovers native session with SQLite disabled');
      assert.ok(pass.codex.includes(codexUuid), 'Codex discovers native session with SQLite disabled');
      assert.ok(pass.glm.includes(`zai-${glmId}`), 'GLM discovers native session with SQLite disabled');
      assert.ok(pass.agy.includes(`antigravity-${agyId}`), 'Antigravity discovers native session with SQLite disabled');
      assert.equal(pass.delegatesSize, 0);
      assert.equal(pass.lineageSize, 0);
      assert.equal(pass.rootStateSize, 0);
      assert.equal(pass.activeRunSize, 0);
    }

    // Case B: real SQLite DB with reduced/incompatible schema (missing payload_json columns).
    if (nodeSqlite?.DatabaseSync) {
      fs.rmSync(dbPath, { force: true });
      const badDb = new nodeSqlite.DatabaseSync(dbPath);
      badDb.exec(`
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, default_provider TEXT);
        CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
        CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, provider TEXT);
      `);
      badDb.close();

      const incompatOut = JSON.parse(execFileSync(process.execPath, ['-e', probeScript(false)], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDEVILLE_GLM_STATE_DIR: path.join(tmp, 'no-mcp') },
        encoding: 'utf8',
      }));
      for (const pass of [incompatOut.first, incompatOut.second]) {
        assert.ok(pass.claude.includes(claudeId), 'Claude survives incompatible T3 schema');
        assert.ok(pass.codex.includes(codexUuid), 'Codex survives incompatible T3 schema');
        assert.ok(pass.glm.includes(`zai-${glmId}`), 'GLM survives incompatible T3 schema');
        assert.ok(pass.agy.includes(`antigravity-${agyId}`), 'Antigravity survives incompatible T3 schema');
        assert.equal(pass.delegatesSize, 0);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('[P1 #2] GLM T3 discovery skips archived history in SQL, materializes zero archived items, and completes under 50 ms', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  withTempHome('cv-v069-glm-perf-', (tmp) => {
    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const now = Date.parse('2026-11-26T22:00:00Z');
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const db = createFullT3Db(dbPath);

    // Seed an archived GLM thread with 5,000 turn_items, 200 messages, and 50 provider_turns.
    const archivedNative = '99999999-1111-4111-8111-111111111111';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, archived_at, payload_json)
      VALUES ('th-glm-archived-huge', 'proj-1', 'Huge Archived GLM', 'acpRegistry_glm_agent', 'pt-arch', ?, ?, ?, ?)`).run(
      iso(86_400_000), iso(7_200_000), iso(3_600_000),
      JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-arch', 'th-glm-archived-huge', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(7_200_000),
      JSON.stringify({ nativeThreadRef: { nativeId: archivedNative } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-arch', 'th-glm-archived-huge', 1, 'acpRegistry_glm_agent', 'pt-arch', 'completed', ?, ?, ?)`).run(
      iso(86_400_000), iso(7_200_000), JSON.stringify({ startedAt: iso(86_400_000) }),
    );

    db.exec('BEGIN');
    const insItem = db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, 'th-glm-archived-huge', 'run-arch', ?, 'command_execution', 'completed', ?, ?)`);
    const archivedPayload = JSON.stringify({ type: 'command_execution', input: 'echo __ARCHIVED_SENTINEL__', output: 'x'.repeat(256), exitCode: 0 });
    for (let i = 1; i <= 5000; i++) {
      insItem.run(`arch-it-${i}`, i, iso(7_200_000 - i), archivedPayload);
    }
    const insMsg = db.prepare(`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, created_at, updated_at, payload_json)
      VALUES (?, 'th-glm-archived-huge', 'run-arch', 'assistant', ?, ?, ?)`);
    for (let i = 1; i <= 200; i++) {
      insMsg.run(`arch-msg-${i}`, iso(7_200_000 - i), iso(7_200_000 - i), JSON.stringify({ role: 'assistant', text: `__ARCHIVED_SENTINEL__ msg ${i}` }));
    }
    const insTurn = db.prepare(`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, ordinal, status, started_at, completed_at, payload_json)
      VALUES (?, 'th-glm-archived-huge', 'pt-arch', ?, 'completed', ?, ?, ?)`);
    for (let i = 1; i <= 50; i++) {
      insTurn.run(`arch-turn-${i}`, i, iso(7_200_000 - i * 1000), iso(7_200_000 - i * 1000), JSON.stringify({
        marker: '__ARCHIVED_SENTINEL__',
        turnTokenUsage: { inputTokens: 10_000, cachedInputTokens: 5_000, outputTokens: 500 },
      }));
    }

    // Seed 1 active GLM thread with 3 items.
    const activeNative = '88888888-2222-4222-8222-222222222222';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-glm-live', 'proj-1', 'Live GLM', 'acpRegistry_glm_agent', 'pt-live', ?, ?, ?)`).run(
      iso(30_000), iso(2_000),
      JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-live', 'th-glm-live', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(2_000),
      JSON.stringify({ nativeThreadRef: { nativeId: activeNative } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES ('run-live', 'th-glm-live', 1, 'acpRegistry_glm_agent', 'pt-live', 'running', ?, ?)`).run(
      iso(30_000), JSON.stringify({ startedAt: iso(29_000) }),
    );
    const insLiveItem = db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, 'th-glm-live', 'run-live', ?, 'command_execution', 'completed', ?, ?)`);
    for (let i = 1; i <= 3; i++) {
      insLiveItem.run(`live-it-${i}`, i, iso(5_000 - i * 1000), JSON.stringify({ type: 'command_execution', input: `step ${i}`, exitCode: 0 }));
    }
    db.exec('COMMIT');
    db.close();

    // Cold discovery with 5,000 archived items must ignore archived history,
    // materialize zero archived payloads in JS, and finish < 50 ms.
    t3code.clearT3Cache();
    const origJsonParse = JSON.parse;
    let archivedPayloadsParsed = 0;
    JSON.parse = function patchedParse(text, ...rest) {
      if (typeof text === 'string' && text.includes('__ARCHIVED_SENTINEL__')) archivedPayloadsParsed++;
      return origJsonParse.call(this, text, ...rest);
    };
    let sessions;
    let elapsedMs;
    try {
      const start = performance.now();
      sessions = t3code.readT3AcpGlmSessions(2 * 60_000, { now });
      elapsedMs = performance.now() - start;
    } finally {
      JSON.parse = origJsonParse;
    }

    assert.equal(archivedPayloadsParsed, 0, 'zero archived items/messages/turns may be materialized during discovery');
    assert.equal(sessions.length, 1, 'archived GLM thread must not be returned');
    assert.equal(sessions[0].sessionId, `zai-${activeNative}`);
    assert.equal(sessions[0].lastToolInput, 'step 3');
    assert.ok(elapsedMs < 50, `Expected cold GLM discovery with 5k archived items < 50 ms, took ${elapsedMs.toFixed(1)} ms`);

    // Explicit detail lookup still resolves archived threads with bounded history.
    const detail = t3code.readT3AcpGlmSessionDetail(archivedNative);
    assert.ok(detail, 'explicit detail lookup still reads archived GLM thread');
    assert.equal(detail.toolHistory.length, 120);
    assert.equal(detail.messages.length, 50);
  });
});

test('[P1 #3] Native Antigravity /rename sets userNamed: true and preserves named:antigravity:merlin Hall of Lives lineage', () => {
  const tmp = makeTempDir('cv-v069-agy-rename-lineage-');
  try {
    const now = Date.parse('2026-11-26T22:15:00Z');
    const project = path.join(tmp, 'work', 'merlin-tower');
    const rootDir = path.join(tmp, 'antigravity-cli');
    fs.mkdirSync(project, { recursive: true });

    const merlinId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const unnamedId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    writeFile(path.join(rootDir, 'history.jsonl'), `${[
      { timestamp: now - 20_000, workspace: project, conversationId: merlinId, display: 'Begin spellwork' },
      { timestamp: now - 10_000, workspace: project, conversationId: merlinId, type: 'slash_command', display: '/rename Merlin' },
      { timestamp: now - 15_000, workspace: project, conversationId: unnamedId, display: 'Routine patrol' },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 10_000);
    writeFile(path.join(rootDir, 'annotations', `${unnamedId}.pbtxt`), 'title: "Auto Generated Title"\n', now - 15_000);
    for (const id of [merlinId, unnamedId]) {
      writeFile(path.join(rootDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), `${JSON.stringify({
        step_index: 0, type: 'USER_INPUT', created_at: iso(15_000), content: 'Hello',
      })}\n`, now - 15_000);
    }

    const adapter = new AntigravityAdapter({ rootDir, now: () => now, readLocks: () => '' });
    const sessions = adapter.getActiveSessions(2 * 60_000);
    const merlin = sessions.find(s => s.sessionId === `antigravity-${merlinId}`);
    const unnamed = sessions.find(s => s.sessionId === `antigravity-${unnamedId}`);

    assert.ok(merlin);
    assert.equal(merlin.agentName, 'Merlin');
    assert.equal(merlin.userNamed, true, 'native /rename must propagate userNamed: true');
    assert.equal(
      AgentBiography.identityKeyFor({ ...merlin, id: merlin.sessionId, projectPath: merlin.project }),
      'named:antigravity:merlin',
    );
    assert.equal(AgentBiography.identityKeyFor(merlin), 'named:antigravity:merlin');

    assert.ok(unnamed);
    assert.equal(unnamed.agentName, null);
    assert.equal(unnamed.userNamed, false);
    assert.equal(
      AgentBiography.identityKeyFor({ ...unnamed, id: unnamed.sessionId, projectPath: unnamed.project }),
      'project:antigravity:merlin-tower',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('[P1 #4] Active Antigravity delegate retry on a new native ID does not revive earlier attempt and reports backgroundPending.count === 1', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  withTempHome('cv-v069-agy-retry-native-', (tmp) => {
    const now = Date.parse('2026-11-26T22:30:00Z');
    const quietMs = 15 * 60_000;
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const acpDir = path.join(tmp, '.t3', 'userdata', 'providers', 'antigravity', 'inst1', 'antigravity-acp');
    const transcript = (id) => path.join(acpDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const dbFile = (id) => path.join(acpDir, 'conversations', `${id}.db`);
    const lines = (steps) => `${steps.map(s => JSON.stringify(s)).join('\n')}\n`;

    const parentId = '11111111-aaaa-4aaa-8aaa-111111111111';
    const attemptA = '22222222-aaaa-4aaa-8aaa-222222222222';
    const attemptB = '33333333-aaaa-4aaa-8aaa-333333333333';

    writeFile(transcript(parentId), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: iso(quietMs + 10_000), content: 'Delegate task' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(quietMs), model: 'gemini-4-neon-xhigh', content: 'Delegated.' },
    ]), now - quietMs);
    // Attempt A completed 15 min ago; Attempt B is actively running (silent xhigh think).
    writeFile(transcript(attemptA), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: iso(quietMs + 20_000), content: 'First try' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(quietMs), model: 'gemini-4-neon-xhigh', content: 'Failed once.' },
    ]), now - quietMs);
    writeFile(transcript(attemptB), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: iso(quietMs - 60_000), content: 'Retry try' },
    ]), now - (quietMs - 60_000));

    // Even with leaked .db locks on all 3 files, attemptA must never revive.
    const lockLines = [parentId, attemptA, attemptB].map((id, idx) => {
      const p = dbFile(id);
      writeFile(p, 'sqlite-dummy', now - quietMs);
      return `${idx + 1}: POSIX  ADVISORY  READ 9001 103:06:${fs.statSync(p).ino} 1073741826 1073742335`;
    });

    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const db = createFullT3Db(dbPath);
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-parent', 'proj-1', 'Lead', 'antigravity', 'pt-parent', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-parent-1', 'th-parent', 1, 'antigravity', 'pt-parent', 'completed', ?, ?, ?)`).run(iso(quietMs), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES ('att-parent-1', 'th-parent', 'run-parent-1', 1, 'antigravity', 'pt-parent', ?)`).run(JSON.stringify({ nativeThreadId: parentId }));

    // Single delegate thread with Run 1 (completed -> attemptA) and Run 2 (running -> attemptB).
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-del-retry', 'proj-1', 'Retry Worker', 'antigravity', 'pt-del-b', ?, ?, ?)`).run(
      iso(quietMs), iso(quietMs - 60_000),
      JSON.stringify({ lineage: { parentThreadId: 'th-parent', relationshipToParent: 'subagent' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-del-1', 'th-del-retry', 1, 'antigravity', 'pt-del-a', 'completed', ?, ?, ?)`).run(iso(quietMs + 20_000), iso(quietMs), JSON.stringify({}));
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES ('att-del-1', 'th-del-retry', 'run-del-1', 1, 'antigravity', 'pt-del-a', ?)`).run(JSON.stringify({ nativeThreadId: attemptA }));
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES ('run-del-2', 'th-del-retry', 2, 'antigravity', 'pt-del-b', 'running', ?, ?)`).run(
      iso(quietMs - 60_000), JSON.stringify({ startedAt: iso(quietMs - 60_000) }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id, thread_id, run_id, attempt_ordinal, provider, provider_thread_id, payload_json)
      VALUES ('att-del-2', 'th-del-retry', 'run-del-2', 1, 'antigravity', 'pt-del-b', ?)`).run(JSON.stringify({ nativeThreadId: attemptB }));
    db.close();

    const activeIds = t3code.readT3ActiveRunNativeIds('antigravity');
    assert.equal(activeIds.has(attemptB), true);
    assert.equal(activeIds.has(attemptA), false, 'completed earlier attempt native ID must not be marked active');

    const rootStates = t3code.readT3RootThreadState('antigravity', [attemptA, attemptB]);
    assert.equal(rootStates.get(attemptA)?.activeRun, false, 'root state must not mark old attempt active');
    assert.equal(rootStates.get(attemptB)?.activeRun, true);

    const adapter = new AntigravityAdapter({ now: () => now, readLocks: () => `${lockLines.join('\n')}\n` });
    const sessions = adapter.getActiveSessions(2 * 60_000);
    const parent = sessions.find(s => s.sessionId === `antigravity-${parentId}`);
    const oldSess = sessions.find(s => s.sessionId === `antigravity-${attemptA}`);
    const newSess = sessions.find(s => s.sessionId === `antigravity-${attemptB}`);

    assert.ok(parent);
    assert.equal(oldSess, undefined, 'old completed attempt must NOT be revived by retry run');
    assert.ok(newSess, 'active retry attempt stays alive');
    assert.equal(parent.backgroundPending?.count, 1, 'parent backgroundPending counts only the 1 live retry');

    // When a queued active run has NO attempt row yet, active-run discovery falls back
    // to that run's provider_thread nativeThreadRef without reviving completed attemptA.
    const queuedNative = '44444444-aaaa-4aaa-8aaa-444444444444';
    const db2 = new nodeSqlite.DatabaseSync(dbPath);
    db2.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('pt-del-queued', 'th-del-retry', 'antigravity', 'active', ?, ?)`).run(
      iso(10_000), JSON.stringify({ nativeThreadRef: { nativeId: queuedNative } }),
    );
    db2.prepare("UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ? WHERE run_id = 'run-del-2'").run(iso(20_000));
    db2.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES ('run-del-3', 'th-del-retry', 3, 'antigravity', 'pt-del-queued', 'queued', ?, ?)`).run(
      iso(10_000), JSON.stringify({ startedAt: iso(10_000) }),
    );
    db2.close();
    t3code.clearT3Cache();

    const queuedActiveIds = t3code.readT3ActiveRunNativeIds('antigravity');
    assert.equal(queuedActiveIds.has(queuedNative), true, 'falls back to active provider_thread when active run has no attempt ID yet');
    assert.equal(queuedActiveIds.has(attemptA), false, 'older completed attemptA stays inactive');
    assert.equal(queuedActiveIds.has(attemptB), false, 'older completed attemptB stays inactive');
  });
});

test('[P1 #5] Archived GLM thread with completed run and stale provider_threads.status=active is never live or working', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  withTempHome('cv-v069-glm-archived-state-', (tmp) => {
    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const now = Date.parse('2026-11-26T22:45:00Z');
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const db = createFullT3Db(dbPath);

    // 1. Archived thread + completed run + stale provider_threads.status = 'active'
    const archivedNative = '11111111-aaaa-4111-8111-111111111111';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, archived_at, payload_json)
      VALUES ('th-arch', 'p1', 'Archived Done', 'acpRegistry_glm_agent', 'pt-arch', ?, ?, ?, ?)`).run(
      iso(600_000), iso(10_000), iso(5_000), JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-arch', 'th-arch', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(10_000), JSON.stringify({ nativeThreadRef: { nativeId: archivedNative } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-arch', 'th-arch', 1, 'acpRegistry_glm_agent', 'pt-arch', 'completed', ?, ?, ?)`).run(
      iso(600_000), iso(10_000), JSON.stringify({ startedAt: iso(600_000) }),
    );

    // 2. Non-archived recent thread + completed run + stale pt.status = 'active' -> awaiting_input (NOT working)
    const doneRecentNative = '22222222-bbbb-4222-8222-222222222222';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-done-recent', 'p1', 'Done Recent', 'acpRegistry_glm_agent', 'pt-dr', ?, ?, ?)`).run(
      iso(60_000), iso(10_000), JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-dr', 'th-done-recent', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(10_000), JSON.stringify({ nativeThreadRef: { nativeId: doneRecentNative } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-dr', 'th-done-recent', 1, 'acpRegistry_glm_agent', 'pt-dr', 'completed', ?, ?, ?)`).run(
      iso(60_000), iso(10_000), JSON.stringify({ startedAt: iso(60_000) }),
    );

    // 3. Non-archived old thread + completed run + stale pt.status = 'active' -> NOT kept alive past threshold
    const doneOldNative = '33333333-cccc-4333-8333-333333333333';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-done-old', 'p1', 'Done Old', 'acpRegistry_glm_agent', 'pt-do', ?, ?, ?)`).run(
      iso(900_000), iso(600_000), JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-do', 'th-done-old', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(600_000), JSON.stringify({ nativeThreadRef: { nativeId: doneOldNative } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES ('run-do', 'th-done-old', 1, 'acpRegistry_glm_agent', 'pt-do', 'completed', ?, ?, ?)`).run(
      iso(900_000), iso(600_000), JSON.stringify({ startedAt: iso(900_000) }),
    );

    // 4. Non-archived thread with NO run row + pt.status = 'active' -> falls back to pt.status === 'active'
    const noRunActiveNative = '44444444-dddd-4444-8444-444444444444';
    db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES ('th-no-run', 'p1', 'No Run Fallback', 'acpRegistry_glm_agent', 'pt-nr', ?, ?, ?)`).run(
      iso(600_000), iso(600_000), JSON.stringify({ modelSelection: { model: 'glm-5.4' } }),
    );
    db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver)
      VALUES ('pt-nr', 'th-no-run', 'acpRegistry_glm_agent', 'active', ?, ?, 'acpRegistry')`).run(
      iso(600_000), JSON.stringify({ nativeThreadRef: { nativeId: noRunActiveNative } }),
    );
    db.close();

    const sessions = t3code.readT3AcpGlmSessions(2 * 60_000, { now });
    const byNative = (id) => sessions.find(s => s.sessionId === `zai-${id}`);

    assert.equal(byNative(archivedNative), undefined, 'archived GLM thread must never appear in live discovery');
    assert.equal(byNative(doneOldNative), undefined, 'old completed GLM thread must not stay live via stale pt.status');
    assert.equal(byNative(doneRecentNative)?.turnState, 'awaiting_input', 'completed run overrides stale pt.status=active');
    assert.equal(byNative(noRunActiveNative)?.turnState, 'working', 'thread without run lifecycle rows falls back to pt.status=active');
  });
});

test('[P1 #11] Claude TaskCreate correlates tool_result IDs on shared task lists and omits failed creates', () => {
  const tmp = makeTempDir('cv-v069-claude-task-result-');
  try {
    const project = path.join(tmp, 'work', 'repo');
    const projDir = path.join(tmp, '.claude', 'projects', project.replaceAll('/', '-'));
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const file = path.join(projDir, 'shared-task-list.jsonl');

    writeFile(file, `${[
      {
        type: 'assistant',
        timestamp: iso(20_000),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', id: 'tu_create_1', name: 'TaskCreate', input: { subject: 'Fix shared board' } },
            { type: 'tool_use', id: 'tu_create_fail', name: 'TaskCreate', input: { subject: 'Broken task' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: iso(19_000),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_create_1', is_error: false, content: 'Task #7 created successfully: Fix shared board' },
            { type: 'tool_result', tool_use_id: 'tu_create_fail', is_error: true, content: 'Error: task creation rejected' },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: iso(15_000),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', id: 'tu_create_2', name: 'TaskCreate', input: { subject: 'Verify structured result' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: iso(14_000),
        toolUseResult: { task: { id: '12', subject: 'Verify structured result' } },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_create_2', is_error: false, content: 'Created' },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: iso(10_000),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', id: 'tu_upd_7', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } },
            { type: 'tool_use', id: 'tu_upd_12', name: 'TaskUpdate', input: { taskId: '12', status: 'completed' } },
          ],
        },
      },
    ].map(r => JSON.stringify(r)).join('\n')}\n`, now - 5_000);

    const proj = claudeTest.getTranscriptProjection(file, project, 'claude-sonnet-4-6');
    assert.deepEqual(proj.todos, [
      { subject: 'Fix shared board', status: 'in_progress', phase: null },
      { subject: 'Verify structured result', status: 'completed', phase: null },
    ]);
    assert.equal(Object.hasOwn(proj, '_pendingTaskCreates'), false, 'internal _pendingTaskCreates stripped');
    assert.equal(Object.hasOwn(proj, '_taskItems'), false, 'internal _taskItems stripped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
