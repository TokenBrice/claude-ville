import {
    buildStableGpuBatches,
    clampGpuLights,
    emissivePhaseForAmbientLight,
    estimateGpuWorldTextureBytes,
    gpuLightColorForShader,
    localLightPhaseForLighting,
    selectGpuTimingMetrics,
} from './GpuWorldPolicy.js';
import {
    createPostFxLadder,
    POST_FX_LEVELS,
} from '../postfx/PostFxLadder.js';

const MAX_LIGHTS = 16;
const VERTEX_FLOATS = 8;
const VERTEX_STRIDE = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const BLOOM_SCALE = 0.375;
const OCCLUSION_SCALE = 0.375;
const EMA_ALPHA = 0.1;
const MAX_CACHED_TEXTURE_BYTES = 48 * 1024 * 1024;
const MAX_CACHED_TEXTURES = 512;
const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;

const PHASE_GRADES = Object.freeze({
    day: { base: [1, 0.996, 0.98], edge: [0.84, 0.88, 0.91], edgeAlpha: 0.28, fog: [0.55, 0.68, 0.74] },
    night: { base: [0.50, 0.59, 0.77], edge: [0.32, 0.42, 0.60], edgeAlpha: 0.46, fog: [0.08, 0.12, 0.22] },
    dusk: { base: [0.93, 0.75, 0.62], edge: [0.59, 0.38, 0.38], edgeAlpha: 0.42, fog: [0.38, 0.29, 0.34] },
    dawn: { base: [0.89, 0.79, 0.78], edge: [0.49, 0.46, 0.59], edgeAlpha: 0.40, fog: [0.44, 0.46, 0.58] },
});

const QUAD_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_world;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_meta;
uniform vec3 u_camera;
uniform vec2 u_resolution;
out vec2 v_uv;
out float v_alpha;
out float v_material;
out float v_elevation;
out float v_emissive;
void main() {
    vec2 screen = (a_world + u_camera.xy) * u_camera.z;
    vec2 clip = vec2(
        screen.x / max(1.0, u_resolution.x) * 2.0 - 1.0,
        1.0 - screen.y / max(1.0, u_resolution.y) * 2.0
    );
    gl_Position = vec4(clip, 0.0, 1.0);
    v_uv = a_uv;
    v_alpha = a_meta.x;
    v_material = a_meta.y;
    v_elevation = a_meta.z;
    v_emissive = a_meta.w;
}`;

const SCENE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_alpha;
in float v_material;
in float v_elevation;
in float v_emissive;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outEmission;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform sampler2D u_emissiveMap;
uniform sampler2D u_occlusion;
uniform bool u_hasMaterialMap;
uniform bool u_hasEmissiveMap;
uniform vec2 u_resolution;
uniform vec2 u_occlusionResolution;
uniform vec3 u_gradeBase;
uniform vec3 u_gradeEdge;
uniform float u_edgeAlpha;
uniform vec3 u_fogColor;
uniform vec4 u_weather;
uniform vec4 u_sun;
uniform float u_time;
uniform float u_motionScale;
uniform int u_lightCount;
uniform vec4 u_lights[16];
uniform vec4 u_lightColors[16];

float materialNear(float value, float target) {
    return 1.0 - step(0.45, abs(value - target));
}

float occlusionBetween(vec2 fromPx, vec2 toPx, float elevation) {
    vec2 fromUv = fromPx / max(vec2(1.0), u_resolution);
    vec2 toUv = toPx / max(vec2(1.0), u_resolution);
    float blocked = 0.0;
    // Three samples keep the stepped pixel-art shadow read while avoiding the
    // previous five texture fetches for every admitted light and scene pixel.
    for (int stepIndex = 1; stepIndex <= 3; stepIndex++) {
        float t = float(stepIndex) / 4.0;
        vec2 uv = mix(fromUv, toUv, t);
        float h = texture(u_occlusion, clamp(uv, vec2(0.0), vec2(1.0))).r;
        blocked = max(blocked, smoothstep(elevation + 0.03, elevation + 0.18, h));
    }
    return blocked;
}

vec3 applyMaterialWeather(vec3 color, float material, vec2 px) {
    float rain = u_weather.x;
    float wettable = max(
        max(materialNear(material, 1.0), materialNear(material, 3.0)),
        max(materialNear(material, 7.0), materialNear(material, 8.0))
    );
    float foliage = materialNear(material, 4.0);
    float phase = u_motionScale <= 0.0 ? 0.37 : u_time * 0.001 * u_motionScale;
    float ordered = mod(floor(px.x) + 2.0 * floor(px.y), 4.0) / 3.0;
    float wet = rain * wettable;
    color *= mix(1.0, 0.80, wet);
    color = mix(color, color * vec3(0.82, 0.94, 1.08), wet * 0.24);
    float glint = step(0.86, fract((px.x + px.y * 0.5) * 0.031 + phase * 0.07 + ordered * 0.08));
    color += vec3(0.22, 0.30, 0.34) * glint * wet * 0.16;
    color = mix(color, color * vec3(0.86, 0.94, 0.82), rain * foliage * 0.12);
    return color;
}

vec3 applyAuthoredSunBand(vec3 color, float material) {
    float response = 0.36;
    response = mix(response, 0.62, materialNear(material, 1.0));
    response = mix(response, 0.48, materialNear(material, 2.0));
    response = mix(response, 0.82, materialNear(material, 3.0));
    response = mix(response, 0.56, materialNear(material, 4.0));
    response = mix(response, 0.42, materialNear(material, 5.0));
    response = mix(response, 0.58, materialNear(material, 7.0));
    response = mix(response, 0.24, materialNear(material, 8.0));
    float keyFacing = clamp(0.5 + (-u_sun.x - u_sun.y) * 0.25, 0.0, 1.0);
    float rawBand = 0.84 + response * (0.12 + keyFacing * 0.12);
    // Four restrained palette bands preserve authored ramps instead of adding
    // a smooth PBR gradient across individual sprite pixels.
    float quantized = rawBand < 0.79 ? 0.72
        : rawBand < 0.93 ? 0.86
        : rawBand < 1.06 ? 1.0
        : 1.12;
    return color * mix(1.0, quantized, clamp(u_sun.w, 0.0, 1.0));
}

vec3 applyGrade(vec3 color, vec2 topLeftPx) {
    vec2 centre = vec2(u_resolution.x * 0.5, u_resolution.y * 0.46);
    float inner = min(u_resolution.x, u_resolution.y) * 0.18;
    float outer = max(u_resolution.x, u_resolution.y) * 0.72;
    float t = clamp((distance(topLeftPx, centre) - inner) / max(1.0, outer - inner), 0.0, 1.0);
    float edge = t <= 0.62
        ? mix(0.0, u_edgeAlpha * 0.4, t / 0.62)
        : mix(u_edgeAlpha * 0.4, u_edgeAlpha, (t - 0.62) / 0.38);
    color *= u_gradeBase;
    color *= mix(vec3(1.0), u_gradeEdge, edge);
    return color;
}

void main() {
    vec4 albedo = texture(u_albedo, v_uv);
    float alpha = albedo.a * v_alpha;
    if (alpha < 0.01) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, v_uv) : vec4(0.0);
    vec4 authoredEmission = u_hasEmissiveMap ? texture(u_emissiveMap, v_uv) : vec4(0.0);
    float material = sidecar.r > 0.003 ? floor(sidecar.r * 255.0 + 0.5) : v_material;
    float emissive = max(v_emissive, sidecar.g * 2.0);
    vec3 emissionColor = albedo.rgb;
    if (u_hasEmissiveMap) {
        // The emissive channel owns both hue (RGB) and contribution (A). Do
        // not reconstruct authored emission from the albedo texture.
        emissionColor = authoredEmission.rgb;
        emissive = authoredEmission.a * 2.0;
    } else if (u_hasMaterialMap) {
        // A material map without an authored emissive channel is explicitly
        // non-emissive; never infer a glow from its albedo pixels.
        emissionColor = vec3(0.0);
        emissive = 0.0;
    }
    // Authored emitters remain identifiable in daylight without behaving like
    // night-time floodlights. Ambient light falls through dusk/night, smoothly
    // restoring their full energy when illumination is actually needed.
    float emissivePhase = mix(0.12, 1.0, 1.0 - clamp(u_sun.w, 0.0, 1.0));
    emissive *= emissivePhase;
    float elevation = max(v_elevation, sidecar.b);
    vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec2 glPx = gl_FragCoord.xy;
    vec3 color = albedo.rgb;
    // Clear weather is the overwhelmingly common case. Avoid the ordered
    // glint/material classification work when every weather contribution is
    // mathematically zero; rainy output remains byte-for-byte equivalent.
    if (u_weather.x > 0.001) color = applyMaterialWeather(color, material, px);
    color = applyAuthoredSunBand(color, material);
    color = applyGrade(color, px);

    for (int i = 0; i < 16; i++) {
        if (i >= u_lightCount) break;
        vec4 light = u_lights[i];
        float radius = max(1.0, light.z);
        float distanceToLight = distance(glPx, light.xy);
        if (distanceToLight >= radius) continue;
        float falloff = 1.0 - smoothstep(0.0, radius, distanceToLight);
        float blocked = occlusionBetween(glPx, light.xy, elevation);
        float amount = falloff * light.w * (1.0 - blocked * 0.88);
        color += u_lightColors[i].rgb * amount * u_lightColors[i].a * 0.34;
        float waterReceiver = materialNear(material, 8.0);
        float reflectionX = 1.0 - smoothstep(0.0, radius * 0.30, abs(glPx.x - light.x));
        float reflectionY = 1.0 - smoothstep(0.0, radius * 1.70, abs(glPx.y - light.y));
        float reflectionCourse = step(0.52, fract((floor(px.x) + floor(px.y) * 0.5) * 0.125));
        color += u_lightColors[i].rgb * waterReceiver * reflectionX * reflectionY
            * reflectionCourse * light.w * u_lightColors[i].a * 0.10;
    }

    float fog = clamp(u_weather.y, 0.0, 1.0);
    float groundFog = fog * (1.0 - elevation * 0.72) * smoothstep(0.18, 0.98, gl_FragCoord.y / max(1.0, u_resolution.y));
    color = mix(color, u_fogColor, groundFog * 0.48);
    vec3 emission = emissionColor * emissive;
    color += emission * 0.42;
    outColor = vec4(max(color, vec3(0.0)) * alpha, alpha);
    outEmission = vec4(emission * alpha, alpha > 0.0 ? 1.0 : 0.0);
}`;

const OCCLUSION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_alpha;
in float v_elevation;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform bool u_hasMaterialMap;
uniform float u_occluder;
layout(location = 0) out vec4 outColor;
void main() {
    float alpha = texture(u_albedo, v_uv).a * v_alpha;
    if (alpha < 0.05) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, v_uv) : vec4(0.0);
    float height = max(max(v_elevation, sidecar.b), u_occluder * sidecar.a);
    outColor = vec4(height * alpha, 0.0, 0.0, alpha);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
const vec2 UV[3] = vec2[](vec2(0.0,0.0), vec2(2.0,0.0), vec2(0.0,2.0));
out vec2 v_uv;
void main() {
    gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
    v_uv = UV[gl_VertexID];
}`;

const BLOOM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_input;
uniform vec2 u_texel;
uniform bool u_blur;
vec4 sampleAt(vec2 uv) { return texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))); }
void main() {
    if (!u_blur) {
        vec4 sum = vec4(0.0);
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                sum += sampleAt(v_uv + vec2(float(x), float(y)) * u_texel * 2.0);
            }
        }
        outColor = sum / 9.0;
        return;
    }
    vec4 sum = sampleAt(v_uv) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0,-1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0,-1.0) * u_texel * 2.0) * 0.20;
    outColor = sum;
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
void main() {
    vec4 scene = texture(u_scene, clamp(v_uv, vec2(0.0), vec2(1.0)));
    vec3 bloom = texture(u_bloom, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    vec3 color = scene.rgb + bloom * u_bloomStrength;
    outColor = vec4(color, scene.a);
}`;

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

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
        gl.deleteShader(shader);
        throw new Error(message);
    }
    return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'unknown program link error';
        gl.deleteProgram(program);
        throw new Error(message);
    }
    return program;
}

function uniformLocations(gl, program, names) {
    return names.reduce((out, name) => {
        out[name] = gl.getUniformLocation(program, name);
        return out;
    }, {});
}

function phaseGrade(feed = {}) {
    const phase = String(feed.phase || feed.atmosphere?.phase || 'day').toLowerCase();
    return PHASE_GRADES[phase] || PHASE_GRADES.day;
}

function weatherUniform(feed = {}) {
    const weather = feed.weather || feed.atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const rainy = type === 'rain' || type === 'storm' || type === 'overcast';
    return [
        rainy ? clamp(finite(weather.precipitation, weather.intensity), 0, 1) : 0,
        clamp(finite(weather.fog, type === 'storm' ? 0.35 : 0), 0, 1),
        type === 'storm' ? 1 : 0,
        clamp(finite(weather.intensity), 0, 1),
    ];
}

export class GpuWorldRenderer {
    constructor(canvas, { enabled = true } = {}) {
        this.canvas = canvas || null;
        this.enabled = Boolean(enabled);
        this.supported = false;
        this.contextHealthy = false;
        this.disposed = false;
        this.suspended = false;
        this.width = Math.max(1, Math.floor(canvas?.width || 1));
        this.height = Math.max(1, Math.floor(canvas?.height || 1));
        this.frames = 0;
        this.records = 0;
        this.batches = 0;
        this.lightCount = 0;
        this.emissivePhase = 0.12;
        this.localLightPhase = 0;
        this.uploadMs = null;
        this.cpuMs = null;
        this.shaderCpuMs = null;
        this.gpuMs = null;
        this.timerExtension = null;
        this.pendingGpuQueries = [];
        this.qualityTimingSource = 'cpu-fallback';
        this.gpuTimerErrors = 0;
        this.frameGapMs = null;
        this.uploads = 0;
        this.uploadBytes = 0;
        this.textureBytes = 0;
        this.textureEvictions = 0;
        this.qualityLadder = createPostFxLadder({
            budgetMs: 4,
            healthyMs: 2,
            overBudgetFrames: 12,
            probeMs: 1500,
        });
        // Shader compilation and first-use texture uploads happen together on
        // a fresh context. Begin with optional occlusion/bloom shed, then let
        // the normal healthy probes restore REDUCED and FULL within ~3 seconds.
        this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
        this._frameUploadMs = 0;
        this._lastRenderAtMs = null;
        this._textureEntries = new Map();
        this._renderErrorLogged = false;
        this._onContextLost = event => {
            event.preventDefault();
            this.contextHealthy = false;
            // A restored WebGL context has a new object namespace. Forget old
            // handles without deleting them; delete* on the restored context
            // produces INVALID_OPERATION warnings for every stale object.
            this._abandonGpuResources();
        };
        this._onContextRestored = () => {
            if (this.disposed) return;
            if (this.suspended) {
                this.contextHealthy = true;
                return;
            }
            try {
                this._initResources();
                this.resize(this.width, this.height);
                this.contextHealthy = true;
            } catch (error) {
                console.warn('[GpuWorldRenderer] context restore failed:', error);
                this.contextHealthy = false;
            }
        };

        if (!canvas?.getContext) return;
        canvas.addEventListener?.('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener?.('webglcontextrestored', this._onContextRestored, false);
        try {
            this.gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: false,
                preserveDrawingBuffer: false,
            });
            if (!this.gl) return;
            this.supported = true;
            this.contextHealthy = true;
            this._initResources();
            this.resize(this.width, this.height);
        } catch (error) {
            console.warn('[GpuWorldRenderer] initialization failed:', error);
            this.contextHealthy = false;
        }
    }

    _initResources() {
        const gl = this.gl;
        this._releaseGpuResources();
        this.sceneProgram = createProgram(gl, QUAD_VERTEX, SCENE_FRAGMENT);
        this.occlusionProgram = createProgram(gl, QUAD_VERTEX, OCCLUSION_FRAGMENT);
        this.bloomProgram = createProgram(gl, FULLSCREEN_VERTEX, BLOOM_FRAGMENT);
        this.compositeProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
        this.timerExtension = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        this.sceneUniforms = uniformLocations(gl, this.sceneProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap', 'u_emissiveMap', 'u_occlusion',
            'u_hasMaterialMap', 'u_hasEmissiveMap', 'u_occlusionResolution', 'u_gradeBase', 'u_gradeEdge',
            'u_edgeAlpha', 'u_fogColor', 'u_weather', 'u_time', 'u_motionScale',
            'u_sun',
            'u_lightCount', 'u_lights[0]', 'u_lightColors[0]',
        ]);
        this.occlusionUniforms = uniformLocations(gl, this.occlusionProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap',
            'u_hasMaterialMap', 'u_occluder',
        ]);
        this.bloomUniforms = uniformLocations(gl, this.bloomProgram, ['u_input', 'u_texel', 'u_blur']);
        this.compositeUniforms = uniformLocations(gl, this.compositeProgram, [
            'u_scene', 'u_bloom', 'u_bloomStrength',
        ]);
        this.vao = gl.createVertexArray();
        this.vertexBuffer = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, VERTEX_STRIDE, 4 * Float32Array.BYTES_PER_ELEMENT);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.emptyMaterialTexture = this._createTexture(1, 1, {
            data: new Uint8Array([0, 0, 0, 0]),
            filter: gl.NEAREST,
        });
        this._textureEntries.clear();
    }

    _createTexture(width, height, { data = null, filter = null } = {}) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const sampling = filter ?? gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    _createTarget(width, height, { attachments = 1, filter = null } = {}) {
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        const textures = [];
        const drawBuffers = [];
        for (let index = 0; index < attachments; index++) {
            const texture = this._createTexture(width, height, { filter });
            textures.push(texture);
            const attachment = gl.COLOR_ATTACHMENT0 + index;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
            drawBuffers.push(attachment);
        }
        gl.drawBuffers(drawBuffers);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            for (const texture of textures) gl.deleteTexture(texture);
            gl.deleteFramebuffer(framebuffer);
            throw new Error('GPU world framebuffer is incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { framebuffer, textures, width, height, attachments };
    }

    _releaseTarget(target) {
        if (!target || !this.gl) return;
        this.gl.deleteFramebuffer(target.framebuffer);
        for (const texture of target.textures || []) this.gl.deleteTexture(texture);
    }

    _releaseGpuResources() {
        const gl = this.gl;
        if (!gl) return;
        if (gl.isContextLost?.()) {
            this._abandonGpuResources();
            return;
        }
        for (const query of this.pendingGpuQueries) gl.deleteQuery?.(query);
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        for (const entry of this._textureEntries?.values?.() || []) {
            if (entry.texture) gl.deleteTexture(entry.texture);
        }
        this._textureEntries?.clear?.();
        if (this.emptyMaterialTexture) gl.deleteTexture(this.emptyMaterialTexture);
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.vao) gl.deleteVertexArray(this.vao);
        for (const program of [this.sceneProgram, this.occlusionProgram, this.bloomProgram, this.compositeProgram]) {
            if (program) gl.deleteProgram(program);
        }
        this.emptyMaterialTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
    }

    _abandonGpuResources() {
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        this._textureEntries?.clear?.();
        this.emptyMaterialTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        this.textureBytes = 0;
        this.vertexBufferBytes = 0;
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this.gpuMs = null;
        this.qualityTimingSource = 'cpu-fallback';
    }

    _ensureTargets() {
        const gl = this.gl;
        const bloomWidth = Math.max(1, Math.floor(this.width * BLOOM_SCALE));
        const bloomHeight = Math.max(1, Math.floor(this.height * BLOOM_SCALE));
        const occWidth = Math.max(1, Math.floor(this.width * OCCLUSION_SCALE));
        const occHeight = Math.max(1, Math.floor(this.height * OCCLUSION_SCALE));
        const matches = this.sceneTarget?.width === this.width
            && this.sceneTarget?.height === this.height
            && this.bloomA?.width === bloomWidth
            && this.bloomA?.height === bloomHeight
            && this.bloomB?.width === bloomWidth
            && this.bloomB?.height === bloomHeight
            && this.occlusionTarget?.width === occWidth
            && this.occlusionTarget?.height === occHeight;
        if (matches) return;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = this._createTarget(this.width, this.height, { attachments: 2, filter: gl.NEAREST });
        this.bloomA = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.bloomB = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.occlusionTarget = this._createTarget(occWidth, occHeight, { filter: gl.NEAREST });
        this._updateTextureBytes();
    }

    _updateTextureBytes() {
        const cachedTextures = [...this._textureEntries.values()].map(entry => ({
            width: entry.width,
            height: entry.height,
            copies: 1,
        }));
        const estimate = estimateGpuWorldTextureBytes({
            width: this.width,
            height: this.height,
            bloomScale: BLOOM_SCALE,
            occlusionScale: OCCLUSION_SCALE,
            cachedTextures,
        });
        // The scene target has two full-resolution attachments rather than the
        // policy helper's one, so add the emissive attachment explicitly.
        this.textureBytes = estimate.total + this.width * this.height * 4;
    }

    resize(width, height) {
        this.width = Math.max(1, Math.floor(finite(width, this.width)));
        this.height = Math.max(1, Math.floor(finite(height, this.height)));
        if (this.canvas) {
            if (this.canvas.width !== this.width) this.canvas.width = this.width;
            if (this.canvas.height !== this.height) this.canvas.height = this.height;
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.imageRendering = 'pixelated';
        }
        if (this.gl && this.contextHealthy && !this.suspended) this._ensureTargets();
    }

    isActive() {
        return Boolean(this.enabled && this.supported && this.contextHealthy && !this.disposed && !this.suspended);
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    suspend() {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        this._releaseGpuResources();
        this.textureBytes = 0;
    }

    resume() {
        if (this.disposed || !this.suspended || !this.gl) return this.isActive();
        try {
            this.suspended = false;
            this._initResources();
            this.resize(this.width, this.height);
            this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
            this.contextHealthy = true;
            return true;
        } catch (error) {
            this.suspended = true;
            this.contextHealthy = false;
            console.warn('[GpuWorldRenderer] resume failed; Canvas fallback remains active:', error);
            return false;
        }
    }

    _textureFor(key, source, revision = null) {
        const gl = this.gl;
        if (!source) return null;
        const width = Math.max(1, Math.floor(source.width || source.videoWidth || 1));
        const height = Math.max(1, Math.floor(source.height || source.videoHeight || 1));
        let entry = this._textureEntries.get(key);
        const changed = !entry
            || entry.source !== source
            || entry.revision !== revision
            || entry.width !== width
            || entry.height !== height;
        if (!entry) {
            entry = { texture: gl.createTexture(), source: null, revision: null, width: 0, height: 0 };
            this._textureEntries.set(key, entry);
        }
        if (changed) {
            const started = performance.now();
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.bindTexture(gl.TEXTURE_2D, null);
            entry.source = source;
            entry.revision = revision;
            entry.width = width;
            entry.height = height;
            this.uploads++;
            this.uploadBytes += width * height * 4;
            this._frameUploadMs += performance.now() - started;
            this._updateTextureBytes();
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.texture;
    }

    _trimTextureCache() {
        let bytes = 0;
        for (const entry of this._textureEntries.values()) bytes += entry.width * entry.height * 4;
        if (bytes <= MAX_CACHED_TEXTURE_BYTES && this._textureEntries.size <= MAX_CACHED_TEXTURES) return;
        const candidates = [...this._textureEntries.entries()]
            .filter(([, entry]) => entry.lastUsedFrame !== this.frames + 1)
            .sort((a, b) => finite(a[1].lastUsedFrame) - finite(b[1].lastUsedFrame));
        for (const [key, entry] of candidates) {
            if (bytes <= MAX_CACHED_TEXTURE_BYTES && this._textureEntries.size <= MAX_CACHED_TEXTURES) break;
            this.gl.deleteTexture(entry.texture);
            this._textureEntries.delete(key);
            bytes -= entry.width * entry.height * 4;
            this.textureEvictions++;
        }
        this._updateTextureBytes();
    }

    _beginGpuTimer() {
        if (!this.timerExtension || !this.gl?.createQuery) return null;
        let query = null;
        try {
            query = this.gl.createQuery();
            if (!query) return null;
            this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
            return query;
        } catch {
            this.gl.deleteQuery?.(query);
            this.gpuTimerErrors++;
            return null;
        }
    }

    _endGpuTimer(query) {
        if (!query || !this.timerExtension) return;
        try {
            const gl = this.gl;
            gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
            this.pendingGpuQueries.push(query);
            if (this.pendingGpuQueries.length > 4) {
                const stale = this.pendingGpuQueries.shift();
                gl.deleteQuery?.(stale);
            }
        } catch {
            this.gpuTimerErrors++;
            this.gpuMs = null;
            this.gl.deleteQuery?.(query);
        }
    }

    _pollGpuQueries() {
        if (!this.timerExtension || !this.pendingGpuQueries.length) return;
        const gl = this.gl;
        let disjoint = false;
        try {
            disjoint = Boolean(gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT));
        } catch {
            return;
        }
        for (let index = this.pendingGpuQueries.length - 1; index >= 0; index--) {
            const query = this.pendingGpuQueries[index];
            let available = false;
            try {
                available = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE));
            } catch {
                this.pendingGpuQueries.splice(index, 1);
                gl.deleteQuery?.(query);
                this.gpuTimerErrors++;
                continue;
            }
            if (!available) continue;
            this.pendingGpuQueries.splice(index, 1);
            try {
                if (disjoint) {
                    // A disjoint interval invalidates every result from it;
                    // use the CPU path until a clean query arrives.
                    this.gpuMs = null;
                } else {
                    const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
                    if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
                        this.gpuMs = ema(this.gpuMs, nanoseconds / 1e6);
                    } else {
                        this.gpuMs = null;
                    }
                }
            } catch {
                this.gpuMs = null;
                this.gpuTimerErrors++;
            } finally {
                gl.deleteQuery?.(query);
            }
        }
    }

    _verticesFor(records) {
        const vertices = new Float32Array(records.length * 6 * VERTEX_FLOATS);
        let offset = 0;
        const push = (x, y, u, v, record) => {
            vertices[offset++] = x;
            vertices[offset++] = y;
            vertices[offset++] = u;
            vertices[offset++] = v;
            vertices[offset++] = record.alpha;
            vertices[offset++] = record.material;
            vertices[offset++] = record.elevation;
            vertices[offset++] = record.emissive;
        };
        for (const record of records) {
            const x0 = record.x;
            const y0 = record.y;
            const x1 = x0 + record.width;
            const y1 = y0 + record.height;
            const u0 = record.sx / record.sourceWidth;
            const v0 = record.sy / record.sourceHeight;
            const u1 = (record.sx + record.sw) / record.sourceWidth;
            const v1 = (record.sy + record.sh) / record.sourceHeight;
            push(x0, y0, u0, v0, record);
            push(x1, y0, u1, v0, record);
            push(x0, y1, u0, v1, record);
            push(x0, y1, u0, v1, record);
            push(x1, y0, u1, v0, record);
            push(x1, y1, u1, v1, record);
        }
        return vertices;
    }

    _setCameraUniforms(uniforms, camera, scale = 1) {
        const gl = this.gl;
        const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
        const zoom = Math.max(0.01, finite(camera?.zoom, 1));
        gl.uniform3f(
            uniforms.u_camera,
            finite(camera?.x),
            finite(camera?.y),
            zoom * dpr * scale,
        );
    }

    _bindBatch(program, uniforms, batch, { occlusion = false } = {}) {
        const gl = this.gl;
        const first = batch.records[0];
        const albedo = this._textureFor(batch.textureKey, batch.source, first?.textureRevision);
        if (!albedo) return 0;
        const material = batch.materialSource
            ? this._textureFor(`material:${batch.sidecarKey || batch.textureKey}`, batch.materialSource, first?.sidecarRevision)
            : this.emptyMaterialTexture;
        const vertices = this._verticesFor(batch.records);
        this.vertexBufferBytes = Math.max(this.vertexBufferBytes || 0, vertices.byteLength);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, albedo);
        gl.uniform1i(uniforms.u_albedo, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, material);
        gl.uniform1i(uniforms.u_materialMap, 1);
        gl.uniform1i(uniforms.u_hasMaterialMap, batch.materialSource ? 1 : 0);
        if (uniforms.u_emissiveMap) {
            const emissive = batch.emissiveSource
                ? this._textureFor(
                    `emissive:${batch.sidecarKey || batch.textureKey}`,
                    batch.emissiveSource,
                    first?.sidecarRevision,
                )
                : this.emptyMaterialTexture;
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, emissive);
            gl.uniform1i(uniforms.u_emissiveMap, 3);
            gl.uniform1i(uniforms.u_hasEmissiveMap, batch.emissiveSource ? 1 : 0);
        }
        if (occlusion) {
            gl.uniform1f(uniforms.u_occluder, Math.max(...batch.records.map(record => record.occluder || 0)));
        }
        gl.drawArrays(gl.TRIANGLES, 0, batch.records.length * 6);
        return batch.records.length;
    }

    _renderOcclusion(batches, camera) {
        const gl = this.gl;
        const target = this.occlusionTarget;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.occlusionProgram);
        this._setCameraUniforms(this.occlusionUniforms, camera, OCCLUSION_SCALE);
        gl.uniform2f(this.occlusionUniforms.u_resolution, target.width, target.height);
        for (const batch of batches) {
            const occluding = batch.records.filter(record => record.occluder > 0 || record.elevation > 0.05);
            if (!occluding.length) continue;
            this._bindBatch(this.occlusionProgram, this.occlusionUniforms, { ...batch, records: occluding }, { occlusion: true });
        }
    }

    _setSceneUniforms(feed, camera, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        const uniforms = this.sceneUniforms;
        const grade = phaseGrade(feed);
        const weather = weatherUniform(feed);
        if (qualityLevel >= POST_FX_LEVELS.REDUCED) {
            weather[0] *= 0.72;
            weather[3] *= 0.72;
        }
        if (qualityLevel >= POST_FX_LEVELS.MINIMAL) {
            weather[0] = 0;
            weather[2] = 0;
            weather[3] = 0;
        }
        this._setCameraUniforms(uniforms, camera, 1);
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        gl.uniform2f(uniforms.u_occlusionResolution, this.occlusionTarget.width, this.occlusionTarget.height);
        gl.uniform3fv(uniforms.u_gradeBase, grade.base);
        gl.uniform3fv(uniforms.u_gradeEdge, grade.edge);
        gl.uniform1f(uniforms.u_edgeAlpha, grade.edgeAlpha);
        gl.uniform3fv(uniforms.u_fogColor, grade.fog);
        gl.uniform4fv(uniforms.u_weather, weather);
        const sun = feed.lighting?.sunDirIso || {};
        gl.uniform4f(
            uniforms.u_sun,
            finite(sun.x, -0.7071),
            finite(sun.y, -0.7071),
            clamp(finite(feed.lighting?.sunWarmth), 0, 1),
            clamp(finite(feed.lighting?.ambientLight, 1), 0, 1),
        );
        this.emissivePhase = emissivePhaseForAmbientLight(feed.lighting?.ambientLight);
        gl.uniform1f(uniforms.u_time, finite(feed.timeMs, Date.now()));
        gl.uniform1f(uniforms.u_motionScale, feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2));
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.occlusionTarget.textures[0]);
        gl.uniform1i(uniforms.u_occlusion, 2);

        this.localLightPhase = localLightPhaseForLighting(feed.lighting);
        const daylightSuppressesLights = this.localLightPhase <= LOCAL_LIGHT_VISIBILITY_FLOOR;
        const lightLimit = daylightSuppressesLights
            ? 0
            : qualityLevel >= POST_FX_LEVELS.MINIMAL
            ? 4
            : qualityLevel >= POST_FX_LEVELS.REDUCED
                ? 10
                : MAX_LIGHTS;
        const lights = clampGpuLights(feed.lights, lightLimit);
        const lightValues = new Float32Array(MAX_LIGHTS * 4);
        const lightColors = new Float32Array(MAX_LIGHTS * 4);
        for (let index = 0; index < lights.length; index++) {
            const light = lights[index];
            const color = gpuLightColorForShader(light, [1, 0.78, 0.42]);
            const offset = index * 4;
            lightValues[offset] = finite(light.x);
            lightValues[offset + 1] = this.height - finite(light.y);
            lightValues[offset + 2] = Math.max(1, finite(light.radius, 64));
            lightValues[offset + 3] = clamp(finite(light.intensity, 1), 0, 3)
                * this.localLightPhase;
            lightColors[offset] = color[0];
            lightColors[offset + 1] = color[1];
            lightColors[offset + 2] = color[2];
            lightColors[offset + 3] = light.night
                ? clamp(finite(feed.lighting?.beaconIntensity, 0), 0, 1)
                : 1;
        }
        this.lightCount = lights.length;
        gl.uniform1i(uniforms.u_lightCount, lights.length);
        gl.uniform4fv(uniforms['u_lights[0]'], lightValues);
        gl.uniform4fv(uniforms['u_lightColors[0]'], lightColors);
    }

    _renderScene(batches, camera, feed, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
        const bloomEnabled = qualityLevel < POST_FX_LEVELS.MINIMAL
            && localLightPhaseForLighting(feed.lighting) > LOCAL_LIGHT_VISIBILITY_FLOOR;
        gl.drawBuffers(bloomEnabled
            ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]
            : [gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.sceneProgram);
        this._setSceneUniforms(feed, camera, qualityLevel);
        for (const batch of batches) {
            if (batch.blend === 'add') gl.blendFunc(gl.ONE, gl.ONE);
            else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this._bindBatch(this.sceneProgram, this.sceneUniforms, batch);
        }
        return bloomEnabled;
    }

    _renderBloom() {
        const gl = this.gl;
        gl.useProgram(this.bloomProgram);
        gl.uniform1i(this.bloomUniforms.u_input, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.bloomA.width, this.bloomA.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[1]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.width, 1 / this.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.framebuffer);
        gl.viewport(0, 0, this.bloomB.width, this.bloomB.height);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomA.textures[0]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.bloomA.width, 1 / this.bloomA.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _present(qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.drawBuffers([gl.BACK]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.compositeProgram);
        gl.uniform1i(this.compositeUniforms.u_scene, 0);
        gl.uniform1i(this.compositeUniforms.u_bloom, 1);
        const bloomStrength = qualityLevel >= POST_FX_LEVELS.MINIMAL
            ? 0
            : qualityLevel >= POST_FX_LEVELS.REDUCED
                ? 0.42
                : 0.72;
        gl.uniform1f(
            this.compositeUniforms.u_bloomStrength,
            this.lightCount > 0 ? bloomStrength * this.emissivePhase : 0,
        );
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[0]);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomB.textures[0]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    render({ records = [], camera = null, feed = {} } = {}) {
        if (!this.isActive() || !camera || !records.length) return false;
        const gl = this.gl;
        const started = performance.now();
        const frameGapMs = this._lastRenderAtMs == null ? 0 : started - this._lastRenderAtMs;
        this._lastRenderAtMs = started;
        this._frameUploadMs = 0;
        let qualityLevel = this.qualityLadder.getLevel();
        let gpuTimer = null;
        // DISABLED means optional GPU effects are exhausted, not that the
        // renderer may swap composition paths mid-scene. Canvas-only fauna and
        // water details sit beneath this surface; toggling to Canvas and back
        // makes boats/waterfalls blink. Keep the minimal resident scene while
        // cheap probes allow recovery after warm-up.
        if (qualityLevel >= POST_FX_LEVELS.DISABLED) {
            const recovery = this.qualityLadder.update({ totalMs: 0 }, started);
            qualityLevel = Math.min(recovery.effectiveLevel, POST_FX_LEVELS.MINIMAL);
        }
        try {
            // Timer results are asynchronous. Polling only availability keeps
            // this path non-blocking; until the first clean result arrives the
            // existing CPU submission measurement remains the ladder fallback.
            this._pollGpuQueries();
            this._ensureTargets();
            const batches = buildStableGpuBatches(records);
            if (!batches.length) return false;
            gl.bindVertexArray(this.vao);
            gl.enable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gpuTimer = this._beginGpuTimer();
            const localLightsVisible = localLightPhaseForLighting(feed.lighting)
                > LOCAL_LIGHT_VISIBILITY_FLOOR;
            if (qualityLevel < POST_FX_LEVELS.MINIMAL && localLightsVisible) {
                this._renderOcclusion(batches, camera);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.occlusionTarget.framebuffer);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.viewport(0, 0, this.occlusionTarget.width, this.occlusionTarget.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            const bloomEnabled = this._renderScene(batches, camera, feed, qualityLevel);
            gl.disable(gl.BLEND);
            if (bloomEnabled && this.lightCount > 0) this._renderBloom();
            gl.enable(gl.BLEND);
            this._present(qualityLevel);
            this._endGpuTimer(gpuTimer);
            gpuTimer = null;
            this._trimTextureCache();
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.bindVertexArray(null);
            this.records = batches.reduce((sum, batch) => sum + batch.records.length, 0);
            this.batches = batches.length;
            this.frames++;
            const totalMs = performance.now() - started;
            const shaderCpuMs = Math.max(0, totalMs - this._frameUploadMs);
            this.uploadMs = ema(this.uploadMs, this._frameUploadMs);
            this.shaderCpuMs = ema(this.shaderCpuMs, shaderCpuMs);
            this.cpuMs = ema(this.cpuMs, totalMs);
            this.frameGapMs = ema(this.frameGapMs, frameGapMs);
            const timing = selectGpuTimingMetrics({
                uploadMs: this._frameUploadMs,
                shaderCpuMs,
                gpuMs: this.gpuMs,
                gpuTimerSupported: Boolean(this.timerExtension),
                frameGapMs,
            });
            this.qualityTimingSource = timing.source;
            this.qualityLadder.update(timing.metrics, started);
            return true;
        } catch (error) {
            if (gpuTimer) {
                try {
                    gl.endQuery(this.timerExtension?.TIME_ELAPSED_EXT);
                } catch {
                    // Context loss or a driver error may already have ended it.
                }
                gl.deleteQuery?.(gpuTimer);
            }
            if (!this._renderErrorLogged) {
                this._renderErrorLogged = true;
                console.warn('[GpuWorldRenderer] render failed; Canvas fallback remains active:', error);
            }
            this.contextHealthy = false;
            return false;
        }
    }

    getDiagnostics() {
        const quality = this.qualityLadder.getState();
        return {
            supported: this.supported,
            active: this.isActive(),
            contextHealthy: this.contextHealthy,
            suspended: this.suspended,
            width: this.width,
            height: this.height,
            frames: this.frames,
            records: this.records,
            batches: this.batches,
            lights: this.lightCount,
            localLightPhase: this.localLightPhase,
            uploads: this.uploads,
            uploadBytes: this.uploadBytes,
            uploadMs: this.uploadMs ?? 0,
            cpuMs: this.cpuMs ?? 0,
            shaderCpuMs: this.shaderCpuMs ?? 0,
            gpuMs: this.gpuMs,
            gpuTimerSupported: Boolean(this.timerExtension),
            gpuTimerExtension: this.timerExtension ? 'EXT_disjoint_timer_query_webgl2' : null,
            gpuTimerPendingQueries: this.pendingGpuQueries.length,
            gpuTimerErrors: this.gpuTimerErrors,
            qualityTimingSource: this.qualityTimingSource,
            frameGapMs: this.frameGapMs ?? 0,
            textureBytes: this.textureBytes,
            cachedTextures: this._textureEntries.size,
            textureEvictions: this.textureEvictions,
            maxCachedTextureBytes: MAX_CACHED_TEXTURE_BYTES,
            maxCachedTextures: MAX_CACHED_TEXTURES,
            materialAttachments: 2,
            occlusionScale: OCCLUSION_SCALE,
            bloomScale: BLOOM_SCALE,
            qualityLevel: quality.effectiveLevel,
            qualityReason: quality.lastDecisionReason,
            qualityDegradationReason: quality.lastDegradationReason,
            qualityTransitionAtMs: quality.lastTransitionAtMs,
            qualityTransitionMetrics: quality.lastTransitionMetrics,
            resources: this.getResourceAccounting(),
        };
    }

    getResourceAccounting() {
        if (this.suspended || !this.contextHealthy) {
            return { textures: {}, attachments: {}, buffers: {} };
        }
        const cachedTextures = [...this._textureEntries.values()]
            .reduce((sum, entry) => sum + entry.width * entry.height * 4, 0);
        const targetBytes = target => target ? target.width * target.height * 4 : 0;
        return {
            textures: { cachedSources: cachedTextures },
            attachments: {
                sceneColor: targetBytes(this.sceneTarget),
                sceneEmission: targetBytes(this.sceneTarget),
                bloomA: targetBytes(this.bloomA),
                bloomB: targetBytes(this.bloomB),
                occlusion: targetBytes(this.occlusionTarget),
            },
            buffers: { vertices: this.vertexBufferBytes || 0 },
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.canvas?.removeEventListener?.('webglcontextlost', this._onContextLost, false);
        this.canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
        this._releaseGpuResources();
        this.contextHealthy = false;
        this.textureBytes = 0;
    }
}

export function createGpuWorldRenderer({ canvas, enabled = true } = {}) {
    if (!canvas?.getContext) return null;
    const renderer = new GpuWorldRenderer(canvas, { enabled });
    return renderer.supported ? renderer : null;
}
