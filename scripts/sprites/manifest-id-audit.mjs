#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifestPath = join(repoRoot, 'claudeville', 'assets', 'sprites', 'manifest.yaml');
const scanRoots = [
    'claudeville/src',
    'claudeville/config',
].filter((rel) => existsSync(join(repoRoot, rel)));
const prefixes = '(agent|building|prop|veg|terrain|bridge|dock|equipment|overlay|atmosphere)';
const idBody = '[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*';
const literalPattern = new RegExp(`(['"])(${prefixes}\\.${idBody})\\1`, 'g');
const dynamicPattern = new RegExp('`([^`]*(?:agent|building|prop|veg|terrain|bridge|dock|equipment|overlay|atmosphere)\\.[^`]*)`', 'g');
const dynamicIdPattern = new RegExp(`${prefixes}\\.(?:[A-Za-z0-9_-]+|\\$\\{[^}]+\\})(?:\\.(?:[A-Za-z0-9_-]+|\\$\\{[^}]+\\}))*`, 'g');
const allowedDynamic = [
    /^agent\.\$\{[^}]+\}$/,
    /^agent\.\$\{[^}]+\}\.base$/,
    /^building\.\$\{[^}]+\}$/,
    /^building\.\$\{[^}]+\}\.\$\{[^}]+\}\.\$\{[^}]+\}\.\$\{[^}]+\}$/,
    /^prop\.\$\{[^}]+\}$/,
    /^dock\.\$\{[^}]+\}$/,
    /^bridge\.landmark\.\$\{[^}]+\}\.\$\{[^}]+\}$/,
    /^veg\.tree\.\$\{[^}]+\}\.\$\{[^}]+\}$/,
    /^veg\.boulder\.\$\{[^}]+\}\.\$\{[^}]+\}$/,
];

const manifestIds = collectManifestIds();
const references = collectReferences();
let errors = 0;

for (const ref of references) {
    if (ref.dynamic) {
        if (!allowedDynamic.some((pattern) => pattern.test(ref.id))) {
            console.error(`DYNAMIC UNKNOWN: ${ref.file}:${ref.line} ${ref.id}`);
            errors++;
        }
        continue;
    }
    if (!manifestIds.has(ref.id)) {
        console.error(`UNKNOWN SPRITE ID: ${ref.file}:${ref.line} ${ref.id}`);
        errors++;
    }
}

if (errors) {
    console.error(`sprite ID audit failed: ${errors} issue(s), ${references.length} references scanned`);
    process.exit(1);
}

console.log(`sprite ID audit passed: ${references.length} references, ${manifestIds.size} manifest IDs`);

function collectManifestIds() {
    const ids = new Set();
    const text = readFileSync(manifestPath, 'utf8');
    for (const match of text.matchAll(/^\s*-\s+id:\s*([A-Za-z0-9_.-]+)\s*$/gm)) {
        ids.add(match[1]);
    }
    return ids;
}

function collectReferences() {
    const refs = [];
    for (const root of scanRoots) {
        for (const file of walk(join(repoRoot, root))) {
            const rel = relative(repoRoot, file);
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(literalPattern)) {
                refs.push({ file: rel, line: lineFor(text, match.index), id: match[2], dynamic: false });
            }
            for (const match of text.matchAll(dynamicPattern)) {
                const template = match[1];
                if (!template.includes('${')) continue;
                for (const idMatch of template.matchAll(dynamicIdPattern)) {
                    const normalized = idMatch[0];
                    const before = template[idMatch.index - 1] || '';
                    if (!normalized.includes('${')) continue;
                    if (/[A-Za-z0-9_$.:{]/.test(before)) continue;
                    refs.push({ file: rel, line: lineFor(text, match.index + idMatch.index), id: normalized, dynamic: true });
                }
            }
        }
    }
    return refs;
}

function walk(dir, files = []) {
    for (const name of readdirSync(dir).sort()) {
        if (name === 'node_modules' || name === '.git') continue;
        const abs = join(dir, name);
        const stat = statSync(abs);
        if (stat.isDirectory()) walk(abs, files);
        else if (stat.isFile() && abs.endsWith('.js')) files.push(abs);
    }
    return files;
}

function lineFor(text, index) {
    return text.slice(0, index).split(/\r?\n/).length;
}
