#!/usr/bin/env node

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '..', '..');
const pricing = JSON.parse(readFileSync(join(repoRoot, 'claudeville/src/config/model-pricing.json'), 'utf8'));
const sources = [
  'claudeville/src/domain/value-objects/TokenUsage.js',
  'widget/Sources/main.swift',
  'widget/Resources/widget.html',
];

let failures = 0;

for (const rel of sources) {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  checkRates(rel, text, pricing.claude.rates);
  checkRates(rel, text, pricing.openai.rates);
  checkDefault(rel, text, pricing.claude.default);
  checkDefault(rel, text, pricing.openai.default);
}

const kdeText = readFileSync(join(repoRoot, 'widget/kde/claudeville/contents/ui/main.qml'), 'utf8');
if (!/tokens \* 0\.000003/.test(kdeText)) {
  console.error('INVALID: KDE widget no longer uses the documented simplified flat estimate');
  failures++;
}

if (failures) {
  console.error(`pricing check failed: ${failures} issue(s)`);
  process.exit(1);
}

console.log(`pricing check passed: ${sources.length} detailed surfaces plus KDE flat estimate`);

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
