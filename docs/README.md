# Documentation

This directory holds current operational and design documentation for ClaudeVille. It should stay small, current, and task-oriented. Historical agent plans and raw research do not belong here; keep those under `agents/` only when they are still useful enough to index.

## Start Here

Read these in order when joining the project:

1. `README.md` for the product shape, quick start, APIs, and top-level validation.
2. `AGENTS.md` or `CLAUDE.md` for shared-checkout rules, git hygiene, and repo-wide constraints.
3. `claudeville/CLAUDE.md` for implementation context inside the app.
4. The specific runbook below for the task you are doing.

## Task Map

| Task | Read |
| --- | --- |
| Diagnose a first-hour setup, provider, API, or graphics issue | `docs/troubleshooting.md` |
| Understand load-bearing constraints before changing architecture | `docs/design-decisions.md` |
| Add or change a provider, model, pricing identity, or agent sprite mapping | `docs/agent-provider-addition.md` |
| Add World mode animation, pulses, particles, or reduced-motion behavior | `docs/motion-budget.md` |
| QA World mode visuals, deterministic scenarios, terrain cache, or sprite refreshes | `docs/world-visual-qa-checklist.md` |
| Generate or edit PixelLab sprite assets | `scripts/sprites/generate.md`, then `docs/pixellab-reference.md` only for tool/API specifics |
| Adapt the ClaudeVille world-metaphor approach to another domain | `docs/visual-experience-crafting.md` |

## Documentation Rules

- Prefer one maintained source of truth over parallel notes. If a detail belongs to code ownership, put it in the nearest area README or `claudeville/CLAUDE.md`; if it is a project-wide decision, put it in `docs/design-decisions.md`.
- Keep runbooks executable. Include commands, expected symptoms, and the exact files to check. Remove stale line references instead of preserving them as provenance.
- Keep `/docs` focused on current guidance. Move large proofs, screenshots, and exploratory notes to `agents/research/` only when the repo needs to retain them.
- Use English for new or edited docs and UI copy.
- For docs-only changes, review the diff and run `git status --short`. Use `npm run validate:quick` only when the doc change affects commands, generated assets, validation policy, or code-facing contracts.

## Related Local Docs

| Location | Purpose |
| --- | --- |
| `PRODUCT.md` | Product purpose, audience, positioning, and brand principles. |
| `DESIGN.md` | DOM chrome design system and visual design contract. |
| `CHANGELOG.md` | Named release history shown in-app from the version chip. |
| `CONTRIBUTING.md` | Public contribution lanes, setup, validation, and pull request expectations. |
| `SECURITY.md` | Private vulnerability reporting policy and scope. |
| `SUPPORT.md` | Support routing for setup, provider, and visual issues. |
| `claudeville/adapters/README.md` | Adapter contract and normalized provider data. |
| `claudeville/src/presentation/character-mode/README.md` | World mode renderer pipeline and canvas contracts. |
| `claudeville/src/presentation/dashboard-mode/README.md` | Dashboard renderer lifecycle and detail polling. |
| `claudeville/src/presentation/shared/README.md` | Top bar, sidebar, activity panel, model identity, and shared detail cache. |
| `scripts/sprites/generate.md` | Manifest-first sprite generation and validation workflow. |
| `agents/README.md` | Current agent-artifact policy and retained artifact index. |
