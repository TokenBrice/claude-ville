# PixelLab Local Docs Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a comprehensive `docs/pixellab-reference.md` plus surgical pointer edits in agent docs so future agents can pick the right pixellab tool, format calls correctly, and recover from common errors without external fetches.

**Architecture:** One new dense reference doc, six one-line pointer edits in existing files, one verification gate. No script changes, no manifest changes, no asset regeneration.

**Tech Stack:** Markdown only. Validation via `diff`, `grep`, `wc`, and `npm run sprites:validate`.

**Spec:** `docs/superpowers/specs/2026-04-27-pixellab-docs-design.md`

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `docs/pixellab-reference.md` | Create | Comprehensive pixellab reference: tool catalog, decision tree, params, async lifecycle, animation templates, prompt grammar, pitfalls, smoke recipes. |
| `scripts/sprites/generate.md` | Edit (+1 line) | Tactical runbook gains a pointer to the reference doc. |
| `AGENTS.md` | Edit (+1 line) | Sprite Generation section gains a pointer. |
| `CLAUDE.md` | Edit (+1 line) | Mirror of AGENTS.md. |
| `claudeville/CLAUDE.md` | Edit (+1 line) | In-app Sprite Generation section gains a pointer. |
| `README.md` | Edit (+1 row in docs table) | Surface to humans browsing the repo. |
| `agents/plans/chardesign-revamp.md` | Edit (+1 line near top) | Frozen plan back-links to current canonical reference. |

---

## Task 1: Create the reference doc

**Files:**
- Create: `docs/pixellab-reference.md`

- [ ] **Step 1: Write the file with the complete content shown below**

Use the Write tool. The exact content (including the trailing newline) is:

````markdown
# PixelLab Reference for ClaudeVille Agents

## When to read this

- You are picking a pixellab tool to bake or edit a sprite and the choice is not obvious.
- You hit a parameter enum (`outline`, `shading`, `detail`, `view`, `isometric_tile_shape`, `tile_type`) and need the valid values.
- You see an unfamiliar HTTP status (423, 429) or an unexpected ZIP layout and need to know what's normal.
- You need to know whether a capability lives in the MCP server or only in the REST API.

For tactical "how do I run the validation script" questions, stay in `scripts/sprites/generate.md`. For the pixellab subscription / quota question, see the next section.

## Tier-3 budget

ClaudeVille is on **Tier 3 (Pixel Architect)**: 10,000 generations per month, resets near the 25th. Recent utilization runs around 3%, so headroom is generous. Spend deliberately on quality, not volume — do not over-engineer caching to save twenty generations.

Approximate cost per asset family (so an agent can sanity-check before kicking off a bulk bake):

| Operation | Cost |
| --- | --- |
| `create_character` standard mode (8 directions) | ~1 generation + ~8 for the rotation rig |
| `create_character` pro mode | 20–40 generations |
| `animate_character` template mode (per animation, full 8-direction rig) | 8 generations × frames per direction (e.g. walking-6-frames = 8 gens) |
| `animate_character` v3 mode | depends on `frame_count` (4–16) |
| `animate_character` pro mode | 20–40 generations per direction |
| `create_isometric_tile` | 1–2 generations |
| `create_tiles_pro` | 20 (small/medium) or 25 (larger sizes) |
| `create_topdown_tileset` / `create_sidescroller_tileset` | 16 tiles or 23 with full transition |
| `create_map_object` | 1 generation |
| REST `create-image-pixflux` | 1 generation |

A full ClaudeVille character revamp (6 characters × create + 2 animations) lands around 100 generations. A full sprite refresh including buildings, overlays, and terrain is well under 500.

## Authoritative external references

When the local doc is silent or stale, fetch directly. The official files are LLM-friendly and small.

| URL | Size | Use it for |
| --- | --- | --- |
| `https://www.pixellab.ai/llms.txt` | ~200 lines | First orientation; index of every doc page and tool. |
| `https://www.pixellab.ai/llms-full.txt` | ~3,700 lines | Full prose for every tool when you need behavioral nuance. |
| `https://api.pixellab.ai/v2/llms.txt` | ~2,000 lines | Endpoint signatures, parameter shapes, status codes. |
| `https://api.pixellab.ai/v2/openapi.json` | ~250 KB JSON | Machine-readable schema. The llms.txt enums sometimes truncate with `...`; OpenAPI is the source of truth. |
| `https://www.pixellab.ai/create-character` (browser) | n/a | Live `template_animation_id` dropdown when the documented enum is incomplete. |

Re-fetch when an MCP call returns an error you do not recognize, when a parameter set seems wrong, or when a capability you remember is not visible.

## MCP vs REST boundary

The pixellab MCP server (configured via `claude mcp add --transport http pixellab https://api.pixellab.ai/mcp --header "Authorization: Bearer YOUR_TOKEN"`) exposes a curated **asset-creation** subset. ClaudeVille uses both surfaces.

**Available via MCP (`mcp__pixellab__*`):**

| Tool | Purpose | Canvas range |
| --- | --- | --- |
| `create_character` | 4- or 8-direction character | 16-128 px (canvas auto-pads ~40%) |
| `animate_character` | Animate an existing character (template / v3 / pro) | inherits character size |
| `create_isometric_tile` | Single isometric tile | 16-64 px (24+ recommended) |
| `create_map_object` | Transparent-BG prop | 32-400 px |
| `create_topdown_tileset` | Wang tileset for top-down terrain | 16 or 32 px tiles |
| `create_sidescroller_tileset` | Sidescroller platform tileset | 16 or 32 px tiles |
| `create_tiles_pro` | Multi-shape tile grid (hex / hex_pointy / isometric / octagon / square_topdown) | 16-256 px tiles |
| `get_*` / `list_*` / `delete_*` | One per asset family above | n/a |

**Only via REST (`https://api.pixellab.ai/v2/*`):**

- General image generation: `create-image-pixflux`, `create-image-pixen`, `create-image-bitforge`, `generate-image-v2`, `generate-with-style-v2`, `generate-ui-v2`
- Edit / inpaint: `inpaint-v3`, `inpaint`, `edit-image`, `edit-images-v2`, `edit-animation-v2`
- Rotate: `rotate`, `generate-8-rotations-v2`, `generate-8-rotations-v3`
- Animate (non-character): `animate-with-text`, `animate-with-text-v2`, `animate-with-text-v3`, `animate-with-skeleton`, `interpolation-v2`, `estimate-skeleton`
- Outfit / pose / image ops: `transfer-outfit-v2`, `try-on`, `multi-image`, `pose-to-image`, `re-pose`, `reshape`, `resize`, `remove-background`, `image-to-pixelart`, `image-to-image-depth`, `unzoom-pixelart`, `reduce-colors`
- Maps: `create-map`, `create-map-new`, `extend-map`, `extend-map-v2`, `create-large-image`, `create-texture`
- Other: `create-instant-character`, `create-ui-elements`, `create-ui-elements-pro`, `create-sl-image-pro`, `create-character-with-4-directions`, `create-character-with-8-directions` (the MCP `create_character` wraps these last two)

**Why ClaudeVille uses both:** MCP `create_isometric_tile` caps at 64 px. Hero buildings such as `building.watchtower` (400×300) need REST `create-image-pixflux`. `scripts/sprites/generate-pixellab-revamp.mjs` calls REST directly and reads `PIXELLAB_API_TOKEN` from `.dev.vars`.

## Tool catalog

Per-tool quick reference. Inputs list the most-used parameters, not every option. See `https://api.pixellab.ai/v2/llms.txt` for full parameter shapes.

### `create_character`

- Inputs: `description`, `name`, `image_size` (16-128 width/height), `n_directions` (4 or 8), `view`, `outline`, `shading`, `detail`, `mode` (`standard` / `pro`), `proportions`, `template_id` (`mannequin` for humanoid; `bear`/`cat`/`dog`/`horse`/`lion` for quadrupeds), `seed`.
- Output: `character_id` + URLs for the 4 or 8 rotation images. **Async.**
- Canvas auto-pads ~40% — request `92` and the source frame is ~128. Crop in post.
- Repo usage: ClaudeVille agent characters in `claudeville/assets/sprites/characters/agent.*/sheet.png`.

### `animate_character`

- Inputs: `character_id`, `template_animation_id` (template mode), `action_description` + `frame_count` (v3 mode), `mode` (`template` / `v3` / `pro`), `directions` (defaults to all character directions in template mode, south only in custom).
- Output: per-direction frame URLs attached to the character record. **Async.**
- Repo usage: walking + idle animations applied to each character; assembly handled by `scripts/sprites/generate-character-mcp.mjs`.

### `create_isometric_tile`

- Inputs: `description`, `image_size` (16-64 px), `isometric_tile_shape` (`thin tile` / `thick tile` / `block`, default `block`), `outline`, `shading`, `detail`, `init_image`, `init_image_strength`, `seed`.
- Output: tile image. **Async.**
- Repo usage: floor rings, status overlays, head accessories. Pass `thin tile` for icons; `block` clips small assets.

### `create_map_object`

- Inputs: `description`, `image_size` (32-400 px, max area 400×400 basic / 192×192 with inpainting), `view` (default `high top-down`), `outline`, `shading`, `detail`, `init_image`, `background_image` (style match), `inpainting`.
- Output: object image with transparent background. **Async.**
- Repo usage: not currently active. Consider when a prop exceeds 64 px and needs transparency.

### `create_topdown_tileset`

- Inputs: `lower_description`, `upper_description`, `transition_description`, `tile_size` (16 or 32), `transition_size` (0.0 / 0.25 / 0.5 / 0.75 / 1.0), `view` (`low top-down` / `high top-down`), `outline`, `shading`, `detail`, references for `lower`/`upper`/`transition`/`color`.
- Output: 16 tiles (no transition) or 23 tiles (full transition) as a Wang set. **Async.**
- Repo usage: terrain tilesets in `claudeville/assets/sprites/terrain/`.

### `create_sidescroller_tileset`

- Same shape as topdown, plus `transition_description` describes a top decorative layer (moss, snow). No `upper_description`.
- Repo usage: not currently active.

### `create_tiles_pro`

- Inputs: `description`, `tile_type` (`hex` / `hex_pointy` / `isometric` / `octagon` / `square_topdown`), `tile_size` (16-256, default 32), `tile_height` (non-square), `tile_view` (or `tile_view_angle` 0-90 + `tile_depth_ratio` 0.0-1.0), `style_images` (1-4 reference tiles).
- Output: tile grid. **Async.** Cost 20-25 generations.
- Repo usage: not currently active. Use when terrain needs hex / octagon variants.

## Decision tree

You need to bake or edit X. Use this branching:

- **New character with directional walk + idle:** MCP `create_character` (size 92, n_directions 8, view `low top-down`, detail `medium detail`, shading `basic shading`, outline `single color black outline`) → `animate_character` template `walking-6-frames` → `animate_character` template `breathing-idle` → poll `get_character` until both at 100% → download ZIP → `node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path>`.
- **Hero building (>64 px any side):** REST `create-image-pixflux` via `scripts/sprites/generate-pixellab-revamp.mjs`. Compose into grid tiles in post (the script does this for `kind: hero` entries).
- **Standard building (≤64 px isometric tile):** MCP `create_isometric_tile` size 32-64, `isometric_tile_shape: thick tile` for buildings or `block` for chunky landmarks.
- **Floor ring / status overlay (small isometric icon, transparent BG):** MCP `create_isometric_tile` size 32-64, `isometric_tile_shape: thin tile`. Use shape language in the description ("single-band ring", "triple-band").
- **Head accessory overlay (32 px, on top of head):** MCP `create_isometric_tile` size 32, `isometric_tile_shape: thin tile`. Differentiate with explicit shape words ("vertical pillar", "wreath", "halo") so overlays read distinctly at small size.
- **Terrain transition (Wang):** MCP `create_topdown_tileset` with `lower_description` + `upper_description` + optional `transition_description`. Pick `tile_size: 32` for 24+px legibility.
- **Multi-shape terrain set (hex, octagon, square at angle):** MCP `create_tiles_pro`. Use `tile_view_angle` for fine control.
- **Map concept image / freeform scene:** REST `create-image-pixflux` with `isometric: true`, `view: 'low top-down'`. Used in `generate-pixellab-revamp.mjs` for the town concept.
- **Prop with transparent BG, larger than 64 px:** MCP `create_map_object`.
- **Edit/inpaint an existing PNG:** REST only. Decide whether the cost of a one-off REST call is worth it vs. regenerating from scratch.

## Async / job lifecycle

All MCP creation tools and their REST equivalents at `v2/*` return **202 Accepted** with a job, character, or tile ID. Only sync exception: REST `create-image-pixflux` / `pixen` / `bitforge` return 200 with image data inline.

Status codes:

- **200** — ready, payload available
- **202** — accepted, processing
- **423** — locked, still processing → poll again
- **429** — too many concurrent jobs → back off and retry
- **402** — insufficient credits (rare on Tier 3 but possible)
- **422** — validation error (parameter shape wrong)
- **529** — rate limit exceeded (long-window cap, back off longer)

Poll cadence:

- Characters and full animation rigs: every 60s; full bake takes 5–10 min.
- Isometric tiles, map objects, single-image jobs: every 10–15s.

Character ZIP layout (verified 2026-04-28 in `scripts/sprites/generate-character-mcp.mjs`):

```
metadata.json
rotations/<dir>.png                                         (S × S, S = source canvas)
animations/animating-<uuid>/<dir>/frame_NNN.png             (S × S each)
```

`metadata.json` has a `frames.animations[<anim_id>][<dir>]` map of frame paths. Identify walk vs idle by frame count (6 frames = walk, 4 frames = idle in the current ClaudeVille rig).

## Parameter reference

Exact enums and ranges. Source: `https://api.pixellab.ai/v2/llms.txt` and the `docs/options/*` pages, verified 2026-04-27.

| Parameter | Values / range | Notes |
| --- | --- | --- |
| `outline` | `single color black outline` \| `single color outline` \| `selective outline` \| `lineless` | Strong as param; weak in description. |
| `shading` | `flat shading` \| `basic shading` \| `medium shading` \| `detailed shading` \| `highly detailed shading` | More shading = more colors used. |
| `detail` | `low detail` \| `medium detail` \| `high detail` | `'highly detailed'` is **not** a documented enum value. Use `high detail`. |
| `view` | `side` \| `low top-down` \| `high top-down` | ClaudeVille uses `low top-down`. |
| `tile_view` (tiles_pro) | `top-down` \| `high top-down` \| `low top-down` \| `side` | `top-down` = no depth, `low top-down` ≈ 30%. |
| `isometric_tile_shape` | `thin tile` (~15%) \| `thick tile` (~25%) \| `block` (~50%, default) | Floor rings and overlays need `thin tile`. |
| `tile_type` (tiles_pro) | `hex` \| `hex_pointy` \| `isometric` \| `octagon` \| `square_topdown` | Default `isometric`. |
| `transition_size` (tilesets) | 0.0 \| 0.25 \| 0.5 \| 0.75 \| 1.0 | 0.0 = no transition (16 tiles), 1.0 = full transition (23 tiles). |
| `text_guidance_scale` | 1.0 – 20.0, default 8.0 | Higher = more literal; over-saturation past ~12. |
| `init_image_strength` | 1 – 999 | 0–300 rough color, 300–400 rough shape, 400–600 medium, 600–900 detailed (use when refining nearly-finished art). |
| `seed` | integer; 0 = random | Reuse a seed to get a near-identical regeneration. |
| `no_background` | bool | Transparent output. Saying "transparent background" in the prompt is redundant. |
| `mode` (`create_character` 8-dir) | `standard` (1 gen) \| `pro` (20–40 gens) | Pro ignores outline/shading/detail/proportions/text_guidance_scale. |
| `mode` (`animate_character`) | `template` (1 gen/dir) \| `v3` (custom from `action_description`, `frame_count` 4–16) \| `pro` (20–40 gen/dir) | Auto-detected: template if `template_animation_id` provided, else v3. |
| `direction` (camera) | `north` \| `north-east` \| `east` \| `south-east` \| `south` \| `south-west` \| `west` \| `north-west` | Weak guidance; pair with init image for reliability. |

## Animation templates

Known `template_animation_id` values, confirmed across docs and repo as of 2026-04-27. The API documentation truncates the enum with `...`; for the complete current list, open `https://www.pixellab.ai/create-character` and read the animation dropdown.

| Group | Templates | ClaudeVille usage |
| --- | --- | --- |
| Idle | `breathing-idle` | active (rows 6–9 in character sheet) |
| Walk / run | `walking-4-frames`, `walking-6-frames`, `crouched-walking` | `walking-6-frames` active (rows 0–5) |
| Attack | `attack`, `attack-back`, `attack-left`, `attack-right`, `cross-punch` | unused |
| Reaction | `angry`, `bark` | unused |
| Acrobatic | `backflip` | unused |

`animate_character` modes:

- `template` — skeleton-based from `template_animation_id`, 1 generation per direction, fastest path. **Default for ClaudeVille.**
- `v3` — custom animation from `action_description` text + `frame_count` (4–16, even).
- `pro` — generates directions sequentially using completed sides as reference, 20–40 generations per direction, highest quality.

## Style anchor and prompt building

The `manifest.yaml` `style.anchor` field is concatenated into every generation prompt at call time (handled by `scripts/sprites/generate-pixellab-revamp.mjs:27` for REST and equivalent code on the MCP path). It locks the visual tone; do not duplicate its content into per-asset prompts.

**Encode in the prompt (description):**

- Subject identity: who or what this is.
- Distinctive accessories or props.
- Color cues that must override the palette ("amber robe", not just "robe").
- Silhouette intent: "tall reads from far zoom", "square stocky stance".
- Negative cues only when the model has a known failure mode for that asset.

**Encode as parameters (do not also put in the description):**

- `outline`, `shading`, `detail` — strong when set as params, weak when in description.
- `view`, `direction`, `isometric` — same.
- `no_background` — sets transparency. Saying "transparent background" in the description is redundant.

Watch for redundancy: passing `view: 'low top-down'` together with `'low top-down isometric view'` in the description over-weights the cue and can saturate the result. Pick one channel for each concept.

Keep negative descriptions short and concrete: `"no text, no logo, no UI"` works; long lists of forbidden things can pull the model in unexpected directions.

## Pitfalls

1. **Character canvas auto-pads ~40%.** `create_character` with `width: 64` returns a ~90×90 source frame. `scripts/sprites/generate-character-mcp.mjs:108` center-crops back to 92×92. Don't fight this; rely on the crop.
2. **Isometric tiles cap at 64 px.** Above 64 px you must use REST `create-image-pixflux` or MCP `create_map_object` (32–400 px, but not the isometric tile model).
3. **Tile sizes <24 px give weaker results** even though 16 is allowed. Prefer 32+ for production assets.
4. **`'highly detailed'` for `detail` is undocumented.** Pass `high detail` (canonical enum). The pixflux endpoint will not error on the wrong value, but the cue is silently weakly applied.
5. **Background bleed.** REST `create-image-pixflux` with `no_background: true` can return near-transparent gray pixels at edges. `generate-pixellab-revamp.mjs` handles this with `keyOutEdgeBackground` + `trimAlphaFringe`. Re-use that logic when writing new REST callers.
6. **MCP returns a job; REST `pixflux` returns the image.** Plan async polling for MCP and synchronous handling for REST. Don't mix patterns.
7. **`isometric_tile_shape` defaults to `block`.** That gives ~50% canvas height of "depth" and clips small icons. For overlays and floor rings, pass `thin tile` explicitly.
8. **Direction set must match across `create_character` and `animate_character`.** If create was 8-directional, animate must request the same 8 directions, or the sheet is incomplete.
9. **Cache busting.** When PNGs change, bump `style.assetVersion` in `manifest.yaml`. Browsers cache aggressively; agents should never claim "the change is live" without confirming the version bump.
10. **Response wrapper shape varies.** The API standard wrapper is `{ success, data, error, usage }` and image data lands at `data.image` or `data.images[0]` depending on endpoint. `generate-pixellab-revamp.mjs:320` reads `json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0]` to handle all variants. Re-use that fallback chain for new REST callers.

## Existing repo scripts

| Script | Path used | Authentication | When to invoke |
| --- | --- | --- | --- |
| `scripts/sprites/generate-pixellab-revamp.mjs` | REST `/v2/create-image-pixflux` | `.dev.vars` → `PIXELLAB_API_TOKEN` | Hero buildings (>64 px any side), map concept, character sheets when MCP is unavailable. |
| `scripts/sprites/generate-character-mcp.mjs` | MCP ZIP assembly only (you call MCP first) | Inherits from MCP server (token in MCP config) | After `mcp__pixellab__create_character` + `animate_character` complete, to assemble into the 736×920 sheet. |
| `scripts/sprites/manifest-validator.mjs` | None (filesystem) | n/a | After any sprite change. `npm run sprites:validate`. |

## Smoke recipes

### MCP isometric tile

```text
1. mcp__pixellab__create_isometric_tile(
     description="<style anchor>, <subject>",
     image_size={"width": 32, "height": 32},
     isometric_tile_shape="thin tile",
     outline="single color black outline",
     shading="medium shading",
     detail="high detail",
   )
   → returns tile_id
2. Poll mcp__pixellab__get_isometric_tile(tile_id) until ready (typically <30s)
3. curl --fail -o claudeville/assets/sprites/.../<id>.png "<image_url_from_response>"
4. file <path>   # confirm PNG dimensions
5. npm run sprites:validate
```

### MCP character bake

```text
1. mcp__pixellab__create_character(
     description="<style anchor>, <character description>",
     name="<sprite-id>",
     image_size={"width": 92, "height": 92},
     n_directions=8,
     view="low top-down",
     detail="medium detail",
     shading="basic shading",
     outline="single color black outline",
   )
   → returns character_id
2. mcp__pixellab__animate_character(
     character_id=<id>,
     template_animation_id="walking-6-frames",
   )
3. mcp__pixellab__animate_character(
     character_id=<id>,
     template_animation_id="breathing-idle",
   )
4. Poll mcp__pixellab__get_character(<id>) every 60s until both animations
   show progress: 100 (5–10 min total).
5. Download character ZIP from the /characters/{id}/zip URL in the response.
6. node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path>
7. file claudeville/assets/sprites/characters/<sprite-id>/sheet.png   # 736×920
8. npm run sprites:validate
```

### REST pixflux

```bash
curl --fail -X POST https://api.pixellab.ai/v2/create-image-pixflux \
  -H "Authorization: Bearer $PIXELLAB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "<style anchor>, <subject>",
    "image_size": {"width": 96, "height": 96},
    "no_background": true,
    "isometric": true,
    "view": "low top-down",
    "outline": "single color black outline",
    "shading": "medium shading",
    "detail": "high detail",
    "seed": 12345
  }' | jq -r '.image.base64 // .data.image.base64' | base64 -d > out.png
```

For the full revamp script that handles edge-color cleanup and grid composition, see `scripts/sprites/generate-pixellab-revamp.mjs`.

## Known issues / TODO

- MCP `create_character` + `animate_character` polling is currently manual (call `get_character` every 60s). A small helper that polls and writes the ZIP path on completion would remove a tedious step from every character bake.
- `generate-pixellab-revamp.mjs` and the MCP character path duplicate the style-anchor logic. If a third path is added, factor the anchor-prepend into a shared utility.
- The `detail` enum is documented as `low detail` / `medium detail` / `high detail`, but `generate-pixellab-revamp.mjs` passes `'highly detailed'`. Decide whether to (a) update the script to canonical values or (b) verify empirically that the legacy string still produces the desired effect, and document the choice.
- No automated check that on-disk PNG dimensions match the manifest `size` field. `manifest-validator.mjs` checks existence and the character sheet motion contract, not arbitrary sizes.

## Glossary

- **PixFlux** — primary text-to-image model, larger canvases up to 400×400, weak text-guidance.
- **BitForge** — small-medium image model (max 200 px) with style-transfer support.
- **Pixen** — newer image model, default `highly detailed` detail level (the only place that string is canonical).
- **Wang tileset** — 16- or 23-tile arrangement that connects in any direction. Output of `create_topdown_tileset` and `create_sidescroller_tileset`.
- **Dual-grid 15-tileset** — alternative tileset packing exposed by `create-tileset`.
- **Oblique projection** — non-isometric angled projection (Tibia-style); not used in ClaudeVille.
- **Isometric (PixelLab semantics)** — true isometric (120° axes); set `view: 'low top-down', isometric: true` for the ClaudeVille look.
- **Tier-3 / Pixel Architect** — current subscription. 10,000 generations/month.
````

- [ ] **Step 2: Verify the file exists and is the expected length**

```bash
test -f docs/pixellab-reference.md && wc -l docs/pixellab-reference.md
```

Expected: line count between 230 and 360. If outside, re-check the content against this plan.

- [ ] **Step 3: Verify all script line citations resolve**

```bash
sed -n '27,38p' scripts/sprites/generate-pixellab-revamp.mjs | head -1
sed -n '320p' scripts/sprites/generate-pixellab-revamp.mjs
sed -n '108,113p' scripts/sprites/generate-character-mcp.mjs | head -1
```

Expected:
- Line 27 of `generate-pixellab-revamp.mjs`: `const STYLE = [`
- Line 320 of `generate-pixellab-revamp.mjs` contains `json?.image || json?.data?.image`
- Line 108 of `generate-character-mcp.mjs`: `// Center-crop a CELL×CELL window from a SOURCE×SOURCE frame.`

If any line drifts, update the corresponding citation in the doc.

- [ ] **Step 4: Stage but do not commit yet**

```bash
git add docs/pixellab-reference.md
```

---

## Task 2: Pointer in `scripts/sprites/generate.md`

**Files:**
- Modify: `scripts/sprites/generate.md` (insert one paragraph after the existing intro on line 3)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with these exact strings:

`old_string`:
```
# ClaudeVille Sprite Asset Runbook

This runbook covers the current manifest-first sprite workflow for ClaudeVille. It replaces older fixed asset-count plans: always trust `claudeville/assets/sprites/manifest.yaml` over hardcoded IDs in old notes.

## Sources Of Truth
```

`new_string`:
```
# ClaudeVille Sprite Asset Runbook

This runbook covers the current manifest-first sprite workflow for ClaudeVille. It replaces older fixed asset-count plans: always trust `claudeville/assets/sprites/manifest.yaml` over hardcoded IDs in old notes.

For tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`docs/pixellab-reference.md`](../../docs/pixellab-reference.md).

## Sources Of Truth
```

- [ ] **Step 2: Verify**

```bash
grep -c "docs/pixellab-reference.md" scripts/sprites/generate.md
```

Expected: `1`

- [ ] **Step 3: Stage**

```bash
git add scripts/sprites/generate.md
```

---

## Task 3: Pointer in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (extend the `## Sprite Generation` block with a closing reference paragraph)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with these exact strings:

`old_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets.
The `style.assetVersion` field is used as a cache-busting query string by `AssetManager`; bump it when changing sprite PNGs that browsers may cache.
```

`new_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets.
The `style.assetVersion` field is used as a cache-busting query string by `AssetManager`; bump it when changing sprite PNGs that browsers may cache.

For pixellab tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`docs/pixellab-reference.md`](docs/pixellab-reference.md).
```

- [ ] **Step 2: Verify**

```bash
grep -c "docs/pixellab-reference.md" AGENTS.md
```

Expected: `1`

- [ ] **Step 3: Stage**

```bash
git add AGENTS.md
```

---

## Task 4: Mirror the change into `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (apply the identical edit so parity is preserved)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with the **same** `old_string` and `new_string` as Task 3.

`old_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets.
The `style.assetVersion` field is used as a cache-busting query string by `AssetManager`; bump it when changing sprite PNGs that browsers may cache.
```

`new_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets.
The `style.assetVersion` field is used as a cache-busting query string by `AssetManager`; bump it when changing sprite PNGs that browsers may cache.

For pixellab tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`docs/pixellab-reference.md`](docs/pixellab-reference.md).
```

- [ ] **Step 2: Verify parity**

```bash
diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)
```

Expected: no output (empty diff). If non-empty, the two files have drifted; the per-repo convention requires they match after the title line.

- [ ] **Step 3: Stage**

```bash
git add CLAUDE.md
```

---

## Task 5: Pointer in `claudeville/CLAUDE.md`

**Files:**
- Modify: `claudeville/CLAUDE.md` (extend its in-app Sprite Generation block; relative path is `../docs/...` because this file lives one level deeper than the root agent docs)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with these exact strings:

`old_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets. `style.assetVersion` should be bumped when PNGs change and browser cache behavior matters.
The `palettes` block in `manifest.yaml` is mirrored in `claudeville/assets/sprites/palettes.yaml`; keep both in sync if editing either.

For full asset generation steps see `scripts/sprites/generate.md`.
```

`new_string`:
```
The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets. `style.assetVersion` should be bumped when PNGs change and browser cache behavior matters.
The `palettes` block in `manifest.yaml` is mirrored in `claudeville/assets/sprites/palettes.yaml`; keep both in sync if editing either.

For full asset generation steps see `scripts/sprites/generate.md`.
For pixellab tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`../docs/pixellab-reference.md`](../docs/pixellab-reference.md).
```

- [ ] **Step 2: Verify**

```bash
grep -c "docs/pixellab-reference.md" claudeville/CLAUDE.md
```

Expected: `1`

- [ ] **Step 3: Stage**

```bash
git add claudeville/CLAUDE.md
```

---

## Task 6: Add the doc to the `README.md` docs table

**Files:**
- Modify: `README.md` (add one row in the bottom docs table)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with these exact strings:

`old_string`:
```
| `scripts/sprites/generate.md` | Sprite work | Manifest-first Pixellab generation and asset validation runbook. |

## License
```

`new_string`:
```
| `scripts/sprites/generate.md` | Sprite work | Manifest-first Pixellab generation and asset validation runbook. |
| `docs/pixellab-reference.md` | Sprite work | Pixellab tool catalog, parameter enums, animation templates, async lifecycle, and pitfalls. |

## License
```

- [ ] **Step 2: Verify**

```bash
grep -c "docs/pixellab-reference.md" README.md
```

Expected: `1`

- [ ] **Step 3: Stage**

```bash
git add README.md
```

---

## Task 7: Back-link from `agents/plans/chardesign-revamp.md`

**Files:**
- Modify: `agents/plans/chardesign-revamp.md` (insert one line after the agentic-workers note)

- [ ] **Step 1: Apply the edit**

Use the Edit tool with these exact strings:

`old_string`:
```
# Character Design Revamp Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. The plan is structured as four waves; each wave dispatches independent subagents in parallel. Sequential steps within a track are checkbox-tracked.
```

`new_string`:
```
# Character Design Revamp Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. The plan is structured as four waves; each wave dispatches independent subagents in parallel. Sequential steps within a track are checkbox-tracked.

> **Pixellab reference:** This plan was written before the canonical pixellab guide existed. For up-to-date tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`../../docs/pixellab-reference.md`](../../docs/pixellab-reference.md). Apparent disagreements between this plan and that reference should defer to the reference.
```

- [ ] **Step 2: Verify**

```bash
grep -c "docs/pixellab-reference.md" agents/plans/chardesign-revamp.md
```

Expected: `1`

- [ ] **Step 3: Stage**

```bash
git add agents/plans/chardesign-revamp.md
```

---

## Task 8: Cross-file verification gate

**Files:** none (read-only checks)

- [ ] **Step 1: Confirm root-level CLAUDE.md / AGENTS.md parity**

```bash
diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)
```

Expected: no output.

- [ ] **Step 2: Confirm every pointer resolves to the new doc**

```bash
for f in scripts/sprites/generate.md AGENTS.md CLAUDE.md claudeville/CLAUDE.md README.md agents/plans/chardesign-revamp.md; do
  grep -l "docs/pixellab-reference.md" "$f" >/dev/null && echo "OK  $f" || echo "FAIL $f"
done
```

Expected: six lines, all `OK`.

- [ ] **Step 3: Confirm all relative links from pointer files resolve to the new doc**

```bash
test -f docs/pixellab-reference.md && echo "ref doc exists"
# scripts/sprites/generate.md uses ../../docs/pixellab-reference.md
test -f scripts/sprites/../../docs/pixellab-reference.md && echo "scripts/sprites link OK"
# AGENTS.md / CLAUDE.md / README.md use docs/pixellab-reference.md (root-relative)
test -f docs/pixellab-reference.md && echo "root link OK"
# claudeville/CLAUDE.md uses ../docs/pixellab-reference.md
test -f claudeville/../docs/pixellab-reference.md && echo "claudeville link OK"
# agents/plans/chardesign-revamp.md uses ../../docs/pixellab-reference.md
test -f agents/plans/../../docs/pixellab-reference.md && echo "agents/plans link OK"
```

Expected: five lines, all confirming the file exists at each relative path.

- [ ] **Step 4: Confirm sprites validation still passes**

```bash
npm run sprites:validate 2>&1 | tail -5
```

Expected: success (or, if `js-yaml` is missing as noted in `CLAUDE.md`, the documented fallback is acceptable — sprite validation is not the gate for a docs-only change, but running it confirms we did not accidentally touch a manifest).

- [ ] **Step 5: Confirm no unrelated edits**

```bash
git status --short
```

Expected: only the seven files modified by Tasks 1–7 (plus any unrelated working-tree state that existed before this plan started — preserve it).

```bash
git diff --cached --stat
```

Expected: line additions on the six edited files plus the new reference doc; no deletions outside the explicit edits.

---

## Task 9: Commit

**Files:** the seven files staged in Tasks 1–7.

- [ ] **Step 1: Create the commit**

Only proceed if the user has explicitly approved committing on this run. Per the repo `CLAUDE.md`, commits require explicit user approval; do not commit silently.

If approved:

```bash
git commit -m "$(cat <<'EOF'
docs: add comprehensive pixellab reference for agents

Add docs/pixellab-reference.md covering MCP-vs-REST boundary, tool
catalog, decision tree, async/job lifecycle, parameter enums,
animation templates, prompt grammar, pitfalls, and smoke recipes.
Add pointer lines from AGENTS.md, CLAUDE.md, claudeville/CLAUDE.md,
scripts/sprites/generate.md, README.md, and the chardesign revamp
plan so agents discover the reference from any entry point.

No script, manifest, or asset changes.
EOF
)"
```

- [ ] **Step 2: Verify**

```bash
git log -1 --stat
```

Expected: seven files changed; reference doc shows ~250-340 insertions; pointer files each show small insertions.

---

## Self-review checklist

Run through these before declaring the plan complete:

- [ ] Every spec section (§1–§15) maps to content in Task 1's doc.
- [ ] No "TBD" / "TODO" / placeholder text in any task body. (The "Known issues / TODO" section inside the reference doc is content, not a placeholder.)
- [ ] Every cross-file pointer uses a relative path that actually resolves from its own location.
- [ ] `diff` parity check between `AGENTS.md` and `CLAUDE.md` is in the verification gate.
- [ ] Tasks 2, 3, 4, 6, 7 use exact `old_string`/`new_string` pairs verified against the files at planning time.
- [ ] Task 5 reads the file first because the in-app `claudeville/CLAUDE.md` Sprite Generation block has a different ending than the root version.
- [ ] Task 9 respects the repo's "commit only when explicitly approved" rule.
