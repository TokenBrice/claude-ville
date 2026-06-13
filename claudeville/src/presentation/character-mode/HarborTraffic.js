import { MAP_SIZE } from '../../config/constants.js';
import { normalizeRepoBranch, repoBranchProfile, repoProfile } from '../shared/RepoColor.js';
import {
    cleanCommitSubject,
    collectGitEventsFromAgents,
    commitMessageFromCommand,
    displayRepoName,
    shortGitLabel,
} from '../shared/GitEventIdentity.js';
import { tileToWorld, worldToTile } from './Projection.js';

export { normalizeGitEvent } from '../shared/GitEventIdentity.js';

const SHIP_SPRITE_ID = 'prop.harborBoat';
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
const FINALE_EFFECT_MS = 9000;
const SCREEN_SUMMARY_MS = 16000;
const RECENT_PUSH_REPLAY_MS = 2 * 60 * 1000;
const HARBOR_CRATE_TTL_MS = 30000;
const MAX_LABEL_CHARS = 30;
const COMMIT_EQUIVALENCE_WINDOW_MS = 10 * 60 * 1000;
const HARBOR_FINALE_TILE = { tileX: 38.2, tileY: 6.6 };
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
const UNTETHERED_MIN_COMMITS = 2;
const UNTETHERED_HOLD_MS = 5 * 60 * 1000;
const PUSH_SIGNAL_EXPIRY_MS = 8000;
const HARBOR_BEACON_BUOY_TILE = { tileX: 26.0, tileY: 6.0 };
const REPO_DOCK_SHIP_Y_OFFSET = 236;
const REPO_DOCK_SHIP_SORT_OFFSET = 8;
const MAX_HARBOR_SHIP_PACK_SIZE = 30;
const HARBOR_DOCKED_VISUAL_PACK_THRESHOLD = 5;
const HARBOR_DOCKED_VISUAL_PACK_SIZE = 30;
const HARBOR_SQUAD_REUSE_OFFSETS = Object.freeze([
    { tileX: 0.70, tileY: 0.48 },
    { tileX: -0.56, tileY: 0.56 },
    { tileX: 0.82, tileY: -0.34 },
    { tileX: -0.64, tileY: -0.42 },
]);
const HARBOR_SHIP_CLASSES = Object.freeze([
    { key: 'flagship', spriteId: 'prop.harborShip.flagship', minCommits: 10, scale: 0.64, wakeScale: 2.38, cargoRows: 7, mastCount: 5, labelLift: 48, flagOffsetX: 31, flagOffsetY: 48, badge: '10+' },
    { key: 'dreadnought', spriteId: 'prop.harborShip.dreadnought', minCommits: 8, scale: 0.66, wakeScale: 2.12, cargoRows: 7, mastCount: 5, labelLift: 44, flagOffsetX: 28, flagOffsetY: 44, badge: '8+' },
    { key: 'galleon', spriteId: 'prop.harborShip.galleon', minCommits: 6, scale: 0.69, wakeScale: 1.86, cargoRows: 6, mastCount: 4, labelLift: 38, flagOffsetX: 24, flagOffsetY: 38, badge: '6+' },
    { key: 'brigantine', spriteId: 'prop.harborShip.brigantine', minCommits: 4, scale: 0.75, wakeScale: 1.56, cargoRows: 5, mastCount: 3, labelLift: 31, flagOffsetX: 18, flagOffsetY: 31, badge: '4+' },
    { key: 'sloop', spriteId: 'prop.harborShip.sloop', minCommits: 3, scale: 0.80, wakeScale: 1.32, cargoRows: 3, mastCount: 2, labelLift: 26, flagOffsetX: 14, flagOffsetY: 26, badge: '3+' },
    { key: 'cutter', spriteId: 'prop.harborShip.cutter', minCommits: 2, scale: 0.88, wakeScale: 1.15, cargoRows: 1, mastCount: 1, labelLift: 16, flagOffsetX: 8, flagOffsetY: 16, badge: '2+' },
    { key: 'skiff', spriteId: 'prop.harborShip.skiff', minCommits: 1, scale: 0.82, wakeScale: 0.88, cargoRows: 0, mastCount: 1, labelLift: 0, flagOffsetX: 0, flagOffsetY: 0, badge: '' },
]);
const HARBOR_SHIP_STACK_CLASSES = Object.freeze([
    { key: 'stack30', spriteId: 'prop.harborShip.stack30', minCommits: 25, scale: 0.82, wakeScale: 2.34, cargoRows: 8, mastCount: 6, labelLift: 54, flagOffsetX: 34, flagOffsetY: 52 },
    { key: 'stack20', spriteId: 'prop.harborShip.stack30', minCommits: 15, scale: 0.72, wakeScale: 2.02, cargoRows: 7, mastCount: 5, labelLift: 46, flagOffsetX: 30, flagOffsetY: 46 },
    { key: 'stack10', spriteId: 'prop.harborShip.stack10', minCommits: 8, scale: 0.76, wakeScale: 1.66, cargoRows: 5, mastCount: 4, labelLift: 36, flagOffsetX: 24, flagOffsetY: 36 },
    { key: 'stack5', spriteId: 'prop.harborShip.stack5', minCommits: 5, scale: 0.80, wakeScale: 1.30, cargoRows: 3, mastCount: 3, labelLift: 26, flagOffsetX: 17, flagOffsetY: 28 },
]);
const HARBOR_SHIP_PACK_SEQUENCE = Object.freeze([20, 10, 5, 1, 10, 5, 1, 5, 1]);
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

const QUAY_GROUPS = [
    { name: 'West Quay', berthIndexes: [0, 1, 2] },
    { name: 'Market Quay', berthIndexes: [3, 4, 5] },
    { name: 'Beacon Quay', berthIndexes: [6, 7, 8] },
    { name: 'Outer Quay', berthIndexes: [9, 10, 11] },
];

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
const DEPARTURE_EDGE_LANES = Object.freeze([7.4, 10.2, 13.0, 15.8, 18.6, 21.4, 24.2, 27.0, 29.8, 32.6, 35.4, 38.2]);

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

function trafficProfile(project, branch = '') {
    return repoBranchProfile(project, normalizeRepoBranch(branch));
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
    return {
        seenEventIds,
        ships,
        batches,
        pushEvents,
        repoQuays,
        nextSequence: Number.isFinite(previous.nextSequence) ? previous.nextSequence : ships.size,
        nextBatchSequence: Number.isFinite(previous.nextBatchSequence) ? previous.nextBatchSequence : batches.size,
    };
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
    return chosen;
}

function chooseBerthIndex(state, project) {
    const quayIndex = assignedQuayIndex(state, project);
    const key = String(project || 'unknown');
    const occupied = new Set();
    for (const ship of state.ships.values()) {
        if (Number.isFinite(Number(ship.berthIndex))) occupied.add(Number(ship.berthIndex));
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

function dockWaterBounds(entry = {}) {
    return isCommitLagoonZone(entry.waitingZone || entry.departWaterZone)
        ? COMMIT_LAGOON_WATER_BOUNDS
        : HARBOR_DOCK_WATER_BOUNDS;
}

function dockWaterRegions(entry = {}) {
    return isCommitLagoonZone(entry.waitingZone || entry.departWaterZone)
        ? COMMIT_LAGOON_WATER_REGIONS
        : HARBOR_DOCK_WATER_REGIONS;
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
// per-ship status/pushStatus/eventTime; cap at 32 entries (drop oldest on overflow).
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
    return `${ids.join('|')}#${meta.join(',')}`;
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

    const squads = [];
    repoGroups.forEach((group, repoGroupIndex) => {
        const totalRepoDockCount = group.ships.length;
        const zonePartitions = [
            {
                waitingZone: 'harbor',
                ships: [],
                sourceOffset: 0,
            },
            {
                waitingZone: 'commit-lagoon',
                ships: group.ships,
                sourceOffset: 0,
            },
        ];

        for (const partition of zonePartitions) {
            const zoneDockCount = partition.ships.length;
            if (!zoneDockCount) continue;
            const repoSegmentCount = Math.max(1, Math.ceil(zoneDockCount / MAX_SHIPS_PER_SQUAD_ANCHORAGE));
            for (let repoSegmentIndex = 0; repoSegmentIndex < repoSegmentCount; repoSegmentIndex++) {
                const start = repoSegmentIndex * MAX_SHIPS_PER_SQUAD_ANCHORAGE;
                const ships = partition.ships.slice(start, start + MAX_SHIPS_PER_SQUAD_ANCHORAGE);
                if (!ships.length) continue;
                const repoDockOffset = start;
                squads.push({
                    ...group,
                    ships,
                    count: ships.length,
                    repoDockCount: zoneDockCount,
                    repoTotalDockCount: totalRepoDockCount,
                    repoDockOffset,
                    repoSourceOffset: partition.sourceOffset + start,
                    repoGroupIndex,
                    repoSegmentIndex,
                    repoSegmentCount,
                    segmentKey: `${group.key}:${partition.waitingZone}:segment:${repoSegmentIndex}`,
                    waitingZone: partition.waitingZone,
                    failedCount: ships.filter(ship => ship.pushStatus === 'failed').length,
                    latestEventTime: ships.reduce((max, ship) => Math.max(max, ship.eventTime || 0), 0),
                });
            }
        }
    });

    const byShipId = new Map();
    const squadCount = squads.length;
    const zoneSquadCounts = new Map();
    squads.forEach((squad, squadIndex) => {
        const waitingZone = squad.waitingZone || 'harbor';
        const zoneSquadIndex = zoneSquadCounts.get(waitingZone) || 0;
        zoneSquadCounts.set(waitingZone, zoneSquadIndex + 1);
        const anchorages = anchoragesForWaitingZone(waitingZone);
        const anchorIndex = zoneSquadIndex % anchorages.length;
        const squadCycle = Math.floor(zoneSquadIndex / anchorages.length);
        const anchor = anchorages[anchorIndex] || anchorages[0] || HARBOR_SQUAD_ANCHORAGES[0];
        const repoDockCount = Math.max(squad.count, Number(squad.repoDockCount) || squad.count);
        const density = dockSquadDensity(totalDocked, squadCount, repoDockCount);
        const compactCommitLabel = density >= 0.52 || totalDocked >= 9 || repoDockCount >= 3;
        squad.anchor = anchor;
        squad.anchorIndex = anchorIndex;
        squad.squadIndex = squadIndex;
        squad.zoneSquadIndex = zoneSquadIndex;
        squad.squadCount = squadCount;
        squad.totalDocked = totalDocked;
        squad.density = density;
        squad.compactCommitLabel = compactCommitLabel;
        const repoDockOffset = Number(squad.repoDockOffset) || 0;
        squad.formationSpacing = dockSquadFormationSpacing(squad.ships, repoDockOffset, repoDockCount);
        squad.ships.forEach((ship, shipIndex) => {
            const tile = dockSquadFormationTile(anchor, shipIndex, squad.count, squadCycle, squad.segmentKey || squad.key, squad.formationSpacing, anchorIndex);
            const world = toWorld(tile.tileX, tile.tileY);
            const repoDockIndex = repoDockOffset + shipIndex;
            const layoutShip = {
                ...ship,
                repoDockIndex,
                repoDockCount,
                repoDockVisibleCount: squad.count,
                waitingZone,
            };
            const showCommitLabel = ship.pushStatus === 'failed'
                || (!compactCommitLabel && totalDocked <= 18)
                || (shipIndex === 0 && totalDocked <= 18 && repoDockCount <= 5)
                || (shipIndex === 0 && totalDocked <= 36 && (squad.repoSegmentIndex % 3) === 0);
            byShipId.set(ship.id, {
                ...tile,
                id: ship.id,
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
                repoDockVisibleCount: squad.count,
                repoSegmentIndex: squad.repoSegmentIndex,
                repoSegmentCount: squad.repoSegmentCount,
                squadIndex,
                zoneSquadIndex,
                squadCount,
                squadShipIndex: shipIndex,
                squadShipCount: squad.count,
                squadDensity: density,
                compactCommitLabel,
                showCommitLabel,
            });
        });
    });

    relaxDockShipLayout([...byShipId.values()]);

    return {
        squads,
        byShipId,
        totalDocked,
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
        return routeGraphMetadata(ship?.arrivingKind === 'fetch' ? 'inbound.fetch-roadstead' : 'inbound.pull');
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

function departureEdgeTile(ship, band) {
    if (!ship) return { tileX: 19.3, tileY: DEPARTURE_EDGE_Y };
    const laneCount = DEPARTURE_EDGE_LANES.length;
    const routeIndex = Number.isFinite(Number(ship?.departRouteIndex))
        ? Number(ship.departRouteIndex)
        : (Number(ship?.laneIndex) || 0);
    const squadIndex = Math.max(0, Math.min(10000, Number(ship?.departSquadIndex || 0)));
    const squadCount = Math.max(1, Number(ship?.departSquadCount || 1));
    const zone = ship?.departWaterZone || ship?.waitingZone || 'harbor';
    const routeSeed = stableHash(`${ship.id || ''}:${ship.departEventId || ''}:${zone}`);
    const laneOffset = Math.round((squadIndex - (squadCount - 1) / 2) * 0.8);
    const laneIndex = (((routeSeed % laneCount) + Math.abs(routeIndex) + laneOffset) % laneCount);
    const lane = DEPARTURE_EDGE_LANES[(laneIndex + laneCount) % laneCount];
    const bandBias = Number.isFinite(Number(band?.exitLaneIndex))
        ? Number(band.exitLaneIndex)
        : 0;
    const x = clamp(lane + bandBias * 0.28, 4.2, MAP_SIZE - 1.4);
    return { tileX: x, tileY: DEPARTURE_EDGE_Y };
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
    const exitPoint = fallbackLane?.[fallbackLane.length - 1];
    pushRoutePoint(raw, exitPoint);
    pushRoutePoint(raw, departureEdgeTile(ship, band));

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
    return cleanCommitSubject(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function commitIdentityParts(event = {}) {
    const project = String(event.project || 'unknown');
    const branch = normalizeRepoBranch(event.branch || event.targetRef || '');
    const sha = String(event.sha || '').trim().toLowerCase();
    const label = cleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
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

function findExistingCommitShip(state, event) {
    for (const ship of state.ships.values()) {
        if (sameCommitIdentity(ship, event)) return ship;
    }
    return null;
}

function mergeCommitIntoShip(ship, event, now = Date.now()) {
    const nextLabel = cleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
    const currentLabel = cleanCommitSubject(ship.label || '');
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
                    label: ship.label || '',
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

function pendingRepoSummariesFromDockSummaries(summaries) {
    const byRepo = new Map();
    for (const summary of summaries?.values?.() || []) {
        const count = Number(summary.count) || 0;
        if (count <= 0) continue;
        const profile = summary.profile || trafficProfile(summary.project, summary.branch);
        const existing = byRepo.get(profile.key) || {
            project: summary.project,
            branch: summary.branch || '',
            repoName: trafficLabel(summary.project, summary.branch),
            shortName: profile.shortName || trafficLabel(summary.project, summary.branch, 18),
            profile,
            pendingCommits: 0,
            failedPushes: 0,
            latestEventTime: 0,
            waitingZone: 'harbor',
            storageCommits: 0,
        };
        existing.pendingCommits += count;
        existing.failedPushes += Number(summary.failedCount) || 0;
        existing.latestEventTime = Math.max(existing.latestEventTime, Number(summary.latestEventTime) || 0);
        if (isCommitLagoonZone(summary.waitingZone)) {
            existing.waitingZone = 'commit-lagoon';
            existing.storageCommits += count;
        }
        byRepo.set(profile.key, existing);
    }
    return [...byRepo.values()]
        .sort((a, b) => (b.failedPushes - a.failedPushes)
            || (b.pendingCommits - a.pendingCommits)
            || (b.latestEventTime - a.latestEventTime)
            || a.repoName.localeCompare(b.repoName));
}

function dockedShipNeedsIndividualVisual(ship = {}) {
    return ship.pushStatus === 'failed'
        || ship.pushStatus === 'rejected'
        || ship.pushStatus === 'cancelled'
        || ship.pushStatus === 'canceled'
        || ship.untetheredFlag
        || ship.detachedHead;
}

function buildDockedVisualPackMap(dockLayout) {
    const groups = new Map();
    for (const squad of dockLayout?.squads || []) {
        for (const ship of squad.ships || []) {
            const meta = dockLayout.byShipId?.get?.(ship.id);
            if (!meta) continue;
            const waitingZone = meta.waitingZone || squad.waitingZone || 'harbor';
            const key = `${squad.key}\x1f${waitingZone}`;
            const group = groups.get(key) || [];
            group.push({ ship, meta });
            groups.set(key, group);
        }
    }

    const visible = new Map();
    for (const entries of groups.values()) {
        entries.sort((a, b) => (a.meta.repoDockIndex - b.meta.repoDockIndex)
            || ((a.ship.eventTime || 0) - (b.ship.eventTime || 0))
            || a.ship.id.localeCompare(b.ship.id));

        const regular = [];
        const special = [];
        for (const entry of entries) {
            if (dockedShipNeedsIndividualVisual(entry.ship)) special.push(entry);
            else regular.push(entry);
        }

        const visualEntries = [];
        for (let start = 0; start < regular.length;) {
            const remaining = regular.length - start;
            if (remaining < HARBOR_DOCKED_VISUAL_PACK_THRESHOLD) {
                for (const entry of regular.slice(start)) {
                    visualEntries.push({
                        entry,
                        visualPackSize: 1,
                        visualPackStartIndex: entry.meta.repoDockIndex,
                        visualPackEndIndex: entry.meta.repoDockIndex,
                        visualPackHiddenCount: 0,
                    });
                }
                break;
            }

            const chunk = regular.slice(start, start + HARBOR_DOCKED_VISUAL_PACK_SIZE);
            const last = chunk[chunk.length - 1];
            visualEntries.push({
                entry: chunk[0],
                visualPackSize: chunk.length,
                visualPackStartIndex: chunk[0].meta.repoDockIndex,
                visualPackEndIndex: last?.meta?.repoDockIndex ?? chunk[0].meta.repoDockIndex + chunk.length - 1,
                visualPackHiddenCount: Math.max(0, chunk.length - 1),
            });
            start += chunk.length;
        }

        for (const entry of special) {
            visualEntries.push({
                entry,
                visualPackSize: 1,
                visualPackStartIndex: entry.meta.repoDockIndex,
                visualPackEndIndex: entry.meta.repoDockIndex,
                visualPackHiddenCount: 0,
            });
        }

        visualEntries.sort((a, b) => (a.visualPackStartIndex - b.visualPackStartIndex)
            || a.entry.ship.id.localeCompare(b.entry.ship.id));
        const visibleCount = visualEntries.length;
        visualEntries.forEach((item, visualIndex) => {
            visible.set(item.entry.ship.id, {
                ...item,
                visualIndex,
                visibleCount,
            });
        });
    }
    return visible;
}

function distributedHarborShipPackSize(fleetCount, fleetIndex) {
    const count = Math.max(1, Math.round(Number(fleetCount) || 1));
    const index = Math.max(0, Math.min(count - 1, Math.round(Number(fleetIndex) || 0)));
    const maxPackSize = Math.min(MAX_HARBOR_SHIP_PACK_SIZE, count);
    if (count <= 1) return 1;
    if (index === 0) return maxPackSize;

    const cycle = Math.floor((index - 1) / HARBOR_SHIP_PACK_SEQUENCE.length);
    const sequenceIndex = (index - 1 + cycle * 3) % HARBOR_SHIP_PACK_SEQUENCE.length;
    return Math.max(1, Math.min(maxPackSize, HARBOR_SHIP_PACK_SEQUENCE[sequenceIndex] || 1));
}

function harborShipPackSize(ship = {}) {
    if (ship.status === 'docked') {
        const visualPackSize = Number(ship.visualPackSize);
        if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
            return Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, Math.round(visualPackSize)));
        }
    }
    if (ship.status === 'departing') {
        const departIndex = Number.isFinite(Number(ship.departSquadIndex))
            ? Math.max(0, Number(ship.departSquadIndex))
            : 0;
        return distributedHarborShipPackSize(ship.departSquadCount, departIndex);
    }
    const repoIndex = Number.isFinite(Number(ship.repoDockIndex))
        ? Math.max(0, Number(ship.repoDockIndex))
        : 0;
    const repoCount = Math.max(
        1,
        Number(ship.repoDockCount || 0),
        Number(ship.squadShipCount || 0),
        Number(ship.repoDockVisibleCount || 0)
    );
    return distributedHarborShipPackSize(repoCount, repoIndex);
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
    // 3.2 — inbound ships use a small fixed class so the inbound ramp is visually consistent.
    if (ship.isInbound) {
        const variant = inboundShipClass();
        return {
            ...variant,
            packSize: 1,
            trim: 0,
            scale: variant.scale,
        };
    }
    const packSize = harborShipPackSize(ship);
    const stackVariant = harborShipStackClass(packSize);
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
    return DEPARTURE_MS + Math.min(20000, packSize * 1200);
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

export function reduceHarborTrafficState(previous, events, options = {}) {
    const state = cloneState(previous);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const motionScale = options.motionScale === 0 ? 0 : 1;

    const sorted = [...(events || [])]
        .filter(event => event?.id && event?.type && event?.project)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    const latestPushTimes = latestPushTimesByProject(sorted);
    const relevantProjects = new Set(sorted.map(event => String(event.project || 'unknown')));
    for (const ship of state.ships.values()) {
        if (ship.project) relevantProjects.add(String(ship.project));
    }
    for (const [project] of state.repoQuays.entries()) {
        if (!relevantProjects.has(String(project || 'unknown'))) state.repoQuays.delete(project);
    }
    for (const project of relevantProjects) {
        assignedQuayIndex(state, project);
    }

    for (const event of sorted) {
        if (event.type !== 'push') {
            if (state.seenEventIds.has(event.id)) continue;
            state.seenEventIds.add(event.id);
        }

        if (event.type === 'commit') {
            if (isHistoricalCommittedBeforePush(event, latestPushTimes, now)) continue;
            const existingShip = findExistingCommitShip(state, event);
            if (existingShip) {
                state.seenEventIds.add(event.id);
                mergeCommitIntoShip(existingShip, event, now);
                continue;
            }
            const branch = eventBranch(event);
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project);
            const laneIndex = stableHash(`${event.project}:${branch}:${event.id}`) % SEA_LANES.length;
            const profile = trafficProfile(event.project, branch);
            state.nextSequence++;
            state.ships.set(event.id, {
                id: event.id,
                project: event.project,
                branch,
                targetRef: event.targetRef || '',
                ...gitEventDebugMetadata(event, branch),
                repoName: profile.shortName,
                quayIndex,
                sha: event.sha,
                label: cleanCommitSubject(event.label || commitMessageFromCommand(event.command)) || event.label,
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
            });
            continue;
        }

        // 3.2 — pull/fetch as inbound ships sailing toward harbor.
        if (event.type === 'pull' || event.type === 'fetch') {
            const inboundStatus = String(event.status || gitEventStatusLabel(event) || '').toLowerCase();
            if (inboundStatus === 'failed' || inboundStatus === 'rejected'
                || inboundStatus === 'cancelled' || inboundStatus === 'canceled') {
                state.seenEventIds.add(event.id);
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
                : chooseBerthIndex(state, event.project);
            state.nextSequence++;
            state.ships.set(inboundId, {
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
            });
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
            const incomingStatus = event.status || 'unknown';
            const previousStatus = previousPush?.status || null;
            const status = previousStatus && incomingStatus === 'unknown' ? previousStatus : incomingStatus;
            const existingBatch = state.batches.get(batchId);
            const statusChanged = previousStatus && previousStatus !== status;
            const branch = eventBranch(event);
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
            selectedShips.forEach((ship, departSquadIndex) => {
                const dockMeta = dockLayout.byShipId.get(ship.id);
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
                            : now + departSquadIndex * DEPARTURE_STAGGER_MS;
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
                            : now + departSquadIndex * DEPARTURE_STAGGER_MS;
                    }
                    ship.status = skipDepartureAnimation ? 'docked' : 'cancelling';
                    ship.departEventId = event.id;
                    ship.departEventTime = event.timestamp || now;
                    return;
                }
                ship.status = 'departing';
                ship.departEventId = event.id;
                // Mass-scaled departure (force-push wins).
                ship.departMsOverride = dynamicDepartureMs(ship, forceFlag);
                if (status === 'success' && previousStatus !== 'success') {
                    ship.departStartedAt = null;
                }
                ship.departStartedAt = skipDepartureAnimation
                    ? now - ship.departMsOverride - FADE_DELAY_MS - EXIT_FADE_MS - EXIT_HOLD_MS - 1
                    : ship.departStartedAt || startedAt + departSquadIndex * DEPARTURE_STAGGER_MS;
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
                ship.departEventId = null;
            }
            continue;
        }
        // 3.2 — inbound lifecycle: arrive then dock (pull) or anchor (fetch).
        if (ship.status === 'arriving') {
            const startedAt = ship.arrivingStartedAt || now;
            const duration = Math.max(1, Number(ship.arrivingDuration) || INBOUND_DURATION_MS);
            if (motionScale === 0 || now - startedAt >= duration) {
                if (ship.arrivingKind === 'fetch') {
                    ship.status = 'anchored';
                } else {
                    ship.status = 'docked';
                    ship.eventTime = ship.eventTime || now;
                }
            }
            continue;
        }
        // 3.2 — anchored fetch ships expire after a while.
        if (ship.status === 'anchored') {
            const startedAt = ship.arrivingStartedAt || now;
            if (now - startedAt > INBOUND_DURATION_MS * 2) {
                state.ships.delete(id);
            }
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
            state.ships.delete(id);
        }
    }

    for (const [id, batch] of state.batches) {
        const age = now - (batch.startedAt || now);
        if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS) {
            state.batches.delete(id);
        }
    }

    return state;
}

function easedDeparture(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
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
        if (typeof window !== 'undefined' && window.localStorage?.getItem('claudeVilleDebug') === '1') {
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
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        if (this.motionScale <= 0) this.storageTransfers.clear();
    }

    update(agents, dt = 16, now = Date.now()) {
        this.frame += (dt / 16) * this.motionScale;
        const events = collectGitEventsFromAgents(agents, {
            maxLabelChars: MAX_LABEL_CHARS,
            ellipsis: '…',
        });
        this.state = reduceHarborTrafficState(this.state, events, {
            now,
            motionScale: this.motionScale,
        });
        const dockLayout = buildDockSquadLayout(this.state);
        this._observeStorageTransfers(dockLayout, now);
        this._pendingRepoSummaries = pendingRepoSummariesFromDockSummaries(this._repoDockSummaries(dockLayout));
        this._observeHarborCrates(agents, events, now);
        this._observePeakDensity(now);
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

    enumerateDrawables(now = Date.now()) {
        const dockLayout = buildDockSquadLayout(this.state);
        const visualPackByShipId = buildDockedVisualPackMap(dockLayout);
        const repoSummaries = this._repoDockSummaries(dockLayout);
        const markers = this._repoQuayDrawables(repoSummaries);
        const markerByRepo = new Map();
        for (const marker of markers) {
            if (marker.payload?.type !== 'repo-quay') continue;
            const profile = marker.payload?.profile || trafficProfile(marker.payload?.project, marker.payload?.branch);
            const key = profile.key;
            if (key) markerByRepo.set(key, marker.payload);
            const baseKey = repoProfile(marker.payload?.project).key;
            if (baseKey && !markerByRepo.has(baseKey)) markerByRepo.set(baseKey, marker.payload);
        }
        // 3.6 — compute untethered projects (no upstream, >N docked commits).
        const untetheredProjects = this._computeUntetheredProjects(now);
        const dockedByRepo = new Map();
        const departing = [];

        for (const ship of this.state.ships.values()) {
            const drawable = this._shipDrawable(ship, now);
            if (!drawable) continue;
            if (drawable.payload.status === 'docked') {
                const key = trafficProfile(drawable.payload.project, drawable.payload.branch).key;
                const list = dockedByRepo.get(key) || [];
                list.push(drawable);
                dockedByRepo.set(key, list);
            } else {
                departing.push(drawable);
            }
        }

        const visible = [];
        const crateDrawnForKeys = new Set();
        for (const squad of dockLayout.squads) {
            const list = dockedByRepo.get(squad.key) || [];
            const byId = new Map(list.map(drawable => [drawable.payload.id, drawable]));
            // 4.17: precompute screen positions for each ship in the squad so
            // we can wire a `buntingNext` field onto each drawable (the next
            // sibling's anchor). Bunting renders only when squad.ships.length >= 2.
            const squadAnchors = squad.ships
                .map(ship => ({ id: ship.id, meta: dockLayout.byShipId.get(ship.id), pack: visualPackByShipId.get(ship.id) }))
                .filter(entry => entry.meta && entry.pack);
            for (const ship of squad.ships) {
                const pack = visualPackByShipId.get(ship.id);
                if (!pack) continue;
                const drawable = byId.get(ship.id);
                const meta = dockLayout.byShipId.get(ship.id);
                if (!drawable || !meta) continue;
                drawable.payload.x = meta.x;
                drawable.payload.y = meta.y;
                drawable.payload.repoDockIndex = meta.repoDockIndex;
                drawable.payload.repoDockCount = meta.repoDockCount;
                drawable.payload.repoTotalDockCount = meta.repoTotalDockCount;
                drawable.payload.repoDockVisibleCount = pack.visibleCount || meta.repoDockVisibleCount;
                drawable.payload.squadKey = meta.squadKey;
                drawable.payload.squadIndex = meta.squadIndex;
                drawable.payload.squadCount = meta.squadCount;
                drawable.payload.squadShipIndex = Number.isFinite(Number(pack.visualIndex))
                    ? Number(pack.visualIndex)
                    : meta.squadShipIndex;
                drawable.payload.squadShipCount = pack.visibleCount || meta.squadShipCount;
                drawable.payload.squadDensity = meta.squadDensity;
                drawable.payload.compactCommitLabel = meta.compactCommitLabel || pack.visualPackSize > 1;
                drawable.payload.showCommitLabel = pack.visualPackSize > 1 ? false : meta.showCommitLabel;
                drawable.payload.waitingZone = meta.waitingZone;
                drawable.payload.zoneSquadIndex = meta.zoneSquadIndex;
                drawable.payload.anchorageName = meta.anchorageName;
                drawable.payload.anchorageIndex = meta.anchorageIndex;
                drawable.payload.formationColumn = meta.column;
                drawable.payload.formationRow = meta.row;
                drawable.payload.visualPackSize = pack.visualPackSize;
                drawable.payload.visualPackStartIndex = pack.visualPackStartIndex;
                drawable.payload.visualPackEndIndex = pack.visualPackEndIndex;
                drawable.payload.visualPackHiddenCount = pack.visualPackHiddenCount;
                const transfer = this._storageTransferPosition(ship.id, meta, now);
                if (transfer) {
                    drawable.payload.x = transfer.x;
                    drawable.payload.y = transfer.y;
                    drawable.payload.tailX = transfer.tailX;
                    drawable.payload.tailY = transfer.tailY;
                    drawable.payload.storageTransferProgress = transfer.progress;
                    drawable.payload.storageTransfer = transfer.progress < 1;
                }
                drawable.payload.harborCrate = !crateDrawnForKeys.has(squad.key)
                    ? this.harborCrates.get(squad.key) || null
                    : null;
                if (drawable.payload.harborCrate) crateDrawnForKeys.add(squad.key);
                // 3.6 — mark flagship of an untethered project so renderer can draw broken-rope chevron.
                if (meta.squadShipIndex === 0 && untetheredProjects.has(String(drawable.payload.project || 'unknown'))) {
                    drawable.payload.untetheredFlag = true;
                }
                // 4.17: bunting neighbor anchor (next docked ship in the same
                // squad). Read by _drawShip to draw a thin arc between the two
                // adjacent ships when squadAnchors.length >= 2.
                const visibleAnchorIndex = squadAnchors.findIndex(entry => entry.id === ship.id);
                if (squadAnchors.length >= 2 && visibleAnchorIndex >= 0 && visibleAnchorIndex < squadAnchors.length - 1) {
                    const next = squadAnchors[visibleAnchorIndex + 1];
                    if (next?.meta) {
                        drawable.payload.buntingNext = { x: next.meta.x, y: next.meta.y };
                    }
                }
                drawable.sortY = drawable.payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
                visible.push(drawable);
            }
        }

        departing.sort((a, b) => ((a.payload.departStartedAt || 0) - (b.payload.departStartedAt || 0))
            || ((a.payload.departSquadIndex || 0) - (b.payload.departSquadIndex || 0))
            || ((a.payload.eventTime || 0) - (b.payload.eventTime || 0))
            || a.payload.id.localeCompare(b.payload.id));
        const convoyGroups = new Map();
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
        for (const drawable of this._harborCrateDrawables(markerByRepo, crateDrawnForKeys)) {
            visible.push(drawable);
        }
        // 3.7 — single lagoon channel buoy at the Commit Lagoon → Harbor seam.
        const buoyDrawable = this._lagoonChannelBuoyDrawable(now);
        if (buoyDrawable) visible.push(buoyDrawable);

        const sorted = visible.sort((a, b) => a.sortY - b.sortY);
        // 3.6 — hover lore: snapshot ship positions in draw order for hit testing.
        this._shipHitEntries = sorted
            .filter(drawable => drawable.payload?.type === 'ship')
            .map(drawable => drawable.payload);
        return sorted;
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
        const subject = cleanCommitSubject(ship.label || '');
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
            // Count commits flowing toward the harbor via the lagoon.
            for (const other of this.state.ships.values()) {
                if (other.status === 'docked' && other.project === ship.project) activeCount += 1;
            }
            break;
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
                ts: now,
            },
        };
    }

    enumerateWakeDescriptors(now = Date.now()) {
        if (!this.state?.ships?.size) return [];
        const drawables = this.enumerateDrawables(now);
        const wakes = [];
        for (const item of drawables) {
            const drawable = item.payload;
            if (!drawable || drawable.type !== 'ship') continue;
            const shipClass = harborShipClass(drawable);
            const waterRegion = this._shipWaterRegion(drawable);
            if (drawable.storageTransfer && drawable.storageTransferProgress > 0.002 && drawable.storageTransferProgress < 1) {
                wakes.push({
                    type: 'departing',
                    x: drawable.x,
                    y: drawable.y,
                    tailX: drawable.tailX,
                    tailY: drawable.tailY,
                    alpha: Math.max(0.06, 0.14 * (1 - drawable.storageTransferProgress * 0.45)),
                    spread: (0.32 + drawable.storageTransferProgress * 0.52) * shipClass.wakeScale,
                    progress: drawable.storageTransferProgress,
                    waterRegion,
                    projectAccent: trafficProfile(drawable.project, drawable.branch).accent,
                });
                continue;
            }
            if (drawable.status === 'docked') {
                const pulse = this.motionScale > 0
                    ? 0.55 + 0.25 * Math.sin(this.frame * 0.08 + drawable.berthIndex)
                    : 0.58;
                wakes.push({
                    type: 'docked',
                    x: drawable.x,
                    y: drawable.y,
                    alpha: 0.08 + pulse * 0.045,
                    radiusX: 26 * shipClass.wakeScale,
                    radiusY: 12 * shipClass.wakeScale,
                    waterRegion,
                    projectAccent: trafficProfile(drawable.project, drawable.branch).accent,
                });
                continue;
            }
            if (drawable.status === 'departing' && drawable.progress > 0.002 && drawable.progress < 0.94) {
                wakes.push({
                    type: 'departing',
                    x: drawable.x,
                    y: drawable.y,
                    tailX: drawable.tailX,
                    tailY: drawable.tailY,
                    alpha: Math.max(0.05, 0.18 * (1 - drawable.progress)),
                    spread: (0.35 + drawable.progress * 0.75) * shipClass.wakeScale,
                    progress: drawable.progress,
                    waterRegion,
                    projectAccent: trafficProfile(drawable.project, drawable.branch).accent,
                });
            }
        }
        return wakes;
    }

    _shipWaterRegion(ship = {}) {
        if (Number.isFinite(Number(ship.storageTransferProgress))) {
            const progress = Number(ship.storageTransferProgress);
            if (progress < 0.24) return 'harbor';
            if (progress > 0.74) return 'lagoon';
            return 'sea';
        }
        if (isCommitLagoonZone(ship.departWaterZone || ship.waitingZone)) {
            return ship.status === 'departing' && Number(ship.progress || 0) > 0.72
                ? 'sea'
                : 'lagoon';
        }
        return 'harbor';
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
            };
            summary.count += 1;
            if (ship.pushStatus === 'failed') summary.failedCount += 1;
            summary.x += pos.x;
            summary.y += pos.y;
            summary.latestEventTime = Math.max(summary.latestEventTime, ship.eventTime || 0);
            summary.waitingZone = waitingZone;
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
                    quayName: isCommitLagoonZone(waitingZone) ? 'Commit Lagoon' : QUAY_GROUPS[quayIndex]?.name || 'Quay',
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
            this._drawFinaleEffect(ctx, effect);
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
        const width = Math.min(500, Math.max(344, Math.max(title.length, detail.length) * 7.2 + 76));
        const height = 82;
        const origin = this._batchOrigin(summary);
        const screen = camera?.worldToScreen
            ? camera.worldToScreen(origin.x, origin.y)
            : { x: canvas.width - width - 18, y: 72 };
        const minimapW = 150 + 28;
        const minimapH = 150 + 28;
        const maxX = canvas.width - width - 14;
        const maxY = canvas.height - height - 14;
        let x = Math.round(Math.max(14, Math.min(maxX, screen.x - width / 2)));
        let y = Math.round(Math.max(14, Math.min(maxY, screen.y - height - 26)));
        if (x + width > canvas.width - minimapW && y + height > canvas.height - minimapH) {
            y = Math.max(14, canvas.height - minimapH - height - 12);
        }

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.shadowColor = 'rgba(14, 8, 5, 0.46)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = style.panel;
        ctx.fillRect(x, y, width, height);
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(255, 224, 150, 0.34)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1.5, y - 1.5, width + 3, height + 3);
        ctx.strokeStyle = style.panelBorder || style.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        ctx.fillStyle = style.accent;
        ctx.fillRect(x, y, 7, height);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + 9, y + 5, 4, height - 10);
        ctx.fillStyle = 'rgba(255, 239, 185, 0.13)';
        ctx.fillRect(x + 15, y + 6, width - 22, 1);
        ctx.fillRect(x + 15, y + height - 7, width - 22, 1);

        ctx.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fff0b8';
        this._fillReadableText(ctx, shortGitLabel(title, 56, '…'), x + 26, y + 14);
        this._drawRepoLabelIcon(ctx, x + 27, y + 44, 8, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        this._fillReadableText(ctx, shortGitLabel(detail, 60, '…'), x + 38, y + 38);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.62)';
        ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        this._fillReadableText(ctx, (PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown).shortLabel.toUpperCase(), x + 26, y + 62);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.42)';
        ctx.fillRect(x + 94, y + 61, Math.max(34, width - 114), 1);
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
            const dockTile = ship.arrivingKind === 'fetch'
                ? (ship.inboundRoadsteadTile || { tileX: 38.05, tileY: 13.15 })
                : startTile;
            const fakeShipForRoute = { ...ship, departFromTile: dockTile };
            const fwdRoute = composeWaterRouteTiles(dockTile, fakeShipForRoute, this.waterRouteData)
                .map(point => toWorld(point.tileX, point.tileY));
            const reversedRoute = [...fwdRoute].reverse();
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

    _drawShip(ctx, ship, zoom) {
        // 3.2 — inbound ships fade in over the first 8s of approach.
        let alpha;
        if (ship.status === 'departing') {
            alpha = this._departureAlpha(ship);
        } else if (ship.status === 'arriving' || ship.status === 'anchored') {
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            alpha = Math.max(0, Math.min(1, elapsed / INBOUND_FADE_IN_MS));
        } else {
            alpha = 1;
        }
        if (alpha <= 0.02) return;
        const profile = trafficProfile(ship.project, ship.branch);
        const shipClass = harborShipClass(ship);

        // Ship wakes are exported through enumerateWakeDescriptors() so the
        // water layer can render them beneath harbor traffic and buildings.

        ctx.save();
        // 3.6 — amended commit flash hull in repo accent for 400ms.
        const amendFlashAt = Number(ship.amendFlashAt) || 0;
        const amendFlashElapsed = amendFlashAt ? Math.max(0, Date.now() - amendFlashAt) : Infinity;
        const flashing = amendFlashElapsed < 400;
        // 3.1 — force-push: ship lists and sinks in last 4s of departure.
        let listAngle = 0;
        let sinkY = 0;
        let forceSinkAlpha = alpha;
        if (this.motionScale > 0 && ship.status === 'departing' && ship.pushForce === true) {
            const departMs = Math.max(1, Number(ship.departMsOverride) || FORCE_DEPARTURE_MS);
            const sinkWindow = Math.min(4000, departMs * 0.5);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const sinkProgress = Math.max(0, Math.min(1, (elapsed - (departMs - sinkWindow)) / sinkWindow));
            if (sinkProgress > 0) {
                listAngle = (4 + 4 * sinkProgress) * (Math.PI / 180); // 4° → 8°
                sinkY = 16 * sinkProgress;
                forceSinkAlpha = Math.max(0, alpha * (1 - sinkProgress * 0.55));
            }
        }
        if (listAngle !== 0 || sinkY !== 0) {
            ctx.translate(ship.x, ship.y);
            ctx.rotate(listAngle);
            ctx.translate(-ship.x, -ship.y + sinkY);
        }
        if (flashing && this.motionScale > 0) {
            ctx.save();
            ctx.globalAlpha = 0.42 * (1 - amendFlashElapsed / 400);
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = profile.accent;
            ctx.beginPath();
            ctx.ellipse(ship.x, ship.y - 2, 26 * (shipClass.scale || 1), 14 * (shipClass.scale || 1), 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        if (this.sprites) {
            this._drawShipSprite(ctx, ship, forceSinkAlpha, shipClass);
        } else {
            this._drawFallbackBoat(ctx, ship.x, ship.y, forceSinkAlpha, shipClass, profile);
        }
        this._drawShipClassOverlay(ctx, ship, forceSinkAlpha, profile, shipClass);
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

        // Mist fade through last 800ms of departure.
        if (this.motionScale > 0 && ship.status === 'departing') {
            const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const mistStart = departMs - MIST_FADE_MS;
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
        if (ship.status === 'docked' && ship.pushStatus === 'failed') {
            this._drawFailedPushMark(ctx, ship, zoom, shipClass);
        }
        // Rejected ships docked back with caution flag overlay.
        if (ship.status === 'docked' && ship.pushStatus === 'rejected') {
            this._drawRejectedCautionFlag(ctx, ship, zoom, shipClass);
        }
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

    _drawShipSprite(ctx, ship, alpha, shipClass = harborShipClass(ship)) {
        const scale = Math.max(0.5, Number(shipClass.scale || 1));
        const spriteId = shipClass.spriteId && this.sprites?.assets?.has?.(shipClass.spriteId)
            ? shipClass.spriteId
            : SHIP_SPRITE_ID;
        if (Math.abs(scale - 1) < 0.01) {
            this.sprites.drawSprite(ctx, spriteId, ship.x, ship.y, { alpha });
            return;
        }
        ctx.save();
        ctx.translate(Math.round(ship.x), Math.round(ship.y));
        ctx.scale(scale, scale);
        this.sprites.drawSprite(ctx, spriteId, 0, 0, { alpha });
        ctx.restore();
    }

    _drawShipClassOverlay(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        if (shipClass.spriteId && this.sprites?.assets?.has?.(shipClass.spriteId)) {
            this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass);
            return;
        }

        const scale = Math.max(0.5, Number(shipClass.scale || 1));
        const cargoRows = Math.max(0, Number(shipClass.cargoRows || 0));
        const mastCount = Math.max(1, Number(shipClass.mastCount || 1));
        const bob = this.motionScale > 0 ? Math.sin(this.frame * 0.08 + ship.berthIndex) * 0.8 : 0;
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

        this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass);

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

    _drawShipTierBadge(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        if (!shipClass.badge) return;
        const scale = Math.max(0.85, Number(shipClass.scale || 1));
        const bob = this.motionScale > 0 ? Math.sin(this.frame * 0.08 + ship.berthIndex) * 0.8 : 0;
        const badge = shipClass.badge;
        const badgeW = Math.max(18, badge.length * 6 + 8) * scale;
        const badgeH = 12 * scale;
        const x = Math.round(ship.x - badgeW / 2);
        const y = Math.round(ship.y - (40 + Math.max(0, Number(shipClass.labelLift || 0)) + bob) * scale);
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        ctx.fillStyle = 'rgba(24, 33, 36, 0.92)';
        ctx.fillRect(x, y, Math.round(badgeW), Math.round(badgeH));
        ctx.strokeStyle = profile.accent;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(badgeW) - 1, Math.round(badgeH) - 1);
        ctx.fillStyle = '#f4df9f';
        ctx.font = `${Math.max(8, Math.round(9 * scale))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge, Math.round(ship.x), Math.round(y + badgeH / 2 + 0.5));
        ctx.restore();
    }

    _drawHarborCrate(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const bob = this.motionScale > 0 ? Math.sin(this.frame * 0.08 + ship.berthIndex) * 1.2 : 0;
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
        const elapsed = Number.isFinite(ship.elapsed) ? ship.elapsed : ship.progress * DEPARTURE_MS;
        const fadeStart = DEPARTURE_MS + FADE_DELAY_MS;
        if (elapsed <= fadeStart) return 1;
        return Math.max(0, Math.min(1, 1 - (elapsed - fadeStart) / EXIT_FADE_MS));
    }

    _drawDockedShipWake(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch)) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale > 0
            ? 0.55 + 0.25 * Math.sin(this.frame * 0.08 + ship.berthIndex)
            : 0.62;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = profile.accent;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 4 * s), 30 * s, 16 * s, -0.18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = profile.glow;
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 5 * s), 26 * s, 13 * s, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawWake(ctx, ship, alpha = 1) {
        const phase = this.frame * 0.18 + ship.berthIndex;
        const dx = ship.x - (ship.tailX ?? ship.x - 1);
        const dy = ship.y - (ship.tailY ?? ship.y);
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const px = -uy;
        const py = ux;
        ctx.save();
        ctx.globalAlpha = Math.max(0.12, 0.34 * (1 - ship.progress)) * alpha;
        ctx.strokeStyle = 'rgba(198, 236, 241, 0.7)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const offset = i * 8 + Math.sin(phase + i) * 2;
            const spread = 4 + i * 2;
            const startBack = 14 + offset;
            const endBack = 30 + offset;
            ctx.beginPath();
            ctx.moveTo(ship.x - ux * startBack + px * spread, ship.y - uy * startBack + py * spread);
            ctx.quadraticCurveTo(
                ship.x - ux * ((startBack + endBack) / 2) + px * Math.sin(phase + i) * 3,
                ship.y - uy * ((startBack + endBack) / 2) + py * Math.sin(phase + i) * 3,
                ship.x - ux * endBack - px * spread,
                ship.y - uy * endBack - py * spread
            );
            ctx.stroke();
        }
        ctx.restore();
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

    // 3.1 — yellow chevron banner above the flagship's flag for --force-with-lease.
    _drawForceLeaseBanner(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (45 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.fillStyle = '#ffd34a';
        ctx.strokeStyle = 'rgba(40, 28, 8, 0.78)';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 11 * s, y + 4 * s);
        ctx.lineTo(x, y + 8 * s);
        ctx.lineTo(x + 5 * s, y + 4 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // 3.1 — thin yellow underline beneath the flag for --force-if-includes.
    _drawForceIncludesUnderline(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (16 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.fillStyle = '#ffd34a';
        ctx.fillRect(x, y, Math.max(2, Math.round(11 * s)), Math.max(1, Math.round(1.5 * s)));
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

    // Sea-mist fade gradient at the ship's last position.
    _drawMistFade(ctx, x, y, t) {
        const radius = 38 + t * 18;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, radius);
        grd.addColorStop(0, `rgba(220, 224, 230, ${0.62 * t})`);
        grd.addColorStop(0.6, `rgba(214, 222, 228, ${0.32 * t})`);
        grd.addColorStop(1, 'rgba(214, 222, 228, 0)');
        ctx.save();
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.ellipse(x, y, radius, radius * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Secondary pennon hoisted on flagship/dreadnought at cast-off end.
    _drawSecondaryPennon(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (52 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.fillStyle = profile.accent;
        ctx.beginPath();
        ctx.moveTo(x + 2 * s, y);
        ctx.lineTo(x + 8 * s, y + 3 * s);
        ctx.lineTo(x + 2 * s, y + 6 * s);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // Yellow caution flag overlay on a rejected ship.
    _drawRejectedCautionFlag(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (38 + (shipClass.flagOffsetY || 0)) * s);
        const pulse = this.motionScale > 0
            ? 0.62 + 0.22 * Math.sin(this.frame * 0.18 + ship.berthIndex)
            : 0.72;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.fillStyle = PUSH_STATUS_STYLE.rejected.accent;
        ctx.strokeStyle = PUSH_STATUS_STYLE.rejected.panelBorder || '#ff755d';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10 * s, y + 4 * s);
        ctx.lineTo(x, y + 8 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // Red collision flare burst at the boomerang turn point.
    _drawCollisionFlare(ctx, x, y, t) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.4, 0.95 * (1 - t));
        ctx.strokeStyle = '#ff5a3c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y - 12, 8 + t * 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ff7a55';
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const r = 10 + t * 14;
            ctx.fillRect(Math.round(x + Math.cos(angle) * r), Math.round(y - 12 + Math.sin(angle) * r * 0.5), 2, 2);
        }
        ctx.restore();
    }

    // 3.6 — broken-rope chevron above the flag for untethered (no remote).
    _drawUntetheredFlag(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (47 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.strokeStyle = '#d6dadf';
        ctx.lineWidth = Math.max(1, Math.round(1.3 * s));
        // broken-rope chevron: two segments with a gap between
        ctx.beginPath();
        ctx.moveTo(x - 4 * s, y + 4 * s);
        ctx.lineTo(x + 1 * s, y);
        ctx.lineTo(x + 3 * s, y + 2 * s);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 6 * s, y + 5 * s);
        ctx.lineTo(x + 9 * s, y + 1 * s);
        ctx.lineTo(x + 13 * s, y + 4 * s);
        ctx.stroke();
        ctx.restore();
    }

    // 3.6 — checkered black-and-white band overlay for detached HEAD.
    _drawDetachedHeadBand(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (15 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (27 + (shipClass.flagOffsetY || 0)) * s);
        const cell = Math.max(1, Math.round(2 * s));
        ctx.save();
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = i % 2 === 0 ? '#1a1a1a' : '#f4f0e6';
            ctx.fillRect(x + i * cell, y, cell, cell);
        }
        ctx.restore();
    }

    // 3.6 — small superscript on the flag indicating amend count (²).
    _drawAmendSuperscript(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const count = Math.max(1, Number(ship.amendCount || 0));
        if (count <= 0) return;
        const labels = ['', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
        const text = count > 1 ? (labels[count] || `^${count}`) : '¹';
        const x = Math.round(ship.x + (26 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (33 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.fillStyle = '#f6cf60';
        ctx.font = `${Math.max(7, Math.round(8 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        this._fillReadableText(ctx, text, x, y);
        ctx.restore();
    }

    // 3.2 — small crates ride along inbound ships proportional to incoming commit count.
    _drawInboundCrates(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const count = Math.min(4, Math.max(1, Number(ship.inboundCargoCount || 0)));
        const baseY = Math.round(ship.y - 14 * (shipClass.scale || 1));
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
        const pulse = (!muted && this.motionScale > 0)
            ? 0.55 + 0.40 * (0.5 + 0.5 * Math.sin(this.frame * 0.16))
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
        // Glow halo when active.
        if (!muted) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.32 * pulse;
            const grd = ctx.createRadialGradient(x, y - 7 * s, 0, x, y - 7 * s, 22 * s);
            grd.addColorStop(0, accent);
            grd.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grd;
            ctx.beginPath();
            ctx.arc(x, y - 7 * s, 22 * s, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
    }

    // 3.4 — public API: lighthouse beam (WU3-B) consumes this to drive its strobe.
    // Returns the most informative signal for the current tick.
    getActivePushSignal(now = Date.now()) {
        // 1. Active failed push → strobe red briefly.
        for (const batch of this.state.batches.values()) {
            const status = batch.status || 'unknown';
            if (status !== 'failed') continue;
            const ts = batch.statusUpdatedAt || batch.eventTime || batch.startedAt || now;
            if (now - ts > PUSH_SIGNAL_EXPIRY_MS) continue;
            const profile = trafficProfile(batch.project, batch.branch);
            return {
                state: 'failed',
                accent: profile.accent || PUSH_STATUS_STYLE.failed.accent,
                ts,
                expiresAt: ts + PUSH_SIGNAL_EXPIRY_MS,
            };
        }
        // 2. Active rejected push → strobe yellow briefly.
        for (const batch of this.state.batches.values()) {
            const status = batch.status || 'unknown';
            if (status !== 'rejected') continue;
            const ts = batch.statusUpdatedAt || batch.eventTime || batch.startedAt || now;
            if (now - ts > PUSH_SIGNAL_EXPIRY_MS) continue;
            const profile = trafficProfile(batch.project, batch.branch);
            return {
                state: 'rejected',
                accent: profile.accent || PUSH_STATUS_STYLE.rejected.accent,
                ts,
                expiresAt: ts + PUSH_SIGNAL_EXPIRY_MS,
            };
        }
        // 3. Departing squad → sweep beam from origin to departure tile in the squad accent.
        let activeDeparting = null;
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'departing') continue;
            if (!activeDeparting || (ship.departStartedAt || 0) > (activeDeparting.departStartedAt || 0)) {
                activeDeparting = ship;
            }
        }
        if (activeDeparting) {
            const profile = trafficProfile(activeDeparting.project, activeDeparting.branch);
            const originTile = this._shipStartTile(activeDeparting);
            const route = this._shipRouteTiles(activeDeparting);
            const departTile = route?.[route.length - 1] || originTile;
            return {
                state: 'departing',
                squadId: activeDeparting.batchId || activeDeparting.departEventId || activeDeparting.id || null,
                originTile: { tileX: originTile.tileX, tileY: originTile.tileY },
                departingTile: { tileX: departTile.tileX, tileY: departTile.tileY },
                accent: profile.accent,
                ts: activeDeparting.departStartedAt || now,
            };
        }
        // 4. Untethered (no remote) + lagoon non-empty for > 5min → steady caution.
        const untethered = this._computeUntetheredProjects(now);
        if (untethered.size > 0) {
            return { state: 'untethered' };
        }
        // 5. Unpushed commits sitting in the lagoon → gentle pulse.
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const meta = this._lastDockLayoutByShipId.get(ship.id);
            const inLagoon = isCommitLagoonZone(meta?.waitingZone || ship.waitingZone);
            if (inLagoon) return { state: 'pulsing' };
        }
        return { state: 'idle' };
    }

    _drawFailedPushMark(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale > 0
            ? 0.55 + Math.sin(this.frame * 0.16 + ship.berthIndex) * 0.18
            : 0.62;
        const lift = Math.max(0, Number(shipClass.labelLift || 0));
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = PUSH_STATUS_STYLE.failed.accent;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        const cx = Math.round(ship.x + (18 + (shipClass.flagOffsetX || 0) * 0.4) * s);
        const cy = Math.round(ship.y - (36 + lift) * s);
        ctx.beginPath();
        ctx.arc(cx, cy, 7 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 3 * s, cy - 3 * s);
        ctx.lineTo(cx + 3 * s, cy + 3 * s);
        ctx.moveTo(cx + 3 * s, cy - 3 * s);
        ctx.lineTo(cx - 3 * s, cy + 3 * s);
        ctx.stroke();
        ctx.restore();
    }

    _drawRepoFlag(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + (13 + (shipClass.flagOffsetX || 0)) * s);
        const y = Math.round(ship.y - (31 + (shipClass.flagOffsetY || 0)) * s);
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        ctx.fillStyle = 'rgba(17, 26, 30, 0.82)';
        ctx.fillRect(x, y, Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(14 * s)));
        ctx.fillStyle = profile.accent;
        ctx.beginPath();
        ctx.moveTo(x + 2 * s, y + 1 * s);
        ctx.lineTo(x + 13 * s, y + 5 * s);
        ctx.lineTo(x + 2 * s, y + 9 * s);
        ctx.closePath();
        ctx.fill();
        if (profile.isBranchVariant && profile.baseAccent) {
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(x + 3 * s, y + 6 * s, Math.max(2, Math.round(9 * s)), Math.max(1, Math.round(2 * s)));
        }
        ctx.restore();
    }

    // 4.17: procedural repo heraldry shield on squad flagship. Drawn in canvas
    // (no sprite/asset) so we can tint by repo hue at render time. Height ~24 px
    // in world units; clamped tightly above the ship so it doesn't overlap the
    // commit pennant which sits to the side and below.
    _drawRepoShield(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const w = 18 * s;
        const h = 24 * s;
        const cx = Math.round(ship.x);
        const top = Math.round(ship.y - (44 + (shipClass.flagOffsetY || 0) * 0.6) * s);
        const left = cx - w / 2;
        const right = cx + w / 2;
        const pointY = top + h;
        const shoulderY = top + h * 0.72;

        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.94;
        // Drop shadow behind the shield for legibility against busy water.
        ctx.fillStyle = 'rgba(8, 12, 16, 0.55)';
        ctx.beginPath();
        ctx.moveTo(left + 1, top + 2);
        ctx.lineTo(right + 1, top + 2);
        ctx.lineTo(right + 1, shoulderY + 2);
        ctx.lineTo(cx + 1, pointY + 2);
        ctx.lineTo(left + 1, shoulderY + 2);
        ctx.closePath();
        ctx.fill();

        // Shield body filled with the repo accent.
        ctx.fillStyle = profile.accent || '#f6d384';
        ctx.beginPath();
        ctx.moveTo(left, top);
        ctx.lineTo(right, top);
        ctx.lineTo(right, shoulderY);
        ctx.lineTo(cx, pointY);
        ctx.lineTo(left, shoulderY);
        ctx.closePath();
        ctx.fill();

        // Outer rim — gold on base repos, branch accent on variants.
        ctx.strokeStyle = profile.isBranchVariant && profile.baseAccent
            ? profile.baseAccent
            : 'rgba(255, 240, 184, 0.88)';
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.stroke();

        // Branch variant: thin sash band across the bottom (the band sits just
        // above the point so the chevron still reads as a shield).
        if (profile.isBranchVariant && profile.baseAccent) {
            const bandTop = top + h * 0.50;
            const bandH = Math.max(1, Math.round(3 * s));
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(left + 1.5 * s, bandTop, w - 3 * s, bandH);
        }

        // Short repo label in the upper third of the shield.
        const shortName = String(profile.shortName || profile.name || '').slice(0, 3).toUpperCase();
        if (shortName) {
            ctx.fillStyle = profile.labelText || 'rgba(20, 14, 10, 0.94)';
            ctx.font = `${Math.max(7, Math.round(8 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            this._applyReadableTextShadow(ctx);
            ctx.fillText(shortName, cx, top + h * 0.34, w - 4 * s);
        }
        ctx.restore();
    }

    // 4.17: thin static bunting arc between two adjacent docked ships in the
    // same squad. No animation — reduced-motion clients get the same visual.
    _drawSquadBunting(ctx, ship, neighbor, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch)) {
        if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) return;
        const s = 1 / Math.max(1, zoom || 1);
        const liftA = 28 * s; // anchor lift above each ship's deck
        const liftB = 28 * s;
        const ax = ship.x;
        const ay = ship.y - liftA;
        const bx = neighbor.x;
        const by = neighbor.y - liftB;
        const sag = Math.min(14 * s, Math.hypot(bx - ax, by - ay) * 0.18);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2 + sag;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.82;
        ctx.strokeStyle = profile.accent || '#f6d384';
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mx, my, bx, by);
        ctx.stroke();
        // Small midpoint pennant for a flag-line feel.
        ctx.fillStyle = profile.isBranchVariant && profile.baseAccent
            ? profile.baseAccent
            : (profile.accent || '#f6d384');
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - 3 * s, my + 5 * s);
        ctx.lineTo(mx + 3 * s, my + 5 * s);
        ctx.closePath();
        ctx.fill();
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
            const width = Math.max(36 * s, label.length * 6.2 * s + 12 * s);
            const labelX = Math.round(ship.x - width / 2);
            const labelY = Math.round(y - 17 * s);
            ctx.fillStyle = 'rgba(24, 42, 39, 0.88)';
            ctx.fillRect(labelX, labelY, Math.round(width), Math.round(13 * s));
            ctx.strokeStyle = profile.accent || '#f6d384';
            ctx.strokeRect(labelX + 0.5, labelY + 0.5, Math.round(width) - 1, Math.round(13 * s) - 1);
            ctx.fillStyle = profile.labelText || '#fff0b8';
            ctx.font = `${Math.max(7, Math.round(8 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            this._fillReadableText(ctx, label, Math.round(ship.x), Math.round(labelY + 7 * s), Math.max(12, width - 4 * s));
        }
        ctx.restore();
    }

    _drawCommitPennant(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const statusStyle = PUSH_STATUS_STYLE[ship.pushStatus] || null;
        const accent = ship.pushStatus === 'failed' && statusStyle ? statusStyle.accent : profile.accent;
        const compact = Boolean(ship.compactCommitLabel);
        const localIndex = Number.isFinite(Number(ship.squadShipIndex))
            ? Math.max(0, Number(ship.squadShipIndex))
            : Math.max(0, Number(ship.repoDockIndex || 0));
        const visibleCount = Math.max(1, Number(ship.repoDockVisibleCount || 1));
        const lane = visibleCount > 1 ? Math.max(-0.72, Math.min(0.72, localIndex - (visibleCount - 1) / 2)) : 0;
        const labelLift = Math.max(0, Number(shipClass.labelLift || 0));
        const miniX = Math.round(ship.x - (22 + Math.min(12, labelLift * 0.3)) * s);
        const miniY = Math.round(ship.y - (31 + labelLift * 0.55) * s);

        const label = shortGitLabel(commitPennantLabel(ship), compact ? 10 : 12, '…');
        const textSize = Math.max(7, Math.round(8 * s));
        const maxWidth = compact ? 58 * s : 70 * s;
        const width = Math.max(42 * s, Math.min(maxWidth + 12 * s, label.length * textSize * 0.62 + 22 * s));
        const x = Math.round(ship.x - width / 2 + lane * 34 * s);
        const labelTier = compact ? localIndex % 4 : localIndex % 3;
        const y = Math.round(ship.y + (22 + labelTier * 10 + Math.min(8, labelLift * 0.18)) * s);
        const height = 15 * s;
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.9)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = accent;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        if (profile.isBranchVariant && profile.baseAccent) {
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(x, y, Math.max(1, Math.round(2 * s)), Math.round(height));
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + (profile.isBranchVariant ? Math.max(1, Math.round(2 * s)) : 0), y, Math.max(2, Math.round(4 * s)), Math.round(height));
        this._drawRepoLabelIcon(ctx, x + 8 * s, y + height / 2, 6 * s, profile);
        ctx.fillStyle = ship.pushStatus === 'failed' && statusStyle ? accent : (profile.labelText || accent);
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        this._fillReadableText(ctx, label, Math.round(x + 15 * s), Math.round(y + height / 2 + 0.5), Math.max(12, width - 18 * s));
        ctx.fillStyle = accent;
        ctx.fillRect(miniX, miniY, Math.max(1, Math.round(3 * s)), Math.max(1, Math.round(11 * s)));
        ctx.restore();
    }

    // 3.6 — hover lore: cargo label above the hovered ship carrying the commit subject.
    _drawHoverCargoLabel(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const subject = cleanCommitSubject(ship.label || '');
        const label = shortGitLabel(subject || `commit ${commitPennantLabel(ship)}`, 36, '…');
        if (!label) return;
        const s = 1 / Math.max(1, zoom || 1);
        const lift = Math.max(0, Number(shipClass.labelLift || 0));
        const textSize = Math.max(8, Math.round(9 * s));
        const height = Math.round(17 * s);
        const width = Math.round(Math.max(54 * s, label.length * textSize * 0.62 + 26 * s));
        const x = Math.round(ship.x - width / 2);
        const y = Math.round(ship.y - (56 + lift) * s);
        ctx.save();
        ctx.globalAlpha = Math.min(1, 0.96 * alpha);
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.92)';
        ctx.fillRect(x, y, width, height);
        ctx.strokeStyle = profile.accent;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        this._drawRepoLabelIcon(ctx, x + 9 * s, y + height / 2, 6 * s, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        this._fillReadableText(ctx, label, Math.round(x + 17 * s), Math.round(y + height / 2 + 0.5), Math.max(12, width - 22 * s));
        // Short stem tying the cargo label to its ship.
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(ship.x - s), y + height, Math.max(1, Math.round(2 * s)), Math.round(6 * s));
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
        ctx.globalCompositeOperation = (effect.status === 'failed' || effect.status === 'rejected' || effect.status === 'cancelled' || forceSink) ? 'source-over' : 'screen';
        ctx.globalAlpha = Math.max(0.18, alpha);
        ctx.strokeStyle = style.accent;
        ctx.fillStyle = style.glow;
        ctx.lineWidth = 2;

        if (effect.status === 'failed' || effect.status === 'rejected') {
            const radius = 20 + wave * 12;
            ctx.beginPath();
            ctx.arc(effect.x, effect.y - 24, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(effect.x - 11, effect.y - 35);
            ctx.lineTo(effect.x + 11, effect.y - 13);
            ctx.moveTo(effect.x + 11, effect.y - 35);
            ctx.lineTo(effect.x - 11, effect.y - 13);
            ctx.stroke();
        } else if (effect.status === 'cancelled') {
            // 5.11 — soft grey expanding ring, low alpha. Reduced-motion: a single
            //        static ring at mid radius.
            const staticMotion = this.motionScale === 0;
            const radius = staticMotion ? 22 : (16 + progress * 18);
            ctx.globalAlpha = Math.max(0.12, alpha * 0.55);
            ctx.beginPath();
            ctx.arc(effect.x, effect.y - 24, radius, 0, Math.PI * 2);
            ctx.stroke();
        } else if (forceSink) {
            // 3.1 — whirlpool: concentric inward-spiraling arcs with red spray.
            ctx.strokeStyle = '#3a4f6a';
            ctx.lineWidth = 2;
            const spirals = this.motionScale === 0 ? 1 : 3;
            for (let i = 0; i < spirals; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress - i * 0.18));
                const ring = Math.max(6, 48 - ringProgress * 36 + i * 6);
                ctx.globalAlpha = Math.max(0.10, alpha * (1 - i * 0.22));
                ctx.beginPath();
                ctx.ellipse(effect.x, effect.y, ring, ring * 0.36, -0.22 + ringProgress * 0.6, 0, Math.PI * 2);
                ctx.stroke();
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
                ctx.beginPath();
                ctx.ellipse(effect.x, effect.y, ring, ring * 0.34, -0.22, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = Math.max(0.10, alpha * 0.55);
            ctx.beginPath();
            ctx.moveTo(summary.x - 8, summary.y - 72);
            ctx.lineTo(effect.x + 72, effect.y - 18);
            ctx.lineTo(effect.x - 18, effect.y + 12);
            ctx.closePath();
            ctx.fill();

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
        ctx.fillStyle = style.accent;
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(style.shortLabel, Math.round(effect.x), Math.round(effect.y - 52));
        ctx.restore();
    }

    _drawClusterTag(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const label = `+${payload.count}`;
        const width = Math.max(18, label.length * 6 + 8) * s;
        const height = 13 * s;
        const x = payload.x - width / 2;
        const y = payload.y - 34 * s;

        ctx.save();
        ctx.fillStyle = 'rgba(27, 43, 48, 0.86)';
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.82)';
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = '#f2d36b';
        ctx.font = `${Math.max(8, Math.round(10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(payload.x), Math.round(y + height / 2));
        ctx.restore();
    }

    _drawCommitLagoonSign(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const profile = payload.profile || trafficProfile(payload.project, payload.branch);
        const count = Math.max(1, Number(payload.count || 1));
        const detail = `${shortGitLabel(payload.repoName || trafficLabel(payload.project, payload.branch), 20, '…')} (${count})`;
        const title = 'COMMIT LAGOON';
        const width = Math.max(132 * s, Math.min(204 * s, Math.max(title.length, detail.length) * 6.2 * s + 34 * s));
        const height = 36 * s;
        const x = Math.round(payload.x - width / 2);
        const y = Math.round(payload.y - height / 2);

        ctx.save();
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = 'rgba(50, 42, 25, 0.92)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = 'rgba(247, 214, 123, 0.86)';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + Math.round(5 * s), y + Math.round(5 * s), Math.max(2, Math.round(4 * s)), Math.round(height - 10 * s));
        ctx.fillStyle = '#f4df9f';
        ctx.font = `${Math.max(8, Math.round(10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this._fillReadableText(ctx, title, Math.round(payload.x + 2 * s), Math.round(y + 11 * s));
        this._drawRepoLabelIcon(ctx, x + 15 * s, y + 25 * s, 7 * s, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.font = `${Math.max(7, Math.round(8 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        this._fillReadableText(ctx, detail, Math.round(x + 23 * s), Math.round(y + 25 * s), Math.max(24, width - 28 * s));
        ctx.restore();
    }

    _drawRepoQuayMarker(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const profile = payload.profile || trafficProfile(payload.project, payload.branch);
        const count = Math.max(1, Number(payload.count || 1));
        const name = shortGitLabel(trafficLabel(payload.project, payload.branch), count >= 100 ? 18 : 20, '…');
        const label = `${name} (${count})`;
        const textSize = Math.max(7, Math.round(9 * s));
        const width = Math.max(104 * s, Math.min(190 * s, label.length * textSize * 0.58 + 30 * s));
        const height = 18 * s;
        const x = Math.round(payload.x - width / 2);
        const y = Math.round(payload.y - height / 2);
        const failed = Number(payload.failedCount || 0) > 0;

        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = profile.panel || 'rgba(20, 30, 34, 0.88)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.panelBorder || profile.accent);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        if (profile.isBranchVariant && profile.baseAccent) {
            ctx.fillStyle = profile.baseAccent;
            ctx.fillRect(x, y, Math.max(2, Math.round(3 * s)), Math.round(height));
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + (profile.isBranchVariant ? Math.max(2, Math.round(3 * s)) : 0), y, Math.max(3, Math.round(5 * s)), Math.round(height));

        ctx.globalAlpha = 1;
        this._drawRepoLabelIcon(ctx, x + 11 * s, y + height / 2, 7 * s, profile);
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.labelText || profile.accent);
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        this._fillReadableText(ctx, label, Math.round(x + 20 * s), Math.round(y + height / 2 + 0.5), Math.max(24, width - 24 * s));
        ctx.restore();
    }

    _drawFallbackBoat(ctx, x, y, alpha, shipClass = HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1], profile = { accent: '#9fb9b5' }) {
        const scale = Math.max(0.5, Number(shipClass.scale || 1));
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
