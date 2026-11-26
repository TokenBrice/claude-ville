import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
    ALLOWED_SEMANTIC_LANDMARKS,
    DEPTH_MAX,
    DEPTH_SPAN,
    E2_SCULPTED_SITES,
    FULL_TILE_POLY,
    assertSemanticLandmark,
    canonicalTile,
    createE2PilotTerrain,
    createSurfaceRegistry,
    depthToNormalized,
    faceStopIndex,
    isSemanticLandmark,
    localTileCoords,
    pickProjectedTriangles,
    pickSurfaceHeight,
    pickSurfaceIntersection,
    planeHeight,
    polygonSignedArea2,
    projectSurface,
    screenRayToTile,
    tileCoords,
    tileIndex,
    validateTerrainDef,
} from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const propsDir = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

function fullPoly() {
    return FULL_TILE_POLY.map((pt) => [...pt]);
}

function makeBaseTerrain(overrides = {}) {
    const full = fullPoly();
    return {
        version: 1,
        revision: 'w6-a-unit-fixture',
        pools: [{ id: 1, h16: -96, flow: [0, 1] }],
        tiles: [
            {
                tile: 820,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'grass',
                        walk: true,
                        basin: null,
                    },
                ],
            },
            {
                tile: 821,
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [-96, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 1,
                    },
                ],
            },
        ],
        banks: [
            {
                top: [820, 0],
                water: [821, 1],
                edge: [[256, 0], [256, 256]],
                lip16: 0,
                material: 'ashlar',
                style: 'forge-moss',
                foam: true,
            },
        ],
        footings: [
            {
                landmark: 'archive',
                support: [820, 0],
                poly: [[0, 0], [128, 0], [128, 64], [0, 64]],
                courses16: [16, 32],
                material: 'stone',
                orientation: 'SE',
            },
        ],
        links: [],
        spills: [],
        ...overrides,
    };
}

// ------------------------------------------------------------------ 1. specs/01 §5 oracle assertions

test('specs/01 §5 elevation & ray-picking oracle assertions match exactly', () => {
    // lift(u, v, h) = [32*(u-v), 16*(u+v)-h, 32*(u+v)+h/2]
    const p0 = projectSurface(10, 10, 0);
    assert.deepEqual([p0.x, p0.y, p0.d], [0, 320, 640]);

    const p1 = projectSurface(10 + 1 / 32, 10 + 1 / 32, 1);
    assert.deepEqual([p1.x, p1.y, p1.d], [p0.x, p0.y, p0.d + 2.5]);

    // Normalized depth mapping (Depth32Float clear=1, compare=less)
    assert.equal(depthToNormalized(p0.d), (DEPTH_MAX - 640) / DEPTH_SPAN);
    assert.ok(depthToNormalized(p1.d) < depthToNormalized(p0.d));

    // Stair sample pick: plane16 = [0, 128, 0], h(a=0.5) = 4
    const stairSample = projectSurface(10, 10, 4);
    assert.equal(pickSurfaceHeight(stairSample.x, stairSample.y, 10, 10, [0, 128, 0]), 4);

    // Raised +8 tile pick: [128, 0, 0] -> 8
    assert.equal(pickSurfaceHeight(0, 320, 10, 10, [128, 0, 0]), 8);

    // Flat ground tile pick: [0, 0, 0] -> 0
    assert.equal(pickSurfaceHeight(0, 320, 10, 10, [0, 0, 0]), 0);

    // Tile index, inverse, canonical local (a, b), and ray inversion
    assert.equal(tileIndex(20, 20), 820);
    assert.deepEqual(tileCoords(820), { tx: 20, ty: 20 });
    assert.equal(tileIndex(0, 0), 0);
    assert.equal(tileIndex(39, 39), 1599);

    const canon = canonicalTile(10, 10);
    assert.deepEqual(canon, { tx: 10, ty: 10, tile: 410, a: 0.5, b: 0.5 });
    assert.deepEqual(localTileCoords(10.25, 9.75, 10, 10), { a: 0.75, b: 0.25 });
    assert.equal(planeHeight([0, 128, 0], 0.5, 0.5), 4);
    assert.deepEqual(screenRayToTile(0, 320, 0), { u: 10, v: 10 });

    // §5 bank lip drop check on base fixture: (lip16 - lowerWater.plane16[0]) / 16 === 6
    const base = makeBaseTerrain();
    const reg = createSurfaceRegistry(base);
    const bank = reg.banks[0];
    const lowerWater = reg.getSurfaceByKey(bank.water);
    assert.equal((bank.lip16 - lowerWater.plane16[0]) / 16, 6);
});

test('parallel/coplanar denom === 0 fallback avoids division by zero and enforces top-left fill rule', () => {
    // ha + hb = 512 -> denom = 16 - 512/32 = 0 (viewing ray parallel to plane)
    const hitA = pickSurfaceHeight(0, 320, 10, 10, [0, 256, 256]);
    const hitB = pickSurfaceHeight(0, 320, 10, 10, [0, 512, 0]);
    const hitC = pickSurfaceIntersection(0, 304, 10, 10, [0, 256, 256]);

    // Edge-on plane projects to zero area -> degenerate zero-area face cannot own a pixel; never NaN/Infinity!
    assert.equal(hitA, null);
    assert.equal(hitB, null);
    assert.equal(hitC, null);
    assert.ok(!Number.isNaN(hitA) && !Number.isNaN(hitB));

    // Non-degenerate projected vertical riser quad split into 2 adjacent triangles:
    // Every pixel on the shared diagonal must belong to EXACTLY ONE triangle under top-left fill!
    const vTL = { x: 0, y: 0, d: 100, h: 8 };
    const vTR = { x: 10, y: 0, d: 100, h: 8 };
    const vBR = { x: 10, y: 10, d: 100, h: 0 };
    const vBL = { x: 0, y: 10, d: 100, h: 0 };

    const triA = [vTL, vTR, vBL];
    const triB = [vTR, vBR, vBL];

    // Interior hit on vertical riser interpolates height linearly (y=5 -> h=4)
    const midHit = pickProjectedTriangles(5, 5, [triA, triB]);
    assert.ok(midHit !== null);
    assert.equal(midHit.h, 4);
    assert.equal(midHit.d, 100);

    // Top-left fill seam check on shared diagonal (5, 5): owned by triB ONLY, never both or neither
    const hitTriA = pickProjectedTriangles(5, 5, [triA]);
    const hitTriB = pickProjectedTriangles(5, 5, [triB]);
    assert.equal((hitTriA !== null) ^ (hitTriB !== null), 1);

    // Top edge (5, 0) included; bottom edge (5, 10) and right edge (10, 5) excluded
    assert.ok(pickProjectedTriangles(5, 0, [triA, triB]) !== null);
    assert.equal(pickProjectedTriangles(5, 10, [triA, triB]), null);
    assert.equal(pickProjectedTriangles(10, 5, [triA, triB]), null);

    // Zero-area degenerate triangle explicitly rejected
    const degenTri = [
        { x: 0, y: 0, d: 500, h: 16 },
        { x: 10, y: 0, d: 500, h: 16 },
        { x: 20, y: 0, d: 500, h: 16 },
    ];
    assert.equal(pickProjectedTriangles(5, 0, [degenTri]), null);
});

// ------------------------------------------------------------------ 2. Overlap tile & picking

test('overlap tile [820, 0] ground + [820, 2] slab [96, 128] queries, bounds, and topmost picking', () => {
    const full = fullPoly();
    const terrain = makeBaseTerrain({
        tiles: [
            {
                tile: 820, // (20, 20)
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'grass',
                        walk: true,
                        basin: null,
                    },
                    {
                        id: 2,
                        kind: 'floor',
                        poly: full,
                        plane16: [128, 0, 0],
                        underside16: 96,
                        material: 'timber',
                        walk: true,
                        basin: null,
                        route: 'bridge',
                    },
                ],
            },
            {
                tile: 821, // (21, 20)
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [-96, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 1,
                    },
                ],
            },
        ],
    });

    const reg = createSurfaceRegistry(terrain);

    // Per-surface heights require surfaceId at overlaps
    assert.equal(reg.heightAt(20, 20, 0), 0);
    assert.equal(reg.heightAt(20, 20, 2), 8);
    assert.throws(() => reg.heightAt(20, 20), /requires explicit surfaceId/i);

    // Slab bounds: [96, 128] in 1/16 px = [6, 8] in art px (void [0, 6] open below!)
    assert.deepEqual(reg.slabBoundsAt(20, 20, 2), {
        top16: 128,
        underside16: 96,
        top: 8,
        underside: 6,
    });
    assert.deepEqual(reg.slabBoundsAt(20, 20, 0), {
        top16: 0,
        underside16: null,
        top: 0,
        underside: null,
    });

    // Ray hitting tile (20, 20) center at screen point (0, 640) intersects BOTH ground (h=0)
    // and raised slab (h=8 at a=0.75, b=0.75, higher D = 32*(20.25+20.25)+4 = 1300 vs 1280)!
    const screenAtCenter = projectSurface(20, 20, 0);
    const topPick = reg.pickTopSurface(screenAtCenter.x, screenAtCenter.y, [820, 821]);
    assert.ok(topPick !== null);
    assert.equal(topPick.tile, 820);
    assert.equal(topPick.surfaceId, 2);
    assert.equal(topPick.h, 8);
    assert.ok(topPick.d > screenAtCenter.d);

    // Deterministic tie-breaking: two coplanar surfaces at identical D & h -> higher surfaceId wins
    const tieTerrain = makeBaseTerrain({
        tiles: [
            {
                tile: 820,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'grass',
                        walk: true,
                        basin: null,
                    },
                    {
                        id: 5,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'plaza',
                        walk: true,
                        basin: null,
                    },
                ],
            },
            {
                tile: 821,
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [-96, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 1,
                    },
                ],
            },
        ],
    });
    const tieReg = createSurfaceRegistry(tieTerrain);
    const tiePick = tieReg.pickTopSurface(screenAtCenter.x, screenAtCenter.y, [820]);
    assert.equal(tiePick.surfaceId, 5);

    // Nonselectable opaque foreground slab blocks picks through to ground behind it
    const blockedTerrain = makeBaseTerrain({
        tiles: [
            {
                tile: 820,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'grass',
                        walk: true,
                        basin: null,
                    },
                    {
                        id: 2,
                        kind: 'floor',
                        poly: full,
                        plane16: [128, 0, 0],
                        underside16: 96,
                        material: 'ashlar',
                        walk: false,
                        basin: null,
                        selectable: false,
                    },
                ],
            },
            {
                tile: 821,
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [-96, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 1,
                    },
                ],
            },
        ],
    });
    const blockedReg = createSurfaceRegistry(blockedTerrain);
    const blocker = blockedReg.pickTopSurface(screenAtCenter.x, screenAtCenter.y, [820]);
    assert.equal(blocker.selectableId, null);
    assert.equal(blocker.blockerDepth, blocker.d);
    assert.equal(blocker.blockerDepth, topPick.d);
    assert.equal(blocker.surfaceId, 2);
});

// ------------------------------------------------------------------ 3. Link validation (exact height, no diagonal cuts)

test('stair link validation accepts exact joins and rejects 1-unit mismatch & diagonal corner cuts', () => {
    const full = fullPoly();
    const tGround = tileIndex(10, 10);
    const tStair = tileIndex(11, 10);
    const tTerrace = tileIndex(12, 10);
    const tDiag = tileIndex(11, 11);

    const makeStairTerrain = (terraceH0, extraLinks = []) => ({
        version: 1,
        revision: 'stair-link-test',
        pools: [],
        tiles: [
            {
                tile: tGround,
                surfaces: [{ id: 0, kind: 'floor', poly: full, plane16: [0, 0, 0], underside16: null, material: 'road', walk: true, basin: null }],
            },
            {
                tile: tStair,
                surfaces: [{ id: 3, kind: 'stair', poly: full, plane16: [0, 128, 0], underside16: null, material: 'ashlar', walk: true, basin: null }],
            },
            {
                tile: tTerrace,
                surfaces: [{ id: 2, kind: 'floor', poly: full, plane16: [terraceH0, 0, 0], underside16: null, material: 'plaza', walk: true, basin: null }],
            },
            {
                tile: tDiag,
                surfaces: [{ id: 0, kind: 'floor', poly: full, plane16: [0, 0, 0], underside16: null, material: 'road', walk: true, basin: null }],
            },
        ],
        banks: [],
        footings: [],
        links: [
            { from: [tGround, 0], to: [tStair, 3], fromEdge: 1, toEdge: 3, bidirectional: true },
            { from: [tStair, 3], to: [tTerrace, 2], fromEdge: 1, toEdge: 3, bidirectional: true },
            ...extraLinks,
        ],
        spills: [],
    });

    // Exact match (+8 px = 128 in 1/16 px): ACCEPTED
    const reg = createSurfaceRegistry(makeStairTerrain(128));
    assert.equal(reg.areLinked([tGround, 0], [tStair, 3]), true);
    assert.equal(reg.areLinked([tStair, 3], [tTerrace, 2]), true);
    assert.equal(reg.areLinked([tTerrace, 2], [tStair, 3]), true);
    assert.ok(reg.linkCost3D(reg.links[0]) > 32); // 3D hypotenuse > flat 32px step

    // 1-unit (1/16 px) height mismatch (129 vs 128): REJECTED
    assert.throws(() => createSurfaceRegistry(makeStairTerrain(129)), /endpoint height mismatch/i);
    assert.throws(() => createSurfaceRegistry(makeStairTerrain(127)), /endpoint height mismatch/i);

    // Diagonal corner cut (10,10) -> (11,11): REJECTED
    assert.throws(
        () => createSurfaceRegistry(makeStairTerrain(128, [
            { from: [tGround, 0], to: [tDiag, 0], fromEdge: 1, toEdge: 3, bidirectional: true },
        ])),
        /diagonal corner cut/i,
    );

    // Wrong (non-opposite) edge indices on adjacent tiles: REJECTED
    const badEdge = makeStairTerrain(128);
    badEdge.links[0] = { from: [tGround, 0], to: [tStair, 3], fromEdge: 1, toEdge: 1, bidirectional: true };
    assert.throws(() => createSurfaceRegistry(badEdge), /opposite CCW order/i);
});

// ------------------------------------------------------------------ 4. Spill, pool & polygon validation

test('spill and pool validation enforces upper H > lower H, distinct pools, and water plane parity', () => {
    const full = fullPoly();
    const tUpper = tileIndex(11, 11);
    const tLower = tileIndex(11, 12);

    const makeSpillTerrain = (upperH16, lowerH16, lowerBasin = 1, upperPlaneOverride = null) => ({
        version: 1,
        revision: 'spill-test',
        pools: [
            { id: 1, h16: lowerH16, flow: [0, 1] },
            { id: 2, h16: upperH16, flow: [0, 1] },
        ],
        tiles: [
            {
                tile: tUpper,
                surfaces: [{ id: 1, kind: 'water', poly: full, plane16: upperPlaneOverride ?? [upperH16, 0, 0], underside16: null, material: 'shallowWater', walk: false, basin: 2 }],
            },
            {
                tile: tLower,
                surfaces: [{ id: 1, kind: 'water', poly: full, plane16: [lowerH16, 0, 0], underside16: null, material: 'shallowWater', walk: false, basin: lowerBasin }],
            },
        ],
        banks: [],
        footings: [],
        links: [],
        spills: [
            { id: 'spill-1', upper: [tUpper, 1], lower: [tLower, 1], edge: [[0, 256], [256, 256]], frames: 4 },
        ],
    });

    // Valid head drop: +112 > -16 (+7 px -> -1 px = 8 px drop)
    const reg = createSurfaceRegistry(makeSpillTerrain(112, -16));
    assert.equal(reg.spills.length, 1);
    assert.equal(reg.spillsForPool(2).length, 1);

    // Reject upper H === lower H
    assert.throws(() => createSurfaceRegistry(makeSpillTerrain(0, 0)), /upper pool H.*> lower pool H/i);
    // Reject upper H < lower H
    assert.throws(() => createSurfaceRegistry(makeSpillTerrain(-32, -16)), /upper pool H.*> lower pool H/i);
    // Reject same pool referenced for both upper & lower
    assert.throws(() => createSurfaceRegistry(makeSpillTerrain(112, 112, 2)), /distinct pools/i);
    // Reject water plane != pool h16
    assert.throws(() => createSurfaceRegistry(makeSpillTerrain(112, -16, 1, [96, 0, 0])), /must equal pool/i);

    // Reject adjacent water tiles with conflicting heights and NO spill
    const noSpillConflict = makeSpillTerrain(112, -16);
    noSpillConflict.spills = [];
    assert.throws(() => createSurfaceRegistry(noSpillConflict), /conflicting heights without a spill/i);

    // Reject CW winding & zero-area polygons
    const cwPoly = [[0, 0], [0, 256], [256, 256], [256, 0]];
    assert.ok(polygonSignedArea2(cwPoly) < 0);
    const badWinding = makeBaseTerrain();
    badWinding.tiles[0].surfaces[0].poly = cwPoly;
    assert.throws(() => createSurfaceRegistry(badWinding), /counterclockwise/i);

    const zeroArea = makeBaseTerrain();
    zeroArea.tiles[0].surfaces[0].poly = [[0, 0], [128, 128], [256, 256]];
    assert.throws(() => createSurfaceRegistry(zeroArea), /zero area/i);

    // Reject duplicate surface IDs on one tile & soffit above top
    const dupId = makeBaseTerrain();
    dupId.tiles[0].surfaces.push({ ...dupId.tiles[0].surfaces[0] });
    assert.throws(() => createSurfaceRegistry(dupId), /duplicate surface id/i);

    const badSoffit = makeBaseTerrain();
    badSoffit.tiles[0].surfaces[0].underside16 = 16; // top is 0!
    assert.throws(() => createSurfaceRegistry(badSoffit), /strictly below top plane/i);
});

// ------------------------------------------------------------------ 5. Legacy save non-teleport guarantee

test('resolveLegacySurface preserves known routes and never teleports onto disconnected elevated terraces', () => {
    const full = fullPoly();
    const tGround = tileIndex(10, 10);
    const tOverlap = tileIndex(11, 10);
    const tDisconnectedTerrace = tileIndex(12, 10);

    const reg = createSurfaceRegistry({
        version: 1,
        revision: 'legacy-save-test',
        pools: [],
        tiles: [
            {
                tile: tGround,
                surfaces: [
                    { id: 0, kind: 'floor', poly: full, plane16: [0, 0, 0], underside16: null, material: 'road', walk: true, basin: null, route: 'ground', legacy: true },
                ],
            },
            {
                tile: tOverlap,
                surfaces: [
                    { id: 0, kind: 'floor', poly: full, plane16: [0, 0, 0], underside16: null, material: 'road', walk: true, basin: null, route: 'ground', legacy: true },
                    { id: 2, kind: 'floor', poly: full, plane16: [128, 0, 0], underside16: 96, material: 'timber', walk: true, basin: null, route: 'bridge' },
                ],
            },
            {
                tile: tDisconnectedTerrace,
                surfaces: [
                    // Elevated +16 px terrace with NO ground floor and NO link from ground!
                    { id: 2, kind: 'floor', poly: full, plane16: [256, 0, 0], underside16: null, material: 'plaza', walk: true, basin: null, route: 'archive-terrace' },
                ],
            },
        ],
        banks: [],
        footings: [],
        links: [
            { from: [tGround, 0], to: [tOverlap, 0], fromEdge: 1, toEdge: 3, bidirectional: true },
        ],
        spills: [],
    });

    // Overlap tile: onBridge=false -> stays on ground [id=0, H=0]
    const under = reg.resolveLegacySurface(11, 10, { onBridge: false });
    assert.equal(under.tile, tOverlap);
    assert.equal(under.surfaceId, 0);
    assert.equal(under.height, 0);
    assert.equal(under.fallback, false);

    // Overlap tile: onBridge=true -> resolves onto bridge deck [id=2, H=8]
    const over = reg.resolveLegacySurface(11, 10, { onBridge: true });
    assert.equal(over.tile, tOverlap);
    assert.equal(over.surfaceId, 2);
    assert.equal(over.height, 8);
    assert.equal(over.fallback, false);

    // Disconnected elevated terrace tile: legacy actor MUST NOT teleport onto [tDisconnectedTerrace, 2] (+16)!
    // Instead falls back to nearest reachable legacy landing [tOverlap, 0] (H=0)!
    const noTeleport = reg.resolveLegacySurface(12, 10, { onBridge: false });
    assert.notEqual(noTeleport.tile, tDisconnectedTerrace);
    assert.notEqual(noTeleport.surfaceId, 2);
    assert.equal(noTeleport.tile, tOverlap);
    assert.equal(noTeleport.surfaceId, 0);
    assert.equal(noTeleport.height, 0);
    assert.equal(noTeleport.fallback, true);

    // Seed-based knownRoute from [tGround, 0] also never teleports onto disconnected terrace
    const seeded = reg.resolveLegacySurface(12, 10, { knownRoute: [tGround, 0] });
    assert.equal(seeded.tile, tOverlap);
    assert.equal(seeded.surfaceId, 0);
    assert.equal(seeded.fallback, true);

    // Unauthored tile resolves cleanly to implicit ground (id=0, H=0)
    const implicit = reg.resolveLegacySurface(5, 5);
    assert.equal(implicit.surfaceId, 0);
    assert.equal(implicit.height, 0);
    assert.equal(implicit.reason, 'implicit-ground');
});

// ------------------------------------------------------------------ 6. D5 landmark guard & E2 sculpted sites / pilot

test('strict D5 landmark guard permits 9 landmarks + Runic Tide-Terrace + Windmill and rejects cottages/sheds', () => {
    for (const id of ['command', 'taskboard', 'forge', 'mine', 'archive', 'tavern', 'portal', 'watchtower', 'harbor', 'quotaTerrace', 'quotaTerraceApron', 'quotaPillar', 'windmill']) {
        assert.equal(isSemanticLandmark(id), true, `expected ${id} allowed`);
        assert.doesNotThrow(() => assertSemanticLandmark(id));
    }
    assert.ok(ALLOWED_SEMANTIC_LANDMARKS.has('command'));
    assert.ok(ALLOWED_SEMANTIC_LANDMARKS.has('windmill'));
    assert.ok(ALLOWED_SEMANTIC_LANDMARKS.has('quotaTerrace'));
    assert.ok(ALLOWED_SEMANTIC_LANDMARKS.has('quotaPillar'));

    for (const bad of ['cottage', 'fisherCottage', 'shed', 'tool_shed', 'woodcutter_hut', 'peasant_house', 'decorative_dwelling', 'unknownHall']) {
        assert.equal(isSemanticLandmark(bad), false, `expected ${bad} rejected`);
        assert.throws(() => assertSemanticLandmark(bad), /D5 violation/i);

        const terrainWithBadFooting = makeBaseTerrain({
            footings: [
                {
                    landmark: bad,
                    support: [820, 0],
                    poly: [[0, 0], [128, 0], [128, 64], [0, 64]],
                    courses16: [16],
                    material: 'stone',
                },
            ],
        });
        const check = validateTerrainDef(terrainWithBadFooting);
        assert.equal(check.ok, false);
        assert.ok(check.errors.some((e) => /D5 violation/i.test(e)));
        assert.throws(() => createSurfaceRegistry(terrainWithBadFooting), /D5 violation/i);
    }

    // Reject forbidden top-level cottage/shed collections too
    const sneaky = makeBaseTerrain({ cottages: [{ id: 'north-cottage' }] });
    assert.throws(() => createSurfaceRegistry(sneaky), /D5 violation/i);
});

test('E2_SCULPTED_SITES elevation table, face-value ladder, and createE2PilotTerrain preset', () => {
    assert.equal(E2_SCULPTED_SITES.commandKeepRise.elevationPx, 8);
    assert.equal(E2_SCULPTED_SITES.windmillKnoll.elevationPx, 8);
    assert.equal(E2_SCULPTED_SITES.lighthouseHeadland.elevationPx, 8);
    assert.equal(E2_SCULPTED_SITES.archiveTerrace.elevationPx, 16);
    assert.equal(E2_SCULPTED_SITES.westSeaCliffs.elevationPx, 24);
    assert.equal(E2_SCULPTED_SITES.westSeaCliffs.walkable, false);

    // Triangle Strategy face-value ladder: top k, sun k-1, shade k-2, joint k-3 (clamped)
    assert.equal(faceStopIndex(7, 'top', 9), 7);
    assert.equal(faceStopIndex(7, 'sun', 9), 6);
    assert.equal(faceStopIndex(7, 'shade', 9), 5);
    assert.equal(faceStopIndex(7, 'joint', 9), 4);
    assert.equal(faceStopIndex(1, 'joint', 9), 0);

    // Pilot preset compiles cleanly and satisfies every E2 invariant
    const pilot = createE2PilotTerrain();
    const reg = createSurfaceRegistry(pilot);
    assert.equal(reg.pools.length, 2);
    assert.equal(reg.spills.length, 1);
    assert.equal(reg.links.length, 4);
    assert.equal(reg.heightAt(9, 10, 0), 0);
    assert.equal(reg.heightAt(10, 10, 3, 0, 0.5), 0);
    assert.equal(reg.heightAt(10, 10, 3, 0.5, 0.5), 4);
    assert.equal(reg.heightAt(10, 10, 3, 1, 0.5), 8);
    assert.equal(reg.heightAt(11, 10, 2), 8);
    assert.equal(reg.heightAt(9, 11, 0), 0);
    assert.equal(reg.heightAt(9, 11, 2), 8);
    assert.equal(reg.getPool(2).height - reg.getPool(1).height, 8);
});

// ------------------------------------------------------------------ 7. Sprite bakers, PNG dimensions, alpha & ART_RAMPS purity

const ART_RAMP_HEX_SET = new Set(
    Object.values(ART_RAMPS).flat().map((hex) => hex.toLowerCase()),
);

function inspectPng(filename) {
    const abs = join(propsDir, filename);
    const png = PNG.sync.read(readFileSync(abs));
    const colors = new Set();
    let opaqueCount = 0;
    let semiAlphaCount = 0;
    let tierACount = 0;

    const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };

    for (let i = 0; i < png.data.length; i += 4) {
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        const a = png.data[i + 3];
        if (a === 0) continue;
        if (a < 255) semiAlphaCount++;
        opaqueCount++;
        const hx = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        colors.add(hx);
        const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
        const mx = Math.max(r, g, b) / 255;
        const mn = Math.min(r, g, b) / 255;
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (lum > 0.70 || (sat > 0.65 && mx >= 0.50)) tierACount++;
    }

    return { png, colors, opaqueCount, semiAlphaCount, tierAShare: tierACount / Math.max(1, opaqueCount) };
}

test('bake-lagoon-spillway.mjs --check passes and PNG obeys 256x96, 4 distinct frames, zero semi-alpha & strict ART_RAMPS', () => {
    const helpOut = execFileSync(process.execPath, [join(repoRoot, 'scripts/sprites/bake-lagoon-spillway.mjs'), '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /--check/);

    const checkOut = execFileSync(process.execPath, [join(repoRoot, 'scripts/sprites/bake-lagoon-spillway.mjs'), '--check'], { encoding: 'utf8' });
    assert.match(checkOut, /ok: prop\.lagoonSpillway\.png/);

    const info = inspectPng('prop.lagoonSpillway.png');
    assert.equal(info.png.width, 256);
    assert.equal(info.png.height, 96);
    assert.ok(info.opaqueCount > 2000);
    assert.equal(info.semiAlphaCount, 0, 'spillway must have zero semi-alpha pixels');
    assert.ok(info.colors.size <= 32, `expected <= 32 colors, got ${info.colors.size}`);
    assert.ok(info.tierAShare < 0.05, `expected Tier-A share < 5%, got ${(info.tierAShare * 100).toFixed(2)}%`);

    for (const hx of info.colors) {
        assert.ok(ART_RAMP_HEX_SET.has(hx), `spillway color ${hx} must be strictly in ART_RAMPS`);
    }

    // Verify all 4 64x96 frames are distinct animation phases
    const frameHashes = new Set();
    for (let f = 0; f < 4; f++) {
        const bytes = [];
        for (let y = 0; y < 96; y++) {
            const start = (y * 256 + f * 64) * 4;
            bytes.push(Buffer.from(info.png.data.subarray(start, start + 64 * 4)));
        }
        frameHashes.add(Buffer.concat(bytes).toString('base64'));
    }
    assert.equal(frameHashes.size, 4, 'all 4 waterfall frames must be distinct');
});

test('bake-terrace-kit.mjs --check passes and all 6 PNGs obey dims, zero semi-alpha, <=24 colors & strict ART_RAMPS', () => {
    const helpOut = execFileSync(process.execPath, [join(repoRoot, 'scripts/sprites/bake-terrace-kit.mjs'), '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /--check/);

    const checkOut = execFileSync(process.execPath, [join(repoRoot, 'scripts/sprites/bake-terrace-kit.mjs'), '--check'], { encoding: 'utf8' });
    assert.match(checkOut, /ok: prop\.terraceStair\.ne\.png/);
    assert.match(checkOut, /ok: prop\.terraceCorner\.outer\.png/);

    const allowedTerraceHex = new Set([...ART_RAMP_HEX_SET, '#060402']);
    const specs = [
        ['prop.terraceStair.ne.png', 64, 48],
        ['prop.terraceStair.nw.png', 64, 48],
        ['prop.terraceStair.se.png', 64, 48],
        ['prop.terraceStair.sw.png', 64, 48],
        ['prop.terraceCorner.inner.png', 32, 32],
        ['prop.terraceCorner.outer.png', 32, 32],
    ];

    const seenBuffers = new Set();
    for (const [name, w, h] of specs) {
        const info = inspectPng(name);
        assert.equal(info.png.width, w, `${name} width`);
        assert.equal(info.png.height, h, `${name} height`);
        assert.ok(info.opaqueCount > 200, `${name} non-empty`);
        assert.equal(info.semiAlphaCount, 0, `${name} must have zero semi-alpha pixels`);
        assert.ok(info.colors.size <= 24, `${name}: expected <= 24 colors, got ${info.colors.size}`);
        assert.equal(info.tierAShare, 0, `${name}: expected 0% Tier-A`);
        for (const hx of info.colors) {
            assert.ok(allowedTerraceHex.has(hx), `${name}: color ${hx} must be in ART_RAMPS or #060402 outline`);
        }
        assert.ok(info.colors.has('#060402'), `${name}: must include #060402 selective outline`);
        seenBuffers.add(Buffer.from(info.png.data).toString('base64'));
    }

    // All 4 stair directions + 2 corner variants are geometrically distinct
    assert.equal(seenBuffers.size, 6, 'all 6 terrace kit PNGs must be distinct');
});
