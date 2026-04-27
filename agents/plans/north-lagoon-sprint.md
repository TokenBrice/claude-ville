# North Lagoon Sprint — Swarm Execution Plan

Generated: 2026-04-28  
Worktree: `.worktrees/north-lagoon` on branch `feature/north-lagoon-sprint`  
Baseline HEAD: `c96eed3` (matches origin/main, clean working tree)

Source spec: the North Lagoon Improvement Report distilled from parallel Opus + Sonnet + Haiku audits. This plan formalises that report into shippable workstreams under the project Swarm SOP.

## Scope decisions

**Ship now (this swarm):** Tier A complete (A1–A6) + Tier B complete (B1–B7).

**Defer (write follow-up plan, do not implement here):** Tier C in full.
- C1 three-tier ecology — needs new sprite generation pipeline + animation systems
- C2 time-of-day signatures — entangled with broader AtmosphereState plumbing
- C3 git-correlated debris — requires adapter changes outside the lagoon's blast radius
- C4 Command stepping-stones bridge — requires sprite work tightly coupled to bridge system

## Worker dispatch (Full Swarm per SOP)

| Worker | Model / effort | Owned paths | Items |
|---|---|---|---|
| **W1 CORE** | Sonnet · high | `claudeville/src/presentation/character-mode/IsometricRenderer.js`, `claudeville/src/presentation/character-mode/SceneryEngine.js` | A1, A2, A3, A4, A6, B1, B7 |
| **W2 ASSETS** | Opus · high | `claudeville/assets/sprites/manifest.yaml`, new PNGs under `claudeville/assets/sprites/{vegetation,props,buildings}/` | B2, B3, B4, B6 (manifest entries + Pixellab generation) |
| **W3 SCENERY-A** | Sonnet · medium | `claudeville/src/config/scenery.js` | A5 (remove dead `OPEN_SEA_BIRDS` export), B5 (place existing harbor props near lagoon) |
| **W4 SCENERY-B** | Sonnet · medium | `claudeville/src/config/scenery.js` | B2 lilypad placements, B4 mangrove root placements, B6 driftwood placements (depends on W2 + W3) |
| **REVIEWER** | Opus · high | none (notes-only) | Full diff review across all four workers |

### Sequence

```
Phase 1 (parallel):  W1 ─┐
                     W2 ─┤  (no shared paths)
                     W3 ─┘

Phase 2 (sequential after W2 + W3):  W4

Phase 3:  REVIEWER (notes-only, sees all diffs)

Phase 4 (orchestrator):  validate → commit → push → merge to main
```

Concurrency cap: 3 active workers in Phase 1 (within 5-agent limit).

## File ownership map

| Path | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `IsometricRenderer.js` | own | — | — | — |
| `SceneryEngine.js` | own | — | — | — |
| `manifest.yaml` | — | own | — | — |
| sprite PNGs (new) | — | own | — | — |
| `scenery.js` | — | — | own (Phase 1) | own (Phase 2) |

No write conflicts; only sequencing constraint is `scenery.js` between W3 and W4.

## Tier A — implementation specs

### A1 · Add `deepRatio` for `'river'` basins
- **File:** `SceneryEngine.js:130, 186`
- **Change:** `kind === 'moat' ? 0.5 : 0` → `kind === 'moat' ? 0.5 : kind === 'river' ? 0.35 : 0` (apply to both occurrences). Same pattern for line 186 (`0.64` → keep 0.64 for moat, `0.35` for river).
- **Rationale:** Unlocks centre-darkening, depth wash, wave amplitude variation already coded.

### A2 · Animated ripple ring on waterfall pools
- **File:** `IsometricRenderer.js:_drawTropicalWaterfalls` ~line 3733–3799
- **Change:** Replace static `ctx.ellipse` pool with an additional expanding ring drawn from `waterFrame` phase. Ring radius `lerp(0, poolRadius * 1.2)` over a 60-frame cycle, alpha fading from 0.45 to 0.

### A3 · Lagoon-specific shimmer colour
- **File:** `IsometricRenderer.js:_drawDynamicWaterHighlights` (line 1741), `_drawTerrainTone` (line 2900)
- **Change:** Detect lagoon water (basin kind === 'river') vs harbor sea, branch shimmer colour: warm teal `rgba(120,230,200,…)` for river, current cool blue for sea.

### A4 · Gull routes loop over lagoon
- **File:** `IsometricRenderer.js:54–62` (GULL_STAGING_WAYPOINTS), `76–150` (OPEN_SEA_FLOCK_ROUTES)
- **Change:** Add 2 staging waypoints near lagoon centre (`{tileX: 7.4, tileY: 8.6}`, `{tileX: 14.0, tileY: 9.6}`). Add one new flock route looping over lagoon (size 5–6 birds, route through `[6,9] → [11,7] → [16,9] → [13,11] → [8,11]`).

### A5 · Remove dead `OPEN_SEA_BIRDS` export
- **File:** `scenery.js:304`
- **Change:** Delete the `OPEN_SEA_BIRDS` constant block. Verify no other file imports it (`rg "OPEN_SEA_BIRDS" claudeville/`).

### A6 · Guard fish schools from lagoon depth-block regression
- **File:** `IsometricRenderer.js:_drawFishSchools` ~line 3297–3330
- **Change:** When iterating fish schools, allow placement on tiles that are deepWaterTiles **and** in a lagoon basin. Add a small permissive branch: if school's tile is in the lagoon kind basin, render even if marked deep.

### B1 · Shore foam / transition gradient
- **File:** `IsometricRenderer.js:_drawShoreCrest` line 2870–2884
- **Change:** Add a semi-transparent radial wash (3–6 px feather) outward from shore tile centre toward the water side. Alpha 0.18, colour matching tile's foam tone.

### B7 · Weather-reactive water palette
- **File:** `IsometricRenderer.js` water draw passes (1741, 2900)
- **Change:** Read `AtmosphereState` weather intensity. When weather === 'storm' or 'rain' with intensity > 0.4, lerp lagoon water tile colour toward darker desaturated variant. Add subtle rain-dimple noise.

## Tier B — sprite + placement specs

### B2 · Lily pad sprite + placement
- **W2:** Add manifest entry `veg.lilypad`, tool `map_object`, size 32, transparent isometric pad.
- **W4:** Place 3–4 entries in `scenery.js` near `tileX 13–16, tileY 7–9`.

### B3 · Mid-lake island shrine
- **W2:** Add manifest entry `prop.lakeShrine`, tool `map_object`, size 64. Prompt: weathered stone shrine with rune inset, mossy base, small offering bowl, glowing rune accent. Rationale: focal landmark on the existing waterfall island.
- **W4:** Place 1 entry near the existing mid-lake waterfall rock (target `tileX ≈ 11.5, tileY ≈ 8.5`).

> **B3 placement deferred (review fix).** The reviewer flagged that the candidate tile (11.4, 8.6) lies inside the lagoon basin and rasterises as water, so the shrine would float on a teal tile with no land beneath it. The sprite asset and manifest entry shipped; the placement entry was removed and is queued as a follow-up that requires either a basin-mask exception or authored island land-tile around the existing waterfall rock geometry.

### B4 · Mangrove root props at west shore
- **W2:** Add two manifest entries: `prop.mangroveRoot.twisted` (size 32) and `prop.mangroveRoot.arch` (size 48).
- **W4:** Place 2–3 entries at `tileX 6–8, tileY 7–10` along the west shore.

### B5 · Fishing props at lagoon shore (uses existing manifest entries)
- **W3 only.** No new sprite work.
- Place 1× `prop.netRack` at `tileX ≈ 6, tileY ≈ 8`. Place 1× `prop.harborBeaconBuoy` at `tileX ≈ 14, tileY ≈ 5.5`. Place 1× `prop.harborBeaconBuoy` at `tileX ≈ 20, tileY ≈ 11`.

### B6 · Driftwood / debris log
- **W2:** Add manifest entry `prop.driftwood.log` (size 48).
- **W4:** Place 1–2 at `tileX 7–8, tileY 9–10.5` in west shore shallows.

## Validation (orchestrator runs before commit)

| Check | When |
|---|---|
| `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js` | After W1 lands |
| `node --check claudeville/src/presentation/character-mode/SceneryEngine.js` | After W1 lands |
| `node --check claudeville/src/config/scenery.js` | After W3 + W4 land |
| `npm run sprites:validate` | After W2 lands |
| Visual smoke: launch `npm run dev`, open `http://localhost:4000`, pan to north lagoon | Before final commit |

## Out of scope explicit

- Tier C items (C1–C4): documented in a separate follow-up plan, not implemented here.
- No edits to character sprites, building sprites, or AgentSprite.
- No edits to root agent docs.
- No changes outside the file ownership map above.

## Commit policy

Per SOP commit-and-push gates: orchestrator commits after all four workers + reviewer have approved. Atomic commit per logical theme (one for renderer changes, one for sprites, one for scenery placements, one for plan doc) with conventional-commit prefixes. Push to origin/feature branch and open PR for merge.
