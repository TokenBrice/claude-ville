#!/usr/bin/env node

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = join(__dirname, '..', '..');
const required = [
  'widget/Info.plist',
  'widget/Resources/widget.css',
  'widget/Resources/widget.html',
  'widget/Sources/main.swift',
  'widget/build.sh',
];

let failures = 0;

for (const rel of required) {
  if (!existsSync(join(repoRoot, rel))) {
    console.error(`MISSING: ${rel}`);
    failures++;
  }
}

const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
if (swiftc.status === 0) {
  const firstLine = (swiftc.stdout || '').split(/\r?\n/).find(Boolean) || 'swiftc available';
  console.log(`swiftc: ${firstLine}`);
} else {
  console.warn('swiftc: not available on PATH; source checks continue without compiling');
}

const bundle = spawnSync(process.execPath, ['scripts/widget/check-bundle.cjs'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (bundle.stdout) process.stdout.write(bundle.stdout);
if (bundle.stderr) process.stderr.write(bundle.stderr);
if (bundle.status !== 0) failures++;

if (failures) {
  console.error(`widget check failed: ${failures} issue(s)`);
  process.exit(1);
}

console.log('widget check passed');
