# Agent Artifacts

This directory stores committed agent outputs. Before using any old plan as implementation input, check this index first, then re-verify the referenced code at the current `HEAD`.

## Status Taxonomy

| Status | Meaning |
| --- | --- |
| `active` | Current guidance, but still requires a fresh baseline before implementation. |
| `ready` | Prepared for execution; safe only after owned paths and current code are rechecked. |
| `historical` | Useful context or implementation history, not a current task list. |
| `superseded` | Replaced by newer docs, code, or plans. Do not execute directly. |
| `deferred` | Intentionally postponed; re-open only with an explicit new assignment. |
| `reference` | Reusable design/process context, not an implementation plan. |

## Artifact Index

| Artifact | Status | Last verified | Replacement / source of truth | Safe to execute | Validation notes |
| --- | --- | --- | --- | --- | --- |
| `agents/plans/agent-work-streamlining-plan.md` | `historical` | 2026-04-29 at `34237bfc0aae1da34455c128d761b8f48217ecb1` | `agents/handover/agent-work-streamlining-execution.md` and current code. | No | Major low-risk phases were implemented; large refactors are deferred in the handover. |
| `agents/handover/agent-work-streamlining-execution.md` | `active` | 2026-04-29 at `34237bfc0aae1da34455c128d761b8f48217ecb1` | Current code plus deferred-work list in the handover. | Partial | Use as the next-boundary record for smoke checks, widget validation, and deferred refactor batches. |
| `agents/plans/code-health-remediation-plan.md` | `historical` | 2026-04-28 baseline in file | Current code plus `agents/plans/post-p0-p2-follow-up-plan.md` and `agents/plans/agent-work-streamlining-plan.md`. | No | Many P0-P2 items were completed; confirm every finding before reopening. |
| `agents/handover/p0-p1-p2-remediation-handover.md` | `historical` | 2026-04-28 at `d01f400976a268da7a28630e546d6fe64381755a` | Current code and newer follow-up plans. | No | Completion record only; use for residual-risk context. |
| `agents/plans/post-p0-p2-follow-up-plan.md` | `active` | 2026-04-28 baseline in file | Current code; overlapping workflow items moved into `agent-work-streamlining-plan.md`. | Partial | Several items are implemented at the 2026-04-29 baseline; re-audit before edits. |
| `agents/plans/world-enhancement-plan.md` | `active` | Review provenance in file; pre-2026-04-29 | Current renderer, `docs/motion-budget.md`, sprite manifest. | Partial | Treat as visual roadmap; reconcile asset IDs, renderer names, and validation commands first. |
| `agents/plans/atmosphere-enhancement-roadmap.md` | `active` | 2026-04-28 | Current atmosphere modules and manifest. | Partial | Refresh baseline and asset IDs before assigning implementation slices. |
| `agents/plans/agent-building-interactions-refinement.md` | `active` | 2026-04-28 | Current `AgentManager`, building config, and World mode docs. | Partial | Use as behavior design input; validate movement and selection in browser. |
| `agents/plans/chardesign-revamp.md` | `historical` | 2026-04-28 | Current `manifest.yaml`, `ModelVisualIdentity.js`, and sprite docs. | No | Completed/history; do not reuse manifest snippets without verification. |
| `agents/plans/claudeville-atmosphere-epic-rampup.md` | `historical` | 2026-04-27 | `agents/plans/atmosphere-enhancement-roadmap.md` plus current manifest. | No | Several proposed asset IDs may not exist. |
| `agents/plans/living-twilight-sky.md` | `superseded` | Pre-2026-04-29 | Current `SkyRenderer`, atmosphere modules, and manifest. | No | Rationale only. |
| `agents/plans/weather-atmosphere-clock-system.md` | `superseded` | Pre-2026-04-29 | Current atmosphere modules and `docs/motion-budget.md`. | No | Rationale only. |
| `agents/plans/harbor-capacity-phase-b.md` | `ready` | 2026-04-26 | Current `HarborTraffic.js`, scenery config, and World smoke. | Partial | Reconfirm Phase A/B state before implementation. |
| `agents/plans/harbor-capacity-expansion.md` | `deferred` | 2026-04-26 | `harbor-capacity-phase-b.md` for the minimal cut. | No | Phase A deferred; do not start without new scope. |
| `agents/handover/claudeville-type-design-handover.md` | `reference` | 2026-04-29 | `docs/visual-experience-crafting.md`. | No | Design-transfer packet, not a local implementation plan. |

## Templates

Use these for new committed artifacts:

- `agents/templates/plan.md`
- `agents/templates/research.md`
- `agents/templates/handover.md`

Keep artifacts concise. If a plan becomes stale, update this index with a `superseded` or `historical` row instead of silently deleting context.
