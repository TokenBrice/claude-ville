const DEFAULT_PULSE_PRIORITY = ['selection', 'working', 'recent', 'intrinsic'];
const DEFAULT_PULSE_BANDS = Object.freeze({
    selection: { rate: 0.115, base: 0.72, amplitude: 0.28, phase: 0 },
    working: { rate: 0.075, base: 0.64, amplitude: 0.22, phase: 0.7 },
    recent: { rate: 0.045, base: 0.58, amplitude: 0.18, phase: 1.4 },
    alert: { rate: 0.145, base: 0.68, amplitude: 0.30, phase: 0.2 },
    harbor: { rate: 0.065, base: 0.62, amplitude: 0.20, phase: 1.1 },
    intrinsic: { rate: 0.035, base: 0.55, amplitude: 0.14, phase: 2.0 },
});

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

export function getPulseBands() {
    return DEFAULT_PULSE_BANDS;
}

export function pulseValue(bandName = 'intrinsic', frame = 0, motionScale = 1) {
    const band = DEFAULT_PULSE_BANDS[bandName] || DEFAULT_PULSE_BANDS.intrinsic;
    if (motionScale <= 0) return band.base;
    const phase = (Number(frame) || 0) * band.rate + band.phase;
    return band.base + Math.sin(phase) * band.amplitude;
}

export function pulseAlpha(bandName = 'intrinsic', frame = 0, motionScale = 1, min = 0, max = 1) {
    const value = Math.max(0, Math.min(1, pulseValue(bandName, frame, motionScale)));
    const lo = Math.max(0, Math.min(1, Number(min) || 0));
    const hi = Math.max(lo, Math.min(1, Number(max) || 1));
    return lo + (hi - lo) * value;
}
