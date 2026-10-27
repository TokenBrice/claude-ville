const fs = require('fs');

// Synchronous adapters may recover locally; the registry must still distinguish
// a failed observation from a confirmed empty provider slice.
const readFailures = { count: 0, code: null };
function noteReadFailure(error) {
  if (!error || ['ENOENT', 'ENOTDIR'].includes(error.code)) return;
  readFailures.count++;
  readFailures.code = error.code || 'ADAPTER_READ_FAILED';
}


const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const TAIL_STATE_CACHE_MAX = 128;
// PV-5 (a stopgap until SV-1): at 32 MB the cache held about two large Claude
// tails, so one append re-read every tail. 128 MB keeps a 12-session fleet
// resident for about 50 MB more RSS.
const TAIL_STATE_CACHE_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CLAUDEVILLE_TAIL_STATE_CACHE_MAX_BYTES || 128 * 1024 * 1024) || 128 * 1024 * 1024
);
const TAIL_GUARD_BYTES = 256;

// Tail-offset cache: one largest requested window per path. Smaller callers
// derive their view instead of retaining overlapping copies of the same tail.
const _tailStateCache = new Map();
let _tailStateCacheBytes = 0;
const _parsedTailStats = {
  hits: 0,
  misses: 0,
  parsePasses: 0,
  parsedLines: 0,
  projectedLines: 0,
  reusedLines: 0,
  rejectedEntries: 0,
  rejectedBytes: 0,
  bytesRead: 0,
  headBytesRead: 0,
};

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

// Shell input fields whose leading `cd <dir> &&` hop and `git -C <dir>` flag
// say where a command ran, not what it does. Agents prefix most calls with an
// absolute `cd`, so a bounded summary that keeps them shows only a directory.
const SHELL_COMMAND_FIELDS = new Set(['command', 'cmd']);
const SHELL_DIR_TOKEN = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const SHELL_CD_PREFIX = new RegExp(String.raw`^\s*cd\s+(${SHELL_DIR_TOKEN})\s*(?:&&|;|\n)\s*`);
const GIT_DIR_FLAG = new RegExp(String.raw`(^|[\s;&|(])git\s+-C\s+(${SHELL_DIR_TOKEN})\s+`, 'g');

/**
 * Drop leading `cd <dir> &&` / `cd <dir>;` hops and every `git -C <dir>` flag,
 * so what survives truncation is the command itself. Returns the input
 * unchanged when nothing would be left of it.
 */
function stripShellLocationPrefix(command) {
  if (typeof command !== 'string') return command;
  let text = command;
  for (let hops = 0; hops < 8; hops++) {
    const next = text.replace(SHELL_CD_PREFIX, '');
    if (next === text) break;
    text = next;
  }
  text = text.replace(GIT_DIR_FLAG, '$1git ').trim();
  return text || command;
}

/**
 * The directories `stripShellLocationPrefix` drops (the leading `cd <dir>`
 * hops, then every `git -C <dir>`), joined in order; '' when the command
 * names none. A summary without them reads the same in every directory.
 */
function shellLocationOf(command) {
  if (typeof command !== 'string') return '';
  const dirs = [];
  let text = command;
  for (let hops = 0; hops < 8; hops++) {
    const match = SHELL_CD_PREFIX.exec(text);
    if (!match) break;
    dirs.push(match[1]);
    text = text.slice(match[0].length);
  }
  for (const match of text.matchAll(GIT_DIR_FLAG)) dirs.push(match[2]);
  return dirs.join('\u001f');
}

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
      _parsedTailStats.headBytesRead += bytesRead;
      return buffer.toString('utf-8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    noteReadFailure(error);
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
      _parsedTailStats.bytesRead += Math.max(0, bytesRead);
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
      _parsedTailStats.bytesRead += Math.max(0, boundaryBytes);
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
  bytes += entry.jsonView?.estimatedBytes || 0;
  return bytes;
}

function deleteTailState(filePath) {
  const previous = _tailStateCache.get(filePath);
  if (previous) _tailStateCacheBytes -= previous.estimatedBytes || tailStateBytes(previous);
  _tailStateCache.delete(filePath);
  _tailStateCacheBytes = Math.max(0, _tailStateCacheBytes);
}

function clearTailCache(source = null) {
  if (!source) {
    _tailStateCache.clear();
    _tailStateCacheBytes = 0;
    return;
  }
  for (const [filePath, entry] of _tailStateCache) {
    if (entry.jsonView?.source === source) deleteTailState(filePath);
  }
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

    // A JSON tail keeps records, not raw lines: a raw read starts over.
    const found = _tailStateCache.get(filePath);
    const cached = found?.kind === 'json' ? null : found;
    const cacheCoversRequest = cached
      && cached.capacity >= requestedCount
      && (cached.lines.length >= requestedCount || cached.maxBytes >= maxBytes);
    if (cacheCoversRequest && cached.dev === stat.dev && cached.ino === (stat.ino || 0) && stat.size >= cached.size) {
      if (
        stat.size === cached.size
        && stat.mtimeMs === cached.mtimeMs
        && stat.ctimeMs === cached.ctimeMs
      ) {
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
        _parsedTailStats.bytesRead += window.bytesRead;
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
            ctimeMs: stat.ctimeMs,
            dev: stat.dev,
            ino: cached.ino,
            guard: tailGuard(Buffer.concat([guard, appendedBuffer])),
            lines,
            pendingBuffer: split.pendingBuffer,
            capacity: cached.capacity,
            maxBytes: Math.max(cached.maxBytes, maxBytes),
            jsonView: cached.jsonView || null,
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
      ctimeMs: readStat.ctimeMs,
      dev: readStat.dev,
      ino: readStat.ino || 0,
      guard: tailGuard(buffer),
      lines,
      pendingBuffer: split.pendingBuffer,
      capacity,
      maxBytes: readMaxBytes,
      jsonView: cached?.jsonView || null,
    };
    cacheTailState(filePath, entry);
    return finalizeTailLines(lines, split.pendingBuffer, requestedCount);
  } catch (error) {
    noteReadFailure(error);
    return [];
  }
}

function getTailCacheDiagnostics() {
  let projectionBytes = 0;
  for (const state of _tailStateCache.values()) {
    projectionBytes += state.jsonView?.estimatedBytes || 0;
  }
  return {
    entries: _tailStateCache.size,
    estimatedBytes: _tailStateCacheBytes,
    entryLimit: TAIL_STATE_CACHE_MAX,
    byteLimit: TAIL_STATE_CACHE_MAX_BYTES,
    parsed: {
      ..._parsedTailStats,
      projectionBytes,
    },
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

function parseJsonLines(lines, { source, file, project } = {}) {
  const stats = _jsonlStatsFor(source);
  let lastContentIndex = lines.length - 1;
  while (lastContentIndex >= 0 && !lines[lastContentIndex].trim()) lastContentIndex -= 1;
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      results.push(typeof project === 'function' ? project(value) : value);
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

function estimateParsedValueBytes(value) {
  const seen = new Set();
  const stack = [value];
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) {
      bytes += 8;
    } else if (typeof current === 'string') {
      bytes += 16 + (current.length * 2);
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
          bytes += 16 + (key.length * 2);
          stack.push(item);
        }
      }
    }
  }
  return bytes;
}

// SV-1 — a JSON tail state keeps the parsed (or projected) record of each
// line in its window, never the raw line text: once parsed, the text is dead
// weight, and holding both made a 3.8 MB transcript cost 14.7 MB of budget.
// An append is folded structurally (the guard proves the prefix intact), so
// only appended lines are decoded, parsed and estimated, and the window's
// estimate is a running sum of per-record estimates. A malformed last line
// keeps its text until it can be judged as a mid-window skip.
function tailRecord(record, lineBytes) {
  record.lineBytes = lineBytes;
  record.bytes = 24
    + (record.valid ? estimateParsedValueBytes(record.value) : 0)
    + (record.line ? 16 + (record.line.length * 2) : 0);
  return record;
}

function noteSkippedTailLine(stats, source, file, line, windowByteOffset) {
  stats.skippedLines += 1;
  stats.lastSkipped = {
    file: file || null,
    windowByteOffset,
    lineBytes: Buffer.byteLength(line, 'utf-8'),
    ts: Date.now(),
  };
  if (JSONL_DEBUG) {
    console.warn(
      `[jsonl] skipped malformed line (source=${source || 'unknown'} file=${file || 'n/a'} `
      + `windowByteOffset=${windowByteOffset} lineBytes=${stats.lastSkipped.lineBytes}): `
      + `${line.slice(0, 120)}`,
    );
  }
}

function parseTailLine(line, lineBytes, { source, file, project, last, offset }) {
  if (!line.trim()) return tailRecord({ valid: false, value: null, classification: 'blank' }, lineBytes);
  const stats = _jsonlStatsFor(source);
  try {
    const parsed = JSON.parse(line);
    const value = typeof project === 'function' ? project(parsed) : parsed;
    stats.parsedLines += 1;
    _parsedTailStats.parsedLines += 1;
    if (typeof project === 'function') _parsedTailStats.projectedLines += 1;
    return tailRecord({ valid: true, value, classification: 'parsed' }, lineBytes);
  } catch {
    // A malformed last line is expected mid-write; anywhere else it is real
    // silent data loss (see /api/perf).
    if (last) {
      stats.trailingPartials += 1;
      return tailRecord({ valid: false, value: null, classification: 'trailing', line }, lineBytes);
    }
    noteSkippedTailLine(stats, source, file, line, offset);
    return tailRecord({ valid: false, value: null, classification: 'skipped' }, lineBytes);
  }
}

function splitTailBuffer(buffer) {
  const lines = [];
  const lineBytes = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 10) continue;
    lines.push(buffer.toString('utf-8', start, index));
    lineBytes.push(index - start);
    start = index + 1;
  }
  return { lines, lineBytes, pendingBuffer: Buffer.from(buffer.subarray(start)) };
}

// Fold complete lines (and the bytes after the last newline) onto `base`
// records, keeping the newest `capacity` complete lines. Lines that fall out
// of the window are never parsed, as with a plain tail read.
function buildJsonTailState(base, split, identity, ctx) {
  const { capacity, source, file, project } = ctx;
  const pendingText = split.pendingBuffer.length ? split.pendingBuffer.toString('utf-8') : '';
  const total = base.records.length + split.lines.length;
  const drop = Math.max(0, total - capacity);
  const baseDrop = Math.min(drop, base.records.length);
  const firstNew = drop - baseDrop;
  let recordBytes = base.recordBytes;
  let windowBytes = base.windowBytes;
  for (let index = 0; index < baseDrop; index++) {
    recordBytes -= base.records[index].bytes;
    windowBytes -= base.records[index].lineBytes + 1;
  }
  const records = baseDrop ? base.records.slice(baseDrop) : base.records.slice();
  let lastNew = -1;
  if (!pendingText.trim()) {
    for (let index = split.lines.length - 1; index >= firstNew; index--) {
      if (split.lines[index].trim()) { lastNew = index; break; }
    }
  }
  for (let index = firstNew; index < split.lines.length; index++) {
    const line = split.lines[index];
    const reused = index === 0 && base.pendingText && line === base.pendingText ? base.pendingRecord : null;
    const record = reused || parseTailLine(line, split.lineBytes[index], {
      source, file, project, last: index === lastNew, offset: windowBytes,
    });
    records.push(record);
    recordBytes += record.bytes;
    windowBytes += record.lineBytes + 1;
  }
  // A malformed line is "trailing" only while it is the last line with
  // content; once newer content follows it, it is a mid-window skip.
  let lastContent = pendingText.trim() ? records.length : -1;
  for (let index = records.length - 1; lastContent < 0 && index >= 0; index--) {
    if (records[index].classification !== 'blank') lastContent = index;
  }
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.classification !== 'trailing' || index === lastContent) continue;
    let offset = 0;
    for (let prior = 0; prior < index; prior++) offset += records[prior].lineBytes + 1;
    noteSkippedTailLine(_jsonlStatsFor(source), source, file, record.line, offset);
    records[index] = tailRecord({ valid: false, value: null, classification: 'skipped' }, record.lineBytes);
    recordBytes += records[index].bytes - record.bytes;
  }
  const pendingRecord = pendingText
    ? parseTailLine(pendingText, split.pendingBuffer.length, { source, file, project, last: true, offset: windowBytes })
    : null;
  const estimatedBytes = 64 + (records.length * 8) + recordBytes + (pendingRecord ? pendingRecord.bytes : 0);
  return {
    kind: 'json',
    ...identity,
    capacity,
    maxBytes: ctx.maxBytes,
    pendingBuffer: split.pendingBuffer,
    pendingText,
    pendingRecord,
    records,
    recordBytes,
    windowBytes,
    // Summary for diagnostics and `clearTailCache(source)`.
    jsonView: { source, projectionKey: ctx.projectionKey, estimatedBytes },
  };
}

const EMPTY_JSON_TAIL = Object.freeze({ records: [], recordBytes: 0, windowBytes: 0, pendingText: '', pendingRecord: null });

function readJsonTailState(filePath, options) {
  const count = Math.max(1, Number(options.count) || 1);
  const chunkBytes = options.tailChunkBytes ?? DEFAULT_TAIL_CHUNK_BYTES;
  const maxBytes = options.tailMaxBytes ?? DEFAULT_TAIL_BYTES;
  const source = options.source || 'unknown';
  const projectionKey = typeof options.project === 'function'
    ? String(options.projectionKey || 'projected')
    : 'full';
  try {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      deleteTailState(filePath);
      return null;
    }
    if (stat.size === 0) {
      deleteTailState(filePath);
      return null;
    }
    const ctx = { source, file: filePath, project: options.project, projectionKey };
    const found = _tailStateCache.get(filePath);
    const cached = found?.kind === 'json'
      && found.jsonView.source === source
      && found.jsonView.projectionKey === projectionKey
      ? found
      : null;
    const covers = cached
      && cached.capacity >= count
      && (cached.records.length >= count || cached.maxBytes >= maxBytes);
    if (covers && cached.dev === stat.dev && cached.ino === (stat.ino || 0) && stat.size >= cached.size) {
      if (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs && stat.ctimeMs === cached.ctimeMs) {
        // Unchanged: serve the parsed window without touching the file.
        _parsedTailStats.hits += 1;
        _parsedTailStats.reusedLines += cached.records.length;
        cacheTailState(filePath, cached);
        return cached;
      }
      const appendedBytes = stat.size - cached.size;
      const pendingBytes = cached.pendingBuffer.byteLength;
      if (appendedBytes > 0 && appendedBytes <= maxBytes && pendingBytes <= maxBytes) {
        // Re-read the guard window just before the cached offset; a mismatch
        // means the prefix was rewritten in place, so take the full-read path.
        const guard = cached.guard;
        const window = readByteRangeText(filePath, cached.size - guard.length, guard.length + appendedBytes);
        _parsedTailStats.bytesRead += window.bytesRead;
        const prefixIntact = window.bytesRead >= guard.length
          && window.buffer.subarray(0, guard.length).equals(guard);
        if (prefixIntact && window.bytesRead > guard.length) {
          const appended = window.buffer.subarray(guard.length);
          const state = buildJsonTailState(cached, splitTailBuffer(Buffer.concat([cached.pendingBuffer, appended])), {
            size: cached.size + appended.length,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            dev: stat.dev,
            ino: cached.ino,
            guard: tailGuard(Buffer.concat([guard, appended])),
          }, { ...ctx, capacity: cached.capacity, maxBytes: Math.max(cached.maxBytes, maxBytes) });
          _parsedTailStats.misses += 1;
          _parsedTailStats.parsePasses += 1;
          _parsedTailStats.reusedLines += Math.min(cached.records.length, state.records.length);
          return retainJsonTailState(filePath, state);
        }
      }
    }

    // Full tail read: first sight, shrink/rotation, rewrite, or oversized append.
    const capacity = Math.max(count, cached?.capacity || 0);
    const readMaxBytes = Math.max(maxBytes, cached?.maxBytes || 0);
    const { stat: readStat, buffer } = readTailRaw(filePath, capacity, chunkBytes, readMaxBytes);
    if (!buffer.length) {
      deleteTailState(filePath);
      return null;
    }
    const state = buildJsonTailState(EMPTY_JSON_TAIL, splitTailBuffer(buffer), {
      size: readStat.size,
      mtimeMs: readStat.mtimeMs,
      ctimeMs: readStat.ctimeMs,
      dev: readStat.dev,
      ino: readStat.ino || 0,
      guard: tailGuard(buffer),
    }, { ...ctx, capacity, maxBytes: readMaxBytes });
    _parsedTailStats.misses += 1;
    _parsedTailStats.parsePasses += 1;
    return retainJsonTailState(filePath, state);
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

function retainJsonTailState(filePath, state) {
  cacheTailState(filePath, state);
  if (_tailStateCache.get(filePath) !== state) {
    _parsedTailStats.rejectedEntries += 1;
    _parsedTailStats.rejectedBytes += state.estimatedBytes || 0;
  }
  return state;
}

// The newest `count` lines of a JSON tail, with blank edges trimmed exactly
// as a raw tail read trims them.
function jsonTailWindow(state, count) {
  const all = state.pendingRecord ? state.records.concat(state.pendingRecord) : state.records;
  let start = 0;
  let end = all.length;
  while (start < end && all[start].classification === 'blank') start += 1;
  while (end > start && all[end - 1].classification === 'blank') end -= 1;
  return all.slice(Math.max(start, end - count), end);
}

function jsonRecordWindow(records, count) {
  const start = Math.max(0, records.length - count);
  const results = [];
  for (let index = start; index < records.length; index++) {
    const record = records[index];
    if (record?.valid) results.push(record.value);
  }
  return results;
}

function jsonRecordWindows(records, counts) {
  const windows = new Map();
  for (const count of counts) windows.set(count, jsonRecordWindow(records, count));
  return windows;
}

function readJsonLines(filePath, options = {}) {
  if (options.from === 'start') {
    return parseJsonLines(readLines(filePath, options), {
      source: options.source,
      file: filePath,
      project: options.project,
    });
  }

  const windowCounts = options._windowCounts || null;
  const count = Math.max(1, Number(options.count ?? 50) || 1);
  const state = readJsonTailState(filePath, { ...options, count });
  if (!state) {
    return windowCounts
      ? new Map(windowCounts.map(windowCount => [windowCount, []]))
      : [];
  }
  const requestedRecords = jsonTailWindow(state, count);
  if (windowCounts) return jsonRecordWindows(requestedRecords, windowCounts);
  return jsonRecordWindow(requestedRecords, requestedRecords.length);
}

/**
 * Parse one largest tail and expose exact smaller line windows from the same
 * snapshot. Invalid and trailing records retain their line positions, so a
 * 50-line view has the same semantics as an independent 50-line tail read.
 */
function readJsonLineWindows(filePath, counts, options = {}) {
  const normalizedCounts = Array.from(new Set(
    (Array.isArray(counts) ? counts : [counts])
      .map(count => Math.max(1, Number(count) || 1)),
  ));
  if (!normalizedCounts.length) return new Map();
  return readJsonLines(filePath, {
    ...options,
    from: 'end',
    count: Math.max(...normalizedCounts),
    _windowCounts: normalizedCounts,
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

function normalizeCacheTokenValue(rawValue) {
  try {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeCacheTokenField(usage, fieldMap) {
  const fields = Array.isArray(fieldMap)
    ? fieldMap
    : fieldMap == null ? [] : [fieldMap];

  for (const field of fields) {
    const rawValue = typeof field === 'function' ? field(usage) : usage?.[field];
    const value = normalizeCacheTokenValue(rawValue);
    if (value !== null) return value;
  }
  return 0;
}

/**
 * Resolve provider-specific cache fields into the frontend contract.
 *
 * Each field-map value may be one field name, an ordered list of aliases, or
 * a provider-local selector function when alias precedence is not a simple
 * first-valid-number lookup. Provider parsing and error boundaries stay in
 * the adapter that owns the source format.
 */
function normalizeCacheTokens(usage, providerFieldMap = {}) {
  return {
    cacheRead: normalizeCacheTokenField(usage, providerFieldMap?.cacheRead),
    cacheCreate: normalizeCacheTokenField(usage, providerFieldMap?.cacheCreate),
  };
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
    if (SHELL_COMMAND_FIELDS.has(field)) fieldValue = stripShellLocationPrefix(fieldValue);
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
  readFailures,
  noteReadFailure,
  clearTailCache,
  createDetailResponse,
  fileSignature,
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  normalizeCacheTokens,
  parseJsonLines,
  readByteRangeText,
  readHeadLines,
  readHeadText,
  readJsonLineWindows,
  readJsonLines,
  readLines,
  readTailLines,
  shellLocationOf,
  statCacheKey,
  stripShellLocationPrefix,
  summarizeToolInput,
  tailGuard,
  trimCache,
};
