const SUPPORTED_KINDS = new Set(['point', 'beam', 'spark', 'arc', 'orbit']);

export function normalizeLightSource(source = {}, defaults = {}) {
    const kind = SUPPORTED_KINDS.has(source.kind) ? source.kind : 'point';
    const origin = source.origin || (
        Number.isFinite(source.x) && Number.isFinite(source.y)
            ? { x: source.x, y: source.y }
            : null
    );
    return {
        id: source.id || defaults.id || `${defaults.buildingType || 'light'}:${kind}:${Math.round(origin?.x || 0)},${Math.round(origin?.y || 0)}`,
        kind,
        origin,
        x: origin?.x ?? source.x,
        y: origin?.y ?? source.y,
        endpoints: Array.isArray(source.endpoints) ? source.endpoints : undefined,
        controlPoint: source.controlPoint,
        parent: source.parent,
        color: source.color || defaults.color || '#ffcc66',
        radius: Number.isFinite(source.radius) ? source.radius : defaults.radius || 64,
        length: source.length,
        width: source.width,
        alpha: Number.isFinite(source.alpha) ? source.alpha : defaults.alpha,
        ttl: source.ttl ?? null,
        createdAt: source.createdAt,
        buildingType: source.buildingType || defaults.buildingType || null,
        building: source.building || defaults.building || null,
        intensity: Number.isFinite(source.intensity) ? source.intensity : defaults.intensity ?? 1,
        overlay: source.overlay || defaults.overlay || null,
    };
}

export function lightSourceCacheKey(source, phaseBucket = 'fallback') {
    return [
        source.id || '',
        source.kind || 'point',
        Math.round(source.x ?? source.origin?.x ?? 0),
        Math.round(source.y ?? source.origin?.y ?? 0),
        Math.round(source.radius || 0),
        source.color || '',
        phaseBucket,
    ].join('|');
}

export function supportedLightSourceKinds() {
    return [...SUPPORTED_KINDS];
}

export class LightSourceRegistry {
    constructor() {
        this.staticSources = new Map();
        this.transientSources = new Map();
    }

    setStaticSources(ownerId, sources = []) {
        this.staticSources.set(ownerId, sources.map(source => normalizeLightSource(source)));
    }

    registerTransient(source) {
        const normalized = normalizeLightSource(source, {
            id: source.id || `transient:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        });
        this.transientSources.set(normalized.id, normalized);
        return normalized.id;
    }

    remove(ownerOrSourceId) {
        this.staticSources.delete(ownerOrSourceId);
        this.transientSources.delete(ownerOrSourceId);
    }

    getSources(now = Date.now()) {
        const out = [];
        for (const sources of this.staticSources.values()) out.push(...sources);
        for (const [id, source] of this.transientSources.entries()) {
            if (source.ttl != null && source.createdAt != null && now - source.createdAt > source.ttl) {
                this.transientSources.delete(id);
                continue;
            }
            out.push(source);
        }
        return out;
    }
}
