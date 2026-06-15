# ClaudeVille Building Harmonization & Upgrade Plan

- **Status:** `completed` (executed 2026-06-15)
- **Author:** Claude (Opus 4.8) — research + plan + execution
- **Date:** 2026-06-15
- **Scope:** The nine World-mode building sprites and their generation/render coupling.
- **Goal:** One coherent, high-fantasy pixel-art building set — consistent style, consistent size logic, consistent grounding — with no regression in the animated overlays, occlusion split, or light system.

## Execution status (2026-06-15)

Done and verified in the live app (`sprites:validate` + `world:validate-buildings` pass, 0 console errors):

- **Regenerated on-contract (single-image, grounded base, recalibrated overlays/lights):** Task Board, Forge, Mine, Watchtower (narrowed/heightened), Observatory (added base + recalibrated animated clock).
- **`composeGrid` fully retired:** Command, Portal, Observatory, Watchtower converted to single-image (Command/Portal losslessly from their existing tiles). Dead `_loadComposedBuilding` removed from `AssetManager`; `AssetManager` now loads building overlay layers (watchfire/banner/beacon/portalGlow) from `buildings/<id>/<name>.png` for single-image entries.
- **Kept:** Command, Portal, Harbor (warm-waterfront variant — meets craft rules), Archive. Archive de-violet polish was **skipped** (optional in plan; already on-contract — not worth the emitter/horizon recalibration risk).
- **Style contract** authored at `docs/building-style-contract.md`.
- **Style source unified (Decision 7):** `generate-pixellab-revamp.mjs` now reads `style.anchor` + subject-only building prompts from the manifest; no divergent hardcoded `STYLE`.
- **New tool:** `scripts/sprites/key-out-bg.mjs` — `create_map_object` downloads arrive flattened on grey; this keys the background out (edge flood-fill). This was the cause of the "grey background" issue.
- **Asset version:** bumped to `2026-06-15-building-harmonization-v3`.

Remaining/optional follow-ups: Archive de-violet (cosmetic), Harbor optional cool-shift (declined — kept as variant), and live in-app occlusion fine-tuning of `horizonY` per building if any agent-clipping is spotted.

---

## 0. TL;DR

The building set is good in parts and incoherent as a whole. Three problems compound:

1. **Three competing art "dialects."** One global style anchor exists in the manifest, but the per-building prompts speak three different languages: *epic painterly stone* (Command, Archive, Observatory, Portal), *old-school 16-bit RPG* (Forge, Mine), and *bold cozy cartoon RPG* (Harbor, Task Board). The renderer faithfully shows all three.
2. **No size system.** On-disk sprite footprints span **112px → 400px** with no rule tying sprite size to tile footprint. Forge is undersized (sprite height = 1.00× its iso footprint); Watchtower is oversized (2.34×).
3. **Inconsistent grounding.** Some buildings carry a baked isometric base diamond (Command, Archive, Task Board), some sit on a stone/hex floor (Portal, Mine), some sit on water (Harbor), and two **float with no base at all** (Observatory, Watchtower).

A fourth, structural issue sits underneath: there are **two style sources of truth** (the manifest `style.anchor` and a hardcoded `STYLE` constant in the generation script), and the "hero" generation path slices a single generated image into a tile grid for **no quality benefit**.

**Recommended path:** Adopt one written **Style Contract** (§3), drive *all* generation from the manifest, **retire `composeGrid`** in favor of single-image generation (≤400px, which fits every building), and regenerate buildings in **priority order** (Task Board → Forge → Watchtower → Mine → Observatory, then optional polish on the rest), re-calibrating the pixel-coupled overlay/light anchors after each. Command and Portal are the reference targets and are kept.

Cost is small (~1 PixelLab generation per building; full set well under 20 generations). The real work is **re-calibration and validation**, not credits.

---

## 1. Current State Inventory

`TILE_WIDTH = 64`, `TILE_HEIGHT = 32` (`claudeville/src/config/constants.js:1-2`). Iso footprint pixel size = `(w+h)·32` wide × `(w+h)·16` tall. Sprites are blitted at **native pixel size with no fit-to-footprint scaling** (`SpriteRenderer.drawSprite` calls `ctx.drawImage(img, dx, dy)` with no size args; `BuildingSprite.drawDrawable` passes exact `dims.w/h`). So the on-disk size *is* the on-screen size (× integer zoom).

| Building | Manifest tag | Gen tool | On-disk dims | Footprint w×h | iso-fp px (w×h) | sprite-h ÷ fp-h | Style cluster | Quality |
|---|---|---|---|---|---|---|---|---|
| **command** | HERO (composeGrid 3×2) | isometric_tile→sliced | 312×208 | 5×4 | 288×144 | 1.44 | A · Gold stone | ★★★★★ |
| **archive** | STANDARD | isometric_tile (single) | 336×224 | 5×3 | 256×128 | 1.75 | A · Gold stone | ★★★★★ |
| **portal** | HERO (composeGrid 3×2) | isometric_tile→sliced | 312×208 | 4×4 | 256×128 | 1.63 | A/arcane glow | ★★★★★ |
| **observatory** | HERO (composeGrid 3×2) | map_object→sliced | 312×208 | 4×4 | 256×128 | 1.63 | A · Gold stone | ★★★★ (floats) |
| **harbor** | STANDARD | isometric_tile (single) | 352×224 | 5×4 | 288×144 | 1.56 | warm wood/water | ★★★★ (off-palette) |
| **mine** | STANDARD | isometric_tile (single) | 160×160 | 4×3 | 224×112 | 1.43 | arcane dark | ★★★½ (small, hex base) |
| **watchtower** | HERO (composeGrid 4×3) | isometric_tile→sliced | 400×300 | 3×5 | 256×128 | 2.34 | B · pastel limestone | ★★ (washed, floats) |
| **forge** | STANDARD | isometric_tile (single) | 112×112 | 4×3 | 224×112 | 1.00 | C · cartoon | ★★½ (tiny, wrong proj.) |
| **taskboard** | HERO (comment only) | map_object (single) | 176×176 | 4×3 | 224×112 | 1.57 | C · cartoon | ★½ (worst) |

Source refs: dims from disk; footprints from `claudeville/src/config/buildings.js`; manifest entries `claudeville/assets/sprites/manifest.yaml:344-532`.

> Note the **incoherent taxonomy**: Task Board is *commented* "HERO" but generated as a single small `map_object`; Archive and Harbor are tagged "STANDARD" but are among the largest, hero-quality sprites. The HERO/STANDARD labels describe the *generation method*, not the visual result — and they don't even do that consistently.

---

## 2. Root-Cause Diagnosis (the five axes of disharmony)

**A. Style dialect drift.** The manifest `style.anchor` ("epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks", `manifest.yaml:3`) is concatenated into prompts, but per-building prose overrides the vibe:
- Gold: *"epic command center castle keep…imposing isometric fortress."*
- 16-bit: *"old-school 16-bit fantasy RPG isometric…landmark"* (forge, mine, archive).
- Cozy cartoon: *"bold readable isometric RPG landmark…cozy village square job board, no castle facade, no door, no large stone towers"* (taskboard) — this prompt **actively steers away** from the Command look, which is exactly why it diverges most.

**B. No size discipline.** `displaySize`/image `size` is set ad hoc per building (104, 100, 112, 160, 176, and implicit 336/352/400). Sprite-height ÷ footprint-height ranges 1.00–2.34 with no rule. Same-footprint buildings (forge, mine, taskboard are all 4×3) render at wildly different sizes (112 vs 160 vs 176).

**C. Grounding inconsistency.** Baked grass+cobble diamond (Command, Archive), warm cobble diamond (Task Board), stone floor (Portal), hex tile (Mine), water+pilings (Harbor), or **nothing — floats** (Observatory, Watchtower). A floating building reads as a cut-out pasted on the terrain.

**D. Palette fragmentation.** Roofs alone use steel-slate blue (Command/Archive/Observatory), terracotta red (Forge), and sky-cartoon blue (Task Board). Stone ranges from neutral warm-grey (Command) to desaturated lilac (Watchtower, blown-out near-white highlights) to deep navy (Mine).

**E. Two style sources + a no-op slicing step (structural).**
- The bake script (`scripts/sprites/generate-pixellab-revamp.mjs:31-54`) carries a **hardcoded `STYLE` constant and inline prompts** that do *not* read from `manifest.yaml`. The two can silently diverge (documented in `docs/pixellab-reference.md`).
- "Hero" buildings are generated as **one** full-resolution image (`pixflux()` at `generate-pixellab-revamp.mjs:194`, `resizeNearest` at :205) and then **sliced into a `[cols×rows]` PNG grid** (:210-214) that `AssetManager` re-composes and upscales at load (`_loadComposedBuilding`). The slicing buys **no generation fidelity** — it only adds per-cell PNGs, `composeGrid` manifest complexity, and a second anchor code path. Archive and Harbor (single images at 336/352px) prove single-image hero quality.

---

## 3. Target — The Building Style Contract

This is the single spec every regenerated (and ideally every retained) building must satisfy. It is intended to live in the manifest header comment and in `docs/` once approved.

### 3.1 Craft rules (apply to all buildings)
- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). *(Fixes Forge's near-front 2D view.)*
- **Outline:** 1px selective outline in warm near-black (`#060402`–`#040404`), **not** pure black and **not** colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** painterly with 3–4 tone steps per material, crisp cel transitions on edges, **minimum ~35% lightness contrast** dark→light per material. *(Kills the Watchtower pastel/washed problem.)*
- **Lighting:** single warm key from **upper-left**; cool shadow toward lower-right; faint magical rim-glow on landmarks (per the manifest anchor).
- **Roof signature:** slate-blue roof ramp is the family motif. *(Forge red and Task Board sky-blue are non-conformant → recolor to slate, keeping warm forge firelight as the accent.)*

### 3.2 Palette ramps (sampled from the gold trio + Portal/Mine)
| Ramp | Stops (dark → light) | Use |
|---|---|---|
| Cool grey stone | `#4C3A4C` · `#5C5A70` · `#837F86` · `#A9A6AC` | default walls |
| Slate-blue roof | `#215B7F` · `#3782B5` · `#3A86BA` | all roofs |
| Crimson banner | `#782331` · `#96201A` · `#A32B21` | banners/cloth |
| Gold trim | `#BA9668` · `#D79613` · `#E0A311` · `#EFC819` | trim/metal |
| Warm torch glow | `#D79613` · `#F89206` · `#FDE2AD` | fire/window light |
| Arcane violet | `#8149B2` · `#B241F0` · `#E39AFC` | Portal/arcane only |
| Cyan ore glow | `#1E6F86` · `#45DCA8` · `#C8FFF0` | Mine ore only |
| Grass base | `#355408` · `#456F03` · `#567A16` | land diamond |
| Cobble base | `#99776A` · `#A1795E` · `#E0A665` | path/apron |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

### 3.3 Required grounding
Every building sits on a baked **2:1 iso diamond base** matching the terrain it stands on:
- Land buildings → grass + cobble apron diamond (Command/Archive style).
- Arcane → dark stone-floor diamond (Portal style).
- Harbor → timber deck + water pilings (current Harbor is acceptable).
- Diamond width ≈ sprite footprint width + ~16px margin. **Nothing floats.** *(Fixes Observatory, Watchtower, Forge.)*

### 3.4 Size system (footprint-driven, capped at 400px for single-image generation)
Rule of thumb: **sprite width ≈ 1.2 × iso-diamond width** = `1.2 · (w+h) · 32`, then height by archetype. Three tiers:

| Tier | Applies to | Target W × H |
|---|---|---|
| **Hero hall** (≥5-wide footprint / civic landmark) | command, archive, harbor, observatory, portal | ~310–346 × ~210–230 |
| **Standard structure** (4×3 footprint) | forge, mine, taskboard | ~256–268 × ~220–240 |
| **Tower** (narrow, tall) | watchtower | ~280 × ~370 |

Concrete per-building targets vs current:

| Building | Current | Target (W×H) | Action |
|---|---|---|---|
| command | 312×208 | 320×214 | keep / minor |
| archive | 336×224 | 320×214 | keep; de-violet stone toward neutral grey |
| portal | 312×208 | 312×208 | keep (reference) |
| observatory | 312×208 | 308×210 | add base diamond |
| harbor | 352×224 | 344×224 | keep; optional cool-shift |
| mine | 160×160 | 260×230 | enlarge; lighten; diamond base |
| forge | 112×112 | 260×230 | full rebuild; iso; slate roof; base |
| taskboard | 176×176 | 264×222 | full rebuild; hero-grade quest board |
| watchtower | 400×300 | 280×370 | recolor to stone; narrow+heighten; base |

*(These keep every building ≤400px so all can be generated as a single image — see §4.)*

---

## 4. Architecture Decision — retire `composeGrid`, generate single-image

**Recommendation: convert all buildings to single-image generation (one PNG, `base.png`, ≤400px) and remove the `composeGrid` path.**

Why this is low-risk and a net simplification:
- The bake already generates a **single** full-res image and only slices it afterward (`generate-pixellab-revamp.mjs:194-214`). Removing the slice = strictly fewer steps, identical pixels.
- Single-image hero quality is already proven by Archive (336×224) and Harbor (352×224).
- It collapses two anchor/loader code paths in `AssetManager` into one, removes `composeGrid`/`displaySize` manifest fields, and removes 6–12 per-cell PNGs per hero from the tree (simpler `sprites:validate`, cleaner visual-diff baselines).
- Every target size in §3.4 is ≤400px, the `create_map_object` / REST pixflux ceiling (`docs/pixellab-reference.md`).

**Tradeoff / alternative:** keep `composeGrid` if a future building must exceed 400px (none currently does). If kept, the slicing still adds no fidelity — so even then, prefer single-image and only tile when a building genuinely needs >400px. Decision flagged in §7.

**Source-of-truth fix (do regardless of the above):** make the bake script read prompts + style from `manifest.yaml` (or, minimally, sync the script's `STYLE`/prompts to the manifest and add a check that they match). One style source only.

---

## 5. Risk Register (what breaks when a sprite is resized/relaid-out)

Regenerating a building is not just dropping in a PNG. The renderer hard-codes pixel coordinates against each sprite's current geometry. **Every target below must be re-measured on the new sprite.**

| Risk | Location | Detail |
|---|---|---|
| **Occlusion split breaks** | `manifest.yaml` `horizonY`; `BuildingSprite.js:1094-1095` | `horizonY` is an absolute pixel row, not a fraction. Resizing a `splitForOcclusion` building (command, watchtower, observatory, portal, harbor, taskboard, archive) requires recomputing `horizonY` or agents draw in front of/behind walls wrong. |
| **Overlay anchors drift** | `manifest.yaml` layer anchors (watchfire `[40,52]`, banner `[96,24]`, beacon `[196,42]`, portalGlow `[144,60]`) | Animated overlays are pixel-pinned to the base; a relaid base misplaces fire/banners/portal vortex. |
| **Effect/light anchors drift** | `BuildingVisualRegistry.js` | ~16 hardcoded coords: observatory `clockFace.compositeRef {312,208}` + center `[133,73]` + hand lengths; watchtower `lanternFire [200,68/66]`; emitter/light fallbacks for forge `[51,66]`, mine `[73,95]`, portal `[144,60]`, harbor, taskboard, archive `[168,88]`, command. Resizing invalidates all of them. |
| **Emitter coords drift** | `manifest.yaml` `emitters:` per building | Torch/sparkle/smoke/ember particle origins are sprite-local px. |
| **Reduced-motion fallback** | `docs/motion-budget.md` | Overlays must keep a static fallback; re-verify under `prefers-reduced-motion`. |
| **Manifest ↔ PNG bookkeeping** | `sprites:validate` | Enforces: every PNG ↔ a manifest entry, no orphans, no SHA-256 duplicates, palette mirror parity (`manifest.yaml` ↔ `palettes.yaml`). Converting composeGrid→single means deleting old `base-*-*.png` and editing the manifest in the same change. |
| **Asset cache** | `style.assetVersion` | Bump on every PNG change or the browser serves stale sprites. |
| **Zoom-step doc drift (minor, pre-existing)** | `Camera.js:12` vs CLAUDE.md | Actual zoom steps are `[1,1.5,2,2.5,3]`, but CLAUDE.md says integer `{1,2,3}`. Pixel-perfect blits only hold at integer zooms; note when validating crispness. (Out of scope to fix, but relevant to visual QA.) |

**Mitigation:** add a per-building "calibration" checklist (§6.3) and re-run it after each regen. Consider a tiny dev overlay that draws current emitter/light/anchor points over the sprite to make re-measuring fast (optional, §7 Phase 0).

---

## 6. Execution Plan

### 6.1 Phasing (priority = off-contract distance, from the visual audit)
Regenerate worst-first so the biggest wins land early; each building is independently shippable.

1. **Phase 0 — Foundations (no art yet):**
   - Write the Style Contract (§3) into the manifest header + `docs/`.
   - Unify the style source: bake script reads manifest prompts/style (or sync + assert parity).
   - Decide composeGrid retirement (§4) and, if yes, land the `AssetManager` single-image simplification behind the existing single-image path first (Archive/Harbor already use it).
   - (Optional) dev calibration overlay for anchor re-measurement.
2. **Phase 1 — Worst offenders:** **Task Board**, then **Forge**. Full rebuilds to hero-adjacent size, slate roof, iso projection, baked base.
3. **Phase 2 — Off-palette/floating:** **Watchtower** (recolor stone, narrow+heighten, add base), **Mine** (enlarge, lighten, diamond base), **Observatory** (add base diamond; keep render).
4. **Phase 3 — Polish (optional):** **Archive** (de-violet stone toward Command neutral). **Harbor**, **Command**, and **Portal** are kept as-is (Harbor retained as the warm-waterfront variant per Decision 6 — verify craft rules only, no regen).

### 6.2 Per-building loop (verifiable)
For each building:
1. Draft the prompt from the Contract (palette ramps + craft rules + required base + target size). Keep the building's *function* legible (quest board must read as a quest board, forge as a forge).
2. Generate via PixelLab (`create_map_object`/REST pixflux, `no_background: true`, ≤400px). Check `get_balance` once before the batch.
3. Place PNG at the manifest-implied path; if converting from composeGrid, delete old `base-*-*.png` and update the manifest entry (drop `composeGrid`/`displaySize`, set single-image dims/anchor).
4. **Re-calibrate** all pixel-coupled values for that building (§6.3).
5. Bump `style.assetVersion`.
6. Verify (§6.4). Commit per building.

### 6.3 Calibration checklist (per regenerated building)
- [ ] Recompute `horizonY` (visual horizon row) if `splitForOcclusion`.
- [ ] Re-measure manifest `emitters:` coords (torch/sparkle/smoke/ember/etc.).
- [ ] Re-measure manifest layer anchors (watchfire/banner/beacon/portalGlow) if the building keeps overlays.
- [ ] Re-measure `lightSource` (and `lightSources[]`) px coords.
- [ ] Update `BuildingVisualRegistry.js` coords for that building (effect anchors, light fallbacks, emitter fallbacks; observatory `clockFace.compositeRef` + center + radii; watchtower `lanternFire`).
- [ ] Confirm `anchor` (bottom-center, default `[w/2, h·7/8]`) sits at the base diamond's footprint center.

### 6.4 Validation gates (match to what changed)
- `npm run sprites:validate` — manifest ↔ PNG bidirectional, palette mirror parity, dup/orphan check. (fast, no server)
- `npm run world:validate-buildings` — every `BUILDING_DEFS` type ↔ manifest entry; required fields; capacity vs visitTiles.
- `npm run dev`, then open `http://localhost:4000`: World mode — each regenerated building renders, sits on its base (no float), overlays/fire/banners aligned, light glow correct, occlusion split correct as an agent walks behind/in front, hover outline correct, label tag anchors above the sprite. Test at zoom 1/2/3.
- `prefers-reduced-motion`: overlays fall back to static.
- `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` — update baselines intentionally (these *should* change); commit new baselines.
- Re-check English-only copy gate if any manifest comments/docs change.

---

## 7. Decisions — Confirmed 2026-06-15

| # | Decision | Choice |
|---|---|---|
| 1 | **Scope** | **Targeted regen** — rebuild Task Board, Forge, Watchtower; adjust Mine + Observatory; light polish Archive; keep Command, Portal, Harbor. |
| 2 | **Palette philosophy** | **Unified craft rules + thematic palettes** — keep Portal violet, Mine cyan-ore, Harbor warm-wood as allowed deviations on shared craft rules. |
| 3 | **Generation method** | **Retire `composeGrid`** — single image per building, ≤400px (see §4). |
| 4 | **Watchtower silhouette** | **Narrow + heighten (~280×370)** — reshape to a vertical landmark, recolor to stone family, add base. |
| 5 | **Mine base** | **Swap hex → iso diamond** — ground it like the family; also enlarge (~260×230) and lighten. |
| 6 | **Harbor** | **Keep warm wood/water variant** — no regeneration; only confirm it meets craft rules (outline, shading, grounding). |
| 7 | **Style source** | **Refactor bake script to read prompts + style from `manifest.yaml`** — one source of truth (part of Phase 0). |
| 8 | **Execution** | **Orchestrated workflow pass** — draft prompts + regenerate + calibrate across the phased set in one orchestrated run, then batch review. *(Note: anchor re-calibration and visual QA in §6.3 are inherently human-in-the-loop; the workflow drafts/automates up to those gates.)* |

Net effect on §6.1: Phase 1 = Task Board, Forge. Phase 2 = Watchtower, Mine, Observatory. Phase 3 = Archive polish only (Harbor and Portal/Command untouched).

---

## 8. Effort & Cost
- **PixelLab credits:** ~1 generation/building; the whole set < 20 generations (Tier-3 budget is 10k/mo). Negligible. Check `get_balance` first.
- **Engineering effort (dominant cost):** prompt iteration + the §6.3 re-calibration + visual QA per building. Budget the bulk of time here, not on generation.
- **Files touched:** `claudeville/assets/sprites/buildings/*`, `manifest.yaml`, `palettes.yaml` (parity), `BuildingVisualRegistry.js`, possibly `AssetManager.js` (composeGrid removal), `scripts/sprites/generate-pixellab-revamp.mjs` (style source unification), `scripts/sprites/baselines/*`, `CHANGELOG.md` + version locations.

## 9. Rollout
- Land per-building (or per-phase) commits so each is independently reviewable and revertible.
- **Before pushing:** prepend a `CHANGELOG.md` entry (a named minor release fits — e.g. `## v0.X.Y — *Stonemason's Charter* · Jun DD, 2026`) and bump the version in `claudeville/index.html` `.topbar__version` and `package.json`.
- Keep `agents/README.md` index row (below) current; flip status `ready → historical` when complete.

---

## Appendix A — Key source references
- Building defs/footprints: `claudeville/src/config/buildings.js:84-367`
- Manifest building entries + style anchor: `claudeville/assets/sprites/manifest.yaml:1-3, 339-532`
- Native-size blit (no scaling): `claudeville/src/presentation/character-mode/SpriteRenderer.js:~28`; split blit `BuildingSprite.js:1106-1128`
- Occlusion split / horizonY: `BuildingSprite.js:1080-1104`
- Pixel-coupled effect/light anchors: `BuildingVisualRegistry.js` (clockFace ~63-71, lanternFire ~93-96, emitter/light fallbacks ~113-155)
- composeGrid compose+upscale: `AssetManager.js` `_loadComposedBuilding` (~135-160)
- Bake script (single-image gen + slice + hardcoded STYLE): `scripts/sprites/generate-pixellab-revamp.mjs:31-54, 174-218`
- PixelLab tool sizes/limits/cost: `docs/pixellab-reference.md`
- Generation workflow: `scripts/sprites/generate.md`

## Appendix B — Style cluster map (current)
- **A · Gold stone (canon):** command, archive, observatory, portal — cool grey masonry, slate-blue roof, crimson+gold, painterly, grounded.
- **arcane glow:** portal (hero), mine (small/dark) — same craft + violet/cyan emissive.
- **warm wood/water:** harbor — same craft, wood+water palette.
- **B · pastel limestone (off-contract):** watchtower — desaturated lilac, low contrast, floats.
- **C · cartoon (off-contract):** forge (tiny, near-2D, red roof), taskboard (flat, candy colors) — worst.

## Appendix C — agents/README.md index row to add
```
| [plans/claudeville-building-harmonization-upgrade-plan.md](plans/claudeville-building-harmonization-upgrade-plan.md) | ready | 2026-06-15 | manifest.yaml + live sprites + BuildingVisualRegistry | After fresh baseline; phased §6 | sprites:validate, world:validate-buildings, capture/visual-diff; re-calibrate §6.3 |
```
