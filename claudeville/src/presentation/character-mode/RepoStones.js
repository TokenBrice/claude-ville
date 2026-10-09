// W7.7 — repo standing stones. One stone per repo that holds a Harbor
// Home-Waters anchorage and has >= 1 lifetime commit (ChronicleStore meta
// `lifetimeCounts`, never pruned), planted on the land behind that slot's
// buoy (townPlan REPO_STONE_ANCHORS) and grown through the MonumentRules
// lifetime tiers 1 / 10 / 100 / 1000 (cairn → stone → pillar → obelisk).
// The face carries the repo crest in `repoProfile().accent`. Repos without
// an anchorage are the Harbor's overflow chip, as their fleets already are.
//
// Static band: no motion, no light. Each (sprite, accent) pair is baked
// once into a small canvas with its contact shadow, so a stone costs one
// blit per frame on Canvas and one reused record on the resident GPU path
// (`image`, read by ChronicleMonuments); counts are re-read at most every
// REFRESH_MS.

import { repoStoneSpriteFor } from '../../application/MonumentRules.js';
import { REPO_STONE_ANCHORS } from '../../config/townPlan.js';
import { repoProfile } from '../shared/RepoColor.js';
import { fillPixelEllipse } from './PixelShapes.js';
import { tileToWorld } from './Projection.js';

const REFRESH_MS = 5000;
const CREST_INK = '#2b2a33';
// Sprite-local top-left of the 7×8 crest shield, on each stone's front face
// (measured on the baked prop.repoStone.* PNGs).
export const REPO_STONE_CRESTS = Object.freeze({
    'prop.repoStone.cairn': Object.freeze({ x: 12, y: 15 }),
    'prop.repoStone.stone': Object.freeze({ x: 9, y: 15 }),
    'prop.repoStone.pillar': Object.freeze({ x: 15, y: 22 }),
    'prop.repoStone.obelisk': Object.freeze({ x: 15, y: 46 }),
});
// The crest: a heater shield, 7 wide, 8 tall ('1' ink rim, '2' accent field).
const CREST_ROWS = ['1111111', '1222221', '1222221', '1222221', '1222221', '0122210', '0012100', '0001000'];
const SHADOW_PAD = 4;

/**
 * Pure: the stones to plant for `anchorages` (Map or entries of project →
 * Harbor slot) and `counts` (Map project → lifetime commits). One stone per
 * slot that has a quay anchor; a project below one commit plants nothing.
 */
export function repoStoneLayout(anchorages, counts, anchors = REPO_STONE_ANCHORS) {
    const bySlot = new Map(anchors.map(anchor => [anchor.slot, anchor]));
    const out = [];
    const seen = new Set();
    for (const [project, slot] of anchorages || []) {
        const anchor = bySlot.get(slot);
        if (!anchor || seen.has(slot)) continue;
        const spriteId = repoStoneSpriteFor(counts?.get?.(project));
        if (!spriteId) continue;
        seen.add(slot);
        out.push({ project, slot, spriteId, tileX: anchor.tileX, tileY: anchor.tileY });
    }
    return out.sort((a, b) => a.slot - b.slot);
}

export class RepoStones {
    constructor({ assets = null } = {}) {
        this.assets = assets;
        this.stones = [];
        this._refreshAt = -Infinity;
        this._pending = null;
        this._baked = new Map();
    }

    async refresh(harbor, store, now = Date.now()) {
        if (this._pending || now - this._refreshAt < REFRESH_MS) return this._pending;
        const anchorages = harbor?.state?.repoAnchorages;
        if (!anchorages?.size || typeof store?.getLifetimeCommitCount !== 'function') {
            this._refreshAt = now;
            this.stones = [];
            return null;
        }
        const entries = [...anchorages.entries()];
        this._pending = Promise.all(entries.map(([project]) => store.getLifetimeCommitCount(project)
            .then(count => [project, Number(count) || 0], () => [project, 0])))
            .then((pairs) => {
                this.stones = repoStoneLayout(entries, new Map(pairs)).map((stone) => {
                    const world = tileToWorld(stone.tileX, stone.tileY);
                    return { ...stone, worldX: world.x, worldY: world.y, accent: repoProfile(stone.project).accent };
                });
            })
            .finally(() => {
                this._refreshAt = now;
                this._pending = null;
            });
        return this._pending;
    }

    drawables(camera = null) {
        const bounds = camera?.getViewportTileBounds?.(2);
        const out = [];
        for (const stone of this.stones) {
            if (bounds && (stone.tileX < bounds.startX || stone.tileX > bounds.endX
                || stone.tileY < bounds.startY || stone.tileY > bounds.endY)) continue;
            out.push({ kind: 'chronicle-monument', sortY: stone.worldY + 18, payload: { ...stone, kind: 'repo-stone' } });
        }
        return out;
    }

    draw(ctx, stone) {
        const baked = this.image(stone);
        if (!baked) return;
        ctx.drawImage(baked.canvas, Math.round(stone.worldX - baked.ax), Math.round(stone.worldY - baked.ay));
    }

    /** The stone's baked face `{ canvas, ax, ay, key, revision }`, or null before its sprite loads. */
    image(stone) {
        return this._bake(stone.spriteId, stone.accent);
    }

    _bake(spriteId, accent) {
        const key = `${spriteId}|${accent}`;
        if (this._baked.has(key)) return this._baked.get(key);
        const img = this.assets?.get?.(spriteId);
        const anchor = this.assets?.getAnchor?.(spriteId);
        if (!img || !anchor || typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = img.width + SHADOW_PAD * 2;
        canvas.height = img.height + SHADOW_PAD;
        const c = canvas.getContext('2d');
        c.imageSmoothingEnabled = false;
        const ax = anchor[0] + SHADOW_PAD;
        const ay = anchor[1];
        const halfW = Math.max(6, Math.round(img.width * 0.42));
        fillPixelEllipse(c, ax, ay, halfW, Math.max(3, Math.round(halfW / 2.6)), 'rgba(26, 22, 18, 0.35)');
        c.drawImage(img, SHADOW_PAD, 0);
        const crest = REPO_STONE_CRESTS[spriteId];
        if (crest) {
            CREST_ROWS.forEach((row, y) => [...row].forEach((cell, x) => {
                if (cell === '0') return;
                c.fillStyle = cell === '1' ? CREST_INK : accent;
                c.fillRect(SHADOW_PAD + crest.x + x, crest.y + y, 1, 1);
            }));
        }
        const baked = { canvas, ax, ay, key: `repo:${key}`, revision: 0 };
        this._baked.set(key, baked);
        return baked;
    }

    dispose() {
        this.stones = [];
        this._baked.clear();
        this.assets = null;
    }
}
