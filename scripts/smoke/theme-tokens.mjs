// Token-conformance smoke (visual-quality plan 1.4). The status ramps forked
// twice between theme.js (JS authority) and reset.css (CSS fallback), so this
// script fails validate:quick if:
//   1. reset.css no longer defines every --cv-status-* at its authority or
//      declared CSS fallback color (or STATUS_CSS_VARS drifts from the
//      STATUS_VISUALS keys);
//   2. another CSS file re-defines a --cv-status-* literal;
//   3. a new private status hex table appears in src/ outside the allowlist;
//   4. anything but the App.js boot bridge touches --cv-status-* from JS.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_VISUALS, STATUS_CSS_VARS, TOOL_CATEGORY_COLORS } from '../../claudeville/src/config/theme.js';

const SCRIPT_NAME = 'theme-tokens.mjs';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RESET_CSS = path.join(REPO_ROOT, 'claudeville/css/reset.css');
const TOPBAR_CSS = path.join(REPO_ROOT, 'claudeville/css/topbar.css');
const CSS_DIR = path.join(REPO_ROOT, 'claudeville/css');
const SRC_DIR = path.join(REPO_ROOT, 'claudeville/src');

const CONTRAST_BASE = '#0d0a0c';
const RAW_TAILWIND_HEXES = Object.freeze([
    '#ef4444', '#facc15', '#eab308', '#60a5fa',
    '#a78bfa', '#34d399', '#f59e0b', '#c084fc',
]);

// CSS retains the house-ramp fallback values for these two status colors. The
// JS status authority is still checked for every other status below; when its
// owning palette changes, these overrides can be removed in the same commit.
const CSS_STATUS_FALLBACK_OVERRIDES = Object.freeze({
    errored: '#e06c5b',
    waiting_on_user: '#e8d44d',
});

const EXPECTED_HOUSE_TOKENS = Object.freeze({
    '--cv-purple': '#b79ae6',
    '--cv-warn-yellow': '#e8d44d',
});

const CONTRAST_TOKEN_NAMES = Object.freeze([
    ...Object.values(STATUS_CSS_VARS),
    '--cv-tool-read',
    '--cv-tool-write',
    '--cv-tool-exec',
    '--cv-tool-search',
    '--cv-tool-task',
    '--cv-tool-other',
    '--cv-green-soft',
    '--cv-blue-soft',
    '--cv-purple',
    '--cv-warn-yellow',
    '--cv-amber-deep',
    '--cv-gold',
    '--cv-gold-deep',
    '--cv-gold-bright',
    '--cv-gold-warm',
    '--cv-gold-soft',
    '--cv-yellow',
    '--cv-tan',
    '--cv-text-muted',
    '--cv-text-gray',
]);

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

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCustomProperty(css, name) {
    const pattern = new RegExp(`${escapeRegExp(name)}\\s*:\\s*([^;]+);`);
    const match = css.match(pattern);
    assert.ok(match, `${name} is not defined`);
    return match[1].trim();
}

// Follow `var(--token)` aliases through the given stylesheets (first match
// wins per lookup) down to a literal colour value.
function resolveCustomProperty(sources, name, seen = new Set()) {
    assert.ok(!seen.has(name), `${name} has a circular var() reference`);
    seen.add(name);
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(name)}\\s*:\\s*([^;]+);`);
    const css = [].concat(sources).find((text) => pattern.test(text));
    assert.ok(css, `${name} is not defined`);
    const value = css.match(pattern)[1].trim();
    const alias = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
    return alias ? resolveCustomProperty(sources, alias[1], seen) : value;
}

function resolveValue(sources, value) {
    const alias = String(value).trim().match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
    return alias ? resolveCustomProperty(sources, alias[1]) : value;
}

// Finds `declaration` in the first rule whose selector list contains
// `selector` as a complete member (`.a, .b {` matches `.a` and `.b`).
function readRuleDeclaration(css, selector, declaration) {
    const declarationPattern = new RegExp(
        `(?:^|\\s)${escapeRegExp(declaration)}\\s*:\\s*([^;]+);`,
    );
    const rulePattern = new RegExp(
        `(?:^|[\\s,}])${escapeRegExp(selector)}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`,
        'g',
    );
    for (const ruleMatch of css.matchAll(rulePattern)) {
        const declarationMatch = ruleMatch[1].match(declarationPattern);
        if (declarationMatch) return declarationMatch[1].trim();
    }
    assert.fail(`${selector} has no ${declaration} declaration`);
}

function parseColor(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const hex = normalized.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        const digits = hex[1];
        assert.ok([3, 4, 6, 8].includes(digits.length), `unsupported hex color '${value}'`);
        const expanded = digits.length <= 4
            ? [...digits].map((digit) => `${digit}${digit}`).join('')
            : digits;
        const channels = [
            Number.parseInt(expanded.slice(0, 2), 16),
            Number.parseInt(expanded.slice(2, 4), 16),
            Number.parseInt(expanded.slice(4, 6), 16),
        ];
        const alphaDigits = expanded.length === 8 ? expanded.slice(6, 8) : 'ff';
        return {
            r: channels[0] / 255,
            g: channels[1] / 255,
            b: channels[2] / 255,
            a: Number.parseInt(alphaDigits, 16) / 255,
        };
    }

    const functional = normalized.match(/^rgba?\((.*)\)$/i);
    if (!functional) throw new Error(`unsupported color '${value}'`);
    const parts = functional[1].split(',').map((part) => part.trim());
    assert.ok(parts.length === 3 || parts.length === 4, `invalid color '${value}'`);
    const channels = parts.slice(0, 3).map((part) => {
        const number = part.endsWith('%')
            ? Number.parseFloat(part) * 2.55
            : Number.parseFloat(part);
        assert.ok(Number.isFinite(number), `invalid color channel '${part}'`);
        return Math.max(0, Math.min(255, number)) / 255;
    });
    const alpha = parts.length === 4 ? Number.parseFloat(parts[3]) : 1;
    assert.ok(Number.isFinite(alpha), `invalid color alpha '${parts[3]}'`);
    return { r: channels[0], g: channels[1], b: channels[2], a: Math.max(0, Math.min(1, alpha)) };
}

function blendOver(foreground, background) {
    const alpha = foreground.a ?? 1;
    return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
        a: 1,
    };
}

function linearize(channel) {
    return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color) {
    return 0.2126 * linearize(color.r)
        + 0.7152 * linearize(color.g)
        + 0.0722 * linearize(color.b);
}

function contrastRatio(foreground, background) {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function assertContrast(label, foreground, background) {
    const effectiveForeground = blendOver(foreground, background);
    const ratio = contrastRatio(effectiveForeground, background);
    assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1`);
}

// The four chrome surfaces (--bg-0..3) plus the legacy surface aliases, all
// resolved through var() and pre-blended over the palette-review base.
function readSurfaceTokens(resetCss) {
    const base = parseColor(CONTRAST_BASE);
    const surface = (name) => blendOver(parseColor(resolveCustomProperty(resetCss, name)), base);
    return {
        base,
        'bg-0': surface('--bg-0'),
        'bg-1': surface('--bg-1'),
        'bg-2': surface('--bg-2'),
        'bg-3': surface('--bg-3'),
        'surface-1': surface('--cv-surface-1'),
        'surface-2': surface('--cv-surface-2'),
        'surface-3': surface('--cv-surface-3'),
        panel: surface('--cv-panel'),
    };
}

function run() {
    const resetCss = fs.readFileSync(RESET_CSS, 'utf8');
    const topbarCss = fs.readFileSync(TOPBAR_CSS, 'utf8');

    check('STATUS_CSS_VARS covers exactly the STATUS_VISUALS keys', () => {
        assert.deepEqual(
            Object.keys(STATUS_CSS_VARS).sort(),
            Object.keys(STATUS_VISUALS).sort(),
        );
    });

    // reset.css defines each --cv-status-* at the JS authority color, except
    // for the two house-ramp fallback overrides declared above.
    for (const [status, visual] of Object.entries(STATUS_VISUALS)) {
        const varName = STATUS_CSS_VARS[status] || '(unmapped)';
        const override = CSS_STATUS_FALLBACK_OVERRIDES[status];
        const expectedLabel = override
            ? `CSS house-ramp fallback for ${status}`
            : `STATUS_VISUALS.${status}.color`;
        check(`reset.css ${varName} == ${expectedLabel}`, () => {
            assert.ok(STATUS_CSS_VARS[status], `STATUS_CSS_VARS is missing '${status}'`);
            const pattern = new RegExp(`${varName.replace(/-/g, '\\-')}\\s*:\\s*([^;]+);`);
            const match = resetCss.match(pattern);
            assert.ok(match, `${varName} is not defined in reset.css`);
            const expected = override || visual.color;
            assert.equal(normalizeHex(match[1]), normalizeHex(expected));
        });
    }

    check('reset.css contains no raw Tailwind status/tool colors', () => {
        const css = resetCss.toLowerCase();
        const offenders = RAW_TAILWIND_HEXES.filter((hex) => css.includes(hex));
        assert.deepEqual(offenders, []);
    });

    for (const [token, expected] of Object.entries(EXPECTED_HOUSE_TOKENS)) {
        check(`reset.css ${token} uses the house-ramp color`, () => {
            assert.equal(normalizeHex(resolveCustomProperty(resetCss, token)), expected);
        });
    }

    // Tool colours: theme.js is the authority, reset.css mirrors it.
    for (const [tool, expected] of Object.entries(TOOL_CATEGORY_COLORS)) {
        check(`reset.css --cv-tool-${tool} == TOOL_CATEGORY_COLORS.${tool}`, () => {
            assert.equal(
                normalizeHex(resolveCustomProperty(resetCss, `--cv-tool-${tool}`)),
                normalizeHex(expected),
            );
        });
    }

    check('tool colours never reuse a status colour', () => {
        const statusColors = new Set(Object.values(STATUS_VISUALS).map((visual) => normalizeHex(visual.color)));
        const reused = Object.entries(TOOL_CATEGORY_COLORS)
            .filter(([, color]) => statusColors.has(normalizeHex(color)))
            .map(([tool]) => tool);
        assert.deepEqual(reused, []);
    });

    const surfaces = readSurfaceTokens(resetCss);
    check('dark text tokens meet 4.5:1 on every declared dark surface', () => {
        for (const token of CONTRAST_TOKEN_NAMES) {
            const color = parseColor(resolveCustomProperty(resetCss, token));
            for (const [surface, background] of Object.entries(surfaces)) {
                assertContrast(`${token} on ${surface}`, color, background);
            }
        }
    });

    // Resting top-bar text sits on the bar (--bg-1), inside a tab well
    // (--bg-0) and on a hover plate (--bg-2); it must stay legible on all three.
    const topbarSurfaces = {
        bar: surfaces['bg-1'],
        well: surfaces['bg-0'],
        hover: surfaces['bg-2'],
    };
    check('topbar text declarations meet 4.5:1 on the bar, wells and hover plates', () => {
        const selectors = [
            '.topbar__sound-btn',
            '.topbar__cinema-btn',
            '.topbar__seg-stat--muted .topbar__stat-value',
            '.topbar__uptime',
            '.topbar__stat-rate',
            '.topbar__mode-btn',
        ];
        for (const selector of selectors) {
            const declared = readRuleDeclaration(topbarCss, selector, 'color');
            const color = parseColor(resolveValue(resetCss, declared));
            for (const [surface, background] of Object.entries(topbarSurfaces)) {
                assertContrast(`${selector} on ${surface}`, color, background);
            }
        }
    });

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
