/**
 * Google Gemini CLI adapter
 * Data source: ~/.gemini/
 *
 * Session format (JSON object):
 *   {
 *     "sessionId": "...",
 *     "projectHash": "...",      // cwd SHA-256 hash
 *     "messages": [
 *       {"type": "user", "content": "Hello"},
 *       {"type": "gemini", "content": "Hi!", "model": "gemini-2.5-flash", "tokens": {...}},
 *       {"type": "info", "content": "..."}
 *     ]
 *   }
 *
 * Restore project paths: projectHash is the SHA-256 hash of cwd
 * Hash known project paths to map them
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const SESSION_CACHE_MAX = 256;

const _parsedSessionCache = new Map();
const _sessionFileById = new Map();

// ─── Restore project paths ──────────────────────────────

/**
 * Reverse-map project paths from SHA-256 hashes
 * calculate hashes for known path candidates and match them
 */
const _hashToPathCache = new Map();

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function resolveProjectPath(projectHash) {
  // Check cache
  if (_hashToPathCache.has(projectHash)) {
    return _hashToPathCache.get(projectHash);
  }

  const homeDir = os.homedir();

  // Candidate 1: home directory itself
  if (sha256(homeDir) === projectHash) {
    _hashToPathCache.set(projectHash, homeDir);
    return homeDir;
  }

  // Candidate 2: first-level children under the home directory (Desktop, Documents, Projects etc.)
  const commonDirs = ['Desktop', 'Documents', 'Projects', 'Developer', 'dev', 'src', 'code', 'repos', 'workspace', 'work'];
  for (const dir of commonDirs) {
    const fullPath = path.join(homeDir, dir);
    if (sha256(fullPath) === projectHash) {
      _hashToPathCache.set(projectHash, fullPath);
      return fullPath;
    }
    // Search up to two levels deep
    try {
      if (fs.existsSync(fullPath)) {
        const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 50); // Limit if there are too many
        for (const sub of subdirs) {
          const subPath = path.join(fullPath, sub.name);
          if (sha256(subPath) === projectHash) {
            _hashToPathCache.set(projectHash, subPath);
            return subPath;
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Candidate 3: check hashes from Claude Code project paths
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projDirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of projDirs) {
        // Claude projects directory name: -Users-name-path format
        const projPath = '/' + dir.replace(/-/g, '/').replace(/^\//, '');
        if (sha256(projPath) === projectHash) {
          _hashToPathCache.set(projectHash, projPath);
          return projPath;
        }
      }
    }
  } catch { /* ignore */ }

  // Mapping failed; return null (do not show the hash directory name)
  _hashToPathCache.set(projectHash, null);
  return null;
}

function getParsedSession(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const key = `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    const cached = _parsedSessionCache.get(filePath);
    if (cached?.key === key) {
      _parsedSessionCache.delete(filePath);
      _parsedSessionCache.set(filePath, cached);
      return cached.session;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    _parsedSessionCache.set(filePath, { key, session });
    while (_parsedSessionCache.size > SESSION_CACHE_MAX) {
      const oldest = _parsedSessionCache.keys().next().value;
      if (oldest === undefined) break;
      _parsedSessionCache.delete(oldest);
    }
    return session;
  } catch {
    return null;
  }
}

// ─── Session parsing ────────────────────────────────────────

/**
 * Extract model/tools/messages from Gemini session JSON
 * Actual format: {sessionId, projectHash, messages: [{type, content, model, ...}]}
 */
function parseSession(filePath) {
  const detail = {
    model: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };

  try {
    const session = getParsedSession(filePath);
    if (!session) return detail;

    const messages = session.messages;
    if (!Array.isArray(messages)) return detail;

    // Scan backward from the end
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Gemini response message
      if (msg.type === 'gemini') {
        // Model information
        if (!detail.model && msg.model) {
          detail.model = msg.model;
        }

        // Text message
        if (!detail.lastMessage && msg.content) {
          const text = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (text.length > 0) {
            detail.lastMessage = text.substring(0, 80);
          }
        }

        // Tool use (when functionCall is present)
        if (!detail.lastTool && msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            detail.lastTool = tc.name || 'function_call';
            if (tc.args) {
              const args = tc.args;
              if (args.command) detail.lastToolInput = args.command.substring(0, 60);
              else if (args.file_path) detail.lastToolInput = args.file_path.split('/').pop();
              else detail.lastToolInput = JSON.stringify(args).substring(0, 60);
            }
            break;
          }
        }
      }

      // Tool call result (tool_call type)
      if (!detail.lastTool && msg.type === 'tool_call') {
        detail.lastTool = msg.name || msg.toolName || 'tool';
        if (msg.input) {
          detail.lastToolInput = (typeof msg.input === 'string'
            ? msg.input : JSON.stringify(msg.input)
          ).substring(0, 60);
        }
      }

      if (detail.lastMessage && detail.model) break;
    }
  } catch { /* ignore */ }

  return detail;
}

/**
 * Extract tool history from Gemini sessions
 */
function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const session = getParsedSession(filePath);
    if (!session) return tools;
    const messages = session.messages;
    if (!Array.isArray(messages)) return tools;

    for (const msg of messages) {
      // gemini type: check toolCalls
      if (msg.type === 'gemini' && msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          let detail = '';
          if (tc.args) {
            if (tc.args.command) detail = tc.args.command.substring(0, 80);
            else if (tc.args.file_path) detail = tc.args.file_path;
            else detail = JSON.stringify(tc.args).substring(0, 80);
          }
          tools.push({
            tool: tc.name || 'function_call',
            detail,
            ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
          });
        }
      }

      // tool_call type
      if (msg.type === 'tool_call') {
        let detail = '';
        if (msg.input) {
          detail = (typeof msg.input === 'string'
            ? msg.input : JSON.stringify(msg.input)
          ).substring(0, 80);
        }
        tools.push({
          tool: msg.name || msg.toolName || 'tool',
          detail,
          ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
        });
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

/**
 * Extract recent messages from Gemini sessions
 */
function getRecentMessages(filePath, maxItems = 5) {
  const msgList = [];
  try {
    const session = getParsedSession(filePath);
    if (!session) return msgList;
    const messages = session.messages;
    if (!Array.isArray(messages)) return msgList;

    for (const msg of messages) {
      if (msg.type === 'info') continue; // skip info messages

      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text.length === 0) continue;

      msgList.push({
        role: msg.type === 'gemini' ? 'assistant' : msg.type === 'user' ? 'user' : 'system',
        text: text.substring(0, 200),
        ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return msgList.slice(-maxItems);
}

function getGitEvents(filePath, context) {
  const events = [];
  try {
    const session = getParsedSession(filePath);
    if (!session) return events;
    const messages = session.messages;
    if (!Array.isArray(messages)) return events;

    messages.forEach((msg, msgIndex) => {
      const ts = msg.timestamp || 0;
      if (msg.type === 'gemini' && Array.isArray(msg.toolCalls)) {
        msg.toolCalls.forEach((tc, callIndex) => {
          if (!tc.args) return;
          events.push(...extractGitEventsFromCommandSource(tc.args, {
            ...context,
            ts,
            sourceId: tc.id || msg.id || `${stableHash(JSON.stringify(msg))}:${callIndex}`,
          }));
        });
      }

      if (msg.type === 'tool_call' && msg.input) {
        events.push(...extractGitEventsFromCommandSource(msg.input, {
          ...context,
          ts,
          sourceId: msg.id || `${stableHash(JSON.stringify(msg))}:input`,
        }));
      }
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

/**
 * Scan active session files
 * ~/.gemini/tmp/<project_hash>/chats/session-*.json
 */
function scanActiveSessions(activeThresholdMs) {
  const results = [];
  if (!fs.existsSync(TMP_DIR)) return results;

  const now = Date.now();

  try {
    const projectDirs = fs.readdirSync(TMP_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const projDir of projectDirs) {
      const chatsDir = path.join(TMP_DIR, projDir.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      let sessionFiles;
      try {
        sessionFiles = fs.readdirSync(chatsDir)
          .filter(f => f.startsWith('session-') && f.endsWith('.json'));
      } catch { continue; }

      for (const file of sessionFiles) {
        const filePath = path.join(chatsDir, file);
        let stat;
        try { stat = fs.statSync(filePath); } catch { continue; }

        if (now - stat.mtimeMs > activeThresholdMs) continue;

        results.push({
          filePath,
          mtime: stat.mtimeMs,
          fileName: file,
          projectHash: projDir.name,
        });
      }
    }
  } catch { /* ignore */ }

  return results;
}

// ─── Adapter class ────────────────────────────────────

class GeminiAdapter {
  get name() { return 'Gemini CLI'; }
  get provider() { return 'gemini'; }
  get homeDir() { return GEMINI_DIR; }

  isAvailable() {
    return fs.existsSync(GEMINI_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const sessionFiles = scanActiveSessions(activeThresholdMs);
    const sessions = [];

    for (const { filePath, mtime, fileName, projectHash } of sessionFiles) {
      const detail = parseSession(filePath);
      const sessionId = fileName.replace('session-', '').replace('.json', '');
      _sessionFileById.set(`gemini-${sessionId}`, filePath);
      const project = resolveProjectPath(projectHash);

      sessions.push({
        sessionId: `gemini-${sessionId}`,
        provider: 'gemini',
        agentId: null,
        agentType: 'main',
        model: detail.model || 'gemini',
        status: 'active',
        lastActivity: mtime,
        project: project,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        gitEvents: getGitEvents(filePath, {
          provider: 'gemini',
          sessionId: `gemini-${sessionId}`,
          project,
        }),
        parentSessionId: null,
      });
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = sessionId.replace('gemini-', '');
    const indexedPath = _sessionFileById.get(sessionId);
    if (indexedPath && fs.existsSync(indexedPath)) {
      return {
        toolHistory: getToolHistory(indexedPath),
        messages: getRecentMessages(indexedPath),
        sessionId,
      };
    }

    const sessionFiles = scanActiveSessions(30 * 60 * 1000);
    for (const { filePath, fileName } of sessionFiles) {
      const fileId = fileName.replace('session-', '').replace('.json', '');
      if (fileId === cleanId) {
        _sessionFileById.set(sessionId, filePath);
        return {
          toolHistory: getToolHistory(filePath),
          messages: getRecentMessages(filePath),
          sessionId,
        };
      }
    }

    return { toolHistory: [], messages: [] };
  }

  getWatchPaths() {
    const paths = [];
    if (fs.existsSync(TMP_DIR)) {
      try {
        const projDirs = fs.readdirSync(TMP_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const dir of projDirs) {
          const chatsDir = path.join(TMP_DIR, dir.name, 'chats');
          if (fs.existsSync(chatsDir)) {
            paths.push({ type: 'directory', path: chatsDir, filter: '.json' });
          }
        }
      } catch { /* ignore */ }
    }
    return paths;
  }

  invalidateCaches() {
    _parsedSessionCache.clear();
    _sessionFileById.clear();
  }
}

module.exports = { GeminiAdapter };
