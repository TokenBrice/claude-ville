const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Load adapters ─────────────────────────────────────
const {
  getAllSessions,
  getSessionDetailByProvider,
  getSessionDetailsBatch,
  getAllWatchPaths,
  getActiveProviders,
  isKnownSessionDetailProvider,
  invalidateSessionCaches,
  getAdapterPerfStats,
  getGitEnrichmentPerfStats,
  getJsonlDiagnostics,
  adapters,
} = require('./adapters');

// ─── Usage quota service ──────────────────────────────
const usageQuota = require('./services/usageQuota');

// Claude adapter (teams/tasks are Claude-only)
const claudeAdapter = adapters.find(a => a.provider === 'claude');

// ─── Settings ───────────────────────────────────────────────
const PORT = 4000;
const STATIC_DIR = __dirname;
const STATIC_ROOT = path.resolve(STATIC_DIR);
const WIDGET_STATIC_ROOT = path.resolve(__dirname, '..', 'widget', 'Resources');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const STATIC_REAL_ROOT = realpathSync(STATIC_ROOT);
const WIDGET_STATIC_REAL_ROOT = realpathIfExists(WIDGET_STATIC_ROOT);
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const STARTUP_BOOTSTRAP_DELAY_MS = 25;
const STARTUP_STATS_WARNING_MS = 1500;
const JSON_BODY_LIMIT_BYTES = 256 * 1024;

// ─── MIME type mapping ─────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

// ─── WebSocket client management ──────────────────────────
const wsClients = new Set();
const WS_BACKPRESSURE_BYTES = 1024 * 1024;
const WS_HEARTBEAT_INTERVAL_MS = 30_000;
const WS_STALE_AFTER_MS = 90_000;
const WS_MAX_PAYLOAD_BYTES = 256 * 1024;
const WS_MAX_BUFFER_BYTES = WS_MAX_PAYLOAD_BYTES + 32;
const WATCH_FALLBACK_SCAN_INTERVAL_MS = 2000;
const WATCH_FALLBACK_MAX_ENTRIES = 2000;
const WATCH_FALLBACK_MAX_DEPTH = 10;
const GIT_STATE_MAX_PROJECTS = 40;
const GIT_STATE_MAX_REF_ENTRIES = 800;

// ─── Utility functions ──────────────────────────────────────

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

function sendApiPayload(res, label, buildPayload, errorMessage) {
  try {
    sendJson(res, 200, buildPayload());
  } catch (err) {
    console.error(`${label}:`, err.message);
    sendError(res, 500, errorMessage);
  }
}

function readJsonBody(req, callback) {
  let body = '';
  let byteLength = 0;
  let tooLarge = false;
  let settled = false;

  const finish = (err, data) => {
    if (settled) return;
    settled = true;
    callback(err, data);
  };

  req.on('data', (chunk) => {
    byteLength += chunk.length;
    if (byteLength > JSON_BODY_LIMIT_BYTES) {
      tooLarge = true;
      body = '';
      return;
    }
    if (tooLarge) return;
    body += chunk;
  });
  req.on('end', () => {
    if (tooLarge) {
      const err = new Error('Payload Too Large');
      err.statusCode = 413;
      return finish(err);
    }
    if (!body) return finish(null, {});
    try {
      finish(null, JSON.parse(body));
    } catch (err) {
      finish(err);
    }
  });
  req.on('error', finish);
}

function cacheControlFor() {
  return 'no-cache';
}

function isContainedPath(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function realpathExistingPath(filePath) {
  return realpathSync(filePath);
}

function realpathIfExists(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return 'now';

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function safeCollect(label, fn, fallback = null, warnMs = STARTUP_STATS_WARNING_MS) {
  const start = Date.now();
  try {
    const value = fn();
    const elapsed = Date.now() - start;
    if (elapsed >= warnMs) {
      console.log(`[Perf] ${label} took ${elapsed}ms`);
    }
    return value;
  } catch (err) {
    console.error(`[${label}] ${err.message}`);
    return fallback;
  }
}

function printStartupStats(providers) {
  const sessions = safeCollect('getAllSessions', () => getAllSessions(ACTIVE_THRESHOLD_MS), []);
  const watchPaths = safeCollect('getAllWatchPaths', getAllWatchPaths, []);

  const providerCounts = new Map();
  for (const session of sessions) {
    providerCounts.set(session.provider, (providerCounts.get(session.provider) || 0) + 1);
  }

  const projects = new Set(sessions.map(session => session.project).filter(Boolean));
  const namedCodexAgents = sessions.filter(session => session.provider === 'codex' && (session.name || session.agentName)).length;
  const namedKimiAgents = sessions.filter(session => session.provider === 'kimi' && (session.name || session.agentName)).length;
  const sessionsWithTools = sessions.filter(session => session.lastTool).length;
  const latestActivity = sessions.reduce((latest, session) => Math.max(latest, session.lastActivity || 0), 0);

  console.log('  Startup stats:');
  console.log(`    - Sessions: ${sessions.length} active across ${projects.size} project${projects.size === 1 ? '' : 's'}`);
  if (providers.length > 0) {
    const providerSummary = providers
      .map(provider => `${provider.name}: ${providerCounts.get(provider.provider) || 0}`)
      .join(', ');
    console.log(`    - Provider sessions: ${providerSummary}`);
  }
  console.log(`    - Named Codex agents: ${namedCodexAgents}`);
  console.log(`    - Named Kimi agents: ${namedKimiAgents}`);
  console.log(`    - Sessions with current tool: ${sessionsWithTools}`);
  console.log(`    - Latest activity: ${latestActivity ? formatAge(Date.now() - latestActivity) : 'none'}`);
  console.log(`    - Watch paths configured: ${watchPaths.length}`);
  console.log('');

  return { sessions, watchPaths };
}

// ─── API handlers ─────────────────────────────────────────

/**
 * GET /api/sessions
 * Collect sessions from all active adapters
 */
function handleGetSessions(req, res, parsedUrl) {
  sendApiPayload(res, 'Failed to fetch sessions', () => {
    const force = ['1', 'true', 'yes'].includes(String(parsedUrl.searchParams.get('force') || '').toLowerCase());
    const sessions = getAllSessions(ACTIVE_THRESHOLD_MS, { force });
    return { sessions, count: sessions.length, timestamp: Date.now() };
  }, 'Unable to load session information.');
}

/**
 * GET /api/teams
 * Claude team information (Claude-only)
 */
function handleGetTeams(req, res) {
  sendApiPayload(res, 'Failed to fetch teams', () => {
    const teams = getTeamsCached();
    return { teams, count: teams.length };
  }, 'Unable to load team information.');
}

/**
 * GET /api/tasks
 * Claude task information (Claude-only)
 */
function handleGetTasks(req, res) {
  sendApiPayload(res, 'Failed to fetch tasks', () => {
    const taskGroups = claudeAdapter ? claudeAdapter.getTasks() : [];
    return { taskGroups, totalGroups: taskGroups.length };
  }, 'Unable to load task information.');
}

/**
 * GET /api/session-detail?sessionId=xxx&project=xxx&provider=claude
 * Return tool history and recent messages for one session
 */
function handleGetSessionDetail(req, res, parsedUrl) {
  try {
    const sessionId = parsedUrl.searchParams.get('sessionId');
    const project = parsedUrl.searchParams.get('project') || '';
    const provider = String(parsedUrl.searchParams.get('provider') || 'claude').toLowerCase();

    if (!sessionId) return sendError(res, 400, 'sessionId is required');
    if (!isKnownSessionDetailProvider(provider)) return sendError(res, 400, 'invalid provider');

    const result = getSessionDetailByProvider(provider, sessionId, project);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('Failed to fetch session details:', err.message);
    sendError(res, 500, 'Unable to load session details.');
  }
}

/**
 * POST /api/session-details
 * Batch-fetch details for visible/selected sessions.
 */
function handlePostSessionDetails(req, res) {
  readJsonBody(req, (err, body = {}) => {
    if (err) {
      const statusCode = err.statusCode === 413 ? 413 : 400;
      const message = statusCode === 413 ? 'Payload Too Large' : 'invalid JSON body';
      return sendError(res, statusCode, message);
    }
    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    const valid = [];
    for (const item of items) {
      const provider = String(item?.provider || 'claude').toLowerCase();
      const sessionId = String(item?.sessionId || '');
      if (!sessionId || !isKnownSessionDetailProvider(provider)) continue;
      valid.push({
        key: item.key,
        provider,
        sessionId,
        project: String(item?.project || ''),
      });
    }
    try {
      const details = getSessionDetailsBatch(valid);
      sendJson(res, 200, { details, count: Object.keys(details).length, timestamp: Date.now() });
    } catch (fetchErr) {
      console.error('Failed to fetch batch session details:', fetchErr.message);
      sendError(res, 500, 'Unable to load session details.');
    }
  });
}

/**
 * GET /api/providers
 * Active provider list
 */
function handleGetProviders(req, res) {
  sendApiPayload(res, 'Failed to fetch providers', () => {
    const providers = getActiveProviders();
    return { providers, count: providers.length };
  }, 'Unable to load provider information.');
}

/**
 * GET /api/usage
 * Claude usage/subscription information
 */
function handleGetUsage(req, res) {
  sendApiPayload(res, 'Failed to fetch usage', () => usageQuota.fetchUsage(), 'Unable to load usage information.');
}

/**
 * GET /api/perf
 * Lightweight runtime counters for manual performance checks.
 */
function handleGetPerf(req, res) {
  sendApiPayload(res, 'Failed to fetch perf counters', () => ({
    websocketClients: wsClients.size,
    activeWatchPaths: serverPerf.activeWatchPaths,
    recursiveWatchFallbacks: serverPerf.recursiveWatchFallbacks,
    recursiveWatchFallbackDetails: Array.from(recursiveWatchFallbacks.values()).map((fallback) => ({
      path: fallback.wp.path,
      provider: fallback.wp.provider || null,
      filter: fallback.wp.filter || null,
      baselinePending: Boolean(fallback.baselinePending),
      lastScanAt: fallback.lastScanAt || null,
      lastSignatureAt: fallback.lastSignatureAt || null,
      lastError: fallback.lastError || null,
    })),
    providers: getAdapterPerfStats(),
    gitEnrichment: getGitEnrichmentPerfStats(),
    jsonlDiagnostics: getJsonlDiagnostics(),
    watchFailures: serverPerf.watchFailures,
    recentWatchFailures: serverPerf.watchFailureDetails,
    fallbackScans: serverPerf.fallbackScans,
    fallbackChanges: serverPerf.fallbackChanges,
    skippedWrites: serverPerf.skippedWrites,
    lastBroadcast: serverPerf.lastBroadcast,
    recentBroadcasts: serverPerf.broadcasts,
    cacheStampCounter,
    lastBroadcastStamp,
    timestamp: Date.now(),
  }), 'Unable to load performance information.');
}

/**
 * GET /api/changelog
 * Returns CHANGELOG.md as plain text for the in-app changelog viewer.
 */
function handleGetChangelog(req, res) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  try {
    const content = fs.readFileSync(changelogPath, 'utf-8');
    setCorsHeaders(res);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
  } catch (err) {
    sendError(res, 404, 'Changelog not found');
  }
}

// ─── Static file serving ─────────────────────────────────────

function serveContainedFile(req, res, parsedUrl, { root, realRoot, label = 'Static' }) {
  if (process.env.DEBUG_STATIC) {
    console.log(`[${label}] request`, req.url);
  }
  try {
    let requestedPath;
    try {
      requestedPath = decodeURIComponent(parsedUrl.pathname || '/');
    } catch {
      return sendError(res, 400, 'Bad Request');
    }

    const relativePath = requestedPath === '/'
      ? 'index.html'
      : requestedPath.replace(/^\/+/, '');
    let filePath = path.resolve(root, relativePath);
    if (!isContainedPath(root, filePath)) {
      return sendError(res, 403, 'Forbidden');
    }

    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, 'Not Found');
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.resolve(filePath, 'index.html');
      if (!isContainedPath(root, filePath)) {
        return sendError(res, 403, 'Forbidden');
      }
      if (!fs.existsSync(filePath)) {
        return sendError(res, 404, 'Not Found');
      }
    }

    const realFilePath = realpathExistingPath(filePath);
    if (!isContainedPath(realRoot, realFilePath)) {
      return sendError(res, 403, 'Forbidden');
    }
    filePath = realFilePath;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isText = contentType.includes('text') ||
                   contentType.includes('javascript') ||
                   contentType.includes('json') ||
                   contentType.includes('svg');

    if (process.env.DEBUG_STATIC) {
      console.log(`[${label}] resolved`, filePath, 'type', contentType);
    }

    setCorsHeaders(res);
    fs.readFile(filePath, isText ? 'utf-8' : undefined, (err, data) => {
      if (process.env.DEBUG_STATIC) {
        console.log(`[${label}] read callback for`, filePath, 'err?', Boolean(err));
      }
      if (err) {
        console.error('File read error:', err.message);
        return sendError(res, 500, 'Internal Server Error');
      }

      if (process.env.DEBUG_STATIC) {
        const byteLength = Buffer.isBuffer(data) ? data.length : String(data).length;
        console.log(`[${label}] serving`, filePath, 'bytes', byteLength, 'type', contentType);
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControlFor(),
      });
      res.end(data);
    });
  } catch (err) {
    console.error('Static file serving failed:', err.message);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal Server Error');
    }
  }
}

function handleStaticFile(req, res, parsedUrl) {
  return serveContainedFile(req, res, parsedUrl, {
    root: STATIC_ROOT,
    realRoot: STATIC_REAL_ROOT,
    label: 'Static',
  });
}

function handleWidgetStaticFile(req, res, parsedUrl) {
  return serveContainedFile(req, res, parsedUrl, {
    root: WIDGET_STATIC_ROOT,
    realRoot: WIDGET_STATIC_REAL_ROOT,
    label: 'WidgetStatic',
  });
}

// ─── WebSocket implementation (RFC 6455) ──────────────────────────

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function handleWebSocketUpgrade(req, socket, head = Buffer.alloc(0)) {
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
    socket._cvLastSeen = Date.now();
    socket._cvDraining = false;
    socket._cvSupportsDeltas = false;
    socket._cvFrameBuffer = Buffer.alloc(0);
    wsClients.add(socket);
    if (head.length > 0) {
      processWebSocketData(socket, head);
    }
    setTimeout(() => {
      if (!socket.destroyed && socket.writable && wsClients.has(socket)) {
        sendInitialData(socket);
      }
    }, 100);
  });

  socket.on('data', (buffer) => {
    try {
      processWebSocketData(socket, buffer);
    } catch (err) {
      closeWebSocket(socket, 1002);
    }
  });

  socket.on('close', () => {
    closeWebSocket(socket, null, { sendFrame: false });
  });

  socket.on('error', () => {
    closeWebSocket(socket, null, { sendFrame: false });
  });
}

function processWebSocketData(socket, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
  socket._cvFrameBuffer = socket._cvFrameBuffer && socket._cvFrameBuffer.length > 0
    ? Buffer.concat([socket._cvFrameBuffer, buffer])
    : buffer;

  if (socket._cvFrameBuffer.length > WS_MAX_BUFFER_BYTES) {
    closeWebSocket(socket, 1009);
    return;
  }

  while (!socket.destroyed && socket._cvFrameBuffer.length > 0) {
    const consumed = handleWebSocketFrame(socket, socket._cvFrameBuffer);
    if (consumed === 0) break;
    if (consumed < 0) {
      closeWebSocket(socket, 1009);
      return;
    }
    socket._cvFrameBuffer = socket._cvFrameBuffer.slice(consumed);
  }
}

function handleWebSocketFrame(socket, buffer) {
  if (buffer.length < 2) return 0;
  socket._cvLastSeen = Date.now();

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  const opcode = firstByte & 0x0f;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return 0;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return 0;
    const extendedLength = buffer.readBigUInt64BE(2);
    if (extendedLength > BigInt(WS_MAX_PAYLOAD_BYTES)) return -1;
    payloadLength = Number(extendedLength);
    offset = 10;
  }

  if (payloadLength > WS_MAX_PAYLOAD_BYTES) return -1;

  let maskKey = null;
  if (isMasked) {
    if (buffer.length < offset + 4) return 0;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return 0;

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
      closeWebSocket(socket, 1000);
      break;
    case 0x9:
      socket.write(createWebSocketFrame(payload, 0xa));
      break;
    case 0xa:
      socket._cvLastSeen = Date.now();
      break;
  }
  return offset + payloadLength;
}

function closeWebSocket(socket, code = 1000, { sendFrame = true } = {}) {
  if (!socket) return;
  wsClients.delete(socket);
  socket._cvPendingFrame = null;
  socket._cvDraining = false;
  if (!sendFrame || socket.destroyed || !socket.writable) return;

  const frame = code == null
    ? createWebSocketFrame('', 0x8)
    : (() => {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        return createWebSocketFrame(payload, 0x8);
      })();
  try {
    socket.end(frame);
  } catch {
    socket.destroy();
  }
}

function handleTextMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      wsSend(socket, { type: 'pong', timestamp: Date.now() });
    } else if (data.type === 'hello') {
      // Delta-capable clients announce themselves; legacy clients never send
      // this and keep receiving full update payloads.
      socket._cvSupportsDeltas = data.deltas === true;
    } else if (data.type === 'resync') {
      // A delta client lost its patch baseline (missed frame or seq mismatch)
      // and needs a fresh full snapshot to resume patching.
      sendInitialData(socket);
    }
  } catch { /* ignore */ }
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
    writeWebSocketFrame(socket, createWebSocketFrame(JSON.stringify(data)));
  } catch (err) {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      // Ignore send errors.
    }
    closeWebSocket(socket, null, { sendFrame: false });
  }
}

function wsBroadcast(fullMessage, deltaMessage = null) {
  // Frames are built lazily: a fleet of delta-capable clients never pays for
  // serializing the full payload, and vice versa.
  let fullFrame = null;
  let deltaFrame = null;
  for (const socket of wsClients) {
    if (deltaMessage && socket._cvSupportsDeltas) {
      if (!deltaFrame) deltaFrame = createWebSocketFrame(JSON.stringify(deltaMessage));
      writeWebSocketFrame(socket, deltaFrame, { queueLatest: true });
    } else {
      if (!fullFrame) fullFrame = createWebSocketFrame(JSON.stringify(fullMessage));
      writeWebSocketFrame(socket, fullFrame, { queueLatest: true });
    }
  }
}

function writeWebSocketFrame(socket, frame, { queueLatest = false } = {}) {
  if (!socket || socket.destroyed || !socket.writable) {
    closeWebSocket(socket, null, { sendFrame: false });
    return false;
  }
  if ((socket.writableLength || 0) > WS_BACKPRESSURE_BYTES) {
    serverPerf.skippedWrites++;
    closeWebSocket(socket, null);
    return false;
  }
  if (socket._cvDraining) {
    serverPerf.skippedWrites++;
    if (queueLatest) socket._cvPendingFrame = frame;
    return false;
  }
  try {
    const ok = socket.write(frame);
    if (!ok) {
      socket._cvDraining = true;
      socket.once('drain', () => {
        socket._cvDraining = false;
        const pendingFrame = socket._cvPendingFrame;
        socket._cvPendingFrame = null;
        if (pendingFrame) writeWebSocketFrame(socket, pendingFrame, { queueLatest: true });
      });
    }
    return ok;
  } catch {
    closeWebSocket(socket, null, { sendFrame: false });
    return false;
  }
}

function startWebSocketHeartbeat() {
  setInterval(() => {
    const now = Date.now();
    const pingFrame = createWebSocketFrame(String(now), 0x9);
    for (const socket of wsClients) {
      if (!socket || socket.destroyed) {
        closeWebSocket(socket, null, { sendFrame: false });
        continue;
      }
      if (now - (socket._cvLastSeen || now) > WS_STALE_AFTER_MS) {
        closeWebSocket(socket, null);
        continue;
      }
      writeWebSocketFrame(socket, pingFrame);
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
}

// ─── Data broadcast ────────────────────────────────

function sendInitialData(socket) {
  try {
    // Reuse the canonical broadcast state when other clients are already
    // synced to it, so every delta client shares the same patch baseline.
    if (lastBroadcastState && wsClients.size > 1) {
      wsSend(socket, {
        type: 'init',
        sessions: lastBroadcastState.sessions,
        teams: lastBroadcastState.teams,
        usage: lastBroadcastState.usage,
        seq: broadcastSeq,
        timestamp: Date.now(),
      });
      return;
    }
    const state = {
      sessions: getAllSessions(ACTIVE_THRESHOLD_MS, { force: true }),
      teams: getTeamsCached({ force: true }),
      usage: usageQuota.fetchUsage(),
    };
    broadcastSeq++;
    lastBroadcastState = state;
    wsSend(socket, {
      type: 'init',
      sessions: state.sessions,
      teams: state.teams,
      usage: state.usage,
      seq: broadcastSeq,
      timestamp: Date.now(),
    });
  } catch (err) {
    // Ignore initial data send failures.
  }
}

let watchDebounce = null;
let watchRefreshDebounce = null;
const watchRetryTimers = new Map();
let lastBroadcastSignature = null;
// Coarse counter bumped on any cache invalidation; used to skip the broadcast
// SHA when nothing relevant has changed since the last broadcast.
let cacheStampCounter = 0;
let lastBroadcastStamp = -1;
let providerDataDirty = true;
let teamsDirty = true;
let lastFullDiscoveryAt = 0;
let lastFullBroadcastAt = 0;
// Delta broadcasting: canonical {sessions, teams, usage} state matching the
// last frame sent to clients, plus a monotonic sequence number so delta
// clients can detect a broken patch chain and ask for a resync.
let broadcastSeq = 0;
let lastBroadcastState = null;
let lastDeltaSnapshotAt = 0;
const activeProjectGitState = new Map();
const activeWatchers = new Map();
const recursiveWatchFallbacks = new Map();
const serverPerf = {
  broadcasts: [],
  skippedWrites: 0,
  lastBroadcast: null,
  activeWatchPaths: 0,
  recursiveWatchFallbacks: 0,
  watchFailures: 0,
  watchFailureDetails: [],
  fallbackScans: 0,
  fallbackChanges: 0,
};
const teamsCache = {
  at: 0,
  teams: [],
};

const BROADCAST_POLL_INTERVAL = 2000;
const BROADCAST_DEBOUNCE_MS = 100;
const BROADCAST_FULL_DISCOVERY_INTERVAL = 20_000;
const TEAMS_CACHE_TTL_MS = 5000;
// Delta clients still get a periodic full snapshot as a self-healing floor.
const DELTA_SNAPSHOT_INTERVAL_MS = 20_000;
const DELTA_MAX_PATCH_OPS = 500;

function markProviderDataDirty(reason = 'watch', provider = null) {
  providerDataDirty = true;
  if (!provider || provider === 'claude') teamsDirty = true;
  cacheStampCounter++;
  invalidateSessionCaches({ provider });
  if (process.env.DEBUG_WATCH) {
    const scope = provider ? ` provider=${provider}` : ' provider=all';
    console.log(`[Watch] dirty: ${reason}${scope}`);
  }
}

function getTeamsCached({ force = false } = {}) {
  if (!claudeAdapter) return [];
  const now = Date.now();
  if (!force && !teamsDirty && now - teamsCache.at < TEAMS_CACHE_TTL_MS) {
    return teamsCache.teams;
  }
  const teams = claudeAdapter.getTeams();
  teamsCache.at = now;
  teamsCache.teams = teams;
  if (teamsDirty) cacheStampCounter++;
  teamsDirty = false;
  return teams;
}

function escapeJsonPointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Minimal JSON-Patch (RFC 6902 subset: add/replace/remove) diff. Arrays are
// diffed index-wise, which is cheap and correct for our mostly-stable,
// activity-sorted session lists; heavy reorders just produce a large patch
// that the size guard below converts back into a full broadcast.
function appendJsonPatchOps(prev, next, basePath, ops) {
  if (prev === next || ops.length > DELTA_MAX_PATCH_OPS) return;
  const prevIsArray = Array.isArray(prev);
  const nextIsArray = Array.isArray(next);
  if (prevIsArray && nextIsArray) {
    const shared = Math.min(prev.length, next.length);
    for (let i = 0; i < shared; i++) {
      appendJsonPatchOps(prev[i], next[i], `${basePath}/${i}`, ops);
    }
    for (let i = prev.length - 1; i >= next.length; i--) {
      ops.push({ op: 'remove', path: `${basePath}/${i}` });
    }
    for (let i = prev.length; i < next.length; i++) {
      ops.push({ op: 'add', path: `${basePath}/${i}`, value: next[i] });
    }
    return;
  }
  const prevIsObject = !prevIsArray && prev !== null && typeof prev === 'object';
  const nextIsObject = !nextIsArray && next !== null && typeof next === 'object';
  if (prevIsObject && nextIsObject) {
    for (const key of Object.keys(prev)) {
      if (!(key in next)) ops.push({ op: 'remove', path: `${basePath}/${escapeJsonPointerToken(key)}` });
    }
    for (const key of Object.keys(next)) {
      const childPath = `${basePath}/${escapeJsonPointerToken(key)}`;
      if (key in prev) appendJsonPatchOps(prev[key], next[key], childPath, ops);
      else ops.push({ op: 'add', path: childPath, value: next[key] });
    }
    return;
  }
  ops.push({ op: 'replace', path: basePath, value: next });
}

function createJsonPatch(prevState, nextState) {
  try {
    const ops = [];
    appendJsonPatchOps(prevState, nextState, '', ops);
    return ops;
  } catch {
    return null;
  }
}

function collectBroadcastPayload({ force = false } = {}) {
  const stages = {};
  const stage = (label, fn) => {
    const start = Date.now();
    const value = fn();
    stages[label] = Date.now() - start;
    return value;
  };
  const payload = {
    type: 'update',
    sessions: stage('sessions', () => getAllSessions(ACTIVE_THRESHOLD_MS, { force })),
    teams: stage('teams', () => getTeamsCached({ force })),
    usage: stage('usage', () => usageQuota.fetchUsage()),
    timestamp: Date.now(),
  };
  return { payload, stages };
}

function broadcastUpdate({ force = false, reason = 'poll' } = {}) {
  if (wsClients.size === 0) return;
  const now = Date.now();
  const heartbeatDue = now - lastFullBroadcastAt >= BROADCAST_FULL_DISCOVERY_INTERVAL;
  if (!force && !providerDataDirty && !heartbeatDue) return;

  // When the cache stamp hasn't moved we can skip a heartbeat-only refresh
  // without hashing the multi-KB payload. force-paths still flow through.
  const currentStamp = cacheStampCounter;
  if (!force && heartbeatDue && !providerDataDirty && currentStamp === lastBroadcastStamp) {
    lastFullBroadcastAt = now;
    return;
  }

  try {
    if (heartbeatDue) refreshWatchPaths();
    const collectStart = Date.now();
    const stampAtCollect = cacheStampCounter;
    const { payload, stages } = collectBroadcastPayload({ force: force || heartbeatDue });

    const sigStart = Date.now();
    let signature = lastBroadcastSignature;
    let signatureSkipped = false;
    let serializedState = null;
    if (force || stampAtCollect !== lastBroadcastStamp || lastBroadcastSignature === null) {
      serializedState = JSON.stringify({
        sessions: payload.sessions,
        teams: payload.teams,
        usage: payload.usage,
      });
      signature = crypto
        .createHash('sha1')
        .update(serializedState)
        .digest('hex');
    } else {
      signatureSkipped = true;
    }
    stages.signature = Date.now() - sigStart;

    if (signatureSkipped || signature === lastBroadcastSignature) {
      // Stamp or payload matched; nothing changed since the last broadcast.
      providerDataDirty = false;
      lastBroadcastStamp = stampAtCollect;
      lastFullBroadcastAt = now;
      return;
    }

    const deltaStart = Date.now();
    const nextState = { sessions: payload.sessions, teams: payload.teams, usage: payload.usage };
    const snapshotDue = now - lastDeltaSnapshotAt >= DELTA_SNAPSHOT_INTERVAL_MS;
    const patch = lastBroadcastState && !snapshotDue
      ? createJsonPatch(lastBroadcastState, nextState)
      : null;
    stages.delta = Date.now() - deltaStart;

    if (patch && patch.length === 0) {
      // Structurally identical to the last broadcast (e.g. key-order churn
      // changed the signature); refresh bookkeeping without waking clients.
      lastBroadcastSignature = signature;
      lastBroadcastStamp = stampAtCollect;
      lastBroadcastState = nextState;
      providerDataDirty = false;
      lastFullBroadcastAt = now;
      return;
    }

    let deltaMessage = null;
    if (patch && patch.length <= DELTA_MAX_PATCH_OPS) {
      const serializedPatch = JSON.stringify(patch);
      if (serializedState === null || serializedPatch.length < serializedState.length) {
        deltaMessage = {
          type: 'update-delta',
          baseSeq: broadcastSeq,
          seq: broadcastSeq + 1,
          patch,
          timestamp: payload.timestamp,
        };
      }
    }

    broadcastSeq++;
    payload.seq = broadcastSeq;
    lastBroadcastSignature = signature;
    lastBroadcastStamp = stampAtCollect;
    lastBroadcastState = nextState;
    if (!deltaMessage) lastDeltaSnapshotAt = now;
    wsBroadcast(payload, deltaMessage);
    providerDataDirty = false;
    lastFullBroadcastAt = now;
    const elapsed = Date.now() - collectStart;
    serverPerf.lastBroadcast = { elapsed, stages, reason, sessions: payload.sessions.length, clients: wsClients.size, mode: deltaMessage ? 'delta' : 'full', deltaOps: patch ? patch.length : null, ts: now };
    serverPerf.broadcasts.push(serverPerf.lastBroadcast);
    while (serverPerf.broadcasts.length > 25) serverPerf.broadcasts.shift();
    for (const [stage, ms] of Object.entries(stages)) {
      if (ms >= 500) console.log(`[Perf] broadcast ${stage} took ${ms}ms`);
    }
  } catch (err) {
    console.error('[Watch] Failed to process data:', err.message);
  }
}

function debouncedBroadcast() {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => broadcastUpdate({ reason: 'watch' }), BROADCAST_DEBOUNCE_MS);
}

function debouncedWatchRefresh() {
  if (watchRefreshDebounce) clearTimeout(watchRefreshDebounce);
  watchRefreshDebounce = setTimeout(() => {
    watchRefreshDebounce = null;
    refreshWatchPaths();
  }, BROADCAST_DEBOUNCE_MS);
}

function scheduleWatchRetry(wp, key, attempt = 0) {
  if (activeWatchers.has(key)) return;
  if (watchRetryTimers.has(key)) return;

  const delay = Math.min(5000, 200 * Math.pow(2, attempt));
  const timer = setTimeout(() => {
    watchRetryTimers.delete(key);
    if (activeWatchers.has(key)) return;
    if (fs.existsSync(wp.path)) {
      refreshWatchPaths();
      if (activeWatchers.has(key)) return;
    }
    if (attempt < 7) scheduleWatchRetry(wp, key, attempt + 1);
  }, delay);
  watchRetryTimers.set(key, timer);
}

function recordWatchFailure(wp, key, err, phase = 'setup') {
  serverPerf.watchFailures++;
  const detail = {
    phase,
    type: wp.type,
    path: wp.path,
    provider: wp.provider || null,
    recursive: Boolean(wp.recursive),
    message: err?.message || 'watch failed',
    ts: Date.now(),
  };
  serverPerf.watchFailureDetails.push(detail);
  while (serverPerf.watchFailureDetails.length > 20) serverPerf.watchFailureDetails.shift();
  if (process.env.DEBUG_WATCH) {
    console.log(`[Watch] ${phase} failed for ${key}: ${detail.message}`);
  }
}

function addRecursiveWatchFallback(wp, key, err) {
  if (wp.type !== 'directory' || !wp.recursive) return;
  const now = Date.now();
  if (!recursiveWatchFallbacks.has(key)) {
    const fallback = {
      wp,
      key,
      signature: null,
      lastScanAt: 0,
      lastSignatureAt: null,
      baselinePending: true,
      lastError: err?.message || null,
    };
    try {
      if (fs.existsSync(wp.path)) {
        fallback.signature = getWatchFallbackSignature(wp);
        fallback.lastSignatureAt = now;
        fallback.baselinePending = false;
        fallback.lastError = err?.message || null;
      }
    } catch (baselineErr) {
      fallback.lastError = baselineErr.message;
    }
    recursiveWatchFallbacks.set(key, fallback);
  } else {
    const fallback = recursiveWatchFallbacks.get(key);
    fallback.wp = wp;
    fallback.lastError = err?.message || fallback.lastError;
  }
  serverPerf.recursiveWatchFallbacks = recursiveWatchFallbacks.size;
}

// Per-subdirectory signature cache used to keep recursive fallback scans cheap
// when a user has hundreds of historic project directories.
const WATCH_FALLBACK_DIR_CACHE_TTL_MS = 10_000;
const WATCH_FALLBACK_DIR_IDLE_MS = 5 * 60_000;
const watchFallbackDirCache = new Map();
let recentlyActiveDirsAt = 0;
let recentlyActiveDirsCache = null;
const RECENTLY_ACTIVE_DIRS_TTL_MS = 5000;

function getRecentlyActiveDirs() {
  const now = Date.now();
  if (recentlyActiveDirsCache && now - recentlyActiveDirsAt < RECENTLY_ACTIVE_DIRS_TTL_MS) {
    return recentlyActiveDirsCache;
  }
  const dirs = new Set();
  try {
    const sessions = getAllSessions(ACTIVE_THRESHOLD_MS);
    for (const session of sessions) {
      if (session.project) dirs.add(session.project);
    }
  } catch {
    // Best-effort; if session enumeration fails, fall back to no constraint.
  }
  recentlyActiveDirsCache = dirs;
  recentlyActiveDirsAt = now;
  return dirs;
}

function _walkDirForSignature(root, wp, budget) {
  const stack = [{ dir: root, depth: 0 }];
  let entries = 0;
  let files = 0;
  let latestMtimeMs = 0;
  let totalSize = 0;
  let truncated = false;
  let errors = 0;

  while (stack.length > 0 && entries < budget) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      errors++;
      continue;
    }

    for (const dirent of dirents) {
      entries++;
      if (entries >= budget) {
        truncated = true;
        break;
      }

      const entryPath = path.join(current.dir, dirent.name);
      if (dirent.isDirectory()) {
        if (current.depth < WATCH_FALLBACK_MAX_DEPTH) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!dirent.isFile()) continue;
      if (wp.filter && !dirent.name.endsWith(wp.filter)) continue;

      try {
        const stat = fs.statSync(entryPath);
        files++;
        latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
        totalSize += stat.size;
      } catch {
        errors++;
      }
    }
  }

  if (stack.length > 0) truncated = true;
  return { files, latestMtimeMs, totalSize, truncated, errors };
}

function getWatchFallbackSignature(wp) {
  const root = wp.path;
  const now = Date.now();

  // Try to constrain the scan to immediate children of `root` (e.g.
  // ~/.claude/projects/*) so we can per-dir cache and skip idle ones.
  let rootDirents;
  try {
    rootDirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // Root unreadable — fall back to a single full walk for compatibility.
    const walk = _walkDirForSignature(root, wp, WATCH_FALLBACK_MAX_ENTRIES);
    return JSON.stringify({
      files: walk.files,
      latestMtimeMs: Math.round(walk.latestMtimeMs),
      totalSize: walk.totalSize,
      truncated: walk.truncated,
      errors: walk.errors + 1,
    });
  }

  const activeDirs = getRecentlyActiveDirs();
  let files = 0;
  let latestMtimeMs = 0;
  let totalSize = 0;
  let truncated = false;
  let errors = 0;
  // Total entry budget shared across children so a runaway dir can't starve siblings.
  let budgetLeft = WATCH_FALLBACK_MAX_ENTRIES;

  for (const dirent of rootDirents) {
    const childPath = path.join(root, dirent.name);
    if (!dirent.isDirectory()) {
      if (dirent.isFile()) {
        if (wp.filter && !dirent.name.endsWith(wp.filter)) continue;
        try {
          const stat = fs.statSync(childPath);
          files++;
          latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
          totalSize += stat.size;
        } catch {
          errors++;
        }
      }
      continue;
    }

    if (budgetLeft <= 0) {
      truncated = true;
      break;
    }

    const cacheKey = `${wp.provider || 'unknown'}:${wp.filter || ''}:${childPath}`;
    const cached = watchFallbackDirCache.get(cacheKey);

    // Cheap stat first: if the dir itself hasn't moved and we have a fresh
    // cached signature, reuse it.
    let dirMtimeMs = 0;
    try {
      dirMtimeMs = fs.statSync(childPath).mtimeMs;
    } catch {
      errors++;
      continue;
    }

    const isActive = activeDirs.has(childPath);
    const cacheFresh = cached && (now - cached.at) < WATCH_FALLBACK_DIR_CACHE_TTL_MS;
    const dirIdle = cached && dirMtimeMs <= cached.dirMtimeMs && (now - cached.lastChangedAt) > WATCH_FALLBACK_DIR_IDLE_MS;

    if (cacheFresh || (cached && !isActive && dirIdle)) {
      files += cached.files;
      latestMtimeMs = Math.max(latestMtimeMs, cached.latestMtimeMs);
      totalSize += cached.totalSize;
      if (cached.truncated) truncated = true;
      errors += cached.errors;
      continue;
    }

    const childBudget = Math.min(budgetLeft, WATCH_FALLBACK_MAX_ENTRIES);
    const walk = _walkDirForSignature(childPath, wp, childBudget);
    budgetLeft -= Math.min(childBudget, walk.files + 1);
    files += walk.files;
    latestMtimeMs = Math.max(latestMtimeMs, walk.latestMtimeMs);
    totalSize += walk.totalSize;
    if (walk.truncated) truncated = true;
    errors += walk.errors;

    const changed = !cached
      || cached.files !== walk.files
      || cached.totalSize !== walk.totalSize
      || Math.round(cached.latestMtimeMs) !== Math.round(walk.latestMtimeMs);
    watchFallbackDirCache.set(cacheKey, {
      at: now,
      dirMtimeMs,
      lastChangedAt: changed ? now : (cached?.lastChangedAt || now),
      files: walk.files,
      latestMtimeMs: walk.latestMtimeMs,
      totalSize: walk.totalSize,
      truncated: walk.truncated,
      errors: walk.errors,
    });
  }

  return JSON.stringify({ files, latestMtimeMs: Math.round(latestMtimeMs), totalSize, truncated, errors });
}

function runRecursiveWatchFallbackChecks() {
  const now = Date.now();
  for (const fallback of recursiveWatchFallbacks.values()) {
    if (activeWatchers.has(fallback.key)) {
      recursiveWatchFallbacks.delete(fallback.key);
      continue;
    }
    if (now - fallback.lastScanAt < WATCH_FALLBACK_SCAN_INTERVAL_MS) continue;
    fallback.lastScanAt = now;
    if (!fs.existsSync(fallback.wp.path)) continue;

    try {
      const signature = getWatchFallbackSignature(fallback.wp);
      serverPerf.fallbackScans++;
      const shouldMarkDirty = fallback.baselinePending || (fallback.signature && signature !== fallback.signature);
      if (shouldMarkDirty) {
        serverPerf.fallbackChanges++;
        markProviderDataDirty(`stat-fallback:${path.basename(fallback.wp.path)}`, fallback.wp.provider || null);
        debouncedBroadcast();
      }
      fallback.signature = signature;
      fallback.lastSignatureAt = now;
      fallback.baselinePending = false;
      fallback.lastError = null;
    } catch (err) {
      fallback.lastError = err.message;
      if (process.env.DEBUG_WATCH) {
        console.log(`[Watch] fallback scan failed for ${fallback.key}: ${err.message}`);
      }
    }
  }
  serverPerf.recursiveWatchFallbacks = recursiveWatchFallbacks.size;
}

// ─── File watching (multi-provider) ────────────────────────

function watchKey(wp) {
  return `${wp.provider || 'unknown'}:${wp.type}:${wp.path}:${wp.filter || ''}:${wp.recursive ? 1 : 0}`;
}

function handleWatchEvent(wp, key, eventType, filename) {
  const isRelevant = wp.type === 'directory' || eventType === 'change' || eventType === 'rename';
  if (!isRelevant) return;
  if (wp.type === 'directory' && wp.filter && filename && !filename.endsWith(wp.filter)) return;

  if (wp.type === 'file' && eventType === 'rename') {
    const watcher = activeWatchers.get(key);
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      activeWatchers.delete(key);
    }
    debouncedWatchRefresh();
    scheduleWatchRetry(wp, key);
  }

  markProviderDataDirty(`${wp.type}:${path.basename(wp.path)}`, wp.provider || null);
  debouncedBroadcast();
}

function refreshWatchPaths(initialWatchPaths = null) {
  const watchPaths = Array.isArray(initialWatchPaths) ? initialWatchPaths : safeCollect('getAllWatchPaths', getAllWatchPaths, []);
  const nextKeys = new Set();
  let added = 0;

  for (const wp of watchPaths) {
    const key = watchKey(wp);
    nextKeys.add(key);
    if (activeWatchers.has(key)) continue;
    try {
      let watcher = null;
      if (wp.type === 'file') {
        if (!fs.existsSync(wp.path)) continue;
        watcher = fs.watch(wp.path, (eventType, filename) => handleWatchEvent(wp, key, eventType, filename));
      } else if (wp.type === 'directory') {
        if (!fs.existsSync(wp.path)) continue;
        watcher = fs.watch(wp.path, { recursive: wp.recursive || false }, (eventType, filename) => handleWatchEvent(wp, key, eventType, filename));
      }
      if (!watcher) continue;
      watcher.on?.('error', () => {
        activeWatchers.delete(key);
        const err = new Error('watcher emitted error');
        recordWatchFailure(wp, key, err, 'runtime');
        addRecursiveWatchFallback(wp, key, err);
        scheduleWatchRetry(wp, key);
      });
      activeWatchers.set(key, watcher);
      recursiveWatchFallbacks.delete(key);
      const retryTimer = watchRetryTimers.get(key);
      if (retryTimer) {
        clearTimeout(retryTimer);
        watchRetryTimers.delete(key);
      }
      added++;
    } catch (err) {
      recordWatchFailure(wp, key, err, 'setup');
      addRecursiveWatchFallback(wp, key, err);
    }
  }

  for (const [key, watcher] of activeWatchers) {
    if (nextKeys.has(key)) continue;
    try { watcher.close(); } catch { /* ignore */ }
    activeWatchers.delete(key);
  }

  for (const key of recursiveWatchFallbacks.keys()) {
    if (nextKeys.has(key)) continue;
    recursiveWatchFallbacks.delete(key);
  }

  if (added > 0 || serverPerf.activeWatchPaths !== activeWatchers.size) {
    console.log(`[Watch] ${activeWatchers.size} paths are now being watched`);
    markProviderDataDirty('watch-refresh');
  }
  serverPerf.activeWatchPaths = activeWatchers.size;
  serverPerf.recursiveWatchFallbacks = recursiveWatchFallbacks.size;
  lastFullDiscoveryAt = Date.now();
}

function resolveProjectGitDir(project) {
  if (!project) return null;
  try {
    const dotGit = path.join(project, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;

    const content = fs.readFileSync(dotGit, 'utf8');
    const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/im);
    if (!match) return null;
    return path.resolve(project, match[1]);
  } catch {
    return null;
  }
}

function gitStateFilePart(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return `${label}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return null;
  }
}

function appendGitRefDirParts(parts, root, label) {
  const stack = [{ dir: root, depth: 0 }];
  let entries = 0;

  while (stack.length > 0 && entries < GIT_STATE_MAX_REF_ENTRIES) {
    const current = stack.pop();
    let dirents = [];
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > GIT_STATE_MAX_REF_ENTRIES) break;
      const entryPath = path.join(current.dir, dirent.name);
      const rel = path.relative(root, entryPath);
      if (dirent.isDirectory()) {
        if (current.depth < 8) stack.push({ dir: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (!dirent.isFile()) continue;
      const part = gitStateFilePart(entryPath, `${label}/${rel}`);
      if (part) parts.push(part);
    }
  }

  if (entries >= GIT_STATE_MAX_REF_ENTRIES) parts.push(`${label}:truncated`);
}

function projectGitStateSignature(project) {
  const gitDir = resolveProjectGitDir(project);
  if (!gitDir) return null;

  const parts = [];
  for (const fileName of ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs', path.join('logs', 'HEAD')]) {
    const part = gitStateFilePart(path.join(gitDir, fileName), fileName);
    if (part) parts.push(part);
  }
  appendGitRefDirParts(parts, path.join(gitDir, 'refs', 'heads'), 'refs/heads');
  appendGitRefDirParts(parts, path.join(gitDir, 'refs', 'remotes'), 'refs/remotes');
  appendGitRefDirParts(parts, path.join(gitDir, 'logs', 'refs', 'heads'), 'logs/refs/heads');
  appendGitRefDirParts(parts, path.join(gitDir, 'logs', 'refs', 'remotes'), 'logs/refs/remotes');
  return parts.sort().join('|');
}

function activeGitProjects() {
  const projects = [];
  const seen = new Set();
  let sessions = [];
  try {
    sessions = getAllSessions(ACTIVE_THRESHOLD_MS);
  } catch {
    return projects;
  }

  for (const session of sessions) {
    const project = session?.project;
    if (!project || seen.has(project)) continue;
    seen.add(project);
    projects.push(project);
    if (projects.length >= GIT_STATE_MAX_PROJECTS) break;
  }
  return projects;
}

function scanActiveProjectGitState() {
  if (wsClients.size === 0) return;

  const projects = activeGitProjects();
  const activeProjects = new Set(projects);
  for (const project of activeProjectGitState.keys()) {
    if (!activeProjects.has(project)) activeProjectGitState.delete(project);
  }

  let changed = false;
  for (const project of projects) {
    const signature = projectGitStateSignature(project);
    if (!signature) continue;
    const previous = activeProjectGitState.get(project);
    activeProjectGitState.set(project, signature);
    if (previous && previous !== signature) changed = true;
  }

  if (changed) markProviderDataDirty('git-state');
}

function startFileWatcher(initialWatchPaths = null) {
  refreshWatchPaths(initialWatchPaths);
  // Periodic polling (2 seconds) to catch missed changes
  setInterval(() => {
    if (Date.now() - lastFullDiscoveryAt >= BROADCAST_FULL_DISCOVERY_INTERVAL) {
      refreshWatchPaths();
    }
    runRecursiveWatchFallbackChecks();
    scanActiveProjectGitState();
    if (wsClients.size > 0) broadcastUpdate({ reason: 'interval' });
  }, BROADCAST_POLL_INTERVAL);
  console.log('[Watch] Started dirty-driven 2-second scheduler');
}

// ─── HTTP server ──────────────────────────────────────────

const API_ROUTES = {
  GET: new Map([
    ['/api/sessions', handleGetSessions],
    ['/api/teams', handleGetTeams],
    ['/api/tasks', handleGetTasks],
    ['/api/session-detail', handleGetSessionDetail],
    ['/api/providers', handleGetProviders],
    ['/api/usage', handleGetUsage],
    ['/api/perf', handleGetPerf],
    ['/api/changelog', handleGetChangelog],
  ]),
  POST: new Map([
    ['/api/session-details', handlePostSessionDetails],
  ]),
};

const WIDGET_STATIC_PATHS = new Set(['/widget.html', '/widget.css']);

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendError(res, 400, 'Bad Request');
  }
  const pathname = parsedUrl.pathname;

  const routeHandler = API_ROUTES[req.method]?.get(pathname);
  if (routeHandler) {
    return routeHandler(req, res, parsedUrl);
  }

  if (WIDGET_STATIC_PATHS.has(pathname)) {
    return handleWidgetStaticFile(req, res, parsedUrl);
  }

  handleStaticFile(req, res, parsedUrl);
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ─── Start server ──────────────────────────────────────────

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
  console.log(`  Server running: http://localhost:${PORT}`);
  console.log('');

  // Show active providers
  const providers = getActiveProviders();
  if (providers.length === 0) {
    console.log('  [!] No active providers');
    console.log('      One of ~/.claude/, ~/.codex/, ~/.gemini/, ~/.kimi/, or ~/.local/share/opencode/ is required');
  } else {
    console.log('  Active providers:');
    for (const p of providers) {
      console.log(`    - ${p.name} (${p.homeDir})`);
    }
  }
  console.log('');

  setTimeout(() => {
    const startupStats = printStartupStats(providers);
    // Initialize the usage quota service
    usageQuota.init();
    startFileWatcher(startupStats.watchPaths);
    startWebSocketHeartbeat();
  }, STARTUP_BOOTSTRAP_DELAY_MS);
});

// ─── Error handling ────────────────────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Unhandled exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  for (const socket of wsClients) {
    closeWebSocket(socket, null);
  }
  server.close(() => {
    console.log('Server shutdown complete');
    process.exit(0);
  });
});
