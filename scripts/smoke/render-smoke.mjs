#!/usr/bin/env node

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { startIsolatedServer } from './support/isolated-server.mjs';
import { makeTempDir } from '../tests/support/tmp.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 8_000;

const artifactDir = makeTempDir('claudeville-render-');
const diagnostics = {
  status: 'running',
  baseUrl: null,
  port: null,
  viewport: VIEWPORT,
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  failedRequests: [],
  fpsSample: null,
  modeTimings: {},
  failure: null,
};

function oneLine(error) {
  const message = String(error?.stack || error?.message || error || 'unknown failure')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 2_000) || 'unknown failure';
}

async function timedStep(name, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } catch (error) {
    const browserContext = [
      ...diagnostics.consoleErrors,
      ...diagnostics.consoleWarnings,
      ...diagnostics.pageErrors,
    ].slice(-3).join(' | ');
    throw new Error(
      `${name} failed: ${oneLine(error)}${browserContext ? `; browser: ${browserContext}` : ''}`,
    );
  } finally {
    diagnostics.modeTimings[name] = Math.round(performance.now() - startedAt);
  }
}

// ------------------------------------------------------------ sound (7.1) ----
// The sound control's states at 1280 and 1440 on fresh profiles, in a
// browser that requires a gesture before audio (so `armed` is real):
// off → the first-ever click opens the SOUND panel's presets → Town band
// (playing) → hushed; armed (a stored enable, no click yet); playing with no
// agents (the band on an empty island). Every state: a screenshot, `#topbarSoundToggle`
// at the same box as when off (0 px shift) and `.topbar__center` never
// overflowing at 1440 with three attention buckets showing. At 1280 the
// three buckets already overflow the centre at HEAD (130 px; a maintainer
// finding, no density change in this wave), so there the sound group must
// keep one box in every state and the overflow stay within HEAD's plus the
// 16 px the 44 px group adds over the old 28 px note. Then the keyboard
// walk (7.6): 14 Tabs from `#topbarAlertsToggle` visit ≥ 5 top-bar controls
// without changing the selected agent, the presets are a radiogroup
// "Listen to" of 3 radios, the volume carries `aria-valuetext`, and `M`
// toggles sound in World and Dashboard.
const SOUND_VIEWPORTS = [1280, 1440];
const SOUND_GESTURE_ARGS = ['--autoplay-policy=user-gesture-required'];
// `.topbar__center` overflow at 1280 with three attention buckets at the
// Wave-6 HEAD (29fc9ad), and what the fixed 44 px sound group may add to it.
const CENTER_OVERFLOW_1280_HEAD_PX = 130;
const SOUND_GROUP_GROWTH_PX = 44 - 28;
const shotsArg = process.argv.find(arg => arg.startsWith('--shots='));
const SOUND_SHOTS_DIR = shotsArg ? path.resolve(shotsArg.slice('--shots='.length)) : null;

async function soundPage(browser, baseUrl, width, { scenario = null, storage = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  // Playwright's evaluate carries a synthetic user activation, which would
  // start a stored enable on its own; `navigator.userActivation` reports
  // trusted input only, as for a real visitor (browser-lifecycle.mjs does
  // the same for its armed chip).
  await context.addInitScript(() => {
    let active = false;
    const mark = (event) => { if (event.isTrusted) active = true; };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    Object.defineProperty(Navigator.prototype, 'userActivation', {
      configurable: true,
      get: () => ({ hasBeenActive: active, isActive: active }),
    });
  });
  if (storage) {
    await context.addInitScript((entries) => {
      if (sessionStorage.getItem('render-smoke-seeded')) return;
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      sessionStorage.setItem('render-smoke-seeded', '1');
    }, storage);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(`[sound ${width}] ${message.text()}`);
  });
  page.on('pageerror', error => diagnostics.pageErrors.push(`[sound ${width}] ${oneLine(error)}`));
  await page.goto(`${baseUrl}/?sim=1${scenario ? `&scenario=${scenario}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 12_000 });
  await page.waitForFunction(() => window.__claudeVilleApp?._bootState === 'ready' && Boolean(document.getElementById('topbarSoundToggle')));
  return { context, page };
}

async function soundGeometry(page) {
  return page.evaluate(() => {
    const box = el => (el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null);
    const center = document.querySelector('.topbar__center');
    return {
      state: document.getElementById('topbarSoundToggle')?.getAttribute('data-sound-state') ?? null,
      toggle: box(document.getElementById('topbarSoundToggle')),
      group: box(document.querySelector('.topbar__sound')),
      centerOverflow: center ? center.scrollWidth - center.clientWidth : null,
      counts: document.querySelector('.topbar__badges')?.textContent.trim().replace(/\s+/g, ' ') ?? null,
    };
  });
}

async function waitSoundState(page, state, timeout = STEP_TIMEOUT_MS) {
  await page.waitForFunction(want => document.getElementById('topbarSoundToggle')?.getAttribute('data-sound-state') === want, state, { timeout });
}

async function soundShot(page, name) {
  const file = `sound-${name}.png`;
  await page.screenshot({ path: path.join(artifactDir, file) });
  if (SOUND_SHOTS_DIR) {
    fs.mkdirSync(SOUND_SHOTS_DIR, { recursive: true });
    fs.copyFileSync(path.join(artifactDir, file), path.join(SOUND_SHOTS_DIR, file));
  }
}

// 0 px shift of the toggle, and the centre's overflow: none at 1440; at 1280
// the same as the base state's and within HEAD's + the sound group's growth.
function assertSameBox(base, now, label, width) {
  assert.ok(now.toggle && base.toggle, `${label}: #topbarSoundToggle missing`);
  const shift = Math.max(Math.abs(now.toggle.x - base.toggle.x), Math.abs(now.toggle.y - base.toggle.y), Math.abs(now.toggle.width - base.toggle.width));
  assert.equal(shift, 0, `${label}: #topbarSoundToggle moved ${shift} px (${JSON.stringify(base.toggle)} → ${JSON.stringify(now.toggle)})`);
  assert.ok(now.centerOverflow != null, `${label}: no .topbar__center`);
  if (width > 1280) {
    assert.ok(now.centerOverflow <= 0, `${label}: .topbar__center overflows by ${now.centerOverflow} px`);
  } else {
    // The centre's width also follows the left cluster's live text (the FPS
    // readout's digits move it by a glyph), so sound's share is judged by
    // the sound group itself: the same box in every state.
    const group = ['x', 'width'].map(k => Math.abs((now.group?.[k] ?? NaN) - (base.group?.[k] ?? NaN)));
    assert.ok(group.every(d => d === 0), `${label}: .topbar__sound moved or resized (${JSON.stringify(base.group)} → ${JSON.stringify(now.group)})`);
    assert.ok(now.centerOverflow <= CENTER_OVERFLOW_1280_HEAD_PX + SOUND_GROUP_GROWTH_PX, `${label}: .topbar__center overflows by ${now.centerOverflow} px, over HEAD's ${CENTER_OVERFLOW_1280_HEAD_PX} + ${SOUND_GROUP_GROWTH_PX}`);
  }
  return shift;
}

// Three attention buckets on the top bar: the many-waiting fixture's waits,
// plus one errored and one rate-limited agent.
async function showThreeBuckets(page) {
  await page.evaluate(() => {
    const app = window.__claudeVilleApp;
    const [a, b] = [...app.world.agents.values()];
    app.world.updateAgent(a.id, { status: 'errored' });
    app.world.updateAgent(b.id, { status: 'rate_limited' });
  });
  await page.waitForTimeout(600);
}

async function soundStates(browser, baseUrl, width) {
  const rows = [];
  let offBase = null;
  const record = (name, geometry, shift) => rows.push({ state: name, sound: geometry.state, shiftPx: shift, centerOverflowPx: geometry.centerOverflow, toggle: geometry.toggle, groupWidth: geometry.group?.width ?? null });
  {
    const { context, page } = await soundPage(browser, baseUrl, width, { scenario: 'many-waiting' });
    try {
      await showThreeBuckets(page);
      const base = await soundGeometry(page);
      offBase = base;
      assert.equal(base.state, 'off', `fresh profile: data-sound-state ${base.state}`);
      assert.equal(base.group?.width, 44, `.topbar__sound is ${base.group?.width} px wide, want 44`);
      record('off', base, assertSameBox(base, base, `${width} off`, width));
      await soundShot(page, `off-${width}`);

      await page.locator('#topbarSoundToggle').click();
      await page.locator('#soundPanel').waitFor({ state: 'visible' });
      const open = await soundGeometry(page);
      assert.equal(open.state, 'off', 'the first-ever click opens the presets and picks none');
      record('popover open', open, assertSameBox(base, open, `${width} popover open`, width));
      await soundShot(page, `popover-${width}`);

      await page.locator('#soundPresets [role="radio"][data-preset="townBand"]').click();
      await waitSoundState(page, 'playing');
      const playingOpen = await soundGeometry(page);
      record('playing, popover open', playingOpen, assertSameBox(base, playingOpen, `${width} playing (open)`, width));
      await soundShot(page, `playing-popover-${width}`);
      await page.keyboard.press('Escape');
      await page.locator('#soundPanel').waitFor({ state: 'hidden' });
      const playing = await soundGeometry(page);
      record('playing', playing, assertSameBox(base, playing, `${width} playing`, width));
      await soundShot(page, `playing-${width}`);

      await page.locator('#topbarSoundMenu').click();
      await page.locator('#soundHush').click();
      await waitSoundState(page, 'hushed');
      const hushed = await soundGeometry(page);
      record('hushed', hushed, assertSameBox(base, hushed, `${width} hushed`, width));
      await soundShot(page, `hushed-${width}`);
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
    }
  }
  {
    // A stored enable before any gesture: armed until the first click.
    const { context, page } = await soundPage(browser, baseUrl, width, { scenario: 'many-waiting', storage: { 'claudeville.sound.enabled': 'true', 'claudeville.sound.mode': 'bgm' } });
    try {
      await showThreeBuckets(page);
      await waitSoundState(page, 'armed');
      const armed = await soundGeometry(page);
      record('armed', armed, assertSameBox(offBase, armed, `${width} armed`, width));
      await soundShot(page, `armed-${width}`);
    } finally {
      await context.close();
    }
  }
  {
    // No agents: the Town band plays on an empty island.
    const { context, page } = await soundPage(browser, baseUrl, width, { scenario: 'no-agents' });
    try {
      await page.locator('#topbarSoundToggle').click();
      await page.locator('#soundPresets [role="radio"][data-preset="townBand"]').click();
      await page.keyboard.press('Escape');
      await waitSoundState(page, 'playing');
      const empty = await soundGeometry(page);
      // Another fixture (no agents, so no buckets): the toggle's box only.
      const shift = Math.max(Math.abs(empty.toggle.x - offBase.toggle.x), Math.abs(empty.toggle.y - offBase.toggle.y), Math.abs(empty.toggle.width - offBase.toggle.width));
      record('playing, no agents', empty, shift);
      assert.equal(shift, 0, `${width}: #topbarSoundToggle moved ${shift} px between off and playing with no agents`);
      assert.ok(empty.centerOverflow <= 0, `${width} playing, no agents: .topbar__center overflows by ${empty.centerOverflow} px`);
      await soundShot(page, `playing-no-agents-${width}`);
    } finally {
      await context.close();
    }
  }
  return rows;
}

async function keyboardWalk(browser, baseUrl) {
  const { context, page } = await soundPage(browser, baseUrl, 1440);
  try {
    const selected = () => page.evaluate(() => document.body.getAttribute('data-cv-selected'));
    const before = await selected();
    await page.locator('#topbarAlertsToggle').focus();
    const visited = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => {
        const el = document.activeElement;
        return el?.closest?.('.topbar') ? (el.id || el.getAttribute('aria-label') || el.className) : null;
      }));
    }
    const distinct = [...new Set(visited.filter(Boolean))];
    assert.ok(distinct.length >= 5, `14 Tabs from #topbarAlertsToggle visited ${distinct.length} top-bar controls (${distinct.join(', ')}), want ≥ 5`);
    assert.equal(await selected(), before, 'the keyboard walk changed the selected agent');

    await page.locator('#topbarSoundToggle').click();
    await page.locator('#soundPanel').waitFor({ state: 'visible' });
    const aria = await page.evaluate(() => {
      const group = document.querySelector('#soundPanel [role="radiogroup"]');
      const volume = document.querySelector('#soundVolume');
      return {
        label: group?.getAttribute('aria-label') ?? null,
        radios: group ? group.querySelectorAll('[role="radio"]').length : 0,
        focused: document.activeElement?.getAttribute('role') ?? null,
        dialog: document.getElementById('soundPanel')?.getAttribute('role') ?? null,
        valuetext: volume?.getAttribute('aria-valuetext') ?? null,
      };
    });
    assert.equal(aria.dialog, 'dialog', 'the SOUND panel is a dialog');
    assert.equal(aria.label, 'Listen to', `the presets radiogroup is labelled ${aria.label}`);
    assert.equal(aria.radios, 3, `the presets radiogroup has ${aria.radios} radios`);
    assert.equal(aria.focused, 'radio', 'the panel opens with focus on a preset radio');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    const volumeText = await page.evaluate(() => document.querySelector('#soundVolume')?.getAttribute('aria-valuetext') ?? null);
    assert.match(String(volumeText), /^(\d+ of 10|Off)$/, `the volume's aria-valuetext is ${volumeText}`);
    await page.keyboard.press('Escape');

    const enabled = () => page.evaluate(() => Boolean(window.__claudevilleAudio?.()?.enabled));
    const pressM = async () => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('m');
      await page.waitForTimeout(300);
      return enabled();
    };
    const world = [await enabled(), await pressM(), await pressM()];
    await page.locator('#btnModeDashboard').click();
    await page.waitForFunction(() => window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'dashboard');
    const dashboard = [await enabled(), await pressM(), await pressM()];
    assert.ok(world[1] !== world[0] && world[2] === world[0], `M in World: enabled ${world.join(' → ')}`);
    assert.ok(dashboard[1] !== dashboard[0] && dashboard[2] === dashboard[0], `M in Dashboard: enabled ${dashboard.join(' → ')}`);
    return { visited: distinct, aria: { ...aria, volumeText }, m: { world, dashboard } };
  } finally {
    await context.close();
  }
}

async function run() {
  let server = null;
  let browser = null;
  let failure = null;
  const startedAt = performance.now();

  try {
    server = await startIsolatedServer();
    diagnostics.baseUrl = server.baseUrl;
    diagnostics.port = server.port;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      reducedMotion: 'reduce',
    });
    // A separate tab holds real history while the simulator runs on the same
    // origin. This exercises actual IndexedDB and BroadcastChannel isolation.
    const history = await context.newPage();
    await history.route('**/__render-seed', route => route.fulfill({ contentType: 'text/html', body: '<title>History isolation probe</title>' }));
    await history.goto(`${server.baseUrl}/__render-seed`);
    const liveBefore = await history.evaluate(async () => {
      const { ChronicleStore } = await import('/src/infrastructure/ChronicleStore.js');
      const { SpendLedger } = await import('/src/application/SpendLedger.js');
      const store = new ChronicleStore();
      await store.put('meta', { key: 'founding', value: { identityKey: 'live:founder', ts: 1234 } });
      await store.put('meta', { key: `usageLedger:${new SpendLedger(null).date}`, value: { tokens: 456, cost: 12.34 } });
      await store.put('biographies', { identityKey: 'live:founder', lifetimeTokens: 456 });
      await store.put('affinities', { pairKey: 'live:a|live:b', score: 7 });
      const keys = ['claudeville.chronicle.captureLease', 'claudeville.biography.writeLease', 'claudeville.affinity.writeLease'];
      for (const key of keys) localStorage.setItem(key, JSON.stringify({ token: 'live-observer', expiresAt: Date.now() + 60000 }));
      window.liveMessages = [];
      store.channel.onmessage = event => window.liveMessages.push(event.data);
      window.readLiveHistory = async () => ({
        rows: await Promise.all(['meta', 'biographies', 'affinities'].map(name => new Promise((resolve, reject) => {
          const request = store.db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }))),
        leases: keys.map(key => localStorage.getItem(key)),
      });
      return window.readLiveHistory();
    });
    const page = await context.newPage();
    const usageRequests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/usage') usageRequests.push(request.url());
    });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
      if (message.type() === 'warning') diagnostics.consoleWarnings.push(message.text());
    });
    page.on('pageerror', (error) => {
      diagnostics.pageErrors.push(oneLine(error));
    });
    page.on('requestfailed', (request) => {
      diagnostics.failedRequests.push({
        method: request.method(),
        url: request.url(),
        error: request.failure()?.errorText || 'unknown request failure',
      });
    });

    async function assertFpsCounter(idle = false) {
      await page.locator('#statFps').waitFor({ state: 'visible' });
      await page.waitForFunction(expectedIdle => {
        const text = document.getElementById('statFps')?.textContent;
        return expectedIdle ? text === 'FPS idle' : /^\d+ FPS$/.test(text);
      }, idle);
      assert.equal(await page.locator('#statQuotaWrap').count(), 0);
    }

    await timedStep('world', async () => {
      await page.goto(`${server.baseUrl}/?sim=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 12_000,
      });
      await page.waitForFunction(() => (
        window.__claudeVilleApp?._bootState === 'ready'
        && window.__claudeVilleApp?.world?.agents?.size > 0
      ));
      await page.locator('#worldCanvas').waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        const { eventBus } = await import('/src/domain/events/DomainEvent.js');
        window.__claudeVilleRenderSmokeFps = null;
        eventBus.on('fps:updated', (fps) => {
          if (Number.isFinite(fps)) window.__claudeVilleRenderSmokeFps = fps;
        });
      });
      await page.waitForFunction(() => Number.isFinite(window.__claudeVilleRenderSmokeFps));
      diagnostics.fpsSample = await page.evaluate(() => window.__claudeVilleRenderSmokeFps);
      await assertFpsCounter();
      assert.equal(await page.evaluate(() => document.getElementById('statFps').textContent === `${window.__claudeVilleRenderSmokeFps} FPS`), true);
      await page.screenshot({ path: path.join(artifactDir, 'world.png') });
    });

    await timedStep('dashboard', async () => {
      await page.locator('#btnModeDashboard').click();
      await page.waitForFunction(() => (
        window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'dashboard'
      ));
      await page.locator('#dashboardMode').waitFor({ state: 'visible' });
      await page.locator('.dash-card__select').first().waitFor({ state: 'visible' });
      await assertFpsCounter(true);
      await page.screenshot({ path: path.join(artifactDir, 'dashboard.png') });
    });

    // Product contract: selecting a card in Dashboard mode records the selection
    // (aria-pressed) but the Activity Panel only opens once World mode is active
    // again (ActivityPanel._onAgentSelected defers while _viewMode === 'dashboard').
    await timedStep('select', async () => {
      const firstAgent = page.locator('.dash-card__select').first();
      await firstAgent.click();
      await page.waitForFunction(() => (
        document.querySelector('.dash-card__select[aria-pressed="true"]') !== null
      ));
    });

    await timedStep('panel', async () => {
      await page.locator('#btnModeCharacter').click();
      await page.waitForFunction(() => (
        window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'character'
      ));
      await page.locator('#worldCanvas').waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const panel = document.getElementById('activityPanel');
        return !!panel && panel.style.display !== 'none' && panel.getBoundingClientRect().width > 0;
      });
      await assertFpsCounter();
      await page.screenshot({ path: path.join(artifactDir, 'panel.png') });
    });

    await timedStep('deselect', async () => {
      await page.locator('#panelClose').click();
      await page.waitForFunction(() => document.getElementById('activityPanel')?.style.display === 'none');
      await page.waitForFunction(() => !document.body.hasAttribute('data-cv-selected'));
      await page.locator('#worldCanvas').waitFor({ state: 'visible' });
    });

    await timedStep('simulation-isolation', async () => {
      await page.evaluate(async () => {
        const { AgentBiography } = await import('/src/domain/value-objects/AgentBiography.js');
        const app = window.__claudeVilleApp;
        const store = app.chronicleStore;
        if (!app.simMode || store.dbName === 'claudeville-chronicle' || app.latestUsage != null) {
          throw new Error('Simulator acquired live storage or usage');
        }
        // Drive the actual observers with nonzero counters, then inspect their
        // persisted output while another tab holds live history and leases.
        const agent = app.world.agents.values().next().value;
        const ledger = app.spendLedger;
        ledger.sample();
        const before = { ...ledger.today };
        app.world.updateAgent(agent.id, {
          tokens: { ...agent.tokens, input: agent.tokens.input + 1234, totalInput: agent.tokens.totalInput + 1234 },
          cost: { ...agent.cost, usd: (Number(agent.cost) || 0) + 2.5 },
        });
        await ledger.flush();
        const saved = await store.getMeta(`usageLedger:${ledger.date}`);
        if (!(saved?.tokens >= before.tokens + 1234 && saved?.cost >= before.cost + 2.5)) {
          throw new Error('Simulator did not persist nonzero observed spend');
        }
        await app.biographyService._foundingPromise;
        await app.biographyService._drainMutations();
        await app.biographyService.flush();
        const founding = await store.getFounding();
        const biography = await store.getBiography(AgentBiography.identityKeyFor(agent));
        if (!founding || founding.identityKey === 'live:founder' || !(biography?.lifetimeTokens >= 1234)) {
          throw new Error('Simulator did not persist its own founding and token biography');
        }
        await store.putAffinities([{ pairKey: 'sim:a|sim:b', score: 999 }]);
      });
      assert.deepEqual(await history.evaluate(() => window.readLiveHistory()), liveBefore);
      assert.deepEqual(await history.evaluate(() => window.liveMessages), []);
      assert.deepEqual(usageRequests, []);
      diagnostics.simulationIsolation = 'live history, leases, broadcast and usage preserved';
    });

    await timedStep('sound-states', async () => {
      const soundBrowser = await chromium.launch({ headless: true, args: SOUND_GESTURE_ARGS });
      try {
        diagnostics.soundStates = {};
        for (const width of SOUND_VIEWPORTS) diagnostics.soundStates[width] = await soundStates(soundBrowser, server.baseUrl, width);
        diagnostics.keyboardWalk = await keyboardWalk(soundBrowser, server.baseUrl);
      } finally {
        await soundBrowser.close();
      }
    });

    const browserFailures = [
      ...diagnostics.consoleErrors.map(message => `console error: ${message}`),
      ...diagnostics.pageErrors.map(message => `page error: ${message}`),
      ...diagnostics.failedRequests.map(request => (
        `failed request: ${request.method} ${request.url} (${request.error})`
      )),
    ];
    if (browserFailures.length) {
      throw new Error(browserFailures.join(' | '));
    }
    diagnostics.status = 'ok';
  } catch (error) {
    failure = error;
    diagnostics.status = 'failed';
    diagnostics.failure = oneLine(error);
  } finally {
    diagnostics.durationMs = Math.round(performance.now() - startedAt);
    try {
      await browser?.close();
    } catch (error) {
      failure ||= error;
      diagnostics.status = 'failed';
      diagnostics.failure ||= `Browser cleanup failed: ${oneLine(error)}`;
    }
    try {
      await server?.stop();
    } catch (error) {
      failure ||= error;
      diagnostics.status = 'failed';
      diagnostics.failure ||= `Server cleanup failed: ${oneLine(error)}`;
    }
    fs.writeFileSync(
      path.join(artifactDir, 'diagnostics.json'),
      `${JSON.stringify(diagnostics, null, 2)}\n`,
    );
  }

  console.log(`render smoke artifacts: ${artifactDir}`);
  if (failure) {
    console.error(`render smoke failed: ${diagnostics.failure || oneLine(failure)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`render smoke passed in ${diagnostics.durationMs}ms`);
}

run().catch((error) => {
  diagnostics.status = 'failed';
  diagnostics.failure = oneLine(error);
  fs.writeFileSync(
    path.join(artifactDir, 'diagnostics.json'),
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );
  console.log(`render smoke artifacts: ${artifactDir}`);
  console.error(`render smoke failed: ${diagnostics.failure}`);
  process.exitCode = 1;
});
