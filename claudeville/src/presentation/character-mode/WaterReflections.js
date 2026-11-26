// Mirror up to twelve nearby bodies about the first exposed water below their feet.
// The ground band and the resident water mask clip the duplicate behind the scene.

import { COAST_FIELD_FLAGS, getCoastField, MAX_CONTACT_GAP } from './CoastBake.js';
import { effectBudgetMode } from './gpu/GpuWorldPolicy.js';

export const BODY_REFLECTION_CAP = 12;
const { water, covered } = COAST_FIELD_FLAGS;
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
        let gap = 0;
        const field = renderer._coastBake?.waterFields;
        while (gap <= MAX_CONTACT_GAP) {
            const x = sprite.x, y = sprite.y + gap;
            if (field) {
                const col = Math.floor((x - field.x) / 2), row = Math.floor((y - field.y) / 2);
                if (col >= 0 && row >= 0 && col < field.cols && row < field.rows
                    && (field.coastField[(row * field.cols + col) * 2 + 1] & (water | covered)) === water) break;
            } else if (coast.signedDistanceAtWorld(x, y) > 0) break;
            gap++;
        }
        if (gap <= MAX_CONTACT_GAP) _candidates.push({ agentId, sprite, gap, distance: Math.hypot(sprite.x - cx, sprite.y - cy) });
    }
    if (!_candidates.length) return records;
    _candidates.sort((a, b) => a.distance - b.distance);
    if (_candidates.length > BODY_REFLECTION_CAP) _candidates.length = BODY_REFLECTION_CAP;
    const chosen = new Map(_candidates.map(c => [c.agentId, c]));
    _reflections.length = 0;
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const agentId = agentIdOf(record);
        const candidate = chosen.get(agentId);
        const sprite = candidate?.sprite;
        if (!sprite || !(record.height > 0) || !(record.sh > 0)) continue;
        // Crop the cell to the feet row so the mirror axis is the ground line.
        // A body lifted onto a bridge deck is drawn `lift` px up: crop at its
        // drawn feet and move the twin down twice the lift, so it mirrors
        // about the water under the body, not about the deck it stands on.
        const lift = Math.round(Math.max(0, Number(sprite._currentBridgeLift?.()) || 0));
        const height = Math.max(1, Math.min(record.height, Math.round(sprite.y - lift - record.y) + 1));
        const sh = record.sh * height / record.height;
        _reflections.push({
            ...record,
            id: `ground:reflect:${record.id}`,
            // Separate hats and weapons share the body’s waterline.
            y: 2 * candidate.gap + (record.sharedLayer ? 2 * (sprite.y + 1 - height) - record.y : record.y + 2 * lift),
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
            // Indexed albedo needs the color code even on the water twin.
            sidecarKey: record.recolorIndex ? record.sidecarKey : '',
            materialSource: record.recolorIndex ? record.materialSource : null,
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
