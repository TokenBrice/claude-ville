#!/usr/bin/env node
// Generate candidate pose strips (plan 7.3 work/wait, 7.1 sit) for one
// character and stage them in the action-strip layout (8 direction columns ×
// the groups' rows of the 92 px engine cell, SpriteSheet.DIRECTIONS order).
// Output is staged only: nothing here writes the manifest or the shipped
// `characters/<id>/actions.png`; a reviewed strip is promoted separately.
//
// Two routes, both REST through the `.dev.vars` token (never printed):
//   skeleton  POST /animate-with-skeleton-v3. The first frame is the
//             direction's base-sheet idle row-6 cell (padded to 128², the
//             estimate-skeleton size), its 18 joints come from
//             /estimate-skeleton (0.1 generation, cached), and every frame's
//             joints are that skeleton with arm/torso deltas only: hip, knee
//             and ankle are copied verbatim (V7 pinned feet). Held groups
//             (`sit`) bend hip/knee/ankle once and then hold them.
//   template  POST /characters/animations mode "template" on the PixelLab rig
//             (manifest provenance.characterId), e.g. `crouching` for the sit
//             pilot: 1 generation per direction, frames at the rig canvas,
//             centred into the 92 px cell like generate-action-strip.mjs.
// Every paid call goes through pixellab-spend.mjs: live balance before and
// after, refusal below --floor, one ledger line per job.
//
// Usage:
//   node scripts/sprites/generate-pose-strip.mjs --id=agent.claude.sonnet --groups=strike,wait \
//       --directions=east,west,south-east,south-west --floor=1172 --item=7.3 --plan
//   node scripts/sprites/generate-pose-strip.mjs --id=agent.codex.gpt55 --groups=sit-template \
//       --directions=south-east,south-west,east,west --item=7.1
//   … --assemble-only        re-assemble from the cache, no spend
//   … --force=<group>        re-request a cached group (new seed)
//   Output: --out=<dir> (default output/pose-strips) → <id>.<groups>.png + .json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import {
    blitPng,
    characterAnimationFrames,
    fetchPng,
    fitCenterToCell,
    getCharacter,
    hashSeed,
    readPixellabToken,
    repoRoot,
    waitForCharacterAnimation,
} from './pixellab-rest.mjs';
import { api, createSpend, waitForBackgroundJob } from './pixellab-spend.mjs';
import { collectSpriteEntries, loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

const CELL = 92;
const PAD = 128;
const OFFSET = (PAD - CELL) / 2;
const IDLE_ROW = 6;
const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
// Screen-space "forward" for a horizontal arm, per facing (low top-down: side
// facings read full length, the diagonal facings lean toward the camera).
const FORWARD = {
    east: [1, 0], west: [-1, 0],
    'south-east': [0.82, 0.32], 'south-west': [-0.82, 0.32],
    'north-east': [0.82, -0.32], 'north-west': [-0.82, -0.32],
    south: [0.35, 0.3], north: [-0.35, -0.3],
};
// Skeleton-v3 bills by clip length: 3 frames = 2, 8 = 3, 15 = 4 (worst case
// for the refusal check; the ledger records what was actually charged).
const skeletonCost = (frames) => (frames <= 3 ? 2 : frames <= 8 ? 3 : 4);
const ESTIMATE_COST = 1;

// Named groups. `frames` are arm/torso poses for the skeleton route: arm
// angles in degrees from hanging straight down, positive toward forward
// (180 = straight up, > 180 = up and behind); `lean` shifts head, neck and
// shoulders by [forward px, down px]; `seat` (0–1) bends hip/knee/ankle once.
const GROUPS = Object.freeze({
    // Edit/Write/apply_patch at the Forge: wind-up, cock, downswing, contact
    // (the WorkDownbeats contact frame, index 3), recoil, settle.
    strike: {
        route: 'skeleton',
        action: 'hammer strike',
        held: 'gripping a small iron smithing hammer in the raised hand',
        frames: [
            { upper: 140, fore: 170 },
            { upper: 165, fore: 205 },
            { upper: 110, fore: 95 },
            { upper: 55, fore: 60, lean: [1.5, 1] },
            { upper: 70, fore: 100, lean: [0.5, 0] },
            { upper: 30, fore: 25 },
        ],
        contactFrame: 3,
        hold: 5,
    },
    // Waiting on the operator (the action-needed pose): the near hand rises
    // once, open and empty, and holds. Static after the raise.
    wait: {
        route: 'skeleton',
        action: 'raise hand and wait',
        held: 'both hands empty, the raised hand open with the palm forward',
        frames: [
            { upper: 70, fore: 120 },
            { upper: 135, fore: 178 },
            { upper: 135, fore: 178 },
        ],
        hold: 2,
    },
    // Rest seat, heavy-armour route: sit down once and hold (hands on thighs).
    sit: {
        route: 'skeleton',
        action: 'sit down',
        held: 'hands resting on the thighs',
        frames: [
            { seat: 0.5, upper: 25, fore: 45 },
            { seat: 1, upper: 20, fore: 70 },
            { seat: 1, upper: 20, fore: 70 },
        ],
        hold: 2,
    },
    // Rest seat, template route: PixelLab's `crouching` humanoid template.
    'sit-template': {
        route: 'template',
        template: 'crouching',
        // Template records come back with display_name null and
        // animation_type = the template id, so the group is found by type.
        animationName: 'crouching',
    },
});

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const list = (value) => (value || '').split(',').map((item) => item.trim()).filter(Boolean);

const id = option('id');
const groupNames = list(option('groups'));
const directions = list(option('directions') || 'east,west,south-east,south-west');
const plan = flag('plan');
const assembleOnly = flag('assemble-only');
const forced = new Set(list(option('force')));
const floor = Number(option('floor', '272'));
const item = option('item', 'pose-strip');
const agent = option('agent', 'AssetsA');
const outDir = join(repoRoot, option('out', join('output', 'pose-strips')));
const cacheDir = join(repoRoot, 'output', 'pose-strip-cache', id || '_');
const descriptionOverride = option('description');
// `--snap=sheet` (default) snaps every generated pixel to the nearest colour
// already on the character's base sheet, so a strip frame never introduces a
// colour the walk/idle cells do not carry (no shimmer on the cell swap).
const snapMode = option('snap', 'sheet');

if (!id) fail('--id=<manifest character id> is required');
if (!groupNames.length) fail(`--groups= one or more of ${Object.keys(GROUPS).join(', ')}`);
for (const name of groupNames) if (!GROUPS[name]) fail(`unknown group "${name}"`);
for (const name of directions) if (!DIRECTIONS.includes(name)) fail(`unknown direction "${name}"`);

const entry = collectSpriteEntries(loadSpriteManifest()).find((candidate) => candidate.id === id);
if (!entry) fail(`${id} is not a manifest character`);
const sheet = PNG.sync.read(readFileSync(join(spritesRoot, 'characters', id, 'sheet.png')));
const sheetPalette = snapMode === 'sheet' ? paletteOf(sheet) : null;
const snapStats = { pixels: 0, moved: 0, maxDistance: 0 };
const snapMemo = new Map();
const token = readPixellabToken();
const spend = createSpend({ token, agent, floor });
const description = descriptionOverride || subjectOf(entry.prompt || id);
const rel = (path) => path.slice(repoRoot.length).replace(/^\//, '');

// ─── plan ─────────────────────────────────────────────────────────────────────

const quote = groupNames.map((name) => {
    const group = GROUPS[name];
    const perDirection = group.route === 'skeleton' ? skeletonCost(group.frames.length) : 1;
    return { name, route: group.route, perDirection, total: perDirection * directions.length };
});
const worst = quote.reduce((sum, row) => sum + row.total, 0) + (quote.some((row) => row.route === 'skeleton') ? directions.length * 0.1 : 0);
console.log(`[pose-strip] ${id}: ${quote.map((row) => `${row.name} (${row.route}) ${row.perDirection}×${directions.length}=${row.total}`).join(', ')}; worst case ≈ ${worst} generations`);
console.log(`[pose-strip] balance ${await spend.balance()}, floor ${spend.floor}; description "${description}"`);
if (plan) process.exit(0);

// ─── generate ─────────────────────────────────────────────────────────────────

const provenance = { id, description, groups: {} };
const groupCells = new Map();
for (const name of groupNames) {
    const group = GROUPS[name];
    const cells = new Map();
    provenance.groups[name] = { route: group.route, directions: {} };
    for (const direction of directions) {
        const result = group.route === 'skeleton'
            ? await skeletonDirection(name, group, direction)
            : await templateDirection(name, group, direction);
        cells.set(direction, result.cells);
        provenance.groups[name].directions[direction] = result.provenance;
    }
    groupCells.set(name, cells);
}

// ─── assemble ─────────────────────────────────────────────────────────────────

const layout = {};
let row = 0;
for (const name of groupNames) {
    const count = Math.max(...[...groupCells.get(name).values()].map((cells) => cells.length));
    layout[name] = { rows: [row, row + count - 1], hold: GROUPS[name].hold ?? count - 1 };
    if (GROUPS[name].contactFrame !== undefined) layout[name].contactFrame = GROUPS[name].contactFrame;
    row += count;
}
const strip = new PNG({ width: CELL * DIRECTIONS.length, height: CELL * row });
for (const name of groupNames) {
    for (const [direction, cells] of groupCells.get(name)) {
        cells.forEach((cell, index) => blitPng(cell, strip, DIRECTIONS.indexOf(direction) * CELL, (layout[name].rows[0] + index) * CELL));
    }
}
mkdirSync(outDir, { recursive: true });
const stem = `${id}.${groupNames.join('+')}`;
writeFileSync(join(outDir, `${stem}.png`), PNG.sync.write(strip));
writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify({ ...provenance, cell: CELL, groups: layout, jobs: provenance.groups }, null, 2)}\n`);
console.log(`[pose-strip] wrote ${rel(join(outDir, `${stem}.png`))} (${strip.width}×${strip.height}); groups ${JSON.stringify(layout)}`);
if (sheetPalette) console.log(`[pose-strip] palette snap: ${snapStats.moved}/${snapStats.pixels} px moved onto the ${sheetPalette.length}-colour sheet palette (max RGB distance ${snapStats.maxDistance.toFixed(1)})`);
console.log(`[pose-strip] audit: node scripts/sprites/feet-audit.mjs --id=${id} --strip=${rel(join(outDir, `${stem}.png`))} --groups=${Object.entries(layout).map(([name, g]) => `${name}:${g.rows[0]}-${g.rows[1]}`).join(',')}`);

// ─── skeleton route ───────────────────────────────────────────────────────────

async function skeletonDirection(name, group, direction) {
    const firstFrame = paddedIdleCell(direction);
    const firstFramePng = PNG.sync.write(firstFrame);
    const base = await estimatedSkeleton(direction, firstFramePng);
    const frames = group.frames.map((pose) => poseSkeleton(base, pose, direction));
    const jobPath = join(cacheDir, `${name}-${direction}.job.json`);
    let job = existsSync(jobPath) && !forced.has(name) ? JSON.parse(readFileSync(jobPath, 'utf8')) : null;
    if (!job) {
        if (assembleOnly) fail(`${name}/${direction} has no cached job and --assemble-only was requested`);
        const seed = hashSeed(`${id}:${name}:${direction}:${forced.has(name) ? Date.now() : 0}`);
        const body = {
            description: `${description}, ${group.held}`,
            action: group.action,
            direction,
            view: 'low top-down',
            first_frame: { type: 'base64', base64: firstFramePng.toString('base64'), format: 'png' },
            first_frame_keypoints: base,
            keypoints: frames,
            template_id: 'mannequin',
            seed,
            no_background: true,
        };
        job = await spend.job({
            item,
            endpoint: '/animate-with-skeleton-v3',
            target: `${id} ${name} ${direction} (${frames.length} frames)`,
            maxCost: skeletonCost(frames.length),
            run: async () => {
                const queued = await api(token, '/animate-with-skeleton-v3', { method: 'POST', body, label: `${name}/${direction}` });
                const jobId = queued?.background_job_id || queued?.data?.background_job_id || queued?.job_id;
                if (!jobId) throw new Error(`no background_job_id in ${JSON.stringify(queued).slice(0, 300)}`);
                const done = await waitForBackgroundJob(token, jobId, { label: `${name}/${direction}` });
                return { jobId, seed, usage: queued?.usage || done?.usage || null, images: imagesOf(done), ledgerDetail: { jobId, seed } };
            },
        });
        mkdirSync(dirname(jobPath), { recursive: true });
        writeFileSync(jobPath, JSON.stringify({ ...job, keypoints: frames, firstFrameKeypoints: base }));
    }
    const cells = [];
    for (let index = 0; index < job.images.length; index++) {
        const png = await imagePng(job.images[index], `${name}-${direction}-${index}`);
        writePng(join(cacheDir, `${name}-${direction}-${index}.png`), png);
        cells.push(snapToSheet(cropPadded(png)));
    }
    if (cells.length !== group.frames.length) fail(`${name}/${direction}: ${cells.length} frames returned, ${group.frames.length} requested`);
    return { cells, provenance: { jobId: job.jobId, seed: job.seed, usage: job.usage } };
}

function paddedIdleCell(direction) {
    const col = DIRECTIONS.indexOf(direction);
    const out = new PNG({ width: PAD, height: PAD });
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const si = ((IDLE_ROW * CELL + y) * sheet.width + col * CELL + x) * 4;
            const di = ((y + OFFSET) * PAD + x + OFFSET) * 4;
            for (let c = 0; c < 4; c++) out.data[di + c] = sheet.data[si + c];
        }
    }
    return out;
}

function cropPadded(png) {
    // Frames come back at the first frame's 128² canvas; the character stays
    // where the idle cell put it, so the centre 92² is the engine cell.
    if (png.width !== PAD || png.height !== PAD) return fitCenterToCell(png, CELL);
    const out = new PNG({ width: CELL, height: CELL });
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const si = ((y + OFFSET) * PAD + x + OFFSET) * 4;
            const di = (y * CELL + x) * 4;
            for (let c = 0; c < 4; c++) out.data[di + c] = png.data[si + c];
        }
    }
    return out;
}

async function estimatedSkeleton(direction, firstFramePng) {
    const path = join(cacheDir, `estimate-${direction}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    if (assembleOnly) fail(`no cached skeleton for ${direction} and --assemble-only was requested`);
    const result = await spend.job({
        item,
        endpoint: '/estimate-skeleton',
        target: `${id} ${direction} idle row ${IDLE_ROW}`,
        maxCost: ESTIMATE_COST,
        run: () => api(token, '/estimate-skeleton', {
            method: 'POST',
            label: `estimate ${direction}`,
            body: { image: { type: 'base64', base64: firstFramePng.toString('base64'), format: 'png' } },
        }),
    });
    const keypoints = (result?.keypoints || []).map(({ x, y, label, z_index: z }) => ({ x, y, label, z_index: Math.round(z ?? 0) }));
    if (keypoints.length !== 18) fail(`estimate for ${direction} returned ${keypoints.length} joints`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(keypoints, null, 1));
    return keypoints;
}

// Arm/torso deltas only. Hip, knee and ankle are copied verbatim unless the
// pose sits (then they bend once and later frames repeat the same numbers).
function poseSkeleton(base, pose, direction) {
    const px = Object.fromEntries(base.map((k) => [k.label, { ...k, x: k.x * PAD, y: k.y * PAD }]));
    const [fx, fy] = FORWARD[direction];
    // Near side = the shoulder drawn on top (higher z_index).
    const near = (px['RIGHT SHOULDER'].z_index ?? 0) >= (px['LEFT SHOULDER'].z_index ?? 0) ? 'RIGHT' : 'LEFT';
    const far = near === 'RIGHT' ? 'LEFT' : 'RIGHT';
    const ankleY = Math.max(px['RIGHT LEG'].y, px['LEFT LEG'].y);
    const bodyH = Math.max(20, ankleY - px.NOSE.y);
    const upperLen = Math.max(dist(px[`${near} SHOULDER`], px[`${near} ELBOW`]), 0.2 * bodyH);
    const foreLen = Math.max(dist(px[`${near} ELBOW`], px[`${near} ARM`]), 0.18 * bodyH);
    const armPoint = (from, length, degrees) => {
        const t = (degrees * Math.PI) / 180;
        return { x: from.x + length * fx * Math.sin(t), y: from.y + length * (Math.cos(t) + fy * Math.sin(t)) };
    };
    const out = Object.fromEntries(Object.entries(px).map(([label, k]) => [label, { ...k }]));

    let drop = 0;
    if (pose.seat) {
        // Seat: hips drop toward knee height and slide back a little, knees
        // come forward, ankles plant under the knees. Bent once, then held.
        for (const side of ['RIGHT', 'LEFT']) {
            const hip = px[`${side} HIP`], knee = px[`${side} KNEE`], ankle = px[`${side} LEG`];
            const thigh = dist(hip, knee), shin = dist(knee, ankle);
            const s = pose.seat;
            const hipY = hip.y + s * thigh * 0.8;
            const hipX = hip.x - s * fx * thigh * 0.15;
            out[`${side} HIP`] = { ...hip, x: hipX, y: hipY };
            out[`${side} KNEE`] = { ...knee, x: hipX + s * fx * thigh * 0.9, y: hipY + (1 - s) * thigh * 0.8 + s * fy * thigh * 0.9 };
            out[`${side} LEG`] = { ...ankle, x: out[`${side} KNEE`].x + s * fx * 1, y: Math.min(ankle.y, out[`${side} KNEE`].y + shin) };
        }
        drop = (out['RIGHT HIP'].y + out['LEFT HIP'].y) / 2 - (px['RIGHT HIP'].y + px['LEFT HIP'].y) / 2;
    }

    const [leanX, leanY] = pose.lean || [0, 0];
    const shiftX = leanX * fx;
    const shiftY = leanY + leanX * fy + drop;
    for (const label of ['NOSE', 'RIGHT EYE', 'LEFT EYE', 'RIGHT EAR', 'LEFT EAR', 'NECK',
        'RIGHT SHOULDER', 'LEFT SHOULDER', `${far} ELBOW`, `${far} ARM`]) {
        out[label].x += shiftX;
        out[label].y += shiftY;
    }
    if (pose.seat) {
        // Far arm follows the torso down onto the far thigh.
        out[`${far} ARM`] = armPoint(armPoint(out[`${far} SHOULDER`], upperLen, pose.upper ?? 0), foreLen, pose.fore ?? 0);
        out[`${far} ELBOW`] = armPoint(out[`${far} SHOULDER`], upperLen, pose.upper ?? 0);
    }
    const elbow = armPoint(out[`${near} SHOULDER`], upperLen, pose.upper ?? 0);
    const hand = armPoint(elbow, foreLen, pose.fore ?? 0);
    out[`${near} ELBOW`] = { ...out[`${near} ELBOW`], ...elbow };
    out[`${near} ARM`] = { ...out[`${near} ARM`], ...hand };
    return base.map((k) => {
        const p = out[k.label];
        return { x: clamp01(p.x / PAD), y: clamp01(p.y / PAD), label: k.label, z_index: k.z_index };
    });
}

function imagesOf(job) {
    const response = job?.last_response || job?.data?.last_response || job?.result || job;
    const images = response?.images || response?.data?.images || [];
    return images.map((image) => (typeof image === 'string' ? image : image?.base64 ? { base64: image.base64 } : image?.url || image?.image_url || image));
}

async function imagePng(image, label) {
    if (typeof image === 'string' && /^https?:/.test(image)) return fetchPng(image, { label });
    const base64 = typeof image === 'string' ? image : image?.base64;
    if (!base64) throw new Error(`unrecognised image payload for ${label}`);
    return PNG.sync.read(Buffer.from(base64.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

// ─── template route ───────────────────────────────────────────────────────────

async function templateDirection(name, group, direction) {
    const characterId = entry.provenance?.characterId;
    if (!characterId) fail(`${id} has no provenance.characterId (the PixelLab rig)`);
    let character = await getCharacter(token, characterId);
    let known = characterAnimationFrames(character, group.animationName, { frameCount: 1 });
    if (!known.byDirection.has(direction) || forced.has(name)) {
        if (assembleOnly) fail(`${name}/${direction} is not on the rig and --assemble-only was requested`);
        const stale = forced.has(name) ? new Set(known.groupIds) : null;
        await spend.job({
            item,
            endpoint: '/characters/animations (template)',
            target: `${id} ${group.template} ${direction}`,
            maxCost: 1,
            run: async () => {
                const queued = await api(token, '/characters/animations', {
                    method: 'POST',
                    label: `${name}/${direction}`,
                    body: {
                        character_id: characterId,
                        animation_name: group.animationName,
                        template_animation_id: group.template,
                        mode: 'template',
                        directions: [direction],
                    },
                });
                const settled = await waitForCharacterAnimation(token, characterId, {
                    animationName: group.animationName,
                    directions: [direction],
                    frameCount: 1,
                    excludeGroupIds: stale,
                    pollIntervalMs: 10_000,
                    label: `${name}/${direction}`,
                });
                return { queued, usage: queued?.usage || null, groupId: settled.byDirectionGroup.get(direction), ledgerDetail: { characterId, groupId: settled.byDirectionGroup.get(direction) } };
            },
        });
        character = await getCharacter(token, characterId);
        known = characterAnimationFrames(character, group.animationName, { frameCount: 1 });
    }
    const urls = known.byDirection.get(direction) || [];
    const cells = [];
    for (let index = 0; index < urls.length; index++) {
        const png = await fetchPng(urls[index], { label: `${name}-${direction}-${index}` });
        writePng(join(cacheDir, `${name}-${direction}-${index}.png`), png);
        cells.push(snapToSheet(fitCenterToCell(png, CELL)));
    }
    return { cells, provenance: { characterId, animationGroupId: known.byDirectionGroup.get(direction), frames: urls.length } };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Subject-only noun phrase from the manifest prompt: drop negative and canvas
// clauses ("no …", "… margin", "… canvas edge").
function subjectOf(prompt) {
    return prompt.split(',').map((part) => part.trim())
        .filter((part) => part && !/^no\b/i.test(part) && !/margin|canvas|pixels touching|8-direction|pixel art/i.test(part))
        .slice(0, 6).join(', ');
}

function paletteOf(png) {
    const seen = new Map();
    for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i + 3] < 16) continue;
        const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
        if (!seen.has(key)) seen.set(key, [png.data[i], png.data[i + 1], png.data[i + 2]]);
    }
    return [...seen.values()];
}

// Nearest sheet colour (weighted RGB), alpha forced to the sheet's binary
// alpha (>= 16 opaque, else clear). Memoized per source colour.
function snapToSheet(cell) {
    if (!sheetPalette) return cell;
    for (let i = 0; i < cell.data.length; i += 4) {
        if (cell.data[i + 3] < 16) {
            cell.data[i] = cell.data[i + 1] = cell.data[i + 2] = cell.data[i + 3] = 0;
            continue;
        }
        const key = (cell.data[i] << 16) | (cell.data[i + 1] << 8) | cell.data[i + 2];
        let hit = snapMemo.get(key);
        if (!hit) {
            let best = null;
            let bestDistance = Infinity;
            for (const colour of sheetPalette) {
                const dr = colour[0] - cell.data[i], dg = colour[1] - cell.data[i + 1], db = colour[2] - cell.data[i + 2];
                const distance = Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = colour;
                }
            }
            hit = { colour: best, distance: bestDistance };
            snapMemo.set(key, hit);
        }
        snapStats.pixels++;
        if (hit.distance > 0) snapStats.moved++;
        snapStats.maxDistance = Math.max(snapStats.maxDistance, hit.distance);
        cell.data[i] = hit.colour[0];
        cell.data[i + 1] = hit.colour[1];
        cell.data[i + 2] = hit.colour[2];
        cell.data[i + 3] = 255;
    }
    return cell;
}

function writePng(path, png) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(png));
}

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

function fail(message) {
    console.error(`[pose-strip] ${message}`);
    process.exit(2);
}
