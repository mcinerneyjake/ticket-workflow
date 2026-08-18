import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tkt-3a91af2aa6d9. This is a public repo, and the user-agnosticism rule used to be honour-system
// prose: a hand-run `git grep '/Users/'` with a hardcoded exclusion list. It rotted the worst way —
// the list went stale, so it reported a hit on every clean run while the identifier actually
// committed (a real account name in a `~user/` path) sat in a shape it never matched. A check that
// always fires is a check people stop reading.
//
// PLACEHOLDER-AWARE, not shape-blind: fixtures legitimately need home paths to exercise path
// parsing, so banning the shape outright is what forced the stale exclusion list to exist at all.
// What is banned is a home path naming a REAL account.

const PLACEHOLDERS = new Set([
  'someuser', 'user', 'youruser', 'me', 'x', 'o', 'test', 'example',
  // CI runners: a workflow, or a pasted CI log in a doc, legitimately carries these. Omitting them
  // would recreate the always-fires check this ticket was filed against.
  'runner', 'ubuntu',
]);

// `/Users/<owner>` and `/home/<owner>` need NO trailing slash — `/Users/user` at end of line, or
// `HOME=/Users/user`, is exactly the leak the first cut of this check missed, which made it
// narrower than the grep it replaced. The owner class starts at `[A-Za-z_]`, so a leading-underscore
// account is caught and `~5 minutes` is not.
const ABS_HOME = /(?:\/Users\/|\/home\/)([A-Za-z_][A-Za-z0-9._-]*)/g;
// The tilde form DOES require a trailing slash, deliberately: bare `~word` is ordinary prose
// ("~two hours", "~40 lines"), and flagging it would fire on documentation forever. So `cd ~user`
// with no path after it is a known blind spot — named here and in CLAUDE.md rather than implied.
const TILDE_HOME = /~([A-Za-z_][A-Za-z0-9._-]*)\//g;

// Lines carrying this marker are the control fixtures below. Scoped to LINES, not to this whole
// file: a whole-file exclusion is the hardcoded-exclusion-list mistake this ticket removed, and it
// would make a genuine leak anywhere in this file unscannable.
const FIXTURE = 'HYGIENE_FIXTURE';

const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const env = { ...process.env };
  // An inherited git context overrides cwd, so this would silently scan a DIFFERENT repository and
  // report it clean — and no file-count floor can catch that, since any repo clears one.
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }) };
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status === 1) return { ok: false, out: '' };
    throw err;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  const root = git(['rev-parse', '--show-toplevel'], here).out.trim();
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const name = pkg && typeof pkg === 'object' && 'name' in pkg ? pkg.name : undefined;
  // Identity check, not a smoke test: it is what makes "clean" mean clean HERE.
  expect(name, 'resolved a different repository than ticket-workflow').toBe('ticket-workflow');
  return root;
}

function leakedOwners(line: string): string[] {
  const owners = [...line.matchAll(ABS_HOME), ...line.matchAll(TILDE_HOME)].map((m) => m[1]);
  return owners.filter((o) => !PLACEHOLDERS.has(o.toLowerCase()));
}

describe('public repo carries no local identifiers', () => {
  it('has no home-directory path naming a real account, anywhere in the index', () => {
    const root = repoRoot();

    // Scans the INDEX, not the working tree. Reading worktree bytes checked neither snapshot
    // consistently: a leak could be staged and then cleaned in the worktree, passing the pre-commit
    // gate while the leaked blob committed; a tracked-but-deleted file threw ENOENT and killed the
    // suite with an unrelated error; and `-I` gives binary skipping for free.
    const candidates = git(['grep', '--cached', '-I', '-n', '-E', '(/Users/|/home/|~)[A-Za-z_]', '--', '.'], root);

    // Non-vacuity, two ways. A negative claim resolved from an empty scan is a clean report that
    // inspected nothing.
    const tracked = git(['ls-files'], root).out.split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(50);
    const control = git(['grep', '--cached', '-c', 'ticket-workflow', '--', '.'], root);
    expect(control.ok, 'the index-grep instrument found nothing at all — it is broken, not the repo clean').toBe(true);

    const leaks: string[] = [];
    for (const line of candidates.out.split('\n').filter(Boolean)) {
      if (line.includes(FIXTURE)) continue;
      const [file, , ...rest] = line.split(':');
      const owners = leakedOwners(rest.join(':'));
      for (const owner of owners) leaks.push(`${file}: ${owner}`);
    }

    expect(leaks, 'a home path names a real account — use a placeholder').toEqual([]);
  });

  // Controls: the matcher must fire on the real thing and stay silent on the placeholder, or the
  // clean verdict above means nothing.
  it('flags a real account name, with or without a trailing slash', () => {
    expect(leakedOwners('/Users/realaccount/board/')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('HOME=/Users/realaccount')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/home/realaccount')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/_realaccount/x')).toEqual(['_realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('cd ~realaccount/repo')).toEqual(['realaccount']); // HYGIENE_FIXTURE
  });

  it('permits placeholders, CI runner paths and ordinary prose', () => {
    expect(leakedOwners('cd ~someuser/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/x/repos/some-repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/home/runner/work/repo/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('it took ~two hours and ~40 lines')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('no home path here at all')).toEqual([]);
  });

  // The documented blind spot, pinned so it cannot be mistaken for coverage later.
  it('does NOT catch a bare tilde account with no path after it (known limit)', () => {
    expect(leakedOwners('cd ~realaccount')).toEqual([]); // HYGIENE_FIXTURE
  });
});
