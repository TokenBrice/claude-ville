const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GIT_EVENT_TYPES = new Set(['commit', 'push']);
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
const GIT_STATUS_CACHE_TTL_MS = 5000;
const _gitStatusCache = new Map();

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

  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
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

    positionals.push(token);
  }

  return { positionals, repositoryFromFlag };
}

function extractTargetRef(type, tokens, subcommandIndex) {
  if (type !== 'push') return null;

  const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
  const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
  if (refspecs[0] === 'tag' && refspecs[1]) return normalizeRefName(refspecs[1]);

  for (const refspec of refspecs) {
    const target = normalizeRefName(refspec);
    if (target) return target;
  }

  return null;
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
  };

  if (parsed.targetRef) event.targetRef = parsed.targetRef;
  if (typeof context.success === 'boolean') event.success = context.success;
  if (Number.isFinite(Number(context.exitCode))) event.exitCode = Number(context.exitCode);
  const completedAt = parseTimestamp(context.completedAt);
  if (completedAt) event.completedAt = completedAt;

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

    events.push(createGitEvent(segment, match.type, dryRun, context, {
      targetRef: extractTargetRef(match.type, tokens, match.subcommandIndex),
    }));
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

function runGit(project, args) {
  if (!project) return '';
  return execFileSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 750,
  }).trim();
}

function readPushState(project) {
  const now = Date.now();
  const cached = _gitStatusCache.get(project);
  if (cached && now - cached.at < GIT_STATUS_CACHE_TTL_MS) return cached.value;

  let value = { pushedToUpstream: false, upstream: null };
  try {
    if (runGit(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _gitStatusCache.set(project, { at: now, value });
      return value;
    }
    const upstream = runGit(project, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const counts = runGit(project, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
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

  _gitStatusCache.set(project, { at: now, value });
  return value;
}

function syntheticPushForProject(project, commitEvents, now = Date.now()) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length) return null;

  const pushState = readPushState(project);
  if (!pushState.pushedToUpstream) return null;

  const latestCommit = commits[0];
  const latestCommitTime = latestCommit.completedAt || latestCommit.ts || 0;
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
    ts: now,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: now,
    status: 'success',
    targetRef: pushState.upstream,
    label: pushState.upstream ? `Pushed to ${pushState.upstream}` : 'Pushed',
    inferred: true,
  };
}

function inferPushedGitEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const projects = new Set(
    list
      .filter((event) => event?.type === 'commit' && event.project)
      .map((event) => event.project)
  );
  if (!projects.size) return list;

  const enriched = [...list];
  for (const project of projects) {
    const hasObservedPush = list.some((event) => event?.type === 'push' && event.project === project);
    if (hasObservedPush) continue;
    const inferred = syntheticPushForProject(project, list, now);
    if (inferred) enriched.push(inferred);
  }
  return dedupeGitEvents(enriched);
}

function inferPushedGitEventsForSessions(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;

  const eventsByProject = new Map();
  for (const session of sessions) {
    for (const event of session.gitEvents || []) {
      if (!event?.project) continue;
      const events = eventsByProject.get(event.project) || [];
      events.push(event);
      eventsByProject.set(event.project, events);
    }
  }

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
      if (event?.type === 'commit' && event.project && inferredByProject.has(event.project)) {
        additions.push(...inferredByProject.get(event.project));
      }
    }
    if (!additions.length) return session;
    return {
      ...session,
      gitEvents: dedupeGitEvents([...ownEvents, ...additions]),
    };
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
  inferPushedGitEvents,
  inferPushedGitEventsForSessions,
  parseGitEventsFromCommand,
  stableHash,
};
