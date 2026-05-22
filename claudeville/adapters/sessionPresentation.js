const pricing = require('../src/config/model-pricing.json');

const DEFAULT_TOKEN_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  cacheWrite: 0,
  totalInput: 0,
  totalOutput: 0,
});

const FIELD_ALIASES = Object.freeze({
  input: ['input', 'totalInput', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'total_input_tokens', 'total_input'],
  output: ['output', 'totalOutput', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'total_output_tokens', 'total_output'],
  cacheRead: ['cacheRead', 'cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read'],
  cacheCreate: ['cacheCreate', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cache_create_tokens'],
  totalInput: ['totalInput', 'total_input', 'total_input_tokens', 'input'],
  totalOutput: ['totalOutput', 'total_output', 'total_output_tokens', 'output'],
  cacheWrite: ['cacheWrite', 'cache_write'],
});

const EFFORT_LABELS = Object.freeze({
  none: 'none',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

const DEFAULT_CODEX_IDENTITY = Object.freeze({
  label: 'Codex',
  shortLabel: 'Codex',
  spriteId: 'agent.codex.gpt54',
  color: '#7be3d7',
});

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function coerceTokenField(raw, candidates) {
  for (const candidate of candidates) {
    if (raw[candidate] !== undefined && raw[candidate] !== null) {
      return normalizeNumber(raw[candidate]);
    }
  }
  return 0;
}

function isLikelyNormalized(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return ['input', 'output', 'cacheRead', 'cacheCreate'].every((key) => Number.isFinite(Number(raw[key])));
}

function normalizeTokenUsage(raw = null) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_USAGE };
  if (isLikelyNormalized(raw)) {
    return {
      input: normalizeNumber(raw.input),
      output: normalizeNumber(raw.output),
      cacheRead: normalizeNumber(raw.cacheRead),
      cacheCreate: normalizeNumber(raw.cacheCreate ?? raw.cacheWrite),
      cacheWrite: normalizeNumber(raw.cacheWrite ?? raw.cache_create ?? raw.cacheCreate),
      totalInput: normalizeNumber(raw.totalInput ?? raw.input),
      totalOutput: normalizeNumber(raw.totalOutput ?? raw.output),
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
  };
}

function pricingModelCandidates(model) {
  const normalized = String(model || '')
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/\s+/g, '-');
  const dottedCodex = normalized.replace(/\bgpt-5-(\d)\b/g, 'gpt-5.$1');
  return [...new Set([normalized, dottedCodex])];
}

function rateMatches(candidates, rate) {
  const match = String(rate?.match || '').toLowerCase();
  return !!match && candidates.some((candidate) => candidate.includes(match));
}

function ratesForModel(model, provider) {
  const modelCandidates = pricingModelCandidates(model);
  const normalizedModel = modelCandidates[0] || '';
  const normalizedProvider = String(provider || '').toLowerCase();
  if (normalizedProvider === 'kimi' || modelCandidates.some((candidate) => candidate.includes('kimi'))) {
    return pricing.kimi.rates.find((rate) => rateMatches(modelCandidates, rate)) || pricing.kimi.default;
  }
  if (normalizedProvider === 'deepseek' || modelCandidates.some((candidate) => candidate.includes('deepseek'))) {
    return pricing.deepseek.rates.find((rate) => rateMatches(modelCandidates, rate)) || pricing.deepseek.default;
  }
  const tableKey = normalizedProvider === 'codex' || normalizedModel.includes('gpt') ? 'openai' : 'claude';
  return pricing[tableKey].rates.find((rate) => rateMatches(modelCandidates, rate)) || pricing[tableKey].default;
}

function estimateCost(rawUsage, model, provider) {
  const usage = normalizeTokenUsage(rawUsage);
  const rates = ratesForModel(model, provider);
  return (
    usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * rates.cacheRead +
    usage.cacheCreate * rates.cacheCreate
  ) / 1000000;
}

function normalizeModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/\s+/g, '-');
}

function normalizeReasoningEffort(effort) {
  const normalized = String(effort || '').toLowerCase();
  if (!normalized || normalized === 'none') return normalized ? 'none' : null;
  if (normalized === 'max' || normalized.includes('maximum')) return 'max';
  if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
  if (normalized.includes('high')) return 'high';
  if (normalized.includes('mid') || normalized.includes('medium')) return 'medium';
  if (normalized.includes('low')) return 'low';
  return normalized;
}

function normalizeCodexEffortTier(effortTier) {
  return effortTier === 'max' ? 'xhigh' : effortTier;
}

function codexGpt55Sprite(effortTier) {
  return effortTier === 'high'
    ? 'agent.codex.gpt55.high'
    : effortTier === 'xhigh'
      ? 'agent.codex.gpt55.xhigh'
      : 'agent.codex.gpt55';
}

function modelIdentity(model, effort, provider = '') {
  const normalizedModel = normalizeModel(model);
  const normalizedProvider = String(provider || '').toLowerCase();
  const effortTier = normalizeReasoningEffort(effort);

  if (normalizedModel.includes('opus')) return { shortLabel: 'Opus', effortTier, spriteId: 'agent.claude.opus', color: '#ffe7a8' };
  if (normalizedModel.includes('haiku')) return { shortLabel: 'Haiku', effortTier, spriteId: 'agent.claude.haiku', color: '#ffd47a' };
  if (normalizedModel.includes('sonnet') || normalizedProvider.includes('claude')) {
    return { shortLabel: normalizedModel.includes('sonnet') ? 'Sonnet' : 'Claude', effortTier, spriteId: 'agent.claude.sonnet', color: '#f2d36b' };
  }
  if (normalizedModel.includes('gpt-5-3-codex-spark')) {
    return { shortLabel: '5.3 Spark', effortTier: normalizeCodexEffortTier(effortTier), spriteId: 'agent.codex.gpt53spark', color: '#f8e36f' };
  }
  if (normalizedModel.includes('gpt-5-3-codex')) {
    return { shortLabel: '5.3', effortTier: normalizeCodexEffortTier(effortTier), spriteId: 'agent.codex.gpt53spark', color: '#f8e36f' };
  }
  if (normalizedModel.includes('gpt-5-5')) {
    const codexEffort = normalizeCodexEffortTier(effortTier);
    return { shortLabel: '5.5', effortTier: codexEffort, spriteId: codexGpt55Sprite(codexEffort), color: '#fff1b8' };
  }
  if (normalizedModel.includes('gpt-5-4') || normalizedModel.includes('gpt-5.4')) {
    return { shortLabel: '5.4', effortTier: normalizeCodexEffortTier(effortTier), spriteId: 'agent.codex.gpt54', color: '#8bd6ff' };
  }
  if (normalizedProvider.includes('codex') || normalizedModel.includes('codex') || normalizedModel.includes('gpt')) {
    return { ...DEFAULT_CODEX_IDENTITY, effortTier: normalizeCodexEffortTier(effortTier) };
  }
  if (normalizedProvider.includes('kimi') || normalizedModel.includes('kimi')) {
    return { shortLabel: 'Kimi', effortTier, spriteId: 'agent.kimi.base', color: '#ff8da8' };
  }
  if (normalizedProvider.includes('deepseek') || normalizedModel.includes('deepseek')) {
    const isPro = normalizedModel.includes('v4-pro');
    const isFlash = normalizedModel.includes('v4-flash');
    const isReasoner = normalizedModel.includes('reasoner');
    return {
      shortLabel: isPro ? 'DS V4 Pro' : isFlash ? 'DS Flash' : isReasoner ? 'DS Reasoner' : 'DeepSeek',
      effortTier,
      spriteId: 'agent.gemini.base',
      color: isPro ? '#9ee7ff' : '#7cf4c8',
    };
  }
  if (normalizedProvider.includes('gemini') || normalizedModel.includes('gemini')) {
    return { shortLabel: 'Gemini', effortTier, spriteId: 'agent.gemini.base', color: '#9ad7ff' };
  }
  return {
    shortLabel: String(model || ''),
    effortTier,
    spriteId: null,
    color: '#64748b',
  };
}

function formatModelLabel(model, effort, provider = '') {
  const identity = modelIdentity(model, effort, provider);
  let label = identity.shortLabel || String(model || '?');
  if (identity.effortTier && identity.effortTier !== 'none') {
    label += ` ${EFFORT_LABELS[identity.effortTier] || identity.effortTier}`;
  }
  return label
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace('-20250929', '')
    .replace('-20251001', '');
}

function decorateSessionPresentation(session) {
  const identity = modelIdentity(session.model, session.reasoningEffort || session.effort, session.provider);
  const explicitCost = Number(session.estimatedCost);
  return {
    ...session,
    estimatedCost: Number.isFinite(explicitCost) && explicitCost >= 0
      ? explicitCost
      : estimateCost(session.tokenUsage ?? session.tokens ?? session.usage, session.model, session.provider),
    displayModel: session.displayModel || formatModelLabel(session.model, session.reasoningEffort || session.effort, session.provider),
    modelColor: session.modelColor || identity.color,
    spriteId: session.spriteId || identity.spriteId,
  };
}

module.exports = {
  decorateSessionPresentation,
  estimateCost,
  formatModelLabel,
  modelIdentity,
  normalizeTokenUsage,
  ratesForModel,
};
