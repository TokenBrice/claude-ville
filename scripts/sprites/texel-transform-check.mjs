// 3.8 — ships, the flower cart and held weapons draw at an integer multiple
// of the world texel: frames are baked offline or at cache time (hull roll
// strips, cleanEdge weapon frames, the 1x flower cart), so no runtime
// `ctx.rotate` and no non-1 `ctx.scale` may appear in their drawing code.
// The only allowed scale is the screen-fixed plate cancel
// `scale(1 / zoom, 1 / zoom)` that keeps harbor labels at screen size.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE_DIR = 'claudeville/src/presentation/character-mode';
// Whole files that only draw ships, hulls or weapon frames.
const WHOLE_FILES = [
    'HarborTraffic.js',
    'HarborHulls.js',
    'WeaponFrames.js',
    'CodexWeaponPose.js',
    'AstraWeaponPose.js',
];
// AgentSprite methods that paint or place held equipment.
const AGENT_SPRITE = 'AgentSprite.js';
const WEAPON_METHOD = /^_(drawCodex\w*|drawWeapon\w*|drawGear\w*|\w*WeaponFrame\w*|cachedCodex\w*|drawTaperedBlade|fillWeapon\w*|codexWeapon\w*)$/;
const PLATE_CANCEL = /^\s*1\s*\/\s*(\(\s*zoom\s*\|\|\s*1\s*\)|zoom)\s*,\s*1\s*\/\s*(\(\s*zoom\s*\|\|\s*1\s*\)|zoom)\s*$/;
const NO_SCALE_MANIFEST_IDS = [/^prop\.flowerCart$/, /^prop\.harborShip\./];

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length));
}

// The text between a call's opening parenthesis and its matching close.
function callArgs(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
    }
    return '';
}

function lineOf(source, index) {
    return source.slice(0, index).split('\n').length;
}

export function transformViolations(source, { lineOffset = 0 } = {}) {
    const code = stripComments(source);
    const violations = [];
    const pattern = /\.(rotate|scale|transform|setTransform)\s*\(/g;
    for (let match; (match = pattern.exec(code));) {
        const args = callArgs(code, match.index + match[0].length - 1);
        const call = match[1];
        if (call === 'scale' && PLATE_CANCEL.test(args)) continue;
        if (call === 'setTransform' && /^\s*1\s*,\s*0\s*,\s*0\s*,\s*1\s*(,|$)/.test(args)) continue;
        violations.push({ line: lineOf(code, match.index) + lineOffset, text: `${call}(${args.trim()})` });
    }
    return violations;
}

// Class methods of AgentSprite whose names mark them as weapon drawing, as
// { name, body, line } (body = the method's source through its closing
// brace, found by brace matching on the comment-stripped code).
function weaponMethods(source) {
    const code = stripComments(source);
    const methods = [];
    const header = /^ {4}(_\w+)\s*\([^)]*\)\s*\{/gm;
    for (let match; (match = header.exec(code));) {
        if (!WEAPON_METHOD.test(match[1])) continue;
        let depth = 0;
        let end = code.length;
        for (let i = match.index + match[0].length - 1; i < code.length; i++) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}' && --depth === 0) { end = i + 1; break; }
        }
        methods.push({ name: match[1], body: source.slice(match.index, end), line: lineOf(code, match.index) - 1 });
    }
    return methods;
}

export function validateTexelTransforms({ root, manifestEntries = [] } = {}) {
    let errors = 0;
    const report = (where, text) => {
        console.error(`TEXEL TRANSFORM: ${where} ${text} (3.8: ships, the flower cart and weapons draw baked frames; no ctx.rotate or non-1 ctx.scale)`);
        errors++;
    };
    for (const file of WHOLE_FILES) {
        const rel = join(MODE_DIR, file);
        for (const v of transformViolations(readFileSync(join(root, rel), 'utf8'))) report(`${rel}:${v.line}`, v.text);
    }
    const spriteRel = join(MODE_DIR, AGENT_SPRITE);
    const methods = weaponMethods(readFileSync(join(root, spriteRel), 'utf8'));
    if (!methods.some(m => m.name === '_drawWeaponAt')) report(spriteRel, 'weapon drawing method _drawWeaponAt not found; update WEAPON_METHOD');
    for (const method of methods) {
        for (const v of transformViolations(method.body, { lineOffset: method.line })) report(`${spriteRel}:${v.line} ${method.name}`, v.text);
    }
    for (const entry of manifestEntries) {
        if (!NO_SCALE_MANIFEST_IDS.some(re => re.test(entry.id || ''))) continue;
        for (const key of ['displaySize', 'scale', 'drawScale']) {
            if (entry[key] !== undefined) report(`manifest ${entry.id}`, `${key}: ${entry[key]} (draws at 1x)`);
        }
    }
    return errors;
}
