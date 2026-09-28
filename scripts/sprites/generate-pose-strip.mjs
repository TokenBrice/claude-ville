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
//             joints are that skeleton with arm deltas only: head, neck,
//             shoulders, hips, knees and ankles are copied verbatim (V7
//             pinned feet, garment lock), the profile's baked prop hand is
//             frozen and the gesture is empty-handed. Held groups (`sit`)
//             bend hip/knee/ankle once and then hold them.
//   template  POST /characters/animations mode "template" on the PixelLab rig
//             (manifest provenance.characterId), e.g. `crouching` for the sit
//             pilot: 1 generation per direction, frames at the rig canvas,
//             centred into the 92 px cell like generate-action-strip.mjs.
// Every paid call goes through pixellab-spend.mjs: live balance before and
// after, refusal below --floor, one ledger line per job.
//
// Usage:
//   node scripts/sprites/generate-pose-strip.mjs --id=agent.claude.sonnet --groups=strike,tinker,wait \
//       --clip --directions=east,west,south-east,south-west --agent=Strips73 --item=7.3 --plan
//   node scripts/sprites/generate-pose-strip.mjs --id=agent.codex.gpt55 --groups=sit-template \
//       --directions=south-east,south-west,east,west --item=7.1
//   node scripts/sprites/generate-pose-strip.mjs --id=agent.codex.gpt55 --groups=sit-front \
//       --directions=south-east,south-west --agent=Villagers --item=7.1 --out=output/waking-isle/Villagers/sitart/strips
//       (7.1 front sit: seatFrontSkeleton drops hips/head onto the seat with joint depth;
//        --seat-front='{json}' per body family, --freeze=<facing>@x0,y0,x1,y1 for a planted prop)
//   … --clip                 all groups in one ≤ 15-frame job per direction
//                            (15 frames bill 4 generations, 3 frames bill 2)
//   … --estimate-only        cache the idle skeletons and stop
//   … --assemble-only        re-assemble from the cache, no spend
//   … --freeze-detached      freeze the idle's detached props in every group (freezeProps)
//   … --force=<group>        re-request a cached group (new seed); --force=clip for a clip
//   Output: --out=<dir> (default output/pose-strips) → <id>.<groups>.png + .json
//   (the .json carries every frame's keypoints for feet-audit's identity check)
//   Audit every candidate with scripts/sprites/feet-audit.mjs, then ship it with
//   scripts/sprites/assemble-action-strip.mjs.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { components, newIslands } from './cell-islands.mjs';

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
// for the refusal check; the ledger records what was actually charged). A
// longer clip is nearly free, so `--clip` packs several groups into one job.
const skeletonCost = (frames) => (frames <= 3 ? 2 : frames <= 8 ? 3 : 4);
const MAX_CLIP_FRAMES = 15;
const ESTIMATE_COST = 1;

// Named groups. `frames` are arm poses for the skeleton route: arm angles in
// degrees from hanging straight down, positive toward forward (180 = straight
// up, > 180 = up and behind); `look` lifts the head joints by px (a glance up);
// `seat` (0–1) bends hip/knee/ankle once. Head, neck, shoulders and hips are
// copied verbatim in every work frame (garment lock: a moving torso joint is
// what made robes and capes flare like a run cycle in the Phase A pilot).
// `arm` picks the gesturing arm: 'near' (drawn on top), 'far', or a map by
// direction; the arm holding the profile's baked prop (PROPS) never gestures,
// so a prop never turns into a tool: the gesture is empty-handed. `support`
// poses the other arm (never the prop arm). `clearance` (wait) lifts the hand
// joint at least that many px above the head top so the raised hand clears
// the hat or helm. `contactFrame` is the WorkDownbeats frame.
const GROUPS = Object.freeze({
    // Edit/Write/apply_patch at the Forge: raise overhead, cock behind the
    // head, downswing, contact at waist height, recoil, settle. Frames 0–1 go
    // overhead on every facing so the E/SE arc never reads as pointing.
    strike: {
        route: 'skeleton',
        // Gesture words only: an object in the label ("onto an anvil") is
        // drawn into every frame of the clip.
        action: 'pounding down with a closed empty fist',
        arm: 'near',
        // Chibi arms are short: angles alone leave an "overhead" hand at the
        // hat brim, which reads as pointing. `clearance` lifts the wind-up
        // hand joint above the head top, as the wait pose does.
        frames: [
            { upper: 170, fore: 185, clearance: 3 },
            { upper: 185, fore: 215, clearance: 2 },
            { upper: 130, fore: 120 },
            { upper: 65, fore: 70 },
            { upper: 80, fore: 105 },
            { upper: 45, fore: 50 },
        ],
        contactFrame: 3,
        hold: 5,
    },
    // Bash/test: both hands busy at chest height, the working hand turning
    // and tapping (contact on the tap, frame 2).
    tinker: {
        route: 'skeleton',
        action: 'fiddling with both empty hands at chest height',
        arm: 'near',
        support: { upper: 35, fore: 95 },
        frames: [
            { upper: 45, fore: 100 },
            { upper: 55, fore: 125 },
            { upper: 40, fore: 80 },
            { upper: 55, fore: 120 },
            { upper: 45, fore: 95 },
            { upper: 35, fore: 80 },
        ],
        contactFrame: 2,
        hold: 0,
    },
    // WebFetch/search at the Observatory: the hand rises to shade the eyes,
    // the head lifts a pixel to look far, then settles.
    gaze: {
        route: 'skeleton',
        action: 'shading the eyes with one flat hand and looking far away',
        arm: 'near',
        frames: [
            { upper: 100, fore: 150 },
            { upper: 120, fore: 200 },
            { upper: 120, fore: 200, look: 1 },
            { upper: 120, fore: 200 },
        ],
        contactFrame: 2,
        hold: 1,
    },
    // Waiting on the operator (the action-needed pose): one open hand rises
    // high above the head and holds. E/SE raise the far hand, whose arm never
    // crosses the face; the runtime shows the held row only (static).
    wait: {
        route: 'skeleton',
        action: 'raising one open empty hand high above the head and holding it',
        arm: { east: 'far', 'south-east': 'far' },
        clearance: 5,
        frames: [
            { upper: 110, fore: 150 },
            { upper: 165, fore: 185 },
            { upper: 165, fore: 185 },
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
    // Rest seat, front three-quarter (7.1, SE/SW only; seatFrontSkeleton): the
    // hips drop onto the seat, the thighs point at the camera (short in screen
    // space, a visible lap), the shins hang under the knees, the free hands
    // rest on the knees and head/neck/shoulders drop with the hips, upright.
    // Frame 0 settles, 1–2 are two samples of the held pose (the stage step
    // picks one). Joint `depth` (0–255, nearer = higher) is what turns the
    // knees toward the viewer; without it the model reads a side squat. No
    // "bench" in the prompt: the model paints one, the runtime draws its own.
    'sit-front': {
        route: 'skeleton',
        pose: 'seat-front',
        action: 'sit down',
        held: 'seated upright with a straight back on a low seat, knees toward the viewer, hands resting on the knees',
        frames: [{ seat: 0.75 }, { seat: 1 }, { seat: 1 }],
        hold: 2,
        // Fractions of each side's thigh length (screen px) and depth deltas;
        // `--seat-front='{…}'` overrides per body family.
        seatFront: {
            hipDrop: 1, hipBack: 0.15, kneeOut: 0.3, kneeDown: 0.5, shin: 0.9, floorForward: 0.45,
            handAlong: 0.7, standDepth: 128, sideDepth: 8, kneeDepth: 90, handDepth: 45,
        },
        // Non-body alpha islands smaller than this (px) are cleared.
        despeckle: 6,
        // Detached props (sparkles, a floating wrench, a star mote) are frozen:
        // every detached island the model drew is cleared and the idle cell's
        // own detached islands are pasted back pixel-exact (freezeProps).
        freezeDetached: true,
    },
});

// Baked props (drawn into the base sheet; Codex weapons are runtime overlays
// the strip's `grip.sheathe` parks). `hands` names the screen side of the body
// the prop's grip sits on in each work facing; the hand joint on that side is
// the prop hand, frozen in every frame, and the gesture moves the other arm.
const PROPS = Object.freeze({
    'agent.claude.fable': { prop: 'a tall golden staff', hands: { 'south-east': 'right', 'south-west': 'left' } },
    'agent.claude.opus': { prop: 'a tall wooden staff with a crystal head', hands: { 'south-east': 'right', west: 'left', 'south-west': 'left' } },
    'agent.claude.sonnet': { prop: 'a wooden staff topped with a violet crystal', hands: { 'south-west': 'left' } },
    'agent.deepseek.flash': { prop: 'a short dagger held low', hands: { west: 'right' } },
    'agent.deepseek.flash.high': { prop: 'a wooden longbow held low in front', hands: { 'south-east': 'right', east: 'right', west: 'left', 'south-west': 'left' } },
    'agent.deepseek.flash.xhigh': { prop: 'a wooden longbow held low in front', hands: { 'south-east': 'right', east: 'right', west: 'left', 'south-west': 'left' } },
    'agent.deepseek.reasoner': { prop: 'a wooden longbow held low in front', hands: { 'south-east': 'right', east: 'right', west: 'left', 'south-west': 'left' } },
    'agent.deepseek.pro': { prop: 'a curved scimitar held low', hands: { 'south-east': 'left', east: 'left', west: 'right', 'south-west': 'right' } },
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
// `--clip`: every listed group in ONE skeleton job per direction (frames
// concatenated, ≤ 15), then split back into groups. `--estimate-only`: fetch
// and cache the idle skeletons (0.1 generation each) and stop.
const clip = flag('clip');
const estimateOnly = flag('estimate-only');
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
// `--smear=<px>` (default 40): new detached islands up to this size (1–2 px
// specks and the video model's motion-smear arcs beside a fast swing) are
// cleared after the snap; the body component is never touched. Anything
// larger stays for feet-audit's fragment check to fail.
const smearMax = Number(option('smear', '40'));
// `--seat-front='{"kneeDepth":80}'` overrides the sit-front pose params.
// `--freeze=south-west@22,10,31,50[;…]`: inside that cell box (inclusive) every
// frame of the facing takes the idle cell's pixels (idle opaque → idle pixel,
// else cleared) — a planted staff the model nudged; the box must stay clear of
// the body. Both are recorded in the stage json provenance.
const seatFrontOverride = JSON.parse(option('seat-front', '{}'));
const freezeBoxes = Object.fromEntries((option('freeze') || '').split(';').filter(Boolean).map((spec) => {
    const [facing, box] = spec.split('@');
    return [facing, box.split(',').map(Number)];
}));
// `--freeze-detached`: every group freezes detached props (freezeProps), e.g.
// gpt54's floating wrench, which the model drops or moves on some facings.
const freezeDetachedAll = flag('freeze-detached');

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

const skeletonFrames = (names) => names.reduce((sum, name) => sum + GROUPS[name].frames.length, 0);
if (clip) {
    if (groupNames.some((name) => GROUPS[name].route !== 'skeleton')) fail('--clip packs skeleton groups only');
    if (skeletonFrames(groupNames) > MAX_CLIP_FRAMES) fail(`--clip: ${skeletonFrames(groupNames)} frames exceed ${MAX_CLIP_FRAMES}`);
}
const quote = clip
    ? [{ name: groupNames.join('+'), route: 'skeleton clip', perDirection: skeletonCost(skeletonFrames(groupNames)), total: skeletonCost(skeletonFrames(groupNames)) * directions.length }]
    : groupNames.map((name) => {
        const group = GROUPS[name];
        const perDirection = group.route === 'skeleton' ? skeletonCost(group.frames.length) : 1;
        return { name, route: group.route, perDirection, total: perDirection * directions.length };
    });
const worst = quote.reduce((sum, row) => sum + row.total, 0) + (quote.some((row) => row.route !== 'template') ? directions.length * 0.1 : 0);
console.log(`[pose-strip] ${id}: ${quote.map((row) => `${row.name} (${row.route}) ${row.perDirection}×${directions.length}=${row.total}`).join(', ')}; worst case ≈ ${worst} generations`);
console.log(`[pose-strip] balance ${await spend.balance()}, floor ${spend.floor}; description "${description}"`);
if (plan) process.exit(0);
if (estimateOnly) {
    for (const direction of directions) await estimatedSkeleton(direction, PNG.sync.write(paddedIdleCell(direction)));
    console.log(`[pose-strip] skeletons cached in ${rel(cacheDir)}`);
    process.exit(0);
}

// ─── generate ─────────────────────────────────────────────────────────────────

const provenance = { id, description, groups: {} };
const groupCells = new Map();
const keypointLog = { pad: PAD, offset: OFFSET, base: {}, groups: {} };
const speckStats = { cleared: 0, islands: 0 };
const batches = clip ? [groupNames] : groupNames.map((name) => [name]);
for (const names of batches) {
    for (const name of names) {
        provenance.groups[name] = { route: GROUPS[name].route, ...(names.length > 1 ? { clip: names.join('+') } : {}), directions: {} };
        groupCells.set(name, new Map());
        keypointLog.groups[name] = {};
    }
    for (const direction of directions) {
        if (GROUPS[names[0]].route !== 'skeleton') {
            const result = await templateDirection(names[0], GROUPS[names[0]], direction);
            groupCells.get(names[0]).set(direction, result.cells);
            provenance.groups[names[0]].directions[direction] = result.provenance;
            continue;
        }
        const result = await skeletonClip(names, direction);
        keypointLog.base[direction] = result.base;
        for (const name of names) {
            groupCells.get(name).set(direction, result.cells[name]);
            provenance.groups[name].directions[direction] = result.provenance;
            keypointLog.groups[name][direction] = result.keypoints[name];
        }
    }
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
writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify({ ...provenance, cell: CELL, groups: layout, jobs: provenance.groups, keypoints: keypointLog }, null, 2)}\n`);
console.log(`[pose-strip] wrote ${rel(join(outDir, `${stem}.png`))} (${strip.width}×${strip.height}); groups ${JSON.stringify(layout)}`);
if (sheetPalette) console.log(`[pose-strip] palette snap: ${snapStats.moved}/${snapStats.pixels} px moved onto the ${sheetPalette.length}-colour sheet palette (max RGB distance ${snapStats.maxDistance.toFixed(1)})`);
if (speckStats.cleared) console.log(`[pose-strip] specks: cleared ${speckStats.islands} new detached islands, ${speckStats.cleared} px (≤ ${smearMax} px each, not on the idle cell)`);
console.log(`[pose-strip] audit: node scripts/sprites/feet-audit.mjs --id=${id} --strip=${rel(join(outDir, `${stem}.png`))} --groups=${Object.entries(layout).map(([name, g]) => `${name}:${g.rows[0]}-${g.rows[1]}`).join(',')}`);

// ─── skeleton route ───────────────────────────────────────────────────────────

// One job per direction for `names` (one group, or a `--clip` of several whose
// frames are concatenated and split back). A single group keeps the
// `<group>-<direction>` cache names; a clip caches as `<a>+<b>-<direction>`.
async function skeletonClip(names, direction) {
    const firstFrame = paddedIdleCell(direction);
    const firstFramePng = PNG.sync.write(firstFrame);
    const base = await estimatedSkeleton(direction, firstFramePng);
    const perGroup = Object.fromEntries(names.map((name) => [name, GROUPS[name].frames.map((pose) => poseSkeleton(base, pose, direction, GROUPS[name]))]));
    const frames = names.flatMap((name) => perGroup[name]);
    const key = names.join('+');
    const isForced = names.some((name) => forced.has(name)) || forced.has('clip');
    const jobPath = join(cacheDir, `${key}-${direction}.job.json`);
    let job = existsSync(jobPath) && !isForced ? JSON.parse(readFileSync(jobPath, 'utf8')) : null;
    if (!job) {
        if (assembleOnly) fail(`${key}/${direction} has no cached job and --assemble-only was requested`);
        const pendingPath = `${jobPath}.pending`;
        let pending = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')) : null;
        const seed = pending?.seed ?? hashSeed(`${id}:${key}:${direction}:${isForced ? Date.now() : 0}`);
        const single = names.length === 1 ? GROUPS[names[0]] : null;
        const body = {
            description: `${description}${heldText(direction)}${single?.held ? `, ${single.held}` : ''}`,
            action: names.map((name) => GROUPS[name].action).join(', then '),
            direction,
            view: 'low top-down',
            first_frame: { type: 'base64', base64: firstFramePng.toString('base64'), format: 'png' },
            first_frame_keypoints: base,
            keypoints: frames,
            template_id: 'mannequin',
            seed,
            no_background: true,
        };
        const detail = { seed, resumed: Boolean(pending) };
        job = await spend.job({
            item,
            endpoint: '/animate-with-skeleton-v3',
            target: `${id} ${key} ${direction} (${frames.length} frames)`,
            maxCost: pending ? 0 : skeletonCost(frames.length),
            detail,
            run: async () => {
                if (!pending) {
                    const queued = await api(token, '/animate-with-skeleton-v3', { method: 'POST', body, label: `${key}/${direction}` });
                    const jobId = queued?.background_job_id || queued?.data?.background_job_id || queued?.job_id;
                    if (!jobId) throw new Error(`no background_job_id in ${JSON.stringify(queued).slice(0, 300)}`);
                    pending = { jobId, seed, usage: queued?.usage || null };
                    mkdirSync(dirname(jobPath), { recursive: true });
                    writeFileSync(pendingPath, JSON.stringify(pending));
                }
                Object.assign(detail, pending);
                const done = await waitForBackgroundJob(token, pending.jobId, { label: `${key}/${direction}`, maxWaitMs: 60 * 60 * 1000 });
                return { jobId: pending.jobId, seed, usage: pending.usage || done?.usage || null, images: imagesOf(done), ledgerDetail: detail };
            },
        });
        mkdirSync(dirname(jobPath), { recursive: true });
        writeFileSync(jobPath, JSON.stringify({ ...job, keypoints: frames, firstFrameKeypoints: base, description: body.description, action: body.action }));
        unlinkSync(pendingPath);
    }
    if (job.images.length !== frames.length) fail(`${key}/${direction}: ${job.images.length} frames returned, ${frames.length} requested`);
    const idleMask = maskOf(cropPadded(firstFrame));
    const cells = {};
    let index = 0;
    for (const name of names) {
        cells[name] = [];
        for (let frame = 0; frame < perGroup[name].length; frame++, index++) {
            const png = await imagePng(job.images[index], `${key}-${direction}-${index}`);
            writePng(join(cacheDir, `${key}-${direction}-${index}.png`), png);
            cells[name].push(freezeProps(despeckle(snapToSheet(cropPadded(png)), idleMask, GROUPS[name]), cropPadded(firstFrame), direction, GROUPS[name]));
        }
    }
    const seatFront = names.some((name) => GROUPS[name].pose === 'seat-front') ? { seatFront: seatFrontParams(GROUPS['sit-front']) } : {};
    const frozen = freezeBoxes[direction] ? { freeze: freezeBoxes[direction] } : {};
    const detachedFrozen = freezeDetachedAll ? { freezeDetached: true } : {};
    return { cells, base, keypoints: perGroup, provenance: { jobId: job.jobId, seed: job.seed, usage: job.usage, ...seatFront, ...frozen, ...detachedFrozen } };
}

// The prop clause for this facing: the profile's baked prop stays still in
// its own hand, the gesturing hand is empty (a prop never becomes a tool).
function heldText(direction) {
    const props = PROPS[id];
    if (props?.hands?.[direction]) return `, holding ${props.prop} perfectly still in one hand, the other hand empty`;
    return ', both hands empty';
}

function maskOf(cell) {
    const mask = new Uint8Array(CELL * CELL);
    for (let p = 0; p < mask.length; p++) mask[p] = cell.data[p * 4 + 3] >= 16 ? 1 : 0;
    return mask;
}

// Speck and smear cleanup after the palette snap: new detached islands of
// ≤ --smear px (the idle cell does not carry them) are cleared;
// `group.despeckle` (px) also clears every non-body island smaller than that.
// Anything larger is left for feet-audit's fragment check to fail.
function despeckle(cell, idleMask, group) {
    const mask = maskOf(cell);
    const clear = (island) => {
        for (const p of island.pixels) {
            cell.data[p * 4] = cell.data[p * 4 + 1] = cell.data[p * 4 + 2] = cell.data[p * 4 + 3] = 0;
            speckStats.cleared++;
        }
    };
    for (const island of newIslands(mask, idleMask, CELL)) {
        if (island.size > smearMax) continue;
        clear(island);
        speckStats.islands++;
    }
    if (group.despeckle) {
        const [, ...islands] = components(maskOf(cell), CELL);
        for (const island of islands) if (island.size < group.despeckle) clear(island);
    }
    return cell;
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
function poseSkeleton(base, pose, direction, group = {}) {
    if (group.pose === 'seat-front') return seatFrontSkeleton(base, pose, direction, group);
    return pose.seat ? seatSkeleton(base, pose, direction) : workSkeleton(base, pose, direction, group);
}

// Work and wait frames: garment lock. Head, neck, shoulders, hips, knees and
// ankles are the idle skeleton verbatim (`look` only lifts the head joints);
// the gesturing arm takes the pose angles, the other arm takes `support` or
// stays put, and the prop hand (PROPS) never moves.
function workSkeleton(base, pose, direction, group) {
    const px = Object.fromEntries(base.map((k) => [k.label, { ...k, x: k.x * PAD, y: k.y * PAD }]));
    const [fx, fy] = FORWARD[direction];
    const near = (px['RIGHT SHOULDER'].z_index ?? 0) >= (px['LEFT SHOULDER'].z_index ?? 0) ? 'RIGHT' : 'LEFT';
    const far = near === 'RIGHT' ? 'LEFT' : 'RIGHT';
    const propHand = propHandFor(px, direction);
    const pick = typeof group.arm === 'object' && group.arm ? (group.arm[direction] || 'near') : (group.arm || 'near');
    let gesture = pick === 'far' ? far : near;
    if (gesture === propHand) gesture = gesture === near ? far : near;
    const other = gesture === near ? far : near;
    const ankleY = Math.max(px['RIGHT LEG'].y, px['LEFT LEG'].y);
    const bodyH = Math.max(20, ankleY - px.NOSE.y);
    const limb = (side) => [dist(px[`${side} SHOULDER`], px[`${side} ELBOW`]), dist(px[`${side} ELBOW`], px[`${side} ARM`])];
    const upperLen = Math.max(limb('RIGHT')[0], limb('LEFT')[0], 0.2 * bodyH);
    const foreLen = Math.max(limb('RIGHT')[1], limb('LEFT')[1], 0.18 * bodyH);
    const armPoint = (from, length, degrees) => {
        const t = (degrees * Math.PI) / 180;
        return { x: from.x + length * fx * Math.sin(t), y: from.y + length * (Math.cos(t) + fy * Math.sin(t)) };
    };
    const out = Object.fromEntries(Object.entries(px).map(([label, k]) => [label, { ...k }]));
    if (pose.look) {
        for (const label of ['NOSE', 'RIGHT EYE', 'LEFT EYE', 'RIGHT EAR', 'LEFT EAR']) out[label].y -= pose.look;
    }
    const poseArm = (side, upper, fore, clearance = 0) => {
        const shoulder = out[`${side} SHOULDER`];
        let elbow = armPoint(shoulder, upperLen, upper);
        let hand = armPoint(elbow, foreLen, fore);
        if (clearance) {
            // The raised hand must clear the hat or helm: lift the hand joint
            // to `clearance` px above the idle cell's top row, elbow between.
            const limit = headTop(direction) - clearance;
            if (hand.y > limit) {
                hand = { x: hand.x, y: limit };
                elbow = { x: (shoulder.x + hand.x) / 2 + fx * 2, y: (shoulder.y + hand.y) / 2 };
            }
        }
        out[`${side} ELBOW`] = { ...out[`${side} ELBOW`], ...elbow };
        out[`${side} ARM`] = { ...out[`${side} ARM`], ...hand };
    };
    if (pose.upper !== undefined) poseArm(gesture, pose.upper, pose.fore ?? pose.upper, pose.clearance ?? group.clearance ?? 0);
    if (group.support && other !== propHand) poseArm(other, group.support.upper, group.support.fore);
    return base.map((k) => {
        const p = out[k.label];
        return { x: clamp01(p.x / PAD), y: clamp01(p.y / PAD), label: k.label, z_index: k.z_index };
    });
}

// The hand joint on the screen side PROPS names for this facing, or null.
function propHandFor(px, direction) {
    const side = PROPS[id]?.hands?.[direction];
    if (!side) return null;
    const rightX = px['RIGHT ARM'].x, leftX = px['LEFT ARM'].x;
    if (side === 'right') return rightX >= leftX ? 'RIGHT' : 'LEFT';
    return rightX <= leftX ? 'RIGHT' : 'LEFT';
}

// Top opaque row of the direction's idle cell in 128² first-frame space.
function headTop(direction) {
    const col = DIRECTIONS.indexOf(direction);
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            if (sheet.data[((IDLE_ROW * CELL + y) * sheet.width + col * CELL + x) * 4 + 3] >= 16) return y + OFFSET;
        }
    }
    return OFFSET;
}

// The 7.1 seat (Villagers): hips, knees and ankles bend once, then hold.
function seatSkeleton(base, pose, direction) {
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

function seatFrontParams(group) {
    return { ...group.seatFront, ...seatFrontOverride };
}

// The 7.1 front three-quarter seat (Villagers), blended from the standing
// skeleton by `pose.seat`. Per side, in fractions of that side's thigh: the hip
// drops `hipDrop` and slides `hipBack` away from the facing; the knee sits
// `kneeOut` toward the facing and `kneeDown` below the hip (the thigh points at
// the camera, so it is short on screen); the ankle hangs `shin` under the knee,
// never more than `floorForward` below the standing ankle. Head, neck and
// shoulders drop with the hips (upright, no lean); a free hand rests
// `handAlong` of the way from hip to knee, its elbow halfway between the
// dropped standing elbow and the shoulder–hand midpoint; the PROPS hand (or,
// for a facing PROPS does not name, `hold: { <facing>: 'left' | 'right' }`
// screen side) keeps its idle position (the planted staff or bow does not
// move) and its elbow takes half the drop. Depth: every leg and arm joint gets one (near side
// +sideDepth, far side −sideDepth around standDepth), knees and ankles
// +kneeDepth, hands +handDepth, elbows half that; head and torso joints keep
// the template's standing depth.
function seatFrontSkeleton(base, pose, direction, group) {
    const p = seatFrontParams(group);
    const px = Object.fromEntries(base.map((k) => [k.label, { ...k, x: k.x * PAD, y: k.y * PAD }]));
    const out = Object.fromEntries(Object.entries(px).map(([label, k]) => [label, { ...k }]));
    const toward = FORWARD[direction][0] < 0 ? -1 : 1;
    const s = pose.seat;
    const near = (px['RIGHT SHOULDER'].z_index ?? 0) >= (px['LEFT SHOULDER'].z_index ?? 0) ? 'RIGHT' : 'LEFT';
    const holdSide = p.hold?.[direction];
    const propHand = propHandFor(px, direction)
        ?? (holdSide ? ((holdSide === 'right') === (px['RIGHT ARM'].x >= px['LEFT ARM'].x) ? 'RIGHT' : 'LEFT') : null);
    const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s });
    const sideDepth = (side) => p.standDepth + (side === near ? p.sideDepth : -p.sideDepth);
    for (const side of ['RIGHT', 'LEFT']) {
        const hip = px[`${side} HIP`], knee = px[`${side} KNEE`], ankle = px[`${side} LEG`];
        const thigh = dist(hip, knee), shin = dist(knee, ankle);
        const hipSeat = { x: hip.x - toward * thigh * p.hipBack, y: hip.y + thigh * p.hipDrop };
        const kneeSeat = { x: hipSeat.x + toward * thigh * p.kneeOut, y: hipSeat.y + thigh * p.kneeDown };
        const ankleSeat = { x: kneeSeat.x, y: Math.min(kneeSeat.y + shin * p.shin, ankle.y + thigh * p.floorForward) };
        const depth = sideDepth(side);
        out[`${side} HIP`] = { ...hip, ...lerp(hip, hipSeat), depth };
        out[`${side} KNEE`] = { ...knee, ...lerp(knee, kneeSeat), depth: depth + s * p.kneeDepth };
        out[`${side} LEG`] = { ...ankle, ...lerp(ankle, ankleSeat), depth: depth + s * p.kneeDepth };
    }
    const drop = (out['RIGHT HIP'].y + out['LEFT HIP'].y - px['RIGHT HIP'].y - px['LEFT HIP'].y) / 2;
    for (const label of ['NOSE', 'RIGHT EYE', 'LEFT EYE', 'RIGHT EAR', 'LEFT EAR', 'NECK', 'RIGHT SHOULDER', 'LEFT SHOULDER']) {
        out[label].y += drop;
    }
    for (const side of ['RIGHT', 'LEFT']) {
        if (side === propHand) {
            out[`${side} ELBOW`] = { ...out[`${side} ELBOW`], y: px[`${side} ELBOW`].y + drop * 0.5 * s };
            continue;
        }
        const hip = out[`${side} HIP`], knee = out[`${side} KNEE`], shoulder = out[`${side} SHOULDER`];
        const hand = { x: hip.x + (knee.x - hip.x) * p.handAlong, y: hip.y + (knee.y - hip.y) * p.handAlong - 1 };
        const elbowStand = { x: px[`${side} ELBOW`].x, y: px[`${side} ELBOW`].y + drop };
        const elbowSeat = { x: (elbowStand.x + (shoulder.x + hand.x) / 2) / 2, y: (elbowStand.y + (shoulder.y + hand.y) / 2) / 2 };
        const handStand = { x: px[`${side} ARM`].x, y: px[`${side} ARM`].y + drop };
        const depth = sideDepth(side);
        out[`${side} ELBOW`] = { ...out[`${side} ELBOW`], ...lerp(elbowStand, elbowSeat), depth: depth + s * p.handDepth * 0.5 };
        out[`${side} ARM`] = { ...out[`${side} ARM`], ...lerp(handStand, hand), depth: depth + s * p.handDepth };
    }
    return base.map((k) => {
        const q = out[k.label];
        const joint = { x: clamp01(q.x / PAD), y: clamp01(q.y / PAD), label: k.label, z_index: k.z_index };
        if (q.depth !== undefined) joint.depth = Math.round(Math.min(255, Math.max(0, q.depth)));
        return joint;
    });
}

// Prop freeze after the speck cleanup. `group.freezeDetached` (or
// `--freeze-detached` for every group): clear every island but the body, then
// paste the idle cell's detached islands back where the body is not. `--freeze`
// box: the idle cell's pixels inside the facing's box, on top of whatever the
// model drew there.
function freezeProps(cell, idle, direction, group) {
    if (group.freezeDetached || freezeDetachedAll) {
        const [body, ...detached] = components(maskOf(cell), CELL);
        for (const island of detached) for (const p of island.pixels) cell.data.fill(0, p * 4, p * 4 + 4);
        const bodyMask = new Uint8Array(CELL * CELL);
        if (body) for (const p of body.pixels) bodyMask[p] = 1;
        const [, ...idleDetached] = components(maskOf(idle), CELL);
        for (const island of idleDetached) {
            for (const p of island.pixels) if (!bodyMask[p]) for (let c = 0; c < 4; c++) cell.data[p * 4 + c] = idle.data[p * 4 + c];
        }
    }
    const box = freezeBoxes[direction];
    if (!box) return cell;
    const [x0, y0, x1, y1] = box;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const i = (y * CELL + x) * 4;
            for (let c = 0; c < 4; c++) cell.data[i + c] = idle.data[i + 3] >= 16 ? idle.data[i + c] : 0;
        }
    }
    return cell;
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
// clauses ("no …", "… margin", "… canvas edge"), the runtime-weapon grip
// clauses (a strip's hands are empty; the runtime weapon is sheathed) and
// held-item clauses (PROPS says per facing whether a baked prop is in hand).
function subjectOf(prompt) {
    return prompt.split(',').map((part) => part.trim())
        .filter((part) => part && !/^no\b/i.test(part) && !/margin|canvas|pixels touching|8-direction|pixel art|runtime|gripping|hands? (?:held|visible)|visible hands|open hands/i.test(part))
        .filter((part) => !/\b(staff|sword|bow|longbow|dagger|daggers|scimitar|blade|wrench|hammer|spear|weapon|quiver)\b/i.test(part))
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
