import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { makeTempDir } from './support/tmp.mjs';
import {
    DEFAULT_BUDGET_PATH,
    GROUND_SATURATION_BY_SEASON,
    evaluateGate,
    loadArtBudget,
    measureGrainDensity,
    measureWangEdgeContinuity,
    updateBudgetMonotonic,
    validateSurfaceSidecar,
} from '../sprites/art-analyze.mjs';
import {
    REGION_CLASS,
    SHADER_TAG,
    bucketAttributionDiffs,
    buildAttributionGlslSources,
    buildAttributionWgslSource,
    classifyRecordRegion,
    decodeAttributionBuffer,
    decodeAttributionWord,
    encodeAttributionWord,
    packRgba8Attribution,
    unpackRgba8Attribution,
} from '../visual/attribution.mjs';
import {
    GREEN_SWATCH_RGB,
    analyzeFrameReadback,
    evaluateCaptureFenceState,
} from '../visual/capture.mjs';
import {
    JND_DELTA_E,
    comparePngBuffers,
    evaluateVerdict,
    oklabDeltaEJnd,
    runVisualGate,
} from '../visual/compare.mjs';
import {
    generateVisualBoard,
    scaleNearestPng,
} from '../visual/board.mjs';
import { summarizeParityAttribution } from '../smoke/webgpu-parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makePng(width, height, fillFn) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a = 255] = fillFn(x, y);
            const i = (y * width + x) * 4;
            png.data[i] = r;
            png.data[i + 1] = g;
            png.data[i + 2] = b;
            png.data[i + 3] = a;
        }
    }
    return png;
}

// ---------------------------------------------------------------------------
// 1. Medium Contract doc & docs/README.md registration
// ---------------------------------------------------------------------------

test('docs/medium-contract.md contains all 9 rules, irregularity note, and art:gate checks', () => {
    const contractPath = path.join(ROOT, 'docs', 'medium-contract.md');
    assert.equal(existsSync(contractPath), true);
    const body = readFileSync(contractPath, 'utf8');
    for (const heading of [
        '1. **One grid.** ★',
        '2. **Stepped colour.** ★',
        '3. **The brightest-thing rule.** ★',
        '4. **Ink.**',
        '5. **Mass.**',
        '6. **Units, not noise.** ★',
        '7. **Ground contact.**',
        '8. **Water contact.** ★',
        '9. **Light by face, time by palette.**',
    ]) {
        assert.ok(body.includes(heading), `missing rule heading: ${heading}`);
    }
    assert.ok(body.includes('A metronome is a defect.'));
    assert.ok(body.includes('`art:gate` checks for the ★ rules:'));

    const docsIndex = readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
    assert.ok(docsIndex.includes('docs/medium-contract.md'), 'docs/README.md should register docs/medium-contract.md');
});

// ---------------------------------------------------------------------------
// 2. Ratcheted art:gate & art-budget.json
// ---------------------------------------------------------------------------

test('art-budget.json locks X-7 seasonal saturation bands and passes art:gate on baseline', () => {
    const budget = loadArtBudget(DEFAULT_BUDGET_PATH);
    assert.equal(budget.schemaVersion, 1);
    assert.deepEqual(budget.groundSaturationBySeason, {
        spring: [0.48, 0.56],
        summer: [0.45, 0.50],
        autumn: [0.40, 0.50],
        winter: [0.22, 0.36],
    });
    assert.deepEqual(GROUND_SATURATION_BY_SEASON.spring, { min: 0.48, max: 0.56 });
    assert.deepEqual(GROUND_SATURATION_BY_SEASON.summer, { min: 0.45, max: 0.50 });
    assert.deepEqual(GROUND_SATURATION_BY_SEASON.autumn, { min: 0.40, max: 0.50 });
    assert.deepEqual(GROUND_SATURATION_BY_SEASON.winter, { min: 0.22, max: 0.36 });
    assert.deepEqual(budget.globalRules.mediumContractGrainRatioBand, [0.70, 1.30]);

    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sprites', 'art-analyze.mjs'), '--gate'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `expected art:gate exit 0, got ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stdout, /\[art:gate\] PASS/);
});

test('art:gate fails on synthetic over-budget asset and CLI fails when budget cap is regressed', () => {
    const budget = loadArtBudget(DEFAULT_BUDGET_PATH);

    // Pure evaluateGate check: new un-allowlisted prop violating colours, semiAlpha, tierA, and grainRatio
    const syntheticAsset = {
        id: 'prop.syntheticBadNewAsset',
        class: 'props',
        files: ['props/prop.syntheticBadNewAsset.png'],
        visiblePixels: 1000,
        colours: 120,          // cap is 48 for new props
        semiAlpha: 0.05,       // cap is 0.002
        saturation: 0.4,
        tierA: 0.25,           // cap is 0.05
        tierAExempt: 0,
        offRamp: null,
        edgeContinuity: null,
        grainDensity: 1500,
        grainRatio: 1.9,       // band is [0.70, 1.30]
        surfaceIssues: [],
        terrain: null,
        scaleIssues: [],
        missing: [],
        errors: [],
        flags: ['semi-alpha', 'tier-a'],
    };
    const gate = evaluateGate([syntheticAsset], { seasonalRamps: [], canopyRemaps: [] }, budget);
    assert.equal(gate.pass, false);
    const rulesHit = new Set(gate.violations.map((v) => v.rule));
    assert.ok(rulesHit.has('maxColours'));
    assert.ok(rulesHit.has('maxSemiAlpha'));
    assert.ok(rulesHit.has('maxTierA'));
    assert.ok(rulesHit.has('grainRatio'));

    // Real CLI invocation against a tightened temp budget where agent.claude.opus exceeds its cap
    const tmpDir = makeTempDir('cv-w0d-budget-');
    try {
        const tightBudget = JSON.parse(JSON.stringify(budget));
        tightBudget.legacyAllowlist['agent.claude.opus'].maxColours = 100;
        const tightPath = path.join(tmpDir, 'tight-budget.json');
        writeFileSync(tightPath, JSON.stringify(tightBudget, null, 2));

        const run = spawnSync(
            process.execPath,
            [path.join(ROOT, 'scripts', 'sprites', 'art-analyze.mjs'), '--gate', '--ids=agent.claude.opus', `--budget=${tightPath}`],
            { cwd: ROOT, encoding: 'utf8' },
        );
        assert.equal(run.status, 1, 'CLI --gate must exit 1 on cap regression');
        assert.match(run.stderr, /agent\.claude\.opus \[maxColours\]/);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('updateBudgetMonotonic tightens cleanly and refuses loosening unless allowLoosen is set', () => {
    const baseBudget = {
        schemaVersion: 1,
        globalRules: {
            maxColoursNewAsset: { characters: 64, props: 48 },
            maxSemiAlphaOutsideAtmosphere: 0.002,
            maxTierAOutsideExempt: 0.05,
            terrainMinOnRampShare: 0.97,
            terrainMinEdgeContinuity: 0.99,
            mediumContractGrainRatioBand: [0.70, 1.30],
        },
        groundSaturationBySeason: { spring: [0.48, 0.56], summer: [0.45, 0.50], autumn: [0.40, 0.50], winter: [0.22, 0.36] },
        legacyAllowlist: {
            'agent.test': { maxColours: 300, maxTierA: 0.15, reason: 'legacy' },
        },
    };

    const improved = [{
        id: 'agent.test',
        class: 'characters',
        colours: 200,
        semiAlpha: 0,
        tierA: 0.02, // now under global 0.05 -> maxTierA should be removed!
        offRamp: null,
        edgeContinuity: null,
        grainRatio: null,
        terrain: null,
    }];
    const tight = updateBudgetMonotonic(baseBudget, improved, {});
    assert.equal(tight.budget.legacyAllowlist['agent.test'].maxColours, 200);
    assert.equal(tight.budget.legacyAllowlist['agent.test'].maxTierA, undefined);
    assert.equal(tight.tightened.length, 2);

    const regressed = [{
        ...improved[0],
        colours: 350, // > 300 cap
    }];
    assert.throws(
        () => updateBudgetMonotonic(baseBudget, regressed, {}, { allowLoosen: false }),
        /Refusing to loosen art-budget\.json/,
    );
    const allowed = updateBudgetMonotonic(baseBudget, regressed, {}, { allowLoosen: true });
    assert.equal(allowed.budget.legacyAllowlist['agent.test'].maxColours, 350);
});

test('measureGrainDensity, measureWangEdgeContinuity, and validateSurfaceSidecar work on synthetic PNGs', () => {
    const flat = makePng(32, 32, () => [100, 100, 100, 255]);
    const blocks = makePng(32, 32, (x, y) => (((x >> 1) + (y >> 1)) % 2 === 0 ? [20, 20, 20, 255] : [220, 220, 220, 255]));
    const flatGrain = measureGrainDensity(flat);
    const blockGrain = measureGrainDensity(blocks);
    assert.equal(flatGrain.densityPer32x32, 0);
    assert.ok(blockGrain.densityPer32x32 > 500);

    const smoothWang = makePng(64, 64, () => [90, 120, 70, 255]);
    const wangGood = measureWangEdgeContinuity(smoothWang, 0.03);
    assert.equal(wangGood.continuity, 1);

    const brokenWang = makePng(64, 64, (x) => (x % 16 === 0 ? [250, 20, 20, 255] : [90, 120, 70, 255]));
    const wangBad = measureWangEdgeContinuity(brokenWang, 0.03);
    assert.ok(wangBad.continuity < 0.99);

    const albedo = makePng(8, 8, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [120, 110, 100, 255] : [0, 0, 0, 0]));
    const goodSurface = makePng(8, 8, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [16, 0, 32, 0x80] : [0, 0, 0, 0]));
    assert.deepEqual(validateSurfaceSidecar(albedo, goodSurface), []);

    const badSurface = makePng(8, 8, () => [16, 0, 99, 0x80]); // height outside alpha + normal > 63
    const issues = validateSurfaceSidecar(albedo, badSurface);
    assert.equal(issues.length, 2);
});

// ---------------------------------------------------------------------------
// 3. Attribution 32-bit pack/unpack round-trip & diff bucketing
// ---------------------------------------------------------------------------

test('attribution.mjs 32-bit word & RGBA8 pack/unpack round-trips across all regions, tags, layers, and recordIndex', () => {
    const recordIndices = [-1, 0, 1, 7, 1024, 65534];
    const layerBytes = [0, 1, 7, 127, 255];
    const rgbaScratch = new Uint8Array(4);

    for (const recordIndex of recordIndices) {
        for (const regionClass of Object.values(REGION_CLASS)) {
            for (let shaderTag = 0; shaderTag <= 15; shaderTag++) {
                for (const layerByte of layerBytes) {
                    const word = encodeAttributionWord({ recordIndex, regionClass, shaderTag, layerByte });
                    const decoded = decodeAttributionWord(word);
                    assert.equal(decoded.recordIndex, recordIndex);
                    assert.equal(decoded.recordSlot, recordIndex + 1);
                    assert.equal(decoded.regionClass, regionClass);
                    assert.equal(decoded.shaderTag, shaderTag);
                    assert.equal(decoded.layerByte, layerByte);

                    packRgba8Attribution(word, rgbaScratch, 0);
                    const unpacked = unpackRgba8Attribution(rgbaScratch, 0);
                    assert.equal(unpacked, word);
                }
            }
        }
    }

    assert.throws(() => encodeAttributionWord({ recordIndex: 65535 }), RangeError);
    assert.throws(() => encodeAttributionWord({ regionClass: 16 }), RangeError);
    assert.throws(() => encodeAttributionWord({ shaderTag: 16 }), RangeError);
    assert.throws(() => encodeAttributionWord({ layerByte: 256 }), RangeError);

    // Shader helpers & record classifier
    assert.equal(classifyRecordRegion({ id: 'agent:abc:body', layer: 2 }).regionClass, REGION_CLASS.agentBody);
    assert.equal(classifyRecordRegion({ id: 'agent:abc:weaponFront', layer: 5 }).regionClass, REGION_CLASS.agentAttachment);
    assert.equal(classifyRecordRegion({ id: 'building:forge', layer: 1 }).regionClass, REGION_CLASS.buildingWall);
    assert.equal(classifyRecordRegion({ id: 'terrain:0', flags: 2 }).regionClass, REGION_CLASS.reflection);

    const wgsl = buildAttributionWgslSource();
    assert.ok(wgsl.includes('fn vsAttribution') && wgsl.includes('fn fsAttribution') && wgsl.includes('vec4<u32>'));
    const glsl = buildAttributionGlslSources();
    assert.ok(glsl.vertex.includes('#version 300 es') && glsl.fragment.includes('o_attrRgba'));
});

test('attribution.mjs and webgpu-parity.mjs bucket explained vs unclassified >1 LSB pixels accurately', () => {
    const w = 4;
    const h = 4;
    const count = w * h;
    const pixelD = new Uint8Array(count);
    const words = new Uint32Array(count);
    const rimMask = new Uint8Array(count);

    // Pixel 0: openSea cloudCourseEdge with d = 3 -> explained
    pixelD[0] = 3;
    words[0] = encodeAttributionWord({ recordIndex: -1, regionClass: REGION_CLASS.openSea, shaderTag: SHADER_TAG.cloudCourseEdge });
    // Pixel 1: paintedWater waterRipple with d = 2 -> explained
    pixelD[1] = 2;
    words[1] = encodeAttributionWord({ recordIndex: 0, regionClass: REGION_CLASS.paintedWater, shaderTag: SHADER_TAG.waterRipple });
    // Pixel 2: agentBody with rimMask = 1 and d = 4 -> rimOver1
    pixelD[2] = 4;
    rimMask[2] = 1;
    words[2] = encodeAttributionWord({ recordIndex: 1, regionClass: REGION_CLASS.agentBody, shaderTag: 0, layerByte: 2 });
    // Pixel 3: buildingWall with NO shaderTag and d = 5 -> unclassified!
    pixelD[3] = 5;
    words[3] = encodeAttributionWord({ recordIndex: 2, regionClass: REGION_CLASS.buildingWall, shaderTag: 0 });

    const records = [{ id: 'terrain:0' }, { id: 'agent:sonnet:body' }, { id: 'building:forge' }];

    // Verify rgba8 decoding matches r32uint
    const rgba8 = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) packRgba8Attribution(words[i], rgba8, i * 4);
    assert.deepEqual(decodeAttributionBuffer(rgba8, w, h, 'rgba8'), words);

    const bucketed = bucketAttributionDiffs({ pixelD, attribution: rgba8, attributionFormat: 'rgba8', records, rimMask, width: w, height: h });
    assert.equal(bucketed.over1Total, 4);
    assert.equal(bucketed.rimOver1, 1);
    assert.equal(bucketed.explainedNonRimOver1, 2);
    assert.equal(bucketed.unclassifiedNonRimOver1, 1);
    assert.equal(bucketed.byTag['openSea:cloudCourseEdge'], 1);
    assert.equal(bucketed.byTag['paintedWater:waterRipple'], 1);
    assert.equal(bucketed.byTag['buildingWall:unclassified'], 1);

    const paritySummary = summarizeParityAttribution({
        pixelD,
        attribution: words,
        attributionFormat: 'r32uint',
        records,
        rimMask,
        width: w,
        height: h,
        shareLe1: 0.99995,
        strict: true,
    });
    assert.equal(paritySummary.classifiedNonRimOver1, 2);
    assert.equal(paritySummary.unclassifiedNonRimOver1, 1);
    assert.equal(paritySummary.strictPass, true);
});

// ---------------------------------------------------------------------------
// 4. Astra's green first-frame guard & strict capture fence
// ---------------------------------------------------------------------------

test('capture.mjs catches #416139 green first frames and enforces all capture fence predicates', () => {
    const greenPng = makePng(64, 64, () => [...GREEN_SWATCH_RGB, 255]);
    const greenCheck = analyzeFrameReadback(greenPng.data, 64, 64);
    assert.equal(greenCheck.ok, false);
    assert.match(greenCheck.reason, /#416139/);
    assert.equal(greenCheck.greenFillShare, 1);

    const monoPng = makePng(64, 64, () => [12, 20, 30, 255]);
    const monoCheck = analyzeFrameReadback(monoPng.data, 64, 64);
    assert.equal(monoCheck.ok, false);
    assert.match(monoCheck.reason, /degenerate frame/);

    const richPng = makePng(64, 64, (x, y) => [(x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255, 255]);
    const richCheck = analyzeFrameReadback(richPng.data, 64, 64);
    assert.equal(richCheck.ok, true);
    assert.ok(richCheck.distinctInteriorColors >= 4);

    const readyState = {
        worldReadyAttr: true,
        worldStackOpacity: 1,
        firstFrameReason: null,
        revealSnapshotPending: false,
        season: 'summer',
        terrainKey: 'v3:summer:clear',
        presentGeneration: 5,
        fallbackFrameCount: 5,
    };
    assert.equal(evaluateCaptureFenceState(readyState, { expectedSeason: 'summer', minPresentGeneration: 4 }).ready, true);
    assert.equal(evaluateCaptureFenceState({ ...readyState, worldStackOpacity: 0 }, { minPresentGeneration: 4 }).ready, false);
    assert.equal(evaluateCaptureFenceState({ ...readyState, firstFrameReason: 'boot' }, { minPresentGeneration: 4 }).ready, false);
    assert.equal(evaluateCaptureFenceState({ ...readyState, revealSnapshotPending: true }, { minPresentGeneration: 4 }).ready, false);
    assert.equal(evaluateCaptureFenceState({ ...readyState, season: 'winter' }, { expectedSeason: 'summer', minPresentGeneration: 4 }).ready, false);
    assert.equal(evaluateCaptureFenceState({ ...readyState, terrainKey: '' }, { minPresentGeneration: 4 }).ready, false);
    assert.equal(evaluateCaptureFenceState({ ...readyState, presentGeneration: 4 }, { minPresentGeneration: 4 }).ready, false);
    // Fallback frame-count support before Integrator wires presentGeneration
    assert.equal(
        evaluateCaptureFenceState({ ...readyState, presentGeneration: null, fallbackFrameCount: 6 }, { minPresentGeneration: 5 }).ready,
        true,
    );
});

// ---------------------------------------------------------------------------
// 5. compare.mjs pure-Node OKLab ΔE, SSIM, attribution regions & CI --gate
// ---------------------------------------------------------------------------

test('compare.mjs computes OKLab ΔE, SSIM, regional verdicts, and telemetry/structural gates', () => {
    const base = makePng(32, 32, (x, y) => [60 + x * 2, 90 + y * 2, 70, 255]);
    const same = makePng(32, 32, (x, y) => [60 + x * 2, 90 + y * 2, 70, 255]);
    const shifted = makePng(32, 32, (x, y) => (
        x < 16
            ? [60 + x * 2, 90 + y * 2, 70, 255]
            : [220, 40, 180, 255]
    ));

    // Attribution: left half = landGround, right half = agentBody
    const attr = new Uint32Array(32 * 32);
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            attr[y * 32 + x] = encodeAttributionWord({
                recordIndex: x < 16 ? 0 : 1,
                regionClass: x < 16 ? REGION_CLASS.landGround : REGION_CLASS.agentBody,
            });
        }
    }

    assert.equal(oklabDeltaEJnd(100, 120, 80, 100, 120, 80), 0);
    assert.ok(oklabDeltaEJnd(60, 90, 70, 220, 40, 180) > JND_DELTA_E * 10);

    const cmpPass = comparePngBuffers(base, same, { attribution: attr, attributionFormat: 'r32uint' });
    assert.equal(cmpPass.weightedSsim, 1);
    assert.equal(cmpPass.perceptualByRegion.landGround.p999DeltaE, 0);
    assert.equal(cmpPass.perceptualByRegion.agentBody.p999DeltaE, 0);
    const vPass = evaluateVerdict({
        caseId: 'synthetic-pass',
        perceptualByRegion: cmpPass.perceptualByRegion,
        parityAttribution: cmpPass.parityAttribution,
        structural: { labelCollisionPairs: 0, bodyOverlapPairs: 0 },
        telemetryBudgets: { derivedCpuBytes: 8_000_000, pathLookupAvgMs: 0.04 },
    });
    assert.equal(vPass.verdict, 'pass');

    const cmpFail = comparePngBuffers(base, shifted, { attribution: attr, attributionFormat: 'r32uint' });
    assert.equal(cmpFail.perceptualByRegion.landGround.p999DeltaE, 0);
    assert.ok(cmpFail.perceptualByRegion.agentBody.p999DeltaE > 3.0);
    assert.equal(cmpFail.perceptualByRegion.agentBody.shareOverJnd, 1);
    assert.equal(cmpFail.parityAttribution.unclassifiedNonRimOver1, 512);
    const vFail = evaluateVerdict({
        caseId: 'synthetic-fail',
        perceptualByRegion: cmpFail.perceptualByRegion,
        parityAttribution: cmpFail.parityAttribution,
        structural: { labelCollisionPairs: 1, bodyOverlapPairs: 0 },
        telemetryBudgets: { derivedCpuBytes: 250_000_000, pathLookupAvgMs: 0.5 },
    });
    assert.equal(vFail.verdict, 'fail');
    assert.ok(vFail.failures.length >= 4);

    // CI --gate on empty golden dir passes cleanly via schema self-test
    const tmpDir = makeTempDir('cv-w0d-golden-');
    try {
        const emptyGate = runVisualGate({ goldenDir: tmpDir });
        assert.equal(emptyGate.pass, true);
        assert.equal(emptyGate.mode, 'schema-self-test');

        // CLI invocation also exits 0 cleanly
        const cli = spawnSync(
            process.execPath,
            [path.join(ROOT, 'scripts', 'visual', 'compare.mjs'), '--gate', `--golden-dir=${tmpDir}`],
            { cwd: ROOT, encoding: 'utf8' },
        );
        assert.equal(cli.status, 0, cli.stderr);

        // Add one valid golden case and verify golden-verify mode passes
        const caseDir = path.join(tmpDir, 'readme-noon');
        mkdirSync(caseDir, { recursive: true });
        writeFileSync(path.join(caseDir, 'composite.png'), PNG.sync.write(base));
        writeFileSync(path.join(caseDir, 'meta.json'), JSON.stringify({
            schemaVersion: 1,
            caseId: 'readme-noon',
            backend: 'webgpu',
            adapter: { vendor: 'nvidia', architecture: 'blackwell', fallback: false },
            determinism: { selfStableBytes: true, ladderLevel: 0, nondeterministicMasks: [] },
            structural: { labelCollisionPairs: 0, bodyOverlapPairs: 0 },
        }));
        const goldenGate = runVisualGate({ goldenDir: tmpDir });
        assert.equal(goldenGate.pass, true);
        assert.equal(goldenGate.mode, 'golden-verify');
        assert.equal(goldenGate.goldenCases, 1);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// 6. board.mjs nearest-neighbor 1x/2x/3x PNG + HTML generation
// ---------------------------------------------------------------------------

test('board.mjs generates valid 1x/2x/3x nearest-neighbor PNGs, heatmap, and self-contained HTML', () => {
    const tmpDir = makeTempDir('cv-w0d-board-');
    try {
        const base = makePng(16, 12, (x, y) => [50 + x * 4, 80 + y * 5, 90, 255]);
        const head = makePng(16, 12, (x, y) => (
            x === 5 && y === 4 ? [240, 60, 200, 255] : [50 + x * 4, 80 + y * 5, 90, 255]
        ));

        // Verify nearest-neighbor upscale exact pixel preservation
        const scaled2 = scaleNearestPng(base, 2);
        assert.equal(scaled2.width, 32);
        assert.equal(scaled2.height, 24);
        assert.equal(scaled2.data[(0 * 32 + 0) * 4], base.data[0]);
        assert.equal(scaled2.data[(1 * 32 + 1) * 4], base.data[0]);

        const out = generateVisualBoard({
            name: 'unit-test-board',
            basePng: base,
            headPng: head,
            outDir: tmpDir,
            rois: [{ label: 'diff-spot', x: 4, y: 3, w: 4, h: 4 }],
            scales: [1, 2, 3],
        });

        assert.equal(out.heatmapStats.overJndPixels, 1);
        assert.equal(existsSync(out.files.html), true);
        assert.equal(existsSync(out.files.heatmap), true);
        assert.equal(existsSync(out.files.verdict), true);

        const html = readFileSync(out.files.html, 'utf8');
        assert.ok(html.includes('image-rendering: pixelated'));
        assert.ok(html.includes('diff-spot'));
        assert.ok(html.includes('board-1x.png'));

        for (const scale of [1, 2, 3]) {
            const boardFile = out.files.boards[`${scale}x`];
            assert.equal(existsSync(boardFile), true);
            const parsed = PNG.sync.read(readFileSync(boardFile));
            assert.equal(parsed.width, 16 * scale * 3 + 4);
            assert.equal(parsed.height, 12 * scale);
        }
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
