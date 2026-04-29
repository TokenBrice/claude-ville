#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifestPath = join(repoRoot, 'claudeville', 'assets', 'sprites', 'manifest.yaml');
const args = process.argv.slice(2);
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
const selectedIds = idsArg
    ? idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean)
    : manifest.entries.map((entry) => entry.id);
const entriesById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
const missing = selectedIds.filter((id) => !entriesById.has(id));

if (missing.length) {
    console.error(`unknown manifest sprite IDs: ${missing.join(', ')}`);
    process.exit(1);
}

console.log(`Sprite plan: ${selectedIds.length} manifest-backed ID(s)`);
console.log(`Style anchor: ${manifest.styleAnchor || '(none)'}`);

for (const id of selectedIds) {
    const entry = entriesById.get(id);
    console.log('');
    console.log(id);
    console.log(`  tool: ${entry.tool || inferTool(id)}`);
    console.log(`  dimensions: ${dimensionsFor(entry)}`);
    for (const path of expectedPaths(entry)) {
        console.log(`  path: claudeville/assets/sprites/${path}`);
    }
    if (entry.prompt) {
        console.log(`  prompt: ${[manifest.styleAnchor, entry.prompt].filter(Boolean).join(', ')}`);
    } else if (entry.lower || entry.upper) {
        if (entry.lower) console.log(`  lower: ${[manifest.styleAnchor, entry.lower].filter(Boolean).join(', ')}`);
        if (entry.upper) console.log(`  upper: ${[manifest.styleAnchor, entry.upper].filter(Boolean).join(', ')}`);
    } else {
        console.log('  prompt: (no prompt in manifest)');
    }
}

function parseManifest(text) {
    const styleAnchor = text.match(/^\s+anchor:\s*"([^"]+)"/m)?.[1] || '';
    const entries = [];
    const lines = text.split(/\r?\n/);
    let current = null;
    let block = null;

    for (const line of lines) {
        const idMatch = line.match(/^  - id:\s*([A-Za-z0-9_.-]+)\s*$/);
        if (idMatch) {
            if (current) entries.push(current);
            current = { id: idMatch[1], layers: [] };
            block = null;
            continue;
        }
        if (!current) continue;
        if (/^    layers:\s*$/.test(line)) {
            block = 'layers';
            continue;
        }
        if (/^    [A-Za-z0-9_-]+:/.test(line)) block = null;
        if (block === 'layers') {
            const layerMatch = line.match(/^      ([A-Za-z0-9_-]+):/);
            if (layerMatch) current.layers.push(layerMatch[1]);
            continue;
        }
        const prop = line.match(/^    ([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!prop) continue;
        current[prop[1]] = parseValue(prop[2]);
    }
    if (current) entries.push(current);
    return { styleAnchor, entries };
}

function parseValue(raw) {
    const value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    const array = value.match(/^\[([^\]]*)\]$/);
    if (array) {
        return array[1].split(',').map((part) => {
            const item = part.trim();
            return /^-?\d+$/.test(item) ? Number(item) : item.replace(/^['"]|['"]$/g, '');
        });
    }
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
}

function expectedPaths(entry) {
    if (entry.assetPath) return [String(entry.assetPath).replace(/^assets\/sprites\//, '')];
    if (entry.composeGrid && entry.layers.includes('base')) {
        const [cols, rows] = entry.composeGrid;
        const paths = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) paths.push(`buildings/${entry.id}/base-${col}-${row}.png`);
        }
        for (const layer of entry.layers.filter((name) => name !== 'base')) paths.push(`buildings/${entry.id}/${layer}.png`);
        return paths;
    }
    const base = pathFor(entry.id);
    const paths = base ? [base] : [];
    for (const layer of entry.layers.filter((name) => name !== 'base')) paths.push(`buildings/${entry.id}/${layer}.png`);
    return paths;
}

function pathFor(id) {
    if (id.startsWith('agent.')) return `characters/${id}/sheet.png`;
    if (id.startsWith('equipment.')) return `equipment/${id}.png`;
    if (id.startsWith('overlay.')) return `overlays/${id}.png`;
    if (id.startsWith('building.')) return `buildings/${id}/base.png`;
    if (id.startsWith('prop.')) return `props/${id}.png`;
    if (id.startsWith('veg.')) return `vegetation/${id}.png`;
    if (id.startsWith('terrain.')) return `terrain/${id}/sheet.png`;
    if (id.startsWith('bridge.') || id.startsWith('dock.')) return `bridges/${id}.png`;
    if (id.startsWith('atmosphere.')) return `atmosphere/${id}.png`;
    return null;
}

function dimensionsFor(entry) {
    if (entry.composeGrid) return `composeGrid ${entry.composeGrid.join('x')}`;
    if (entry.width && entry.height) return `${entry.width}x${entry.height}`;
    if (entry.size && entry.id.startsWith('agent.')) return `${entry.size * (entry.n_directions || 8)}x${entry.size * 10} sheet (${entry.size}px cells)`;
    if (entry.size) return `${entry.size}x${entry.size}`;
    return 'manifest default';
}

function inferTool(id) {
    if (id.startsWith('agent.')) return 'create_character';
    if (id.startsWith('terrain.')) return 'tileset';
    return 'map_object';
}
