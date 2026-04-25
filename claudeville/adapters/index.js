/**
 * Adapter registry
 * Registers and manages all AI coding CLI adapters
 */
const { ClaudeAdapter } = require('./claude');
const { CodexAdapter } = require('./codex');
const { GeminiAdapter } = require('./gemini');

const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
];

/**
 * Collect sessions from all active adapters
 */
function getAllSessions(activeThresholdMs) {
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
  return allSessions.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Fetch session details for a specific provider
 */
function getSessionDetailByProvider(provider, sessionId, project) {
  const adapter = adapters.find(a => a.provider === provider);
  if (!adapter) return { toolHistory: [], messages: [] };
  try {
    return adapter.getSessionDetail(sessionId, project);
  } catch (err) {
    console.error(`[${adapter.name}] Failed to fetch session details:`, err.message);
    return { toolHistory: [], messages: [] };
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
      paths.push(...adapter.getWatchPaths());
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
  getAllWatchPaths,
  getActiveProviders,
};
