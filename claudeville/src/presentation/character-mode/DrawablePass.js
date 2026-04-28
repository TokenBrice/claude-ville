function finiteSortY(value) {
    return Number.isFinite(value) ? value : 0;
}

export function createDepthDrawable(kind, sortY, payload, draw) {
    return {
        kind,
        sortY: finiteSortY(sortY),
        payload,
        draw,
    };
}

function drawAgent(ctx, zoom, context, sprite) {
    sprite?.draw?.(ctx, zoom);
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
} = {}) {
    for (const drawable of buildingDrawables) {
        target.push(createDepthDrawable(drawable.kind, drawable.sortY, drawable, drawBuilding));
    }
    for (const drawable of propDrawables) {
        target.push(drawable);
    }
    for (const sprite of agentSprites) {
        target.push(createDepthDrawable('agent', sprite.y, sprite, drawAgent));
    }
    for (const drawable of harborDrawables) {
        target.push(createDepthDrawable('harbor-traffic', drawable.sortY, drawable, drawHarborTraffic));
    }
    for (const drawable of landmarkDrawables) {
        target.push(createDepthDrawable('landmark-activity', drawable.sortY, drawable, drawLandmarkActivity));
    }
    for (const drawable of chronicleMonumentDrawables) {
        target.push(createDepthDrawable('chronicle-monument', drawable.sortY, drawable, drawChronicleMonument));
    }
    for (const drawable of chroniclerDrawables) {
        target.push(createDepthDrawable('chronicler', drawable.sortY, drawable, drawChronicler));
    }
    target.sort((a, b) => a.sortY - b.sortY);
}

export function drawDepthSortedDrawables(ctx, drawables, context = {}) {
    const zoom = context.zoom || 1;
    for (const drawable of drawables) {
        drawable.draw?.(ctx, zoom, context, drawable.payload);
    }
}
