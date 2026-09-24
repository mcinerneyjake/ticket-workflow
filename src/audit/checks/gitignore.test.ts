import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitignore } from './gitignore.js';
import { defaultExec, readRepoFile, type AuditContext, type Exec, type ExecResult } from '../types.js';

/** A conforming node_modules rule, so the worktree cases vary only the worktree dimension. */
const NM = 'node_modules\n';
/** A conforming worktree rule, so the node_modules cases vary only the node_modules dimension. */
const WT = '.claude/worktrees\n';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RepoOpts {
  readonly git?: boolean;
  /** A root package.json, which is what makes node_modules a requirement. Default: present. */
  readonly node?: boolean;
}

function makeRepo(contents?: string, opts?: RepoOpts): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-gitignore-'));
  tempDirs.push(dir);
  if (opts?.git !== false) execFileSync('git', ['init', '-q', dir]);
  if (opts?.node !== false) writeFileSync(path.join(dir, 'package.json'), '{}\n');
  if (contents !== undefined) writeFileSync(path.join(dir, '.gitignore'), contents);
  return dir;
}

function ctxFor(dir: string, exec: Exec = defaultExec): AuditContext {
  return { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec };
}

function run(contents?: string, opts?: RepoOpts) {
  return gitignore.run(ctxFor(makeRepo(contents, opts)));
}

/** An exec that answers every call the same way — for the outcomes real git will not produce. */
function fixedExec(result: ExecResult): Exec {
  return () => result;
}

/** Real git for everything except `check-ignore`, so the probe's own failure paths are reachable. */
function failingProbe(result: ExecResult): Exec {
  return (cmd, args, opts) => (args.includes('check-ignore') ? result : defaultExec(cmd, args, opts));
}

describe('gitignore check — decided by ignore EFFECT, not by matching entry strings', () => {
  it('FAILS the trailing-slash form, which does not ignore a SYMLINKED worktree', () => {
    // The bug (tkt-45ddb02e4280). A `dir/` pattern matches directories only, and a worktree
    // materialized as a symlink is a FILE to git — so `git status` reports `?? .claude/` and the
    // main checkout fills with another session's in-flight work.
    const res = run(`${NM}.claude/worktrees/\n`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/trailing slash/i);
    expect(res.detail).toMatch(/\.claude\/worktrees/);
  });

  it('FAILS it even where .claude/worktrees already exists on disk as a real directory', () => {
    // The verdict must be a property of the REPOSITORY, not of the auditor's filesystem. git
    // resolves a `dir/` pattern against the working tree, so probing the audited checkout reported
    // this exact broken rule as conforming wherever `worktree` had left its directory behind —
    // which is the whole target population, this repo included.
    const dir = makeRepo(`${NM}.claude/worktrees/\n`);
    mkdirSync(path.join(dir, '.claude', 'worktrees'), { recursive: true });
    expect(gitignore.run(ctxFor(dir)).status).toBe('fail');
  });

  it('passes the slashless form, which ignores the symlink and the directory alike', () => {
    expect(run(`${NM}.claude/worktrees\n`).status).toBe('pass');
  });

  it('passes a leading-slash anchor', () => {
    expect(run(`${NM}/.claude/worktrees\n`).status).toBe('pass');
  });

  it('passes when a working form accompanies the broken one — the EFFECT is what is asserted', () => {
    // A check that rejected the trailing-slash STRING would fail this repo, which is conforming.
    expect(run(`${NM}.claude/worktrees/\n.claude/worktrees\n`).status).toBe('pass');
  });

  it('passes a rule written in a nested, committed .claude/.gitignore', () => {
    const dir = makeRepo(NM);
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', '.gitignore'), 'worktrees\n');
    expect(gitignore.run(ctxFor(dir)).status).toBe('pass');
  });

  it('fails when a negation RE-INCLUDES the worktree, and names the negation', () => {
    // `git check-ignore -v` exits 0 for a negation too, so an exit-code-only probe reads this as
    // ignored. The deciding rule is the one git prints, and a leading `!` means NOT ignored.
    const res = run(`${NM}.claude/*\n!.claude/worktrees\n`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/!\.claude\/worktrees/);
  });

  it('passes when the negation LOSES to an excluded parent, which still ignores the worktree', () => {
    // The other direction, and the reason this reads git's verdict rather than grepping for `!`:
    // git cannot re-include under an excluded directory, so `.claude/` beats `!.claude/worktrees`.
    expect(run(`${NM}.claude/\n!.claude/worktrees\n`).status).toBe('pass');
  });

  it('fails a file that only MENTIONS the path in a comment', () => {
    expect(run(`# ignore .claude/worktrees one day\n${NM}`).status).toBe('fail');
  });

  it('fails a non-empty file that does not ignore it at all', () => {
    expect(run(`${NM}dist/\n`).status).toBe('fail');
  });

  it('fails a missing .gitignore, and an empty one', () => {
    expect(run(undefined).status).toBe('fail');
    expect(run('\n  \n').status).toBe('fail');
  });

  it('gives a real verdict in a directory that is not a git repository yet', () => {
    // `init` scaffolds before `git init` — the rules are evaluated in a scratch repo, so the audited
    // directory need not be one. Both verdicts must be reachable there, not just BLOCKED.
    expect(run(`${NM}.claude/worktrees\n`, { git: false }).status).toBe('pass');
    expect(run(NM, { git: false }).status).toBe('fail');
  });
});

describe('gitignore check — node_modules must be ignored as a SYMLINK too (tkt-6b1ad6b887fe)', () => {
  it('FAILS `node_modules/`, which leaves the SYMLINKED node_modules of a worktree untracked', () => {
    // Worktrees link node_modules to the primary's rather than installing, and a `dir/` pattern
    // never matches that link — `git status` shows `?? node_modules` and `git add -A` commits it.
    const res = run(`node_modules/\n${WT}`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/node_modules/);
    expect(res.detail).toMatch(/trailing slash/i);
  });

  it('FAILS it even where node_modules already exists on disk as a real directory', () => {
    // Every Node checkout that has run `npm ci` — probing it in place would read `node_modules/` as
    // conforming. The scratch repository is what keeps the answer a property of the rules.
    const dir = makeRepo(`node_modules/\n${WT}`);
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '');
    expect(gitignore.run(ctxFor(dir)).status).toBe('fail');
  });

  it('fails when there is no node_modules rule at all, and names it', () => {
    const res = run(WT);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/node_modules/);
  });

  it('fails when a negation re-includes node_modules, and names the negation', () => {
    const res = run(`node_modules\n!node_modules\n${WT}`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/!node_modules/);
  });

  it('fails a negation that re-includes only the DIRECTORY shape, and names it', () => {
    // `!node_modules/` matches directories only, so the symlink stays ignored while a real one is
    // re-included. A file under it reports NO rule, so only the directory's own verdict names it.
    const res = run(`node_modules\n!node_modules/\n${WT}`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/!node_modules\//);
  });

  it.each(['node_modules', '/node_modules', '**/node_modules'])('passes %s, which ignores the symlink and the directory alike', (rule) => {
    expect(run(`${rule}\n${WT}`).status).toBe('pass');
  });

  it('fails when the only node_modules rule lives in .git/info/exclude', () => {
    const dir = makeRepo(WT);
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), NM);
    expect(gitignore.run(ctxFor(dir)).status).toBe('fail');
  });

  it.each(['node_modules/*', 'node_modules/**'])('FAILS %s, which matches only the contents, and says to write it bare', (rule) => {
    const res = run(`${rule}\n${WT}`);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/write it bare: node_modules$/);
  });

  it('does not require node_modules in a repo with no package.json (a core-tier, non-Node repo)', () => {
    expect(run(WT, { node: false }).status).toBe('pass');
    expect(run(WT, { node: false }).detail).not.toMatch(/node_modules/);
  });

  it('control: the same repo WITH a package.json fails', () => {
    expect(run(WT).status).toBe('fail');
  });

  it('blocks when package.json cannot be read — unknown is not "not a Node repo"', () => {
    const dir = makeRepo(WT, { node: false });
    mkdirSync(path.join(dir, 'package.json'));
    expect(gitignore.run(ctxFor(dir)).status).toBe('blocked');
  });

  it('reports BOTH defects when both rules carry the trailing slash', () => {
    // Reporting only the first sends someone round the fix-and-re-audit loop twice.
    const res = run('node_modules/\n.claude/worktrees/\n');
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/\.claude\/worktrees/);
    expect(res.detail).toMatch(/node_modules/);
  });
});

describe('gitignore check — a rule that does not travel with a clone is not conformance', () => {
  it('fails when the only rule lives in .git/info/exclude', () => {
    const dir = makeRepo(NM);
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/worktrees\n');
    expect(gitignore.run(ctxFor(dir)).status).toBe('fail');
  });

  it('fails when the only rule lives in a machine-local excludesFile, absolute OR relative', () => {
    // The relative spelling is the one a source-provenance test misses: `path.isAbsolute` is false
    // for it, so a check reading the reported source would call a per-machine rule clone-travelling.
    for (const spelling of ['absolute', 'relative'] as const) {
      const dir = makeRepo(NM);
      writeFileSync(path.join(dir, 'machine-local'), '.claude/worktrees\n');
      const value = spelling === 'absolute' ? path.join(dir, 'machine-local') : 'machine-local';
      execFileSync('git', ['-C', dir, 'config', 'core.excludesFile', value]);
      expect(gitignore.run(ctxFor(dir)).status, spelling).toBe('fail');
    }
  });

  it("ignores the AUDITOR's global excludesFile in both directions", () => {
    // A `.claude/` line in a developer's own global ignore file is a realistic Claude Code setting.
    // It must neither rescue a broken repo nor fail a conforming one — and it out-ranks the
    // committed rule when it excludes the parent directory, so reading the deciding rule's source
    // is not enough; the machine's file has to be out of the evaluation entirely.
    const home = mkdtempSync(path.join(tmpdir(), 'tw-gitignore-home-'));
    tempDirs.push(home);
    const excludes = path.join(home, 'ignore');
    writeFileSync(excludes, '.claude/\nnode_modules\n');
    writeFileSync(path.join(home, 'config'), `[core]\n\texcludesFile = ${excludes}\n`);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(home, 'config');
    try {
      expect(run(NM).status, 'a global rule must not rescue a repo with no rule').toBe('fail');
      expect(run(`${NM}.claude/worktrees/\n`).status, 'a global rule must not rescue the trailing-slash form').toBe('fail');
      expect(run(`node_modules/\n${WT}`).status, 'a global rule must not rescue node_modules/').toBe('fail');
      expect(run(`${NM}.claude/worktrees\n`).status, 'a global rule must not fail a conforming repo').toBe('pass');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it('control: the same rule in the committed .gitignore DOES pass', () => {
    // Without this, every case above could be green because the probe never finds anything.
    expect(run(`${NM}.claude/worktrees\n`).status).toBe('pass');
  });
});

describe('gitignore check — the bare .claude/ trap', () => {
  it('passes ignoring all of .claude/, but WARNS that the guardrail files cannot be committed', () => {
    const res = run(`${NM}.claude/\n`);
    expect(res.status).toBe('pass');
    expect(res.detail).toMatch(/\.claude\/settings\.json/);
  });

  it('does not warn when settings.json is genuinely re-included', () => {
    // `.claude/` + `!.claude/settings.json` does NOT re-include it (git cannot re-include under an
    // excluded directory) but `.claude/*` + `!` does — so the warning must read the EFFECT too.
    const res = run(`${NM}.claude/*\n!.claude/settings.json\n`);
    expect(res.status).toBe('pass');
    expect(res.detail).not.toMatch(/settings\.json/);
  });

  it('still warns for the negation that only LOOKS like a re-include', () => {
    const res = run(`${NM}.claude/\n!.claude/settings.json\n`);
    expect(res.status).toBe('pass');
    expect(res.detail).toMatch(/\.claude\/settings\.json/);
  });
});

describe('gitignore check — "cannot determine" is BLOCKED, never a pass and never a fail', () => {
  it('blocks when git is not on PATH', () => {
    const res = gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), fixedExec({ kind: 'absent' })));
    expect(res.status).toBe('blocked');
    expect(res.detail).toMatch(/git/i);
  });

  it('blocks when the scratch repository cannot be initialised', () => {
    const res = gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), fixedExec({ kind: 'error', message: 'EAGAIN' })));
    expect(res.status).toBe('blocked');
  });

  it('blocks when the probe cannot be spawned, even though git init succeeded', () => {
    const res = gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), failingProbe({ kind: 'error', message: 'EAGAIN' })));
    expect(res.status).toBe('blocked');
  });

  it('blocks when the probe reports NO exit code — an unknown verdict is not the permissive one', () => {
    const exec = failingProbe({ kind: 'ran', ok: false, status: null, stdout: '', stderr: '' });
    expect(gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), exec)).status).toBe('blocked');
  });

  it('blocks on a fatal exit, rather than reading it as "not ignored"', () => {
    // Exit 1 means "no path is ignored"; 128 means git failed. Collapsing them would report a
    // broken probe as a repository defect, and send someone to edit a correct .gitignore.
    const exec = failingProbe({ kind: 'ran', ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' });
    expect(gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), exec)).status).toBe('blocked');
  });

  it('blocks when the probe claims a match but names no rule', () => {
    const exec = failingProbe({ kind: 'ran', ok: true, status: 0, stdout: '', stderr: '' });
    expect(gitignore.run(ctxFor(makeRepo(`${NM}.claude/worktrees\n`), exec)).status).toBe('blocked');
  });

  it('leaves no scratch directory behind', () => {
    const scratch = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('tw-gitignore-') && !tempDirs.some((d) => d.endsWith(n)));
    const before = new Set(scratch());
    run(`${NM}.claude/worktrees\n`);
    expect(scratch().filter((n) => !before.has(n))).toEqual([]);
  });
});

/** Guards the symlink materialisation itself: if it silently produced a directory, every
 *  trailing-slash case above would pass and the check would be back to the bug it fixes. */
describe('gitignore check — the symlink probe really is a symlink', () => {
  it('a dangling symlink is a non-directory to git, so a dir/ pattern does not match it', () => {
    const dir = makeRepo('.claude/worktrees/\n');
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, '.claude', 'worktrees'));
    // `-c core.excludesFile=` for the same reason the check passes it: a `.claude/` line in the
    // developer's own global ignore file would hide the symlink and make this assertion vacuous.
    const out = execFileSync('git', ['-c', 'core.excludesFile=', '-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(out, 'an unignored symlinked worktree is what the user actually sees').toMatch(/\.claude\//);
  });
});
