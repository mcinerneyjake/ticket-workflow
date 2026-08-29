import path from 'node:path';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const LAUNCHER_PATH = '.claude/hooks/guard-bash.mjs';

// A launcher IMPORTS the guard from the installed package; a vendored copy carries the guard's own
// source. The specifier must appear in import position — a vendored guard whose provenance comment
// mentions 'ticket-workflow/hooks/…' is still a vendored guard — and a launcher is small by
// construction, so anything guard-sized fails the classification even with the right import line.
// The budget has headroom over the largest shipped launcher on purpose — templates.test.ts pins that
// margin, because a comment paragraph pushing a correct launcher over it would report it as vendored.
const LAUNCHER_MAX_LINES = 80;
const IMPORT_POSITION = /(?:import\s*\(\s*|from\s+)['"]ticket-workflow\/hooks\/guard-bash\.mjs['"]/;

// Only exit 2 blocks. Exit 1 is a non-blocking hook ERROR and exit 0 is ALLOW, so a launcher that
// crashes runs the command — which is why this check reads the exit CODE and never `ok`.
const BLOCK_EXIT = 2;

// Whole-tree staging is the guard's rule 1 and consults neither branch nor remote, so it means the
// same thing in every repo state — unlike a commit-to-main probe, which a remote-less repo exempts.
const DANGEROUS_COMMAND = 'git add -A';
const ORDINARY_COMMAND = 'echo hello';

/**
 * Recognises a launcher reporting that it could obtain NO guard at all — the state a repository
 * cannot self-certify past, as distinct from a launcher that runs and blocks indiscriminately.
 *
 * Three things this is NOT. It is not a single token: launchers scaffolded before the token existed
 * are correct and fail closed with their own wording, and matching only the token reported every one
 * of them as `fail — it is inert, wedging the repo` on any machine without the toolchain installed
 * (measured against four repos on the author's machine; tkt-c4a4a79bec8a review). It is not a
 * provenance check: an audited repo can print anything it likes, so a launcher that blocks
 * everything CAN spoof its way from `fail` to `blocked` — this check reports what a repo claims
 * about itself, and `blocked` gates anyway. And it is not emitted by a guard that loaded and then
 * misbehaved: the shipped launchers reserve it for the resolution failure, so a broken guard reads
 * as the defect it is.
 */
const GUARD_UNAVAILABLE = /guard-unavailable|could not run the guard from ticket-workflow|no usable ticket-workflow guard could be loaded/;

function looksLikeLauncher(contents: string): boolean {
  const small = contents.split('\n').length <= LAUNCHER_MAX_LINES;
  return small && (IMPORT_POSITION.test(contents) || /run-hook\.mjs\s+\S+/.test(contents));
}

interface Probe {
  readonly status: number;
  readonly stderr: string;
}

/**
 * Drives the launcher exactly as the harness does: payload as JSON on stdin, exit code as verdict.
 *
 * TRUST BOUNDARY, stated rather than discovered: this EXECUTES code from the audited repository, and
 * the text gates above are a shape filter, not a sandbox. Auditing a checkout you do not trust runs
 * its launcher as you. That is inherent — a guard cannot be shown to run without running it — but it
 * means `audit` is not safe to point at arbitrary third-party code. Hardening (scrubbed env, tighter
 * timeout) is tracked separately; the 60s spawn timeout in defaultExec is the only bound today.
 */
function runLauncher(ctx: AuditContext, command: string): Probe | { readonly undetermined: string } {
  const res = ctx.exec('node', [path.join(ctx.repoDir, LAUNCHER_PATH)], {
    cwd: ctx.repoDir,
    input: JSON.stringify({ cwd: ctx.repoDir, tool_name: 'Bash', tool_input: { command } }),
  });
  if (res.kind === 'absent') return { undetermined: 'node is not on PATH, so the launcher cannot be executed' };
  if (res.kind === 'error') return { undetermined: `the launcher could not be spawned: ${res.message}` };
  // Death by signal reports a null status, and an injected exec may report none at all. Both are "no
  // exit code", and an unknown verdict must never resolve to the allowing one.
  if (typeof res.status !== 'number') return { undetermined: 'the launcher produced no exit code, so its verdict is unknown' };
  return { status: res.status, stderr: res.stderr };
}

/**
 * THREE-WAY by design: launcher = PASS, vendored copy = FAIL, absent = FAIL. Never "present = PASS" —
 * the vendored shape is the one that already burned (a stale copy left the guard failing OPEN on an
 * unresolvable branch for ~24h), and it is exactly the shape that looks fine to a presence check.
 *
 * And never "reads correctly = PASS" (tkt-c4a4a79bec8a). Classifying on file TEXT returned the same
 * PASS for a launcher that discriminated and for one that threw ERR_MODULE_NOT_FOUND and blocked
 * every command, wedging the repo — same verdict, opposite realities. So the text checks below are
 * only a pre-filter for shapes that must not run at all; the verdict comes from EXECUTING the
 * launcher against a dangerous and an ordinary command and requiring it to tell them apart.
 */
export const hookLauncher: AuditCheck = {
  id: 'hook-launcher',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read(LAUNCHER_PATH);
    if (file.kind === 'missing') {
      return makeResult(this, 'fail', `${LAUNCHER_PATH} is absent — no in-repo guard at all; a fresh clone runs unguarded`);
    }
    if (file.kind === 'error') return makeResult(this, 'blocked', `${LAUNCHER_PATH} could not be read: ${file.message}`);
    if (!looksLikeLauncher(file.contents)) {
      return makeResult(
        this,
        'fail',
        `${LAUNCHER_PATH} is a vendored copy, not a launcher — it drifts silently from the shipped guard; replace it with a launcher importing ticket-workflow/hooks/guard-bash.mjs`,
      );
    }
    // Kept as TEXT because execution cannot reach it: with the package resolvable, the import never
    // fails, so a launcher missing its blocking exit runs the guard correctly here and would fail
    // OPEN only on the machine where resolution breaks.
    const failsClosed = file.contents.includes('process.exit(2)') || /run-hook\.mjs\s+\S+/.test(file.contents);
    if (!failsClosed) {
      return makeResult(this, 'fail', `${LAUNCHER_PATH} delegates to the package but never exits 2 — an import failure would fail OPEN`);
    }

    const dangerous = runLauncher(ctx, DANGEROUS_COMMAND);
    if ('undetermined' in dangerous) return makeResult(this, 'blocked', dangerous.undetermined);
    const ordinary = runLauncher(ctx, ORDINARY_COMMAND);
    if ('undetermined' in ordinary) return makeResult(this, 'blocked', ordinary.undetermined);

    const blocksDangerous = dangerous.status === BLOCK_EXIT;
    const allowsOrdinary = ordinary.status === 0;
    if (blocksDangerous && allowsOrdinary) {
      return makeResult(this, 'pass', `${LAUNCHER_PATH} runs and discriminates — \`${DANGEROUS_COMMAND}\` blocked (exit 2), \`${ORDINARY_COMMAND}\` allowed`);
    }
    if (blocksDangerous) {
      // Blocks everything. Fail-closed is the RIGHT behaviour for a guard that cannot load, so this
      // is not a repository defect — but it is also not evidence the guard works, and BLOCKED gates.
      if (GUARD_UNAVAILABLE.test(ordinary.stderr)) {
        return makeResult(
          this,
          'blocked',
          `${LAUNCHER_PATH} cannot load the guard, so it blocks every command (correctly, but unverifiably) — install the toolchain and re-run`,
        );
      }
      return makeResult(
        this,
        'fail',
        `${LAUNCHER_PATH} blocks even \`${ORDINARY_COMMAND}\` (exit ${ordinary.status}) and reports no load failure — the guard is broken or the launcher inert; either way it wedges the repo rather than guarding it`,
      );
    }
    return makeResult(
      this,
      'fail',
      `${LAUNCHER_PATH} did not block \`${DANGEROUS_COMMAND}\` (exit ${dangerous.status}, and only exit 2 blocks) — the guard is not in force`,
    );
  },
};
