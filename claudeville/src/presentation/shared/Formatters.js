const HOME_ROOTS = Object.freeze(['Users', 'home']);

export function hashRows(rows, fields) {
    let hash = 2166136261;
    for (const row of rows || []) {
        for (const field of fields) {
            const value = typeof field === 'function' ? field(row) : row?.[field];
            const str = String(value ?? '');
            for (let i = 0; i < str.length; i++) {
                hash ^= str.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            hash ^= 31;
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 124;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function normalizeStatus(status, fallback = 'idle') {
    const normalized = String(status || fallback || 'idle').toLowerCase();
    return normalized === 'active' ? 'working' : normalized;
}

export function statusClass(status, fallback = 'idle') {
    const normalized = normalizeStatus(status, fallback);
    return ['working', 'idle', 'waiting'].includes(normalized) ? normalized : fallback;
}

export function formatNumber(num) {
    const value = Number(num) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return String(value);
}

export function formatTokens(value) {
    return formatNumber(value);
}

export function formatCost(cost) {
    const value = Number(cost);
    if (!Number.isFinite(value) || value <= 0) return '$0.0000';
    if (value < 0.0001) return '<$0.0001';
    if (value >= 10) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(4)}`;
}

export function shortenHomePath(path) {
    const text = String(path || '');
    if (!text || text === '_unknown') return '';
    const separator = text.includes('\\') ? '\\' : '/';
    const parts = text.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2 && HOME_ROOTS.includes(parts[0])) {
        const suffix = parts.slice(2).join(separator);
        return suffix ? `~${separator}${suffix}` : '~';
    }
    return text;
}

export function shortProjectName(path, unknownLabel = 'Unknown Project') {
    if (!path || path === '_unknown') return unknownLabel;
    const shortened = shortenHomePath(path);
    if (shortened === '~') return '~';
    const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || String(path);
}

export function truncateText(value, max) {
    const text = String(value || '');
    return text.length > max ? `${text.substring(0, max - 1)}...` : text;
}
