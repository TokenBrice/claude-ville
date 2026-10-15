const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { execFile, execFileSync } = require('child_process');

const GIT_EVENT_TYPES = new Set(['commit', 'push', 'pull', 'fetch']);
const GH_EVENT_TYPES = new Set(['pr', 'issue', 'release']);
const GH_EVENT_COMMANDS = Object.freeze({
  pr: new Set(['create', 'merge']),
  issue: new Set(['create']),
  release: new Set(['create']),
});
const GH_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '--repo',
  '-R',
  '--hostname',
  '--config',
]);
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
]);
const HELP_FLAGS = new Set(['--help', '-h']);
// `git tag` forms that list, delete or verify rather than create a tag.
const GIT_TAG_NON_CREATE_FLAGS = new Set(['-l', '--list', '-d', '--delete', '-v', '--verify', '-n']);
const GIT_TAG_FLAGS_WITH_VALUE = new Set(['-m', '--message', '-F', '--file', '-u', '--local-user']);
// Git-state probes invalidate a project's cache when refs change. Keep a slow
// fallback for missed/provider-external changes without launching a subprocess
// burst at every 30-second watcher reconciliation.
const GIT_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_REPOSITORY_PUSH_TTL_MS = 2 * 60 * 1000;
const REPOSITORY_UNPUSHED_EVENT_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.CLAUDEVILLE_REPOSITORY_UNPUSHED_EVENT_TTL_MS || (7 * 24 * 60 * 60 * 1000)) || (7 * 24 * 60 * 60 * 1000)
);
const MAX_UNPUSHED_COMMITS_PER_BRANCH = 120;
// Branches scanned per repository: every checked-out branch, then the most
// recently committed ones, bounded so a repository with hundreds of stale
// branches costs one `git log`.
const MAX_SCANNED_BRANCHES = 24;
// Ambiguous branch memberships settled per log re-read.
const MAX_MEMBERSHIP_RESOLUTIONS = 32;
const MAX_UNPUSHED_COMMITS_PER_SCAN = 600;
const GIT_EVENT_STDERR_MAX_CHARS = 2048;
const GIT_EVENT_REASON_MAX_CHARS = 200;
const GIT_LANDED_SHAS_MAX = 200;
const GIT_FROZEN_EVENT_MAX = 20_000;
const REPO_IDENTITY_TTL_MS = 60_000;
const REPO_IDENTITY_MAX_ENTRIES = 2048;
// Forge events are transcript-derived and intentionally bounded like the
// repository commit cache. The newest records win when a scan is larger.
const MAX_FORGE_EVENTS_PER_PROJECT = MAX_UNPUSHED_COMMITS_PER_BRANCH;
const GIT_TRACKING_TTL_MS = 6 * 60 * 60 * 1000;
const GIT_TRACKING_MAX_PROJECTS = 512;
const GIT_REMOTE_REF_SCAN_MAX_ENTRIES = 800;
const GIT_REMOTE_REF_SCAN_MAX_DEPTH = 8;
const GIT_STATE_MAX_REF_ENTRIES = 800;
const GIT_METADATA_MAX_PROJECTS = 128;
// Four server ref/reflog roots in each of the checkout/common git dirs.
const GIT_METADATA_MAX_CACHED_ENTRIES = 8 * GIT_STATE_MAX_REF_ENTRIES;
const _gitMetadataSnapshots = new Map();
const GIT_WORKER_MAX_CONCURRENCY = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_CONCURRENCY',
  2,
  1,
  8,
);
const GIT_WORKER_MAX_QUEUE_DEPTH = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_QUEUE_DEPTH',
  32,
  1,
  256,
);
const GIT_WORKER_TIMEOUT_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_TIMEOUT_MS',
  750,
  50,
  10_000,
);
const GIT_WORKER_RETRY_BASE_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_RETRY_BASE_MS',
  1_000,
  100,
  60_000,
);
const GIT_WORKER_RETRY_MAX_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_RETRY_MAX_MS',
  30_000,
  GIT_WORKER_RETRY_BASE_MS,
  5 * 60_000,
);
const _repoScans = new Map();
const _repoIdentityCache = new Map();
const _packedRefsCache = new Map();
const _gitTrackingLastSeen = new Map();
const _perf = {
  disabled: false,
  enrichmentCalls: 0,
  enrichmentTimeMs: 0,
  projectsScanned: 0,
  gitCommandCount: 0,
  gitCommandTimeMs: 0,
  gitCommandErrors: 0,
  gitCommandTimeouts: 0,
  cacheHits: 0,
  headInvalidations: 0,
  remoteRefScans: 0,
  remoteRefEntries: 0,
  remoteRefScanHighWater: 0,
  remoteRefScanTruncations: 0,
  lastRun: null,
  recentRuns: [],
};

const _gitWorker = {
  enabled: false,
  stopping: false,
  queue: [],
  activeJobs: 0,
  activeChildren: new Set(),
  states: new Map(),
  retryTimers: new Map(),
  onDataReady: null,
  requests: 0,
  refreshes: 0,
  refreshTimeMs: 0,
  failures: 0,
  retries: 0,
  sheds: 0,
  coalesced: 0,
  staleCompletions: 0,
  droppedOnShutdown: 0,
  callbackErrors: 0,
  maxQueueDepthObserved: 0,
  lastError: null,
  lastErrorAt: null,
  lastRefreshAt: null,
  lastRefreshProject: null,
  lastRefreshReason: null,
};

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function invalidateGitStatusCaches({ project = null } = {}) {
  if (!project) {
    for (const state of _repoScans.values()) state.forceRescan = true;
    if (_gitWorker.enabled) noteGitWorkerInvalidation();
    return;
  }
  const normalized = normalizeProjectPath(project);
  _repoIdentityCache.delete(`${normalized}\0${process.env.GIT_CEILING_DIRECTORIES || ''}`);
  const repoRoot = resolveRepoIdentity(normalized)?.repoRoot || normalized;
  const state = _repoScans.get(repoRoot);
  if (state) state.forceRescan = true;
  if (_gitWorker.enabled && (state || _gitWorker.states.has(repoRoot))) noteGitWorkerInvalidation(repoRoot);
}

function pruneGitTrackingState(activeRepoRoots = [], now = Date.now()) {
  for (const repoRoot of activeRepoRoots) {
    if (!repoRoot) continue;
    _gitTrackingLastSeen.delete(repoRoot);
    _gitTrackingLastSeen.set(repoRoot, now);
  }

  const expired = new Set();
  for (const [repoRoot, seenAt] of _gitTrackingLastSeen) {
    if ((now - seenAt) > GIT_TRACKING_TTL_MS) expired.add(repoRoot);
  }
  while ((_gitTrackingLastSeen.size - expired.size) > GIT_TRACKING_MAX_PROJECTS) {
    const repoRoot = [..._gitTrackingLastSeen.keys()].find((candidate) => !expired.has(candidate));
    if (!repoRoot) break;
    expired.add(repoRoot);
  }

  for (const repoRoot of expired) {
    _gitTrackingLastSeen.delete(repoRoot);
    _repoScans.delete(repoRoot);
    _gitMetadataSnapshots.delete(repoRoot);
  }
}

// ─── Repository identity (filesystem only, no subprocess) ───────────
//
// repoRoot is the main worktree: the parent of the common `.git` dir, the
// common dir's `core.worktree` (submodules), or the common dir itself (a
// bare repository with linked worktrees). checkout is the top level of the
// worktree containing the path. Subdirectories walk up to their checkout.

function normalizeProjectPath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return path.isAbsolute(text) ? path.resolve(text) : text;
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readTail(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function realpathOr(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function readCoreWorktree(commonDir) {
  const config = readFileSafe(path.join(commonDir, 'config'));
  const core = /^\s*\[core\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(config);
  const match = core && /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(core[1]);
  return match ? realpathOr(path.resolve(commonDir, match[1].replace(/^"(.*)"$/, '$1'))) : null;
}

function buildRepoIdentity(checkoutPath, gitDirPath) {
  const checkout = realpathOr(checkoutPath);
  const gitDir = realpathOr(gitDirPath);
  const commonDir = realpathOr(resolveGitCommonDir(gitDir));
  // `git worktree list` names the main worktree: the parent of a `.git`
  // common dir, else `core.worktree`, else the common dir itself (separate
  // git dirs and bare repositories). The main worktree's git dir is the
  // common dir.
  let repoRoot;
  if (path.basename(commonDir) === '.git') repoRoot = path.dirname(commonDir);
  else repoRoot = readCoreWorktree(commonDir) || commonDir;
  return {
    repoRoot,
    checkout,
    gitDir,
    commonDir,
    worktree: { name: path.basename(checkout), path: checkout, isMain: gitDir === commonDir },
  };
}

function isBareRepository(dir) {
  try {
    if (!fs.statSync(path.join(dir, 'HEAD')).isFile()) return false;
    if (!fs.statSync(path.join(dir, 'objects')).isDirectory()) return false;
  } catch {
    return false;
  }
  return /^\s*bare\s*=\s*true\s*$/im.test(readFileSafe(path.join(dir, 'config')));
}

function dotGitStamp(dotGit) {
  try {
    const stat = fs.statSync(dotGit);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function resolveRepoIdentity(dir) {
  const normalized = normalizeProjectPath(dir);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  const now = Date.now();
  const cacheKey = `${normalized}\0${process.env.GIT_CEILING_DIRECTORIES || ''}`;
  const cached = _repoIdentityCache.get(cacheKey);
  if (cached && now - cached.at < REPO_IDENTITY_TTL_MS && dotGitStamp(cached.dotGit) === cached.stamp) {
    return cached.value;
  }

  // Symlinked paths walk from their real location. Misses are not cached: a
  // repository can be initialized at any moment.
  let value = null;
  let foundDotGit = null;
  // Like git, never search up into a GIT_CEILING_DIRECTORIES entry.
  const ceilings = new Set(String(process.env.GIT_CEILING_DIRECTORIES || '')
    .split(path.delimiter).filter((entry) => path.isAbsolute(entry)).map((entry) => realpathOr(path.resolve(entry))));
  for (let current = realpathOr(normalized); ;) {
    const dotGit = path.join(current, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* keep walking up */ }
    let gitDir = null;
    if (stat?.isDirectory()) gitDir = dotGit;
    else if (stat?.isFile()) {
      const pointer = readFileSafe(dotGit).match(/^\s*gitdir:\s*(.+?)\s*$/im);
      if (pointer) gitDir = path.resolve(current, pointer[1]);
    }
    if (gitDir) {
      value = buildRepoIdentity(current, gitDir);
      foundDotGit = dotGit;
      break;
    }
    if (!stat && isBareRepository(current)) {
      value = buildRepoIdentity(current, current);
      foundDotGit = path.join(current, 'HEAD');
      break;
    }
    const parent = path.dirname(current);
    if (parent === current || ceilings.has(parent)) break;
    current = parent;
  }
  _repoIdentityCache.delete(cacheKey);
  if (!value) return null;
  _repoIdentityCache.set(cacheKey, { at: now, value, dotGit: foundDotGit, stamp: dotGitStamp(foundDotGit) });
  while (_repoIdentityCache.size > REPO_IDENTITY_MAX_ENTRIES) {
    _repoIdentityCache.delete(_repoIdentityCache.keys().next().value);
  }
  return value;
}

function readHeadState(gitDir) {
  const head = readFileSafe(path.join(gitDir, 'HEAD')).trim();
  if (!head) return null;
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (match) return { branch: match[1], detached: false };
  const detached = /^[0-9a-f]{40,64}$/.test(head);
  return detached ? { branch: '', detached, sha: head } : { branch: '', detached };
}

function packedRefs(commonDir) {
  const file = path.join(commonDir, 'packed-refs');
  let stat;
  try { stat = fs.statSync(file); } catch { return new Set(); }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = _packedRefsCache.get(commonDir);
  if (cached?.key === key) return cached.refs;
  const refs = new Set();
  for (const line of readFileSafe(file).split('\n')) {
    const match = /^[0-9a-f]{40,64} (refs\/\S+)$/.exec(line.trim());
    if (match) refs.add(match[1]);
  }
  _packedRefsCache.delete(commonDir);
  _packedRefsCache.set(commonDir, { key, refs });
  while (_packedRefsCache.size > GIT_METADATA_MAX_PROJECTS) {
    _packedRefsCache.delete(_packedRefsCache.keys().next().value);
  }
  return refs;
}

function repoHasRef(commonDir, ref) {
  try {
    if (fs.statSync(path.join(commonDir, ref)).isFile()) return true;
  } catch { /* not a loose ref */ }
  return packedRefs(commonDir).has(ref);
}

// A push positional names a tag (not a branch) when only refs/tags has it.
function repoHasTag(identity, name) {
  if (!name || name.startsWith('-') || name.startsWith('refs/') || /[\s:~^?*[\\]/.test(name)) return false;
  return repoHasRef(identity.commonDir, `refs/tags/${name}`)
    && !repoHasRef(identity.commonDir, `refs/heads/${name}`);
}

function resolveGitCommonDir(gitDir) {
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  } catch {
    return gitDir;
  }
}

function gitMetadataSnapshot(project) {
  let snapshot = _gitMetadataSnapshots.get(project);
  if (!snapshot) snapshot = { directories: new Map(), entryCount: 0 };
  _gitMetadataSnapshots.delete(project);
  _gitMetadataSnapshots.set(project, snapshot);
  while (_gitMetadataSnapshots.size > GIT_METADATA_MAX_PROJECTS) {
    _gitMetadataSnapshots.delete(_gitMetadataSnapshots.keys().next().value);
  }
  // Never retain leaf stats between probes: a nested ref can be rewritten
  // without changing its directory. Only directory listings are reusable.
  const stats = new Map();
  return {
    snapshot,
    stat(file) {
      if (!stats.has(file)) {
        try { stats.set(file, fs.statSync(file)); } catch { stats.set(file, null); }
      }
      return stats.get(file);
    },
  };
}

function gitDirectoryIdentity(stat) {
  return stat
    ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    : null;
}

function rememberGitDirectory(metadata, directory, identity, entries) {
  const { snapshot } = metadata;
  const previous = snapshot.directories.get(directory);
  if (previous) snapshot.entryCount -= previous.entries.length + 1;
  snapshot.directories.delete(directory);
  const weight = entries.length + 1;
  if (weight > GIT_METADATA_MAX_CACHED_ENTRIES) return;
  while (snapshot.entryCount + weight > GIT_METADATA_MAX_CACHED_ENTRIES) {
    const oldest = snapshot.directories.keys().next().value;
    snapshot.entryCount -= snapshot.directories.get(oldest).entries.length + 1;
    snapshot.directories.delete(oldest);
  }
  snapshot.directories.set(directory, { identity, entries });
  snapshot.entryCount += weight;
}

function gitDirectoryEntries(metadata, directory, limit, full = false) {
  const identity = gitDirectoryIdentity(metadata.stat(directory));
  const cached = metadata.snapshot.directories.get(directory);
  if (identity && cached?.identity === identity) {
    if (full) return { entries: cached.entries.slice(), truncated: false };
    return { entries: cached.entries.slice(0, limit), truncated: cached.entries.length > limit };
  }
  if (cached) {
    metadata.snapshot.entryCount -= cached.entries.length + 1;
    metadata.snapshot.directories.delete(directory);
  }
  const entries = [];
  let dir;
  let truncated = false;
  try {
    dir = fs.opendirSync(directory);
    const bound = full ? GIT_STATE_MAX_REF_ENTRIES : limit;
    while (entries.length < bound) {
      const entry = dir.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    if (entries.length >= bound && dir.readSync()) truncated = true;
  } finally {
    try { dir?.closeSync(); } catch { /* ignore */ }
  }
  if (!truncated && identity) rememberGitDirectory(metadata, directory, identity, entries);
  // The server historically sorts the entire directory before applying its
  // traversal cap. Oversized roots must keep that behavior; the worker must
  // instead keep its bounded native-order prefix, so these are not cached.
  if (full && truncated) {
    return { entries: fs.readdirSync(directory, { withFileTypes: true }), truncated: false };
  }
  return { entries, truncated };
}

function gitStateFilePart(metadata, file, label) {
  const stat = metadata.stat(file);
  return stat?.isFile() ? `${label}:${Math.round(stat.mtimeMs)}:${stat.size}` : null;
}

function appendGitRefDirParts(metadata, parts, root, label) {
  const stack = [{ dir: root, depth: 0 }];
  let entries = 0;
  while (stack.length > 0 && entries < GIT_STATE_MAX_REF_ENTRIES) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = gitDirectoryEntries(metadata, current.dir, GIT_STATE_MAX_REF_ENTRIES, true).entries;
    } catch {
      continue;
    }
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > GIT_STATE_MAX_REF_ENTRIES) break;
      const entryPath = path.join(current.dir, dirent.name);
      if (dirent.isDirectory()) {
        if (current.depth < 8) stack.push({ dir: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (!dirent.isFile()) continue;
      const part = gitStateFilePart(metadata, entryPath, `${label}/${path.relative(root, entryPath)}`);
      if (part) parts.push(part);
    }
  }
  if (entries >= GIT_STATE_MAX_REF_ENTRIES) parts.push(`${label}:truncated`);
}

function projectGitStateSignature(project) {
  if (!project) return null;
  // Subdirectory sessions walk up to their checkout's git dir.
  const identity = resolveRepoIdentity(project);
  if (!identity) return null;
  const gitDir = identity.gitDir;
  const metadata = gitMetadataSnapshot(normalizeProjectPath(project));
  const parts = [];
  for (const fileName of ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs', path.join('logs', 'HEAD')]) {
    const part = gitStateFilePart(metadata, path.join(gitDir, fileName), fileName);
    if (part) parts.push(part);
  }
  const refRoots = ['refs/heads', 'refs/remotes', 'logs/refs/heads', 'logs/refs/remotes'];
  for (const label of refRoots) {
    appendGitRefDirParts(metadata, parts, path.join(gitDir, label), label);
  }
  // A linked worktree keeps HEAD and its reflog in its own git dir, but its
  // branches, remote-tracking refs and packed refs live in the common dir, so
  // a push from the worktree changes only those.
  const commonDir = identity.commonDir;
  if (commonDir !== gitDir) {
    const part = gitStateFilePart(metadata, path.join(commonDir, 'packed-refs'), 'common/packed-refs');
    if (part) parts.push(part);
    for (const label of refRoots) {
      appendGitRefDirParts(metadata, parts, path.join(commonDir, label), `common/${label}`);
    }
  }
  return parts.sort().join('|');
}

// Repository-wide ref state: the shared branches, remote-tracking refs and
// packed refs, plus every worktree's HEAD. Unchanged means a scan would see
// nothing new, so warm polls launch no subprocess.
function repoStateSignature(identity) {
  const metadata = gitMetadataSnapshot(identity.repoRoot);
  const commonDir = identity.commonDir;
  const parts = [];
  for (const fileName of ['HEAD', 'packed-refs']) {
    const part = gitStateFilePart(metadata, path.join(commonDir, fileName), fileName);
    if (part) parts.push(part);
  }
  for (const label of ['refs/heads', 'refs/remotes']) {
    appendGitRefDirParts(metadata, parts, path.join(commonDir, label), label);
  }
  let worktrees = [];
  try {
    worktrees = gitDirectoryEntries(metadata, path.join(commonDir, 'worktrees'), 64).entries;
  } catch { /* no linked worktrees */ }
  for (const entry of worktrees) {
    const part = gitStateFilePart(metadata, path.join(commonDir, 'worktrees', entry.name, 'HEAD'), `worktrees/${entry.name}/HEAD`);
    if (part) parts.push(part);
  }
  return parts.sort().join('|');
}

function isGitEnrichmentDisabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT || '').toLowerCase());
}

function gitWorkerErrorDetail(error) {
  const detail = error?.message || error?.code || String(error || 'Unknown Git worker error');
  return detail.length <= 256 ? detail : `${detail.slice(0, 255)}…`;
}

function isGitWorkerTimeout(error) {
  return error?.code === 'ETIMEDOUT'
    || error?.signal === 'SIGTERM'
    || /timed? out|timeout/i.test(error?.message || '');
}

function gitWorkerState(project) {
  const normalizedProject = path.resolve(String(project));
  let state = _gitWorker.states.get(normalizedProject);
  if (state) return state;

  state = {
    project: normalizedProject,
    generation: 0,
    queued: false,
    running: false,
    rerunRequested: false,
    retryAttempt: 0,
    nextRetryAt: 0,
    retryTimer: null,
    observedBranches: new Set(),
    jobObservedBranches: new Set(),
    lastRequestedAt: null,
    lastCompletedAt: null,
    lastGoodAt: null,
    lastReason: null,
  };
  _gitWorker.states.set(normalizedProject, state);
  trimGitWorkerStates(normalizedProject);
  return state;
}

function trimGitWorkerStates(protectedProject = null) {
  if (_gitWorker.states.size <= GIT_TRACKING_MAX_PROJECTS) return;
  for (const [project, state] of _gitWorker.states) {
    if (_gitWorker.states.size <= GIT_TRACKING_MAX_PROJECTS) break;
    if (project === protectedProject) continue;
    if (state.running || state.queued) continue;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    _gitWorker.states.delete(project);
  }
}

function noteGitWorkerInvalidation(project = null) {
  const states = project
    ? [gitWorkerState(project)]
    : [..._gitWorker.states.values()];
  for (const state of states) {
    state.generation++;
    if (state.running || state.queued) state.rerunRequested = true;
  }
}

function scheduleGitWorkerRetry(project, state) {
  if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled()) return;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  const delay = Math.min(
    GIT_WORKER_RETRY_MAX_MS,
    GIT_WORKER_RETRY_BASE_MS * (2 ** Math.min(state.retryAttempt - 1, 8)),
  );
  state.nextRetryAt = Date.now() + delay;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    state.nextRetryAt = 0;
    if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled()) return;
    _gitWorker.retries++;
    requestGitWorkerRefresh(project, { reason: 'retry' });
  }, delay);
  state.retryTimer.unref?.();
}

function addObservedGitBranches(state, events = []) {
  const branches = new Set();
  for (const event of events) {
    if (event?.type !== 'commit') continue;
    const branch = eventBranch(event);
    if (branch) branches.add(branch);
  }
  let unseen = false;
  for (const branch of branches) {
    if (!state.observedBranches.has(branch) && !state.jobObservedBranches.has(branch)) unseen = true;
    state.observedBranches.add(branch);
  }
  return unseen;
}

function runGitWorkerCommand(project, args) {
  if (!project) return Promise.resolve('');

  const start = Date.now();
  _perf.gitCommandCount++;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let hardTimeout = null;

    const finish = (error, stdout = '') => {
      if (settled) return;
      settled = true;
      if (hardTimeout) clearTimeout(hardTimeout);
      if (child) _gitWorker.activeChildren.delete(child);
      _perf.gitCommandTimeMs += Date.now() - start;

      if (error) {
        const expectedRefMiss = args[0] === 'rev-parse'
          && args.includes('--verify')
          && args.includes('--quiet')
          && Number.isInteger(error?.status);
        if (!expectedRefMiss) {
          _perf.gitCommandErrors++;
          if (isGitWorkerTimeout(error)) _perf.gitCommandTimeouts++;
        }
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    };

    try {
      child = execFile('git', ['-C', project, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_WORKER_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 256 * 1024,
      }, (error, stdout) => finish(error, stdout));
      _gitWorker.activeChildren.add(child);
      hardTimeout = setTimeout(() => {
        const timeoutError = new Error(`git command timed out after ${GIT_WORKER_TIMEOUT_MS}ms`);
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.signal = 'SIGTERM';
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        finish(timeoutError);
      }, GIT_WORKER_TIMEOUT_MS + 250);
      hardTimeout.unref?.();
    } catch (error) {
      finish(error);
    }
  });
}

function scanSnapshotFingerprint(state) {
  return JSON.stringify([
    state.snapshot?.unpushed || [],
    [...state.recent.keys()].sort(),
  ]);
}

async function refreshGitWorkerProject(job, workerState) {
  const { project: repoRoot, generation, reason } = job;
  const startedAt = Date.now();
  const identity = resolveRepoIdentity(repoRoot) || pseudoIdentity(repoRoot);
  const state = repoScanState(identity);
  const startSignature = repoStateSignature(identity);
  const observedBranches = new Set(workerState.observedBranches);
  workerState.observedBranches.clear();
  workerState.jobObservedBranches = new Set(observedBranches);
  rememberObservedBranches(state, observedBranches);
  const pendingShas = [...state.pendingShas];
  state.pendingShas.clear();
  const previous = state.snapshot;
  const fingerprintBefore = scanSnapshotFingerprint(state);

  try {
    if (state.signature !== undefined && startSignature !== state.signature) {
      for (const [sha, entry] of state.containment) {
        if (!entry.contained) state.containment.delete(sha);
      }
    }
    const cwd = scanCwd(identity);
    const result = await runStepsAsync(cwd, scanRepositorySteps(state, {
      observedBranches: state.observedBranches,
      now: startedAt,
    }));
    if (result?.ok && pendingShas.length) {
      await runStepsAsync(cwd, containmentSteps(state, pendingShas, Date.now()));
    }
    const completedAt = Date.now();
    state.lastScanFailed = !result?.ok;
    if (result?.ok) {
      state.snapshot = { at: completedAt, generation, unpushed: result.unpushed };
      state.signature = startSignature;
    } else if (!previous) {
      // Not a repository (or git refused): an empty, authoritative answer.
      state.snapshot = { at: completedAt, generation, unpushed: [] };
    } else {
      previous.at = completedAt;
      previous.generation = generation;
    }

    const endSignature = repoStateSignature(identity);
    if (workerState.generation !== generation || startSignature !== endSignature) {
      _gitWorker.staleCompletions++;
      workerState.generation++;
      workerState.rerunRequested = true;
    }

    workerState.retryAttempt = 0;
    workerState.nextRetryAt = 0;
    workerState.lastGoodAt = completedAt;
    workerState.lastCompletedAt = completedAt;
    workerState.lastReason = reason;
    _gitWorker.refreshes++;
    _gitWorker.refreshTimeMs += completedAt - startedAt;
    _gitWorker.lastRefreshAt = completedAt;
    _gitWorker.lastRefreshProject = repoRoot;
    _gitWorker.lastRefreshReason = reason;

    const changed = !previous || fingerprintBefore !== scanSnapshotFingerprint(state) || pendingShas.length > 0;
    if (changed) {
      const rerunBeforePublish = workerState.rerunRequested;
      const generationBeforePublish = workerState.generation;
      try {
        _gitWorker.onDataReady?.({
          project: repoRoot,
          reason: 'git-enrichment-refresh',
          staleAgeMs: previous ? Math.max(0, completedAt - startedAt) : null,
        });
      } catch (error) {
        _gitWorker.callbackErrors++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      }
      // The server invalidates this repository when it publishes the
      // completion. Keep the published snapshot aligned with that generation
      // without losing a genuinely newer request coalesced during the job.
      if (state.snapshot && state.snapshot.generation === generationBeforePublish) {
        state.snapshot.generation = workerState.generation;
      }
      workerState.rerunRequested = rerunBeforePublish;
    }
  } catch (error) {
    for (const sha of pendingShas) state.pendingShas.add(sha);
    _gitWorker.failures++;
    _gitWorker.lastError = `${repoRoot}: ${gitWorkerErrorDetail(error)}`;
    _gitWorker.lastErrorAt = Date.now();
    workerState.retryAttempt++;
    scheduleGitWorkerRetry(repoRoot, workerState);
  } finally {
    workerState.jobObservedBranches.clear();
  }
}

function drainGitWorkerQueue() {
  if (!_gitWorker.enabled || _gitWorker.stopping) return;
  while (_gitWorker.activeJobs < GIT_WORKER_MAX_CONCURRENCY && _gitWorker.queue.length) {
    const job = _gitWorker.queue.shift();
    const state = _gitWorker.states.get(job.project);
    if (!state || !state.queued) continue;
    state.queued = false;
    state.running = true;
    state.lastRequestedAt = job.requestedAt;
    state.lastReason = job.reason;
    _gitWorker.activeJobs++;
    Promise.resolve(refreshGitWorkerProject(job, state))
      .catch((error) => {
        _gitWorker.failures++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      })
      .finally(() => {
        _gitWorker.activeJobs--;
        state.running = false;
        if (_gitWorker.enabled && !_gitWorker.stopping && state.rerunRequested) {
          state.rerunRequested = false;
          requestGitWorkerRefresh(job.project, { reason: 'coalesced-change' });
        }
        trimGitWorkerStates();
        drainGitWorkerQueue();
      })
      .catch((error) => {
        _gitWorker.failures++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      });
  }
}

function requestGitWorkerRefresh(project, { reason = 'stale', observedEvents = [], force = false } = {}) {
  if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled() || !project) return false;
  const normalized = normalizeProjectPath(String(project));
  const normalizedProject = resolveRepoIdentity(normalized)?.repoRoot || normalized;
  _gitWorker.requests++;
  const state = gitWorkerState(normalizedProject);
  const hasUnseenBranches = addObservedGitBranches(state, observedEvents);
  if (state.running || state.queued) {
    _gitWorker.coalesced++;
    if (state.running && (hasUnseenBranches || force)) state.rerunRequested = true;
    return true;
  }
  if (state.nextRetryAt > Date.now()) {
    _gitWorker.coalesced++;
    return true;
  }
  if (_gitWorker.queue.length >= GIT_WORKER_MAX_QUEUE_DEPTH) {
    _gitWorker.sheds++;
    state.observedBranches.clear();
    return false;
  }

  state.queued = true;
  state.lastRequestedAt = Date.now();
  state.lastReason = reason;
  _gitWorker.queue.push({
    project: normalizedProject,
    generation: state.generation,
    reason,
    requestedAt: state.lastRequestedAt,
  });
  _gitWorker.maxQueueDepthObserved = Math.max(_gitWorker.maxQueueDepthObserved, _gitWorker.queue.length);
  drainGitWorkerQueue();
  return true;
}

function configureGitEnrichmentWorker({ enabled = true, onDataReady = null } = {}) {
  _gitWorker.enabled = Boolean(enabled);
  _gitWorker.stopping = !_gitWorker.enabled;
  _gitWorker.onDataReady = typeof onDataReady === 'function' ? onDataReady : null;
  if (_gitWorker.enabled) drainGitWorkerQueue();
  return getGitWorkerPerfStats();
}

function shutdownGitEnrichmentWorker() {
  _gitWorker.stopping = true;
  _gitWorker.enabled = false;
  _gitWorker.onDataReady = null;
  _gitWorker.droppedOnShutdown += _gitWorker.queue.length;
  _gitWorker.queue.length = 0;
  for (const timer of _gitWorker.retryTimers.values()) clearTimeout(timer);
  _gitWorker.retryTimers.clear();
  for (const state of _gitWorker.states.values()) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.nextRetryAt = 0;
    state.queued = false;
    state.rerunRequested = false;
  }
  for (const child of _gitWorker.activeChildren) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function getGitWorkerPerfStats() {
  const now = Date.now();
  let staleProjects = 0;
  let maxStaleAgeMs = 0;
  for (const state of _repoScans.values()) {
    if (!state.snapshot) continue;
    const age = Math.max(0, now - Number(state.snapshot.at || now));
    if (age >= GIT_STATUS_CACHE_TTL_MS) staleProjects++;
    maxStaleAgeMs = Math.max(maxStaleAgeMs, age);
  }
  return {
    enabled: _gitWorker.enabled,
    stopping: _gitWorker.stopping,
    maxConcurrency: GIT_WORKER_MAX_CONCURRENCY,
    maxQueueDepth: GIT_WORKER_MAX_QUEUE_DEPTH,
    timeoutMs: GIT_WORKER_TIMEOUT_MS,
    retryBaseMs: GIT_WORKER_RETRY_BASE_MS,
    retryMaxMs: GIT_WORKER_RETRY_MAX_MS,
    activeJobs: _gitWorker.activeJobs,
    activeSubprocesses: _gitWorker.activeChildren.size,
    queueDepth: _gitWorker.queue.length,
    stateCount: _gitWorker.states.size,
    requests: _gitWorker.requests,
    refreshes: _gitWorker.refreshes,
    refreshTimeMs: _gitWorker.refreshTimeMs,
    failures: _gitWorker.failures,
    retries: _gitWorker.retries,
    shedCount: _gitWorker.sheds,
    coalescedRequests: _gitWorker.coalesced,
    staleCompletions: _gitWorker.staleCompletions,
    droppedOnShutdown: _gitWorker.droppedOnShutdown,
    callbackErrors: _gitWorker.callbackErrors,
    maxQueueDepthObserved: _gitWorker.maxQueueDepthObserved,
    staleProjects,
    maxStaleAgeMs,
    lastError: _gitWorker.lastError,
    lastErrorAt: _gitWorker.lastErrorAt,
    lastRefreshAt: _gitWorker.lastRefreshAt,
    lastRefreshProject: _gitWorker.lastRefreshProject,
    lastRefreshReason: _gitWorker.lastRefreshReason,
  };
}

function recordGitEnrichment(label, projectCount, fn) {
  const disabled = isGitEnrichmentDisabled();
  _perf.disabled = disabled;
  _perf.enrichmentCalls++;
  if (disabled) {
    const run = {
      label,
      disabled: true,
      projectCount: Number(projectCount) || 0,
      elapsed: 0,
      ts: Date.now(),
    };
    _perf.lastRun = run;
    _perf.recentRuns.push(run);
    while (_perf.recentRuns.length > 25) _perf.recentRuns.shift();
    return null;
  }

  const start = Date.now();
  const beforeCommands = _perf.gitCommandCount;
  const beforeErrors = _perf.gitCommandErrors;
  const beforeTimeouts = _perf.gitCommandTimeouts;
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - start;
    _perf.enrichmentTimeMs += elapsed;
    _perf.projectsScanned += Number(projectCount) || 0;
    const run = {
      label,
      disabled: false,
      projectCount: Number(projectCount) || 0,
      elapsed,
      gitCommands: _perf.gitCommandCount - beforeCommands,
      errors: _perf.gitCommandErrors - beforeErrors,
      timeouts: _perf.gitCommandTimeouts - beforeTimeouts,
      ts: Date.now(),
    };
    _perf.lastRun = run;
    _perf.recentRuns.push(run);
    while (_perf.recentRuns.length > 25) _perf.recentRuns.shift();
  }
}

function getGitEnrichmentPerfStats() {
  const worker = getGitWorkerPerfStats();
  return {
    ..._perf,
    disabled: isGitEnrichmentDisabled(),
    worker,
    workerQueueDepth: worker.queueDepth,
    workerShedCount: worker.shedCount,
    workerActiveJobs: worker.activeJobs,
    repositoryScanCount: _repoScans.size,
    unpushedEventCacheSize: [..._repoScans.values()].filter((state) => state.snapshot).length,
    repoIdentityCacheSize: _repoIdentityCache.size,
    frozenEventCount: _frozenGitEventFields.size,
    unpushedTransitionCacheSize: [..._repoScans.values()].reduce((total, state) => total + (state.lists?.size || 0), 0),
    trackingProjectCount: _gitTrackingLastSeen.size,
    trackingProjectLimit: GIT_TRACKING_MAX_PROJECTS,
    remoteRefScanEntryLimit: GIT_REMOTE_REF_SCAN_MAX_ENTRIES,
    remoteRefScanDepthLimit: GIT_REMOTE_REF_SCAN_MAX_DEPTH,
  };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function parseTimestamp(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractCommand(value, depth = 0) {
  if (!value || depth > 4) return null;
  const parsed = tryParseJson(value);

  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.command === 'string') return parsed.command;
    if (typeof parsed.cmd === 'string') return parsed.cmd;

    for (const key of ['input', 'arguments', 'args', 'payload', 'data']) {
      const command = extractCommand(parsed[key], depth + 1);
      if (command) return command;
    }
  }

  return null;
}
const OUTPUT_FIELD_KEYS = new Set([
  'aggregated_output',
  'content',
  'message',
  'output',
  'result',
  'stderr',
  'stdout',
  'text',
  'tool_result',
  'toolUseResult',
]);

function collectOutputStrings(value, parts, depth = 0, active = false) {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    if (active && value.trim()) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputStrings(item, parts, depth + 1, active);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key || '');
    if (/^(?:command|cmd|input|arguments|args)$/i.test(normalizedKey)) continue;
    const childIsOutput = active
      || OUTPUT_FIELD_KEYS.has(normalizedKey)
      || /(?:output|result|stdout|stderr)/i.test(normalizedKey);
    collectOutputStrings(child, parts, depth + 1, childIsOutput);
  }
}

function extractToolOutput(value, { direct = false } = {}) {
  const parts = [];
  collectOutputStrings(tryParseJson(value), parts, 0, direct);
  return [...new Set(parts)].join('\n').slice(0, 64 * 1024);
}

// ─── Shell command parsing ──────────────────────────────────────────
//
// A tool call's command is a small shell script. It is parsed into simple
// commands with the connector that follows each one (`&&`, `||`, `;`, `|`,
// `&`), subshell boundaries, `cd` / `git -C` working directories and wrapper
// prefixes. Heredoc bodies are removed first: their lines are data, never
// commands.

const HEREDOC_PLACEHOLDER_RE = /<<__CV_HEREDOC_(\d+)__/g;
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

function stripHeredocs(command) {
  const bodies = [];
  const pending = [];
  let out = '';
  let quote = null;
  // `$(` opened inside double quotes: the `-m "$(cat <<'EOF' … EOF)"` idiom.
  let substitutionDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") {
      out += ch + (command[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\n' && pending.length) {
      out += ch;
      let cursor = i + 1;
      for (const heredoc of pending) {
        const lines = [];
        let closed = false;
        while (cursor < command.length) {
          const end = command.indexOf('\n', cursor);
          const line = command.slice(cursor, end === -1 ? command.length : end);
          cursor = end === -1 ? command.length : end + 1;
          if (line.trim() === heredoc.delimiter) {
            closed = true;
            break;
          }
          lines.push(line);
        }
        bodies[heredoc.index] = lines.join('\n');
        if (!closed) break;
      }
      pending.length = 0;
      i = cursor - 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '$' && command[i + 1] === '(') {
        substitutionDepth++;
        out += '$(';
        i++;
        continue;
      }
      if (ch === ')' && substitutionDepth > 0) substitutionDepth--;
      else if (ch === '"' && substitutionDepth === 0) quote = null;
      if (!(ch === '<' && substitutionDepth > 0)) {
        out += ch;
        continue;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const match = /^<<[-~]?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(command.slice(i));
      if (match) {
        const index = bodies.length;
        bodies.push('');
        pending.push({ delimiter: match[1] ?? match[2] ?? match[3], index });
        out += `<<__CV_HEREDOC_${index}__`;
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return { text: out, bodies };
}

function heredocIndexes(text) {
  return [...String(text || '').matchAll(HEREDOC_PLACEHOLDER_RE)].map((match) => Number(match[1]));
}

function displayCommand(text) {
  return String(text || '').replace(HEREDOC_PLACEHOLDER_RE, '<<EOF');
}

// Simple commands with their trailing connector, plus `(`/`)` subshell
// markers. A backslash-newline is whitespace; `#` starts a comment.
function splitShellItems(text) {
  const items = [];
  let current = '';
  let quote = null;
  let substitution = 0;
  const flush = (next) => {
    const trimmed = current.trim();
    current = '';
    if (trimmed) {
      items.push({ kind: 'command', text: trimmed, next });
      return;
    }
    const last = items[items.length - 1];
    if (next && last?.kind === 'close' && !last.next) last.next = next;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\') {
      if (next === '\n') current += ' ';
      else current += ch + (next ?? '');
      i++;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '$' && next === '(') {
      substitution++;
      current += '$(';
      i++;
      continue;
    }
    if (substitution > 0) {
      if (ch === '(') substitution++;
      else if (ch === ')') substitution--;
      current += ch;
      continue;
    }
    if (ch === '#' && (!current || /\s$/.test(current))) {
      const end = text.indexOf('\n', i);
      i = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (ch === '(' && !current.trim()) {
      flush(null);
      items.push({ kind: 'open' });
      continue;
    }
    if (ch === ')') {
      flush(null);
      items.push({ kind: 'close', next: null });
      continue;
    }
    if (ch === '&' && next === '&') {
      flush('&&');
      i++;
      continue;
    }
    if (ch === '|' && next === '|') {
      flush('||');
      i++;
      continue;
    }
    if (ch === '|') {
      if (next === '&') i++;
      flush('|');
      continue;
    }
    if (ch === ';') {
      if (next === ';') i++;
      flush(';');
      continue;
    }
    if (ch === '\n') {
      flush(';');
      continue;
    }
    if (ch === '&') {
      // `2>&1` and `&>file` are redirections, not background jobs.
      if (/[<>]$/.test(current) || next === '>') {
        current += ch;
        continue;
      }
      flush('&');
      continue;
    }
    current += ch;
  }
  flush(null);
  return items;
}

const REDIRECTION_RE = /^(\d*|&)(>>?|<<?<?)(&?)(.*)$/;

function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  let quote = null;
  const flush = () => {
    if (started) tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
    started = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '\\' && quote !== "'") {
      if (i + 1 < segment.length) current += segment[++i];
      started = true;
      quoted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
    started = true;
  }
  flush();

  // Unquoted redirections (`> file`, `2>&1`, `>/dev/null`, `<<EOF`) are not
  // arguments: a push refspec list must never contain `>` or `/dev/null`.
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = token.quoted ? null : REDIRECTION_RE.exec(token.value);
    if (match) {
      if (!match[3] && !match[4]) i++;
      continue;
    }
    values.push(token.value);
  }
  return values;
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

// Index of the command word after env assignments and transparent wrappers
// (`env`, `time`, `timeout`, `command`, `nice`, `sudo`, `nohup`, `exec`), or
// -1 when there is none or the wrapper only looks the command up.
function commandWordIndex(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (isEnvAssignment(token) || token === '{' || token === '!') {
      index++;
      continue;
    }
    switch (path.basename(token)) {
      case 'env':
        index++;
        while (index < tokens.length) {
          const option = tokens[index];
          if (isEnvAssignment(option)) index++;
          else if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) index += 2;
          else if (option.startsWith('-')) index++;
          else break;
        }
        continue;
      case 'time':
        index++;
        while (tokens[index] === '-p') index++;
        continue;
      case 'timeout':
        index++;
        while (index < tokens.length && tokens[index].startsWith('-')) {
          index += ['-s', '--signal', '-k', '--kill-after'].includes(tokens[index]) ? 2 : 1;
        }
        index++;
        continue;
      case 'nice':
        index++;
        while (index < tokens.length && tokens[index].startsWith('-')) {
          index += ['-n', '--adjustment'].includes(tokens[index]) ? 2 : 1;
        }
        continue;
      case 'sudo':
        index++;
        while (index < tokens.length && tokens[index].startsWith('-')) {
          index += /^-[ugpChrtTDR]$/.test(tokens[index]) ? 2 : 1;
        }
        continue;
      case 'command':
        index++;
        if (tokens[index] === '-v' || tokens[index] === '-V') return -1;
        while (tokens[index] === '-p') index++;
        continue;
      case 'nohup':
      case 'exec':
        index++;
        continue;
      default:
        return index;
    }
  }
  return -1;
}

// The inline script of `bash -c '…'` / `sh -lc '…'`, or null.
function shellWrapperScript(tokens, start) {
  let sawC = false;
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '+o') {
      i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token)) {
      if (token.includes('c')) sawC = true;
      continue;
    }
    return sawC ? token : null;
  }
  return null;
}

// A directory the parser cannot know: a shell variable, a command
// substitution, `cd -`, or anything relative to one of those. Events there
// belong to no repository, never to the session's.
const UNKNOWN_DIR = '\u0000unknown-dir';

function resolveShellPath(base, target) {
  const text = String(target ?? '');
  if (!text || /[$`*?]/.test(text)) return null;
  if (text === '~' || text.startsWith('~/')) return path.join(os.homedir(), text.slice(1));
  if (path.isAbsolute(text)) return path.resolve(text);
  if (base === UNKNOWN_DIR) return UNKNOWN_DIR;
  return base ? path.resolve(base, text) : null;
}

// Walks one script level, recording simple commands in order with the
// working directory each one runs in.
// Every segment records the groups it sits in (`( … )`, `{ …; }`, a
// `bash -c` script) so short-circuit evaluation can skip a whole group.
function collectShellSegments(text, cwd, walk, depth = 0, groups = []) {
  const subshells = [];
  const dirStack = [];
  groups = groups.slice();
  const openGroup = () => {
    walk.groupSeq = (walk.groupSeq || 0) + 1;
    groups.push(walk.groupSeq);
  };
  const closeGroup = (next) => {
    groups.pop();
    const last = walk.segments[walk.segments.length - 1];
    if (next && last && !last.next) last.next = next;
  };
  for (const item of splitShellItems(text)) {
    if (item.kind === 'open') {
      subshells.push(cwd);
      openGroup();
      continue;
    }
    if (item.kind === 'close') {
      if (subshells.length) cwd = subshells.pop();
      closeGroup(item.next);
      continue;
    }
    let tokens = tokenizeShellSegment(item.text);
    if (tokens.length === 1 && tokens[0] === '}') {
      closeGroup(item.next);
      continue;
    }
    if (tokens[0] === '{') {
      openGroup();
      tokens = tokens.slice(1);
      if (!tokens.length) continue;
    }
    const start = commandWordIndex(tokens);
    const segment = { text: item.text, next: item.next, cwd, tokens, start, word: start >= 0 ? path.basename(tokens[start]) : '', groups: groups.slice() };
    if (segment.word === 'cd' || segment.word === 'pushd') {
      const target = tokens.slice(start + 1).find((token) => !token.startsWith('-') || token === '-');
      const resolved = target === undefined ? os.homedir() : (target === '-' ? null : resolveShellPath(cwd, target));
      if (segment.word === 'pushd') dirStack.push(cwd);
      cwd = resolved || UNKNOWN_DIR;
      walk.segments.push(segment);
      continue;
    }
    if (segment.word === 'popd') {
      if (dirStack.length) cwd = dirStack.pop();
      walk.segments.push(segment);
      continue;
    }
    if (SHELL_WRAPPERS.has(segment.word) && depth < 3) {
      const script = shellWrapperScript(tokens, start);
      if (script !== null) {
        const before = walk.segments.length;
        walk.groupSeq = (walk.groupSeq || 0) + 1;
        collectShellSegments(script, cwd, walk, depth + 1, [...groups, walk.groupSeq]);
        if (walk.segments.length > before) {
          // The wrapper exits with its script's last status.
          walk.segments[walk.segments.length - 1].next = item.next;
          continue;
        }
      }
    }
    walk.segments.push(segment);
  }
}

// `git [global options] <subcommand>`: the subcommand, its index and the
// directory the command runs in after `-C` / `--work-tree`.
function parseGitInvocation(tokens, start, cwd) {
  if (start < 0 || path.basename(tokens[start] || '') !== 'git') return null;
  let dir = cwd;
  let workTree = false;
  // `--git-dir` names the repository; its checkout is the parent of a
  // `.git` directory (an explicit work tree wins).
  const useGitDir = (value) => {
    const gitDir = resolveShellPath(dir, value);
    if (workTree) return;
    if (!gitDir || gitDir === UNKNOWN_DIR) dir = UNKNOWN_DIR;
    else dir = path.basename(gitDir) === '.git' ? path.dirname(gitDir) : gitDir;
  };
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-C' || token === '--work-tree') {
      const value = tokens[++index];
      if (token === '-C' && value === '') continue;
      dir = resolveShellPath(dir, value) || UNKNOWN_DIR;
      if (token === '--work-tree') workTree = true;
      continue;
    }
    if (token.startsWith('--work-tree=')) {
      dir = resolveShellPath(dir, token.slice('--work-tree='.length)) || UNKNOWN_DIR;
      workTree = true;
      continue;
    }
    if (token === '--git-dir') {
      useGitDir(tokens[++index]);
      continue;
    }
    if (token.startsWith('--git-dir=')) {
      useGitDir(token.slice('--git-dir='.length));
      continue;
    }
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return { subcommand: token, subcommandIndex: index, dir };
  }
  return null;
}

// Flags, option values and positionals of a git subcommand. Option values are
// consumed (`-m "--dry-run"` is a message, not a flag), clusters like `-am`
// are expanded, and everything after `--` is positional.
function scanSubcommandArgs(tokens, subcommandIndex, { shortWithValue = '', longWithValue = new Set() } = {}) {
  const flags = new Set();
  const values = new Map();
  const positionals = [];
  const addValue = (flag, value) => {
    flags.add(flag);
    if (!values.has(flag)) values.set(flag, []);
    values.get(flag).push(value);
  };
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) addValue(token.slice(0, eq), token.slice(eq + 1));
      else if (longWithValue.has(token)) addValue(token, tokens[++i] ?? '');
      else flags.add(token);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let c = 1; c < token.length; c++) {
        const flag = `-${token[c]}`;
        if (shortWithValue.includes(token[c])) {
          const rest = token.slice(c + 1);
          addValue(flag, rest || (tokens[++i] ?? ''));
          break;
        }
        flags.add(flag);
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, values, positionals };
}

const COMMIT_ARG_SPEC = {
  shortWithValue: 'mFCct',
  longWithValue: new Set([
    '--message', '--file', '--reuse-message', '--reedit-message', '--author', '--date',
    '--cleanup', '--fixup', '--squash', '--template', '--trailer', '--pathspec-from-file',
  ]),
};
const PUSH_ARG_SPEC = {
  shortWithValue: 'o',
  longWithValue: new Set(['--push-option', '--receive-pack', '--exec', '--repo']),
};
const PULL_FETCH_ARG_SPEC = {
  shortWithValue: 'ojXs',
  longWithValue: new Set([
    '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--jobs', '--upload-pack',
    '--server-option', '--refmap', '--negotiation-tip', '--strategy', '--strategy-option',
    '--recurse-submodules-default',
  ]),
};
const COMMIT_STATUS_MODES = ['--dry-run', '--short', '--porcelain', '--long'];
const GIT_PULL_FETCH_TRACKED_FLAGS = ['--all', '--prune', '--tags'];

function isHelpFlag(scan) {
  return scan.flags.has('-h') || scan.flags.has('--help');
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}
const SECRET_ASSIGNMENT_RE = /(^|[\s?&,;])(?:--)?(?:key|token)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|,]*)/gi;
const SECRET_TOKEN_RE = /[A-Za-z0-9_-]{32,}/g;

// Credentials of any length: URL userinfo (`https://user:pass@host`,
// `https://token@host`), auth headers, provider token shapes, and
// `*TOKEN=` / `*PASSWORD=` / `*SECRET=` style assignments.
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const AUTH_HEADER_RE = /(authorization:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi;
// Full-length provider token formats, standalone only: `feature/ghp_cache`
// is a branch name, not a token.
const PROVIDER_TOKEN_RE = /(?<![A-Za-z0-9_./-])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|glpat-[A-Za-z0-9_-]{20}|xox[abprs]-[A-Za-z0-9-]{10,})(?![A-Za-z0-9_])/g;
const CREDENTIAL_ASSIGNMENT_RE = /\b([A-Za-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s'";&|,]+)/gi;

function scrubCredentials(value) {
  return String(value ?? '')
    .replace(URL_USERINFO_RE, '$1[redacted]@')
    .replace(AUTH_HEADER_RE, '$1[redacted]')
    .replace(PROVIDER_TOKEN_RE, '[redacted]')
    .replace(CREDENTIAL_ASSIGNMENT_RE, '$1$2[redacted]');
}

// Identity fields are names, never credentials: redacting them would merge
// distinct branches, refs or paths. Free text and remotes are scrubbed.
const IDENTITY_FIELDS = new Set([
  'id', 'sha', 'commandHash', 'sessionId', 'sourceId', 'project', 'repoRoot', 'checkout', 'cwd', 'path', 'name',
  'branch', 'branches', 'src', 'dst', 'tag', 'targetRef', 'refspec', 'refspecs', 'upstream', 'comparisonRef',
  'oldShas', 'landedShas', 'oldSha', 'newSha', 'oldIds', 'type', 'source', 'provider', 'attribution', 'status',
]);

// Every string a git event carries leaves through here.
function scrubEventStrings(value, key = '') {
  if (typeof value === 'string') {
    return IDENTITY_FIELDS.has(key) ? value : scrubCredentials(value);
  }
  if (Array.isArray(value)) return value.map((item) => scrubEventStrings(item, key));
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) value[childKey] = scrubEventStrings(child, childKey);
  }
  return value;
}

function stripSecrets(value) {
  return scrubCredentials(value)
    .replace(SECRET_ASSIGNMENT_RE, '$1')
    .replace(SECRET_TOKEN_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function isForgeEventType(type) {
  return GH_EVENT_TYPES.has(String(type || '').toLowerCase());
}

function normalizeForgeUrl(value, type) {
  let candidate = String(value || '').trim().replace(/[),.;!?]+$/g, '');
  if (!candidate || stripSecrets(candidate) !== candidate) return null;

  const route = type === 'pr'
    ? /\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/i
    : type === 'issue'
      ? /\/[^/\s]+\/[^/\s]+\/issues\/\d+\/?$/i
      : /\/[^/\s]+\/[^/\s]+\/releases\/tag\/[^/\s?#]+\/?$/i;
  if (!/^https?:\/\/(?:www\.)?github\.com\//i.test(candidate) || !route.test(candidate)) return null;
  return candidate;
}

function forgeUrlsByType(output) {
  const urls = new Map();
  const text = String(output || '');
  const matches = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s<>"'`]+/gi) || [];
  for (const match of matches) {
    for (const type of GH_EVENT_TYPES) {
      const url = normalizeForgeUrl(match, type);
      if (!url) continue;
      const values = urls.get(type) || [];
      if (!values.includes(url)) values.push(url);
      urls.set(type, values);
      break;
    }
  }
  return urls;
}

function findGhCommand(tokens) {
  let index = 0;
  if (tokens[index] !== 'gh') return null;

  index++;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return null;
    if (GH_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=') || token.startsWith('--config=')) {
      index++;
      continue;
    }
    if (token.startsWith('-')) {
      index++;
      continue;
    }

    const type = String(token).toLowerCase();
    if (!GH_EVENT_TYPES.has(type)) return null;
    index++;
    while (index < tokens.length) {
      const actionToken = tokens[index];
      if (actionToken === '--') return null;
      if (GH_GLOBAL_FLAGS_WITH_VALUE.has(actionToken)) {
        index += 2;
        continue;
      }
      if (actionToken.startsWith('-')) {
        index++;
        continue;
      }

      const action = String(actionToken).toLowerCase();
      if (!GH_EVENT_COMMANDS[type]?.has(action)) return null;
      return { type, action, actionIndex: index };
    }
  }

  return null;
}

function normalizeRefName(ref) {
  const text = String(ref || '').trim();
  if (!text) return null;

  const withoutForce = text.startsWith('+') ? text.slice(1) : text;
  const target = withoutForce.includes(':')
    ? withoutForce.slice(withoutForce.lastIndexOf(':') + 1)
    : withoutForce;
  if (!target) return null;

  return target
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '');
}

// The tag a `git tag [-a|-s] [-m msg] <name> [<commit>]` segment creates, or
// null (a list/delete/verify form).
function createdTagName(tokens, subcommandIndex) {
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') return tokens[i + 1] || null;
    if (GIT_TAG_NON_CREATE_FLAGS.has(token) || token.startsWith('--list=') || token.startsWith('--contains')
      || token.startsWith('--no-contains') || token.startsWith('--points-at') || token.startsWith('--merged')
      || token.startsWith('--no-merged')) return null;
    if (GIT_TAG_FLAGS_WITH_VALUE.has(token) || /^-[a-zA-Z]*[mFu]$/.test(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

function clampConfidence(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function capText(value, limit) {
  const text = String(value || '');
  return text.length > limit ? text.slice(text.length - limit) : text;
}

// ─── Command output evidence ────────────────────────────────────────

const COMMIT_OUTPUT_RE = /^\[([^\]\n]+?) ([0-9a-f]{7,40})\] ?(.*)$/gm;
const NOTHING_TO_COMMIT_RE = /nothing to commit|no changes added to commit|nothing added to commit/i;
const PUSH_REF_LINE_RE = /^\s*([+*=!-])?\s*(\[[^\]]+\]|[0-9a-f]{4,40}\.\.\.?[0-9a-f]{4,40})\s+(\S+)\s+->\s+(\S+)(?:\s+\((.+)\))?\s*$/;
const PUSH_DELETED_LINE_RE = /^\s*-\s+\[deleted\]\s+(\S+)/;
const PUSH_RELEVANT_LINE_RE = /^(?:To \S|\s*[+*=!-]?\s*(?:\[[^\]]+\]|[0-9a-f]{4,40}\.\.)|error:|fatal:|hint:|remote:|Everything up-to-date|Updates were rejected|branch '.*' set up to track)/i;
const PUSH_FAILURE_LINE_RE = /^(?:fatal:|error:|ERROR:)|Permission denied|Could not read from remote repository|Authentication failed/;

function commitOutputLines(output) {
  return [...String(output || '').matchAll(COMMIT_OUTPUT_RE)].map((match) => {
    const head = match[1].replace(/\s*\(root-commit\)\s*/, '').trim();
    const detached = head === 'detached HEAD';
    return {
      branch: detached ? '' : head,
      detached,
      sha: match[2].toLowerCase(),
      subject: match[3].trim(),
    };
  });
}

function pushOutputRefs(output) {
  const refs = [];
  let upToDate = false;
  for (const line of String(output || '').split('\n')) {
    if (/Everything up-to-date/.test(line)) upToDate = true;
    const deleted = PUSH_DELETED_LINE_RE.exec(line);
    if (deleted) {
      refs.push({ from: '', to: shortRefName(deleted[1]), status: 'ok' });
      continue;
    }
    const match = PUSH_REF_LINE_RE.exec(line);
    if (!match) continue;
    const flag = match[1] || ' ';
    const summary = match[2];
    const sha = /\.\.\.?([0-9a-f]+)$/.exec(summary)?.[1];
    refs.push({
      from: shortRefName(match[3]),
      to: shortRefName(match[4]),
      status: flag === '!' ? 'rejected' : (flag === '=' || /up to date/i.test(summary) ? 'up-to-date' : 'ok'),
      sha: sha || undefined,
      reason: match[5] || null,
      line: line.trim(),
    });
  }
  return { refs, upToDate };
}

function shortRefName(ref) {
  return String(ref || '').replace(/^refs\/(?:heads|tags)\//, '');
}

function pushRelevantLines(output) {
  return String(output || '').split('\n').filter((line) => PUSH_RELEVANT_LINE_RE.test(line));
}

function firstReasonLine(lines) {
  const line = lines.find((candidate) => /^\s*!/.test(candidate))
    || lines.find((candidate) => PUSH_FAILURE_LINE_RE.test(candidate))
    || lines.find((candidate) => candidate.trim());
  if (!line) return null;
  const text = stripSecrets(line);
  return text.length > GIT_EVENT_REASON_MAX_CHARS ? `${text.slice(0, GIT_EVENT_REASON_MAX_CHARS - 1)}…` : text;
}

// ─── Event identity and frozen observation state ────────────────────

// Repository state read at observation time (HEAD branch, worktree identity,
// tag existence) is frozen by event id: re-parsing a transcript never
// re-labels an event because HEAD moved since.
const _frozenGitEventFields = new Map();

function frozenFields(id) {
  return _frozenGitEventFields.get(id) || null;
}

function freezeFields(id, fields) {
  const existing = _frozenGitEventFields.get(id);
  const value = existing ? { ...existing, ...fields } : fields;
  _frozenGitEventFields.delete(id);
  _frozenGitEventFields.set(id, value);
  while (_frozenGitEventFields.size > GIT_FROZEN_EVENT_MAX) {
    _frozenGitEventFields.delete(_frozenGitEventFields.keys().next().value);
  }
  return value;
}

function gitEventIdentity(type, commandHash, context, segmentIndex) {
  const parts = [
    context.provider || 'unknown',
    context.sessionId || null,
    context.sourceId || null,
    normalizeProjectPath(context.project),
    parseTimestamp(context.ts),
    type,
    commandHash,
  ];
  if (segmentIndex > 0) parts.push(`#${segmentIndex}`);
  return parts.filter(Boolean).join('|');
}

function checkoutKey(dir) {
  return resolveRepoIdentity(dir)?.checkout || dir || '';
}

// The branch a `git switch` / `git checkout` segment moves HEAD to, or null
// when it is a path checkout or cannot be told.
function switchTarget(tokens, git) {
  const isSwitch = git.subcommand === 'switch';
  const scan = scanSubcommandArgs(tokens, git.subcommandIndex, isSwitch
    ? { shortWithValue: 'cC', longWithValue: new Set(['--create', '--force-create', '--orphan']) }
    : { shortWithValue: 'bB', longWithValue: new Set(['--orphan']) });
  if (isHelpFlag(scan)) return null;
  for (const flag of isSwitch ? ['-c', '-C', '--create', '--force-create', '--orphan'] : ['-b', '-B', '--orphan']) {
    const value = scan.values.get(flag)?.[0];
    if (value) return { branch: shortRefName(value), detached: false };
  }
  if (scan.flags.has('--detach') || (isSwitch && scan.flags.has('-d'))) return { branch: '', detached: true };
  const name = scan.positionals[0];
  if (!name || name === '-' || (!isSwitch && (scan.positionals.length !== 1 || tokens.includes('--')))) return null;
  if (isSwitch) return { branch: shortRefName(name), detached: false };
  const identity = resolveRepoIdentity(git.dir);
  return identity && repoHasRef(identity.commonDir, `refs/heads/${shortRefName(name)}`)
    ? { branch: shortRefName(name), detached: false }
    : null;
}

function observationState(cwd, { branchHint = null, switchedHead = null, tagNames = [] } = {}) {
  // A directory that does not exist (or is unknown) names no repository,
  // even inside one: the command could not have run there.
  const identity = cwd && cwd !== UNKNOWN_DIR && fs.existsSync(cwd) ? resolveRepoIdentity(cwd) : null;
  const head = identity ? readHeadState(identity.gitDir) : null;
  let headBranch = head?.branch || '';
  let detached = head?.detached === true;
  if (switchedHead) {
    headBranch = switchedHead.branch;
    detached = switchedHead.detached;
  } else if (branchHint && branchHint !== 'HEAD') {
    headBranch = branchHint;
    detached = false;
  }
  return {
    repoRoot: identity?.repoRoot || null,
    checkout: identity?.checkout || null,
    worktree: identity?.worktree || null,
    headBranch,
    detached,
    tags: identity ? tagNames.filter((name) => repoHasTag(identity, name)) : [],
  };
}

function applyIdentityFields(event, state, cwd) {
  if (cwd && cwd !== UNKNOWN_DIR) event.cwd = cwd;
  if (!state.repoRoot) event.unresolved = true;
  if (state.repoRoot) event.repoRoot = state.repoRoot;
  if (state.checkout) event.checkout = state.checkout;
  if (state.worktree) event.worktree = { ...state.worktree };
}

function createGitEvent(segmentText, type, dryRun, context, parsed = {}) {
  const forge = isForgeEventType(type);
  const rawNormalized = normalizeCommand(displayCommand(segmentText));
  // Forge command arguments can contain titles, prompts, and credentials.
  // Keep only the executable/action for new event records; Git events retain
  // their existing command field after secret scrubbing.
  const normalized = forge
    ? `gh ${type} ${parsed.action || 'create'}`
    : stripSecrets(rawNormalized);
  const commandHash = parsed.commandHash || stableHash(forge ? stripSecrets(rawNormalized) : normalized);
  const segmentIndex = Number(parsed.segmentIndex) || 0;
  const provider = context.provider || 'unknown';
  const sessionId = context.sessionId || null;
  const sourceId = context.sourceId || null;
  const ts = parseTimestamp(context.ts);
  const project = normalizeProjectPath(context.project);
  const completedAt = parseTimestamp(context.completedAt);
  const confidence = forge
    ? 0.7
    : (parsed.completionKnown ? 0.98 : (parsed.evidence ? 0.92 : 0.85));

  const event = {
    id: parsed.id || `git-${type}-${stableHash(gitEventIdentity(type, commandHash, context, segmentIndex))}`,
    type,
    command: normalized,
    project,
    provider,
    sessionId,
    sourceId,
    // Chained segments get monotonically increasing sub-timestamps so
    // `git push && git commit` keeps the later commit after the push.
    ts: ts ? ts + segmentIndex : ts,
    commandHash,
    dryRun,
    source: context.source || 'command-parser',
    confidence: clampConfidence(context.confidence, confidence),
    inferred: forge || context.inferred === true,
    observed: !forge && context.observed !== false && context.inferred !== true,
  };

  if (forge && parsed.action) event.action = parsed.action;
  if (forge && parsed.url) event.url = parsed.url;
  if (!forge && parsed.state) applyIdentityFields(event, parsed.state, parsed.cwd);
  if (parsed.targetRef) event.targetRef = parsed.targetRef;
  if (parsed.refspec) event.refspec = parsed.refspec;
  if (Array.isArray(parsed.refspecs) && parsed.refspecs.length) event.refspecs = parsed.refspecs;
  if (parsed.branch) event.branch = parsed.branch;
  if (parsed.detached) event.detached = true;
  if (parsed.sha) event.sha = parsed.sha;
  if (parsed.label) event.label = parsed.label;
  if (type === 'commit' && !forge) event.attribution = 'observed';
  if (type === 'push') {
    if (Array.isArray(parsed.refs)) event.refs = parsed.refs;
    if (parsed.tag) event.tag = parsed.tag;
    if (parsed.tagsOnly) event.tagsOnly = true;
    if (parsed.force) event.force = parsed.force;
    if (parsed.deleted) event.deleted = true;
    if (parsed.remote) event.remote = parsed.remote;
    if (Array.isArray(parsed.landedShas) && parsed.landedShas.length) {
      event.landedShas = parsed.landedShas.slice(0, GIT_LANDED_SHAS_MAX);
    }
  }
  if (type === 'pull' || type === 'fetch') {
    if (parsed.remote) event.remote = parsed.remote;
    if (Array.isArray(parsed.flags) && parsed.flags.length) event.flags = parsed.flags;
  }
  if (forge) {
    // A forge command's outcome is the call's own (one gh command per call).
    if (typeof context.success === 'boolean') event.success = context.success;
    if (context.exitCode !== null && context.exitCode !== undefined && Number.isFinite(Number(context.exitCode))) {
      event.exitCode = Number(context.exitCode);
    }
  }
  if (typeof parsed.success === 'boolean') event.success = parsed.success;
  if (Number.isFinite(parsed.exitCode)) event.exitCode = parsed.exitCode;
  if (parsed.status) event.status = parsed.status;
  else if (context.status) event.status = context.status;
  if (parsed.reason) event.reason = parsed.reason;
  if (completedAt) event.completedAt = completedAt + segmentIndex;
  if (!forge && parsed.stderr) event.stderr = stripSecrets(capText(parsed.stderr, GIT_EVENT_STDERR_MAX_CHARS));

  return scrubEventStrings(event);
}

function collectParserOutput(context, options) {
  const outputValues = [];
  for (const source of [options, context]) {
    for (const key of [
      'output',
      'stdout',
      'stderr',
      'result',
      'toolOutput',
      'tool_output',
      'toolResult',
      'tool_result',
      'aggregated_output',
    ]) {
      if (source?.[key] !== undefined) outputValues.push(source[key]);
    }
  }
  return [...new Set(outputValues
    .map(value => extractToolOutput(value, { direct: typeof value === 'string' }))
    .filter(Boolean))]
    .join('\n');
}

function callExitStatus(context) {
  if (typeof context.success === 'boolean') return context.success;
  const exitCode = Number(context.exitCode);
  if (context.exitCode !== undefined && context.exitCode !== null && Number.isFinite(exitCode)) return exitCode === 0;
  return null;
}

function commitMessageSubject(scan, bodies) {
  const fromValue = (value) => {
    const text = String(value || '');
    const placeholder = /<<__CV_HEREDOC_(\d+)__/.exec(text);
    const body = placeholder ? bodies[Number(placeholder[1])] : text;
    return String(body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  };
  const message = scan.values.get('-m')?.[0] ?? scan.values.get('--message')?.[0];
  if (message !== undefined) return fromValue(message);
  return '';
}

// Classifies each git segment of one tool call. The call's exit status
// belongs to the segment that ran last: in a trailing `&&` run, segments
// before the failing one succeeded and segments after it never ran. A
// segment's own output (`[branch sha]`, `! [rejected]`) always wins, so
// `|| true` cannot launder a rejection.
const PRESUMED_OK_COMMANDS = new Set(['git', 'cd', 'pushd', 'popd', 'true', 'echo', 'printf', 'export', 'set', ':']);

function chainOutcomes(segments, exit) {
  const count = segments.length;
  let runStart = count - 1;
  while (runStart > 0 && segments[runStart - 1].next === '&&') runStart--;
  let lastOk = runStart - 1;
  let failing = count;
  if (exit === false) {
    for (let i = runStart; i < count; i++) {
      if (segments[i].evidence === 'ok') lastOk = i;
    }
    // Without output evidence, the failure is the first segment that could
    // plausibly fail: shell builtins and git plumbing such as `git add` or
    // `git tag` are presumed to have succeeded.
    failing = lastOk + 1;
    while (failing < count && !segments[failing].candidate && PRESUMED_OK_COMMANDS.has(segments[failing].word)) failing++;
    for (let i = lastOk + 1; i < count; i++) {
      if (['failed', 'rejected', 'nothing'].includes(segments[i].evidence)) {
        failing = i;
        break;
      }
    }
  }
  segments.forEach((segment, index) => {
    if (!segment.candidate) return;
    let status = null;
    let fromExit = false;
    const piped = segment.next === '|';
    if (exit === true && index >= runStart && !piped) {
      status = 'ok';
      fromExit = true;
    } else if (exit === false && index >= runStart) {
      if (index <= lastOk) {
        status = 'ok';
        fromExit = true;
      } else if (index === failing && !piped) {
        status = 'failed';
        fromExit = true;
      } else if (index > failing) {
        status = 'notRun';
      }
    }
    if (segment.evidence && segment.evidence !== 'ok') {
      // The exit code still belongs to the segment that failed with it.
      fromExit = fromExit && status === 'failed';
      status = segment.evidence;
    } else if (segment.evidence === 'ok' && status !== 'ok') {
      status = 'ok';
    }
    segment.outcome = status;
    segment.outcomeFromExit = fromExit;
  });
  applyShortCircuit(segments, segments, 0);
}

const SEGMENT_FAILED = ['failed', 'rejected', 'nothing'];

function segmentStatus(segment) {
  if (segment.evidence === 'ok' || segment.outcome === 'ok') return 'ok';
  if (SEGMENT_FAILED.includes(segment.evidence) || SEGMENT_FAILED.includes(segment.outcome)) return 'fail';
  if (!segment.candidate && segment.word === 'true') return 'ok';
  if (!segment.candidate && segment.word === 'false') return 'fail';
  return 'unknown';
}

// Shell short-circuiting over `&&`/`||` lists, with groups as units: `a || b`
// skips b after a success, `a && b` after a failure, and a skipped unit keeps
// the list's previous status (`a || b && c` still runs c). A skipped unit's
// segments did not run; a unit that only maybe ran cannot take the call's
// exit status as its own. Returns the status of the last executed unit.
function applyShortCircuit(all, segments, depth) {
  const units = [];
  for (const segment of segments) {
    const key = segment.groups?.[depth];
    const last = units[units.length - 1];
    if (key !== undefined && last?.key === key) last.segments.push(segment);
    else units.push({ key, segments: [segment] });
  }
  let status = 'unknown';
  units.forEach((unit, index) => {
    const previous = index > 0 ? units[index - 1].segments.at(-1) : null;
    const connector = previous?.next || null;
    let runs = 'yes';
    // After an unknown status, `&&` keeps the run-level deduction made from
    // the call's exit status; only `||` loses it.
    if (connector === '&&') runs = status === 'fail' ? 'no' : 'yes';
    else if (connector === '||') runs = status === 'fail' ? 'yes' : (status === 'ok' ? 'no' : 'maybe');
    if (unit.segments.some((segment) => segment.evidence)) runs = 'yes';
    if (runs === 'no') {
      for (const segment of unit.segments) {
        if (segment.candidate && !segment.evidence) {
          segment.outcome = 'notRun';
          segment.outcomeFromExit = false;
        }
      }
      return;
    }
    const unitStatus = unit.key === undefined ? segmentStatus(unit.segments[0]) : applyShortCircuit(all, unit.segments, depth + 1);
    if (runs === 'maybe') {
      for (const segment of unit.segments) {
        if (segment.candidate && segment.outcomeFromExit && segment.outcome === 'ok') {
          segment.outcome = null;
          segment.outcomeFromExit = false;
        }
      }
      status = 'unknown';
      return;
    }
    status = unitStatus;
  });
  return status;
}

// A later `git log -1 --oneline` / `git rev-parse HEAD` names a quiet
// commit's sha: a log line must carry the commit's own subject; a lone
// rev-parse sha counts only straight after the commit in an `&&` run.
function followUpCommitLine(segments, commitSegment, subject, output) {
  let followUp = null;
  let chained = true;
  for (let index = commitSegment.index + 1; index < segments.length; index++) {
    chained = chained && segments[index - 1].next === '&&';
    const next = segments[index];
    const git = parseGitInvocation(next.tokens || [], next.start, next.cwd);
    if (git?.subcommand === 'commit') break;
    if (git && ['log', 'show', 'rev-parse'].includes(git.subcommand)) {
      followUp = git.subcommand;
      break;
    }
  }
  if (!followUp) return null;
  const lines = String(output || '').split('\n').map((line) => line.trim());
  if (followUp === 'rev-parse') {
    const shas = lines.filter((line) => /^[0-9a-f]{7,40}$/.test(line));
    return chained && shas.length === 1 ? { branch: '', detached: false, sha: shas[0], subject } : null;
  }
  if (!subject) return null;
  for (const line of lines) {
    const match = /^(?:commit )?([0-9a-f]{7,40})\s+(?:\([^)]*\)\s+)?(.+)$/.exec(line);
    if (match && match[2].trim() === subject) return { branch: '', detached: false, sha: match[1], subject };
  }
  return null;
}

function tagRefName(name) {
  const text = String(name || '');
  return text.startsWith('refs/tags/') ? text : `refs/tags/${shortRefName(text)}`;
}

function pushRefs(scan, { remoteFromFlag, headBranch, createdTags, tagNames }) {
  const refspecs = remoteFromFlag ? scan.positionals : scan.positionals.slice(1);
  const deleteFlag = scan.flags.has('-d') || scan.flags.has('--delete');
  const isTagName = (name) => createdTags.has(name) || tagNames.has(name);
  const refs = [];
  for (let index = 0; index < refspecs.length; index++) {
    const spec = refspecs[index];
    if (spec === 'tag' && refspecs[index + 1]) {
      const name = tagRefName(refspecs[++index]);
      refs.push({ src: name, dst: name, tag: true });
      continue;
    }
    const force = spec.startsWith('+');
    const text = force ? spec.slice(1) : spec;
    const colon = text.indexOf(':');
    const rawSrc = colon >= 0 ? text.slice(0, colon) : text;
    const rawDst = colon >= 0 ? text.slice(colon + 1) : text;
    if (deleteFlag || (colon === 0 && rawDst)) {
      refs.push({ src: '', dst: shortRefName(rawDst || rawSrc), deleted: true });
      continue;
    }
    const tag = rawSrc.startsWith('refs/tags/') || rawDst.startsWith('refs/tags/')
      || (!rawSrc.startsWith('refs/') && isTagName(rawSrc));
    // Tag refs keep their namespace: `refs/tags/feature` never names the
    // `feature` branch.
    let src = rawSrc === 'HEAD' || rawSrc === '@' ? headBranch : shortRefName(rawSrc);
    let dst = colon >= 0 ? shortRefName(rawDst) : src;
    if (tag) {
      if (rawSrc.startsWith('refs/tags/') || isTagName(rawSrc)) src = tagRefName(rawSrc);
      dst = tagRefName(colon >= 0 ? rawDst : rawSrc);
    }
    const ref = { src, dst };
    if (tag) ref.tag = true;
    if (force) ref.force = true;
    refs.push(ref);
  }
  const explicit = refspecs.length > 0;
  const allRefs = scan.flags.has('--all') || scan.flags.has('--branches') || scan.flags.has('--mirror');
  if (!explicit && !allRefs && !scan.flags.has('--tags') && headBranch) {
    refs.push({ src: headBranch, dst: headBranch });
  }
  return { refs, refspecs };
}

function parsePushSegment(segment, git, walk, state) {
  const scan = scanSubcommandArgs(segment.tokens, git.subcommandIndex, PUSH_ARG_SPEC);
  if (isHelpFlag(scan)) return null;
  const dryRun = scan.flags.has('--dry-run') || scan.flags.has('-n');
  const remoteFromFlag = scan.values.has('--repo');
  const { refs, refspecs } = pushRefs(scan, {
    remoteFromFlag,
    headBranch: state.detached ? '' : state.headBranch,
    createdTags: segment.createdTags,
    tagNames: new Set(state.tags),
  });
  let force = null;
  if (scan.flags.has('--force-with-lease')) force = 'lease';
  else if (scan.flags.has('--force-if-includes')) force = 'includes';
  else if (scan.flags.has('-f') || scan.flags.has('--force') || refs.some((ref) => ref.force)) force = true;
  const branchRefs = refs.filter((ref) => !ref.tag);
  const tagRefs = refs.filter((ref) => ref.tag);
  const deleted = refs.length > 0 && refs.every((ref) => ref.deleted);
  const tagsOnly = (branchRefs.length === 0 && (scan.flags.has('--tags') || tagRefs.length > 0));
  const first = branchRefs[0];
  const parsed = {
    dryRun,
    refs: refs.map(({ src, dst, tag }) => (tag ? { src, dst, status: null, tag: true } : { src, dst, status: null })),
    refspec: refspecs[0],
    refspecs,
    remote: remoteFromFlag ? scan.values.get('--repo')[0] : (scan.positionals[0] || null),
    force,
    deleted,
    tagsOnly,
    branch: first ? (first.deleted ? first.dst : first.src) || undefined : undefined,
    targetRef: first ? first.dst : (tagRefs[0] ? shortRefName(tagRefs[0].dst) : undefined),
  };
  if (tagRefs.length === 1) parsed.tag = shortRefName(tagRefs[0].dst);
  return parsed;
}

function pushOutputBlocks(output) {
  const blocks = [];
  for (const line of String(output || '').split('\n')) {
    // A push with nothing to send prints no `To …` header, only this line:
    // it is a block (and an outcome) of its own.
    if (/^To \S/.test(line) || /^Everything up-to-date/.test(line)) blocks.push([line]);
    else if (blocks.length) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((lines) => lines.join('\n'));
}

function pushOutputFor(candidate, blocks, used, output) {
  if (!blocks) return output;
  const refs = candidate.push.refs;
  const matches = (block) => {
    const { refs: lines, upToDate } = pushOutputRefs(block);
    if (!lines.length && upToDate) return true;
    if (!refs.length) return lines.length > 0;
    return refs.some((ref) => lines.some((line) => line.to === shortRefName(ref.dst)));
  };
  const index = blocks.findIndex((block, blockIndex) => !used.has(blockIndex) && matches(block));
  if (index < 0) return '';
  used.add(index);
  return blocks[index];
}

function pushEvidence(parsed, output) {
  const { refs: lines, upToDate } = pushOutputRefs(output);
  let rejected = false;
  let ok = false;
  for (const ref of parsed.refs) {
    const src = shortRefName(ref.src);
    const dst = shortRefName(ref.dst);
    const line = lines.find((candidate) => (candidate.from && (candidate.from === src || candidate.from === 'HEAD') && candidate.to === dst)
      || candidate.to === dst);
    if (line) {
      ref.status = line.status;
      if (line.sha) ref.sha = line.sha;
      if (line.status === 'rejected') rejected = true;
      else ok = true;
    } else if (upToDate) {
      ref.status = 'up-to-date';
      ok = true;
    }
  }
  if (!parsed.refs.length && lines.length) {
    rejected = lines.some((line) => line.status === 'rejected');
    ok = !rejected;
  }
  if (!parsed.refs.length && upToDate) ok = true;
  const relevant = pushRelevantLines(output);
  if (rejected) return { evidence: 'rejected', relevant };
  if (ok) return { evidence: 'ok', relevant };
  if (relevant.some((line) => PUSH_FAILURE_LINE_RE.test(line) || /! \[/.test(line))) {
    return { evidence: /! \[(?:remote )?rejected\]|Updates were rejected/.test(relevant.join('\n')) ? 'rejected' : 'failed', relevant };
  }
  return { evidence: null, relevant };
}

function parseGitEventsFromCommand(command, context = {}, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const output = collectParserOutput(context, options);
  const forgeUrls = forgeUrlsByType(output);
  const forgeUrlIndexes = new Map();
  const ignoreDryRun = options.ignoreDryRun !== false;
  const exit = callExitStatus(context);
  const { text, bodies } = stripHeredocs(command);
  const project = normalizeProjectPath(context.project);
  const initialCwd = typeof context.cwd === 'string' && context.cwd
    ? (resolveShellPath(project, context.cwd.trim()) || UNKNOWN_DIR)
    : project;
  const walk = { segments: [] };
  collectShellSegments(text, initialCwd, walk);

  const createdTags = new Set();
  let branchMoved = false;
  // `git switch feature && git commit …` commits on feature even though HEAD
  // is back on main by the time the transcript is read.
  const branchByCheckout = new Map();
  const commitLines = commitOutputLines(output);
  const usedCommitLines = new Set();

  walk.segments.forEach((segment, segmentIndex) => {
    segment.index = segmentIndex;
    if (segment.start < 0) return;
    if (segment.word === 'gh') {
      const forge = findGhCommand(segment.tokens.slice(segment.start));
      if (!forge || segment.tokens.some((token) => HELP_FLAGS.has(token))) return;
      const dryRun = segment.tokens.some((token) => token === '--dry-run' || token.startsWith('--dry-run='));
      if (dryRun && ignoreDryRun) return;
      segment.candidate = { type: forge.type, forge, dryRun };
      return;
    }
    const git = parseGitInvocation(segment.tokens, segment.start, segment.cwd);
    if (!git) return;
    if (git.subcommand === 'checkout' || git.subcommand === 'switch') {
      branchMoved = true;
      const target = switchTarget(segment.tokens, git);
      if (target) branchByCheckout.set(checkoutKey(git.dir), target);
    }
    if (git.subcommand === 'tag') {
      const tag = createdTagName(segment.tokens, git.subcommandIndex);
      if (tag) createdTags.add(tag);
      return;
    }
    if (!GIT_EVENT_TYPES.has(git.subcommand)) return;
    segment.createdTags = new Set(createdTags);
    segment.git = git;
    segment.branchHintUsable = !branchMoved && git.dir === initialCwd;
    segment.switchedHead = branchByCheckout.get(checkoutKey(git.dir)) || null;
    segment.candidate = { type: git.subcommand };
  });

  const candidates = walk.segments.filter((segment) => segment.candidate);
  for (const segment of candidates) {
    const { type } = segment.candidate;
    if (isForgeEventType(type)) continue;
    const displayText = normalizeCommand(displayCommand(segment.text));
    const commandHash = stableHash(stripSecrets(displayText));
    const id = `git-${type}-${stableHash(gitEventIdentity(type, commandHash, context, segment.index))}`;
    segment.candidate.id = id;
    segment.candidate.commandHash = commandHash;
    let frozen = frozenFields(id);
    if (!frozen?.state) {
      const tagNames = type === 'push'
        ? scanSubcommandArgs(segment.tokens, segment.git.subcommandIndex, PUSH_ARG_SPEC).positionals
        : [];
      const state = observationState(segment.git.dir, {
        branchHint: segment.branchHintUsable ? context.branchHint : null,
        switchedHead: segment.switchedHead,
        tagNames,
      });
      // An unresolved lookup is retried on the next parse: the repository
      // may only exist once a pending `git init` has run.
      frozen = state.repoRoot ? freezeFields(id, { state }) : { ...(frozen || {}), state };
    }
    segment.candidate.state = frozen.state;
    segment.candidate.frozen = frozen;

    if (type === 'commit') {
      const scan = scanSubcommandArgs(segment.tokens, segment.git.subcommandIndex, COMMIT_ARG_SPEC);
      if (isHelpFlag(scan)) {
        segment.candidate = null;
        continue;
      }
      segment.candidate.dryRun = COMMIT_STATUS_MODES.some((flag) => scan.flags.has(flag));
      let subject = commitMessageSubject(scan, bodies);
      const file = scan.values.get('-F')?.[0] ?? scan.values.get('--file')?.[0];
      if (!subject && file === '-') {
        const index = heredocIndexes(segment.text)[0];
        if (index !== undefined) subject = String(bodies[index] || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
      }
      segment.candidate.subject = subject;
    } else if (type === 'push') {
      const parsed = parsePushSegment(segment, segment.git, walk, segment.candidate.state);
      if (!parsed) {
        segment.candidate = null;
        continue;
      }
      segment.candidate.push = parsed;
      segment.candidate.dryRun = parsed.dryRun;
    } else {
      const scan = scanSubcommandArgs(segment.tokens, segment.git.subcommandIndex, PULL_FETCH_ARG_SPEC);
      if (isHelpFlag(scan)) {
        segment.candidate = null;
        continue;
      }
      segment.candidate.dryRun = scan.flags.has('--dry-run');
      const refspecs = scan.positionals.slice(1).filter(Boolean);
      segment.candidate.pullFetch = {
        remote: scan.positionals[0] || null,
        refspecs,
        targetRef: refspecs.map(normalizeRefName).find(Boolean) || null,
        flags: GIT_PULL_FETCH_TRACKED_FLAGS.filter((flag) => scan.flags.has(flag)),
      };
    }
    if (segment.candidate.dryRun && ignoreDryRun) segment.candidate = null;
  }

  // Output evidence, attributed per segment. Several pushes in one call each
  // consume their own `To <remote>` block: one push's success line can never
  // vouch for another.
  const pushCount = walk.segments.filter((segment) => segment.candidate?.type === 'push').length;
  const pushBlocks = pushCount > 1 ? pushOutputBlocks(output) : null;
  const usedPushBlocks = new Set();
  for (const segment of walk.segments) {
    const candidate = segment.candidate;
    if (!candidate || isForgeEventType(candidate.type)) continue;
    if (candidate.type === 'commit') {
      let lineIndex = commitLines.findIndex((line, index) => !usedCommitLines.has(index)
        && candidate.subject && line.subject === candidate.subject);
      if (lineIndex < 0) lineIndex = commitLines.findIndex((_, index) => !usedCommitLines.has(index));
      const follow = lineIndex < 0 ? followUpCommitLine(walk.segments, segment, candidate.subject, output) : null;
      if (lineIndex >= 0) {
        usedCommitLines.add(lineIndex);
        candidate.commitLine = commitLines[lineIndex];
        segment.evidence = 'ok';
      } else if (follow) {
        // `git commit -q … && git log --oneline -1`: the follow-up printed
        // the new commit, so the commit ran and succeeded.
        candidate.commitLine = follow;
        segment.evidence = 'ok';
      } else if (NOTHING_TO_COMMIT_RE.test(output)) {
        segment.evidence = 'nothing';
      }
    } else if (candidate.type === 'push') {
      const evidence = pushEvidence(candidate.push, pushOutputFor(candidate, pushBlocks, usedPushBlocks, output));
      candidate.pushLines = evidence.relevant;
      if (evidence.evidence) segment.evidence = evidence.evidence;
    }
  }
  chainOutcomes(walk.segments, exit);

  const events = [];
  const contextExitCode = Number.isFinite(Number(context.exitCode)) && context.exitCode !== null && context.exitCode !== undefined
    ? Number(context.exitCode)
    : null;
  for (const segment of walk.segments) {
    const candidate = segment.candidate;
    if (!candidate) continue;
    if (isForgeEventType(candidate.type)) {
      const urls = forgeUrls.get(candidate.type) || [];
      const urlIndex = forgeUrlIndexes.get(candidate.type) || 0;
      const parsed = { action: candidate.forge.action, segmentIndex: segment.index };
      if (urls[urlIndex]) parsed.url = urls[urlIndex];
      forgeUrlIndexes.set(candidate.type, urlIndex + 1);
      const forgeContext = { ...context, inferred: true, observed: false };
      events.push(createGitEvent(segment.text, candidate.type, candidate.dryRun, forgeContext, parsed));
      continue;
    }

    const outcome = segment.outcome;
    if (outcome === 'notRun') continue;
    if (candidate.type === 'commit' && ['failed', 'rejected', 'nothing'].includes(outcome)) continue;

    const state = candidate.state;
    const parsed = {
      id: candidate.id,
      commandHash: candidate.commandHash,
      segmentIndex: segment.index,
      state,
      cwd: segment.git.dir,
      completionKnown: exit !== null,
      evidence: Boolean(segment.evidence),
    };
    if (outcome === 'ok') {
      parsed.success = true;
      if (exit !== null) parsed.exitCode = 0;
      if (candidate.type === 'push') parsed.status = 'success';
    } else if (outcome === 'failed' || outcome === 'rejected') {
      parsed.success = false;
      if (segment.outcomeFromExit && contextExitCode !== null) parsed.exitCode = contextExitCode;
      parsed.status = outcome;
    }

    if (candidate.type === 'commit') {
      const line = candidate.commitLine;
      if (line?.detached) parsed.detached = true;
      else if (line?.branch && line.branch !== 'HEAD') parsed.branch = line.branch;
      else if (state.detached) parsed.detached = true;
      else if (state.headBranch) parsed.branch = state.headBranch;
      parsed.sha = line?.sha || candidate.frozen.sha || undefined;
      parsed.label = line?.subject || candidate.subject || undefined;
      parsed.stderr = output;
    } else if (candidate.type === 'push') {
      Object.assign(parsed, candidate.push);
      parsed.stderr = candidate.pushLines.join('\n');
      if (outcome === 'failed' || outcome === 'rejected') parsed.reason = firstReasonLine(candidate.pushLines.length ? candidate.pushLines : output.split('\n'));
      if (outcome === 'rejected') {
        for (const ref of parsed.refs) if (!ref.status) ref.status = 'rejected';
      } else if (outcome === 'failed') {
        for (const ref of parsed.refs) if (!ref.status) ref.status = 'failed';
      }
      if (candidate.frozen.landedShas) parsed.landedShas = candidate.frozen.landedShas;
    } else {
      const pullFetch = candidate.pullFetch;
      parsed.remote = pullFetch.remote;
      parsed.flags = pullFetch.flags;
      parsed.targetRef = pullFetch.targetRef;
      if (pullFetch.refspecs.length) {
        parsed.refspec = pullFetch.refspecs[0];
        parsed.refspecs = pullFetch.refspecs;
      }
      parsed.branch = normalizeRefName(pullFetch.targetRef) || (state.detached ? undefined : state.headBranch) || undefined;
      parsed.stderr = output;
    }
    events.push(createGitEvent(segment.text, candidate.type, candidate.dryRun, context, parsed));
  }

  return dedupeGitEvents(events);
}

function scrubForgeEventOutput(event) {
  const type = String(event?.type || event?.kind || '').toLowerCase();
  if (!isForgeEventType(type)) return;

  if (!event.url) {
    const output = [event.stderr, event.stdout, event.output, event.result]
      .filter(value => typeof value === 'string')
      .join('\n');
    const url = forgeUrlsByType(output).get(type)?.[0];
    if (url) event.url = url;
  } else {
    const url = normalizeForgeUrl(event.url, type);
    if (url) event.url = url;
    else delete event.url;
  }

  // Completion records may temporarily attach stdout/stderr after parsing.
  // Parse the URL above, then discard the provider prose and any credentials.
  for (const field of ['stderr', 'stdout', 'output', 'result']) delete event[field];
}

function dedupeGitEvents(events) {
  const seen = new Set();
  const unique = [];

  for (const event of events) {
    const type = event?.type || event?.kind;
    if (!isForgeEventType(type) && typeof event?.stderr === 'string') {
      event.stderr = stripSecrets(event.stderr);
    }
    scrubForgeEventOutput(event);
    if (!event || !event.id || seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }

  // Adapter scans can contain many old tool records for one repository. Keep
  // the newest forge records without imposing a new limit on Git history.
  const dropped = new Set();
  const forgeCountsByProject = new Map();
  for (let index = unique.length - 1; index >= 0; index--) {
    const event = unique[index];
    const type = event?.type || event?.kind;
    if (!isForgeEventType(type)) continue;
    const project = String(event?.project || '').trim() || '<unknown>';
    const count = forgeCountsByProject.get(project) || 0;
    if (count >= MAX_FORGE_EVENTS_PER_PROJECT) {
      dropped.add(index);
      continue;
    }
    forgeCountsByProject.set(project, count + 1);
  }

  return unique.filter((_, index) => !dropped.has(index));
}

function gitEventWireReference(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';
  let remaining = hash >>> 0;
  for (let index = 0; index < 6; index++) {
    encoded = alphabet[remaining % 64] + encoded;
    remaining = Math.floor(remaining / 64);
  }
  return encoded;
}

/**
 * Replace repeated session git-event objects with payload-level references.
 * Event ids are the normal table keys. A deterministic content suffix keeps
 * two non-identical events with the same id lossless instead of silently
 * merging them. Session references use stable short aliases derived from the
 * sorted full ids, while bitmap rows and repeated-string tables remove JSON
 * field-name overhead without changing the rehydrated event shape.
 */
function compactGitEventsForWire(sessions) {
  if (!Array.isArray(sessions)) {
    return {
      sessions: [],
      gitEventFields: [],
      gitEventStringTables: [],
      gitEventsById: {},
    };
  }

  const gitEventsById = Object.create(null);
  const entriesById = new Map();

  const referenceFor = (event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    const eventId = String(event.id || '').trim();
    let serialized = null;
    const serialize = () => {
      if (serialized === null) serialized = JSON.stringify(event);
      return serialized;
    };
    const baseKey = eventId || `git-event-${stableHash(serialize())}`;
    const existing = entriesById.get(baseKey) || [];
    for (const entry of existing) {
      if (entry.event === event || isDeepStrictEqual(entry.event, event)) return entry.key;
    }

    let key = baseKey;
    if (existing.length > 0) {
      const contentHash = stableHash(serialize());
      key = `${baseKey}~${contentHash}`;
      let suffix = 2;
      while (Object.prototype.hasOwnProperty.call(gitEventsById, key)) {
        key = `${baseKey}~${contentHash}-${suffix++}`;
      }
    }
    gitEventsById[key] = event;
    existing.push({ key, event });
    entriesById.set(baseKey, existing);
    return key;
  };

  const referencedSessions = sessions.map((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
    const references = [];
    for (const event of Array.isArray(session.gitEvents) ? session.gitEvents : []) {
      const reference = referenceFor(event);
      if (reference) references.push(reference);
    }
    return { ...session, gitEvents: references };
  });

  const gitEventIds = Object.keys(gitEventsById).sort();
  const gitEventReferenceById = new Map();
  const usedReferences = new Set();
  for (const id of gitEventIds) {
    const baseReference = gitEventWireReference(id);
    let reference = baseReference;
    let suffix = 2;
    while (usedReferences.has(reference)) reference = `${baseReference}~${suffix++}`;
    usedReferences.add(reference);
    gitEventReferenceById.set(id, reference);
  }
  // Normalize through JSON once so undefined/non-JSON properties have exactly
  // the same semantics as the former direct session payload.
  const events = gitEventIds.map((id) => JSON.parse(JSON.stringify(gitEventsById[id])));
  const gitEventFields = [...new Set(events.flatMap((event) => Object.keys(event)))].sort();
  const gitEventStringTables = [];
  const stringTableByField = new Map();

  for (let fieldIndex = 0; fieldIndex < gitEventFields.length; fieldIndex++) {
    const field = gitEventFields[fieldIndex];
    const values = events
      .filter((event) => Object.prototype.hasOwnProperty.call(event, field))
      .map((event) => event[field]);
    if (!values.length || values.some((value) => typeof value !== 'string')) continue;

    const uniqueValues = [...new Set(values)];
    const indexByValue = new Map(uniqueValues.map((value, index) => [value, index]));
    const rawBytes = values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
    const indexedBytes = Buffer.byteLength(JSON.stringify(uniqueValues))
      + values.reduce((total, value) => total + String(indexByValue.get(value)).length, 0)
      + 10;
    if (indexedBytes >= rawBytes) continue;

    stringTableByField.set(field, indexByValue);
    gitEventStringTables.push([fieldIndex, uniqueValues]);
  }

  const encodedGitEventsById = Object.create(null);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const masks = [];
    for (let start = 0; start < gitEventFields.length; start += 30) {
      let mask = 0;
      for (let offset = 0; offset < 30 && start + offset < gitEventFields.length; offset++) {
        if (Object.prototype.hasOwnProperty.call(event, gitEventFields[start + offset])) {
          mask += 2 ** offset;
        }
      }
      masks.push(mask);
    }

    const row = [masks];
    for (const field of gitEventFields) {
      if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
      const value = event[field];
      row.push(stringTableByField.has(field)
        ? stringTableByField.get(field).get(value)
        : value);
    }
    encodedGitEventsById[gitEventIds[eventIndex]] = row;
  }

  const compactedSessions = referencedSessions.map((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
    return {
      ...session,
      gitEvents: session.gitEvents.map((id) => gitEventReferenceById.get(id)),
    };
  });

  return {
    sessions: compactedSessions,
    gitEventFields,
    gitEventStringTables,
    gitEventsById: encodedGitEventsById,
  };
}

function eventTime(event) {
  return parseTimestamp(event?.completedAt || event?.completed_at || event?.ts || event?.timestamp || event?.time);
}

function eventSha(event) {
  return String(event?.sha || event?.commit || event?.hash || event?.commitSha || event?.revision || '')
    .trim()
    .toLowerCase();
}

function eventBranch(event) {
  return normalizeLocalBranchName(String(event?.branch || event?.targetRef || '')
    .replace(/^refs\/remotes\/[^/]+\//, ''));
}

function eventRepoKey(event) {
  return event?.repoRoot || event?.project || null;
}

function shasMatch(left, right) {
  if (!left || !right) return false;
  if (left.length >= 7 && right.length >= 7) return left.startsWith(right) || right.startsWith(left);
  return left === right;
}

function commitSubjectFromCommand(command) {
  if (!command) return '';
  const { text, bodies } = stripHeredocs(String(command));
  for (const item of splitShellItems(text)) {
    if (item.kind !== 'command') continue;
    const tokens = tokenizeShellSegment(item.text);
    const git = parseGitInvocation(tokens, commandWordIndex(tokens), null);
    if (!git || git.subcommand !== 'commit') continue;
    const subject = commitMessageSubject(scanSubcommandArgs(tokens, git.subcommandIndex, COMMIT_ARG_SPEC), bodies);
    if (subject) return subject;
  }
  return '';
}

function normalizeCommitText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function commitText(event) {
  return normalizeCommitText(
    event?.label || event?.subject || event?.message || commitSubjectFromCommand(event?.command)
  );
}

function eventTimesClose(left, right) {
  if (!left || !right) return false;
  return Math.abs(left - right) <= 120000;
}

function commitTextsEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 18) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function sameCommitEvent(left, right) {
  if (!left || !right || left.type !== 'commit' || right.type !== 'commit') return false;
  if (eventRepoKey(left) !== eventRepoKey(right)) return false;

  const leftSha = eventSha(left);
  const rightSha = eventSha(right);
  if (leftSha && rightSha) return shasMatch(leftSha, rightSha);

  const leftTime = eventTime(left);
  const rightTime = eventTime(right);
  const timesClose = eventTimesClose(leftTime, rightTime);
  if (left.commandHash && right.commandHash && left.commandHash === right.commandHash) {
    return !leftTime || !rightTime || timesClose;
  }

  return timesClose && commitTextsEquivalent(commitText(left), commitText(right));
}

function mergeCommitEvents(observed, inferred) {
  const merged = {
    ...inferred,
    ...observed,
  };
  const observedSha = eventSha(observed);
  const inferredSha = eventSha(inferred);
  // The scan knows the full sha; the observed `[branch abc1234]` line only
  // the short form.
  const sha = inferredSha.length > observedSha.length ? inferredSha : (observedSha || inferredSha);
  if (sha) {
    merged.sha = sha;
    // Keep the sha on later re-parses of the transcript, after the commit
    // has left the unpushed list.
    if (observed.id && sha !== observedSha && observed.observed !== false) freezeFields(observed.id, { sha });
  }
  if (!merged.label && inferred.label) merged.label = inferred.label;
  if (!merged.branch && inferred.branch) merged.branch = inferred.branch;
  if (!merged.targetRef && inferred.targetRef) merged.targetRef = inferred.targetRef;
  if (!merged.upstream && inferred.upstream) merged.upstream = inferred.upstream;
  if (!merged.comparisonRef && inferred.comparisonRef) merged.comparisonRef = inferred.comparisonRef;
  if (!merged.author && inferred.author) merged.author = inferred.author;
  if (!merged.coAuthors && inferred.coAuthors) merged.coAuthors = inferred.coAuthors;
  if (typeof merged.hasUpstream !== 'boolean' && typeof inferred.hasUpstream === 'boolean') {
    merged.hasUpstream = inferred.hasUpstream;
  }
  // Membership from a scan newer than the observation supersedes the
  // branch the observation recorded; incomplete scan evidence only adds.
  if (Array.isArray(inferred.branches) && inferred.scannedAt && inferred.scannedAt >= eventTime(observed)) {
    const complete = inferred.branchesComplete !== false;
    merged.branches = complete
      ? inferred.branches.slice()
      : [...new Set([...inferred.branches, observed.branch].filter(Boolean))];
    if (complete && observed.branch && !merged.branches.includes(observed.branch)) {
      merged.branch = inferred.branch || merged.branches[0] || null;
    }
  }
  if (observed.inferred !== true) merged.inferred = false;
  return merged;
}

function mergeUnpushedGitEvents(observedEvents, inferredEvents) {
  const observed = Array.isArray(observedEvents) ? observedEvents : [];
  const inferred = Array.isArray(inferredEvents) ? inferredEvents : [];
  if (!inferred.length) return dedupeGitEvents(observed);

  const usedInferred = new Set();
  const merged = observed.map((event) => {
    if (event?.type !== 'commit') return event;
    const index = inferred.findIndex((candidate, candidateIndex) => {
      return !usedInferred.has(candidateIndex) && sameCommitEvent(event, candidate);
    });
    if (index === -1) return event;
    usedInferred.add(index);
    return mergeCommitEvents(event, inferred[index]);
  });

  inferred.forEach((event, index) => {
    if (!usedInferred.has(index)) merged.push(event);
  });

  return dedupeGitEvents(merged);
}

function runGit(project, args) {
  if (!project) return '';
  const start = Date.now();
  _perf.gitCommandCount++;
  try {
    return execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (err) {
    _perf.gitCommandErrors++;
    if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || /timed? out|timeout/i.test(err?.message || '')) {
      _perf.gitCommandTimeouts++;
    }
    throw err;
  } finally {
    _perf.gitCommandTimeMs += Date.now() - start;
  }
}

function normalizeLocalBranchName(branch) {
  return String(branch || '').trim().replace(/^refs\/heads\//, '');
}

// ─── Repository scan (one per repoRoot) ─────────────────────────────
//
// One `for-each-ref` lists every local branch with its upstream and every
// remote-tracking ref. A commit is unpushed while no remote-tracking ref
// contains it; one `git log --source <branches> --not --remotes` lists those
// commits for the checked-out and recently committed branches. The log is
// skipped when no tip moved. Commits that leave the list either landed (a
// remote-tracking ref contains the old tip: a push) or were rewritten
// (reset, amend, rebase, deleted branch). Recent `update by push` entries in
// the remote-tracking reflogs give real push times and survive a restart.

const REF_LISTING_FORMAT = '%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)%00%(symref)';
const UNPUSHED_LOG_FORMAT = '%H%x1f%ct%x1f%P%x1f%an%x1f%ae%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1e';
const OBSERVED_PUSH_MATCH_WINDOW_MS = 5 * 60 * 1000;
// A sha-less observed commit made this long before the latest scan should
// have been listed by it.
const SHA_LESS_SCAN_GRACE_MS = 5000;
const MAX_REFLOG_SEEN_ENTRIES = 2000;
const MAX_CONTAINMENT_SHAS_PER_CHECK = 100;
const MAX_CONTAINMENT_ENTRIES = 4000;

function pseudoIdentity(project) {
  const root = normalizeProjectPath(project) || String(project || '');
  return {
    repoRoot: root,
    checkout: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
    worktree: { name: path.basename(root), path: root, isMain: true },
  };
}

function repoScanState(identity) {
  let state = _repoScans.get(identity.repoRoot);
  if (!state) {
    state = {
      repoRoot: identity.repoRoot,
      identity,
      snapshot: null,
      signature: undefined,
      forceRescan: false,
      lists: null,
      commits: null,
      logKey: null,
      scannedAt: 0,
      hasRemotes: false,
      recent: new Map(),
      reflogSeen: new Set(),
      containment: new Map(),
      pendingShas: new Set(),
      observedBranches: new Set(),
      seenBranches: new Set(),
    };
    _repoScans.set(identity.repoRoot, state);
  }
  state.identity = identity;
  return state;
}

function scanCwd(identity) {
  try {
    if (fs.statSync(identity.repoRoot).isDirectory()) return identity.repoRoot;
  } catch { /* fall back to the checkout */ }
  return identity.checkout || identity.repoRoot;
}

function parseRefListing(output) {
  const heads = new Map();
  const remotes = new Map();
  for (const line of String(output || '').split('\n')) {
    const [refname, objectname, upstream, track, date, symref] = line.split('\0');
    if (!refname || !objectname) continue;
    if (refname.startsWith('refs/heads/')) {
      heads.set(refname.slice('refs/heads/'.length), {
        tip: objectname,
        upstream: upstream || '',
        track: track || '',
        date: (Number(date) || 0) * 1000,
      });
    } else if (refname.startsWith('refs/remotes/') && !symref && !refname.endsWith('/HEAD')) {
      remotes.set(refname.slice('refs/remotes/'.length), objectname);
    }
  }
  return { heads, remotes };
}

// Every listed commit's named branches. The listing is closed under
// ancestry (an ancestor outside it is on a remote, and so are its own
// ancestors), so a branch's unpushed commits are exactly those reachable from
// its tip inside the listing. Branches keep scan order: checked-out first.
// Commits on no named branch came from a detached HEAD.
function assignBranchMembership(commits, branchTips, branchSets = null) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  for (const commit of commits) commit.branches = [];
  for (const [name, tip] of branchTips) {
    const stack = bySha.has(tip) ? [tip] : [];
    const seen = new Set();
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = bySha.get(sha);
      commit.branches.push(name);
      for (const parent of commit.parents) if (bySha.has(parent) && !seen.has(parent)) stack.push(parent);
    }
  }
  if (branchSets) {
    const order = branchTips.map(([name]) => name);
    for (const commit of commits) {
      const names = new Set(commit.branches);
      for (const [name, set] of branchSets) if (set.has(commit.sha)) names.add(name);
      commit.branches = order.filter((name) => names.has(name));
    }
  }
  for (const commit of commits) {
    commit.branch = commit.branches[0] || '';
    commit.detached = commit.branches.length === 0;
  }
}

function parseUnpushedLog(output) {
  const commits = [];
  for (const record of String(output || '').split('\x1e')) {
    const [sha, seconds, parents, author, email, subject, trailers] = record.replace(/^\s+/, '').split('\x1f');
    if (!/^[0-9a-f]{40,64}$/.test(sha || '')) continue;
    const ts = Number(seconds) * 1000;
    commits.push({
      sha,
      ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      parents: String(parents || '').split(' ').filter(Boolean),
      author: author ? { name: author, ...(email ? { email } : {}) } : null,
      subject: subject || '',
      coAuthors: String(trailers || '')
        .split('\x1d')
        .map((value) => value.replace(/<[^>]*>/, '').trim())
        .filter(Boolean),
    });
  }
  return commits.reverse();
}

function repoWorktreeHeads(identity) {
  const worktrees = [];
  const main = readHeadState(identity.commonDir);
  if (main && identity.repoRoot !== identity.commonDir) worktrees.push({ path: identity.repoRoot, ...main });
  let names = [];
  try {
    names = fs.readdirSync(path.join(identity.commonDir, 'worktrees'));
  } catch { /* no linked worktrees */ }
  for (const name of names.slice(0, 64)) {
    const dir = path.join(identity.commonDir, 'worktrees', name);
    const head = readHeadState(dir);
    const pointer = readFileSafe(path.join(dir, 'gitdir')).trim();
    if (!head || !pointer) continue;
    worktrees.push({ path: realpathOr(path.dirname(path.resolve(dir, pointer))), ...head });
  }
  return worktrees;
}

function remoteReflogFile(commonDir, remoteRef) {
  return path.join(commonDir, 'logs', 'refs', 'remotes', ...String(remoteRef).split('/'));
}

function remoteReflogEntries(commonDir, remoteRef, since) {
  const file = remoteReflogFile(commonDir, remoteRef);
  try {
    if (fs.statSync(file).mtimeMs < since) return [];
  } catch {
    return [];
  }
  const entries = [];
  for (const line of readTail(file, 16 * 1024).split('\n')) {
    const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d{9,}) [+-]\d{4}\t(.*)$/.exec(line);
    if (!match) continue;
    const ts = Number(match[3]) * 1000;
    if (ts < since) continue;
    entries.push({ old: match[1], next: match[2], ts, push: /^update by push/.test(match[4]) });
  }
  return entries;
}

function scannedCommitEvent(state, commit, meta) {
  const repoRoot = state.repoRoot;
  const id = `git-unpushed-${stableHash(`${repoRoot}:${commit.sha}`)}`;
  // The first named branch seen is frozen; it stays the label while the
  // commit is still on it. A branch-less observation is never frozen, so a
  // detached commit later put on a branch gains its name.
  const frozen = frozenFields(id);
  const branch = frozen?.branch && (commit.branches.includes(frozen.branch) || !commit.branches.length)
    ? frozen.branch
    : commit.branch;
  if (branch && branch !== frozen?.branch) freezeFields(id, { branch });
  const head = meta.heads.get(branch);
  const sameName = meta.remotes.has(`origin/${branch}`) ? `origin/${branch}` : null;
  const upstream = head?.upstream || sameName;
  const worktree = meta.worktreeByBranch.get(branch);
  const event = {
    id,
    type: 'commit',
    command: `git commit ${commit.sha.slice(0, 10)} (${commit.subject || 'unpushed commit'})`,
    project: repoRoot,
    repoRoot,
    provider: 'git',
    sessionId: `git-repo-${stableHash(repoRoot)}`,
    sourceId: 'git-upstream-status',
    source: 'git-upstream-status',
    confidence: 0.72,
    ts: commit.ts,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: commit.ts,
    sha: commit.sha,
    label: commit.subject || commit.sha.slice(0, 10),
    inferred: true,
    observed: false,
    branch: branch || null,
    targetRef: branch || upstream || null,
    upstream: upstream || null,
    comparisonRef: upstream || (meta.hasRemotes ? 'remotes' : meta.defaultLocal),
    hasUpstream: Boolean(upstream),
    attribution: 'scanned',
    // Scan recency, independent of the commit time.
    scanSeq: meta.scanSeq,
    scannedAt: meta.scannedAt,
    branchesComplete: commit.branchesComplete !== false,
  };
  if (commit.branches.length) event.branches = commit.branches.slice();
  if (!branch && commit.detached) event.detached = true;
  if (worktree) {
    event.checkout = worktree.path;
    event.worktree = { name: path.basename(worktree.path), path: worktree.path, isMain: worktree.path === repoRoot };
  }
  if (commit.author) event.author = commit.author;
  if (commit.coAuthors.length) event.coAuthors = commit.coAuthors;
  return scrubEventStrings(event);
}

function transitionPushEvent(state, { branch, targetRef, shas, tip, ts }) {
  const repoRoot = state.repoRoot;
  const id = `git-push-transition-${stableHash([repoRoot, branch || 'HEAD', targetRef || 'upstream', tip].join('|'))}`;
  const dst = String(targetRef || '').replace(/^[^/]+\//, '') || branch || '';
  return {
    id,
    type: 'push',
    command: `git push (${targetRef || 'upstream'} now contains ${branch || 'HEAD'})`,
    project: repoRoot,
    repoRoot,
    provider: 'git',
    sessionId: `git-repo-${stableHash(repoRoot)}`,
    sourceId: 'git-upstream-transition',
    source: 'git-upstream-transition',
    confidence: 0.82,
    ts,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: ts,
    status: 'success',
    targetRef: targetRef || null,
    branch: branch || null,
    label: targetRef ? `Pushed to ${targetRef}` : 'Pushed',
    inferred: true,
    observed: false,
    synthetic: 'transition',
    refs: [{ src: branch || '', dst, status: 'ok', sha: tip }],
    landedShas: shas.slice(-GIT_LANDED_SHAS_MAX),
  };
}

function rewrittenEvent(state, branch, previousList, appeared, now, stamp = { scanSeq: state.scanSeq, scannedAt: state.scannedAt }) {
  const repoRoot = state.repoRoot;
  const oldShas = previousList.map((previous) => previous.sha);
  const used = new Set();
  const replacements = [];
  for (const previous of previousList) {
    const text = normalizeCommitText(previous.label);
    const match = text && appeared.find((event) => !used.has(event.sha) && normalizeCommitText(event.label) === text);
    if (!match) continue;
    used.add(match.sha);
    replacements.push({ oldSha: previous.sha, newSha: match.sha });
  }
  const id = `git-rewritten-${stableHash([repoRoot, branch || 'HEAD', ...oldShas].join('|'))}`;
  const event = {
    id,
    type: 'rewritten',
    command: `git history rewritten (${oldShas.length} commit${oldShas.length === 1 ? '' : 's'} left ${branch || 'HEAD'})`,
    project: repoRoot,
    repoRoot,
    provider: 'git',
    sessionId: `git-repo-${stableHash(repoRoot)}`,
    sourceId: 'git-upstream-status',
    source: 'git-upstream-status',
    confidence: 0.8,
    ts: now,
    completedAt: now,
    commandHash: stableHash(id),
    dryRun: false,
    inferred: true,
    observed: false,
    branch: branch || null,
    oldShas: oldShas.slice(-GIT_LANDED_SHAS_MAX),
    scanSeq: stamp.scanSeq || 0,
    scannedAt: stamp.scannedAt || 0,
    branchesComplete: true,
  };
  if (replacements.length) event.replacements = replacements;
  return event;
}

function recentLandedShas(state) {
  const landed = new Set();
  for (const event of state.recent.values()) {
    for (const sha of event.landedShas || []) landed.add(sha);
  }
  return landed;
}

function expireRecentRepositoryEvents(state, now = Date.now()) {
  const cutoff = now - RECENT_REPOSITORY_PUSH_TTL_MS;
  for (const [id, event] of state.recent) {
    const ts = Number(event?.completedAt || event?.ts || 0);
    if (!Number.isFinite(ts) || ts < cutoff) state.recent.delete(id);
  }
}

// Yields git argument lists and receives each command's stdout (null when it
// failed); shared by the synchronous path and the background worker.
function* scanRepositorySteps(state, { observedBranches = new Set(), now = Date.now() } = {}) {
  const identity = state.identity;
  const listing = yield ['for-each-ref', `--format=${REF_LISTING_FORMAT}`, 'refs/heads', 'refs/remotes'];
  if (listing === null) return { ok: false };
  const { heads, remotes } = parseRefListing(listing);
  const worktrees = repoWorktreeHeads(identity);
  const worktreeByBranch = new Map(worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch, worktree]));
  const hasRemotes = remotes.size > 0;
  const defaultLocal = hasRemotes ? null : (heads.has('main') ? 'main' : (heads.has('master') ? 'master' : null));
  const remoteTips = new Set(remotes.values());
  const eligible = (name) => {
    const head = heads.get(name);
    if (!head) return false;
    if (!hasRemotes) return Boolean(defaultLocal) && name !== defaultLocal;
    if (remoteTips.has(head.tip)) return false;
    if (head.upstream && remotes.has(head.upstream) && !/ahead|gone/.test(head.track)) return false;
    return true;
  };
  const recentBranches = [...heads.entries()]
    .filter(([, head]) => now - head.date <= REPOSITORY_UNPUSHED_EVENT_TTL_MS)
    .sort((left, right) => right[1].date - left[1].date)
    .map(([name]) => name);
  const ordered = [...new Set([
    ...worktrees.map((worktree) => worktree.branch).filter(Boolean),
    ...[...observedBranches].filter(Boolean),
    ...recentBranches,
  ])];
  const eligibleSet = new Set(ordered.filter(eligible));
  const candidates = [...eligibleSet].slice(0, MAX_SCANNED_BRANCHES);
  const candidateSet = new Set(candidates);
  // Detached checkouts carry cargo on no branch; their HEAD is a scan root.
  const detachedTips = hasRemotes
    ? [...new Set(worktrees.filter((worktree) => worktree.detached && worktree.sha && !remoteTips.has(worktree.sha))
      .map((worktree) => worktree.sha))]
    : [];

  const logKey = stableHash(JSON.stringify([
    candidates.map((name) => [name, heads.get(name).tip]),
    detachedTips,
    hasRemotes ? [...remotes.entries()].sort() : [defaultLocal, heads.get(defaultLocal)?.tip],
  ]));
  let commits = state.commits;
  const maxCount = Math.min(MAX_UNPUSHED_COMMITS_PER_SCAN, MAX_UNPUSHED_COMMITS_PER_BRANCH * (candidates.length + detachedTips.length));
  if (logKey !== state.logKey || !commits) {
    if (!candidates.length && !detachedTips.length) {
      commits = [];
    } else {
      const output = yield [
        'log',
        '--source',
        `--max-count=${maxCount}`,
        `--format=${UNPUSHED_LOG_FORMAT}`,
        ...candidates.map((name) => `refs/heads/${name}`),
        ...detachedTips,
        ...(hasRemotes ? ['--not', '--remotes'] : [`^refs/heads/${defaultLocal}`]),
        '--',
      ];
      if (output === null) return { ok: false };
      commits = parseUnpushedLog(output);
    }
    state.scanSaturated = maxCount > 0 && commits.length >= maxCount;
    // A saturated listing may omit a connecting parent, so the parent walk
    // can miss membership: each branch's own unpushed list settles it. Only
    // when the log is re-read, and at most one call per scanned branch.
    state.branchSets = null;
    if (state.scanSaturated && candidates.length > 1) {
      state.branchSets = new Map();
      for (const name of candidates) {
        const listed = yield [
          'rev-list',
          `--max-count=${MAX_UNPUSHED_COMMITS_PER_SCAN}`,
          `refs/heads/${name}`,
          ...(hasRemotes ? ['--not', '--remotes'] : [`^refs/heads/${defaultLocal}`]),
          '--',
        ];
        if (listed !== null) state.branchSets.set(name, new Set(listed.split('\n').filter(Boolean)));
      }
    }
    // Membership a capped or failed per-branch list cannot settle is
    // ambiguous: settle a bounded number of shas with `for-each-ref
    // --contains`; the rest stay incomplete and never lose a branch.
    state.membershipOverrides = new Map();
    state.membershipIncomplete = new Set();
    if (state.scanSaturated) {
      assignBranchMembership(commits, candidates.map((name) => [name, heads.get(name).tip]), state.branchSets);
      const uncertain = state.branchSets
        ? candidates.filter((name) => !state.branchSets.has(name) || state.branchSets.get(name).size >= MAX_UNPUSHED_COMMITS_PER_SCAN)
        : candidates;
      const ambiguous = commits.filter((commit) => uncertain.some((name) => !commit.branches.includes(name)));
      for (const commit of ambiguous.slice(0, MAX_MEMBERSHIP_RESOLUTIONS)) {
        const output = yield ['for-each-ref', `--contains=${commit.sha}`, '--format=%(refname:short)', 'refs/heads/'];
        if (output === null) continue;
        const containing = new Set(output.split('\n').map((line) => line.trim()).filter(Boolean));
        state.membershipOverrides.set(commit.sha, candidates.filter((name) => containing.has(name)));
      }
      for (const commit of ambiguous) {
        if (!state.membershipOverrides.has(commit.sha)) state.membershipIncomplete.add(commit.sha);
      }
    }
  }
  assignBranchMembership(commits, candidates.map((name) => [name, heads.get(name).tip]), state.branchSets);
  for (const commit of commits) {
    commit.branchesComplete = true;
    const override = state.membershipOverrides?.get(commit.sha);
    if (override) {
      commit.branches = override;
    } else if (state.membershipIncomplete?.has(commit.sha)) {
      // Incomplete evidence may add a branch, never remove one.
      const previous = state.lastMembership?.get(commit.sha) || [];
      commit.branches = [...new Set([...commit.branches, ...previous.filter((name) => heads.has(name))])];
      commit.branchesComplete = false;
    }
    commit.branch = commit.branches[0] || '';
    commit.detached = commit.branches.length === 0 && commit.branchesComplete;
  }
  // Wall-clock based so a restarted server always outranks the previous
  // lifetime's sequence (unless the clock moves backwards).
  const scanStamp = { scanSeq: Math.max((state.scanSeq || 0) + 1, Date.now()), scannedAt: now };

  const meta = { heads, remotes, hasRemotes, defaultLocal, worktreeByBranch, ...scanStamp };
  const unpushed = commits.map((commit) => scannedCommitEvent(state, commit, meta));
  const current = new Map(unpushed.map((event) => [event.sha, event]));
  const landedNow = new Set();
  expireRecentRepositoryEvents(state, now);

  if (state.lists) {
    const vanishedByBranch = new Map();
    for (const [sha, previous] of state.lists) {
      if (current.has(sha)) continue;
      // Still listable but outside this scan's branch window: not a change.
      if (eligibleSet.has(previous.branch) && !candidateSet.has(previous.branch)) continue;
      if (!vanishedByBranch.has(previous.branch)) vanishedByBranch.set(previous.branch, []);
      vanishedByBranch.get(previous.branch).push(previous);
    }
    const appeared = unpushed.filter((event) => !state.lists.has(event.sha));
    // Each vanished commit is classified on its own: a remote contains it
    // (landed) or not (rewritten), so one batch can be partly both.
    // A commit that only left a bounded listing (the scan window moved past
    // it) is still on a branch: neither landed nor rewritten.
    const vanished = [...vanishedByBranch.values()].flat().map((previous) => previous.sha);
    const reach = vanished.length
      ? yield* reachabilitySteps(vanished, { hasRemotes, orphans: true })
      : new Map();
    for (const [branch, previousList] of vanishedByBranch) {
      if (!reach) continue;
      const landed = previousList.filter((previous) => reach.get(previous.sha)?.contained);
      const rewritten = previousList.filter((previous) => {
        const entry = reach.get(previous.sha);
        return entry && !entry.contained && (entry.orphaned || entry.missing);
      });
      if (landed.length) {
        const tip = landed[landed.length - 1];
        const output = yield ['for-each-ref', `--contains=${tip.sha}`, '--format=%(refname)', 'refs/remotes/'];
        const refs = String(output || '')
          .split('\n')
          .map((ref) => ref.trim())
          .filter((ref) => ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD'))
          .map((ref) => ref.slice('refs/remotes/'.length));
        const upstream = heads.get(branch)?.upstream;
        const targetRef = [upstream, `origin/${branch}`].find((ref) => ref && refs.includes(ref)) || refs[0] || upstream || null;
        const moved = targetRef ? remoteReflogEntries(identity.commonDir, targetRef, state.scannedAt - 60_000).at(-1) : null;
        const event = transitionPushEvent(state, {
          branch,
          targetRef,
          shas: landed.map((previous) => previous.sha),
          tip: tip.sha,
          ts: moved && moved.ts <= now ? moved.ts : now,
        });
        state.recent.set(event.id, event);
        for (const previous of landed) landedNow.add(previous.sha);
      }
      if (rewritten.length) {
        const event = rewrittenEvent(state, branch, rewritten, appeared.filter((candidate) => candidate.branch === branch), now, scanStamp);
        state.recent.set(event.id, event);
      }
    }
  }

  // Remote-tracking reflogs replay recent pushes on the first scan after a
  // (re)start, when no earlier list can show what left. Later pushes are
  // seen as list transitions, and observed commits pushed between two scans
  // depart through verified containment.
  if (hasRemotes && !state.lists) {
    const since = now - RECENT_REPOSITORY_PUSH_TTL_MS;
    const alreadyLanded = recentLandedShas(state);
    for (const remoteRef of remotes.keys()) {
      for (const entry of remoteReflogEntries(identity.commonDir, remoteRef, since)) {
        if (!entry.push) continue;
        const key = `${remoteRef}:${entry.next}`;
        if (state.reflogSeen.has(key)) continue;
        state.reflogSeen.add(key);
        if (landedNow.has(entry.next) || alreadyLanded.has(entry.next)) continue;
        // A branch's first push (`000…0 → tip`) published what no other
        // remote-tracking ref already had.
        const output = yield /^0+$/.test(entry.old)
          ? ['rev-list', `--max-count=${GIT_LANDED_SHAS_MAX}`, entry.next, '--not', `--exclude=${remoteRef}`, '--remotes']
          : ['rev-list', `--max-count=${GIT_LANDED_SHAS_MAX}`, `${entry.old}..${entry.next}`];
        const shas = String(output || '').split('\n')
          .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha) && !alreadyLanded.has(sha))
          .reverse();
        if (!shas.length) continue;
        const localBranch = [...heads.entries()].find(([, head]) => head.upstream === remoteRef)?.[0]
          || remoteRef.replace(/^[^/]+\//, '');
        const event = transitionPushEvent(state, { branch: localBranch, targetRef: remoteRef, shas, tip: entry.next, ts: entry.ts });
        state.recent.set(event.id, event);
        for (const sha of shas) alreadyLanded.add(sha);
      }
    }
    while (state.reflogSeen.size > MAX_REFLOG_SEEN_ENTRIES) {
      state.reflogSeen.delete(state.reflogSeen.values().next().value);
    }
  }

  state.lists = new Map(unpushed.map((event) => [event.sha, { sha: event.sha, branch: event.branch, label: event.label }]));
  state.lastMembership = new Map(unpushed.map((event) => [event.sha, event.branches || []]));
  state.scanSeq = scanStamp.scanSeq;
  // Branches whose unpushed commits this scan knows completely: the scanned
  // ones, and those a remote already contains (nothing unpushed).
  state.scannedBranches = new Set([...candidateSet, ...[...heads.keys()].filter((name) => !eligible(name))]);
  state.headNames = new Set(heads.keys());
  state.commits = commits;
  state.logKey = logKey;
  state.scannedAt = now;
  state.hasRemotes = hasRemotes;
  return { ok: true, unpushed };
}

// Containment of observed commit shas the scan does not list: one call to
// keep the shas that exist, one to find which of them no remote contains.
// Reachability of a set of shas, in at most three calls: which exist, which
// no remote-tracking ref contains, and (optionally) which no ref, HEAD or
// worktree reaches at all (amended or reset away). Containment is concluded
// only from a complete listing: a capped listing proves nothing.
const REACHABILITY_LIST_CAP = 5000;

function* reachabilitySteps(shas, { hasRemotes, orphans = false }) {
  const result = new Map();
  const pending = [...new Set(shas)].filter(Boolean);
  if (!pending.length) return result;
  const existing = yield ['rev-list', '--ignore-missing', '--no-walk=unsorted', ...pending];
  if (existing === null) return null;
  const full = existing.split('\n').filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  const listed = (output) => {
    const lines = String(output).split('\n').filter(Boolean);
    return { set: new Set(lines), complete: lines.length < REACHABILITY_LIST_CAP };
  };
  let uncontained = null;
  if (hasRemotes && full.length) {
    const output = yield ['rev-list', '--ignore-missing', `--max-count=${REACHABILITY_LIST_CAP}`, ...full, '--not', '--remotes'];
    if (output !== null) uncontained = listed(output);
  }
  let orphaned = null;
  if (orphans && full.length) {
    const output = yield ['rev-list', '--ignore-missing', `--max-count=${REACHABILITY_LIST_CAP}`, ...full, '--not', '--all'];
    if (output !== null) orphaned = listed(output);
  }
  for (const sha of pending) {
    const match = full.find((candidate) => candidate.startsWith(sha)) || null;
    result.set(sha, {
      full: match,
      // The repository has no such object: the observation was a ghost
      // (another repository's output, or a commit that never existed here).
      missing: !match,
      contained: Boolean(match && uncontained?.complete && !uncontained.set.has(match)),
      orphaned: Boolean(match && orphaned?.set.has(match)),
    });
  }
  return result;
}

// Observed commit shas the scan does not list. A failed check records "not
// contained" so a broken repository is not re-asked every poll; a ref change
// clears those entries.
function* containmentSteps(state, shas, now = Date.now()) {
  const pending = [...new Set(shas)].filter(Boolean).slice(0, MAX_CONTAINMENT_SHAS_PER_CHECK);
  if (!pending.length) return;
  const reach = yield* reachabilitySteps(pending, { hasRemotes: state.hasRemotes, orphans: true });
  for (const sha of pending) {
    const entry = reach?.get(sha) || { full: null, missing: false, contained: false, orphaned: false };
    state.containment.delete(sha);
    state.containment.set(sha, { ...entry, at: now });
  }
  while (state.containment.size > MAX_CONTAINMENT_ENTRIES) {
    state.containment.delete(state.containment.keys().next().value);
  }
}

function runStepsSync(cwd, steps) {
  let step = steps.next();
  while (!step.done) {
    let output = null;
    try {
      output = runGit(cwd, step.value);
    } catch {
      output = null;
    }
    step = steps.next(output);
  }
  return step.value;
}

async function runStepsAsync(cwd, steps) {
  let step = steps.next();
  while (!step.done) {
    let output = null;
    try {
      output = await runGitWorkerCommand(cwd, step.value);
    } catch (error) {
      if (
        isGitWorkerTimeout(error)
        || error?.code === 'ENOENT'
        || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ) throw error;
      output = null;
    }
    step = steps.next(output);
  }
  return step.value;
}

function containmentFor(state, sha) {
  if (!sha) return null;
  const direct = state.containment.get(sha);
  if (direct) return direct;
  for (const [key, entry] of state.containment) {
    if (shasMatch(key, sha) || (entry.full && shasMatch(entry.full, sha))) return entry;
  }
  return null;
}

function unpushedShaIndex(unpushed) {
  const index = new Map();
  for (const event of unpushed || []) {
    if (event.sha) index.set(event.sha.slice(0, 7), event.sha);
  }
  return index;
}

function listedSha(index, sha) {
  const full = index.get(String(sha || '').slice(0, 7));
  return Boolean(full && shasMatch(full, sha));
}

// Repositories touched by a set of sessions: each session's own repository
// plus every repository its observed commands ran in (`cd`, `git -C`).
function collectRepositories(sessions, extraProjects) {
  const repos = new Map();
  const identities = new Map();
  const identityOf = (dir) => {
    if (!identities.has(dir)) identities.set(dir, resolveRepoIdentity(dir));
    return identities.get(dir);
  };
  const ensure = (identity) => {
    let info = repos.get(identity.repoRoot);
    if (!info) {
      info = {
        identity,
        branches: new Set(),
        observedCommits: [],
        observedPushes: [],
        watch: false,
      };
      repos.set(identity.repoRoot, info);
    }
    return info;
  };
  const sessionRepos = sessions.map((session) => {
    const roots = new Set();
    const identity = session?.project ? identityOf(session.project) : null;
    if (identity) roots.add(ensure(identity).identity.repoRoot);
    for (const event of Array.isArray(session?.gitEvents) ? session.gitEvents : []) {
      if (!event?.repoRoot || event.observed === false) continue;
      if (event.type !== 'commit' && event.type !== 'push') continue;
      const eventIdentity = identityOf(event.repoRoot);
      if (!eventIdentity || eventIdentity.repoRoot !== event.repoRoot) continue;
      const info = ensure(eventIdentity);
      roots.add(eventIdentity.repoRoot);
      if (event.type === 'commit') {
        info.observedCommits.push(event);
        if (event.branch) info.branches.add(normalizeLocalBranchName(event.branch));
      } else if (event.type === 'push') {
        info.observedPushes.push(event);
      }
    }
    return { identity, roots };
  });
  for (const project of extraProjects) {
    const identity = identityOf(project);
    if (identity) ensure(identity).watch = true;
  }
  return { repos, sessionRepos };
}

function pendingContainmentShas(state, info) {
  const index = unpushedShaIndex(state.snapshot?.unpushed);
  const pending = [];
  for (const commit of info.observedCommits) {
    const sha = eventSha(commit);
    if (!sha || commit.success === false || listedSha(index, sha)) continue;
    if (containmentFor(state, sha)) continue;
    pending.push(sha);
  }
  return pending;
}

// Branches observed commits named stay in the scan window even when old;
// the most recent ones win when a long session names many.
function rememberObservedBranches(state, branches) {
  let unseen = false;
  for (const branch of branches) {
    if (!state.seenBranches.has(branch)) unseen = true;
    state.seenBranches.add(branch);
  }
  while (state.seenBranches.size > 512) state.seenBranches.delete(state.seenBranches.values().next().value);
  for (const branch of branches) {
    state.observedBranches.delete(branch);
    state.observedBranches.add(branch);
  }
  while (state.observedBranches.size > MAX_SCANNED_BRANCHES) {
    state.observedBranches.delete(state.observedBranches.values().next().value);
  }
  return unseen;
}

function refreshRepositorySync(info, now) {
  const state = repoScanState(info.identity);
  const signature = repoStateSignature(info.identity);
  const changed = state.signature !== undefined && signature !== state.signature;
  if (changed) {
    _perf.headInvalidations++;
    for (const [sha, entry] of state.containment) {
      if (!entry.contained) state.containment.delete(sha);
    }
  }
  const unseenBranch = rememberObservedBranches(state, info.branches);
  const stale = !state.snapshot
    || state.forceRescan
    || changed
    || unseenBranch
    || now - state.snapshot.at >= GIT_STATUS_CACHE_TTL_MS;
  const cwd = scanCwd(info.identity);
  if (stale) {
    const result = runStepsSync(cwd, scanRepositorySteps(state, { observedBranches: state.observedBranches, now }));
    state.lastScanFailed = !result?.ok;
    if (result?.ok) {
      state.snapshot = { at: now, generation: 0, unpushed: result.unpushed };
      state.signature = signature;
      state.forceRescan = false;
    }
  } else {
    _perf.cacheHits++;
  }
  if (!state.snapshot) return state;
  const pending = pendingContainmentShas(state, info);
  if (pending.length) runStepsSync(cwd, containmentSteps(state, pending, now));
  return state;
}

function refreshRepositoryAsync(info, now) {
  const state = repoScanState(info.identity);
  const worker = gitWorkerState(state.repoRoot);
  const signature = repoStateSignature(info.identity);
  if (state.signature !== undefined && signature !== state.signature && worker.lastSignatureSeen !== signature) {
    worker.lastSignatureSeen = signature;
    _perf.headInvalidations++;
    noteGitWorkerInvalidation(state.repoRoot);
  }
  for (const sha of state.snapshot ? pendingContainmentShas(state, info) : []) state.pendingShas.add(sha);
  const unseenBranch = [...info.branches].some((branch) => !state.seenBranches.has(branch));
  const needsRefresh = !state.snapshot
    || state.snapshot.generation !== worker.generation
    || now - state.snapshot.at >= GIT_STATUS_CACHE_TTL_MS
    || state.pendingShas.size > 0
    || unseenBranch;
  // Until the refresh lands, the snapshot cannot prove anything is gone.
  state.refreshPending = needsRefresh;
  if (needsRefresh) {
    requestGitWorkerRefresh(state.repoRoot, {
      reason: state.snapshot ? 'stale' : 'initial',
      observedEvents: info.observedCommits,
      force: state.pendingShas.size > 0,
    });
  } else {
    _perf.cacheHits++;
  }
  return state;
}

function pushLaneMatches(push, synthetic) {
  const branch = eventBranch(push);
  if (branch && synthetic.branch === branch) return true;
  const remote = push.remote || 'origin';
  return (push.refs || []).some((ref) => ref?.dst && (
    synthetic.targetRef === `${remote}/${ref.dst}` || synthetic.refs?.[0]?.dst === ref.dst
  ));
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

// Everything one repository contributes to its sessions this poll.
function repositoryContribution(state, info, now) {
  expireRecentRepositoryEvents(state, now);
  const unpushed = state.snapshot?.unpushed || [];
  const recent = [...state.recent.values()].sort((left, right) => eventTime(left) - eventTime(right));
  const absorbed = new Set();
  const pushLanded = new Map();

  // An observed successful push takes the landed shas of the matching
  // transition; the duplicate synthetic departure is dropped.
  for (const push of info.observedPushes) {
    if (push.success !== true || push.tagsOnly || push.deleted) continue;
    const frozen = frozenFields(push.id);
    const landed = new Set(frozen?.landedShas || []);
    // The push output names the pushed tip (`old..new main -> main`); without
    // it, only the transition nearest in time on the same lane matches.
    const pushedTips = (push.refs || []).map((ref) => ref?.sha).filter(Boolean);
    const candidates = recent.filter((synthetic) => synthetic.type === 'push'
      && synthetic.synthetic === 'transition'
      && Math.abs(eventTime(synthetic) - eventTime(push)) <= OBSERVED_PUSH_MATCH_WINDOW_MS
      && pushLaneMatches(push, synthetic));
    const matches = pushedTips.length
      ? candidates.filter((synthetic) => pushedTips.some((tip) => (synthetic.landedShas || []).some((sha) => shasMatch(sha, tip))))
      : candidates.sort((left, right) => Math.abs(eventTime(left) - eventTime(push)) - Math.abs(eventTime(right) - eventTime(push))).slice(0, 1);
    for (const synthetic of matches) {
      absorbed.add(synthetic.id);
      for (const sha of synthetic.landedShas || []) landed.add(sha);
    }
    if (!landed.size) continue;
    const list = [...landed].slice(-GIT_LANDED_SHAS_MAX);
    pushLanded.set(push.id, list);
    if (!sameList(frozen?.landedShas, list)) freezeFields(push.id, { landedShas: list });
  }

  // Observed commits a remote already contains but no departure covers
  // (pushed while the server was down, or before the scan saw them).
  const covered = new Set();
  for (const event of recent) for (const sha of event.landedShas || []) covered.add(sha);
  for (const list of pushLanded.values()) for (const sha of list) covered.add(sha);
  const inferredByBranch = new Map();
  for (const commit of info.observedCommits) {
    const sha = eventSha(commit);
    if (!sha || commit.success === false) continue;
    const entry = containmentFor(state, sha);
    if (!entry?.contained) continue;
    const full = entry.full || sha;
    if ([...covered].some((landed) => shasMatch(landed, full))) continue;
    const branch = eventBranch(commit);
    if (!inferredByBranch.has(branch)) inferredByBranch.set(branch, []);
    inferredByBranch.get(branch).push({ commit, full });
  }
  const inferred = [];
  for (const [branch, entries] of inferredByBranch) {
    const shas = [...new Set(entries.map((entry) => entry.full))];
    const ts = Math.max(...entries.map((entry) => eventTime(entry.commit) || 0)) || now;
    const id = `git-push-inferred-${stableHash([state.repoRoot, branch || 'HEAD', ...[...shas].sort()].join('|'))}`;
    inferred.push({
      id,
      type: 'push',
      command: `git push (a remote already contains ${shas.length} commit${shas.length === 1 ? '' : 's'})`,
      project: state.repoRoot,
      repoRoot: state.repoRoot,
      provider: entries[0].commit.provider,
      sessionId: entries[0].commit.sessionId,
      sourceId: 'git-upstream-status',
      source: 'git-upstream-status',
      confidence: 0.76,
      ts,
      commandHash: stableHash(id),
      dryRun: false,
      success: true,
      exitCode: 0,
      completedAt: ts,
      status: 'success',
      branch: branch || null,
      targetRef: branch || null,
      label: 'Pushed',
      inferred: true,
      observed: false,
      synthetic: 'inferred',
      landedShas: shas.slice(-GIT_LANDED_SHAS_MAX),
      commitIds: entries.map((entry) => entry.commit.id),
    });
  }

  // Observed commits that are not real cargo retire as rewritten and leave
  // the session: shas no ref reaches any more (amended or reset away before
  // any scan listed them), shas the repository does not have at all, and
  // sha-less observations that a later scan of the repository cannot match.
  // A later commit with the same subject on the branch replaces them.
  const ghostIds = new Set();
  const ghostsByBranch = new Map();
  for (const commit of info.observedCommits) {
    if (commit.success === false) continue;
    const sha = eventSha(commit);
    let ghostSha = null;
    if (sha) {
      const entry = containmentFor(state, sha);
      if (!entry?.orphaned && !entry?.missing) continue;
      ghostSha = entry.full || sha;
    } else {
      // Only positive evidence retires a sha-less observation: its branch
      // is gone, or a complete (unsaturated) listing of that branch, taken
      // after the commit, has nothing matching it. In doubt it stays.
      // Both rules need a successful listing newer than the observation;
      // a failed or pending refresh proves nothing.
      if (state.lastScanFailed || state.refreshPending) continue;
      const observedAt = eventTime(commit);
      if (!observedAt || !state.scannedAt || observedAt + SHA_LESS_SCAN_GRACE_MS > state.scannedAt) continue;
      const branch = eventBranch(commit);
      const branchGone = Boolean(branch && state.headNames && !state.headNames.has(branch));
      if (!branchGone) {
        if (state.scanSaturated || !branch || !state.scannedBranches?.has(branch)) continue;
        if (unpushed.some((event) => sameCommitEvent(commit, event))) continue;
      }
    }
    ghostIds.add(commit.id);
    const branch = eventBranch(commit);
    if (!ghostsByBranch.has(branch)) ghostsByBranch.set(branch, []);
    ghostsByBranch.get(branch).push({ commit, sha: ghostSha, label: commit.label || commitText(commit) });
  }
  for (const [branch, ghosts] of ghostsByBranch) {
    const ghostShas = new Set(ghosts.map((ghost) => ghost.sha).filter(Boolean));
    const successors = [
      ...unpushed.filter((event) => eventBranch(event) === branch),
      ...info.observedCommits
        .filter((commit) => eventBranch(commit) === branch && eventSha(commit) && !ghostIds.has(commit.id))
        .map((commit) => ({ sha: eventSha(commit), label: commit.label || commitText(commit) })),
    ].filter((event) => !ghostShas.has(event.sha));
    const withSha = ghosts.filter((ghost) => ghost.sha);
    const ts = Math.max(...ghosts.map((ghost) => eventTime(ghost.commit) || 0)) || now;
    const event = rewrittenEvent(state, branch, withSha, successors, ts);
    event.oldIds = ghosts.map((ghost) => ghost.commit.id);
    if (withSha.length !== ghosts.length) {
      event.id = `git-rewritten-${stableHash([state.repoRoot, branch || 'HEAD', ...withSha.map((ghost) => ghost.sha), ...event.oldIds].join('|'))}`;
    }
    event.commitIds = event.oldIds;
    inferred.push(event);
  }

  return {
    unpushed,
    recent: recent.filter((event) => !absorbed.has(event.id)),
    pushLanded,
    inferred,
    ghostIds,
  };
}

function enrichSessionsWithRepositories(sessions, extraProjects, label, refresh) {
  const now = Date.now();
  const { repos, sessionRepos } = collectRepositories(sessions, extraProjects);
  return recordGitEnrichment(label, repos.size, () => {
    pruneGitTrackingState([...repos.keys()], now);
    const contributions = new Map();
    for (const [repoRoot, info] of repos) {
      const state = refresh(info, now);
      contributions.set(repoRoot, repositoryContribution(state, info, now));
    }

    // Observed git events whose repository is unknown, gone, or which a scan
    // proved to be ghosts are not cargo: they never reach the harbor, and in
    // particular never fall back to the session's repository.
    const ghostIds = new Set([...contributions.values()].flatMap((contribution) => [...contribution.ghostIds]));
    const liveRepo = new Map();
    const isLiveRepo = (repoRoot) => {
      if (!liveRepo.has(repoRoot)) liveRepo.set(repoRoot, resolveRepoIdentity(repoRoot)?.repoRoot === repoRoot);
      return liveRepo.get(repoRoot);
    };
    const isHarborEvent = (event) => {
      if (!event || !GIT_EVENT_TYPES.has(event.type) || event.observed === false) return true;
      if (event.unresolved) return false;
      if (event.repoRoot && !isLiveRepo(event.repoRoot)) return false;
      return !ghostIds.has(event.id);
    };

    const enrichedSessions = sessions.map((session, index) => {
      const { identity, roots } = sessionRepos[index];
      const sourceEvents = Array.isArray(session?.gitEvents) ? session.gitEvents : [];
      const kept = sourceEvents.filter(isHarborEvent);
      const pruned = kept.length !== sourceEvents.length;
      if (!identity && !roots.size) return pruned ? { ...session, gitEvents: kept } : session;
      const next = identity
        ? { ...session, repoRoot: identity.repoRoot, worktree: { ...identity.worktree } }
        : { ...session };
      if (pruned) next.gitEvents = kept;
      if (!roots.size) return next;
      let patched = pruned;
      const own = kept.map((event) => {
        if (event?.type !== 'push' || event.landedShas) return event;
        for (const root of roots) {
          const landed = contributions.get(root)?.pushLanded.get(event.id);
          if (!landed) continue;
          patched = true;
          return { ...event, landedShas: landed };
        }
        return event;
      });
      const ownIds = new Set(sourceEvents.map((event) => event?.id));
      const unpushed = [];
      const extra = [];
      for (const root of roots) {
        const contribution = contributions.get(root);
        if (!contribution) continue;
        unpushed.push(...contribution.unpushed);
        extra.push(...contribution.recent);
        extra.push(...contribution.inferred
          .filter((push) => push.commitIds.some((id) => ownIds.has(id)))
          .map(({ commitIds, ...push }) => push));
      }
      if (!unpushed.length && !extra.length && !patched) return next;
      next.gitEvents = dedupeGitEvents([...mergeUnpushedGitEvents(own, unpushed), ...extra]);
      return next;
    });

    const covered = new Set(sessionRepos.flatMap(({ roots }) => [...roots]));
    for (const [repoRoot, info] of repos) {
      if (!info.watch || covered.has(repoRoot)) continue;
      const contribution = contributions.get(repoRoot);
      const events = dedupeGitEvents([
        ...recentRepositoryUnpushedEvents(contribution.unpushed, now),
        ...contribution.recent,
      ]);
      if (!events.length) continue;
      enrichedSessions.push(createRepositoryGitSession(repoRoot, events));
    }
    return enrichedSessions;
  });
}

function createRepositoryGitSession(project, gitEvents) {
  const events = Array.isArray(gitEvents) ? gitEvents : [];
  const latestActivity = events.reduce((latest, event) => {
    const eventTime = event?.completedAt || event?.ts || 0;
    return Math.max(latest, Number(eventTime) || 0);
  }, Date.now());
  const count = events.length;
  const pushCount = events.filter((event) => event?.type === 'push').length;
  const commitCount = events.filter((event) => event?.type === 'commit').length;
  const lastMessage = pushCount && !commitCount
    ? (pushCount === 1 ? '1 pushed batch' : `${pushCount} pushed batches`)
    : (commitCount === 1 ? '1 unpushed commit' : `${commitCount || count} unpushed commits`);
  const identity = resolveRepoIdentity(project);

  const session = {
    sessionId: `git-repo-${stableHash(project)}`,
    provider: 'git',
    agentId: null,
    agentType: 'repository',
    name: 'Repo Watch',
    agentName: 'Repo Watch',
    model: 'git',
    status: 'active',
    lastActivity: latestActivity || Date.now(),
    project,
    lastMessage,
    lastTool: 'git status',
    lastToolInput: 'Scan unpushed commits',
    tokenUsage: null,
    gitEvents: events,
    parentSessionId: null,
  };
  if (identity) {
    session.repoRoot = identity.repoRoot;
    session.worktree = { ...identity.worktree };
  }
  return session;
}

function recentRepositoryUnpushedEvents(events = [], now = Date.now()) {
  const cutoff = now - REPOSITORY_UNPUSHED_EVENT_TTL_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    if (event?.type !== 'commit') return true;
    const eventTime = Number(event.completedAt || event.ts || 0);
    return Number.isFinite(eventTime) && eventTime >= cutoff;
  });
}

function inferUnpushedGitEventsForSessions(sessions, options = {}) {
  if (!Array.isArray(sessions)) return sessions;
  const extraProjects = Array.isArray(options.projects)
    ? options.projects.filter(Boolean)
    : [];
  if (sessions.length === 0 && extraProjects.length === 0) {
    pruneGitTrackingState([], Date.now());
    return sessions;
  }
  const worker = _gitWorker.enabled;
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment(worker ? 'unpushed-async' : 'unpushed', 0, () => sessions);
    return sessions;
  }
  return enrichSessionsWithRepositories(
    sessions,
    extraProjects,
    worker ? 'unpushed-async' : 'unpushed',
    worker ? refreshRepositoryAsync : refreshRepositorySync,
  );
}

// Push inference now happens with the repository scan (landed shas on
// transitions, verified containment of observed commits). This stage is kept
// for the registry's pipeline and callers that still chain it.
function inferPushedGitEventsForSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;
  if (isGitEnrichmentDisabled()) recordGitEnrichment('pushed', 0, () => sessions);
  return sessions;
}

// Pushes for a list of events, from verified remote containment only: the
// cached result of earlier scans, never the current HEAD.
function inferPushedGitEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const { repos } = collectRepositories([{ gitEvents: list }], []);
  const additions = [];
  for (const [repoRoot, info] of repos) {
    const state = _repoScans.get(repoRoot);
    if (!state) continue;
    additions.push(...repositoryContribution(state, info, Date.now()).inferred.map(({ commitIds, ...push }) => push));
  }
  return additions.length ? dedupeGitEvents([...list, ...additions]) : list;
}

function extractGitEventsFromCommandSource(source, context = {}, options = {}) {
  const parsedSource = tryParseJson(source);
  const command = extractCommand(parsedSource);
  const sourceOutput = extractToolOutput(parsedSource);
  const output = sourceOutput
    ? [context.output, sourceOutput].filter(Boolean).join('\n')
    : context.output;
  const parserContext = output ? { ...context, output } : { ...context };
  // Tool inputs may name their own working directory (Codex `workdir`).
  const workdir = parsedSource && typeof parsedSource === 'object' && !Array.isArray(parsedSource)
    ? [parsedSource.workdir, parsedSource.cwd, parsedSource.working_directory].find((value) => typeof value === 'string' && value.trim())
    : null;
  if (workdir) {
    const base = normalizeProjectPath(context.cwd) || normalizeProjectPath(context.project);
    parserContext.cwd = resolveShellPath(base, workdir.replace(/^file:\/\//, '')) || UNKNOWN_DIR;
  }
  return parseGitEventsFromCommand(command, parserContext, options);
}

module.exports = {
  _test: { containmentSteps },
  MAX_FORGE_EVENTS_PER_PROJECT,
  compactGitEventsForWire,
  dedupeGitEvents,
  configureGitEnrichmentWorker,
  extractCommand,
  extractGitEventsFromCommandSource,
  getGitEnrichmentPerfStats,
  getGitWorkerPerfStats,
  invalidateGitStatusCaches,
  inferPushedGitEvents,
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
  isGitEnrichmentDisabled,
  mergeUnpushedGitEvents,
  normalizeProjectPath,
  parseGitEventsFromCommand,
  projectGitStateSignature,
  requestGitWorkerRefresh,
  resolveRepoIdentity,
  shutdownGitEnrichmentWorker,
  stableHash,
};
