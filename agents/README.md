# Agent Artifacts

This directory stores committed agent outputs. Before using any old plan as implementation input, check this index first, confirm the artifact still exists in the current checkout, then re-verify the referenced code at the current `HEAD`.

## Status Taxonomy

| Status | Meaning |
| --- | --- |
| `active` | Current guidance, but still requires a fresh baseline before implementation. |
| `ready` | Prepared for execution; safe only after owned paths and current code are rechecked. |
| `historical` | Useful context or implementation history, not a current task list. |
| `superseded` | Replaced by newer docs, code, or plans. Do not execute directly. |
| `deferred` | Intentionally postponed; re-open only with an explicit new assignment. |
| `reference` | Reusable design/process context, not an implementation plan. |
| `missing` | Referenced by older history but not present in this checkout. Do not execute; use the named replacement/source of truth instead. |

## Artifact Index

| Artifact | Status | Last verified | Replacement / source of truth | Safe to execute | Validation notes |
| --- | --- | --- | --- | --- | --- |
| `agents/plans/agent-work-streamlining-plan.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | `agents/handover/agent-work-streamlining-execution.md` and current code. | No | Historical plan is not present in this checkout; use the handover for context only. |
| `agents/handover/agent-work-streamlining-execution.md` | `active` | 2026-04-29 at `34237bfc0aae1da34455c128d761b8f48217ecb1` | Current code plus deferred-work list in the handover. | Partial | Use as the next-boundary record for smoke checks, widget validation, and deferred refactor batches. |
| `agents/plans/code-health-remediation-plan.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current code, `agents/handover/p0-p1-p2-remediation-handover.md`, and `agents/handover/agent-work-streamlining-execution.md`. | No | Historical plan is not present in this checkout; confirm every old finding before reopening. |
| `agents/handover/p0-p1-p2-remediation-handover.md` | `historical` | 2026-04-28 at `d01f400976a268da7a28630e546d6fe64381755a` | Current code and newer follow-up plans. | No | Completion record only; use for residual-risk context. |
| `agents/plans/post-p0-p2-follow-up-plan.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current code and `agents/handover/agent-work-streamlining-execution.md`. | No | Not present in this checkout; do not treat as active guidance. |
| `agents/plans/world-enhancement-plan.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md`, current renderer, `docs/motion-budget.md`, sprite manifest. | No | Replaced by the current world-enhancement swarm plan and current World mode docs. |
| `agents/plans/atmosphere-enhancement-roadmap.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md` and current atmosphere modules. | No | Not present in this checkout; use current code and the consolidated plan. |
| `agents/plans/agent-building-interactions-refinement.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current `AgentManager`, building config, World mode docs, and `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md`. | No | Not present in this checkout; re-audit behavior before edits. |
| `agents/plans/chardesign-revamp.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current `manifest.yaml`, `ModelVisualIdentity.js`, and sprite docs. | No | Historical plan is absent; do not reuse old manifest snippets without verification. |
| `agents/plans/claudeville-atmosphere-epic-rampup.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current atmosphere modules, manifest, and consolidated world plan. | No | Historical plan is absent; several old asset IDs may not exist. |
| `agents/plans/living-twilight-sky.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current `SkyRenderer`, atmosphere modules, and manifest. | No | Superseded rationale is not present in this checkout. |
| `agents/plans/weather-atmosphere-clock-system.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current atmosphere modules and `docs/motion-budget.md`. | No | Superseded rationale is not present in this checkout. |
| `agents/plans/harbor-capacity-phase-b.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current `HarborTraffic.js`, scenery config, World smoke, and consolidated world plan. | No | Not present in this checkout; re-baseline harbor behavior before implementation. |
| `agents/plans/harbor-capacity-expansion.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current harbor code and consolidated world plan. | No | Deferred plan is absent; do not start without new scope. |
| `agents/handover/claudeville-type-design-handover.md` | `reference` | 2026-04-29 | `docs/visual-experience-crafting.md`. | No | Design-transfer packet, not a local implementation plan. |
| `agents/plans/world-enhancement-council-2026-05-17.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md` and current code. | No | Consolidated 2026-05-17 plan is not present in this checkout; use the 2026-05-18 plan and re-verify file:line refs. |
| `agents/research/world-enhancement-council-2026-05-17/` | `reference` | 2026-05-17 at `e919f845c5074487c694d6aa163968df48728de1` | Six per-domain audit notes (visual, behavior, buildings, character, git/harbor, portal/codehealth) feeding the consolidated plan. | No | Rationale + raw findings for the consolidated plan; do not execute the per-member recommendations directly without consulting the consolidated phasing. |
| `agents/plans/deepseek-opencode-agent-support-plan.md` | `missing` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current code in `claudeville/adapters/opencode.js` and related UI/pricing files. | No | Implemented plan is not present in this checkout; use current code as source of truth. |
| `agents/plans/aether-light-activity-module.md` | `ready` | 2026-05-17 at `94a037a1bdd234dcae93370c7d6c4f38555b4d4b` | Current code plus Home Assistant Matter setup; optional sidecar plan for Razer Aether activity lights on EndeavourOS/Linux. | Partial | Requires Home Assistant/Matter preflight, `HA_URL`, `HA_TOKEN`, and `HA_LIGHT_ENTITY`; no runtime code implemented yet. |
| `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md` | `ready` | 2026-05-18 at `61f10ef0c447e43a1199439fd7d78cdda7fa5b31` | Current World mode code plus this six-agent council synthesis. | Partial | 125-idea backlog and phased plan for agent movement, visuals, harbor, buildings, and map rendering; re-baseline owned paths before executing any phase. |
| `agents/plans/code-health-enhancement-swarm-2026-05-22.md` | `historical` | 2026-05-22 at `92b5da14cef52a92ad06fe9c6d6b1a44199ee3eb` | Current code after implementation. | No | Implemented code-health simplification plan; keep as execution provenance, not a live task list. |
| `agents/research/kimi-integration-export/kimi-export-0beb2209-20260501-183644.md` | `historical` | 2026-05-18 doc audit at `9ce51968c422c572930758d6b6f04e3951fe7320` | Current `claudeville/adapters/kimi.js`, `claudeville/adapters/README.md`, and provider docs. | No | Large raw Kimi integration transcript moved out of the repo root; useful only as provenance, not implementation guidance. |
| `agents/claudeville-upgrade.md` | `ready` | 2026-06-09 at `ec205cacc576572135b0835cf6c802a188bf9490` | This consolidated ranked backlog plus the 2026-05-18 swarm plan for fine-grained world items. | Partial | Cross-area ranked upgrade backlog (visuals, performance, metaphor, backend, widgets) from a five-agent exploration; re-verify file:line refs and in-flight Fable edits before executing any tier. |

## Templates

Use these for new committed artifacts:

- `agents/templates/plan.md`
- `agents/templates/research.md`
- `agents/templates/handover.md`

Keep artifacts concise. If a plan becomes stale, update this index with a `superseded` or `historical` row instead of silently deleting context.
