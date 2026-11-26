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
import { Compositor, HEAD_APEX_COLUMNS, STRIP_HEAD_MATCHED, sourceList } from '../../claudeville/src/presentation/character-mode/Compositor.js';
import { DIRECTIONS, WALK_FRAMES } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { CODEX_CELESTIAL_GRIPS } from '../../claudeville/src/presentation/character-mode/CodexCelestialGrips.js';
import { ASTRA_WRIST_TABLES, ASTRA_POSE_WRIST_TABLES } from '../../claudeville/src/presentation/character-mode/AstraWeaponPose.js';
import { CODEX_ENGINEER_GRIPS, clearDetachedCodexWrench } from '../../claudeville/src/presentation/character-mode/CodexEngineerGrips.js';
import { CODEX_PALADIN_GRIPS } from '../../claudeville/src/presentation/character-mode/CodexPaladinGrips.js';
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
    // Second Fable body: no shoulder motes, so no reviewed glow source.
    'agent.claude.fable.b': character('fabric'),
    // The rune tablet is pale stone: no reviewed glow source on this body.
    'agent.claude.mythos': character('fabric'),
    'agent.claude.opus': character('fabric'),
    'agent.claude.opus.b': character('fabric'),
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
    'agent.codex.gpt56luna.b': character('metal'),
    // Sampled 2026-10-13: the reactor core's oranges (chest height, front facings).
    'agent.codex.gpt56sol': character('metal', 0.18, ['#cb6728', '#d26e1b', '#9b3c0f']),
    'agent.codex.gpt56sol.b': character('metal'),
    // Sampled 2026-10-13 from the sheet: the violet visor slit only (head rows).
    'agent.codex.gpt6astra': character('metal', 0.16, ['#9d73d4', '#8e6dc3']),
    // Second Astra body: open-faced, no visor slit, so no reviewed glow source.
    'agent.codex.gpt6astra.b': character('metal'),
    'agent.codex.gpt54': character('metal'),
    'agent.codex.gpt53spark': character('metal'),
    'agent.claude.base': character('fabric'),
    'agent.codex.base': character('metal', 0.14, ['#5ccfc1']),
    'agent.gemini.base': character('glass-rune', 0.10, ['#9ab3d9', '#a5bef3', '#9eaae9']),
    'agent.gemini.carbon': character('glass-rune', 0.16, ['#e7fcfc', '#cbfbfb', '#a7f9f9', '#7bf1f0']),
    'agent.gemini.carbon.b': character('glass-rune', 0.16, ['#a9f5f7', '#76d2da', '#b9e3e8', '#cef2f2']),
    'agent.gemini.argon': character('glass-rune', 0.14, ['#f6dffe', '#f0d1fe', '#ddadf8', '#b77cf2', '#b26ffc']),
    'agent.gemini.neon': character('glass-rune', 0.16, [
        '#c5f3f6', '#9ef1f5', '#65eff3', '#75e5ec', '#47d7dc', '#3ebfe1', '#7eced6', '#2aaecf', '#44b9c3',
    ]),
    'agent.gemini.neon.b': character('glass-rune', 0.16, [
        '#d3ffff', '#9cf7f8', '#53e3e3', '#50ced1', '#40a9b3',
    ]),
    'agent.gemini.hydrogen': character('glass-rune', 0.12, ['#c2feff', '#81f5f9', '#85d4f3', '#94e1f2']),
    'agent.gemini.flash': character('glass-rune', 0.12, ['#fbf0ad', '#fae981', '#fdea5a', '#f9de64', '#fad849']),
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
    // building.command's material sidecar: scripts/sprites/paint-facade-materials.mjs
    // (EN-2), whose reviewed regions separate the oak gate and iron fittings
    // from wall colours a palette alone cannot disambiguate.
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
const palettes = {};
const anchors = {};
for (const id of Object.keys(PROFILES).sort()) {
    const profile = PROFILES[id];
    const entry = entries.get(id);
    if (!entry) throw new Error(`missing manifest entry ${id}`);
    if (id.startsWith('agent.') && !declaresSidecarFile(entry)) continue;
    // The same reviewed colour classification serves the base sheet and the
    // optional C2 action strip; both are the same character's albedo pixels.
    const sources = [pathForEntry(entry), ...actionStripPathsForEntry(entry).slice(0, 1)];
    const images = sources.map(path => PNG.sync.read(readFileSync(join(spritesRoot, path))));
    let codes;
    if (id.startsWith('agent.')) {
        const palette = paletteFor(entry, images);
        palettes[id] = palette.model;
        codes = palette.codes;
        anchors[id] = anchorsFor(entry, images);
    }
    for (const [i, sourcePath] of sources.entries()) {
        const channels = authorChannels(images[i], profile, codes);
        for (const [channel, png] of Object.entries(channels)) {
            const outputPath = join(spritesRoot, sourcePath.replace(/\.png$/, `.${channel}.png`));
            const bytes = PNG.sync.write(png, { colorType: 6 });
            if (check) {
                if (!existsSync(outputPath) || !readFileSync(outputPath).equals(bytes)) {
                    console.error(`[author-roster-channels] STALE ${sourcePath}:${channel}`);
                    failures++;
                }
            } else {
                if (!existsSync(outputPath) || !readFileSync(outputPath).equals(bytes)) writeFileSync(outputPath, bytes);
            }
        }
        const emissivePixels = channels.emissive ? countContributingPixels(channels.emissive) : 0;
        console.log(`[author-roster-channels] ${check ? 'checked' : 'authored'} ${sourcePath}: ${profile.material}, ${emissivePixels} emissive pixels`);
    }
}

for (const [name, models] of [['roster-palettes', palettes], ['anchors', anchors]]) {
    const path = join(spritesRoot, 'characters', name + '.json');
    const firelight = name === 'roster-palettes'
        ? ',"firelight":' + JSON.stringify([...PNG.sync.read(readFileSync(join(spritesRoot, 'luts/light-ramp.command.png'))).data])
        : '';
    const json = '{"version":1' + firelight + ',"models":{\n' + Object.entries(models)
        .map(([id, model]) => JSON.stringify(id) + ':' + JSON.stringify(model)).join(',\n') + '\n}}\n';
    if (check) {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== json) {
            console.error('[author-roster-channels] STALE ' + path);
            failures++;
        }
    } else writeFileSync(path, json);
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

function paletteFor(entry, images) {
    const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16));
    const robeAnchors = sourceList(entry.paletteSource?.robe).map(rgb);
    const trimAnchors = sourceList(entry.paletteSource?.trim).map(rgb);
    const codes = new Map();
    const robeColors = [];
    for (const { data } of images) {
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 16) continue;
            const key = data.readUIntBE(i, 3);
            if (codes.has(key)) continue;
            const matches = a => a.every((v, c) => Math.abs(data[i + c] - v) <= 12);
            const robe = robeAnchors.findIndex(matches);
            const trim = trimAnchors.findIndex(matches);
            codes.set(key, trim < 0 ? 0 : 32 + trim);
            if (robe >= 0) robeColors.push([data[i], data[i+1], data[i+2], robe, trim]);
        }
    }
    if (robeColors.length > 31) throw new Error(entry.id + ' exceeds 31 robe slots');
    robeColors.sort((a, b) => a[3]-b[3] || a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
    robeColors.forEach(([r,g,b], i) => codes.set((r << 16) | (g << 8) | b, i + 1));
    return { model: { robeAnchors, robeColors, trimAnchors }, codes };
}

function anchorsFor(entry, [base, actions]) {
    if (entry.id === 'agent.codex.gpt54') {
        base = { ...base, data: Buffer.from(base.data) };
        clearDetachedCodexWrench({ clearRect(x, y, w, h) {
            for (let row = y; row < y + h; row++) base.data.fill(0, (row * base.width + x) * 4, (row * base.width + x + w) * 4);
        } }, base.width, base.height);
    }
    const cell = base.width / DIRECTIONS.length;
    const scan = Compositor.prototype;
    const columns = HEAD_APEX_COLUMNS[entry.id];
    const templates = STRIP_HEAD_MATCHED.has(entry.id) ? scan._headTemplates(base, cell, columns) : null;
    const groups = { walk: [base, 0, WALK_FRAMES-1], idle: [base, WALK_FRAMES, base.height/cell-1] };
    for (const [name, group] of Object.entries(entry.actionStrip?.groups || {})) groups[name] = [actions, ...group.rows];
    const headApex = {};
    for (const [name, [image, first, last]] of Object.entries(groups)) {
        headApex[name] = {};
        for (const [col, direction] of DIRECTIONS.entries()) {
            const points = [];
            for (let row = first; row <= last; row++) {
                const x = col * cell, y = row * cell;
                const apex = image === actions && templates?.[col]
                    ? scan._matchHead(image.data, image.width, x, y, cell, templates[col])
                    : scan._cellHeadApex(image.data, image.width, x, y, cell, columns);
                points.push(apex.found ? [Math.round(apex.centroidX - x), apex.topY - y] : null);
            }
            headApex[name][direction] = points;
        }
    }
    const grip = CODEX_CELESTIAL_GRIPS[entry.id] || CODEX_ENGINEER_GRIPS[entry.id] || CODEX_PALADIN_GRIPS[entry.id];
    const tracks = grip?.wrists || ASTRA_WRIST_TABLES[entry.id];
    if (!tracks) return { headApex };
    const wrists = { walk: {}, idle: {}, ...(grip?.poseWrists || ASTRA_POSE_WRIST_TABLES[entry.id]) };
    for (const [dir, frames] of Object.entries(tracks)) {
        wrists.walk[dir] = frames.slice(0, WALK_FRAMES);
        wrists.idle[dir] = frames.slice(WALK_FRAMES);
    }
    return { headApex, [CODEX_PALADIN_GRIPS[entry.id] ? 'wristL' : 'wristR']: wrists };
}

function authorChannels(albedo, profile, codes) {
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
        if (codes && alpha >= 16) material.data[index + 1] = codes.get(albedo.data.readUIntBE(index, 3));
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
