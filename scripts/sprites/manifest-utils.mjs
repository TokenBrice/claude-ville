import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
export const manifestPath = join(spritesRoot, 'manifest.yaml');
export const palettesPath = join(spritesRoot, 'palettes.yaml');

export const SPRITE_GROUP_KEYS = Object.freeze([
    'characters',
    'equipment',
    'accessories',
    'statusOverlays',
    'buildings',
    'props',
    'vegetation',
    'terrain',
    'bridges',
    'atmosphere',
]);

export function loadSpriteManifest(path = manifestPath) {
    return yaml.load(readFileSync(path, 'utf8'));
}

export function collectSpriteEntries(manifest, groups = SPRITE_GROUP_KEYS) {
    const entries = [];
    for (const group of groups) {
        const groupEntries = manifest?.[group];
        if (!Array.isArray(groupEntries)) continue;
        entries.push(...groupEntries);
    }
    return entries;
}

export function layerNamesForEntry(entry) {
    if (!entry?.layers) return [];
    if (Array.isArray(entry.layers)) return entry.layers;
    return Object.keys(entry.layers);
}

export function pathForEntry(entryOrId) {
    const entry = typeof entryOrId === 'string' ? { id: entryOrId } : entryOrId;
    const id = entry?.id || '';
    if (entry?.assetPath) return String(entry.assetPath).replace(/^assets\/sprites\//, '');
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

export function expectedPathsForEntry(entry) {
    if (!entry) return [];
    const layerNames = layerNamesForEntry(entry);
    if (entry.composeGrid && layerNames.includes('base')) {
        const [cols, rows] = entry.composeGrid;
        const paths = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                paths.push(`buildings/${entry.id}/base-${col}-${row}.png`);
            }
        }
        for (const layer of layerNames.filter((name) => name !== 'base')) {
            paths.push(`buildings/${entry.id}/${layer}.png`);
        }
        return paths;
    }

    const base = pathForEntry(entry);
    const paths = base ? [base] : [];
    for (const layer of layerNames.filter((name) => name !== 'base')) {
        paths.push(`buildings/${entry.id}/${layer}.png`);
    }
    return paths;
}

export function inferSpriteTool(id) {
    if (id.startsWith('agent.')) return 'create_character';
    if (id.startsWith('terrain.')) return 'tileset';
    return 'map_object';
}

export function dimensionsForEntry(entry) {
    if (entry.composeGrid) return `composeGrid ${entry.composeGrid.join('x')}`;
    if (entry.width && entry.height) return `${entry.width}x${entry.height}`;
    if (entry.size && entry.id.startsWith('agent.')) {
        return `${entry.size * (entry.n_directions || 8)}x${entry.size * 10} sheet (${entry.size}px cells)`;
    }
    if (entry.size) return `${entry.size}x${entry.size}`;
    return 'manifest default';
}
