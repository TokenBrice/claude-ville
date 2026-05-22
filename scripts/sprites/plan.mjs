#!/usr/bin/env node

import {
    collectSpriteEntries,
    dimensionsForEntry,
    expectedPathsForEntry,
    inferSpriteTool,
    loadSpriteManifest,
    manifestPath,
} from './manifest-utils.mjs';

const args = process.argv.slice(2);
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const manifest = loadSpriteManifest(manifestPath);
const entries = collectSpriteEntries(manifest);
const selectedIds = idsArg
    ? idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean)
    : entries.map((entry) => entry.id);
const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
const missing = selectedIds.filter((id) => !entriesById.has(id));

if (missing.length) {
    console.error(`unknown manifest sprite IDs: ${missing.join(', ')}`);
    process.exit(1);
}

console.log(`Sprite plan: ${selectedIds.length} manifest-backed ID(s)`);
console.log(`Style anchor: ${manifest.style?.anchor || '(none)'}`);

for (const id of selectedIds) {
    const entry = entriesById.get(id);
    console.log('');
    console.log(id);
    console.log(`  tool: ${entry.tool || inferSpriteTool(id)}`);
    console.log(`  dimensions: ${dimensionsForEntry(entry)}`);
    for (const path of expectedPathsForEntry(entry)) {
        console.log(`  path: claudeville/assets/sprites/${path}`);
    }
    if (entry.prompt) {
        console.log(`  prompt: ${[manifest.style?.anchor, entry.prompt].filter(Boolean).join(', ')}`);
    } else if (entry.lower || entry.upper) {
        if (entry.lower) console.log(`  lower: ${[manifest.style?.anchor, entry.lower].filter(Boolean).join(', ')}`);
        if (entry.upper) console.log(`  upper: ${[manifest.style?.anchor, entry.upper].filter(Boolean).join(', ')}`);
    } else {
        console.log('  prompt: (no prompt in manifest)');
    }
}
