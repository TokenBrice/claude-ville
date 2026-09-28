// The padded body-and-caption footprint an attention frame promises to show:
// the sprite plus its name/reason plate, with the same numbers the overlay uses
// when it has to admit an agent stayed outside the frame.
export function attentionCandidateBounds(candidate) {
    if (candidate.bounds) return candidate.bounds;
    return {
        minX: candidate.x - 44, maxX: candidate.x + 44,
        // Tallest 1:1 body (plan 2.1: ≤ 76 texels) plus the screen-fixed T1
        // beacon and attention plate (~42 px, i.e. ~28 texels at zoom 1.5).
        minY: candidate.y - 104, maxY: candidate.y + 12,
    };
}

// Pure world-space framing. Unknown wait ages stay unknown and sort last.
// `zooms` are the tiers to try, closest first (4.1: the camera passes its
// close, medium and wide shot scales, then tier 1); the last is the fallback.
export function fitAttentionFrame(candidates, viewport, { padding = 16, zooms = [3, 2, 1] } = {}) {
    const tiers = [...new Set(zooms)].filter(zoom => Number.isFinite(zoom) && zoom > 0).sort((a, b) => b - a);
    const floor = tiers.length ? tiers[tiers.length - 1] : 1;
    const ranked = [...candidates].sort((a, b) => {
        const age = value => Number.isFinite(value) && value > 0 ? value : Infinity;
        return age(a.awaitingSince) - age(b.awaitingSince) || String(a.id).localeCompare(String(b.id));
    });
    const width = Math.max(0, viewport.width - padding * 2);
    const height = Math.max(0, viewport.height - padding * 2);
    const bounds = attentionCandidateBounds;
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const candidate of ranked) {
        const b = bounds(candidate);
        box.minX = Math.min(box.minX, b.minX);
        box.minY = Math.min(box.minY, b.minY);
        box.maxX = Math.max(box.maxX, b.maxX);
        box.maxY = Math.max(box.maxY, b.maxY);
    }
    const midpoint = b => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const center = ranked.length ? midpoint(box) : { x: 0, y: 0 };
    const result = (pose, zoom, bias) => {
        const included = [], excluded = [];
        for (const candidate of ranked) {
            const b = bounds(candidate);
            const fits = b.minX >= pose.x - width / (2 * zoom)
                && b.maxX <= pose.x + width / (2 * zoom)
                && b.minY >= pose.y - height / (2 * zoom)
                && b.maxY <= pose.y + height / (2 * zoom);
            (fits ? included : excluded).push(candidate.id);
        }
        return { center: pose, zoom, included, excluded, bias };
    };
    for (const zoom of tiers) {
        const centered = result(center, zoom, 'center');
        if (centered.excluded.length) continue;
        if (!ranked.length) return centered;
        const oldest = midpoint(bounds(ranked[0]));
        const third = result({ x: oldest.x + width / (6 * zoom), y: center.y }, zoom, 'third');
        return third.excluded.length ? centered : third;
    }
    // No complete fit: keep the oldest decision in a centered widest-tier shot.
    return result(ranked.length ? midpoint(bounds(ranked[0])) : center, floor, 'center');
}
