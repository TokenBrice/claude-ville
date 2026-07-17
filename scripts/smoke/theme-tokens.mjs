// Token-conformance smoke (visual-quality plan 1.4). The status ramps forked
// twice between theme.js (JS authority) and reset.css (CSS fallback), so this
// script fails validate:quick if:
//   1. reset.css no longer defines every --cv-status-* at the STATUS_VISUALS
//      color (or STATUS_CSS_VARS drifts from STATUS_VISUALS keys);
//   2. another CSS file re-defines a --cv-status-* literal;
//   3. a new private status hex table appears in src/ outside the allowlist;
//   4. anything but the App.js boot bridge touches --cv-status-* from JS.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_VISUALS, STATUS_CSS_VARS } from '../../claudeville/src/config/theme.js';

const SCRIPT_NAME = 'theme-tokens.mjs';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RESET_CSS = path.join(REPO_ROOT, 'claudeville/css/reset.css');
const CSS_DIR = path.join(REPO_ROOT, 'claudeville/css');
const SRC_DIR = path.join(REPO_ROOT, 'claudeville/src');

// Files allowed to mention status tokens literally. Everything else must
// consume STATUS_VISUALS (JS) or var(--cv-status-*) (CSS).
const HEX_TABLE_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/src/config/theme.js'),
]);
const CSS_DEFINITION_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/css/reset.css'),
]);
const JS_VAR_TOUCH_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/src/config/theme.js'),    // STATUS_CSS_VARS names
    path.join(REPO_ROOT, 'claudeville/src/presentation/App.js'), // boot bridge
]);

let failed = false;

function pass(message) {
    console.log(`  PASS ${message}`);
}

function fail(message, err) {
    failed = true;
    console.log(`  FAIL ${message}${err ? `: ${err.message || err}` : ''}`);
}

function check(label, fn) {
    try {
        fn();
        pass(label);
    } catch (err) {
        fail(label, err);
    }
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const normalizeHex = (value) => String(value || '').trim().toLowerCase();

function run() {
    const resetCss = fs.readFileSync(RESET_CSS, 'utf8');

    check('STATUS_CSS_VARS covers exactly the STATUS_VISUALS keys', () => {
        assert.deepEqual(
            Object.keys(STATUS_CSS_VARS).sort(),
            Object.keys(STATUS_VISUALS).sort(),
        );
    });

    // reset.css defines each --cv-status-* at exactly the STATUS_VISUALS color.
    for (const [status, visual] of Object.entries(STATUS_VISUALS)) {
        const varName = STATUS_CSS_VARS[status] || '(unmapped)';
        check(`reset.css ${varName} == STATUS_VISUALS.${status}.color`, () => {
            assert.ok(STATUS_CSS_VARS[status], `STATUS_CSS_VARS is missing '${status}'`);
            const pattern = new RegExp(`${varName.replace(/-/g, '\\-')}\\s*:\\s*([^;]+);`);
            const match = resetCss.match(pattern);
            assert.ok(match, `${varName} is not defined in reset.css`);
            assert.equal(normalizeHex(match[1]), normalizeHex(visual.color));
        });
    }

    // No other CSS file may re-define a --cv-status-* literal (consumption via
    // var(--cv-status-*) is fine — that is the point of the tokens).
    const cssDefinition = /--cv-status-[a-z-]+\s*:\s*(?!var\()[^;]+;/i;
    for (const file of walk(CSS_DIR).filter((f) => f.endsWith('.css'))) {
        if (CSS_DEFINITION_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} does not re-define --cv-status-*`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => cssDefinition.test(line));
            assert.deepEqual(offenders, []);
        });
    }

    // No private status-keyed hex tables in src/ outside the allowlist, e.g.
    // `working: '#4ade80'` or `rate_limited: '#f59e0b'`.
    const statusHex = /['"]?(?:working|idle|waiting|errored|rate_limited|rateLimited|waiting_on_user|waitingOnUser|completed|chatting)['"]?\s*:\s*['"]#[0-9a-fA-F]{3,8}\b/;
    for (const file of walk(SRC_DIR).filter((f) => f.endsWith('.js'))) {
        if (HEX_TABLE_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} has no private status hex table`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => statusHex.test(line));
            assert.deepEqual(offenders, []);
        });
    }

    // Only the boot bridge may setProperty --cv-status-* at runtime (reading
    // via var(--cv-status-*) in inline styles is fine — that is the point).
    const setStatusVar = /setProperty\(\s*['"]--cv-status-/;
    for (const file of walk(SRC_DIR).filter((f) => f.endsWith('.js'))) {
        if (JS_VAR_TOUCH_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} does not re-stamp --cv-status-*`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => setStatusVar.test(line));
            assert.deepEqual(offenders, []);
        });
    }
}

try {
    run();
} catch (err) {
    fail('uncaught failure in smoke', err);
}

if (failed) {
    console.log(`[${SCRIPT_NAME}] FAIL`);
    process.exit(1);
}
console.log(`[${SCRIPT_NAME}] PASS`);
