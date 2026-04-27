# PixelLab Local Docs Optimization — Design

**Date:** 2026-04-27
**Status:** Spec, awaiting user review
**Author:** brainstorming session (Opus 4.7)

## Problem

ClaudeVille is on PixelLab Tier 3 (Pixel Architect, 10,000 generations/month) and uses the service heavily. Coding agents that arrive in this repo to bake or edit sprites currently have:

- A tactical asset runbook (`scripts/sprites/generate.md`) that says *what* to run.
- A 4-step "Sprite Generation" snippet in the root agent docs.
- One project-specific implementation plan (`agents/plans/chardesign-revamp.md`) that encodes a lot of pixellab know-how but is a single revamp's plan, not reference material.
- Two scripts (`generate-pixellab-revamp.mjs`, `generate-character-mcp.mjs`) that demonstrate two different code paths (REST `pixflux` vs MCP `create_character` + ZIP assemble) without saying *when* an agent should pick which.

Gaps confirmed by reading https://www.pixellab.ai/llms.txt, https://www.pixellab.ai/llms-full.txt (3,716 lines), and https://api.pixellab.ai/v2/llms.txt (2,078 lines):

1. **Tool selection.** No local guide says when to call `create_character` vs `pixflux` vs `create_isometric_tile` vs `create_map_object` vs `create_tiles_pro`.
2. **MCP-vs-REST boundary.** The MCP server exposes only the asset-creation subset. ClaudeVille uses both (MCP for characters/overlays, REST for hero buildings >64×64). That decision is not documented.
3. **Parameter enums.** Valid values for `outline`, `shading`, `detail`, `view`, `isometric_tile_shape`, etc. are nowhere in the repo. The legacy script even passes `'highly detailed'` for `detail`, which is not in the documented enum and is silently weakly ignored by `pixflux`.
4. **Animation templates.** Repo only references `walking-6-frames` and `breathing-idle`. The API exposes many more (`attack`, `attack-back`, `backflip`, `bark`, `cross-punch`, `crouched-walking`, …).
5. **Async/job lifecycle.** 202 → poll → 423 (still processing) / 429 (throttled) is not documented locally.
6. **Tier-3 quota awareness.** Agents have no signal about how generous the budget is or when to be cautious.
7. **Pitfalls from official docs.** "Canvas auto-pads ~40% to make room for animations" (explains the existing center-crop in `generate-character-mcp.mjs:108`), "isometric tiles 16-64 with 24+ better", `tile_strength`/`tileset_adherence` knobs, `isometric_tile_shape` semantics — none are captured.
8. **External fetch path.** Agents don't know that `https://api.pixellab.ai/v2/llms.txt` is the shortest authoritative reference for a parameter shape.

## Approach

**Layered documentation** (option B from the brainstorming session), with **comprehensive scope** (option 2):

- One new dense reference doc at `docs/pixellab-reference.md` (300–400 lines).
- Tiny pointer lines in the existing agent docs and the tactical runbook so agents discover the reference when they need it, without bloating canonical context.
- No script changes, no manifest changes, no asset regeneration.

This matches the repo's existing layering convention:
- Root `AGENTS.md`/`CLAUDE.md` = agent map
- `claudeville/CLAUDE.md` = in-app boundary contracts
- `scripts/sprites/generate.md` = tactical commands
- `docs/<topic>.md` = reference / design material

## File plan

| Path | Action | Size delta | Why |
|---|---|---|---|
| `docs/pixellab-reference.md` | Create | +300–400 lines | New comprehensive reference. |
| `scripts/sprites/generate.md` | Edit | +1 line near top | Pointer to the reference doc. |
| `AGENTS.md` | Edit | +1 line | Pointer in the Sprite Generation section. |
| `CLAUDE.md` | Edit | +1 line | Mirror of `AGENTS.md` change. |
| `claudeville/CLAUDE.md` | Edit | +1 line | Pointer in the in-app Sprite Generation block. |
| `README.md` | Edit | +1 row in docs table | Surface the new doc to humans. |
| `agents/plans/chardesign-revamp.md` | Edit | +1 line near top | Back-link to the reference doc so future readers of that plan find the canonical pixellab guide. |

Parity check after edits: `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` must be empty.

## Outline of `docs/pixellab-reference.md`

### 1. When to read this (≈10 lines)
- You're picking a pixellab tool to bake or edit a sprite.
- You're hitting a parameter enum and don't know the valid values.
- You're seeing a 423 / 429 / unexpected ZIP layout.
- You need to know whether to use the MCP server or REST.

### 2. Tier-3 budget (≈10 lines)
- Plan: Pixel Architect (Tier 3), 10,000 generations/month, resets ~25th.
- Headroom is generous (recent month: ~3% utilization). Spend deliberately on quality, not volume; don't over-engineer caching to save 20 generations.
- Cost watch: `create_character` standard mode = 1 gen + ~8 gens for full 8-direction rotation rig; `animate_character` template = 1 gen/direction (8 directions × 6 frames = 8 gens); `pro` modes cost 20–40 gens each. `create_tiles_pro` 20–25 gens depending on size.

### 3. Authoritative external references (≈15 lines)
- https://www.pixellab.ai/llms.txt — compact index (~200 lines).
- https://www.pixellab.ai/llms-full.txt — every doc page inlined (~3.7k lines). Fetch when you need a tool's prose explanation.
- https://api.pixellab.ai/v2/llms.txt — authoritative endpoint signatures (~2k lines). Fetch when you need exact parameter shape, types, and limits.
- Fetch fresh when an MCP call returns an error you don't recognize, or when the parameter set seems wrong: the API evolves and these files are the source of truth.

### 4. MCP vs REST boundary (≈25 lines)
**MCP server (`mcp__pixellab__*`) exposes the asset-creation subset:**
- `create_character` (4 or 8 directions)
- `animate_character` (template, v3, pro modes)
- `create_isometric_tile` (16–64 px)
- `create_map_object` (32–400 px, transparent BG)
- `create_topdown_tileset` (Wang)
- `create_sidescroller_tileset`
- `create_tiles_pro` (hex / hex_pointy / isometric / octagon / square_topdown)
- `get_*` / `list_*` / `delete_*` for each asset type

**Only via REST (`https://api.pixellab.ai/v2/*`):**
- `create-image-pixflux`, `create-image-pixen`, `create-image-bitforge` — general image gen, larger canvases
- `inpaint-v3`, `inpaint`, `edit-image*`, `edit-animation-v2`
- `rotate`, `generate-8-rotations-v2`/`v3`
- `animate-with-text*`, `animate-with-skeleton`, `interpolation-v2`
- `transfer-outfit-v2`, `try-on`, `multi-image`
- `image-to-pixelart`, `resize`, `remove-background`, `unzoom-pixelart`, `reduce-colors`, `reshape`, `re-pose`, `pose-to-image`
- `extend-map*`, `create-map*`, `create-large-image`, `create-texture`, `create-instant-character`
- `create-ui-elements*`, `generate-ui-v2`, `create-sl-image-pro`, `generate-with-style-v2`
- `image-to-image-depth`, `estimate-skeleton`

**Why ClaudeVille uses both:** MCP `create_isometric_tile` caps at 64 px. Hero buildings are up to 400×300 (e.g. `building.watchtower`). For those, `scripts/sprites/generate-pixellab-revamp.mjs` calls REST `create-image-pixflux` directly and reads `PIXELLAB_API_TOKEN` from `.dev.vars`.

### 5. Tool catalog (≈45 lines, table form)
For each MCP tool: input shape (key params), output (sync image / async job_id / character with multiple animations), typical canvas range, generation cost, primary ClaudeVille usage with file references.

### 6. Decision tree (≈30 lines)
"You need to bake X" → which tool + why. Branches:
- New character with directional walk + idle → MCP `create_character` + `animate_character` (templates: walking-6-frames + breathing-idle), then `generate-character-mcp.mjs` to assemble into the 736×920 sheet.
- Hero building (>64 px any side) → REST `create-image-pixflux` via `generate-pixellab-revamp.mjs`. Compose into grid tiles in post.
- Standard building (≤64 px isometric tile) → MCP `create_isometric_tile`.
- Floor ring / status overlay (small isometric icon, transparent BG) → MCP `create_isometric_tile` size 32–64.
- Head accessory overlay (32 px) → MCP `create_isometric_tile`. Use shape language ("vertical pillar", "wreath") to differentiate from rings.
- Terrain transition (Wang) → MCP `create_topdown_tileset` (lower/upper/transition descriptions, tile_size 16 or 32).
- Multi-shape terrain set (hex, octagon, square at angle) → MCP `create_tiles_pro`.
- Map concept image / freeform scene → REST `create-image-pixflux` with `isometric: true`.
- Prop with transparent BG, larger than 64 px → MCP `create_map_object`.

### 7. Async / job lifecycle (≈20 lines)
- All creation endpoints return 202 + a job/character/tile ID; only sync exception is `create-image-pixflux` REST which returns base64 inline.
- Poll cadence: 60s for `create_character` + `animate_character` (a full character rig takes 5–10 min). Faster (10–15s) for tiles and map objects.
- Status codes: 202 = accepted, 200 = ready, 423 = still processing (poll again), 429 = too many concurrent jobs (back off), 402 = insufficient credits.
- Character ZIP: `GET /characters/{id}/zip` returns the full asset bundle (`metadata.json` + `rotations/` + `animations/<anim_id>/<dir>/frame_NNN.png`). MCP `get_character` returns the URLs; `generate-character-mcp.mjs:46` consumes the ZIP layout.

### 8. Parameter reference (≈45 lines)
Exact enums, defaults, and ranges — all extracted from the API llms.txt and verified against the docs/options/* pages.

- `outline`: `single color black outline` | `single color outline` | `selective outline` | `lineless`
- `shading`: `flat shading` | `basic shading` | `medium shading` | `detailed shading` | `highly detailed shading`
- `detail`: `low detail` | `medium detail` | `high detail` (note: `'highly detailed'` is **not** in the enum; it appears in some legacy code but is silently weakly ignored — use `high detail` instead)
- `view`: `side` | `low top-down` | `high top-down`
- `tile_view` (tiles_pro): `top-down` | `high top-down` | `low top-down` | `side`
- `isometric_tile_shape`: `thin tile` (~15% canvas height) | `thick tile` (~25%) | `block` (~50%, default)
- `tile_type` (tiles_pro): `hex` | `hex_pointy` | `isometric` | `octagon` | `square_topdown`
- `transition_size` (tilesets): 0.0 | 0.25 | 0.5 | 0.75 | 1.0
- `text_guidance_scale`: 1.0–20.0, default 8.0
- `init_image_strength`: 1–999. 0–300 = rough color guidance, 300–400 = rough shape, 400–600 = medium, 600–900 = detailed (use when refining nearly-finished art)
- `seed`: integer; 0 = random; reuse a seed to get a near-identical regeneration
- `no_background`: bool; transparent output
- `mode` (create_character 8-directions): `standard` (1 gen) | `pro` (20–40 gens)
- `mode` (animate_character): `template` (1 gen/dir) | `v3` (custom from action_description, frame_count 4–16) | `pro` (20–40 gen/dir, sequential reference-based)

### 9. Animation templates (≈30 lines)
Full enum of `template_animation_id` values, grouped by use case, with one-line descriptions. ClaudeVille's current selections (`walking-6-frames`, `breathing-idle`) marked.

Groups (partial; full list pulled from `https://api.pixellab.ai/v2/llms.txt:675` enum):
- **Idle:** `breathing-idle`, `idle`
- **Walk/run:** `walking-6-frames`, `walking-8-frames`, `running`, `crouched-walking`
- **Attack:** `attack`, `attack-back`, `attack-left`, `attack-right`, `cross-punch`
- **Reaction:** `angry`, `bark`
- **Acrobatic:** `backflip`

Note: the API llms.txt truncates the enum with `...`. At implementation time, fetch `https://api.pixellab.ai/v2/openapi.json` to get the complete list verbatim and tell the reader the doc may lag.

### 10. Style anchor and prompt building (≈25 lines)
- `manifest.yaml` → `style.anchor` is concatenated into every prompt at generation time (handled by `scripts/sprites/generate-pixellab-revamp.mjs:27` and equivalent MCP-path code).
- Encode in the **prompt**: subject identity, accessories, color cues, silhouette intent, scale relative to a known referent.
- Encode as **parameters** (don't repeat in prompt): outline, shading, detail, view, isometric, no_background, transparent — these are weakly model-guided when in prompt and strongly model-guided as parameters.
- Watch out for prompt → param redundancy: passing `view: 'low top-down'` AND `'low top-down isometric view'` in the description over-weights the cue and can saturate the result.
- Negative description: short and concrete ("no text, no logo, no UI"). Long negatives can pull the model in unexpected directions.

### 11. Pitfalls catalog (≈30 lines)
1. **Character canvas auto-pads ~40%.** `create_character` with `width: 64` returns a ~90×90 source frame. `generate-character-mcp.mjs:108` center-crops back to 92×92. Don't fight this; rely on the crop.
2. **Isometric tiles cap at 64.** Above 64 px you must use `create-image-pixflux` (REST) or `create_map_object` (MCP, 32–400 px, but not "isometric tile" model).
3. **Tile sizes <24 px give weaker results** even though 16 is allowed. Prefer 32+ for production assets.
4. **`'highly detailed'` for `detail` is undocumented.** Pass `high detail` (canonical enum). The pixflux endpoint won't error, but the cue is weakly applied.
5. **Background bleed.** `create-image-pixflux` with `no_background: true` can return near-transparent gray pixels at edges. The revamp script handles this with `keyOutEdgeBackground` + `trimAlphaFringe`. Re-use that logic when writing new REST callers.
6. **MCP returns a job, REST returns the image.** Plan async polling for MCP and synchronous handling for REST. Don't mix patterns.
7. **`isometric_tile_shape` defaults to `block`.** That gives ~50% canvas height of "depth" and clips small icons. For overlays and floor rings, pass `thin tile` explicitly.
8. **Direction set must match across `create_character` and `animate_character`.** If create was 8-directional, animate must request the same 8 directions, or you get incomplete sheets.
9. **Cache busting.** When PNGs change, bump `style.assetVersion` in `manifest.yaml`. Browsers cache aggressively; agents should never claim "the change is live" without confirming the version bump.
10. **Response wrapper shape varies.** `create-image-pixflux` returns 200 sync, but the API standard wrapper is `{ success, data, error, usage }` and image data lands at `data.image` or `data.images[0]` depending on endpoint. `generate-pixellab-revamp.mjs:320` reads `json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0]` to handle all variants. Re-use that fallback chain for new REST callers.

### 12. Existing repo scripts (≈15 lines, table)
| Script | Path used | Authentication | When to invoke |
|---|---|---|---|
| `scripts/sprites/generate-pixellab-revamp.mjs` | REST `/v2/create-image-pixflux` | `.dev.vars` → `PIXELLAB_API_TOKEN` | Hero buildings (>64 px any side), map concept, character sheets when MCP is unavailable |
| `scripts/sprites/generate-character-mcp.mjs` | MCP ZIP assembly only (you call MCP first) | Inherits from MCP server (token in MCP config) | After `mcp__pixellab__create_character` + `animate_character` complete, to assemble into 736×920 sheet |
| `scripts/sprites/manifest-validator.mjs` | none (filesystem) | n/a | After any sprite change. `npm run sprites:validate`. |

### 13. Smoke recipes (≈25 lines)
Three copy-pasteable sequences:
1. **MCP isometric tile smoke:** `mcp__pixellab__create_isometric_tile` → `mcp__pixellab__get_isometric_tile` poll → `curl --fail` download.
2. **MCP character bake smoke:** `create_character` → poll `get_character` for `progress: 100` → `animate_character` (`walking-6-frames`) → `animate_character` (`breathing-idle`) → poll until both complete → download ZIP via `/characters/{id}/zip` → `node scripts/sprites/generate-character-mcp.mjs --id=<id> --zip=<path>`.
3. **REST pixflux smoke:** single `curl -X POST` against `https://api.pixellab.ai/v2/create-image-pixflux` with bearer token, parse `image.base64`, save with `--fail`.

### 14. Known issues / TODO (≈10 lines)
Captured for future agents who hit the same friction:
- MCP `create_character` + `animate_character` polling is currently manual (call `get_character` every 60s). A small helper that polls and writes the ZIP path on completion would remove a tedious step from every character bake.
- `generate-pixellab-revamp.mjs` and the MCP character path duplicate the style anchor logic. If a third path is added, factor the anchor-prepend into a shared utility.
- The `detail` enum is documented as `low/medium/high` but the legacy script passes `'highly detailed'`. Decide whether to (a) update the script to canonical values or (b) verify empirically that the legacy string still produces the desired effect, and document the choice.
- No automated check that on-disk PNG dimensions match the manifest `size` field. `manifest-validator.mjs` checks existence and the character sheet motion contract, not arbitrary sizes.

### 15. Glossary (≈15 lines)
Short definitions:
- **PixFlux** — primary text-to-image model, larger canvases, weak text-guidance.
- **BitForge** — small-medium image model with style transfer support.
- **Pixen** — newer image model, default `highly detailed` detail level.
- **Wang tileset** — 16- or 23-tile arrangement that connects in any direction. Output of `create_topdown_tileset` and `create_sidescroller_tileset`.
- **Dual-grid 15-tileset** — alternative tileset packing exposed by `create-tileset`.
- **Oblique projection** — non-isometric angled projection (Tibia-style).
- **Isometric (PixelLab semantics)** — true isometric (120° axes); use `view: 'low top-down', isometric: true` for the ClaudeVille look.
- **Tier-3 / Pixel Architect** — current subscription. 10,000 generations/month.

## What this design deliberately omits

- Aseprite / Pixelorama plugin instructions.
- Marketing fluff ("vibe coding").
- Pricing / refund / Steam policy.
- Detailed prose for tools the MCP doesn't expose AND ClaudeVille doesn't use via REST. Those get one line in §4 with a pointer to the API llms.txt; reproducing them locally would rot.
- Worked example prompts for every manifest entry. The manifest itself is the source of truth for prompts; the reference doc explains the *grammar* of a good prompt, not specific incantations.

## Success criteria

1. An agent landing in this repo with a "bake a new prop sprite" or "regenerate the watchtower" task can pick the right tool from the decision tree without external fetches.
2. An agent debugging a 423 / 429 / unexpected ZIP layout can resolve it from the async section without external fetches.
3. The reference doc holds up against the official llms.txt for at least the next API release cycle (no deep coupling to specific endpoint paths beyond what's stable).
4. `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` stays empty.
5. The reference doc's parameter enums match `https://api.pixellab.ai/v2/llms.txt` at write time. A note tells future maintainers to re-verify.

## Decisions resolved during review

- Back-link `agents/plans/chardesign-revamp.md` to the new reference doc (one line near top).
- Include a "Known issues / TODO" tail (§14) capturing manual polling, anchor-logic duplication, `detail` enum discrepancy, and dimension validation gap.
- ~350 lines is acceptable; no length cut required.
