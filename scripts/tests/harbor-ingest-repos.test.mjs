import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildRepos,
  commitFile,
  git,
  gitOutput,
  isolateGitConfig,
  session,
} from './support/harbor-ingest.mjs';

isolateGitConfig(test);
const require = createRequire(import.meta.url);
const GIT_EVENTS = require.resolve('../../claudeville/adapters/gitEvents.js');

// Each scenario gets a fresh module so in-memory transition state never
// leaks between scenarios.
function freshGit() {
  delete require.cache[GIT_EVENTS];
  return require(GIT_EVENTS);
}

function enrich(g, sessions) {
  return g.inferPushedGitEventsForSessions(g.inferUnpushedGitEventsForSessions(sessions));
}

const byType = (events, type) => (events || []).filter((event) => event.type === type);

test('repo identity: main checkout, subdirectory and linked worktree share repoRoot; a submodule is its own repo', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const main = g.resolveRepoIdentity(repos.main);
  const sub = g.resolveRepoIdentity(repos.subdir);
  const wt = g.resolveRepoIdentity(repos.worktree);
  const submodule = g.resolveRepoIdentity(repos.submodule);
  assert.equal(main.repoRoot, repos.main);
  assert.equal(sub.repoRoot, repos.main);
  assert.equal(sub.checkout, repos.main);
  assert.equal(wt.repoRoot, repos.main);
  assert.equal(wt.checkout, repos.worktree);
  assert.deepEqual(wt.worktree, { name: 'wt-feature', path: repos.worktree, isMain: false });
  assert.deepEqual(main.worktree, { name: 'main', path: repos.main, isMain: true });
  assert.equal(submodule.repoRoot, repos.submodule);
  assert.equal(submodule.checkout, repos.submodule);
  assert.equal(g.resolveRepoIdentity(repos.root), null);
  // Trailing slashes and dot segments normalize to the same identity.
  assert.equal(g.resolveRepoIdentity(`${repos.main}/`).repoRoot, repos.main);
  assert.equal(g.resolveRepoIdentity(path.join(repos.other, '..', 'main', 'pkg')).repoRoot, repos.main);
});

test('subdirectory sessions get a git-state signature and the same commit ids as the root', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  assert.ok(g.projectGitStateSignature(repos.subdir));
  const sha = commitFile(repos.main, 'pkg/app/b.txt', 'subdir work');
  const [root, sub] = enrich(g, [session(repos.main, [], 'root'), session(repos.subdir, [], 'sub')]);
  const rootCommit = byType(root.gitEvents, 'commit').find((event) => event.sha === sha);
  const subCommit = byType(sub.gitEvents, 'commit').find((event) => event.sha === sha);
  assert.ok(rootCommit && subCommit);
  assert.equal(rootCommit.id, subCommit.id);
  assert.equal(rootCommit.repoRoot, repos.main);
  assert.equal(rootCommit.attribution, 'scanned');
  assert.equal(root.repoRoot, repos.main);
  assert.equal(sub.repoRoot, repos.main);

  git(repos.main, 'push', '-q');
  const [rootAfter, subAfter] = enrich(g, [session(repos.main, [], 'root'), session(repos.subdir, [], 'sub')]);
  for (const after of [rootAfter, subAfter]) {
    assert.equal(byType(after.gitEvents, 'commit').length, 0);
    const [push] = byType(after.gitEvents, 'push');
    assert.ok(push, 'a transition push reaches both sessions');
    assert.deepEqual(push.landedShas, [sha]);
    assert.equal(push.synthetic, 'transition');
    assert.equal(push.repoRoot, repos.main);
  }
});

test('worktree commits: one ship per sha across checkouts; local merge then push lands them', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const sha = commitFile(repos.worktree, 'w.txt', 'feature work');
  const [mainSession, wtSession] = enrich(g, [session(repos.main, [], 'main'), session(repos.worktree, [], 'wt')]);
  const mainCommit = byType(mainSession.gitEvents, 'commit').find((event) => event.sha === sha);
  const wtCommit = byType(wtSession.gitEvents, 'commit').find((event) => event.sha === sha);
  assert.ok(mainCommit, 'the main checkout sees the worktree branch cargo');
  assert.equal(mainCommit.id, wtCommit.id);
  assert.equal(mainCommit.branch, 'feature');
  assert.equal(wtSession.worktree.isMain, false);

  git(repos.main, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  enrich(g, [session(repos.main, [], 'main'), session(repos.worktree, [], 'wt')]);
  git(repos.main, 'push', '-q');
  const [mainAfter, wtAfter] = enrich(g, [session(repos.main, [], 'main'), session(repos.worktree, [], 'wt')]);
  const landed = new Set(byType(mainAfter.gitEvents, 'push').flatMap((push) => push.landedShas || []));
  assert.ok(landed.has(sha), 'feature commit landed through main');
  assert.equal(byType(wtAfter.gitEvents, 'commit').filter((event) => event.sha === sha).length, 0);
});

test('a topic branch stays docked after switching to an up-to-date main; no fake push', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'topic');
  const sha = commitFile(repos.main, 'topic.txt', 'topic work');
  const observed = g.parseGitEventsFromCommand('git commit -m "topic work"', {
    provider: 'claude', sessionId: 'topic', sourceId: 'c1', ts: Date.now(), project: repos.main,
    success: true, exitCode: 0, output: `[topic ${sha.slice(0, 7)}] topic work\n`,
  });
  git(repos.main, 'switch', '-q', 'main');
  const [after] = enrich(g, [session(repos.main, observed, 'topic')]);
  assert.deepEqual(byType(after.gitEvents, 'push'), []);
  const commits = byType(after.gitEvents, 'commit');
  assert.equal(commits.length, 1, 'observed and scanned commit merge into one');
  assert.equal(commits[0].sha, sha);
  assert.equal(commits[0].branch, 'topic');
  assert.equal(commits[0].attribution, 'observed');
});

test('a hook-rejected commit produces neither a ship nor a push (Claude is_error)', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const observed = g.parseGitEventsFromCommand('git commit -m "will be rejected"', {
    provider: 'claude', sessionId: 'hook', sourceId: 'c1', ts: Date.now(), project: repos.main,
    success: false, output: 'Exit code 1\npre-commit hook failed: lint errors\n',
  });
  assert.deepEqual(observed, []);
  const [after] = enrich(g, [session(repos.main, observed, 'hook')]);
  assert.deepEqual(after.gitEvents, []);
});

test('reset --hard origin/main discards a commit as rewritten, never as a push', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const sha = commitFile(repos.main, 'drop.txt', 'jettison');
  const [before] = enrich(g, [session(repos.main)]);
  assert.equal(byType(before.gitEvents, 'commit').length, 1);
  git(repos.main, 'reset', '-q', '--hard', 'origin/main');
  const [after] = enrich(g, [session(repos.main)]);
  assert.deepEqual(byType(after.gitEvents, 'push'), []);
  assert.deepEqual(byType(after.gitEvents, 'commit'), []);
  const [rewritten] = byType(after.gitEvents, 'rewritten');
  assert.ok(rewritten, 'the dropped commit is reported as rewritten');
  assert.deepEqual(rewritten.oldShas, [sha]);
  assert.equal(rewritten.branch, 'main');
  assert.equal(rewritten.repoRoot, repos.main);
});

test('amend links the old sha to its replacement', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const original = commitFile(repos.main, 'amend.txt', 'amend me');
  enrich(g, [session(repos.main)]);
  fs.writeFileSync(path.join(repos.main, 'amend.txt'), 'amended\n');
  git(repos.main, 'commit', '-q', '-a', '--amend', '--no-edit');
  const amended = git(repos.main, 'rev-parse', 'HEAD');
  assert.notEqual(original, amended);
  const [after] = enrich(g, [session(repos.main)]);
  const [rewritten] = byType(after.gitEvents, 'rewritten');
  assert.ok(rewritten);
  assert.deepEqual(rewritten.oldShas, [original]);
  assert.deepEqual(rewritten.replacements, [{ oldSha: original, newSha: amended }]);
  assert.deepEqual(byType(after.gitEvents, 'commit').map((event) => event.sha), [amended]);
});

test('cd into a submodule attributes the commit to the submodule repo', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const sha = commitFile(repos.submodule, 'z.txt', 'submodule change');
  const [observed] = g.parseGitEventsFromCommand('cd vendor/sub && git commit -m "submodule change"', {
    provider: 'claude', sessionId: 's', sourceId: 'c1', ts: Date.now(), project: repos.main,
    success: true, exitCode: 0, output: `[main ${sha.slice(0, 7)}] submodule change\n`,
  });
  assert.equal(observed.repoRoot, repos.submodule);
  assert.equal(observed.cwd, repos.submodule);
  assert.equal(observed.project, repos.main);
  const [after] = enrich(g, [session(repos.main, [observed])]);
  assert.deepEqual(byType(after.gitEvents, 'push'), [], 'no fake superproject push');
});

test('git push -u origin HEAD on a feature branch freezes that branch', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'feat-b');
  commitFile(repos.main, 'b.txt', 'feat b');
  const result = gitOutput(repos.main, 'push', '-u', 'origin', 'HEAD');
  const context = {
    provider: 'claude', sessionId: 's', sourceId: 'p1', ts: Date.now(), project: repos.main,
    success: result.exitCode === 0, exitCode: result.exitCode, output: result.output,
  };
  const [push] = g.parseGitEventsFromCommand('git push -u origin HEAD', context);
  assert.equal(push.branch, 'feat-b');
  assert.equal(push.status, 'success');
  git(repos.main, 'switch', '-q', 'main');
  const [again] = g.parseGitEventsFromCommand('git push -u origin HEAD', context);
  assert.equal(again.branch, 'feat-b');
});

test('a rejected push is classified from its own output', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'm.txt', 'main first');
  git(repos.main, 'push', '-q');
  commitFile(repos.other, 'o.txt', 'other work');
  const result = gitOutput(repos.other, 'push', 'origin', 'main');
  assert.notEqual(result.exitCode, 0);
  const [push] = g.parseGitEventsFromCommand('git push origin main', {
    provider: 'claude', sessionId: 'o', sourceId: 'p1', ts: Date.now(), project: repos.other,
    success: false, exitCode: result.exitCode, output: result.output,
  });
  assert.equal(push.status, 'rejected');
  assert.equal(push.success, false);
  assert.equal(push.refs[0].status, 'rejected');
  const [after] = enrich(g, [session(repos.other, [push], 'o')]);
  assert.equal(byType(after.gitEvents, 'push').filter((event) => event.success !== false).length, 0);
});

test('scanned commits carry author, co-authors and scanned attribution', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  fs.writeFileSync(path.join(repos.main, 'co.txt'), 'co\n');
  git(repos.main, 'add', 'co.txt');
  git(repos.main, 'commit', '-q', '-m', 'pair work', '-m', 'Co-Authored-By: Claude Opus <noreply@example.com>\nCo-authored-by: Ada <ada@example.com>');
  const [after] = enrich(g, [session(repos.main)]);
  const [commit] = byType(after.gitEvents, 'commit');
  assert.deepEqual(commit.author, { name: 'Fixture Author', email: 'author@claudeville.local' });
  assert.deepEqual(commit.coAuthors, ['Claude Opus', 'Ada']);
  assert.equal(commit.attribution, 'scanned');
  assert.equal(commit.label, 'pair work');
});

test('unpushed commits on every local branch are scanned, not only the current one', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'side');
  const sideSha = commitFile(repos.main, 'side.txt', 'side work');
  git(repos.main, 'switch', '-q', 'main');
  const mainSha = commitFile(repos.main, 'main.txt', 'main work');
  const [after] = enrich(g, [session(repos.main)]);
  const commits = byType(after.gitEvents, 'commit');
  assert.deepEqual(new Set(commits.map((event) => `${event.branch}:${event.sha}`)), new Set([`side:${sideSha}`, `main:${mainSha}`]));
});

test('an observed successful push gets verified landedShas', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const sha = commitFile(repos.main, 'p.txt', 'ship it');
  enrich(g, [session(repos.main)]);
  const result = gitOutput(repos.main, 'push', 'origin', 'main');
  assert.equal(result.exitCode, 0);
  const observed = g.parseGitEventsFromCommand('git push origin main', {
    provider: 'claude', sessionId: 's', sourceId: 'p1', ts: Date.now(), project: repos.main,
    success: true, exitCode: 0, output: result.output,
  });
  const [after] = enrich(g, [session(repos.main, observed)]);
  const observedPush = byType(after.gitEvents, 'push').find((event) => event.observed);
  assert.ok(observedPush);
  assert.deepEqual(observedPush.landedShas, [sha]);
  assert.equal(observedPush.refs[0].status, 'ok');
});

test('push transitions are durable across a restart via remote reflogs', (t) => {
  const repos = buildRepos(t);
  let g = freshGit();
  const sha = commitFile(repos.main, 'r.txt', 'before restart');
  enrich(g, [session(repos.main)]);
  const pushedAt = Date.now();
  git(repos.main, 'push', '-q');
  g = freshGit();
  const [after] = enrich(g, [session(repos.main)]);
  const [push] = byType(after.gitEvents, 'push');
  assert.ok(push, 'a push within the window is replayed after a restart');
  assert.ok(push.landedShas.includes(sha));
  assert.ok(Math.abs(push.ts - pushedAt) < 5000, 'the departure uses the real push time');
});

test('warm polls launch no git subprocesses', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'perf.txt', 'perf');
  commitFile(repos.worktree, 'perf-wt.txt', 'perf wt');
  const sessions = [session(repos.main, [], 'a'), session(repos.subdir, [], 'b'), session(repos.worktree, [], 'c')];
  enrich(g, sessions);
  const warmStart = g.getGitEnrichmentPerfStats().gitCommandCount;
  for (let index = 0; index < 10; index++) enrich(g, sessions);
  assert.equal(g.getGitEnrichmentPerfStats().gitCommandCount - warmStart, 0);
  const before = g.getGitEnrichmentPerfStats().gitCommandCount;
  git(repos.main, 'push', '-q');
  enrich(g, sessions);
  const cost = g.getGitEnrichmentPerfStats().gitCommandCount - before;
  assert.ok(cost > 0 && cost <= 8, `a push costs a bounded refresh (${cost} commands)`);
});

test('worker path normalizes trailing slashes and dot segments without a refresh loop', async (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'x.txt', 'worker commit');
  g.configureGitEnrichmentWorker({ enabled: true });
  t.after(() => g.shutdownGitEnrichmentWorker());
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const project of [repos.main, `${repos.main}/`, `${repos.other}/../main`]) {
    const sessions = [{ sessionId: `w-${project}`, provider: 'codex', project, gitEvents: [] }];
    g.inferUnpushedGitEventsForSessions(sessions);
    for (let attempt = 0; attempt < 40 && g.getGitWorkerPerfStats().activeJobs + g.getGitWorkerPerfStats().queueDepth > 0; attempt++) {
      await wait(50);
    }
    await wait(50);
    const [result] = g.inferUnpushedGitEventsForSessions(sessions);
    assert.deepEqual(byType(result.gitEvents, 'commit').map((event) => event.label), ['worker commit'], project);
    const before = g.getGitEnrichmentPerfStats().gitCommandCount;
    for (let index = 0; index < 5; index++) g.inferUnpushedGitEventsForSessions(sessions);
    await wait(100);
    assert.equal(g.getGitEnrichmentPerfStats().gitCommandCount - before, 0, `no refresh loop for ${project}`);
  }
  const [push] = g.parseGitEventsFromCommand('git push', {
    provider: 'codex', sessionId: 'x', sourceId: 'y', ts: 1, project: repos.other,
  });
  assert.equal(push.branch, 'main', 'the branch never defers to a cold worker cache');
});
