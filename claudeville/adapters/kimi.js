/**
 * Kimi CLI adapter
 * Data source: ~/.kimi/
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
]);

const _configCache = { at: 0, value: null };
const _kimiJsonCache = { at: 0, value: null };

// ─── Utilities ─────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
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

function readConfigToml() {
  const now = Date.now();
  if (_configCache.value && (now - _configCache.at) < 5000) return _configCache.value;
  try {
    const content = fs.readFileSync(CONFIG_TOML, 'utf-8');
    const config = { defaultModel: 'kimi-for-coding', models: {} };

    // Extract default_model
    const defaultMatch = content.match(/^default_model\s*=\s*"([^"]+)"/m);
    if (defaultMatch) config.defaultModel = defaultMatch[1];

    // Extract model blocks: [models."kimi-code/kimi-for-coding"]
    const modelBlockRegex = /^\[models\."([^"]+)"\]\s*\n((?:[^\[]*\n)*)/gm;
    let m;
    while ((m = modelBlockRegex.exec(content)) !== null) {
      const block = m[2];
      const modelMatch = block.match(/^model\s*=\s*"([^"]+)"/m);
      const displayMatch = block.match(/^display_name\s*=\s*"([^"]+)"/m);
      const providerMatch = block.match(/^provider\s*=\s*"([^"]+)"/m);
      config.models[m[1]] = {
        model: modelMatch ? modelMatch[1] : m[1],
        displayName: displayMatch ? displayMatch[1] : (modelMatch ? modelMatch[1] : m[1]),
        provider: providerMatch ? providerMatch[1] : 'kimi',
      };
    }

    _configCache.value = config;
    _configCache.at = now;
    return config;
  } catch {
    return { defaultModel: 'kimi-for-coding', models: {} };
  }
}

function resolveModelInfo(config) {
  const defaultModelKey = config.defaultModel || 'kimi-for-coding';
  const modelEntry = config.models[defaultModelKey];
  if (modelEntry) return modelEntry;
  return { model: 'kimi-for-coding', displayName: 'Kimi-k2.6', provider: 'kimi' };
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
  return summarizeSharedToolInput(argsStr, {
    fields: KIMI_TOOL_INPUT_FIELDS,
    basenameFields: basenameFile ? ['file_path'] : [],
    maxLength,
    missingValue: null,
    parseJsonStrings: true,
    stringFallback: 'string',
    objectFallback: 'none',
  });
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

// ─── Adapter class ────────────────────────────────────

class KimiAdapter {
  get name() { return 'Kimi CLI'; }
  get provider() { return 'kimi'; }
  get homeDir() { return KIMI_DIR; }

  isAvailable() {
    return fs.existsSync(KIMI_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    if (!fs.existsSync(SESSIONS_DIR)) return [];

    const now = Date.now();
    const config = readConfigToml();
    const modelInfo = resolveModelInfo(config);
    const sessions = [];

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

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = sessionId.replace('kimi-', '');
    // Find the wire file across all project directories
    if (!fs.existsSync(SESSIONS_DIR)) {
      return createDetailResponse({ sessionId });
    }

    try {
      const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projectDirs) {
        const wirePath = path.join(SESSIONS_DIR, projDir.name, cleanId, 'wire.jsonl');
        if (fs.existsSync(wirePath)) {
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

  getWatchPaths() {
    const paths = [];
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, recursive: true, filter: '.jsonl' });
      // Also watch state.json files
      paths.push({ type: 'directory', path: SESSIONS_DIR, recursive: true, filter: '.json' });
    }
    if (fs.existsSync(KIMI_JSON)) {
      paths.push({ type: 'file', path: KIMI_JSON });
    }
    return paths;
  }

  invalidateCaches() {
    _configCache.at = 0;
    _configCache.value = null;
    _kimiJsonCache.at = 0;
    _kimiJsonCache.value = null;
  }
}

module.exports = { KimiAdapter };
