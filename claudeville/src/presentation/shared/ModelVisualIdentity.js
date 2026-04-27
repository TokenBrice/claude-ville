const DEFAULT_CODEX_IDENTITY = Object.freeze({
    family: 'codex',
    modelClass: 'codex',
    modelTier: null,
    label: 'Codex',
    shortLabel: 'Codex',
    spriteId: 'agent.codex.gpt54',
    paletteKey: 'codex',
    trim: ['#7be3d7', '#55c7f0', '#8ee88e'],
    accent: ['#bff7ee', '#6ee7d8', '#5ad6ff'],
    minimapColor: '#7be3d7',
});

const EFFORT_LABELS = Object.freeze({
    none: 'none',
    low: 'low',
    medium: 'med',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
});

// Head overlays (anchored above hat). Only the apex tiers — low/med/high
// moved to floor rings to avoid stacking conflicts with tall headgear.
const EFFORT_ACCESSORIES = Object.freeze({
    xhigh: 'effortXhigh',
    max: 'effortMax',
});

// Floor rings (anchored at feet). Used for low/medium/high reasoning tiers.
// Overlay IDs map to overlay.status.effortLow / effortMedium / effortHigh.
const EFFORT_FLOOR_RINGS = Object.freeze({
    low: 'overlay.status.effortLow',
    medium: 'overlay.status.effortMedium',
    high: 'overlay.status.effortHigh',
});

const CODEX_EQUIPMENT_BY_CLASS = Object.freeze({
    codex: 'wrench',
    spark: 'multitool',
    gpt54: 'wrench',
    gpt55: 'sword',
});

const CODEX_GPT55_EQUIPMENT_BY_EFFORT = Object.freeze({
    none: 'sword',
    low: 'sword',
    medium: 'sword',
    high: 'greatsword',
    xhigh: 'warlord',
});

const DEFAULT_EFFORT_RENDERING = Object.freeze({
    effortBakedIntoSprite: false,
    showDashboardEffortCrest: true,
    allowRuntimeEffortAccessory: true,
    allowRuntimeEffortFloorRing: true,
    allowRuntimeEffortWeapon: true,
});

function codexEquipment(effortTier, modelClass) {
    const equipment = modelClass === 'gpt55'
        ? CODEX_GPT55_EQUIPMENT_BY_EFFORT[effortTier || 'none'] || CODEX_EQUIPMENT_BY_CLASS.gpt55
        : CODEX_EQUIPMENT_BY_CLASS[modelClass] || null;
    return {
        effortAccessory: EFFORT_ACCESSORIES[effortTier] || null,
        effortFloorRing: EFFORT_FLOOR_RINGS[effortTier] || null,
        equipment,
        effortWeapon: equipment,
        suppressBakedWeapon: true,
    };
}

function normalizeCodexEffortTier(effortTier) {
    return effortTier === 'max' ? 'xhigh' : effortTier;
}

function normalizeModel(model) {
    return String(model || '')
        .toLowerCase()
        .replace(/[._]/g, '-')
        .replace(/\s+/g, '-');
}

export function normalizeReasoningEffort(effort) {
    const normalized = String(effort || '').toLowerCase();
    if (!normalized || normalized === 'none') return normalized ? 'none' : null;
    if (normalized === 'max' || normalized.includes('maximum')) return 'max';
    if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('mid')) return 'medium';
    if (normalized.includes('medium')) return 'medium';
    if (normalized.includes('low')) return 'low';
    return normalized;
}

export function getModelVisualIdentity(model, effort, provider = '') {
    const normalizedModel = normalizeModel(model);
    const normalizedProvider = String(provider || '').toLowerCase();
    const effortTier = normalizeReasoningEffort(effort);
    const effortAccessory = EFFORT_ACCESSORIES[effortTier] || null;
    const effortFloorRing = EFFORT_FLOOR_RINGS[effortTier] || null;

    if (normalizedModel.includes('opus')) {
        return {
            family: 'claude',
            modelClass: 'opus',
            modelTier: 'apex',
            label: 'Claude Opus',
            shortLabel: 'Opus',
            effortTier,
            ...DEFAULT_EFFORT_RENDERING,
            effortAccessory,
            effortFloorRing,
            spriteId: 'agent.claude.opus',
            paletteKey: 'claude',
            trim: ['#ffe7a8', '#c8a3ff', '#f4b15f'],
            accent: ['#fff4cf', '#d8bcff', '#ffca7a'],
            minimapColor: '#ffe7a8',
        };
    }

    if (normalizedModel.includes('haiku')) {
        return {
            family: 'claude',
            modelClass: 'haiku',
            modelTier: 'light',
            label: 'Claude Haiku',
            shortLabel: 'Haiku',
            effortTier,
            ...DEFAULT_EFFORT_RENDERING,
            effortAccessory,
            effortFloorRing,
            spriteId: 'agent.claude.haiku',
            paletteKey: 'claude',
            trim: ['#ffd47a', '#ffe39a', '#f6c25c'],
            accent: ['#fff1c2', '#ffe39a', '#ffcc7a'],
            minimapColor: '#ffd47a',
        };
    }

    if (normalizedModel.includes('sonnet') || normalizedProvider.includes('claude')) {
        return {
            family: 'claude',
            modelClass: 'sonnet',
            modelTier: 'balanced',
            label: 'Claude Sonnet',
            shortLabel: normalizedModel.includes('sonnet') ? 'Sonnet' : 'Claude',
            effortTier,
            ...DEFAULT_EFFORT_RENDERING,
            effortAccessory,
            effortFloorRing,
            spriteId: 'agent.claude.sonnet',
            paletteKey: 'claude',
            trim: ['#f2d36b', '#b7ccff', '#e9b85f'],
            accent: ['#ffe39a', '#dfe8ff', '#f7bf6d'],
            minimapColor: '#f2d36b',
        };
    }

    if (normalizedModel.includes('gpt-5-3-codex-spark')) {
        const modelClass = 'spark';
        const codexEffortTier = normalizeCodexEffortTier(effortTier);
        const equipment = codexEquipment(codexEffortTier, modelClass);
        return {
            family: 'codex',
            modelClass,
            modelTier: 'swift',
            label: 'GPT-5.3 Codex Spark',
            shortLabel: '5.3 Spark',
            effortTier: codexEffortTier,
            ...DEFAULT_EFFORT_RENDERING,
            ...equipment,
            spriteId: 'agent.codex.gpt53spark',
            paletteKey: 'codex',
            trim: ['#f8e36f', '#87f7ff', '#c5ff72'],
            accent: ['#fff6a3', '#55e7ff', '#b8ff5c'],
            minimapColor: '#f8e36f',
        };
    }

    if (normalizedModel.includes('gpt-5-5')) {
        const modelClass = 'gpt55';
        const codexEffortTier = normalizeCodexEffortTier(effortTier);
        const equipment = codexEquipment(codexEffortTier, modelClass);
        return {
            family: 'codex',
            modelClass,
            modelTier: 'apex',
            label: 'GPT-5.5',
            shortLabel: '5.5',
            effortTier: codexEffortTier,
            ...DEFAULT_EFFORT_RENDERING,
            ...equipment,
            spriteId: 'agent.codex.gpt55',
            paletteKey: 'codex',
            trim: ['#fff1b8', '#7be3d7', '#f8c45f'],
            accent: ['#ffffff', '#bff7ee', '#ffd98a'],
            minimapColor: '#fff1b8',
        };
    }

    if (normalizedModel.includes('gpt-5-4') || normalizedModel.includes('gpt-5.4')) {
        const modelClass = 'gpt54';
        const codexEffortTier = normalizeCodexEffortTier(effortTier);
        const equipment = codexEquipment(codexEffortTier, modelClass);
        return {
            family: 'codex',
            modelClass,
            modelTier: 'senior',
            label: 'GPT-5.4',
            shortLabel: '5.4',
            effortTier: codexEffortTier,
            ...DEFAULT_EFFORT_RENDERING,
            ...equipment,
            spriteId: 'agent.codex.gpt54',
            paletteKey: 'codex',
            trim: ['#8bd6ff', '#7be3d7', '#a9b7ff'],
            accent: ['#d5f4ff', '#95f0df', '#d3dcff'],
            minimapColor: '#8bd6ff',
        };
    }

    if (normalizedProvider.includes('codex') || normalizedModel.includes('codex') || normalizedModel.includes('gpt')) {
        const codexEffortTier = normalizeCodexEffortTier(effortTier);
        const equipment = codexEquipment(codexEffortTier, DEFAULT_CODEX_IDENTITY.modelClass);
        return {
            ...DEFAULT_CODEX_IDENTITY,
            effortTier: codexEffortTier,
            ...DEFAULT_EFFORT_RENDERING,
            ...equipment,
        };
    }

    return {
        family: null,
        modelClass: 'standard',
        modelTier: null,
        label: String(model || ''),
        shortLabel: String(model || ''),
        effortTier,
        ...DEFAULT_EFFORT_RENDERING,
        effortAccessory,
        effortFloorRing,
        spriteId: null,
        paletteKey: null,
        trim: null,
        accent: null,
        minimapColor: null,
    };
}

export function formatModelLabel(model, effort, provider = '') {
    const identity = getModelVisualIdentity(model, effort, provider);
    let label = identity.shortLabel || String(model || '?');
    const effortTier = identity.effortTier;
    if (effortTier && effortTier !== 'none') {
        label += ` ${EFFORT_LABELS[effortTier] || effortTier}`;
    }
    return label
        .replace('claude-', '')
        .replace(/-\d{8}$/, '')
        .replace('-20250929', '')
        .replace('-20251001', '');
}
