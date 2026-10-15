import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';
import { git, isolateGitConfig } from './support/harbor-ingest.mjs';

isolateGitConfig(test);
const require = createRequire(import.meta.url);
const FIXTURES = path.resolve(import.meta.dirname, '../adapters/fixtures');
const { _test: codex } = require('../../claudeville/adapters/codex.js');
const { _test: claude } = require('../../claudeville/adapters/claude.js');
const { _test: registry } = require('../../claudeville/adapters/index.js');

const now = Date.now();

function project(t) {
  const root = fs.realpathSync(makeTempDir('claudeville-harbor-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const sub = path.join(repo, 'vendor', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  return { root, repo, sub };
}

function materialize(file, replacements) {
  let content = fs.readFileSync(file, 'utf8');
  for (const [placeholder, value] of replacements) content = content.replaceAll(placeholder, value);
  return content;
}

test('Codex: current custom_tool_call + item_completed rollouts yield observed commit and push events', (t) => {
  const { repo, sub } = project(t);
  const content = materialize(path.join(FIXTURES, 'codex', 'git-commit-push.jsonl'), new Map([
    ['__PROJECT__', repo],
    ['__FIVE_MINUTES_AGO__', new Date(now - 5 * 60_000).toISOString()],
    ['__FOUR_MINUTES_AGO__', new Date(now - 4 * 60_000).toISOString()],
    ['__THREE_MINUTES_AGO__', new Date(now - 3 * 60_000).toISOString()],
    ['__NOW__', new Date(now).toISOString()],
    ['__FOUR_MINUTES_AGO_MS__', String(now - 4 * 60_000)],
    ['__THREE_MINUTES_AGO_MS__', String(now - 3 * 60_000)],
    ['__COMMAND_STARTED_MS__', String(now - 1500)],
    ['__NOW_MS__', String(now)],
  ]));
  const entries = content.trim().split('\n').map((line) => JSON.parse(line));
  const events = codex.getGitEvents(null, { provider: 'codex', sessionId: 'codex-git', project: repo }, entries);

  const commits = events.filter((event) => event.type === 'commit');
  assert.deepEqual(commits.map((event) => event.label), ['Add harbor fixture', 'Bump submodule'],
    'the nothing-to-commit call yields no ship');
  const [commit, subCommit] = commits;
  assert.equal(commit.sha, '1a2b3c4');
  assert.equal(commit.branch, 'main');
  assert.equal(commit.success, true);
  assert.equal(commit.exitCode, 0);
  assert.equal(commit.sourceId, 'exec-commit');
  assert.equal(commit.repoRoot, repo);
  assert.equal(commit.cwd, repo);
  assert.equal(commit.attribution, 'observed');
  assert.ok(commit.confidence >= 0.95);
  assert.equal(subCommit.repoRoot, sub, 'git -C attributes the commit to the nested repository');

  const [push] = events.filter((event) => event.type === 'push');
  assert.ok(push, 'the push is observed');
  assert.equal(push.branch, 'main', 'HEAD resolves to the branch checked out at observation');
  assert.equal(push.success, true);
  assert.equal(push.status, 'success');
  assert.deepEqual(push.refs, [{ src: 'main', dst: 'main', status: 'ok', sha: '1a2b3c4' }]);
  assert.ok(push.ts < subCommit.ts);
});

test('Codex: legacy function_call + exec_command_end rollouts still parse with their outcome', () => {
  const entries = [
    { timestamp: new Date(now - 2000).toISOString(), type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ cmd: 'git push origin main', workdir: '/tmp/claudeville-no-repo' }) } },
    { timestamp: new Date(now - 1000).toISOString(), type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'c1', exit_code: 1, stderr: ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs' } },
  ];
  const [push] = codex.getGitEvents(null, { provider: 'codex', sessionId: 'legacy', project: '/tmp/claudeville-legacy' }, entries);
  assert.equal(push.type, 'push');
  assert.equal(push.success, false);
  assert.equal(push.status, 'rejected');
  assert.equal(push.cwd, '/tmp/claudeville-no-repo');
});

test('Claude: is_error results, chained commits and laundered rejections', (t) => {
  const { root, repo } = project(t);
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, materialize(path.join(FIXTURES, 'claude', 'git-outcomes.jsonl'), new Map([['__PROJECT__', repo]])));
  const events = claude.getGitEvents(transcript, { provider: 'claude', sessionId: 'claude-git', project: repo });
  const commits = events.filter((event) => event.type === 'commit');
  assert.deepEqual(commits.map((event) => event.label), ['Land the quay'], 'the hook-rejected commit yields no ship');
  assert.equal(commits[0].sha, '2b3c4d5');
  assert.equal(commits[0].success, true);
  assert.equal(commits[0].exitCode, 0);

  const pushes = events.filter((event) => event.type === 'push');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].status, 'rejected', '`|| true` does not launder the rejection');
  assert.equal(pushes[0].success, false);
  assert.match(pushes[0].reason, /rejected/);
  assert.equal(pushes[1].status, 'success');
  assert.equal(pushes[1].cwd, path.join(repo, 'pkg'), 'the transcript cwd is the command cwd');
  assert.equal(pushes[1].repoRoot, repo);
  for (const event of events) assert.ok((event.stderr || '').length <= 2048);
});

test('Claude project directories use the every-non-alphanumeric encoding', () => {
  assert.equal(claude.encodeClaudeProjectDir('/home/u/git/pharosville/.worktrees/harbour'), '-home-u-git-pharosville--worktrees-harbour');
  assert.equal(claude.encodeClaudeProjectDir('/home/u/my_repo.v2'), '-home-u-my-repo-v2');
});

test('Repo Watch: a linked worktree reads remotes from the common dir config', (t) => {
  const { root, repo } = project(t);
  git(repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git');
  const worktree = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree);
  assert.equal(registry.hasGitHubRemote(repo), true);
  assert.equal(registry.hasGitHubRemote(worktree), true);
});
