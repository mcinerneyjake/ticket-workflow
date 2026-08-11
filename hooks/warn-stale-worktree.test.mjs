import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessWorktree,
  formatReport,
  gatherFacts,
  parseThreshold,
  instructionFilesIn,
  resolveBaseRef,
  INSTRUCTION_FILES,
  DEFAULT_THRESHOLD,
} from './warn-stale-worktree.mjs';

const HOOK = fileURLToPath(new URL('./warn-stale-worktree.mjs', import.meta.url));

const worktree = (over = {}) => ({
  isLinkedWorktree: true,
  branch: 'feat/x',
  behind: 0,
  staleFiles: [],
  baseRef: 'origin/main',
  ...over,
});

const runHook = (cwd, env = {}, stdin = '{}') =>
  spawnSync(process.execPath, [HOOK], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('assessWorktree', () => {
  it('says nothing outside a linked worktree', () => {
    expect(assessWorktree({ isLinkedWorktree: false }).level).toBe('ok');
    expect(formatReport(assessWorktree({ isLinkedWorktree: false }))).toBeNull();
  });

  it('says nothing for a fresh worktree with no instruction drift', () => {
    expect(assessWorktree(worktree({ behind: 3 })).level).toBe('ok');
  });

  it('warns when an instruction file moved on the base branch, even if barely behind', () => {
    const a = assessWorktree(worktree({ behind: 1, staleFiles: ['CLAUDE.md'] }));
    expect(a.level).toBe('warn');
    expect(a.summary).toContain('CLAUDE.md');
    expect(a.lines.join(' ')).toContain('STALE');
  });

  it('warns on distance alone past the threshold, and says instructions are still accurate', () => {
    const a = assessWorktree(worktree({ behind: DEFAULT_THRESHOLD }));
    expect(a.level).toBe('warn');
    expect(a.lines.join(' ')).toContain('still accurate');
  });

  it('treats the threshold as inclusive at the boundary and quiet below it', () => {
    expect(assessWorktree(worktree({ behind: DEFAULT_THRESHOLD - 1 })).level).toBe('ok');
    expect(assessWorktree(worktree({ behind: DEFAULT_THRESHOLD })).level).toBe('warn');
  });

  it('honours a custom threshold, including 0 meaning always-warn', () => {
    expect(assessWorktree(worktree({ behind: 5, threshold: 3 })).level).toBe('warn');
    expect(assessWorktree(worktree({ behind: 5, threshold: 50 })).level).toBe('ok');
    expect(assessWorktree(worktree({ behind: 0, threshold: 0 })).level).toBe('warn');
  });

  it('calls a detached worktree detached rather than "on HEAD"', () => {
    for (const branch of ['HEAD', null]) {
      const a = assessWorktree(worktree({ branch, behind: 20 }));
      expect(a.summary).toContain('detached worktree');
      expect(a.summary).not.toContain("'HEAD'");
    }
  });

  it('pluralises stale-file wording', () => {
    expect(
      assessWorktree(worktree({ behind: 1, staleFiles: ['CLAUDE.md'] })).lines.join(' '),
    ).toContain('copy here is STALE');
    expect(
      assessWorktree(worktree({ behind: 1, staleFiles: ['CLAUDE.md', 'AGENTS.md'] })).lines.join(
        ' ',
      ),
    ).toContain('copies here are STALE');
  });

  it('never claims an exact figure — the local base ref is a floor', () => {
    expect(assessWorktree(worktree({ behind: 20 })).lines.join(' ')).toContain('floor');
  });
});

// Every one of these was a real fail-open in the first cut of this hook. Each
// asserts not.toBe('ok') explicitly, because 'ok' is the permissive answer and
// the whole point is that a failed probe can never produce it.
describe('assessWorktree: no probe failure may render as clean', () => {
  const cases = [
    ['git could not be queried at all', { isLinkedWorktree: null, probeError: 'bad config' }],
    ['base ref unresolvable', worktree({ baseRef: null, behind: null })],
    ['commit distance unavailable', worktree({ behind: null })],
    ['instruction-file probe failed', worktree({ behind: 3, staleFiles: null })],
    ['instruction probe failed while also far behind', worktree({ behind: 99, staleFiles: null })],
  ];

  for (const [name, facts] of cases) {
    it(`reports 'unknown', never 'ok', when ${name}`, () => {
      const a = assessWorktree(facts);
      expect(a.level).toBe('unknown');
      expect(a.level).not.toBe('ok');
      expect(formatReport(a)).not.toBeNull();
      expect(a.lines.join(' ')).toMatch(/NOT checked|could NOT be determined/);
    });
  }

  it('does not claim instructions are accurate when the check failed', () => {
    const a = assessWorktree(worktree({ behind: 3, staleFiles: null }));
    expect(a.lines.join(' ')).not.toContain('still accurate');
  });

  it('surfaces the underlying git error so the environment can be fixed', () => {
    const a = assessWorktree({ isLinkedWorktree: null, probeError: 'safe.directory refusal' });
    expect(a.lines.join(' ')).toContain('safe.directory refusal');
  });
});

describe('parseThreshold', () => {
  it('keeps an explicit 0 instead of falling back to the default', () => {
    expect(parseThreshold('0')).toEqual({ threshold: 0 });
  });

  it('defaults quietly when unset or empty', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseThreshold(raw)).toEqual({ threshold: DEFAULT_THRESHOLD });
    }
  });

  it('reports rather than swallows an unparseable or negative value', () => {
    for (const raw of ['abc', '15m', '-3']) {
      const r = parseThreshold(raw);
      expect(r.threshold).toBe(DEFAULT_THRESHOLD);
      expect(r.warning, raw).toContain('not a non-negative number');
    }
  });

  it('accepts a padded numeric string', () => {
    expect(parseThreshold(' 7 ').threshold).toBe(7);
  });
});

describe('instructionFilesIn', () => {
  it('matches a nested instruction file, not just one at the repo root', () => {
    expect(instructionFilesIn(['apps/web/CLAUDE.md'])).toEqual(['apps/web/CLAUDE.md']);
    expect(instructionFilesIn(['CLAUDE.md'])).toEqual(['CLAUDE.md']);
  });

  it('ignores ordinary source files and lookalikes', () => {
    expect(instructionFilesIn(['src/index.ts', 'docs/CLAUDE.md.bak', 'MyCLAUDE.md'])).toEqual([]);
  });
});

describe('formatReport', () => {
  it('emits the SessionStart payload shape the harness reads', () => {
    const r = formatReport(assessWorktree(worktree({ behind: 30, staleFiles: ['CLAUDE.md'] })));
    expect(r.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(r.hookSpecificOutput.additionalContext).toContain('CLAUDE.md');
    expect(r.systemMessage).toBeTruthy();
  });

  it('is valid JSON when serialised — the hook writes it to stdout', () => {
    const r = formatReport(assessWorktree(worktree({ behind: 30 })));
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
  });
});

// gatherFacts and the entrypoint are where the git plumbing lives, so they run
// against real repos. Without this every test above could pass while the hook
// detected nothing in practice.
describe('against real repositories', () => {
  let root, work, wt, nested, nestedWt, develop, developWt, noRemote, noRemoteWt;
  const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const init = (dir) => {
    mkdirSync(dir, { recursive: true });
    run(['init', '--initial-branch=main', '.'], dir);
    run(['config', 'user.email', 't@example.com'], dir);
    run(['config', 'user.name', 'T'], dir);
  };
  const clonePair = (name) => {
    const origin = path.join(root, `${name}.git`);
    const w = path.join(root, name);
    mkdirSync(origin, { recursive: true });
    run(['init', '--bare', '--initial-branch=main', '.'], origin);
    run(['clone', origin, w], root);
    run(['config', 'user.email', 't@example.com'], w);
    run(['config', 'user.name', 'T'], w);
    return w;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wt-stale-'));

    // 1. Root CLAUDE.md, base branch moves after the worktree is cut.
    work = clonePair('work');
    wt = path.join(root, 'work-wt');
    writeFileSync(path.join(work, 'CLAUDE.md'), 'original\n');
    run(['add', 'CLAUDE.md'], work);
    run(['commit', '-m', 'init'], work);
    run(['push', '-u', 'origin', 'main'], work);
    run(['worktree', 'add', wt, '-b', 'feat/stale'], work);
    writeFileSync(path.join(work, 'CLAUDE.md'), 'REWRITTEN\n');
    run(['commit', '-am', 'rewrite'], work);
    run(['push', 'origin', 'main'], work);
    run(['fetch', 'origin'], work);

    // 2. Instructions live in a SUBDIRECTORY only.
    nested = clonePair('nested');
    nestedWt = path.join(root, 'nested-wt');
    mkdirSync(path.join(nested, 'apps', 'web'), { recursive: true });
    writeFileSync(path.join(nested, 'apps/web/CLAUDE.md'), 'strict OFF\n');
    run(['add', '.'], nested);
    run(['commit', '-m', 'init'], nested);
    run(['push', '-u', 'origin', 'main'], nested);
    run(['worktree', 'add', nestedWt, '-b', 'feat/nested'], nested);
    writeFileSync(path.join(nested, 'apps/web/CLAUDE.md'), 'strict ON, pinned by a test\n');
    run(['commit', '-am', 'rewrite nested'], nested);
    run(['push', 'origin', 'main'], nested);
    run(['fetch', 'origin'], nested);

    // 3. Default branch is `develop`, and origin/main does NOT exist.
    develop = clonePair('dev');
    developWt = path.join(root, 'dev-wt');
    writeFileSync(path.join(develop, 'CLAUDE.md'), 'x\n');
    run(['add', '.'], develop);
    run(['commit', '-m', 'init'], develop);
    run(['branch', '-m', 'develop'], develop);
    run(['push', '-u', 'origin', 'develop'], develop);
    run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'], develop);
    run(['worktree', 'add', developWt, '-b', 'feat/dev'], develop);

    // 4. No remote at all — local main is the only base.
    noRemote = path.join(root, 'local');
    noRemoteWt = path.join(root, 'local-wt');
    init(noRemote);
    writeFileSync(path.join(noRemote, 'CLAUDE.md'), 'x\n');
    run(['add', '.'], noRemote);
    run(['commit', '-m', 'init'], noRemote);
    run(['worktree', 'add', noRemoteWt, '-b', 'feat/local'], noRemote);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('detects the linked worktree and the stale root instruction file', () => {
    const f = gatherFacts(wt);
    expect(f.isLinkedWorktree).toBe(true);
    expect(f.branch).toBe('feat/stale');
    expect(f.baseRef).toBe('origin/main');
    expect(f.behind).toBe(1);
    expect(f.staleFiles).toEqual(['CLAUDE.md']);
    expect(assessWorktree(f).level).toBe('warn');
  });

  it('detects a stale instruction file in a SUBDIRECTORY', () => {
    const f = gatherFacts(nestedWt);
    expect(f.staleFiles).toEqual(['apps/web/CLAUDE.md']);
    expect(assessWorktree(f).summary).toContain('apps/web/CLAUDE.md');
  });

  it('finds it from a subdirectory session too, despite diff.relative', () => {
    run(['config', 'diff.relative', 'true'], nested);
    expect(gatherFacts(path.join(nestedWt, 'apps')).staleFiles).toEqual(['apps/web/CLAUDE.md']);
    run(['config', '--unset', 'diff.relative'], nested);
  });

  it('uses origin/HEAD so a develop-default repo is not falsely alarmed', () => {
    const f = gatherFacts(developWt);
    expect(f.baseRef).toBe('origin/develop');
    expect(assessWorktree(f).level).toBe('ok');
  });

  it('falls back to a local base branch when there is no remote', () => {
    const f = gatherFacts(noRemoteWt);
    expect(f.baseRef).toBe('main');
    expect(assessWorktree(f).level).toBe('ok');
  });

  it('resolveBaseRef prefers the actual default branch over origin/main', () => {
    expect(resolveBaseRef(developWt)).toBe('origin/develop');
  });

  it('does NOT flag the primary checkout', () => {
    expect(gatherFacts(work).isLinkedWorktree).toBe(false);
  });

  it('does not count a deliberate local edit as staleness', () => {
    writeFileSync(path.join(wt, 'AGENTS.md'), 'my own new file\n');
    run(['add', 'AGENTS.md'], wt);
    run(['commit', '-m', 'local agents file'], wt);
    expect(gatherFacts(wt).staleFiles).toEqual(['CLAUDE.md']);
  });

  it('reports a non-repo directory as not-a-worktree rather than unknown', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
    expect(gatherFacts(plain).isLinkedWorktree).toBe(false);
    rmSync(plain, { recursive: true, force: true });
  });

  it('reports UNKNOWN, not clean, when the git environment is poisoned', () => {
    // The tkt-fbc74a3252fe shape: a malformed GIT_CONFIG_PARAMETERS makes every
    // git invocation fail. Silence here would disable the hook entirely.
    const r = runHook(wt, { GIT_CONFIG_PARAMETERS: "'--broken" });
    expect(r.status).toBe(0);
    expect(r.stdout, 'poisoned git must not be silent').not.toBe('');
    const out = JSON.parse(r.stdout);
    expect(out.systemMessage).toContain('did not run');
  });

  describe('entrypoint end to end', () => {
    it('prints nothing from a primary checkout', () => {
      const r = runHook(work);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('prints a valid SessionStart payload naming the stale file', () => {
      const r = runHook(wt);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.systemMessage).toContain('CLAUDE.md');
    });

    it('honours payload.cwd over the process cwd', () => {
      // Run FROM the primary checkout but point payload.cwd at the worktree.
      const r = runHook(work, {}, JSON.stringify({ cwd: wt }));
      expect(JSON.parse(r.stdout).systemMessage).toContain('CLAUDE.md');
    });

    it('warns about an unparseable threshold even when otherwise clean', () => {
      const r = runHook(developWt, { WORKTREE_STALE_THRESHOLD: 'abc' });
      expect(r.stdout).not.toBe('');
      expect(JSON.parse(r.stdout).systemMessage).toContain('not a non-negative number');
    });

    it('treats threshold 0 as always-warn rather than falling back to 15', () => {
      const r = runHook(developWt, { WORKTREE_STALE_THRESHOLD: '0' });
      expect(r.stdout, 'threshold 0 must warn').not.toBe('');
    });

    it('still runs when invoked through a symlink', () => {
      const link = path.join(root, 'linked-hook.mjs');
      symlinkSync(HOOK, link);
      const r = spawnSync(process.execPath, [link], { cwd: wt, input: '{}', encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout, 'symlinked hook must still run').not.toBe('');
    });

    it('exits 0 even on garbage stdin', () => {
      const r = runHook(wt, {}, 'not json at all');
      expect(r.status).toBe(0);
    });
  });
});

describe('constants', () => {
  it('covers the instruction files an agent actually reads', () => {
    expect(INSTRUCTION_FILES).toContain('CLAUDE.md');
  });
});
