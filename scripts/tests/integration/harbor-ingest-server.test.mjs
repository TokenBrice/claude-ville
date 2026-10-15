// The real server path: server.js startup, the worker-enabled git enrichment,
// wire compaction and /api/sessions, over a repository whose detached
// worktree shares the commits of an upstream-less branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startIsolatedServer } from '../../smoke/support/isolated-server.mjs';
import { makeTempDir } from '../support/tmp.mjs';
import { buildRepos, commitFile, git, isolateGitConfig } from '../support/harbor-ingest.mjs';

isolateGitConfig(test);

function decodeWire(payload) {
  const fields = payload.gitEventFields || [];
  const tables = new Map((payload.gitEventStringTables || []).map(([index, values]) => [index, values]));
  return Object.values(payload.gitEventsById || {}).map((row) => {
    const [masks, ...values] = row;
    const event = {};
    let cursor = 0;
    fields.forEach((field, index) => {
      if (!(Math.floor(masks[Math.floor(index / 30)] / (2 ** (index % 30))) % 2)) return;
      const value = values[cursor++];
      event[field] = tables.has(index) ? tables.get(index)[value] : value;
    });
    return event;
  });
}

// A live Claude main session in the repository whose Bash calls are the
// given commands with their outputs.
function seedClaudeSession(home, project, calls) {
  const sessionId = '00000000-0000-4000-8000-00000000c1de';
  const directory = path.join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const records = [{ type: 'user', timestamp: new Date(now - 10_000).toISOString(), cwd: project, message: { role: 'user', content: [{ type: 'text', text: 'Run the harness.' }] } }];
  calls.forEach(([command, output], index) => {
    const id = `toolu_harbor_${index}`;
    const at = now - 9_000 + index * 1000;
    records.push({ type: 'assistant', timestamp: new Date(at).toISOString(), cwd: project, gitBranch: 'main', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    records.push({ type: 'user', timestamp: new Date(at + 500).toISOString(), cwd: project, toolUseResult: { stdout: output, stderr: '', interrupted: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: output }] } });
  });
  fs.writeFileSync(path.join(directory, `${sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'history.jsonl'), `${JSON.stringify({ sessionId, agentType: 'main', model: 'claude-opus-5-5', project, timestamp: now, display: 'harbor harness' })}\n`);
}

test('/api/sessions: branch labels beside a detached worktree, and no phantom cargo from harness commands', { timeout: 30_000 }, async (t) => {
  const repos = buildRepos(t);
  // Repo Watch discovers repositories with a GitHub remote under the scan root.
  git(repos.main, 'remote', 'add', 'github', 'git@github.com:example/harbor.git');
  git(repos.main, 'switch', '-q', '-c', 'proto');
  const proto = [
    commitFile(repos.main, 'p1.txt', 'proto one'),
    commitFile(repos.main, 'p2.txt', 'proto two'),
    commitFile(repos.main, 'p3.txt', 'proto three'),
  ];
  git(repos.main, 'switch', '-q', 'main');
  const outside = path.join(repos.root, 'outside');
  // A detached worktree at the branch tip (0 commits beyond it), and one with
  // cargo of its own on no branch.
  git(repos.main, 'worktree', 'add', '-q', '--detach', path.join(outside, 'cand'), proto[2]);
  const probe = path.join(outside, 'probe');
  git(repos.main, 'worktree', 'add', '-q', '--detach', probe, 'origin/main');
  const detachedOnly = commitFile(probe, 'd.txt', 'detached only');

  const realSha = commitFile(repos.main, 'real.txt', 'real cargo');
  const home = makeTempDir('claudeville-harbor-server-');
  seedClaudeSession(home, repos.main, [
    // Harness commands whose directory cannot be known, or that ran in a
    // repository that no longer exists, plus a ghost and one real commit.
    ['cd "$D" && cd c && git commit -q --allow-empty -m base', '[main 2fecba4] base'],
    ['cd /nonexistent-claudeville-harbor/c && git commit -m x', '[main 1234567] x'],
    ['git commit -m det', '[main 0badc0d] det'],
    ['git commit -m "real cargo"', `[main ${realSha.slice(0, 7)}] real cargo`],
  ]);
  const server = await startIsolatedServer({
    home,
    env: {
      PATH: process.env.PATH,
      CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '',
      CLAUDEVILLE_REPOSITORY_SCAN_ROOT: repos.root,
    },
  });
  t.after(() => server.stop());

  let payload = null;
  let commits = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${server.baseUrl}/api/sessions?force=1`, { headers: { Host: `127.0.0.1:${server.port}` } });
    payload = await response.json();
    commits = decodeWire(payload).filter((event) => event.type === 'commit' && event.repoRoot === repos.main);
    if (commits.length >= 5 && decodeWire(payload).some((event) => event.type === 'rewritten')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(payload.gitEventFields.includes('branches'), 'compaction carries branches');
  const all = decodeWire(payload);
  for (const label of ['base', 'x', 'det']) {
    assert.deepEqual(all.filter((event) => event.type === 'commit' && event.label === label), [], `no phantom ${label} cargo`);
  }
  assert.ok(all.some((event) => event.type === 'rewritten' && event.oldIds?.length), 'the ghost observation is retired');
  const real = commits.find((event) => event.label === 'real cargo');
  assert.equal(real?.attribution, 'observed', 'the real observed commit merges with its scan');
  assert.equal(real.sha, realSha);
  const bySha = new Map(commits.map((event) => [event.sha, event]));
  assert.equal(bySha.size, 5, `five unpushed commits reach /api/sessions (${[...bySha.keys()].length})`);
  for (const sha of proto) {
    assert.equal(bySha.get(sha).branch, 'proto', sha);
    assert.deepEqual(bySha.get(sha).branches, ['proto'], sha);
    assert.equal(bySha.get(sha).detached, undefined, sha);
  }
  assert.equal(bySha.get(detachedOnly).branch, null);
  assert.equal(bySha.get(detachedOnly).detached, true);
  assert.equal(bySha.get(detachedOnly).branches, undefined);
});
