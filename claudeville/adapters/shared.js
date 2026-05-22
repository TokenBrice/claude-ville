const fs = require('fs');

const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;

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

function readTailLines(filePath, count, {
  chunkBytes = DEFAULT_TAIL_CHUNK_BYTES,
  maxBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size === 0) return [];

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

      const text = chunks.join('').trim();
      return text ? text.split('\n').slice(-count) : [];
    } finally {
      fs.closeSync(fd);
    }
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

function parseJsonLines(lines) {
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // Provider JSONL files can contain partial trailing writes. Ignore them.
    }
  }
  return results;
}

function readJsonLines(filePath, options = {}) {
  return parseJsonLines(readLines(filePath, options));
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
  parseJsonLines,
  readHeadLines,
  readHeadText,
  readJsonLines,
  readLines,
  readTailLines,
  statCacheKey,
  summarizeToolInput,
  trimCache,
};
