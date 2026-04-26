const crypto = require('crypto');

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

function createGitEvent(command, type, dryRun, context) {
  const normalized = normalizeCommand(command);
  const commandHash = stableHash(normalized);
  const provider = context.provider || 'unknown';
  const sessionId = context.sessionId || null;
  const sourceId = context.sourceId || null;
  const ts = parseTimestamp(context.ts);
  const project = context.project || null;
  const identity = [provider, sessionId, sourceId, project, ts, type, commandHash].filter(Boolean).join('|');

  return {
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

    events.push(createGitEvent(segment, match.type, dryRun, context));
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

function extractGitEventsFromCommandSource(source, context = {}, options = {}) {
  const command = extractCommand(source);
  return parseGitEventsFromCommand(command, context, options);
}

module.exports = {
  dedupeGitEvents,
  extractCommand,
  extractGitEventsFromCommandSource,
  parseGitEventsFromCommand,
  stableHash,
};
