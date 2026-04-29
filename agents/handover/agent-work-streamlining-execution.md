# Agent Work Streamlining Execution Handover

Date: 2026-04-29
Status: implemented with deferred large refactors
Baseline HEAD: `34237bfc0aae1da34455c128d761b8f48217ecb1`
Plan source: `agents/plans/agent-work-streamlining-plan.md`

## Landed Scope

- Added agent artifact governance:
  - `agents/README.md`
  - reusable templates under `agents/templates/`
  - root README and AGENTS/CLAUDE links
  - Quick Modes in `docs/swarm-orchestration-procedure.md`
- Added `docs/agent-provider-addition.md` for provider/model/visual identity additions.
- Added no-install validation tooling:
  - `check:server`
  - `check:adapters`
  - `check:services`
  - `check:frontend-syntax`
  - `check:scripts`
  - `check:git-events`
  - `check:adapter-fixtures`
  - `validate:quick`
- Added widget and sprite safety checks:
  - stale bundle check
  - source widget check
  - KDE package check
  - pricing consistency check backed by `claudeville/src/config/model-pricing.json`
  - sprite runtime ID audit
  - manifest-backed sprite planning dry run
  - legacy PixelLab revamp `--ids` guard
- Hardened adapter/runtime contracts:
  - adapter metadata export
  - registry-level session/detail normalization
  - server detail provider validation from registry metadata
  - synthetic `git` detail response
  - git enrichment counters in `/api/perf`
  - `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1`
  - `/api/usage` provider annotation
- Improved frontend state/debug behavior:
  - domain/application status normalization
  - consistent `World.getStats()`
  - `App.destroy()` cleanup path
  - `SessionDetailsService` debug counters
  - desktop-only notes in scoped frontend docs
- Added low-risk World mode cleanup:
  - documented drawable contract in `DrawablePass.js`
  - safer terrain-cache `motionScale` restoration
  - corrected building drawable cache comment
  - World README guidance for future `buildingVisuals`, pulse helper, and frame context extraction

## Validation Run

Passed:

```bash
npm run validate:quick
npm run sprites:validate
git diff --check
diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)
npm run sprites:plan -- --ids=agent.codex.gpt54
node scripts/sprites/generate-pixellab-revamp.mjs --dry-run --ids=building.command
node scripts/sprites/generate-pixellab-revamp.mjs --dry-run
```

The final `generate-pixellab-revamp.mjs --dry-run` command exits non-zero by design when `--ids` is omitted.

Explicit safety failures still expected:

```bash
npm run widget:verify-bundle
npm run widget:check
```

They report that the ignored generated app bundle is stale against `widget/Resources/widget.html`. `widget:check` also reports that `swiftc` is not available on this Linux host. Rebuild/verify on macOS only when widget runtime validation is in scope.

Runtime endpoint curl checks against the existing `localhost:4000` process returned HTTP 200 for `/api/providers`, `/api/sessions`, and `/api/perf`, but that process was already running and may not include the edited `server.js` until restarted.

## Deferred Work

The following plan items remain intentionally deferred because they are broad refactors or require platform/runtime validation:

- Full `IsometricRenderer.js` layer extraction.
- Full `buildingVisuals` registry migration.
- `AgentSprite` movement/visual/equipment split.
- CSS refinement-layer collapse.
- Centralized runtime generation from `model-pricing.json` into JS/Swift/QML.
- Deep adapter parser extraction beyond normalization fixtures.
- Selection controller and shared presentation row builders.
- macOS widget build/runtime smoke.
- Browser visual smoke and sprite visual diff under a restarted dev server.

## Next Boundary

Recommended next implementation batch:

1. Restart `npm run dev` and perform browser smoke for World, Dashboard, selection, Activity Panel, and `/api/perf.gitEnrichment`.
2. On macOS, run `npm run widget:build`, `npm run widget`, then `npm run widget:verify-bundle`.
3. Implement the selection controller and shared presentation helpers before attempting CSS consolidation.
4. Implement World drawable/layer extraction in a dedicated full-swarm branch with browser screenshots and sprite visual diff.
