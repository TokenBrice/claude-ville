import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// The operator's git config (push.autoSetupRemote, signing, hooks paths)
// must not change what these fixtures push or how they commit.
const configRoot = makeTempDir('claudeville-push-transition-config-');
const emptyConfig = path.join(configRoot, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'ClaudeVille Fixture';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'fixture@claudeville.local';
delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
test.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { inferUnpushedGitEventsForSessions } = require('../../claudeville/adapters/gitEvents.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t, { remote = true } = {}) {
  const root = fs.realpathSync(makeTempDir('claudeville-push-transition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  if (remote) {
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, repo);
  } else {
    git(root, 'init', '-q', '-b', 'main', repo);
  }
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  if (remote) {
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
  }
  return { root, repo };
}

// A branch checked out in a linked worktree, created from local HEAD: git
// configures no upstream for it.
function worktree(repo, branch) {
  const checkout = path.join(repo, '.worktrees', branch.replace(/\W+/g, '-'));
  git(repo, 'worktree', 'add', '-q', '-b', branch, checkout);
  return checkout;
}

function observe(project) {
  const [session] = inferUnpushedGitEventsForSessions([{ sessionId: `fixture-${project}`, project, gitEvents: [] }]);
  const events = session?.gitEvents || [];
  return {
    commits: events.filter((event) => event.type === 'commit').map((event) => `${event.branch}:${event.label}`),
    pushes: events.filter((event) => event.type === 'push').map((event) => ({
      branch: event.branch,
      targetRef: event.targetRef,
      source: event.source,
    })),
  };
}

test('a push without -u from an upstream-less worktree branch sails its commits', (t) => {
  const { repo } = fixture(t);
  const checkout = worktree(repo, 'feat/harbor');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'Raise the harbor');
  assert.deepEqual(observe(checkout), { commits: ['feat/harbor:Raise the harbor'], pushes: [] });

  git(checkout, 'push', '-q', 'origin', 'feat/harbor');
  assert.deepEqual(observe(checkout), {
    commits: [],
    pushes: [{ branch: 'feat/harbor', targetRef: 'origin/feat/harbor', source: 'git-upstream-transition' }],
  });
});

test('a worktree branch pushed straight to main sails its commits', (t) => {
  const { repo } = fixture(t);
  const checkout = worktree(repo, 'feat/quay');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'Lay the quay');
  assert.deepEqual(observe(checkout).commits, ['feat/quay:Lay the quay']);

  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  git(checkout, 'fetch', '-q', 'origin');
  const after = observe(checkout);
  assert.deepEqual(after.commits, []);
  assert.deepEqual(after.pushes.map((push) => push.branch), ['feat/quay']);
});

test('commits pushed through a release branch sail after HEAD has moved to it', (t) => {
  const { repo } = fixture(t);
  git(repo, 'switch', '-q', '-c', 'feat/visual');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Paint the sails');
  assert.deepEqual(observe(repo).commits, ['feat/visual:Paint the sails']);

  git(repo, 'switch', '-q', '-c', 'release/v1', 'origin/main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge visual', 'feat/visual');
  git(repo, 'push', '-q', '-u', 'origin', 'release/v1');
  assert.deepEqual(observe(repo).pushes, [
    { branch: 'feat/visual', targetRef: 'origin/release/v1', source: 'git-upstream-transition' },
  ]);
});

test('commits that left the list without reaching a remote stay unsailed until pushed', (t) => {
  const { repo } = fixture(t);
  git(repo, 'switch', '-q', '-c', 'feat/hold');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Stow the cargo');
  assert.deepEqual(observe(repo).commits, ['feat/hold:Stow the cargo']);

  git(repo, 'switch', '-q', 'main');
  assert.deepEqual(observe(repo), { commits: [], pushes: [] });

  git(repo, 'push', '-q', 'origin', 'feat/hold');
  assert.deepEqual(observe(repo).pushes.map((push) => push.branch), ['feat/hold']);
});

test('resetting an upstream-less branch to its remote base without pushing is not a push', (t) => {
  const { repo } = fixture(t);
  git(repo, 'switch', '-q', '-c', 'feat/drop');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Jettison the cargo');
  assert.deepEqual(observe(repo).commits, ['feat/drop:Jettison the cargo']);

  git(repo, 'reset', '-q', '--hard', 'origin/main');
  assert.deepEqual(observe(repo), { commits: [], pushes: [] });
});

test('merging into a local main with no remote is not a push', (t) => {
  const { repo } = fixture(t, { remote: false });
  git(repo, 'switch', '-q', '-c', 'feat/local');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Keep it ashore');
  assert.deepEqual(observe(repo).commits, ['feat/local:Keep it ashore']);

  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'feat/local');
  git(repo, 'switch', '-q', 'feat/local');
  assert.deepEqual(observe(repo), { commits: [], pushes: [] });
});
