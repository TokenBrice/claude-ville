const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_EVENT_TYPES = new Set(['commit', 'push', 'pull', 'fetch']);
const GIT_PULL_FETCH_FLAG_TRACKED = new Set(['--all', '--prune', '--tags']);
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
const GIT_SUBCOMMAND_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-F',
  '-m',
  '-o',
  '-S',
  '--author',
  '--cleanup',
  '--date',
  '--exec',
  '--file',
  '--fixup',
  '--gpg-sign',
  '--message',
  '--pathspec-from-file',
  '--push-option',
  '--receive-pack',
  '--repo',
  '--reuse-message',
  '--reedit-message',
  '--squash',
  '--template',
  '--trailer',
]);
const GIT_PUSH_FLAGS_WITH_VALUE = new Set([
  '-o',
  '--exec',
  '--push-option',
  '--receive-pack',
  '--repo',
]);
// Raised from 5s to 30s: unpushed-commit scans are idempotent and dominate the
// per-poll cost when many repos are open. Two mechanisms keep commit visibility
// fast despite the long base TTL: projects with active sessions use the shorter
// active TTL, and a HEAD/logs-HEAD mtime change busts that project's caches so
// new commits surface on the next enrichment pass.
const GIT_STATUS_CACHE_TTL_MS = 30000;
const GIT_STATUS_ACTIVE_CACHE_TTL_MS = 10000;
const RECENT_REPOSITORY_PUSH_TTL_MS = 2 * 60 * 1000;
const REPOSITORY_UNPUSHED_EVENT_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.CLAUDEVILLE_REPOSITORY_UNPUSHED_EVENT_TTL_MS || (7 * 24 * 60 * 60 * 1000)) || (7 * 24 * 60 * 60 * 1000)
);
const MAX_UNPUSHED_COMMITS_PER_BRANCH = 120;
const GIT_TRACKING_TTL_MS = 6 * 60 * 60 * 1000;
const GIT_TRACKING_MAX_PROJECTS = 512;
const _gitStatusCache = new Map();
const _unpushedEventsCache = new Map();
const _currentBranchCache = new Map();
const _gitStatusActiveProjects = new Map();
const _gitHeadSignatureByProject = new Map();
const _lastUnpushedByProjectBranch = new Map();
const _recentRepositoryPushEvents = new Map();
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
  lastRun: null,
  recentRuns: [],
};

function invalidateGitStatusCaches({ project = null } = {}) {
  if (!project) {
    _gitStatusCache.clear();
    _unpushedEventsCache.clear();
    _currentBranchCache.clear();
    return;
  }

  const prefix = `${project}::`;
  for (const key of _gitStatusCache.keys()) {
    if (key === project || key.startsWith(prefix)) _gitStatusCache.delete(key);
  }
  _unpushedEventsCache.delete(project);
  _currentBranchCache.delete(project);
}

function markProjectSessionActive(project, now = Date.now()) {
  if (!project) return;
  _gitStatusActiveProjects.set(project, now);
  _gitTrackingLastSeen.delete(project);
  _gitTrackingLastSeen.set(project, now);
  if (_gitStatusActiveProjects.size > 512) {
    for (const [key, at] of _gitStatusActiveProjects.entries()) {
      if (now - at >= GIT_STATUS_CACHE_TTL_MS) _gitStatusActiveProjects.delete(key);
    }
  }
}

function pruneGitTrackingState(activeProjects = [], now = Date.now()) {
  for (const project of activeProjects) {
    if (!project) continue;
    _gitTrackingLastSeen.delete(project);
    _gitTrackingLastSeen.set(project, now);
  }

  const expiredProjects = new Set();
  for (const [project, seenAt] of _gitTrackingLastSeen) {
    if ((now - seenAt) > GIT_TRACKING_TTL_MS) expiredProjects.add(project);
  }
  while ((_gitTrackingLastSeen.size - expiredProjects.size) > GIT_TRACKING_MAX_PROJECTS) {
    const project = [..._gitTrackingLastSeen.keys()].find((candidate) => !expiredProjects.has(candidate));
    if (!project) break;
    expiredProjects.add(project);
  }

  for (const project of expiredProjects) {
    _gitTrackingLastSeen.delete(project);
    _gitStatusActiveProjects.delete(project);
    _gitHeadSignatureByProject.delete(project);
    invalidateGitStatusCaches({ project });
  }

  for (const [key, remembered] of _lastUnpushedByProjectBranch) {
    const observedAt = Number(remembered?.observedAt || 0);
    if (expiredProjects.has(remembered?.project) || !observedAt || (now - observedAt) > GIT_TRACKING_TTL_MS) {
      _lastUnpushedByProjectBranch.delete(key);
    }
  }
}

function gitStatusCacheTtl(project, now = Date.now()) {
  const activeAt = _gitStatusActiveProjects.get(project);
  if (activeAt != null && now - activeAt < GIT_STATUS_CACHE_TTL_MS) {
    return GIT_STATUS_ACTIVE_CACHE_TTL_MS;
  }
  return GIT_STATUS_CACHE_TTL_MS;
}

function gitHeadFiles(project) {
  let gitDir = path.join(project, '.git');
  try {
    if (fs.statSync(gitDir).isFile()) {
      // Worktree/submodule checkout: .git is a pointer file to the real git dir.
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!pointer) return [];
      gitDir = path.resolve(project, pointer[1]);
    }
  } catch {
    return [];
  }
  // logs/HEAD mtime changes on every commit; HEAD mtime changes on checkout.
  return [path.join(gitDir, 'logs', 'HEAD'), path.join(gitDir, 'HEAD')];
}

function gitHeadSignature(project) {
  const files = gitHeadFiles(project);
  if (!files.length) return null;
  return files
    .map((file) => {
      try {
        return String(fs.statSync(file).mtimeMs);
      } catch {
        return '-';
      }
    })
    .join('|');
}

function invalidateOnGitHeadChange(project) {
  if (!project) return;
  const signature = gitHeadSignature(project);
  const previous = _gitHeadSignatureByProject.get(project);
  _gitHeadSignatureByProject.set(project, signature);
  if (previous !== undefined && signature !== null && previous !== signature) {
    _perf.headInvalidations++;
    invalidateGitStatusCaches({ project });
  }
}

function isGitEnrichmentDisabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT || '').toLowerCase());
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
  return {
    ..._perf,
    disabled: isGitEnrichmentDisabled(),
    statusCacheSize: _gitStatusCache.size,
    unpushedEventCacheSize: _unpushedEventsCache.size,
    currentBranchCacheSize: _currentBranchCache.size,
    activeProjectCacheSize: _gitStatusActiveProjects.size,
    headSignatureCacheSize: _gitHeadSignatureByProject.size,
    unpushedTransitionCacheSize: _lastUnpushedByProjectBranch.size,
    trackingProjectCount: _gitTrackingLastSeen.size,
    trackingProjectLimit: GIT_TRACKING_MAX_PROJECTS,
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

function extractCommand(value) {
  if (!value) return null;
  const parsed = tryParseJson(value);

  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.command === 'string') return parsed.command;
    if (typeof parsed.cmd === 'string') return parsed.cmd;
  }

  return null;
}

function splitShellCommands(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
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

    if (ch === ';' || ch === '\n' || (ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function findGitCommand(tokens) {
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index++;
  if (tokens[index] !== 'git') return null;

  index++;
  while (index < tokens.length) {
    const token = tokens[index];
    if (GIT_EVENT_TYPES.has(token)) return { type: token, subcommandIndex: index };

    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith('--git-dir=') ||
      token.startsWith('--work-tree=') ||
      token.startsWith('--namespace=') ||
      token.startsWith('--exec-path=') ||
      token.startsWith('-c') && token.length > 2
    ) {
      index++;
      continue;
    }

    if (token.startsWith('-')) {
      index++;
      continue;
    }

    return null;
  }

  return null;
}

function isDryRun(type, tokens, subcommandIndex) {
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--dry-run' || token.startsWith('--dry-run=')) return true;
    if (type === 'push' && token === '-n') return true;
  }
  return false;
}

function isHelpRequest(tokens, subcommandIndex) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (HELP_FLAGS.has(token)) return true;
    if (i <= subcommandIndex) continue;
    if (token.includes('=')) continue;
    if (GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) i++;
  }
  return false;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
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

function pushPositionals(tokens, subcommandIndex) {
  const positionals = [];
  let repositoryFromFlag = false;
  let force = null;

  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (token === '--force' || token === '-f') {
      if (force === null) force = true;
    } else if (token === '--force-with-lease' || token.startsWith('--force-with-lease=')) {
      force = 'lease';
    } else if (token === '--force-if-includes' || token.startsWith('--force-if-includes=')) {
      force = 'includes';
    }

    if (token === '--repo') repositoryFromFlag = true;
    if (GIT_PUSH_FLAGS_WITH_VALUE.has(token) || GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }

    if (token.startsWith('--repo=')) {
      repositoryFromFlag = true;
      continue;
    }
    if (token.startsWith('--push-option=') || token.startsWith('--receive-pack=')) continue;
    if (token.startsWith('-')) continue;

    if (token.startsWith('+') && force === null) force = true;
    positionals.push(token);
  }

  return { positionals, repositoryFromFlag, force };
}

function pullFetchPositionals(tokens, subcommandIndex) {
  const positionals = [];
  const flags = [];

  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (GIT_PULL_FETCH_FLAG_TRACKED.has(token) && !flags.includes(token)) flags.push(token);
    if (GIT_PUSH_FLAGS_WITH_VALUE.has(token) || GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;

    positionals.push(token);
  }

  return { positionals, flags };
}

function extractTargetRef(type, tokens, subcommandIndex) {
  if (type === 'push') {
    const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
    const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
    if (refspecs[0] === 'tag' && refspecs[1]) return normalizeRefName(refspecs[1]);

    for (const refspec of refspecs) {
      const target = normalizeRefName(refspec);
      if (target) return target;
    }

    return null;
  }

  if (type === 'pull' || type === 'fetch') {
    const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
    const refspecs = positionals.slice(1);
    for (const refspec of refspecs) {
      const target = normalizeRefName(refspec);
      if (target) return target;
    }
    return null;
  }

  return null;
}

function extractRefspecs(type, tokens, subcommandIndex) {
  if (type === 'push') {
    const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
    const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
    return refspecs.filter(Boolean);
  }

  if (type === 'pull' || type === 'fetch') {
    const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
    return positionals.slice(1).filter(Boolean);
  }

  return [];
}

function extractRemote(type, tokens, subcommandIndex) {
  if (type !== 'pull' && type !== 'fetch') return null;
  const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
  const remote = positionals[0];
  return remote ? String(remote).trim() || null : null;
}

// Branch-deletion pushes ("git push origin --delete b", "-d b", "origin :b")
// look like a normal push to the branch positional; flag them so consumers show
// a deletion rather than a publish to that ref.
function isPushDelete(tokens, subcommandIndex) {
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--delete' || token === '-d' || token.startsWith('--delete=')) return true;
  }
  const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
  const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
  return refspecs.some((refspec) => {
    const withoutForce = String(refspec).replace(/^\+/, '');
    return withoutForce.startsWith(':') && withoutForce.length > 1;
  });
}

function clampConfidence(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function createGitEvent(command, type, dryRun, context, parsed = {}) {
  const normalized = normalizeCommand(command);
  const commandHash = stableHash(normalized);
  const provider = context.provider || 'unknown';
  const sessionId = context.sessionId || null;
  const sourceId = context.sourceId || null;
  const ts = parseTimestamp(context.ts);
  const project = context.project || null;
  const identity = [provider, sessionId, sourceId, project, ts, type, commandHash].filter(Boolean).join('|');
  const completedAt = parseTimestamp(context.completedAt);
  const hasCompletionMetadata = completedAt
    || typeof context.success === 'boolean'
    || Number.isFinite(Number(context.exitCode))
    || context.status != null;

  const event = {
    id: `git-${type}-${stableHash(identity)}`,
    type,
    command: normalized,
    project,
    provider,
    sessionId,
    sourceId,
    ts,
    commandHash,
    dryRun,
    source: context.source || 'command-parser',
    confidence: clampConfidence(context.confidence, hasCompletionMetadata ? 0.98 : 0.92),
    inferred: context.inferred === true,
    observed: context.observed !== false && context.inferred !== true,
  };

  if (parsed.targetRef) event.targetRef = parsed.targetRef;
  if (parsed.refspec) event.refspec = parsed.refspec;
  if (Array.isArray(parsed.refspecs) && parsed.refspecs.length) event.refspecs = parsed.refspecs;
  if (project && type === 'push') {
    const branch = normalizeRefName(parsed.targetRef) || currentBranch(project);
    if (branch) {
      event.branch = branch;
      if (!event.targetRef) event.targetRef = branch;
    }
  }
  if (project && (type === 'pull' || type === 'fetch')) {
    const branch = normalizeRefName(parsed.targetRef) || currentBranch(project);
    if (branch) event.branch = branch;
  }
  if (type === 'push' && parsed.force) event.force = parsed.force;
  if (type === 'push' && parsed.deleted) event.deleted = true;
  if ((type === 'pull' || type === 'fetch')) {
    if (parsed.remote) event.remote = parsed.remote;
    if (Array.isArray(parsed.flags) && parsed.flags.length) event.flags = parsed.flags;
  }
  if (typeof context.success === 'boolean') event.success = context.success;
  if (Number.isFinite(Number(context.exitCode))) event.exitCode = Number(context.exitCode);
  if (context.status) event.status = context.status;
  if (completedAt) event.completedAt = completedAt;
  if (typeof context.stderr === 'string' && context.stderr) event.stderr = context.stderr;

  return event;
}

function parseGitEventsFromCommand(command, context = {}, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const events = [];
  const ignoreDryRun = options.ignoreDryRun !== false;

  for (const segment of splitShellCommands(command)) {
    const tokens = tokenizeShellSegment(segment);
    const match = findGitCommand(tokens);
    if (!match) continue;
    if (isHelpRequest(tokens, match.subcommandIndex)) continue;

    const dryRun = isDryRun(match.type, tokens, match.subcommandIndex);
    if (dryRun && ignoreDryRun) continue;

    const parsed = {
      targetRef: extractTargetRef(match.type, tokens, match.subcommandIndex),
    };
    const refspecs = extractRefspecs(match.type, tokens, match.subcommandIndex);
    if (refspecs.length) {
      parsed.refspec = refspecs[0];
      parsed.refspecs = refspecs;
    }
    if (match.type === 'push') {
      const pushInfo = pushPositionals(tokens, match.subcommandIndex);
      if (pushInfo.force) parsed.force = pushInfo.force;
      if (isPushDelete(tokens, match.subcommandIndex)) parsed.deleted = true;
    } else if (match.type === 'pull' || match.type === 'fetch') {
      parsed.remote = extractRemote(match.type, tokens, match.subcommandIndex);
      const pullInfo = pullFetchPositionals(tokens, match.subcommandIndex);
      if (pullInfo.flags.length) parsed.flags = pullInfo.flags;
    }
    events.push(createGitEvent(segment, match.type, dryRun, context, parsed));
  }

  return dedupeGitEvents(events);
}

function dedupeGitEvents(events) {
  const seen = new Set();
  const unique = [];

  for (const event of events) {
    if (!event || !event.id || seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }

  return unique;
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

function commitSubjectFromCommand(command) {
  if (!command) return '';

  for (const segment of splitShellCommands(command)) {
    const tokens = tokenizeShellSegment(segment);
    const match = findGitCommand(tokens);
    if (!match || match.type !== 'commit') continue;

    const messages = [];
    for (let i = match.subcommandIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if ((token === '-m' || token === '--message') && tokens[i + 1]) {
        messages.push(tokens[i + 1]);
        i++;
        continue;
      }
      if (token.startsWith('--message=')) {
        messages.push(token.slice('--message='.length));
        continue;
      }
      if (token.startsWith('-m') && token.length > 2) {
        messages.push(token.slice(2));
      }
    }
    if (messages.length) return messages.join(' ');
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
  if (left.project !== right.project) return false;

  const leftSha = eventSha(left);
  const rightSha = eventSha(right);
  if (leftSha && rightSha) return leftSha === rightSha;

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
  const sha = eventSha(observed) || eventSha(inferred);
  if (sha) merged.sha = sha;
  if (!merged.label && inferred.label) merged.label = inferred.label;
  if (!merged.branch && inferred.branch) merged.branch = inferred.branch;
  if (!merged.targetRef && inferred.targetRef) merged.targetRef = inferred.targetRef;
  if (!merged.upstream && inferred.upstream) merged.upstream = inferred.upstream;
  if (!merged.comparisonRef && inferred.comparisonRef) merged.comparisonRef = inferred.comparisonRef;
  if (typeof merged.hasUpstream !== 'boolean' && typeof inferred.hasUpstream === 'boolean') {
    merged.hasUpstream = inferred.hasUpstream;
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
    }).trim();
  } catch (err) {
    const expectedRefMiss = args[0] === 'rev-parse'
      && args.includes('--verify')
      && args.includes('--quiet')
      && Number.isInteger(err?.status);
    if (!expectedRefMiss) {
      _perf.gitCommandErrors++;
      if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || /timed? out|timeout/i.test(err?.message || '')) {
        _perf.gitCommandTimeouts++;
      }
    }
    throw err;
  } finally {
    _perf.gitCommandTimeMs += Date.now() - start;
  }
}

function tryRunGit(project, args) {
  try {
    return runGit(project, args);
  } catch {
    return '';
  }
}

function refExists(project, ref) {
  if (!ref) return false;
  return !!tryRunGit(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

function currentBranch(project) {
  if (!project) return '';
  const now = Date.now();
  const cached = _currentBranchCache.get(project);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }
  const value = tryRunGit(project, ['branch', '--show-current']);
  _currentBranchCache.set(project, { at: now, value });
  return value;
}

function normalizeLocalBranchName(branch) {
  return String(branch || '').trim().replace(/^refs\/heads\//, '');
}

function branchUpstream(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  return tryRunGit(project, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${normalized}`]);
}

function sameNameRemoteBranch(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  const refs = tryRunGit(project, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/*/${normalized}`,
  ])
    .split('\n')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .filter((ref) => !ref.endsWith('/HEAD'));
  if (!refs.length) return '';
  const originRef = refs.find((ref) => ref === `origin/${normalized}`);
  return originRef || refs[0];
}

function defaultComparisonBase(project, branch) {
  const candidates = [
    'origin/HEAD',
    'origin/main',
    'origin/master',
    'main',
    'master',
  ].filter((ref) => ref && ref !== branch);

  for (const baseRef of candidates) {
    if (refExists(project, baseRef)) return baseRef;
  }

  return null;
}

function branchComparison(project, branch, explicitUpstream = '') {
  const normalizedBranch = normalizeLocalBranchName(branch || currentBranch(project));
  const upstream = explicitUpstream || branchUpstream(project, normalizedBranch);
  if (upstream) {
    return {
      branch: normalizedBranch,
      baseRef: upstream,
      upstream,
      hasUpstream: true,
    };
  }

  const remoteBranch = sameNameRemoteBranch(project, normalizedBranch);
  if (remoteBranch) {
    return {
      branch: normalizedBranch,
      baseRef: remoteBranch,
      upstream: remoteBranch,
      hasUpstream: true,
    };
  }

  const baseRef = defaultComparisonBase(project, normalizedBranch);
  if (baseRef) return {
    branch: normalizedBranch,
    baseRef,
    upstream: null,
    hasUpstream: false,
  };

  return {
    branch: normalizedBranch,
    baseRef: null,
    upstream: null,
    hasUpstream: false,
  };
}

function unpushedComparison(project) {
  return branchComparison(project, currentBranch(project));
}

function readPushState(project, branch = null) {
  const now = Date.now();
  const normalizedBranch = normalizeLocalBranchName(branch);
  const cacheKey = `${project}::${normalizedBranch || 'HEAD'}`;
  const cached = _gitStatusCache.get(cacheKey);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }

  let value = { pushedToUpstream: false, upstream: null };
  try {
    if (runGit(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const effectiveBranch = normalizedBranch || currentBranch(project) || 'HEAD';
    const upstream = normalizedBranch
      ? branchUpstream(project, normalizedBranch)
      : runGit(project, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const counts = runGit(project, ['rev-list', '--left-right', '--count', `${effectiveBranch}...${upstream}`])
      .split(/\s+/)
      .map((part) => Number(part));
    const ahead = Number.isFinite(counts[0]) ? counts[0] : null;
    value = {
      pushedToUpstream: ahead === 0,
      upstream: upstream || null,
    };
  } catch {
    value = { pushedToUpstream: false, upstream: null };
  }

  _gitStatusCache.set(cacheKey, { at: now, value });
  return value;
}

function syntheticPushForProject(project, commitEvents, now = Date.now()) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length) return null;

  const branch = commits[0].branch || commits[0].targetRef || null;
  const pushState = readPushState(project, branch);
  if (!pushState.pushedToUpstream) return null;

  const latestCommit = commits[0];
  const latestCommitTime = latestCommit.completedAt || latestCommit.ts || 0;
  const eventTime = latestCommitTime || now;
  const id = `git-push-inferred-${stableHash([
    project,
    pushState.upstream || 'upstream',
    latestCommit.id || latestCommit.commandHash || latestCommit.command || latestCommitTime,
  ].join('|'))}`;

  return {
    id,
    type: 'push',
    command: `git push (${pushState.upstream || 'upstream'} already contains HEAD)`,
    project,
    provider: latestCommit.provider,
    sessionId: latestCommit.sessionId,
    sourceId: 'git-upstream-status',
    source: 'git-upstream-status',
    confidence: 0.76,
    ts: eventTime,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: eventTime,
    status: 'success',
    targetRef: pushState.upstream,
    branch: branch || null,
    label: pushState.upstream ? `Pushed to ${pushState.upstream}` : 'Pushed',
    inferred: true,
    observed: false,
  };
}

function syntheticPushesForProject(project, commitEvents, now = Date.now()) {
  const groups = new Map();
  for (const event of commitEvents || []) {
    if (event?.type !== 'commit' || event.project !== project) continue;
    const branch = eventBranch(event);
    const events = groups.get(branch) || [];
    events.push(event);
    groups.set(branch, events);
  }

  return [...groups.values()]
    .map((events) => syntheticPushForProject(project, events, now))
    .filter(Boolean);
}

function projectBranchKey(project, branch = '') {
  return `${project}::${normalizeLocalBranchName(branch) || 'HEAD'}`;
}

function groupCommitEventsByBranch(events = []) {
  const groups = new Map();
  for (const event of events || []) {
    if (event?.type !== 'commit') continue;
    const branch = eventBranch(event);
    const list = groups.get(branch) || [];
    list.push(event);
    groups.set(branch, list);
  }
  return groups;
}

function syntheticRepositoryPushFromTransition(project, branch, commitEvents, pushState, now) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length || !pushState?.pushedToUpstream) return null;

  const latestCommit = commits[0];
  const normalizedBranch = normalizeLocalBranchName(branch || latestCommit.branch || latestCommit.targetRef || '');
  const id = `git-push-transition-${stableHash([
    project,
    normalizedBranch || 'HEAD',
    pushState.upstream || 'upstream',
    latestCommit.sha || latestCommit.id || latestCommit.commandHash || latestCommit.command,
  ].join('|'))}`;

  return {
    id,
    type: 'push',
    command: `git push (${pushState.upstream || 'upstream'} now contains HEAD)`,
    project,
    provider: latestCommit.provider || 'git',
    sessionId: latestCommit.sessionId || `git-repo-${stableHash(project)}`,
    sourceId: 'git-upstream-transition',
    source: 'git-upstream-transition',
    confidence: 0.82,
    ts: now,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: now,
    status: 'success',
    targetRef: pushState.upstream,
    branch: normalizedBranch || null,
    label: pushState.upstream ? `Pushed to ${pushState.upstream}` : 'Pushed',
    inferred: true,
    observed: false,
  };
}

function expireRecentRepositoryPushEvents(now = Date.now()) {
  const cutoff = now - RECENT_REPOSITORY_PUSH_TTL_MS;
  for (const [id, event] of _recentRepositoryPushEvents.entries()) {
    const ts = Number(event?.completedAt || event?.ts || 0);
    if (!Number.isFinite(ts) || ts < cutoff) _recentRepositoryPushEvents.delete(id);
  }
}

function observeRepositoryPushTransitions(project, unpushedEvents = [], now = Date.now()) {
  if (!project) return;
  expireRecentRepositoryPushEvents(now);

  const currentByBranch = groupCommitEventsByBranch(unpushedEvents);
  for (const [branch, events] of currentByBranch.entries()) {
    _lastUnpushedByProjectBranch.set(projectBranchKey(project, branch), {
      project,
      branch,
      events: dedupeGitEvents(events),
      observedAt: now,
    });
  }

  for (const [key, previous] of _lastUnpushedByProjectBranch.entries()) {
    if (previous.project !== project) continue;
    if (currentByBranch.has(previous.branch)) continue;

    const pushState = readPushState(project, previous.branch);
    if (pushState.pushedToUpstream) {
      const event = syntheticRepositoryPushFromTransition(project, previous.branch, previous.events, pushState, now);
      if (event) _recentRepositoryPushEvents.set(event.id, event);
      _lastUnpushedByProjectBranch.delete(key);
    }
  }
}

function recentRepositoryPushEventsByProject(projects = [], now = Date.now()) {
  expireRecentRepositoryPushEvents(now);
  const projectSet = new Set((projects || []).filter(Boolean));
  const byProject = new Map();
  for (const event of _recentRepositoryPushEvents.values()) {
    if (projectSet.size && !projectSet.has(event.project)) continue;
    const list = byProject.get(event.project) || [];
    list.push(event);
    byProject.set(event.project, list);
  }
  return byProject;
}

function readUnpushedCommitEvents(project, context = {}) {
  if (!project) return [];
  const now = Date.now();
  const cached = _unpushedEventsCache.get(project);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }

  let value = [];
  const commandErrorsBefore = _perf.gitCommandErrors;
  try {
    if (runGit(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _unpushedEventsCache.set(project, { at: now, value });
      return value;
    }
    const comparisons = [unpushedComparison(project)].filter((comparison) => comparison.baseRef);
    if (!comparisons.length) {
      if (_perf.gitCommandErrors > commandErrorsBefore) return cached?.value || value;
      _unpushedEventsCache.set(project, { at: now, value });
      return value;
    }

    const events = [];
    for (const comparison of comparisons) {
      const output = runGit(project, [
        'log',
        '--reverse',
        `--max-count=${MAX_UNPUSHED_COMMITS_PER_BRANCH}`,
        '--format=%H%x1f%ct%x1f%s',
        `${comparison.baseRef}..${comparison.branch}`,
      ]);
      if (!output) continue;

      for (const line of output.split('\n')) {
        const [sha, timestampSeconds, subject] = line.split('\x1f');
        if (!sha) continue;
        const ts = Number(timestampSeconds) * 1000;
        const id = `git-unpushed-${stableHash(`${project}:${comparison.branch || 'HEAD'}:${sha}`)}`;
        events.push({
          id,
          type: 'commit',
          command: `git commit ${sha.slice(0, 10)} (${subject || 'unpushed commit'})`,
          project,
          provider: context.provider,
          sessionId: context.sessionId,
          sourceId: 'git-upstream-status',
          source: 'git-upstream-status',
          confidence: 0.72,
          ts: Number.isFinite(ts) ? ts : Date.now(),
          commandHash: stableHash(id),
          dryRun: false,
          success: true,
          exitCode: 0,
          completedAt: Number.isFinite(ts) ? ts : Date.now(),
          sha,
          label: subject || sha.slice(0, 10),
          inferred: true,
          observed: false,
          branch: comparison.branch || null,
          targetRef: comparison.branch || comparison.baseRef,
          upstream: comparison.upstream,
          comparisonRef: comparison.baseRef,
          hasUpstream: comparison.hasUpstream,
        });
      }
    }
    value = dedupeGitEvents(events);
  } catch {
    return cached?.value || value;
  }
  _unpushedEventsCache.set(project, { at: now, value });
  return value;
}

function inferPushedGitEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const commitsByProject = new Map();
  const observedPushBranchesByProject = new Map();
  for (const event of list) {
    if (!event?.project) continue;
    if (event.type === 'commit') {
      const commits = commitsByProject.get(event.project) || [];
      commits.push(event);
      commitsByProject.set(event.project, commits);
    }
    if (event.type === 'push') {
      const branches = observedPushBranchesByProject.get(event.project) || new Set();
      branches.add(eventBranch(event));
      observedPushBranchesByProject.set(event.project, branches);
    }
  }
  if (!commitsByProject.size) return list;

  const enriched = [...list];
  for (const [project, commits] of commitsByProject.entries()) {
    const observedBranches = observedPushBranchesByProject.get(project) || new Set();
    const candidates = syntheticPushesForProject(project, commits, now)
      .filter((event) => !observedBranches.has(eventBranch(event)));
    enriched.push(...candidates);
  }
  return dedupeGitEvents(enriched);
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

  return {
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

  const now = Date.now();
  const extraProjects = Array.isArray(options.projects)
    ? options.projects.filter(Boolean)
    : [];
  if (sessions.length === 0 && extraProjects.length === 0) {
    pruneGitTrackingState([], now);
    return sessions;
  }
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment('unpushed', 0, () => sessions);
    return sessions;
  }
  const eventsByProject = new Map();
  const projects = [
    ...sessions.map((session) => session?.project).filter(Boolean),
    ...extraProjects,
  ];

  const uniqueProjects = [...new Set(projects.filter(Boolean))];
  return recordGitEnrichment('unpushed', uniqueProjects.length, () => {
    pruneGitTrackingState(uniqueProjects, now);
    for (const session of sessions) {
      if (session?.project) markProjectSessionActive(session.project, now);
    }
    for (const project of uniqueProjects) {
      invalidateOnGitHeadChange(project);
      if (!eventsByProject.has(project)) {
        const unpushed = readUnpushedCommitEvents(project, {
          provider: 'git',
          sessionId: `git-repo-${stableHash(project)}`,
        });
        eventsByProject.set(project, unpushed);
        observeRepositoryPushTransitions(project, unpushed, now);
      }
    }

    const recentPushesByProject = recentRepositoryPushEventsByProject(uniqueProjects, now);
    const hasUnpushed = [...eventsByProject.values()].some((events) => events.length > 0);
    const hasRecentPushes = [...recentPushesByProject.values()].some((events) => events.length > 0);
    if (!hasUnpushed && !hasRecentPushes) return sessions;

    const enrichedSessions = sessions.map((session) => {
      const project = session?.project;
      const unpushed = project ? eventsByProject.get(project) || [] : [];
      const recentPushes = project ? recentPushesByProject.get(project) || [] : [];
      if (!unpushed.length && !recentPushes.length) return session;

      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const commitEvents = mergeUnpushedGitEvents(ownEvents, unpushed);
      return {
        ...session,
        gitEvents: dedupeGitEvents([...commitEvents, ...recentPushes]),
      };
    });

    const sessionProjects = new Set(sessions.map((session) => session?.project).filter(Boolean));
    for (const project of extraProjects) {
      if (sessionProjects.has(project)) continue;
      const unpushed = recentRepositoryUnpushedEvents(eventsByProject.get(project), now);
      const recentPushes = recentPushesByProject.get(project) || [];
      const events = dedupeGitEvents([...unpushed, ...recentPushes]);
      if (!events.length) continue;
      enrichedSessions.push(createRepositoryGitSession(project, events));
    }

    return enrichedSessions;
  });
}

function inferPushedGitEventsForSessions(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment('pushed', 0, () => sessions);
    return sessions;
  }

  const eventsByProject = new Map();
  for (const session of sessions) {
    for (const event of session.gitEvents || []) {
      if (!event?.project) continue;
      const events = eventsByProject.get(event.project) || [];
      events.push(event);
      eventsByProject.set(event.project, events);
    }
  }

  return recordGitEnrichment('pushed', eventsByProject.size, () => {
    const inferredByProject = new Map();
    for (const [project, events] of eventsByProject.entries()) {
      const enriched = inferPushedGitEvents(events, options);
      const inferred = enriched.filter((event) => event.inferred && !events.some((existing) => existing.id === event.id));
      if (inferred.length) inferredByProject.set(project, inferred);
    }

    if (!inferredByProject.size) return sessions;
    return sessions.map((session) => {
      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const additions = [];
      for (const event of ownEvents) {
        if (event?.type !== 'commit' || !event.project || !inferredByProject.has(event.project)) continue;
        const branch = eventBranch(event);
        const inferredForProject = inferredByProject.get(event.project);
        if (!branch) {
          additions.push(...inferredForProject.filter((inferred) => !inferred.branch));
          continue;
        }
        additions.push(...inferredForProject.filter((inferred) => eventBranch(inferred) === branch));
      }
      if (!additions.length) return session;
      return {
        ...session,
        gitEvents: dedupeGitEvents([...ownEvents, ...additions]),
      };
    });
  });
}

function extractGitEventsFromCommandSource(source, context = {}, options = {}) {
  const command = extractCommand(source);
  return parseGitEventsFromCommand(command, context, options);
}

module.exports = {
  dedupeGitEvents,
  extractCommand,
  extractGitEventsFromCommandSource,
  getGitEnrichmentPerfStats,
  invalidateGitStatusCaches,
  inferPushedGitEvents,
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
  isGitEnrichmentDisabled,
  mergeUnpushedGitEvents,
  parseGitEventsFromCommand,
  stableHash,
};
