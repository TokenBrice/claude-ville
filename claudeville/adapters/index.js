/**
 * Adapter registry
 * Registers and manages all AI coding CLI adapters
 */
const { ClaudeAdapter } = require('./claude');
const { CodexAdapter } = require('./codex');
const { GeminiAdapter } = require('./gemini');
const { GrokAdapter } = require('./grok');
const { KimiAdapter } = require('./kimi');
const { OpenCodeAdapter } = require('./opencode');
const { OmpAdapter } = require('./omp');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getJsonlDiagnostics, trimCache } = require('./shared');
const { decorateSessionPresentation } = require('./sessionPresentation');
const { normalizeDialogue, normalizeObservedSources } = require('./dialogue');
const {
  getGitEnrichmentPerfStats,
  invalidateGitStatusCaches,
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
  isGitEnrichmentDisabled,
} = require('./gitEvents');

const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
  new GrokAdapter(),
  new KimiAdapter(),
  new OpenCodeAdapter(),
  new OmpAdapter(),
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
// Aligned with the server's 2s BROADCAST_POLL_INTERVAL so interval broadcasts
// never serve a list staler than one poll tick.
const SESSION_LIST_CACHE_TTL_MS = 2000;
const SESSION_DETAIL_CACHE_TTL_MS = 5000;
const SESSION_DETAIL_MAX_CACHE = 256;
// Repository discovery is a cold fallback, not active-session state. Watcher
// descriptors and per-project Git signatures handle live changes, so avoid
// rescanning the checkout root (and spawning rev-parse) every five seconds.
const REPOSITORY_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const REPOSITORY_SCAN_MAX_PROJECTS = Math.max(1, Number(process.env.CLAUDEVILLE_REPOSITORY_SCAN_MAX || 80) || 80);
const DIRTY_KINDS = new Set(['transcript', 'discovery', 'metadata', 'teams', 'git', 'reconcile']);
const REPOSITORY_SCAN_ROOT = process.env.CLAUDEVILLE_REPOSITORY_SCAN_ROOT
  || path.join(os.homedir(), 'Documents', 'git');
const ERROR_CODE_MAX_LENGTH = 48;

const _providerHealth = new Map(adapters.map((adapter) => [adapter.provider, {
  id: adapter.provider,
  name: adapter.name,
  health: 'unavailable',
  sessions: 0,
  lastScanStartedAt: null,
  lastSuccessAt: null,
  errorCode: null,
  watchState: 'unavailable',
  skippedLines: 0,
}]));

const _sessionListCache = {
  at: 0,
  threshold: null,
  sessions: [],
};
const _sessionsByProvider = new Map();
const _dirtySessionProviders = new Set();

const _sessionDetailCache = new Map();
const _repositoryScanCache = {
  at: 0,
  projects: [],
};

function boundedErrorCode(err, fallback) {
  const source = typeof err?.code === 'string' && err.code ? err.code : fallback;
  const normalized = String(source || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || fallback).slice(0, ERROR_CODE_MAX_LENGTH);
}

function providerSkippedLines(provider) {
  const count = Number(getJsonlDiagnostics()[provider]?.skippedLines);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function updateProviderHealth(adapter, updates) {
  const current = _providerHealth.get(adapter.provider);
  if (!current) return;
  Object.assign(current, updates, {
    skippedLines: providerSkippedLines(adapter.provider),
  });
}

function recordProviderUnavailable(adapter) {
  updateProviderHealth(adapter, {
    health: 'unavailable',
    sessions: 0,
    errorCode: null,
    watchState: 'unavailable',
  });
}

function recordProviderFailure(adapter, errorCode, updates = {}) {
  updateProviderHealth(adapter, {
    health: 'degraded',
    errorCode,
    ...updates,
  });
}

function getProviderHealth() {
  return adapters.map((adapter) => ({ ..._providerHealth.get(adapter.provider) }));
}

function normalizeProviderId(provider, fallback = 'claude') {
  return String(provider || fallback).toLowerCase();
}

function normalizeSession(session, context = {}) {
  const provider = normalizeProviderId(session?.provider, context.provider || 'unknown');
  return decorateSessionPresentation({
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
    // Provenance-tagged speech. Adapters that cannot supply it normalize to
    // null dialogue with every observed source false, so the world view stays
    // silent instead of inventing a line.
    dialogue: normalizeDialogue(session?.dialogue),
    observedSources: normalizeObservedSources(session?.observedSources),
    tokenUsage: session?.tokenUsage ?? session?.tokens ?? session?.usage ?? null,
    parentSessionId: session?.parentSessionId ?? null,
    reasoningEffort: session?.reasoningEffort ?? null,
    workflowId: session?.workflowId ?? null,
    workflowName: session?.workflowName ?? null,
    permissionMode: session?.permissionMode ?? null,
    turnState: session?.turnState ?? 'unknown',
    pendingTool: session?.pendingTool ?? null,
    pendingSince: Number.isFinite(Number(session?.pendingSince)) ? Number(session.pendingSince) : null,
    awaitingSince: Number.isFinite(Number(session?.awaitingSince)) ? Number(session.awaitingSince) : null,
    waitReason: session?.waitReason ?? null,
    resident: session?.resident === true,
    sendMessages: Array.isArray(session?.sendMessages) ? session.sendMessages : [],
    gitEvents: Array.isArray(session?.gitEvents) ? session.gitEvents : [],
  });
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

function resolveGitConfigPath(project) {
  try {
    const dotGit = path.join(project, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return path.join(dotGit, 'config');
    if (!stat.isFile()) return null;

    const content = fs.readFileSync(dotGit, 'utf8');
    const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/im);
    if (!match) return null;
    const gitDir = path.resolve(project, match[1]);
    return path.join(gitDir, 'config');
  } catch {
    return null;
  }
}

function hasGitHubRemote(project) {
  const configPath = resolveGitConfigPath(project);
  if (!configPath) return false;

  try {
    const config = fs.readFileSync(configPath, 'utf8');
    return /url\s*=\s*.*github\.com[:/]/i.test(config);
  } catch {
    return false;
  }
}

function discoverGitHubProjects(root) {
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const candidate = path.join(root, entry.name);
    let stat = null;
    try {
      stat = entry.isSymbolicLink() ? fs.statSync(candidate) : null;
    } catch {
      continue;
    }
    if (!entry.isDirectory() && !(stat && stat.isDirectory())) continue;
    if (!hasGitHubRemote(candidate)) continue;
    projects.push(candidate);
    if (projects.length >= REPOSITORY_SCAN_MAX_PROJECTS) break;
  }
  return projects;
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
  projects.push(...discoverGitHubProjects(REPOSITORY_SCAN_ROOT));

  _repositoryScanCache.at = now;
  _repositoryScanCache.projects = [...new Set(projects)];
  return _repositoryScanCache.projects;
}

/**
 * Collect sessions from all active adapters
 */
function getAllSessions(activeThresholdMs, { force = false } = {}) {
  const now = Date.now();
  const canRefreshProviders = !force
    && _sessionListCache.threshold === activeThresholdMs
    && (now - _sessionListCache.at) < SESSION_LIST_CACHE_TTL_MS;
  if (canRefreshProviders && _dirtySessionProviders.size === 0) {
    return _sessionListCache.sessions;
  }

  const adaptersToScan = canRefreshProviders
    ? adapters.filter((adapter) => _dirtySessionProviders.has(adapter.provider))
    : adapters;
  const refreshedProviders = new Set(adaptersToScan.map((adapter) => adapter.provider));
  // TTL expiry still reconciles every adapter. Within that window, refresh only
  // dirty provider slices, then merge them in the original adapter order.
  for (const adapter of adaptersToScan) {
    _sessionsByProvider.set(adapter.provider, []);
    const lastScanStartedAt = Date.now();
    let available = false;
    try {
      available = adapter.isAvailable();
    } catch (err) {
      recordProviderFailure(adapter, boundedErrorCode(err, 'ADAPTER_AVAILABILITY_FAILED'), {
        sessions: 0,
        lastScanStartedAt,
      });
      console.error(`[${adapter.name}] Failed to check availability:`, err.message);
      continue;
    }
    if (!available) {
      updateProviderHealth(adapter, { lastScanStartedAt });
      recordProviderUnavailable(adapter);
      continue;
    }
    try {
      const sessions = adapter.getActiveSessions(activeThresholdMs);
      if (!Array.isArray(sessions)) {
        recordProviderFailure(adapter, 'INVALID_SESSION_RESULT', {
          sessions: 0,
          lastScanStartedAt,
        });
        continue;
      }
      _sessionsByProvider.set(
        adapter.provider,
        sessions.map((session) => normalizeSession(session, { provider: adapter.provider })),
      );
      const lastSuccessAt = Date.now();
      updateProviderHealth(adapter, {
        health: sessions.length > 0 ? 'healthy' : 'empty',
        sessions: sessions.length,
        lastScanStartedAt,
        lastSuccessAt,
        errorCode: null,
        watchState: _providerHealth.get(adapter.provider)?.watchState === 'unavailable'
          ? 'pending'
          : _providerHealth.get(adapter.provider)?.watchState,
      });
    } catch (err) {
      recordProviderFailure(adapter, boundedErrorCode(err, 'ADAPTER_READ_FAILED'), {
        sessions: 0,
        lastScanStartedAt,
      });
      console.error(`[${adapter.name}] Failed to fetch sessions:`, err.message);
    }
  }
  const allSessions = adapters.flatMap((adapter) => _sessionsByProvider.get(adapter.provider) || []);
  const repositoryScanProjects = isGitEnrichmentDisabled() ? [] : getRepositoryScanProjects();
  const sessions = inferPushedGitEventsForSessions(inferUnpushedGitEventsForSessions(allSessions, {
    projects: repositoryScanProjects,
  }))
    .map((session) => normalizeSession(session))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  _sessionListCache.at = Date.now();
  _sessionListCache.threshold = activeThresholdMs;
  _sessionListCache.sessions = sessions;
  if (canRefreshProviders) {
    for (const provider of refreshedProviders) _dirtySessionProviders.delete(provider);
  } else {
    _dirtySessionProviders.clear();
  }
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

function normalizeDirtyDescriptor(dirty, provider = null) {
  const value = dirty && typeof dirty === 'object' ? dirty : {};
  const providerValue = value.provider || provider;
  const normalizedProvider = providerValue
    ? normalizeProviderId(providerValue, '')
    : null;
  return {
    provider: normalizedProvider || null,
    path: value.path ? path.resolve(String(value.path)) : null,
    kind: DIRTY_KINDS.has(value.kind) ? value.kind : 'reconcile',
    reason: String(value.reason || 'cache-invalidation'),
    sessionId: value.sessionId ? String(value.sessionId) : null,
    project: value.project ? path.resolve(String(value.project)) : null,
  };
}

function invalidateSessionCaches({ details = true, provider = null, dirty = null } = {}) {
  const descriptor = normalizeDirtyDescriptor(dirty, provider);
  const normalizedProvider = descriptor.provider;
  const scopedProvider = normalizedProvider && ADAPTER_BY_PROVIDER[normalizedProvider]
    ? normalizedProvider
    : null;
  const isProviderScoped = !!scopedProvider && descriptor.kind !== 'reconcile';
  if (isProviderScoped) {
    _dirtySessionProviders.add(scopedProvider);
  } else {
    _sessionListCache.at = 0;
    _sessionListCache.threshold = null;
    _sessionListCache.sessions = [];
    _sessionsByProvider.clear();
    _dirtySessionProviders.clear();
  }

  if (descriptor.kind === 'git' && (descriptor.project || descriptor.path)) {
    invalidateGitStatusCaches({ project: descriptor.project || descriptor.path });
  }

  if (details) {
    if (descriptor.kind === 'git' && (descriptor.project || descriptor.path)) {
      const project = descriptor.project || descriptor.path;
      for (const key of _sessionDetailCache.keys()) {
        if (key.endsWith(`::${project}`)) _sessionDetailCache.delete(key);
      }
    } else if (scopedProvider && descriptor.sessionId) {
      const prefix = `${scopedProvider}::${descriptor.sessionId}::`;
      for (const key of _sessionDetailCache.keys()) {
        if (key.startsWith(prefix)) _sessionDetailCache.delete(key);
      }
    } else if (scopedProvider) {
      for (const key of _sessionDetailCache.keys()) {
        if (key.startsWith(`${scopedProvider}::`)) {
          _sessionDetailCache.delete(key);
        }
      }
    } else if (descriptor.kind !== 'git') {
      _sessionDetailCache.clear();
    }
  }

  const adaptersToInvalidate = isProviderScoped
    ? [ADAPTER_BY_PROVIDER[scopedProvider]]
    : (['discovery', 'metadata', 'reconcile'].includes(descriptor.kind) ? adapters : []);

  for (const adapter of adaptersToInvalidate) {
    try {
      if (typeof adapter.invalidateCachesForDirty === 'function') {
        adapter.invalidateCachesForDirty(descriptor);
      } else if (descriptor.kind !== 'transcript' && descriptor.kind !== 'git' && descriptor.kind !== 'teams') {
        adapter.invalidateCaches?.();
      }
    } catch {
      // Adapter-local cache invalidation is best effort.
    }
  }
}

function setAdapterDataReadyCallback(callback) {
  for (const adapter of adapters) {
    try {
      adapter.setDataReadyCallback?.(callback);
    } catch {
      // Optional adapter completion notifications are best effort.
    }
  }
}

function _trimSessionDetailCache() {
  trimCache(_sessionDetailCache, SESSION_DETAIL_MAX_CACHE);
}

/**
 * Collect watch paths from all active adapters
 */
function getAllWatchPaths({ sessions = [], activeThresholdMs = null } = {}) {
  const paths = [];
  for (const adapter of adapters) {
    let available = false;
    try {
      available = adapter.isAvailable();
    } catch (err) {
      recordProviderFailure(adapter, boundedErrorCode(err, 'ADAPTER_AVAILABILITY_FAILED'), {
        watchState: 'failed',
      });
      continue;
    }
    if (!available) {
      recordProviderUnavailable(adapter);
      continue;
    }
    try {
      const providerSessions = sessions.filter((session) => session?.provider === adapter.provider);
      const watchPaths = adapter.getWatchPaths({
        sessions: providerSessions,
        activeThresholdMs,
      });
      paths.push(...watchPaths.map((watchPath) => ({
        ...watchPath,
        provider: adapter.provider,
      })));
      updateProviderHealth(adapter, {
        watchState: watchPaths.length > 0 ? 'watching' : 'idle',
      });
    } catch (err) {
      recordProviderFailure(adapter, boundedErrorCode(err, 'ADAPTER_WATCH_FAILED'), {
        watchState: 'failed',
      });
    }
  }
  return paths;
}

/**
 * Active adapter list
 */
function getActiveProviders() {
  return getAdapterMetadata({ includeUnavailable: false })
    .filter((metadata) => !metadata.synthetic);
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
  getProviderHealth,
  getAdapterPerfStats,
  getGitEnrichmentPerfStats,
  getJsonlDiagnostics,
  isKnownSessionDetailProvider,
  invalidateSessionCaches,
  normalizeDirtyDescriptor,
  normalizeDetail,
  normalizeSession,
  setAdapterDataReadyCallback,
};
