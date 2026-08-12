/**
 * Oh My Pi (OMP) agent-hub adapter.
 *
 * OMP persists one JSONL transcript for each session under
 * ~/.omp/agent/sessions/<project>/<session>.jsonl. Nested task agents are
 * stored below the parent transcript in <session>/<agent-name>.jsonl.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDetailResponse,
  readJsonLines,
  summarizeToolInput,
} = require('./shared');

const OMP_HOME = path.join(os.homedir(), '.omp');
const DEFAULT_SESSIONS_DIR = path.join(OMP_HOME, 'agent', 'sessions');
const TRANSCRIPT_HEAD_LINES = 32;
const TRANSCRIPT_TAIL_LINES = 2500;
const DETAIL_TAIL_LINES = 5000;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPTS = 4096;
const TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'cmd',
  'path',
  'filePath',
  'file_path',
  'pattern',
  'query',
  'prompt',
  'content',
  'description',
  'target',
  'recipient',
]);

function parseTimestamp(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function transcriptId(sessionId) {
  return sessionId ? `omp-${sessionId}` : '';
}

function rawSessionId(sessionId) {
  return String(sessionId || '').replace(/^omp-/, '');
}

function extractText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .filter(Boolean);
    const text = parts.join('').trim();
    return text || null;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim() || null;
  }
  return null;
}

function compactText(value, maxLength = 200) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function readUsage(rawUsage, total) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const input = number(rawUsage.input ?? rawUsage.totalInput ?? rawUsage.input_tokens);
  const output = number(rawUsage.output ?? rawUsage.totalOutput ?? rawUsage.output_tokens);
  const cacheRead = number(rawUsage.cacheRead ?? rawUsage.cache_read);
  const cacheCreate = number(rawUsage.cacheWrite ?? rawUsage.cacheCreate ?? rawUsage.cache_create);
  total.input += input;
  total.output += output;
  total.cacheRead += cacheRead;
  total.cacheCreate += cacheCreate;
  total.reasoningTokens += number(rawUsage.reasoningTokens ?? rawUsage.reasoning_tokens);
  total.turnCount += 1;
  return true;
}
function mergeRecords(head, tail) {
  const records = [];
  const seen = new Set();
  for (const record of [...head, ...tail]) {
    if (!record || typeof record !== 'object') continue;
    const key = record.id
      ? `id:${record.id}`
      : `record:${record.type || ''}:${record.timestamp || ''}:${record.parentId || ''}:${records.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return records;
}

function childParentId(filePath, sessionsDir) {
  const parentDir = path.basename(path.dirname(filePath));
  if (path.dirname(filePath) === sessionsDir) return null;
  const match = parentDir.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}

function childName(filePath, sessionsDir) {
  return childParentId(filePath, sessionsDir)
    ? path.basename(filePath, '.jsonl')
    : null;
}

function modelProvider(model) {
  const value = String(model || '');
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : null;
}

function parseOmpTranscript(records, {
  filePath = '',
  parentSessionId = null,
  childAgentName = null,
  now = Date.now(),
  activeThresholdMs = null,
  fallbackProject = null,
  detail = true,
} = {}) {
  let session = null;
  let title = null;
  let model = null;
  let underlyingProvider = null;
  let latestActivity = 0;
  let latestAssistantText = null;
  let latestAssistantTs = 0;
  let latestTool = null;
  let latestToolInput = null;
  let sawSessionExit = false;
  const pendingTools = new Map();
  const toolHistory = [];
  const messages = [];
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };

  for (const record of records || []) {
    const recordTs = parseTimestamp(record?.timestamp);
    const customTs = parseTimestamp(record?.data?.recordedAt);
    latestActivity = Math.max(latestActivity, recordTs, customTs);

    if (record?.type === 'session') {
      session = record;
      title = record.title || title;
      latestActivity = Math.max(latestActivity, parseTimestamp(record.timestamp));
      continue;
    }
    if (record?.type === 'title' || record?.type === 'title_change') {
      const nextTitle = record.title || record.data?.title;
      if (nextTitle) title = String(nextTitle);
      latestActivity = Math.max(latestActivity, parseTimestamp(record.updatedAt));
      continue;
    }
    if (record?.type === 'model_change' && record.model) {
      model = String(record.model);
      underlyingProvider = modelProvider(model) || underlyingProvider;
      continue;
    }
    if (record?.type === 'custom' && record.customType === 'session_exit') {
      sawSessionExit = true;
      continue;
    }

    const message = record?.type === 'message' ? record.message : null;
    if (!message || typeof message !== 'object') continue;
    const messageTs = parseTimestamp(message.timestamp) || recordTs;
    latestActivity = Math.max(latestActivity, messageTs);
    if (message.provider) underlyingProvider = String(message.provider);
    if (message.model) model = String(message.model);
    if (message.usage) readUsage(message.usage, usage);

    const role = String(message.role || '');
    if (role === 'assistant') {
      const text = extractText(message.content);
      if (text) {
        latestAssistantText = compactText(text);
        latestAssistantTs = messageTs;
        if (detail) messages.push({ role: 'assistant', text: compactText(text), ts: messageTs });
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!part || part.type !== 'toolCall') continue;
        const tool = String(part.name || 'tool');
        const toolCallId = String(part.id || `${tool}:${messageTs}:${toolHistory.length}`);
        const args = part.arguments ?? null;
        const entry = {
          tool,
          detail: summarizeToolInput(args, {
            fields: TOOL_INPUT_FIELDS,
            basenameFields: ['path', 'filePath', 'file_path'],
            maxLength: 80,
            missingValue: '',
            objectFallback: 'json',
            stringFallback: 'string',
            parseJsonStrings: true,
            compactWhitespace: true,
          }),
          ts: messageTs,
        };
        latestTool = tool;
        latestToolInput = entry.detail || null;
        if (detail) toolHistory.push(entry);
        pendingTools.set(toolCallId, { tool, ts: messageTs });
      }
      continue;
    }
    if (role === 'user') {
      const text = extractText(message.content);
      if (detail && text) messages.push({ role: 'user', text: compactText(text), ts: messageTs });
      continue;
    }
    if (role === 'toolResult' || role === 'tool') {
      if (message.toolCallId) pendingTools.delete(String(message.toolCallId));
    }
  }

  if (!session?.id) return null;
  const sessionId = transcriptId(String(session.id));
  const project = session.cwd || fallbackProject || null;
  const statActivity = (() => {
    try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
  })();
  latestActivity = Math.max(latestActivity, statActivity);
  if (activeThresholdMs != null && (now - latestActivity) > Number(activeThresholdMs)) return null;

  const tokenUsage = usage.turnCount > 0 ? {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreate: usage.cacheCreate,
    cacheWrite: usage.cacheCreate,
    totalInput: usage.input,
    totalOutput: usage.output,
    reasoningTokens: usage.reasoningTokens,
    reasoningInOutput: false,
    turnCount: usage.turnCount,
  } : null;
  const turnState = pendingTools.size > 0
    ? 'tool_pending'
    : (latestAssistantText || sawSessionExit ? 'awaiting_input' : 'unknown');
  const resolvedModel = model || 'omp';
  const resolvedProvider = underlyingProvider || modelProvider(resolvedModel);

  return {
    session: {
      sessionId,
      provider: 'omp',
      underlyingProvider: resolvedProvider,
      agentId: String(session.id),
      agentType: parentSessionId ? 'sub-agent' : 'main',
      agentName: childAgentName || title || null,
      project,
      model: resolvedModel,
      status: 'active',
      lastActivity: latestActivity,
      lastTool: latestTool,
      lastToolInput: latestToolInput,
      lastMessage: latestAssistantText,
      tokenUsage,
      parentSessionId: parentSessionId ? transcriptId(parentSessionId) : null,
      turnState,
      pendingTool: pendingTools.values().next().value?.tool || null,
      pendingSince: pendingTools.values().next().value?.ts || null,
    },
    detail: createDetailResponse({
      provider: 'omp',
      sessionId,
      project,
      toolHistory: toolHistory.slice(-120),
      messages: messages.slice(-40),
      tokenUsage,
      agentName: childAgentName || title || null,
      underlyingProvider: resolvedProvider,
    }),
  };
}

class OmpAdapter {
  constructor({ sessionsDir = null, rootDir = null, now = () => Date.now() } = {}) {
    this.sessionsDir = path.resolve(sessionsDir || rootDir || DEFAULT_SESSIONS_DIR);
    this.home = path.resolve(this.sessionsDir, '..', '..');
    this.now = now;
    this._index = new Map();
  }

  get name() { return 'Oh My Pi'; }
  get provider() { return 'omp'; }
  get homeDir() { return this.home; }

  isAvailable() {
    try { return fs.statSync(this.sessionsDir).isDirectory(); } catch { return false; }
  }

  _listTranscriptFiles() {
    const files = [];
    const visit = (directory) => {
      if (files.length >= MAX_TRANSCRIPTS) return;
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= MAX_TRANSCRIPTS) break;
        const current = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(current);
        else if (entry.isDirectory() && !entry.name.startsWith('.')) visit(current);
      }
    };
    visit(this.sessionsDir);
    return files;
  }

  _readRecords(filePath, lines = TRANSCRIPT_TAIL_LINES) {
    const head = readJsonLines(filePath, {
      from: 'start',
      count: TRANSCRIPT_HEAD_LINES,
      headMaxBytes: 256 * 1024,
      source: this.provider,
    });
    const tail = readJsonLines(filePath, {
      from: 'end',
      count: lines,
      tailMaxBytes: MAX_TAIL_BYTES,
      source: this.provider,
    });
    return mergeRecords(head, tail);
  }

  _parseFile(filePath, { activeThresholdMs = null, detail = false } = {}) {
    const records = this._readRecords(filePath, detail ? DETAIL_TAIL_LINES : TRANSCRIPT_TAIL_LINES);
    return parseOmpTranscript(records, {
      filePath,
      parentSessionId: childParentId(filePath, this.sessionsDir),
      childAgentName: childName(filePath, this.sessionsDir),
      now: this.now(),
      activeThresholdMs,
      detail,
    });
  }

  getActiveSessions(activeThresholdMs) {
    this._index.clear();
    const sessions = [];
    for (const filePath of this._listTranscriptFiles()) {
      const parsed = this._parseFile(filePath, { activeThresholdMs });
      if (!parsed) continue;
      this._index.set(rawSessionId(parsed.session.sessionId), { filePath, parentSessionId: parsed.session.parentSessionId });
      sessions.push(parsed.session);
    }
    return sessions;
  }

  getSessionDetail(sessionId, project) {
    const rawId = rawSessionId(sessionId);
    let entry = this._index.get(rawId);
    if (!entry) {
      for (const filePath of this._listTranscriptFiles()) {
        const parsed = this._parseFile(filePath);
        if (!parsed) continue;
        const parsedRawId = rawSessionId(parsed.session.sessionId);
        this._index.set(parsedRawId, { filePath, parentSessionId: parsed.session.parentSessionId });
        if (parsedRawId === rawId) entry = { filePath, parentSessionId: parsed.session.parentSessionId };
      }
    }
    if (!entry) return createDetailResponse({ provider: this.provider, sessionId, project: project || '' });
    const parsed = this._parseFile(entry.filePath, { detail: true });
    if (!parsed) return createDetailResponse({ provider: this.provider, sessionId, project: project || '' });
    if (project && !parsed.detail.project) parsed.detail.project = project;
    return parsed.detail;
  }

  getWatchPaths() {
    return [{ type: 'directory', path: this.sessionsDir, recursive: true, filter: '.jsonl' }];
  }

  invalidateCachesForDirty() {
    this._index.clear();
  }

  shutdown() {
    this._index.clear();
  }
}

module.exports = {
  OmpAdapter,
  parseOmpTranscript,
};
