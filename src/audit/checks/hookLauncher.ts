import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const LAUNCHER_PATH = '.claude/hooks/guard-bash.mjs';

// A launcher IMPORTS the guard from the installed package; a vendored copy carries the guard's own
// source. The specifier must appear in import position — a vendored guard whose provenance comment
// mentions 'ticket-workflow/hooks/…' is still a vendored guard — and a launcher is small by
// construction, so anything guard-sized fails the classification even with the right import line.
const LAUNCHER_MAX_LINES = 60;
const IMPORT_POSITION = /(?:import\s*\(\s*|from\s+)['"]ticket-workflow\/hooks\/guard-bash\.mjs['"]/;

function looksLikeLauncher(contents: string): boolean {
  const small = contents.split('\n').length <= LAUNCHER_MAX_LINES;
  return small && (IMPORT_POSITION.test(contents) || /run-hook\.mjs\s+\S+/.test(contents));
}

/**
 * THREE-WAY by design: launcher = PASS, vendored copy = FAIL, absent = FAIL. Never "present = PASS" —
 * the vendored shape is the one that already burned (a stale copy left the guard failing OPEN on an
 * unresolvable branch for ~24h), and it is exactly the shape that looks fine to a presence check.
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
    // A launcher that lets an import failure fall through exits 1, which the hook protocol reads as
    // ALLOW — the fail-open in a costume. Require the explicit blocking exit (run-hook.mjs carries
    // its own).
    const failsClosed = file.contents.includes('process.exit(2)') || /run-hook\.mjs\s+\S+/.test(file.contents);
    if (!failsClosed) {
      return makeResult(this, 'fail', `${LAUNCHER_PATH} delegates to the package but never exits 2 — an import failure would fail OPEN`);
    }
    return makeResult(this, 'pass', `${LAUNCHER_PATH} is a fail-closed launcher`);
  },
};
