#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const lockPath = join(repoRoot, 'package-lock.json');
const sourcePath = join(repoRoot, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js');
const vendorPath = join(repoRoot, 'claudeville', 'vendor', 'js-yaml.min.js');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const lockedVersion = lock.packages?.['node_modules/js-yaml']?.version;
if (!lockedVersion) {
    throw new Error('package-lock.json does not contain node_modules/js-yaml');
}
if (!existsSync(sourcePath)) {
    throw new Error('node_modules/js-yaml/dist/js-yaml.min.js is missing; run npm install before refreshing vendor assets');
}

const source = readFileSync(sourcePath, 'utf8');
const header = source.split(/\r?\n/, 1)[0] || '';
if (!header.includes(`js-yaml ${lockedVersion}`)) {
    throw new Error(`js-yaml dist header does not match package-lock version ${lockedVersion}: ${header}`);
}

copyFileSync(sourcePath, vendorPath);
console.log(`refreshed claudeville/vendor/js-yaml.min.js from js-yaml ${lockedVersion}`);
