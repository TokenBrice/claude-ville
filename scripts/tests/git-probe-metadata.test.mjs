import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const { projectGitStateSignature } = require('../../claudeville/adapters/gitEvents.js');

function fixture(t) {
  const project = makeTempDir('claudeville-git-probe-');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const gitDir = path.join(project, '.git');
  fs.mkdirSync(gitDir);
  return { project, gitDir };
}

function put(gitDir, relative, content, seconds = 1_700_000_000) {
  const file = path.join(gitDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function part(file, label) {
  const stat = fs.statSync(file);
  return `${label}:${Math.round(stat.mtimeMs)}:${stat.size}`;
}

test('the shared probe preserves the sorted HEAD, refs, packed refs and reflog signature', (t) => {
  const { project, gitDir } = fixture(t);
  const names = ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs', 'logs/HEAD',
    'refs/heads/main', 'refs/remotes/origin/team/main',
    'logs/refs/heads/main', 'logs/refs/remotes/origin/team/main'];
  const expected = names.map((name) => part(put(gitDir, name, `${name}\n`), name)).sort().join('|');
  assert.equal(projectGitStateSignature(project), expected);
  assert.equal(projectGitStateSignature(project), expected);
});

test('warm snapshots detect a nested existing ref rewrite with unchanged directory metadata', (t) => {
  const { project, gitDir } = fixture(t);
  put(gitDir, 'HEAD', 'ref: refs/heads/main\n');
  const relative = 'refs/remotes/origin/team/main';
  const file = put(gitDir, relative, 'a'.repeat(40));
  const before = projectGitStateSignature(project);
  const directory = path.dirname(file);
  const directoryBefore = fs.statSync(directory);
  put(gitDir, relative, 'b'.repeat(40), 1_700_000_001);
  const directoryAfter = fs.statSync(directory);
  assert.equal(directoryBefore.mtimeMs, directoryAfter.mtimeMs);
  assert.equal(directoryBefore.ctimeMs, directoryAfter.ctimeMs);
  const after = projectGitStateSignature(project);
  assert.notEqual(after, before);
  assert.ok(after.split('|').includes(part(file, relative)));
});

test('warm snapshots detect nested additions, deletion and replaced ref directories', (t) => {
  const { project, gitDir } = fixture(t);
  const first = put(gitDir, 'refs/remotes/origin/team/first', 'a'.repeat(40));
  const before = projectGitStateSignature(project);
  const second = put(gitDir, 'refs/remotes/origin/team/second', 'b'.repeat(40));
  const added = projectGitStateSignature(project);
  assert.notEqual(added, before);
  assert.ok(added.split('|').includes(part(second, 'refs/remotes/origin/team/second')));
  fs.unlinkSync(first);
  const removed = projectGitStateSignature(project);
  assert.ok(!removed.includes('refs/remotes/origin/team/first:'));
  const directory = path.dirname(second);
  fs.renameSync(directory, `${directory}-old`);
  const replacement = put(gitDir, 'refs/remotes/origin/team/replacement', 'c'.repeat(40));
  const replaced = projectGitStateSignature(project);
  assert.ok(replaced.split('|').includes(part(replacement, 'refs/remotes/origin/team/replacement')));
  assert.ok(!replaced.includes('refs/remotes/origin/team/second:'));
});

test('oversized roots keep the alphabetical 800-entry server boundary', (t) => {
  const { project, gitDir } = fixture(t);
  for (let index = 804; index >= 0; index--) {
    put(gitDir, `refs/heads/branch-${String(index).padStart(4, '0')}`, `${index}\n`);
  }
  const signature = projectGitStateSignature(project);
  const expected = Array.from({ length: 800 }, (_, index) => {
    const name = `refs/heads/branch-${String(index).padStart(4, '0')}`;
    return part(path.join(gitDir, name), name);
  });
  expected.push('refs/heads:truncated');
  assert.equal(signature, expected.sort().join('|'));
  assert.equal(projectGitStateSignature(project), signature);
});

test('the depth bound excludes deeper refs without losing a file at depth eight', (t) => {
  const { project, gitDir } = fixture(t);
  const nested = `refs/remotes/${Array.from({ length: 8 }, (_, index) => `d${index}`).join('/')}`;
  const included = put(gitDir, `${nested}/main`, 'a'.repeat(40));
  put(gitDir, `${nested}/too-deep/main`, 'b'.repeat(40));
  assert.equal(projectGitStateSignature(project), part(included, `${nested}/main`));
});

test('worktree pointers retain checkout-local HEAD and the existing server signature scope', (t) => {
  const { project, gitDir } = fixture(t);
  fs.rmSync(gitDir, { recursive: true });
  const actualGitDir = path.join(project, 'metadata', 'worktrees', 'checkout');
  fs.mkdirSync(actualGitDir, { recursive: true });
  fs.writeFileSync(gitDir, 'gitdir: metadata/worktrees/checkout\n');
  const head = put(actualGitDir, 'HEAD', 'ref: refs/heads/topic\n');
  put(actualGitDir, 'commondir', '../..\n');
  put(path.join(project, 'metadata'), 'refs/remotes/origin/main', 'a'.repeat(40));
  assert.equal(projectGitStateSignature(project), part(head, 'HEAD'));
  put(actualGitDir, 'HEAD', 'b'.repeat(40), 1_700_000_002);
  assert.equal(projectGitStateSignature(project), part(head, 'HEAD'));
  fs.writeFileSync(gitDir, 'not a gitdir pointer\n');
  assert.equal(projectGitStateSignature(project), null);
});
