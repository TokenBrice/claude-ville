# Let's Make Astra Model Really Epic

**Status:** `implemented and character-verified`

**Date:** September 9, 2026

**Scope:** Astra's character art, signature equipment, animation integration, and visual verification. Luna remains the reference for the lighter class.

**Baseline:** repository v0.45.2; current shipped Astra sheet and maintainer's Astra/Luna screenshot.

## 1. The result we want

Astra should read immediately as the heaviest, most formidable warrior in the village: a celestial juggernaut with dark monumental armor, a commanding silhouette, and a weapon that belongs to her alone. Her power should be apparent while standing still at normal village zoom, with no nameplate and no effects.

Recommended direction: **Astra, the Starforged Sovereign**, carrying **Worldsplitter**, a colossal sovereign's halberd. The maintainer suggested a polearm or halberd; this plan recommends the halberd for its unmistakable axe-head silhouette and commanding vertical presence. These are art-direction names; keep the product's model label “GPT-6 Astra.”

The four pillars, in priority order:

1. A permanent, unmistakable signature weapon.
2. Obsidian-blue armor, aged gold, and restrained violet-white celestial accents.
3. Broad shoulders, thick armor, heavy boots, and grounded posture.
4. An integrated crown-like helmet and a substantial imperial mantle.

Success is recognition, weight, and craft at the existing pixel scale. More particles, a larger world, or a new rendering system are not required.

## 2. What the current implementation tells us

Source observations, distinct from the proposed art decisions below:

- `manifest.yaml` describes Astra in polished silver plate, a small star crest, and a short violet cape. Inspection of the shipped sheet confirms a narrow silver body, especially in side views. Luna's prompt also emphasizes silver armor.
- Astra is already registered as `mythic` with a `deliberate` mood. This project does not need a new model class or provider mapping.
- `ModelVisualIdentity.js` assigns Astra Luna's `crescentSaber` at absent/low effort, `runeblade` at medium, Sol's `dawnblade` at high, and `polearm` at xhigh/max/ultra. This directly weakens a stable visual identity.
- `AgentSprite.js` also has an Astra fallback equipment mapping. Both mappings need coherent treatment.
- Terra already owns the `earthbreaker` warhammer; Sol owns the radiant `dawnblade`. A generic hammer or glowing gold sword would shift the resemblance to another character.
- Astra's base sprite is empty-handed. Equipment is composed at runtime through `CodexWeaponPose.js` and the Astra-specific `AstraWeaponPose.js`. The new weapon should follow this architecture.
- The base sheet uses 92px cells, eight direction columns, six walk rows and four idle rows: 736×920px. Current generation metadata is 76px, pro mode, with anchor `[46, 80]`.
- Astra already has a separate authored `read` action strip, with both hands occupied and equipment sheathed. A replacement body must not switch back to the old silver outfit when reading.
- The current portrait crop is `{ x: 28, y: 14, w: 36, h: 36 }`. A broader helmet and shoulders require a fresh crop review.
- Astra currently declares zero emission and no character sidecars. Adding authored glow or mixed materials is optional work, not an existing asset that can simply be recolored.

Implementation references: [manifest](../../claudeville/assets/sprites/manifest.yaml), [identity policy](../../claudeville/src/presentation/shared/ModelVisualIdentity.js), [World equipment](../../claudeville/src/presentation/character-mode/AgentSprite.js), [weapon pose](../../claudeville/src/presentation/character-mode/AstraWeaponPose.js), [shared grip composition](../../claudeville/src/presentation/character-mode/CodexWeaponPose.js), [avatar rendering](../../claudeville/src/presentation/dashboard-mode/AvatarCanvas.js).

## 3. Art specification

### Silhouette and body

Use a powerful armored humanoid with a broad inverted-triangle torso, layered oversized pauldrons, a deep breastplate, substantial forearm armor, and wide planted boots. Preserve visible joints and a gap between the legs so the body does not become a solid block.

Starting proportions for concept evaluation, measured on opaque body bounds excluding the weapon: shoulders roughly 25–35% wider than Luna, body roughly 5–15% taller. These are design targets, not measured current differences or required runtime scale multipliers. Fit the approved artwork into the existing 92px cell with room for movement and crest; reduce ornament before sacrificing frame safety.

The helmet has a low integrated three-point crown with one central star point. Keep its silhouette separate from the existing floating effort accessories. The face is a narrow pale violet visor beneath a substantial brow. Avoid delicate horns, a huge floating halo, or a crown that collides with effort crests.

The mantle is deep imperial violet, broad across the back and falling toward the calves. Use two or three large folds and one clear gold border. Front views must still communicate weight without relying on the cape; rear views should remain recognizable from the mantle and shoulders.

### Palette

These are proposed swatches for art production, subject to native-size review. They are not automatic emission keys or changes to the shared Codex palette.

| Role | Starting colors | Purpose |
| --- | --- | --- |
| Armor shadow / outline | `#151B2B` | Deep blue-black structure |
| Armor body | `#303C52`, `#53627A` | Readable metal planes above the darkest background |
| Metal edge | `#91A0B8` | Selective sharp edges, without returning to a silver body |
| Aged gold | `#8D6535`, `#C49A52`, `#E7CA83` | Rank, crown, guard, and limited trim |
| Mantle | `#302342`, `#59406D` | A substantial distinct fabric mass |
| Celestial accent | `#BCA7EF`, `#E8DEFF` | Visor, one breastplate star, and one weapon inlay |

Aim for approximately two-thirds dark armor, one-fifth mantle, and the remaining visible area in trim and highlights. Judge the image, not exact pixel percentages. Keep gold out of large armor panels so Astra does not become a second Sol. Maintain enough armor midtone to survive night lighting; “obsidian” must not mean an unreadable black silhouette.

Keep the registry's existing lavender identity accent unless actual UI review exposes a mismatch. Do not recolor Luna or edit the shared `codex` palette to solve Astra's body colors. If a dedicated palette key proves necessary after checking how palette replacement is consumed, scope it to Astra and update both palette mirrors.

### Worldsplitter: the signature weapon

Choose a colossal halberd with a long dark shaft, a broad angular axe head on one side, a short opposing armor-piercing beak, and a substantial spear point above. Use an aged-gold collar and one recessed violet-white four-point star in the head. Its mass comes from the large axe face and thick socket, with clear negative space around the beak and point. Keep the design simple enough that the three-part head reads at village scale.

Starting target: overall weapon length around 1.3–1.5 times the standing body height, with the axe head roughly one-third of the shoulder span. These are concept targets; validate composed bounds and label clearance before fixing dimensions. A proposed manifest ID is `equipment.codex.worldsplitter`; select the final asset dimensions and measured grip anchor during integration. Compare against the existing `equipment.codex.polearm` as well: Worldsplitter needs a broader axe silhouette and dark/gold/violet identity, distinct from that weapon's crescent icy-steel glaive and cyan inlays.

At rest, hold it nearly upright beside the body with a slight outward lean, making a tall commanding silhouette without covering the helmet or nameplate. During walking, use a controlled diagonal carry with enough clearance for the shaft's lower end. Use a physically plausible hand connection in every direction. A two-handed pose is optional only if the authored body and grip system support it cleanly; do not draw a second floating hand to imply support. Use the existing read-action sheathing contract to stow or suppress it while both hands are occupied; review whether a long polearm needs Astra-specific stowed placement rather than assuming sword placement will work.

The weapon must remain distinct in a black silhouette comparison with Luna's curved saber, Sol's radiant greatblade, Terra's hammer, and the existing Codex glaive. Reject a thin generic spear, a recolored existing polearm, an axe head that hides the whole body, or gold ornament that loses its shape at village scale. The upright carry should feel like a sovereign's guard stance; the huge axe head supplies the battlefield weight.

### Motion and restraint

Walk: controlled steps, restrained torso bounce, a slight delayed mantle response, stable weapon mass, and firm foot contact. Idle: slow breathing and a small weight shift. Reading: the same armor, helmet, and mantle with a correctly stowed weapon.

Use existing timing and mood controls where they suffice. Do not slow actual navigation or delay status transitions for theatrical effect. Review animation against displacement so a heavier gait does not create foot sliding.

Optional final refinement: a tiny authored visor or blade emission mask. Keep it static or use existing motion infrastructure. No new particle system, permanent aura, camera shake, ground shockwaves, extra lights, or new postprocessing pass in the core scope. Reduced motion and Canvas fallback must retain the full character identity.

## 4. Effort and model identity

**Proposed behavior change:** Astra carries Worldsplitter at every effort level, including absent effort. Effort continues to use the existing labels, floor indicators, and distinct xhigh/max/ultra accessories.

This intentionally replaces the current weapon progression, which is asserted in `scripts/tests/model-registry.test.mjs`. Update that contract explicitly. Low-effort Astra should still look like Astra. A changing workload should not change her weapon family.

Avoid adding effort-dependent weapon variants in this pass. If later desired, small changes to the same blade's inlay could be explored without changing silhouette or taking attention from approval/error states.

Keep model IDs, resolution rules, provider badges, context metadata, and other characters' equipment behavior intact. Review crown/accessory stacking at all tiers; adjust Astra-specific placement only if needed.

## 5. Production sequence and checkpoints

### Phase A — establish the comparison and concept

1. Capture current Astra and Luna side by side at equal world zoom, plus Sol and Terra as adjacent-class references. Include body-only and equipped views, south, east, and north. Capture Astra's current effort states.
2. Prepare two focused concept candidates using the same palette and weapon family: A, broad sovereign armor with a full mantle; B, slightly more angular fortress armor with a split mantle. Recommend A unless its cape dominates the body.
3. Show each at native size and 2× beside Luna. Include silhouette and grayscale comparisons, with a rough weapon composition. Large promotional illustrations are insufficient evidence for this decision.
4. Select the strongest candidate before commissioning complete animation sets. Record the selected prompt, dimensions, reference, and why it won. Candidate work stays outside production asset paths until selected.

Checkpoint: the body alone reads heavier than Luna, and the equipped figure has a distinct weapon silhouette. No generation or credit spending is part of preparing this plan; implementation should quote the selected work and live balance through the maintained workflow before submitting generation jobs.

### Phase B — produce one coherent body and weapon

1. Follow [sprite-character](../../.claude/skills/sprite-character/SKILL.md) and the [canonical runbook](../../scripts/sprites/generate.md). Read the PixelLab reference when executing calls; use current tool schemas and a live balance rather than historical credit figures.
2. Preserve the canonical character ID `agent.codex.gpt6astra`. Update its subject prompt and verify generation size/mode independently of the 92px engine cell. Start from the known 76px/pro setup unless the approved concept needs a reviewed adjustment; a larger source can be cropped during assembly.
3. Generate an empty-handed body rig with all eight directions. Inspect direction consistency before ordering walk and idle animations. Record the new rig ID; do not reuse old provenance for new artwork.
4. Generate the six-frame walking and four-frame breathing-idle groups through the runbook. Assemble using explicit returned animation IDs; review all 80 body cells for clipping, planted feet, armor continuity, cape motion, and empty hands.
5. Add and produce only the Worldsplitter equipment entry. Review alpha cleanup, pixel scale, outline, colors, and grip coordinates before composing it with Astra.
6. Regenerate the existing `read` action strip from the accepted new rig. Retain its separate layout and sheathing contract. If the new read strip cannot pass review, use the documented strip-less fallback and record the temporary visual regression; never ship the old silver strip with the new body.
7. Re-evaluate the portrait crop and body anchor using actual visible bounds. Preserve foot placement across idle, walk, reading, and direction changes.

Checkpoint: complete coherent art, with no outfit changes between poses and no duplicated weapon baked into the body.

### Phase C — integrate equipment and materials

1. Change Astra's effort and fallback equipment policies to Worldsplitter. Add the corresponding asset definition and include it in equipment-capture loading.
2. Inspect the new body's actual hand locations across every frame. Recalibrate the Astra-specific pose logic as needed; old coordinates are not evidence of a correct grip on new art.
3. Update Astra's gauntlet palette in `CodexWeaponPose.js` to match the body. Review front/back weapon layering, turns, resting angle, read sheathing, and return to idle.
4. Check composed GPU sheet padding, weapon overhang, clipping/culling, and Canvas composition. Reuse the existing equipment paths; expand bounds only where the new asset demonstrates a need.
5. If materials add visible value, author reviewed metal/fabric masks and an Astra `PROFILES` entry. For any emission, explicitly select the intended source pixels and follow the [material contract](../../docs/material-channel-contract.md); do not infer emission from brightness. Start with readable albedo and zero emission.
6. Run channel authoring only after reviewing its write scope; inspect the resulting diff and retain task-owned changes only. Do not expand a static atlas merely because Astra has new art. If an existing atlas depends on a changed source, rebake that affected atlas deterministically.
7. Bump `style.assetVersion` once when the accepted PNG bytes change. Update owner documentation for the new permanent weapon policy.

Checkpoint: the same silhouette, weapon, grip, and state meaning in World and Dashboard, with coherent GPU and Canvas presentation.

### Phase D — prove the result in the village

Use the maintained server at `http://localhost:4000`, started with `npm run dev`; if already running, verify and use it without killing the port. Use controlled comparison scenes alongside a live-session check.

| Review | Required evidence |
| --- | --- |
| Identity | Astra/Luna/Sol/Terra together at normal zoom, labels hidden for the comparison; body-only, equipped, grayscale, silhouette |
| Direction and motion | Eight directions × all six walk and four idle frames; playback for grip drift, cape flicker, foot sliding, and turning |
| Effort | absent, low, medium, high, xhigh, max, ultra; same signature weapon and readable existing effort distinctions |
| Authored action | Read entry, held read, and return; no old outfit, duplicate blade, or detached equipment |
| Lighting | Clear day, dusk/night, and storm; ordinary and selected states, with and without decorative effects |
| Occlusion and attention | Near buildings, behind scenery, and in a crowd; thought bubbles and approval/error marks remain readable |
| Surfaces | World GPU, Canvas fallback, Dashboard avatar and relevant portraits; no squeezed body or clipped crown |
| Motion preferences | Reduced motion and frozen views still communicate rank and identity |

Use 1280px and a larger desktop viewport for the final World/Dashboard fit check. Preserve the desktop-only layout. Judge actual gameplay size first, then zoom in to diagnose defects.

## 6. Files and scope

Expected production files:

- `claudeville/assets/sprites/manifest.yaml`: Astra prompt/provenance/crop, new weapon, optional channel declarations, asset version.
- `claudeville/assets/sprites/characters/agent.codex.gpt6astra/`: base sheet, replacement read strip, optional reviewed companions.
- `claudeville/assets/sprites/equipment/equipment.codex.worldsplitter.png`: proposed new weapon path.
- `claudeville/src/presentation/shared/ModelVisualIdentity.js`: permanent Astra equipment identity.
- `claudeville/src/presentation/character-mode/AgentSprite.js`: equipment definition and fallback, bounded composition adjustments if needed.
- `claudeville/src/presentation/character-mode/AstraWeaponPose.js` and `CodexWeaponPose.js`: measured grip and matching gauntlet colors.
- `scripts/sprites/capture-codex-equipment.mjs`: new asset loaded by the maintained capture tool.
- Focused existing model/equipment/pose tests and nearest-owner docs.

Conditional files: `author-roster-channels.mjs` and sidecars for reviewed materials; both palette mirrors only if adding an Astra-specific palette; avatar rendering only if crop metadata cannot solve a demonstrated fitting issue. Registry source/generated modules need no change unless a deliberate registry field changes.

Keep Luna's assets, shared palette, unrelated worktree changes, model pricing, adapters, server, world layout, and other characters outside this work. Add no runtime dependency, framework, build step, or general rendering rewrite.

## 7. Verification commands and limits

During implementation, after the relevant changes:

```bash
node scripts/sprites/plan.mjs --ids=agent.codex.gpt6astra
npm run sprites:audit-refresh
node scripts/sprites/contact-sheet.mjs --groups=characters
npm run models:resolve -- codex gpt-6-astra
npm run models:check
node --test scripts/tests/model-registry.test.mjs scripts/tests/astra-weapon-pose.test.mjs scripts/tests/r4-dialogue.rendering.test.mjs
node scripts/sprites/capture-codex-equipment.mjs --model=gpt6astra --all-frames --verify-gpu --out-dir=output/astra-epic-review
npm run verify:render
npm run sprites:capture-fresh
npm run sprites:visual-diff
npm run verify:architecture
npm run check:artifacts
```

Update the existing effort test to assert the permanent weapon while retaining effort marker and model identity checks. Add focused regressions only for demonstrated new risks such as composed bounds or incorrect sheathing; avoid tests that merely duplicate configuration.

The sprite visual-diff suite is building-focused and cannot establish Astra's quality. The dedicated character/equipment captures and manual browser judgment are mandatory. Missing baselines should be reported, not silently replaced. `verify:render` provides console/screenshot evidence, not artistic approval or a performance benchmark.

Run `validate:quick` after integration. If composition bounds or caches change materially, compare a matched scene's frame/resource metrics to the baseline; reject an unexplained regression rather than introducing broad performance work. Release checks and changelog/versioning apply only when a release is requested.

## 8. Acceptance and delivery

The work is ready when:

1. At ordinary village scale, a reviewer can distinguish Astra from Luna without labels, both equipped and body-only.
2. Astra reads as the roster's heaviest warrior through armor mass, stance, and weapon; she remains recognizable from the back and side.
3. Worldsplitter remains her signature at every effort level and does not resemble Sol's blade or Terra's hammer.
4. All directions and frames have coherent gear, hands, feet, palette, and bounds; read mode and portraits use the new identity.
5. Night, reduced motion, and Canvas preserve legibility. Status/selection/approval information remains visually stronger than decorative emission.
6. Focused validation passes, relevant command limitations are recorded, and the final diff contains only task-owned changes.

Deliver one approved body sheet, one signature weapon, the matching read strip or an explicitly recorded fallback, updated integration and tests, and a concise before/after contact sheet plus motion/browser evidence. Keep disposable generation caches under `output/`; index any retained evidence under `agents/research/`.

For recovery, record the pre-change revision and changed asset paths before integration. Restore the Astra art, pose, identity policy, and metadata as one coherent set through a reviewed reverse patch if needed; avoid broad checkout resets. Never pair the new pose with an old body during rollback.

Relative effort: concept selection and grip/animation review are the main uncertainties; policy wiring is small. Allocate work in the four phases above, with production spending limited to the selected character and weapon, and targeted retries for failed directions/groups. Record live generation quotes and actual spend during execution; no fixed credit or calendar estimate is claimed here.

## 9. Starting production brief

Prepend the current manifest style anchor to this subject-only body prompt, then refine against the selected native-size concept:

> Celestial sovereign Astra, the heaviest armored warrior in an old-school fantasy RPG village. Broad monumental dark blue-gunmetal plate armor, layered massive pauldrons, thick breastplate with one aged-gold four-point star, heavy gauntlets and broad planted boots. Low integrated crowned helmet with a central star point and a narrow pale violet visor. Substantial deep imperial violet mantle with large simple folds and restrained aged-gold border. Powerful compact humanoid proportions, visibly wider torso than a light silver skirmisher, clear articulated joints and leg separation. Dark armor planes remain readable with selective steel-blue highlights. Identical outfit, proportions, and colors from every viewing angle. Empty visible hands positioned for a runtime weapon. No held weapon, shield, floating halo, particles, ground effect, pedestal, or background. Clear silhouette at native pixel size, eight-direction character.

Weapon subject brief:

> Worldsplitter, Astra's colossal sovereign's halberd. Long thick dark shaft, massive angular dark blue-gunmetal axe head on one side, short opposing armor-piercing beak, and substantial spear point above. Clear negative space separates the three-part head silhouette. Thick aged-gold socket and restrained gold shaft collars, selective pale steel cutting edge, one recessed pale violet four-point star in the axe face. Monumental weight and commanding vertical presence, simple readable silhouette, cohesive old-school fantasy pixel art. Full weapon fits within the canvas with clear margin around the point and shaft end. Isolated weapon, transparent background, no hands, no character, no particles, no bloom cloud, no lettering.

Final creative test: Luna is a capable skirmisher. Astra should look like the sovereign whose arrival changes the battle plan.

## 10. Execution record — September 9, 2026

Implemented against `0550806207cf026c71f9e1c8e15e08ccf4c82597` following maintainer authorization, including the requested substantial cape. [Retained visual evidence](../research/astra-epic/README.md) accompanies this record. The maintainer subsequently authorized committing and publishing this work as `v0.45.3 — The Starforged Sovereign`.

### Delivered

- New dark gunmetal/gold sovereign body, broad armor, integrated crown, pale violet visor, and full calf-length violet cape. The first complete rig passed the Luna/old-Astra comparison, so a second speculative rig was unnecessary.
- Permanent Worldsplitter halberd at all seven effort states; existing effort rings/crests retain their meaning. New equipment is 112×112 with measured shaft anchor `[36, 68]` and scale `0.78`; its pose stands upright at rest and leans during walking.
- Updated all 80 wrist coordinates, matching gauntlet palette, and portrait crop `[23, 12, 46, 42]`. The crop supports a crisp 2× hero portrait within the existing fitting policy.
- Replaced 736×920 walk/idle sheet and 736×368 read strip. Read poses suppress the halberd while the hands are occupied. New assets use `2026-09-09-astra-worldsplitter` cache version.
- Preserved Luna and the other roster assets, shared palettes, model registry metadata, and existing runtime architecture. The body and weapon remain readable without new emission, materials, lights, particles, or motion clocks.

### Source provenance and selection

| Asset/group | PixelLab source | Selection |
| --- | --- | --- |
| Body rig | `a1da82e8-9dc7-410c-9c5e-81698604ab2c` | 76px pro, eight directions |
| Walk | `7473bf5a-38e5-45ab-bbfc-11fc238c2eb5` | Template `walking-6-frames`; ZIP key `animating` |
| Idle | `ca134b92-f184-49d1-85bb-98d44d7c43a4` | Template `breathing-idle`; ZIP key `animating-ca134b92` |
| Rear walk repair | `c68fa3a8-302f-4dcc-aa8b-2e5e1f0ad1c2` | ZIP key `astra-caped-walk-repair`; north/north-east/north-west only, 96px export, skip the leading reference and retain six animated frames |
| Read | `6b29a379-57d5-482d-a4a9-961dbace148f` | `claudeville-read-v1`, four frames per direction; 88px south export and 96px other exports centered into 92px cells |
| North read repair | Direction record `4ae1f893-d4d1-42fb-a99a-c1621590cad6`, same read group | Latest north frames; lowered arms and book hidden by the body from behind |
| Halberd | Map object `93cba3fb-b609-40c2-bba8-018f893932f4` | Transparent 112px PNG, side-view generation |

The default walking template removed the cape in three rear directions; those 18 cells were replaced through a custom v3 walk. A pixel comparison verified that all unselected cells remained byte-identical. The first north read raised its book above the helmet; the replacement keeps the book below the shoulders and hidden from behind. The source-aware frame cache was verified by assembling and inspecting the new north pose instead of the cached rejected pose.

PixelLab balance changed from 2,000 to 1,951 generations: **49 used** (20 rig, 1 weapon, 16 base animation directions, 3 cape repairs, 8 read directions, 1 north-read repair). No credit fallback was used. Final prompts live in the manifest; repair prompts are summarized above. Disposable exports and full capture grids remain under `output/astra-epic-*`.

### Necessary sprite-tool corrections

`generate-character-mcp.mjs` now supports explicit direction selection, explicit leading-reference omission, and a verified export-canvas override for partial group repairs. It still validates every selected frame before writing. The shared manifest writer now inserts after the complete multiline animation ledger; previously it could insert the read strip inside that ledger. A regression test covers the real failure and preservation of adjacent metadata/characters. Action-strip cache filenames now include the source frame URL's path hash, preventing a regenerated pose or replacement rig from silently reusing old pixels.

### Verification and limits

| Check | Result |
| --- | --- |
| `validate:quick` | Passed: 899 tests, architecture, model parity, syntax, artifact and ID checks |
| Focused follow-up tests and script syntax after cache fix | Passed: 11 tests and 219 script files |
| Final `sprites:audit-refresh` | Passed: no missing/orphan assets, palette errors, sheet errors, material errors, or warnings |
| `models:resolve -- codex gpt-6-astra` | Correct Astra identity and Worldsplitter equipment |
| Equipment capture `--all-frames --verify-gpu` | Passed: all 560 effort/direction/frame combinations, zero Canvas/GPU pixel differences |
| `verify:render` | Passed, 22.28s; evidence `/tmp/claudeville-render-vd2MdO` |
| Maintained-server visual review | Day/night/storm, approval with ultra crest, read pose, Dashboard, and 1280px portrait reviewed in both backends; no browser errors; authored read strip confirmed |
| Motion evidence | Recorded forced six-frame walk cycles through eight directions in the real World renderer; source grids reviewed for cape continuity and grip placement |
| Live session | Confirmed new asset version, cape, halberd, and portrait at `http://localhost:4000` |
| Building captures | All 20 fresh no-agent poses captured successfully |
| Building visual diff | **6/20 passed; 14 differed from stored baselines.** This no-agent suite does not test Astra. Building/terrain assets and rendering behavior were not modified; the historical mismatch cause was not isolated and baselines were not updated. This is a remaining broad visual-baseline limitation, not a claimed passing check. |

The forced animation recording is a presentation review, not a navigation or performance benchmark. No new performance claim is made. The optional material/emission experiment was unnecessary for the accepted appearance. Broad historical baseline remediation remains outside this character redesign.
