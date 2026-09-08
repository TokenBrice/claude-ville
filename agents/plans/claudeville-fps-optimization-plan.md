# ClaudeVille World FPS optimization plan

**Status:** `proposed — not started`
**Date:** 2026-09-08
**Constraint:** every item must have no or low visual-quality impact. Resolution cuts, effect removal, cadence throttling of visible motion, and agent-count caps are out of scope.
**Evidence:** four read-only Astra investigations on today's `main` against the maintained server (see *Evidence sources*), plus retained `agents/research/nfs-5/04-renderer.md` and `agents/research/claudeville-frontier-visual/performance-envelope.md`. Numbers below are measured unless marked `[estimate]`.

## 1. Diagnosis

The world is **not GPU-bound and not on the wrong GPU**. On a real windowed Chrome on the RTX 5070 Ti (`UNMASKED_RENDERER_WEBGL` = NVIDIA, `--render-node-override=/dev/dri/renderD128`), the WebGL timer query reports **0.5–1.3 ms GPU time per frame**. Chrome flag A/B (`--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist CanvasOopRasterization`) changed nothing; Vulkan blanks the world. Launcher changes are rejected.

The frame is spent in two places, both driven by the **volume of Canvas2D commands** issued to `worldCanvas` and `worldOverlayCanvas` every frame:

| Where | Measured | Source |
| --- | --- | --- |
| Main thread JS (`appTotalMs`) | 13–18 ms p50 at 47–89 agents; `drawables` segment 8 ms p50 / 18 ms p95 | frameHealth + `_frameTimingSamples` |
| GPU-process CPU replaying accelerated-Canvas2D paint ops (`RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` 1855 ms + `DoRasterCHROMIUM::Deserializing` 508 ms over a 7.06 s / 168-commit trace) | **~14 ms of GPU-process CPU per commit** | CDP trace, headed NVIDIA probe |
| Main-thread canvas publication (`ProduceCanvasResource` 136 ms / 112 calls, `RasterCHROMIUM` 126 ms) | ~1.6 ms per commit | same trace |
| Actual GPU execution | 0.5–1.3 ms | `EXT_disjoint_timer_query_webgl2` |

This matches the user's symptom: the long-running Chrome GPU process at ~70 % of a core with an idle GPU. `hostGapMs` is Chrome rasterizing our 2D command stream, not compositing.

**Command volume.** Wrapped `CanvasRenderingContext2D` counters over 629 frames at 89 agents (denominator includes ablation phases, so per-frame figures are lower bounds): `worldOverlayCanvas` fillRect 982 k, fill 326 k, stroke 261 k, fillText 82 k; `worldCanvas` fill 451 k, fillRect 366 k, stroke 323 k, drawImage 117 k, fillText 67 k — **≈ 5,400 Canvas2D commands per frame** across the two 2D layers.

**Layer ablation (same window, runtime-only, 89 agents, quality level 0):**

| Suppressed paint | FPS | appTotalMs | hostGapMs |
| --- | ---: | ---: | ---: |
| none (baseline) | 41.5 | 13.5 | 10.9 |
| `worldOverlayCanvas` | 50.3 | 11.4 | 8.0 |
| `worldCanvas` | **74.8** | 9.2 | 3.7 |
| none (restored) | 42.5 | 15.6 | 16.0 |

Suppressing `worldCanvas` painting alone nearly doubles FPS. This is a destructive ablation, not a shippable change — but it bounds the prize: **the lower 2D canvas costs ~11 ms/frame end-to-end**, and on the resident GPU path most of what it paints is *covered* by the WebGL layer.

**Root cause (source).** `DrawablePass.drawDepthSortedDrawables` (`DrawablePass.js:289-298`) skips Canvas buildings/props when `gpuWorldActive`, but **not agents**. `AgentSprite._drawAtScreenPosition` (`AgentSprite.js:2996-3032`) must run to publish `_setGpuFrameRecord`, then continues to paint back equipment, silhouette, body `drawImage`, frozen tint, and front equipment into `worldCanvas` — pixels the resident renderer then draws again on `fxCanvas` above it. The five action marks already have single-backend ownership (`:3042-3048`); the body does not. CPU sampling at 50 agents puts `drawImage` under `_drawCodexAssetEquipment` (110 ms) and `save` under `_drawChatEffect` (77 ms) at the top of the drawables pass. `HarborTraffic._drawRepoAnchorage` (27 ms) is a second duplicate-category site.

## 2. Ranked items

Gain figures are per frame at the 47–89-agent baseline on the NVIDIA host. FPS conversion is non-linear; at 17 FPS each saved ms ≈ +0.3 FPS, at 40 FPS ≈ +1.7 FPS.

### P1 — Resident agents: prepare only, don't paint the body (highest value)

- **Change.** Split `AgentSprite._drawAtScreenPosition` into state/pose/geometry preparation (always) and Canvas body painting (fallback path only). On the resident GPU path, publish `_setGpuFrameRecord` and skip `_drawCodexEquipment(back/front)`, `_drawSpriteSilhouette`, the body `drawImage`, and `_drawFrozenTint`. Keep grounding, arrival ring, waiting beacon, departed treatment, and every fallback-path behaviour byte-identical. Route through `DrawablePass.drawAgent` so the policy lives beside the existing building/prop skip.
- **Coverage audit (required).** The Canvas layer can show through where the WebGL island does not cover (sea edge, waterfall, arrivals outside the island). Decide per-drawable using the same scene-category policy the buildings use, not a blanket skip.
- **Gain.** Removes the majority of `worldCanvas` drawImage/fill work at any agent count. Bounded above by the ablation (≈ 11 ms/frame end-to-end incl. GPU-process replay); `[estimate]` 4–8 ms/frame realistic.
- **Visual risk.** None if coverage is proven; bodies are already rendered by the GPU layer. Verify pixel-diff at day/night, full/compact LOD, selected/waiting/rate-limited/departed, arrival/archive, sea edge, and both zoom extremes.
- **Effort.** M. Files: `AgentSprite.js` (`_drawAtScreenPosition`, ~L2900-3100), `DrawablePass.js` (`drawAgent`, `drawDepthSortedDrawables`), `AgentGpuOverlayRenderer.js` (parity check only).
- **Verify.** Counter of lower-context body/equipment paint calls → 0 on the resident path while GPU records and upper-overlay marks stay constant; headed A/B of `drawables` segment and `hostGapMs`; `npm run verify:render`.

### P2 — Single-owner rule for every scene category on the resident path

- **Change.** Extend the P1 ownership rule to the remaining duplicate-painted categories, starting with `HarborTraffic._drawRepoAnchorage` (27 ms sampled) and any lower-pass decoration the GPU scene already emits (`GpuSceneBuilder` terrain/ground/shadow records). Add a per-category paint counter to the existing Shift-D diagnostics so ownership is observable.
- **Gain.** `[estimate]` 1–3 ms/frame; reduces the ~5,400 commands/frame further.
- **Visual risk.** None where coverage is proven (same audit as P1). Low otherwise — do not skip categories that legitimately paint outside the island.
- **Effort.** M. Files: `DrawablePass.js` (category policy), `WorldFrameRenderer.js:543-605` (lower/upper dispatch), `HarborTraffic.js`.

### P3 — Overlay canvas: replace per-frame vector plaques with cached stamps

- **Change.** `worldOverlayCanvas` issues ~1,500 `fillRect` + ~500 `fill` + ~400 `stroke` per frame (89 agents), dominated by static plaque geometry redrawn each frame: `_drawChatEffect` scroll/backplate/path (`AgentSprite.js:5628-5666`), compact name/status plates (`_drawCompactNameStatus`, `:5773`), provider glyphs. Text layout is already cached; the *raster path construction* is not. Cache each plaque as a small bounded offscreen stamp keyed by (text, accent, DPR, zoom bucket) and `drawImage` it — one command instead of dozens.
- **Gain.** `[estimate]` 2–4 ms/frame end-to-end at crowd density (overlay ablation bounded it at ~5 ms).
- **Visual risk.** None at integer DPR/zoom; low at fractional zoom (verify pixel parity; snap stamp placement to device pixels as body anchors already are, `AgentSprite.js:6969-6972`).
- **Effort.** M. Bounded LRU (reuse the 240-entry pattern from `_getLightGlowStamp`).

### P4 — Stop building the unused PostFx water mask on the resident path

- **Change.** `PostFxFeed.build` calls `fillWater` unconditionally (`PostFxFeed.js:710-727`); the resident GLSL has no water-mask sampler; `WorldFrameRenderer.js:620-650` still sends it. Gate on backend. Measured 35 repaints / 36 frames of a 315×200 canvas.
- **Gain.** 0.27 ms/frame measured producer CPU. Small, but zero-risk and S.
- **Visual risk.** None (hybrid PostFx path keeps it).
- **Effort.** S.

### P5 — Skip geometry-channel preparation when it cannot affect the frame

- **Change.** Four agent-atlas channels (albedo, material, emissive, occluder) each receive the same dirty patches (~164 `texSubImage2D` per frame at 90 agents, 3.6 MB/frame each). The occluder/geometry channel is dead only when occlusion is disabled **and** the ground-fog elevation coefficient is zero (`GpuWorldRenderer.js:316-317,393`). Gate `_uploadBatchTextures`, `_stageFrameVertices`, the occlusion clear, and the atlas geometry packing under that exact predicate; force a full revision on reactivation. Never skip emissive because bloom is off (`:395-397`).
- **Gain.** Up to 3.6 MB/frame and ~25 % of patch submissions when the predicate holds; `[estimate]` 0.1–0.3 ms submission plus unmeasured GPU-process command time.
- **Visual risk.** None under the exact predicate; verify fog/night recovery.
- **Effort.** M. Files: `GpuWorldRenderer.js:1179-1225,1532-1596`, `GpuSceneBuilder.js:833-880,999-1094`.

### P6 — Dirty-rect uploads for the retained semantic ground (existing P3 of the frontier plan)

- **Change.** `ground:semantics` (1006×639) is fully re-uploaded on every revision change (36/36 frames, 2.57 MB/frame) with zero storage changes. Implement the already-proposed dirty-region `texSubImage2D`.
- **Gain.** Up to 2.5 MB/frame; `[estimate]` 0.1–0.3 ms.
- **Visual risk.** None.
- **Effort.** M. Already specified in `agents/research/claudeville-frontier-visual/performance-envelope.md` P3 — do not re-design, implement.

### P7 — Coalesce adjacent agent-atlas dirty cells into row runs

- **Change.** Merge horizontally adjacent 140×140 dirty cells into one `texSubImage2D` per row run (bytes may rise slightly, call count falls). Admit only if a headed A/B shows the GPU-process command overhead falling.
- **Gain.** `[estimate]` 0.1–0.4 ms; unproven.
- **Effort.** M. Conditional experiment; drop if P1–P3 land and the GPU-process replay share becomes negligible.

## 3. Session-age degradation (3 FPS after hours vs 17 FPS fresh)

Not reproduced in the 4-minute headless soak that survived: forced-GC heap flat at ~33 MB, `createTexture`/`deleteTexture` balanced (285/289), `agentSprites` tracked the roster, DOM nodes flat. Two growth signals were observed and are worth bounding, but neither is proven to be the 3 FPS cause:

| Metric | t=0 | t=240 s | Note |
| --- | ---: | ---: | --- |
| renderer-held canvases | 1,240 | 2,915 | plateaued ~2,900 after 120 s |
| held canvas pixels | 51.2 M | 75.5 M | ≈ 300 MB of 2D backing stores, mostly `_silhouetteCellCache` (898→2,535) and `_cellBoundsCache` (1,216→2,637) |
| GPU cached-source bytes vs cap | 125 MB vs 50 MB cap, `cachedTextureCapExceeded: true`, 780 evictions | — | pinned sources exceed the soft cap; eviction excludes this-frame textures, so a large roster can thrash |

Source findings from the same investigation (each a small, no-visual-impact fix):

- `IsometricRenderer._getWetReflectionStamp` (`L10445-10479`) inserts into `lightGradientCache` without the 240-entry/pixel eviction its sibling `_getLightGlowStamp` uses, and its key includes the atmosphere cache key although the stamp pixels do not depend on it → unbounded key churn across the day cycle.
- Overlay spatial grids (`_overlayCompactGrid`, `_overlayBubbleGrid`, `_overlayClusterGrid`) retain stale `bucket.items` until the bucket is revisited; `staleBuckets` rose 9→49, 13→61, 16→38 in 4 min. `_overlayBubbleClusters` never truncates its high-water array.
- `App._cleanupOwnedOnce` (`App.js:1884-1885, 1999-2001`) never calls `wsClient.disconnect()` directly; a destroy between `_bootFoundation` (`:378-385`) and `SessionWatcher` creation (`:261-265`) leaks the socket and reconnect timer. Not a steady-state leak; a lifecycle gap.

**P8 — Bound the caches above and re-run the soak for 60+ minutes on a headed NVIDIA probe** (the maintained `performance-soak.mjs` at 10 min did not reach the regime the user hit). Record `hostGapMs`, GPU-process CPU (`/proc/<pid>/stat`), held-canvas pixels, and `textureEvictions` every minute. Hypotheses to test if bounded caches don't fix it: time-of-day driven cache churn (atmosphere-keyed stamps), texture-cap thrash at high roster, Chrome discarding accelerated canvases under memory pressure and falling back to software raster for the 3,000 small canvases.

## 4. Rejected / out of scope

- Chrome launch flags, Vulkan, PRIME offload, `--use-angle` variants — measured no change or breakage.
- Resolution/DPR reductions, disabling bloom/occlusion further, agent-cadence throttling — visible; and the GPU is idle so they buy nothing.
- OffscreenCanvas worker (OF-007) and WebGPU (OF-008) — remain conditional per `open-followups.md`; the bottleneck is command volume, which a worker would move rather than remove.
- Generic pooling / allocation trimming — already landed under NFS-5; `collect`/`sort/cull` are < 1 ms.

## 5. Execution order

1. **Wave 0 (instrument, S):** per-category paint counters in Shift-D; P4.
2. **Wave 1 (the prize, M):** P1 with the coverage audit, then P2. Gate on headed A/B: `hostGapMs` and `drawables` both down, `verify:render` pixel parity.
3. **Wave 2 (overlay, M):** P3.
4. **Wave 3 (uploads, M):** P5, P6; P7 only if the GPU-process replay share is still material after Wave 1.
5. **Wave 4 (session age):** P8 cache bounds, then the 60-minute headed soak.

**Acceptance for the plan as a whole:** headed NVIDIA probe at 1245×693, live roster ≥ 45 agents: `hostGapMs` ≤ 5 ms, `appTotalMs` ≤ 10 ms p50, ≥ 40 FPS sustained, `verify:render` baselines unchanged, and a 60-minute soak with FPS within 10 % of minute 1.

## 6. Measurement contract

Headed Chrome on the NVIDIA card, launched with the user's `claudeville.fish` flags plus `--remote-debugging-port`, window 1245×693, DPR 1, live server. Per item, record before/after over ≥ 3 s steady state: `window.__claudeVillePerf.frameHealth()` (`emaAppTotalMs`, `emaHostGapMs`, `emaFrameGapMs`), `renderer._frameTimingSamples` p50/p95 per segment (enable via `renderer._performanceSamples = {slots:[],index:0,count:0,capacity:240}`), `renderer.gpuWorld.getDiagnostics()` (`uploads`, `uploadBytes`, `gpuMs`), and wrapped `CanvasRenderingContext2D` call counts per canvas. Headless Playwright is acceptable only for JS-segment deltas; it uses software GL and its `hostGapMs` is meaningless.

## 7. Evidence sources

- Session-local investigations (2026-09-08): `perf-compositor` (CDP trace `/tmp/CompositorGap-trace-complete.json`, layer ablation, canvas inventory), `perf-drawables` (CPU sampling at 50 agents, 10/24/50/100 scaling), `perf-gpu-uploads` (per-texture upload table), `perf-session-decay` (`/tmp/session-decay-soak.jsonl`). Three of the four agents hit the 15-minute runtime cap; their tables were recovered from transcripts.
- Retained: `agents/research/nfs-5/04-renderer.md`, `agents/research/claudeville-frontier-visual/performance-envelope.md`, `agents/plans/open-followups.md`.
