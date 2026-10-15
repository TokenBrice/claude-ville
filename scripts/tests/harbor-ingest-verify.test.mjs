// Regression tests for the independent verification of Track A
// (P1-2/3/5/6, P2-7..10, Codex completion cwd, --git-dir, in-chain branch
// switches and observed commits rewritten before any scan).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { makeTempDir } from './support/tmp.mjs';
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
const { _test: codex } = require('../../claudeville/adapters/codex.js');

function freshGit() {
  delete require.cache[GIT_EVENTS];
  return require(GIT_EVENTS);
}

function execGit(cwd, env, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const enrich = (g, sessions) => g.inferPushedGitEventsForSessions(g.inferUnpushedGitEventsForSessions(sessions));
const byType = (events, type) => (events || []).filter((event) => event.type === type);
const ctx = (project, sourceId, extra = {}) => ({ provider: 'claude', sessionId: 's', sourceId, ts: Date.now(), project, ...extra });

test('P1-2: one push\'s success output cannot launder another push\'s rejection', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'a.txt', 'main work');
  commitFile(repos.other, 'b.txt', 'other work');
  const first = gitOutput(repos.main, 'push', 'origin', 'main');
  const second = gitOutput(repos.other, 'push', 'origin', 'main');
  assert.equal(first.exitCode, 0);
  assert.notEqual(second.exitCode, 0);
  const events = g.parseGitEventsFromCommand(`git -C ${repos.main} push origin main && git -C ${repos.other} push origin main`,
    ctx(repos.root, 'p', { success: false, exitCode: second.exitCode, output: first.output + second.output }));
  assert.deepEqual(events.map((event) => [event.cwd, event.status]), [
    [repos.main, 'success'],
    [repos.other, 'rejected'],
  ]);
  assert.notEqual(events[0].refs[0].sha, events[1].refs[0].sha);
});

test('P1-3: a mixed branch/tag push keeps the tag namespace on its ref', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const [push] = g.parseGitEventsFromCommand('git push origin main refs/tags/feature', ctx(repos.main, 'p'));
  assert.equal(push.branch, 'main');
  assert.equal(push.tagsOnly, undefined);
  assert.deepEqual(push.refs.map(({ src, dst, tag }) => ({ src, dst, tag })), [
    { src: 'main', dst: 'main', tag: undefined },
    { src: 'refs/tags/feature', dst: 'refs/tags/feature', tag: true },
  ]);
  git(repos.main, 'tag', 'v3');
  const [tagPush] = g.parseGitEventsFromCommand('git push origin v3', ctx(repos.main, 'p2'));
  assert.equal(tagPush.tag, 'v3');
  assert.deepEqual(tagPush.refs.map(({ src, tag }) => [src, tag]), [['refs/tags/v3', true]]);
});

test('P1-5: truncated rev-list output never proves remote containment', () => {
  const g = freshGit();
  const state = { hasRemotes: true, containment: new Map() };
  const newest = 'a'.repeat(40);
  const oldest = 'b'.repeat(40);
  const steps = g._test.containmentSteps(state, [newest, oldest], Date.now());
  let step = steps.next();
  const truncated = [newest, ...Array.from({ length: 4999 }, (_, index) => index.toString(16).padStart(40, 'c'))].join('\n');
  const replies = [`${newest}\n${oldest}`, truncated, ''];
  while (!step.done) step = steps.next(replies.shift() ?? '');
  assert.equal(state.containment.get(newest).contained, false);
  assert.equal(state.containment.get(oldest).contained, false, 'absence from a capped listing is not containment');
});

test('P1-6: a vanished batch is partitioned into landed and rewritten commits', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const a = commitFile(repos.main, 'a.txt', 'first');
  const b = commitFile(repos.main, 'b.txt', 'second');
  const c = commitFile(repos.main, 'c.txt', 'third');
  enrich(g, [session(repos.main)]);
  git(repos.main, 'push', '-q', 'origin', `${b}:main`);
  fs.writeFileSync(path.join(repos.main, 'c.txt'), 'third amended\n');
  git(repos.main, 'commit', '-q', '-a', '--amend', '--no-edit');
  const d = git(repos.main, 'rev-parse', 'HEAD');
  const [after] = enrich(g, [session(repos.main)]);
  const landed = byType(after.gitEvents, 'push').flatMap((push) => push.landedShas || []);
  assert.deepEqual(new Set(landed), new Set([a, b]));
  const [rewritten] = byType(after.gitEvents, 'rewritten');
  assert.deepEqual(rewritten.oldShas, [c]);
  assert.deepEqual(rewritten.replacements, [{ oldSha: c, newSha: d }]);
});

test('P2-7: a branch\'s first push is replayed after a restart', (t) => {
  const repos = buildRepos(t);
  let g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'feat-new');
  const sha = commitFile(repos.main, 'n.txt', 'new branch work');
  enrich(g, [session(repos.main)]);
  git(repos.main, 'push', '-q', '-u', 'origin', 'feat-new');
  g = freshGit();
  const [after] = enrich(g, [session(repos.main)]);
  const push = byType(after.gitEvents, 'push').find((event) => event.landedShas?.includes(sha));
  assert.ok(push, 'the creation push lands its commits');
  assert.equal(push.branch, 'feat-new');
});

test('P2-8: detached HEAD cargo is scanned', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'checkout', '-q', '--detach');
  const sha = commitFile(repos.main, 'd.txt', 'detached work');
  const [after] = enrich(g, [session(repos.main)]);
  const [commit] = byType(after.gitEvents, 'commit');
  assert.equal(commit?.sha, sha);
  assert.equal(commit.detached, true);
  assert.equal(commit.branch, null);
});

test('P2-9: separate git dirs, bare repositories and symlinked subdirectories resolve', (t) => {
  const root = fs.realpathSync(makeTempDir('claudeville-harbor-layouts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const g = freshGit();
  const storage = path.join(root, 'storage');
  const main = path.join(root, 'main');
  git(root, 'init', '-q', `--separate-git-dir=${storage}`, main);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  const linked = path.join(root, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked);
  const mainId = g.resolveRepoIdentity(main);
  const linkedId = g.resolveRepoIdentity(linked);
  assert.equal(mainId.repoRoot, linkedId.repoRoot, 'one repository across a separate git dir and its worktree');
  assert.equal(mainId.worktree.isMain, true);
  assert.equal(linkedId.worktree.isMain, false);

  const bare = path.join(root, 'bare.git');
  git(root, 'init', '-q', '--bare', bare);
  assert.equal(g.resolveRepoIdentity(bare)?.repoRoot, bare);

  fs.mkdirSync(path.join(main, 'pkg'));
  const link = path.join(root, 'alias');
  fs.symlinkSync(path.join(main, 'pkg'), link);
  assert.equal(g.resolveRepoIdentity(link)?.repoRoot, mainId.repoRoot);
});

test('P2-10: a repository initialized after a miss is found', (t) => {
  const root = fs.realpathSync(makeTempDir('claudeville-harbor-late-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The temp root may itself sit inside a repository.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => { delete process.env.GIT_CEILING_DIRECTORIES; });
  const g = freshGit();
  assert.equal(g.resolveRepoIdentity(root), null);
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(g.resolveRepoIdentity(root)?.repoRoot, root);
});

test('Codex paired completion cwd and --git-dir set the event cwd', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const [viaGitDir] = g.parseGitEventsFromCommand(`git --git-dir=${repos.other}/.git push origin main`, ctx(repos.main, 'gd'));
  assert.equal(viaGitDir.cwd, repos.other);
  assert.equal(viaGitDir.repoRoot, repos.other);
  const now = Date.now();
  const entries = [
    { timestamp: new Date(now - 2000).toISOString(), type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ cmd: 'git push origin main' }) } },
    { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'item_completed', started_at_ms: now - 1000, completed_at_ms: now, item: { type: 'CommandExecution', id: 'i1', call_id: 'c1', command: 'git push origin main', cwd: `file://${repos.other}`, exit_code: 0, status: 'completed' } } },
  ];
  const [push] = codex.getGitEvents(null, { provider: 'codex', sessionId: 'c', project: repos.main }, entries);
  assert.equal(push.cwd, repos.other);
  assert.equal(push.repoRoot, repos.other);
});

test('a branch switched to inside the chain owns the quiet commit', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'branch', 'feature-x');
  const run = gitOutput(repos.main, 'switch', 'feature-x');
  assert.equal(run.exitCode, 0);
  commitFile(repos.main, 'q.txt', 'quiet');
  git(repos.main, 'switch', '-q', 'main');
  const [commit] = g.parseGitEventsFromCommand('git switch feature-x && git commit -q -m quiet && git switch main',
    ctx(repos.main, 'sw', { success: true, exitCode: 0, output: "Switched to branch 'feature-x'\nSwitched to branch 'main'\n" }));
  assert.equal(commit.branch, 'feature-x');
  const [created] = g.parseGitEventsFromCommand('git checkout -b fresh && git commit -q -m fresh',
    ctx(repos.main, 'co', { success: true, exitCode: 0 }));
  assert.equal(created.branch, 'fresh');
});

test('observed commits amended or reset before any scan are reported as rewritten', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const original = commitFile(repos.main, 'r.txt', 'draft');
  const observedA = g.parseGitEventsFromCommand('git commit -m draft', ctx(repos.main, 'a', {
    success: true, exitCode: 0, output: `[main ${original.slice(0, 7)}] draft\n`,
  }));
  fs.writeFileSync(path.join(repos.main, 'r.txt'), 'draft 2\n');
  git(repos.main, 'commit', '-q', '-a', '--amend', '--no-edit');
  const amended = git(repos.main, 'rev-parse', 'HEAD');
  const [after] = enrich(g, [session(repos.main, observedA)]);
  const [rewritten] = byType(after.gitEvents, 'rewritten');
  assert.ok(rewritten, 'the amended-away observation is rewritten');
  assert.deepEqual(rewritten.oldShas, [original]);
  assert.deepEqual(rewritten.replacements, [{ oldSha: original, newSha: amended }]);

  const g2 = freshGit();
  const dropped = commitFile(repos.main, 'z.txt', 'doomed');
  const observedZ = g2.parseGitEventsFromCommand('git commit -m doomed', ctx(repos.main, 'z', {
    success: true, exitCode: 0, output: `[main ${dropped.slice(0, 7)}] doomed\n`,
  }));
  git(repos.main, 'reset', '-q', '--hard', 'origin/main');
  const [reset] = enrich(g2, [session(repos.main, observedZ)]);
  const resetEvent = byType(reset.gitEvents, 'rewritten').find((event) => event.oldShas.includes(dropped));
  assert.ok(resetEvent, 'the reset-away observation is rewritten');
  assert.deepEqual(byType(reset.gitEvents, 'push'), []);
});

test('a detached worktree sharing an upstream-less branch\'s commits keeps the branch labels', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'proto');
  const shared = [commitFile(repos.main, 'p1.txt', 'proto one'), commitFile(repos.main, 'p2.txt', 'proto two')];
  git(repos.main, 'branch', 'proto-copy');
  const branchOnly = commitFile(repos.main, 'p3.txt', 'proto three');
  git(repos.main, 'switch', '-q', 'main');
  const detachedWt = path.join(repos.root, 'wt-detached');
  git(repos.main, 'worktree', 'add', '-q', '--detach', detachedWt, shared[1]);
  // The detached tip is newer than every branch commit: it is walked first.
  const detachedOnly = commitFile(detachedWt, 'd.txt', 'detached only');
  const quietWt = path.join(repos.root, 'wt-quiet');
  git(repos.main, 'worktree', 'add', '-q', '--detach', quietWt, 'origin/main');

  const [after] = enrich(g, [session(repos.main), session(detachedWt, [], 'detached')]);
  const bySha = new Map(byType(after.gitEvents, 'commit').map((event) => [event.sha, event]));
  assert.equal(bySha.size, 4, 'four unpushed commits; the quiet detached worktree adds none');
  for (const sha of shared) {
    assert.equal(bySha.get(sha).branch, 'proto');
    assert.deepEqual(bySha.get(sha).branches, ['proto', 'proto-copy']);
    assert.equal(bySha.get(sha).detached, undefined);
  }
  assert.equal(bySha.get(branchOnly).branch, 'proto');
  assert.deepEqual(bySha.get(branchOnly).branches, ['proto']);
  assert.equal(bySha.get(detachedOnly).branch, null);
  assert.equal(bySha.get(detachedOnly).detached, true);
});

test('commands in unknown or vanished directories never become cargo of the session repository', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  for (const command of [
    'cd "$R" && git commit -q --allow-empty -m x',
    'cd $TMP/x && git commit -m x',
    'git -C "$(mktemp -d)" commit -m x',
    'cd - && git commit -m x',
    'cd "$D" && cd c && git commit -m base',
    `cd ${repos.root}/missing && git commit -m gone`,
  ]) {
    const [event] = g.parseGitEventsFromCommand(command, ctx(repos.main, `u-${command}`, {
      success: true, exitCode: 0, output: '[main 2fecba4] x\n',
    }));
    assert.equal(event.unresolved, true, command);
    assert.equal(event.repoRoot, undefined, command);
  }
  const [workdir] = g.extractGitEventsFromCommandSource({ cmd: 'git commit -m x', workdir: '$HOME/x' }, ctx(repos.main, 'wd'));
  assert.equal(workdir.unresolved, true);
  const [inside] = g.parseGitEventsFromCommand('git commit -m real', ctx(repos.subdir, 'in', { success: true, exitCode: 0 }));
  assert.equal(inside.repoRoot, repos.main);
  assert.equal(inside.unresolved, undefined);
});

test('ghost observations are retired: unresolved, vanished repos, missing shas and unmatched sha-less commits', async (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const temp = path.join(repos.root, 'scratch-repo');
  fs.mkdirSync(temp);
  git(temp, 'init', '-q', '-b', 'main');
  const tempSha = commitFile(temp, 't.txt', 'newwork');
  const events = [
    ...g.parseGitEventsFromCommand('cd "$D" && git commit -m x', ctx(repos.main, 'g1', { success: true, exitCode: 0, output: '[main 1111111] x\n' })),
    ...g.parseGitEventsFromCommand(`cd ${temp} && git commit -m newwork`, ctx(repos.main, 'g2', { success: true, exitCode: 0, output: `[main ${tempSha.slice(0, 7)}] newwork\n` })),
    ...g.parseGitEventsFromCommand('git commit -m det', ctx(repos.main, 'g3', { success: true, exitCode: 0, output: '[main 65a2c38] det\n' })),
    ...g.parseGitEventsFromCommand('git commit -m "never landed here"', ctx(repos.main, 'g4', { ts: Date.now() - 60_000 })),
  ];
  assert.equal(events.length, 4);
  assert.equal(events[1].repoRoot, temp, 'the temp repo existed when the command was observed');
  fs.rmSync(temp, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  enrich(g, [session(repos.main, events)]);
  const [after] = enrich(g, [session(repos.main, events)]);
  assert.deepEqual(byType(after.gitEvents, 'commit'), [], 'no phantom cargo in the session repository');
  const retired = byType(after.gitEvents, 'rewritten').flatMap((event) => event.oldIds || []);
  assert.ok(retired.includes(events[2].id), 'a sha the repository does not have is retired');
  assert.ok(retired.includes(events[3].id), 'an unmatched sha-less commit older than the scan is retired');
});

test('final #1: credentials never reach the wire, whatever their length', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const url = 'https://alice:short-password@example.test/r.git';
  const events = [
    ...g.parseGitEventsFromCommand(`git push ${url} main`, ctx(repos.main, 'c1', {
      success: false, exitCode: 128,
      output: `fatal: unable to access '${url}/': Could not resolve host: example.test\n`,
    })),
    ...g.parseGitEventsFromCommand('GH_TOKEN=tiny git -c http.extraHeader="Authorization: Bearer abc123" push https://ghp_shortTok3n@github.com/o/r.git main', ctx(repos.main, 'c2', {
      success: false, exitCode: 1, output: 'remote: Invalid username or token. Password=hunter2\nfatal: Authentication failed for \'https://ghp_shortTok3n@github.com/o/r.git/\'\n',
    })),
  ];
  assert.equal(events.length, 2);
  const wire = JSON.stringify(g.compactGitEventsForWire([{ sessionId: 's', project: repos.main, gitEvents: events }]));
  for (const secret of ['short-password', 'alice:', 'ghp_shortTok3n', 'abc123', 'hunter2', 'tiny']) {
    assert.ok(!wire.includes(secret), `the wire leaks ${secret}`);
  }
  assert.match(events[0].remote, /example\.test/);
});

test('final #2: a push after || does not run when the first push succeeded', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'a.txt', 'a');
  const first = gitOutput(repos.main, 'push', 'origin', 'main');
  const events = g.parseGitEventsFromCommand(`git -C ${repos.main} push origin main || git -C ${repos.other} push origin main`,
    ctx(repos.root, 'or', { success: true, exitCode: 0, output: first.output }));
  assert.deepEqual(events.map((event) => [event.cwd, event.status]), [[repos.main, 'success']]);
});

test('final #5: an up-to-date push keeps its own outcome next to another push\'s rejection', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const upToDate = gitOutput(repos.main, 'push', 'origin', 'main');
  assert.match(upToDate.output, /Everything up-to-date/);
  commitFile(repos.main, 'm.txt', 'main moves');
  git(repos.main, 'push', '-q', 'origin', 'main');
  commitFile(repos.other, 'o.txt', 'other work');
  const rejected = gitOutput(repos.other, 'push', 'origin', 'main');
  const events = g.parseGitEventsFromCommand(`git -C ${repos.main} push origin main && git -C ${repos.other} push origin main`,
    ctx(repos.root, 'utd', { success: false, exitCode: rejected.exitCode, output: upToDate.output + rejected.output }));
  assert.deepEqual(events.map((event) => [event.cwd, event.status]), [
    [repos.main, 'success'],
    [repos.other, 'rejected'],
  ]);
  assert.equal(events[0].refs[0].status, 'up-to-date');
});

test('final #4: crossing the scan window never invents rewritten history', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'long');
  for (let index = 0; index < 120; index++) git(repos.main, 'commit', '-q', '--allow-empty', '-m', `step ${index}`);
  const [before] = enrich(g, [session(repos.main)]);
  assert.equal(byType(before.gitEvents, 'commit').length, 120);
  git(repos.main, 'commit', '-q', '--allow-empty', '-m', 'step 120');
  const [after] = enrich(g, [session(repos.main)]);
  assert.deepEqual(byType(after.gitEvents, 'rewritten'), []);
  assert.deepEqual(byType(after.gitEvents, 'push'), []);
});

test('R1: a sha-less observation stays docked when the scan window is saturated', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  fs.writeFileSync(path.join(repos.main, 'quiet.txt'), 'quiet\n');
  git(repos.main, 'add', 'quiet.txt');
  git(repos.main, 'commit', '-q', '-m', 'quiet start');
  const [observed] = g.parseGitEventsFromCommand('git commit -q -m "quiet start"', ctx(repos.main, 'q', { ts: Date.now() - 60_000 }));
  assert.equal(observed.sha, undefined);
  for (let index = 0; index < 120; index++) git(repos.main, 'commit', '-q', '--allow-empty', '-m', `later ${index}`);
  const [after] = enrich(g, [session(repos.main, [observed])]);
  assert.deepEqual(byType(after.gitEvents, 'rewritten'), [], 'absence from a saturated window proves nothing');
  assert.ok(after.gitEvents.some((event) => event.id === observed.id), 'the observation stays');
});

test('R2: redaction keeps ref identities and subjects; only credential structures go', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const [cache] = g.parseGitEventsFromCommand('git push origin feature/ghp_cache', ctx(repos.main, 'r1'));
  const [docs] = g.parseGitEventsFromCommand('git push origin feature/ghp_docs', ctx(repos.main, 'r2'));
  assert.equal(cache.branch, 'feature/ghp_cache');
  assert.equal(docs.branch, 'feature/ghp_docs');
  assert.deepEqual(cache.refs.map(({ src, dst }) => [src, dst]), [['feature/ghp_cache', 'feature/ghp_cache']]);
  const [subject] = g.parseGitEventsFromCommand('git commit -m "fix ghp_cache parser"', ctx(repos.main, 'r3', {
    success: true, exitCode: 0, output: '[main abc1234] fix ghp_cache parser\n',
  }));
  assert.equal(subject.label, 'fix ghp_cache parser');
  const token = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
  assert.equal(token.length, 40);
  const [leak] = g.parseGitEventsFromCommand(`git push origin main # ${token}`, ctx(repos.main, 'r4', {
    success: false, exitCode: 1, output: `fatal: bad credentials ${token}\n`,
  }));
  assert.ok(!JSON.stringify(leak).includes(token));
});

test('R3: a skipped fallback group never runs its pushes', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'a.txt', 'a');
  const first = gitOutput(repos.main, 'push', 'origin', 'main');
  for (const command of [
    `git -C ${repos.main} push origin main || (true && git -C ${repos.other} push origin main)`,
    `git -C ${repos.main} push origin main || { true && git -C ${repos.other} push origin main; }`,
    `git -C ${repos.main} push origin main || bash -c "true && git -C ${repos.other} push origin main"`,
  ]) {
    const events = g.parseGitEventsFromCommand(command, ctx(repos.root, `n-${command}`, { success: true, exitCode: 0, output: first.output }));
    assert.deepEqual(events.map((event) => [event.cwd, event.status]), [[repos.main, 'success']], command);
  }
  // `a || b && c` runs c after a succeeds (the list keeps a's status).
  const flat = g.parseGitEventsFromCommand(`git -C ${repos.main} push origin main || true && git -C ${repos.other} push origin main`,
    ctx(repos.root, 'flat', { success: true, exitCode: 0, output: first.output }));
  assert.equal(flat.length, 2);
});

test('R6: branch membership survives a capped listing that omits a connecting parent', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const shared = commitFile(repos.main, 's.txt', 'shared newest');
  git(repos.main, 'branch', 'copy');
  const base = Date.now() - 2 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 250; index++) {
    const date = new Date(base + index * 60_000).toISOString();
    execGit(repos.main, { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, 'commit', '-q', '--allow-empty', '-m', `old ${index}`);
  }
  const [after] = enrich(g, [session(repos.main)]);
  const commit = byType(after.gitEvents, 'commit').find((event) => event.sha === shared);
  assert.ok(commit, 'the shared commit is listed');
  assert.deepEqual(new Set(commit.branches), new Set(['main', 'copy']));
});

test('R8: an unresolved observation is retried once its repository exists', (t) => {
  const root = fs.realpathSync(makeTempDir('claudeville-harbor-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => { delete process.env.GIT_CEILING_DIRECTORIES; });
  const g = freshGit();
  const context = ctx(root, 'pending', { ts: 1_800_000_000_000 });
  const command = 'mkdir fresh && cd fresh && git init -q -b main && git commit -q --allow-empty -m first';
  const [pending] = g.parseGitEventsFromCommand(command, context);
  assert.equal(pending.unresolved, true);
  const fresh = path.join(root, 'fresh');
  fs.mkdirSync(fresh);
  git(fresh, 'init', '-q', '-b', 'main');
  git(fresh, 'commit', '-q', '--allow-empty', '-m', 'first');
  const [done] = g.parseGitEventsFromCommand(command, { ...context, success: true, exitCode: 0 });
  assert.equal(done.id, pending.id);
  assert.equal(done.repoRoot, fresh);
  assert.equal(done.unresolved, undefined);
});

test('identity honours GIT_CEILING_DIRECTORIES', (t) => {
  const outer = fs.realpathSync(makeTempDir('claudeville-harbor-ceiling-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  git(outer, 'init', '-q', '-b', 'main');
  const inner = path.join(outer, 'plain');
  fs.mkdirSync(inner);
  const g = freshGit();
  assert.equal(g.resolveRepoIdentity(inner)?.repoRoot, outer);
  process.env.GIT_CEILING_DIRECTORIES = outer;
  t.after(() => { delete process.env.GIT_CEILING_DIRECTORIES; });
  const g2 = freshGit();
  assert.equal(g2.resolveRepoIdentity(inner), null);
});

test('v1.1 R1: a failed branch listing never proves a branch was deleted', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  enrich(g, [session(repos.main)]);
  git(repos.main, 'switch', '-q', '-c', 'new-feature');
  fs.writeFileSync(path.join(repos.main, 'nf.txt'), 'nf\n');
  git(repos.main, 'add', 'nf.txt');
  git(repos.main, 'commit', '-q', '-m', 'quiet feature work');
  const [observed] = g.parseGitEventsFromCommand('git commit -q -m "quiet feature work"', ctx(repos.main, 'nf', { ts: Date.now() - 30_000 }));
  assert.equal(observed.branch, 'new-feature');
  const pathBefore = process.env.PATH;
  process.env.PATH = path.join(repos.root, 'no-git-here');
  let after;
  try {
    [after] = enrich(g, [session(repos.main, [observed])]);
  } finally {
    process.env.PATH = pathBefore;
  }
  assert.deepEqual(byType(after.gitEvents, 'rewritten').filter((event) => event.oldIds?.length), []);
  assert.ok(after.gitEvents.some((event) => event.id === observed.id), 'the cargo stays docked');
});

test('v1.1: scanned and rewritten events carry scanSeq, scannedAt and branchesComplete', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  commitFile(repos.main, 'one.txt', 'one');
  const before = Date.now();
  const [first] = enrich(g, [session(repos.main)]);
  const [commit] = byType(first.gitEvents, 'commit');
  assert.ok(Number.isInteger(commit.scanSeq) && commit.scanSeq > 0);
  assert.ok(commit.scannedAt >= before);
  assert.notEqual(commit.scannedAt, commit.completedAt);
  assert.equal(commit.branchesComplete, true);
  git(repos.main, 'reset', '-q', '--hard', 'origin/main');
  const [second] = enrich(g, [session(repos.main)]);
  const [rewritten] = byType(second.gitEvents, 'rewritten');
  assert.ok(rewritten.scanSeq > commit.scanSeq);
  assert.ok(rewritten.scannedAt >= commit.scannedAt);
  const wire = g.compactGitEventsForWire([{ sessionId: 's', gitEvents: [commit, rewritten] }]);
  for (const field of ['scanSeq', 'scannedAt', 'branchesComplete']) assert.ok(wire.gitEventFields.includes(field), field);
});

test('v1.1 R4: a newer scan supersedes an observed commit\'s stale branch', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  git(repos.main, 'switch', '-q', '-c', 'topic');
  const sha = commitFile(repos.main, 't.txt', 'topic work');
  const [observed] = g.parseGitEventsFromCommand('git commit -m "topic work"', ctx(repos.main, 'tw', {
    ts: Date.now() - 20_000, success: true, exitCode: 0, output: `[topic ${sha.slice(0, 7)}] topic work\n`,
  }));
  git(repos.main, 'switch', '-q', 'main');
  git(repos.main, 'merge', '-q', '--ff-only', 'topic');
  git(repos.main, 'branch', '-q', '-f', 'topic', 'origin/main');
  const [after] = enrich(g, [session(repos.main, [observed])]);
  const [merged] = byType(after.gitEvents, 'commit');
  assert.equal(merged.attribution, 'observed');
  assert.equal(merged.sha, sha);
  assert.deepEqual(merged.branches, ['main']);
  assert.equal(merged.branch, 'main', 'the stale observed branch is not resurrected');
  assert.ok(merged.scanSeq > 0);
});

test('v1.1 R6: capped per-branch evidence never shrinks membership; ambiguous shas are resolved', (t) => {
  const repos = buildRepos(t);
  const g = freshGit();
  const shared = commitFile(repos.main, 's.txt', 'shared tip of copy');
  git(repos.main, 'branch', 'copy');
  const base = Date.now() - 3 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 650; index++) {
    const date = new Date(base + index * 60_000).toISOString();
    execGit(repos.main, { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, 'commit', '-q', '--allow-empty', '-m', `deep ${index}`);
  }
  const [after] = enrich(g, [session(repos.main)]);
  const commit = byType(after.gitEvents, 'commit').find((event) => event.sha === shared);
  assert.ok(commit);
  assert.deepEqual(new Set(commit.branches), new Set(['main', 'copy']));
  assert.equal(commit.branchesComplete, true, 'definitive reachability settled it');
});

test('v1.1: scanSeq outranks a previous server lifetime after a restart', (t) => {
  const repos = buildRepos(t);
  commitFile(repos.main, 'seq.txt', 'seq');
  let g = freshGit();
  enrich(g, [session(repos.main)]);
  git(repos.main, 'commit', '-q', '--allow-empty', '-m', 'second scan');
  const [before] = enrich(g, [session(repos.main)]);
  const oldSeq = Math.max(...byType(before.gitEvents, 'commit').map((event) => event.scanSeq));
  g = freshGit();
  const [after] = enrich(g, [session(repos.main)]);
  const newSeq = Math.max(...byType(after.gitEvents, 'commit').map((event) => event.scanSeq));
  assert.ok(newSeq > oldSeq, `${newSeq} > ${oldSeq}`);
  git(repos.main, 'commit', '-q', '--allow-empty', '-m', 'third scan');
  const [later] = enrich(g, [session(repos.main)]);
  assert.ok(Math.max(...byType(later.gitEvents, 'commit').map((event) => event.scanSeq)) > newSeq, 'still strictly increasing');
});
