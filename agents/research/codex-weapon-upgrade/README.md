# Codex Epic Weapon Upgrade Exploration

Date: 2026-04-28

## Context

The current Codex equipment pass has improved coherence over the first baked-weapon attempt, but it still does not meet the "epic weapon" bar. The controlled capture grid confirms two separate issues:

- **Art quality:** GPT-5.5 swords and greatswords are drawn from simple canvas polygons. They read as clean debug overlays more than legendary weapons. GPT-5.4 and Spark props are coherent, but not visually ambitious.
- **Attachment:** The runtime draws a synthetic grip/hand on top of the weapon after the character sprite. The weapon origin, hilt, hands, and body occlusion are not all using the same anchor model, so the weapon can look pasted onto the torso instead of held.

Current captures:

- `agents/research/codex-weapon-upgrade/current-captures/gpt55-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/current-captures/gpt54-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/current-captures/gpt53spark-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/current-captures/codex-equipment-overview.png`

## Recommendation

Use a **hybrid runtime equipment system**:

1. Keep Codex base character sheets weapon-free.
2. Replace the primitive sword/greatsword drawings with weapon overlay assets generated or refined via Pixellab.
3. Add an explicit weapon attachment model: each weapon has a grip anchor, near-hand anchor, optional far-hand anchor, and direction-aware body occlusion.
4. Add polearm as a real equipment kind instead of hiding it inside `warlord`.

Do not solve this by rebaking full character sheets with held weapons. Baked weapons make attachment look natural in one generated frame, but they drift across 8 directions and 10 animation rows, and they multiply the number of character sheets needed for effort and weapon variants.

## Weapon Set

Start with four Codex weapons:

| Equipment | Intended use | Notes |
| --- | --- | --- |
| `runeblade` | GPT-5.5 none/low/medium | One-handed legendary sword, cyan rune channel, gold crossguard. |
| `greatsword` | GPT-5.5 high | Two-handed oversized sword, stronger silhouette and glow. |
| `glaive` / `polearm` | GPT-5.5 xhigh or Spark high/xhigh | Long shaft with crescent rune blade. Needs two-hand pose and back-layer shaft. |
| `engineerWrench` | GPT-5.4 | Keep as identity equipment, but upgrade to a battle-wrench/hammer silhouette. |

## Implementation Shape

### Asset Layer

Add a small equipment asset family, either as a new manifest group or as manifest entries with explicit `assetPath`:

```yaml
equipment:
  - id: equipment.codex.runeblade
    tool: create_map_object
    width: 96
    height: 96
    anchor: [60, 68] # grip point, not bottom-center
    prompt: "legendary Codex runeblade longsword..."
```

Required runtime metadata:

- `grip`: weapon-local coordinate that attaches to the character hand.
- `nearHand`: weapon-local coordinate for the visible wrapping hand/cuff.
- `farHand`: optional second hand point for greatswords and polearms.
- `bladeTip`: optional coordinate for glow/spark effects.
- `defaultAngle`: canonical drawn angle.

If we use Pixellab, `create_map_object` is the right MCP tool for a first pass because it supports transparent non-square weapon objects up to 400 px. The generated weapon should be treated as a raw source: inspect it, trim/normalize it, then commit only curated PNGs.

### Pose Layer

Replace the current freehand `rightHand`, `twoHanded`, and `shoulderRest` logic with direction-aware attachment profiles:

```js
const CODEX_WEAPON_POSES = {
  s:  { hand: [0.30, 0.58], angle: 0.12, layer: 'front' },
  se: { hand: [0.65, 0.54], angle: -0.08, layer: 'front' },
  e:  { hand: [0.70, 0.50], angle: -0.24, layer: 'front' },
  ne: { hand: [0.63, 0.46], angle: -0.42, layer: 'split' },
  n:  { hand: [0.57, 0.48], angle: -0.46, layer: 'back' },
  nw: { hand: [0.37, 0.46], angle: -0.42, layer: 'split' },
  w:  { hand: [0.30, 0.50], angle: -0.24, layer: 'front' },
  sw: { hand: [0.35, 0.54], angle: -0.08, layer: 'front' },
};
```

The values should be tuned against the capture grid. The point is that direction and occlusion become data, not embedded in one-off drawing routines.

### Render Layer

Draw weapons in three phases:

1. **Back pass:** shafts, far blade portions, capes, rear-facing weapons.
2. **Character pass:** unchanged sprite draw.
3. **Front pass:** near hilt/blade portions, hand wrap, glow accents.

The near hand should be drawn as a small Codex gauntlet cuff over the hilt, using the same provider trim palette as the character. That is the visual glue that makes the weapon look held.

## Pixellab Probe

Two Pixellab map-object samples were queued as viability tests:

- Runeblade: `fca1cfea-f02b-4db5-9711-11cbeb3b267e`
- Polearm/glaive: `05c2c4c8-ecba-4e62-93f8-f0a77fe7f480`

Saved probes:

- `agents/research/codex-weapon-upgrade/pixellab-runeblade-probe.png` — 96x96 RGBA, 1,546 opaque pixels, no semi-transparent fringe.
- `agents/research/codex-weapon-upgrade/pixellab-polearm-probe.png` — 112x112 RGBA, 1,214 opaque pixels, no semi-transparent fringe.
- `agents/research/codex-weapon-upgrade/pixellab-greatsword-probe.png` — 112x112 RGBA source for the high-tier GPT-5.5 greatsword.
- `agents/research/codex-weapon-upgrade/pixellab-engineer-wrench-probe.png` — 96x96 RGBA source for the GPT-5.4 battle-engineer wrench.

These started as viability probes. The implementation pass below promotes the curated versions directly into the equipment asset folder and supplies grip anchors through the manifest/runtime metadata.

## Implemented Pass

The first implementation pass promotes the probes into runtime equipment assets:

- `claudeville/assets/sprites/equipment/equipment.codex.runeblade.png`
- `claudeville/assets/sprites/equipment/equipment.codex.greatsword.png`
- `claudeville/assets/sprites/equipment/equipment.codex.polearm.png`
- `claudeville/assets/sprites/equipment/equipment.codex.engineerWrench.png`

Runtime mapping:

- GPT-5.5 none/low/medium: `runeblade`
- GPT-5.5 high: `greatsword`
- GPT-5.5 xhigh/max: `polearm`
- GPT-5.4 and default Codex: `engineerWrench`
- GPT-5.3 Spark: compact procedural `multitool`

Validation captures:

- `agents/research/codex-weapon-upgrade/integration-captures/gpt55-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/integration-captures/gpt54-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/integration-captures/gpt53spark-equipment-grid.png`
- `agents/research/codex-weapon-upgrade/integration-captures/codex-equipment-overview.png`

The implemented renderer keeps fallback procedural drawings so missing equipment PNGs do not blank out a Codex agent.

## Validation

After implementation:

1. `node --check claudeville/src/presentation/character-mode/AgentSprite.js`
2. `node --check claudeville/src/presentation/shared/ModelVisualIdentity.js`
3. `npm run sprites:validate` if PNGs or manifest entries change.
4. `node scripts/sprites/capture-codex-equipment.mjs --out-dir=agents/research/codex-weapon-upgrade/final-captures`
5. Manually inspect all Codex models, efforts, directions, and idle/walk poses.

The pass criterion is visual, not just syntactic: the blade/polearm must read as a deliberate legendary weapon, and the grip must sit in the hand in every captured direction.
