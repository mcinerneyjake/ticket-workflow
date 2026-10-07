# Spec: workflow rewrite

Status: proposed; accepted when this file merges · Epic: `tkt-d841316d04f7` · Owner repo: `ticket-workflow`

## Problem

The workflow this package supports grew one well-justified incident at a time, and the cost is now
the workflow itself. A hardpack session loads 99,709 bytes (~25k tokens) of always-on instructions
before it reads a ticket — 743 lines of repo `CLAUDE.md`, 87 of parent-directory `CLAUDE.md`, 236 of
global `CLAUDE.md` and a 159-line memory index — plus a 1039-line workflow skill on invocation
(`wc -lc`, recorded on the epic). Many of those rules state that nothing enforces them. A title-based
estimate, not yet a measurement, puts ~90% of hardpack's backlog at the system maintaining itself.

The pipeline is strong at the back (guards, gates, review, resume) and missing the front: nothing
makes the human's intent explicit before work starts, a multi-ticket feature has no destination
document, and tickets are cut from one-line reports rather than from a design.

## Goal

**Legibility first, throughput second.** A fresh session, or a hiring manager, understands the
system in five minutes; tickets ship faster as a consequence of a smaller, sharper context.

Measured against the baseline recorded on the epic (always-loaded size, merged PRs/week; round-trips
per ticket, review findings per ticket and the infra share of the backlog once a probe exists).

## Sources

The primary source is the `mattpocock/skills` repository (MIT), read at its 2026-09-29 state:
its skill files and commit history. The talk "Full Walkthrough: Workflow for AI Coding" (AI Engineer
Europe 2026) framed the work, but its transcript could not be obtained; what is known of it comes
from secondary summaries, so nothing here rests on the talk alone. Terms follow the repository:
"spec" not "PRD", red→green with no refactor step, review by two fresh-context axes.

## The workflow

| Phase | What happens | Human gate |
|---|---|---|
| 1. Grill | The agent interviews the human one question at a time, each with a recommended answer; facts are found by sub-agents, decisions are the human's. Updates the repo's `GLOSSARY.md`. | Confirm shared understanding |
| 2. Spec | Synthesized from the grill, never a second interview. Lives in the repo owning the interface, merged to `main` before slicing. | Merge of the spec PR |
| 3. Slice | Vertical tracer-bullet tickets with blocking edges, agreed test seams and a HITL/AFK label each. | Approve slicing, seams, labels |
| 4. Implement | One ticket per session, in a worktree, red→green at the agreed seams only. | none |
| 5. Review | Two fresh-context sub-agents: standards and spec adherence. The skill fixes findings, commits and opens the PR; the ticket enters `qa` at PR-open. | none |
| 6. Merge | After the human QA's the running change. | Merge, in every mode |

The human sits at the two ends: **what to build** (gated three times: understanding, spec, slicing)
and **what lands on `main`**. Commit
and PR-open are cheap to reverse, so they are no longer gates. Review is no longer a gate either,
because the skill runs it unconditionally; it was a gate only because it could be skipped.

## Decisions

### Where things live

- **Specs** live in the repo that owns the interface being changed, as a spec file under
  `docs/specs/`. A cross-repo feature's spec goes to the repo whose interface it changes (usually this
  package). Git history replaces append-only body conventions: specs are edited normally.
- **The board** holds a spec ticket that links to the file; slices are its children. A spec ticket
  is any ticket whose `spec` field is set, as `owner/repo:path/to/spec.md`; there is no `spec` type,
  so the marker and the link cannot disagree. A **local probe**, `ticket-workflow specs` (not a CI
  audit check — CI has no board), fails when an open spec ticket's link does not resolve on the
  owning repo's default branch, and exits as "could not check" rather than clean when the board, the
  repo or a ticket's `spec` value is unreadable.
- **A finished spec is deleted, never archived.** When its spec ticket is `done`, the file is removed
  from the default branch and indexed in that repo's `docs/specs/README.md` by a permalink
  (`https://github.com/<owner>/<repo>/blob/<sha>/<path>`) to the last commit that held it. There is no
  archive folder: an in-tree archive is still read as current. The probe checks both halves — the file
  is gone, and the permalink resolves — but never writes the index. An `archived` spec ticket is
  retired, not finished, and owes no index entry.
- **Skills ship in this package.** `init` installs them into a consumer's `.claude/skills/`, pinned
  by the package tag; `audit` reports missing or drifted copies.

### Skills

- **Vendored** from `mattpocock/skills` at a pinned commit, each copy carrying the MIT copyright and
  permission notice: `grilling`, `tdd`, `standards-and-spec-review`, `handoff`, `codebase-design`.
  These are tracker-agnostic judgment; rewriting them would be imitation.
  `standards-and-spec-review` is upstream's `code-review`, renamed so it cannot shadow Claude Code's
  built-in `/code-review`, which consumer review gates run. `templates/skills/UPSTREAM.json` records
  the rename.
- **Our own**, because they bind to the board, the guards and the night run: `to-tickets`,
  `implement`, the night-run loop, `retro`.
- **Size**: every `SKILL.md` ≤ 120 lines, audited; overflow goes to sibling reference files loaded
  on demand.

### Ticket authorship

- **Planned work**: the session that grilled the human slices the spec and creates the tickets.
  `guard-ticket` narrows to admit a Claude create only when its `parent` is an **open** spec ticket:
  non-null `spec`, status neither `done` nor `archived`, read through the package's `getTicket`.
  Anything it cannot read or judge blocks. It does not check that the spec link resolves; the
  spec-link probe owns that, and a network call in a PreToolUse hook would turn an offline machine
  into blocked creates. The spec ticket itself is filed through local intake. A `parent` is
  self-asserted, so this narrows the tool rather than proving a grill happened.
- **Ad-hoc reports** ("X is broken") stay with the local intake agent: classification is what a
  local model does well.

### Slices

- Each slice cuts a narrow, complete path through every layer and fits one fresh context window.
- Each names its **test seams**; the human approves them with the slicing. No test is written at an
  unagreed seam.
- Each carries a validated **HITL/AFK field**, `autonomy: hitl | afk`. A write naming any other value
  is rejected; a missing or invalid value already on disk reads as HITL: the fail-closed direction,
  since AFK admits unattended work.

### Implementation

- Red→green at the agreed seams. Refactoring belongs to review.
- **Interactive**: one ticket per session, `/clear` between tickets.
- **Unattended**: the night run becomes a deterministic loop over the DAG's AFK frontier, running
  unblocked slices in parallel, each a headless session in its own worktree ending in its own PR.
  Concurrency is capped by test slots. No in-harness orchestrator, no integration branch: one PR per
  slice keeps merges small and lets one bad slice fail alone.

### Review

Two sub-agents in fresh contexts, run in parallel, findings never merged or reranked:

- **Standards**: the Fowler smell baseline as labelled heuristics, the review-phase tenets, and the
  diff's **authorizing line**, named but never edited.
- **Spec adherence**: every agreed seam has a test; the diff does what its slice and spec say.

After the findings are fixed, the main thread runs the **mutation check** on that line: flip it,
confirm the suite goes red, revert. Not the reviewer, because both reviewers share one working tree
and a flip would show the other a mutated diff (`tkt-0dbbd0bc6151`).

### Guards

- **Enforce, else load by phase, else delete.** A rule that can be a hook, test or audit check
  becomes one and its prose goes; a rule a phase genuinely needs moves into that phase's skill;
  everything else is deleted.
- **`guard-worktree` becomes stateless.** The primary checkout is read-only for every agent, armed or
  not, with one exception: `git pull --ff-only origin main` on a clean `main`, keeping today's
  conditions on it — `HEAD` an ancestor of upstream, and no untracked or ignored path colliding with
  the update. Arming, the post-merge state and its sticky flags are removed; no phase of the new
  workflow writes the primary. Cases this rule does not yet serve are listed under Open questions.
- **`guard-subagent-gates` must change.** Its rule names commit, push and PR-open as human gates,
  which this spec abolishes; it would block the review and fix steps when they run as sub-agents.
  It narrows to merge.
- `guard-bash`, `guard-board-writes`, `guard-review-target` and `warn-stale-worktree` stay as they
  are. hardpack's local `guard-unattended-merge` stays; it refuses backgrounded Bash during a night
  run, so the parallel loop lives in the deterministic runner, outside any Claude session.

### Keeping it small

- **Every `CLAUDE.md` ≤ 60 lines**, repo and global. The repo file is an `audit` check that ships
  `advisory: true` and becomes gating per repo once that repo's file is cut: a gating check would
  redden every consumer's required gate the day it lands. The global file lives in no repo, so CI
  cannot see it; it is checked locally (`doctor`), and that check is per-machine, not CI-enforced.
- **Engineering tenets are split by phase**: adversary list and premise validation in grilling and
  slicing; instrument proof and verify-the-effect in implement; can-it-fail in review.
- **Memory** holds only user, feedback and project facts, ≤ 40 index entries. Reference gotchas move
  to the phase skill's reference files where they bite, or become checks.
- **`/retro`** routes every lesson to `check`, `skill`, `memory` or `drop`. The `instruction` verb is
  removed: it was the pipe that filled `CLAUDE.md`.
- **`GLOSSARY.md`** per repo, owned by grilling, loaded on demand by spec and review, line-capped by
  `audit`.

## Interfaces that change

| Surface | Change |
|---|---|
| Ticket schema | `autonomy: hitl \| afk`, validated, defaulting to HITL; a nullable `spec: owner/repo:path` field that marks a spec ticket and carries its link |
| `guard-ticket` | Admits a create whose parent is an open spec ticket |
| `guard-worktree` | Stateless rule above |
| `guard-subagent-gates` | Narrows to merge |
| `audit` | Repo `CLAUDE.md` line cap, skill line cap, glossary cap, skills present and current |
| `doctor` / probes | Global `CLAUDE.md` cap; `specs`: open spec links resolve, finished specs deleted and indexed |
| `init` | Installs the skills and a `GLOSSARY.md` stub |
| Night run | Parallel frontier loop over AFK slices, capped by test slots |

## Rollout

A strangler: the current workflow stays fully in force until the new one has run once.

0. **Baseline** captured on the epic before any change.
1. **Build** the rewrite with the *current* workflow: this spec through a PR, slices filed through
   the local intake agent, current gates.
2. **Pilot** one real feature through the new workflow: hardpack's ticket comments
   (`tkt-c5360d109929`). Chosen because it crosses UI, API and storage entirely inside hardpack, and
   its first slice blocks two that can then run in parallel. Its grill must settle whether live
   refresh is in scope and whether the board's file watcher tolerates a non-`.md` sidecar. Whatever
   the pilot breaks is fixed before step 3.
3. **Cut**: docs to the cap, the stateless guard, the cap from advisory to gating per repo.
4. **Roll out** to the other consumers one pin bump at a time.
5. **Rewrite the case study** around the new workflow, with an evolution section on before/after
   numbers.

Until the epic is done, no other agent coding work is started or resumed. Non-coding tickets are
unaffected.

## Out of scope

- A cloud implement/review model split: the review's value is the fresh context, not the model tier.
- Container sandboxes per slice: worktrees plus guards remain the isolation model.
- Auto-merge in any mode.

## Open questions

- A spec parent is self-asserted and promotable: `update_ticket` can set `spec` on any open ticket,
  so one call turns any ticket into a parent that admits creates. `guard-ticket` also judges the
  parent from its own process and board resolution, not the MCP server's, so check and write can
  disagree. Whether the check moves server-side, and who may set `spec`, is undecided.
- Cases the stateless `guard-worktree` blocks today's workflow from: repos with no `origin` (the
  exception cannot apply), unticketed meta and docs sessions working in a primary, and `npm ci` in a
  primary after a pin bump so its MCP server loads the new build.
- Parallel slices share a `node_modules` linked to the primary, so a slice that changes a dependency
  cannot run in parallel; and a repo allowing one test-infra ticket in flight caps the frontier.
- How round-trips per ticket, review findings per ticket and the backlog's infra share are measured,
  before the pilot starts.
