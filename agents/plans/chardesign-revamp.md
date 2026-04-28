# Character Design Revamp Implementation Plan (v2)

Status: historical/completed plan. Retain for implementation history only; current sprite IDs, manifest fields, and `style.assetVersion` must be verified against `claudeville/assets/sprites/manifest.yaml`, `scripts/sprites/generate.md`, and `docs/pixellab-reference.md` before reuse.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. The plan is structured as four waves; each wave dispatches independent subagents in parallel. Sequential steps within a track are checkbox-tracked.

> **Pixellab reference:** This plan was written before the canonical pixellab guide existed. For up-to-date tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`../../docs/pixellab-reference.md`](../../docs/pixellab-reference.md). Apparent disagreements between this plan and that reference should defer to the reference.

**Goal:** Replace ClaudeVille's 5 chibi character sprites with a coherent 6-character lineup at higher fidelity, encoding family (Claude vs Codex) and tier (master / journeyman / apprentice; captain / senior / swift) directly in silhouette and body shape, separating *identity* from *runtime stat* by moving low/med/high effort onto FLOOR rings and reserving HEAD overlays for xhigh/max only.

**Architecture:** Switch character generation from the legacy one-shot REST `pixflux` endpoint to the pixellab MCP `create_character` + `animate_character` path, assembled into the existing 8 dirs × 10 rows × 92px sheet via a new Node script. Engine-side: wire the existing-but-unused effort accessory hook, add an effort floor-ring rendering pass, add a Haiku branch in identity / dashboard / minimap. The 92×92 cell size stays untouched — every change conforms to existing engine contracts.

**Tech Stack:** pixellab MCP (`create_character`, `animate_character`, `create_isometric_tile`, `get_character`), Node 20+ (built-ins + `pngjs` ^7.0.0 already in dev deps), `npm run sprites:validate`, `npm run dev` for browser smoke.

**Wave dependency graph:**
```
WAVE 1 (3 parallel tracks: code-prep) ─┐
                                       ├──> WAVE 2 (manifest scaffold, sequential) ──> WAVE 3 (6+1 parallel: bake) ──> WAVE 4 (validate, sequential)
                                       │
                                       └──> WAVE 3 can start tooling-checks once Track C done
```

**Validation gates:** End of Wave 1 (each track committed cleanly), end of Wave 3 (all sheets exist + dimensions OK), end of Wave 4 (browser smoke on all 6 characters, both modes, all effort tiers).

---

## File Structure

| Path | Action | Owner Wave / Track |
|---|---|---|
| `claudeville/src/presentation/character-mode/AgentSprite.js` | Modify (line 450 + new effort floor-ring render hook) | Wave 1, Track A |
| `claudeville/src/presentation/shared/ModelVisualIdentity.js` | Modify (haiku branch, max tier, `effortFloorRing` field, codex visual-only clamp) | Wave 1, Track A |
| `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js` | Modify (haiku insignia, haiku headgear, manifest-driven version) | Wave 1, Track B |
| `claudeville/src/presentation/character-mode/Minimap.js` | Modify (haiku case) | Wave 1, Track B |
| `scripts/sprites/generate-character-mcp.mjs` | Create (assembly script with `--source-size` flag + pre-assembly check) | Wave 1, Track C |
| `claudeville/assets/sprites/manifest.yaml` | Modify (rewrite 5 prompts, add haiku, swap effort overlays, bump assetVersion ONCE) | Wave 2 |
| `claudeville/assets/sprites/characters/agent.claude.haiku/sheet.png` | Create (apprentice tier) | Wave 3, Track D |
| `claudeville/assets/sprites/characters/agent.claude.opus/sheet.png` | Replace (master archmage; size 76 to avoid wide-brim clip) | Wave 3, Track E |
| `claudeville/assets/sprites/characters/agent.claude.sonnet/sheet.png` | Replace (scholar — no tome, no pointed hat; mortarboard + quill + floating scroll) | Wave 3, Track F |
| `claudeville/assets/sprites/characters/agent.codex.gpt55/sheet.png` | Replace (captain artificer) | Wave 3, Track G |
| `claudeville/assets/sprites/characters/agent.codex.gpt54/sheet.png` | Replace (senior; deep-rust palette + forearm gauntlet for body-silhouette signature) | Wave 3, Track H |
| `claudeville/assets/sprites/characters/agent.codex.gpt53spark/sheet.png` | Replace (swift mechanic; neutral idle, no forward-lean) | Wave 3, Track I |
| `claudeville/assets/sprites/overlays/overlay.status.effortLow.png` | Create (floor ring, low) | Wave 3, Track J |
| `claudeville/assets/sprites/overlays/overlay.status.effortMedium.png` | Create (floor ring, medium) | Wave 3, Track J |
| `claudeville/assets/sprites/overlays/overlay.status.effortHigh.png` | Create (floor ring, high) | Wave 3, Track J |
| `claudeville/assets/sprites/overlays/overlay.accessory.effortMax.png` | Create (head; vertical triple-pillar + laurel ring — distinct SHAPE from xhigh halo) | Wave 3, Track J |
| `claudeville/assets/sprites/overlays/overlay.accessory.effortLow.png` | **Delete** (replaced by floor ring) | Wave 2 |
| `claudeville/assets/sprites/overlays/overlay.accessory.effortMedium.png` | **Delete** (replaced by floor ring) | Wave 2 |
| `claudeville/assets/sprites/overlays/overlay.accessory.effortHigh.png` | **Delete** (replaced by floor ring) | Wave 2 |
| `claudeville/assets/sprites/overlays/overlay.accessory.effortXhigh.png` | Keep (head; existing halo crown) | — |

---

## Common Procedure: Bake One Character (referenced by Wave 3 tracks D–I)

Each character bake is identical except for the prompt and the sprite ID. Follow these 7 steps:

- [ ] **Step 1: Create the character via pixellab MCP**

Call `mcp__pixellab__create_character`:
- description: `<style anchor> + <character-specific description>`
- name: `<human-readable name>`
- size: 92 (or 76 for Opus per Risk R1)
- n_directions: 8
- view: `low top-down`
- detail: `medium detail`
- shading: `basic shading`
- outline: `single color black outline`

The style anchor (always prefixed) is exactly:
```
epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks
```

Note the returned `character_id`.

- [ ] **Step 2: Queue walk animation**

Call `mcp__pixellab__animate_character` with `character_id` and `template_animation_id: "walking-6-frames"`.

- [ ] **Step 3: Queue breathing-idle animation**

Call `mcp__pixellab__animate_character` with `character_id` and `template_animation_id: "breathing-idle"`.

- [ ] **Step 4: Poll until both animations show 100%**

Call `mcp__pixellab__get_character` with `character_id` every 60s until the response shows two animations both complete (the response includes a `progress` field per animation; both must be 100). Total wait ≈ 5–10 min.

The response shape is documented as:
```json
{
  "character_id": "...",
  "rotations": { "south": "https://...", "south-east": "https://...", ... },
  "animations": [
    { "name": "walking-6-frames", "progress": 100, "directions": { "south": "https://...png", ... } },
    { "name": "breathing-idle",   "progress": 100, "directions": { "south": "https://...png", ... } }
  ]
}
```
If actual response shape diverges, the assembler script throws with the actual vs expected dimensions — adjust the script's `SOURCE` constant and re-run Step 6 (no need to re-generate via MCP).

- [ ] **Step 5: Download all 24 artifacts to cache**

Run (substitute `<id>`):
```bash
ID=<id>
mkdir -p output/character-mcp-cache/$ID/{rotations,walk,breathing-idle}
```

For each direction `D` in `south south-east east north-east north north-west west south-west`, download:
- rotation: `output/character-mcp-cache/$ID/rotations/$D.png`  (132×132)
- walk strip: `output/character-mcp-cache/$ID/walk/$D.png`  (132 × (132 × 6) = 132 × 792)
- idle strip: `output/character-mcp-cache/$ID/breathing-idle/$D.png`  (132 × (132 × 4) = 132 × 528)

Use `curl --fail` for every download (HTTP 423 means animation still pending — return to Step 4 and re-poll).

The URLs are extracted from the `get_character` response. With `jq` if response saved to `resp.json`:
```bash
jq -r '.animations[] | select(.name=="walking-6-frames") | .directions | to_entries[] | "\(.key) \(.value)"' resp.json
```

- [ ] **Step 6: Pre-assembly cache check**

```bash
test $(find output/character-mcp-cache/$ID -name '*.png' | wc -l) -eq 24 || echo "INCOMPLETE — re-run Step 5"
```
Expected: silent (passes). If "INCOMPLETE", review Step 4/5 and rerun.

- [ ] **Step 7: Assemble the 736×920 sheet**

```bash
node scripts/sprites/generate-character-mcp.mjs --id=$ID
```
Expected: `wrote claudeville/assets/sprites/characters/$ID/sheet.png (736×920)`.

Confirm:
```bash
file claudeville/assets/sprites/characters/$ID/sheet.png
```
Expected: `PNG image data, 736 x 920, 8-bit/color RGBA, non-interlaced`.

---

## WAVE 1 — Code Prep (parallel — three subagents)

Dispatch all three subagents simultaneously. Each gets a self-contained packet with the relevant files and tasks.

### Track A — Engine identity + sprite wire-up

**Subagent role:** modify `AgentSprite.js` and `ModelVisualIdentity.js` only. Three commits, one per logical change.

**Files:**
- Modify: `claudeville/src/presentation/shared/ModelVisualIdentity.js`
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js:450` (and add a new floor-ring rendering pass near line 700–720 where status overlays load)

#### Track A — Task A1: Wire the head accessory through the compositor (1 commit)

- [ ] **Step 1: Verify the line**

Run: `sed -n '445,455p' claudeville/src/presentation/character-mode/AgentSprite.js`
Expected: line 450 reads `        const accessory = null;` (the leading 8 spaces are part of the unique match).

- [ ] **Step 2: Replace exactly**

Edit `claudeville/src/presentation/character-mode/AgentSprite.js`:

old (unique 8-space indent):
```js
        const accessory = null;
```
new:
```js
        const accessory = identity.effortAccessory ?? null;
```

- [ ] **Step 3: Syntax smoke**

```bash
node --check claudeville/src/presentation/character-mode/AgentSprite.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "fix: wire identity.effortAccessory into compositor"
```

#### Track A — Task A2: Add Haiku branch + max tier + floor-ring identity field + codex visual-only clamp (1 commit)

- [ ] **Step 1: Read the current file**

```bash
sed -n '1,170p' claudeville/src/presentation/shared/ModelVisualIdentity.js
```
Confirm the structure matches the patches below before editing.

- [ ] **Step 2: Extend `EFFORT_LABELS` and replace `EFFORT_ACCESSORIES`; add `EFFORT_FLOOR_RINGS`**

Replace exactly:

```js
const EFFORT_LABELS = Object.freeze({
    none: 'none',
    low: 'low',
    medium: 'med',
    high: 'high',
    xhigh: 'xhigh',
});

const EFFORT_ACCESSORIES = Object.freeze({
    low: 'effortLow',
    medium: 'effortMedium',
    high: 'effortHigh',
    xhigh: 'effortXhigh',
});
```

with:

```js
const EFFORT_LABELS = Object.freeze({
    none: 'none',
    low: 'low',
    medium: 'med',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
});

// Head overlays (anchored above hat). Only the apex tiers — low/med/high
// moved to floor rings to avoid stacking conflicts with tall headgear.
const EFFORT_ACCESSORIES = Object.freeze({
    xhigh: 'effortXhigh',
    max: 'effortMax',
});

// Floor rings (anchored at feet). Used for low/medium/high tiers.
// Overlay IDs map to overlay.status.effortLow / effortMedium / effortHigh.
const EFFORT_FLOOR_RINGS = Object.freeze({
    low: 'overlay.status.effortLow',
    medium: 'overlay.status.effortMedium',
    high: 'overlay.status.effortHigh',
});
```

- [ ] **Step 3: Recognize `max` in `normalizeReasoningEffort`**

Replace exactly:

```js
    if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
```

with:

```js
    if (normalized === 'max' || normalized.includes('maximum')) return 'max';
    if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
```

- [ ] **Step 4: Compute both head accessory and floor ring at top of `getModelVisualIdentity`**

Replace exactly:

```js
    const effortTier = normalizeReasoningEffort(effort);
    const effortAccessory = EFFORT_ACCESSORIES[effortTier] || null;
```

with:

```js
    const effortTier = normalizeReasoningEffort(effort);
    const effortAccessory = EFFORT_ACCESSORIES[effortTier] || null;
    const effortFloorRing = EFFORT_FLOOR_RINGS[effortTier] || null;
```

- [ ] **Step 5: Add Haiku branch BEFORE the Sonnet block**

Find the line `    if (normalizedModel.includes('sonnet') || normalizedProvider.includes('claude')) {` and insert IMMEDIATELY ABOVE it:

```js
    if (normalizedModel.includes('haiku')) {
        return {
            family: 'claude',
            modelClass: 'haiku',
            modelTier: 'light',
            label: 'Claude Haiku',
            shortLabel: 'Haiku',
            effortTier,
            effortAccessory,
            effortFloorRing,
            spriteId: 'agent.claude.haiku',
            paletteKey: 'claude',
            trim: ['#ffd47a', '#ffe39a', '#f6c25c'],
            accent: ['#fff1c2', '#ffe39a', '#ffcc7a'],
            minimapColor: '#ffd47a',
        };
    }

```

- [ ] **Step 6: Add `effortFloorRing` to ALL existing return objects**

Every existing return inside `getModelVisualIdentity` (Opus, Sonnet-claude-fallback, Spark, GPT-5.5, GPT-5.4, default-codex, generic) must include `effortFloorRing` alongside `effortAccessory`.

For the four CLAUDE returns (haiku already added in Step 5; opus + sonnet-fallback) and the generic fallback, replace exactly each pair:

```js
            effortTier,
            effortAccessory,
```

with:

```js
            effortTier,
            effortAccessory,
            effortFloorRing,
```

For the four CODEX returns (spark, gpt55, gpt54, default-codex), apply the visual-only clamp — the **label** stays as the user reported (`max` displays as "max"), but the **head overlay** clamps to xhigh and the **floor ring** is null since codex never has low/med/high+max combos. Replace each pair:

```js
            effortTier,
            effortAccessory,
```

with:

```js
            effortTier,
            effortAccessory: effortTier === 'max' ? EFFORT_ACCESSORIES.xhigh : effortAccessory,
            effortFloorRing,
```

This preserves `effortTier='max'` for the label, but maps the visual to the existing xhigh halo.

- [ ] **Step 7: Smoke test**

```bash
node --check claudeville/src/presentation/shared/ModelVisualIdentity.js
node -e "import('./claudeville/src/presentation/shared/ModelVisualIdentity.js').then(m => {
  const a = m.getModelVisualIdentity('claude-haiku-4-5', 'high', 'claude');
  console.log('haiku:', a.spriteId, a.effortAccessory, a.effortFloorRing);
  const b = m.getModelVisualIdentity('claude-opus-4-7', 'max', 'claude');
  console.log('opus-max:', b.effortAccessory, b.effortFloorRing);
  const c = m.getModelVisualIdentity('gpt-5-5', 'max', 'codex');
  console.log('gpt55-max:', c.effortTier, c.effortAccessory, c.effortFloorRing);
  console.log('label:', m.formatModelLabel('gpt-5-5', 'max', 'codex'));
})"
```
Expected exactly:
```
haiku: agent.claude.haiku null overlay.status.effortHigh
opus-max: effortMax null
gpt55-max: max effortXhigh null
label: 5.5 max
```

- [ ] **Step 8: Commit**

```bash
git add claudeville/src/presentation/shared/ModelVisualIdentity.js
git commit -m "feat: add haiku model class, max tier, and floor-ring effort overlays"
```

#### Track A — Task A3: Render the effort floor ring in `_drawStatus` (1 commit)

The existing status overlay renderer in `AgentSprite.js` loads `overlay.status.selected/chat/working/idle` via `this.assets.get(...)` near line 704 and draws under the agent feet. We add a parallel pass for the effort floor ring.

- [ ] **Step 1: Read the existing status pass**

```bash
sed -n '695,765p' claudeville/src/presentation/character-mode/AgentSprite.js
```
Confirm there's a section that loads `overlay.status.selected` and draws it at the feet anchor. The new effort ring is drawn the same way but using the identity-driven asset id.

- [ ] **Step 2: Add the effort floor-ring draw immediately after the selected ring**

In `AgentSprite.js`, find the line:

```js
        const ring = this.assets.get('overlay.status.selected');
```

After the entire block that draws `ring` (typically ends with `ctx.drawImage(ring, ...);` or similar; depending on local indentation the block may span 5–15 lines), insert this new draw block at the same indentation level:

```js
        const effortRingId = identity.effortFloorRing;
        if (effortRingId) {
            const effortRing = this.assets.get(effortRingId);
            if (effortRing) {
                const dims = this.assets.getDims(effortRingId);
                ctx.drawImage(
                    effortRing,
                    Math.round(this.x - dims.w / 2),
                    Math.round(this.y - dims.h / 2),
                    dims.w,
                    dims.h
                );
            }
        }
```

If `identity` is not in scope at the insertion point, hoist it from where it's used elsewhere in the function (e.g., `const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);` at the top of `_drawStatus`). Reference the existing usage at line 1025 of the same file for the import (`getModelVisualIdentity` is already imported via the file's import block).

- [ ] **Step 3: Verify imports**

Run: `grep -n "getModelVisualIdentity" claudeville/src/presentation/character-mode/AgentSprite.js`
Expected: at least one existing import or use. If only used inline at line ~1025, the new code uses it from the same module-level import — no new import needed.

- [ ] **Step 4: Syntax smoke**

```bash
node --check claudeville/src/presentation/character-mode/AgentSprite.js
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "feat: render identity.effortFloorRing under agent feet"
```

---

### Track B — Dashboard + Minimap

**Subagent role:** modify `AvatarCanvas.js` and `Minimap.js`. Two commits.

**Files:**
- Modify: `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js:7` (version constant) + insignia (~line 277) + headgear (~line 346)
- Modify: `claudeville/src/presentation/character-mode/Minimap.js` (haiku case)

#### Track B — Task B1: Make `AvatarCanvas` cache version manifest-driven + add Haiku branches (1 commit)

The hardcoded `SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp'` at `AvatarCanvas.js:7` is independent of the manifest's `style.assetVersion` field. After this fix, dashboard avatars will pick up cache-busts from the manifest automatically — no manual sync required across phases.

- [ ] **Step 1: Convert the hardcoded constant to read from the AssetManager**

Read context:
```bash
sed -n '1,15p' claudeville/src/presentation/dashboard-mode/AvatarCanvas.js
```

Find the existing line:
```js
const SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp';
```

We need `AvatarCanvas` to use the same `style.assetVersion` the rest of the engine uses. The simplest path: read it from the `AssetManager` instance passed into the constructor. Trace how `AvatarCanvas` is instantiated by reading: `grep -n "new AvatarCanvas" claudeville/src/presentation/`. If the AssetManager is reachable, prefer instance-driven over module-constant.

If AvatarCanvas is created without AssetManager access, the second-best option is to import the manifest once at module load. Add at the top of the file (after existing imports):

```js
let SPRITE_ASSET_VERSION_PROMISE = null;
async function getSpriteAssetVersion() {
    if (!SPRITE_ASSET_VERSION_PROMISE) {
        SPRITE_ASSET_VERSION_PROMISE = fetch('assets/sprites/manifest.yaml')
            .then(r => r.text())
            .then(text => {
                const m = text.match(/^\s*assetVersion:\s*"([^"]+)"/m);
                return m ? m[1] : 'unknown';
            })
            .catch(() => 'unknown');
    }
    return SPRITE_ASSET_VERSION_PROMISE;
}
```

Replace the constant `const SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp';` with:

```js
let SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp'; // overwritten asynchronously on first load
getSpriteAssetVersion().then(v => { SPRITE_ASSET_VERSION = v; });
```

This makes the cache-bust manifest-driven. `let` allows the async update; the initial value covers the first paint before the fetch resolves.

- [ ] **Step 2: Add the Haiku insignia handler**

Find the Sonnet block in `_drawModelInsignia`:

```js
        if (identity.modelClass === 'sonnet') {
            ctx.fillStyle = accent;
            ctx.fillRect(-3, 0, 6, 2);
            ctx.strokeStyle = '#fff4cf';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-4, 7);
            ctx.lineTo(4, 1);
            ctx.stroke();
            return;
        }
```

Insert immediately AFTER it:

```js
        if (identity.modelClass === 'haiku') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(-3, 4);
            ctx.lineTo(3, 4);
            ctx.lineTo(0, 8);
            ctx.closePath();
            ctx.fill();
            return;
        }

```

- [ ] **Step 3: Add the Haiku-specific headgear**

Find `_drawModelHeadgear` (~line 346). The current code applies the same wide-brim claude wizard hat to ALL `family === 'claude'` characters — Haiku will get Opus's hat, contradicting the apprentice grammar. Add a Haiku-specific override.

Replace exactly:

```js
        if (identity.family === 'claude') {
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-6, -10);
            ctx.lineTo(0, -16);
            ctx.lineTo(6, -10);
            ctx.lineTo(3, -8);
            ctx.lineTo(-3, -8);
            ctx.closePath();
            ctx.fill();
            return;
        }
```

with:

```js
        if (identity.modelClass === 'haiku') {
            // small hooded cap, no brim — apprentice tier
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-4, -10);
            ctx.lineTo(0, -13);
            ctx.lineTo(4, -10);
            ctx.lineTo(2, -7);
            ctx.lineTo(-2, -7);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.family === 'claude') {
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-6, -10);
            ctx.lineTo(0, -16);
            ctx.lineTo(6, -10);
            ctx.lineTo(3, -8);
            ctx.lineTo(-3, -8);
            ctx.closePath();
            ctx.fill();
            return;
        }
```

- [ ] **Step 4: Syntax smoke**

```bash
node --check claudeville/src/presentation/dashboard-mode/AvatarCanvas.js
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/dashboard-mode/AvatarCanvas.js
git commit -m "feat: AvatarCanvas reads asset version from manifest, adds haiku branches"
```

#### Track B — Task B2: Add Haiku case to Minimap (1 commit)

`Minimap.js` switches on `modelClass` at lines 88 and 98 for `spark` and `gpt55`. Without a haiku branch the haiku falls through to default rendering — same as opus/sonnet today. Add an explicit case for visual consistency.

- [ ] **Step 1: Read context**

```bash
sed -n '80,110p' claudeville/src/presentation/character-mode/Minimap.js
```

- [ ] **Step 2: Add the haiku branch**

Locate the existing `else if (identity.modelClass === 'spark')` or similar conditional. Insert a new branch BEFORE it (so haiku matches first when the model is Haiku):

```js
        } else if (identity.modelClass === 'haiku') {
            ctx.fillStyle = identity.minimapColor || '#ffd47a';
            ctx.beginPath();
            ctx.arc(x, y, 1.5, 0, Math.PI * 2);
            ctx.fill();
```

Match the existing code's brace/whitespace style by reading the surrounding lines.

- [ ] **Step 3: Syntax smoke**

```bash
node --check claudeville/src/presentation/character-mode/Minimap.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/Minimap.js
git commit -m "feat: minimap haiku case"
```

---

### Track C — MCP assembly script

**Subagent role:** create one new file. One commit.

**Files:**
- Create: `scripts/sprites/generate-character-mcp.mjs`

#### Track C — Task C1: Write the assembler

- [ ] **Step 1: Create the file**

Write `scripts/sprites/generate-character-mcp.mjs` exactly:

```js
#!/usr/bin/env node
// Assemble a ClaudeVille character sheet (8 dirs × 10 rows × 92px = 736×920)
// from pixellab MCP outputs cached on disk.
//
// Usage:
//   node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> [--source-size=132]
//
// Cache layout (operator must populate before running):
//   output/character-mcp-cache/<id>/rotations/<dir>.png       (S × S, where S = source size, default 132)
//   output/character-mcp-cache/<id>/walk/<dir>.png            (S × (S × 6) — 6-frame strip)
//   output/character-mcp-cache/<id>/breathing-idle/<dir>.png  (S × (S × 4) — 4-frame strip)
//
// Output: claudeville/assets/sprites/characters/<id>/sheet.png  (736×920)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cacheRoot = join(repoRoot, 'output', 'character-mcp-cache');
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters');

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const CELL = 92;
const WALK_FRAMES = 6;
const IDLE_FRAMES = 4;
const COLS = DIRECTIONS.length;
const ROWS = WALK_FRAMES + IDLE_FRAMES;

function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
}

const id = arg('id', null);
if (!id) { console.error('Missing --id=<sprite-id>'); process.exit(1); }
const SOURCE = parseInt(arg('source-size', '132'), 10);
if (Number.isNaN(SOURCE) || SOURCE < CELL) { console.error(`--source-size must be ≥ ${CELL}`); process.exit(1); }

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

async function main() {
    const cacheDir = join(cacheRoot, id);
    if (!existsSync(cacheDir)) throw new Error(`Cache not found: ${cacheDir}`);

    // Pre-flight: 24 files must exist
    let count = 0;
    for (const sub of ['rotations', 'walk', 'breathing-idle']) {
        for (const dir of DIRECTIONS) {
            if (existsSync(join(cacheDir, sub, `${dir}.png`))) count++;
        }
    }
    if (count !== 24) throw new Error(`Cache for ${id} has ${count}/24 PNGs — re-run download step.`);

    const sheet = new PNG({ width: CELL * COLS, height: CELL * ROWS });
    sheet.data.fill(0);

    for (let col = 0; col < COLS; col++) {
        const dir = DIRECTIONS[col];

        const walkStrip = readPng(join(cacheDir, 'walk', `${dir}.png`));
        if (walkStrip.height !== SOURCE || walkStrip.width !== SOURCE * WALK_FRAMES) {
            throw new Error(`walk/${dir}.png: expected ${SOURCE * WALK_FRAMES}×${SOURCE}, got ${walkStrip.width}×${walkStrip.height}. Use --source-size=<actual height> if pixellab returned a different canvas.`);
        }
        for (let f = 0; f < WALK_FRAMES; f++) {
            const frame = cropCenter(walkStrip, f * SOURCE, 0);
            blit(frame, sheet, col * CELL, f * CELL);
        }

        const idleStrip = readPng(join(cacheDir, 'breathing-idle', `${dir}.png`));
        if (idleStrip.height !== SOURCE || idleStrip.width !== SOURCE * IDLE_FRAMES) {
            throw new Error(`breathing-idle/${dir}.png: expected ${SOURCE * IDLE_FRAMES}×${SOURCE}, got ${idleStrip.width}×${idleStrip.height}.`);
        }
        for (let f = 0; f < IDLE_FRAMES; f++) {
            const frame = cropCenter(idleStrip, f * SOURCE, 0);
            blit(frame, sheet, col * CELL, (WALK_FRAMES + f) * CELL);
        }
    }

    const outPath = join(spritesRoot, id, 'sheet.png');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(sheet));
    console.log(`wrote ${outPath} (${CELL * COLS}×${CELL * ROWS})`);
}

function readPng(p) {
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return PNG.sync.read(readFileSync(p));
}

// Center-crop CELL×CELL from a SOURCE×SOURCE region of src starting at (sx, sy).
function cropCenter(src, sx, sy) {
    const off = Math.floor((SOURCE - CELL) / 2);
    const out = new PNG({ width: CELL, height: CELL });
    out.data.fill(0);
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const sxx = sx + off + x;
            const syy = sy + off + y;
            if (sxx < 0 || syy < 0 || sxx >= src.width || syy >= src.height) continue;
            const si = (src.width * syy + sxx) << 2;
            const di = (CELL * y + x) << 2;
            out.data[di] = src.data[si];
            out.data[di + 1] = src.data[si + 1];
            out.data[di + 2] = src.data[si + 2];
            out.data[di + 3] = src.data[si + 3];
        }
    }
    return out;
}

function blit(src, dst, dx, dy) {
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const si = (src.width * y + x) << 2;
            if (src.data[si + 3] === 0) continue;
            const dxx = dx + x;
            const dyy = dy + y;
            if (dxx < 0 || dyy < 0 || dxx >= dst.width || dyy >= dst.height) continue;
            const di = (dst.width * dyy + dxx) << 2;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = src.data[si + 3];
        }
    }
}
```

- [ ] **Step 2: Syntax smoke**

```bash
node --check scripts/sprites/generate-character-mcp.mjs
```
Expected: no output.

- [ ] **Step 3: Confirm pngjs is available**

```bash
node -e "import('pngjs').then(m => console.log('pngjs ok', !!m.PNG))"
```
Expected: `pngjs ok true`. If module not found, run `npm install` first.

- [ ] **Step 4: Commit**

```bash
git add scripts/sprites/generate-character-mcp.mjs
git commit -m "feat: add MCP-based character sheet assembler"
```

---

## WAVE 2 — Manifest scaffold (sequential, in parent session)

After all three Wave 1 tracks are committed, dispatch this single sequential task. It builds the full manifest ahead of generation; the validator will fail until Wave 3 completes — that is expected and acknowledged.

### Task W2: Rewrite manifest, swap effort overlays, bump assetVersion ONCE

- [ ] **Step 1: Bump assetVersion ONCE**

Edit `claudeville/assets/sprites/manifest.yaml`. Replace exactly:

```yaml
  assetVersion: "2026-04-27-harbor-dock-cleanup-v1"
```
with:
```yaml
  assetVersion: "2026-04-28-character-revamp-v1"
```

- [ ] **Step 2: Rewrite the 5 existing character prompts and add the Haiku entry**

In `manifest.yaml`, locate the `characters:` section. Replace the entire block from `agent.claude.opus` through `agent.codex.gpt53spark` (5 entries, ending before `agent.claude.base`) with the following 6 entries (Opus → Sonnet → Haiku → GPT-5.5 → GPT-5.4 → Spark):

```yaml
  - id: agent.claude.opus
    tool: create_character
    prompt: "Claude Opus 4.7 master archmage, tall pointed wizard hat with narrow brim and star sigil at apex, full-length floor-dragging ivory and amber robe, broad gold rune mantle, high collar, glowing tome held in one hand, tall ornate runed staff in the other, regal commanding silhouette, 8-direction pixel art"
    n_directions: 8
    size: 76
    animations: [walk, breathing-idle]
    palette_layer: claude
    anchor: [46, 80]

  - id: agent.claude.sonnet
    tool: create_character
    prompt: "Claude Sonnet 4.6 journeyman scholar, flat scholar mortarboard cap with single feather, knee-length amber scholar cloak with belt sash and inkpot pouches, silver quill in one hand, floating illuminated scroll trailing behind shoulder, no tome, nimble balanced silhouette, 8-direction pixel art"
    n_directions: 8
    size: 92
    animations: [walk, breathing-idle]
    palette_layer: claude
    anchor: [46, 80]

  - id: agent.claude.haiku
    tool: create_character
    prompt: "Claude Haiku 4.5 apprentice scribe-mage, small hooded cap (no brim), simple amber tunic with rolled sleeves over a short open mage robe, leather satchel of scrolls, short carved walking stick, compact youthful slim silhouette, visible leather boots, 8-direction pixel art"
    n_directions: 8
    size: 92
    animations: [walk, breathing-idle]
    palette_layer: claude
    anchor: [46, 80]

  - id: agent.codex.gpt55
    tool: create_character
    prompt: "Codex GPT-5.5 captain artificer, peaked navy captain cap with gold band, long bright teal officer coat with prominent shoulder epaulettes and gold rune trim, luminous chest core, ornate brass tool belt, commanding tall posture, master engineer leader silhouette, 8-direction pixel art"
    n_directions: 8
    size: 92
    animations: [walk, breathing-idle]
    palette_layer: codex
    anchor: [46, 80]

  - id: agent.codex.gpt54
    tool: create_character
    prompt: "Codex GPT-5.4 senior engineer artificer, flat brass-trimmed engineer cap, brass goggles down over the eyes, deep rust-and-bronze coat distinct from the captain's bright teal, large prominent left-arm gauntlet with exposed gear teeth, backpack toolkit silhouette over right shoulder, sturdy practical artificer silhouette, 8-direction pixel art"
    n_directions: 8
    size: 92
    animations: [walk, breathing-idle]
    palette_layer: codex
    anchor: [46, 80]

  - id: agent.codex.gpt53spark
    tool: create_character
    prompt: "Codex GPT-5.3 Spark scout artificer mechanic, backwards visor cap with cyan lens, short open vest with rolled-up sleeves over yellow lightning sash, light short trousers tucked into runner boots, neutral upright stance with ready hands, swift scout engineer silhouette, 8-direction pixel art"
    n_directions: 8
    size: 92
    animations: [walk, breathing-idle]
    palette_layer: codex
    anchor: [46, 80]

```

- [ ] **Step 3: Replace the four `overlay.accessory.effort*` entries with the new schema**

Locate the `accessories:` section. Replace the entire block of 4 entries (`overlay.accessory.effortLow`, `effortMedium`, `effortHigh`, `effortXhigh`) with this single retained entry:

```yaml
  - id: overlay.accessory.effortXhigh
    tool: isometric_tile
    prompt: "tall gold reasoning crest with single ring crown, Claude apex tier, transparent background"
    size: 32
    n_directions: 8
    anchor: [16, 13]

  - id: overlay.accessory.effortMax
    tool: isometric_tile
    prompt: "vertical triple-pillar gold star crown rising above head, three stacked star points with laurel wreath base, distinct vertical pillar shape clearly different from any ring or halo, Claude maximum tier, transparent background"
    size: 32
    n_directions: 8
    anchor: [16, 16]

```

- [ ] **Step 4: Add three new `overlay.status.effort*` floor-ring entries**

Locate the `statusOverlays:` section. Append these three entries after the existing `overlay.status.idle`:

```yaml
  - id: overlay.status.effortLow
    tool: isometric_tile
    prompt: "soft single-band bronze floor ring at agent feet, faint glow, low effort tier marker, transparent background"
    size: 64

  - id: overlay.status.effortMedium
    tool: isometric_tile
    prompt: "double-band silver floor ring at agent feet, gentle pulse glow, medium effort tier marker, transparent background"
    size: 64

  - id: overlay.status.effortHigh
    tool: isometric_tile
    prompt: "triple-band gold floor ring with rune sparks at agent feet, vivid pulse, high effort tier marker, transparent background"
    size: 64

```

- [ ] **Step 5: Remove the orphaned PNG files**

```bash
rm claudeville/assets/sprites/overlays/overlay.accessory.effortLow.png \
   claudeville/assets/sprites/overlays/overlay.accessory.effortMedium.png \
   claudeville/assets/sprites/overlays/overlay.accessory.effortHigh.png
```

(The `effortXhigh.png` is kept as-is; the rest are deleted because they were already replaced semantically by floor rings.)

- [ ] **Step 6: Commit (validator will fail — that is expected)**

```bash
git add claudeville/assets/sprites/manifest.yaml
git rm claudeville/assets/sprites/overlays/overlay.accessory.effortLow.png \
       claudeville/assets/sprites/overlays/overlay.accessory.effortMedium.png \
       claudeville/assets/sprites/overlays/overlay.accessory.effortHigh.png
git commit -m "feat: scaffold manifest for character revamp + floor-ring effort tiers"
```

`npm run sprites:validate` will report missing PNGs at this point. That is the entire point of Wave 3.

---

## WAVE 3 — Asset generation (parallel — six character subagents + one overlay subagent)

Dispatch all 7 subagents simultaneously. Each operates on disjoint cache directories and disjoint output paths. The manifest is fully scaffolded; subagents only WRITE PNGs.

**Important — pixellab MCP queueing:** the MCP tolerates concurrent generation jobs from the same account (each call returns a job id and processes server-side). However, *each subagent* must have MCP access. If subagents do NOT have MCP access in the executing harness, fall back to the parent operator running the 7 procedures sequentially with batched create + animate calls (kick off all 6 creates → all 12 animates → all 4 overlay tiles → poll all → download all).

### Track D — Bake `agent.claude.haiku`

**Subagent role:** follow the **Common Procedure** with these exact substitutions, then commit.

- create_character description (after the style anchor):
  ```
  Claude Haiku 4.5 apprentice scribe-mage, small hooded cap (no brim), simple amber tunic with rolled sleeves over a short open mage robe, leather satchel of scrolls, short carved walking stick, compact youthful slim silhouette, visible leather boots
  ```
- name: `Claude Haiku Apprentice`
- size: 92
- sprite id (`<id>` everywhere in Steps 5–7): `agent.claude.haiku`

After Step 7 (sheet.png exists at correct dims):

- [ ] **Verify dimensions**: `file claudeville/assets/sprites/characters/agent.claude.haiku/sheet.png` must report `736 x 920`.
- [ ] **Commit**:
  ```bash
  git add claudeville/assets/sprites/characters/agent.claude.haiku/sheet.png
  git commit -m "feat: bake Claude Haiku apprentice sprite"
  ```

### Track E — Bake `agent.claude.opus`

Substitutions for the **Common Procedure**:

- create_character description (after style anchor):
  ```
  Claude Opus 4.7 master archmage, tall pointed wizard hat with narrow brim and star sigil at apex, full-length floor-dragging ivory and amber robe, broad gold rune mantle, high collar, glowing tome held in one hand, tall ornate runed staff in the other, regal commanding silhouette
  ```
- name: `Claude Opus Archmage`
- size: **76** (smaller pixellab canvas to avoid wide-brim hat clipping the 92-px cell — see Risk R1)
- sprite id: `agent.claude.opus`

After assembly:

- [ ] Verify dimensions are 736×920.
- [ ] Commit:
  ```bash
  git add claudeville/assets/sprites/characters/agent.claude.opus/sheet.png
  git commit -m "feat: bake Claude Opus archmage sprite at new fidelity"
  ```

### Track F — Bake `agent.claude.sonnet`

Substitutions:

- create_character description:
  ```
  Claude Sonnet 4.6 journeyman scholar, flat scholar mortarboard cap with single feather, knee-length amber scholar cloak with belt sash and visible inkpot pouches, silver quill held high in one hand, floating illuminated scroll trailing behind the shoulder, no tome, nimble balanced silhouette
  ```
- name: `Claude Sonnet Scholar`
- size: 92
- sprite id: `agent.claude.sonnet`

After assembly:

- [ ] Verify 736×920.
- [ ] Commit:
  ```bash
  git add claudeville/assets/sprites/characters/agent.claude.sonnet/sheet.png
  git commit -m "feat: bake Claude Sonnet journeyman scholar (mortarboard + quill, no tome)"
  ```

### Track G — Bake `agent.codex.gpt55`

Substitutions:

- create_character description:
  ```
  Codex GPT-5.5 captain artificer, peaked navy captain cap with gold band, long bright teal officer coat with prominent shoulder epaulettes and gold rune trim, luminous chest core, ornate brass tool belt, commanding tall posture, master engineer leader silhouette
  ```
- name: `Codex GPT-5.5 Captain`
- size: 92
- sprite id: `agent.codex.gpt55`

After assembly:

- [ ] Verify 736×920.
- [ ] Commit:
  ```bash
  git add claudeville/assets/sprites/characters/agent.codex.gpt55/sheet.png
  git commit -m "feat: bake Codex GPT-5.5 captain artificer at new fidelity"
  ```

### Track H — Bake `agent.codex.gpt54`

Substitutions:

- create_character description:
  ```
  Codex GPT-5.4 senior engineer artificer, flat brass-trimmed engineer cap, brass goggles down over the eyes, deep rust-and-bronze coat distinctly different from the bright teal captain's coat, large prominent left-arm gauntlet with exposed gear teeth, visible backpack toolkit silhouette over the right shoulder, sturdy practical artificer silhouette
  ```
- name: `Codex GPT-5.4 Senior`
- size: 92
- sprite id: `agent.codex.gpt54`

After assembly:

- [ ] Verify 736×920.
- [ ] Commit:
  ```bash
  git add claudeville/assets/sprites/characters/agent.codex.gpt54/sheet.png
  git commit -m "feat: bake Codex GPT-5.4 senior (rust palette + arm gauntlet body signature)"
  ```

### Track I — Bake `agent.codex.gpt53spark`

Substitutions:

- create_character description:
  ```
  Codex GPT-5.3 Spark scout artificer mechanic, backwards visor cap with cyan lens, short open vest with rolled-up sleeves over a yellow lightning sash, light short trousers tucked into runner boots, neutral upright stance with ready hands, swift scout engineer silhouette
  ```
- name: `Codex GPT-5.3 Spark Scout`
- size: 92
- sprite id: `agent.codex.gpt53spark`

After assembly:

- [ ] Verify 736×920.
- [ ] Commit:
  ```bash
  git add claudeville/assets/sprites/characters/agent.codex.gpt53spark/sheet.png
  git commit -m "feat: bake Codex GPT-5.3 Spark scout (neutral idle, no forward-lean)"
  ```

### Track J — Generate the four overlay PNGs

**Subagent role:** four pixellab `create_isometric_tile` calls, four downloads, four commits (or one batch commit). Floor rings and the new effortMax head overlay are all 32–64 px tiles, much faster than character bakes (~30s each).

For each entry, call `mcp__pixellab__create_isometric_tile`:

| Sprite ID | Path | Size | Description (after style anchor) |
|---|---|---|---|
| `overlay.status.effortLow` | `claudeville/assets/sprites/overlays/overlay.status.effortLow.png` | 64 | `soft single-band bronze floor ring at agent feet, faint glow, low effort tier marker, transparent background, isometric` |
| `overlay.status.effortMedium` | `claudeville/assets/sprites/overlays/overlay.status.effortMedium.png` | 64 | `double-band silver floor ring at agent feet, gentle pulse glow, medium effort tier marker, transparent background, isometric` |
| `overlay.status.effortHigh` | `claudeville/assets/sprites/overlays/overlay.status.effortHigh.png` | 64 | `triple-band gold floor ring with rune sparks at agent feet, vivid pulse, high effort tier marker, transparent background, isometric` |
| `overlay.accessory.effortMax` | `claudeville/assets/sprites/overlays/overlay.accessory.effortMax.png` | 32 | `vertical triple-pillar gold star crown rising above head, three stacked star points with a laurel wreath base, distinctly vertical pillar shape — NOT a ring, NOT a halo, NOT a circle, Claude maximum tier marker, transparent background, isometric` |

For each:
- [ ] Call `mcp__pixellab__create_isometric_tile` with the description and size.
- [ ] Poll `mcp__pixellab__get_isometric_tile` until 100%.
- [ ] Download the resulting PNG with `curl --fail` to the path above. Use `mkdir -p` if needed.
- [ ] Verify dimensions: `file <path>` reports the correct W×H.

After all four PNGs exist:

- [ ] **Commit**:
  ```bash
  git add claudeville/assets/sprites/overlays/overlay.status.effortLow.png \
          claudeville/assets/sprites/overlays/overlay.status.effortMedium.png \
          claudeville/assets/sprites/overlays/overlay.status.effortHigh.png \
          claudeville/assets/sprites/overlays/overlay.accessory.effortMax.png
  git commit -m "feat: bake effort floor rings (low/med/high) and effortMax head crown"
  ```

---

## WAVE 4 — Validation (sequential, in parent session)

After all Wave 3 subagents have committed, run this final track in the parent session.

### Task W4.1: Run the sprite validator

- [ ] **Step 1: Validate manifest ↔ PNG bidirectional**

```bash
npm run sprites:validate
```

Expected: passes — every manifest entry resolves, no orphan PNGs.

If `js-yaml` is missing locally (per a documented fallback), do the equivalent manual check:
```bash
find claudeville/assets/sprites/characters -name 'sheet.png' | sort
find claudeville/assets/sprites/overlays -name '*.png' | sort
```
Compare against the manifest entries by eye.

- [ ] **Step 2: Confirm walk-motion delta check passes**

The validator's `hasRealWalkMotion` gate (`scripts/sprites/manifest-validator.mjs`) compares walk frames pairwise. If any character fails — that is, its 6 walk frames don't show enough pixel difference — re-run that character's bake (Wave 3 track) with a different `template_animation_id` (e.g., `walking-8-frames` or `walking-6-frames` again with a fresh seed via re-create). Document any re-bakes in commit messages.

### Task W4.2: Browser smoke

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open and verify**

Open `http://localhost:4000` and confirm the following with concrete assertions:

1. **No checkerboard placeholders** — open browser DevTools → Network panel; filter for "sheet.png"; confirm all 6 character sheets return 200 with the URL containing `?v=2026-04-28-character-revamp-v1`.
2. **Console clean** — DevTools → Console — no 404s, no warnings about missing `overlay.status.effortLow/Medium/High` or `overlay.accessory.effortMax`.
3. **Visual tier grammar (zoom = 1)** — at default zoom, verify pairwise:
   - **Opus visibly taller than Haiku by ≥10px** (master vs apprentice).
   - **Sonnet has flat mortarboard, no pointed wizard hat** (scholar grammar holds).
   - **GPT-5.5 has long teal coat with shoulder epaulettes** (captain).
   - **GPT-5.4 has rust-bronze coat with prominent left-arm gauntlet** (visibly different from gpt55's teal).
   - **Spark has backwards cap and yellow sash** (visibly compact and bright).
4. **Floor rings render** — if any active session reports `effort=low/medium/high`, a ring is drawn under the agent's feet. If no live sessions match, verify by selecting any agent (which already triggers `overlay.status.selected`) and confirm no console errors when the renderer attempts to also draw the effort ring.
5. **Head overlays render** — if any active session reports `effort=xhigh`, the existing halo crown shows above the head. If `effort=max` on a Claude session, the new triple-pillar crown shows.
6. **Codex `max` clamp** — if any Codex session reports `effort=max`:
   - Visual: shows `effortXhigh` head halo (not `effortMax`).
   - Label: dashboard text reads "5.5 max" (not "5.5 xhigh") — confirming label preserved per design.
7. **Dashboard mode** — toggle to dashboard, confirm avatar cards render the 6 distinct insignia/headgear; Haiku card shows the new triangle insignia and small hooded cap, NOT the wide-brim wizard hat.
8. **Selection / camera follow** — click an agent in world mode, panel opens, camera follows; click empty world, panel closes.

Manual identity sanity check (for clamp behavior in environments without live `effort=max` sessions):
```bash
node -e "import('./claudeville/src/presentation/shared/ModelVisualIdentity.js').then(m => {
  console.log(m.getModelVisualIdentity('claude-opus-4-7', 'max', 'claude').effortAccessory);
  console.log(m.getModelVisualIdentity('gpt-5-5', 'max', 'codex').effortAccessory);
  console.log(m.formatModelLabel('gpt-5-5', 'max', 'codex'));
})"
```
Expected:
```
effortMax
effortXhigh
5.5 max
```

### Task W4.3: Final git status sanity

- [ ] **Step 1: Clean tree**

```bash
git status --short
```
Expected: clean (or only unrelated edits documented at session start).

- [ ] **Step 2: Review the commit history**

```bash
git log --oneline -25
```
Expected: a focused sequence of commits across Wave 1 (5–6 commits), Wave 2 (1 commit), Wave 3 (7 commits), Wave 4 (no commits — validation only). Total ≈ 13–14 commits.

---

## Cost & Time Budget

| Resource | Per character | Total |
|---|---|---|
| pixellab `create_character` (standard mode) | 1 generation | 6 |
| pixellab `animate_character` walking-6-frames | 8 dirs × 1 = 8 generations | 48 |
| pixellab `animate_character` breathing-idle | 8 dirs × 1 = 8 generations | 48 |
| pixellab `create_isometric_tile` (3 floor rings + effortMax) | 1 generation each | 4 |
| **Total generations** | — | **~106** |
| Wall-clock per character (sequential) | 12–15 min (gen + 2 animations + downloads) | ~75–90 min |
| Wall-clock with parallel Wave 3 (6 subagents) | — | **~12–15 min total** |
| Wave 1 (parallel code prep) | — | ~5–10 min |
| Wave 2 (manifest scaffold) | — | ~5 min |
| Wave 4 (validation) | — | ~10 min |
| **End-to-end with parallel Wave 3** | — | **~35–45 min** |

If subagents do NOT have MCP access, fall back to parent-operator serial execution: ~2 hours end-to-end.

---

## Risks & Open Questions

- **R1. Wide-brim hat clipping (Opus).** The original chibi Opus had a tall flat hat that filled the 92-px cell. The new pointed wizard hat at pixellab `size=92` exceeds the cell easily. Mitigation already applied: Track E uses `size=76` for Opus, giving the canvas room to fit the hat after center-crop. If the resulting Opus character is too small relative to the others at gameplay zoom, re-bake at size 84 or revise the prompt to "tall but narrow pointed hat (no brim)".

- **R2. MCP animation strip dimensions.** The assembler script asserts `walk` strip = `132 × 792` and `breathing-idle` = `132 × 528`. If pixellab returns a different layout (taller padding, vertical strip, per-frame files instead of horizontal), the script throws with a clear error message that includes actual dims. Operator passes `--source-size=<actual>` to retry. No re-generation needed unless the layout is fundamentally different (e.g., per-direction-per-frame).

- **R3. Walk-motion delta gate.** The validator may reject a character whose 6 walk frames are too similar pixel-wise. If pixellab's `walking-6-frames` template produces overly subtle motion at this proportion, re-bake with a different template (e.g., `walking-8-frames`) or with `walking-6-frames` and a different RNG by recreating the character with a small prompt tweak. Document re-bakes in commit messages.

- **R4. effortMax shape uniqueness.** The new effortMax overlay must read as visually distinct from `effortXhigh` at 32px. The prompt explicitly forbids "ring", "halo", "circle". If first-bake review shows it still reads as a halo, re-bake with even more explicit shape language (e.g., "vertical 3-tier obelisk", "stacked star points") or fall back to a colored laurel wreath silhouette.

- **R5. Codex label vs visual divergence.** A Codex session reporting `effort=max` will display label "5.5 max" but render the xhigh halo. This is intentional — label preserves user input, visual clamps to existing asset. If users find this confusing, change `effortTier` in the codex returns instead of just `effortAccessory` (and update the Risks).

- **R6. AvatarCanvas async version.** The new `getSpriteAssetVersion()` fetch resolves asynchronously; the very first paint after a fresh page load uses the fallback constant `'2026-04-26-visual-revamp'` for ~50–200 ms before the real manifest version takes effect. This may serve a stale cached PNG on the first frame. Acceptable since the next paint corrects it; revisit if visible flicker appears.

## Out of Scope

- **Painterly portraits in the activity panel** (would use `gpt-image-1`, which is not configured in this environment). Out of scope for this plan.
- **Gemini character refresh** — `agent.gemini.base` is untouched. Existing rendering for Gemini sessions continues to work; Gemini will look "old" next to the revamped Claude/Codex cast. A follow-up plan is the right place to bake `agent.gemini.flash` / `agent.gemini.pro` in the same grammar.
- **`scripts/sprites/generate-pixellab-revamp.mjs`** — the legacy REST script — left in place as historical reference. Not deleted, not updated.
- **Visual-diff baselines** (`npm run sprites:capture-fresh`) — will not match after this work. Refresh is a follow-up if visual-diff is a CI gate.

## Dispatch Pattern (subagent-driven execution)

When executing this plan via `superpowers:subagent-driven-development`:

1. **Wave 1**: dispatch 3 subagents in parallel (Track A, Track B, Track C). Each gets the relevant section of this plan as their context. Wait for all three to commit.
2. **Wave 2**: parent session executes Task W2 directly (single sequential edit).
3. **Wave 3**: dispatch 7 subagents in parallel (Tracks D–J). Each gets the Common Procedure + their specific substitutions. Wait for all seven to commit. If a subagent lacks MCP access in your harness, the parent runs Wave 3 serially with batched MCP calls.
4. **Wave 4**: parent session runs validation directly. No subagent.

After Wave 4 passes, the lineup is shipped.
