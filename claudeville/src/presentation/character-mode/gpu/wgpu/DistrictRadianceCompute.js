// Pass-local 2.5D GI. Supply air-side, directly lit diffuse flux (linear RGB8),
// ordered [stratum][cellY][cellX][RGBA]. Layer 0 alpha is cell opacity. Slabs
// are two inclusive uint16 height intervals per cell; lower > upper is empty.
import { BUILDING_DEFS } from '../../../../config/buildings.js';
import { buildingCenterToWorld } from '../../Projection.js';
import { createUniformViews, writeUniforms } from '../wgsl/common.js';
import {
    DISTRICT_PARAMS, DISTRICT_RADIANCE_WGSL, DISTRICT_COURSES, RADIANCE_INTERVALS, RADIANCE_STRATA_H,
} from '../wgsl/radiance.js';

export const GI_FRONTIER_MASK_BIT = 1 << 5;
const CELL_COUNT = 256 * 256;
const FLUX_LAYER = CELL_COUNT * 4;
const sites = ['forge', 'portal'].map(type => buildingCenterToWorld(BUILDING_DEFS.find(b => b.type === type)));
export const DISTRICT_ORIGIN = Object.freeze([
    Math.round((sites[0].x + sites[1].x) / 32) * 16 - 512,
    Math.round((sites[0].y + sites[1].y) / 16) * 16 - 512, // Ground Y is twice projected Y.
]);

const slabBytes = CELL_COUNT * 8;
const fluxBytes = FLUX_LAYER * 3;
const cascadeBytes = 2 * 256 * 128 * 3 * 4;
const resolvedBytes = 2 * 64 * 64 * 3 * 4;
const uniformBytes = 4 * DISTRICT_PARAMS.size;
export const DISTRICT_MEMORY_BYTES = Object.freeze({
    slabs: slabBytes, fluxOpacity: fluxBytes, cascades: cascadeBytes, resolved: resolvedBytes, uniforms: uniformBytes,
    total: slabBytes + fluxBytes + cascadeBytes + resolvedBytes + uniformBytes,
});

function activeCells({ slabs, fluxOpacity }) {
    if (!(slabs instanceof Uint16Array) || slabs.length !== 4 * CELL_COUNT ||
        !(fluxOpacity instanceof Uint8Array) || fluxOpacity.length !== 3 * FLUX_LAYER) {
        throw new RangeError('Expected 256² RGBA16 slab cells and three 256² RGBA8 flux/opacity layers');
    }
    const rect = [256, 256, 0, 0];
    for (let i = 0; i < CELL_COUNT; i++) {
        let active = fluxOpacity[i * 4 + 3];
        for (let layer = 0; layer < 3 && !active; layer++) {
            const k = layer * FLUX_LAYER + i * 4;
            active = fluxOpacity[k] | fluxOpacity[k + 1] | fluxOpacity[k + 2];
        }
        if (active) {
            const x = i % 256, y = i >> 8;
            rect[0] = Math.min(rect[0], x);
            rect[1] = Math.min(rect[1], y);
            rect[2] = Math.max(rect[2], x + 1);
            rect[3] = Math.max(rect[3], y + 1);
        }
    }
    return rect;
}

export class DistrictRadianceCompute {
    constructor({ enabled = false } = {}) {
        this._enabled = enabled === true;
        this.release();
    }

    get enabled() { return this._enabled; }

    set enabled(value) {
        this._enabled = value === true;
        if (!this._enabled) this.release();
    }

    async prepare(device, { enabled = this.enabled, district = null } = {}) {
        this.release();
        this._enabled = enabled === true;
        if (!this.enabled) return this.getDiagnostics();
        const bounds = district ? activeCells(district) : [0, 0, 0, 0];
        const stage = globalThis.GPUShaderStage?.COMPUTE ?? 4;
        const tex = globalThis.GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 };
        const buf = globalThis.GPUBufferUsage ?? { COPY_DST: 8, UNIFORM: 64 };
        const generation = this.resources;
        try {
            const layout = device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: stage, buffer: { type: 'uniform', minBindingSize: DISTRICT_PARAMS.size } },
                { binding: 1, visibility: stage, texture: { sampleType: 'uint' } },
                { binding: 2, visibility: stage, storageTexture: { access: 'write-only', format: 'rgba8uint', viewDimension: '2d-array' } },
                ...[3, 4].map(binding => ({ binding, visibility: stage, texture: { sampleType: 'uint', viewDimension: '2d-array' } })),
            ] });
            const module = device.createShaderModule({ label: 'district-radiance', code: DISTRICT_RADIANCE_WGSL });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
            const pipeline = entryPoint => device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } });
            const pipelines = await Promise.all([pipeline('districtCascade'), pipeline('districtResolve')]);
            if (this.resources !== generation || !this.enabled) return this.getDiagnostics();
            this.device = device;
            [this.cascade, this.resolve] = pipelines;
            const createTexture = (label, format, size, usage) => {
                const texture = device.createTexture({ label, size, format, usage: tex.TEXTURE_BINDING | usage });
                this.resources.push(texture);
                return texture;
            };
            this.slabs = createTexture('district-slabs', 'rgba16uint', [256, 256, 1], tex.COPY_DST);
            this.flux = createTexture('district-flux-opacity', 'rgba8uint', [256, 256, 3], tex.COPY_DST);
            this.slabView = this.slabs.createView();
            this.fluxOpacityView = this.flux.createView();
            const pair = (name, w, h) => [0, 1].map(i =>
                createTexture(name + i, 'rgba8uint', [w, h, 3], tex.STORAGE_BINDING).createView());
            const scratch = pair('district-cascade', 256, 128);
            this.fields = pair('district-resolved', 64, 64);
            this.params = RADIANCE_INTERVALS.slice(0, -1).map(() => {
                const buffer = device.createBuffer({ size: DISTRICT_PARAMS.size, usage: buf.UNIFORM | buf.COPY_DST });
                this.resources.push(buffer);
                return buffer;
            });
            const group = (level, output, previous) => device.createBindGroup({ layout, entries: [
                { binding: 0, resource: { buffer: this.params[level] } },
                { binding: 1, resource: this.slabView }, { binding: 2, resource: output },
                { binding: 3, resource: previous }, { binding: 4, resource: this.fluxOpacityView },
            ] });
            this.groups = this.params.map((_, i) => group(i, scratch[i % 2], scratch[1 - i % 2]));
            this.resolveGroups = this.fields.map(view => group(0, view, scratch[0]));
            this._upload(district, bounds);
        } catch (error) {
            if (this.resources === generation) this.release();
            throw error;
        }
        return this.getDiagnostics();
    }

    _upload(district, bounds) {
        this.published = false; // The new slabs may close a previously open door.
        const queue = this.device.queue;
        if (district) {
            queue.writeTexture({ texture: this.slabs }, district.slabs, { bytesPerRow: 2048 }, [256, 256, 1]);
            queue.writeTexture({ texture: this.flux }, district.fluxOpacity, { bytesPerRow: 1024, rowsPerImage: 256 }, [256, 256, 3]);
        }
        const views = createUniformViews(DISTRICT_PARAMS.size);
        this.params.forEach((buffer, level) => {
            writeUniforms(DISTRICT_PARAMS, views, { level, activeCells: bounds });
            queue.writeBuffer(buffer, 0, views.buffer);
        });
    }

    setDistrict(district) {
        if (!this.device || !this.enabled) return;
        const bounds = activeCells(district);
        try {
            this._upload(district, bounds);
        } catch (error) {
            this.release();
            throw error;
        }
    }

    getCurrentFieldView() {
        return this.enabled && this.published ? this.fields[this.readIndex] : null;
    }

    // A single timestamp pair spans the four ordered dispatches and the resolve.
    encode(encoder, { dtSeconds = 0, reducedMotion = false, enabled = this.enabled, timestampWrites } = {}) {
        if (!enabled || !this.enabled) {
            if (this.enabled) this.enabled = false;
            return null;
        }
        if (!this.device || !encoder) return null;
        this.elapsedMs += Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds * 1000 : 0);
        if (this.revision && (reducedMotion ? this.published : this.elapsedMs < 250)) return this.getCurrentFieldView();
        const pass = encoder.beginComputePass({ label: 'district-radiance', timestampWrites });
        pass.setPipeline(this.cascade);
        for (let level = 3; level >= 0; level--) {
            pass.setBindGroup(0, this.groups[level]);
            pass.dispatchWorkgroups(32, 16, 3);
        }
        const next = this.readIndex ^ 1;
        pass.setPipeline(this.resolve);
        pass.setBindGroup(0, this.resolveGroups[next]);
        pass.dispatchWorkgroups(8, 8, 3);
        pass.end();
        this.elapsedMs %= 250;
        this.readIndex = next;
        this.revision++;
        this.published = true;
        return this.getCurrentFieldView();
    }

    getDiagnostics() {
        return {
            ready: !!this.device, revision: this.revision, origin: DISTRICT_ORIGIN,
            frontierMaskBit: this.getCurrentFieldView() ? GI_FRONTIER_MASK_BIT : 0,
            residentBytes: this.device ? DISTRICT_MEMORY_BYTES.total : 0,
        };
    }

    release() {
        for (const resource of this.resources ?? []) resource.destroy();
        this.resources = [];
        this.device = this.groups = this.resolveGroups = this.params = this.fields = null;
        this.slabs = this.flux = this.slabView = this.fluxOpacityView = this.cascade = this.resolve = null;
        this.readIndex = this.revision = this.elapsedMs = 0;
        this.published = false;
    }
}

export function createDistrictRadianceCompute(options) {
    return new DistrictRadianceCompute(options);
}

// Point oracle: only visit the cascade lanes feeding this receiver. Every memoized
// lane goes through the same RGBA8 rounding as an actual cascade texture store.
const transfer = {
    linear: c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    encoded: c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055,
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function land(base, bounce, role) {
    if (role !== 0 || !bounce.some(Boolean)) return [...base];
    let rgb = base.map((c, i) => transfer.encoded(Math.min(1, transfer.linear(c) + bounce[i] / 255)));
    const peak = Math.max(...rgb);
    if (peak >= 0.5) rgb = rgb.map(c => Math.max(c, peak * 0.35));
    const encodedScale = Math.min(1, 0.74 / Math.max(0.0001, luma(rgb)));
    rgb = rgb.map(c => c * encodedScale);
    const linearScale = Math.min(1, 0.70 / Math.max(0.0001, luma(rgb.map(transfer.linear))));
    let bytes = rgb.map(c => Math.floor(255 * c * linearScale));
    for (;;) {
        const hi = Math.max(...bytes);
        if (hi >= 128) bytes = bytes.map(c => Math.max(c, Math.ceil(hi * 0.35)));
        rgb = bytes.map(c => c / 255);
        if (luma(rgb) <= 0.74 && luma(rgb.map(transfer.linear)) <= 0.70) return rgb;
        bytes = bytes.map(c => Math.max(0, c - 1));
    }
}

function rayOffset(ray, count, radius) {
    const angle = (ray + 0.5) * 2 * Math.PI / count - Math.PI / 8;
    return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
}

/** x,y are ground coordinates (not projected screen y). base is encoded sRGB in [0,1]. */
export function evaluateDistrictRadianceReference(district, {
    x, y, height = 4, base = [0, 0, 0], role = 0,
}) {
    if (![x, y, height].every(Number.isFinite) || base?.length !== 3 ||
        !Array.from(base).every(c => Number.isFinite(c) && c >= 0 && c <= 1)) {
        throw new RangeError('Expected finite receiver coordinates and three normalized sRGB channels');
    }
    const bounds = activeCells(district);
    const { slabs, fluxOpacity } = district;
    function trace(ax, ay, az, bx, by, bz, layer, collect) {
        const hit = [0, 0, 0, 255];
        let cx = Math.floor(ax / 4), cy = Math.floor(ay / 4);
        const lx = Math.floor(bx / 4), ly = Math.floor(by / 4);
        if (Math.max(cx, lx) < bounds[0] || Math.max(cy, ly) < bounds[1] ||
            Math.min(cx, lx) >= bounds[2] || Math.min(cy, ly) >= bounds[3]) return hit;
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const sx = Math.sign(dx), sy = Math.sign(dy);
        const nx = Math.max(1, Math.abs(dx)), ny = Math.max(1, Math.abs(dy));
        const denominator = nx * ny;
        let tx = sx ? Math.abs(4 * (cx + Math.max(0, sx)) - ax) * ny : denominator + 1;
        let ty = sy ? Math.abs(4 * (cy + Math.max(0, sy)) - ay) * nx : denominator + 1;
        let t = 0;
        for (;;) {
            const end = Math.min(tx, ty, denominator);
            if (end > t && cx >= bounds[0] && cy >= bounds[1] && cx < bounds[2] && cy < bounds[3]) {
                const k = (cy * 256 + cx) * 4;
                const z0 = az + dz * t / denominator, z1 = az + dz * end / denominator;
                const low = Math.min(z0, z1), high = Math.max(z0, z1);
                for (const j of [k, k + 2]) {
                    if (slabs[j] <= slabs[j + 1] && low <= slabs[j + 1] && high >= slabs[j]) {
                        hit[3] = Math.floor((hit[3] * (255 - fluxOpacity[k + 3]) + 127) / 255);
                        break;
                    }
                }
                if (!hit[3]) break;
                if (collect) {
                    const source = layer * FLUX_LAYER + k;
                    if (fluxOpacity[source] || fluxOpacity[source + 1] || fluxOpacity[source + 2]) {
                        for (let i = 0; i < 3; i++) hit[i] = Math.floor((hit[3] * fluxOpacity[source + i] + 127) / 255);
                        hit[3] = 0;
                        break;
                    }
                }
            }
            if (end === denominator) break;
            if (tx === end) { cx += sx; tx += 4 * ny; }
            if (ty === end) { cy += sy; ty += 4 * nx; }
            t = end;
        }
        return hit;
    }

    const memo = new Map();
    function cascade(level, px, py, layer, ray) {
        const row = 64 >> level, count = 8 << (2 * level);
        const key = ((level * 3 + layer) * 32768) + (py * row + px) * count + ray;
        if (memo.has(key)) return memo.get(key);
        const pitch = 16 << level, h = RADIANCE_STRATA_H[layer];
        const cx = (px + 0.5) * pitch, cy = (py + 0.5) * pitch;
        const [dx, dy] = rayOffset(ray, count, RADIANCE_INTERVALS[level]);
        const merged = [0, 0, 0, 0];
        if (level === 3) {
            const [fx, fy] = rayOffset(ray, count, 512);
            const hit = trace(cx + dx, cy + dy, h, cx + fx, cy + fy, h, layer, true);
            for (let i = 0; i < 4; i++) merged[i] = 255 * hit[i];
        } else {
            const ax = cx / (2 * pitch) - 0.5, ay = cy / (2 * pitch) - 0.5;
            const fx = ax - Math.floor(ax), fy = ay - Math.floor(ay);
            for (let q = 0; q < 4; q++) {
                const qx = q & 1, qy = q >> 1;
                const ux = Math.max(0, Math.min(row / 2 - 1, Math.floor(ax) + qx));
                const uy = Math.max(0, Math.min(row / 2 - 1, Math.floor(ay) + qy));
                const w = 0.25 * (qx ? fx : 1 - fx) * (qy ? fy : 1 - fy);
                for (let child = ray * 4; child < ray * 4 + 4; child++) {
                    const [ex, ey] = rayOffset(child, count * 4, RADIANCE_INTERVALS[level + 1]);
                    const near = trace(cx + dx, cy + dy, h, (ux + 0.5) * 2 * pitch + ex, (uy + 0.5) * 2 * pitch + ey, h, layer, true);
                    for (let i = 0; i < 3; i++) merged[i] += w * 255 * near[i];
                    if (!near[3]) continue;
                    const far = cascade(level + 1, ux, uy, layer, child);
                    for (let i = 0; i < 4; i++) merged[i] += w * near[3] * far[i];
                }
            }
        }
        const packed = merged.map(v => Math.round(v / 255));
        memo.set(key, packed);
        return packed;
    }

    const localX = Math.floor(x - DISTRICT_ORIGIN[0]), localY = Math.floor(y - DISTRICT_ORIGIN[1]);
    const px = Math.floor(localX / 16), py = Math.floor(localY / 16);
    const cx = 16 * px + 8, cy = 16 * py + 8;
    const receiverH = Math.floor(height);
    const layer = receiverH > 52 ? 2 : receiverH > 16 ? 1 : 0;
    const h = RADIANCE_STRATA_H[layer];
    const inside = px >= 0 && px < 64 && py >= 0 && py < 64;
    const sky = Array(8).fill(inside ? 0 : 1);
    const energy = [0, 0, 0];
    let weight = 0;
    if (inside && trace(localX, localY, receiverH, cx, cy, h, layer, false)[3] === 255) {
        for (let ray = 0; ray < 8; ray++) {
            const own = cascade(0, px, py, layer, ray);
            for (let i = 0; i < 3; i++) energy[i] += own[i];
            weight++;
            const [dx, dy] = rayOffset(ray, 8, 1);
            const nx = px + dx, ny = py + dy;
            if (nx >= 0 && nx < 64 && ny >= 0 && ny < 64) {
                for (let adjacent = 0; adjacent < 3; adjacent++) {
                    if (adjacent === layer) continue;
                    const pitchWeight = 0.5 / Math.abs(adjacent - layer);
                    const visible = trace(cx, cy, h, nx * 16 + 8, ny * 16 + 8, RADIANCE_STRATA_H[adjacent], layer, false)[3];
                    weight += pitchWeight;
                    if (!visible) continue;
                    const pitched = cascade(0, nx, ny, adjacent, ray);
                    for (let i = 0; i < 3; i++) energy[i] += pitchWeight * Math.floor((visible * pitched[i] + 127) / 255);
                }
            }
            const [ex, ey] = rayOffset(ray, 8, 512);
            sky[ray] = Number(trace(cx, cy, h, cx + ex, cy + ey, h + 256, layer, false)[3] >= 128);
        }
    }
    const peak = Math.max(...energy) / Math.max(1, weight);
    const course = role === 0 ? Number(peak >= 2) + Number(peak >= 20) : 0;
    const swatch = energy[2] > energy[0] ? DISTRICT_COURSES.violet : DISTRICT_COURSES.warm;
    const bounce = swatch.map(c => course * c);
    return { stratum: h, course, bounce, encoded: land(base, bounce, role), emission: [0, 0, 0, 0],
        skyBins: sky, skyOpenness: sky.reduce((a, b) => a + b, 0) / 8 };
}
