// Transient in-memory push telemetry helper for Hobotnica (`hobotnica-telemetry.v1`).
//
// Helper-plus-fold architecture: this module is NOT a registered disk adapter.
// It stores instance-scoped push frames (snapshot chunks, deltas, heartbeats,
// clears), overlays live telemetry onto existing disk sessions by canonical ID
// without spawning duplicates, synthesizes diskless GLM (`zai-hbt-<threadId>`)
// sessions, resolves cross-provider wave parent links (`teamName: null`), and
// serves bounded detail payloads for push-only sessions.

const path = require('path');
const { truncatePromptDetail } = require('./hooks');
const { createDetailResponse } = require('./shared');

const PROTOCOL_VERSION = 'hobotnica-telemetry.v1';
const PUSH_STALE_TTL_MS = 30_000;
const PUSH_DROP_TTL_MS = 60_000;
const DEFAULT_ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

const MAX_INSTANCES = 8;
const MAX_ENTRIES_PER_INSTANCE = 256;
const MAX_SNAPSHOT_CHUNKS = 32;
const MAX_PENDING_SNAPSHOTS_PER_INSTANCE = 4;
const MAX_WORKING_SET = 16;
const MAX_RECENT_TOOLS = 120;
const MAX_RECENT_MESSAGES = 50;
const MAX_PENDING_ACTIONS = 16;

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'antigravity', 'zai']);
const DISK_BACKED_PROVIDERS = new Set(['claude', 'codex', 'antigravity']);
const VALID_ENVELOPE_TYPES = new Set(['snapshot', 'delta', 'heartbeat', 'clear']);
const ACTIVE_PHASES = new Set([
  'starting',
  'working',
  'thinking',
  'tool_running',
  'tool_pending',
  'awaiting_approval',
  'awaiting_input_blocking',
]);

function boundStr(value, maxLen = 256) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen);
}

function safeTimestamp(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeProvider(raw) {
  const driver = String(raw?.provider || raw?.providerDriver || '').trim().toLowerCase();
  const model = String(raw?.model || '').trim().toLowerCase();
  const instanceId = String(raw?.providerInstanceId || '').trim().toLowerCase();

  if (
    driver === 'claude'
    || driver === 'claudeagent'
    || driver === 'claude-agent'
    || driver === 'claude_agent'
  ) {
    return 'claude';
  }
  if (driver === 'codex') return 'codex';
  if (driver === 'antigravity') return 'antigravity';
  if (
    driver === 'zai'
    || driver === 'glm'
    || driver === 'acp'
    || driver === 'acp-registry'
    || driver === 'acpregistry'
    || driver.startsWith('acpregistry_glm')
    || driver.includes('glm')
    || model.startsWith('glm')
    || instanceId.includes('glm')
    || instanceId.includes('zai')
  ) {
    return 'zai';
  }
  return SUPPORTED_PROVIDERS.has(driver) ? driver : null;
}

function normalizeWorkingSetOp(op) {
  const value = String(op || '').trim().toLowerCase();
  if (value === 'write' || value === 'edit') return 'write';
  if (value === 'read' || value === 'search' || value === 'exec') return 'read';
  return null;
}

function normalizeWorkingSet(items, fallbackAt) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const byPath = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const itemPath = boundStr(item.path, 240);
    const op = normalizeWorkingSetOp(item.op);
    if (!itemPath || !op) continue;
    const at = safeTimestamp(item.at, fallbackAt);
    const existing = byPath.get(itemPath);
    if (!existing || at >= existing.at) {
      byPath.set(itemPath, { path: itemPath, op, at, source: 'push' });
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_WORKING_SET);
}

function mergeWorkingSets(diskItems, pushItems) {
  const merged = new Map();
  for (const item of Array.isArray(diskItems) ? diskItems : []) {
    if (!item?.path) continue;
    merged.set(item.path, item);
  }
  for (const item of Array.isArray(pushItems) ? pushItems : []) {
    if (!item?.path) continue;
    const existing = merged.get(item.path);
    if (!existing || (Number(item.at) || 0) >= (Number(existing.at) || 0)) {
      merged.set(item.path, item);
    }
  }
  return [...merged.values()]
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_WORKING_SET);
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== null && value !== undefined && value !== '' && typeof value !== 'boolean') {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
      }
    }
    return null;
  };
  const input = pick('input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const output = pick('output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  const cacheRead = pick('cacheRead', 'cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read');
  const cacheCreate = pick('cacheCreate', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens');
  if (input === null && output === null && cacheRead === null && cacheCreate === null) {
    return null;
  }
  return {
    availability: input !== null && output !== null ? 'observed' : 'partial',
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheCreate: cacheCreate ?? 0,
    cacheWrite: cacheCreate ?? 0,
    totalInput: input ?? 0,
    totalOutput: output ?? 0,
  };
}

function hasObservedTokens(usage) {
  if (!usage || typeof usage !== 'object') return false;
  if (usage.availability === 'observed' || usage.availability === 'partial') {
    return (Number(usage.input) || 0) > 0
      || (Number(usage.output) || 0) > 0
      || (Number(usage.cacheRead) || 0) > 0
      || (Number(usage.cacheCreate) || 0) > 0;
  }
  return (Number(usage.input) || 0) > 0 || (Number(usage.output) || 0) > 0;
}

function normalizePlanProgress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const total = Number(raw.total);
  const done = Number(raw.completed ?? raw.done);
  if (!Number.isFinite(total) || !Number.isFinite(done) || total < 0 || done < 0) return null;
  const normalizedTotal = Math.trunc(total);
  return {
    done: Math.min(normalizedTotal, Math.trunc(done)),
    total: normalizedTotal,
    source: 'exact',
  };
}

function normalizePendingActions(raw) {
  if (!Array.isArray(raw)) return [];
  const actions = [];
  for (const item of raw.slice(0, MAX_PENDING_ACTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const audience = item.audience === 'operator' || item.audience === 'parent'
      ? item.audience
      : null;
    if (!audience) continue;
    const kind = boundStr(item.kind, 32) || 'approval';
    const summary = boundStr(item.summary, 240) || '';
    const awaitingSinceMs = Number.isFinite(Number(item.awaitingSinceMs))
      ? Number(item.awaitingSinceMs)
      : null;
    actions.push({ kind, audience, summary, awaitingSinceMs });
  }
  return actions;
}

function normalizeRecentTools(raw, fallbackTs) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(-MAX_RECENT_TOOLS).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const tool = boundStr(item.tool || item.name, 128);
    if (!tool) return [];
    const entry = {
      tool,
      detail: truncatePromptDetail(item.detail || item.summary || item.input || '') || '',
      ts: safeTimestamp(item.ts ?? item.at ?? item.timestamp, fallbackTs),
    };
    if (Number.isFinite(Number(item.toolExitCode ?? item.exitCode))) {
      entry.toolExitCode = Number(item.toolExitCode ?? item.exitCode);
    }
    const stderr = boundStr(item.toolStderr || item.stderr, 200);
    if (stderr) entry.toolStderr = truncatePromptDetail(stderr) || stderr;
    return [entry];
  });
}

function normalizeRecentMessages(raw, fallbackTs) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(-MAX_RECENT_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const role = item.role === 'user' || item.role === 'assistant' || item.role === 'system'
      ? item.role
      : 'assistant';
    const content = boundStr(item.content || item.text || item.message, 1000);
    if (!content) return [];
    return [{
      role,
      content,
      ts: safeTimestamp(item.ts ?? item.at ?? item.timestamp, fallbackTs),
    }];
  });
}

function derivePushLifecycle(raw, pendingActions, updatedAtMs, completedAtMs, now) {
  const phase = String(raw.phase || '').trim().toLowerCase();
  const explicitAudience = raw.waitAudience === 'operator' || raw.waitAudience === 'parent'
    ? raw.waitAudience
    : null;
  const operatorAction = pendingActions.find(action => action.audience === 'operator') || null;
  const hasParentAction = pendingActions.some(action => action.audience === 'parent');
  const waitAudience = explicitAudience === 'operator' || operatorAction
    ? 'operator'
    : (explicitAudience === 'parent' || hasParentAction ? 'parent' : null);

  const activeToolName = boundStr(raw.activeToolName, 128);
  const explicitEnd = raw.sessionEndedAt != null && Number.isFinite(Number(raw.sessionEndedAt)) && Number(raw.sessionEndedAt) > 0
    ? safeTimestamp(raw.sessionEndedAt, now)
    : null;
  const sessionEndedAt = explicitEnd || (phase === 'stopped' ? (completedAtMs || updatedAtMs) : null);

  if (waitAudience === 'operator' && !sessionEndedAt) {
    let waitReason = 'approval';
    if (operatorAction?.kind === 'question' || raw.waitReason === 'question') {
      waitReason = 'question';
    } else if (operatorAction?.kind === 'plan_review' || raw.waitReason === 'plan_review') {
      waitReason = 'plan_review';
    }
    const rawDetail = operatorAction?.summary
      || raw.promptDetail
      || raw.currentActivityLabel
      || raw.latestSnippet
      || '';
    const promptDetail = truncatePromptDetail(rawDetail);
    const waitSince = safeTimestamp(
      operatorAction?.awaitingSinceMs ?? raw.awaitingSince ?? updatedAtMs,
      updatedAtMs,
    );
    const pendingTool = activeToolName
      || (waitReason === 'question' ? 'AskUserQuestion' : operatorAction?.kind === 'secret' ? 'SecretRequest' : 'Approval');
    return {
      phase: phase || 'awaiting_approval',
      turnState: 'tool_pending',
      waitAudience: 'operator',
      waitReason,
      promptDetail,
      pendingTool,
      pendingSince: waitSince,
      awaitingSince: waitSince,
      apiError: null,
      sessionEndedAt: null,
    };
  }

  let turnState = 'unknown';
  if (phase === 'starting' || phase === 'working' || phase === 'thinking') {
    turnState = 'working';
  } else if (phase === 'tool_running' || phase === 'tool_pending') {
    turnState = 'tool_pending';
  } else if (phase === 'awaiting_approval' || phase === 'awaiting_input_blocking') {
    // Parent-facing waits or non-operator pauses keep the villager working,
    // never ringing the operator Bell Lane.
    turnState = activeToolName ? 'tool_pending' : 'working';
  } else if (
    phase === 'completed'
    || phase === 'idle'
    || phase === 'stopped'
    || phase === 'failed'
    || phase === 'interrupted'
  ) {
    turnState = 'awaiting_input';
  } else if (['working', 'tool_pending', 'awaiting_input', 'unknown'].includes(raw.turnState)) {
    turnState = raw.turnState;
  }

  const apiError = phase === 'failed'
    ? { kind: 'failed', status: null, at: completedAtMs || updatedAtMs }
    : null;

  return {
    phase: phase || 'unknown',
    turnState,
    waitAudience,
    waitReason: null,
    promptDetail: null,
    pendingTool: turnState === 'tool_pending' ? activeToolName : null,
    pendingSince: turnState === 'tool_pending' ? updatedAtMs : null,
    awaitingSince: turnState === 'awaiting_input' ? (completedAtMs || updatedAtMs) : null,
    apiError,
    sessionEndedAt,
  };
}

function codexRolloutCanonicalId(rolloutPath) {
  if (typeof rolloutPath !== 'string' || !rolloutPath.trim()) return null;
  const base = path.basename(rolloutPath.trim());
  const match = /^rollout-(.+)\.jsonl$/i.exec(base);
  return match ? `codex-${match[1]}` : null;
}

function sanitizeAgentEntry(raw, instanceId, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.origin === 'provider_native') return null;

  const provider = normalizeProvider(raw);
  if (!provider) return null;

  const owningThreadId = boundStr(raw.owningThreadId || raw.threadId || raw.key, 256);
  const childThreadId = boundStr(raw.childThreadId, 256);
  const parentThreadId = boundStr(raw.parentThreadId, 256);
  const subagentId = boundStr(raw.subagentId, 256);
  const key = boundStr(raw.key || childThreadId || owningThreadId || subagentId, 256);
  if (!key) return null;

  const agentThreadId = childThreadId || owningThreadId || key;
  const updatedAtMs = safeTimestamp(raw.updatedAtMs ?? raw.updatedAt, now);
  const startedAtMs = safeTimestamp(raw.startedAtMs ?? raw.startedAt, updatedAtMs);
  const completedAtMs = raw.completedAtMs != null && Number.isFinite(Number(raw.completedAtMs))
    ? safeTimestamp(raw.completedAtMs, updatedAtMs)
    : null;
  const pendingActions = normalizePendingActions(raw.pendingActions);
  const lifecycle = derivePushLifecycle(raw, pendingActions, updatedAtMs, completedAtMs, now);

  const origin = raw.origin === 'root' || raw.origin === 'app_owned'
    ? raw.origin
    : (parentThreadId ? 'app_owned' : 'root');

  const recentTools = normalizeRecentTools(raw.recentTools, updatedAtMs);
  const recentMessages = normalizeRecentMessages(raw.recentMessages, updatedAtMs);
  const hasDetailFields = recentTools !== null || recentMessages !== null;

  const entry = {
    instanceId,
    key,
    subagentId,
    owningThreadId: owningThreadId || agentThreadId,
    parentThreadId,
    childThreadId,
    agentThreadId,
    origin,
    waveId: boundStr(raw.waveId, 128),
    teamName: null,
    supersedes: boundStr(raw.supersedes, 256),
    role: boundStr(raw.role, 120),
    title: boundStr(raw.title, 256),
    provider,
    model: boundStr(raw.model, 128),
    nativeSessionId: boundStr(raw.nativeSessionId, 256),
    rolloutPath: boundStr(raw.rolloutPath, 512),
    cwd: boundStr(raw.cwd, 512),
    projectName: boundStr(raw.projectName, 256),
    activeToolName: boundStr(raw.activeToolName, 128),
    currentActivityLabel: boundStr(raw.currentActivityLabel, 120),
    latestSnippet: boundStr(raw.latestSnippet, 140),
    workingSet: normalizeWorkingSet(raw.workingSet, updatedAtMs),
    planProgress: normalizePlanProgress(raw.planProgress),
    tokenUsage: normalizeTokenUsage(raw.tokenUsage),
    startedAtMs,
    updatedAtMs,
    completedAtMs,
    receivedAt: now,
    ...lifecycle,
  };

  const detail = hasDetailFields
    ? {
      toolHistory: recentTools || [],
      messages: recentMessages || [],
      updatedAtMs,
    }
    : null;

  return { entry, detail };
}

function makeValidationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class HobotnicaPushStore {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._instances = new Map();
    this._canonicalByLookup = new Map();
    this._canonicalByNative = new Map();
    this._canonicalToEntryRef = new Map();
    this._diskMatchedCanonicals = new Set();
  }

  _getOrCreateInstance(instanceId, bootId, mode, now) {
    let instance = this._instances.get(instanceId);
    if (!instance) {
      while (this._instances.size >= MAX_INSTANCES) {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [id, candidate] of this._instances) {
          if (candidate.lastSeenAt < oldestAt) {
            oldestAt = candidate.lastSeenAt;
            oldestId = id;
          }
        }
        if (oldestId === null) break;
        this._instances.delete(oldestId);
      }
      instance = {
        instanceId,
        bootId,
        mode,
        lastSeq: 0,
        lastSeenAt: now,
        wasStale: false,
        entries: new Map(),
        details: new Map(),
        pendingChunks: new Map(),
      };
      this._instances.set(instanceId, instance);
      return { instance, reset: false };
    }

    const wasStale = now - instance.lastSeenAt >= PUSH_STALE_TTL_MS;
    let reset = false;
    if (instance.bootId !== bootId) {
      reset = instance.entries.size > 0;
      instance.bootId = bootId;
      instance.lastSeq = 0;
      instance.entries.clear();
      instance.details.clear();
      instance.pendingChunks.clear();
    }
    if (mode) instance.mode = mode;
    instance.lastSeenAt = now;
    instance.wasStale = wasStale;
    return { instance, reset };
  }

  _enforceEntryLimit(instance) {
    while (instance.entries.size > MAX_ENTRIES_PER_INSTANCE) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of instance.entries) {
        if (entry.updatedAtMs < oldestAt) {
          oldestAt = entry.updatedAtMs;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      instance.entries.delete(oldestKey);
      instance.details.delete(oldestKey);
    }
  }

  _commitSnapshot(instance, items) {
    instance.entries.clear();
    instance.details.clear();
    instance.pendingChunks.clear();
    for (const item of items) {
      if (instance.entries.size >= MAX_ENTRIES_PER_INSTANCE) break;
      instance.entries.set(item.entry.key, item.entry);
      if (item.detail) instance.details.set(item.entry.key, item.detail);
    }
  }

  ingest(envelope, nowOverride = null) {
    const now = nowOverride !== null ? nowOverride : this._now();
    this.prune(now);

    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw makeValidationError('INVALID_ENVELOPE', 'invalid hobotnica telemetry envelope');
    }
    if (envelope.protocol !== PROTOCOL_VERSION) {
      throw makeValidationError('INVALID_PROTOCOL', 'unsupported telemetry protocol');
    }
    const type = boundStr(envelope.type, 32);
    if (!type || !VALID_ENVELOPE_TYPES.has(type)) {
      throw makeValidationError('INVALID_TYPE', 'invalid telemetry envelope type');
    }
    const instanceId = boundStr(envelope.instanceId, 128);
    if (!instanceId) {
      throw makeValidationError('INVALID_INSTANCE_ID', 'invalid instanceId');
    }
    const bootId = boundStr(envelope.bootId, 128);
    if (!bootId) {
      throw makeValidationError('INVALID_BOOT_ID', 'invalid bootId');
    }
    if (envelope.seq !== undefined) {
      if (typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq) || envelope.seq < 0) {
        throw makeValidationError('INVALID_SEQ', 'invalid seq');
      }
    }
    const mode = envelope.mode === 'dev' || envelope.mode === 'prod' ? envelope.mode : 'dev';

    const { instance, reset } = this._getOrCreateInstance(instanceId, bootId, mode, now);
    if (typeof envelope.seq === 'number' && envelope.seq > instance.lastSeq) {
      instance.lastSeq = envelope.seq;
    }

    if (type === 'heartbeat') {
      const revived = instance.wasStale;
      instance.wasStale = false;
      return { accepted: true, changed: reset || revived };
    }

    if (type === 'clear') {
      const hadEntries = instance.entries.size > 0;
      instance.entries.clear();
      instance.details.clear();
      instance.pendingChunks.clear();
      instance.wasStale = false;
      return { accepted: true, changed: reset || hadEntries };
    }

    if (type === 'snapshot') {
      if (!Array.isArray(envelope.agents)) {
        throw makeValidationError('INVALID_SNAPSHOT', 'snapshot agents must be an array');
      }
      const chunkIndex = envelope.chunkIndex === undefined ? 0 : envelope.chunkIndex;
      const totalChunks = envelope.totalChunks === undefined ? 1 : envelope.totalChunks;
      if (
        !Number.isInteger(totalChunks)
        || totalChunks < 1
        || totalChunks > MAX_SNAPSHOT_CHUNKS
        || !Number.isInteger(chunkIndex)
        || chunkIndex < 0
        || chunkIndex >= totalChunks
      ) {
        throw makeValidationError('INVALID_SNAPSHOT_CHUNK', 'invalid snapshot chunk metadata');
      }
      const snapshotId = boundStr(envelope.snapshotId, 128) || `snap-${now}`;
      const sanitized = [];
      for (const rawAgent of envelope.agents) {
        const parsed = sanitizeAgentEntry(rawAgent, instanceId, now);
        if (parsed) sanitized.push(parsed);
      }

      if (totalChunks === 1) {
        this._commitSnapshot(instance, sanitized);
        instance.wasStale = false;
        return { accepted: true, changed: true, committed: true };
      }

      let pending = instance.pendingChunks.get(snapshotId);
      if (!pending || pending.totalChunks !== totalChunks) {
        while (instance.pendingChunks.size >= MAX_PENDING_SNAPSHOTS_PER_INSTANCE) {
          const oldestSnap = instance.pendingChunks.keys().next().value;
          if (oldestSnap === undefined) break;
          instance.pendingChunks.delete(oldestSnap);
        }
        pending = { totalChunks, chunks: new Map(), createdAt: now };
        instance.pendingChunks.set(snapshotId, pending);
      }
      pending.chunks.set(chunkIndex, sanitized);

      if (pending.chunks.size < totalChunks) {
        return { accepted: true, changed: reset, committed: false };
      }

      const assembled = [];
      for (let idx = 0; idx < totalChunks; idx++) {
        const part = pending.chunks.get(idx);
        if (part) assembled.push(...part);
      }
      this._commitSnapshot(instance, assembled);
      instance.wasStale = false;
      return { accepted: true, changed: true, committed: true };
    }

    // type === 'delta'
    const hasUpserts = envelope.upserts !== undefined;
    const hasRemoves = envelope.removes !== undefined;
    if (!hasUpserts && !hasRemoves) {
      throw makeValidationError('INVALID_DELTA', 'delta must include upserts or removes');
    }
    if (hasUpserts && !Array.isArray(envelope.upserts)) {
      throw makeValidationError('INVALID_DELTA', 'delta upserts must be an array');
    }
    if (hasRemoves && !Array.isArray(envelope.removes)) {
      throw makeValidationError('INVALID_DELTA', 'delta removes must be an array');
    }

    let changed = reset || instance.wasStale;
    instance.wasStale = false;

    for (const rawKey of envelope.removes || []) {
      const target = boundStr(rawKey, 256);
      if (!target) continue;
      if (instance.entries.delete(target)) {
        instance.details.delete(target);
        changed = true;
        continue;
      }
      for (const [entryKey, entry] of instance.entries) {
        if (entry.agentThreadId === target || entry.subagentId === target) {
          instance.entries.delete(entryKey);
          instance.details.delete(entryKey);
          changed = true;
        }
      }
    }

    for (const rawAgent of envelope.upserts || []) {
      const parsed = sanitizeAgentEntry(rawAgent, instanceId, now);
      if (!parsed) continue;
      instance.entries.set(parsed.entry.key, parsed.entry);
      if (parsed.detail) {
        instance.details.set(parsed.entry.key, parsed.detail);
      }
      changed = true;
    }
    this._enforceEntryLimit(instance);

    return { accepted: true, changed };
  }

  prune(now = this._now()) {
    let removed = false;
    for (const [instanceId, instance] of this._instances) {
      if (now - instance.lastSeenAt >= PUSH_DROP_TTL_MS) {
        this._instances.delete(instanceId);
        removed = true;
      }
    }
    if (this._instances.size === 0 && removed) {
      this._canonicalByLookup.clear();
      this._canonicalByNative.clear();
      this._canonicalToEntryRef.clear();
      this._diskMatchedCanonicals.clear();
    }
    return removed;
  }

  nextExpiryAt(now = this._now()) {
    let next = null;
    for (const instance of this._instances.values()) {
      const staleAt = instance.lastSeenAt + PUSH_STALE_TTL_MS;
      const dropAt = instance.lastSeenAt + PUSH_DROP_TTL_MS;
      if (staleAt > now && (next === null || staleAt < next)) next = staleAt;
      if (dropAt > now && (next === null || dropAt < next)) next = dropAt;
    }
    return next;
  }

  clear() {
    this._instances.clear();
    this._canonicalByLookup.clear();
    this._canonicalByNative.clear();
    this._canonicalToEntryRef.clear();
    this._diskMatchedCanonicals.clear();
  }

  get instanceCount() {
    return this._instances.size;
  }

  _buildDiskIndex(sessions) {
    const byProviderAlias = new Map();
    const byAnyAlias = new Map();
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      if (!session?.sessionId || !session?.provider) continue;
      const provider = String(session.provider).toLowerCase();
      const prefix = `${provider}-`;
      const unprefixed = session.sessionId.startsWith(prefix)
        ? session.sessionId.slice(prefix.length)
        : session.sessionId;
      const aliases = [
        session.sessionId,
        session.sourceSessionId,
        session.agentId,
        unprefixed,
      ].filter(Boolean);
      for (const alias of aliases) {
        const str = String(alias);
        const lower = str.toLowerCase();
        byProviderAlias.set(`${provider}::${str}`, i);
        byProviderAlias.set(`${provider}::${lower}`, i);
        if (!byAnyAlias.has(str)) byAnyAlias.set(str, i);
        if (!byAnyAlias.has(lower)) byAnyAlias.set(lower, i);
      }
    }
    return { byProviderAlias, byAnyAlias };
  }

  _matchDiskSessionIndex(entry, diskIndex) {
    const candidates = [];
    if (entry.provider === 'codex' && entry.rolloutPath) {
      const rolloutId = codexRolloutCanonicalId(entry.rolloutPath);
      if (rolloutId) candidates.push(rolloutId);
    }
    if (entry.nativeSessionId) {
      candidates.push(entry.nativeSessionId);
      if (entry.provider === 'antigravity' && !entry.nativeSessionId.startsWith('antigravity-')) {
        candidates.push(`antigravity-${entry.nativeSessionId}`);
      } else if (entry.provider === 'codex' && !entry.nativeSessionId.startsWith('codex-')) {
        candidates.push(`codex-${entry.nativeSessionId}`);
      } else if (entry.provider === 'zai' && !entry.nativeSessionId.startsWith('zai-')) {
        candidates.push(`zai-${entry.nativeSessionId}`);
      }
    }
    for (const candidate of candidates) {
      const exact = diskIndex.byProviderAlias.get(`${entry.provider}::${candidate}`);
      if (exact !== undefined) return exact;
      const lower = diskIndex.byProviderAlias.get(`${entry.provider}::${candidate.toLowerCase()}`);
      if (lower !== undefined) return lower;
    }
    return -1;
  }

  _expectedDiskCanonicalId(entry) {
    if (entry.provider === 'codex' && entry.rolloutPath) {
      const rolloutId = codexRolloutCanonicalId(entry.rolloutPath);
      if (rolloutId) return rolloutId;
    }
    if (!entry.nativeSessionId) return null;
    if (entry.provider === 'claude') return entry.nativeSessionId;
    if (entry.provider === 'antigravity') {
      return entry.nativeSessionId.startsWith('antigravity-')
        ? entry.nativeSessionId
        : `antigravity-${entry.nativeSessionId}`;
    }
    if (entry.provider === 'codex') {
      return entry.nativeSessionId.startsWith('codex-')
        ? entry.nativeSessionId
        : `codex-${entry.nativeSessionId}`;
    }
    if (entry.provider === 'zai') {
      return entry.nativeSessionId.startsWith('zai-')
        ? entry.nativeSessionId
        : `zai-${entry.nativeSessionId}`;
    }
    return null;
  }

  _buildHobotnicaMeta(entry) {
    return {
      instanceId: entry.instanceId,
      threadId: entry.owningThreadId,
      childThreadId: entry.childThreadId || null,
      subagentId: entry.subagentId || null,
      parentThreadId: entry.parentThreadId || null,
      waveId: entry.waveId || null,
    };
  }

  fold(sessions, now = this._now(), { normalizeSession = null, activeThresholdMs = DEFAULT_ACTIVE_THRESHOLD_MS } = {}) {
    this.prune(now);
    const input = Array.isArray(sessions) ? sessions : [];
    if (this._instances.size === 0) return input;

    const out = input.slice();
    const diskIndex = this._buildDiskIndex(out);

    const canonicalByInstanceKey = new Map();
    const canonicalByInstanceThread = new Map();
    const canonicalByInstanceSubagent = new Map();
    const canonicalByNative = new Map();
    const canonicalByLookup = new Map();
    const canonicalToEntryRef = new Map();
    const diskMatchedCanonicals = new Set();
    const touchedRecords = [];

    const registerLookup = (instanceId, entry, canonicalId) => {
      canonicalByInstanceKey.set(`${instanceId}::${entry.key}`, canonicalId);
      canonicalByInstanceThread.set(`${instanceId}::${entry.agentThreadId}`, canonicalId);
      if (entry.subagentId) {
        canonicalByInstanceSubagent.set(`${instanceId}::${entry.subagentId}`, canonicalId);
        canonicalByLookup.set(`subagent::${entry.subagentId}`, canonicalId);
        canonicalByLookup.set(`thread+subagent::${entry.owningThreadId}::${entry.subagentId}`, canonicalId);
      }
      canonicalByLookup.set(`key::${entry.key}`, canonicalId);
      canonicalByLookup.set(`thread::${entry.agentThreadId}`, canonicalId);
      if (!entry.childThreadId && entry.owningThreadId) {
        canonicalByLookup.set(`thread::${entry.owningThreadId}`, canonicalId);
      }
      if (entry.nativeSessionId) {
        canonicalByNative.set(`${entry.provider}::${entry.nativeSessionId}`, canonicalId);
        canonicalByNative.set(`${entry.provider}::${entry.nativeSessionId.toLowerCase()}`, canonicalId);
        canonicalByLookup.set(`native::${entry.nativeSessionId}`, canonicalId);
      }
      canonicalByLookup.set(`session::${canonicalId}`, canonicalId);
      canonicalToEntryRef.set(canonicalId, { instanceId, entryKey: entry.key });
    };

    const threshold = Number.isFinite(Number(activeThresholdMs)) && Number(activeThresholdMs) > 0
      ? Number(activeThresholdMs)
      : DEFAULT_ACTIVE_THRESHOLD_MS;

    // Pass 1: match disk sessions or synthesize diskless GLM (`zai-hbt-*`).
    for (const [instanceId, instance] of this._instances) {
      const ageMs = Math.max(0, now - instance.lastSeenAt);
      const stale = ageMs >= PUSH_STALE_TTL_MS;

      for (const entry of instance.entries.values()) {
        const isDelegate = Boolean(entry.parentThreadId) || entry.origin === 'app_owned';

        if (DISK_BACKED_PROVIDERS.has(entry.provider)) {
          // Pre-native hold: never spawn phantom villagers before native ID arrives.
          if (!entry.nativeSessionId && !(entry.provider === 'codex' && entry.rolloutPath)) {
            continue;
          }
          const matchedIdx = this._matchDiskSessionIndex(entry, diskIndex);
          if (matchedIdx >= 0) {
            const disk = out[matchedIdx];
            const canonicalId = disk.sessionId;
            diskMatchedCanonicals.add(canonicalId);
            registerLookup(instanceId, entry, canonicalId);
            // After 30s without push/heartbeat, disk-backed villagers drop the
            // push overlay and fall back to their disk state.
            if (stale) continue;

            const overlaid = {
              ...disk,
              // Preserve disk gitEvents, dialogue, lastResults, todos, compactions,
              // repoRoot, worktree, sendMessages, permissionMode, script, openQuestion.
              turnState: entry.turnState !== 'unknown' ? entry.turnState : disk.turnState,
              pendingTool: entry.pendingTool ?? (entry.turnState === 'tool_pending' ? disk.pendingTool : null),
              pendingSince: entry.pendingSince ?? (entry.turnState === 'tool_pending' ? disk.pendingSince : null),
              awaitingSince: entry.awaitingSince ?? (entry.turnState === 'awaiting_input' ? disk.awaitingSince : null),
              waitReason: entry.waitReason,
              waitAudience: entry.waitAudience,
              promptDetail: entry.promptDetail ?? undefined,
              apiError: entry.apiError || disk.apiError || null,
              sessionEndedAt: entry.sessionEndedAt || disk.sessionEndedAt || null,
              workingSet: entry.workingSet.length > 0
                ? mergeWorkingSets(disk.workingSet, entry.workingSet)
                : (Array.isArray(disk.workingSet) ? disk.workingSet : []),
              tokenUsage: hasObservedTokens(disk.tokenUsage)
                ? disk.tokenUsage
                : (entry.tokenUsage || disk.tokenUsage || null),
              taskProgress: disk.taskProgress || entry.planProgress || null,
              lastActivity: Math.max(Number(disk.lastActivity) || 0, entry.updatedAtMs || 0),
              lastTool: entry.pendingTool || entry.activeToolName || disk.lastTool || null,
              lastToolInput: (entry.waitReason && entry.promptDetail)
                ? entry.promptDetail
                : (disk.lastToolInput || entry.currentActivityLabel || null),
              lastMessage: disk.lastMessage || entry.latestSnippet || null,
              agentName: disk.userNamed
                ? disk.agentName
                : (disk.agentName || entry.title || entry.role || null),
              name: disk.userNamed
                ? (disk.name || disk.agentName)
                : (disk.name || disk.agentName || entry.title || entry.role || null),
              agentType: isDelegate ? 'sub-agent' : (disk.agentType || 'main'),
              subagentKind: isDelegate ? 'delegate' : (disk.subagentKind || null),
              teamName: null,
              waveId: entry.waveId || null,
              hobotnica: this._buildHobotnicaMeta(entry),
              signalSource: 'push',
              signalCertainty: 'observed',
              signalObservedAt: entry.updatedAtMs,
              signalStale: false,
            };
            out[matchedIdx] = overlaid;
            touchedRecords.push({ instanceId, entry, canonicalId, outIndex: matchedIdx, isSynthetic: false });
          } else {
            // Disk session not present yet — record expected canonical ID for
            // parent/focus resolution without spawning a phantom villager.
            const expectedId = this._expectedDiskCanonicalId(entry);
            if (expectedId) registerLookup(instanceId, entry, expectedId);
          }
          continue;
        }

        // Provider: 'zai' (GLM)
        const matchedIdx = entry.nativeSessionId
          ? this._matchDiskSessionIndex(entry, diskIndex)
          : -1;
        if (matchedIdx >= 0) {
          const disk = out[matchedIdx];
          const canonicalId = disk.sessionId;
          diskMatchedCanonicals.add(canonicalId);
          registerLookup(instanceId, entry, canonicalId);
          if (stale) continue;

          const overlaid = {
            ...disk,
            turnState: entry.turnState !== 'unknown' ? entry.turnState : disk.turnState,
            pendingTool: entry.pendingTool ?? (entry.turnState === 'tool_pending' ? disk.pendingTool : null),
            pendingSince: entry.pendingSince ?? (entry.turnState === 'tool_pending' ? disk.pendingSince : null),
            awaitingSince: entry.awaitingSince ?? (entry.turnState === 'awaiting_input' ? disk.awaitingSince : null),
            waitReason: entry.waitReason,
            waitAudience: entry.waitAudience,
            promptDetail: entry.promptDetail ?? undefined,
            apiError: entry.apiError || disk.apiError || null,
            sessionEndedAt: entry.sessionEndedAt || disk.sessionEndedAt || null,
            workingSet: entry.workingSet.length > 0
              ? mergeWorkingSets(disk.workingSet, entry.workingSet)
              : (Array.isArray(disk.workingSet) ? disk.workingSet : []),
            tokenUsage: hasObservedTokens(disk.tokenUsage)
              ? disk.tokenUsage
              : (entry.tokenUsage || disk.tokenUsage || null),
            taskProgress: disk.taskProgress || entry.planProgress || null,
            lastActivity: Math.max(Number(disk.lastActivity) || 0, entry.updatedAtMs || 0),
            lastTool: entry.pendingTool || entry.activeToolName || disk.lastTool || null,
            lastToolInput: (entry.waitReason && entry.promptDetail)
              ? entry.promptDetail
              : (disk.lastToolInput || entry.currentActivityLabel || null),
            lastMessage: disk.lastMessage || entry.latestSnippet || null,
            agentName: disk.userNamed
              ? disk.agentName
              : (disk.agentName || entry.title || entry.role || null),
            name: disk.userNamed
              ? (disk.name || disk.agentName)
              : (disk.name || disk.agentName || entry.title || entry.role || null),
            agentType: isDelegate ? 'sub-agent' : (disk.agentType || 'main'),
            subagentKind: isDelegate ? 'delegate' : (disk.subagentKind || null),
            teamName: null,
            waveId: entry.waveId || null,
            hobotnica: this._buildHobotnicaMeta(entry),
            signalSource: 'push',
            signalCertainty: 'observed',
            signalObservedAt: entry.updatedAtMs,
            signalStale: false,
          };
          out[matchedIdx] = overlaid;
          touchedRecords.push({ instanceId, entry, canonicalId, outIndex: matchedIdx, isSynthetic: false });
          continue;
        }

        // Diskless GLM ACP: synthesize `zai-hbt-<threadId>`.
        const canonicalId = `zai-hbt-${entry.agentThreadId}`;
        const isActivePhase = ACTIVE_PHASES.has(entry.phase) && !entry.sessionEndedAt;
        if (!isActivePhase && now - entry.updatedAtMs > threshold) {
          continue;
        }

        const synthetic = {
          sessionId: canonicalId,
          provider: 'zai',
          agentId: entry.nativeSessionId || entry.agentThreadId,
          agentType: isDelegate ? 'sub-agent' : 'main',
          subagentKind: isDelegate ? 'delegate' : null,
          agentName: entry.title || entry.role || null,
          name: entry.title || entry.role || null,
          project: entry.cwd || null,
          model: entry.model || 'glm-5.4',
          status: 'active',
          teamName: null,
          waveId: entry.waveId || null,
          hobotnica: this._buildHobotnicaMeta(entry),
          lastActivity: entry.updatedAtMs,
          lastTool: entry.pendingTool || entry.activeToolName || null,
          lastToolInput: (entry.waitReason && entry.promptDetail)
            ? entry.promptDetail
            : (entry.currentActivityLabel || null),
          lastMessage: entry.latestSnippet || null,
          turnState: entry.turnState,
          pendingTool: entry.pendingTool,
          pendingSince: entry.pendingSince,
          awaitingSince: entry.awaitingSince,
          turnStartedAt: entry.startedAtMs,
          sessionEndedAt: entry.sessionEndedAt,
          waitReason: entry.waitReason,
          waitAudience: entry.waitAudience,
          promptDetail: entry.promptDetail ?? undefined,
          apiError: entry.apiError,
          workingSet: entry.workingSet,
          tokenUsage: entry.tokenUsage,
          taskProgress: entry.planProgress,
          signalSource: 'push',
          signalCertainty: 'observed',
          signalObservedAt: entry.updatedAtMs,
          signalStale: stale,
          freshness: {
            state: stale ? 'stale' : 'fresh',
            observedAt: instance.lastSeenAt,
            ageMs,
          },
        };
        const outIndex = out.length;
        out.push(synthetic);
        registerLookup(instanceId, entry, canonicalId);
        touchedRecords.push({ instanceId, entry, canonicalId, outIndex, isSynthetic: true });
      }
    }

    // Pass 2: resolve cross-provider `parentSessionId`, `rootSessionId`, and `supersedes`.
    const outIndexById = new Map();
    for (let i = 0; i < out.length; i++) {
      if (out[i]?.sessionId) outIndexById.set(out[i].sessionId, i);
    }

    const supersededIndices = new Set();
    for (const rec of touchedRecords) {
      const { instanceId, entry, canonicalId, outIndex } = rec;
      const session = out[outIndex];

      if (entry.parentThreadId) {
        const parentCanonical = canonicalByInstanceThread.get(`${instanceId}::${entry.parentThreadId}`)
          || canonicalByInstanceKey.get(`${instanceId}::${entry.parentThreadId}`)
          || (outIndexById.has(entry.parentThreadId) ? entry.parentThreadId : null);
        if (parentCanonical && parentCanonical !== canonicalId) {
          session.parentSessionId = parentCanonical;
        }
      }

      if (entry.supersedes) {
        const oldCanonical = canonicalByInstanceKey.get(`${instanceId}::${entry.supersedes}`)
          || canonicalByInstanceThread.get(`${instanceId}::${entry.supersedes}`)
          || canonicalByInstanceSubagent.get(`${instanceId}::${entry.supersedes}`)
          || canonicalByNative.get(`${entry.provider}::${entry.supersedes}`)
          || canonicalByNative.get(`${entry.provider}::${entry.supersedes.toLowerCase()}`)
          || (diskIndex.byAnyAlias.has(entry.supersedes) ? out[diskIndex.byAnyAlias.get(entry.supersedes)]?.sessionId : null)
          || entry.supersedes;
        if (oldCanonical && oldCanonical !== canonicalId) {
          session.supersedes = oldCanonical;
          const oldIdx = outIndexById.get(oldCanonical);
          if (oldIdx !== undefined && oldIdx !== outIndex) {
            out[oldIdx] = {
              ...out[oldIdx],
              sessionEndedAt: entry.updatedAtMs || now,
            };
            supersededIndices.add(oldIdx);
          }
        }
      }
    }

    // Compute rootSessionId by walking parentSessionId chains (cycle-guarded).
    for (const rec of touchedRecords) {
      const session = out[rec.outIndex];
      if (!session.parentSessionId) continue;
      let cursor = session.parentSessionId;
      const visited = new Set([session.sessionId]);
      for (let depth = 0; depth < 8 && cursor; depth++) {
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const parentIdx = outIndexById.get(cursor);
        if (parentIdx === undefined) break;
        const nextParent = out[parentIdx]?.parentSessionId;
        if (!nextParent || visited.has(nextParent)) break;
        cursor = nextParent;
      }
      session.rootSessionId = cursor || session.parentSessionId;
    }

    // Normalize all newly synthesized, overlaid, or superseded sessions so
    // spriteId, cost, workingSet, promptDetail, and waitAudience gates stay uniform.
    if (typeof normalizeSession === 'function') {
      const toNormalize = new Set(touchedRecords.map(rec => rec.outIndex));
      for (const idx of supersededIndices) toNormalize.add(idx);
      for (const idx of toNormalize) {
        const current = out[idx];
        const preservedFreshness = current.freshness;
        const normalized = normalizeSession(current, { provider: current.provider });
        if (preservedFreshness) normalized.freshness = preservedFreshness;
        out[idx] = normalized;
      }
    }

    this._canonicalByLookup = canonicalByLookup;
    this._canonicalByNative = canonicalByNative;
    this._canonicalToEntryRef = canonicalToEntryRef;
    this._diskMatchedCanonicals = diskMatchedCanonicals;

    return out.sort((a, b) => (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0));
  }

  resolveCanonicalId(query = {}) {
    if (!query || typeof query !== 'object') return null;
    const now = this._now();
    this.prune(now);

    const sessionId = boundStr(query.sessionId, 256);
    const nativeSessionId = boundStr(query.nativeSessionId, 256);
    const threadId = boundStr(query.threadId, 256);
    const subagentId = boundStr(query.subagentId, 256);
    const provider = query.provider ? normalizeProvider({ provider: query.provider }) : null;

    if (threadId && subagentId) {
      const both = this._canonicalByLookup.get(`thread+subagent::${threadId}::${subagentId}`);
      if (both) return both;
    }
    if (subagentId) {
      const bySub = this._canonicalByLookup.get(`subagent::${subagentId}`);
      if (bySub) return bySub;
    }
    if (threadId) {
      const byThread = this._canonicalByLookup.get(`thread::${threadId}`)
        || this._canonicalByLookup.get(`key::${threadId}`);
      if (byThread) return byThread;
    }
    if (nativeSessionId) {
      if (provider) {
        const byProvNative = this._canonicalByNative.get(`${provider}::${nativeSessionId}`)
          || this._canonicalByNative.get(`${provider}::${nativeSessionId.toLowerCase()}`);
        if (byProvNative) return byProvNative;
      }
      const byNative = this._canonicalByLookup.get(`native::${nativeSessionId}`);
      if (byNative) return byNative;
    }
    if (sessionId) {
      const bySession = this._canonicalByLookup.get(`session::${sessionId}`)
        || this._canonicalByLookup.get(`thread::${sessionId}`)
        || this._canonicalByLookup.get(`native::${sessionId}`);
      if (bySession) return bySession;
    }

    // Fallback scan over live store entries (handles focus before first fold).
    for (const instance of this._instances.values()) {
      for (const entry of instance.entries.values()) {
        const matchesPair = threadId && subagentId
          && (entry.owningThreadId === threadId || entry.childThreadId === threadId || entry.agentThreadId === threadId)
          && entry.subagentId === subagentId;
        const matchesSub = subagentId && !threadId && entry.subagentId === subagentId;
        const matchesThread = threadId && !subagentId
          && (entry.agentThreadId === threadId || entry.key === threadId || (!entry.childThreadId && entry.owningThreadId === threadId));
        const matchesNative = nativeSessionId && entry.nativeSessionId
          && entry.nativeSessionId.toLowerCase() === nativeSessionId.toLowerCase()
          && (!provider || entry.provider === provider);
        if (matchesPair || matchesSub || matchesThread || matchesNative) {
          if (entry.provider === 'zai') {
            return entry.nativeSessionId ? `zai-${entry.nativeSessionId}` : `zai-hbt-${entry.agentThreadId}`;
          }
          const expected = this._expectedDiskCanonicalId(entry);
          if (expected) return expected;
        }
      }
    }

    if (nativeSessionId && provider) {
      if (provider === 'claude') return nativeSessionId;
      if (provider === 'antigravity') {
        return nativeSessionId.startsWith('antigravity-') ? nativeSessionId : `antigravity-${nativeSessionId}`;
      }
      if (provider === 'codex') {
        return nativeSessionId.startsWith('codex-') ? nativeSessionId : `codex-${nativeSessionId}`;
      }
      if (provider === 'zai') {
        return nativeSessionId.startsWith('zai-') ? nativeSessionId : `zai-${nativeSessionId}`;
      }
    }

    return sessionId || nativeSessionId || threadId || subagentId || null;
  }

  getDetail(provider, sessionId, project = '') {
    const now = this._now();
    this.prune(now);
    const id = boundStr(sessionId, 256);
    if (!id) return null;
    // Disk-backed sessions keep their full on-disk transcript details.
    if (this._diskMatchedCanonicals.has(id)) return null;

    let entryRef = this._canonicalToEntryRef.get(id) || null;
    if (!entryRef && id.startsWith('zai-hbt-')) {
      const threadId = id.slice('zai-hbt-'.length);
      for (const [instanceId, instance] of this._instances) {
        for (const [entryKey, entry] of instance.entries) {
          if (entry.provider === 'zai' && entry.agentThreadId === threadId) {
            entryRef = { instanceId, entryKey };
            break;
          }
        }
        if (entryRef) break;
      }
    }
    if (!entryRef) return null;

    const instance = this._instances.get(entryRef.instanceId);
    if (!instance) return null;
    const entry = instance.entries.get(entryRef.entryKey);
    if (!entry) return null;
    if (provider && String(provider).toLowerCase() !== entry.provider) return null;

    const detail = instance.details.get(entryRef.entryKey);
    const isSynthetic = id.startsWith('zai-hbt-');
    if (!isSynthetic && !detail) return null;

    return createDetailResponse({
      provider: entry.provider,
      sessionId: id,
      project: project || entry.cwd || '',
      toolHistory: detail ? detail.toolHistory.map(item => ({ ...item })) : [],
      messages: detail ? detail.messages.map(item => ({ ...item })) : [],
      tokenUsage: entry.tokenUsage ? { ...entry.tokenUsage } : null,
      agentName: entry.title || entry.role || undefined,
    });
  }
}

const hobotnicaPush = new HobotnicaPushStore();

function foldHobotnicaPush(sessions, now = Date.now(), options = {}) {
  return hobotnicaPush.fold(sessions, now, options);
}

function getHobotnicaDetail(provider, sessionId, project = '') {
  return hobotnicaPush.getDetail(provider, sessionId, project);
}

module.exports = {
  PROTOCOL_VERSION,
  PUSH_STALE_TTL_MS,
  PUSH_DROP_TTL_MS,
  MAX_INSTANCES,
  MAX_ENTRIES_PER_INSTANCE,
  MAX_SNAPSHOT_CHUNKS,
  MAX_RECENT_TOOLS,
  MAX_RECENT_MESSAGES,
  SUPPORTED_PROVIDERS,
  HobotnicaPushStore,
  hobotnicaPush,
  foldHobotnicaPush,
  getHobotnicaDetail,
  normalizeProvider,
  codexRolloutCanonicalId,
};
