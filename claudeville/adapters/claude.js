/**
 * Claude Code CLI adapter
 * Data source: ~/.claude/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  createDetailResponse,
  parseJsonLines,
  readJsonLines: readSharedJsonLines,
  readTailLines,
  statCacheKey,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const GIT_EVENT_SCAN_LINES = 5000;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 64 * 1024 * 1024;
const MAX_HEAD_BYTES = 512 * 1024;
const SESSION_ENTRY_CACHE_MAX = 256;
const SESSION_ENTRY_CACHE_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CLAUDEVILLE_CLAUDE_PARSED_TAIL_CACHE_MAX_BYTES || 32 * 1024 * 1024) || 32 * 1024 * 1024
);
const SEND_MESSAGE_MAX_EDGES = 10;
const SEND_MESSAGE_RECIPIENT_FIELDS = Object.freeze([
  'recipient',
  'to',
  'recipient_name',
  'recipientName',
]);
// A single active pass can legitimately contain more than 128 Claude sessions.
// Keep the common working set warm, with the byte budget as the hard memory cap.
const TRANSCRIPT_AGGREGATE_CACHE_MAX = 512;
const TRANSCRIPT_AGGREGATE_CACHE_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CLAUDEVILLE_CLAUDE_TRANSCRIPT_CACHE_MAX_BYTES || 32 * 1024 * 1024) || 32 * 1024 * 1024
);
const TRANSCRIPT_SCAN_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_GUARD_BYTES = 256;
const TRANSCRIPT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_MAX_AGENT_LAUNCHES = 2048;
const TRANSCRIPT_ASYNC_THRESHOLD_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CLAUDEVILLE_TRANSCRIPT_ASYNC_THRESHOLD_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024
);
const TRANSCRIPT_SCAN_CONCURRENCY = 1;
const TRANSCRIPT_SCAN_QUEUE_MAX = 128;
const ORPHAN_SCAN_CACHE_MAX = 512;
const TEAM_MEMBERSHIP_WARNED_MAX = 256;
const ORPHAN_DIR_MTIME_EPSILON_MS = 1;
const CLAUDE_TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'file_path',
  'pattern',
  'query',
  'target',
  'target_agent_id',
  'targetAgentId',
  'session_id',
  'sessionId',
  'agent_id',
  'agentId',
  'thread_id',
  'threadId',
  'id',
  'targets',
  'recipient',
  'description',
  'prompt',
  'url',
]);

const _sessionEntryCache = new Map();
let _sessionEntryCacheBytes = 0;
const _sessionEntryCacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  byteEvictions: 0,
  entryEvictions: 0,
  rejectedEntries: 0,
};
const _transcriptAggregateCache = new Map();
let _transcriptAggregateCacheBytes = 0;
const _transcriptScanQueue = [];
const _activeTranscriptStreams = new Map();
let _activeTranscriptScans = 0;
let _dataReadyCallback = null;
let _transcriptScanEpoch = 0;
let _adapterShutdown = false;
const _transcriptAggregateStats = {
  bytesRead: 0,
  guardBytesRead: 0,
  fullScans: 0,
  incrementalScans: 0,
  asyncScans: 0,
  asyncCompletions: 0,
  staleAsyncScans: 0,
  scanErrors: 0,
  malformedLines: 0,
  oversizedLines: 0,
  parsedLines: 0,
  rotations: 0,
  truncations: 0,
  rewrites: 0,
  guardMismatches: 0,
  cacheEvictions: 0,
  cacheByteEvictions: 0,
  cacheEntryEvictions: 0,
  cacheRejectedEntries: 0,
  queueRejections: 0,
  cancelledQueuedScans: 0,
  cancelledActiveScans: 0,
};
const _sessionNamesCache = { signature: '', value: new Map() };
const _teamMembershipCache = { signature: '', value: new Map() };
const _teamMembershipWarned = new Set();
const _teamsCache = { signature: '', value: [] };
// Incremental orphan/team-member scan cache: per project directory, remember its
// mtime and the .jsonl listing so an unchanged directory skips the readdir on the
// next poll. Files are still stat'd every poll (appends don't bump the directory
// mtime), so returned sessions stay identical.
const _orphanScanCache = {
  filesByProjectDir: new Map(),
  projectDirMtimes: new Map(),
};

// ─── Utilities ─────────────────────────────────────────────

function isPathInside(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolve a candidate file only if it stays within rootPath after symlink
// resolution. Guards the client-supplied sessionId/agentId in session-detail
// paths against traversal (e.g. '../../../../etc/foo').
function safeExistingFile(candidatePath, rootPath) {
  try {
    if (!fs.existsSync(candidatePath)) return null;
    const rootReal = fs.realpathSync(rootPath);
    const fileReal = fs.realpathSync(candidatePath);
    return isPathInside(fileReal, rootReal) ? fileReal : null;
  } catch {
    return null;
  }
}

function readLastLines(filePath, lineCount) {
  return readTailLines(filePath, lineCount, {
    chunkBytes: TAIL_CHUNK_BYTES,
    maxBytes: MAX_TAIL_BYTES,
  });
}

function readJsonLines(filePath, { from = 'end', count = GIT_EVENT_SCAN_LINES } = {}) {
  return readSharedJsonLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'claude',
  });
}

function readClaudeSessionNames() {
  const signature = directorySignature(SESSIONS_DIR, { extension: '.json' });
  if (_sessionNamesCache.signature === signature) return _sessionNamesCache.value;
  const names = new Map();
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return names;
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(file => file.endsWith('.json') && !file.startsWith('.'));

    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId.trim() : '';
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (sessionId && name) names.set(sessionId, name);
      } catch { /* ignore malformed session metadata */ }
    }
  } catch { /* ignore */ }
  _sessionNamesCache.signature = signature;
  _sessionNamesCache.value = names;
  return names;
}

function readClaudeTeamMembership() {
  const signature = directorySignature(TEAMS_DIR, { recursive: true, extension: '.json' });
  if (_teamMembershipCache.signature === signature) return _teamMembershipCache.value;
  const members = new Map();
  if (!fs.existsSync(TEAMS_DIR)) return members;
  try {
    const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter(dir => dir.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    const collisions = new Map();

    for (const teamDir of teamDirs) {
      const inboxDir = path.join(TEAMS_DIR, teamDir.name, 'inboxes');
      if (!fs.existsSync(inboxDir)) continue;
      let inboxFiles;
      try {
        inboxFiles = fs.readdirSync(inboxDir)
          .filter(file => file.endsWith('.json') && !file.startsWith('.'))
          .sort();
      } catch {
        continue;
      }
      for (const file of inboxFiles) {
        const agentName = path.basename(file, '.json');
        if (!agentName) continue;
        const previous = members.get(agentName);
        if (previous && previous !== teamDir.name) {
          const list = collisions.get(agentName) || [previous];
          list.push(teamDir.name);
          collisions.set(agentName, list);
        }
        members.set(agentName, teamDir.name);
      }
    }

    for (const [agentName, teams] of collisions.entries()) {
      const winner = members.get(agentName);
      const key = `${agentName}|${teams.slice().sort().join(',')}|${winner}`;
      if (_teamMembershipWarned.has(key)) continue;
      _teamMembershipWarned.add(key);
      while (_teamMembershipWarned.size > TEAM_MEMBERSHIP_WARNED_MAX) {
        _teamMembershipWarned.delete(_teamMembershipWarned.values().next().value);
      }
      console.warn(`[claude adapter] agentName "${agentName}" appears in multiple teams: ${teams.join(', ')}; using ${winner}`);
    }
  } catch { /* ignore */ }
  _teamMembershipCache.signature = signature;
  _teamMembershipCache.value = members;
  return members;
}

function directorySignature(dirPath, { recursive = false, extension = '' } = {}) {
  try {
    if (!fs.existsSync(dirPath)) return 'missing';
    const parts = [];
    const walk = (current, depth = 0) => {
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive && depth < 4) walk(fullPath, depth + 1);
          continue;
        }
        if (extension && !entry.name.endsWith(extension)) continue;
        try {
          const stat = fs.statSync(fullPath);
          parts.push(statCacheKey(fullPath, stat));
        } catch { /* ignore */ }
      }
    };
    walk(dirPath);
    return parts.join('|');
  } catch {
    return 'error';
  }
}

function estimateStringBytes(value) {
  return 16 + (String(value || '').length * 2);
}

function estimateJsonValueBytes(value) {
  const seen = new Set();
  const stack = [value];
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) {
      bytes += 8;
    } else if (typeof current === 'string') {
      bytes += estimateStringBytes(current);
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      bytes += 8;
    } else if (typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      if (Array.isArray(current)) {
        bytes += 32 + (current.length * 8);
        for (const item of current) stack.push(item);
      } else {
        const entries = Object.entries(current);
        bytes += 48 + (entries.length * 16);
        for (const [key, item] of entries) {
          bytes += estimateStringBytes(key);
          stack.push(item);
        }
      }
    }
  }
  return bytes;
}

function estimateSessionEntryRecordBytes(filePath, key, entries) {
  return 96 + estimateStringBytes(filePath) + estimateStringBytes(key) + estimateJsonValueBytes(entries);
}

function deleteSessionEntryRecord(filePath, { evicted = false, reason = null } = {}) {
  const record = _sessionEntryCache.get(filePath);
  if (!record) return;
  _sessionEntryCache.delete(filePath);
  _sessionEntryCacheBytes = Math.max(0, _sessionEntryCacheBytes - (record.estimatedBytes || 0));
  if (evicted) {
    _sessionEntryCacheStats.evictions++;
    if (reason === 'bytes') _sessionEntryCacheStats.byteEvictions++;
    if (reason === 'entries') _sessionEntryCacheStats.entryEvictions++;
  }
}

function clearSessionEntryCache() {
  _sessionEntryCache.clear();
  _sessionEntryCacheBytes = 0;
}

function cacheSessionEntries(filePath, key, entries) {
  deleteSessionEntryRecord(filePath);
  const estimatedBytes = estimateSessionEntryRecordBytes(filePath, key, entries);
  if (estimatedBytes > SESSION_ENTRY_CACHE_MAX_BYTES) {
    _sessionEntryCacheStats.rejectedEntries++;
    return;
  }

  const record = { key, entries, estimatedBytes };
  _sessionEntryCache.set(filePath, record);
  _sessionEntryCacheBytes += estimatedBytes;
  while (
    _sessionEntryCache.size > SESSION_ENTRY_CACHE_MAX
    || _sessionEntryCacheBytes > SESSION_ENTRY_CACHE_MAX_BYTES
  ) {
    const reason = _sessionEntryCacheBytes > SESSION_ENTRY_CACHE_MAX_BYTES ? 'bytes' : 'entries';
    const oldestPath = _sessionEntryCache.keys().next().value;
    if (oldestPath === undefined) break;
    deleteSessionEntryRecord(oldestPath, { evicted: true, reason });
  }
}

function touchSessionEntryRecord(filePath, record) {
  _sessionEntryCache.delete(filePath);
  _sessionEntryCache.set(filePath, record);
}

function getSessionEntries(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = statCacheKey(filePath, stat);
    const cached = _sessionEntryCache.get(filePath);
    if (cached?.key === cacheKey) {
      _sessionEntryCacheStats.hits++;
      touchSessionEntryRecord(filePath, cached);
      return cached.entries;
    }
    _sessionEntryCacheStats.misses++;
    deleteSessionEntryRecord(filePath);
    const entries = readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    cacheSessionEntries(filePath, cacheKey, entries);
    return entries;
  } catch {
    return [];
  }
}

function tailEntries(filePath, count) {
  const entries = getSessionEntries(filePath);
  return entries.slice(-count);
}

function readUsageNumber(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function emptyTokenUsage() {
  return {
    input: 0,
    output: 0,
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    turnCount: 0,
  };
}

function createTranscriptAggregate(filePath) {
  return {
    filePath,
    dev: 0,
    ino: 0,
    size: 0,
    mtimeMs: 0,
    guard: Buffer.alloc(0),
    trailing: Buffer.alloc(0),
    discardingLine: false,
    usage: emptyTokenUsage(),
    launches: [],
    displayUsage: null,
    displayLaunches: null,
  };
}

function cloneTranscriptAggregate(aggregate) {
  if (!aggregate) return null;
  return {
    ...aggregate,
    guard: Buffer.from(aggregate.guard),
    trailing: Buffer.from(aggregate.trailing),
    usage: { ...aggregate.usage },
    launches: aggregate.launches.map((launch) => ({ ...launch })),
  };
}

function appendTranscriptGuard(aggregate, chunk) {
  if (chunk.length >= TRANSCRIPT_GUARD_BYTES) {
    aggregate.guard = Buffer.from(chunk.subarray(chunk.length - TRANSCRIPT_GUARD_BYTES));
    return;
  }
  const combined = aggregate.guard.length ? Buffer.concat([aggregate.guard, chunk]) : Buffer.from(chunk);
  aggregate.guard = combined.length > TRANSCRIPT_GUARD_BYTES
    ? Buffer.from(combined.subarray(combined.length - TRANSCRIPT_GUARD_BYTES))
    : combined;
}

function addTranscriptEntry(aggregate, entry) {
  const msg = entry?.message;
  if (!msg) return;

  if (msg.usage) {
    const usage = msg.usage;
    const input = readUsageNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
    const output = readUsageNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
    const cacheRead = readUsageNumber(usage, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadInputTokens']);
    const cacheCreate = readUsageNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
    aggregate.usage.totalInput += input;
    aggregate.usage.totalOutput += output;
    aggregate.usage.cacheRead += cacheRead;
    aggregate.usage.cacheCreate += cacheCreate;
    aggregate.usage.contextWindow = input + cacheRead + cacheCreate;
    aggregate.usage.turnCount++;
    aggregate.usage.input = aggregate.usage.totalInput;
    aggregate.usage.output = aggregate.usage.totalOutput;
  }

  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (block?.type !== 'tool_use' || block.name !== 'Agent' || !block.input) continue;
    const prompt = typeof block.input.prompt === 'string' ? block.input.prompt : '';
    aggregate.launches.push({
      name: typeof block.input.description === 'string' ? block.input.description.substring(0, 256) : null,
      agentType: typeof block.input.subagent_type === 'string'
        ? block.input.subagent_type.substring(0, 128)
        : 'sub-agent',
      promptHash: prompt ? stableHash(prompt) : null,
    });
    if (aggregate.launches.length > TRANSCRIPT_MAX_AGENT_LAUNCHES) {
      aggregate.launches.splice(0, aggregate.launches.length - TRANSCRIPT_MAX_AGENT_LAUNCHES);
    }
  }
}

function parseTranscriptLine(aggregate, lineBuffer) {
  let line = lineBuffer;
  if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
  if (line.length === 0) return;
  try {
    addTranscriptEntry(aggregate, JSON.parse(line.toString('utf8')));
    _transcriptAggregateStats.parsedLines++;
  } catch {
    _transcriptAggregateStats.malformedLines++;
  }
}

function appendTranscriptPartial(aggregate, segment) {
  if (aggregate.discardingLine || segment.length === 0) return;
  if (aggregate.trailing.length + segment.length > TRANSCRIPT_MAX_LINE_BYTES) {
    aggregate.trailing = Buffer.alloc(0);
    aggregate.discardingLine = true;
    _transcriptAggregateStats.oversizedLines++;
    return;
  }
  aggregate.trailing = aggregate.trailing.length
    ? Buffer.concat([aggregate.trailing, segment])
    : Buffer.from(segment);
}

function processTranscriptChunk(aggregate, chunk) {
  appendTranscriptGuard(aggregate, chunk);
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(10, offset);
    if (newline === -1) {
      appendTranscriptPartial(aggregate, chunk.subarray(offset));
      break;
    }

    const segment = chunk.subarray(offset, newline);
    if (aggregate.discardingLine) {
      aggregate.discardingLine = false;
      aggregate.trailing = Buffer.alloc(0);
    } else if (aggregate.trailing.length + segment.length > TRANSCRIPT_MAX_LINE_BYTES) {
      aggregate.trailing = Buffer.alloc(0);
      _transcriptAggregateStats.oversizedLines++;
    } else {
      const line = aggregate.trailing.length
        ? Buffer.concat([aggregate.trailing, segment])
        : segment;
      aggregate.trailing = Buffer.alloc(0);
      parseTranscriptLine(aggregate, line);
    }
    offset = newline + 1;
  }
}

function statIdentity(stat) {
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: Number(stat.size) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
  };
}

function sameTranscriptTarget(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function estimateTranscriptAggregateBytes(aggregate) {
  if (!aggregate) return 0;
  let bytes = 256
    + estimateStringBytes(aggregate.filePath)
    + (aggregate.guard?.byteLength || 0)
    + (aggregate.trailing?.byteLength || 0)
    + estimateJsonValueBytes(aggregate.usage);
  if (aggregate.displayUsage && aggregate.displayUsage !== aggregate.usage) {
    bytes += estimateJsonValueBytes(aggregate.displayUsage);
  }

  const seenLaunches = new Set();
  const addLaunches = (launches) => {
    if (!Array.isArray(launches)) return;
    bytes += 32 + (launches.length * 8);
    for (const launch of launches) {
      if (!launch || seenLaunches.has(launch)) continue;
      seenLaunches.add(launch);
      bytes += 64
        + estimateStringBytes(launch.name)
        + estimateStringBytes(launch.agentType)
        + estimateStringBytes(launch.promptHash);
    }
  };
  addLaunches(aggregate.launches);
  if (aggregate.displayLaunches !== aggregate.launches) addLaunches(aggregate.displayLaunches);
  return bytes;
}

function estimateTranscriptRecordBytes(filePath, record) {
  return 160
    + estimateStringBytes(filePath)
    + estimateTranscriptAggregateBytes(record?.aggregate)
    + (record?.pendingTarget ? 64 : 0);
}

function deleteTranscriptRecord(filePath, { evicted = false, reason = null } = {}) {
  const record = _transcriptAggregateCache.get(filePath);
  if (!record) return;
  _transcriptAggregateCache.delete(filePath);
  _transcriptAggregateCacheBytes = Math.max(
    0,
    _transcriptAggregateCacheBytes - (record.estimatedBytes || 0)
  );
  if (evicted) {
    _transcriptAggregateStats.cacheEvictions++;
    if (reason === 'bytes') _transcriptAggregateStats.cacheByteEvictions++;
    if (reason === 'entries') _transcriptAggregateStats.cacheEntryEvictions++;
  }
}

function clearTranscriptAggregateCache() {
  for (const record of _transcriptAggregateCache.values()) {
    record.generation = (record.generation || 0) + 1;
    record.pendingTarget = null;
  }
  _transcriptAggregateCache.clear();
  _transcriptAggregateCacheBytes = 0;
}

function touchTranscriptRecord(filePath, record) {
  const existing = _transcriptAggregateCache.get(filePath);
  if (existing) {
    _transcriptAggregateCacheBytes = Math.max(
      0,
      _transcriptAggregateCacheBytes - (existing.estimatedBytes || 0)
    );
    _transcriptAggregateCache.delete(filePath);
  }
  record.estimatedBytes = estimateTranscriptRecordBytes(filePath, record);
  _transcriptAggregateCache.set(filePath, record);
  _transcriptAggregateCacheBytes += record.estimatedBytes;
  while (
    _transcriptAggregateCache.size > TRANSCRIPT_AGGREGATE_CACHE_MAX
    || _transcriptAggregateCacheBytes > TRANSCRIPT_AGGREGATE_CACHE_MAX_BYTES
  ) {
    const reason = _transcriptAggregateCacheBytes > TRANSCRIPT_AGGREGATE_CACHE_MAX_BYTES
      ? 'bytes'
      : 'entries';
    let victim = null;
    for (const entry of _transcriptAggregateCache.entries()) {
      if (!entry[1].pendingTarget) {
        victim = entry;
        break;
      }
    }
    if (!victim) break;
    deleteTranscriptRecord(victim[0], { evicted: true, reason });
  }
  const retained = _transcriptAggregateCache.get(filePath) === record;
  if (!retained) _transcriptAggregateStats.cacheRejectedEntries++;
  return retained
    && _transcriptAggregateCache.size <= TRANSCRIPT_AGGREGATE_CACHE_MAX
    && _transcriptAggregateCacheBytes <= TRANSCRIPT_AGGREGATE_CACHE_MAX_BYTES;
}

function transcriptGuardMatches(filePath, aggregate) {
  if (!aggregate || aggregate.guard.length === 0) return true;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(aggregate.guard.length);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, aggregate.size - buffer.length);
    _transcriptAggregateStats.guardBytesRead += bytesRead;
    return bytesRead === aggregate.guard.length && buffer.equals(aggregate.guard);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function finishTranscriptAggregate(aggregate, target) {
  aggregate.dev = target.dev;
  aggregate.ino = target.ino;
  aggregate.size = target.size;
  aggregate.mtimeMs = target.mtimeMs;
  aggregate.displayUsage = aggregate.usage;
  aggregate.displayLaunches = aggregate.launches;
  if (!aggregate.discardingLine && aggregate.trailing.length > 0) {
    let trailing = aggregate.trailing;
    if (trailing[trailing.length - 1] === 13) trailing = trailing.subarray(0, trailing.length - 1);
    try {
      const provisional = {
        usage: { ...aggregate.usage },
        launches: aggregate.launches.slice(),
      };
      addTranscriptEntry(provisional, JSON.parse(trailing.toString('utf8')));
      aggregate.displayUsage = provisional.usage;
      aggregate.displayLaunches = provisional.launches;
    } catch {
      // An incomplete trailing record remains pending until a newline arrives.
    }
  }
  return aggregate;
}

function scanTranscriptRangeSync(filePath, target, mode, baseAggregate, start) {
  const aggregate = mode === 'append'
    ? cloneTranscriptAggregate(baseAggregate)
    : createTranscriptAggregate(filePath);
  let fd;
  let position = start;
  try {
    fd = fs.openSync(filePath, 'r');
    while (position < target.size) {
      const requested = Math.min(TRANSCRIPT_SCAN_CHUNK_BYTES, target.size - position);
      const chunk = Buffer.allocUnsafe(requested);
      const bytesRead = fs.readSync(fd, chunk, 0, requested, position);
      if (bytesRead <= 0) break;
      const value = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      processTranscriptChunk(aggregate, value);
      position += bytesRead;
      _transcriptAggregateStats.bytesRead += bytesRead;
    }
    if (position !== target.size) throw new Error('Transcript changed during scan');
    return finishTranscriptAggregate(aggregate, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function notifyTranscriptDataReady(filePath, reason) {
  if (_adapterShutdown || typeof _dataReadyCallback !== 'function') return;
  try {
    _dataReadyCallback({
      provider: 'claude',
      path: filePath,
      kind: 'transcript',
      reason,
    });
  } catch {
    // Completion notification must not fail the scan worker.
  }
}

function runNextTranscriptScan() {
  if (_adapterShutdown) return;
  while (_activeTranscriptScans < TRANSCRIPT_SCAN_CONCURRENCY && _transcriptScanQueue.length > 0) {
    const task = _transcriptScanQueue.shift();
    if (task.epoch !== _transcriptScanEpoch) continue;
    const record = _transcriptAggregateCache.get(task.filePath);
    if (!record || record.generation !== task.generation) continue;
    _activeTranscriptScans++;
    const aggregate = task.mode === 'append'
      ? cloneTranscriptAggregate(task.baseAggregate)
      : createTranscriptAggregate(task.filePath);
    let settled = false;
    let stream = null;
    const settle = (err = null) => {
      if (settled) return;
      settled = true;
      if (_adapterShutdown || task.epoch !== _transcriptScanEpoch) return;
      if (stream) _activeTranscriptStreams.delete(stream);
      _activeTranscriptScans--;
      const currentRecord = _transcriptAggregateCache.get(task.filePath);
      if (currentRecord?.generation === task.generation) {
        currentRecord.pendingTarget = null;
        if (err) {
          _transcriptAggregateStats.scanErrors++;
        } else {
          let currentTarget = null;
          try { currentTarget = statIdentity(fs.statSync(task.filePath)); } catch { /* file disappeared */ }
          if (!sameTranscriptTarget(currentTarget, task.target)) {
            _transcriptAggregateStats.staleAsyncScans++;
          } else {
            currentRecord.aggregate = finishTranscriptAggregate(aggregate, task.target);
            _transcriptAggregateStats.asyncCompletions++;
          }
        }
        touchTranscriptRecord(task.filePath, currentRecord);
      }
      notifyTranscriptDataReady(task.filePath, err ? 'transcript-scan-error' : 'transcript-scan-complete');
      setImmediate(runNextTranscriptScan);
    };

    if (task.start >= task.target.size) {
      settle();
      continue;
    }
    try {
      stream = fs.createReadStream(task.filePath, {
        start: task.start,
        end: task.target.size - 1,
        highWaterMark: TRANSCRIPT_SCAN_CHUNK_BYTES,
      });
    } catch (err) {
      settle(err);
      continue;
    }
    _activeTranscriptStreams.set(stream, { task, aggregate });
    stream.on('data', (chunk) => {
      if (_adapterShutdown || task.epoch !== _transcriptScanEpoch) return;
      processTranscriptChunk(aggregate, chunk);
      _transcriptAggregateStats.bytesRead += chunk.length;
    });
    stream.once('error', settle);
    stream.once('end', () => settle());
  }
}

function scheduleTranscriptScan(filePath, record, target, mode, baseAggregate, start) {
  if (_adapterShutdown || _transcriptScanQueue.length >= TRANSCRIPT_SCAN_QUEUE_MAX) {
    _transcriptAggregateStats.queueRejections++;
    return false;
  }
  record.generation = (record.generation || 0) + 1;
  record.pendingTarget = target;
  if (!touchTranscriptRecord(filePath, record)) {
    record.generation++;
    record.pendingTarget = null;
    touchTranscriptRecord(filePath, record);
    _transcriptAggregateStats.queueRejections++;
    return false;
  }
  _transcriptScanQueue.push({
    filePath,
    target,
    mode,
    baseAggregate,
    start,
    generation: record.generation,
    epoch: _transcriptScanEpoch,
  });
  _transcriptAggregateStats.asyncScans++;
  setImmediate(runNextTranscriptScan);
  return true;
}

function getTranscriptAggregate(filePath) {
  if (_adapterShutdown) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    deleteTranscriptRecord(filePath);
    return null;
  }
  const target = statIdentity(stat);
  let record = _transcriptAggregateCache.get(filePath);
  if (!record) record = { aggregate: null, pendingTarget: null, generation: 0 };
  touchTranscriptRecord(filePath, record);

  if (record.pendingTarget) return record.aggregate;
  const cached = record.aggregate;
  if (cached && sameTranscriptTarget(cached, target)) return cached;

  let mode = 'full';
  let start = 0;
  if (cached) {
    if (cached.dev !== target.dev || cached.ino !== target.ino) {
      _transcriptAggregateStats.rotations++;
    } else if (target.size < cached.size) {
      _transcriptAggregateStats.truncations++;
    } else if (target.size === cached.size) {
      _transcriptAggregateStats.rewrites++;
    } else if (transcriptGuardMatches(filePath, cached)) {
      mode = 'append';
      start = cached.size;
    } else {
      _transcriptAggregateStats.guardMismatches++;
      _transcriptAggregateStats.rewrites++;
    }
  }

  if (mode === 'append') _transcriptAggregateStats.incrementalScans++;
  else _transcriptAggregateStats.fullScans++;
  const bytesToRead = target.size - start;
  if (bytesToRead > TRANSCRIPT_ASYNC_THRESHOLD_BYTES) {
    scheduleTranscriptScan(filePath, record, target, mode, cached, start);
    return cached;
  }

  try {
    record.aggregate = scanTranscriptRangeSync(filePath, target, mode, cached, start);
    touchTranscriptRecord(filePath, record);
    return record.aggregate;
  } catch {
    _transcriptAggregateStats.scanErrors++;
    return cached;
  }
}

function shutdownClaudeAdapter() {
  if (_adapterShutdown) return;
  _adapterShutdown = true;
  _transcriptScanEpoch++;
  _dataReadyCallback = null;

  _transcriptAggregateStats.cancelledQueuedScans += _transcriptScanQueue.length;
  _transcriptAggregateStats.cancelledActiveScans += _activeTranscriptStreams.size;
  _transcriptScanQueue.length = 0;

  const streams = Array.from(_activeTranscriptStreams.keys());
  _activeTranscriptStreams.clear();
  _activeTranscriptScans = 0;
  clearTranscriptAggregateCache();
  clearSessionEntryCache();
  _orphanScanCache.filesByProjectDir.clear();
  _orphanScanCache.projectDirMtimes.clear();
  _teamMembershipWarned.clear();
  _sessionNamesCache.signature = '';
  _sessionNamesCache.value = new Map();
  _teamMembershipCache.signature = '';
  _teamMembershipCache.value = new Map();
  _teamsCache.signature = '';
  _teamsCache.value = [];

  for (const stream of streams) {
    try { stream.destroy(); } catch { /* shutdown is best effort */ }
  }
}

function summarizeToolInput(input, { maxLength = 60, basenameFile = true } = {}) {
  return summarizeSharedToolInput(input, {
    fields: CLAUDE_TOOL_INPUT_FIELDS,
    basenameFields: basenameFile ? ['file_path'] : [],
    maxLength,
    missingValue: null,
    stringFallback: 'none',
    objectFallback: 'none',
  });
}

function getFirstUserPrompt(filePath) {
  const entries = readJsonLines(filePath, { from: 'start', count: 200 });
  for (const entry of entries) {
    if (entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.find(block => block.type === 'text' && block.text)?.text;
      if (text) return text;
    }
  }
  return null;
}

function getAgentLaunches(sessionFilePath) {
  try {
    const aggregate = getTranscriptAggregate(sessionFilePath);
    return aggregate?.displayLaunches || aggregate?.launches || [];
  } catch {
    return [];
  }
}

// ─── Session parsing ────────────────────────────────────────

function getClaudeTranscriptSummary(filePath, tailCount) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  if (!filePath || !fs.existsSync(filePath)) return detail;

  try {
    const entries = tailEntries(filePath, tailCount);

    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i].message;
      if (!msg || msg.role !== 'assistant') continue;

      if (!detail.model && msg.model) detail.model = msg.model;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!detail.lastTool && block.type === 'tool_use') {
          detail.lastTool = block.name || null;
          detail.lastToolInput = summarizeToolInput(block.input, { maxLength: 60, basenameFile: true });
        }
        if (!detail.lastMessage && block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) detail.lastMessage = text.substring(0, 80);
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch { /* ignore */ }

  return detail;
}

function getClaudeMainSessionSummary(sessionId, projectPath) {
  if (!projectPath) return getClaudeTranscriptSummary(null, 30);
  const encoded = projectPath.replace(/\//g, '-');
  return getClaudeTranscriptSummary(path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`), 30);
}

function getSubAgentDetail(filePath) {
  return getClaudeTranscriptSummary(filePath, 20);
}

function getToolHistory(sessionFilePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = tailEntries(sessionFilePath, 100);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const detail = summarizeToolInput(block.input, { maxLength: 80, basenameFile: false }) || '';
        tools.push({ tool: block.name || 'unknown', detail, ts: entry.timestamp || 0 });
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function getRecentMessages(sessionFilePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = tailEntries(sessionFilePath, 60);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg) continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'text' || !block.text) continue;
        const text = block.text.trim();
        if (text.length === 0) continue;
        messages.push({ role: msg.role, text: text.substring(0, 200), ts: entry.timestamp || 0 });
      }
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function getTokenUsage(sessionFilePath) {
  try {
    const aggregate = getTranscriptAggregate(sessionFilePath);
    return aggregate ? { ...(aggregate.displayUsage || aggregate.usage) } : emptyTokenUsage();
  } catch { /* ignore */ }
  return emptyTokenUsage();
}

// Latest plan/act permission mode for a session. Transcripts carry sparse
// `permissionMode` markers ('default' | 'plan' | 'acceptEdits' |
// 'bypassPermissions') on user prompt entries and dedicated
// `type: 'permission-mode'` lines emitted on mode changes, so the newest
// marker in the cached tail window is the current mode. Best effort: null
// when no marker is inside the window.
function getPermissionMode(sessionFilePath) {
  try {
    const entries = getSessionEntries(sessionFilePath);
    for (let i = entries.length - 1; i >= 0; i--) {
      const mode = entries[i].permissionMode;
      if (typeof mode === 'string' && mode) return mode;
    }
  } catch { /* ignore */ }
  return null;
}

function readSendMessageRecipient(input) {
  for (const field of SEND_MESSAGE_RECIPIENT_FIELDS) {
    const value = input?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Sender→recipient edges from SendMessage tool calls. The sender is the
// session carrying the edge; `recipient` is the raw alias from the tool
// input (team agent name), left unresolved so consumers can match it
// against agentName/name/agentId. Edges without a resolvable recipient
// (e.g. shutdown_response replies keyed by request_id) are skipped.
function getSendMessageEdges(sessionFilePath, maxItems = SEND_MESSAGE_MAX_EDGES) {
  const edges = [];
  try {
    const entries = getSessionEntries(sessionFilePath);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type !== 'tool_use' || block.name !== 'SendMessage' || !block.input) continue;
        const recipient = readSendMessageRecipient(block.input);
        if (!recipient) continue;
        const summary = typeof block.input.summary === 'string' ? block.input.summary.trim() : '';
        edges.push({
          recipient,
          messageType: typeof block.input.type === 'string' && block.input.type ? block.input.type : 'message',
          summary: summary ? summary.substring(0, 80) : null,
          ts: entry.timestamp || 0,
        });
      }
    }
  } catch { /* ignore */ }
  return edges.slice(-maxItems);
}

function getGitEvents(sessionFilePath, context) {
  const events = [];
  try {
    const entries = getSessionEntries(sessionFilePath);

    // Index tool_result blocks by tool_use_id so we can surface push stderr
    // back into the parser context (rejected vs. failed disambiguation).
    const resultsByToolUseId = new Map();
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
        const tur = entry.toolUseResult;
        const parts = [];
        if (tur) {
          if (typeof tur.stderr === 'string') parts.push(tur.stderr);
          if (typeof tur.stdout === 'string') parts.push(tur.stdout);
        }
        if (typeof block.content === 'string') {
          parts.push(block.content);
        } else if (Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
          }
        }
        resultsByToolUseId.set(block.tool_use_id, {
          stderr: parts.join('\n'),
          isError: block.is_error === true,
        });
      }
    }

    entries.forEach((entry, entryIndex) => {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;

      msg.content.forEach((block, blockIndex) => {
        if (block.type !== 'tool_use' || !block.input) return;
        const result = block.id ? resultsByToolUseId.get(block.id) : null;
        events.push(...extractGitEventsFromCommandSource(block.input, {
          ...context,
          ts: entry.timestamp || entry.created_at || 0,
          sourceId: block.id || entry.uuid || entry.id || `${stableHash(JSON.stringify(entry))}:${blockIndex}`,
          stderr: result?.stderr || '',
        }));
      });
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

function resolveSessionFilePath(sessionId, project) {
  if (!project) return null;
  const encoded = project.replace(/\//g, '-');
  const projectsDir = path.join(CLAUDE_DIR, 'projects', encoded);

  if (sessionId.startsWith('subagent-')) {
    const agentId = sessionId.replace('subagent-', '');
    try {
      const sessionDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of sessionDirs) {
        const subagentsDir = path.join(projectsDir, dir.name, 'subagents');
        const agentFile = safeExistingFile(path.join(subagentsDir, `agent-${agentId}.jsonl`), projectsDir);
        if (agentFile) return agentFile;

        // Workflow sub-agents are nested under subagents/workflows/<wfRunId>/.
        const workflowsDir = path.join(subagentsDir, 'workflows');
        let runDirs;
        try {
          runDirs = fs.readdirSync(workflowsDir, { withFileTypes: true })
            .filter(d => d.isDirectory());
        } catch { continue; }
        for (const runDir of runDirs) {
          const nested = safeExistingFile(path.join(workflowsDir, runDir.name, `agent-${agentId}.jsonl`), projectsDir);
          if (nested) return nested;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  return safeExistingFile(path.join(projectsDir, `${sessionId}.jsonl`), projectsDir);
}

function getSessionFileActivity(sessionId, project) {
  if (!project) return 0;
  const encoded = project.replace(/\//g, '-');
  const sessionFile = path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(sessionFile)) return fs.statSync(sessionFile).mtimeMs;
  } catch { /* ignore */ }
  return 0;
}

function resolveProjectPathFromMap(projectPathMap, encodedProject) {
  return projectPathMap.get(encodedProject)
    || `/${encodedProject.replace(/^-/, '').replace(/-/g, '/')}`;
}

// Cached .jsonl listing for a project directory. A directory's mtime only
// changes when entries are added/removed, so an unchanged mtime lets us reuse
// the previous listing and skip the readdir. Callers still stat each returned
// file, so freshly appended (active) sessions are detected regardless.
function listProjectSessionFiles(projPath) {
  let dirMtime;
  try {
    dirMtime = fs.statSync(projPath).mtimeMs;
  } catch {
    return [];
  }
  const previous = _orphanScanCache.projectDirMtimes.get(projPath);
  const cached = _orphanScanCache.filesByProjectDir.get(projPath);
  if (
    cached
    && previous !== undefined
    && Math.abs(dirMtime - previous) <= ORPHAN_DIR_MTIME_EPSILON_MS
  ) {
    _orphanScanCache.filesByProjectDir.delete(projPath);
    _orphanScanCache.filesByProjectDir.set(projPath, cached);
    _orphanScanCache.projectDirMtimes.delete(projPath);
    _orphanScanCache.projectDirMtimes.set(projPath, previous);
    return cached;
  }
  let files;
  try {
    files = fs.readdirSync(projPath)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));
  } catch {
    return cached || [];
  }
  _orphanScanCache.projectDirMtimes.set(projPath, dirMtime);
  _orphanScanCache.filesByProjectDir.set(projPath, files);
  while (_orphanScanCache.filesByProjectDir.size > ORPHAN_SCAN_CACHE_MAX) {
    const oldest = _orphanScanCache.filesByProjectDir.keys().next().value;
    _orphanScanCache.filesByProjectDir.delete(oldest);
    _orphanScanCache.projectDirMtimes.delete(oldest);
  }
  return files;
}

// ─── Workflow sub-agents ────────────────────────────────────
// The Workflow tool spawns its sub-agents under
//   <sessionDir>/subagents/workflows/<wfRunId>/agent-<id>.jsonl
// (one level deeper than ordinary Task sub-agents) and persists the run's
// script as <sessionDir>/workflows/scripts/<workflowName>-<wfRunId>.js. The
// human-facing workflow name is only recoverable from that script filename.

function readWorkflowName(sessionDir, wfRunId) {
  const scriptsDir = path.join(sessionDir, 'workflows', 'scripts');
  let files;
  try { files = fs.readdirSync(scriptsDir); } catch { return null; }
  const suffix = `-${wfRunId}.js`;
  for (const file of files) {
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return null;
}

// Freshest mtime across a session's ordinary and workflow sub-agent
// transcripts. A long-running orchestrator can leave its own .jsonl untouched
// for minutes while its (possibly nested workflow) children write constantly,
// so the parent's liveness must follow its children.
function latestSubAgentActivity(sessionDir) {
  let latest = 0;
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return latest;
  const scan = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      try {
        const m = fs.statSync(path.join(dir, name)).mtimeMs;
        if (m > latest) latest = m;
      } catch { /* ignore */ }
    }
  };
  scan(subagentsDir);
  const workflowsDir = path.join(subagentsDir, 'workflows');
  let runDirs;
  try { runDirs = fs.readdirSync(workflowsDir, { withFileTypes: true }); } catch { runDirs = []; }
  for (const dir of runDirs) {
    if (dir.isDirectory()) scan(path.join(workflowsDir, dir.name));
  }
  return latest;
}

function buildSubAgentSession({ filePath, agentId, decodedProject, parentSessionId, name, agentType, workflowId = null, workflowName = null, lastActivity }) {
  const detail = getSubAgentDetail(filePath);
  const sessionId = `subagent-${agentId}`;
  return {
    sessionId,
    provider: 'claude',
    agentId,
    name: name || null,
    agentName: name || null,
    agentType,
    model: detail.model || 'unknown',
    status: 'active',
    lastActivity,
    project: decodedProject,
    lastMessage: detail.lastMessage,
    lastTool: detail.lastTool,
    lastToolInput: detail.lastToolInput,
    tokenUsage: getTokenUsage(filePath),
    permissionMode: getPermissionMode(filePath),
    sendMessages: getSendMessageEdges(filePath),
    gitEvents: getGitEvents(filePath, { provider: 'claude', sessionId, project: decodedProject }),
    parentSessionId,
    workflowId,
    workflowName,
  };
}

// ─── Adapter class ────────────────────────────────────

class ClaudeAdapter {
  get name() { return 'Claude Code'; }
  get provider() { return 'claude'; }
  get homeDir() { return CLAUDE_DIR; }

  isAvailable() {
    return !_adapterShutdown && fs.existsSync(CLAUDE_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    if (_adapterShutdown) return [];
    const lines = readLastLines(HISTORY_FILE, 1000);
    const entries = parseJsonLines(lines, { source: 'claude', file: HISTORY_FILE });
    const now = Date.now();
    const sessionsMap = new Map();
    const projectPathMap = new Map(); // Encoded directory name to real path
    const activeSessionIdsByProject = new Map();
    const sessionNames = readClaudeSessionNames();
    const teamMembership = readClaudeTeamMembership();

    const HISTORY_SCAN_MS = 10 * 60 * 1000;
    for (const entry of entries) {
      // Build the project path map from all entries, regardless of active state
      if (entry.project) {
        const encoded = entry.project.replace(/\//g, '-');
        projectPathMap.set(encoded, entry.project);
        if (!activeSessionIdsByProject.has(encoded)) {
          activeSessionIdsByProject.set(encoded, new Set());
        }
      }

      if (!entry.sessionId) continue;
      if (now - (entry.timestamp || 0) > HISTORY_SCAN_MS) continue;

      const existing = sessionsMap.get(entry.sessionId);
      if (!existing || (entry.timestamp || 0) > (existing.timestamp || 0)) {
        if (entry.project) {
          const encoded = entry.project.replace(/\//g, '-');
          activeSessionIdsByProject.set(encoded, activeSessionIdsByProject.get(encoded) || new Set());
          activeSessionIdsByProject.get(encoded).add(entry.sessionId);
        }
        sessionsMap.set(entry.sessionId, {
          sessionId: entry.sessionId,
          provider: 'claude',
          agentId: entry.agentId || null,
          agentType: entry.agentType || (entry.agentId ? 'sub-agent' : 'main'),
          model: entry.model || 'unknown',
          status: 'active',
          lastActivity: entry.timestamp || 0,
          project: entry.project || null,
          lastMessage: entry.display ? entry.display.substring(0, 100) : null,
        });
      }
    }

    const mainSessions = [];
    for (const session of sessionsMap.values()) {
      const fileMtime = getSessionFileActivity(session.sessionId, session.project);
      const childMtime = session.project
        ? latestSubAgentActivity(path.join(CLAUDE_DIR, 'projects', session.project.replace(/\//g, '-'), session.sessionId))
        : 0;
      const lastActive = Math.max(session.lastActivity, fileMtime, childMtime);
      if (now - lastActive > activeThresholdMs) continue;

      session.lastActivity = lastActive;
      const detail = getClaudeMainSessionSummary(session.sessionId, session.project);
      const sessionFilePath = resolveSessionFilePath(session.sessionId, session.project);
      const sessionName = sessionNames.get(session.sessionId) || null;
      const teamName = sessionName ? teamMembership.get(sessionName) || null : null;
      mainSessions.push({
        ...session,
        name: sessionName,
        agentName: sessionName,
        teamName,
        model: detail.model || session.model,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        lastMessage: detail.lastMessage || session.lastMessage,
        tokenUsage: sessionFilePath ? getTokenUsage(sessionFilePath) : null,
        permissionMode: sessionFilePath ? getPermissionMode(sessionFilePath) : null,
        sendMessages: sessionFilePath ? getSendMessageEdges(sessionFilePath) : [],
        gitEvents: sessionFilePath ? getGitEvents(sessionFilePath, {
          provider: 'claude',
          sessionId: session.sessionId,
          project: session.project,
        }) : [],
      });
    }

    mainSessions.sort((a, b) => b.lastActivity - a.lastActivity);

    // Orphan sessions (active .jsonl files whose history entry is older than HISTORY_SCAN_MS).
    // Computed before subagents so their session IDs feed into the subagent scan — otherwise
    // long-running parents that haven't logged a recent prompt would have their subagents missed.
    const orphans = this._getOrphanSessions(activeThresholdMs, projectPathMap, new Set(sessionsMap.keys()), sessionNames, teamMembership);
    for (const orphan of orphans) {
      if (!orphan.project || !orphan.sessionId) continue;
      const encoded = orphan.project.replace(/\//g, '-');
      if (!activeSessionIdsByProject.has(encoded)) activeSessionIdsByProject.set(encoded, new Set());
      activeSessionIdsByProject.get(encoded).add(orphan.sessionId);
    }

    const subAgents = this._getActiveSubAgents(activeThresholdMs, activeSessionIdsByProject, projectPathMap);

    return [...mainSessions, ...subAgents, ...orphans];
  }

  _getActiveSubAgents(activeThresholdMs, activeSessionIdsByProject = new Map(), projectPathMap = new Map()) {
    if (activeSessionIdsByProject.size === 0) return [];

    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const results = [];

    try {
      for (const [encodedProject, sessionIds] of activeSessionIdsByProject.entries()) {
        const projPath = path.join(projectsDir, encodedProject);
        if (!fs.existsSync(projPath)) continue;

        for (const sessionId of sessionIds) {
          const subagentsDir = path.join(projPath, sessionId, 'subagents');
          if (!fs.existsSync(subagentsDir)) continue;
          const sessionDir = path.join(projPath, sessionId);
          const parentSessionFile = path.join(projPath, `${sessionId}.jsonl`);
          const agentLaunches = getAgentLaunches(parentSessionFile);
          const decodedProject = resolveProjectPathFromMap(projectPathMap, encodedProject);

          // Ordinary Task sub-agents live directly under subagents/.
          let agentFiles;
          try {
            agentFiles = fs.readdirSync(subagentsDir)
              .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
          } catch { agentFiles = []; }

          for (const agentFile of agentFiles) {
            const filePath = path.join(subagentsDir, agentFile);
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }

            if (now - stat.mtimeMs > activeThresholdMs) continue;

            const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
            const prompt = getFirstUserPrompt(filePath);
            const launch = prompt
              ? agentLaunches.find(item => item.promptHash === stableHash(prompt))
              : null;

            results.push(buildSubAgentSession({
              filePath,
              agentId,
              decodedProject,
              parentSessionId: sessionId,
              name: launch?.name || null,
              agentType: launch?.agentType || 'sub-agent',
              lastActivity: stat.mtimeMs,
            }));
          }

          // Workflow sub-agents live one level deeper, grouped per run id.
          const workflowsDir = path.join(subagentsDir, 'workflows');
          let runDirs;
          try {
            runDirs = fs.readdirSync(workflowsDir, { withFileTypes: true })
              .filter(d => d.isDirectory());
          } catch { runDirs = []; }

          for (const runDir of runDirs) {
            const workflowId = runDir.name;
            const runPath = path.join(workflowsDir, workflowId);
            let runFiles;
            try {
              runFiles = fs.readdirSync(runPath)
                .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
            } catch { continue; }
            if (!runFiles.length) continue;
            const workflowName = readWorkflowName(sessionDir, workflowId);

            for (const agentFile of runFiles) {
              const filePath = path.join(runPath, agentFile);
              let stat;
              try { stat = fs.statSync(filePath); } catch { continue; }

              if (now - stat.mtimeMs > activeThresholdMs) continue;

              const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
              results.push(buildSubAgentSession({
                filePath,
                agentId,
                decodedProject,
                parentSessionId: sessionId,
                name: null,
                agentType: 'workflow-subagent',
                workflowId,
                workflowName,
                lastActivity: stat.mtimeMs,
              }));
            }
          }
        }
      }
    } catch { /* ignore */ }

    return results;
  }

  _getOrphanSessions(activeThresholdMs, projectPathMap = new Map(), knownIds = new Set(), sessionNames = new Map(), teamMembership = new Map()) {
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const results = [];

    try {
      const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      const liveProjectDirs = new Set(projDirs.map((projDir) => path.join(projectsDir, projDir.name)));
      for (const cachedPath of _orphanScanCache.filesByProjectDir.keys()) {
        if (liveProjectDirs.has(cachedPath)) continue;
        _orphanScanCache.filesByProjectDir.delete(cachedPath);
        _orphanScanCache.projectDirMtimes.delete(cachedPath);
      }

      for (const projDir of projDirs) {
        const projPath = path.join(projectsDir, projDir.name);
        const files = listProjectSessionFiles(projPath);

        for (const file of files) {
          const sessionId = file.replace('.jsonl', '');
          // Skip sessions already known
          if (knownIds.has(sessionId)) continue;

          const filePath = path.join(projPath, file);
          let stat;
          try { stat = fs.statSync(filePath); } catch { continue; }

          // Long-running parents (e.g., orchestrating audit subagents or a workflow
          // swarm) can leave their own .jsonl untouched for minutes while children
          // write constantly. Treat the session as active if either the parent file
          // or any (possibly nested workflow) subagent file is fresh.
          const lastActivity = Math.max(stat.mtimeMs, latestSubAgentActivity(path.join(projPath, sessionId)));

          if (now - lastActivity > activeThresholdMs) continue;

          const detail = getSubAgentDetail(filePath);
          const decodedProject = resolveProjectPathFromMap(projectPathMap, projDir.name);
          const sessionName = sessionNames.get(sessionId) || null;
          const teamName = sessionName ? teamMembership.get(sessionName) || null : null;

          results.push({
            sessionId,
            provider: 'claude',
            agentId: sessionId,
            name: sessionName,
            agentName: sessionName,
            teamName,
            agentType: 'team-member',
            model: detail.model || 'unknown',
            status: 'active',
            lastActivity,
            project: decodedProject,
            lastMessage: detail.lastMessage,
            lastTool: detail.lastTool,
            lastToolInput: detail.lastToolInput,
            tokenUsage: getTokenUsage(filePath),
            permissionMode: getPermissionMode(filePath),
            sendMessages: getSendMessageEdges(filePath),
            gitEvents: getGitEvents(filePath, {
              provider: 'claude',
              sessionId,
              project: decodedProject,
            }),
          });
        }
      }
    } catch { /* ignore */ }

    return results;
  }

  getSessionDetail(sessionId, project) {
    if (_adapterShutdown) return createDetailResponse({ sessionId });
    const filePath = resolveSessionFilePath(sessionId, project);
    if (!filePath) return createDetailResponse({ sessionId });
    return createDetailResponse({
      toolHistory: getToolHistory(filePath),
      messages: getRecentMessages(filePath),
      tokenUsage: getTokenUsage(filePath),
      sessionId,
    });
  }

  getWatchPaths({ sessions = [] } = {}) {
    if (_adapterShutdown) return [];
    const paths = [];
    const projectsDir = path.join(CLAUDE_DIR, 'projects');

    // Stable roots only discover immediate children. Exact active files and
    // their shallow parents below provide append and rotation coverage without
    // subscribing to every historical transcript.
    if (fs.existsSync(CLAUDE_DIR)) {
      paths.push({
        type: 'directory',
        path: CLAUDE_DIR,
        filters: ['history.jsonl', 'projects', 'sessions', 'teams'],
        scope: 'discovery',
        kind: 'discovery',
      });
    }

    if (fs.existsSync(HISTORY_FILE)) {
      paths.push({ type: 'file', path: HISTORY_FILE, scope: 'discovery', kind: 'discovery', probe: true });
    }

    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, filters: ['.json'], scope: 'discovery', kind: 'metadata' });
    }

    if (fs.existsSync(projectsDir)) {
      paths.push({ type: 'directory', path: projectsDir, scope: 'discovery', kind: 'discovery' });
    }

    if (fs.existsSync(TEAMS_DIR)) {
      paths.push({ type: 'directory', path: TEAMS_DIR, scope: 'discovery', kind: 'teams' });
      try {
        const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .slice(0, 64);
        for (const entry of teamDirs) {
          const teamDir = path.join(TEAMS_DIR, entry.name);
          paths.push({ type: 'directory', path: teamDir, filters: ['.json'], scope: 'recent', kind: 'teams' });
          const inboxDir = path.join(teamDir, 'inboxes');
          if (fs.existsSync(inboxDir)) {
            paths.push({ type: 'directory', path: inboxDir, filters: ['.json'], scope: 'recent', kind: 'teams' });
          }
        }
      } catch { /* ignore */ }
    }

    for (const session of sessions) {
      if (!session?.project || !session.sessionId) continue;
      const projectDir = path.join(projectsDir, session.project.replace(/\//g, '-'));
      const parentSessionId = session.parentSessionId || session.sessionId;
      const parentDir = path.join(projectDir, parentSessionId);
      const dirtyTarget = {
        kind: 'transcript',
        sessionId: session.sessionId,
        project: session.project,
      };
      paths.push({
        type: 'directory',
        path: projectDir,
        filters: ['.jsonl'],
        scope: 'recent',
        activity: session.lastActivity,
        ...dirtyTarget,
      });

      let sourcePath;
      if (session.agentType === 'sub-agent' || session.agentType === 'workflow-subagent') {
        const agentFile = `agent-${session.agentId}.jsonl`;
        sourcePath = session.workflowId
          ? path.join(parentDir, 'subagents', 'workflows', session.workflowId, agentFile)
          : path.join(parentDir, 'subagents', agentFile);
        paths.push({
          type: 'directory',
          path: path.dirname(sourcePath),
          filters: ['.jsonl'],
          scope: 'active',
          probe: true,
          activity: session.lastActivity,
          ...dirtyTarget,
        });
      } else {
        sourcePath = path.join(projectDir, `${session.sessionId}.jsonl`);
        paths.push({
          type: 'directory',
          path: parentDir,
          scope: 'active',
          probe: true,
          activity: session.lastActivity,
          ...dirtyTarget,
        });
      }
      if (fs.existsSync(sourcePath)) {
        paths.push({
          type: 'file',
          path: sourcePath,
          scope: 'active',
          probe: true,
          activity: session.lastActivity,
          ...dirtyTarget,
        });
      }
    }

    return paths;
  }

  // ─── Teams/tasks (Claude-only) ──────────────────────

  getTeams() {
    if (_adapterShutdown) return [];
    const signature = directorySignature(TEAMS_DIR, { recursive: true, extension: '.json' });
    if (_teamsCache.signature === signature) return _teamsCache.value;
    if (!fs.existsSync(TEAMS_DIR)) return [];
    const teams = [];
    try {
      const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of teamDirs) {
        const configPath = path.join(TEAMS_DIR, dir.name, 'config.json');
        try {
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            teams.push({ teamName: dir.name, ...config });
          }
        } catch {
          teams.push({ teamName: dir.name, error: 'parse failed' });
        }
      }
    } catch { /* ignore */ }
    _teamsCache.signature = signature;
    _teamsCache.value = teams;
    return teams;
  }

  getTasks() {
    if (_adapterShutdown) return [];
    if (!fs.existsSync(TASKS_DIR)) return [];
    const taskGroups = [];
    try {
      const taskDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of taskDirs) {
        const groupDir = path.join(TASKS_DIR, dir.name);
        const tasks = [];
        try {
          const files = fs.readdirSync(groupDir).filter(f => f.endsWith('.json'));
          for (const file of files) {
            try {
              tasks.push(JSON.parse(fs.readFileSync(path.join(groupDir, file), 'utf-8')));
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        taskGroups.push({
          groupName: dir.name,
          tasks: tasks.sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
          count: tasks.length,
        });
      }
    } catch { /* ignore */ }
    return taskGroups;
  }

  setDataReadyCallback(callback) {
    _dataReadyCallback = !_adapterShutdown && typeof callback === 'function' ? callback : null;
  }

  invalidateCachesForDirty(dirty = {}) {
    if (_adapterShutdown) return;
    if (dirty.path) deleteSessionEntryRecord(dirty.path);
    if (dirty.kind === 'transcript') return;
    if (dirty.kind === 'teams') {
      _teamMembershipCache.signature = '';
      _teamMembershipCache.value = new Map();
      _teamsCache.signature = '';
      _teamsCache.value = [];
      return;
    }

    _sessionNamesCache.signature = '';
    _sessionNamesCache.value = new Map();
    if (dirty.kind === 'discovery' || dirty.kind === 'reconcile') {
      clearSessionEntryCache();
      for (const filePath of _transcriptAggregateCache.keys()) {
        if (!fs.existsSync(filePath)) deleteTranscriptRecord(filePath);
      }
    }
    if (dirty.kind === 'reconcile') {
      for (const projectDir of _orphanScanCache.filesByProjectDir.keys()) {
        if (fs.existsSync(projectDir)) continue;
        _orphanScanCache.filesByProjectDir.delete(projectDir);
        _orphanScanCache.projectDirMtimes.delete(projectDir);
      }
    }
  }

  invalidateCaches() {
    if (_adapterShutdown) return;
    clearSessionEntryCache();
    clearTranscriptAggregateCache();
    _sessionNamesCache.signature = '';
    _sessionNamesCache.value = new Map();
    _teamMembershipCache.signature = '';
    _teamMembershipCache.value = new Map();
    _teamsCache.signature = '';
    _teamsCache.value = [];
  }

  shutdown() {
    shutdownClaudeAdapter();
  }

  dispose() {
    shutdownClaudeAdapter();
  }

  getPerfStats() {
    let pending = 0;
    for (const record of _transcriptAggregateCache.values()) {
      if (record.pendingTarget) pending++;
    }
    let workingEstimatedBytes = 0;
    for (const { aggregate } of _activeTranscriptStreams.values()) {
      workingEstimatedBytes += estimateTranscriptAggregateBytes(aggregate);
    }
    return {
      parsedTailCache: {
        ..._sessionEntryCacheStats,
        entries: _sessionEntryCache.size,
        estimatedBytes: _sessionEntryCacheBytes,
        entryLimit: SESSION_ENTRY_CACHE_MAX,
        byteLimit: SESSION_ENTRY_CACHE_MAX_BYTES,
      },
      transcriptAggregate: {
        ..._transcriptAggregateStats,
        cacheEntries: _transcriptAggregateCache.size,
        estimatedBytes: _transcriptAggregateCacheBytes,
        entryLimit: TRANSCRIPT_AGGREGATE_CACHE_MAX,
        byteLimit: TRANSCRIPT_AGGREGATE_CACHE_MAX_BYTES,
        evictions: _transcriptAggregateStats.cacheEvictions,
        workingEstimatedBytes,
        totalEstimatedBytes: _transcriptAggregateCacheBytes + workingEstimatedBytes,
        pending,
        queued: _transcriptScanQueue.length,
        active: _activeTranscriptScans,
        activeStreams: _activeTranscriptStreams.size,
        shutdown: _adapterShutdown,
        asyncThresholdBytes: TRANSCRIPT_ASYNC_THRESHOLD_BYTES,
        maxLineBytes: TRANSCRIPT_MAX_LINE_BYTES,
      },
      orphanScan: {
        projectDirectories: _orphanScanCache.filesByProjectDir.size,
      },
      teamMembershipWarnings: _teamMembershipWarned.size,
    };
  }
}

module.exports = { ClaudeAdapter };
