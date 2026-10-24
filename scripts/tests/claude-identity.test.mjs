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
