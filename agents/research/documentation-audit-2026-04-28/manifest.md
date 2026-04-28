# Documentation Audit Manifest

Date: 2026-04-28
Baseline: `e55ebbecdccb6b12fc06afe5aa1ad27a83860494`
Scope exclusions: third-party/generated/transient trees (`node_modules/`, `.worktrees/`, `output/`, `.playwright-cli/`, `.playwright-mcp/`).

## Audit Surface

Checked documentation and documentation-like contract files:

- [x] `.claude/skills/troubleshooting/references/integration.md`
- [x] `.claude/skills/verify-architecture/SKILL.md`
- [x] `.claude/skills/verify-server/SKILL.md`
- [x] `.claude/skills/verify-widget-build/SKILL.md`
- [x] `AGENTS.md`
- [x] `CLAUDE.md`
- [x] `README.md`
- [x] `agents/plans/agent-building-interactions-refinement.md`
- [x] `agents/plans/atmosphere-enhancement-roadmap.md`
- [x] `agents/plans/chardesign-revamp.md`
- [x] `agents/plans/chronicle.md`
- [x] `agents/plans/claudeville-atmosphere-epic-rampup.md`
- [x] `agents/plans/claudeville-fix-and-performance-plan.md`
- [x] `agents/plans/claudeville-visual-refresh-plan.md`
- [x] `agents/plans/codex-equipment-coherence-design.md`
- [x] `agents/plans/familiars-and-council.md`
- [x] `agents/plans/feature-foundation.md`
- [x] `agents/plans/forest-sprite-opportunities.md`
- [x] `agents/plans/harbor-capacity-expansion.md`
- [x] `agents/plans/harbor-capacity-phase-b.md`
- [x] `agents/plans/living-twilight-sky.md`
- [x] `agents/plans/north-lagoon-sprint.md`
- [x] `agents/plans/tool-rituals.md`
- [x] `agents/plans/weather-atmosphere-clock-system.md`
- [x] `agents/plans/world-enhancement-plan.md`
- [x] `claudeville/CLAUDE.md`
- [x] `claudeville/adapters/README.md`
- [x] `claudeville/assets/sprites/manifest.yaml`
- [x] `claudeville/assets/sprites/palettes.yaml`
- [x] `claudeville/src/presentation/character-mode/README.md`
- [x] `claudeville/src/presentation/dashboard-mode/README.md`
- [x] `claudeville/src/presentation/shared/README.md`
- [x] `docs/design-decisions.md`
- [x] `docs/motion-budget.md`
- [x] `docs/pixellab-reference.md`
- [x] `docs/swarm-orchestration-procedure.md`
- [x] `docs/troubleshooting.md`
- [x] `docs/visual-experience-crafting.md`
- [x] `scripts/sprites/generate.md`
- [x] `package.json` command/dependency contract

## Remediation Summary

Critical issues found: 0
Major issues found: 8
Minor issues found: 18

Major fixes applied:

- Added missing public routes to root/app docs: `POST /api/session-details` and `GET /api/perf`.
- Corrected adapter cache TTLs to 5 seconds and documented cache-bypass/debug knobs.
- Restored root `CLAUDE.md` / `AGENTS.md` parity.
- Added the missing Harbor Master building to the README building list.
- Corrected native widget polling from 3 seconds to 5 seconds.
- Documented duplicated pricing tables in browser and widget surfaces.
- Updated World/Dashboard/shared presentation docs for batch details, hidden-mode loop pause, volatile cache release, and current helper modules.
- Marked stale implementation plans as historical/superseded or requiring a refreshed baseline.

Minor fixes applied:

- Removed stale source line references where they drifted quickly.
- Corrected `SessionDetailsService` fresh/stale cache TTLs.
- Added `RepoColor.js`, `TeamColor.js`, and batch detail guidance to shared presentation docs.
- Added sprite runbook coverage for manifest entries that use `width`/`height` instead of `size`.
- Marked `generate-pixellab-revamp.mjs` as a legacy static-inventory helper that should be run only with explicit reviewed `--ids`.
- Translated repo-local Claude troubleshooting notes to English and removed destructive port-kill cleanup from verification skill docs.

Verified unchanged:

- `manifest.yaml` and `palettes.yaml` are synchronized.
- Manifest-implied sprite PNG paths exist and no non-placeholder orphan PNGs were found during read-only inspection.
- Internal Markdown links resolved after remediation.
- `package.json` scripts match documented commands.

Remaining concerns:

- Several `agents/plans/*.md` files intentionally remain historical. They are preserved for rationale, but implementation agents must verify them against live code before reuse.
- `claudeville/src/infrastructure/ClaudeDataSource.js` still contains a stale `getHistory()` call path for `/api/history`; no public docs referenced that route, so it was not documented as live API.
- Live server/browser/widget validation was not run during this docs-only pass.
