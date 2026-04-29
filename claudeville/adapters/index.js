/**
 * Adapter registry
 * Registers and manages all AI coding CLI adapters
 */
const { ClaudeAdapter } = require('./claude');
const { CodexAdapter } = require('./codex');
const { GeminiAdapter } = require('./gemini');
const { execFileSync } = require('child_process');
const {
  getGitEnrichmentPerfStats,
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
  isGitEnrichmentDisabled,
} = require('./gitEvents');

const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
];

const ADAPTER_BY_PROVIDER = Object.fromEntries(adapters.map((adapter) => [adapter.provider, adapter]));
const SYNTHETIC_PROVIDERS = Object.freeze([
  {
    provider: 'git',
    name: 'Git Repository',
    homeDir: null,
    synthetic: true,
    supportsDetail: true,
    supportsWatchPaths: false,
    detailReason: 'Synthetic repository git sessions do not have provider transcript details.',
  },
]);
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

function normalizeProviderId(provider, fallback = 'claude') {
  return String(provider || fallback).toLowerCase();
}

function normalizeSession(session, context = {}) {
  const provider = normalizeProviderId(session?.provider, context.provider || 'unknown');
  return {
    ...session,
    sessionId: String(session?.sessionId || ''),
    provider,
    agentId: session?.agentId ?? null,
    agentType: session?.agentType || 'main',
    agentName: session?.agentName ?? session?.name ?? null,
    project: session?.project ?? null,
    model: session?.model || provider,
    status: session?.status || 'active',
    lastActivity: Number(session?.lastActivity) || 0,
    lastTool: session?.lastTool ?? null,
    lastToolInput: session?.lastToolInput ?? null,
    lastMessage: session?.lastMessage ?? null,
    tokenUsage: session?.tokenUsage ?? session?.tokens ?? session?.usage ?? null,
    parentSessionId: session?.parentSessionId ?? null,
    reasoningEffort: session?.reasoningEffort ?? null,
    gitEvents: Array.isArray(session?.gitEvents) ? session.gitEvents : [],
  };
}

function normalizeDetail(detail, context = {}) {
  const value = detail && typeof detail === 'object' ? detail : {};
  return {
    ...value,
    provider: normalizeProviderId(value.provider, context.provider || 'claude'),
    sessionId: String(value.sessionId || context.sessionId || ''),
    project: value.project ?? context.project ?? '',
    toolHistory: Array.isArray(value.toolHistory) ? value.toolHistory : [],
    messages: Array.isArray(value.messages) ? value.messages : [],
    tokenUsage: value.tokenUsage ?? value.tokens ?? value.usage ?? null,
    gitEvents: Array.isArray(value.gitEvents) ? value.gitEvents : [],
    agentName: value.agentName ?? value.name ?? null,
  };
}

function getAdapterMetadata({ includeUnavailable = true } = {}) {
  const adapterMetadata = adapters
    .filter((adapter) => includeUnavailable || adapter.isAvailable())
    .map((adapter) => ({
      name: adapter.name,
      provider: adapter.provider,
      homeDir: adapter.homeDir,
      synthetic: false,
      supportsDetail: typeof adapter.getSessionDetail === 'function',
      supportsWatchPaths: typeof adapter.getWatchPaths === 'function',
    }));
  return [...adapterMetadata, ...SYNTHETIC_PROVIDERS];
}

function isKnownSessionDetailProvider(provider) {
  const normalizedProvider = normalizeProviderId(provider, '');
  return getAdapterMetadata()
    .some((metadata) => metadata.provider === normalizedProvider && metadata.supportsDetail);
}

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
      if (!Array.isArray(sessions)) continue;
      allSessions.push(...sessions.map((session) => normalizeSession(session, { provider: adapter.provider })));
    } catch (err) {
      console.error(`[${adapter.name}] Failed to fetch sessions:`, err.message);
    }
  }
  const repositoryScanProjects = isGitEnrichmentDisabled() ? [] : getRepositoryScanProjects();
  const sessions = inferPushedGitEventsForSessions(inferUnpushedGitEventsForSessions(allSessions, {
    projects: repositoryScanProjects,
  }))
    .map((session) => normalizeSession(session))
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
  provider = normalizeProviderId(provider);
  const key = `${provider}::${sessionId}::${project || ''}`;
  const cached = _sessionDetailCache.get(key);

  if (!force && cached && (now - cached.at) < SESSION_DETAIL_CACHE_TTL_MS) {
    _sessionDetailCache.delete(key);
    _sessionDetailCache.set(key, cached);
    return cached.value;
  }

  const adapter = ADAPTER_BY_PROVIDER[provider];
  if (!adapter) {
    return normalizeDetail({
      reason: SYNTHETIC_PROVIDERS.find((metadata) => metadata.provider === provider)?.detailReason || 'No adapter detail provider is registered.',
    }, { provider, sessionId, project });
  }

  try {
    const value = normalizeDetail(adapter.getSessionDetail(sessionId, project), { provider, sessionId, project });
    _sessionDetailCache.set(key, { value, at: now });
    _trimSessionDetailCache();
    return value;
  } catch (err) {
    console.error(`[${adapter.name}] Failed to fetch session details:`, err.message);
    return cached?.value || normalizeDetail(null, { provider, sessionId, project });
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
    synthetic: false,
    supportsDetail: typeof a.getSessionDetail === 'function',
    supportsWatchPaths: typeof a.getWatchPaths === 'function',
  }));
}

function getAdapterPerfStats() {
  const stats = {};
  for (const adapter of adapters) {
    if (typeof adapter.getPerfStats !== 'function') continue;
    try {
      stats[adapter.provider] = adapter.getPerfStats();
    } catch (err) {
      stats[adapter.provider] = {
        error: err?.message || 'Unable to collect adapter perf stats',
      };
    }
  }
  return stats;
}

module.exports = {
  adapters,
  getAdapterMetadata,
  getAllSessions,
  getSessionDetailByProvider,
  getSessionDetailsBatch,
  getAllWatchPaths,
  getActiveProviders,
  getAdapterPerfStats,
  getGitEnrichmentPerfStats,
  isKnownSessionDetailProvider,
  invalidateSessionCaches,
  normalizeDetail,
  normalizeSession,
};
