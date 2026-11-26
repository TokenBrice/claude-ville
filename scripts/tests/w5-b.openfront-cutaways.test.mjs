import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { apertureCutContains } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { BUILDING_VISUAL_REGISTRY } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import {
    FORGE_ARCH_ROWS,
    OPEN_FRONT_PROFILES,
    TAVERN_ARCH_ROWS,
    buildOpenFrontSprites,
    getOpenFrontProfile,
    isPointInsideOpenBay,
    openFrontArchSortY,
    openFrontRearSortY,
    resolveOpenFrontDrawOrder,
    splitOpenFrontMask,
} from '../../claudeville/src/presentation/character-mode/OpenFront.js';
import {
    ARCHIVE_CUTAWAY_PROFILE,
    ARCHIVE_MAX_SPINES,
    BAYER_4X4,
    BAYER_PEEL_STEP_MS,
    COMMAND_CUTAWAY_PROFILE,
    CUTAWAY_LAYERS_3,
    CUTAWAY_LAYERS_4,
    CutawayPeelController,
    GLASS_DWELL_MS,
    HARBOR_CUTAWAY_PROFILE,
    HARBOR_MAX_LANTERNS,
    WAR_TABLE_LANDMARKS,
    WAR_TABLE_MAX_PAWNS,
    applyBayerPeelToRgba,
    assignArchiveBays,
    buildArchiveCutawayState,
    buildBayerPeelMask,
    buildCommandWarTableState,
    buildHarborCutawayState,
    drawArchiveCutaway,
    drawCommandWarTable,
    drawHarborCutaway,
    formatCommandSillBar,
    hashDirectoryName,
    normalizeCutawayLayers,
    projectWarTableDot,
} from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import {
    CURVATURE_CLASS,
    OCT_64_NORMALS,
    SURFACE_FLAGS,
    SURFACE_V1_MAX_H16,
    bakeBuildingSurfaceV1,
    checkAoMonotonicity,
    decodeOctNormal,
    encodeOctNormalId,
    mirrorOctNormalId,
    packReliefMaterialGB,
    packSurfaceV1Texel,
    seedOctNormalId,
    unpackReliefMaterialGB,
    unpackSurfaceV1Texel,
    validateMaterialFlags,
    validateSurfaceV1Buffer,
} from '../sprites/bake-depth-channels.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeRecordingCtx() {
    const rects = [];
    const images = [];
    const textCalls = [];
    return {
        rects,
        images,
        textCalls,
        fillStyle: '#000000',
        fillRect(x, y, w, h) {
            rects.push({ x, y, w, h, fillStyle: this.fillStyle });
        },
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            images.push({ img, sx, sy, sw, sh, dx, dy, dw, dh });
        },
        fillText(text, x, y) {
            textCalls.push({ kind: 'fillText', text, x, y });
        },
        strokeText(text, x, y) {
            textCalls.push({ kind: 'strokeText', text, x, y });
        },
    };
}

// ─── 1. Surface-v1 & Oct64 Normal Baker (`bake-depth-channels.mjs`) ──────────

test('OCT_64_NORMALS: 64 unit normals round-trip cleanly with lowest-ID tie-breaking and exact flipX mirror invariance', () => {
    assert.equal(OCT_64_NORMALS.length, 64);

    for (let id = 0; id < 64; id++) {
        const [nx, ny, nz] = decodeOctNormal(id);
        const len = Math.hypot(nx, ny, nz);
        assert.ok(Math.abs(len - 1) < 1e-12, `id ${id} unit length: ${len}`);

        // Vector round-trip: re-encoding decoded normal lands on an identical unit vector
        // and picks the lowest ID on any octahedral seam tie.
        const encoded = encodeOctNormalId(nx, ny, nz);
        assert.ok(encoded >= 0 && encoded <= 63 && encoded <= id, `id ${id} lowest-ID tie: got ${encoded}`);
        const [rx, ry, rz] = decodeOctNormal(encoded);
        const dot = nx * rx + ny * ry + nz * rz;
        assert.ok(Math.abs(dot - 1) < 1e-12, `id ${id} round-trip dot ${dot}`);

        // Identity mirror (flipX = false).
        assert.equal(mirrorOctNormalId(id, false), id, `id ${id} flipX=false preserves ID`);

        // X-mirror (flipX = true) negates X and preserves Y and Z accurately.
        const mirroredId = mirrorOctNormalId(id, true);
        const [mx, my, mz] = decodeOctNormal(mirroredId);
        assert.ok(Math.abs(mx + nx) < 1e-12, `id ${id} mirror X: ${mx} vs ${-nx}`);
        assert.ok(Math.abs(my - ny) < 1e-12, `id ${id} mirror Y: ${my} vs ${ny}`);
        assert.ok(Math.abs(mz - nz) < 1e-12, `id ${id} mirror Z: ${mz} vs ${nz}`);

        // Double mirror restores the exact original vector.
        const [dmx, dmy, dmz] = decodeOctNormal(mirrorOctNormalId(mirroredId, true));
        assert.ok(Math.abs(dmx - nx) < 1e-12 && Math.abs(dmy - ny) < 1e-12 && Math.abs(dmz - nz) < 1e-12);
    }

    // Explicit tie-break checks: all 4 corners decode to [0, 0, -1], so lowest ID 0 wins.
    assert.equal(encodeOctNormalId(0, 0, -1), 0);
    // Equidistant between id 27 (-1/7,-1/7,+) and id 28 (+1/7,-1/7,+): [0, -1/7, 5/7] ties on 27 & 28 -> 27 wins.
    assert.equal(encodeOctNormalId(0, -1 / 7, 5 / 7), 27);
    // Seed forward oct ID stays in [0, 63].
    const upSeed = seedOctNormalId(0, 0, 1);
    assert.ok(upSeed >= 0 && upSeed <= 63);
    // Out-of-range IDs throw.
    assert.throws(() => decodeOctNormal(-1), RangeError);
    assert.throws(() => decodeOctNormal(64), RangeError);
    assert.throws(() => mirrorOctNormalId(64, true), RangeError);
});

test('relief material G/B encodes all 256 (ao, slope) combinations with high 2 bits of G strictly zero', () => {
    for (const normalId of [0, 1, 27, 42, 63]) {
        for (let slope = 0; slope < 16; slope++) {
            for (let ao = 0; ao < 16; ao++) {
                const { g, b } = packReliefMaterialGB({ normalId, ao, slope });
                assert.equal(g & 0xc0, 0, 'upper 2 bits of G strictly zero');
                const unpacked = unpackReliefMaterialGB(g, b);
                assert.equal(unpacked.normalId, normalId);
                assert.equal(unpacked.reservedG, 0);
                assert.equal(unpacked.ao, ao);
                assert.equal(unpacked.slope, slope);
                assert.equal(unpacked.slopeDeg, slope * 6);
            }
        }
    }
    assert.throws(() => packReliefMaterialGB({ normalId: 64, ao: 0, slope: 0 }), RangeError);
    assert.throws(() => packReliefMaterialGB({ normalId: 0, ao: 16, slope: 0 }), RangeError);
    assert.throws(() => packReliefMaterialGB({ normalId: 0, ao: 0, slope: 16 }), RangeError);

    // Forbidden flag combinations (Spec 01 §1).
    assert.equal(validateMaterialFlags(SURFACE_FLAGS.relief).ok, true);
    assert.equal(validateMaterialFlags(SURFACE_FLAGS.relief | SURFACE_FLAGS.coded).ok, true);
    assert.equal(validateMaterialFlags(SURFACE_FLAGS.relief | SURFACE_FLAGS.packed).ok, false);
    assert.equal(validateMaterialFlags(SURFACE_FLAGS.coded | SURFACE_FLAGS.packed).ok, false);
    assert.equal(validateMaterialFlags(SURFACE_FLAGS.relief, { isTerrain: true }).ok, false);
    assert.equal(validateMaterialFlags(1 << 22).ok, false);
});

test('surface-v1 texel packing enforces H16 bounds/overflow, B<=63, and all A bitfields', () => {
    // Exact 1/16 px height precision and maximum H16 = 65535.
    for (const [heightPx, expectedH16] of [[0, 0], [0.0625, 1], [12.375, 198], [255, 4080], [65535 / 16, SURFACE_V1_MAX_H16]]) {
        const packed = packSurfaceV1Texel({
            heightPx,
            normalId: 37,
            valid: true,
            protectInk: true,
            curvature: CURVATURE_CLASS.crease,
            ao: 13,
        });
        assert.equal(packed.r, expectedH16 & 255);
        assert.equal(packed.g, (expectedH16 >> 8) & 255);
        assert.equal(packed.b, 37);
        assert.equal(packed.b & 0xc0, 0);
        assert.equal(packed.a, 128 | 64 | (3 << 4) | 13);

        const unpacked = unpackSurfaceV1Texel(packed.r, packed.g, packed.b, packed.a);
        assert.equal(unpacked.h16, expectedH16);
        assert.equal(unpacked.heightPx, expectedH16 / 16);
        assert.equal(unpacked.normalId, 37);
        assert.equal(unpacked.reservedNormalBits, 0);
        assert.equal(unpacked.valid, true);
        assert.equal(unpacked.protectInk, true);
        assert.equal(unpacked.curvature, 3);
        assert.equal(unpacked.ao, 13);
    }

    // Exhaustive A bitfield verification (valid x protectInk x curvature x ao).
    for (const valid of [false, true]) {
        for (const protectInk of [false, true]) {
            for (let curvature = 0; curvature < 4; curvature++) {
                for (let ao = 0; ao < 16; ao++) {
                    const p = packSurfaceV1Texel({ heightPx: 1, normalId: 5, valid, protectInk, curvature, ao });
                    const u = unpackSurfaceV1Texel(p.r, p.g, p.b, p.a);
                    assert.equal(u.valid, valid);
                    assert.equal(u.protectInk, protectInk);
                    assert.equal(u.curvature, curvature);
                    assert.equal(u.ao, ao);
                }
            }
        }
    }

    // Reject H16 overflow and out-of-range fields.
    assert.throws(() => packSurfaceV1Texel({ heightPx: -0.1 }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: 4096 }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: Number.POSITIVE_INFINITY }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: Number.NaN }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: 1, normalId: 64 }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: 1, curvature: 4 }), RangeError);
    assert.throws(() => packSurfaceV1Texel({ heightPx: 1, ao: 16 }), RangeError);
});

test('validateSurfaceV1Buffer & bakeBuildingSurfaceV1 enforce alpha/valid/B<=63/AO monotonicity and CLI --check works', () => {
    // 6x6 synthetic building patch: transparent border, raised central wall + lower apron recess.
    const w = 6;
    const h = 6;
    const albedoData = new Uint8ClampedArray(w * h * 4);
    const occData = new Uint8ClampedArray(w * h * 4);
    const matData = new Uint8ClampedArray(w * h * 4);
    for (let y = 1; y <= 4; y++) {
        for (let x = 1; x <= 4; x++) {
            const o = (y * w + x) * 4;
            const isCrevice = y === 4 && x === 2;
            const isWallTop = y === 1 && x === 2;
            const heightPx = isCrevice ? 2 : (isWallTop ? 40 : 28);
            const face = isCrevice ? 0 : 1; // apron vs SW wall
            albedoData[o] = isCrevice ? 18 : 160;
            albedoData[o + 1] = isCrevice ? 16 : 150;
            albedoData[o + 2] = isCrevice ? 16 : 140;
            albedoData[o + 3] = 255;
            occData[o] = heightPx;
            occData[o + 1] = 255;
            occData[o + 2] = (face << 6) | Math.min(63, Math.round(heightPx / 4));
            occData[o + 3] = 255;
            matData[o] = 1; // stone
            matData[o + 3] = 255;
        }
    }

    const baked = bakeBuildingSurfaceV1({
        albedo: { width: w, height: h, data: albedoData },
        occluder: { width: w, height: h, data: occData },
        material: { width: w, height: h, data: matData },
    });
    assert.equal(baked.validation.ok, true, baked.validation.errors.join('; '));
    assert.equal(baked.validation.stats.opaquePixels, 16);
    assert.equal(baked.validation.stats.transparentPixels, 20);

    // AO monotonicity: lower crevice (2,4) must be at least as occluded as exposed top (2,1).
    const mono = checkAoMonotonicity({
        rgba: baked.surfaceData,
        width: w,
        height: h,
        pairs: [{ open: [2, 1], crevice: [2, 4] }],
    });
    assert.equal(mono.ok, true, JSON.stringify(mono.violations));
    assert.equal(checkAoMonotonicity([0, 3, 7, 15]).ok, true);
    assert.equal(checkAoMonotonicity([0, 9, 4]).ok, false);

    // Corruption checks on validateSurfaceV1Buffer.
    const badOutside = new Uint8ClampedArray(baked.surfaceData);
    badOutside[0] = 1; // H16 != 0 on transparent pixel (0,0)
    assert.equal(validateSurfaceV1Buffer(badOutside, albedoData, w, h).ok, false);

    const badB = new Uint8ClampedArray(baked.surfaceData);
    badB[(1 * w + 1) * 4 + 2] = 64; // upper 2 bits set
    assert.equal(validateSurfaceV1Buffer(badB, albedoData, w, h).ok, false);

    const badValid = new Uint8ClampedArray(baked.surfaceData);
    badValid[(1 * w + 1) * 4 + 3] &= 127; // clear valid bit on opaque texel
    assert.equal(validateSurfaceV1Buffer(badValid, albedoData, w, h).ok, false);

    // CLI mode: --help and --check --id=building.forge (in-memory, zero writes).
    const cliPath = path.join(REPO_ROOT, 'scripts', 'sprites', 'bake-depth-channels.mjs');
    const helpOut = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /surface-v1/);
    const checkOut = execFileSync(process.execPath, [cliPath, '--check', '--id=building.forge'], { encoding: 'utf8' });
    assert.match(checkOut, /OK building\.forge/);
});

// ─── 2. Command — Miniature War Table (§5.1) ─────────────────────────────────

test('§5.1 Command War Table projects all 9 exact distinct landmark dots from real building centers', () => {
    const expected = {
        portal: [0, 3],
        mine: [4, 6],
        taskboard: [10, 9],
        archive: [9, 0],
        forge: [15, 8],
        command: [15, 2],
        tavern: [19, 4],
        harbor: [22, 6],
        watchtower: [25, 4],
    };

    assert.equal(Object.keys(WAR_TABLE_LANDMARKS).length, 9);
    const seenCells = new Set();

    for (const [type, [ex, ey]] of Object.entries(expected)) {
        const def = BUILDING_DEFS.find((d) => d.type === type);
        assert.ok(def, `BUILDING_DEFS has ${type}`);
        const center = buildingCenterToWorld({
            position: { tileX: def.x, tileY: def.y },
            width: def.width,
            height: def.height,
        });
        const projected = projectWarTableDot(center.x, center.y);
        assert.deepEqual([projected.tx, projected.ty], [ex, ey], `${type} dot`);
        assert.deepEqual([WAR_TABLE_LANDMARKS[type].tx, WAR_TABLE_LANDMARKS[type].ty], [ex, ey], `cached ${type} dot`);
        seenCells.add(`${ex},${ey}`);
    }
    assert.equal(seenCells.size, 9, 'all 9 landmark dots are strictly distinct');

    // Table top contract: 26x10 centered on [270, 184], sheared by -0.52.
    assert.equal(COMMAND_CUTAWAY_PROFILE.table.width, 26);
    assert.equal(COMMAND_CUTAWAY_PROFILE.table.height, 10);
    assert.deepEqual(COMMAND_CUTAWAY_PROFILE.table.center, [270, 184]);
    assert.equal(COMMAND_CUTAWAY_PROFILE.table.slope, -0.52);
});

test('§5.1 Command War Table: upright 3x5 vs errored 5x3 pawns, returned removal, 8-pawn cap & +N sill bar', () => {
    const leadA = { agentId: 'lead-a', status: 'working' };
    const leadB = { agentId: 'lead-b', status: 'working' };
    const waiter = { agentId: 'wait-c', status: 'waiting_on_user' };
    const helper = { agentId: 'work-d', status: 'working' };

    const buildings = ['portal', 'mine', 'taskboard', 'archive', 'forge', 'command', 'tavern', 'harbor', 'lighthouse', 'forge'];
    const childrenA = buildings.map((b, i) => ({
        id: `child-${i}`,
        parentSessionId: 'lead-a',
        building: b,
        status: i === 2 ? 'error' : 'working',
        trimColor: `#aa${String(i).padStart(2, '0')}55`,
    }));
    // Returned child must be omitted completely.
    const returnedChild = {
        id: 'child-returned',
        parentSessionId: 'lead-a',
        building: 'archive',
        status: 'returned',
        returned: true,
        trimColor: '#ff0000',
    };
    // Second lead's child should not mix onto lead-a's muster; lead-b is counted in sill bar.
    const childB = {
        id: 'child-b-1',
        parentSessionId: 'lead-b',
        building: 'mine',
        status: 'working',
    };

    const state = buildCommandWarTableState({
        presentedSessions: [leadA, leadB, waiter, helper],
        allAgents: [...childrenA, returnedChild, childB],
    });

    assert.equal(state.ownerLeadId, 'lead-a');
    assert.equal(state.totalLiveChildren, 10);
    assert.equal(state.pawns.length, WAR_TABLE_MAX_PAWNS);
    assert.equal(state.pawnOverflow, 2);
    assert.equal(state.otherLeadsWithChildren, 1);
    assert.equal(state.pawns.some((p) => p.agentId === 'child-returned'), false);

    // Upright 3x5 pawn on normal live child, prone 5x3 pawn on errored child.
    assert.equal(state.pawns[0].width, 3);
    assert.equal(state.pawns[0].height, 5);
    assert.equal(state.pawns[0].orientation, 'upright');
    assert.equal(state.pawns[0].tx, 0);
    assert.equal(state.pawns[0].ty, 3);

    assert.equal(state.pawns[2].errored, true);
    assert.equal(state.pawns[2].width, 5);
    assert.equal(state.pawns[2].height, 3);
    assert.equal(state.pawns[2].orientation, 'prone');
    assert.equal(state.pawns[2].tx, 10);
    assert.equal(state.pawns[2].ty, 9);

    // Exact sill bar format (fits 168 px at z2).
    assert.equal(formatCommandSillBar({ working: 3, waiting: 1, overflow: 2 }), '3 WORKING · 1 WAITING · +2');
    assert.equal(formatCommandSillBar({ working: 2, waiting: 0, overflow: 0 }), '2 WORKING · 0 WAITING');
    assert.equal(state.sillBar, '3 WORKING · 1 WAITING · +3');

    // Drawing in normal mode vs postcardFrame().
    const painted = [];
    const ctxLive = makeRecordingCtx();
    const liveRes = drawCommandWarTable(ctxLive, state, {
        paintText: (_ctx, text) => painted.push(text),
    });
    assert.equal(liveRes.drawnPawns, 8);
    assert.equal(liveRes.sillBarDrawn, true);
    assert.deepEqual(painted, [state.sillBar]);
    assert.equal(ctxLive.textCalls.length, 0, 'never calls ctx.fillText directly');

    const paintedPostcard = [];
    const ctxPostcard = makeRecordingCtx();
    const { result: pcRes, textCalls } = withPostcardFrame(() => drawCommandWarTable(ctxPostcard, state, {
        paintText: (_ctx, text) => paintedPostcard.push(text),
    }));
    assert.equal(pcRes.drawnPawns, 8);
    assert.equal(pcRes.sillBarDrawn, false, 'sill bar suppressed under postcardFrame()');
    assert.deepEqual(paintedPostcard, []);
    assert.equal(textCalls, 0);
});

// ─── 3. Archive — 5 Repo Bays & Compaction Shelf (§5.2) ──────────────────────

test('§5.2 Archive: 5 bays stable hashing, 5th fallback bay, 12-spine shelf cap, midnight clear & zero text in postcardFrame()', () => {
    // All 10 existing Archive room panes sit inside the slope +0.50 cut.
    for (const pane of BUILDING_VISUAL_REGISTRY.archive.rooms.slots) {
        assert.equal(
            apertureCutContains(ARCHIVE_CUTAWAY_PROFILE.cut, pane.at[0], pane.at[1]),
            true,
            `Archive room pane [${pane.at}] inside cut`,
        );
    }

    // 5 ground lancet X positions.
    assert.deepEqual(
        ARCHIVE_CUTAWAY_PROFILE.bays.map((b) => b.lancetAt[0]),
        [95, 115.5, 137.5, 159.5, 181.5],
    );

    // Stable directory hashing independent of input ordering.
    const dirs = ['claudeville', 'scripts', 'docs', 'tests', 'assets', 'bench'];
    const a1 = assignArchiveBays(dirs);
    const a2 = assignArchiveBays([...dirs].reverse());
    assert.deepEqual(
        a1.bays.map((b) => b.directory),
        a2.bays.map((b) => b.directory),
        'bay assignment is order-independent and stable',
    );
    assert.equal(a1.bays.length, 5);
    assert.equal(a1.bays[4].isFallback, true);
    assert.equal(a1.bays[4].label, 'everything else');
    assert.equal(a1.overflowDirectories.length, 2);
    for (const extra of a1.overflowDirectories) {
        assert.equal(a1.dirToBay.get(extra), 4, `${extra} falls into 5th bay`);
    }
    assert.equal(hashDirectoryName('scripts'), hashDirectoryName('scripts'));

    // Build Archive cutaway state with readers, compactions today + yesterday, and Loom hook.
    const today = new Date(2026, 10, 26, 14, 30, 0);
    const todayMorning = new Date(2026, 10, 26, 9, 0, 0).getTime();
    const yesterdayLate = new Date(2026, 10, 25, 23, 55, 0).getTime();

    const firstNamedDir = a1.bays[0].directory;
    const overflowDir = a1.overflowDirectories[0];

    const compactions = Array.from({ length: 14 }, (_, i) => ({
        id: `cmp-${i}`,
        agentId: `a-${i % 3}`,
        timestamp: todayMorning + i * 60_000,
        trimColor: '#d4984e',
    }));
    // Add one yesterday compaction (must be cleared at local midnight) and one Chronicle event today.
    compactions.push({ id: 'old-cmp', agentId: 'a-0', timestamp: yesterdayLate, trimColor: '#999999' });
    const chronicleEvents = [
        { id: 'chr-1', kind: 'compacted', agentId: 'a-1', timestamp: todayMorning + 20 * 60_000, trimColor: '#6f82c6' },
        { id: 'cmp-0', kind: 'compacted', agentId: 'a-0', timestamp: todayMorning, trimColor: '#d4984e' }, // duplicate id deduped
    ];

    const state = buildArchiveCutawayState({
        directories: dirs,
        agents: [
            {
                id: 'reader-1',
                repoRoot: '/repo/alpha',
                workingSet: [
                    { path: `${overflowDir}/old.js`, updatedAt: 100 },
                    { path: `${firstNamedDir}/App.js`, updatedAt: 200 },
                ],
            },
            {
                id: 'reader-2',
                repoRoot: '/repo/alpha',
                workingSet: ['README.md'], // root file -> 5th bay
            },
        ],
        compactions,
        chronicleEvents,
        now: today,
        loomPanel: { fakeCanvas: true },
    });

    assert.equal(state.readers[0].bayIndex, 0, 'reader stands at bay of newest workingSet path');
    assert.equal(state.readers[1].bayIndex, 4, 'root file routes to 5th everything-else bay');
    assert.equal(state.compactionShelf.totalToday, 15, '14 compactions + 1 unique Chronicle compacted today; yesterday excluded');
    assert.equal(state.compactionShelf.spines.length, ARCHIVE_MAX_SPINES);
    assert.equal(state.compactionShelf.overflow, 3);
    assert.equal(state.compactionShelf.spines[0].width, 2);
    assert.equal(state.compactionShelf.spines[0].height, 6);
    assert.equal(state.loomWall.sourceWidth, 96);
    assert.equal(state.loomWall.sourceHeight, 72);

    // Draw normally without bay names vs with bay names vs under postcardFrame().
    const ctxDefault = makeRecordingCtx();
    const resDefault = drawArchiveCutaway(ctxDefault, state);
    assert.equal(resDefault.drawnSpines, 12);
    assert.equal(resDefault.overflowStamped, true);
    assert.equal(resDefault.bayNamesDrawn, false);
    assert.equal(ctxDefault.images.length, 1, 'Loom of Days panel scaled onto rear wall');
    assert.equal(ctxDefault.textCalls.length, 0);

    const glassTexts = [];
    const ctxGlass = makeRecordingCtx();
    const resGlass = drawArchiveCutaway(ctxGlass, state, {
        showBayNames: true,
        paintText: (_ctx, text) => glassTexts.push(text),
    });
    assert.equal(resGlass.bayNamesDrawn, true);
    assert.equal(glassTexts.length, 1);

    // Under postcardFrame(), even showBayNames=true MUST emit zero text and draw no bay names.
    const postcardTexts = [];
    const ctxPostcard = makeRecordingCtx();
    const { result: resPc, textCalls } = withPostcardFrame(() => drawArchiveCutaway(ctxPostcard, state, {
        showBayNames: true,
        paintText: (_ctx, text) => postcardTexts.push(text),
    }));
    assert.equal(resPc.bayNamesDrawn, false);
    assert.deepEqual(postcardTexts, []);
    assert.equal(ctxPostcard.textCalls.length, 0);
    assert.equal(textCalls, 0);
});

// ─── 4. Harbor — Chart Loft (§5.3) ───────────────────────────────────────────

test('§5.3 Harbor Chart Loft: 2 Harbor-classified slots, 4-lantern cap + numeral stamp & zero text', () => {
    // Rooms 3, 4 and 5 (index 2, 3, 4 of Harbor windowRects) fall inside the Chart Loft cut.
    for (const [x, y] of [[151.5, 104], [144, 108.5], [159, 101.5]]) {
        assert.equal(apertureCutContains(HARBOR_CUTAWAY_PROFILE.cut, x, y), true, `Harbor room [${x},${y}] inside cut`);
    }

    const agents = [
        { id: 'harbor-1', currentTool: 'Bash', toolInput: { command: 'git commit -m "feat"' } },
        { id: 'archive-1', currentTool: 'Read', toolInput: { file_path: 'README.md' } },
        { id: 'harbor-2', currentTool: 'Bash', toolInput: { command: 'git push origin main' } },
        { id: 'harbor-3', currentTool: 'Bash', toolInput: { command: 'git status' } },
    ];
    const pendingRepos = [
        { repoRoot: '/work/alpha', pendingCommits: 2 },
        { repoRoot: '/work/beta', pendingCommits: 1 },
        { repoRoot: '/work/gamma', pendingCommits: 4 },
        { repoRoot: '/work/delta', pendingCommits: 1 },
        { repoRoot: '/work/epsilon', pendingCommits: 3 },
        { repoRoot: '/work/zeta', pendingCommits: 1 },
        { repoRoot: '/work/clean', pendingCommits: 0 }, // ignored
    ];

    const state = buildHarborCutawayState({ agents, harborPendingRepos: pendingRepos });
    assert.equal(state.hasText, false);
    assert.equal(state.slots[0].id, 'chartTable');
    assert.equal(state.slots[0].pose, 'think');
    assert.equal(state.slots[0].agentId, 'harbor-1');
    assert.equal(state.slots[1].id, 'ledgerDesk');
    assert.equal(state.slots[1].pose, 'tinker');
    assert.equal(state.slots[1].agentId, 'harbor-2');
    assert.equal(state.signalRack.totalPendingRepos, 6);
    assert.equal(state.signalRack.lanterns.length, HARBOR_MAX_LANTERNS);
    assert.equal(state.signalRack.overflow, 2);

    const ctx = makeRecordingCtx();
    const { result, textCalls } = withPostcardFrame(() => drawHarborCutaway(ctx, state));
    assert.equal(result.drawnLanterns, 4);
    assert.equal(result.overflowStamped, true);
    assert.equal(ctx.textCalls.length, 0);
    assert.equal(textCalls, 0);
});

// ─── 5. Bayer Cutaway Peel Controller & OpenFront Engine ─────────────────────

test('CutawayPeelController: selection>=z2 & 300ms Glass dwell triggers, 4x150ms Bayer steps & reducedMotion instant swap', () => {
    assert.equal(BAYER_4X4.length, 16);
    assert.equal(normalizeCutawayLayers(CUTAWAY_LAYERS_4).hasRoofPeel, true);
    assert.equal(normalizeCutawayLayers(CUTAWAY_LAYERS_3).hasRoofPeel, false);
    assert.equal(normalizeCutawayLayers(['only-one']), null);

    // Pure Bayer peel mask coverage across an 8x8 tile (4 blocks of 4x4): 100%, 75%, 50%, 25%, 0%.
    const expectedCoverage = [1, 0.75, 0.5, 0.25, 0];
    for (let step = 0; step <= 4; step++) {
        const mask = buildBayerPeelMask(8, 8, step);
        const kept = mask.reduce((sum, v) => sum + v, 0);
        assert.equal(kept / mask.length, expectedCoverage[step], `step ${step} coverage`);
        assert.ok(mask.every((v) => v === 0 || v === 1), 'strictly binary integer mask');
    }

    // applyBayerPeelToRgba preserves exact bytes with zero smooth alpha fades.
    const solid = new Uint8ClampedArray(16 * 4);
    for (let i = 0; i < 16; i++) {
        solid[i * 4] = 95;
        solid[i * 4 + 1] = 128;
        solid[i * 4 + 2] = 161;
        solid[i * 4 + 3] = 255;
    }
    const halfPeeled = applyBayerPeelToRgba(solid, 4, 4, 2);
    let opaque = 0;
    let clear = 0;
    for (let i = 0; i < 16; i++) {
        const a = halfPeeled[i * 4 + 3];
        assert.ok(a === 0 || a === 255, `no smooth alpha: got ${a}`);
        if (a === 255) opaque++;
        else clear++;
    }
    assert.equal(opaque, 8);
    assert.equal(clear, 8);

    // Selection at z < 2 stays closed.
    const ctrl = new CutawayPeelController();
    let snap = ctrl.update({ buildingId: 'command', selected: true, zoom: 1.5, now: 1000 });
    assert.equal(snap.isOpen, false);
    assert.equal(snap.step, 0);
    assert.equal(snap.roofCoverage, 1);

    // Selection at z >= 2 steps through 4x150ms discrete peel stages (600ms total).
    snap = ctrl.update({ buildingId: 'command', selected: true, zoom: 2, now: 1000 });
    assert.equal(snap.trigger, 'selection');
    assert.equal(snap.step, 0);
    assert.equal(snap.roofCoverage, 1);
    for (let step = 1; step <= 4; step++) {
        snap = ctrl.update({ buildingId: 'command', selected: true, zoom: 2, now: 1000 + step * BAYER_PEEL_STEP_MS });
        assert.equal(snap.step, step, `step ${step} at ${step * 150}ms`);
        assert.equal(snap.roofCoverage, expectedCoverage[step]);
    }
    assert.equal(snap.fullyOpen, true);
    assert.equal(snap.state, 'open');

    // Reduced motion swaps instantly (0ms) on open and close.
    const rmCtrl = new CutawayPeelController();
    const rmOpen = rmCtrl.update({ buildingId: 'archive', selected: true, zoom: 2, now: 5000, reducedMotion: true });
    assert.equal(rmOpen.step, 4);
    assert.equal(rmOpen.roofCoverage, 0);
    assert.equal(rmOpen.fullyOpen, true);
    const rmClose = rmCtrl.update({ buildingId: 'archive', selected: false, zoom: 2, now: 5000, reducedMotion: true });
    assert.equal(rmClose.step, 0);
    assert.equal(rmClose.isOpen, false);

    // Inspection Glass dwell trigger: closed before 300ms, opens at >= 300ms even at zoom 1.
    const glassCtrl = new CutawayPeelController();
    assert.equal(glassCtrl.update({ buildingId: 'harbor', glassHover: true, zoom: 1, now: 2000 }).isOpen, false);
    assert.equal(glassCtrl.update({ buildingId: 'harbor', glassHover: true, zoom: 1, now: 2000 + GLASS_DWELL_MS - 1 }).isOpen, false);
    const dwellStart = glassCtrl.update({ buildingId: 'harbor', glassHover: true, zoom: 1, now: 2000 + GLASS_DWELL_MS });
    assert.equal(dwellStart.trigger, 'glass-dwell');
    assert.equal(dwellStart.isOpen, true);
    assert.equal(dwellStart.step, 0);
    const dwellStep2 = glassCtrl.update({ buildingId: 'harbor', glassHover: true, zoom: 1, now: 2000 + GLASS_DWELL_MS + 300 });
    assert.equal(dwellStep2.step, 2);
    assert.equal(dwellStep2.roofCoverage, 0.5);
});

test('OpenFront: Tavern & Forge profiles, exact RGBA byte preservation, bay containment and Forge draw order', () => {
    const tavern = getOpenFrontProfile('tavern');
    const forge = getOpenFrontProfile('building.forge');
    assert.ok(tavern && forge);
    assert.equal(tavern.frontArchRows, TAVERN_ARCH_ROWS);
    assert.equal(forge.frontArchRows, FORGE_ARCH_ROWS);
    assert.deepEqual(forge.nativeSize, { width: 256, height: 232 });
    assert.deepEqual(forge.anchor, [128, 169]);
    assert.ok(forge.bays.some((b) => b.id === 'forge-anvil'));
    assert.ok(forge.bays.some((b) => b.id === 'forge-hearth'));

    // Exact byte preservation across splitOpenFrontMask for Forge (256x232).
    const w = 256;
    const h = 232;
    const sourceRgba = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
        sourceRgba[p * 4] = (p * 17) & 255;
        sourceRgba[p * 4 + 1] = (p * 31) & 255;
        sourceRgba[p * 4 + 2] = (p * 47) & 255;
        sourceRgba[p * 4 + 3] = 255;
    }
    const split = splitOpenFrontMask(w, h, forge.frontArchRows, sourceRgba);
    assert.ok(split.frontArchCount > 500, 'Forge front arch mask covers piers and lintel');
    assert.equal(split.frontArchCount + split.rearInteriorCount, w * h);
    // Open smithy mouth center (x=86, y=170) stays in rearInterior, never frontArch.
    assert.equal(split.frontArchMask[170 * w + 86], 0, 'open mouth stays in rearInterior');
    assert.equal(split.rearInteriorMask[170 * w + 86], 1);
    // Left pier (x=50, y=150) belongs to frontArch.
    assert.equal(split.frontArchMask[150 * w + 50], 1, 'left pier in frontArch');

    for (let p = 0; p < w * h; p++) {
        assert.equal(split.frontArchMask[p] + split.rearInteriorMask[p], 1);
        const o = p * 4;
        for (let c = 0; c < 4; c++) {
            const frontByte = split.frontArchRgba[o + c];
            const rearByte = split.rearInteriorRgba[o + c];
            assert.ok(frontByte === 0 || rearByte === 0, 'strictly disjoint bytes');
            assert.equal(frontByte + rearByte, sourceRgba[o + c], 'exact zero-loss byte preservation');
        }
    }

    // Forge bay containment & draw order: agents inside Forge bay sort BEHIND frontArch and IN FRONT of rearInterior.
    const forgeDef = BUILDING_DEFS.find((d) => d.type === 'forge');
    const forgeBuilding = new Building(forgeDef);
    const forgeAnchor = buildingCenterToWorld(forgeBuilding);

    for (const bay of forge.bays) {
        const bayWorld = tileToWorld(bay.tile.tileX, bay.tile.tileY);
        assert.equal(isPointInsideOpenBay('forge', bayWorld, forgeAnchor), true, `${bay.id} inside Forge bay`);
        const drawOrder = resolveOpenFrontDrawOrder('forge', bayWorld, forgeAnchor);
        assert.equal(drawOrder.insideBay, true);
        assert.deepEqual(drawOrder.order, ['rearInterior', 'agent', 'frontArch'], `${bay.id} sandwiches between rearInterior and frontArch`);
        assert.ok(drawOrder.rearInteriorSortY < drawOrder.agentSortY);
        assert.ok(drawOrder.agentSortY < drawOrder.frontArchSortY);
    }

    // Agent outside Forge in the yard renders IN FRONT of the front arch.
    const forgeYard = tileToWorld(27.5, 29.5);
    assert.equal(isPointInsideOpenBay('forge', forgeYard, forgeAnchor), false);
    const yardOrder = resolveOpenFrontDrawOrder('forge', forgeYard, forgeAnchor);
    assert.deepEqual(yardOrder.order, ['rearInterior', 'frontArch', 'agent']);
    assert.ok(openFrontRearSortY('forge', forgeYard.x, forgeAnchor) < openFrontArchSortY('forge', forgeYard.x, forgeAnchor));

    // Generalized StaticPropSprite column occlusion builder for both Tavern and Forge.
    const tavernDef = BUILDING_DEFS.find((d) => d.type === 'tavern');
    const tavernBuilding = new Building(tavernDef);
    const mockAssets = {
        get: (id) => (id === 'building.tavern' ? { width: 296, height: 288 } : { width: 256, height: 232 }),
        getAnchor: (id) => (id === 'building.tavern' ? [158, 218] : [128, 169]),
        getEntry: () => ({ materialClass: 'stone' }),
    };

    const [tavernSprite] = buildOpenFrontSprites({ buildingId: 'tavern', building: tavernBuilding, assets: mockAssets });
    const [forgeSprite] = buildOpenFrontSprites({ buildingId: 'forge', building: forgeBuilding, assets: mockAssets });
    assert.ok(tavernSprite.occlusionColumns.length > 4);
    assert.ok(forgeSprite.occlusionColumns.length > 4);

    // Forge anvil occupant paints before its matching frontArch column; yard actor paints after it.
    const anvilPos = tileToWorld(forge.bays[1].tile.tileX, forge.bays[1].tile.tileY);
    const anvilCol = forgeSprite.occlusionColumns.find(
        (col) => anvilPos.x - forgeSprite.x >= col.left && anvilPos.x - forgeSprite.x < col.right,
    );
    assert.ok(anvilCol && anvilCol.sortY > anvilPos.y, 'anvil occupant renders behind front arch column');

    const yardCol = forgeSprite.occlusionColumns.find(
        (col) => forgeYard.x - forgeSprite.x >= col.left && forgeYard.x - forgeSprite.x < col.right,
    );
    assert.ok(yardCol && yardCol.sortY < forgeYard.y, 'yard occupant renders in front of front arch column');
    assert.equal(Object.keys(OPEN_FRONT_PROFILES).includes('tavern'), true);
    assert.equal(Object.keys(OPEN_FRONT_PROFILES).includes('forge'), true);
});
