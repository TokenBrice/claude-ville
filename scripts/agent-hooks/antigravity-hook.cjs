#!/usr/bin/env node

// Optional read-only observability forwarder for Google Antigravity (`hooks.json`).
// Maps Antigravity camelCase stdin payloads into ClaudeVille's POST /api/ingest/hook
// schema and ALWAYS prints a neutral JSON object `{}` on stdout (never `{ "decision": "allow" }`)
// so PreToolUse defers to Antigravity's normal permission flow.

const fs = require('node:fs');
const http = require('node:http');

const ANTIGRAVITY_HOOK_EVENTS = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PreInvocation',
  'PostInvocation',
  'Stop',
]);

const ALLOWLISTED_INPUT_KEYS = Object.freeze([
  'CommandLine',
  'command',
  'file_path',
  'Path',
  'path',
  'query',
  'pattern',
  'description',
]);

function readInput() {
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function redactIngestValue(value) {
  const clean = String(value || '')
    .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  if (clean.length <= 200) return clean;
  return `${clean.slice(0, 199).trimEnd()}…`;
}

function mapAntigravityHookEvent(input, now = Date.now()) {
  const kind = typeof input?.hookEventName === 'string' ? input.hookEventName.trim() : '';
  if (!ANTIGRAVITY_HOOK_EVENTS.has(kind)) return null;
  const sessionId = typeof input?.conversationId === 'string' ? input.conversationId.trim() : '';
  if (!sessionId) return null;

  const toolCall = input.toolCall && typeof input.toolCall === 'object' && !Array.isArray(input.toolCall)
    ? input.toolCall
    : null;
  const rawArgs = toolCall?.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
    ? toolCall.args
    : null;

  let safeInput = null;
  if (rawArgs) {
    for (const key of ALLOWLISTED_INPUT_KEYS) {
      if (typeof rawArgs[key] !== 'string') continue;
      const value = redactIngestValue(rawArgs[key]);
      if (value) safeInput = { [key]: value };
      break;
    }
  }

  return {
    provider: 'antigravity',
    sessionId,
    kind,
    tool: typeof toolCall?.name === 'string' ? redactIngestValue(toolCall.name)?.slice(0, 128) || null : null,
    input: safeInput,
    cwd: typeof input.cwd === 'string' ? input.cwd.slice(0, 4096) : '',
    ts: now,
  };
}

function postIngestEvent(event, { request = http.request, token = process.env.CLAUDEVILLE_INGEST_TOKEN } = {}) {
  const body = JSON.stringify(event);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (token) headers['X-ClaudeVille-Ingest-Token'] = token;
  try {
    const req = request({
      hostname: '127.0.0.1',
      port: 4000,
      path: '/api/ingest/hook',
      method: 'POST',
      headers,
      timeout: 150,
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end(body);
  } catch {}
}

function runIngest({
  env = process.env,
  read = readInput,
  request = http.request,
  now = Date.now,
  write = (chunk) => process.stdout.write(chunk),
} = {}) {
  if (env.CLAUDEVILLE_DISABLE_HOOKS === '1') {
    write('{}\n');
    return 0;
  }
  const event = mapAntigravityHookEvent(read(), now());
  if (event) postIngestEvent(event, { request, token: env.CLAUDEVILLE_INGEST_TOKEN });
  // Antigravity hooks must print valid JSON on stdout; empty object keeps PreToolUse neutral.
  write('{}\n');
  return 0;
}

if (require.main === module) process.exitCode = runIngest();

module.exports = {
  ANTIGRAVITY_HOOK_EVENTS,
  mapAntigravityHookEvent,
  runIngest,
};
