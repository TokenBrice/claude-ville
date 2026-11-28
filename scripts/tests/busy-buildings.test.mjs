import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BuildingSprite,
    DAYTIME_ROOM_GLASS_SHARE,
    FORGE_BANK_COOLDOWN_MS,
} from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { BuildingPartGates, workerTier } from '../../claudeville/src/presentation/character-mode/BuildingPartGates.js';
import {
    BUILDING_EMITTER_FALLBACKS,
    BUILDING_VISUAL_REGISTRY,
    getBuildingEffectAnchor,
    getBuildingPennantAnchor,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { buildApertureModel } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { MarkGovernor, MarkTier, setActiveMarkGovernor, getActiveMarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { ritualDownbeat } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';
import { RoomGlass, litStep, unlitStep } from '../../claudeville/src/presentation/character-mode/RoomGlass.js';
import { drawWorkDownbeat } from '../../claudeville/src/presentation/character-mode/WorkDownbeats.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

function recCtx() {
    const fills = [];
    const draws = [];
    const texts = [];
    return {
        fills,
        draws,
        texts,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '',
        font: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        save() {},
        restore() {},
        translate() {},
        scale() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        setTransform() {},
        measureText: (text) => ({ width: String(text).length * 7 }),
        fillRect(x, y, w, h) {
            fills.push({ x, y, w, h, fill: this.fillStyle, alpha: this.globalAlpha });
        },
        drawImage(...args) {
            draws.push({ args, alpha: this.globalAlpha });
        },
        fillText(text, x, y) {
            texts.push({ text, x, y, fill: this.fillStyle });
        },
    };
}

test('1. Forge banks whenever work.forge is closed, with a short 5–10 s cooldown against flicker', () => {
    assert.ok(FORGE_BANK_COOLDOWN_MS >= 5000 && FORGE_BANK_COOLDOWN_MS <= 10000);
    const gates = new BuildingPartGates();
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        partGates: gates,
        motionScale: 1,
        _forgeGlow: 0.22,
        _forgeWarmRemainingMs: 0,
        _forgeWorkload: { banked: false },
        _villageAtRest: () => false,
        _ritualsFor: () => [],
    });
    const forge = { type: 'forge' };

    // Starts empty with work.forge closed: banked immediately.
    gates.update({ workingIdsByType: new Map() });
    assert.equal(renderer._restMaskShowing(forge), true);

    // Worker arrives: ignites immediately and arms cooldown.
    gates.update({ workingIdsByType: new Map([['forge', new Set(['smith-1'])]]) });
    renderer._updateForgeGlow(16);
    assert.equal(renderer._restMaskShowing(forge), false);
    assert.equal(renderer._forgeWarmRemainingMs, FORGE_BANK_COOLDOWN_MS);
    assert.equal(renderer._forgeGlow, 0.62);

    // Steady active ticks must hold at target (0.62) without alternating decay below target,
    // and ritual cooldown must clamp at target rather than dipping to floor.
    renderer._updateForgeGlow(50);
    renderer._updateForgeGlow(50);
    assert.equal(renderer._forgeGlow, 0.62, 'active forge glow stays steady at target without 2-frame sawtooth');
    renderer._forgeGlow = 0.63;
    renderer._updateForgeGlow(50);
    assert.equal(renderer._forgeGlow, 0.62, 'post-ritual decay clamps at active target rather than undershooting');

    // Worker leaves: stays warm during cooldown against flicker.
    gates.update({ workingIdsByType: new Map() });
    renderer._updateForgeGlow(FORGE_BANK_COOLDOWN_MS - 1000);
    assert.equal(renderer._restMaskShowing(forge), false);

    // Once cooldown expires: Forge banks.
    renderer._updateForgeGlow(1000);
    assert.equal(renderer._restMaskShowing(forge), true);
});

test('2. Every landmark has a pennant anchor and occupancy pennants render at alpha 1 outside MarkGovernor', () => {
    for (const type of ['command', 'taskboard', 'forge', 'mine', 'archive', 'tavern', 'portal', 'watchtower', 'harbor']) {
        const anchor = getBuildingPennantAnchor(type);
        assert.ok(Array.isArray(anchor?.at) && anchor.at.length === 2, `${type} defines pennant.at`);
    }

    // Even under a saturated MarkGovernor with a nearby PRIMARY mark, pennants keep globalAlpha = 1.
    const prevGov = getActiveMarkGovernor();
    const gov = new MarkGovernor();
    gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 2 });
    gov.admit(MarkTier.PRIMARY, 100, 100);
    for (let i = 0; i < 10; i++) gov.admit(MarkTier.AMBIENT, 100, 100);
    setActiveMarkGovernor(gov);
    try {
        const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
            assets: { getAnchor: () => [0, 0] },
            partGates: new BuildingPartGates(),
            frame: 0,
            motionScale: 1,
            atmosphereState: { weather: { type: 'clear', windX: 0.35 } },
            _visitorRepoByType: new Map([['forge', { project: 'p', count: 1, profile: { accent: '#ffaa33', hue: 30, saturation: 80, lightness: 60 } }]]),
            _patronIdsByType: new Map(),
            _buildingOccupancyInfo: () => ({ state: 'occupied', count: 1, capacity: 4, ratio: 0.25 }),
            _overlayLightGrade: () => null,
        });
        const alphas = [];
        const ctx = {
            _alpha: 0.2,
            get globalAlpha() { return this._alpha; },
            set globalAlpha(v) { this._alpha = v; alphas.push(v); },
            save() {},
            restore() {},
            drawImage() {},
        };
        renderer._drawOccupancyPennant(ctx, { type: 'forge' }, { id: 'building.forge' }, 100, 100, 'whole', null);
        assert.ok(alphas.includes(1), 'pennant forces full opacity (globalAlpha = 1)');
    } finally {
        setActiveMarkGovernor(prevGov);
    }
});

test('3. Occupied rooms glow warm amber by day (roomGlassGate) while light pools stay night-only (roomGate)', () => {
    assert.ok(DAYTIME_ROOM_GLASS_SHARE >= 0.5 && DAYTIME_ROOM_GLASS_SHARE <= 0.75);
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: { clock: { minuteOfDay: 12 * 60 } },
        _roomLitByType: new Map([['archive', new Float32Array([1, 0, 1])]]),
        _apertureModel: null,
        _apertureProfile: null,
    });
    // Daytime: occupied rooms get daytime glass share; empty rooms stay dark; ApertureLights roomGate stays 0.
    assert.equal(renderer.roomGlassGate('archive', 0), DAYTIME_ROOM_GLASS_SHARE);
    assert.equal(renderer.roomGlassGate('archive', 1), 0);
    assert.equal(renderer._glassGroupGate('archive', 1), DAYTIME_ROOM_GLASS_SHARE);
    assert.equal(renderer._glassGroupGate('archive', 2), 0);
    assert.equal(renderer._glassGroupGate('archive', 0), 0, 'hall panes stay dark');
    assert.equal(renderer.roomGate('archive', 0), 0, 'ApertureLights/water columns stay night-only');

    // Night: occupied rooms reach full 1.0 on both glass and light gates.
    renderer.atmosphereState = { clock: { minuteOfDay: 23 * 60 } };
    assert.equal(renderer.roomGlassGate('archive', 0), 1);
    assert.equal(renderer.roomGate('archive', 0), 1);
    assert.equal(renderer.roomGlassGate('archive', 1), 0);

    // RoomGlass.patch paints warm interior amber on daytime occupied rooms
    // (blended from base.emissive.png at DAYTIME_ROOM_GLASS_SHARE, alpha 255),
    // dark slate on empty rooms, and transparent pass-through at night.
    assert.equal(litStep(0.75), 0.75);
    assert.equal(unlitStep(0.75), 0.25);
    const prevDoc = globalThis.document;
    let lastImageData = null;
    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: (img) => { lastImageData = img; },
            }),
        }),
    };
    try {
        const rg = new RoomGlass(null);
        // 2x1 sprite: pixel 0 is room 1 (occupied), pixel 1 is room 2 (empty).
        rg._maps.set('archive', {
            left: 0,
            top: 0,
            w: 2,
            h: 1,
            spriteWidth: 2,
            rooms: 2,
            group: new Int8Array([1, 2]),
            albedo: new Uint8ClampedArray([
                52, 52, 60, 255,
                52, 52, 60, 255,
            ]),
            emissive: new Uint8ClampedArray([
                252, 196, 124, 160,
                252, 196, 124, 160,
            ]),
            channels: { material: null, occluder: null },
        });
        // Noon: room 1 lit at 0.75 (night 0), room 2 empty (0).
        const dayPatch = rg.patch(
            'archive',
            (g) => (g === 1 ? DAYTIME_ROOM_GLASS_SHARE : 0),
            () => 0,
        );
        assert.equal(dayPatch.hasDaytimeLit, true);
        // Room 1 blended 75% toward warm amber [252, 196, 124]: R=202, G=160, B=108, A=255.
        assert.deepEqual([...lastImageData.data.slice(0, 4)], [202, 160, 108, 255]);
        // Room 2 remains dark slate albedo [52, 52, 60, 255].
        assert.deepEqual([...lastImageData.data.slice(4, 8)], [52, 52, 60, 255]);

        // Night: room 1 lit at 1.0 (night 1), room 2 empty (0).
        const nightPatch = rg.patch(
            'archive',
            (g) => (g === 1 ? 1 : 0),
            (g) => (g === 1 ? 1 : 0),
        );
        assert.equal(nightPatch.hasDaytimeLit, false);
        // Room 1 is transparent pass-through (full night emissive + bloom/pools).
        assert.deepEqual([...lastImageData.data.slice(0, 4)], [0, 0, 0, 0]);
        // Room 2 remains dark slate.
        assert.deepEqual([...lastImageData.data.slice(4, 8)], [52, 52, 60, 255]);
    } finally {
        globalThis.document = prevDoc;
    }
});

test('4. WorkDownbeats peak is 4x4 with 2-texel rays and DOWNBEAT_STRIDE is 2', () => {
    const ritual = { pose: 'hammer', phase: 'playing', beatOrigin: 0, motionEnabled: true };
    // Hammer period is 460 ms; stride 2 hits beat 0, 2, 4 (never 1, 3).
    assert.ok(ritualDownbeat(ritual, 0), 'beat 0 strikes');
    assert.equal(ritualDownbeat(ritual, 460), null, 'beat 1 skipped');
    const beat2 = ritualDownbeat(ritual, 920);
    assert.ok(beat2 && beat2.phase === 'peak', 'beat 2 hits peak at stride 2');

    const ctx = recCtx();
    const drawn = drawWorkDownbeat(ctx, ritual, 100, 100, { side: 1, scale: 1, now: 920 });
    assert.equal(drawn, true);
    const core = ctx.fills.find((f) => f.w === 4 && f.h === 4);
    assert.ok(core, 'peak draws a 4x4 cream core');
    const rays = ctx.fills.filter((f) => f.w === 2 && f.h === 2);
    assert.equal(rays.length, 6, 'peak draws three 2-step rays of 2x2 texels');
});

test('4. Worker tiers (1, 2–4, 5+), raised Forge/Portal emitters, and ChimneySmoke tiers + Lighthouse cottage', () => {
    assert.equal(workerTier(0), 0);
    assert.equal(workerTier(1), 1);
    assert.equal(workerTier(2), 2);
    assert.equal(workerTier(4), 2);
    assert.equal(workerTier(5), 3);
    assert.equal(workerTier(12), 3);

    const forgeSpark = BUILDING_EMITTER_FALLBACKS.forge.find((e) => e.type === 'forgeSpark');
    const portalRune = BUILDING_EMITTER_FALLBACKS.portal.find((e) => e.type === 'portalRune');
    assert.ok(forgeSpark.chance >= 0.1, `forgeSpark chance raised (${forgeSpark.chance})`);
    assert.ok(portalRune.chance >= 0.1, `portalRune chance raised (${portalRune.chance})`);
    assert.ok(Array.isArray(getBuildingEffectAnchor('watchtower', 'cottageSmokeTop')), 'Lighthouse defines cottageSmokeTop');

    // ChimneySmoke: Lighthouse cottage smokes by day when occupied; crown stays night-only; worker tiers step 420 -> 280 -> 140 ms.
    const smoke = new ChimneySmoke();
    smoke.sources = () => [
        { key: 'watchtower:0', type: 'watchtower', kind: 'crown', x: 100, y: 50, hearth: true, building: {}, localY: 50 },
        { key: 'watchtower:cottage', type: 'watchtower', kind: 'cottage', x: 80, y: 200, hearth: false, building: {}, localY: 237 },
        { key: 'forge:0', type: 'forge', kind: 'workshop', x: 300, y: 100, hearth: true, building: {}, localY: 15 },
    ];
    const spawned = [];
    const particles = { motionEnabled: true, countTagged: () => 0, spawn: (...args) => spawned.push(args) };
    const noon = { clock: { minuteOfDay: 12 * 60 }, phase: 'day', weather: { type: 'clear', windX: 0.35 } };

    // Occupied Lighthouse + 5-worker Forge at noon: cottage and Forge smoke; tower crown stays silent.
    smoke.update({
        now: 140,
        timeMs: 140,
        atmosphere: noon,
        particleSystem: particles,
        presence: new Map([
            ['watchtower', { count: 1, tier: 'occupied' }],
            ['forge', { count: 5, tier: 'busy' }],
        ]),
    });
    assert.deepEqual(spawned.map((s) => s[4].tag).sort(), ['chimney:forge:0', 'chimney:watchtower:cottage']);
    // 140 ms later: tier-3 Forge (5+ workers) emits again; tier-1 cottage (420 ms) waits.
    smoke.update({
        now: 280,
        timeMs: 280,
        atmosphere: noon,
        particleSystem: particles,
        presence: new Map([
            ['watchtower', { count: 1, tier: 'occupied' }],
            ['forge', { count: 5, tier: 'busy' }],
        ]),
    });
    assert.equal(spawned.filter((s) => s[4].tag === 'chimney:forge:0').length, 2, 'tier 3 (5+ workers) puffs every 140 ms');
    assert.equal(spawned.filter((s) => s[4].tag === 'chimney:watchtower:cottage').length, 1, 'tier 1 (1 worker) waits 420 ms');
});

test('4. LandmarkActivity draws ground stamps at zoom 1–2 while gating plates, and refreshes TTL on arrival', (t) => {
    const world = {
        buildings: new Map([
            ['forge', { position: { tileX: 26, tileY: 26 }, width: 4, height: 3, entrance: { tileX: 28, tileY: 29 }, containsPoint: (x, y) => x >= 26 && x <= 30 && y >= 26 && y <= 29 }],
            ['taskboard', { position: { tileX: 23, tileY: 32 }, width: 4, height: 3, entrance: { tileX: 25, tileY: 35 }, containsPoint: () => false }],
            ['command', { position: { tileX: 13, tileY: 14 }, width: 5, height: 4, entrance: { tileX: 15, tileY: 18 }, containsPoint: () => false }],
        ]),
    };
    const activity = new LandmarkActivity({ world });
    t.after(() => activity.dispose());

    const agent = {
        id: 'smith-1',
        currentTool: 'Edit',
        currentToolInput: 'src/app.js',
        targetBuildingType: 'forge',
        lastSessionActivity: 't1',
    };
    const t0 = 100_000;
    const walkingSprite = { agent, x: 0, y: 0, moving: true };
    activity.reconcile([agent], [walkingSprite], t0);
    const [billet] = [...activity.items.values()].filter((item) => item.type === 'forge');
    assert.ok(billet, 'forge billet created');
    const initialExpiry = billet.expiresAt;

    // Ground stamp draws even when _chitsVisible is false (zoom 1–2); text plate stays suppressed.
    const ctx = recCtx();
    let plateDraws = 0;
    const rendererStub = {
        _zoom: 1,
        _chitsVisible: () => false,
        _drawInstrumentPlate: () => { plateDraws++; return true; },
    };
    activity.draw(ctx, { payload: { ...billet, x: 50, y: 50, alpha: 1 } }, 1, rendererStub, null);
    assert.ok(ctx.fills.length > 0, 'forge billet stamp draws at zoom 1');
    assert.equal(plateDraws, 0, 'text plate stays gated at zoom 1');

    // Arrival at Forge refreshes TTL so the billet stays visible after a long walk.
    const forgePos = tileToWorld(27, 27);
    const arrivedSprite = { agent, x: forgePos.x, y: forgePos.y, moving: false };
    activity.reconcile([agent], [arrivedSprite], t0 + 15_000);
    assert.ok(billet.expiresAt > initialExpiry, 'TTL refreshed upon arrival at Forge');
    assert.equal(billet.arrivedRefreshed, true);
});

test('4 & 5. Persistent Archive/Portal/Command rituals, Mine outer-rail cart, and static Harbor crates', () => {
    const gates = new BuildingPartGates();
    gates.update({
        workingIdsByType: new Map([
            ['archive', new Set(['r1'])],
            ['portal', new Set(['p1'])],
            ['command', new Set(['c1'])],
            ['mine', new Set(['m1'])],
        ]),
    });
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        partGates: gates,
        motionScale: 1,
        frame: 0,
        assets: { get: () => null },
        _partClockMs: () => 600,
        _ritualsFor: () => [],
        _overlayLightGrade: () => null,
        _watchtowerActiveCount: () => 3,
        _buildingActivityInfo: () => ({ intensity: 0.7, occupancy: { ratio: 0.7 }, alert: false }),
        harborStatus: { failedPushActive: false },
    });

    const archiveCtx = recCtx();
    renderer._drawArchiveRitual(archiveCtx, { x: 100, y: 100 }, null);
    assert.ok(archiveCtx.fills.length > 0, 'Archive turning folio stays raised while work.archive is open');

    const portalCtx = recCtx();
    renderer._drawPortalRitual(portalCtx, { x: 100, y: 100 }, null);
    assert.ok(portalCtx.fills.length > 0, 'Portal 3-ring dot aura stays active while work.portal is open');

    const cmdCtx = recCtx();
    renderer._drawCommandRitual(cmdCtx, (x, y) => ({ x, y }));
    assert.ok(cmdCtx.fills.length > 0, 'Command gold standard stays raised while work.command is open');

    const mineCtx = recCtx();
    const rail = { railA: { x: 77, y: 194 }, railB: { x: 47, y: 209 }, railLen: 33.54, ux: -0.894, uy: 0.447 };
    renderer._drawMineRitual(mineCtx, { x: 76, y: 186 }, rail, null);
    assert.ok(mineCtx.fills.length > 0, 'Mine parks loaded ore cart on outer rail while work.mine is open');

    // Harbor cargo crates are strictly static across frames (no sine bob).
    const harborCtxA = recCtx();
    renderer.frame = 0;
    renderer._drawHarborActivityMarkers(harborCtxA, { x: 140, y: 205 }, { type: 'harbor' }, null);
    const harborCtxB = recCtx();
    renderer.frame = 17;
    renderer._drawHarborActivityMarkers(harborCtxB, { x: 140, y: 205 }, { type: 'harbor' }, null);
    assert.ok(harborCtxA.fills.length > 0);
    assert.deepEqual(
        harborCtxA.fills.map((f) => [f.x, f.y, f.w, f.h]),
        harborCtxB.fills.map((f) => [f.x, f.y, f.w, f.h]),
        'Harbor cargo crates never bob across frames',
    );
});

test('6. Command aperture legend counts working and waiting from _inspectionSessions, not folded room slots', () => {
    const model = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [
            { agentId: 'marshal', name: 'Marshal', tool: 'spawn agent', status: 'working', working: true, waiting: false },
            { agentId: 'courier', name: 'Courier', tool: 'message', status: 'working', working: true, waiting: false },
            { agentId: 'ledger', name: 'Ledger', tool: null, status: 'waiting_on_user', working: false, waiting: true },
        ],
    });
    assert.equal(model.workingCount, 2);
    assert.equal(model.waitingCount, 1);

    // Even when _roomSlotsByType has 0 folded workers, legend prints "2 working · 1 waiting".
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        _zoom: 2,
        _roomSlotsByType: new Map([['command', { working: 0, waiting: 1 }]]),
    });
    const ctx = recCtx();
    const profile = BUILDING_VISUAL_REGISTRY.command.aperture;
    renderer._drawApertureLegend(ctx, (x, y) => ({ x, y }), { type: 'command' }, model, profile);
    assert.equal(ctx.texts[0]?.text, '2 working · 1 waiting');
});
