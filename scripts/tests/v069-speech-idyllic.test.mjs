import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import {
    DEFAULT_SPEECH_DISPLAY,
    SPEECH_DISPLAY_EVENT,
    SPEECH_DISPLAY_LABELS,
    SPEECH_DISPLAY_MODES,
    SPEECH_DISPLAY_STORAGE_KEY,
    normalizeSpeechDisplay,
    readSpeechDisplay,
    writeSpeechDisplay,
} from '../../claudeville/src/presentation/shared/DisplaySettings.js';
import {
    VILLAGE_WEATHER_KEY,
    VILLAGE_WEATHER_MODES,
    readVillageForecast,
    readVillageWeather,
    readVillageWeatherMode,
    setVillageForecast,
    setVillageWeatherMode,
    watchVillageWeather,
    weatherMode,
} from '../../claudeville/src/presentation/shared/VillageWeatherSettings.js';
import {
    THOUGHT_COMPACT_MAX_TEXT,
    THOUGHT_HEAD,
    THOUGHT_OVERVIEW_CANDIDATE_COUNT,
    THOUGHT_PAINT,
    createThoughtColumn,
    layoutThoughtColumn,
    resolveSpeechDisplay,
    usesScribeLine,
} from '../../claudeville/src/presentation/character-mode/ThoughtColumn.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import {
    ambientCaptionLayout,
    paintSpeechLayer,
    shortSpeakerName,
} from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';
import {
    AUTHORED_DAY_SITE,
    AtmosphereState,
    IDYLLIC_WEATHER,
    WEATHER_PRESETS,
    createAtmosphereSnapshot,
    createLiveAtmosphereSnapshot,
    resolveFreezingState,
    resolveWeather,
    weatherHistorySampler,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { WIND_SPEED_BY_TYPE } from '../../claudeville/src/presentation/character-mode/Wind.js';
import {
    groundOptionsFor,
    groundStateAt,
    rainClearedMinutesAgo,
} from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { auroraGateOpen } from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';

const openMeteoFixture = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-london.json', import.meta.url)));

function makeRendererHost(zoom = 1, { width = 1280, height = 720 } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = {
        zoom,
        worldToScreen: (x, y) => ({ x: x * zoom, y: y * zoom }),
        screenToWorld: (x, y) => ({ x: x / zoom, y: y / zoom }),
    };
    renderer._screenViewport = () => ({ width, height });
    renderer._overlayBubbleOrder = [];
    renderer._overlayBubbleBaseRects = [];
    renderer._overlayBubbleOccupiedRects = [];
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    renderer._agentLabelHitRects = [];
    renderer._attentionWorldRects = [];
    renderer.buildingRenderer = { identityWorldRects: [] };
    renderer.theatreMode = false;
    renderer._readMode = false;
    renderer._readLocked = false;
    renderer._idleFrameDirty = false;
    return renderer;
}

function makeThreadEntry(text) {
    return { text, accent: '#f2d36b', confidence: null, shape: 'speech', badge: '' };
}

function makeSpeaker(id, {
    name = id,
    x = 400,
    y = 300,
    text = 'Investigating the terrain shader and lighting pass carefully',
    history = [],
    selected = false,
    hovered = false,
    fresh = 1000,
    repo = '#77aa88',
} = {}) {
    const thread = [makeThreadEntry(text), ...history.map(makeThreadEntry)];
    return {
        agent: { id, name, status: 'working' },
        x,
        y,
        selected,
        hovered,
        addedAt: -60_000,
        _dialogueDisplayUntil: fresh,
        _activitySnapshot: thread[0],
        _activityThread: () => thread,
        _shouldUseLongWaitClock: () => false,
        thoughtRepoAccent: () => repo,
        thoughtSpeakerTag: () => id.slice(0, 3).toUpperCase(),
        _providerTrimColor: () => '#ffffff',
        _statusVisual: () => ({ color: '#f2d36b' }),
    };
}

function rectsOverlap(a, b, pad = 0) {
    return a.x < b.x + b.w + pad
        && a.x + a.w + pad > b.x
        && a.y < b.y + b.h + pad
        && a.y + a.h + pad > b.y;
}

// ---------------------------------------------------------------------------
// Part 1 — Speech / Thought Display Modes (Item 2)
// ---------------------------------------------------------------------------

test('DisplaySettings speechDisplay constants and storage round-trip all 4 modes', () => {
    assert.equal(SPEECH_DISPLAY_STORAGE_KEY, 'claudeville.world.speechDisplay');
    assert.equal(SPEECH_DISPLAY_EVENT, 'world:speech-display-setting');
    assert.deepEqual(SPEECH_DISPLAY_MODES, ['auto', 'bubbles', 'spoken', 'both']);
    assert.equal(DEFAULT_SPEECH_DISPLAY, 'auto');
    assert.deepEqual(SPEECH_DISPLAY_LABELS, {
        auto: 'Zoom-adaptive',
        bubbles: 'Above agents',
        spoken: 'Bottom-left stream',
        both: 'Both',
    });

    const entries = new Map();
    const store = {
        getItem: k => entries.get(k) ?? null,
        setItem: (k, v) => entries.set(k, v),
    };
    assert.equal(readSpeechDisplay(store), 'auto');
    for (const mode of SPEECH_DISPLAY_MODES) {
        assert.equal(normalizeSpeechDisplay(mode), mode);
        assert.equal(writeSpeechDisplay(mode, store), mode);
        assert.equal(entries.get(SPEECH_DISPLAY_STORAGE_KEY), mode);
        assert.equal(readSpeechDisplay(store), mode);
    }
    assert.equal(normalizeSpeechDisplay('bogus'), 'auto');
    assert.equal(normalizeSpeechDisplay(null), 'auto');
    assert.equal(writeSpeechDisplay('bogus', store), 'auto');
    assert.equal(readSpeechDisplay(store), 'auto');

    const brokenStore = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
    };
    assert.equal(readSpeechDisplay(brokenStore), 'auto');
    assert.equal(writeSpeechDisplay('both', brokenStore), 'both');
});

test('resolveSpeechDisplay covers full 4 modes x zoom x readMode x theatreMode matrix', () => {
    const zooms = [0.5, 1.0, 1.59, 1.6, 2.0];
    for (const mode of [...SPEECH_DISPLAY_MODES, 'invalid']) {
        for (const z of zooms) {
            const compact = z < 1.6;
            // READ key B always forces above-agent bubbles and suppresses scribe stream.
            for (const theatre of [false, true]) {
                assert.deepEqual(resolveSpeechDisplay(z, true, theatre, mode), {
                    drawBubbles: true,
                    useScribe: false,
                    drawPip: false,
                    overviewCompact: compact,
                }, `readMode mode=${mode} z=${z} theatre=${theatre}`);
            }
            // Theatre mode H (without READ) always forces pure-stage SPOKEN stream + quill pip.
            assert.deepEqual(resolveSpeechDisplay(z, false, true, mode), {
                drawBubbles: false,
                useScribe: true,
                drawPip: true,
                overviewCompact: false,
            }, `theatreMode mode=${mode} z=${z}`);
        }
    }

    // Normal mode (readMode=false, theatreMode=false)
    for (const z of [0.5, 1.0, 1.59]) {
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'auto'), {
            drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false,
        });
        assert.equal(usesScribeLine(z, false, false), true);
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'bubbles'), {
            drawBubbles: true, useScribe: false, drawPip: false, overviewCompact: true,
        });
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'spoken'), {
            drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false,
        });
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'both'), {
            drawBubbles: true, useScribe: true, drawPip: false, overviewCompact: true,
        });
    }
    for (const z of [1.6, 2.0, 3.0]) {
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'auto'), {
            drawBubbles: true, useScribe: false, drawPip: false, overviewCompact: false,
        });
        assert.equal(usesScribeLine(z, false, false), false);
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'bubbles'), {
            drawBubbles: true, useScribe: false, drawPip: false, overviewCompact: false,
        });
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'spoken'), {
            drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false,
        });
        assert.deepEqual(resolveSpeechDisplay(z, false, false, 'both'), {
            drawBubbles: true, useScribe: true, drawPip: false, overviewCompact: false,
        });
    }
});

test('overview compact bubble packing at z=0.5 and z=1.0 enforces scaled budget, compact width, short candidates, screen-space pad, and zero overlaps', () => {
    // z = 0.5 -> s = 2, screen-space pad = max(2, round(4 * 2)) = 8 world px, non-focused budget = 3.
    const r05 = makeRendererHost(0.5, { width: 1280, height: 720 });
    assert.equal(r05.getSpeechDisplay(), 'auto');
    assert.equal(r05.setSpeechDisplay('bubbles'), 'bubbles');
    assert.equal(r05._idleFrameDirty, true);

    const cluster05 = Array.from({ length: 8 }, (_, i) => makeSpeaker(`s05-${i}`, {
        x: 700 + (i % 4) * 140,
        y: 500 + Math.floor(i / 4) * 100,
        text: `Agent ${i} auditing isometric shaders and viewport clamping`,
        history: ['Older line one', 'Oldest line two'],
        fresh: 1000 + i,
    }));
    r05._assignAgentBubbleSlots(cluster05, 0.5, [], null, 1000);
    const placed05 = cluster05.filter(sp => sp.bubbleSlot != null);
    assert.ok(placed05.length >= 1 && placed05.length <= 3, `z=0.5 budget <= 3, got ${placed05.length}`);
    for (const sp of placed05) {
        assert.equal(sp._thoughtHeadMaxText, THOUGHT_COMPACT_MAX_TEXT);
        assert.equal(sp._thoughtHistoryLimit, 0, 'non-focused speakers drop history rows in overview compact');
        assert.equal(sp._thoughtColumn.rows, 1);
        assert.ok(sp._thoughtColumn.textWidth <= THOUGHT_COMPACT_MAX_TEXT);
        assert.ok(sp._bubbleCandidate < THOUGHT_OVERVIEW_CANDIDATE_COUNT, `candidate ${sp._bubbleCandidate} < 16`);
        assert.ok(sp.bubbleSlot <= 3, `slot ${sp.bubbleSlot} <= 3`);
    }
    for (let i = 0; i < placed05.length; i++) {
        for (let j = i + 1; j < placed05.length; j++) {
            assert.equal(
                rectsOverlap(placed05[i]._thoughtRects.body, placed05[j]._thoughtRects.body, 0),
                false,
                `z=0.5 bubbles ${placed05[i].agent.id} and ${placed05[j].agent.id} must not overlap`,
            );
        }
    }

    // Selected speaker in overview compact keeps 2 history rows and is always admitted alongside the 3 non-focused cap.
    cluster05[0].selected = true;
    r05._assignAgentBubbleSlots(cluster05, 0.5, [], null, 2000);
    assert.notEqual(cluster05[0].bubbleSlot, null);
    assert.equal(cluster05[0]._thoughtHistoryLimit, 2);
    assert.equal(cluster05[0]._thoughtColumn.rows, 3);

    // z = 1.0 -> s = 1, pad = 4 world px, non-focused budget = 5.
    const r10 = makeRendererHost(1.0, { width: 1280, height: 720 });
    r10.setSpeechDisplay('bubbles');
    const cluster10 = Array.from({ length: 10 }, (_, i) => makeSpeaker(`s10-${i}`, {
        x: 200 + (i % 5) * 190,
        y: 260 + Math.floor(i / 5) * 140,
        text: `Speaker ${i} verifying compact overview packing across districts`,
        history: ['Earlier step', 'Oldest step'],
        fresh: 2000 + i,
    }));
    r10._assignAgentBubbleSlots(cluster10, 1.0, [], null, 1000);
    const placed10 = cluster10.filter(sp => sp.bubbleSlot != null);
    assert.equal(placed10.length, 5, `z=1.0 budget should admit 5 speakers, got ${placed10.length}`);
    for (const sp of placed10) {
        assert.equal(sp._thoughtHeadMaxText, THOUGHT_COMPACT_MAX_TEXT);
        assert.equal(sp._thoughtHistoryLimit, 0);
        assert.ok(sp._bubbleCandidate < THOUGHT_OVERVIEW_CANDIDATE_COUNT);
        assert.ok(sp.bubbleSlot <= 3);
    }
    for (let i = 0; i < placed10.length; i++) {
        for (let j = i + 1; j < placed10.length; j++) {
            assert.equal(
                rectsOverlap(placed10[i]._thoughtRects.body, placed10[j]._thoughtRects.body, 0),
                false,
                `z=1.0 bubbles ${placed10[i].agent.id} and ${placed10[j].agent.id} must not overlap`,
            );
        }
    }

    // z = 2.0 -> non-compact budget is 8 with full 232 px maxText.
    const r20 = makeRendererHost(2.0, { width: 2560, height: 1440 });
    r20.setSpeechDisplay('bubbles');
    const cluster20 = Array.from({ length: 10 }, (_, i) => makeSpeaker(`s20-${i}`, {
        x: 150 + (i % 5) * 200,
        y: 200 + Math.floor(i / 5) * 180,
        fresh: 3000 + i,
    }));
    r20._assignAgentBubbleSlots(cluster20, 2.0, [], null, 1000);
    const placed20 = cluster20.filter(sp => sp.bubbleSlot != null);
    assert.equal(placed20.length, 8);
    assert.equal(placed20[0]._thoughtHeadMaxText, THOUGHT_HEAD.maxText);
});

test('Both mode snapshots SPOKEN line before AgentSprite.drawThought clears _statusThread, formats speaker name, and omits duplicate quill pip', () => {
    const pipRects = [];
    const paintedColumns = [];
    const ctx = {
        font: '',
        fillStyle: '',
        globalAlpha: 1,
        save() {},
        restore() {},
        translate() {},
        scale() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        setTransform() {},
        measureText: s => ({ width: String(s).length * 7 }),
        fillRect(...args) { pipRects.push(args); },
        fillText() {},
    };

    // Use real AgentSprite.prototype.drawThought + _drawStatus clearing `_statusThread = null`!
    const sprite = Object.create(AgentSprite.prototype);
    Object.assign(sprite, {
        agent: { id: 'agent-both', name: 'Archivist-of-the-Western-Isle', status: 'working' },
        x: 300,
        y: 220,
        _placeX: 300,
        bubbleSlot: 0,
        bubbleLateral: 0,
        bubbleClampX: 0,
        bubbleBaseY: 180,
        bubbleOccluded: false,
        bubbleMergedInto: null,
        bubbleMergedCount: 1,
        decisionFocusMuted: false,
        chatting: false,
        _thoughtAnchorX: 300,
        _thoughtHistoryLimit: 0,
        _thoughtHeadMaxText: THOUGHT_COMPACT_MAX_TEXT,
        _statusClock: false,
        _statusThread: [makeThreadEntry('Indexing the lantern archive')],
        _activityThread: () => [makeThreadEntry('Indexing the lantern archive')],
        _shouldUseLongWaitClock: () => false,
        thoughtRepoAccent: () => '#77aa88',
        thoughtSpeakerTag: () => 'ARC',
        _statusVisual: () => ({ color: '#f2d36b' }),
        _drawThoughtHead(_c, column) { paintedColumns.push({ width: column.headWidth, textWidth: column.textWidth }); },
        _drawThoughtHistory() {},
    });

    const renderer = {
        _overlayBubbleOrder: [sprite],
        getReadMode: () => false,
        getSpeechDisplay: () => 'both',
        camera: {},
    };

    const plan = paintSpeechLayer(ctx, renderer, [sprite], { zoom: 1, restZoom: 1, theatreMode: false });
    assert.equal(plan.drawBubbles, true);
    assert.equal(plan.useScribe, true);
    assert.equal(plan.drawPip, false);
    // AgentSprite._drawStatus cleared _statusThread during COLUMN paint!
    assert.equal(sprite._statusThread, null);
    assert.equal(paintedColumns.length, 1);
    assert.ok(paintedColumns[0].textWidth <= THOUGHT_COMPACT_MAX_TEXT, 'painter honoured compact _thoughtHeadMaxText');
    // No 3-dot quill pip drawn because the speaker already has a visible bubble!
    assert.equal(pipRects.length, 0);

    // ambientCaptionLayout must NOT crash after _statusThread became null, and must attribute speaker!
    const caption = ambientCaptionLayout(ctx, renderer, { width: 1280, height: 720 });
    assert.ok(caption, 'SPOKEN caption rendered in Both mode');
    assert.equal(caption.style.eyebrow, 'SPOKEN');
    assert.equal(caption.chip, '#77aa88');
    const expectedName = shortSpeakerName(sprite);
    assert.equal(expectedName.length, 18);
    assert.ok(expectedName.endsWith('…'));
    assert.equal(caption.text, `${expectedName} · Indexing the lantern archive`);

    // Spoken-only mode draws the 3-dot quill pip and skips drawThoughtLayer.
    sprite._statusThread = [makeThreadEntry('Quietly listening')];
    sprite.agent.name = 'Atlas';
    paintedColumns.length = 0;
    pipRects.length = 0;
    renderer.getSpeechDisplay = () => 'spoken';
    paintSpeechLayer(ctx, renderer, [sprite], { zoom: 2, restZoom: 2, theatreMode: false });
    assert.equal(paintedColumns.length, 0, 'spoken mode draws no above-agent bubble');
    assert.equal(pipRects.length, 3, 'spoken mode draws the 3-dot quill pip');
    const spokenCaption = ambientCaptionLayout(ctx, renderer, { width: 1280, height: 720 });
    assert.equal(spokenCaption.text, 'Atlas · Quietly listening');
});

test('spoken and overview auto modes do not leak phantom bubble hit rects or suppress head glyphs', () => {
    const renderer = makeRendererHost(1.0);
    renderer.setSpeechDisplay('spoken');
    const sprite = makeSpeaker('hidden-bubble', { x: 400, y: 300 });
    renderer._assignAgentBubbleSlots([sprite], 1.0, [], null, 1000);
    assert.notEqual(sprite.bubbleSlot, null, 'speaker still resolves for SPOKEN scribe');
    assert.equal(sprite._thoughtBubblesDrawn, false);
    assert.equal(renderer._speechDisplayPlan.drawBubbles, false);

    // Phantom bubble body rect must NOT be handed to building plaques.
    const hitRects = renderer._collectAgentLabelHitRects([sprite]);
    assert.equal(hitRects.includes(sprite._thoughtRects.body), false, 'undrawn bubble body excluded from plaque hit rects');

    // AgentSprite._thoughtOwnsHead must return false when bubbles are hidden!
    const agentSprite = Object.create(AgentSprite.prototype);
    agentSprite.bubbleSlot = 0;
    agentSprite.bubbleMergedInto = null;
    agentSprite.decisionFocusMuted = false;
    agentSprite._thoughtBubblesDrawn = false;
    assert.equal(agentSprite._thoughtOwnsHead(), false, '_thoughtBubblesDrawn=false leaves head glyphs visible');

    agentSprite._thoughtBubblesDrawn = undefined;
    agentSprite.renderer = { _speechDisplayPlan: { drawBubbles: false } };
    assert.equal(agentSprite._thoughtOwnsHead(), false, 'renderer._speechDisplayPlan.drawBubbles=false leaves head glyphs visible');

    agentSprite.renderer = { _speechDisplayPlan: { drawBubbles: true } };
    assert.equal(agentSprite._thoughtOwnsHead(), true, 'visible bubble owns head space');

    // Switching back to bubbles restores hit rect forwarding.
    renderer.setSpeechDisplay('bubbles');
    renderer._assignAgentBubbleSlots([sprite], 1.0, [], null, 2000);
    assert.equal(renderer._speechDisplayPlan.drawBubbles, true);
    const bubbleHitRects = renderer._collectAgentLabelHitRects([sprite]);
    assert.equal(bubbleHitRects.includes(sprite._thoughtRects.body), true);

    // Event bus subscription wiring check.
    const unsub = eventBus.on(SPEECH_DISPLAY_EVENT, ({ mode } = {}) => renderer.setSpeechDisplay(mode));
    try {
        eventBus.emit(SPEECH_DISPLAY_EVENT, { mode: 'both' });
        assert.equal(renderer.getSpeechDisplay(), 'both');
    } finally {
        unsub();
    }
});

// ---------------------------------------------------------------------------
// Part 2 — Third Village Sky / Weather Mode: Idyllic (Item 4.E)
// ---------------------------------------------------------------------------

test('VillageWeatherSettings watchVillageWeather: zero fetches in idyllic, aborts real-sky fetch, fires onChange on modeled <-> idyllic', async (t) => {
    t.after(() => {
        setVillageWeatherMode('modeled');
        setVillageForecast(null);
    });
    assert.deepEqual(VILLAGE_WEATHER_MODES, ['modeled', 'real-sky', 'idyllic']);
    assert.equal(weatherMode('modeled'), 'modeled');
    assert.equal(weatherMode('real-sky'), 'real-sky');
    assert.equal(weatherMode('idyllic'), 'idyllic');
    assert.equal(weatherMode('sunny'), 'modeled');

    const storageMap = new Map([[VILLAGE_WEATHER_KEY, 'idyllic']]);
    const fakeStorage = { getItem: k => storageMap.get(k) ?? null };
    assert.equal(readVillageWeather(fakeStorage), 'idyllic');

    let fetchCalls = 0;
    let activeSignal = null;
    let resolveFetch = null;
    let clearedTimers = 0;
    let scheduledTimer = 0;
    let changes = 0;
    const root = {
        localStorage: { getItem: k => storageMap.get(k) ?? null },
        addEventListener() {},
        removeEventListener() {},
        setTimeout: () => ++scheduledTimer,
        clearTimeout(id) { if (id) clearedTimers++; },
        fetch: (_url, { signal }) => {
            fetchCalls++;
            activeSignal = signal;
            return new Promise(resolve => { resolveFetch = resolve; });
        },
    };

    // Boot directly in idyllic: zero fetch calls, forecast null, mode idyllic.
    const watcher = watchVillageWeather({ root, onChange: () => { changes++; } });
    try {
        assert.equal(fetchCalls, 0);
        assert.equal(readVillageWeatherMode(), 'idyllic');
        assert.equal(readVillageForecast(), null);

        // idyllic -> modeled fires onChange without touching fetch.
        const c1 = changes;
        watcher.setMode('modeled');
        assert.equal(readVillageWeatherMode(), 'modeled');
        assert.equal(changes, c1 + 1);
        assert.equal(fetchCalls, 0);

        // modeled -> idyllic fires onChange without touching fetch.
        const c2 = changes;
        watcher.setMode('idyllic');
        assert.equal(readVillageWeatherMode(), 'idyllic');
        assert.equal(changes, c2 + 1);
        assert.equal(fetchCalls, 0);

        // idyllic -> real-sky starts fetch, then switching to idyllic aborts it & clears forecast!
        watcher.setMode('real-sky');
        assert.equal(fetchCalls, 1);
        assert.equal(activeSignal.aborted, false);
        assert.notEqual(readVillageForecast(), null);

        const c3 = changes;
        watcher.setMode('idyllic');
        assert.equal(activeSignal.aborted, true, 'switching real-sky -> idyllic aborts in-flight fetch');
        assert.equal(readVillageWeatherMode(), 'idyllic');
        assert.equal(readVillageForecast(), null, 'switching to idyllic clears villageForecast');
        assert.equal(changes, c3 + 1);

        // Late resolution of aborted fetch is ignored and schedules no timer.
        resolveFetch(Response.json({ fetchedAt: Date.now(), hourly: openMeteoFixture.hourly }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(readVillageForecast(), null);
        assert.equal(scheduledTimer, 0);
        assert.equal(clearedTimers, 0);
    } finally {
        watcher.destroy();
    }
    assert.equal(readVillageWeatherMode(), 'modeled', 'destroy resets weather mode to modeled');

    // Simulation mode forces modeled even when localStorage says idyllic.
    const simWatcher = watchVillageWeather({ root, simulation: true });
    try {
        assert.equal(readVillageWeatherMode(), 'modeled');
        simWatcher.setMode('idyllic');
        assert.equal(readVillageWeatherMode(), 'modeled');
    } finally {
        simWatcher.destroy();
    }
});

test('Idyllic atmosphere holds balmy clear weather and dry frostless winter ground while preserving day/night, moon, Lantern Night, aurora, and QA overrides', async (t) => {
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    globalThis.window = Object.assign(new EventTarget(), { location: new URL('http://localhost/') });
    globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
    t.after(() => {
        setVillageWeatherMode('modeled');
        setVillageForecast(null);
        if (prevWindow !== undefined) globalThis.window = prevWindow;
        else delete globalThis.window;
        if (prevDocument !== undefined) globalThis.document = prevDocument;
        else delete globalThis.document;
    });

    assert.equal(Object.isFrozen(IDYLLIC_WEATHER), true);
    assert.equal(IDYLLIC_WEATHER.type, 'clear');
    assert.equal(IDYLLIC_WEATHER.intensity, WEATHER_PRESETS.clear.intensity);
    assert.equal(IDYLLIC_WEATHER.cloudCover, 0.10);
    assert.equal(IDYLLIC_WEATHER.precipitation, 0);
    assert.equal(IDYLLIC_WEATHER.fog, 0);
    assert.equal(IDYLLIC_WEATHER.frozen, false);
    assert.equal(IDYLLIC_WEATHER.windX, WIND_SPEED_BY_TYPE.clear);

    // Default createAtmosphereSnapshot stays modeled for backwards compatibility.
    const modeledDefault = createAtmosphereSnapshot({ now: new Date(2026, 0, 15, 12, 0) });
    assert.equal(modeledDefault.weatherSource, null);

    // Winter night & dawn (Jan 15 02:00 & 06:00, Nov 20 23:00): dry, frostless, non-freezing!
    setVillageWeatherMode('idyllic');
    const janNight = new Date(2026, 0, 15, 2, 0);
    const janDawn = new Date(2026, 0, 15, 6, 0);
    const novNight = new Date(2026, 10, 20, 23, 0);
    const state = new AtmosphereState({ nowProvider: () => janNight });

    for (const date of [janNight, janDawn, novNight]) {
        const snap = state.update({ now: date });
        assert.deepEqual(snap.weatherSource, { kind: 'idyllic', ageMinutes: null });
        assert.equal(snap.timeline.idyllic, true);
        assert.equal(snap.weather.type, 'clear');
        assert.equal(snap.weather.cloudCover, 0.10);
        assert.equal(snap.weather.precipitation, 0);
        assert.equal(snap.weather.fog, 0);
        assert.equal(snap.weather.frozen, false);
        assert.equal(snap.weather.freezing, false, `no icy breath on ${date.toISOString()}`);
        assert.equal(snap.weather.windX, WIND_SPEED_BY_TYPE.clear);

        const gOpts = groundOptionsFor(snap);
        assert.equal(gOpts.idyllic, true);
        const ground = groundStateAt(date, gOpts);
        assert.deepEqual(ground, {
            wetness: 0,
            puddles: 0,
            snowCover: 0,
            frost: 0,
            frostRising: false,
            bucketMinute: ground.bucketMinute,
        });
        assert.equal(rainClearedMinutesAgo(date, gOpts), null);
        assert.equal(weatherHistorySampler(date, { idyllic: true })(120), IDYLLIC_WEATHER);
    }

    // resolveFreezingState explicitly returns false under idyllic even with winter clear dawn & prior freezing.
    assert.equal(resolveFreezingState(null, true, false, {
        date: janDawn,
        weather: IDYLLIC_WEATHER,
        phase: 'dawn',
        idyllic: true,
    }), false);
    assert.equal(resolveWeather(janNight, null, { idyllic: true }).type, 'clear');

    // Real day/night shift, light grades, moon, and aurora remain active in Idyllic mode!
    const noonSnap = createAtmosphereSnapshot({
        now: new Date(2026, 0, 15, 12, 30),
        weatherMode: 'idyllic',
        solarSite: AUTHORED_DAY_SITE,
    });
    const nightSnap = createAtmosphereSnapshot({
        now: new Date(2026, 0, 15, 23, 0),
        weatherMode: 'idyllic',
        solarSite: AUTHORED_DAY_SITE,
    });
    assert.equal(noonSnap.phase, 'day');
    assert.equal(nightSnap.phase, 'night');
    assert.ok(noonSnap.lightGrade.exposure > nightSnap.lightGrade.exposure, 'real day/night exposure arc preserved');
    assert.ok(nightSnap.sky.starsAlpha > 0.5, 'clear idyllic night shows stars');
    assert.equal(auroraGateOpen(nightSnap), true, 'winter night aurora gate remains open in Idyllic mode');

    // Full-moon night preserves moon illumination and Lantern Night!
    const fullMoonNight = createAtmosphereSnapshot({
        now: new Date(2026, 10, 24, 21, 0),
        weatherMode: 'idyllic',
        solarSite: { zone: 'greenwich', lat: 51.5, lon: 0, offsetMinutes: () => 0 },
    });
    assert.equal(fullMoonNight.sky.moon.visible, true, 'moon arc remains visible in Idyllic mode');
    assert.ok(fullMoonNight.lighting.moonFill > 0, 'moonFill remains active in Idyllic mode');
    assert.equal(fullMoonNight.skyKeys.lanternNight, true, 'Lantern Night remains active in Idyllic mode');

    // QA overrides win over Idyllic mode!
    const rainOverride = state.setWeather('rain');
    assert.equal(rainOverride.weather.type, 'rain');
    assert.equal(rainOverride.weatherSource, null);
    assert.equal(rainOverride.timeline.idyllic, false);
    assert.equal(groundOptionsFor(rainOverride).idyllic, false);

    // Frozen snapshot ignores live Idyllic mode (protects golden/parity frames).
    state.clear();
    const backToIdyllic = state.update({ now: janNight });
    assert.equal(backToIdyllic.weatherSource.kind, 'idyllic');
    const frozen = state.freeze();
    assert.equal(frozen.weatherSource, null);
    assert.equal(frozen.timeline.idyllic, false);

    // Live helper & App dashboard/chronicle helpers read live Idyllic mode!
    const live = createLiveAtmosphereSnapshot();
    assert.deepEqual(live.weatherSource, { kind: 'idyllic', ageMinutes: null });
    assert.equal(live.weather.type, 'clear');

    const { App } = await import('../../claudeville/src/presentation/App.js');
    const fakeApp = Object.assign(Object.create(App.prototype), {
        renderer: null,
        modeManager: { getCurrentMode: () => 'dashboard' },
    });
    const dashAtmo = fakeApp._readDashboardAtmosphere();
    assert.deepEqual(dashAtmo.weatherSource, { kind: 'idyllic', ageMinutes: null });
    const skyCode = fakeApp._currentChronicleSkyCode();
    assert.equal(skyCode.rain, 0);
    assert.equal(skyCode.snow, 0);
    assert.equal(skyCode.cloud, 0);
    const appSource = readFileSync(new URL('../../claudeville/src/presentation/App.js', import.meta.url), 'utf8');
    assert.match(appSource, /refreshAtmosphere:\s*snapshot\s*=>[\s\S]*?_invalidateIdleFrame\?\.\(\)/);
});
