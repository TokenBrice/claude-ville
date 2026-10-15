// Shared real-repository fixture for the harbor ingestion tests: a bare
// remote, a main clone with a `pkg/app` subdirectory, a submodule, a linked
// worktree on `feature`, and a second clone for rejected pushes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeTempDir } from './tmp.mjs';

// The operator's git config (signing, hooks, push.autoSetupRemote) must not
// change what these fixtures commit or push.
export function isolateGitConfig(test) {
  const configRoot = makeTempDir('claudeville-harbor-ingest-config-');
  const emptyConfig = path.join(configRoot, 'gitconfig');
  fs.writeFileSync(emptyConfig, '[protocol "file"]\n\tallow = always\n');
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Fixture Author';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'author@claudeville.local';
  delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  test.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Runs a git command that may fail and returns its combined output, like an
// agent's shell tool would capture it.
export function gitOutput(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { exitCode: result.status ?? 1, output: `${result.stdout || ''}${result.stderr || ''}` };
}

export function buildRepos(t) {
  const root = fs.realpathSync(makeTempDir('claudeville-harbor-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The temp root may itself sit inside a repository: never search above it.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  const remote = path.join(root, 'remote.git');
  const subRemote = path.join(root, 'subremote.git');
  const seed = path.join(root, 'subseed');
  const main = path.join(root, 'main');
  const other = path.join(root, 'other');
  const worktree = path.join(root, 'wt-feature');
  // Setup commits and pushes are dated an hour back, so their remote reflog
  // entries sit outside the replay window of a freshly loaded module.
  process.env.GIT_COMMITTER_DATE = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '--bare', '-b', 'main', subRemote);
  git(root, 'clone', '-q', subRemote, seed);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'sub init');
  git(seed, 'push', '-q', 'origin', 'main');

  git(root, 'clone', '-q', remote, main);
  fs.mkdirSync(path.join(main, 'pkg', 'app'), { recursive: true });
  fs.writeFileSync(path.join(main, 'pkg', 'app', 'a.txt'), 'a\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  git(main, 'submodule', '-q', 'add', subRemote, 'vendor/sub');
  git(main, 'commit', '-q', '-m', 'add submodule');
  git(main, 'push', '-q');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  git(root, 'clone', '-q', remote, other);
  delete process.env.GIT_COMMITTER_DATE;

  return {
    root,
    remote,
    main,
    other,
    worktree,
    subdir: path.join(main, 'pkg', 'app'),
    submodule: path.join(main, 'vendor', 'sub'),
  };
}

export function commitFile(cwd, name, message) {
  fs.writeFileSync(path.join(cwd, name), `${message}\n`);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

export function session(project, gitEvents = [], sessionId = `s-${path.basename(project)}`) {
  return { sessionId, provider: 'claude', project, gitEvents };
}
