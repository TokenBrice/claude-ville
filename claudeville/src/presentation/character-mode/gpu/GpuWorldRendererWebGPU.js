import { preferAgentModelCells } from '../AgentLayerRecords.js';
import { evictableAgentTexture, captureRecordWords, RAIN_LAYER_TABLE } from './GpuWorldRenderer.js';
// Wave 10 (10.1 Stage A) — the resident world on WebGPU, behind WebGL2 and
// opt-in (`?renderer=webgpu`). The same interface as GpuWorldRenderer (contract
// §4.4) over the same inputs: GpuSceneBuilder's record stream batched by
// `buildStableGpuBatches`, staged by GpuRecordLayout (72-byte records, one
// storage buffer per frame, each batch drawn from its slice through
// firstInstance), and every per-frame value resolved by GpuFrameState — this
// file uploads, it never re-derives frame state. Shaders are the WGSL twins in
// gpu/wgsl/ (index.js). Uploads land the bytes WebGL2 uploads (wgpu/
// GpuWgpuTextures.js). Declared exclusion: the 2.10 radiance solve is not
// ported (off at every ladder level; `radianceBounce: false`).
import {
    buildStableGpuBatches,
    CLOUD_TILE_SIZE,
    createGpuTimingMetricsScratch,
    DAYTIME_WORK_BLOOM_CORE,
    DAYTIME_WORK_BLOOM_STRENGTH,
    effectBudgetMode,
    EFFECT_BUDGET,
    GPU_PARTICLE_INSTANCE_BYTES,
    GPU_RECORD_FLAGS,
    gpuRecordPageable,
    hasActiveBloomEmitters,
    LIGHT_TILE_STRIDE,
    selectGpuTimingMetrics,
    resolveFrontierPolicy,
    shedEffectsForLevel,
} from './GpuWorldPolicy.js';
import {
    cloudTile,
    createAtmosphereCourses,
    createLightFrameState,
    createPuddleUniforms,
    createSeaWeather,
    createWaterFx,
    resolveAtmosphereCourses,
    resolveCamera,
    resolveFatPixels,
    resolveFrameGrade,
    resolveFrontierFrame,
    resolveDiurnalFrame,
    resolveLights,
    resolveMist,
    resolveMistBurn,
    resolveSeaState,
    createSeaState,
    resolveOccluderChannel,
    resolvePaletteLut,
    agentPaletteLut,
    PALETTE_LUT_WIDTH,
    PALETTE_LUT_HEIGHT,
    resolvePuddles,
    resolveSeaWeather,
    resolveWaterFx,
    resolveWeatherUniform,
} from './GpuFrameState.js';
import { createRecordStaging, RECORD_INSTANCE_BYTES, stageGpuRecords } from './GpuRecordLayout.js';
import { ALBEDO_PAGE_GUTTER, ALBEDO_PAGE_SIZE } from './GpuAlbedoPage.js';
import { coastFieldTexels, mirrorStormDrop, openSeaHazeRows, openSeaSky, openSeaSquall, waterMoodFor } from '../CoastBake.js';
import { createPostFxLadder, POST_FX_LEVELS } from '../postfx/PostFxLadder.js';
import { NEUTRAL_SOURCE_ENERGY, sourceEnergyFor } from '../AtmosphereState.js';
import { particleMotifMask } from '../ParticleSystem.js';
import { CUE_RUN_VERTICES, GROUND_CUE_TEXTURE_KEY } from '../GroundCueRecords.js';
import {
    BATCH_UNIFORM_LAYOUT,
    BATCH_UNIFORM_STRIDE,
    BLOOM_BINDING,
    DEBUG_LOAD_BINDING,
    FRAME_UNIFORM_LAYOUT,
    assembleScene,
    createUniformViews,
    writeBatchUniforms,
    writeFrameUniforms,
} from './wgsl/index.js';
import { SCENE_WGSL, sceneWgsl } from './wgsl/scene.js';
import { BATCH_BINDING, COMPOSITE_BINDING, FRAME_BINDING } from './wgsl/common.js';
import { COMPOSITE_ROLES_BINDING } from './wgsl/composite.js';
import { HDR_HIGHLIGHT_MODES, HDR_HIGHLIGHTS_DEFAULT, hdrLampsLit, resolveDisplayColor } from '../DisplayColor.js';
import { adapterInfo, probeWebGpu, requestWebGpuDevice } from './wgpu/GpuDeviceManager.js';
import {
    BLEND_NORMAL, BLEND_NORMAL_ROLE,
    BLOOM_FORMAT,
    LIGHT_RECORD_BUFFER_BYTES,
    SCENE_COLOR_FORMAT,
    SCENE_DEPTH_FORMAT,
    SCENE_EMISSION_FORMAT,
    prepareWorldPipelines,
    prepareSurfacePipelines,
    prepareWorldWaterResolve,
    prepareEmberPipelines,
} from './wgpu/GpuWgpuPipelines.js';
import {
    copySourceToTexture,
    createWgpuTexture,
    GpuWgpuAlbedoPage,
    WGPU_TEXTURE_FORMATS,
    writeTextureRows,
} from './wgpu/GpuWgpuTextures.js';
import { PlanarWaterPass, bayerCollarSelect, isMirrorAdmittedRecord, srgb8ToLinear16 } from './wgpu/PlanarWaterPass.js';
import { RAIN_GROUND_CELL } from '../WeatherRenderer.js';
import { WaterRippleCompute, RIPPLE_FIXED_DT, RIPPLE_GRID_WIDTH, RIPPLE_GRID_HEIGHT } from './wgpu/WaterRippleCompute.js';
import { WindFieldCompute, WIND_EMBER_MAX_CAPACITY, WIND_WORLD_BOUNDS } from './wgpu/WindFieldCompute.js';
import { VolumetricShaftsPass } from './wgpu/VolumetricShaftsPass.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../../config/constants.js';
import { GpuWgpuTimer } from './wgpu/GpuWgpuTimestamps.js';
import { waterMaxSaturation } from '../GradeEvaluator.js';
import { resolveFirelight } from './Firelight.js';
import { resolveSunShade } from './SunShade.js';
import { GpuFrameReuse, stageGpuFrameBindings } from './GpuFrameReuse.js';
import { createGpuRainField, gpuRainField, rainSplashMask } from '../WeatherRenderer.js';
import { lookStrength } from '../LookStrengths.js';
import { assembleRain, RAIN_BINDING, RAIN_UNIFORM_BYTES } from './wgsl/rain.js';

export { probeWebGpu };

const SCENE_DEPTH_BYTES_PER_PIXEL = EFFECT_BUDGET['particle-depth'].cost.attachmentBytesPerPixel;
const MAX_PARTICLE_INSTANCES = 240;
const BLOOM_SCALE = 0.375;
// Keep recently used optional targets through brief ladder/light changes.
const TARGET_RETENTION_MS = 5000;
const EMA_ALPHA = 0.1;
// The same evictable-source ceiling as the WebGL2 cache (GpuWorldRenderer).
const PALETTE_LUT_BYTES = PALETTE_LUT_WIDTH * PALETTE_LUT_HEIGHT * 4;
const SPILL_FIELD_BYTES = 256 * 144 * 4 * 2;
const MAX_CACHED_TEXTURE_BYTES = 160 * 1024 * 1024 - PALETTE_LUT_BYTES - SPILL_FIELD_BYTES;
const MAX_CACHED_TEXTURES = 512;
const GPU_PASS_NAMES = ['upload', 'scene', 'bloom', 'present'];
const PASS_RING_CAPACITY = 32;
const GPU_TIMER_EVERY = 4;
const GPU_TIMER_DENSE_MISS_SHARE = 0.1;
const GPU_TIMER_RING = 30;
const DRAIN_TIMEOUT_MS = 2000;
const ZERO4 = Object.freeze([0, 0, 0, 0]);
// Bytes per texel of the colour formats this renderer allocates or presents.
const TEXEL_BYTES = Object.freeze({ rgba8unorm: 4, bgra8unorm: 4, 'rgba8unorm-srgb': 4, 'bgra8unorm-srgb': 4, rgba16float: 8, rgba32float: 16 });
const texelBytes = format => TEXEL_BYTES[format] ?? 4;

const FRONTIER_BITS = Object.freeze({ mirror: 1, ripples: 2, surfaceDepth: 4, wind: 8, shafts: 16, gi: 32 });
const FRONTIER_PASSES = { mirror: PlanarWaterPass, ripples: WaterRippleCompute, wind: WindFieldCompute, shafts: VolumetricShaftsPass };

function defaultFrontier(canvas, option) {
    const query = new URLSearchParams(globalThis.location?.search);
    if (query.get('frontier') === '0' || query.has('debugCaptureTargets')) return false;
    if (globalThis.document?.documentElement?.dataset?.cvProfile === 'mobile') return false;
    return option ?? (query.get('frontier') === '1' || (Boolean(canvas?.ownerDocument) && !query.has('sim')));
}

// Match the rain vertex shader so each impulse lands at its drop's ground cell.
function rainCellHash(value) {
    let x = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
}

// The Frontier variant keeps the flat rain field's hash, shape and admission,
// and reconstructs each exposed landing before projecting its fall and depth.
async function prepareTerraceRain(device, layouts, roles, pipelines) {
    const code = assembleRain()
        .replace('let ground =', 'let plan =')
        .replace('  let phase =', `
  let isoPlan = vec2f(plan.y * 2.0 + plan.x, plan.y * 2.0 - plan.x) / 64.0;
  let planTile = vec2i(floor(isoPlan + 0.5));
  var supportH = 0.0;
  if (all(planTile >= vec2i(0)) && all(planTile < vec2i(textureDimensions(rainMask)))) {
    let receiver = round(textureLoad(rainMask, planTile, 0).r * 255.0);
    if (receiver > 127.0) { supportH = 255.0 - receiver; }
  }
  let ground = plan - vec2f(0.0, supportH);
  let phase =`)
        .replace('let tile = vec2i(floor(iso + 0.5));', 'let tile = planTile;')
        .replace('1.0 - key / 65535.0', 'clamp((6144.0 - (2.0 * world.y + 2.5 * (supportH + max(0.0, ground.y - world.y)))) / 8192.0, 0.000001, 0.999999)');
    const module = device.createShaderModule({ label: 'terrace-rain', code });
    for (const attachment of roles ? [true] : [false, true]) {
        const targets = [{ format: SCENE_COLOR_FORMAT, blend: BLEND_NORMAL }];
        if (attachment) targets.push({ format: roles || SCENE_EMISSION_FORMAT, blend: roles ? BLEND_NORMAL_ROLE : BLEND_NORMAL });
        pipelines.set('rain' + attachment, await device.createRenderPipelineAsync({
            label: 'terrace-rain', layout: layouts.rainPipeline, primitive: { topology: 'triangle-list' },
            vertex: { module, entryPoint: 'rainVs' }, fragment: { module, entryPoint: 'rainFs', targets },
            depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less-equal' },
        }));
    }
}

export function planarMirrorFoot(record, waterZ) {
    // Unproject the final visible hull row, which already includes its tide.
    if (waterZ && record.id?.startsWith('harbor:hull:')) return record.y + record.height - 1 + waterZ;
    return record.mirrorFootY ?? record.footY ?? record.y + record.height;
}

export function waterInputs(terrain) {
    const { coast, contacts } = terrain.frontierCoast;
    const basin = new Uint16Array(coast.cols * coast.rows);
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    let wetLeft = Infinity, wetRight = -Infinity, wetTop = Infinity, wetBottom = -Infinity;
    for (let ty = 0; ty < MAP_SIZE; ty++) for (let tx = 0; tx < MAP_SIZE; tx++) {
        const key = tx + ',' + ty;
        const meta = terrain.waterMeta?.get(key);
        const harbor = terrain.harborTiles?.has(key) || meta?.region === 'harbor'
            || terrain.spillwaySplashes?.some(p => p.receivingTile === ty * MAP_SIZE + tx);
        if (!meta && !harbor) continue;
        const cx = (tx - ty) * TILE_WIDTH / 2, cy = (tx + ty) * TILE_HEIGHT / 2;
        wetLeft = Math.min(wetLeft, cx - TILE_WIDTH / 2); wetRight = Math.max(wetRight, cx + TILE_WIDTH / 2);
        wetTop = Math.min(wetTop, cy - TILE_HEIGHT / 2); wetBottom = Math.max(wetBottom, cy + TILE_HEIGHT / 2);
        if (!harbor) continue;
        for (let y = cy - TILE_HEIGHT / 2; y < cy + TILE_HEIGHT / 2; y += 2) {
            for (let x = cx - TILE_WIDTH / 2; x < cx + TILE_WIDTH / 2; x += 2) {
                if (Math.abs((x + 1 - cx) / (TILE_WIDTH / 2)) + Math.abs((y + 1 - cy) / (TILE_HEIGHT / 2)) > 1) continue;
                const col = (x - coast.x) >> 1, row = (y - coast.y) >> 1;
                if (col < 0 || col >= coast.cols || row < 0 || row >= coast.rows) continue;
                basin[row * coast.cols + col] = 1;
            }
        }
        left = Math.min(left, cx - TILE_WIDTH / 2); right = Math.max(right, cx + TILE_WIDTH / 2);
        top = Math.min(top, cy - TILE_HEIGHT / 2); bottom = Math.max(bottom, cy + TILE_HEIGHT / 2);
    }
    const rect = right < left ? [0, 0, 0, 0] : [left - 10, top - 10, Math.min(1024, right - left + 20), Math.min(512, bottom - top + 20)];
    // A single field covers the duck ponds and Harbor. Only the Harbor owns planar color.
    const rippleScale = Math.min(RIPPLE_GRID_WIDTH / Math.max(1, wetRight - wetLeft), RIPPLE_GRID_HEIGHT / Math.max(1, wetBottom - wetTop));
    const rippleOrigin = Number.isFinite(wetLeft) ? [wetLeft, wetTop] : [0, 0];
    const boundary = new Uint8Array(RIPPLE_GRID_WIDTH * RIPPLE_GRID_HEIGHT * 4);
    for (let y = 0; y < RIPPLE_GRID_HEIGHT; y++) for (let x = 0; x < RIPPLE_GRID_WIDTH; x++) {
        const px = Math.floor(rippleOrigin[0] + (x + 0.5) / rippleScale) - coast.x;
        const py = Math.floor(rippleOrigin[1] + (y + 0.5) / rippleScale) - coast.y;
        if (px < 0 || py < 0 || px >= coast.cols * 2 || py >= coast.rows * 2) continue;
        const cell = (py >> 1) * coast.cols + (px >> 1);
        const wet = terrain.frontierCoast.exposure[cell] & (1 << ((px & 1) + 2 * (py & 1)));
        if (wet) boundary.set([255, 128, 128, 255], (y * RIPPLE_GRID_WIDTH + x) * 4);
    }
    const [ox, oy, w, h] = rect;
    const mask = new Uint8Array(w * h);
    const contact = new Uint8Array(w * h * 4);
    const localBasin = new Uint16Array(w * h / 4);
    const exposure = new Uint8Array(w * h / 4);
    const edge = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const px = x + ox - coast.x, py = y + oy - coast.y;
        const cell = (py >> 1) * coast.cols + (px >> 1);
        const local = (y >> 1) * (w / 2) + (x >> 1);
        localBasin[local] = basin[cell] || 0;
        exposure[local] = terrain.frontierCoast.exposure[cell] || 0;
        if (!localBasin[local]) continue;
        const i = y * w + x;
        edge[i] = Math.min(9, 1 + (edge[i - 1] || 0), 1 + (edge[i - w] || 0));
        if (exposure[local] & (1 << ((px & 1) + 2 * (py & 1)))) mask[i] = 4;
    }
    const samples = new DataView(contacts.buffer, contacts.byteOffset, contacts.byteLength);
    for (let offset = 0; offset < contacts.byteLength; offset += 8) {
        const at = samples.getUint32(offset, true);
        const x = at % (coast.cols * 2) + coast.x - ox;
        const y = Math.floor(at / (coast.cols * 2)) + coast.y - oy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        contact.set(contacts.subarray(offset + 4, offset + 8), (y * w + x) * 4);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        edge[i] = Math.min(edge[i], 1 + (edge[i + 1] || 0), 1 + (edge[i + w] || 0));
        if (!mask[i]) continue;
        if (!bayerCollarSelect(edge[i] - 1, ox + x, oy + y)) { mask[i] = 0; continue; }
        // A physical contact fixes the sample in place; the next two art rows
        // allow at most one texel of displacement.
        for (let d = 0; d < 3; d++) {
            const k = i - d * w;
            const contactStarts = contact[4 * k + 3] && !contact[4 * (k - w) + 3];
            const aboveY = y - d - 1;
            const wetAbove = exposure[(aboveY >> 1) * (w / 2) + (x >> 1)] & (1 << ((x & 1) + 2 * (aboveY & 1)));
            if (contactStarts || !wetAbove) { mask[i] = d + 1; break; }
        }
    }
    // The sluice cuts a real opening in the receiving bank. Preserve that
    // opening when the coarse coast grid or the dithered planar collar misses it.
    for (const p of terrain.spillwaySplashes || []) {
        for (let dx = -9; dx < 9; dx++) for (let depth = 0; depth < 8; depth++) {
            const x = p.x + dx - ox, y = p.y - Math.floor((dx + 1) / 2) + depth - oy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const cell = (y >> 1) * (w / 2) + (x >> 1);
            localBasin[cell] = 1;
            exposure[cell] |= 1 << ((x & 1) + 2 * (y & 1));
            mask[y * w + x] = 4;
            const rx = Math.floor((x + ox - rippleOrigin[0]) * rippleScale);
            const ry = Math.floor((y + oy - rippleOrigin[1]) * rippleScale);
            if (rx >= 0 && ry >= 0 && rx < RIPPLE_GRID_WIDTH && ry < RIPPLE_GRID_HEIGHT)
                boundary.set([255, 128, 128, 255], 4 * (ry * RIPPLE_GRID_WIDTH + rx));
        }
    }
    return { bake: terrain.frontierCoast, mask, contact, exposure, basin: localBasin, planarRect: rect, rippleScale, rippleOrigin, boundary, spillwaySplashes: terrain.spillwaySplashes };
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ema(previous, sample) {
    const value = Math.max(0, finite(sample));
    return previous == null ? value : previous + (value - previous) * EMA_ALPHA;
}

// Stable identities for GPU objects, so bind-group cache keys are cheap strings.
const gpuIds = new WeakMap();
let nextGpuId = 1;
function gpuId(object) {
    if (!object) return 0;
    let id = gpuIds.get(object);
    if (!id) {
        id = nextGpuId++;
        gpuIds.set(object, id);
    }
    return id;
}

function vec3Pair(flat) {
    return [flat[0], flat[1], flat[2], 0, flat[3], flat[4], flat[5], 0];
}

// IEEE 754 binary16 → float32, for the rgba16float capture readback.
function halfFloatsToFloat32(halves) {
    const out = new Float32Array(halves.length);
    for (let index = 0; index < halves.length; index++) {
        const h = halves[index];
        const sign = h & 0x8000 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        out[index] = exponent === 0 ? sign * mantissa * 2 ** -24
            : exponent === 31 ? (mantissa ? NaN : sign * Infinity)
                : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }
    return out;
}

export class GpuWorldRendererWebGPU {
    constructor(canvas, { enabled = true, device = null, adapter = null, pipelines = null, frontierEnabled } = {}) {
        this.backend = 'webgpu';
        this._frontierAllowed = defaultFrontier(canvas, true);
        this.frontierConfig = { enabled: defaultFrontier(canvas, frontierEnabled), mirror: true, ripples: true, surfaceDepth: true, wind: true, shafts: true, gi: false };
        this._frontierPasses = new Map();
        this._frontierMask = 0;
        this._surfaceGroups = new Map();
        this._surfacePages = new Set();
        this.canvas = canvas || null;
        this.enabled = Boolean(enabled);
        this.supported = false;
        this.contextHealthy = false;
        this.disposed = false;
        this.suspended = false;
        this.device = null;
        this.adapter = null;
        this.adapterInfo = null;
        this.context = null;
        this.canvasFormat = globalThis.navigator?.gpu?.getPreferredCanvasFormat?.() || 'bgra8unorm';
        this.pipelines = null;
        this.width = Math.max(1, Math.floor(canvas?.width || 1));
        this.height = Math.max(1, Math.floor(canvas?.height || 1));
        this.frames = 0;
        this.records = 0;
        this.batches = 0;
        this.markRecords = 0;
        this.markRoleRecords = 0;
        // 10.2 — the late mark pass this frame (the C4 verified-success peak).
        this.lateMarkRecords = 0;
        this.lateMarkRoleRecords = 0;
        this.lightCount = 0;
        this.sourceEnergy = NEUTRAL_SOURCE_ENERGY;
        this.wetReflectionCount = 0;
        this.localLightPhase = 0;
        this.uploadMs = null;
        this.cpuMs = null;
        this.shaderCpuMs = null;
        this.gpuMs = null;
        this.timerSupported = false;
        this._timer = null;
        this.passSamplingEnabled = false;
        this._passCursor = 0;
        this._sampledPass = null;
        this.gpuDisjointDiscards = 0;
        this._passStarted = 0;
        this._passUploadBytes = 0;
        this._passResults = Object.fromEntries(GPU_PASS_NAMES.map(name => [name, {
            samples: new Array(PASS_RING_CAPACITY).fill(null),
            count: 0, next: 0, gpuSum: 0, gpuCount: 0, cpuSum: 0, latest: null,
        }]));
        this.qualityTimingSource = 'cpu-fallback';
        this._qualityTimingScratch = createGpuTimingMetricsScratch();
        this._qualityTimingInput = { uploadMs: 0, shaderCpuMs: 0, gpuMs: null, gpuTimerSupported: false, frameGapMs: 0 };
        this.gpuTimerErrors = 0;
        this.frameGapMs = null;
        this.uploads = 0;
        this.uploadBytes = 0;
        this._uploadByteKinds = { wholeImages: 0, imagePatches: 0, albedoPage: 0, typedFields: 0, lightRecords: 0 };
        this.skippedOccluderUploads = 0;
        this.textureBytes = 0;
        this.textureEvictions = 0;
        // 0.1 — the pacing-true ladder, exactly as the WebGL2 world runs it.
        this.qualityLadder = createPostFxLadder({ maxLevel: POST_FX_LEVELS.MINIMAL });
        this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
        this.gpuMsP25 = null;
        this._gpuTimerRing = null;
        this._gpuTimerEvery = GPU_TIMER_EVERY;
        this._pendingPresentIntervalMs = null;
        this._presentIntervalsNoted = false;
        this._displayDpr = null;
        this._displayScreenWidth = 0;
        this._displayScreenHeight = 0;
        this._onVisibilityChange = () => {
            this._frontierVisibilityReset = true;
            this._pendingPresentIntervalMs = null;
            this.qualityLadder.clearPacing();
        };
        this._lightFrame = createLightFrameState();
        this.lightAdmission = this._lightFrame.admission;
        this.lightClusterOverride = null;
        this.radianceOverride = null;
        this.fatPixelsOverride = null;
        this.fatPixelsFrame = false;
        this._debugLoad = null;
        this._frameLoadPasses = 0;
        this._frameLoadArm = null;
        const debugParams = new URLSearchParams(globalThis.location?.search || '');
        const debugLoadPasses = Number(debugParams.get('gpuLoad'));
        if (debugLoadPasses > 0) {
            this.setDebugLoad({ passes: debugLoadPasses, levels: debugParams.get('gpuLoadLevels') || 'full' });
        }
        this._frameUploadMs = 0;
        this._lastRenderAtMs = null;
        this._textureEntries = new Map();
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this._lastTextureTrimFrame = 0;
        this._recordStaging = createRecordStaging();
        this._markStaging = createRecordStaging();
        this._markBatches = [];
        this._markNormalized = [];
        this.vertexBufferBytes = 0;
        this._particleBytes = new ArrayBuffer(MAX_PARTICLE_INSTANCES * GPU_PARTICLE_INSTANCE_BYTES);
        this._particleViews = {
            f32: new Float32Array(this._particleBytes),
            u16: new Uint16Array(this._particleBytes),
            u8: new Uint8Array(this._particleBytes),
            capacity: MAX_PARTICLE_INSTANCES,
        };
        this._particleCount = 0;
        this._particleMotifTexture = null;
        this.particleInstances = 0;
        // RN-1 — the world rain field (WeatherRenderer.gpuRainField).
        this._rain = createGpuRainField();
        this._rainMaskView = null;
        this.rainShare = 0;
        this.rainInstances = 0;
        this._batchScratch = [];
        this._albedoPage = null;
        this.emptyAlbedoPage = null;
        this._pageRecord = (record) => (
            this._albedoPage && gpuRecordPageable(record, ALBEDO_PAGE_SIZE - ALBEDO_PAGE_GUTTER)
                ? this._albedoPage.place(record)
                : null
        );
        this._normalizedRecordScratch = [];
        this._lightTilesEmpty = new Uint16Array(1);
        this._camera = { xy: [0, 0], scale: 0 };
        this._waterFx = createWaterFx();
        this._atmosphereCourses = createAtmosphereCourses();
        this.mist = new Float32Array(4);
        this.mistBurn = Float32Array.from([1, 1]);
        this._seaState = createSeaState();
        this._seaWeather = createSeaWeather();
        this._seaWeatherFrame = { sunlit: 0, gust: null };
        this._puddles = createPuddleUniforms();
        this._puddleActive = false;
        this.cloudCourses = 0;
        this.aerialHaze = 0;
        this.footprintMarchSteps = 0;
        this.paletteLutActive = false;
        this.waterFieldsActive = false;
        this.openSeaDiagnostics = null;
        this._sourceCensus = { atlasRecords: 0, individualRecords: 0, batchCount: 0, uploadBytes: 0 };
        this._renderErrorLogged = false;
        // Uniform staging (common.js layouts): one frame block, a batch ring.
        this._frameViews = createUniformViews(FRAME_UNIFORM_LAYOUT.size);
        this._frameState = {};
        this._batchViews = createUniformViews(BATCH_UNIFORM_STRIDE * 64);
        this._batchState = {};
        this._bloomParams = createUniformViews(512);
        this._frameBindGroup = null;
        this._attributionPipelines = null;
        this._frameBindKey = '';
        this._batchBindGroups = new Map();
        this.deviceLost = null;
        this.deviceRebuilds = 0;
        this.deviceRebuildError = null;
        this._rebuildPromise = null;
        // An unrecoverable failure (`_fail`): `{ stage, message, summary, atMs }`.
        this.failure = null;
        // GPU errors outside the frame's scopes (diagnostics only).
        this.uncapturedErrors = 0;
        this.lastUncapturedError = null;
        this._lastCanvasTexture = null;
        // 0.3 — the HDR canvas's SDR readout surface (`readoutSurface`).
        this._readout = null;
        this.initError = null;
        // 10.2 / 10.3 — the display path (DisplayColor.resolveDisplayColor):
        // `_display` is the active HDR/P3 variant (GpuWgpuPipelines
        // displayVariant) or null for the shipped SDR path; `presentFormat`
        // is the canvas format actually configured.
        this.hdrMode = HDR_HIGHLIGHTS_DEFAULT;
        this.dynamicRangeHigh = false;
        this.colorGamutP3 = false;
        this.toneMappingSupported = true;
        this._displayWant = resolveDisplayColor({ backend: 'webgpu', hdrMode: this.hdrMode });
        this._display = null;
        this._displayRequest = 0;
        this._emitterVariants = new WeakMap();
        this.displayError = null;
        // The host's display-status callback (IsometricRenderer), or null.
        this.onDisplayChange = null;
        this.presentFormat = this.canvasFormat;
        this.canvasColorSpace = 'srgb';
        this.canvasToneMapping = 'standard';
        this._compositeRolesBindGroup = null;

        if (!canvas?.getContext) {
            this.ready = Promise.resolve(false);
            return;
        }
        try {
            this.context = canvas.getContext('webgpu');
        } catch (error) {
            this.initError = String(error?.message || error);
        }
        if (!this.context) {
            this.ready = Promise.resolve(false);
            return;
        }
        this.supported = true;
        if (device && pipelines) {
            try {
                this._adoptDevice(device, adapter, pipelines);
                this.ready = Promise.resolve(true);
            } catch (error) {
                this._initFailed(error);
                this.ready = Promise.resolve(false);
            }
        } else {
            // A caller holding no prepared pipelines (a harness) waits on
            // `ready`; isActive() stays false until the shaders are built.
            this.ready = (async () => {
                try {
                    const probe = device ? { device, adapter } : await requestWebGpuDevice();
                    const prepared = await prepareWorldPipelines(probe.device, this.canvasFormat);
                    if (this.disposed) return false;
                    this._adoptDevice(probe.device, probe.adapter, prepared);
                    return true;
                } catch (error) {
                    this._initFailed(error);
                    return false;
                }
            })();
        }
    }

    _initFailed(error) {
        this.initError = String(error?.message || error);
        this.contextHealthy = false;
        console.warn('[GpuWorldRendererWebGPU] initialization failed:', error);
    }

    // A device (fresh or rebuilt) becomes this renderer's: configure the
    // canvas, watch for loss, build every resident resource.
    _adoptDevice(device, adapter, pipelines) {
        this.device = device;
        this.adapter = adapter || null;
        this.adapterInfo = adapter ? adapterInfo(adapter) : this.adapterInfo;
        this.pipelines = pipelines;
        this.timerSupported = device.features.has('timestamp-query');
        this._display = null;
        this._configureCanvas();
        device.lost.then((info) => this._onDeviceLost(device, info));
        // An error outside our frame scopes (`_openFrameScope`) is not our
        // frame's: Chrome's own work on this device (its copy of the canvas
        // for a page readback, an extension) reports here. It is diagnosed
        // (`uncapturedErrors`, Shift-D), never a world failure.
        device.onuncapturederror = (event) => {
            if (device !== this.device) return;
            const message = String(event?.error?.message || 'unknown').replace(/\s+/g, ' ').trim();
            this.uncapturedErrors++;
            this.lastUncapturedError = message.length > 200 ? `${message.slice(0, 199)}…` : message;
            if (this.uncapturedErrors <= 3) console.warn('[GpuWorldRendererWebGPU] GPU error outside the frame (the world keeps drawing):', event?.error);
        };
        this._initResources();
        this.contextHealthy = true;
        this.resize(this.width, this.height);
        this._requestDisplay();
    }

    // An unrecoverable failure: the world goes inactive for good, and
    // `failure` tells IsometricRenderer to swap to a fresh WebGL2 world
    // (`_fallBackFromWebGpu`; the page holds its last frame until then).
    _fail(stage, error) {
        if (this.disposed || this.failure) return;
        const message = String(error?.message || error || 'unknown');
        const brief = message.replace(/\s+/g, ' ').trim();
        this.failure = {
            stage,
            message,
            // 'failed in frame: <summary>' (IsometricRenderer): a frame
            // exception needs no stage prefix.
            summary: `${stage === 'frame' ? '' : `${stage}: `}${brief.length > 40 ? `${brief.slice(0, 39)}…` : brief}`,
            atMs: performance.now(),
        };
        this.contextHealthy = false;
        console.warn(`[GpuWorldRendererWebGPU] ${stage} failure; WebGL2 takes over:`, error);
    }

    // The frame's own GPU work (uploads, encode, submit) runs inside a
    // validation and an out-of-memory error scope: an error there means the
    // frame drew wrong or nothing while render() returned true, so the world
    // fails (`_fail`, WebGL2 takes over) once the scope reports.
    _openFrameScope(device) {
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
    }

    _closeFrameScope(device) {
        for (const filter of ['validation', 'out-of-memory']) {
            device.popErrorScope().then((error) => {
                if (error && device === this.device) this._fail(filter, error);
            }, () => {});
        }
    }

    // 10.2 / 10.3 — the canvas for the active display path: the shipped
    // preferred format, sRGB and standard tone mapping unless an HDR variant
    // (rgba16float + extended) or a P3 variant (display-p3) is active. The
    // HDR canvas is also sampled, by its SDR readout (`readoutSurface`).
    _configureCanvas() {
        const display = this._display;
        const u = globalThis.GPUTextureUsage;
        const config = {
            device: this.device,
            format: display?.format || this.canvasFormat,
            alphaMode: 'premultiplied',
            usage: u.RENDER_ATTACHMENT | u.COPY_SRC | (display?.hdr ? u.TEXTURE_BINDING : 0),
        };
        if (display?.p3) config.colorSpace = 'display-p3';
        if (display?.hdr) config.toneMapping = { mode: 'extended' };
        this.context.configure(config);
        const applied = this.context.getConfiguration?.() || null;
        this.presentFormat = config.format;
        this.canvasColorSpace = applied?.colorSpace || config.colorSpace || 'srgb';
        this.canvasToneMapping = applied?.toneMapping?.mode || config.toneMapping?.mode || 'standard';
        // A browser without canvas tone mapping (Safari 26) echoes no
        // `extended`: HDR is then unavailable, never half-applied.
        return !display?.hdr || !applied || applied.toneMapping?.mode === 'extended';
    }

    /**
     * 10.2 / 10.3 — the HDR setting and the screen's media queries (the
     * caller re-sends them on the setting's event and on each query's
     * `change`). The HDR/P3 variant compiles asynchronously; until it is
     * ready, and whenever neither applies, the shipped SDR path renders.
     */
    setDisplayColor({ hdrMode = this.hdrMode, dynamicRangeHigh = this.dynamicRangeHigh, colorGamutP3 = this.colorGamutP3 } = {}) {
        this._displayWant = resolveDisplayColor({
            backend: 'webgpu',
            hdrMode,
            dynamicRangeHigh,
            colorGamutP3,
            toneMappingSupported: this.toneMappingSupported,
        });
        this.hdrMode = this._displayWant.mode;
        this.dynamicRangeHigh = dynamicRangeHigh === true;
        this.colorGamutP3 = colorGamutP3 === true;
        this._requestDisplay();
    }

    _requestDisplay() {
        const want = this._displayWant;
        const token = ++this._displayRequest;
        if (!this.device || !this.pipelines) return;
        if (want.hdr === Boolean(this._display?.hdr) && want.p3 === Boolean(this._display?.p3)) return;
        if (!want.hdr && !want.p3) {
            this._applyDisplay(null);
            return;
        }
        const device = this.device;
        const pipelines = this.pipelines;
        pipelines.displayVariant(want).then(async variant => {
            let pending = this._emitterVariants.get(variant);
            if (!pending) {
                const module = pipelines.modules.scene;
                pending = Promise.all([false, true].map(depthWriteEnabled => device.createRenderPipelineAsync({
                    label: 'world-emitter-roles',
                    layout: pipelines.layouts.scenePipeline,
                    vertex: { module, entryPoint: 'sceneVs' },
                    primitive: { topology: 'triangle-strip' },
                    depthStencil: { format: SCENE_DEPTH_FORMAT, depthWriteEnabled, depthCompare: 'always' },
                    fragment: { module, entryPoint: 'emitterRoleFs', targets: [
                        { format: SCENE_COLOR_FORMAT, blend: BLEND_NORMAL }, { format: variant.emissionFormat },
                    ] },
                })));
                this._emitterVariants.set(variant, pending);
                pending.catch(() => this._emitterVariants.delete(variant));
            }
            return { ...variant, emitterRoles: await pending };
        }).then((variant) => {
            if (token !== this._displayRequest || device !== this.device || this.disposed) return;
            this.displayError = null;
            this._applyDisplay(variant);
        }, (error) => {
            this.displayError = String(error?.message || error);
            console.warn('[GpuWorldRendererWebGPU] HDR/P3 display variant unavailable; staying SDR:', error);
        });
    }

    // The next render's `_ensureTargets` follows the variant's emission
    // format and builds the roles composite's bind group. A canvas that does
    // not echo `extended` tone mapping ends HDR here for good; the host
    // (`onDisplayChange`) re-publishes the display status so SET says so.
    _applyDisplay(variant) {
        this._display = variant;
        this._compositeRolesBindGroup = null;
        if (!this._configureCanvas()) {
            this.toneMappingSupported = false;
            this._display = null;
            this._configureCanvas();
            this.setDisplayColor();
            this.onDisplayChange?.();
        }
    }

    // §4.2 — a lost device drops every handle without destroying it; the
    // caller's Canvas world draws until `_rebuildDevice()` succeeds. A loss
    // the browser caused (reason 'unknown') rebuilds on its own; a failed
    // rebuild, or an explicit `destroy()` that is not our dispose (a harness,
    // an extension), is unrecoverable (`_fail`): the app takes WebGL2. A
    // caller may still `_rebuildDevice()` a standalone world.
    _onDeviceLost(device, info) {
        if (device !== this.device) return;
        this.deviceLost = { reason: info?.reason || 'unknown', message: String(info?.message || ''), atMs: performance.now() };
        this.contextHealthy = false;
        this._abandonGpuResources();
        if (this.disposed) return;
        if (this.deviceLost.reason === 'destroyed') {
            this._fail('device', 'destroyed');
            return;
        }
        setTimeout(() => {
            if (this.disposed || this.contextHealthy) return;
            this._rebuildDevice().then((rebuilt) => {
                if (!rebuilt && !this.contextHealthy) this._fail('device', `lost; rebuild failed: ${this.deviceRebuildError || 'unknown'}`);
            });
        }, 250);
    }

    /** Re-request the adapter and device, rebuild pipelines and resources. Re-entrant. */
    _rebuildDevice() {
        if (this._rebuildPromise) return this._rebuildPromise;
        this._rebuildPromise = (async () => {
            try {
                if (this.disposed || !this.context) return false;
                const { adapter, device } = await requestWebGpuDevice();
                const pipelines = await prepareWorldPipelines(device, this.canvasFormat);
                if (this.disposed) {
                    device.destroy();
                    return false;
                }
                if (this.contextHealthy && this.device && this.device !== device) {
                    this._releaseGpuResources();
                    this.device.destroy();
                }
                this.failure = null;
                this._adoptDevice(device, adapter, pipelines);
                this.deviceRebuilds++;
                this.deviceRebuildError = null;
                if (this.suspended) this._releaseGpuResources();
                return true;
            } catch (error) {
                this.deviceRebuildError = String(error?.message || error);
                console.warn('[GpuWorldRendererWebGPU] device rebuild failed:', error);
                return false;
            } finally {
                this._rebuildPromise = null;
            }
        })();
        return this._rebuildPromise;
    }

    _initResources() {
        const device = this.device;
        const u = globalThis.GPUBufferUsage;
        this._releaseGpuResources();
        this._samplers = {
            cloud: device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear' }),
            linear: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
            nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }),
        };
        this._frameBuffer = device.createBuffer({ size: FRAME_UNIFORM_LAYOUT.size, usage: u.UNIFORM | u.COPY_DST, label: 'world-frame' });
        this._batchBuffer = null;
        this._batchBufferSlots = 0;
        this._recordBuffer = null;
        this._recordBufferBytes = 0;
        this._markRecordBuffer = null;
        this._markRecordBufferBytes = 0;
        this._bloomParamBuffer = device.createBuffer({ size: 512, usage: u.UNIFORM | u.COPY_DST, label: 'world-bloom-params' });
        this._particleBuffer = device.createBuffer({ size: this._particleBytes.byteLength, usage: u.VERTEX | u.COPY_DST, label: 'world-particles' });
        this._rainBuffer = device.createBuffer({ size: RAIN_UNIFORM_BYTES, usage: u.UNIFORM | u.COPY_DST, label: 'world-rain' });
        this._rainBindGroup = null;
        this._rainBindGroupView = null;
        this._lightRecordBuffer = device.createBuffer({ size: LIGHT_RECORD_BUFFER_BYTES, usage: u.STORAGE | u.COPY_DST, label: 'world-light-records' });
        this._lightRecordsSource = null;
        this._lightRecordsRevision = null;
        this.emptyMaterialTexture = createWgpuTexture(device, 1, 1, 'rgba8', { label: 'empty' });
        this.emptyMaterialView = this.emptyMaterialTexture.createView();
        writeTextureRows(device, this.emptyMaterialTexture, new Uint8Array(4), 1, 1, 4);
        this.emptyAlbedoPage = createWgpuTexture(device, 1, 1, 'rgba8', { label: 'empty-page' });
        this.emptyAlbedoPageView = this.emptyAlbedoPage.createView({ dimension: '2d-array' });
        const tile = cloudTile().data;
        this.cloudTileTexture = createWgpuTexture(device, CLOUD_TILE_SIZE, CLOUD_TILE_SIZE, 'rgba8', { label: 'cloud-tile' });
        writeTextureRows(device, this.cloudTileTexture, tile, CLOUD_TILE_SIZE, CLOUD_TILE_SIZE, 4);
        this.cloudTileView = this.cloudTileTexture.createView();
        this._albedoPage = new GpuWgpuAlbedoPage(device);
        this._timer = this.timerSupported ? new GpuWgpuTimer(device) : null;
        this._textureEntries.clear();
        this._batchBindGroups.clear();
        this._frameBindGroup = null;
        this._attributionPipelines = null;
        this._frameBindKey = '';
        this._frameDescriptor = null;
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
    }

    _releaseGpuResources() {
        if (!this.device) return;
        if (!this.contextHealthy) {
            this._abandonGpuResources();
            return;
        }
        for (const target of [this.sceneTarget, this.bloomA, this.bloomB]) {
            for (const texture of target?.textures || []) texture.destroy();
        }
        for (const entry of this._textureEntries.values()) entry.texture?.destroy?.();
        this._albedoPage?.release();
        for (const texture of [this.emptyMaterialTexture, this.emptyAlbedoPage, this.cloudTileTexture]) texture?.destroy?.();
        for (const buffer of [this._frameBuffer, this._batchBuffer, this._recordBuffer, this._markRecordBuffer,
            this._bloomParamBuffer, this._particleBuffer, this._lightRecordBuffer, this._rainBuffer]) buffer?.destroy?.();
        this._timer?.destroy();
        this._abandonGpuResources();
    }

    _abandonGpuResources() {
        this._releaseFrontier();
        this._frameDescriptor = null;
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this._targetNeedsEmission = false;
        this._targetNeedsBloom = false;
        this._lastEmissionUseAt = -Infinity;
        this._lastBloomUseAt = -Infinity;
        this._textureEntries.clear();
        this._albedoPage?.abandon();
        this._albedoPage = null;
        this.emptyMaterialTexture = null;
        this.emptyMaterialView = null;
        this.emptyAlbedoPage = null;
        this.emptyAlbedoPageView = null;
        this.cloudTileTexture = null;
        this.cloudTileView = null;
        this._frameBuffer = null;
        this._batchBuffer = null;
        this._batchBufferSlots = 0;
        this._recordBuffer = null;
        this._recordBufferBytes = 0;
        this._markRecordBuffer = null;
        this._markRecordBufferBytes = 0;
        this._bloomParamBuffer = null;
        this._particleBuffer = null;
        this._rainBuffer = null;
        this._rainBindGroup = null;
        this._rainBindGroupView = null;
        this._rainMaskView = null;
        this._lightRecordBuffer = null;
        this._lightRecordsSource = null;
        this._particleMotifTexture = null;
        this._batchBindGroups.clear();
        this._frameBindGroup = null;
        this._attributionPipelines = null;
        this._frameBindKey = '';
        this._compositeBindGroup = null;
        this._compositeRolesBindGroup = null;
        this._bloomBindGroups = null;
        this._debugLoadBindGroup = null;
        this._timer = null;
        this._lastCanvasTexture = null;
        try {
            this._readout?.context?.unconfigure?.();
        } catch {
            // Already unconfigured by a lost device.
        }
        this._readout = null;
        this.textureBytes = 0;
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this.vertexBufferBytes = 0;
        this.gpuMs = null;
        this.qualityTimingSource = 'cpu-fallback';
    }

    _createTarget(width, height, format, { transient = false, label } = {}) {
        const u = globalThis.GPUTextureUsage;
        const usage = transient && u.TRANSIENT_ATTACHMENT
            ? u.RENDER_ATTACHMENT | u.TRANSIENT_ATTACHMENT
            : u.RENDER_ATTACHMENT | (transient ? 0 : u.TEXTURE_BINDING | u.COPY_SRC);
        const texture = this.device.createTexture({ label, size: [width, height], format, usage });
        return { texture, view: texture.createView() };
    }

    _ensureTargets(needsEmission = this._targetNeedsEmission, needsBloom = this._targetNeedsBloom) {
        needsEmission ||= Boolean(this._display);
        const now = performance.now();
        if (needsEmission) this._lastEmissionUseAt = now;
        if (needsBloom) this._lastBloomUseAt = now;
        const bloomWidth = Math.max(1, Math.floor(this.width * BLOOM_SCALE));
        const bloomHeight = Math.max(1, Math.floor(this.height * BLOOM_SCALE));
        const emissionFormat = this._display?.emissionFormat || SCENE_EMISSION_FORMAT;
        const depthFormat = this._frontierMask & 4 ? 'depth32float' : SCENE_DEPTH_FORMAT;
        const splitWater = Boolean(this._frontierMask & 17);
        const sameSize = this.sceneTarget?.splitWater === splitWater && this.sceneTarget?.depthFormat === depthFormat && this.sceneTarget?.width === this.width && this.sceneTarget?.height === this.height;
        const keepEmission = needsEmission || (sameSize && this.sceneTarget?.emission
            && now - this._lastEmissionUseAt < TARGET_RETENTION_MS);
        const keepBloom = needsBloom || (sameSize && this.bloomA
            && now - this._lastBloomUseAt < TARGET_RETENTION_MS);
        let changed = this._targetNeedsBloom !== needsBloom;
        this._targetNeedsEmission = needsEmission;
        this._targetNeedsBloom = needsBloom;
        if (!sameSize) {
            for (const texture of this.sceneTarget?.textures || []) texture.destroy();
            const color = this._createTarget(this.width, this.height, SCENE_COLOR_FORMAT, { label: 'scene-color' });
            const depth = this._createTarget(this.width, this.height, depthFormat, { transient: !splitWater, label: 'scene-depth' });
            this.sceneTarget = { width: this.width, height: this.height, emissionFormat, depthFormat, splitWater, color, emission: null, depth, textures: [color.texture, depth.texture] };
            changed = true;
        }
        const target = this.sceneTarget;
        if (Boolean(target.emission) !== Boolean(keepEmission) || target.emissionFormat !== emissionFormat) {
            target.emission?.texture.destroy();
            target.emission = keepEmission
                ? this._createTarget(this.width, this.height, emissionFormat, { label: 'scene-emission' }) : null;
            target.emissionFormat = emissionFormat;
            target.textures = [target.color.texture, target.depth.texture, ...(target.emission ? [target.emission.texture] : [])];
            changed = true;
        }
        if (Boolean(this.bloomA) !== Boolean(keepBloom)
            || (this.bloomA && (this.bloomA.width !== bloomWidth || this.bloomA.height !== bloomHeight))) {
            this.bloomA?.texture.destroy();
            this.bloomB?.texture.destroy();
            const bloom = (label) => {
                const value = this._createTarget(bloomWidth, bloomHeight, BLOOM_FORMAT, { label });
                return { width: bloomWidth, height: bloomHeight, ...value, textures: [value.texture] };
            };
            this.bloomA = keepBloom ? bloom('bloom-a') : null;
            this.bloomB = keepBloom ? bloom('bloom-b') : null;
            changed = true;
        }
        if (!changed) {
            if (this._display && !this._compositeRolesBindGroup) this._createCompositeRolesBindGroup();
            return;
        }
        const { color, emission } = target;
        const device = this.device;
        const layouts = this.pipelines.layouts;
        this._compositeBindGroup = device.createBindGroup({
            layout: layouts.composite,
            entries: [
                { binding: COMPOSITE_BINDING.sceneColor, resource: color.view },
                { binding: COMPOSITE_BINDING.bloomColor, resource: needsBloom ? this.bloomB.view : this.emptyMaterialView },
            ],
        });
        const bloomGroup = (input, sampler, offset) => device.createBindGroup({
            layout: layouts.bloom,
            entries: [
                { binding: BLOOM_BINDING.input, resource: input },
                { binding: BLOOM_BINDING.sampler, resource: sampler },
                { binding: BLOOM_BINDING.params, resource: { buffer: this._bloomParamBuffer, offset, size: 16 } },
            ],
        });
        // Pass 1 reads the NEAREST emission target, pass 2 the LINEAR bloomA
        // (the WebGL2 targets' own filters), all in GL row order (bloom.js).
        this._bloomBindGroups = needsBloom ? [
            bloomGroup(emission.view, this._samplers.nearest, 0),
            bloomGroup(this.bloomA.view, this._samplers.linear, 256),
        ] : null;
        const f32 = this._bloomParams.f32;
        const u32 = this._bloomParams.u32;
        f32[0] = 1 / this.width; f32[1] = 1 / this.height; u32[2] = 0;
        f32[64] = 1 / bloomWidth; f32[65] = 1 / bloomHeight; u32[66] = 1;
        device.queue.writeBuffer(this._bloomParamBuffer, 0, this._bloomParams.buffer);
        this._debugLoadBindGroup = device.createBindGroup({
            layout: layouts.debugLoad,
            entries: [
                { binding: DEBUG_LOAD_BINDING.scene, resource: color.view },
                { binding: DEBUG_LOAD_BINDING.sampler, resource: this._samplers.nearest },
            ],
        });
        this._compositeRolesBindGroup = null;
        if (this._display && emission) this._createCompositeRolesBindGroup();
        this._updateTextureBytes();
    }

    _createCompositeRolesBindGroup() {
        this._compositeRolesBindGroup = this.device.createBindGroup({
            layout: this.pipelines.layouts.compositeRoles,
            entries: [
                { binding: COMPOSITE_BINDING.sceneColor, resource: this.sceneTarget.color.view },
                { binding: COMPOSITE_BINDING.bloomColor, resource: this._targetNeedsBloom ? this.bloomB.view : this.emptyMaterialView },
                { binding: COMPOSITE_ROLES_BINDING.sceneEmission, resource: this.sceneTarget.emission.view },
            ],
        });
    }

    _updateTextureBytes() {
        const target = this.sceneTarget;
        const sceneBytes = target ? target.width * target.height * (4 + (target.depthFormat === 'depth32float' ? 4 : SCENE_DEPTH_BYTES_PER_PIXEL)) : 0;
        const emissionBytes = target?.emission ? target.width * target.height * texelBytes(target.emissionFormat) : 0;
        const bloomBytes = (this.bloomA ? this.bloomA.width * this.bloomA.height * 4 : 0)
            + (this.bloomB ? this.bloomB.width * this.bloomB.height * 4 : 0);
        this.textureBytes = sceneBytes + emissionBytes + bloomBytes + this._cachedTextureBytes
            + (this._albedoPage?.bytes || 0);
    }

    resize(width, height) {
        this._canvasGeneration = (this._canvasGeneration || 0) + 1;
        this.width = Math.max(1, Math.floor(finite(width, this.width)));
        this.height = Math.max(1, Math.floor(finite(height, this.height)));
        if (this.canvas) {
            if (this.canvas.width !== this.width) this.canvas.width = this.width;
            if (this.canvas.height !== this.height) this.canvas.height = this.height;
            if (this.canvas.style) {
                this.canvas.style.pointerEvents = 'none';
                this.canvas.style.imageRendering = 'pixelated';
            }
        }
        if (this.device && this.contextHealthy && !this.suspended) this._ensureTargets();
    }

    isActive() {
        return Boolean(this.enabled && this.supported && this.contextHealthy && !this.failure && !this.disposed && !this.suspended);
    }

    supportsSceneCommands(request) {
        const commands = request?.commands;
        if (!commands?.length) return false;
        for (let index = 0; index < commands.length; index++) {
            const command = commands[index];
            if (!command?.source || !Number.isFinite(command.x) || !Number.isFinite(command.y)
                || !(command.width > 0) || !(command.height > 0)) return false;
        }
        return true;
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    get frontierEnabled() { return this.frontierConfig.enabled; }

    get substrateRevision() {
        return this.frontierEnabled && this.frontierConfig.mirror ? 1 : 0;
    }

    setFrontierConfig(options = {}) {
        let changed = false;
        for (const key of Object.keys(this.frontierConfig)) {
            if (typeof options[key] !== 'boolean') continue;
            const value = key === 'enabled' ? this._frontierAllowed && options[key] : options[key];
            if (this.frontierConfig[key] === value) continue;
            this.frontierConfig[key] = value;
            changed = true;
        }
        if (!changed) return;
        this._releaseFrontier();
        this._frameReuse?.invalidate();
    }

    _releaseFrontier() {
        for (const entry of this._frontierPasses.values()) entry.pass?.release();
        this._frontierPasses.clear();
        this._surfaceGroups.clear();
        this._surfacePages = new Set();
        this._mirrorBuffer?.destroy();
        this._mirrorBuffer = null;
        this._mirrorBufferBytes = 0;
        this._waterBed?.destroy();
        this._waterBed = null;
        this._waterInputs = null;
        this._resolveBake = null;
        this._rainPhases = null;
        this._mirrorGroups = new WeakMap();
        this._mirrorBatches = [];
        this._mirrorStaging = null;
        this._waterBedView = null;
        this._resolveGroups = [];
        this._hullPositions = new Map();
        for (const [key, entry] of this._textureEntries || []) {
            if (!key.startsWith('frontier:')) continue;
            entry.texture.destroy();
            this._cachedTextureBytes -= entry.bytes;
            this._textureEntries.delete(key);
        }
        this._frontierMask = 0;
        this._frontierRevision = 0;
        this._frontierPolicy = null;
        this._frontierWindow = 0;
        this.gpuMsP95 = null;
    }

    _prepareFrontier(terrain, feed) {
        if (!this.frontierEnabled) return;
        const device = this.device;
        const roles = this._display?.emissionFormat || null;
        const format = roles || SCENE_EMISSION_FORMAT;
        if (this._frontierFormat !== roles) {
            this._releaseFrontier();
            this._frontierFormat = roles;
        }
        for (const name of ['surfaceDepth', 'mirror', 'ripples', 'wind', 'shafts']) {
            if (!this.frontierConfig[name] || this._frontierPasses.has(name)) continue;
            if (name === 'shafts' && !this.frontierConfig.surfaceDepth) continue;
            const pass = FRONTIER_PASSES[name] ? new FRONTIER_PASSES[name](name === 'wind' ? { emberCapacity: WIND_EMBER_MAX_CAPACITY } : {}) : null;
            const entry = { pass, ready: false, error: null };
            this._frontierPasses.set(name, entry);
            const prepare = async () => {
                if (pass) {
                    await pass.prepare(device, { emissionFormat: format });
                    if (name === 'wind' && this._frontierPasses.get(name) === entry) entry.embers = await prepareEmberPipelines(device, this.pipelines.layouts, roles);
                    if (name === 'mirror' && this._frontierPasses.get(name) === entry) await prepareWorldWaterResolve(device, pass, this.pipelines.layouts, roles);
                } else {
                    entry.pipelines = await prepareSurfacePipelines(device, this.pipelines.layouts, roles);
                    await prepareTerraceRain(device, this.pipelines.layouts, roles, entry.pipelines);
                }
            };
            // The synchronous GPU allocations belong to this optional pass's validation scope.
            device.pushErrorScope('validation');
            const preparation = prepare();
            const validation = device.popErrorScope();
            Promise.all([preparation, validation]).then(([, error]) => {
                if (error) throw error;
                if (this._frontierPasses.get(name) === entry) entry.ready = true;
                else pass?.release();
            }).catch(error => {
                entry.error = String(error?.message || error);
                pass?.release();
            });
        }
        if (terrain?.frontierCoast?.coast && this._waterInputs?.bake !== terrain.frontierCoast) this._waterInputs = waterInputs(terrain);
        let mask = 0;
        for (const [name, entry] of this._frontierPasses) if (entry.ready) mask |= FRONTIER_BITS[name];
        if (!terrain?.frontierCoast?.coast || !this._waterInputs?.planarRect[2]) mask &= ~FRONTIER_BITS.mirror;
        const tier = this.qualityLadder.getLevel();
        const policyKey = tier + '/' + Boolean(feed.reducedMotion);
        const previous = policyKey === this._frontierPolicyKey && this._frontierPolicy;
        this._frontierPolicyKey = policyKey;
        const measured = this._frontierWindow >= GPU_TIMER_RING;
        this._frontierPolicy = resolveFrontierPolicy({ backend: 'webgpu', qualityTier: tier, reducedMotion: feed.reducedMotion,
            frontierFlags: previous?.frontierFlags || this.frontierConfig, frameTimeMs: measured ? this.gpuMsP95 : 0,
            ultrawide: this.width >= 3840 });
        if (measured) this._frontierWindow = 0;
        if (!this._frontierPolicy.frontierFlags.shafts) mask &= ~FRONTIER_BITS.shafts;
        if (!(mask & FRONTIER_BITS.surfaceDepth)) mask &= ~FRONTIER_BITS.shafts;
        if (mask & 1) {
            const water = this._waterInputs;
            water.maskView = this.uploadTypedTexture('frontier:water-mask', { data: water.mask, width: water.planarRect[2],
                height: water.planarRect[3], format: 'r8', revision: water.bake.key });
        }
        this._frontierMask = mask;
    }

    _frontierDiagnostics() {
        const passes = {};
        let logicalBytes = this._mirrorBufferBytes || 0;
        if (this._waterBed) logicalBytes += this._waterBed.width * this._waterBed.height * 4;
        const depthDelta = this.sceneTarget?.depthFormat === 'depth32float' ? this.width * this.height * (4 - SCENE_DEPTH_BYTES_PER_PIXEL) : 0;
        let cachedBytes = 0;
        for (const [key, entry] of this._textureEntries) if (key.startsWith('frontier:') || key === 'building.harbor:underside') cachedBytes += entry.bytes;
        for (const name of Object.keys(FRONTIER_BITS)) {
            const entry = this._frontierPasses.get(name);
            const diag = entry?.pass?.getDiagnostics();
            passes[name] = { ...diag, ready: entry?.ready === true, error: entry?.error ?? null };
            if (entry?.ready) {
                logicalBytes += diag?.allocatedBytes ?? diag?.memoryBytes?.total ?? 0;
                if (name === 'mirror') logicalBytes += entry.pass.mirrorUniformBuffer.size + entry.pass.resolveUniformBuffer.size;
                if (name === 'ripples') logicalBytes += entry.pass.paramsBuffer.size + entry.pass.impulseBuffer.size;
            }
        }
        return { enabled: this.frontierEnabled, featureMask: this._frontierMask, passes, passOwnedBytes: logicalBytes, logicalBytes: logicalBytes + cachedBytes + depthDelta,
            gpuMsP95: this.gpuMsP95, policy: this._frontierPolicy };
    }

    setLightClusterOverride(value = null) {
        this.lightClusterOverride = value == null ? null : Boolean(value);
        return this.lightClusterOverride;
    }

    /**
     * 2.10 — the ground radiance pilot is not ported to WebGPU (a declared
     * Stage A exclusion; it is off at every ladder level). The request is
     * recorded; forcing it on is unsupported and returns false.
     */
    setRadianceOverride(value = null) {
        this.radianceOverride = value == null ? null : Boolean(value);
        return this.radianceOverride === true ? false : this.radianceOverride;
    }

    suspend() {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        this._releaseGpuResources();
        this.textureBytes = 0;
    }

    resume() {
        if (this.disposed || !this.suspended || !this.device) return this.isActive();
        try {
            this.suspended = false;
            if (!this.contextHealthy) return false;
            this._initResources();
            this.resize(this.width, this.height);
            this.qualityLadder.resume();
            this._gpuTimerRing = null;
            this.gpuMsP25 = null;
            this._pendingPresentIntervalMs = null;
            return true;
        } catch (error) {
            this.suspended = true;
            this._fail('resume', error);
            return false;
        }
    }

    hasResidentTexture(key, revision) {
        const entry = this._textureEntries.get(key);
        return Boolean(this.contextHealthy && entry?.texture && entry.source && entry.revision === revision);
    }

    _entryFor(key, format) {
        let entry = this._textureEntries.get(key);
        if (!entry) {
            entry = { texture: null, view: null, source: null, revision: null, width: 0, height: 0, bytes: 0, format, lastUsedFrame: -1 };
            this._textureEntries.set(key, entry);
            this._textureCacheNeedsTrim = true;
        }
        return entry;
    }

    // Canvas/image sources, cached by key: a whole upload on a new source,
    // size or non-continuous revision, sub-rect patches otherwise (the WebGL2
    // `_textureFor` rules, patch validity included).
    _textureFor(key, source, revision = null, updates = null) {
        if (!source || source.width === 0 || source.height === 0) return null;
        const width = Math.max(1, Math.floor(source.width || source.videoWidth || 1));
        const height = Math.max(1, Math.floor(source.height || source.videoHeight || 1));
        let entry = this._textureEntries.get(key);
        if (source.gpuResident === true) {
            if (!entry || entry.revision !== revision || entry.width !== width || entry.height !== height) return null;
            entry.lastUsedFrame = this.frames + 1;
            return entry.view;
        }
        const storageChanged = !entry || entry.source !== source || entry.width !== width || entry.height !== height;
        const revisionChanged = !entry || entry.revision !== revision;
        entry = this._entryFor(key, 'rgba8');
        if (storageChanged || revisionChanged) {
            const started = performance.now();
            const canPatch = !storageChanged
                && (entry.lastUsedFrame === this.frames || entry.lastUsedFrame === this.frames + 1)
                && Array.isArray(updates)
                && updates.length > 0
                && updates.every((update) => {
                    const updateWidth = Math.floor(update?.width || update?.source?.width || 0);
                    const updateHeight = Math.floor(update?.height || update?.source?.height || 0);
                    const updateX = Math.floor(update?.x || 0);
                    const updateY = Math.floor(update?.y || 0);
                    const subRect = update?.sx != null;
                    const sx = Math.floor(update?.sx || 0);
                    const sy = Math.floor(update?.sy || 0);
                    return Boolean(
                        update?.source
                        && updateWidth > 0
                        && updateHeight > 0
                        && (subRect
                            ? sx >= 0 && sy >= 0
                                && sx + updateWidth <= update.source.width
                                && sy + updateHeight <= update.source.height
                            : update.source.width === updateWidth && update.source.height === updateHeight)
                        && updateX >= 0
                        && updateY >= 0
                        && updateX + updateWidth <= width
                        && updateY + updateHeight <= height
                    );
                });
            let uploadedBytes = 0;
            try {
                if (canPatch) {
                    for (const update of updates) {
                        if (!update?.source) continue;
                        const updateWidth = Math.floor(update.width || update.source.width);
                        const updateHeight = Math.floor(update.height || update.source.height);
                        copySourceToTexture(this.device, entry.texture, update.source, {
                            sx: update.sx != null ? Math.floor(update.sx) : 0,
                            sy: update.sx != null ? Math.floor(update.sy || 0) : 0,
                            width: updateWidth,
                            height: updateHeight,
                            x: Math.max(0, Math.floor(update.x || 0)),
                            y: Math.max(0, Math.floor(update.y || 0)),
                        });
                        uploadedBytes += Math.max(0, updateWidth) * Math.max(0, updateHeight) * 4;
                    }
                } else {
                    if (!entry.texture || entry.width !== width || entry.height !== height || entry.format !== 'rgba8') {
                        entry.texture?.destroy?.();
                        entry.texture = createWgpuTexture(this.device, width, height, 'rgba8', { external: true, label: key });
                        entry.view = entry.texture.createView();
                        entry.format = 'rgba8';
                    }
                    copySourceToTexture(this.device, entry.texture, source, { width, height });
                    uploadedBytes = width * height * 4;
                }
            } catch (error) {
                // An undecodable source (an image still loading) draws nothing
                // this frame and retries on the next.
                entry.source = null;
                entry.revision = null;
                return null;
            }
            const bytes = width * height * 4;
            entry.source = source;
            entry.revision = revision;
            entry.width = width;
            entry.height = height;
            this._cachedTextureBytes += bytes - (entry.bytes || 0);
            entry.bytes = bytes;
            this.uploads++;
            this.uploadBytes += uploadedBytes;
            this._uploadByteKinds[canPatch ? 'imagePatches' : 'wholeImages'] += uploadedBytes;
            this._frameUploadMs += performance.now() - started;
            if (storageChanged) {
                this._textureCacheNeedsTrim = true;
                this._updateTextureBytes();
            }
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.view;
    }

    /** V9 typed-field upload (r8, rg8, r16ui, rgba32f, rgba8), cached by key and revision. */
    uploadTypedTexture(key, { width, height, format, data, revision = null } = {}) {
        const spec = WGPU_TEXTURE_FORMATS[format];
        const w = Math.floor(finite(width));
        const h = Math.floor(finite(height));
        const channels = spec ? spec.bytesPerTexel / spec.array.BYTES_PER_ELEMENT : 0;
        if (!this.device || !this.contextHealthy || !spec || w <= 0 || h <= 0
            || !(data instanceof spec.array) || data.length < w * h * channels) {
            return null;
        }
        const bytes = w * h * spec.bytesPerTexel;
        let entry = this._textureEntries.get(key);
        const storageChanged = !entry || entry.format !== format || entry.width !== w || entry.height !== h;
        if (entry && entry.format !== format) {
            entry.texture?.destroy?.();
            this._cachedTextureBytes -= entry.bytes || 0;
            this._textureEntries.delete(key);
            entry = null;
        }
        entry = entry || this._entryFor(key, format);
        if (storageChanged || entry.revision !== revision || entry.source !== data) {
            const started = performance.now();
            if (storageChanged) {
                entry.texture?.destroy?.();
                entry.texture = createWgpuTexture(this.device, w, h, format, { label: key });
                entry.view = entry.texture.createView();
                entry.format = format;
            }
            const view = data.length === w * h * channels ? data : data.subarray(0, w * h * channels);
            writeTextureRows(this.device, entry.texture, view, w, h, spec.bytesPerTexel);
            this._cachedTextureBytes += bytes - entry.bytes;
            entry.source = data;
            entry.revision = revision;
            entry.width = w;
            entry.height = h;
            entry.bytes = bytes;
            this.uploads++;
            this.uploadBytes += bytes;
            this._uploadByteKinds.typedFields += bytes;
            this._frameUploadMs += performance.now() - started;
            if (storageChanged) {
                this._textureCacheNeedsTrim = true;
                this._updateTextureBytes();
            }
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.view;
    }

    _trimTextureCache(protectedFrame = this.frames + 1) {
        const nonTextureBytes = (this._recordBufferBytes || 0) + (this._markRecordBufferBytes || 0)
            + (this._particleBuffer ? this._particleBytes.byteLength : 0) + (this._lightRecordBuffer ? LIGHT_RECORD_BUFFER_BYTES : 0)
            + (this.sceneTarget ? this.width * this.height * texelBytes(this.presentFormat) : 0);
        const sourceBudget = Math.min(MAX_CACHED_TEXTURE_BYTES,
            160 * 1024 * 1024 - (this.textureBytes - this._cachedTextureBytes) - nonTextureBytes);
        const overCap = this._cachedTextureBytes > sourceBudget || this._textureEntries.size > MAX_CACHED_TEXTURES;
        if (!overCap) {
            this._textureCacheNeedsTrim = false;
            return;
        }
        if (!this._textureCacheNeedsTrim && sourceBudget === this._lastSourceBudget && this.frames - this._lastTextureTrimFrame < 120) return;
        this._lastSourceBudget = sourceBudget;
        this._lastTextureTrimFrame = this.frames;
        this._textureCacheNeedsTrim = false;
        const candidates = [...this._textureEntries.entries()]
            .filter(([key, entry]) => !key.startsWith('frontier:') && (entry.lastUsedFrame < protectedFrame || evictableAgentTexture(key)))
            .sort((a, b) => finite(a[1].lastUsedFrame) - finite(b[1].lastUsedFrame));
        for (const [key, entry] of candidates) {
            if (this._cachedTextureBytes <= sourceBudget && this._textureEntries.size <= MAX_CACHED_TEXTURES) break;
            // Destroyed after this frame's submit (trim runs post-submit).
            entry.texture?.destroy?.();
            if (entry.lastUsedFrame >= protectedFrame) preferAgentModelCells(key);
            this._textureEntries.delete(key);
            this._cachedTextureBytes -= entry.bytes || 0;
            this.textureEvictions++;
        }
        this._updateTextureBytes();
    }

    setPassSamplingEnabled(enabled) {
        this.passSamplingEnabled = Boolean(enabled);
    }

    _recordPass(sample) {
        const ring = this._passResults[sample.pass];
        const evicted = ring.samples[ring.next];
        if (evicted) {
            ring.cpuSum -= evicted.cpuMs;
            if (evicted.gpuMs != null) {
                ring.gpuSum -= evicted.gpuMs;
                ring.gpuCount -= 1;
            }
        }
        ring.samples[ring.next] = sample;
        ring.next = (ring.next + 1) % PASS_RING_CAPACITY;
        ring.count = Math.min(PASS_RING_CAPACITY, ring.count + 1);
        ring.cpuSum += sample.cpuMs;
        if (sample.gpuMs != null) {
            ring.gpuSum += sample.gpuMs;
            ring.gpuCount += 1;
        }
        ring.latest = sample;
    }

    _recordFrameTimerSample(gpuMs, arm = undefined) {
        this.gpuMs = ema(this.gpuMs, gpuMs);
        const ring = this._gpuTimerRing ||= {
            samples: new Float64Array(GPU_TIMER_RING),
            sorted: new Float64Array(GPU_TIMER_RING),
            count: 0,
            next: 0,
        };
        ring.samples[ring.next] = gpuMs;
        ring.next = (ring.next + 1) % GPU_TIMER_RING;
        ring.count = Math.min(GPU_TIMER_RING, ring.count + 1);
        const sorted = ring.sorted.subarray(0, ring.count);
        sorted.set(ring.samples.subarray(0, ring.count));
        sorted.sort();
        this.gpuMsP25 = sorted[Math.floor((ring.count - 1) * 0.25)];
        this.gpuMsP95 = sorted[Math.ceil(ring.count * 0.95) - 1];
        if (this._frontierMask) this._frontierWindow++;
        if (arm !== undefined && arm !== null) this._debugLoad?.samples?.[arm]?.push(gpuMs);
    }

    _onTimerResult({ frameMs, passes, metadata }) {
        if (!Number.isFinite(frameMs) || frameMs < 0) {
            this.gpuTimerErrors++;
            return;
        }
        this._recordFrameTimerSample(frameMs, metadata?.arm ?? undefined);
        if (!metadata?.passes) return;
        for (const [pass, sample] of Object.entries(metadata.passes)) {
            this._recordPass({ pass, draws: sample.draws, bytes: sample.bytes, cpuMs: sample.cpuMs, gpuMs: passes[pass] ?? null });
        }
    }

    // B.1b + V9 sidecars, as `GpuWorldRenderer._uploadBatchTextures`.
    _uploadBatchTextures(batches, occluderChannelEnabled = true) {
        const page = this._albedoPage;
        if (page) {
            const started = performance.now();
            const uploads = page.uploads;
            const bytes = page.flushUploads();
            if (bytes) {
                this.uploads += page.uploads - uploads;
                this.uploadBytes += bytes;
                this._uploadByteKinds.albedoPage += bytes;
                this._frameUploadMs += performance.now() - started;
            }
        }
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            if (batch.page) {
                batch.albedoTexture = batch.page.view;
                batch.materialTexture = null;
                batch.emissiveTexture = null;
                batch.occluderTexture = null;
                continue;
            }
            const first = batch.records[0];
            const sidecar = batch.sidecarKey || batch.textureKey;
            batch.albedoTexture = this._textureFor(batch.textureKey, batch.source, first?.textureRevision, first?.textureUpdates);
            batch.materialTexture = batch.materialSource
                ? this._textureFor(`material:${sidecar}`, batch.materialSource, first?.materialRevision ?? first?.sidecarRevision, first?.materialTextureUpdates)
                : null;
            batch.emissiveTexture = batch.emissiveSource
                ? this._textureFor(`emissive:${sidecar}`, batch.emissiveSource, first?.emissiveRevision ?? first?.sidecarRevision, first?.emissiveTextureUpdates)
                : null;
            if (!occluderChannelEnabled && batch.occluderSource) this.skippedOccluderUploads++;
            batch.occluderTexture = first?.terrainPlanes ? this.uploadTypedTexture('terrain:planes', first.terrainPlanes)
                : (occluderChannelEnabled || (this._frontierMask & 4 && first?.flags & GPU_RECORD_FLAGS.surfaceCode)) && batch.occluderSource
                ? this._textureFor(`occluder:${sidecar}`, batch.occluderSource, first?.sidecarRevision, first?.occluderTextureUpdates)
                : null;
        }
    }

    // The frame's uniforms and group-0 textures: `_setSceneUniforms`,
    // `_uploadOpenSeaUniforms` and `_present` of the WebGL2 world, one block.
    // Fields WebGL2 leaves stale when a feature is off (beam shape, puddle
    // rect/sky) are left stale here the same way.
    _resolveFrame(feed, camera, qualityLevel, batches = null) {
        const s = this._frameState;
        for (const key of Object.keys(s)) delete s[key];
        const grade = resolveFrameGrade(feed);
        const weather = resolveWeatherUniform(feed, qualityLevel);
        const view = resolveCamera(camera, 1, this._camera);
        this._camera = view;
        s.cameraXy = view.xy;
        s.cameraScale = view.scale;
        s.resolution = [this.width, this.height];
        s.packedGeometry = !this._occluderChannelSkipped;
        Object.assign(s, resolveDiurnalFrame(feed, grade), resolveFrontierFrame(this._frontierMask, {
            planarRect: this._waterInputs?.planarRect, waterH: finite(feed.atmosphere?.lunarTide?.level ?? feed.waterH), basinHandle: this._frontierMask & 1,
            fieldRevision: this._frontierRevision ?? 0,
        }));
        s.gradeExposure = grade.exposure;
        s.gradeSaturation = grade.saturation;
        s.gradeGain = grade.gain;
        s.gradeLift = grade.lift;
        s.gradeGamma = grade.gamma;
        s.gradePurkinje = grade.purkinje;
        s.gradeShadow = grade.shadowTint;
        s.gradeHighlight = grade.highlightTint;
        s.gradeEdge = grade.vignetteEdge;
        s.edgeAlpha = grade.vignetteAlpha;
        s.poolGain = grade.poolGain ?? 1;
        s.fogColor = grade.fogColor;
        const cloudCover = clamp(finite(feed.atmosphere?.weather?.cloudCover, 0), 0, 1);
        s.overcast = clamp((cloudCover - 0.7) / 0.2, 0, 1);
        s.weather = weather;
        this._frameWeather = weather;
        // MS-1 — the low mist (prepareFrame's resolveMist; zero = today's veil).
        s.mist = this.mist;
        // MS-2 — the burn-off shares of the mist's top.
        s.mistBurn = this.mistBurn;
        const sun = feed.lighting?.sunDirIso || {};
        s.sun = [finite(sun.x, -0.7071), finite(sun.y, -0.7071), clamp(finite(feed.lighting?.sunWarmth), 0, 1), clamp(finite(grade.sunBand, 1), 0, 1)];
        this._frameGradeForComposite = grade;
        this._compositeQualityLevel = qualityLevel;
        const courses = resolveAtmosphereCourses(qualityLevel, camera, feed, grade, this._atmosphereCourses);
        this.cloudCourses = courses.courses;
        this.aerialHaze = courses.aerialHaze;
        s.cloud = courses.cloud;
        s.cloudThresholds = courses.thresholds;
        s.cloudLone = courses.lone;
        // SEA-1 — the sunlit water's lift in stops.
        s.seaLift = courses.lift;
        // SEA-2 / SEA-3 — the sky on lit water and the sea state (prepareFrame).
        s.seaState = this._seaState.uniform;
        s.haze = courses.haze;
        s.hazeStart = courses.hazeStart;
        // Sea weather: the sunlit ceiling and the C-W3 gust field.
        const sea = resolveSeaWeather(qualityLevel, camera, feed, {
            courses: this._atmosphereCourses, width: this.width, height: this.height,
        }, this._seaWeather);
        const windField = this._frontierMask & 8 && this._frontierPasses.get('wind').pass.getCurrentFieldView();
        const gust = windField || (sea.gust
            ? this.uploadTypedTexture('sea:gust', {
                width: sea.gust.width, height: sea.gust.height, format: 'r8', data: sea.gust.data, revision: sea.gust.revision,
            })
            : null);
        this._seaWeatherFrame.sunlit = sea.sunlit;
        this._seaWeatherFrame.gust = gust;
        s.seaSunlit = finite(sea.sunlit, 0);
        // W6.11 — the scene's grass gust course reads the same field.
        s.grassGust = gust ? finite(sea.grassGust, 0) : 0;
        // BI-1 — still water's paws (the same field) and the knot wind's share.
        const still = this._stillWater || (this._stillWater = new Float32Array(2));
        still[0] = gust ? finite(sea.stillPaws, 0) : 0;
        still[1] = finite(sea.stillShare, 1);
        s.stillWater = still;
        s.seaGustRect = windField ? [WIND_WORLD_BOUNDS.originX, WIND_WORLD_BOUNDS.originY, WIND_WORLD_BOUNDS.width / 128, WIND_WORLD_BOUNDS.height / 128] : gust ? this._seaWeather.gustState.rect : ZERO4;
        const energy = sourceEnergyFor(feed.lighting);
        this.sourceEnergy = energy;
        const daytimeWorkBloom = energy.bucket === 'daylight' && hasActiveBloomEmitters(batches);
        this._daytimeWorkBloom = daytimeWorkBloom;
        s.coreEnergy = daytimeWorkBloom
            ? DAYTIME_WORK_BLOOM_CORE
            : clamp(finite(energy.core, 1), 0, 2);
        const moonFill = clamp(finite(feed.lighting?.moonFill, 0), 0, 1);
        const water = resolveWaterFx(feed, camera, qualityLevel, grade, moonFill, this.width, this._waterFx);
        s.waterFx = water.fx;
        s.starlight = water.starlight;
        s.swellDrift = water.swellDrift;
        s.surfGlow = water.surfGlow;
        s.glint = water.glint;
        s.glintStops = vec3Pair(water.stops);
        // 3.1 / 3.6 — the coast lattice fields (MINIMAL: absent).
        const fields = feed.coastWater;
        let cycle = null;
        let coast = null;
        const live = effectBudgetMode('waterCrests', qualityLevel) === 'on' || effectBudgetMode('coastSwash', qualityLevel) === 'on';
        const baked = fields?.cols > 0 && fields?.rows > 0;
        if (live && baked) {
            cycle = this.uploadTypedTexture('field:cycle-offset', {
                width: fields.cols, height: fields.rows, format: 'r8', data: fields.cycleOffset, revision: fields.revision,
            });
        }
        // EN-7 — the coast field stays bound at MINIMAL for its mirror stops
        // alone (`mirrorRect`); every other reader keeps `coastRect` 0 there.
        if (baked) {
            coast = this.uploadTypedTexture('field:coast', {
                width: fields.cols, height: fields.rows, format: 'rgba8', data: coastFieldTexels(fields), revision: fields.revision,
            });
        }
        const present = Boolean(cycle && coast);
        s.coastRect = present ? [fields.x, fields.y, fields.cols, fields.rows] : ZERO4;
        s.mirrorRect = coast ? [fields.x, fields.y, fields.cols, fields.rows] : ZERO4;
        s.mirrorBreak = mirrorStormDrop(feed.weather || feed.atmosphere?.weather, feed.atmosphere || null);
        this.waterFieldsActive = present;
        const mood = waterMoodFor({ lightGrade: grade, weather: feed.weather || feed.atmosphere?.weather });
        s.waterMood = [mood.night, mood.storm];
        s.waterSky = [mood.sky[0], mood.sky[1], mood.sky[2], mood.skyWeight];
        const lightFrame = resolveLights(feed, camera, qualityLevel, {
            width: this.width, height: this.height, view: this._camera, clusterOverride: this.lightClusterOverride, state: this._lightFrame,
        });
        s.wetness = clamp(finite(feed.wetness, 0), 0, 1);
        this.wetReflectionCount = lightFrame.wetReflectionCount;
        s.wetReflectionCount = this.wetReflectionCount;
        // 5.2 — puddles.
        const puddles = resolvePuddles(feed, this._puddles, qualityLevel);
        // GW-1 / GW-2 — the ground weather field (RGBA8, raw bytes) takes
        // this binding instead of the R8 mask while either look is on.
        const puddleMask = puddles.mask
            ? this.uploadTypedTexture(puddles.textureKey, {
                width: puddles.mask.cols, height: puddles.mask.rows, format: puddles.format, data: puddles.mask.data, revision: puddles.revision,
            })
            : null;
        this._puddleActive = Boolean(puddleMask);
        s.puddles = puddleMask ? puddles.puddles : 0;
        s.groundWeather = puddleMask ? puddles.groundWeather : ZERO4;
        if (puddleMask) {
            s.puddleRect = puddles.rect;
            s.puddleSky = vec3Pair(puddles.sky);
        }
        const lutSource = resolvePaletteLut(qualityLevel, feed);
        const lut = this.uploadTypedTexture('lut:palette-ramp', agentPaletteLut);
        this.paletteLutActive = Boolean(lut && lutSource);
        s.hasPaletteLut = this.paletteLutActive;
        // NL-2 / NL-1 — firelight on people and the tuned ramp (Firelight.js).
        s.firelight = resolveFirelight(this._firelight ||= new Float32Array(2));
        const shaderTimeMs = ((finite(feed.timeMs, Date.now()) % 1000000) + 1000000) % 1000000;
        s.timeMs = shaderTimeMs;
        s.motionScale = feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2);
        this.localLightPhase = lightFrame.localLightPhase;
        this._uploadLightRecords(lightFrame.records, lightFrame.recordsRevision);
        const tiles = lightFrame.tiles
            ? this.uploadTypedTexture('light:tiles', {
                width: lightFrame.tilesX * LIGHT_TILE_STRIDE, height: lightFrame.tilesY, format: 'r16ui', data: lightFrame.tiles, revision: lightFrame.tilesRevision,
            })
            : this.uploadTypedTexture('light:tiles-empty', { width: 1, height: 1, format: 'r16ui', data: this._lightTilesEmpty });
        this.lightCount = lightFrame.count;
        s.lightCount = lightFrame.count;
        s.lightTileGrid = [lightFrame.tilesX, lightFrame.tilesY, lightFrame.clusters ? 1 : 0];
        const field = lightFrame.footprint;
        const footprint = field?.data
            ? this.uploadTypedTexture('field:footprint', {
                width: field.width, height: field.height, format: 'rg8', data: field.data, revision: field.revision ?? null,
            })
            : null;
        this.footprintMarchSteps = footprint ? lightFrame.marchSteps : 0;
        s.footprintRect = [finite(field?.originX), finite(field?.originY), footprint ? finite(field.cell, 4) : 0];
        s.footprintSize = [footprint ? field.width : 0, footprint ? field.height : 0];
        s.marchSteps = this.footprintMarchSteps;
        // SD-2 — the sun's shade field, uploaded once per built field (off:
        // the empty view and a zero rect, so no fragment reads it).
        const sunShade = resolveSunShade(feed, this._sunShade ||= {});
        const shadeField = sunShade.texture ? this.uploadTypedTexture('field:shade', sunShade.texture) : null;
        s.shadeRect = shadeField ? sunShade.rect : ZERO4;
        s.shade = sunShade.steps;
        // 2.10 — declared exclusion: the reader stays off (w = 0).
        s.radianceGrid = ZERO4;
        // The composite's open sea and present terms.
        s.seaOn = true;
        s.seaSunBand = clamp(finite(grade.sunBand, 1), 0, 1);
        const atmosphere = feed.atmosphere || null;
        const seaWeatherSky = feed.weather || atmosphere?.weather || null;
        const sky = openSeaSky(atmosphere);
        s.seaHaze = [sky.haze[0], sky.haze[1], sky.haze[2], openSeaHazeRows(seaWeatherSky?.fog)];
        s.seaSky = sky.horizon;
        const seaWeatherOn = effectBudgetMode('sea-weather', qualityLevel) === 'on';
        const squall = seaWeatherOn ? openSeaSquall(seaWeatherSky, feed.timeMs) : null;
        s.squall = [squall?.x ?? 0, squall?.y ?? 0, squall?.halfWidth ?? 1, squall?.strength ?? 0];
        s.squallFall = squall?.fall ?? 0;
        this.openSeaDiagnostics = { squall: Boolean(squall), paws: Boolean(gust), sunlit: finite(sea.sunlit, 0) > 0 };
        const bloomMode = effectBudgetMode('bloom', qualityLevel);
        const bloomStrength = bloomMode === 'off' ? 0 : bloomMode === 'reduced' ? 0.42 : 0.72;
        const bloomEnergy = daytimeWorkBloom
            ? DAYTIME_WORK_BLOOM_STRENGTH
            : clamp(finite(energy.bloom, 1), 0, 2);
        const bloomSources = this.lightCount > 0 || daytimeWorkBloom;
        s.bloomStrength = bloomSources ? bloomStrength * bloomEnergy : 0;
        // 10.2 / 10.3 — the display path's uniforms (read only by the roles
        // composite and mark fragment). Under HDR the emitter courses gain
        // only while the lamps are lit (the `settling` lamp course), up to the
        // mode's emitter cap (below the NEEDS YOU mark's light), marks
        // always, and bloom runs at half strength alongside the role gain (NE P1.4).
        const display = this._display;
        const gains = this._displayWant.gains;
        s.hdrEnabled = display?.hdr ? 1 : 0;
        s.p3Enabled = display?.p3 ? 1 : 0;
        s.hdrMode = HDR_HIGHLIGHT_MODES.indexOf(this.hdrMode);
        s.hdrMarkGain = display?.hdr ? gains.mark : 1;
        s.hdrEmitterGain = display?.hdr && hdrLampsLit(atmosphere) ? gains.emitter : [1, 1, 1];
        s.hdrEmitterCap = gains.emitterCap;
        if (display?.hdr) s.bloomStrength *= 0.5;
        this._frameBloomStrength = s.bloomStrength;
        const flash = feed.flash;
        s.flash = [finite(flash?.[0], 0), finite(flash?.[1], 0), finite(flash?.[2], 0)];
        s.fatPixels = this.fatPixelsFrame;
        writeFrameUniforms(this._frameViews, s);
        this._bindFrameGroup({
            seaGust: gust,
            lightTiles: tiles,
            footprint,
            cycleOffset: present ? cycle : null,
            coastField: coast,
            puddleMask,
            paletteLut: lut,
            motifs: this._particleCount > 0 ? this._particleMotifTexture : null,
            shadeField,
        });
    }

    _bindFrameGroup(views) {
        const empty = this.emptyMaterialView;
        const F = FRAME_BINDING;
        const resources = [
            [F.cloudTile, this.cloudTileView],
            [F.seaGust, views.seaGust || empty],
            [F.lightTiles, views.lightTiles],
            [F.footprint, views.footprint || empty],
            [F.cycleOffset, views.cycleOffset || empty],
            [F.coastField, views.coastField || empty],
            [F.puddleMask, views.puddleMask || empty],
            [F.paletteLut, views.paletteLut || empty],
            [F.radianceTex, empty],
            [F.motifs, views.motifs || empty],
            [F.shadeField, views.shadeField || empty],
        ];
        const key = resources.map(([, view]) => gpuId(view)).join(',');
        if (key === this._frameBindKey && this._frameBindGroup) return;
        this._frameBindKey = key;
        const descriptor = {
            label: 'world-frame',
            layout: this.pipelines.layouts.frame,
            entries: [
                { binding: F.frame, resource: { buffer: this._frameBuffer } },
                { binding: F.lightData, resource: { buffer: this._lightRecordBuffer } },
                ...resources.map(([binding, resource]) => ({ binding, resource })),
                { binding: F.cloudSampler, resource: this._samplers.cloud },
                { binding: F.seaGustSampler, resource: this._samplers.linear },
                { binding: F.nearestSampler, resource: this._samplers.nearest },
                { binding: F.radianceSampler, resource: this._samplers.linear },
                { binding: F.linearSampler, resource: this._samplers.linear },
            ],
        };
        this._frameBindGroup = this.device.createBindGroup(descriptor);
        this._frameDescriptor = descriptor;
        this._surfaceGroups.clear();
    }

    _surfaceGroup(record) {
        const source = (record.flags & GPU_RECORD_FLAGS.surfacePage) && record.surfaceSource;
        if (!source) return this._frameBindGroup;
        const key = 'frontier:surface:' + (record.surfaceKey || record.textureKey);
        if (!this._surfacePages.has(key)) {
            if (source.width > 512 || source.height > 512 || this._surfacePages.size >= 2) return this._surfaceViewGroup(this.emptyMaterialView);
            this._surfacePages.add(key);
        }
        const surface = source.data
            ? this.uploadTypedTexture(key, { ...source, format: 'rgba8', revision: source })
            : this._textureFor(key, source, source);
        return this._surfaceViewGroup(surface || this.emptyMaterialView);
    }

    _surfaceViewGroup(surface) {
        let group = this._surfaceGroups.get(surface);
        if (!group) {
            group = this.device.createBindGroup({ ...this._frameDescriptor, label: 'world-surface-v1',
                entries: this._frameDescriptor.entries.map(entry => entry.binding === FRAME_BINDING.motifs
                    ? { binding: entry.binding, resource: surface } : entry) });
            this._surfaceGroups.set(surface, group);
        }
        return group;
    }

    // The light records (common.js `lightData`): the floats WebGL2 uploads as
    // its RGBA32F record texture, rewritten when their revision moves (the
    // uploadTypedTexture rule).
    _uploadLightRecords(records, revision) {
        if (records === this._lightRecordsSource && revision === this._lightRecordsRevision) return;
        const started = performance.now();
        this.device.queue.writeBuffer(this._lightRecordBuffer, 0, records.buffer, records.byteOffset, LIGHT_RECORD_BUFFER_BYTES);
        this._lightRecordsSource = records;
        this._lightRecordsRevision = revision;
        this.uploads++;
        this.uploadBytes += LIGHT_RECORD_BUFFER_BYTES;
        this._uploadByteKinds.lightRecords += LIGHT_RECORD_BUFFER_BYTES;
        this._frameUploadMs += performance.now() - started;
    }

    _ensureBuffer(name, bytesName, byteLength, usage, label) {
        if (this[name] && this[bytesName] >= byteLength) return false;
        this[name]?.destroy?.();
        const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, byteLength))));
        this[name] = this.device.createBuffer({ size, usage, label });
        this[bytesName] = size;
        this._batchBindGroups.clear();
        return true;
    }

    _batchBindGroup(recordBuffer, batch) {
        const B = BATCH_BINDING;
        const albedo = batch.page ? this.emptyMaterialView : batch.albedoTexture;
        const page = batch.page ? batch.albedoTexture : (this._albedoPage?.view || this.emptyAlbedoPageView);
        const material = batch.materialTexture || this.emptyMaterialView;
        const emissive = batch.emissiveTexture || this.emptyMaterialView;
        const occluder = batch.occluderTexture || this.emptyMaterialView;
        const key = `${gpuId(recordBuffer)}:${gpuId(this._batchBuffer)}:${gpuId(albedo)}:${gpuId(page)}:${gpuId(material)}:${gpuId(emissive)}:${gpuId(occluder)}`;
        let cached = this._batchBindGroups.get(key);
        if (!cached) {
            cached = {
                group: this.device.createBindGroup({
                    layout: this.pipelines.layouts.batch,
                    entries: [
                        { binding: B.batch, resource: { buffer: this._batchBuffer, offset: 0, size: BATCH_UNIFORM_LAYOUT.size } },
                        { binding: B.recs, resource: { buffer: recordBuffer } },
                        { binding: B.albedo, resource: albedo },
                        { binding: B.albedoPage, resource: page },
                        { binding: B.materialMap, resource: material },
                        { binding: B.emissiveMap, resource: emissive },
                        { binding: B.occluderMap, resource: occluder },
                        { binding: B.albedoSampler, resource: this._samplers.nearest },
                    ],
                }),
                lastUsedFrame: this.frames,
            };
            this._batchBindGroups.set(key, cached);
        }
        cached.lastUsedFrame = this.frames;
        return cached.group;
    }

    _pruneBindGroups() {
        if (this.frames % 120 !== 0) return;
        for (const [key, cached] of this._batchBindGroups) {
            if (this.frames - cached.lastUsedFrame > 120) this._batchBindGroups.delete(key);
        }
    }

    _writeBatchSlot(slot, batch, { mark = false } = {}) {
        const s = this._batchState;
        const first = batch.records[0];
        const terrain = !mark && first?.id === 'terrain:static';
        const optOut = ((first?.flags || 0) & GPU_RECORD_FLAGS.fatOptOut) !== 0;
        const size = batch.page ? [ALBEDO_PAGE_SIZE, ALBEDO_PAGE_SIZE] : (batch.albedoSize || [1, 1]);
        s.albedoSize = size;
        s.trimColumn = -1;
        s.supportH = finite(first?.supportH);
        s.sublayerRank = finite(first?.sublayerRank);
        s.surfaceOffset = first?.surfaceOffset || ZERO4;
        s.albedoPaged = Boolean(batch.page);
        s.fatPixels = !mark && this.fatPixelsFrame && !optOut;
        s.additive = !mark && batch.blend === 'add';
        s.terrainBatch = terrain;
        s.puddleGround = this._puddleActive && terrain;
        s.hasMaterialMap = Boolean(batch.materialTexture);
        s.hasEmissiveMap = Boolean(batch.emissiveTexture);
        s.hasOccluderMap = Boolean(batch.occluderTexture);
        s.cueRuns = !mark && Boolean(batch.cueRuns);
        s.writesDepth = batch.writesDepth === true;
        writeBatchUniforms(this._batchViews, slot, s);
    }

    _ensureBatchSlots(count) {
        if (this._batchViews.buffer.byteLength < count * BATCH_UNIFORM_STRIDE) {
            this._batchViews = createUniformViews(2 ** Math.ceil(Math.log2(count)) * BATCH_UNIFORM_STRIDE);
        }
        const u = globalThis.GPUBufferUsage;
        this._ensureBuffer('_batchBuffer', '_batchBufferSlotsBytes', count * BATCH_UNIFORM_STRIDE, u.UNIFORM | u.COPY_DST, 'world-batches');
    }

    _stageMarks(marks, upload = true) {
        this._markByteLength = 0;
        if (!marks?.length) {
            this._markBatches.length = 0;
            return this._markBatches;
        }
        const batches = buildStableGpuBatches(marks, this._markBatches, this._markNormalized);
        const byteLength = stageGpuRecords(batches, this._markStaging, { fullTail: true });
        this._markByteLength = byteLength;
        const u = globalThis.GPUBufferUsage;
        this._ensureBuffer('_markRecordBuffer', '_markRecordBufferBytes', byteLength, u.STORAGE | u.COPY_DST, 'world-mark-records');
        if (upload) this.device.queue.writeBuffer(this._markRecordBuffer, 0, this._markStaging.f32.buffer, 0, byteLength);
        for (const batch of batches) {
            const first = batch.records[0];
            batch.albedoTexture = this._textureFor(batch.textureKey, batch.source, first?.textureRevision);
            batch.albedoSize = batch.albedoTexture ? [this._textureEntries.get(batch.textureKey)?.width || 1, this._textureEntries.get(batch.textureKey)?.height || 1] : null;
            batch.materialTexture = null;
            batch.emissiveTexture = null;
            batch.occluderTexture = null;
            batch.page = null;
        }
        return batches;
    }

    notePresentInterval(intervalMs) {
        if (!this._presentIntervalsNoted) {
            this._presentIntervalsNoted = true;
            globalThis.document?.addEventListener?.('visibilitychange', this._onVisibilityChange);
        }
        this._pendingPresentIntervalMs = intervalMs;
        const dpr = globalThis.devicePixelRatio || 1;
        const screenWidth = globalThis.screen?.width || 0;
        const screenHeight = globalThis.screen?.height || 0;
        if (dpr !== this._displayDpr || screenWidth !== this._displayScreenWidth || screenHeight !== this._displayScreenHeight) {
            if (this._displayDpr !== null) {
                this.qualityLadder.relatch();
                this._pendingPresentIntervalMs = null;
            }
            this._displayDpr = dpr;
            this._displayScreenWidth = screenWidth;
            this._displayScreenHeight = screenHeight;
        }
    }

    prepareFrame(feed = {}) {
        const qualityLevel = Math.min(this.qualityLadder.getLevel(), POST_FX_LEVELS.MINIMAL);
        this._preparedQualityLevel = qualityLevel;
        this._preparedFeed = feed;
        // MS-1 — the low mist; WorldFrameRenderer reads it to drop the fog-bank records.
        this.mist = resolveMist(feed, qualityLevel, this.mist);
        // MS-2 — the burn-off shares (land, sea) of the mist's top.
        this.mistBurn = resolveMistBurn(feed, this.mist, this.mistBurn);
        // SEA-2 / SEA-3 — the sky on lit water and the sea state, once a frame.
        const seaNight = waterMoodFor({ lightGrade: resolveFrameGrade(feed), weather: feed.weather || feed.atmosphere?.weather }).night;
        this._seaState = resolveSeaState(feed, qualityLevel, seaNight, this._seaState);
        return resolveOccluderChannel(feed);
    }

    hasPendingGpuQueries() {
        return (this._timer?.pending ?? 0) > 0;
    }

    ensureFreshOutput(force = false) {
        if (!force && this._freshOutputThisTask) return true;
        const input = this._lastRenderInput;
        if (!input) return false;
        const previous = input.forceFreshOutput;
        input.forceFreshOutput = true;
        try {
            // A readback/late-mark rescue repaints the same logical frame; it
            // must not add a second pacing or timing sample.
            return this.render(input, true);
        } finally {
            input.forceFreshOutput = previous;
        }
    }

    // RN-1 — this frame's world rain (look `rn1`; EFFECT_BUDGET `world-rain`,
    // off at MINIMAL, where the overlay keeps the whole field) and its
    // open-ground splash mask (GpuWorldRenderer `_prepareRain`'s twin).
    _prepareRain(feed, camera, qualityLevel) {
        const mask = lookStrength('rn1') > 0 ? rainSplashMask(feed?.rainSplashTiles?.(), Boolean(this._frontierMask & 4)) : null;
        this._rainMaskView = mask ? this.uploadTypedTexture('rain:splash-mask', mask) : null;
        const field = gpuRainField(feed?.atmosphere, camera, {
            timeMs: feed?.timeMs,
            viewport: feed?.rainViewport,
            on: effectBudgetMode('world-rain', qualityLevel) === 'on' && Boolean(this._rainBuffer),
            splashMask: Boolean(this._rainMaskView),
        }, this._rain);
        this.rainInstances = field.instances;
        this.rainShare = field.instances > 0 ? field.share : 0;
    }

    _rainGroup() {
        const view = this._rainMaskView || this.emptyMaterialView;
        if (!this._rainBindGroup || this._rainBindGroupView !== view) {
            this._rainBindGroup = this.device.createBindGroup({
                label: 'world-rain',
                layout: this.pipelines.layouts.rain,
                entries: [
                    { binding: RAIN_BINDING.rain, resource: { buffer: this._rainBuffer } },
                    { binding: RAIN_BINDING.mask, resource: view },
                ],
            });
            this._rainBindGroupView = view;
        }
        return this._rainBindGroup;
    }

    _encodeRipples(encoder, records, feed, motion, dtSec) {
        const ripple = this._frontierPasses.get('ripples').pass;
        const water = this._waterInputs;
        if (water) {
            if (!water.boundaryUploaded) {
                ripple.uploadBoundaryField(water.boundary);
                water.boundaryUploaded = true;
            }
            const moved = new Map();
            const impulseAt = (wx, wy, kind, radius, strength, key = null) => {
                const x = Math.floor((wx - water.rippleOrigin[0]) * water.rippleScale);
                const y = Math.floor((wy - water.rippleOrigin[1]) * water.rippleScale);
                if (x < 0 || y < 0 || x >= RIPPLE_GRID_WIDTH || y >= RIPPLE_GRID_HEIGHT) return;
                const cell = y * RIPPLE_GRID_WIDTH + x;
                if (key !== null) {
                    moved.set(key, cell);
                    if (!this._hullPositions.has(key) || this._hullPositions.get(key) === cell) return;
                }
                if (water.boundary[4 * cell] && !motion.reducedMotion) ripple.queueImpulse({ x, y, kind, radius, strength });
            };
            for (const r of records) {
                if (!r.mirrorSource || !r.id?.startsWith('harbor:hull:')) continue;
                const bow = r.bowOffsetX || r.width * 0.3;
                impulseAt(r.frontCornerX + bow, r.footY, 'boat', 3, 1, r.id + ':bow');
                impulseAt(r.frontCornerX - bow, r.footY, 'wake', 2, 0.65, r.id + ':stern');
            }
            if (water.spillwaySplashes?.length) {
                water.spillElapsed = motion.reducedMotion || motion.visibilityReturned ? 0 : (water.spillElapsed || 0) + dtSec;
                if (water.spillElapsed >= RIPPLE_FIXED_DT) {
                    water.spillElapsed %= RIPPLE_FIXED_DT;
                    for (const { x, y } of water.spillwaySplashes) impulseAt(x, y, 'spillway', 2, 0.6);
                }
            }
            feed.duckPaddles?.forEach(([x, y], i) => impulseAt(x, y, 'wake', 1, 0.35, i));
            this._hullPositions = moved;
            if (this.rainInstances && !motion.reducedMotion) {
                const u = this._rain.uniforms;
                const [ox, oy, cols] = u;
                const rows = Math.ceil(this.rainInstances / cols);
                for (let cy = oy; cy < oy + rows; cy++) {
                    for (let cx = ox; cx < ox + cols; cx++) {
                        const seed = rainCellHash(Math.imul(cx + 32768, 0x8da6b343) ^ Math.imul(cy + 32768, 0xd8163841) ^ u[3]);
                        if (seed / 4294967296 >= u[4]) continue;
                        const pick = rainCellHash(seed ^ 0x68e31da4) / 4294967296;
                        const layer = pick < RAIN_LAYER_TABLE.cut0 ? 0 : pick < RAIN_LAYER_TABLE.cut1 ? 1 : 2;
                        const phase = u[8 + layer];
                        const impact = 1 - rainCellHash(seed + 3) / 4294967296;
                        const previous = this._rainPhases?.[layer];
                        if (previous == null || !((phase >= previous) ? impact > previous && impact <= phase : impact > previous || impact <= phase)) continue;
                        const rx = cx * RAIN_GROUND_CELL + Math.floor(rainCellHash(seed + 1) / 4294967296 * RAIN_GROUND_CELL);
                        const ry = cy * RAIN_GROUND_CELL + Math.floor(rainCellHash(seed + 2) / 4294967296 * RAIN_GROUND_CELL);
                        impulseAt(rx, ry, 'rain', 1, 0.3);
                    }
                }
                this._rainPhases = u.slice(8, 11);
            } else this._rainPhases = null;
        }
        for (const impulse of feed.waterImpulses || []) ripple.queueImpulse(impulse);
        return ripple.encode(encoder, { ...motion, dtSec });
    }

    _encodeFrontierWater(encoder, records, target, emission, feed) {
        const { bake, exposure, contact, basin, planarRect, maskView } = this._waterInputs;
        const pass = this._frontierPasses.get('mirror').pass;
        const state = this._frameState;
        const waterZ = state.basinParams[0];
        const [left, top, width, height] = planarRect;
        const [cx, cy] = state.cameraXy;
        const scale = state.cameraScale;
        const x = Math.max(0, Math.floor((left + cx) * scale));
        const y = Math.max(0, this.height - Math.ceil((top + height + cy) * scale));
        const w = Math.min(this.width, Math.ceil((left + width + cx) * scale)) - x;
        const h = Math.min(this.height, this.height - Math.floor((top + cy) * scale)) - y;
        if (w <= 0 || h <= 0) return;
        const mirrorBatches = this._mirrorBatches;
        let count = 0, batchCount = 0;
        const add = (rx, ry, rw, rh, u0, v0, u1, v1, foot, proxy) => {
            const offset = count++ * 12;
            if (!this._mirrorStaging || offset + 12 > this._mirrorStaging.length) {
                const larger = new Float32Array(Math.max(768, offset * 2));
                if (offset) larger.set(this._mirrorStaging);
                this._mirrorStaging = larger;
            }
            const data = this._mirrorStaging;
            data[offset] = rx; data[offset + 1] = ry; data[offset + 2] = rw; data[offset + 3] = rh;
            data[offset + 4] = u0; data[offset + 5] = v0; data[offset + 6] = u1; data[offset + 7] = v1;
            data[offset + 8] = foot - ry - rh; data[offset + 9] = foot - ry;
            data[offset + 10] = 2 * foot + (proxy ? 1 / 32 : 0);
        };
        const append = r => {
            const view = this._textureFor(r.textureKey, r.source, r.textureRevision);
            if (!view) return;
            const first = count;
            const sx = r.sx || 0, sy = r.sy || 0;
            const sw = r.sw || r.sourceWidth, sh = r.sh || r.sourceHeight;
            if (r.mirrorColumns) {
                for (let col = sx; col < sx + sw; col++) for (const span of r.mirrorColumns[col]) {
                    const start = Math.max(sy, span.start), end = Math.min(sy + sh, span.end);
                    if (start >= end) continue;
                    // The art ends at the piling tip. Falling water cannot expose a missing lower texel.
                    const lowWater = span.foot === span.end ? Math.min(0, waterZ) : 0;
                    add(r.x + col - sx, r.y + start - sy, 1, end - start, col / r.sourceWidth, start / r.sourceHeight,
                        (col + 1) / r.sourceWidth, end / r.sourceHeight, r.y + span.foot - sy + lowWater, r.mirrorOnly);
                }
            } else {
                const u0 = sx / r.sourceWidth, u1 = (sx + sw) / r.sourceWidth;
                const foot = planarMirrorFoot(r, waterZ);
                add(r.x, r.y, r.width, r.height, r.flipX ? u1 : u0, sy / r.sourceHeight, r.flipX ? u0 : u1,
                    (sy + sh) / r.sourceHeight, foot, false);
            }
            if (count === first) return;
            let group = this._mirrorGroups.get(view);
            if (!group) {
                group = this.device.createBindGroup({ layout: pass.mirrorBindGroupLayout, entries: [
                    { binding: 0, resource: { buffer: pass.mirrorUniformBuffer } },
                    { binding: 1, resource: view }, { binding: 2, resource: pass.mirrorSampler },
                ] });
                this._mirrorGroups.set(view, group);
            }
            const batch = mirrorBatches[batchCount++] ||= {};
            batch.bindGroup = group;
            batch.firstInstance = first;
            batch.instanceCount = count - first;
        };
        const captureMirror = feed.reducedMotion || this._frontierPolicy?.frontierFlags.mirrorCadence !== false || !pass._mirrorClearCount || this.frames % 2 === 0;
        if (captureMirror) {
            const admission = { basinId: 1 };
            for (const r of records) {
                if (!isMirrorAdmittedRecord(r, admission)) continue;
                if (r.mirrorProxy) append(r.mirrorProxy);
                append(r);
            }
            mirrorBatches.length = batchCount;
        }
        if (count) {
            const usage = globalThis.GPUBufferUsage;
            this._ensureBuffer('_mirrorBuffer', '_mirrorBufferBytes', count * 48, usage.VERTEX | usage.COPY_DST, 'harbor-mirror-quads');
            this.device.queue.writeBuffer(this._mirrorBuffer, 0, this._mirrorStaging.buffer, 0, count * 48);
            for (const batch of mirrorBatches) batch.instanceBuffer = this._mirrorBuffer;
        }
        // Horizontal refraction never crosses strip boundaries. Reuse this bounded
        // scratch texture even when the Harbor fills an ultrawide display.
        const bedWidth = Math.min(this.width, Math.ceil(width * scale) + 2);
        const bedHeight = Math.min(64, this.height);
        if (!this._waterBed || this._waterBed.width !== bedWidth || this._waterBed.height !== bedHeight) {
            this._waterBed?.destroy();
            this._waterBed = createWgpuTexture(this.device, bedWidth, bedHeight, 'rgba8', { label: 'frontier-clean-bed' });
            this._waterBedView = this._waterBed.createView();
            this._resolveGroups.length = 0;
        }
        const upload = (key, data, format, w, h) => this.uploadTypedTexture('frontier:' + key, { data, format, width: w, height: h, revision: bake.key });
        const ripple = (this._frontierMask & 2) && this._frontierPasses.get('ripples').pass;
        const index = ripple ? ripple._readIndex : 2;
        const empty = this.emptyMaterialView;
        if (this._resolveBake !== bake) { this._resolveGroups.length = 0; this._resolveBake = bake; }
        const group = this._resolveGroups[index] ||= pass.createResolveTextureBindGroup({
            bed: this._waterBedView, occupancy: upload('exposure', exposure, 'r8', width / 2, height / 2),
            contacts: upload('contacts', contact, 'rgba8', width, height), basinMap: upload('basin', basin, 'r16ui', width / 2, height / 2),
            cycle: empty, coast: maskView, gust: empty, rippleState: ripple ? ripple.getReadView() : empty,
        });
        const linearSky = row => [...row.slice(0, 3).map(c => srgb8ToLinear16(Math.round(255 * c)) / 65535), row[3]];
        pass.encode(encoder, { ...state, waterZ, planarRect, basinId: 1, records, mirrorBatches, captureMirror,
            bedCopy: { source: target.color.texture, bed: this._waterBed, origin: [x, y], size: [w, h] },
            featureMask: this._frontierMask, maxSat: waterMaxSaturation({ night: state.waterMood[0], storm: state.waterMood[1] }),
            resolveTargetView: target.color.view, resolveEmissionView: emission && target.emission.view,
            resolveTextureBindGroup: group, reducedMotion: feed.reducedMotion, skyFar: linearSky(state.skyFar),
            skyNear: linearSky(state.skyNear), coastOrigin: [left, top, ...this._waterInputs.rippleOrigin],
            rippleSize: [RIPPLE_GRID_WIDTH, RIPPLE_GRID_HEIGHT, this._waterInputs.rippleScale, planarRect[1]],
            revision: state.frontier[2] });
    }

    render(input = {}, repeatOutput = false) {
        const { records = [], camera = null, feed = {}, particles = null, marks = null, forceFreshOutput = false } = input;
        this._freshOutputThisTask = false;
        // FP-2 — true only after a frame the byte gate reused: its staged
        // inputs equal the presented frame's (IsometricRenderer._canSkipIdleFrame).
        this.lastFrameReused = false;
        if (!this.isActive() || !camera || !records.length) return false;
        const device = this.device;
        const timerWasPending = this.hasPendingGpuQueries();
        const started = performance.now();
        const frameGapMs = repeatOutput || this._lastRenderAtMs == null ? 0 : started - this._lastRenderAtMs;
        if (!repeatOutput) this._lastRenderAtMs = started;
        const presentIntervalMs = repeatOutput ? null
            : this._presentIntervalsNoted ? this._pendingPresentIntervalMs : frameGapMs;
        if (!repeatOutput) this._pendingPresentIntervalMs = null;
        this._frameUploadMs = 0;
        const occluderChannelEnabled = this._preparedFeed === feed ? resolveOccluderChannel(feed) : this.prepareFrame(feed);
        const qualityLevel = this._preparedQualityLevel;
        this._preparedFeed = null;
        if (occluderChannelEnabled && this._occluderChannelSkipped) {
            for (const [key, entry] of this._textureEntries) {
                // A versioned sidecar stays resident. _textureFor compares its source,
                // dimensions and revision, and falls back to a full copy after missed patches.
                if (entry.revision == null && key.startsWith('occluder:')) entry.source = null;
            }
        }
        this._occluderChannelSkipped = !occluderChannelEnabled;
        this.fatPixelsFrame = resolveFatPixels(camera, this.fatPixelsOverride);
        this._openFrameScope(device);
        try {
            this._prepareFrontier(records[0]?.id === 'terrain:static' ? records[0] : null, feed);
            const page = this._albedoPage;
            page?.beginFrame(this.frames);
            let batches = buildStableGpuBatches(records, this._batchScratch, this._normalizedRecordScratch, this._pageRecord);
            if (page?.repackIfOverflowed()) {
                batches = buildStableGpuBatches(records, this._batchScratch, this._normalizedRecordScratch, this._pageRecord);
                page.endRepackPass();
                this._batchBindGroups.clear();
                this._updateTextureBytes();
            }
            if (!batches.length) return false;
            this._sampledPass = !repeatOutput && this.passSamplingEnabled && this.frames % 12 === 0
                ? GPU_PASS_NAMES[this._passCursor++ % GPU_PASS_NAMES.length] : null;
            const passCpu = {};
            let mark = performance.now();
            const passUploadBytes = this.uploadBytes;
            // [upload] — V9 records (72-byte, whole frame), textures, particles.
            const byteLength = stageGpuRecords(batches, this._recordStaging, { fullTail: true });
            const u = globalThis.GPUBufferUsage;
            this._ensureBuffer('_recordBuffer', '_recordBufferBytes', byteLength, u.STORAGE | u.COPY_DST, 'world-records');
            this.vertexBufferBytes = this._recordBufferBytes;
            this._uploadBatchTextures(batches, occluderChannelEnabled);
            this._particleCount = particles?.packGpuInstances ? particles.packGpuInstances(this._particleViews) : 0;
            this.particleInstances = this._particleCount;
            if (this._particleCount > 0) {
                const motifs = particleMotifMask();
                this._particleMotifTexture = this.uploadTypedTexture('particle:motifs', {
                    width: motifs.width, height: motifs.height, format: 'r8', data: motifs.data, revision: motifs.revision,
                });
            }
            this._prepareRain(feed, camera, qualityLevel);
            let atlasRecords = 0;
            let individualRecords = 0;
            for (let index = 0; index < records.length; index++) {
                if (records[index]?.sourceKind === 'atlas') atlasRecords += 1;
                else individualRecords += 1;
            }
            this._sourceCensus = { atlasRecords, individualRecords, batchCount: batches.length, uploadBytes: this.uploadBytes };
            this._frameLoadPasses = 0;
            this._frameLoadArm = null;
            const load = this._debugLoad;
            if (load?.schedule) {
                const arm = load.schedule[load.cursor++ % load.schedule.length];
                this._frameLoadPasses = arm.passes;
                this._frameLoadArm = arm.id;
            } else if (load && (load.levels === 'all' || qualityLevel === POST_FX_LEVELS.FULL)) {
                this._frameLoadPasses = load.passes;
            }
            this._resolveFrame(feed, camera, qualityLevel, batches);
            const bloomOn = this._frameState.bloomStrength > 0;
            const display = this._display;
            const roles = display ? display.emissionFormat : null;
            const writeEmission = bloomOn || roles !== null;
            this._ensureTargets(writeEmission, bloomOn);
            const markBatches = this._stageMarks(marks, false);
            // Batch uniforms: scene batches then mark batches, one slot each.
            this._ensureBatchSlots(batches.length + markBatches.length);
            for (let index = 0; index < batches.length; index++) {
                const batch = batches[index];
                if (!batch.page && batch.albedoTexture) {
                    const entry = this._textureEntries.get(batch.textureKey);
                    batch.albedoSize = entry ? [entry.width, entry.height] : [1, 1];
                }
                this._writeBatchSlot(index, batch);
            }
            for (let index = 0; index < markBatches.length; index++) {
                this._writeBatchSlot(batches.length + index, markBatches[index], { mark: true });
            }
            const batchByteLength = (batches.length + markBatches.length) * BATCH_UNIFORM_STRIDE;
            const reuse = (this._frameReuse ||= new GpuFrameReuse()).begin();
            reuse.bytes(this._recordStaging.f32, byteLength);
            reuse.bytes(this._frameViews.buffer);
            reuse.bytes(this._batchViews.buffer, batchByteLength);
            reuse.bytes(this._particleBytes, this._particleCount * GPU_PARTICLE_INSTANCE_BYTES);
            // RN-1 — the rain field's uniforms and instance count.
            reuse.bytes(this._rain.uniforms, this.rainInstances > 0 ? RAIN_UNIFORM_BYTES : 0);
            reuse.scalar(this.rainInstances);
            reuse.scalar(this._rainMaskView);
            reuse.bytes(this._markStaging.f32, this._markByteLength);
            reuse.bytes(this._bloomParams.buffer);
            stageGpuFrameBindings(reuse, this, batches, markBatches);
            const fresh = this._frontierMask !== 0 || forceFreshOutput || timerWasPending || this.hasPendingGpuQueries()
                || this._readbackPending || this._debugLoad || this.passSamplingEnabled;
            if (!fresh && reuse.unchanged()) {
                this.skippedFrames = (this.skippedFrames || 0) + 1;
                this.lastFrameReused = true;
                return true;
            }
            device.queue.writeBuffer(this._recordBuffer, 0, this._recordStaging.f32.buffer, 0, byteLength);
            device.queue.writeBuffer(this._frameBuffer, 0, this._frameViews.buffer);
            device.queue.writeBuffer(this._batchBuffer, 0, this._batchViews.buffer, 0, batchByteLength);
            if (this._particleCount) device.queue.writeBuffer(this._particleBuffer, 0, this._particleBytes, 0, this._particleCount * GPU_PARTICLE_INSTANCE_BYTES);
            if (this.rainInstances) device.queue.writeBuffer(this._rainBuffer, 0, this._rain.uniforms);
            if (this._markByteLength) device.queue.writeBuffer(this._markRecordBuffer, 0, this._markStaging.f32.buffer, 0, this._markByteLength);
            passCpu.upload = { cpuMs: performance.now() - mark, draws: 0, bytes: byteLength + this.uploadBytes - passUploadBytes };
            // GPU timer: 1 frame in 4 (every frame while the pacing window
            // misses), or every K-slope arm frame.
            const timeThisFrame = !repeatOutput
                && (this._frameLoadArm !== null || this.frames % this._gpuTimerEvery === 0);
            const timer = this._timer;
            const slot = timer && timeThisFrame
                ? timer.begin({ arm: this._frameLoadArm, passes: this.passSamplingEnabled ? passCpu : null })
                : -1;
            const encoder = device.createCommandEncoder({ label: 'world-frame' });
            // 10.2 / 10.3 — on an HDR or P3 screen the emission attachment is
            // always written. Mixed emitter batches write the per-texel role
            // so a glazed pane or a sunlit roof stays an ordinary receiver.
            // [scene] — MRT colour + emission, painter depth, then particles.
            mark = performance.now();
            const target = this.sceneTarget;
            const mask = this._frontierMask;
            const surface = mask & 4 ? this._frontierPasses.get('surfaceDepth').pipelines : null;
            const motion = { reducedMotion: feed.reducedMotion, visibilityReturned: Boolean(this._frontierVisibilityReset) };
            const computeTime = timer && slot >= 0 && (mask & 10) ? timer.writes(slot, 'compute') : null;
            // A timed empty pass marks the first command even on a zero-step frame.
            if (computeTime) encoder.beginComputePass({ timestampWrites: computeTime }).end();
            const density = this._frontierPolicy?.frontierFlags.windRippleDensity === false ? 0.5 : 1;
            const wind = mask & 8 ? this._frontierPasses.get('wind').pass.encode(encoder, { ...motion,
                dtSeconds: density * frameGapMs / 1000, forcing: { weather: feed.weather || feed.atmosphere?.weather,
                    emitters: records.find(r => r.windEmitters)?.windEmitters || [], timeSec: feed.timeMs / 1000 },
                documentHidden: globalThis.document?.hidden }) : null;
            const ripple = mask & 2 ? this._encodeRipples(encoder, records, feed, motion, density * frameGapMs / 1000) : null;
            this._frontierVisibilityReset = false;
            const revision = ripple?.revision ?? wind?.revision ?? this._frontierRevision ?? 0;
            if (mask && revision !== this._frameState.frontier[2]) {
                this._frontierRevision = this._frameState.frontier[2] = revision;
                const offset = FRAME_UNIFORM_LAYOUT.byName.frontier.offset + 8;
                this._frameViews.u32[offset / 4] = revision;
                device.queue.writeBuffer(this._frameBuffer, offset, this._frameViews.buffer, offset, 4);
            }
            const sceneDescriptor = {
                label: 'world-scene',
                colorAttachments: [
                    { view: target.color.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
                    ...(writeEmission ? [
                        { view: target.emission.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
                    ] : []),
                ],
                depthStencilAttachment: { view: target.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: mask & 17 ? 'store' : 'discard' },
                timestampWrites: timer?.writes(slot, 'scene'),
            };
            let scene = encoder.beginRenderPass(sceneDescriptor);
            scene.setBindGroup(0, this._frameBindGroup);
            let bound = null;
            let boundRole = 0;
            let draws = 0;
            const bindingRecords = { albedoPage: 0, pilotAtlas: 0, agentAtlas: 0, cueAtlas: 0, other: 0 };
            for (let index = 0; index < batches.length; index++) {
                const batch = batches[index];
                if (!batch.albedoTexture) continue;
                const cue = Boolean(batch.cueRuns);
                const emitterRoles = roles && batch.emissiveTexture && batch.blend !== 'add' && !cue;
                const cleanBed = Boolean(mask & 1) && batch.records[0]?.id === 'terrain:static';
                const planarBatch = mask & 1 && (cleanBed || batch.records.some(r => r.flags & GPU_RECORD_FLAGS.reflect));
                const waterPass = planarBatch && this._frontierPasses.get('mirror').pass;
                const depthWriter = batch.writesDepth === true || Boolean(batch.records[0]?.terrainPlanes);
                const pipeline = surface ? surface.get([writeEmission, depthWriter, cue, batch.blend === 'add', Boolean(emitterRoles),
                    batch.writesDepth === true && Boolean(batch.records[0]?.flags & GPU_RECORD_FLAGS.surfacePage)].join())
                    : waterPass ? (writeEmission ? waterPass.bedPipeline : waterPass.bedColorPipeline)
                    : emitterRoles ? display.emitterRoles[Number(batch.writesDepth === true)]
                    : this.pipelines.scene(batch.blend === 'add', batch.writesDepth === true, writeEmission, cue, roles, writeEmission);
                if (pipeline !== bound) {
                    scene.setPipeline(pipeline);
                    bound = pipeline;
                }
                if (roles) {
                    const role = batch.emissiveTexture && !(batch.records[0]?.ownerSlot > 0) ? 1 : 0;
                    if (role !== boundRole) {
                        scene.setBlendConstant({ r: 0, g: 0, b: 0, a: role });
                        boundRole = role;
                    }
                }
                if (planarBatch) scene.setBindGroup(0, this._surfaceViewGroup(this._waterInputs.maskView));
                else if (surface) scene.setBindGroup(0, this._surfaceGroup(batch.records[0]));
                else if (mask & 1) scene.setBindGroup(0, this._frameBindGroup);
                scene.setBindGroup(1, this._batchBindGroup(this._recordBuffer, batch), [index * BATCH_UNIFORM_STRIDE]);
                scene.draw(cue ? CUE_RUN_VERTICES : 4, batch.count, 0, batch.instanceOffset / RECORD_INSTANCE_BYTES);
                draws++;
                if (cleanBed) {
                    scene.end();
                    this._encodeFrontierWater(encoder, records, target, writeEmission, feed);
                    scene = encoder.beginRenderPass({ label: 'world-over-water',
                        colorAttachments: sceneDescriptor.colorAttachments.map(a => ({ ...a, loadOp: 'load' })),
                        depthStencilAttachment: { ...sceneDescriptor.depthStencilAttachment, depthLoadOp: 'load', depthStoreOp: mask & 16 ? 'store' : 'discard' } });
                    scene.setBindGroup(0, this._frameBindGroup);
                    bound = null;
                    boundRole = 0;
                }
                if (batch.page) bindingRecords.albedoPage += batch.count;
                else if (batch.textureKey === 'agent-frame-atlas') bindingRecords.agentAtlas += batch.count;
                else if (batch.textureKey === 'world-pilot') bindingRecords.pilotAtlas += batch.count;
                else if (batch.textureKey === GROUND_CUE_TEXTURE_KEY) bindingRecords.cueAtlas += batch.count;
                else bindingRecords.other += batch.count;
            }
            this._sceneTextureBindings = { groupsBound: draws, records: bindingRecords };
            if (surface) scene.setBindGroup(0, this._frameBindGroup);
            if (this._particleCount > 0 && this._particleMotifTexture) {
                if (boundRole) scene.setBlendConstant({ r: 0, g: 0, b: 0, a: 0 });
                scene.setPipeline(surface ? surface.get('particle' + writeEmission) : this.pipelines.particles(writeEmission, roles, writeEmission));
                scene.setVertexBuffer(0, this._particleBuffer);
                scene.draw(4, this._particleCount, 0, 0);
            }
            if (wind && !feed.reducedMotion) {
                const entry = this._frontierPasses.get('wind');
                scene.setBindGroup(0, this._frameBindGroup);
                scene.setPipeline(entry.embers.get(target.depthFormat + writeEmission));
                scene.setVertexBuffer(0, wind.emberBuffer);
                scene.draw(4, entry.pass.emberCapacity);
            }
            // RN-1 — the world rain, after the particles, on the same depth.
            if (this.rainInstances > 0) {
                if (boundRole) scene.setBlendConstant({ r: 0, g: 0, b: 0, a: 0 });
                scene.setPipeline(surface ? surface.get('rain' + writeEmission) : this.pipelines.rain(writeEmission, roles, writeEmission));
                scene.setBindGroup(1, this._rainGroup());
                scene.draw(12, this.rainInstances, 0, 0);
            }
            scene.end();
            if (mask & 16) {
                const forge = records.find(r => r.shaftReceiver && r.id?.startsWith('building.forge'));
                this._frontierPasses.get('shafts').pass.encode(encoder, { ...this._frameState,
                    sceneState: { atmosphere: feed.atmosphere, hour: feed.atmosphere?.clock?.minuteOfDay / 60,
                        weather: feed.weather, forgeActive: forge?.daytimeEmitter, forgeEnabled: Boolean(forge),
                        archiveEnabled: records.some(r => r.shaftReceiver && r.id?.startsWith('building.archive')) },
                    reducedMotion: feed.reducedMotion, timeSec: feed.timeMs / 1000, windFieldView: wind?.fieldView,
                    depthView: target.depth.view, sceneDepthView: target.depth.view, colorView: target.color.view,
                    emissionView: writeEmission && target.emission.view, hasEmissionAttachment: writeEmission });
            }
            passCpu.scene = { cpuMs: performance.now() - mark, draws, bytes: this.width * this.height * 4 * (writeEmission ? 2 : 1) };
            // [bloom] — runs at half strength while HDR presents (NE P1.4).
            mark = performance.now();
            if (bloomOn) {
                const writes = timer?.writes(slot, 'bloom');
                const passes = [
                    [this.bloomA, this._bloomBindGroups[0], this.pipelines.bloom],
                    [this.bloomB, this._bloomBindGroups[1], this.pipelines.bloom],
                ];
                passes.forEach(([bloomTarget, group, pipeline], index) => {
                    const pass = encoder.beginRenderPass({
                        label: `world-bloom-${index}`,
                        colorAttachments: [{ view: bloomTarget.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
                        timestampWrites: writes && (index === 0 || index === passes.length - 1)
                            ? (index === 0
                                ? { querySet: writes.querySet, beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }
                                : { querySet: writes.querySet, endOfPassWriteIndex: writes.endOfPassWriteIndex })
                            : undefined,
                    });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, group);
                    pass.draw(3);
                    pass.end();
                });
            }
            passCpu.bloom = { cpuMs: performance.now() - mark, draws: bloomOn ? 2 : 0, bytes: bloomOn ? this.bloomA.width * this.bloomA.height * 8 : 0 };
            // [present] — composite (open sea, flash, bloom), debug load, T1 marks.
            mark = performance.now();
            const canvasTexture = this.context.getCurrentTexture();
            this._lastCanvasTexture = canvasTexture;
            const present = encoder.beginRenderPass({
                label: 'world-present',
                colorAttachments: [{ view: canvasTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
                timestampWrites: timer?.writes(slot, 'present'),
            });
            present.setPipeline(display ? display.composite : this.pipelines.composite);
            present.setBindGroup(0, this._frameBindGroup);
            present.setBindGroup(1, display ? this._compositeRolesBindGroup : this._compositeBindGroup);
            present.draw(3);
            if (this._frameLoadPasses > 0) {
                present.setPipeline(display ? display.debugLoad : this.pipelines.debugLoad);
                present.setBindGroup(0, this._debugLoadBindGroup);
                for (let index = 0; index < this._frameLoadPasses; index++) present.draw(3);
            }
            this.lateMarkRecords = 0;
            this.lateMarkRoleRecords = 0;
            this._drawMarkBatches(present, markBatches, batches.length, false);
            present.end();
            passCpu.present = { cpuMs: performance.now() - mark, draws: 1, bytes: this.width * this.height * 4 };
            timer?.resolve(encoder, slot);
            device.queue.submit([encoder.finish()]);
            reuse.commit();
            this._lastRenderInput = input;
            this._freshOutputThisTask = true;
            queueMicrotask(this._expireFreshOutput ||= () => { this._freshOutputThisTask = false; });
            timer?.collect(slot, result => this._onTimerResult(result));
            if (this._sampledPass && !(slot >= 0 && this.passSamplingEnabled)) {
                const sample = passCpu[this._sampledPass];
                if (sample) this._recordPass({ pass: this._sampledPass, ...sample, gpuMs: null });
            }
            this._trimTextureCache();
            this._pruneBindGroups();
            let renderedRecords = 0;
            for (let index = 0; index < batches.length; index++) renderedRecords += batches[index].records.length;
            this.records = renderedRecords;
            this.batches = batches.length;
            this.frames++;
            if (repeatOutput) return true;
            const totalMs = performance.now() - started;
            const shaderCpuMs = Math.max(0, totalMs - this._frameUploadMs);
            this.uploadMs = ema(this.uploadMs, this._frameUploadMs);
            this.shaderCpuMs = ema(this.shaderCpuMs, shaderCpuMs);
            this.cpuMs = ema(this.cpuMs, totalMs);
            this.frameGapMs = ema(this.frameGapMs, frameGapMs);
            const timingInput = this._qualityTimingInput;
            timingInput.uploadMs = this._frameUploadMs;
            timingInput.shaderCpuMs = shaderCpuMs;
            timingInput.gpuMs = this.gpuMsP25;
            timingInput.gpuTimerSupported = this.timerSupported;
            timingInput.frameGapMs = frameGapMs;
            const timing = selectGpuTimingMetrics(timingInput, this._qualityTimingScratch);
            timing.metrics.intervalMs = presentIntervalMs;
            this.qualityTimingSource = timing.source;
            const quality = this.qualityLadder.update(timing.metrics, started);
            this._gpuTimerEvery = quality.missShare >= GPU_TIMER_DENSE_MISS_SHARE ? 1 : GPU_TIMER_EVERY;
            return true;
        } catch (error) {
            this._fail('frame', error);
            return false;
        } finally {
            this._closeFrameScope(device);
        }
    }

    // The T1 mark pass body (contract §7.4): staged mark batches in draw
    // order onto the presented frame, batch uniforms from slot `slotBase`;
    // counts the records (and role-2 records) drawn into `markRecords` or,
    // for the late pass, `lateMarkRecords`.
    _drawMarkBatches(pass, markBatches, slotBase, late) {
        let drawn = 0;
        let role = 0;
        if (markBatches.length) {
            pass.setPipeline(this._display ? this._display.marks : this.pipelines.marks);
            pass.setBindGroup(0, this._frameBindGroup);
            for (let index = 0; index < markBatches.length; index++) {
                const batch = markBatches[index];
                if (!batch.albedoTexture) continue;
                pass.setBindGroup(1, this._batchBindGroup(this._markRecordBuffer, batch), [(slotBase + index) * BATCH_UNIFORM_STRIDE]);
                pass.draw(4, batch.count, 0, batch.instanceOffset / RECORD_INSTANCE_BYTES);
                drawn += batch.count;
                for (let recordIndex = 0; recordIndex < batch.count; recordIndex++) {
                    if (batch.records[recordIndex].flags & GPU_RECORD_FLAGS.actionMark) role++;
                }
            }
        }
        if (late) {
            this.lateMarkRecords = drawn;
            this.lateMarkRoleRecords = role;
        } else {
            this.markRecords = drawn;
            this.markRoleRecords = role;
        }
    }

    /**
     * 10.2 — marks the overlay hands over after this frame rendered (the C4
     * verified-success cream peak frame, then the frame's T1 marks again so
     * they stay above it, as the overlay stacks them): the mark pass once
     * more onto the same presented canvas texture, in its own submit. Call it
     * in the same task as a `render` that returned true. Returns the records
     * drawn (`lateMarkRecords`); the caller repaints on the overlay when that
     * falls short of `marks.length`.
     */
    drawLateMarks(marks) {
        this.lateMarkRecords = 0;
        this.lateMarkRoleRecords = 0;
        if (!this._freshOutputThisTask || !this.isActive() || !marks?.length || !this._lastCanvasTexture) return 0;
        const device = this.device;
        this._openFrameScope(device);
        try {
            const markBatches = this._stageMarks(marks);
            this._ensureBatchSlots(markBatches.length);
            for (let index = 0; index < markBatches.length; index++) this._writeBatchSlot(index, markBatches[index], { mark: true });
            device.queue.writeBuffer(this._batchBuffer, 0, this._batchViews.buffer, 0, markBatches.length * BATCH_UNIFORM_STRIDE);
            const encoder = device.createCommandEncoder({ label: 'world-late-marks' });
            const pass = encoder.beginRenderPass({
                label: 'world-late-marks',
                colorAttachments: [{ view: this._lastCanvasTexture.createView(), loadOp: 'load', storeOp: 'store' }],
            });
            this._drawMarkBatches(pass, markBatches, 0, true);
            pass.end();
            device.queue.submit([encoder.finish()]);
            this._frameReuse?.invalidate();
            return this.lateMarkRecords;
        } catch (error) {
            if (!this._renderErrorLogged) {
                this._renderErrorLogged = true;
                console.warn('[GpuWorldRendererWebGPU] late mark pass failed; the overlay draws them:', error);
            }
            this.lateMarkRecords = 0;
            this.lateMarkRoleRecords = 0;
            return 0;
        } finally {
            this._closeFrameScope(device);
        }
    }

    /**
     * 0.3 — the frame this task presented, as a surface a 2D canvas can
     * draw (the reveal bands' readback). The SDR canvas is itself; the HDR
     * canvas (rgba16float) is not: Chrome cannot copy it into its BGRA8
     * raster image (the copy raises a validation error on our device), so
     * its nearest texels are drawn clamped into a `width` x `height` canvas
     * of the preferred format and the canvas's colour space. Call it in the
     * same task as a `render` that returned true; null when it cannot read.
     */
    readoutSurface(width, height) {
        if (!this.ensureFreshOutput()) return null;
        const display = this._display;
        if (!display?.hdr) return this.canvas;
        const texture = this._lastCanvasTexture;
        if (!this.isActive() || !texture || !display.readout || !globalThis.document) return null;
        const device = this.device;
        device.pushErrorScope('validation');
        try {
            let readout = this._readout;
            if (!readout) {
                const canvas = globalThis.document.createElement('canvas');
                readout = this._readout = { canvas, context: canvas.getContext('webgpu'), colorSpace: null };
            }
            if (readout.canvas.width !== width) readout.canvas.width = width;
            if (readout.canvas.height !== height) readout.canvas.height = height;
            if (readout.colorSpace !== this.canvasColorSpace) {
                readout.context.configure({
                    device, format: this.canvasFormat, colorSpace: this.canvasColorSpace,
                    alphaMode: 'premultiplied',
                    usage: globalThis.GPUTextureUsage.RENDER_ATTACHMENT | globalThis.GPUTextureUsage.COPY_SRC,
                });
                readout.colorSpace = this.canvasColorSpace;
            }
            const encoder = device.createCommandEncoder({ label: 'world-hdr-readout' });
            readout.texture = readout.context.getCurrentTexture();
            const pass = encoder.beginRenderPass({
                label: 'world-hdr-readout',
                colorAttachments: [{ view: readout.texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(display.readout);
            pass.setBindGroup(0, device.createBindGroup({
                layout: display.readout.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: texture.createView() }],
            }));
            pass.draw(3);
            pass.end();
            device.queue.submit([encoder.finish()]);
            return readout.canvas;
        } catch (error) {
            console.warn('[GpuWorldRendererWebGPU] HDR readout failed:', error);
            return null;
        } finally {
            device.popErrorScope().then((error) => {
                if (error) console.warn('[GpuWorldRendererWebGPU] HDR readout failed:', error);
            }, () => {});
        }
    }

    /**
     * Fence this task's presented surface, including the HDR clamped readout.
     * The caller snapshots it through Canvas in this task and reads the tiny
     * composite only after completion, preserving browser alpha/P3 conversion
     * without any staging buffer or a full-resolution GPU copy.
     */
    snapshotReadoutSurface(width, height) {
        if (!this.ensureFreshOutput() || !this.isActive() || !this._lastCanvasTexture) return null;
        const surface = this.readoutSurface(width, height);
        if (!surface) return null;
        const device = this.device;
        try {
            const ready = device.queue.onSubmittedWorkDone().then(() => true, () => false);
            return { surface, ready, deviceLost: device.lost };
        } catch {
            return null;
        }
    }

    /**
     * §4.3 — resolves when the GPU has finished every submitted frame (capped
     * at DRAIN_TIMEOUT_MS); gpu-burst's stand-in for WebGL's 1-px readPixels.
     */
    drain() {
        if (!this.device) return Promise.resolve(false);
        return Promise.race([
            this.device.queue.onSubmittedWorkDone().then(() => true, () => false),
            new Promise(resolve => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
        ]);
    }

    /**
     * §5.1 — the parity harness's readback of the frame just rendered (call it
     * in the same task as `render`, while the canvas texture is current):
     * tight RGBA, top-left row order. `composite` is the presented canvas
     * texture (BGRA swizzled to RGBA), `scene`/`emission` the scene targets.
     * 8-bit targets come back as Uint8Array; an rgba16float target (10.2:
     * the HDR canvas and emission attachment) as Float32Array of its values.
     * `formats` names each target's format.
     */
    async debugCaptureTargets({ includeAttribution = false } = {}) {
        if (!this.ensureFreshOutput()) {
            return { scene: null, composite: null, emission: null, attribution: null, attributionFormat: null, formats: {}, width: this.width, height: this.height, rowOrder: 'top-left', channelOrder: 'rgba' };
        }
        this._readbackPending = (this._readbackPending || 0) + 1;
        try {
            return await this._captureTargets(includeAttribution);
        } finally {
            this._readbackPending--;
        }
    }

    _captureAttribution(encoder) {
        const device = this.device;
        if (!this._attributionPipelines) {
            const module = device.createShaderModule({
                label: 'world-attribution', code: assembleScene().replace(SCENE_WGSL, () => sceneWgsl(true)),
            });
            const layout = device.createPipelineLayout({ bindGroupLayouts: [this.pipelines.layouts.frame, this.pipelines.layouts.batch] });
            const vertex = { module, entryPoint: 'captureVs', buffers: [{ arrayStride: 4, stepMode: 'instance',
                attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }] }] };
            this._attributionPipelines = ['scene', 'cue', 'mark'].map(kind => device.createRenderPipeline({
                label: 'world-attribution-' + kind, layout, vertex,
                fragment: { module, entryPoint: kind === 'mark' ? 'captureMarkFs' : 'captureFs', targets: [{ format: 'r32uint' }] },
                primitive: { topology: kind === 'cue' ? 'triangle-list' : 'triangle-strip' },
            }));
        }
        const { records, marks } = this._lastRenderInput;
        const scene = this._batchScratch;
        this._uploadBatchTextures(scene, !this._occluderChannelSkipped);
        const overlays = this._stageMarks(marks);
        const sceneWords = captureRecordWords(records, this._normalizedRecordScratch, scene);
        const markWords = captureRecordWords(marks || [], this._markNormalized, overlays, records.length, true);
        const buffer = device.createBuffer({ size: (sceneWords.length + markWords.length) * 4,
            usage: GPUBufferUsage.VERTEX, mappedAtCreation: true, label: 'world-capture-words' });
        const words = new Uint32Array(buffer.getMappedRange());
        words.set(sceneWords);
        words.set(markWords, sceneWords.length);
        buffer.unmap();
        const batches = [...scene, ...overlays];
        this._ensureBatchSlots(batches.length);
        for (const [i, batch] of batches.entries()) this._writeBatchSlot(i, batch, { mark: i >= scene.length });
        device.queue.writeBuffer(this._batchBuffer, 0, this._batchViews.buffer, 0, batches.length * BATCH_UNIFORM_STRIDE);
        const target = this._createTarget(this.width, this.height, 'r32uint', { label: 'world-attribution' });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
        pass.setBindGroup(0, this._frameBindGroup);
        for (const [i, batch] of batches.entries()) {
            if (!batch.albedoTexture) continue;
            const mark = i >= scene.length;
            pass.setPipeline(this._attributionPipelines[mark ? 2 : batch.cueRuns ? 1 : 0]);
            pass.setVertexBuffer(0, buffer, mark ? sceneWords.byteLength : 0);
            pass.setBindGroup(1, this._batchBindGroup(mark ? this._markRecordBuffer : this._recordBuffer, batch), [i * BATCH_UNIFORM_STRIDE]);
            pass.draw(batch.cueRuns ? CUE_RUN_VERTICES : 4, batch.count, 0, batch.instanceOffset / RECORD_INSTANCE_BYTES);
        }
        pass.end();
        return { texture: target.texture, buffer };
    }

    async _captureTargets(includeAttribution) {
        const out = { scene: null, composite: null, emission: null, attribution: null, attributionFormat: null, formats: {}, width: this.width, height: this.height, rowOrder: 'top-left', channelOrder: 'rgba' };
        if (!this.isActive() || !this.sceneTarget) return out;
        const device = this.device;
        const width = this.width;
        const height = this.height;
        const u = globalThis.GPUBufferUsage;
        // [name, texture, format, stored in GL row order (the scene targets,
        // wgsl/scene.js) and so read bottom-up]
        const sources = [
            ['scene', this.sceneTarget.color.texture, SCENE_COLOR_FORMAT, true],
            ['emission', this.sceneTarget.emission?.texture, this.sceneTarget.emissionFormat, true],
            ['composite', this._lastCanvasTexture, this.presentFormat, false],
        ].filter(([, texture]) => texture);
        device.pushErrorScope('validation');
        const encoder = device.createCommandEncoder({ label: 'world-capture' });
        let attribution;
        try {
            attribution = includeAttribution ? this._captureAttribution(encoder) : null;
        } catch (error) {
            await device.popErrorScope();
            throw error;
        }
        if (attribution) sources.push(['attribution', attribution.texture, 'r32uint', true]);
        const reads = sources.map(([name, texture, format, glRows]) => {
            const texelBytes = format === 'rgba16float' ? 8 : 4;
            const pitch = Math.ceil(width * texelBytes / 256) * 256;
            const buffer = device.createBuffer({ size: pitch * height, usage: u.MAP_READ | u.COPY_DST });
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch, rowsPerImage: height }, [width, height]);
            return { name, buffer, format, texelBytes, pitch, glRows };
        });
        device.queue.submit([encoder.finish()]);
        attribution?.texture.destroy();
        attribution?.buffer.destroy();
        if (attribution) this._trimTextureCache(this.frames);
        const error = await device.popErrorScope();
        for (const read of reads) {
            try {
                if (error) throw error;
                await read.buffer.mapAsync(globalThis.GPUMapMode.READ);
                const mapped = new Uint8Array(read.buffer.getMappedRange());
                const rowBytes = width * read.texelBytes;
                const tight = new Uint8Array(width * height * read.texelBytes);
                for (let y = 0; y < height; y++) {
                    const row = read.glRows ? height - 1 - y : y;
                    tight.set(mapped.subarray(row * read.pitch, row * read.pitch + rowBytes), y * rowBytes);
                }
                if (read.format === 'r32uint') {
                    out.attribution = new Uint32Array(tight.buffer);
                    out.attributionFormat = read.format;
                } else if (read.format === 'rgba16float') {
                    out[read.name] = halfFloatsToFloat32(new Uint16Array(tight.buffer));
                } else {
                    if (read.format === 'bgra8unorm') {
                        for (let index = 0; index < tight.length; index += 4) {
                            const b = tight[index];
                            tight[index] = tight[index + 2];
                            tight[index + 2] = b;
                        }
                    }
                    out[read.name] = tight;
                }
                out.formats[read.name] = read.format;
                read.buffer.unmap();
            } catch {
                out[read.name] = null;
            }
            read.buffer.destroy();
        }
        if (includeAttribution && !out.attribution) {
            throw new Error('Attribution capture failed: ' + (error?.message || 'unable to map the r32uint target'));
        }
        return out;
    }

    setDebugLoad(config = null) {
        const spec = typeof config === 'number' ? { passes: config } : config;
        const schedule = Array.isArray(spec?.schedule) && spec.schedule.length
            ? spec.schedule.map((arm, index) => ({ id: String(arm?.id ?? index), passes: Math.max(0, Math.floor(finite(arm?.passes))) }))
            : null;
        const passes = Math.max(0, Math.floor(finite(spec?.passes)));
        if (!schedule && passes === 0) {
            this._debugLoad = null;
            return null;
        }
        this._debugLoad = {
            passes,
            levels: spec.levels === 'all' ? 'all' : 'full',
            schedule,
            cursor: 0,
            samples: schedule ? Object.fromEntries(schedule.map(arm => [arm.id, []])) : null,
        };
        return { passes, levels: this._debugLoad.levels, schedule };
    }

    takeDebugLoadSamples() {
        const samples = this._debugLoad?.samples;
        if (!samples) return null;
        const taken = {};
        for (const [id, values] of Object.entries(samples)) {
            taken[id] = values.slice();
            values.length = 0;
        }
        return taken;
    }

    frameHealth() {
        return {
            active: this.isActive(),
            contextHealthy: this.contextHealthy,
            deviceLost: this.deviceLost,
            frames: this.frames,
        };
    }

    getDiagnostics() {
        const renderer = this;
        const quality = this.qualityLadder.getState();
        return {
            frontier: this._frontierDiagnostics(),
            backend: 'webgpu',
            adapter: this.adapterInfo,
            recordStride: this.pipelines?.recordStride ?? null,
            deviceLost: this.deviceLost,
            failure: this.failure,
            deviceRebuilds: this.deviceRebuilds,
            deviceRebuildError: this.deviceRebuildError,
            initError: this.initError,
            radianceBounce: false,
            timestamps: {
                supported: this.timerSupported,
                pending: this._timer?.pending ?? 0,
                errors: this._timer?.errors ?? 0,
                dropped: this._timer?.dropped ?? 0,
                samples: this._gpuTimerRing?.count ?? 0,
                gpuMs: this.gpuMs,
                gpuMsP25: this.gpuMsP25,
            },
            supported: this.supported,
            active: this.isActive(),
            contextHealthy: this.contextHealthy,
            suspended: this.suspended,
            width: this.width,
            height: this.height,
            frames: this.frames,
            skippedFrames: this.skippedFrames || 0,
            records: this.records,
            batches: this.batches,
            markRecords: this.markRecords,
            markRoleRecords: this.markRoleRecords,
            lateMarkRecords: this.lateMarkRecords,
            lateMarkRoleRecords: this.lateMarkRoleRecords,
            // 10.2 / 10.3 — the display path (Shift-D's display row).
            hdrEnabled: Boolean(this._display?.hdr),
            hdrMode: this.hdrMode,
            hdrReason: this._displayWant.reason,
            hdrGains: this._display?.hdr ? this._displayWant.gains : null,
            dynamicRangeHigh: this.dynamicRangeHigh,
            colorGamutP3: this.colorGamutP3,
            p3Enabled: Boolean(this._display?.p3),
            canvasFormat: this.presentFormat,
            canvasColorSpace: this.canvasColorSpace,
            canvasToneMapping: this.canvasToneMapping,
            emissionFormat: this.sceneTarget?.emissionFormat || SCENE_EMISSION_FORMAT,
            displayError: this.displayError,
            uncapturedErrors: this.uncapturedErrors,
            lastUncapturedError: this.lastUncapturedError,
            lights: this.lightCount,
            localLightPhase: this.localLightPhase,
            exposureBucket: this.sourceEnergy?.bucket ?? 'unreviewed',
            wetReflections: this.wetReflectionCount,
            gradeKey: this._frameGradeForComposite?.key ?? null,
            gradeExposure: this._frameGradeForComposite?.exposure ?? null,
            cloudCourses: this.cloudCourses,
            aerialHaze: this.aerialHaze,
            uploads: this.uploads,
            uploadBytes: this.uploadBytes,
            uploadBytesByKind: { ...this._uploadByteKinds },
            sceneTextureBindings: this._sceneTextureBindings,
            skippedOccluderUploads: this.skippedOccluderUploads,
            uploadMs: this.uploadMs ?? 0,
            cpuMs: this.cpuMs ?? 0,
            shaderCpuMs: this.shaderCpuMs ?? 0,
            gpuMs: this.gpuMs,
            gpuMsP25: this.gpuMsP25,
            gpuTimerSamples: this._gpuTimerRing?.count ?? 0,
            gpuTimerEvery: this._gpuTimerEvery,
            gpuTimerSupported: this.timerSupported,
            gpuTimerExtension: this.timerSupported ? 'timestamp-query' : null,
            gpuTimerPendingQueries: this._timer?.pending ?? 0,
            gpuTimerErrors: this.gpuTimerErrors + (this._timer?.errors ?? 0),
            gpuDisjointDiscards: this.gpuDisjointDiscards,
            passSamplingEnabled: this.passSamplingEnabled,
            passes: Object.fromEntries(GPU_PASS_NAMES.map(name => {
                const ring = this._passResults[name];
                return [name, {
                    gpuMs: ring.gpuCount ? ring.gpuSum / ring.gpuCount : null,
                    cpuMs: ring.count ? ring.cpuSum / ring.count : null,
                    draws: ring.latest?.draws ?? null,
                    bytes: ring.latest?.bytes ?? null,
                    samples: ring.count,
                }];
            })),
            qualityTimingSource: this.qualityTimingSource,
            frameGapMs: this.frameGapMs ?? 0,
            textureBytes: this.textureBytes,
            residentTextureBytes: this.textureBytes,
            cachedTextureBytes: this._cachedTextureBytes,
            cachedTextureCapBytes: MAX_CACHED_TEXTURE_BYTES,
            cachedTextureCapExceeded: this._cachedTextureBytes > MAX_CACHED_TEXTURE_BYTES,
            cachedTextures: this._textureEntries.size,
            albedoPage: this._albedoPage?.getDiagnostics() || null,
            radiance: { supported: false, override: this.radianceOverride, reason: 'not ported to WebGPU (Stage A declared exclusion)' },
            textureEvictions: this.textureEvictions,
            maxCachedTextureBytes: MAX_CACHED_TEXTURE_BYTES,
            maxCachedTextures: MAX_CACHED_TEXTURES,
            materialAttachments: this.sceneTarget ? (this.sceneTarget.emission ? 2 : 1) : 0,
            particleInstances: this.particleInstances,
            footprintMarchSteps: this.footprintMarchSteps,
            bloomScale: BLOOM_SCALE,
            qualityLevel: quality.effectiveLevel,
            qualityReason: quality.lastDecisionReason,
            shedEffects: shedEffectsForLevel(quality.effectiveLevel),
            shedReason: quality.lastDecisionReason,
            qualityDegradationReason: quality.lastDegradationReason,
            qualityTransitionReason: quality.lastTransitionReason,
            qualityTransitionAtMs: quality.lastTransitionAtMs,
            qualityTransitionMetrics: quality.lastTransitionMetrics,
            qualityTransitions: quality.transitions,
            pacing: {
                refreshHz: quality.refreshHz,
                periodMs: quality.periodMs,
                budgetMs: quality.budgetMs,
                timerVeto: quality.timerVeto,
                missShare: quality.missShare,
                intervals: Math.min(quality.pacingCount, quality.options.pacingWindow),
                window: quality.options.pacingWindow,
                pending: quality.pending ? `${quality.pending.kind} from ${quality.pending.fromLevel}` : null,
                pacedLevel: quality.pacedLevel,
                coolDownUntilMs: quality.holdUntilMs,
                nextProbeAtMs: quality.nextProbeAtMs,
                sampledAtMs: quality.lastSampleAtMs,
            },
            lightAdmission: { ...this.lightAdmission },
            debugLoad: this._debugLoad
                ? { passes: this._debugLoad.passes, levels: this._debugLoad.levels, arms: this._debugLoad.schedule?.length ?? 0 }
                : null,
            get resources() { return renderer.getResourceAccounting(); },
            atlasRecords: this._sourceCensus?.atlasRecords || 0,
            individualRecords: this._sourceCensus?.individualRecords || 0,
            sourceBatchCount: this._sourceCensus?.batchCount || this.batches,
            sourceUploadBytes: this._sourceCensus?.uploadBytes || this.uploadBytes,
        };
    }

    getResourceAccounting() {
        if (this.suspended || !this.contextHealthy) return { textures: {}, attachments: {}, buffers: {} };
        let pinnedSourceBytes = 0;
        let evictableSourceBytes = 0;
        const atlasPages = [];
        for (const [name, entry] of this._textureEntries) {
            const bytes = entry.bytes || 0;
            const pinned = name.startsWith('frontier:') || entry.lastUsedFrame >= this.frames && !evictableAgentTexture(name);
            if (pinned) pinnedSourceBytes += bytes;
            else evictableSourceBytes += bytes;
            if (name.includes('world-pilot') || name.includes('agent-frame-atlas')) {
                atlasPages.push({ name, width: entry.width, height: entry.height, bytes, pinned });
            }
        }
        const targetBytes = (target, format) => target ? target.width * target.height * texelBytes(format) : 0;
        const colorBytes = targetBytes(this.sceneTarget, SCENE_COLOR_FORMAT);
        const emissionBytes = this.sceneTarget?.emission ? targetBytes(this.sceneTarget, this.sceneTarget.emissionFormat) : 0;
        const bloomABytes = targetBytes(this.bloomA, BLOOM_FORMAT);
        const bloomBBytes = targetBytes(this.bloomB, BLOOM_FORMAT);
        // The configured canvas (rgba16float while HDR presents).
        const presentationBytes = this.sceneTarget ? this.width * this.height * texelBytes(this.presentFormat) : 0;
        const depthBytes = this.sceneTarget ? this.width * this.height * (this.sceneTarget.depthFormat === 'depth32float' ? 4 : SCENE_DEPTH_BYTES_PER_PIXEL) : 0;
        const attachmentBytes = colorBytes + emissionBytes + depthBytes + bloomABytes + bloomBBytes + presentationBytes;
        const particleBytes = this._particleBuffer ? this._particleBytes.byteLength : 0;
        const lightBytes = this._lightRecordBuffer ? LIGHT_RECORD_BUFFER_BYTES : 0;
        const bufferBytes = (this._recordBufferBytes || 0) + (this._markRecordBufferBytes || 0) + particleBytes + lightBytes;
        const pageBytes = this._albedoPage?.bytes || 0;
        const frontierBytes = this._frontierDiagnostics().passOwnedBytes;
        const pinnedBytes = frontierBytes + pinnedSourceBytes + pageBytes + attachmentBytes + bufferBytes;
        return {
            frontierBytes,
            textures: { pinnedSources: pinnedSourceBytes, evictableSources: evictableSourceBytes, albedoPage: pageBytes, radiance: 0 },
            pinnedBytes,
            evictableBytes: evictableSourceBytes,
            totalBytes: pinnedBytes + evictableSourceBytes,
            atlasPages,
            liveBodyAtlas: atlasPages.find(page => page.name === 'agent-frame-atlas') || null,
            cachedSourceOverageBytes: Math.max(0, pinnedSourceBytes + evictableSourceBytes - MAX_CACHED_TEXTURE_BYTES),
            attachments: {
                presentation: presentationBytes,
                sceneColor: colorBytes,
                sceneEmission: emissionBytes,
                sceneDepth: depthBytes,
                bloomA: bloomABytes,
                bloomB: bloomBBytes,
            },
            buffers: { vertices: this._recordBufferBytes || 0, marks: this._markRecordBufferBytes || 0, particles: particleBytes, lights: lightBytes },
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        globalThis.document?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
        this.setDebugLoad(null);
        this._releaseGpuResources();
        this.contextHealthy = false;
        this.textureBytes = 0;
        try {
            this.context?.unconfigure?.();
        } catch {
            // Already unconfigured by a lost device.
        }
        this.device?.destroy?.();
    }
}

/**
 * §4.4 — the WebGPU resident world for `canvas`, or null when it cannot run.
 * With `device` + `pipelines` (IsometricRenderer.resolveBackend's prepared
 * set) it is active at once; otherwise it builds them and `renderer.ready`
 * resolves true once active.
 */
export function createGpuWorldRendererWebGPU({ canvas, enabled = true, device = null, adapter = null, pipelines = null, frontierEnabled } = {}) {
    if (!canvas?.getContext) return null;
    const renderer = new GpuWorldRendererWebGPU(canvas, { enabled, device, adapter, pipelines, frontierEnabled });
    return renderer.supported ? renderer : null;
}

/**
 * §4.1 — everything the synchronous `show()` needs, resolved before any canvas
 * context is taken: a hardware adapter, its device and the compiled pipelines
 * (a WGSL or validation failure lands here, so the caller keeps WebGL2).
 * Returns `{ available, device, adapter, pipelines, info, reason, isFallbackAdapter }`.
 */
export async function prepareGpuWorldWebGPU() {
    const probe = await probeWebGpu();
    if (!probe.available) return { ...probe, pipelines: null };
    try {
        const format = globalThis.navigator.gpu.getPreferredCanvasFormat();
        const pipelines = await prepareWorldPipelines(probe.device, format);
        return { ...probe, pipelines, recordStride: pipelines.recordStride };
    } catch (error) {
        probe.device.destroy();
        return { ...probe, available: false, device: null, pipelines: null, reason: `pipelines: ${error?.message || error}` };
    }
}
