#!/usr/bin/env node

import assert from 'node:assert/strict';

import { MonumentPlanter } from '../../claudeville/src/application/MonumentRules.js';
import { ChronicleStore } from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { ChronicleMonuments } from '../../claudeville/src/presentation/character-mode/ChronicleMonuments.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { RelationshipState } from '../../claudeville/src/presentation/character-mode/RelationshipState.js';
import { TrailRenderer } from '../../claudeville/src/presentation/character-mode/TrailRenderer.js';
import { worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { VisitTileAllocator } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

class MemoryChronicleStore extends ChronicleStore {
  constructor(meta, writes, dbName = `claudeville-smoke-${Math.random()}`) {
    super({ dbName });
    this.meta = meta;
    this.writes = writes;
  }

  async getMeta(key, fallback = null) {
    return this.meta.has(key) ? structuredClone(this.meta.get(key)) : fallback;
  }

  async setMeta(key, value) {
    this.meta.set(key, structuredClone(value));
    this.writes.count++;
    return value;
  }
}

function commit(project, index, timestamp = index + 1) {
  return {
    id: `${project}-${index}`,
    sha: `${project}-sha-${index}`,
    type: 'commit',
    project,
    timestamp,
    ts: timestamp,
    message: `fix: commit ${index}`,
  };
}

async function checkPersistedCommitIdempotency() {
  const meta = new Map();
  const writes = { count: 0 };
  const events = Array.from({ length: 4097 }, (_, index) => ({
    projectId: '/repo/a',
    commitId: `sha-${index}`,
    observedAt: index + 1,
  }));

  const first = new MemoryChronicleStore(meta, writes);
  const firstResults = await first.recordCommitEvents(events);
  assert.equal(firstResults.filter(result => result.recorded).length, events.length);
  assert.equal(await first.getLifetimeCommitCount('/repo/a'), events.length);
  assert.equal(writes.count, 1, 'one replay batch should persist once');
  first.close();

  const second = new MemoryChronicleStore(meta, writes);
  const replayResults = await second.recordCommitEvents(events);
  assert.equal(replayResults.some(result => result.recorded), false);
  assert.equal(await second.getLifetimeCommitCount('/repo/a'), events.length);

  await second.recordCommitEvent('/repo/b', 'repo-b-1', 20_000);
  const filler = Array.from({ length: 4096 }, (_, index) => ({
    projectId: '/repo/c',
    commitId: `repo-c-${index}`,
    observedAt: 30_000 + index,
  }));
  await second.recordCommitEvents(filler);
  const crossProjectReplay = await second.recordCommitEvent('/repo/b', 'repo-b-1', 20_000);
  assert.equal(crossProjectReplay.recorded, false, 'another repo must not evict the latest project identity');
  assert.equal(await second.getLifetimeCommitCount('/repo/b'), 1);
  second.close();
}

async function checkConcurrentLifetimeWriters() {
  const meta = new Map();
  const writes = { count: 0 };
  assert.equal(typeof globalThis.navigator?.locks?.request, 'function');

  const dbName = 'claudeville-smoke-concurrent';
  const first = new MemoryChronicleStore(meta, writes, dbName);
  const second = new MemoryChronicleStore(meta, writes, dbName);
  await Promise.all([
    first.recordCommitEvent('/repo/shared', 'shared-1', 1),
    second.recordCommitEvent('/repo/shared', 'shared-2', 2),
  ]);
  const reader = new MemoryChronicleStore(meta, writes, dbName);
  assert.equal(await reader.getLifetimeCommitCount('/repo/shared'), 2);
  first.close();
  second.close();
  reader.close();
}

async function checkChronicleReplayAndDispose() {
  const meta = new Map();
  const writes = { count: 0 };
  const store = new MemoryChronicleStore(meta, writes);
  const emitted = [];
  const events = Array.from({ length: 4097 }, (_, index) => commit('/repo/monuments', index));
  const monuments = new ChronicleMonuments({
    chronicleStore: store,
    eventTarget: { on: () => () => {}, emit: (...args) => emitted.push(args) },
  });
  await monuments._processCommitMilestones(events, 50_000);
  await monuments._processCommitMilestones(events, 50_100);
  assert.equal(await store.getLifetimeCommitCount('/repo/monuments'), events.length);
  assert.equal(monuments.getDiagnostics().seenCommitIds, 4096);
  monuments.dispose();
  store.close();

  let resolveBatch;
  const delayedStore = {
    recordCommitEvents: () => new Promise(resolve => { resolveBatch = resolve; }),
  };
  const delayedEmits = [];
  const delayed = new ChronicleMonuments({
    chronicleStore: delayedStore,
    eventTarget: { on: () => () => {}, emit: (...args) => delayedEmits.push(args) },
  });
  const pending = delayed._processCommitMilestones([commit('/repo/delayed', 1)], 60_000);
  await Promise.resolve();
  delayed.dispose();
  resolveBatch([{ count: 1, recorded: true }]);
  await pending;
  assert.equal(delayed.getDiagnostics().activeBanners, 0);
  assert.equal(delayedEmits.length, 0);
}

async function checkPlanterDisposeBoundary() {
  let active = true;
  let resolveGet;
  let puts = 0;
  let emits = 0;
  const planter = new MonumentPlanter({
    store: {
      get: () => new Promise(resolve => { resolveGet = resolve; }),
      put: async () => { puts++; },
    },
    rules: { buildRecord: () => ({ id: 'record-1' }) },
    eventTarget: { emit: () => { emits++; } },
  });
  const pending = planter.processEvents([{}], { isActive: () => active });
  await Promise.resolve();
  active = false;
  resolveGet(null);
  assert.deepEqual(await pending, []);
  assert.equal(puts, 0);
  assert.equal(emits, 0);
}

function gitEvent(id, timestamp, overrides = {}) {
  return {
    id,
    type: 'commit',
    timestamp,
    project: '/repo/visits',
    sha: id,
    message: `fix: ${id}`,
    ...overrides,
  };
}

function checkVisitReplayWindow() {
  const now = 1_000_000;
  const older = Array.from({ length: 600 }, (_, index) => gitEvent(`old-${index}`, now - 2_000));
  const newestPush = gitEvent('new-push', now - 1_000, {
    type: 'push',
    success: false,
    status: 'failed',
  });
  const agents = [
    { id: 'agent-a', projectPath: '/repo/visits', status: 'idle', gitEvents: older },
    { id: 'agent-b', projectPath: '/repo/visits', status: 'idle', gitEvents: [newestPush] },
  ];
  const manager = new VisitIntentManager({ now: () => now });
  manager.reconcile(agents, now);
  const agentB = [...(manager.intentsByAgent.get('agent-b')?.values() || [])];
  assert.equal(agentB.some(intent => intent.source === 'git' && intent.reason === 'push'), true);
  assert.equal(agentB.some(intent => intent.source === 'alert'), true);
  assert.equal(manager.getDiagnostics().seenGitEvents, 600);
  const pushExpiry = agentB.find(intent => intent.source === 'git').expiresAt;

  manager.reconcile(agents, now + 1_000);
  const replayedPush = [...manager.intentsByAgent.get('agent-b').values()]
    .find(intent => intent.source === 'git');
  assert.equal(replayedPush.expiresAt, pushExpiry, 'replay must not extend event-time expiry');

  manager.reconcile(agents, now + 91_000);
  assert.equal(manager.snapshot(now + 91_000).intents.some(intent => intent.source === 'git'), false);
  manager.dispose();
  manager.reconcile(agents, now + 92_000);
  assert.equal(manager.getDiagnostics().intents, 0);
}

function checkSharedRepositoryVisitCost() {
  const now = 2_000_000;
  const shared = Array.from({ length: 120 }, (_, index) => ({
    ...gitEvent(`shared-${index}`, now - 2_000 + index),
    sessionId: 'git-repo-shared',
  }));
  const agents = Array.from({ length: 100 }, (_, index) => ({
    id: `shared-agent-${index}`,
    projectPath: '/repo/shared',
    status: 'idle',
    gitEvents: shared.map(event => ({ ...event })),
  }));
  agents.at(-1).gitEvents.push({
    ...gitEvent('agent-specific-failed-push', now - 100, {
      type: 'push',
      success: false,
      status: 'failed',
    }),
    sessionId: agents.at(-1).id,
  });

  const manager = new VisitIntentManager({ now: () => now });
  manager.reconcile(agents, now);
  const diagnostics = manager.getDiagnostics();
  assert.equal(diagnostics.gitReplayNormalized, 121);
  assert.ok(diagnostics.gitReplayRawDuplicates >= 11_880);
  const finalAgentIntents = [...(manager.intentsByAgent.get(agents.at(-1).id)?.values() || [])];
  assert.equal(finalAgentIntents.some(intent => intent.source === 'git' && intent.reason === 'push'), true);
  assert.equal(finalAgentIntents.some(intent => intent.source === 'alert'), true);

  const startedAt = performance.now();
  for (let index = 0; index < 20; index++) manager.reconcile(agents, now + index + 1);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 100, `20 cached shared-repo reconciles took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(manager.getDiagnostics().gitReplayCacheHits >= 20);
  manager.dispose();
  return elapsedMs;
}

function checkPostDisposeNoMutation() {
  const landmark = new LandmarkActivity();
  landmark.dispose();
  landmark.reconcile([{ id: 'late', tokens: { input: 10 } }], [], 10_000);
  assert.equal(landmark.getDiagnostics().items, 0);
  assert.equal(landmark.getDiagnostics().previousTokenTotals, 0);

  const allocator = new VisitTileAllocator();
  allocator.dispose();
  allocator.updateContext({ buildings: new Map([['late', {}]]) });
  assert.equal(allocator.allocate({ agent: { id: 'late' } }), null);
  assert.equal(allocator.getDiagnostics().buildings, 0);

  const world = { agents: new Map() };
  const relationships = new RelationshipState(world);
  relationships.dispose();
  const a = { agent: { id: 'a' }, x: 0, y: 0 };
  const b = { agent: { id: 'b' }, x: 1, y: 1 };
  a.chatPartner = b;
  b.chatPartner = a;
  relationships.reconcile({ agentSprites: new Map([['a', a], ['b', b]]) });
  assert.equal(relationships.getSnapshot(), null);
  assert.equal(relationships.getDiagnostics().chatPairs, 0);
  assert.equal(relationships.getDiagnostics().rememberedSpriteTiles, 0);
}

function checkRelationshipGateTileBounds() {
  const world = { agents: new Map() };
  const relationships = new RelationshipState(world);
  const sprites = new Map();
  for (let index = 0; index < 1000; index++) {
    const agent = { id: `gate-${index}`, position: { x: 99, y: 99 } };
    const sprite = { agent, x: 64, y: 32 };
    sprites.set(agent.id, sprite);
    world.agents.set(agent.id, agent);
    relationships.reconcile({ agentSprites: sprites });
    const departureTile = worldToTile(sprite.x, sprite.y);
    world.agents.delete(agent.id);
    eventBus.emit('agent:removed', agent);
    sprite.x += 64;
    relationships.reconcile({ agentSprites: sprites });
    assert.equal(relationships.getDiagnostics().rememberedSpriteTiles, 1);
    assert.deepEqual(relationships.getSnapshot().recentDepartures.at(-1).lastTile, departureTile);
    sprites.delete(agent.id);
    relationships.reconcile({ agentSprites: sprites });
    assert.equal(relationships.getDiagnostics().rememberedSpriteTiles, 0);
    assert.deepEqual(relationships.getSnapshot().recentDepartures.at(-1).lastTile, departureTile);
  }
  relationships.dispose();
}

async function checkMonumentProjectionRetention() {
  const now = 3_000_000_000;
  const month = 30 * 24 * 60 * 60 * 1000;
  const records = Array.from({ length: 7 }, (_, index) => ({
    id: `forge-${index}`,
    district: 'forge',
    kind: 'feature',
    weight: 'minor',
    project: '/repo/projection',
    label: `Milestone ${index}`,
    lore: `Recorded lore ${index}`,
    tileX: index,
    tileY: index,
    plantedAt: index === 0 ? now - month : now - (7 - index) * 100,
    ts: index === 0 ? now - 700 : now - Math.max(1, index - 1) * 100,
  }));
  const persisted = new Map(records.map(record => [record.id, record]));
  const monuments = new ChronicleMonuments({
    store: {
      queryRange: async () => [...persisted.values()],
      get: async (_store, id) => persisted.get(id),
      put: async (_store, record) => persisted.set(record.id, record),
    },
    eventTarget: { on: () => () => {}, emit() {} },
  });
  await monuments.hydrate(now);
  const ids = at => monuments.enumerateDrawables(at).map(drawable => drawable.payload.id);
  const visible = records.slice(1).map(record => record.id);
  assert.deepEqual(ids(now), [...visible, 'founding:forge'], 'equal ts values preserve record insertion order');
  const founding = monuments.enumerateDrawables(now).at(-1).payload;
  assert.equal(founding.lore, records[0].lore);
  assert.equal(founding.tileX, records[0].tileX);
  assert.equal(founding.plantedAt, records[0].plantedAt);
  assert.deepEqual(monuments.ledgerFor(founding, now), {
    district: 'forge',
    rows: [records[6], records[5], records[4]],
    overflow: 4,
    total: 7,
  });
  assert.deepEqual(monuments.enumerateDrawables(now, {
    getViewportTileBounds: () => ({ startX: 1, endX: 1, startY: 1, endY: 1 }),
  }).map(drawable => drawable.payload.id), ['forge-1']);
  assert.deepEqual(ids(now + 1), visible, 'the founding row expires just after its month boundary, before update');
  assert.equal(monuments.ledgerFor(records[1], now + 1).total, 6);
  const planted = await monuments.update([{
    id: 'planter',
    gitEvents: [gitEvent('projection-new', now + 2, {
      project: '/repo/projection',
      message: 'feat: new retained monument',
    })],
  }], {}, now + 2);
  assert.equal(planted.length, 1);
  assert.deepEqual(ids(now + 2), [planted[0].id, ...visible.slice(0, 5), 'founding:forge']);
  assert.equal(monuments.enumerateDrawables(now + 2).at(-1).payload.lore, records[1].lore);
  assert.equal(monuments.ledgerFor(planted[0], now + 2).total, 7);
  assert.equal(monuments.ledgerFor(planted[0], now + 2).rows[0].id, planted[0].id);
  assert.equal(monuments.records.has(records[0].id), false, 'expired hydrated memory is released on update');
  assert.equal(persisted.has(records[0].id), true, 'projection expiry never deletes persisted monument history');
  monuments.dispose();
}

async function checkTrailHydrateDisposeBoundary() {
  let resolveQuery;
  const trail = new TrailRenderer({
    store: {
      queryRange: () => new Promise(resolve => { resolveQuery = resolve; }),
    },
  });
  const hydrate = trail.hydrate(10_000);
  await Promise.resolve();
  await trail.dispose();
  resolveQuery([{ id: 'late', agentId: 'late', ts: 10_000, tileX: 1, tileY: 1 }]);
  await hydrate;
  assert.equal(trail.samplesByAgent.size, 0);
  assert.equal(trail._loaded, false);
}

function checkTrailSamplingBounds() {
  const stationaryAgent = {
    id: 'stationary',
    provider: 'claude',
    position: { tileX: 99, tileY: 99 },
  };
  const stationarySprite = { x: 160, y: 80 };
  const stationaryTrail = new TrailRenderer({
    sprites: new Map([[stationaryAgent.id, stationarySprite]]),
  });
  const startedAt = 1_000_000;
  for (let second = 0; second < 600; second++) {
    stationaryTrail.capture([stationaryAgent], startedAt + second * 1000);
  }
  const stationaryDiagnostics = stationaryTrail.getDiagnostics();
  const [stationarySample] = stationaryTrail.samplesByAgent.get(stationaryAgent.id);
  const expectedTile = worldToTile(stationarySprite.x, stationarySprite.y);
  assert.equal(stationaryDiagnostics.totalSamples, 1);
  assert.equal(stationaryDiagnostics.duplicateDrops, 599);
  assert.equal(stationarySample.tileX, expectedTile.tileX);
  assert.equal(stationarySample.tileY, expectedTile.tileY);
  assert.notEqual(stationarySample.tileX, stationaryAgent.position.tileX);

  const agents = Array.from({ length: 100 }, (_, index) => ({
    id: `moving-${index}`,
    position: { tileX: 0, tileY: 0 },
  }));
  const sprites = new Map(agents.map((agent, index) => [
    agent.id,
    { x: index * 3, y: index * 2 },
  ]));
  const boundedTrail = new TrailRenderer({ sprites });
  for (let second = 0; second < 800; second++) {
    for (const sprite of sprites.values()) sprite.x += 64;
    boundedTrail.capture(agents, startedAt + second * 1000);
  }
  const boundedDiagnostics = boundedTrail.getDiagnostics();
  assert.ok(boundedDiagnostics.totalSamples <= boundedDiagnostics.globalLimit);
  assert.ok(
    boundedDiagnostics.totalSamples >= Math.floor(boundedDiagnostics.globalLimit * 0.5),
    'moving trail fixture did not retain enough samples to exercise the global bound',
  );
  assert.ok(boundedDiagnostics.compactedSamples > 0, 'moving trail fixture did not exercise compaction');
  assert.equal(boundedTrail.samplesByAgent.size, agents.length);
  assert.ok(
    [...boundedTrail.samplesByAgent.values()]
      .every(samples => samples.length >= 2 && samples.length <= boundedDiagnostics.perAgentLimit),
  );
  assert.equal(boundedTrail.pending.length, 0);

  const directTrail = new TrailRenderer();
  const directSamples = Array.from({ length: 500 }, (_, index) => ({
    agentId: 'direct',
    ts: startedAt + index * 1000,
    tileX: index,
    tileY: index,
  }));
  directTrail.samplesByAgent.set('direct', directSamples);
  directTrail._totalSamples = directSamples.length;
  let directRenderSamples = 0;
  directTrail._trailPoints = samples => {
    directRenderSamples = samples.length;
    return samples.map(sample => ({ x: sample.tileX, y: sample.tileY, ts: sample.ts }));
  };
  directTrail._drawTrailPoints = () => {};
  directTrail.draw(
    { save() {}, setTransform() {}, restore() {} },
    { getViewportTileBounds: () => null },
    { width: 1280, height: 720, dpr: 1 },
    startedAt + 500_000,
  );
  assert.equal(
    directRenderSamples,
    directTrail.getDiagnostics().renderPerAgentLimit,
    'direct trail rendering must use the same per-agent cap as cached rendering',
  );
  stationaryTrail.dispose();
  boundedTrail.dispose();
  directTrail.dispose();

  return {
    stationarySamples: stationaryDiagnostics.totalSamples,
    stationaryDuplicateDrops: stationaryDiagnostics.duplicateDrops,
    boundedSamples: boundedDiagnostics.totalSamples,
    compactedSamples: boundedDiagnostics.compactedSamples,
    directRenderSamples,
  };
}

function checkTrailSingletonBounds() {
  const startedAt = 1_000_000;
  const live = { id: 'live-overlay', status: 'working', position: { tileX: 0, tileY: 0 } };
  const action = { id: 'action-overlay', status: 'waiting_on_user', position: { tileX: 0, tileY: 1 } };
  const selected = { id: 'selected-overlay', position: { tileX: 0, tileY: 2 } };
  const trail = new TrailRenderer({ world: { agents: new Map([[live.id, live], [action.id, action]]) } });
  trail.setSelectedAgent(selected.id);
  for (let second = 0; second < 30; second++) {
    for (const agent of [live, action, selected]) agent.position.tileX = second;
    trail.capture([live, action, selected], startedAt + second * 1000);
  }
  const selectedTail = trail.samplesByAgent.get(selected.id).slice(-24);
  const actionTail = trail.samplesByAgent.get(action.id).slice(-12);
  const historical = Array.from({ length: 13_000 }, (_, index) => ({
    id: `one-shot-${index}`,
    position: { tileX: index % 40, tileY: Math.floor(index / 40) % 40 },
  }));
  trail.capture(historical.slice(0, 6500), startedAt + 60_000);
  trail.capture(historical.slice(6500), startedAt + 30_000);
  const diagnostics = trail.getDiagnostics();
  assert.ok(diagnostics.totalSamples <= diagnostics.globalLimit, 'unique singleton identities must obey the global bound');
  assert.equal(
    [...trail.samplesByAgent.values()].reduce((sum, samples) => sum + samples.length, 0),
    diagnostics.totalSamples,
    'whole-bucket eviction must preserve exact accounting',
  );
  assert.equal(trail.samplesByAgent.has(historical[6500].id), false, 'oldest historical singleton is evicted first, not first inserted');
  assert.equal(trail.samplesByAgent.has(historical[0].id), true);
  assert.equal(trail.samplesByAgent.has(historical.at(-1).id), true);
  assert.deepEqual(trail.samplesByAgent.get(selected.id), selectedTail, 'departed selection keeps its complete recent overlay');
  assert.deepEqual(trail.samplesByAgent.get(action.id), actionTail, 'action-needed overlay keeps its complete recent path');
  assert.ok(trail.samplesByAgent.get(live.id).length >= 2, 'live route survives historical eviction');
  trail._pruneMemory(startedAt + 60_000 + 60 * 60 * 1000 + 1, { force: true });
  assert.equal(trail.getDiagnostics().totalSamples, 0, 'one-hour expiry still releases every retained sample');
  trail.dispose();
  return { singletonSamples: diagnostics.totalSamples, singletonAgents: diagnostics.agentsWithSamples };
}

async function checkTrailPauseHydrationBoundary() {
  let resolveQuery;
  let leaseAcquisitions = 0;
  const lease = {
    acquired: true,
    renew: () => true,
    release: () => {},
  };
  const store = {
    queryRange: () => new Promise(resolve => { resolveQuery = resolve; }),
    acquireCaptureLease: () => {
      leaseAcquisitions++;
      return lease;
    },
  };
  const trail = new TrailRenderer({ store });
  const update = trail.update([], 10_000);
  await Promise.resolve();
  trail.pause();
  resolveQuery([{ id: 'late', agentId: 'late', ts: 10_000, tileX: 1, tileY: 1 }]);
  await update;
  assert.equal(trail.getDiagnostics().paused, true);
  assert.equal(trail.samplesByAgent.size, 0);
  assert.equal(leaseAcquisitions, 0);

  store.queryRange = async () => [];
  trail.resume();
  await trail.update([], 11_000);
  assert.equal(leaseAcquisitions, 1);
  await trail.dispose();
}

await checkPersistedCommitIdempotency();
await checkConcurrentLifetimeWriters();
await checkChronicleReplayAndDispose();
await checkPlanterDisposeBoundary();
checkVisitReplayWindow();
const sharedRepositoryVisitMs = checkSharedRepositoryVisitCost();
checkPostDisposeNoMutation();
checkRelationshipGateTileBounds();
await checkMonumentProjectionRetention();
await checkTrailHydrateDisposeBoundary();
const trailBounds = { ...checkTrailSamplingBounds(), ...checkTrailSingletonBounds() };
await checkTrailPauseHydrationBoundary();

console.log(JSON.stringify({
  ok: true,
  smoke: 'world-state-bounds',
  sharedRepositoryVisit20ReconcilesMs: Number(sharedRepositoryVisitMs.toFixed(2)),
  trailBounds,
}));
