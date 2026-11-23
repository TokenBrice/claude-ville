import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { BuildingSprite, READ_VERBS } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { MarkGovernor, MarkTier, setActiveMarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { Sidebar, sidebarListRowKey } from '../../claudeville/src/presentation/shared/Sidebar.js';
import { classifyTool } from '../../claudeville/src/domain/services/ToolIdentity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withStubDocument(fn) {
    const previous = globalThis.document;
    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({ fillStyle: '', fillRect() {} }),
        }),
    };
    try {
        return fn();
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
}

function fakeCanvasCtx() {
    const ops = [];
    return {
        ops,
        globalAlpha: 1,
        fillStyle: '',
        save() { ops.push(['save']); },
        restore() { ops.push(['restore']); },
        translate(x, y) { ops.push(['translate', x, y]); },
        scale(x, y) { ops.push(['scale', x, y]); },
        setTransform(...args) { ops.push(['setTransform', ...args]); },
        getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
        fillRect(...args) { ops.push(['fillRect', ...args]); },
        drawImage(...args) { ops.push(['drawImage', ...args]); },
    };
}

function makeSprite(overrides = {}) {
    return Object.assign(Object.create(AgentSprite.prototype), {
        agent: {
            id: 'worker-1',
            name: 'Wren',
            status: 'working',
            currentTool: 'Edit',
            currentToolInput: { file_path: 'src/app.js' },
            isDeparted: false,
        },
        _zoom: 1,
        _placeX: 100,
        _placeY: 200,
        moving: false,
        chatting: false,
        bubbleSlot: null,
        bubbleMergedInto: null,
        decisionFocusMuted: false,
        behavior: { planMode: false },
        isArrivalPending: () => false,
        ...overrides,
    });
}

// --- Item 1: Tool glyph at default zoom (1–2), GPU and Canvas ----------------

test('head tool glyph draws at zoom 1–2 for working villagers (including while walking) and respects guards', () => withStubDocument(() => {
    const governor = new MarkGovernor();
    setActiveMarkGovernor(governor);
    try {
        const ctx = fakeCanvasCtx();

        // Zoom 1 and 2 (walking and standing): draws above the head.
        for (const [zoom, moving] of [[1, false], [1, true], [1.5, true], [2, false]]) {
            governor.beginFrame();
            ctx.ops.length = 0;
            const sprite = makeSprite({ _zoom: zoom, moving });
            assert.equal(sprite._drawToolGlyphBadge(ctx, 140), true, `should draw at zoom ${zoom} moving=${moving}`);
            assert.ok(ctx.ops.some(op => op[0] === 'translate' && op[1] === 100 && op[2] === 140));
        }

        // Zoom > 2 does not draw the head badge.
        governor.beginFrame();
        assert.equal(makeSprite({ _zoom: 3 })._drawToolGlyphBadge(ctx, 140), false);

        // Thought owning the head, chatting, attention status, empty tool, non-working, departed, arrival-pending, postcard all skip.
        governor.beginFrame();
        assert.equal(makeSprite({ bubbleSlot: 0 })._drawToolGlyphBadge(ctx, 140), false, 'thought owns head');
        assert.equal(makeSprite({ chatting: true })._drawToolGlyphBadge(ctx, 140), false, 'chatting');
        assert.equal(makeSprite({ agent: { id: 'a', status: 'waiting_on_user', currentTool: 'Edit' } })._drawToolGlyphBadge(ctx, 140), false, 'attention');
        assert.equal(makeSprite({ agent: { id: 'a', status: 'working', currentTool: '' } })._drawToolGlyphBadge(ctx, 140), false, 'no currentTool');
        assert.equal(makeSprite({ agent: { id: 'a', status: 'idle', currentTool: 'Edit' } })._drawToolGlyphBadge(ctx, 140), false, 'non-working');
        assert.equal(makeSprite({ isArrivalPending: () => true })._drawToolGlyphBadge(ctx, 140), false, 'arrival pending');
        assert.equal(withPostcardFrame(() => makeSprite()._drawToolGlyphBadge(ctx, 140)).result, false, 'postcard');
    } finally {
        setActiveMarkGovernor(null);
    }
}));

test('head tool glyph yields to T1 plates reserved as PRIMARY in MarkGovernor', () => withStubDocument(() => {
    const governor = new MarkGovernor();
    setActiveMarkGovernor(governor);
    try {
        governor.beginFrame();
        // Reserve a T1 plate right over the glyph slot (100 - 5, 140 - 19, 10x10).
        governor.reserve({ x: 80, y: 110, w: 60, h: 30 }, MarkTier.PRIMARY, 'attention');
        const ctx = fakeCanvasCtx();
        assert.equal(makeSprite()._drawToolGlyphBadge(ctx, 140), false, 'yields to overlapping T1 plate');

        // A worker clear of the T1 plate still draws.
        assert.equal(makeSprite({ _placeX: 300 })._drawToolGlyphBadge(ctx, 140), true, 'draws when clear of T1 plate');
    } finally {
        setActiveMarkGovernor(null);
    }
}));

test('AgentGpuOverlayRenderer calls _drawToolGlyphBadge at zoom 1–2 and suppresses overlapping emote/plan glyphs', () => {
    const calls = [];
    const host = {
        agent: { id: 'w', status: 'working', currentTool: 'Edit', isDeparted: false },
        gpuWorldEnabled: true,
        selected: false,
        chatting: false,
        gpuActionOverlay: false,
        _behindBuilding: false,
        _gpuFrameRecord: { contentTopY: 40 },
        _labelTopY: y => y,
        _drawToolGlyphBadge: (_ctx, topY) => { calls.push(['tool-glyph', topY]); return true; },
        _drawStatusEmote: () => calls.push(['emote']),
        _drawPlanModeGlyph: () => calls.push(['plan']),
        _drawRetryGlyph: () => calls.push(['retry']),
        _drawNameTag: () => calls.push(['name']),
    };
    const renderer = new AgentGpuOverlayRenderer(host);
    // Even in compact mode (gpuActionOverlay false), the tool glyph draws on the GPU path.
    renderer.draw({}, 1, 'compact');
    assert.deepEqual(calls, [['tool-glyph', 40], ['name']]);

    // In full mode, when tool glyph draws, status emote and plan-mode glyph yield to it.
    calls.length = 0;
    renderer.draw({}, 2, 'full');
    assert.deepEqual(calls, [['tool-glyph', 40], ['retry'], ['name']]);

    // When tool glyph does not draw, emote and plan-mode glyph still run.
    calls.length = 0;
    host._drawToolGlyphBadge = () => false;
    renderer.draw({}, 2, 'full');
    assert.deepEqual(calls, [['emote'], ['plan'], ['retry'], ['name']]);
});

// --- Item 2: Sidebar active tool name & row key ------------------------------

function fakeSidebarRow() {
    const node = () => {
        const attrs = new Map();
        return {
            textContent: '',
            nodeValue: '',
            hidden: false,
            disabled: false,
            className: '',
            dataset: {},
            style: { setProperty() {} },
            getAttribute: name => attrs.get(name) ?? null,
            setAttribute: (name, value) => attrs.set(name, String(value)),
            removeAttribute: name => attrs.delete(name),
        };
    };
    return {
        className: '',
        style: { setProperty() {} },
        _sidebarRefs: {
            name: node(),
            nameText: node(),
            workflow: node(),
            modelText: node(),
            state: node(),
            age: node(),
            info: node(),
            match: node(),
            parent: node(),
            dot: node(),
            select: node(),
            avatar: { agent: null },
        },
    };
}

test('Sidebar includes currentTool in row key and shows active tool name for working rows', () => {
    const base = { id: 'a1', name: 'Rowan', status: 'working', model: 'claude-opus-4-6', provider: 'claude', currentTool: 'Edit' };
    assert.notEqual(
        sidebarListRowKey(base),
        sidebarListRowKey({ ...base, currentTool: 'Bash' }),
        'row key must change when currentTool changes',
    );

    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        selection: { isSelected: () => false },
        _toggleOptional() {},
        _syncBust() {},
    });
    const row = fakeSidebarRow();
    sidebar._patchAgentRow(row, base, { accent: '#4c9a4c' }, {}, null);
    assert.equal(row._sidebarRefs.state.textContent, 'Edit');
    assert.match(row._sidebarRefs.modelText.nodeValue, /Opus/);

    // MCP tool names shorten cleanly.
    sidebar._patchAgentRow(row, { ...base, currentTool: 'mcp__playwright__browser_click' }, { accent: '#4c9a4c' }, {}, null);
    assert.equal(row._sidebarRefs.state.textContent, 'pw:browser_click');

    // Working without currentTool falls back to 'working'.
    sidebar._patchAgentRow(row, { ...base, currentTool: null }, { accent: '#4c9a4c' }, {}, null);
    assert.equal(row._sidebarRefs.state.textContent, 'working');

    // Non-working agents keep their status word even if currentTool is stale.
    sidebar._patchAgentRow(row, { ...base, status: 'idle', currentTool: 'Edit' }, { accent: '#4c9a4c' }, {}, null);
    assert.equal(row._sidebarRefs.state.textContent, 'idle');
});

// --- Item 3: Code reads route to Archive -------------------------------------

test('all reading and searching tools on code files route to Archive while edits stay at Forge', () => {
    for (const [tool, input] of [
        ['Read', { file_path: 'claudeville/src/presentation/character-mode/AgentSprite.js' }],
        ['Read', { file_path: 'src/edit.js' }],
        ['Grep', { pattern: 'create', path: 'src/app.js' }],
        ['Glob', { pattern: '**/*.js' }],
        ['LS', { path: 'src' }],
        ['Bash', 'rg "ToolGlyphBadge" claudeville/src/'],
        ['Bash', 'cat claudeville/server.js'],
        ['read_custom_code', { path: 'src/main.ts' }],
    ]) {
        assert.equal(classifyTool(tool, input)?.building, 'archive', `${tool} ${JSON.stringify(input)}`);
    }
    assert.equal(classifyTool('Edit', { file_path: 'src/app.js' })?.building, 'forge');
    assert.equal(classifyTool('Write', { file_path: 'src/app.js' })?.building, 'forge');
});

// --- Item 4: READ mode verbs, hideCount, placedToolBuilding, arrivalPending --

test('READ_VERBS covers every classifier reason in ToolIdentity.js with no OTHER fallthrough', () => {
    const source = fs.readFileSync(path.join(ROOT, 'claudeville/src/domain/services/ToolIdentity.js'), 'utf8');
    const classifierSource = source.slice(0, source.indexOf('const TOOL_ACTION_CATEGORIES'));
    const reasons = new Set([
        ...[...classifierSource.matchAll(/reason:\s*['"]([a-z0-9-]+)['"]/g)].map(m => m[1]),
        'read-docs',
        'multi-tool',
    ]);
    // Extract TOOL_VERBS keys as well to guarantee 100% coverage.
    const toolVerbsBlock = source.slice(source.indexOf('const TOOL_VERBS = Object.freeze({'), source.indexOf('});', source.indexOf('const TOOL_VERBS = Object.freeze({')));
    for (const m of toolVerbsBlock.matchAll(/^\s*['"]?([a-z0-9-]+)['"]?\s*:/gm)) {
        reasons.add(m[1]);
    }
    const missing = [...reasons].filter(reason => !READ_VERBS[reason] || READ_VERBS[reason] === 'OTHER');
    assert.deepEqual(missing, [], `unmapped reasons would fall through to OTHER: ${missing.join(', ')}`);
});

test('READ mode buckets by placedToolBuilding, skips arrivalPending, and keeps building name with hideCount', () => {
    const building = Object.create(BuildingSprite.prototype);
    building._taskboardBoardModel = { updateAgentSprites() {} };
    building._labelTextFor = (b) => b.type.toUpperCase();

    const makeReadSprite = (id, { tool, input = '', building: fb = null, arrivalPending = false, status = 'working' } = {}) => ({
        agent: { id, status, currentTool: tool, currentToolInput: input, isDeparted: false, targetBuildingType: fb },
        _lastBuildingType: fb,
        behavior: { building: fb },
        isArrivalPending: () => arrivalPending,
    });

    const sprites = [
        // Unrecognized shell command (run-shell) must bucket to home district (forge), NOT command.
        makeReadSprite('s1', { tool: 'run_command', input: 'echo hello', building: 'forge' }),
        // Code read goes to archive.
        makeReadSprite('s2', { tool: 'Read', input: { file_path: 'src/a.js' } }),
        // Arrival-pending worker must be excluded from _readCounts.
        makeReadSprite('s3', { tool: 'Edit', input: { file_path: 'src/b.js' }, arrivalPending: true }),
        // Git flow -> harbor GIT.
        makeReadSprite('s4', { tool: 'Bash', input: 'git push origin main' }),
        // Verification -> taskboard TESTING.
        makeReadSprite('s5', { tool: 'Bash', input: 'npm test' }),
        // Delegation -> command DELEGATING.
        makeReadSprite('s6', { tool: 'Agent', input: 'lane 8' }),
        // Watch -> watchtower WATCHING.
        makeReadSprite('s7', { tool: 'Monitor', input: 'sleep 5' }),
        // Browser -> portal BROWSING.
        makeReadSprite('s8', { tool: 'mcp__playwright__browser_snapshot', input: '{}' }),
    ];

    building.setAgentSprites(sprites);

    assert.deepEqual(building._readPlaques.get('forge'), ['RUNNING · 1'], 'run-shell buckets to home district and skips arrivalPending s3');
    assert.deepEqual(building._readPlaques.get('archive'), ['READING · 1']);
    assert.deepEqual(building._readPlaques.get('harbor'), ['GIT · 1']);
    assert.deepEqual(building._readPlaques.get('taskboard'), ['TESTING · 1']);
    assert.deepEqual(building._readPlaques.get('command'), ['DELEGATING · 1'], 'run-shell did not leak into command');
    assert.deepEqual(building._readPlaques.get('watchtower'), ['WATCHING · 1']);
    assert.deepEqual(building._readPlaques.get('portal'), ['BROWSING · 1']);
    assert.ok(sprites.every(s => s.readToolVerb && s.readToolVerb !== 'OTHER'), 'no worker fell through to OTHER');

    // Once s3 finishes arriving, _readPlaques updates on the next setAgentSprites call.
    sprites[2].isArrivalPending = () => false;
    building.setAgentSprites(sprites);
    assert.deepEqual(building._readPlaques.get('forge'), ['RUNNING · 1', 'WRITING · 1']);

    // Plaque attempt keeps building name, puts all verb rows below, and sets hideCount: true.
    const [attempt] = building._labelRenderAttempts({ type: 'forge' }, {
        isHovered: false,
        isLandmark: true,
        zoom: 1,
        readRows: building._readPlaques.get('forge'),
    });
    assert.equal(attempt.text, 'FORGE');
    assert.equal(attempt.hideCount, true);
    assert.deepEqual(attempt.rows, [{ label: 'RUNNING · 1' }, { label: 'WRITING · 1' }]);
});
