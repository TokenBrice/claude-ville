#!/usr/bin/env node

/**
 * Baseline screenshot capture script for pixel-art sprite visual diffs.
 *
 * This script captures the 5 baseline poses used by `scripts/sprites/visual-diff.mjs`.
 *
 * The app exposes window.cameraSet({ x, y, zoom }) in local browser sessions so
 * each pose captures a distinct world viewport.
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

// Camera center positions for the 5 baseline poses (worldX, worldY, zoom).
const POSES = {
  overview: { x: 0, y: 0, zoom: 1 },
  command: { x: 360, y: 240, zoom: 2 },
  harbor: { x: 540, y: 480, zoom: 2 },
  mine: { x: 240, y: 480, zoom: 2 },
  fringe: { x: 80, y: 80, zoom: 1 },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

try {
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  // Allow renderer to mount + assets to load
  await page.waitForTimeout(2000);
  await page.waitForFunction(() => typeof window.cameraSet === 'function', null, { timeout: 5000 });

  for (const [name, pose] of Object.entries(POSES)) {
    const result = await page.evaluate((nextPose) => window.cameraSet(nextPose), pose);
    if (!result) throw new Error(`cameraSet failed for ${name}`);
    await page.waitForTimeout(500);

    const path = join(outDir, `${name}${suffix}.png`);
    // Capture the world canvas area (skip topbar at y=60, capture 720px height)
    await page.screenshot({ path, fullPage: false, clip: { x: 0, y: 60, width: 1280, height: 720 } });
    console.log(`captured ${path}`);
  }

  console.log(`Done - ${Object.keys(POSES).length} poses written to ${outDir}`);
} finally {
  await browser.close();
}
