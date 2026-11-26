// Wave 10 (contract §2 / §3.1 / §3.2) — bind group layouts, shader modules and
// render pipelines of the WebGPU world. `prepareWorldPipelines` compiles every
// module and the base pipelines asynchronously and throws on any compilation
// or validation error, so a backend that cannot build its shaders is known
// before a canvas context is taken (the caller then keeps WebGL2). Every
// reachable scene and particle variant, with or without an emission attachment,
// is prewarmed asynchronously before its display path can render.
import { LIGHT_RECORD_ROWS, MAX_LIGHT_RECORDS } from '../GpuWorldPolicy.js';
import { assertRecordStride, RECORD_INSTANCE_BYTES, RECORD_OFFSETS } from '../GpuRecordLayout.js';
import {
    BATCH_BINDING,
    BATCH_UNIFORM_LAYOUT,
    COMPOSITE_BINDING,
    FRAME_BINDING,
    FRAME_UNIFORM_LAYOUT,
    RECORD_STRUCT_WGSL,
} from '../wgsl/common.js';
import {
    BLOOM_BINDING,
    BLOOM_WGSL,
    DEBUG_LOAD_BINDING,
    DEBUG_LOAD_WGSL,
    PARTICLE_VERTEX_LAYOUT,
    assembleComposite,
    assembleParticle,
    assembleScene,
} from '../wgsl/index.js';
import { COMPOSITE_ROLES_BINDING, HDR_READOUT_WGSL } from '../wgsl/composite.js';
import { PLANAR_WATER_RESOLVE_WGSL } from './PlanarWaterPass.js';
import { SCENE_WGSL, sceneWgsl, SURFACE_DEPTH_WGSL } from '../wgsl/scene.js';
import { assembleRain, RAIN_BINDING, RAIN_UNIFORM_BYTES } from '../wgsl/rain.js';

export const SCENE_COLOR_FORMAT = 'rgba8unorm';
// Stage A keeps the emission target 8-bit (contract P14): the parity gate
// compares the shipped picture. 10.2 moves it to rgba16float only while HDR
// is presenting (SCENE_EMISSION_HDR_FORMAT); an SDR screen never sees it.
export const SCENE_EMISSION_FORMAT = 'rgba8unorm';
export const SCENE_EMISSION_HDR_FORMAT = 'rgba16float';
export const HDR_CANVAS_FORMAT = 'rgba16float';
export const SCENE_DEPTH_FORMAT = 'depth16unorm';
export const BLOOM_FORMAT = 'rgba8unorm';
// The light-record storage buffer (wgsl/common.js `lightData`): the WebGL2
// record texture's MAX_LIGHT_RECORDS x LIGHT_RECORD_ROWS RGBA32F texels.
export const LIGHT_RECORD_BUFFER_BYTES = MAX_LIGHT_RECORDS * LIGHT_RECORD_ROWS * 16;

// §3.2 — premultiplied source-over and the additive batch blend, applied to
// both MRT targets like WebGL2's single blendFunc.
export const BLEND_NORMAL = Object.freeze({
    color: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
    alpha: Object.freeze({ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
});
export const BLEND_ADD = Object.freeze({
    color: Object.freeze({ srcFactor: 'one', dstFactor: 'one', operation: 'add' }),
    alpha: Object.freeze({ srcFactor: 'one', dstFactor: 'one', operation: 'add' }),
});
// 10.2 / 10.3 (§7.1) — the emission target while roles are staged (an HDR or
// P3 screen): colour exactly as above (bloom reads the same emission), but
// alpha is the batch's role, the pass's blend constant (setBlendConstant a =
// 1 for a building/prop emitter batch, 0 otherwise): a covering fragment
// writes its role, an uncovered texel keeps the role beneath, and additive
// batches never change it.
export const BLEND_NORMAL_ROLE = Object.freeze({
    color: BLEND_NORMAL.color,
    alpha: Object.freeze({ srcFactor: 'constant', dstFactor: 'one-minus-src-alpha', operation: 'add' }),
});
export const BLEND_ADD_ROLE = Object.freeze({
    color: BLEND_ADD.color,
    alpha: Object.freeze({ srcFactor: 'zero', dstFactor: 'one', operation: 'add' }),
});

function stages() {
    return globalThis.GPUShaderStage.VERTEX | globalThis.GPUShaderStage.FRAGMENT;
}

function texture(binding, sampleType = 'float', viewDimension = '2d') {
    return { binding, visibility: stages(), texture: { sampleType, viewDimension } };
}

function sampler(binding) {
    return { binding, visibility: stages(), sampler: { type: 'filtering' } };
}

export function createWorldLayouts(device) {
    const F = FRAME_BINDING;
    const B = BATCH_BINDING;
    const frame = device.createBindGroupLayout({
        label: 'world-frame',
        entries: [
            { binding: F.frame, visibility: stages(), buffer: { type: 'uniform', minBindingSize: FRAME_UNIFORM_LAYOUT.size } },
            texture(F.cloudTile), sampler(F.cloudSampler),
            texture(F.seaGust), sampler(F.seaGustSampler),
            { binding: F.lightData, visibility: stages(), buffer: { type: 'read-only-storage', minBindingSize: LIGHT_RECORD_BUFFER_BYTES } },
            texture(F.lightTiles, 'uint'),
            texture(F.footprint), texture(F.cycleOffset), texture(F.coastField), texture(F.puddleMask),
            texture(F.paletteLut), sampler(F.nearestSampler),
            texture(F.radianceTex), sampler(F.radianceSampler),
            texture(F.motifs), sampler(F.linearSampler),
            texture(F.shadeField),
        ],
    });
    const batch = device.createBindGroupLayout({
        label: 'world-batch',
        entries: [
            {
                binding: B.batch,
                visibility: stages(),
                buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BATCH_UNIFORM_LAYOUT.size },
            },
            { binding: B.recs, visibility: stages(), buffer: { type: 'read-only-storage' } },
            texture(B.albedo), texture(B.albedoPage, 'float', '2d-array'),
            texture(B.materialMap), texture(B.emissiveMap), texture(B.occluderMap),
            sampler(B.albedoSampler),
        ],
    });
    const composite = device.createBindGroupLayout({
        label: 'world-composite',
        entries: [texture(COMPOSITE_BINDING.sceneColor), texture(COMPOSITE_BINDING.bloomColor)],
    });
    // 10.2 / 10.3 — the roles composite also reads the emission attachment
    // (float for rgba16float; unfilterable is never needed: textureLoad).
    const compositeRoles = device.createBindGroupLayout({
        label: 'world-composite-roles',
        entries: [texture(COMPOSITE_BINDING.sceneColor), texture(COMPOSITE_BINDING.bloomColor), texture(COMPOSITE_ROLES_BINDING.sceneEmission)],
    });
    const bloom = device.createBindGroupLayout({
        label: 'world-bloom',
        entries: [
            texture(BLOOM_BINDING.input), sampler(BLOOM_BINDING.sampler),
            { binding: BLOOM_BINDING.params, visibility: stages(), buffer: { type: 'uniform', minBindingSize: 16 } },
        ],
    });
    const debugLoad = device.createBindGroupLayout({
        label: 'world-debug-load',
        entries: [texture(DEBUG_LOAD_BINDING.scene), sampler(DEBUG_LOAD_BINDING.sampler)],
    });
    // RN-1 — the world rain's own uniforms and open-ground splash mask.
    const rain = device.createBindGroupLayout({
        label: 'world-rain',
        entries: [
            { binding: RAIN_BINDING.rain, visibility: stages(), buffer: { type: 'uniform', minBindingSize: RAIN_UNIFORM_BYTES } },
            texture(RAIN_BINDING.mask),
        ],
    });
    const pipelineLayout = (label, groups) => device.createPipelineLayout({ label, bindGroupLayouts: groups });
    return {
        rain,
        rainPipeline: pipelineLayout('world-rain', [frame, rain]),
        frame,
        batch,
        composite,
        compositeRoles,
        bloom,
        debugLoad,
        scenePipeline: pipelineLayout('world-scene', [frame, batch]),
        particlePipeline: pipelineLayout('world-particle', [frame]),
        compositePipeline: pipelineLayout('world-composite', [frame, composite]),
        compositeRolesPipeline: pipelineLayout('world-composite-roles', [frame, compositeRoles]),
        bloomPipeline: pipelineLayout('world-bloom', [bloom]),
        debugLoadPipeline: pipelineLayout('world-debug-load', [debugLoad]),
    };
}

async function compileModule(device, code, label) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo?.();
    const errors = (info?.messages || []).filter(message => message.type === 'error');
    if (errors.length) {
        const lines = code.split('\n');
        const detail = errors.slice(0, 8).map(message => (
            `${label}:${message.lineNum}:${message.linePos} ${message.message}\n    ${lines[message.lineNum - 1]?.trim() ?? ''}`
        )).join('\n');
        throw new Error(`WGSL compilation failed (${errors.length} errors)\n${detail}`);
    }
    return module;
}

const writeAll = () => globalThis.GPUColorWrite.ALL;

// `roles` (10.2/10.3): the emission target's format while roles are staged
// (SCENE_EMISSION_FORMAT on a P3 SDR screen, SCENE_EMISSION_HDR_FORMAT under
// HDR), always written, alpha = the batch role (BLEND_*_ROLE); null is the
// shipped Stage A target.
function emissionTarget(add, roles) {
    if (roles) return { format: roles, blend: add ? BLEND_ADD_ROLE : BLEND_NORMAL_ROLE, writeMask: writeAll() };
    return { format: SCENE_EMISSION_FORMAT, blend: add ? BLEND_ADD : BLEND_NORMAL, writeMask: writeAll() };
}

function sceneDescriptor(layouts, module, { add = false, depth = false, cue = false, roles = null, attachment = true } = {}) {
    const blend = add ? BLEND_ADD : BLEND_NORMAL;
    return {
        label: `world-scene${add ? '-add' : ''}${depth ? '-depth' : ''}${cue ? '-cue' : ''}${roles ? `-roles-${roles}` : ''}${attachment ? '' : '-color-only'}`,
        layout: layouts.scenePipeline,
        vertex: { module, entryPoint: 'sceneVs' },
        primitive: { topology: cue ? 'triangle-list' : 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: SCENE_DEPTH_FORMAT, depthWriteEnabled: depth, depthCompare: 'always' },
        fragment: {
            module,
            entryPoint: 'sceneFs',
            targets: [
                { format: SCENE_COLOR_FORMAT, blend },
                ...(attachment ? [emissionTarget(add, roles)] : []),
            ],
        },
    };
}

function particleDescriptor(layouts, module, { roles = null, attachment = true } = {}) {
    return {
        label: `world-particles${roles ? `-roles-${roles}` : ''}${attachment ? '' : '-color-only'}`,
        layout: layouts.particlePipeline,
        vertex: { module, entryPoint: 'particleVs', buffers: [PARTICLE_VERTEX_LAYOUT] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: SCENE_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
        fragment: {
            module,
            entryPoint: 'particleFs',
            targets: [
                { format: SCENE_COLOR_FORMAT, blend: BLEND_NORMAL },
                ...(attachment ? [emissionTarget(false, roles)] : []),
            ],
        },
    };
}

// RN-1 — the world rain: the particle draw's depth and blend, no vertex
// buffers, two quads (a triangle list) per instance.
function rainDescriptor(layouts, module, { roles = null, attachment = true } = {}) {
    return {
        label: `world-rain${roles ? `-roles-${roles}` : ''}${attachment ? '' : '-color-only'}`,
        layout: layouts.rainPipeline,
        vertex: { module, entryPoint: 'rainVs' },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: SCENE_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
        fragment: {
            module,
            entryPoint: 'rainFs',
            targets: [
                { format: SCENE_COLOR_FORMAT, blend: BLEND_NORMAL },
                ...(attachment ? [emissionTarget(false, roles)] : []),
            ],
        },
    };
}

// Adapt the planar pass's source lookups to GL-row scene targets and the
// persisted sparse contact stream. The integer resolve and collar stay shared.
export async function prepareWorldWaterResolve(device, pass, layouts, roles) {
    const emissionFormat = roles || SCENE_EMISSION_FORMAT;
    const code = PLANAR_WATER_RESOLVE_WGSL;
    const module = await compileModule(device, code, 'world-water-resolve.wgsl');
    const layout = device.createPipelineLayout({ bindGroupLayouts: [pass.resolveParamsLayout, pass.resolveTexturesLayout] });
    const pipeline = (entryPoint, targets) => device.createRenderPipelineAsync({
        label: entryPoint, layout, vertex: { module, entryPoint: 'fullscreenVs' },
        fragment: { module, entryPoint, targets }, primitive: { topology: 'triangle-list' },
    });
    const bed = await compileModule(device, assembleScene().replace(SCENE_WGSL, () => sceneWgsl(false, true)), 'clean-bed.wgsl');
    [pass.resolveColorOnlyPipeline, pass.resolvePipeline, pass.bedColorPipeline, pass.bedPipeline] = await Promise.all([
        pipeline('planarWaterResolveColorFs', [{ format: SCENE_COLOR_FORMAT }]),
        pipeline('planarWaterResolveFs', [{ format: SCENE_COLOR_FORMAT }, { format: emissionFormat }]),
        device.createRenderPipelineAsync(sceneDescriptor(layouts, bed, { attachment: false })),
        device.createRenderPipelineAsync(sceneDescriptor(layouts, bed, { roles })),
    ]);
}

// The compute output is also the instance stream. Decorative sparks keep the
// emission attachment intact and test their emitter's foot against the scene.
export async function prepareEmberPipelines(device, layouts, roles) {
    const module = await compileModule(device, FRAME_UNIFORM_LAYOUT.wgsl + `
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@vertex fn emberVs(@builtin(vertex_index) vi: u32,
    @location(0) posVel: vec4f, @location(1) lifeHeat: vec4f) -> @builtin(position) vec4f {
  if (lifeHeat.z < 0.1) { return vec4f(2.0, 2.0, 0.0, 1.0); }
  let p = floor(posVel.xy) + vec2f(f32(vi & 1u), f32(vi >> 1u));
  let xy = (p + frame.cameraXy) * frame.cameraScale / frame.resolution * 2.0 - 1.0;
  let d = clamp((6144.0 - (2.0 * p.y + 2.5 * max(0.0, lifeHeat.w - p.y))) / 8192.0, 0.0, 1.0);
  let flat = 1.0 - clamp((lifeHeat.w + 2048.0) * 8.0 / 65535.0, 0.0, 1.0);
  return vec4f(xy, select(flat, d, (frame.frontier.x & 4u) != 0u), 1.0);
}
@fragment fn emberFs() -> @location(0) vec4f { return vec4f(0.83, 0.41, 0.16, 1.0); }
`, 'wind-embers.wgsl');
    const variants = new Map();
    await Promise.all([SCENE_DEPTH_FORMAT, 'depth32float'].flatMap(format => (roles ? [true] : [false, true]).map(async attachment => {
        const pipeline = await device.createRenderPipelineAsync({
            label: 'wind-embers', layout: layouts.particlePipeline,
            vertex: { module, entryPoint: 'emberVs', buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [
                { shaderLocation: 0, format: 'float32x4', offset: 0 }, { shaderLocation: 1, format: 'float32x4', offset: 16 },
            ] }] }, primitive: { topology: 'triangle-strip' },
            fragment: { module, entryPoint: 'emberFs', targets: [{ format: SCENE_COLOR_FORMAT },
                ...(attachment ? [{ format: roles || SCENE_EMISSION_FORMAT, writeMask: 0 }] : [])] },
            depthStencil: { format, depthCompare: 'less-equal', depthWriteEnabled: false },
        });
        variants.set(format + attachment, pipeline);
    })));
    return variants;
}

// All consumers of the geometric attachment use the same art-space projection.
export async function prepareSurfacePipelines(device, layouts, roles = null) {
    const shader = assembleScene().replace(SCENE_WGSL, () => sceneWgsl(false, true));
    const depthFor = (sy, foot) => `clamp((6144.0 - (2.0 * ${sy} + 2.5 * max(0.0, ${foot} - ${sy}))) / 8192.0, 0.000001, 0.999999)`;
    const [scene, particle, rain] = await Promise.all([
        compileModule(device, shader + SURFACE_DEPTH_WGSL, 'surface-v1.wgsl'),
        compileModule(device, assembleParticle().replace('1.0 - f32(depth.x) / 65535.0',
            depthFor('world.y', '(f32(depth.x) / 8.0 - 2048.0)')), 'surface-particles.wgsl'),
        compileModule(device, assembleRain().replace('1.0 - key / 65535.0', depthFor('world.y', 'ground.y')), 'surface-rain.wgsl'),
    ]);
    const variants = new Map();
    const tasks = [];
    const prepare = (key, descriptor, compare, entryPoint) => {
        descriptor.depthStencil = { ...descriptor.depthStencil, format: 'depth32float', depthCompare: compare };
        if (entryPoint) descriptor.fragment.entryPoint = entryPoint;
        tasks.push(device.createRenderPipelineAsync(descriptor).then(pipeline => variants.set(key, pipeline)));
    };
    for (const attachment of roles ? [true] : [false, true]) {
        for (const depth of [false, true]) for (const cue of [false, true]) for (const add of [false, true]) {
            for (const emitter of roles && !cue && !add ? [false, true] : [false]) {
                for (const registered of depth ? [false, true] : [false]) {
                    const desc = sceneDescriptor(layouts, scene, { attachment, roles, depth, cue, add });
                    if (emitter) desc.fragment.targets[1].blend = BLEND_NORMAL;
                    // Flat sprite layers share a foot plane and retain their authored paint order.
                    prepare([attachment, depth, cue, add, emitter, registered].join(), desc,
                        registered ? 'less' : 'less-equal', emitter ? 'surfaceRolesFs' : 'surfaceFs');
                }
            }
        }
        prepare('particle' + attachment, particleDescriptor(layouts, particle, { roles, attachment }), 'less-equal');
        prepare('rain' + attachment, rainDescriptor(layouts, rain, { roles, attachment }), 'less-equal');
    }
    await Promise.all(tasks);
    return variants;
}

/**
 * Compiles the world's modules and base pipelines for `canvasFormat`. Throws
 * (with the first WGSL errors) on any failure; never returns a half-built set.
 */
export async function prepareWorldPipelines(device, canvasFormat) {
    device.pushErrorScope('validation');
    let result = null;
    let failure = null;
    try {
        const layouts = createWorldLayouts(device);
        const [scene, particle, composite, bloom, debugLoad] = await Promise.all([
            compileModule(device, assembleScene({ radiance: false }), 'scene.wgsl'),
            compileModule(device, assembleParticle(), 'particle.wgsl'),
            compileModule(device, assembleComposite(), 'composite.wgsl'),
            compileModule(device, BLOOM_WGSL, 'bloom.wgsl'),
            compileModule(device, DEBUG_LOAD_WGSL, 'debug-load.wgsl'),
        ]);
        const modules = { scene, particle, composite, bloom, debugLoad };
        const [sceneBase, particleBase, compositePipeline, bloomPipeline, debugLoadPipeline, markPipeline] = await Promise.all([
            device.createRenderPipelineAsync(sceneDescriptor(layouts, scene, {})),
            device.createRenderPipelineAsync(particleDescriptor(layouts, particle, {})),
            device.createRenderPipelineAsync({
                label: 'world-composite',
                layout: layouts.compositePipeline,
                vertex: { module: composite, entryPoint: 'fullscreenVs' },
                primitive: { topology: 'triangle-list' },
                fragment: { module: composite, entryPoint: 'compositeFs', targets: [{ format: canvasFormat, blend: BLEND_NORMAL }] },
            }),
            device.createRenderPipelineAsync({
                label: 'world-bloom',
                layout: layouts.bloomPipeline,
                vertex: { module: bloom, entryPoint: 'bloomVs' },
                primitive: { topology: 'triangle-list' },
                fragment: { module: bloom, entryPoint: 'bloomFs', targets: [{ format: BLOOM_FORMAT }] },
            }),
            device.createRenderPipelineAsync({
                label: 'world-debug-load',
                layout: layouts.debugLoadPipeline,
                vertex: { module: debugLoad, entryPoint: 'fullscreenVs' },
                primitive: { topology: 'triangle-list' },
                fragment: { module: debugLoad, entryPoint: 'debugLoadFs', targets: [{ format: canvasFormat, blend: BLEND_ADD }] },
            }),
            // Wave 10 S5 — the T1 mark pass over the presented frame (the
            // canvas is not mirrored, so the marks use scene.js's `markVs`).
            device.createRenderPipelineAsync({
                label: 'world-marks',
                layout: layouts.scenePipeline,
                vertex: { module: scene, entryPoint: 'markVs' },
                primitive: { topology: 'triangle-strip', cullMode: 'none' },
                fragment: { module: scene, entryPoint: 'markFs', targets: [{ format: canvasFormat, blend: BLEND_NORMAL }] },
            }),
        ]);
        const sceneVariants = new Map([['0000', sceneBase]]);
        const particleVariants = new Map([['1', particleBase]]);
        // RN-1 — the world rain module and its variants (keyed as particles).
        const rainModule = await compileModule(device, assembleRain(), 'rain.wgsl');
        modules.rain = rainModule;
        const rainVariants = new Map();
        // Stage B — every reachable non-role scene and particle variant:
        // emission is always written when attached, otherwise the pass is
        // color-only. Compile asynchronously here (in parallel, off the frame)
        // instead of by `scene()`/`particles()` inside a frame: on a cold
        // shader cache those synchronous builds held the first WebGPU frame's
        // GPU work for seconds.
        await Promise.all([
            ...Array.from({ length: 7 }, (_, index) => {
                const bits = index + 1;
                const options = { add: (bits & 4) !== 0, depth: (bits & 2) !== 0, cue: (bits & 1) !== 0 };
                const key = `${options.add ? 1 : 0}${options.depth ? 1 : 0}0${options.cue ? 1 : 0}`;
                return device.createRenderPipelineAsync(sceneDescriptor(layouts, scene, options))
                    .then(pipeline => sceneVariants.set(key, pipeline));
            }),
            ...Array.from({ length: 8 }, (_, bits) => {
                const options = { add: (bits & 4) !== 0, depth: (bits & 2) !== 0, cue: (bits & 1) !== 0, attachment: false };
                const key = `${options.add ? 1 : 0}${options.depth ? 1 : 0}1${options.cue ? 1 : 0}:color`;
                return device.createRenderPipelineAsync(sceneDescriptor(layouts, scene, options))
                    .then(pipeline => sceneVariants.set(key, pipeline));
            }),
            device.createRenderPipelineAsync(particleDescriptor(layouts, particle, { attachment: false }))
                .then(pipeline => particleVariants.set('0:color', pipeline)),
            ...[true, false].map(attachment => device.createRenderPipelineAsync(rainDescriptor(layouts, rainModule, { attachment }))
                .then(pipeline => rainVariants.set(attachment ? '1' : '0:color', pipeline))),
        ]);
        // 10.2 / 10.3 — the display variants (an HDR and/or P3 canvas): the
        // roles composite, the roles mark fragment and a debug-load pipeline
        // for the canvas format. Built asynchronously on first request, once
        // per (hdr, p3); an SDR screen never compiles either roles module.
        const displayVariants = new Map();
        let rolesModules = null;
        const buildDisplayVariant = async ({ hdr, p3 }) => {
            rolesModules ||= Promise.all([
                compileModule(device, assembleComposite({ roles: true }), 'composite-roles.wgsl'),
                compileModule(device, assembleScene({ radiance: false, markRoles: true }), 'scene-mark-roles.wgsl'),
            ]);
            const [compositeRoles, markRoles] = await rolesModules;
            const format = hdr ? HDR_CANVAS_FORMAT : canvasFormat;
            const [composite, marks, debugLoadFormat, readout] = await Promise.all([
                device.createRenderPipelineAsync({
                    label: `world-composite-roles${hdr ? '-hdr' : ''}${p3 ? '-p3' : ''}`,
                    layout: layouts.compositeRolesPipeline,
                    vertex: { module: compositeRoles, entryPoint: 'fullscreenVs' },
                    primitive: { topology: 'triangle-list' },
                    fragment: { module: compositeRoles, entryPoint: 'compositeRolesFs', targets: [{ format, blend: BLEND_NORMAL }] },
                }),
                device.createRenderPipelineAsync({
                    label: `world-marks-roles-${format}`,
                    layout: layouts.scenePipeline,
                    vertex: { module: markRoles, entryPoint: 'markVs' },
                    primitive: { topology: 'triangle-strip', cullMode: 'none' },
                    fragment: { module: markRoles, entryPoint: 'markRolesFs', targets: [{ format, blend: BLEND_NORMAL }] },
                }),
                format === canvasFormat ? debugLoadPipeline : device.createRenderPipelineAsync({
                    label: `world-debug-load-${format}`,
                    layout: layouts.debugLoadPipeline,
                    vertex: { module: debugLoad, entryPoint: 'fullscreenVs' },
                    primitive: { topology: 'triangle-list' },
                    fragment: { module: debugLoad, entryPoint: 'debugLoadFs', targets: [{ format, blend: BLEND_ADD }] },
                }),
                // 0.3 — the HDR canvas's SDR readout (`readoutSurface`).
                hdr ? compileModule(device, HDR_READOUT_WGSL, 'hdr-readout.wgsl').then(module => device.createRenderPipelineAsync({
                    label: 'world-hdr-readout',
                    layout: 'auto',
                    vertex: { module, entryPoint: 'fullscreenVs' },
                    primitive: { topology: 'triangle-list' },
                    fragment: { module, entryPoint: 'hdrReadoutFs', targets: [{ format: canvasFormat }] },
                })) : null,
            ]);
            // Role staging always writes emission. Prewarm its scene/particle
            // variants before publishing the display variant, never in render().
            const roles = hdr ? SCENE_EMISSION_HDR_FORMAT : SCENE_EMISSION_FORMAT;
            await Promise.all([
                ...Array.from({ length: 8 }, (_, bits) => {
                    const options = { add: (bits & 4) !== 0, depth: (bits & 2) !== 0, cue: (bits & 1) !== 0, roles };
                    const key = `${options.add ? 1 : 0}${options.depth ? 1 : 0}0${options.cue ? 1 : 0}${roles}`;
                    return device.createRenderPipelineAsync(sceneDescriptor(layouts, scene, options))
                        .then(pipeline => sceneVariants.set(key, pipeline));
                }),
                device.createRenderPipelineAsync(particleDescriptor(layouts, particle, { roles }))
                    .then(pipeline => particleVariants.set(`1${roles}`, pipeline)),
                device.createRenderPipelineAsync(rainDescriptor(layouts, rainModule, { roles }))
                    .then(pipeline => rainVariants.set(`1${roles}`, pipeline)),
            ]);
            return Object.freeze({
                hdr,
                p3,
                format,
                emissionFormat: hdr ? SCENE_EMISSION_HDR_FORMAT : SCENE_EMISSION_FORMAT,
                composite,
                marks,
                debugLoad: debugLoadFormat,
                readout,
            });
        };
        result = {
            layouts,
            modules,
            canvasFormat,
            composite: compositePipeline,
            bloom: bloomPipeline,
            debugLoad: debugLoadPipeline,
            marks: markPipeline,
            // Every lookup is a prewarmed variant, including color-only passes
            // and display-role staging. Missing preparation is a backend error.
            scene(add, depth, emission, cue, roles = null, attachment = true) {
                const key = `${add ? 1 : 0}${depth ? 1 : 0}${emission ? 0 : 1}${cue ? 1 : 0}${roles || ''}${attachment ? '' : ':color'}`;
                const pipeline = sceneVariants.get(key);
                if (!pipeline) throw new Error(`World scene pipeline was not prepared: ${key}`);
                return pipeline;
            },
            particles(emission, roles = null, attachment = true) {
                const key = `${emission ? '1' : '0'}${roles || ''}${attachment ? '' : ':color'}`;
                const pipeline = particleVariants.get(key);
                if (!pipeline) throw new Error(`World particle pipeline was not prepared: ${key}`);
                return pipeline;
            },
            rain(emission, roles = null, attachment = true) {
                const key = `${emission ? '1' : '0'}${roles || ''}${attachment ? '' : ':color'}`;
                const pipeline = rainVariants.get(key);
                if (!pipeline) throw new Error(`World rain pipeline was not prepared: ${key}`);
                return pipeline;
            },
            /** Resolves to the frozen display variant for `{ hdr, p3 }` (at least one true). */
            displayVariant({ hdr = false, p3 = false } = {}) {
                const key = `${hdr ? 1 : 0}${p3 ? 1 : 0}`;
                let pending = displayVariants.get(key);
                if (!pending) {
                    pending = buildDisplayVariant({ hdr, p3 });
                    pending.catch(() => displayVariants.delete(key));
                    displayVariants.set(key, pending);
                }
                return pending;
            },
            get variantCount() {
                return sceneVariants.size + particleVariants.size;
            },
        };
    } catch (error) {
        failure = error;
    }
    const validation = await device.popErrorScope();
    if (failure) throw failure;
    if (validation) throw new Error(`WebGPU pipeline validation failed: ${validation.message}`);
    // §2.4 — the stride assertion runs once per device, at pipeline build.
    result.recordStride = await probeRecordStride(device);
    return result;
}

// §2.4 — the record stride as the shader's own storage layout reports it: a
// compute pass over a buffer whose every u32 word holds its own index reads
// record 1's first lane and record 0's loc3/loc4/loc5 lanes, so the words it
// returns are their byte offsets / 4. `assertRecordStride` throws unless the
// array stride is exactly RECORD_INSTANCE_BYTES.
export async function probeRecordStride(device) {
    const u = globalThis.GPUBufferUsage;
    const module = await compileModule(device, `
${RECORD_STRUCT_WGSL}
@group(0) @binding(0) var<storage, read> recs: array<RecordInstance>;
@group(0) @binding(1) var<storage, read_write> probe: array<u32, 4>;
@compute @workgroup_size(1) fn main() {
  probe[0] = bitcast<u32>(recs[1].loc0x);
  probe[1] = recs[0].loc3xy;
  probe[2] = recs[0].loc4zw;
  probe[3] = recs[0].loc5xy;
}`, 'record-stride.wgsl');
    const words = new Uint32Array(RECORD_INSTANCE_BYTES / 2);
    for (let index = 0; index < words.length; index++) words[index] = index;
    const input = device.createBuffer({ size: words.byteLength, usage: u.STORAGE | u.COPY_DST });
    device.queue.writeBuffer(input, 0, words);
    const output = device.createBuffer({ size: 16, usage: u.STORAGE | u.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: u.MAP_READ | u.COPY_DST });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(globalThis.GPUMapMode.READ);
    const [strideWords, loc3, loc4zw, loc5] = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    for (const buffer of [input, output, read]) buffer.destroy();
    const stride = strideWords * 4;
    assertRecordStride(stride);
    const offsets = { loc3: loc3 * 4, loc4zw: loc4zw * 4, loc5: loc5 * 4 };
    if (offsets.loc3 !== RECORD_OFFSETS.loc3 || offsets.loc4zw !== RECORD_OFFSETS.loc4 + 4 || offsets.loc5 !== RECORD_OFFSETS.loc5) {
        throw new Error(`RecordInstance lanes misplaced: ${JSON.stringify(offsets)}`);
    }
    return stride;
}
