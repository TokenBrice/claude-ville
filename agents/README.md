# Retained agent artifacts

Committed agent outputs belong under `/agents/` only when they remain useful after the task that produced them. Use the path that matches the artifact:

- `agents/plans/<slug>.md` — implementation plans and their execution records.
- `agents/research/<slug>/` — research notes, audits, proofs, and supporting evidence.
- `agents/handover/<slug>.md` — handover memos for work that another agent must continue.

Before using or adding a retained artifact, check this index and the artifact's own status. Deleted historical artifacts are not implementation guidance. `agents/plans/open-followups.md` is the live checklist of still-open or deferred work; a plan may be implemented while items from it remain on that checklist.

## Current inventory

Statuses below are the statuses recorded in the artifacts themselves.

### Plans

| Artifact | Status | Purpose |
| --- | --- | --- |
| [`plans/claudeville-comprehensive-remediation-plan.md`](plans/claudeville-comprehensive-remediation-plan.md) | `implemented and verified` | Comprehensive remediation plan and verification record. |
| [`plans/claudeville-council-enchantment-plan.md`](plans/claudeville-council-enchantment-plan.md) | `shipped as v0.36.0` | Council of Six enchantment plan: 15 consolidated items, cross-item contracts, and wave sequencing against `v0.35.0.1`. Note: `CHANGELOG.md` records its items as shipped in `v0.36.0`; the artifact header was stale and is now corrected (see the Fable 5.1 plan, item 0.6). |
| [`plans/claudeville-fable-5.1-enhancement-implementation-plan.md`](plans/claudeville-fable-5.1-enhancement-implementation-plan.md) | `shipped as v0.38.0 + v0.39.0` | Fable 5.1 enhancement plan (*The Commander's Map*): five cross-item contracts and 29 items across five waves against `v0.37.0` — truth hotfixes (pricing, identity, cold scans, overlays), operator signal (provider-reported cost, turn timing, working set, hook ingestion), GPU-path light delivery (ladder, parity, attention lights, labels), and the chrome as an instrument. The 24 Waves 0-3 items shipped in `v0.38.0`; the 5 Wave 4 items shipped in `v0.39.0` (the generated distant-shore band was built and cut on maintainer review). |
| [`plans/claudeville-opus5-improvement-plan.md`](plans/claudeville-opus5-improvement-plan.md) | `executed` | Opus 5 improvement plan, round assignments, execution record, and Wave 4 research verdicts. Its header formerly read `proposed — not started`; that was stale and was corrected 2026-08-30. |
| [`plans/claudeville-post-oom-reliability-performance-plan.md`](plans/claudeville-post-oom-reliability-performance-plan.md) | `implemented and release-verified` | Post-OOM reliability and performance plan. |
| [`plans/claudeville-semantic-diorama-rendering-plan.md`](plans/claudeville-semantic-diorama-rendering-plan.md) | `implemented and release-verified for v0.33.0` | Semantic diorama rendering plan and release record. |
| [`plans/open-followups.md`](plans/open-followups.md) | `live checklist` | Active ledger of open, deferred, conditional, and already-landed follow-ups. |

### Research

| Artifact | Status | Purpose |
| --- | --- | --- |
| [`research/claudeville-comprehensive-verification/audit.md`](research/claudeville-comprehensive-verification/audit.md) | `ready` | Comprehensive verification audit and evidence index. |
| [`research/claudeville-fable-5.1-review/`](research/claudeville-fable-5.1-review/) | `ready` | Evidence for the Fable 5.1 plan: four read-only reviews (`rendering-review.md`, `ui-review.md`, `signal-review.md`, `sol-outside-review.md`), the GPU quality-ladder timeline and probe script, and eight reference captures under `shots/`. |

There are currently no handover memos under `agents/handover/`. The checkout also contains `agents/.DS_Store`, which is macOS directory metadata, not a retained agent artifact and has no project status.
