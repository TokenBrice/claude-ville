import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import {
    DISTRICT_PROPS,
    GULL_BANK_FRAME,
    GULL_FLIGHT_FRAMES,
    GULL_LIGHTHOUSE_HOTSPOT,
    GULL_OFFMAP_GATEWAYS,
    GULL_ROUTE_SPEED_SCALE,
    GULL_STAGING_WAYPOINTS,
    LAND_BIRD_ROUTES,
    LIVESTOCK_ROUTES,
    DEER_DAWN_ROUTE,
    CALM_WATER_FAUNA,
    HERON_SHALLOWS,
    SHORE_FAUNA,
    MARINE_FISH_SCHOOLS,
    OPEN_SEA_FLOCK_FORMATION,
    OPEN_SEA_FLOCK_ROUTES,
    WATCHTOWER_GULL_ORBIT,
    WORLD_TREE,
} from '../../config/scenery.js';
import { fireflyGroundTiles } from './AmbientGround.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { ornamentPlan, readCalmGateOverride, sampleFramePressure } from './MarkGovernor.js';
import { DRAGONFLY_POOL_MAX } from './ParticleSystem.js';
import { buildingCenterToWorld } from './Projection.js';
import { monthIndexForAtmosphere, seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { seasonShiftFor } from './AtmosphereState.js';
import { ambientEventProgress, dayPartBeatLive } from './AmbientEvents.js';
import { squallApproach } from './CoastBake.js';

// 6.7 — the ambient-life budget (output/claudeville-opus55-aesthetic/
// weather-life.md). One flock wave of gulls is the whole pool; 4–10 of them
// are on a crossing at once (6–8 at dawn and dusk, ×0.3 in rain), and only the
// few nearest the middle of the view are drawn: 8 at the wide shot, 5 at z2,
// 3 from z3. A storm grounds them on their roosts; from nightfall to sunrise
// the flock sleeps on the roosts and only the lighthouse gull flies, until the
// W6.8 dawn-rise beat lifts the sleepers in one wave; reduced motion shows the
// roosts alone. The birds answer to the time of day and the village's own
// weather only — never to a push, a release or any other agent event (V3).
const GULL_POPULATION = OPEN_SEA_FLOCK_ROUTES.reduce((sum, flock) => sum + flock.size, 0);
const GULL_ACTIVE_DAY = Object.freeze([4, 10]);
const GULL_ACTIVE_TWILIGHT = Object.freeze([6, 8]);
const GULL_RAIN_SCALE = 0.3;
// The lanes: one pool gull per lane per crossing, so never more aloft.
const GULL_LANE_COUNT = Math.max(...GULL_ACTIVE_DAY, ...GULL_ACTIVE_TWILIGHT);
// W6.4 — the flying band walks toward its target one bird per
// GULL_BAND_STEP_MS (never a burst), and a lane only joins or leaves between
// crossings or while its bird is out of view, so no gull pops in or out on
// screen. While the forecast squall is on the sea the target is the whole
// upper band and the flock wheels inland (GULL_INLAND_PULL of the way toward
// the island's heart, circling GULL_WHEEL_TILES wide, eased over
// GULL_INLAND_MS); once the rain starts it drops to the rain band, each
// grounded bird taking a roost; it all reverses as the rain clears.
const GULL_BAND_STEP_MS = 6000;
const GULL_INLAND_MS = 30000;
const GULL_INLAND_PULL = 0.32;
const GULL_WHEEL_TILES = 1.1;
const GULL_WHEEL_RATE = 0.14;
// W6.2 — the scheduled `gull-fishing-run` (AmbientEvents, frequent tier):
// one gull of an always-flying lane peels off over FISHING_BLEND of the run,
// flies FISHING_TURNS slow, tightening circuits of open water FISHING_ORBIT
// tiles wide, folds into one dive over FISHING_DIVE of the circuit, climbs
// and rejoins its lane.
const FISHING_BLEND = 0.14;
const FISHING_TURNS = 1.15;
const FISHING_ORBIT = 1.5;
const FISHING_DIVE = Object.freeze([0.44, 0.6]);
const FISHING_SEARCH_TILES = 8;
// AW-P8a — dragonflies over the lily-pad clusters on summer days (Jun–Aug),
// by day, out of rain: 2 at the wide shot, 3 from z2, 4 from z3, on the
// particle system's own dragonfly pool (never the shared 240 cap). One joins
// every DRAGONFLY_SPAWN_GAP_MS; shed with the fauna cadence under frame
// pressure; held still under reduced motion.
export const DRAGONFLY_ZOOM_CAPS = Object.freeze([[3, 4], [2, 3], [0, 2]]);
const DRAGONFLY_SPAWN_GAP_MS = 1800;
const LILY_CLUSTER_TILES = 1.6;
// Songbirds: one at the wide shot (W6.1: the user's resting zoom), 2 at z2,
// 3 from z3; none in rain, storm or at night, and they settle into the
// trees once the forecast squall is on the sea (W6.4); one perched bird
// under reduced motion.
export const SONGBIRD_ZOOM_CAPS = Object.freeze([[3, 3], [2, 2], [0.9, 1]]);
// Fireflies: Apr–Oct, dusk and night, clear air, on fixed grass homes near
// water. Twelve at the wide shot and z2, sixteen from z3. Their 2 s blink
// holds a dim course around a longer core + halo course; all light is drawn
// after the grade. Drift and blink use only the stepped motion clock.
const FIREFLY_HOMES = 48;
export const FIREFLY_ZOOM_CAPS = Object.freeze([[3, 16], [2, 12], [0.9, 12]]);
const FIREFLY_CYCLE_MS = 2000;
const FIREFLY_ON_MS = 1400;
const FIREFLY_CORE = '#e4d594';
const FIREFLY_HALO = '#9e9155';
const FIREFLY_OUTER = '#57553a';
// Twelve year-round ash spirits: eight at the roots, four rising softly
// through the trunk/canopy band. Fixed homes, 250 ms steps and a 6 s blink.
const ASH_MOTE_COUNT = 12;
const ASH_MOTE_CORE = '#d1e3d8';
const ASH_MOTE_HALO = '#729e94';
const ASH_MOTE_OUTER = '#3e625e';
const ASH_MOTE_DIM = '#91b8aa';
// W6.4 — ducks paddle for cover (the root and lily margins of their own
// water) while a squall approaches and through the rain, then back out;
// a storm still sends them in. One per CALM_WATER_FAUNA entry; every home,
// cover point and the path between them stays on water tiles that are not
// bridge deck (the tiles `drawWaterfowl` draws a duck on), so no duck
// vanishes on the way in or out.
const DUCK_COVER = Object.freeze([
    Object.freeze({ tileX: 14.75, tileY: 23.15 }),
    Object.freeze({ tileX: 16.7, tileY: 21.3 }),
    Object.freeze({ tileX: 12.9, tileY: 8.75 }),
    Object.freeze({ tileX: 13.6, tileY: 8.95 }),
]);
const DUCK_COVER_MS = 40000;
// W6.5 (AW-P4) — fauna journeys. Ducks swim home and up their bank through
// DUCK_HOMING (a span of dusk's progress) and back out through DUCK_WAKING
// (of dawn's), read off the atmosphere clock so a pinned or skipped hour
// lands them where that hour has them; a dabble beat tips two ducks of one
// basin head-under in some DABBLE_WINDOW_MS windows. Rows of the duck art:
// the head above DUCK_HEAD_ROW, the reflection from DUCK_WATERLINE_ROW down
// (cropped on land).
const DUCK_HOMING = Object.freeze([0.3, 0.7]);
const DUCK_WAKING = Object.freeze([0.3, 0.8]);
const DABBLE_WINDOW_MS = 90000;
const DABBLE_MS = 2400;
const DABBLE_PAIRS = Object.freeze([[0, 1], [2, 3]]);
const DUCK_HEAD_ROW = 15;
const DUCK_WATERLINE_ROW = 24;
// A heron hop: take-off to landing, scaled by the hop's length, to a free
// shallow within HERON_HOP_REACH tiles (else the nearest), with two
// wingbeats over its first half, then a glide in. The stab-and-swallow beat
// is three 120 ms frames of the neck rows (above HERON_NECK_ROW) dipped
// forward, at the middle of its stay (C4 Minor, no residue).
const HERON_HOP_MS = Object.freeze([1800, 4200]);
const HERON_HOP_REACH = 5;
const HERON_STAB_FRAME_MS = 120;
const HERON_STAB_DIP = Object.freeze([[0, 1], [-1, 2], [0, 1]]);
const HERON_NECK_ROW = 15;
// The heron in flight, at the standing art's scale (hand-authored, facing
// left like it; mirrored to fly right): dagger bill, head drawn back on the
// S-neck with its pouch under the chest, legs trailing past the tail, pale
// grey coverts against black flight feathers so it reads over the lagoon.
// 0 wings up, 1 wings down, 2 glide. d dark, m mid, l light, h pale,
// w highlight, b bill — the standing heron's own ramp. Its back row (the
// bill's) flies HERON_FLIGHT_LIFT px above the ground point, where the
// standing heron carries its body, so take-off and landing do not jump.
const HERON_FLIGHT_TONES = Object.freeze({ d: '#1b1834', m: '#374a69', l: '#6a839e', h: '#9bb0c5', w: '#c0d3e9', b: '#cb866d' });
const HERON_FLIGHT_FRAMES = Object.freeze([
    Object.freeze([
        '........................d.d.d.....',
        '......................ddddddd.....',
        '.....................dddddddd.....',
        '....................dhhdddd.......',
        '...................dhhhhddd.......',
        '..................dhhhhhhdd.......',
        '.................dhwhhhhld........',
        '................dhwhhhhld.........',
        '...............dhwhhhhld..........',
        '..............dhwhhhhld...........',
        '.............dhwhhhhlld...........',
        '.....dd.....dlhhhhllmd............',
        '....dmlmd..dlhhhhlmmd.............',
        'bbbbbdmmmmmmmlllmmmmmmmmd.........',
        '......dddmmmmmmmmmmmmmmmmmdddddddd',
        '........dmmmmmmmmmmmmmmmmdd....d.d',
        '.........dmmd.ddddddddddd.........',
        '..........dd......................',
    ]),
    Object.freeze([
        '.....dd...........................',
        '....dmlmd.........................',
        'bbbbbdmmmmmmmlllmmmmmmmmd.........',
        '......dddmmmhhhhhhhhmmmmmmdddddddd',
        '........dmhhwwhhhhhllmmmmdd....d.d',
        '.........dlhwhhhhhhldddddd........',
        '..........dlhwhhhhhld.............',
        '...........dlhhhhhhld.............',
        '............dlhhhhhd..............',
        '.............dlhhhdd..............',
        '..............ddddd...............',
        '..............ddddd...............',
        '...............d.d.d..............',
    ]),
    // 2 glide: both wings held spread and swept back from the shoulder, the
    // far wing rising over the back and the nearer, larger one below the
    // body, each pale coverts leading and black flight feathers trailing,
    // the hands drooping a texel at the tips; the head held back on the
    // S-neck with its pouch under the chest as in 0/1.
    Object.freeze([
        '...................dddd...........',
        '..................dmmmdd..........',
        '.................dhhmmd...........',
        '.....dd.........dhhhmmd...........',
        '....dmlmd.....ddhwhhmmd...........',
        'bbbbbdmmmmmmddhwhhhmmmmmd.........',
        '......dddmmmmhwwhhhmmmmmmmdddddddd',
        '........dmmmmdhwhhhhmmmmmdd....d.d',
        '.........dmmd.dhwhhhhmmd..........',
        '..........dd...dlhhhhmmd..........',
        '................dlhhhmmd..........',
        '.................dllhmmd..........',
        '..................dmmmdd..........',
        '..................dd.d.d..........',
    ]),
]);
const HERON_FLIGHT_BACK_ROWS = Object.freeze(HERON_FLIGHT_FRAMES.map(rows => rows.findIndex(row => row.includes('b'))));
const HERON_FLIGHT_LIFT = 20;
const HERON_SHADOW = 'rgba(7, 18, 30, 0.26)';
// Fish scatter for FISH_SCATTER_MS when a gull's fishing dive passes within
// FISH_DIVE_REACH tiles or a git ship under way within FISH_WAKE_REACH world
// px: the school splits and sinks (dimmer), then gathers again.
const FISH_SCATTER_MS = 3000;
const FISH_DIVE_REACH = 2.5;
const FISH_WAKE_REACH = 56;
// Roost points (sprite-local px of the building art, feet on the perch): the
// lighthouse's seaward merlon and three pile tops of the harbor piers.
const GULL_ROOSTS = Object.freeze([
    Object.freeze({ building: 'watchtower', at: [174, 79], facing: -1 }),
    Object.freeze({ building: 'harbor', at: [64, 173], facing: 1 }),
    Object.freeze({ building: 'harbor', at: [150, 185], facing: -1 }),
    Object.freeze({ building: 'harbor', at: [122, 212], facing: 1 }),
]);
const GULL_PERCH_FRAME = 'prop.gullPerch';
// W6.8 — the dawn-rise beat (AmbientEvents.DAY_PART_BEATS, opened at the
// grade's sunrise key with its season shift): the sleeping roost gulls lift
// once, one after another DAWN_WAVE_STAGGER_MS apart (plus up to
// DAWN_WAVE_JITTER_MS), climbing DAWN_WAVE_ALTITUDE px over the first
// DAWN_WAVE_CLIMB of the flight and gliding DAWN_WAVE_REACH tiles out from
// the island's heart at DAWN_WAVE_SPEED tiles a second: far enough to leave
// even the widest view, so no bird vanishes on screen (they are not culled
// at the map rim). A beat already open on the first frame flies no wave.
const DAWN_SUNRISE_KEY_MINUTE = 6 * 60;
const DAWN_WAVE_STAGGER_MS = 1100;
const DAWN_WAVE_JITTER_MS = 450;
const DAWN_WAVE_ALTITUDE = 24;
const DAWN_WAVE_CLIMB = 0.3;
const DAWN_WAVE_REACH = 26;
const DAWN_WAVE_SPEED = 1.8;
const DAWN_WAVE_FLIGHT_MS = DAWN_WAVE_REACH / DAWN_WAVE_SPEED * 1000;
const DAWN_WAVE_SPAN_MS = 3 * DAWN_WAVE_STAGGER_MS + DAWN_WAVE_JITTER_MS + DAWN_WAVE_FLIGHT_MS;
// Grade tint cache: one tinted canvas per (frame, grade bucket), rebuilt only
// when the bucket moves. A bucket is the grade's response to three probe
// colours at 1/32 steps, so it follows every term of the grade that shows.
const GRADE_PROBES = Object.freeze([[0.92, 0.94, 0.95], [0.5, 0.5, 0.5], [0.45, 0.62, 0.8]]);
const GULL_SHADOW = 'rgba(7, 18, 30, 0.22)';
const SONGBIRD_SHADOW = 'rgba(0, 0, 0, 0.16)';
// W8.4a (AD-P11 / AW-P15) — the livestock region: cow, sheep and goat in
// the paddock, two hens before it, a dog at the Forge front and a cat on
// the Archive plaza (LIVESTOCK_ROUTES), plus the `deer-at-dawn` stag. Each
// is a small 4-direction sheet (FAUNA_SHEET_ROWS × stand + 4 walk columns,
// `frameW`/`frameH` cells; the hen is one side-view row, mirrored) read by
// `faunaSheetFrame`, never the 8 × 10 character contract. Caps by zoom like
// the songbirds: 7 from z2, 5 from z1.4, 3 from z0.9, the paddock pair at
// the whole-island view. They answer to the clock and the village's
// weather only (V3): walking stops at night (the cat still prowls), in
// rain and storm, under frame pressure (the fauna cadence) and under
// reduced motion, holding the standing frame where they are; the hens and
// the dog go in at night and in the wet, fading over LIVESTOCK_AWAY_MS.
export const LIVESTOCK_ZOOM_CAPS = Object.freeze([[2, 7], [1.4, 5], [0.9, 3], [0, 2]]);
export const FAUNA_SHEET_ROWS = Object.freeze(['south', 'east', 'north', 'west']);
const LIVESTOCK_AWAY_MS = 8000;
const LIVESTOCK_SHADOW = 'rgba(0, 0, 0, 0.16)';
// Walk cadence: frames per second scale with speed (a trot is quicker).
const LIVESTOCK_FPS_PER_TILE_S = 26;
const LIVESTOCK_FPS = Object.freeze([4, 10]);
// A hen pecks for HEN_PECK_S once every HEN_PECK_EVERY_S while it stands.
const HEN_PECK_EVERY_S = 2.6;
const HEN_PECK_S = 0.45;
// The stag: out to its grazing point over DEER_WALK of the event, back
// over the last DEER_WALK; it turns to face the meadow at mid-graze, and
// fades in and out in DEER_FADE_STEPS over DEER_FADE of the event.
const DEER_WALK = 0.2;
const DEER_FADE = 0.06;
const DEER_FADE_STEPS = 4;

const WILDLIFE_SCENE_ITEMS = Object.freeze([
    Object.freeze({
        sourceCategory: 'wildlife',
        stableKey: 'wildlife:ground-and-air',
        sortY: -1000000,
    }),
]);

// Wildlife is world detail rather than an occluder. Keeping the
// whole layer overlay-safe lets the Canvas fallback retain its original early
// draw order while the direct GPU island replays it on the transparent overlay.
export const WILDLIFE_SCENE_CATEGORY = Object.freeze({
    id: 'wildlife',
    sortBand: 40,
    enumerate({ renderer } = {}) {
        return renderer?.wildlifeRenderer ? WILDLIFE_SCENE_ITEMS : [];
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        const wildlife = context.renderer?.wildlifeRenderer;
        wildlife?.drawSceneLayer?.(ctx, context.renderNow);
    },
    unsupported: 'overlay-safe',
    overlayBand: 40,
});

// Owns fauna animation state. The host supplies stable world classifiers,
// culling, renderer services, and the live frame/motion values.
export class WildlifeRenderer {
    constructor(host) {
        this.host = host;
        this.openSeaFlockBirds = this._buildOpenSeaFlockBirds();
        this._landBirdRoutes = null;
        this._landBirdLastNow = 0;
        this._sceneFrameToken = null;
        this._sceneFrameNow = 0;
        this._visibleGullIds = new Set();
        this._visibleFireflyIds = new Set();
        this._fireflyHomes = null;
        this._roosts = null;
        this._tintGrade = null;
        this._tintKey = '';
        this._tintCache = new Map();
        // Last frame's gull budget, for diagnostics and capture tooling.
        this.lastGullStats = { pool: GULL_POPULATION, active: 0, visible: 0, cap: 0, roosting: 0, rising: 0, lighthouse: 0, mode: 'idle', band: [0, 0], fishing: 0 };
        // W6.4 — the flying band now ([always-flying lanes, flying lanes]),
        // each lane's fly decision for its current crossing, and the share
        // of the way the flock has wheeled inland.
        this._gullBand = [0, 0];
        this._gullBandAt = 0;
        this._gullLaneStates = Array.from({ length: GULL_LANE_COUNT }, () => ({ cycle: NaN, fly: false }));
        this._gullInland = 0;
        this._gullInlandAt = 0;
        this._islandHeartTile = null;
        // W6.2 — the gull-fishing-run being flown (planned once per event).
        this._fishing = null;
        // W6.8 — the dawn-rise beat as last seen (null before the first
        // frame), when its lift-off wave began, and each roost's way out.
        this._dawnRise = { live: null, startAt: 0 };
        this._dawnAways = new Map();
        // AW-P8a — lily-cluster homes, spawn pacing, the graded body colours.
        this._dragonflyHomes = null;
        this._dragonflySpawnAt = 0;
        this._dragonflySerial = 0;
        this._dragonflyBudget = { cap: 0, reason: null };
        this._gradedColors = new Map();
        // W6.4 — ducks' share of the way to cover (0 home, 1 in cover).
        this._duckCover = 0;
        this._duckCoverAt = 0;
        // W6.5 — each school's scatter (until, and the tile direction away).
        this._fishScatter = MARINE_FISH_SCHOOLS.map(() => ({ until: 0, awayX: 0, awayY: 0 }));
        this._point = { tileX: 0, tileY: 0 };
        this._heronPose = { tileX: 0, tileY: 0, altitude: 0, flying: false, frame: 0, facing: -1, stab: -1 };
        // W0.2 — what the last frame drew, and the budgets it drew under.
        this._drawn = { songbirds: 0, fireflies: 0, ashMotes: 0, ducks: 0, herons: 0, fish: 0, dragonflies: 0, livestock: 0, deer: 0 };
        this._songbirdBudget = { cap: 0, reason: null };
        this._fireflyBudget = { cap: 0, reason: null };
        this._ashMoteBudget = { cap: 0, reason: null };
        this._songbirdsSettling = false;
        // W8.4a — each livestock actor's own walk clock (ms; it runs only
        // while that actor may walk), the eased away shares (0 out, 1 in) and
        // the reused per-frame records.
        this._livestockClocks = null;
        this._livestockAt = 0;
        this._livestockAwayNight = 0;
        this._livestockAwayWet = 0;
        this._livestockBudget = { cap: 0, reason: null, walking: false };
        this._livestockPoses = LIVESTOCK_ROUTES.map(() => ({ tileX: 0, tileY: 0, walking: false, dir: 'south', frame: 0, alpha: 1, x: 0, y: 0, route: null }));
        this._livestockOrder = [];
        this._deerPose = { tileX: 0, tileY: 0, walking: false, dir: 'east', frame: 0, alpha: 1 };
        this._faunaCell = { sx: 0, sy: 0, sw: 0, sh: 0, mirror: false };
    }

    drawSceneLayer(ctx, frameToken = null) {
        if (this._sceneFrameToken !== frameToken) {
            this._sceneFrameToken = frameToken;
            this._sceneFrameNow = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
        }
        // The resident overlay is ungraded, so fauna drawn there wears the C2
        // grade through cached tinted frames; the Canvas world pass is graded
        // after the fact and draws the authored art. Fireflies are light: they
        // never enter the graded Canvas pass (WorldFrameRenderer draws them on
        // the overlay after the grade instead).
        const overlay = ctx === this.host.overlayCtx;
        this._prepareTint(overlay ? this.host._lastAtmosphere?.lightGrade : null);
        this.drawFishSchools(ctx);
        this.drawWaterfowl(ctx);
        this.drawLivestock(ctx);
        this.drawDragonflies(ctx);
        if (overlay) this.drawFireflies(ctx, this._sceneFrameNow);
        this.drawOpenSeaGulls(ctx);
        this.drawLandBirds(ctx, this._sceneFrameNow);
    }

    drawFishSchools(ctx) {
        this._drawn.fish = 0;
        if (!this.host.motionScale || !this.host.sprites || !MARINE_FISH_SCHOOLS.length) return;
        const visible = this.host._getVisibleTileBounds(2);
        const motionMs = Number(this.host.motionTimeMs) || 0;
        const now = this._sceneFrameNow || 0;
        const point = this._point;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let index = 0; index < MARINE_FISH_SCHOOLS.length && index < 12; index++) {
            const fish = MARINE_FISH_SCHOOLS[index];
            fishSchoolPoint(fish, motionMs, point);
            const baseX = Math.floor(point.tileX);
            const baseY = Math.floor(point.tileY);
            if (baseX < visible.startX || baseX > visible.endX || baseY < visible.startY || baseY > visible.endY) continue;
            if (!this._isFishTile(baseX, baseY)) continue;
            if (this._isHarborLabelZone(baseX, baseY)) continue;
            const scatter = this._fishScatter[index];
            if (now >= scatter.until) this._fishDisturbance(point, scatter, now);
            let tileX = point.tileX;
            let tileY = point.tileY;
            let split = 0;
            let alpha = 0.48;
            const left = scatter.until - now;
            if (left > 0) {
                // Dart away over 400 ms, drift back over the rest (whole texels).
                const elapsed = FISH_SCATTER_MS - left;
                const reach = 0.6 * (elapsed < 400 ? elapsed / 400 : 1 - (elapsed - 400) / (FISH_SCATTER_MS - 400));
                const awayX = tileX + scatter.awayX * reach;
                const awayY = tileY + scatter.awayY * reach;
                if (this._isFishTile(Math.floor(awayX), Math.floor(awayY))) {
                    tileX = awayX;
                    tileY = awayY;
                }
                split = Math.round(reach * 7);
                alpha = elapsed < 2000 ? 0.26 : 0.38;
            }
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            if (split > 0) {
                // The school splits: its two halves part by `split` texels.
                const half = (this.host.assets?.get?.(fish.id)?.width | 0) >> 1;
                this._drawFaunaPart(ctx, fish.id, x, y, 0, 0, half, 0, -split, 0, alpha);
                this._drawFaunaPart(ctx, fish.id, x, y, half, 0, half, 0, split, 0, alpha);
            } else {
                this._drawFauna(ctx, fish.id, x, y, alpha);
            }
            this._drawn.fish++;
        }
        ctx.restore();
    }

    // A school swims in lagoon or shallow water, never on bridge deck.
    _isFishTile(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        const isLagoon = this.host.lagoonWaterTiles?.has(key);
        return this.host.waterTiles.has(key)
            && !(this.host.deepWaterTiles.has(key) && !isLagoon)
            && !this.host.bridgeTiles?.has(key);
    }

    // W6.5 — start a scatter when the run gull's dive or a git ship under
    // way (its wake) crosses the school; the school darts directly away.
    _fishDisturbance(point, scatter, now) {
        let fromX = NaN;
        let fromY = NaN;
        const run = this._fishing;
        if (run?.diving && Math.hypot(run.diveTileX - point.tileX, run.diveTileY - point.tileY) <= FISH_DIVE_REACH) {
            fromX = run.diveTileX;
            fromY = run.diveTileY;
        } else {
            const traffic = this.host.harborTraffic;
            const ships = traffic?.state?.ships;
            if (ships?.size && typeof traffic._shipUnderWay === 'function') {
                const wx = (point.tileX - point.tileY) * TILE_WIDTH / 2;
                const wy = (point.tileX + point.tileY) * TILE_HEIGHT / 2;
                for (const ship of ships.values()) {
                    if (!Number.isFinite(ship?.x) || !Number.isFinite(ship?.y)) continue;
                    if (Math.hypot(ship.x - wx, ship.y - wy) > FISH_WAKE_REACH || !traffic._shipUnderWay(ship)) continue;
                    // World px back to a tile offset (the inverse projection).
                    fromX = point.tileX + ((ship.x - wx) / (TILE_WIDTH / 2) + (ship.y - wy) / (TILE_HEIGHT / 2)) / 2;
                    fromY = point.tileY + ((ship.y - wy) / (TILE_HEIGHT / 2) - (ship.x - wx) / (TILE_WIDTH / 2)) / 2;
                    break;
                }
            }
        }
        if (!Number.isFinite(fromX)) return;
        const dx = point.tileX - fromX;
        const dy = point.tileY - fromY;
        const length = Math.hypot(dx, dy) || 1;
        scatter.until = now + FISH_SCATTER_MS;
        scatter.awayX = length > 0.01 ? dx / length : 1;
        scatter.awayY = length > 0.01 ? dy / length : 0;
    }

    // Calm-water ducks + shoreline herons. W6.5: by day each duck paddles its
    // loop; at dusk it swims home and up its bank, sleeping there through the
    // night (head tucked), back out at dawn; now and then two ducks of one
    // basin dabble head-under. Herons stand on their shallow; an occasional
    // `heron-relocation` flies one to a free shallow and back, with a rare
    // stab at the water while it stays. W6.4: while a squall approaches and
    // through the rain the ducks paddle to cover and back out once it
    // clears; a storm sends them in. Reduced motion freezes all of it (the
    // motion clock stops, the shares snap, no event is live). Every step's
    // tile is checked: water that is not bridge deck, or the duck's bank.
    drawWaterfowl(ctx) {
        this._drawn.ducks = 0;
        this._drawn.herons = 0;
        if (!this.host.sprites) return;
        const visible = this.host._getVisibleTileBounds(2);
        const storm = this._weatherType() === 'storm';
        const cover = this._duckCoverShare();
        const ashore = this._duckAshoreShare();
        const motionMs = Number(this.host.motionTimeMs) || 0;
        const sleeping = ashore >= 1 && this._phase() === 'night';
        const dabbling = cover <= 0 && ashore <= 0 && this.host.motionScale ? dabbleAt(motionMs) : null;
        const point = this._point;
        ctx.save();
        for (let index = 0; !storm && index < CALM_WATER_FAUNA.length; index++) {
            const duck = CALM_WATER_FAUNA[index];
            duckPoint(duck, index, { motionMs, cover, ashore }, point);
            const bx = Math.floor(point.tileX);
            const by = Math.floor(point.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            const key = `${bx},${by}`;
            const onWater = this.host.waterTiles.has(key) && !this.host.bridgeTiles?.has(key);
            const onBank = !onWater && ashore > 0 && duck.bank
                && bx === Math.floor(duck.bank.tileX) && by === Math.floor(duck.bank.tileY);
            if (!onWater && !onBank) continue;
            const x = (point.tileX - point.tileY) * TILE_WIDTH / 2;
            const y = (point.tileX + point.tileY) * TILE_HEIGHT / 2;
            const dip = dabbling && dabbling.ducks.includes(index) ? dabbling.dip[dabbling.ducks.indexOf(index)] : 0;
            if (onBank && sleeping) {
                // Asleep on the bank: body settled a texel, head on the back.
                this._drawFaunaPart(ctx, duck.id, x, y, 0, DUCK_HEAD_ROW, 0, DUCK_WATERLINE_ROW - DUCK_HEAD_ROW, 0, 1);
                this._drawFaunaPart(ctx, duck.id, x, y, 10, DUCK_HEAD_ROW - 4, 7, 4, 5, 4);
            } else if (onBank) {
                this._drawFaunaPart(ctx, duck.id, x, y, 0, 0, 0, DUCK_WATERLINE_ROW, 0, 0);
            } else if (dip > 0) {
                // Dabbling: tipped head-under, the body a texel lower.
                this._drawFaunaPart(ctx, duck.id, x, y, 0, DUCK_HEAD_ROW, 0, 0, 0, dip);
            } else {
                this._drawFauna(ctx, duck.id, x, y);
            }
            this._drawn.ducks++;
        }
        const event = this.host.ambientEvents?.occasional;
        const clock = this.host._lastAtmosphere?.effectiveDate?.getTime?.() ?? Date.now();
        const pose = this._heronPose;
        for (let index = 0; index < SHORE_FAUNA.length; index++) {
            const heron = SHORE_FAUNA[index];
            heronPose(index, event, clock, pose);
            const bx = Math.floor(pose.tileX);
            const by = Math.floor(pose.tileY);
            if (bx < visible.startX - 1 || bx > visible.endX + 1 || by < visible.startY - 1 || by > visible.endY + 1) continue;
            const gx = Math.round((pose.tileX - pose.tileY) * TILE_WIDTH / 2);
            const gy = Math.round((pose.tileX + pose.tileY) * TILE_HEIGHT / 2);
            if (pose.flying) {
                this._drawHeronFlight(ctx, gx, gy, pose);
                this._drawn.herons++;
                continue;
            }
            if (!this._isHeronTile(bx, by)) continue;
            const bob = this.host.motionScale ? Math.round(Math.sin(this.host.waterFrame * 0.4 + heron.tileX) * 0.5) : 0;
            if (pose.stab >= 0) {
                const [dx, dy] = HERON_STAB_DIP[pose.stab];
                this._drawFaunaPart(ctx, heron.id, gx, gy + bob, 0, 0, 0, HERON_NECK_ROW, dx, dy);
                this._drawFaunaPart(ctx, heron.id, gx, gy + bob, 0, HERON_NECK_ROW, 0, 0, 0, 0);
            } else {
                this._drawFauna(ctx, heron.id, gx, gy + bob);
            }
            this._drawn.herons++;
        }
        ctx.restore();
    }

    // A heron stands on a shore tile or shallow (not deep) water, never on
    // bridge deck.
    _isHeronTile(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        if (this.host.bridgeTiles?.has(key)) return false;
        if (this.host.waterTiles.has(key)) return !this.host.deepWaterTiles.has(key);
        return Boolean(this.host.shoreTiles?.has(key));
    }

    // The flying heron: its shadow on the ground point (narrowing as it
    // climbs) and the authored flight frame `altitude` above its standing
    // body height, mirrored to its heading.
    _drawHeronFlight(ctx, gx, gy, pose) {
        const half = Math.max(3, 7 - (pose.altitude >> 3));
        ctx.fillStyle = HERON_SHADOW;
        ctx.fillRect(gx - half, gy, half * 2, 1);
        ctx.fillRect(gx - half + 2, gy + 1, half * 2 - 4, 1);
        const rows = HERON_FLIGHT_FRAMES[pose.frame] || HERON_FLIGHT_FRAMES[0];
        const width = rows[0].length;
        const left = gx - (width >> 1);
        const top = Math.round(gy - HERON_FLIGHT_LIFT - pose.altitude) - (HERON_FLIGHT_BACK_ROWS[pose.frame] ?? HERON_FLIGHT_BACK_ROWS[0]);
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < width; c++) {
                const tone = HERON_FLIGHT_TONES[row[c]];
                if (!tone) continue;
                ctx.fillStyle = this._gradedColor(tone);
                ctx.fillRect(pose.facing > 0 ? left + width - 1 - c : left + c, top + r, 1, 1);
            }
        }
    }

    // Songbirds flitting on small looping flight paths between the trees of the
    // inhabited belt — the land analogue of the sea gulls. Wing frames cycle
    // when motion is on; under reduced motion one bird sits perched. The wide
    // shot's one bird flies the west or south-east loop first, away from the
    // Command plaza where the thought bubbles gather. W6.4: once the forecast
    // squall is on the sea each bird finishes its flutter, perches and stays
    // hidden in the trees until the weather clears.
    drawLandBirds(ctx, frameNow = null) {
        this._drawn.songbirds = 0;
        if (!this.host.sprites || !LAND_BIRD_ROUTES.length) return;
        const reduced = !this.host.motionScale;
        const weather = this.host._lastAtmosphere?.weather || null;
        const approach = squallApproach(weather);
        const budget = songbirdBudget({
            zoom: this._zoom(),
            weatherType: this._weatherType(),
            phase: this._phase(),
            motionScale: this.host.motionScale,
            approach,
        }, this._songbirdBudget);
        const settling = !reduced && approach && budget.reason === 'weather'
            && this._weatherType() !== 'rain' && this._weatherType() !== 'storm' && this._phase() !== 'night';
        this._songbirdsSettling = settling;
        const cap = settling ? zoomCap(SONGBIRD_ZOOM_CAPS, this._zoom()) : budget.cap;
        if (cap <= 0) return;
        if (!this._landBirdRoutes) {
            this._landBirdRoutes = LAND_BIRD_ROUTES.map((r) => ({
                route: this._normalizeGullRoute(r.points),
                speed: r.speed ?? 0.018,
                altitude: r.altitude ?? 26,
                phase: r.phase ?? 0,
                wingRate: r.wingRate ?? 6,
                // #39 — flutter-pause: songbirds flutter along the route, then
                // perch-hold for 1–3s at the route point before fluttering on.
                // `progress` advances only while fluttering; held position is
                // captured at the moment a perch begins. State seeds vary so the
                // three birds don't perch in unison.
                progress: (r.phase ?? 0) % 1,
                state: 'flutter',
                stateUntil: 0,
                perchProgress: (r.phase ?? 0) % 1,
            }));
        }
        const now = Number.isFinite(frameNow)
            ? frameNow
            : (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
        const dtMs = this._landBirdLastNow ? Math.max(0, Math.min(120, now - this._landBirdLastNow)) : 0;
        this._landBirdLastNow = now;
        const visible = this.host._getVisibleTileBounds(3);
        let drawn = 0;
        const birds = this._landBirdRoutes;
        const first = cap === 1 && birds.length > 1 ? 1 : 0;
        ctx.save();
        for (let n = 0; n < birds.length; n++) {
            const bird = birds[(first + n) % birds.length];
            if (drawn >= cap) break;
            if (!settling) bird.settled = false;
            if (bird.settled) continue;
            let progress;
            let perched;
            if (reduced) {
                // Reduced motion: a static perched bird, held at a
                // deterministic point on its route.
                progress = bird.phase % 1;
                perched = true;
            } else {
                if (now >= bird.stateUntil) {
                    if (bird.state === 'flutter') {
                        bird.state = 'perch';
                        bird.perchProgress = bird.progress;
                        bird.stateUntil = now + 1000 + this._gullUnitNoise(bird.phase * 17.3 + now * 0.0001) * 2000;
                    } else {
                        bird.state = 'flutter';
                        bird.stateUntil = now + 1400 + this._gullUnitNoise(bird.phase * 23.9 + now * 0.0002) * 2600;
                    }
                }
                if (bird.state === 'flutter') {
                    bird.progress = ((bird.progress + bird.speed * (dtMs / 16)) % 1 + 1) % 1;
                }
                progress = bird.state === 'perch' ? bird.perchProgress : bird.progress;
                perched = bird.state === 'perch';
                if (settling && perched) {
                    bird.settled = true;
                    continue;
                }
            }
            const p = this._pointOnGullRoute(bird.route, progress);
            const bx = Math.floor(p.tileX);
            const by = Math.floor(p.tileY);
            if (bx < visible.startX - 2 || bx > visible.endX + 2 || by < visible.startY - 2 || by > visible.endY + 2) continue;
            const gx = Math.round((p.tileX - p.tileY) * TILE_WIDTH / 2);
            const gy = Math.round((p.tileX + p.tileY) * TILE_HEIGHT / 2);
            ctx.fillStyle = SONGBIRD_SHADOW;
            ctx.fillRect(gx - 3, gy, 6, 1);
            ctx.fillRect(gx - 2, gy + 1, 4, 1);
            let frame = 'prop.songbird';
            if (!reduced && !perched) {
                const f = Math.floor(this.host.waterFrame * bird.wingRate + bird.phase * 11) % 4;
                frame = f === 0 ? 'prop.songbird.up' : f === 2 ? 'prop.songbird.down' : 'prop.songbird';
            }
            // Perched birds settle lower (drop the flight altitude toward a
            // rooftop sit) and use the level wings-folded frame.
            const altitude = perched ? bird.altitude * 0.18 : bird.altitude;
            this._drawFauna(ctx, frame, gx, gy - altitude);
            drawn++;
        }
        ctx.restore();
        this._drawn.songbirds = drawn;
    }

    // W8.4a — the livestock region (see LIVESTOCK_ZOOM_CAPS). Each actor's
    // walk clock runs only while it may walk, so a pause (night, rain,
    // pressure, reduced motion) holds it where it stands in its standing
    // frame, and the walk picks up from there. Drawn back to front.
    drawLivestock(ctx) {
        this._drawn.livestock = 0;
        this._drawn.deer = 0;
        const assets = this.host.assets;
        if (!this.host.sprites || !assets) return;
        const weatherType = this._weatherType();
        const phase = this._phase();
        const reduced = !(this.host.motionScale > 0);
        const budget = this._livestockCap();
        const now = this._sceneFrameNow || 0;
        const dtMs = this._livestockAt ? Math.max(0, Math.min(120, now - this._livestockAt)) : 0;
        this._livestockAt = now;
        const wet = weatherType === 'rain' || weatherType === 'storm';
        const night = phase === 'night';
        if (reduced) {
            this._livestockAwayWet = wet ? 1 : 0;
            this._livestockAwayNight = night ? 1 : 0;
        } else {
            const ease = dtMs / LIVESTOCK_AWAY_MS;
            this._livestockAwayWet = clamp(this._livestockAwayWet + (wet ? ease : -ease), 0, 1);
            this._livestockAwayNight = clamp(this._livestockAwayNight + (night ? ease : -ease), 0, 1);
        }
        if (!this._livestockClocks) {
            // Seeded from the atmosphere clock, so a pinned hour loads the same poses.
            const clock = this.host._lastAtmosphere?.effectiveDate?.getTime?.() || 0;
            this._livestockClocks = LIVESTOCK_ROUTES.map((_, index) => (reduced ? 0 : (clock + index * 7919) % 3600000));
        }
        const scale = Math.min(1, Number(this.host.motionScale) || 0);
        const order = this._livestockOrder;
        order.length = 0;
        const count = Math.min(budget.cap, LIVESTOCK_ROUTES.length);
        const visible = count > 0 ? this.host._getVisibleTileBounds(2) : null;
        for (let index = 0; index < LIVESTOCK_ROUTES.length; index++) {
            const route = LIVESTOCK_ROUTES[index];
            const walks = budget.walking || (budget.reason === 'night' && route.night === 'roam');
            if (walks) this._livestockClocks[index] += dtMs * scale;
            if (index >= count) continue;
            const away = Math.max(
                route.wet === 'away' ? this._livestockAwayWet : 0,
                route.night === 'away' ? this._livestockAwayNight : 0,
            );
            // Stepped fade in quarters: never a smooth ramp, never a pop.
            const alpha = Math.round((1 - away) * 4) / 4;
            if (alpha <= 0) continue;
            const pose = this._livestockPoses[index];
            livestockPose(route, reduced ? 0 : this._livestockClocks[index], { still: !walks }, pose);
            if (pose.tileX < visible.startX - 1 || pose.tileX > visible.endX + 1
                || pose.tileY < visible.startY - 1 || pose.tileY > visible.endY + 1) continue;
            pose.alpha = alpha;
            pose.route = route;
            pose.x = Math.round((pose.tileX - pose.tileY) * TILE_WIDTH / 2);
            pose.y = Math.round((pose.tileX + pose.tileY) * TILE_HEIGHT / 2);
            order.push(pose);
        }
        order.sort((a, b) => a.y - b.y || a.x - b.x);
        ctx.save();
        for (const pose of order) {
            if (this._drawFaunaCell(ctx, pose.route.sprite, pose.x, pose.y, pose)) this._drawn.livestock++;
        }
        this._drawDeer(ctx);
        ctx.restore();
    }

    _livestockCap() {
        return livestockBudget({
            zoom: this._zoom(),
            motionScale: this.host.motionScale,
            level: Number(sampleFramePressure()?.level) || 0,
            calm: readCalmGateOverride() === 'quiet',
            phase: this._phase(),
            weatherType: this._weatherType(),
        }, this._livestockBudget);
    }

    // AW-P15 — the `deer-at-dawn` stag, timed off the atmosphere clock like
    // the heron relocation; the scheduler holds it under reduced motion.
    _drawDeer(ctx) {
        const event = this.host.ambientEvents?.occasional;
        if (event?.kind !== 'deer-at-dawn' || !(this.host.motionScale > 0)) return;
        const clock = this.host._lastAtmosphere?.effectiveDate?.getTime?.() ?? Date.now();
        const progress = ambientEventProgress(event, clock);
        if (progress < 0) return;
        const pose = deerDawnPose(progress, (event.endMs - event.startMs) / 1000, this._deerPose);
        const visible = this.host._getVisibleTileBounds(2);
        if (pose.tileX < visible.startX - 1 || pose.tileX > visible.endX + 1
            || pose.tileY < visible.startY - 1 || pose.tileY > visible.endY + 1) return;
        const x = Math.round((pose.tileX - pose.tileY) * TILE_WIDTH / 2);
        const y = Math.round((pose.tileX + pose.tileY) * TILE_HEIGHT / 2);
        if (this._drawFaunaCell(ctx, DEER_DAWN_ROUTE.sprite, x, y, pose)) this._drawn.deer = 1;
    }

    // One cell of a fauna sheet (faunaSheetFrame) with its contact shadow,
    // through the tint cache; a one-row sheet faces east, mirrored for west.
    _drawFaunaCell(ctx, id, x, y, pose) {
        const assets = this.host.assets;
        const img = assets?.get?.(id);
        const cell = img ? faunaSheetFrame(assets.getEntry(id), pose.dir, pose.frame, img, this._faunaCell) : null;
        if (!cell) return false;
        const [ax, ay] = assets.getAnchor(id);
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * pose.alpha;
        const side = pose.dir === 'east' || pose.dir === 'west';
        const w = Math.max(4, Math.round(cell.sw * (side ? 0.5 : 0.28)));
        ctx.fillStyle = LIVESTOCK_SHADOW;
        ctx.fillRect(x - (w >> 1), y, w, 1);
        ctx.fillRect(x - (w >> 1) + 2, y + 1, w - 4, 1);
        const src = this._tinted(id, img);
        if (cell.mirror) {
            ctx.save();
            ctx.translate(x, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(src, cell.sx, cell.sy, cell.sw, cell.sh, -ax, y - ay, cell.sw, cell.sh);
            ctx.restore();
        } else {
            ctx.drawImage(src, cell.sx, cell.sy, cell.sw, cell.sh, x - ax, y - ay, cell.sw, cell.sh);
        }
        ctx.globalAlpha = prev;
        return true;
    }

    // 6.7 — fireflies: blinking pixel lights over grass near water. Each lives
    // around a fixed home tile (a deterministic spread over the whole map), so
    // panning reveals the same swarm instead of re-rolling it.
    drawFireflies(ctx, frameNow = null) {
        // Both backends call this after the grade, even outside firefly season.
        this.drawAshMotes(ctx);
        this._drawn.fireflies = 0;
        const cap = this._fireflyCap();
        if (cap <= 0) {
            this._visibleFireflyIds.clear();
            return;
        }
        const homes = this._fireflyHomeTiles();
        if (!homes.length) return;
        const now = Math.floor((Number(this.host.motionTimeMs) || 0) / 125) * 125;
        const view = this._viewCenter();
        const bounds = this.host._getVisibleTileBounds(1);
        const lit = [];
        for (let i = 0; i < homes.length; i++) {
            const home = homes[i];
            if (home.tileX < bounds.startX || home.tileX > bounds.endX || home.tileY < bounds.startY || home.tileY > bounds.endY) continue;
            const blink = (now + home.seed * FIREFLY_CYCLE_MS * 7) % FIREFLY_CYCLE_MS;
            lit.push({ i, home, blink, rank: (this._visibleFireflyIds.has(i) ? 0 : 1e9) + dist2(home, view) });
        }
        lit.sort((a, b) => a.rank - b.rank);
        this._visibleFireflyIds.clear();
        const count = Math.min(cap, lit.length);
        let drawn = 0;
        ctx.save();
        for (let n = 0; n < count; n++) {
            const { i, home, blink } = lit[n];
            this._visibleFireflyIds.add(i);
            if (blink >= FIREFLY_ON_MS) continue;
            const t = now * 0.0006 + home.seed * 40;
            const x = Math.round(home.x + Math.sin(t * 1.3) * 9);
            const y = Math.round(home.y - 6 + Math.sin(t * 0.9 + 1.7) * 3);
            // Two square-texel glow courses, never a blur or additive bloom.
            ctx.fillStyle = FIREFLY_OUTER;
            ctx.fillRect(x - 2, y, 5, 1);
            ctx.fillRect(x, y - 2, 1, 5);
            const halo = blink >= 250 && blink < FIREFLY_ON_MS - 250;
            if (halo) {
                ctx.fillStyle = FIREFLY_HALO;
                ctx.fillRect(x - 1, y - 1, 3, 3);
            }
            ctx.fillStyle = FIREFLY_CORE;
            ctx.fillRect(x, y, 1, 1);
            drawn++;
        }
        ctx.restore();
        this._drawn.fireflies = drawn;
    }

    drawAshMotes(ctx) {
        this._drawn.ashMotes = 0;
        const cap = ashMoteBudget({
            zoom: this._zoom(), phase: this._phase(), weatherType: this._weatherType(),
            motionScale: this.host.motionScale,
            level: Number(sampleFramePressure()?.level) || 0,
        }, this._ashMoteBudget).cap;
        if (!cap) return;
        const { centerX, centerY, radiusX, radiusY } = WORLD_TREE.islet;
        const bounds = this.host._getVisibleTileBounds(2);
        // Frozen MotionClock means a frozen position and blink, not a new
        // wall-clock phase when reduced motion is toggled.
        const time = Math.floor((Number(this.host.motionTimeMs) || 0) / 250) * 250;
        ctx.save();
        for (let i = 0; i < cap; i++) {
            const rising = i >= 8;
            const angle = i * Math.PI * 2 / (rising ? 4 : 8);
            const drift = time * 0.00012 + i * 2.3;
            const x = Math.round(centerX + Math.cos(angle) * radiusX * (rising ? 0.45 : 0.78) + Math.sin(drift) * 7);
            const y = Math.round(rising
                ? centerY - 70 - (i - 8) * 40 + Math.sin(drift * 0.75) * 18
                : centerY + Math.sin(angle) * radiusY * 0.65 - 12 + Math.cos(drift * 0.8) * 4);
            const tileX = (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2;
            const tileY = (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2;
            if (tileX < bounds.startX || tileX > bounds.endX || tileY < bounds.startY || tileY > bounds.endY) continue;
            const blink = (time + i * 875) % 6000;
            const bright = blink >= 1000 && blink < 4250;
            ctx.fillStyle = ASH_MOTE_OUTER;
            ctx.fillRect(x - 2, y, 5, 1);
            ctx.fillRect(x, y - 2, 1, 5);
            ctx.fillStyle = ASH_MOTE_HALO;
            if (bright) ctx.fillRect(x - 1, y - 1, 3, 3);
            ctx.fillStyle = bright ? ASH_MOTE_CORE : ASH_MOTE_DIM;
            ctx.fillRect(x, y, bright ? 2 : 1, 1);
            this._drawn.ashMotes++;
        }
        ctx.restore();
    }

    // AW-P8a — dragonflies over the lily-pad clusters. The pool lives on the
    // particle system (its own DRAGONFLY_POOL_MAX, outside the shared cap);
    // this keeps it at the budget, one newcomer at a time at the in-view
    // cluster with the fewest, sheds the extras with a fade, and draws them
    // here so both backends show them. With motion off the pool fills to
    // the cap at once and every dragonfly holds its pose.
    drawDragonflies(ctx) {
        this._drawn.dragonflies = 0;
        const pool = this.host.particleSystem;
        if (!pool?.dragonflies) return;
        const cap = this._dragonflyCap();
        const flies = pool.dragonflies;
        let staying = 0;
        for (const fly of flies) if (!fly.leaving) staying++;
        if (staying > cap) {
            pool.releaseDragonflies(staying - cap);
        } else if (staying < cap) {
            this._topUpDragonflies(pool, cap - staying);
        }
        if (!pool.dragonflies.length) return;
        const motion = this.host.motionScale > 0;
        ctx.save();
        for (const fly of pool.dragonflies) {
            if (fly.draw(ctx, motion, this._gradedColor(fly.color))) this._drawn.dragonflies++;
        }
        ctx.restore();
    }

    _dragonflyCap() {
        return dragonflyBudget({
            zoom: this._zoom(),
            month: monthIndexForAtmosphere(this.host._lastAtmosphere),
            weatherType: this._weatherType(),
            phase: this._phase(),
            motionScale: this.host.motionScale,
            level: Number(sampleFramePressure()?.level) || 0,
            calm: readCalmGateOverride() === 'quiet',
        }, this._dragonflyBudget).cap;
    }

    _topUpDragonflies(pool, missing) {
        const homes = this._lilyClusterHomes();
        if (!homes.length) return;
        const motion = this.host.motionScale > 0;
        const now = this._sceneFrameNow || 0;
        if (motion && this._dragonflySpawnAt && now - this._dragonflySpawnAt < DRAGONFLY_SPAWN_GAP_MS) return;
        const bounds = this.host._getVisibleTileBounds(1);
        const count = motion ? 1 : missing;
        for (let n = 0; n < count; n++) {
            let best = null;
            let bestRank = Infinity;
            for (let h = 0; h < homes.length; h++) {
                const home = homes[h];
                let residents = 0;
                for (const fly of pool.dragonflies) if (fly.homeIndex === h && !fly.leaving) residents++;
                const inView = home.tileX >= bounds.startX && home.tileX <= bounds.endX
                    && home.tileY >= bounds.startY && home.tileY <= bounds.endY;
                const rank = (inView ? 0 : 100) + residents * 4 + ((h + this._dragonflySerial) % homes.length);
                if (rank < bestRank) {
                    bestRank = rank;
                    best = h;
                }
            }
            const home = homes[best];
            const serial = this._dragonflySerial++;
            const fly = pool.spawnDragonfly(home.x, home.y, {
                rangeX: home.rangeX,
                rangeY: home.rangeY,
                seed: (0x2545f491 ^ Math.imul(serial + 1, 0x9e3779b1)) >>> 0,
            });
            if (!fly) break;
            fly.homeIndex = best;
        }
        this._dragonflySpawnAt = now || 1;
    }

    // The authored lily pads (DISTRICT_PROPS `veg.lilypad`) grouped into
    // clusters: world centre plus a hover ellipse spanning the pads.
    _lilyClusterHomes() {
        if (this._dragonflyHomes) return this._dragonflyHomes;
        const clusters = [];
        for (const prop of DISTRICT_PROPS) {
            if (prop.id !== 'veg.lilypad') continue;
            const cluster = clusters.find(group => group.pads.some(pad => (
                Math.hypot(pad.tileX - prop.tileX, pad.tileY - prop.tileY) <= LILY_CLUSTER_TILES
            )));
            if (cluster) cluster.pads.push(prop);
            else clusters.push({ pads: [prop] });
        }
        this._dragonflyHomes = clusters.map(({ pads }) => {
            const tileX = pads.reduce((sum, pad) => sum + pad.tileX, 0) / pads.length;
            const tileY = pads.reduce((sum, pad) => sum + pad.tileY, 0) / pads.length;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            let spanX = 0;
            for (const pad of pads) spanX = Math.max(spanX, Math.abs((pad.tileX - pad.tileY) * TILE_WIDTH / 2 - x));
            const rangeX = Math.round(Math.min(28, spanX + 10));
            return Object.freeze({ tileX, tileY, x, y, rangeX, rangeY: Math.round(rangeX / 2) });
        });
        return this._dragonflyHomes;
    }

    // A body colour as this pass draws it: graded on the ungraded overlay,
    // authored on the Canvas world pass (graded after the fact).
    _gradedColor(color) {
        if (!this._tintGrade) return color;
        let graded = this._gradedColors.get(color);
        if (graded) return graded;
        const hex = /^#([0-9a-f]{6})$/i.exec(color);
        if (!hex) return color;
        const n = Number.parseInt(hex[1], 16);
        const out = applyGradeToRgb([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], this._tintGrade);
        graded = `rgb(${Math.round(clamp(out[0], 0, 1) * 255)}, ${Math.round(clamp(out[1], 0, 1) * 255)}, ${Math.round(clamp(out[2], 0, 1) * 255)})`;
        this._gradedColors.set(color, graded);
        return graded;
    }

    _fireflyCap() {
        return fireflyBudget({
            zoom: this._zoom(),
            month: monthIndexForAtmosphere(this.host._lastAtmosphere),
            weatherType: this._weatherType(),
            phase: this._phase(),
            motionScale: this.host.motionScale,
            level: Number(sampleFramePressure()?.level) || 0,
        }, this._fireflyBudget).cap;
    }

    // W6.4 — the ducks' share of the way to cover, eased on the scene clock;
    // the first frame and reduced motion snap to the end state.
    _duckCoverShare() {
        const now = this._sceneFrameNow || 0;
        const weather = this.host._lastAtmosphere?.weather || null;
        const type = weather?.type;
        const target = (type === 'rain' || type === 'storm' || squallApproach(weather)) ? 1 : 0;
        if (!this.host.motionScale || !this._duckCoverAt) {
            this._duckCoverAt = now || 1;
            this._duckCover = target;
            return target;
        }
        const step = Math.max(0, Math.min(250, now - this._duckCoverAt)) / DUCK_COVER_MS;
        this._duckCoverAt = now;
        this._duckCover = target > this._duckCover
            ? Math.min(target, this._duckCover + step)
            : Math.max(target, this._duckCover - step);
        return this._duckCover;
    }

    _fireflyHomeTiles() {
        if (this._fireflyHomes?.length) return this._fireflyHomes;
        const ground = fireflyGroundTiles(this.host);
        if (!ground.length) return ground;
        // Every Nth tile in hash order: an even, deterministic spread.
        const sorted = [...ground].sort((a, b) => a.seed - b.seed);
        const step = Math.max(1, Math.floor(sorted.length / FIREFLY_HOMES));
        const homes = [];
        for (let i = 0; i < sorted.length && homes.length < FIREFLY_HOMES; i += step) homes.push(sorted[i]);
        this._fireflyHomes = homes;
        return homes;
    }

    _isHarborLabelZone(tileX, tileY) {
        return tileX >= 31 && tileX <= 38 && tileY >= 18 && tileY <= 23;
    }

    _buildOpenSeaFlockBirds() {
        const birds = [];
        OPEN_SEA_FLOCK_ROUTES.forEach((flock, flockIndex) => {
            const route = this._normalizeGullRoute(flock.route);
            const count = Math.max(1, flock.size || OPEN_SEA_FLOCK_FORMATION.length);
            for (let member = 0; member < count; member++) {
                const formation = OPEN_SEA_FLOCK_FORMATION[member % OPEN_SEA_FLOCK_FORMATION.length];
                const seed = 31.41 + (flockIndex + 1) * 23.17 + member * 8.31;
                birds.push({
                    index: birds.length,
                    route,
                    flockIndex,
                    altitude: flock.altitude + (member % 4) * 2.8,
                    phase: flock.phase + member * 0.011,
                    memberPhase: seed,
                    sideOffset: formation.side + Math.sin(seed) * 0.10,
                    trailOffset: formation.trail + Math.cos(seed * 0.73) * 0.08,
                    speed: flock.speed * GULL_ROUTE_SPEED_SCALE * (0.82 + (member % 3) * 0.018),
                    wingRate: flock.wingRate * (0.92 + (member % 4) * 0.045),
                    entryIndex: (flockIndex + member) % GULL_OFFMAP_GATEWAYS.length,
                    exitIndex: (flockIndex * 3 + member * 2) % GULL_OFFMAP_GATEWAYS.length,
                    waypointIndex: (flockIndex + member) % GULL_STAGING_WAYPOINTS.length,
                    orbitRadiusX: 1.55 + ((Math.sin(seed * 0.43) + 1) / 2) * 1.10,
                    orbitRadiusY: 1.05 + ((Math.cos(seed * 0.61) + 1) / 2) * 0.75,
                    orbitStart: seed * 0.27,
                    orbitTurns: 0.72 + (member % 3) * 0.22,
                    orbitDirection: (member + flockIndex) % 2 === 0 ? 1 : -1,
                });
            }
        });
        return birds;
    }

    _normalizeGullRoute(points = []) {
        const routePoints = points.map((point) => ({
            tileX: point.tileX,
            tileY: point.tileY,
        }));
        const cumulative = [0];
        let totalLength = 0;

        for (let i = 0; i < routePoints.length; i++) {
            const from = routePoints[i];
            const to = routePoints[(i + 1) % routePoints.length];
            const length = Math.max(0.001, Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY));
            totalLength += length;
            cumulative.push(totalLength);
        }

        return {
            points: routePoints,
            cumulative,
            totalLength: Math.max(0.001, totalLength),
        };
    }

    _pointOnGullRoute(route, progress) {
        const normalized = ((progress % 1) + 1) % 1;
        const distance = normalized * route.totalLength;
        let segmentIndex = 0;
        for (let i = 0; i < route.points.length; i++) {
            if (distance >= route.cumulative[i] && distance <= route.cumulative[i + 1]) {
                segmentIndex = i;
                break;
            }
        }

        const from = route.points[segmentIndex];
        const to = route.points[(segmentIndex + 1) % route.points.length];
        const startDistance = route.cumulative[segmentIndex];
        const segmentLength = Math.max(0.001, route.cumulative[segmentIndex + 1] - startDistance);
        const t = (distance - startDistance) / segmentLength;
        const dx = to.tileX - from.tileX;
        const dy = to.tileY - from.tileY;
        const length = Math.max(0.001, Math.hypot(dx, dy));

        return {
            tileX: from.tileX + dx * t,
            tileY: from.tileY + dy * t,
            tangentX: dx / length,
            tangentY: dy / length,
        };
    }

    _loopingPick(list, index) {
        return list[((index % list.length) + list.length) % list.length];
    }

    _gullUnitNoise(seed) {
        const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
        return value - Math.floor(value);
    }

    // The phase's band of gulls on a crossing at once: the budget's 4–10,
    // 6–8 at dawn and dusk.
    _gullPhaseBand() {
        const phase = this._phase();
        return phase === 'dawn' || phase === 'dusk' ? GULL_ACTIVE_TWILIGHT : GULL_ACTIVE_DAY;
    }

    // The band the flock is heading for: the phase band, ×0.3 in rain (and
    // after a storm), the whole upper band while the forecast squall is on
    // the sea (W6.4). A hard band, not an expectation: the flying gulls are
    // lanes, each carrying one pool gull per crossing, so no more than `max`
    // can ever be aloft; lanes below `min` always fly and the rest fly on
    // alternate crossings chosen per lane and crossing.
    _gullActiveBand() {
        const [min, max] = this._gullPhaseBand();
        const type = this._weatherType();
        if (type === 'rain' || type === 'storm') {
            return [Math.max(1, Math.round(min * GULL_RAIN_SCALE)), Math.max(1, Math.round(max * GULL_RAIN_SCALE))];
        }
        if (squallApproach(this.host._lastAtmosphere?.weather || null)) return [max, max];
        return [min, max];
    }

    // W6.4 — the band flown now, one step toward the target band every
    // GULL_BAND_STEP_MS; the first frame and reduced motion snap to it.
    _gullBandNow() {
        const [targetMin, targetMax] = this._gullActiveBand();
        const band = this._gullBand;
        const now = this._sceneFrameNow || 0;
        if (!this.host.motionScale || !this._gullBandAt) {
            band[0] = targetMin;
            band[1] = targetMax;
            this._gullBandAt = (now || 1) - GULL_BAND_STEP_MS;
            return band;
        }
        while (now - this._gullBandAt >= GULL_BAND_STEP_MS) {
            if (!stepGullBand(band, targetMin, targetMax)) {
                this._gullBandAt = now - GULL_BAND_STEP_MS;
                break;
            }
            this._gullBandAt += GULL_BAND_STEP_MS;
        }
        return band;
    }

    _gullLaneMembers(lane) {
        if (!this._gullLanes) {
            this._gullLanes = Array.from({ length: GULL_LANE_COUNT }, (_, l) => (
                this.openSeaFlockBirds.filter(gull => gull.index % GULL_LANE_COUNT === l)
            ));
        }
        return this._gullLanes[lane] || [];
    }

    // One entry per lane that flies this frame: the lane, its gull, the
    // crossing index and its progress along the crossing. Lanes run
    // continuously at their first member's speed, staggered by the golden
    // ratio so crossings start and end (at the map rim) at different
    // moments. A lane's decision holds for its whole crossing; a band step
    // reaches it at its next crossing, or at once while its bird is out of
    // `bounds`, so a bird never pops in or out on screen.
    _gullLaneFlights(time, bounds = null, inland = 0) {
        const [min, max] = this._gullBandNow();
        const flights = [];
        for (let lane = 0; lane < GULL_LANE_COUNT; lane++) {
            const members = this._gullLaneMembers(lane);
            if (!members.length) continue;
            const rawCycle = time * members[0].speed + ((lane * 0.61803398875) % 1);
            const cycleIndex = Math.floor(rawCycle);
            const journeyT = rawCycle - cycleIndex;
            const want = lane < min || (lane < max && this._gullUnitNoise(lane * 3.71 + cycleIndex * 7.31) < 0.5);
            const pick = Math.floor(this._gullUnitNoise(lane * 1.93 + cycleIndex * 4.07) * members.length);
            const gull = members[Math.min(members.length - 1, pick)];
            const state = this._gullLaneStates[lane];
            if (state.cycle !== cycleIndex) {
                state.cycle = cycleIndex;
                state.fly = want;
            } else if (state.fly !== want) {
                const point = this._gullJourneyPoint(gull, cycleIndex, journeyT);
                this._applyGullInland(point, gull, time, inland);
                if (!bounds || !this._isGullInVisibleBounds(point, bounds)) state.fly = want;
            }
            if (state.fly) flights.push({ lane, gull, cycleIndex, journeyT });
        }
        return flights;
    }

    // W6.4 — the flock's eased share of the way inland (0 at sea, 1 wheeling
    // over the island) while the forecast squall is on the sea.
    _gullInlandShare() {
        const now = this._sceneFrameNow || 0;
        const target = squallApproach(this.host._lastAtmosphere?.weather || null) ? 1 : 0;
        if (!this.host.motionScale || !this._gullInlandAt) {
            this._gullInland = target;
        } else {
            const step = Math.max(0, Math.min(250, now - this._gullInlandAt)) / GULL_INLAND_MS;
            this._gullInland = target > this._gullInland
                ? Math.min(target, this._gullInland + step)
                : Math.max(target, this._gullInland - step);
        }
        this._gullInlandAt = now || 1;
        const share = this._gullInland;
        return share * share * (3 - 2 * share);
    }

    // Moves a flock point (tile units) `inland` of the way toward the
    // island's heart and onto the bird's own slow wheel.
    _applyGullInland(point, gull, time, inland) {
        if (!(inland > 0)) return point;
        const heart = this._islandHeart();
        const angle = time * GULL_WHEEL_RATE + gull.memberPhase;
        point.tileX += (heart.tileX - point.tileX) * GULL_INLAND_PULL * inland + Math.cos(angle) * GULL_WHEEL_TILES * inland;
        point.tileY += (heart.tileY - point.tileY) * GULL_INLAND_PULL * inland + Math.sin(angle) * GULL_WHEEL_TILES * 0.7 * inland;
        return point;
    }

    // The centroid of the island's dry tiles (tile units), once the water
    // classification exists.
    _islandHeart() {
        if (this._islandHeartTile) return this._islandHeartTile;
        const water = this.host.waterTiles;
        if (!water?.size) return { tileX: MAP_SIZE / 2, tileY: MAP_SIZE / 2 };
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (water.has(`${x},${y}`)) continue;
                sumX += x + 0.5;
                sumY += y + 0.5;
                count++;
            }
        }
        this._islandHeartTile = count
            ? Object.freeze({ tileX: sumX / count, tileY: sumY / count })
            : Object.freeze({ tileX: MAP_SIZE / 2, tileY: MAP_SIZE / 2 });
        return this._islandHeartTile;
    }

    // W6.2 — the live gull-fishing-run, timed on the atmosphere's clock (the
    // one the scheduler reads), or null. Planned once per event.
    _gullFishingRun(flights) {
        const event = this.host.ambientEvents?.frequent;
        if (event?.kind !== 'gull-fishing-run') {
            this._fishing = null;
            return null;
        }
        // AmbientEvents imports this module's budgets, so the progress
        // (`ambientEventProgress`) is read here rather than imported.
        const clock = this.host._lastAtmosphere?.effectiveDate?.getTime?.() ?? Date.now();
        const span = event.endMs - event.startMs;
        if (!(span > 0) || clock < event.startMs || clock >= event.endMs) return null;
        const progress = (clock - event.startMs) / span;
        if (this._fishing?.startMs !== event.startMs) this._fishing = this._planFishingRun(event, flights);
        const run = this._fishing;
        if (run.lane < 0) return null;
        run.progress = progress;
        return run;
    }

    // The run's gull: the always-flying lane's bird nearest the middle of
    // the view; its circuit: centred on the nearest open water around that
    // bird whose whole circuit is gull water, starting on its side.
    _planFishingRun(event, flights) {
        const run = { startMs: event.startMs, lane: -1, centerX: 0, centerY: 0, orbitStart: 0, direction: 1, progress: 0, lastX: NaN, facing: 1 };
        const view = this._viewCenter();
        let best = null;
        let bestRank = Infinity;
        for (const flight of flights) {
            if (flight.lane >= this._gullBand[0]) continue;
            const point = this._gullJourneyPoint(flight.gull, flight.cycleIndex, flight.journeyT);
            const rank = dist2({
                x: (point.tileX - point.tileY) * TILE_WIDTH / 2,
                y: (point.tileX + point.tileY) * TILE_HEIGHT / 2,
            }, view);
            if (rank < bestRank) {
                bestRank = rank;
                best = { lane: flight.lane, point };
            }
        }
        if (!best) return run;
        const center = this._fishingCenterNear(best.point.tileX, best.point.tileY);
        if (!center) return run;
        run.lane = best.lane;
        run.centerX = center.tileX;
        run.centerY = center.tileY;
        run.orbitStart = Math.atan2((best.point.tileY - center.tileY) / 0.75, best.point.tileX - center.tileX);
        run.direction = (Number(event.seed) & 1) ? 1 : -1;
        return run;
    }

    _fishingCenterNear(tileX, tileY) {
        const originX = Math.floor(tileX);
        const originY = Math.floor(tileY);
        for (let ring = 0; ring <= FISHING_SEARCH_TILES; ring++) {
            for (let dy = -ring; dy <= ring; dy++) {
                for (let dx = -ring; dx <= ring; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const x = originX + dx;
                    const y = originY + dy;
                    const key = `${x},${y}`;
                    if (!this.host.waterTiles.has(key) || this.host.bridgeTiles?.has(key)) continue;
                    if (this._fishingCircuitClear(x + 0.5, y + 0.5)) return { tileX: x + 0.5, tileY: y + 0.5 };
                }
            }
        }
        return null;
    }

    _fishingCircuitClear(centerX, centerY) {
        if (!this._isGullFlightTile(Math.floor(centerX), Math.floor(centerY))) return false;
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const x = Math.floor(centerX + Math.cos(angle) * FISHING_ORBIT);
            const y = Math.floor(centerY + Math.sin(angle) * FISHING_ORBIT * 0.75);
            if (!this._isGullFlightTile(x, y)) return false;
        }
        return true;
    }

    // The run gull's pose: its lane pose eased out to the circuit and back,
    // gliding on slow wingbeats, one dive at the middle of the circuit.
    _gullFishingPose(run, pose, gull, time) {
        const p = run.progress;
        const blend = p < FISHING_BLEND ? p / FISHING_BLEND : p > 1 - FISHING_BLEND ? (1 - p) / FISHING_BLEND : 1;
        const weight = blend * blend * (3 - 2 * blend);
        const s = clamp((p - FISHING_BLEND) / (1 - 2 * FISHING_BLEND), 0, 1);
        const angle = run.orbitStart + run.direction * s * Math.PI * 2 * FISHING_TURNS;
        const radius = FISHING_ORBIT * (1 - 0.3 * Math.sin(s * Math.PI));
        const circuitX = run.centerX + Math.cos(angle) * radius;
        const circuitY = run.centerY + Math.sin(angle) * radius * 0.75;
        let altitude = gull.altitude;
        let diving = false;
        if (s >= FISHING_DIVE[0] && s <= FISHING_DIVE[1]) {
            const well = Math.sin(((s - FISHING_DIVE[0]) / (FISHING_DIVE[1] - FISHING_DIVE[0])) * Math.PI);
            altitude -= well * gull.altitude * 0.85;
            diving = well > 0.45;
        }
        const tileX = pose.tileX + (circuitX - pose.tileX) * weight;
        const tileY = pose.tileY + (circuitY - pose.tileY) * weight;
        // W6.5 — where the dive meets the water, for the fish below it.
        run.diving = diving && weight >= 1;
        run.diveTileX = tileX;
        run.diveTileY = tileY;
        const blendedAltitude = pose.altitude + (altitude - pose.altitude) * weight;
        const x = (tileX - tileY) * TILE_WIDTH / 2;
        const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
        if (Number.isFinite(run.lastX) && Math.abs(x - run.lastX) > 0.05) run.facing = x < run.lastX ? -1 : 1;
        run.lastX = x;
        const bob = (pose.y - pose.waterY + pose.altitude) * (1 - weight);
        const flapFrame = Math.floor(time * gull.wingRate * 0.6 + gull.memberPhase) % GULL_FLIGHT_FRAMES.length;
        return {
            id: pose.id,
            tileX,
            tileY,
            x,
            y: waterY - blendedAltitude + bob,
            waterY,
            altitude: blendedAltitude,
            frameId: diving ? 'prop.gullFlight.down' : (weight >= 1 && flapFrame === 1 ? GULL_BANK_FRAME : GULL_FLIGHT_FRAMES[flapFrame]),
            fallbackFrameId: 'prop.gullFlight',
            facing: weight > 0.5 ? run.facing : pose.facing,
            fishing: true,
        };
    }

    _gullVisitsLighthouse(gull, cycleIndex) {
        return this._gullUnitNoise(gull.memberPhase + cycleIndex * 5.17 + gull.flockIndex * 2.11) < 0.58;
    }

    _lerpPoint(from, to, t) {
        return {
            tileX: from.tileX + (to.tileX - from.tileX) * t,
            tileY: from.tileY + (to.tileY - from.tileY) * t,
        };
    }

    _quadraticPoint(from, control, to, t) {
        const a = this._lerpPoint(from, control, t);
        const b = this._lerpPoint(control, to, t);
        return this._lerpPoint(a, b, t);
    }

    // Crossings begin and end at the map's edge: the authored off-map
    // gateways are pulled onto the rim, so no gull ever hangs over the void.
    _gullGateway(gull, cycleIndex, kind) {
        const bias = kind === 'exit' ? 3 : 0;
        const baseIndex = kind === 'exit' ? gull.exitIndex : gull.entryIndex;
        const gateway = this._loopingPick(GULL_OFFMAP_GATEWAYS, baseIndex + cycleIndex * (kind === 'exit' ? 3 : 2) + bias);
        return {
            tileX: clamp(gateway.tileX, 0.5, MAP_SIZE - 1.5),
            tileY: clamp(gateway.tileY, 0.5, MAP_SIZE - 1.5),
        };
    }

    _gullStagingPoint(gull, cycleIndex, kind) {
        const waypoint = this._loopingPick(
            GULL_STAGING_WAYPOINTS,
            gull.waypointIndex + cycleIndex * (kind === 'exit' ? 2 : 1)
        );
        const routePoint = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.19 + (kind === 'exit' ? 0.37 : 0)) % 1 + 1) % 1
        );
        const mix = kind === 'exit' ? 0.42 : 0.58;
        return {
            tileX: waypoint.tileX * mix + routePoint.tileX * (1 - mix),
            tileY: waypoint.tileY * mix + routePoint.tileY * (1 - mix),
        };
    }

    _gullOrbitPoint(gull, travelT) {
        const angle = gull.orbitStart + travelT * Math.PI * 2 * gull.orbitTurns * gull.orbitDirection;
        const wobble = Math.sin(angle * 1.7 + gull.memberPhase) * 0.18;
        return {
            tileX: GULL_LIGHTHOUSE_HOTSPOT.tileX + Math.cos(angle) * (gull.orbitRadiusX + wobble),
            tileY: GULL_LIGHTHOUSE_HOTSPOT.tileY + Math.sin(angle) * (gull.orbitRadiusY + wobble * 0.65),
        };
    }

    _gullJourneyPoint(gull, cycleIndex, t) {
        const entry = this._gullGateway(gull, cycleIndex, 'entry');
        const exit = this._gullGateway(gull, cycleIndex, 'exit');
        const inbound = this._gullStagingPoint(gull, cycleIndex, 'entry');
        const outbound = this._gullStagingPoint(gull, cycleIndex, 'exit');
        const openWaterMid = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.23 + 0.18) % 1 + 1) % 1
        );
        if (!this._gullVisitsLighthouse(gull, cycleIndex)) {
            if (t < 0.32) {
                return this._quadraticPoint(entry, inbound, inbound, t / 0.32);
            }
            if (t < 0.68) {
                return this._quadraticPoint(inbound, openWaterMid, outbound, (t - 0.32) / 0.36);
            }
            return this._quadraticPoint(outbound, outbound, exit, (t - 0.68) / 0.32);
        }

        const orbitStart = this._gullOrbitPoint(gull, 0);
        const orbitEnd = this._gullOrbitPoint(gull, 1);

        if (t < 0.28) {
            return this._quadraticPoint(entry, inbound, inbound, t / 0.28);
        }
        if (t < 0.44) {
            return this._quadraticPoint(inbound, this._lerpPoint(inbound, orbitStart, 0.55), orbitStart, (t - 0.28) / 0.16);
        }
        if (t < 0.60) {
            return this._gullOrbitPoint(gull, (t - 0.44) / 0.16);
        }
        return this._quadraticPoint(orbitEnd, outbound, exit, (t - 0.60) / 0.40);
    }

    // Flying gulls this frame (motion on). Positions are in world units.
    _openSeaGullPositions(bounds = null) {
        const time = this.host.waterFrame;
        const inland = this._gullInlandShare();
        const flights = this._gullLaneFlights(time, bounds, inland);
        const run = this._gullFishingRun(flights);
        return flights.map((flight) => {
            const { gull, cycleIndex, journeyT } = flight;
            const routePoint = this._gullJourneyPoint(gull, cycleIndex, journeyT);
            const turnProbe = this._gullJourneyPoint(gull, cycleIndex, Math.min(1, journeyT + 0.006));
            const dx = turnProbe.tileX - routePoint.tileX;
            const dy = turnProbe.tileY - routePoint.tileY;
            const tangentLength = Math.max(0.001, Math.hypot(dx, dy));
            const tangentX = dx / tangentLength;
            const tangentY = dy / tangentLength;
            const sideX = -tangentY;
            const sideY = tangentX;
            const spread = 1 + Math.sin(time * 0.9 + gull.memberPhase) * 0.10;
            const wander = Math.sin(time * 0.72 + gull.memberPhase) * 0.08;
            const point = this._applyGullInland({
                tileX: routePoint.tileX + sideX * gull.sideOffset * spread + tangentX * wander,
                tileY: routePoint.tileY + sideY * gull.sideOffset * spread + tangentY * wander,
            }, gull, time, inland);
            const { tileX, tileY } = point;
            const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
            const bob = Math.sin(time * 1.1 + gull.memberPhase) * 2.4;
            // #39 — fishing dive: over the open-water midsection a gull folds
            // and plunges toward the surface, then climbs back to cruise. A
            // half-sine well over [0.40, 0.62] of the journey reduces altitude
            // by up to ~80% (a near-surface skim) and recovers. Lighthouse
            // visitors keep their orbit altitude.
            let diveDrop = 0;
            let diving = false;
            const visitsLighthouse = this._gullVisitsLighthouse(gull, cycleIndex);
            if (!visitsLighthouse) {
                const DIVE_START = 0.40;
                const DIVE_END = 0.62;
                if (journeyT >= DIVE_START && journeyT <= DIVE_END) {
                    const dt = (journeyT - DIVE_START) / (DIVE_END - DIVE_START);
                    const well = Math.sin(dt * Math.PI);
                    diveDrop = well * gull.altitude * 0.80;
                    diving = well > 0.45;
                }
            }
            const screenVx = (dx - dy) * TILE_WIDTH / 2;
            const orbiting = visitsLighthouse && journeyT >= 0.44 && journeyT <= 0.60;
            const turn = orbiting
                ? gull.orbitDirection * 0.6
                : sideX * dx + sideY * dy;
            const flapFrame = Math.floor(time * gull.wingRate + gull.memberPhase) % GULL_FLIGHT_FRAMES.length;
            const banking = Math.abs(turn + Math.sin(time * 0.55 + gull.memberPhase) * 0.42) > 0.36
                && flapFrame === 1;

            const pose = {
                id: gull.index,
                tileX,
                tileY,
                x: (tileX - tileY) * TILE_WIDTH / 2,
                y: waterY - (gull.altitude - diveDrop) + bob,
                waterY,
                altitude: gull.altitude - diveDrop,
                frameId: diving ? 'prop.gullFlight.down' : (banking ? GULL_BANK_FRAME : GULL_FLIGHT_FRAMES[flapFrame]),
                fallbackFrameId: 'prop.gullFlight',
                facing: screenVx < 0 ? -1 : 1,
            };
            return run && flight.lane === run.lane ? this._gullFishingPose(run, pose, gull, time) : pose;
        }).filter(Boolean);
    }

    _isGullFlightTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;

        const lighthouseDx = (tileX - GULL_LIGHTHOUSE_HOTSPOT.tileX) / 4.2;
        const lighthouseDy = (tileY - GULL_LIGHTHOUSE_HOTSPOT.tileY) / 3.0;
        if ((lighthouseDx * lighthouseDx + lighthouseDy * lighthouseDy) <= 1) return true;

        const key = `${tileX},${tileY}`;
        if (!this.host.waterTiles.has(key) || this.host.bridgeTiles?.has(key)) return false;
        if (this._isHarborLabelZone(tileX, tileY)) return false;
        const openness = this.host._waterOpenness(tileX, tileY);
        if (this.host._isOpenSeaTile(tileX, tileY, openness)) return true;
        const eastSea = tileX >= 31 && tileY <= 34;
        const crossMapWater = tileY >= 22 && tileY <= 27;
        const northLagoonRun = tileY <= 11 && tileX >= 6;
        const broadLightWater = tileX >= 5 && tileX <= 35 && tileY <= 18;
        if (openness >= 0.38 && (eastSea || crossMapWater || northLagoonRun || broadLightWater)) return true;
        return this.host.deepWaterTiles.has(key) && openness >= 0.50;
    }

    _isGullInVisibleBounds(gull, bounds) {
        const tileX = Math.floor(gull.tileX);
        const tileY = Math.floor(gull.tileY);
        return tileX >= bounds.startX - 2
            && tileX <= bounds.endX + 2
            && tileY >= bounds.startY - 2
            && tileY <= bounds.endY + 2;
    }

    // What the sky holds this frame. `flying` gates the flock, `lighthouse`
    // the beacon gull, `roost` how many perches are taken, `grounded` how
    // many of those stay put through the dawn wave: all of them in a storm
    // and under reduced motion; from nightfall to sunrise and through the
    // dawn wave every perch (the flock asleep); otherwise one per bird the
    // weather has grounded below the phase band (W6.4).
    _gullPlan() {
        const zoom = this._zoom();
        const cap = zoom >= 3 ? 3 : zoom >= 2 ? 5 : 8;
        const all = GULL_ROOSTS.length;
        if (!this.host.motionScale) return { mode: 'reduced-motion', flying: false, lighthouse: false, roost: all, grounded: all, cap };
        if (this._weatherType() === 'storm') return { mode: 'storm', flying: false, lighthouse: false, roost: all, grounded: all, cap };
        if (this._phase() === 'night') return { mode: 'night', flying: false, lighthouse: true, roost: all, grounded: all, cap };
        const grounded = clamp(this._gullPhaseBand()[1] - this._gullBandNow()[1], 0, all);
        return { mode: 'flying', flying: true, lighthouse: true, roost: this._gullsAsleep() ? all : grounded, grounded, cap };
    }

    // W6.8 — the sunrise key the dawn-rise beat opens on: the grade's
    // sunrise with the season's shift.
    _sunriseMinute(atmosphere) {
        return DAWN_SUNRISE_KEY_MINUTE + (Number(seasonShiftFor(seasonTokenForAtmosphere(atmosphere))?.sunriseShift) || 0);
    }

    // W6.8 — watch the dawn-rise beat on the atmosphere's clock. The frame
    // it opens (seen shut the frame before) starts the one lift-off wave,
    // under motion and out of a storm; the wave is forgotten once it shuts.
    _watchDawnRise() {
        const atmosphere = this.host._lastAtmosphere;
        const minute = Number(atmosphere?.clock?.minuteOfDay);
        const live = dayPartBeatLive('dawn-rise', minute, { sunriseMinute: this._sunriseMinute(atmosphere) });
        const rise = this._dawnRise;
        if (!live) rise.startAt = 0;
        else if (rise.live === false && this.host.motionScale && this._weatherType() !== 'storm') rise.startAt = this._sceneFrameNow || 1;
        rise.live = live;
    }

    // Milliseconds into the dawn wave, or -1 outside it.
    _dawnWaveElapsed() {
        const start = this._dawnRise.startAt;
        if (!start) return -1;
        const elapsed = (this._sceneFrameNow || 0) - start;
        return elapsed >= 0 && elapsed < DAWN_WAVE_SPAN_MS ? elapsed : -1;
    }

    // The flock sleeps on its roosts from nightfall to sunrise (the dawn
    // phase opens half an hour before the sunrise key) and until its wave
    // has flown.
    _gullsAsleep() {
        const phase = this._phase();
        if (phase === 'night' || this._dawnWaveElapsed() >= 0) return true;
        if (phase !== 'dawn') return false;
        const atmosphere = this.host._lastAtmosphere;
        const minute = Number(atmosphere?.clock?.minuteOfDay);
        return Number.isFinite(minute) && ((minute % 1440) + 1440) % 1440 < this._sunriseMinute(atmosphere);
    }

    // A roost's way out: from the island's heart through the perch to the
    // map rim (tile units), and the flight's length in ms.
    _dawnAway(roost) {
        const cached = this._dawnAways.get(roost.id);
        if (cached) return cached;
        const heart = this._islandHeart();
        const dirX = roost.tileX - heart.tileX;
        const dirY = roost.tileY - heart.tileY;
        const scale = DAWN_WAVE_REACH / (Math.hypot(dirX, dirY) || 1);
        const away = Object.freeze({ tileX: roost.tileX + dirX * scale, tileY: roost.tileY + dirY * scale });
        this._dawnAways.set(roost.id, away);
        return away;
    }

    // Roost `index`'s bird `elapsed` ms into the dawn wave: the roost itself
    // while it waits its turn, its flight pose once it lifts, null once it
    // has flown its reach.
    _dawnLiftPose(roost, index, elapsed) {
        const flown = elapsed - index * DAWN_WAVE_STAGGER_MS - this._gullUnitNoise(index * 5.3 + 1.7) * DAWN_WAVE_JITTER_MS;
        if (flown < 0) return roost;
        const away = this._dawnAway(roost);
        const p = flown / DAWN_WAVE_FLIGHT_MS;
        if (p >= 1) return null;
        const along = p * p * (2 - p);
        const climb = 1 - (1 - Math.min(1, p / DAWN_WAVE_CLIMB)) ** 2;
        const altitude = DAWN_WAVE_ALTITUDE * climb;
        const tileX = roost.tileX + (away.tileX - roost.tileX) * along;
        const tileY = roost.tileY + (away.tileY - roost.tileY) * along;
        const screenVx = (away.tileX - roost.tileX) - (away.tileY - roost.tileY);
        const flap = Math.floor(flown * (p < DAWN_WAVE_CLIMB ? 0.009 : 0.006) + index) % GULL_FLIGHT_FRAMES.length;
        return {
            id: roost.id,
            tileX,
            tileY,
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2 - altitude,
            altitude,
            frameId: GULL_FLIGHT_FRAMES[flap],
            fallbackFrameId: 'prop.gullFlight',
            facing: Math.abs(screenVx) < 1e-6 ? roost.facing : screenVx < 0 ? -1 : 1,
        };
    }

    drawOpenSeaGulls(ctx) {
        this._watchDawnRise();
        const plan = this._gullPlan();
        const stats = this.lastGullStats;
        stats.mode = plan.mode;
        stats.cap = plan.cap;
        stats.active = 0;
        stats.visible = 0;
        stats.roosting = 0;
        stats.rising = 0;
        stats.lighthouse = 0;
        stats.fishing = 0;
        stats.band[0] = this._gullBand[0];
        stats.band[1] = this._gullBand[1];
        if (!this.host.assets?.has?.('prop.gullFlight')) return;
        const bounds = this.host._getVisibleTileBounds(2);

        if (plan.roost > 0) {
            ctx.save();
            const wave = plan.mode === 'flying' ? this._dawnWaveElapsed() : -1;
            const roosts = this._roostPoints();
            const perchFrame = this.host.assets.has(GULL_PERCH_FRAME) ? GULL_PERCH_FRAME : 'prop.gullFlight';
            for (let index = 0; index < roosts.length && index < plan.roost; index++) {
                const roost = roosts[index];
                const pose = wave >= 0 && index >= plan.grounded ? this._dawnLiftPose(roost, index, wave) : roost;
                if (!pose || (pose === roost && !this._isGullInVisibleBounds(pose, bounds))) continue;
                if (pose === roost) {
                    this._drawGullSprite(ctx, { ...roost, frameId: perchFrame, fallbackFrameId: 'prop.gullFlight' });
                    stats.roosting++;
                } else {
                    this._drawGullSprite(ctx, pose);
                    stats.rising++;
                }
            }
            ctx.restore();
        }

        const candidates = [];
        if (plan.lighthouse) {
            const beacon = this._watchtowerGullPosition();
            if (beacon && this._isGullInVisibleBounds(beacon, bounds)) candidates.push(beacon);
        }
        if (plan.flying) {
            const flying = this._openSeaGullPositions(bounds);
            // While the flock wheels inland it may cross dry land too.
            const overLand = this._gullInland > 0;
            stats.active = flying.length;
            for (const gull of flying) {
                if (!this._isGullInVisibleBounds(gull, bounds)) continue;
                const tileX = Math.floor(gull.tileX);
                const tileY = Math.floor(gull.tileY);
                if (!gull.fishing && !(overLand ? this._isGullSkyTile(tileX, tileY) : this._isGullFlightTile(tileX, tileY))) continue;
                candidates.push(gull);
            }
        }
        if (!candidates.length) {
            this._visibleGullIds.clear();
            return;
        }
        // Keep the birds already on screen, then the nearest to the middle of
        // the view, so the capped set never flickers between rivals; the
        // fishing-run gull always makes the cut (it replaces its lane's bird,
        // so the count is unchanged).
        const view = this._viewCenter();
        for (const gull of candidates) {
            gull.rank = gull.fishing ? -1 : (this._visibleGullIds.has(gull.id) ? 0 : 1e9) + dist2(gull, view);
        }
        candidates.sort((a, b) => a.rank - b.rank);
        const shown = candidates.slice(0, plan.cap);
        this._visibleGullIds.clear();
        ctx.save();
        for (const gull of shown) {
            this._visibleGullIds.add(gull.id);
            this._drawGullShadow(ctx, gull);
        }
        for (const gull of shown) this._drawGullSprite(ctx, gull);
        ctx.restore();
        stats.visible = shown.length;
        stats.lighthouse = shown.some(gull => gull.id === 'lighthouse') ? 1 : 0;
        stats.fishing = shown.some(gull => gull.fishing) ? 1 : 0;
    }

    _isGullSkyTile(tileX, tileY) {
        return tileX >= 0 && tileX < MAP_SIZE && tileY >= 0 && tileY < MAP_SIZE && !this._isHarborLabelZone(tileX, tileY);
    }

    // A two-row pixel shadow on the water under a flying gull, smaller and
    // fainter the higher the bird.
    _drawGullShadow(ctx, gull) {
        if (!(gull.altitude > 0)) return;
        const half = gull.altitude > 30 ? 2 : 3;
        const x = Math.round(gull.x);
        const y = Math.round(gull.waterY);
        ctx.fillStyle = GULL_SHADOW;
        ctx.fillRect(x - half, y - 1, half * 2, 1);
        ctx.fillRect(x - half + 1, y, half * 2 - 2, 1);
    }

    _drawGullSprite(ctx, gull) {
        const frameId = this.host.assets?.get(gull.frameId) ? gull.frameId : gull.fallbackFrameId;
        const img = this.host.assets?.get(frameId);
        if (!img) return false;
        const [anchorX, anchorY] = this.host.assets.getAnchor(frameId);
        ctx.save();
        ctx.translate(Math.round(gull.x), Math.round(gull.y));
        ctx.scale(gull.facing || 1, 1);
        ctx.drawImage(this._tinted(frameId, img), Math.round(-anchorX), Math.round(-anchorY));
        ctx.restore();
        return true;
    }

    // Roost points in world units (feet), resolved once the perch buildings'
    // art anchors are known.
    _roostPoints() {
        if (this._roosts) return this._roosts;
        const roosts = [];
        for (const roost of GULL_ROOSTS) {
            const building = this.host.world?.buildings?.get?.(roost.building);
            const id = `building.${roost.building}`;
            if (!building || !this.host.assets?.has?.(id)) return roosts;
            const anchor = this.host.assets.getAnchor(id);
            const center = buildingCenterToWorld(building);
            const x = Math.round(center.x - anchor[0] + roost.at[0]);
            const y = Math.round(center.y - anchor[1] + roost.at[1]);
            roosts.push(roostAt(x, y, roost.facing, `roost:${roost.building}:${roost.at.join(',')}`));
        }
        this._roosts = roosts;
        return roosts;
    }

    // Watchtower beacon gull. Single bird looping the Pharos Lighthouse at
    // WATCHTOWER_GULL_ORBIT; the one gull that flies at night, in the lantern's
    // light. Motion-only: reduced motion shows the roosts instead.
    _watchtowerGullPosition() {
        if (!this.host.motionScale) return null;
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        const t = (now % WATCHTOWER_GULL_ORBIT.periodMs) / WATCHTOWER_GULL_ORBIT.periodMs;
        const angle = t * Math.PI * 2;
        const tileX = WATCHTOWER_GULL_ORBIT.centerTileX + Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
        const tileY = WATCHTOWER_GULL_ORBIT.centerTileY + Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
        const tangentX = -Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
        const tangentY = Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
        const screenVx = (tangentX - tangentY) * TILE_WIDTH / 2;
        const flapIndex = Math.floor(now * 0.006) % GULL_FLIGHT_FRAMES.length;
        const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
        return {
            id: 'lighthouse',
            tileX,
            tileY,
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: waterY - WATCHTOWER_GULL_ORBIT.altitudePx,
            waterY,
            altitude: WATCHTOWER_GULL_ORBIT.altitudePx,
            frameId: GULL_FLIGHT_FRAMES[flapIndex],
            fallbackFrameId: 'prop.gullFlight',
            facing: screenVx < 0 ? -1 : 1,
        };
    }

    // Draw one authored fauna frame through the tint cache.
    _drawFauna(ctx, id, x, y, alpha = null) {
        const img = this.host.assets?.get?.(id);
        if (!img) return;
        this.host.sprites.drawSprite(ctx, id, x, y, alpha == null
            ? { image: this._tinted(id, img) }
            : { image: this._tinted(id, img), alpha });
    }

    // One part of an authored fauna frame (source rect sx, sy, sw × sh; 0 =
    // to the art's edge) at its place in the whole frame, offset dx, dy
    // whole texels: cropped reflections, tucked heads, a heron's dipped neck.
    _drawFaunaPart(ctx, id, x, y, sx, sy, sw, sh, dx = 0, dy = 0, alpha = null) {
        const img = this.host.assets?.get?.(id);
        if (!img) return;
        const w = sw || (img.width - sx);
        const h = sh || (img.height - sy);
        if (w <= 0 || h <= 0) return;
        const [ax, ay] = this.host.assets.getAnchor(id);
        const prev = ctx.globalAlpha;
        if (alpha != null) ctx.globalAlpha = prev * alpha;
        ctx.drawImage(this._tinted(id, img), sx, sy, w, h, Math.round(x - ax) + sx + dx, Math.round(y - ay) + sy + dy, w, h);
        ctx.globalAlpha = prev;
    }

    // W6.5 — the ducks' share of the way ashore at the atmosphere's own
    // clock (`duckAshoreShare`); reduced motion snaps to the end state.
    _duckAshoreShare() {
        const phase = this._phase();
        if (!this.host.motionScale) return phase === 'dusk' || phase === 'night' ? 1 : 0;
        return duckAshoreShare(phase, this.host._lastAtmosphere?.phaseProgress);
    }

    // Select the grade bucket fauna is tinted to this pass (null = draw the
    // authored art). Moving to a new bucket drops the old tinted frames.
    _prepareTint(lightGrade) {
        if (!lightGrade?.gain || !lightGrade?.purkinje) {
            this._tintGrade = null;
            return;
        }
        let key = '';
        for (const probe of GRADE_PROBES) {
            const out = applyGradeToRgb(probe, lightGrade);
            key += `${Math.round(out[0] * 32)},${Math.round(out[1] * 32)},${Math.round(out[2] * 32)};`;
        }
        this._tintGrade = lightGrade;
        if (key === this._tintKey) return;
        this._tintKey = key;
        this._tintCache.clear();
        this._gradedColors.clear();
    }

    _tinted(id, img) {
        const grade = this._tintGrade;
        if (!grade || typeof document === 'undefined') return img;
        const cached = this._tintCache.get(id);
        if (cached && cached.source === img) return cached.canvas;
        const w = img.width | 0;
        const h = img.height | 0;
        if (!w || !h) return img;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const tctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!tctx) return img;
        tctx.drawImage(img, 0, 0);
        const data = tctx.getImageData(0, 0, w, h);
        const px = data.data;
        const memo = new Map();
        const rgb = [0, 0, 0];
        for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] === 0) continue;
            const packed = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
            let out = memo.get(packed);
            if (out === undefined) {
                rgb[0] = px[i] / 255;
                rgb[1] = px[i + 1] / 255;
                rgb[2] = px[i + 2] / 255;
                const graded = applyGradeToRgb(rgb, grade);
                out = (Math.round(graded[0] * 255) << 16) | (Math.round(graded[1] * 255) << 8) | Math.round(graded[2] * 255);
                memo.set(packed, out);
            }
            px[i] = (out >> 16) & 0xff;
            px[i + 1] = (out >> 8) & 0xff;
            px[i + 2] = out & 0xff;
        }
        tctx.putImageData(data, 0, 0);
        this._tintCache.set(id, { source: img, canvas });
        return canvas;
    }

    _phase() {
        const atmosphere = this.host._lastAtmosphere;
        return atmosphere?.phase || atmosphere?.clock?.phase || 'day';
    }

    _weatherType() {
        return this.host._lastAtmosphere?.weather?.type || 'clear';
    }

    _zoom() {
        return Number(this.host.camera?.zoom) || 1;
    }

    // The world point at the middle of the view (hysteresis ranking).
    _viewCenter() {
        const camera = this.host.camera;
        const vp = this.host._screenViewport?.();
        if (!camera?.screenToWorld || !vp) return { x: 0, y: 0 };
        return camera.screenToWorld(vp.width / 2, vp.height / 2);
    }
}

function roostAt(x, y, facing, id) {
    const tileX = (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2;
    const tileY = (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2;
    return Object.freeze({ id, x, y, tileX, tileY, facing, altitude: 0 });
}

// W0.2 / W6.1 — the pure budget rules the draw path, the Shift-D ambient
// audit and `world:validate-ambient` share: `{ cap, reason }`, where
// `reason` names the gate that zeroed the cap (null while open).
export function songbirdBudget({ zoom = 1, weatherType = 'clear', phase = 'day', motionScale = 1, approach = false } = {}, out = {}) {
    out.cap = 0;
    out.reason = null;
    if (!(Number(motionScale) > 0)) {
        out.cap = 1;
        out.reason = 'reduced-motion';
    } else if (weatherType === 'rain' || weatherType === 'storm' || approach) {
        out.reason = 'weather';
    } else if (phase === 'night') {
        out.reason = 'phase';
    } else {
        out.cap = zoomCap(SONGBIRD_ZOOM_CAPS, Number(zoom) || 1);
        if (out.cap <= 0) out.reason = 'zoom';
    }
    return out;
}

export function fireflyBudget({ zoom = 1, month = null, weatherType = 'clear', phase = 'day', motionScale = 1, level = 0 } = {}, out = {}) {
    out.cap = 0;
    out.reason = null;
    if (!(Number(motionScale) > 0)) out.reason = 'reduced-motion';
    else if (month == null || month < 3 || month > 9) out.reason = 'month';
    else if (phase !== 'dusk' && phase !== 'night') out.reason = 'phase';
    else if (weatherType === 'rain' || weatherType === 'storm') out.reason = 'weather';
    else if (ornamentPlan({ level, calm: false, motionScale: 1 }).faunaCadence !== 'on') out.reason = 'pressure';
    else {
        out.cap = zoomCap(FIREFLY_ZOOM_CAPS, Number(zoom) || 1);
        if (out.cap <= 0) out.reason = 'zoom';
    }
    return out;
}

export function ashMoteBudget({ zoom = 1, weatherType = 'clear', phase = 'day', motionScale = 1, level = 0 } = {}, out = {}) {
    out.cap = 0;
    out.reason = null;
    if (phase !== 'night') out.reason = 'phase';
    else if (weatherType === 'storm') out.reason = 'weather';
    else if (Number(zoom) < 0.9) out.reason = 'zoom';
    else if (ornamentPlan({ level, calm: false, motionScale: 1 }).ambientParticles !== 'on') out.reason = 'pressure';
    else {
        out.cap = ASH_MOTE_COUNT;
        if (!(Number(motionScale) > 0)) out.reason = 'reduced-motion';
    }
    return out;
}

// AW-P8a — dragonflies: Jun–Aug, by day, out of rain; 2/3/4 by zoom up to
// DRAGONFLY_POOL_MAX; shed (reason 'pressure') when `ornamentPlan()` sheds
// the fauna cadence; under reduced motion the cap stands and they hold still
// (reason 'reduced-motion').
export function dragonflyBudget({ zoom = 1, month = null, weatherType = 'clear', phase = 'day', motionScale = 1, level = 0, calm = false } = {}, out = {}) {
    out.cap = 0;
    out.reason = null;
    if (month == null || month < 5 || month > 7) out.reason = 'month';
    else if (phase !== 'day') out.reason = 'phase';
    else if (weatherType === 'rain' || weatherType === 'storm') out.reason = 'weather';
    else if (!(Number(motionScale) > 0)) {
        out.cap = Math.min(DRAGONFLY_POOL_MAX, zoomCap(DRAGONFLY_ZOOM_CAPS, Number(zoom) || 1));
        out.reason = 'reduced-motion';
    } else if (ornamentPlan({ level, calm, motionScale: 1 }).faunaCadence !== 'on') out.reason = 'pressure';
    else out.cap = Math.min(DRAGONFLY_POOL_MAX, zoomCap(DRAGONFLY_ZOOM_CAPS, Number(zoom) || 1));
    return out;
}

// W8.4a — the livestock budget: `{ cap, walking, reason }`. The cap is the
// zoom's (LIVESTOCK_ZOOM_CAPS, reason 'zoom' when it is 0); `walking` is
// false (and `reason` names why) under reduced motion, frame pressure (the
// fauna cadence), rain or storm, and at night — the actors stay, standing.
export function livestockBudget({ zoom = 1, motionScale = 1, level = 0, calm = false, phase = 'day', weatherType = 'clear' } = {}, out = {}) {
    out.cap = zoomCap(LIVESTOCK_ZOOM_CAPS, Number(zoom) || 1);
    out.walking = false;
    out.reason = null;
    if (!(Number(motionScale) > 0)) out.reason = 'reduced-motion';
    else if (ornamentPlan({ level, calm, motionScale: 1 }).faunaCadence !== 'on') out.reason = 'pressure';
    else if (weatherType === 'rain' || weatherType === 'storm') out.reason = 'weather';
    else if (phase === 'night') out.reason = 'night';
    else out.walking = true;
    if (out.cap <= 0) out.reason = 'zoom';
    return out;
}

/**
 * W8.4a — one fauna sheet cell: rows FAUNA_SHEET_ROWS (south, east, north,
 * west), columns 0 standing and 1–4 walking; a one-row sheet faces east and
 * mirrors for west (`mirror`). `entry` carries `frameW`/`frameH`; `img`
 * (else the entry's `width`/`height`) the sheet size. Null when unusable.
 */
export function faunaSheetFrame(entry, dir = 'south', frame = 0, img = null, out = {}) {
    const sw = Number(entry?.frameW) | 0;
    const sh = Number(entry?.frameH) | 0;
    if (sw <= 0 || sh <= 0) return null;
    const cols = Math.floor((Number(img?.width ?? entry.width) | 0) / sw);
    const rows = Math.floor((Number(img?.height ?? entry.height) | 0) / sh);
    if (cols <= 0 || rows <= 0) return null;
    const fourWay = rows >= FAUNA_SHEET_ROWS.length;
    out.sx = clamp(frame | 0, 0, cols - 1) * sw;
    out.sy = fourWay ? Math.max(0, FAUNA_SHEET_ROWS.indexOf(dir)) * sh : 0;
    out.sw = sw;
    out.sh = sh;
    out.mirror = !fourWay && dir === 'west';
    return out;
}

// The screen facing from one tile point toward another (`sideOnly`: east
// or west, for the one-row hen).
function faceToward(from, to, sideOnly = false) {
    const sdx = (to.tileX - to.tileY) - (from.tileX - from.tileY);
    const sdy = ((to.tileX + to.tileY) - (from.tileX + from.tileY)) / 2;
    if (sideOnly || Math.abs(sdx) >= Math.abs(sdy)) return sdx < 0 ? 'west' : 'east';
    return sdy < 0 ? 'north' : 'south';
}

function livestockHoldS(route, index) {
    const [min, max] = route.holdS || [20, 40];
    return min + (max - min) * hashUnit((Number(route.phase) || 0) * 1000 + index * 37 + 11);
}

function walkFps(tilesPerS) {
    return clamp(tilesPerS * LIVESTOCK_FPS_PER_TILE_S, LIVESTOCK_FPS[0], LIVESTOCK_FPS[1]);
}

/**
 * W8.4a — livestock `route`'s pose at its walk clock `clockMs`: it stands
 * at each point for a seeded `holdS` span (a hen pecks now and then), then
 * walks to the next at `speed` tiles/s, round the loop. `still` holds the
 * standing frame wherever the clock left it. Writes `{ tileX, tileY,
 * walking, dir, frame }` into `out`.
 */
export function livestockPose(route, clockMs, { still = false } = {}, out = {}) {
    const points = route?.points;
    const n = points?.length || 0;
    out.walking = false;
    out.frame = 0;
    if (!n) return out;
    const hen = route.kind === 'hen';
    const speed = Math.max(0.01, Number(route.speed) || 0.2);
    let period = 0;
    for (let i = 0; i < n; i++) {
        period += livestockHoldS(route, i);
        if (n > 1) period += Math.hypot(points[(i + 1) % n].tileX - points[i].tileX, points[(i + 1) % n].tileY - points[i].tileY) / speed;
    }
    let t = fract((Number(clockMs) || 0) / 1000 / period + (Number(route.phase) || 0)) * period;
    for (let i = 0; i < n; i++) {
        const from = points[i];
        const to = points[(i + 1) % n];
        const hold = livestockHoldS(route, i);
        if (t < hold || n === 1) {
            out.tileX = from.tileX;
            out.tileY = from.tileY;
            const face = from.face && (!hen || from.face === 'east' || from.face === 'west') ? from.face : null;
            out.dir = face || (n > 1 ? faceToward(points[(i - 1 + n) % n], from, hen) : 'east');
            if (hen && !still && fract((t + 1) / HEN_PECK_EVERY_S) * HEN_PECK_EVERY_S < HEN_PECK_S) out.frame = 1;
            return out;
        }
        t -= hold;
        const walk = Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY) / speed;
        if (t < walk) {
            const s = t / walk;
            out.tileX = from.tileX + (to.tileX - from.tileX) * s;
            out.tileY = from.tileY + (to.tileY - from.tileY) * s;
            out.dir = faceToward(from, to, hen);
            if (!still) {
                const step = Math.floor(t * walkFps(speed));
                out.walking = true;
                out.frame = hen ? (step % 2 ? 2 : 0) : 1 + (step % 4);
            }
            return out;
        }
        t -= walk;
    }
    out.tileX = points[0].tileX;
    out.tileY = points[0].tileY;
    out.dir = points[0].face || 'south';
    return out;
}

/**
 * AW-P15 — the `deer-at-dawn` stag at `progress` (0–1) through an event
 * `spanS` seconds long: out of the treeline to DEER_DAWN_ROUTE.graze over
 * DEER_WALK, grazing (turning to face the meadow halfway), back over the
 * last DEER_WALK; `alpha` steps in and out in DEER_FADE_STEPS quarters.
 */
export function deerDawnPose(progress, spanS = 100, out = {}) {
    const p = clamp(Number(progress) || 0, 0, 1);
    const { from, graze } = DEER_DAWN_ROUTE;
    const walkS = Math.max(1, DEER_WALK * (Number(spanS) || 100));
    const speed = Math.hypot(graze.tileX - from.tileX, graze.tileY - from.tileY) / walkS;
    let a = from;
    let b = graze;
    let s = -1;
    if (p < DEER_WALK) s = p / DEER_WALK;
    else if (p > 1 - DEER_WALK) {
        a = graze;
        b = from;
        s = (p - (1 - DEER_WALK)) / DEER_WALK;
    }
    if (s >= 0) {
        out.tileX = a.tileX + (b.tileX - a.tileX) * s;
        out.tileY = a.tileY + (b.tileY - a.tileY) * s;
        out.dir = faceToward(a, b);
        out.walking = true;
        out.frame = 1 + (Math.floor(s * walkS * walkFps(speed)) % 4);
    } else {
        out.tileX = graze.tileX;
        out.tileY = graze.tileY;
        out.dir = p < 0.5 ? faceToward(from, graze) : 'south';
        out.walking = false;
        out.frame = 0;
    }
    const edge = Math.min(p, 1 - p) / DEER_FADE;
    out.alpha = edge >= 1 ? 1 : Math.max(1, Math.ceil(edge * DEER_FADE_STEPS)) / DEER_FADE_STEPS;
    return out;
}

// W6.4 — one step of the flying band [always, max] toward [min, max]: a
// grounded bird first, then an always-flying lane eased to alternate, then
// a lane promoted to always-flying, then an alternate lane added. Returns
// false at the target.
function stepGullBand(band, targetMin, targetMax) {
    if (band[1] > targetMax) {
        band[1]--;
        band[0] = Math.min(band[0], band[1]);
    } else if (band[0] > targetMin) {
        band[0]--;
    } else if (band[0] < targetMin) {
        band[0]++;
        band[1] = Math.max(band[1], band[0]);
    } else if (band[1] < targetMax) {
        band[1]++;
    } else {
        return false;
    }
    return true;
}

function zoomCap(caps, zoom) {
    for (const [minZoom, cap] of caps) if (zoom >= minZoom) return cap;
    return 0;
}

function dist2(point, view) {
    const dx = (Number(point.x) || 0) - view.x;
    const dy = (Number(point.y) || 0) - view.y;
    return dx * dx + dy * dy;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function hashUnit(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

function fract(value) {
    return ((value % 1) + 1) % 1;
}

function smoothstep(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

// The point at share `s` of the way along `points` (a closed loop when
// `closed`), by length.
function polylinePoint(points, s, closed, out) {
    const count = closed ? points.length : points.length - 1;
    let total = 0;
    for (let i = 0; i < count; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        total += Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
    }
    let left = clamp(s, 0, 1) * total;
    for (let i = 0; i < count; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const length = Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
        if (left <= length || i === count - 1) {
            const t = length > 0 ? clamp(left / length, 0, 1) : 0;
            out.tileX = a.tileX + (b.tileX - a.tileX) * t;
            out.tileY = a.tileY + (b.tileY - a.tileY) * t;
            return out;
        }
        left -= length;
    }
    out.tileX = points[0].tileX;
    out.tileY = points[0].tileY;
    return out;
}

/**
 * W6.5 — a fish school's tile point at motion time `motionMs`: a ping-pong
 * drift along its authored `path` over `driftS` seconds plus a small swim.
 */
export function fishSchoolPoint(fish, motionMs, out = { tileX: 0, tileY: 0 }) {
    const seconds = (Number(motionMs) || 0) / 1000;
    const phase = Number(fish.phase) || 0;
    if (fish.path?.length > 1) {
        const cycle = fract(seconds / (fish.driftS || 120) + phase / (Math.PI * 2));
        polylinePoint(fish.path, cycle < 0.5 ? cycle * 2 : 2 - cycle * 2, false, out);
    } else {
        out.tileX = fish.tileX;
        out.tileY = fish.tileY;
    }
    const radius = fish.radius ?? 0;
    out.tileX += Math.sin(seconds * 1.4 + phase) * radius;
    out.tileY += Math.cos(seconds * 0.9 + phase) * radius * 0.5;
    return out;
}

/**
 * W6.5 — the ducks' share of the way ashore at the atmosphere clock's
 * `phase` and `phaseProgress`: 0 by day, rising across DUCK_HOMING of dusk
 * (home, then up the bank), 1 all night, falling across DUCK_WAKING of dawn.
 */
export function duckAshoreShare(phase, phaseProgress = 0) {
    const p = clamp(Number(phaseProgress) || 0, 0, 1);
    if (phase === 'night') return 1;
    if (phase === 'dusk') return clamp((p - DUCK_HOMING[0]) / (DUCK_HOMING[1] - DUCK_HOMING[0]), 0, 1);
    if (phase === 'dawn') return 1 - clamp((p - DUCK_WAKING[0]) / (DUCK_WAKING[1] - DUCK_WAKING[0]), 0, 1);
    return 0;
}

/**
 * W6.5 — duck `index`'s tile point: on its paddle loop (one lap per `lapS`
 * seconds of motion time), drawn toward its W6.4 cover by `cover`, and by
 * `ashore` home and then up to its bank (each share eased).
 */
export function duckPoint(duck, index, { motionMs = 0, cover = 0, ashore = 0 } = {}, out = { tileX: 0, tileY: 0 }) {
    let px = duck.tileX;
    let py = duck.tileY;
    if (duck.paddle?.length > 1) {
        polylinePoint(duck.paddle, fract((Number(motionMs) || 0) / 1000 / (duck.lapS || 200) + (Number(duck.phase) || 0) / (Math.PI * 2)), true, out);
        px = out.tileX;
        py = out.tileY;
    }
    const shelter = DUCK_COVER[index] || duck;
    const c = smoothstep(cover);
    let x = duck.tileX + (px - duck.tileX) * (1 - c) + (shelter.tileX - duck.tileX) * c;
    let y = duck.tileY + (py - duck.tileY) * (1 - c) + (shelter.tileY - duck.tileY) * c;
    const a = smoothstep(ashore);
    if (a > 0 && duck.bank) {
        if (a < 0.5) {
            x += (duck.tileX - x) * a * 2;
            y += (duck.tileY - y) * a * 2;
        } else {
            x = duck.tileX + (duck.bank.tileX - duck.tileX) * (a - 0.5) * 2;
            y = duck.tileY + (duck.bank.tileY - duck.tileY) * (a - 0.5) * 2;
        }
    }
    out.tileX = x;
    out.tileY = y;
    return out;
}

const DABBLE_OUT = { ducks: null, dip: [0, 0] };
/**
 * W6.5 — the dabble beat at motion time `motionMs`, or null: in about two
 * windows in five, 30 s in, one basin's pair tip head-under for 2.4 s
 * (staggered 300 ms; dip 1 texel easing in and out, 2 held). Shared record.
 */
export function dabbleAt(motionMs) {
    const t = Number(motionMs) || 0;
    const window = Math.floor(t / DABBLE_WINDOW_MS);
    const roll = hashUnit(window * 7.13 + 3.1);
    if (roll >= 0.4) return null;
    const local = t - window * DABBLE_WINDOW_MS - 30000;
    let any = false;
    for (let i = 0; i < 2; i++) {
        const at = local - i * 300;
        DABBLE_OUT.dip[i] = at >= 0 && at < DABBLE_MS ? (at < 200 || at >= DABBLE_MS - 200 ? 1 : 2) : 0;
        any ||= DABBLE_OUT.dip[i] > 0;
    }
    DABBLE_OUT.ducks = DABBLE_PAIRS[roll < 0.2 ? 0 : 1];
    return any ? DABBLE_OUT : null;
}

/**
 * W6.5 — a `heron-relocation` event's plan: which heron flies, from its
 * shallow to a free one within HERON_HOP_REACH tiles (else the nearest free
 * one; indices into HERON_SHALLOWS), and whether it stabs at the water while
 * it stays. Null for any other event.
 */
export function heronRelocation(event) {
    if (event?.kind !== 'heron-relocation' || !SHORE_FAUNA.length) return null;
    const seed = (Number(event.seed) || 0) * 1000;
    const heron = Math.min(SHORE_FAUNA.length - 1, Math.floor(hashUnit(seed + 1) * SHORE_FAUNA.length));
    const from = SHORE_FAUNA[heron].shallow;
    const origin = HERON_SHALLOWS[from];
    const homes = new Set(SHORE_FAUNA.map(item => item.shallow));
    const reach = index => Math.hypot(HERON_SHALLOWS[index].tileX - origin.tileX, HERON_SHALLOWS[index].tileY - origin.tileY);
    const free = HERON_SHALLOWS.map((_, index) => index).filter(index => !homes.has(index)).sort((p, q) => reach(p) - reach(q));
    if (!free.length) return null;
    const near = Math.max(1, free.filter(index => reach(index) <= HERON_HOP_REACH).length);
    const to = free[Math.min(near - 1, Math.floor(hashUnit(seed + 2) * near))];
    return { heron, from, to, stab: hashUnit(seed + 3) < 0.6 };
}

/**
 * W6.5 — heron `index`'s pose at atmosphere clock `clockMs` under the live
 * occasional `event`: on its shallow; or, for the event's heron, a hop out
 * (two wingbeats then a glide, an arc `altitude` world px high), the stay
 * (with the stab frame index 0–2 at its middle, else -1), and the hop home.
 */
export function heronPose(index, event, clockMs, out = {}) {
    const heron = SHORE_FAUNA[index];
    const home = HERON_SHALLOWS[heron?.shallow] || heron;
    out.tileX = home.tileX;
    out.tileY = home.tileY;
    out.altitude = 0;
    out.flying = false;
    out.frame = 0;
    out.facing = -1;
    out.stab = -1;
    const plan = heronRelocation(event);
    if (!plan || plan.heron !== index) return out;
    const span = event.endMs - event.startMs;
    const t = clockMs - event.startMs;
    if (!(span > 0) || !(t >= 0) || t >= span) return out;
    const from = HERON_SHALLOWS[plan.from];
    const to = HERON_SHALLOWS[plan.to];
    const dist = Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY);
    const hop = Math.min(span / 3, clamp(1600 + 220 * dist, HERON_HOP_MS[0], HERON_HOP_MS[1]));
    let a = to;
    let b = to;
    let s = -1;
    if (t < hop) {
        a = from;
        s = t / hop;
    } else if (t >= span - hop) {
        b = from;
        s = (t - (span - hop)) / hop;
    }
    if (s < 0) {
        out.tileX = to.tileX;
        out.tileY = to.tileY;
        const mid = span / 2 - (HERON_STAB_FRAME_MS * HERON_STAB_DIP.length) / 2;
        if (plan.stab && t >= mid && t < mid + HERON_STAB_FRAME_MS * HERON_STAB_DIP.length) {
            out.stab = Math.floor((t - mid) / HERON_STAB_FRAME_MS);
        }
        return out;
    }
    const eased = smoothstep(s);
    out.tileX = a.tileX + (b.tileX - a.tileX) * eased;
    out.tileY = a.tileY + (b.tileY - a.tileY) * eased;
    out.altitude = Math.round(Math.sin(Math.PI * s) * (10 + 3 * dist));
    out.flying = out.altitude > 0;
    // Two wingbeats (0 up, 1 down, up, down) over the first half, then the
    // glide frame (2) in.
    out.frame = s < 0.5 ? Math.floor(s * 8) % 2 : 2;
    out.facing = (b.tileX - b.tileY) - (a.tileX - a.tileY) > 0 ? 1 : -1;
    return out;
}
