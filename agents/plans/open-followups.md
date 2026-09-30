# Open follow-ups

**Status:** `live checklist`

**As of:** 2026-09-30, release `v0.48.2.1` (js-yaml hotfix after *Heralds of Sun and Moon*; follows *The Keeper's Lamp* and *The Waking Isle*, phases 1–5)

This is the active ledger for deferred work extracted from completed plans. A
source plan can remain `implemented` or `release-verified`; an item belongs
here only when that plan explicitly retained it or gave it a conditional
revisit trigger. The original audit checklists are evidence/specification, not
an additional source of open work.

`[ ]` means open/deferred until its trigger is observed. `[x]` means the
relevant work is already implemented and must not be carried forward as open.

## Artifact-policy note

The repository instructions reference this `agents/README.md` index. It follows
the existing retained-artifact convention of `agents/plans/<slug>.md` and is
linked from each source plan below.

## Open / deferred

- [ ] **Async stale-while-revalidate Git worker / bounded async Git refresh**

  - **ID:** `OF-001`
  - **Added:** 2026-07-26
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Git timeouts, user-visible stalls, cold/change enrichment above 50 ms p95, Git in broadcast p95, or Git commands during an unchanged warm run.
  - **Source:** [comprehensive remediation plan — CV-PERF-003](claudeville-comprehensive-remediation-plan.md#package-9--small-cleanup-and-explicit-deferrals) and [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups).
  - **Reopen when, from the comprehensive plan:** post-Package-8 runtime measurements show Git timeouts or sustained user-visible event-loop/broadcast stalls. The execution record restates this as isolated timeouts or user-visible stalls reproducing.
  - **Reopen when, from the post-OOM plan:** cold/change Git enrichment exceeds **50 ms p95**, Git appears in broadcast p95, or an unchanged warm run launches any Git command.
  - **Current status:** Partially closed. The bounded async stale-while-revalidate worker **is now implemented** in `claudeville/adapters/gitEvents.js` (2 concurrent jobs, 32-deep queue with shedding, request coalescing, 750 ms subprocess timeout, 256 KiB output cap, 1 s–30 s retry backoff, telemetry at `/api/perf` under `gitWorker`). Two synchronous paths remain and are the residual work: `claudeville/adapters/index.js:210-216` (`execFileSync('git', …)`, which was outside the implementing task's file ownership) and the fallback at `claudeville/adapters/gitEvents.js:1656`. Close this item once those two are migrated or explicitly justified as safe.
  - **Current measurement:** recorded cold enrichment was **17.02 ms / 4 commands** and unchanged warm enrichment **0.34 ms / 0 commands**; the comprehensive release gate recorded steady Git activity at **2.50 commands/second** and event-loop p95 at **22.9 ms or below**. No listed trigger is currently evidenced.

- [ ] **Provider/model lazy asset loading**

  - **ID:** `OF-002`
  - **Added:** 2026-07-26
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Cold readiness exceeds 2 seconds or memory pressure is reproduced.
  - **Source:** [comprehensive remediation plan — CV-PERF-004](claudeville-comprehensive-remediation-plan.md#package-9--small-cleanup-and-explicit-deferrals).
  - **Reopen when:** cold readiness exceeds **2 seconds** or memory pressure is reproduced. The retained baseline was cold readiness near **1.23 seconds** with bounded caches.
  - **Current status:** Open — deferred. World resource suspension/reload is implemented, but broader provider/model lazy-loading infrastructure was not added. Current boot still awaits `AssetManager.load()` and, for the material renderer, `loadMaterialAssets()` before loading the renderer (`claudeville/src/presentation/App.js`).

- [ ] **Identity-aware native-surface registry and staged asset groups**

  - **ID:** `OF-003`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** A new surface owner shares World assets with Dashboard, diagnostics cannot attribute overlap, or Dashboard becomes a direct boot mode.
  - **Source:** [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups).
  - **Reopen when:** a new surface owner shares World assets with Dashboard, diagnostics cannot attribute overlap, or Dashboard becomes a direct boot mode.
  - **Current status:** Open — deferred architecture. The simpler explicit owner lifecycle is implemented and reaches zero World canvas/decoded-resource checkpoints, but current `CanvasBudget` is aggregate accounting and `AssetManager` has no identity-aware owner registry or staged `ensure()` groups.
  - **Current measurement:** the recorded World → Dashboard → World checkpoint was **1,286,560 → 0 → 1,286,560** main-canvas pixels, **15,717,856 → 0 → 15,717,856** decoded World asset pixels, and **3,385,600 → 0 → 3,385,600** composited agent-sheet pixels. No listed trigger is currently evidenced.

- [ ] **Durable Claude aggregate checkpoints and a global provider cold-work scheduler**

  - **ID:** `OF-004`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** A cold restart scans more than 64 MiB synchronously, takes more than 2 seconds, or provider diagnostics show a growing deferred-age backlog.
  - **Source:** [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups), corresponding to Package 7 Phase B.
  - **Reopen when:** a cold restart scans more than **64 MiB synchronously**, takes more than **2 seconds**, or provider diagnostics show a growing deferred-age backlog.
  - **Current status:** Open — deferred. Current Claude code has bounded signature/aggregate caches, guard/append aggregation, and a concurrency-one async scan queue, but no durable ClaudeVille-owned checkpoint or global provider cold-work scheduler. The large-fixture evidence was about **52.5 MiB** and an unchanged second detail read added zero parsed lines, so the trigger was not met.

- [ ] **Conditional P3 provider whole-file caches and incremental indexes**

  - **ID:** `OF-005`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Oversized fixtures demonstrate material savings.
  - **Source:** [post-OOM plan — Package 7, Phase C](claudeville-post-oom-reliability-performance-plan.md#phase-c-conditional-p3-whole-file-caches).
  - **Scope:** byte-bound Gemini’s whole-history cache and derive all consumers from one compact pass; incrementally parse growing Codex/Kimi session indexes with last-write-wins semantics instead of full read/split/parse on each signature change.
  - **Reopen when:** oversized fixtures demonstrate **material savings**; the plan records that current local index files were small and no Gemini corpus was present.
  - **Current status:** Open — conditional P3. The measured provider discovery/cache bounds are implemented, but current source still full-reads/splits the Codex index on a signature miss, parses Gemini session JSON as a whole, and rereads the bounded Kimi index tail on a signature miss. No oversized-fixture trigger is recorded.

- [ ] **Long pressure soak before a release push**

  - **ID:** `OF-006`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-26
  - **Trigger:** Before a release push, run and pass the long pressure soak against the correct server process.
  - **Source:** [post-OOM plan — Definition of done](claudeville-post-oom-reliability-performance-plan.md#definition-of-done) and [release verification gate](claudeville-post-oom-reliability-performance-plan.md#package-9--release-verification-gate).
  - **Reopen when:** before a release push, run the long pressure soak against the correct server process and pass both the JavaScript heap/RSS gates and deduplicated native-resource gates.
  - **Current status:** Satisfied for v0.48.0 (default 10/30-minute run against an isolated server, since release agents never touch `:4000`, exit 0; that isolated server had no sessions, so the browser arm soaked an idle island with 0 agents — a loaded soak can point `--url` at the isolated server with `?sim=1&scenario=dense-24-agents`) and for v0.47.1 (against the maintained server); recurring before the next release push. v0.46.0 history: The first 10/30-minute run against an isolated server failed `DOM listener count changed during World soak` (116 vs 114). The count was not climbing: it spiked at the 300 s and 600 s checkpoints and was back at the floor within 1 s. Cause: the 5-minute Chronicle prune ran as seven chained IndexedDB transactions, and the soak's quiescence barrier only waited for the one in flight, so each checkpoint sampled the chain's request handlers mid-flight. `ChronicleStore.prune()` now runs as one atomic readwrite transaction over all pruned stores. The soak and its assertion are unchanged. Re-run exit 0: listeners flat at 114 at every checkpoint; browser heap projected growth 1.57 MB against the 8 MiB limit; server RSS slope ≤ 0. Earlier evidence for v0.42.0: [release evidence](../research/claudeville-astra-refinement/README.md#v0420-release-verification).
  - **Current gate values:** **8 MiB** browser-heap projected-growth limit, **64 MiB** server-RSS allowance above the second-half median, with steady and trailing growth-slope limits, **250 ms** event-loop p95 limit, plus native canvas/asset drift checks in `scripts/smoke/performance-soak.mjs`.

### Additional conditional follow-ups from the semantic rendering plan

The semantic rendering plan also contains two explicit conditional
architecture follow-ups. They are included here because the task brief asked
for them if that completed plan contained open follow-ups; its stale unchecked
implementation checklist is not otherwise treated as open work. The second of
them, OF-008 (WebGPU), has since landed and is recorded under *Already landed*.

- [ ] **Evaluate OffscreenCanvas for remaining main-thread contention**

  - **ID:** `OF-007`
  - **Added:** 2026-08-21
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Profiling after the GPU-resident path is complete shows main-thread contention remains material.
  - **Source:** [semantic diorama rendering plan — Package 9](claudeville-semantic-diorama-rendering-plan.md#package-9--conditional-modernization-and-polish).
  - **Reopen when:** profiling after the GPU-resident path is complete shows main-thread contention remains material.
  - **Current status:** Open — conditional and not implemented. Current source has no `OffscreenCanvas` path; the plan’s recorded post-GPU verification was **12.6 ms rAF p95** at **100% FULL** quality, so no trigger is recorded.

- [ ] **Strip-less read characters (the authored wait row landed)**

  - **ID:** `OF-009`
  - **Added:** 2026-09-06
  - **Trigger:** Generations are funded for the six strip-less profiles' `read` strips (96–144 by the Waking Isle plan's estimate) or for re-cutting the shipped `read` strips that fail the stricter Phase C audit.
  - **Source:** [frontier visual plan — 2.7 roster rollout decision](claudeville-frontier-visual-plan.md#27-roster-rollout-decision) and items 2.1–2.3; [Waking Isle plan — 7.3](claudeville-opus55-xhigh-visual-plan.md#73-authored-work-and-wait-strips-with-pinned-feet-cm-3-m10).
  - **Current status:** Open — narrowed to `read`. The wait row landed in `5f4abfe` (Waking Isle 7.3, PixelLab Phase C): `animate_with_skeleton_v3` with the ankle, knee and hip keypoints copied from the idle cell kept the feet planted where the four earlier held-palm prompts had failed. All 26 profiles in `manifest.yaml` now carry `wait`, `strike` and `tinker` in E/W/SE/SW, and 10 carry `gaze`; the shipped audit passed 1,720 work/wait/gaze frames across 88 groups (feet ±2 px, detached-fragment gate, non-arm identity, raised-hand clearance). What remains is `read`, which only 20 of 26 profiles carry: the same six are strip-less (`codex.gpt55.high`, `claude.fable`, `claude.opus`, `claude.haiku`, `gemini.base`, `grok.base`) and still draw the procedural read prop. Their strips were outside the 1,000-generation cap. The Phase C audit's stricter checks also fail 15 of the 20 shipped `read` strips from `0fe37ee`: 14 on feet (±3 to 7 px, e.g. `deepseek.flash` SE −7) and `codex.gpt54` on a floating wrench 82–102 px off its idle position. They ship unchanged. Balance after the rollout: 338.6 generations.

- [ ] **Resident GPU ladder budget calibration at dense-100**

  - **ID:** `OF-011`
  - **Added:** 2026-09-26
  - **Trigger:** A quiet-host dense-100 soak at tier 1 (`node scripts/smoke/world-fps-benchmark.mjs --mode=soak --scenario=dense-100-agents --zoom=1`) holds FULL (close), or sheds below FULL while its per-pass work is unchanged, or a user reports the village dropping to MINIMAL on a large roster (reopen the budget work).
  - **Source:** [Opus 5.5 aesthetic plan — Performance](claudeville-opus55-aesthetic-plan.md#performance); [Waking Isle plan — 0.1](claudeville-opus55-xhigh-visual-plan.md#01-pacing-true-resident-ladder-and-declared-light-admission-wpg-1-pb-1-pb-7-pb-8).
  - **Current status:** Open — fix landed, receipt pending. The cause was the fixed 4 ms budget measured against ANGLE-Metal `TIME_ELAPSED`, which times whole command-buffer spans (Waking Isle 0.1). The pacing-true ladder in `3e0d876` replaces it (`postfx/PostFxLadder.js`, `scripts/tests/postfx-ladder.test.mjs`): the display period is latched from warm-up and snapped to a standard rate, the timer-veto budget is half the period, a contended timer or main-thread misses never demote a paced display, failed promotion probes back off 8/16/32 s, and a shed that does not help reverts with a 60 s then 120 s cool-down. Light admission is declared per level (32/24/12, `EFFECT_BUDGET['light-admission']`). Every run so far was on a host at load 7–27, so none is evidence. Close when the quiet-host soak meets the 0.1 soak row (≥ 98 % FULL, ≤ 1 change per minute, rAF p95 ≤ 1.05× the period).

- [ ] **GPU-owned memory estimate at DPR 2 (source-texture cap resolved)**

  - **ID:** `OF-012`
  - **Added:** 2026-09-26
  - **Trigger:** Memory pressure is reproduced, the diagnostic ceilings are enforced rather than advisory, or the GPU-owned estimate is re-measured at DPR 2 (close if it is under its 128 MiB ceiling or the ceiling is resized on measured numbers, as the texture cap was).
  - **Source:** [Opus 5.5 aesthetic plan — Performance](claudeville-opus55-aesthetic-plan.md#performance).
  - **Current status:** Open — narrowed. Waking Isle B.2 (`5f4abfe`) met its acceptance (footprint is a byte measure, so the loaded host does not void it): GPU-process footprint at dense-100 1080p 821–874 MB across the implementer's and the auditor's runs (target ≤ 1.0 GB; v0.47.1 read 1,351–1,392 MB with the same probe); `gpuEquippedSheetEstimateBytes` 0 MB by default, because crowd-only equipped sheets are released after 3 s and rebuilt at most one per frame (worst case 101.7 MB with all 17 resident); 0 px frame diff across a real release and recompose; Canvas parity and context loss checked. Dashboard avatar canvases became CPU-backed (−56 MB), and so did the agent atlases (+0.18 ms/frame main-thread upload, noted beside `EFFECT_BUDGET`). The source-texture cap was resized from 48 MiB to 160 MiB on measured numbers (largest set sampled in one frame 130 MB, 0 evictions per 10 s over 7 poses) in `MAX_CACHED_TEXTURE_BYTES` of both resident renderers and in `docs/material-channel-contract.md`. Left: the `CanvasBudget` GPU-owned estimate at DPR 2 was not re-measured against its advisory 128 MiB ceiling (`MAX_GPU_RESOURCE_BYTES`), and about 44 MB of 736×920 raster textures in Chrome's transfer cache (present at v0.47.1 too) is unattributed.


- [ ] **Audio listening sign-off and working-day soaks**

  - **ID:** `OF-013`
  - **Added:** 2026-09-27
  - **Trigger:** Before the next release that ships the Opus 5.5 audio plan.
  - **Source:** [Opus 5.5 audio plan — Execution record](claudeville-opus55-audio-plan.md#execution-record).
  - **Current status:** Open. Waves 0–7 are implemented and pass the local probe (`npm run audio:probe`, stage 7), but no one has listened. v0.47.1 retired the Village preset, so its sea, weather and storm pass and its soak no longer apply, and re-arranged the Town band's book (each piece its own players, key, feel, engine and meter) and extended it to 19 pieces; the Town band listening applies to that book. Pending: the Wave-3 listener battery (T1 idle/light/busy, T2 family ID ≥ 90 %, T5 "is anyone waiting?" ≥ 8/10, in Signals and in Town band for the waiting cadence) and the "bell, not beep" pass; a Town band pass over the 19 pieces (distinct at a listen, and their weather and night re-dress); a full working-day soak in Town band and in Signals (log what got turned down or off). The reel v3 in `output/claudeville-opus55-audio/reel/` (local only) predates v0.47.1. The Waking Isle phases changed no sound, only when the world's marks show against it: a mark whose cue a sounding director expects waits for its note (`expectCueScore`, `5f4abfe`), and the release crown lands on the peal's first note (8.2, `6559335`). Judge that sync in the same listening pass.

- [ ] **Audio frame and CPU cost on a quiet host**

  - **ID:** `OF-015`
  - **Added:** 2026-09-27
  - **Trigger:** A quiet-host run of `npm run audio:probe -- --only fps` and the world-scene CPU proxy.
  - **Source:** [Opus 5.5 audio plan — Waves 4 and 5](claudeville-opus55-audio-plan.md#execution-record).
  - **Current status:** Open — reported as INFO. On a loaded host the app frame total p95 read +0.1…+0.3 ms with sound on (the gate is ≤ 0.1 ms; off-vs-off noise was 0.0–0.5 ms; the same at Wave-4 HEAD). The world-scene CPU proxy (a median 6.8 % of a core against the ≤ 2 % sea / ≤ 3.5 % storm budgets) measured the Village layers, retired in v0.47.1, so that half of the trigger no longer applies. What remains is the frame cost with the Town band playing, from a quiet-host `npm run audio:probe -- --only fps`.

### Carried from the Waking Isle plan

Items the [Waking Isle plan](claudeville-opus55-xhigh-visual-plan.md) could
not close with the hardware, engines or generations available, or that its
art-director reviews raised outside its scope.

- [ ] **Headed by-eye HDR and P3 judgement on the XDR**

  - **ID:** `OF-017`
  - **Added:** 2026-09-29
  - **Trigger:** The maintainer views a lit night scene (e.g. `many-waiting` at 22:00) headed on the XDR in Chrome on the Stage B default renderer.
  - **Source:** [Waking Isle plan — 10.2](claudeville-opus55-xhigh-visual-plan.md#102-tier-h-hdr-highlights-on-the-webgpu-presenter-ch-3) and [10.3](claudeville-opus55-xhigh-visual-plan.md#103-reserved-role-wide-gamut-on-p3-screens-ch-4).
  - **Current status:** Open. Headroom 16 shows EDR is engaged, not how the marks read against the flames. The headed run also used `?renderer=webgpu` rather than the default and kept no `full` reading. To judge by eye: `subtle` and `full` (the gain cap trims white flame cores to about ×1.28 in subtle and ×1.6 in full; the verified-success cream peak outshines the NEEDS YOU marks for its single frame, as specified); every mark reading brighter than every emitter; and 10.3's P3 role chroma, which headless can only force (the on-screen ΔE_ok check is unmeasured). Harness: `output/waking-isle/HDR/xdr-check.mjs` and `xdr-check.md` (local only).

- [ ] **Real Safari and Firefox runs**

  - **ID:** `OF-018`
  - **Added:** 2026-09-29
  - **Trigger:** WebKit and Firefox builds matching the installed Playwright are available (1.59.1 wants webkit-2272 and firefox-1511), or someone runs the app by hand in Safari and Firefox.
  - **Source:** [Waking Isle plan — 10.1](claudeville-opus55-xhigh-visual-plan.md#101-a-webgpu-backend-behind-the-webgl2-fallback-staged-wpg-3-of-008).
  - **Current status:** Open — unmeasured. Stage B's backend selection (Safari and Firefox default to WebGL2; Safari may opt in with `?renderer=webgpu`) was checked only with a simulated UA with `userAgentData` removed; the installed engines are protocol-incompatible with this Playwright. Unverified in the real engines: the WebGL2 world (and its P3 path, the Firefox default), Safari's WebGPU opt-in (no tone mapping, so it stays SDR) and the HDR setting's copy there.

- [ ] **Art-director carries that need maintainer decisions**

  - **ID:** `OF-019`
  - **Added:** 2026-09-29
  - **Trigger:** A maintainer decision on any of the four points below; none is a Waking Isle item.
  - **Source:** the Waking Isle Phase 2 and Phase 3 art-director reviews (carry lists), against [the plan's guardrails](claudeville-opus55-xhigh-visual-plan.md#guardrails-binding-on-every-item).
  - **Current status:** Open — needs decisions. (1) **Clone-crowd identity:** the `many-waiting` queue is nine identical wizards and clones cluster at the Forge door; the 7.3 strips add motion, not identity, so variety needs a roster or profile variant rule. (2) **Overlay density at z1/z2:** plaques, NEEDS YOU plates, bells, tool chips, name labels and ground status rings all sit on the world plate; a label LOD at z1/z2 that keeps the T1 plates is a V3/V8 guardrail call. (3) **Static z1:** at z1 only bodies, water, the river and the mirror ripple move; 6.1's building parts do not read at that scale. (4) **Night light on volumes:** pools land on floors; walls, roofs and canopies stay unlit and backlit bodies read cold, with the 2.10 ground-radiance bounce pilot off at every level (`6559335`).

- [ ] **Run gait for real urgency (7.5)**

  - **ID:** `OF-020`
  - **Added:** 2026-09-29
  - **Trigger:** The PixelLab reset on 2026-10-09 (the maintainer deferred 7.5 until then for a full skeleton-v3 rollout), or the maintainer asks for it hand-authored.
  - **Source:** [Waking Isle plan — 7.5](claudeville-opus55-xhigh-visual-plan.md#75-run-gait-for-real-urgency-optional-cm-8); pilot evidence `output/waking-isle/RunGait/` (contact sheets at 1×–4×, feet-audit sheets, an in-app WebGPU screencast of a chat run, `tools/`).
  - **Current status:** Open — deferred. On 2026-09-29 a pilot spent **19 generations** (balance 338.6 → 319.6, `pixellab-ledger.jsonl` agent `RunGait`): `running-6-frames` in `template` mode on all 8 facings of `agent.claude.sonnet` (robed) and `agent.codex.gpt55.xhigh` (heavy armour), 16 generations, and one `skeleton-v3` facing (sonnet SE), 3. Template **failed identity**: the robed profile's staff pops in on 4 of 6 SE frames, the robe is redrawn as trousers and white boots on E/W/NW/SW, and the armour's NE cape comes and goes (flicker 0.46–0.54 against a 0.32 cap); the other 7 armour facings read well. Skeleton-v3 **kept identity** (robe, hat and staff steady) with some cloth motion smear, at 3 generations per facing. Nothing shipped: the assets and the runtime match `ee145a3`; the tooling stays.
  - **Rollout recipe:**
    1. **Route:** `node scripts/sprites/generate-pose-strip.mjs --id=<id> --groups=run-skel --directions=<all 8> --item=7.5 --plan`, then without `--plan`. **≈ 24 generations per profile** (3 × 8; 2–4 per facing documented) **≈ 624 for all 26 profiles**, plus ≈ 15 % re-rolls. Skeleton jobs run > 6 min per facing: raise `waitForCharacterAnimation`'s `stallMs` to ~15 min for this mode; a job that trips the guard still completes and bills, so recover it with `--assemble-only` (or `output/waking-isle/RunGait/tools/await-record.mjs`), never by requesting again. `pixellab-spend.mjs` refuses below `GLOBAL_FLOOR` (272).
    2. **Seating (V7):** the template draws the cycle 1–8 px above the rig's ground; `seatGait` drops each facing by one amount so its most grounded frame stands on the base sheet's foot line (anchor `maxY` over rows 0–9) and clamps flight frames to ≤ 2 px lift (`--gait-lift`).
    3. **Audit:** `feet-audit.mjs --groups=run:0-5` gait mode: foot line `dy` and body hop `dx` (head band against the cycle median) within ±2 px, no new fragment ≥ 3 px, and `flicker` (a frame's colour histogram against its cycle, median L1) ≤ max(0.3, 1.5 × the profile's worst walk frame). Also judge the z2 contact sheet by eye: a prop popping in or cloth smear passes the numbers. Frames snap to the profile's sheet palette; the 1-texel rim is baked at runtime.
    4. **Assembly:** `assemble-action-strip.mjs --stage=<id>.run-skel.png --groups=run` appends rows after `gaze` as group `run` and records `provenance.templateStrips` (mode + animation group id per facing); run `author-roster-channels.mjs`, then bump `style.assetVersion`.
    5. **Wiring (proven in the pilot, then removed):** in `AgentSprite`, `_runGaitEligible(speed)` = motion on, `speed === SPEED_RUNGS.at(-1)` (1.5), `chatPartner` or an active intent with `source === 'alert'`, and the resident strip declares `run`. While eligible, `_advanceWalkAnimation` turns a frame per **7.5 px** (`RUN_PIXELS_PER_FRAME`; 5 refreshes at 60 Hz, 10 at 120 Hz). A walk↔run switch keeps the frame index, sets `_strideDistance = frame × px-per-frame` and re-takes the stride phase. The start beat, follow-yield plant and `_resetWalkCycle` clear the run. `_actionStripPose` returns the `run` cell (frame = the stride frame, never a clock) while travelling, so Canvas, WebGL2 and WebGPU sample one cell and `grip.sheathe` parks the Codex weapon. Reduced motion is never eligible (the body still cuts). The speed rules are unchanged: only a WORKING alert or a chat approach reaches the top rung. Measured in app (WebGPU, FULL): every run frame is held exactly 5 rAFs at 1.5 px per refresh. Add the `docs/motion-budget.md` row and a test for 5/10-refresh holds, walk without the intent or strip, and no run under reduced motion.

- [ ] **Activity panel as a world overlay (4.9)**

  - **ID:** `OF-021`
  - **Added:** 2026-09-29
  - **Trigger:** Opening or closing the activity panel hitches (a gap above 2× the latched period in at least 3 of 10 cycles), including on a headed 120 Hz run on the XDR (M24).
  - **Source:** [Waking Isle plan — 4.9](claudeville-opus55-xhigh-visual-plan.md#49-activity-panel-as-an-overlay-with-camera-safe-insets-optional-cc-4-m).
  - **Current status:** Open — conditional, not triggered (recorded in `6559335`). Headless Chromium at `dense-24-agents`, z2, forced FULL, 2560×1440 and 5120×1440: 0/10 open and 0/10 close cycles over 33.3 ms, no long tasks near the events and no black frames; the synchronous render in the ResizeObserver (≤ 11.6 ms at 5120) plus five GPU target reallocations fit one 16.7 ms period. Headless rAF is paced by a synthetic 60 Hz BeginFrame, so GPU-side stalls on the 120 Hz XDR are unmeasured.

- [ ] **A visible Chronicler on every backend**

  - **ID:** `OF-022`
  - **Added:** 2026-09-29
  - **Trigger:** A sprite for the Chronicler is authored or funded (PixelLab or by hand), or the maintainer asks for the errand to be visible again.
  - **Source:** [council enchantment plan — 13](claudeville-council-enchantment-plan.md#13-verified-outcomes-and-the-chroniclers-errand); [Waking Isle plan — Execution record](claudeville-opus55-xhigh-visual-plan.md#execution-record).
  - **Current status:** Open — no body on any backend. The Chronicler had only a Canvas procedural body (robe and staff) that walked over water; the GPU path never drew it. Waking Isle P3 removed it for backend parity (`6559335`: `Chronicler.js` draw path, the `chronicler` kind in `DrawablePass`, the `WorldFrameRenderer` drawables). The errand state (`routeState`, `enqueueEvent`, coalescing, `update`) still runs and its test passes, so §13's intent — a figure at the Archive that walks to a verified monument and back — has logic but no figure. Needs: a sprite (idle, walk, reading), land-only routing (no water tiles on the errand path) and a GPU record so WebGPU, WebGL2 and Canvas draw it alike.

- [ ] **GPU world paths are not in automated gates**

  - **ID:** `OF-023`
  - **Added:** 2026-09-29
  - **Trigger:** A CI runner with a hardware GPU becomes available, or a GPU-only regression reaches `main` unnoticed.
  - **Source:** [Waking Isle plan — 10.1](claudeville-opus55-xhigh-visual-plan.md#101-a-webgpu-backend-behind-the-webgl2-fallback-staged-wpg-3-of-008) and [Execution record](claudeville-opus55-xhigh-visual-plan.md#execution-record).
  - **Current status:** Open. `npm run verify:render` launches plain headless Chromium, which has no WebGPU adapter and a software (SwiftShader) WebGL2, so Stage B's selection gives it the Canvas world: the automated gates render only the Canvas world. CI (`.github/workflows/ci.yml`) runs `validate:full`, which renders no browser frame at all. The WebGPU and WebGL2 resident paths are covered only by `npm run smoke:webgpu-parity` (36 cases at ≤ 1 LSB plus device loss) and `npm run smoke:v3-truth` (no environment pixel reads agent state), which need a real GPU (Chromium with `--use-angle=metal`) and are not in CI.

- [ ] **Frame-cost regressions found by the Phase 5 receipts**

  - **ID:** `OF-024`
  - **Added:** 2026-09-29
  - **Trigger:** A headed session at 5120×1440 or on the 120 Hz XDR stops holding its display rate, or someone next touches the wall/gate prop channels, the batching pager or boot.
  - **Source:** [Waking Isle plan — Receipts (quiet host)](claudeville-opus55-xhigh-visual-plan.md#receipts-quiet-host).
  - **Current status:** Open — measured, not fixed (the maintainer reports a flat 60 FPS in real use and asked to wrap up). Headless, vsync unlocked, forced FULL, dense-24: frame p95 WebGL2 7.4 ms at 1080p and 10.4 ms at 5120, WebGPU 12.6 and 20.9 ms, against the pre-plan 4.8/5.0 ms (p50 4.3/5.9 and 3.9/4.3 ms against 3.7/3.9). The p95 tail is the item to explain first. **B.1b:** dense-100 z1 1080p draws 123 scene batches by day and 131 at night, against 58/61 at the P3 receipt and the plan's ≤ 80; [INFERENCE] the P5 wall and gate props carry their own occluder/emissive canvases (`StaticPropSprite` channels, `sidecarKey` `…:own`), which keeps them off the albedo page and splits batches — page their channels or give the wall runs one shared sidecar atlas. **Boot:** time to first world frame 1838–1901 ms against 1430–1479 ms at `3e0d876` (WebGL2 compile and link 44 ms against 15 ms at P1). **Ladder:** before the M6 default change the flat light walk made MINIMAL costlier than FULL in `gpu-burst`; `light-clusters` is now on at every level, but the per-level re-measure was not run. **B.3:** appRender saving 0.40 ms (WebGPU dense-100 day), below the plan's ≥ 0.5 target. Evidence: `output/waking-isle/Receipts/RECEIPTS-tables.md` (local).

- [ ] **Quiet-host receipts not run in Phase 5**

  - **ID:** `OF-025`
  - **Added:** 2026-09-29
  - **Trigger:** The next quiet-host measurement session, or before claiming the plan's ladder Definition of done.
  - **Source:** [Waking Isle plan — Definition of done](claudeville-opus55-xhigh-visual-plan.md#definition-of-done) and [9.7](claudeville-opus55-xhigh-visual-plan.md#97-calm-dashboard-transitions-d2).
  - **Current status:** Open — stopped at the maintainer's request after the first receipts lane. Not run: the free-ladder 180 s soak (≥ 98 % FULL at 5120×1440 60 Hz, dense-24 and dense-100, OF-011's trigger); the deferred R1 receipts (rain re-price, particle depth, 2.1 A/B against `3e0d876`, 4.1 rest zooms); the post-M6 `gpu-burst` per-level check; the cold-shader-cache boot arm; and the 9.7b View Transition gate (W → D crossfade starting ≤ 150 ms on a quiet host, snapshot memory acceptable) — 9.7b stays unimplemented until it passes. The maintainer reports a flat 60 FPS in daily use with other load on the machine.

## Already landed; do not carry forward as open

- [x] **Re-probe the G95C with HDR on**

  - **ID:** `OF-016`
  - **Added:** 2026-09-29
  - **Last reviewed:** 2026-09-29
  - **Trigger:** The G95C is connected with HDR enabled in macOS.
  - **Source:** [Waking Isle plan — Maintainer decisions, M1](claudeville-opus55-xhigh-visual-plan.md#maintainer-decisions-settled-2026-09-28) and [10.2](claudeville-opus55-xhigh-visual-plan.md#102-tier-h-hdr-highlights-on-the-webgpu-presenter-ch-3).
  - **Reopen when:** The G95C's HDR mode is turned off, or the headroom stops engaging with HDR highlights on.
  - **Current status:** Closed — probed 2026-09-29 after `28ddff3`. `NSScreen` (`color-hdr-screens.swift`): Odyssey G95C, 5120×1440, backing scale 1, 60 Hz, potential EDR 10.15, P3 representable. Headed Chrome (system Chrome, Stage B default WebGPU, `many-waiting` 22:00, window at 5120×1440 DPR 1; Playwright launched without its forced sRGB profile): `dynamic-range: high` true, `color-gamut: p3` true; HDR highlights on → canvas `rgba16float` / `display-p3` / `extended`, EDR headroom 1 → 2.03; setting off → `bgra8unorm` / `standard`, headroom back to 1 within 6 s, and 1 on a fresh page with the setting off. 10.2's acceptance holds on the G95C. The current headroom (2.03) sits below the full mode's 2.5× mark gain, so full-mode marks clip at the panel's headroom while staying above the emitter cap (1.60). Evidence: `output/waking-isle/HDR/g95c-check-{modes,offpoll}.json` (local only).

- [x] **WebGPU backend behind the WebGL2 fallback**

  - **ID:** `OF-008`
  - **Added:** 2026-08-21
  - **Last reviewed:** 2026-09-29
  - **Trigger:** WebGL2 batching, attachment limits, or material passes remain a measured blocker.
  - **Source:** [semantic diorama rendering plan — Package 9](claudeville-semantic-diorama-rendering-plan.md#package-9--conditional-modernization-and-polish); [Waking Isle plan — 10.1](claudeville-opus55-xhigh-visual-plan.md#101-a-webgpu-backend-behind-the-webgl2-fallback-staged-wpg-3-of-008).
  - **Reopen when:** WebGL2 batching, attachment limits, or material passes remain a measured blocker.
  - **Current status:** Closed — landed in `ee145a3` (Waking Isle 10.1 Stage A and B) on the maintainer's M19 decision, because HDR present needs WebGPU, not on this trigger. `gpu/GpuWorldRendererWebGPU.js` renders the same record stream and shared frame state with WGSL twins generated from the GLSL constants; `npm run smoke:webgpu-parity` passes 36/36 at ≤ 1 LSB, device loss included. WebGPU is the default in Chromium with a hardware adapter; Safari is opt-in, Firefox stays on WebGL2, a software rasterizer gets Canvas, and any WebGPU failure falls back to WebGL2. With light records in a storage buffer, `world:gpu-burst` (dense-24, 22:00, FULL) read WebGPU 2.19 vs WebGL2 2.35 ms at 1680 and 4.85 vs 5.02 ms at 4880, on a shared host; the quiet-host receipt of record is still to be taken. Real Safari and Firefox runs are carried as OF-018.

- [x] **Window light that reaches the street (3.3)**

  - **ID:** `OF-010`
  - **Added:** 2026-09-06
  - **Trigger:** The scene-shader apply path for the spill field produces a pixel-measurable warm gain on the Command doorstep; then the C3 protocol (3× 30 s on/off, forced FULL, `dense-24-agents` hour 23) resolves a band inside `[0.4, 1.2]` ms on a quiet host.
  - **Source:** [frontier visual plan — 3.3 window light that reaches the street](claudeville-frontier-visual-plan.md#33-window-light-that-reaches-the-street-pilot-conditional); [Waking Isle plan — 2.1](claudeville-opus55-xhigh-visual-plan.md#21-25d-light-records-and-receivers-lgi-1) and [Maintainer decisions, M6](claudeville-opus55-xhigh-visual-plan.md#maintainer-decisions-settled-2026-09-28).
  - **Current status:** Closed — superseded. M6 (2026-09-28) approved closing OF-010 in favour of the Waking Isle light core, and the plan lists re-landing the spill field as specified as rejected: its field could not reach receivers baked into landmark sprites, and its elevation gate read a row ramp. What landed instead: 2.5D light records, footprint occlusion and the landmark surface channel (2.1–2.3) in `5f4abfe`; aperture lights from the emissive sidecars, whose window light spills down its own face to the street (`APERTURE_SPILL`), with a clustered light list, room-true gates and the warm Command steps (2.4, 2.9) in `6559335`. The `SPILL_FIELD_*` constants left in both resident renderers only reserve bytes in the texture-cache budget.

- [x] **Top-bar centre overflows at 1280 with three attention buckets**

  - **ID:** `OF-014`
  - **Added:** 2026-09-27
  - **Trigger:** A maintainer decision on top-bar density at 1280 (the graphics plan's territory).
  - **Source:** [Opus 5.5 audio plan — Wave 7](claudeville-opus55-audio-plan.md#wave-7--shipped); [Waking Isle plan — 9.1](claudeville-opus55-xhigh-visual-plan.md#91-a-mode-stable-top-bar-and-a-world-camera-dock-fixes-of-014-cu-1-m14).
  - **Current status:** Closed — fixed in `3e0d876` by Waking Isle 9.1 on decision M14, with no responsive shrinking: the camera controls moved out of the bar into a World camera dock, and the bar's gaps and ledger padding went from 16 to 12 px. The phase audit forced wider counts (29/12/11) at 1280×800: `.topbar__center` client = scroll = 591 px, the ledger sits at y = 7 on row 1, there is no document x-scroll and no glyph is cut. Every top-bar control keeps its x (±0 px) across World → Dashboard → World at all 10 viewport/DPR configurations checked (1280, 1440, 1920 and 2560 at DPR 1 and 2, 5120 at DPR 1, 1512×982 at DPR 2), and the dock covered none of 4,424 T1 plates over 2,304 camera layouts.

- [x] **Change-driven Git enrichment:** scoped signatures, cache reuse, nested-remote handling, ref invalidation, and zero-command unchanged warm refresh are implemented. This does not close the async-worker item above.
- [x] **World resource suspension:** Dashboard releases the World canvas, decoded World assets, masks/outlines, and composited agent sheets; World reloads them on a generation-current resume.
- [x] **Bounded Claude parsing:** compact signature-keyed tail/aggregate projections, byte caps, append/guard handling, and concurrency-one async large-file scans are implemented. This does not close the durable-checkpoint/scheduler item above.
- [x] **Measured provider discovery hot paths:** bounded caches, active-first lookups, Kimi’s bounded old-index fallback, and OpenCode’s avoidance of the all-history active-part scan are implemented. This does not close the conditional Phase C cache/index work above.
- [x] **Pressure measurement infrastructure:** process identity, warm-up, rolling slopes, native-resource checkpoints, and the default 10/30-minute soak are implemented and release-verified; only the explicitly pending pre-push gate remains above.
