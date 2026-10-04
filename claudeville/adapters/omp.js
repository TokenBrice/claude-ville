/**
 * Oh My Pi (OMP) agent-hub adapter.
 *
 * OMP persists one JSONL transcript for each session under
 * ~/.omp/agent/sessions/<project>/<session>.jsonl. Nested task agents are
 * stored below the parent transcript in <session>/<agent-name>.jsonl.
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDetailResponse,
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  normalizeCacheTokens,
  readJsonLines,
  summarizeToolInput,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState } = require('./turnState');

const OMP_HOME = path.join(os.homedir(), '.omp');
const DEFAULT_SESSIONS_DIR = path.join(OMP_HOME, 'agent', 'sessions');
const TRANSCRIPT_HEAD_LINES = 32;
const TRANSCRIPT_HEAD_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_LINES = 2500;
const DETAIL_TAIL_LINES = 5000;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPTS = 4096;
const RECONCILE_INTERVAL_MS = 30 * 1000;
const MAX_DIRECTORIES = 4096;
// OMP names session transcripts and their child directories
// <ISO start>_<id>, e.g. 2026-10-04T09-58-47-155Z_01a1...; lexical order is age order.
const SESSION_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
const DETAIL_DISCOVERY_MAX_FILES = 512;
const DETAIL_DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
const DETAIL_HEADER_MAX_BYTES = 4096;
const REDUCED_CACHE_MAX = 512;
const REDUCED_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const NEGATIVE_CACHE_MAX = 512;
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
const OMP_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: [usage => usage?.cacheRead ?? usage?.cache_read],
  cacheCreate: [usage => usage?.cacheWrite ?? usage?.cacheCreate ?? usage?.cache_create],
});

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
function projectPrompt(content) {
  const text = extractText(content)
    ?.replace(/<(system-reminder|advisory)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();
  return text ? text.slice(0, 200) : null;
}

function todoItems(argumentsValue) {
  const items = [];
  const append = (value, rawPhase = null) => {
    const phase = typeof rawPhase === 'string' && rawPhase.trim()
      ? rawPhase.trim().slice(0, 80)
      : null;
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const rawSubject = typeof item === 'string'
        ? item
        : (typeof item?.task === 'string' ? item.task : item?.subject);
      const key = typeof rawSubject === 'string' ? rawSubject.trim() : '';
      if (!key) continue;
      const rawStatus = typeof item?.status === 'string' ? item.status : 'pending';
      const status = ['pending', 'in_progress', 'completed'].includes(rawStatus)
        ? rawStatus
        : 'pending';
      items.push({ key, subject: key.slice(0, 200), status, phase });
    }
  };
  for (const group of Array.isArray(argumentsValue?.list) ? argumentsValue.list : []) {
    append(group?.items, typeof group?.phase === 'string' ? group.phase : null);
  }
  append(argumentsValue?.items, typeof argumentsValue?.phase === 'string' ? argumentsValue.phase : null);
  if (typeof argumentsValue?.task === 'string' && ['init', 'append'].includes(argumentsValue.op)) {
    append([argumentsValue.task], typeof argumentsValue?.phase === 'string' ? argumentsValue.phase : null);
  }
  return items;
}

function applyTodoOperation(todos, rawArguments) {
  let argumentsValue = rawArguments;
  if (typeof argumentsValue === 'string') {
    try { argumentsValue = JSON.parse(argumentsValue); } catch { return; }
  }
  if (!argumentsValue || typeof argumentsValue !== 'object') return;
  const op = argumentsValue.op;
  if (op === 'init') {
    todos.splice(0, todos.length, ...todoItems(argumentsValue));
    return;
  }
  if (op === 'append') {
    todos.push(...todoItems(argumentsValue));
    return;
  }
  if (!['done', 'start', 'drop'].includes(op)) return;
  const task = typeof argumentsValue.task === 'string' ? argumentsValue.task.trim() : null;
  const phase = typeof argumentsValue.phase === 'string' && argumentsValue.phase.trim()
    ? argumentsValue.phase.trim().slice(0, 80)
    : null;
  const matches = todo => (!task || todo.key === task) && (!phase || todo.phase === phase);
  if (!task && !phase) return;
  if (op === 'drop') {
    for (let index = todos.length - 1; index >= 0; index--) {
      if (matches(todos[index])) todos.splice(index, 1);
    }
    return;
  }
  const status = op === 'start' ? 'in_progress' : 'completed';
  for (const todo of todos) {
    if (matches(todo)) todo.status = status;
  }
}


function readUsage(rawUsage, total) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const input = number(rawUsage.input ?? rawUsage.totalInput ?? rawUsage.input_tokens);
  const output = number(rawUsage.output ?? rawUsage.totalOutput ?? rawUsage.output_tokens);
  const { cacheRead, cacheCreate } = normalizeCacheTokens(rawUsage, OMP_CACHE_FIELD_MAP);
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

function sessionStamp(name) {
  const match = SESSION_STAMP.exec(name);
  return match ? match[0] : '';
}

function descending(left, right) {
  return left < right ? 1 : left > right ? -1 : 0;
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

// Match Claude's bounded, newest-per-path transcript projection. Edit paths
// come from structured per-file results, never from patch or result prose.
function workingSetPath(value, project, readSelector = false) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  let filePath = value.trim().slice(0, 4096);
  if (readSelector) filePath = filePath.replace(/:(?:raw|img|conflicts|\d+(?:[-+]\d*)?|-\d+)(?:,\d+(?:-\d+)?)?(?=:|$)/g, '');
  if (!filePath || /[:?*]/.test(filePath) || filePath.includes(';')) return null;
  if (filePath.startsWith('~/')) filePath = path.join(os.homedir(), filePath.slice(2));
  let canonical = path.resolve(project || process.cwd(), filePath);
  try { if (fs.statSync(canonical).isDirectory()) return null; } catch { /* missing files are valid writes */ }
  let cursor = canonical;
  const suffix = [];
  while (cursor !== path.dirname(cursor)) {
    try {
      canonical = path.join(fs.realpathSync(cursor), ...suffix.reverse());
      break;
    } catch {
      suffix.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
  for (const [base, prefix] of [[project, ''], [os.homedir(), '~/']]) {
    if (!base) continue;
    let root = path.resolve(base);
    try { root = fs.realpathSync(root); } catch { /* keep resolved path */ }
    const relative = path.relative(root, canonical);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return prefix + relative.split(path.sep).join('/');
    }
  }
  return canonical.split(path.sep).join('/');
}

function reduceOmpTranscript(records, {
  filePath = '',
  parentSessionId = null,
  childAgentName = null,
  fallbackProject = null,
  detail = true,
  fileMtimeMs = null,
} = {}) {
  let session = null;
  let title = null;
  let model = null;
  let reasoningEffort = null;
  let underlyingProvider = null;
  let latestActivity = 0;
  let latestAssistantText = null;
  let latestAssistantTs = 0;
  let lastPrompt = null;
  let gitBranch = null;
  let turnStartedAt = null;
  let turnEnded = false;
  let turnEndedAt = null;
  let latestTool = null;
  let latestToolInput = null;
  const pendingTools = new Map();
  const todos = [];
  const toolHistory = [];
  const messages = [];
  const workingSet = [];
  const rememberPath = (value, op, at, readSelector = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    workingSet.push({ path: value.trim().slice(0, 4096), op, at, readSelector });
    if (workingSet.length > 64) workingSet.shift();
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };
  const dialogueBuckets = new Map();
  const observedSources = emptyObservedSources();
  const rememberDialogue = ({ text, kind, source, observedAt, actionId = null, observedKey }) => {
    if (typeof text !== 'string' || !text.trim()) return;
    observedSources[observedKey] = true;
    let bucket = dialogueBuckets.get(kind);
    if (!bucket) {
      bucket = [];
      dialogueBuckets.set(kind, bucket);
    }
    bucket.unshift({ text, kind, source, observedAt, actionId });
    if (bucket.length > 8) bucket.pop();
  };

  for (const record of records || []) {
    const recordTs = parseTimestamp(record?.timestamp);
    const customTs = parseTimestamp(record?.data?.recordedAt);
    latestActivity = Math.max(latestActivity, recordTs, customTs);
    const branch = record?.gitBranch
      ?? record?.git_branch
      ?? record?.git?.branch
      ?? record?.data?.gitBranch
      ?? record?.data?.git_branch
      ?? record?.data?.git?.branch;
    if (typeof branch === 'string' && branch.trim()) gitBranch = branch.trim().slice(0, 256);

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
    if (record?.type === 'thinking_level_change' && record.thinkingLevel) {
      reasoningEffort = String(record.thinkingLevel);
      continue;
    }
    if (record?.type === 'custom' && record.customType === 'session_exit') {
      turnEnded = true;
      turnEndedAt = recordTs || customTs || turnEndedAt;
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
        turnEnded = true;
        turnEndedAt = messageTs || turnEndedAt;
        rememberDialogue({
          text,
          kind: 'assistant',
          source: 'omp.message',
          observedAt: messageTs,
          observedKey: 'assistantText',
        });
        if (detail) messages.push({ role: 'assistant', text: compactText(text), ts: messageTs });
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'thinking') {
          rememberDialogue({
            text: part.thinking,
            kind: 'thinking',
            source: 'omp.thinking',
            observedAt: messageTs,
            observedKey: 'thinkingPlaintext',
          });
          continue;
        }
        if (part.type !== 'toolCall') continue;
        const tool = String(part.name || 'tool');
        const toolCallId = String(part.id || `${tool}:${messageTs}:${toolHistory.length}`);
        const args = part.arguments ?? null;
        if (tool === 'todo') applyTodoOperation(todos, args);
        if (tool === 'read' || tool === 'write') {
          rememberPath(args?.path, tool === 'read' ? 'read' : 'write', messageTs, tool === 'read');
        }
        if (args && typeof args === 'object') {
          rememberDialogue({
            text: args.i,
            kind: 'intent',
            source: 'omp.tool.i',
            observedAt: messageTs,
            actionId: part.id ?? null,
            observedKey: 'toolIntent',
          });
        }
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
        turnEnded = false;
        turnEndedAt = null;
      }
      continue;
    }
    if (role === 'user') {
      const text = extractText(message.content);
      const prompt = projectPrompt(message.content);
      if (prompt) lastPrompt = prompt;
      if (detail && text) messages.push({ role: 'user', text: compactText(text), ts: messageTs });
      turnStartedAt = messageTs || turnStartedAt;
      turnEnded = false;
      turnEndedAt = null;
      continue;
    }
    if (role === 'toolResult' || role === 'tool') {
      if (message.toolCallId) pendingTools.delete(String(message.toolCallId));
      if (message.toolName === 'edit' && !message.isError && Array.isArray(message.details?.perFileResults)) {
        for (const result of message.details.perFileResults) rememberPath(result?.path, 'write', messageTs);
      }
    }
  }

  if (!session?.id) return null;
  const sessionId = transcriptId(String(session.id));
  const project = session.cwd || fallbackProject || null;
  const statActivity = fileMtimeMs != null && Number.isFinite(Number(fileMtimeMs))
    ? Number(fileMtimeMs)
    : (() => {
      try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
    })();
  latestActivity = Math.max(latestActivity, statActivity);
  const dialogueCandidates = [];
  for (const bucket of dialogueBuckets.values()) {
    for (const raw of bucket) {
      const candidate = makeDialogue({
        text: raw.text,
        kind: raw.kind,
        source: raw.source,
        observedAt: raw.observedAt,
        actionId: raw.actionId,
        project,
      });
      if (candidate) dialogueCandidates.push(candidate);
    }
  }

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
  const pending = pendingTools.values().next().value || null;
  const turnDescriptor = {
    pendingTool: pending?.tool || null,
    pendingSince: pending?.ts || null,
    turnEnded,
    turnEndedAt,
    permissionMode: 'bypassPermissions',
  };
  const resolvedModel = model || 'omp';
  const resolvedProvider = underlyingProvider || modelProvider(resolvedModel);
  const newestPaths = [];
  const seenPaths = new Set();
  for (let i = workingSet.length - 1; i >= 0 && newestPaths.length < 16; i--) {
    const item = workingSet[i];
    const canonical = workingSetPath(item.path, project, item.readSelector);
    if (!canonical || seenPaths.has(canonical)) continue;
    seenPaths.add(canonical);
    newestPaths.push({ path: canonical, op: item.op, at: item.at, source: 'transcript' });
  }

  return {
    dialogueCandidates,
    turnDescriptor,
    session: {
      sessionId,
      provider: 'omp',
      underlyingProvider: resolvedProvider,
      agentId: String(session.id),
      agentType: parentSessionId ? 'sub-agent' : 'main',
      agentName: childAgentName || title || null,
      project,
      model: resolvedModel,
      reasoningEffort: reasoningEffort || null,
      status: 'active',
      lastActivity: latestActivity,
      lastTool: latestTool,
      lastToolInput: latestToolInput,
      lastMessage: latestAssistantText,
      dialogue: null,
      observedSources,
      tokenUsage,
      parentSessionId: parentSessionId ? transcriptId(parentSessionId) : null,
      lastPrompt,
      todos: todos.slice(0, 64).map(({ subject, status, phase }) => ({ subject, status, phase })),
      gitBranch,
      signalSource: 'transcript',
      turnStartedAt,
      workingSet: newestPaths,
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

function presentOmpTranscript(reduced, { now = Date.now(), activeThresholdMs = null } = {}) {
  if (!reduced) return null;
  if (activeThresholdMs != null && now - reduced.session.lastActivity > Number(activeThresholdMs)) return null;
  const tokenUsage = reduced.session.tokenUsage ? { ...reduced.session.tokenUsage } : null;
  const dialogue = pickDialogue(reduced.dialogueCandidates, { now });
  return {
    session: {
      ...reduced.session,
      tokenUsage,
      observedSources: { ...reduced.session.observedSources },
      todos: reduced.session.todos.map(item => ({ ...item })),
      workingSet: reduced.session.workingSet.map(item => ({ ...item })),
      dialogue: dialogue ? { ...dialogue } : null,
      ...deriveTurnState(reduced.turnDescriptor, now),
    },
    detail: {
      ...reduced.detail,
      tokenUsage,
      toolHistory: reduced.detail.toolHistory.map(item => ({ ...item })),
      messages: reduced.detail.messages.map(item => ({ ...item })),
    },
  };
}

function parseOmpTranscript(records, options = {}) {
  return presentOmpTranscript(reduceOmpTranscript(records, options), options);
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

class OmpAdapter {
  constructor({ sessionsDir = null, rootDir = null, now = () => Date.now() } = {}) {
    this.sessionsDir = path.resolve(sessionsDir || rootDir || DEFAULT_SESSIONS_DIR);
    this.home = path.resolve(this.sessionsDir, '..', '..');
    this.now = now;
    this._index = new Map();
    this._detailIndex = new Map();
    this._directories = new Map();
    this._files = new Map();
    this._activePaths = new Set();
    this._changedPaths = new Set();
    this._dirtyDirectories = new Set();
    this._discoveryGeneration = 0;
    this._negativeDetails = new Map();
    this._reconciledAt = null;
    this._forceReconcile = false;
    this._lastThreshold = undefined;
    this._reducedCache = new Map();
    this._reducedCacheBytes = 0;
    this._perf = {
      activePasses: 0,
      filesDiscovered: 0,
      filesStatted: 0,
      filesSkippedBeforeRead: 0,
      filesOpened: 0,
      bytesRead: 0,
      linesParsed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statErrors: 0,
      reducedHits: 0,
      reducedMisses: 0,
      reducedEvictions: 0,
      directoryReads: 0,
      directoryStats: 0,
      detailLookups: 0,
      detailMetadataStats: 0,
      lastDetailMetadataStats: 0,
      detailHeaderFiles: 0,
      detailHeaderBytes: 0,
      detailNegativeHits: 0,
      detailCappedLookups: 0,
      lastDetailHeaderFiles: 0,
      lastDetailHeaderBytes: 0,
      lastPassAt: null,
      lastPassDurationMs: 0,
      lastFilesDiscovered: 0,
      lastFilesStatted: 0,
      lastFilesSkippedBeforeRead: 0,
      lastFilesOpened: 0,
      lastBytesRead: 0,
      lastLinesParsed: 0,
      lastCacheHits: 0,
      lastCacheMisses: 0,
      lastStatErrors: 0,
    };
  }

  get name() { return 'Oh My Pi'; }
  get provider() { return 'omp'; }
  get homeDir() { return this.home; }

  isAvailable() {
    try { return fs.statSync(this.sessionsDir).isDirectory(); } catch (error) { noteReadFailure(error); return false; }
  }

  _directoryListing(directory, { revalidate = false, fileStat = null } = {}) {
    const cached = this._directories.get(directory);
    if (cached && !revalidate && !this._dirtyDirectories.has(directory)) return cached;
    try {
      if (!fileStat) {
        this._perf.directoryStats += 1;
        fileStat = fs.statSync(directory);
      }
      const signature = statIdentity(fileStat);
      if (cached?.signature === signature) return cached;
      this._perf.directoryReads += 1;
      const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => descending(left.name, right.name));
      const listing = { signature, mtimeMs: fileStat.mtimeMs, entries: [] };
      let files = 0;
      let children = 0;
      // Caps keep the newest stamped names; readdir order is not age order.
      for (const entry of entries) {
        const current = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl') && files < MAX_TRANSCRIPTS) {
          listing.entries.push({ path: current, directory: false });
          files += 1;
        } else if (entry.isDirectory() && !entry.name.startsWith('.') && children < MAX_DIRECTORIES) {
          listing.entries.push({ path: current, directory: true });
          children += 1;
        }
      }
      this._directories.set(directory, listing);
      this._discoveryGeneration += 1;
      return listing;
    } catch (error) {
      noteReadFailure(error);
      return cached || null;
    }
  }

  _refreshTopology({ force = false } = {}) {
    const now = this.now();
    const reconcile = force || this._forceReconcile || this._reconciledAt === null
      || now - this._reconciledAt >= RECONCILE_INTERVAL_MS;
    const root = this._directoryListing(this.sessionsDir, { revalidate: true });
    if (!root) return reconcile;
    const rootChanged = this._rootSignature !== root.signature;
    if (!reconcile && !rootChanged && this._dirtyDirectories.size === 0) return false;
    const found = [];
    const visited = new Set();
    const sessionDirectories = [];
    // Session directories inherit their stamp so nested agents rank with their parent.
    const visit = (directory, stamp, listing = null) => {
      if (visited.size >= MAX_DIRECTORIES) return;
      visited.add(directory);
      listing ||= this._directoryListing(directory, { revalidate: reconcile });
      if (!listing) return;
      for (const entry of listing.entries) {
        const name = path.basename(entry.path);
        if (!entry.directory) {
          found.push({ path: entry.path, stamp: sessionStamp(name) || stamp });
        } else if (stamp) {
          visit(entry.path, stamp);
        } else {
          const ownStamp = sessionStamp(name);
          if (ownStamp) sessionDirectories.push({ path: entry.path, stamp: ownStamp });
          else visit(entry.path, '');
        }
      }
    };
    // Project containers first, then session trees newest-first, so the
    // directory cap and transcript cap both drop the oldest sessions.
    visit(this.sessionsDir, '', root);
    sessionDirectories.sort((left, right) => descending(left.stamp, right.stamp));
    for (const directory of sessionDirectories) {
      if (visited.size >= MAX_DIRECTORIES) break;
      visit(directory.path, directory.stamp);
    }
    if (found.length > MAX_TRANSCRIPTS) {
      found.sort((left, right) => descending(left.stamp, right.stamp));
      found.length = MAX_TRANSCRIPTS;
    }
    const files = new Map();
    for (const { path: filePath } of found) {
      files.set(filePath, this._files.get(filePath) || { stat: null, rawId: null, headerGeneration: null });
    }
    for (const filePath of this._files.keys()) {
      if (!files.has(filePath)) this._forgetFile(filePath);
    }
    for (const directory of this._directories.keys()) {
      if (!visited.has(directory)) this._directories.delete(directory);
    }
    this._files = files;
    this._rootSignature = root.signature;
    this._dirtyDirectories.clear();
    this._forceReconcile = false;
    if (reconcile) this._reconciledAt = now;
    return reconcile;
  }

  _deleteReduced(filePath) {
    const cached = this._reducedCache.get(filePath);
    if (cached) this._reducedCacheBytes -= cached.estimatedBytes;
    this._reducedCache.delete(filePath);
  }

  _forgetFile(filePath) {
    const rawId = this._files.get(filePath)?.rawId;
    if (rawId && this._detailIndex.get(rawId)?.filePath === filePath) this._detailIndex.delete(rawId);
    if (rawId && this._index.get(rawId)?.filePath === filePath) this._index.delete(rawId);
    this._files.delete(filePath);
    this._activePaths.delete(filePath);
    this._changedPaths.delete(filePath);
    this._deleteReduced(filePath);
  }

  _rememberIdentity(rawId, filePath, fileStat) {
    const file = this._files.get(filePath);
    if (file?.rawId && file.rawId !== rawId) {
      if (this._detailIndex.get(file.rawId)?.filePath === filePath) this._detailIndex.delete(file.rawId);
      this._index.delete(file.rawId);
      this._discoveryGeneration += 1;
    }
    if (file) {
      file.rawId = rawId;
      file.stat = fileStat;
      file.headerGeneration = this._discoveryGeneration;
    }
    const entry = { filePath, dev: fileStat.dev, ino: fileStat.ino };
    this._detailIndex.delete(rawId);
    this._detailIndex.set(rawId, entry);
    while (this._detailIndex.size > MAX_TRANSCRIPTS) this._detailIndex.delete(this._detailIndex.keys().next().value);
    return entry;
  }

  _readRecords(filePath, lines = TRANSCRIPT_TAIL_LINES) {
    const head = readJsonLines(filePath, {
      from: 'start',
      count: TRANSCRIPT_HEAD_LINES,
      headMaxBytes: TRANSCRIPT_HEAD_MAX_BYTES,
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

  _parseFile(filePath, { activeThresholdMs = null, detail = false, fileStat = null } = {}) {
    fileStat ||= fs.statSync(filePath);
    let signature = statIdentity(fileStat);
    let cached = this._reducedCache.get(filePath);
    if (cached && cached.signature !== signature) {
      this._deleteReduced(filePath);
      cached = null;
    }
    const kind = detail ? 'detail' : 'summary';
    if (cached && Object.prototype.hasOwnProperty.call(cached, kind)) {
      this._perf.reducedHits += 1;
      this._reducedCache.delete(filePath);
      this._reducedCache.set(filePath, cached);
    } else {
      this._perf.reducedMisses += 1;
      let reduced;
      let observed;
      for (let attempt = 0; attempt < 2; attempt++) {
        reduced = reduceOmpTranscript(this._readRecords(filePath, detail ? DETAIL_TAIL_LINES : TRANSCRIPT_TAIL_LINES), {
          filePath,
          parentSessionId: childParentId(filePath, this.sessionsDir),
          childAgentName: childName(filePath, this.sessionsDir),
          detail,
          fileMtimeMs: fileStat.mtimeMs,
        });
        try {
          observed = fs.statSync(filePath);
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            this._forgetFile(filePath);
            return null;
          }
          throw error;
        }
        if (statIdentity(observed) === signature) break;
        // Retry once with the new metadata; a busy writer is not a read failure.
        this._deleteReduced(filePath);
        cached = null;
        if (attempt === 1) {
          this._activePaths.add(filePath);
          return null;
        }
        fileStat = observed;
        signature = statIdentity(fileStat);
      }
      cached ||= { signature, estimatedBytes: 0 };
      this._deleteReduced(filePath);
      cached[kind] = reduced;
      cached.estimatedBytes = 256 + filePath.length * 2 + Buffer.byteLength(JSON.stringify(cached), 'utf8') * 2;
      this._reducedCache.set(filePath, cached);
      this._reducedCacheBytes += cached.estimatedBytes;
      while (this._reducedCache.size > REDUCED_CACHE_MAX || this._reducedCacheBytes > REDUCED_CACHE_MAX_BYTES) {
        this._deleteReduced(this._reducedCache.keys().next().value);
        this._perf.reducedEvictions += 1;
      }
      if (reduced) this._rememberIdentity(rawSessionId(reduced.session.sessionId), filePath, observed);
    }
    return presentOmpTranscript(cached[kind], { now: this.now(), activeThresholdMs });
  }

  getActiveSessions(activeThresholdMs) {
    const startedAt = Date.now();
    this._index.clear();
    const sessions = [];
    const reconcile = this._refreshTopology({ force: this._lastThreshold !== activeThresholdMs });
    this._lastThreshold = activeThresholdMs;
    const candidates = reconcile || activeThresholdMs == null
      ? new Set(this._files.keys())
      : new Set([...this._activePaths, ...this._changedPaths]);
    for (const [filePath, file] of this._files) {
      if (!file.stat) candidates.add(filePath);
    }
    const activePaths = new Set();
    const pass = {
      filesDiscovered: this._files.size,
      filesStatted: 0,
      filesSkippedBeforeRead: 0,
      filesOpened: 0,
      bytesRead: 0,
      linesParsed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statErrors: 0,
    };
    const diagnosticsBefore = getJsonlDiagnostics()[this.provider]?.parsedLines || 0;
    const tailBefore = getTailCacheDiagnostics().parsed;
    const reducedHitsBefore = this._perf.reducedHits;
    const reducedMissesBefore = this._perf.reducedMisses;
    const threshold = activeThresholdMs == null ? null : Number(activeThresholdMs);
    const now = this.now();

    for (const filePath of candidates) {
      if (!this._files.has(filePath)) continue;
      let fileStat;
      pass.filesStatted += 1;
      try {
        fileStat = fs.statSync(filePath);
      } catch (error) {
        noteReadFailure(error);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') this._forgetFile(filePath);
        else activePaths.add(filePath);
        pass.statErrors += 1;
        pass.filesSkippedBeforeRead += 1;
        continue;
      }
      const file = this._files.get(filePath);
      if (!fileStat.isFile()) {
        this._forgetFile(filePath);
        continue;
      }
      if (file) file.stat = fileStat;

      const ageMs = now - fileStat.mtimeMs;
      const inactive = threshold != null && (
        threshold <= 0
        || (Number.isFinite(threshold) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs > threshold)
      );
      if (inactive) {
        pass.filesSkippedBeforeRead += 1;
        continue;
      }

      const parsed = this._parseFile(filePath, { activeThresholdMs, fileStat });
      if (!parsed) {
        if (this._files.has(filePath)) activePaths.add(filePath);
        continue;
      }
      const rawId = rawSessionId(parsed.session.sessionId);
      activePaths.add(filePath);
      this._index.set(rawId, this._rememberIdentity(rawId, filePath, fileStat));
      sessions.push(parsed.session);
    }
    this._activePaths = activePaths;
    this._changedPaths.clear();

    const diagnosticsAfter = getJsonlDiagnostics()[this.provider]?.parsedLines || 0;
    const tailAfter = getTailCacheDiagnostics().parsed;
    pass.bytesRead = Math.max(0, tailAfter.bytesRead - tailBefore.bytesRead)
      + Math.max(0, tailAfter.headBytesRead - tailBefore.headBytesRead);
    pass.linesParsed = Math.max(0, diagnosticsAfter - diagnosticsBefore);
    pass.cacheHits = this._perf.reducedHits - reducedHitsBefore;
    pass.cacheMisses = this._perf.reducedMisses - reducedMissesBefore;
    pass.filesOpened = pass.cacheMisses;
    this._recordActivePass(startedAt, pass);
    return sessions;
  }

  _recordActivePass(startedAt, pass) {
    this._perf.activePasses += 1;
    for (const field of [
      'filesDiscovered',
      'filesStatted',
      'filesSkippedBeforeRead',
      'filesOpened',
      'bytesRead',
      'linesParsed',
      'cacheHits',
      'cacheMisses',
      'statErrors',
    ]) {
      this._perf[field] += pass[field];
      this._perf[`last${field[0].toUpperCase()}${field.slice(1)}`] = pass[field];
    }
    this._perf.lastPassAt = Date.now();
    this._perf.lastPassDurationMs = this._perf.lastPassAt - startedAt;
  }

  _discoverIdentity(rawId) {
    let filesRead = 0;
    let bytesRead = 0;
    const readIdentity = (filePath, file) => {
      if (file.headerGeneration === this._discoveryGeneration) return null;
      if (filesRead >= DETAIL_DISCOVERY_MAX_FILES || bytesRead >= DETAIL_DISCOVERY_MAX_BYTES) return null;
      filesRead += 1;
      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        const buffer = Buffer.allocUnsafe(Math.min(DETAIL_HEADER_MAX_BYTES, DETAIL_DISCOVERY_MAX_BYTES - bytesRead));
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        bytesRead += read;
        file.headerGeneration = this._discoveryGeneration;
        file.stat = stat;
        const text = buffer.toString('utf8', 0, read);
        const lines = text.split('\n').slice(0, TRANSCRIPT_HEAD_LINES);
        for (let index = 0; index < lines.length; index++) {
          if (index === lines.length - 1 && read < stat.size && !text.endsWith('\n')) break;
          let record;
          try { record = JSON.parse(lines[index]); } catch { continue; }
          if (record?.type !== 'session' || !record.id) continue;
          const discoveredId = String(record.id);
          const entry = this._rememberIdentity(discoveredId, filePath, stat);
          return discoveredId === rawId ? entry : null;
        }
      } catch (error) {
        noteReadFailure(error);
        if (error?.code === 'ENOENT') this._forgetFile(filePath);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      return null;
    };
    let matched = null;
    // Parent names expose their id. Verify that candidate before unrelated headers.
    for (const [filePath, file] of this._files) {
      if (!path.basename(filePath).endsWith(`${rawId}.jsonl`)) continue;
      matched = readIdentity(filePath, file);
      if (matched || filesRead >= DETAIL_DISCOVERY_MAX_FILES || bytesRead >= DETAIL_DISCOVERY_MAX_BYTES) break;
    }
    if (!matched) {
      // A cold topology has no file stats yet. Populate only those missing
      // observations once; active passes and later lookups reuse the same map.
      const recentFiles = [...this._files.entries()];
      for (const [filePath, file] of recentFiles) {
        if (file.stat) continue;
        this._perf.detailMetadataStats += 1;
        this._perf.lastDetailMetadataStats += 1;
        try {
          file.stat = fs.statSync(filePath);
        } catch (error) {
          noteReadFailure(error);
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') this._forgetFile(filePath);
        }
      }
      recentFiles.sort((left, right) => (right[1].stat?.mtimeMs ?? 0) - (left[1].stat?.mtimeMs ?? 0));
      for (const [filePath, file] of recentFiles) {
        if (!this._files.has(filePath)) continue;
        matched = readIdentity(filePath, file);
        if (matched || filesRead >= DETAIL_DISCOVERY_MAX_FILES || bytesRead >= DETAIL_DISCOVERY_MAX_BYTES) break;
      }
    }
    this._perf.lastDetailHeaderFiles = filesRead;
    this._perf.lastDetailHeaderBytes = bytesRead;
    this._perf.detailHeaderFiles += filesRead;
    this._perf.detailHeaderBytes += bytesRead;
    if (!matched && (filesRead >= DETAIL_DISCOVERY_MAX_FILES || bytesRead >= DETAIL_DISCOVERY_MAX_BYTES)) {
      this._perf.detailCappedLookups += 1;
    }
    return matched;
  }

  getSessionDetail(sessionId, project) {
    this._perf.detailLookups += 1;
    this._perf.lastDetailHeaderFiles = 0;
    this._perf.lastDetailHeaderBytes = 0;
    this._perf.lastDetailMetadataStats = 0;
    this._refreshTopology();
    const rawId = rawSessionId(sessionId);
    const empty = () => createDetailResponse({ provider: this.provider, sessionId, project: project || '' });
    let entry = this._index.get(rawId) || this._detailIndex.get(rawId);
    if (!entry && this._negativeDetails.get(rawId) === this._discoveryGeneration) {
      this._perf.detailNegativeHits += 1;
      return empty();
    }
    if (!entry) entry = this._discoverIdentity(rawId);
    if (!entry) {
      this._negativeDetails.delete(rawId);
      this._negativeDetails.set(rawId, this._discoveryGeneration);
      while (this._negativeDetails.size > NEGATIVE_CACHE_MAX) this._negativeDetails.delete(this._negativeDetails.keys().next().value);
      return empty();
    }
    let fileStat;
    try {
      fileStat = fs.statSync(entry.filePath);
    } catch (error) {
      noteReadFailure(error);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        this._forgetFile(entry.filePath);
        this._detailIndex.delete(rawId);
        this._index.delete(rawId);
      }
      return empty();
    }
    const parsed = this._parseFile(entry.filePath, { detail: true, fileStat });
    if (!parsed) {
      if (this._files.has(entry.filePath)) throw new Error('Transcript changed during detail read');
      return empty();
    }
    if (rawSessionId(parsed.session.sessionId) !== rawId) {
      this._detailIndex.delete(rawId);
      this._index.delete(rawId);
      return empty();
    }
    if (project && !parsed.detail.project) parsed.detail.project = project;
    return parsed.detail;
  }

  getWatchPaths() {
    return [{ type: 'directory', path: this.sessionsDir, recursive: true, filter: '.jsonl' }];
  }

  invalidateCachesForDirty(dirty = {}) {
    if (dirty.kind === 'reconcile' || !dirty.kind) this._forceReconcile = true;
    if (!dirty.path) return;
    const changed = path.resolve(dirty.path);
    const relative = path.relative(this.sessionsDir, changed);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return;
    if (changed.endsWith('.jsonl')) {
      if (this._changedPaths.size < MAX_TRANSCRIPTS) this._changedPaths.add(changed);
      if (!this._files.has(changed)) this._markDirectoryDirty(path.dirname(changed));
    } else {
      this._markDirectoryDirty(changed);
    }
  }

  _markDirectoryDirty(directory) {
    while (this._dirtyDirectories.size < MAX_DIRECTORIES) {
      this._dirtyDirectories.add(directory);
      if (directory === this.sessionsDir) break;
      directory = path.dirname(directory);
    }
  }

  getPerfStats() {
    return {
      ...this._perf,
      discoveryGeneration: this._discoveryGeneration,
      knownTranscripts: this._files.size,
      knownDirectories: this._directories.size,
      detailMappings: this._detailIndex.size,
      negativeDetails: this._negativeDetails.size,
      detailDiscoveryFileLimit: DETAIL_DISCOVERY_MAX_FILES,
      detailDiscoveryByteLimit: DETAIL_DISCOVERY_MAX_BYTES,
      reducedEntries: this._reducedCache.size,
      reducedBytes: this._reducedCacheBytes,
      reducedEntryLimit: REDUCED_CACHE_MAX,
      reducedByteLimit: REDUCED_CACHE_MAX_BYTES,
    };
  }

  shutdown() {
    this._index.clear();
    this._detailIndex.clear();
    this._directories.clear();
    this._files.clear();
    this._activePaths.clear();
    this._changedPaths.clear();
    this._dirtyDirectories.clear();
    this._negativeDetails.clear();
    this._reducedCache.clear();
    this._reducedCacheBytes = 0;
    this._rootSignature = null;
    this._reconciledAt = null;
    this._forceReconcile = false;
    this._lastThreshold = undefined;
  }
}

module.exports = {
  OmpAdapter,
  parseOmpTranscript,
};
