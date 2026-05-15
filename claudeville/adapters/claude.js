/**
 * Claude Code CLI adapter
 * Data source: ~/.claude/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const GIT_EVENT_SCAN_LINES = 5000;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 64 * 1024 * 1024;
const MAX_HEAD_BYTES = 512 * 1024;
const SESSION_ENTRY_CACHE_MAX = 256;
const AGENT_LAUNCH_CACHE_MAX = 128;
const TOKEN_USAGE_CACHE_MAX = 128;

const _sessionEntryCache = new Map();
const _agentLaunchCache = new Map();
const _tokenUsageCache = new Map();
const _sessionNamesCache = { signature: '', value: new Map() };
const _teamMembershipCache = { signature: '', value: new Map() };
const _teamMembershipWarned = new Set();
const _teamsCache = { signature: '', value: [] };

// ─── Utilities ─────────────────────────────────────────────

function readLastLines(filePath, lineCount) {
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
      while (position > 0 && newlineCount <= lineCount && bytesCollected < MAX_TAIL_BYTES) {
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
      return chunks.join('').trim().split('\n').slice(-lineCount);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function readFirstLines(filePath, lineCount) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size === 0) return [];
      const bytesToRead = Math.min(stat.size, MAX_HEAD_BYTES);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return buffer.toString('utf-8', 0, bytesRead).split('\n').slice(0, lineCount);
    } finally {
      fs.closeSync(fd);
    }
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

function readJsonLines(filePath, { from = 'end', count = GIT_EVENT_SCAN_LINES } = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = from === 'start' ? readFirstLines(filePath, count) : readLastLines(filePath, count);
    return parseJsonLines(lines);
  } catch {
    return [];
  }
}

function statCacheKey(filePath, stat) {
  return `${filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino || 0}`;
}

function readClaudeSessionNames() {
  const signature = directorySignature(SESSIONS_DIR, { extension: '.json' });
  if (_sessionNamesCache.signature === signature) return _sessionNamesCache.value;
  const names = new Map();
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return names;
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(file => file.endsWith('.json') && !file.startsWith('.'));

    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId.trim() : '';
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (sessionId && name) names.set(sessionId, name);
      } catch { /* ignore malformed session metadata */ }
    }
  } catch { /* ignore */ }
  _sessionNamesCache.signature = signature;
  _sessionNamesCache.value = names;
  return names;
}

function readClaudeTeamMembership() {
  const signature = directorySignature(TEAMS_DIR, { recursive: true, extension: '.json' });
  if (_teamMembershipCache.signature === signature) return _teamMembershipCache.value;
  const members = new Map();
  if (!fs.existsSync(TEAMS_DIR)) return members;
  try {
    const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter(dir => dir.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    const collisions = new Map();

    for (const teamDir of teamDirs) {
      const inboxDir = path.join(TEAMS_DIR, teamDir.name, 'inboxes');
      if (!fs.existsSync(inboxDir)) continue;
      let inboxFiles;
      try {
        inboxFiles = fs.readdirSync(inboxDir)
          .filter(file => file.endsWith('.json') && !file.startsWith('.'))
          .sort();
      } catch {
        continue;
      }
      for (const file of inboxFiles) {
        const agentName = path.basename(file, '.json');
        if (!agentName) continue;
        const previous = members.get(agentName);
        if (previous && previous !== teamDir.name) {
          const list = collisions.get(agentName) || [previous];
          list.push(teamDir.name);
          collisions.set(agentName, list);
        }
        members.set(agentName, teamDir.name);
      }
    }

    for (const [agentName, teams] of collisions.entries()) {
      const winner = members.get(agentName);
      const key = `${agentName}|${teams.slice().sort().join(',')}|${winner}`;
      if (_teamMembershipWarned.has(key)) continue;
      _teamMembershipWarned.add(key);
      console.warn(`[claude adapter] agentName "${agentName}" appears in multiple teams: ${teams.join(', ')}; using ${winner}`);
    }
  } catch { /* ignore */ }
  _teamMembershipCache.signature = signature;
  _teamMembershipCache.value = members;
  return members;
}

function directorySignature(dirPath, { recursive = false, extension = '' } = {}) {
  try {
    if (!fs.existsSync(dirPath)) return 'missing';
    const parts = [];
    const walk = (current, depth = 0) => {
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive && depth < 4) walk(fullPath, depth + 1);
          continue;
        }
        if (extension && !entry.name.endsWith(extension)) continue;
        try {
          const stat = fs.statSync(fullPath);
          parts.push(statCacheKey(fullPath, stat));
        } catch { /* ignore */ }
      }
    };
    walk(dirPath);
    return parts.join('|');
  } catch {
    return 'error';
  }
}

function getSessionEntries(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = statCacheKey(filePath, stat);
    const cached = _sessionEntryCache.get(filePath);
    if (cached?.key === cacheKey) {
      _sessionEntryCache.delete(filePath);
      _sessionEntryCache.set(filePath, cached);
      return cached.entries;
    }
    const entries = readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    _sessionEntryCache.set(filePath, { key: cacheKey, entries });
    while (_sessionEntryCache.size > SESSION_ENTRY_CACHE_MAX) {
      const oldest = _sessionEntryCache.keys().next().value;
      if (oldest === undefined) break;
      _sessionEntryCache.delete(oldest);
    }
    return entries;
  } catch {
    return [];
  }
}

function tailEntries(filePath, count) {
  const entries = getSessionEntries(filePath);
  return entries.slice(-count);
}

function getFullSessionEntries(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = statCacheKey(filePath, stat);
  const cached = _tokenUsageCache.get(filePath);
  if (cached?.key === cacheKey) {
    _tokenUsageCache.delete(filePath);
    _tokenUsageCache.set(filePath, cached);
    return cached.entries;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const entries = parseJsonLines(raw ? raw.split('\n') : []);
  _tokenUsageCache.set(filePath, { key: cacheKey, entries, usage: null });
  while (_tokenUsageCache.size > TOKEN_USAGE_CACHE_MAX) {
    const oldest = _tokenUsageCache.keys().next().value;
    if (oldest === undefined) break;
    _tokenUsageCache.delete(oldest);
  }
  return entries;
}

function readUsageNumber(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function summarizeToolInput(input, { maxLength = 60, basenameFile = true } = {}) {
  if (!input) return null;

  let value = null;
  if (input.command) value = input.command;
  else if (input.file_path) value = basenameFile ? input.file_path.split('/').pop() : input.file_path;
  else if (input.pattern) value = input.pattern;
  else if (input.query) value = input.query;
  else if (input.target) value = input.target;
  else if (input.target_agent_id) value = input.target_agent_id;
  else if (input.targetAgentId) value = input.targetAgentId;
  else if (input.session_id) value = input.session_id;
  else if (input.sessionId) value = input.sessionId;
  else if (input.agent_id) value = input.agent_id;
  else if (input.agentId) value = input.agentId;
  else if (input.thread_id) value = input.thread_id;
  else if (input.threadId) value = input.threadId;
  else if (input.id) value = input.id;
  else if (Array.isArray(input.targets)) value = input.targets.join(',');
  else if (input.recipient) value = input.recipient;
  else if (input.description) value = input.description;
  else if (input.prompt) value = input.prompt;
  else if (input.url) value = input.url;

  return value ? String(value).substring(0, maxLength) : null;
}

function getFirstUserPrompt(filePath) {
  const entries = readJsonLines(filePath, { from: 'start', count: 200 });
  for (const entry of entries) {
    if (entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.find(block => block.type === 'text' && block.text)?.text;
      if (text) return text;
    }
  }
  return null;
}

function getAgentLaunches(sessionFilePath) {
  try {
    const stat = fs.statSync(sessionFilePath);
    const cacheKey = statCacheKey(sessionFilePath, stat);
    const cached = _agentLaunchCache.get(sessionFilePath);
    if (cached?.key === cacheKey) {
      _agentLaunchCache.delete(sessionFilePath);
      _agentLaunchCache.set(sessionFilePath, cached);
      return cached.launches;
    }

    const launches = [];
    const raw = fs.readFileSync(sessionFilePath, 'utf-8');
    const entries = parseJsonLines(raw ? raw.split('\n') : []);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type !== 'tool_use' || block.name !== 'Agent' || !block.input) continue;
        launches.push({
          name: block.input.description || null,
          agentType: block.input.subagent_type || 'sub-agent',
          prompt: block.input.prompt || null,
        });
      }
    }

    _agentLaunchCache.set(sessionFilePath, { key: cacheKey, launches });
    while (_agentLaunchCache.size > AGENT_LAUNCH_CACHE_MAX) {
      const oldest = _agentLaunchCache.keys().next().value;
      if (oldest === undefined) break;
      _agentLaunchCache.delete(oldest);
    }
    return launches;
  } catch {
    return [];
  }
}

// ─── Session parsing ────────────────────────────────────────

function getSessionDetail(sessionId, projectPath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  if (!projectPath) return detail;

  const encoded = projectPath.replace(/\//g, '-');
  const sessionFile = path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionFile)) return detail;

  try {
    const entries = tailEntries(sessionFile, 30);

    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i].message;
      if (!msg || msg.role !== 'assistant') continue;

      if (!detail.model && msg.model) detail.model = msg.model;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!detail.lastTool && block.type === 'tool_use') {
          detail.lastTool = block.name || null;
          detail.lastToolInput = summarizeToolInput(block.input, { maxLength: 60, basenameFile: true });
        }
        if (!detail.lastMessage && block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) detail.lastMessage = text.substring(0, 80);
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch { /* ignore */ }

  return detail;
}

function getSubAgentDetail(filePath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  try {
    const entries = tailEntries(filePath, 20);

    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i].message;
      if (!msg || msg.role !== 'assistant') continue;

      if (!detail.model && msg.model) detail.model = msg.model;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!detail.lastTool && block.type === 'tool_use') {
          detail.lastTool = block.name || null;
          detail.lastToolInput = summarizeToolInput(block.input, { maxLength: 60, basenameFile: true });
        }
        if (!detail.lastMessage && block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) detail.lastMessage = text.substring(0, 80);
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch { /* ignore */ }
  return detail;
}

function getToolHistory(sessionFilePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = tailEntries(sessionFilePath, 100);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const detail = summarizeToolInput(block.input, { maxLength: 80, basenameFile: false }) || '';
        tools.push({ tool: block.name || 'unknown', detail, ts: entry.timestamp || 0 });
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function getRecentMessages(sessionFilePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = tailEntries(sessionFilePath, 60);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg) continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'text' || !block.text) continue;
        const text = block.text.trim();
        if (text.length === 0) continue;
        messages.push({ role: msg.role, text: text.substring(0, 200), ts: entry.timestamp || 0 });
      }
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function getTokenUsage(sessionFilePath) {
  const emptyUsage = {
    input: 0,
    output: 0,
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,  // Context size for the last turn
    turnCount: 0,
  };
  try {
    const stat = fs.statSync(sessionFilePath);
    const cacheKey = statCacheKey(sessionFilePath, stat);
    const cached = _tokenUsageCache.get(sessionFilePath);
    if (cached?.key === cacheKey && cached.usage) {
      _tokenUsageCache.delete(sessionFilePath);
      _tokenUsageCache.set(sessionFilePath, cached);
      return { ...cached.usage };
    }

    const usage = { ...emptyUsage };
    const entries = cached?.key === cacheKey ? cached.entries : getFullSessionEntries(sessionFilePath);

    let lastUsage = null;
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || !msg.usage) continue;
      const u = msg.usage;
      usage.totalInput += readUsageNumber(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
      usage.totalOutput += readUsageNumber(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
      usage.cacheRead += readUsageNumber(u, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadInputTokens']);
      usage.cacheCreate += readUsageNumber(u, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
      usage.turnCount++;
      lastUsage = u;
    }
    usage.input = usage.totalInput;
    usage.output = usage.totalOutput;

    // Last turn context = input + cache_read + cache_create
    if (lastUsage) {
      usage.contextWindow =
        readUsageNumber(lastUsage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']) +
        readUsageNumber(lastUsage, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadInputTokens']) +
        readUsageNumber(lastUsage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
    }

    const latest = _tokenUsageCache.get(sessionFilePath);
    if (latest?.key === cacheKey) latest.usage = { ...usage };
    return usage;
  } catch { /* ignore */ }
  return emptyUsage;
}

function getGitEvents(sessionFilePath, context) {
  const events = [];
  try {
    const entries = getSessionEntries(sessionFilePath);

    entries.forEach((entry, entryIndex) => {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;

      msg.content.forEach((block, blockIndex) => {
        if (block.type !== 'tool_use' || !block.input) return;
        events.push(...extractGitEventsFromCommandSource(block.input, {
          ...context,
          ts: entry.timestamp || entry.created_at || 0,
          sourceId: block.id || entry.uuid || entry.id || `${stableHash(JSON.stringify(entry))}:${blockIndex}`,
        }));
      });
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

function resolveSessionFilePath(sessionId, project) {
  if (!project) return null;
  const encoded = project.replace(/\//g, '-');
  const projectsDir = path.join(CLAUDE_DIR, 'projects', encoded);

  if (sessionId.startsWith('subagent-')) {
    const agentId = sessionId.replace('subagent-', '');
    try {
      const sessionDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of sessionDirs) {
        const agentFile = path.join(projectsDir, dir.name, 'subagents', `agent-${agentId}.jsonl`);
        if (fs.existsSync(agentFile)) return agentFile;
      }
    } catch { /* ignore */ }
    return null;
  }

  const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);
  return fs.existsSync(sessionFile) ? sessionFile : null;
}

function getSessionFileActivity(sessionId, project) {
  if (!project) return 0;
  const encoded = project.replace(/\//g, '-');
  const sessionFile = path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(sessionFile)) return fs.statSync(sessionFile).mtimeMs;
  } catch { /* ignore */ }
  return 0;
}

function resolveProjectPathFromMap(projectPathMap, encodedProject) {
  return projectPathMap.get(encodedProject)
    || `/${encodedProject.replace(/^-/, '').replace(/-/g, '/')}`;
}

// ─── Adapter class ────────────────────────────────────

class ClaudeAdapter {
  get name() { return 'Claude Code'; }
  get provider() { return 'claude'; }
  get homeDir() { return CLAUDE_DIR; }

  isAvailable() {
    return fs.existsSync(CLAUDE_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const lines = readLastLines(HISTORY_FILE, 1000);
    const entries = parseJsonLines(lines);
    const now = Date.now();
    const sessionsMap = new Map();
    const projectPathMap = new Map(); // Encoded directory name to real path
    const activeSessionIdsByProject = new Map();
    const sessionNames = readClaudeSessionNames();
    const teamMembership = readClaudeTeamMembership();

    const HISTORY_SCAN_MS = 10 * 60 * 1000;
    for (const entry of entries) {
      // Build the project path map from all entries, regardless of active state
      if (entry.project) {
        const encoded = entry.project.replace(/\//g, '-');
        projectPathMap.set(encoded, entry.project);
        if (!activeSessionIdsByProject.has(encoded)) {
          activeSessionIdsByProject.set(encoded, new Set());
        }
      }

      if (!entry.sessionId) continue;
      if (now - (entry.timestamp || 0) > HISTORY_SCAN_MS) continue;

      const existing = sessionsMap.get(entry.sessionId);
      if (!existing || (entry.timestamp || 0) > (existing.timestamp || 0)) {
        if (entry.project) {
          const encoded = entry.project.replace(/\//g, '-');
          activeSessionIdsByProject.set(encoded, activeSessionIdsByProject.get(encoded) || new Set());
          activeSessionIdsByProject.get(encoded).add(entry.sessionId);
        }
        sessionsMap.set(entry.sessionId, {
          sessionId: entry.sessionId,
          provider: 'claude',
          agentId: entry.agentId || null,
          agentType: entry.agentType || (entry.agentId ? 'sub-agent' : 'main'),
          model: entry.model || 'unknown',
          status: 'active',
          lastActivity: entry.timestamp || 0,
          project: entry.project || null,
          lastMessage: entry.display ? entry.display.substring(0, 100) : null,
        });
      }
    }

    const mainSessions = [];
    for (const session of sessionsMap.values()) {
      const fileMtime = getSessionFileActivity(session.sessionId, session.project);
      const lastActive = Math.max(session.lastActivity, fileMtime);
      if (now - lastActive > activeThresholdMs) continue;

      session.lastActivity = lastActive;
      const detail = getSessionDetail(session.sessionId, session.project);
      const sessionFilePath = resolveSessionFilePath(session.sessionId, session.project);
      const sessionName = sessionNames.get(session.sessionId) || null;
      const teamName = sessionName ? teamMembership.get(sessionName) || null : null;
      mainSessions.push({
        ...session,
        name: sessionName,
        agentName: sessionName,
        teamName,
        model: detail.model || session.model,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        lastMessage: detail.lastMessage || session.lastMessage,
        tokenUsage: sessionFilePath ? getTokenUsage(sessionFilePath) : null,
        gitEvents: sessionFilePath ? getGitEvents(sessionFilePath, {
          provider: 'claude',
          sessionId: session.sessionId,
          project: session.project,
        }) : [],
      });
    }

    mainSessions.sort((a, b) => b.lastActivity - a.lastActivity);

    // Orphan sessions (active .jsonl files whose history entry is older than HISTORY_SCAN_MS).
    // Computed before subagents so their session IDs feed into the subagent scan — otherwise
    // long-running parents that haven't logged a recent prompt would have their subagents missed.
    const orphans = this._getOrphanSessions(activeThresholdMs, projectPathMap, new Set(sessionsMap.keys()), sessionNames, teamMembership);
    for (const orphan of orphans) {
      if (!orphan.project || !orphan.sessionId) continue;
      const encoded = orphan.project.replace(/\//g, '-');
      if (!activeSessionIdsByProject.has(encoded)) activeSessionIdsByProject.set(encoded, new Set());
      activeSessionIdsByProject.get(encoded).add(orphan.sessionId);
    }

    const subAgents = this._getActiveSubAgents(activeThresholdMs, activeSessionIdsByProject, projectPathMap);

    return [...mainSessions, ...subAgents, ...orphans];
  }

  _getActiveSubAgents(activeThresholdMs, activeSessionIdsByProject = new Map(), projectPathMap = new Map()) {
    if (activeSessionIdsByProject.size === 0) return [];

    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const results = [];

    try {
      for (const [encodedProject, sessionIds] of activeSessionIdsByProject.entries()) {
        const projPath = path.join(projectsDir, encodedProject);
        if (!fs.existsSync(projPath)) continue;

        for (const sessionId of sessionIds) {
          const subagentsDir = path.join(projPath, sessionId, 'subagents');
          if (!fs.existsSync(subagentsDir)) continue;
          const parentSessionFile = path.join(projPath, `${sessionId}.jsonl`);
          const agentLaunches = getAgentLaunches(parentSessionFile);

          let agentFiles;
          try {
            agentFiles = fs.readdirSync(subagentsDir)
              .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
          } catch { continue; }

          for (const agentFile of agentFiles) {
            const filePath = path.join(subagentsDir, agentFile);
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }

            if (now - stat.mtimeMs > activeThresholdMs) continue;

            const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
            const detail = getSubAgentDetail(filePath);
            const prompt = getFirstUserPrompt(filePath);
            const launch = prompt
              ? agentLaunches.find(item => item.prompt === prompt)
              : null;
            const decodedProject = resolveProjectPathFromMap(projectPathMap, encodedProject);

            results.push({
              sessionId: `subagent-${agentId}`,
              provider: 'claude',
              agentId,
              name: launch?.name || null,
              agentName: launch?.name || null,
              agentType: launch?.agentType || 'sub-agent',
              model: detail.model || 'unknown',
              status: 'active',
              lastActivity: stat.mtimeMs,
              project: decodedProject,
              lastMessage: detail.lastMessage,
              lastTool: detail.lastTool,
              lastToolInput: detail.lastToolInput,
              tokenUsage: getTokenUsage(filePath),
              gitEvents: getGitEvents(filePath, {
                provider: 'claude',
                sessionId: `subagent-${agentId}`,
                project: decodedProject,
              }),
              parentSessionId: sessionId,
            });
          }
        }
      }
    } catch { /* ignore */ }

    return results;
  }

  _getOrphanSessions(activeThresholdMs, projectPathMap = new Map(), knownIds = new Set(), sessionNames = new Map(), teamMembership = new Map()) {
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const results = [];

    try {
      const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projDirs) {
        const projPath = path.join(projectsDir, projDir.name);
        let files;
        try {
          files = fs.readdirSync(projPath)
            .filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));
        } catch { continue; }

        for (const file of files) {
          const sessionId = file.replace('.jsonl', '');
          // Skip sessions already known
          if (knownIds.has(sessionId)) continue;

          const filePath = path.join(projPath, file);
          let stat;
          try { stat = fs.statSync(filePath); } catch { continue; }

          // Long-running parents (e.g., orchestrating 8 audit subagents) can leave their
          // own .jsonl untouched for minutes while children write constantly. Treat the
          // session as active if either the parent file or any subagent file is fresh.
          let lastActivity = stat.mtimeMs;
          const subagentsDir = path.join(projPath, sessionId, 'subagents');
          if (fs.existsSync(subagentsDir)) {
            try {
              for (const agentFile of fs.readdirSync(subagentsDir)) {
                if (!agentFile.startsWith('agent-') || !agentFile.endsWith('.jsonl')) continue;
                try {
                  const aStat = fs.statSync(path.join(subagentsDir, agentFile));
                  if (aStat.mtimeMs > lastActivity) lastActivity = aStat.mtimeMs;
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }

          if (now - lastActivity > activeThresholdMs) continue;

          const detail = getSubAgentDetail(filePath);
          const decodedProject = resolveProjectPathFromMap(projectPathMap, projDir.name);
          const sessionName = sessionNames.get(sessionId) || null;
          const teamName = sessionName ? teamMembership.get(sessionName) || null : null;

          results.push({
            sessionId,
            provider: 'claude',
            agentId: sessionId,
            name: sessionName,
            agentName: sessionName,
            teamName,
            agentType: 'team-member',
            model: detail.model || 'unknown',
            status: 'active',
            lastActivity,
            project: decodedProject,
            lastMessage: detail.lastMessage,
            lastTool: detail.lastTool,
            lastToolInput: detail.lastToolInput,
            tokenUsage: getTokenUsage(filePath),
            gitEvents: getGitEvents(filePath, {
              provider: 'claude',
              sessionId,
              project: decodedProject,
            }),
          });
        }
      }
    } catch { /* ignore */ }

    return results;
  }

  getSessionDetail(sessionId, project) {
    const filePath = resolveSessionFilePath(sessionId, project);
    if (!filePath) return { toolHistory: [], messages: [], tokenUsage: null };
    return {
      toolHistory: getToolHistory(filePath),
      messages: getRecentMessages(filePath),
      tokenUsage: getTokenUsage(filePath),
      sessionId,
    };
  }

  getWatchPaths() {
    const paths = [];

    // history.jsonl
    if (fs.existsSync(HISTORY_FILE)) {
      paths.push({ type: 'file', path: HISTORY_FILE });
    }

    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, filter: '.json' });
    }

    // Project directory (recursive also detects subagent files)
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      try {
        const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const dir of projDirs) {
          paths.push({
            type: 'directory',
            path: path.join(projectsDir, dir.name),
            filter: '.jsonl',
            recursive: true,
          });
        }
      } catch { /* ignore */ }
    }

    // Watch team directory (detect team creation/changes)
    if (fs.existsSync(TEAMS_DIR)) {
      paths.push({
        type: 'directory',
        path: TEAMS_DIR,
        recursive: true,
        filter: '.json',
      });
    }

    return paths;
  }

  // ─── Teams/tasks (Claude-only) ──────────────────────

  getTeams() {
    const signature = directorySignature(TEAMS_DIR, { recursive: true, extension: '.json' });
    if (_teamsCache.signature === signature) return _teamsCache.value;
    if (!fs.existsSync(TEAMS_DIR)) return [];
    const teams = [];
    try {
      const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of teamDirs) {
        const configPath = path.join(TEAMS_DIR, dir.name, 'config.json');
        try {
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            teams.push({ teamName: dir.name, ...config });
          }
        } catch {
          teams.push({ teamName: dir.name, error: 'parse failed' });
        }
      }
    } catch { /* ignore */ }
    _teamsCache.signature = signature;
    _teamsCache.value = teams;
    return teams;
  }

  getTasks() {
    if (!fs.existsSync(TASKS_DIR)) return [];
    const taskGroups = [];
    try {
      const taskDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of taskDirs) {
        const groupDir = path.join(TASKS_DIR, dir.name);
        const tasks = [];
        try {
          const files = fs.readdirSync(groupDir).filter(f => f.endsWith('.json'));
          for (const file of files) {
            try {
              tasks.push(JSON.parse(fs.readFileSync(path.join(groupDir, file), 'utf-8')));
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        taskGroups.push({
          groupName: dir.name,
          tasks: tasks.sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
          count: tasks.length,
        });
      }
    } catch { /* ignore */ }
    return taskGroups;
  }

  invalidateCaches() {
    _sessionEntryCache.clear();
    _agentLaunchCache.clear();
    _tokenUsageCache.clear();
    _sessionNamesCache.signature = '';
    _sessionNamesCache.value = new Map();
    _teamMembershipCache.signature = '';
    _teamMembershipCache.value = new Map();
    _teamsCache.signature = '';
    _teamsCache.value = [];
  }
}

module.exports = { ClaudeAdapter };
