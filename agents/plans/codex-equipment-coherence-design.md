# Codex Agent Equipment Coherence — Design Spec

Generated: 2026-04-28
Status: Design (pre-implementation). Subagent research synthesis from haiku/sonnet/opus parallel passes.

---

## Problem

Three Codex agents (`agent.codex.gpt53spark`, `agent.codex.gpt54`, `agent.codex.gpt55`) render incoherently. Three failure modes are stacked:

1. PixelLab ignored the negative prompts at `manifest.yaml:42-67` and baked weapons into the 8-direction × 10-row sprite sheets, with hand-anchor drift and weapon-shape variance across the 80 cells per character.
2. The runtime weapon overlay system at `AgentSprite.js:887-930` draws additional vector weapons on top, mapped from effort tier (`ModelVisualIdentity.js:39-45`).
3. The pixel scrubber at `AgentSprite.js:537-583` that should erase the baked weapons only fires when `suppressBakedWeapon: true`, which `ModelVisualIdentity.js:177` sets only for `gpt55`. `gpt54` and `gpt53spark` therefore render BOTH the baked weapon AND the runtime overlay.

Two architectural mismatches sit underneath the rendering chaos:

- **Manifest framing vs. runtime shapes.** Codex prompts describe "epic arcane engineer", "battle-engineer", "tool-belt", "no sword no blade" — yet the code draws plain swords, daggers, greatswords, polearms.
- **Identity vs. effort overload.** Currently the weapon shape encodes both character identity AND effort tier (low→dagger, medium→swordShield, high→greatsword, xhigh/max→polearm). A single character "grows new arms" when the user nudges `--reasoning high`. Effort signaling already has dedicated channels (floor rings + crown accessories).

## Goal

After this work:

1. Each Codex character carries its own **permanent, character-specific equipment** that does not change with effort tier.
2. **Effort tier signals only via floor ring + crown accessory** — both already exist in the asset pipeline.
3. The double-weapon visual chaos is gone. Scrubber runs uniformly across all three characters with per-class color-selector tuning so it does not clip body pixels.
4. Manifest framing and runtime rendering agree: gpt53spark and gpt54 read as engineer-class, gpt55 reads as warrior-captain.

## Per-character equipment vocabulary

| Character | Class | Permanent equipment | Geometry slot | Visual cue |
|---|---|---|---|---|
| `gpt53spark` | scout-duelist | **Spark multitool** — short folding wrench-knife, one-handed, hip height. Single rune glyph on grip glows faintly at higher effort tiers. | `rightHand` (existing) | Replaces `dagger`. |
| `gpt54` | battle-engineer | **Heavy engineer wrench** — two-handed bronze-headed pipe wrench, glyph-inscribed jaws. Shoulder-rest is the pose concept across all 8 directions; rear-facing renders use a back-anchored variant so the wrench reads as resting on shoulder rather than floating beside it. | New `shoulderRest` (s/sw/se/e/w) + reuse `backCarry` (n/ne/nw) | Replaces all four prior weapon slots for this character. |
| `gpt55` | techno-paladin captain | **Captain's runeblade** — sheathed at hip when walking, drawn-and-grounded when selected. Blade carries a faint engraved rune line (per haiku rune-glyph aesthetic). Shield at left arm. | `rightHand` + `shield` (existing) | Refines existing sword. |

**Rule:** equipment shape = character identity (constant). Floor ring + crown = effort tier (variable). Both render simultaneously.

## Code changes

### `claudeville/src/presentation/shared/ModelVisualIdentity.js`

Replace the effort-keyed `CODEX_EFFORT_WEAPONS` map (lines 39-45) with a class-keyed `CODEX_EQUIPMENT_BY_CLASS`:

```javascript
const CODEX_EQUIPMENT_BY_CLASS = Object.freeze({
    spark: 'multitool',
    gpt54: 'wrench',
    gpt55: 'swordShield',
});
```

Update `codexEquipment(effortTier, modelClass)` (lines 55-63):
- Take `modelClass` as a second argument.
- Look up `effortEquipment` from `CODEX_EQUIPMENT_BY_CLASS[modelClass]`.
- Always set the floor ring (`EFFORT_FLOOR_RINGS[effortTier]`) — drop the current `effortWeapon ? null : ...` suppression.
- Always set `suppressBakedWeapon: true` (no longer per-character).

Each Codex branch in `getModelVisualIdentity` (lines 147-213) calls `codexEquipment(effortTier, modelClass)` with its modelClass. Remove the line-177 per-character `suppressBakedWeapon: true` override (it becomes default).

### `claudeville/src/presentation/character-mode/AgentSprite.js`

**Rename and reshape vector draw routines** (lines 1044-1143):

| Current | New | Notes |
|---|---|---|
| `_drawCodexDagger` (1044) | `_drawCodexMultitool` | Folding wrench-knife: 8px folded body, 4px deployed jaw, glyph dot on grip. |
| `_drawCodexKnightSword` (1055) | `_drawCodexRuneblade` | Rebuild blade silhouette (current is awkward). Add a 1px-wide rune-engraving line spanning the blade length in `#7be3d7` (codex teal accent), with a single 2×2px rune mark at the blade midpoint. |
| `_drawCodexShield` (1067) | (keep) | Used only by gpt55. |
| `_drawCodexGreatsword` (1087) | `_drawCodexShoulderWrench` | Shoulder-rest pose: head up-right of shoulder, handle down along body. ~28px overall length. |
| `_drawCodexBackGreatsword` (1101) | `_drawCodexBackWrench` | Same wrench shape, rear-facing geometry for n/ne/nw. |
| `_drawCodexPolearm` (1111) | **delete** | No character uses polearm post-refactor. |
| `_drawCodexSledgehammer` (1125) | **delete** | Already unused (no caller). |
| `_drawWeaponGripHand` (1136) | (keep) | Reused for all hand-held equipment. |

**Rename `_drawCodexEffortWeapon` (line 887) → `_drawCodexEquipment`.** Branch on `identity.equipment` kind, not effort tier. Layer logic stays the same (back/front split for back-carry vs held).

**Add `shoulderRest` geometry slot** in `_codexWeaponGeometry` (line 948-1005):

```javascript
const shoulderRest = {
    x: centerX + sideSign * bodyWidth * 0.30 * drawScale,
    y: shoulderY,
    flipX: sideSign < 0,
    angle: this._wrenchShoulderLeanForDirection(directionKey),
    scale: 0.94,
};
```

Add `_wrenchShoulderLeanForDirection(directionKey)` helper alongside the existing `_heldWeaponLeanForDirection`, `_greatswordLeanForDirection`, `_polearmLeanForDirection` (lines 1022-1042). Lean values to be tuned during implementation; starting point: e/w = -0.45 (heavy backward lean), se/sw = -0.20, s = -0.05.

**`_weaponBackCarryDirection(directionKey)` (line 1018)** — keep as-is. Routes wrench north-facing renders through the back-carry path.

### Pixel scrubber tuning — `_clearBakedCodexSidearmPixels` (lines 537-583)

Add per-class branching to both the color selectors at `_markBakedWeaponPixels:618-622` and the mask zones at `_bakedWeaponMaskZones:586-603`.

**New helpers:**

```javascript
_bakedWeaponSelectorsForClass(modelClass) {
    // Returns the four boolean expressions used to flag weapon pixels,
    // tuned to avoid clipping each character's palette.
}

_bakedWeaponMaskZonesForClass(modelClass, directionKey, cellSize) {
    // Returns the per-direction rectangles to scan, tuned per character.
}
```

**Per-class tuning targets:**

| Character | Color selectors that need narrowing | Mask zone adjustments |
|---|---|---|
| `gpt55` | (current values are baseline — they were tuned here) | (current values are baseline) |
| `gpt54` | `goldHilt` (`r>150 && g>95 && g<190 && b<95`) overlaps brass goggles; raise `g<170` upper bound. `greyMetal` overlaps mechanical gauntlet; consider per-zone gating. | Possibly widen `nw`/`w` zones — gauntlet sits where mask currently scans for sidearm. |
| `gpt53spark` | `cyanBlade` (`g>150 && b>150 && r<170`) overlaps cyan visor lens; raise `g>180` to spare visor pixels. `goldHilt` overlaps yellow lightning sash; tighten `r>165` minimum. | Tighten `s`/`se` zones — sash crosses the lower-right where blade scrubber currently sweeps. |

Calibration is empirical: load the character with the flag enabled, screenshot at 1× zoom in all 8 directions, identify clipped body pixels, narrow selectors. The browser cache key `cleanupKey` (`AgentSprite.js:462`) invalidates on flag flip, so iteration is reload-fast.

### `claudeville/assets/sprites/manifest.yaml`

**Bump `style.assetVersion`** (line 2) to a new tag — e.g. `2026-04-28-codex-engineer-tools-v1`.

**Rewrite Codex character prompts** (lines 42-67). Lead with armor identity, describe hands positively, drop the long negative list:

```yaml
- id: agent.codex.gpt55
  tool: create_character
  prompt: "Codex GPT-5.5 techno-paladin captain, navy plate armor with gold trim,
    peaked captain helm with crest, teal energy core on breastplate, shoulder pauldrons,
    palms loose at sides fingers visible, sheathed longsword on hip belt visible at rest,
    commanding upright stance, 8-direction pixel art"
  n_directions: 8
  size: 92
  animations: [walk, breathing-idle]
  palette_layer: codex
  anchor: [46, 80]
  mode: pro

- id: agent.codex.gpt54
  tool: create_character
  prompt: "Codex GPT-5.4 senior battle-engineer, deep teal half-plate with brass utility belt,
    brass goggles on helmet, mechanical bronze gauntlet on left forearm,
    palms loose fingers visible, small backpack toolkit with antenna,
    sturdy grounded stance, 8-direction pixel art"
  n_directions: 8
  size: 92
  animations: [walk, breathing-idle]
  palette_layer: codex
  anchor: [46, 80]
  mode: pro

- id: agent.codex.gpt53spark
  tool: create_character
  prompt: "Codex GPT-5.3 Spark scout-duelist, light teal leather armor with yellow lightning sash,
    backwards visor helm with cyan lens, runner boots, palms loose fingers visible,
    folded multitool clipped to hip belt, agile alert stance, 8-direction pixel art"
  n_directions: 8
  size: 92
  animations: [walk, breathing-idle]
  palette_layer: codex
  anchor: [46, 80]
  mode: pro
```

Note: `mode: pro` is added per-entry. The character generation script (`scripts/sprites/generate-character-mcp.mjs`) will need to read this field and pass it to `mcp__pixellab__create_character`.

## PixelLab regeneration workflow

1. Verify current Tier-3 balance via `GET https://api.pixellab.ai/v2/balance`.
2. For each of three Codex characters, in sequence:
   - `mcp__pixellab__create_character` with `mode: pro`, the new prompt, `image_size: {width: 92, height: 92}`, `n_directions: 8`, `view: 'low top-down'`. Pro mode ignores `outline`/`shading`/`detail` per `pixellab-reference.md:190`.
   - `mcp__pixellab__animate_character` with `template_animation_id: 'walking-6-frames'`.
   - `mcp__pixellab__animate_character` with `template_animation_id: 'breathing-idle'`.
   - Poll `mcp__pixellab__get_character` every 60s until both animations show progress 100. Pro-mode bake takes ~10-15 min per character.
   - Download the character ZIP from the response URL.
   - `node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path>` assembles the 736×920 sheet into `claudeville/assets/sprites/characters/<sprite-id>/sheet.png`.
3. `npm run sprites:validate` — manifest ↔ PNG bidirectional check.
4. `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` — pixelmatch baseline. Expect intentional diff in the three Codex rows only.

**Cost:** 3 × pro create (20-40 gen each) + 3 × 2 animations × 8 directions template (16 gen per char) = **108-168 generations**. ~1.7% of monthly tier-3 budget.

**Seeds:** not reused (none currently set in manifest). PixelLab picks fresh seeds. Reproducibility via the new prompts + saved character_ids returned by the API.

## Validation

| Gate | Command / check | Pass criterion |
|---|---|---|
| Syntax | `node --check claudeville/src/presentation/shared/ModelVisualIdentity.js` and `node --check claudeville/src/presentation/character-mode/AgentSprite.js` | No errors |
| Manifest | `npm run sprites:validate` | Three Codex sheet PNGs present, no orphans |
| Visual diff | `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` | Diff localized to `agent.codex.*` rows |
| Live scrubber | Browser at zoom 1, all 8 directions per character, effort tier toggling low→max | No body pixels clipped by scrubber; no double-weapon visible |
| Equipment grip | Multitool/wrench/sword visually attached to hand at all 8 directions, both walk and idle | No floating; no clipping into torso |
| Effort signal | Floor ring visible for low/medium/high; crown visible for xhigh/max; both coexist with equipment | Both readable simultaneously |
| Playwright capture | New script `scripts/sprites/capture-codex-equipment.mjs` — Playwright load, force each Codex × each effort tier × each direction, screenshot to `agents/research/codex-equipment-coherence/captures/` | Generated grid; manual visual review |
| Documentation parity | `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` | Empty (root agent docs in sync) |

## Scope boundaries

- **Claude mages untouched.** Opus/Sonnet/Haiku keep their current baked staves. No symmetric runtime-staff system. Mages with vertical-grip baked staves work; the asymmetry is intentional.
- **`agent.codex.base` placeholder unchanged.** Used as fallback only.
- **Gemini agent unchanged.**
- **World enhancement plan integration.** This work corresponds to a new entry under Tier 1 of `agents/plans/world-enhancement-plan.md`: "#39 Codex equipment coherence — REVISED CLASS GRAMMAR" (per opus's design-review recommendation). Insert after #38 in a follow-up commit.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pro-mode regeneration produces different weapon shapes baked in | Medium | Scrubber tuned to handle baked-weapon residue; per-class selectors as safety net |
| Color selectors clip non-weapon body pixels (sash, gauntlet, visor) | High | Per-class selector tuning is part of the pass, not a follow-up |
| `shoulderRest` geometry leans wrong at some directions | Medium | Lean angles tuned via browser inspection during implementation |
| Pro-mode bake exceeds expected duration | Low | 10-15 min per character × 3 = ~45 min total; if any character stalls past 30 min, restart with same prompt + new character_id |
| Visual diff baseline drifts for non-Codex agents due to manifest version bump | Low | The version bump only invalidates browser cache, not the PNGs themselves; non-Codex sheets are unchanged on disk |
| `scripts/sprites/generate-character-mcp.mjs` does not currently support `mode: pro` from manifest | Medium | Verified during implementation; if absent, add a small flag-pass-through |

## Effort estimate

- Code refactor (`ModelVisualIdentity.js` + `AgentSprite.js` + scrubber tuning): **S-M (~2-4 hours)**
- Manifest prompt rewrite + version bump: **S (~30 min)**
- PixelLab pro-mode regeneration (3 characters): **M (~45-60 min wall-clock, mostly waiting)**
- Scrubber per-class calibration via browser inspection: **M (~1-2 hours, iterative)**
- Playwright capture script + grid review: **S-M (~1 hour)**
- Total: **half-day to full day**, plus ~150 PixelLab generations.

## Open questions / explicit deferrals

None within this spec. Per user direction (Q2: "no followup, everything in this pass"), all calibration and Playwright capture work is included.

## File touch list

```
claudeville/src/presentation/shared/ModelVisualIdentity.js
claudeville/src/presentation/character-mode/AgentSprite.js
claudeville/assets/sprites/manifest.yaml
claudeville/assets/sprites/characters/agent.codex.gpt53spark/sheet.png  (regenerated)
claudeville/assets/sprites/characters/agent.codex.gpt54/sheet.png       (regenerated)
claudeville/assets/sprites/characters/agent.codex.gpt55/sheet.png       (regenerated)
scripts/sprites/generate-character-mcp.mjs                              (if pro-mode flag pass-through is missing)
scripts/sprites/capture-codex-equipment.mjs                             (new)
agents/plans/world-enhancement-plan.md                                  (insert entry #39 in a separate commit)
```

## References

- Subagent reports archived in this conversation: haiku (pixel-art weapon convention survey), sonnet (technical 4-path analysis), opus (design coherence review).
- `docs/pixellab-reference.md` — generation cost table, parameter reference, MCP/REST split.
- `agents/plans/world-enhancement-plan.md` — Tier-1 placement reference.
- `claudeville/CLAUDE.md` — validation checklist.
