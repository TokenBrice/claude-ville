// Run directly. The optional frame and storage profiles use disposable browser contexts.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchChromium, gpuLaunchArgs } from './support/chromium.mjs';
import { startIsolatedServer } from './support/isolated-server.mjs';

const server = await startIsolatedServer();
let browser;
const errors = [];
const profileBackend = process.argv.includes('--canvas') ? 'canvas' : 'webgl';
const options = { viewport: { width: 1920, height: 1080 }, timezoneId: 'Europe/Belgrade' };
const shots = process.argv.find(arg => arg.startsWith('--shots='))?.slice('--shots='.length);

async function openWorld(page, query) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.baseUrl + '/?' + query, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__claudeVilleApp?.renderer?._worldFramePresented, null, { timeout: 60_000 });
}

async function twilightProfile(twilight, sweep) {
  const page = await browser.newPage(options);
  try {
    await openWorld(page, 'sim=1&scenario=readme-showcase&timelapse=1&renderer=' + profileBackend);
    const result = await page.evaluate(async ({ twilight, sweep }) => {
      const renderer = window.__claudeVilleApp.renderer;
      const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
      renderer.cameraDirector.setAutoMode(false);
      renderer.camera.noteUserInput();
      renderer.setCameraPose({ ...tileToWorld({ tileX: 20, tileY: 20 }), zoom: renderer.camera.tierZoom(1) });
      const clock = renderer.replay.replayClock;
      const at = new Date(clock.start);
      if (twilight === 'dusk') at.setHours(0, Math.round(renderer._lastAtmosphere.solar.sunsetMinute) - 30, 0, 0);
      clock.elapsed = clock.playhead = (+at - clock.start) / (clock.end - clock.start) * clock.duration;
      clock.advance(0, false);
      // Settle each fresh page at the same starting sun before observing the
      // first sweep. The dense showcase has no authored timeline steps.
      clock.advance = () => {};
      await new Promise(resolve => setTimeout(resolve, 12_000));
      if (sweep) delete clock.advance;
      const entries = [];
      const observer = new PerformanceObserver(list => entries.push(...list.getEntries()));
      observer.observe({ type: 'longtask' });
      const gaps = [];
      const start = performance.now();
      let last = start;
      renderer.startPerformanceProfile();
      await new Promise(resolve => {
        const frame = now => {
          if (now > last) gaps.push(now - last);
          last = now;
          if (now - start < 6000) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      entries.push(...observer.takeRecords());
      observer.disconnect();
      const { samples: frames, renderTimings } = renderer.stopPerformanceProfile();
      const stats = values => {
        values.sort((a, b) => a - b);
        const round = value => Math.round(value * 10) / 10;
        return {
          count: values.length, mean: round(values.reduce((sum, n) => sum + n, 0) / values.length),
          p95: round(values[Math.floor(values.length * 0.95)]), max: round(values.at(-1)),
        };
      };
      return {
        backend: renderer.worldRendererMode, agents: renderer.agentSprites.size,
        adapter: renderer.gpuWorld?.gl?.getParameter(renderer.gpuWorld.gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL),
        start: at.toTimeString().slice(0, 8), end: renderer._lastAtmosphere.clock.label,
        rafMs: stats(gaps), worldMs: stats(frames.map(f => f.totalMs)),
        slowStages: renderTimings?.segments?.slice().sort((a, b) => b.p95 - a.p95).slice(0, 4).map(({ label, p95 }) => [label, Math.round(p95)]),
        longTasks: entries.length, longMs: entries.reduce((sum, e) => sum + e.duration, 0),
      };
    }, { twilight, sweep });
    console.log(JSON.stringify({ twilight, sweep, load1: os.loadavg()[0], ...result }));
    assert.equal(result.backend, profileBackend, 'the frame comparison requires the requested backend');
    if (shots) {
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `${profileBackend}-${twilight}-${sweep ? 'sweep' : 'static'}.png`) });
    }
  } finally {
    await page.close();
  }
}

async function profileBuild() {
  const page = await browser.newPage(options);
  try {
    await page.route('**/__retold-build', route => route.fulfill({ contentType: 'text/html', body: '<title>Recorded day</title>' }));
    await page.goto(server.baseUrl + '/__retold-build');
    const result = await page.evaluate(async () => {
      const { ChronicleStore, trailSampleId } = await import('/src/infrastructure/ChronicleStore.js');
      const { dayBounds } = await import('/src/application/ChronicleLog.js');
      const { loadChronicleScenario } = await import('/src/application/ChronicleScenario.js');
      const date = '2026-11-17';
      const { lower } = dayBounds(date);
      const store = new ChronicleStore();
      const ids = Array.from({ length: 25 }, (_, i) => 'fixture-' + i);
      for (let minute = 0; minute < 1440; minute += 5) {
        const batch = [];
        for (let sec = minute * 60; sec < (minute + 5) * 60; sec++) {
          const ts = lower + sec * 1000;
          for (const [i, agentId] of ids.entries()) {
            batch.push({ id: trailSampleId(agentId, ts), agentId, provider: 'codex', model: 'gpt-6-astra',
              ts, tileX: i, tileY: sec % 19, dayProgress: sec / 86400, phase: 'day' });
          }
        }
        await store.bulkPut('trailSamples', batch);
      }
      store.close();
      const start = performance.now();
      const { scenario } = await loadChronicleScenario(date);
      window.fixtureScenario = scenario;
      return { rows: 2160000, buildMs: Math.round(performance.now() - start),
        steps: scenario.timeline.length, jsonBytes: new Blob([JSON.stringify(scenario)]).size };
    });
    const session = await page.context().newCDPSession(page);
    const usedHeap = async () => {
      await session.send('HeapProfiler.collectGarbage');
      return (await session.send('Runtime.getHeapUsage')).usedSize;
    };
    const withScenario = await usedHeap();
    await page.evaluate(() => delete window.fixtureScenario);
    const retainedHeapBytes = withScenario - await usedHeap();
    console.log(JSON.stringify({ load1: os.loadavg()[0], ...result, retainedHeapBytes }));
    assert.equal(result.steps, 25 * 288);
    assert.ok(result.jsonBytes < 1024 * 1024);
    assert.ok(result.buildMs < 1000, 'indexed read and build must finish within a second');
  } finally {
    await page.close();
  }
}

async function smoke() {
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await openWorld(page, 'sim=1&scenario=readme-showcase&timelapse=1&renderer=canvas');
    await page.waitForFunction(() => window.__claudeVilleApp.agentSimulator.replayClock.playhead >= 3000);
    const demo = await page.evaluate(() => {
      const { renderer, agentSimulator, villageState } = window.__claudeVilleApp;
      return { phase: renderer._lastAtmosphere.clock.phase, time: +renderer._lastAtmosphere.effectiveDate,
        clock: agentSimulator.replayClock.now, elapsed: agentSimulator.replayClock.playhead,
        seaSecond: renderer._replaySea?.second, motion: renderer.motionTimeMs, source: villageState.source, retold: villageState.retold };
    });
    assert.equal(demo.time, demo.clock);
    assert.equal(demo.elapsed % 3000, 0);
    assert.equal(demo.seaSecond, demo.elapsed / 1000);
    assert.equal(demo.motion, 0);
    assert.equal(demo.source, 'simulator');
    assert.equal(demo.retold, false);

    await page.goto(server.baseUrl + '/?retold=2026-11-17', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__claudeVilleApp?.villageState?.phase === 'no-recorded-samples');
    assert.match(await page.locator('#worldEmpty').innerText(), /NO RECORDED TRAIL SAMPLES/);
    const absent = await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'claudeville-chronicle'));
    assert.equal(absent, false, 'reading an unrecorded day must leave a missing live database absent');

    const seed = await context.newPage();
    await seed.route('**/__seed-retold', route => route.fulfill({ contentType: 'text/html', body: '<title>Recorded-day fixture</title>' }));
    await seed.goto(server.baseUrl + '/__seed-retold');
    await seed.evaluate(async () => {
      const { ChronicleStore, trailSampleId } = await import('/src/infrastructure/ChronicleStore.js');
      const { dayBounds } = await import('/src/application/ChronicleLog.js');
      const { lower } = dayBounds('2026-11-17');
      const store = new ChronicleStore();
      await store.bulkPut('events', [
        { id: 'fixture-arrival', agentId: 'gate', agentName: 'Gate body', provider: 'codex', kind: 'arrived', ts: lower + 1000 },
        { id: 'fixture-ship', agentId: 'repo', provider: 'git', project: 'test', kind: 'commit', sha: 'a123bcdef', ts: lower + 2000 },
        { id: 'fixture-push', agentId: 'repo', provider: 'git', project: 'test', kind: 'push',
          gitKey: 'push:fixture:landed', ts: lower + 4 * 3600_000 },
      ]);
      await store.put('trailSamples', { id: trailSampleId('walker', lower + 3000), agentId: 'walker', provider: 'codex',
        model: 'gpt-6-astra', tileX: 12, tileY: 13, ts: lower + 3000 });
      window.readBook = async () => Promise.all(['events', 'trailSamples', 'meta'].map(name => store.queryRange(name)));
      window.hasSamples = await new (await import('/src/application/ChronicleLog.js')).ChronicleLog({ store }).hasTrailSamples('2026-11-17');
    });
    assert.equal(await seed.evaluate(() => window.hasSamples), true);
    const otherDay = await seed.evaluate(async () => {
      const { loadChronicleScenario } = await import('/src/application/ChronicleScenario.js');
      return loadChronicleScenario('2026-11-16');
    });
    assert.equal(otherDay, null);
    const before = await seed.evaluate(() => window.readBook());
    const requests = [];
    page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/session')) requests.push(req.url()); });
    await page.bringToFront();
    await openWorld(page, 'retold=2026-11-17&renderer=canvas');
    await page.waitForFunction(() => window.__claudeVilleApp.renderer.harborTraffic.state.ships.size > 0, null, { timeout: 20_000 })
      .catch(async error => {
        console.error(await page.evaluate(() => {
          const { world, renderer, agentSimulator } = window.__claudeVilleApp;
          return { ids: [...world.agents.keys()], clock: agentSimulator.replayClock, steps: agentSimulator.getScenario()?.timeline,
            harbor: renderer.harborTraffic.getDiagnostics(), frame: renderer._frameFailureStats, visible: document.visibilityState };
        }));
        throw error;
      });
    const day = await page.evaluate(async () => {
      const { renderer, chronicleStore, villageState, world } = window.__claudeVilleApp;
      const { VILLAGE_GATE } = await import('/src/config/townPlan.js');
      const { sessionDetailsService } = await import('/src/presentation/shared/SessionDetailsService.js');
      await sessionDetailsService.fetchSessionDetailsBatch([...world.agents.values()]);
      await sessionDetailsService.fetchSessionDetail(world.agents.get('walker'));
      const stand = id => {
        const sprite = renderer.agentSprites.get(id);
        return sprite._screenToTile(sprite.x, sprite.y);
      };
      return {
        retold: villageState.retold, db: chronicleStore.dbName, count: world.agents.size,
        date: renderer._lastAtmosphere.clock.localDate, walker: stand('walker'), gate: stand('gate'), expectedGate: VILLAGE_GATE.inside,
      };
    });
    assert.equal(day.retold, true);
    assert.equal(day.db, 'claudeville-chronicle-simulation');
    assert.equal(day.count, 2);
    assert.equal(day.date, '2026-11-17');
    for (const [position, expected] of [[day.walker, { tileX: 12, tileY: 13 }], [day.gate, day.expectedGate]]) {
      assert.ok(Math.abs(position.tileX - expected.tileX) < 0.001 && Math.abs(position.tileY - expected.tileY) < 0.001);
    }
    // Advance to the recorded push without waiting four hours of village time.
    await page.evaluate(() => window.__claudeVilleApp.agentSimulator.advanceReplay(16000, true));
    await page.waitForFunction(() => [...window.__claudeVilleApp.renderer.harborTraffic.state.pushEvents.values()].some(push => push.status === 'success'));
    assert.deepEqual(requests, []);
    assert.deepEqual(await seed.evaluate(() => window.readBook()), before);
    console.log('PASS timelapse and recorded-day URLs, static steps, gate, ship, missing-day state and live history isolation');
  } finally {
    await context.close();
  }
}

try {
  browser = await launchChromium({ args: process.argv.includes('--canvas') ? ['--disable-gpu'] : gpuLaunchArgs() });
  if (process.argv.includes('--build-profile')) {
    await profileBuild();
  } else if (process.argv.includes('--profile')) {
    for (const twilight of ['dawn', 'dusk']) {
      for (const sweep of [false, true]) await twilightProfile(twilight, sweep);
    }
  } else {
    await smoke();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.stop();
}
