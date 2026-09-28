#!/usr/bin/env node
// Ship reviewed pose strips into a character's action strip (plan 7.3 work
// and wait, 7.1 sit). One writer per `characters/<id>/actions.png`: this
// script rebuilds it from
//   - every group the manifest already declares (the shipped cells, verbatim),
//   - staged generate-pose-strip.mjs candidates (--stage, their .json sidecar
//     carries layout, jobs and per-frame keypoints), and
//   - the staged 7.1 sit cells (output/waking-isle/Villagers/sit/<id>.sit.png
//     + .sit.json { groups: { sit: { hold } }, seatLine: { <dir>: y } }),
// with staged groups replacing shipped groups of the same name. Row order:
// read, wait, sit, strike, tinker, gaze, then anything else. Only facings a
// staged group actually authored are declared (`directions`), so the runtime
// never resolves an empty cell.
//
// It never edits manifest.yaml (a shared file): it prints the `actionStrip`
// record to paste, writes output/action-strips/<id>.keypoints.json for
// feet-audit's identity check on the shipped strip, and leaves the companion
// channels to `node scripts/sprites/author-roster-channels.mjs`.
//
// Usage:
//   node scripts/sprites/assemble-action-strip.mjs --id=agent.claude.sonnet \
//       --stage=output/pose-strips/agent.claude.sonnet.strike+tinker+wait.png [--groups=wait,strike]
//   … --no-sit        ignore a staged sit strip
//   … --dry           print the record, write nothing
// Audit the result: node scripts/sprites/feet-audit.mjs --id=<id>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { collectSpriteEntries, loadSpriteManifest, repoRoot, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const SHORT = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const ORDER = ['read', 'wait', 'sit', 'strike', 'tinker', 'gaze'];

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const list = (value) => (value || '').split(',').map((item) => item.trim()).filter(Boolean);

const id = option('id');
if (!id) fail('--id=<manifest character id> is required');
const entry = collectSpriteEntries(loadSpriteManifest()).find((candidate) => candidate.id === id);
if (!entry) fail(`${id} is not a manifest character`);
const only = new Set(list(option('groups')));
const dry = flag('dry');

// name → { png, rows: [a, b] (source rows), hold (source row), extra: {...}, keypoints, base }
const sources = new Map();

if (entry.actionStrip?.path) {
    const path = join(spritesRoot, entry.actionStrip.path);
    if (existsSync(path)) {
        const png = PNG.sync.read(readFileSync(path));
        for (const [name, group] of Object.entries(entry.actionStrip.groups || {})) {
            const { rows, hold, ...extra } = group;
            sources.set(name, { png, rows, hold, extra, origin: 'shipped' });
        }
    }
}

const keypoints = { pad: 128, offset: 18, base: {}, groups: {} };
const shippedKeypoints = join(repoRoot, 'output', 'action-strips', `${id}.keypoints.json`);
if (existsSync(shippedKeypoints)) {
    const previous = JSON.parse(readFileSync(shippedKeypoints, 'utf8'));
    Object.assign(keypoints.base, previous.base || {});
    Object.assign(keypoints.groups, previous.groups || {});
}
const jobs = {};

for (const stagePath of list(option('stage')).map((path) => join(repoRoot, path))) {
    if (!existsSync(stagePath)) fail(`stage ${stagePath} does not exist`);
    const png = PNG.sync.read(readFileSync(stagePath));
    const sidecar = stagePath.replace(/\.png$/, '.json');
    if (!existsSync(sidecar)) fail(`stage ${stagePath} has no .json sidecar`);
    const meta = JSON.parse(readFileSync(sidecar, 'utf8'));
    if (meta.id !== id) fail(`${sidecar} is for ${meta.id}, not ${id}`);
    for (const [name, group] of Object.entries(meta.groups || {})) {
        if (only.size && !only.has(name)) continue;
        const extra = {};
        if (Number.isInteger(group.contactFrame)) extra.contactFrame = group.contactFrame;
        sources.set(name, { png, rows: group.rows, hold: group.hold, extra, origin: 'stage' });
        if (meta.keypoints?.groups?.[name]) {
            keypoints.groups[name] = meta.keypoints.groups[name];
            Object.assign(keypoints.base, meta.keypoints.base || {});
        }
        // One job per facing per clip: groups packed into one clip share it.
        const clipName = meta.jobs?.[name]?.clip || name;
        const dirs = meta.jobs?.[name]?.directions || {};
        for (const [direction, job] of Object.entries(dirs)) {
            if (job?.jobId) (jobs[clipName] ||= {})[SHORT[DIRECTIONS.indexOf(direction)]] = job.jobId;
        }
    }
}

const sitPath = join(repoRoot, 'output', 'waking-isle', 'Villagers', 'sit', `${id}.sit.png`);
if (!flag('no-sit') && existsSync(sitPath) && (!only.size || only.has('sit'))) {
    const png = PNG.sync.read(readFileSync(sitPath));
    const sidecar = sitPath.replace(/\.png$/, '.json');
    const meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : {};
    const rowsCount = png.height / CELL;
    const holdRel = Number.isInteger(meta.groups?.sit?.hold) ? meta.groups.sit.hold : rowsCount - 1;
    const extra = {};
    if (meta.seatLine) extra.seatLine = meta.seatLine;
    // Job ids only; the full pose params, seeds and prompts stay in the .sit.json.
    if (meta.provenance) extra.provenance = { route: meta.provenance.route, jobs: { se: meta.provenance.jobs?.['south-east']?.jobId, sw: meta.provenance.jobs?.['south-west']?.jobId } };
    sources.set('sit', { png, rows: [0, rowsCount - 1], hold: holdRel, extra, origin: 'stage' });
}

if (!sources.size) fail(`${id}: nothing to assemble`);
for (const [name, source] of sources) {
    if (source.png.width !== CELL * DIRECTIONS.length || source.png.height % CELL !== 0) fail(`${name}: source is not 8 columns of ${CELL}px cells`);
}

// ─── layout ───────────────────────────────────────────────────────────────────

const names = [...sources.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const layout = {};
let row = 0;
for (const name of names) {
    const source = sources.get(name);
    const count = source.rows[1] - source.rows[0] + 1;
    const group = { rows: [row, row + count - 1] };
    // Shipped holds are absolute rows; staged holds (generator layouts and the
    // sit json) are group-relative frame indexes.
    const hold = !Number.isInteger(source.hold) ? source.rows[1]
        : source.origin === 'stage' ? source.rows[0] + source.hold : source.hold;
    group.hold = row + Math.min(count - 1, Math.max(0, hold - source.rows[0]));
    const authored = SHORT.filter((_, col) => columnHasPixels(source.png, col, source.rows));
    Object.assign(group, source.extra);
    if (source.origin === 'stage') {
        if (authored.length < SHORT.length) group.directions = authored;
        else delete group.directions;
        const contact = contactPoints(name, group.contactFrame);
        if (contact) group.contact = contact;
    }
    layout[name] = group;
    row += count;
}

const out = new PNG({ width: CELL * DIRECTIONS.length, height: CELL * row });
for (const name of names) {
    const source = sources.get(name);
    const count = source.rows[1] - source.rows[0] + 1;
    PNG.bitblt(source.png, out, 0, source.rows[0] * CELL, out.width, count * CELL, 0, layout[name].rows[0] * CELL);
}

const relPath = entry.actionStrip?.path || `characters/${id}/actions.png`;
const record = {
    path: relPath,
    cell: CELL,
    groups: layout,
    grip: entry.actionStrip?.grip || { hand: 'both', sheathe: true },
    provenance: {
        // A character's first strip starts from its sheet's character id.
        ...(entry.actionStrip?.provenance || (entry.provenance?.characterId ? { characterId: entry.provenance.characterId } : {})),
        // Skeleton candidates use the padded canvas, not the 92px packed cell.
        generationSize: entry.actionStrip?.provenance?.generationSize ?? keypoints.pad,
        ...(Object.keys(jobs).length ? { poseStrips: { generationMode: 'skeleton-v3', jobs: mergeJobs(entry.actionStrip?.provenance?.poseStrips?.jobs, jobs) } } : {}),
    },
};

console.log(`[assemble] ${id}: ${names.map((name) => `${name} ${layout[name].rows.join('–')}${sources.get(name).origin === 'stage' ? '*' : ''}`).join(', ')} (${out.width}×${out.height}; * = staged)`);
// One group and one provenance key per line keeps every manifest line short
// enough to review and hand-edit.
console.log('    actionStrip:');
console.log(`      path: ${record.path}`);
console.log(`      cell: ${record.cell}`);
console.log('      groups:');
for (const [name, group] of Object.entries(record.groups)) console.log(`        ${name}: ${flow(group)}`);
console.log(`      grip: ${flow(record.grip)}`);
console.log('      provenance:');
for (const [key, value] of Object.entries(record.provenance)) console.log(`        ${key}: ${flow(value)}`);
if (dry) process.exit(0);

const target = join(spritesRoot, relPath);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, PNG.sync.write(out));
mkdirSync(dirname(shippedKeypoints), { recursive: true });
const shippedGroups = Object.fromEntries(Object.entries(keypoints.groups).filter(([name]) => layout[name]));
writeFileSync(shippedKeypoints, `${JSON.stringify({ ...keypoints, groups: shippedGroups })}\n`);
console.log(`[assemble] wrote ${relPath} and ${shippedKeypoints.slice(repoRoot.replace(/\/$/, '').length + 1)}; next: paste the record into manifest.yaml, run author-roster-channels.mjs, then feet-audit --id=${id}`);

// ─── helpers ──────────────────────────────────────────────────────────────────

function rank(name) {
    const index = ORDER.indexOf(name);
    return index < 0 ? ORDER.length : index;
}

function columnHasPixels(png, col, rows) {
    for (let y = rows[0] * CELL; y < (rows[1] + 1) * CELL; y++) {
        for (let x = col * CELL; x < (col + 1) * CELL; x++) if (png.data[(y * png.width + x) * 4 + 3] >= 16) return true;
    }
    return false;
}

// The contact frame's gesture hand (the hand joint that moved furthest from
// the idle skeleton) per facing, in cell px.
function contactPoints(name, contactFrame) {
    if (!Number.isInteger(contactFrame)) return null;
    const perDirection = keypoints.groups[name];
    if (!perDirection) return null;
    const contact = {};
    for (const [direction, frames] of Object.entries(perDirection)) {
        const base = keypoints.base[direction];
        const frame = frames?.[contactFrame];
        if (!base || !frame) continue;
        const at = (points, label) => points.find((point) => point.label === label);
        let best = null;
        for (const side of ['RIGHT', 'LEFT']) {
            const a = at(base, `${side} ARM`), b = at(frame, `${side} ARM`);
            const moved = Math.hypot(a.x - b.x, a.y - b.y);
            if (!best || moved > best.moved) best = { moved, point: b };
        }
        const x = Math.round(best.point.x * keypoints.pad - keypoints.offset);
        const y = Math.round(best.point.y * keypoints.pad - keypoints.offset);
        contact[SHORT[DIRECTIONS.indexOf(direction)]] = [Math.max(0, Math.min(CELL - 1, x)), Math.max(0, Math.min(CELL - 1, y))];
    }
    return Object.keys(contact).length ? contact : null;
}

function mergeJobs(previous, next) {
    return { ...(previous || {}), ...next };
}

// Flow-style YAML (the manifest's actionStrip convention).
function flow(value) {
    if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
    if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${/^[\w-]+$/.test(key) ? key : JSON.stringify(key)}: ${flow(item)}`).join(', ')} }`;
    if (typeof value === 'string') return /^[a-z][\w./]*(?:-[a-z][\w./]*)*$/i.test(value) ? value : JSON.stringify(value);
    return String(value);
}

function fail(message) {
    console.error(`[assemble] ${message}`);
    process.exit(2);
}
