/**
 * Adapter registry
 * Registers and manages all AI coding CLI adapters
 */
const { ClaudeAdapter } = require('./claude');
const { CodexAdapter } = require('./codex');
const { GeminiAdapter } = require('./gemini');
const { execFileSync } = require('child_process');
const {
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
} = require('./gitEvents');

const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
];

const ADAPTER_BY_PROVIDER = Object.fromEntries(adapters.map((adapter) => [adapter.provider, adapter]));
const SESSION_LIST_CACHE_TTL_MS = 5000;
const SESSION_DETAIL_CACHE_TTL_MS = 5000;
const SESSION_DETAIL_MAX_CACHE = 256;
const REPOSITORY_SCAN_CACHE_TTL_MS = 5000;

const _sessionListCache = {
  at: 0,
  threshold: null,
  sessions: [],
};

const _sessionDetailCache = new Map();
const _repositoryScanCache = {
  at: 0,
  projects: [],
};

function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 750,
  }).trim();
}

function getRepositoryScanProjects() {
  const now = Date.now();
  if ((now - _repositoryScanCache.at) < REPOSITORY_SCAN_CACHE_TTL_MS) {
    return _repositoryScanCache.projects;
  }

  const projects = [];
  try {
    const root = runGit(['rev-parse', '--show-toplevel']);
    if (root) projects.push(root);
  } catch {
    // ClaudeVille can run outside a git checkout, so repo scanning is optional.
  }

  _repositoryScanCache.at = now;
  _repositoryScanCache.projects = [...new Set(projects)];
  return _repositoryScanCache.projects;
}

/**
 * Collect sessions from all active adapters
 */
function getAllSessions(activeThresholdMs, { force = false } = {}) {
  const now = Date.now();
  if (!force && _sessionListCache.threshold === activeThresholdMs && (now - _sessionListCache.at) < SESSION_LIST_CACHE_TTL_MS) {
    return _sessionListCache.sessions;
  }

  const allSessions = [];
  for (const adapter of adapters) {
    if (!adapter.isAvailable()) continue;
    try {
      const sessions = adapter.getActiveSessions(activeThresholdMs);
      allSessions.push(...sessions);
    } catch (err) {
      console.error(`[${adapter.name}] Failed to fetch sessions:`, err.message);
    }
  }
  const sessions = inferPushedGitEventsForSessions(inferUnpushedGitEventsForSessions(allSessions, {
    projects: getRepositoryScanProjects(),
  }))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  _sessionListCache.at = now;
  _sessionListCache.threshold = activeThresholdMs;
  _sessionListCache.sessions = sessions;
  return sessions;
}

/**
 * Fetch session details for a specific provider
 */
function getSessionDetailByProvider(provider, sessionId, project, { force = false } = {}) {
  const now = Date.now();
  const key = `${provider}::${sessionId}::${project || ''}`;
  const cached = _sessionDetailCache.get(key);

  if (!force && cached && (now - cached.at) < SESSION_DETAIL_CACHE_TTL_MS) {
    _sessionDetailCache.delete(key);
    _sessionDetailCache.set(key, cached);
    return cached.value;
  }

  const adapter = ADAPTER_BY_PROVIDER[provider];
  if (!adapter) return { toolHistory: [], messages: [] };

  try {
    const value = adapter.getSessionDetail(sessionId, project);
    _sessionDetailCache.set(key, { value, at: now });
    _trimSessionDetailCache();
    return value;
  } catch (err) {
    console.error(`[${adapter.name}] Failed to fetch session details:`, err.message);
    return cached?.value || { toolHistory: [], messages: [] };
  }
}

function getSessionDetailsBatch(items = [], { force = false } = {}) {
  const results = {};
  for (const item of items) {
    const provider = String(item?.provider || 'claude').toLowerCase();
    const sessionId = String(item?.sessionId || '');
    const project = String(item?.project || '');
    if (!sessionId) continue;
    const key = item.key || `${provider}::${sessionId}::${project}`;
    results[key] = getSessionDetailByProvider(provider, sessionId, project, { force });
  }
  return results;
}

function invalidateSessionCaches({ details = true, provider = null } = {}) {
  const normalizedProvider = provider ? String(provider).toLowerCase() : null;
  const scopedProvider = normalizedProvider && ADAPTER_BY_PROVIDER[normalizedProvider]
    ? normalizedProvider
    : null;
  _sessionListCache.at = 0;
  _sessionListCache.threshold = null;
  _sessionListCache.sessions = [];

  if (details) {
    if (scopedProvider) {
      for (const key of _sessionDetailCache.keys()) {
        if (key.startsWith(`${scopedProvider}::`)) {
          _sessionDetailCache.delete(key);
        }
      }
    } else {
      _sessionDetailCache.clear();
    }
  }

  const adaptersToInvalidate = scopedProvider
    ? [ADAPTER_BY_PROVIDER[scopedProvider]]
    : adapters;

  for (const adapter of adaptersToInvalidate) {
    try {
      adapter.invalidateCaches?.();
    } catch {
      // Adapter-local cache invalidation is best effort.
    }
  }
}

function _trimSessionDetailCache() {
  if (_sessionDetailCache.size <= SESSION_DETAIL_MAX_CACHE) return;
  const removeCount = _sessionDetailCache.size - SESSION_DETAIL_MAX_CACHE;
  for (let i = 0; i < removeCount; i++) {
    const oldest = _sessionDetailCache.keys().next().value;
    if (oldest === undefined) break;
    _sessionDetailCache.delete(oldest);
  }
}

/**
 * Collect watch paths from all active adapters
 */
function getAllWatchPaths() {
  const paths = [];
  for (const adapter of adapters) {
    if (!adapter.isAvailable()) continue;
    try {
      paths.push(...adapter.getWatchPaths().map((watchPath) => ({
        ...watchPath,
        provider: adapter.provider,
      })));
    } catch {
      // ignore
    }
  }
  return paths;
}

/**
 * Active adapter list
 */
function getActiveProviders() {
  return adapters.filter(a => a.isAvailable()).map(a => ({
    name: a.name,
    provider: a.provider,
    homeDir: a.homeDir,
  }));
}

module.exports = {
  adapters,
  getAllSessions,
  getSessionDetailByProvider,
  getSessionDetailsBatch,
  getAllWatchPaths,
  getActiveProviders,
  invalidateSessionCaches,
};
