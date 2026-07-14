#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const DEFAULT_BROWSER_SECONDS = Number(process.env.CLAUDEVILLE_BROWSER_SOAK_SECONDS) || 600;
const DEFAULT_SERVER_SECONDS = Number(process.env.CLAUDEVILLE_SERVER_SOAK_SECONDS) || 1800;
const DEFAULT_INTERVAL_SECONDS = Number(process.env.CLAUDEVILLE_SOAK_INTERVAL_SECONDS) || 60;
const MAX_HEAP_PLATEAU_BYTES = 8 * 1024 * 1024;
const MAX_SERVER_RSS_PLATEAU_BYTES = 64 * 1024 * 1024;
const MAX_STEADY_GIT_COMMANDS_PER_SECOND = 2.5;
const MAX_EVENT_LOOP_P95_MS = 250;
const MAX_VOLATILE_CANVAS_PIXELS = 32 * 1024 * 1024;

function usage() {
  console.log(`Usage: node scripts/smoke/performance-soak.mjs [options]

Options:
  --url=<url>               ClaudeVille URL (default: ${DEFAULT_URL})
  --browser-seconds=<n>     Active World duration (default: ${DEFAULT_BROWSER_SECONDS})
  --server-seconds=<n>      Server/reconnect duration (default: ${DEFAULT_SERVER_SECONDS})
  --interval-seconds=<n>    Checkpoint interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --headed                  Show the Chromium window
  --help                    Print this help

The default run is the release-gate 10-minute World and 30-minute server soak.
Provider append/rotation behavior is covered by watcher-runtime.mjs; this script
does not mutate live provider data.`);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL.replace(/\/+$/, ''),
    browserSeconds: DEFAULT_BROWSER_SECONDS,
    serverSeconds: DEFAULT_SERVER_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      options.headed = true;
      continue;
    }
    const [flag, inlineValue] = arg.split('=', 2);
    if (!['--url', '--browser-seconds', '--server-seconds', '--interval-seconds'].includes(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    if (flag === '--url') options.url = value.replace(/\/+$/, '');
    if (flag === '--browser-seconds') options.browserSeconds = Number(value);
    if (flag === '--server-seconds') options.serverSeconds = Number(value);
    if (flag === '--interval-seconds') options.intervalSeconds = Number(value);
  }
  for (const [name, value] of [
    ['browser seconds', options.browserSeconds],
    ['server seconds', options.serverSeconds],
    ['interval seconds', options.intervalSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  return options;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function installListenerAudit(page) {
  await page.addInitScript(() => {
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const targetIds = new WeakMap();
    const listenerIds = new WeakMap();
    const active = new Set();
    let nextTargetId = 1;
    let nextListenerId = 1;
    const idFor = (map, value, next) => {
      if (!map.has(value)) map.set(value, next());
      return map.get(value);
    };
    const captureFor = options => (
      typeof options === 'boolean' ? options : Boolean(options?.capture)
    );
    const keyFor = (target, type, listener, options) => {
      const targetId = idFor(targetIds, target, () => nextTargetId++);
      const listenerId = idFor(listenerIds, listener, () => nextListenerId++);
      return `${targetId}|${type}|${listenerId}|${captureFor(options) ? 1 : 0}`;
    };
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      originalAdd.call(this, type, listener, options);
      if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
        active.add(keyFor(this, type, listener, options));
      }
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
      originalRemove.call(this, type, listener, options);
      if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
        active.delete(keyFor(this, type, listener, options));
      }
    };
    window.__cvSoakListenerCount = () => active.size;
  });
}

async function measureFrames(page, frameCount = 45) {
  return page.evaluate(async count => {
    const deltas = await new Promise(resolve => {
      const values = [];
      let previous = performance.now();
      const tick = now => {
        values.push(now - previous);
        previous = now;
        if (values.length >= count + 1) resolve(values.slice(1));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((a, b) => a - b);
    const percentile = value => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * value))];
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return {
      samples: deltas.length,
      meanMs: Math.round(mean * 100) / 100,
      p50Ms: Math.round(percentile(0.5) * 100) / 100,
      p95Ms: Math.round(percentile(0.95) * 100) / 100,
      maxMs: Math.round(deltas[deltas.length - 1] * 100) / 100,
      fps: Math.round(1000 / mean),
    };
  }, frameCount);
}

async function sampleBrowser(page, cdp, elapsedSeconds) {
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(50);
  const frame = await measureFrames(page);
  const snapshot = await page.evaluate(async () => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const budget = window.__claudeVillePerf?.canvasBudget?.() || null;
    const app = window.__claudeVilleApp;
    return {
      heapUsed: performance.memory?.usedJSHeapSize ?? null,
      listeners: window.__cvSoakListenerCount?.() ?? null,
      eventBusListeners: [...eventBus.listeners.values()]
        .reduce((sum, callbacks) => sum + callbacks.size, 0),
      agents: app?.world?.agents?.size ?? null,
      cards: document.querySelectorAll('.dash-card').length,
      avatarCanvases: document.querySelectorAll('.dash-card canvas, .activity-panel canvas').length,
      canvasElements: document.querySelectorAll('canvas').length,
      budget,
    };
  });
  const runtime = snapshot.budget?.runtime || {};
  return {
    elapsedSeconds,
    heapUsed: snapshot.heapUsed,
    listeners: snapshot.listeners,
    eventBusListeners: snapshot.eventBusListeners,
    agents: snapshot.agents,
    cards: snapshot.cards,
    avatarCanvases: snapshot.avatarCanvases,
    canvasElements: snapshot.canvasElements,
    frame,
    canvas: {
      visiblePixels: snapshot.budget?.visibleCanvasPixels ?? null,
      volatilePixels: snapshot.budget?.volatilePixels ?? null,
      retainedAssetPixels: snapshot.budget?.retainedAssetPixels ?? null,
    },
    boundedState: runtime.boundedState || null,
    harbor: runtime.harbor || null,
    events: runtime.events || null,
    landmarks: runtime.landmarks || null,
    visits: runtime.visits || null,
    pathfinder: runtime.pathfinder || null,
    frameFailures: runtime.frameFailures || null,
  };
}

function openWebSocketProbe(page, url, timeoutMs = 5000) {
  return page.evaluate(({ probeUrl, probeTimeoutMs }) => new Promise((resolve, reject) => {
    const socket = new WebSocket(probeUrl.replace(/^http/, 'ws'));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('WebSocket reconnect probe timed out')), probeTimeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', deltas: true }));
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'init') finish(null, message.sessions?.length ?? 0);
      } catch (error) {
        finish(error);
      }
    };
    socket.onerror = () => finish(new Error('WebSocket reconnect probe failed'));
  }), { probeUrl: url, probeTimeoutMs: timeoutMs });
}

async function sampleServer(probePage, url, elapsedSeconds) {
  const reconnectSessions = await openWebSocketProbe(probePage, url);
  const response = await fetch(`${url}/api/perf`);
  if (!response.ok) throw new Error(`/api/perf returned HTTP ${response.status}`);
  const perf = await response.json();
  return {
    elapsedSeconds,
    reconnectSessions,
    websocketClients: perf.websocketClients,
    runtime: perf.runtime,
    watchers: perf.watchers,
    caches: perf.caches,
    providers: perf.providers,
    tailCache: perf.tailCache,
    gitRate: perf.gitRate,
    gitCommandCount: perf.gitEnrichment?.gitCommandCount ?? null,
    gitCommandTimeMs: perf.gitEnrichment?.gitCommandTimeMs ?? null,
    dirtyMarks: perf.dirty?.marks ?? null,
    lastBroadcast: perf.lastBroadcast,
  };
}

function assertBrowserBounds(sample) {
  const state = sample.boundedState || {};
  assert.ok(state.lightFadeColors <= state.lightFadeColorLimit, 'light fade cache exceeded its cap');
  assert.ok(state.crowdBumpCooldowns <= state.crowdBumpCooldownLimit, 'crowd cooldowns exceeded their cap');
  const harbor = sample.harbor || {};
  for (const [countKey, limitKey] of [
    ['seenEventIds', 'maxSeenEventIds'],
    ['pushEvents', 'maxPushEvents'],
    ['ships', 'maxShips'],
    ['batches', 'maxBatches'],
    ['repoQuays', 'maxRepoQuays'],
    ['eventTombstones', 'maxEventTombstones'],
    ['commitReplayFloors', 'maxCommitReplayFloors'],
    ['overflowDockCounts', 'maxOverflowDockCounts'],
    ['repoFirstSeen', 'maxRepoFirstSeen'],
  ]) {
    assert.ok(harbor[countKey] <= harbor[limitKey], `Harbor ${countKey} exceeded ${limitKey}`);
  }
  assert.ok(sample.events?.emittedToolKeys <= sample.events?.maxEmittedToolKeysTotal,
    'tool-event keys exceeded their cap');
  assert.ok(sample.pathfinder?.cacheEntries <= sample.pathfinder?.cacheLimit,
    'pathfinder cache exceeded its cap');
  assert.equal(sample.frameFailures?.paused, false, 'World frame loop paused after repeated failures');
  assert.ok(Number.isFinite(sample.canvas?.volatilePixels), 'volatile canvas diagnostics are missing');
  assert.ok(sample.canvas.volatilePixels <= MAX_VOLATILE_CANVAS_PIXELS,
    `volatile canvas pixels were ${sample.canvas.volatilePixels}`);
}

function assertBrowserPlateau(samples) {
  if (samples.length < 3) return;
  const baseline = samples[0];
  const final = samples[samples.length - 1];
  assert.equal(final.listeners, baseline.listeners, 'DOM listener count changed during World soak');
  assert.equal(final.eventBusListeners, baseline.eventBusListeners,
    'event-bus listener count changed during World soak');
  assert.equal(final.canvasElements, baseline.canvasElements, 'canvas element count changed during World soak');
  assert.equal(final.cards, baseline.cards, 'dashboard cards appeared during World soak');
  assert.equal(final.avatarCanvases, baseline.avatarCanvases, 'avatar canvases appeared during World soak');
  assert.equal(final.canvas.visiblePixels, baseline.canvas.visiblePixels,
    'visible canvas backing pixels changed during World soak');
  assert.equal(final.canvas.retainedAssetPixels, baseline.canvas.retainedAssetPixels,
    'retained asset pixels changed during World soak');
  const heapSamples = samples.map(sample => sample.heapUsed).filter(Number.isFinite);
  if (heapSamples.length >= 3) {
    const secondHalf = heapSamples.slice(Math.floor(heapSamples.length / 2));
    const floor = Math.min(...secondHalf);
    assert.ok(heapSamples.at(-1) - floor <= MAX_HEAP_PLATEAU_BYTES,
      `forced-GC heap did not plateau within ${MAX_HEAP_PLATEAU_BYTES} bytes`);
  }
}

function assertServerPlateau(samples) {
  if (samples.length < 3) return;
  const rssSamples = samples
    .map(sample => sample.runtime?.memory?.rss)
    .filter(Number.isFinite);
  if (rssSamples.length >= 3) {
    const secondHalf = rssSamples.slice(Math.floor(rssSamples.length / 2));
    const floor = Math.min(...secondHalf);
    assert.ok(rssSamples.at(-1) - floor <= MAX_SERVER_RSS_PLATEAU_BYTES,
      `server RSS did not plateau within ${MAX_SERVER_RSS_PLATEAU_BYTES} bytes`);
  }

  for (const sample of samples) {
    const p95 = sample.runtime?.eventLoop?.delayMs?.p95;
    assert.ok(Number.isFinite(sample.runtime?.memory?.rss), 'server RSS diagnostics are missing');
    assert.ok(Number.isFinite(p95), 'event-loop p95 diagnostics are missing');
    assert.ok(p95 <= MAX_EVENT_LOOP_P95_MS,
      `event-loop p95 was ${p95} ms at ${sample.elapsedSeconds}s`);
    const tailCache = sample.tailCache;
    assert.ok(Number.isFinite(tailCache?.estimatedBytes) && Number.isFinite(tailCache?.byteLimit),
      'tail-cache diagnostics are missing');
    assert.ok(tailCache.estimatedBytes <= tailCache.byteLimit,
      `tail cache used ${tailCache.estimatedBytes} bytes (limit ${tailCache.byteLimit})`);
    assert.ok(Number.isFinite(sample.gitCommandCount), 'Git command diagnostics are missing');
  }

  const steadySamples = samples.slice(1);
  const first = steadySamples[0];
  const last = steadySamples.at(-1);
  const elapsed = last.elapsedSeconds - first.elapsedSeconds;
  if (elapsed > 0 && Number.isFinite(first.gitCommandCount) && Number.isFinite(last.gitCommandCount)) {
    const rate = (last.gitCommandCount - first.gitCommandCount) / elapsed;
    assert.ok(rate <= MAX_STEADY_GIT_COMMANDS_PER_SECOND,
      `steady git command rate was ${rate.toFixed(2)}/s`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browserSamples = [];
  const serverSamples = [];
  const browserErrors = [];
  const startedAt = Date.now();
  const browserUntil = startedAt + options.browserSeconds * 1000;
  const serverUntil = startedAt + options.serverSeconds * 1000;
  const finishAt = Math.max(browserUntil, serverUntil);
  const intervalMs = options.intervalSeconds * 1000;

  const browser = await chromium.launch({
    headless: !options.headed,
    args: ['--enable-precise-memory-info'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const probePage = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => browserErrors.push(error.message));
  await installListenerAudit(page);
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__claudeVilleApp?._bootState === 'ready', null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__claudeVillePerf?.canvasBudget === 'function');
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  let browserOpen = true;
  let nextCheckpointAt = startedAt;
  try {
    while (Date.now() <= finishAt) {
      const now = Date.now();
      if (now < nextCheckpointAt) await sleep(nextCheckpointAt - now);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
      if (browserOpen && Date.now() <= browserUntil) {
        const sample = await sampleBrowser(page, cdp, elapsedSeconds);
        assertBrowserBounds(sample);
        browserSamples.push(sample);
        console.log(JSON.stringify({ type: 'browser', ...sample }));
      } else if (browserOpen) {
        browserOpen = false;
        await page.close();
      }
      if (Date.now() <= serverUntil) {
        const sample = await sampleServer(probePage, options.url, elapsedSeconds);
        const physicalWatchEntries = sample.watchers?.linux?.watchEntries;
        if (Number.isFinite(physicalWatchEntries)) {
          assert.ok(physicalWatchEntries < 1000,
            `physical watcher count was ${physicalWatchEntries}`);
        }
        serverSamples.push(sample);
        console.log(JSON.stringify({ type: 'server', ...sample }));
      }
      nextCheckpointAt += intervalMs;
      if (nextCheckpointAt > finishAt) break;
    }
  } finally {
    await browser.close();
  }

  assertBrowserPlateau(browserSamples);
  assertServerPlateau(serverSamples);
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  const summary = {
    ok: true,
    url: options.url,
    durations: {
      browserSeconds: options.browserSeconds,
      serverSeconds: options.serverSeconds,
      intervalSeconds: options.intervalSeconds,
    },
    checkpoints: {
      browser: browserSamples.length,
      server: serverSamples.length,
    },
    browser: browserSamples.length ? {
      heapFirst: browserSamples[0].heapUsed,
      heapLast: browserSamples.at(-1).heapUsed,
      heapMin: Math.min(...browserSamples.map(sample => sample.heapUsed).filter(Number.isFinite)),
      heapMax: Math.max(...browserSamples.map(sample => sample.heapUsed).filter(Number.isFinite)),
      listeners: browserSamples.at(-1).listeners,
      eventBusListeners: browserSamples.at(-1).eventBusListeners,
      lightFadeColors: browserSamples.at(-1).boundedState?.lightFadeColors,
      harborSeenEvents: browserSamples.at(-1).harbor?.seenEventIds,
      frameP95Ms: browserSamples.map(sample => sample.frame.p95Ms),
    } : null,
    server: serverSamples.length ? {
      rssFirst: serverSamples[0].runtime?.memory?.rss,
      rssLast: serverSamples.at(-1).runtime?.memory?.rss,
      heapFirst: serverSamples[0].runtime?.memory?.heapUsed,
      heapLast: serverSamples.at(-1).runtime?.memory?.heapUsed,
      physicalWatchesMax: (() => {
        const values = serverSamples.map(sample => sample.watchers?.linux?.watchEntries).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
      })(),
      gitCommandsFirst: serverSamples[0].gitCommandCount,
      gitCommandsLast: serverSamples.at(-1).gitCommandCount,
      broadcastMaxMs: Math.max(...serverSamples.map(sample => sample.lastBroadcast?.elapsed || 0)),
    } : null,
  };
  console.log(JSON.stringify({ type: 'summary', ...summary }, null, 2));
}

main().catch(error => {
  console.error(`[performance-soak] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
