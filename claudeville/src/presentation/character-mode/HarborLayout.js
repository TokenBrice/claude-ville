// Harbor water geometry and dock layout: anchorages, berths, route bands,
// titan packing and squad formations. Pure: no canvas, no sprites, no colour
// registry, so the state model and node tests can lay out a harbor without
// the art graph. HarborState.js owns the semantic state; HarborTraffic.js
// draws what this module places.
import { MAP_SIZE } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { WORLD_TREE } from '../../config/scenery.js';
import { projectNameFromPath } from '../shared/GitEventIdentity.js';
import { tileToWorld, worldToTile } from './Projection.js';

// Hull tiers as layout data. Each tier's footprint (in wake-scale units)
// fixes its formation spacing and collision radius, so re-authoring hull
// art (HarborTraffic's HARBOR_SHIP_CLASSES) cannot reshuffle formations.
// `screenWidth` is the hull strip's frame width (world px), which keeps a
// moored hull's body off the Harbor's piers on screen; update it with the
// art.
// Commit tiers are chosen by fleet or pack size, stack tiers by the exact
// count of a titan pack.
export const HARBOR_SHIP_TIERS = Object.freeze([
    Object.freeze({ key: 'flagship', minCommits: 10, footprint: 2.38, screenWidth: 97 }),
    Object.freeze({ key: 'dreadnought', minCommits: 8, footprint: 2.12, screenWidth: 82 }),
    Object.freeze({ key: 'galleon', minCommits: 6, footprint: 1.86, screenWidth: 76 }),
    Object.freeze({ key: 'brigantine', minCommits: 4, footprint: 1.56, screenWidth: 66 }),
    Object.freeze({ key: 'sloop', minCommits: 3, footprint: 1.32, screenWidth: 46 }),
    Object.freeze({ key: 'cutter', minCommits: 2, footprint: 1.15, screenWidth: 42 }),
    Object.freeze({ key: 'skiff', minCommits: 1, footprint: 0.88, screenWidth: 29 }),
]);
export const HARBOR_STACK_TIERS = Object.freeze([
    Object.freeze({ key: 'stack50', minCommits: 50, footprint: 2.80, screenWidth: 197 }),
    Object.freeze({ key: 'stack40', minCommits: 40, footprint: 2.60, screenWidth: 157 }),
    Object.freeze({ key: 'stack30', minCommits: 30, footprint: 2.38, screenWidth: 151 }),
    Object.freeze({ key: 'stack20', minCommits: 20, footprint: 2.12, screenWidth: 122 }),
    Object.freeze({ key: 'stack10', minCommits: 10, footprint: 1.72, screenWidth: 108 }),
    Object.freeze({ key: 'stack5', minCommits: 1, footprint: 1.30, screenWidth: 75 }),
]);
// The release sloop and inbound cutters always wear one fixed tier.
const RELEASE_SAIL_TIER = HARBOR_SHIP_TIERS.find(tier => tier.key === 'sloop');
const INBOUND_TIER = HARBOR_SHIP_TIERS.find(tier => tier.key === 'cutter');

// The tier a ship sails as: a true visual pack (one drawable standing in for
// hidden ships) takes the stack tier for its exact count; anything else the
// commit tier for its fleet or pack size.
export function harborShipTier(ship = {}) {
    if (ship.releaseSail) return { ...RELEASE_SAIL_TIER, packSize: 1, stack: false };
    if (ship.isInbound) return { ...INBOUND_TIER, packSize: 1, stack: false };
    const packSize = harborShipPackSize(ship);
    if (Number(ship.visualPackSize) > 1) {
        const count = Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, Math.round(Number(packSize) || 1)));
        const stack = HARBOR_STACK_TIERS.find(tier => count >= tier.minCommits);
        return { ...stack, packSize: count, stack: true };
    }
    const tier = HARBOR_SHIP_TIERS.find(item => packSize >= item.minCommits)
        || HARBOR_SHIP_TIERS[HARBOR_SHIP_TIERS.length - 1];
    return { ...tier, packSize, stack: false };
}

export function harborShipFootprint(ship = {}) {
    return harborShipTier(ship).footprint;
}

export const MAX_SHIPS_PER_SQUAD_ANCHORAGE = 3;
export const MAX_HARBOR_SHIP_PACK_SIZE = 50;

// Titan tiers — a repo/branch fleet of HARBOR_TITAN_MIN_COMMITS or more docked
// commits stops sailing as one ship per commit and consolidates into
// ceil(n / 50) balanced stack ships (5/10/20/30/40/50-class hulls, exact count
// on the badge). Smaller fleets keep the lead-hull + skiffs look.
export const HARBOR_TITAN_MIN_COMMITS = 5;

export const HARBOR_SQUAD_REUSE_OFFSETS = Object.freeze([
    { tileX: 0.70, tileY: 0.48 },
    { tileX: -0.56, tileY: 0.56 },
    { tileX: 0.82, tileY: -0.34 },
    { tileX: -0.64, tileY: -0.42 },
]);

export const HARBOR_SQUAD_ANCHORAGES = Object.freeze([
    { name: 'Inner West Basin', zone: 'inner-harbor', tileX: 32.60, tileY: 22.75, columns: 2, columnDx: 1.16, columnDy: 0.08, rowDx: -0.54, rowDy: 1.02 },
    { name: 'Inner Quay Basin', zone: 'inner-harbor', tileX: 35.15, tileY: 22.55, columns: 2, columnDx: 1.12, columnDy: -0.12, rowDx: -0.40, rowDy: 1.04 },
    { name: 'Harbor Mouth', zone: 'inner-harbor', tileX: 37.15, tileY: 20.50, columns: 2, columnDx: 0.52, columnDy: -1.08, rowDx: 0.88, rowDy: 0.26 },
    { name: 'Beacon Reach', zone: 'inner-harbor', tileX: 37.55, tileY: 17.25, columns: 2, columnDx: -0.32, columnDy: -1.18, rowDx: 0.84, rowDy: 0.18 },
    { name: 'North Roadstead', zone: 'outer-roadstead', tileX: 38.05, tileY: 13.15, columns: 2, columnDx: -0.34, columnDy: -1.26, rowDx: 0.86, rowDy: 0.10 },
    { name: 'East Roadstead', zone: 'outer-roadstead', tileX: 38.75, tileY: 16.15, columns: 2, columnDx: 0.86, columnDy: -0.70, rowDx: 0.54, rowDy: 0.76 },
    { name: 'South Roadstead', zone: 'outer-roadstead', tileX: 38.90, tileY: 21.20, columns: 2, columnDx: 1.04, columnDy: 0.08, rowDx: 0.38, rowDy: 0.98 },
    { name: 'Outer Fairway', zone: 'outer-roadstead', tileX: 38.25, tileY: 24.05, columns: 2, columnDx: 1.06, columnDy: 0.20, rowDx: -0.28, rowDy: 1.04 },
]);

export const COMMIT_LAGOON_SQUAD_ANCHORAGES = Object.freeze([
    { name: 'Commit Lagoon West', zone: 'commit-lagoon', tileX: 7.75, tileY: 8.55, columns: 2, columnDx: 0.96, columnDy: -0.22, rowDx: 0.36, rowDy: 0.82 },
    { name: 'Commit Lagoon Spring', zone: 'commit-lagoon', tileX: 12.30, tileY: 5.75, columns: 2, columnDx: 0.82, columnDy: 0.18, rowDx: 0.54, rowDy: 0.72 },
    { name: 'Commit Lagoon Center', zone: 'commit-lagoon', tileX: 14.20, tileY: 9.30, columns: 2, columnDx: 1.04, columnDy: -0.18, rowDx: 0.42, rowDy: 0.82 },
    { name: 'Commit Lagoon East', zone: 'commit-lagoon', tileX: 25.60, tileY: 3.90, columns: 2, columnDx: 0.82, columnDy: -0.24, rowDx: 0.46, rowDy: 0.78 },
]);

// Quay berths (pull-request cutters, legacy fallbacks): the pier channels.
export const BERTHS = [
    { tileX: 32.6, tileY: 19.85 },
    { tileX: 33.5, tileY: 19.85 },
    { tileX: 34.4, tileY: 19.85 },
    { tileX: 32.6, tileY: 17.6 },
    { tileX: 33.5, tileY: 17.6 },
    { tileX: 34.4, tileY: 17.6 },
    { tileX: 35.3, tileY: 19.85 },
    { tileX: 35.3, tileY: 17.6 },
    { tileX: 32.6, tileY: 21.95 },
    { tileX: 33.5, tileY: 21.95 },
    { tileX: 34.4, tileY: 21.95 },
    { tileX: 35.3, tileY: 21.95 },
];

export const QUAY_GROUPS = [
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
export const COAST_ANCHORAGE_SLOTS = Object.freeze([
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
    // D2 — the Harbor's pier berths (Track C's quay, 5.A): the water
    // channels between and beside its three piers. A fleet moors in line
    // astern, lead at the inner end clear of the quay, bow in (NW), squad
    // toward the pier heads and, past them, on out along the same line;
    // branch squads queue down it too. Its marker (`markerTile`) is a post on
    // the pier deck beside the channel, not a buoy on open water.
    { name: 'North Pier Berth', zone: 'coast', pier: true, tileX: 36.2, tileY: 17.6, columns: 1, columnDx: 0, columnDy: 0, rowDx: 1.0, rowDy: 0, leadDx: -3.0, leadDy: 0, moorHeading: 'nw', markerTileX: 35.4, markerTileY: 18.5 },
    { name: 'Middle Pier Berth', zone: 'coast', pier: true, tileX: 36.2, tileY: 19.85, columns: 1, columnDx: 0, columnDy: 0, rowDx: 1.0, rowDy: 0, leadDx: -3.0, leadDy: 0, moorHeading: 'nw', markerTileX: 34.9, markerTileY: 20.6 },
    { name: 'Pharos Pier Berth', zone: 'coast', pier: true, tileX: 36.2, tileY: 15.2, columns: 1, columnDx: 0, columnDy: 0, rowDx: 1.0, rowDy: 0, leadDx: -3.0, leadDy: 0, moorHeading: 'nw', markerTileX: 35.4, markerTileY: 16.1 },
    { name: 'Quay Pier Berth', zone: 'coast', pier: true, tileX: 36.2, tileY: 22.1, columns: 1, columnDx: 0, columnDy: 0, rowDx: 1.0, rowDy: 0, leadDx: -3.0, leadDy: 0, moorHeading: 'nw', markerTileX: 33.2, markerTileY: 21.2 },
]);

// Bumped when the claim order changes; HarborState re-claims a state laid
// out under an older order (2 = D2, the pier berths first).
export const HARBOR_ANCHORAGE_VERSION = 2;

// D2 — the order fleets claim anchorages (indexes into
// COAST_ANCHORAGE_SLOTS, which keep their order for the repo stones):
// the four pier berths, then the lagoon and the coast take the overflow.
export const HARBOR_SLOT_FILL_ORDER = Object.freeze([10, 11, 12, 13, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

// The Harbor's pier decks (Track C, 5.A): water obstacles in the field,
// tile rectangles (centreline ± 0.35 over each pier's span).
export const HARBOR_PIER_DECKS = Object.freeze([
    // The quay platform's water front (the house footprint is land already).
    Object.freeze({ name: 'Quay', x0: 28.0, x1: 32.0, y0: 16.6, y1: 21.3 }),
    Object.freeze({ name: 'North', x0: 31.5, x1: 35.8, y0: 16.05, y1: 16.75 }),
    Object.freeze({ name: 'Middle', x0: 32.0, x1: 35.8, y0: 18.45, y1: 19.15 }),
    Object.freeze({ name: 'South', x0: 32.0, x1: 35.3, y0: 20.55, y1: 21.25 }),
]);

export const COAST_ANCHORAGE_ZONE = 'coast';

export const SEA_LANES = [
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

// Departure route families. A push picks one by hash (the reducer's
// `departRouteIndex`); each family stands out to sea through its own horizon
// exit (HARBOR_SEA_EXITS), and the lane graph finds the water between. The
// names stay the route-graph ids the panels show.
export const LOCAL_WATER_ROUTE_BANDS = Object.freeze([
    Object.freeze({ name: 'inner-channel', exitIndex: 0 }),
    Object.freeze({ name: 'outer-channel', exitIndex: 1 }),
    Object.freeze({ name: 'beacon-channel', exitIndex: 2 }),
]);

export const COMMIT_LAGOON_ROUTE_BANDS = Object.freeze([
    Object.freeze({ name: 'lagoon-east-channel', exitIndex: 1 }),
    Object.freeze({ name: 'lagoon-spring-channel', exitIndex: 0 }),
    Object.freeze({ name: 'tavern-backwater', exitIndex: 2 }),
]);

export const DEPARTURE_EDGE_Y = 2.8;
export const HARBOR_ROUTE_GRAPH_VERSION = 1;

export const HARBOR_ROUTE_WAYPOINTS = Object.freeze({
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
    'lagoon.center': { id: 'lagoon.center', name: 'Commit Lagoon Center', zone: 'commit-lagoon', tileX: 14.20, tileY: 9.30 },
    'lagoon.south-channel': { id: 'lagoon.south-channel', name: 'Islet South Channel', zone: 'commit-lagoon', tileX: 21.00, tileY: 9.75 },
    'lagoon.east': { id: 'lagoon.east', name: 'Commit Lagoon East', zone: 'commit-lagoon', tileX: 25.60, tileY: 3.90 },
    'lagoon.channel-buoy': { id: 'lagoon.channel-buoy', name: 'Lagoon Channel Buoy', zone: 'commit-lagoon', tileX: 26.0, tileY: 6.0 },
});

export const HARBOR_ROUTE_GRAPH = Object.freeze({
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
            waypoints: ['lagoon.center', 'lagoon.south-channel', 'lagoon.channel-buoy', 'lagoon.east', 'roadstead.north', 'sea.exit'],
        },
        'lagoon.lagoon-spring-channel': {
            id: 'lagoon.lagoon-spring-channel',
            name: 'Lagoon Spring Channel',
            kind: 'lagoon',
            zone: 'commit-lagoon',
            bandName: 'lagoon-spring-channel',
            waypoints: ['lagoon.spring', 'lagoon.south-channel', 'lagoon.channel-buoy', 'roadstead.north', 'sea.exit'],
        },
        'lagoon.tavern-backwater': {
            id: 'lagoon.tavern-backwater',
            name: 'Tavern Backwater',
            kind: 'lagoon',
            zone: 'commit-lagoon',
            bandName: 'tavern-backwater',
            waypoints: ['lagoon.center', 'lagoon.south-channel', 'lagoon.channel-buoy', 'roadstead.outer', 'sea.exit'],
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
            waypoints: ['harbor.inner-basin', 'lagoon.channel-buoy', 'lagoon.south-channel', 'lagoon.center'],
        },
    }),
});

export function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

export function toTile(x, y) {
    return worldToTile(x, y);
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

export function repoAnchorageKey(project) {
    return String(project || 'unknown');
}

export function repoAnchorageSlot(state, project) {
    const slot = state?.repoAnchorages?.get?.(repoAnchorageKey(project));
    return Number.isInteger(slot) ? slot : null;
}

// Dock order: failed first, then oldest first, so a new commit joins the
// tail of its fleet and never reshuffles the ships already moored (P-D2).
export function compareDockedShips(a, b) {
    const aFailed = a?.pushStatus === 'failed' ? 1 : 0;
    const bFailed = b?.pushStatus === 'failed' ? 1 : 0;
    return (bFailed - aFailed)
        || ((a?.eventTime || 0) - (b?.eventTime || 0))
        || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function dockSquadDensity(totalDocked, squadCount, shipCount) {
    return Math.max(
        Math.min(1, totalDocked / 14),
        Math.min(1, squadCount / 6),
        Math.min(1, shipCount / 4)
    );
}

export function harborShipClassFormationSpacing(ship = {}) {
    const footprint = Math.max(0.85, harborShipFootprint(ship));
    return Math.max(1.05, Math.min(2.28, 0.82 + footprint * 0.56));
}

export function dockSquadFormationSpacing(ships = [], repoDockOffset = 0, repoDockCount = ships.length) {
    return ships.reduce((spacing, ship, shipIndex) => (
        Math.max(spacing, harborShipClassFormationSpacing({
            ...ship,
            repoDockIndex: repoDockOffset + shipIndex,
            repoDockCount,
            repoDockVisibleCount: ships.length,
        }))
    ), 1);
}

export function anchoragesForWaitingZone(waitingZone) {
    return isCommitLagoonZone(waitingZone)
        ? COMMIT_LAGOON_SQUAD_ANCHORAGES
        : HARBOR_SQUAD_ANCHORAGES;
}

export function harborShipCollisionRadius(ship = {}) {
    const footprint = Math.max(0.85, harborShipFootprint(ship));
    return Math.max(34, Math.min(66, 22 + footprint * 16));
}

export function isCommitLagoonZone(zone) {
    return zone === 'commit-lagoon';
}

export function isCoastZone(zone) {
    return zone === COAST_ANCHORAGE_ZONE;
}

// World px a lagoon ship keeps from the world ash's islet (WORLD_TREE.islet):
// about a hull's half-length, so no keel ever rides its sand.
export const WORLD_TREE_ISLET_CLEARANCE_PX = 24;

// A tile pushed radially off the world ash's islet until it stands
// WORLD_TREE_ISLET_CLEARANCE_PX clear of its oval; any other tile unchanged.
export function clearOfWorldTreeIslet(tile) {
    const { centerX, centerY, radiusX, radiusY } = WORLD_TREE.islet;
    const world = tileToWorld(tile.tileX, tile.tileY);
    const dx = world.x - centerX;
    const dy = world.y - centerY;
    const outerX = radiusX + WORLD_TREE_ISLET_CLEARANCE_PX;
    const outerY = radiusY + WORLD_TREE_ISLET_CLEARANCE_PX;
    const reach = Math.hypot(dx / outerX, dy / outerY);
    if (reach >= 1) return tile;
    const angle = reach > 0 ? Math.atan2(dy / outerY, dx / outerX) : Math.PI / 2;
    const pushed = worldToTile(centerX + Math.cos(angle) * outerX, centerY + Math.sin(angle) * outerY);
    return { tileX: pushed.tileX, tileY: pushed.tileY };
}

export function dockSquadCycleOffset(squadCycle = 0, anchorIndex = 0) {
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

const DOCK_FORMATION_LOOSENESS = 0.18;

export function dockSquadFormationTile(anchor, shipIndex, shipCount, squadCycle = 0, key = '', spacing = 1, anchorIndex = 0) {
    const columns = Math.max(1, Math.min(Number(anchor.columns) || 1, shipCount));
    const column = shipIndex % columns;
    const row = Math.floor(shipIndex / columns);
    const columnCenter = (columns - 1) / 2;
    const spacingScale = Math.max(0.9, Number(spacing) || 1);
    // A loose anchorage, not a lattice: odd rows stand half a column over,
    // and each ship swings up to DOCK_FORMATION_LOOSENESS tiles off its
    // place by its own hash (placement still keeps every berth clear).
    const stagger = columns > 1 && row % 2 === 1 ? 0.5 : 0;
    // (A pier berth keeps its channel line; it loosens past the heads.)
    const hash = stableHash(`${key}:${shipIndex}:anchor`);
    const loose = shipCount > 1 && !anchor.pier ? DOCK_FORMATION_LOOSENESS : 0;
    const looseX = ((hash % 1000) / 1000 - 0.5) * 2 * loose;
    const looseY = ((Math.floor(hash / 1000) % 1000) / 1000 - 0.5) * 2 * loose;
    const cycleOffset = dockSquadCycleOffset(squadCycle, anchorIndex);
    return {
        tileX: anchor.tileX
            + (column - columnCenter + stagger) * (anchor.columnDx || 0) * spacingScale
            + row * (anchor.rowDx || 0) * spacingScale
            + cycleOffset.tileX
            + looseX,
        tileY: anchor.tileY
            + (column - columnCenter + stagger) * (anchor.columnDy || 0) * spacingScale
            + row * (anchor.rowDy || 0) * spacingScale
            + cycleOffset.tileY
            + looseY,
        column,
        row,
        columns,
    };
}

// P-D4 — moorings by placement, in layout order: each hull takes its
// formation tile if that water keeps its clearance from land and its berth
// room from every hull already placed, else the nearest such point on rings
// round it (DOCK_PLACE_STEP apart, out to DOCK_PLACE_REACH tiles). Earlier
// fleets never move for later ones, so a new commit only ever places itself.
// Berth room is an ellipse on screen: a hull's collision radius across, 80 %
// of it up and down the screen (iso rows stack a little closer).
const DOCK_ROOM_FORE_AFT = 0.8;
const DOCK_PLACE_STEP = 0.2;
// The pier heads' tileX (Track C's decks end by 35.8).
const HARBOR_PIER_HEAD_TILE_X = 36.0;
// How far (tiles) a pier fleet's line runs on out past its pier heads.
const DOCK_PLACE_LINE_REACH = 14;
const DOCK_PLACE_REACH = 5;

function dockRoomFree(entry, x, y, placed) {
    const box = hullScreenBox({ x, y }, entry);
    for (const other of placed) {
        const r = Math.max(entry.collisionRadius || 42, other.collisionRadius || 42);
        const dx = (x - other.x) / r;
        const dy = (y - other.y) / (r * DOCK_ROOM_FORE_AFT);
        if (dx * dx + dy * dy < 1) return false;
        // No two hull bodies overlap on screen, however wide a stack.
        if (boxesOverlap(box, hullScreenBox(other, other))) return false;
    }
    return true;
}

export function relaxDockShipLayout(entries = []) {
    if (!Array.isArray(entries) || !entries.length) return;
    const field = harborWaterField();
    const placed = [];
    for (const entry of entries) {
        const clearance = Number(entry.clearance) || harborHullClearance(entry);
        const intended = toTile(entry.x, entry.y);
        let chosen = null;
        let fallback = null;
        let fallbackRoom = -Infinity;
        if (entry.placeAlong) {
            // Past the pier heads the line loosens like an open anchorage:
            // each hull stands off it by its own hash.
            const sway = ((stableHash(`${entry.id}:pier-line`) % 1000) / 1000 - 0.5) * 2 * DOCK_FORMATION_LOOSENESS;
            for (let step = 0; step * DOCK_PLACE_STEP <= DOCK_PLACE_LINE_REACH && !chosen; step++) {
                const along = {
                    tileX: intended.tileX + entry.placeAlong.tileX * step * DOCK_PLACE_STEP,
                    tileY: intended.tileY + entry.placeAlong.tileY * step * DOCK_PLACE_STEP,
                };
                if (entry.berthOutside && along.tileX < HARBOR_PIER_HEAD_TILE_X + 0.4) continue;
                const open = along.tileX > HARBOR_PIER_HEAD_TILE_X ? sway : 0;
                const tile = {
                    tileX: along.tileX - entry.placeAlong.tileY * open,
                    tileY: along.tileY + entry.placeAlong.tileX * open,
                };
                if (field.clearance(tile.tileX, tile.tileY) < clearance) continue;
                const world = toWorld(tile.tileX, tile.tileY);
                if (!hullClearsPiers(world, entry)) continue;
                if (dockRoomFree(entry, world.x, world.y, placed)) chosen = tile;
            }
        }
        for (let ring = 0; ring * DOCK_PLACE_STEP <= DOCK_PLACE_REACH && !chosen; ring++) {
            const radius = ring * DOCK_PLACE_STEP;
            const count = ring === 0 ? 1 : Math.ceil(Math.PI * 2 * radius / DOCK_PLACE_STEP);
            // Each ring starts on the formation's own row line (stable).
            for (let i = 0; i < count; i++) {
                const angle = (i / count) * Math.PI * 2;
                const tile = { tileX: intended.tileX + Math.cos(angle) * radius, tileY: intended.tileY + Math.sin(angle) * radius };
                if (field.clearance(tile.tileX, tile.tileY) < clearance) continue;
                const world = toWorld(tile.tileX, tile.tileY);
                if (!hullClearsPiers(world, entry)) continue;
                if (dockRoomFree(entry, world.x, world.y, placed)) {
                    chosen = tile;
                    break;
                }
                // The roomiest clear point seen, should every ring be full.
                let room = Infinity;
                for (const other of placed) room = Math.min(room, Math.hypot(world.x - other.x, (world.y - other.y) / DOCK_ROOM_FORE_AFT));
                if (room > fallbackRoom) {
                    fallback = tile;
                    fallbackRoom = room;
                }
            }
        }
        const tile = chosen || fallback || field.nearestClear(intended, clearance);
        const world = toWorld(tile.tileX, tile.tileY);
        entry.x = world.x;
        entry.y = world.y;
        entry.tileX = tile.tileX;
        entry.tileY = tile.tileY;
        placed.push(entry);
    }
}

// S-M1 — a dock layout is a pure function of one state: cached per state
// object (each reduce returns a new one), so every consumer of a state reads
// one layout, two harbors never share one, and a layout never holds ship
// objects from an older state. A reducer that is still mutating its state
// builds with buildDockLayoutFresh instead.
const _layoutByState = new WeakMap();

export function buildDockSquadLayout(state) {
    if (!state || typeof state !== 'object') return buildDockLayoutFresh(state);
    let cached = _layoutByState.get(state);
    // A new water mask re-lays every fleet.
    if (!cached || cached.version !== _waterFieldVersion) {
        cached = { version: _waterFieldVersion, layout: buildDockLayoutFresh(state) };
        _layoutByState.set(state, cached);
    }
    return cached.layout;
}

// Titan packing. `ships` is one repo/branch fleet in dock order. Fleets under
// HARBOR_TITAN_MIN_COMMITS keep one ship per commit; larger fleets collapse
// into ceil(n / MAX_HARBOR_SHIP_PACK_SIZE) balanced packs, each drawn as a
// single stack hull whose badge carries the exact count. Ships behind a failed,
// rejected or cancelled push pack the same way among themselves (row 20: a
// failed 60-commit fleet is two red-flagged stacks, not 60 hulls), and so do
// untethered and detached-HEAD ships. Every pack's lead is its first ship;
// the rest are hidden behind that lead and inherit its position.
function dockedPackGroup(ship = {}) {
    const status = ship.pushStatus === 'canceled' ? 'cancelled' : ship.pushStatus;
    if (status === 'failed' || status === 'rejected' || status === 'cancelled') return status;
    // Untethered and detached-HEAD ships pack among themselves too (a
    // detached worktree's 24 commits are one stack with its detached
    // marker, not a 24-skiff line); detached work also follows the budget.
    if (ship.untetheredFlag) return 'untethered';
    if (ship.detachedHead) return 'detached';
    return 'regular';
}
const BUDGETED_PACK_GROUPS = new Set(['regular', 'detached']);

export function planDockedVisualPacks(ships = [], regularThreshold = HARBOR_TITAN_MIN_COMMITS) {
    const groups = new Map();
    ships.forEach((ship, index) => {
        const group = dockedPackGroup(ship);
        const list = groups.get(group) || [];
        list.push({ ship, index });
        groups.set(group, list);
    });
    const toPack = (chunk) => ({
        ships: chunk.map(entry => entry.ship),
        lead: chunk[0].ship,
        size: chunk.length,
        startIndex: chunk[0].index,
        endIndex: chunk[chunk.length - 1].index,
    });
    const packs = [];
    for (const [group, entries] of groups) {
        const threshold = BUDGETED_PACK_GROUPS.has(group) ? regularThreshold : HARBOR_TITAN_MIN_COMMITS;
        if (entries.length < threshold) {
            for (const entry of entries) packs.push(toPack([entry]));
            continue;
        }
        const packCount = Math.ceil(entries.length / MAX_HARBOR_SHIP_PACK_SIZE);
        const base = Math.floor(entries.length / packCount);
        const extra = entries.length % packCount;
        let cursor = 0;
        for (let packIndex = 0; packIndex < packCount; packIndex++) {
            const size = base + (packIndex < extra ? 1 : 0);
            packs.push(toPack(entries.slice(cursor, cursor + size)));
            cursor += size;
        }
    }
    packs.sort((a, b) => a.startIndex - b.startIndex);
    return packs;
}

// Adaptive hull budget. A busy harbor packs its largest regular fleets
// sooner: their pack threshold steps 5 → 3 → 2 (largest fleet first) while
// more than HARBOR_HULL_BUDGET_HIGH hulls would show, and steps back up
// (smallest first) only while the harbor would stay under
// HARBOR_HULL_BUDGET_LOW, so a fleet never flips as single commits arrive.
// Failed, rejected and cancelled squads and loose ships keep their own rules.
// The thresholds live in the state (`packThresholds`, keyed like dock
// groups); the reducer carries them from one state to the next.
export const HARBOR_HULL_BUDGET_HIGH = 36;
export const HARBOR_HULL_BUDGET_LOW = 28;
const PACK_THRESHOLD_STEPS = Object.freeze([HARBOR_TITAN_MIN_COMMITS, 3, 2]);

function dockGroupsForBudget(state) {
    const groups = new Map();
    for (const ship of state?.ships?.values?.() || []) {
        if (ship.status !== 'docked') continue;
        const key = `${String(ship.project || 'unknown')}\x1f${ship.branch || ''}`;
        const list = groups.get(key) || [];
        list.push(ship);
        groups.set(key, list);
    }
    return [...groups.entries()].map(([key, ships]) => ({
        key,
        ships,
        regular: ships.filter(ship => BUDGETED_PACK_GROUPS.has(dockedPackGroup(ship))).length,
    }));
}

export function planPackThresholds(state, previous = null) {
    const groups = dockGroupsForBudget(state);
    const thresholds = new Map();
    for (const group of groups) {
        const held = Number(previous?.get?.(group.key));
        thresholds.set(group.key, PACK_THRESHOLD_STEPS.includes(held) ? held : HARBOR_TITAN_MIN_COMMITS);
    }
    const hullsOf = (group, threshold) => planDockedVisualPacks(group.ships, threshold).length;
    const counts = new Map(groups.map(group => [group.key, hullsOf(group, thresholds.get(group.key))]));
    let total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const bySize = [...groups].sort((a, b) => (b.regular - a.regular) || a.key.localeCompare(b.key));
    if (total > HARBOR_HULL_BUDGET_HIGH) {
        for (const step of PACK_THRESHOLD_STEPS.slice(1)) {
            for (const group of bySize) {
                if (total <= HARBOR_HULL_BUDGET_HIGH) break;
                if (thresholds.get(group.key) <= step || group.regular < step) continue;
                const next = hullsOf(group, step);
                total += next - counts.get(group.key);
                counts.set(group.key, next);
                thresholds.set(group.key, step);
            }
        }
    } else if (total < HARBOR_HULL_BUDGET_LOW) {
        for (const group of [...bySize].reverse()) {
            let threshold = thresholds.get(group.key);
            while (threshold < HARBOR_TITAN_MIN_COMMITS) {
                const up = PACK_THRESHOLD_STEPS[PACK_THRESHOLD_STEPS.indexOf(threshold) - 1];
                const next = hullsOf(group, up);
                if (total + next - counts.get(group.key) > HARBOR_HULL_BUDGET_LOW) break;
                total += next - counts.get(group.key);
                counts.set(group.key, next);
                threshold = up;
            }
            thresholds.set(group.key, threshold);
        }
    }
    for (const [key, threshold] of thresholds) if (threshold === HARBOR_TITAN_MIN_COMMITS) thresholds.delete(key);
    return thresholds;
}

export function coastFormationAnchor(slot = COAST_ANCHORAGE_SLOTS[0]) {
    return {
        ...slot,
        tileX: slot.tileX + (Number(slot.leadDx) || 0),
        tileY: slot.tileY + (Number(slot.leadDy) || 0),
    };
}

export function dockSquadPackSpacing(squad) {
    return squad.packs.reduce((spacing, pack) => (
        Math.max(spacing, harborShipClassFormationSpacing({
            ...pack.lead,
            repoDockIndex: pack.startIndex,
            repoDockCount: squad.repoDockCount,
            repoDockVisibleCount: squad.packs.length,
            visualPackSize: pack.size,
        }))
    ), 1);
}

export function buildDockLayoutFresh(state) {
    const groups = new Map();
    let totalDocked = 0;
    for (const ship of state?.ships?.values?.() || []) {
        if (ship.status !== 'docked') continue;
        const project = String(ship.project || 'unknown');
        const branch = ship.branch || '';
        const key = `${project}\x1f${branch}`;
        const knownQuay = state.repoQuays?.get?.(project);
        const group = groups.get(key) || {
            key,
            project: ship.project,
            branch,
            name: projectNameFromPath(project),
            // D1 — a linked worktree's branch moors as a sub-squad inside its
            // repo's anchorage; this names its worktree pennant.
            worktree: null,
            quayIndex: Number.isFinite(Number(ship.quayIndex)) ? Number(ship.quayIndex) : (Number.isFinite(knownQuay) ? knownQuay : 0),
            ships: [],
            failedCount: 0,
            latestEventTime: 0,
            earliestEventTime: Infinity,
        };
        group.ships.push(ship);
        if (!group.worktree && ship.worktree && ship.worktree.isMain === false) group.worktree = ship.worktree.name || '';
        group.failedCount += ship.pushStatus === 'failed' ? 1 : 0;
        group.latestEventTime = Math.max(group.latestEventTime, ship.eventTime || 0);
        group.earliestEventTime = Math.min(group.earliestEventTime, ship.eventTime || 0);
        groups.set(key, group);
        totalDocked += 1;
    }
    const repoGroups = [...groups.values()]
        .map((group) => ({
            ...group,
            ships: [...group.ships].sort(compareDockedShips),
            count: group.ships.length,
        }))
        // Sticky squad order: a branch keeps its place in its fleet while
        // its oldest commit waits, however the counts change.
        .sort((a, b) => (a.quayIndex - b.quayIndex)
            || (a.earliestEventTime - b.earliestEventTime)
            || a.name.localeCompare(b.name)
            || a.key.localeCompare(b.key));

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
        const packs = planDockedVisualPacks(group.ships, state?.packThresholds?.get?.(group.key) ?? HARBOR_TITAN_MIN_COMMITS);
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
            harborShipClassFormationSpacing({
                ...pack.lead,
                repoDockIndex: pack.startIndex,
                repoDockCount: squad.repoDockCount,
                repoDockVisibleCount: squad.packs.length,
                visualPackSize: pack.size,
            })
        ))).sort((a, b) => b - a);
        const hasPack = packs.some(pack => pack.size > 1);
        fleet.anchor = { ...coastFormationAnchor(slot), columns: hasPack || slot.pier ? slot.columns : slot.columns + 1 };
        fleet.visibleCount = packs.length;
        fleet.spacing = Math.max(1.05, (spacings.length >= 3 ? spacings[1] : spacings[0]) || 1);
        fleet.cursor = 0;
    }
    const zoneSquadCounts = new Map();
    const anchorageCycles = new Map();
    const representatives = [];
    squads.forEach((squad, squadIndex) => {
        const waitingZone = squad.waitingZone;
        const zoneSquadIndex = zoneSquadCounts.get(waitingZone) || 0;
        zoneSquadCounts.set(waitingZone, zoneSquadIndex + 1);
        let anchor;
        let anchorIndex;
        let squadCycle = 0;
        let spacing;
        const fleet = fleets.get(repoAnchorageKey(squad.project));
        if (fleet) {
            // P-D2 — each branch squad keeps its own block of formation
            // columns beside the buoy, so a commit on one branch never
            // shifts another branch's ships.
            const block = fleet.cursor++;
            const width = Math.max(1, Number(fleet.anchor.columns) || 1) * fleet.spacing;
            anchor = {
                ...fleet.anchor,
                tileX: fleet.anchor.tileX + block * width * (Number(fleet.anchor.columnDx) || 0),
                tileY: fleet.anchor.tileY + block * width * (Number(fleet.anchor.columnDy) || 0),
            };
            anchorIndex = fleet.slot;
            spacing = fleet.spacing;
        } else {
            // Overflow squads keep an anchorage by their own key (P-D2), so
            // one squad coming or going never moves the others; squads that
            // share an anchorage take its reuse rings in order.
            const anchorages = anchoragesForWaitingZone(waitingZone);
            anchorIndex = stableHash(squad.segmentKey || squad.key) % anchorages.length;
            const cycleKey = `${waitingZone}\x1f${anchorIndex}`;
            squadCycle = anchorageCycles.get(cycleKey) || 0;
            anchorageCycles.set(cycleKey, squadCycle + 1);
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
            const tile = dockSquadFormationTile(anchor, packIndex, squad.packs.length, squadCycle, squad.segmentKey || squad.key, spacing, anchorIndex);
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
                clearance: harborHullClearance(layoutShip),
                hullHalfPx: harborHullHalfWidthPx(layoutShip),
                hullBodyPx: harborHullBodyPx(layoutShip),
                squadKey: squad.key,
                worktree: squad.worktree || '',
                waitingZone,
                anchorageName: anchor.name,
                anchorageIndex: anchorIndex,
                moorHeading: anchor.moorHeading || '',
                // A pier fleet that overflows its channel moors on along
                // the channel line, past the pier heads (see placement).
                placeAlong: anchor.pier ? { tileX: Number(anchor.rowDx) || 0, tileY: Number(anchor.rowDy) || 0 } : null,
                berthOutside: anchor.pier ? harborBerthsOutsidePiers(layoutShip) : false,
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
                placeOrder: Number(lead.eventTime) || 0,
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

    // Oldest hulls place first, so a fleet's moorings hold as it grows.
    relaxDockShipLayout([...representatives].sort((a, b) => (a.placeOrder - b.placeOrder) || String(a.id).localeCompare(String(b.id))));
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

export function harborRouteGraphRoute(routeId) {
    return HARBOR_ROUTE_GRAPH.routes[routeId] || null;
}

export function routeGraphWaypointSnapshot(waypointId) {
    const waypoint = HARBOR_ROUTE_WAYPOINTS[waypointId] || { id: waypointId, name: waypointId, zone: 'unknown' };
    return {
        id: waypoint.id,
        name: waypoint.name,
        zone: waypoint.zone,
        tileX: Number.isFinite(Number(waypoint.tileX)) ? Number(waypoint.tileX) : null,
        tileY: Number.isFinite(Number(waypoint.tileY)) ? Number(waypoint.tileY) : null,
    };
}

export function routeGraphMetadata(routeId, overrides = {}) {
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

export function outboundRouteIdForBand(band, zone = 'harbor') {
    const bandName = String(band?.name || '');
    if (isCommitLagoonZone(zone)) return `lagoon.${bandName}`;
    return `outbound.${bandName}`;
}

export function waterRouteMetadataForBand(band, ship = {}, kind = 'outbound') {
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

export function compactRouteMetadata(route = null) {
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

export function routeBandsFromData(routeData, ship = null) {
    if (Array.isArray(routeData?.bands) && routeData.bands.length) return routeData.bands;
    return isCommitLagoonZone(ship?.departWaterZone || ship?.waitingZone)
        ? COMMIT_LAGOON_ROUTE_BANDS
        : LOCAL_WATER_ROUTE_BANDS;
}

// ─── Water field (Phase 3.2) ─────────────────────────────────────────────────
//
// Navigable water: the runtime scenery mask minus bridge spans, building
// footprints and the world ash's islet oval; everything off the map is open
// sea. HARBOR_WATER_MASK is that mask as it stood when the lane graph was
// laid (rows = tileY, columns = tileX, '~' = water), so the reducer and node
// tests lay out on the same water the app draws; the renderer registers the
// live mask through setHarborWaterMask. Distances are ground tiles (tile
// space is isotropic on the ground: one tile = 32√2 world px).
export const HARBOR_WATER_MASK = Object.freeze([
    '.................~~~~~~~~~~~~~~~~~~~~~~~',
    '.................~~~~~~~~~~~~~~~~~~~~~~~',
    '.................~~~~~~~~~~~~~~~~~~~~~~~',
    '..........~~~~~..~~~~~~~~~~~~~~~~~~~~~~~',
    '.........~~~~~~~.~...~~~~~~~~~~~~~~~~~~~',
    '....~~~~~~~~~~~~.~....~~~~~~~~~~~~~~~~~~',
    '.~~~~~~~~~~~~~~..~.....~~~~~~~~~~~~~~~~~',
    '.~~~~~~~~~~~~~..~~.....~~~~~~~~~~~~~~~~~',
    '..~~~~~~~~~~~~~~~~~...~~~~~...~~~~~~~~~~',
    '...~~~~~~~~~~~~~~~~~~~~~~~~...~~~~~~~~~~',
    '....~~~~~~~~~~~~~~~~~~........~~~~~~~~~~',
    '......~~~....~~~~~~~~~........~~~~~~~~~~',
    '..............~~~~~~~.........~~~~~~~~~~',
    '................~~...........~~~~~~~~~~~',
    '.............................~~~~~~~~~~~',
    '............................~~~~~~~~~~~~',
    '.............................~~~~~~~~~~~',
    '................................~~~~~~~~',
    '................................~~~~~~~~',
    '................................~~~~~~~~',
    '................................~~~~~~~~',
    '................~~..........~~~~~~~~~~~~',
    '~~~.....................~.~~~~~~~~~~~~~~',
    '~~~~~~~.~~~~~~~~~...~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~.~~~~~~~~~...~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~.~~~~~~~~~...~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~.~~~~~~~......~~~~~....~~~~~~~~~~',
    '~~~...........................~~~~~~~~~~',
    '..............................~~~~~~~~~~',
    '...............................~~~~~~~~~',
    '...............................~~~~~~~~~',
    '...............................~~~~~~~~~',
    '................................~~~~~~~~',
    '................................~~~~~~~~',
    '................................~~~~~~~~',
    '.................................~~~~~~~',
    '.................................~~~~~~~',
    '..................................~~~~~~',
    '..................................~~~~~~',
    '...................................~~~~~',
]);

export const HARBOR_GROUND_PX_PER_TILE = 32 * Math.SQRT2;
// How far (tiles) a clearance query looks for land; open sea reads as this.
export const HARBOR_WATER_REACH = 3;
// Lane clearance (tiles) between lane-graph nodes and in open water.
export const HARBOR_LANE_CLEARANCE = 0.5;
// Clearance a taut (shortcut) leg keeps where the water allows it.
const HARBOR_LANE_COMFORT = 0.8;

function maskLand(isWater) {
    const land = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) land[y * MAP_SIZE + x] = isWater(x, y) ? 0 : 1;
    }
    for (const building of BUILDING_DEFS) {
        const bx = building.position?.x ?? building.x;
        const by = building.position?.y ?? building.y;
        for (let y = by; y < by + building.height; y++) {
            for (let x = bx; x < bx + building.width; x++) {
                if (x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE) land[y * MAP_SIZE + x] = 1;
            }
        }
    }
    return land;
}

let _defaultLand = null;
let _registeredLand = null;
let _waterField = null;
let _waterFieldVersion = 0;
const _pathCache = new Map();
const PATH_CACHE_LIMIT = 512;

function defaultLand() {
    _defaultLand ||= maskLand((x, y) => HARBOR_WATER_MASK[y]?.[x] === '~');
    return _defaultLand;
}

// Registers the live water mask (a Set of "x,y" keys, plus the bridge spans
// ships never pass under); null restores HARBOR_WATER_MASK. Returns true when
// the navigable water changed (layouts and routes are then rebuilt).
export function setHarborWaterMask(waterTiles = null, bridgeTiles = null) {
    const next = waterTiles?.size
        ? maskLand((x, y) => {
            const key = `${x},${y}`;
            return waterTiles.has(key) && !bridgeTiles?.has?.(key);
        })
        : null;
    const current = _registeredLand || defaultLand();
    const candidate = next || defaultLand();
    let same = current.length === candidate.length;
    for (let i = 0; same && i < current.length; i++) same = current[i] === candidate[i];
    _registeredLand = next;
    if (same) return false;
    _waterField = null;
    _waterFieldVersion++;
    _pathCache.clear();
    return true;
}

export function harborWaterFieldVersion() {
    return _waterFieldVersion;
}

export function harborWaterField() {
    _waterField ||= buildHarborWaterField(_registeredLand || defaultLand());
    return _waterField;
}

function buildHarborWaterField(land) {
    const reach = HARBOR_WATER_REACH;
    const isLand = (ix, iy) => ix >= 0 && iy >= 0 && ix < MAP_SIZE && iy < MAP_SIZE && land[iy * MAP_SIZE + ix] === 1;
    const { centerX, centerY, radiusX, radiusY } = WORLD_TREE.islet;
    // Ground distance (tiles) outside the islet oval, measured along its radius.
    const isletClearance = (tileX, tileY) => {
        const world = tileToWorld(tileX, tileY);
        const ux = (world.x - centerX) / radiusX;
        const uy = (world.y - centerY) / radiusY;
        const r = Math.hypot(ux, uy);
        if (r > 6) return Infinity;
        const angle = Math.atan2(uy, ux);
        const rim = Math.hypot(Math.cos(angle) * radiusX, 2 * Math.sin(angle) * radiusY) / HARBOR_GROUND_PX_PER_TILE;
        return (r - 1) * rim;
    };
    // Ground tiles from (tileX, tileY) to the nearest land, capped at `reach`
    // (0 on land).
    const clearance = (tileX, tileY) => {
        let best = reach;
        const fx = Math.floor(tileX);
        const fy = Math.floor(tileY);
        for (let iy = fy - reach; iy <= fy + reach; iy++) {
            for (let ix = fx - reach; ix <= fx + reach; ix++) {
                if (!isLand(ix, iy)) continue;
                const dx = Math.max(ix - tileX, 0, tileX - ix - 1);
                const dy = Math.max(iy - tileY, 0, tileY - iy - 1);
                const d = Math.hypot(dx, dy);
                if (d < best) best = d;
            }
        }
        for (const deck of HARBOR_PIER_DECKS) {
            const dx = Math.max(deck.x0 - tileX, 0, tileX - deck.x1);
            const dy = Math.max(deck.y0 - tileY, 0, tileY - deck.y1);
            const d = Math.hypot(dx, dy);
            if (d < best) best = d;
        }
        return Math.max(0, Math.min(best, isletClearance(tileX, tileY)));
    };
    const field = {
        version: _waterFieldVersion,
        isLand,
        clearance,
        // Required clearance at distance `u` along a leg of length `len`: the
        // ends may sit as tight as their own clearance allows (`aOpen`,
        // `bOpen`), and the requirement rises at half a tile per tile to the
        // lane clearance between them.
        legOpen(a, b, aOpen = HARBOR_LANE_CLEARANCE, bOpen = HARBOR_LANE_CLEARANCE, lane = HARBOR_LANE_CLEARANCE) {
            const len = Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
            const steps = Math.max(1, Math.ceil(len / 0.1));
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const u = t * len;
                const need = Math.min(lane, aOpen + u * 0.5, bOpen + (len - u) * 0.5);
                if (clearance(a.tileX + (b.tileX - a.tileX) * t, a.tileY + (b.tileY - a.tileY) * t) < need - 1e-6) return false;
            }
            return true;
        },
        segmentClearance(a, b) {
            const len = Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
            const steps = Math.max(1, Math.ceil(len / 0.1));
            let min = Infinity;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                min = Math.min(min, clearance(a.tileX + (b.tileX - a.tileX) * t, a.tileY + (b.tileY - a.tileY) * t));
            }
            return min;
        },
        // The nearest point (rings of 0.1 tile) with at least `radius`
        // clearance; within a ring the most open one. Falls back to the most
        // open point seen.
        nearestClear(tile, radius) {
            const tx = Number(tile.tileX);
            const ty = Number(tile.tileY);
            if (clearance(tx, ty) >= radius) return { tileX: tx, tileY: ty };
            let fallback = { tileX: tx, tileY: ty };
            let fallbackClear = clearance(tx, ty);
            for (let ring = 1; ring <= 50; ring++) {
                const r = ring * 0.1;
                const count = Math.max(8, Math.ceil(Math.PI * 2 * r / 0.1));
                let found = null;
                let foundClear = -1;
                for (let i = 0; i < count; i++) {
                    const a = (i / count) * Math.PI * 2;
                    const px = tx + Math.cos(a) * r;
                    const py = ty + Math.sin(a) * r;
                    const c = clearance(px, py);
                    if (c >= radius && c > foundClear) {
                        found = { tileX: px, tileY: py };
                        foundClear = c;
                    }
                    if (c > fallbackClear) {
                        fallback = { tileX: px, tileY: py };
                        fallbackClear = c;
                    }
                }
                if (found) return found;
            }
            return fallback;
        },
    };
    field.lanes = buildLaneGraph(field);
    return field;
}

// ─── Lane graph (Phase 3.3) ──────────────────────────────────────────────────
//
// Channel-centre waypoints; the field links every pair it can sail between
// (HARBOR_LANE_CLEARANCE, or a pinch node's own clearance at its end). Routes
// run Dijkstra from any slot to any slot or horizon exit, are pulled taut
// where the water is open, and are smoothed with a centripetal Catmull-Rom
// spline checked against the field.
export const HARBOR_LANE_NODES = Object.freeze([
    { id: 'lagoon.west', tileX: 6.8, tileY: 7.9 },
    { id: 'lagoon.basin', tileX: 10.4, tileY: 8.6 },
    { id: 'lagoon.spring', tileX: 11.6, tileY: 5.4 },
    { id: 'lagoon.spit', tileX: 14.6, tileY: 9.4 },
    { id: 'lagoon.center', tileX: 17.6, tileY: 10.6 },
    { id: 'lagoon.channel-west', tileX: 20.4, tileY: 10.4 },
    // The south channel's pinch between the islet and the Tavern shore
    // (about 0.95 tile wide): nodes ride its clearance ridge.
    { id: 'lagoon.pinch-west', tileX: 21.2, tileY: 10.1 },
    { id: 'lagoon.pinch', tileX: 21.85, tileY: 9.55 },
    { id: 'lagoon.pinch-east', tileX: 22.6, tileY: 9.3 },
    { id: 'lagoon.channel-east', tileX: 23.4, tileY: 9.0 },
    { id: 'lagoon.islet-east', tileX: 24.9, tileY: 6.6 },
    { id: 'lagoon.east', tileX: 25.2, tileY: 3.2 },
    { id: 'sea.north', tileX: 29.5, tileY: 3.0 },
    { id: 'sea.north-east', tileX: 35.5, tileY: 5.0 },
    { id: 'roadstead.far-north', tileX: 38.2, tileY: 8.5 },
    { id: 'roadstead.north', tileX: 37.6, tileY: 12.4 },
    { id: 'coast.pharos', tileX: 32.8, tileY: 11.0 },
    { id: 'coast.pharos-bank', tileX: 31.6, tileY: 14.6 },
    { id: 'roadstead.east', tileX: 38.4, tileY: 16.2 },
    { id: 'harbor.mouth', tileX: 37.6, tileY: 19.4 },
    { id: 'harbor.pier-north', tileX: 36.6, tileY: 17.6 },
    { id: 'harbor.pier-middle', tileX: 36.4, tileY: 19.85 },
    { id: 'harbor.pier-pharos', tileX: 36.6, tileY: 15.2 },
    { id: 'harbor.inner', tileX: 36.3, tileY: 21.9 },
    { id: 'harbor.west', tileX: 31.4, tileY: 22.6 },
    { id: 'strait.mouth', tileX: 30.0, tileY: 24.2 },
    { id: 'coast.south', tileX: 37.8, tileY: 24.0 },
    { id: 'coast.strand', tileX: 34.6, tileY: 26.8 },
    { id: 'coast.south-sea', tileX: 38.0, tileY: 29.5 },
    { id: 'coast.reed', tileX: 34.8, tileY: 30.8 },
    { id: 'coast.wall', tileX: 36.4, tileY: 35.0 },
    // Horizon exits, off the map's north-east edge: a departing hull sinks
    // below the horizon on its last leg here (HarborTraffic).
    { id: 'horizon.north', tileX: 29.0, tileY: -7.0 },
    { id: 'horizon.north-east', tileX: 35.0, tileY: -6.5 },
    { id: 'horizon.east', tileX: 41.5, tileY: -4.0 },
]);

export const HARBOR_SEA_EXITS = Object.freeze(['horizon.north-east', 'horizon.north', 'horizon.east']);
const LANE_MAX_LEG = 11;

function buildLaneGraph(field) {
    const nodes = HARBOR_LANE_NODES
        .map(node => ({ ...node, open: Math.min(HARBOR_LANE_CLEARANCE, field.clearance(node.tileX, node.tileY) * 0.9) }))
        .filter(node => node.open > 0.2);
    const edges = nodes.map(() => []);
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const length = Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
            if (length > LANE_MAX_LEG) continue;
            // A short hop between ridge nodes in a pinch only has to stay as
            // open as its tighter end.
            const open = field.legOpen(a, b, a.open, b.open)
                || (length <= 1.5 && field.segmentClearance(a, b) >= Math.min(a.open, b.open));
            if (!open) continue;
            edges[i].push({ to: j, length });
            edges[j].push({ to: i, length });
        }
    }
    const byId = new Map(nodes.map((node, index) => [node.id, index]));
    return { nodes, edges, byId };
}

function laneEndOpen(field, tile) {
    return Math.min(HARBOR_LANE_CLEARANCE, field.clearance(tile.tileX, tile.tileY) * 0.9);
}

// Dijkstra over the lane graph with the two ends linked in as free points.
function lanePath(field, from, to) {
    const { nodes, edges } = field.lanes;
    const fromOpen = laneEndOpen(field, from);
    const toOpen = laneEndOpen(field, to);
    const direct = Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY);
    if (direct <= LANE_MAX_LEG && field.legOpen(from, to, fromOpen, toOpen)) return [from, to];
    const n = nodes.length;
    const START = n;
    const GOAL = n + 1;
    const links = (point, open) => {
        const out = [];
        let nearest = -1;
        let nearestLength = Infinity;
        for (let i = 0; i < n; i++) {
            const length = Math.hypot(nodes[i].tileX - point.tileX, nodes[i].tileY - point.tileY);
            if (length < nearestLength) {
                nearest = i;
                nearestLength = length;
            }
            if (length <= LANE_MAX_LEG && field.legOpen(point, nodes[i], open, nodes[i].open)) out.push({ to: i, length });
        }
        // A point no lane reaches (it should not happen on clamped water)
        // still joins the graph at its nearest node.
        if (!out.length && nearest >= 0) out.push({ to: nearest, length: nearestLength });
        return out;
    };
    const startLinks = links(from, fromOpen);
    const goalLinks = new Map(links(to, toOpen).map(link => [link.to, link.length]));
    const dist = new Float64Array(n + 2).fill(Infinity);
    const prev = new Int32Array(n + 2).fill(-1);
    const done = new Uint8Array(n + 2);
    dist[START] = 0;
    for (;;) {
        let u = -1;
        for (let i = 0; i < n + 2; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
        if (u < 0 || u === GOAL) break;
        done[u] = 1;
        const out = u === START ? startLinks : edges[u];
        for (const { to: v, length } of out) {
            if (dist[u] + length < dist[v]) {
                dist[v] = dist[u] + length;
                prev[v] = u;
            }
        }
        if (u !== START && goalLinks.has(u) && dist[u] + goalLinks.get(u) < dist[GOAL]) {
            dist[GOAL] = dist[u] + goalLinks.get(u);
            prev[GOAL] = u;
        }
    }
    if (prev[GOAL] < 0) return [from, to];
    const path = [];
    for (let v = prev[GOAL]; v !== START && v >= 0; v = prev[v]) path.push(nodes[v]);
    path.reverse();
    return [from, ...path.map(node => ({ tileX: node.tileX, tileY: node.tileY, open: node.open })), to];
}

// Greedy string-pulling: from each point, jump to the farthest later point
// whose leg keeps HARBOR_LANE_COMFORT clearance (or each end's own).
function pullTaut(field, points) {
    if (points.length <= 2) return points;
    const openOf = (index) => (index === 0 || index === points.length - 1
        ? laneEndOpen(field, points[index])
        : Math.min(HARBOR_LANE_COMFORT, points[index].open ?? HARBOR_LANE_CLEARANCE));
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
        let j = points.length - 1;
        while (j > i + 1 && !field.legOpen(points[i], points[j], openOf(i), openOf(j), HARBOR_LANE_COMFORT)) j--;
        out.push(points[j]);
        i = j;
    }
    return out;
}

// Centripetal Catmull-Rom through `points`, sampled about every 0.3 tile; a
// span whose curve strays nearer land than its chord does keeps the chord.
function smoothPath(field, points) {
    if (points.length <= 2) return points.map(p => ({ tileX: p.tileX, tileY: p.tileY }));
    const out = [{ tileX: points[0].tileX, tileY: points[0].tileY }];
    const knot = (a, b) => Math.sqrt(Math.max(1e-6, Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY)));
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const len = Math.hypot(p2.tileX - p1.tileX, p2.tileY - p1.tileY);
        const steps = Math.max(1, Math.ceil(len / 0.3));
        const t1 = knot(p0, p1);
        const t2 = t1 + knot(p1, p2);
        const t3 = t2 + knot(p2, p3);
        const at = (t) => {
            const lerp = (a, b, ta, tb) => {
                const w = tb - ta <= 1e-9 ? 0 : (t - ta) / (tb - ta);
                return { tileX: a.tileX + (b.tileX - a.tileX) * w, tileY: a.tileY + (b.tileY - a.tileY) * w };
            };
            const a1 = lerp(p0, p1, 0, t1);
            const a2 = lerp(p1, p2, t1, t2);
            const a3 = lerp(p2, p3, t2, t3);
            const b1 = lerp(a1, a2, 0, t2);
            const b2 = lerp(a2, a3, t1, t3);
            return lerp(b1, b2, t1, t2);
        };
        const chord = Math.min(HARBOR_LANE_CLEARANCE, field.segmentClearance(p1, p2));
        const span = [];
        let ok = true;
        for (let s = 1; s <= steps; s++) {
            const point = s === steps ? { tileX: p2.tileX, tileY: p2.tileY } : at(t1 + (t2 - t1) * (s / steps));
            if (s < steps && field.clearance(point.tileX, point.tileY) < chord - 0.02) ok = false;
            span.push(point);
        }
        if (ok) out.push(...span);
        else {
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                out.push({ tileX: p1.tileX + (p2.tileX - p1.tileX) * t, tileY: p1.tileY + (p2.tileY - p1.tileY) * t });
            }
        }
    }
    return out;
}

// The water path between two tiles (start and end exact): lane graph,
// pulled taut, smoothed. Cached per field version; callers must not mutate.
export function composeWaterPath(fromTile, toTile) {
    const from = { tileX: Number(fromTile.tileX), tileY: Number(fromTile.tileY) };
    const to = { tileX: Number(toTile.tileX), tileY: Number(toTile.tileY) };
    const key = `${_waterFieldVersion}|${from.tileX.toFixed(2)},${from.tileY.toFixed(2)}|${to.tileX.toFixed(2)},${to.tileY.toFixed(2)}`;
    const hit = _pathCache.get(key);
    if (hit) {
        _pathCache.delete(key);
        _pathCache.set(key, hit);
        return hit;
    }
    const field = harborWaterField();
    const path = Object.freeze(smoothPath(field, pullTaut(field, lanePath(field, from, to))));
    _pathCache.set(key, path);
    while (_pathCache.size > PATH_CACHE_LIMIT) _pathCache.delete(_pathCache.keys().next().value);
    return path;
}

export function harborSeaExit(index = 0) {
    const id = HARBOR_SEA_EXITS[Math.abs(Math.floor(Number(index) || 0)) % HARBOR_SEA_EXITS.length];
    const node = HARBOR_LANE_NODES.find(item => item.id === id);
    return { tileX: node.tileX, tileY: node.tileY };
}

// A departure: from the ship's mooring through the lane graph to its route
// family's horizon exit.
export function composeWaterRouteTiles(startTile, ship, routeData = null) {
    const bands = routeBandsFromData(routeData, ship);
    const routeIndex = Number.isFinite(Number(ship?.departRouteIndex))
        ? Number(ship.departRouteIndex)
        : Number(ship?.laneIndex || 0);
    const band = bands[Math.abs(routeIndex) % bands.length] || bands[0];
    return composeWaterPath(startTile, harborSeaExit(band.exitIndex ?? routeIndex));
}

// Where a route leaves the map (an inset of `margin` tiles inside its edge),
// or its end when it never does: finales and summaries anchor here, and the
// horizon leg beyond it is off-screen sea.
export function routeSeaTile(route = [], margin = 1) {
    const inside = (p) => p.tileX >= margin && p.tileY >= margin && p.tileX <= MAP_SIZE - 1 - margin && p.tileY <= MAP_SIZE - 1 - margin;
    return routeSeaCrossing(route, inside)?.tile || route[route.length - 1] || null;
}

// Ground distance along a route to where it leaves the map (its length when
// it never does).
export function routeSeaLength(route = []) {
    const inside = (p) => p.tileX >= 0 && p.tileY >= 0 && p.tileX <= MAP_SIZE - 1 && p.tileY <= MAP_SIZE - 1;
    return routeSeaCrossing(route, inside)?.distance ?? routeLengthTiles(route);
}

function routeSeaCrossing(route, inside) {
    let travelled = 0;
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1];
        const b = route[i];
        const length = Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY);
        if (inside(a) && !inside(b)) {
            let lo = 0;
            let hi = 1;
            for (let k = 0; k < 20; k++) {
                const mid = (lo + hi) / 2;
                if (inside({ tileX: a.tileX + (b.tileX - a.tileX) * mid, tileY: a.tileY + (b.tileY - a.tileY) * mid })) lo = mid;
                else hi = mid;
            }
            return {
                tile: { tileX: a.tileX + (b.tileX - a.tileX) * lo, tileY: a.tileY + (b.tileY - a.tileY) * lo },
                distance: travelled + length * lo,
            };
        }
        travelled += length;
    }
    return null;
}

export function routeLengthTiles(route = []) {
    let length = 0;
    for (let i = 1; i < route.length; i++) length += Math.hypot(route[i].tileX - route[i - 1].tileX, route[i].tileY - route[i - 1].tileY);
    return length;
}

export function composeStorageTransferTiles(fromTile, toTile) {
    return composeWaterPath(fromTile, toTile);
}

// ─── Sailing (Phase 3.4) ─────────────────────────────────────────────────────
//
// Cruise speed (ground tiles/s) by tier: small hulls are quicker. A convoy
// sails at its slowest member's speed. A departure accelerates from rest over
// HARBOR_SAIL_ACCEL_MS and then holds cruise to the horizon (no ease-out:
// the ship sails off, it does not stop); its duration is the route length at
// that speed, clamped.
export const HARBOR_SAIL_ACCEL_MS = 4000;
export const HARBOR_SAIL_MIN_MS = 20000;
export const HARBOR_SAIL_MAX_MS = 75000;
const HARBOR_TIER_SPEED = Object.freeze({
    skiff: 0.86, cutter: 0.82, sloop: 0.78, brigantine: 0.74, galleon: 0.7, dreadnought: 0.66, flagship: 0.62,
    stack5: 0.7, stack10: 0.66, stack20: 0.62, stack30: 0.6, stack40: 0.58, stack50: 0.56,
});

export function harborCruiseSpeed(ship = {}) {
    return HARBOR_TIER_SPEED[harborShipTier(ship).key] || 0.7;
}

// Hull length (ground tiles) as convoy spacing sees it.
export function harborHullLengthTiles(ship = {}) {
    return harborShipFootprint(ship) * 0.62;
}

export function harborSailDurationMs(lengthTiles, speed) {
    const accel = HARBOR_SAIL_ACCEL_MS / 1000;
    const raw = (Math.max(0, lengthTiles) / Math.max(0.05, speed) + accel / 2) * 1000;
    return Math.round(clamp(raw, HARBOR_SAIL_MIN_MS, HARBOR_SAIL_MAX_MS));
}

// Distance sailed (tiles) `elapsedMs` into a `durationMs` run of
// `lengthTiles`: rest → cruise over the accel window, cruise after.
export function harborSailDistance(elapsedMs, lengthTiles, durationMs, accelMs = HARBOR_SAIL_ACCEL_MS) {
    const total = Math.max(0.001, durationMs / 1000);
    const accel = Math.min(accelMs / 1000, total * 0.5);
    const speed = lengthTiles / Math.max(0.001, total - accel / 2);
    const t = clamp(elapsedMs / 1000, 0, total);
    return t < accel ? speed * t * t / (2 * accel) : Math.min(lengthTiles, speed * (t - accel / 2));
}

// A moored hull's screen size (world px, from its tier's strip width): half
// its hull's width, and its body's height above the waterline (sails and
// masts may rise over what lies behind it; the body may not).
export function harborHullHalfWidthPx(ship = {}) {
    return Math.round((Number(harborShipTier(ship).screenWidth) || 40) * 0.5);
}

export function harborHullBodyPx(ship = {}) {
    return Math.round(10 + (Number(harborShipTier(ship).screenWidth) || 40) * 0.15);
}

// World px a pier deck (and the quay) stands above the water; its pilings
// fill the face below the deck edge.
export const HARBOR_PIER_DECK_LIFT_PX = 12;
// The waterside buildings' lower walls (world px above their footprint) a
// hull body standing in front of them must not cover.
const HARBOR_WALL_LIFT_PX = 48;
const WATERSIDE_BUILDINGS = new Set(['harbor', 'watchtower']);

// A moored hull's body on screen (world px): its strip's width across, its
// body's height above the waterline (sails and masts may rise over what
// lies behind it; the body may not).
export function hullScreenBox(world, entry = {}) {
    const half = Number(entry.hullHalfPx) || 12;
    const body = Number(entry.hullBodyPx) || 14;
    return { x0: world.x - half, x1: world.x + half, y0: world.y - body, y1: world.y + 1 };
}

function boxesOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// The screen silhouette of a tile rectangle raised `lift` px: the convex
// hull of its water-level and lifted corners.
function prismPolygon(rect, lift) {
    const corners = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]];
    const points = [];
    for (const [tx, ty] of corners) {
        const w = toWorld(tx, ty);
        points.push([w.x, w.y], [w.x, w.y - lift]);
    }
    points.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of points) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (const p of [...points].reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Separating-axis test: an axis-aligned box against a convex polygon.
function boxHitsPolygon(box, poly) {
    const boxPoints = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    const axes = [[1, 0], [0, 1]];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        axes.push([b[1] - a[1], a[0] - b[0]]);
    }
    for (const [ax, ay] of axes) {
        let pMin = Infinity; let pMax = -Infinity; let bMin = Infinity; let bMax = -Infinity;
        for (const [x, y] of poly) { const d = x * ax + y * ay; pMin = Math.min(pMin, d); pMax = Math.max(pMax, d); }
        for (const [x, y] of boxPoints) { const d = x * ax + y * ay; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
        if (pMax <= bMin || bMax <= pMin) return false;
    }
    return true;
}

let _harborObstaclePolygons = null;
// Screen silhouettes a moored hull body must keep clear of: every pier deck
// and the quay (from the water to the deck), and the lower walls of the
// waterside buildings (the Harbor, the Lighthouse).
export function harborObstaclePolygons() {
    if (_harborObstaclePolygons) return _harborObstaclePolygons;
    const out = HARBOR_PIER_DECKS.map(deck => ({ name: deck.name, rect: deck, poly: prismPolygon(deck, HARBOR_PIER_DECK_LIFT_PX) }));
    for (const building of BUILDING_DEFS) {
        if (!WATERSIDE_BUILDINGS.has(building.type)) continue;
        const rect = { x0: building.x, x1: building.x + building.width, y0: building.y, y1: building.y + building.height };
        out.push({ name: building.type, rect, poly: prismPolygon(rect, HARBOR_WALL_LIFT_PX), building: true });
    }
    _harborObstaclePolygons = out;
    return out;
}

// True when a hull moored at world (x, y) keeps its body clear of every
// pier, the quay and the waterside walls on screen, whether they stand in
// front of it or behind it. A hull wholly behind a building (north or west
// of its footprint) is the depth sort's to hide, so walls only count for
// hulls in front of them.
export function hullClearsPiers(world, entry = {}) {
    const box = hullScreenBox(world, entry);
    const tile = toTile(world.x, world.y);
    for (const obstacle of harborObstaclePolygons()) {
        if (obstacle.building && (tile.tileY < obstacle.rect.y0 || tile.tileX < obstacle.rect.x0)) continue;
        if (boxHitsPolygon(box, obstacle.poly)) return false;
    }
    return true;
}

// Ground clearance (tiles) a moored hull keeps from land, by tier: never
// under HARBOR_MOORING_CLEARANCE, so no fleet moors in a channel too narrow
// for the lanes to reach it.
export const HARBOR_MOORING_CLEARANCE = 0.6;
export function harborHullClearance(ship = {}) {
    const width = Number(harborShipTier(ship).screenWidth) || 40;
    return Math.max(HARBOR_MOORING_CLEARANCE, 0.12 + 0.36 * width / HARBOR_GROUND_PX_PER_TILE);
}

// The largest hulls never berth inside a pier channel: they moor on the
// berth's line past the pier heads.
const PIER_OUTSIDE_TIERS = new Set(['flagship', 'dreadnought', 'stack10', 'stack20', 'stack30', 'stack40', 'stack50']);
export function harborBerthsOutsidePiers(ship = {}) {
    return PIER_OUTSIDE_TIERS.has(harborShipTier(ship).key);
}

// v0.23 A2 — the repo's lead ship (repoDockIndex/departSquadIndex 0) carries a
// commit-count-class hull sized by the whole fleet; every other commit sails as
// an individual skiff.
export function harborFleetCount(ship = {}) {
    return Math.max(
        1,
        Number(ship.repoTotalDockCount || 0),
        Number(ship.repoDockCount || 0),
        Number(ship.squadShipCount || 0),
        Number(ship.repoDockVisibleCount || 0)
    );
}

export function harborShipPackSize(ship = {}) {
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
