const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

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
  setAdapterDataReadyCallback,
  adapters,
} = require('./adapters');
const { getTailCacheDiagnostics } = require('./adapters/shared');

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
const WATCH_FALLBACK_MAX_AGE_MS = 60_000;
const WATCH_DYNAMIC_CAP = Math.max(1, Math.min(2048, Number(process.env.CLAUDEVILLE_WATCH_DYNAMIC_CAP || 512) || 512));
const WATCH_ACTIVE_PROBE_CAP = Math.max(1, Math.min(4096, Number(process.env.CLAUDEVILLE_WATCH_PROBE_CAP || 1024) || 1024));
const WATCH_ZERO_CLIENT_GRACE_MS = Math.max(50, Number(process.env.CLAUDEVILLE_WATCH_ZERO_CLIENT_GRACE_MS || 15_000) || 15_000);
const WATCH_RECONCILIATION_INTERVAL_MS = 30_000;
const PERF_SAMPLE_INTERVAL_MS = 5000;
const LINUX_WATCH_SAMPLE_INTERVAL_MS = 15_000;
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

function cacheControlFor(parsedUrl, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const versioned = parsedUrl?.searchParams?.has('v');
  const isFont = ['.woff', '.woff2', '.ttf'].includes(ext);
  const spriteRoot = path.join(STATIC_ROOT, 'assets', 'sprites');
  const isSprite = isContainedPath(spriteRoot, filePath);
  if (versioned && (isFont || isSprite)) return 'public, max-age=31536000, immutable';
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

function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function printStartupStats(providers) {
  const sessions = safeCollect('getAllSessions', () => getAllSessions(ACTIVE_THRESHOLD_MS), []);
  updateCanonicalActiveProjects(sessions);
  const watchPaths = safeCollect('getAllWatchPaths', () => getAllWatchPaths({
    sessions,
    activeThresholdMs: ACTIVE_THRESHOLD_MS,
  }), []);

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
    updateCanonicalActiveProjects(sessions);
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
  const gitEnrichment = getGitEnrichmentPerfStats();
  sendApiPayload(res, 'Failed to fetch perf counters', () => ({
    websocketClients: wsClients.size,
    activeWatchPaths: serverPerf.activeWatchPaths,
    recursiveWatchFallbacks: serverPerf.recursiveWatchFallbacks,
    recursiveWatchFallbackDetails: Array.from(recursiveWatchFallbacks.values()).map((fallback) => ({
      path: fallback.wp.path,
      provider: fallback.wp.provider || null,
      filters: fallback.wp.filters || (fallback.wp.filter ? [fallback.wp.filter] : []),
      baselinePending: Boolean(fallback.baselinePending),
      lastScanAt: fallback.lastScanAt || null,
      lastSignatureAt: fallback.lastSignatureAt || null,
      lastForcedAt: fallback.lastForcedAt || null,
      entriesScanned: fallback.entriesScanned || 0,
      lastError: fallback.lastError || null,
    })),
    providers: getAdapterPerfStats(),
    gitEnrichment,
    gitRate: perfDiagnostics.gitRate,
    jsonlDiagnostics: getJsonlDiagnostics(),
    tailCache: getTailCacheDiagnostics(),
    watchFailures: serverPerf.watchFailures,
    recentWatchFailures: serverPerf.watchFailureDetails,
    fallbackScans: serverPerf.fallbackScans,
    fallbackChanges: serverPerf.fallbackChanges,
    fallbackEntriesScanned: serverPerf.fallbackEntriesScanned,
    skippedWrites: serverPerf.skippedWrites,
    lastBroadcast: serverPerf.lastBroadcast,
    recentBroadcasts: serverPerf.broadcasts,
    cacheStampCounter,
    lastBroadcastStamp,
    runtime: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: perfDiagnostics.memory,
      eventLoop: perfDiagnostics.eventLoop,
    },
    watchers: {
      configured: serverPerf.configuredWatchPaths,
      canonical: serverPerf.canonicalWatchPaths,
      installed: serverPerf.activeWatchPaths,
      stableInstalled: serverPerf.stableWatchPaths,
      dynamicRequested: serverPerf.dynamicWatchPathsRequested,
      dynamicInstalled: serverPerf.dynamicWatchPaths,
      dynamicDropped: serverPerf.dynamicWatchPathsDropped,
      dynamicCap: WATCH_DYNAMIC_CAP,
      dynamicEnabled: dynamicWatchersEnabled,
      probePaths: serverPerf.probeWatchPaths,
      probeCap: WATCH_ACTIVE_PROBE_CAP,
      probeScans: serverPerf.probeScans,
      probeChanges: serverPerf.probeChanges,
      reconciliations: serverPerf.reconciliations,
      lastReconciliationAt,
      linux: perfDiagnostics.linuxWatchers,
    },
    caches: {
      teams: {
        entries: teamsCache.teams.length,
        estimatedBytes: estimateJsonBytes(teamsCache.teams),
      },
      broadcastState: {
        entries: Array.isArray(lastBroadcastState?.sessions) ? lastBroadcastState.sessions.length : 0,
        estimatedBytes: serverPerf.lastBroadcastStateBytes,
      },
      activeProjectGitState: { entries: activeProjectGitState.size },
      watchFallbacks: { entries: recursiveWatchFallbacks.size },
      watchProbeSignatures: { entries: watchProbeSignatures.size },
      activeProbeDescriptors: { entries: activeProbeDescriptors.size },
      watchRetries: { entries: watchRetryTimers.size },
      gitStatus: {
        entries: Number(gitEnrichment.statusCacheSize || 0) + Number(gitEnrichment.currentBranchCacheSize || 0),
      },
    },
    dirty: {
      providerDataDirty,
      teamsDirty,
      marks: serverPerf.dirtyMarks,
      last: serverPerf.lastDirty,
    },
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
        'Cache-Control': cacheControlFor(parsedUrl, filePath),
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
    const wasEmpty = wsClients.size === 0;
    wsClients.add(socket);
    if (wasEmpty) onFirstWebSocketClient();
    if (head.length > 0) {
      processWebSocketData(socket, head);
    }
    socket._cvInitialTimer = setTimeout(() => {
      socket._cvInitialTimer = null;
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
  const removed = wsClients.delete(socket);
  if (socket._cvInitialTimer) {
    clearTimeout(socket._cvInitialTimer);
    socket._cvInitialTimer = null;
  }
  socket._cvPendingFrame = null;
  socket._cvDraining = false;
  if (removed && wsClients.size === 0) onLastWebSocketClient();
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
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
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
    updateCanonicalActiveProjects(state.sessions);
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
let dynamicWatchRetireTimer = null;
let heartbeatTimer = null;
let watcherSchedulerTimer = null;
let perfSampleTimer = null;
let startupTimer = null;
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
let lastReconciliationAt = 0;
// Delta broadcasting: canonical {sessions, teams, usage} state matching the
// last frame sent to clients, plus a monotonic sequence number so delta
// clients can detect a broken patch chain and ask for a resync.
let broadcastSeq = 0;
let lastBroadcastState = null;
let lastDeltaSnapshotAt = 0;
const activeProjectGitState = new Map();
const lastCanonicalActiveProjects = new Set();
const activeWatchers = new Map();
const recursiveWatchFallbacks = new Map();
const watchProbeSignatures = new Map();
let latestWatchDescriptors = [];
let selectedWatchDescriptors = new Map();
let activeProbeDescriptors = new Map();
let dynamicWatchersEnabled = false;
const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
let lastEventLoopUtilization = performance.eventLoopUtilization();
let lastGitPerfSample = null;
let lastLinuxWatchSampleAt = 0;
const perfDiagnostics = {
  memory: null,
  eventLoop: null,
  gitRate: null,
  linuxWatchers: {
    supported: process.platform === 'linux',
    sampledAt: null,
    inotifyFds: null,
    watchEntries: null,
    error: null,
  },
};
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
  fallbackEntriesScanned: 0,
  configuredWatchPaths: 0,
  canonicalWatchPaths: 0,
  stableWatchPaths: 0,
  dynamicWatchPathsRequested: 0,
  dynamicWatchPaths: 0,
  dynamicWatchPathsDropped: 0,
  probeWatchPaths: 0,
  probeScans: 0,
  probeChanges: 0,
  reconciliations: 0,
  dirtyMarks: 0,
  lastDirty: null,
  lastBroadcastStateBytes: 0,
};
const teamsCache = {
  at: 0,
  teams: [],
};

const BROADCAST_POLL_INTERVAL = 2000;
const BROADCAST_DEBOUNCE_MS = 100;
const TEAMS_CACHE_TTL_MS = 5000;
// Delta clients still get a periodic full snapshot as a self-healing floor.
const DELTA_SNAPSHOT_INTERVAL_MS = 20_000;
const DELTA_MAX_PATCH_OPS = 500;

function normalizeServerDirtyDescriptor(value = 'watch', provider = null) {
  const input = value && typeof value === 'object'
    ? value
    : { reason: value, provider, kind: 'reconcile' };
  return {
    provider: input.provider ? String(input.provider).toLowerCase() : null,
    path: input.path ? path.resolve(String(input.path)) : null,
    kind: input.kind || 'reconcile',
    reason: String(input.reason || 'watch'),
    sessionId: input.sessionId ? String(input.sessionId) : null,
    project: input.project ? path.resolve(String(input.project)) : null,
  };
}

function markProviderDataDirty(value = 'watch', provider = null) {
  const dirty = normalizeServerDirtyDescriptor(value, provider);
  providerDataDirty = true;
  if (dirty.kind === 'teams'
    || (dirty.provider === 'claude' && ['discovery', 'metadata', 'reconcile'].includes(dirty.kind))
    || (!dirty.provider && dirty.kind === 'reconcile')) {
    teamsDirty = true;
  }
  cacheStampCounter++;
  serverPerf.dirtyMarks++;
  serverPerf.lastDirty = { ...dirty, at: Date.now() };
  invalidateSessionCaches({ provider: dirty.provider, dirty });
  if (process.env.DEBUG_WATCH) {
    const scope = dirty.provider ? ` provider=${dirty.provider}` : ' provider=all';
    console.log(`[Watch] dirty: ${dirty.reason} kind=${dirty.kind}${scope}`);
  }
}

function updateCanonicalActiveProjects(sessions = []) {
  const projects = [];
  const seen = new Set();
  for (const session of sessions) {
    const project = session?.project;
    if (!project || seen.has(project)) continue;
    seen.add(project);
    projects.push(project);
    if (projects.length >= GIT_STATE_MAX_PROJECTS) break;
  }
  lastCanonicalActiveProjects.clear();
  projects.forEach((project) => lastCanonicalActiveProjects.add(project));
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
  updateCanonicalActiveProjects(payload.sessions);
  return { payload, stages };
}

function broadcastUpdate({ force = false, reason = 'poll' } = {}) {
  if (wsClients.size === 0) return;
  const now = Date.now();
  if (!force && !providerDataDirty) return;

  try {
    const collectStart = Date.now();
    const stampAtCollect = cacheStampCounter;
    const { payload, stages } = collectBroadcastPayload({ force });

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
      serverPerf.lastBroadcastStateBytes = Buffer.byteLength(serializedState);
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

setAdapterDataReadyCallback((dirty) => {
  if (shutdownStarted) return;
  markProviderDataDirty(dirty);
  debouncedBroadcast();
});

function scheduleWatchRetry(wp, key, attempt = 0) {
  if (activeWatchers.has(key)) return;
  if (watchRetryTimers.has(key)) return;
  if (!selectedWatchDescriptors.has(key)) return;

  const delay = Math.min(5000, 200 * Math.pow(2, attempt));
  const timer = setTimeout(() => {
    watchRetryTimers.delete(key);
    if (activeWatchers.has(key)) return;
    if (!selectedWatchDescriptors.has(key)) return;
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
    provider: wp.provider || wp.providers?.[0] || null,
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

function descriptorProviders(wp) {
  if (Array.isArray(wp.providers) && wp.providers.length > 0) return wp.providers;
  return wp.provider ? [wp.provider] : [];
}

function descriptorEventPath(wp, filename = null) {
  if (wp.type !== 'directory' || !filename) return wp.path;
  const candidate = path.resolve(wp.path, String(filename));
  return isContainedPath(wp.path, candidate) ? candidate : wp.path;
}

function descriptorDirtyKind(wp, eventPath) {
  const normalizedPath = String(eventPath || wp.path).toLowerCase();
  const kinds = Array.isArray(wp.kinds) ? wp.kinds : (wp.kind ? [wp.kind] : []);
  if (normalizedPath.includes(`${path.sep}teams${path.sep}`) || normalizedPath.endsWith(`${path.sep}teams`)) return 'teams';
  if (kinds.length === 1) return kinds[0];
  if (normalizedPath.endsWith('.jsonl') && (wp.scopes?.includes('active') || wp.scopes?.includes('recent'))) {
    return 'transcript';
  }
  if (kinds.includes('transcript') && wp.scopes?.includes('active')) return 'transcript';
  if (kinds.includes('metadata')) return 'metadata';
  return kinds[0] || 'discovery';
}

function dirtyDescriptorForWatch(wp, reason, filename = null) {
  const providers = descriptorProviders(wp);
  const sessionIds = Array.isArray(wp.sessionIds) ? wp.sessionIds : (wp.sessionId ? [wp.sessionId] : []);
  const projects = Array.isArray(wp.projects) ? wp.projects : (wp.project ? [wp.project] : []);
  const eventPath = descriptorEventPath(wp, filename);
  return {
    provider: providers.length === 1 ? providers[0] : null,
    path: eventPath,
    kind: descriptorDirtyKind(wp, eventPath),
    reason,
    sessionId: sessionIds.length === 1 ? sessionIds[0] : null,
    project: projects.length === 1 ? projects[0] : null,
  };
}

function markWatchDescriptorDirty(wp, reason, filename = null) {
  markProviderDataDirty(dirtyDescriptorForWatch(wp, reason, filename));
}

function addWatchFallback(wp, key, err) {
  const now = Date.now();
  if (!recursiveWatchFallbacks.has(key)) {
    const fallback = {
      wp,
      key,
      signature: null,
      lastScanAt: 0,
      lastSignatureAt: null,
      lastForcedAt: now,
      entriesScanned: 0,
      baselinePending: true,
      lastError: err?.message || null,
    };
    try {
      if (fs.existsSync(wp.path)) {
        const sample = getWatchFallbackSignature(wp, WATCH_FALLBACK_MAX_ENTRIES);
        fallback.signature = sample.signature;
        fallback.entriesScanned = sample.entriesScanned;
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

function descriptorMatchesFilename(wp, filename) {
  const filters = Array.isArray(wp.filters) ? wp.filters : (wp.filter ? [wp.filter] : []);
  if (filters.length === 0 || !filename) return true;
  const name = String(filename);
  return filters.some((filter) => name.endsWith(filter));
}

function _walkDirForSignature(root, wp, budget) {
  const stack = [{ dir: root, depth: 0 }];
  const hash = crypto.createHash('sha1');
  let entriesScanned = 0;
  let files = 0;
  let totalSize = 0;
  let truncated = false;
  let errors = 0;

  while (stack.length > 0 && entriesScanned < budget) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      errors++;
      continue;
    }

    for (const dirent of dirents) {
      if (entriesScanned >= budget) {
        truncated = true;
        break;
      }
      entriesScanned++;

      const entryPath = path.join(current.dir, dirent.name);
      let stat = null;
      try {
        stat = fs.statSync(entryPath);
      } catch {
        errors++;
      }

      if (dirent.isDirectory()) {
        hash.update(`d:${path.relative(root, entryPath)}:${Math.round(stat?.mtimeMs || 0)}\n`);
        if (wp.recursive && current.depth < WATCH_FALLBACK_MAX_DEPTH) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!dirent.isFile()) continue;
      if (!descriptorMatchesFilename(wp, dirent.name)) continue;
      files++;
      totalSize += stat?.size || 0;
      hash.update(`f:${path.relative(root, entryPath)}:${Math.round(stat?.mtimeMs || 0)}:${stat?.size || 0}\n`);
    }
  }

  if (stack.length > 0) truncated = true;
  return {
    signature: hash.digest('hex'),
    entriesScanned,
    files,
    totalSize,
    truncated,
    errors,
  };
}

function getWatchFallbackSignature(wp, budget = WATCH_FALLBACK_MAX_ENTRIES) {
  if (wp.type === 'file') {
    let signature = 'missing';
    let errors = 0;
    let entriesScanned = 0;
    try {
      const stat = fs.statSync(wp.path);
      entriesScanned = 1;
      signature = `${stat.dev}:${stat.ino}:${Math.round(stat.mtimeMs)}:${stat.size}`;
    } catch {
      errors = 1;
    }
    return { signature, entriesScanned, files: signature === 'missing' ? 0 : 1, totalSize: 0, truncated: false, errors };
  }

  try {
    const rootStat = fs.statSync(wp.path);
    const walk = _walkDirForSignature(wp.path, wp, budget);
    return {
      ...walk,
      signature: `${Math.round(rootStat.mtimeMs)}:${walk.signature}:${walk.files}:${walk.totalSize}:${walk.truncated ? 1 : 0}:${walk.errors}`,
    };
  } catch {
    return { signature: 'missing', entriesScanned: 0, files: 0, totalSize: 0, truncated: false, errors: 1 };
  }
}

function runRecursiveWatchFallbackChecks() {
  const now = Date.now();
  let budgetLeft = WATCH_FALLBACK_MAX_ENTRIES;
  for (const fallback of recursiveWatchFallbacks.values()) {
    if (activeWatchers.has(fallback.key)) {
      recursiveWatchFallbacks.delete(fallback.key);
      continue;
    }
    if (!selectedWatchDescriptors.has(fallback.key)) {
      recursiveWatchFallbacks.delete(fallback.key);
      continue;
    }
    if (now - fallback.lastScanAt < WATCH_FALLBACK_SCAN_INTERVAL_MS) continue;
    if (budgetLeft <= 0) break;
    fallback.lastScanAt = now;

    try {
      const sample = getWatchFallbackSignature(fallback.wp, budgetLeft);
      budgetLeft -= sample.entriesScanned;
      serverPerf.fallbackScans++;
      serverPerf.fallbackEntriesScanned += sample.entriesScanned;
      const maxAgeDue = now - fallback.lastForcedAt >= WATCH_FALLBACK_MAX_AGE_MS;
      const shouldMarkDirty = fallback.baselinePending
        || (fallback.signature && sample.signature !== fallback.signature)
        || maxAgeDue;
      if (shouldMarkDirty) {
        serverPerf.fallbackChanges++;
        markWatchDescriptorDirty(fallback.wp, maxAgeDue
          ? `stat-fallback-max-age:${path.basename(fallback.wp.path)}`
          : `stat-fallback:${path.basename(fallback.wp.path)}`);
        debouncedBroadcast();
      }
      if (maxAgeDue) fallback.lastForcedAt = now;
      fallback.signature = sample.signature;
      fallback.entriesScanned = sample.entriesScanned;
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
  return `${wp.type}:${wp.path}`;
}

function canonicalWatchPath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function canonicalizeWatchDescriptors(watchPaths = []) {
  const merged = new Map();
  for (const raw of watchPaths) {
    if (!raw || !['file', 'directory'].includes(raw.type) || !raw.path) continue;
    const canonicalPath = canonicalWatchPath(raw.path);
    const key = `${raw.type}:${canonicalPath}`;
    const rawFilters = [raw.filter, ...(Array.isArray(raw.filters) ? raw.filters : [])]
      .map((filter) => String(filter || ''))
      .filter(Boolean);
    const rawScopes = Array.isArray(raw.scopes) && raw.scopes.length > 0 ? raw.scopes : [raw.scope];
    const scopes = rawScopes.filter((scope) => ['active', 'recent', 'discovery', 'static'].includes(scope));
    if (scopes.length === 0) scopes.push('discovery');
    const scope = scopes.includes('active') ? 'active' : (scopes.includes('recent') ? 'recent' : scopes[0]);
    const dynamic = typeof raw.dynamic === 'boolean'
      ? raw.dynamic
      : scope === 'active' || scope === 'recent';
    const defaultPriority = scope === 'active'
      ? (raw.type === 'file' ? 0 : 1)
      : (scope === 'recent' ? (raw.type === 'file' ? 2 : 3) : 4);
    const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : defaultPriority;
    const providers = Array.isArray(raw.providers) ? raw.providers : [raw.provider];
    const rawKinds = Array.isArray(raw.kinds) ? raw.kinds : [raw.kind];
    const rawSessionIds = Array.isArray(raw.sessionIds) ? raw.sessionIds : [raw.sessionId];
    const rawProjects = Array.isArray(raw.projects) ? raw.projects : [raw.project];
    let descriptor = merged.get(key);
    if (!descriptor) {
      descriptor = {
        type: raw.type,
        path: canonicalPath,
        filters: new Set(),
        matchAll: rawFilters.length === 0,
        providers: new Set(),
        scopes: new Set(),
        kinds: new Set(),
        sessionIds: new Set(),
        projects: new Set(),
        dynamic,
        probe: Boolean(raw.probe),
        priority,
        activity: Number(raw.activity) || 0,
        recursive: false,
      };
      merged.set(key, descriptor);
    } else {
      descriptor.dynamic = descriptor.dynamic && dynamic;
      descriptor.probe = descriptor.probe || Boolean(raw.probe);
      descriptor.priority = Math.min(descriptor.priority, priority);
      descriptor.activity = Math.max(descriptor.activity, Number(raw.activity) || 0);
      if (rawFilters.length === 0) descriptor.matchAll = true;
    }
    if (!descriptor.matchAll) rawFilters.forEach((filter) => descriptor.filters.add(filter));
    providers.filter(Boolean).forEach((provider) => descriptor.providers.add(String(provider)));
    scopes.forEach((value) => descriptor.scopes.add(value));
    rawKinds.filter(Boolean).forEach((kind) => descriptor.kinds.add(String(kind)));
    rawSessionIds.filter(Boolean).forEach((sessionId) => descriptor.sessionIds.add(String(sessionId)));
    rawProjects.filter(Boolean).forEach((project) => descriptor.projects.add(String(project)));
  }

  return Array.from(merged.values()).map((descriptor) => {
    const providers = Array.from(descriptor.providers).sort();
    const scopes = Array.from(descriptor.scopes).sort();
    const kinds = Array.from(descriptor.kinds).sort();
    const sessionIds = Array.from(descriptor.sessionIds).sort();
    const projects = Array.from(descriptor.projects).sort();
    return {
      type: descriptor.type,
      path: descriptor.path,
      filters: descriptor.matchAll ? [] : Array.from(descriptor.filters).sort(),
      providers,
      provider: providers[0] || null,
      scopes,
      scope: scopes.includes('active') ? 'active' : (scopes.includes('recent') ? 'recent' : 'discovery'),
      kinds,
      kind: kinds.length === 1 ? kinds[0] : null,
      sessionIds,
      sessionId: sessionIds.length === 1 ? sessionIds[0] : null,
      projects,
      project: projects.length === 1 ? projects[0] : null,
      dynamic: descriptor.dynamic,
      probe: descriptor.probe,
      priority: descriptor.priority,
      activity: descriptor.activity,
      recursive: false,
    };
  });
}

function selectWatchDescriptors(descriptors, { includeDynamic = dynamicWatchersEnabled } = {}) {
  const stable = descriptors.filter((descriptor) => !descriptor.dynamic);
  const requestedDynamic = descriptors.filter((descriptor) => descriptor.dynamic)
    .sort((a, b) => a.priority - b.priority || b.activity - a.activity || a.path.localeCompare(b.path));
  const dynamic = includeDynamic ? requestedDynamic.slice(0, WATCH_DYNAMIC_CAP) : [];
  return {
    selected: [...stable, ...dynamic],
    stable,
    requestedDynamic,
    dynamic,
  };
}

function selectProbeDescriptors(descriptors, { includeDynamic = dynamicWatchersEnabled } = {}) {
  return descriptors
    .filter((descriptor) => descriptor.probe && (!descriptor.dynamic || includeDynamic))
    .sort((a, b) => a.priority - b.priority || b.activity - a.activity || a.path.localeCompare(b.path))
    .slice(0, WATCH_ACTIVE_PROBE_CAP);
}

function closeWatcherEntry(key) {
  const entry = activeWatchers.get(key);
  if (!entry) return;
  try { entry.watcher.close(); } catch { /* ignore */ }
  activeWatchers.delete(key);
}

function handleWatchEvent(key, eventType, filename) {
  const wp = activeWatchers.get(key)?.descriptor || selectedWatchDescriptors.get(key);
  if (!wp) return;
  const isRelevant = wp.type === 'directory' || eventType === 'change' || eventType === 'rename';
  if (!isRelevant) return;
  if (wp.type === 'directory' && !descriptorMatchesFilename(wp, filename)) return;

  if (wp.type === 'file' && eventType === 'rename') {
    closeWatcherEntry(key);
    debouncedWatchRefresh();
    scheduleWatchRetry(wp, key);
  }

  if (wp.type === 'directory' || eventType === 'rename') debouncedWatchRefresh();
  markWatchDescriptorDirty(wp, `${wp.type}:${path.basename(wp.path)}`, filename);
  debouncedBroadcast();
}

function refreshWatchPaths(initialWatchPaths = null, { sessions = null } = {}) {
  let watchPaths = initialWatchPaths;
  if (!Array.isArray(watchPaths)) {
    const sessionSnapshot = Array.isArray(sessions)
      ? sessions
      : (dynamicWatchersEnabled ? safeCollect('getAllSessions for watch paths', () => getAllSessions(ACTIVE_THRESHOLD_MS), []) : []);
    watchPaths = safeCollect('getAllWatchPaths', () => getAllWatchPaths({
      sessions: sessionSnapshot,
      activeThresholdMs: ACTIVE_THRESHOLD_MS,
    }), []);
  }
  const canonical = canonicalizeWatchDescriptors(watchPaths);
  const selection = selectWatchDescriptors(canonical);
  latestWatchDescriptors = canonical;
  selectedWatchDescriptors = new Map(selection.selected.map((descriptor) => [watchKey(descriptor), descriptor]));
  const probes = selectProbeDescriptors(canonical);
  activeProbeDescriptors = new Map(probes.map((descriptor) => [watchKey(descriptor), descriptor]));
  const nextKeys = new Set(selectedWatchDescriptors.keys());
  let added = 0;

  for (const wp of selection.selected) {
    const key = watchKey(wp);
    const existing = activeWatchers.get(key);
    if (existing) {
      existing.descriptor = wp;
      continue;
    }
    if (!fs.existsSync(wp.path)) {
      scheduleWatchRetry(wp, key);
      continue;
    }
    try {
      const watcher = fs.watch(wp.path, (eventType, filename) => handleWatchEvent(key, eventType, filename));
      watcher.on?.('error', (watchError) => {
        closeWatcherEntry(key);
        const err = watchError instanceof Error ? watchError : new Error('watcher emitted error');
        recordWatchFailure(wp, key, err, 'runtime');
        addWatchFallback(wp, key, err);
        scheduleWatchRetry(wp, key);
      });
      activeWatchers.set(key, { watcher, descriptor: wp });
      recursiveWatchFallbacks.delete(key);
      const retryTimer = watchRetryTimers.get(key);
      if (retryTimer) {
        clearTimeout(retryTimer);
        watchRetryTimers.delete(key);
      }
      added++;
    } catch (err) {
      recordWatchFailure(wp, key, err, 'setup');
      addWatchFallback(wp, key, err);
      scheduleWatchRetry(wp, key);
    }
  }

  for (const key of activeWatchers.keys()) {
    if (nextKeys.has(key)) continue;
    closeWatcherEntry(key);
  }

  for (const key of recursiveWatchFallbacks.keys()) {
    if (nextKeys.has(key)) continue;
    recursiveWatchFallbacks.delete(key);
  }
  for (const [key, timer] of watchRetryTimers) {
    if (nextKeys.has(key)) continue;
    clearTimeout(timer);
    watchRetryTimers.delete(key);
  }
  for (const key of watchProbeSignatures.keys()) {
    if (!activeProbeDescriptors.has(key)) watchProbeSignatures.delete(key);
  }

  if (added > 0 || serverPerf.activeWatchPaths !== activeWatchers.size) {
    console.log(`[Watch] ${activeWatchers.size} paths are now being watched`);
  }
  serverPerf.configuredWatchPaths = watchPaths.length;
  serverPerf.canonicalWatchPaths = canonical.length;
  serverPerf.activeWatchPaths = activeWatchers.size;
  serverPerf.stableWatchPaths = selection.stable.filter((descriptor) => activeWatchers.has(watchKey(descriptor))).length;
  serverPerf.dynamicWatchPathsRequested = selection.requestedDynamic.length;
  serverPerf.dynamicWatchPaths = selection.dynamic.filter((descriptor) => activeWatchers.has(watchKey(descriptor))).length;
  serverPerf.dynamicWatchPathsDropped = Math.max(0, selection.requestedDynamic.length - selection.dynamic.length);
  serverPerf.probeWatchPaths = probes.length;
  serverPerf.recursiveWatchFallbacks = recursiveWatchFallbacks.size;
  lastFullDiscoveryAt = Date.now();
}

function watchProbeSignature(wp) {
  try {
    const stat = fs.statSync(wp.path);
    return `${stat.dev}:${stat.ino}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function runActiveWatchProbes() {
  if (wsClients.size === 0) return false;
  const probes = Array.from(activeProbeDescriptors.entries())
    .sort(([, a], [, b]) => a.priority - b.priority || b.activity - a.activity)
    .slice(0, WATCH_ACTIVE_PROBE_CAP);
  let changed = false;
  for (const [key, wp] of probes) {
    const signature = watchProbeSignature(wp);
    const previous = watchProbeSignatures.get(key);
    watchProbeSignatures.set(key, signature);
    serverPerf.probeScans++;
    if (previous === undefined || previous === signature) continue;
    serverPerf.probeChanges++;
    changed = true;
    markWatchDescriptorDirty(wp, `active-probe:${path.basename(wp.path)}`);
    if (wp.type === 'directory' || signature === 'missing' || previous === 'missing') debouncedWatchRefresh();
  }
  serverPerf.probeWatchPaths = probes.length;
  return changed;
}

function onFirstWebSocketClient() {
  if (dynamicWatchRetireTimer) {
    clearTimeout(dynamicWatchRetireTimer);
    dynamicWatchRetireTimer = null;
  }
  if (dynamicWatchersEnabled) return;
  dynamicWatchersEnabled = true;
  refreshWatchPaths();
}

function onLastWebSocketClient() {
  if (shutdownStarted) return;
  if (dynamicWatchRetireTimer || !dynamicWatchersEnabled) return;
  dynamicWatchRetireTimer = setTimeout(() => {
    dynamicWatchRetireTimer = null;
    if (wsClients.size > 0) return;
    dynamicWatchersEnabled = false;
    refreshWatchPaths(latestWatchDescriptors);
  }, WATCH_ZERO_CLIENT_GRACE_MS);
}

function watcherTopologySnapshot() {
  return {
    installed: activeWatchers.size,
    stableInstalled: serverPerf.stableWatchPaths,
    dynamicInstalled: serverPerf.dynamicWatchPaths,
    dynamicEnabled: dynamicWatchersEnabled,
    probes: activeProbeDescriptors.size,
  };
}

function millisecondsFromNanoseconds(value) {
  return Number.isFinite(value) ? Math.round((value / 1e6) * 1000) / 1000 : null;
}

function sampleLinuxWatcherCount(now = Date.now()) {
  if (process.platform !== 'linux') return;
  if (now - lastLinuxWatchSampleAt < LINUX_WATCH_SAMPLE_INTERVAL_MS) return;
  lastLinuxWatchSampleAt = now;

  let inotifyFds = 0;
  let watchEntries = 0;
  let error = null;
  try {
    const fdInfoDir = '/proc/self/fdinfo';
    for (const fd of fs.readdirSync(fdInfoDir)) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(fdInfoDir, fd), 'utf8');
      } catch {
        continue;
      }
      const entries = content.match(/^inotify wd:/gm)?.length || 0;
      if (entries > 0) inotifyFds++;
      watchEntries += entries;
    }
  } catch (err) {
    error = err?.message || 'Unable to inspect /proc watcher state';
  }
  perfDiagnostics.linuxWatchers = {
    supported: true,
    sampledAt: now,
    inotifyFds,
    watchEntries,
    error,
  };
}

function sampleRuntimePerf() {
  const now = Date.now();
  const memory = process.memoryUsage();
  perfDiagnostics.memory = {
    sampledAt: now,
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };

  const currentUtilization = performance.eventLoopUtilization();
  const utilizationDelta = performance.eventLoopUtilization(currentUtilization, lastEventLoopUtilization);
  lastEventLoopUtilization = currentUtilization;
  perfDiagnostics.eventLoop = {
    sampledAt: now,
    windowMs: PERF_SAMPLE_INTERVAL_MS,
    utilization: Math.round((utilizationDelta.utilization || 0) * 10_000) / 10_000,
    delayMs: {
      min: millisecondsFromNanoseconds(eventLoopDelayMonitor.min),
      max: millisecondsFromNanoseconds(eventLoopDelayMonitor.max),
      mean: millisecondsFromNanoseconds(eventLoopDelayMonitor.mean),
      p50: millisecondsFromNanoseconds(eventLoopDelayMonitor.percentile(50)),
      p95: millisecondsFromNanoseconds(eventLoopDelayMonitor.percentile(95)),
      p99: millisecondsFromNanoseconds(eventLoopDelayMonitor.percentile(99)),
    },
  };
  eventLoopDelayMonitor.reset();

  const git = getGitEnrichmentPerfStats();
  if (lastGitPerfSample) {
    const elapsedSeconds = Math.max(0.001, (now - lastGitPerfSample.at) / 1000);
    perfDiagnostics.gitRate = {
      sampledAt: now,
      windowMs: now - lastGitPerfSample.at,
      commandsPerSecond: Math.round(((git.gitCommandCount - lastGitPerfSample.gitCommandCount) / elapsedSeconds) * 1000) / 1000,
      commandTimeMsPerSecond: Math.round(((git.gitCommandTimeMs - lastGitPerfSample.gitCommandTimeMs) / elapsedSeconds) * 1000) / 1000,
      cacheHitsPerSecond: Math.round(((git.cacheHits - lastGitPerfSample.cacheHits) / elapsedSeconds) * 1000) / 1000,
    };
  }
  lastGitPerfSample = {
    at: now,
    gitCommandCount: Number(git.gitCommandCount) || 0,
    gitCommandTimeMs: Number(git.gitCommandTimeMs) || 0,
    cacheHits: Number(git.cacheHits) || 0,
  };
  sampleLinuxWatcherCount(now);
}

function startRuntimePerfSampling() {
  if (perfSampleTimer) return;
  eventLoopDelayMonitor.enable();
  sampleRuntimePerf();
  perfSampleTimer = setInterval(sampleRuntimePerf, PERF_SAMPLE_INTERVAL_MS);
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
  return Array.from(lastCanonicalActiveProjects).slice(0, GIT_STATE_MAX_PROJECTS);
}

function scanActiveProjectGitState() {
  if (wsClients.size === 0) return;

  const projects = activeGitProjects();
  const activeProjects = new Set(projects);
  for (const project of activeProjectGitState.keys()) {
    if (!activeProjects.has(project)) activeProjectGitState.delete(project);
  }

  const changedProjects = [];
  for (const project of projects) {
    const signature = projectGitStateSignature(project);
    if (!signature) continue;
    const previous = activeProjectGitState.get(project);
    activeProjectGitState.set(project, signature);
    if (previous && previous !== signature) changedProjects.push(project);
  }

  for (const project of changedProjects) {
    markProviderDataDirty({
      provider: null,
      path: project,
      kind: 'git',
      reason: 'git-state',
      project,
    });
  }
}

function reconcileWatchTopology() {
  const now = Date.now();
  let sessions = [];
  if (wsClients.size > 0) {
    markProviderDataDirty({ kind: 'reconcile', reason: 'max-age-reconciliation' });
    sessions = safeCollect('watch reconciliation', () => getAllSessions(ACTIVE_THRESHOLD_MS, { force: true }), []);
    updateCanonicalActiveProjects(sessions);
  }
  refreshWatchPaths(null, { sessions });
  lastReconciliationAt = now;
  serverPerf.reconciliations++;
}

function startFileWatcher(initialWatchPaths = null) {
  refreshWatchPaths(initialWatchPaths);
  lastReconciliationAt = Date.now();
  if (watcherSchedulerTimer) return;
  watcherSchedulerTimer = setInterval(() => {
    const probeChanged = runActiveWatchProbes();
    runRecursiveWatchFallbackChecks();
    scanActiveProjectGitState();
    const reconciliationDue = Date.now() - lastReconciliationAt >= WATCH_RECONCILIATION_INTERVAL_MS;
    if (reconciliationDue) reconcileWatchTopology();
    if (wsClients.size > 0) {
      broadcastUpdate({ reason: reconciliationDue ? 'reconciliation' : (probeChanged ? 'active-probe' : 'interval') });
    }
  }, BROADCAST_POLL_INTERVAL);
  console.log('[Watch] Started bounded 2-second active probe');
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

function startServer() {
  if (server.listening) return server;
  server.listen(PORT, () => {
    console.log(ASCII_LOGO);
    console.log(`  Server running: http://localhost:${PORT}`);
    console.log('');

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

    startRuntimePerfSampling();
    startupTimer = setTimeout(() => {
      startupTimer = null;
      const startupStats = printStartupStats(providers);
      usageQuota.init();
      startFileWatcher(startupStats.watchPaths);
      startWebSocketHeartbeat();
    }, STARTUP_BOOTSTRAP_DELAY_MS);
  });
  return server;
}

// ─── Error handling ────────────────────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
});

let shutdownStarted = false;

function clearRuntimeTimer(timer) {
  if (timer) clearTimeout(timer);
}

function shutdownRuntime({ reason = 'shutdown', exitCode = 0, exitProcess = true } = {}) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\nShutting down server (${reason})...`);

  clearRuntimeTimer(startupTimer);
  clearRuntimeTimer(watchDebounce);
  clearRuntimeTimer(watchRefreshDebounce);
  clearRuntimeTimer(dynamicWatchRetireTimer);
  clearRuntimeTimer(heartbeatTimer);
  clearRuntimeTimer(watcherSchedulerTimer);
  clearRuntimeTimer(perfSampleTimer);
  startupTimer = null;
  watchDebounce = null;
  watchRefreshDebounce = null;
  dynamicWatchRetireTimer = null;
  heartbeatTimer = null;
  watcherSchedulerTimer = null;
  perfSampleTimer = null;

  for (const timer of watchRetryTimers.values()) clearTimeout(timer);
  watchRetryTimers.clear();
  for (const key of Array.from(activeWatchers.keys())) closeWatcherEntry(key);
  recursiveWatchFallbacks.clear();
  watchProbeSignatures.clear();
  selectedWatchDescriptors.clear();
  activeProbeDescriptors.clear();
  setAdapterDataReadyCallback(null);
  for (const adapter of adapters) {
    try {
      if (typeof adapter.shutdown === 'function') adapter.shutdown();
      else if (typeof adapter.dispose === 'function') adapter.dispose();
    } catch (err) {
      console.warn(`[Shutdown] ${adapter.provider || adapter.name || 'adapter'} cleanup failed:`, err?.message || err);
    }
  }
  eventLoopDelayMonitor.disable();

  for (const socket of Array.from(wsClients)) {
    closeWebSocket(socket, null);
    try { socket.destroy(); } catch { /* ignore */ }
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    console.log('Server shutdown complete');
    if (exitProcess) process.exit(exitCode);
  };
  const forceTimer = setTimeout(finish, 2000);
  forceTimer.unref?.();
  if (server.listening) {
    server.close(() => {
      clearTimeout(forceTimer);
      finish();
    });
  } else {
    clearTimeout(forceTimer);
    finish();
  }
}

function installProcessHandlers() {
  process.once('uncaughtException', (err) => {
    console.error('Unhandled exception:', err?.stack || err?.message || err);
    shutdownRuntime({ reason: 'uncaughtException', exitCode: 1 });
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
  process.once('SIGINT', () => shutdownRuntime({ reason: 'SIGINT' }));
  process.once('SIGTERM', () => shutdownRuntime({ reason: 'SIGTERM' }));
}

if (require.main === module) {
  installProcessHandlers();
  startServer();
}

module.exports = {
  startServer,
  shutdownRuntime,
  _watcherTest: {
    cacheControlFor,
    canonicalizeWatchDescriptors,
    dirtyDescriptorForWatch,
    getWatchFallbackSignature,
    installProcessHandlers,
    onFirstWebSocketClient,
    onLastWebSocketClient,
    refreshWatchPaths,
    selectProbeDescriptors,
    selectWatchDescriptors,
    watcherTopologySnapshot,
    constants: {
      WATCH_DYNAMIC_CAP,
      WATCH_ACTIVE_PROBE_CAP,
      WATCH_FALLBACK_MAX_ENTRIES,
      WATCH_FALLBACK_MAX_AGE_MS,
    },
  },
};
