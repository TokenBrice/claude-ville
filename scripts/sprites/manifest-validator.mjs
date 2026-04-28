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
const manifestEntries = [];
const CHARACTER_DIRECTIONS = 8;
const CHARACTER_DIRECTION_KEYS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const CHARACTER_WALK_FRAMES = 6;
const CHARACTER_IDLE_FRAMES = 4;
const CHARACTER_ROWS = CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES;
const CHARACTER_CELL = 92;
const ALPHA_THRESHOLD = 16;
const MIN_NORMALIZED_WALK_DELTA = 32;
const REQUIRED_EQUIPMENT_MIN_PIXELS = Object.freeze({
    dagger: 8,
    multitool: 10,
    sword: 12,
    greatsword: 18,
    wrench: 18,
    polearm: 16,
    shield: 24,
    swordShield: 32,
});
const CHARACTER_GENERATION_MODES = new Set(['standard', 'pro']);
const REQUIRED_PRO_CHARACTER_IDS = new Set([
    'agent.codex.gpt53spark',
    'agent.codex.gpt54',
    'agent.codex.gpt55',
]);

function pathFor(entry) {
    if (entry.assetPath) return String(entry.assetPath).replace(/^assets\/sprites\//, '');
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
        manifestEntries.push(e);
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

let invalidManifest = 0;
for (const entry of manifestEntries) {
    invalidManifest += validateManifestEntry(entry);
}

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

let invalidAtmosphere = 0;
for (const entry of manifest.atmosphere || []) {
    invalidAtmosphere += validateAtmospherePng(entry);
}

console.log(`expected: ${expected.size}  missing: ${missing}  orphan PNGs: ${orphans}  invalid manifest entries: ${invalidManifest}  invalid character sheets: ${invalidCharacters}  invalid atmosphere PNGs: ${invalidAtmosphere}`);
process.exit(missing > 0 || invalidManifest > 0 || invalidCharacters > 0 || invalidAtmosphere > 0 ? 1 : 0);

function validateManifestEntry(entry) {
    if (!entry?.id) return 0;

    let errors = 0;
    if (entry.id.startsWith('agent.') && entry.mode !== undefined) {
        const mode = String(entry.mode);
        if (!CHARACTER_GENERATION_MODES.has(mode)) {
            console.error(`INVALID MANIFEST: ${entry.id} has unsupported mode "${entry.mode}"`);
            errors++;
        }
    }

    if (REQUIRED_PRO_CHARACTER_IDS.has(entry.id) && entry.mode !== 'pro') {
        console.error(`INVALID MANIFEST: ${entry.id} must set mode: pro for Codex equipment coherence bakes`);
        errors++;
    }

    return errors;
}

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
    errors += validateRequiredEquipment(entry, png, cell, rel);
    return errors;
}

function validateAtmospherePng(entry) {
    const rel = pathFor(entry);
    if (!rel) return 0;
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return 0;

    const expected = expectedAtmosphereDimensions(entry);
    if (!expected) return 0;

    let png;
    try {
        png = PNG.sync.read(readFileSync(abs));
    } catch (err) {
        console.error(`INVALID ATMOSPHERE: ${rel} cannot be decoded (${err.message})`);
        return 1;
    }

    if (png.width === expected.width && png.height === expected.height) return 0;
    console.error(`INVALID ATMOSPHERE: ${rel} is ${png.width}x${png.height}, expected ${expected.width}x${expected.height}`);
    return 1;
}

function expectedAtmosphereDimensions(entry) {
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
        return { width, height };
    }

    const size = Number(entry.size);
    if (!Number.isFinite(size)) return null;
    if (entry.tool === 'tileset') {
        return { width: size * 2, height: size * 2 };
    }
    return { width: size, height: size };
}

function validateRequiredEquipment(entry, png, cell, rel) {
    const required = requiredEquipmentList(entry);
    if (!required.length) return 0;

    let errors = 0;
    for (const equipment of required) {
        const minPixels = equipment.minPixels ?? REQUIRED_EQUIPMENT_MIN_PIXELS[equipment.kind];
        if (!Number.isFinite(minPixels)) {
            console.error(`INVALID CHARACTER: ${entry.id} has unsupported required_equipment "${equipment.kind}"`);
            errors++;
            continue;
        }

        const missing = [];
        for (let row = 0; row < CHARACTER_ROWS; row++) {
            for (let direction = 0; direction < CHARACTER_DIRECTIONS; direction++) {
                const count = equipmentPixelCount(png, direction, row, cell, equipment.kind);
                if (count < minPixels) missing.push(`${animationRowLabel(row)}:${CHARACTER_DIRECTION_KEYS[direction]}`);
            }
        }
        if (missing.length) {
            const sample = missing.slice(0, 16).join(', ');
            const suffix = missing.length > 16 ? `, ... +${missing.length - 16} more` : '';
            console.error(`INVALID CHARACTER: ${rel} required_equipment "${equipment.kind}" is missing or too faint in ${sample}${suffix}`);
            errors++;
        }
    }
    return errors;
}

function requiredEquipmentList(entry) {
    const raw = entry.required_equipment ?? entry.requiredEquipment;
    if (!raw) return [];

    const values = Array.isArray(raw) ? raw : [raw];
    const result = [];
    for (const value of values) {
        if (typeof value === 'string') {
            result.push({ kind: normalizeEquipmentKind(value) });
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        const kind = normalizeEquipmentKind(value.kind || value.type || value.name);
        if (!kind) continue;
        const minPixels = Number(value.min_pixels ?? value.minPixels);
        result.push({
            kind,
            minPixels: Number.isFinite(minPixels) && minPixels > 0 ? minPixels : undefined,
        });
    }
    return result;
}

function normalizeEquipmentKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase().replace(/[-_\s]+/g, '');
    const aliases = {
        dagger: 'dagger',
        multitool: 'multitool',
        sword: 'sword',
        greatsword: 'greatsword',
        wrench: 'wrench',
        polearm: 'polearm',
        shield: 'shield',
        swordshield: 'swordShield',
    };
    return aliases[normalized] || normalized;
}

function equipmentPixelCount(png, direction, row, cell, kind) {
    const x0 = direction * cell;
    const y0 = row * cell;
    const bbox = alphaBounds(png, x0, y0, cell);
    if (!bbox) return 0;

    const contentWidth = bbox.maxX - bbox.minX + 1;
    const contentHeight = bbox.maxY - bbox.minY + 1;
    const centerX = (bbox.minX + bbox.maxX) / 2;
    const coreHalfWidth = Math.max(10, contentWidth * 0.23);
    const coreTop = bbox.minY + contentHeight * 0.18;
    const coreBottom = bbox.minY + contentHeight * 0.88;

    let count = 0;
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
        for (let x = bbox.minX; x <= bbox.maxX; x++) {
            const absoluteX = x0 + x;
            const absoluteY = y0 + y;
            const p = (png.width * absoluteY + absoluteX) * 4;
            const a = png.data[p + 3];
            if (a <= ALPHA_THRESHOLD) continue;

            const inBodyCore = Math.abs(x - centerX) <= coreHalfWidth && y >= coreTop && y <= coreBottom;
            if (inBodyCore && kind !== 'shield' && kind !== 'swordShield') continue;

            const r = png.data[p];
            const g = png.data[p + 1];
            const b = png.data[p + 2];
            if (isEquipmentPixel(kind, r, g, b, a)) count++;
        }
    }
    return count;
}

function isEquipmentPixel(kind, r, g, b, a) {
    if (a <= ALPHA_THRESHOLD) return false;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const brightSteel = r > 172 && g > 172 && b > 156 && spread < 96;
    const coolSteel = r > 92 && g > 112 && b > 128 && b >= r && spread < 110;
    const cyanRune = r < 135 && g > 135 && b > 145 && Math.abs(g - b) < 72;
    const goldFitting = r > 158 && g > 98 && g < 205 && b < 112;
    const darkShaft = r > 36 && r < 132 && g > 24 && g < 112 && b < 96;
    const shieldFace = r > 70 && g > 82 && b > 86 && spread < 88;

    if (kind === 'dagger' || kind === 'multitool' || kind === 'sword' || kind === 'greatsword') {
        return brightSteel || coolSteel || cyanRune || goldFitting;
    }
    if (kind === 'wrench') {
        return coolSteel || cyanRune || goldFitting || darkShaft;
    }
    if (kind === 'polearm') {
        return brightSteel || coolSteel || cyanRune || goldFitting || darkShaft;
    }
    if (kind === 'shield') {
        return shieldFace || goldFitting || cyanRune;
    }
    if (kind === 'swordShield') {
        return brightSteel || coolSteel || cyanRune || goldFitting || shieldFace;
    }
    return false;
}

function animationRowLabel(row) {
    return row < CHARACTER_WALK_FRAMES
        ? `walk${row}`
        : `idle${row - CHARACTER_WALK_FRAMES}`;
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
