/**
 * T3 Code & Hobotnica orchestration state database (`statev2.sqlite`) helpers.
 *
 * Reads `~/.t3/userdata/statev2.sqlite` and `$HOBOTNICA_HOME/userdata/statev2.sqlite`
 * (default `~/.local/share/hobotnica/userdata/statev2.sqlite`) strictly read-only
 * through `node:sqlite` (unflagged from Node 22.13; graceful no-op when `node:sqlite`
 * is unavailable, or when a database is missing, locked, or uses a reduced schema).
 * Queries are cached per database path + `-wal` stat signature so frequent 2s adapter
 * polls cost only stat calls.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDetailResponse,
  stripShellLocationPrefix,
  summarizeToolInput,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState, toEpochMs } = require('./turnState');
const { normalizeToolResults, toolResultId, toolResultLocation } = require('./toolResults');
const {
  dedupeGitEvents,
  extractGitEventsFromCommandSource,
  normalizeProjectPath,
} = require('./gitEvents');
const { contextWindowForModel } = require('../src/config/models.generated.cjs');

const T3_PARENT_PREFIX = Object.freeze({
  claudeAgent: '',
  antigravity: 'antigravity-',
  codex: 'codex-',
  acpRegistry_glm_agent: 'zai-',
});

const T3_ACTIVE_RUN_STATUSES = Object.freeze([
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
]);

const T3_ACTIVE_RUN_STATUS_SET = new Set(T3_ACTIVE_RUN_STATUSES);
const T3_ACTIVE_ITEM_STATUSES = new Set(['in_progress', 'running', 'pending', 'waiting', 'started', 'queued']);
const T3_FAILED_RUN_STATUSES = new Set(['failed']);
const T3_ENDED_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);

const T3_TURN_ITEM_LIMIT = 500;
const T3_MESSAGE_LIMIT = 60;
const T3_TODO_LIMIT = 64;
const T3_QUERY_FAILED = Symbol('T3_QUERY_FAILED');
const T3_DISCOVERY_CACHE_MAX = 16;

function t3UserDataDir() {
  return path.join(os.homedir(), '.t3', 'userdata');
}

function t3StateDbPath() {
  return path.join(t3UserDataDir(), 'statev2.sqlite');
}

function hobotnicaHomeDir() {
  const configured = typeof process.env.HOBOTNICA_HOME === 'string'
    ? process.env.HOBOTNICA_HOME.trim()
    : '';
  return configured || path.join(os.homedir(), '.local', 'share', 'hobotnica');
}

function hobotnicaUserDataDir() {
  return path.join(hobotnicaHomeDir(), 'userdata');
}

function hobotnicaStateDbPath() {
  return path.join(hobotnicaUserDataDir(), 'statev2.sqlite');
}

function resolveSourceDbPaths(source = 'all') {
  if (source === 't3') return [t3StateDbPath()];
  if (source === 'hobotnica') return [hobotnicaStateDbPath()];
  // Order T3 before Hobotnica so when callers merge maps by key, Hobotnica wins on overlap.
  return [...new Set([t3StateDbPath(), hobotnicaStateDbPath()])];
}

function dbPathExists(dbPath) {
  try {
    return fs.existsSync(dbPath);
  } catch {
    return false;
  }
}

function t3StateDbExists(source = 'all') {
  return resolveSourceDbPaths(source).some(dbPathExists);
}

function hobotnicaStateDbExists() {
  return dbPathExists(hobotnicaStateDbPath());
}

let _nodeSqlite;
function loadNodeSqlite() {
  if (_nodeSqlite === undefined) {
    try {
      _nodeSqlite = require('node:sqlite');
    } catch {
      _nodeSqlite = null;
    }
  }
  return _nodeSqlite;
}

function statPart(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function stateDbSignature(dbPath) {
  const main = statPart(dbPath);
  if (!main) return null;
  const wal = statPart(`${dbPath}-wal`) || 'none';
  return `${dbPath}|${main}|${wal}`;
}

function t3StateSignature(source = 't3') {
  if (source === 'hobotnica') return stateDbSignature(hobotnicaStateDbPath());
  if (source === 'all') {
    const sigs = resolveSourceDbPaths('all').map(stateDbSignature).filter(Boolean);
    return sigs.length > 0 ? sigs.join('||') : null;
  }
  return stateDbSignature(t3StateDbPath());
}

function hobotnicaStateSignature() {
  return stateDbSignature(hobotnicaStateDbPath());
}

const _cachesByPath = new Map();

function clearT3Cache() {
  _cachesByPath.clear();
}

function syncCacheForPath(dbPath) {
  const sig = stateDbSignature(dbPath);
  if (!sig) {
    _cachesByPath.delete(dbPath);
    return null;
  }
  let cache = _cachesByPath.get(dbPath);
  if (!cache || cache.sig !== sig) {
    cache = { sig, entries: new Map(), schema: null, glmDiscovery: new Map() };
    _cachesByPath.set(dbPath, cache);
  }
  return cache;
}

function withStateDb(dbPath, fn, fallback = null) {
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync || !dbPathExists(dbPath)) return fallback;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    // Graceful no-op when DB is locked (SQLITE_BUSY/SQLITE_LOCKED), missing,
    // corrupted, or schema differs. Never poison provider readFailures.
    return fallback;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function cachedStateQuery(dbPath, cacheKey, compute, fallback) {
  const cache = syncCacheForPath(dbPath);
  if (!cache) return fallback;
  if (cache.entries.has(cacheKey)) return cache.entries.get(cacheKey);
  const value = withStateDb(dbPath, db => {
    const schema = readSchemaInfo(db, cache);
    return compute(db, schema);
  }, T3_QUERY_FAILED);
  if (value === T3_QUERY_FAILED) return fallback;
  cache.entries.set(cacheKey, value);
  return value;
}

function readSchemaInfo(db, cache) {
  if (cache?.schema) return cache.schema;
  const tables = new Set();
  const columns = new Map();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const row of rows) {
    if (typeof row?.name === 'string') tables.add(row.name);
  }
  const interesting = [
    'orchestration_v2_projection_threads',
    'orchestration_v2_projection_runs',
    'orchestration_v2_projection_run_attempts',
    'orchestration_v2_projection_provider_threads',
    'orchestration_v2_projection_provider_turns',
    'orchestration_v2_projection_turn_items',
    'orchestration_v2_projection_messages',
    'projection_projects',
  ];
  for (const tbl of interesting) {
    if (!tables.has(tbl)) continue;
    const cols = new Set();
    try {
      for (const info of db.prepare(`PRAGMA table_info(${tbl})`).all()) {
        if (typeof info?.name === 'string') cols.add(info.name);
      }
    } catch { /* ignore */ }
    columns.set(tbl, cols);
  }
  const schema = { tables, columns };
  if (cache) cache.schema = schema;
  return schema;
}

function queryT3State(sql, ...params) {
  const key = `raw:${sql}:${JSON.stringify(params)}`;
  return cachedStateQuery(t3StateDbPath(), key, (db) => {
    try {
      return db.prepare(sql).all(...params);
    } catch {
      return T3_QUERY_FAILED;
    }
  }, []);
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTs(value) {
  if (value == null) return 0;
  const ms = toEpochMs(value);
  return ms != null && ms > 0 ? ms : 0;
}

function normalizedIdsKey(ids) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim().toLowerCase())
      .filter(Boolean),
  )].sort();
}

function isSubagentLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') return false;
  const parentThreadId = typeof lineage.parentThreadId === 'string' ? lineage.parentThreadId.trim() : '';
  if (!parentThreadId) return false;
  const rel = typeof lineage.relationshipToParent === 'string' ? lineage.relationshipToParent.trim().toLowerCase() : '';
  return !rel || rel === 'subagent';
}

const GLM_PROVIDER_HINT_RE = /(?:^|[^a-z0-9])(?:glm|zai)(?:$|[^a-z0-9])/i;

function parentSessionIdFor(provider, nativeId) {
  if (typeof provider !== 'string' || typeof nativeId !== 'string' || !nativeId.trim()) return null;
  let prefix = T3_PARENT_PREFIX[provider];
  if (prefix === undefined && GLM_PROVIDER_HINT_RE.test(provider)) {
    prefix = 'zai-';
  }
  if (prefix === undefined) return null;
  return `${prefix}${nativeId.trim()}`;
}

function canonicalWorkingSetPath(rawPath, project) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const cleaned = rawPath.trim().replace(/^file:\/\//, '');
  const resolved = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : (project ? path.resolve(project, cleaned) : cleaned);
  if (project) {
    const normProj = path.resolve(project);
    if (resolved === normProj) return null;
    if (resolved.startsWith(`${normProj}${path.sep}`)) {
      return resolved.slice(normProj.length + 1).split(path.sep).join('/');
    }
  }
  return resolved;
}

function cleanT3UserPrompt(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const reqMatches = [...text.matchAll(/<user_request>((?:(?!<user_request\b)[\s\S])*?)<\/user_request>/gi)];
  const rawBody = reqMatches.length > 0
    ? reqMatches[reqMatches.length - 1][1]
    : text;
  const body = rawBody
    .replace(
      /<(?:t3_code_instructions|hobotnica_instructions|runtime_info)\b[^>]*>[\s\S]*?<\/(?:t3_code_instructions|hobotnica_instructions|runtime_info)>/gi,
      '',
    )
    .replace(/<(?:t3_code_instructions|hobotnica_instructions)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/?user_request\b[^>]*>/gi, '');
  const cleaned = body.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

function normalizeEffort(raw) {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'minimal') return 'low';
  if (lower === 'extra-high' || lower === 'extra') return 'xhigh';
  if (lower === 'med') return 'medium';
  if (['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(lower)) return lower;
  return lower;
}

function extractThoughtLevel(modelSelection) {
  const options = modelSelection?.options;
  if (Array.isArray(options)) {
    for (const opt of options) {
      if (!opt || typeof opt !== 'object') continue;
      if (['thought_level', 'reasoning_effort', 'effort'].includes(opt.id) && typeof opt.value === 'string') {
        return normalizeEffort(opt.value);
      }
    }
  } else if (options && typeof options === 'object') {
    const raw = options.thought_level ?? options.reasoning_effort ?? options.effort;
    if (typeof raw === 'string') return normalizeEffort(raw);
  }
  return null;
}

function projectT3Todos(rawTodos) {
  if (!Array.isArray(rawTodos)) return null;
  return rawTodos.slice(0, T3_TODO_LIMIT).flatMap((todo) => {
    if (!todo || typeof todo !== 'object') return [];
    const rawSubject = typeof todo.subject === 'string' && todo.subject.trim()
      ? todo.subject
      : (typeof todo.content === 'string' && todo.content.trim()
        ? todo.content
        : (typeof todo.title === 'string' ? todo.title : ''));
    const subject = rawSubject.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!subject) return [];
    const rawStatus = typeof todo.status === 'string' ? todo.status.trim().toLowerCase() : '';
    let status = 'pending';
    if (rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done' || rawStatus === 'skipped') {
      status = 'completed';
    } else if (rawStatus === 'in_progress' || rawStatus === 'in-progress' || rawStatus === 'running') {
      status = 'in_progress';
    }
    return [{ subject, status, phase: null }];
  });
}

// ─── 1. Renamed titles ────────────────────────────────────

const T3_RENAMED_SQL = `
SELECT DISTINCT lower(json_extract(a.payload_json, '$.nativeThreadId')) AS native, t.title AS title
FROM orchestration_v2_projection_run_attempts a
JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
WHERE a.provider = ?
  AND json_extract(t.payload_json, '$.titleRenamed') = 1
  AND lower(json_extract(a.payload_json, '$.nativeThreadId')) IN (SELECT value FROM json_each(?))
`;

function readT3RenamedTitles(provider, nativeIds, { source = 'all' } = {}) {
  const uniqueIds = normalizedIdsKey(nativeIds);
  if (!provider || uniqueIds.length === 0) return new Map();
  const idsJson = JSON.stringify(uniqueIds);
  const key = `renamed:${provider}:${idsJson}`;
  const merged = new Map();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const result = cachedStateQuery(dbPath, key, (db, schema) => {
      const titles = new Map();
      if (!schema.tables.has('orchestration_v2_projection_run_attempts')
        || !schema.tables.has('orchestration_v2_projection_threads')) {
        return titles;
      }
      for (const row of db.prepare(T3_RENAMED_SQL).all(provider, idsJson)) {
        const title = typeof row.title === 'string' ? row.title.trim().slice(0, 128) : '';
        if (title && row.native) titles.set(row.native, title);
      }
      return titles;
    }, new Map());
    for (const [native, title] of result) merged.set(native, title);
  }
  return merged;
}

// ─── 2. Lineage ───────────────────────────────────────────

function buildAttemptCteBody(schema) {
  const hasRuns = schema.tables.has('orchestration_v2_projection_runs');
  const attemptCols = schema.columns.get('orchestration_v2_projection_run_attempts') || new Set();
  const hasRunId = hasRuns && attemptCols.has('run_id');
  const hasAttemptOrdinal = attemptCols.has('attempt_ordinal');
  const orderBy = hasRunId
    ? `r.ordinal DESC${hasAttemptOrdinal ? ', a.attempt_ordinal DESC' : ''}, a.rowid DESC`
    : (hasAttemptOrdinal ? 'a.attempt_ordinal DESC, a.rowid DESC' : 'a.rowid DESC');
  const joinRuns = hasRunId
    ? 'JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id'
    : '';
  return `
    attempt AS (
      SELECT a.thread_id, a.provider, json_extract(a.payload_json, '$.nativeThreadId') AS native,
        ROW_NUMBER() OVER (PARTITION BY a.thread_id ORDER BY ${orderBy}) AS rank
      FROM orchestration_v2_projection_run_attempts a
      ${joinRuns}
      WHERE json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
    )
  `;
}

function buildAttemptCte(schema) {
  return `WITH ${buildAttemptCteBody(schema)}`;
}

function buildActiveRunNativeCte(schema) {
  const runCols = schema.columns.get('orchestration_v2_projection_runs');
  if (!runCols || !runCols.has('status')) return null;
  const attemptCols = schema.columns.get('orchestration_v2_projection_run_attempts');
  const threadCols = schema.columns.get('orchestration_v2_projection_threads');
  const hasAttempts = Boolean(attemptCols && attemptCols.has('run_id'));
  const hasThreads = Boolean(threadCols);
  const hasProviderThreads = schema.tables.has('orchestration_v2_projection_provider_threads');
  const ptKeyExpr = hasProviderThreads
    ? (runCols.has('provider_thread_id') && hasThreads && threadCols.has('active_provider_thread_id')
      ? 'COALESCE(r.provider_thread_id, t.active_provider_thread_id)'
      : (runCols.has('provider_thread_id')
        ? 'r.provider_thread_id'
        : (hasThreads && threadCols.has('active_provider_thread_id') ? 't.active_provider_thread_id' : null)))
    : null;
  if (!hasAttempts && !ptKeyExpr) return null;

  const attemptOrder = attemptCols?.has('attempt_ordinal')
    ? 'a.attempt_ordinal DESC, a.rowid DESC'
    : 'a.rowid DESC';
  const providerParts = [];
  if (hasAttempts) providerParts.push('ra.provider');
  if (runCols.has('provider')) providerParts.push('r.provider');
  if (ptKeyExpr) providerParts.push('pt.provider');
  if (hasThreads && threadCols.has('default_provider')) providerParts.push('t.default_provider');
  const providerExpr = providerParts.length > 1
    ? `COALESCE(${providerParts.join(', ')})`
    : (providerParts[0] || 'NULL');
  const ptNativeExpr = ptKeyExpr ? "lower(json_extract(pt.payload_json, '$.nativeThreadRef.nativeId'))" : null;
  const nativeExpr = hasAttempts && ptNativeExpr
    ? `COALESCE(ra.native, ${ptNativeExpr})`
    : (hasAttempts ? 'ra.native' : ptNativeExpr);
  const deletedFilter = hasThreads && threadCols.has('deleted_at') ? 'AND t.deleted_at IS NULL' : '';

  const attemptCte = hasAttempts ? `
    active_run_attempt AS (
      SELECT a.run_id,
             a.provider,
             lower(json_extract(a.payload_json, '$.nativeThreadId')) AS native,
             ROW_NUMBER() OVER (PARTITION BY a.run_id ORDER BY ${attemptOrder}) AS rn
      FROM orchestration_v2_projection_run_attempts a
      WHERE json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
    ),` : '';

  return `
    ${attemptCte}
    active_run_native AS (
      SELECT DISTINCT
        ${providerExpr} AS provider,
        ${nativeExpr} AS native
      FROM orchestration_v2_projection_runs r
      ${hasAttempts ? 'LEFT JOIN active_run_attempt ra ON ra.run_id = r.run_id AND ra.rn = 1' : ''}
      ${hasThreads ? 'LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id' : ''}
      ${ptKeyExpr ? `LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = ${ptKeyExpr}` : ''}
      WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        ${deletedFilter}
        AND ${nativeExpr} IS NOT NULL
    )
  `;
}

function sqlEpochMsExpr(expr) {
  return `(CASE WHEN typeof(${expr}) IN ('integer', 'real') THEN (CASE WHEN ${expr} > 1e12 THEN ${expr} ELSE ${expr} * 1000.0 END) ELSE COALESCE((julianday(${expr}) - 2440587.5) * 86400000.0, 0) END)`;
}

/**
 * Resolve T3 Code parent thread lineage for subagent threads of `provider`.
 * Returns Map<lowerNativeId, { parentSessionId, parentProvider, parentNative, title, titleRenamed, relationshipToParent }>.
 */
function readT3Lineage(provider, nativeIds, { source = 'all' } = {}) {
  const uniqueIds = normalizedIdsKey(nativeIds);
  if (!provider || uniqueIds.length === 0) return new Map();
  const idsJson = JSON.stringify(uniqueIds);
  const key = `lineage:${provider}:${idsJson}`;
  const merged = new Map();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const result = cachedStateQuery(dbPath, key, (db, schema) => {
      const links = new Map();
      if (!schema.tables.has('orchestration_v2_projection_run_attempts')
        || !schema.tables.has('orchestration_v2_projection_threads')) {
        return links;
      }
      const sql = `
        ${buildAttemptCte(schema)}
        SELECT lower(child.native) AS native,
               t.title AS title,
               json_extract(t.payload_json, '$.titleRenamed') AS titleRenamed,
               json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationshipToParent,
               parent.provider AS parentProvider,
               parent.native AS parentNative
        FROM attempt child
        JOIN orchestration_v2_projection_threads t ON t.thread_id = child.thread_id
        JOIN attempt parent ON parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId') AND parent.rank = 1
        WHERE child.provider = ?
          AND lower(child.native) IN (SELECT value FROM json_each(?))
      `;
      for (const row of db.prepare(sql).all(provider, idsJson)) {
        const rel = typeof row.relationshipToParent === 'string' ? row.relationshipToParent.trim() : null;
        if (rel && rel.toLowerCase() !== 'subagent') continue;
        const parentSessionId = parentSessionIdFor(row.parentProvider, row.parentNative);
        if (!parentSessionId || !row.native) continue;
        links.set(row.native, {
          parentSessionId,
          parentProvider: row.parentProvider,
          parentNative: row.parentNative,
          title: typeof row.title === 'string' ? row.title.trim().slice(0, 128) || null : null,
          titleRenamed: row.titleRenamed === 1 || row.titleRenamed === true,
          relationshipToParent: rel,
        });
      }
      return links;
    }, new Map());
    for (const [k, v] of result) merged.set(k, { ...v });
  }
  return merged;
}

// ─── 3. Active delegates grouped by parent session ID ─────

/**
 * Query indexed `orchestration_v2_projection_runs` for active child runs
 * (`status IN ('queued','preparing','starting','running','waiting')`),
 * grouped by parent session ID so parents waiting on cross-provider T3
 * delegates stay alive and get accurate `backgroundPending`.
 *
 * Returns Map<parentSessionId, { count, since, parentProvider, parentNative, children }>.
 */
function readT3ActiveDelegates({ source = 'all' } = {}) {
  const key = 'activeDelegates';
  const merged = new Map();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const result = cachedStateQuery(dbPath, key, (db, schema) => {
      const byParent = new Map();
      const runCols = schema.columns.get('orchestration_v2_projection_runs');
      const threadCols = schema.columns.get('orchestration_v2_projection_threads');
      if (!runCols || !threadCols
        || !runCols.has('status')
        || !schema.tables.has('orchestration_v2_projection_run_attempts')) {
        return byParent;
      }

      const startedExpr = runCols.has('payload_json') && runCols.has('requested_at')
        ? "COALESCE(json_extract(r.payload_json, '$.startedAt'), r.requested_at)"
        : (runCols.has('requested_at') ? 'r.requested_at' : 'NULL');
      const childDeletedFilter = threadCols.has('deleted_at') ? 'AND t.deleted_at IS NULL' : '';
      const hasProviderThreads = schema.tables.has('orchestration_v2_projection_provider_threads');
      const attemptCols = schema.columns.get('orchestration_v2_projection_run_attempts') || new Set();
      const hasAttemptRunId = attemptCols.has('run_id');
      const attemptOrder = attemptCols.has('attempt_ordinal') ? 'a.attempt_ordinal DESC, a.rowid DESC' : 'a.rowid DESC';
      const ptJoinKey = runCols.has('provider_thread_id') && threadCols.has('active_provider_thread_id')
        ? 'COALESCE(r.provider_thread_id, t.active_provider_thread_id)'
        : (runCols.has('provider_thread_id') ? 'r.provider_thread_id' : 't.active_provider_thread_id');
      const ptJoin = hasProviderThreads
        ? `LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = ${ptJoinKey}`
        : '';
      const ptNativeExpr = hasProviderThreads
        ? "COALESCE(child.native, json_extract(pt.payload_json, '$.nativeThreadRef.nativeId'))"
        : 'child.native';
      const childProviderExpr = runCols.has('provider')
        ? 'COALESCE(child.provider, r.provider)'
        : 'child.provider';
      const runAttemptCte = hasAttemptRunId
        ? `,
      run_attempt AS (
        SELECT a.run_id, a.provider, json_extract(a.payload_json, '$.nativeThreadId') AS native,
          ROW_NUMBER() OVER (PARTITION BY a.run_id ORDER BY ${attemptOrder}) AS rank
        FROM orchestration_v2_projection_run_attempts a
        WHERE json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
      )`
        : '';
      const childAttemptJoin = hasAttemptRunId
        ? 'LEFT JOIN run_attempt child ON child.run_id = r.run_id AND child.rank = 1'
        : 'LEFT JOIN attempt child ON child.thread_id = r.thread_id AND child.rank = 1';

      const sql = `
      WITH ${buildAttemptCteBody(schema)}
      ${runAttemptCte}
      SELECT r.thread_id AS childThreadId,
             r.status AS runStatus,
             ${startedExpr} AS startedAt,
             ${childProviderExpr} AS childProvider,
             ${ptNativeExpr} AS childNative,
             json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationshipToParent,
             parent.provider AS parentProvider,
             parent.native AS parentNative
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      JOIN attempt parent ON parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId') AND parent.rank = 1
      ${childAttemptJoin}
      ${ptJoin}
      WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
        ${childDeletedFilter}
    `;

      const seenChildrenByParent = new Map();
      for (const row of db.prepare(sql).all()) {
        const rel = typeof row.relationshipToParent === 'string' ? row.relationshipToParent.trim().toLowerCase() : '';
        if (rel && rel !== 'subagent') continue;
        const parentSessionId = parentSessionIdFor(row.parentProvider, row.parentNative);
        if (!parentSessionId) continue;

        const startedAt = parseTs(row.startedAt) || null;
        const childSessionId = parentSessionIdFor(row.childProvider, row.childNative);

        let childrenByThread = seenChildrenByParent.get(parentSessionId);
        if (!childrenByThread) {
          childrenByThread = new Map();
          seenChildrenByParent.set(parentSessionId, childrenByThread);
        }
        const existingChild = childrenByThread.get(row.childThreadId);
        if (existingChild) {
          if (startedAt && (!existingChild.startedAt || startedAt < existingChild.startedAt)) {
            existingChild.startedAt = startedAt;
          }
          continue;
        }
        childrenByThread.set(row.childThreadId, {
          childThreadId: row.childThreadId,
          childProvider: row.childProvider || null,
          childNative: row.childNative || null,
          childSessionId,
          startedAt,
        });

        if (!byParent.has(parentSessionId)) {
          byParent.set(parentSessionId, {
            parentProvider: row.parentProvider,
            parentNative: row.parentNative,
            count: 0,
            since: null,
            children: [],
          });
        }
      }

      for (const [parentSessionId, entry] of byParent) {
        const children = [...(seenChildrenByParent.get(parentSessionId)?.values() || [])];
        const starts = children.map(c => c.startedAt).filter(ts => Number.isFinite(ts) && ts > 0);
        entry.children = children;
        entry.count = children.length;
        entry.since = starts.length > 0 ? Math.min(...starts) : null;
      }

      return byParent;
    }, new Map());

    for (const [parentSessionId, entry] of result) {
      const existing = merged.get(parentSessionId);
      if (!existing) {
        merged.set(parentSessionId, {
          ...entry,
          children: entry.children.map(c => ({ ...c })),
        });
      } else {
        const byChildId = new Map(existing.children.map(c => [c.childThreadId, c]));
        for (const child of entry.children) {
          byChildId.set(child.childThreadId, { ...child });
        }
        const children = [...byChildId.values()];
        const starts = children.map(c => c.startedAt).filter(ts => Number.isFinite(ts) && ts > 0);
        merged.set(parentSessionId, {
          ...entry,
          children,
          count: children.length,
          since: starts.length > 0 ? Math.min(...starts) : null,
        });
      }
    }
  }

  return merged;
}

// ─── 4. Root thread state & active run native IDs ─────────

/**
 * Return per-nativeId `{ settledAt, archivedAt, deletedAt, isSubagent, activeRun }`
 * from `orchestration_v2_projection_threads` + `orchestration_v2_projection_runs`.
 */
function readT3RootThreadState(provider, nativeIds, { source = 'all' } = {}) {
  const uniqueIds = normalizedIdsKey(nativeIds);
  if (!provider || uniqueIds.length === 0) return new Map();
  const idsJson = JSON.stringify(uniqueIds);
  const key = `rootState:${provider}:${idsJson}`;
  const merged = new Map();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const result = cachedStateQuery(dbPath, key, (db, schema) => {
      const states = new Map();
      const threadCols = schema.columns.get('orchestration_v2_projection_threads');
      if (!threadCols || !schema.tables.has('orchestration_v2_projection_run_attempts')) {
        return states;
      }
      const activeRunCte = buildActiveRunNativeCte(schema);
      const archivedExpr = threadCols.has('archived_at')
        ? "COALESCE(t.archived_at, json_extract(t.payload_json, '$.archivedAt'))"
        : "json_extract(t.payload_json, '$.archivedAt')";
      const deletedExpr = threadCols.has('deleted_at')
        ? "COALESCE(t.deleted_at, json_extract(t.payload_json, '$.deletedAt'))"
        : "json_extract(t.payload_json, '$.deletedAt')";
      const updatedOrder = threadCols.has('updated_at') ? 'ORDER BY t.updated_at ASC' : '';
      const activeRunExpr = activeRunCte
        ? `EXISTS (
          SELECT 1 FROM active_run_native arn
          WHERE arn.provider = a.provider
            AND arn.native = lower(json_extract(a.payload_json, '$.nativeThreadId'))
        )`
        : '0';

      const sql = `
      ${activeRunCte ? `WITH ${activeRunCte}` : ''}
      SELECT DISTINCT lower(json_extract(a.payload_json, '$.nativeThreadId')) AS native,
             t.thread_id AS threadId,
             json_extract(t.payload_json, '$.settledAt') AS settledAt,
             json_extract(t.payload_json, '$.unsettledAt') AS unsettledAt,
             json_extract(t.payload_json, '$.settledOverride') AS settledOverride,
             ${archivedExpr} AS archivedAt,
             ${deletedExpr} AS deletedAt,
             json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentThreadId,
             json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationshipToParent,
             ${activeRunExpr} AS activeRun
      FROM orchestration_v2_projection_run_attempts a
      JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
      WHERE a.provider = ?
        AND lower(json_extract(a.payload_json, '$.nativeThreadId')) IN (SELECT value FROM json_each(?))
      ${updatedOrder}
    `;

      for (const row of db.prepare(sql).all(provider, idsJson)) {
        if (!row.native) continue;
        let settledAt = typeof row.settledAt === 'string' && row.settledAt.trim() ? row.settledAt.trim() : null;
        const unsettledAt = typeof row.unsettledAt === 'string' && row.unsettledAt.trim() ? row.unsettledAt.trim() : null;
        if (row.settledOverride === 'unsettled' || (settledAt && unsettledAt && parseTs(unsettledAt) >= parseTs(settledAt))) {
          settledAt = null;
        }
        const archivedAt = typeof row.archivedAt === 'string' && row.archivedAt.trim() ? row.archivedAt.trim() : null;
        const deletedAt = typeof row.deletedAt === 'string' && row.deletedAt.trim() ? row.deletedAt.trim() : null;
        const isSubagent = isSubagentLineage({
          parentThreadId: row.parentThreadId,
          relationshipToParent: row.relationshipToParent,
        });
        states.set(row.native, {
          settledAt,
          archivedAt,
          deletedAt,
          isSubagent,
          activeRun: Boolean(row.activeRun),
        });
      }
      return states;
    }, new Map());
    for (const [k, v] of result) merged.set(k, { ...v });
  }

  return merged;
}

/**
 * Return lowercased nativeIds for `provider` that currently have an active run
 * in `orchestration_v2_projection_runs`. Cheap indexed scan used to keep quiet
 * running turns in candidate discovery even without `/proc/locks`.
 */
function readT3ActiveRunNativeIds(provider, { source = 'all' } = {}) {
  if (!provider) return new Set();
  const key = `activeRunNatives:${provider}`;
  const merged = new Set();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const result = cachedStateQuery(dbPath, key, (db, schema) => {
      const ids = new Set();
      const activeRunCte = buildActiveRunNativeCte(schema);
      if (!activeRunCte) return ids;
      const sql = `
      WITH ${activeRunCte}
      SELECT DISTINCT native
      FROM active_run_native
      WHERE provider = ?
    `;
      for (const row of db.prepare(sql).all(provider)) {
        if (row.native) ids.add(row.native);
      }
      return ids;
    }, new Set());
    for (const id of result) merged.add(id);
  }
  return merged;
}

// ─── 5. ACP GLM-5.4 sessions from T3 SQLite ───────────────

function normalizeKeepGlmNativeIds(keepSessionIds) {
  if (!keepSessionIds) return [];
  const raw = [];
  for (const id of keepSessionIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    raw.push(trimmed.startsWith('zai-') ? trimmed.slice(4) : trimmed);
  }
  return normalizedIdsKey(raw);
}

function queryT3AcpGlmRecords(db, schema, {
  cutoffMs = null,
  keepNativeIds = [],
  includeArchived = false,
  detailTarget = null,
} = {}) {
  const threadCols = schema.columns.get('orchestration_v2_projection_threads');
  if (!threadCols || !threadCols.has('default_provider')) return [];

  const hasProviderThreads = schema.tables.has('orchestration_v2_projection_provider_threads');
  const ptCols = schema.columns.get('orchestration_v2_projection_provider_threads') || new Set();
  const hasRuns = schema.tables.has('orchestration_v2_projection_runs');
  const runCols = schema.columns.get('orchestration_v2_projection_runs') || new Set();
  const hasLatestRun = hasRuns && runCols.has('status');
  const hasAttempts = schema.tables.has('orchestration_v2_projection_run_attempts');
  const hasTurns = schema.tables.has('orchestration_v2_projection_provider_turns');
  const hasItems = schema.tables.has('orchestration_v2_projection_turn_items');
  const hasMessages = schema.tables.has('orchestration_v2_projection_messages');
  const hasProjects = schema.tables.has('projection_projects');

  const ptJoin = hasProviderThreads
    ? `LEFT JOIN orchestration_v2_projection_provider_threads pt
         ON pt.provider_thread_id = t.active_provider_thread_id
         OR (t.active_provider_thread_id IS NULL AND pt.thread_id = t.thread_id)`
    : '';
  const projJoin = hasProjects
    ? 'LEFT JOIN projection_projects proj ON proj.project_id = t.project_id'
    : '';
  const glmFilter = hasProviderThreads && ptCols.has('driver')
    ? `(t.default_provider = 'acpRegistry_glm_agent'
        OR lower(t.default_provider) LIKE '%glm%'
        OR (pt.driver = 'acpRegistry' AND lower(COALESCE(json_extract(t.payload_json, '$.modelSelection.model'), '')) LIKE '%glm%'))`
    : `(t.default_provider = 'acpRegistry_glm_agent'
        OR lower(t.default_provider) LIKE '%glm%'
        OR (t.default_provider LIKE 'acpRegistry%' AND lower(COALESCE(json_extract(t.payload_json, '$.modelSelection.model'), '')) LIKE '%glm%'))`;

  const baseWhereParts = [glmFilter];
  if (!includeArchived) {
    const deletedExpr = threadCols.has('deleted_at')
      ? "COALESCE(t.deleted_at, json_extract(t.payload_json, '$.deletedAt'), '')"
      : "COALESCE(json_extract(t.payload_json, '$.deletedAt'), '')";
    const archivedExpr = threadCols.has('archived_at')
      ? "COALESCE(t.archived_at, json_extract(t.payload_json, '$.archivedAt'), '')"
      : "COALESCE(json_extract(t.payload_json, '$.archivedAt'), '')";
    baseWhereParts.push(`NULLIF(TRIM(${deletedExpr}), '') IS NULL`);
    baseWhereParts.push(`NULLIF(TRIM(${archivedExpr}), '') IS NULL`);
  }

  const cteParts = [`
    glm_threads AS (
      SELECT t.thread_id AS threadId,
             t.title AS title,
             t.default_provider AS defaultProvider,
             ${threadCols.has('updated_at') ? 't.updated_at' : 'NULL'} AS threadUpdatedAt,
             ${threadCols.has('created_at') ? 't.created_at' : 'NULL'} AS threadCreatedAt,
             ${threadCols.has('archived_at') ? 't.archived_at' : 'NULL'} AS archivedAt,
             ${threadCols.has('deleted_at') ? 't.deleted_at' : 'NULL'} AS deletedAt,
             t.payload_json AS threadPayloadJson,
             ${hasProjects ? 'proj.workspace_root' : 'NULL'} AS workspaceRoot,
             ${hasProviderThreads ? 'pt.status' : 'NULL'} AS ptStatus,
             ${hasProviderThreads && ptCols.has('updated_at') ? 'pt.updated_at' : 'NULL'} AS ptUpdatedAt,
             ${hasProviderThreads ? 'pt.payload_json' : 'NULL'} AS ptPayloadJson
      FROM orchestration_v2_projection_threads t
      ${ptJoin}
      ${projJoin}
      WHERE ${baseWhereParts.join('\n        AND ')}
    )
  `];
  if (hasLatestRun) {
    const runOrder = runCols.has('ordinal') ? 'r.ordinal DESC, r.rowid DESC' : 'r.rowid DESC';
    cteParts.push(`
      latest_run AS (
        SELECT r.run_id AS runId,
               r.thread_id AS threadId,
               ${runCols.has('ordinal') ? 'r.ordinal' : 'r.rowid'} AS ordinal,
               r.status AS status,
               ${runCols.has('requested_at') ? 'r.requested_at' : 'NULL'} AS requestedAt,
               ${runCols.has('completed_at') ? 'r.completed_at' : 'NULL'} AS completedAt,
               ${runCols.has('payload_json') ? 'r.payload_json' : 'NULL'} AS payloadJson,
               ROW_NUMBER() OVER (PARTITION BY r.thread_id ORDER BY ${runOrder}) AS rn
        FROM orchestration_v2_projection_runs r
        WHERE r.thread_id IN (SELECT threadId FROM glm_threads)
      )
    `);
  }
  if (hasAttempts) {
    const attemptCols = schema.columns.get('orchestration_v2_projection_run_attempts') || new Set();
    const hasRunId = hasRuns && attemptCols.has('run_id');
    const hasAttemptOrdinal = attemptCols.has('attempt_ordinal');
    const orderBy = hasRunId
      ? `r.ordinal DESC${hasAttemptOrdinal ? ', a.attempt_ordinal DESC' : ''}, a.rowid DESC`
      : (hasAttemptOrdinal ? 'a.attempt_ordinal DESC, a.rowid DESC' : 'a.rowid DESC');
    const joinRuns = hasRunId
      ? 'JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id'
      : '';
    cteParts.push(`
      glm_attempt AS (
        SELECT a.thread_id, a.provider, json_extract(a.payload_json, '$.nativeThreadId') AS native,
          ROW_NUMBER() OVER (PARTITION BY a.thread_id ORDER BY ${orderBy}) AS rank
        FROM orchestration_v2_projection_run_attempts a
        ${joinRuns}
        WHERE a.thread_id IN (SELECT threadId FROM glm_threads)
          AND json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
      )
    `);
  }

  const filterParts = [];
  const params = [];

  if (detailTarget) {
    const detailConds = ['lower(gt.threadId) = ?'];
    params.push(detailTarget);
    if (hasProviderThreads) {
      detailConds.push("lower(COALESCE(json_extract(gt.ptPayloadJson, '$.nativeThreadRef.nativeId'), '')) = ?");
      params.push(detailTarget);
    }
    if (hasAttempts) {
      detailConds.push("lower(COALESCE(att.native, '')) = ?");
      params.push(detailTarget);
    }
    filterParts.push(`(${detailConds.join(' OR ')})`);
  } else if (cutoffMs !== null) {
    const selectConds = [];
    if (hasLatestRun) {
      selectConds.push("lower(COALESCE(lr.status, '')) IN ('queued', 'preparing', 'starting', 'running', 'waiting')");
      if (hasProviderThreads) {
        selectConds.push("(lr.runId IS NULL AND lower(COALESCE(gt.ptStatus, '')) = 'active')");
      }
    } else if (hasProviderThreads) {
      selectConds.push("lower(COALESCE(gt.ptStatus, '')) = 'active'");
    }

    const sqlCutoff = cutoffMs - 2000;
    if (threadCols.has('updated_at')) {
      selectConds.push(`${sqlEpochMsExpr('gt.threadUpdatedAt')} >= ?`);
      params.push(sqlCutoff);
    }
    if (hasProviderThreads && ptCols.has('updated_at')) {
      selectConds.push(`${sqlEpochMsExpr('gt.ptUpdatedAt')} >= ?`);
      params.push(sqlCutoff);
    }
    if (hasLatestRun) {
      if (runCols.has('completed_at')) {
        selectConds.push(`${sqlEpochMsExpr('lr.completedAt')} >= ?`);
        params.push(sqlCutoff);
      }
      if (runCols.has('requested_at')) {
        selectConds.push(`${sqlEpochMsExpr('lr.requestedAt')} >= ?`);
        params.push(sqlCutoff);
      }
      if (runCols.has('payload_json')) {
        selectConds.push(`${sqlEpochMsExpr("json_extract(lr.payloadJson, '$.startedAt')")} >= ?`);
        params.push(sqlCutoff);
      }
    }

    if (keepNativeIds.length > 0) {
      const keepJson = JSON.stringify(keepNativeIds);
      selectConds.push('lower(gt.threadId) IN (SELECT value FROM json_each(?))');
      params.push(keepJson);
      if (hasProviderThreads) {
        selectConds.push("lower(COALESCE(json_extract(gt.ptPayloadJson, '$.nativeThreadRef.nativeId'), '')) IN (SELECT value FROM json_each(?))");
        params.push(keepJson);
      }
      if (hasAttempts) {
        selectConds.push("lower(COALESCE(att.native, '')) IN (SELECT value FROM json_each(?))");
        params.push(keepJson);
      }
    }

    if (selectConds.length > 0) {
      filterParts.push(`(${selectConds.join(' OR ')})`);
    }
  }

  const threadsSql = `
    WITH ${cteParts.join(',\n')}
    SELECT gt.threadId,
           gt.title,
           gt.defaultProvider,
           gt.threadUpdatedAt,
           gt.threadCreatedAt,
           gt.archivedAt,
           gt.deletedAt,
           gt.threadPayloadJson,
           gt.workspaceRoot,
           gt.ptStatus,
           gt.ptUpdatedAt,
           gt.ptPayloadJson,
           ${hasLatestRun ? 'lr.runId' : 'NULL'} AS runId,
           ${hasLatestRun ? 'lr.ordinal' : 'NULL'} AS runOrdinal,
           ${hasLatestRun ? 'lr.status' : 'NULL'} AS runStatus,
           ${hasLatestRun ? 'lr.requestedAt' : 'NULL'} AS runRequestedAt,
           ${hasLatestRun ? 'lr.completedAt' : 'NULL'} AS runCompletedAt,
           ${hasLatestRun ? 'lr.payloadJson' : 'NULL'} AS runPayloadJson,
           ${hasAttempts ? 'att.provider' : 'NULL'} AS attemptProvider,
           ${hasAttempts ? 'att.native' : 'NULL'} AS attemptNative
    FROM glm_threads gt
    ${hasLatestRun ? 'LEFT JOIN latest_run lr ON lr.threadId = gt.threadId AND lr.rn = 1' : ''}
    ${hasAttempts ? 'LEFT JOIN glm_attempt att ON att.thread_id = gt.threadId AND att.rank = 1' : ''}
    ${filterParts.length > 0 ? `WHERE ${filterParts.join('\n      AND ')}` : ''}
  `;

  const threadRows = db.prepare(threadsSql).all(...params);
  if (!threadRows.length) return [];

  // Deduplicate if a thread matched multiple provider_threads rows (keep newest).
  const threadById = new Map();
  for (const row of threadRows) {
    const prev = threadById.get(row.threadId);
    if (!prev || parseTs(row.ptUpdatedAt) >= parseTs(prev.ptUpdatedAt)) {
      threadById.set(row.threadId, row);
    }
  }

  const threadIds = [...threadById.keys()];
  const idsJson = JSON.stringify(threadIds);

  // Latest attempt nativeThreadId for parent threads (selected GLM threads already carry attemptNative)
  const parentThreadIds = new Set();
  for (const row of threadById.values()) {
    const payload = safeJsonParse(row.threadPayloadJson);
    if (isSubagentLineage(payload?.lineage)) {
      parentThreadIds.add(payload.lineage.parentThreadId.trim());
    }
  }
  const latestAttemptByThread = new Map();
  if (hasAttempts && parentThreadIds.size > 0) {
    const attemptSql = `
      ${buildAttemptCte(schema)}
      SELECT thread_id AS threadId, provider, native
      FROM attempt
      WHERE rank = 1
        AND thread_id IN (SELECT value FROM json_each(?))
    `;
    for (const row of db.prepare(attemptSql).all(JSON.stringify([...parentThreadIds]))) {
      latestAttemptByThread.set(row.threadId, row);
    }
  }

  // Aggregated token usage per selected thread from provider_turns (SQL-side)
  const tokenSummaryByThread = new Map();
  if (hasTurns) {
    const turnCols = schema.columns.get('orchestration_v2_projection_provider_turns') || new Set();
    if (turnCols.has('payload_json')) {
      const sortExpr = turnCols.has('ordinal') ? 'ordinal' : 'rowid';
      const turnsSql = `
        WITH parsed AS (
          SELECT
            thread_id AS threadId,
            ${sortExpr} AS sortOrd,
            rowid AS rid,
            MAX(0, COALESCE(
              CAST(json_extract(payload_json, '$.turnTokenUsage.inputTokens') AS REAL),
              CAST(json_extract(payload_json, '$.turnTokenUsage.input_tokens') AS REAL),
              0
            )) AS rawIn,
            MAX(0, COALESCE(
              CAST(json_extract(payload_json, '$.turnTokenUsage.cachedInputTokens') AS REAL),
              CAST(json_extract(payload_json, '$.turnTokenUsage.cached_input_tokens') AS REAL),
              CAST(json_extract(payload_json, '$.turnTokenUsage.cacheReadInputTokens') AS REAL),
              0
            )) AS cachedIn,
            MAX(0, COALESCE(
              CAST(json_extract(payload_json, '$.turnTokenUsage.outputTokens') AS REAL),
              CAST(json_extract(payload_json, '$.turnTokenUsage.output_tokens') AS REAL),
              0
            )) AS outTok,
            MAX(0, COALESCE(
              CAST(json_extract(payload_json, '$.turnTokenUsage.reasoningTokens') AS REAL),
              CAST(json_extract(payload_json, '$.turnTokenUsage.reasoning_tokens') AS REAL),
              0
            )) AS reasoningTok
          FROM orchestration_v2_projection_provider_turns
          WHERE thread_id IN (SELECT value FROM json_each(?))
            AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.turnTokenUsage') END = 'object'
        ),
        nonzero AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY threadId ORDER BY sortOrd DESC, rid DESC) AS rnDesc
          FROM parsed
          WHERE rawIn > 0 OR cachedIn > 0 OR outTok > 0 OR reasoningTok > 0
        )
        SELECT
          threadId,
          SUM(MAX(0, rawIn - cachedIn)) AS totalUncachedInput,
          SUM(cachedIn) AS totalCacheRead,
          SUM(outTok) AS totalOutput,
          SUM(reasoningTok) AS totalReasoning,
          COUNT(*) AS usageTurnCount,
          MAX(CASE WHEN rnDesc = 1 THEN rawIn ELSE 0 END) AS lastTurnTotalInput
        FROM nonzero
        GROUP BY threadId
      `;
      for (const row of db.prepare(turnsSql).all(idsJson)) {
        tokenSummaryByThread.set(row.threadId, row);
      }
    }
  }

  // Bounded turn items per selected thread (newest T3_TURN_ITEM_LIMIT in SQL, returned ordinal ASC)
  const itemsByThread = new Map();
  if (hasItems) {
    const itemCols = schema.columns.get('orchestration_v2_projection_turn_items') || new Set();
    const ordCol = itemCols.has('ordinal') ? 'ordinal' : 'rowid';
    const itemSelect = `thread_id AS threadId, ${itemCols.has('run_id') ? 'run_id' : 'NULL'} AS runId, ${ordCol} AS ordinal, ${itemCols.has('type') ? 'type' : "''"} AS type, ${itemCols.has('status') ? 'status' : "''"} AS status, ${itemCols.has('updated_at') ? 'updated_at' : 'NULL'} AS updatedAt, payload_json AS payloadJson`;
    if (threadIds.length === 1) {
      const rows = db.prepare(`
        SELECT ${itemSelect}
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ?
        ORDER BY ${ordCol} DESC, rowid DESC
        LIMIT ?
      `).all(threadIds[0], T3_TURN_ITEM_LIMIT);
      rows.reverse();
      if (rows.length) itemsByThread.set(threadIds[0], rows);
    } else {
      const itemsSql = `
        WITH ranked AS (
          SELECT ${itemSelect}, rowid AS rid,
                 ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ${ordCol} DESC, rowid DESC) AS rn
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id IN (SELECT value FROM json_each(?))
        )
        SELECT threadId, runId, ordinal, type, status, updatedAt, payloadJson
        FROM ranked
        WHERE rn <= ?
        ORDER BY threadId ASC, ordinal ASC, rid ASC
      `;
      for (const row of db.prepare(itemsSql).all(idsJson, T3_TURN_ITEM_LIMIT)) {
        let list = itemsByThread.get(row.threadId);
        if (!list) {
          list = [];
          itemsByThread.set(row.threadId, list);
        }
        list.push(row);
      }
    }
  }

  // Bounded messages per selected thread (newest T3_MESSAGE_LIMIT in SQL, returned created_at ASC)
  const messagesByThread = new Map();
  if (hasMessages) {
    const msgCols = schema.columns.get('orchestration_v2_projection_messages') || new Set();
    const createdCol = msgCols.has('created_at') ? 'created_at' : 'rowid';
    const msgSelect = `thread_id AS threadId, ${msgCols.has('role') ? 'role' : "''"} AS role, ${msgCols.has('created_at') ? 'created_at' : 'NULL'} AS createdAt, ${msgCols.has('updated_at') ? 'updated_at' : 'NULL'} AS updatedAt, payload_json AS payloadJson`;
    if (threadIds.length === 1) {
      const rows = db.prepare(`
        SELECT ${msgSelect}
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ?
        ORDER BY ${createdCol} DESC, rowid DESC
        LIMIT ?
      `).all(threadIds[0], T3_MESSAGE_LIMIT);
      rows.reverse();
      if (rows.length) messagesByThread.set(threadIds[0], rows);
    } else {
      const msgSql = `
        WITH ranked AS (
          SELECT ${msgSelect}, ${createdCol} AS sortCreated, rowid AS rid,
                 ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ${createdCol} DESC, rowid DESC) AS rn
          FROM orchestration_v2_projection_messages
          WHERE thread_id IN (SELECT value FROM json_each(?))
        )
        SELECT threadId, role, createdAt, updatedAt, payloadJson
        FROM ranked
        WHERE rn <= ?
        ORDER BY threadId ASC, sortCreated ASC, rid ASC
      `;
      for (const row of db.prepare(msgSql).all(idsJson, T3_MESSAGE_LIMIT)) {
        let list = messagesByThread.get(row.threadId);
        if (!list) {
          list = [];
          messagesByThread.set(row.threadId, list);
        }
        list.push(row);
      }
    }
  }

  const records = [];
  for (const row of threadById.values()) {
    const threadPayload = safeJsonParse(row.threadPayloadJson) || {};
    const ptPayload = safeJsonParse(row.ptPayloadJson) || {};
    const latestRun = row.runId != null || row.runStatus != null
      ? {
        runId: row.runId,
        ordinal: row.runOrdinal,
        status: row.runStatus,
        requestedAt: row.runRequestedAt,
        completedAt: row.runCompletedAt,
        payloadJson: row.runPayloadJson,
      }
      : null;
    const runPayload = latestRun ? safeJsonParse(latestRun.payloadJson) || {} : {};

    const nativeId = (typeof ptPayload?.nativeThreadRef?.nativeId === 'string' && ptPayload.nativeThreadRef.nativeId.trim())
      || (typeof row.attemptNative === 'string' && row.attemptNative.trim())
      || row.threadId;
    const sessionId = `zai-${nativeId}`;

    const archivedAt = (typeof row.archivedAt === 'string' && row.archivedAt.trim())
      || (typeof threadPayload.archivedAt === 'string' && threadPayload.archivedAt.trim())
      || null;
    const deletedAt = (typeof row.deletedAt === 'string' && row.deletedAt.trim())
      || (typeof threadPayload.deletedAt === 'string' && threadPayload.deletedAt.trim())
      || null;
    const isArchivedOrDeleted = Boolean(archivedAt || deletedAt);

    // Run lifecycle: honor explicit terminal run status; only fall back to
    // provider_threads.status === 'active' when no run lifecycle row exists.
    const runStatus = latestRun && typeof latestRun.status === 'string' && latestRun.status.trim()
      ? latestRun.status.trim().toLowerCase()
      : null;
    const runActive = Boolean(runStatus && T3_ACTIVE_RUN_STATUS_SET.has(runStatus));
    const ptActive = !runStatus && String(row.ptStatus || '').toLowerCase() === 'active';
    const isLive = !isArchivedOrDeleted && (runActive || ptActive);

    const modelSelection = runPayload?.modelSelection || threadPayload?.modelSelection || null;
    const model = (typeof modelSelection?.model === 'string' && modelSelection.model.trim()) || 'glm';
    const reasoningEffort = extractThoughtLevel(modelSelection);

    const rawProject = (typeof threadPayload.worktreePath === 'string' && threadPayload.worktreePath.trim())
      || (typeof row.workspaceRoot === 'string' && row.workspaceRoot.trim())
      || null;
    const project = rawProject ? (normalizeProjectPath(rawProject) || rawProject) : null;
    const gitBranch = typeof threadPayload.branch === 'string' && threadPayload.branch.trim()
      ? threadPayload.branch.trim().slice(0, 256)
      : null;

    const rawTitle = typeof row.title === 'string' ? row.title.trim().slice(0, 128) : '';
    const userNamed = threadPayload.titleRenamed === true;

    // Parent lineage
    let parentSessionId = null;
    let agentType = 'main';
    let subagentKind = null;
    if (isSubagentLineage(threadPayload.lineage)) {
      const parentAttempt = latestAttemptByThread.get(threadPayload.lineage.parentThreadId.trim());
      const resolvedParent = parentAttempt ? parentSessionIdFor(parentAttempt.provider, parentAttempt.native) : null;
      if (resolvedParent) {
        parentSessionId = resolvedParent;
        agentType = 'sub-agent';
        subagentKind = 'delegate';
      }
    }

    // Token usage from aggregated provider_turns + contextUsage from provider_threads
    const turnSummary = tokenSummaryByThread.get(row.threadId) || null;
    const totalUncachedInput = Math.max(0, Number(turnSummary?.totalUncachedInput) || 0);
    const totalOutput = Math.max(0, Number(turnSummary?.totalOutput) || 0);
    const totalCacheRead = Math.max(0, Number(turnSummary?.totalCacheRead) || 0);
    const totalReasoning = Math.max(0, Number(turnSummary?.totalReasoning) || 0);
    const usageTurnCount = Math.max(0, Number(turnSummary?.usageTurnCount) || 0);
    const lastTurnTotalInput = Math.max(0, Number(turnSummary?.lastTurnTotalInput) || 0);

    const ctxUsage = ptPayload?.contextUsage;
    const contextWindowMax = (Number.isFinite(Number(ctxUsage?.maxTokens)) && Number(ctxUsage.maxTokens) > 0)
      ? Number(ctxUsage.maxTokens)
      : (contextWindowForModel(model, 'zai') || 1_000_000);
    const contextWindow = (Number.isFinite(Number(ctxUsage?.usedTokens)) && Number(ctxUsage.usedTokens) > 0)
      ? Number(ctxUsage.usedTokens)
      : lastTurnTotalInput;

    const tokenUsage = usageTurnCount > 0 || contextWindow > 0 ? {
      availability: 'observed',
      input: totalUncachedInput,
      output: totalOutput,
      totalInput: totalUncachedInput,
      totalOutput: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: 0,
      cacheWrite: 0,
      reasoningTokens: totalReasoning,
      reasoningInOutput: true,
      turnCount: usageTurnCount,
      contextWindow,
      contextWindowMax,
    } : null;

    // Turn items reduction
    const items = itemsByThread.get(row.threadId) || [];
    const observedSources = emptyObservedSources();
    const dialogueRaw = [];
    const workingSetRaw = [];
    const lastResults = [];
    const gitEvents = [];
    const toolHistory = [];
    let todos = [];
    let lastTool = null;
    let lastToolInput = null;
    let lastMessage = null;
    let pendingTool = null;
    let pendingSince = null;
    let errorItem = null;
    let latestItemTs = 0;

    for (const itemRow of items) {
      const p = safeJsonParse(itemRow.payloadJson) || {};
      const itemType = itemRow.type || p.type || '';
      const itemStatus = String(itemRow.status || p.status || '').toLowerCase();
      const startedAt = parseTs(p.startedAt);
      const completedAt = parseTs(p.completedAt);
      const updatedAt = parseTs(itemRow.updatedAt || p.updatedAt);
      const itemTs = Math.max(completedAt, updatedAt, startedAt);
      if (itemTs > latestItemTs) latestItemTs = itemTs;

      const isActiveItem = isLive && T3_ACTIVE_ITEM_STATUSES.has(itemStatus)
        && (!latestRun || !itemRow.runId || itemRow.runId === latestRun.runId);

        if (itemType === 'command_execution') {
          const cmd = typeof p.input === 'string' ? p.input : '';
          const summary = cmd ? stripShellLocationPrefix(cmd).slice(0, 200) : (typeof p.title === 'string' ? p.title.slice(0, 160) : '');
          lastTool = 'run_command';
          lastToolInput = summary || null;
          toolHistory.push({
            tool: 'run_command',
            detail: summary || '',
            input: summary || '',
            ts: startedAt || itemTs || 0,
            ...(Number.isFinite(Number(p.exitCode)) ? { toolExitCode: Number(p.exitCode) } : {}),
            ...(startedAt && completedAt && completedAt >= startedAt ? { durationMs: completedAt - startedAt } : {}),
          });
          if (isActiveItem) {
            pendingTool = 'run_command';
            pendingSince = startedAt || itemTs || null;
          }
          if (itemStatus === 'completed' || itemStatus === 'failed') {
            const hasExit = p.exitCode !== null && p.exitCode !== undefined && Number.isFinite(Number(p.exitCode));
            const exitCode = hasExit ? Number(p.exitCode) : (itemStatus === 'failed' ? 1 : null);
            const exitCodeSource = hasExit ? 'exit' : (itemStatus === 'failed' ? 'flag' : null);
            const doneAt = completedAt || updatedAt || startedAt;
            if (exitCode !== null && doneAt) {
              lastResults.push({
                id: toolResultId({
                  provider: 'zai',
                  sessionId,
                  callId: p.nativeItemRef?.nativeId || p.id || `ord-${itemRow.ordinal}`,
                  tool: 'run_command',
                  detail: summary,
                  completedAt: doneAt,
                }),
                tool: 'run_command',
                detail: summary,
                exitCode,
                exitCodeSource,
                durationMs: startedAt && doneAt >= startedAt ? doneAt - startedAt : null,
                completedAt: doneAt,
                source: 'transcript',
                location: toolResultLocation({ cwd: project, command: cmd }),
                noOutput: typeof p.output === 'string' ? p.output.trim().length === 0 : null,
              });
            }
            if (cmd) {
              const extracted = extractGitEventsFromCommandSource(
                { command: cmd, cwd: project },
                {
                  sessionId,
                  provider: 'zai',
                  project: project || '',
                  cwd: project || '',
                  timestamp: doneAt || startedAt,
                  completedAt: doneAt || undefined,
                  exitCode: exitCode ?? undefined,
                  isError: exitCode !== null ? exitCode !== 0 : itemStatus === 'failed',
                  output: typeof p.output === 'string' ? p.output : '',
                },
              );
              if (Array.isArray(extracted) && extracted.length) gitEvents.push(...extracted);
            }
          }
        } else if (itemType === 'file_change') {
          const fileName = typeof p.fileName === 'string'
            ? p.fileName
            : (typeof p.path === 'string' ? p.path : (typeof p.file_path === 'string' ? p.file_path : null));
          const summary = fileName ? path.basename(fileName) : (typeof p.title === 'string' ? p.title.slice(0, 160) : '');
          lastTool = 'write_file';
          lastToolInput = summary || null;
          toolHistory.push({
            tool: 'write_file',
            detail: summary || '',
            input: summary || '',
            ts: startedAt || itemTs || 0,
          });
          if (fileName) {
            workingSetRaw.push({ path: fileName, op: 'write', at: itemTs || null });
          }
          if (isActiveItem) {
            pendingTool = 'write_file';
            pendingSince = startedAt || itemTs || null;
          }
        } else if (itemType === 'dynamic_tool') {
          const rawToolName = typeof p.toolName === 'string' ? p.toolName.trim() : '';
          const input = p.input && typeof p.input === 'object' ? p.input : null;
          const isTodoCall = Boolean(input && Array.isArray(input.todos))
            || rawToolName.toLowerCase() === 'todowrite'
            || /^task\s+list:/i.test(rawToolName);

          if (isTodoCall && Array.isArray(input?.todos)) {
            const projected = projectT3Todos(input.todos);
            if (projected) {
              todos = projected;
              const activeTodo = input.todos.find(t => String(t?.status || '').toLowerCase() === 'in_progress');
              const planText = activeTodo?.activeForm || activeTodo?.active_form || activeTodo?.content || activeTodo?.subject || null;
              if (typeof planText === 'string' && planText.trim()) {
                observedSources.planStep = true;
                dialogueRaw.push({
                  kind: 'plan',
                  source: 'glm.todowrite',
                  text: planText.trim(),
                  observedAt: itemTs,
                  actionId: p.nativeItemRef?.nativeId || `item-${itemRow.ordinal}`,
                });
              }
            }
            const doneCount = todos.filter(t => t.status === 'completed').length;
            const activeSubject = todos.find(t => t.status === 'in_progress')?.subject;
            const summary = activeSubject
              ? `${activeSubject} (${doneCount}/${todos.length})`.slice(0, 160)
              : (todos.length ? `${doneCount}/${todos.length} todos` : rawToolName.slice(0, 160));
            lastTool = 'todowrite';
            lastToolInput = summary || null;
            toolHistory.push({ tool: 'todowrite', detail: summary || '', input: summary || '', ts: startedAt || itemTs || 0 });
            if (isActiveItem) {
              pendingTool = 'todowrite';
              pendingSince = startedAt || itemTs || null;
            }
          } else {
            const toolName = rawToolName || 'dynamic_tool';
            const lowerTool = toolName.toLowerCase();
            const targetPath = typeof input?.path === 'string'
              ? input.path
              : (typeof input?.file_path === 'string' ? input.file_path : (typeof input?.filePath === 'string' ? input.filePath : null));
            if (targetPath) {
              if (['read', 'read_file', 'view_file'].includes(lowerTool)) {
                workingSetRaw.push({ path: targetPath, op: 'read', at: itemTs || null });
              } else if (['write', 'write_file', 'edit', 'edit_file', 'multiedit'].includes(lowerTool)) {
                workingSetRaw.push({ path: targetPath, op: 'write', at: itemTs || null });
              }
            }
            const summary = summarizeToolInput(input || p.title, { maxLength: 160 }) || (typeof p.title === 'string' ? p.title.slice(0, 160) : '');
            lastTool = toolName;
            lastToolInput = summary || null;
            toolHistory.push({ tool: toolName, detail: summary || '', input: summary || '', ts: startedAt || itemTs || 0 });
            if (isActiveItem) {
              pendingTool = toolName;
              pendingSince = startedAt || itemTs || null;
            }
          }
        } else if (itemType === 'web_search') {
          const query = Array.isArray(p.patterns) && typeof p.patterns[0] === 'string'
            ? p.patterns[0]
            : (typeof p.query === 'string' ? p.query : (typeof p.title === 'string' ? p.title : ''));
          const summary = query.trim().slice(0, 160);
          lastTool = 'web_search';
          lastToolInput = summary || null;
          toolHistory.push({ tool: 'web_search', detail: summary || '', input: summary || '', ts: startedAt || itemTs || 0 });
          if (isActiveItem) {
            pendingTool = 'web_search';
            pendingSince = startedAt || itemTs || null;
          }
        } else if (itemType === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
          observedSources.thinkingPlaintext = true;
          dialogueRaw.push({
            kind: 'thinking',
            source: 'glm.reasoning',
            text: p.text,
            observedAt: itemTs,
            actionId: p.nativeItemRef?.nativeId || `item-${itemRow.ordinal}`,
          });
        } else if (itemType === 'assistant_message' && typeof p.text === 'string' && p.text.trim()) {
          observedSources.assistantText = true;
          lastMessage = p.text.trim().slice(0, 400);
          dialogueRaw.push({
            kind: 'assistant',
            source: 'glm.assistant',
            text: p.text,
            observedAt: itemTs,
            actionId: p.nativeItemRef?.nativeId || `item-${itemRow.ordinal}`,
          });
        } else if (itemType === 'error') {
          if (!latestRun || !itemRow.runId || itemRow.runId === latestRun.runId) {
            errorItem = {
              kind: typeof p.failure?.class === 'string' && p.failure.class.trim() ? p.failure.class.trim() : 'provider_error',
              status: Number.isFinite(Number(p.failure?.code)) ? Number(p.failure.code) : null,
              at: itemTs || null,
            };
          }
        }
      }

      // Messages & lastPrompt
      const rawMessages = messagesByThread.get(row.threadId) || [];
      let lastPrompt = null;
      const detailMessages = [];
      for (const msgRow of rawMessages) {
        const mp = safeJsonParse(msgRow.payloadJson) || {};
        const role = msgRow.role || mp.role || 'assistant';
        const text = typeof mp.text === 'string' ? mp.text : '';
        const ts = parseTs(msgRow.updatedAt || msgRow.createdAt);
        if (role === 'user') {
          const cleaned = cleanT3UserPrompt(text);
          if (cleaned) lastPrompt = cleaned;
          if (cleaned) detailMessages.push({ role: 'user', text: cleaned.slice(0, 1200), ts });
        } else if (role === 'assistant' && text.trim()) {
          if (!lastMessage) lastMessage = text.trim().slice(0, 400);
          detailMessages.push({ role: 'assistant', text: text.trim().slice(0, 1600), ts });
        }
      }

      // Working set deduped newest first
      const workingSet = [];
      const seenPaths = new Set();
      for (let i = workingSetRaw.length - 1; i >= 0 && workingSet.length < 16; i--) {
        const item = workingSetRaw[i];
        const canonical = canonicalWorkingSetPath(item.path, project);
        if (!canonical || seenPaths.has(canonical)) continue;
        seenPaths.add(canonical);
        workingSet.push({ path: canonical, op: item.op, at: item.at || 0, source: 'transcript' });
      }

      const dialogueCandidates = [];
      for (const raw of dialogueRaw.slice(-24)) {
        const candidate = makeDialogue({
          text: raw.text,
          kind: raw.kind,
          source: raw.source,
          observedAt: raw.observedAt,
          actionId: raw.actionId,
          project,
        });
        if (candidate) dialogueCandidates.push(candidate);
      }

      // Run lifecycle & turn state
      const turnStartedAt = parseTs(runPayload.startedAt || latestRun?.requestedAt) || null;
      const runCompletedAt = parseTs(latestRun?.completedAt || runPayload.completedAt) || null;
      const lastActivity = Math.max(
        parseTs(row.threadUpdatedAt),
        parseTs(row.ptUpdatedAt),
        parseTs(latestRun?.completedAt),
        parseTs(runPayload.startedAt),
        parseTs(latestRun?.requestedAt),
        latestItemTs,
      );

      let turn;
      if (isLive && runStatus === 'waiting') {
        turn = deriveTurnState({
          pendingTool: pendingTool || lastTool || 'waiting',
          pendingSince: pendingSince || turnStartedAt || lastActivity,
        });
      } else if (isLive) {
        if (pendingTool) {
          turn = deriveTurnState({ pendingTool, pendingSince: pendingSince || turnStartedAt || lastActivity });
        } else {
          turn = deriveTurnState({ turnEnded: false });
        }
      } else if (runStatus && T3_ENDED_RUN_STATUSES.has(runStatus)) {
        turn = deriveTurnState({ turnEnded: true, turnEndedAt: runCompletedAt || lastActivity || null });
      } else {
        turn = deriveTurnState({ known: false });
      }

      const lastTurnDurationMs = runStatus === 'completed' && turnStartedAt && runCompletedAt && runCompletedAt >= turnStartedAt
        ? runCompletedAt - turnStartedAt
        : null;

      const apiError = runStatus && T3_FAILED_RUN_STATUSES.has(runStatus)
        ? (errorItem || { kind: 'provider_error', status: null, at: runCompletedAt || lastActivity || null })
        : null;

      const dedupedGitEvents = gitEvents.length ? dedupeGitEvents(gitEvents) : [];
      const normalizedResults = normalizeToolResults(lastResults);

      records.push({
        threadId: row.threadId,
        nativeId,
        isLive,
        isArchivedOrDeleted,
        lastActivity,
        dialogueCandidates,
        session: {
          sessionId,
          provider: 'zai',
          agentId: nativeId,
          agentType,
          agentName: rawTitle || null,
          userNamed,
          headless: Boolean(parentSessionId),
          model,
          reasoningEffort,
          status: 'active',
          lastActivity,
          project,
          gitBranch,
          ...turn,
          turnStartedAt,
          lastTurnDurationMs,
          apiError,
          lastTool,
          lastToolInput,
          lastMessage,
          lastPrompt,
          dialogue: null,
          observedSources,
          workingSet,
          lastResults: normalizedResults,
          gitEvents: dedupedGitEvents,
          todos,
          tokenUsage,
          contextWindowMax,
          parentSessionId,
          rootSessionId: parentSessionId,
          subagentKind,
          signalSource: 'transcript',
        },
        detail: createDetailResponse({
          provider: 'zai',
          sessionId,
          project: project || '',
          agentName: rawTitle || null,
          toolHistory: toolHistory.slice(-120),
          messages: detailMessages.slice(-50),
          tokenUsage,
          gitEvents: dedupedGitEvents,
        }),
      });
    }

  return records;
}

function readCachedAcpGlmDiscoveryRecordsForPath(dbPath, { cutoffMs = null, keepNativeIds = [] } = {}) {
  const cache = syncCacheForPath(dbPath);
  if (!cache) return [];
  const keepKey = JSON.stringify(keepNativeIds);
  const cached = cache.glmDiscovery.get(keepKey);
  if (cached && (cached.cutoffMs === null || (cutoffMs !== null && cutoffMs >= cached.cutoffMs))) {
    return cached.records;
  }
  const value = withStateDb(dbPath, db => {
    const schema = readSchemaInfo(db, cache);
    return queryT3AcpGlmRecords(db, schema, {
      cutoffMs,
      keepNativeIds,
      includeArchived: false,
      detailTarget: null,
    });
  }, T3_QUERY_FAILED);
  if (value === T3_QUERY_FAILED) return [];
  if (cache.glmDiscovery.size >= T3_DISCOVERY_CACHE_MAX) {
    cache.glmDiscovery.delete(cache.glmDiscovery.keys().next().value);
  }
  cache.glmDiscovery.set(keepKey, { cutoffMs, records: value });
  return value;
}

function readT3AcpGlmSessions(activeThresholdMs, { now = Date.now(), keepSessionIds = null, source = 'all' } = {}) {
  const threshold = activeThresholdMs == null ? null : Math.max(0, Number(activeThresholdMs) || 0);
  const cutoffMs = threshold == null ? null : (now - threshold);
  const keepNativeIds = normalizeKeepGlmNativeIds(keepSessionIds);
  const bySessionId = new Map();
  for (const dbPath of resolveSourceDbPaths(source)) {
    const records = readCachedAcpGlmDiscoveryRecordsForPath(dbPath, { cutoffMs, keepNativeIds });
    for (const record of records) {
      if (record.isArchivedOrDeleted) continue;
      const keep = record.isLive || Boolean(keepSessionIds?.has(record.session.sessionId));
      if (!keep && threshold != null && (now - record.lastActivity > threshold)) continue;
      const dialogue = pickDialogue(record.dialogueCandidates, { now });
      const session = {
        ...record.session,
        dialogue: dialogue ? { ...dialogue } : null,
        observedSources: { ...record.session.observedSources },
        workingSet: record.session.workingSet.map(item => ({ ...item })),
        lastResults: record.session.lastResults.map(item => ({ ...item })),
        gitEvents: record.session.gitEvents.slice(),
        todos: record.session.todos.map(item => ({ ...item })),
        tokenUsage: record.session.tokenUsage ? { ...record.session.tokenUsage } : null,
      };
      const prev = bySessionId.get(session.sessionId);
      if (!prev || (session.lastActivity || 0) >= (prev.lastActivity || 0)) {
        bySessionId.set(session.sessionId, session);
      }
    }
  }
  return [...bySessionId.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

function readT3AcpGlmSessionDetail(nativeId, project = null, { source = 'all' } = {}) {
  const target = String(nativeId || '').trim().toLowerCase();
  if (!target) return null;
  // Prefer Hobotnica over T3 when both exist so the active harness wins.
  const paths = resolveSourceDbPaths(source).slice().reverse();
  for (const dbPath of paths) {
    const records = cachedStateQuery(dbPath, `acpGlmDetail:${target}`, (db, schema) => queryT3AcpGlmRecords(db, schema, {
      cutoffMs: null,
      keepNativeIds: [],
      includeArchived: true,
      detailTarget: target,
    }), []);
    const match = records.find(r => r.nativeId.toLowerCase() === target || r.threadId.toLowerCase() === target);
    if (!match) continue;
    return {
      ...match.detail,
      project: match.detail.project || project || '',
      toolHistory: match.detail.toolHistory.map(item => ({ ...item })),
      messages: match.detail.messages.map(item => ({ ...item })),
      gitEvents: match.detail.gitEvents.slice(),
      tokenUsage: match.detail.tokenUsage ? { ...match.detail.tokenUsage } : null,
    };
  }
  return null;
}

module.exports = {
  T3_ACTIVE_RUN_STATUSES,
  T3_PARENT_PREFIX,
  clearT3Cache,
  cleanT3UserPrompt,
  hobotnicaHomeDir,
  hobotnicaStateDbExists,
  hobotnicaStateDbPath,
  hobotnicaStateSignature,
  hobotnicaUserDataDir,
  projectT3Todos,
  queryT3State,
  readT3AcpGlmSessionDetail,
  readT3AcpGlmSessions,
  readT3ActiveDelegates,
  readT3ActiveRunNativeIds,
  readT3Lineage,
  readT3RenamedTitles,
  readT3RootThreadState,
  t3StateDbExists,
  t3StateDbPath,
  t3StateSignature,
  t3UserDataDir,
};
