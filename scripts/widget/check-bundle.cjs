#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createHash } = require('node:crypto');

const repoRoot = join(__dirname, '..', '..');
const widgetRoot = join(repoRoot, 'widget');
const bundleRoot = join(widgetRoot, 'ClaudeVilleWidget.app', 'Contents');
const sourceToBundle = [
  ['Info.plist', 'Info.plist'],
  ...readdirSync(join(widgetRoot, 'Resources'))
    .filter((name) => statSync(join(widgetRoot, 'Resources', name)).isFile())
    .sort()
    .map((name) => [join('Resources', name), join('Resources', name)]),
];

if (!existsSync(bundleRoot)) {
  console.log('widget bundle check skipped: widget/ClaudeVilleWidget.app is not present');
  process.exit(0);
}

let stale = 0;

for (const [sourceRel, bundleRel] of sourceToBundle) {
  const source = join(widgetRoot, sourceRel);
  const bundled = join(bundleRoot, bundleRel);
  if (!existsSync(bundled)) {
    console.error(`BUNDLE MISSING: ${relative(repoRoot, bundled)}`);
    stale++;
    continue;
  }
  if (sha256(source) !== sha256(bundled)) {
    console.error(`BUNDLE STALE: ${relative(repoRoot, bundled)} differs from ${relative(repoRoot, source)}`);
    stale++;
  }
}

if (stale) {
  console.error('widget bundle is stale; rebuild with npm run widget:build before launching the app bundle');
  process.exit(1);
}

console.log(`widget bundle check passed: ${sourceToBundle.length} source files match bundle copies`);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
