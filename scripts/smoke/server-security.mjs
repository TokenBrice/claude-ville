import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDir } from '../tests/support/tmp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpHome = makeTempDir('claudeville-server-security-');
// SV-10 — a CLI-free PATH, as `support/isolated-server.mjs` uses: a real
// `claude` (or `git`) found under the temp HOME writes state there and can
// outlive cleanup.
const binDir = path.join(tmpHome, 'bin');
fs.mkdirSync(binDir, { recursive: true });
let child = null;
let childOutput = '';
let weatherAttempts = 0;

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      reservation.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

function request(port, {
  method = 'GET',
  pathname = '/api/providers',
  host = `localhost:${port}`,
  origin,
  body = null,
  headers: extraHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, ...extraHeaders };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(port);
      if (response.statusCode === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not become ready');
}

function websocketUpgrade(port, {
  pathname = '/ws',
  host = `localhost:${port}`,
  origin = `http://localhost:${port}`,
  version = '13',
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket upgrade timed out'));
    }, 2000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = error => finish(error);
    socket.once('error', onError);
    socket.on('data', function onData(chunk) {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      socket.off('data', onData);
      const header = received.subarray(0, boundary).toString('latin1');
      const statusCode = Number(header.match(/^HTTP\/1\.1\s+(\d+)/)?.[1] || 0);
      finish(null, {
        socket,
        statusCode,
        remainder: received.subarray(boundary + 4),
      });
    });
    socket.once('connect', () => {
      const headers = [
        `GET ${pathname} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${version}`,
      ];
      if (origin !== null) headers.push(`Origin: ${origin}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
  });
}

function waitForCloseCode(socket, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let received = initial;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket close frame timed out'));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const consume = () => {
      let offset = 0;
      while (received.length - offset >= 2) {
        const first = received[offset];
        let length = received[offset + 1] & 0x7f;
        let headerBytes = 2;
        if (length === 126) {
          if (received.length - offset < 4) return;
          length = received.readUInt16BE(offset + 2);
          headerBytes = 4;
        } else if (length === 127) {
          if (received.length - offset < 10) return;
          length = Number(received.readBigUInt64BE(offset + 2));
          headerBytes = 10;
        }
        if (received.length - offset < headerBytes + length) return;
        const payload = received.subarray(offset + headerBytes, offset + headerBytes + length);
        if ((first & 0x0f) === 0x8) {
          cleanup();
          resolve(payload.length >= 2 ? payload.readUInt16BE(0) : null);
          return;
        }
        offset += headerBytes + length;
      }
      received = received.subarray(offset);
    };
    const onData = chunk => {
      received = Buffer.concat([received, chunk]);
      consume();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    consume();
  });
}

function waitForJsonFrame(socket, predicate, initial = Buffer.alloc(0), timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let received = initial;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket JSON frame timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const consume = () => {
      let offset = 0;
      while (received.length - offset >= 2) {
        const first = received[offset];
        let length = received[offset + 1] & 0x7f;
        let headerBytes = 2;
        if (length === 126) {
          if (received.length - offset < 4) return;
          length = received.readUInt16BE(offset + 2);
          headerBytes = 4;
        } else if (length === 127) {
          if (received.length - offset < 10) return;
          length = Number(received.readBigUInt64BE(offset + 2));
          headerBytes = 10;
        }
        if (received.length - offset < headerBytes + length) return;
        const payload = received.subarray(offset + headerBytes, offset + headerBytes + length);
        offset += headerBytes + length;
        if ((first & 0x0f) === 0x1) {
          try {
            const parsed = JSON.parse(payload.toString('utf8'));
            if (predicate(parsed)) {
              const remainder = received.subarray(offset);
              cleanup();
              resolve({ message: parsed, remainder });
              return;
            }
          } catch {
            // ignore non-JSON frame
          }
        }
      }
      received = received.subarray(offset);
    };
    const onData = chunk => {
      received = Buffer.concat([received, chunk]);
      consume();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    consume();
  });
}

function createMaskedClientFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function waitForExit(processHandle, timeoutMs = 5000) {
  if (processHandle.exitCode !== null) return Promise.resolve(processHandle.exitCode);
  return Promise.race([
    new Promise(resolve => processHandle.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('server did not exit after SIGTERM')),
      timeoutMs,
    )),
  ]);
}

const port = await reserveEphemeralPort();
const bridgeToken = 'hobotnica-bridge-secret-token-0123456789';
const bridgeSecretsDir = path.join(tmpHome, '.local', 'share', 'hobotnica', 'userdata', 'secrets');
const bridgeTokenFile = path.join(bridgeSecretsDir, 'claudeville-bridge-token');
fs.mkdirSync(bridgeSecretsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(bridgeTokenFile, `${bridgeToken}\n`, { mode: 0o600 });
fs.chmodSync(bridgeTokenFile, 0o600);

let mockHobotnicaServer = null;
let mockHobotnicaPort = 0;
const receivedCockpitFocuses = [];
let mockFocusBehavior = { statusCode: 200, body: { ok: true, delivered: true }, delayMs: 0 };

try {
  mockHobotnicaServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedCockpitFocuses.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      const current = { ...mockFocusBehavior };
      const respond = () => {
        res.writeHead(current.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(current.body));
      };
      if (current.delayMs > 0) setTimeout(respond, current.delayMs);
      else respond();
    });
  });
  await new Promise((resolve, reject) => {
    mockHobotnicaServer.once('error', reject);
    mockHobotnicaServer.listen(0, '127.0.0.1', () => {
      mockHobotnicaPort = mockHobotnicaServer.address().port;
      resolve();
    });
  });

  const bootstrap = `
    const http = require('http');
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 4000) args[0] = Number(process.env.CLAUDEVILLE_SMOKE_PORT);
      return originalListen.apply(this, args);
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (url.hostname !== 'api.open-meteo.com') return originalFetch(url, options);
      process.send?.('offline-weather-attempt');
      throw new Error('Network unavailable');
    };
    const runtime = require(${JSON.stringify(path.join(repoRoot, 'claudeville', 'server.js'))});
    process.once('SIGTERM', () => runtime.shutdownRuntime({ reason: 'SIGTERM' }));
    const instance = runtime.startServer();
    instance.once('listening', () => process.send?.(instance.address()));
  `;
  const childEnv = {
    ...process.env,
    HOME: tmpHome,
    PATH: binDir,
    CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1',
    CLAUDEVILLE_INGEST_TOKEN: 'security-smoke-token',
    CLAUDEVILLE_HOBOTNICA_PORT: String(mockHobotnicaPort),
    CLAUDEVILLE_SMOKE_PORT: String(port),
    TZ: 'Europe/London',
  };
  delete childEnv.CLAUDEVILLE_HOBOTNICA_TOKEN_FILE;
  delete childEnv.HOBOTNICA_HOME;
  child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: tmpHome,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', message => {
    if (message === 'offline-weather-attempt') weatherAttempts++;
  });
  const listeningAddress = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server address was not reported')), 2000);
    child.once('message', address => {
      clearTimeout(timer);
      resolve(address);
    });
  });
  const collectOutput = chunk => {
    childOutput = `${childOutput}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);

  await waitForServer(port);
  assert.equal((await listeningAddress).address, '127.0.0.1');

  const accepted = await request(port, { origin: `http://localhost:${port}` });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers['access-control-allow-origin'], undefined);

  const noOrigin = await request(port);
  assert.equal(noOrigin.statusCode, 200, 'origin-less CLI requests must remain supported');

  const weatherPath = '/api/weather?latitude=1&longitude=2&mode=real-sky';
  const weatherHeaders = { 'X-ClaudeVille-Weather': 'real-sky' };
  const optedOut = await request(port, { pathname: weatherPath });
  assert.equal(optedOut.statusCode, 200);
  assert.equal(optedOut.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(optedOut.body), { fetchedAt: null, hourly: null, refreshAt: null });
  assert.equal(weatherAttempts, 0, 'weather requires explicit opt-in');

  for (const pathname of [
    '/api/providers',
    '/api/sessions',
    '/api/session-detail?provider=claude&sessionId=secret&project=%2Ftmp',
    '/api/tasks',
    '/api/usage',
    weatherPath,
  ]) {
    const hostileOrigin = await request(port, {
      pathname,
      origin: 'https://attacker.example',
      headers: pathname === weatherPath ? weatherHeaders : {},
    });
    assert.equal(hostileOrigin.statusCode, 403, `${pathname} accepted a hostile origin`);
    assert.doesNotMatch(hostileOrigin.body, /providers|sessions|homeDir|subscription|quota/);
    assert.equal(hostileOrigin.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(weatherAttempts, 0, 'a hostile origin cannot opt in');
  const offline = await request(port, { pathname: weatherPath, headers: weatherHeaders });
  assert.equal(offline.statusCode, 200);
  assert.equal(JSON.parse(offline.body).hourly, null, 'weather is optional offline');
  assert.equal(weatherAttempts, 1, 'opted-in weather tries the provider');
  await request(port, { pathname: weatherPath, headers: weatherHeaders });
  assert.equal(weatherAttempts, 1, 'a failed forecast is throttled');

  const hostileHost = await request(port, { host: 'attacker.example' });
  assert.equal(hostileHost.statusCode, 421);

  const preflight = await request(port, {
    method: 'OPTIONS',
    origin: `http://localhost:${port}`,
  });
  assert.equal(preflight.statusCode, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);

  const invalidJson = await request(port, {
    method: 'POST',
    pathname: '/api/session-details',
    body: '{',
  });
  assert.equal(invalidJson.statusCode, 400);

  const oversizedJson = await request(port, {
    method: 'POST',
    pathname: '/api/session-details',
    body: JSON.stringify({ value: 'x'.repeat(256 * 1024) }),
  });
  assert.equal(oversizedJson.statusCode, 413);

  const hookBody = JSON.stringify({
    provider: 'codex',
    sessionId: 'security-smoke',
    cwd: tmpHome,
    ts: Date.now(),
    kind: 'PermissionRequest',
    tool: 'Bash',
    input: { command: 'npm test' },
  });
  const ingestHeaders = { 'X-ClaudeVille-Ingest-Token': 'security-smoke-token' };

  const missingHookToken = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: hookBody,
  });
  assert.equal(missingHookToken.statusCode, 401);

  const acceptedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: hookBody,
    headers: ingestHeaders,
  });
  assert.equal(acceptedHook.statusCode, 202);

  const hookWrongMethod = await request(port, {
    method: 'GET',
    pathname: '/api/ingest/hook',
  });
  assert.equal(hookWrongMethod.statusCode, 405);

  const hookHostileHost = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    host: 'attacker.example',
    body: hookBody,
  });
  assert.equal(hookHostileHost.statusCode, 421);

  const hookHostileOrigin = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    origin: 'https://attacker.example',
    body: hookBody,
  });
  assert.equal(hookHostileOrigin.statusCode, 403);

  const malformedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: '{',
    headers: ingestHeaders,
  });
  assert.equal(malformedHook.statusCode, 400);
  assert.doesNotMatch(malformedHook.body, /\bat\s+\S+|stack|SyntaxError/i);

  const oversizedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: JSON.stringify({ value: 'x'.repeat(256 * 1024) }),
    headers: ingestHeaders,
  });
  assert.equal(oversizedHook.statusCode, 413);
  assert.doesNotMatch(oversizedHook.body, /\bat\s+\S+|stack|SyntaxError/i);

  const unknownHookProvider = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: JSON.stringify({ provider: 'unknown', sessionId: 'x', kind: 'SessionStart' }),
    headers: ingestHeaders,
  });
  assert.equal(unknownHookProvider.statusCode, 400);

  // ─── Hobotnica Bridge endpoints: POST /api/ingest/hobotnica & POST /api/focus ───
  const bearerHeaders = { Authorization: `Bearer ${bridgeToken}` };
  const customTokenHeaders = { 'X-Hobotnica-Bridge-Token': bridgeToken };
  const hobotnicaSnapshotBody = JSON.stringify({
    protocol: 'hobotnica-telemetry.v1',
    type: 'snapshot',
    instanceId: 'sec-inst-dev',
    bootId: 'boot-sec-1',
    seq: 1,
    mode: 'dev',
    snapshotId: 'snap-sec-1',
    chunkIndex: 0,
    totalChunks: 1,
    serverTimeMs: Date.now(),
    agents: [
      {
        key: 'agent-sec-1',
        subagentId: 'sub-sec-1',
        owningThreadId: 'th-sec-1',
        parentThreadId: null,
        childThreadId: null,
        origin: 'root',
        waveId: 'wave-sec',
        teamName: null,
        supersedes: null,
        role: 'worker',
        title: 'Security GLM',
        providerDriver: 'acp-registry',
        providerInstanceId: 'glm-agent',
        model: 'glm-5.4',
        nativeSessionId: null,
        cwd: tmpHome,
        projectName: 'smoke',
        turnState: 'working',
        phase: 'thinking',
        activeToolName: null,
        currentActivityLabel: 'Checking auth',
        latestSnippet: null,
        workingSet: [],
        planProgress: null,
        tokenUsage: null,
        pendingActions: [],
        waitAudience: null,
        startedAtMs: Date.now() - 1000,
        updatedAtMs: Date.now(),
        completedAtMs: null,
      },
    ],
  });
  const focusBody = JSON.stringify({
    threadId: 'th-sec-1',
    subagentId: 'sub-sec-1',
    provider: 'zai',
  });

  for (const [pathname, validBody] of [
    ['/api/ingest/hobotnica', hobotnicaSnapshotBody],
    ['/api/focus', focusBody],
  ]) {
    // Missing and wrong token -> 401
    const missingAuth = await request(port, { method: 'POST', pathname, body: validBody });
    assert.equal(missingAuth.statusCode, 401, `${pathname} must reject missing token`);

    const wrongAuth = await request(port, {
      method: 'POST',
      pathname,
      body: validBody,
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    assert.equal(wrongAuth.statusCode, 401, `${pathname} must reject wrong token`);

    // Hostile Host -> 421, hostile Origin -> 403
    const hostileHostRes = await request(port, {
      method: 'POST',
      pathname,
      host: 'attacker.example',
      body: validBody,
      headers: bearerHeaders,
    });
    assert.equal(hostileHostRes.statusCode, 421, `${pathname} must reject non-loopback Host`);

    const hostileOriginRes = await request(port, {
      method: 'POST',
      pathname,
      origin: 'https://attacker.example',
      body: validBody,
      headers: bearerHeaders,
    });
    assert.equal(hostileOriginRes.statusCode, 403, `${pathname} must reject cross-origin Origin`);

    // Wrong HTTP method -> 405
    const wrongMethod = await request(port, { method: 'GET', pathname });
    assert.equal(wrongMethod.statusCode, 405, `${pathname} must reject GET with 405`);
    const optionsMethod = await request(port, { method: 'OPTIONS', pathname });
    assert.equal(optionsMethod.statusCode, 405, `${pathname} must reject OPTIONS with 405`);

    // Malformed JSON -> 400 (no stack), Invalid schema -> 400, Oversized -> 413
    const malformed = await request(port, {
      method: 'POST',
      pathname,
      body: '{',
      headers: bearerHeaders,
    });
    assert.equal(malformed.statusCode, 400, `${pathname} must reject malformed JSON`);
    assert.doesNotMatch(malformed.body, /\bat\s+\S+|stack|SyntaxError/i);

    const invalidSchema = await request(port, {
      method: 'POST',
      pathname,
      body: JSON.stringify({}),
      headers: bearerHeaders,
    });
    assert.equal(invalidSchema.statusCode, 400, `${pathname} must reject invalid schema`);
    assert.doesNotMatch(invalidSchema.body, /\bat\s+\S+|stack|SyntaxError/i);

    const oversized = await request(port, {
      method: 'POST',
      pathname,
      body: JSON.stringify({ pad: 'x'.repeat(256 * 1024) }),
      headers: bearerHeaders,
    });
    assert.equal(oversized.statusCode, 413, `${pathname} must reject oversized body`);
    assert.doesNotMatch(oversized.body, /\bat\s+\S+|stack|SyntaxError/i);
  }

  // Fail-closed token file validation: 0644 loose mode, symlink, and missing file -> 401
  fs.chmodSync(bridgeTokenFile, 0o644);
  for (const [pathname, validBody] of [
    ['/api/ingest/hobotnica', hobotnicaSnapshotBody],
    ['/api/focus', focusBody],
  ]) {
    const looseModeRes = await request(port, {
      method: 'POST',
      pathname,
      body: validBody,
      headers: bearerHeaders,
    });
    assert.equal(looseModeRes.statusCode, 401, `${pathname} must fail closed on 0644 token file`);
  }

  const realTokenCopy = path.join(bridgeSecretsDir, 'real-token');
  fs.writeFileSync(realTokenCopy, `${bridgeToken}\n`, { mode: 0o600 });
  fs.chmodSync(realTokenCopy, 0o600);
  fs.unlinkSync(bridgeTokenFile);
  fs.symlinkSync(realTokenCopy, bridgeTokenFile);
  const symlinkRes = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hobotnica',
    body: hobotnicaSnapshotBody,
    headers: bearerHeaders,
  });
  assert.equal(symlinkRes.statusCode, 401, 'symlink bridge token file must fail closed');

  fs.unlinkSync(bridgeTokenFile);
  const missingFileRes = await request(port, {
    method: 'POST',
    pathname: '/api/focus',
    body: focusBody,
    headers: bearerHeaders,
  });
  assert.equal(missingFileRes.statusCode, 401, 'missing bridge token file must fail closed');

  // Symlinked secrets parent directory must also fail closed
  const realSecretsDir = path.join(tmpHome, 'real-secrets-dir');
  fs.mkdirSync(realSecretsDir, { recursive: true, mode: 0o700 });
  const realSecretsToken = path.join(realSecretsDir, 'claudeville-bridge-token');
  fs.writeFileSync(realSecretsToken, `${bridgeToken}\n`, { mode: 0o600 });
  fs.chmodSync(realSecretsToken, 0o600);
  fs.rmSync(bridgeSecretsDir, { recursive: true, force: true });
  fs.symlinkSync(realSecretsDir, bridgeSecretsDir);
  const symlinkParentRes = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hobotnica',
    body: hobotnicaSnapshotBody,
    headers: bearerHeaders,
  });
  assert.equal(symlinkParentRes.statusCode, 401, 'symlinked secrets parent dir must fail closed');
  fs.unlinkSync(bridgeSecretsDir);
  fs.mkdirSync(bridgeSecretsDir, { recursive: true, mode: 0o700 });

  // Restore valid 0600 regular token file and test 200 paths + WS focus & focus-external relay
  fs.writeFileSync(bridgeTokenFile, `${bridgeToken}\n`, { mode: 0o600 });
  fs.chmodSync(bridgeTokenFile, 0o600);

  const acceptedSnapshot = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hobotnica',
    body: hobotnicaSnapshotBody,
    headers: bearerHeaders,
  });
  assert.equal(acceptedSnapshot.statusCode, 200);
  const snapshotAck = JSON.parse(acceptedSnapshot.body);
  assert.equal(snapshotAck.ok, true);
  assert.match(snapshotAck.claudevilleBootId, /^[0-9a-f]{16}$/);
  assert.equal(snapshotAck.wsClients, 0);

  const acceptedHeartbeat = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hobotnica',
    body: JSON.stringify({
      protocol: 'hobotnica-telemetry.v1',
      type: 'heartbeat',
      instanceId: 'sec-inst-dev',
      bootId: 'boot-sec-1',
      seq: 2,
      mode: 'dev',
      serverTimeMs: Date.now(),
      activeCount: 1,
    }),
    headers: customTokenHeaders,
  });
  assert.equal(acceptedHeartbeat.statusCode, 200);
  assert.equal(JSON.parse(acceptedHeartbeat.body).ok, true);

  // Connect WS client to verify outbound `focus` frame & inbound `focus-external` relay
  const focusSocket = await websocketUpgrade(port);
  assert.equal(focusSocket.statusCode, 101);
  const initFrame = await waitForJsonFrame(
    focusSocket.socket,
    msg => msg.type === 'init',
    focusSocket.remainder,
  );
  assert.equal(initFrame.message.type, 'init');

  const focusFramePromise = waitForJsonFrame(
    focusSocket.socket,
    msg => msg.type === 'focus',
    initFrame.remainder,
  );
  const focusRes = await request(port, {
    method: 'POST',
    pathname: '/api/focus',
    body: focusBody,
    headers: bearerHeaders,
  });
  assert.equal(focusRes.statusCode, 200);
  const focusAck = JSON.parse(focusRes.body);
  assert.equal(focusAck.ok, true);
  assert.equal(focusAck.focused, true);
  assert.equal(focusAck.sessionId, 'zai-hbt-th-sec-1');
  assert.equal(focusAck.clients, 1);

  const focusFrame = await focusFramePromise;
  assert.equal(focusFrame.message.type, 'focus');
  assert.equal(focusFrame.message.sessionId, 'zai-hbt-th-sec-1');

  const externalResultPromise = waitForJsonFrame(
    focusSocket.socket,
    msg => msg.type === 'focus-external-result',
    focusFrame.remainder,
  );
  focusSocket.socket.write(createMaskedClientFrame(JSON.stringify({
    type: 'focus-external',
    threadId: 'th-sec-1',
    subagentId: 'sub-sec-1',
    childThreadId: 'th-child-1',
  })));
  const externalResult = await externalResultPromise;
  assert.equal(externalResult.message.ok, true);
  assert.equal(externalResult.message.delivered, true);
  assert.equal(externalResult.message.statusCode, 200);
  assert.equal(receivedCockpitFocuses.length, 1);
  assert.equal(receivedCockpitFocuses[0].method, 'POST');
  assert.equal(receivedCockpitFocuses[0].url, '/api/cockpit/focus');
  assert.equal(receivedCockpitFocuses[0].authorization, `Bearer ${bridgeToken}`);
  assert.deepEqual(receivedCockpitFocuses[0].body, {
    threadId: 'th-sec-1',
    subagentId: 'sub-sec-1',
    childThreadId: 'th-child-1',
  });

  // Immediate second focus-external within 500ms must be rate-limited
  const rateLimitedPromise = waitForJsonFrame(
    focusSocket.socket,
    msg => msg.type === 'focus-external-result',
    externalResult.remainder,
  );
  focusSocket.socket.write(createMaskedClientFrame(JSON.stringify({
    type: 'focus-external',
    threadId: 'th-sec-1',
  })));
  const rateLimitedResult = await rateLimitedPromise;
  assert.equal(rateLimitedResult.message.ok, false);
  assert.equal(rateLimitedResult.message.reason, 'rate_limited');
  assert.equal(receivedCockpitFocuses.length, 1, 'rate-limited request must not reach Hobotnica');

  // After 500ms cooldown, Hobotnica 202 { delivered: false } must return ok: false, reason: no_cockpit
  await new Promise(resolve => setTimeout(resolve, 550));
  mockFocusBehavior = { statusCode: 202, body: { ok: true, delivered: false }, delayMs: 0 };
  const noCockpitPromise = waitForJsonFrame(
    focusSocket.socket,
    msg => msg.type === 'focus-external-result',
    rateLimitedResult.remainder,
  );
  focusSocket.socket.write(createMaskedClientFrame(JSON.stringify({
    type: 'focus-external',
    threadId: 'th-sec-1',
  })));
  const noCockpitResult = await noCockpitPromise;
  assert.equal(noCockpitResult.message.ok, false);
  assert.equal(noCockpitResult.message.delivered, false);
  assert.equal(noCockpitResult.message.statusCode, 202);
  assert.equal(noCockpitResult.message.reason, 'no_cockpit');
  assert.equal(receivedCockpitFocuses.length, 2);
  focusSocket.socket.destroy();

  // Single-in-flight guard: overlapping focus-external on one socket replies `busy`
  mockFocusBehavior = { statusCode: 200, body: { ok: true, delivered: true }, delayMs: 120 };
  const busySocket = await websocketUpgrade(port);
  assert.equal(busySocket.statusCode, 101);
  const busyInit = await waitForJsonFrame(
    busySocket.socket,
    msg => msg.type === 'init',
    busySocket.remainder,
  );
  const firstBusyReplyPromise = waitForJsonFrame(
    busySocket.socket,
    msg => msg.type === 'focus-external-result',
    busyInit.remainder,
  );
  busySocket.socket.write(createMaskedClientFrame(JSON.stringify({
    type: 'focus-external',
    threadId: 'th-sec-1',
  })));
  busySocket.socket.write(createMaskedClientFrame(JSON.stringify({
    type: 'focus-external',
    threadId: 'th-sec-1',
  })));
  const firstBusyReply = await firstBusyReplyPromise;
  assert.equal(firstBusyReply.message.ok, false);
  assert.equal(firstBusyReply.message.reason, 'busy');
  const secondBusyReply = await waitForJsonFrame(
    busySocket.socket,
    msg => msg.type === 'focus-external-result',
    firstBusyReply.remainder,
  );
  assert.equal(secondBusyReply.message.ok, true);
  assert.equal(receivedCockpitFocuses.length, 3, 'in-flight rejected request must not reach Hobotnica');
  busySocket.socket.destroy();
  mockFocusBehavior = { statusCode: 200, body: { ok: true, delivered: true }, delayMs: 0 };

  const hostileSocket = await websocketUpgrade(port, { origin: 'https://attacker.example' });
  assert.equal(hostileSocket.statusCode, 403);
  hostileSocket.socket.destroy();

  const missingOriginSocket = await websocketUpgrade(port, { origin: null });
  assert.equal(missingOriginSocket.statusCode, 403);
  missingOriginSocket.socket.destroy();

  const wrongPathSocket = await websocketUpgrade(port, { pathname: '/' });
  assert.equal(wrongPathSocket.statusCode, 404);
  wrongPathSocket.socket.destroy();

  const wrongVersionSocket = await websocketUpgrade(port, { version: '12' });
  assert.equal(wrongVersionSocket.statusCode, 400);
  wrongVersionSocket.socket.destroy();

  const validSocket = await websocketUpgrade(port);
  assert.equal(validSocket.statusCode, 101);
  validSocket.socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.equal(
    await waitForCloseCode(validSocket.socket, validSocket.remainder),
    1002,
    'unmasked client frames must close with protocol error',
  );
  validSocket.socket.destroy();

  console.log('server security smoke passed');
} catch (error) {
  if (childOutput) process.stderr.write(`${childOutput}\n`);
  throw error;
} finally {
  if (mockHobotnicaServer) {
    await new Promise(resolve => mockHobotnicaServer.close(resolve)).catch(() => {});
  }
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await waitForExit(child).catch(() => {});
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
