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
// Exit code 1 when any audited strip frame exceeds the tolerance.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { collectSpriteEntries, loadSpriteManifest, repoRoot, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
// SpriteSheet.DIRECTIONS column order.
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const LONG_DIRECTIONS = {
    south: 's', 'south-east': 'se', east: 'e', 'north-east': 'ne',
    north: 'n', 'north-west': 'nw', west: 'w', 'south-west': 'sw',
};
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
        strips.push({ path: resolvePath(stripOption), groups: parseGroups(groupsOption), label: 'candidate' });
    } else if (entry.actionStrip?.path) {
        strips.push({
            path: join(spritesRoot, entry.actionStrip.path),
            groups: Object.entries(entry.actionStrip.groups || {}).map(([name, group]) => ({ name, rows: group.rows })),
            label: 'shipped',
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
            groups.push(auditGroup(png, group, anchors));
            if (contactSheetPath) sheetTiles.push({ id, png, group, anchors });
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
    console.log(JSON.stringify({ tolerance, reference, failures, characters: report }, null, 2));
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
    return { minX, minY, maxX, maxY, cx2: minX + maxX, mask };
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

function auditGroup(png, group, anchors, { reference: mode = reference } = {}) {
    const result = { name: group.name, rows: group.rows, reference: mode, directions: {}, failingFrames: [], pass: true };
    for (const dir of columns) {
        const col = DIRECTIONS.indexOf(dir);
        const anchor = anchors[col];
        const frames = [];
        for (let row = group.rows[0]; row <= group.rows[1]; row++) frames.push(measureCell(png, col, row));
        const first = frames[0];
        const ref = mode === 'group' && first ? first : anchor.idle;
        const rows = frames.map((frame, index) => {
            if (!frame) return { frame: index, empty: true, pass: false };
            const shift = feetShift(ref, frame);
            const pass = Math.abs(shift.dx) <= tolerance && Math.abs(shift.dy) <= tolerance;
            return {
                frame: index,
                dx: shift.dx,
                dy: shift.dy,
                iou: Number(shift.iou.toFixed(2)),
                line: frame.maxY - anchor.maxY,
                pass,
            };
        });
        const worst = rows.reduce((acc, row) => ({
            dx: Math.max(acc.dx, row.empty ? Infinity : Math.abs(row.dx)),
            dy: Math.max(acc.dy, row.empty ? Infinity : Math.abs(row.dy)),
        }), { dx: 0, dy: 0 });
        const entry = { worst, frames: rows };
        if (mode === 'group' && first) {
            const pose = feetShift(anchor.idle, first);
            entry.offsetFromAnchor = { dx: pose.dx, dy: pose.dy, line: first.maxY - anchor.maxY };
        }
        result.directions[dir] = entry;
        for (const row of rows) {
            if (row.pass) continue;
            result.pass = false;
            result.failingFrames.push(row.empty ? `${dir}#${row.frame}(empty)` : `${dir}#${row.frame}(dx${signed(row.dx)},dy${signed(row.dy)})`);
        }
    }
    return result;
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
        ? `\n[feet-audit] ${failures.length} group(s) outside ±${tolerance}px:\n  ${failures.join('\n  ')}`
        : `\n[feet-audit] every audited strip frame is within ±${tolerance}px`);
}

function printGroup(status, group) {
    const cells = Object.entries(group.directions).map(([dir, entry]) => {
        const steps = entry.frames.map((row) => (row.empty ? '∅' : `${signed(row.dx)}/${signed(row.dy)}`)).join(' ');
        const pose = entry.offsetFromAnchor
            ? ` [pose vs idle ${signed(entry.offsetFromAnchor.dx)}/${signed(entry.offsetFromAnchor.dy)}]`
            : '';
        return `${dir}: ${steps}${pose}`;
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
            const barY = oy + CELL * scale - 4;
            for (let x = 4; x < CELL * scale - 4; x++) {
                setPixel(out, ox + x, barY, ok ? [110, 220, 110, 255] : [240, 80, 70, 255]);
                setPixel(out, ox + x, barY + 1, ok ? [110, 220, 110, 255] : [240, 80, 70, 255]);
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
