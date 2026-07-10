/**
 * OpenAI Codex CLI adapter
 * Data source: ~/.codex/
 *
 * Session rollout format (JSONL):
 *   {"type":"session_meta","payload":{"id":"...","cwd":"/path","cli_version":"..."}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"ls"}}
 *   {"type":"response_item","payload":{"type":"message","role":"assistant","content":[...]}}
 *   {"type":"event_msg","payload":{"type":"turn_complete","usage":{...}}}
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  createDetailResponse,
  fileSignature,
  parseJsonLines,
  readHeadText: readSharedHeadText,
  readLines: readSharedLines,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

// ─── Utilities ─────────────────────────────────────────────

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_METADATA_LINES = 24;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const GIT_EVENT_SCAN_LINES = 5000;
const MAX_CURRENT_TOOL_INPUT_CHARS = 500;
const MAX_ROLLOUT_DAY_DIRS = 8192;
const MAX_ROLLOUT_FILES = 100000;
const ROLLOUT_DIR_MTIME_EPSILON_MS = 1;

const _rolloutFileBySessionId = new Map();
const _sessionNamesCache = { signature: '', value: new Map() };
const _rolloutDiscoveryCache = {
  initialized: false,
  filesByPath: new Map(),
  dayDirMtimes: new Map(),
};
let _rolloutDiscoveryStats = {
  at: null,
  activeThresholdMs: null,
  dayDirsScanned: 0,
  rolloutFilesScanned: 0,
  resultCount: 0,
  capped: false,
  warning: null,
};

function readHeadText(filePath, maxBytes = MAX_METADATA_BYTES) {
  return readSharedHeadText(filePath, maxBytes);
}

function readLines(filePath, { from = 'end', count = 50 } = {}) {
  return readSharedLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
  });
}

function parseTimestampMs(value) {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function readCodexSessionNames() {
  const signature = fileSignature(SESSION_INDEX_FILE);
  if (_sessionNamesCache.signature === signature) return _sessionNamesCache.value;

  const names = new Map();
  const seenAt = new Map();
  try {
    const lines = fs.readFileSync(SESSION_INDEX_FILE, 'utf-8').split('\n');
    for (const entry of parseJsonLines(lines, { source: 'codex', file: SESSION_INDEX_FILE })) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      if (!id || !name) continue;

      const updatedAt = parseTimestampMs(entry.updated_at);
      const previous = seenAt.get(id) || 0;
      if (names.has(id) && updatedAt && previous && updatedAt < previous) continue;
      names.set(id, name);
      seenAt.set(id, updatedAt || Date.now());
    }
  } catch { /* ignore malformed or missing session index */ }

  _sessionNamesCache.signature = signature;
  _sessionNamesCache.value = names;
  return names;
}

// ─── Rollout parsing ──────────────────────────────────────

function extractJsonString(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractSessionMetadataFromText(line) {
  const metadataPrefix = line.split('"base_instructions"')[0];
  const agentId = extractJsonString(metadataPrefix, 'id');
  const agentName = extractJsonString(metadataPrefix, 'agent_nickname');
  const agentRole = extractJsonString(metadataPrefix, 'agent_role');
  const agentPath = extractJsonString(metadataPrefix, 'agent_path');
  const parentThreadId = extractJsonString(metadataPrefix, 'parent_thread_id');
  const model = extractJsonString(metadataPrefix, 'model');
  const project = extractJsonString(metadataPrefix, 'cwd');

  return {
    agentId,
    agentName,
    agentType: agentRole || null,
    agentPath,
    parentThreadId,
    model,
    project,
  };
}

function extractTurnMetadataFromPayload(payload) {
  if (!payload) return { model: null, reasoningEffort: null, project: null };
  return {
    model: payload.model || payload.collaboration_mode?.settings?.model || null,
    reasoningEffort: payload.effort
      || payload.reasoning_effort
      || payload.collaboration_mode?.settings?.reasoning_effort
      || null,
    project: payload.cwd || null,
  };
}

function extractTurnMetadataFromText(line) {
  const metadataPrefix = line.split('"user_instructions"')[0];
  return {
    model: extractJsonString(metadataPrefix, 'model'),
    reasoningEffort: extractJsonString(metadataPrefix, 'effort') || extractJsonString(metadataPrefix, 'reasoning_effort'),
    project: extractJsonString(metadataPrefix, 'cwd'),
  };
}

function applySessionMetadata(detail, metadata) {
  if (!metadata) return;
  if (!detail.agentId && metadata.agentId) detail.agentId = metadata.agentId;
  if (!detail.agentName && metadata.agentName) detail.agentName = metadata.agentName;
  if ((detail.agentType === 'main' || !detail.agentType) && metadata.agentType) detail.agentType = metadata.agentType;
  if (!detail.agentPath && metadata.agentPath) detail.agentPath = metadata.agentPath;
  if (!detail.parentThreadId && metadata.parentThreadId) detail.parentThreadId = metadata.parentThreadId;
  if (!detail.model && metadata.model) detail.model = metadata.model;
  if (!detail.project && metadata.project) detail.project = metadata.project;
}

function applyTurnMetadata(detail, metadata) {
  if (!metadata) return;
  if (!detail.model && metadata.model) detail.model = metadata.model;
  if (!detail.reasoningEffort && metadata.reasoningEffort) detail.reasoningEffort = metadata.reasoningEffort;
  if (!detail.project && metadata.project) detail.project = metadata.project;
}

function summarizeCodexToolPayload(payload, { maxLength = MAX_CURRENT_TOOL_INPUT_CHARS, missingValue = null } = {}) {
  if (payload.arguments) {
    const input = typeof payload.arguments === 'string'
      ? payload.arguments
      : JSON.stringify(payload.arguments);
    return summarizeSharedToolInput(input, {
      maxLength,
      missingValue,
      stringFallback: 'string',
    });
  }
  if (payload.command) {
    return summarizeSharedToolInput(payload.command, {
      maxLength,
      missingValue,
      stringFallback: 'string',
    });
  }
  return missingValue;
}

function parseEarlyMetadata(filePath, detail) {
  let headText = '';
  try {
    headText = readHeadText(filePath);
  } catch {
    return;
  }

  const lines = headText.split('\n').slice(0, MAX_METADATA_LINES);
  for (const line of lines) {
    if (!line.trim()) continue;

    let entry = null;
    try { entry = JSON.parse(line); } catch { /* oversized early records may be truncated */ }

    if (entry?.type === 'session_meta' && entry.payload) {
      const subagent = entry.payload.source?.subagent?.thread_spawn;
      applySessionMetadata(detail, {
        agentId: entry.payload.id || null,
        agentName: entry.payload.agent_nickname || subagent?.agent_nickname || null,
        agentType: entry.payload.agent_role || subagent?.agent_role || 'main',
        agentPath: entry.payload.agent_path || subagent?.agent_path || null,
        parentThreadId: subagent?.parent_thread_id || null,
        model: entry.payload.model || null,
        project: entry.payload.cwd || null,
      });
    } else if (line.includes('"type":"session_meta"') || line.includes('"type": "session_meta"')) {
      applySessionMetadata(detail, extractSessionMetadataFromText(line));
    }

    if (entry?.type === 'turn_context') {
      applyTurnMetadata(detail, extractTurnMetadataFromPayload(entry.payload));
    } else if (line.includes('"type":"turn_context"') || line.includes('"type": "turn_context"')) {
      applyTurnMetadata(detail, extractTurnMetadataFromText(line));
    }

    if (detail.agentId && detail.project && detail.model && detail.reasoningEffort) break;
  }
}

/**
 * Codex multi-agent v2 spawn rollouts inherit the parent's model in every
 * on-disk record (rollout, state DB); the child's variant survives only in
 * the orchestrator's task naming, e.g. agent_path "/root/luna_nav_responsive".
 * Infer the GPT-5.6 variant from that leaf prefix.
 */
function inferCodexModel(detail) {
  const model = detail.model;
  if (!model || !detail.agentPath || !/^gpt-5\.6/i.test(model)) return model;
  const leaf = String(detail.agentPath).split('/').filter(Boolean).pop() || '';
  const match = leaf.match(/^(sol|terra|luna)[-_]/i);
  if (!match) return model;
  return `gpt-5.6-${match[1].toLowerCase()}`;
}

/**
 * Extract session metadata/tools/messages from Codex rollout JSONL
 * Actual format: all data is inside entry.payload
 */
function parseRollout(filePath) {
  const detail = {
    agentId: null,
    agentName: null,
    agentType: 'main',
    agentPath: null,
    parentThreadId: null,
    model: null,
    reasoningEffort: null,
    project: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };

  parseEarlyMetadata(filePath, detail);

  // Read recent tools/messages from the end of the file
  const lastLines = readLines(filePath, { from: 'end', count: 50 });
  const entries = parseJsonLines(lastLines, { source: 'codex', file: filePath });

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const payload = entry.payload;
    if (!payload) continue;

    // response_item
    if (entry.type === 'response_item') {
      // Tool use (function_call)
      if (!detail.lastTool && (payload.type === 'function_call' || payload.type === 'command_execution')) {
        detail.lastTool = payload.name || payload.type;
        detail.lastToolInput = summarizeCodexToolPayload(payload);
      }

      // Text message (assistant)
      if (!detail.lastMessage && payload.type === 'message' && payload.role === 'assistant') {
        const content = payload.content;
        if (typeof content === 'string') {
          detail.lastMessage = content.substring(0, 80);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'output_text' && block.text) {
              detail.lastMessage = block.text.trim().substring(0, 80);
              break;
            }
            if (block.type === 'text' && block.text) {
              detail.lastMessage = block.text.trim().substring(0, 80);
              break;
            }
          }
        }
      }
    }

    // If model is missing, try extracting it from turn_context or event_msg
    if (entry.type === 'turn_context') applyTurnMetadata(detail, extractTurnMetadataFromPayload(payload));
    if (!detail.model && entry.type === 'event_msg' && payload.model) {
      detail.model = payload.model;
    }
    if (!detail.reasoningEffort && entry.type === 'event_msg') {
      detail.reasoningEffort = payload.effort || payload.reasoning_effort || null;
    }
  }

  return detail;
}

/**
 * Extract tool history from Codex rollouts
 */
function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const lines = readLines(filePath, { from: 'end', count: 100 });
    const entries = parseJsonLines(lines, { source: 'codex', file: filePath });
    const itemsByCallId = new Map();

    for (const entry of entries) {
      const completion = completionFromExecEvent(entry);
      if (completion) {
        const item = completion.callId ? itemsByCallId.get(completion.callId) : null;
        if (item && completion.exitCode !== null) {
          item.toolExitCode = completion.exitCode;
          if (completion.exitCode !== 0 && completion.stderr) {
            item.toolStderr = completion.stderr.trim().substring(0, 200);
          }
        }
        continue;
      }

      if (entry.type !== 'response_item' || !entry.payload) continue;
      const payload = entry.payload;

      if (payload.type === 'function_call' || payload.type === 'command_execution') {
        const detail = summarizeCodexToolPayload(payload, { maxLength: 80, missingValue: '' });
        const item = {
          tool: payload.name || payload.type,
          detail,
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
        };
        const callId = payload.call_id || payload.id || null;
        if (callId) itemsByCallId.set(callId, item);
        tools.push(item);
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

/**
 * Extract recent messages from Codex rollouts
 */
function getRecentMessages(filePath, maxItems = 5) {
  const messages = [];
  try {
    const lines = readLines(filePath, { from: 'end', count: 60 });
    const entries = parseJsonLines(lines, { source: 'codex', file: filePath });

    for (const entry of entries) {
      if (entry.type !== 'response_item' || !entry.payload) continue;
      const payload = entry.payload;
      if (payload.type !== 'message') continue;

      const role = payload.role || 'assistant';
      let text = '';
      if (typeof payload.content === 'string') {
        text = payload.content;
      } else if (Array.isArray(payload.content)) {
        for (const block of payload.content) {
          if ((block.type === 'output_text' || block.type === 'text') && block.text) {
            text = block.text;
            break;
          }
          if (block.type === 'input_text' && block.text && !block.text.startsWith('<environment_context>')) {
            text = block.text;
            break;
          }
        }
      }
      if (text.trim().length > 0) {
        messages.push({
          role,
          text: text.trim().substring(0, 200),
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
        });
      }
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function readUsageNumber(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * Codex rollout usage is usually emitted as cumulative token_count events.
 * Older formats may attach per-turn usage directly, so keep that fallback too.
 */
function getTokenUsage(filePath) {
  const tokenUsage = {
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
    // Codex output_tokens already includes reasoning_output_tokens
    // (total_tokens = input + output), so reasoning is a breakdown of
    // output and must not be priced again.
    reasoningTokens: 0,
    reasoningInOutput: true,
  };

  try {
    const lines = readLines(filePath, { from: 'end', count: 500 });
    const entries = parseJsonLines(lines, { source: 'codex', file: filePath });
    let lastInput = 0;
    let latestTokenCount = null;

    for (const entry of entries) {
      if (entry.payload?.type === 'token_count' && entry.payload.info?.total_token_usage) {
        latestTokenCount = entry.payload.info;
        continue;
      }

      const usage = entry.payload?.usage || entry.usage;
      if (!usage) continue;

      const input = readUsageNumber(usage, [
        'input_tokens',
        'inputTokens',
        'prompt_tokens',
        'promptTokens',
        'total_input_tokens',
      ]);
      const output = readUsageNumber(usage, [
        'output_tokens',
        'outputTokens',
        'completion_tokens',
        'completionTokens',
        'total_output_tokens',
      ]);
      const cacheRead = readUsageNumber(usage, [
        'cached_input_tokens',
        'cache_read_input_tokens',
        'cacheReadInputTokens',
      ]);
      const cacheCreate = readUsageNumber(usage, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens',
      ]);

      tokenUsage.totalInput += input;
      tokenUsage.totalOutput += output;
      tokenUsage.cacheRead += cacheRead;
      tokenUsage.cacheCreate += cacheCreate;
      tokenUsage.reasoningTokens += readUsageNumber(usage, [
        'reasoning_output_tokens',
        'reasoningOutputTokens',
        'reasoning_tokens',
      ]);
      tokenUsage.turnCount++;
      lastInput = input + cacheRead + cacheCreate;
    }

    if (latestTokenCount) {
      const total = latestTokenCount.total_token_usage || {};
      const last = latestTokenCount.last_token_usage || {};
      const totalInput = readUsageNumber(total, ['input_tokens', 'inputTokens']);
      const cachedInput = readUsageNumber(total, [
        'cached_input_tokens',
        'cache_read_input_tokens',
        'cacheReadInputTokens',
      ]);
      const lastTotal = readUsageNumber(last, ['total_tokens', 'totalTokens', 'input_tokens', 'inputTokens']);

      tokenUsage.totalInput = Math.max(0, totalInput - cachedInput);
      tokenUsage.totalOutput = readUsageNumber(total, ['output_tokens', 'outputTokens']);
      tokenUsage.cacheRead = cachedInput;
      tokenUsage.cacheCreate = 0;
      tokenUsage.reasoningTokens = readUsageNumber(total, [
        'reasoning_output_tokens',
        'reasoningOutputTokens',
      ]);
      tokenUsage.contextWindow = latestTokenCount.model_context_window
        ? Math.min(lastTotal, latestTokenCount.model_context_window)
        : lastTotal;
      tokenUsage.contextWindowMax = latestTokenCount.model_context_window || 0;
      tokenUsage.turnCount = entries.filter(entry => entry.payload?.type === 'token_count').length || tokenUsage.turnCount;
    } else {
      tokenUsage.contextWindow = lastInput;
    }
  } catch { /* ignore */ }

  return tokenUsage;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function parseTimestamp(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function commandFromExecPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.command === 'string') return payload.command;

  if (Array.isArray(payload.command)) {
    const shellFlagIndex = payload.command.findIndex(part => part === '-lc' || part === '-ic' || part === '-c');
    if (shellFlagIndex >= 0 && typeof payload.command[shellFlagIndex + 1] === 'string') {
      return payload.command[shellFlagIndex + 1];
    }
    if (payload.command.every(part => typeof part === 'string')) return payload.command.join(' ');
  }

  if (Array.isArray(payload.parsed_cmd) && payload.parsed_cmd.length === 1) {
    const parsed = payload.parsed_cmd[0];
    if (parsed && typeof parsed.cmd === 'string') return parsed.cmd;
  }

  return null;
}

function completionFromExecEvent(entry) {
  const payload = entry?.payload;
  if (entry?.type !== 'event_msg' || payload?.type !== 'exec_command_end') return null;

  const rawExitCode = payload.exit_code ?? payload.exitCode ?? payload.code;
  const exitCode = Number.isFinite(Number(rawExitCode)) ? Number(rawExitCode) : null;
  const completedAt = parseTimestamp(entry.timestamp || payload.timestamp || payload.completedAt || payload.completed_at);
  let success = null;
  if (typeof payload.success === 'boolean') {
    success = payload.success;
  } else if (exitCode !== null) {
    success = exitCode === 0;
  } else if (payload.status === 'failed' || payload.status === 'error') {
    success = false;
  }

  const stderrParts = [];
  if (typeof payload.stderr === 'string') stderrParts.push(payload.stderr);
  if (typeof payload.stdout === 'string') stderrParts.push(payload.stdout);
  if (!stderrParts.length && typeof payload.aggregated_output === 'string') stderrParts.push(payload.aggregated_output);

  return {
    callId: payload.call_id || payload.callId || payload.id || null,
    command: commandFromExecPayload(payload),
    success,
    exitCode,
    completedAt,
    stderr: stderrParts.join('\n'),
  };
}

function rememberGitEvents(events, bySourceId, byCommandHash) {
  for (const event of events) {
    if (event.sourceId) {
      if (!bySourceId.has(event.sourceId)) bySourceId.set(event.sourceId, new Map());
      bySourceId.get(event.sourceId).set(event.id, event);
    }

    if (event.commandHash) {
      if (!byCommandHash.has(event.commandHash)) byCommandHash.set(event.commandHash, new Map());
      byCommandHash.get(event.commandHash).set(event.id, event);
    }
  }
}

function applyCompletionMetadata(eventsById, completion) {
  if (!eventsById || !completion) return;
  for (const event of eventsById.values()) {
    if (typeof completion.success === 'boolean') event.success = completion.success;
    if (completion.exitCode !== null) event.exitCode = completion.exitCode;
    if (completion.completedAt) event.completedAt = completion.completedAt;
    if (completion.stderr) event.stderr = completion.stderr;
  }
}

function getGitEvents(filePath, context) {
  const events = [];
  try {
    const lines = readLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    const entries = parseJsonLines(lines, { source: 'codex', file: filePath });
    const eventsBySourceId = new Map();
    const eventsByCommandHash = new Map();

    entries.forEach((entry, entryIndex) => {
      const completion = completionFromExecEvent(entry);
      if (completion) {
        if (completion.callId && eventsBySourceId.has(completion.callId)) {
          applyCompletionMetadata(eventsBySourceId.get(completion.callId), completion);
          return;
        }

        const command = normalizeCommand(completion.command);
        const eventsById = command ? eventsByCommandHash.get(stableHash(command)) : null;
        if (eventsById && eventsById.size === 1) applyCompletionMetadata(eventsById, completion);
        return;
      }

      if (entry.type !== 'response_item' || !entry.payload) return;
      const payload = entry.payload;
      if (payload.type !== 'function_call' && payload.type !== 'command_execution') return;

      const commandSources = [];
      if (payload.command) commandSources.push(payload.command);
      if (payload.arguments) commandSources.push(payload.arguments);

      commandSources.forEach((source, sourceIndex) => {
        const parsedEvents = extractGitEventsFromCommandSource(source, {
          ...context,
          ts: entry.timestamp || payload.timestamp || 0,
          sourceId: payload.call_id || payload.id || entry.id || `${stableHash(JSON.stringify(entry))}:${sourceIndex}`,
        });
        events.push(...parsedEvents);
        rememberGitEvents(parsedEvents, eventsBySourceId, eventsByCommandHash);
      });
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

/**
 * Scan rollout files by file mtime, not date-directory recency.
 * Long-running sessions keep appending to their original day folder.
 */
function readSortedChildDirs(parentDir) {
  try {
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readRolloutFileNames(dayDir) {
  try {
    return fs.readdirSync(dayDir)
      .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function rememberRolloutFile(filePath, fileName, mtime, dayDir) {
  _rolloutDiscoveryCache.filesByPath.set(filePath, { fileName, mtime, dayDir });
}

function collectCachedActiveRollouts(activeCutoffMs) {
  const results = [];

  for (const [filePath, cached] of _rolloutDiscoveryCache.filesByPath) {
    const mtime = statMtimeMs(filePath);
    if (mtime === null) {
      _rolloutDiscoveryCache.filesByPath.delete(filePath);
      continue;
    }

    cached.mtime = mtime;
    if (mtime < activeCutoffMs) continue;

    results.push({
      filePath,
      mtime,
      fileName: cached.fileName || path.basename(filePath),
    });
  }

  return results;
}

function scanRolloutDayDir(dayDir, activeCutoffMs, resultsByPath, counters) {
  const fileNames = readRolloutFileNames(dayDir);

  for (const fileName of fileNames) {
    if (counters.files >= MAX_ROLLOUT_FILES) {
      counters.limited = true;
      return;
    }

    const filePath = path.join(dayDir, fileName);
    const mtime = statMtimeMs(filePath);
    counters.files++;
    if (mtime === null) continue;

    rememberRolloutFile(filePath, fileName, mtime, dayDir);
    if (mtime < activeCutoffMs) continue;

    resultsByPath.set(filePath, { filePath, mtime, fileName });
  }
}

function scanRecentRollouts(activeThresholdMs) {
  const startedAt = Date.now();
  const activeCutoffMs = Date.now() - activeThresholdMs;
  const resultsByPath = new Map();
  const counters = { dayDirs: 0, files: 0, limited: false };

  if (!fs.existsSync(SESSIONS_DIR)) {
    _rolloutDiscoveryCache.initialized = false;
    _rolloutDiscoveryCache.filesByPath.clear();
    _rolloutDiscoveryCache.dayDirMtimes.clear();
    recordRolloutDiscoveryStats(startedAt, activeThresholdMs, counters, 0);
    return [];
  }

  if (_rolloutDiscoveryCache.initialized) {
    for (const rollout of collectCachedActiveRollouts(activeCutoffMs)) {
      resultsByPath.set(rollout.filePath, rollout);
    }
  }

  try {
    const years = readSortedChildDirs(SESSIONS_DIR);

    yearLoop:
    for (const year of years) {
      const yearDir = path.join(SESSIONS_DIR, year);
      const months = readSortedChildDirs(yearDir);

      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = readSortedChildDirs(monthDir);

        for (const day of days) {
          const dayDir = path.join(monthDir, day);

          if (counters.dayDirs >= MAX_ROLLOUT_DAY_DIRS) {
            counters.limited = true;
            break yearLoop;
          }

          const dayDirMtime = statMtimeMs(dayDir);
          if (dayDirMtime === null) continue;

          counters.dayDirs++;
          const previousDayDirMtime = _rolloutDiscoveryCache.dayDirMtimes.get(dayDir);
          _rolloutDiscoveryCache.dayDirMtimes.set(dayDir, dayDirMtime);

          if (
            _rolloutDiscoveryCache.initialized
            && previousDayDirMtime !== undefined
            && Math.abs(dayDirMtime - previousDayDirMtime) <= ROLLOUT_DIR_MTIME_EPSILON_MS
          ) {
            continue;
          }

          scanRolloutDayDir(dayDir, activeCutoffMs, resultsByPath, counters);
          if (counters.limited) break yearLoop;
        }
      }
    }
  } catch { /* ignore */ }

  _rolloutDiscoveryCache.initialized = true;
  const rollouts = Array.from(resultsByPath.values()).sort((a, b) => b.mtime - a.mtime);
  recordRolloutDiscoveryStats(startedAt, activeThresholdMs, counters, rollouts.length);
  return rollouts;
}

function recordRolloutDiscoveryStats(startedAt, activeThresholdMs, counters, resultCount) {
  const capped = Boolean(counters.limited);
  _rolloutDiscoveryStats = {
    at: Date.now(),
    durationMs: Date.now() - startedAt,
    activeThresholdMs,
    dayDirsScanned: counters.dayDirs,
    rolloutFilesScanned: counters.files,
    resultCount,
    capped,
    caps: {
      dayDirs: MAX_ROLLOUT_DAY_DIRS,
      rolloutFiles: MAX_ROLLOUT_FILES,
    },
    warning: capped
      ? `Codex rollout discovery hit scan cap after ${counters.dayDirs} day directories and ${counters.files} rollout files`
      : null,
  };
}

// ─── Adapter class ────────────────────────────────────

class CodexAdapter {
  get name() { return 'Codex CLI'; }
  get provider() { return 'codex'; }
  get homeDir() { return CODEX_DIR; }

  isAvailable() {
    return fs.existsSync(CODEX_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const rollouts = scanRecentRollouts(activeThresholdMs);
    const sessionNames = readCodexSessionNames();
    const sessions = [];
    const parsedRollouts = [];
    const sessionIdByThreadId = new Map();

    for (const { filePath, mtime, fileName } of rollouts) {
      const detail = parseRollout(filePath);
      // Extract session ID from the filename: rollout-2025-01-22T10-30-00-abc123.jsonl
      const sessionId = fileName.replace('rollout-', '').replace('.jsonl', '');
      const fullSessionId = `codex-${sessionId}`;
      _rolloutFileBySessionId.set(fullSessionId, filePath);
      const threadId = detail.agentId || sessionId;
      sessionIdByThreadId.set(threadId, fullSessionId);
      parsedRollouts.push({ filePath, mtime, detail, sessionId, fullSessionId, threadId });
    }

    for (const { filePath, mtime, detail, sessionId, fullSessionId, threadId } of parsedRollouts) {
      const sessionName = sessionNames.get(threadId) || sessionNames.get(sessionId) || detail.agentName || null;
      sessions.push({
        sessionId: fullSessionId,
        provider: 'codex',
        agentId: threadId,
        name: sessionName,
        agentName: sessionName,
        agentType: detail.agentType || 'main',
        model: inferCodexModel(detail) || 'codex',
        reasoningEffort: detail.reasoningEffort,
        status: 'active',
        lastActivity: mtime,
        project: detail.project || null,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        tokenUsage: getTokenUsage(filePath),
        gitEvents: getGitEvents(filePath, {
          provider: 'codex',
          sessionId: fullSessionId,
          project: detail.project || null,
        }),
        parentSessionId: detail.parentThreadId
          ? sessionIdByThreadId.get(detail.parentThreadId) || `codex-${detail.parentThreadId}`
          : null,
      });
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    // sessionIdto find the file
    const cleanId = sessionId.replace('codex-', '');
    const indexedPath = _rolloutFileBySessionId.get(sessionId);
    if (indexedPath && fs.existsSync(indexedPath)) {
      return createDetailResponse({
        toolHistory: getToolHistory(indexedPath),
        messages: getRecentMessages(indexedPath),
        tokenUsage: getTokenUsage(indexedPath),
        sessionId,
      });
    }

    const rollouts = scanRecentRollouts(30 * 60 * 1000); // expand to a 30-minute range

    for (const { filePath, fileName } of rollouts) {
      const fileId = fileName.replace('rollout-', '').replace('.jsonl', '');
      if (fileId === cleanId) {
        _rolloutFileBySessionId.set(sessionId, filePath);
        return createDetailResponse({
          toolHistory: getToolHistory(filePath),
          messages: getRecentMessages(filePath),
          tokenUsage: getTokenUsage(filePath),
          sessionId,
        });
      }
    }

    return createDetailResponse({ sessionId });
  }

  getWatchPaths() {
    const paths = [];
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, recursive: true, filter: '.jsonl' });
    }
    if (fs.existsSync(SESSION_INDEX_FILE)) {
      paths.push({ type: 'file', path: SESSION_INDEX_FILE });
    }
    return paths;
  }

  invalidateCaches() {
    _rolloutFileBySessionId.clear();
    _sessionNamesCache.signature = '';
    _sessionNamesCache.value = new Map();
    // Keep rollout discovery metadata across ordinary provider invalidations.
    // Watch events usually mean one file changed; dropping this cache would turn
    // every active-session refresh back into a full historical scan.
  }

  getPerfStats() {
    return {
      rolloutDiscovery: _rolloutDiscoveryStats,
    };
  }
}

module.exports = { CodexAdapter };
