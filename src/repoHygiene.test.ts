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
//
// tkt-87b8b9b60b24: macOS is case-insensitive, so `/users/<owner>` is a working path too. The
// off-case spellings count only at a path root, or every `/api/users/<id>` route reads as a leak;
// only the canonical `/Users/`, `/home/` match mid-path. No blanket `i` (prose `HOME`). Declared
// limits, pinned: `/USERS/`, `/HOME/` and a nested off-case prefix are unmatched; a root route flags.
const ABS_HOME = /(?:\/Users\/|\/home\/|(?<![\w.~-])\/users\/|(?<![\w.~-])\/Home\/)([A-Za-z_][A-Za-z0-9._-]*)/g;
// The tilde form DOES require a trailing slash, deliberately: bare `~word` is ordinary prose
// ("~two hours", "~40 lines"), and flagging it would fire on documentation forever. So `cd ~user`
// with no path after it is a known blind spot — named here and in CLAUDE.md rather than implied.
const TILDE_HOME = /~([A-Za-z_][A-Za-z0-9._-]*)\//g;

// Lines carrying this marker are the control fixtures below. Scoped to LINES of THIS file only: a
// whole-file exclusion would hide a leak here, and an any-file marker lets a doc line opt out.
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
    // `-z` NUL-separates file and line number, so a `:` in a file name cannot misattribute a leak.
    const candidates = git(['grep', '--cached', '-I', '-z', '-n', '-i', '-E', '(/Users/|/home/|~)[A-Za-z_]', '--', '.'], root);

    // Proves the grep runs and this pattern matches (this file's fixtures are tracked); breadth is
    // proven by the file-count floor and the everything-scanned pin below, not by this.
    expect(candidates.ok, 'the candidate pattern matched NOTHING — the instrument is broken, not the repo clean').toBe(true);
    const tracked = git(['ls-files', '-z'], root).out.split('\0').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(50);
    // Candidate records are newline-separated, so a newline in a path could forge `file === self`.
    expect(tracked.filter((f) => f.includes('\n')), 'tracked paths containing a newline break record parsing').toEqual([]);

    // `git grep --cached` never reads a symlink (whose blob is a target path), a submodule, or a
    // conflicted (stage 1-3) entry, so each is an unscanned file; fail for a human rather than skip it.
    const unscannable = git(['ls-files', '-s', '-z'], root).out.split('\0').filter(Boolean)
      .filter((entry) => !/^100(?:644|755) [0-9a-f]+ 0\t/.test(entry))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1));
    expect(unscannable, 'tracked symlinks, submodules or conflicted entries are never scanned by git grep').toEqual([]);

    // `-I` skips binary files, and one stray NUL byte classifies a text file as binary, hiding a leak.
    // Compared against files grep reads at all, so an empty file (no lines) is not mistaken for one.
    const listed = (flags: string[]) => new Set(git(['grep', '--cached', ...flags, '-l', '-z', '-e', '', '--', '.'], root).out.split('\0').filter(Boolean));
    const textFiles = listed(['-I']);
    const skippedAsBinary = [...listed([])].filter((f) => !textFiles.has(f));
    expect(skippedAsBinary, 'tracked files classify as BINARY and are skipped by the -I scan — a stray NUL byte hides a leak this way').toEqual([]);

    const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
    const leaks: string[] = [];
    let fixturesSkipped = 0;
    for (const line of candidates.out.split('\n').filter(Boolean)) {
      const [file, lineNo, ...rest] = line.split('\0');
      expect(/^\d+$/.test(lineNo ?? '') && rest.length > 0, `unparseable grep record: ${JSON.stringify(line)}`).toBe(true);
      const text = rest.join('\0');
      if (file === self && text.includes(FIXTURE)) {
        fixturesSkipped++;
        continue;
      }
      for (const owner of leakedOwners(text)) leaks.push(`${file}: ${owner}`);
    }
    // The fixtures below must reach the classifier; zero skipped means the records were never parsed.
    expect(fixturesSkipped, 'no fixture line of this file was parsed — the record split is broken').toBeGreaterThan(0);

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

  it('flags the prefix in either natural case (tkt-87b8b9b60b24)', () => {
    expect(leakedOwners('/users/realaccount/x')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/Home/realaccount/x')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/mnt/c/Users/realaccount/x')).toEqual(['realaccount']); // HYGIENE_FIXTURE
  });

  it('does not read a nested lowercase route segment as a home dir', () => {
    expect(leakedOwners('GET /api/users/active')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('https://example.com/Home/Index')).toEqual([]); // HYGIENE_FIXTURE
  });

  it('DOES flag a root-level lowercase route (known limit)', () => {
    expect(leakedOwners('GET /users/search')).toEqual(['search']); // HYGIENE_FIXTURE
  });

  it('does NOT catch a nested off-case prefix (known limit)', () => {
    expect(leakedOwners('/mnt/c/users/realaccount/x')).toEqual([]); // HYGIENE_FIXTURE
  });

  it('permits placeholders, CI runner paths and ordinary prose', () => {
    expect(leakedOwners('cd ~someuser/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/x/repos/some-repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/home/runner/work/repo/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('it took ~two hours and ~40 lines')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('no home path here at all')).toEqual([]);
    // An uppercase path segment in prose must not read as a home dir — the blanket-`i` regression.
    expect(leakedOwners('Shared mount/HOME/git middle of the argv')).toEqual([]); // HYGIENE_FIXTURE
  });

  // The documented blind spot, pinned so it cannot be mistaken for coverage later.
  it('does NOT catch a bare tilde account with no path after it (known limit)', () => {
    expect(leakedOwners('cd ~realaccount')).toEqual([]); // HYGIENE_FIXTURE
  });
});
