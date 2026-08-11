import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assessWorktree,
  formatReport,
  gatherFacts,
  INSTRUCTION_FILES,
  DEFAULT_THRESHOLD,
} from './warn-stale-worktree.mjs';

const worktree = (over = {}) => ({
  isLinkedWorktree: true,
  branch: 'feat/x',
  behind: 0,
  staleFiles: [],
  baseRef: 'origin/main',
  ...over,
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

  it('honours a custom threshold', () => {
    expect(assessWorktree(worktree({ behind: 5, threshold: 3 })).level).toBe('warn');
    expect(assessWorktree(worktree({ behind: 5, threshold: 50 })).level).toBe('ok');
  });

  // The fail-open regression this hook exists to avoid. "Could not check" must
  // never render as "nothing to report" — if these ever return 'ok', a broken
  // git environment silently disables the whole warning.
  it('reports LOUDLY, not ok, when the base ref cannot be resolved', () => {
    const a = assessWorktree(worktree({ baseRef: null, behind: null }));
    expect(a.level).toBe('unknown');
    expect(a.level).not.toBe('ok');
    expect(formatReport(a)).not.toBeNull();
    expect(a.lines.join(' ')).toContain('NOT checked');
  });

  it('reports LOUDLY, not ok, when the commit distance cannot be computed', () => {
    const a = assessWorktree(worktree({ behind: null }));
    expect(a.level).toBe('unknown');
    expect(a.level).not.toBe('ok');
    expect(a.lines.join(' ')).toContain('NOT checked');
  });

  it('never claims an exact figure — the local base ref is a floor', () => {
    const a = assessWorktree(worktree({ behind: 20 }));
    expect(a.lines.join(' ')).toContain('floor');
  });

  it('calls a detached worktree detached rather than "on HEAD"', () => {
    for (const branch of ['HEAD', null]) {
      const a = assessWorktree(worktree({ branch, behind: 20 }));
      expect(a.summary).toContain('detached worktree');
      expect(a.summary).not.toContain("'HEAD'");
    }
  });

  it('pluralises stale-file wording', () => {
    expect(assessWorktree(worktree({ behind: 1, staleFiles: ['CLAUDE.md'] })).lines.join(' ')).toContain(
      'copy here is STALE',
    );
    expect(
      assessWorktree(worktree({ behind: 1, staleFiles: ['CLAUDE.md', 'AGENTS.md'] })).lines.join(' '),
    ).toContain('copies here are STALE');
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

// gatherFacts is where the git plumbing lives, so it is exercised against a real
// repo with a real linked worktree rather than mocked. Without this, every test
// above could pass while the hook detected nothing in practice.
describe('gatherFacts against a real worktree', () => {
  let root, work, wt;
  const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wt-stale-'));
    const origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    wt = path.join(root, 'wt');
    mkdirSync(origin);
    run(['init', '--bare', '--initial-branch=main', '.'], origin);
    run(['clone', origin, work], root);
    const cfg = [
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
    ];
    for (const c of cfg) run(c, work);
    writeFileSync(path.join(work, 'CLAUDE.md'), 'original instructions\n');
    run(['add', 'CLAUDE.md'], work);
    run(['commit', '-m', 'init'], work);
    run(['push', '-u', 'origin', 'main'], work);

    // Branch the worktree off main BEFORE main moves, then move main.
    run(['worktree', 'add', wt, '-b', 'feat/stale'], work);
    writeFileSync(path.join(work, 'CLAUDE.md'), 'REWRITTEN instructions\n');
    run(['commit', '-am', 'rewrite instructions'], work);
    run(['push', 'origin', 'main'], work);
    run(['fetch', 'origin'], work);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('detects the linked worktree and the stale instruction file', () => {
    const f = gatherFacts(wt);
    expect(f.isLinkedWorktree).toBe(true);
    expect(f.branch).toBe('feat/stale');
    expect(f.baseRef).toBe('origin/main');
    expect(f.behind).toBe(1);
    expect(f.staleFiles).toEqual(['CLAUDE.md']);
    expect(assessWorktree(f).level).toBe('warn');
  });

  it('does NOT flag the primary checkout', () => {
    expect(gatherFacts(work).isLinkedWorktree).toBe(false);
  });

  it('does not count a local edit to CLAUDE.md as staleness', () => {
    // Intentional local edits are not drift — the diff is merge-base..baseRef,
    // not against the working tree. A ticket that edits CLAUDE.md on purpose
    // (as tkt-6321b5b79986 did) must not trip its own warning.
    writeFileSync(path.join(wt, 'AGENTS.md'), 'my own new file\n');
    run(['add', 'AGENTS.md'], wt);
    run(['commit', '-m', 'local agents file'], wt);
    expect(gatherFacts(wt).staleFiles).toEqual(['CLAUDE.md']);
  });

  it('reports non-repo directories as not-a-worktree rather than throwing', () => {
    expect(gatherFacts(tmpdir()).isLinkedWorktree).toBe(false);
  });
});

describe('constants', () => {
  it('covers the instruction files an agent actually reads', () => {
    expect(INSTRUCTION_FILES).toContain('CLAUDE.md');
  });
});
