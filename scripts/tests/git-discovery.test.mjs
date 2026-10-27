// Repository discovery matches git's (RG-6). An empty `.git` directory, like a
// stray one above a temp root, is not a repository; a `.git` file that does not
// point at a git dir ends the search instead of signing the parent repository.
// Checked against the git CLI itself, with no GIT_CEILING_DIRECTORIES.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

// The proof must not lean on the workaround it retires.
delete process.env.GIT_CEILING_DIRECTORIES;
const require = createRequire(import.meta.url);
const { resolveRepoIdentity, projectGitStateSignature } = require('../../claudeville/adapters/gitEvents.js');

// The git CLI with no inherited GIT_* state or user config.
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return spawnSync('git', args, {
    cwd,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
}

function gitTopLevel(cwd) {
  const result = git(cwd, 'rev-parse', '--show-toplevel');
  return result.status === 0 ? result.stdout.trim() : null;
}

function outerRepository(t) {
  const root = fs.realpathSync(makeTempDir('claudeville-git-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outer = path.join(root, 'outer');
  fs.mkdirSync(outer);
  assert.equal(git(outer, 'init', '-q').status, 0);
  return { root, outer };
}

test('an empty .git directory is not a repository: discovery walks past it, as git does', (t) => {
  const { outer } = outerRepository(t);
  const stray = path.join(outer, 'stray');
  fs.mkdirSync(path.join(stray, '.git'), { recursive: true });
  const nested = path.join(stray, 'pkg');
  fs.mkdirSync(nested);
  for (const dir of [stray, nested]) {
    assert.equal(gitTopLevel(dir), outer, `git finds the outer repository from ${dir}`);
    assert.equal(resolveRepoIdentity(dir)?.checkout, outer, `discovery finds the outer repository from ${dir}`);
  }
});

test('a broken gitfile ends the search instead of signing the parent repository', (t) => {
  const { root, outer } = outerRepository(t);
  const gitfiles = {
    invalid: 'not a gitdir pointer\n',
    dangling: `gitdir: ${path.join(root, 'missing')}\n`,
  };
  for (const [name, content] of Object.entries(gitfiles)) {
    const dir = path.join(outer, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), content);
    assert.equal(gitTopLevel(dir), null, `git stops at the ${name} gitfile`);
    assert.equal(resolveRepoIdentity(dir), null, `discovery stops at the ${name} gitfile`);
    assert.equal(projectGitStateSignature(dir), null, `the ${name} gitfile signs nothing`);
  }
});
