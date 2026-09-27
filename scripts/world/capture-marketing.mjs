#!/usr/bin/env node
// README marketing screenshots from the `readme-showcase` sim scenario:
// world day/night, dashboard, activity panel, SOUND popover with the Town band
// playing, and the 1280x640 social card. Needs the server on :4000.
// Output: docs/assets/github/*.png with --write, else output/playwright/marketing-*.png.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const write = process.argv.includes('--write');
const outDir = write ? join(repoRoot, 'docs', 'assets', 'github') : join(repoRoot, 'output', 'playwright');
const prefix = write ? '' : 'marketing-';
const url = 'http://localhost:4000/?sim=1&scenario=readme-showcase';
mkdirSync(outDir, { recursive: true });

// Projection.js: tileToWorld with 64x32 tiles. Zoom snaps to the 1/2/3 pixel grid.
const TILE_HALF_WIDTH = 32;
const TILE_HALF_HEIGHT = 16;
const HERO = { tileX: 16, tileY: 21, zoom: 1 };
const DAY_HOUR = 10.5;
const NIGHT_HOUR = 22;

// Sim agents have no transcript on the server; give the selected agent's
// panel the tool history, messages and usage a real Codex session reports.
function astraDetail() {
    const now = Date.now();
    const at = (secondsAgo) => now - secondsAgo * 1000;
    return {
        toolHistory: [
            { tool: 'exec_command', detail: 'rg -n "manifest" src/harbor', ts: at(210) },
            { tool: 'Read', detail: 'src/harbor/ManifestRenderer.js', ts: at(180) },
            { tool: 'update_plan', detail: 'Split ledger rows by branch', ts: at(140) },
            { tool: 'apply_patch', detail: 'src/harbor/LedgerRows.js', ts: at(95) },
            { tool: 'exec_command', detail: 'npm run test -- ledger', ts: at(60) },
            { tool: 'apply_patch', detail: 'src/harbor/ManifestRenderer.js', ts: at(12) },
        ],
        messages: [
            { role: 'assistant', text: 'Ledger rows now split per branch; 14 tests pass. Moving the manifest renderer onto the new rows next.', ts: at(58) },
        ],
        tokenUsage: {
            input: 356000,
            output: 28400,
            cacheRead: 1410000,
            contextWindow: 142000,
            contextWindowMax: 258400,
            turnCount: 37,
        },
    };
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
// Auto-camera off so framing sticks; first-run hint already seen.
await ctx.addInitScript(() => {
    localStorage.setItem('cv-auto-camera', '0');
    localStorage.setItem('claudeville.firstRunHint.worldControls.v1', '1');
});
await ctx.route('**/api/session-detail?*', (route) => {
    const sessionId = new URL(route.request().url()).searchParams.get('sessionId');
    if (sessionId !== 'readme-astra') return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(astraDetail()) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const path = (name) => join(outDir, `${prefix}${name}.png`);
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((toast) => toast.remove()));
async function shot(name) {
    await clearToasts();
    await page.screenshot({ path: path(name) });
    console.log(`${prefix}${name}.png`);
}
async function sky(hour) {
    await page.evaluate((h) => {
        const a = window.__claudeVilleAtmosphere;
        a.setTimelineMode('fixed');
        a.setHour(h);
        a.setWeather({ type: 'clear', intensity: 0, windX: 0.2, seed: 4242 });
        a.freeze();
    }, hour);
}
async function frame({ tileX, tileY, zoom }, settle = 1200) {
    const x = (tileX - tileY) * TILE_HALF_WIDTH;
    const y = (tileX + tileY) * TILE_HALF_HEIGHT;
    await page.evaluate(([a, b, z]) => window.cameraSet({ x: a, y: b, zoom: z }), [x, y, zoom]);
    await page.waitForTimeout(settle);
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.cameraSet && window.__claudeVilleAtmosphere);
// Let the crowd walk to its buildings.
await page.waitForTimeout(12000);

// Hero: the whole core (Archive, Command, bridge, Forge, Observatory) at 1x.
await sky(DAY_HOUR);
await frame(HERO);
await shot('world-day');

// Social card source: the world canvas only, no chrome, same framing.
await clearToasts();
const cardSource = (await page.screenshot({ clip: { x: 280, y: 180, width: 1280, height: 640 } })).toString('base64');

await page.click('#btnModeDashboard');
await page.waitForTimeout(2500);
await shot('dashboard');

await page.click('#btnModeCharacter');
await page.waitForTimeout(2000);
const astra = page.locator('.sidebar__agent-select[data-agent-id="readme-astra"]');
await astra.scrollIntoViewIfNeeded();
await astra.click();
await page.waitForTimeout(3000);
await shot('activity-panel');
await page.click('#panelClose');
await page.waitForTimeout(800);

// First click on the fresh sound chip opens the SOUND popover; choose Town band.
await frame(HERO);
await page.click('#topbarSoundToggle');
await page.waitForSelector('#soundPanel:not([hidden])');
await page.click('#soundPanel [data-preset="townBand"]');
await page.waitForFunction(() => /Now/.test(document.getElementById('soundNow')?.textContent || ''), null, { timeout: 15000 });
await page.waitForTimeout(4000);
await shot('sound-popover');
await page.keyboard.press('Escape');
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(500);

await sky(NIGHT_HOUR);
await frame(HERO, 1800);
await shot('world-night');

const card = await (await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })).newPage();
await card.setContent(`<!doctype html><html><body style="margin:0;position:relative;width:1280px;height:640px;overflow:hidden;background:#0b0f14">
  <img src="data:image/png;base64,${cardSource}" style="position:absolute;inset:0;width:1280px;height:640px"/>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(8,6,10,0) 45%, rgba(8,6,10,0.6) 70%, rgba(8,6,10,0.92) 100%)"></div>
  <div style="position:absolute;left:56px;bottom:48px;font-family:Georgia,'Times New Roman',serif">
    <div style="font-size:72px;font-weight:700;color:#f5c86e;letter-spacing:1px;line-height:1;text-shadow:0 2px 12px rgba(0,0,0,.6)">ClaudeVille</div>
    <div style="font-size:28px;color:#f2ead9;margin-top:12px;text-shadow:0 1px 6px rgba(0,0,0,.6)">Watch your local AI coding CLIs work in a living pixel village</div>
  </div>
</body></html>`);
await card.waitForTimeout(400);
await card.screenshot({ path: path('claudeville-og-card') });
console.log(`${prefix}claudeville-og-card.png`);

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
