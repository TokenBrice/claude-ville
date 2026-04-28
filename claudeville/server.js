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
  invalidateSessionCaches,
  adapters,
} = require('./adapters');

// ─── Usage quota service ──────────────────────────────
const usageQuota = require('./services/usageQuota');

// Claude adapter (teams/tasks are Claude-only)
const claudeAdapter = adapters.find(a => a.provider === 'claude');

// ─── Settings ───────────────────────────────────────────────
const PORT = 4000;
const STATIC_DIR = __dirname;
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const ALLOWED_SESSION_PROVIDERS = Object.freeze(new Set(['claude', 'codex', 'gemini', 'git']));
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

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > JSON_BODY_LIMIT_BYTES) {
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!body) return callback(null, {});
    try {
      callback(null, JSON.parse(body));
    } catch (err) {
      callback(err);
    }
  });
  req.on('error', callback);
}

function cacheControlFor(reqPath) {
  return reqPath.startsWith('/assets/sprites/')
    ? 'no-cache'
    : 'no-cache';
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
function handleGetSessions(req, res) {
  try {
    const sessions = getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
    sendJson(res, 200, { sessions, count: sessions.length, timestamp: Date.now() });
  } catch (err) {
    console.error('Failed to fetch sessions:', err.message);
    sendError(res, 500, 'Unable to load session information.');
  }
}

/**
 * GET /api/teams
 * Claude team information (Claude-only)
 */
function handleGetTeams(req, res) {
  try {
    const teams = claudeAdapter ? claudeAdapter.getTeams() : [];
    sendJson(res, 200, { teams, count: teams.length });
  } catch (err) {
    console.error('Failed to fetch teams:', err.message);
    sendError(res, 500, 'Unable to load team information.');
  }
}

/**
 * GET /api/tasks
 * Claude task information (Claude-only)
 */
function handleGetTasks(req, res) {
  try {
    const taskGroups = claudeAdapter ? claudeAdapter.getTasks() : [];
    sendJson(res, 200, { taskGroups, totalGroups: taskGroups.length });
  } catch (err) {
    console.error('Failed to fetch tasks:', err.message);
    sendError(res, 500, 'Unable to load task information.');
  }
}

/**
 * GET /api/session-detail?sessionId=xxx&project=xxx&provider=claude
 * Return tool history and recent messages for one session
 */
function handleGetSessionDetail(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    const project = url.searchParams.get('project') || '';
    const provider = String(url.searchParams.get('provider') || 'claude').toLowerCase();

    if (!sessionId) return sendError(res, 400, 'sessionId is required');
    if (!ALLOWED_SESSION_PROVIDERS.has(provider)) return sendError(res, 400, 'invalid provider');

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
    if (err) return sendError(res, 400, 'invalid JSON body');
    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    const valid = [];
    for (const item of items) {
      const provider = String(item?.provider || 'claude').toLowerCase();
      const sessionId = String(item?.sessionId || '');
      if (!sessionId || !ALLOWED_SESSION_PROVIDERS.has(provider)) continue;
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
  try {
    const providers = getActiveProviders();
    sendJson(res, 200, { providers, count: providers.length });
  } catch (err) {
    console.error('Failed to fetch providers:', err.message);
    sendError(res, 500, 'Unable to load provider information.');
  }
}

/**
 * GET /api/usage
 * Claude usage/subscription information
 */
function handleGetUsage(req, res) {
  try {
    const usage = usageQuota.fetchUsage();
    sendJson(res, 200, usage);
  } catch (err) {
    console.error('Failed to fetch usage:', err.message);
    sendError(res, 500, 'Unable to load usage information.');
  }
}

// ─── Static file serving ─────────────────────────────────────

function handleStaticFile(req, res) {
  if (process.env.DEBUG_STATIC) {
    console.log('[Static] request', req.url);
  }
  try {
    const requestedPath = decodeURIComponent(req.url.split('?')[0] || '/');
    let filePath = path.join(STATIC_DIR, requestedPath === '/' ? 'index.html' : requestedPath);

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

    if (process.env.DEBUG_STATIC) {
      console.log('[Static] resolved', filePath, 'type', contentType);
    }

    setCorsHeaders(res);
    fs.readFile(filePath, isText ? 'utf-8' : undefined, (err, data) => {
      if (process.env.DEBUG_STATIC) {
        console.log('[Static] read callback for', filePath, 'err?', Boolean(err));
      }
      if (err) {
        console.error('File read error:', err.message);
        return sendError(res, 500, 'Internal Server Error');
      }

      if (process.env.DEBUG_STATIC) {
        const byteLength = Buffer.isBuffer(data) ? data.length : String(data).length;
        console.log('[Static] serving', filePath, 'bytes', byteLength, 'type', contentType);
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControlFor(req.url),
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

// ─── WebSocket implementation (RFC 6455) ──────────────────────────

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
    socket._cvLastSeen = Date.now();
    socket._cvDraining = false;
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
      // Ignore frame handling errors.
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
  socket._cvLastSeen = Date.now();

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
      socket._cvLastSeen = Date.now();
      break;
  }
}

function handleTextMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      wsSend(socket, { type: 'pong', timestamp: Date.now() });
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
    wsClients.delete(socket);
  }
}

function wsBroadcast(data) {
  const frame = createWebSocketFrame(JSON.stringify(data));
  for (const socket of wsClients) {
    writeWebSocketFrame(socket, frame);
  }
}

function writeWebSocketFrame(socket, frame) {
  if (!socket || socket.destroyed || !socket.writable) {
    wsClients.delete(socket);
    return false;
  }
  if ((socket.writableLength || 0) > WS_BACKPRESSURE_BYTES) {
    try { socket.end(createWebSocketFrame('', 0x8)); } catch { socket.destroy(); }
    wsClients.delete(socket);
    return false;
  }
  if (socket._cvDraining) return false;
  try {
    const ok = socket.write(frame);
    if (!ok) {
      socket._cvDraining = true;
      socket.once('drain', () => {
        socket._cvDraining = false;
      });
    }
    return ok;
  } catch {
    wsClients.delete(socket);
    return false;
  }
}

function startWebSocketHeartbeat() {
  setInterval(() => {
    const now = Date.now();
    const pingFrame = createWebSocketFrame(String(now), 0x9);
    for (const socket of wsClients) {
      if (!socket || socket.destroyed) {
        wsClients.delete(socket);
        continue;
      }
      if (now - (socket._cvLastSeen || now) > WS_STALE_AFTER_MS) {
        try { socket.end(createWebSocketFrame('', 0x8)); } catch { socket.destroy(); }
        wsClients.delete(socket);
        continue;
      }
      writeWebSocketFrame(socket, pingFrame);
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
}

// ─── Data broadcast ────────────────────────────────

function sendInitialData(socket) {
  try {
    wsSend(socket, {
      type: 'init',
      sessions: getAllSessions(ACTIVE_THRESHOLD_MS, { force: true }),
      teams: getTeamsCached({ force: true }),
      usage: usageQuota.fetchUsage(),
      timestamp: Date.now(),
    });
  } catch (err) {
    // Ignore initial data send failures.
  }
}

let watchDebounce = null;
let lastBroadcastSignature = null;
let providerDataDirty = true;
let lastFullDiscoveryAt = 0;
let lastFullBroadcastAt = 0;
const activeWatchers = new Map();
const serverPerf = {
  broadcasts: [],
  skippedWrites: 0,
  lastBroadcast: null,
  activeWatchPaths: 0,
};
const teamsCache = {
  at: 0,
  signature: '',
  teams: [],
};

const BROADCAST_POLL_INTERVAL = 2000;
const BROADCAST_DEBOUNCE_MS = 100;
const BROADCAST_FULL_DISCOVERY_INTERVAL = 20_000;
const TEAMS_CACHE_TTL_MS = 5000;

function markProviderDataDirty(reason = 'watch') {
  providerDataDirty = true;
  invalidateSessionCaches();
  if (process.env.DEBUG_WATCH) console.log(`[Watch] dirty: ${reason}`);
}

function getTeamsCached({ force = false } = {}) {
  if (!claudeAdapter) return [];
  const now = Date.now();
  if (!force && !providerDataDirty && now - teamsCache.at < TEAMS_CACHE_TTL_MS) {
    return teamsCache.teams;
  }
  const teams = claudeAdapter.getTeams();
  teamsCache.at = now;
  teamsCache.teams = teams;
  teamsCache.signature = crypto.createHash('sha1').update(JSON.stringify(teams)).digest('hex');
  return teams;
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

  try {
    if (heartbeatDue) refreshWatchPaths();
    const collectStart = Date.now();
    const { payload, stages } = collectBroadcastPayload({ force: force || heartbeatDue });

    const signature = crypto
      .createHash('sha1')
      .update(JSON.stringify({
        sessions: payload.sessions,
        teams: payload.teams,
        usage: payload.usage,
      }))
      .digest('hex');

    if (signature === lastBroadcastSignature) {
      providerDataDirty = false;
      lastFullBroadcastAt = now;
      return;
    }

    lastBroadcastSignature = signature;
    wsBroadcast(payload);
    providerDataDirty = false;
    lastFullBroadcastAt = now;
    const elapsed = Date.now() - collectStart;
    serverPerf.lastBroadcast = { elapsed, stages, reason, sessions: payload.sessions.length, clients: wsClients.size, ts: now };
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

// ─── File watching (multi-provider) ────────────────────────

function watchKey(wp) {
  return `${wp.type}:${wp.path}:${wp.filter || ''}:${wp.recursive ? 1 : 0}`;
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
        watcher = fs.watch(wp.path, (eventType) => {
          if (eventType === 'change' || eventType === 'rename') {
            markProviderDataDirty(`file:${path.basename(wp.path)}`);
            debouncedBroadcast();
          }
        });
      } else if (wp.type === 'directory') {
        if (!fs.existsSync(wp.path)) continue;
        watcher = fs.watch(wp.path, { recursive: wp.recursive || false }, (eventType, filename) => {
          if (wp.filter && filename && !filename.endsWith(wp.filter)) return;
          markProviderDataDirty(`dir:${path.basename(wp.path)}`);
          debouncedBroadcast();
        });
      }
      if (!watcher) continue;
      watcher.on?.('error', () => {
        activeWatchers.delete(key);
      });
      activeWatchers.set(key, watcher);
      added++;
    } catch {
      // Ignore paths that cannot be watched.
    }
  }

  for (const [key, watcher] of activeWatchers) {
    if (nextKeys.has(key)) continue;
    try { watcher.close(); } catch { /* ignore */ }
    activeWatchers.delete(key);
  }

  if (added > 0 || serverPerf.activeWatchPaths !== activeWatchers.size) {
    console.log(`[Watch] ${activeWatchers.size} paths are now being watched`);
    markProviderDataDirty('watch-refresh');
  }
  serverPerf.activeWatchPaths = activeWatchers.size;
  lastFullDiscoveryAt = Date.now();
}

function startFileWatcher(initialWatchPaths = null) {
  refreshWatchPaths(initialWatchPaths);
  // Periodic polling (2 seconds) to catch missed changes
  setInterval(() => {
    if (Date.now() - lastFullDiscoveryAt >= BROADCAST_FULL_DISCOVERY_INTERVAL) {
      refreshWatchPaths();
    }
    if (wsClients.size > 0) broadcastUpdate({ reason: 'interval' });
  }, BROADCAST_POLL_INTERVAL);
  console.log('[Watch] Started dirty-driven 2-second scheduler');
}

// ─── HTTP server ──────────────────────────────────────────

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
      case '/api/usage':
        return handleGetUsage(req, res);
    }
  }

  if (req.method === 'POST') {
    switch (pathname) {
      case '/api/session-details':
        return handlePostSessionDetails(req, res);
    }
  }

  // Serve widget files (/widget.html, /widget.css)
  if (pathname === '/widget.html' || pathname === '/widget.css') {
    const widgetFile = path.join(__dirname, '..', 'widget', 'Resources', pathname);
    if (fs.existsSync(widgetFile)) {
      const ext = path.extname(widgetFile).toLowerCase();
      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext], 'Cache-Control': cacheControlFor(pathname) });
      fs.createReadStream(widgetFile, { encoding: 'utf-8' }).pipe(res);
      return;
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
    console.log('      One of ~/.claude/, ~/.codex/, or ~/.gemini/ is required');
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
    try {
      socket.end(createWebSocketFrame('', 0x8));
    } catch { /* ignore */ }
  }
  server.close(() => {
    console.log('Server shutdown complete');
    process.exit(0);
  });
});
