/**
 * Kimi CLI adapter
 * Data sources: ~/.kimi/ (legacy) and ~/.kimi-code/ (Kimi Code, 2026 migration).
 * Both layouts are scanned; see the "Kimi Code" parsing section below for the new format.
 *
 * Session format:
 *   ~/.kimi/sessions/<project_hash_md5>/<session_uuid>/wire.jsonl
 *   ~/.kimi/sessions/<project_hash_md5>/<session_uuid>/state.json
 *
 * wire.jsonl events:
 *   {"timestamp": <unix_ts>, "message": {"type": "TurnBegin", ...}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ToolCall", "payload": {"function": {"name": "Shell", "arguments": "..."}}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ToolResult", "payload": {"return_value": {"output": "..."}}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ContentPart", "payload": {"type": "text", "text": "..."}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "StatusUpdate", "payload": {"token_usage": {"input_other": N, "output": N, "input_cache_read": N, "input_cache_creation": N}, "context_tokens": N, "max_context_tokens": N}}}
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  createDetailResponse,
  readJsonLines: readSharedJsonLines,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');

const KIMI_DIR = path.join(os.homedir(), '.kimi');
const SESSIONS_DIR = path.join(KIMI_DIR, 'sessions');
const KIMI_JSON = path.join(KIMI_DIR, 'kimi.json');
const CONFIG_TOML = path.join(KIMI_DIR, 'config.toml');

// Kimi Code (2026 migration of the Kimi CLI) uses a new home dir and layout:
//   ~/.kimi-code/session_index.jsonl  → {sessionId, sessionDir, workDir} per line
//   ~/.kimi-code/sessions/<workspace>/<session_uuid>/state.json
//   ~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl
const KIMI_CODE_DIR = path.join(os.homedir(), '.kimi-code');
const KIMI_CODE_SESSIONS_DIR = path.join(KIMI_CODE_DIR, 'sessions');
const KIMI_CODE_INDEX = path.join(KIMI_CODE_DIR, 'session_index.jsonl');
const KIMI_CODE_CONFIG_TOML = path.join(KIMI_CODE_DIR, 'config.toml');

const GIT_EVENT_SCAN_LINES = 5000;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_BYTES = 512 * 1024;
const KIMI_TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'file_path',
  'pattern',
  'query',
  'target',
  'path',
  'description',
  'prompt',
  'url',
  'content',
  'task_id',
  'skill',
  'id',
]);

const _configCache = { at: 0, value: null };
const _kimiJsonCache = { at: 0, value: null };
const _codeConfigCache = { at: 0, value: null };
const _codeIndexCache = { at: 0, value: null };

// ─── Utilities ─────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function stripKimiSessionPrefix(sessionId) {
  return String(sessionId || '').replace(/^kimi-/, '');
}

function isPathInside(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

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

function safeExistingDirectory(candidatePath, rootPath) {
  try {
    if (!candidatePath || !fs.existsSync(candidatePath)) return null;
    const stat = fs.statSync(candidatePath);
    if (!stat.isDirectory()) return null;
    const rootReal = fs.realpathSync(rootPath);
    const dirReal = fs.realpathSync(candidatePath);
    return isPathInside(dirReal, rootReal) ? dirReal : null;
  } catch {
    return null;
  }
}

function readJsonLines(filePath, { from = 'end', count = 100 } = {}) {
  return readSharedJsonLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'kimi',
  });
}

function readKimiJson() {
  const now = Date.now();
  if (_kimiJsonCache.value && (now - _kimiJsonCache.at) < 5000) return _kimiJsonCache.value;
  try {
    const content = fs.readFileSync(KIMI_JSON, 'utf-8');
    const data = JSON.parse(content);
    _kimiJsonCache.value = data;
    _kimiJsonCache.at = now;
    return data;
  } catch {
    return { work_dirs: [] };
  }
}

function readConfigToml(filePath = CONFIG_TOML, cache = _configCache) {
  const now = Date.now();
  if (cache.value && (now - cache.at) < 5000) return cache.value;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = { defaultModel: 'kimi-for-coding', models: {} };

    // Extract default_model
    const defaultMatch = content.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    if (defaultMatch) config.defaultModel = defaultMatch[1];

    // Extract model blocks: [models."kimi-code/kimi-for-coding"]
    // Block body runs until the next section header (a line starting with `[`),
    // while still allowing inline arrays like `capabilities = [ ... ]`.
    const modelBlockRegex = /^\s*\[models\."([^"]+)"\]\s*\n((?:(?!\s*\[)[^\n]*\n?)*)/gm;
    let m;
    while ((m = modelBlockRegex.exec(content)) !== null) {
      const block = m[2];
      const modelMatch = block.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const displayMatch = block.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
      const providerMatch = block.match(/^\s*provider\s*=\s*"([^"]+)"/m);
      const maxCtxMatch = block.match(/^\s*max_context_size\s*=\s*(\d+)/m);
      config.models[m[1]] = {
        model: modelMatch ? modelMatch[1] : m[1],
        displayName: displayMatch ? displayMatch[1] : (modelMatch ? modelMatch[1] : m[1]),
        provider: providerMatch ? providerMatch[1] : 'kimi',
        maxContext: maxCtxMatch ? Number(maxCtxMatch[1]) : 0,
      };
    }

    cache.value = config;
    cache.at = now;
    return config;
  } catch {
    return { defaultModel: 'kimi-for-coding', models: {} };
  }
}

function resolveModelInfo(config) {
  const defaultModelKey = config.defaultModel || 'kimi-for-coding';
  const modelEntry = config.models[defaultModelKey];
  if (modelEntry) return modelEntry;
  return { model: 'kimi-for-coding', displayName: 'Kimi-k2.6', provider: 'kimi', maxContext: 0 };
}

function addKimiCodeIndexEntry(map, key, entry) {
  const normalized = String(key || '').trim();
  if (normalized && !map.has(normalized)) map.set(normalized, entry);
}

// Kimi Code session index: sessionId, sessionDir, and basename(sessionDir) → { sessionDir, workDir }
function readKimiCodeIndex() {
  const now = Date.now();
  if (_codeIndexCache.value && (now - _codeIndexCache.at) < 5000) return _codeIndexCache.value;
  const map = new Map();
  try {
    const content = fs.readFileSync(KIMI_CODE_INDEX, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && entry.sessionId) {
          const sessionDir = typeof entry.sessionDir === 'string'
            ? safeExistingDirectory(entry.sessionDir, KIMI_CODE_SESSIONS_DIR)
            : null;
          if (!sessionDir) continue;
          const indexed = { sessionDir, workDir: entry.workDir || null };
          addKimiCodeIndexEntry(map, entry.sessionId, indexed);
          addKimiCodeIndexEntry(map, sessionDir, indexed);
          addKimiCodeIndexEntry(map, path.basename(sessionDir), indexed);
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* ignore */ }
  _codeIndexCache.value = map;
  _codeIndexCache.at = now;
  return map;
}

function buildProjectPathMap() {
  const map = new Map();
  const kimiJson = readKimiJson();
  if (Array.isArray(kimiJson.work_dirs)) {
    for (const entry of kimiJson.work_dirs) {
      if (entry.path) {
        map.set(md5(entry.path), entry.path);
      }
    }
  }
  // Also try common directories
  const home = os.homedir();
  const commonDirs = ['Desktop', 'Documents', 'Projects', 'Developer', 'dev', 'src', 'code', 'repos', 'workspace', 'work'];
  for (const dir of commonDirs) {
    const fullPath = path.join(home, dir);
    map.set(md5(fullPath), fullPath);
    try {
      if (fs.existsSync(fullPath)) {
        const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 50);
        for (const sub of subdirs) {
          const subPath = path.join(fullPath, sub.name);
          map.set(md5(subPath), subPath);
        }
      }
    } catch { /* ignore */ }
  }
  return map;
}

function resolveProjectPath(projectHash) {
  const map = buildProjectPathMap();
  return map.get(projectHash) || null;
}

function getSessionTitle(statePath) {
  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content);
    if (state.custom_title && typeof state.custom_title === 'string') {
      return state.custom_title.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function summarizeToolInput(argsStr, { maxLength = 60, basenameFile = true } = {}) {
  const summary = summarizeSharedToolInput(argsStr, {
    fields: KIMI_TOOL_INPUT_FIELDS,
    basenameFields: basenameFile ? ['file_path'] : [],
    maxLength,
    missingValue: null,
    parseJsonStrings: true,
    stringFallback: 'string',
    objectFallback: 'none',
  });
  if (summary != null) return summary;
  return summarizeQuestionPrompt(argsStr, maxLength);
}

// AskUserQuestion keeps its identifying text in questions[].question, which the
// shallow shared field scan cannot reach; surface it so captions and activity
// rows are not blank on question turns.
function summarizeQuestionPrompt(argsStr, maxLength) {
  let args = argsStr;
  if (typeof argsStr === 'string') {
    try { args = JSON.parse(argsStr); } catch { return null; }
  }
  if (!args || typeof args !== 'object' || !Array.isArray(args.questions)) return null;
  const entry = args.questions.find((item) => item && typeof item.question === 'string' && item.question.trim());
  return entry ? entry.question.trim().substring(0, maxLength) : null;
}

function parseWireDetail(filePath) {
  const detail = {
    model: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };

  const entries = readJsonLines(filePath, { from: 'end', count: 100 });

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message;
    if (!msg) continue;

    const payload = msg.payload;
    if (!payload) continue;

    // ToolCall
    if (!detail.lastTool && msg.type === 'ToolCall' && payload.function) {
      detail.lastTool = payload.function.name || null;
      detail.lastToolInput = summarizeToolInput(payload.function.arguments, { maxLength: 60, basenameFile: true });
    }

    // ContentPart text
    if (!detail.lastMessage && msg.type === 'ContentPart' && payload.type === 'text' && payload.text) {
      const text = payload.text.trim();
      if (text.length > 0) detail.lastMessage = text.substring(0, 80);
    }
  }

  return detail;
}

function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 200 });
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'ToolCall') continue;
      const payload = msg.payload;
      if (!payload || !payload.function) continue;
      const func = payload.function;
      let detail = '';
      if (func.arguments) {
        detail = summarizeToolInput(func.arguments, { maxLength: 80, basenameFile: false }) || '';
      }
      tools.push({
        tool: func.name || 'unknown',
        detail,
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function getRecentMessages(filePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 100 });
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'ContentPart') continue;
      const payload = msg.payload;
      if (!payload || payload.type !== 'text' || !payload.text) continue;
      const text = payload.text.trim();
      if (text.length === 0) continue;
      messages.push({
        role: 'assistant',
        text: text.substring(0, 200),
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function getTokenUsage(filePath) {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
  };

  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 500 });
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let lastContextTokens = 0;
    let lastMaxContext = 0;
    let turnCount = 0;

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'StatusUpdate') continue;
      const payload = msg.payload;
      if (!payload) continue;

      const usage = payload.token_usage;
      if (usage && typeof usage === 'object') {
        totalInput += Number(usage.input_other) || 0;
        totalOutput += Number(usage.output) || 0;
        totalCacheRead += Number(usage.input_cache_read) || 0;
        totalCacheCreate += Number(usage.input_cache_creation) || 0;
        turnCount++;
      }

      if (Number.isFinite(payload.context_tokens)) {
        lastContextTokens = payload.context_tokens;
      }
      if (Number.isFinite(payload.max_context_tokens)) {
        lastMaxContext = payload.max_context_tokens;
      }
    }

    return {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      contextWindow: lastContextTokens,
      contextWindowMax: lastMaxContext,
      turnCount,
      totalInput,
      totalOutput,
    };
  } catch { /* ignore */ }

  return emptyUsage;
}

function getGitEvents(filePath, context) {
  const events = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });

    entries.forEach((entry, entryIndex) => {
      const msg = entry.message;
      if (!msg || msg.type !== 'ToolCall' || !msg.payload || !msg.payload.function) return;
      const func = msg.payload.function;
      if (func.name !== 'Shell' || !func.arguments) return;

      let args = null;
      try { args = JSON.parse(func.arguments); } catch { return; }
      if (!args || !args.command) return;

      const command = args.command;
      events.push(...extractGitEventsFromCommandSource(command, {
        ...context,
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
        sourceId: func.id || msg.payload.id || `${stableHash(JSON.stringify(entry))}:0`,
      }));
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

// ─── Kimi Code (~/.kimi-code) parsing ─────────────────────
//
// New wire.jsonl events use a top-level `type` and `time` (ms), unlike the
// legacy `{timestamp(s), message:{type, payload}}` shape parsed above.
//   {"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{...},"time":...}}
//   {"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"..."}}}
//   {"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":N,"output":N,"inputCacheRead":N,"inputCacheCreation":N}}

function loopEvent(entry, eventType) {
  if (!entry || entry.type !== 'context.append_loop_event') return null;
  const e = entry.event;
  if (!e || e.type !== eventType) return null;
  return e;
}

function kimiCodeEventTime(entry, event = null) {
  return Number(event && event.time) || Number(entry && entry.time) || 0;
}

function kimiCodeToolCallId(event) {
  return String(
    event?.toolCallId
    || event?.tool_call_id
    || event?.callId
    || event?.call_id
    || event?.uuid
    || event?.id
    || '',
  ).trim();
}

function kimiCodeUsageNumber(usage, ...keys) {
  for (const key of keys) {
    if (!usage || !Object.prototype.hasOwnProperty.call(usage, key)) continue;
    const raw = usage[key];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function kimiCodeTextFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && block.text) {
      return String(block.text).trim();
    }
  }
  return '';
}

function kimiCodeModelAlias(entry) {
  if (!entry || entry.type !== 'config.update') return null;
  if (typeof entry.modelAlias === 'string' && entry.modelAlias.trim()) return entry.modelAlias.trim();
  if (entry.key === 'modelAlias' && typeof entry.value === 'string' && entry.value.trim()) return entry.value.trim();
  return null;
}

function readKimiCodeState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const agents = state.agents && typeof state.agents === 'object' && !Array.isArray(state.agents)
      ? state.agents
      : {};
    // Current Kimi Code builds persist the project root as top-level `workDir`.
    const workDir = typeof state.workDir === 'string' && state.workDir.trim()
      ? state.workDir.trim()
      : null;
    // Only surface user-set titles; auto-derived titles (the first prompt) make
    // noisy villager names, so leave them null for procedural naming (matches legacy).
    if (state.isCustomTitle && state.title && typeof state.title === 'string') {
      return { title: state.title.trim().substring(0, 80) || null, agents, workDir };
    }
    return { title: null, agents, workDir };
  } catch {
    return { title: null, agents: {}, workDir: null };
  }
}

function kimiCodeProjectFromState(stateMeta) {
  if (typeof stateMeta?.workDir === 'string' && stateMeta.workDir.trim()) {
    return stateMeta.workDir.trim();
  }
  // Last resort for older layouts. On current builds `agents.<id>.homedir` points
  // inside the session store (~/.kimi-code/sessions/...), not the project.
  const agents = stateMeta?.agents && typeof stateMeta.agents === 'object' ? stateMeta.agents : {};
  const orderedAgentIds = ['main', ...Object.keys(agents).filter(agentId => agentId !== 'main')];
  for (const agentId of orderedAgentIds) {
    const homedir = agents[agentId]?.homedir;
    if (typeof homedir === 'string' && homedir.trim()) return homedir.trim();
  }
  return null;
}

function kimiCodeParentSessionId(sessionDirName, agentName, agentsMeta = {}, activeAgentNames = new Set()) {
  if (agentName === 'main') return null;
  const parentAgentId = String(agentsMeta?.[agentName]?.parentAgentId || '').trim();
  if (
    parentAgentId
    && parentAgentId !== 'main'
    && parentAgentId !== agentName
    && activeAgentNames.has(parentAgentId)
  ) {
    return `kimi-${sessionDirName}::${parentAgentId}`;
  }
  return `kimi-${sessionDirName}`;
}

function kimiCodeSessionModelKey(detailsByAgentName, agentRecords, now, activeThresholdMs) {
  const mainModel = detailsByAgentName.get('main')?.model;
  if (mainModel) return mainModel;
  for (const record of agentRecords) {
    if (record.agentName === 'main' || now - record.stat.mtimeMs > activeThresholdMs) continue;
    const model = detailsByAgentName.get(record.agentName)?.model;
    if (model) return model;
  }
  return null;
}

function parseWireDetailV2(filePath) {
  const detail = { model: null, project: null, lastTool: null, lastToolInput: null, lastMessage: null };
  const entries = readJsonLines(filePath, { from: 'end', count: 100 });

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || !entry.type) continue;

    if (!detail.project && entry.type === 'config.update' && typeof entry.cwd === 'string') {
      const cwd = entry.cwd.trim();
      if (cwd) detail.project = cwd;
    }

    if (!detail.model && entry.type === 'usage.record' && entry.model) {
      detail.model = entry.model;
    }
    if (!detail.model) {
      const modelAlias = kimiCodeModelAlias(entry);
      if (modelAlias) detail.model = modelAlias;
    }

    const call = loopEvent(entry, 'tool.call');
    if (!detail.lastTool && call && call.name) {
      detail.lastTool = call.name;
      detail.lastToolInput = summarizeToolInput(call.args, { maxLength: 60, basenameFile: true });
    }

    const part = loopEvent(entry, 'content.part');
    if (!detail.lastMessage && part && part.part && part.part.type === 'text' && part.part.text) {
      const text = part.part.text.trim();
      if (text.length > 0) detail.lastMessage = text.substring(0, 80);
    }

    if (detail.project && detail.model && detail.lastTool && detail.lastMessage) break;
  }

  return detail;
}

function getToolHistoryV2(filePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 200 });
    const completionsByCallId = new Map();
    for (const entry of entries) {
      const result = loopEvent(entry, 'tool.result');
      const callId = kimiCodeToolCallId(result);
      const completion = callId ? kimiCodeResultCompletion(entry) : null;
      if (completion) completionsByCallId.set(callId, completion);
    }

    for (const entry of entries) {
      const call = loopEvent(entry, 'tool.call');
      if (!call) continue;
      const detail = call.args ? (summarizeToolInput(call.args, { maxLength: 80, basenameFile: false }) || '') : '';
      const item = {
        tool: call.name || 'unknown',
        detail,
        ts: kimiCodeEventTime(entry, call),
      };
      const callId = kimiCodeToolCallId(call);
      const completion = callId ? completionsByCallId.get(callId) : null;
      if (completion && Number.isFinite(completion.exitCode)) {
        item.toolExitCode = completion.exitCode;
        if (completion.exitCode !== 0 && completion.stderr) {
          item.toolStderr = completion.stderr.trim().substring(0, 200);
        }
      }
      tools.push(item);
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function kimiCodeResultCompletion(entry) {
  const result = entry?.event?.result;
  if (!result || typeof result !== 'object') return null;
  const output = [result.stderr, result.error, result.message, result.output]
    .find(value => typeof value === 'string' && value.trim());
  const isError = result.isError === true
    || result.is_error === true
    || result.error === true
    || (typeof result.error === 'string' && result.error.trim().length > 0);
  const rawExitCode = result.exitCode ?? result.exit_code ?? result.code;
  const exitCode = Number.isFinite(Number(rawExitCode)) ? Number(rawExitCode) : (isError ? 1 : 0);
  return {
    success: !isError && exitCode === 0,
    exitCode,
    completedAt: kimiCodeEventTime(entry, entry.event),
    stderr: (isError || exitCode !== 0) && output ? output.trim().substring(0, 2000) : '',
  };
}

function getRecentMessagesV2(filePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 100 });
    for (const entry of entries) {
      if (entry && entry.type === 'context.append_message' && entry.message) {
        const text = kimiCodeTextFromContent(entry.message.content);
        if (text) {
          messages.push({
            role: entry.message.role || 'user',
            text: text.substring(0, 200),
            ts: kimiCodeEventTime(entry),
          });
        }
        continue;
      }

      const part = loopEvent(entry, 'content.part');
      if (!part || !part.part || part.part.type !== 'text' || !part.part.text) continue;
      const text = part.part.text.trim();
      if (text.length === 0) continue;
      messages.push({
        role: 'assistant',
        text: text.substring(0, 200),
        ts: kimiCodeEventTime(entry, part),
      });
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function emptyKimiCodeUsage(contextWindowMax = 0) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax,
    turnCount: 0,
  };
}

function getTokenUsageV2(filePath, contextWindowMax = 0) {
  const emptyUsage = emptyKimiCodeUsage(contextWindowMax);

  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 500 });
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let lastContextTokens = 0;
    let turnCount = 0;

    for (const entry of entries) {
      if (!entry || entry.type !== 'usage.record' || !entry.usage) continue;
      const u = entry.usage;
      const inputOther = kimiCodeUsageNumber(u, 'inputOther', 'input_other');
      const cacheRead = kimiCodeUsageNumber(u, 'inputCacheRead', 'input_cache_read');
      const cacheCreate = kimiCodeUsageNumber(u, 'inputCacheCreation', 'input_cache_creation');
      totalInput += inputOther;
      totalOutput += kimiCodeUsageNumber(u, 'output', 'output_tokens');
      totalCacheRead += cacheRead;
      totalCacheCreate += cacheCreate;
      turnCount++;
      // Most recent turn's input tokens ≈ current context occupancy
      lastContextTokens = inputOther + cacheRead + cacheCreate;
    }

    return {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      contextWindow: lastContextTokens,
      contextWindowMax,
      turnCount,
      totalInput,
      totalOutput,
    };
  } catch { /* ignore */ }

  return emptyUsage;
}

function kimiCodeSessionDirFromWire(wirePath) {
  return safeExistingDirectory(path.dirname(path.dirname(path.dirname(wirePath))), KIMI_CODE_SESSIONS_DIR);
}

function getKimiCodeWireContext(wirePath, fallbackProject = null) {
  const detail = parseWireDetailV2(wirePath);
  const config = readConfigToml(KIMI_CODE_CONFIG_TOML, _codeConfigCache);
  const modelInfo = resolveModelInfo(config);
  const modelEntry = detail.model ? config.models[detail.model] : null;
  const sessionDir = kimiCodeSessionDirFromWire(wirePath);
  const index = readKimiCodeIndex();
  const indexEntry = sessionDir ? (index.get(sessionDir) || index.get(path.basename(sessionDir))) : null;
  const statePath = sessionDir ? path.join(sessionDir, 'state.json') : null;
  const stateMeta = statePath && fs.existsSync(statePath)
    ? readKimiCodeState(statePath)
    : { title: null, agents: {} };
  return {
    project: indexEntry?.workDir || kimiCodeProjectFromState(stateMeta) || detail.project || fallbackProject || null,
    contextWindowMax: (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0,
  };
}

function getGitEventsV2(filePath, context) {
  const events = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    const completionsByCallId = new Map();
    for (const entry of entries) {
      const result = loopEvent(entry, 'tool.result');
      const callId = kimiCodeToolCallId(result);
      const completion = callId ? kimiCodeResultCompletion(entry) : null;
      if (completion) completionsByCallId.set(callId, completion);
    }

    entries.forEach((entry, entryIndex) => {
      const call = loopEvent(entry, 'tool.call');
      if (!call || (call.name !== 'Bash' && call.name !== 'Shell')) return;
      const command = call.args && call.args.command;
      if (!command) return;
      const callId = kimiCodeToolCallId(call);
      const completion = callId ? completionsByCallId.get(callId) : null;
      events.push(...extractGitEventsFromCommandSource(command, {
        ...context,
        ts: kimiCodeEventTime(entry, call),
        sourceId: callId || `${stableHash(JSON.stringify(entry))}:${entryIndex}`,
        success: completion ? completion.success : undefined,
        exitCode: completion ? completion.exitCode : undefined,
        completedAt: completion ? completion.completedAt : undefined,
        stderr: completion ? completion.stderr : undefined,
      }));
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

// Walk ~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl.
// The `main` agent is the user-facing session; subagents become child sessions.
function getActiveSessionsV2(activeThresholdMs, now) {
  if (!fs.existsSync(KIMI_CODE_SESSIONS_DIR)) return [];

  const index = readKimiCodeIndex();
  const config = readConfigToml(KIMI_CODE_CONFIG_TOML, _codeConfigCache);
  const modelInfo = resolveModelInfo(config);
  const sessions = [];

  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
  } catch {
    return [];
  }

  for (const wsDir of workspaceDirs) {
    const wsPath = path.join(KIMI_CODE_SESSIONS_DIR, wsDir.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch { continue; }

    for (const sDir of sessionDirs) {
      const sessionDirName = sDir.name;
      const sessionPath = path.join(wsPath, sessionDirName);
      const agentsDir = path.join(sessionPath, 'agents');

      let agentDirs;
      try {
        agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      } catch { continue; }

      const sessionRealPath = safeExistingDirectory(sessionPath, KIMI_CODE_SESSIONS_DIR);
      const indexEntry = (sessionRealPath ? index.get(sessionRealPath) : null)
        || index.get(sessionPath)
        || index.get(sessionDirName);
      const statePath = path.join(sessionPath, 'state.json');
      const stateMeta = fs.existsSync(statePath)
        ? readKimiCodeState(statePath)
        : { title: null, agents: {} };
      const title = stateMeta.title;

      const agentRecords = [];
      let latestAgentActivity = 0;
      for (const aDir of agentDirs) {
        const agentName = aDir.name;
        const wirePath = path.join(agentsDir, agentName, 'wire.jsonl');
        if (!fs.existsSync(wirePath)) continue;

        let stat;
        try { stat = fs.statSync(wirePath); } catch { continue; }
        latestAgentActivity = Math.max(latestAgentActivity, stat.mtimeMs);
        agentRecords.push({ agentName, wirePath, stat });
      }
      if (!agentRecords.length || now - latestAgentActivity > activeThresholdMs) continue;

      const activeAgentNames = new Set(agentRecords
        .filter(record => record.agentName === 'main' || now - record.stat.mtimeMs <= activeThresholdMs)
        .map(record => record.agentName));
      const hasMainRecord = agentRecords.some(record => record.agentName === 'main');
      const detailsByAgentName = new Map();
      let wireProject = null;
      for (const record of agentRecords) {
        const detail = parseWireDetailV2(record.wirePath);
        detailsByAgentName.set(record.agentName, detail);
        if (!wireProject && detail.project) wireProject = detail.project;
      }
      const project = indexEntry?.workDir || kimiCodeProjectFromState(stateMeta) || wireProject;

      if (!hasMainRecord) {
        const modelKey = kimiCodeSessionModelKey(detailsByAgentName, agentRecords, now, activeThresholdMs)
          || config.defaultModel;
        const modelEntry = modelKey ? config.models[modelKey] : null;
        const model = (modelEntry && modelEntry.displayName) || modelInfo.displayName || modelInfo.model || 'kimi';
        const ctxMax = (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0;
        const sessionId = `kimi-${sessionDirName}`;
        sessions.push({
          sessionId,
          provider: 'kimi',
          agentId: 'main',
          name: title,
          agentName: title,
          agentType: 'main',
          model,
          status: 'active',
          lastActivity: latestAgentActivity,
          project,
          lastMessage: null,
          lastTool: null,
          lastToolInput: null,
          tokenUsage: emptyKimiCodeUsage(ctxMax),
          gitEvents: [],
          parentSessionId: null,
        });
      }

      for (const { agentName, wirePath, stat } of agentRecords) {
        const isMain = agentName === 'main';
        // Child agents can keep writing after the main wire goes quiet; keep the
        // main session visible so parent/child lineage remains intact in the UI.
        const lastActivity = isMain ? Math.max(stat.mtimeMs, latestAgentActivity) : stat.mtimeMs;
        if (now - lastActivity > activeThresholdMs) continue;

        const detail = detailsByAgentName.get(agentName) || parseWireDetailV2(wirePath);
        const sessionId = isMain ? `kimi-${sessionDirName}` : `kimi-${sessionDirName}::${agentName}`;

        const modelKey = detail.model || config.defaultModel;
        const modelEntry = modelKey ? config.models[modelKey] : null;
        const model = (modelEntry && modelEntry.displayName) || modelInfo.displayName || modelInfo.model || 'kimi';
        const ctxMax = (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0;
        const agentLabel = isMain ? title : agentName;

        sessions.push({
          sessionId,
          provider: 'kimi',
          agentId: agentName,
          name: agentLabel,
          agentName: agentLabel,
          agentType: isMain ? 'main' : 'sub-agent',
          model,
          status: 'active',
          lastActivity,
          project,
          lastMessage: detail.lastMessage,
          lastTool: detail.lastTool,
          lastToolInput: detail.lastToolInput,
          tokenUsage: getTokenUsageV2(wirePath, ctxMax),
          gitEvents: getGitEventsV2(wirePath, {
            provider: 'kimi',
            sessionId,
            project,
          }),
          parentSessionId: kimiCodeParentSessionId(sessionDirName, agentName, stateMeta.agents, activeAgentNames),
        });
      }
    }
  }

  return sessions;
}

// Resolve the wire.jsonl path for a Kimi Code session id ("<sessionDir>" or "<sessionDir>::<agent>").
function findKimiCodeWire(cleanId) {
  if (!fs.existsSync(KIMI_CODE_SESSIONS_DIR)) return null;
  let dirName = cleanId;
  let agentName = 'main';
  let explicitAgent = false;
  const sep = cleanId.indexOf('::');
  if (sep !== -1) {
    dirName = cleanId.slice(0, sep);
    agentName = cleanId.slice(sep + 2);
    explicitAgent = true;
  }

  const entry = readKimiCodeIndex().get(dirName);
  if (entry && entry.sessionDir) {
    const wire = safeExistingFile(
      path.join(entry.sessionDir, 'agents', agentName, 'wire.jsonl'),
      KIMI_CODE_SESSIONS_DIR,
    );
    if (wire) return wire;
  }

  // Fallback: scan workspaces for the session dir (e.g. brand-new, not yet indexed)
  try {
    const wsDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const wire = safeExistingFile(
        path.join(KIMI_CODE_SESSIONS_DIR, ws.name, dirName, 'agents', agentName, 'wire.jsonl'),
        KIMI_CODE_SESSIONS_DIR,
      );
      if (wire) return wire;
    }
  } catch { /* ignore */ }

  if (!explicitAgent) {
    const childWire = findNewestKimiCodeChildWire(dirName, entry?.sessionDir || null);
    if (childWire) return childWire;
  }

  return null;
}

function newestKimiCodeChildWireInSession(sessionPath) {
  const sessionDir = safeExistingDirectory(sessionPath, KIMI_CODE_SESSIONS_DIR);
  if (!sessionDir) return null;
  const agentsDir = path.join(sessionDir, 'agents');
  let best = null;
  try {
    const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'main');
    for (const agentDir of agentDirs) {
      const wire = safeExistingFile(path.join(agentsDir, agentDir.name, 'wire.jsonl'), KIMI_CODE_SESSIONS_DIR);
      if (!wire) continue;
      let stat;
      try { stat = fs.statSync(wire); } catch { continue; }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { wire, mtimeMs: stat.mtimeMs };
    }
  } catch { /* ignore */ }
  return best?.wire || null;
}

function findNewestKimiCodeChildWire(dirName, indexedSessionDir = null) {
  if (indexedSessionDir) {
    const wire = newestKimiCodeChildWireInSession(indexedSessionDir);
    if (wire) return wire;
  }

  try {
    const wsDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const sessionPath = path.join(KIMI_CODE_SESSIONS_DIR, ws.name, dirName);
      const wire = newestKimiCodeChildWireInSession(sessionPath);
      if (wire) return wire;
    }
  } catch { /* ignore */ }

  return null;
}

// ─── Adapter class ────────────────────────────────────

class KimiAdapter {
  get name() { return 'Kimi CLI'; }
  get provider() { return 'kimi'; }
  get homeDir() { return fs.existsSync(KIMI_CODE_DIR) ? KIMI_CODE_DIR : KIMI_DIR; }

  isAvailable() {
    return fs.existsSync(KIMI_DIR) || fs.existsSync(KIMI_CODE_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const now = Date.now();
    const sessions = [];

    if (fs.existsSync(SESSIONS_DIR)) {
      const config = readConfigToml();
      const modelInfo = resolveModelInfo(config);

      try {
        const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const projDir of projectDirs) {
          const projectHash = projDir.name;
          const projPath = path.join(SESSIONS_DIR, projectHash);
          const project = resolveProjectPath(projectHash);

          let sessionDirs;
          try {
            sessionDirs = fs.readdirSync(projPath, { withFileTypes: true })
              .filter(d => d.isDirectory());
          } catch { continue; }

          for (const sessionDir of sessionDirs) {
            const sessionId = sessionDir.name;
            const sessionPath = path.join(projPath, sessionId);
            const wirePath = path.join(sessionPath, 'wire.jsonl');

            if (!fs.existsSync(wirePath)) continue;

            let stat;
            try { stat = fs.statSync(wirePath); } catch { continue; }

            if (now - stat.mtimeMs > activeThresholdMs) continue;

            const statePath = path.join(sessionPath, 'state.json');
            const title = fs.existsSync(statePath) ? getSessionTitle(statePath) : null;
            const detail = parseWireDetail(wirePath);

            sessions.push({
              sessionId: `kimi-${sessionId}`,
              provider: 'kimi',
              agentId: sessionId,
              name: title,
              agentName: title,
              agentType: 'main',
              model: detail.model || modelInfo.displayName || modelInfo.model || 'kimi',
              status: 'active',
              lastActivity: stat.mtimeMs,
              project,
              lastMessage: detail.lastMessage,
              lastTool: detail.lastTool,
              lastToolInput: detail.lastToolInput,
              tokenUsage: getTokenUsage(wirePath),
              gitEvents: getGitEvents(wirePath, {
                provider: 'kimi',
                sessionId: `kimi-${sessionId}`,
                project,
              }),
              parentSessionId: null,
            });
          }
        }
      } catch { /* ignore */ }
    }

    sessions.push(...getActiveSessionsV2(activeThresholdMs, now));

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = stripKimiSessionPrefix(sessionId);

    // Kimi Code (~/.kimi-code) layout takes priority
    const codeWire = findKimiCodeWire(cleanId);
    if (codeWire) {
      const codeContext = getKimiCodeWireContext(codeWire, project);
      return createDetailResponse({
        project: codeContext.project,
        toolHistory: getToolHistoryV2(codeWire),
        messages: getRecentMessagesV2(codeWire),
        tokenUsage: getTokenUsageV2(codeWire, codeContext.contextWindowMax),
        sessionId,
      });
    }

    // Legacy ~/.kimi layout: find the wire file across all project directories
    if (!fs.existsSync(SESSIONS_DIR)) {
      return createDetailResponse({ sessionId });
    }

    try {
      const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projectDirs) {
        const wirePath = safeExistingFile(
          path.join(SESSIONS_DIR, projDir.name, cleanId, 'wire.jsonl'),
          SESSIONS_DIR,
        );
        if (wirePath) {
          return createDetailResponse({
            toolHistory: getToolHistory(wirePath),
            messages: getRecentMessages(wirePath),
            tokenUsage: getTokenUsage(wirePath),
            sessionId,
          });
        }
      }
    } catch { /* ignore */ }

    return createDetailResponse({ sessionId });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(KIMI_DIR)) {
      paths.push({ type: 'directory', path: KIMI_DIR, filters: ['sessions', 'kimi.json', 'config.toml'], scope: 'discovery' });
    }
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_JSON)) {
      paths.push({ type: 'file', path: KIMI_JSON, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(CONFIG_TOML)) {
      paths.push({ type: 'file', path: CONFIG_TOML, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(KIMI_CODE_DIR)) {
      paths.push({ type: 'directory', path: KIMI_CODE_DIR, filters: ['sessions', 'session_index.jsonl', 'config.toml'], scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_CODE_SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: KIMI_CODE_SESSIONS_DIR, scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_CODE_INDEX)) {
      paths.push({ type: 'file', path: KIMI_CODE_INDEX, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(KIMI_CODE_CONFIG_TOML)) {
      paths.push({ type: 'file', path: KIMI_CODE_CONFIG_TOML, scope: 'discovery', probe: true });
    }

    for (const session of sessions) {
      const cleanId = stripKimiSessionPrefix(session.sessionId);
      const baseId = cleanId.split('::', 1)[0];
      let sourcePath = null;

      if (session.project && !cleanId.includes('::')) {
        const legacySessionDir = path.join(SESSIONS_DIR, md5(session.project), baseId);
        const legacyWire = path.join(legacySessionDir, 'wire.jsonl');
        if (fs.existsSync(legacyWire)) {
          sourcePath = legacyWire;
          paths.push({ type: 'directory', path: path.dirname(legacySessionDir), scope: 'recent', activity: session.lastActivity });
          paths.push({ type: 'directory', path: legacySessionDir, filters: ['.jsonl', '.json'], scope: 'active', probe: true, activity: session.lastActivity });
        }
      }

      if (!sourcePath) {
        sourcePath = findKimiCodeWire(cleanId);
        if (sourcePath) {
          const agentDir = path.dirname(sourcePath);
          const agentsDir = path.dirname(agentDir);
          const sessionDir = path.dirname(agentsDir);
          paths.push({ type: 'directory', path: path.dirname(sessionDir), scope: 'recent', activity: session.lastActivity });
          paths.push({ type: 'directory', path: sessionDir, filters: ['.json'], scope: 'active', probe: true, activity: session.lastActivity });
          paths.push({ type: 'directory', path: agentsDir, scope: 'active', probe: true, activity: session.lastActivity });
          paths.push({ type: 'directory', path: agentDir, filters: ['.jsonl'], scope: 'active', probe: true, activity: session.lastActivity });
        }
      }

      if (sourcePath && fs.existsSync(sourcePath)) {
        paths.push({ type: 'file', path: sourcePath, scope: 'active', probe: true, activity: session.lastActivity });
      }
    }
    return paths;
  }

  invalidateCaches() {
    _configCache.at = 0;
    _configCache.value = null;
    _kimiJsonCache.at = 0;
    _kimiJsonCache.value = null;
    _codeConfigCache.at = 0;
    _codeConfigCache.value = null;
    _codeIndexCache.at = 0;
    _codeIndexCache.value = null;
  }
}

module.exports = { KimiAdapter };
