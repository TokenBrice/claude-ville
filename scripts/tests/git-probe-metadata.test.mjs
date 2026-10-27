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
  // Like git, discovery takes a `.git` directory only when it holds HEAD.
  const head = put(gitDir, 'HEAD', 'ref: refs/heads/main\n');
  return { project, gitDir, head };
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
  const { project, gitDir, head } = fixture(t);
  for (let index = 804; index >= 0; index--) {
    put(gitDir, `refs/heads/branch-${String(index).padStart(4, '0')}`, `${index}\n`);
  }
  const signature = projectGitStateSignature(project);
  const expected = Array.from({ length: 800 }, (_, index) => {
    const name = `refs/heads/branch-${String(index).padStart(4, '0')}`;
    return part(path.join(gitDir, name), name);
  });
  expected.push('refs/heads:truncated', part(head, 'HEAD'));
  assert.equal(signature, expected.sort().join('|'));
  assert.equal(projectGitStateSignature(project), signature);
});

test('the depth bound excludes deeper refs without losing a file at depth eight', (t) => {
  const { project, gitDir, head } = fixture(t);
  const nested = `refs/remotes/${Array.from({ length: 8 }, (_, index) => `d${index}`).join('/')}`;
  const included = put(gitDir, `${nested}/main`, 'a'.repeat(40));
  put(gitDir, `${nested}/too-deep/main`, 'b'.repeat(40));
  assert.equal(projectGitStateSignature(project), [part(head, 'HEAD'), part(included, `${nested}/main`)].sort().join('|'));
});

test('worktree pointers sign checkout-local HEAD and the shared refs a push from the worktree moves', (t) => {
  const { project, gitDir } = fixture(t);
  fs.rmSync(gitDir, { recursive: true });
  const actualGitDir = path.join(project, 'metadata', 'worktrees', 'checkout');
  fs.mkdirSync(actualGitDir, { recursive: true });
  fs.writeFileSync(gitDir, 'gitdir: metadata/worktrees/checkout\n');
  const head = put(actualGitDir, 'HEAD', 'ref: refs/heads/topic\n');
  put(actualGitDir, 'commondir', '../..\n');
  const commonDir = path.join(project, 'metadata');
  const remoteRef = put(commonDir, 'refs/remotes/origin/main', 'a'.repeat(40));
  const signed = () => [part(head, 'HEAD'), part(remoteRef, 'common/refs/remotes/origin/main')].sort().join('|');
  assert.equal(projectGitStateSignature(project), signed());
  put(actualGitDir, 'HEAD', 'b'.repeat(40), 1_700_000_002);
  assert.equal(projectGitStateSignature(project), signed());
  const beforePush = projectGitStateSignature(project);
  put(commonDir, 'refs/remotes/origin/main', 'c'.repeat(40), 1_700_000_003);
  assert.notEqual(projectGitStateSignature(project), beforePush);
  assert.equal(projectGitStateSignature(project), signed());
  fs.writeFileSync(gitDir, 'not a gitdir pointer\n');
  assert.equal(projectGitStateSignature(project), null);
});

// SV-9 — the enrichment path reuses a repository's leaf signature while its
// ref directories, HEAD, packed-refs and worktree HEADs are unchanged.
const { _test: { repoStateSignature }, resolveRepoIdentity } = require('../../claudeville/adapters/gitEvents.js');

test('SV-9: a repository signature is reused until git moves a ref, and re-signed within its TTL', (t) => {
  const { project, gitDir } = fixture(t);
  put(gitDir, 'refs/heads/main', 'a'.repeat(40));
  put(gitDir, 'refs/remotes/origin/main', 'a'.repeat(40));
  const identity = resolveRepoIdentity(project);
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const leafStats = (fn) => {
    const original = fs.statSync;
    let count = 0;
    fs.statSync = (target, ...rest) => {
      if (String(target).includes(`${path.sep}refs${path.sep}`) && !fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) count++;
      return original(target, ...rest);
    };
    try { return { value: fn(), count }; } finally { fs.statSync = original; }
  };

  const first = repoStateSignature(identity);
  const warm = leafStats(() => repoStateSignature(identity));
  assert.equal(warm.value, first);
  assert.equal(warm.count, 0, 'an unchanged repository signs no loose ref');

  // Git moves a ref by renaming a lock file over it: the directory changes.
  const ref = path.join(gitDir, 'refs/remotes/origin/main');
  fs.writeFileSync(`${ref}.lock`, 'b'.repeat(40));
  fs.renameSync(`${ref}.lock`, ref);
  const moved = repoStateSignature(identity);
  assert.notEqual(moved, first, 'a pushed remote-tracking ref is seen at once');

  // A rewrite in place keeps its directory; it is re-signed within the TTL.
  put(gitDir, 'refs/heads/main', 'c'.repeat(40), 1_700_000_005);
  assert.equal(repoStateSignature(identity), moved);
  now += 5_000;
  assert.notEqual(repoStateSignature(identity), moved, 'an in-place rewrite is re-signed after 5 s');
});
