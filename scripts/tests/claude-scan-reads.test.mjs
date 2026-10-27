import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// SV-3 and SV-4: an unchanged Claude rescan must not re-read what cannot have
// changed (a sub-agent's first prompt) or what it never uses (task groups of
// sessions outside the scan).
const tmpHome = makeTempDir('claudeville-scan-reads-');
const previousHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
const { getTailCacheDiagnostics } = require('../../claudeville/adapters/shared.js');

const project = path.join(tmpHome, 'workspace', 'fixture');
const projectDir = path.join(tmpHome, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
const tasksDir = path.join(tmpHome, '.claude', 'tasks');
const parentId = 'aaaaaaaa-0000-4000-8000-000000000001';
const thresholdMs = 10 * 60 * 1000;
const at = offsetMs => new Date(Date.now() - offsetMs).toISOString();
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const userLine = (uuid, content) => ({
  type: 'user', sessionId: parentId, uuid, timestamp: at(3000), cwd: project, isSidechain: true,
  message: { role: 'user', content },
});
const assistantLine = uuid => ({
  type: 'assistant', sessionId: parentId, uuid, timestamp: at(2000), cwd: project, isSidechain: true,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Mapping.' }], usage: { input_tokens: 1, output_tokens: 1 } },
});
const childPath = id => path.join(projectDir, parentId, 'subagents', `agent-${id}.jsonl`);

fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.dirname(childPath('x')), { recursive: true });
fs.writeFileSync(path.join(projectDir, `${parentId}.jsonl`), jsonl([
  { type: 'user', sessionId: parentId, uuid: 'u1', timestamp: at(5000), cwd: project, message: { role: 'user', content: 'lead prompt' } },
  {
    type: 'assistant', sessionId: parentId, uuid: 'a1', timestamp: at(4000), cwd: project,
    message: {
      role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Fixture crew', prompt: 'Map the fixture', subagent_type: 'Explore' } }],
    },
  },
]));
fs.writeFileSync(path.join(tmpHome, '.claude', 'history.jsonl'), jsonl([{ display: 'x', timestamp: Date.now(), project, sessionId: parentId }]));
fs.mkdirSync(path.join(tasksDir, parentId), { recursive: true });
fs.writeFileSync(path.join(tasksDir, parentId, '1.json'), JSON.stringify({ id: '1', subject: 'First', status: 'completed' }));
fs.writeFileSync(path.join(tasksDir, parentId, '2.json'), JSON.stringify({ id: '2', subject: 'Second', status: 'in_progress' }));
for (let index = 0; index < 40; index++) {
  fs.mkdirSync(path.join(tasksDir, `old-${index}`));
  fs.writeFileSync(path.join(tasksDir, `old-${index}`, '1.json'), JSON.stringify({ id: '1', subject: 'Old', status: 'completed' }));
}

const adapter = new ClaudeAdapter();
test.after(() => {
  adapter.shutdown();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function scan() {
  const before = getTailCacheDiagnostics().parsed.headBytesRead;
  const sessions = adapter.getActiveSessions(thresholdMs);
  return { sessions, headBytes: getTailCacheDiagnostics().parsed.headBytesRead - before };
}
const byId = (sessions, id) => sessions.find(session => session.sessionId === id);

test('a scan reads task groups only for the sessions it projects', () => {
  const originalReaddir = fs.readdirSync;
  const originalReadFile = fs.readFileSync;
  const touched = [];
  fs.readdirSync = (target, ...rest) => { touched.push(String(target)); return originalReaddir(target, ...rest); };
  fs.readFileSync = (target, ...rest) => { touched.push(String(target)); return originalReadFile(target, ...rest); };
  let sessions;
  try {
    ({ sessions } = scan());
  } finally {
    fs.readdirSync = originalReaddir;
    fs.readFileSync = originalReadFile;
  }
  assert.deepEqual(byId(sessions, parentId).taskProgress, { done: 1, total: 2, source: 'exact' });
  assert.equal(byId(sessions, parentId).tasks.length, 2);
  assert.equal(touched.filter(target => target === tasksDir).length, 0, 'the scan never lists the whole tasks dir');
  assert.deepEqual(touched.filter(target => target.includes(`${path.sep}old-`)), [], 'unrelated groups stay unread');
  assert.equal(adapter.getTasks().length, 41, '/api/tasks keeps the full sweep');
});

test('a sub-agent first prompt is read once per file identity, and again after a rewrite', () => {
  fs.writeFileSync(childPath('crew'), jsonl([userLine('s1', 'Map the fixture'), assistantLine('s2')]));
  const first = scan();
  assert.equal(byId(first.sessions, 'subagent-crew').agentName, 'Fixture crew');
  assert.equal(byId(first.sessions, 'subagent-crew').subagentKind, 'Explore');
  assert.ok(first.headBytes > 0);

  assert.equal(scan().headBytes, 0, 'an unchanged rescan reads no head');
  fs.appendFileSync(childPath('crew'), jsonl([assistantLine('s3')]));
  const appended = scan();
  assert.equal(appended.headBytes, 0, 'an append leaves the head, and its prompt, as it was');
  assert.equal(byId(appended.sessions, 'subagent-crew').agentName, 'Fixture crew');

  // A shrink means the file was rewritten in place: its head is read again.
  fs.writeFileSync(childPath('crew'), jsonl([userLine('s9', 'Something else')]));
  const rewritten = scan();
  assert.ok(rewritten.headBytes > 0);
  assert.equal(byId(rewritten.sessions, 'subagent-crew').subagentKind ?? null, null, 'the new prompt matches no launch');
});

test('PV-15: a sub-agent whose meta names its launch never reads its head', () => {
  fs.writeFileSync(childPath('meta'), jsonl([userLine('m1', 'Map the fixture'), assistantLine('m2')]));
  fs.writeFileSync(childPath('meta').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_1' }));
  const first = scan();
  assert.equal(byId(first.sessions, 'subagent-meta').agentName, 'Fixture crew');
  assert.equal(byId(first.sessions, 'subagent-meta').subagentKind, 'Explore');
  assert.equal(first.headBytes, 0, 'the launch matches by toolUseId, with no first-prompt read');
});

test('a sub-agent without a prompt yet is re-read as it grows', () => {
  fs.writeFileSync(childPath('late'), jsonl([assistantLine('l1')]));
  assert.equal(byId(scan().sessions, 'subagent-late').subagentKind ?? null, null);
  assert.equal(scan().headBytes, 0, 'an unchanged file keeps its missing prompt');
  fs.appendFileSync(childPath('late'), jsonl([userLine('l2', 'Map the fixture')]));
  const grown = scan();
  assert.ok(grown.headBytes > 0);
  assert.equal(byId(grown.sessions, 'subagent-late').agentName, 'Fixture crew');
});
