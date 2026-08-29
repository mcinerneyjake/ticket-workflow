// CORE-tier launcher, not a copy — the guard lives in the ticket-workflow package. Core repos have
// no package.json by design, so the repo-local specifier alone can never resolve; hence TWO
// candidates, repo-local first so a package.json added here later becomes authoritative untouched.
// The trade, stated rather than discovered: candidate 2 is a machine-local, unversioned install, so
// a fresh clone elsewhere has no guard — it fails CLOSED there, which is why both paths end in
// blockUnavailable()/blockBroken(). Only exit 2 blocks; 1 is a non-blocking error and 0 is ALLOW.
//
// The `guard-unavailable` token is a CONTRACT: `ticket-workflow audit` executes this launcher and
// uses it to tell "no guard installed here" from a launcher that runs and blocks every command.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];

// Two exits, deliberately distinct. `guard-unavailable` means NO guard could be obtained, which is
// a machine-state problem the audit reports as unverifiable. A guard that loaded and then misbehaved
// is BROKEN, and must not borrow that excuse — it audits as a defect, which is what it is.
const blockUnavailable = (message) => {
  process.stderr.write(`[guard-bash] BLOCKED (guard-unavailable): ${message}\n`);
  process.exit(2);
};

const blockBroken = (message) => {
  process.stderr.write(`[guard-bash] BLOCKED: ${message}\n`);
  process.exit(2);
};

const load = async (label, importer) => {
  try {
    const mod = await importer();
    if (typeof mod?.main === 'function') return mod.main;
    // A pin too old to export a callable main resolves without throwing, so a caught error is not
    // the only way to end up with no guard.
    failures.push(`${label}: resolved but exports no callable main — stale install?`);
  } catch (err) {
    failures.push(`${label}: ${err?.code ?? err?.message ?? 'import failed'}`);
  }
};

// Candidate 1's specifier is a literal, not a variable: the audit classifies a launcher by the
// specifier appearing in import position. Candidate 2 is an absolute file URL, because a bare
// specifier resolves from this launcher's directory and would miss it too.
const installed = join(homedir(), '.claude', 'tools', 'node_modules', 'ticket-workflow', 'hooks', 'guard-bash.mjs');
const main =
  (await load('repo-local', () => import('ticket-workflow/hooks/guard-bash.mjs'))) ??
  (await load('machine-local', () => import(pathToFileURL(installed).href)));

if (!main) {
  blockUnavailable(`no usable ticket-workflow guard could be loaded, so Bash stays blocked.\n${failures.map((f) => `  - ${f}`).join('\n')}`);
}

try {
  await main();
} catch (err) {
  // The guard throwing is NOT the guard allowing: an uncaught rejection exits 1, which the protocol
  // reads as a non-blocking error and runs the command anyway.
  blockBroken(`the guard threw (${err?.message ?? err}).`);
}

// Every path in the guard's main() exits; falling off the end here would exit 0.
blockBroken('the guard returned without exiting — contract violation.');
