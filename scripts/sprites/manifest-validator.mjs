#!/usr/bin/env node
// Validates that every PNG path implied by manifest.yaml exists, and that no
// orphan PNGs sit in assets/sprites/ outside _placeholder/.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { PNG } from 'pngjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
const manifestPath = join(spritesRoot, 'manifest.yaml');

const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));

const expected = new Set();
const characterEntries = [];
const CHARACTER_DIRECTIONS = 8;
const CHARACTER_WALK_FRAMES = 6;
const CHARACTER_IDLE_FRAMES = 4;
const CHARACTER_CELL = 92;
const ALPHA_THRESHOLD = 16;
const MIN_NORMALIZED_WALK_DELTA = 32;

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
        if (e.id?.startsWith('agent.')) characterEntries.push(e);
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

let invalidCharacters = 0;
for (const entry of characterEntries) {
    invalidCharacters += validateCharacterSheet(entry);
}

console.log(`expected: ${expected.size}  missing: ${missing}  orphan PNGs: ${orphans}  invalid character sheets: ${invalidCharacters}`);
process.exit(missing > 0 || invalidCharacters > 0 ? 1 : 0);

function validateCharacterSheet(entry) {
    const rel = pathFor(entry);
    if (!rel) return 0;
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return 0;

    const cell = Number(entry.size) || CHARACTER_CELL;
    const expectedWidth = CHARACTER_DIRECTIONS * cell;
    const expectedHeight = (CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES) * cell;
    let png;
    try {
        png = PNG.sync.read(readFileSync(abs));
    } catch (err) {
        console.error(`INVALID CHARACTER: ${rel} cannot be decoded (${err.message})`);
        return 1;
    }

    let errors = 0;
    if (png.width !== expectedWidth || png.height !== expectedHeight) {
        console.error(`INVALID CHARACTER: ${rel} is ${png.width}x${png.height}, expected ${expectedWidth}x${expectedHeight}`);
        errors++;
    }

    if (cell !== CHARACTER_CELL) {
        console.error(`INVALID CHARACTER: ${entry.id} uses ${cell}px cells, expected canonical ${CHARACTER_CELL}px cells`);
        errors++;
    }

    if (!hasRealWalkMotion(png, cell)) {
        console.error(`INVALID CHARACTER: ${rel} walk frames look like a bobbed duplicate pose; regenerate real gait frames`);
        errors++;
    }
    return errors;
}

function hasRealWalkMotion(png, cell) {
    if (png.width < CHARACTER_DIRECTIONS * cell || png.height < CHARACTER_WALK_FRAMES * cell) return false;

    let strongestDelta = 0;
    for (let direction = 0; direction < CHARACTER_DIRECTIONS; direction++) {
        const baseline = normalizedLowerBodyMask(png, direction, 0, cell);
        if (!baseline) continue;
        for (let frame = 1; frame < CHARACTER_WALK_FRAMES; frame++) {
            const candidate = normalizedLowerBodyMask(png, direction, frame, cell);
            if (!candidate) continue;
            strongestDelta = Math.max(strongestDelta, symmetricDeltaSize(baseline, candidate));
            if (strongestDelta >= MIN_NORMALIZED_WALK_DELTA) return true;
        }
    }
    return false;
}

function normalizedLowerBodyMask(png, direction, frame, cell) {
    const x0 = direction * cell;
    const y0 = frame * cell;
    const bbox = alphaBounds(png, x0, y0, cell);
    if (!bbox) return null;

    const lowerStart = bbox.minY + Math.floor((bbox.maxY - bbox.minY) * 0.56);
    const points = new Set();
    for (let y = lowerStart; y <= bbox.maxY; y++) {
        for (let x = bbox.minX; x <= bbox.maxX; x++) {
            if (alphaAt(png, x0 + x, y0 + y) <= ALPHA_THRESHOLD) continue;
            points.add(`${x - bbox.minX},${y - bbox.minY}`);
        }
    }
    return points;
}

function alphaBounds(png, x0, y0, cell) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
            if (alphaAt(png, x0 + x, y0 + y) <= ALPHA_THRESHOLD) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }

    if (maxX < 0 || maxY < 0) return null;
    return { minX, minY, maxX, maxY };
}

function alphaAt(png, x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
    return png.data[(png.width * y + x) * 4 + 3];
}

function symmetricDeltaSize(a, b) {
    let delta = 0;
    for (const point of a) {
        if (!b.has(point)) delta++;
    }
    for (const point of b) {
        if (!a.has(point)) delta++;
    }
    return delta;
}
