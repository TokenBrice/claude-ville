#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = join(__dirname, '..', '..');
const packageRoot = join(repoRoot, 'widget', 'kde', 'claudeville');
const required = [
  'widget/kde/claudeville/metadata.json',
  'widget/kde/claudeville/contents/config/config.qml',
  'widget/kde/claudeville/contents/config/main.xml',
  'widget/kde/claudeville/contents/ui/configGeneral.qml',
  'widget/kde/claudeville/contents/ui/main.qml',
  'widget/kde/install.sh',
  'widget/kde/uninstall.sh',
];

let failures = 0;

for (const rel of required) {
  if (!existsSync(join(repoRoot, rel))) {
    console.error(`MISSING: ${rel}`);
    failures++;
  }
}

let metadata = null;
try {
  metadata = JSON.parse(readFileSync(join(packageRoot, 'metadata.json'), 'utf8'));
  const pluginId = metadata?.KPlugin?.Id;
  if (pluginId !== 'com.honorstudio.claudeville.kde') {
    console.error(`INVALID: metadata KPlugin.Id is ${JSON.stringify(pluginId)}`);
    failures++;
  }
  if (metadata?.KPackageStructure !== 'Plasma/Applet') {
    console.error(`INVALID: KPackageStructure is ${JSON.stringify(metadata?.KPackageStructure)}`);
    failures++;
  }
} catch (err) {
  console.error(`INVALID: widget/kde/claudeville/metadata.json cannot be parsed (${err.message})`);
  failures++;
}

const qmlPath = join(packageRoot, 'contents', 'ui', 'main.qml');
if (existsSync(qmlPath)) {
  const qml = readFileSync(qmlPath, 'utf8');
  const ids = new Set([...qml.matchAll(/["'](agent\.[A-Za-z0-9_.-]+)["']/g)].map((match) => match[1]));
  for (const id of [...ids].sort()) {
    const imagePath = join(packageRoot, 'contents', 'images', `${id}.png`);
    if (!existsSync(imagePath)) {
      console.error(`MISSING IMAGE: widget/kde/claudeville/contents/images/${id}.png`);
      failures++;
    }
  }
  console.log(`kde sprite image references checked: ${ids.size}`);
}

const kpackagetool = spawnSync('kpackagetool6', ['--version'], { encoding: 'utf8' });
if (kpackagetool.status === 0) {
  const firstLine = (kpackagetool.stdout || kpackagetool.stderr || '').split(/\r?\n/).find(Boolean) || 'kpackagetool6 available';
  console.log(`kpackagetool6: ${firstLine}`);
} else {
  console.warn('kpackagetool6: not available on PATH; package source checks still passed if no errors are listed');
}

if (failures) {
  console.error(`kde widget check failed: ${failures} issue(s)`);
  process.exit(1);
}

console.log('kde widget check passed');
