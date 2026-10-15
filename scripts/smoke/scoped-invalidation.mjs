import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeTempDir } from '../tests/support/tmp.mjs';

const tmpHome = makeTempDir('claudeville-invalidation-');
const require = createRequire(import.meta.url);
const previousHome = process.env.HOME;
const previousDisableGit = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;

process.env.HOME = tmpHome;
delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'ClaudeVille Fixture';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'fixture@claudeville.local';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A clone of a bare remote with one pushed base commit.
function makeRepository(name) {
  const remote = path.join(tmpHome, 'remotes', `${name}.git`);
  const project = path.join(tmpHome, name);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  git(tmpHome, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmpHome, 'clone', '-q', remote, project);
  commit(project, `${name} base`);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  return project;
}

function commit(project, message) {
  fs.writeFileSync(path.join(project, 'commit.txt'), `${message}\n`);
  git(project, 'add', 'commit.txt');
  git(project, 'commit', '-q', '-m', message);
  return git(project, 'rev-parse', 'HEAD');
}

const session = (project, id = `fixture-${path.basename(project)}`) => ({ sessionId: id, provider: 'fixture', project, gitEvents: [] });
const labels = (sessions) => sessions[0].gitEvents.filter((event) => event.type === 'commit').map((event) => event.label);

try {
  const projectA = makeRepository('project-a');
  const projectB = makeRepository('project-b');
  commit(projectA, 'a first');
  commit(projectB, 'b first');
  const gitEvents = require('../../claudeville/adapters/gitEvents.js');
  const commands = () => gitEvents.getGitEnrichmentPerfStats().gitCommandCount;

  // Gitlink identity: a linked worktree and a submodule both have a `.git`
  // file. The worktree belongs to its main checkout; the submodule is its own
  // repository; subdirectories of either walk up to them.
  const worktree = path.join(tmpHome, 'project-a-wt');
  git(projectA, 'worktree', 'add', '-q', '-b', 'side', worktree);
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());
  const worktreeIdentity = gitEvents.resolveRepoIdentity(path.join(worktree, 'nested', 'dir'));
  assert.equal(worktreeIdentity.repoRoot, fs.realpathSync(projectA));
  assert.equal(worktreeIdentity.checkout, fs.realpathSync(worktree));
  assert.equal(worktreeIdentity.worktree.isMain, false);
  assert.ok(gitEvents.projectGitStateSignature(worktree), 'a worktree gitlink must sign its git state');
  git(projectB, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', projectA, 'vendor/a');
  const submodule = path.join(projectB, 'vendor', 'a');
  assert.ok(fs.statSync(path.join(submodule, '.git')).isFile());
  const submoduleIdentity = gitEvents.resolveRepoIdentity(submodule);
  assert.equal(submoduleIdentity.repoRoot, fs.realpathSync(submodule));
  assert.equal(submoduleIdentity.checkout, fs.realpathSync(submodule));
  assert.equal(submoduleIdentity.commonDir, path.join(fs.realpathSync(projectB), '.git', 'modules', 'vendor', 'a'));
  assert.ok(gitEvents.projectGitStateSignature(submodule), 'a submodule gitlink must sign its git state');
  assert.equal(gitEvents.resolveRepoIdentity(projectB).repoRoot, fs.realpathSync(projectB));
  git(projectB, 'commit', '-q', '-m', 'b submodule');

  const sessionsA = [session(projectA), session(path.join(projectA, 'sub', 'dir'), 'fixture-a-subdir'), session(worktree, 'fixture-a-wt')];
  const first = gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  assert.ok(labels(first).includes('a first'));
  assert.equal(new Set(first.map((entry) => entry.repoRoot)).size, 1, 'root, subdirectory and worktree share one repository');
  gitEvents.inferUnpushedGitEventsForSessions([session(projectB)]);
  const warmStart = commands();
  gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  gitEvents.inferUnpushedGitEventsForSessions([session(projectB)]);
  assert.equal(commands(), warmStart, 'warm polls must launch no Git subprocess');
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 60_000;
  try {
    gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(commands(), warmStart, 'an unchanged 60-second window must not launch a periodic Git subprocess burst');
  const initialStats = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(initialStats.repositoryScanCount, 2, 'one scan state per repository, not per session path');
  assert.equal(initialStats.unpushedEventCacheSize, 2);

  const beforeCommit = gitEvents.getGitEnrichmentPerfStats();
  commit(projectA, 'a second');
  const afterCommitSessions = gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  const afterCommit = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(afterCommit.headInvalidations, beforeCommit.headInvalidations + 1,
    'a new commit must invalidate the repository without waiting for its TTL');
  assert.ok(afterCommit.gitCommandCount > beforeCommit.gitCommandCount);
  assert.ok(labels(afterCommitSessions).includes('a second'), 'the next enrichment pass must expose the new commit');

  gitEvents.invalidateGitStatusCaches({ project: projectA });
  const pathBeforeGitFailure = process.env.PATH;
  process.env.PATH = path.join(tmpHome, 'missing-bin');
  let failedScan;
  try {
    failedScan = gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  } finally {
    process.env.PATH = pathBeforeGitFailure;
  }
  assert.ok(labels(failedScan).includes('a second'), 'a failed Git scan must keep the last good result');
  const recovered = gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
  assert.ok(labels(recovered).includes('a second'), 'Git enrichment must retry and recover after a transient failure');

  const openCodeState = path.join(tmpHome, '.local', 'share', 'opencode');
  fs.mkdirSync(openCodeState, { recursive: true });
  for (const fileName of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
    fs.writeFileSync(path.join(openCodeState, fileName), 'fixture');
  }
  const registry = require('../../claudeville/adapters/index.js');
  const claude = registry.adapters.find((adapter) => adapter.provider === 'claude');
  const grok = registry.adapters.find((adapter) => adapter.provider === 'grok');
  const openCode = registry.adapters.find((adapter) => adapter.provider === 'opencode');
  const openCodeWatchPaths = openCode.getWatchPaths();
  assert.ok(openCodeWatchPaths.some(entry => entry.path.endsWith('opencode.db')));
  assert.ok(openCodeWatchPaths.some(entry => entry.path.endsWith('opencode.db-wal')));
  assert.equal(
    openCodeWatchPaths.some(entry => entry.path.endsWith('-shm') || entry.filters?.includes('.db-shm')),
    false,
    'reader-mutated SQLite shared memory must not be watched',
  );
  const originalClaudeScoped = claude.invalidateCachesForDirty;
  const originalGrokFull = grok.invalidateCaches;
  const claudeDirtyCalls = [];
  let grokFullInvalidations = 0;
  claude.invalidateCachesForDirty = (dirty) => {
    claudeDirtyCalls.push(dirty);
    return originalClaudeScoped.call(claude, dirty);
  };
  grok.invalidateCaches = () => {
    grokFullInvalidations++;
    return originalGrokFull.call(grok);
  };

  try {
    const transcriptPath = path.join(tmpHome, '.claude', 'projects', 'fixture.jsonl');
    registry.invalidateSessionCaches({
      dirty: {
        provider: 'claude',
        path: transcriptPath,
        kind: 'transcript',
        reason: 'append',
        sessionId: 'fixture-session',
        project: projectA,
      },
    });
    assert.equal(claudeDirtyCalls.length, 1);
    assert.equal(claudeDirtyCalls[0].kind, 'transcript');
    assert.equal(claudeDirtyCalls[0].sessionId, 'fixture-session');
    assert.equal(grokFullInvalidations, 0, 'unrelated adapter cache must survive provider append');
    const afterAppend = commands();
    gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
    gitEvents.inferUnpushedGitEventsForSessions([session(projectB)]);
    assert.equal(commands(), afterAppend, 'provider append must not invalidate Git enrichment');

    registry.invalidateSessionCaches({
      dirty: {
        provider: null,
        path: projectA,
        kind: 'git',
        reason: 'git-state',
        project: projectA,
      },
    });
    const afterGitDirty = commands();
    gitEvents.inferUnpushedGitEventsForSessions([session(projectB)]);
    assert.equal(commands(), afterGitDirty, 'Git invalidation must leave other repositories warm');
    gitEvents.inferUnpushedGitEventsForSessions(sessionsA);
    assert.ok(commands() > afterGitDirty, 'Git invalidation must rescan the named repository');
    assert.equal(grokFullInvalidations, 0, 'Git invalidation must not flush provider adapters');

    registry.invalidateSessionCaches({
      dirty: {
        provider: 'grok',
        path: path.join(tmpHome, '.grok', 'sessions'),
        kind: 'discovery',
        reason: 'new-session',
      },
    });
    assert.equal(grokFullInvalidations, 1, 'provider discovery should retain legacy full invalidation');
  } finally {
    claude.invalidateCachesForDirty = originalClaudeScoped;
    grok.invalidateCaches = originalGrokFull;
  }

  const remoteProject = makeRepository('nested-remote-ref');
  const remoteBase = git(remoteProject, 'rev-parse', 'HEAD');
  const remoteHead = commit(remoteProject, 'remote second');
  git(remoteProject, 'update-ref', 'refs/remotes/origin/team/main', remoteBase);
  const remoteSession = session(remoteProject, 'nested-remote-ref-session');
  assert.ok(labels(gitEvents.inferUnpushedGitEventsForSessions([remoteSession])).includes('remote second'),
    'fixture must begin with one commit ahead of the nested remote ref');
  const beforeRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  git(remoteProject, 'update-ref', 'refs/remotes/origin/team/main', remoteHead);
  const afterRemoteAdvance = gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  const afterRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(afterRemoteStats.headInvalidations, beforeRemoteStats.headInvalidations + 1,
    'a nested loose remote-ref update must invalidate Git enrichment without watcher help');
  assert.ok(afterRemoteStats.gitCommandCount > beforeRemoteStats.gitCommandCount);
  assert.equal(labels(afterRemoteAdvance).includes('remote second'), false,
    'the refreshed enrichment must not retain a commit now contained by the remote ref');
  assert.ok(afterRemoteAdvance[0].gitEvents.some((event) => event.type === 'push' && event.landedShas?.includes(remoteHead)),
    'the landed commit departs with a transition push');

  const bulkRemoteDir = path.join(remoteProject, '.git', 'refs', 'remotes', 'bulk');
  fs.mkdirSync(bulkRemoteDir, { recursive: true });
  for (let index = 0; index < 900; index++) {
    fs.writeFileSync(path.join(bulkRemoteDir, `ref-${String(index).padStart(4, '0')}`), `${remoteHead}\n`);
  }
  gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  const afterBulk = commands();
  gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  assert.equal(commands(), afterBulk, 'a bounded signature over large loose remote-ref trees stays warm');

  const { shutdownRuntime, _watcherTest } = require('../../claudeville/server.js');
  const watchRoot = path.join(tmpHome, 'watch-root');
  fs.mkdirSync(watchRoot);
  const canonical = _watcherTest.canonicalizeWatchDescriptors([
    {
      type: 'directory',
      path: watchRoot,
      provider: 'claude',
      scope: 'active',
      kind: 'transcript',
      sessionId: 'fixture-session',
      project: projectA,
      filter: '.jsonl',
    },
  ]);
  assert.equal(canonical.length, 1);
  assert.deepEqual(canonical[0].kinds, ['transcript']);
  assert.deepEqual(canonical[0].sessionIds, ['fixture-session']);
  assert.deepEqual(canonical[0].projects, [projectA]);
  const dirty = _watcherTest.dirtyDescriptorForWatch(canonical[0], 'directory:watch-root', 'child.jsonl');
  assert.deepEqual(dirty, {
    provider: 'claude',
    path: path.join(watchRoot, 'child.jsonl'),
    kind: 'transcript',
    reason: 'directory:watch-root',
    sessionId: 'fixture-session',
    project: projectA,
  });
  shutdownRuntime({ reason: 'scoped invalidation smoke', exitProcess: false });

  console.log('scoped invalidation smoke passed (gitlink identity, warm polls, provider append, repository Git scope, nested remote refs, watcher metadata)');
} finally {
  process.env.HOME = previousHome;
  if (previousDisableGit === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = previousDisableGit;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
