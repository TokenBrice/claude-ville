#!/usr/bin/env node

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ratesForModel } = require('../../claudeville/adapters/sessionPresentation');

const repoRoot = join(__dirname, '..', '..');
const pricing = JSON.parse(readFileSync(join(repoRoot, 'claudeville/src/config/model-pricing.json'), 'utf8'));
const browserPricingSources = [
  'claudeville/src/domain/value-objects/TokenUsage.js',
];
const apiPricingSource = 'claudeville/adapters/sessionPresentation.js';
const widgetSources = [
  'widget/Sources/main.swift',
  'widget/Resources/widget.html',
  'widget/kde/claudeville/contents/ui/main.qml',
];

let failures = 0;

for (const rel of browserPricingSources) {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  for (const provider of ['claude', 'openai', 'kimi', 'deepseek']) {
    checkRates(rel, text, pricing[provider].rates);
    checkDefault(rel, text, pricing[provider].default);
  }
  requireText(rel, text, 'pricingModelCandidates');
  requireText(rel, text, 'gpt-5-(\\d)');
}

const apiText = readFileSync(join(repoRoot, apiPricingSource), 'utf8');
requireText(apiPricingSource, apiText, "require('../src/config/model-pricing.json')");
requireText(apiPricingSource, apiText, 'function estimateCost(');
requireText(apiPricingSource, apiText, 'function decorateSessionPresentation(');
requireText(apiPricingSource, apiText, 'function pricingModelCandidates(');
requireText(apiPricingSource, apiText, 'gpt-5-(\\d)');
assertRate('api gpt-5-6-sol', ratesForModel('gpt-5-6-sol', 'codex'), pricing.openai.rates[0]);
assertRate('api gpt-5-6-terra', ratesForModel('gpt-5-6-terra', 'codex'), pricing.openai.rates[1]);
assertRate('api gpt-5-6-luna', ratesForModel('gpt-5-6-luna', 'codex'), pricing.openai.rates[2]);
assertRate('api gpt-5-6', ratesForModel('gpt-5-6', 'codex'), pricing.openai.rates[3]);
assertRate('api gpt-5-5', ratesForModel('gpt-5-5', 'codex'), pricing.openai.rates[4]);
assertRate('api gpt-5-4', ratesForModel('gpt-5-4', 'codex'), pricing.openai.rates[5]);
assertRate('api gpt-5-3-codex-spark', ratesForModel('gpt-5-3-codex-spark', 'codex'), pricing.openai.rates[6]);

const forbiddenWidgetPatterns = [
  /\bpricingForModel\b/,
  /\bestimateTokenCost\b/,
  /\bCLAUDE_RATES\b/,
  /\bOPEN_AI_RATES\b/,
  /\bKIMI_RATES\b/,
  /\bDEEPSEEK_RATES\b/,
  /\bDEFAULT_(?:CLAUDE|OPEN_AI|KIMI|DEEPSEEK)_RATES\b/,
  /\btokens\s*\*\s*0\.000003\b/,
  /\bmatch:\s*['"][^'"]+['"]\s*,\s*input:\s*\d+(?:\.\d+)?\b/,
];

for (const rel of widgetSources) {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  requireText(rel, text, 'estimatedCost');
  requireText(rel, text, 'displayModel');
  requireText(rel, text, 'modelColor');
  for (const pattern of forbiddenWidgetPatterns) {
    if (pattern.test(text)) {
      console.error(`INVALID: ${rel} still contains widget-side pricing/model rate logic matching ${pattern}`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`pricing check failed: ${failures} issue(s)`);
  process.exit(1);
}

console.log(`pricing check passed: browser pricing parity, API session presentation, and ${widgetSources.length} widget consumers`);

function checkRates(rel, text, rates) {
  for (const rate of rates) {
    const line = lineForRate(text, rate.match);
    if (!line) {
      console.error(`MISSING: ${rel} does not include rate match ${rate.match}`);
      failures++;
      continue;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreate']) {
      if (!numberPattern(rate[key]).test(line)) {
        console.error(`MISMATCH: ${rel} ${rate.match}.${key} should include ${rate[key]}`);
        failures++;
      }
    }
  }
}

function checkDefault(rel, text, defaults) {
  for (const value of Object.values(defaults)) {
    const needle = numberPattern(value);
    if (!needle.test(text)) {
      console.error(`MISSING: ${rel} default pricing value ${value}`);
      failures++;
    }
  }
}

function lineForRate(text, match) {
  const quoted = new RegExp(`["']${escapeRegExp(match)}["']`);
  return text.split(/\r?\n/).find((line) => quoted.test(line) && /\binput\b/.test(line));
}

function numberPattern(value) {
  const escaped = String(value).replace('.', '\\.');
  return new RegExp(`(?<![0-9.])${escaped}(?:\\.0)?(?![0-9.])`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireText(rel, text, needle) {
  if (text.includes(needle)) return;
  console.error(`MISSING: ${rel} does not include ${needle}`);
  failures++;
}

function assertRate(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch (err) {
    console.error(`MISMATCH: ${label} should resolve to ${JSON.stringify(expected)} (${err.message})`);
    failures++;
  }
}
