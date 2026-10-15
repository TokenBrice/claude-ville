#!/usr/bin/env node

// Deterministic companion-channel authoring for the R1-08 character roster and
// land tiles. Material classes and emissive colors are reviewed semantic data;
// this script never derives emission from luminance.

import {
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    actionStripPathsForEntry,
    collectSpriteEntries,
    loadSpriteManifest,
    pathForEntry,
    spritesRoot,
} from './manifest-utils.mjs';

const check = process.argv.includes('--check');

// Exact source colors keep glow semantic and sparse. Contribution is encoded
// in emissive alpha and deliberately remains below 0.20 for daylight restraint.
const PROFILES = Object.freeze({
    'agent.claude.fable': character('fabric', 0.10, ['#f9c855', '#f9cc57', '#f6c658']),
    'agent.claude.opus': character('fabric'),
    'agent.claude.sonnet': {
        ...character('fabric', 0.12, ['#d59cfb', '#c15df4', '#dba4f2']),
        // Reviewed source palette (pass 2 crescent-staff body): exposed face,
        // the crescent crystal at the staff head.
        materialColors: {
            unlit: ['d59f99', 'efa096', 'eca9a2', 'e89e99', 'e9a59b', 'd68884'],
            'glass-rune': ['d59cfb', 'c15df4', 'dba4f2', 'a464dc', 'd385ed'],
        },
    },
    'agent.claude.haiku': character('fabric'),
    'agent.codex.gpt55': character('metal', 0.16, ['#56efc9', '#43e1ca']),
    'agent.codex.gpt55.high': character('metal', 0.14, ['#70c0c7', '#68adba']),
    'agent.codex.gpt55.xhigh': character('metal', 0.18, ['#55e0d8', '#44c9c6']),
    'agent.codex.gpt56terra': {
        ...character('metal', 0.14, ['#e69744', '#da8e43']),
        // Reviewed source palette: olive cloth, leather fittings and bare skin.
        materialColors: {
            fabric: ['697b59', '3e4b38', '5e6955', '515b4e', '81514a', '73413c', '684747', '4e3f3e', '39262a'],
            unlit: ['ba8375', 'a66758', '8b655e', 'd1a292', '9f7873', 'eab9a1', 'd98f79'],
            'glass-rune': ['e69744', 'da8e43'],
        },
    },
    'agent.codex.gpt56luna': character('metal'),
    // Sampled 2026-10-13: the reactor core's oranges (chest height, front facings).
    'agent.codex.gpt56sol': character('metal', 0.18, ['#cb6728', '#d26e1b', '#9b3c0f']),
    // Sampled 2026-10-13 from the sheet: the violet visor slit only (head rows).
    'agent.codex.gpt6astra': character('metal', 0.16, ['#9d73d4', '#8e6dc3']),
    'agent.codex.gpt54': character('metal'),
    'agent.codex.gpt53spark': character('metal'),
    'agent.claude.base': character('fabric'),
    'agent.codex.base': character('metal', 0.14, ['#5ccfc1']),
    'agent.gemini.base': character('glass-rune', 0.10, ['#9ab3d9', '#a5bef3', '#9eaae9']),
    'agent.kimi.base': character('fabric'),
    'agent.deepseek.reasoner': character('earth', 0.12, ['#4ea68c', '#398e7b']),
    'agent.deepseek.pro': character('earth', 0.10, ['#61ab9d', '#319893']),
    // Sampled 2026-09-10 from each regenerated sheet: the sparse bright teals
    // on the cloak's rune edging, not the leather body greens. Re-mapped
    // through the 2026-10-15 value lift (scripts/sprites/value-lift.mjs).
    'agent.deepseek.flash': character('earth', 0.08, ['#77dabf', '#72eac0', '#c1f0e9']),
    'agent.deepseek.flash.high': character('earth', 0.10, ['#b9eee2', '#2efad0']),
    'agent.deepseek.flash.xhigh': character('earth', 0.12, ['#bbf6e7', '#b8fae8']),
    'agent.grok.base': character('fabric', 0.14, ['#46a9d1', '#59d3e4']),
    'agent.grok.composer': character('fabric', 0.12, ['#4ab9cf', '#47dce4']),
    'agent.zai.glm': character('fabric', 0.12, ['#40865d', '#569c77', '#70ca84']),
    'agent.zai.glm.b': character('fabric', 0.12, ['#3f906e']),
    'agent.zai.flash': character('fabric'),
    'building.command': {
        ...terrain('stone'),
        channels: ['material'],
        // Blue roof tiles remain stone; these authored palette groups distinguish
        // the crimson cloth and planted edges from masonry. Shared wall/door
        // colors deliberately stay stone; a palette cannot disambiguate them.
        materialColors: {
            fabric: ['9f1f1f', '96201a', '912323', 'a01322', 'a32b21', 'b82821', '823022'],
            foliage: ['255a18', '2a5f1c', '29611a', '12240e'],
        },
    },
    'terrain.grass-dirt': terrain('earth'),
    'terrain.grass-cobble': terrain('cobble'),
    'terrain.grass-shore': terrain('foliage'),
    'terrain.cobble-square': terrain('cobble'),
});

const entries = new Map(collectSpriteEntries(loadSpriteManifest()).map((entry) => [entry.id, entry]));
let failures = 0;
if (check) {
    const missingProfiles = [...entries.values()]
        .filter((entry) => entry.id?.startsWith('agent.') && requiresSidecarProfile(entry))
        .filter((entry) => !PROFILES[entry.id])
        .map((entry) => entry.id);
    if (missingProfiles.length) {
        console.error(`[author-roster-channels] missing required character profiles: ${missingProfiles.join(', ')}`);
        failures += missingProfiles.length;
    }
}
for (const [id, profile] of Object.entries(PROFILES)) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`missing manifest entry ${id}`);
    if (id.startsWith('agent.') && !declaresSidecarFile(entry)) continue;
    // The same reviewed colour classification serves the base sheet and the
    // optional C2 action strip; both are the same character's albedo pixels.
    const sources = [pathForEntry(entry), ...actionStripPathsForEntry(entry).slice(0, 1)];
    for (const sourcePath of sources) {
        const albedo = PNG.sync.read(readFileSync(join(spritesRoot, sourcePath)));
        const channels = authorChannels(albedo, profile);
        for (const [channel, png] of Object.entries(channels)) {
            const outputPath = join(spritesRoot, sourcePath.replace(/\.png$/, `.${channel}.png`));
            const bytes = PNG.sync.write(png, { colorType: 6 });
            if (check) {
                if (!existsSync(outputPath) || !readFileSync(outputPath).equals(bytes)) {
                    console.error(`[author-roster-channels] STALE ${sourcePath}:${channel}`);
                    failures++;
                }
            } else {
                writeFileSync(outputPath, bytes);
            }
        }
        const emissivePixels = channels.emissive ? countContributingPixels(channels.emissive) : 0;
        console.log(`[author-roster-channels] ${check ? 'checked' : 'authored'} ${sourcePath}: ${profile.material}, ${emissivePixels} emissive pixels`);
    }
}

if (failures) {
    console.error(`[author-roster-channels] ${failures} stale or missing channel file(s)`);
    process.exit(1);
}
console.log(`[author-roster-channels] ${check ? 'check passed' : 'done'}: ${Object.keys(PROFILES).length} ids`);

function declaresSidecarFile(entry) {
    return Object.entries(entry).some(([key, value]) => key.endsWith('Sidecar') && value === true);
}

function requiresSidecarProfile(entry) {
    if (declaresSidecarFile(entry)) return true;
    return declaresSidecarRequiredGeometry(entry);
}

function declaresSidecarRequiredGeometry(value) {
    if (Array.isArray(value)) return value.some(declaresSidecarRequiredGeometry);
    if (!value || typeof value !== 'object') return false;
    if (value.geometry === 'sidecar-required') return true;
    return Object.values(value).some(declaresSidecarRequiredGeometry);
}

function character(material, emissiveContribution = 0, emissiveColors = []) {
    return { material, emissiveContribution, emissiveColors, occluder: 'alpha-silhouette' };
}

function terrain(material) {
    return { material, emissiveContribution: 0, emissiveColors: [], occluder: 'none' };
}

function authorChannels(albedo, profile) {
    const material = blankLike(albedo);
    const emissive = blankLike(albedo);
    const occluder = blankLike(albedo);
    const selected = new Set(profile.emissiveColors.map(normalizeHex));
    const materialIndex = materialClassId(profile.material);
    const materialColors = new Map(Object.entries(profile.materialColors || {}).flatMap(
        ([name, colors]) => colors.map(color => [normalizeHex(color), materialClassId(name)])
    ));
    for (let index = 0; index < albedo.data.length; index += 4) {
        const alpha = albedo.data[index + 3];
        if (alpha === 0) continue;
        const rgb = rgbKey(albedo.data[index], albedo.data[index + 1], albedo.data[index + 2]);
        material.data[index] = materialColors.get(rgb) ?? materialIndex;
        material.data[index + 3] = alpha;

        if (profile.occluder === 'alpha-silhouette') {
            occluder.data[index + 1] = alpha;
            occluder.data[index + 3] = alpha;
        }

        if (selected.has(rgb)) {
            emissive.data[index] = albedo.data[index];
            emissive.data[index + 1] = albedo.data[index + 1];
            emissive.data[index + 2] = albedo.data[index + 2];
            emissive.data[index + 3] = Math.min(alpha, Math.round(alpha * profile.emissiveContribution));
        }
    }
    const channels = { material, emissive, occluder };
    return profile.channels ? Object.fromEntries(profile.channels.map(name => [name, channels[name]])) : channels;
}

function blankLike(source) {
    return new PNG({ width: source.width, height: source.height, colorType: 6 });
}

function normalizeHex(value) {
    const hex = String(value).replace(/^#/, '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error(`invalid authored RGB ${value}`);
    return hex;
}

function rgbKey(r, g, b) {
    return [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function countContributingPixels(png) {
    let count = 0;
    for (let index = 3; index < png.data.length; index += 4) {
        if (png.data[index] > 0) count++;
    }
    return count;
}
