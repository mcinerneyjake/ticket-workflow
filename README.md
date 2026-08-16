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
  (default 15, `0` to always report). Also a `PreToolUse` guard
  (`guard-review-target.mjs`) that refuses a `/code-review` with no explicit
  target when the session's own repository has no diff to review, because a
  wrong-repo review reads exactly like a clean one. Wire `guard-ticket` only if
  you want that policy — the others suit any consumer.
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
"devDependencies": { "ticket-workflow": "git+https://github.com/mcinerneyjake/ticket-workflow.git#v0.11.0" }
```

Wire the MCP server (`.mcp.json`) and the hooks + allowlist (`.claude/settings.json`);
see a consuming repo's config for the exact shape. Run `npx ticket-workflow show <id>`
to view a ticket's pipeline.

### Wiring the hooks from an install

Each hook is available both as a script path and as a subpath import, so a consumer can wire the
installed copy instead of vendoring one that then drifts:

```jsonc
// .claude/settings.json — run the installed file directly
"command": "node node_modules/ticket-workflow/hooks/guard-bash.mjs"
```

```js
// or import it, to set consumer-specific policy before handing over
import { main } from 'ticket-workflow/hooks/guard-bash.mjs';
main();
```

> **Both forms above are fail-open if the install is absent or stale**, and neither is what you want
> for a guard you rely on. `node <path-that-does-not-exist>` exits 1, and only exit **2** blocks — so
> a missing `node_modules` reads as *allow*. The bare `main()` call has the same hole: if the package
> resolves but exports no callable `main`, the throw exits 1, again an allow. Wrap both, as
> [Installing it once per machine](#installing-it-once-per-machine-user-scope) does.

The exported subpaths are exactly the five hook files above. Importing a hook does **not** run it;
`main()` reads the payload from stdin and ends in `process.exit()`, so it is one hook per process —
which is how Claude Code invokes them anyway (one process per matcher).

### Installing it once per machine (user scope)

The hooks and MCP server can govern *every* repo on a machine by wiring them at user scope
(`~/.claude/settings.json`, `~/.claude.json`) instead of per repo. Install to a stable location —
**not** a working checkout, and not `npm i -g` (`npm root -g` is Node-version-scoped, so the next
upgrade silently relocates it):

```bash
npm install --prefix ~/.claude/tools ticket-workflow@github:<owner>/ticket-workflow#<tag>
```

Wiring a checkout is the trap worth naming: hooks are re-read on **every** invocation, so checking
out a branch that edits `guard-bash.mjs` re-arms or dis-arms the machine's guard for every running
session, mid-edit — and `dist/` becomes the MCP server that every newly started session loads.

**Do not point the wiring straight at the installed file either** — same reason as above: a missing
file exits 1, which reads as *allow*. Wire a small launcher that converts "cannot load" into the
right answer for the event.

**Where the launcher lives is load-bearing, and the two constraints pull in opposite directions:**

- **outside `node_modules`** — its whole job is to still exist when the install does not;
- **but still under the install prefix** (`~/.claude/tools/hooks/`, not `~/.claude/hooks/`), because
  `import('ticket-workflow/…')` is a *bare specifier*, resolved by walking up from the launcher's own
  directory. Put it beside `settings.json` instead and it throws `ERR_MODULE_NOT_FOUND` **with the
  install fully present** — which, failing closed, wedges every Bash call on the machine.

```js
// ~/.claude/tools/hooks/run-hook.mjs <hook-name> <closed|open>
const [name, direction] = process.argv.slice(2);

// Validate up front. `direction === 'closed' ? 2 : 0` would make a one-character typo in
// settings.json silently disarm the guard, so an unusable direction blocks.
if (!name || (direction !== 'closed' && direction !== 'open')) {
  process.stderr.write('[run-hook] BLOCKED: usage: run-hook.mjs <hook-name> <closed|open>\n');
  process.exit(2);
}

try {
  const { main } = await import(`ticket-workflow/hooks/${name}.mjs`);
  if (typeof main !== 'function') throw new TypeError('no callable main — stale install?');
  await main();
} catch (err) {
  process.stderr.write(`[${name}] could not run: ${err?.message ?? err?.code ?? 'import failed'}\n`);
  process.exit(direction === 'closed' ? 2 : 1);
}

// Every hook here ends in process.exit(); returning instead is a contract violation (a stale pin),
// and falling off the end exits 0 — an allow. Guards must not resolve that permissively.
if (direction === 'closed') process.exit(2);
```

Fail direction is per event. A guard that cannot run must block; a reporter that cannot run has
nothing to block and must not wedge the session — but note it exits **1, not 0**:

| hook | event | cannot **load** → |
|---|---|---|
| `guard-bash` | `PreToolUse` | **closed** (exit 2) |
| `guard-ticket` | `PreToolUse` | **closed** (exit 2) |
| `guard-review-target` | `UserPromptExpansion` | **closed** (exit 2) |
| `warn-stale-worktree` | `SessionStart` | open (exit 1) |
| `track-steps` | `PostToolUse` | open (exit 1) |

**Why 1 and not 0.** Exit 0 is *success*, and its stderr is not surfaced; a non-zero, non-2 exit is a
non-blocking *error*, and its stderr **is**. Exiting 0 would therefore make a dead reporter quieter
than no launcher at all — an unlaunched broken hook exits 1 and is at least visible. 1 keeps it
non-blocking and visible.

Two honest limits on that table:

- It describes what happens when a hook cannot **load**. It is not a claim about each hook's internal
  behaviour: `guard-bash`, once loaded, deliberately exits 0 on a payload it cannot parse, and only
  its unresolvable-branch rule fails closed. `guard-ticket` and `guard-review-target` do fail closed
  internally.
- The `open` rows are a genuine gap. Nothing here detects a reporter that stopped recording; the
  stderr is visible only if someone is looking. Treat "are my hooks actually running?" as a question
  needing its own check.

**Wiring at user scope does not replace project scope — the two are additive.** Duplicate *guards*
are harmless (they decide identically), but a duplicate **writer** is not: two `track-steps` hooks
append to the same `events/<id>.jsonl` and double-log every milestone. If you wire `track-steps` at
user scope, remove any per-repo `PostToolUse` copy.

**Verify by removing things, not by reading the config** — and remove *both*, because they fail
differently:

1. Move the development checkout's `hooks/` and `dist/` aside. The guards must still block, still
   allow on a feature branch, and the MCP server must still answer. Anything that changes means the
   machine was still depending on that tree.
2. Move the **install** aside. Each `closed` row must exit 2 and each `open` row exit 1. This is the
   only step that exercises the launcher's reason to exist — with the install present, a mistyped
   fail direction is never even read, so step 1 alone would pass with the guard disarmed.

## `doctor` — checking that the wiring above is actually live

Everything in the two sections above lives in machine-local, unversioned files. No repository's test
suite can see them, so nothing detects that a hook drifted, that an install half-upgraded, or that
the telemetry writer stopped recording. `doctor` reads that wiring and reports on it:

```bash
npx ticket-workflow doctor            # from any repo
npx ticket-workflow doctor --strict   # UNKNOWN counts as failure (for a gate)
npx ticket-workflow doctor --no-mcp   # skip starting the MCP server
```

| check | what it answers |
|---|---|
| `writer-uniqueness` | how many `PostToolUse` telemetry writers are wired — two double-log every milestone |
| `hook-wiring` | does any **vendored** hook copy differ from the one this package ships |
| `pin` | is more than one version of this package live at once |
| `mcp` | does the configured server start and answer `initialize`, at what version |
| `board` | do the MCP server and the telemetry writer point at the **same** board |
| `protected-branch` | which branches `guard-bash` will actually protect *here* |
| `reporter-liveness` | when did the hook last write a step only it can write |
| `toolchain` | which of this repo's gate steps can be recorded at all |

**Every check returns OK / MISMATCH / UNKNOWN, never a boolean.** UNKNOWN is the point: on a machine
with no `~/.claude` — CI, a container, a fresh clone — the user-scope checks are genuinely
unanswerable, and reporting that as OK is the fail-open shape this package exists to reject. The
exit code is 0 unless a check MISMATCHes; `--strict` also fails on UNKNOWN, which is what a gate wants.

Two things it deliberately does **not** claim. It cannot see a *running* MCP server — a session's
server is not observable from another process — so it answers the weaker, checkable question of
whether a new session's server would start. And a `hook-wiring` OK means the wired files match what
this package ships, not that the guards are correct; that is what their own suites are for.

## Development

```bash
npm install      # runs the prepare build
npm run typecheck
npm test
npm run build    # emit dist/
```
