import { ART_RAMPS } from '../../config/artPalette.js';
import { MAP_SIZE } from '../../config/constants.js';
import { WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { pulseValue, pulseAlpha } from './PulsePolicy.js';
import { BUOY_TORCH_COLORS } from './ParticleSystem.js';
import { fitLabelText, measureLabelText, snapScreenOrigin } from './WorldLabelKit.js';
import { normalizeRepoBranch, repoBranchProfile, repoProfile } from '../shared/RepoColor.js';
import {
    cleanCommitSubject,
    commitMessageFromCommand,
    displayRepoName,
    gitEventKind,
    normalizeGitEvent,
    parseEventTime,
    shortGitLabel,
} from '../shared/GitEventIdentity.js';
import { tileToWorld, worldToTile } from './Projection.js';
import { WILDLIFE_SCENE_CATEGORY } from './WildlifeRenderer.js';
import {
    FAILURE,
    FAILURE_OUTLINE,
    GOLD,
    GOLD_RAMP,
    PEAK,
    bracket,
    defineMoment,
    diamond,
    ellipseArcDots,
    fillConvex,
    createCueGate,
    cueGatedAge,
    drawMomentThread,
    holdSuccessGrammar,
    momentPhase,
    quantStep,
    queueMomentEdgePlate,
    peakMarkSink,
    releaseSuccessGrammar,
    pixelLine,
    resolveMomentAnchor,
    snap,
    wakeV,
} from './EffectStamps.js';
import { drawPixelFlame, fillPixelEllipse } from './PixelShapes.js';
import { PENNANT_REST_FRAME, currentPennantTime, currentPennantWind, drawMiniPennant, drawPennant, pennantFrame } from './PixelPennant.js';

import { drawHullFallback, hullGeometry, hullMasthead, hullRecords, hullStrip, liveryStrip, rollFrameIndex } from './HarborHulls.js';

export { normalizeGitEvent } from '../shared/GitEventIdentity.js';

const MAX_SHIPS_PER_SQUAD_ANCHORAGE = 3;
const HARBOR_LOG_TILE = { tileX: 34.8, tileY: 17.2 };
const COMMIT_LAGOON_LOG_TILE = { tileX: 17.2, tileY: 6.1 };
const DEPARTURE_MS = 48000;
const DEPARTURE_STAGGER_MS = 720;
const STORAGE_TRANSFER_MS = 9000;
const STORAGE_TRANSFER_STAGGER_MS = 220;
const EXIT_HOLD_MS = 1800;
const EXIT_FADE_MS = 4200;
const FADE_DELAY_MS = 3200;
// 3.6 / 6.5 — the untethered broken-rope chevron: two polylines in texels
// from the flag pole's top (x toward the cloth side), a gap between them.
const UNTETHERED_CHEVRON = Object.freeze([
    Object.freeze([[-4, 4], [1, 0], [3, 2]]),
    Object.freeze([[6, 5], [9, 1], [13, 4]]),
]);

// 4.17 / 6.5 — the heraldry shield silhouette as whole-texel row runs
// `[y, x0, x1)` about a centre column: straight sides to the shoulder at
// 72 % of the height, then a stepped taper to a 2-texel point.
const shieldRunCache = new Map();
function shieldRuns(w, h) {
    const key = `${w}x${h}`;
    let runs = shieldRunCache.get(key);
    if (runs) return runs;
    const left = -Math.round(w / 2);
    const right = left + w;
    const shoulder = Math.round(h * 0.72);
    runs = [];
    for (let y = 0; y < h; y++) {
        if (y < shoulder) {
            runs.push([y, left, right]);
            continue;
        }
        const k = (y - shoulder + 1) / (h - shoulder + 1);
        const x0 = Math.min(-1, Math.round(left * (1 - k)));
        const x1 = Math.max(1, Math.round(right * (1 - k)));
        runs.push([y, x0, x1]);
    }
    if (shieldRunCache.size > 32) shieldRunCache.clear();
    shieldRunCache.set(key, runs = Object.freeze(runs.map((run) => Object.freeze(run))));
    return runs;
}
const FINALE_EFFECT_MS = 9000;
const SCREEN_SUMMARY_MS = 16000;
const RECENT_PUSH_REPLAY_MS = 2 * 60 * 1000;
const HARBOR_REPLAY_GRACE_MS = 60 * 1000;
const HARBOR_REPLAY_RETENTION_MS = RECENT_PUSH_REPLAY_MS + HARBOR_REPLAY_GRACE_MS;
const MAX_HARBOR_SHIPS = 2048;
const MAX_HARBOR_SEEN_EVENT_IDS = 2048;
const MAX_HARBOR_PUSH_EVENTS = 1024;
const MAX_HARBOR_BATCHES = 512;
const MAX_HARBOR_REPO_QUAYS = 512;
const MAX_HARBOR_EVENT_TOMBSTONES = 4096;
const MAX_HARBOR_COMMIT_REPLAY_FLOORS = 1024;
const MAX_HARBOR_OVERFLOW_DOCK_COUNTS = 512;
const MAX_HARBOR_EVENT_IDS_PER_SHIP = 64;
const HARBOR_OVERFLOW_OTHER_KEY = '\x00other-repositories';
const MAX_REPO_FIRST_SEEN = 512;
const HARBOR_MAINTENANCE_INTERVAL_MS = 10000;
const HARBOR_CRATE_TTL_MS = 30000;
const MAX_LABEL_CHARS = 30;
const COMMIT_EQUIVALENCE_WINDOW_MS = 10 * 60 * 1000;
const HARBOR_FINALE_TILE = { tileX: 38.2, tileY: 6.6 };
// 6.5 — failed-push bracket: a 120 ms convergence, one cream flash frame, a
// three-step shake of the stamp only, then a static red broken bracket for as
// long as the failure stands. Replays older than the window arrive static.
// V8 — the residue is the thread's window (actor → slip, while both are in
// view); the bracket itself draws the same static frame through it and after.
const FAILURE_BRACKET = defineMoment('medium', { anticipation: 120, peak: 80, follow: 180, residue: 6000 });
const FAILURE_BRACKET_FRESH_MS = 15000;
const FAILURE_BRACKET_MAX = 4;
const FAILURE_SHAKE = Object.freeze([2, -2, 1]);
const HARBOR_SUMMARY_TILE = { tileX: 35.2, tileY: 21.5 };
const FORCE_DEPARTURE_MS = 12000;
const CAST_OFF_MS = 1500;
const MIST_FADE_MS = 800;
const BOOMERANG_OUT_MS = 16000;
const BOOMERANG_IN_MS = 12000;
// 5.11 — cancelled pushes return to berth half-speed with no collision flare.
const CANCEL_RETURN_MS = 12000;
const INBOUND_DURATION_MS = 36000;
const INBOUND_FADE_IN_MS = 8000;
const INBOUND_SHIP_CLASS_KEY = 'cutter';
// W7.9 (SW-P9) — the pull-request cutter: `gh pr create` moors one at the
// outer roadstead for as long as an open PR plausibly waits (PR_SHIP_MOOR_MS
// from its creation), `gh pr merge` sails it in to a quay berth over
// PR_MERGE_SAIL_MS, where it lies PR_QUAY_HOLD_MS before retiring. Its one
// mark is a parchment pennant above the repo flag (no new hull art).
const PR_SHIP_MOOR_MS = 2 * 60 * 60 * 1000;
const PR_QUAY_HOLD_MS = 10 * 60 * 1000;
const PR_MERGE_SAIL_MS = 20000;
const PR_ROADSTEAD_ROWS = 3;
const PR_PENNANT_CLOTH = '#e8dcb8';
const PR_PENNANT_RIM = '#3a2c1a';
const NO_SINK = Object.freeze({ progress: 0, px: 0, alphaScale: 1 });
// The repo flag's staff foot laps this many texels down the mast top.
const FLAG_MAST_OVERLAP = 3;
// 8.2 — a verified release sails from the pier (SM-3). The release's own
// sloop (the existing sloop hull: one more ship record) appears at the
// Harbor's release slip on a 4×4 Bayer order in four steps (whole texels of
// the hull and its reflection, never translucent; bare-masted; the crown
// waits for it), then follows the release crown's moment clock
// (ChronicleMonuments): a gold pennant of the 6.5 family climbs the mast in
// three held steps through the anticipation, the sail outline takes the one
// cream peak frame, the sloop casts off bow-first (screen-right, the way
// every hull frame faces) along the channel route through the follow with
// two wake chevrons astern (its V wake starts once they are spent), and sails
// on past the buoys to open water, dissolving on the same order over its last
// stretch. Reduced motion ties it up at the slip at once for the static crown
// and clears it when the moment ends.
// Pennant cloth texels below its flown position per hoist step (3 = flown).
const RELEASE_SAIL_HOIST_DROP = Object.freeze([24, 16, 8, 0]);
// World px per ms at cruise, reached over the crown's 1200 ms follow.
const RELEASE_SAIL_CRUISE = 0.036;
const RELEASE_SAIL_ACCEL_MS = 1200;
const RELEASE_SAIL_FADE_PX = 160;
// The arrival: 1/4, 2/4, 3/4 and all of the hull's texels, each held this
// long.
const RELEASE_SAIL_ARRIVE_STEP_MS = 150;
const RELEASE_SAIL_LIMIT = 2;
const RELEASE_SAIL_BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
// The release slip: open water in front of the Harbor jetty's east arm, and
// the one leg out of it (bow-first, about 27° below screen-right — the way
// the hull faces — passing below the east arm's front posts) where the sloop
// joins the channel route every departure takes.
const RELEASE_SAIL_SLIP = Object.freeze({ tileX: 32.025, tileY: 21.1 });
const RELEASE_SAIL_OUT = Object.freeze({ tileX: 34.5, tileY: 21.1 });
// The chevrons: 7-step V arms two texels thick (they must read over the sea
// glitter), the first 3 texels astern of the stern, the
// second a further 8 back; foam and crest are the hull wake's tones.
const RELEASE_SAIL_CHEVRON_LENGTH = 7;
const RELEASE_SAIL_CHEVRON_GAP = 8;
const RELEASE_SAIL_FOAM = ART_RAMPS.shallowWater[2];
const RELEASE_SAIL_CREST = '#b5cabf';
// The rejected caution beat: one 2 Hz step of four is the lit tone (V4).
const CAUTION_BEAT_STEP_MS = 500;
const UNTETHERED_MIN_COMMITS = 2;
const UNTETHERED_HOLD_MS = 5 * 60 * 1000;
const HARBOR_BEACON_BUOY_TILE = { tileX: 26.0, tileY: 6.0 };
const REPO_DOCK_SHIP_Y_OFFSET = 236;
const REPO_DOCK_SHIP_SORT_OFFSET = 8;
const MAX_HARBOR_SHIP_PACK_SIZE = 50;
// Titan tiers — a repo/branch fleet of HARBOR_TITAN_MIN_COMMITS or more docked
// commits stops sailing as one ship per commit and consolidates into
// ceil(n / 50) balanced stack ships (5/10/20/30/40/50-class hulls, exact count
// on the badge). Smaller fleets keep the lead-hull + skiffs look.
const HARBOR_TITAN_MIN_COMMITS = 5;
const HARBOR_SQUAD_REUSE_OFFSETS = Object.freeze([
    { tileX: 0.70, tileY: 0.48 },
    { tileX: -0.56, tileY: 0.56 },
    { tileX: 0.82, tileY: -0.34 },
    { tileX: -0.64, tileY: -0.42 },
]);
// 3.8 — hulls draw at scale 1 from their roll strips (HarborHulls.js). The
// label lift is the hull's height above its waterline (world px; the strip
// anchor overrides it once loaded) and the flag offsets sit the repo flag at
// the mast head of the scale-1 hull.
const HARBOR_SHIP_CLASSES = Object.freeze([
    { key: 'flagship', spriteId: 'prop.harborShip.flagship', minCommits: 10, wakeScale: 2.38, cargoRows: 7, mastCount: 5, labelLift: 84, flagOffsetX: 8, flagOffsetY: 50, badge: '10+' },
    { key: 'dreadnought', spriteId: 'prop.harborShip.dreadnought', minCommits: 8, wakeScale: 2.12, cargoRows: 7, mastCount: 5, labelLift: 74, flagOffsetX: 8, flagOffsetY: 42, badge: '8+' },
    { key: 'galleon', spriteId: 'prop.harborShip.galleon', minCommits: 6, wakeScale: 1.86, cargoRows: 6, mastCount: 4, labelLift: 62, flagOffsetX: 6, flagOffsetY: 30, badge: '6+' },
    { key: 'brigantine', spriteId: 'prop.harborShip.brigantine', minCommits: 4, wakeScale: 1.56, cargoRows: 5, mastCount: 3, labelLift: 63, flagOffsetX: 6, flagOffsetY: 30, badge: '4+' },
    { key: 'sloop', spriteId: 'prop.harborShip.sloop', minCommits: 3, wakeScale: 1.32, cargoRows: 3, mastCount: 2, labelLift: 59, flagOffsetX: 4, flagOffsetY: 26, badge: '3+' },
    { key: 'cutter', spriteId: 'prop.harborShip.cutter', minCommits: 2, wakeScale: 1.15, cargoRows: 1, mastCount: 1, labelLift: 45, flagOffsetX: 2, flagOffsetY: 12, badge: '2+' },
    { key: 'skiff', spriteId: 'prop.harborShip.skiff', minCommits: 1, wakeScale: 0.88, cargoRows: 0, mastCount: 1, labelLift: 38, flagOffsetX: 0, flagOffsetY: 6, badge: '' },
]);
const RELEASE_SAIL_CLASS = Object.freeze({
    ...HARBOR_SHIP_CLASSES.find(item => item.key === 'sloop'),
    packSize: 1,
    trim: 0,
});
// Stack hull per titan tier, chosen by the pack's exact commit count.
const HARBOR_SHIP_STACK_CLASSES = Object.freeze([
    { key: 'stack50', spriteId: 'prop.harborShip.stack50', minCommits: 50, wakeScale: 2.80, cargoRows: 10, mastCount: 7, labelLift: 154, flagOffsetX: 40, flagOffsetY: 118 },
    { key: 'stack40', spriteId: 'prop.harborShip.stack40', minCommits: 40, wakeScale: 2.60, cargoRows: 9, mastCount: 6, labelLift: 145, flagOffsetX: 30, flagOffsetY: 110 },
    { key: 'stack30', spriteId: 'prop.harborShip.stack30', minCommits: 30, wakeScale: 2.38, cargoRows: 8, mastCount: 6, labelLift: 119, flagOffsetX: 28, flagOffsetY: 86 },
    { key: 'stack20', spriteId: 'prop.harborShip.stack20', minCommits: 20, wakeScale: 2.12, cargoRows: 7, mastCount: 5, labelLift: 106, flagOffsetX: 24, flagOffsetY: 74 },
    { key: 'stack10', spriteId: 'prop.harborShip.stack10', minCommits: 10, wakeScale: 1.72, cargoRows: 5, mastCount: 4, labelLift: 80, flagOffsetX: 18, flagOffsetY: 48 },
    { key: 'stack5', spriteId: 'prop.harborShip.stack5', minCommits: 1, wakeScale: 1.30, cargoRows: 3, mastCount: 3, labelLift: 65, flagOffsetX: 14, flagOffsetY: 34 },
]);
const HARBOR_DOCK_WATER_BOUNDS = Object.freeze({
    minTileX: 31.05,
    maxTileX: MAP_SIZE - 1.95,
    minTileY: 10.15,
    maxTileY: 24.85,
});
const HARBOR_DOCK_WATER_REGIONS = Object.freeze([
    { centerX: 37.30, centerY: 21.70, radiusX: 6.35, radiusY: 7.00, limit: 0.86 },
    { centerX: 39.20, centerY: 16.20, radiusX: 4.45, radiusY: 6.05, limit: 0.82 },
    { centerX: 43.00, centerY: 19.00, radiusX: 12.60, radiusY: 23.00, limit: 0.88 },
]);
const COMMIT_LAGOON_WATER_BOUNDS = Object.freeze({
    minTileX: 5.15,
    maxTileX: 27.85,
    minTileY: 3.55,
    maxTileY: 12.85,
});
const COMMIT_LAGOON_WATER_REGIONS = Object.freeze([
    { centerX: 7.60, centerY: 8.30, radiusX: 5.45, radiusY: 3.65, limit: 0.88 },
    { centerX: 12.40, centerY: 5.20, radiusX: 3.85, radiusY: 2.65, limit: 0.86 },
    { centerX: 17.40, centerY: 10.50, radiusX: 5.15, radiusY: 3.45, limit: 0.88 },
    { centerX: 24.80, centerY: 7.60, radiusX: 3.95, radiusY: 2.70, limit: 0.86 },
]);
const HARBOR_SQUAD_ANCHORAGES = Object.freeze([
    { name: 'Inner West Basin', zone: 'inner-harbor', tileX: 32.60, tileY: 22.75, columns: 2, columnDx: 1.16, columnDy: 0.08, rowDx: -0.54, rowDy: 1.02 },
    { name: 'Inner Quay Basin', zone: 'inner-harbor', tileX: 35.15, tileY: 22.55, columns: 2, columnDx: 1.12, columnDy: -0.12, rowDx: -0.40, rowDy: 1.04 },
    { name: 'Harbor Mouth', zone: 'inner-harbor', tileX: 37.15, tileY: 20.50, columns: 2, columnDx: 0.52, columnDy: -1.08, rowDx: 0.88, rowDy: 0.26 },
    { name: 'Beacon Reach', zone: 'inner-harbor', tileX: 37.55, tileY: 17.25, columns: 2, columnDx: -0.32, columnDy: -1.18, rowDx: 0.84, rowDy: 0.18 },
    { name: 'North Roadstead', zone: 'outer-roadstead', tileX: 38.05, tileY: 13.15, columns: 2, columnDx: -0.34, columnDy: -1.26, rowDx: 0.86, rowDy: 0.10 },
    { name: 'East Roadstead', zone: 'outer-roadstead', tileX: 38.75, tileY: 16.15, columns: 2, columnDx: 0.86, columnDy: -0.70, rowDx: 0.54, rowDy: 0.76 },
    { name: 'South Roadstead', zone: 'outer-roadstead', tileX: 38.90, tileY: 21.20, columns: 2, columnDx: 1.04, columnDy: 0.08, rowDx: 0.38, rowDy: 0.98 },
    { name: 'Outer Fairway', zone: 'outer-roadstead', tileX: 38.25, tileY: 24.05, columns: 2, columnDx: 1.06, columnDy: 0.20, rowDx: -0.28, rowDy: 1.04 },
]);
const COMMIT_LAGOON_SQUAD_ANCHORAGES = Object.freeze([
    { name: 'Commit Lagoon West', zone: 'commit-lagoon', tileX: 7.75, tileY: 8.55, columns: 2, columnDx: 0.96, columnDy: -0.22, rowDx: 0.36, rowDy: 0.82 },
    { name: 'Commit Lagoon Spring', zone: 'commit-lagoon', tileX: 12.30, tileY: 5.75, columns: 2, columnDx: 0.82, columnDy: 0.18, rowDx: 0.54, rowDy: 0.72 },
    { name: 'Commit Lagoon Center', zone: 'commit-lagoon', tileX: 17.20, tileY: 10.10, columns: 2, columnDx: 1.04, columnDy: -0.18, rowDx: 0.42, rowDy: 0.82 },
    { name: 'Commit Lagoon East', zone: 'commit-lagoon', tileX: 24.20, tileY: 7.55, columns: 2, columnDx: 0.82, columnDy: -0.24, rowDx: 0.46, rowDy: 0.78 },
]);

const BERTHS = [
    { tileX: 32.8, tileY: 21.2 },
    { tileX: 33.4, tileY: 21.7 },
    { tileX: 33.6, tileY: 20.5 },
    { tileX: 34.2, tileY: 21.9 },
    { tileX: 35.0, tileY: 21.8 },
    { tileX: 34.7, tileY: 20.3 },
    { tileX: 35.8, tileY: 21.6 },
    { tileX: 36.5, tileY: 21.0 },
    { tileX: 36.1, tileY: 20.2 },
    { tileX: 37.0, tileY: 21.5 },
    { tileX: 36.8, tileY: 20.5 },
    { tileX: 35.4, tileY: 20.0 },
];
// S9 — the Harbor jetty's tie-up posts (the timber deck south of the master's
// office), one per quay group, where a failed push with no docked ship is
// bracketed.
const HARBOR_JETTY_SLIPS = Object.freeze([
    Object.freeze({ tileX: 32.4, tileY: 20.0 }),
    Object.freeze({ tileX: 31.7, tileY: 20.3 }),
    Object.freeze({ tileX: 32.9, tileY: 19.6 }),
    Object.freeze({ tileX: 31.1, tileY: 20.6 }),
]);

const QUAY_GROUPS = [
    { name: 'West Quay', berthIndexes: [0, 1, 2] },
    { name: 'Market Quay', berthIndexes: [3, 4, 5] },
    { name: 'Beacon Quay', berthIndexes: [6, 7, 8] },
    { name: 'Outer Quay', berthIndexes: [9, 10, 11] },
];

// Home Waters — persistent per-repo anchorages. Each active repo (a
// repo with a live agent, or with docked commit ships) claims a stable buoy +
// crest + tinted-water slot in the lagoon or along the east coast. The repo's
// docked commit ships form up beside their own buoy, so the water reads as a
// map of which projects are alive and how much each is holding. Slots are
// listed in fill order: two northern lagoon slots, then the coast.
// `leadDx/leadDy` offset the formation origin from the buoy; rows march along the
// shore so the buoy label stays in front of its fleet. Repos beyond the pool
// share an overflow chip and dock in the Commit Lagoon (no silent drop).
const COAST_ANCHORAGE_SLOTS = Object.freeze([
    { ...COMMIT_LAGOON_SQUAD_ANCHORAGES[0], tileY: 9.65, leadDy: -1.1 },
    { ...COMMIT_LAGOON_SQUAD_ANCHORAGES[1], tileY: 6.85, leadDy: -1.1 },
    { name: 'Pharos Reach', tileX: 33.0, tileY: 10.2, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
    { name: 'Southern Strand', tileX: 35.8, tileY: 28.6, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
    { name: 'North Shoal', tileX: 35.4, tileY: 7.4, columns: 2, columnDx: 0, columnDy: 1.15, rowDx: -1.05, rowDy: 0, leadDx: -1.15, leadDy: 0 },
    { name: 'Reed Point', tileX: 33.6, tileY: 31.4, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
    { name: 'Far North Sea', tileX: 32.8, tileY: 4.6, columns: 2, columnDx: 0, columnDy: 1.15, rowDx: -1.05, rowDy: 0, leadDx: -1.15, leadDy: 0 },
    { name: 'Wall Tower Bank', tileX: 35.8, tileY: 34.2, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
    { name: 'Pharos Bank', tileX: 32.0, tileY: 13.4, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
    { name: 'Strand Shallows', tileX: 32.2, tileY: 28.2, columns: 2, columnDx: 1.15, columnDy: 0, rowDx: 0, rowDy: -1.05, leadDx: 0, leadDy: -1.15 },
]);
const COAST_ANCHORAGE_ZONE = 'coast';
const COAST_WATER_BOUNDS = Object.freeze({
    minTileX: 30.4,
    maxTileX: MAP_SIZE - 2.3,
    minTileY: 3.3,
    maxTileY: 36.6,
});
const COAST_WATER_REGIONS = Object.freeze([
    { centerX: 33.00, centerY: 6.20, radiusX: 6.00, radiusY: 3.40, limit: 0.90 },
    { centerX: 34.30, centerY: 13.50, radiusX: 3.60, radiusY: 5.00, limit: 0.90 },
    { centerX: 34.00, centerY: 24.50, radiusX: 4.00, radiusY: 5.20, limit: 0.90 },
    { centerX: 35.20, centerY: 31.80, radiusX: 2.40, radiusY: 4.60, limit: 0.90 },
]);
const REPO_ANCHORAGE_OVERFLOW_TILE = Object.freeze({ tileX: 17.2, tileY: 11.4 });
// An agent's repo stays "home" (a lit anchorage) this long after its last update.
const REPO_ANCHORAGE_ACTIVE_MS = 5 * 60 * 1000;

// Harbor marks (flags, plates, buoys, labels) and wildlife stay overlay-safe:
// their routes stay in open water and they are marks, not matter. Wildlife
// and waterfalls share the same resolved category so the existing registry
// can replay every water/air detail above the direct GPU island.
const OVERLAY_SAFE_SCENE_ITEMS = [];
// 3.8 / M23 — the hulls themselves are matter: on the resident path they are
// V9 records (painter depth, grade, lamp light, footprint occlusion) with a
// `reflect` twin and a V-wake stamp in the ground band; elsewhere the Canvas
// fallback draws the same whole-texel frames (graded on the overlay).
export const HARBOR_HULL_SCENE_CATEGORY = Object.freeze({
    id: 'harbor-hulls',
    sortBand: 40,
    // A hull behind the Harbor (a split building on its piers) sorts before
    // the back half, so the whole building hides it.
    behindSplitBuildings: true,
    enumerate({ renderer } = {}) {
        return renderer?.harborTraffic?.enumerateHullDrawables?.() ?? [];
    },
    emitSceneCommands(item) {
        return item?.records?.length ? item.records : null;
    },
    canvasFallback(ctx, item, zoom, context = {}) {
        if (!item?.pose) return;
        const renderer = context.renderer;
        drawHullFallback(ctx, item.pose, {
            ungradedOverlay: context.ungradedOverlay === true,
            lightGrade: renderer?._lastAtmosphere?.lightGrade || null,
        });
    },
    unsupported: 'overlay-safe',
    overlayBand: 39,
});
export const HARBOR_TRAFFIC_SCENE_CATEGORY = Object.freeze({
    id: 'harbor-traffic',
    sortBand: 40,
    enumerate({ renderer } = {}) {
        const items = OVERLAY_SAFE_SCENE_ITEMS;
        items.length = 0;
        const wildlifeItems = WILDLIFE_SCENE_CATEGORY.enumerate({ renderer });
        for (let index = 0; index < wildlifeItems.length; index++) items.push(wildlifeItems[index]);
        const harborItems = renderer?.harborTraffic?.enumerateDrawables?.() ?? [];
        for (let index = 0; index < harborItems.length; index++) items.push(harborItems[index]);
        return items;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        if (drawable?.sourceCategory === WILDLIFE_SCENE_CATEGORY.id) {
            WILDLIFE_SCENE_CATEGORY.canvasFallback(ctx, drawable, zoom, context);
            return;
        }
        const harborTraffic = context.renderer?.harborTraffic || context.harborTraffic;
        harborTraffic?.draw?.(ctx, drawable, zoom);
    },
    unsupported: 'overlay-safe',
    overlayBand: 40,
});

const SEA_LANES = [
    [
        { tileX: 36.2, tileY: 21.1 },
        { tileX: 37.1, tileY: 19.2 },
        { tileX: 38.0, tileY: 15.7 },
        { tileX: 37.6, tileY: 12.8 },
        { tileX: 38.1, tileY: 9.4 },
        { tileX: 38.2, tileY: 6.6 },
    ],
    [
        { tileX: 34.8, tileY: 20.6 },
        { tileX: 36.9, tileY: 18.8 },
        { tileX: 38.1, tileY: 14.7 },
        { tileX: 37.7, tileY: 12.1 },
        { tileX: 38.3, tileY: 8.8 },
        { tileX: 38.5, tileY: 5.8 },
    ],
    [
        { tileX: 33.5, tileY: 20.5 },
        { tileX: 36.6, tileY: 18.3 },
        { tileX: 37.8, tileY: 14.2 },
        { tileX: 37.3, tileY: 11.8 },
        { tileX: 38.0, tileY: 8.4 },
        { tileX: 38.3, tileY: 4.9 },
    ],
    [
        { tileX: 38.2, tileY: 21.0 },
        { tileX: 38.0, tileY: 18.7 },
        { tileX: 38.0, tileY: 15.8 },
        { tileX: 37.5, tileY: 13.2 },
        { tileX: 38.1, tileY: 9.9 },
        { tileX: 38.4, tileY: 7.0 },
    ],
];

const LOCAL_WATER_ROUTE_BANDS = Object.freeze([
    {
        name: 'inner-channel',
        offsetX: 0.34,
        offsetY: -0.08,
        waypoints: [
            { tileX: 36.4, tileY: 22.05 },
            { tileX: 38.05, tileY: 20.35 },
            { tileX: 38.0, tileY: 16.2 },
            { tileX: 37.55, tileY: 12.7 },
            { tileX: 38.15, tileY: 8.75 },
        ],
        exitLaneIndex: 1,
    },
    {
        name: 'outer-channel',
        offsetX: -0.20,
        offsetY: -0.26,
        waypoints: [
            { tileX: 37.75, tileY: 21.25 },
            { tileX: 38.25, tileY: 18.45 },
            { tileX: 37.8, tileY: 14.15 },
            { tileX: 37.35, tileY: 11.45 },
            { tileX: 38.05, tileY: 8.15 },
        ],
        exitLaneIndex: 2,
    },
    {
        name: 'beacon-channel',
        offsetX: 0.18,
        offsetY: 0.20,
        waypoints: [
            { tileX: 38.2, tileY: 20.85 },
            { tileX: 37.95, tileY: 17.4 },
            { tileX: 37.45, tileY: 13.25 },
            { tileX: 38.05, tileY: 9.75 },
        ],
        exitLaneIndex: 3,
    },
]);
const COMMIT_LAGOON_ROUTE_BANDS = Object.freeze([
    {
        name: 'lagoon-east-channel',
        offsetX: 0.30,
        offsetY: -0.14,
        allowSouthbound: true,
        waypoints: [
            { tileX: 14.8, tileY: 8.2 },
            { tileX: 20.4, tileY: 8.8 },
            { tileX: 25.0, tileY: 7.2 },
            { tileX: 30.6, tileY: 5.2 },
            { tileX: 36.2, tileY: 4.9 },
        ],
        exitLaneIndex: 2,
    },
    {
        name: 'lagoon-spring-channel',
        offsetX: -0.22,
        offsetY: -0.26,
        allowSouthbound: true,
        waypoints: [
            { tileX: 12.8, tileY: 6.3 },
            { tileX: 18.2, tileY: 6.6 },
            { tileX: 24.8, tileY: 6.0 },
            { tileX: 31.4, tileY: 4.4 },
            { tileX: 36.8, tileY: 5.6 },
        ],
        exitLaneIndex: 1,
    },
    {
        name: 'observatory-backwater',
        offsetX: 0.14,
        offsetY: 0.22,
        allowSouthbound: true,
        waypoints: [
            { tileX: 18.4, tileY: 10.2 },
            { tileX: 22.8, tileY: 8.9 },
            { tileX: 27.8, tileY: 6.2 },
            { tileX: 34.0, tileY: 4.3 },
            { tileX: 38.2, tileY: 6.6 },
        ],
        exitLaneIndex: 3,
    },
]);
const DEPARTURE_EDGE_Y = 2.8;
const HARBOR_ROUTE_GRAPH_VERSION = 1;
const RELEASE_CONVOY_MIN_SHIPS = 2;
const HARBOR_ROUTE_WAYPOINTS = Object.freeze({
    'berth.quay': { id: 'berth.quay', name: 'Repo Berth', zone: 'berth' },
    'berth.pull': { id: 'berth.pull', name: 'Pull Berth', zone: 'berth' },
    'harbor.inner-basin': { id: 'harbor.inner-basin', name: 'Inner Basin', zone: 'harbor', tileX: 36.4, tileY: 22.05 },
    'harbor.mouth': { id: 'harbor.mouth', name: 'Harbor Mouth', zone: 'harbor', tileX: 38.05, tileY: 20.35 },
    'roadstead.north': { id: 'roadstead.north', name: 'North Roadstead', zone: 'roadstead', tileX: 38.05, tileY: 13.15 },
    'roadstead.east': { id: 'roadstead.east', name: 'East Roadstead', zone: 'roadstead', tileX: 38.75, tileY: 16.15 },
    'roadstead.south': { id: 'roadstead.south', name: 'South Roadstead', zone: 'roadstead', tileX: 38.90, tileY: 21.20 },
    'roadstead.outer': { id: 'roadstead.outer', name: 'Outer Fairway', zone: 'roadstead', tileX: 38.25, tileY: 24.05 },
    'sea.exit': { id: 'sea.exit', name: 'Departure Edge', zone: 'sea', tileY: DEPARTURE_EDGE_Y },
    'lagoon.west': { id: 'lagoon.west', name: 'Commit Lagoon West', zone: 'commit-lagoon', tileX: 7.75, tileY: 8.55 },
    'lagoon.spring': { id: 'lagoon.spring', name: 'Commit Lagoon Spring', zone: 'commit-lagoon', tileX: 12.30, tileY: 5.75 },
    'lagoon.center': { id: 'lagoon.center', name: 'Commit Lagoon Center', zone: 'commit-lagoon', tileX: 17.20, tileY: 10.10 },
    'lagoon.east': { id: 'lagoon.east', name: 'Commit Lagoon East', zone: 'commit-lagoon', tileX: 24.20, tileY: 7.55 },
    'lagoon.channel-buoy': { id: 'lagoon.channel-buoy', name: 'Lagoon Channel Buoy', zone: 'commit-lagoon', tileX: 26.0, tileY: 6.0 },
});
const HARBOR_ROUTE_GRAPH = Object.freeze({
    version: HARBOR_ROUTE_GRAPH_VERSION,
    routes: Object.freeze({
        'outbound.inner-channel': {
            id: 'outbound.inner-channel',
            name: 'Inner Channel',
            kind: 'outbound',
            zone: 'harbor',
            bandName: 'inner-channel',
            waypoints: ['berth.quay', 'harbor.inner-basin', 'harbor.mouth', 'roadstead.north', 'sea.exit'],
        },
        'outbound.outer-channel': {
            id: 'outbound.outer-channel',
            name: 'Outer Channel',
            kind: 'outbound',
            zone: 'harbor',
            bandName: 'outer-channel',
            waypoints: ['berth.quay', 'harbor.mouth', 'roadstead.east', 'roadstead.north', 'sea.exit'],
        },
        'outbound.beacon-channel': {
            id: 'outbound.beacon-channel',
            name: 'Beacon Channel',
            kind: 'outbound',
            zone: 'harbor',
            bandName: 'beacon-channel',
            waypoints: ['berth.quay', 'harbor.mouth', 'roadstead.south', 'roadstead.outer', 'sea.exit'],
        },
        'lagoon.lagoon-east-channel': {
            id: 'lagoon.lagoon-east-channel',
            name: 'Lagoon East Channel',
            kind: 'lagoon',
            zone: 'commit-lagoon',
            bandName: 'lagoon-east-channel',
            waypoints: ['lagoon.center', 'lagoon.east', 'lagoon.channel-buoy', 'roadstead.north', 'sea.exit'],
        },
        'lagoon.lagoon-spring-channel': {
            id: 'lagoon.lagoon-spring-channel',
            name: 'Lagoon Spring Channel',
            kind: 'lagoon',
            zone: 'commit-lagoon',
            bandName: 'lagoon-spring-channel',
            waypoints: ['lagoon.spring', 'lagoon.channel-buoy', 'roadstead.north', 'sea.exit'],
        },
        'lagoon.observatory-backwater': {
            id: 'lagoon.observatory-backwater',
            name: 'Observatory Backwater',
            kind: 'lagoon',
            zone: 'commit-lagoon',
            bandName: 'observatory-backwater',
            waypoints: ['lagoon.center', 'lagoon.east', 'lagoon.channel-buoy', 'roadstead.outer', 'sea.exit'],
        },
        'inbound.pull': {
            id: 'inbound.pull',
            name: 'Inbound Pull Approach',
            kind: 'inbound',
            zone: 'berth',
            waypoints: ['sea.exit', 'roadstead.north', 'harbor.mouth', 'berth.pull'],
        },
        'inbound.fetch-roadstead': {
            id: 'inbound.fetch-roadstead',
            name: 'Inbound Fetch Roadstead',
            kind: 'roadstead',
            zone: 'roadstead',
            waypoints: ['sea.exit', 'roadstead.north', 'roadstead.outer'],
        },
        'berth.assignment': {
            id: 'berth.assignment',
            name: 'Berth Assignment',
            kind: 'berth',
            zone: 'berth',
            waypoints: ['berth.quay'],
        },
        'storage.lagoon-transfer': {
            id: 'storage.lagoon-transfer',
            name: 'Lagoon Storage Transfer',
            kind: 'lagoon-transfer',
            zone: 'commit-lagoon',
            waypoints: ['harbor.inner-basin', 'lagoon.channel-buoy', 'lagoon.center'],
        },
    }),
});
const PUSH_STATUS_STYLE = {
    success: {
        label: 'Push landed',
        shortLabel: 'landed',
        accent: '#6cdb94',
        panel: 'rgba(22, 54, 43, 0.92)',
        glow: 'rgba(108, 219, 148, 0.58)',
    },
    failed: {
        label: 'Push failed',
        shortLabel: 'failed',
        accent: '#f07668',
        panel: 'rgba(62, 31, 34, 0.93)',
        glow: 'rgba(240, 87, 76, 0.55)',
    },
    rejected: {
        label: 'Push rejected',
        shortLabel: 'rejected',
        accent: '#ffd34a',
        panel: 'rgba(60, 50, 22, 0.93)',
        glow: 'rgba(255, 211, 74, 0.55)',
        panelBorder: '#ff755d',
    },
    // 5.11 — cancelled is distinct from failed: muted grey, no red effects.
    cancelled: {
        label: 'Push cancelled',
        shortLabel: 'cancelled',
        accent: '#6c757d',
        panel: 'rgba(40, 44, 48, 0.92)',
        glow: 'rgba(108, 117, 125, 0.45)',
    },
    unknown: {
        label: 'Push sent',
        shortLabel: 'sent',
        accent: '#f6cf60',
        panel: 'rgba(58, 48, 27, 0.92)',
        glow: 'rgba(246, 207, 96, 0.52)',
    },
};

function isHarborCrateTool(agent) {
    const text = `${agent?.currentTool || ''} ${agent?.currentToolInput || ''} ${agent?.lastToolInput || ''}`.toLowerCase();
    return /\bgit\s+(status|diff|show)\b/.test(text);
}

function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

function toTile(x, y) {
    return worldToTile(x, y);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseColorRgba(value) {
    const text = String(value || '').trim();
    const hex = text.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const match = text.match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return null;
    return {
        r: clamp(parts[0] || 0, 0, 255),
        g: clamp(parts[1] || 0, 0, 255),
        b: clamp(parts[2] || 0, 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1,
    };
}

// #3 — Grade authority. Lerp a color string (hex or rgba) toward the active
// `grade.worldTint`, preserving the source alpha, so harbor anchorage glows
// pick up the time-of-day cast. Pure color transform with no time component —
// identical under reduced motion. Returns the input unchanged when it can't
// parse, or when no grade is supplied.
function gradeColorString(value, grade) {
    const base = parseColorRgba(value);
    const tint = parseColorRgba(grade?.worldTint);
    if (!base || !tint) return value;
    const w = clamp(tint.a, 0, 1);
    if (w <= 0) return value;
    const r = Math.round(base.r + (tint.r - base.r) * w);
    const g = Math.round(base.g + (tint.g - base.g) * w);
    const b = Math.round(base.b + (tint.b - base.b) * w);
    return `rgba(${r}, ${g}, ${b}, ${base.a})`;
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function eventBranch(event = {}) {
    return normalizeRepoBranch(event.branch || event.targetRef || '');
}

function trafficIdentity(project, branch = '') {
    return `${String(project || 'unknown')}\x1f${normalizeRepoBranch(branch)}`;
}

const HARBOR_CLEAN_LABEL_CACHE_LIMIT = 512;
const _cleanCommitLabelCache = new Map();

function boundedCacheValue(cache, key, create, limit) {
    if (cache.has(key)) return cache.get(key);
    const value = create();
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
}

// Repo profiles resolve live: RepoColor's visible-repo registry can move a
// repo's pennant when the on-screen set changes, so a private cache would
// keep a stale slot after a repo leaves and returns.
function trafficProfile(project, branch = '') {
    return repoBranchProfile(project, normalizeRepoBranch(branch));
}

function cachedCleanCommitSubject(value) {
    const key = String(value || '');
    return boundedCacheValue(
        _cleanCommitLabelCache,
        key,
        () => cleanCommitSubject(key),
        HARBOR_CLEAN_LABEL_CACHE_LIMIT,
    );
}

function trafficLabel(project, branch = '', maxChars = 26) {
    const normalizedBranch = normalizeRepoBranch(branch);
    const repo = displayRepoName(project, maxChars);
    if (!normalizedBranch) return repo;
    return `${repo}/${shortGitLabel(normalizedBranch, 14, '…')}`;
}

function boundedEventConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(1, numeric));
}

function gitEventSourceLabel(event = {}) {
    const explicit = event.source || event.eventSource || event.sourceType || event.origin || '';
    if (explicit) return String(explicit);
    if (event.command) return 'command-parser';
    return event.inferred === true ? 'inferred' : 'observed';
}

function gitEventStatusLabel(event = {}) {
    if (event.status) return String(event.status);
    if (event.success === true) return 'success';
    if (event.success === false) return 'failed';
    return 'unknown';
}

function gitEventRefLabel(event = {}, branch = '') {
    return String(event.ref || event.refspec || event.targetRef || branch || event.upstream || '');
}

function gitEventDebugMetadata(event = {}, branch = '') {
    const inferred = event.inferred === true;
    return {
        gitKind: event.type ? String(event.type) : '',
        eventStatus: gitEventStatusLabel(event),
        remote: event.remote ? String(event.remote) : '',
        ref: gitEventRefLabel(event, branch),
        refspec: event.refspec ? String(event.refspec) : '',
        source: gitEventSourceLabel(event),
        sourceId: event.sourceId ? String(event.sourceId) : '',
        confidence: boundedEventConfidence(event.confidence),
        inferred,
        observed: event.observed === true || (!inferred && event.observed !== false),
        sessionId: event.sessionId ? String(event.sessionId) : '',
        agentId: event.agentId ? String(event.agentId) : '',
        completedAt: Number(event.completedAt || event.completed_at || 0) || 0,
    };
}

function inboundGitLabel(event = {}, branch = '') {
    const type = event.type === 'fetch' ? 'fetch' : 'pull';
    const parts = [type, event.remote || '', event.targetRef || event.ref || event.refspec || branch || ''].filter(Boolean);
    return shortGitLabel(parts.join(' '), 22, '…') || type;
}

function rotateIndexes(indexes, offset) {
    const list = Array.isArray(indexes) ? indexes : [];
    if (list.length <= 1) return [...list];
    const start = Math.abs(offset || 0) % list.length;
    return [...list.slice(start), ...list.slice(0, start)];
}

function cloneState(previous = {}) {
    previous = previous || {};
    const seenEventIds = previous.seenEventIds instanceof Set
        ? new Set(previous.seenEventIds)
        : new Set(previous.seenEventIds || []);
    const sourceShips = previous.ships instanceof Map
        ? previous.ships.entries()
        : Object.entries(previous.ships || {});
    const ships = new Map();
    for (const [id, ship] of sourceShips) {
        ships.set(id, {
            ...ship,
            eventIds: Array.isArray(ship.eventIds) ? [...ship.eventIds] : [ship.id].filter(Boolean),
            route: compactRouteMetadata(ship.route),
            convoy: ship.convoy ? { ...ship.convoy } : null,
        });
    }
    const sourceBatches = previous.batches instanceof Map
        ? previous.batches.entries()
        : Object.entries(previous.batches || {});
    const batches = new Map();
    for (const [id, batch] of sourceBatches) {
        const next = {
            ...batch,
            shipIds: Array.isArray(batch.shipIds) ? [...batch.shipIds] : [],
            route: compactRouteMetadata(batch.route),
            convoy: batch.convoy ? { ...batch.convoy } : null,
        };
        if (Array.isArray(batch.sealedOriginPoints)) {
            next.sealedOriginPoints = batch.sealedOriginPoints.map(p => ({ x: p.x, y: p.y }));
        }
        batches.set(id, next);
    }
    const sourcePushEvents = previous.pushEvents instanceof Map
        ? previous.pushEvents.entries()
        : Object.entries(previous.pushEvents || {});
    const pushEvents = new Map();
    for (const [id, pushEvent] of sourcePushEvents) {
        pushEvents.set(id, { ...pushEvent });
    }
    const sourceRepoQuays = previous.repoQuays instanceof Map
        ? previous.repoQuays.entries()
        : Object.entries(previous.repoQuays || {});
    const repoQuays = new Map();
    for (const [project, quayIndex] of sourceRepoQuays) {
        repoQuays.set(project, Number.isFinite(Number(quayIndex)) ? Number(quayIndex) : 0);
    }
    const sourceSeenEventTimes = previous.seenEventTimes instanceof Map
        ? previous.seenEventTimes.entries()
        : Object.entries(previous.seenEventTimes || {});
    const seenEventTimes = new Map();
    for (const [id, timestamp] of sourceSeenEventTimes) {
        const value = Number(timestamp);
        if (id && Number.isFinite(value)) seenEventTimes.set(id, value);
    }
    const sourceEventTombstones = previous.eventTombstones instanceof Map
        ? previous.eventTombstones.entries()
        : Object.entries(previous.eventTombstones || {});
    const eventTombstones = new Map();
    for (const [id, tombstone] of sourceEventTombstones) {
        if (!id) continue;
        eventTombstones.set(id, typeof tombstone === 'object' && tombstone
            ? { ...tombstone }
            : { removedAt: Number(tombstone) || 0 });
    }
    const sourceCommitReplayFloors = previous.commitReplayFloors instanceof Map
        ? previous.commitReplayFloors.entries()
        : Object.entries(previous.commitReplayFloors || {});
    const commitReplayFloors = new Map();
    for (const [identity, floor] of sourceCommitReplayFloors) {
        const eventTime = Number(typeof floor === 'object' ? floor?.eventTime : floor);
        if (!identity || !Number.isFinite(eventTime) || eventTime <= 0) continue;
        commitReplayFloors.set(identity, typeof floor === 'object' && floor
            ? { ...floor, eventTime }
            : { eventTime, recordedAt: 0 });
    }
    const sourceOverflowDockCounts = previous.overflowDockCounts instanceof Map
        ? previous.overflowDockCounts.entries()
        : Object.entries(previous.overflowDockCounts || {});
    const overflowDockCounts = new Map();
    for (const [identity, overflow] of sourceOverflowDockCounts) {
        const count = Math.max(0, Number(overflow?.count || 0));
        if (!identity || count <= 0) continue;
        overflowDockCounts.set(identity, { ...overflow, count });
    }
    const sourceRepoAnchorages = previous.repoAnchorages instanceof Map
        ? previous.repoAnchorages.entries()
        : Object.entries(previous.repoAnchorages || {});
    const repoAnchorages = new Map();
    for (const [project, slot] of sourceRepoAnchorages) {
        const index = Number(slot);
        if (!project || !Number.isInteger(index) || index < 0 || index >= COAST_ANCHORAGE_SLOTS.length) continue;
        repoAnchorages.set(project, index);
    }
    return {
        seenEventIds,
        seenEventTimes,
        eventTombstones,
        commitReplayFloors,
        overflowDockCounts,
        ships,
        batches,
        pushEvents,
        repoQuays,
        repoAnchorages,
        nextSequence: Number.isFinite(previous.nextSequence) ? previous.nextSequence : ships.size,
        nextBatchSequence: Number.isFinite(previous.nextBatchSequence) ? previous.nextBatchSequence : batches.size,
    };
}

function repoAnchorageKey(project) {
    return String(project || 'unknown');
}

// Home Waters allocation lives in the semantic state so the dock layout, the
// push reducer (departure start tiles) and the buoy drawables all agree on
// which coastal slot a repo owns. First come keeps its slot until it has no
// docked ships and no live agent; slots are claimed in COAST_ANCHORAGE_SLOTS
// order so the fleet spreads along the coast. Returns the slot index or null
// when the pool is exhausted (the repo then docks in the Commit Lagoon).
function ensureRepoAnchorage(state, project) {
    const key = repoAnchorageKey(project);
    const existing = state.repoAnchorages.get(key);
    if (Number.isInteger(existing)) return existing;
    const used = new Set(state.repoAnchorages.values());
    for (let slot = 0; slot < COAST_ANCHORAGE_SLOTS.length; slot++) {
        if (used.has(slot)) continue;
        state.repoAnchorages.set(key, slot);
        return slot;
    }
    return null;
}

function repoAnchorageSlot(state, project) {
    const slot = state?.repoAnchorages?.get?.(repoAnchorageKey(project));
    return Number.isInteger(slot) ? slot : null;
}

function syncRepoAnchorages(state, activeProjects = null) {
    const keep = new Set();
    for (const ship of state.ships.values()) {
        if (ship.status === 'docked') keep.add(repoAnchorageKey(ship.project));
    }
    for (const project of activeProjects || []) keep.add(repoAnchorageKey(project));
    for (const key of [...state.repoAnchorages.keys()]) {
        if (!keep.has(key)) state.repoAnchorages.delete(key);
    }
    for (const key of keep) ensureRepoAnchorage(state, key);
}

function markHarborEventSeen(state, event, now) {
    if (!event?.id) return;
    state.seenEventIds.add(event.id);
    const eventTime = Number(event.timestamp);
    state.seenEventTimes.set(event.id, Number.isFinite(eventTime) && eventTime > 0 ? eventTime : now);
}

function harborEventStatus(event = {}) {
    return String(event.status || gitEventStatusLabel(event) || 'unknown').toLowerCase();
}

function tombstoneHarborEvent(state, event, now, overrides = {}) {
    const id = typeof event === 'string' ? event : event?.id;
    if (!id) return;
    const source = typeof event === 'object' && event ? event : {};
    const eventTime = Number(overrides.eventTime ?? source.timestamp ?? source.eventTime ?? 0) || 0;
    const tombstone = {
        type: String(overrides.type || source.type || ''),
        status: String(overrides.status || source.status || ''),
        eventTime,
        removedAt: now,
    };
    state.eventTombstones.delete(id);
    state.eventTombstones.set(id, tombstone);
    while (state.eventTombstones.size > MAX_HARBOR_EVENT_TOMBSTONES) {
        state.eventTombstones.delete(state.eventTombstones.keys().next().value);
    }
}

function harborEventIsTombstoned(state, event) {
    const tombstone = state.eventTombstones.get(event?.id);
    if (!tombstone) return false;
    if (event.type !== 'push') return true;
    if (tombstone.type && tombstone.type !== 'push') return false;
    return String(tombstone.status || 'unknown').toLowerCase() === harborEventStatus(event);
}

function recordCommitReplayFloor(state, project, branch, eventTime, now) {
    const timestamp = Number(eventTime);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const identity = trafficIdentity(project, branch);
    const previous = state.commitReplayFloors.get(identity);
    const next = {
        eventTime: Math.max(timestamp, Number(previous?.eventTime || 0)),
        recordedAt: now,
    };
    state.commitReplayFloors.delete(identity);
    state.commitReplayFloors.set(identity, next);
    while (state.commitReplayFloors.size > MAX_HARBOR_COMMIT_REPLAY_FLOORS) {
        state.commitReplayFloors.delete(state.commitReplayFloors.keys().next().value);
    }
}

function latestProjectCommitReplayFloor(state, project) {
    const prefix = `${String(project || 'unknown')}\x1f`;
    let latest = 0;
    for (const [identity, floor] of state.commitReplayFloors) {
        if (!identity.startsWith(prefix)) continue;
        latest = Math.max(latest, Number(floor?.eventTime || 0));
    }
    return latest;
}

function commitIsAtOrBelowReplayFloor(state, event) {
    const eventTime = Number(event?.timestamp);
    if (!Number.isFinite(eventTime) || eventTime <= 0) return false;
    const branch = eventBranch(event);
    const exact = Number(state.commitReplayFloors.get(trafficIdentity(event.project, branch))?.eventTime || 0);
    const projectWide = Number(state.commitReplayFloors.get(trafficIdentity(event.project, ''))?.eventTime || 0);
    const floor = Math.max(exact, projectWide, branch ? 0 : latestProjectCommitReplayFloor(state, event.project));
    return floor > 0 && eventTime <= floor;
}

function mergeHarborOverflowRecord(target, source, now) {
    target.count = Math.max(0, Number(target.count || 0)) + Math.max(0, Number(source.count || 0));
    target.failedCount = Math.max(0, Number(target.failedCount || 0)) + Math.max(0, Number(source.failedCount || 0));
    const earliest = [target.earliestEventTime, source.earliestEventTime]
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
    target.earliestEventTime = earliest.length ? Math.min(...earliest) : 0;
    target.latestEventTime = Math.max(Number(target.latestEventTime || 0), Number(source.latestEventTime || 0));
    target.updatedAt = now;
    return target;
}

function foldHarborOverflowRecord(state, record, now) {
    const other = state.overflowDockCounts.get(HARBOR_OVERFLOW_OTHER_KEY) || {
        project: 'Additional repositories',
        branch: '',
        waitingZone: 'harbor',
        quayIndex: 0,
        count: 0,
        failedCount: 0,
        earliestEventTime: 0,
        latestEventTime: 0,
        aggregate: true,
    };
    state.overflowDockCounts.delete(HARBOR_OVERFLOW_OTHER_KEY);
    state.overflowDockCounts.set(HARBOR_OVERFLOW_OTHER_KEY, mergeHarborOverflowRecord(other, record, now));
}

function pruneHarborOverflowDockCounts(state, now) {
    while (state.overflowDockCounts.size > MAX_HARBOR_OVERFLOW_DOCK_COUNTS) {
        const entry = [...state.overflowDockCounts.entries()]
            .find(([identity]) => identity !== HARBOR_OVERFLOW_OTHER_KEY);
        if (!entry) break;
        state.overflowDockCounts.delete(entry[0]);
        foldHarborOverflowRecord(state, entry[1], now);
    }
}

function recordHarborDockOverflow(state, ship, now) {
    const project = String(ship?.project || 'unknown');
    const branch = normalizeRepoBranch(ship?.branch || ship?.targetRef || '');
    const waitingZone = ship?.waitingZone || 'harbor';
    const identity = `${trafficIdentity(project, branch)}\x1f${waitingZone}`;
    const eventTime = Number(ship?.eventTime || 0);
    const record = state.overflowDockCounts.get(identity) || {
        project,
        branch,
        waitingZone,
        quayIndex: Number.isFinite(Number(ship?.quayIndex)) ? Number(ship.quayIndex) : 0,
        count: 0,
        failedCount: 0,
        earliestEventTime: eventTime,
        latestEventTime: eventTime,
        aggregate: false,
    };
    mergeHarborOverflowRecord(record, {
        count: 1,
        failedCount: ship?.pushStatus === 'failed' ? 1 : 0,
        earliestEventTime: eventTime,
        latestEventTime: eventTime,
    }, now);
    state.overflowDockCounts.delete(identity);
    if (state.overflowDockCounts.size >= MAX_HARBOR_OVERFLOW_DOCK_COUNTS) {
        foldHarborOverflowRecord(state, record, now);
    } else {
        state.overflowDockCounts.set(identity, record);
    }
    pruneHarborOverflowDockCounts(state, now);
}

function clearHarborDockOverflowForPush(state, event, pushTime) {
    for (const [identity, record] of state.overflowDockCounts) {
        if (record.aggregate || !pushEventMatchesShip(event, record)) continue;
        const latest = Number(record.latestEventTime || 0);
        if (!pushTime || !latest || latest <= pushTime) state.overflowDockCounts.delete(identity);
    }
}

function harborOverflowDockCount(state) {
    let total = 0;
    for (const record of state?.overflowDockCounts?.values?.() || []) {
        total += Math.max(0, Number(record?.count || 0));
    }
    return total;
}

function latestShipEventTime(state, ship) {
    let latest = Number(ship?.eventTime || 0);
    for (const id of ship?.eventIds || []) {
        latest = Math.max(latest, Number(state.seenEventTimes.get(id) || 0));
    }
    return latest;
}

function retireHarborShip(state, id, ship, now, { recordFloor = true } = {}) {
    if (!ship) return;
    const ids = new Set([ship.id, ...(ship.eventIds || [])].filter(Boolean));
    const eventTime = latestShipEventTime(state, ship);
    const type = ship.gitKind || (ship.isInbound ? ship.arrivingKind : 'commit') || '';
    for (const eventId of ids) {
        tombstoneHarborEvent(state, eventId, now, {
            type,
            eventTime: Number(state.seenEventTimes.get(eventId) || eventTime || 0),
        });
    }
    if (recordFloor && type === 'commit') {
        recordCommitReplayFloor(state, ship.project, ship.branch || ship.targetRef || '', eventTime, now);
    }
    state.ships.delete(id);
}

function harborLiveEventIds(state) {
    const ids = new Set();
    for (const ship of state.ships.values()) {
        if (ship.id) ids.add(ship.id);
        for (const id of ship.eventIds || []) if (id) ids.add(id);
        if (ship.pushEventId) ids.add(ship.pushEventId);
        if (ship.departEventId) ids.add(ship.departEventId);
    }
    for (const batch of state.batches.values()) {
        const id = String(batch.id || '').replace(/^push-batch:/, '');
        if (id) ids.add(id);
    }
    return ids;
}

function pruneHarborReplayState(state, now) {
    const liveIds = harborLiveEventIds(state);
    const cutoff = now - HARBOR_REPLAY_RETENTION_MS;

    for (const [id, push] of state.pushEvents) {
        const timestamp = Number(push.eventTime || push.seenAt || 0);
        if (!liveIds.has(id) && (!Number.isFinite(timestamp) || timestamp < cutoff)) {
            tombstoneHarborEvent(state, id, now, { type: 'push', status: push.status, eventTime: timestamp });
            state.pushEvents.delete(id);
        }
    }
    if (state.pushEvents.size > MAX_HARBOR_PUSH_EVENTS) {
        const removable = [...state.pushEvents.entries()].sort((a, b) => (
            Number(liveIds.has(a[0])) - Number(liveIds.has(b[0]))
            || Number(a[1]?.eventTime || a[1]?.seenAt || 0) - Number(b[1]?.eventTime || b[1]?.seenAt || 0)
            || a[0].localeCompare(b[0])
        ));
        let excess = state.pushEvents.size - MAX_HARBOR_PUSH_EVENTS;
        for (const [id, push] of removable) {
            if (excess <= 0) break;
            excess--;
            tombstoneHarborEvent(state, id, now, {
                type: 'push',
                status: push.status,
                eventTime: Number(push.eventTime || push.seenAt || 0),
            });
            state.pushEvents.delete(id);
        }
    }

    for (const id of state.seenEventIds) {
        const timestamp = Number(state.seenEventTimes.get(id) || 0);
        if (!liveIds.has(id) && (!Number.isFinite(timestamp) || timestamp < cutoff)) {
            tombstoneHarborEvent(state, id, now, { eventTime: timestamp });
            state.seenEventIds.delete(id);
            state.seenEventTimes.delete(id);
        }
    }
    if (state.seenEventIds.size > MAX_HARBOR_SEEN_EVENT_IDS) {
        const removable = [...state.seenEventIds].sort((a, b) => (
            Number(liveIds.has(a)) - Number(liveIds.has(b))
            || Number(state.seenEventTimes.get(a) || 0) - Number(state.seenEventTimes.get(b) || 0)
            || a.localeCompare(b)
        ));
        let excess = state.seenEventIds.size - MAX_HARBOR_SEEN_EVENT_IDS;
        for (const id of removable) {
            if (excess <= 0) break;
            excess--;
            tombstoneHarborEvent(state, id, now, { eventTime: Number(state.seenEventTimes.get(id) || 0) });
            state.seenEventIds.delete(id);
            state.seenEventTimes.delete(id);
        }
    }
    for (const id of state.seenEventTimes.keys()) {
        if (!state.seenEventIds.has(id)) state.seenEventTimes.delete(id);
    }
    while (state.eventTombstones.size > MAX_HARBOR_EVENT_TOMBSTONES) {
        state.eventTombstones.delete(state.eventTombstones.keys().next().value);
    }
    while (state.commitReplayFloors.size > MAX_HARBOR_COMMIT_REPLAY_FLOORS) {
        state.commitReplayFloors.delete(state.commitReplayFloors.keys().next().value);
    }
    pruneHarborOverflowDockCounts(state, now);
}

function harborShipRetentionRank(ship) {
    if (ship?.status === 'departing' || ship?.status === 'rejecting' || ship?.status === 'cancelling') return 3;
    if (ship?.status === 'docked') return 2;
    if (ship?.status === 'arriving') return 1;
    return 0;
}

function pruneHarborShips(state, now) {
    for (const ship of state.ships.values()) {
        if (!Array.isArray(ship.eventIds) || ship.eventIds.length <= MAX_HARBOR_EVENT_IDS_PER_SHIP) continue;
        const excess = ship.eventIds.splice(0, ship.eventIds.length - MAX_HARBOR_EVENT_IDS_PER_SHIP);
        for (const id of excess) {
            tombstoneHarborEvent(state, id, now, { type: ship.gitKind || 'commit', eventTime: state.seenEventTimes.get(id) });
        }
    }
    if (state.ships.size <= MAX_HARBOR_SHIPS) return;
    const removable = [...state.ships.entries()].sort((a, b) => (
        harborShipRetentionRank(a[1]) - harborShipRetentionRank(b[1])
        || Number(a[1]?.eventTime || a[1]?.createdAt || 0) - Number(b[1]?.eventTime || b[1]?.createdAt || 0)
        || a[0].localeCompare(b[0])
    ));
    let excess = state.ships.size - MAX_HARBOR_SHIPS;
    for (const [id, ship] of removable) {
        if (excess <= 0) break;
        excess--;
        if (ship.status === 'docked' && ship.gitKind === 'commit') {
            recordHarborDockOverflow(state, ship, now);
        }
        retireHarborShip(state, id, ship, now);
    }
}

function pruneHarborBatches(state) {
    for (const batch of state.batches.values()) {
        batch.shipIds = (batch.shipIds || []).filter(id => state.ships.has(id)).slice(0, MAX_HARBOR_SHIPS);
        batch.shipCount = batch.shipIds.length;
    }
    if (state.batches.size <= MAX_HARBOR_BATCHES) return;
    const removable = [...state.batches.entries()].sort((a, b) => (
        Number((a[1]?.shipIds || []).some(id => state.ships.has(id)))
        - Number((b[1]?.shipIds || []).some(id => state.ships.has(id)))
        || Number(a[1]?.startedAt || a[1]?.eventTime || 0) - Number(b[1]?.startedAt || b[1]?.eventTime || 0)
        || a[0].localeCompare(b[0])
    ));
    let excess = state.batches.size - MAX_HARBOR_BATCHES;
    for (const [id] of removable) {
        if (excess <= 0) break;
        excess--;
        state.batches.delete(id);
    }
}

function pruneHarborRepoQuays(state) {
    if (state.repoQuays.size <= MAX_HARBOR_REPO_QUAYS) return;
    const liveProjects = new Set([...state.ships.values()].map(ship => String(ship.project || 'unknown')));
    const removable = [...state.repoQuays.keys()].sort((a, b) => (
        Number(liveProjects.has(String(a))) - Number(liveProjects.has(String(b)))
        || String(a).localeCompare(String(b))
    ));
    let excess = state.repoQuays.size - MAX_HARBOR_REPO_QUAYS;
    for (const project of removable) {
        if (excess <= 0) break;
        excess--;
        state.repoQuays.delete(project);
    }
}

function assignedQuayIndex(state, project) {
    const key = String(project || 'unknown');
    const existing = state.repoQuays.get(key);
    if (Number.isFinite(existing)) return existing;

    const preferred = stableHash(key) % QUAY_GROUPS.length;
    const loads = QUAY_GROUPS.map((_, index) => {
        let load = 0;
        for (const ship of state.ships.values()) {
            if (ship.quayIndex === index && ship.status === 'docked') load += 1;
        }
        for (const [project, quayIndex] of state.repoQuays.entries()) {
            if (String(project || 'unknown') === key) continue;
            if (quayIndex === index) load += 0.35;
        }
        return load;
    });

    let chosen = preferred;
    for (let i = 1; i < QUAY_GROUPS.length; i++) {
        const candidate = (preferred + i) % QUAY_GROUPS.length;
        if (loads[candidate] < loads[chosen]) chosen = candidate;
    }
    state.repoQuays.set(key, chosen);
    while (state.repoQuays.size > MAX_HARBOR_REPO_QUAYS) {
        const oldest = state.repoQuays.keys().next().value;
        if (oldest === key && state.repoQuays.size > 1) {
            const nextOldest = [...state.repoQuays.keys()][1];
            state.repoQuays.delete(nextOldest);
        } else {
            state.repoQuays.delete(oldest);
        }
    }
    return chosen;
}

function chooseBerthIndex(state, project, occupiedBerths = null) {
    const quayIndex = assignedQuayIndex(state, project);
    const key = String(project || 'unknown');
    const occupied = occupiedBerths || new Set();
    if (!occupiedBerths) {
        for (const ship of state.ships.values()) {
            if (Number.isFinite(Number(ship.berthIndex))) occupied.add(Number(ship.berthIndex));
        }
    }
    const otherRepoQuays = new Set();
    for (const [assignedProject, assignedQuay] of state.repoQuays.entries()) {
        if (String(assignedProject || 'unknown') !== key) otherRepoQuays.add(assignedQuay);
    }

    const preferredGroup = QUAY_GROUPS[quayIndex] || QUAY_GROUPS[0];
    for (const berthIndex of rotateIndexes(preferredGroup.berthIndexes, state.nextSequence)) {
        if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
    }

    for (let offset = 1; offset < QUAY_GROUPS.length; offset++) {
        const nextQuayIndex = (quayIndex + offset) % QUAY_GROUPS.length;
        if (otherRepoQuays.has(nextQuayIndex)) continue;
        const group = QUAY_GROUPS[nextQuayIndex];
        for (const berthIndex of rotateIndexes(group.berthIndexes, state.nextSequence)) {
            if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
        }
    }

    for (let offset = 1; offset < QUAY_GROUPS.length; offset++) {
        const group = QUAY_GROUPS[(quayIndex + offset) % QUAY_GROUPS.length];
        for (const berthIndex of rotateIndexes(group.berthIndexes, state.nextSequence)) {
            if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
        }
    }

    return {
        berthIndex: state.nextSequence % BERTHS.length,
        quayIndex,
    };
}

function latestPushTimesByProject(events) {
    const latest = new Map();
    for (const event of events) {
        if (event?.type !== 'push' || !event.project || !Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
        if (!pushMarksCommitsLanded(event)) continue;
        const key = trafficIdentity(event.project, eventBranch(event));
        const previous = latest.get(key) || 0;
        if (event.timestamp > previous) latest.set(key, event.timestamp);
    }
    return latest;
}

function pushMarksCommitsLanded(event = {}) {
    if (event.status === 'success' || event.success === true) return true;
    const exitCode = event.exitCode ?? event.exit_code;
    return exitCode != null && Number.isFinite(Number(exitCode)) && Number(exitCode) === 0;
}

// 8.2 — the release sloop's partial reveal (arrival and last stretch): a copy
// of its hull strip keeping only the texels whose 4×4 Bayer order is under
// `level` (1/4, 2/4, 3/4), so the hull and its reflection come and go in
// whole palette texels at full strength instead of a translucent ghost.
// Cached per strip image and level; `liveryKey` gives each its own texture.
const _revealStrips = new WeakMap();

function releaseRevealStrip(strip, level) {
    let levels = _revealStrips.get(strip.image);
    if (!levels) {
        levels = new Map();
        _revealStrips.set(strip.image, levels);
    }
    const keep = Math.round(level * 16);
    if (levels.has(keep)) return levels.get(keep);
    let revealed = strip;
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = strip.image.width;
        canvas.height = strip.image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(strip.image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = data.data;
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                if (RELEASE_SAIL_BAYER4[((y & 3) << 2) | (x & 3)] >= keep) px[(y * canvas.width + x) * 4 + 3] = 0;
            }
        }
        ctx.putImageData(data, 0, 0);
        revealed = { ...strip, image: canvas, liveryKey: `${strip.liveryKey || strip.spriteId}|reveal${keep}` };
    }
    levels.set(keep, revealed);
    return revealed;
}

// 8.2 — the release sloop's one cream peak frame: a 1-texel rim around its
// sails (every texel above the deck that is not cloth but touches the pale,
// unsaturated cloth), per roll frame of the hull strip, in the peak cream.
// The cloth is cream already, so the rim sits outside it. Cached per strip
// image and frame as `{ canvas, runs }`: the rim stamp, and the same texels
// as row runs `[x, y, width, ...]` (10.2 hands them to the GPU mark pass).
const _sailOutlines = new WeakMap();

function releaseSailOutline(strip, frame) {
    let frames = _sailOutlines.get(strip.image);
    if (!frames) {
        frames = new Map();
        _sailOutlines.set(strip.image, frames);
    }
    if (frames.has(frame)) return frames.get(frame);
    let outline = null;
    if (typeof document !== 'undefined') {
        const w = strip.frameWidth;
        const h = strip.frameHeight;
        const source = document.createElement('canvas');
        source.width = w;
        source.height = h;
        const sctx = source.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(strip.image, frame * w, 0, w, h, 0, 0, w, h);
        const data = sctx.getImageData(0, 0, w, h).data;
        const cloth = new Uint8Array(w * h);
        // The deck and waterline rows (the lip is pale too) stay out.
        const lastRow = Math.max(0, strip.anchorY - 3);
        for (let y = 0; y < lastRow; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (data[i + 3] < 128) continue;
                const lo = Math.min(data[i], data[i + 1], data[i + 2]);
                const hi = Math.max(data[i], data[i + 1], data[i + 2]);
                if (lo >= 0x80 && hi - lo <= 70) cloth[y * w + x] = 1;
            }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = PEAK;
        const runs = [];
        const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && cloth[y * w + x] === 1;
        for (let y = 0; y < lastRow; y++) {
            for (let x = 0; x < w; x++) {
                if (cloth[y * w + x]) continue;
                if (!at(x - 1, y) && !at(x + 1, y) && !at(x, y - 1) && !at(x, y + 1)) continue;
                ctx.fillRect(x, y, 1, 1);
                const last = runs.length - 3;
                if (last >= 0 && runs[last + 1] === y && runs[last] + runs[last + 2] === x) runs[last + 2]++;
                else runs.push(x, y, 1);
            }
        }
        outline = { canvas, runs };
    }
    frames.set(frame, outline);
    return outline;
}

function pointAlongPath(points, progress) {
    if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];

    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        lengths.push(length);
        total += length;
    }
    if (total <= 0) return points[points.length - 1];

    let remaining = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 1; i < points.length; i++) {
        const length = lengths[i - 1];
        if (remaining <= length || i === points.length - 1) {
            const a = points[i - 1];
            const b = points[i];
            const t = length <= 0 ? 1 : remaining / length;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        remaining -= length;
    }

    return points[points.length - 1];
}

function compareDockedShips(a, b) {
    const aFailed = a?.pushStatus === 'failed' ? 1 : 0;
    const bFailed = b?.pushStatus === 'failed' ? 1 : 0;
    return (bFailed - aFailed)
        || ((b?.eventTime || 0) - (a?.eventTime || 0))
        || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function compareDepartingShips(a, b) {
    return ((a?.eventTime || 0) - (b?.eventTime || 0))
        || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function releaseConvoyMetadata(event, branch, selectedShips = [], status = 'unknown', forceFlag = null) {
    if (status !== 'success' || forceFlag === true) return null;
    if (!Array.isArray(selectedShips) || selectedShips.length < RELEASE_CONVOY_MIN_SHIPS) return null;
    const profile = trafficProfile(event.project, branch);
    return {
        id: `release-convoy:${event.id}`,
        mode: 'release-convoy',
        project: event.project,
        branch: branch || '',
        repoName: profile.shortName,
        label: 'Release convoy',
        count: selectedShips.length,
        leaderShipId: selectedShips[0]?.id || '',
        pushEventId: event.id,
        routeId: '',
    };
}

function dockSquadDensity(totalDocked, squadCount, shipCount) {
    return Math.max(
        Math.min(1, totalDocked / 14),
        Math.min(1, squadCount / 6),
        Math.min(1, shipCount / 4)
    );
}

function harborShipClassFormationSpacing(shipClass = {}) {
    const wakeScale = Math.max(0.85, Number(shipClass.wakeScale || 1));
    return Math.max(1.05, Math.min(2.28, 0.82 + wakeScale * 0.56));
}

function dockSquadFormationSpacing(ships = [], repoDockOffset = 0, repoDockCount = ships.length) {
    return ships.reduce((spacing, ship, shipIndex) => (
        Math.max(spacing, harborShipClassFormationSpacing(harborShipClass({
            ...ship,
            repoDockIndex: repoDockOffset + shipIndex,
            repoDockCount,
            repoDockVisibleCount: ships.length,
        })))
    ), 1);
}

function anchoragesForWaitingZone(waitingZone) {
    return isCommitLagoonZone(waitingZone)
        ? COMMIT_LAGOON_SQUAD_ANCHORAGES
        : HARBOR_SQUAD_ANCHORAGES;
}

function harborShipCollisionRadius(ship = {}) {
    const shipClass = harborShipClass(ship);
    const wakeScale = Math.max(0.85, Number(shipClass.wakeScale || 1));
    return Math.max(34, Math.min(66, 22 + wakeScale * 16));
}

function isCommitLagoonZone(zone) {
    return zone === 'commit-lagoon';
}

function isCoastZone(zone) {
    return zone === COAST_ANCHORAGE_ZONE;
}

function dockWaterBounds(entry = {}) {
    const zone = entry.waitingZone || entry.departWaterZone;
    if (isCommitLagoonZone(zone)) return COMMIT_LAGOON_WATER_BOUNDS;
    if (isCoastZone(zone)) return COAST_WATER_BOUNDS;
    return HARBOR_DOCK_WATER_BOUNDS;
}

function dockWaterRegions(entry = {}) {
    const zone = entry.waitingZone || entry.departWaterZone;
    if (isCommitLagoonZone(zone)) return COMMIT_LAGOON_WATER_REGIONS;
    if (isCoastZone(zone)) return COAST_WATER_REGIONS;
    return HARBOR_DOCK_WATER_REGIONS;
}

function dockShipWaterBounds(entry = {}) {
    const radius = Math.max(34, Number(entry.collisionRadius) || 42);
    const margin = clamp((radius - 34) / 64, 0, 0.62);
    const bounds = dockWaterBounds(entry);
    return {
        minTileX: bounds.minTileX + margin * 0.40,
        maxTileX: bounds.maxTileX - margin * 0.92,
        minTileY: bounds.minTileY + margin * 0.32,
        maxTileY: bounds.maxTileY - margin * 0.50,
    };
}

function harborWaterRegionScore(tile, region) {
    const dx = (tile.tileX - region.centerX) / region.radiusX;
    const dy = (tile.tileY - region.centerY) / region.radiusY;
    return dx * dx + dy * dy;
}

function projectTileIntoHarborRegion(tile, region) {
    const score = harborWaterRegionScore(tile, region);
    if (score <= region.limit) return tile;

    const scale = Math.sqrt(region.limit / Math.max(score, 0.0001));
    return {
        tileX: region.centerX + (tile.tileX - region.centerX) * scale,
        tileY: region.centerY + (tile.tileY - region.centerY) * scale,
    };
}

function clampDockTileToHarborWater(tile, entry = {}) {
    const bounds = dockShipWaterBounds(entry);
    let next = {
        tileX: clamp(Number(tile.tileX) || bounds.maxTileX, bounds.minTileX, bounds.maxTileX),
        tileY: clamp(Number(tile.tileY) || bounds.maxTileY, bounds.minTileY, bounds.maxTileY),
    };

    const regions = dockWaterRegions(entry);
    let bestRegion = regions[0];
    let bestScore = Infinity;
    for (const region of regions) {
        const score = harborWaterRegionScore(next, region);
        if (score < bestScore) {
            bestScore = score;
            bestRegion = region;
        }
        if (score <= region.limit) return next;
    }

    next = projectTileIntoHarborRegion(next, bestRegion);
    return {
        tileX: clamp(next.tileX, bounds.minTileX, bounds.maxTileX),
        tileY: clamp(next.tileY, bounds.minTileY, bounds.maxTileY),
    };
}

function clampDockShipToHarborWater(entry = {}) {
    const tile = clampDockTileToHarborWater(toTile(entry.x, entry.y), entry);
    const world = toWorld(tile.tileX, tile.tileY);
    entry.x = world.x;
    entry.y = world.y;
    entry.tileX = tile.tileX;
    entry.tileY = tile.tileY;
}

function dockSquadCycleOffset(squadCycle = 0, anchorIndex = 0) {
    const cycle = Math.max(0, Math.floor(Number(squadCycle) || 0));
    if (cycle <= 0) return { tileX: 0, tileY: 0 };

    const patternIndex = (cycle - 1 + Math.max(0, Number(anchorIndex) || 0)) % HARBOR_SQUAD_REUSE_OFFSETS.length;
    const ring = Math.floor((cycle - 1) / HARBOR_SQUAD_REUSE_OFFSETS.length);
    const offset = HARBOR_SQUAD_REUSE_OFFSETS[patternIndex];
    const ringSpread = 1 + Math.min(2, ring) * 0.34;
    return {
        tileX: offset.tileX * ringSpread,
        tileY: offset.tileY * ringSpread,
    };
}

function dockSquadFormationTile(anchor, shipIndex, shipCount, squadCycle = 0, key = '', spacing = 1, anchorIndex = 0) {
    const columns = Math.max(1, Math.min(Number(anchor.columns) || 1, shipCount));
    const column = shipIndex % columns;
    const row = Math.floor(shipIndex / columns);
    const columnCenter = (columns - 1) / 2;
    const spacingScale = Math.max(0.9, Number(spacing) || 1);
    const jitterSeed = stableHash(`${key}:${shipIndex}`);
    const jitter = shipCount > 1 ? ((jitterSeed % 9) - 4) * 0.01 : 0;
    const cycleOffset = dockSquadCycleOffset(squadCycle, anchorIndex);
    return {
        tileX: anchor.tileX
            + (column - columnCenter) * (anchor.columnDx || 0) * spacingScale
            + row * (anchor.rowDx || 0) * spacingScale
            + cycleOffset.tileX
            + jitter,
        tileY: anchor.tileY
            + (column - columnCenter) * (anchor.columnDy || 0) * spacingScale
            + row * (anchor.rowDy || 0) * spacingScale
            + cycleOffset.tileY
            - jitter,
        column,
        row,
        columns,
    };
}

function relaxDockShipLayout(entries = []) {
    if (!Array.isArray(entries) || !entries.length) return;
    for (const entry of entries) clampDockShipToHarborWater(entry);
    if (entries.length <= 1) return;

    for (let iteration = 0; iteration < 14; iteration++) {
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const a = entries[i];
                const b = entries[j];
                const minDistance = Math.max(a.collisionRadius || 42, b.collisionRadius || 42);
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const distance = Math.hypot(dx, dy);
                if (distance >= minDistance) continue;
                const fallbackAngle = ((stableHash(`${a.id}:${b.id}:dock-relax`) % 628) / 100);
                const ux = distance > 0.001 ? dx / distance : Math.cos(fallbackAngle);
                const uy = distance > 0.001 ? dy / distance : Math.sin(fallbackAngle) * 0.55;
                const push = (minDistance - distance) * 0.52;
                a.x -= ux * push;
                a.y -= uy * push;
                b.x += ux * push;
                b.y += uy * push;
            }
        }
        for (const entry of entries) clampDockShipToHarborWater(entry);
    }

    for (const entry of entries) {
        const tile = clampDockTileToHarborWater(toTile(entry.x, entry.y), entry);
        const world = toWorld(tile.tileX, tile.tileY);
        entry.x = world.x;
        entry.y = world.y;
        entry.tileX = tile.tileX;
        entry.tileY = tile.tileY;
    }
}

// 5.5 — memo for buildDockSquadLayout. relaxDockShipLayout runs up to 14 iterations
// per call; on first-paint replay (200 unpushed commits across 8 repos) the same
// ship set + status set repeats across many ticks. Key is the sorted ship-id list +
// per-ship status/pushStatus/eventTime + the repo→anchorage allocation; cap at
// 32 entries (drop oldest on overflow).
const DOCK_SQUAD_LAYOUT_CACHE_SIZE = 32;
const _dockSquadLayoutCache = new Map();

function dockSquadLayoutCacheKey(state) {
    const ships = state?.ships;
    if (!ships) return '';
    const ids = [];
    const meta = [];
    const iterable = ships instanceof Map
        ? ships.values()
        : Object.values(ships || {});
    for (const ship of iterable) {
        if (!ship || !ship.id || ship.status !== 'docked') continue;
        ids.push(ship.id);
        meta.push(`${ship.id}:${ship.pushStatus || ''}:${ship.eventTime || 0}`);
    }
    if (!ids.length) return 'empty';
    ids.sort();
    meta.sort();
    const anchorages = [];
    for (const [project, slot] of state?.repoAnchorages?.entries?.() || []) anchorages.push(`${project}=${slot}`);
    anchorages.sort();
    return `${ids.join('|')}#${meta.join(',')}#${anchorages.join(',')}`;
}

function buildDockSquadLayout(state) {
    const cacheKey = dockSquadLayoutCacheKey(state);
    if (cacheKey) {
        const cached = _dockSquadLayoutCache.get(cacheKey);
        if (cached) {
            // refresh LRU order
            _dockSquadLayoutCache.delete(cacheKey);
            _dockSquadLayoutCache.set(cacheKey, cached);
            return cached;
        }
    }
    const layout = _buildDockSquadLayoutFresh(state);
    if (cacheKey) {
        _dockSquadLayoutCache.set(cacheKey, layout);
        if (_dockSquadLayoutCache.size > DOCK_SQUAD_LAYOUT_CACHE_SIZE) {
            const oldest = _dockSquadLayoutCache.keys().next().value;
            if (oldest !== undefined) _dockSquadLayoutCache.delete(oldest);
        }
    }
    return layout;
}

function dockedShipNeedsIndividualVisual(ship = {}) {
    return ship.pushStatus === 'failed'
        || ship.pushStatus === 'rejected'
        || ship.pushStatus === 'cancelled'
        || ship.pushStatus === 'canceled'
        || ship.untetheredFlag
        || ship.detachedHead;
}

// Titan packing. `ships` is one repo/branch fleet in dock order. Fleets under
// HARBOR_TITAN_MIN_COMMITS keep one ship per commit; larger fleets collapse
// into ceil(n / MAX_HARBOR_SHIP_PACK_SIZE) balanced packs, each drawn as a
// single stack hull whose badge carries the exact count. Ships that need their
// own visual (failed/rejected/cancelled pushes, untethered, detached HEAD)
// always sail individually. Every pack's lead is its first ship; the rest are
// hidden behind that lead and inherit its position.
function planDockedVisualPacks(ships = []) {
    const regular = [];
    const special = [];
    ships.forEach((ship, index) => {
        (dockedShipNeedsIndividualVisual(ship) ? special : regular).push({ ship, index });
    });
    const toPack = (chunk) => ({
        ships: chunk.map(entry => entry.ship),
        lead: chunk[0].ship,
        size: chunk.length,
        startIndex: chunk[0].index,
        endIndex: chunk[chunk.length - 1].index,
    });
    const packs = [];
    if (regular.length >= HARBOR_TITAN_MIN_COMMITS) {
        const packCount = Math.ceil(regular.length / MAX_HARBOR_SHIP_PACK_SIZE);
        const base = Math.floor(regular.length / packCount);
        const extra = regular.length % packCount;
        let cursor = 0;
        for (let packIndex = 0; packIndex < packCount; packIndex++) {
            const size = base + (packIndex < extra ? 1 : 0);
            packs.push(toPack(regular.slice(cursor, cursor + size)));
            cursor += size;
        }
    } else {
        for (const entry of regular) packs.push(toPack([entry]));
    }
    for (const entry of special) packs.push(toPack([entry]));
    packs.sort((a, b) => a.startIndex - b.startIndex);
    return packs;
}

function coastFormationAnchor(slot = COAST_ANCHORAGE_SLOTS[0]) {
    return {
        ...slot,
        tileX: slot.tileX + (Number(slot.leadDx) || 0),
        tileY: slot.tileY + (Number(slot.leadDy) || 0),
    };
}

function dockSquadPackSpacing(squad) {
    return squad.packs.reduce((spacing, pack) => (
        Math.max(spacing, harborShipClassFormationSpacing(harborShipClass({
            ...pack.lead,
            repoDockIndex: pack.startIndex,
            repoDockCount: squad.repoDockCount,
            repoDockVisibleCount: squad.packs.length,
            visualPackSize: pack.size,
        })))
    ), 1);
}

function _buildDockSquadLayoutFresh(state) {
    const groups = new Map();
    let totalDocked = 0;
    for (const ship of state?.ships?.values?.() || []) {
        if (ship.status !== 'docked') continue;
        const profile = trafficProfile(ship.project, ship.branch);
        const group = groups.get(profile.key) || {
            key: profile.key,
            project: ship.project,
            branch: ship.branch || '',
            profile,
            quayIndex: Number.isFinite(Number(ship.quayIndex)) ? Number(ship.quayIndex) : assignedQuayIndex(state, ship.project),
            ships: [],
            failedCount: 0,
            latestEventTime: 0,
        };
        group.ships.push(ship);
        group.failedCount += ship.pushStatus === 'failed' ? 1 : 0;
        group.latestEventTime = Math.max(group.latestEventTime, ship.eventTime || 0);
        groups.set(profile.key, group);
        totalDocked += 1;
    }
    const repoGroups = [...groups.values()]
        .map((group) => ({
            ...group,
            ships: [...group.ships].sort(compareDockedShips),
            count: group.ships.length,
        }))
        .sort((a, b) => (a.quayIndex - b.quayIndex)
            || (b.failedCount - a.failedCount)
            || (b.count - a.count)
            || (b.latestEventTime - a.latestEventTime)
            || a.profile.name.localeCompare(b.profile.name));

    // Each repo/branch fleet is packed first, then routed either to its
    // project's coastal anchorage (every branch of a project shares one buoy and
    // one formation) or, when the coast is full, to the Commit Lagoon in squads
    // of up to MAX_SHIPS_PER_SQUAD_ANCHORAGE visible packs.
    const squads = [];
    const fleets = new Map();
    const makeSquad = (group, packs, extra) => {
        const ships = packs.flatMap(pack => pack.ships);
        const dockIndexById = new Map();
        group.ships.forEach((ship, index) => dockIndexById.set(ship.id, index));
        return {
            ...group,
            ships,
            packs,
            dockIndexById,
            count: ships.length,
            repoDockCount: group.ships.length,
            repoTotalDockCount: group.ships.length,
            repoDockOffset: packs[0]?.startIndex || 0,
            failedCount: ships.filter(ship => ship.pushStatus === 'failed').length,
            latestEventTime: ships.reduce((max, ship) => Math.max(max, ship.eventTime || 0), 0),
            ...extra,
        };
    };
    repoGroups.forEach((group, repoGroupIndex) => {
        const packs = planDockedVisualPacks(group.ships);
        if (!packs.length) return;
        const slot = repoAnchorageSlot(state, group.project);
        if (slot != null) {
            const fleetKey = repoAnchorageKey(group.project);
            const fleet = fleets.get(fleetKey) || { key: fleetKey, slot, squads: [] };
            const squad = makeSquad(group, packs, {
                waitingZone: COAST_ANCHORAGE_SLOTS[slot].zone || COAST_ANCHORAGE_ZONE,
                repoGroupIndex,
                repoSegmentIndex: 0,
                repoSegmentCount: 1,
                segmentKey: `${group.key}:${COAST_ANCHORAGE_ZONE}:segment:0`,
            });
            fleet.squads.push(squad);
            fleets.set(fleetKey, fleet);
            squads.push(squad);
            return;
        }
        const repoSegmentCount = Math.max(1, Math.ceil(packs.length / MAX_SHIPS_PER_SQUAD_ANCHORAGE));
        for (let repoSegmentIndex = 0; repoSegmentIndex < repoSegmentCount; repoSegmentIndex++) {
            const start = repoSegmentIndex * MAX_SHIPS_PER_SQUAD_ANCHORAGE;
            const segmentPacks = packs.slice(start, start + MAX_SHIPS_PER_SQUAD_ANCHORAGE);
            if (!segmentPacks.length) continue;
            squads.push(makeSquad(group, segmentPacks, {
                waitingZone: 'commit-lagoon',
                repoGroupIndex,
                repoSegmentIndex,
                repoSegmentCount,
                segmentKey: `${group.key}:commit-lagoon:segment:${repoSegmentIndex}`,
            }));
        }
    });

    const byShipId = new Map();
    const visualPackByShipId = new Map();
    const squadCount = squads.length;
    const totalVisible = squads.reduce((sum, squad) => sum + squad.packs.length, 0);
    for (const fleet of fleets.values()) {
        const slot = COAST_ANCHORAGE_SLOTS[fleet.slot];
        const packs = fleet.squads.flatMap(squad => squad.packs);
        // Coastal slots sit ~3 tiles apart, so keep each fleet short along the
        // shore: skiff-only fleets take a third column, and one oversized lead
        // hull does not stretch the whole grid (collision relax clears it).
        const spacings = fleet.squads.flatMap(squad => squad.packs.map(pack => (
            harborShipClassFormationSpacing(harborShipClass({
                ...pack.lead,
                repoDockIndex: pack.startIndex,
                repoDockCount: squad.repoDockCount,
                repoDockVisibleCount: squad.packs.length,
                visualPackSize: pack.size,
            }))
        ))).sort((a, b) => b - a);
        const hasPack = packs.some(pack => pack.size > 1);
        fleet.anchor = { ...coastFormationAnchor(slot), columns: hasPack ? slot.columns : slot.columns + 1 };
        fleet.visibleCount = packs.length;
        fleet.spacing = Math.max(1.05, (spacings.length >= 3 ? spacings[1] : spacings[0]) || 1);
        fleet.cursor = 0;
    }
    const zoneSquadCounts = new Map();
    const representatives = [];
    squads.forEach((squad, squadIndex) => {
        const waitingZone = squad.waitingZone;
        const zoneSquadIndex = zoneSquadCounts.get(waitingZone) || 0;
        zoneSquadCounts.set(waitingZone, zoneSquadIndex + 1);
        let anchor;
        let anchorIndex;
        let squadCycle = 0;
        let formationBase = 0;
        let formationCount = squad.packs.length;
        let spacing;
        const fleet = fleets.get(repoAnchorageKey(squad.project));
        if (fleet) {
            anchor = fleet.anchor;
            anchorIndex = fleet.slot;
            formationBase = fleet.cursor;
            fleet.cursor += squad.packs.length;
            formationCount = fleet.visibleCount;
            spacing = fleet.spacing;
        } else {
            const anchorages = anchoragesForWaitingZone(waitingZone);
            anchorIndex = zoneSquadIndex % anchorages.length;
            squadCycle = Math.floor(zoneSquadIndex / anchorages.length);
            anchor = anchorages[anchorIndex] || anchorages[0] || HARBOR_SQUAD_ANCHORAGES[0];
            spacing = dockSquadPackSpacing(squad);
        }
        const repoDockCount = squad.repoDockCount;
        const visibleCount = squad.packs.length;
        const density = dockSquadDensity(totalVisible, squadCount, visibleCount);
        const compactCommitLabel = density >= 0.52 || totalVisible >= 9 || visibleCount >= 3;
        squad.anchor = anchor;
        squad.anchorIndex = anchorIndex;
        squad.squadIndex = squadIndex;
        squad.zoneSquadIndex = zoneSquadIndex;
        squad.squadCount = squadCount;
        squad.totalDocked = totalDocked;
        squad.density = density;
        squad.compactCommitLabel = compactCommitLabel;
        squad.formationSpacing = spacing;
        squad.packs.forEach((pack, packIndex) => {
            const tile = dockSquadFormationTile(anchor, formationBase + packIndex, formationCount, squadCycle, squad.segmentKey || squad.key, spacing, anchorIndex);
            const world = toWorld(tile.tileX, tile.tileY);
            const lead = pack.lead;
            const repoDockIndex = pack.startIndex;
            const layoutShip = {
                ...lead,
                repoDockIndex,
                repoDockCount,
                repoDockVisibleCount: visibleCount,
                waitingZone,
                visualPackSize: pack.size,
            };
            const showCommitLabel = lead.pushStatus === 'failed'
                || (!compactCommitLabel && totalVisible <= 18)
                || (packIndex === 0 && totalVisible <= 18 && repoDockCount <= 5)
                || (packIndex === 0 && totalVisible <= 36 && (squad.repoSegmentIndex % 3) === 0);
            const meta = {
                ...tile,
                id: lead.id,
                x: world.x,
                y: world.y,
                collisionRadius: harborShipCollisionRadius(layoutShip),
                squadKey: squad.key,
                waitingZone,
                anchorageName: anchor.name,
                anchorageIndex: anchorIndex,
                repoDockIndex,
                repoDockCount,
                repoTotalDockCount: squad.repoTotalDockCount,
                repoDockVisibleCount: visibleCount,
                repoSegmentIndex: squad.repoSegmentIndex,
                repoSegmentCount: squad.repoSegmentCount,
                squadIndex,
                zoneSquadIndex,
                squadCount,
                squadShipIndex: packIndex,
                squadShipCount: visibleCount,
                squadDensity: density,
                compactCommitLabel,
                showCommitLabel,
                visualLeadId: lead.id,
            };
            byShipId.set(lead.id, meta);
            representatives.push(meta);
            visualPackByShipId.set(lead.id, {
                visualPackSize: pack.size,
                visualPackStartIndex: pack.startIndex,
                visualPackEndIndex: pack.endIndex,
                visualPackHiddenCount: Math.max(0, pack.size - 1),
                visualIndex: packIndex,
                visibleCount,
            });
            for (const ship of pack.ships) {
                if (ship === lead) continue;
                byShipId.set(ship.id, {
                    ...meta,
                    id: ship.id,
                    repoDockIndex: squad.dockIndexById.get(ship.id) ?? repoDockIndex,
                    showCommitLabel: false,
                });
            }
        });
    });

    relaxDockShipLayout(representatives);
    for (const meta of byShipId.values()) {
        if (meta.visualLeadId === meta.id) continue;
        const lead = byShipId.get(meta.visualLeadId);
        if (!lead) continue;
        meta.x = lead.x;
        meta.y = lead.y;
        meta.tileX = lead.tileX;
        meta.tileY = lead.tileY;
    }

    return {
        squads,
        byShipId,
        visualPackByShipId,
        totalDocked,
        totalVisible,
        squadCount,
    };
}

function harborRouteGraphRoute(routeId) {
    return HARBOR_ROUTE_GRAPH.routes[routeId] || null;
}

function routeGraphWaypointSnapshot(waypointId) {
    const waypoint = HARBOR_ROUTE_WAYPOINTS[waypointId] || { id: waypointId, name: waypointId, zone: 'unknown' };
    return {
        id: waypoint.id,
        name: waypoint.name,
        zone: waypoint.zone,
        tileX: Number.isFinite(Number(waypoint.tileX)) ? Number(waypoint.tileX) : null,
        tileY: Number.isFinite(Number(waypoint.tileY)) ? Number(waypoint.tileY) : null,
    };
}

function routeGraphMetadata(routeId, overrides = {}) {
    const route = harborRouteGraphRoute(routeId);
    if (!route) return null;
    const waypointIds = Array.isArray(route.waypoints) ? [...route.waypoints] : [];
    return {
        graphVersion: HARBOR_ROUTE_GRAPH.version,
        id: route.id,
        name: route.name,
        kind: overrides.kind || route.kind,
        zone: overrides.zone || route.zone,
        bandName: overrides.bandName || route.bandName || '',
        waypointIds,
        waypoints: waypointIds.map(routeGraphWaypointSnapshot),
        fromWaypoint: overrides.fromWaypoint || waypointIds[0] || '',
        toWaypoint: overrides.toWaypoint || waypointIds[waypointIds.length - 1] || '',
    };
}

function outboundRouteIdForBand(band, zone = 'harbor') {
    const bandName = String(band?.name || '');
    if (isCommitLagoonZone(zone)) return `lagoon.${bandName}`;
    return `outbound.${bandName}`;
}

function waterRouteMetadataForBand(band, ship = {}, kind = 'outbound') {
    if (kind === 'inbound') {
        const moorsOut = ship?.arrivingKind === 'fetch' || ship?.arrivingKind === 'pr';
        return routeGraphMetadata(moorsOut ? 'inbound.fetch-roadstead' : 'inbound.pull');
    }
    const zone = ship?.departWaterZone || ship?.waitingZone || 'harbor';
    return routeGraphMetadata(outboundRouteIdForBand(band, zone), {
        kind: isCommitLagoonZone(zone) ? 'lagoon' : 'outbound',
        zone: isCommitLagoonZone(zone) ? 'commit-lagoon' : 'harbor',
        bandName: band?.name || '',
    });
}

function compactRouteMetadata(route = null) {
    if (!route) return null;
    return {
        graphVersion: route.graphVersion,
        id: route.id,
        name: route.name,
        kind: route.kind,
        zone: route.zone,
        bandName: route.bandName || '',
        waypointIds: Array.isArray(route.waypointIds) ? [...route.waypointIds] : [],
        fromWaypoint: route.fromWaypoint || '',
        toWaypoint: route.toWaypoint || '',
    };
}

function routeBandsFromData(routeData, ship = null) {
    if (Array.isArray(routeData?.bands) && routeData.bands.length) return routeData.bands;
    return isCommitLagoonZone(ship?.departWaterZone || ship?.waitingZone)
        ? COMMIT_LAGOON_ROUTE_BANDS
        : LOCAL_WATER_ROUTE_BANDS;
}

function pushRoutePoint(route, point) {
    if (!point) return;
    const previous = route[route.length - 1];
    if (previous && Math.hypot(previous.tileX - point.tileX, previous.tileY - point.tileY) < 0.12) return;
    route.push({ tileX: point.tileX, tileY: point.tileY });
}

function offsetWaterRoutePoint(point, band, ship, index, lastIndex) {
    if (index === 0 || index === lastIndex) return point;
    const squadCount = Math.max(1, Number(ship?.departSquadCount || 1));
    const squadIndex = Math.max(0, Number(ship?.departSquadIndex || 0));
    const centered = squadIndex - (squadCount - 1) / 2;
    const offset = Math.max(-0.36, Math.min(0.36, centered * 0.13));
    return {
        tileX: point.tileX + offset * (Number(band?.offsetX) || 0),
        tileY: point.tileY + offset * (Number(band?.offsetY) || 0),
    };
}

function composeWaterRouteTiles(startTile, ship, routeData = null) {
    const bands = routeBandsFromData(routeData, ship);
    const routeIndex = Number.isFinite(Number(ship?.departRouteIndex))
        ? Number(ship.departRouteIndex)
        : Number(ship?.laneIndex || 0);
    const band = bands[Math.abs(routeIndex) % bands.length] || bands[0];
    const fallbackLane = SEA_LANES[Math.abs(Number(band.exitLaneIndex ?? ship?.laneIndex ?? 0)) % SEA_LANES.length] || SEA_LANES[0];
    const raw = [];
    pushRoutePoint(raw, startTile);
    for (const point of band.waypoints || []) {
        if (!band.allowSouthbound && Number(point.tileY) > Number(startTile.tileY) + 0.65) continue;
        pushRoutePoint(raw, point);
    }
    // End at the established sea-lane endpoint. The old randomized edge leg
    // could send a ship back across the island after it had already reached
    // open water; the ship now fades during this final approach instead.
    const seaExitPoint = fallbackLane?.[fallbackLane.length - 1];
    pushRoutePoint(raw, seaExitPoint);

    const lastIndex = raw.length - 1;
    const route = [];
    raw.forEach((point, index) => {
        pushRoutePoint(route, offsetWaterRoutePoint(point, band, ship, index, lastIndex));
    });
    return route.length ? route : [startTile, ...(fallbackLane || [])];
}

function composeStorageTransferTiles(fromTile, toTile, ship = {}) {
    const route = [];
    pushRoutePoint(route, fromTile);
    const laneOffset = Math.max(-0.44, Math.min(0.44, ((stableHash(`${ship.id || ''}:storage-lane`) % 9) - 4) * 0.11));
    const entryY = Math.max(12.0, Math.min(16.2, fromTile.tileY - 5.6));
    pushRoutePoint(route, { tileX: 37.0 + laneOffset, tileY: entryY });
    pushRoutePoint(route, { tileX: 35.2 + laneOffset, tileY: 9.1 });
    pushRoutePoint(route, { tileX: 28.4 + laneOffset * 0.6, tileY: 6.6 });
    if (toTile.tileX < 15) {
        pushRoutePoint(route, { tileX: 20.6 + laneOffset * 0.4, tileY: 6.3 });
        pushRoutePoint(route, { tileX: 14.2 + laneOffset * 0.3, tileY: 6.5 });
    } else if (toTile.tileX > 21) {
        pushRoutePoint(route, { tileX: 24.2 + laneOffset * 0.3, tileY: 6.6 });
    }
    pushRoutePoint(route, toTile);
    return route;
}

function isHistoricalCommittedBeforePush(event, latestPushTimes, now) {
    const branch = eventBranch(event);
    const latestPush = latestPushTimes.get(trafficIdentity(event.project, branch))
        || latestPushTimes.get(trafficIdentity(event.project, ''))
        || (branch ? 0 : latestProjectPushTime(latestPushTimes, event.project))
        || 0;
    if (!latestPush || !Number.isFinite(event.timestamp) || event.timestamp > latestPush) return false;
    return Math.max(0, now - latestPush) > RECENT_PUSH_REPLAY_MS;
}

function latestProjectPushTime(latestPushTimes, project) {
    const prefix = `${String(project || 'unknown')}\x1f`;
    let latest = 0;
    for (const [key, timestamp] of latestPushTimes.entries()) {
        if (!String(key).startsWith(prefix)) continue;
        if (Number(timestamp) > latest) latest = Number(timestamp);
    }
    return latest;
}

function pushEventMatchesShip(event, ship) {
    if (!ship || ship.project !== event.project) return false;
    const pushBranch = eventBranch(event);
    const shipBranch = normalizeRepoBranch(ship.branch || ship.targetRef || '');
    if (!pushBranch) return true;
    if (!shipBranch) return true;
    return pushBranch === shipBranch;
}

function shipEligibleForPush(ship, event, previousPush, now) {
    if (!ship || ship.status !== 'docked' || !pushEventMatchesShip(event, ship)) return false;
    const pushTime = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : 0;
    if (!pushTime) return true;
    if (Number.isFinite(ship.eventTime) && ship.eventTime <= pushTime) return true;

    // Existing harbor ships predate the observed push even when their backend
    // timestamps are slightly out of order. New post-push commits must stay docked.
    const firstSeenBeforePush = Number.isFinite(ship.createdAt)
        && ship.createdAt < (previousPush?.seenAt || now);
    return firstSeenBeforePush;
}

function commitCompareText(value = '') {
    return cachedCleanCommitSubject(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function commitIdentityParts(event = {}) {
    const project = String(event.project || 'unknown');
    const branch = normalizeRepoBranch(event.branch || event.targetRef || '');
    const sha = String(event.sha || '').trim().toLowerCase();
    const label = cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
    return {
        project,
        branch,
        sha,
        label,
        compareLabel: commitCompareText(label),
        timestamp: Number(event.timestamp ?? event.eventTime ?? 0) || 0,
    };
}

function commitTimesClose(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return true;
    return Math.abs(a - b) <= COMMIT_EQUIVALENCE_WINDOW_MS;
}

function commitLabelsEquivalent(left, right, leftTime, rightTime) {
    if (!left || !right || !commitTimesClose(leftTime, rightTime)) return false;
    if (left === right) {
        if (left.length >= 10) return true;
        if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime <= 0 || rightTime <= 0) return false;
        return Math.abs(leftTime - rightTime) <= 30000;
    }
    if (Math.min(left.length, right.length) < 18) return false;
    return left.startsWith(right) || right.startsWith(left);
}

function sameCommitIdentity(a, b) {
    const left = commitIdentityParts(a);
    const right = commitIdentityParts(b);
    if (left.project !== right.project) return false;
    if (left.branch && right.branch && left.branch !== right.branch && (!left.sha || !right.sha || left.sha !== right.sha)) return false;
    if (left.sha && right.sha) return left.sha === right.sha;
    if (left.sha || right.sha) {
        return commitLabelsEquivalent(left.compareLabel, right.compareLabel, left.timestamp, right.timestamp);
    }
    return commitLabelsEquivalent(left.compareLabel, right.compareLabel, left.timestamp, right.timestamp);
}

function commitIdentityIndexLabelKey(parts) {
    const label = parts.compareLabel || '';
    if (!label) return '';
    return `${parts.project}\x1f${label.length >= 18 ? label.slice(0, 18) : label}`;
}

function addCommitIdentityIndexEntry(map, key, ship) {
    if (!key) return;
    const entries = map.get(key) || new Set();
    entries.add(ship);
    map.set(key, entries);
}

function indexCommitShip(index, ship) {
    if (!ship) return;
    if (!index.order.has(ship)) index.order.set(ship, index.nextOrder++);
    const parts = commitIdentityParts(ship);
    if (parts.sha) addCommitIdentityIndexEntry(index.bySha, `${parts.project}\x1f${parts.sha}`, ship);
    addCommitIdentityIndexEntry(index.byLabel, commitIdentityIndexLabelKey(parts), ship);
    if (!parts.sha) addCommitIdentityIndexEntry(index.byLabelWithoutSha, commitIdentityIndexLabelKey(parts), ship);
}

function buildCommitIdentityIndex(state) {
    const index = {
        bySha: new Map(),
        byLabel: new Map(),
        byLabelWithoutSha: new Map(),
        order: new Map(),
        nextOrder: 0,
    };
    for (const ship of state.ships.values()) indexCommitShip(index, ship);
    return index;
}

function findIndexedCommitShip(index, event) {
    const parts = commitIdentityParts(event);
    const candidates = new Set();
    if (parts.sha) {
        for (const ship of index.bySha.get(`${parts.project}\x1f${parts.sha}`) || []) candidates.add(ship);
    }
    const labelKey = commitIdentityIndexLabelKey(parts);
    if (labelKey) {
        const labelIndex = parts.sha ? index.byLabelWithoutSha : index.byLabel;
        for (const ship of labelIndex.get(labelKey) || []) candidates.add(ship);
    }
    return [...candidates]
        .sort((a, b) => Number(index.order.get(a) || 0) - Number(index.order.get(b) || 0))
        .find(ship => sameCommitIdentity(ship, event)) || null;
}

function mergeCommitIntoShip(ship, event, now = Date.now()) {
    const nextLabel = cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
    const currentLabel = cachedCleanCommitSubject(ship.label || '');
    const previousEventIds = Array.isArray(ship.eventIds) ? ship.eventIds : [ship.id].filter(Boolean);
    ship.eventIds = previousEventIds;
    const isNewAmend = !!(event.id && !ship.eventIds.includes(event.id));
    if (event.id && !ship.eventIds.includes(event.id)) ship.eventIds.push(event.id);
    if (!ship.sha && event.sha) ship.sha = event.sha;
    if (!ship.branch && eventBranch(event)) ship.branch = eventBranch(event);
    if (!ship.targetRef && event.targetRef) ship.targetRef = event.targetRef;
    if (nextLabel && (!currentLabel || currentLabel.startsWith('$(cat') || nextLabel.length < currentLabel.length)) {
        ship.label = nextLabel;
    }
    if (Number.isFinite(event.timestamp) && event.timestamp > 0) {
        ship.eventTime = Math.min(Number(ship.eventTime || event.timestamp), event.timestamp);
    }
    if (isNewAmend) {
        // 3.6 — amended commit: bump count and flash hull for 400ms via amendFlashAt
        ship.amendCount = Math.max(0, Number(ship.amendCount || 0)) + 1;
        ship.amendFlashAt = now;
    }
    // 3.6 — detached HEAD detection (commit with empty branch)
    if (eventBranch(event) === '' && ship.detachedHead !== true) {
        ship.detachedHead = true;
    }
    // Track upstream hint when an adapter forwards it on commits
    if (typeof event.hasUpstream === 'boolean' && ship.hasUpstreamHint == null) {
        ship.hasUpstreamHint = event.hasUpstream;
    }
}

function commitIdFragment(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    const hash = text.match(/\b[0-9a-f]{7,40}\b/i);
    if (hash) return hash[0].slice(0, 7).toLowerCase();
    const compact = text.replace(/^commit[:\s-]*/i, '').replace(/\s+/g, '');
    return compact && compact.length <= 16 ? compact : '';
}

function commitPennantLabel(ship = {}) {
    // PR cutters carry pull identity, never a commit hash or source event ID.
    if (ship.prShip) return pullRequestShipLabel(ship);
    const visualPackSize = Number(ship.visualPackSize);
    if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
        return `${Math.round(visualPackSize)}x`;
    }
    const eventIds = Array.isArray(ship.eventIds) ? ship.eventIds : [];
    const candidates = [
        ship.sha,
        ship.commit,
        ship.hash,
        ship.commitSha,
        ship.revision,
        ship.commandHash,
        ...eventIds,
        ship.sourceId,
        ship.id,
    ];

    for (const candidate of candidates) {
        const label = commitIdFragment(candidate);
        if (label) return label;
    }

    return 'commit';
}

export function snapshotHarborTrafficState(state) {
    const cloned = cloneState(state);
    const dockLayout = buildDockSquadLayout(cloned);
    return {
        nextSequence: cloned.nextSequence,
        seenEventIds: [...cloned.seenEventIds].sort(),
        ships: [...cloned.ships.values()]
            .map((ship) => {
                const meta = dockLayout.byShipId.get(ship.id) || {};
                return {
                    id: ship.id,
                    project: ship.project,
                    branch: ship.branch || '',
                    quayIndex: ship.quayIndex ?? null,
                    repoName: ship.repoName || '',
                    sha: ship.sha || '',
                    label: ship.prShip ? pullRequestShipLabel(ship) : ship.label || '',
                    status: ship.status,
                    gitKind: ship.gitKind || '',
                    eventStatus: ship.eventStatus || '',
                    remote: ship.remote || '',
                    ref: ship.ref || '',
                    refspec: ship.refspec || '',
                    targetRef: ship.targetRef || '',
                    source: ship.source || '',
                    sourceId: ship.sourceId || '',
                    confidence: ship.confidence ?? null,
                    inferred: ship.inferred === true,
                    observed: ship.observed === true,
                    sessionId: ship.sessionId || '',
                    agentId: ship.agentId || '',
                    completedAt: ship.completedAt || 0,
                    arrivingKind: ship.arrivingKind || null,
                    inboundCargoCount: ship.inboundCargoCount ?? null,
                    pushStatus: ship.pushStatus || null,
                    pushSource: ship.pushSource || '',
                    pushConfidence: ship.pushConfidence ?? null,
                    pushInferred: ship.pushInferred === true,
                    pushObserved: ship.pushObserved === true,
                    pushRemote: ship.pushRemote || '',
                    pushRef: ship.pushRef || '',
                    pushForce: ship.pushForce || null,
                    batchId: ship.batchId || null,
                    berthIndex: ship.berthIndex,
                    laneIndex: ship.laneIndex,
                    repoDockIndex: meta.repoDockIndex ?? ship.repoDockIndex ?? null,
                    repoDockCount: meta.repoDockCount ?? ship.repoDockCount ?? null,
                    repoTotalDockCount: meta.repoTotalDockCount ?? ship.repoTotalDockCount ?? null,
                    repoDockVisibleCount: meta.repoDockVisibleCount ?? ship.repoDockVisibleCount ?? null,
                    repoSegmentIndex: meta.repoSegmentIndex ?? ship.repoSegmentIndex ?? null,
                    repoSegmentCount: meta.repoSegmentCount ?? ship.repoSegmentCount ?? null,
                    squadIndex: meta.squadIndex ?? ship.squadIndex ?? null,
                    squadCount: meta.squadCount ?? ship.squadCount ?? null,
                    squadShipIndex: meta.squadShipIndex ?? ship.squadShipIndex ?? null,
                    squadShipCount: meta.squadShipCount ?? ship.squadShipCount ?? null,
                    squadDensity: meta.squadDensity ?? ship.squadDensity ?? null,
                    compactCommitLabel: meta.compactCommitLabel ?? ship.compactCommitLabel ?? null,
                    showCommitLabel: meta.showCommitLabel ?? ship.showCommitLabel ?? null,
                    formationColumn: meta.column ?? ship.formationColumn ?? null,
                    formationRow: meta.row ?? ship.formationRow ?? null,
                    waitingZone: meta.waitingZone ?? ship.waitingZone ?? null,
                    departWaterZone: ship.departWaterZone || null,
                    anchorageName: meta.anchorageName ?? ship.anchorageName ?? null,
                    anchorageIndex: meta.anchorageIndex ?? ship.anchorageIndex ?? null,
                    zoneSquadIndex: meta.zoneSquadIndex ?? ship.zoneSquadIndex ?? null,
                    departSquadIndex: ship.departSquadIndex ?? null,
                    departSquadCount: ship.departSquadCount ?? null,
                    departRouteIndex: ship.departRouteIndex ?? null,
                    route: compactRouteMetadata(ship.route),
                    convoy: ship.convoy ? { ...ship.convoy } : null,
                    departFromTile: ship.departFromTile || null,
                    eventTime: ship.eventTime,
                    departEventId: ship.departEventId || null,
                    departStartedAt: ship.departStartedAt || null,
                };
            })
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
        repoQuays: [...cloned.repoQuays.entries()]
            .map(([project, quayIndex]) => ({ project, quayIndex }))
            .sort((a, b) => a.project.localeCompare(b.project)),
        repoAnchorages: [...cloned.repoAnchorages.entries()]
            .map(([project, slot]) => ({ project, slot, anchorage: COAST_ANCHORAGE_SLOTS[slot]?.name || '' }))
            .sort((a, b) => a.project.localeCompare(b.project)),
        batches: [...cloned.batches.values()]
            .map(batch => ({
                id: batch.id,
                project: batch.project,
                branch: batch.branch || '',
                quayIndex: batch.quayIndex ?? null,
                repoName: batch.repoName || '',
                label: batch.label || '',
                status: batch.status || 'unknown',
                eventStatus: batch.eventStatus || '',
                remote: batch.remote || '',
                ref: batch.ref || '',
                refspec: batch.refspec || '',
                source: batch.source || '',
                sourceId: batch.sourceId || '',
                confidence: batch.confidence ?? null,
                inferred: batch.inferred === true,
                observed: batch.observed === true,
                targetRef: batch.targetRef || '',
                force: batch.force || null,
                route: compactRouteMetadata(batch.route),
                convoy: batch.convoy ? { ...batch.convoy } : null,
                shipCount: batch.shipCount || 0,
                eventTime: batch.eventTime || 0,
                startedAt: batch.startedAt || 0,
                shipIds: [...(batch.shipIds || [])].sort(),
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
        pushEvents: [...cloned.pushEvents.values()]
            .map(push => ({
                id: push.id,
                project: push.project || '',
                branch: push.branch || '',
                status: push.status || 'unknown',
                eventStatus: push.eventStatus || '',
                remote: push.remote || '',
                ref: push.ref || '',
                refspec: push.refspec || '',
                source: push.source || '',
                sourceId: push.sourceId || '',
                confidence: push.confidence ?? null,
                inferred: push.inferred === true,
                observed: push.observed === true,
                force: push.force || null,
                eventTime: push.eventTime || 0,
                batchId: push.batchId || null,
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
    };
}

// One row per repo with docked commits or a failed push. A failed push with
// nothing docked (no batch) still makes a row, so `harbor:updated` reports it;
// `agentId` is the agent whose failure the Harbor's bracket marks (its docked
// failed ship first, else its latest failed push), the key its cue is scored by.
export function pendingRepoSummariesFromDockSummaries(summaries, pushEvents = []) {
    const byRepo = new Map();
    const rowFor = (project, branch, profile) => byRepo.get(profile.key) || {
        project,
        branch: branch || '',
        repoName: trafficLabel(project, branch),
        shortName: profile.shortName || trafficLabel(project, branch, 18),
        profile,
        pendingCommits: 0,
        failedPushes: 0,
        agentId: null,
        latestFailureAt: 0,
        latestEventTime: 0,
        oldestCommitTime: 0,
        waitingZone: 'harbor',
        storageCommits: 0,
    };
    for (const summary of summaries?.values?.() || []) {
        const count = Number(summary.count) || 0;
        if (count <= 0) continue;
        const profile = summary.profile || trafficProfile(summary.project, summary.branch);
        const existing = rowFor(summary.project, summary.branch, profile);
        existing.pendingCommits += count;
        existing.failedPushes += Number(summary.failedCount) || 0;
        existing.agentId ??= summary.failedAgentId ?? null;
        existing.latestFailureAt = Math.max(existing.latestFailureAt, Number(summary.failedAt) || 0);
        existing.latestEventTime = Math.max(existing.latestEventTime, Number(summary.latestEventTime) || 0);
        const earliestEventTime = Number(summary.earliestEventTime) || 0;
        if (earliestEventTime > 0) {
            existing.oldestCommitTime = existing.oldestCommitTime > 0
                ? Math.min(existing.oldestCommitTime, earliestEventTime)
                : earliestEventTime;
        }
        if (isCommitLagoonZone(summary.waitingZone)) {
            existing.waitingZone = 'commit-lagoon';
            existing.storageCommits += count;
        }
        byRepo.set(profile.key, existing);
    }
    const pushAgent = new Map();
    for (const push of pushEvents || []) {
        const status = push?.status || 'unknown';
        if ((status !== 'failed' && status !== 'rejected') || push.batchId || !push.project) continue;
        const branch = push.branch || '';
        const profile = trafficProfile(push.project, branch);
        const existing = rowFor(push.project, branch, profile);
        const eventTime = Number(push.eventTime) || 0;
        existing.failedPushes += 1;
        existing.latestFailureAt = Math.max(existing.latestFailureAt, eventTime);
        existing.latestEventTime = Math.max(existing.latestEventTime, eventTime);
        const latest = pushAgent.get(profile.key);
        if (push.agentId && (!latest || eventTime >= latest.eventTime)) {
            pushAgent.set(profile.key, { agentId: push.agentId, eventTime });
        }
        byRepo.set(profile.key, existing);
    }
    for (const [key, { agentId }] of pushAgent) {
        const row = byRepo.get(key);
        row.agentId ??= agentId;
    }
    return [...byRepo.values()]
        .sort((a, b) => (b.failedPushes - a.failedPushes)
            || (b.pendingCommits - a.pendingCommits)
            || (b.latestEventTime - a.latestEventTime)
            || a.repoName.localeCompare(b.repoName));
}

// v0.23 A2 — the repo's lead ship (repoDockIndex/departSquadIndex 0) carries a
// commit-count-class hull sized by the whole fleet; every other commit sails as
// an individual skiff.
function harborFleetCount(ship = {}) {
    return Math.max(
        1,
        Number(ship.repoTotalDockCount || 0),
        Number(ship.repoDockCount || 0),
        Number(ship.squadShipCount || 0),
        Number(ship.repoDockVisibleCount || 0)
    );
}

function harborShipPackSize(ship = {}) {
    const visualPackSize = Number(ship.visualPackSize);
    if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
        return Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, Math.round(visualPackSize)));
    }
    if (ship.status === 'docked') {
        const repoIndex = Number.isFinite(Number(ship.repoDockIndex))
            ? Math.max(0, Number(ship.repoDockIndex))
            : 0;
        if (repoIndex !== 0) return 1;
        return Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, harborFleetCount(ship)));
    }
    if (ship.status === 'departing') {
        const departIndex = Number.isFinite(Number(ship.departSquadIndex))
            ? Math.max(0, Number(ship.departSquadIndex))
            : 0;
        if (departIndex !== 0) return 1;
        const squadCount = Math.max(1, Number(ship.departSquadCount || 0));
        return Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, squadCount));
    }
    const repoIndex = Number.isFinite(Number(ship.repoDockIndex))
        ? Math.max(0, Number(ship.repoDockIndex))
        : 0;
    if (repoIndex !== 0) return 1;
    return Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, harborFleetCount(ship)));
}

function harborShipStackClass(packSize) {
    const count = Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, Math.round(Number(packSize) || 1)));
    const variant = HARBOR_SHIP_STACK_CLASSES.find(item => count >= item.minCommits);
    if (!variant) return null;
    return {
        ...variant,
        packSize: count,
        trim: 0,
        badge: `${count}x`,
    };
}

function harborShipClass(ship = {}) {
    // 8.2 — the release sloop is always the one sloop hull.
    if (ship.releaseSail) return RELEASE_SAIL_CLASS;
    // 3.2 — inbound ships use a small fixed class so the inbound ramp is visually consistent.
    if (ship.isInbound) {
        const variant = inboundShipClass();
        return {
            ...variant,
            packSize: 1,
            trim: 0,
            scale: variant.scale,
            // W7.9 — a PR cutter carries no commit count: no `2+` badge.
            ...(ship.prShip ? { badge: '' } : null),
        };
    }
    const packSize = harborShipPackSize(ship);
    // Stack sprites are reserved for true visual packs — one drawable standing
    // in for hidden overflow ships. A fleet lead whose flock is individually
    // visible keeps a commit-count class hull instead, so the harbor never
    // double-counts (e.g. 12 skiffs plus a "12x" stack).
    const isTrueVisualPack = Number(ship.visualPackSize) > 1;
    const stackVariant = isTrueVisualPack ? harborShipStackClass(packSize) : null;
    if (stackVariant) return stackVariant;
    const variant = HARBOR_SHIP_CLASSES.find(item => packSize >= item.minCommits)
        || HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1];
    const trim = stableHash(`${ship.project || ''}:${ship.branch || ''}:${ship.id || ''}:harbor-ship-trim`) % 4;
    const skiffScale = [0.88, 0.94, 0.90, 0.86][trim] || variant.scale;
    return {
        ...variant,
        packSize,
        trim,
        scale: variant.key === 'skiff' ? skiffScale : variant.scale,
    };
}

// Push lifecycle: mass-scaled departure (overridden by force-push)
function dynamicDepartureMs(ship = {}, force = null) {
    if (force === true) return FORCE_DEPARTURE_MS;
    const packSize = Math.max(1, harborShipPackSize(ship));
    const base = DEPARTURE_MS + Math.min(20000, packSize * 1200);
    // v0.23 A5 — deterministic ±12% per-ship jitter so a flock doesn't sail in
    // lock-step and the departure spreads out over time.
    const jitter = 1 + (((stableHash(`${ship.id || ''}:depart-jitter`) % 25) - 12) / 100);
    return Math.round(base * jitter);
}

// 3.2 — inbound ship class lookup
function inboundShipClass() {
    return HARBOR_SHIP_CLASSES.find(item => item.key === INBOUND_SHIP_CLASS_KEY)
        || HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1];
}

// 3.2 — parse incoming commit count from pull flags/remote args. Best-effort.
function parseIncomingCommits(event = {}) {
    const flags = Array.isArray(event.flags) ? event.flags : [];
    const stderr = String(event.stderr || '');
    // Look for tokens like "+12" or "Fast-forwarded ... 12 files changed".
    const stderrMatch = stderr.match(/(\d+)\s+(?:files?\s+changed|commits?|insertions?|new\s+commits?)/i);
    if (stderrMatch) {
        const n = parseInt(stderrMatch[1], 10);
        if (Number.isFinite(n) && n > 0) return Math.min(10, n);
    }
    for (const flag of flags) {
        const m = String(flag).match(/^--depth=(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return Math.min(10, n);
        }
    }
    return 0;
}

// W7.9 — the moored PR cutter a `gh pr merge` sends in: the one whose scraped
// pull URL matches, else the project's newest moored PR with no URL to
// contradict it. Null when no cutter is waiting (a PR opened elsewhere).
function findMooredPullRequest(state, event) {
    const url = String(event?.url || '');
    let best = null;
    for (const ship of state.ships.values()) {
        if (!ship.prShip || ship.arrivingKind !== 'pr' || ship.project !== event.project) continue;
        if (url && ship.prUrl) {
            if (ship.prUrl === url) return ship;
            continue;
        }
        if (!best || (ship.prCreatedAt || 0) > (best.prCreatedAt || 0)) best = ship;
    }
    return best;
}

// Moored PR cutters fill the outer-roadstead anchorages in turn, a row
// further out each lap, so two open PRs never moor on one tile.
function pullRequestRoadsteadTile(state) {
    const anchorages = HARBOR_SQUAD_ANCHORAGES.filter(anchorage => anchorage.zone === 'outer-roadstead');
    let slot = 0;
    for (const ship of state.ships.values()) {
        if (ship.prShip && ship.arrivingKind === 'pr') slot++;
    }
    const anchorage = anchorages[slot % anchorages.length] || HARBOR_SQUAD_ANCHORAGES[0];
    const row = Math.floor(slot / Math.max(1, anchorages.length)) % PR_ROADSTEAD_ROWS;
    return { tileX: anchorage.tileX + anchorage.rowDx * row, tileY: anchorage.tileY + anchorage.rowDy * row };
}

function pullRequestShipLabel(event = {}) {
    const match = String(event.prUrl || event.url || '').match(/\/pull\/(\d+)(?:[/?#]|$)/);
    if (match) return `PR #${match[1]}`;
    const detail = String(event.branch || event.prTitle || event.title || '').trim();
    return detail ? `PR ${detail}` : 'PR';
}

function pullRequestShip(state, event, now) {
    const profile = trafficProfile(event.project, event.branch || '');
    state.nextSequence++;
    return {
        id: `pr:${event.id}`,
        project: event.project,
        branch: event.branch || '',
        targetRef: '',
        ...gitEventDebugMetadata(event, ''),
        repoName: profile.shortName,
        quayIndex: assignedQuayIndex(state, event.project),
        sha: '',
        label: pullRequestShipLabel(event),
        inboundCargoCount: 0,
        berthIndex: state.nextSequence % BERTHS.length,
        laneIndex: stableHash(`${event.project}:${event.id}:pr`) % SEA_LANES.length,
        eventTime: event.timestamp || now,
        createdAt: now,
        eventIds: [event.id],
        isInbound: true,
        prShip: true,
        prUrl: String(event.url || ''),
        prTitle: String(event.title || ''),
        prCreatedAt: event.timestamp || now,
        detachedHead: false,
        amendCount: 0,
    };
}

export function reduceHarborTrafficState(previous, events, options = {}) {
    const state = cloneState(previous);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const motionScale = options.motionScale === 0 ? 0 : 1;

    const sortedEvents = [...(events || [])]
        .filter(event => event?.id && event?.type && event?.project)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    // Pushes may sit before a long commit tail while still applying to a live
    // docked ship, so transition correctness requires the complete ordered tail.
    const sorted = sortedEvents;
    const latestPushTimes = latestPushTimesByProject(sorted);
    const relevantProjects = new Set(sorted.map(event => String(event.project || 'unknown')));
    for (const ship of state.ships.values()) {
        if (ship.project) relevantProjects.add(String(ship.project));
    }
    for (const [project] of state.repoQuays.entries()) {
        if (!relevantProjects.has(String(project || 'unknown'))) state.repoQuays.delete(project);
    }
    if (relevantProjects.size <= MAX_HARBOR_REPO_QUAYS) {
        for (const project of relevantProjects) assignedQuayIndex(state, project);
    }
    const commitIdentityIndex = buildCommitIdentityIndex(state);
    // Live-only repos claim coastal slots only after this tail's commits have,
    // so a fresh replay parks fleets first and idle agents fill what's left.
    const activeProjects = Array.isArray(options.activeProjects) ? options.activeProjects : [];
    const occupiedBerths = new Set();
    for (const ship of state.ships.values()) {
        if (Number.isFinite(Number(ship.berthIndex))) occupiedBerths.add(Number(ship.berthIndex));
    }

    for (const event of sorted) {
        if (event.type !== 'push') {
            if (state.seenEventIds.has(event.id) || harborEventIsTombstoned(state, event)) continue;
            markHarborEventSeen(state, event, now);
        }

        if (event.type === 'commit') {
            if (commitIsAtOrBelowReplayFloor(state, event)) continue;
            if (isHistoricalCommittedBeforePush(event, latestPushTimes, now)) continue;
            const existingShip = findIndexedCommitShip(commitIdentityIndex, event);
            if (existingShip) {
                markHarborEventSeen(state, event, now);
                mergeCommitIntoShip(existingShip, event, now);
                indexCommitShip(commitIdentityIndex, existingShip);
                continue;
            }
            const branch = eventBranch(event);
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project, occupiedBerths);
            const laneIndex = stableHash(`${event.project}:${branch}:${event.id}`) % SEA_LANES.length;
            const profile = trafficProfile(event.project, branch);
            state.nextSequence++;
            const ship = {
                id: event.id,
                project: event.project,
                branch,
                targetRef: event.targetRef || '',
                ...gitEventDebugMetadata(event, branch),
                repoName: profile.shortName,
                quayIndex,
                sha: event.sha,
                label: cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command)) || event.label,
                status: 'docked',
                route: routeGraphMetadata('berth.assignment'),
                berthIndex,
                laneIndex,
                eventTime: event.timestamp || now,
                createdAt: now,
                eventIds: [event.id],
                // 3.6 — edge case flags inferred at commit time
                detachedHead: branch === '',
                hasUpstreamHint: typeof event.hasUpstream === 'boolean' ? event.hasUpstream : null,
                amendCount: 0,
            };
            state.ships.set(event.id, ship);
            ensureRepoAnchorage(state, event.project);
            occupiedBerths.add(berthIndex);
            indexCommitShip(commitIdentityIndex, ship);
            continue;
        }

        // 3.2 — pull/fetch as inbound ships sailing toward harbor.
        if (event.type === 'pull' || event.type === 'fetch') {
            const inboundStatus = String(event.status || gitEventStatusLabel(event) || '').toLowerCase();
            if (inboundStatus === 'failed' || inboundStatus === 'rejected'
                || inboundStatus === 'cancelled' || inboundStatus === 'canceled') {
                markHarborEventSeen(state, event, now);
                continue;
            }
            if (motionScale === 0) continue;
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            if (eventAge > RECENT_PUSH_REPLAY_MS) continue;
            const inboundId = `inbound:${event.id}`;
            if (state.ships.has(inboundId)) continue;
            const branch = eventBranch(event);
            const profile = trafficProfile(event.project, branch);
            const laneIndex = stableHash(`${event.project}:${branch}:${event.id}:inbound`) % SEA_LANES.length;
            const cargoCount = parseIncomingCommits(event);
            // Choose an outer-roadstead anchor for fetch (waits) or a berth for pull.
            const isFetch = event.type === 'fetch';
            const outerRoadsteads = HARBOR_SQUAD_ANCHORAGES.filter(a => a.zone === 'outer-roadstead');
            const roadstead = outerRoadsteads[stableHash(`${event.project}:${event.id}:roadstead`) % outerRoadsteads.length]
                || HARBOR_SQUAD_ANCHORAGES[0];
            const { berthIndex, quayIndex } = isFetch
                ? { berthIndex: -1, quayIndex: assignedQuayIndex(state, event.project) }
                : chooseBerthIndex(state, event.project, occupiedBerths);
            state.nextSequence++;
            const ship = {
                id: inboundId,
                project: event.project,
                branch,
                targetRef: event.targetRef || '',
                ...gitEventDebugMetadata(event, branch),
                repoName: profile.shortName,
                quayIndex,
                sha: '',
                label: inboundGitLabel(event, branch),
                status: 'arriving',
                arrivingKind: isFetch ? 'fetch' : 'pull',
                route: routeGraphMetadata(isFetch ? 'inbound.fetch-roadstead' : 'inbound.pull'),
                inboundCargoCount: cargoCount,
                inboundRoadsteadTile: isFetch ? { tileX: roadstead.tileX, tileY: roadstead.tileY } : null,
                berthIndex: berthIndex >= 0 ? berthIndex : (state.nextSequence % BERTHS.length),
                laneIndex,
                arrivingStartedAt: now,
                arrivingDuration: INBOUND_DURATION_MS,
                eventTime: event.timestamp || now,
                createdAt: now,
                eventIds: [event.id],
                isInbound: true,
                detachedHead: false,
                amendCount: 0,
            };
            state.ships.set(inboundId, ship);
            occupiedBerths.add(ship.berthIndex);
            indexCommitShip(commitIdentityIndex, ship);
            continue;
        }

        // W7.9 (SW-P9) — pull requests as the PR cutter class. A failed
        // command sails nothing; a PR older than the replay window appears
        // already moored (or already at the quay) instead of re-sailing.
        if (event.type === 'pr') {
            const prStatus = String(event.status || gitEventStatusLabel(event) || '').toLowerCase();
            if (prStatus === 'failed' || prStatus === 'rejected'
                || prStatus === 'cancelled' || prStatus === 'canceled') continue;
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            const sail = motionScale !== 0 && eventAge <= RECENT_PUSH_REPLAY_MS;
            if (event.action === 'create') {
                if (eventAge > PR_SHIP_MOOR_MS || state.ships.has(`pr:${event.id}`)) continue;
                const ship = pullRequestShip(state, event, now);
                Object.assign(ship, {
                    status: sail ? 'arriving' : 'anchored',
                    arrivingKind: 'pr',
                    route: routeGraphMetadata('inbound.fetch-roadstead'),
                    inboundRoadsteadTile: pullRequestRoadsteadTile(state),
                    arrivingStartedAt: sail ? now : now - INBOUND_DURATION_MS,
                    prMooredAt: sail ? 0 : (event.timestamp || now),
                });
                state.ships.set(ship.id, ship);
                continue;
            }
            if (event.action !== 'merge') continue;
            const moored = findMooredPullRequest(state, event);
            if (eventAge > PR_QUAY_HOLD_MS) {
                if (moored) retireHarborShip(state, moored.id, moored, now, { recordFloor: false });
                continue;
            }
            if (!moored && state.ships.has(`pr:${event.id}`)) continue;
            const ship = moored || pullRequestShip(state, event, now);
            if (moored) ship.eventIds.push(event.id);
            ship.prUrl = String(event.url || ship.prUrl || '');
            ship.branch = event.branch || ship.branch || '';
            ship.prTitle = String(event.title || ship.prTitle || '');
            ship.label = pullRequestShipLabel(ship);
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project, occupiedBerths);
            Object.assign(ship, {
                status: sail ? 'arriving' : 'anchored',
                arrivingKind: 'pr-merge',
                route: routeGraphMetadata('inbound.pull'),
                prFromTile: moored ? ship.inboundRoadsteadTile : null,
                inboundRoadsteadTile: null,
                berthIndex,
                quayIndex,
                arrivingStartedAt: sail ? now : now - INBOUND_DURATION_MS,
                arrivingDuration: moored ? PR_MERGE_SAIL_MS : INBOUND_DURATION_MS,
                prMergedAt: event.timestamp || now,
                prQuayedAt: sail ? 0 : (event.timestamp || now),
                eventTime: event.timestamp || now,
            });
            state.ships.set(ship.id, ship);
            occupiedBerths.add(berthIndex);
            continue;
        }

        if (event.type === 'push') {
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            const skipOldReplay = eventAge > RECENT_PUSH_REPLAY_MS;
            const skipDepartureAnimation = motionScale === 0 || skipOldReplay;
            const pushTime = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : 0;
            const batchId = `push-batch:${event.id}`;
            const previousPush = state.pushEvents.get(event.id);
            if (!previousPush && harborEventIsTombstoned(state, event)) continue;
            const incomingStatus = harborEventStatus(event);
            const previousStatus = previousPush?.status || null;
            const status = previousStatus && incomingStatus === 'unknown' ? previousStatus : incomingStatus;
            const existingBatch = state.batches.get(batchId);
            const statusChanged = previousStatus && previousStatus !== status;
            const branch = eventBranch(event);
            if (status === 'success') {
                recordCommitReplayFloor(state, event.project, branch, pushTime, now);
                clearHarborDockOverflowForPush(state, event, pushTime);
            }
            const profile = trafficProfile(event.project, branch);
            const pushMetadata = gitEventDebugMetadata(event, branch);
            // 3.1 — capture force flag (true / 'lease' / 'includes')
            const forceFlag = event.force === true || event.force === 'lease' || event.force === 'includes'
                ? event.force
                : null;

            let selectedShips = [];
            const existingShipIds = new Set(existingBatch?.shipIds || []);
            const selectedIds = new Set();
            const addShip = (ship) => {
                if (!ship || selectedIds.has(ship.id)) return;
                selectedIds.add(ship.id);
                selectedShips.push(ship);
            };
            if (existingBatch?.shipIds?.length) {
                existingBatch.shipIds
                    .map(id => state.ships.get(id))
                    .filter(Boolean)
                    .forEach(addShip);
            }
            for (const ship of state.ships.values()) {
                if (!shipEligibleForPush(ship, event, previousPush, now)) continue;
                addShip(ship);
            }
            selectedShips.sort(compareDepartingShips);

            if (status !== 'success' && status !== 'failed' && status !== 'rejected' && status !== 'cancelled') {
                if (existingBatch?.status === 'unknown') state.batches.delete(batchId);
                state.pushEvents.set(event.id, {
                    id: event.id,
                    project: event.project,
                    branch,
                    status,
                    ...pushMetadata,
                    force: forceFlag,
                    eventTime: event.timestamp || now,
                    batchId: null,
                    seenAt: previousPush?.seenAt || now,
                });
                continue;
            }

            if (!existingBatch && selectedShips.length === 0) {
                state.pushEvents.set(event.id, {
                    id: event.id,
                    project: event.project,
                    branch,
                    status,
                    ...pushMetadata,
                    force: forceFlag,
                    eventTime: event.timestamp || now,
                    batchId: null,
                    seenAt: now,
                });
                continue;
            }

            const newShipCount = selectedShips.filter(ship => !existingShipIds.has(ship.id)).length;
            if (previousPush && !statusChanged && existingBatch && newShipCount === 0) continue;

            const dockLayout = buildDockSquadLayout(state);
            const shipIds = selectedShips.map(ship => ship.id);
            const startedAt = existingBatch?.startedAt
                || previousPush?.seenAt
                || (skipOldReplay ? now - SCREEN_SUMMARY_MS - FINALE_EFFECT_MS - 1 : now);
            const convoy = status === 'success'
                ? (existingBatch?.convoy || releaseConvoyMetadata(event, branch, selectedShips, status, forceFlag))
                : null;
            const batch = {
                ...(existingBatch || {}),
                id: batchId,
                project: event.project,
                branch,
                quayIndex: assignedQuayIndex(state, event.project),
                repoName: profile.shortName,
                label: event.label || existingBatch?.label || '',
                targetRef: event.targetRef || existingBatch?.targetRef || '',
                status,
                ...pushMetadata,
                // 3.1 — keep force flag on the batch so renderers can branch on it
                force: forceFlag,
                convoy,
                shipIds,
                shipCount: shipIds.length,
                sequence: existingBatch?.sequence || ++state.nextBatchSequence,
                eventTime: event.timestamp || existingBatch?.eventTime || now,
                startedAt,
                statusUpdatedAt: statusChanged ? now : existingBatch?.statusUpdatedAt || now,
            };
            state.batches.set(batchId, batch);
            state.pushEvents.set(event.id, {
                id: event.id,
                project: event.project,
                branch,
                status,
                ...pushMetadata,
                force: forceFlag,
                eventTime: event.timestamp || now,
                batchId,
                seenAt: previousPush?.seenAt || now,
            });

            const departSquadCount = Math.max(1, selectedShips.length);
            // Titan packs sail as one hull: members of a docked pack that leave
            // together stay hidden behind the first selected member of that pack.
            const departPacks = new Map();
            for (const ship of selectedShips) {
                const key = dockLayout.byShipId.get(ship.id)?.visualLeadId || ship.id;
                const pack = departPacks.get(key) || { leadId: ship.id, size: 0, visibleIndex: departPacks.size };
                pack.size += 1;
                departPacks.set(key, pack);
            }
            selectedShips.forEach((ship, departSquadIndex) => {
                const dockMeta = dockLayout.byShipId.get(ship.id);
                const departPack = departPacks.get(dockMeta?.visualLeadId || ship.id) || { leadId: ship.id, size: 1, visibleIndex: departSquadIndex };
                ship.visualPackLeadId = departPack.leadId;
                ship.visualPackSize = departPack.leadId === ship.id ? departPack.size : 1;
                const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
                const departWaterZone = dockMeta?.waitingZone || ship.waitingZone || 'harbor';
                const routeBands = isCommitLagoonZone(departWaterZone)
                    ? COMMIT_LAGOON_ROUTE_BANDS
                    : LOCAL_WATER_ROUTE_BANDS;
                const routeIndex = stableHash(`${event.project}:${branch}:${event.id}:${departWaterZone}:water-route`) % routeBands.length;
                const routeBand = routeBands[routeIndex] || routeBands[0];
                const route = waterRouteMetadataForBand(routeBand, { ...ship, departWaterZone });
                if (convoy && !convoy.routeId && route?.id) convoy.routeId = route.id;
                if (!batch.route && route) batch.route = route;
                ship.pushStatus = status;
                ship.pushSource = pushMetadata.source || '';
                ship.pushConfidence = pushMetadata.confidence;
                ship.pushInferred = pushMetadata.inferred === true;
                ship.pushObserved = pushMetadata.observed === true;
                ship.pushRemote = pushMetadata.remote || '';
                ship.pushRef = pushMetadata.ref || '';
                ship.batchId = batchId;
                ship.pushEventId = event.id;
                ship.pushSeenAt = now;
                ship.waitingZone = departWaterZone;
                ship.departWaterZone = departWaterZone;
                ship.departSquadIndex = departSquadIndex;
                ship.departSquadCount = departSquadCount;
                ship.departRouteIndex = routeIndex;
                ship.route = route;
                ship.departRouteOffset = departSquadIndex - (departSquadCount - 1) / 2;
                ship.departStaggerMs = DEPARTURE_STAGGER_MS;
                ship.departFromTile = dockMeta
                    ? { tileX: dockMeta.tileX, tileY: dockMeta.tileY }
                    : { tileX: berth.tileX, tileY: berth.tileY };
                if (dockMeta) {
                    ship.repoDockIndex = dockMeta.repoDockIndex;
                    ship.repoDockCount = dockMeta.repoDockCount;
                    ship.repoTotalDockCount = dockMeta.repoTotalDockCount;
                    ship.repoDockVisibleCount = dockMeta.repoDockVisibleCount;
                    ship.repoSegmentIndex = dockMeta.repoSegmentIndex;
                    ship.repoSegmentCount = dockMeta.repoSegmentCount;
                    ship.squadIndex = dockMeta.squadIndex;
                    ship.squadCount = dockMeta.squadCount;
                    ship.squadShipIndex = dockMeta.squadShipIndex;
                    ship.squadShipCount = dockMeta.squadShipCount;
                    ship.squadDensity = dockMeta.squadDensity;
                    ship.compactCommitLabel = dockMeta.compactCommitLabel;
                    ship.showCommitLabel = dockMeta.showCommitLabel;
                    ship.formationColumn = dockMeta.column;
                    ship.formationRow = dockMeta.row;
                    ship.waitingZone = dockMeta.waitingZone;
                    ship.departWaterZone = dockMeta.waitingZone;
                    ship.anchorageName = dockMeta.anchorageName;
                    ship.anchorageIndex = dockMeta.anchorageIndex;
                }
                // 3.1 — propagate force flag to each ship so draw/lifecycle helpers can react.
                ship.pushForce = forceFlag;
                ship.convoy = convoy ? {
                    ...convoy,
                    routeId: convoy.routeId || route?.id || '',
                    index: departSquadIndex,
                    leaderShipId: convoy.leaderShipId || selectedShips[0]?.id || ship.id,
                } : null;
                if (status === 'failed') {
                    ship.status = 'docked';
                    ship.failedAt = skipOldReplay ? null : now;
                    ship.departEventId = null;
                    ship.departStartedAt = null;
                    ship.departEventTime = null;
                    return;
                }
                // Rejected push boomerangs: out then back, redocks with caution flag.
                if (status === 'rejected') {
                    if (statusChanged || !ship.boomerangStartedAt) {
                        ship.boomerangStartedAt = skipDepartureAnimation
                            ? now - BOOMERANG_OUT_MS - BOOMERANG_IN_MS - 1
                            : now + departPack.visibleIndex * DEPARTURE_STAGGER_MS;
                    }
                    ship.status = skipDepartureAnimation ? 'docked' : 'rejecting';
                    ship.departEventId = event.id;
                    ship.departEventTime = event.timestamp || now;
                    return;
                }
                // 5.11 — cancelled push: half-speed return to berth, no collision flare.
                if (status === 'cancelled') {
                    if (statusChanged || !ship.cancelReturnStartedAt) {
                        ship.cancelReturnStartedAt = skipDepartureAnimation
                            ? now - CANCEL_RETURN_MS - 1
                            : now + departPack.visibleIndex * DEPARTURE_STAGGER_MS;
                    }
                    ship.status = skipDepartureAnimation ? 'docked' : 'cancelling';
                    ship.departEventId = event.id;
                    ship.departEventTime = event.timestamp || now;
                    return;
                }
                ship.status = 'departing';
                ship.departEventId = event.id;
                // Mass-scaled departure (force-push wins). Pack members share
                // their lead's timing so the whole titan retires together.
                ship.departMsOverride = dynamicDepartureMs({ ...ship, visualPackSize: departPack.size }, forceFlag);
                if (status === 'success' && previousStatus !== 'success') {
                    ship.departStartedAt = null;
                }
                ship.departStartedAt = skipDepartureAnimation
                    ? now - ship.departMsOverride - FADE_DELAY_MS - EXIT_FADE_MS - EXIT_HOLD_MS - 1
                    : ship.departStartedAt || startedAt + departPack.visibleIndex * DEPARTURE_STAGGER_MS;
                // Cast-off phase: hold at berth briefly before the proper departure.
                if (!skipDepartureAnimation && (statusChanged || !ship.castOffStartedAt)) {
                    ship.castOffStartedAt = ship.departStartedAt;
                }
                ship.departEventTime = event.timestamp || now;
            });
        }
    }

    for (const [id, ship] of state.ships) {
        // Boomerang lifecycle: out then back, then redock with caution flag.
        if (ship.status === 'rejecting') {
            const startedAt = ship.boomerangStartedAt || now;
            const totalMs = BOOMERANG_OUT_MS + BOOMERANG_IN_MS;
            if (motionScale === 0 || now - startedAt >= totalMs) {
                ship.status = 'docked';
                ship.pushStatus = 'rejected';
                ship.rejectedAt = now;
                ship.boomerangStartedAt = null;
                ship.departStartedAt = null;
                ship.visualPackLeadId = null;
                ship.visualPackSize = null;
                ship.departEventId = null;
            }
            continue;
        }
        // 5.11 — cancelled lifecycle: half-speed return then redock, no caution flag.
        if (ship.status === 'cancelling') {
            const startedAt = ship.cancelReturnStartedAt || now;
            if (motionScale === 0 || now - startedAt >= CANCEL_RETURN_MS) {
                ship.status = 'docked';
                ship.pushStatus = 'cancelled';
                ship.cancelledAt = now;
                ship.cancelReturnStartedAt = null;
                ship.departStartedAt = null;
                ship.visualPackLeadId = null;
                ship.visualPackSize = null;
                ship.departEventId = null;
            }
            continue;
        }
        // 3.2 — inbound lifecycle: arrive then dock (pull) or anchor (fetch,
        // a moored PR, a merged PR at its quay berth).
        if (ship.status === 'arriving') {
            const startedAt = ship.arrivingStartedAt || now;
            const duration = Math.max(1, Number(ship.arrivingDuration) || INBOUND_DURATION_MS);
            if (motionScale === 0 || now - startedAt >= duration) {
                if (ship.arrivingKind === 'fetch' || ship.arrivingKind === 'pr') {
                    ship.status = 'anchored';
                    if (ship.arrivingKind === 'pr') ship.prMooredAt = ship.prMooredAt || now;
                } else if (ship.arrivingKind === 'pr-merge') {
                    ship.status = 'anchored';
                    ship.prQuayedAt = ship.prQuayedAt || now;
                } else {
                    ship.status = 'docked';
                    ship.eventTime = ship.eventTime || now;
                }
            }
            continue;
        }
        // 3.2 — anchored fetch ships expire after a while; W7.9 moored and
        // quayed PR cutters on their own holds.
        if (ship.status === 'anchored') {
            const startedAt = ship.arrivingStartedAt || now;
            const expired = ship.arrivingKind === 'pr'
                ? now - (ship.prMooredAt || startedAt) > PR_SHIP_MOOR_MS
                : ship.arrivingKind === 'pr-merge'
                    ? now - (ship.prQuayedAt || startedAt) > PR_QUAY_HOLD_MS
                    : now - startedAt > INBOUND_DURATION_MS * 2;
            if (expired) retireHarborShip(state, id, ship, now, { recordFloor: false });
            continue;
        }
        if (ship.status !== 'departing') continue;
        const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
        const startedAt = ship.departStartedAt || now;
        const progress = motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / departMs));
        if (progress >= 1 && now - startedAt > departMs + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS) {
            const batch = ship.batchId ? state.batches.get(ship.batchId) : null;
            if (batch) {
                const startTile = Number.isFinite(Number(ship?.departFromTile?.tileX))
                    && Number.isFinite(Number(ship?.departFromTile?.tileY))
                    ? { tileX: Number(ship.departFromTile.tileX), tileY: Number(ship.departFromTile.tileY) }
                    : (() => {
                        const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
                        return { tileX: berth.tileX, tileY: berth.tileY };
                    })();
                const route = composeWaterRouteTiles(startTile, ship, null);
                const endpointTile = (batch.status || 'unknown') === 'failed'
                    ? startTile
                    : route?.[route.length - 1] || startTile;
                if (endpointTile) {
                    const world = toWorld(endpointTile.tileX, endpointTile.tileY);
                    if (!batch.sealedOriginPoints) batch.sealedOriginPoints = [];
                    batch.sealedOriginPoints.push({ x: world.x, y: world.y });
                }
            }
            retireHarborShip(state, id, ship, now);
        }
    }

    for (const [id, batch] of state.batches) {
        const age = now - (batch.startedAt || now);
        if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS) {
            state.batches.delete(id);
        }
    }

    pruneHarborShips(state, now);
    pruneHarborBatches(state);
    pruneHarborRepoQuays(state);
    syncRepoAnchorages(state, activeProjects);
    pruneHarborReplayState(state, now);

    return state;
}

function easedDeparture(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function rawGitEventProject(event, agent) {
    return String(event?.project
        || event?.projectPath
        || event?.repository
        || event?.repo
        || event?.workspace
        || agent?.projectPath
        || agent?.teamName
        || agent?.project
        || 'unknown');
}

function canonicalRawGitEventKey(event, agent) {
    const type = gitEventKind(event);
    if (!type) return '';
    const project = rawGitEventProject(event, agent);
    const sha = String(event.sha || event.commit || event.hash || event.commitSha || event.revision || '').trim().toLowerCase();
    const explicitId = event.id || event.eventId || event.uuid || event.key || event.sourceId || '';
    if (explicitId) {
        const discriminator = sha
            || event.commandHash
            || `${event.timestamp || event.time || event.ts || event.completedAt || ''}\x1f${event.branch || event.targetRef || event.ref || ''}`;
        return `${type}\x1f${project}\x1f${String(explicitId)}\x1f${String(discriminator || '')}`;
    }
    if (type === 'commit' && sha) return `${type}\x1f${project}\x1f${sha}`;
    return '';
}

function rawGitEventTime(event) {
    const value = event?.completedAt || event?.completed_at || event?.timestamp || event?.time || event?.ts || 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function rawGitEventCompletionScore(event) {
    if (typeof event?.success === 'boolean') return 2;
    if (Number.isFinite(Number(event?.exitCode ?? event?.exit_code))) return 2;
    if (event?.status != null || event?.outcome != null || event?.conclusion != null) return 1;
    return 0;
}

function preferCanonicalRawGitEvent(previous, candidate) {
    const type = gitEventKind(candidate.event);
    const previousTime = rawGitEventTime(previous.event);
    const candidateTime = rawGitEventTime(candidate.event);
    if (type === 'commit') {
        if (!previousTime) return candidateTime > 0;
        return candidateTime > 0 && candidateTime < previousTime;
    }
    if (candidateTime !== previousTime) return candidateTime > previousTime;
    return rawGitEventCompletionScore(candidate.event) > rawGitEventCompletionScore(previous.event);
}

// W7.9 — `gh pr create|merge` events (the adapter's forge `pr` type) in the
// harbor's normalized shape. The shared git normalizer has no PR kind.
function normalizeHarborPullRequestEvent(event, agent = {}, index = 0) {
    if (String(event?.type || '').toLowerCase() !== 'pr' || event.dryRun === true) return null;
    const action = String(event.action || '').toLowerCase();
    if (action !== 'create' && action !== 'merge') return null;
    const project = String(event.project || event.repository || event.repo || agent.projectPath || agent.project || 'unknown');
    const timestamp = parseEventTime(
        event.timestamp || event.time || event.ts || event.completedAt,
        parseEventTime(agent.lastSessionActivity, 0),
    );
    return {
        id: String(event.id || `pr:${project}:${action}:${timestamp}:${index}`),
        type: 'pr',
        action,
        project,
        timestamp,
        ts: timestamp,
        url: String(event.url || ''),
        title: String(event.title || ''),
        status: gitEventStatusLabel(event),
        label: action === 'merge' ? 'PR merged' : 'PR opened',
        command: event.command ? String(event.command) : '',
        sha: '',
        branch: String(event.branch || ''),
        targetRef: '',
        inferred: true,
        observed: false,
        provider: event.provider || agent.provider || '',
        sessionId: event.sessionId || agent.sessionId || null,
    };
}

function collectHarborGitEvents(agents, options = {}, stats = null) {
    const candidates = [];
    const canonicalCandidates = new Map();
    const normalizedKeys = new Set();
    const seenSourceArrays = new Set();
    let rawCount = 0;
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            if (seenSourceArrays.has(source)) continue;
            seenSourceArrays.add(source);
            source.forEach((event, index) => {
                rawCount++;
                const canonicalKey = canonicalRawGitEventKey(event, agent);
                const candidate = { event, agent, index, order: candidates.length };
                if (!canonicalKey) {
                    candidates.push(candidate);
                    return;
                }
                const previous = canonicalCandidates.get(canonicalKey);
                if (!previous) {
                    canonicalCandidates.set(canonicalKey, candidate);
                    candidates.push(candidate);
                } else if (preferCanonicalRawGitEvent(previous, candidate)) {
                    candidate.order = previous.order;
                    canonicalCandidates.set(canonicalKey, candidate);
                    candidates[previous.order] = candidate;
                }
            });
        }
    }
    const events = [];
    for (const candidate of candidates) {
        const normalized = normalizeGitEvent(candidate.event, candidate.agent, candidate.index, options)
            || normalizeHarborPullRequestEvent(candidate.event, candidate.agent, candidate.index);
        if (!normalized || (options.type && normalized.type !== options.type)) continue;
        const normalizedKey = `${normalized.type}\x1f${normalized.project}\x1f${normalized.id}`;
        if (normalizedKeys.has(normalizedKey)) continue;
        normalizedKeys.add(normalizedKey);
        events.push(normalized);
    }
    events.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    if (stats) {
        stats.rawCount = rawCount;
        stats.normalizedCount = events.length;
    }
    return events;
}

function rawGitEventEdgeVersion(event) {
    if (!event) return '';
    return [
        event.id || event.eventId || event.uuid || event.key || '',
        event.type || event.kind || event.action || '',
        event.status || event.outcome || event.conclusion || '',
        event.success,
        event.exitCode ?? event.exit_code ?? '',
        event.timestamp || event.time || event.ts || '',
        event.completedAt || event.completed_at || '',
        event.sha || event.commit || event.hash || '',
        event.branch || event.targetRef || event.ref || '',
    ].join('\x1f');
}

function harborEventSourceSnapshot(agents) {
    const snapshot = [];
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            snapshot.push({
                agent,
                source,
                length: source.length,
                first: source[0] || null,
                last: source[source.length - 1] || null,
                firstVersion: rawGitEventEdgeVersion(source[0]),
                lastVersion: rawGitEventEdgeVersion(source[source.length - 1]),
                project: agent?.projectPath || agent?.project || '',
                sessionId: agent?.sessionId || agent?.agentId || agent?.id || '',
                provider: agent?.provider || '',
            });
        }
    }
    return snapshot;
}

function harborEventSourcesEqual(previous, next) {
    if (!Array.isArray(previous) || previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index++) {
        const left = previous[index];
        const right = next[index];
        if (left.agent !== right.agent
            || left.source !== right.source
            || left.length !== right.length
            || left.first !== right.first
            || left.last !== right.last
            || left.firstVersion !== right.firstVersion
            || left.lastVersion !== right.lastVersion
            || left.project !== right.project
            || left.sessionId !== right.sessionId
            || left.provider !== right.provider) return false;
    }
    return true;
}

function harborEventsVersion(events) {
    let first = 2166136261;
    let second = 0x9e3779b9;
    const mix = (value) => {
        const text = String(value ?? '');
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            first = Math.imul(first ^ code, 16777619) >>> 0;
            second = (Math.imul(second ^ code, 2246822519) + 3266489917) >>> 0;
        }
        first = Math.imul(first ^ 31, 16777619) >>> 0;
        second = Math.imul(second ^ 131, 2246822519) >>> 0;
    };
    for (const event of events || []) {
        mix(event.id);
        mix(event.type);
        mix(event.project);
        mix(event.branch);
        mix(event.targetRef);
        mix(event.timestamp);
        mix(event.completedAt);
        mix(event.status);
        mix(event.sha);
        mix(event.label);
        mix(event.force);
        mix(event.success);
        mix(event.exitCode);
        mix(event.remote);
        mix(event.ref);
    }
    return `${events?.length || 0}:${first.toString(36)}:${second.toString(36)}`;
}

function harborStateHasTimedLifecycle(state) {
    if (state?.batches?.size) return true;
    for (const ship of state?.ships?.values?.() || []) {
        if (ship.status === 'docked') continue;
        // Moored and quayed PR cutters only expire, on the maintenance tick.
        if (ship.status === 'anchored' && ship.prShip) continue;
        return true;
    }
    return false;
}

export class HarborTraffic {
    constructor({ sprites } = {}) {
        this.sprites = sprites || null;
        this.state = cloneState();
        this._pendingRepoSummaries = [];
        this.harborCrates = new Map();
        this.storageTransfers = new Map();
        this._lastDockLayoutByShipId = new Map();
        // 3.6 — hover lore: per-frame ship positions for hit testing + hovered ship id.
        this.hoveredShipId = null;
        this._shipHitEntries = [];
        this.motionScale = 1;
        this.frame = 0;
        this.waterRouteData = null;
        // #3 — active atmosphere grade; anchorage glows lerp toward worldTint.
        this._grade = null;
        // 6.5 — first sighting of each repo's failure bracket: { firstSeen, fresh }.
        this._failureBrackets = new Map();
        // #18 — repos seen at least once, so a brand-new repo's first anchorage
        // can fire a one-time christening (maiden banner) and skip it thereafter.
        this._repoFirstSeen = new Map();
        this._activeRepoAnchorages = new Map();
        this._activeProjectsKey = '';
        this._lastEventsVersion = '';
        this._nextMaintenanceAt = 0;
        this._stateVersion = 0;
        this._stateReductions = 0;
        this._unchangedReconciliations = 0;
        this._eventSourceSnapshot = null;
        this._sourceNormalizations = 0;
        this._sourceCacheHits = 0;
        this._advanceCalls = 0;
        this._reconcileCalls = 0;
        this._lastRawEventCount = 0;
        this._lastNormalizedEventCount = 0;
        this._hasTimedLifecycle = false;
        this._dockLayout = buildDockSquadLayout(this.state);
        this._repoDockSummaryCache = new Map();
        // The semantic state retains replay history, but frames only need the
        // pack representatives chosen by the titan packing policy plus
        // currently animated ships. Rebuild this window when state changes
        // instead of walking the complete retained history every frame.
        this._packedDockedEntries = [];
        this._activeRenderShips = [];
        this._repoQuayDrawableCache = [];
        this._markerByRepoCache = new Map();
        this._repoAnchorageDrawableCache = [];
        this._drawableBuffer = [];
        this._hullItems = [];
        this._hullItemPool = new Map();
        this._departingBuffer = [];
        this._crateDrawnForKeys = new Set();
        this._convoyGroups = new Map();
        // 8.2 — release sloops by crown key (see launchReleaseSail).
        this._releaseSails = new Map();
        this._enumeratedFrame = -1;
        this._previousDebugHarbor = null;
        this._disposed = false;
        if (typeof window !== 'undefined' && window.localStorage?.getItem('claudeVilleDebug') === '1') {
            this._previousDebugHarbor = window.__harbor || null;
            window.__harbor = this;
        }
    }

    _applyReadableTextShadow(ctx) {
        ctx.shadowColor = 'rgba(8, 5, 4, 0.88)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    _fillReadableText(ctx, text, x, y, maxWidth) {
        ctx.save();
        this._applyReadableTextShadow(ctx);
        if (maxWidth != null) ctx.fillText(text, x, y, maxWidth);
        else ctx.fillText(text, x, y);
        ctx.restore();
    }

    _drawRepoLabelIcon(ctx, x, y, size, profile = null) {
        const r = size / 2;
        ctx.save();
        this._applyReadableTextShadow(ctx);
        ctx.fillStyle = profile?.accent || '#f6d384';
        ctx.strokeStyle = 'rgba(255, 240, 184, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (profile?.isBranchVariant) {
            ctx.strokeStyle = 'rgba(19, 12, 8, 0.78)';
            ctx.beginPath();
            ctx.moveTo(x - r * 0.3, y - r * 0.35);
            ctx.lineTo(x + r * 0.25, y + r * 0.2);
            ctx.lineTo(x + r * 0.52, y + r * 0.2);
            ctx.stroke();
        }
        ctx.restore();
    }

    setWaterRouteData(routeData) {
        this.waterRouteData = routeData || null;
        this._enumeratedFrame = -1;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        if (this.motionScale <= 0) this.storageTransfers.clear();
        this._enumeratedFrame = -1;
    }

    setGradeState(grade) {
        this._grade = grade || null;
    }

    update(agents, dt = 16, now = Date.now()) {
        if (this._disposed) return;
        this.advance(dt);
        this.reconcile(agents, now);
    }

    advance(dt = 16) {
        if (this._disposed) return;
        this._advanceCalls++;
        this.frame += (dt / 16) * this.motionScale;
    }

    reconcile(agents, now = Date.now(), { force = false } = {}) {
        if (this._disposed) return this;
        this._reconcileCalls++;
        const sourceSnapshot = harborEventSourceSnapshot(agents);
        const sourceChanged = !harborEventSourcesEqual(this._eventSourceSnapshot, sourceSnapshot);
        let events = [];
        let eventsVersion = this._lastEventsVersion;
        if (sourceChanged || force) {
            const stats = {};
            events = collectHarborGitEvents(agents, {
                maxLabelChars: MAX_LABEL_CHARS,
                ellipsis: '…',
            }, stats);
            eventsVersion = harborEventsVersion(events);
            if (sourceChanged) this._eventSourceSnapshot = sourceSnapshot;
            this._sourceNormalizations++;
            this._lastRawEventCount = stats.rawCount || 0;
            this._lastNormalizedEventCount = stats.normalizedCount || 0;
        } else {
            this._sourceCacheHits++;
        }
        const eventsChanged = sourceChanged && eventsVersion !== this._lastEventsVersion;
        // Home Waters: live-agent repos claim coastal anchorages through the
        // reducer, so a change in the live set is a reduction trigger too.
        this._observeRepoAnchorages(agents, now);
        const activeProjects = [...this._activeRepoAnchorages.values()].map(entry => entry.project);
        const activeProjectsKey = [...activeProjects].sort().join('\x1f');
        const activeChanged = activeProjectsKey !== this._activeProjectsKey;
        const shouldReduce = force
            || eventsChanged
            || activeChanged
            || this._hasTimedLifecycle
            || now >= this._nextMaintenanceAt;
        if (shouldReduce) {
            this.state = reduceHarborTrafficState(this.state, force || eventsChanged ? events : [], {
                now,
                motionScale: this.motionScale,
                activeProjects,
            });
            this._lastEventsVersion = eventsVersion;
            this._activeProjectsKey = activeProjectsKey;
            this._nextMaintenanceAt = now + HARBOR_MAINTENANCE_INTERVAL_MS;
            this._hasTimedLifecycle = harborStateHasTimedLifecycle(this.state);
            this._stateVersion++;
            this._stateReductions++;
            this._dockLayout = buildDockSquadLayout(this.state);
            this._repoDockSummaryCache = this._repoDockSummaries(this._dockLayout);
            this._pendingRepoSummaries = pendingRepoSummariesFromDockSummaries(this._repoDockSummaryCache, this.state.pushEvents.values());
            this._observeStorageTransfers(this._dockLayout, now);
            this._refreshRenderWindow(now);
        } else {
            this._unchangedReconciliations++;
        }
        this._observeHarborCrates(agents, sourceChanged || force ? events : [], now);
        this._repoAnchorageDrawableCache = this._repoAnchorageDrawables(this._repoDockSummaryCache, now);
        this._observePeakDensity(now);
        this._enumeratedFrame = -1;
        return this;
    }

    getDiagnostics() {
        return {
            stateVersion: this._stateVersion,
            stateReductions: this._stateReductions,
            unchangedReconciliations: this._unchangedReconciliations,
            sourceNormalizations: this._sourceNormalizations,
            sourceCacheHits: this._sourceCacheHits,
            animationAdvances: this._advanceCalls,
            semanticReconciliations: this._reconcileCalls,
            rawEventCount: this._lastRawEventCount,
            normalizedEventCount: this._lastNormalizedEventCount,
            seenEventIds: this.state.seenEventIds.size,
            maxSeenEventIds: MAX_HARBOR_SEEN_EVENT_IDS,
            pushEvents: this.state.pushEvents.size,
            maxPushEvents: MAX_HARBOR_PUSH_EVENTS,
            ships: this.state.ships.size,
            maxShips: MAX_HARBOR_SHIPS,
            batches: this.state.batches.size,
            maxBatches: MAX_HARBOR_BATCHES,
            repoQuays: this.state.repoQuays.size,
            maxRepoQuays: MAX_HARBOR_REPO_QUAYS,
            eventTombstones: this.state.eventTombstones.size,
            maxEventTombstones: MAX_HARBOR_EVENT_TOMBSTONES,
            commitReplayFloors: this.state.commitReplayFloors.size,
            maxCommitReplayFloors: MAX_HARBOR_COMMIT_REPLAY_FLOORS,
            overflowDockCounts: this.state.overflowDockCounts.size,
            maxOverflowDockCounts: MAX_HARBOR_OVERFLOW_DOCK_COUNTS,
            overflowDockedCommits: harborOverflowDockCount(this.state),
            harborCrates: this.harborCrates.size,
            storageTransfers: this.storageTransfers.size,
            activeRepoAnchorages: this._activeRepoAnchorages?.size || 0,
            repoFirstSeen: this._repoFirstSeen.size,
            maxRepoFirstSeen: MAX_REPO_FIRST_SEEN,
            cleanLabelCache: _cleanCommitLabelCache.size,
            cleanLabelCacheLimit: HARBOR_CLEAN_LABEL_CACHE_LIMIT,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (typeof window !== 'undefined' && window.__harbor === this) {
            if (this._previousDebugHarbor && !this._previousDebugHarbor._disposed) window.__harbor = this._previousDebugHarbor;
            else delete window.__harbor;
        }
        this._previousDebugHarbor = null;
        this.state = cloneState();
        this._pendingRepoSummaries = [];
        this.harborCrates.clear();
        this.storageTransfers.clear();
        this._releaseSails.clear();
        this._lastDockLayoutByShipId.clear();
        this._shipHitEntries = [];
        this.hoveredShipId = null;
        this._activeRepoAnchorages.clear();
        this._activeProjectsKey = '';
        this._repoFirstSeen.clear();
        this._eventSourceSnapshot = null;
        this._lastRawEventCount = 0;
        this._lastNormalizedEventCount = 0;
        this._hasTimedLifecycle = false;
        this._dockLayout = null;
        this._repoDockSummaryCache?.clear?.();
        this._packedDockedEntries.length = 0;
        this._activeRenderShips.length = 0;
        this._repoQuayDrawableCache.length = 0;
        this._markerByRepoCache.clear();
        this._repoAnchorageDrawableCache.length = 0;
        this._drawableBuffer.length = 0;
        this._hullItems.length = 0;
        this._hullItemPool.clear();
        this._departingBuffer.length = 0;
        this._crateDrawnForKeys.clear();
        this._convoyGroups.clear();
        this._enumeratedFrame = -1;
        this.waterRouteData = null;
        this._grade = null;
        this._failureBrackets.clear();
        releaseSuccessGrammar(this);
        this.sprites = null;
    }

    /**
     * Track which repos are currently "home" — those with a live agent. The
     * set is merged with docked-ship repos at draw time so a repo that just
     * shipped a commit keeps its anchorage even after its agent departs.
     */
    _observeRepoAnchorages(agents, now = Date.now()) {
        const active = this._activeRepoAnchorages;
        for (const agent of agents || []) {
            const project = agent?.projectPath || agent?.project;
            if (!project) continue;
            const profile = repoProfile(project);
            if (!profile?.key) continue;
            active.set(profile.key, { project, profile, lastActive: now });
        }
        for (const [key, entry] of active) {
            if (now - (entry.lastActive || 0) > REPO_ANCHORAGE_ACTIVE_MS) active.delete(key);
        }
    }

    getPendingRepoSummaries() {
        return this._pendingRepoSummaries || [];
    }

    getRepoSummaries() {
        const summaries = new Map();
        for (const summary of this._pendingRepoSummaries || []) {
            const profile = summary.profile || trafficProfile(summary.project, summary.branch);
            summaries.set(profile.key, {
                project: summary.project,
                branch: summary.branch || '',
                repoName: summary.repoName || trafficLabel(summary.project, summary.branch),
                shortName: summary.shortName || profile.shortName,
                profile,
                pendingCommits: Number(summary.pendingCommits) || 0,
                dockedCommits: 0,
                failedPushes: 0,
                latestEventTime: Number(summary.latestEventTime) || 0,
                waitingZone: summary.waitingZone || 'harbor',
                storageCommits: Number(summary.storageCommits) || 0,
            });
        }
        for (const summary of this._repoDockSummaries().values()) {
            const existing = summaries.get(summary.profile.key) || {
                project: summary.project,
                branch: summary.branch || '',
                repoName: trafficLabel(summary.project, summary.branch),
                shortName: summary.profile.shortName,
                profile: summary.profile,
                pendingCommits: 0,
                dockedCommits: 0,
                failedPushes: 0,
                latestEventTime: 0,
                waitingZone: summary.waitingZone || 'harbor',
                storageCommits: 0,
            };
            existing.dockedCommits += summary.count;
            if (Number(existing.pendingCommits) <= 0) {
                existing.failedPushes += summary.failedCount;
            }
            existing.latestEventTime = Math.max(existing.latestEventTime, summary.latestEventTime || 0);
            if (isCommitLagoonZone(summary.waitingZone)) {
                existing.waitingZone = 'commit-lagoon';
                if (Number(existing.pendingCommits) > 0) {
                    existing.storageCommits = Math.max(existing.storageCommits, Number(summary.count) || 0);
                } else {
                    existing.storageCommits += Number(summary.count) || 0;
                }
            } else {
                existing.waitingZone = existing.waitingZone || 'harbor';
            }
            summaries.set(summary.profile.key, existing);
        }
        return [...summaries.values()]
            .sort((a, b) => (b.failedPushes - a.failedPushes)
                || (b.dockedCommits - a.dockedCommits)
                || (b.pendingCommits - a.pendingCommits)
                || (b.latestEventTime - a.latestEventTime)
                || a.repoName.localeCompare(b.repoName));
    }

    getFailedPushState(now = Date.now()) {
        const repos = new Map();
        let latest = null;
        for (const batch of this.state.batches.values()) {
            if ((batch.status || 'unknown') !== 'failed') continue;
            const age = this._batchSummaryAge(batch, now);
            if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS) continue;
            const profile = trafficProfile(batch.project, batch.branch);
            const current = repos.get(profile.key) || {
                project: batch.project,
                branch: batch.branch || '',
                repoName: trafficLabel(batch.project, batch.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, batch.eventTime || batch.startedAt || 0);
            repos.set(profile.key, current);
            if (!latest || current.latestEventTime > (latest.eventTime || 0)) {
                latest = {
                    id: batch.id,
                    project: batch.project,
                    branch: batch.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: batch.targetRef || '',
                    label: batch.label || '',
                    eventTime: current.latestEventTime,
                };
            }
        }
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked' || ship.pushStatus !== 'failed') continue;
            const profile = trafficProfile(ship.project, ship.branch);
            const eventTime = Math.max(ship.eventTime || 0, ship.failedAt || 0);
            const current = repos.get(profile.key) || {
                project: ship.project,
                branch: ship.branch || '',
                repoName: trafficLabel(ship.project, ship.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, eventTime);
            repos.set(profile.key, current);
            if (!latest || eventTime > (latest.eventTime || 0)) {
                latest = {
                    id: ship.pushEventId || ship.id,
                    project: ship.project,
                    branch: ship.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: ship.label || '',
                    eventTime,
                };
            }
        }
        for (const push of this.state.pushEvents.values()) {
            if ((push.status || 'unknown') !== 'failed' || push.batchId || !push.project) continue;
            const profile = trafficProfile(push.project, push.branch);
            const current = repos.get(profile.key) || {
                project: push.project,
                branch: push.branch || '',
                repoName: trafficLabel(push.project, push.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, push.eventTime || 0);
            repos.set(profile.key, current);
            if (!latest || (push.eventTime || 0) > (latest.eventTime || 0)) {
                latest = {
                    id: push.id,
                    project: push.project,
                    branch: push.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: '',
                    eventTime: push.eventTime || 0,
                };
            }
        }
        const list = [...repos.values()]
            .sort((a, b) => (b.latestEventTime - a.latestEventTime) || a.repoName.localeCompare(b.repoName));
        return {
            hasFailedPush: list.length > 0,
            status: list.length > 0 ? 'failed' : 'ok',
            accent: PUSH_STATUS_STYLE.failed.accent,
            glow: PUSH_STATUS_STYLE.failed.glow,
            intensity: Math.min(1, list.reduce((sum, repo) => sum + repo.failedPushes, 0) / 4),
            latest,
            repos: list,
        };
    }

    // 3.6 — detect projects without upstream tracking. A project is "untethered" if either:
    //   (a) any ship has an explicit hasUpstreamHint === false, OR
    //   (b) it has >= UNTETHERED_MIN_COMMITS docked commits and no push event has ever landed
    //       (the lagoon has held the commits without progress).
    _computeUntetheredProjects(now = Date.now()) {
        const untethered = new Set();
        const dockedByProject = new Map();
        const pushedProjects = new Set();
        for (const push of this.state.pushEvents.values()) {
            if (push?.project) pushedProjects.add(String(push.project));
        }
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const projectKey = String(ship.project || 'unknown');
            const entry = dockedByProject.get(projectKey) || { count: 0, oldest: now };
            entry.count += 1;
            entry.oldest = Math.min(entry.oldest, ship.createdAt || now);
            dockedByProject.set(projectKey, entry);
            if (ship.hasUpstreamHint === false) {
                untethered.add(projectKey);
            }
        }
        for (const [project, entry] of dockedByProject) {
            if (pushedProjects.has(project)) continue;
            if (entry.count >= UNTETHERED_MIN_COMMITS && (now - entry.oldest) >= UNTETHERED_HOLD_MS) {
                untethered.add(project);
            }
        }
        return untethered;
    }

    _observePeakDensity(now) {
        if (!this._peakWindow) this._peakWindow = { peak: 0, since: now };
        if (this.state.ships.size > this._peakWindow.peak) {
            this._peakWindow.peak = this.state.ships.size;
        }
        if (now - this._peakWindow.since > 60000) {
            if (this._peakWindow.peak >= 8
                && typeof window !== 'undefined'
                && window.localStorage?.getItem('claudeVilleDebug') === '1') {
                console.info(`[harbor] peak ships in last minute: ${this._peakWindow.peak}`);
            }
            this._peakWindow = { peak: this.state.ships.size, since: now };
        }
    }

    _observeStorageTransfers(dockLayout, now = Date.now()) {
        const next = new Map();
        for (const [id, meta] of dockLayout?.byShipId?.entries?.() || []) {
            next.set(id, {
                x: meta.x,
                y: meta.y,
                tileX: meta.tileX,
                tileY: meta.tileY,
                waitingZone: meta.waitingZone || 'harbor',
            });
        }

        if (this.motionScale <= 0) {
            this.storageTransfers.clear();
            this._lastDockLayoutByShipId = next;
            return;
        }

        if (!this._lastDockLayoutByShipId.size) {
            this._lastDockLayoutByShipId = next;
            return;
        }

        let transferIndex = 0;
        for (const [id, current] of next) {
            const previous = this._lastDockLayoutByShipId.get(id);
            if (!previous) continue;
            const ship = this.state.ships.get(id);
            if (!ship || ship.status !== 'docked') continue;
            const enteringStorage = !isCommitLagoonZone(previous.waitingZone)
                && isCommitLagoonZone(current.waitingZone);
            if (!enteringStorage || this.storageTransfers.has(id)) continue;

            const fromTile = {
                tileX: Number(previous.tileX),
                tileY: Number(previous.tileY),
            };
            const toTile = {
                tileX: Number(current.tileX),
                tileY: Number(current.tileY),
            };
            this.storageTransfers.set(id, {
                id,
                startedAt: now + transferIndex * STORAGE_TRANSFER_STAGGER_MS,
                duration: STORAGE_TRANSFER_MS,
                routeMetadata: routeGraphMetadata('storage.lagoon-transfer'),
                route: composeStorageTransferTiles(fromTile, toTile, ship)
                    .map(point => toWorld(point.tileX, point.tileY)),
                fromZone: previous.waitingZone || 'harbor',
                toZone: current.waitingZone || 'commit-lagoon',
            });
            transferIndex += 1;
        }

        for (const [id, transfer] of this.storageTransfers) {
            const current = next.get(id);
            if (!current || !isCommitLagoonZone(current.waitingZone)) {
                this.storageTransfers.delete(id);
                continue;
            }
            if (now - (transfer.startedAt || now) > (transfer.duration || STORAGE_TRANSFER_MS) + 250) {
                this.storageTransfers.delete(id);
            }
        }

        this._lastDockLayoutByShipId = next;
    }

    _storageTransferPosition(shipId, fallback, now = Date.now()) {
        const transfer = this.storageTransfers.get(shipId);
        if (!transfer || this.motionScale <= 0) return null;
        const duration = Math.max(1, Number(transfer.duration) || STORAGE_TRANSFER_MS);
        const rawProgress = Math.max(0, Math.min(1, (now - (transfer.startedAt || now)) / duration));
        const eased = easedDeparture(rawProgress);
        const route = Array.isArray(transfer.route) && transfer.route.length
            ? transfer.route
            : [{ x: fallback.x, y: fallback.y }];
        const pos = pointAlongPath(route, eased);
        const tail = pointAlongPath(route, Math.max(0, eased - 0.035));
        if (rawProgress >= 1) {
            this.storageTransfers.delete(shipId);
            return {
                x: fallback.x,
                y: fallback.y,
                tailX: tail.x,
                tailY: tail.y,
                progress: 1,
            };
        }
        return {
            x: pos.x,
            y: pos.y,
            tailX: tail.x,
            tailY: tail.y,
            progress: rawProgress,
        };
    }

    _refreshRenderWindow(now = Date.now()) {
        const dockLayout = this._dockLayout || buildDockSquadLayout(this.state);
        const visualPackByShipId = dockLayout.visualPackByShipId || new Map();
        const untetheredProjects = this._computeUntetheredProjects(now);
        const packed = this._packedDockedEntries;
        const active = this._activeRenderShips;
        packed.length = 0;
        active.length = 0;

        // Squads contain every retained docked ship, while the pack map only
        // contains representatives that can produce a drawable. Materialize
        // that sparse join once per semantic state version.
        for (const squad of dockLayout.squads || []) {
            const visibleSquad = [];
            for (const ship of squad.ships || []) {
                const pack = visualPackByShipId.get(ship.id);
                const meta = pack ? dockLayout.byShipId.get(ship.id) : null;
                if (!pack || !meta) continue;
                visibleSquad.push({ ship, pack, meta, nextMeta: null, drawable: null });
            }
            for (let index = 0; index < visibleSquad.length; index++) {
                const entry = visibleSquad[index];
                entry.nextMeta = visibleSquad[index + 1]?.meta || null;
                const drawable = this._shipDrawable(entry.ship, now);
                if (!drawable) continue;
                const { meta, pack } = entry;
                const payload = drawable.payload;
                payload.x = meta.x;
                payload.y = meta.y;
                payload.repoDockIndex = meta.repoDockIndex;
                payload.repoDockCount = meta.repoDockCount;
                payload.repoTotalDockCount = meta.repoTotalDockCount;
                payload.repoDockVisibleCount = pack.visibleCount || meta.repoDockVisibleCount;
                payload.squadKey = meta.squadKey;
                payload.squadIndex = meta.squadIndex;
                payload.squadCount = meta.squadCount;
                payload.squadShipIndex = Number.isFinite(Number(pack.visualIndex))
                    ? Number(pack.visualIndex)
                    : meta.squadShipIndex;
                payload.squadShipCount = pack.visibleCount || meta.squadShipCount;
                payload.squadDensity = meta.squadDensity;
                payload.compactCommitLabel = meta.compactCommitLabel || pack.visualPackSize > 1;
                payload.showCommitLabel = pack.visualPackSize > 1 ? false : meta.showCommitLabel;
                payload.waitingZone = meta.waitingZone;
                payload.zoneSquadIndex = meta.zoneSquadIndex;
                payload.anchorageName = meta.anchorageName;
                payload.anchorageIndex = meta.anchorageIndex;
                payload.formationColumn = meta.column;
                payload.formationRow = meta.row;
                payload.visualPackSize = pack.visualPackSize;
                payload.visualPackStartIndex = pack.visualPackStartIndex;
                payload.visualPackEndIndex = pack.visualPackEndIndex;
                payload.visualPackHiddenCount = pack.visualPackHiddenCount;
                payload.buntingNext = entry.nextMeta
                    ? { x: entry.nextMeta.x, y: entry.nextMeta.y }
                    : null;
                payload.untetheredFlag = meta.squadShipIndex === 0
                    && untetheredProjects.has(String(payload.project || 'unknown'));
                drawable.sortY = payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
                entry.drawable = drawable;
                packed.push(entry);
            }
        }

        for (const ship of this.state.ships.values()) {
            if (ship.status === 'docked') continue;
            // Pack members sailing behind their titan lead never draw themselves.
            if (ship.visualPackLeadId && ship.visualPackLeadId !== ship.id) continue;
            active.push(ship);
        }

        this._repoQuayDrawableCache = this._repoQuayDrawables(this._repoDockSummaryCache);
        this._markerByRepoCache.clear();
        for (const marker of this._repoQuayDrawableCache) {
            if (marker.payload?.type !== 'repo-quay') continue;
            const profile = marker.payload.profile || trafficProfile(marker.payload.project, marker.payload.branch);
            if (profile.key) this._markerByRepoCache.set(profile.key, marker.payload);
            const baseKey = repoProfile(marker.payload.project).key;
            if (baseKey && !this._markerByRepoCache.has(baseKey)) {
                this._markerByRepoCache.set(baseKey, marker.payload);
            }
        }
        this._enumeratedFrame = -1;
    }

    enumerateDrawables(now = Date.now()) {
        if (this._enumeratedFrame === this.frame) return this._drawableBuffer;
        if (!this._packedDockedEntries.length && this.state.ships.size) {
            this._refreshRenderWindow(now);
        }
        const markerByRepo = this._markerByRepoCache;
        const departing = this._departingBuffer;
        departing.length = 0;
        for (const ship of this._activeRenderShips) {
            const drawable = this._shipDrawable(ship, now);
            if (!drawable) continue;
            departing.push(drawable);
        }

        const visible = this._drawableBuffer;
        visible.length = 0;
        const crateDrawnForKeys = this._crateDrawnForKeys;
        crateDrawnForKeys.clear();
        for (const entry of this._packedDockedEntries) {
            const { drawable, meta, ship } = entry;
            const payload = drawable.payload;
            payload.x = meta.x;
            payload.y = meta.y;
            payload.tailX = ship.tailX;
            payload.tailY = ship.tailY;
            payload.storageTransferProgress = null;
            payload.storageTransfer = false;
            const transfer = this._storageTransferPosition(ship.id, meta, now);
            if (transfer) {
                payload.x = transfer.x;
                payload.y = transfer.y;
                payload.tailX = transfer.tailX;
                payload.tailY = transfer.tailY;
                payload.storageTransferProgress = transfer.progress;
                payload.storageTransfer = transfer.progress < 1;
            }
            payload.harborCrate = !crateDrawnForKeys.has(meta.squadKey)
                ? this.harborCrates.get(meta.squadKey) || null
                : null;
            if (payload.harborCrate) crateDrawnForKeys.add(meta.squadKey);
            drawable.sortY = payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
            visible.push(drawable);
        }

        departing.sort((a, b) => ((a.payload.departStartedAt || 0) - (b.payload.departStartedAt || 0))
            || ((a.payload.departSquadIndex || 0) - (b.payload.departSquadIndex || 0))
            || ((a.payload.eventTime || 0) - (b.payload.eventTime || 0))
            || a.payload.id.localeCompare(b.payload.id));
        const convoyGroups = this._convoyGroups;
        convoyGroups.clear();
        for (const drawable of departing) {
            const convoy = drawable.payload?.convoy;
            if (!convoy?.id || (drawable.payload?.pushStatus || '') !== 'success') continue;
            const list = convoyGroups.get(convoy.id) || [];
            list.push(drawable);
            convoyGroups.set(convoy.id, list);
        }
        for (const list of convoyGroups.values()) {
            if (list.length < RELEASE_CONVOY_MIN_SHIPS) continue;
            list.sort((a, b) => ((Number.isFinite(Number(a.payload.convoy?.index)) ? Number(a.payload.convoy.index) : 0)
                - (Number.isFinite(Number(b.payload.convoy?.index)) ? Number(b.payload.convoy.index) : 0))
                || ((a.payload.departStartedAt || 0) - (b.payload.departStartedAt || 0))
                || a.payload.id.localeCompare(b.payload.id));
            list.forEach((drawable, index) => {
                drawable.payload.convoy = {
                    ...drawable.payload.convoy,
                    visibleCount: list.length,
                    visibleIndex: index,
                };
                if (index === 0) drawable.payload.convoyLeader = true;
                const next = list[index + 1]?.payload;
                if (next) drawable.payload.convoyNext = { x: next.x, y: next.y };
            });
        }
        for (const drawable of departing) {
            visible.push(drawable);
        }
        for (const sail of this._releaseSails.values()) {
            const drawable = this._releaseSailDrawable(sail, now);
            if (drawable) visible.push(drawable);
        }
        for (const drawable of this._harborCrateDrawables(markerByRepo, crateDrawnForKeys)) {
            visible.push(drawable);
        }
        // 3.7 — single lagoon channel buoy at the Commit Lagoon → Harbor seam.
        const buoyDrawable = this._lagoonChannelBuoyDrawable(now);
        if (buoyDrawable) visible.push(buoyDrawable);

        // Home Waters — persistent per-repo anchorages.
        for (const drawable of this._repoAnchorageDrawableCache) {
            visible.push(drawable);
        }

        visible.sort((a, b) => a.sortY - b.sortY);
        // 3.6 — hover lore: snapshot ship positions in draw order for hit testing.
        this._shipHitEntries.length = 0;
        for (const drawable of visible) {
            if (drawable.payload?.type === 'ship') this._shipHitEntries.push(drawable.payload);
        }
        this._enumeratedFrame = this.frame;
        return visible;
    }

    // 3.6 — hover lore: topmost-drawn ship under a world-space point, or null.
    hitTestShip(worldX, worldY) {
        const entries = this._shipHitEntries || [];
        for (let i = entries.length - 1; i >= 0; i--) {
            const ship = entries[i];
            const radius = harborShipCollisionRadius(ship) * 0.8;
            const dx = worldX - ship.x;
            // Hull sprites sit slightly above the anchor point; bias the hit center up.
            const dy = (worldY - (ship.y - 8)) * 1.5;
            if ((dx * dx + dy * dy) <= radius * radius) return ship;
        }
        return null;
    }

    setHoveredShip(shipId) {
        this.hoveredShipId = shipId || null;
    }

    // 3.6 — hover lore: native-tooltip text for a hovered ship (repo + commit subject).
    shipTooltip(ship = {}) {
        const repo = trafficLabel(ship.project, ship.branch, 40);
        if (ship.prShip) return `${repo} - ${pullRequestShipLabel(ship)}`;
        const visualPackSize = Number(ship.visualPackSize);
        if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
            const start = Number.isFinite(Number(ship.visualPackStartIndex))
                ? Number(ship.visualPackStartIndex) + 1
                : 1;
            const end = Number.isFinite(Number(ship.visualPackEndIndex))
                ? Number(ship.visualPackEndIndex) + 1
                : start + visualPackSize - 1;
            return `${repo} - ${Math.round(visualPackSize)} pending commits (${start}-${end})`;
        }
        const subject = cachedCleanCommitSubject(ship.label || '');
        const cargo = subject || `commit ${commitPennantLabel(ship)}`;
        return `${repo} - ${cargo}`;
    }

    // 3.7 — lagoon channel buoy: pulses in the repo accent of whichever ship is mid-storage-transfer.
    _lagoonChannelBuoyDrawable(now = Date.now()) {
        const pos = toWorld(HARBOR_BEACON_BUOY_TILE.tileX, HARBOR_BEACON_BUOY_TILE.tileY);
        let activeProfile = null;
        let activeCount = 0;
        let activeProject = '';
        // Find an active storage transfer (Commit Lagoon ↔ Harbor) to colour the buoy.
        for (const [shipId] of this.storageTransfers) {
            const ship = this.state.ships.get(shipId);
            if (!ship) continue;
            const profile = trafficProfile(ship.project, ship.branch);
            activeProfile = profile;
            activeProject = trafficLabel(ship.project, ship.branch);
            // Dock summaries already include retained and overflow history.
            for (const summary of this._repoDockSummaryCache.values()) {
                if (summary.project === ship.project) activeCount += Number(summary.count) || 0;
            }
            break;
        }
        // v0.23 A5 — flock cast-off pulse: when a multi-ship push has just cast
        // off, the beacon flares in that push's repo accent and fades over ~3s.
        let castOff = 0;
        let castOffProfile = null;
        const castOffWindow = CAST_OFF_MS + 1400;
        for (const ship of this._activeRenderShips) {
            if (ship.status !== 'departing') continue;
            if (Math.max(1, Number(ship.departSquadCount || 1)) < 2) continue;
            const elapsed = now - (Number(ship.departStartedAt) || now);
            if (elapsed < 0 || elapsed > castOffWindow) continue;
            const intensity = 1 - elapsed / castOffWindow;
            if (intensity > castOff) {
                castOff = intensity;
                castOffProfile = trafficProfile(ship.project, ship.branch);
            }
        }
        return {
            kind: 'harbor-traffic',
            sortY: pos.y + 12,
            payload: {
                type: 'lagoon-channel-buoy',
                x: pos.x,
                y: pos.y,
                profile: activeProfile,
                activeProject,
                activeCount,
                castOff,
                castOffAccent: castOffProfile?.accent || null,
                ts: now,
            },
        };
    }

    _harborCrateDrawables(markerByRepo, skipKeys = new Set()) {
        const drawables = [];
        let fallbackIndex = 0;
        for (const [key, crate] of this.harborCrates) {
            if (skipKeys.has(key)) continue;
            const marker = markerByRepo.get(key);
            const quayIndex = assignedQuayIndex(this.state, crate.project);
            const fallbackBerthIndex = QUAY_GROUPS[quayIndex]?.berthIndexes?.[0] ?? fallbackIndex % BERTHS.length;
            const fallbackBerth = BERTHS[fallbackBerthIndex] || BERTHS[0];
            const pos = marker
                ? {
                    x: marker.x + (Number(marker.repoLogIndex || 0) % 2 === 0 ? -86 : 86),
                    y: marker.y + REPO_DOCK_SHIP_Y_OFFSET + 42,
                }
                : toWorld(fallbackBerth.tileX, fallbackBerth.tileY);
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y + REPO_DOCK_SHIP_SORT_OFFSET,
                payload: {
                    type: 'crate',
                    project: crate.project,
                    profile: crate.profile,
                    harborCrate: crate,
                    berthIndex: fallbackBerthIndex,
                    x: pos.x,
                    y: pos.y,
                },
            });
            fallbackIndex += 1;
        }
        return drawables;
    }

    _observeHarborCrates(agents, events, now) {
        for (const event of events || []) {
            if (event?.type !== 'push') continue;
            const key = repoProfile(event.project).key;
            this.harborCrates.delete(key);
        }

        for (const agent of agents || []) {
            if (!agent?.projectPath && !agent?.project) continue;
            if (!isHarborCrateTool(agent)) continue;
            if (agent.targetBuildingType !== 'harbor' && agent.lastKnownBuildingType !== 'harbor') continue;
            const project = agent.projectPath || agent.project || agent.teamName || 'unknown';
            const profile = repoProfile(project);
            this.harborCrates.set(profile.key, {
                project,
                profile,
                agentId: agent.id,
                label: /git\s+diff\b/i.test(`${agent.currentToolInput || ''} ${agent.lastToolInput || ''}`) ? 'DIFF' : 'STAT',
                createdAt: now,
                expiresAt: now + HARBOR_CRATE_TTL_MS,
            });
        }

        for (const [key, crate] of this.harborCrates) {
            if ((crate.expiresAt || 0) <= now) this.harborCrates.delete(key);
        }
    }

    _repoDockSummaries(dockLayout = null) {
        if (!dockLayout && this._repoDockSummaryCache) return this._repoDockSummaryCache;
        const layout = dockLayout || buildDockSquadLayout(this.state);
        const summaries = new Map();
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const profile = trafficProfile(ship.project, ship.branch);
            const dockMeta = layout.byShipId.get(ship.id);
            const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
            const pos = dockMeta
                ? { x: dockMeta.x, y: dockMeta.y }
                : toWorld(berth.tileX, berth.tileY);
            const waitingZone = dockMeta?.waitingZone
                || ship.waitingZone
                || 'harbor';
            const summaryKey = `${profile.key}\x1f${waitingZone}`;
            const summary = summaries.get(summaryKey) || {
                project: ship.project,
                branch: ship.branch || '',
                profile,
                summaryKey,
                quayIndex: Number.isFinite(Number(ship.quayIndex)) ? Number(ship.quayIndex) : assignedQuayIndex(this.state, ship.project),
                waitingZone,
                count: 0,
                failedCount: 0,
                x: 0,
                y: 0,
                latestEventTime: 0,
                earliestEventTime: 0,
            };
            summary.count += 1;
            if (ship.pushStatus === 'failed') {
                summary.failedCount += 1;
                summary.failedAgentId ??= ship.agentId || null;
                summary.failedAt = Math.max(Number(summary.failedAt) || 0, Number(ship.failedAt || ship.eventTime) || 0);
            }
            summary.x += pos.x;
            summary.y += pos.y;
            summary.latestEventTime = Math.max(summary.latestEventTime, ship.eventTime || 0);
            const isCommitShip = ship.isInbound !== true && (ship.gitKind || 'commit') === 'commit';
            const eventTime = Number(ship.eventTime) || 0;
            if (isCommitShip && eventTime > 0) {
                summary.earliestEventTime = summary.earliestEventTime > 0
                    ? Math.min(summary.earliestEventTime, eventTime)
                    : eventTime;
            }
            summary.waitingZone = waitingZone;
            summaries.set(summaryKey, summary);
        }
        for (const overflow of this.state.overflowDockCounts.values()) {
            const count = Math.max(0, Number(overflow.count || 0));
            if (count <= 0) continue;
            const profile = trafficProfile(overflow.project, overflow.branch);
            const waitingZone = overflow.waitingZone || 'harbor';
            const summaryKey = `${profile.key}\x1f${waitingZone}`;
            const summary = summaries.get(summaryKey) || {
                project: overflow.project,
                branch: overflow.branch || '',
                profile,
                summaryKey,
                quayIndex: Number.isFinite(Number(overflow.quayIndex)) ? Number(overflow.quayIndex) : 0,
                waitingZone,
                count: 0,
                failedCount: 0,
                x: 0,
                y: 0,
                latestEventTime: 0,
                earliestEventTime: 0,
            };
            summary.count += count;
            summary.failedCount += Math.max(0, Number(overflow.failedCount || 0));
            summary.latestEventTime = Math.max(summary.latestEventTime, Number(overflow.latestEventTime || 0));
            const overflowEarliestEventTime = Number(overflow.earliestEventTime) || 0;
            if (overflowEarliestEventTime > 0) {
                summary.earliestEventTime = summary.earliestEventTime > 0
                    ? Math.min(summary.earliestEventTime, overflowEarliestEventTime)
                    : overflowEarliestEventTime;
            }
            summary.overflowCount = Math.max(0, Number(summary.overflowCount || 0)) + count;
            summaries.set(summaryKey, summary);
        }
        return summaries;
    }

    _repoQuayDrawables(summaries = this._repoDockSummaries()) {
        const ordered = [...summaries.values()]
            .sort((a, b) => Number(isCommitLagoonZone(b.waitingZone)) - Number(isCommitLagoonZone(a.waitingZone))
                || (a.quayIndex - b.quayIndex)
                || (b.count - a.count)
                || (b.latestEventTime - a.latestEventTime)
                || a.profile.name.localeCompare(b.profile.name));
        const harborAnchor = toWorld(HARBOR_LOG_TILE.tileX, HARBOR_LOG_TILE.tileY);
        const lagoonAnchor = toWorld(COMMIT_LAGOON_LOG_TILE.tileX, COMMIT_LAGOON_LOG_TILE.tileY);
        const drawables = [];

        const lagoonSummaries = ordered.filter(summary => isCommitLagoonZone(summary.waitingZone));
        if (lagoonSummaries.length) {
            const total = lagoonSummaries.reduce((sum, summary) => sum + (Number(summary.count) || 0), 0);
            const leader = lagoonSummaries
                .slice()
                .sort((a, b) => (b.count - a.count)
                    || (b.latestEventTime - a.latestEventTime)
                    || a.profile.name.localeCompare(b.profile.name))[0];
            drawables.push({
                kind: 'harbor-traffic',
                sortY: lagoonAnchor.y - 96,
                payload: {
                    type: 'commit-lagoon-sign',
                    project: leader?.project || '',
                    branch: leader?.branch || '',
                    profile: leader?.profile || repoProfile(leader?.project),
                    count: total,
                    repoName: leader ? trafficLabel(leader.project, leader.branch) : '',
                    x: lagoonAnchor.x,
                    y: lagoonAnchor.y - 96,
                },
            });
        }

        const zoneIndexes = new Map();
        ordered.forEach((summary) => {
            const quayIndex = Number.isFinite(Number(summary.quayIndex)) ? Number(summary.quayIndex) : 0;
            const waitingZone = summary.waitingZone || 'harbor';
            const index = zoneIndexes.get(waitingZone) || 0;
            zoneIndexes.set(waitingZone, index + 1);
            const anchor = isCommitLagoonZone(waitingZone) ? lagoonAnchor : harborAnchor;
            const yOffset = isCommitLagoonZone(waitingZone) ? -66 + index * 16 : -192 + index * 16;
            drawables.push({
                kind: 'harbor-traffic',
                sortY: anchor.y + yOffset + index,
                payload: {
                    type: 'repo-quay',
                    project: summary.project,
                    branch: summary.branch || '',
                    profile: summary.profile,
                    quayName: isCommitLagoonZone(waitingZone)
                        ? 'Commit Lagoon'
                        : (isCoastZone(waitingZone) && COAST_ANCHORAGE_SLOTS[repoAnchorageSlot(this.state, summary.project)]?.name)
                            || QUAY_GROUPS[quayIndex]?.name
                            || 'Quay',
                    waitingZone,
                    count: summary.count,
                    failedCount: summary.failedCount,
                    repoLogIndex: index,
                    x: anchor.x,
                    y: anchor.y + yOffset,
                },
            });
        });

        return drawables;
    }

    /**
     * Home Waters anchorages: one persistent buoy per active repo on the
     * coastal slot the reducer allocated (`state.repoAnchorages`), so the buoy
     * and that repo's docked fleet always share a position. Repos without a
     * slot (pool exhausted) fold into an overflow chip beside the Commit Lagoon.
     */
    _repoAnchorageDrawables(repoSummaries = new Map(), now = Date.now()) {
        const active = this._activeRepoAnchorages;
        const repos = new Map();
        for (const [key, entry] of active) {
            repos.set(key, {
                key,
                project: entry.project,
                profile: entry.profile,
                docked: 0,
                failed: 0,
                lastActive: entry.lastActive || 0,
                live: true,
            });
        }
        for (const summary of repoSummaries.values()) {
            const profile = repoProfile(summary.project);
            const key = profile.key;
            const existing = repos.get(key) || {
                key,
                project: summary.project,
                profile,
                docked: 0,
                failed: 0,
                lastActive: 0,
                live: false,
            };
            existing.docked += Number(summary.count) || 0;
            existing.failed += Number(summary.failedCount) || 0;
            existing.lastActive = Math.max(existing.lastActive, summary.latestEventTime || 0);
            repos.set(key, existing);
        }
        if (!repos.size) return [];

        const shown = [];
        let overflow = 0;
        const seenSlots = new Set();
        for (const repo of repos.values()) {
            const slot = repoAnchorageSlot(this.state, repo.project);
            if (slot == null || seenSlots.has(slot)) {
                overflow += 1;
                continue;
            }
            seenSlots.add(slot);
            repo.slot = slot;
            shown.push(repo);
        }
        shown.sort((a, b) => a.slot - b.slot);

        const drawables = [];
        for (const repo of shown) {
            const tile = COAST_ANCHORAGE_SLOTS[repo.slot];
            if (!tile) continue;
            const pos = toWorld(tile.tileX, tile.tileY);
            const lively = repo.docked > 0 || (now - repo.lastActive) < REPO_ANCHORAGE_ACTIVE_MS;
            // #18 — christening: the first time a repo ever earns an anchorage,
            // emit a one-shot event so ChronicleMonuments raises a maiden banner.
            if (!this._repoFirstSeen.has(repo.key)) {
                this._repoFirstSeen.set(repo.key, now);
                if (this._repoFirstSeen.size > MAX_REPO_FIRST_SEEN) {
                    this._repoFirstSeen.delete(this._repoFirstSeen.keys().next().value);
                }
                eventBus?.emit?.('harbor:repo-christened', {
                    project: repo.project,
                    repoName: repo.profile.shortName,
                    tileX: tile.tileX,
                    tileY: tile.tileY,
                    ts: now,
                });
            }
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y - 2,
                payload: {
                    type: 'repo-anchorage',
                    project: repo.project,
                    profile: repo.profile,
                    repoName: repo.profile.shortName,
                    docked: repo.docked,
                    failed: repo.failed,
                    live: repo.live,
                    lively,
                    slot: repo.slot,
                    x: pos.x,
                    y: pos.y,
                },
            });
        }
        if (overflow > 0) {
            const pos = toWorld(REPO_ANCHORAGE_OVERFLOW_TILE.tileX, REPO_ANCHORAGE_OVERFLOW_TILE.tileY);
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y - 2,
                payload: {
                    type: 'repo-anchorage',
                    overflowMore: overflow,
                    repoName: `+${overflow}`,
                    x: pos.x,
                    y: pos.y,
                },
            });
        }
        return drawables;
    }

    activeFinaleEffects(now = Date.now()) {
        const effects = [];
        for (const batch of this.state.batches.values()) {
            const startedAt = this._batchClockStart(batch, now);
            const age = now - startedAt;
            if (age < 0) continue;
            const status = batch.status || 'unknown';
            const finaleDelay = this._batchFinaleDelay(batch);
            const effectAge = age - finaleDelay;
            if (effectAge < 0 || effectAge > FINALE_EFFECT_MS) continue;
            const origin = this._batchOrigin(batch);
            effects.push({
                ...batch,
                status,
                x: origin.x,
                y: origin.y,
                effectAge,
                progress: Math.max(0, Math.min(1, effectAge / FINALE_EFFECT_MS)),
            });
        }
        return effects.sort((a, b) => (a.startedAt - b.startedAt) || a.id.localeCompare(b.id));
    }

    latestScreenSummary(now = Date.now()) {
        let latest = null;
        for (const batch of this.state.batches.values()) {
            const age = this._batchSummaryAge(batch, now);
            if (age < 0 || age > SCREEN_SUMMARY_MS) continue;
            if (!latest || (batch.startedAt || 0) > (latest.startedAt || 0)) latest = batch;
        }
        return latest;
    }

    _batchFinaleDelay(batch) {
        const status = batch?.status || 'unknown';
        if (status === 'failed' || status === 'rejected' || status === 'cancelled' || this.motionScale === 0) return 0;
        // 3.1 — force-push uses a shorter departure window, so fire the whirlpool earlier.
        const baseDeparture = batch?.force === true ? FORCE_DEPARTURE_MS : DEPARTURE_MS;
        return baseDeparture * 0.96;
    }

    _batchClockStart(batch, now = Date.now()) {
        if ((batch?.status || 'unknown') === 'failed') {
            return batch.statusUpdatedAt || batch.startedAt || now;
        }
        return batch?.startedAt || now;
    }

    _batchSummaryAge(batch, now = Date.now()) {
        return now - this._batchClockStart(batch, now) - this._batchFinaleDelay(batch);
    }

    _batchOrigin(batch) {
        const points = [];
        for (const shipId of batch.shipIds || []) {
            const ship = this.state.ships.get(shipId);
            if (!ship) continue;
            if ((batch.status || 'unknown') === 'failed') {
                const tile = this._shipStartTile(ship);
                points.push(toWorld(tile.tileX, tile.tileY));
                continue;
            }
            const route = this._shipRouteTiles(ship);
            const endpoint = route?.[route.length - 1];
            if (endpoint) points.push(toWorld(endpoint.tileX, endpoint.tileY));
        }
        for (const sealed of batch.sealedOriginPoints || []) {
            points.push({ x: sealed.x, y: sealed.y });
        }
        if (points.length === 0) return toWorld(HARBOR_FINALE_TILE.tileX, HARBOR_FINALE_TILE.tileY);
        const sum = points.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y,
        }), { x: 0, y: 0 });
        return {
            x: sum.x / points.length,
            y: sum.y / points.length,
        };
    }

    _shipStartTile(ship) {
        if (Number.isFinite(Number(ship?.departFromTile?.tileX)) && Number.isFinite(Number(ship?.departFromTile?.tileY))) {
            return {
                tileX: Number(ship.departFromTile.tileX),
                tileY: Number(ship.departFromTile.tileY),
            };
        }
        const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
        return { tileX: berth.tileX, tileY: berth.tileY };
    }

    _shipRouteTiles(ship) {
        return composeWaterRouteTiles(this._shipStartTile(ship), ship, this.waterRouteData);
    }

    draw(ctx, drawable, zoom = 1) {
        if (!drawable?.payload) return;
        if (drawable.payload.type === 'cluster') {
            this._drawClusterTag(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'repo-quay') {
            this._drawRepoQuayMarker(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'repo-anchorage') {
            this._drawRepoAnchorage(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'commit-lagoon-sign') {
            this._drawCommitLagoonSign(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'crate') {
            const profile = drawable.payload.profile || repoProfile(drawable.payload.project);
            this._drawHarborCrate(ctx, drawable.payload, zoom, 1, profile);
            return;
        }
        if (drawable.payload.type === 'lagoon-channel-buoy') {
            this._drawLagoonChannelBuoy(ctx, drawable.payload, zoom);
            return;
        }
        this._drawShip(ctx, drawable.payload, zoom);
    }

    drawFinaleEffects(ctx, now = Date.now()) {
        for (const effect of this.activeFinaleEffects(now)) {
            // 6.5 — failure is marked by the static bracket (drawMoments).
            if (effect.status === 'failed' || effect.status === 'rejected') continue;
            this._drawFinaleEffect(ctx, effect);
        }
    }

    // 6.5 — a verified failed (or remote-rejected) push is marked where it
    // happened: a static red broken bracket over the repo's slip, preceded by
    // one cream flash and a three-step shake of the stamp only — never the
    // camera. Drawn on the upper overlay for both backends. While any bracket
    // stands, success grammar (the release crown) is deferred.
    drawMoments(ctx, zoom = 1, now = Date.now()) {
        if (!ctx) return;
        const marks = this._failureBracketMarks(now);
        if (!marks.length) {
            releaseSuccessGrammar(this);
            return;
        }
        holdSuccessGrammar(this, 400);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (const mark of marks) this._drawFailureBracket(ctx, mark, now);
        ctx.restore();
    }

    // One mark per repo: the docked failed/rejected ship's slip when commits
    // are waiting, else the repo's quay for a failed push with nothing docked.
    // Only verified outcomes (success:false or a non-zero exit) reach here.
    _failureBracketMarks(now = Date.now()) {
        const marks = new Map();
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            if (ship.pushStatus !== 'failed' && ship.pushStatus !== 'rejected') continue;
            const key = String(ship.project || 'unknown');
            if (marks.has(key)) continue;
            marks.set(key, {
                key,
                tile: this._shipStartTile(ship),
                onShip: true,
                agentId: ship.agentId || null,
                eventTime: Number(ship.failedAt || ship.rejectedAt || 0),
            });
        }
        for (const push of this.state.pushEvents.values()) {
            const status = push.status || 'unknown';
            if ((status !== 'failed' && status !== 'rejected') || push.batchId || !push.project) continue;
            const key = String(push.project);
            if (marks.has(key)) continue;
            marks.set(key, {
                key,
                tile: this._repoSlipTile(push.project),
                onShip: false,
                agentId: push.agentId || null,
                eventTime: Number(push.eventTime || 0),
            });
        }
        for (const key of this._failureBrackets.keys()) {
            if (!marks.has(key)) this._failureBrackets.delete(key);
        }
        const list = [];
        for (const mark of marks.values()) {
            if (list.length >= FAILURE_BRACKET_MAX) break;
            let seen = this._failureBrackets.get(mark.key);
            if (!seen) {
                seen = {
                    firstSeen: now,
                    fresh: mark.eventTime > 0 && now - mark.eventTime < FAILURE_BRACKET_FRESH_MS,
                    // 8.3 — the cream frame lands on the failed push's note.
                    cue: createCueGate('pushFailed', mark.agentId),
                };
                this._failureBrackets.set(mark.key, seen);
            }
            mark.firstSeen = seen.firstSeen;
            mark.fresh = seen.fresh;
            mark.cue = seen.cue;
            list.push(mark);
        }
        return list;
    }

    // A failure with nothing docked is marked on the Harbor's own jetty, where
    // a repo's ships tie up — never out on open water. Each quay group has its
    // own post along the jetty so up to four failing repos do not stack.
    _repoSlipTile(project) {
        const key = String(project || 'unknown');
        const assigned = this.state.repoQuays?.get?.(key);
        const index = Number.isFinite(assigned) ? assigned : stableHash(key) % QUAY_GROUPS.length;
        return HARBOR_JETTY_SLIPS[index % HARBOR_JETTY_SLIPS.length];
    }

    // ─── 8.2 — a verified release sails from the pier ────────────────────────
    // ChronicleMonuments drives the sloop from the release crown's moment
    // clock: `launchReleaseSail` reveals it at the release slip (bare mast)
    // with `clock(now)` → { phase, step, reduced } | null, read before the
    // drawables of each frame so the hoist, the peak rim and the chevrons land
    // on the crown's own frames; `releaseSailArrived` holds the crown until the
    // sloop is fully in; `stageReleaseSail` re-reads the phase at overlay time
    // and returns the masthead the crown blooms over; `endReleaseSail` hands
    // the sloop to open water (under reduced motion: clears it). Only a
    // planted, verified release record ever launches one. Returns the ms
    // until it has arrived (what the crown waits), or null when none launched.
    launchReleaseSail({ key, project = null, label = null, clock = null, now = Date.now() } = {}) {
        if (!key || this._releaseSails.has(key)) return null;
        while (this._releaseSails.size >= RELEASE_SAIL_LIMIT) {
            this._releaseSails.delete(this._releaseSails.keys().next().value);
        }
        const id = `release-sail:${key}`;
        const route = [RELEASE_SAIL_SLIP, ...this._shipRouteTiles({ id, departFromTile: RELEASE_SAIL_OUT, laneIndex: 0 })]
            .map(point => toWorld(point.tileX, point.tileY));
        let length = 0;
        for (let i = 1; i < route.length; i++) length += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        // The first leg's unit heading, for the stern while still at the slip.
        const next = route[1] || route[0];
        const leadLength = Math.hypot(next.x - route[0].x, next.y - route[0].y) || 1;
        const lead = { x: (next.x - route[0].x) / leadLength, y: (next.y - route[0].y) / leadLength };
        this._releaseSails.set(key, {
            key,
            id,
            project,
            label,
            route,
            length,
            lead,
            launchedAt: now,
            castOffAt: null,
            ended: false,
            still: false,
            hoist: -1,
            peak: false,
            chevrons: -1,
            drawn: null,
            clock: typeof clock === 'function' ? clock : null,
        });
        this._enumeratedFrame = -1;
        return this.motionScale > 0 ? RELEASE_SAIL_ARRIVE_STEP_MS * 4 : 0;
    }

    // Whether the release sloop has revealed at its slip and sat whole for
    // one step (so no frame hoists on a part-revealed hull); at once under
    // reduced motion, and a sloop that is gone never holds the crown.
    releaseSailArrived(key, now = Date.now(), { reduced = false } = {}) {
        const sail = this._releaseSails.get(key);
        if (!sail || reduced || sail.still || this.motionScale <= 0) return true;
        return now - sail.launchedAt >= RELEASE_SAIL_ARRIVE_STEP_MS * 4;
    }

    // The arrival's reveal level (the share of hull texels up): 1/4 → 4/4,
    // one step per RELEASE_SAIL_ARRIVE_STEP_MS; 1 when motion is off.
    _releaseSailArrivalAlpha(sail, now, reduced = false) {
        if (reduced || sail.still || this.motionScale <= 0) return 1;
        const step = Math.floor(Math.max(0, now - sail.launchedAt) / RELEASE_SAIL_ARRIVE_STEP_MS);
        return Math.min(4, step + 1) / 4;
    }

    // `phase`/`step`: the crown's momentPhase this frame. Returns the world
    // masthead { x, y, flagTop, depthY, tiedUp } of the pose drawn this frame
    // (the slip while the hull strip loads), or null for an unknown key.
    stageReleaseSail(key, { phase = null, step = 0, reduced = false, now = Date.now() } = {}) {
        const sail = this._releaseSails.get(key);
        if (!sail) return null;
        this._stageReleaseSail(sail, phase, step, reduced, now);
        return this._releaseSailMast(sail);
    }

    // `phase`/`step`: the crown's momentPhase this frame.
    _stageReleaseSail(sail, phase, step, reduced, now) {
        const still = reduced || this.motionScale <= 0;
        const hoist = phase === 'anticipation' ? Math.min(2, step) : 3;
        const peak = phase === 'peak';
        const chevrons = !still && phase === 'follow' ? step : -1;
        if (!still && sail.castOffAt == null && (phase === 'follow' || phase === 'residue')) sail.castOffAt = now;
        if (still !== sail.still || hoist !== sail.hoist || peak !== sail.peak || chevrons !== sail.chevrons) {
            sail.still = still;
            sail.hoist = hoist;
            sail.peak = peak;
            sail.chevrons = chevrons;
            this._enumeratedFrame = -1;
        }
    }

    // The crown's moment is over (or was never staged): a sloop still at its
    // slip casts off now, bare-masted if it never hoisted; under reduced
    // motion it is cleared with the static crown.
    endReleaseSail(key, now = Date.now()) {
        const sail = this._releaseSails.get(key);
        if (!sail) return;
        sail.ended = true;
        sail.peak = false;
        sail.chevrons = -1;
        if (sail.still || this.motionScale <= 0) this._releaseSails.delete(key);
        else if (sail.castOffAt == null) sail.castOffAt = now;
        this._enumeratedFrame = -1;
    }

    _releaseSailMast(sail) {
        const ship = sail.drawn;
        const start = sail.route[0];
        if (!ship) return { x: Math.round(start.x), y: Math.round(start.y) - 40, flagTop: Math.round(start.y) - 40, depthY: start.y, tiedUp: true };
        const pose = this._hullPose(ship);
        const mast = pose ? hullMasthead(pose) : { x: Math.round(ship.x), y: Math.round(ship.y) - 40 };
        const flag = this._flagAnchor(ship, RELEASE_SAIL_CLASS);
        return {
            x: mast.x,
            y: mast.y,
            flagTop: Math.min(mast.y, flag.y),
            depthY: ship.y,
            tiedUp: ship.status === 'docked',
        };
    }

    // Distance sailed `ms` after cast-off: an even acceleration over the
    // follow to cruise, then cruise.
    _releaseSailDistance(ms) {
        const t = Math.max(0, ms);
        if (t < RELEASE_SAIL_ACCEL_MS) return RELEASE_SAIL_CRUISE * t * t / (2 * RELEASE_SAIL_ACCEL_MS);
        return RELEASE_SAIL_CRUISE * (t - RELEASE_SAIL_ACCEL_MS / 2);
    }

    _releaseSailDrawable(sail, now) {
        if (!sail.ended && sail.clock) {
            const clock = sail.clock(now);
            // The clock may end the crown (and with it, under reduced motion,
            // this sloop).
            if (!this._releaseSails.has(sail.key)) return null;
            if (clock) this._stageReleaseSail(sail, clock.phase, clock.step, clock.reduced, now);
        }
        const route = sail.route;
        const start = route[0];
        let x = start.x;
        let y = start.y;
        let tailX = x;
        let tailY = y;
        // Fading in at the slip until it has arrived (the crown waits).
        let alpha = this._releaseSailArrivalAlpha(sail, now);
        let progress = 0;
        const sailing = sail.castOffAt != null && !sail.still;
        if (sailing) {
            const d = this._releaseSailDistance(now - sail.castOffAt);
            if (!(sail.length > 0) || d >= sail.length) {
                this._releaseSails.delete(sail.key);
                return null;
            }
            progress = d / sail.length;
            const pos = pointAlongPath(route, progress);
            // The heading: a point 12 px back along the route (along the first
            // leg while fewer than 12 px out).
            const back = d >= 12
                ? pointAlongPath(route, (d - 12) / sail.length)
                : { x: pos.x - sail.lead.x * 12, y: pos.y - sail.lead.y * 12 };
            x = pos.x;
            y = pos.y;
            tailX = back.x;
            tailY = back.y;
            const left = sail.length - d;
            if (left < RELEASE_SAIL_FADE_PX) alpha = Math.ceil(left / RELEASE_SAIL_FADE_PX * 4) / 4;
        }
        const payload = sail.drawn || (sail.drawn = { type: 'ship', releaseSail: true });
        payload.id = sail.id;
        payload.project = sail.project;
        payload.branch = null;
        payload.label = sail.label;
        payload.status = sailing ? 'departing' : 'docked';
        payload.x = x;
        payload.y = y;
        payload.tailX = tailX;
        payload.tailY = tailY;
        payload.progress = progress;
        payload.releaseAlpha = alpha;
        // The V wake waits until the cast-off chevrons are spent.
        payload.releaseWake = sailing && sail.chevrons < 0 && progress > 0;
        payload.hoist = sail.hoist;
        payload.peak = sail.peak;
        payload.chevrons = sail.chevrons;
        return { kind: 'harbor-traffic', sortY: y, payload };
    }

    // The sloop's marks (its hull, reflection and wake are the harbor-hulls
    // records): the sail outline on the one cream frame, the gold pennant on
    // its hoist, the two cast-off chevrons astern. No repo flag, plate or
    // badge: the release pennant is this ship's one flag. Marks are drawn at
    // full strength (never translucent) while at least 3/4 of the hull's
    // texels are up.
    _drawReleaseSailMarks(ctx, ship) {
        const alpha = ship.releaseAlpha ?? 1;
        if (alpha < 0.75) return;
        ctx.save();
        const strip = hullStrip(this.sprites?.assets, RELEASE_SAIL_CLASS.spriteId);
        const pose = strip ? this._hullPose(ship) : null;
        if (ship.peak && pose) {
            const outline = releaseSailOutline(strip, pose.frame);
            if (outline) {
                const g = hullGeometry(pose);
                // 10.2 — a verified release's peak frame: on the resident
                // path its cream rim is a role-2 GPU mark (peakMarkSink).
                const sink = peakMarkSink(ctx);
                if (sink) {
                    ctx.fillStyle = PEAK;
                    const { runs } = outline;
                    for (let index = 0; index < runs.length; index += 3) sink(g.x + runs[index], g.y + runs[index + 1], runs[index + 2], 1);
                } else {
                    ctx.drawImage(outline.canvas, g.x, g.y);
                }
            }
        }
        if (ship.hoist >= 0) {
            const { x, y } = this._flagAnchor(ship, RELEASE_SAIL_CLASS);
            const flown = ship.hoist >= 3;
            const windX = currentPennantWind();
            drawPennant(ctx, x, y + 16 + RELEASE_SAIL_HOIST_DROP[Math.min(3, ship.hoist)], {
                accent: GOLD,
                shade: GOLD_RAMP[0],
                frame: flown ? pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 1 }) : PENNANT_REST_FRAME,
                windX,
                withPole: flown,
            });
        }
        if (ship.chevrons >= 0) {
            // Every hull frame faces screen-right, so the waterline stern
            // sits left of the pivot: the chevrons open astern of it on the
            // water (never over the hull), trailing back along the route's
            // heading (the first leg runs bow-first, down and to the right),
            // the pair stepping back 2 texels on the follow's last step.
            const sternX = Math.round(ship.x) - (strip ? Math.round(strip.frameWidth * 0.3) : 16);
            const waterY = Math.round(ship.y);
            let hx = ship.x - ship.tailX;
            let hy = ship.y - ship.tailY;
            const heading = Math.hypot(hx, hy);
            if (heading > 1e-3) {
                hx /= heading;
                hy /= heading;
            } else {
                hx = 1;
                hy = 0;
            }
            const count = ship.chevrons === 0 ? 1 : 2;
            for (let i = 0; i < count; i++) {
                const back = 3 + i * RELEASE_SAIL_CHEVRON_GAP + (ship.chevrons === 2 ? 2 : 0);
                wakeV(ctx, Math.round(sternX - hx * back), Math.round(waterY - hy * back), hx, hy, {
                    length: RELEASE_SAIL_CHEVRON_LENGTH,
                    halfAngle: 0.7,
                    thick: 2,
                    color: RELEASE_SAIL_FOAM,
                    crest: RELEASE_SAIL_CREST,
                });
            }
        }
        ctx.restore();
    }

    _drawFailureBracket(ctx, mark, now) {
        if (!mark.tile) return;
        const point = toWorld(mark.tile.tileX, mark.tile.tileY);
        const size = mark.onShip ? { width: 30, height: 20, lift: 12 } : { width: 22, height: 14, lift: 6 };
        const animated = mark.fresh && this.motionScale > 0;
        // 8.3 — the cream frame waits for the failed push's first note.
        const age = animated
            ? cueGatedAge(mark.cue, now - mark.firstSeen, FAILURE_BRACKET.anticipation, FAILURE_BRACKET.active)
            : 0;
        const phase = animated ? momentPhase(age, FAILURE_BRACKET) : null;
        // 8.1 — V8: at the slip when that spot is clear and in the safe area;
        // else along the Harbor's own column; else an edge plate.
        const halfW = size.width / 2 + 7;
        const anchor = resolveMomentAnchor(point, {
            building: 'harbor',
            actorId: mark.agentId,
            depthY: point.y,
            extent: { left: -halfW, top: -(size.lift + size.height / 2 + 6), right: halfW, bottom: size.height / 2 + 2 - size.lift },
            id: `failed-push:${mark.key}`,
            kind: 'pushFailed',
            tier: 'medium',
            phase: phase?.phase ?? 'residue',
        });
        if (anchor.mode === 'edge') {
            queueMomentEdgePlate(anchor, { word: 'PUSH FAILED', color: FAILURE, peak: phase?.phase === 'peak', ctx });
            return;
        }
        const x = anchor.x;
        const y = anchor.y - size.lift;
        // The actor → the slip, for the residue window only.
        if (phase?.phase === 'residue') drawMomentThread(ctx, anchor, { color: FAILURE, targetLift: size.lift });
        const options = { width: size.width, height: size.height, broken: true, color: FAILURE, outline: FAILURE_OUTLINE };
        switch (phase?.phase) {
        case 'anticipation':
            // The two halves close in from either side in two held steps.
            ctx.globalAlpha = 0.66;
            bracket(ctx, x, y, { ...options, splitX: [4, 2][quantStep(phase.t, 2)] });
            ctx.globalAlpha = 1;
            break;
        case 'peak':
            bracket(ctx, x, y, { ...options, color: PEAK });
            break;
        case 'follow':
            bracket(ctx, x + FAILURE_SHAKE[phase.step], y, options);
            break;
        default:
            bracket(ctx, x, y, options);
            break;
        }
    }

    drawScreenSummary(ctx, canvas, camera, now = Date.now()) {
        const summary = this.latestScreenSummary(now);
        if (!summary || !canvas) return;
        const style = PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown;
        const profile = trafficProfile(summary.project, summary.branch);
        const age = this._batchSummaryAge(summary, now);
        const fade = this.motionScale === 0
            ? 1
            : Math.min(1, Math.max(0, (SCREEN_SUMMARY_MS - age) / 1600));
        if (fade <= 0) return;

        const project = trafficLabel(summary.project, summary.branch);
        const count = Number(summary.shipCount || 0);
        const commitLabel = count === 1 ? '1 commit' : `${count} commits`;
        const title = summary.status === 'success'
            ? `${commitLabel} successfully pushed`
            : summary.status === 'failed'
                ? 'Push failed'
                : `${commitLabel} sent to sea`;
        const target = summary.targetRef && normalizeRepoBranch(summary.targetRef) !== normalizeRepoBranch(summary.branch)
            ? ` -> ${summary.targetRef}`
            : '';
        const detail = `${project}${target}`;
        const titleLine = shortGitLabel(title, 56, '…');
        const detailLine = shortGitLabel(detail, 60, '…');
        const statusLine = (PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown).shortLabel.toUpperCase();
        ctx.save();
        ctx.font = WORLD_DISPLAY_FONT_8;
        const titleWidth = measureLabelText(ctx, titleLine);
        ctx.font = WORLD_BODY_FONT_11;
        const detailWidth = measureLabelText(ctx, detailLine);
        ctx.restore();
        const width = Math.min(500, Math.max(344, Math.max(titleWidth, detailWidth) + 76));
        const height = 82;
        const origin = this._batchOrigin(summary);
        const screen = camera?.worldToScreen
            ? camera.worldToScreen(origin.x, origin.y)
            : { x: canvas.width - width - 18, y: 72 };
        const maxX = canvas.width - width - 14;
        const maxY = canvas.height - height - 14;
        let x = Math.round(Math.max(14, Math.min(maxX, screen.x - width / 2)));
        let y = Math.round(Math.max(14, Math.min(maxY, screen.y - height - 26)));

        ctx.save();
        ctx.globalAlpha = fade;
        // C5 — hard 2 px offset block replaces the blurred drop shadow.
        ctx.fillStyle = 'rgba(14, 8, 5, 0.46)';
        ctx.fillRect(x + 2, y + 2, width, height);
        ctx.fillStyle = style.panel;
        ctx.fillRect(x, y, width, height);
        // C5 — integer fillRect rims replace the 0.5-offset lineWidth-2 strokes.
        ctx.fillStyle = 'rgba(255, 224, 150, 0.34)';
        ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
        ctx.fillStyle = style.panelBorder || style.accent;
        ctx.fillRect(x, y, width, 1);
        ctx.fillRect(x, y + height - 1, width, 1);
        ctx.fillRect(x, y + 1, 1, height - 2);
        ctx.fillRect(x + width - 1, y + 1, 1, height - 2);
        ctx.fillStyle = style.accent;
        ctx.fillRect(x, y, 7, height);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + 9, y + 5, 4, height - 10);
        ctx.fillStyle = 'rgba(255, 239, 185, 0.13)';
        ctx.fillRect(x + 15, y + 6, width - 22, 1);
        ctx.fillRect(x + 15, y + height - 7, width - 22, 1);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = '#fff0b8';
        this._fillReadableText(ctx, titleLine, x + 26, y + 20);
        this._drawRepoLabelIcon(ctx, x + 27, y + 44, 8, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.font = WORLD_BODY_FONT_11;
        this._fillReadableText(ctx, detailLine, x + 38, y + 48);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.62)';
        ctx.font = WORLD_DISPLAY_FONT_8;
        this._fillReadableText(ctx, statusLine, x + 26, y + 66);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.42)';
        ctx.fillRect(x + 94, y + 56, Math.max(34, width - 114), 1);
        ctx.restore();
    }

    _shipDrawable(ship, now) {
        const startTile = this._shipStartTile(ship);
        const start = toWorld(startTile.tileX, startTile.tileY);
        let x = start.x;
        let y = start.y;
        let progress = 0;
        let castOff = 0;
        let castingOff = false;
        let inboundProgress = 0;

        if (ship.status === 'departing') {
            const route = this._shipRouteTiles(ship).map(point => toWorld(point.tileX, point.tileY));
            const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
            const startedAt = ship.departStartedAt || now;
            const elapsed = Math.max(0, now - startedAt);
            // Cast-off phase ('casting-off'): hold ship at berth, stutter east ~8px.
            if (this.motionScale > 0 && elapsed < CAST_OFF_MS) {
                castingOff = true;
                ship.phase = 'casting-off';
                castOff = elapsed / CAST_OFF_MS;
                x = start.x + castOff * 8;
                y = start.y;
            } else {
                if (ship.phase === 'casting-off') ship.phase = 'departing';
                const effectiveElapsed = Math.max(0, elapsed - CAST_OFF_MS);
                progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, effectiveElapsed / departMs));
                const eased = easedDeparture(progress);
                const pos = pointAlongPath(route, eased);
                const previous = pointAlongPath(route, Math.max(0, eased - 0.035));
                x = pos.x;
                y = pos.y;
                ship.tailX = previous.x;
                ship.tailY = previous.y;
                // v0.23 A5 — perpendicular serpentine sway along the heading so
                // the flock weaves rather than sailing dead-straight.
                if (this.motionScale > 0) {
                    const hdx = pos.x - previous.x;
                    const hdy = pos.y - previous.y;
                    const len = Math.hypot(hdx, hdy) || 1;
                    const swayPhase = (stableHash(`${ship.id || ''}:sway`) % 1000) / 1000 * Math.PI * 2;
                    const sway = Math.sin(progress * Math.PI * 3 + swayPhase) * 4;
                    x += (-hdy / len) * sway;
                    y += (hdx / len) * sway;
                }
                if (progress >= 1 && this.motionScale === 0) return null;
            }
        } else if (ship.status === 'rejecting') {
            // Boomerang: 16s out, 12s back; turn 180° at apex.
            const route = this._shipRouteTiles(ship).map(point => toWorld(point.tileX, point.tileY));
            const startedAt = ship.boomerangStartedAt || now;
            const elapsed = Math.max(0, now - startedAt);
            let phaseProgress;
            let outbound = true;
            if (elapsed < BOOMERANG_OUT_MS) {
                phaseProgress = elapsed / BOOMERANG_OUT_MS;
                // Outbound never reaches further than the halfway point along the route.
                const eased = easedDeparture(phaseProgress) * 0.5;
                const pos = pointAlongPath(route, eased);
                const previous = pointAlongPath(route, Math.max(0, eased - 0.035));
                x = pos.x;
                y = pos.y;
                ship.tailX = previous.x;
                ship.tailY = previous.y;
                progress = phaseProgress * 0.5;
            } else {
                outbound = false;
                phaseProgress = Math.min(1, (elapsed - BOOMERANG_OUT_MS) / BOOMERANG_IN_MS);
                // Inbound from the apex back toward the berth.
                const eased = 0.5 - easedDeparture(phaseProgress) * 0.5;
                const pos = pointAlongPath(route, eased);
                const next = pointAlongPath(route, Math.min(1, eased + 0.035));
                x = pos.x;
                y = pos.y;
                ship.tailX = next.x;
                ship.tailY = next.y;
                progress = eased;
            }
            return {
                kind: 'harbor-traffic',
                sortY: y,
                payload: {
                    ...ship,
                    type: 'ship',
                    x,
                    y,
                    tailX: ship.tailX,
                    tailY: ship.tailY,
                    progress,
                    boomerangOutbound: outbound,
                    boomerangPhaseProgress: phaseProgress,
                    elapsed,
                },
            };
        } else if (ship.status === 'cancelling') {
            // 5.11 — cancelled return: short outbound (~30%), then back to berth.
            //        Total CANCEL_RETURN_MS, half-speed of a full departure. No flare.
            const route = this._shipRouteTiles(ship).map(point => toWorld(point.tileX, point.tileY));
            const startedAt = ship.cancelReturnStartedAt || now;
            const elapsed = Math.max(0, now - startedAt);
            const phaseProgress = Math.min(1, elapsed / CANCEL_RETURN_MS);
            // 0 → 0.5 (apex) → 0 along the route, peaking at 30% of the way out.
            const apex = 0.30;
            const eased = phaseProgress < 0.5
                ? (phaseProgress / 0.5) * apex
                : apex * (1 - (phaseProgress - 0.5) / 0.5);
            const pos = pointAlongPath(route, eased);
            const trailingDir = phaseProgress < 0.5
                ? pointAlongPath(route, Math.max(0, eased - 0.025))
                : pointAlongPath(route, Math.min(1, eased + 0.025));
            x = pos.x;
            y = pos.y;
            ship.tailX = trailingDir.x;
            ship.tailY = trailingDir.y;
            return {
                kind: 'harbor-traffic',
                sortY: y,
                payload: {
                    ...ship,
                    type: 'ship',
                    x,
                    y,
                    tailX: ship.tailX,
                    tailY: ship.tailY,
                    progress: eased,
                    cancelPhaseProgress: phaseProgress,
                    elapsed,
                },
            };
        } else if (ship.status === 'arriving' || ship.status === 'anchored') {
            // 3.2 — inbound ship: sail toward dock through the reversed route.
            const dockTile = ship.arrivingKind === 'fetch' || ship.arrivingKind === 'pr'
                ? (ship.inboundRoadsteadTile || { tileX: 38.05, tileY: 13.15 })
                : startTile;
            const fakeShipForRoute = { ...ship, departFromTile: dockTile };
            const fwdRoute = composeWaterRouteTiles(dockTile, fakeShipForRoute, this.waterRouteData)
                .map(point => toWorld(point.tileX, point.tileY));
            let reversedRoute = [...fwdRoute].reverse();
            // W7.9 — a merged PR sails in from its mooring, not from the sea:
            // the approach joins the route at its nearest point.
            if (ship.arrivingKind === 'pr-merge' && ship.prFromTile) {
                const from = toWorld(ship.prFromTile.tileX, ship.prFromTile.tileY);
                let nearest = 0;
                let best = Infinity;
                for (let i = 0; i < reversedRoute.length; i++) {
                    const d = (reversedRoute[i].x - from.x) ** 2 + (reversedRoute[i].y - from.y) ** 2;
                    if (d < best) { best = d; nearest = i; }
                }
                const rest = reversedRoute.slice(nearest + 1);
                reversedRoute = [from, ...(rest.length ? rest : reversedRoute.slice(-1))];
            }
            const startedAt = ship.arrivingStartedAt || now;
            const duration = Math.max(1, Number(ship.arrivingDuration) || INBOUND_DURATION_MS);
            inboundProgress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / duration));
            const eased = easedDeparture(inboundProgress);
            const pos = pointAlongPath(reversedRoute, eased);
            const next = pointAlongPath(reversedRoute, Math.min(1, eased + 0.035));
            x = pos.x;
            y = pos.y;
            ship.tailX = next.x;
            ship.tailY = next.y;
        }

        return {
            kind: 'harbor-traffic',
            sortY: y,
            payload: {
                ...ship,
                type: 'ship',
                x,
                y,
                tailX: ship.tailX,
                tailY: ship.tailY,
                progress,
                castingOff,
                castOffProgress: castOff,
                inboundProgress,
                elapsed: Math.max(0, now - (ship.departStartedAt || ship.arrivingStartedAt || ship.boomerangStartedAt || now)),
            },
        };
    }

    // DrawablePass sorts a hull behind a split building by depth
    // (`behindBuilding`, with the building drawable that sorts over it); the
    // marks drop only where that building's silhouette covers the hull on
    // screen: its masthead (where the flag flies) or most of a 3 x 3 grid
    // over the frame. A hull passing behind the Lighthouse footprint beside
    // the slim tower stays in view, and so do its flag and plate.
    _marksHiddenBehindBuilding(ship) {
        const item = this._hullItemPool?.get(ship.id);
        if (!item?.behindBuilding) return false;
        const building = item.behindBuildingDrawable;
        const sprites = this.sprites;
        const pose = item.pose;
        if (!building?.entry?.id || typeof sprites?.hitTest !== 'function' || !pose?.strip) return true;
        const id = building.entry.id;
        const [ax, ay] = sprites.assets?.getAnchor?.(id) || [0, 0];
        const dx = Math.round(building.wx - ax);
        const dy = Math.round(building.wy - ay);
        const mast = hullMasthead(pose);
        if (sprites.hitTest(id, mast.x, mast.y, dx, dy)) return true;
        const g = hullGeometry(pose);
        let covered = 0;
        for (let j = 1; j <= 3; j++) {
            for (let i = 1; i <= 3; i++) {
                if (sprites.hitTest(id, g.x + g.width * i / 4, g.y + g.height * j / 4, dx, dy)) covered++;
            }
        }
        return covered >= 5;
    }

    _drawShip(ctx, ship, zoom) {
        const alpha = this._shipAlpha(ship);
        if (alpha <= 0.02) return;
        // A hull the Harbor hides takes its flags and plates with it, as a
        // body behind a building drops its name.
        if (this._marksHiddenBehindBuilding(ship)) return;
        if (ship.releaseSail) {
            this._drawReleaseSailMarks(ctx, ship);
            return;
        }
        const profile = trafficProfile(ship.project, ship.branch);
        const shipClass = harborShipClass(ship);

        // 3.8 — the hull, its reflection and its V wake are the harbor-hulls
        // scene category (records on the resident path). This pass draws the
        // ship's marks: flags, badges, plates and moorings, which ride the
        // hull's whole-texel sink so a sinking ship takes its flag down.
        ctx.save();
        // 3.6 — amended commit flash hull in repo accent for 400ms.
        const amendFlashAt = Number(ship.amendFlashAt) || 0;
        const amendFlashElapsed = amendFlashAt ? Math.max(0, Date.now() - amendFlashAt) : Infinity;
        const flashing = amendFlashElapsed < 400;
        // 3.1 — force-push: the hull takes its hardest roll frame and sinks
        // in whole texels over the last 4 s of departure (no rotate).
        const sink = this._shipSink(ship);
        const forceSinkAlpha = alpha * sink.alphaScale;
        if (sink.px) ctx.translate(0, sink.px);
        if (flashing && this.motionScale > 0) {
            ctx.save();
            ctx.globalAlpha = 0.42 * (1 - amendFlashElapsed / 400);
            ctx.globalCompositeOperation = 'lighter';
            fillPixelEllipse(ctx, ship.x, ship.y - 2, 26, 14, profile.accent);
            ctx.restore();
        }
        if (!hullStrip(this.sprites?.assets, shipClass.spriteId)) {
            this._drawFallbackBoat(ctx, ship.x, ship.y, forceSinkAlpha, shipClass, profile);
        }
        this._drawShipClassOverlay(ctx, ship, forceSinkAlpha, profile, shipClass, zoom);
        this._drawRepoFlag(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        // 4.17: procedural repo heraldry shield on the squad flagship. Drawn
        // alongside (not replacing) the existing pennant/flag — the small
        // pennant remains for cluster-density reads.
        if (ship.squadShipIndex === 0 && ship.status === 'docked') {
            this._drawRepoShield(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        }
        // 4.17: bunting arc to the next docked sibling in the same squad.
        if (ship.buntingNext && ship.status === 'docked') {
            this._drawSquadBunting(ctx, ship, ship.buntingNext, zoom, forceSinkAlpha, profile);
        }
        ctx.restore();

        if (ship.status === 'departing' && ship.convoy) {
            if (ship.convoyNext) {
                this._drawReleaseConvoyLine(ctx, ship, ship.convoyNext, zoom, forceSinkAlpha, profile);
            }
            this._drawReleaseConvoyCue(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        }

        // 3.1 — red spray particles puff at the keel during sinking (force-push).
        if (this.motionScale > 0 && ship.status === 'departing' && ship.pushForce === true) {
            const departMs = Math.max(1, Number(ship.departMsOverride) || FORCE_DEPARTURE_MS);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const sinkWindow = Math.min(4000, departMs * 0.5);
            const sinkProgress = Math.max(0, Math.min(1, (elapsed - (departMs - sinkWindow)) / sinkWindow));
            if (sinkProgress > 0) {
                this._drawRedSprayParticles(ctx, ship, sinkProgress);
            }
        }

        // Mist fade through the last 800ms of the approach to open water.
        if (this.motionScale > 0 && ship.status === 'departing') {
            const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const mistStart = CAST_OFF_MS + departMs - MIST_FADE_MS;
            if (elapsed >= mistStart) {
                const t = Math.max(0, Math.min(1, (elapsed - mistStart) / MIST_FADE_MS));
                this._drawMistFade(ctx, ship.x, ship.y, t);
            }
        }

        if (ship.status === 'docked' || ship.status === 'anchored') {
            this._drawMooringTick(ctx, ship, zoom, profile, shipClass);
            // Cast-off phase: shrinking mooring tick + puff handled via _drawMooringTick variant.
        }
        if (ship.status === 'departing' && this.motionScale > 0 && Number(ship.elapsed || 0) < CAST_OFF_MS) {
            // mooring tick shrinks as the cast-off animates.
            this._drawMooringTick(ctx, ship, zoom, profile, shipClass, {
                shrink: 1 - Math.min(1, Number(ship.elapsed || 0) / CAST_OFF_MS),
                puff: true,
            });
        }
        // Rejected ships docked back with caution flag overlay.
        if (ship.status === 'docked' && ship.pushStatus === 'rejected') {
            this._drawRejectedCautionFlag(ctx, ship, zoom, shipClass);
        }
        if (ship.prShip) this._drawPullRequestPennant(ctx, ship, zoom, shipClass);
        // Boomerang collision flare at apex (~50% of phase 1).
        if (ship.status === 'rejecting' && ship.boomerangOutbound && Number(ship.boomerangPhaseProgress || 0) > 0.92) {
            this._drawCollisionFlare(ctx, ship.x, ship.y, Math.min(1, (Number(ship.boomerangPhaseProgress) - 0.92) / 0.08));
        }
        // 3.1 — force flag heraldic decorations (only on flagship/dreadnought).
        if (ship.pushForce === 'lease' && (shipClass.key === 'flagship' || shipClass.key === 'dreadnought')) {
            this._drawForceLeaseBanner(ctx, ship, zoom, shipClass);
        } else if (ship.pushForce === 'includes') {
            this._drawForceIncludesUnderline(ctx, ship, zoom, shipClass);
        }
        // Flagship/dreadnought hoist a secondary pennon at cast-off end.
        if ((shipClass.key === 'flagship' || shipClass.key === 'dreadnought')
            && ship.status === 'departing'
            && Number(ship.elapsed || 0) >= CAST_OFF_MS
            && Number(ship.elapsed || 0) < CAST_OFF_MS + 1200) {
            this._drawSecondaryPennon(ctx, ship, zoom, profile, shipClass);
        }
        // 3.6 — untethered (no remote) flagship gets a broken-rope chevron.
        if (ship.untetheredFlag) {
            this._drawUntetheredFlag(ctx, ship, zoom, profile, shipClass);
        }
        // 3.6 — detached HEAD ships get a checkered band on the flag.
        if (ship.detachedHead && !ship.branch) {
            this._drawDetachedHeadBand(ctx, ship, zoom, shipClass);
        }
        // 3.6 — amended commits show a superscript on the flag.
        if (Number(ship.amendCount || 0) > 0) {
            this._drawAmendSuperscript(ctx, ship, zoom, shipClass);
        }
        // 3.2 — inbound pull/fetch ships carry crates per incoming-commit count.
        if (ship.isInbound && Number(ship.inboundCargoCount || 0) > 0) {
            this._drawInboundCrates(ctx, ship, zoom, profile, shipClass);
        }
        if (ship.harborCrate) {
            this._drawHarborCrate(ctx, ship, zoom, alpha, profile, shipClass);
        }
        if (ship.showCommitLabel !== false || ship.pushStatus === 'failed' || ship.pushStatus === 'rejected') {
            this._drawCommitPennant(ctx, ship, zoom, alpha, profile, shipClass);
        }
        // 3.6 — hover lore: hovered ship surfaces its commit subject as a cargo label.
        if (ship.id && ship.id === this.hoveredShipId) {
            this._drawHoverCargoLabel(ctx, ship, zoom, alpha, profile, shipClass);
        }
    }

    // v0.23 A3 / 3.8 — per-ship vertical bob in whole texels (positive = up),
    // phase-seeded off the ship id so a docked flock heaves out of sync.
    // Departing hulls heave harder. Zero under reduced motion.
    _shipBob(ship = {}) {
        if (this.motionScale <= 0) return 0;
        const phase = (stableHash(ship.id || '') % 1000) / 1000 * Math.PI * 2;
        const heave = ship.status === 'departing' ? 1.7 : 1;
        return Math.round(Math.sin(this.frame * 0.08 + phase) * 1.2 * heave);
    }

    // v0.23 A3 / 3.8 — hull roll in degrees (~±1.5°, ~±2.9° departing), a
    // slower off-phase sine so roll and bob never lock. It only selects one of
    // the five baked roll frames (rollFrameIndex); nothing rotates at draw
    // time. Upright under reduced motion.
    _shipRoll(ship = {}) {
        if (this.motionScale <= 0) return 0;
        const phase = (stableHash(ship.id || '') % 1000) / 1000 * Math.PI * 2;
        const heave = ship.status === 'departing' ? 1.9 : 1;
        return Math.sin(this.frame * 0.065 + phase + 0.7) * 1.5 * heave;
    }

    // 3.2 — inbound ships fade in over the first 8 s of approach; departing
    // ships fade out at the end of their route.
    _shipAlpha(ship = {}) {
        if (ship.releaseSail) return ship.releaseAlpha ?? 1;
        if (ship.status === 'departing') return this._departureAlpha(ship);
        // A merged PR cutter is already in view at its mooring.
        if (ship.arrivingKind === 'pr-merge') return 1;
        if (ship.status === 'arriving' || ship.status === 'anchored') {
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            return Math.max(0, Math.min(1, elapsed / INBOUND_FADE_IN_MS));
        }
        return 1;
    }

    // 3.1 / 3.8 — a force-pushed hull sinks 16 texels over the last 4 s of
    // its departure, in whole texels, fading to 45 %.
    _shipSink(ship = {}) {
        if (!(this.motionScale > 0) || ship.status !== 'departing' || ship.pushForce !== true) return NO_SINK;
        const departMs = Math.max(1, Number(ship.departMsOverride) || FORCE_DEPARTURE_MS);
        const sinkWindow = Math.min(4000, departMs * 0.5);
        const elapsed = Math.max(0, Number(ship.elapsed) || 0);
        const progress = Math.max(0, Math.min(1, (elapsed - (departMs - sinkWindow)) / sinkWindow));
        if (!(progress > 0)) return NO_SINK;
        return { progress, px: Math.round(16 * progress), alphaScale: 1 - progress * 0.55 };
    }

    // 3.8 — the whole-texel hull pose the harbor-hulls category draws: roll
    // frame, bob, sink, a 4-step alpha, the V wake while under way, and the
    // repo-accent livery stripe on skiffs (baked into a cached strip copy).
    _hullPose(ship) {
        const shipClass = harborShipClass(ship);
        let strip = hullStrip(this.sprites?.assets, shipClass.spriteId);
        if (!strip) return null;
        const sink = this._shipSink(ship);
        let alpha = Math.round(this._shipAlpha(ship) * sink.alphaScale * 4) / 4;
        if (alpha <= 0) return null;
        if (shipClass.key === 'skiff') {
            const accent = trafficProfile(ship.project, ship.branch).accent;
            strip = liveryStrip(strip, accent, 4 + (stableHash(`${ship.id || ''}:skiff`) % 4));
        }
        // 8.2 — the release sloop comes and goes in whole texels.
        if (ship.releaseSail && alpha < 1) {
            strip = releaseRevealStrip(strip, alpha);
            alpha = 1;
        }
        const frame = sink.progress > 0 ? 4 : rollFrameIndex(this._shipRoll(ship));
        return {
            id: ship.id || `${ship.x},${ship.y}`,
            strip,
            frame,
            x: ship.x,
            y: ship.y,
            bob: this._shipBob(ship),
            sink: sink.px,
            alpha,
            wake: this._shipUnderWay(ship) ? this._wakeHeading(ship, shipClass) : null,
        };
    }

    // Heading from the route sample `_shipDrawable` stored: an inbound ship's
    // tail point lies ahead on its reversed route, every other one behind.
    _wakeHeading(ship, shipClass) {
        const ahead = ship.status === 'arriving' || ship.status === 'anchored';
        const dirX = ahead ? ship.tailX - ship.x : ship.x - ship.tailX;
        const dirY = ahead ? ship.tailY - ship.y : ship.y - ship.tailY;
        // The V runs from the bow: fresh (under the hull) to the stern, then a
        // class-scaled open-water tail that ages out in its 4 steps.
        const strip = hullStrip(this.sprites?.assets, shipClass.spriteId);
        const hold = strip ? Math.round(strip.frameWidth * 0.8) : 20;
        return { dirX, dirY, hold, length: hold + 24 + Math.round(shipClass.wakeScale * 12) };
    }

    // A hull is under way (throws a V wake) while it sails a route: departing
    // past cast-off, rejecting, cancelling, arriving, or mid storage transfer.
    _shipUnderWay(ship = {}) {
        if (ship.releaseSail) return ship.releaseWake === true;
        if (!Number.isFinite(ship.tailX) || !Number.isFinite(ship.tailY)) return false;
        if (Math.abs(ship.x - ship.tailX) + Math.abs(ship.y - ship.tailY) < 0.5) return false;
        if (ship.storageTransfer) return true;
        if (ship.status === 'departing') return !ship.castingOff && ship.progress > 0.002 && ship.progress < 0.97;
        return ship.status === 'rejecting' || ship.status === 'cancelling' || ship.status === 'arriving';
    }

    // 3.8 — one harbor-hulls item per drawn ship, at the ship drawable's
    // painter sortY, carrying its pose and (for the resident path) its
    // records. Items are pooled per ship id.
    enumerateHullDrawables(now = Date.now()) {
        const drawables = this.enumerateDrawables(now);
        const items = this._hullItems;
        items.length = 0;
        const pool = this._hullItemPool;
        for (const drawable of drawables) {
            const ship = drawable.payload;
            if (ship?.type !== 'ship') continue;
            const pose = this._hullPose(ship);
            if (!pose) continue;
            let item = pool.get(pose.id);
            if (!item) {
                item = { kind: 'harbor-hulls', id: pose.id, sortY: 0, x: 0, y: 0, pose: null, records: [] };
                pool.set(pose.id, item);
            }
            item.sortY = drawable.sortY;
            item.x = ship.x;
            item.y = ship.y;
            item.pose = pose;
            hullRecords(pose, item.records);
            items.push(item);
        }
        if (pool.size > items.length * 2 + 32) {
            const live = new Set(items.map(item => item.id));
            for (const id of pool.keys()) if (!live.has(id)) pool.delete(id);
        }
        return items;
    }

    // v0.23 A7 — the repo's lead docked ship (index 0) with more than one commit
    // aboard the fleet.
    _isFleetLead(ship = {}) {
        return ship.status === 'docked'
            && Math.max(0, Number(ship.repoDockIndex || 0)) === 0
            && harborFleetCount(ship) > 1;
    }

    _drawShipClassOverlay(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), zoom = 1) {
        if (hullStrip(this.sprites?.assets, shipClass.spriteId)) {
            this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass, zoom);
            return;
        }

        // No hull art (asset missing or no sprite system): a procedural
        // stand-in at scale 1.
        const scale = 1;
        const cargoRows = Math.max(0, Number(shipClass.cargoRows || 0));
        const mastCount = Math.max(1, Number(shipClass.mastCount || 1));
        const bob = this._shipBob(ship);
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        ctx.lineWidth = Math.max(1, Math.round(1.2 * scale));

        if (scale > 1.02) {
            const deckY = ship.y - (13 + bob) * scale;
            ctx.fillStyle = 'rgba(27, 38, 42, 0.82)';
            ctx.strokeStyle = 'rgba(245, 217, 139, 0.62)';
            ctx.beginPath();
            ctx.moveTo(ship.x - 24 * scale, deckY + 11 * scale);
            ctx.lineTo(ship.x + 24 * scale, deckY - 1 * scale);
            ctx.lineTo(ship.x + 30 * scale, deckY + 7 * scale);
            ctx.lineTo(ship.x - 18 * scale, deckY + 19 * scale);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            ctx.fillRect(Math.round(ship.x - 18 * scale), Math.round(deckY + 6 * scale), Math.max(2, Math.round(36 * scale)), Math.max(1, Math.round(2 * scale)));
        } else {
            const trim = Number(shipClass.trim || 0);
            const deckY = ship.y - (8 + bob) * scale;
            ctx.fillStyle = trim % 2 === 0 ? profile.accent : 'rgba(245, 217, 139, 0.86)';
            ctx.fillRect(Math.round(ship.x - 15 * scale), Math.round(deckY + 7 * scale), Math.max(8, Math.round(24 * scale)), Math.max(1, Math.round(2 * scale)));
            if (trim >= 2) {
                ctx.fillStyle = '#8a5530';
                ctx.strokeStyle = 'rgba(32, 20, 14, 0.78)';
                const crateX = Math.round(ship.x - 7 * scale);
                const crateY = Math.round(ship.y - (16 + bob) * scale);
                ctx.fillRect(crateX, crateY, Math.max(5, Math.round(7 * scale)), Math.max(4, Math.round(6 * scale)));
                ctx.strokeRect(crateX + 0.5, crateY + 0.5, Math.max(5, Math.round(7 * scale)) - 1, Math.max(4, Math.round(6 * scale)) - 1);
            }
        }

        for (let i = 0; i < cargoRows; i++) {
            const row = Math.floor(i / 2);
            const side = i % 2 === 0 ? -1 : 1;
            const w = (8 + row * 2) * scale;
            const h = (7 + row) * scale;
            const x = Math.round(ship.x + side * (5 + row * 4) * scale - w / 2);
            const y = Math.round(ship.y - (19 + row * 7 + bob) * scale);
            ctx.fillStyle = i === 0 ? '#8a5530' : '#6f472d';
            ctx.strokeStyle = 'rgba(32, 20, 14, 0.86)';
            ctx.fillRect(x, y, Math.round(w), Math.round(h));
            ctx.strokeRect(x + 0.5, y + 0.5, Math.round(w) - 1, Math.round(h) - 1);
            ctx.fillStyle = profile.accent;
            ctx.fillRect(x + Math.round(2 * scale), y + Math.round(3 * scale), Math.max(2, Math.round(w - 4 * scale)), Math.max(1, Math.round(scale)));
        }

        if (shipClass.key !== 'skiff') for (let i = 0; i < mastCount; i++) {
            const mastX = ship.x + (i === 0 ? 2 : -13) * scale;
            const mastTop = ship.y - (39 + i * 5 + bob) * scale;
            const mastBase = ship.y - (13 + bob) * scale;
            ctx.strokeStyle = 'rgba(30, 22, 16, 0.92)';
            ctx.lineWidth = Math.max(1, Math.round(2 * scale));
            ctx.beginPath();
            ctx.moveTo(Math.round(mastX), Math.round(mastBase));
            ctx.lineTo(Math.round(mastX), Math.round(mastTop));
            ctx.stroke();
            ctx.fillStyle = i === 0 ? 'rgba(238, 230, 189, 0.94)' : 'rgba(177, 209, 214, 0.90)';
            ctx.strokeStyle = 'rgba(53, 69, 70, 0.78)';
            ctx.beginPath();
            ctx.moveTo(mastX + 1 * scale, mastTop + 4 * scale);
            ctx.lineTo(mastX + (15 - i * 3) * scale, mastTop + (15 + i * 2) * scale);
            ctx.lineTo(mastX + 1 * scale, mastTop + (22 + i * 3) * scale);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            ctx.fillRect(Math.round(mastX + 3 * scale), Math.round(mastTop + (12 + i * 2) * scale), Math.max(5, Math.round(11 * scale)), Math.max(1, Math.round(2 * scale)));
        }

        this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass, zoom);

        if (shipClass.key === 'galleon' || shipClass.key === 'dreadnought' || shipClass.key === 'flagship') {
            const railY = ship.y - (3 + bob) * scale;
            ctx.strokeStyle = 'rgba(244, 220, 151, 0.72)';
            ctx.lineWidth = Math.max(1, Math.round(1.4 * scale));
            ctx.beginPath();
            ctx.moveTo(ship.x - 28 * scale, railY + 11 * scale);
            ctx.lineTo(ship.x + 33 * scale, railY - 3 * scale);
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            const lanternCount = shipClass.key === 'flagship' ? 5 : 3;
            for (let i = 0; i < lanternCount; i++) {
                const t = lanternCount === 1 ? 0 : i / (lanternCount - 1);
                const lx = ship.x + (-23 + t * 48) * scale;
                const ly = railY + (8 - t * 11) * scale;
                ctx.fillRect(Math.round(lx), Math.round(ly), Math.max(2, Math.round(3 * scale)), Math.max(2, Math.round(3 * scale)));
            }
        }

        ctx.restore();
    }

    // 3.8 — the hull's height above its waterline in world px (the strip's
    // waterline anchor), falling back to the class table.
    _hullLift(ship, shipClass = harborShipClass(ship)) {
        const strip = hullStrip(this.sprites?.assets, shipClass.spriteId);
        return strip ? strip.anchorY : Math.max(0, Number(shipClass.labelLift || 0));
    }

    // 3.8 — plates sit above the hull and its masthead flag at every zoom:
    // screen px (relative to the waterline anchor, zoom cancelled) of the
    // flag's top (the hull's top edge while the strip loads), 4 px up.
    _plateBase(ship, shipClass, zoom) {
        const strip = hullStrip(this.sprites?.assets, shipClass.spriteId);
        const flagTop = strip?.mastheads ? strip.mastheads[2][1] + FLAG_MAST_OVERLAP - 16 : 0;
        const lift = this._hullLift(ship, shipClass) - Math.min(0, flagTop);
        return -Math.round((lift + this._shipBob(ship)) * (zoom || 1)) - 4;
    }

    _hasShipBadge(ship, shipClass) {
        if (ship.prShip) return false;
        return (this._isFleetLead(ship) && !(Number(ship.visualPackSize) > 1)) || Boolean(shipClass.badge);
    }

    _drawShipTierBadge(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), zoom = 1) {
        if (ship.prShip) return;
        // v0.23 A7 — the repo's lead docked ship shows a single fleet-count banner
        // in place of its class tier badge. Titan packs keep their exact `Nx`
        // badge instead (a 57-commit fleet reads 29x + 28x; the buoy label
        // carries the fleet total), so per-hull counts never disagree.
        if (this._isFleetLead(ship) && !(Number(ship.visualPackSize) > 1)) {
            this._drawFleetBanner(ctx, ship, alpha, profile, shipClass, zoom);
            return;
        }
        if (!shipClass.badge) return;
        const badge = shipClass.badge;
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        // C5 — screen-fixed plate: zoom cancelled, integer screen-pixel layout.
        ctx.translate(ship.x, ship.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_DISPLAY_FONT_8;
        const width = Math.max(18, measureLabelText(ctx, badge) + 8);
        const height = 14;
        const left = -Math.round(width / 2);
        const top = this._plateBase(ship, shipClass, zoom) - height;
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = 'rgba(24, 33, 36, 0.92)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = '#f4df9f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(badge, 0, top + 11);
        ctx.restore();
    }

    // v0.23 A7 — one fleet-count banner (N⚓, repo accent) above the lead ship,
    // reusing the tier-badge style so the whole flock reads as a single fleet.
    _drawFleetBanner(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), zoom = 1) {
        const count = harborFleetCount(ship);
        const badge = `${count}⚓`;
        ctx.save();
        ctx.globalAlpha = 0.96 * alpha;
        // C5 — screen-fixed plate: zoom cancelled, integer screen-pixel layout.
        ctx.translate(ship.x, ship.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_DISPLAY_FONT_8;
        const width = Math.max(20, measureLabelText(ctx, badge) + 10);
        const height = 14;
        const left = -Math.round(width / 2);
        const top = this._plateBase(ship, shipClass, zoom) - height;
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = 'rgba(20, 29, 32, 0.94)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = profile.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, badge, 0, top + 11);
        ctx.restore();
    }

    _drawHarborCrate(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const bob = this._shipBob(ship);
        const shipLift = Math.max(0, Number(shipClass.labelLift || 0)) * 0.35;
        const x = Math.round(ship.x - (18 + shipLift * 0.35) * s);
        const y = Math.round(ship.y - (19 + bob + shipLift) * s);
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        if (this.sprites) {
            this.sprites.drawSprite(ctx, 'prop.harborCrates', x, y + 11 * s, { alpha: 0.96 * alpha });
        } else {
            ctx.fillStyle = '#8a5530';
            ctx.strokeStyle = '#2d1c12';
            ctx.lineWidth = Math.max(1, Math.round(1.5 * s));
            ctx.fillRect(x - 9 * s, y - 7 * s, 18 * s, 14 * s);
            ctx.strokeRect(x - 9 * s + 0.5, y - 7 * s + 0.5, 18 * s - 1, 14 * s - 1);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(x - 7 * s), Math.round(y - 1 * s), Math.max(1, Math.round(14 * s)), Math.max(1, Math.round(2 * s)));
        ctx.restore();
    }

    _departureAlpha(ship) {
        const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
        const elapsed = Number.isFinite(Number(ship.elapsed))
            ? Number(ship.elapsed)
            : CAST_OFF_MS + Math.max(0, Number(ship.progress) || 0) * departMs;
        const arrivalAt = CAST_OFF_MS + departMs;
        const fadeStart = Math.max(CAST_OFF_MS, arrivalAt - EXIT_FADE_MS);
        if (elapsed <= fadeStart) return 1;
        const fadeDuration = Math.max(1, arrivalAt - fadeStart);
        return Math.max(0, Math.min(1, 1 - (elapsed - fadeStart) / fadeDuration));
    }

    _drawMooringTick(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), options = {}) {
        const s = 1 / Math.max(1, zoom || 1);
        const style = PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.success;
        const offsetX = Math.max(0, Number(shipClass.flagOffsetX || 0));
        const offsetY = Math.max(0, Number(shipClass.flagOffsetY || 0)) * 0.45;
        const shrink = Math.max(0, Math.min(1, Number(options.shrink ?? 1)));
        if (shrink <= 0.02 && !options.puff) return;
        ctx.save();
        ctx.fillStyle = ship.pushStatus ? style.accent : profile.accent;
        const fullHeight = Math.max(1, Math.round(5 * s));
        const height = Math.max(1, Math.round(fullHeight * shrink));
        const baseY = Math.round(ship.y - (23 + offsetY) * s) + (fullHeight - height);
        ctx.fillRect(Math.round(ship.x + (17 + offsetX) * s), baseY, Math.max(1, Math.round(2 * s)), height);
        // Small puff when cast-off begins shrinking the mooring tick.
        if (options.puff && this.motionScale > 0) {
            ctx.globalAlpha = 0.45 * (1 - (1 - shrink));
            ctx.fillStyle = 'rgba(225, 225, 225, 0.65)';
            const px = Math.round(ship.x + (17 + offsetX) * s);
            for (let i = 0; i < 4; i++) {
                const dx = ((i % 2 === 0) ? -1 : 1) * (1 + i) * s;
                const dy = -i * 1.5 * s;
                ctx.fillRect(px + dx, baseY + dy, Math.max(1, Math.round(1.5 * s)), Math.max(1, Math.round(1.5 * s)));
            }
        }
        ctx.restore();
    }

    // 3.1 / 6.5 — a yellow pennant hoisted above the flagship's flag for
    // --force-with-lease (the shared pixel strip, flying downwind).
    _drawForceLeaseBanner(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 14;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: '#ffd34a',
            rim: '#281c08',
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 1 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // W7.9 — the PR cutter's one mark: a parchment pennant hoisted above its
    // repo flag (the shared pixel strip, flying downwind; the rest frame in
    // calm air and under reduced motion), so a PR reads apart from a
    // pull/fetch cutter on the same hull.
    _drawPullRequestPennant(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y } = this._flagAnchor(ship, shipClass);
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y, {
            accent: PR_PENNANT_CLOTH,
            rim: PR_PENNANT_RIM,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 2 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // 3.1 — thin yellow underline beneath the flag for --force-if-includes.
    _drawForceIncludesUnderline(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        // One texel under the repo flag's cloth (cloth rows 2-10 of the strip).
        const { x, y } = this._flagAnchor(ship, shipClass);
        ctx.save();
        ctx.fillStyle = '#ffd34a';
        ctx.fillRect(x + 3, y + 11, 11, 1);
        ctx.restore();
    }

    // 3.1 — red spray particles puff at the keel during a force-push sink.
    _drawRedSprayParticles(ctx, ship, sinkProgress) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.4, 0.85 * sinkProgress);
        ctx.fillStyle = '#ff4a39';
        for (let i = 0; i < 5; i++) {
            const seed = stableHash(`${ship.id || ''}:spray:${i}`);
            const angle = ((seed % 628) / 100) + this.frame * 0.02 * (i % 2 === 0 ? 1 : -1);
            const distance = 4 + ((seed >> 2) % 12) * sinkProgress;
            const sx = ship.x + Math.cos(angle) * distance;
            const sy = ship.y + 2 + Math.sin(angle) * distance * 0.4;
            ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
        }
        ctx.restore();
    }

    // Sea-mist fade at the ship's last position: three stepped scanline
    // courses (outer haze to dense core) instead of a radial gradient.
    _drawMistFade(ctx, x, y, t) {
        const radius = 38 + t * 18;
        ctx.save();
        ctx.globalAlpha = 0.16 * t;
        fillPixelEllipse(ctx, x, y, radius, radius * 0.55, 'rgb(214, 222, 228)');
        ctx.globalAlpha = 0.2 * t;
        fillPixelEllipse(ctx, x, y, radius * 0.6, radius * 0.6 * 0.55, 'rgb(214, 222, 228)');
        ctx.globalAlpha = 0.26 * t;
        fillPixelEllipse(ctx, x, y, radius * 0.3, radius * 0.3 * 0.55, 'rgb(220, 224, 230)');
        ctx.restore();
    }

    // Secondary pennon hoisted on flagship/dreadnought at cast-off end (6.5:
    // the shared pixel strip, flying downwind).
    _drawSecondaryPennon(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 21;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: profile.accent,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 2 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // Caution pennant on a rejected ship (6.5: the shared pixel strip in the
    // rejected status colour). The caution beat is a V4 palette step, not a
    // fade: every 2 s the cloth swaps to its rim tone for one 0.5 s step on
    // the pennant clock; reduced motion holds the rest tones.
    _drawRejectedCautionFlag(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 7;
        const style = PUSH_STATUS_STYLE.rejected;
        const rim = style.panelBorder || '#ff755d';
        const step = Math.floor(currentPennantTime() / CAUTION_BEAT_STEP_MS) + (Number(ship.berthIndex) || 0);
        const lit = this.motionScale > 0 && ((step % 4) + 4) % 4 === 3;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: lit ? rim : style.accent,
            rim: lit ? style.accent : rim,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 3 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // Red collision flare burst at the boomerang turn point.
    _drawCollisionFlare(ctx, x, y, t) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.4, 0.95 * (1 - t));
        ellipseArcDots(ctx, x, y - 12, 8 + t * 12, 8 + t * 12, { step: 3, dot: 2, color: '#ff5a3c' });
        ctx.fillStyle = '#ff7a55';
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const r = 10 + t * 14;
            ctx.fillRect(Math.round(x + Math.cos(angle) * r), Math.round(y - 12 + Math.sin(angle) * r * 0.5), 2, 2);
        }
        ctx.restore();
    }

    // 3.6 / 6.5 — broken-rope chevron above the repo flag for untethered (no
    // remote): two whole-texel polylines on the art grid, riding the flag's
    // pole and bob and mirrored with the wind like the cloth.
    _drawUntetheredFlag(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 16;
        const dir = currentPennantWind() < 0 ? -1 : 1;
        ctx.save();
        ctx.fillStyle = '#d6dadf';
        for (const run of UNTETHERED_CHEVRON) {
            for (let i = 1; i < run.length; i++) {
                pixelLine(ctx, x + dir * run[i - 1][0], y + run[i - 1][1], x + dir * run[i][0], y + run[i][1]);
            }
        }
        ctx.restore();
    }

    // 3.6 / 6.5 — checkered black-and-white band across the flag's hoist for
    // detached HEAD: five 2×2-texel cells on the cloth side of the pole.
    _drawDetachedHeadBand(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x: pole, y: top } = this._flagAnchor(ship, shipClass);
        const y = top + 4;
        const mirror = currentPennantWind() < 0;
        ctx.save();
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = i % 2 === 0 ? '#1a1a1a' : '#f4f0e6';
            ctx.fillRect(mirror ? pole - 2 - i * 2 : pole + 2 + i * 2, y, 2, 2);
        }
        ctx.restore();
    }

    // 3.6 — small superscript on the flag indicating amend count (²).
    _drawAmendSuperscript(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const count = Math.max(1, Number(ship.amendCount || 0));
        if (count <= 0) return;
        const labels = ['', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
        const text = count > 1 ? (labels[count] || `^${count}`) : '¹';
        // C5 — screen-fixed glyphs at the repo flag's fly end (world anchor).
        const { x, y } = this._flagAnchor(ship, shipClass);
        ctx.save();
        ctx.translate(x + 21, y + 2);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.fillStyle = '#f6cf60';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, text, 0, 7);
        ctx.restore();
    }

    // 3.2 — small crates ride along inbound ships proportional to incoming commit count.
    _drawInboundCrates(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const count = Math.min(4, Math.max(1, Number(ship.inboundCargoCount || 0)));
        const baseY = Math.round(ship.y - Math.max(8, this._hullLift(ship, shipClass) * 0.4) - this._shipBob(ship));
        ctx.save();
        ctx.fillStyle = '#8a5530';
        ctx.strokeStyle = '#2d1c12';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        for (let i = 0; i < count; i++) {
            const cx = Math.round(ship.x - 8 * s + i * 5 * s);
            const cy = baseY - i * 2 * s;
            ctx.fillRect(cx, cy, Math.round(4 * s), Math.round(4 * s));
            ctx.strokeRect(cx + 0.5, cy + 0.5, Math.round(4 * s) - 1, Math.round(4 * s) - 1);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(ship.x - 8 * s), Math.round(baseY + 5 * s), Math.max(2, Math.round(count * 5 * s)), 1);
        ctx.restore();
    }

    // 3.7 — single channel buoy pulsing in the active storage-transfer repo accent.
    _drawLagoonChannelBuoy(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const profile = payload.profile;
        const muted = !profile;
        const accent = muted ? '#8c95a0' : profile.accent;
        // 3.9 — lantern pulse snapped onto the shared 'harbor' band; muted or
        // reduced-motion buoys hold the legacy static alpha.
        const pulse = (!muted && this.motionScale > 0)
            ? pulseAlpha('harbor', this.frame, this.motionScale, 0.55, 0.95)
            : 0.65;
        const x = Math.round(payload.x);
        const y = Math.round(payload.y);
        ctx.save();
        // Base — pylon shape rooted into the water.
        ctx.fillStyle = 'rgba(38, 50, 58, 0.95)';
        ctx.strokeStyle = 'rgba(15, 22, 28, 0.92)';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        ctx.fillRect(x - 4 * s, y - 2 * s, 8 * s, 6 * s);
        ctx.strokeRect(x - 4 * s + 0.5, y - 2 * s + 0.5, 8 * s - 1, 6 * s - 1);
        // Lantern — pulses in the active repo accent (or muted when idle).
        ctx.globalAlpha = pulse;
        ctx.fillStyle = accent;
        ctx.fillRect(x - 3 * s, y - 10 * s, 6 * s, 7 * s);
        ctx.globalAlpha = Math.min(1, pulse * 1.2);
        ctx.fillStyle = muted ? 'rgba(140, 149, 160, 0.6)' : 'rgba(255, 246, 200, 0.9)';
        ctx.fillRect(x - 2 * s, y - 9 * s, 4 * s, 5 * s);
        // Glow halo when active: two stepped pixel discs, additive.
        if (!muted) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.13 * pulse;
            fillPixelEllipse(ctx, x, y - 7 * s, 22 * s, 22 * s, accent);
            ctx.globalAlpha = 0.19 * pulse;
            fillPixelEllipse(ctx, x, y - 7 * s, 11 * s, 11 * s, accent);
            ctx.globalCompositeOperation = 'source-over';
        }
        // v0.23 A5 — cast-off flare: an additive stepped disc in the departing
        // push's accent, even when the buoy is otherwise idle. Reduced motion
        // leaves castOff at 0 so nothing is drawn.
        const castOff = Math.max(0, Number(payload.castOff) || 0);
        if (castOff > 0) {
            const ringAccent = payload.castOffAccent || accent;
            const r = (16 + 18 * castOff) * s;
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.2 * castOff;
            fillPixelEllipse(ctx, x, y - 7 * s, r, r, ringAccent);
            ctx.globalAlpha = 0.3 * castOff;
            fillPixelEllipse(ctx, x, y - 7 * s, r * 0.5, r * 0.5, ringAccent);
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
    }

    // 6.5 / 3.8 — the flag hoist: the repo flag's pole stands on the hull's
    // masthead (the manifest `masthead` of the strip, turned with the roll
    // frame it draws, riding its bob), its foot FLAG_MAST_OVERLAP texels down
    // the mast so staff and mast read as one spar. Returns the pennant box
    // top-left x at the pole and its top row (the pole foot is y + 16); every
    // other mark on the flag hangs off this. A hull still loading its strip
    // falls back to the class offsets.
    _flagAnchor(ship, shipClass = harborShipClass(ship)) {
        const bob = this._shipBob(ship);
        const strip = hullStrip(this.sprites?.assets, shipClass.spriteId);
        if (!strip?.mastheads) {
            return {
                x: Math.round(ship.x + 13 + (shipClass.flagOffsetX || 0)),
                y: Math.round(ship.y - 31 - (shipClass.flagOffsetY || 0) - bob),
            };
        }
        const frame = this._shipSink(ship).progress > 0 ? 4 : rollFrameIndex(this._shipRoll(ship));
        const [mx, my] = strip.mastheads[frame];
        return {
            x: Math.round(ship.x) - strip.anchorX + mx,
            y: Math.round(ship.y) - strip.anchorY - bob + my + FLAG_MAST_OVERLAP - 16,
        };
    }

    // 6.5 — the repo flag: the shared pixel pennant strip on a staff at the
    // masthead in the repo accent (a branch variant rims it in its base
    // repo's accent), stepped at 4 fps downwind, on the rest frame in calm
    // air and under reduced motion.
    _drawRepoFlag(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y } = this._flagAnchor(ship, shipClass);
        const windX = currentPennantWind();
        const phase = stableHash(ship.id || '') % 4;
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        drawPennant(ctx, x, y + 16, {
            accent: profile.accent,
            rim: profile.isBranchVariant && profile.baseAccent ? profile.baseAccent : null,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase }),
            windX,
        });
        ctx.restore();
    }

    // 4.17 / 6.5: procedural repo heraldry shield on the squad flagship,
    // tinted by the repo at render time. The shield is flag drawing on the art
    // grid: whole-texel row runs in world units (24 texels tall, wide enough
    // at z1 for its label), so it scales with the hull in exact k×k texels;
    // no path, no anti-aliased edge. Only the short repo label stays a
    // screen-fixed C5 glyph run, centred on the shield's upper third.
    _drawRepoShield(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const h = 24;
        const shortName = String(profile.shortName || profile.name || '').slice(0, 3).toUpperCase();
        ctx.save();
        ctx.font = WORLD_DISPLAY_FONT_8;
        // The crest widens just enough to carry its label at z1 without
        // squeezing glyphs (C5 measures instead of fillText maxWidth).
        const w = shortName ? Math.max(18, Math.ceil(measureLabelText(ctx, shortName)) + 6) : 18;
        const cx = Math.round(ship.x);
        const top = Math.round(ship.y) - Math.round(44 + (shipClass.flagOffsetY || 0) * 0.6);
        const runs = shieldRuns(w, h);
        ctx.globalAlpha = Math.max(0, alpha) * 0.94;
        // Drop shadow behind the shield for legibility against busy water.
        ctx.fillStyle = 'rgba(8, 12, 16, 0.55)';
        for (const [y, x0, x1] of runs) ctx.fillRect(cx + x0 + 1, top + y + 2, x1 - x0, 1);
        // Outer rim — gold on base repos, branch accent on variants: the
        // silhouette grown by one texel.
        ctx.fillStyle = profile.isBranchVariant && profile.baseAccent
            ? profile.baseAccent
            : 'rgba(255, 240, 184, 0.88)';
        ctx.fillRect(cx + runs[0][1] - 1, top - 1, runs[0][2] - runs[0][1] + 2, 1);
        for (const [y, x0, x1] of runs) ctx.fillRect(cx + x0 - 1, top + y, x1 - x0 + 2, 1);
        ctx.fillRect(cx - 1, top + h, 2, 1);
        // Shield body filled with the repo accent.
        ctx.fillStyle = profile.accent || '#f6d384';
        for (const [y, x0, x1] of runs) ctx.fillRect(cx + x0, top + y, x1 - x0, 1);
        // Branch variant: a 3-texel sash across the middle (just above the
        // point, so the chevron still reads as a shield).
        if (profile.isBranchVariant && profile.baseAccent) {
            const bandTop = Math.round(h * 0.5);
            ctx.fillStyle = profile.baseAccent;
            for (const [y, x0, x1] of runs) {
                if (y >= bandTop && y < bandTop + 3) ctx.fillRect(cx + x0 + 2, top + y, Math.max(0, x1 - x0 - 4), 1);
            }
        }
        ctx.restore();
        // Short repo label in the upper third of the shield (C5 screen-fixed).
        if (shortName) {
            ctx.save();
            ctx.globalAlpha = Math.max(0, alpha) * 0.94;
            ctx.translate(cx, top + Math.round(h * 0.34));
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            snapScreenOrigin(ctx);
            ctx.font = WORLD_DISPLAY_FONT_8;
            ctx.fillStyle = profile.labelText || 'rgba(20, 14, 10, 0.94)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            this._applyReadableTextShadow(ctx);
            ctx.fillText(shortName, 0, 4);
            ctx.restore();
        }
    }

    // 4.17 / 6.5: static bunting line between two adjacent docked ships in
    // the same squad, on the art grid: a sagging line of whole texels (each
    // step joined by pixelLine, no stroke) with a hanging pixel pennant at
    // its lowest point. No animation — reduced motion shows the same line.
    _drawSquadBunting(ctx, ship, neighbor, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch)) {
        if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) return;
        const lift = 28; // anchor lift above each ship's deck, texels
        const ax = Math.round(ship.x);
        const ay = Math.round(ship.y - lift);
        const bx = Math.round(neighbor.x);
        const by = Math.round(neighbor.y - lift);
        const sag = Math.round(Math.min(14, Math.hypot(bx - ax, by - ay) * 0.18));
        const steps = Math.max(1, Math.abs(bx - ax), Math.abs(by - ay));
        const at = (t) => [Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t + 4 * sag * t * (1 - t))];
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.82;
        ctx.fillStyle = profile.accent || '#f6d384';
        let [px0, py0] = at(0);
        for (let i = 1; i <= steps; i++) {
            const [px1, py1] = at(i / steps);
            if (px1 !== px0 || py1 !== py0) pixelLine(ctx, px0, py0, px1, py1);
            px0 = px1;
            py0 = py1;
        }
        // Small pennant at the lowest point for a flag-line feel: a hanging
        // triangle, rows filled on whole texels.
        const [px, py] = at(0.5);
        ctx.fillStyle = profile.isBranchVariant && profile.baseAccent
            ? profile.baseAccent
            : (profile.accent || '#f6d384');
        fillConvex(ctx, [[px - 3, py + 1], [px + 3, py + 1], [px, py + 6]]);
        ctx.restore();
    }

    _drawReleaseConvoyLine(ctx, ship, neighbor, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch)) {
        if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) return;
        const s = 1 / Math.max(1, zoom || 1);
        const ax = ship.x;
        const ay = ship.y - 18 * s;
        const bx = neighbor.x;
        const by = neighbor.y - 18 * s;
        const distance = Math.hypot(bx - ax, by - ay);
        if (distance < 8) return;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.50;
        ctx.strokeStyle = profile.accent || '#f6d384';
        ctx.lineWidth = Math.max(1, Math.round(1.2 * s));
        ctx.setLineDash([Math.max(4, 6 * s), Math.max(3, 5 * s)]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
    }

    _drawReleaseConvoyCue(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const lift = Math.max(0, Number(shipClass.labelLift || 0));
        const x = Math.round(ship.x - 15 * s);
        const y = Math.round(ship.y - (49 + lift * 0.55) * s);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.88;
        ctx.fillStyle = profile.accent || '#f6d384';
        for (let i = 0; i < 2; i++) {
            const dx = i * 9 * s;
            ctx.beginPath();
            ctx.moveTo(x + dx, y);
            ctx.lineTo(x + dx + 7 * s, y + 4 * s);
            ctx.lineTo(x + dx, y + 8 * s);
            ctx.closePath();
            ctx.fill();
        }
        if (ship.convoyLeader) {
            const count = Math.max(RELEASE_CONVOY_MIN_SHIPS, Number(ship.convoy?.visibleCount || ship.convoy?.count || 0));
            const label = `CVY ${count}`;
            // C5 — screen-fixed plate at the ship anchor, whole screen px.
            ctx.save();
            ctx.translate(ship.x, ship.y);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            snapScreenOrigin(ctx);
            ctx.font = WORLD_DISPLAY_FONT_8;
            const width = Math.max(36, measureLabelText(ctx, label) + 12);
            const height = 14;
            const left = -Math.round(width / 2);
            const top = -Math.round(49 + lift * 0.55) - 17;
            ctx.fillStyle = profile.accent || '#f6d384';
            ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
            ctx.fillStyle = 'rgba(24, 42, 39, 0.88)';
            ctx.fillRect(left, top, width, height);
            ctx.fillStyle = profile.labelText || '#fff0b8';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            this._fillReadableText(ctx, label, 0, top + 11);
            ctx.restore();
        }
        ctx.restore();
    }

    _drawCommitPennant(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const statusStyle = PUSH_STATUS_STYLE[ship.pushStatus] || null;
        const accent = ship.pushStatus === 'failed' && statusStyle ? statusStyle.accent : profile.accent;
        const compact = Boolean(ship.compactCommitLabel);
        const localIndex = Number.isFinite(Number(ship.squadShipIndex))
            ? Math.max(0, Number(ship.squadShipIndex))
            : Math.max(0, Number(ship.repoDockIndex || 0));
        const visibleCount = Math.max(1, Number(ship.repoDockVisibleCount || 1));
        const lane = visibleCount > 1 ? Math.max(-0.72, Math.min(0.72, localIndex - (visibleCount - 1) / 2)) : 0;
        const bob = this._shipBob(ship);
        // The mini pennant is the second flag of the masthead hoist: on the
        // mast just under the repo flag's cloth, riding the same bob and roll.
        const hoist = this._flagAnchor(ship, shipClass);
        const miniX = hoist.x;
        const miniY = hoist.y + 12;

        const label = shortGitLabel(commitPennantLabel(ship), compact ? 10 : 12, '…');
        const maxText = compact ? 58 : 70;
        const labelTier = compact ? localIndex % 4 : localIndex % 3;
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        // C5 — screen-fixed plate: zoom cancelled, whole screen px, width
        // measured (fitLabelText keeps today's 58/70 px cap).
        ctx.translate(ship.x, ship.y - bob);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const shown = fitLabelText(ctx, label, maxText);
        const width = Math.max(42, measureLabelText(ctx, shown) + 22);
        const height = 16;
        const left = Math.round(lane * 34) - Math.round(width / 2);
        // 3.8 — above the hull (and its tier badge), staggered per squad slot,
        // never on the water where the reflection lies.
        const badgeRoom = this._hasShipBadge(ship, shipClass) ? 18 : 0;
        const top = this._plateBase(ship, shipClass, zoom) + Math.round(bob * (zoom || 1)) - badgeRoom - height - labelTier * 10;
        ctx.fillStyle = accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.9)';
        ctx.fillRect(left, top, width, height);
        if (profile.isBranchVariant && profile.baseAccent) {
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(left, top, 2, height);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left + (profile.isBranchVariant ? 2 : 0), top, 4, height);
        this._drawRepoLabelIcon(ctx, left + 8, top + height / 2, 6, profile);
        ctx.fillStyle = ship.pushStatus === 'failed' && statusStyle ? accent : (profile.labelText || accent);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, shown, left + 15, top + 12);
        ctx.restore();
        // v0.23 A4 / 6.5 — mini pennant on the plate pole (world art): the
        // small pixel pennant, stepped with the one wind like the repo flag.
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        const windX = currentPennantWind();
        drawMiniPennant(ctx, miniX, miniY + 11, {
            accent,
            frame: pennantFrame(currentPennantTime(), windX, {
                motion: this.motionScale > 0,
                phase: stableHash(ship.id || '') % 4,
            }),
            windX,
        });
        ctx.restore();
    }

    // 3.6 — hover lore: cargo label above the hovered ship carrying the commit subject.
    _drawHoverCargoLabel(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const subject = ship.prShip ? pullRequestShipLabel(ship) : cachedCleanCommitSubject(ship.label || '');
        const label = shortGitLabel(subject || `commit ${commitPennantLabel(ship)}`, 36, '…');
        if (!label) return;
        const base = this._plateBase(ship, shipClass, zoom) - (this._hasShipBadge(ship, shipClass) ? 18 : 0);
        ctx.save();
        ctx.globalAlpha = Math.min(1, 0.96 * alpha);
        // C5 — screen-fixed plate: zoom cancelled, whole screen px, width
        // measured (this label has no cap today, so none is added).
        ctx.translate(ship.x, ship.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const width = Math.max(54, measureLabelText(ctx, label) + 26);
        const height = 16;
        const left = -Math.round(width / 2);
        const top = base - 20 - height;
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.92)';
        ctx.fillRect(left, top, width, height);
        this._drawRepoLabelIcon(ctx, left + 9, top + height / 2, 6, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, label, left + 17, top + 12);
        // Short stem tying the cargo label to its ship.
        ctx.fillStyle = profile.accent;
        ctx.fillRect(-1, top + height, 2, 6);
        ctx.restore();
    }

    _drawFinaleEffect(ctx, effect) {
        const style = PUSH_STATUS_STYLE[effect.status] || PUSH_STATUS_STYLE.unknown;
        const progress = Math.max(0, Math.min(1, effect.progress || 0));
        const alpha = this.motionScale === 0 ? 0.78 : Math.max(0, 1 - progress);
        const wave = this.motionScale === 0 ? 0.55 : Math.sin(progress * Math.PI);
        const summary = toWorld(HARBOR_SUMMARY_TILE.tileX, HARBOR_SUMMARY_TILE.tileY);
        const count = Math.max(1, Number(effect.shipCount || 1));
        const intensity = Math.max(1, Math.min(4, Math.sqrt(count)));
        const burstCount = Math.min(28, 8 + count * 2);
        // 3.1 — force-push success uses a sinking whirlpool, not expanding rings.
        const forceSink = effect.status === 'success' && effect.force === true;

        ctx.save();
        ctx.globalCompositeOperation = (effect.status === 'cancelled' || forceSink) ? 'source-over' : 'screen';
        ctx.globalAlpha = Math.max(0.18, alpha);
        ctx.fillStyle = style.glow;

        if (effect.status === 'cancelled') {
            // 5.11 — soft grey expanding ring, low alpha. Reduced-motion: a single
            //        static ring at mid radius.
            const staticMotion = this.motionScale === 0;
            const radius = staticMotion ? 22 : (16 + progress * 18);
            ctx.globalAlpha = Math.max(0.12, alpha * 0.55);
            ellipseArcDots(ctx, effect.x, effect.y - 24, radius, radius, { step: 3, dot: 2, color: style.accent });
        } else if (forceSink) {
            // 3.1 — whirlpool: inward-spiraling dotted arcs (each ring's sweep
            // start turns with its progress) with red spray.
            const spirals = this.motionScale === 0 ? 1 : 3;
            for (let i = 0; i < spirals; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress - i * 0.18));
                const ring = Math.max(6, 48 - ringProgress * 36 + i * 6);
                const start = ringProgress * Math.PI * 1.2 + i * 0.9;
                ctx.globalAlpha = Math.max(0.10, alpha * (1 - i * 0.22));
                ellipseArcDots(ctx, effect.x, effect.y, ring, ring * 0.36, {
                    start, end: start + Math.PI * 1.6, step: 3, dot: 2, color: '#3a4f6a',
                });
            }
            // Red spray particles erupting from the whirlpool eye.
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = Math.max(0.22, alpha * 0.92);
            ctx.fillStyle = '#ff4a39';
            const sprayCount = Math.min(14, 5 + Math.round(count));
            for (let i = 0; i < sprayCount; i++) {
                const seed = stableHash(`${effect.id}:whirl:${i}`);
                const angle = (seed % 628) / 100;
                const distance = 6 + ((seed >> 3) % 28) * progress;
                const x = effect.x + Math.cos(angle) * distance;
                const y = effect.y + Math.sin(angle) * distance * 0.42;
                ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
            }
        } else {
            for (let i = 0; i < Math.ceil(intensity) + 1; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress * 1.18 - i * 0.14));
                const ring = 24 + ringProgress * (54 + intensity * 14);
                ctx.globalAlpha = Math.max(0.08, alpha * (1 - i * 0.16));
                ellipseArcDots(ctx, effect.x, effect.y, ring, ring * 0.34, { step: 4, dot: 2, color: style.accent });
            }
            ctx.globalAlpha = Math.max(0.10, alpha * 0.55);
            ctx.fillStyle = style.glow;
            fillConvex(ctx, [
                [summary.x - 8, summary.y - 72],
                [effect.x + 72, effect.y - 18],
                [effect.x - 18, effect.y + 12],
            ]);

            ctx.globalAlpha = Math.max(0.22, alpha * 0.88);
            for (let i = 0; i < burstCount; i++) {
                const seed = stableHash(`${effect.id}:${i}`);
                const angle = (seed % 628) / 100;
                const distance = 20 + ((seed >> 3) % 52) * (0.45 + progress * 0.7) * intensity / 2;
                const size = 1 + (seed % 3);
                const x = effect.x + Math.cos(angle) * distance;
                const y = effect.y + Math.sin(angle) * distance * 0.38;
                ctx.fillRect(Math.round(x), Math.round(y), size, size);
            }
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.max(0.48, alpha);
        // C5 — screen-fixed caption: cancel the camera zoom read off the
        // active transform (drawFinaleEffects receives no zoom argument).
        ctx.save();
        const frame = ctx.getTransform();
        const dpr = ctx.canvas?._claudeVilleDpr || 1;
        const zoom = Math.abs(frame.a) > 0.01 ? Math.abs(frame.a) / dpr : 1;
        ctx.translate(effect.x, effect.y);
        ctx.scale(1 / zoom, 1 / zoom);
        snapScreenOrigin(ctx);
        ctx.fillStyle = style.accent;
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(style.shortLabel, 0, -48);
        ctx.restore();
        ctx.restore();
    }

    _drawClusterTag(ctx, payload, zoom) {
        const label = `+${payload.count}`;
        // C5 — screen-fixed tab: zoom cancelled, whole screen px.
        ctx.save();
        ctx.translate(payload.x, payload.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_DISPLAY_FONT_8;
        const width = Math.max(18, measureLabelText(ctx, label) + 8);
        const height = 14;
        const left = -Math.round(width / 2);
        const top = -34;
        ctx.fillStyle = 'rgba(242, 211, 107, 0.82)';
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = 'rgba(27, 43, 48, 0.86)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = '#f2d36b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, 0, top + 11);
        ctx.restore();
    }

    _drawCommitLagoonSign(ctx, payload, zoom) {
        const profile = payload.profile || trafficProfile(payload.project, payload.branch);
        const count = Math.max(1, Number(payload.count || 1));
        const detail = `${shortGitLabel(payload.repoName || trafficLabel(payload.project, payload.branch), 20, '…')} (${count})`;
        const title = 'COMMIT LAGOON';
        // C5 — screen-fixed sign: zoom cancelled, whole screen px, rows sized
        // from measured text with today's 132–204 px width band.
        ctx.save();
        ctx.globalAlpha = 0.96;
        ctx.translate(payload.x, payload.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_DISPLAY_FONT_8;
        const titleWidth = measureLabelText(ctx, title);
        ctx.font = WORLD_BODY_FONT_11;
        const detailWidth = measureLabelText(ctx, detail);
        const width = Math.max(132, Math.min(204, Math.max(titleWidth, detailWidth) + 34));
        const shownDetail = fitLabelText(ctx, detail, width - 28);
        const height = 36;
        const left = -Math.round(width / 2);
        const top = -Math.round(height / 2);
        ctx.fillStyle = 'rgba(247, 214, 123, 0.86)';
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = 'rgba(50, 42, 25, 0.92)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left + 5, top + 5, 4, height - 10);
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = '#f4df9f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, title, 2, top + 14);
        this._drawRepoLabelIcon(ctx, left + 15, top + 25, 7, profile);
        ctx.font = WORLD_BODY_FONT_11;
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.textAlign = 'left';
        this._fillReadableText(ctx, shownDetail, left + 23, top + 29);
        ctx.restore();
    }

    _drawRepoQuayMarker(ctx, payload, zoom) {
        const profile = payload.profile || trafficProfile(payload.project, payload.branch);
        const count = Math.max(1, Number(payload.count || 1));
        const name = shortGitLabel(trafficLabel(payload.project, payload.branch), count >= 100 ? 18 : 20, '…');
        const label = `${name} (${count})`;
        const failed = Number(payload.failedCount || 0) > 0;
        // C5 — screen-fixed marker: zoom cancelled, whole screen px, width
        // measured with today's 104–190 px band.
        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.translate(payload.x, payload.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const width = Math.max(104, Math.min(190, measureLabelText(ctx, label) + 30));
        const shown = fitLabelText(ctx, label, width - 24);
        const height = 16;
        const left = -Math.round(width / 2);
        const top = -Math.round(height / 2);
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.panelBorder || profile.accent);
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = profile.panel || 'rgba(20, 30, 34, 0.88)';
        ctx.fillRect(left, top, width, height);
        if (profile.isBranchVariant && profile.baseAccent) {
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(left, top, 3, height);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left + (profile.isBranchVariant ? 3 : 0), top, 5, height);

        ctx.globalAlpha = 1;
        this._drawRepoLabelIcon(ctx, left + 11, top + height / 2, 7, profile);
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.labelText || profile.accent);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, shown, left + 20, top + 12);
        ctx.restore();
    }

    // #18 — small flickering flame atop an active repo buoy; colours come
    // from ParticleSystem's shared `buoyTorch` palette. 5.8 — reduced motion
    // draws a single static frame instead of suppressing the flame entirely.
    _drawBuoyTorch(ctx, x, topY, slot = 0) {
        // A 2-texel pixel flame on the shared buoyTorch palette whose height
        // steps between three frames; neighbours are phase-offset by slot so
        // the anchorage never flickers in lockstep. Reduced motion holds one.
        const moving = this.motionScale > 0;
        const phase = (moving ? this.frame * 0.32 : 0) + slot * 1.7;
        const height = 5 + Math.round(Math.sin(phase));
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        drawPixelFlame(ctx, x, topY, height, 2, {
            outer: BUOY_TORCH_COLORS[0],
            inner: BUOY_TORCH_COLORS[1] || BUOY_TORCH_COLORS[0],
            tip: BUOY_TORCH_COLORS[2] || BUOY_TORCH_COLORS[BUOY_TORCH_COLORS.length - 1],
        });
        ctx.restore();
    }

    _drawRepoAnchorage(ctx, payload, zoom) {
        const x = payload.x;
        const y = payload.y;

        // Overflow chip — repos that did not get their own anchorage slot.
        if (payload.overflowMore) {
            const text = payload.repoName || `+${payload.overflowMore}`;
            // C5 — screen-fixed chip: zoom cancelled, whole screen px.
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            snapScreenOrigin(ctx);
            ctx.font = WORLD_BODY_FONT_11;
            const w = Math.max(30, measureLabelText(ctx, text) + 12);
            const h = 14;
            const left = -Math.round(w / 2);
            const top = -Math.round(h / 2);
            ctx.globalAlpha = 0.78;
            ctx.fillStyle = 'rgba(159, 185, 181, 0.7)';
            ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
            ctx.fillStyle = 'rgba(20, 30, 34, 0.82)';
            ctx.fillRect(left, top, w, h);
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#cdd9d6';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            this._fillReadableText(ctx, fitLabelText(ctx, text, w - 6), 0, top + 11);
            ctx.restore();
            return;
        }

        const profile = payload.profile || repoProfile(payload.project);
        const lively = payload.lively !== false;
        const failed = Number(payload.failed || 0) > 0;
        const moving = this.motionScale > 0;

        // #18 — phase-offset vertical bob so neighbouring buoys never bob in
        // lockstep. Slot index seeds the phase; failed repos sit low ("droop")
        // and bob with a smaller amplitude. Whole texels; reduced motion = none.
        const slot = Number(payload.slot) || 0;
        const bobBand = pulseValue('harbor', this.frame + slot * 11, this.motionScale) - 0.62;
        const bobAmp = failed ? 0.7 : 1.6;
        const bob = moving ? Math.round(bobBand * bobAmp) : 0;
        const droop = failed ? 3 : 0;
        const bx = snap(x);
        const buoyY = snap(y) + bob + droop;

        ctx.save();
        // Tinted water patch — the repo's "sea area", one flat stepped course.
        // Failed repos lose their colour: a muted grey wash reads as a sunken,
        // troubled anchorage.
        const rx = lively ? 17 : 13;
        const waterGlow = failed
            ? 'rgba(96, 104, 110, 0.30)'
            : gradeColorString(profile.glow || 'rgba(122, 200, 216, 0.32)', this._grade);
        ctx.globalAlpha = failed ? 0.5 : (lively ? 0.85 : 0.45);
        fillPixelEllipse(ctx, bx, snap(y), rx, Math.round(rx / 2), waterGlow);
        ctx.globalAlpha = 1;

        // Mooring buoy post + pennant in the repo accent (rides the bob).
        const topY = buoyY - 13;
        ctx.fillStyle = 'rgba(24, 16, 10, 0.85)';
        ctx.fillRect(bx, topY, 1, 13);
        // Failed pennant droops — a slack triangle hanging off the post tip.
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : profile.accent;
        fillConvex(ctx, failed
            ? [[bx + 1, topY], [bx + 7, topY + 6], [bx + 1, topY + 7]]
            : [[bx + 1, topY], [bx + 10, topY + 3], [bx + 1, topY + 6]]);

        // #18 — active-repo signal flame: a small flickering torch atop the post
        // whenever the repo is lively (live agent or fresh push). Drawn inline
        // (HarborTraffic owns no particle pool) using the shared buoyTorch
        // palette. Reduced motion draws a single static flame frame instead of
        // suppressing it (5.8).
        if (lively && !failed) {
            this._drawBuoyTorch(ctx, bx, topY, slot);
        }

        // Crest float at the waterline (rides the bob): a rimmed pixel diamond.
        diamond(ctx, bx, buoyY - 2, lively ? 4 : 3, {
            color: 'rgba(255, 240, 184, 0.9)',
            fill: profile.accent || '#f6d384',
        });

        // Name + docked count label.
        const name = payload.repoName || profile.shortName || 'repo';
        const label = payload.docked > 0 ? `${name} (${payload.docked})` : name;
        // C5 screen-fixed plate: zoom cancelled, whole screen px.
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const w = Math.max(40, measureLabelText(ctx, label) + 12);
        const h = 14;
        const left = -Math.round(w / 2);
        const top = 9;
        ctx.globalAlpha = lively ? 0.95 : 0.7;
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.panelBorder || profile.accent);
        ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
        ctx.fillStyle = profile.panel || 'rgba(20, 30, 34, 0.85)';
        ctx.fillRect(left, top, w, h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lively ? (profile.labelText || profile.accent) : 'rgba(180, 196, 192, 0.78)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, fitLabelText(ctx, label, w - 8), 0, top + 11);
        ctx.restore();
        ctx.restore();
    }

    _drawFallbackBoat(ctx, x, y, alpha, shipClass = HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1], profile = { accent: '#9fb9b5' }) {
        const scale = 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#6a3f2a';
        ctx.beginPath();
        ctx.moveTo(x - 20 * scale, y + 5 * scale);
        ctx.lineTo(x + 17 * scale, y - 4 * scale);
        ctx.lineTo(x + 10 * scale, y + 10 * scale);
        ctx.lineTo(x - 13 * scale, y + 14 * scale);
        ctx.closePath();
        ctx.fill();
        if ((shipClass.cargoRows || 0) > 0) {
            ctx.fillStyle = '#8a5530';
            ctx.strokeStyle = '#2d1c12';
            for (let i = 0; i < Math.min(3, shipClass.cargoRows); i++) {
                const cx = x - (8 - i * 7) * scale;
                const cy = y - (9 + i * 2) * scale;
                ctx.fillRect(Math.round(cx), Math.round(cy), Math.round(7 * scale), Math.round(6 * scale));
                ctx.strokeRect(Math.round(cx) + 0.5, Math.round(cy) + 0.5, Math.round(7 * scale) - 1, Math.round(6 * scale) - 1);
            }
        }
        ctx.fillStyle = '#d9c99a';
        ctx.fillRect(Math.round(x - 3 * scale), Math.round(y - 23 * scale), Math.max(2, Math.round(3 * scale)), Math.round(22 * scale));
        ctx.fillStyle = '#9fb9b5';
        ctx.beginPath();
        ctx.moveTo(x, y - 22 * scale);
        ctx.lineTo(x + 13 * scale, y - 9 * scale);
        ctx.lineTo(x + 1 * scale, y - 7 * scale);
        ctx.closePath();
        ctx.fill();
        if (shipClass.badge) {
            ctx.fillStyle = profile.accent || '#f4df9f';
            ctx.fillRect(Math.round(x - 14 * scale), Math.round(y - 2 * scale), Math.round(24 * scale), Math.max(2, Math.round(2 * scale)));
        }
        ctx.restore();
    }
}
