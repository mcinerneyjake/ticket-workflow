# ticket-workflow

This repo follows its own guardrail standard. `node dist/cli/index.js audit .` (after a build) is the
machine-checkable definition; this file is a pointer to it, not a second copy.

## What this package is

The canonical ticket engine: MCP server, guard/telemetry hooks, pipeline CLI (`list`, `show`,
`doctor`, `verify`, `audit`, `init`), the guardrail template set, and the audit that checks any repo
against the standard. Consumers (kanban first) pin it by **git tag**, never a branch — a fix here
reaches them only through a tag cut plus their own pin bump.

## Public and user-agnostic — hard rule

This is a public repo. **Never commit a local identifier**: no home-directory path naming a real
account, no machine-local board paths, no private hostnames.

**Enforced in the gate, not by a grep you have to remember.** `src/repoHygiene.test.ts` scans the
**index** — the snapshot that will actually commit — for `~user/`, `/Users/user` and `/home/user`,
failing unless the owner is an obvious placeholder (`someuser`, `x`, `runner`, …). The consequence
to know when running it locally: **an unstaged edit is not scanned.** `git add` first, or the run
reports on a file you have already changed. `src/templates.test.ts` holds template contents to the
same standard separately.

This replaced a hand-run `git grep` with a hardcoded exclusion list, which rotted the worst way: the
list went stale, so it reported a hit on **every clean run** while the identifier that was actually
committed — a real account name in a `~user/` path — sat in a shape it never matched. A check that
always fires is a check people stop reading (`tkt-3a91af2aa6d9`).

**What it cannot catch.** Three gaps, all deliberate and all measured:

1. **A bare tilde account with no path after it** — `cd ~user` is invisible, because `~word` is
   ordinary prose (`~two hours`, `~40 lines`) and matching it would fire on documentation forever.
   Only the `~user/` form is caught. A test pins this so it cannot later be mistaken for coverage.
2. **Anything that is not a path shape.** A probe cannot name the identifiers it hunts without
   committing them, so a bare first name in fixture data is invisible to it.
3. **Another repo's on-disk directory named in a comment**, unless it sits under a home path.

Gaps 2 and 3 were both found by hand in the same pass and stay convention plus review: give fixtures
placeholder names, and describe another repo by what it is, never by where it sits on disk.

## Quality gate

`npm run typecheck`, `npm run lint`, and `npm test` must all pass before a ticket is done; CI (job
`gate`) runs the same plus coverage, build, and `audit .`. The pre-commit hook runs the gate locally.

- TypeScript conventions (lint-enforced): no `as` casts (`as const` allowed), no non-null `!`, no
  `any` in your own types.
- `typescript` is held at ^6 until typescript-eslint's peer range admits 7 — see the dependabot
  ignore; bump both together.

## Branch, commit & PR workflow

Every ticket lands on its own branch and merges to `main` via a **squash-merged PR** — never a direct
push to `main`. Branch names follow `<type>/<id>-<slug>` (`bug→fix`, `feature→feat`, `task→task`,
`chore→chore`), enforced server-side by the `branch-name` check. Three human gates: "Ready to
commit?", "Ready to open PR?", "Ready to merge?".

## Testing

Every logic change adds tests: happy path, edge cases, rejection cases. Bug fixes write the failing
repro first and watch it go red. The hooks ship with packaging + direct-execution contracts
(`hooks/packaging.test.mjs`) — a new hook needs a probe there or the suite fails.

## Versioning

Tags are the release artifact. Version comparisons use `git tag --sort=v:refname` (lexical sort puts
v0.10.0 beside v0.1.0), and `git ls-remote --exit-code` answers remote existence. Cut a tag only from
a green `main`; consumers bump their pin by hand.

## Comment philosophy

Comments are sparse and earn their place: only a non-obvious *why* — an invariant, a fail-open/closed
decision, a gotcha. Never restate what the code says.
