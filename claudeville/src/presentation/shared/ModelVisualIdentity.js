import {
    MODEL_DEFAULTS,
    contextWindowForModel,
    findModelRow,
    normalizeModel,
} from '../../config/models.generated.js';

const DEFAULT_CODEX_IDENTITY = Object.freeze({
    family: 'codex',
    modelClass: MODEL_DEFAULTS.codex.modelClass,
    modelTier: MODEL_DEFAULTS.codex.modelTier,
    label: MODEL_DEFAULTS.codex.label,
    shortLabel: MODEL_DEFAULTS.codex.shortLabel,
    spriteId: MODEL_DEFAULTS.codex.spriteId,
    paletteKey: MODEL_DEFAULTS.codex.paletteKey,
    trim: MODEL_DEFAULTS.codex.trim,
    accent: MODEL_DEFAULTS.codex.accent,
    minimapColor: MODEL_DEFAULTS.codex.color,
});

const EFFORT_LABELS = Object.freeze({
    none: 'none',
    low: 'low',
    medium: 'med',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
    ultra: 'ultra',
});

// Head overlays (anchored above hat). Only the apex tiers — low/med/high
// moved to floor rings to avoid stacking conflicts with tall headgear.
const EFFORT_ACCESSORIES = Object.freeze({
    xhigh: 'effortXhigh',
    max: 'effortMax',
    ultra: 'effortUltra',
});

// Floor rings (anchored at feet). Used for low/medium/high reasoning tiers.
// Overlay IDs map to overlay.status.effortLow / effortMedium / effortHigh.
const EFFORT_FLOOR_RINGS = Object.freeze({
    low: 'overlay.status.effortLow',
    medium: 'overlay.status.effortMedium',
    high: 'overlay.status.effortHigh',
});

const CODEX_EQUIPMENT_BY_CLASS = Object.freeze({
    codex: 'engineerWrench',
    spark: 'multitool',
    gpt54: 'engineerWrench',
    gpt55: 'runeblade',
    gpt56sol: 'dawnblade',
    gpt56terra: 'earthbreaker',
    gpt56luna: 'crescentSaber',
    gpt6astra: 'crescentSaber',
});

const CODEX_ASTRA_EQUIPMENT_BY_EFFORT = Object.freeze({
    none: 'crescentSaber',
    low: 'crescentSaber',
    medium: 'runeblade',
    high: 'dawnblade',
    xhigh: 'polearm',
    max: 'polearm',
    ultra: 'polearm',
});

const CODEX_GPT55_EQUIPMENT_BY_EFFORT = Object.freeze({
    none: 'runeblade',
    low: 'runeblade',
    medium: 'runeblade',
    high: 'greatsword',
    xhigh: 'polearm',
});
const CODEX_GPT55_SPRITE_BY_EFFORT = Object.freeze({
    high: 'agent.codex.gpt55.high',
    xhigh: 'agent.codex.gpt55.xhigh',
});

const DEFAULT_EFFORT_RENDERING = Object.freeze({
    effortBakedIntoSprite: false,
    showDashboardEffortCrest: true,
    allowRuntimeEffortAccessory: true,
    allowRuntimeEffortFloorRing: true,
    allowRuntimeEffortWeapon: true,
});

const PROVIDER_BASE_SPRITES = Object.freeze(Object.fromEntries(
    Object.entries(MODEL_DEFAULTS).map(([provider, identity]) => [provider, identity.spriteId]),
));

// Sprite ids selected by rendering policy rather than by a registry row:
// the per-provider `agent.<provider>.base` fallback (AgentSprite composes
// `agent.${provider}.base` when an identity has no spriteId) and the GPT-5.5
// effort variants. The registry completeness test accepts these alongside
// registry rows and provider defaults.
export const POLICY_SPRITE_IDS = Object.freeze([
    ...Object.keys(MODEL_DEFAULTS).map((provider) => `agent.${provider}.base`),
    ...Object.values(CODEX_GPT55_SPRITE_BY_EFFORT),
]);

function codexEquipment(effortTier, modelClass, { suppressBakedWeapon = true } = {}) {
    const equipment = modelClass === 'gpt6astra'
        ? CODEX_ASTRA_EQUIPMENT_BY_EFFORT[effortTier || 'none'] || CODEX_EQUIPMENT_BY_CLASS.gpt6astra
        : modelClass === 'gpt55'
        ? CODEX_GPT55_EQUIPMENT_BY_EFFORT[effortTier || 'none'] || CODEX_EQUIPMENT_BY_CLASS.gpt55
        : CODEX_EQUIPMENT_BY_CLASS[modelClass] || null;
    return {
        effortAccessory: EFFORT_ACCESSORIES[effortTier] || null,
        effortFloorRing: EFFORT_FLOOR_RINGS[effortTier] || null,
        equipment,
        effortWeapon: equipment,
        suppressBakedWeapon,
    };
}

function codexGpt55Sprite(effortTier) {
    return CODEX_GPT55_SPRITE_BY_EFFORT[effortTier] || 'agent.codex.gpt55';
}

function normalizeCodexEffortTier(effortTier) {
    return effortTier === 'max' ? 'xhigh' : effortTier;
}

// Canonical provider key for palette/hue lookups, shared by the world sprite
// (AgentSprite delegates here) and the dashboard avatar (which keys its
// shared-Compositor requests with it, plan 1.7).
export function providerPaletteKey(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    const model = String(agent?.model || '').toLowerCase();
    if (model.includes('deepseek')) return 'deepseek';
    if (model.includes('glm') || provider.includes('zai') || provider.includes('zhipu')) return 'zai';
    if (provider.includes('opencode')) return 'opencode';
    if (provider.includes('gemini') || model.includes('gemini')) return 'gemini';
    if (provider.includes('codex') || model.includes('codex') || model.includes('gpt')) return 'codex';
    if (provider.includes('claude') || model.includes('claude')) return 'claude';
    if (provider.includes('kimi') || model.includes('kimi')) return 'kimi';
    if (provider.includes('grok') || model.includes('grok')) return 'grok';
    return 'default';
}

function inferredRegistryProvider(model, provider = '') {
    const normalizedModel = normalizeModel(model);
    if (normalizedModel.includes('deepseek')) return 'deepseek';
    if (normalizedModel.includes('glm')) return 'zai';
    if (normalizedModel.includes('gemini')) return 'gemini';
    if (normalizedModel.includes('codex') || normalizedModel.includes('gpt')) return 'codex';
    if (normalizedModel.includes('claude')) return 'claude';
    if (normalizedModel.includes('kimi')) return 'kimi';
    if (normalizedModel.includes('grok')) return 'grok';
    const normalizedProvider = String(provider || '').toLowerCase();
    if (normalizedProvider.includes('deepseek')) return 'deepseek';
    if (normalizedProvider.includes('zai') || normalizedProvider.includes('zhipu')) return 'zai';
    if (normalizedProvider.includes('gemini')) return 'gemini';
    if (normalizedProvider.includes('codex') || normalizedProvider.includes('openai')) return 'codex';
    if (normalizedProvider.includes('claude')) return 'claude';
    if (normalizedProvider.includes('kimi')) return 'kimi';
    if (normalizedProvider.includes('grok')) return 'grok';
    return normalizedProvider;
}

function selectModelRow(model, provider = '') {
    const direct = findModelRow(model, provider);
    if (!direct.isDefault) return direct;

    const modelMatch = findModelRow(model);
    if (!modelMatch.isDefault) return modelMatch;

    const inferredProvider = inferredRegistryProvider(model, provider);
    if (inferredProvider && inferredProvider !== String(provider || '').toLowerCase()) {
        const inferred = findModelRow(model, inferredProvider);
        if (inferred.row) return inferred;
    }
    return direct;
}

export function providerBaseSpriteId(model, provider = '') {
    const { row } = selectModelRow(model, provider);
    if (row?.spriteId) return row.spriteId;
    const paletteKey = providerPaletteKey({ model, provider });
    return PROVIDER_BASE_SPRITES[paletteKey] || null;
}

export function normalizeReasoningEffort(effort) {
    const normalized = String(effort || '').toLowerCase();
    if (!normalized || normalized === 'none') return normalized ? 'none' : null;
    if (normalized.includes('ultra')) return 'ultra';
    if (normalized === 'max' || normalized.includes('maximum')) return 'max';
    if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('mid')) return 'medium';
    if (normalized.includes('medium')) return 'medium';
    if (normalized.includes('low')) return 'low';
    return normalized;
}

export function contextWindowLimitForModel(model, provider = '') {
    return contextWindowForModel(model, provider) ?? 200000;
}

export function getModelVisualIdentity(model, effort, provider = '') {
    const { row, isDefault } = selectModelRow(model, provider);
    const effortTier = normalizeReasoningEffort(effort);
    const effortAccessory = EFFORT_ACCESSORIES[effortTier] || null;
    const effortFloorRing = EFFORT_FLOOR_RINGS[effortTier] || null;

    if (!row) {
        const paletteKey = providerPaletteKey({ model, provider });
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
            spriteId: PROVIDER_BASE_SPRITES[paletteKey] || null,
            paletteKey: paletteKey === 'default' ? null : paletteKey,
            trim: null,
            accent: null,
            minimapColor: null,
        };
    }

    const baseIdentity = row === MODEL_DEFAULTS.codex
        ? DEFAULT_CODEX_IDENTITY
        : {
            family: isDefault ? row.paletteKey : row.provider,
            modelClass: row.modelClass,
            modelTier: row.modelTier,
            label: row.label,
            shortLabel: row.shortLabel,
            spriteId: row.spriteId,
            paletteKey: row.paletteKey,
            trim: row.trim,
            accent: row.accent,
            minimapColor: row.color,
        };

    if (row.paletteKey !== 'codex') {
        return {
            ...baseIdentity,
            effortTier,
            ...DEFAULT_EFFORT_RENDERING,
            effortAccessory,
            effortFloorRing,
        };
    }

    const isCelestial = row.modelClass === 'gpt6astra'
        || row.modelClass === 'gpt56sol'
        || row.modelClass === 'gpt56terra'
        || row.modelClass === 'gpt56luna';
    const codexEffortTier = isCelestial ? effortTier : normalizeCodexEffortTier(effortTier);
    const equipment = codexEquipment(
        codexEffortTier,
        row.modelClass,
        { suppressBakedWeapon: !isCelestial },
    );
    const identity = {
        ...baseIdentity,
        effortTier: codexEffortTier,
        ...DEFAULT_EFFORT_RENDERING,
        ...equipment,
        spriteId: row.modelClass === 'gpt55'
            ? codexGpt55Sprite(codexEffortTier)
            : row.spriteId,
    };
    if (row.modelClass === 'gpt55') {
        identity.codexHeavyGearBaked = codexEffortTier === 'high' || codexEffortTier === 'xhigh';
    }
    if (row.modelClass === 'gpt6astra') identity.codexHeavyGearBaked = true;
    return identity;
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
