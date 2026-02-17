const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── 설정 ───────────────────────────────────────────────
const PORT = 3000;
const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const STATIC_DIR = __dirname;
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2분

// ─── MIME 타입 매핑 ─────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ─── WebSocket 클라이언트 관리 ──────────────────────────
const wsClients = new Set();

// ─── 유틸리티 함수 ──────────────────────────────────────

/**
 * 파일의 마지막 N줄 읽기 (메모리 효율적)
 */
function readLastLines(filePath, lineCount) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    return lines.slice(-lineCount);
  } catch (err) {
    console.error(`파일 읽기 실패: ${filePath}`, err.message);
    return [];
  }
}

/**
 * JSONL 줄들을 파싱하여 유효한 JSON 객체 배열 반환
 */
function parseJsonLines(lines) {
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // 파싱 실패한 줄은 무시
    }
  }
  return results;
}

/**
 * CORS 헤더 설정
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * JSON 응답 전송
 */
function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 에러 응답 전송
 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/**
 * 세션 대화 파일에서 모델/도구/메시지 추출
 * ~/.claude/projects/{encoded-path}/{sessionId}.jsonl
 */
function getSessionDetail(sessionId, projectPath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };

  if (!projectPath) return detail;

  // 프로젝트 경로 인코딩: "/" → "-"
  const encoded = projectPath.replace(/\//g, '-');
  const projectsDir = path.join(CLAUDE_DIR, 'projects', encoded);
  const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) return detail;

  try {
    const lines = readLastLines(sessionFile, 30);
    const entries = parseJsonLines(lines);

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const msg = entry.message;
      if (!msg) continue;

      if (msg.role === 'assistant') {
        // 모델 추출
        if (!detail.model && msg.model) {
          detail.model = msg.model;
        }

        const content = msg.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          // 마지막 도구 사용
          if (!detail.lastTool && block.type === 'tool_use') {
            detail.lastTool = block.name || null;
            // 도구 입력에서 유용한 정보 추출
            if (block.input) {
              if (block.input.command) {
                detail.lastToolInput = block.input.command.substring(0, 60);
              } else if (block.input.file_path) {
                detail.lastToolInput = block.input.file_path.split('/').pop();
              } else if (block.input.pattern) {
                detail.lastToolInput = block.input.pattern;
              } else if (block.input.query) {
                detail.lastToolInput = block.input.query.substring(0, 40);
              }
            }
          }
          // 마지막 텍스트 메시지
          if (!detail.lastMessage && block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0) {
              detail.lastMessage = text.substring(0, 80);
            }
          }
        }
      }

      // 모든 정보 찾았으면 중단
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch (err) {
    // 파싱 실패 무시
  }

  return detail;
}

/**
 * 세션 파일에서 최근 도구 사용 이력 추출 (대시보드용)
 */
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
        const toolName = block.name || 'unknown';
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
        tools.push({ tool: toolName, detail, ts: entry.timestamp || 0 });
      }
    }
  } catch {}
  return tools.slice(-maxItems);
}

/**
 * 세션 파일에서 최근 텍스트 메시지 추출 (대시보드용)
 */
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
        messages.push({
          role: msg.role,
          text: text.substring(0, 200),
          ts: entry.timestamp || 0,
        });
      }
    }
  } catch {}
  return messages.slice(-maxItems);
}

/**
 * 세션 파일 경로 찾기 (일반 세션 / 서브에이전트)
 */
function resolveSessionFilePath(sessionId, project) {
  if (!project) return null;
  const encoded = project.replace(/\//g, '-');
  const projectsDir = path.join(CLAUDE_DIR, 'projects', encoded);

  // 서브에이전트인 경우
  if (sessionId.startsWith('subagent-')) {
    const agentId = sessionId.replace('subagent-', '');
    // 프로젝트 내 모든 세션 디렉토리를 순회
    try {
      const sessionDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of sessionDirs) {
        const agentFile = path.join(projectsDir, dir.name, 'subagents', `agent-${agentId}.jsonl`);
        if (fs.existsSync(agentFile)) return agentFile;
      }
    } catch {}
    return null;
  }

  // 일반 세션
  const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);
  return fs.existsSync(sessionFile) ? sessionFile : null;
}

// ─── API 핸들러 ─────────────────────────────────────────

/**
 * GET /api/sessions
 * history.jsonl의 마지막 1000줄에서 최근 5분 내 활성 세션 추출
 */
function handleGetSessions(req, res) {
  try {
    const sessions = getEnrichedSessions();
    sendJson(res, 200, { sessions, count: sessions.length, timestamp: Date.now() });
  } catch (err) {
    console.error('세션 조회 실패:', err.message);
    sendError(res, 500, '세션 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/teams
 * ~/.claude/teams/ 하위 팀별 config.json 읽기
 */
function handleGetTeams(req, res) {
  try {
    if (!fs.existsSync(TEAMS_DIR)) {
      return sendJson(res, 200, { teams: [] });
    }

    const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const teams = [];
    for (const teamName of teamDirs) {
      const configPath = path.join(TEAMS_DIR, teamName, 'config.json');
      try {
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          teams.push({ teamName, ...config });
        }
      } catch (err) {
        console.error(`팀 설정 파싱 실패: ${teamName}`, err.message);
        teams.push({ teamName, error: '파싱 실패' });
      }
    }

    sendJson(res, 200, { teams, count: teams.length });
  } catch (err) {
    console.error('팀 조회 실패:', err.message);
    sendError(res, 500, '팀 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/tasks
 * ~/.claude/tasks/ 하위 폴더별 태스크 JSON 파일들 읽기
 */
function handleGetTasks(req, res) {
  try {
    if (!fs.existsSync(TASKS_DIR)) {
      return sendJson(res, 200, { taskGroups: [] });
    }

    const taskDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const taskGroups = [];
    for (const groupName of taskDirs) {
      const groupDir = path.join(TASKS_DIR, groupName);
      const tasks = [];

      try {
        const files = fs.readdirSync(groupDir)
          .filter(f => f.endsWith('.json'));

        for (const file of files) {
          try {
            const taskData = JSON.parse(
              fs.readFileSync(path.join(groupDir, file), 'utf-8')
            );
            tasks.push(taskData);
          } catch {
            // 파싱 실패한 파일 무시
          }
        }
      } catch {
        // 디렉토리 읽기 실패 무시
      }

      taskGroups.push({
        groupName,
        tasks: tasks.sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
        count: tasks.length,
      });
    }

    sendJson(res, 200, { taskGroups, totalGroups: taskGroups.length });
  } catch (err) {
    console.error('태스크 조회 실패:', err.message);
    sendError(res, 500, '태스크 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/session-detail?sessionId=xxx&project=xxx
 * 특정 세션의 도구 히스토리 + 최근 메시지 반환 (대시보드용)
 */
function handleGetSessionDetail(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    const project = url.searchParams.get('project');

    if (!sessionId) return sendError(res, 400, 'sessionId 필수');

    const filePath = resolveSessionFilePath(sessionId, project);
    if (!filePath) {
      return sendJson(res, 200, { toolHistory: [], messages: [] });
    }

    const toolHistory = getToolHistory(filePath);
    const messages = getRecentMessages(filePath);

    sendJson(res, 200, { toolHistory, messages, sessionId });
  } catch (err) {
    console.error('세션 상세 조회 실패:', err.message);
    sendError(res, 500, '세션 상세 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/history?lines=100
 * history.jsonl의 마지막 N줄 반환
 */
function handleGetHistory(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lineCount = Math.min(
      Math.max(parseInt(url.searchParams.get('lines') || '100', 10), 1),
      5000
    );

    const lines = readLastLines(HISTORY_FILE, lineCount);
    const entries = parseJsonLines(lines);

    sendJson(res, 200, {
      entries,
      count: entries.length,
      requestedLines: lineCount,
    });
  } catch (err) {
    console.error('히스토리 조회 실패:', err.message);
    sendError(res, 500, '히스토리를 불러올 수 없습니다.');
  }
}

// ─── 정적 파일 서빙 ─────────────────────────────────────

function handleStaticFile(req, res) {
  try {
    let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url);

    // 디렉토리 트래버설 방지
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(STATIC_DIR)) {
      return sendError(res, 403, 'Forbidden');
    }

    // URL 쿼리 파라미터 제거
    filePath = resolvedPath.split('?')[0];

    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, 'Not Found');
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) {
        return sendError(res, 404, 'Not Found');
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isText = contentType.includes('text') ||
                   contentType.includes('javascript') ||
                   contentType.includes('json') ||
                   contentType.includes('svg');

    setCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });

    const stream = fs.createReadStream(filePath, isText ? { encoding: 'utf-8' } : undefined);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('파일 스트림 에러:', err.message);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal Server Error');
      }
    });
  } catch (err) {
    console.error('정적 파일 서빙 실패:', err.message);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal Server Error');
    }
  }
}

// ─── WebSocket 구현 (RFC 6455) ──────────────────────────

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-5AB5DC563B35';

/**
 * WebSocket 핸드셰이크 처리
 */
function handleWebSocketUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_STRING)
    .digest('base64');

  const responseStr =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
    '\r\n';

  socket.write(responseStr, () => {
    wsClients.add(socket);
    console.log(`[WS] 클라이언트 연결 (총 ${wsClients.size}개)`);

    // 초기 데이터 전송 (핸드셰이크 완료 후)
    setTimeout(() => sendInitialData(socket), 100);
  });

  socket.on('data', (buffer) => {
    try {
      handleWebSocketFrame(socket, buffer);
    } catch (err) {
      console.error('[WS] 프레임 처리 에러:', err.message);
    }
  });

  socket.on('close', () => {
    wsClients.delete(socket);
    console.log(`[WS] 클라이언트 연결 해제 (총 ${wsClients.size}개)`);
  });

  socket.on('error', (err) => {
    console.error('[WS] 소켓 에러:', err.message);
    wsClients.delete(socket);
  });
}

/**
 * WebSocket 프레임 파싱 (RFC 6455)
 */
function handleWebSocketFrame(socket, buffer) {
  if (buffer.length < 2) return;

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  const opcode = firstByte & 0x0f;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (isMasked) {
    if (buffer.length < offset + 4) return;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return;

  const payload = buffer.slice(offset, offset + payloadLength);
  if (isMasked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  switch (opcode) {
    case 0x1: // 텍스트 프레임
      handleTextMessage(socket, payload.toString('utf-8'));
      break;
    case 0x8: // 연결 종료
      socket.end(createWebSocketFrame('', 0x8));
      wsClients.delete(socket);
      break;
    case 0x9: // Ping
      socket.write(createWebSocketFrame(payload, 0xa)); // Pong
      break;
    case 0xa: // Pong
      break;
  }
}

/**
 * 텍스트 메시지 처리
 */
function handleTextMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      wsSend(socket, { type: 'pong', timestamp: Date.now() });
    }
  } catch {
    // JSON이 아닌 메시지는 무시
  }
}

/**
 * WebSocket 프레임 생성
 */
function createWebSocketFrame(data, opcode = 0x1) {
  const isBuffer = Buffer.isBuffer(data);
  const payload = isBuffer ? data : Buffer.from(String(data), 'utf-8');
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * WebSocket 클라이언트에 JSON 메시지 전송
 */
function wsSend(socket, data) {
  try {
    if (socket.writable) {
      socket.write(createWebSocketFrame(JSON.stringify(data)));
    }
  } catch (err) {
    console.error('[WS] 전송 에러:', err.message);
    wsClients.delete(socket);
  }
}

/**
 * 모든 WebSocket 클라이언트에 브로드캐스트
 */
function wsBroadcast(data) {
  const frame = createWebSocketFrame(JSON.stringify(data));
  for (const socket of wsClients) {
    try {
      if (socket.writable) {
        socket.write(frame);
      } else {
        wsClients.delete(socket);
      }
    } catch {
      wsClients.delete(socket);
    }
  }
}

/**
 * 서브에이전트 세션 파일에서 모델/도구/메시지 추출
 */
function getSubAgentDetail(filePath) {
  const detail = { model: null, lastTool: null, lastMessage: null, lastToolInput: null };
  try {
    const lines = readLastLines(filePath, 20);
    const entries = parseJsonLines(lines);

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const msg = entry.message;
      if (!msg) continue;

      if (msg.role === 'assistant') {
        if (!detail.model && msg.model) {
          detail.model = msg.model;
        }
        const content = msg.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (!detail.lastTool && block.type === 'tool_use') {
            detail.lastTool = block.name || null;
            if (block.input) {
              if (block.input.command) {
                detail.lastToolInput = block.input.command.substring(0, 60);
              } else if (block.input.file_path) {
                detail.lastToolInput = block.input.file_path.split('/').pop();
              } else if (block.input.pattern) {
                detail.lastToolInput = block.input.pattern;
              } else if (block.input.query) {
                detail.lastToolInput = block.input.query.substring(0, 40);
              }
            }
          }
          if (!detail.lastMessage && block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0) {
              detail.lastMessage = text.substring(0, 80);
            }
          }
        }
      }
      if (detail.model && detail.lastTool && detail.lastMessage) break;
    }
  } catch {
    // 파싱 실패 무시
  }
  return detail;
}

/**
 * 활성 서브에이전트 검색
 * ~/.claude/projects/{project}/{sessionId}/subagents/agent-{id}.jsonl
 */
function getActiveSubAgents() {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const now = Date.now();
  const results = [];

  try {
    const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const projDir of projDirs) {
      const projPath = path.join(projectsDir, projDir.name);

      // 세션 디렉토리 탐색
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

          const age = now - stat.mtimeMs;
          if (age > ACTIVE_THRESHOLD_MS) continue;

          const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
          const detail = getSubAgentDetail(filePath);

          // 프로젝트 경로 복원: "-Users-honorstudio" → "/Users/honorstudio"
          const decodedProject = '/' + projDir.name.replace(/^-/, '').replace(/-/g, '/');

          results.push({
            sessionId: `subagent-${agentId}`,
            agentId: agentId,
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
  } catch (err) {
    console.error('[SubAgent] 스캔 실패:', err.message);
  }

  return results;
}

/**
 * 세션 파일 수정시간으로 활성 여부 확인 (history.jsonl보다 정확)
 * Claude가 도구를 사용하면 세션 파일이 갱신되므로 실시간 감지 가능
 */
function getSessionFileActivity(sessionId, project) {
  if (!project) return 0;
  const encoded = project.replace(/\//g, '-');
  const sessionFile = path.join(CLAUDE_DIR, 'projects', encoded, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(sessionFile)) {
      return fs.statSync(sessionFile).mtimeMs;
    }
  } catch {}
  return 0;
}

/**
 * 활성 세션 목록을 history.jsonl + 세션파일 mtime + 서브에이전트에서 추출 (공통 함수)
 */
function getEnrichedSessions() {
  const lines = readLastLines(HISTORY_FILE, 1000);
  const entries = parseJsonLines(lines);
  const now = Date.now();
  const sessionsMap = new Map();

  // 1단계: history.jsonl에서 세션 ID + 프로젝트 경로 수집 (시간 제한 완화 - 10분)
  const HISTORY_SCAN_MS = 10 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.sessionId) continue;
    const timeDiff = now - (entry.timestamp || 0);
    if (timeDiff > HISTORY_SCAN_MS) continue;

    const existing = sessionsMap.get(entry.sessionId);
    if (!existing || (entry.timestamp || 0) > (existing.timestamp || 0)) {
      sessionsMap.set(entry.sessionId, {
        sessionId: entry.sessionId,
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

  // 2단계: 세션 파일 수정시간으로 실제 활성 여부 판단
  const mainSessions = [];
  for (const session of sessionsMap.values()) {
    // 세션 파일 mtime 체크 (도구 사용 시 갱신됨)
    const fileMtime = getSessionFileActivity(session.sessionId, session.project);
    const lastActive = Math.max(session.lastActivity, fileMtime);
    const age = now - lastActive;

    if (age > ACTIVE_THRESHOLD_MS) continue;

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

  // 3단계: 서브에이전트 추가
  const subAgents = getActiveSubAgents();

  return [...mainSessions, ...subAgents];
}

/**
 * 초기 연결 시 현재 상태 전송
 */
function sendInitialData(socket) {
  try {
    wsSend(socket, {
      type: 'init',
      sessions: getEnrichedSessions(),
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[WS] 초기 데이터 전송 실패:', err.message);
  }
}

// ─── 파일 감시 + 주기적 폴링 ────────────────────────────

let watchDebounce = null;

function broadcastUpdate() {
  if (wsClients.size === 0) return;
  try {
    wsBroadcast({
      type: 'update',
      sessions: getEnrichedSessions(),
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[Watch] 데이터 처리 실패:', err.message);
  }
}

function debouncedBroadcast() {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(broadcastUpdate, 100);
}

function startFileWatcher() {
  // 1. history.jsonl 감시
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      console.log('[Watch] history.jsonl 없음, 감시 대기 중...');
      const interval = setInterval(() => {
        if (fs.existsSync(HISTORY_FILE)) {
          clearInterval(interval);
          startFileWatcher();
        }
      }, 5000);
      return;
    }

    fs.watch(HISTORY_FILE, (eventType) => {
      if (eventType !== 'change') return;
      debouncedBroadcast();
    });
    console.log('[Watch] history.jsonl 감시 시작');
  } catch (err) {
    console.error('[Watch] 파일 감시 실패:', err.message);
  }

  // 2. 프로젝트 세션 디렉토리 감시 (도구 사용 시 세션파일 변경 감지)
  try {
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const projDir of projDirs) {
        const projPath = path.join(projectsDir, projDir.name);
        try {
          fs.watch(projPath, { recursive: false }, (eventType, filename) => {
            if (filename && filename.endsWith('.jsonl')) {
              debouncedBroadcast();
            }
          });
        } catch {}
      }
      console.log(`[Watch] ${projDirs.length}개 프로젝트 디렉토리 감시 시작`);
    }
  } catch (err) {
    console.error('[Watch] 프로젝트 디렉토리 감시 실패:', err.message);
  }

  // 3. 주기적 폴링 (2초) - 서브에이전트 변경 등 놓치는 것 방지
  setInterval(() => {
    if (wsClients.size > 0) {
      broadcastUpdate();
    }
  }, 2000);
  console.log('[Watch] 2초 주기 폴링 시작');
}

// ─── HTTP 서버 ──────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // URL에서 경로 추출 (쿼리 파라미터 제거)
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // API 라우팅
  if (req.method === 'GET') {
    switch (pathname) {
      case '/api/sessions':
        return handleGetSessions(req, res);
      case '/api/teams':
        return handleGetTeams(req, res);
      case '/api/tasks':
        return handleGetTasks(req, res);
      case '/api/history':
        return handleGetHistory(req, res);
      case '/api/session-detail':
        return handleGetSessionDetail(req, res);
    }
  }

  // 정적 파일 서빙
  handleStaticFile(req, res);
});

// WebSocket upgrade 핸들링
server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWebSocketUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

// ─── 서버 시작 ──────────────────────────────────────────

const ASCII_LOGO = `
╔══════════════════════════════════════════════════════╗
║                                                      ║
║    ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗  ║
║   ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝  ║
║   ██║     ██║     ███████║██║   ██║██║  ██║█████╗    ║
║   ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝    ║
║   ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗  ║
║    ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝  ║
║          ██╗   ██╗██╗██╗     ██╗     ███████╗        ║
║          ██║   ██║██║██║     ██║     ██╔════╝        ║
║          ╚██╗ ██╔╝██║██║     ██║     █████╗          ║
║           ╚████╔╝ ██║██║     ██║     ██╔══╝          ║
║            ╚██╔╝  ██║███████╗███████╗███████╗        ║
║             ╚═╝   ╚═╝╚══════╝╚══════╝╚══════╝        ║
║                                                      ║
║        Claude Code Agent Visualization Dashboard     ║
║                    by honorstudio                    ║
╚══════════════════════════════════════════════════════╝
`;

server.listen(PORT, () => {
  console.log(ASCII_LOGO);
  console.log(`  서버 실행 중: http://localhost:${PORT}`);
  console.log(`  데이터 소스: ${CLAUDE_DIR}`);
  console.log(`  히스토리: ${HISTORY_FILE}`);
  console.log('');

  // 파일 감시 시작
  startFileWatcher();
});

// ─── 에러 핸들링 ────────────────────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}가 이미 사용 중입니다.`);
  } else {
    console.error('서버 에러:', err.message);
  }
});

process.on('uncaughtException', (err) => {
  console.error('처리되지 않은 예외:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 프로미스 거부:', reason);
});

process.on('SIGINT', () => {
  console.log('\n서버를 종료합니다...');
  // 모든 WebSocket 연결 종료
  for (const socket of wsClients) {
    try {
      socket.end(createWebSocketFrame('', 0x8));
    } catch {
      // 무시
    }
  }
  server.close(() => {
    console.log('서버 종료 완료');
    process.exit(0);
  });
});
