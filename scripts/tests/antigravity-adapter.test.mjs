import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { classifyTool, toolActionCategory } from '../../claudeville/src/domain/services/ToolIdentity.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { resolveAgentStatus } from '../../claudeville/src/domain/services/StatusResolver.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'antigravity');

const { AntigravityAdapter, parseAntigravityModel, cleanUserPrompt } = require('../../claudeville/adapters/antigravity.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');
const { hookOverlay, mergeOverlay, promptDetailFrom } = require('../../claudeville/adapters/hooks.js');
const { mapAntigravityHookEvent, runIngest: runAntigravityHookIngest } = require('../../scripts/agent-hooks/antigravity-hook.cjs');

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT = '/workspace/claude-ville';

function writeFile(target, content, mtimeMs = Date.now()) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  const date = new Date(mtimeMs);
  fs.utimesSync(target, date, date);
}

test('parseAntigravityModel and cleanUserPrompt extract model, effort, and prompt cleanly', () => {
  assert.deepEqual(parseAntigravityModel('gemini-4-carbon-high'), { model: 'gemini-4-carbon', effort: 'high' });
  assert.deepEqual(parseAntigravityModel('gemini-4-neon-minimal'), { model: 'gemini-4-neon', effort: 'low' });
  assert.deepEqual(parseAntigravityModel('Gemini 4 Carbon (High)'), { model: 'gemini-4-carbon', effort: 'high' });
  assert.deepEqual(parseAntigravityModel('Gemini 3.8 Flash (Medium)'), { model: 'gemini-3.8-flash', effort: 'medium' });
  assert.deepEqual(parseAntigravityModel('gemini-4-argon', 'xhigh'), { model: 'gemini-4-argon', effort: 'xhigh' });

  const wrapped = 'Error: The stream was interrupted. Please continue the task you were working on.<USER_REQUEST>\nShip Carbon sprites\n</USER_REQUEST>\n<ADDITIONAL_METADATA>now</ADDITIONAL_METADATA>';
  assert.equal(cleanUserPrompt(wrapped), 'Ship Carbon sprites');
});

test('AntigravityAdapter parses transcripts, compact args, tokens, workingSet, gitEvents, and subagent lineage', () => {
  const tmp = makeTempDir('cv-antigravity-test-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const now = Date.parse('2026-11-20T19:45:25Z');

    writeFile(
      path.join(rootDir, 'settings.json'),
      JSON.stringify({ model: 'Gemini 4 Carbon (High)' }),
      now,
    );
    writeFile(
      path.join(rootDir, 'history.jsonl'),
      `${JSON.stringify({ timestamp: now - 25_000, workspace: PROJECT, conversationId: PARENT_ID, display: 'Add Antigravity support' })}\n`,
      now,
    );
    writeFile(
      path.join(rootDir, 'cache', 'last_conversations.json'),
      JSON.stringify({ [PROJECT]: PARENT_ID }),
      now,
    );

    const parentTranscript = fs.readFileSync(path.join(FIXTURE_DIR, 'carbon-parent.jsonl'), 'utf8');
    const childTranscript = fs.readFileSync(path.join(FIXTURE_DIR, 'neon-subagent.jsonl'), 'utf8');

    writeFile(
      path.join(rootDir, 'brain', PARENT_ID, '.system_generated', 'logs', 'transcript.jsonl'),
      parentTranscript,
      now - 5_000,
    );
    writeFile(
      path.join(rootDir, 'brain', CHILD_ID, '.system_generated', 'logs', 'transcript.jsonl'),
      childTranscript,
      now - 2_000,
    );

    const adapter = new AntigravityAdapter({ rootDir, now: () => now });
    assert.equal(adapter.isAvailable(), true);

    const sessions = adapter.getActiveSessions(60_000).map(s => normalizeSession(s));
    assert.equal(sessions.length, 2);

    const parent = sessions.find(s => s.sessionId === `antigravity-${PARENT_ID}`);
    const child = sessions.find(s => s.sessionId === `antigravity-${CHILD_ID}`);
    assert.ok(parent, 'parent session discovered');
    assert.ok(child, 'child subagent discovered');

    // Parent session assertions
    assert.equal(parent.provider, 'antigravity');
    assert.equal(parent.underlyingProvider, 'gemini');
    assert.equal(parent.project, PROJECT);
    assert.equal(parent.model, 'gemini-4-carbon');
    assert.equal(parent.reasoningEffort, 'high');
    assert.equal(parent.teamName, 'Elemental Guild');
    assert.equal(parent.turnState, 'awaiting_input');
    assert.equal(parent.lastPrompt, 'Add Antigravity support and Gemini 4 sprites to ClaudeVille.');
    assert.equal(parent.lastTurnDurationMs, 20_000);

    // Token accounting (uncached input + cacheRead + output; contextWindow is prompt size)
    assert.equal(parent.tokenUsage.input, 18_500);
    assert.equal(parent.tokenUsage.cacheRead, 40_500);
    assert.equal(parent.tokenUsage.output, 1_130);
    assert.equal(parent.tokenUsage.totalInput, 18_500);
    assert.equal(parent.tokenUsage.contextWindow, 22_500);
    assert.equal(parent.tokenUsage.contextWindowMax, 1_000_000);

    // Working set, tool results (including real duplicated-header noOutput), git events, sendMessages
    assert.deepEqual(
      parent.workingSet.map(w => ({ path: w.path, op: w.op })),
      [
        { path: 'claudeville/adapters/index.js', op: 'write' },
        { path: 'README.md', op: 'read' },
      ],
    );
    const failedRun = parent.lastResults.find(r => r.exitCode === 1);
    assert.ok(failedRun, 'failed run_command recorded');
    assert.equal(failedRun.exitCode, 1);
    assert.equal(failedRun.exitCodeSource, 'exit');
    assert.equal(failedRun.detail, 'npm run lint');
    assert.equal(failedRun.noOutput, false);
    const silentRun = parent.lastResults.find(r => r.exitCode === 0 && r.noOutput === true);
    assert.ok(silentRun, 'silent run_command with duplicated headers + No output marker sets noOutput: true');
    assert.ok(parent.gitEvents.some(e => e.type === 'commit'), 'git commit extracted from run_command');
    assert.ok(
      parent.sendMessages.some(m => m.recipient === CHILD_ID),
      'send_message stores raw recipient so RelationshipAffinityService matches child agentId',
    );

    // Child subagent assertions (adapter derives question wait; normalizeSession clears launcher-directed waits on subagents)
    const rawChild = adapter.getActiveSessions(60_000).find(s => s.sessionId === `antigravity-${CHILD_ID}`);
    assert.equal(rawChild.waitReason, 'question', 'raw adapter reports ask_question waitReason');
    assert.equal(child.parentSessionId, `antigravity-${PARENT_ID}`);
    assert.equal(child.rootSessionId, `antigravity-${PARENT_ID}`);
    assert.equal(child.agentType, 'sub-agent');
    assert.equal(child.subagentKind, 'research');
    assert.equal(child.agentName, 'Sprite Auditor');
    assert.equal(child.project, PROJECT, 'child inherits workspace from parent');
    assert.equal(child.model, 'gemini-4-neon');
    assert.equal(child.reasoningEffort, 'medium');
    assert.equal(child.turnState, 'tool_pending');
    assert.equal(child.pendingTool, 'ask_question');
    assert.equal(child.waitReason, null, 'normalizeSession clears question wait on subagent');
    assert.match(child.lastToolInput || '', /Include Hydrogen and Argon/);

    // Detail & watch descriptors
    const detail = adapter.getSessionDetail(`antigravity-${PARENT_ID}`, PROJECT);
    assert.equal(detail.provider, 'antigravity');
    assert.equal(detail.messages.length, 2);
    assert.ok(detail.toolHistory.some(t => t.tool === 'invoke_subagent'));

    const watchPaths = adapter.getWatchPaths({ sessions });
    assert.ok(watchPaths.some(d => d.scope === 'discovery' && d.recursive !== true));
    assert.ok(watchPaths.some(d => d.scope === 'active' && d.probe === true && d.type === 'file'));

    // Lifecycle hook overlay supports provider: 'antigravity'
    const overlay = hookOverlay.ingest({
      provider: 'antigravity',
      sessionId: `antigravity-${PARENT_ID}`,
      kind: 'PermissionRequest',
      tool: 'run_command',
      input: { CommandLine: 'git push origin main' },
      ts: now + 1000,
    });
    const merged = mergeOverlay(parent, overlay, now + 1000);
    assert.equal(merged.waitReason, 'approval');
    assert.equal(merged.promptDetail, 'git push origin main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ToolIdentity maps Antigravity native tools to the expected village buildings', () => {
  assert.equal(classifyTool('edit_file', { Path: '/repo/src/app.js' }).building, 'forge');
  assert.equal(classifyTool('write_file', { Path: '/repo/src/new.js' }).building, 'forge');
  assert.equal(classifyTool('read_file', { Path: '/repo/docs/README.md' }).building, 'archive');
  assert.equal(classifyTool('search_web', { query: 'Gemini 4 Carbon pricing' }).building, 'portal');
  assert.equal(classifyTool('run_command', { CommandLine: 'git status --short' }).building, 'harbor');
  assert.equal(classifyTool('run_command', { CommandLine: 'npm run validate:quick' }).building, 'taskboard');
  assert.equal(classifyTool('invoke_subagent', { Role: 'Auditor' }).building, 'command');
  assert.equal(classifyTool('swarm', { action: 'add', name: 'worker-1' }).building, 'command');
  assert.equal(classifyTool('run_workflow', { Description: 'Audit' }).building, 'command');
  assert.equal(classifyTool('swarm_wait', {}).building, 'watchtower');
  assert.equal(classifyTool('schedule', { DurationSeconds: 60 }).building, 'watchtower');
  assert.equal(toolActionCategory('ask_question'), 'think');
});

test('Antigravity explicit /rename reads annotations, while auto-titles and slash commands never resurrect or rename unrenamed sessions', () => {
  const tmp = makeTempDir('cv-antigravity-rename-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const renamedId = 'aaaaaaaa-1111-4111-8111-111111111111';
    const autoId = 'bbbbbbbb-2222-4222-8222-222222222222';
    const clearedId = 'cccccccc-3333-4333-8333-333333333333';
    const exitedId = 'cccccccc-4444-4444-8444-444444444444';
    const t0 = Date.parse('2026-11-20T19:00:00Z');
    const tSlashLater = Date.parse('2026-11-20T21:00:00Z');
    const now = tSlashLater + 30_000;

    const history = [
      { timestamp: t0, workspace: PROJECT, conversationId: renamedId, display: 'Initial prompt' },
      { timestamp: tSlashLater, workspace: PROJECT, conversationId: renamedId, type: 'slash_command', display: '/rename Fallback Title' },
      { timestamp: t0, workspace: PROJECT, conversationId: autoId, display: 'Auto-titled session' },
      { timestamp: tSlashLater, workspace: PROJECT, conversationId: autoId, type: 'slash_command', display: '/model Gemini 4 Carbon (High)' },
      { timestamp: t0, workspace: PROJECT, conversationId: clearedId, display: 'Session to clear' },
      { timestamp: t0 + 10_000, workspace: PROJECT, conversationId: clearedId, type: 'slash_command', display: '/clear' },
      { timestamp: t0, workspace: PROJECT, conversationId: exitedId, display: 'Session to exit' },
      { timestamp: t0 + 10_000, workspace: PROJECT, conversationId: exitedId, type: 'slash_command', display: '/exit' },
    ];
    writeFile(path.join(rootDir, 'history.jsonl'), `${history.map(h => JSON.stringify(h)).join('\n')}\n`, tSlashLater);
    writeFile(path.join(rootDir, 'annotations', `${renamedId}.pbtxt`), 'title:"RENAMED \\"HERO\\" NAME"\n', tSlashLater);
    writeFile(path.join(rootDir, 'annotations', `${autoId}.pbtxt`), 'title:"Long Auto Generated Conversation Summary"\n', t0);

    const baseStep = (ts) => JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(ts).toISOString(),
      model: 'gemini-4-carbon-high',
      input_tokens: 100,
      output_tokens: 20,
      content: 'Done.',
    });

    writeFile(path.join(rootDir, 'brain', renamedId, '.system_generated', 'logs', 'transcript.jsonl'), `${baseStep(t0)}\n`, t0);
    writeFile(path.join(rootDir, 'brain', autoId, '.system_generated', 'logs', 'transcript.jsonl'), `${baseStep(t0)}\n`, t0);
    writeFile(path.join(rootDir, 'brain', clearedId, '.system_generated', 'logs', 'transcript.jsonl'), `${baseStep(t0)}\n`, t0);
    writeFile(path.join(rootDir, 'brain', exitedId, '.system_generated', 'logs', 'transcript.jsonl'), `${baseStep(t0)}\n`, t0);

    const adapter = new AntigravityAdapter({ rootDir, now: () => now });
    const all = adapter.getAllSessions();

    const renamed = all.find(s => s.sessionId === `antigravity-${renamedId}`);
    const auto = all.find(s => s.sessionId === `antigravity-${autoId}`);
    const cleared = all.find(s => s.sessionId === `antigravity-${clearedId}`);
    const exited = all.find(s => s.sessionId === `antigravity-${exitedId}`);

    assert.equal(renamed.agentName, 'RENAMED "HERO" NAME');
    assert.equal(renamed.lastActivity, t0, '/rename must not bump lastActivity');
    assert.equal(renamed.sessionEndedAt, null);

    assert.equal(auto.agentName, null, 'auto-generated annotation titles are ignored without /rename');
    assert.equal(auto.lastActivity, t0, '/model must not bump lastActivity');

    assert.equal(cleared.lastActivity, t0, '/clear must not bump lastActivity');
    assert.equal(cleared.sessionEndedAt, null, '/clear keeps the same conversation, so it is no end');
    assert.equal(exited.lastActivity, t0, '/exit must not bump lastActivity');
    assert.equal(exited.sessionEndedAt, t0 + 10_000, '/exit sets explicit sessionEndedAt');

    // Editing an existing annotation updates agentName on next poll and invalidates via .pbtxt watch path.
    writeFile(path.join(rootDir, 'annotations', `${renamedId}.pbtxt`), 'title:"UPDATED-TITLE"\n', tSlashLater + 5000);
    const watchPaths = adapter.getWatchPaths({ sessions: [] });
    assert.ok(watchPaths.some(d => d.kind === 'metadata' && d.filters?.includes('.pbtxt')));
    adapter.invalidateCachesForDirty({ path: path.join(rootDir, 'annotations', `${renamedId}.pbtxt`), kind: 'metadata' });
    const updated = adapter.getAllSessions().find(s => s.sessionId === `antigravity-${renamedId}`);
    assert.equal(updated.agentName, 'UPDATED-TITLE');

    // A newer transcript step after /exit resumes the conversation and clears sessionEndedAt.
    writeFile(path.join(rootDir, 'brain', exitedId, '.system_generated', 'logs', 'transcript.jsonl'), `${baseStep(t0 + 20_000)}\n`, t0 + 20_000);
    adapter.invalidateCaches();
    const resumed = adapter.getAllSessions().find(s => s.sessionId === `antigravity-${exitedId}`);
    assert.equal(resumed.sessionEndedAt, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity handles ERROR_MESSAGE, ask_question resolution, Orchestrator crew liveness, and hook forwarding', () => {
  const tmp = makeTempDir('cv-antigravity-edge-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const errId = 'dddddddd-4444-4444-8444-444444444444';
    const orchId = 'eeeeeeee-5555-4555-8555-555555555555';
    const subId = 'ffffffff-6666-4666-8666-666666666666';
    const now = Date.parse('2026-11-20T20:00:00Z');

    // 1. Trailing ERROR_MESSAGE surfaces apiError
    writeFile(
      path.join(rootDir, 'brain', errId, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        { step_index: 0, type: 'USER_INPUT', created_at: new Date(now - 5000).toISOString(), content: 'Run tests' },
        { step_index: 1, type: 'ERROR_MESSAGE', status: 'DONE', created_at: new Date(now - 1000).toISOString(), error: 'The stream was interrupted.' },
      ].map(s => JSON.stringify(s)).join('\n') + '\n',
      now - 1000,
    );

    // 2. Orchestrator parent awaiting after launching an active child (whose ask_question already cleared)
    writeFile(
      path.join(rootDir, 'brain', orchId, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        { step_index: 0, type: 'USER_INPUT', created_at: new Date(now - 10_000).toISOString(), content: 'Audit codebase' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now - 8000).toISOString(),
          model: 'gemini-pro-orchestrator-neon',
          input_tokens: 1000,
          output_tokens: 100,
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Code Auditor"', Model: '"flash"' } }],
        },
        { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: new Date(now - 7000).toISOString(), content: `Created the following subagent:\n{\n  "conversationId": "${subId}"\n}` },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 6000).toISOString(), model: 'gemini-pro-orchestrator-neon', input_tokens: 500, output_tokens: 50, content: 'Waiting for subagent.' },
      ].map(s => JSON.stringify(s)).join('\n') + '\n',
      now - 6000,
    );
    writeFile(
      path.join(rootDir, 'brain', subId, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        { step_index: 0, type: 'USER_INPUT', created_at: new Date(now - 6000).toISOString(), content: 'Audit codebase' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now - 5000).toISOString(),
          model: 'gemini-pro-orchestrator-neon',
          tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Proceed?' }] } }],
        },
        { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: new Date(now - 3000).toISOString(), content: 'User answered: Yes' },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now - 2000).toISOString(),
          model: 'gemini-pro-orchestrator-neon',
          tool_calls: [{ name: 'read_file', args: { Path: '"/workspace/claude-ville/README.md"' } }],
        },
      ].map(s => JSON.stringify(s)).join('\n') + '\n',
      now - 2000,
    );

    const adapter = new AntigravityAdapter({ rootDir, now: () => now });
    const sessions = adapter.getActiveSessions(60_000).map(s => normalizeSession(s));

    const errored = sessions.find(s => s.sessionId === `antigravity-${errId}`);
    assert.equal(errored.apiError?.kind, 'stream_error');
    assert.equal(resolveAgentStatus(errored, { now }), AgentStatus.ERRORED);

    const orch = sessions.find(s => s.sessionId === `antigravity-${orchId}`);
    const sub = sessions.find(s => s.sessionId === `antigravity-${subId}`);
    assert.equal(sub.waitReason, null, 'ask_question wait clears once GENERIC answer step lands');
    assert.equal(sub.turnState, 'tool_pending');
    assert.equal(orch.displayModel, 'Orch·Neon');
    assert.equal(orch.spriteId, 'agent.gemini.neon');
    assert.equal(orch.backgroundPending?.count, 1);
    assert.equal(resolveAgentStatus(orch, { now }), AgentStatus.WORKING, 'Orchestrator parent with live child stays WORKING');

    // Hook fixes: no toolSummary leak, PreInvocation/PostInvocation supported, script emits neutral {}
    assert.equal(promptDetailFrom({ toolSummary: 'Model-written prose' }), null);
    assert.equal(promptDetailFrom({ CommandLine: 'npm test', toolSummary: 'prose' }), 'npm test');
    const preInv = hookOverlay.ingest({ provider: 'antigravity', sessionId: `antigravity-${orchId}`, kind: 'PreInvocation', ts: now });
    assert.equal(preInv.turnState, 'working');
    const postInv = hookOverlay.ingest({ provider: 'antigravity', sessionId: `antigravity-${orchId}`, kind: 'PostInvocation', ts: now + 10 });
    assert.equal(postInv.turnState, 'working');

    let posted = null;
    let printed = '';
    runAntigravityHookIngest({
      env: { CLAUDEVILLE_INGEST_TOKEN: 'tok' },
      read: () => ({
        conversationId: orchId,
        hookEventName: 'PreToolUse',
        cwd: '/workspace',
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test token=secret', toolSummary: 'Model prose' } },
      }),
      request: () => ({ on() {}, end(body) { posted = JSON.parse(body); }, destroy() {} }),
      write: (out) => { printed += out; },
      now: () => now,
    });
    assert.equal(printed, '{}\n', 'PreToolUse forwarder must emit empty {} and never auto-allow');
    assert.equal(posted.provider, 'antigravity');
    assert.equal(posted.tool, 'run_command');
    assert.deepEqual(posted.input, { CommandLine: 'npm test token=[REDACTED]' });
    assert.equal(mapAntigravityHookEvent({ conversationId: 'x', hookEventName: 'PreInvocation' }).kind, 'PreInvocation');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity Orchestrator keeps its planner identity, and swarm workers marked internal link to their coordinator', () => {
  const tmp = makeTempDir('cv-antigravity-swarm-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const leadId = '12121212-1212-4121-8121-121212121212';
    const workerId = '34343434-3434-4343-8343-343434343434';
    const now = Date.parse('2026-11-20T22:00:00Z');
    const at = (msAgo) => new Date(now - msAgo).toISOString();
    const lines = (steps) => `${steps.map(s => JSON.stringify(s)).join('\n')}\n`;

    writeFile(path.join(rootDir, 'brain', leadId, '.system_generated', 'logs', 'transcript.jsonl'), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(60_000), content: 'Explore first' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(55_000), model: 'gemini-4-carbon-high', input_tokens: 10, output_tokens: 5, content: 'Explored.' },
      { step_index: 2, type: 'USER_INPUT', created_at: at(50_000), content: 'Now run a swarm' },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: at(45_000),
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 10,
        output_tokens: 5,
        tool_calls: [
          { name: 'swarm', args: { action: '"title"', title: '"Living Depth"' } },
          { name: 'swarm', args: { action: '"add"', brief: '"Own the GPU core."' } },
        ],
      },
      { step_index: 4, type: 'GENERIC', status: 'DONE', created_at: at(44_000), content: 'Created At: 2026-11-20T22:59:15+01:00\n{"status":"titled","title":"Living Depth"}' },
      {
        step_index: 5,
        type: 'GENERIC',
        status: 'DONE',
        created_at: at(43_000),
        content: `Created At: 2026-11-20T22:59:16+01:00\nCompleted At: 2026-11-20T22:59:17+01:00\n{"status":"added","name":"neon-gpu-core","model":"gemini-4-neon-xhigh","conversation_id":"${workerId}","note":"The brief is on the board as #1."}`,
      },
      { step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(40_000), model: 'gemini-flash-worker-agy', input_tokens: 10, output_tokens: 5, content: 'Workers added.' },
    ]), now - 40_000);
    writeFile(path.join(rootDir, 'brain', workerId, '.system_generated', 'logs', 'transcript.jsonl'), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(42_000), content: 'Own the GPU core.' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: at(30_000),
        model: 'gemini-4-neon-xhigh',
        input_tokens: 10,
        output_tokens: 5,
        tool_calls: [{ name: 'read_file', args: { Path: '"/workspace/claude-ville/README.md"' } }],
      },
    ]), now - 30_000);
    // agy's metadata cache marks every spawned conversation internal.
    writeFile(path.join(rootDir, 'cache', 'conversation_metadata.json'), JSON.stringify({
      conversations: { [workerId]: { is_internal: true, last_modified_time: at(30_000) } },
    }), now - 30_000);

    const adapter = new AntigravityAdapter({ rootDir, now: () => now });
    const sessions = adapter.getActiveSessions(5 * 60_000).map(s => normalizeSession(s));
    const lead = sessions.find(s => s.sessionId === `antigravity-${leadId}`);
    const worker = sessions.find(s => s.sessionId === `antigravity-${workerId}`);

    assert.equal(lead.model, 'gemini-pro-orchestrator-neon', 'executor steps keep the planner identity');
    assert.equal(lead.reasoningEffort, null, 'the Orchestrator never inherits the earlier Carbon effort');
    assert.equal(lead.spriteId, 'agent.gemini.neon');
    assert.equal(lead.teamName, 'Living Depth');

    assert.ok(worker, 'an internal swarm worker stays visible');
    assert.equal(worker.parentSessionId, `antigravity-${leadId}`);
    assert.equal(worker.agentType, 'sub-agent');
    assert.equal(worker.subagentKind, 'swarm');
    assert.equal(worker.agentName, 'neon-gpu-core');
    assert.equal(worker.teamName, 'Living Depth');
    assert.equal(worker.reasoningEffort, 'xhigh');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity keeps a quiet conversation its live process holds, idle or not, and its working crew while its turn is open', () => {
  const tmp = makeTempDir('cv-antigravity-presence-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const leadId = '56565656-5656-4565-8565-565656565656';
    const finishedId = '78787878-7878-4787-8787-787878787878';
    const exitedId = '9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a';
    const workerIds = {
      thinking: 'abababab-abab-4bab-8bab-abababababab',
      parked: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      killed: 'efefefef-efef-4fef-8fef-efefefefefef',
    };
    const now = Date.parse('2026-11-21T11:00:00Z');
    const quietMs = 90 * 60_000; // past the 60-minute discovery grace as well
    const crewQuietMs = 10 * 60_000;
    const at = (msAgo) => new Date(now - msAgo).toISOString();
    const lines = (steps) => `${steps.map(s => JSON.stringify(s)).join('\n')}\n`;
    const transcript = (id) => path.join(rootDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const commandTurn = (msAgo) => [
      { step_index: 0, type: 'USER_INPUT', created_at: at(msAgo + 10_000), content: 'Own your lane' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(msAgo + 5_000), model: 'gemini-4-carbon-high', tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: at(msAgo), content: 'Command exited with code 0.' },
    ];

    writeFile(transcript(leadId), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 60_000), content: 'Run the swarm' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: at(quietMs + 50_000),
        model: 'gemini-4-carbon-high',
        tool_calls: Object.keys(workerIds).map(name => ({ name: 'swarm', args: { action: '"add"', name: `"${name}"` } })),
      },
      ...Object.entries(workerIds).map(([name, id], idx) => ({
        step_index: 2 + idx,
        type: 'GENERIC',
        status: 'DONE',
        created_at: at(quietMs + 40_000),
        content: `{"status":"added","name":"${name}","conversation_id":"${id}"}`,
      })),
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs + 20_000), model: 'gemini-4-carbon-high', tool_calls: [{ name: 'swarm', args: { action: '"kill"', name: '"killed"' } }] },
      { step_index: 6, type: 'GENERIC', status: 'DONE', created_at: at(quietMs + 15_000), content: '{"status":"killed","name":"killed"}' },
      { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs + 5_000), model: 'gemini-4-carbon-high', tool_calls: [{ name: 'swarm_wait', args: { since: '"3"' } }] },
      { step_index: 8, type: 'GENERIC', status: 'DONE', created_at: at(quietMs), content: 'Waiting for a message that calls on you by name.' },
    ]), now - quietMs);
    writeFile(transcript(finishedId), lines([
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 10_000), content: 'Review the plan' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-carbon-high', content: 'Reviewed.' },
    ]), now - quietMs);
    writeFile(transcript(exitedId), lines(commandTurn(quietMs)), now - quietMs);
    writeFile(transcript(workerIds.thinking), lines(commandTurn(crewQuietMs)), now - crewQuietMs);
    writeFile(transcript(workerIds.killed), lines(commandTurn(crewQuietMs)), now - crewQuietMs);
    writeFile(transcript(workerIds.parked), lines([
      ...commandTurn(crewQuietMs + 20_000),
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(crewQuietMs + 5_000), model: 'gemini-4-carbon-high', tool_calls: [{ name: 'post_message', args: { text: '"@coordinator [done]"' } }, { name: 'swarm_wait', args: { since: '"4"' } }] },
      { step_index: 4, type: 'GENERIC', status: 'DONE', created_at: at(crewQuietMs), content: '{"status":"posted","seq":5}' },
      { step_index: 5, type: 'GENERIC', status: 'DONE', created_at: at(crewQuietMs), content: 'Waiting for a message that calls on you by name.' },
    ]), now - crewQuietMs);

    const inode = (id) => {
      const lockPath = path.join(rootDir, 'presence', `${id}.lock`);
      writeFile(lockPath, '', now - quietMs);
      return fs.statSync(lockPath).ino;
    };
    // The exited conversation's lock file remains, but only a waiter asks for it.
    const procLocks = [
      `1: FLOCK  ADVISORY  WRITE 4242 103:06:${inode(leadId)} 0 EOF`,
      `2: FLOCK  ADVISORY  WRITE 4343 103:06:${inode(finishedId)} 0 EOF`,
      `3: -> FLOCK  ADVISORY  WRITE 4444 103:06:${inode(exitedId)} 0 EOF`,
      '',
    ].join('\n');

    const sessions = new AntigravityAdapter({ rootDir, now: () => now, readLocks: () => procLocks }).getActiveSessions(2 * 60_000);
    assert.deepEqual(sessions.map(s => s.sessionId).sort(), [workerIds.thinking, leadId, finishedId].map(id => `antigravity-${id}`).sort(),
      'a released lock, a parked member and a killed member leave; a held closed turn stays');
    const byId = id => sessions.find(s => s.sessionId === `antigravity-${id}`);
    const [worker, lead] = [byId(workerIds.thinking), byId(leadId)];
    assert.equal(byId(finishedId).turnState, 'awaiting_input', 'idle at the prompt');
    assert.equal(lead.turnState, 'working');
    assert.equal(lead.lastActivity, now - quietMs, 'liveness never rewrites the last observed activity');
    assert.equal(worker.parentSessionId, `antigravity-${leadId}`);
    assert.equal(worker.turnState, 'working');
    assert.equal(lead.backgroundPending?.count, 1, 'the lead waits on its one working member');

    assert.deepEqual(new AntigravityAdapter({ rootDir, now: () => now, readLocks: () => '' }).getActiveSessions(2 * 60_000), [],
      'without lock evidence the activity window alone decides');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity reads a closed turn that waits on its own background task as waiting on crew, and keeps such a crew member', () => {
  const tmp = makeTempDir('cv-antigravity-tasks-');
  try {
    const rootDir = path.join(tmp, '.gemini', 'antigravity-cli');
    const ids = {
      waiting: '13131313-1313-4313-8313-131313131313',
      reported: '24242424-2424-4424-8424-242424242424',
      stale: '35353535-3535-4535-8535-353535353535',
      released: '46464646-4646-4646-8646-464646464646',
      lead: '57575757-5757-4757-8757-575757575757',
      member: '68686868-6868-4868-8868-686868686868',
      doneMember: '79797979-7979-4979-8979-797979797979',
    };
    const now = Date.parse('2026-11-22T11:00:00Z');
    const quietMs = 20 * 60_000;
    const at = (msAgo) => new Date(now - msAgo).toISOString();
    const transcript = (id) => path.join(rootDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const started = (id, index, msAgo) => ({
      step_index: index,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: at(msAgo),
      content: `Tool is running as a background task with task id: ${id}/task-${index}\nTask Description: gh run watch 42`,
    });
    const ended = (id, task, index, msAgo, verb) => ({
      step_index: index,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: at(msAgo),
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${id}/task-${task} content=Task id "${id}/task-${task}" ${verb} with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
    });
    const write = (id, quiet, steps) => writeFile(transcript(id), `${[
      { step_index: 0, type: 'USER_INPUT', created_at: at(quiet + 30_000), content: 'Merge once CI is green' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quiet + 20_000), model: 'gemini-4-neon-xhigh', tool_calls: [{ name: 'run_command', args: { CommandLine: '"gh run watch 42"' } }] },
      ...steps,
      { step_index: 9, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quiet), model: 'gemini-4-neon-xhigh', content: 'Watching CI; I will merge once it is green.' },
    ].map(s => JSON.stringify(s)).join('\n')}\n`, now - quiet);

    write(ids.waiting, quietMs, [started(ids.waiting, 2, quietMs + 10_000)]);
    write(ids.reported, quietMs, [
      started(ids.reported, 2, quietMs + 15_000),
      started(ids.reported, 3, quietMs + 10_000),
      ended(ids.reported, 2, 4, quietMs + 5_000, 'finished'),
      ended(ids.reported, 3, 5, quietMs + 5_000, 'was canceled'),
    ]);
    write(ids.stale, 90 * 60_000, [started(ids.stale, 2, 90 * 60_000 + 10_000)]);
    write(ids.released, quietMs, [started(ids.released, 2, quietMs + 10_000)]);
    // A swarm member runs in its lead's process and holds no lock of its own.
    writeFile(transcript(ids.lead), `${[
      { step_index: 0, type: 'USER_INPUT', created_at: at(quietMs + 60_000), content: 'Run the swarm' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs + 50_000), model: 'gemini-4-neon-xhigh', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"member"' } }, { name: 'swarm', args: { action: '"add"', name: '"done-member"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: at(quietMs + 40_000), content: `{"status":"added","name":"member","conversation_id":"${ids.member}"}` },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: at(quietMs + 40_000), content: `{"status":"added","name":"done-member","conversation_id":"${ids.doneMember}"}` },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(quietMs), model: 'gemini-4-neon-xhigh', content: 'The crew is at work.' },
    ].map(s => JSON.stringify(s)).join('\n')}\n`, now - quietMs);
    write(ids.member, quietMs, [started(ids.member, 2, quietMs + 10_000)]);
    write(ids.doneMember, quietMs, []);

    const inode = (id) => {
      const lockPath = path.join(rootDir, 'presence', `${id}.lock`);
      writeFile(lockPath, '', now - 90 * 60_000);
      return fs.statSync(lockPath).ino;
    };
    const procLocks = [ids.waiting, ids.reported, ids.stale, ids.lead]
      .map((id, idx) => `${idx + 1}: FLOCK  ADVISORY  WRITE 4242 103:06:${inode(id)} 0 EOF`)
      .concat(`5: -> FLOCK  ADVISORY  WRITE 4343 103:06:${inode(ids.released)} 0 EOF`, '')
      .join('\n');

    const sessions = new AntigravityAdapter({ rootDir, now: () => now, readLocks: () => procLocks }).getActiveSessions(2 * 60_000);
    const byId = id => sessions.find(s => s.sessionId === `antigravity-${id}`);
    assert.deepEqual(sessions.map(s => s.sessionId).sort(),
      [ids.waiting, ids.reported, ids.stale, ids.lead, ids.member].map(id => `antigravity-${id}`).sort(),
      'held conversations stay; a released lock and a closed member with no running task leave');
    const waiting = byId(ids.waiting);
    assert.equal(waiting.turnState, 'awaiting_input');
    assert.deepEqual(waiting.backgroundPending, { count: 1, kinds: ['bash'], since: now - quietMs - 10_000 });
    assert.equal(waiting.lastActivity, now - quietMs, 'liveness never rewrites the last observed activity');
    assert.equal(byId(ids.reported).backgroundPending, null, 'a finished and a canceled task no longer count');
    assert.equal(byId(ids.stale).backgroundPending, null, 'a task past the backstop no longer counts');
    const member = byId(ids.member);
    assert.equal(member.parentSessionId, `antigravity-${ids.lead}`);
    assert.deepEqual(member.backgroundPending, { count: 1, kinds: ['bash'], since: now - quietMs - 10_000 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Antigravity discovers T3 Code agy acp conversations under ~/.t3 when no root is set', () => {
  const tmp = makeTempDir('cv-antigravity-t3-');
  const savedHome = process.env.HOME;
  const savedRoot = process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
  try {
    process.env.HOME = tmp;
    delete process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
    const convId = 'dddddddd-5555-4555-8555-555555555555';
    const now = Date.parse('2026-11-23T12:47:00Z');
    const acpDir = path.join(tmp, '.t3', 'userdata', 'providers', 'antigravity', 'ac0a3dfd', 'antigravity-acp');
    writeFile(path.join(acpDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'), `${JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(now - 5_000).toISOString(),
      model: 'gemini-4-neon-high',
      input_tokens: 100,
      output_tokens: 20,
      content: 'Done.',
    })}\n`, now - 5_000);

    const adapter = new AntigravityAdapter({ now: () => now });
    assert.equal(adapter.isAvailable(), true);
    const session = adapter.getActiveSessions(2 * 60_000).find(s => s.sessionId === `antigravity-${convId}`);
    assert.ok(session, 'a T3 Code conversation is discovered');
    assert.equal(session.model, 'gemini-4-neon');
    assert.ok(adapter.getWatchPaths({ sessions: [] }).some(p => p.path === path.join(acpDir, 'brain')));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedRoot !== undefined) process.env.CLAUDEVILLE_ANTIGRAVITY_DIR = savedRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

let nodeSqlite = null;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  // node:sqlite is unflagged from Node 22.13; without it T3 lineage is skipped.
}

test('Antigravity groups a T3 Code delegate under the thread that started it', { skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable' }, () => {
  const tmp = makeTempDir('cv-antigravity-t3-lineage-');
  const savedHome = process.env.HOME;
  const savedRoot = process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
  try {
    process.env.HOME = tmp;
    delete process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
    const delegateId = 'eeeeeeee-6666-4666-8666-666666666666';
    const ownId = 'ffffffff-7777-4777-8777-777777777777';
    const claudeId = '00dd9673-f202-4300-a82a-0ef61373229e';
    const now = Date.parse('2026-11-23T12:47:00Z');
    const acpDir = path.join(tmp, '.t3', 'userdata', 'providers', 'antigravity', 'ac0a3dfd', 'antigravity-acp');
    for (const id of [delegateId, ownId]) {
      writeFile(path.join(acpDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), `${JSON.stringify({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(now - 5_000).toISOString(),
        model: 'gemini-4-neon-high',
        content: 'Done.',
      })}\n`, now - 5_000);
    }

    const db = new nodeSqlite.DatabaseSync(path.join(tmp, '.t3', 'userdata', 'statev2.sqlite'));
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL);
      CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        attempt_ordinal INTEGER NOT NULL, provider TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    const thread = db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)');
    const run = db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)');
    const attempt = db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, 1, ?, ?)');
    const addRun = (threadId, ordinal, provider, nativeThreadId) => {
      const runId = `run:${threadId}:${ordinal}`;
      run.run(runId, threadId, ordinal);
      attempt.run(`${runId}:1`, threadId, runId, provider, JSON.stringify({ nativeThreadId }));
    };
    thread.run('orchestrator', 'Orchestrator', JSON.stringify({}));
    addRun('orchestrator', 1, 'claudeAgent', 'a-session-the-orchestrator-left');
    addRun('orchestrator', 2, 'claudeAgent', claudeId);
    thread.run('delegate', 'L1 fix-cause: supply', JSON.stringify({ lineage: { parentThreadId: 'orchestrator', relationshipToParent: 'subagent' } }));
    addRun('delegate', 1, 'antigravity', delegateId);
    thread.run('own', 'Started in T3 Code', JSON.stringify({}));
    addRun('own', 1, 'antigravity', ownId);
    db.close();

    const sessions = new AntigravityAdapter({ now: () => now }).getActiveSessions(2 * 60_000);
    const delegate = sessions.find(s => s.sessionId === `antigravity-${delegateId}`);
    assert.equal(delegate.parentSessionId, claudeId, 'the parent thread\'s latest session is the parent');
    assert.equal(delegate.rootSessionId, claudeId);
    assert.equal(delegate.agentType, 'sub-agent');
    assert.equal(delegate.subagentKind, 'delegate');
    assert.equal(delegate.agentName, 'L1 fix-cause: supply');
    const own = sessions.find(s => s.sessionId === `antigravity-${ownId}`);
    assert.equal(own.parentSessionId, null, 'a thread T3 Code started itself has no parent');
    assert.equal(own.agentType, 'main');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedRoot !== undefined) process.env.CLAUDEVILLE_ANTIGRAVITY_DIR = savedRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
