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

Keep artifacts concise. If a retained plan becomes stale, update this index with `superseded` or `historical` instead of letting it look current.
