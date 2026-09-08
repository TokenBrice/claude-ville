// Authored pixel silhouettes. Coordinates are shared by Canvas stamps and DOM icons.
const motifs = {
    'weather-clear': ['00010000','01010100','00111000','11111110','00111000','01010100','00010000','00000000'],
    'weather-cloud': ['00000000','00111000','01111100','11111110','11111111','01111110','00000000','00000000'],
    'weather-rain': ['00111000','01111100','11111110','01111111','00000000','01010100','10101000','00000000'],
    'edit-strike': ['00010010','00100100','01001001','10010010','00100100','01001000','10010000','00100000'],
    'read-page': ['11100111','10011001','10111101','10011001','10111101','10011001','11111111','00011000'],
    'shell-slate': ['11111111','10000001','10100001','10010001','10100101','10000001','11111111','00000000'],
    'message-scroll': ['01111110','11000011','01011010','01000010','01011010','01000010','11000011','01111110'],
    'incident-bracket': ['11100111','10000001','10011001','00011000','00011000','10000001','10011001','11100111'],
    'child-return': ['00010000','00110000','01111110','11100010','01100110','00101100','00011000','00000000'],
    'release-crown': ['10011001','11011011','11111111','01111110','01000010','01111110','00000000','00111100'],
    'stale-seal': ['00111111','01000001','10011001','10010001','10011101','10000001','10000010','11111100'],
    'turn-sand': ['11111111','01000010','00100100','00011000','00011000','00111100','01111110','11111111'],
    'search-lens': ['00111100','01000010','10000001','10000001','01000010','00111110','00000110','00000011'],
    'task-slip': ['00011000','01111110','01000010','01011110','01000010','01011110','01000010','01111110'],
    'tool-unknown': ['00111100','01000010','00000010','00000100','00001000','00001000','00000000','00001000'],
    'district-command': ['01000000','01111110','01111100','01111110','01000000','01000000','01000000','11100000'],
    'district-taskboard': ['00111100','11100111','10000001','10101101','10000001','10101101','10000001','11111111'],
    'district-forge': ['00110000','01111000','00110000','00010000','01111110','11111111','00111100','01111110'],
    'district-mine': ['00011000','00111100','01111110','11011011','10011001','10011001','10000001','11111111'],
    'district-archive': ['00011000','00111100','11111111','01011010','01011010','01011010','11111111','11111111'],
    'district-observatory': ['00000110','00011111','01111110','11111000','01101000','00010000','00101000','01000100'],
    'district-portal': ['00111100','01100110','11000011','10011001','10100101','10011001','11000011','01100110'],
    'district-watchtower': ['00111100','00100100','01111110','01011010','01011010','01011010','11111111','10000001'],
    'district-harbor': ['00011000','00111100','00011000','10011001','10011001','11011011','01111110','00011000'],
    // 4.5 — working-set bench tile and the shared-file overlap marks: one
    // pencil for a read/write advisory, two crossed pencils for two writers.
    'file-tile': ['01111100','01000110','01000010','01011010','01000010','01011010','01000010','01111110'],
    'pencil-single': ['00000011','00000111','00001110','00011100','00111000','01110000','11100000','01000000'],
    'pencil-double': ['10000001','11000011','01100110','00111100','00111100','01100110','11000011','10000001'],
};
export const EVENT_SHAPES = Object.freeze(Object.fromEntries(Object.entries(motifs).map(([id, rows]) => [
    id, Object.freeze(['0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000',
        ...rows.map(row => `0000${row}0000`),
        '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000']),
])));
const runs = Object.fromEntries(Object.entries(EVENT_SHAPES).map(([id, rows]) => {
    const rects = [];
    rows.forEach((row, y) => {
        for (let x = 0; x < 16; x++) {
            if (row[x] !== '1') continue;
            const start = x;
            while (x + 1 < 16 && row[x + 1] === '1') x++;
            rects.push([start, y, x - start + 1]);
        }
    });
    return [id, rects];
}));
const paths = Object.fromEntries(Object.entries(runs).map(([id, rects]) => [id,
    rects.map(([x, y, width]) => `M${x} ${y}h${width}v1h-${width}Z`).join(''),
]));
// DOM icons fill their box: the drawn extent, not the padded 16×16 grid.
const viewBoxes = Object.fromEntries(Object.entries(runs).map(([id, rects]) => {
    if (!rects.length) return [id, '0 0 16 16'];
    const minX = Math.min(...rects.map(([x]) => x));
    const maxX = Math.max(...rects.map(([x, , width]) => x + width));
    const minY = rects[0][1];
    const maxY = rects[rects.length - 1][1] + 1;
    return [id, `${minX} ${minY} ${maxX - minX} ${maxY - minY}`];
}));
const EVENT_SHAPE_STAMPS = new Map();
const EVENT_SHAPE_STAMP_LIMIT = 240;
const EVENT_SHAPE_STAMP_PIXEL_LIMIT = 4 * 1024 * 1024;
let eventShapeStampPixels = 0;

export function clearEventShapeCache() {
    for (const stamp of EVENT_SHAPE_STAMPS.values()) {
        stamp.canvas.width = 0;
        stamp.canvas.height = 0;
    }
    EVENT_SHAPE_STAMPS.clear();
    eventShapeStampPixels = 0;
}

export function drawEventShape(ctx, id, x, y, scale = 1, color = 'currentColor') {
    const rects = runs[id];
    if (!rects) return;
    const step = Math.max(1, Math.round(scale));
    const left = Math.round(x);
    const top = Math.round(y);
    ctx.fillStyle = color;
    const transform = ctx.getTransform?.();
    const scaleX = transform ? Math.round(transform.a * 1e6) / 1e6 : 0;
    const scaleY = transform ? Math.round(transform.d * 1e6) / 1e6 : 0;
    // Preserve per-run compositing for effects and unsupported transforms.
    if (!transform || transform.b !== 0 || transform.c !== 0 || scaleX !== scaleY ||
        !Number.isFinite(scaleX) || scaleX <= 0 || ctx.globalCompositeOperation !== 'source-over' ||
        ctx.shadowBlur || ctx.shadowOffsetX || ctx.shadowOffsetY || (ctx.filter && ctx.filter !== 'none') ||
        (ctx.shadowColor !== 'rgba(0, 0, 0, 0)' && ctx.shadowColor !== 'transparent') ||
        typeof ctx.fillStyle !== 'string') {
        paintEventShape(ctx, rects, left, top, step);
        return;
    }
    const width = Math.ceil(16 * step * scaleX);
    const height = Math.ceil(16 * step * scaleY);
    if (!Number.isFinite(width * height) || width * height > EVENT_SHAPE_STAMP_PIXEL_LIMIT) {
        paintEventShape(ctx, rects, left, top, step);
        return;
    }
    const key = JSON.stringify([id, EVENT_SHAPES[id], ctx.fillStyle, step, ctx.globalAlpha, scaleX, scaleY]);
    let stamp = EVENT_SHAPE_STAMPS.get(key);
    if (stamp) {
        EVENT_SHAPE_STAMPS.delete(key);
        EVENT_SHAPE_STAMPS.set(key, stamp);
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const stampCtx = canvas.getContext('2d');
        stampCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        stampCtx.globalAlpha = ctx.globalAlpha;
        stampCtx.fillStyle = ctx.fillStyle;
        paintEventShape(stampCtx, rects, 0, 0, step);
        stamp = { canvas, pixels: width * height };
        while (EVENT_SHAPE_STAMPS.size && (EVENT_SHAPE_STAMPS.size >= EVENT_SHAPE_STAMP_LIMIT ||
            eventShapeStampPixels + stamp.pixels > EVENT_SHAPE_STAMP_PIXEL_LIMIT)) {
            const oldestKey = EVENT_SHAPE_STAMPS.keys().next().value;
            const oldest = EVENT_SHAPE_STAMPS.get(oldestKey);
            eventShapeStampPixels -= oldest.pixels;
            oldest.canvas.width = 0;
            oldest.canvas.height = 0;
            EVENT_SHAPE_STAMPS.delete(oldestKey);
        }
        EVENT_SHAPE_STAMPS.set(key, stamp);
        eventShapeStampPixels += stamp.pixels;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(stamp.canvas, Math.round(left * scaleX + transform.e), Math.round(top * scaleY + transform.f));
    ctx.restore();
}

function paintEventShape(ctx, rects, left, top, step) {
    for (const [rx, ry, width] of rects) ctx.fillRect(left + rx * step, top + ry * step, width * step, step);
}
export function eventShapeSvgPath(id) {
    return paths[id] || '';
}
export function eventShapeSvgViewBox(id) {
    return viewBoxes[id] || '0 0 16 16';
}
