import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../adapters/fixtures/claude');

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude keeps a seen main identity and separates Agent kind from agentType', () => {
  const root = makeTempDir('claudeville-claude-identity-');
  const previousHome = process.env.HOME;
  let adapter = null;
  try {
    process.env.HOME = root;
    const project = path.join(root, 'work', 'identity');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const parentPath = path.join(projectDir, 'identity-main.jsonl');
    const childPath = path.join(projectDir, 'identity-main', 'subagents', 'agent-explorer.jsonl');
    const orphanPath = path.join(projectDir, 'never-seen.jsonl');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-launch.jsonl'), parentPath);
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-child.jsonl'), childPath);
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'minimal.jsonl'), orphanPath);

    const historyPath = path.join(root, '.claude', 'history.jsonl');
    writeJsonLines(historyPath, [{
      sessionId: 'identity-main',
      project,
      timestamp: Date.now(),
      model: 'claude-opus-4-6',
      agentType: 'main',
    }]);

    const require = createRequire(import.meta.url);
    const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
    adapter = new ClaudeAdapter();

    const initial = adapter.getActiveSessions(60 * 60 * 1000);
    assert.equal(initial.find(session => session.sessionId === 'identity-main')?.agentType, 'main');
    const child = initial.find(session => session.sessionId === 'subagent-explorer');
    assert.equal(child?.agentType, 'sub-agent');
    assert.equal(child?.subagentKind, 'Explore');
    assert.equal(initial.find(session => session.sessionId === 'never-seen')?.agentType, 'team-member');

    writeJsonLines(historyPath, [{
      sessionId: 'identity-main',
      project,
      timestamp: Date.now() - (11 * 60 * 1000),
      model: 'claude-opus-4-6',
      agentType: 'main',
    }]);
    const afterHistoryAgesOut = adapter.getActiveSessions(60 * 60 * 1000);
    const main = afterHistoryAgesOut.find(session => session.sessionId === 'identity-main');
    assert.equal(main?.agentType, 'main');
    assert.equal(main?.agentId, null);
    assert.equal(adapter.getPerfStats().sessionIdentity.entryLimit, 4096);
    assert.ok(adapter.getPerfStats().sessionIdentity.entries <= 4096);
  } finally {
    adapter?.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PV-4a / RG-12: a `<synthetic>` API-error stub never names the model or
// speaks as it, and a tail window with no assistant record falls back to the
// transcript's own model instead of an 'unknown' placeholder that reads 200K.
test('Claude skips model stubs and falls back to the transcript model', () => {
  const root = makeTempDir('claudeville-claude-model-');
  try {
    const project = path.join(root, 'work', 'model');
    fs.mkdirSync(project, { recursive: true });
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const now = Date.now();
    const at = msAgo => new Date(now - msAgo).toISOString();
    const usage = { input_tokens: 1000, output_tokens: 20 };
    writeJsonLines(path.join(projectDir, 'stub-main.jsonl'), [
      { type: 'user', timestamp: at(60_000), message: { role: 'user', content: 'Read the parser.' } },
      { type: 'assistant', timestamp: at(50_000), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage, content: [
        { type: 'text', text: 'Reading the parser.' },
        { type: 'tool_use', id: 'toolu_stub_read', name: 'Read', input: { file_path: 'src/parser.js' } },
      ] } },
      { type: 'user', timestamp: at(45_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stub_read', content: 'export {};' }] } },
      { type: 'assistant', timestamp: at(5_000), isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 }, content: [
        { type: 'text', text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' },
      ] } },
    ]);
    writeJsonLines(path.join(projectDir, 'quiet-main.jsonl'), [
      { type: 'user', timestamp: at(120_000), message: { role: 'user', content: 'Summarize the parser.' } },
      { type: 'assistant', timestamp: at(110_000), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'The parser reads lines.' }] } },
      ...Array.from({ length: 32 }, (_, i) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(100_000 - i * 1000) })),
    ]);
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [
      { sessionId: 'stub-main', project, timestamp: now, display: 'Stub fixture' },
      { sessionId: 'quiet-main', project, timestamp: now, display: 'Quiet fixture' },
    ]);

    const script = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { normalizeSession } = require('./claudeville/adapters');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000);
      const pick = id => {
        const s = sessions.find(session => session.sessionId === id);
        return s && { model: s.model, published: normalizeSession(s).model, contextWindowMax: s.contextWindowMax, tokenMax: s.tokenUsage.contextWindowMax, dialogue: s.dialogue };
      };
      process.stdout.write(JSON.stringify({ stub: pick('stub-main'), quiet: pick('quiet-main') }));
      adapter.shutdown();
    `;
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const { stub, quiet } = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    }));

    assert.equal(stub.model, 'claude-opus-5-5');
    assert.equal(stub.tokenMax, 1_000_000);
    assert.equal(stub.dialogue?.text, 'Reading the parser.');
    assert.equal(stub.dialogue?.authorship, 'model');

    assert.equal(quiet.model, null);
    assert.equal(quiet.published, 'claude');
    assert.equal(quiet.tokenMax, 1_000_000);
    assert.equal(quiet.contextWindowMax, 1_000_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SM-4: teammates' first prompt arrives wrapped in <teammate-message>, so the
// launch prompt hash never matches; the sibling meta file names them.
test('Claude subagents read their name, team and colour from agent-<id>.meta.json', () => {
  const root = makeTempDir('claudeville-claude-meta-');
  try {
    const project = path.join(root, 'work', 'meta');
    fs.mkdirSync(project, { recursive: true });
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const subagents = path.join(projectDir, 'meta-main', 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-launch.jsonl'), path.join(projectDir, 'meta-main.jsonl'));
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'teammate-child.jsonl'), path.join(subagents, 'agent-lane.jsonl'));
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'teammate-child.meta.json'), path.join(subagents, 'agent-lane.meta.json'));
    // A launch-matched child keeps its launch kind; its meta name wins over
    // the launch description.
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-child.jsonl'), path.join(subagents, 'agent-explorer.jsonl'));
    fs.writeFileSync(path.join(subagents, 'agent-explorer.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'explorer-fixture' }));
    // Malformed or oversized metadata is no metadata.
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'teammate-child.jsonl'), path.join(subagents, 'agent-broken.jsonl'));
    fs.writeFileSync(path.join(subagents, 'agent-broken.meta.json'), '{"name": "never');
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'teammate-child.jsonl'), path.join(subagents, 'agent-huge.jsonl'));
    fs.writeFileSync(path.join(subagents, 'agent-huge.meta.json'), JSON.stringify({ name: 'huge', pad: 'x'.repeat(70 * 1024) }));
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [{
      sessionId: 'meta-main', project, timestamp: Date.now(), model: 'claude-opus-4-6', agentType: 'main',
    }]);

    const script = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { normalizeSession } = require('./claudeville/adapters');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000).map(normalizeSession);
      const pick = id => {
        const s = sessions.find(session => session.sessionId === id);
        return s && { agentName: s.agentName, agentType: s.agentType, subagentKind: s.subagentKind, teamName: s.teamName, agentColor: s.agentColor, recipients: s.sendMessages.map(edge => edge.recipient) };
      };
      process.stdout.write(JSON.stringify({ lane: pick('subagent-lane'), explorer: pick('subagent-explorer'), broken: pick('subagent-broken'), huge: pick('subagent-huge') }));
      adapter.shutdown();
    `;
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const { lane, explorer, broken, huge } = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    }));
    assert.deepEqual(lane, {
      agentName: 'lane-fixture',
      agentType: 'sub-agent',
      subagentKind: 'general-purpose',
      teamName: 'session-fixture',
      agentColor: 'cyan',
      recipients: ['team-lead'],
    });
    assert.equal(explorer.agentName, 'explorer-fixture');
    assert.equal(explorer.subagentKind, 'Explore');
    assert.equal(explorer.teamName, null);
    assert.equal(broken.agentName, null);
    assert.equal(broken.teamName, null);
    assert.equal(huge.agentName, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PV-15: a nested helper's meta names its real parent (`parentAgentId`, a
// sibling transcript) and the launching call (`toolUseId`), which matches in
// that parent's own transcript, never by hashing the first prompt.
test('Claude nested subagents hang under their real parent and keep their root', () => {
  const root = makeTempDir('claudeville-claude-nested-');
  try {
    const project = path.join(root, 'work', 'nested');
    fs.mkdirSync(project, { recursive: true });
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const subagents = path.join(projectDir, 'nest-main', 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-launch.jsonl'), path.join(projectDir, 'nest-main.jsonl'));
    for (const [fixture, id] of [['nested-parent', 'nestedparent'], ['nested-child', 'nestedchild']]) {
      fs.copyFileSync(path.join(FIXTURE_ROOT, `${fixture}.jsonl`), path.join(subagents, `agent-${id}.jsonl`));
      fs.copyFileSync(path.join(FIXTURE_ROOT, `${fixture}.meta.json`), path.join(subagents, `agent-${id}.meta.json`));
    }
    // A parent named in meta but absent here leaves the child on its root.
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'nested-child.jsonl'), path.join(subagents, 'agent-orphaned.jsonl'));
    fs.writeFileSync(path.join(subagents, 'agent-orphaned.meta.json'), JSON.stringify({
      agentType: 'general-purpose', toolUseId: 'toolu_gone', parentAgentId: 'gone', spawnDepth: 2,
    }));
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [{
      sessionId: 'nest-main', project, timestamp: Date.now(), model: 'claude-opus-5-5', agentType: 'main',
    }]);

    const script = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { normalizeSession } = require('./claudeville/adapters');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000).map(normalizeSession);
      const pick = id => {
        const s = sessions.find(session => session.sessionId === id);
        return s && { agentName: s.agentName, subagentKind: s.subagentKind, parentSessionId: s.parentSessionId, rootSessionId: s.rootSessionId ?? null, taskProgress: s.taskProgress };
      };
      process.stdout.write(JSON.stringify({ main: pick('nest-main'), lane: pick('subagent-nestedparent'), helper: pick('subagent-nestedchild'), orphaned: pick('subagent-orphaned') }));
      adapter.shutdown();
    `;
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const { main, lane, helper, orphaned } = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    }));
    // The lane matches the main thread's launch `agent-1` by id.
    assert.deepEqual({ ...lane, taskProgress: undefined }, {
      agentName: 'Map the fixture', subagentKind: 'Explore', parentSessionId: 'nest-main', rootSessionId: 'nest-main', taskProgress: undefined,
    });
    // The helper matches `toolu_nested` in the lane's own transcript.
    assert.deepEqual({ ...helper, taskProgress: undefined }, {
      agentName: 'Nested helper', subagentKind: 'Explore', parentSessionId: 'subagent-nestedparent', rootSessionId: 'nest-main', taskProgress: undefined,
    });
    assert.equal(orphaned.parentSessionId, 'nest-main');
    assert.equal(orphaned.agentName, null, 'no launch matches an id its parent never wrote');
    // Root grouping still counts the whole crew.
    assert.equal(main.taskProgress?.total, 3);
    assert.equal(main.rootSessionId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
