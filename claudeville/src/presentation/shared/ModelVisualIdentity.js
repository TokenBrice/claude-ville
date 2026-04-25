const DEFAULT_CODEX_IDENTITY = Object.freeze({
    family: 'codex',
    modelClass: 'codex',
    modelTier: null,
    label: 'Codex',
    shortLabel: 'Codex',
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
});

function normalizeModel(model) {
    return String(model || '')
        .toLowerCase()
        .replace(/[._]/g, '-')
        .replace(/\s+/g, '-');
}

export function normalizeReasoningEffort(effort) {
    const normalized = String(effort || '').toLowerCase();
    if (!normalized || normalized === 'none') return normalized ? 'none' : null;
    if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('medium')) return 'medium';
    if (normalized.includes('low')) return 'low';
    return normalized;
}

export function getModelVisualIdentity(model, effort, provider = '') {
    const normalizedModel = normalizeModel(model);
    const normalizedProvider = String(provider || '').toLowerCase();
    const effortTier = normalizeReasoningEffort(effort);

    if (normalizedModel.includes('gpt-5-3-codex-spark')) {
        return {
            family: 'codex',
            modelClass: 'spark',
            modelTier: 'swift',
            label: 'GPT-5.3 Codex Spark',
            shortLabel: '5.3 Spark',
            effortTier,
            trim: ['#f8e36f', '#87f7ff', '#c5ff72'],
            accent: ['#fff6a3', '#55e7ff', '#b8ff5c'],
            minimapColor: '#f8e36f',
        };
    }

    if (normalizedModel.includes('gpt-5-5')) {
        return {
            family: 'codex',
            modelClass: 'gpt55',
            modelTier: 'apex',
            label: 'GPT-5.5',
            shortLabel: '5.5',
            effortTier,
            trim: ['#fff1b8', '#7be3d7', '#f8c45f'],
            accent: ['#ffffff', '#bff7ee', '#ffd98a'],
            minimapColor: '#fff1b8',
        };
    }

    if (normalizedProvider.includes('codex') || normalizedModel.includes('codex') || normalizedModel.includes('gpt')) {
        return {
            ...DEFAULT_CODEX_IDENTITY,
            effortTier,
        };
    }

    return {
        family: null,
        modelClass: 'standard',
        modelTier: null,
        label: String(model || ''),
        shortLabel: String(model || ''),
        effortTier,
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
