const DEFAULT_TOKEN_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cacheWrite: 0,
    totalInput: 0,
    totalOutput: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
};

const CLAUDE_RATES = [
    { match: 'opus', input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
    { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
    { match: 'haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
];

const OPEN_AI_RATES = [
    { match: 'gpt-5.5', input: 15, output: 120, cacheRead: 1.5, cacheCreate: 0 },
    { match: 'gpt-5.4', input: 10, output: 80, cacheRead: 1, cacheCreate: 0 },
    { match: 'gpt-5.3', input: 5, output: 40, cacheRead: 0.5, cacheCreate: 0 },
    { match: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 },
];

const KIMI_RATES = [
    { match: 'kimi-for-coding', input: 3, output: 12, cacheRead: 0.3, cacheCreate: 0 },
];

const DEEPSEEK_RATES = [
    { match: 'deepseek-v4-pro', input: 1.74, output: 3.48, cacheRead: 0.145, cacheCreate: 0 },
    { match: 'v4-pro', input: 1.74, output: 3.48, cacheRead: 0.145, cacheCreate: 0 },
    { match: 'deepseek-v4-flash', input: 0.14, output: 0.28, cacheRead: 0.028, cacheCreate: 0 },
    { match: 'v4-flash', input: 0.14, output: 0.28, cacheRead: 0.028, cacheCreate: 0 },
    { match: 'deepseek-reasoner', input: 0.14, output: 0.28, cacheRead: 0.028, cacheCreate: 0 },
    { match: 'reasoner', input: 0.14, output: 0.28, cacheRead: 0.028, cacheCreate: 0 },
];

// xAI public API rates (USD per 1M tokens). Cached input is priced when known.
const GROK_RATES = [
    { match: 'grok-4.5', input: 2, output: 6, cacheRead: 0.5, cacheCreate: 0 },
    { match: 'grok-4-5', input: 2, output: 6, cacheRead: 0.5, cacheCreate: 0 },
    { match: 'composer', input: 0.2, output: 0.5, cacheRead: 0.05, cacheCreate: 0 },
    { match: 'grok-4.3', input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreate: 0 },
    { match: 'grok-4-3', input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreate: 0 },
    { match: 'grok-4', input: 3, output: 15, cacheRead: 0.75, cacheCreate: 0 },
];

const DEFAULT_CLAUDE_RATES = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };
const DEFAULT_OPEN_AI_RATES = { input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 };
const DEFAULT_KIMI_RATES = { input: 3, output: 12, cacheRead: 0.3, cacheCreate: 0 };
const DEFAULT_DEEPSEEK_RATES = { input: 0.14, output: 0.28, cacheRead: 0.028, cacheCreate: 0 };
const DEFAULT_GROK_RATES = { input: 2, output: 6, cacheRead: 0.5, cacheCreate: 0 };

const FIELD_ALIASES = {
    input: ['input', 'totalInput', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'total_input_tokens', 'total_input'],
    output: ['output', 'totalOutput', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'total_output_tokens', 'total_output'],
    cacheRead: ['cacheRead', 'cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read'],
    cacheCreate: ['cacheCreate', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cache_create_tokens'],
    totalInput: ['totalInput', 'total_input', 'total_input_tokens', 'input'],
    totalOutput: ['totalOutput', 'total_output', 'total_output_tokens', 'output'],
    contextWindow: ['contextWindow', 'contextWindowTokens', 'context_window', 'context_window_tokens'],
    contextWindowMax: ['contextWindowMax', 'contextWindowLimit', 'context_window_max', 'context_window_limit', 'context_max'],
    turnCount: ['turnCount', 'turn_count', 'numTurns'],
    cacheWrite: ['cacheWrite', 'cache_write'],
};

const normalizeNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const coerceTokenField = (raw, candidates) => {
    for (const candidate of candidates) {
        if (raw[candidate] !== undefined && raw[candidate] !== null) {
            return normalizeNumber(raw[candidate]);
        }
    }
    return 0;
};

const isLikelyNormalized = (raw) => {
    if (!raw || typeof raw !== 'object') return false;
    return ['input', 'output', 'cacheRead', 'cacheCreate'].every((key) => Number.isFinite(Number(raw[key])));
};

const pricingModelCandidates = (model) => {
    const normalized = String(model || '')
        .toLowerCase()
        .replace(/[._]/g, '-')
        .replace(/\s+/g, '-');
    const dottedCodex = normalized.replace(/\bgpt-5-(\d)\b/g, 'gpt-5.$1');
    return [...new Set([normalized, dottedCodex])];
};

const rateMatches = (candidates, rate) => {
    const match = String(rate?.match || '').toLowerCase();
    return !!match && candidates.some((candidate) => candidate.includes(match));
};

export class TokenUsage {
    constructor(raw = null) {
        Object.assign(this, TokenUsage.normalize(raw));
    }

    static normalize(raw = null) {
        if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_USAGE };
        if (raw instanceof TokenUsage) {
            return { ...raw };
        }
        if (isLikelyNormalized(raw)) {
            return {
                input: normalizeNumber(raw.input),
                output: normalizeNumber(raw.output),
                cacheRead: normalizeNumber(raw.cacheRead),
                cacheCreate: normalizeNumber(raw.cacheCreate ?? raw.cacheWrite),
                totalInput: normalizeNumber(raw.totalInput ?? raw.input),
                totalOutput: normalizeNumber(raw.totalOutput ?? raw.output),
                contextWindow: normalizeNumber(raw.contextWindow ?? raw.contextWindowTokens ?? raw.context_window ?? raw.context_window_tokens),
                contextWindowMax: normalizeNumber(raw.contextWindowMax ?? raw.contextWindowLimit ?? raw.context_window_max ?? raw.context_window_limit ?? raw.context_max),
                turnCount: normalizeNumber(raw.turnCount ?? raw.turn_count ?? raw.numTurns),
                cacheWrite: normalizeNumber(raw.cacheWrite ?? raw.cache_create ?? raw.cacheCreate),
            };
        }

        const input = coerceTokenField(raw, FIELD_ALIASES.input);
        const output = coerceTokenField(raw, FIELD_ALIASES.output);
        const cacheRead = coerceTokenField(raw, FIELD_ALIASES.cacheRead);
        const cacheCreate = coerceTokenField(raw, FIELD_ALIASES.cacheCreate);

        return {
            input,
            output,
            cacheRead,
            cacheCreate,
            cacheWrite: coerceTokenField(raw, FIELD_ALIASES.cacheWrite) || cacheCreate,
            totalInput: coerceTokenField(raw, FIELD_ALIASES.totalInput) || input,
            totalOutput: coerceTokenField(raw, FIELD_ALIASES.totalOutput) || output,
            contextWindow: coerceTokenField(raw, FIELD_ALIASES.contextWindow),
            contextWindowMax: coerceTokenField(raw, FIELD_ALIASES.contextWindowMax),
            turnCount: coerceTokenField(raw, FIELD_ALIASES.turnCount),
        };
    }

    static totalTokens(rawUsage) {
        const usage = rawUsage instanceof TokenUsage ? rawUsage : TokenUsage.normalize(rawUsage);
        return usage.totalInput + usage.totalOutput + usage.cacheRead + usage.cacheCreate;
    }

    static pricingForModel(model, provider) {
        const modelCandidates = pricingModelCandidates(model);
        const normalizedModel = modelCandidates[0] || '';
        const normalizedProvider = String(provider || '').toLowerCase();
        if (normalizedProvider === 'kimi' || modelCandidates.some((candidate) => candidate.includes('kimi'))) {
            return KIMI_RATES.find((rate) => rateMatches(modelCandidates, rate)) || DEFAULT_KIMI_RATES;
        }
        if (normalizedProvider === 'deepseek' || modelCandidates.some((candidate) => candidate.includes('deepseek'))) {
            return DEEPSEEK_RATES.find((rate) => rateMatches(modelCandidates, rate)) || DEFAULT_DEEPSEEK_RATES;
        }
        if (normalizedProvider === 'grok' || modelCandidates.some((candidate) => candidate.includes('grok'))) {
            return GROK_RATES.find((rate) => rateMatches(modelCandidates, rate)) || DEFAULT_GROK_RATES;
        }
        const table = (normalizedProvider === 'codex' || normalizedModel.includes('gpt'))
            ? OPEN_AI_RATES
            : CLAUDE_RATES;

        return table.find((rate) => rateMatches(modelCandidates, rate)) ||
            (table === OPEN_AI_RATES ? DEFAULT_OPEN_AI_RATES : DEFAULT_CLAUDE_RATES);
    }

    static estimateCost(rawUsage, model, provider) {
        const usage = rawUsage instanceof TokenUsage ? rawUsage : TokenUsage.normalize(rawUsage);
        const rates = TokenUsage.pricingForModel(model, provider);
        return (
            usage.input * rates.input +
            usage.output * rates.output +
            usage.cacheRead * rates.cacheRead +
            usage.cacheCreate * rates.cacheCreate
        ) / 1000000;
    }
}
