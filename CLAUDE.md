# ticket-workflow

This repo follows its own guardrail standard. `node dist/cli/index.js audit .` (after a build) is the
machine-checkable definition; this file is a pointer to it, not a second copy.

## What this package is

The canonical ticket engine: MCP server, guard/telemetry hooks, pipeline CLI (`list`, `show`,
`doctor`, `verify`, `audit`, `init`), the guardrail template set, and the audit that checks any repo
against the standard. Consumers (kanban first) pin it by **git tag**, never a branch — a fix here
reaches them only through a tag cut plus their own pin bump.

## Public and user-agnostic — hard rule

This is a public repo. **Never commit a local identifier**: no `/Users/…` paths, no machine-local
board paths, no private hostnames. The template contents are test-enforced
(`src/templates.test.ts`, user-agnosticism case); for everything else, before any commit:
`git grep '/Users/' -- ':!src/templates.test.ts' ':!CLAUDE.md'` must return nothing — the two
excluded files are the enforcement and this rule, whose own text names the pattern.

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
