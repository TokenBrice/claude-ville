const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── 어댑터 로드 ─────────────────────────────────────
const {
  getAllSessions,
  getSessionDetailByProvider,
  getAllWatchPaths,
  getActiveProviders,
  adapters,
} = require('./adapters');

// Claude 어댑터 (팀/태스크는 Claude 전용)
const claudeAdapter = adapters.find(a => a.provider === 'claude');

// ─── 설정 ───────────────────────────────────────────────
const PORT = 3000;
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

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// ─── API 핸들러 ─────────────────────────────────────────

/**
 * GET /api/sessions
 * 모든 활성 어댑터에서 세션 수집
 */
function handleGetSessions(req, res) {
  try {
    const sessions = getAllSessions(ACTIVE_THRESHOLD_MS);
    sendJson(res, 200, { sessions, count: sessions.length, timestamp: Date.now() });
  } catch (err) {
    console.error('세션 조회 실패:', err.message);
    sendError(res, 500, '세션 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/teams
 * Claude 팀 정보 (Claude 전용)
 */
function handleGetTeams(req, res) {
  try {
    const teams = claudeAdapter ? claudeAdapter.getTeams() : [];
    sendJson(res, 200, { teams, count: teams.length });
  } catch (err) {
    console.error('팀 조회 실패:', err.message);
    sendError(res, 500, '팀 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/tasks
 * Claude 태스크 정보 (Claude 전용)
 */
function handleGetTasks(req, res) {
  try {
    const taskGroups = claudeAdapter ? claudeAdapter.getTasks() : [];
    sendJson(res, 200, { taskGroups, totalGroups: taskGroups.length });
  } catch (err) {
    console.error('태스크 조회 실패:', err.message);
    sendError(res, 500, '태스크 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/session-detail?sessionId=xxx&project=xxx&provider=claude
 * 특정 세션의 도구 히스토리 + 최근 메시지 반환
 */
function handleGetSessionDetail(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    const project = url.searchParams.get('project');
    const provider = url.searchParams.get('provider') || 'claude';

    if (!sessionId) return sendError(res, 400, 'sessionId 필수');

    const result = getSessionDetailByProvider(provider, sessionId, project);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('세션 상세 조회 실패:', err.message);
    sendError(res, 500, '세션 상세 정보를 불러올 수 없습니다.');
  }
}

/**
 * GET /api/providers
 * 활성 프로바이더 목록
 */
function handleGetProviders(req, res) {
  try {
    const providers = getActiveProviders();
    sendJson(res, 200, { providers, count: providers.length });
  } catch (err) {
    console.error('프로바이더 조회 실패:', err.message);
    sendError(res, 500, '프로바이더 정보를 불러올 수 없습니다.');
  }
}

// ─── 정적 파일 서빙 ─────────────────────────────────────

function handleStaticFile(req, res) {
  try {
    let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url);

    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(STATIC_DIR)) {
      return sendError(res, 403, 'Forbidden');
    }

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
    setTimeout(() => {
      if (!socket.destroyed && socket.writable && wsClients.has(socket)) {
        sendInitialData(socket);
      }
    }, 100);
  });

  socket.on('data', (buffer) => {
    try {
      handleWebSocketFrame(socket, buffer);
    } catch (err) {
      // 프레임 처리 에러 무시
    }
  });

  socket.on('close', () => {
    wsClients.delete(socket);
  });

  socket.on('error', () => {
    wsClients.delete(socket);
  });
}

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
    case 0x1:
      handleTextMessage(socket, payload.toString('utf-8'));
      break;
    case 0x8:
      socket.end(createWebSocketFrame('', 0x8));
      wsClients.delete(socket);
      break;
    case 0x9:
      socket.write(createWebSocketFrame(payload, 0xa));
      break;
    case 0xa:
      break;
  }
}

function handleTextMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      wsSend(socket, { type: 'pong', timestamp: Date.now() });
    }
  } catch { /* 무시 */ }
}

function createWebSocketFrame(data, opcode = 0x1) {
  const isBuffer = Buffer.isBuffer(data);
  const payload = isBuffer ? data : Buffer.from(String(data), 'utf-8');
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
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

function wsSend(socket, data) {
  try {
    if (!socket.destroyed && socket.writable) {
      socket.write(createWebSocketFrame(JSON.stringify(data)));
    }
  } catch (err) {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      // 전송 에러 무시
    }
    wsClients.delete(socket);
  }
}

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

// ─── 데이터 브로드캐스트 ────────────────────────────────

function sendInitialData(socket) {
  try {
    wsSend(socket, {
      type: 'init',
      sessions: getAllSessions(ACTIVE_THRESHOLD_MS),
      teams: claudeAdapter ? claudeAdapter.getTeams() : [],
      timestamp: Date.now(),
    });
  } catch (err) {
    // 초기 데이터 전송 실패 무시
  }
}

let watchDebounce = null;

function broadcastUpdate() {
  if (wsClients.size === 0) return;
  try {
    wsBroadcast({
      type: 'update',
      sessions: getAllSessions(ACTIVE_THRESHOLD_MS),
      teams: claudeAdapter ? claudeAdapter.getTeams() : [],
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

// ─── 파일 감시 (멀티 프로바이더) ────────────────────────

function startFileWatcher() {
  const watchPaths = getAllWatchPaths();
  let watchCount = 0;

  for (const wp of watchPaths) {
    try {
      if (wp.type === 'file') {
        if (!fs.existsSync(wp.path)) continue;
        fs.watch(wp.path, (eventType) => {
          if (eventType === 'change') debouncedBroadcast();
        });
        watchCount++;
      } else if (wp.type === 'directory') {
        if (!fs.existsSync(wp.path)) continue;
        fs.watch(wp.path, { recursive: wp.recursive || false }, (eventType, filename) => {
          if (wp.filter && filename && !filename.endsWith(wp.filter)) return;
          debouncedBroadcast();
        });
        watchCount++;
      }
    } catch {
      // 감시 실패한 경로 무시
    }
  }

  console.log(`[Watch] ${watchCount}개 경로 감시 시작`);

  // 주기적 폴링 (2초) - 놓치는 변경 방지
  setInterval(() => {
    if (wsClients.size > 0) broadcastUpdate();
  }, 2000);
  console.log('[Watch] 2초 주기 폴링 시작');
}

// ─── HTTP 서버 ──────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET') {
    switch (pathname) {
      case '/api/sessions':
        return handleGetSessions(req, res);
      case '/api/teams':
        return handleGetTeams(req, res);
      case '/api/tasks':
        return handleGetTasks(req, res);
      case '/api/session-detail':
        return handleGetSessionDetail(req, res);
      case '/api/providers':
        return handleGetProviders(req, res);
    }
  }

  handleStaticFile(req, res);
});

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
║     AI Coding Agent Visualization Dashboard          ║
║                    by honorstudio                    ║
╚══════════════════════════════════════════════════════╝
`;

server.listen(PORT, () => {
  console.log(ASCII_LOGO);
  console.log(`  서버 실행 중: http://localhost:${PORT}`);
  console.log('');

  // 활성 프로바이더 표시
  const providers = getActiveProviders();
  if (providers.length === 0) {
    console.log('  [!] 활성 프로바이더 없음');
    console.log('      ~/.claude/ , ~/.codex/ , ~/.gemini/ 중 하나가 필요합니다');
  } else {
    console.log('  활성 프로바이더:');
    for (const p of providers) {
      console.log(`    - ${p.name} (${p.homeDir})`);
    }
  }
  console.log('');

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
  for (const socket of wsClients) {
    try {
      socket.end(createWebSocketFrame('', 0x8));
    } catch { /* 무시 */ }
  }
  server.close(() => {
    console.log('서버 종료 완료');
    process.exit(0);
  });
});
