#!/usr/bin/env node
// MB-4 (D4) — the Portal slumbers until someone travels. Its vortex is painted
// into base.png, so rest needs an authored mask, like the Forge's and the
// Tavern's banked hearths: `slumber.png` (the base's size and origin) restates
// exactly the vortex texels (the `portalGlow` overlay's opaque texels) two
// courses down the vortex's own luma ramp, chroma held. The ramp is the
// vortex's authored colours in Rec. 709 luma order (EmitterCycle's order);
// each texel takes the colour two steps darker on it, the darkest steps
// holding the darkest colour. So it stays the Portal's violet (not the
// hearths' charcoal), the white eye sleeps to a mid violet, and every texel
// is an authored colour. BuildingSprite lays it as a part while the Portal has
// no working visitor (`work.portal`); its night ember is `rest.ember` in
// BuildingVisualRegistry (the slumbering eye's two courses).
//
// Usage:
//   node scripts/sprites/bake-portal-slumber.mjs [--dry-run]
//   node scripts/sprites/bake-portal-slumber.mjs --check

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

const COURSES_DOWN = 2;
const ID = 'building.portal';
const dir = join(spritesRoot, 'buildings', ID);
const args = process.argv.slice(2);
const check = args.includes('--check');
const dryRun = args.includes('--dry-run');

const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const keyOf = (data, i) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
const rgbOf = (k) => [k >> 16, (k >> 8) & 255, k & 255];
const hexOf = (k) => `#${k.toString(16).padStart(6, '0')}`;

const entry = loadSpriteManifest().buildings.find((item) => item.id === ID);
const glowLayer = entry.layers.portalGlow;
const base = PNG.sync.read(readFileSync(join(dir, 'base.png')));
const glow = PNG.sync.read(readFileSync(join(dir, 'portalGlow.png')));
const left = Math.round(glowLayer.anchor[0] - glow.width / 2);
const top = Math.round(glowLayer.anchor[1] - glow.height);

// The vortex: base texels under the overlay's opaque texels.
const vortex = [];
const used = new Set();
for (let y = 0; y < glow.height; y++) {
    for (let x = 0; x < glow.width; x++) {
        if (!glow.data[(y * glow.width + x) * 4 + 3]) continue;
        const i = ((top + y) * base.width + left + x) * 4;
        if (base.data[i + 3] < 255) throw new Error(`${x + left},${y + top}: the overlay lies off the base`);
        vortex.push(i);
        used.add(keyOf(base.data, i));
    }
}
const ramp = [...used].sort((a, b) => luma(rgbOf(a)) - luma(rgbOf(b)) || a - b);
const down = new Map(ramp.map((k, step) => [k, ramp[Math.max(0, step - COURSES_DOWN)]]));

const out = new PNG({ width: base.width, height: base.height });
for (const i of vortex) {
    out.data.set(rgbOf(down.get(keyOf(base.data, i))), i);
    out.data[i + 3] = 255;
}

const path = join(dir, 'slumber.png');
console.log(`[bake-portal-slumber] ${vortex.length} vortex texels, ramp ${ramp.map(hexOf).join(' ')}`);
console.log(`[bake-portal-slumber] ${ramp.map((k) => `${hexOf(k)}→${hexOf(down.get(k))}`).join(' ')}`);
if (check) {
    const disk = PNG.sync.read(readFileSync(path));
    const same = disk.width === out.width && disk.height === out.height && Buffer.compare(disk.data, out.data) === 0;
    console[same ? 'log' : 'error'](`[bake-portal-slumber] slumber.png ${same ? 'matches' : 'differs from'} its derivation`);
    process.exit(same ? 0 : 1);
}
if (!dryRun) writeFileSync(path, PNG.sync.write(out));
