#!/usr/bin/env node

/**
 * Baseline screenshot capture script for pixel-art sprite visual diffs.
 *
 * This script captures the 5 baseline poses used by `scripts/sprites/visual-diff.mjs`.
 *
 * LIMITATION: Camera positioning is not yet wired from headless playwright.
 * Currently all 5 poses capture the same viewport (overview). To drive the camera
 * to specific world coordinates (command center, harbor, mine, fringe), the
 * IsometricRenderer and Camera must expose a window.cameraSet({x, y, zoom}) hook
 * in App.js. For now, poses are captured with consistent positioning for diff comparison.
 *
 * Usage:
 *   npm run sprites:capture-baseline      # Capture baselines to scripts/sprites/baselines/{pose}.png
 *   npm run sprites:capture-fresh         # Capture fresh versions to scripts/sprites/baselines/{pose}-fresh.png
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(repoRoot, 'scripts', 'sprites', 'baselines');
mkdirSync(outDir, { recursive: true });

const fresh = process.argv.includes('--fresh');
const suffix = fresh ? '-fresh' : '';

// Camera positions for the 5 baseline poses (worldX, worldY, zoom).
// These are world-space pixel coords matching the isometric projection.
const POSES = {
  overview: { camX: 0, camY: 0, zoom: 1 },
  command: { camX: 360, camY: 240, zoom: 2 },      // near command center tile (18,18)
  harbor: { camX: 540, camY: 480, zoom: 2 },       // near lighthouse tile (34,10) + harbor docks
  mine: { camX: 240, camY: 480, zoom: 2 },         // near mine tile (12,24)
  fringe: { camX: 80, camY: 80, zoom: 1 },         // tree fringe near tile (4,4)
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

try {
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  // Allow renderer to mount + assets to load
  await page.waitForTimeout(2000);

  for (const [name, pose] of Object.entries(POSES)) {
    // TODO: Once window.cameraSet({x, y, zoom}) is exposed in App.js,
    // drive the camera here:
    // await page.evaluate((pose) => window.cameraSet(pose), pose);
    // await page.waitForTimeout(500);

    const path = join(outDir, `${name}${suffix}.png`);
    // Capture the world canvas area (skip topbar at y=60, capture 720px height)
    await page.screenshot({ path, fullPage: false, clip: { x: 0, y: 60, width: 1280, height: 720 } });
    console.log(`captured ${path}`);
  }

  console.log(`Done — ${Object.keys(POSES).length} poses written to ${outDir}`);
} finally {
  await browser.close();
}
