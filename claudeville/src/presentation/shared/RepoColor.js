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
import { normalizeRepoBranch, projectNameFromPath } from './GitEventIdentity.js';

export { normalizeRepoBranch };

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
// Harbor wire contract v1: a linked worktree or subdirectory session reports
// its repo's main worktree as `repoRoot`. Profiles key on that repo, so every
// checkout of one repo wears one pennant.
const checkoutRepo = new Map();  // checkout path -> repoRoot
const MAX_CHECKOUT_REPOS = 512;
let registryDirty = false;

function learnCheckout(agent) {
    const checkout = agent?.projectPath ? String(agent.projectPath) : '';
    const repoRoot = agent?.repoRoot ? String(agent.repoRoot) : '';
    if (!checkout || !repoRoot || checkoutRepo.get(checkout) === repoRoot) return;
    checkoutRepo.delete(checkout);
    // P2-12 — a path that is now its own repo drops any old worktree alias.
    if (checkout === repoRoot) {
        registryDirty = true;
        return;
    }
    checkoutRepo.set(checkout, repoRoot);
    if (checkoutRepo.size > MAX_CHECKOUT_REPOS) checkoutRepo.delete(checkoutRepo.keys().next().value);
}

// The repo a path belongs to: its known repoRoot, else the path itself.
export function repoKeyFor(project) {
    const path = String(project || '');
    return checkoutRepo.get(path) || path;
}

function trackAgent(agent) {
    if (!agent?.id) return;
    learnCheckout(agent);
    const key = agent.repoRoot ? String(agent.repoRoot) : (agent.projectPath ? String(agent.projectPath) : '');
    if ((liveAgentRepo.get(agent.id) || '') === key) return;
    if (key) liveAgentRepo.set(agent.id, key);
    else liveAgentRepo.delete(agent.id);
    registryDirty = true;
}

function untrackAgent(agent) {
    if (agent?.id && liveAgentRepo.delete(agent.id)) registryDirty = true;
}

// The registry hears the roster on the bus from import on, so every surface
// and every test shares it from the start. The App re-installs it at boot
// and uninstalls it at teardown, which also forgets the roster: a destroyed
// app leaves no listener behind, and a second mount starts empty.
let rosterUnsubscribers = null;

export function installRepoColors() {
    if (rosterUnsubscribers) return;
    rosterUnsubscribers = [
        eventBus.on('agent:added', trackAgent),
        eventBus.on('agent:updated', trackAgent),
        eventBus.on('agent:removed', untrackAgent),
    ];
}

export function uninstallRepoColors() {
    if (!rosterUnsubscribers) return;
    for (const unsubscribe of rosterUnsubscribers) unsubscribe();
    rosterUnsubscribers = null;
    liveAgentRepo.clear();
    visibleSlots.clear();
    checkoutRepo.clear();
    registryDirty = false;
}

installRepoColors();

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
    return shorten(projectNameFromPath(project), 26);
}

// U-1.1 — the display name of a repo: its raw basename (never title-cased),
// with the parent directory only when another visible repo shares that
// basename (`work/beta` beside `other/beta`).
export function repoDisplayName(project) {
    const key = repoKeyFor(project) || 'unknown';
    const name = projectNameFromPath(key);
    resolveVisibleSlots();
    for (const other of visibleSlots.keys()) {
        if (other === key || projectNameFromPath(other) !== name) continue;
        const parent = String(key).split(/[\\/]/).filter(Boolean).at(-2);
        return parent ? `${parent}/${name}` : name;
    }
    return name;
}

export function repoProfile(project) {
    project = repoKeyFor(project) || project;
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

// U-P1 — colour is the repo, everywhere: a branch profile wears its repo's
// pennant (the colours are the base profile's), and only adds the branch
// identity — its name, its key (one ledger row per lane) and its shape kind
// (`branchPennonKind`), which the harbor draws as the masthead pennon.
export function repoBranchProfile(project, branch) {
    const normalizedBranch = normalizeRepoBranch(branch);
    const base = repoProfile(project);
    if (!normalizedBranch) return base;

    const branchHash = stableHash(`${base.key}:${normalizedBranch}`);
    const branchName = shorten(normalizedBranch, 18);
    return {
        ...base,
        key: `${base.key}@${branchHash.toString(36)}`,
        branch: normalizedBranch,
        branchName,
        fullName: `${base.name}/${branchName}`,
        shortName: `${base.shortName}/${shorten(normalizedBranch, 10)}`,
        branchHash,
    };
}

const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk']);

// The pennon shape a lane flies: `default` (swallowtail) for the repo's
// trunk, `worktree` (notched triangle) for a branch checked out in a linked
// worktree, `feature` (burgee) for every other branch, `detached` without one.
export function branchPennonKind(branch, worktree = null) {
    const normalizedBranch = normalizeRepoBranch(branch);
    if (!normalizedBranch) return 'detached';
    if (worktree && worktree.isMain === false) return 'worktree';
    return DEFAULT_BRANCHES.has(normalizedBranch) ? 'default' : 'feature';
}
