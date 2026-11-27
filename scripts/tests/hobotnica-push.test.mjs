// Stage 4 — Deep Hobotnica Integration tests:
// - hobotnicaPush.js helper-plus-fold: canonical-ID overlay without duplicates,
//   pre-native hold, provider_native ignore, diskless GLM (`zai-hbt-*`) + detail routing,
//   cross-provider wave parentSessionId/rootSessionId with `teamName: null`,
//   `supersedes` handoff, instance isolation + bootId reset, chunked snapshots,
//   30s stale / 60s drop TTL + SessionResidency non-retention, waitAudience Bell Lane gating,
//   focus canonical ID resolution, and AntigravityAdapter Hobotnica ACP discovery isolation.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { resolveAgentStatus, normalizeSignalSource } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const require = createRequire(import.meta.url);
const {
  HobotnicaPushStore,
  hobotnicaPush,
  PUSH_STALE_TTL_MS,
  PUSH_DROP_TTL_MS,
  normalizeProvider,
} = require('../../claudeville/adapters/hobotnicaPush.js');
const {
  normalizeSession,
  getSessionDetailByProvider,
} = require('../../claudeville/adapters/index.js');
const { AntigravityAdapter } = require('../../claudeville/adapters/antigravity.js');
const { SessionResidency } = require('../../claudeville/services/sessionResidency.js');
const t3code = require('../../claudeville/adapters/t3code.js');

let nodeSqlite = null;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  // node:sqlite unavailable
}

function makeAgent(overrides = {}) {
  const now = overrides.updatedAtMs || 1_750_000_000_000;
  return {
    key: 'agent-1',
    subagentId: 'sub-1',
    owningThreadId: 'th-1',
    parentThreadId: null,
    childThreadId: null,
    origin: 'root',
    waveId: null,
    teamName: null,
    supersedes: null,
    role: 'engineer',
    title: 'Main Agent',
    providerDriver: 'claudeAgent',
    providerInstanceId: 'claude',
    model: 'claude-sonnet-4-6',
    nativeSessionId: null,
    cwd: '/work/repo',
    projectName: 'repo',
    turnState: 'working',
    phase: 'thinking',
    activeToolName: null,
    currentActivityLabel: 'Thinking',
    latestSnippet: 'Planning changes',
    workingSet: [],
    planProgress: null,
    tokenUsage: null,
    pendingActions: [],
    waitAudience: null,
    startedAtMs: now - 5_000,
    updatedAtMs: now,
    completedAtMs: null,
    ...overrides,
  };
}

function makeSnapshot(agents, overrides = {}) {
  const now = overrides.serverTimeMs || 1_750_000_000_000;
  return {
    protocol: 'hobotnica-telemetry.v1',
    type: 'snapshot',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 1,
    mode: 'dev',
    snapshotId: 'snap-1',
    chunkIndex: 0,
    totalChunks: 1,
    serverTimeMs: now,
    agents,
    ...overrides,
  };
}

test('normalizeProvider maps Hobotnica drivers and GLM aliases accurately', () => {
  assert.equal(normalizeProvider({ providerDriver: 'claudeAgent' }), 'claude');
  assert.equal(normalizeProvider({ providerDriver: 'claude-agent' }), 'claude');
  assert.equal(normalizeProvider({ providerDriver: 'claude_agent' }), 'claude');
  assert.equal(normalizeProvider({ providerDriver: 'codex' }), 'codex');
  assert.equal(normalizeProvider({ providerDriver: 'antigravity' }), 'antigravity');
  assert.equal(normalizeProvider({ providerDriver: 'acp-registry', model: 'glm-5.4' }), 'zai');
  assert.equal(normalizeProvider({ providerDriver: 'acp', providerInstanceId: 'glm-agent' }), 'zai');
  assert.equal(normalizeProvider({ provider: 'glm' }), 'zai');
  assert.equal(normalizeProvider({ provider: 'zai' }), 'zai');
});

test('canonical-ID overlay matches Claude, Antigravity, Codex, and disk GLM without duplicates and preserves disk artifacts', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });

  const diskSessions = [
    normalizeSession({
      sessionId: 'claude-uuid-1111',
      provider: 'claude',
      project: '/work/repo',
      model: 'claude-sonnet-4-6',
      lastActivity: now - 5000,
      turnState: 'working',
      gitEvents: [{ id: 'g1', type: 'commit', sha: 'abc1234', ts: now - 4000 }],
      dialogue: { text: 'Checking tests', full: 'Checking tests', kind: 'intent', source: 'tool', authorship: 'model', fidelity: 'verbatim', redacted: false, observedAt: now - 3000, actionId: 'a1' },
      lastResults: [{ id: 'r1', tool: 'Bash', detail: 'npm test', exitCode: 0, exitCodeSource: 'exit', completedAt: now - 2000, source: 'transcript' }],
      todos: [{ subject: 'Ship Stage 4', status: 'in_progress', phase: null }],
      compactions: [{ at: now - 10_000, trigger: 'auto', preTokens: 50000, postTokens: 12000, durationMs: 800 }],
      compactionCount: 1,
      workingSet: [{ path: 'src/existing.js', op: 'read', at: now - 6000, source: 'transcript' }],
    }),
    normalizeSession({
      sessionId: 'antigravity-conv-2222',
      provider: 'antigravity',
      project: '/work/repo',
      model: 'gemini-4-neon',
      lastActivity: now - 4000,
      turnState: 'working',
    }),
    normalizeSession({
      sessionId: 'codex-2026-11-27T12-00-00-thread-3333',
      provider: 'codex',
      agentId: 'thread-3333',
      project: '/work/repo',
      model: 'gpt-5.4',
      lastActivity: now - 3000,
      turnState: 'working',
    }),
    normalizeSession({
      sessionId: 'zai-glm-disk-4444',
      provider: 'zai',
      agentId: 'glm-disk-4444',
      project: '/work/repo',
      model: 'glm-5.4',
      lastActivity: now - 2000,
      turnState: 'working',
    }),
  ];

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'k-claude',
      subagentId: 'sub-c',
      owningThreadId: 'th-claude',
      providerDriver: 'claudeAgent',
      nativeSessionId: 'claude-uuid-1111',
      waveId: 'wave-alpha',
      phase: 'tool_running',
      activeToolName: 'Edit',
      workingSet: [{ path: 'src/pushed.js', op: 'edit', at: now - 1000, source: 'push' }],
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-agy',
      subagentId: 'sub-a',
      owningThreadId: 'th-agy',
      providerDriver: 'antigravity',
      nativeSessionId: 'conv-2222',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-codex',
      subagentId: 'sub-x',
      owningThreadId: 'th-codex',
      providerDriver: 'codex',
      nativeSessionId: 'thread-3333',
      rolloutPath: '/home/u/.codex/sessions/2026/11/27/rollout-2026-11-27T12-00-00-thread-3333.jsonl',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-glm-disk',
      subagentId: 'sub-g',
      owningThreadId: 'th-glm-disk',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      nativeSessionId: 'glm-disk-4444',
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold(diskSessions, now, { normalizeSession });
  assert.equal(folded.length, 4, 'must overlay without creating any duplicate villagers');

  const claude = folded.find(s => s.sessionId === 'claude-uuid-1111');
  assert.equal(claude.signalSource, 'push');
  assert.equal(claude.waveId, 'wave-alpha');
  assert.equal(claude.teamName, null);
  assert.equal(claude.gitEvents.length, 1, 'disk gitEvents preserved');
  assert.equal(claude.dialogue?.text, 'Checking tests', 'disk dialogue preserved');
  assert.equal(claude.lastResults.length, 1, 'disk lastResults preserved');
  assert.equal(claude.todos.length, 1, 'disk todos preserved');
  assert.equal(claude.compactionCount, 1, 'disk compactions preserved');
  assert.deepEqual(
    claude.workingSet.map(item => [item.path, item.op, item.source]),
    [['src/pushed.js', 'write', 'push'], ['src/existing.js', 'read', 'transcript']],
  );
  assert.deepEqual(claude.hobotnica, {
    instanceId: 'inst-dev',
    threadId: 'th-claude',
    childThreadId: null,
    subagentId: null,
    parentThreadId: null,
    waveId: 'wave-alpha',
    pushOnly: false,
  });

  assert.equal(folded.find(s => s.sessionId === 'antigravity-conv-2222')?.signalSource, 'push');
  assert.equal(folded.find(s => s.sessionId === 'codex-2026-11-27T12-00-00-thread-3333')?.signalSource, 'push');
  assert.equal(folded.find(s => s.sessionId === 'zai-glm-disk-4444')?.signalSource, 'push');
  assert.equal(folded.some(s => s.sessionId.startsWith('zai-hbt-')), false, 'disk GLM matched without synthesizing twin');
});

test('pre-native hold suppresses phantom disk-backed villagers and ignores provider_native entries', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  store.ingest(makeSnapshot([
    makeAgent({ key: 'pre-claude', owningThreadId: 'th-c', providerDriver: 'claudeAgent', nativeSessionId: null }),
    makeAgent({ key: 'pre-codex', owningThreadId: 'th-x', providerDriver: 'codex', nativeSessionId: null }),
    makeAgent({ key: 'pre-agy', owningThreadId: 'th-a', providerDriver: 'antigravity', nativeSessionId: null }),
    makeAgent({ key: 'native-child', owningThreadId: 'th-n', origin: 'provider_native', providerDriver: 'zai', model: 'glm-5.4' }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold([], now, { normalizeSession });
  assert.equal(folded.length, 0, 'pre-native disk providers and provider_native entries never spawn phantom villagers');
});

test('diskless GLM synthesizes zai-hbt-<threadId> with agent.zai.glm sprite and keeps detail off list broadcast', () => {
  const now = Date.now();
  hobotnicaPush.clear();
  try {
    hobotnicaPush.ingest(makeSnapshot([
      makeAgent({
        key: 'k-glm-1',
        subagentId: 'sub-glm-1',
        owningThreadId: 'th-root',
        parentThreadId: 'th-root',
        childThreadId: 'th-glm-child-1',
        origin: 'app_owned',
        waveId: 'wave-9',
        title: 'GLM Scout',
        providerDriver: 'acp-registry',
        providerInstanceId: 'glm-5.4',
        model: 'glm-5.4',
        nativeSessionId: null,
        cwd: '/work/hobotnica',
        phase: 'tool_running',
        activeToolName: 'read_file',
        tokenUsage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800 },
        workingSet: [{ path: 'apps/server/src/http.ts', op: 'search', at: now - 200, source: 'push' }],
        recentTools: [{ tool: 'read_file', detail: 'apps/server/src/http.ts', ts: now - 500 }],
        recentMessages: [{ role: 'assistant', content: 'Inspecting focus route.', ts: now - 100 }],
        updatedAtMs: now,
      }),
    ], { serverTimeMs: now }), now);

    const folded = hobotnicaPush.fold([], now, { normalizeSession });
    assert.equal(folded.length, 1);
    const glm = folded[0];
    assert.equal(glm.sessionId, 'zai-hbt-th-glm-child-1');
    assert.equal(glm.provider, 'zai');
    assert.equal(glm.model, 'glm-5.4');
    assert.equal(glm.spriteId, 'agent.zai.glm');
    assert.equal(glm.agentType, 'sub-agent');
    assert.equal(glm.subagentKind, 'delegate');
    assert.equal(glm.teamName, null);
    assert.equal(glm.signalSource, 'push');
    assert.equal(glm.tokenUsage.input, 1200);
    assert.equal(glm.tokenUsage.output, 340);
    assert.equal(glm.tokenUsage.cacheRead, 800);
    assert.equal(glm.recentTools, undefined, 'detail tools stay off list payload');
    assert.equal(glm.recentMessages, undefined, 'detail messages stay off list payload');
    assert.deepEqual(glm.hobotnica, {
      instanceId: 'inst-dev',
      threadId: 'th-root',
      childThreadId: 'th-glm-child-1',
      subagentId: 'sub-glm-1',
      parentThreadId: 'th-root',
      waveId: 'wave-9',
      pushOnly: true,
    });

    const detail = getSessionDetailByProvider('zai', 'zai-hbt-th-glm-child-1', '/work/hobotnica');
    assert.equal(detail.provider, 'zai');
    assert.equal(detail.sessionId, 'zai-hbt-th-glm-child-1');
    assert.equal(detail.toolHistory.length, 1);
    assert.equal(detail.toolHistory[0].tool, 'read_file');
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.messages[0].content, 'Inspecting focus route.');
    assert.equal(detail.freshness.state, 'fresh');
  } finally {
    hobotnicaPush.clear();
  }
});

test('cross-provider wave resolves parentSessionId, rootSessionId, teamName: null, and focus canonical IDs', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });

  const diskSessions = [
    normalizeSession({ sessionId: 'antigravity-root-conv', provider: 'antigravity', lastActivity: now - 1000 }),
    normalizeSession({ sessionId: 'claude-del-uuid', provider: 'claude', lastActivity: now - 800 }),
    normalizeSession({ sessionId: 'codex-2026-11-27T12-00-00-del-codex', provider: 'codex', agentId: 'del-codex', lastActivity: now - 700 }),
  ];

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'k-root',
      subagentId: 'sub-root',
      owningThreadId: 'th-root',
      origin: 'root',
      waveId: 'wave-42',
      providerDriver: 'antigravity',
      nativeSessionId: 'root-conv',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-claude',
      subagentId: 'sub-claude',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-del-claude',
      origin: 'app_owned',
      waveId: 'wave-42',
      providerDriver: 'claudeAgent',
      nativeSessionId: 'claude-del-uuid',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-codex',
      subagentId: 'sub-codex',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-del-codex',
      origin: 'app_owned',
      waveId: 'wave-42',
      providerDriver: 'codex',
      nativeSessionId: 'del-codex',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-glm-grandchild',
      subagentId: 'sub-glm-gc',
      owningThreadId: 'th-root',
      parentThreadId: 'th-del-claude',
      childThreadId: 'th-del-glm-gc',
      origin: 'app_owned',
      waveId: 'wave-42',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      nativeSessionId: null,
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold(diskSessions, now, { normalizeSession });
  const claude = folded.find(s => s.sessionId === 'claude-del-uuid');
  const codex = folded.find(s => s.sessionId === 'codex-2026-11-27T12-00-00-del-codex');
  const glmGrandchild = folded.find(s => s.sessionId === 'zai-hbt-th-del-glm-gc');

  assert.equal(claude.parentSessionId, 'antigravity-root-conv');
  assert.equal(claude.rootSessionId, 'antigravity-root-conv');
  assert.equal(claude.teamName, null);
  assert.equal(claude.waveId, 'wave-42');
  assert.equal(claude.agentType, 'sub-agent');
  assert.equal(claude.subagentKind, 'delegate');

  assert.equal(codex.parentSessionId, 'antigravity-root-conv');
  assert.equal(codex.rootSessionId, 'antigravity-root-conv');
  assert.equal(codex.teamName, null);

  assert.equal(glmGrandchild.parentSessionId, 'claude-del-uuid');
  assert.equal(glmGrandchild.rootSessionId, 'antigravity-root-conv');
  assert.equal(glmGrandchild.teamName, null);

  // Focus canonical ID resolution
  assert.equal(store.resolveCanonicalId({ threadId: 'th-root', subagentId: 'sub-codex' }), 'codex-2026-11-27T12-00-00-del-codex');
  assert.equal(store.resolveCanonicalId({ threadId: 'th-del-glm-gc' }), 'zai-hbt-th-del-glm-gc');
  assert.equal(store.resolveCanonicalId({ nativeSessionId: 'root-conv', provider: 'antigravity' }), 'antigravity-root-conv');
});

test('supersedes stamps sessionEndedAt on old session, sets successor supersedes, and emits agent:superseded once', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  store.ingest(makeSnapshot([
    makeAgent({
      key: 'old-glm',
      subagentId: 'sub-old',
      owningThreadId: 'th-old',
      providerDriver: 'zai',
      model: 'glm-5.4',
      updatedAtMs: now - 1000,
    }),
    makeAgent({
      key: 'new-glm',
      subagentId: 'sub-new',
      owningThreadId: 'th-new',
      supersedes: 'old-glm',
      providerDriver: 'zai',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold([], now, { normalizeSession });
  const oldSession = folded.find(s => s.sessionId === 'zai-hbt-th-old');
  const newSession = folded.find(s => s.sessionId === 'zai-hbt-th-new');
  assert.equal(oldSession.sessionEndedAt, now);
  assert.equal(newSession.supersedes, 'zai-hbt-th-old');

  // Verify AgentManager emits agent:superseded exactly once per (fromId, toId)
  const world = new World();
  const manager = new AgentManager(world, { clock: () => now });
  const events = [];
  const off = eventBus.on('agent:superseded', payload => events.push(payload));
  try {
    manager.handleWebSocketMessage({ sessions: [normalizeSession({ ...oldSession, sessionEndedAt: null })] });
    assert.equal(world.agents.has('zai-hbt-th-old'), true);
    manager.handleWebSocketMessage({ sessions: folded });
    manager.handleWebSocketMessage({ sessions: folded });
    assert.equal(events.length, 1);
    assert.equal(events[0].fromId, 'zai-hbt-th-old');
    assert.equal(events[0].toId, 'zai-hbt-th-new');
    assert.equal(events[0].agent.id, 'zai-hbt-th-new');
    assert.equal(world.agents.has('zai-hbt-th-old'), false, 'superseded old villager removed via sessionEndedAt');
  } finally {
    off();
    manager.stop();
  }
});

test('instance isolation, bootId reset, chunked snapshot atomic commit, and 30s/60s TTL + SessionResidency', () => {
  let clock = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => clock });

  // Multi-chunk snapshot commits atomically only when all chunks arrive
  const c0 = store.ingest(makeSnapshot(
    [makeAgent({ key: 'dev-1', owningThreadId: 'th-dev-1', providerDriver: 'zai', model: 'glm-5.4', updatedAtMs: clock })],
    { instanceId: 'dev', bootId: 'b-dev', snapshotId: 's1', chunkIndex: 0, totalChunks: 2, serverTimeMs: clock },
  ), clock);
  assert.equal(c0.committed, false);
  assert.equal(store.fold([], clock, { normalizeSession }).length, 0, 'incomplete chunked snapshot not committed');

  const c1 = store.ingest(makeSnapshot(
    [makeAgent({ key: 'dev-2', owningThreadId: 'th-dev-2', providerDriver: 'zai', model: 'glm-5.4', updatedAtMs: clock })],
    { instanceId: 'dev', bootId: 'b-dev', snapshotId: 's1', chunkIndex: 1, totalChunks: 2, serverTimeMs: clock },
  ), clock);
  assert.equal(c1.committed, true);
  assert.equal(store.fold([], clock, { normalizeSession }).length, 2);

  // Prod instance stays isolated from dev bootId reset
  store.ingest(makeSnapshot(
    [makeAgent({ key: 'prod-1', owningThreadId: 'th-prod-1', providerDriver: 'zai', model: 'glm-5.4', updatedAtMs: clock })],
    { instanceId: 'prod', bootId: 'b-prod', mode: 'prod', serverTimeMs: clock },
  ), clock);
  assert.equal(store.fold([], clock, { normalizeSession }).length, 3);

  // Changing dev bootId wipes only dev entries
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'heartbeat',
    instanceId: 'dev',
    bootId: 'b-dev-2',
    seq: 1,
    mode: 'dev',
    serverTimeMs: clock,
    activeCount: 0,
  }, clock);
  const afterReset = store.fold([], clock, { normalizeSession });
  assert.deepEqual(afterReset.map(s => s.sessionId), ['zai-hbt-th-prod-1']);

  // Also test disk-backed + push-only across 30s stale and 60s drop TTL
  const diskClaude = normalizeSession({
    sessionId: 'claude-ttl-1',
    provider: 'claude',
    lastActivity: clock,
    turnState: 'working',
  });
  store.ingest(makeSnapshot([
    makeAgent({ key: 'prod-glm', owningThreadId: 'th-prod-1', providerDriver: 'zai', model: 'glm-5.4', phase: 'tool_running', activeToolName: 'Bash', updatedAtMs: clock }),
    makeAgent({ key: 'prod-claude', owningThreadId: 'th-prod-c', providerDriver: 'claudeAgent', nativeSessionId: 'claude-ttl-1', phase: 'tool_running', activeToolName: 'Edit', updatedAtMs: clock }),
  ], { instanceId: 'prod', bootId: 'b-prod', mode: 'prod', serverTimeMs: clock }), clock);

  const residency = new SessionResidency();
  const freshFold = store.fold([diskClaude], clock, { normalizeSession });
  const freshMerged = residency.merge(freshFold, clock);
  assert.equal(freshMerged.length, 2);
  assert.equal(residency.size, 1, 'SessionResidency admits overlaid disk-backed sessions but not push-only zai-hbt-*');
  assert.equal(residency._residents.has('claude-ttl-1'), true);
  assert.equal(residency._residents.has('zai-hbt-th-prod-1'), false);

  // At 31s (> PUSH_STALE_TTL_MS): disk-backed drops push overlay; push-only becomes stale
  clock += PUSH_STALE_TTL_MS + 1000;
  const staleFold = store.fold([diskClaude], clock, { normalizeSession });
  assert.equal(staleFold.find(s => s.sessionId === 'claude-ttl-1')?.signalSource, 'transcript', 'disk session drops stale push overlay at 30s');
  const staleGlm = staleFold.find(s => s.sessionId === 'zai-hbt-th-prod-1');
  assert.equal(staleGlm.freshness.state, 'stale');
  assert.equal(staleGlm.signalStale, true);

  // At 61s (> PUSH_DROP_TTL_MS): push-only drops completely, and residency does NOT resurrect it
  clock += PUSH_DROP_TTL_MS - PUSH_STALE_TTL_MS;
  const droppedFold = store.fold([diskClaude], clock, { normalizeSession });
  assert.equal(droppedFold.some(s => s.sessionId === 'zai-hbt-th-prod-1'), false);
  const droppedMerged = residency.merge(droppedFold, clock);
  assert.equal(droppedMerged.some(s => s.sessionId === 'zai-hbt-th-prod-1'), false);
});

test('waitAudience operator rings Bell Lane with redacted promptDetail even on delegate; parent never rings Bell Lane', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  assert.equal(normalizeSignalSource('push'), 'push');

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'root-agent',
      owningThreadId: 'th-root',
      providerDriver: 'zai',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'del-operator',
      subagentId: 'sub-op',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-op',
      origin: 'app_owned',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'awaiting_approval',
      turnState: 'awaiting_input',
      waitAudience: 'operator',
      pendingActions: [
        {
          kind: 'question',
          targetThreadId: 'th-op',
          audience: 'operator',
          summary: 'Approve deploy with api_key=supersecretvalue123456789012345678901234567890?',
          awaitingSinceMs: now - 2000,
        },
      ],
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'del-parent',
      subagentId: 'sub-par',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-par',
      origin: 'app_owned',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'awaiting_approval',
      turnState: 'awaiting_input',
      waitAudience: 'parent',
      pendingActions: [
        {
          kind: 'question',
          targetThreadId: 'th-par',
          audience: 'parent',
          summary: 'Waiting for parent orchestrator reply',
          awaitingSinceMs: now - 2000,
        },
      ],
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold([], now, { normalizeSession });
  const op = folded.find(s => s.sessionId === 'zai-hbt-th-op');
  const par = folded.find(s => s.sessionId === 'zai-hbt-th-par');

  assert.equal(op.parentSessionId, 'zai-hbt-th-root');
  assert.equal(op.turnState, 'tool_pending');
  assert.equal(op.waitReason, 'question', 'escalated operator question survives withoutLauncherWait');
  assert.equal(op.signalSource, 'push');
  assert.match(op.promptDetail, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(op.promptDetail, /supersecretvalue/);
  assert.equal(resolveAgentStatus(op, { now }), AgentStatus.WAITING_ON_USER);

  assert.equal(par.waitReason, null, 'parent wait never sets waitReason');
  assert.equal(par.promptDetail, undefined);
  assert.notEqual(resolveAgentStatus(par, { now }), AgentStatus.WAITING_ON_USER);
});

test('AntigravityAdapter discovers both Hobotnica userdata and fallback ACP roots without querying stock ~/.t3 SQLite', {
  skip: !nodeSqlite?.DatabaseSync && 'node:sqlite unavailable',
}, () => {
  const tmp = makeTempDir('cv-hobotnica-agy-');
  const savedHome = process.env.HOME;
  const savedHobotnicaHome = process.env.HOBOTNICA_HOME;
  const savedRoot = process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
  try {
    process.env.HOME = tmp;
    const hobotnicaHome = path.join(tmp, 'custom-hobotnica');
    process.env.HOBOTNICA_HOME = hobotnicaHome;
    delete process.env.CLAUDEVILLE_ANTIGRAVITY_DIR;
    t3code.clearT3Cache();

    const t3Root = path.join(tmp, '.t3', 'userdata', 'providers', 'antigravity', 't3-inst', 'antigravity-acp');
    const hbtUserdataRoot = path.join(hobotnicaHome, 'userdata', 'providers', 'antigravity', 'hbt-prod', 'antigravity-acp');
    const hbtFallbackRoot = path.join(hobotnicaHome, 'providers', 'antigravity', 'hbt-direct', 'antigravity-acp');
    fs.mkdirSync(t3Root, { recursive: true });
    fs.mkdirSync(hbtUserdataRoot, { recursive: true });
    fs.mkdirSync(hbtFallbackRoot, { recursive: true });

    const adapter = new AntigravityAdapter();
    const dirs = adapter._surfaceDirs();
    assert.ok(dirs.includes(t3Root), 'keeps stock ~/.t3 antigravity-acp dir');
    assert.ok(dirs.includes(hbtUserdataRoot), 'discovers $HOBOTNICA_HOME/userdata/providers/antigravity/<inst>/antigravity-acp');
    assert.ok(dirs.includes(hbtFallbackRoot), 'discovers $HOBOTNICA_HOME/providers/antigravity/<inst>/antigravity-acp');

    // Create a stock ~/.t3 SQLite DB that maps conv-hbt-1 to a bogus T3 rename —
    // Hobotnica root must NOT query stock T3 SQLite for its conversations!
    const dbPath = path.join(tmp, '.t3', 'userdata', 'statev2.sqlite');
    const db = new nodeSqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE orchestration_v2_projection_run_attempts (
        attempt_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)').run(
      'th-t3-collision',
      'WRONG-T3-TITLE',
      JSON.stringify({ titleRenamed: true, lineage: { parentThreadId: 'th-other', relationshipToParent: 'subagent' } }),
    );
    db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?)').run(
      'att-1',
      'th-t3-collision',
      'antigravity',
      JSON.stringify({ nativeThreadId: 'conv-hbt-1' }),
    );
    db.close();

    const now = Date.now();
    const transcriptPath = path.join(hbtUserdataRoot, 'brain', 'conv-hbt-1', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'USER_INPUT',
        timestamp: new Date(now - 2000).toISOString(),
        userInput: { items: [{ text: 'Work in Hobotnica' }], workspaceUris: ['file:///work/hobotnica'] },
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        timestamp: new Date(now - 1000).toISOString(),
        plannerResponse: { model: 'gemini-4-neon', response: 'Done.' },
      }),
    ].join('\n') + '\n');

    const sessions = adapter.getActiveSessions(60_000);
    const found = sessions.find(s => s.sessionId === 'antigravity-conv-hbt-1');
    assert.ok(found, 'discovers conversation inside Hobotnica userdata antigravity-acp');
    assert.notEqual(found.agentName, 'WRONG-T3-TITLE', 'Hobotnica root never reads stock ~/.t3 SQLite');
    assert.equal(found.parentSessionId ?? null, null, 'Hobotnica root never attaches stock T3 lineage');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHobotnicaHome === undefined) delete process.env.HOBOTNICA_HOME;
    else process.env.HOBOTNICA_HOME = savedHobotnicaHome;
    if (savedRoot !== undefined) process.env.CLAUDEVILLE_ANTIGRAVITY_DIR = savedRoot;
    t3code.clearT3Cache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Opus B1: overlaid disk Claude/Codex awaiting operator approval stays resident at 190s while push-only zai-hbt-* drops at 60s', () => {
  let clock = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => clock });
  const residency = new SessionResidency();

  const diskClaude = normalizeSession({
    sessionId: 'claude-approval-190',
    provider: 'claude',
    project: '/work/repo',
    lastActivity: clock,
    turnState: 'working',
    freshness: { state: 'fresh', observedAt: clock, ageMs: 0 },
  });
  const diskCodex = normalizeSession({
    sessionId: 'codex-2026-11-27T12-00-00-approval-190',
    provider: 'codex',
    agentId: 'approval-190',
    project: '/work/repo',
    lastActivity: clock,
    turnState: 'working',
    freshness: { state: 'fresh', observedAt: clock, ageMs: 0 },
  });

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'k-claude-approval',
      owningThreadId: 'th-claude-approval',
      providerDriver: 'claudeAgent',
      nativeSessionId: 'claude-approval-190',
      phase: 'awaiting_approval',
      waitAudience: 'operator',
      pendingActions: [
        { kind: 'approval', audience: 'operator', summary: 'Approve rm -rf build', awaitingSinceMs: clock },
      ],
      updatedAtMs: clock,
    }),
    makeAgent({
      key: 'k-codex-approval',
      owningThreadId: 'th-codex-approval',
      providerDriver: 'codex',
      nativeSessionId: 'approval-190',
      rolloutPath: '/home/u/.codex/sessions/2026/11/27/rollout-2026-11-27T12-00-00-approval-190.jsonl',
      phase: 'awaiting_approval',
      waitAudience: 'operator',
      pendingActions: [
        { kind: 'approval', audience: 'operator', summary: 'Approve deploy', awaitingSinceMs: clock },
      ],
      updatedAtMs: clock,
    }),
    makeAgent({
      key: 'k-glm-pushonly',
      owningThreadId: 'th-glm-pushonly',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      phase: 'awaiting_approval',
      waitAudience: 'operator',
      pendingActions: [
        { kind: 'approval', audience: 'operator', summary: 'GLM push-only approval', awaitingSinceMs: clock },
      ],
      updatedAtMs: clock,
    }),
  ], { serverTimeMs: clock }), clock);

  const initialFold = store.fold([diskClaude, diskCodex], clock, { normalizeSession });
  const overlaidClaude = initialFold.find(s => s.sessionId === 'claude-approval-190');
  const overlaidCodex = initialFold.find(s => s.sessionId === 'codex-2026-11-27T12-00-00-approval-190');
  const syntheticGlm = initialFold.find(s => s.sessionId === 'zai-hbt-th-glm-pushonly');
  assert.equal(overlaidClaude.hobotnica.pushOnly, false);
  assert.equal(overlaidCodex.hobotnica.pushOnly, false);
  assert.equal(syntheticGlm.hobotnica.pushOnly, true);

  const merged0 = residency.merge(initialFold, clock);
  assert.equal(merged0.length, 3);
  assert.equal(residency.size, 2, 'only overlaid disk-backed sessions are admitted to residency');

  // After 61s: push-only GLM drops cleanly via 60s TTL and is never resurrected by residency
  clock += PUSH_DROP_TTL_MS + 1000;
  const fold61 = store.fold([diskClaude, diskCodex], clock, { normalizeSession });
  assert.equal(fold61.some(s => s.sessionId === 'zai-hbt-th-glm-pushonly'), false);

  // Advance to 190s (> 2-minute active threshold): disk adapters stop returning idle-on-approval transcripts
  clock += 129_000;
  const fold190 = store.fold([], clock, { normalizeSession });
  assert.equal(fold190.length, 0);
  const merged190 = residency.merge(fold190, clock);

  const residentClaude = merged190.find(s => s.sessionId === 'claude-approval-190');
  const residentCodex = merged190.find(s => s.sessionId === 'codex-2026-11-27T12-00-00-approval-190');
  assert.ok(residentClaude, 'overlaid disk Claude waiting on operator approval remains resident after 190s');
  assert.equal(residentClaude.resident, true);
  assert.equal(residentClaude.waitReason, 'approval');
  assert.ok(residentCodex, 'overlaid disk Codex waiting on operator approval remains resident after 190s');
  assert.equal(residentCodex.resident, true);
  assert.equal(residentCodex.waitReason, 'approval');
  assert.equal(merged190.some(s => s.sessionId === 'zai-hbt-th-glm-pushonly'), false, 'push-only zai-hbt-* stays dropped');
});

test('Astra M4 & Opus M2: generic ACP non-GLM entries are never classified as zai or synthesized as GLM villagers', () => {
  assert.equal(normalizeProvider({ providerDriver: 'acp', model: 'Gemini via ACP', providerInstanceId: 'gemini-acp' }), null);
  assert.equal(normalizeProvider({ providerDriver: 'acp-registry', model: 'gemini-2.5-pro', providerInstanceId: 'gemini' }), null);
  assert.equal(normalizeProvider({ providerDriver: 'acpregistry', model: 'replay', providerInstanceId: 'replay' }), null);
  assert.equal(normalizeProvider({ providerDriver: 'replay', model: 'replay' }), null);
  assert.equal(normalizeProvider({ providerDriver: 'acp' }), null);
  assert.equal(normalizeProvider({ providerDriver: 'acp-registry', provider: 'zai', model: 'custom-model' }), 'zai');
  assert.equal(normalizeProvider({ providerDriver: 'acpregistry', model: 'z-ai/glm-5' }), 'zai');
  assert.equal(normalizeProvider({ providerDriver: 'acp', providerInstanceId: 'acpregistry_zai' }), 'zai');
  assert.equal(normalizeProvider({ providerDriver: 'acp', providerInstanceId: 'banzai-runner', model: 'gemini' }), null);

  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  store.ingest(makeSnapshot([
    makeAgent({
      key: 'acp-gemini',
      owningThreadId: 'th-acp-gemini',
      providerDriver: 'acp-registry',
      providerInstanceId: 'gemini-via-acp',
      model: 'Gemini via ACP',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'acp-replay',
      owningThreadId: 'th-acp-replay',
      providerDriver: 'acp',
      providerInstanceId: 'replay',
      model: 'replay',
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold([], now, { normalizeSession });
  assert.equal(folded.length, 0, 'non-GLM ACP entries must never be synthesized as GLM villagers');
});

test('Astra M5 & Fable Minor: two-delta supersedes handoff resolves via tombstones without touching unrelated disk sessions', () => {
  let clock = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => clock });
  const unrelatedDisk = normalizeSession({
    sessionId: 'claude-unrelated-999',
    provider: 'claude',
    lastActivity: clock - 1000,
    turnState: 'working',
  });

  // Initial snapshot with oldKey
  store.ingest(makeSnapshot([
    makeAgent({
      key: 'old-glm-key',
      subagentId: 'sub-old-1',
      owningThreadId: 'th-old-glm',
      providerDriver: 'zai',
      model: 'glm-5.4',
      updatedAtMs: clock,
    }),
  ], { seq: 1, serverTimeMs: clock }), clock);
  store.fold([unrelatedDisk], clock, { normalizeSession });

  // Delta 1: remove oldKey
  clock += 1000;
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 2,
    mode: 'dev',
    serverTimeMs: clock,
    removes: ['old-glm-key'],
  }, clock);

  // Delta 2: upsert successor referencing oldKey + another agent attempting raw unrelated supersedes
  clock += 1000;
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 3,
    mode: 'dev',
    serverTimeMs: clock,
    upserts: [
      makeAgent({
        key: 'new-glm-key',
        subagentId: 'sub-new-1',
        owningThreadId: 'th-new-glm',
        supersedes: 'old-glm-key',
        providerDriver: 'zai',
        model: 'glm-5.4',
        updatedAtMs: clock,
      }),
      makeAgent({
        key: 'rogue-glm-key',
        owningThreadId: 'th-rogue-glm',
        supersedes: 'claude-unrelated-999',
        providerDriver: 'zai',
        model: 'glm-5.4',
        updatedAtMs: clock,
      }),
    ],
  }, clock);

  const folded = store.fold([unrelatedDisk], clock, { normalizeSession });
  const successor = folded.find(s => s.sessionId === 'zai-hbt-th-new-glm');
  const rogue = folded.find(s => s.sessionId === 'zai-hbt-th-rogue-glm');
  const unrelatedAfter = folded.find(s => s.sessionId === 'claude-unrelated-999');

  assert.equal(successor.supersedes, 'zai-hbt-th-old-glm', 'two-delta supersedes resolves via tombstones');
  assert.equal(rogue.supersedes, null, 'unmapped raw supersedes string is ignored');
  assert.equal(unrelatedAfter.sessionEndedAt, null, 'unrelated disk session is never marked ended by raw supersedes');

  // Also verify two-delta handoff when remove happens BEFORE any intermediate fold
  clock += 1000;
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 4,
    mode: 'dev',
    serverTimeMs: clock,
    upserts: [
      makeAgent({
        key: 'unfolded-old-key',
        owningThreadId: 'th-unfolded-old',
        providerDriver: 'zai',
        model: 'glm-5.4',
        updatedAtMs: clock,
      }),
    ],
  }, clock);
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 5,
    mode: 'dev',
    serverTimeMs: clock + 500,
    removes: ['unfolded-old-key'],
  }, clock + 500);
  store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 6,
    mode: 'dev',
    serverTimeMs: clock + 1000,
    upserts: [
      makeAgent({
        key: 'unfolded-new-key',
        owningThreadId: 'th-unfolded-new',
        supersedes: 'unfolded-old-key',
        providerDriver: 'zai',
        model: 'glm-5.4',
        updatedAtMs: clock + 1000,
      }),
    ],
  }, clock + 1000);
  const folded2 = store.fold([], clock + 1000, { normalizeSession });
  const successor2 = folded2.find(s => s.sessionId === 'zai-hbt-th-unfolded-new');
  assert.equal(successor2.supersedes, 'zai-hbt-th-unfolded-old', 'remove before fold still records tombstone');
});

test('Opus M3, Opus M4 & Fable Minor: GLM root vs pre-child delegate IDs stay distinct, pre-fold focus matches, and root clears hobotnica.subagentId/childThreadId', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'k-glm-root',
      origin: 'root',
      owningThreadId: 'th-shared-root',
      childThreadId: 'stale-root-child-id',
      subagentId: 'sub-root-noise',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-glm-prechild-1',
      origin: 'app_owned',
      owningThreadId: 'th-shared-root',
      parentThreadId: 'th-shared-root',
      childThreadId: null,
      subagentId: 'sub-prechild-1',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-glm-prechild-2',
      origin: 'app_owned',
      owningThreadId: 'th-shared-root',
      parentThreadId: 'th-shared-root',
      childThreadId: null,
      subagentId: null,
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
    makeAgent({
      key: 'k-glm-child-with-thread',
      origin: 'app_owned',
      owningThreadId: 'th-shared-root',
      parentThreadId: 'th-shared-root',
      childThreadId: 'th-real-child',
      subagentId: 'sub-real-child',
      providerDriver: 'acp-registry',
      model: 'glm-5.4',
      updatedAtMs: now,
    }),
  ], { serverTimeMs: now }), now);

  // Pre-fold focus resolution must match post-fold synthesized canonical IDs
  assert.equal(store.resolveCanonicalId({ threadId: 'th-shared-root' }), 'zai-hbt-th-shared-root');
  assert.equal(store.resolveCanonicalId({ threadId: 'th-shared-root', subagentId: 'sub-prechild-1' }), 'zai-hbt-sub-prechild-1');
  assert.equal(store.resolveCanonicalId({ threadId: 'th-real-child', subagentId: 'sub-real-child' }), 'zai-hbt-th-real-child');

  const folded = store.fold([], now, { normalizeSession });
  assert.equal(folded.length, 4, 'root and pre-child delegates must never collide');
  const ids = new Set(folded.map(s => s.sessionId));
  assert.deepEqual(ids, new Set([
    'zai-hbt-th-shared-root',
    'zai-hbt-sub-prechild-1',
    'zai-hbt-k-glm-prechild-2',
    'zai-hbt-th-real-child',
  ]));

  const root = folded.find(s => s.sessionId === 'zai-hbt-th-shared-root');
  const preChild1 = folded.find(s => s.sessionId === 'zai-hbt-sub-prechild-1');
  const realChild = folded.find(s => s.sessionId === 'zai-hbt-th-real-child');

  assert.equal(root.hobotnica.subagentId, null, 'Opus M4: root villager clears hobotnica.subagentId');
  assert.equal(root.hobotnica.childThreadId, null, 'Opus M4: root villager clears hobotnica.childThreadId');
  assert.equal(preChild1.parentSessionId, 'zai-hbt-th-shared-root');
  assert.equal(preChild1.hobotnica.subagentId, 'sub-prechild-1');
  assert.equal(preChild1.hobotnica.childThreadId, null);
  assert.equal(realChild.hobotnica.subagentId, 'sub-real-child');
  assert.equal(realChild.hobotnica.childThreadId, 'th-real-child');
});

test('Opus m1: completedAtMs propagates to sessionEndedAt for terminal phases', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  const finishedAt = now - 3_000;

  store.ingest(makeSnapshot([
    makeAgent({
      key: 'child-completed',
      origin: 'app_owned',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-done',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'completed',
      completedAtMs: finishedAt,
      updatedAtMs: now - 1_000,
    }),
    makeAgent({
      key: 'child-failed',
      origin: 'app_owned',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-failed',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'failed',
      completedAtMs: finishedAt,
      updatedAtMs: now - 1_000,
    }),
    makeAgent({
      key: 'child-interrupted',
      origin: 'app_owned',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-interrupted',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'interrupted',
      completedAtMs: finishedAt,
      updatedAtMs: now - 1_000,
    }),
    makeAgent({
      key: 'child-idle-not-terminal',
      origin: 'app_owned',
      owningThreadId: 'th-root',
      parentThreadId: 'th-root',
      childThreadId: 'th-idle',
      providerDriver: 'zai',
      model: 'glm-5.4',
      phase: 'idle',
      completedAtMs: finishedAt,
      updatedAtMs: now - 1_000,
    }),
  ], { serverTimeMs: now }), now);

  const folded = store.fold([], now, { normalizeSession });
  assert.equal(folded.find(s => s.sessionId === 'zai-hbt-th-done')?.sessionEndedAt, finishedAt);
  assert.equal(folded.find(s => s.sessionId === 'zai-hbt-th-failed')?.sessionEndedAt, finishedAt);
  assert.equal(folded.find(s => s.sessionId === 'zai-hbt-th-interrupted')?.sessionEndedAt, finishedAt);
  assert.equal(folded.find(s => s.sessionId === 'zai-hbt-th-idle')?.sessionEndedAt, null);
});

test('Fable M1 & Minors: ReDoS payload stays < 200ms, hostile toString object is skipped, timestamps are clamped, and password= is redacted', () => {
  const now = 1_750_000_000_000;
  const store = new HobotnicaPushStore({ now: () => now });
  const redosString = 'a-'.repeat(120_000);

  const startedAt = performance.now();
  const res = store.ingest({
    protocol: 'hobotnica-telemetry.v1',
    type: 'delta',
    instanceId: 'inst-dev',
    bootId: 'boot-1',
    seq: 1,
    mode: 'dev',
    serverTimeMs: now,
    upserts: [
      // Hostile object that throws if String() is called on it
      {
        key: { toString: 1 },
        provider: { toString: 1 },
        providerDriver: { toString: 1 },
        phase: { toString: 1 },
      },
      // ReDoS + future timestamp + password= secret payload
      makeAgent({
        key: 'k-hardened',
        owningThreadId: 'th-hardened',
        providerDriver: 'zai',
        model: 'glm-5.4',
        phase: 'awaiting_approval',
        waitAudience: 'operator',
        promptDetail: `${redosString} password=hunter2`,
        currentActivityLabel: `login password=hunter2 ${redosString}`,
        latestSnippet: `db_password=hunter2 ${redosString}`,
        startedAtMs: 9e15,
        updatedAtMs: 9e15,
        completedAtMs: 9e15,
        workingSet: [{ path: 'src/auth.js', op: 'edit', at: 9e15 }],
        pendingActions: [
          {
            kind: 'approval',
            audience: 'operator',
            summary: `Run auth with password=hunter2 ${redosString}`,
            awaitingSinceMs: 9e15,
          },
        ],
        recentTools: [
          { tool: 'Bash', detail: `curl -u admin password=hunter2 ${redosString}`, ts: 9e15 },
        ],
        recentMessages: [
          { role: 'assistant', text: `Connecting with password=hunter2 ${redosString}`, ts: 9e15 },
        ],
      }),
    ],
  }, now);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(res.accepted, true);
  assert.ok(elapsedMs < 200, `ReDoS ingest must finish in < 200ms, took ${elapsedMs.toFixed(1)}ms`);

  const folded = store.fold([], now, { normalizeSession });
  assert.equal(folded.length, 1, 'malformed entry skipped while valid entry in same delta applied');
  const session = folded[0];
  const maxAllowedTs = now + 60_000;

  assert.ok(session.lastActivity <= maxAllowedTs, 'updatedAtMs clamped to now + 60_000');
  assert.ok(session.turnStartedAt <= maxAllowedTs, 'startedAtMs clamped to now + 60_000');
  assert.ok(session.awaitingSince <= maxAllowedTs, 'awaitingSince clamped to now + 60_000');
  assert.ok(session.workingSet[0].at <= maxAllowedTs, 'workingSet[].at clamped to now + 60_000');

  assert.match(session.promptDetail, /password=\[REDACTED\]/);
  assert.doesNotMatch(session.promptDetail, /hunter2/);
  assert.doesNotMatch(session.lastMessage || '', /hunter2/);

  const detail = store.getDetail('zai', 'zai-hbt-th-hardened');
  assert.ok(detail);
  assert.match(detail.toolHistory[0].detail, /password=\[REDACTED\]/);
  assert.doesNotMatch(detail.toolHistory[0].detail, /hunter2/);
  assert.ok(detail.toolHistory[0].ts <= maxAllowedTs);
  assert.match(detail.messages[0].content, /password=\[REDACTED\]/);
  assert.doesNotMatch(detail.messages[0].content, /hunter2/);
  assert.ok(detail.messages[0].ts <= maxAllowedTs);
});
