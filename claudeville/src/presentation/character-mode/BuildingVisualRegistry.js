export const DEFAULT_BUILDING_OCCUPANCY_THRESHOLDS = Object.freeze({
    idleMax: 0,
    occupiedMax: 0.49,
    busyMax: 0.84,
});

export const BUILDING_VISUAL_REGISTRY = Object.freeze({
    command: {
        labelAccent: '#f6c85f',
        emblem: 'crown',
        districtTint: 'rgba(246, 200, 95, 0.24)',
        pulseBand: { color: '#f6c85f', alpha: 0.28 },
        reducedMotionFallback: { pulse: 0.58, alpha: 0.9 },
        occupancyThresholds: { occupiedMax: 0.45, busyMax: 0.8 },
        labelPriority: 'landmark',
        beaconBase: 0.85,
        // 6.2 — sprite-local lit-window spots (calibrated against base.png).
        windowRects: [
            { at: [80, 127], w: 7, h: 10 },
            { at: [210, 120], w: 7, h: 10 },
            { at: [150, 90], w: 8, h: 8, shape: 'ellipse' },
        ],
        // #53 — sprite-local pole base for the occupancy pennant (right turret).
        pennant: { at: [240, 56] },
    },
    taskboard: {
        labelAccent: '#8bd7ff',
        emblem: 'scroll',
        districtTint: 'rgba(139, 215, 255, 0.2)',
        pulseBand: { color: '#8bd7ff', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.52, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 0.8,
        // 6.2 — the two eave lanterns, not mid-wall blobs.
        windowRects: [
            { at: [48, 62], w: 6, h: 8, shape: 'ellipse' },
            { at: [182, 62], w: 6, h: 8, shape: 'ellipse' },
        ],
        pennant: { at: [128, 34] },
    },
    forge: {
        labelAccent: '#f08a4b',
        emblem: 'hammer',
        districtTint: 'rgba(240, 138, 75, 0.24)',
        pulseBand: { color: '#ff9f3f', alpha: 0.3 },
        reducedMotionFallback: { pulse: 0.6, alpha: 0.88 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 1,
        windowRects: [
            { at: [157, 143], w: 9, h: 10 },
            { at: [172, 143], w: 9, h: 10 },
        ],
    },
    mine: {
        labelAccent: '#ffab47',
        emblem: 'pick',
        districtTint: 'rgba(255, 171, 71, 0.22)',
        pulseBand: { color: '#ffab47', alpha: 0.26 },
        reducedMotionFallback: { pulse: 0.54, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.55, busyMax: 0.9 },
        labelPriority: 'landmark',
        beaconBase: 0.78,
    },
    archive: {
        labelAccent: '#b3d68c',
        emblem: 'book',
        districtTint: 'rgba(179, 214, 140, 0.22)',
        pulseBand: { color: '#b3d68c', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.5, alpha: 0.84 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.82 },
        labelPriority: 'landmark',
        beaconBase: 0.82,
        // 6.2 — the two niches flanking the door arch; the crest window above
        // is already baked glowing and needs no warmth stamp.
        windowRects: [
            { at: [139, 130], w: 5, h: 9 },
            { at: [204, 130], w: 5, h: 9 },
        ],
        pennant: { at: [48, 30] },
    },
    observatory: {
        labelAccent: '#bda7ff',
        emblem: 'star',
        districtTint: 'rgba(189, 167, 255, 0.22)',
        pulseBand: { color: '#bda7ff', alpha: 0.26 },
        reducedMotionFallback: { pulse: 0.56, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        beaconBase: 0.7,
        windowRects: [
            { at: [92, 160], w: 9, h: 14 },
            { at: [127, 166], w: 9, h: 14 },
        ],
        pennant: { at: [112, 16] },
        effectAnchors: {
            clockFace: {
                compositeRef: { w: 256, h: 288 },
                center: [96, 108],
                radius: 18,
                sourceSize: 40,
                sourceCenter: 20,
                sourceRadius: 18,
                hourHandLength: 10,
                minuteHandLength: 15,
            },
            // #52 — dome aperture: the small roof dormer under the telescope,
            // opens at night; bursts when a web ritual completes.
            domeAperture: {
                slit: [140, 56],
                star: [140, 50],
                glintArc: { center: [140, 52], radius: 12, from: -2.4, to: -0.7 },
            },
        },
    },
    portal: {
        labelAccent: '#8bd7ff',
        emblem: 'rune',
        districtTint: 'rgba(139, 215, 255, 0.2)',
        pulseBand: { color: '#8feaff', alpha: 0.3 },
        reducedMotionFallback: { pulse: 0.58, alpha: 0.9 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        beaconBase: 0.92,
        pennant: { at: [170, 30] },
    },
    watchtower: {
        labelAccent: '#ffe59a',
        emblem: 'flame',
        districtTint: 'rgba(255, 229, 154, 0.24)',
        pulseBand: { color: '#ffe59a', alpha: 0.28 },
        reducedMotionFallback: { pulse: 0.62, alpha: 0.92 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.9 },
        labelPriority: 'landmark',
        beaconBase: 1,
        // 6.2 — the shaft's three arched windows; lifts the drab daylight
        // watchtower (its warmth used to pool at the lantern fire alone).
        windowRects: [
            { at: [145, 168], w: 9, h: 13 },
            { at: [153, 219], w: 9, h: 13 },
            { at: [140, 270], w: 9, h: 13 },
        ],
        pennant: { at: [166, 80] },
        effectAnchors: {
            lanternFire: {
                flame: [144, 68],
                light: [144, 68],
                particle: [144, 68],
            },
            // #17 — pivot for the rotating distress searchlight beam. Anchored at
            // the lantern fire so the wedge appears to sweep out from the flame.
            searchlight: {
                pivot: [144, 68],
                length: 320,
                width: 58,
            },
        },
    },
    harbor: {
        labelAccent: '#ffd37a',
        emblem: 'anchor',
        districtTint: 'rgba(255, 211, 122, 0.22)',
        pulseBand: { color: '#ffd37a', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.54, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 0.9,
        windowRects: [
            { at: [215, 86], w: 8, h: 10 },
            { at: [233, 86], w: 6, h: 8 },
        ],
    },
});

const WATCHTOWER_LANTERN_FIRE = BUILDING_VISUAL_REGISTRY.watchtower.effectAnchors.lanternFire;

export const BUILDING_EMITTER_FALLBACKS = {
    forge: [
        { type: 'forgeEmber', at: [75, 118], chance: 0.06, count: 1 },
        { type: 'forgeSpark', at: [76, 112], chance: 0.032, count: 1 },
        { type: 'smoke', at: [175, 28], chance: 0.035, count: 1 },
    ],
    mine: [
        { type: 'mineDust', at: [128, 158], chance: 0.035, count: 1 },
        { type: 'mining', at: [138, 165], chance: 0.026, count: 1 },
    ],
    portal: [
        { type: 'portalRune', at: [144, 60], chance: 0.05, count: 1 },
        { type: 'sparkle', at: [122, 80], chance: 0.025, count: 1 },
    ],
    watchtower: [
        { type: 'beaconMote', at: WATCHTOWER_LANTERN_FIRE.particle, chance: 0.038, count: 1 },
    ],
    harbor: [
        { type: 'torch', at: [48, 42], chance: 0.026, count: 1 },
        { type: 'sparkle', at: [70, 58], chance: 0.014, count: 1 },
    ],
    taskboard: [
        { type: 'questPing', at: [128, 90], chance: 0.024, count: 1 },
    ],
    archive: [
        { type: 'archiveMote', at: [168, 82], chance: 0.034, count: 1 },
        { type: 'archiveMote', at: [142, 128], chance: 0.018, count: 1 },
        { type: 'archiveMote', at: [194, 128], chance: 0.018, count: 1 },
    ],
};

export const BUILDING_LIGHT_FALLBACKS = {
    forge: { at: [75, 118], color: '#ff8a33', radius: 80, overlay: 'atmosphere.light.fire-glow' },
    mine: { at: [128, 158], color: '#ffb84d', radius: 80, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [128, 95], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [168, 88], color: '#b3d68c', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [48, 42], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
};

export const LIGHT_SOURCE_REGISTRY = {
    watchtower: [
        {
            kind: 'point',
            at: WATCHTOWER_LANTERN_FIRE.light,
            color: '#ffb347',
            radius: 108,
            overlay: 'atmosphere.light.fire-glow',
        },
    ],
};

export const EMITTER_LIGHTS = {
    torch: { color: '#ffbc62', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    signal: { color: '#ffd37a', radius: 48, overlay: 'atmosphere.light.lantern-glow' },
    forgeEmber: { color: '#ff8a33', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    forgeSpark: { color: '#ff9f3f', radius: 34, overlay: 'atmosphere.light.fire-glow' },
};

export function getBuildingVisual(type) {
    return BUILDING_VISUAL_REGISTRY[type] || null;
}

export function getBuildingLabelAccent(type, fallback = '#d6a951') {
    return getBuildingVisual(type)?.labelAccent || fallback;
}

export function getBuildingLabelEmblem(type, fallback = 'mark') {
    return getBuildingVisual(type)?.emblem || fallback;
}

export function getBuildingLabelPriority(type, fallback = 'normal') {
    return getBuildingVisual(type)?.labelPriority || fallback;
}

export function getBuildingEffectAnchor(type, key, fallback = null) {
    return getBuildingVisual(type)?.effectAnchors?.[key] || fallback;
}

// 6.2 — optional per-building lit-window spots (sprite-local px). Buildings
// without an entry keep the legacy radial warmth blobs.
export function getBuildingWindowRects(type) {
    const rects = getBuildingVisual(type)?.windowRects;
    return Array.isArray(rects) && rects.length ? rects : null;
}

// #53 — optional occupancy-pennant anchor (sprite-local pole base). Only hero
// buildings carry one; absent = no pennant.
export function getBuildingPennantAnchor(type) {
    const pennant = getBuildingVisual(type)?.pennant;
    return Array.isArray(pennant?.at) ? pennant : null;
}

// Per-building responsiveness to the global beacon intensity (0..1). Strong
// emitters (forge/watchtower) react fully; quieter buildings hold back so the
// village dims/brightens in unison without flattening to one brightness.
export function getBuildingBeaconBase(type, fallback = 0.85) {
    const value = getBuildingVisual(type)?.beaconBase;
    return Number.isFinite(value) ? value : fallback;
}

export function getBuildingOccupancyState(type, { count = 0, capacity = 0, alert = false } = {}) {
    if (alert) return 'alert';
    const numericCount = Math.max(0, Number(count) || 0);
    const numericCapacity = Math.max(0, Number(capacity) || 0);
    if (numericCount <= 0 || numericCapacity <= 0) return numericCount > 0 ? 'occupied' : 'idle';
    const ratio = numericCount / numericCapacity;
    const thresholds = {
        ...DEFAULT_BUILDING_OCCUPANCY_THRESHOLDS,
        ...(getBuildingVisual(type)?.occupancyThresholds || {}),
    };
    if (ratio <= thresholds.idleMax) return 'idle';
    if (ratio <= thresholds.occupiedMax) return 'occupied';
    if (ratio <= thresholds.busyMax) return 'busy';
    return 'full';
}
