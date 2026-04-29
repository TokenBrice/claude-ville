# ClaudeVille-Type Design Handover

Use this handover when an agent wants to reuse ClaudeVille's visual-representation framework for a different scenery or domain. Do not copy the fantasy village literally. Copy the contracts, separation of concerns, and validation habits.

## Core Transfer

ClaudeVille turns local AI coding sessions into a legible place:

- The system is a bounded world.
- Durable concepts are landmarks.
- Active sessions are characters.
- Tool use and communication become motion or temporary effects.
- Exact text, history, and controls remain in DOM UI.
- Sprite assets are manifest-driven, cache-busted, validated, and replaceable.

A new implementation should preserve those rules while changing the scenery. Examples: a spaceport for deployment pipelines, a harbor for logistics, a factory for build systems, a clinic for incident response, a newsroom for content workflows, or a research campus for data exploration.

## First Decisions

Write these before touching rendering code or generating sprites:

| Decision | Output |
| --- | --- |
| Domain boundary | What data belongs in the world, and what stays outside. |
| Scenery metaphor | One recognizable setting that can host every major state. |
| Landmark list | 6-12 stable places mapped to long-lived concepts. |
| Actor list | The active entities that move, wait, communicate, fail, or complete. |
| Event vocabulary | Recent events that deserve particles, flashes, trails, or route changes. |
| Dense UI | The panel, dashboard, or table that carries exact inspection data. |
| Asset manifest | IDs, prompts, sizes, anchors, paths, palette keys, and asset version. |
| Motion budget | Which cues are static, slow, medium, fast, or disabled in reduced motion. |

If a concept cannot be mapped clearly, keep it out of the scenery and expose it in the dashboard until the model is clearer.

## Architecture To Reuse

Keep domain state independent from renderers. Use a world adapter that converts product data into landmarks, actors, relationships, and semantic events. Let both Canvas and DOM subscribe to the same state.

Recommended layers:

- Data adapters: read external systems and normalize records. They should be read-only unless the product is explicitly an editor.
- Domain state: owns entities, stable IDs, statuses, relationships, and event emission.
- Canvas world: renders terrain, landmarks, actors, motion, particles, hit testing, camera, and minimap.
- DOM dashboard: renders dense scanning, filters, exact labels, history, controls, and accessibility.
- Shared UI: owns selection, detail fetches, model/type visual identity, toasts, and modal surfaces.
- Asset manager: loads a manifest, maps IDs to paths, cache-busts PNGs, and falls back visibly when assets are missing.

The Canvas should answer "what is happening and where?" The DOM should answer "what exactly is this and what can I do?"

## Visual Grammar

Define the grammar once and keep it stable:

- Shape identifies kind.
- Color identifies family.
- Motion identifies active behavior.
- Glow identifies attention or freshness.
- Size identifies real importance.
- Labels are sparse and mostly for landmarks, hover, or selection.
- Depth order follows world position.
- Selection and hover use one shared vocabulary across Canvas, sidebar, and dashboard.

Avoid using the same cue for conflicting meanings. If red means failure, do not use red as a harmless family color.

## Scenery Adaptation Template

Fill this for the new project:

```md
# <Project> Scenery Brief

Domain:
Scenery metaphor:
Primary user question:

Landmarks:
| Data concept | Landmark | Why this shape | Interaction |
| --- | --- | --- | --- |

Actors:
| Entity | Sprite family | Identity cues | Movement behavior |
| --- | --- | --- | --- |

Events:
| Event | Visual cue | Lifetime | Reduced-motion fallback |
| --- | --- | --- | --- |

Dense UI:
Canvas responsibilities:
DOM responsibilities:

Asset manifest:
Path contract:
Palette rules:
Validation plan:
```

## Sprite And Tooling Rules

Use ClaudeVille's manifest-first asset discipline:

- One manifest is the source of truth for asset IDs, prompts, sizes, anchors, composed layers, palette keys, and asset version.
- Every renderer-referenced sprite must have a manifest entry.
- Every PNG under the sprite tree must be expected by the manifest, except explicit placeholders or documented allowlists.
- Bump the asset version when changed PNGs may be cached by the browser.
- Keep runtime code tied to manifest IDs and path mapping, not to one generation provider.
- Validate existence, orphan PNGs, duplicate PNGs, palette parity, dimensions, and character-sheet contracts.

PixelLab is useful for ClaudeVille because it has MCP and REST surfaces for characters, isometric tiles, transparent props, tilesets, and larger freeform images. Another project can use another generator if it preserves the same manifest/path/validation contract.

## Motion Rules

Treat motion as information, not ornament:

- Static: durable state, idle landmarks, low-priority ambience.
- Slow: selection, tracking, low-frequency sweeps.
- Medium: active work, route progress, meaningful current state.
- Fast: one-shot recent events only.
- Reduced motion: no particles, drifting trails, repeated pulses, or continuous timers required for comprehension.

Each new animated cue needs an owner, a pulse band, a cap, and a static fallback.

## Validation Checklist

Run this before handoff:

- Empty dataset does not look broken.
- Small, normal, and overloaded datasets remain legible.
- Unknown families/types fall back gracefully.
- Every actor can be selected and inspected.
- Selection synchronizes between world, sidebar/dashboard, and detail panel.
- Canvas hit targets match visible sprites.
- Labels do not crowd the world.
- Reduced-motion mode still communicates state.
- Missing assets show an obvious placeholder during development.
- Asset validation passes.
- Browser smoke covers the desktop viewport target.

## Common Failure Modes

- The scenery becomes decoration and no longer answers operational questions.
- Generated art forces changes to the domain model.
- Too many status colors compete with family colors.
- Too much motion hides the important motion.
- Dense text is pushed into Canvas instead of DOM.
- Actor identity is random across reloads.
- Aggregation hides critical outliers.
- Asset paths and manifest IDs drift apart.

## Agent Starting Point

Read these ClaudeVille files for the original implementation pattern:

- `docs/visual-experience-crafting.md`
- `docs/motion-budget.md`
- `scripts/sprites/generate.md`
- `docs/pixellab-reference.md`
- `claudeville/src/presentation/character-mode/README.md`
- `claudeville/src/presentation/shared/README.md`

Then write the new project's scenery brief before generating assets or designing renderer branches.
