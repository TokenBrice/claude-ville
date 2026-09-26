import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import {
    GULL_BANK_FRAME,
    GULL_FLIGHT_FRAMES,
    GULL_LIGHTHOUSE_HOTSPOT,
    GULL_OFFMAP_GATEWAYS,
    GULL_ROUTE_SPEED_SCALE,
    GULL_STAGING_WAYPOINTS,
    LAND_BIRD_ROUTES,
    CALM_WATER_FAUNA,
    SHORE_FAUNA,
    MARINE_FISH_SCHOOLS,
    OPEN_SEA_FLOCK_FORMATION,
    OPEN_SEA_FLOCK_ROUTES,
    WATCHTOWER_GULL_ORBIT,
} from '../../config/scenery.js';
import { fireflyGroundTiles } from './AmbientGround.js';
import { harborGullsSuppressed } from './EffectStamps.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { buildingCenterToWorld } from './Projection.js';
import { monthIndexForAtmosphere } from './SeasonalAmbience.js';

// 6.7 — the ambient-life budget (output/claudeville-opus55-aesthetic/
// weather-life.md). One flock wave of gulls is the whole pool; 4–10 of them
// are on a crossing at once (6–8 at dawn and dusk, ×0.3 in rain), and only the
// few nearest the middle of the view are drawn: 8 at the wide shot, 5 at z2,
// 3 from z3. A storm grounds them on their roosts; the night leaves only the
// lighthouse gull; reduced motion shows the roosts alone; a release crown
// (`harborGullsSuppressed`) clears the sky. A push-success scatter is the one
// moment the full flock flies, and even it only doubles the visible cap.
const GULL_POPULATION = OPEN_SEA_FLOCK_ROUTES.reduce((sum, flock) => sum + flock.size, 0);
const GULL_ACTIVE_DAY = Object.freeze([4, 10]);
const GULL_ACTIVE_TWILIGHT = Object.freeze([6, 8]);
const GULL_RAIN_SCALE = 0.3;
// #39 — how long a celebratory flock scatter holds the active-gull target at
// the whole pool after a harbor push-success / git push.
const GULL_SCATTER_DURATION_MS = 6000;
// Songbirds: none at the wide shot, 2 at z2, 3 from z3; none in rain, storm
// or at night; one perched bird under reduced motion.
const SONGBIRD_ZOOM_CAPS = Object.freeze([[3, 3], [2, 2]]);
// Fireflies: warm months (Apr–Oct), dusk and night, clear air, over grass
// near water; 8 at z2, 12 from z3. Blink 600 ms on / 1400 ms off, each on its
// own phase. Emissive: they are light, so they never take the grade.
const FIREFLY_HOMES = 48;
// Plan 6.x: fireflies are a z3 detail only (≤ 12); none at z1/z2.
const FIREFLY_ZOOM_CAPS = Object.freeze([[3, 12]]);
const FIREFLY_CYCLE_MS = 2000;
const FIREFLY_ON_MS = 600;
const FIREFLY_CORE = '#f6e27a';
const FIREFLY_HALO = '#b8a04a';
// Roost points (sprite-local px of the building art, feet on the perch): the
// lighthouse's seaward merlon and three pile tops of the harbor piers.
const GULL_ROOSTS = Object.freeze([
    Object.freeze({ building: 'watchtower', at: [174, 79], facing: -1 }),
    Object.freeze({ building: 'harbor', at: [64, 173], facing: 1 }),
    Object.freeze({ building: 'harbor', at: [150, 185], facing: -1 }),
    Object.freeze({ building: 'harbor', at: [122, 212], facing: 1 }),
]);
const GULL_PERCH_FRAME = 'prop.gullPerch';
// Grade tint cache: one tinted canvas per (frame, grade bucket), rebuilt only
// when the bucket moves. A bucket is the grade's response to three probe
// colours at 1/32 steps, so it follows every term of the grade that shows.
const GRADE_PROBES = Object.freeze([[0.92, 0.94, 0.95], [0.5, 0.5, 0.5], [0.45, 0.62, 0.8]]);
const GULL_SHADOW = 'rgba(7, 18, 30, 0.22)';
const SONGBIRD_SHADOW = 'rgba(0, 0, 0, 0.16)';

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
        this._gullScatterUntil = 0;
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
        this.lastGullStats = { pool: GULL_POPULATION, active: 0, visible: 0, cap: 0, roosting: 0, lighthouse: 0, mode: 'idle' };
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
        if (overlay) this.drawFireflies(ctx, this._sceneFrameNow);
        this.drawOpenSeaGulls(ctx);
        this.drawLandBirds(ctx, this._sceneFrameNow);
    }

    drawFishSchools(ctx) {
        if (!this.host.motionScale || !this.host.sprites || !MARINE_FISH_SCHOOLS.length) return;
        const visible = this.host._getVisibleTileBounds(2);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const fish of MARINE_FISH_SCHOOLS.slice(0, 12)) {
            const baseX = Math.floor(fish.tileX);
            const baseY = Math.floor(fish.tileY);
            if (baseX < visible.startX || baseX > visible.endX || baseY < visible.startY || baseY > visible.endY) continue;
            const key = `${baseX},${baseY}`;
            const isLagoon = this.host.lagoonWaterTiles?.has(key);
            if (!this.host.waterTiles.has(key) || (this.host.deepWaterTiles.has(key) && !isLagoon) || this.host.bridgeTiles?.has(key)) continue;
            if (this._isHarborLabelZone(baseX, baseY)) continue;

            const swim = Math.sin(this.host.waterFrame * 1.4 + fish.phase) * (fish.radius ?? 0.25);
            const drift = Math.cos(this.host.waterFrame * 0.9 + fish.phase) * 0.12;
            const tileX = fish.tileX + swim;
            const tileY = fish.tileY + drift;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            this._drawFauna(ctx, fish.id, x, y, 0.48);
        }
        ctx.restore();
    }

    // Calm-water ducks + shoreline herons. Ducks drift on lagoon water with a
    // gentle paddle; herons stand at the shore with a small bob. Reduced motion
    // freezes both in place (still readable). A storm sends the ducks in.
    drawWaterfowl(ctx) {
        if (!this.host.sprites) return;
        const visible = this.host._getVisibleTileBounds(2);
        const storm = this._weatherType() === 'storm';
        ctx.save();
        for (const duck of storm ? [] : CALM_WATER_FAUNA) {
            const bx = Math.floor(duck.tileX);
            const by = Math.floor(duck.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            if (!this.host.waterTiles.has(`${bx},${by}`) || this.host.bridgeTiles?.has(`${bx},${by}`)) continue;
            const swim = this.host.motionScale ? Math.sin(this.host.waterFrame * 0.7 + duck.phase) * (duck.radius ?? 0.15) : 0;
            const drift = this.host.motionScale ? Math.cos(this.host.waterFrame * 0.5 + duck.phase) * 0.06 : 0;
            const tileX = duck.tileX + swim;
            const tileY = duck.tileY + drift;
            this._drawFauna(ctx, duck.id, (tileX - tileY) * TILE_WIDTH / 2, (tileX + tileY) * TILE_HEIGHT / 2);
        }
        for (const heron of SHORE_FAUNA) {
            const bx = Math.floor(heron.tileX);
            const by = Math.floor(heron.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            const bob = this.host.motionScale ? Math.round(Math.sin(this.host.waterFrame * 0.4 + heron.tileX) * 0.5) : 0;
            const x = (heron.tileX - heron.tileY) * TILE_WIDTH / 2;
            const y = (heron.tileX + heron.tileY) * TILE_HEIGHT / 2 + bob;
            this._drawFauna(ctx, heron.id, x, y);
        }
        ctx.restore();
    }

    // Songbirds flitting on small looping flight paths between the trees of the
    // inhabited belt — the land analogue of the sea gulls. Wing frames cycle
    // when motion is on; under reduced motion one bird sits perched.
    drawLandBirds(ctx, frameNow = null) {
        if (!this.host.sprites || !LAND_BIRD_ROUTES.length) return;
        const reduced = !this.host.motionScale;
        const weather = this._weatherType();
        const grounded = weather === 'rain' || weather === 'storm' || this._phase() === 'night';
        const cap = reduced ? 1 : grounded ? 0 : zoomCap(SONGBIRD_ZOOM_CAPS, this._zoom());
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
        ctx.save();
        for (const bird of this._landBirdRoutes) {
            if (drawn >= cap) break;
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
    }

    // 6.7 — fireflies: blinking pixel lights over grass near water. Each lives
    // around a fixed home tile (a deterministic spread over the whole map), so
    // panning reveals the same swarm instead of re-rolling it.
    drawFireflies(ctx, frameNow = null) {
        const cap = this._fireflyCap();
        if (cap <= 0) {
            this._visibleFireflyIds.clear();
            return;
        }
        const homes = this._fireflyHomeTiles();
        if (!homes.length) return;
        const now = Number.isFinite(frameNow) && frameNow > 0 ? frameNow : (this._sceneFrameNow || Date.now());
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
        ctx.save();
        for (let n = 0; n < count; n++) {
            const { i, home, blink } = lit[n];
            this._visibleFireflyIds.add(i);
            if (blink >= FIREFLY_ON_MS) continue;
            const t = now * 0.0006 + home.seed * 40;
            const x = Math.round(home.x + Math.sin(t * 1.3) * 9);
            const y = Math.round(home.y - 6 + Math.sin(t * 0.9 + 1.7) * 3);
            // Blink envelope in three frames: core, core + halo, core.
            const halo = blink >= 120 && blink < FIREFLY_ON_MS - 120;
            if (halo) {
                ctx.fillStyle = FIREFLY_HALO;
                ctx.fillRect(x - 1, y, 1, 1);
                ctx.fillRect(x + 1, y, 1, 1);
                ctx.fillRect(x, y - 1, 1, 1);
                ctx.fillRect(x, y + 1, 1, 1);
            }
            ctx.fillStyle = FIREFLY_CORE;
            ctx.fillRect(x, y, 1, 1);
        }
        ctx.restore();
    }

    _fireflyCap() {
        if (!this.host.motionScale) return 0;
        const month = monthIndexForAtmosphere(this.host._lastAtmosphere);
        if (month == null || month < 3 || month > 9) return 0;
        const phase = this._phase();
        if (phase !== 'dusk' && phase !== 'night') return 0;
        const weather = this._weatherType();
        if (weather === 'rain' || weather === 'storm') return 0;
        return zoomCap(FIREFLY_ZOOM_CAPS, this._zoom());
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
                const activeSpan = 0.70 + ((Math.sin(seed * 1.37) + 1) / 2) * 0.18;
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
                    activeSpan,
                    cycleOffset: ((seed * 0.61803398875) % 1 + 1) % 1,
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

    // #39 — record a push-success so the gull flock scatters skyward for a
    // few seconds. Bounded by performance.now(); read by `_openSeaGullPositions`
    // and (via the renderer-supplied getter) by SeasonalAmbience suppression.
    triggerGullScatter() {
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        this._gullScatterUntil = now + GULL_SCATTER_DURATION_MS;
    }

    gullScatterActive() {
        if (!this._gullScatterUntil) return false;
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        return now < this._gullScatterUntil;
    }

    // Gulls on a crossing at once: the budget's 4–10 (6–8 at dawn and dusk),
    // ×0.3 in rain. A hard band, not an expectation: the flying gulls are
    // `max` lanes, each carrying one pool gull per crossing, so no more than
    // `max` can ever be aloft; lanes below `min` always fly and the rest fly
    // on alternate crossings chosen per lane and crossing (fixed for the whole
    // crossing, so a bird never pops mid-flight).
    _gullActiveBand() {
        const phase = this._phase();
        const [min, max] = phase === 'dawn' || phase === 'dusk' ? GULL_ACTIVE_TWILIGHT : GULL_ACTIVE_DAY;
        if (this._weatherType() !== 'rain') return [min, max];
        return [Math.max(1, Math.round(min * GULL_RAIN_SCALE)), Math.max(1, Math.round(max * GULL_RAIN_SCALE))];
    }

    _gullLaneMembers(lane) {
        if (!this._gullLanes) {
            const laneCount = Math.max(...GULL_ACTIVE_DAY, ...GULL_ACTIVE_TWILIGHT);
            this._gullLanes = Array.from({ length: laneCount }, (_, l) => (
                this.openSeaFlockBirds.filter(gull => gull.index % laneCount === l)
            ));
        }
        return this._gullLanes[lane] || [];
    }

    // One entry per lane that flies this frame: the gull, its crossing index
    // and its progress along the crossing. Lanes run continuously at their
    // first member's speed, staggered by the golden ratio so crossings start
    // and end (at the map rim) at different moments.
    _gullLaneFlights(time) {
        const [min, max] = this._gullActiveBand();
        const flights = [];
        for (let lane = 0; lane < max; lane++) {
            const members = this._gullLaneMembers(lane);
            if (!members.length) continue;
            const rawCycle = time * members[0].speed + ((lane * 0.61803398875) % 1);
            const cycleIndex = Math.floor(rawCycle);
            if (lane >= min && this._gullUnitNoise(lane * 3.71 + cycleIndex * 7.31) >= 0.5) continue;
            const pick = Math.floor(this._gullUnitNoise(lane * 1.93 + cycleIndex * 4.07) * members.length);
            flights.push({ gull: members[Math.min(members.length - 1, pick)], cycleIndex, journeyT: rawCycle - cycleIndex });
        }
        return flights;
    }

    // A live push-success scatter: the whole pool on its own crossings.
    _gullScatterFlights(time) {
        const flights = [];
        for (const gull of this.openSeaFlockBirds) {
            const rawCycle = time * gull.speed + gull.cycleOffset;
            const cycleIndex = Math.floor(rawCycle);
            const cyclePhase = rawCycle - cycleIndex;
            if (cyclePhase > gull.activeSpan) continue;
            flights.push({ gull, cycleIndex, journeyT: cyclePhase / gull.activeSpan });
        }
        return flights;
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
    _openSeaGullPositions() {
        const time = this.host.waterFrame;
        const flights = this.gullScatterActive() ? this._gullScatterFlights(time) : this._gullLaneFlights(time);
        return flights.map(({ gull, cycleIndex, journeyT }) => {
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
            const tileX = routePoint.tileX + sideX * gull.sideOffset * spread + tangentX * wander;
            const tileY = routePoint.tileY + sideY * gull.sideOffset * spread + tangentY * wander;
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

            return {
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
    // the beacon gull, `roost` the perched birds.
    _gullPlan() {
        if (harborGullsSuppressed()) return { mode: 'suppressed', flying: false, lighthouse: false, roost: false, cap: 0 };
        const scatter = this.gullScatterActive();
        const zoom = this._zoom();
        const cap = (zoom >= 3 ? 3 : zoom >= 2 ? 5 : 8) * (scatter ? 2 : 1);
        if (!this.host.motionScale) return { mode: 'reduced-motion', flying: false, lighthouse: false, roost: true, cap };
        if (this._weatherType() === 'storm') return { mode: 'storm', flying: false, lighthouse: false, roost: true, cap };
        if (this._phase() === 'night' && !scatter) return { mode: 'night', flying: false, lighthouse: true, roost: false, cap };
        return { mode: scatter ? 'scatter' : 'flying', flying: true, lighthouse: true, roost: false, cap };
    }

    drawOpenSeaGulls(ctx) {
        const plan = this._gullPlan();
        const stats = this.lastGullStats;
        stats.mode = plan.mode;
        stats.cap = plan.cap;
        stats.active = 0;
        stats.visible = 0;
        stats.roosting = 0;
        stats.lighthouse = 0;
        if (!this.host.assets?.has?.('prop.gullFlight')) return;
        const bounds = this.host._getVisibleTileBounds(2);

        if (plan.roost) {
            ctx.save();
            for (const roost of this._roostPoints()) {
                if (!this._isGullInVisibleBounds(roost, bounds)) continue;
                const frameId = this.host.assets.has(GULL_PERCH_FRAME) ? GULL_PERCH_FRAME : 'prop.gullFlight';
                this._drawGullSprite(ctx, { ...roost, frameId, fallbackFrameId: 'prop.gullFlight' });
                stats.roosting++;
            }
            ctx.restore();
        }

        const candidates = [];
        if (plan.lighthouse) {
            const beacon = this._watchtowerGullPosition();
            if (beacon && this._isGullInVisibleBounds(beacon, bounds)) candidates.push(beacon);
        }
        if (plan.flying) {
            const flying = this._openSeaGullPositions();
            stats.active = flying.length;
            for (const gull of flying) {
                if (!this._isGullInVisibleBounds(gull, bounds)) continue;
                if (!this._isGullFlightTile(Math.floor(gull.tileX), Math.floor(gull.tileY))) continue;
                candidates.push(gull);
            }
        }
        if (!candidates.length) {
            this._visibleGullIds.clear();
            return;
        }
        // Keep the birds already on screen, then the nearest to the middle of
        // the view, so the capped set never flickers between rivals.
        const view = this._viewCenter();
        for (const gull of candidates) {
            gull.rank = (this._visibleGullIds.has(gull.id) ? 0 : 1e9) + dist2(gull, view);
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
