# ClaudeVille Sprite Asset Generation Runbook

**Date:** 2026-04-25  
**Scope:** Pixel-art sprite asset generation via the [pixellab MCP server](https://github.com/pixellab-code/pixellab-mcp)  
**Reference:** `docs/superpowers/specs/2026-04-25-pixel-art-visual-upgrade-design.md`

This document guides the generation of ~195 PNG sprite assets across 9 categories through ~94 MCP calls. It is intended for the human executor (Claude Code session operator) working through the pixellab MCP workflow.

---

## 1. Setup (One-time per machine)

### 1.1 Install and configure the pixellab MCP server

If you have not already registered the pixellab MCP server with Claude Code, do so now:

```bash
claude mcp add --transport http pixellab https://api.pixellab.ai/mcp \
  --header "Authorization: Bearer YOUR_API_TOKEN"
```

Replace `YOUR_API_TOKEN` with your pixellab API token from https://pixellab.ai.

### 1.2 Verify the connection

```bash
claude mcp list
```

Expected output:
```
pixellab: http://api.pixellab.ai/mcp ✓ Connected
```

If the connection shows `✗ Error`, confirm your API token is correct and regenerate it if necessary.

---

## 2. Generation Modes

### 2.1 Full bulk regeneration

**Use case:** Starting from scratch or regenerating every sprite in the manifest.

- **Scope:** All 93+ entries in `claudeville/assets/sprites/manifest.yaml`.
- **Effort:** ~94 MCP tool calls.
- **Time:** Several minutes (pixellab MCP API + local image I/O).
- **Cost:** Measurable credit consumption on pixellab account.

**Before bulk generation:** Validate style coherence (§3) by generating 3 reference assets.

### 2.2 Single-asset regeneration

**Use case:** Tweaking one entry's prompt and regenerating just that asset.

- **Scope:** One manifest entry.
- **Effort:** 1 MCP tool call (or ~6 for composed buildings with 6 quadrants).
- **Time:** 5–30 seconds per asset.
- **Cost:** Minimal.

**Workflow:**
1. Edit the entry's prompt in `claudeville/assets/sprites/manifest.yaml`.
2. Make a single MCP call for that asset.
3. Commit the updated PNG.

---

## 3. Reference-Asset Coherence Smoke Test (REQUIRED before bulk)

Before committing ~90 MCP calls for bulk generation, generate exactly 3 reference assets to validate that the style anchor produces coherent output across different asset types.

**Why:** The style anchor is baked into every prompt. If the anchor is poorly tuned, every asset will be visually incoherent. Catching this early saves credits and time.

### 3.1 Generate the three reference assets

1. **Character (agent.claude.base)**

   Call `create_character` with the following parameters:
   - **Description:** Style anchor + character prompt (see manifest entry `characters[0]` for base prompt)
   - **Size:** 64
   - **n_directions:** 8
   - **Animations:** `["walk", "idle"]`
   
   Save output to: `claudeville/assets/sprites/characters/agent.claude.base/sheet.png`

2. **Hero building (building.watchtower, one quadrant)**

   Call `isometric_tile` with:
   - **Description:** Style anchor + "epic harbor lighthouse, weathered grey stone tower, crimson conical roof, brass lantern dome, dragon banner, isometric, dramatic"
   - **Size:** 128
   
   Save output to: `claudeville/assets/sprites/buildings/building.watchtower/base-0-0.png`

3. **Wang tileset (terrain.grass-dirt)**

   Call `tileset` with:
   - **Lower description:** Style anchor + "ancient forest grass with wildflowers and moss"
   - **Upper description:** Style anchor + "rich loam dirt path"
   - **Size:** 32
   
   Save output to: `claudeville/assets/sprites/terrain/terrain.grass-dirt/` (16 Wang variants).

### 3.2 Visual review

After all 3 assets have been generated and saved locally:

1. **Open the three assets in your image viewer side by side.**
2. Ask yourself:
   - Do they share a coherent style (similar pixel density, palette, lighting)?
   - Is the palette consistent (e.g., similar earth tones, highlight colors)?
   - Does the painterly/pixel-edge balance match the anchor description?
   - Are characters recognizable and hero buildings suitably epic?

### 3.3 Iteration cap

**If yes:** Proceed to bulk generation (§4).

**If no:** Iterate up to 3 times:
1. Edit `style.anchor` in `manifest.yaml` to refine the visual direction.
2. Regenerate the 3 references.
3. Eyeball again.

After 3 iterations without coherence, pause and escalate to the user. The fix is likely a rephrase of the anchor itself, not continued regeneration.

---

## 4. Bulk Generation Order (recommended)

Generate assets in this order so the world becomes visually complete at each step. After each batch, commit the PNG folder and run validation (§8).

### 4.1 Wang terrain tilesets (6 calls)

**Calls:** `terrain.grass-dirt`, `terrain.grass-cobble`, `terrain.grass-shore`, `terrain.shore-shallow`, `terrain.shallow-deep`, `terrain.cobble-square`

**Tool:** `tileset` (each call produces 16 Wang variants)

**Directory:** `claudeville/assets/sprites/terrain/<terrain-id>/`

**Why first:** Gives the world a visible ground layer.

**Commit:** `git add claudeville/assets/sprites/terrain/ && git commit -m "feat(sprites): generate Wang terrain tilesets (6 transitions)"`

### 4.2 Standard buildings (7 calls)

**Calls:** `building.code-forge`, `building.token-mine`, `building.task-board`, `building.chat-hall`, `building.research-observatory`, `building.lore-archive`, `building.idle-sanctuary`

**Tool:** `isometric_tile`

**Size:** 64

**Directory:** `claudeville/assets/sprites/buildings/<building-id>/`

**Commit:** `git add claudeville/assets/sprites/buildings/ && git commit -m "feat(sprites): generate standard buildings (7 structures)"`

### 4.3 Hero buildings (28 calls)

**Calls:** `building.command-center`, `building.watchtower`, `building.observatory`, `building.portal-gate`

Each hero building has `composeGrid: [cols, rows]`:
- **Command Center:** 3×3 grid + 2 overlay layers (banner, watchfire) = 11 calls
- **Watchtower (Lighthouse):** 3×2 grid + 1 overlay layer (beacon) = 7 calls
- **Observatory:** 2×2 grid + 1 overlay layer (astrolabe) = 5 calls
- **Portal Gate:** 2×2 grid + 1 overlay layer (glow) = 5 calls

**Tool:** `isometric_tile`

**Size:** 128 (generates into quadrants; AssetManager stitches at boot)

**Per-quadrant path:** `claudeville/assets/sprites/buildings/building.<id>/base-{c}-{r}.png` where `c` ∈ [0, cols) and `r` ∈ [0, rows).

**Overlay paths:** `claudeville/assets/sprites/buildings/building.<id>/<layerName>.png` (e.g., `beacon.png`, `banner.png`)

**Commit:** `git add claudeville/assets/sprites/buildings/ && git commit -m "feat(sprites): generate hero buildings + overlays (28 calls)"`

### 4.4 Characters (3 calls)

**Calls:** `agent.claude.base`, `agent.codex.base`, `agent.gemini.base`

**Tool:** `create_character`

**Size:** 64

**n_directions:** 8

**Animations:** `["walk", "idle"]`

**Output:** Single sprite sheet (16 walk frames + 8 idle frames per 8 directions = 192 frames total in one PNG).

**Directory:** `claudeville/assets/sprites/characters/<agent-id>/`

**Paths:** `claudeville/assets/sprites/characters/agent.claude.base/sheet.png` (and `.codex`, `.gemini`)

**Commit:** `git add claudeville/assets/sprites/characters/ && git commit -m "feat(sprites): generate agent character sheets (3 providers)"`

### 4.5 Accessories (6 calls)

**Calls:** `overlay.accessory.mageHood`, `overlay.accessory.scholarCap`, `overlay.accessory.goggles`, `overlay.accessory.toolBand`, `overlay.accessory.starCrown`, `overlay.accessory.oracleVeil`

**Tool:** `isometric_tile`

**Size:** 32

**n_directions:** 8

**Output:** 8 directional variants per accessory.

**Directory:** `claudeville/assets/sprites/overlays/`

**Paths:** `claudeville/assets/sprites/overlays/overlay.accessory.<name>.png` for each direction (or combined in sheet if pixellab outputs a strip).

**Commit:** `git add claudeville/assets/sprites/overlays/ && git commit -m "feat(sprites): generate character accessories (6 × 8-dir)"`

### 4.6 Status overlays (4 calls)

**Calls:** `overlay.status.selected`, `overlay.status.chat`, `overlay.status.working`, `overlay.status.idle`

**Tool:** `isometric_tile`

**Size:** 64

**Animations:** `selected` has a 3-frame pulse; others are static.

**Directory:** `claudeville/assets/sprites/overlays/`

**Paths:** `claudeville/assets/sprites/overlays/overlay.status.<name>.png` (or frame sheets if animated)

**Commit:** `git add claudeville/assets/sprites/overlays/ && git commit -m "feat(sprites): generate status overlays (4 states)"`

### 4.7 Props (~13 calls)

**Calls:** `prop.harbor.boat`, `prop.lantern`, `prop.signpost`, `prop.runestone`, `prop.well`, `prop.marketStall`, `prop.scrollCrates`, `prop.oreCart`, `prop.flowerCart`, `prop.noticePillar`, `prop.harborPier`, `prop.harborCrates`, `prop.harborCrane`

**Tool:** `isometric_tile`

**Size:** 64

**Directory:** `claudeville/assets/sprites/props/`

**Paths:** `claudeville/assets/sprites/props/prop.<name>.png`

**Commit:** `git add claudeville/assets/sprites/props/ && git commit -m "feat(sprites): generate world props (13 objects)"`

### 4.8 Vegetation (~17 calls)

**Calls:** `veg.tree.oak.large`, `veg.tree.oak.small`, `veg.tree.pine.large`, `veg.tree.pine.small`, `veg.tree.willow.large`, `veg.tree.willow.small`, `veg.boulder.mossy.large`, `veg.boulder.mossy.small`, `veg.boulder.granite.large`, `veg.boulder.granite.small`, `veg.bush.a`, `veg.bush.b`, `veg.bush.c`, `veg.grassTuft.a`, `veg.grassTuft.b`, `veg.reed.a`, `veg.reed.b`

**Tool:** `isometric_tile`

**Size:** 64

**Directory:** `claudeville/assets/sprites/vegetation/`

**Paths:** `claudeville/assets/sprites/vegetation/veg.<species>.<variant>.png`

**Commit:** `git add claudeville/assets/sprites/vegetation/ && git commit -m "feat(sprites): generate vegetation variants (17 plants)"`

### 4.9 Bridges, docks, and atmosphere (~10 calls)

**Bridges & docks (4 calls):**
- `bridge.ew`, `bridge.ns`, `dock.ew`, `dock.ns`
- **Tool:** `isometric_tile`, **Size:** 64
- **Paths:** `claudeville/assets/sprites/bridges/bridge.<orient>.png`, `claudeville/assets/sprites/bridges/dock.<orient>.png`

**Atmosphere (6 calls):**
- `atmosphere.deep-sea`, `atmosphere.light.lighthouse-beam`, `atmosphere.light.fire-glow`, `atmosphere.light.lantern-glow`, `atmosphere.light.ambient`, `atmosphere.aurora` (optional)
- **Tool:** `tileset` (for deep-sea) or `isometric_tile` (for lights)
- **Size:** 64
- **Paths:** `claudeville/assets/sprites/atmosphere/<id>.png`

**Commit:** `git add claudeville/assets/sprites/bridges/ claudeville/assets/sprites/atmosphere/ && git commit -m "feat(sprites): generate bridges, docks, and atmosphere (10 assets)"`

---

## 5. Per-Call Template

For every MCP tool call, follow this pattern:

1. **Read the current style anchor** from the top of `claudeville/assets/sprites/manifest.yaml`:
   ```yaml
   style:
     anchor: "epic high-fantasy pixel art, dramatic lighting, painterly palette,
              crisp pixel edges, no anti-aliasing, heroic silhouettes,
              faint magical glow on landmarks"
   ```

2. **Prepend the anchor to the entry's prompt:**
   ```
   <style.anchor> <entry.prompt>
   ```

3. **Call the appropriate MCP tool** with the combined description and other parameters:

   **Example for a standard building:**
   ```
   mcp__pixellab__isometric_tile(
     description: "epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks epic forge building with brick kiln, glowing forge-mouth, anvil detail, isometric",
     size: 64
   )
   ```

   **Example for a character:**
   ```
   mcp__pixellab__create_character(
     description: "epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks epic high-fantasy mage scholar, warm amber robes with gold trim, glowing rune sigil on chest, hooded silhouette, front 3/4 view",
     size: 64,
     n_directions: 8,
     animations: ["walk", "idle"]
   )
   ```

   **Example for a tileset:**
   ```
   mcp__pixellab__tileset(
     lower_description: "epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks ancient forest grass with wildflowers and moss",
     upper_description: "epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks rich loam dirt path",
     size: 32
   )
   ```

---

## 6. Iteration Cap

If a generated asset does not match the style or the manifest description:

1. **First attempt:** Try up to 3 refinements to the entry's prompt in `manifest.yaml`.
   - Edit the prompt to be more specific or adjust the emphasis.
   - Regenerate and save.

2. **After 3 failures:** Pause and escalate to the user.
   - Do not retry indefinitely.
   - The issue is usually a poorly-tuned prompt or anchor, not a pixellab API limitation.

This cap exists to avoid burning credits on a poorly-aligned prompt. The fix is to rephrase the entry's description or the style anchor, not to keep retrying the same input.

---

## 7. Path Mapping Reference

The following table maps manifest entry IDs to their expected output paths. `AssetManager._pathFor()` in `claudeville/src/presentation/character-mode/AssetManager.js` implements this deterministically.

| Manifest ID prefix | Output path(s) |
|---|---|
| `agent.<provider>.base` | `claudeville/assets/sprites/characters/<id>/sheet.png` |
| `overlay.accessory.<name>` | `claudeville/assets/sprites/overlays/overlay.accessory.<name>.png` |
| `overlay.status.<name>` | `claudeville/assets/sprites/overlays/overlay.status.<name>.png` |
| `building.<type>` (standard, no compose) | `claudeville/assets/sprites/buildings/<id>/base.png` |
| `building.<type>` with `composeGrid: [c, r]` | `claudeville/assets/sprites/buildings/<id>/base-{0..c-1}-{0..r-1}.png` (one per cell) |
| `building.<type>.<layerName>` (overlay) | `claudeville/assets/sprites/buildings/<id>/<layerName>.png` |
| `prop.<name>` | `claudeville/assets/sprites/props/<id>.png` |
| `veg.<species>.<variant>` | `claudeville/assets/sprites/vegetation/<id>.png` |
| `terrain.<class-pair>` (Wang) | `claudeville/assets/sprites/terrain/<id>/sheet.png` (16-cell horizontal Wang strip, or 16 separate files) |
| `bridge.<orient>` | `claudeville/assets/sprites/bridges/<id>.png` |
| `dock.<orient>` | `claudeville/assets/sprites/bridges/<id>.png` |
| `atmosphere.<name>` | `claudeville/assets/sprites/atmosphere/<id>.png` |

---

## 8. Validation After Generation

After each batch (or after all batches if doing full bulk), run the manifest validator:

```bash
npm run sprites:validate
```

Expected output after full bulk generation:
```
expected: 93+  missing: 0  orphan PNGs: 0
(exit code 0)
```

If `missing > 0`, re-generate the listed entries. If `orphan PNGs > 0`, delete unused image files.

---

## 9. Commit Hygiene

Commit assets per category, not per asset. This keeps PR review tractable and follows the bulk generation order above.

**Pattern:**
```bash
git add claudeville/assets/sprites/<category>/
git commit -m "feat(sprites): generate <category> assets (<description>)"
```

**Examples:**
- `feat(sprites): generate Wang terrain tilesets (6 transitions)`
- `feat(sprites): generate standard buildings (7 structures)`
- `feat(sprites): generate hero buildings + overlays (28 calls)`
- `feat(sprites): generate agent character sheets (3 providers)`

One commit per batch ensures that:
- PRs are easier to review and blame.
- If a batch needs regeneration, the commit is self-contained.
- The git history tells the story of the build-out order.

---

## 10. Checklist for Bulk Generation

- [ ] Style coherence smoke test passed (§3).
- [ ] Pixellab MCP server is connected (`claude mcp list`).
- [ ] Cost ceiling confirmed with user before starting.
- [ ] Generated terrain tilesets (6 calls, §4.1).
- [ ] Generated standard buildings (7 calls, §4.2).
- [ ] Generated hero buildings (28 calls, §4.3).
- [ ] Generated characters (3 calls, §4.4).
- [ ] Generated accessories (6 calls, §4.5).
- [ ] Generated status overlays (4 calls, §4.6).
- [ ] Generated props (~13 calls, §4.7).
- [ ] Generated vegetation (~17 calls, §4.8).
- [ ] Generated bridges + atmosphere (~10 calls, §4.9).
- [ ] Ran `npm run sprites:validate` — all expected assets present.
- [ ] Committed all PNG batches with per-category commits.
- [ ] Ran `git status --short` to confirm tree is clean.
