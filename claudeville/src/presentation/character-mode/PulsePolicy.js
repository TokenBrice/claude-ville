const DEFAULT_PULSE_PRIORITY = ['selection', 'working', 'recent', 'intrinsic'];

function parsePriority(value) {
    if (!value) return null;
    const parts = String(value)
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
    return parts.length ? parts : null;
}

export function getPulsePriority() {
    if (typeof window === 'undefined') return [...DEFAULT_PULSE_PRIORITY];
    try {
        const params = new URLSearchParams(window.location.search);
        return parsePriority(params.get('pulsePriority')) || [...DEFAULT_PULSE_PRIORITY];
    } catch {
        return [...DEFAULT_PULSE_PRIORITY];
    }
}

export function getPulseBandPolicy() {
    return {
        slow: { cadence: '>1s', owner: 'selection' },
        medium: { cadence: '~600ms', owner: 'working' },
        fast: { cadence: '<300ms', owner: 'recent' },
        static: { cadence: 'none', owner: 'intrinsic' },
    };
}
