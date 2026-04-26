#!/usr/bin/env node
// Validates that every PNG path implied by manifest.yaml exists, and that no
// orphan PNGs sit in assets/sprites/ outside _placeholder/.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
const manifestPath = join(spritesRoot, 'manifest.yaml');

const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));

const expected = new Set();

function pathFor(entry) {
    if (entry.id.startsWith('agent.')) return `characters/${entry.id}/sheet.png`;
    if (entry.id.startsWith('overlay.')) return `overlays/${entry.id}.png`;
    if (entry.id.startsWith('building.')) return `buildings/${entry.id}/base.png`;
    if (entry.id.startsWith('prop.')) return `props/${entry.id}.png`;
    if (entry.id.startsWith('veg.')) return `vegetation/${entry.id}.png`;
    if (entry.id.startsWith('terrain.')) return `terrain/${entry.id}/sheet.png`;
    if (entry.id.startsWith('bridge.') || entry.id.startsWith('dock.')) return `bridges/${entry.id}.png`;
    if (entry.id.startsWith('atmosphere.')) return `atmosphere/${entry.id}.png`;
    return null;
}

function collect(group) {
    if (!group) return;
    for (const e of group) {
        if (e.composeGrid && e.layers?.base) {
            const [cols, rows] = e.composeGrid;
            for (let r = 0; r < rows; r++)
                for (let c = 0; c < cols; c++)
                    expected.add(`buildings/${e.id}/base-${c}-${r}.png`);
            if (e.layers) {
                for (const name of Object.keys(e.layers)) {
                    if (name === 'base') continue;
                    expected.add(`buildings/${e.id}/${name}.png`);
                }
            }
            continue;
        }
        const p = pathFor(e);
        if (p) expected.add(p);
        if (e.layers) {
            for (const name of Object.keys(e.layers)) {
                if (name === 'base') continue;
                expected.add(`buildings/${e.id}/${name}.png`);
            }
        }
    }
}

['characters', 'accessories', 'statusOverlays', 'buildings', 'props',
 'vegetation', 'terrain', 'bridges', 'atmosphere'].forEach(k => collect(manifest[k]));

let missing = 0;
for (const rel of expected) {
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) {
        console.error(`MISSING: ${rel}`);
        missing++;
    }
}

const found = new Set();
function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === '_placeholder') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.png')) found.add(relative(spritesRoot, p));
    }
}
walk(spritesRoot);

let orphans = 0;
for (const f of found) {
    if (!expected.has(f)) {
        console.warn(`ORPHAN: ${f}`);
        orphans++;
    }
}

console.log(`expected: ${expected.size}  missing: ${missing}  orphan PNGs: ${orphans}`);
process.exit(missing > 0 ? 1 : 0);
