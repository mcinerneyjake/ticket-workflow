# ticket-workflow

A local-first, **per-repo** ticket board and git/PR pipeline, packaged so any repo
can adopt it by adding a dependency plus a little config — with **no coupling** to
any other repo. Each consuming repo owns its own `tickets/` and `events/`.

It ships three pieces:

- **MCP server** (`ticket-workflow-mcp`) — `list_tickets`, `get_ticket`,
  `start_ticket`, `create_ticket`, `update_ticket`, `record_review`,
  `archive_ticket`, `delete_ticket`. Tickets are markdown files (frontmatter +
  body); the board is the filesystem, no database.

  Archiving is its own tool rather than an `update_ticket` status: `archived` is
  deliberately absent from that tool's status enum, so a ticket can't be retired
  by mistyping a field on an ordinary edit, and the tool stays out of any
  name-allowlisted agent toolset. It is reversible — `update_ticket` back to
  `backlog`, and `list_tickets` with `status: "archived"` to find it again.
- **Hooks** (`hooks/`) — a `PreToolUse` **guard** (`guard-bash.mjs`) that blocks
  whole-tree staging and commits/pushes to `main`; a `PostToolUse` **tracker**
  (`track-steps.mjs`) that records pipeline milestones (branch, typecheck, lint,
  test, commit, PR) by watching the commands you run; and an opt-in `PreToolUse`
  guard (`guard-ticket.mjs`) that blocks `create_ticket` so new tickets are
  authored by a metered local-LLM intake agent instead of by the model driving
  the session; and a `SessionStart` **staleness warning**
  (`warn-stale-worktree.mjs`) that reports when the session opened in a git
  worktree whose `CLAUDE.md` / `AGENTS.md` / `.cursorrules` has since changed on
  the base branch — a stale instruction file does not fail, it *instructs*. It
  only writes to stdout, never blocks, and stays silent outside a linked
  worktree; set `WORKTREE_STALE_THRESHOLD` to tune the commit-distance fallback
  (default 15, `0` to always report). Wire `guard-ticket` only if you want that
  policy — the others suit any consumer.
- **CLI viewer** (`ticket-workflow`) — `list` and `show <id>`, rendering a
  ticket's pipeline from the same reducer the web board uses.

The pipeline a ticket flows through:
**Started · Branch · Typecheck · Lint · Tests · Review · Commit · PR · QA · Done.**

## Board location

The board root is resolved at runtime as
`BOARD_DIR_OVERRIDE ?? CLAUDE_PROJECT_DIR ?? process.cwd()`, then `tickets/` and
`events/` under it. Claude Code sets `CLAUDE_PROJECT_DIR` for both the MCP server
and the hooks, so both write to the same per-repo board. `TICKETS_DIR_OVERRIDE`
and `EVENTS_DIR_OVERRIDE` take precedence (used by tests).

## Backup-on-write / recovery

`tickets/` is the source of truth and has no built-in history (consumers typically
gitignore it), so before `updateTicket` overwrites a ticket **body** the prior full
file — frontmatter + body — is snapshotted to:

```
<board>/tickets/.history/<id>/<ISO-timestamp>.md
```

Only body-changing updates snapshot; a structured-only edit (status, priority, …)
writes nothing to `.history/`. Successive edits accumulate one snapshot per prior
version, and `list_tickets` ignores `.history/`, so snapshots never surface on the
board.

**Recovery is manual — there is no restore UI.** To roll a body back, read the
relevant `.history/<id>/<timestamp>.md` and copy its body into the live ticket (e.g.
via `update_ticket`). Snapshotting is best-effort: a failure is logged but never
blocks the edit, so a write can still land without a backup.

## Corrupt ticket files

A ticket file whose frontmatter won't parse is **skipped**, not fatal — one
hand-edited file must never take the whole board down. But the skip is reported to
the caller, never only to stderr: `listBoard()` returns
`{ tickets, unreadable: [{ file, reason }] }`, and `list_tickets` carries the same
`unreadable` array in its envelope plus a `note` naming the files. `listTickets()`
is the tickets-only shorthand for callers that don't need the report.

This matters because the failure is otherwise invisible: a shorter list looks
exactly like a complete one. `unreadable` is board-wide and is **not** run through
the `status`/`project`/`query` filters — a file that won't parse has no fields to
filter on, so no filter may hide it. The usual cause is a hand-edited unquoted
`title:` containing a colon.

## Corrupt event lines

The same rule applies to the JSONL telemetry, for the same reason: a line that
won't parse is skipped rather than fatal, and a shorter pipeline looks exactly like
a ticket with fewer milestones. So `readEvents()` returns
`{ events, skipped, unrecognized }`, and `getTicketEvents()` — the payload behind
`GET /api/tickets/:id/events` and the `get_ticket_events` tool — carries both counts
beside the pipeline it reduced.

**The two counts mean different things, and only one is a problem:**

| field | meaning | act on it? |
|---|---|---|
| `skipped` | structurally unreadable — bad JSON, missing or wrong-typed required keys. History is **lost**. | yes |
| `unrecognized` | well-formed, but names a `step`/`state` this reader's version doesn't know. **Version skew, not damage.** | bump the pin |

They are separate because the `track-steps` hook is installed **once per machine**
while readers are pinned **per repo**. A newer hook writing a step id added after a
consumer's pin is routine; folding that into `skipped` would report every healthy
log as damaged for as long as the pin lagged.

Neither count is logged to stderr — this path is polled (a board re-reads it every
few seconds while a ticket is on screen), so reporting is left to the caller that
decides to surface it.

One deliberate exemption: a non-empty **final** line that won't parse is *not*
counted. `appendEvent` terminates every complete record with `\n`, so an
unterminated tail is a write in flight, and counting it would flap between polls.
Once any later event lands it is no longer last, and it is counted from then on.

> **Breaking in 0.10.0:** `readEvents()` previously returned `TicketEvent[]`. It now
> returns `{ events, skipped, unrecognized }`, and `TicketEventsResponse` gained both
> counts as **required** fields — optional ones would let a consumer default them with
> `?? 0` and report a damaged log as healthy.

## Unassigned tickets

A ticket with no `project` is absent from every project-filtered view, so a work
queue that selects with `list_tickets({ project })` can never pick it — it is not
mislabelled, it is out of the queue. `list_tickets` therefore reports
`unassigned: [id, …]` in its envelope, plus a `note` naming the ids.

Like `unreadable`, it is board-wide and **not** narrowed by your filters — a
`project` filter would exclude the very tickets being reported, which is the bug
itself.

It covers **open** tickets only. `done` and `archived` are past selection, so an
unassigned one there is not lost work, and at least one such ticket is deliberately
project-less because it spans several repos. A field that flagged those on every
call is a field nobody reads by the second week.

Two more bounds, for the same reason:

- **Empty when the board uses no projects at all.** `project` is optional, and a
  single-repo board has nothing to partition — every ticket would be reported, on
  every call, with nothing wrong.
- **Capped at 20 ids**, with the true total in `note`. A truncated list must never
  read as the whole story.

A project of *whitespace* counts as unassigned: it is stored verbatim while a
caller's blank filter is normalized to "no filter", so no filter value can ever
match it — strictly worse than an absent project, and invisible without this.

Dropping an unresolvable project on the agent write path is deliberate (the intake
model hallucinates project names, and projects are *derived* from ticket values, so
a name that matches nothing is dropped rather than minted). This field is what
reconciles the result afterwards, so the drop does not depend on someone reading a
warning that has scrolled past.

## Consuming it in a repo

Add the dependency (public, pinned by tag):

```jsonc
// package.json
"devDependencies": { "ticket-workflow": "git+https://github.com/mcinerneyjake/ticket-workflow.git#v0.8.0" }
```

Wire the MCP server (`.mcp.json`) and the hooks + allowlist (`.claude/settings.json`);
see a consuming repo's config for the exact shape. Run `npx ticket-workflow show <id>`
to view a ticket's pipeline.

## Development

```bash
npm install      # runs the prepare build
npm run typecheck
npm test
npm run build    # emit dist/
```
