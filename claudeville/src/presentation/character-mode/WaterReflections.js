// 3.11 (M11) — moving things reflect.
//
// A body standing where the water is (feet within 0.3 tiles of the coast
// contour: banks, bridges; or open water within half a body height straight
// below the feet: the edge of a pier or quay) gets a duplicate of its packed albedo
// record with V9's `reflect` flag, cropped to the feet and placed in the
// ground band. The vertex stage mirrors it about its base (the feet row); the
// scene fragment keeps it on painted water only (3.6's coast field), drops
// every fifth row, ripples rows by a whole texel on the shared palette tick,
// fades it in three Bayer alpha courses and pulls it 38 % toward the local
// water stop. Labels, rings, plates and beacons never enter the agent albedo
// records, so they are never duplicated. At most 12, nearest the camera
// centre; FULL only (EFFECT_BUDGET `bodyReflections`).

import { getCoastField } from './CoastBake.js';
import { effectBudgetMode } from './gpu/GpuWorldPolicy.js';

export const BODY_REFLECTION_CAP = 12;
const SHORE_SD = -0.3;
// A pier deck sits over the water in screen space, not in the coast field:
// its seats read 0.4-0.6 tiles inland, with the water 12-16 world px below
// the feet. Water that close under the feet takes the mirrored figure.
const PIER_REACH_PX = 16;
const _candidates = [];
const _reflections = [];

function agentIdOf(record) {
    const id = String(record.id || '');
    if (!id.startsWith('agent:')) return null;
    return record.stableKey || id.split(':')[1] || null;
}

export function insertBodyReflectionRecords(renderer, records) {
    if (!records?.length || !renderer?.agentSprites?.size) return records;
    if (effectBudgetMode('bodyReflections', renderer.gpuWorld?._compositeQualityLevel ?? 0) !== 'on') return records;
    const coast = renderer._coastField || renderer.coastField || getCoastField(renderer);
    if (!coast?.signedDistanceAtWorld) return records;
    const camera = renderer.camera;
    const cx = Number(camera?.x) || 0;
    const cy = Number(camera?.y) || 0;
    _candidates.length = 0;
    const seen = new Set();
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const agentId = agentIdOf(record);
        if (!agentId || seen.has(agentId)) continue;
        seen.add(agentId);
        const sprite = renderer.agentSprites.get(agentId);
        if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        const onShore = coast.signedDistanceAtWorld(sprite.x, sprite.y) > SHORE_SD
            || coast.signedDistanceAtWorld(sprite.x, sprite.y + PIER_REACH_PX) > 0;
        if (!onShore) continue;
        _candidates.push({ agentId, sprite, distance: Math.hypot(sprite.x - cx, sprite.y - cy) });
    }
    if (!_candidates.length) return records;
    _candidates.sort((a, b) => a.distance - b.distance);
    if (_candidates.length > BODY_REFLECTION_CAP) _candidates.length = BODY_REFLECTION_CAP;
    const chosen = new Map(_candidates.map(c => [c.agentId, c.sprite]));
    _reflections.length = 0;
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const agentId = agentIdOf(record);
        const sprite = agentId ? chosen.get(agentId) : null;
        if (!sprite || !(record.height > 0) || !(record.sh > 0)) continue;
        // Crop the cell to the feet row so the mirror axis is the ground line.
        const height = Math.max(1, Math.min(record.height, Math.round(sprite.y - record.y) + 1));
        const sh = record.sh * height / record.height;
        _reflections.push({
            ...record,
            id: `ground:reflect:${record.id}`,
            height,
            sh,
            reflect: true,
            writesDepth: false,
            depthSortY: null,
            footY: -1,
            frontCornerX: 0,
            frontCornerY: -1,
            ownerSlot: 0,
            emissive: 0,
            occluder: 0,
            // Albedo only: a reflection neither glows nor carries the body's
            // material/occluder channels.
            sidecarKey: '',
            materialSource: null,
            emissiveSource: null,
            occluderSource: null,
        });
    }
    if (!_reflections.length) return records;
    // Ground band: after terrain and the leading ground records, before any
    // standing record, so every body, hull and wall paints over them.
    let insertAt = 0;
    while (insertAt < records.length) {
        const id = String(records[insertAt].id || '');
        if (id !== 'terrain:static' && !id.startsWith('ground:')) break;
        insertAt++;
    }
    records.splice(insertAt, 0, ..._reflections);
    return records;
}
