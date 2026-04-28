// Canonical per-repo palette + hash-keyed profile.
// Both the harbor (canvas, ship markers) and the sidebar (DOM, project groups)
// must agree on the color for a given repo path.

const REPO_PALETTES = [
    { accent: '#6cdb94', glow: 'rgba(108, 219, 148, 0.34)', panel: 'rgba(20, 54, 42, 0.9)' },
    { accent: '#63c7f2', glow: 'rgba(99, 199, 242, 0.33)', panel: 'rgba(21, 47, 60, 0.9)' },
    { accent: '#f2b84b', glow: 'rgba(242, 184, 75, 0.35)', panel: 'rgba(60, 45, 20, 0.9)' },
    { accent: '#ef7b6d', glow: 'rgba(239, 123, 109, 0.33)', panel: 'rgba(62, 34, 31, 0.9)' },
    { accent: '#b58cff', glow: 'rgba(181, 140, 255, 0.32)', panel: 'rgba(43, 34, 63, 0.9)' },
    { accent: '#f08fd4', glow: 'rgba(240, 143, 212, 0.3)', panel: 'rgba(59, 32, 52, 0.9)' },
    { accent: '#9ed760', glow: 'rgba(158, 215, 96, 0.32)', panel: 'rgba(42, 55, 25, 0.9)' },
    { accent: '#f6cf60', glow: 'rgba(246, 207, 96, 0.33)', panel: 'rgba(58, 48, 27, 0.9)' },
];

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
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

export function repoProfile(project) {
    const name = projectName(project);
    const hash = stableHash(String(project || name || 'unknown'));
    const palette = REPO_PALETTES[hash % REPO_PALETTES.length];
    return {
        key: `${name.toLowerCase()}:${hash.toString(36)}`,
        name,
        shortName: shorten(name, 16),
        hash,
        accent: palette.accent,
        glow: palette.glow,
        panel: palette.panel,
    };
}
