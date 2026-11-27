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
    subagentId: 'sub-c',
    parentThreadId: null,
    waveId: 'wave-alpha',
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
  assert.equal(residency.size, 0, 'SessionResidency does not admit push-owned sessions');

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
