import { formatRelative } from '../shared/Formatters.js';
import { ornamentPlan } from './MarkGovernor.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { pulseValueMs } from './PulsePolicy.js';
import { tileToWorld } from './Projection.js';

export const MAX_BRIDGE_LANTERNS = 6;

const DAY_MS = 24 * 60 * 60_000;
const LANTERN_COLOR = '#ffd56a';
const LANTERN_LIGHT_PRIORITY = 100;

const BRIDGE_LANTERN_SCENE_ITEMS = [];
export const BRIDGE_LANTERN_SCENE_CATEGORY = Object.freeze({
    id: 'bridge-lantern',
    sortBand: 45,
    enumerate({ renderer, renderNow } = {}) {
        const items = BRIDGE_LANTERN_SCENE_ITEMS;
        items.length = 0;
        const drawables = renderer?.bridgeLanterns?.enumerateDrawables?.(renderNow, renderer.camera) ?? [];
        for (let index = 0; index < drawables.length; index++) items.push(drawables[index]);
        return items;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        drawable?.draw?.(ctx, zoom, context);
    },
    unsupported: 'overlay-safe',
    overlayBand: 45,
});

function brightnessTier(ageMs) {
    if (ageMs < DAY_MS) return 0.5;
    if (ageMs < 3 * DAY_MS) return 0.68;
    if (ageMs < 7 * DAY_MS) return 0.85;
    return 1;
}

function ewPlankDeck(bridgeTiles) {
    const entries = bridgeTiles instanceof Map
        ? [...bridgeTiles.entries()].map(([key, value]) => ({ key, ...value }))
        : Array.isArray(bridgeTiles) ? bridgeTiles : [];
    return entries
        .filter(tile => tile?.kind === 'plank' && tile.orientation === 'EW')
        .map((tile) => {
            const [keyX, keyY] = String(tile.key || '').split(',').map(Number);
            return {
                ...tile,
                tileX: Number.isFinite(Number(tile.tileX)) ? Number(tile.tileX) : keyX,
                tileY: Number.isFinite(Number(tile.tileY)) ? Number(tile.tileY) : keyY,
            };
        })
        .filter(tile => Number.isFinite(tile.tileX) && Number.isFinite(tile.tileY))
        .sort((a, b) => a.tileX - b.tileX || a.tileY - b.tileY);
}

export function deriveLanternPlan(pendingRepoSummaries = [], bridgeTiles = [], now = Date.now()) {
    const deck = ewPlankDeck(bridgeTiles);
    if (deck.length === 0) return [];

    const rows = [...(Array.isArray(pendingRepoSummaries) ? pendingRepoSummaries : [])]
        .filter(row => (Number(row.pendingCommits ?? row.count) || 0) > 0)
        .filter(row => (Number(row.oldestCommitTime) || 0) > 0)
        .sort((a, b) => (Number(a.oldestCommitTime) - Number(b.oldestCommitTime))
            || String(a.repoName || a.project || '').localeCompare(String(b.repoName || b.project || ''))
            || String(a.branch || '').localeCompare(String(b.branch || '')));
    const selected = rows.slice(0, MAX_BRIDGE_LANTERNS);
    if (selected.length === 0) return [];

    const west = deck[0];
    const east = deck[deck.length - 1];
    const overflowCount = Math.max(0, rows.length - selected.length);
    return selected.map((row, index) => {
        const fraction = selected.length === 1 ? 0.5 : index / (selected.length - 1);
        const oldestCommitTime = Number(row.oldestCommitTime) || 0;
        const ageMs = Math.max(0, Number(now) - oldestCommitTime);
        return {
            tileX: west.tileX + (east.tileX - west.tileX) * fraction,
            tileY: west.tileY + (east.tileY - west.tileY) * fraction,
            branch: row.branch || '',
            repoName: row.repoName || row.shortName || row.project || 'unknown',
            accent: row.profile?.accent || '#fff1ad',
            ageMs,
            tier: brightnessTier(ageMs),
            oldestCommitTime,
            pendingCommits: Number(row.pendingCommits ?? row.count) || 0,
            overflowCount,
        };
    });
}

function drawLantern(ctx, lantern, now, motionScale) {
    const world = lantern.world;
    const policy = ornamentPlan({ motionScale });
    const animated = policy.lanterns === 'on' && motionScale > 0;
    const pulse = animated ? pulseValueMs('harbor', now, motionScale, lantern.phase) : 1;
    const alpha = Math.max(0.2, Math.min(1, lantern.tier * pulse));
    const x = Math.round(world.x);
    const top = Math.round(world.y) - 16;

    ctx.save();
    ctx.fillStyle = '#563820';
    ctx.globalAlpha = alpha;
    ctx.fillRect(x - 4, top, 5, 1);
    ctx.fillRect(x - 4, top, 1, 3);
    ctx.fillRect(x, top, 1, 3);
    ctx.globalAlpha = alpha * 0.22;
    ctx.fillStyle = lantern.accent;
    ctx.fillRect(x - 3, top + 1, 7, 7);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#563820';
    ctx.fillRect(x - 2, top + 2, 5, 5);
    ctx.fillStyle = lantern.accent;
    ctx.fillRect(x - 1, top + 3, 3, 3);
    ctx.fillStyle = LANTERN_COLOR;
    ctx.fillRect(x - 1, top + 3, 1, 2);
    ctx.restore();
}

export class BridgeLanterns {
    constructor({ renderer } = {}) {
        this.renderer = renderer || null;
        this.plan = [];
        this._signature = null;
        this._drawables = [];
        this._drawNow = 0;
        this.hovered = null;
    }

    update(pendingRepoSummaries = [], now = Date.now()) {
        const signature = this.renderer?._harborPendingReposSignature?.(pendingRepoSummaries)
            ?? JSON.stringify(pendingRepoSummaries);
        if (signature === this._signature) return false;
        this._signature = signature;
        this.plan = deriveLanternPlan(pendingRepoSummaries, this.renderer?.bridgeTiles, now)
            .map((lantern, index) => ({
                ...lantern,
                world: tileToWorld(lantern.tileX, lantern.tileY),
                phase: index * 0.83,
            }));
        this._drawables = this.plan.map(lantern => ({
            id: `bridge-lantern:${lantern.repoName}:${lantern.branch}`,
            kind: 'bridge-lantern',
            x: lantern.world.x,
            y: lantern.world.y - 10,
            sortY: lantern.world.y + 1,
            stableKey: `bridge-lantern:${lantern.repoName}:${lantern.branch}`,
            payload: lantern,
            draw: (ctx) => drawLantern(
                ctx,
                lantern,
                this._drawNow,
                Number(this.renderer?.motionScale) || 0,
            ),
        }));
        return true;
    }

    enumerateDrawables(now = Date.now(), camera = this.renderer?.camera) {
        if (this.plan.length === 0 || !camera?.worldToScreen) return [];
        this._drawNow = now;
        const width = camera.canvas?.clientWidth || camera.canvas?.width || 0;
        const height = camera.canvas?.clientHeight || camera.canvas?.height || 0;
        return this._drawables.filter((drawable) => {
            const lantern = drawable.payload;
            const screen = camera.worldToScreen(lantern.world.x, lantern.world.y - 12);
            return screen.x >= -16 && screen.x <= width + 16 && screen.y >= -24 && screen.y <= height + 16;
        });
    }

    hitTest(worldX, worldY) {
        for (const lantern of this.plan) {
            if (
                worldX >= lantern.world.x - 6 && worldX <= lantern.world.x + 6
                && worldY >= lantern.world.y - 16 && worldY <= lantern.world.y + 3
            ) return lantern;
        }
        return null;
    }
    setHovered(lantern) {
        this.hovered = lantern || null;
    }


    tooltipFor(lantern, now = Date.now()) {
        if (!lantern) return '';
        const age = formatRelative(lantern.oldestCommitTime, now);
        const count = lantern.pendingCommits;
        const line = `${lantern.repoName} - ${lantern.branch || 'unknown branch'} - ${count} ${count === 1 ? 'commit' : 'commits'}${age ? ` - oldest ${age}` : ''}`;
        return lantern.overflowCount > 0
            ? `${line}\n+${lantern.overflowCount} more branches`
            : line;
    }

    getLightSources(lighting = null) {
        const beaconIntensity = Math.max(0, Math.min(1, Number(lighting?.beaconIntensity) || 0));
        if (beaconIntensity <= 0.05 || this.plan.length === 0) return [];
        return this.plan.map(lantern => ({
            ...normalizeLightSource({
                id: `bridge-lantern:${lantern.tileX},${lantern.tileY}`,
                kind: 'point',
                x: lantern.world.x,
                y: lantern.world.y - 10,
                color: LANTERN_COLOR,
                radius: 46,
                intensity: 0.7 * lantern.tier,
                priority: LANTERN_LIGHT_PRIORITY,
                overlay: 'atmosphere.light.lantern-glow',
            }),
            night: true,
        }));
    }
}
