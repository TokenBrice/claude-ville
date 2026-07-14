const fs = require('fs');

const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const TAIL_STATE_CACHE_MAX = 128;
const TAIL_STATE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TAIL_GUARD_BYTES = 256;

// Tail-offset cache: one largest requested window per path. Smaller callers
// derive their view instead of retaining overlapping copies of the same tail.
const _tailStateCache = new Map();
let _tailStateCacheBytes = 0;

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
    if (stat.size === 0) return { stat, buffer: Buffer.alloc(0), bytesCollected: 0 };

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

      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesCollected += bytesRead;

      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) newlineCount++;
      }
    }

    let buffer = Buffer.concat(chunks, bytesCollected);
    if (position > 0) {
      const boundary = Buffer.allocUnsafe(1);
      const boundaryBytes = fs.readSync(fd, boundary, 0, 1, position - 1);
      const startsOnLineBoundary = boundaryBytes === 1 && boundary[0] === 10;
      if (!startsOnLineBoundary) {
        // The bounded window starts in the middle of an older line. Drop that
        // prefix so callers never mistake an expected tail boundary for corrupt
        // provider JSONL (and never decode a split UTF-8 prefix).
        const firstNewline = buffer.indexOf(10);
        buffer = firstNewline === -1 ? Buffer.alloc(0) : buffer.subarray(firstNewline + 1);
      }
    }
    return { stat, buffer, bytesCollected: buffer.length };
  } finally {
    fs.closeSync(fd);
  }
}

function splitLineBuffer(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 10) continue;
    lines.push(buffer.toString('utf-8', start, index));
    start = index + 1;
  }
  const pendingBuffer = Buffer.from(buffer.subarray(start));
  return {
    lines,
    pendingBuffer,
  };
}

function finalizeTailLines(lines, pendingBuffer, count) {
  const pending = pendingBuffer?.length ? pendingBuffer.toString('utf-8') : '';
  const all = pending ? lines.concat(pending) : lines;
  let start = 0;
  let end = all.length;
  while (start < end && !all[start].trim()) start += 1;
  while (end > start && !all[end - 1].trim()) end -= 1;
  return all.slice(Math.max(start, end - count), end);
}

function tailStateBytes(entry) {
  if (!entry) return 0;
  let bytes = entry.guard?.byteLength || 0;
  bytes += entry.pendingBuffer?.byteLength || 0;
  for (const line of entry.lines || []) bytes += Buffer.byteLength(line, 'utf-8');
  return bytes;
}

function deleteTailState(filePath) {
  const previous = _tailStateCache.get(filePath);
  if (previous) _tailStateCacheBytes -= previous.estimatedBytes || tailStateBytes(previous);
  _tailStateCache.delete(filePath);
  _tailStateCacheBytes = Math.max(0, _tailStateCacheBytes);
}

function cacheTailState(filePath, entry) {
  deleteTailState(filePath);
  entry.estimatedBytes = tailStateBytes(entry);
  _tailStateCache.set(filePath, entry);
  _tailStateCacheBytes += entry.estimatedBytes;
  while (_tailStateCache.size > TAIL_STATE_CACHE_MAX || _tailStateCacheBytes > TAIL_STATE_CACHE_MAX_BYTES) {
    const oldestPath = _tailStateCache.keys().next().value;
    if (oldestPath == null) break;
    deleteTailState(oldestPath);
  }
}

function readTailLines(filePath, count, {
  chunkBytes = DEFAULT_TAIL_CHUNK_BYTES,
  maxBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  const requestedCount = Math.max(1, Number(count) || 1);
  try {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      deleteTailState(filePath);
      return [];
    }
    if (stat.size === 0) {
      deleteTailState(filePath);
      return [];
    }

    const cached = _tailStateCache.get(filePath);
    const cacheCoversRequest = cached
      && cached.capacity >= requestedCount
      && (cached.lines.length >= requestedCount || cached.maxBytes >= maxBytes);
    if (cacheCoversRequest && cached.ino === (stat.ino || 0) && stat.size >= cached.size) {
      if (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        // File has not grown: serve the cached tail without touching the file.
        cacheTailState(filePath, cached);
        return finalizeTailLines(cached.lines, cached.pendingBuffer, requestedCount);
      }
      const appendedBytes = stat.size - cached.size;
      const pendingBytes = cached.pendingBuffer?.byteLength || 0;
      if (appendedBytes > 0 && appendedBytes <= maxBytes && pendingBytes <= maxBytes) {
        // Re-read the guard window just before the cached offset; a mismatch
        // means the prefix was rewritten in place, so take the full-read path.
        const guard = Buffer.isBuffer(cached.guard) ? cached.guard : Buffer.alloc(0);
        const window = readByteRangeText(filePath, cached.size - guard.length, guard.length + appendedBytes);
        const prefixIntact = window.bytesRead >= guard.length
          && window.buffer.subarray(0, guard.length).equals(guard);
        if (prefixIntact && window.bytesRead > guard.length) {
          const appendedBuffer = window.buffer.subarray(guard.length);
          const carried = cached.pendingBuffer || Buffer.alloc(0);
          const split = splitLineBuffer(Buffer.concat([carried, appendedBuffer]));
          const lines = cached.lines.concat(split.lines).slice(-cached.capacity);
          const entry = {
            size: cached.size + appendedBuffer.length,
            mtimeMs: stat.mtimeMs,
            ino: cached.ino,
            guard: tailGuard(Buffer.concat([guard, appendedBuffer])),
            lines,
            pendingBuffer: split.pendingBuffer,
            capacity: cached.capacity,
            maxBytes: Math.max(cached.maxBytes, maxBytes),
          };
          cacheTailState(filePath, entry);
          return finalizeTailLines(lines, split.pendingBuffer, requestedCount);
        }
      }
    }

    // Full tail read: first sight, shrink/rotation, or oversized append.
    const capacity = Math.max(requestedCount, cached?.capacity || 0);
    const readMaxBytes = Math.max(maxBytes, cached?.maxBytes || 0);
    const { stat: readStat, buffer } = readTailRaw(filePath, capacity, chunkBytes, readMaxBytes);
    if (!buffer.length) {
      deleteTailState(filePath);
      return [];
    }
    const split = splitLineBuffer(buffer);
    const lines = split.lines.slice(-capacity);
    const entry = {
      size: readStat.size,
      mtimeMs: readStat.mtimeMs,
      ino: readStat.ino || 0,
      guard: tailGuard(buffer),
      lines,
      pendingBuffer: split.pendingBuffer,
      capacity,
      maxBytes: readMaxBytes,
    };
    cacheTailState(filePath, entry);
    return finalizeTailLines(lines, split.pendingBuffer, requestedCount);
  } catch {
    return [];
  }
}

function getTailCacheDiagnostics() {
  return {
    entries: _tailStateCache.size,
    estimatedBytes: _tailStateCacheBytes,
    entryLimit: TAIL_STATE_CACHE_MAX,
    byteLimit: TAIL_STATE_CACHE_MAX_BYTES,
  };
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
  getTailCacheDiagnostics,
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
