// Wave 10 (10.1 Stage A, contract §0.1 / §4.1 / §4.2) — the WebGPU adapter and
// device. A device is requested with the adapter's own values for the limits
// the resident scene needs beyond the WebGPU defaults, plus `timestamp-query`
// when the adapter has it (the 0.1 ladder's GPU veto). A fallback adapter
// counts as software, exactly like a software WebGL2 rasterizer: the caller
// takes the Canvas world. Every rebuild re-requests the adapter (a consumed
// adapter cannot mint a second device).
import { isSoftwareRasterizer } from '../GpuWorldPolicy.js';

export const WEBGPU_RAISED_LIMITS = Object.freeze([
    'maxSampledTexturesPerShaderStage',
    'maxSamplersPerShaderStage',
    'maxInterStageShaderVariables',
    'maxColorAttachmentBytesPerSample',
    'maxStorageBuffersPerShaderStage',
]);

export function adapterInfo(adapter) {
    const info = adapter?.info || {};
    return {
        vendor: String(info.vendor || ''),
        architecture: String(info.architecture || ''),
        device: String(info.device || ''),
        description: String(info.description || ''),
        isFallbackAdapter: Boolean(info.isFallbackAdapter ?? adapter?.isFallbackAdapter),
    };
}

/** True for a fallback (software) adapter or one naming a software rasterizer. */
export function isSoftwareAdapter(adapter) {
    const info = adapterInfo(adapter);
    return info.isFallbackAdapter
        || isSoftwareRasterizer(`${info.vendor} ${info.architecture} ${info.device} ${info.description}`);
}

/**
 * A fresh adapter and device. Throws with a reason for every failure (no
 * `navigator.gpu`, no adapter, a fallback adapter, a rejected device request).
 */
export async function requestWebGpuDevice(adapterOptions = {}) {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) throw new Error('no-navigator-gpu');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance', ...adapterOptions });
    if (!adapter) throw new Error('no-adapter');
    if (isSoftwareAdapter(adapter)) {
        const error = new Error('fallback-adapter');
        error.softwareAdapter = true;
        throw error;
    }
    const requiredLimits = {};
    for (const name of WEBGPU_RAISED_LIMITS) {
        const value = adapter.limits?.[name];
        if (Number.isFinite(value)) requiredLimits[name] = value;
    }
    const requiredFeatures = adapter.features?.has?.('timestamp-query') ? ['timestamp-query'] : [];
    let device;
    try {
        device = await adapter.requestDevice({ requiredLimits, requiredFeatures, label: 'claudeville-world' });
    } catch (error) {
        throw new Error(`device-request-failed: ${error?.message || error}`);
    }
    if (!device) throw new Error('device-request-failed');
    return { adapter, device, info: adapterInfo(adapter), timestampQuery: device.features.has('timestamp-query') };
}

/**
 * §4.1 — the async probe: `{ available, adapter, device, isFallbackAdapter,
 * reason, info }`. Never throws.
 */
export async function probeWebGpu(adapterOptions = {}) {
    try {
        const { adapter, device, info } = await requestWebGpuDevice(adapterOptions);
        return { available: true, adapter, device, isFallbackAdapter: false, reason: null, info };
    } catch (error) {
        return {
            available: false,
            adapter: null,
            device: null,
            isFallbackAdapter: error?.softwareAdapter === true,
            reason: String(error?.message || error),
            info: null,
        };
    }
}
