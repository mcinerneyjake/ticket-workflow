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
  the session. Wire `guard-ticket` only if you want that policy — the other two
  suit any consumer.
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

## Consuming it in a repo

Add the dependency (public, pinned by tag):

```jsonc
// package.json
"devDependencies": { "ticket-workflow": "git+https://github.com/mcinerneyjake/ticket-workflow.git#v0.4.0" }
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
