// Canonical per-repo and per-branch hash-keyed color profiles.
// Both the harbor (canvas, ship markers) and the sidebar (DOM, project groups)
// must agree on the color for a given repo path.
//
// 7.10 — identity hues come from the status-free C1 pennant palette, never a
// free hue wheel: a repo may not wear working green, needs-you yellow or
// error red. The hash is FNV-1a with a murmur3 fmix32 avalanche so sibling
// paths that differ in one character (`dense-1`..`dense-4`) scatter across
// the palette instead of landing one degree apart.
//
// Eight pennants cannot keep a hash collision-free, so the repos on screen
// are resolved in one shared registry: this module tracks the live agents'
// projects (agent:added/updated/removed) and gives every visible repo its own
// pennant — newcomers in hash order, each linear-probing from its hash slot to
// the next free one. A visible repo keeps its slot until it leaves, so no
// pennant repaints under the viewer. Sidebar, Dashboard, Harbor ships and
// building pennants all read repoProfile(), so they always agree. Repos that
// are not on screen (chronicle history) fall back to the plain hash slot.

import { PENNANT_PALETTE } from '../../config/artPalette.js';
import { eventBus } from '../../domain/events/DomainEvent.js';

const INK_LIGHT = [0xee, 0xe3, 0xcb]; // --ink-1: label text mixes toward it
const PANEL_DARK = [0x15, 0x10, 0x0d]; // --bg-1: panels mix toward it

function hexToRgb(hex) {
    const value = Number.parseInt(String(hex).replace('#', ''), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl([r, g, b]) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const delta = max - min;
    if (delta === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    return { hue: ((hue * 60) + 360) % 360, saturation: saturation * 100, lightness: lightness * 100 };
}

function mixRgb(a, b, t) {
    return a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));
}

function rgbHex(rgb) {
    return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function rgbaColor([r, g, b], alpha) {
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// One palette entry → the full profile shape every consumer reads.
function pennantProfile(index) {
    const accent = PENNANT_PALETTE[index];
    const rgb = hexToRgb(accent);
    const { hue, saturation, lightness } = rgbToHsl(rgb);
    return {
        pennantIndex: index,
        hue,
        saturation,
        lightness,
        accent,
        labelText: rgbHex(mixRgb(rgb, INK_LIGHT, 0.45)),
        glow: rgbaColor(rgb, 0.38),
        panel: rgbaColor(mixRgb(rgb, PANEL_DARK, 0.84), 0.94),
        panelBorder: accent,
    };
}

// Profiles are pure functions of the palette index: build each once.
const PENNANT_PROFILES = PENNANT_PALETTE.map((_, index) => pennantProfile(index));

function hashSlot(hash) {
    return hash % PENNANT_PALETTE.length;
}

// --- Visible-repo registry --------------------------------------------------
const liveAgentRepo = new Map(); // agent id -> repo key of each live agent
const visibleSlots = new Map();  // repo key -> resolved pennant index
let registryDirty = false;

function trackAgent(agent) {
    if (!agent?.id) return;
    const key = agent.projectPath ? String(agent.projectPath) : '';
    if ((liveAgentRepo.get(agent.id) || '') === key) return;
    if (key) liveAgentRepo.set(agent.id, key);
    else liveAgentRepo.delete(agent.id);
    registryDirty = true;
}

function untrackAgent(agent) {
    if (agent?.id && liveAgentRepo.delete(agent.id)) registryDirty = true;
}

eventBus.on('agent:added', trackAgent);
eventBus.on('agent:updated', trackAgent);
eventBus.on('agent:removed', untrackAgent);

function resolveVisibleSlots() {
    if (!registryDirty) return;
    registryDirty = false;
    const live = new Set(liveAgentRepo.values());
    for (const key of [...visibleSlots.keys()]) {
        if (!live.has(key)) visibleSlots.delete(key);
    }
    const count = PENNANT_PALETTE.length;
    const taken = new Set(visibleSlots.values());
    const newcomers = [...live]
        .filter((key) => !visibleSlots.has(key))
        .map((key) => [key, stableHash(key)])
        .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1));
    for (const [key, hash] of newcomers) {
        const home = hashSlot(hash);
        let slot = home;
        // More live repos than pennants: collisions are unavoidable, keep home.
        if (taken.size < count) {
            for (let step = 0; step < count; step++) {
                const candidate = (home + step) % count;
                if (!taken.has(candidate)) {
                    slot = candidate;
                    break;
                }
            }
        }
        visibleSlots.set(key, slot);
        taken.add(slot);
    }
}

function colorProfileFor(key, hash) {
    resolveVisibleSlots();
    return PENNANT_PROFILES[visibleSlots.get(key) ?? hashSlot(hash)];
}

// A branch never shares its base repo's pennant: step to one of the other
// seven entries, chosen by the branch hash.
function branchColorProfile(baseProfile, branchHash) {
    const count = PENNANT_PALETTE.length;
    const step = 1 + (branchHash % (count - 1));
    return PENNANT_PROFILES[((baseProfile.pennantIndex || 0) + step) % count];
}

// FNV-1a over UTF-16 code units, finished with murmur3's fmix32 avalanche.
function stableHash(input) {
    const text = String(input || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function shorten(value, maxChars) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function projectName(project) {
    const text = String(project || 'unknown').trim();
    const parts = text.split(/[\\/]/).filter(Boolean);
    return shorten(parts.at(-1) || text || 'unknown', 26);
}

export function normalizeRepoBranch(branch) {
    const text = String(branch || '')
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/remotes\/[^/]+\//, '')
        .trim();
    if (!text || text === 'HEAD' || text === 'unknown') return '';
    return text;
}

export function repoProfile(project) {
    const name = projectName(project);
    const key = String(project || name || 'unknown');
    const hash = stableHash(key);
    const colors = colorProfileFor(key, hash);
    return {
        key: `${name.toLowerCase()}:${hash.toString(36)}`,
        name,
        shortName: shorten(name, 16),
        hash,
        ...colors,
    };
}

export function repoBranchProfile(project, branch) {
    const normalizedBranch = normalizeRepoBranch(branch);
    const base = repoProfile(project);
    if (!normalizedBranch) return base;

    const branchHash = stableHash(`${base.key}:${normalizedBranch}`);
    const colors = branchColorProfile(base, branchHash);
    const branchName = shorten(normalizedBranch, 18);
    return {
        ...base,
        key: `${base.key}@${branchHash.toString(36)}`,
        branch: normalizedBranch,
        branchName,
        fullName: `${base.name}/${branchName}`,
        shortName: `${base.shortName}/${shorten(normalizedBranch, 10)}`,
        branchHash,
        baseAccent: base.accent,
        baseGlow: base.glow,
        basePanel: base.panel,
        isBranchVariant: true,
        ...colors,
    };
}
