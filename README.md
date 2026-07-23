# ticket-workflow

A local-first, **per-repo** ticket board and git/PR pipeline, packaged so any repo
can adopt it by adding a dependency plus a little config — with **no coupling** to
any other repo. Each consuming repo owns its own `tickets/` and `events/`.

It ships three pieces:

- **MCP server** (`ticket-workflow-mcp`) — `list_tickets`, `get_ticket`,
  `start_ticket`, `create_ticket`, `update_ticket`, `record_review`,
  `delete_ticket`. Tickets are markdown files (frontmatter + body); the board is
  the filesystem, no database.
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

## Consuming it in a repo

Add the dependency (public, pinned by tag):

```jsonc
// package.json
"devDependencies": { "ticket-workflow": "git+https://github.com/mcinerneyjake/ticket-workflow.git#v0.1.0" }
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
