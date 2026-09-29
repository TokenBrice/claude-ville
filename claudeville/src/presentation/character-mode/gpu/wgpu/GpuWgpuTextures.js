// Wave 10 (contract §2.8 / §3.3 / §9 decision 1) — WebGPU texture creation and
// the upload paths. Typed fields go through `queue.writeTexture` from the same
// typed arrays the WebGL2 path uploads. Canvas and image sources go through
// `copyExternalImageToTexture` with `premultipliedAlpha: false, flipY: false`:
// measured on Chrome 153 / ANGLE-Metal (output/waking-isle/WGPUCore/
// probe-bytes.html) it lands exactly the bytes WebGL2's
// `texImage2D(canvas|image)` with UNPACK_PREMULTIPLY_ALPHA false does (0 of
// 16,384 texels differ over every alpha 0-255), while a getImageData decode
// differs by 1 on 576 translucent texels — so this call *is* "the same decoded
// bytes" the WebGL2 backend uploads, and no atlas byte changes.
import { ALBEDO_PAGE_SIZE, GpuAlbedoPage, ShelfPacker } from '../GpuAlbedoPage.js';

export const WGPU_TEXTURE_FORMATS = Object.freeze({
    rgba8: Object.freeze({ gpuFormat: 'rgba8unorm', bytesPerTexel: 4, array: Uint8Array }),
    r8: Object.freeze({ gpuFormat: 'r8unorm', bytesPerTexel: 1, array: Uint8Array }),
    rg8: Object.freeze({ gpuFormat: 'rg8unorm', bytesPerTexel: 2, array: Uint8Array }),
    r16ui: Object.freeze({ gpuFormat: 'r16uint', bytesPerTexel: 2, array: Uint16Array }),
    rgba32f: Object.freeze({ gpuFormat: 'rgba32float', bytesPerTexel: 16, array: Float32Array }),
});

const usage = () => globalThis.GPUTextureUsage;

/** A sampled 2D texture; `external` adds what copyExternalImageToTexture demands. */
export function createWgpuTexture(device, width, height, format = 'rgba8', { external = false, layers = 1, label } = {}) {
    const spec = WGPU_TEXTURE_FORMATS[format];
    if (!spec) throw new Error(`unknown GPU texture format: ${format}`);
    const u = usage();
    return device.createTexture({
        label,
        size: [Math.max(1, width), Math.max(1, height), layers],
        format: spec.gpuFormat,
        dimension: '2d',
        usage: u.TEXTURE_BINDING | u.COPY_DST | u.COPY_SRC | (external ? u.RENDER_ATTACHMENT : 0),
    });
}

/**
 * Tightly packed rows into a texture (or one array layer) at `origin`.
 * `queue.writeTexture` takes any `bytesPerRow` (only buffer copies need the
 * 256-byte pitch), so the source rows go through unrepacked.
 */
export function writeTextureRows(device, texture, data, width, height, bytesPerTexel, { x = 0, y = 0, layer = 0 } = {}) {
    const byteView = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    device.queue.writeTexture(
        { texture, origin: { x, y, z: layer } },
        byteView,
        { offset: 0, bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
    );
}

/**
 * A canvas/image source (or its `sx, sy` sub-rect) into `texture` at `x, y`
 * (array `layer`), byte-for-byte as WebGL2's texImage2D/texSubImage2D.
 */
export function copySourceToTexture(device, texture, source, { sx = 0, sy = 0, width, height, x = 0, y = 0, layer = 0 } = {}) {
    device.queue.copyExternalImageToTexture(
        { source, origin: { x: sx, y: sy }, flipY: false },
        { texture, origin: { x, y, z: layer }, premultipliedAlpha: false, colorSpace: 'srgb' },
        { width, height, depthOrArrayLayers: 1 },
    );
}

/**
 * B.1b's albedo texture-array page on WebGPU: the shelf packing, placement and
 * repack policy are GpuAlbedoPage's own; only the allocation and the slot
 * uploads differ. A slot takes its source (or a patch) straight into its layer
 * through the same byte-exact external copy the 2D cache uses, so a paged
 * record samples the texels its unpaged twin would.
 */
export class GpuWgpuAlbedoPage extends GpuAlbedoPage {
    constructor(device) {
        super(null, 0);
        this.device = device;
        this.view = null;
    }

    _allocate(layers) {
        this.texture?.destroy?.();
        this.entries.clear();
        this._pending.length = 0;
        // WebGPU zero-fills a new texture: every gutter is transparent.
        this.texture = createWgpuTexture(this.device, ALBEDO_PAGE_SIZE, ALBEDO_PAGE_SIZE, 'rgba8', {
            external: true, layers, label: 'albedo-page',
        });
        this.view = this.texture.createView({ dimension: '2d-array' });
        this.layers = layers;
        this.packer = new ShelfPacker(ALBEDO_PAGE_SIZE, layers);
    }

    flushUploads() {
        const pending = this._pending;
        if (!pending.length) return 0;
        let bytes = 0;
        for (let index = 0; index < pending.length; index++) {
            const entry = pending[index];
            entry.pending = false;
            if (!entry.source) continue;
            if (entry.updates) {
                for (const update of entry.updates) {
                    const width = Math.floor(update.width || update.source.width);
                    const height = Math.floor(update.height || update.source.height);
                    copySourceToTexture(this.device, this.texture, update.source, {
                        sx: update.sx != null ? Math.floor(update.sx) : 0,
                        sy: update.sx != null ? Math.floor(update.sy || 0) : 0,
                        width,
                        height,
                        x: entry.x + Math.floor(update.x || 0),
                        y: entry.y + Math.floor(update.y || 0),
                        layer: entry.layer,
                    });
                    bytes += width * height * 4;
                }
            } else {
                copySourceToTexture(this.device, this.texture, entry.source, {
                    width: entry.width, height: entry.height, x: entry.x, y: entry.y, layer: entry.layer,
                });
                bytes += entry.width * entry.height * 4;
            }
            entry.updates = null;
            this.uploads++;
        }
        pending.length = 0;
        this.uploadBytes += bytes;
        return bytes;
    }

    release() {
        this.texture?.destroy?.();
        this.abandon();
    }

    abandon() {
        this.view = null;
        super.abandon();
    }
}
