/**
 * Google Gemini CLI 어댑터
 * 데이터 소스: ~/.gemini/
 *
 * 세션 포맷 (JSON 객체):
 *   {
 *     "sessionId": "...",
 *     "projectHash": "...",      // cwd의 SHA-256 해시
 *     "messages": [
 *       {"type": "user", "content": "Hello"},
 *       {"type": "gemini", "content": "Hi!", "model": "gemini-2.5-flash", "tokens": {...}},
 *       {"type": "info", "content": "..."}
 *     ]
 *   }
 *
 * 프로젝트 경로 복원: projectHash는 cwd의 SHA-256이므로
 * 알려진 프로젝트 경로들을 해시해서 매핑
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');

// ─── 프로젝트 경로 복원 ──────────────────────────────

/**
 * SHA-256 해시에서 프로젝트 경로를 역매핑
 * 알려진 경로 후보들의 해시를 계산해서 매칭
 */
const _hashToPathCache = new Map();

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function resolveProjectPath(projectHash) {
  // 캐시 확인
  if (_hashToPathCache.has(projectHash)) {
    return _hashToPathCache.get(projectHash);
  }

  const homeDir = os.homedir();

  // 후보 1: 홈 디렉토리 자체
  if (sha256(homeDir) === projectHash) {
    _hashToPathCache.set(projectHash, homeDir);
    return homeDir;
  }

  // 후보 2: 홈 디렉토리 하위 1단계 (Desktop, Documents, Projects 등)
  const commonDirs = ['Desktop', 'Documents', 'Projects', 'Developer', 'dev', 'src', 'code', 'repos', 'workspace', 'work'];
  for (const dir of commonDirs) {
    const fullPath = path.join(homeDir, dir);
    if (sha256(fullPath) === projectHash) {
      _hashToPathCache.set(projectHash, fullPath);
      return fullPath;
    }
    // 2단계까지 탐색
    try {
      if (fs.existsSync(fullPath)) {
        const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 50); // 너무 많으면 제한
        for (const sub of subdirs) {
          const subPath = path.join(fullPath, sub.name);
          if (sha256(subPath) === projectHash) {
            _hashToPathCache.set(projectHash, subPath);
            return subPath;
          }
        }
      }
    } catch { /* 무시 */ }
  }

  // 후보 3: Claude Code 프로젝트 경로에서도 해시 체크
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projDirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of projDirs) {
        // Claude projects 디렉토리명: -Users-name-path 형식
        const projPath = '/' + dir.replace(/-/g, '/').replace(/^\//, '');
        if (sha256(projPath) === projectHash) {
          _hashToPathCache.set(projectHash, projPath);
          return projPath;
        }
      }
    }
  } catch { /* 무시 */ }

  // 매핑 실패 → null 반환 (해시 디렉토리명은 표시하지 않음)
  _hashToPathCache.set(projectHash, null);
  return null;
}

// ─── 세션 파싱 ────────────────────────────────────────

/**
 * Gemini 세션 JSON에서 모델/도구/메시지 추출
 * 실제 포맷: {sessionId, projectHash, messages: [{type, content, model, ...}]}
 */
function parseSession(filePath) {
  const detail = {
    model: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);

    const messages = session.messages;
    if (!Array.isArray(messages)) return detail;

    // 마지막부터 역순으로 탐색
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Gemini 응답 메시지
      if (msg.type === 'gemini') {
        // 모델 정보
        if (!detail.model && msg.model) {
          detail.model = msg.model;
        }

        // 텍스트 메시지
        if (!detail.lastMessage && msg.content) {
          const text = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (text.length > 0) {
            detail.lastMessage = text.substring(0, 80);
          }
        }

        // 도구 사용 (functionCall이 있는 경우)
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

      // 도구 호출 결과 (tool_call 타입)
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
  } catch { /* 무시 */ }

  return detail;
}

/**
 * Gemini 세션에서 도구 히스토리 추출
 */
function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    const messages = session.messages;
    if (!Array.isArray(messages)) return tools;

    for (const msg of messages) {
      // gemini 타입에서 toolCalls 체크
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

      // tool_call 타입
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
  } catch { /* 무시 */ }
  return tools.slice(-maxItems);
}

/**
 * Gemini 세션에서 최근 메시지 추출
 */
function getRecentMessages(filePath, maxItems = 5) {
  const msgList = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    const messages = session.messages;
    if (!Array.isArray(messages)) return msgList;

    for (const msg of messages) {
      if (msg.type === 'info') continue; // info 메시지 건너뛰기

      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text.length === 0) continue;

      msgList.push({
        role: msg.type === 'gemini' ? 'assistant' : msg.type === 'user' ? 'user' : 'system',
        text: text.substring(0, 200),
        ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
      });
    }
  } catch { /* 무시 */ }
  return msgList.slice(-maxItems);
}

/**
 * 활성 세션 파일 스캔
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
  } catch { /* 무시 */ }

  return results;
}

// ─── 어댑터 클래스 ────────────────────────────────────

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
        parentSessionId: null,
      });
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = sessionId.replace('gemini-', '');
    const sessionFiles = scanActiveSessions(30 * 60 * 1000);

    for (const { filePath, fileName } of sessionFiles) {
      const fileId = fileName.replace('session-', '').replace('.json', '');
      if (fileId === cleanId) {
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
      } catch { /* 무시 */ }
    }
    return paths;
  }
}

module.exports = { GeminiAdapter };
