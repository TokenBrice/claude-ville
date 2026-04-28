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

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// ─── Utilities ─────────────────────────────────────────────

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_METADATA_LINES = 24;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const GIT_EVENT_SCAN_LINES = 5000;
const MAX_CURRENT_TOOL_INPUT_CHARS = 500;

const _rolloutFileBySessionId = new Map();

function readHeadLines(filePath, count) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return [];

    const bytesToRead = Math.min(stat.size, MAX_HEAD_BYTES);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return buffer.toString('utf-8', 0, bytesRead).split('\n').slice(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

function readHeadText(filePath, maxBytes = MAX_METADATA_BYTES) {
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
}

function readTailLines(filePath, count) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return [];

    const chunks = [];
    let position = stat.size;
    let bytesCollected = 0;
    let newlineCount = 0;

    while (position > 0 && newlineCount <= count && bytesCollected < MAX_TAIL_BYTES) {
      const bytesToRead = Math.min(TAIL_CHUNK_BYTES, position, MAX_TAIL_BYTES - bytesCollected);
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

    return chunks.join('').trim().split('\n').slice(-count);
  } finally {
    fs.closeSync(fd);
  }
}

function readLines(filePath, { from = 'end', count = 50 } = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    if (from === 'start') return readHeadLines(filePath, count);
    return readTailLines(filePath, count);
  } catch {
    return [];
  }
}

function parseJsonLines(lines) {
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return results;
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
  const parentThreadId = extractJsonString(metadataPrefix, 'parent_thread_id');
  const model = extractJsonString(metadataPrefix, 'model');
  const project = extractJsonString(metadataPrefix, 'cwd');

  return {
    agentId,
    agentName,
    agentType: agentRole || null,
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
 * Extract session metadata/tools/messages from Codex rollout JSONL
 * Actual format: all data is inside entry.payload
 */
function parseRollout(filePath) {
  const detail = {
    agentId: null,
    agentName: null,
    agentType: 'main',
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
  const entries = parseJsonLines(lastLines);

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const payload = entry.payload;
    if (!payload) continue;

    // response_item
    if (entry.type === 'response_item') {
      // Tool use (function_call)
      if (!detail.lastTool && (payload.type === 'function_call' || payload.type === 'command_execution')) {
        detail.lastTool = payload.name || payload.type;
        if (payload.arguments) {
          detail.lastToolInput = (typeof payload.arguments === 'string'
            ? payload.arguments : JSON.stringify(payload.arguments)
          ).substring(0, MAX_CURRENT_TOOL_INPUT_CHARS);
        } else if (payload.command) {
          detail.lastToolInput = payload.command.substring(0, MAX_CURRENT_TOOL_INPUT_CHARS);
        }
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
    const entries = parseJsonLines(lines);

    for (const entry of entries) {
      if (entry.type !== 'response_item' || !entry.payload) continue;
      const payload = entry.payload;

      if (payload.type === 'function_call' || payload.type === 'command_execution') {
        let detail = '';
        if (payload.arguments) {
          detail = (typeof payload.arguments === 'string'
            ? payload.arguments : JSON.stringify(payload.arguments)
          ).substring(0, 80);
        } else if (payload.command) {
          detail = payload.command.substring(0, 80);
        }
        tools.push({
          tool: payload.name || payload.type,
          detail,
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
        });
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
    const entries = parseJsonLines(lines);

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
  };

  try {
    const lines = readLines(filePath, { from: 'end', count: 500 });
    const entries = parseJsonLines(lines);
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

  return {
    callId: payload.call_id || payload.callId || payload.id || null,
    command: commandFromExecPayload(payload),
    success,
    exitCode,
    completedAt,
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
  }
}

function getGitEvents(filePath, context) {
  const events = [];
  try {
    const lines = readLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    const entries = parseJsonLines(lines);
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
 * Scan rollout files from recent date directories
 */
function scanRecentRollouts(activeThresholdMs) {
  const results = [];
  if (!fs.existsSync(SESSIONS_DIR)) return results;

  const now = Date.now();

  try {
    // YYYY directory traversal
    const years = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse()
      .slice(0, 2); // only the last 2 years

    for (const year of years) {
      const yearDir = path.join(SESSIONS_DIR, year);
      const months = fs.readdirSync(yearDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse()
        .slice(0, 2); // only the last 2 months

      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .sort()
          .reverse()
          .slice(0, 3); // only the last 3 days

        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let rolloutFiles;
          try {
            rolloutFiles = fs.readdirSync(dayDir)
              .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'));
          } catch { continue; }

          for (const file of rolloutFiles) {
            const filePath = path.join(dayDir, file);
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }

            if (now - stat.mtimeMs > activeThresholdMs) continue;

            results.push({ filePath, mtime: stat.mtimeMs, fileName: file });
          }
        }
      }
    }
  } catch { /* ignore */ }

  return results;
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
      sessions.push({
        sessionId: fullSessionId,
        provider: 'codex',
        agentId: threadId,
        name: detail.agentName,
        agentName: detail.agentName,
        agentType: detail.agentType || 'main',
        model: detail.model || 'codex',
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
      return {
        toolHistory: getToolHistory(indexedPath),
        messages: getRecentMessages(indexedPath),
        tokenUsage: getTokenUsage(indexedPath),
        sessionId,
      };
    }

    const rollouts = scanRecentRollouts(30 * 60 * 1000); // expand to a 30-minute range

    for (const { filePath, fileName } of rollouts) {
      const fileId = fileName.replace('rollout-', '').replace('.jsonl', '');
      if (fileId === cleanId) {
        _rolloutFileBySessionId.set(sessionId, filePath);
        return {
          toolHistory: getToolHistory(filePath),
          messages: getRecentMessages(filePath),
          tokenUsage: getTokenUsage(filePath),
          sessionId,
        };
      }
    }

    return { toolHistory: [], messages: [], tokenUsage: null };
  }

  getWatchPaths() {
    const paths = [];
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, recursive: true, filter: '.jsonl' });
    }
    return paths;
  }

  invalidateCaches() {
    _rolloutFileBySessionId.clear();
  }
}

module.exports = { CodexAdapter };
