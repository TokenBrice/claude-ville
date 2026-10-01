# Documentation

ClaudeVille documentation stays current, task-oriented, and close to the code it governs. Plans, research, and raw proofs live in the gitignored local `agents/` scratch folder and are never committed.

## Start Here

1. Read the root `README.md` for product shape and quick start.
2. Read `AGENTS.md` or `CLAUDE.md` for shared-checkout rules and validation routing.
3. Read `claudeville/CLAUDE.md` for runtime ownership and invariants.
4. Use the catalog below to find the authoritative contract, runbook, checklist, or reference.

## Documentation Catalog

| Document | Status | Classification | Purpose |
| --- | --- | --- | --- |
| [`docs/README.md`](README.md) | Current | Reference | Indexes maintained documentation and routes contributors to owner-level guidance. |
| [`docs/agent-provider-addition.md`](agent-provider-addition.md) | Current | Runbook | Adds providers or model-registry rows, including fixture and validation routes. |
| [`docs/building-style-contract.md`](building-style-contract.md) | Current | Contract | Defines building silhouette, material, palette, lighting, and landmark-quality rules. |
| [`docs/design-decisions.md`](design-decisions.md) | Current | Reference | Records load-bearing architecture decisions, rationale, and change obligations. |
| [`docs/material-channel-contract.md`](material-channel-contract.md) | Current | Contract | Defines semantic drawables, material channels, sidecars, atlases, and deterministic defaults. |
| [`docs/motion-budget.md`](motion-budget.md) | Current | Contract | Defines animation allocation gates, pulse bands, and reduced-motion fallbacks. |
| [`docs/pixellab-reference.md`](pixellab-reference.md) | Current | Reference | Covers PixelLab capabilities, parameters, lifecycle, and API pitfalls; the generation runbook remains under `scripts/sprites/`. |
| [`docs/rendering-baselines.md`](rendering-baselines.md) | Current | Reference | Defines deterministic renderer evidence, capture metadata, scenario matrix, and performance comparisons. |
| [`docs/troubleshooting.md`](troubleshooting.md) | Current | Runbook | Diagnoses first-hour setup, providers, APIs, graphics, sound, sprite tooling, and opt-in hook ingestion. |
| [`docs/visual-experience-crafting.md`](visual-experience-crafting.md) | Current | Reference | Explains how to adapt ClaudeVille's world-metaphor method to other domains. |
| [`docs/world-visual-qa-checklist.md`](world-visual-qa-checklist.md) | Current | Checklist | Reviews deterministic World scenes, visual hierarchy, effects, materials, and regressions. |

## Workflow Index

| Workflow | Authoritative route |
| --- | --- |
| Hook ingestion | [Permission prompts are inferred or arrive late](troubleshooting.md#permission-prompts-are-inferred-or-arrive-late) documents the payload schema and opt-in Claude Code dogfood setup. |
| Sound | [Sound does not come back](troubleshooting.md#sound-does-not-come-back) diagnoses the sound control; audio changes are gated locally by `npm run audio:probe` ([`scripts/audio/README.md`](../scripts/audio/README.md)), with decisions in [`design-decisions.md`](design-decisions.md). |
| Screenshot capture | Run `npm run verify:render` for UI screenshot and console evidence. Use `npm run sprites:capture-baseline` or `npm run sprites:capture-fresh`, followed by `npm run sprites:visual-diff`, for sprite comparisons. Regenerate the README images in `docs/assets/github/` with `node scripts/world/capture-marketing.mjs --write` against the server on port 4000; without `--write` it writes `output/playwright/marketing-*.png`. |
| Adapter fixtures | Add redacted synthetic transcripts under `scripts/adapters/fixtures/<provider>/` following its [README](../scripts/adapters/fixtures/README.md); `npm run check:adapter-fixtures` runs the adapter contract. |
| Releases | [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases) and [`.claude/skills/release/SKILL.md`](../.claude/skills/release/SKILL.md); `scripts/release/prepare.mjs` owns changelog grammar and version edits. |
| Sprite generation | Follow [`scripts/sprites/generate.md`](../scripts/sprites/generate.md); use the PixelLab reference only for tool/API specifics. |

## Documentation Rules

- Prefer one maintained authority. Code-owner detail belongs in the nearest README; project-wide decisions belong in the relevant contract or decision record.
- Keep runbooks executable: name exact commands, symptoms, and files. Remove stale line references.
- Keep large proofs and screenshots out of `docs/`; keep them in local `agents/` or `output/` scratch. The README images in `docs/assets/github/` are the only committed screenshots here.
- Use English for edited documentation and UI copy.
- Validate structure and links with `npm run verify:architecture`; `npm run check:artifacts` keeps `agents/` scratch out of the repository.

## Related Owner Docs

| Location | Purpose |
| --- | --- |
| [`README.md`](../README.md) | Product overview, quick start, providers, and README screenshots. |
| [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) | Shared-checkout rules, project map, validation routing, and changelog grammar (kept identical after line 2). |
| [`CHANGELOG.md`](../CHANGELOG.md) | Release history, served in-app through `/api/changelog`; the top entry drives `release:check` and `release:verify`. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Contribution lanes, setup, remotes, pull requests, and release publication. |
| [`claudeville/CLAUDE.md`](../claudeville/CLAUDE.md) | Server invariants, model registry, frontend ownership, sprites, and event bus. |
| [`claudeville/adapters/README.md`](../claudeville/adapters/README.md) | Adapter contract and per-provider source formats. |
| [World mode README](../claudeville/src/presentation/character-mode/README.md) | Renderer pipeline, selection, draw order, and canvas contracts. |
| [Dashboard mode README](../claudeville/src/presentation/dashboard-mode/README.md) | Card lifecycle, details, and keyboard behavior. |
| [Shared presentation README](../claudeville/src/presentation/shared/README.md) | Shared chrome, Activity Panel, model identity, selection, detail cache, and the sound system. |
| [`scripts/audio/README.md`](../scripts/audio/README.md) | Listening harness and the local `npm run audio:probe` gate. |
| [`scripts/tests/README.md`](../scripts/tests/README.md) | Unit and integration test catalog. |
| [`scripts/smoke/README.md`](../scripts/smoke/README.md) | Smoke and runtime verification catalog with the change-to-check matrix. |
| [`scripts/adapters/fixtures/README.md`](../scripts/adapters/fixtures/README.md) | Synthetic adapter transcript fixtures, redaction rule, and consumers. |
| [`scripts/sprites/generate.md`](../scripts/sprites/generate.md) | Manifest-first sprite generation runbook. |
