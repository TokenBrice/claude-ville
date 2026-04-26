# ClaudeVille Sprite Asset Runbook

This runbook covers the current manifest-first sprite workflow for ClaudeVille. It replaces older fixed asset-count plans: always trust `claudeville/assets/sprites/manifest.yaml` over hardcoded IDs in old notes.

## Sources Of Truth

| File | Purpose |
| --- | --- |
| `claudeville/assets/sprites/manifest.yaml` | Canonical sprite IDs, prompts, tool names, sizes, anchors, composed-building layers, style anchor, asset version, and palette block. |
| `claudeville/assets/sprites/palettes.yaml` | Standalone palette mirror for tooling. Keep it in sync with the `palettes` block in `manifest.yaml`. |
| `claudeville/src/presentation/character-mode/AssetManager.js` | Runtime path mapping, manifest flattening, composed building loading, cache busting, and placeholder fallback. |
| `claudeville/src/presentation/character-mode/SpriteSheet.js` | Character sheet layout contract. Current sheets are 8 columns by 10 rows of 92px cells. |
| `scripts/sprites/manifest-validator.mjs` | Manifest-to-PNG validation and character-sheet motion checks. |

## Setup

Runtime does not need npm packages, but the sprite tools do:

```bash
npm install
```

Pixellab generation requires the MCP server and an API token:

```bash
claude mcp add --transport http pixellab https://api.pixellab.ai/mcp \
  --header "Authorization: Bearer YOUR_API_TOKEN"
claude mcp list
```

Expected: `pixellab` is connected.

## Path Contract

Every generated PNG must land at the path implied by its manifest ID:

| ID prefix | Expected path |
| --- | --- |
| `agent.*` | `claudeville/assets/sprites/characters/<id>/sheet.png` |
| `overlay.*` | `claudeville/assets/sprites/overlays/<id>.png` |
| `building.*` | `claudeville/assets/sprites/buildings/<id>/base.png`, or composed grid/layer files when `composeGrid`/`layers` are set |
| `prop.*` | `claudeville/assets/sprites/props/<id>.png` |
| `veg.*` | `claudeville/assets/sprites/vegetation/<id>.png` |
| `terrain.*` | `claudeville/assets/sprites/terrain/<id>/sheet.png` |
| `bridge.*`, `dock.*` | `claudeville/assets/sprites/bridges/<id>.png` |
| `atmosphere.*` | `claudeville/assets/sprites/atmosphere/<id>.png` |

If the runtime cannot load an image, `AssetManager` falls back to `assets/sprites/_placeholder/checker-64.png`. Checkerboard output in the browser usually means a manifest/path/PNG problem.

## Generation Rules

1. Read the current `style.anchor` from `manifest.yaml`.
2. For entries with `prompt`, prepend the anchor to that prompt.
3. For tileset entries with `lower` and `upper`, prepend the anchor to both descriptions and pass them as the lower/upper tileset inputs.
4. Use the entry's `tool`, `size`, `n_directions`, `animations`, `composeGrid`, and `layers` fields.
5. Save output to the path contract above.
6. Bump `style.assetVersion` when changed PNGs may be browser-cached.
7. If editing palette keys or colors, keep `manifest.yaml` and `palettes.yaml` synchronized.

Use `curl --fail` when downloading direct Pixellab URLs. Pixellab may return non-PNG JSON while a job is still pending; `--fail` prevents accidentally saving that response as an image.

## Smoke Before Bulk Work

Before broad regeneration, prove the pipeline with one low-risk asset:

1. Pick one manifest entry, usually a prop/status overlay with high visibility.
2. Call the Pixellab tool for only that entry.
3. Save the PNG to the manifest-implied path.
4. Verify with `file <path>` and `npm run sprites:validate`.
5. Review in the browser if the asset is visible in World mode.

For direct JSON-RPC smoke tests, the known-good sequence is:

```text
initialize -> tools/list -> tools/call(create_isometric_tile) -> poll get_isometric_tile -> curl --fail download
```

## Prioritizing Regeneration

Do not regenerate by manifest order. Rank candidates by runtime impact:

1. Missing PNGs for currently referenced manifest IDs.
2. Globally visible UI/status assets such as `overlay.status.selected`.
3. Size or shape mismatches against `manifest.yaml` and `SpriteSheet.js`.
4. Hero buildings and high-traffic props.
5. Decorative vegetation/atmosphere.

Do not treat `736x920` character sheets as suspicious by default. That is the expected size for 8 directions × 10 animation rows × 92px cells.

## Validation

Run after sprite changes:

```bash
npm run sprites:validate
```

For visual regression checks:

```bash
npm run dev
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

`sprites:visual-diff` compares against screenshots under `docs/superpowers/specs/2026-04-25-pixel-art-baseline` when that baseline exists. If no baseline exists, it exits successfully with a warning.

If dependencies are unavailable and installing them is out of scope, use fallback validation:

```bash
file claudeville/assets/sprites/path/to/touched.png
```

Then inspect `manifest.yaml`, `AssetManager._pathFor()`, and browser output for checkerboard placeholders.

## Commit Hygiene

For broad sprite work, commit in small batches by category or runtime impact. Do not mix generated PNGs with renderer code unless both are required for the same visible behavior.
