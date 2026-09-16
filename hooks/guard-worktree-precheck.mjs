#!/usr/bin/env node
// PreToolUse Edit|Write|NotebookEdit|Bash — the cheap half of guard-worktree (tkt-1d647fd64ce4).
//
// WHY THIS FILE EXISTS AT ALL. Wiring the enforcing entry straight at the package would put the
// run-hook launcher — measured at ~110 ms against ~70 ms for bare node startup — in front of EVERY
// tool call in EVERY session on this machine, and, worse, would WEDGE Edit/Write/Bash machine-wide
// whenever the ~/.claude/tools install is broken: a launcher that fails closed does so before it can
// know the session is unarmed. So the common case — no ticket started — must cost one stat() and
// reach no package code at all.
//
// STANDALONE ON PURPOSE: no relative imports, because this file is COPIED out of the package to sit
// beside run-hook.mjs, where ./lib/ does not exist. That is also why isMain is inlined rather than
// imported. Keep it dependency-free.
//
// STDIN IS READ-ONCE, which drives the control flow: this file must consume fd 0 to learn the
// session id, so it cannot hand the guard a fresh one. It passes the bytes it already read.
//
// FAIL DIRECTION IS CLOSED once armed, open before: unreadable stdin, unreadable guard state, and a
// failed import while armed all exit 2, while an unarmed session exits 0 even with the package
// entirely absent. Those are opposite directions on purpose — see the two cases in
// guard-worktree.test.mjs under "with the package unreachable".

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[guard-worktree]';
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

function fail(detail) {
  process.stderr.write(`${TAG} Blocked: ${detail}\n`);
  process.exit(2);
}

export async function main() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    fail('the hook payload could not be read, so this call could not be judged.');
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail('the hook payload could not be parsed, so this call could not be judged.');
  }

  const id = payload?.session_id;
  // A KNOWN permissive edge, taken deliberately rather than argued away. For a MALFORMED id it is
  // sound — arm() refuses the same shapes, so no marker keyed by one can exist. For a payload that
  // simply omits session_id while the session is genuinely armed under a valid id, it is not: the
  // marker exists and this still allows, on a can't-tell-which-session rather than a real negative.
  // Wedging every tool call on the machine over an unattributable payload is the worse failure, so
  // this is the one place the guard answers a can't-check permissively. It is a residual, not a
  // guarantee — do not read the header's "once armed, every failure past that point closes" as
  // covering it, because reaching "armed" is exactly what this skips.
  if (typeof id !== 'string' || !SESSION_ID.test(id)) process.exit(0);

  const stateDir = process.env.WORKTREE_GUARD_STATE_DIR || join(homedir(), '.claude', 'state', 'worktree-guard');
  try {
    statSync(join(stateDir, id));
  } catch (e) {
    // ENOENT is a real negative — no ticket started. Anything else (a permission wall, a state dir
    // that is not a directory) is NOT an answer, and must not read as one.
    if (e?.code === 'ENOENT') process.exit(0);
    fail(`the worktree-guard state could not be read (${e?.code ?? 'unknown error'}), so this session's arming is unknown.`);
  }

  let mod;
  try {
    mod = await import('ticket-workflow/hooks/guard-worktree.mjs');
  } catch (e) {
    fail(
      `this session is armed, but the guard could not be loaded (${String(e?.message ?? e).split('\n')[0].slice(0, 200)}).\n` +
        'Refusing to let an armed session run unguarded. Fix the ticket-workflow install.',
    );
  }
  mod.run(raw);
}

// Inlined rather than imported from ./lib/is-main.mjs: this file ships copied out of the package.
// realpath on BOTH sides, because Node realpaths the ESM entry point but not argv[1], so a naive
// URL comparison is false through a symlink — and a guard that silently exits 0 reads as ALLOW.
function invokedDirectly(url) {
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) {
  main().catch((e) => fail(`the guard threw before reaching a verdict (${String(e?.message ?? e).split('\n')[0]}).`));
}
