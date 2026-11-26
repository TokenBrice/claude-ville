import palettes from '../../../assets/sprites/characters/roster-palettes.json' with { type: 'json' };
import anchors from '../../../assets/sprites/characters/anchors.json' with { type: 'json' };
import {
    bakeSpriteOutline, DAY_RIM_ALPHA, downsampleMajorityWithChannels, LOD_OUTLINE_ALPHA, OUTLINE_ALPHA,
    STRIP_HEAD_MATCHED, overlayOpaqueBounds, parseTrimColor, robeVariant, shiftRobeColor, sourceGeneration, trimIndex,
} from './Compositor.js';
import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES } from './SpriteSheet.js';
import { clearDetachedCodexWrench } from './CodexEngineerGrips.js';

export const PALETTE_LUT_WIDTH = 64;
export const PALETTE_LUT_HEIGHT = 256;
export function paletteIdentity(model, variant, teamTrim, ramp = []) {
    const trim = parseTrimColor(teamTrim) || parseTrimColor(ramp[trimIndex(variant, ramp.length)]);
    return { model, variant, trim, key: [model, variant, trim].join('|') };
}

export function writePaletteRow(row, { model, variant, trim }) {
    const palette = palettes.models[model];
    row.fill(0);
    if (!palette) return;
    const style = robeVariant(variant);
    palette.robeColors.forEach(([r, g, b, robeAnchor, trimAnchor], i) => {
        let rgb = [r, g, b];
        if (style.value !== 1 || style.hue !== 0) {
            rgb = shiftRobeColor(rgb, variant, palette.robeAnchors[robeAnchor]);
        } else if (trimAnchor >= 0 && trim) {
            const anchor = palette.trimAnchors[trimAnchor];
            rgb = rgb.map((v, c) => Math.max(0, Math.min(255, trim[c] + v - anchor[c])));
        }
        row.set([...rgb, 255], 4 * (1 + i));
    });
    palette.trimAnchors.forEach((rgb, i) => row.set([...rgb, 255], 4 * (32 + i)));
    if (trim) row.set([...trim, 255], 35 * 4);
}

export class AgentPaletteLutTable {
    constructor() {
        this.width = PALETTE_LUT_WIDTH;
        this.height = PALETTE_LUT_HEIGHT;
        this.format = 'rgba8';
        this.data = new Uint8Array(this.width * this.height * 4);
        for (let y = 0; y < 3; y++) {
            this.data.set(palettes.firelight.slice(y * 44, (y + 1) * 44), y * this.width * 4);
        }
        this.revision = 0;
        this.rows = new Map();
        this.used = new Set();
    }

    rowFor(identity) {
        let row = this.rows.get(identity.key);
        if (row !== undefined) {
            this.rows.delete(identity.key);
        } else {
            row = this.rows.size + 4;
            if (row >= this.height) {
                const oldest = this.rows.keys().next().value;
                if (this.used.has(oldest)) return 0;
                row = this.rows.get(oldest);
                this.rows.delete(oldest);
            }
            const offset = row * this.width * 4;
            writePaletteRow(this.data.subarray(offset, offset + this.width * 4), identity);
            this.revision++;
        }
        this.rows.set(identity.key, row);
        this.used.add(identity.key);
        return row;
    }
}
export const agentPaletteLut = new AgentPaletteLutTable();

// A record can still sample an evicted canvas until this frame is submitted.
let frameEpoch = 0;
const activeCellModels = new Map();

// A sheet reclaimed after submission would otherwise be uploaded in full on
// every frame. Keep sampling cells until this pose leaves the working set.
export function preferAgentModelCells(textureKey) {
    const key = textureKey.replace(/^(?:material:|emissive:|occluder:)?(?:agent-model:)?/, '');
    if (key.startsWith('agent.') && key.includes('|') && !key.includes('|cell:')) activeCellModels.set(key, frameEpoch);
}
export function finishAgentLayerFrame() {
    for (const [key, seen] of activeCellModels) if (seen < frameEpoch - 1) activeCellModels.delete(key);
    frameEpoch++;
}

class RasterCache {
    constructor(limit, pixels) {
        this.limit = limit;
        this.maxPixels = pixels;
        this.entries = new Map();
        this.pixels = 0;
    }
    canAdmitSheet(key, pixels) {
        if (this.entries.has(key)) return true;
        let total = this.pixels + pixels;
        let count = this.entries.size + 1;
        for (const entry of this.entries.values()) {
            if (total <= this.maxPixels && count <= this.limit) break;
            if (entry.epoch >= frameEpoch - 1) return false;
            total -= entry.pixels;
            count--;
        }
        return total <= this.maxPixels && count <= this.limit;
    }

    get(key, pixels, build) {
        let entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
        } else {
            const value = build();
            if (typeof pixels === 'function') pixels = pixels(value);
            entry = { pixels, value };
            if (pixels > this.maxPixels) return entry.value;
            while (this.entries.size >= this.limit || this.pixels + pixels > this.maxPixels) {
                const first = this.entries.keys().next().value;
                this.pixels -= this.entries.get(first).pixels;
                this.entries.delete(first);
            }
            this.pixels += pixels;
        }
        entry.epoch = frameEpoch;
        this.entries.set(key, entry);
        return entry.value;
    }
}
export const MODEL_BASE_CACHE = new RasterCache(24, 16_000_000);
const MODEL_TILE_CACHE = new RasterCache(256, 2_000_000);
const MODEL_GROUP_STRIP_CACHE = new RasterCache(48, 12_000_000);
const MODEL_LOD_CACHE = new RasterCache(40, 7_000_000);
export const CANVAS_CELL_CACHE = new RasterCache(512, 16.5 * 1024 * 1024 / 4);
const HAT_CACHE = new RasterCache(192, 65_536);
const GEAR_CACHE = new RasterCache(320, 2_000_000);

// Reserve the bounded pose tiles inside the same 80 MiB model budget.
const MODEL_SHEET_CACHES = [MODEL_GROUP_STRIP_CACHE, MODEL_LOD_CACHE, MODEL_BASE_CACHE];
const MODEL_SHEET_PIXELS = 80 * 1024 * 1024 / 4 - MODEL_TILE_CACHE.maxPixels;

function admitModelSheet(cache, key, pixels, activeCell) {
    if (cache.entries.has(key)) return true;
    if (activeCell && !cache.canAdmitSheet(key, pixels)) return false;
    let excess = MODEL_SHEET_CACHES.reduce((sum, store) => sum + store.pixels, pixels) - MODEL_SHEET_PIXELS;
    for (const store of MODEL_SHEET_CACHES) {
        if (excess <= 0) break;
        for (const [oldest, entry] of store.entries) {
            if (activeCell && entry.epoch >= frameEpoch - 1) break;
            store.entries.delete(oldest);
            store.pixels -= entry.pixels;
            excess -= entry.pixels;
            if (excess <= 0) break;
        }
    }
    return excess <= 0;
}

function surface(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    return ctx;
}

function slice(source, y, width, height, x = 0) {
    const ctx = surface(width, height);
    ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
    return ctx;
}

// The optional material pack may still be loading on first draw. Recover its
// exact index from the authored dictionary until the registered sidecar lands.
const fallbackCodes = new Map();
function colorCode(model, r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let codes = fallbackCodes.get(model);
    if (!codes) {
        codes = new Map();
        palettes.models[model]?.robeColors.forEach(([r,g,b], i) => codes.set((r<<16)|(g<<8)|b, i+1));
        fallbackCodes.set(model, codes);
    }
    if (codes.has(key)) return codes.get(key);
    const trim = palettes.models[model]?.trimAnchors.findIndex(a =>
        Math.abs(r-a[0]) <= 12 && Math.abs(g-a[1]) <= 12 && Math.abs(b-a[2]) <= 12) ?? -1;
    const code = trim < 0 ? 0 : 32 + trim;
    codes.set(key, code);
    return code;
}

export function modelLayerSheet(assets, model, strip, group, scrub, pack, activeCell = null, lod = false) {
    const image = strip?.image || assets.get(model);
    if (!image?.width) return null;
    const channel = name => strip ? strip.channels?.[name] : assets.getSidecar?.(model, name);
    const material = channel('material'), occluder = channel('occluder'), emission = channel('emissive');
    const cell = image.width / DIRECTIONS.length;
    const [first, last] = strip?.meta.groups[group].rows || [0, image.height / cell - 1];
    let x = 0, y = first * cell, width = image.width, height = (last - first + 1) * cell;
    let cache = lod ? MODEL_LOD_CACHE : strip ? MODEL_GROUP_STRIP_CACHE : MODEL_BASE_CACHE;
    let key = [model, group, !!scrub, ...[image, material, occluder, emission].map(sourceGeneration), lod].join('|');
    const planes = lod ? 0.5 : (emission && strip ? 3 : 2);
    // A crowded frame cannot keep 40 full pairs inside the byte cap. Keep
    // active cold cells shared by model and pose instead of evicting live sheets.
    const gpuCell = activeCell && activeCellModels.has(key);
    if (gpuCell || !admitModelSheet(cache, key, width * height * planes, activeCell)) {
        if (gpuCell) activeCellModels.set(key, frameEpoch);
        if (!activeCell) return null;
        x = activeCell.sx;
        y = activeCell.sy;
        width = height = cell;
        key += '|cell:' + x + ',' + y;
        cache = MODEL_TILE_CACHE;
    }
    const cropped = width !== image.width || height !== image.height;
    const pixels = width * height * (lod ? 0.5 : cropped && emission ? 3 : 2);
    return cache.get(key, pixels, () => {
        const ctx = slice(image, y, width, height, x);
        if (!strip && model === 'agent.codex.gpt54') {
            ctx.save();
            ctx.translate(-x, -y);
            clearDetachedCodexWrench(ctx, image.width, image.height);
            ctx.restore();
        }
        if (scrub) scrub(ctx, width, height, x, y, cell);
        const body = ctx.getImageData(0, 0, width, height).data;
        const read = source => source && slice(source, y, width, height, x).getImageData(0, 0, width, height).data;
        const packed = pack(read(material), read(occluder), width * height, true);
        for (let i = 0; i < body.length; i += 4) {
            if (body[i + 3] < 16) {
                if (packed[i + 3]) packed.fill(0, i, i + 4);
            } else if (!material) {
                packed[i] = 255;
                packed[i + 2] |= colorCode(model, body[i], body[i + 1], body[i + 2]) << 1;
                packed[i + 3] = 255;
            }
        }
        if (lod) {
            const half = surface(width / 2, height / 2), geo = surface(width / 2, height / 2);
            const color = half.createImageData(width / 2, height / 2), codes = geo.createImageData(width / 2, height / 2);
            downsampleMajorityWithChannels(body, width, color.data, width / 2, height / 2, cell, packed, codes.data);
            half.putImageData(color, 0, 0);
            geo.putImageData(codes, 0, 0);
            bakeSpriteOutline(half, width / 2, height / 2, cell / 2, LOD_OUTLINE_ALPHA);
            return { source: half.canvas, geometry: geo.canvas, emission: null, key, x, y };
        }
        const geo = surface(width, height);
        geo.putImageData(new ImageData(packed, width, height), 0, 0);
        bakeSpriteOutline(ctx, width, height, cell);
        return { source: ctx.canvas, geometry: geo.canvas, key, x, y,
            emission: emission && cropped ? slice(emission, y, width, height, x).canvas : emission || null };
    });
}

export function recolorCellBytes(data, packed, row, day, material = null, model = null) {
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i+3];
        const rim = alpha > 102 && alpha < 153 && Math.max(data[i],data[i+1],data[i+2]) <= 40;
        const code = packed ? (packed[i+2] >> 1) & 63 : alpha < 16 || rim ? 0 :
            material ? material[i+1] & 63 : colorCode(model, data[i], data[i+1], data[i+2]);
        if (code && code < 32) {
            const j = code * 4;
            data[i] = row[j];
            data[i+1] = row[j+1];
            data[i+2] = row[j+2];
        } else if (code >= 32 && code <= 34 && row[143]) {
            for (let c = 0; c < 3; c++) data[i+c] = Math.min(255, Math.max(0, data[i+c] + row[140+c] - row[code*4+c]));
        }
        if (day && rim) data[i+3] = DAY_RIM_ALPHA;
    }
}

export function canvasBodyCell(sheet, cell, identity, day = true) {
    const {sx, sy, sw, sh} = cell;
    const key = [sheet.key, identity.key, sx, sy, sw, sh, day].join('|');
    return CANVAS_CELL_CACHE.get(key, sw*sh, () => {
        const image = sheet.source.getContext('2d').getImageData(sx, sy, sw, sh);
        const packed = sheet.geometry.getContext('2d').getImageData(sx, sy, sw, sh).data;
        const row = new Uint8Array(256);
        writePaletteRow(row, identity);
        recolorCellBytes(image.data, packed, row, day);
        const ctx = surface(sw, sh);
        ctx.putImageData(image, 0, 0);
        return ctx.canvas;
    });
}

// Canvas and Dashboard read one active cell, including when the optional
// material sidecar has not arrived. Source generations invalidate lazy loads.
export function canvasPoseCell(assets, identity, source, cell, strip = null, scrub = null) {
    const model = identity.model;
    if (!source) return null;
    const material = strip ? strip.channels?.material : assets.getSidecar?.(model, 'material');
    const { sx, sy, sw, sh } = cell;
    const size = source.width / DIRECTIONS.length;
    const key = [sourceGeneration(source), sourceGeneration(material), identity.key, sx, sy, sw, sh, !!scrub].join('|');
    return CANVAS_CELL_CACHE.get(key, sw*sh, () => {
        const ctx = surface(sw, sh);
        // Outline the whole cell before clipping a sitter at the seat line.
        const raw = sh < size ? surface(size, size) : ctx;
        raw.drawImage(source, sx, sy, size, size, 0, 0, size, size);
        if (!strip && model === 'agent.codex.gpt54') {
            raw.save();
            raw.translate(-sx, -sy);
            clearDetachedCodexWrench(raw, source.width, source.height);
            raw.restore();
        }
        if (scrub) scrub(raw, size, size, sx, sy, size);
        bakeSpriteOutline(raw, size, size, size);
        if (raw !== ctx) ctx.drawImage(raw.canvas, 0, 0);
        let codes = null;
        if (material) {
            const m = surface(sw,sh);
            m.drawImage(material,sx,sy,sw,sh,0,0,sw,sh);
            codes = m.getImageData(0,0,sw,sh).data;
        }
        const image = ctx.getImageData(0,0,sw,sh);
        const row = new Uint8Array(256);
        writePaletteRow(row, identity);
        recolorCellBytes(image.data, null, row, true, codes, model);
        ctx.putImageData(image, 0, 0);
        return ctx.canvas;
    });
}

// The padded input leaves room for the side rim and two contact-shadow rows.
export function outlineHat(data, w, h, rimAlpha = OUTLINE_ALPHA) {
    const bottoms = new Int16Array(w).fill(-1);
    const opaque = new Uint8Array(w*h);
    for (let i = 0; i < opaque.length; i++) if (data[4*i+3] >= 16) {
        opaque[i] = 1;
        bottoms[i%w] = Math.floor(i/w);
    }
    const bounds = overlayOpaqueBounds(data, w, h);
    if (!bounds) return;
    // The stamp has a transparent padded perimeter. Four-way reachability
    // keeps the visor, wreath and other enclosed openings clear.
    const exterior = new Uint8Array(w*h);
    const queue = [];
    function visit(i) {
        if (!opaque[i] && !exterior[i]) {
            exterior[i] = 1;
            queue.push(i);
        }
    }
    for (let x = 0; x < w; x++) { visit(x); visit((h-1)*w+x); }
    for (let y = 1; y < h-1; y++) { visit(y*w); visit(y*w+w-1); }
    for (let next = 0; next < queue.length; next++) {
        const i = queue[next];
        if (i % w) visit(i-1);
        if (i % w < w-1) visit(i+1);
        if (i >= w) visit(i-w);
        if (i+w < exterior.length) visit(i+w);
    }
    const inset = Math.floor((bounds.right-bounds.left+1)*0.15);
    for (let x = 0; x < w; x++) {
        const bottom = bottoms[x];
        const side = Math.max(bottoms[x-1] ?? -1, bottoms[x+1] ?? -1);
        for (let y = 0; y < h; y++) {
            const i = y*w+x;
            if (!exterior[i]) continue;
            if (bottom >= 0 && x >= bounds.left+inset && x <= bounds.right-inset && y > bottom && y <= bottom+2) {
                data.set([0,0,0,56], 4*i);
            } else if (y <= (bottom < 0 ? side : bottom) && (opaque[i+w] || opaque[i-w] || (x && opaque[i-1]) || (x+1 < w && opaque[i+1]))) {
                data.set([28,20,16,rimAlpha], 4*i);
            }
        }
    }
}

// LampSilhouette samples alpha >= 0.3. Thresholding each attachment first
// makes their union exactly the threshold of max(body, hat, weapons).
function lampCoverage(image, width, height, x = 0, y = 0) {
    let soft = false;
    for (let i = 3; i < image.data.length; i += 4) {
        if (image.data[i] > 0 && image.data[i] < 77) {
            image.data[i] = 0;
            soft = true;
        }
    }
    if (!soft) return null;
    const ctx = surface(width, height);
    ctx.putImageData(image, -x, -y);
    return ctx.canvas;
}

export function headLayer(compositor, model, accessory, palette, group, frame, dir, scale = 1, day = false) {
    if (!accessory || !compositor.accessoryImage) return null;
    const direction = DIRECTIONS[dir];
    const apex = anchors.models[model]?.headApex[group]?.[direction]?.[frame];
    if (!apex) return null;
    const back = ['n','ne','nw'].includes(direction);
    const stamp = compositor.accessoryImage(accessory, palette, back);
    if (!stamp) return null;
    const key = [stamp.key, scale, day].join('|');
    const w = Math.ceil(stamp.image.width * scale), h = Math.ceil(stamp.height * scale);
    const width = w + 2, height = h + 3;
    const source = HAT_CACHE.get(key, canvas => width * height * (canvas.__cvLampCoverage ? 2 : 1), () => {
        const ctx = surface(width, height);
        if (scale === 0.5) {
            const raw = surface(w * 2, h * 2);
            raw.drawImage(stamp.image, 0, 0, stamp.image.width, stamp.height, 0, 0, stamp.image.width, stamp.height);
            const dst = ctx.createImageData(w, h);
            downsampleMajorityWithChannels(raw.getImageData(0, 0, w * 2, h * 2).data, w * 2, dst.data, w, h, Math.max(w, h) * 2);
            ctx.putImageData(dst, 1, 1);
        } else ctx.drawImage(stamp.image, 0, 0, stamp.image.width, stamp.height, 1, 1, w, h);
        const pixels = ctx.getImageData(0, 0, width, height);
        outlineHat(pixels.data, width, height, day ? DAY_RIM_ALPHA : scale === 1 ? OUTLINE_ALPHA : LOD_OUTLINE_ALPHA);
        ctx.putImageData(pixels, 0, 0);
        if (!day) ctx.canvas.__cvLampCoverage = lampCoverage(pixels, width, height);
        return ctx.canvas;
    });
    const size = DEFAULT_CELL * scale;
    let x = Math.round((apex[0] - stamp.anchor[0]) * scale) - 1;
    let y = Math.round((apex[1] + 1 + Number(back) - stamp.anchor[1]) * scale) - 1;
    if (STRIP_HEAD_MATCHED.has(model) && stamp.bounds) {
        x = Math.min(Math.max(x, -1 - Math.floor(stamp.bounds.left * scale)), size - 2 - Math.floor(stamp.bounds.right * scale));
        y = Math.max(y, -1 - Math.floor(stamp.bounds.top * scale));
    }
    const sx = Math.max(0, -x), sy = Math.max(0, -y);
    const sw = Math.min(width - sx, size - Math.max(0, x));
    const sh = Math.min(height - sy, size - Math.max(0, y));
    return sw > 0 && sh > 0 ? { source, key, sx, sy, sw, sh, x: Math.max(0, x), y: Math.max(0, y) } : null;
}

function halfWeaponStamp(full, wrist, key) {
    if (!full) return null;
    // Retain the measured wrist as the pixel-grid origin during the LOD vote.
    const [wx, wy] = wrist || [0, 0];
    const left = Math.floor((full.x - wx) / 2);
    const top = Math.floor((full.y - wy) / 2);
    const w = Math.ceil((full.x - wx + full.source.width) / 2) - left;
    const h = Math.ceil((full.y - wy + full.source.height) / 2) - top;
    const raw = surface(2 * w, 2 * h);
    raw.drawImage(full.source, full.x - wx - 2 * left, full.y - wy - 2 * top);
    const ctx = surface(w, h);
    const dst = ctx.createImageData(w, h);
    const pixels = raw.getImageData(0, 0, 2 * w, 2 * h).data;
    downsampleMajorityWithChannels(pixels, 2 * w, dst.data, w, h, 2 * Math.max(w, h));
    ctx.putImageData(dst, 0, 0);
    ctx.canvas.__cvLampCoverage = lampCoverage(dst, w, h);
    return { source: ctx.canvas, key, x: Math.round(wx / 2) + left, y: Math.round(wy / 2) + top };
}

export function equipmentLayer(sprite, identity, geometry, layer) {
    const equipment = sprite._runtimeCodexEquipment(identity);
    if (!equipment) return null;
    const model = identity.spriteId;
    const { cell, poseGroup, poseFrame, drawScale } = geometry;
    const image = sprite._equipmentAssetId && sprite.assets?.get?.(sprite._equipmentAssetId);
    const key = [model, equipment, sprite.assets?.assetVersion, sourceGeneration(image),
        sprite.direction, cell.sx, cell.sy, poseGroup, poseFrame, drawScale, layer].join('|');
    const stampPixels = stamp => stamp ? (stamp.source.__cvLampCoverage ? 2 : 1) * stamp.source.width * stamp.source.height : 0;
    return GEAR_CACHE.get(key, stampPixels, () => {
        if (drawScale === 0.5) {
            const full = equipmentLayer(sprite, identity, { ...geometry, drawScale: 1 }, layer);
            const pose = poseGroup ? { group: poseGroup, frame: poseFrame } : headPose(cell);
            const track = anchors.models[model];
            const wrist = (track?.wristR || track?.wristL)?.[pose.group]?.[DIRECTIONS[sprite.direction]]?.[pose.frame];
            return halfWeaponStamp(full, wrist, key);
        }
        const pad = Math.ceil(32 * drawScale);
        const size = Math.ceil(DEFAULT_CELL * drawScale) + 2 * pad;
        const ctx = surface(size, size);
        sprite._drawCodexEquipment(ctx, identity, { ...geometry, dx: pad, dy: pad }, layer);
        const pixels = ctx.getImageData(0, 0, size, size);
        const bounds = overlayOpaqueBounds(pixels.data, size, size);
        if (!bounds) return null;
        const width = bounds.right - bounds.left + 1;
        const height = bounds.bottom - bounds.top + 1;
        const cropped = slice(ctx.canvas, bounds.top, width, height, bounds.left);
        cropped.canvas.__cvLampCoverage = lampCoverage(pixels, width, height, bounds.left, bounds.top);
        return { source: cropped.canvas, key, x: bounds.left - pad, y: bounds.top - pad };
    });
}

export function layerRecord(body, stamp, name, g) {
    if (!stamp) return null;
    const {source} = stamp;
    return { id: body.id+'-'+name, stableKey: body.stableKey, textureKey: name+'|'+stamp.key,
        source, sx: stamp.sx || 0, sy: stamp.sy || 0, sw: stamp.sw || source.width, sh: stamp.sh || source.height,
        width: stamp.sw || source.width, height: stamp.sh || source.height,
        x: g.dx+stamp.x, y: g.dy+stamp.y, alpha: body.alpha, material: body.material,
        elevation: body.elevation, shadeExempt: body.shadeExempt, sharedLayer: true };
}

const LAYER_ORDER = [
    ['seatBack', 0], ['weaponBack', 1], ['body', 2], ['hat', 3], ['frost', 4], ['snow', 4],
    ['weaponFront', 5], ['seatFront', 6], ['candle', 6], ['lantern', 6], ['tankard', 6],
];

export function agentLayerRecords(sources) {
    const records = [];
    for (const [name, layer] of LAYER_ORDER) {
        const record = sources[name];
        if (record) {
            record.layer = layer;
            records.push(record);
        }
    }
    return records;
}

export function headPose(cell, group, first = 0) {
    const row = Math.floor(cell.sy / DEFAULT_CELL);
    return { group: group || (row < WALK_FRAMES ? 'walk' : 'idle'), frame: group ? row-first : row < WALK_FRAMES ? row : row-WALK_FRAMES };
}

export function layerCacheStats() {
    return {
        canvasCellBytes: CANVAS_CELL_CACHE.pixels * 4,
        canvasCells: CANVAS_CELL_CACHE.entries.size,
        modelSheetBytes: MODEL_SHEET_CACHES.reduce((sum, store) => sum + store.pixels * 4, 0),
        modelBaseBytes: (MODEL_BASE_CACHE.pixels + MODEL_TILE_CACHE.pixels) * 4,
        layerCacheBytes: [MODEL_BASE_CACHE, MODEL_TILE_CACHE, MODEL_GROUP_STRIP_CACHE, MODEL_LOD_CACHE, CANVAS_CELL_CACHE, HAT_CACHE, GEAR_CACHE]
            .reduce((sum, store) => sum + store.pixels * 4, 0),
    };
}

export function clearLayerCaches() {
    activeCellModels.clear();
    for (const store of [MODEL_BASE_CACHE, MODEL_TILE_CACHE, MODEL_GROUP_STRIP_CACHE, MODEL_LOD_CACHE, CANVAS_CELL_CACHE, HAT_CACHE, GEAR_CACHE]) {
        store.entries.clear();
        store.pixels = 0;
    }
}

export function avatarIdleCell(compositor, model, palette, variant, accessory, teamTrim) {
    const source = compositor.assets.get(model);
    if (!source?.width) return null;
    const size = source.width / DIRECTIONS.length;
    const identity = paletteIdentity(model, variant, teamTrim, compositor.assets.palettes?.[palette]?.trim);
    const body = canvasPoseCell(compositor.assets, identity, source, { sx: 0, sy: WALK_FRAMES*size, sw: size, sh: size });
    const hat = headLayer(compositor, model, accessory, palette, 'idle', 0, 0, 1, true);
    return bodyWithHead(body, hat);
}

export function bodyWithHead(body, hat) {
    if (!hat) return body;
    const key = [sourceGeneration(body), hat.key, hat.x, hat.y].join('|');
    return CANVAS_CELL_CACHE.get(key, body.width*body.height, () => {
        const ctx = surface(body.width, body.height);
        ctx.drawImage(body,0,0);
        ctx.drawImage(hat.source, hat.sx, hat.sy, hat.sw, hat.sh, hat.x, hat.y, hat.sw, hat.sh);
        return ctx.canvas;
    });
}

// Palette overflow keeps the current frame's admitted rows intact. Recode
// geometry to the legacy strength byte once for the CPU-resolved cell.
export function canvasOverflowRecord(record) {
    const { sx, sy, sw, sh, materialSource, emissiveSource, textureKey, paletteIdentity } = record;
    const sheet = { source: record.source, geometry: materialSource, key: textureKey };
    record.source = canvasBodyCell(sheet, record, paletteIdentity, false);
    const key = [textureKey, 'overflow', sx, sy, sw, sh].join('|');
    const channels = MODEL_TILE_CACHE.get(key, sw * sh * (emissiveSource ? 2 : 1), () => {
        const ctx = slice(materialSource, sy, sw, sh, sx);
        const image = ctx.getImageData(0, 0, sw, sh);
        for (let i = 2; i < image.data.length; i += 4) image.data[i] = (image.data[i] & 1) * 255;
        ctx.putImageData(image, 0, 0);
        return { materialSource: ctx.canvas, emissiveSource: emissiveSource && slice(emissiveSource, sy, sw, sh, sx).canvas };
    });
    Object.assign(record, channels, { sx: 0, sy: 0, sourceWidth: sw, sourceHeight: sh,
        textureKey: key + '|' + paletteIdentity.key, sidecarKey: key });
}
