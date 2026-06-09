const fs = require('fs');

const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const TAIL_STATE_CACHE_MAX = 128;
const TAIL_GUARD_BYTES = 256;

// Tail-offset cache: per (path, count) we remember the byte offset of the last
// read plus the resulting lines, so steady polling only reads appended bytes.
const _tailStateCache = new Map();

const DEFAULT_TOOL_FIELDS = Object.freeze([
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
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
  'content',
]);

function readHeadText(filePath, maxBytes = DEFAULT_HEAD_BYTES) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size === 0) return '';
      const bytesToRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return buffer.toString('utf-8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readHeadLines(filePath, count, { maxBytes = DEFAULT_HEAD_BYTES } = {}) {
  const text = readHeadText(filePath, maxBytes);
  return text ? text.split('\n').slice(0, count) : [];
}

function readByteRangeText(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = Math.max(0, fs.readSync(fd, buffer, 0, length, start));
    return { text: buffer.toString('utf-8', 0, bytesRead), bytesRead, buffer: buffer.subarray(0, bytesRead) };
  } finally {
    fs.closeSync(fd);
  }
}

// Detached copy of the last bytes of `buffer`, used as a prefix-validity guard:
// before an incremental append read, the guard window is re-read and compared so
// an inode-preserving truncate-then-rewrite falls back to a full read instead of
// being misread as a pure append.
function tailGuard(buffer) {
  const start = Math.max(0, buffer.length - TAIL_GUARD_BYTES);
  return Buffer.from(buffer.subarray(start));
}

function readTailRaw(filePath, count, chunkBytes, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return { stat, text: '' };

    const chunks = [];
    let position = stat.size;
    let bytesCollected = 0;
    let newlineCount = 0;

    while (position > 0 && newlineCount <= count && bytesCollected < maxBytes) {
      const bytesToRead = Math.min(chunkBytes, position, maxBytes - bytesCollected);
      position -= bytesToRead;

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      const chunk = buffer.toString('utf-8', 0, bytesRead);
      chunks.unshift(chunk);
      bytesCollected += bytesRead;

      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10) newlineCount++;
      }
    }

    return { stat, text: chunks.join('') };
  } finally {
    fs.closeSync(fd);
  }
}

function finalizeTailLines(lines, pending, count) {
  const all = pending ? lines.concat(pending) : lines;
  let start = 0;
  let end = all.length;
  while (start < end && !all[start].trim()) start += 1;
  while (end > start && !all[end - 1].trim()) end -= 1;
  return all.slice(Math.max(start, end - count), end);
}

function cacheTailState(cacheKey, entry) {
  _tailStateCache.delete(cacheKey);
  _tailStateCache.set(cacheKey, entry);
  trimCache(_tailStateCache, TAIL_STATE_CACHE_MAX);
}

function readTailLines(filePath, count, {
  chunkBytes = DEFAULT_TAIL_CHUNK_BYTES,
  maxBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  const cacheKey = `${filePath}\u0000${count}`;
  try {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      _tailStateCache.delete(cacheKey);
      return [];
    }
    if (stat.size === 0) {
      _tailStateCache.delete(cacheKey);
      return [];
    }

    const cached = _tailStateCache.get(cacheKey);
    if (cached && cached.ino === (stat.ino || 0) && stat.size >= cached.size) {
      if (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        // File has not grown: serve the cached tail without touching the file.
        cacheTailState(cacheKey, cached);
        return cached.result.slice();
      }
      const appendedBytes = stat.size - cached.size;
      if (appendedBytes > 0 && appendedBytes <= maxBytes && cached.pending.length <= maxBytes) {
        // Re-read the guard window just before the cached offset; a mismatch
        // means the prefix was rewritten in place, so take the full-read path.
        const guard = Buffer.isBuffer(cached.guard) ? cached.guard : Buffer.alloc(0);
        const window = readByteRangeText(filePath, cached.size - guard.length, guard.length + appendedBytes);
        const prefixIntact = window.bytesRead >= guard.length
          && window.buffer.subarray(0, guard.length).equals(guard);
        if (prefixIntact && window.bytesRead > guard.length) {
          const appendedBuffer = window.buffer.subarray(guard.length);
          const parts = (cached.pending + appendedBuffer.toString('utf-8')).split('\n');
          const pending = parts.pop();
          const lines = cached.lines.concat(parts).slice(-count);
          const entry = {
            size: cached.size + appendedBuffer.length,
            mtimeMs: stat.mtimeMs,
            ino: cached.ino,
            guard: tailGuard(Buffer.concat([guard, appendedBuffer])),
            lines,
            pending,
            result: finalizeTailLines(lines, pending, count),
          };
          cacheTailState(cacheKey, entry);
          return entry.result.slice();
        }
      }
    }

    // Full tail read: first sight, shrink/rotation, or oversized append.
    const { stat: readStat, text } = readTailRaw(filePath, count, chunkBytes, maxBytes);
    if (!text) {
      _tailStateCache.delete(cacheKey);
      return [];
    }
    const parts = text.split('\n');
    const pending = parts.pop();
    const lines = parts.slice(-count);
    const entry = {
      size: readStat.size,
      mtimeMs: readStat.mtimeMs,
      ino: readStat.ino || 0,
      guard: tailGuard(Buffer.from(text, 'utf-8')),
      lines,
      pending,
      result: finalizeTailLines(lines, pending, count),
    };
    cacheTailState(cacheKey, entry);
    return entry.result.slice();
  } catch {
    return [];
  }
}

function readLines(filePath, {
  from = 'end',
  count = 50,
  headMaxBytes = DEFAULT_HEAD_BYTES,
  tailChunkBytes = DEFAULT_TAIL_CHUNK_BYTES,
  tailMaxBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  if (from === 'start') return readHeadLines(filePath, count, { maxBytes: headMaxBytes });
  return readTailLines(filePath, count, { chunkBytes: tailChunkBytes, maxBytes: tailMaxBytes });
}

// Per-source JSONL parse diagnostics, surfaced via /api/perf as jsonlDiagnostics.
// Sources are adapter provider ids; calls without a source land under 'unknown'.
const _jsonlDiagnostics = new Map();
const JSONL_DEBUG = process.env.CLAUDEVILLE_DEBUG_JSONL === '1';

function _jsonlStatsFor(source) {
  const key = source || 'unknown';
  let stats = _jsonlDiagnostics.get(key);
  if (!stats) {
    stats = { parsedLines: 0, skippedLines: 0, trailingPartials: 0, lastSkipped: null };
    _jsonlDiagnostics.set(key, stats);
  }
  return stats;
}

// Byte offset of lines[index] relative to the start of the read window the
// lines came from (tail reads do not start at byte 0 of the file).
function _windowByteOffset(lines, index) {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    offset += Buffer.byteLength(lines[i], 'utf-8') + 1; // +1 for the newline
  }
  return offset;
}

function _recordSkippedLine(stats, source, file, lines, index) {
  stats.skippedLines += 1;
  const windowByteOffset = _windowByteOffset(lines, index);
  stats.lastSkipped = {
    file: file || null,
    windowByteOffset,
    lineBytes: Buffer.byteLength(lines[index], 'utf-8'),
    ts: Date.now(),
  };
  if (JSONL_DEBUG) {
    console.warn(
      `[jsonl] skipped malformed line (source=${source || 'unknown'} file=${file || 'n/a'} `
      + `windowByteOffset=${windowByteOffset} lineBytes=${stats.lastSkipped.lineBytes}): `
      + `${lines[index].slice(0, 120)}`,
    );
  }
}

function getJsonlDiagnostics() {
  const out = {};
  for (const [source, stats] of _jsonlDiagnostics) {
    out[source] = {
      parsedLines: stats.parsedLines,
      skippedLines: stats.skippedLines,
      trailingPartials: stats.trailingPartials,
      lastSkipped: stats.lastSkipped,
    };
  }
  return out;
}

function parseJsonLines(lines, { source, file } = {}) {
  const stats = _jsonlStatsFor(source);
  let lastContentIndex = lines.length - 1;
  while (lastContentIndex >= 0 && !lines[lastContentIndex].trim()) lastContentIndex -= 1;
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
      stats.parsedLines += 1;
    } catch {
      // Provider JSONL files can contain partial trailing writes. A malformed
      // final line is expected mid-write; count it separately from mid-window
      // skips, which indicate real silent data loss (see /api/perf).
      if (i === lastContentIndex) {
        stats.trailingPartials += 1;
      } else {
        _recordSkippedLine(stats, source, file, lines, i);
      }
    }
  }
  return results;
}

function readJsonLines(filePath, options = {}) {
  return parseJsonLines(readLines(filePath, options), {
    source: options.source,
    file: filePath,
  });
}

function statCacheKey(filePath, stat) {
  return `${filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino || 0}`;
}

function fileSignature(filePath) {
  try {
    return statCacheKey(filePath, fs.statSync(filePath));
  } catch {
    return 'missing';
  }
}

function trimCache(cache, maxSize) {
  while (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function truncateText(value, maxLength, { compactWhitespace = false, ellipsis = false, falseyAsEmpty = false } = {}) {
  let text = falseyAsEmpty ? String(value || '') : String(value);
  if (compactWhitespace) text = text.replace(/\s+/g, ' ').trim();
  if (!ellipsis) return text.substring(0, maxLength);
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function resolveToolField(input, field) {
  if (!input || typeof input !== 'object') return undefined;
  if (field === 'targets' && Array.isArray(input.targets)) return input.targets.join(',');
  return input[field];
}

function basenameForSummary(value) {
  return String(value).split('/').pop();
}

function fallbackSummary(input, mode, options) {
  if (mode === 'json') return truncateText(JSON.stringify(input), options.maxLength, options);
  if (mode === 'string') return truncateText(input, options.maxLength, options);
  if (mode === 'empty') return '';
  return options.missingValue;
}

function summarizeToolInput(input, options = {}) {
  const resolved = {
    maxLength: 60,
    fields: DEFAULT_TOOL_FIELDS,
    basenameFields: ['file_path'],
    parseJsonStrings: false,
    missingValue: null,
    stringFallback: 'string',
    objectFallback: 'none',
    emptyObjectValue: undefined,
    requireTruthyField: true,
    compactWhitespace: false,
    ellipsis: false,
    ...options,
  };

  if (!input) return resolved.missingValue;

  let value = input;
  if (typeof input === 'string') {
    if (!resolved.parseJsonStrings) {
      return fallbackSummary(input, resolved.stringFallback, resolved);
    }
    try {
      value = JSON.parse(input);
    } catch {
      return fallbackSummary(input, resolved.stringFallback, resolved);
    }
  }

  if (!value || typeof value !== 'object') return resolved.missingValue;

  if (
    resolved.emptyObjectValue !== undefined
    && !Array.isArray(value)
    && Object.keys(value).length === 0
  ) {
    return resolved.emptyObjectValue;
  }

  const basenameFields = new Set(resolved.basenameFields || []);
  for (const field of resolved.fields || DEFAULT_TOOL_FIELDS) {
    let fieldValue = resolveToolField(value, field);
    const hasValue = resolved.requireTruthyField ? Boolean(fieldValue) : fieldValue != null;
    if (!hasValue) continue;
    if (basenameFields.has(field)) fieldValue = basenameForSummary(fieldValue);
    return truncateText(fieldValue, resolved.maxLength, resolved);
  }

  return fallbackSummary(value, resolved.objectFallback, resolved);
}

function createDetailResponse({
  provider,
  sessionId,
  project,
  toolHistory = [],
  messages = [],
  tokenUsage = null,
  gitEvents,
  agentName,
  ...extra
} = {}) {
  const detail = {
    ...extra,
    toolHistory: Array.isArray(toolHistory) ? toolHistory : [],
    messages: Array.isArray(messages) ? messages : [],
    tokenUsage,
  };
  if (provider !== undefined) detail.provider = provider;
  if (sessionId !== undefined) detail.sessionId = sessionId;
  if (project !== undefined) detail.project = project;
  if (gitEvents !== undefined) detail.gitEvents = Array.isArray(gitEvents) ? gitEvents : [];
  if (agentName !== undefined) detail.agentName = agentName;
  return detail;
}

module.exports = {
  createDetailResponse,
  fileSignature,
  getJsonlDiagnostics,
  parseJsonLines,
  readByteRangeText,
  readHeadLines,
  readHeadText,
  readJsonLines,
  readLines,
  readTailLines,
  statCacheKey,
  summarizeToolInput,
  tailGuard,
  trimCache,
};
