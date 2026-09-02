#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { startIsolatedServer } from './support/isolated-server.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 8_000;

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeville-render-'));
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
    const page = await context.newPage();
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
      await page.screenshot({ path: path.join(artifactDir, 'world.png') });
    });

    await timedStep('dashboard', async () => {
      await page.locator('#btnModeDashboard').click();
      await page.waitForFunction(() => (
        window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'dashboard'
      ));
      await page.locator('#dashboardMode').waitFor({ state: 'visible' });
      await page.locator('.dash-card__select').first().waitFor({ state: 'visible' });
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
      await page.screenshot({ path: path.join(artifactDir, 'panel.png') });
    });

    await timedStep('deselect', async () => {
      await page.locator('#panelClose').click();
      await page.waitForFunction(() => document.getElementById('activityPanel')?.style.display === 'none');
      await page.waitForFunction(() => !document.body.hasAttribute('data-cv-selected'));
      await page.locator('#worldCanvas').waitFor({ state: 'visible' });
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
