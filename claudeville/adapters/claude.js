/**
 * Claude Code CLI 어댑터
 * 데이터 소스: ~/.claude/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

// ─── 유틸 ─────────────────────────────────────────────

function readLastLines(filePath, lineCount) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}

function parseJsonLines(lines) {
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line)); } catch { /* 무시 */ }
  }
  return results;
}

// ─── 세션 파싱 ────────────────────────────────────────

function getSessionDetail(sessionId, projectPath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  if (!projectPath) return detail;

  const encoded = projectPath.replace(/\//g, '-');
  const sessionFile = path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionFile)) return detail;

  try {
    const lines = readLastLines(sessionFile, 30);
    const entries = parseJsonLines(lines);

    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i].message;
      if (!msg || msg.role !== 'assistant') continue;

      if (!detail.model && msg.model) detail.model = msg.model;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!detail.lastTool && block.type === 'tool_use') {
          detail.lastTool = block.name || null;
          if (block.input) {
            if (block.input.command) detail.lastToolInput = block.input.command.substring(0, 60);
            else if (block.input.file_path) detail.lastToolInput = block.input.file_path.split('/').pop();
            else if (block.input.pattern) detail.lastToolInput = block.input.pattern;
            else if (block.input.query) detail.lastToolInput = block.input.query.substring(0, 40);
            else if (block.input.recipient) detail.lastToolInput = block.input.recipient;
          }
        }
        if (!detail.lastMessage && block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) detail.lastMessage = text.substring(0, 80);
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch { /* 무시 */ }

  return detail;
}

function getSubAgentDetail(filePath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  try {
    const lines = readLastLines(filePath, 20);
    const entries = parseJsonLines(lines);

    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i].message;
      if (!msg || msg.role !== 'assistant') continue;

      if (!detail.model && msg.model) detail.model = msg.model;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!detail.lastTool && block.type === 'tool_use') {
          detail.lastTool = block.name || null;
          if (block.input) {
            if (block.input.command) detail.lastToolInput = block.input.command.substring(0, 60);
            else if (block.input.file_path) detail.lastToolInput = block.input.file_path.split('/').pop();
            else if (block.input.pattern) detail.lastToolInput = block.input.pattern;
            else if (block.input.query) detail.lastToolInput = block.input.query.substring(0, 40);
            else if (block.input.recipient) detail.lastToolInput = block.input.recipient;
          }
        }
        if (!detail.lastMessage && block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) detail.lastMessage = text.substring(0, 80);
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch { /* 무시 */ }
  return detail;
}

function getToolHistory(sessionFilePath, maxItems = 15) {
  const tools = [];
  try {
    const lines = readLastLines(sessionFilePath, 100);
    const entries = parseJsonLines(lines);

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        let detail = '';
        if (block.input) {
          if (block.input.command) detail = block.input.command.substring(0, 80);
          else if (block.input.file_path) detail = block.input.file_path;
          else if (block.input.pattern) detail = block.input.pattern;
          else if (block.input.query) detail = block.input.query.substring(0, 60);
          else if (block.input.prompt) detail = block.input.prompt.substring(0, 60);
          else if (block.input.url) detail = block.input.url;
          else if (block.input.description) detail = block.input.description.substring(0, 60);
        }
        tools.push({ tool: block.name || 'unknown', detail, ts: entry.timestamp || 0 });
      }
    }
  } catch { /* 무시 */ }
  return tools.slice(-maxItems);
}

function getRecentMessages(sessionFilePath, maxItems = 5) {
  const messages = [];
  try {
    const lines = readLastLines(sessionFilePath, 60);
    const entries = parseJsonLines(lines);

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
  } catch { /* 무시 */ }
  return messages.slice(-maxItems);
}

function getTokenUsage(sessionFilePath) {
  const usage = {
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,  // 마지막 턴의 컨텍스트 크기
    turnCount: 0,
  };
  try {
    const lines = readLastLines(sessionFilePath, 200);
    const entries = parseJsonLines(lines);

    let lastUsage = null;
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || !msg.usage) continue;
      const u = msg.usage;
      usage.totalInput += u.input_tokens || 0;
      usage.totalOutput += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      usage.cacheCreate += u.cache_creation_input_tokens || 0;
      usage.turnCount++;
      lastUsage = u;
    }

    // 마지막 턴의 컨텍스트 = input + cache_read + cache_create
    if (lastUsage) {
      usage.contextWindow =
        (lastUsage.input_tokens || 0) +
        (lastUsage.cache_read_input_tokens || 0) +
        (lastUsage.cache_creation_input_tokens || 0);
    }
  } catch { /* 무시 */ }
  return usage;
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
    } catch { /* 무시 */ }
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
  } catch { /* 무시 */ }
  return 0;
}

// ─── 어댑터 클래스 ────────────────────────────────────

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
    const projectPathMap = new Map(); // 인코딩된 디렉토리명 → 실제 경로

    const HISTORY_SCAN_MS = 10 * 60 * 1000;
    for (const entry of entries) {
      // 모든 엔트리에서 프로젝트 경로 맵 구축 (활성 여부 무관)
      if (entry.project) {
        const encoded = entry.project.replace(/\//g, '-');
        projectPathMap.set(encoded, entry.project);
      }

      if (!entry.sessionId) continue;
      if (now - (entry.timestamp || 0) > HISTORY_SCAN_MS) continue;

      const existing = sessionsMap.get(entry.sessionId);
      if (!existing || (entry.timestamp || 0) > (existing.timestamp || 0)) {
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
      mainSessions.push({
        ...session,
        model: detail.model || session.model,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        lastMessage: detail.lastMessage || session.lastMessage,
      });
    }

    mainSessions.sort((a, b) => b.lastActivity - a.lastActivity);

    // 서브에이전트 (프로젝트 경로 맵 전달)
    const subAgents = this._getActiveSubAgents(activeThresholdMs, projectPathMap);

    // 고아 세션 (history.jsonl에 없고 subagents/에도 없는 팀 멤버 등)
    const knownIds = new Set([
      ...Array.from(sessionsMap.keys()),
      ...subAgents.map(s => s.sessionId.replace('subagent-', '')),
    ]);
    const orphans = this._getOrphanSessions(activeThresholdMs, projectPathMap, knownIds);

    return [...mainSessions, ...subAgents, ...orphans];
  }

  _getActiveSubAgents(activeThresholdMs, projectPathMap = new Map()) {
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const results = [];

    try {
      const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projDirs) {
        const projPath = path.join(projectsDir, projDir.name);
        let sessionDirs;
        try {
          sessionDirs = fs.readdirSync(projPath, { withFileTypes: true })
            .filter(d => d.isDirectory());
        } catch { continue; }

        for (const sessionDir of sessionDirs) {
          const subagentsDir = path.join(projPath, sessionDir.name, 'subagents');
          if (!fs.existsSync(subagentsDir)) continue;

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
            // projectPathMap에서 정확한 경로 조회, 없으면 폴백 (하이픈 포함 경로 깨짐 방지)
            const decodedProject = projectPathMap.get(projDir.name)
              || '/' + projDir.name.replace(/^-/, '').replace(/-/g, '/');

            results.push({
              sessionId: `subagent-${agentId}`,
              provider: 'claude',
              agentId,
              agentType: 'sub-agent',
              model: detail.model || 'unknown',
              status: 'active',
              lastActivity: stat.mtimeMs,
              project: decodedProject,
              lastMessage: detail.lastMessage,
              lastTool: detail.lastTool,
              lastToolInput: detail.lastToolInput,
              parentSessionId: sessionDir.name,
            });
          }
        }
      }
    } catch { /* 무시 */ }

    return results;
  }

  _getOrphanSessions(activeThresholdMs, projectPathMap = new Map(), knownIds = new Set()) {
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
          // 이미 알려진 세션이면 스킵
          if (knownIds.has(sessionId)) continue;

          const filePath = path.join(projPath, file);
          let stat;
          try { stat = fs.statSync(filePath); } catch { continue; }

          if (now - stat.mtimeMs > activeThresholdMs) continue;

          const detail = getSubAgentDetail(filePath);
          const decodedProject = projectPathMap.get(projDir.name)
            || '/' + projDir.name.replace(/^-/, '').replace(/-/g, '/');

          results.push({
            sessionId,
            provider: 'claude',
            agentId: sessionId,
            agentType: 'team-member',
            model: detail.model || 'unknown',
            status: 'active',
            lastActivity: stat.mtimeMs,
            project: decodedProject,
            lastMessage: detail.lastMessage,
            lastTool: detail.lastTool,
            lastToolInput: detail.lastToolInput,
          });
        }
      }
    } catch { /* 무시 */ }

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

    // 프로젝트 디렉토리 (recursive로 서브에이전트 파일도 감지)
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
      } catch { /* 무시 */ }
    }

    // 팀 디렉토리 감시 (팀 생성/변경 감지)
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

  // ─── 팀/태스크 (Claude 전용) ──────────────────────

  getTeams() {
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
          teams.push({ teamName: dir.name, error: '파싱 실패' });
        }
      }
    } catch { /* 무시 */ }
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
            } catch { /* 무시 */ }
          }
        } catch { /* 무시 */ }
        taskGroups.push({
          groupName: dir.name,
          tasks: tasks.sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
          count: tasks.length,
        });
      }
    } catch { /* 무시 */ }
    return taskGroups;
  }
}

module.exports = { ClaudeAdapter };
