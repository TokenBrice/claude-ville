# Agent Artifacts

This directory is for retained agent outputs that are still useful after the original task. Keep it sparse. The current cleaned checkout intentionally does not keep the old implementation plans, handovers, screenshots, or raw research dumps that older history may mention.

Before using any artifact as implementation input:

1. Confirm the file still exists in the current checkout.
2. Re-read the current source files named by the artifact.
3. Treat old line numbers, screenshots, and generated outputs as hints, not proof.
4. Prefer the live docs in `docs/README.md` and the nearest area README when they disagree with an artifact.

## Status Taxonomy

Use these statuses when retaining an artifact:

| Status | Meaning |
| --- | --- |
| `active` | Current guidance, but still requires a fresh code baseline before implementation. |
| `ready` | Prepared for execution; safe only after owned paths and current code are rechecked. |
| `historical` | Useful provenance, not a current task list. |
| `superseded` | Replaced by newer docs, code, or plans. Do not execute directly. |
| `deferred` | Intentionally postponed; re-open only with an explicit new assignment. |
| `reference` | Reusable design/process context, not an implementation plan. |

## Current Index

No retained implementation artifacts are currently indexed in this cleaned checkout.

When adding one, place it under:

- `agents/plans/<slug>.md` for implementation plans.
- `agents/research/<slug>/` for research notes, proofs, and image dumps.
- `agents/handover/<slug>.md` for handover memos.

Then add a row here:

| Artifact | Status | Last verified | Source of truth | Safe to execute | Validation notes |
| --- | --- | --- | --- | --- | --- |
| [plans/ui-enhancement-plan.md](plans/ui-enhancement-plan.md) | active | 2026-06-14 (v0.9.1.1) | live app + chrome css/JS | After fresh baseline; phased (A-D) | Re-screenshot vs `research/ui-enhancement-plan/`; see §9 |
| [plans/claudeville-enhancement-tasklist.md](plans/claudeville-enhancement-tasklist.md) | active | 2026-06-14 (v0.9.1.1) | live source (workflow `wf_047e98bc-f72`) | After fresh baseline; 6 parallel workstreams, waves in §5 | Re-baseline `≈` line-refs; per-WS gates in §10; chrome/UI tasks split to `ui-enhancement-second-pass.md`; coordinates with both UI plans (§9) |
| [plans/ui-enhancement-second-pass.md](plans/ui-enhancement-second-pass.md) | active | 2026-06-14 (v0.9.1.1) | live source (extracted from tasklist) | Fold into `ui-enhancement-plan.md` phases C/D | 6 topbar/sidebar/a11y tasks mapped to chrome issues I5/I6/I9; `perf-health-readout` emit coordinates with tasklist WS-E |
| [plans/claudeville-building-harmonization-upgrade-plan.md](plans/claudeville-building-harmonization-upgrade-plan.md) | historical | 2026-06-15 (v0.15.0) | manifest.yaml + live sprites + BuildingVisualRegistry | Executed — see "Execution status" in the plan | Done: 5 buildings regenerated, composeGrid retired, style source unified, validators pass. Optional follow-ups: Archive de-violet, visual-diff re-baseline |
| [plans/claudeville-atmosphere-life-upgrade-plan.md](plans/claudeville-atmosphere-life-upgrade-plan.md) | historical | 2026-06-15 (v0.15.0) | live source + scenery.js/manifest.yaml + `research/atmosphere-life-upgrade/` before/after shots | Executed — see "Execution status" in the plan | Done: ground decals+flowers, day/night insects, songbirds+waterfowl, distant-sea horizon, wall/gate art-up. Wall/gate kept procedural (animated doors) — note in plan. validate:quick + world validators pass |
| [claudeville-visual-upgrade-top-50.md](claudeville-visual-upgrade-top-50.md) | ready | 2026-06-20 (v0.16.1) | live source + `research/claudeville-visual-upgrade/screenshots/` | After fresh baseline; phased Tier 0→3, build foundations #1–#3 (palette/value-hierarchy/grade) before any spectacle | Prioritized top-50 from council workflow `wf_b45983a7-5ce` (6 recon scouts → 10 Opus seats → 115 canonical → 5 debate stances + 4 judges). Re-verify named files/functions before implementing; per-area smoke checks; mark + motion budgets enforced |
| [plans/claudeville-visual-upgrade-implementation-orchestration.md](plans/claudeville-visual-upgrade-implementation-orchestration.md) | ready | 2026-06-20 (v0.16.1) | live source + audited footprints (prep run `wf_d59b5cba-a6b`) | Runnable: `plans/build-workflow/implement-visual-upgrade.workflow.js` (Workflow `{scriptPath}`). Branch `visual-upgrade-build`; foundation serial then 23 file-disjoint waves | Parallel implementation orchestration for the top-50. 23 waves / max width 5; ~36 core-logic items serialized on hot files. Shared-tree + file-disjoint waves + verify(node --check + stray-scope)+commit per wave; `validate:quick` per tier. Re-audit footprints if source drifts before launching |
| [github-visibility-plan.md](github-visibility-plan.md) | active | 2026-06-29 | live GitHub repo metadata + README/package/community-file audit + `../pharos-watch` comparison | Yes, phase by phase after canonical-repo and license decisions | Docs/settings plan for GitHub topics, README conversion, public media, community health files, issue/PR templates, releases, and lightweight trust signals |
| [plans/v0.23-visual-overhaul.md](plans/v0.23-visual-overhaul.md) | historical | 2026-07-12 (v0.23.0) | live source + exploration workflow `wf_cabc5b89-938` | Executed — see "Execution status" in the plan | Released as v0.23.0 *Tides & Torchlight*: harbor flock restored, water/vegetation/atmosphere upgrades, accessory anchoring. 29/30 items verified by adversarial audit workflows; C4 partial by allowed fallback |
| [plans/v0.24-sound-atmosphere.md](plans/v0.24-sound-atmosphere.md) | historical | 2026-07-12 (v0.24.0) | live source (`shared/audio/`) | Executed — see "Execution status" in the plan | Released as v0.24.0 *Bells & Birdsong*: reactive soundscape + songbook music composer. Music layer exceeded plan spec per operator feedback. Verified via Playwright layer/RMS/cue checks |
| [plans/claudeville-performance-implementation.md](plans/claudeville-performance-implementation.md) | historical | 2026-07-14 (v0.25.0) | live source + Linux watcher/RSS + `/api/perf` + Playwright/CDP heap/CPU | Executed - see the plan's implementation record | Released as v0.25.0 *Steady Hearth*: 44,669 -> 59 physical watches; byte-bounded/cancellable transcript caches; scoped invalidation; bounded World/lifecycle/assets/widgets; town visuals preserved. Native macOS/Plasma runtime checks remain platform-only. |

Keep artifacts concise. If a retained plan becomes stale, update this index with `superseded` or `historical` instead of letting it look current.
