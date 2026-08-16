# Project workflow

This repo follows the ticket-workflow standard. `npx ticket-workflow audit .` is the machine-checkable
definition of that standard; this file is a pointer to it, not a second copy.

## Ticket workflow

Work is tracked on the kanban board (MCP tools: `list_tickets`, `get_ticket`, `start_ticket`,
`update_ticket`). A ticket's status must reflect where the work actually is, while it is there:

- **Before the first edit** — `start_ticket <id>` (sets `in-progress` and returns the body).
- **At PR-open** — `update_ticket status: qa`. This is the single point a ticket enters `qa`.
- **After the PR merges** — `update_ticket status: done`. Not before.
- **Stopping mid-ticket** — move it back (`todo` if untouched, else leave `in-progress` with a note).

For feature and bug tickets, add a `## Done when` acceptance list to the ticket body (via
`appendBody`, never a full-body overwrite) before implementing. Append an `## Implementation summary`
when done, including a `Tests:` line and a `Risk:` line (blast radius + rollback).

## Quality gate

`npm run typecheck`, `npm run lint`, and `npm test` must all pass before a ticket can be marked done.
CI runs the same gate (job `gate`) on every PR; it must be green before merge.

## Branch, commit & PR workflow

Every ticket lands on its own branch and merges to `main` via a **squash-merged PR** — never a direct
push to `main`. Three human-approval gates: **"Ready to commit?"**, **"Ready to open PR?"**,
**"Ready to merge?"**. Never cross a gate without explicit confirmation.

1. **Branch** — cut from an up-to-date `main`: `git switch -c <prefix>/<id>-<slug>` where `<prefix>`
   maps the ticket type (`bug→fix`, `feature→feat`, `task→task`, `chore→chore`), `<id>` is the full
   ticket id, and `<slug>` is the kebab-cased title (~4–5 words).
2. **Commit** — stage only the files changed for this ticket (never `git add -A`; the guard-bash hook
   blocks it). Commit as many times as the work needs; the squash-merge collapses the branch to one
   commit on `main`.
3. **PR** — push the branch, open the PR with the ticket id and the `## Implementation summary` in
   the body, then set the ticket to `qa`.
4. **Merge** — after CI is green and with explicit approval: `gh pr merge --squash --delete-branch`,
   then set the ticket to `done`.

## Testing

Every feature or bug-fix ticket adds tests for each logic layer it touches: the happy path, edge
cases, and rejection cases. Bug fixes write the failing reproduction first and watch it go red before
the fix. Skip tests only when the change is pure UI or docs, and say so in the implementation
summary.

## TypeScript conventions (lint-enforced)

- No type casting (`as Foo`) — use type predicates or fix the upstream type. `as const` stays allowed.
- No non-null assertions (`foo!`) — restructure so TypeScript can narrow.
- No `any` in your own types — define concrete interfaces at external boundaries.

## Comment philosophy

Comments are sparse and earn their place: only a non-obvious *why* — an invariant, a
security/concurrency decision, a gotcha. Never restate what the code says. Directives
(eslint/ts/coverage pragmas) are exempt.
