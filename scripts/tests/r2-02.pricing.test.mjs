import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import pricing from '../../claudeville/src/config/model-pricing.json' with { type: 'json' };
import { TokenUsage } from '../../claudeville/src/domain/value-objects/TokenUsage.js';

const require = createRequire(import.meta.url);
const { ratesForModel } = require('../../claudeville/adapters/sessionPresentation.js');

// These are the model strings emitted by the seven adapter fixture families.
// Keep the provider alongside the raw string: provider-only routing is part of
// the pricing lookup contract, while model-only routing handles OpenCode/OMP.
const ADAPTER_FIXTURE_MODELS = [
  { adapter: 'Claude', provider: 'claude', model: 'claude-sonnet-4-5', table: 'claude' },
  { adapter: 'Codex', provider: 'codex', model: 'gpt-5', table: 'openai' },
  { adapter: 'Gemini', provider: 'gemini', model: 'gemini-2.5-flash', table: 'gemini' },
  { adapter: 'Grok', provider: 'grok', model: 'grok-4.5', table: 'grok' },
  { adapter: 'Kimi', provider: 'kimi', model: 'kimi-code/kimi-for-coding', table: 'kimi' },
  { adapter: 'OpenCode', provider: 'opencode', model: 'deepseek/deepseek-v4-pro', table: 'deepseek' },
  { adapter: 'OMP', provider: 'omp', model: 'openai-codex/gpt-5.6-luna', table: 'openai' },
];

test('every adapter fixture model selects a concrete server pricing rate', () => {
  for (const fixture of ADAPTER_FIXTURE_MODELS) {
    const table = pricing[fixture.table];
    const selected = ratesForModel(fixture.model, fixture.provider);

    assert.ok(
      table.rates.includes(selected),
      `${fixture.adapter} fixture model "${fixture.model}" resolved the default pricing rate`,
    );
  }
});

test('server and browser pricing tables select identical rates', () => {
  const providerForBrowser = {
    claude: 'claude',
    openai: 'codex',
    kimi: 'kimi',
    deepseek: 'deepseek',
    grok: 'grok',
    gemini: 'gemini',
  };

  for (const [tableName, table] of Object.entries(pricing)) {
    const provider = providerForBrowser[tableName];
    assert.ok(provider, `missing browser provider mapping for ${tableName}`);

    const numericRate = (rate) => ({
      input: rate.input,
      output: rate.output,
      cacheRead: rate.cacheRead,
      cacheCreate: rate.cacheCreate,
    });
    const normalizeMatch = (match) => String(match || '').toLowerCase().replace(/[._]/g, '-');
    const compare = (label, serverRate, browserRate, { expectMatch = true } = {}) => {
      assert.deepEqual(
        numericRate(browserRate),
        numericRate(serverRate),
        `${tableName}.${label} numeric prices differ between model-pricing.json and TokenUsage.js`,
      );
      if (expectMatch) {
        assert.equal(
          normalizeMatch(browserRate.match),
          normalizeMatch(serverRate.match),
          `${tableName}.${label} model matcher differs between model-pricing.json and TokenUsage.js`,
        );
      }
    };

    compare(
      'default',
      table.default,
      TokenUsage.pricingForModel(`__r2_02_unknown_${tableName}__`, provider),
      { expectMatch: false },
    );

    for (const rate of table.rates) {
      compare(rate.match, rate, TokenUsage.pricingForModel(rate.match, provider));
    }
  }
});
