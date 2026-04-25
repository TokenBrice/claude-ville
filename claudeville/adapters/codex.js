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

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// ─── Utilities ─────────────────────────────────────────────

function readLines(filePath, { from = 'end', count = 50 } = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    if (from === 'start') return lines.slice(0, count);
    return lines.slice(-count);
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

/**
 * Extract session metadata/tools/messages from Codex rollout JSONL
 * Actual format: all data is inside entry.payload
 */
function parseRollout(filePath) {
  const detail = {
    model: null,
    project: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };

  // session_meta is on the first line, so read it first
  const firstLines = readLines(filePath, { from: 'start', count: 5 });
  const firstEntries = parseJsonLines(firstLines);
  for (const entry of firstEntries) {
    if (entry.type === 'session_meta' && entry.payload) {
      detail.model = entry.payload.model || null;
      detail.project = entry.payload.cwd || null;
      break;
    }
  }

  // Read recent tools/messages from the end of the file
  const lastLines = readLines(filePath, { from: 'end', count: 50 });
  const entries = parseJsonLines(lastLines);

  for (const entry of entries) {
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
          ).substring(0, 60);
        } else if (payload.command) {
          detail.lastToolInput = payload.command.substring(0, 60);
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
    if (!detail.model && entry.type === 'turn_context' && payload.model) {
      detail.model = payload.model;
    }
    if (!detail.model && entry.type === 'event_msg' && payload.model) {
      detail.model = payload.model;
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

    for (const { filePath, mtime, fileName } of rollouts) {
      const detail = parseRollout(filePath);
      // Extract session ID from the filename: rollout-2025-01-22T10-30-00-abc123.jsonl
      const sessionId = fileName.replace('rollout-', '').replace('.jsonl', '');

      sessions.push({
        sessionId: `codex-${sessionId}`,
        provider: 'codex',
        agentId: null,
        agentType: 'main',
        model: detail.model || 'codex',
        status: 'active',
        lastActivity: mtime,
        project: detail.project || null,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        tokenUsage: getTokenUsage(filePath),
        parentSessionId: null,
      });
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    // sessionIdto find the file
    const cleanId = sessionId.replace('codex-', '');
    const rollouts = scanRecentRollouts(30 * 60 * 1000); // expand to a 30-minute range

    for (const { filePath, fileName } of rollouts) {
      const fileId = fileName.replace('rollout-', '').replace('.jsonl', '');
      if (fileId === cleanId) {
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
}

module.exports = { CodexAdapter };
