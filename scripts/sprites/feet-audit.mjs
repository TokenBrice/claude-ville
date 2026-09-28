#!/usr/bin/env node
// V7 feet audit for character strips: every new body cell must keep its feet
// within ±2 px of the base sheet's per-direction foot anchor, or the body
// visibly hops when the renderer swaps a walk/idle cell for a strip cell.
//
// The anchor is the one the runtime places every body cell by (plan V7):
//   cx2  = minX + maxX of the direction's idle row-6 cell (alpha >= 16, the
//          threshold AgentSprite.measureCellContentBounds uses);
//   maxY = the lowest opaque row over base rows 0–9 of that direction.
// Every cell of a direction is placed by that one anchor, so a strip frame's
// feet must sit where the idle row-6 feet sit. Per strip frame the audit
// template-matches the idle row-6 cell's bottom 10 rows (feet, ankles, hem)
// against the frame and reports the best-overlap shift:
//   dx, dy = feet displacement in px (fails beyond ±tolerance)
//   line   = frame maxY − anchor maxY (informational: a tool swung below the
//            feet moves the lowest pixel but not the body)
// A raised arm or a swung tool above the feet never moves the match; a
// sliding, lifted or re-drawn foot does.
//
// Poses whose foot line moves by design (the 7.1 sit strip, where the seat
// line becomes the new foot) audit with `--reference=group`: each direction is
// matched against the group's own first frame (the held pose must not creep),
// and that first frame's shift from the standing idle is reported, never
// failed.
//
// Usage:
//   node scripts/sprites/feet-audit.mjs                         # shipped strips, every character
//   node scripts/sprites/feet-audit.mjs --ids=agent.claude.sonnet --directions=e,w,se,sw
//   node scripts/sprites/feet-audit.mjs --id=agent.codex.gpt55 \
//       --strip=output/waking-isle/AssetsA/strips/agent.codex.gpt55.work.png \
//       --groups=strike:0-5,wait:6-8 --directions=e,w,se,sw
//   node scripts/sprites/feet-audit.mjs --id=<id> --strip=<png> --groups=sit:0-3 --reference=group
//   Options: --tolerance=2  --base (also list walk/idle deviations; informational)
//            --json  --contact-sheet=<png> (2× cells with anchor and feet marks)
//
// Three more checks per strip frame (plan 7.3, after the Phase A review):
//   fragments  detached islands (8-connected, alpha >= 16) that the idle cell
//              does not carry within 2 px: a floating hammer head, a stray
//              fragment. Fails at --island-min px (default 3; the generator
//              clears 1–2 px specks). Idle sparkles and badges stay legal.
//   identity   non-arm identity diff against the idle cell: pixels outside the
//              moving arms' envelope (capsules around shoulder–elbow–hand of
//              every arm whose joints moved, in the frame pose and the idle
//              pose) that have no same-colour counterpart within 2 px, added
//              plus removed. Catches a cape flaring like a run cycle, a prop
//              that becomes another prop, a re-drawn crest. Fails above
//              --identity-max px (default max(24, 2.5% of the idle body)).
//              Needs the frames' keypoints: the generator's stage .json next
//              to --strip, or --keypoints=<json> (the assembler's
//              output/action-strips/<id>.keypoints.json, found automatically
//              for shipped strips). Without keypoints it is reported as n/a.
//   clearance  the `wait` group's held frame must rise at least --clearance px
//              (default 3) above the idle cell's top row: the raised hand
//              clears the hat or helm.
// Exit code 1 when any audited strip frame fails a check.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { dilate, newIslands } from './cell-islands.mjs';
import { collectSpriteEntries, loadSpriteManifest, repoRoot, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
// SpriteSheet.DIRECTIONS column order.
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const LONG_DIRECTIONS = {
    south: 's', 'south-east': 'se', east: 'e', 'north-east': 'ne',
    north: 'n', 'north-west': 'nw', west: 'w', 'south-west': 'sw',
};
const SHORT_TO_LONG = Object.fromEntries(Object.entries(LONG_DIRECTIONS).map(([long, short]) => [short, long]));
const ALPHA_MIN = 16;
const FOOT_WINDOW = 10;
const FOOT_SEARCH = 8;
const IDLE_ROW = 6;
const BASE_ROWS = 10;
const BASE_GROUPS = { walk: [0, 5], idle: [6, 9] };

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const list = (value) => (value || '').split(',').map((item) => item.trim()).filter(Boolean);

const tolerance = Number(option('tolerance', '2'));
const reference = option('reference', 'anchor');
const stripOption = option('strip');
const groupsOption = option('groups');
const contactSheetPath = option('contact-sheet');
const directions = list(option('directions')).map((name) => LONG_DIRECTIONS[name] || name);
const ids = [...list(option('ids')), ...list(option('id'))];
const islandMin = Number(option('island-min', '3'));
const identityMaxOption = option('identity-max');
const clearance = Number(option('clearance', '3'));
const keypointsOption = option('keypoints');

for (const name of directions) {
    if (!DIRECTIONS.includes(name)) fail(`unknown direction "${name}"; use ${DIRECTIONS.join(', ')}`);
}
if (!Number.isFinite(tolerance) || tolerance < 0) fail('--tolerance must be a non-negative number');
if (!['anchor', 'group'].includes(reference)) fail('--reference is anchor or group');
if (stripOption && ids.length !== 1) fail('--strip audits one character: pass exactly one --id');
if (stripOption && !groupsOption) fail('--strip needs --groups=name:first-last[,…]');

const entries = collectSpriteEntries(loadSpriteManifest()).filter((entry) => entry.id?.startsWith('agent.'));
const byId = new Map(entries.map((entry) => [entry.id, entry]));
for (const id of ids) if (!byId.has(id)) fail(`${id} is not a manifest character`);
const targets = ids.length ? ids : entries.map((entry) => entry.id);
const columns = directions.length ? directions : DIRECTIONS;

const report = [];
const sheetTiles = [];
for (const id of targets) {
    const entry = byId.get(id);
    const sheetPath = join(spritesRoot, 'characters', id, 'sheet.png');
    if (!existsSync(sheetPath)) continue;
    const sheet = readPng(sheetPath);
    const anchors = anchorsFor(sheet);
    const strips = [];
    if (stripOption) {
        const stripPath = resolvePath(stripOption);
        strips.push({
            path: stripPath,
            groups: parseGroups(groupsOption),
            label: 'candidate',
            keypoints: loadKeypoints(keypointsOption ? resolvePath(keypointsOption) : stripPath.replace(/\.png$/, '.json')),
        });
    } else if (entry.actionStrip?.path) {
        strips.push({
            path: join(spritesRoot, entry.actionStrip.path),
            groups: Object.entries(entry.actionStrip.groups || {}).map(([name, group]) => ({ name, rows: group.rows })),
            label: 'shipped',
            keypoints: loadKeypoints(keypointsOption && ids.length === 1
                ? resolvePath(keypointsOption)
                : join(repoRoot, 'output', 'action-strips', `${id}.keypoints.json`)),
        });
    }
    const character = { id, anchors: {}, strips: [], base: null };
    for (const dir of columns) character.anchors[dir] = anchors[DIRECTIONS.indexOf(dir)].summary;
    for (const strip of strips) {
        if (!existsSync(strip.path)) fail(`${id}: strip ${strip.path} does not exist`);
        const png = readPng(strip.path);
        if (png.width !== CELL * DIRECTIONS.length || png.height % CELL !== 0) {
            fail(`${id}: ${strip.path} is ${png.width}×${png.height}, not 8 columns of ${CELL}px cells`);
        }
        const groups = [];
        for (const group of strip.groups) {
            if (group.rows[1] >= png.height / CELL) fail(`${id}: group ${group.name} rows ${group.rows.join('–')} exceed the strip`);
            groups.push(auditGroup(png, group, anchors, { keypoints: strip.keypoints }));
            if (contactSheetPath) sheetTiles.push({ id, png, group, anchors, result: groups.at(-1) });
        }
        character.strips.push({ path: relative(strip.path), label: strip.label, groups });
    }
    if (flag('base')) {
        character.base = Object.entries(BASE_GROUPS)
            .map(([name, rows]) => auditGroup(sheet, { name, rows }, anchors, { reference: 'anchor' }));
    }
    report.push(character);
}

const failures = report.flatMap((character) => character.strips.flatMap((strip) => strip.groups
    .filter((group) => !group.pass)
    .map((group) => `${character.id} ${group.name}: ${group.failingFrames.join(' ')}`)));

if (flag('json')) {
    console.log(JSON.stringify({ tolerance, reference, failures, characters: report }, (key, value) => (key === 'drift' ? undefined : value), 2));
} else {
    printReport(report);
}
if (contactSheetPath && sheetTiles.length) writeContactSheet(resolvePath(contactSheetPath), sheetTiles);
process.exitCode = failures.length ? 1 : 0;

// ─── measurement ──────────────────────────────────────────────────────────────

function measureCell(png, col, row) {
    const x0 = col * CELL;
    const y0 = row * CELL;
    const mask = new Uint8Array(CELL * CELL);
    let minX = CELL, minY = CELL, maxX = -1, maxY = -1;
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            if (png.data[((y0 + y) * png.width + x0 + x) * 4 + 3] < ALPHA_MIN) continue;
            mask[y * CELL + x] = 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY, cx2: minX + maxX, mask, png, x0, y0 };
}

// Where did the reference feet go? Vertically, the foot line: the frame's
// lowest opaque row against the reference's. Horizontally, the reference's
// bottom FOOT_WINDOW rows (feet, ankles, hem) are template-matched against
// the frame with the foot lines aligned, over ±FOOT_SEARCH px; the
// best-overlap shift (IoU, ties to the smallest move) is the feet
// displacement. A raised arm or a swung tool above the window never moves it;
// a sliding, lifted or re-drawn foot does. (A free 2D match slides up
// featureless robe columns, so the vertical term stays the foot line.)
function feetShift(ref, frame) {
    const dy = frame.maxY - ref.maxY;
    const top = Math.max(0, ref.maxY - FOOT_WINDOW + 1);
    let refCount = 0;
    for (let y = top; y <= ref.maxY; y++) for (let x = 0; x < CELL; x++) refCount += ref.mask[y * CELL + x];
    let best = { dx: 0, dy, iou: -1 };
    for (let dx = -FOOT_SEARCH; dx <= FOOT_SEARCH; dx++) {
        let inter = 0;
        let frameCount = 0;
        for (let y = top; y <= ref.maxY; y++) {
            const fy = y + dy;
            if (fy < 0 || fy >= CELL) continue;
            for (let x = 0; x < CELL; x++) {
                const fx = x + dx;
                if (fx < 0 || fx >= CELL) continue;
                const hit = frame.mask[fy * CELL + fx];
                frameCount += hit;
                inter += hit & ref.mask[y * CELL + x];
            }
        }
        const iou = inter / Math.max(1, refCount + frameCount - inter);
        if (iou > best.iou + 1e-9 || (Math.abs(iou - best.iou) <= 1e-9 && Math.abs(dx) < Math.abs(best.dx))) best = { dx, dy, iou };
    }
    return best;
}

function anchorsFor(sheet) {
    if (sheet.width !== CELL * DIRECTIONS.length || sheet.height < CELL * BASE_ROWS) {
        fail(`base sheet is ${sheet.width}×${sheet.height}, not the 8×10 grid of ${CELL}px cells`);
    }
    return DIRECTIONS.map((dir, col) => {
        const idle = measureCell(sheet, col, IDLE_ROW);
        if (!idle) fail(`base sheet idle row ${IDLE_ROW} is empty for ${dir}`);
        let maxY = -1;
        for (let row = 0; row < BASE_ROWS; row++) maxY = Math.max(maxY, measureCell(sheet, col, row)?.maxY ?? -1);
        return { cx2: idle.cx2, maxY, idle, summary: { cx2: idle.cx2, maxY, idleMaxY: idle.maxY } };
    });
}

function auditGroup(png, group, anchors, { reference: mode = reference, keypoints = null } = {}) {
    const result = { name: group.name, rows: group.rows, reference: mode, directions: {}, failingFrames: [], pass: true };
    const holdIndex = group.rows[1] - group.rows[0];
    for (const dir of columns) {
        const col = DIRECTIONS.indexOf(dir);
        const anchor = anchors[col];
        const frames = [];
        for (let row = group.rows[0]; row <= group.rows[1]; row++) frames.push(measureCell(png, col, row));
        const first = frames[0];
        const ref = mode === 'group' && first ? first : anchor.idle;
        const poses = keypointsFor(keypoints, group.name, dir);
        const identityMax = identityMaxOption !== null
            ? Number(identityMaxOption)
            : Math.max(24, Math.round(0.025 * anchor.idle.mask.reduce((sum, v) => sum + v, 0)));
        const rows = frames.map((frame, index) => {
            if (!frame) return { frame: index, empty: true, pass: false, why: ['empty'] };
            const shift = feetShift(ref, frame);
            const why = [];
            if (Math.abs(shift.dx) > tolerance || Math.abs(shift.dy) > tolerance) why.push(`dx${signed(shift.dx)},dy${signed(shift.dy)}`);
            const fragments = newIslands(frame.mask, anchor.idle.mask, CELL).filter((island) => island.size >= islandMin);
            if (fragments.length) why.push(`fragment${fragments.map((island) => ` ${island.size}px@${island.minX},${island.minY}`).join('')}`);
            // Seat poses (`--reference=group`) redraw hips and legs by design,
            // so the non-arm identity diff applies to standing work poses.
            let identity = null;
            if (mode !== 'group' && poses && poses.frames[index]) {
                identity = identityDiff(anchor.idle, frame, armEnvelope(poses.base, poses.frames[index], poses.pad, poses.offset));
                if (identity.added + identity.removed > identityMax) why.push(`identity ${identity.added}+${identity.removed}px>${identityMax}`);
            }
            let rise = null;
            if (group.name === 'wait' && index === holdIndex) {
                rise = anchor.idle.minY - frame.minY;
                if (rise < clearance) why.push(`hand clears the head by ${rise}px<${clearance}`);
            }
            return {
                frame: index,
                dx: shift.dx,
                dy: shift.dy,
                iou: Number(shift.iou.toFixed(2)),
                line: frame.maxY - anchor.maxY,
                fragments: fragments.map((island) => island.size),
                identity,
                rise,
                pass: why.length === 0,
                why,
            };
        });
        const worst = rows.reduce((acc, row) => ({
            dx: Math.max(acc.dx, row.empty ? Infinity : Math.abs(row.dx)),
            dy: Math.max(acc.dy, row.empty ? Infinity : Math.abs(row.dy)),
            identity: Math.max(acc.identity, row.identity ? row.identity.added + row.identity.removed : 0),
        }), { dx: 0, dy: 0, identity: 0 });
        const entry = { worst, identityMax: poses ? identityMax : null, frames: rows };
        if (mode === 'group' && first) {
            const pose = feetShift(anchor.idle, first);
            entry.offsetFromAnchor = { dx: pose.dx, dy: pose.dy, line: first.maxY - anchor.maxY };
        }
        result.directions[dir] = entry;
        for (const row of rows) {
            if (row.pass) continue;
            result.pass = false;
            result.failingFrames.push(`${dir}#${row.frame}(${row.why.join('; ')})`);
        }
    }
    return result;
}

// ─── fragments and identity ───────────────────────────────────────────────────

// Keypoints for one group and facing from a generator stage .json (its
// `keypoints` field) or an assembler keypoints file (the same object at the
// root): { pad, offset, base: { <long dir>: [18] }, groups: { name: { <long dir>: [[18], …] } } }.
function loadKeypoints(path) {
    if (!path || !existsSync(path)) return null;
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const data = json.keypoints && json.keypoints.groups ? json.keypoints : json;
    return data.groups && data.base ? data : null;
}

function keypointsFor(keypoints, name, dir) {
    const long = SHORT_TO_LONG[dir] || dir;
    const frames = keypoints?.groups?.[name]?.[long];
    const base = keypoints?.base?.[long];
    if (!frames || !base) return null;
    return { frames, base, pad: keypoints.pad || 128, offset: keypoints.offset ?? 18 };
}

// Cells an arm may legitimately repaint: for every arm whose elbow or hand
// moved, capsules along shoulder–elbow–hand in the frame pose (radius 5, the
// hand 7) and in the idle pose (radius 6: a hanging sleeve leaves with it).
function armEnvelope(base, frame, pad, offset) {
    const at = (points, label) => {
        const k = points.find((point) => point.label === label);
        return { x: k.x * pad - offset, y: k.y * pad - offset };
    };
    const envelope = new Uint8Array(CELL * CELL);
    const capsule = (a, b, radius) => {
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)), x1 = Math.min(CELL - 1, Math.ceil(Math.max(a.x, b.x) + radius));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)), y1 = Math.min(CELL - 1, Math.ceil(Math.max(a.y, b.y) + radius));
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
                if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= radius) envelope[y * CELL + x] = 1;
            }
        }
    };
    for (const side of ['RIGHT', 'LEFT']) {
        const moved = ['ELBOW', 'ARM'].some((joint) => {
            const a = at(base, `${side} ${joint}`), b = at(frame, `${side} ${joint}`);
            return Math.hypot(a.x - b.x, a.y - b.y) > 1.5;
        });
        if (!moved) continue;
        for (const [points, radius] of [[frame, 5], [base, 6]]) {
            const shoulder = at(points, `${side} SHOULDER`), elbow = at(points, `${side} ELBOW`), hand = at(points, `${side} ARM`);
            capsule(shoulder, elbow, radius);
            capsule(elbow, hand, radius);
            // The fist and cuff: the model draws the hand up to ~9 px off
            // its joint (measured on the Phase C pilot's settle frames).
            capsule(hand, hand, radius + 4);
        }
    }
    return envelope;
}

// Added: frame pixels outside the envelope with no idle pixel of a close
// colour within 2 px. Removed: idle pixels outside the envelope with no such
// frame pixel. A 1–2 px redraw jitter or a lifted head matches; a flared cape,
// a swapped prop or a re-drawn crest does not.
function identityDiff(idle, frame, envelope) {
    const RADIUS = 2;
    const TOLERANCE = 64;
    const rgb = (cell, p) => {
        const i = ((cell.y0 + ((p / CELL) | 0)) * cell.png.width + cell.x0 + (p % CELL)) * 4;
        return [cell.png.data[i], cell.png.data[i + 1], cell.png.data[i + 2]];
    };
    const close = (a, b) => {
        const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
        return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3 <= TOLERANCE;
    };
    const matched = (from, to, p) => {
        const colour = rgb(from, p);
        const x = p % CELL, y = (p / CELL) | 0;
        for (let dy = -RADIUS; dy <= RADIUS; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= CELL) continue;
            for (let dx = -RADIUS; dx <= RADIUS; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= CELL) continue;
                const q = ny * CELL + nx;
                if (to.mask[q] && close(colour, rgb(to, q))) return true;
            }
        }
        return false;
    };
    const reach = dilate(envelope, CELL, 1);
    let added = 0, removed = 0;
    const drift = [];
    for (let p = 0; p < CELL * CELL; p++) {
        if (reach[p]) continue;
        if (frame.mask[p] && !matched(frame, idle, p)) { added++; drift.push(p); }
        if (idle.mask[p] && !matched(idle, frame, p)) { removed++; drift.push(p); }
    }
    return { added, removed, drift };
}

// ─── output ───────────────────────────────────────────────────────────────────

function printReport(characters) {
    console.log(`[feet-audit] V7 feet audit, tolerance ±${tolerance}px, reference=${reference}, directions ${columns.join(',')}`);
    for (const character of characters) {
        const anchors = Object.entries(character.anchors)
            .map(([dir, a]) => `${dir} cx2=${a.cx2} maxY=${a.maxY}`).join('  ');
        console.log(`\n${character.id}\n  anchor  ${anchors}`);
        for (const group of character.base || []) printGroup('base', group);
        for (const strip of character.strips) {
            console.log(`  ${strip.label} ${strip.path}`);
            for (const group of strip.groups) printGroup(group.pass ? 'PASS' : 'FAIL', group);
        }
        if (!character.strips.length && !character.base) console.log('  (no action strip)');
    }
    console.log(failures.length
        ? `\n[feet-audit] ${failures.length} group(s) fail (feet outside ±${tolerance}px, fragment ≥ ${islandMin}px, identity, or wait clearance < ${clearance}px):\n  ${failures.join('\n  ')}`
        : `\n[feet-audit] every audited strip frame passes (feet within ±${tolerance}px, no fragment, identity held, wait clearance)`);
}

function printGroup(status, group) {
    const cells = Object.entries(group.directions).map(([dir, entry]) => {
        const steps = entry.frames.map((row) => (row.empty ? '∅' : `${signed(row.dx)}/${signed(row.dy)}`)).join(' ');
        const pose = entry.offsetFromAnchor
            ? ` [pose vs idle ${signed(entry.offsetFromAnchor.dx)}/${signed(entry.offsetFromAnchor.dy)}]`
            : '';
        const identity = entry.identityMax !== null && entry.identityMax !== undefined
            ? ` id≤${entry.worst.identity}/${entry.identityMax}`
            : ' id n/a';
        const fragments = entry.frames.reduce((sum, row) => sum + (row.fragments?.length || 0), 0);
        const rise = entry.frames.find((row) => row.rise !== null && row.rise !== undefined)?.rise;
        return `${dir}: ${steps}${pose}${identity}${fragments ? ` frag×${fragments}` : ''}${rise !== undefined ? ` rise ${rise}` : ''}`;
    });
    console.log(`    ${status.padEnd(4)} ${group.name} rows ${group.rows.join('–')} feet dx/dy  ${cells.join('  |  ')}`);
}

// 2× review sheet: each audited cell with the anchor foot line (dotted cyan),
// the reference feet outline where the feet must stay (cyan), and a bar under
// the cell, green when the matched feet shift is within tolerance, red when
// not. Output-only evidence; never an asset.
function writeContactSheet(path, tiles) {
    const scale = 2;
    const cyan = [90, 210, 230, 255];
    const rows = tiles.flatMap((tile) => columns.map((dir) => ({ ...tile, dir })));
    const maxFrames = Math.max(...tiles.map((tile) => tile.group.rows[1] - tile.group.rows[0] + 1));
    const out = new PNG({ width: maxFrames * CELL * scale, height: rows.length * CELL * scale });
    fillChecker(out);
    rows.forEach((item, rowIndex) => {
        const col = DIRECTIONS.indexOf(item.dir);
        const anchor = item.anchors[col];
        const ref = reference === 'group' ? measureCell(item.png, col, item.group.rows[0]) || anchor.idle : anchor.idle;
        const top = Math.max(0, ref.maxY - FOOT_WINDOW + 1);
        for (let frame = 0; frame <= item.group.rows[1] - item.group.rows[0]; frame++) {
            const srcRow = item.group.rows[0] + frame;
            const ox = frame * CELL * scale;
            const oy = rowIndex * CELL * scale;
            for (let y = 0; y < CELL; y++) {
                for (let x = 0; x < CELL; x++) {
                    const si = ((srcRow * CELL + y) * item.png.width + col * CELL + x) * 4;
                    if (item.png.data[si + 3] === 0) continue;
                    for (let sy = 0; sy < scale; sy++) {
                        for (let sx = 0; sx < scale; sx++) blend(out, ox + x * scale + sx, oy + y * scale + sy, item.png.data, si);
                    }
                }
            }
            const lineY = oy + anchor.maxY * scale + scale;
            for (let x = 0; x < CELL * scale; x += 3) setPixel(out, ox + x, lineY, cyan);
            for (let y = top; y <= ref.maxY; y++) {
                for (let x = 0; x < CELL; x++) {
                    if (!ref.mask[y * CELL + x]) continue;
                    const edge = x === 0 || x === CELL - 1 || !ref.mask[y * CELL + x - 1] || !ref.mask[y * CELL + x + 1]
                        || (y < CELL - 1 && !ref.mask[(y + 1) * CELL + x]);
                    if (edge) setPixel(out, ox + x * scale, oy + y * scale, cyan);
                }
            }
            const frameCell = measureCell(item.png, col, srcRow);
            const shift = frameCell ? feetShift(ref, frameCell) : null;
            const ok = shift && Math.abs(shift.dx) <= tolerance && Math.abs(shift.dy) <= tolerance;
            // Green: every check passes. Red: the feet moved. Amber: the feet
            // hold but a fragment, identity or wait-clearance check fails.
            const row = item.result?.directions?.[item.dir]?.frames?.[frame];
            // Identity drift pixels (outside the arm envelope, unmatched) in magenta.
            for (const p of row?.identity?.drift || []) {
                setPixel(out, ox + (p % CELL) * scale, oy + ((p / CELL) | 0) * scale, [236, 64, 220, 255]);
                setPixel(out, ox + (p % CELL) * scale + 1, oy + ((p / CELL) | 0) * scale, [236, 64, 220, 255]);
            }
            const colour = !ok ? [240, 80, 70, 255] : row && !row.pass ? [240, 180, 60, 255] : [110, 220, 110, 255];
            const barY = oy + CELL * scale - 4;
            for (let x = 4; x < CELL * scale - 4; x++) {
                setPixel(out, ox + x, barY, colour);
                setPixel(out, ox + x, barY + 1, colour);
            }
        }
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(out));
    console.log(`[feet-audit] contact sheet ${relative(path)} (${out.width}×${out.height})`);
}

function fillChecker(png) {
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const dark = ((x >> 3) + (y >> 3)) % 2 === 0;
            setPixel(png, x, y, dark ? [34, 34, 40, 255] : [46, 46, 52, 255]);
        }
    }
}

function blend(dst, x, y, src, si) {
    const di = (y * dst.width + x) * 4;
    const a = src[si + 3] / 255;
    for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round(src[si + c] * a + dst.data[di + c] * (1 - a));
    dst.data[di + 3] = 255;
}

function setPixel(png, x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseGroups(text) {
    return list(text).map((spec) => {
        const match = /^([a-zA-Z][\w-]*):(\d+)-(\d+)$/.exec(spec);
        if (!match || Number(match[3]) < Number(match[2])) fail(`bad group "${spec}"; use name:first-last`);
        return { name: match[1], rows: [Number(match[2]), Number(match[3])] };
    });
}

function readPng(path) {
    return PNG.sync.read(readFileSync(path));
}

function resolvePath(path) {
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function relative(path) {
    return path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\//, '') : path;
}

function signed(value) {
    return value > 0 ? `+${value}` : `${value}`;
}

function fail(message) {
    console.error(`[feet-audit] ${message}`);
    process.exit(2);
}
