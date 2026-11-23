import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    postcardCaption,
    postcardFileName,
    postcardFrame,
    withPostcardFrame,
} from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';

// XP-5 — Postcards are safe to share by construction. This file holds the
// static half of the proof: every 2D text call in the World's code is
// classified here with the lock that keeps it off a postcard, and the check
// fails on any text site that is not. The runtime half is
// `scripts/smoke/postcard.mjs` (0 text calls reach a postcard frame, no
// cached text is blitted, on WebGPU, WebGL2 and Canvas).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORLD = path.join(ROOT, 'claudeville/src/presentation/character-mode');
const read = file => fs.readFileSync(path.join(WORLD, file), 'utf8');

// `flag`: the function (default: the site's own) stands down on
// `postcardFrame()`. `tier`: WorldFrameRenderer skips the pass that reaches
// the site on a postcard frame (the gated call, verbatim). `screen`: the
// pass is in the screen tier, after the postcard frame's early return.
// `beacons`: T1 attention text, dropped by the postcard frame's
// beacons-only attention pass (the beacons stay, plates and tallies go).
// `helper`: a pass-through painter whose callers are classified. `debug`:
// developer overlays only. `caption`: the postcard's own caption band.
const SITES = {
    'AgentGpuOverlayRenderer.js drawDepartedTreatment': { flag: true, why: 'DEPARTED plaque' },
    'AgentSprite.js _drawThoughtHead': { tier: 'if (!postcard) drawThoughtLayer(', why: 'speech: the model\'s words, speaker tag' },
    'AgentSprite.js _drawThoughtHistory': { tier: 'if (!postcard) drawThoughtLayer(', why: 'speech history' },
    'AgentSprite.js _drawNamePlate': { flag: '_drawNameTag', why: 'T2 plate: villager name (a cached stamp, so gated before the blit)' },
    'AgentSprite.js _drawObservationSeal': { flag: true, why: 'last-observed age' },
    'AgentSprite.js _drawTurnSand': { flag: true, why: 'turn duration' },
    'AgentSprite.js drawFamiliarMotes': { flag: true, why: 'hidden familiar count' },
    'ArrivalDeparture.js drawChildMiniature': { flag: true, why: 'child count pill' },
    'AttentionPlates.js drawPlateText': { beacons: true, why: 'T1 plate: name, waiting reason' },
    'AttentionPlates.js drawTallyTab': { beacons: true, why: 'T1 tally' },
    'BuildingSprite.js _paintPlaque': { tier: 'if (!postcard) renderer.buildingRenderer?.drawLabels(', why: 'building plaques: patron names, counts, squads' },
    'BuildingSprite.js _drawInstrumentPlate': { flag: true, why: 'instrument plates: workloads, ritual labels, belfry and mine rows' },
    'BuildingSprite.js _drawAttentionBannerBoard': { flag: true, why: 'attention banner board' },
    'BuildingSprite.js _paintTaskboardChalk': { flag: '_drawTaskboardBoard', why: 'taskboard chalk: tasks and agents (a cached raster, so gated before the blit)' },
    'BuildingSprite.js _drawTaskboardPlanTabs': { flag: true, why: 'plan tabs: repo crests and counts' },
    'BuildingSprite.js _drawApertureLegend': { flag: true, why: 'aperture legend: session names and tools' },
    'BuildingSprite.js drawGroundingDebug': { debug: true, why: 'grounding debug (no caller in the frame)' },
    'ChronicleMonuments.js _drawBanner': { flag: true, why: 'Chronicle banner' },
    'CouncilRing.js drawGatherRollCall': { flag: true, why: 'team plate: team name and count' },
    'CrowdClusterOverlay.js drawCrowdClusterBadges': { tier: 'if (!postcard) drawCrowdClusterBadges(', why: 'crowd count badges' },
    'DebugOverlay.js draw': { debug: true, why: 'debug overlay' },
    'DebugOverlay.js drawScreen': { debug: true, why: 'debug overlay' },
    'DebugOverlay.js _drawAmbientBlock': { debug: true, why: 'debug overlay' },
    'EffectStamps.js drawMomentEdgePlates': { screen: 'drawMomentEdgePlates(overlayCtx', why: 'docked moment plates' },
    'HarborTraffic.js _fillReadableText': { helper: true, why: 'harbor text painter: callers below' },
    'HarborTraffic.js _drawShipTierBadge': { flag: true, why: 'ship tier badge' },
    'HarborTraffic.js _drawRepoShield': { flag: true, why: 'repo shield label' },
    'HarborTraffic.js _drawCommitPennant': { flag: true, why: 'commit plate: repo, branch, SHA' },
    'HarborTraffic.js _drawFinaleEffect': { flag: true, why: 'finale caption' },
    'IsometricRenderer.js _drawAtmosphereDebug': { screen: 'drawDebugOverlay(renderer, overlayCtx', why: 'atmosphere debug' },
    'Postcard.js composePostcard': { caption: true, why: 'the caption band, drawn after the guard' },
    'SharedFileKnot.js drawPlate': { tier: 'if (!postcard) drawSharedFileOverlapLabel(', why: 'shared-file plates: file names, counts' },
    'VillageDirectorOverlay.js drawVillageDirectorScreen': { screen: 'drawVillageDirectorScreen(overlayCtx', why: 'director caption' },
    'VillageDirectorOverlay.js drawOffscreenCueEdges': { screen: 'drawOffscreenCueEdges(overlayCtx', why: 'offscreen cue edges' },
    'WorldFrameRenderer.js drawAmbientCaption': { screen: 'drawAmbientCaption(overlayCtx', why: 'ambient caption' },
    'WorldFrameRenderer.js paintBoundsContext': { helper: true, why: 'retained-ground wrapper: the postcard frame redraws that texture' },
    'WorldLabelKit.js paintOutlinedText': { helper: true, why: 'outlined text: only the T4 name calls it' },
};

const DEFINITION = /^(?:export )?(?:async )?function (\w+)|^    (?:static )?(?:async )?([_a-zA-Z]\w*)\s*\([^;]*\)\s*\{\s*$/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);

function definitionAt(line) {
    const match = DEFINITION.exec(line);
    const name = match && (match[1] || match[2]);
    return name && !KEYWORDS.has(name) ? name : null;
}

function enclosing(lines, index) {
    for (let i = index; i >= 0; i--) {
        const name = definitionAt(lines[i]);
        if (name) return name;
    }
    return null;
}

// The source of `name` in `file`: its definition line to the next definition.
function body(file, name) {
    const lines = read(file).split('\n');
    const start = lines.findIndex(line => definitionAt(line) === name);
    assert.ok(start >= 0, `${file} defines ${name}`);
    let end = start + 1;
    while (end < lines.length && !definitionAt(lines[end])) end++;
    return lines.slice(start, end).join('\n');
}

function textSites() {
    const sites = new Map();
    for (const file of fs.readdirSync(WORLD, { recursive: true }).filter(name => name.endsWith('.js'))) {
        const lines = read(file).split('\n');
        lines.forEach((line, index) => {
            if (!/\.(fillText|strokeText)\(/.test(line)) return;
            const key = `${file} ${enclosing(lines, index)}`;
            if (!sites.has(key)) sites.set(key, index + 1);
        });
    }
    return sites;
}

test('every World text site is classified with the lock that keeps it off a postcard', () => {
    const sites = textSites();
    const unclassified = [...sites.keys()].filter(key => !SITES[key]);
    assert.deepEqual(unclassified, [], 'classify each new text site in SITES (and give it a postcard lock)');
    const stale = Object.keys(SITES).filter(key => !sites.has(key));
    assert.deepEqual(stale, [], 'drop SITES entries whose text call is gone');
});

test('each flag-locked site stands down on postcardFrame()', () => {
    for (const [key, lock] of Object.entries(SITES)) {
        if (!lock.flag) continue;
        const [file, site] = key.split(' ');
        const owner = lock.flag === true ? site : lock.flag;
        assert.match(body(file, owner), /postcardFrame\(\)/, `${file} ${owner} (${lock.why})`);
    }
});

test('each tier-locked pass is skipped by the postcard frame, and the screen tier ends it', () => {
    const frame = body('WorldFrameRenderer.js', 'renderWorldFrame');
    const end = frame.indexOf('    if (postcard) {\n');
    assert.ok(end > 0, 'the postcard frame returns before the screen tier');
    const block = frame.slice(end, frame.indexOf('\n    }\n', end));
    assert.match(block, /return true;$/, 'the postcard block ends the frame');
    assert.deepEqual(block.match(/^        [a-zA-Z_.]+\(/gm), [
        '        drawAttentionPlates(',
        '        finishFrameTiming(',
    ], 'the postcard block draws only the beacons');
    for (const [key, lock] of Object.entries(SITES)) {
        if (lock.tier) assert.ok(frame.includes(lock.tier), `${key}: ${lock.tier}`);
        if (lock.screen) {
            const at = frame.indexOf(lock.screen);
            assert.ok(at > end, `${key}: ${lock.screen} draws after the postcard return`);
        }
    }
    // T1: beacons only, on the overlay and in the GPU's mark records; the
    // peak marks stand down.
    assert.ok(frame.includes('drawAttentionPlates(overlayCtx, renderer._attentionLayout, { inkOnly: gpuMarksDrawn, beaconsOnly: true });'));
    assert.match(frame, /attentionMarkRecords\(renderer\._attentionLayout, \{[^}]*beaconsOnly: postcard,/s);
    assert.match(frame, /const peakMarksArmed = !postcard && /);
    const plates = body('AttentionPlates.js', 'drawAttentionPlates');
    assert.ok(plates.indexOf('if (beaconsOnly) {') > 0 && plates.indexOf('if (beaconsOnly) {') < plates.indexOf('drawPlateText('), 'beacons-only returns before plates and tallies');
    assert.match(plates, /if \(!beaconsOnly\) for \(const plate of layout\.plates\) leaderFills/);
    const records = body('AttentionPlates.js', 'attentionMarkRecords');
    assert.match(records, /if \(!beaconsOnly\) for \(const plate of layout\.plates\) leaderFills/);
    assert.match(records, /if \(!beaconsOnly\) for \(const plate of layout\.plates\) plateFills/);
});

test('helper painters are reached only from locked callers', () => {
    const harbor = read('HarborTraffic.js').split('\n');
    const callers = new Set();
    harbor.forEach((line, index) => {
        if (line.includes('this._fillReadableText(')) callers.add(enclosing(harbor, index));
    });
    assert.ok(callers.size > 0);
    for (const caller of callers) {
        if (caller === 'drawScreenSummary') {
            const frame = body('WorldFrameRenderer.js', 'renderWorldFrame');
            assert.ok(frame.indexOf('drawScreenSummary(') > frame.indexOf('    if (postcard) {'), 'harbor summary is screen tier');
            continue;
        }
        assert.match(body('HarborTraffic.js', caller), /postcardFrame\(\)/, `HarborTraffic ${caller}`);
    }
    const outlined = fs.readdirSync(WORLD, { recursive: true })
        .filter(file => file.endsWith('.js') && file !== 'WorldLabelKit.js' && read(file).includes('paintOutlinedText('));
    assert.deepEqual(outlined, ['AgentSprite.js'], 'only the T4 name paints outlined text');
    assert.match(body('AgentSprite.js', '_drawNameTag'), /postcardFrame\(\)/);
    // The retained ground texture redraws on a postcard frame, and after it.
    assert.match(body('WorldFrameRenderer.js', 'prepareSemanticGround'), /postcardFrame\(\),/);
});

test('withPostcardFrame raises the flag and drops and counts every 2D text call', () => {
    const calls = [];
    class FakeContext {
        fillText(text) { calls.push(text); }
        strokeText(text) { calls.push(text); }
    }
    const previous = globalThis.CanvasRenderingContext2D;
    globalThis.CanvasRenderingContext2D = FakeContext;
    try {
        const ctx = new FakeContext();
        const { result, textCalls, textSites } = withPostcardFrame(() => {
            assert.equal(postcardFrame(), true);
            ctx.fillText('repo/secret-project');
            ctx.strokeText('claude-opus');
            return 'drawn';
        }, { trace: true });
        assert.equal(result, 'drawn');
        assert.equal(textCalls, 2);
        assert.equal(textSites.length, 2);
        assert.deepEqual(calls, [], 'no text reached the context');
        assert.equal(postcardFrame(), false);
        ctx.fillText('after');
        assert.deepEqual(calls, ['after'], 'the context is restored');
        assert.throws(() => withPostcardFrame(() => { throw new Error('boom'); }), /boom/);
        assert.equal(postcardFrame(), false, 'a throwing frame still lowers the flag');
        ctx.fillText('again');
        assert.deepEqual(calls, ['after', 'again']);
    } finally {
        globalThis.CanvasRenderingContext2D = previous;
    }
});

test('the caption and file name read the village clock, not a person', () => {
    const date = new Date(2026, 10, 19, 15, 25);
    assert.equal(postcardCaption({ date, phase: 'dusk', villagers: 10 }), 'ClaudeVille · 19 Nov · 15:25 dusk · 10 villagers');
    assert.equal(postcardCaption({ date, phase: null, villagers: 1 }), 'ClaudeVille · 19 Nov · 15:25 · 1 villager');
    assert.equal(postcardCaption({ villagers: 0 }), 'ClaudeVille · 0 villagers');
    assert.equal(postcardFileName(date), 'claudeville-2026-11-19-1525.png');
});

// Cached text reaches a frame through drawImage, past the text guard: each
// sensitive raster is warmed on a live frame, then a postcard frame must not
// blit it.
function fakeContext() {
    return {
        font: '', textAlign: 'left', textBaseline: 'alphabetic', shadowColor: '', fillStyle: '',
        save() {}, restore() {}, translate() {}, scale() {}, setTransform() {}, fillRect() {}, fillText() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: text => ({ width: String(text).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    };
}

test('a postcard frame never blits a warmed name stamp (T2 plate or T4 name)', () => {
    const blits = [];
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        agent: { name: 'secret-project-agent', status: 'working' },
        _zoom: 2, _placeX: 10, _placeY: 20, overlaySlot: 0, labelAlpha: 1,
        isArrivalPending: () => false,
        identityLabelTopPx: () => 4,
        _drawOverlayStamp: (ctx, identity) => blits.push(String(identity).split('|')[0]),
    });
    const ctx = fakeContext();
    for (const selected of [true, false]) {
        sprite.selected = selected;
        blits.length = 0;
        sprite._drawNameTag(ctx);
        assert.deepEqual(blits, [selected ? 'plate' : 'name'], 'the live frame warms the stamp');
        blits.length = 0;
        withPostcardFrame(() => sprite._drawNameTag(ctx));
        assert.deepEqual(blits, [], 'the postcard frame blits no name stamp');
    }
});

// A canvas whose "pixels" are the text painted into it: clearRect over the
// whole canvas wipes it, drawImage copies the source's ink into the target.
class InkCanvas {
    constructor(width = 1, height = 1) {
        this.width = width;
        this.height = height;
        this.ink = [];
    }

    getContext() {
        const canvas = this;
        return Object.assign(fakeContext(), {
            fillText: text => canvas.ink.push(String(text)),
            clearRect: (x, y, w, h) => {
                if (x <= 0 && y <= 0 && x + w >= canvas.width && y + h >= canvas.height) canvas.ink = [];
            },
            drawImage: source => canvas.ink.push(...(source?.ink || [])),
            canvas,
        });
    }
}

test('a postcard frame never blits the warmed taskboard chalk (the pixels drawn, not the key)', () => {
    const previous = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = InkCanvas;
    try {
        const board = Object.assign(Object.create(BuildingSprite.prototype), {
            _zoom: 1,
            _taskboardBoard: () => ({ agent: { id: 'a' } }),
            _taskboardViewFor: () => ({ title: 'secret-repo · fix login', rows: [] }),
            // The chalk itself: the view's words into the real slate raster.
            _paintTaskboardChalk: (slateCtx, origin, view) => slateCtx.fillText(view.title, 0, 0),
        });
        const localPoint = () => ({ x: 0, y: 0 });
        const live = new InkCanvas(400, 300);
        board._drawTaskboardBoard(live.getContext('2d'), localPoint);
        assert.ok(live.ink.some(text => text.includes('secret-repo')), 'the live frame warms the slate raster with chalk and blits it');
        const postcard = new InkCanvas(400, 300);
        withPostcardFrame(() => board._drawTaskboardBoard(postcard.getContext('2d'), localPoint));
        assert.ok(board._taskboardSlateRaster?.canvas, 'the postcard frame blits the slate raster');
        assert.deepEqual(postcard.ink, [], 'the postcard blit carries no chalk');
        const after = new InkCanvas(400, 300);
        board._drawTaskboardBoard(after.getContext('2d'), localPoint);
        assert.ok(after.ink.some(text => text.includes('secret-repo')), 'the next live frame writes its chalk again');
    } finally {
        globalThis.OffscreenCanvas = previous;
    }
});
