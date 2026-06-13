function finiteSortY(value) {
    return Number.isFinite(value) ? value : 0;
}

const KIND_ORDER = Object.freeze({
    'building-back': 10,
    'prop-back': 20,
    prop: 30,
    'harbor-traffic': 40,
    agent: 50,
    'landmark-activity': 60,
    'chronicle-monument': 70,
    chronicler: 75,
    'familiar-motes': 80,
    'building-front': 90,
    building: 95,
});

/**
 * Shared depth drawable contract for World mode overlap rendering.
 *
 * Shape:
 * - kind: stable category for diagnostics and special-case consumers.
 * - sortY: finite world-space Y used for painter ordering.
 * - draw(ctx, zoom, context): draws itself without call-site dispatch.
 * - hitArea: optional future hit-test metadata.
 * - payload: original source object for legacy consumers.
 */
export function createDepthDrawable(kind, sortY, payload, draw) {
    return {
        kind,
        sortY: finiteSortY(sortY),
        sortBand: KIND_ORDER[kind] ?? 50,
        stableKey: payloadStableKey(payload),
        hitArea: payload?.hitArea || null,
        payload,
        draw(ctx, zoom, context) {
            draw?.(ctx, zoom, context, payload);
        },
    };
}

function drawAgent(ctx, zoom, context, sprite) {
    sprite?.draw?.(ctx, zoom, context.agentRenderMode || 'full');
}

function drawBuilding(ctx, zoom, context, drawable) {
    context.buildingRenderer?.drawDrawable?.(ctx, drawable);
}

function drawProp(ctx, zoom, context, payload) {
    payload?.sprite?.drawPart?.(ctx, payload.part || 'whole', zoom);
}

function drawHarborTraffic(ctx, zoom, context, drawable) {
    context.harborTraffic?.draw?.(ctx, drawable, zoom);
}

function drawLandmarkActivity(ctx, zoom, context, drawable) {
    context.landmarkActivity?.draw?.(ctx, drawable, zoom);
}

function drawChronicleMonument(ctx, zoom, context, drawable) {
    context.chronicleMonuments?.draw?.(ctx, drawable, zoom, context.renderNow);
}

function drawChronicler(ctx, zoom, context, drawable) {
    context.chronicler?.draw?.(ctx, drawable, zoom);
}

function drawFamiliarMotes(ctx, zoom, context, drawable) {
    drawable?.draw?.(ctx, zoom, context);
}

export function propDepthDrawable(sprite, part = 'whole') {
    const kind = part === 'whole' ? 'prop' : `prop-${part}`;
    const sortY = part === 'back'
        ? sprite.propBackSortY()
        : part === 'front'
            ? sprite.propFrontSortY()
            : sprite.sortY ?? sprite.y;
    return createDepthDrawable(kind, sortY, { sprite, part }, drawProp);
}

export function appendDepthSortedDrawables(target, {
    buildingDrawables = [],
    propDrawables = [],
    agentSprites = [],
    harborDrawables = [],
    landmarkDrawables = [],
    chronicleMonumentDrawables = [],
    chroniclerDrawables = [],
    familiarDrawables = [],
} = {}) {
    for (const drawable of buildingDrawables) {
        pushDepthDrawable(target, createDepthDrawable(drawable.kind, drawable.sortY, drawable, drawBuilding));
    }
    for (const drawable of propDrawables) {
        pushDepthDrawable(target, drawable);
    }
    for (const sprite of agentSprites) {
        pushDepthDrawable(target, createDepthDrawable('agent', sprite.y, sprite, drawAgent));
    }
    for (const drawable of harborDrawables) {
        pushDepthDrawable(target, createDepthDrawable('harbor-traffic', drawable.sortY, drawable, drawHarborTraffic));
    }
    for (const drawable of landmarkDrawables) {
        pushDepthDrawable(target, createDepthDrawable('landmark-activity', drawable.sortY, drawable, drawLandmarkActivity));
    }
    for (const drawable of chronicleMonumentDrawables) {
        pushDepthDrawable(target, createDepthDrawable('chronicle-monument', drawable.sortY, drawable, drawChronicleMonument));
    }
    for (const drawable of chroniclerDrawables) {
        pushDepthDrawable(target, createDepthDrawable('chronicler', drawable.sortY, drawable, drawChronicler));
    }
    for (const drawable of familiarDrawables) {
        pushDepthDrawable(target, createDepthDrawable(drawable.kind || 'familiar-motes', drawable.sortY, drawable, drawFamiliarMotes));
    }
    target.sort(compareDepthDrawables);
}

export function drawDepthSortedDrawables(ctx, drawables, context = {}) {
    const zoom = context.zoom || 1;
    for (const drawable of drawables) {
        drawable.draw?.(ctx, zoom, context);
    }
}

export function cullDepthSortedDrawables(drawables, camera, viewport, margin = 180) {
    const rect = worldViewportRect(camera, viewport, margin);
    if (!rect) {
        return { enabled: false, input: drawables.length, drawn: drawables.length, culled: 0 };
    }

    let writeIndex = 0;
    const byKind = {};
    for (let i = 0; i < drawables.length; i++) {
        const drawable = drawables[i];
        if (drawableVisibleInRect(drawable, rect)) {
            drawables[writeIndex++] = drawable;
            continue;
        }
        const kind = drawable.kind || 'unknown';
        byKind[kind] = (byKind[kind] || 0) + 1;
    }
    const input = drawables.length;
    drawables.length = writeIndex;
    return {
        enabled: true,
        input,
        drawn: writeIndex,
        culled: input - writeIndex,
        byKind,
    };
}

export function summarizeDrawableLayers(drawables, culling = null) {
    const byKind = {};
    for (const drawable of drawables || []) {
        const kind = drawable?.kind || 'unknown';
        byKind[kind] = (byKind[kind] || 0) + 1;
    }
    return {
        total: drawables?.length || 0,
        byKind,
        culling,
    };
}

function pushDepthDrawable(target, drawable) {
    drawable.sequence = target.length;
    drawable.sortBand = Number.isFinite(Number(drawable.sortBand))
        ? Number(drawable.sortBand)
        : KIND_ORDER[drawable.kind] ?? 50;
    target.push(drawable);
}

function compareDepthDrawables(a, b) {
    return (a.sortY - b.sortY)
        || (a.sortBand - b.sortBand)
        || String(a.kind || '').localeCompare(String(b.kind || ''))
        || String(a.stableKey || '').localeCompare(String(b.stableKey || ''))
        || ((a.sequence || 0) - (b.sequence || 0));
}

function worldViewportRect(camera, viewport, margin) {
    if (!camera || typeof camera.screenToWorld !== 'function' || !viewport?.width || !viewport?.height) return null;
    const a = camera.screenToWorld(-margin, -margin);
    const b = camera.screenToWorld(viewport.width + margin, viewport.height + margin);
    return {
        left: Math.min(a.x, b.x),
        right: Math.max(a.x, b.x),
        top: Math.min(a.y, b.y),
        bottom: Math.max(a.y, b.y),
    };
}

function drawableVisibleInRect(drawable, rect) {
    const point = drawablePoint(drawable);
    if (!point) return true;
    const radius = drawableRadius(drawable);
    return point.x >= rect.left - radius
        && point.x <= rect.right + radius
        && point.y >= rect.top - radius
        && point.y <= rect.bottom + radius;
}

function drawablePoint(drawable) {
    const payload = drawable?.payload || drawable;
    if (Number.isFinite(Number(payload?.wx)) && Number.isFinite(Number(payload?.wy))) {
        return { x: Number(payload.wx), y: Number(payload.wy) };
    }
    if (Number.isFinite(Number(payload?.x)) && Number.isFinite(Number(payload?.y))) {
        return { x: Number(payload.x), y: Number(payload.y) };
    }
    if (Number.isFinite(Number(drawable?.x)) && Number.isFinite(Number(drawable?.y))) {
        return { x: Number(drawable.x), y: Number(drawable.y) };
    }
    if (Number.isFinite(Number(payload?.payload?.x)) && Number.isFinite(Number(payload?.payload?.y))) {
        return { x: Number(payload.payload.x), y: Number(payload.payload.y) };
    }
    return null;
}

function drawableRadius(drawable) {
    const kind = drawable?.kind || '';
    if (kind.startsWith('building')) return 260;
    if (kind === 'harbor-traffic') return 180;
    if (kind === 'agent') return 80;
    if (kind.includes('prop')) return 150;
    return 120;
}

function payloadStableKey(payload) {
    return payload?.id
        || payload?.entry?.id
        || payload?.building?.type
        || payload?.agent?.id
        || payload?.squadKey
        || payload?.payload?.id
        || payload?.payload?.squadKey
        || payload?.payload?.project
        || '';
}
