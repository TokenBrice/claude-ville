import { HARNESS_HUES, TEAM_HUES } from '../../config/theme.js';

// The categorical team ramp lives in the theme.js House Palette as TEAM_HUES
// (plan 1.11); this module only derives glow/panel tones and the stable hash
// assignment.

function stableHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function hexToRgb(hex) {
    const normalized = String(hex || '').replace('#', '');
    const value = Number.parseInt(normalized, 16);
    if (!Number.isFinite(value)) return { r: 139, g: 139, b: 158 };
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

export function getTeamColor(teamName) {
    const key = String(teamName || '').trim();
    if (!key) {
        return {
            accent: '#8b8b9e',
            glow: 'rgba(139, 139, 158, 0.30)',
            panel: 'rgba(34, 34, 46, 0.90)',
        };
    }
    const accent = TEAM_HUES[stableHash(key) % TEAM_HUES.length];
    const { r, g, b } = hexToRgb(accent);
    return {
        accent,
        glow: `rgba(${r}, ${g}, ${b}, 0.34)`,
        panel: `rgba(${Math.round(r * 0.22)}, ${Math.round(g * 0.22)}, ${Math.round(b * 0.22)}, 0.90)`,
    };
}

// FK-7 — the house hue for a teammate's harness colour name, or null for an
// absent or unknown name.
export function harnessAccent(agentColor) {
    const key = String(agentColor || '').trim().toLowerCase();
    return Object.hasOwn(HARNESS_HUES, key) ? HARNESS_HUES[key] : null;
}

// The sash (trim swap) accent for one agent: its harness colour first, then
// the team-name hash, null for a solo agent (no swap).
export function agentTrimAccent(agent) {
    const harness = harnessAccent(agent?.agentColor);
    if (harness) return harness;
    const name = agent?.teamName;
    return name ? getTeamColor(name).accent : null;
}

// FK-3 — Claude Code gives every teammate a team named `session-<id>`. When
// all its members share one parent the team is that parent's squad, not a
// team anyone made: no council ring and no sidebar swatch of its own.
export function isImplicitSessionTeam(teamName, members) {
    if (!String(teamName || '').startsWith('session-')) return false;
    let parentId = null;
    for (const member of members || []) {
        const memberParent = member?.parentSessionId || null;
        if (!memberParent || (parentId && memberParent !== parentId)) return false;
        parentId = memberParent;
    }
    return parentId !== null;
}

export function shortTeamName(teamName) {
    const text = String(teamName || '').trim();
    if (!text) return '';
    if (text === 'default') return text;
    return /^[0-9a-f-]{32,}$/i.test(text) ? text.slice(0, 6) : text;
}
