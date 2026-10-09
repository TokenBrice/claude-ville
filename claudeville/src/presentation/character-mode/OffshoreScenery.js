// claudeville/src/presentation/character-mode/OffshoreScenery.js
//
// W8.5a (AD-P2) — the offshore backdrop: sea stacks, a reef wreck, a far
// hamlet islet, a beacon rock and two far-shore silhouettes standing in the
// open sea past the map diamond (config/scenery.js OFFSHORE_SCENERY).
//
// They belong to the water, not to the island: one static sprite each, drawn
// in the water pass in the list's explicit painter order (back to front),
// over the terrain bake and the open sea and under every island drawable,
// ground cue, haze and fog bank. They never enter the depth sorter, the
// walk grid, the coast field, `_fullIslandWorldBox` or the camera content
// frame, so the opening shot and every route are unchanged.
//
//   Canvas (and hybrid PostFx): `drawOffshoreScenery` right after
//     `_drawTerrain` (WorldFrameRenderer), world transform applied.
//   WebGPU and WebGL2: `offshoreSceneryRecords` from `buildGpuWorldRecords`,
//     `ground:offshore:*` records ordered right after `terrain:static`
//     (ground records never write painter depth), the same image at the same
//     integer world rect, graded, lit and hazed like every record.
//
// Static art only: no clock, no motion, no agent state (V3).

import { OFFSHORE_SCENERY } from '../../config/scenery.js';
import { materialClassId } from './MaterialRegistry.js';
import { tileToWorld } from './Projection.js';

export const OFFSHORE_RECORD_PREFIX = 'ground:offshore:';

const PLACEMENTS = OFFSHORE_SCENERY.map((entry, order) => {
    const world = tileToWorld(entry.tileX, entry.tileY);
    return Object.freeze({
        id: entry.id,
        order,
        worldX: Math.round(world.x),
        worldY: Math.round(world.y),
        recordId: `${OFFSHORE_RECORD_PREFIX}${entry.id}`,
    });
});

/** True for a resident record this module produced. */
export function isOffshoreRecordId(id) {
    return typeof id === 'string' && id.startsWith(OFFSHORE_RECORD_PREFIX);
}

// One placed sprite: its loaded image and integer world rect, or null while
// the PNG is missing (nothing draws; no checkerboard reaches the sea).
function placedSprite(assets, placement) {
    if (!assets?.has?.(placement.id, { request: false })) return null;
    const image = assets.get(placement.id, { request: false });
    const dims = assets.getDims?.(placement.id);
    if (!image || !dims?.w || !dims?.h) return null;
    const [ax, ay] = assets.getAnchor?.(placement.id) ?? [dims.w / 2, dims.h];
    return {
        image,
        x: placement.worldX - Math.round(ax),
        y: placement.worldY - Math.round(ay),
        w: dims.w,
        h: dims.h,
    };
}

function visibleWorldRect(ctx) {
    const m = ctx.getTransform?.();
    const width = ctx.canvas?.width || 0;
    const height = ctx.canvas?.height || 0;
    if (!m || !m.a || !m.d || !width || !height) return null;
    return {
        x0: -m.e / m.a,
        y0: -m.f / m.d,
        x1: (width - m.e) / m.a,
        y1: (height - m.f) / m.d,
    };
}

/** Canvas: the offshore sprites in painter order, world transform applied. */
export function drawOffshoreScenery(ctx, renderer) {
    const assets = renderer?.assets;
    if (!ctx || !assets) return 0;
    const view = visibleWorldRect(ctx);
    let drawn = 0;
    for (const placement of PLACEMENTS) {
        const sprite = placedSprite(assets, placement);
        if (!sprite) continue;
        if (view && (sprite.x > view.x1 || sprite.x + sprite.w < view.x0
            || sprite.y > view.y1 || sprite.y + sprite.h < view.y0)) continue;
        ctx.drawImage(sprite.image, sprite.x, sprite.y);
        drawn++;
    }
    return drawn;
}

// Resident record identity per loaded image, so a reloaded PNG (a new
// assetVersion) re-uploads under the same texture key.
const imageRevisions = new WeakMap();
let imageSerial = 0;
function imageRevision(image) {
    let revision = imageRevisions.get(image);
    if (!revision) {
        revision = `offshore:${++imageSerial}`;
        imageRevisions.set(image, revision);
    }
    return revision;
}

/**
 * Resident path: one reused `ground:offshore:*` record per loaded sprite,
 * appended to `out` in painter order. The scene builder orders every
 * `ground:*` record right after the terrain, ahead of the island's casts,
 * haze and fog; ground records never write painter depth.
 */
export function offshoreSceneryRecords(renderer, out = []) {
    const assets = renderer?.assets;
    if (!assets) return out;
    const pool = renderer._offshoreRecords || (renderer._offshoreRecords = new Map());
    for (const placement of PLACEMENTS) {
        const sprite = placedSprite(assets, placement);
        if (!sprite) continue;
        let record = pool.get(placement.id);
        if (!record) {
            const materialName = assets.getEntry?.(placement.id)?.materialClass || 'stone';
            record = {
                id: placement.recordId,
                stableKey: placement.recordId,
                textureKey: `offshore:${placement.id}`,
                sidecarKey: '',
                sx: 0,
                sy: 0,
                material: materialClassId(materialName),
                emissive: 0,
                occluder: 0,
                alpha: 1,
                writesDepth: false,
                // Between the terrain (-1) and the ground haze (-0.9).
                sequence: -0.95 + placement.order / 1000,
                sourceKind: 'individual',
            };
            pool.set(placement.id, record);
        }
        record.source = sprite.image;
        record.textureRevision = imageRevision(sprite.image);
        record.sourceWidth = sprite.w;
        record.sourceHeight = sprite.h;
        record.sw = sprite.w;
        record.sh = sprite.h;
        record.x = sprite.x;
        record.y = sprite.y;
        record.width = sprite.w;
        record.height = sprite.h;
        // Light lands at the waterline, as on a stone at its ground line.
        record.footY = placement.worldY;
        record.elevation = sprite.h > 70 ? 0.58 : 0.34;
        out.push(record);
    }
    return out;
}
