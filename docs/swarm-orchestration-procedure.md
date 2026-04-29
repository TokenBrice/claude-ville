# Swarm Orchestration SOP

Use this procedure when a request can be split into parallel, independent workstreams, or when the user explicitly asks for swarm/subagent execution.

Do not use this SOP when the user forbids subagents or asks for a quick direct change.

## Quick Modes

| Mode | Use when | Shape |
| --- | --- | --- |
| Direct single-owner task | One agent can safely read, edit, validate, and report. | No subagents; start and end with `git status --short`. |
| Read-only light swarm | Independent research, audit, inventory, ranking, or validation slices. | 1-3 notes-only agents; orchestrator synthesizes and performs any small edits. |
| Full implementation swarm | Multiple editable slices, shared contracts, or correctness risk. | Owned-path baselines, scoped workers, reviewer gate, optional handover. |

Copyable read-only audit packet:

```text
Goal:
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths: none
  read-only paths:
  current HEAD:
  current git status summary:
Non-goals: Do not edit files, stage, commit, or run destructive commands.
Direct edits allowed: no
Expected output: Findings with file/line references, severity, and validation notes.
Validation required:
Stop conditions: Stop if required files are missing or target paths change during review.
Return format: Findings, validation run, residual risks.
```

Copyable implementation worker packet:

```text
Goal:
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths:
  read-only paths:
  current HEAD:
  current git status summary:
  owned-path baseline:
Non-goals:
Direct edits allowed: yes
Expected output: Summary, changed files, validation run, residual risks.
Validation required:
Stop conditions: Stop if owned paths have unexpected unrelated edits.
Return format: Worker Output template.
```

Copyable reviewer packet:

```text
Goal: Review the proposed changes for correctness, scope, and validation gaps.
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths: none
  read-only paths:
  current HEAD:
  current git status summary:
Non-goals: Do not edit, stage, commit, or expand scope.
Direct edits allowed: no
Expected output: approve | approve-with-fixes | request-changes | defer-follow-up.
Validation required:
Stop conditions: Stop if the reviewed diff no longer matches the worktree.
Return format: Reviewer Output template.
```

Copyable handover packet:

```text
Goal: Produce a concise handover for completed or deferred work.
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths: agents/handover/<slug>.md
  read-only paths:
  current HEAD:
  current git status summary:
Non-goals: Do not edit implementation files.
Direct edits allowed: yes, handover path only
Expected output: Handover artifact with landed changes, validation, risks, and next boundary.
Validation required: Docs diff review and `git status --short`.
Stop conditions: Stop if handover path has unexpected unrelated edits.
Return format: Summary, changed files, validation run.
```

## Activation Matrix

| Task shape | Default workflow |
| --- | --- |
| Single-file, low-risk edit | Direct execution; no subagents unless requested. |
| Multi-file but one tightly coupled implementation | Orchestrator implements; optional reviewer if risky. |
| Tightly coupled security or data-correctness implementation | Orchestrator implements; reviewer required. |
| Independent read-only research, inventory, ranking, or validation slices | Light swarm. |
| Independent low-risk docs or code slices with no overlapping writes | Light swarm by default; full swarm if ownership or integration risk is non-trivial. |
| Broad refactor with independent slices | Full swarm with reviewer required. |
| Multi-slice security/data investigation with separable research or validation tracks | Full swarm with reviewer required. |
| User explicitly asks for subagents/swarm | Light or full swarm based on risk, within concurrency limits. |

If sensitive work is tightly coupled, keep implementation with the orchestrator and use an independent reviewer.

## Workflow Modes

### Direct Execution

Use direct execution for quick, low-risk, tightly scoped work. The orchestrator reads, edits, validates, and reports without spawning subagents.

### Light Swarm

Use light swarm when parallel subagents can accelerate discovery, comparison, ranking, or narrow validation without creating meaningful integration risk.

- Typical shape: 1-3 read-only or notes-only subagents.
- Good fits: codebase inventory, bug-cause research, option ranking, docs review, validation checks, sprite or asset audits, and separable performance investigation.
- Reviewer is optional. Add one only if findings affect security, data correctness, broad architecture, or a risky implementation decision.
- Handover agent is usually skipped. The orchestrator writes the final summary.
- Assignment baseline can be brief: current `HEAD`, current `git status --short`, paths to read, no-edit instruction, expected output, and stop conditions.
- If a light-swarm task discovers that writes are needed, the orchestrator either performs the writes directly or upgrades the task to full swarm before delegating edits.

### Full Swarm

Use full swarm when multiple agents may produce implementation patches, when edits cross ownership boundaries, or when correctness risk justifies explicit review gates.

- Typical shape: scoped workers, a reviewer for non-trivial/risky work, and optionally a handover agent.
- Required for broad refactors, multi-slice security/data work, shared-interface changes, overlapping domains, or any work where subagent edits need integration.
- Assignment baselines, ownership checks, reviewer gates, validation mapping, and commit/push gates are mandatory.
- Actual writes should remain ordered when the target is stateful or externally constrained, even if discovery was parallelized.

## SUBAGENTS ORCHESTRATION GUIDELINE

1. Up to 5 `gpt-5.5` subagents can be active at once, with appropriate effort level (`low`, `medium`, or `high`). `gpt-5.3-codex-spark` xhigh can also be used for quick, well-scoped tasks.
2. Spawn subagents to research, perform, and execute tasks needed throughout the mission.
3. For light swarm, skip standing reviewer and handover roles unless risk appears. Keep assignments short, read-only or notes-only by default, and let the orchestrator synthesize the result.
4. For full swarm, spawn a specialized high-effort reviewer subagent to review other agent tasks, return commit-ready recommendations, and identify in-scope optimization, maintainability, and de-duplication opportunities. The reviewer may commit or directly implement only when explicitly delegated for a specific slice, with owned paths and commit authority stated in the assignment packet.
5. Spawn one medium-effort handover subagent for broad enhancement research and handover-note writing on multi-slice/risky swarm work, broad enhancement work, or when requested. Otherwise the orchestrator writes the final handoff.
6. Reuse or close previous subagent sessions **that you spawned** as needed, except the reviewer or handover agents while their standing roles are still active.
7. Do not close subagent sessions spawned by other agents.

## Standard Role Set

- **Swarm orchestrator (you)**
  - Owns scope, assignment packets, integration, staging, commits, pushes, final checks, and final user handoff unless explicitly delegated.
- **Specialist worker subagents (0-3)**
  - Execute independent code/docs/research slices.
  - Default to patch snippets, findings, and validation notes.
- **High-effort reviewer subagent**
  - Reviews worker output and confirms correctness, risk, and scope boundaries.
  - Defaults to notes-only recommendations.
  - Commits or edits only when explicitly delegated per slice.
  - Required for full swarm when work is non-trivial or risky; optional for light swarm.
- **Medium-effort handover subagent**
  - Produces notes-only broad enhancement research and a final handover note.
  - Does not expand implementation scope unless explicitly assigned.
  - Usually skipped for light swarm.

## Model and Effort Selection

| Effort | Use for |
| --- | --- |
| `low` | Read-only searches, docs checks, narrow verification, simple inventory. |
| `medium` | Contained implementation, focused review, validation slices, handover synthesis. |
| `high` | Security, data correctness, cross-cutting architecture, reviewer role, high-risk merges. |
| `xhigh` quick model | Fast, well-scoped mechanical tasks where speed matters and the output is easy to review. |

If a named model is unavailable, use the closest available model with the same role: highest-reasoning for review/risk, fastest reliable coding model for bounded mechanical edits.

## Spawn and Concurrency Rules

- Keep total active subagents to **five or fewer**.
- Spawn workers in parallel only where outputs are independent.
- Use dedicated reviewer/handover on full-swarm multi-slice work or tasks marked non-trivial/risky.
- For small, single-file, low-risk edits, skip reviewer/handover unless requested.
- Reuse reviewer/handover agents across slices where possible.
- Close unused subagent sessions you spawned as soon as their scope is complete.
- Do not close another agent's subagents.
- Never kill local processes, occupied ports, dev servers, terminals, or CLI sessions unless the user explicitly approves and ownership is confirmed.
- Do not assign overlapping write ownership unless all agents are returning notes/patches only.

An immediate blocking task is the next step that must complete before any other slice can proceed. The orchestrator handles those directly. Examples: repo-state checks, failing setup commands, branch decisions, and shared interface decisions. Independent research, validation, or isolated implementation can be delegated.

## Core Workflow

Use the light workflow unless the activation matrix or discovered risk requires the full workflow.

### Light Swarm Workflow

1. **Scope split**
   - Identify independent read-only, notes-only, or low-risk slices.
   - Keep immediate blockers with the orchestrator.
2. **Brief assignment**
   - Include cwd, current `HEAD`, current `git status --short`, read-only paths, no-edit instruction unless explicitly allowed, expected output, and stop conditions.
3. **Parallel discovery**
   - Spawn only the agents needed for the independent slices.
   - Do not assign overlapping writes. Prefer findings, patch suggestions, or validation notes.
4. **Orchestrator synthesis**
   - Compare outputs, make the implementation decision, and perform any small writes directly unless full swarm is now warranted.
   - If subagent findings imply broader or riskier edits, upgrade to full swarm before delegating implementation.
5. **Handoff**
   - Report what was learned, what changed if anything, validation run, residual risks, and the next practical task boundary.

### Full Swarm Workflow

1. **Scope split**
   - Separate the request into clear tasks with minimal overlap.
   - Identify the files and boundaries each task must touch.
   - Record an assignment baseline before handing off work.
2. **Parallel execution**
   - Spawn one worker per independent task.
   - Include the assignment packet and expected deliverables.
3. **Collect + review**
   - Feed worker outputs to reviewer.
   - Reviewer returns one of: `approve`, `approve-with-fixes`, `request-changes`, or `defer-follow-up`.
   - Reviewer includes risks, file/line references, validation evidence, and scope notes.
4. **Merge-and-optimize pass**
   - Re-run `git status --short` and compare owned paths to the assignment baseline before integrating each worker patch.
   - Stop and ask for direction if another agent changed an owned path since assignment.
   - Apply only approved worker outputs.
   - Treat required correctness fixes separately from optional cleanup.
   - Apply reviewer-suggested optimization/de-duplication only when required for the assigned slice or explicitly approved through a mini-assignment.
   - Put out-of-scope improvements in the handover note.
5. **Handover**
   - Handover agent documents what changed, what remains, and follow-up candidates when a handover agent is spawned.
   - For smaller swarm runs without a handover agent, the orchestrator writes the same note in the final response.

## Assignment Baseline

For light-swarm read-only or notes-only tasks, record a brief baseline:

- Current `HEAD`.
- Current `git status --short`.
- Read-only path list.
- No-edit instruction and stop conditions.

Before assigning a full-swarm worker or reviewer any owned paths, record:

- Current `HEAD`.
- Current `git status --short`.
- Owned path list.
- Read-only path list.
- Existing diffs for owned paths (`git diff -- <paths>`) or an equivalent file/hash snapshot.
- Whether direct edits are allowed.
- Which agent owns the paths and when the assignment started.

Before integrating output, compare current state against this baseline. If owned paths changed unexpectedly, stop and ask for direction.

## Edit Ownership

- Workers are patch/notes-only by default.
- Direct worker edits require:
  - explicit exclusive path ownership
  - clean owned paths or explicitly acknowledged pre-existing diffs
  - no overlapping agents on those paths
  - pre-edit and post-edit `git status --short`
  - final orchestrator review before staging or commit
- The orchestrator owns staging, commits, pushes, and final status checks unless the user explicitly delegates those steps.

## Commit and Push Gates

- Do not commit or push unless the user explicitly asks or approves.
- Before committing:
  - re-run `git status --short`
  - review the staged diff
  - confirm only intentional paths are staged
- Before pushing:
  - confirm current branch and upstream
  - run `git fetch`
  - check divergence from upstream
  - confirm exact target remote and branch
  - ensure unrelated staged, modified, or untracked files are not included

## Destructive Command Gates

Never run destructive or ownership-disrupting commands without explicit approval. This includes:

- `git reset --hard`
- `git checkout --`
- `git restore`
- `git clean`
- `rm -rf`
- `git stash drop` or `git stash clear`
- bulk formatters outside assigned scope
- `kill`, `pkill`, `killall`, or port-killing pipelines

## Assignment Packet Template

Reusable committed artifact templates live in `agents/templates/`:

- `agents/templates/plan.md`
- `agents/templates/research.md`
- `agents/templates/handover.md`

```text
Goal:
Scope:
  cwd:
  owned paths:
  read-only paths:
  current HEAD:
  current git status summary:
  owned-path baseline:
Non-goals:
Direct edits allowed: yes/no
Expected output:
Validation required:
Stop conditions:
Effort/model:
Return format:
```

Example:

```text
Goal: Review adapter token normalization and identify correctness risks.
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths: none
  read-only paths: claudeville/adapters/*.js, claudeville/src/domain/entities/Agent.js
  current HEAD: <sha>
  current git status summary: AGENTS.md modified; docs SOP untracked; app files untouched by this assignment
  owned-path baseline: none, read-only task
Non-goals: Do not edit files, do not stage, do not commit.
Direct edits allowed: no
Expected output: Findings with file/line references and risk severity.
Validation required: None unless a finding depends on a command result.
Stop conditions: Stop if requested files change during review or required files are missing.
Effort/model: gpt-5.5 medium
Return format: Reviewer Output template
```

## Output Templates

### Worker Output

```text
Files touched or patch paths:
Why this changed:
Patch/applicability notes:
Validation run:
Assumptions:
Conflict risk:
What is not done:
Suggested next step:
```

### Reviewer Output

```text
Verdict: approve | approve-with-fixes | request-changes | defer-follow-up
Blockers:
Required fixes:
File/line references:
Validation evidence:
Scope notes:
Risk severity:
Integration recommendation:
```

`approve-with-fixes` means integrate only after listed fixes are applied and rechecked.

### Final Handover

```text
Landed changes:
Validation performed:
Validation skipped and why:
Residual risks:
Follow-up opportunities ranked by effort vs reward:
Recommended next task boundary:
```

## Reviewer Gates

- `approve`: safe to integrate as-is.
- `approve-with-fixes`: safe only after specific small fixes are applied and rechecked.
- `request-changes`: do not integrate until blockers are resolved.
- `defer-follow-up`: valid improvement, but outside current task scope.

The orchestrator should not integrate `request-changes` output without resolving the blocker or explicitly documenting why it is being deferred.

## Decision Rules

- Preserve unrelated edits in a shared checkout.
- Keep changes minimal and file-scoped to the assigned task.
- Enhancement research is notes-only unless the user requested implementation.
- Cleanup/de-duplication may be implemented only when required for the assigned slice or explicitly approved.
- For docs-only process updates, use a brief diff review and `git status --short` confirmation.

## Process Checkpoints

- Before edits: `git status --short`.
- Before assigning owned paths: record the assignment baseline.
- Before integrating each worker output: re-run `git status --short` and inspect owned-path diffs against the baseline.
- Before commits: scope-only staged diff review.
- After merge decisions: run relevant validation from `AGENTS.md` and record skipped checks with reasons.
- Before final handoff: final `git status --short`.

## Validation Mapping

- Server or adapter edits: use the syntax checklist in `AGENTS.md`.
- API, runtime, or rendering behavior changes: use runtime and visual checks in `AGENTS.md`.
- Process/docs changes (`AGENTS.md`, `claudeville/CLAUDE.md`, `README.md`, `docs/*.md`): diff review plus `git status --short`.
- Visible docs or locale-sensitive copy changes in `README.md` or `claudeville/CLAUDE.md`: also run the Hangul scan listed in `claudeville/CLAUDE.md`.

## Skills and Docs to Reuse

- Reuse existing project docs (`AGENTS.md`, `claudeville/CLAUDE.md`) as canonical context.
- Root `AGENTS.md` is the workflow and git-hygiene authority; `claudeville/CLAUDE.md` is the area-specific implementation and validation context.
- Use local skills and process docs when they directly match the task.
- Use this SOP for repeatable swarm execution across future feature, refactor, and review tasks.
