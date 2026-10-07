import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardrailTemplates } from '../../templates.js';
import { AUDIT_CHECKS, auditExitCode, runOneCheck } from '../run.js';
import { CLAUDE_MD_LINE_CAP } from './claudeMd.js';
import { lineCount } from './skills.js';

const ID = 'claude-md-line-cap';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-claudemd-'));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'core', exempt: {} }));
  return dir;
}

function write(dir: string, rel: string, lines: number): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), 'x\n'.repeat(lines));
}

function check(dir: string): { status: string; detail: string } {
  const r = runOneCheck(dir, ID);
  if (!r) throw new Error(`${ID} not applicable`);
  return r;
}

describe('claude-md-line-cap', () => {
  it(`passes at exactly ${CLAUDE_MD_LINE_CAP} lines and fails at ${CLAUDE_MD_LINE_CAP + 1}, naming the file and count`, () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', CLAUDE_MD_LINE_CAP);
    expect(check(dir).status).toBe('pass');
    write(dir, 'CLAUDE.md', CLAUDE_MD_LINE_CAP + 1);
    const r = check(dir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`CLAUDE.md (${CLAUDE_MD_LINE_CAP + 1})`);
  });

  it('fails on an oversized .claude/CLAUDE.md beside a compliant root file', () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', 10);
    write(dir, '.claude/CLAUDE.md', CLAUDE_MD_LINE_CAP + 40);
    const r = check(dir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`.claude/CLAUDE.md (${CLAUDE_MD_LINE_CAP + 40})`);
    expect(r.detail).not.toContain('CLAUDE.md (10)');
  });

  it('names every oversized file, not just the first', () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', 200);
    write(dir, '.claude/CLAUDE.md', 61);
    const r = check(dir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('CLAUDE.md (200)');
    expect(r.detail).toContain('.claude/CLAUDE.md (61)');
  });

  it('measures a symlinked CLAUDE.md through the link', () => {
    const dir = repo();
    write(dir, 'docs/AGENTS.md', CLAUDE_MD_LINE_CAP + 5);
    symlinkSync(path.join(dir, 'docs', 'AGENTS.md'), path.join(dir, 'CLAUDE.md'));
    expect(check(dir).status).toBe('fail');
  });

  it('passes with nothing to measure when neither location exists', () => {
    const r = check(repo());
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('no CLAUDE.md or .claude/CLAUDE.md to measure');
  });

  it('passes an empty CLAUDE.md', () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'CLAUDE.md'), '');
    expect(check(dir).status).toBe('pass');
  });

  it('BLOCKS rather than passing when CLAUDE.md cannot be read', () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', CLAUDE_MD_LINE_CAP + 80);
    const file = path.join(dir, 'CLAUDE.md');
    chmodSync(file, 0o000);
    try {
      const r = check(dir);
      expect(r.status, r.detail).toBe('blocked');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('BLOCKS when CLAUDE.md is a directory', () => {
    const dir = repo();
    mkdirSync(path.join(dir, 'CLAUDE.md'));
    expect(check(dir).status).toBe('blocked');
  });

  it('an unreadable location does not hide an over-cap FAIL in the other', () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', CLAUDE_MD_LINE_CAP + 140);
    mkdirSync(path.join(dir, '.claude', 'CLAUDE.md'), { recursive: true });
    const r = check(dir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`CLAUDE.md (${CLAUDE_MD_LINE_CAP + 140})`);
    expect(r.detail).toContain('.claude/CLAUDE.md could not be read');
  });

  it('BLOCKS when the only over-cap candidate is unreadable, even beside a compliant file', () => {
    const dir = repo();
    write(dir, 'CLAUDE.md', 10);
    mkdirSync(path.join(dir, '.claude', 'CLAUDE.md'), { recursive: true });
    expect(check(dir).status).toBe('blocked');
  });

  it('the shipped CLAUDE.md template is within the cap', () => {
    const tpl = guardrailTemplates(undefined, 'core').find((t) => t.targetPath === 'CLAUDE.md');
    expect(tpl).toBeDefined();
    expect(lineCount(tpl?.contents ?? '')).toBeLessThanOrEqual(CLAUDE_MD_LINE_CAP);
  });

  it('is advisory: a FAIL never moves the audit exit code', () => {
    expect(AUDIT_CHECKS.find((c) => c.id === ID)?.advisory).toBe(true);
    const dir = repo();
    write(dir, 'CLAUDE.md', CLAUDE_MD_LINE_CAP + 1);
    const r = runOneCheck(dir, ID);
    expect(r?.status).toBe('fail');
    expect(auditExitCode({ repoDir: dir, tier: 'core', tierDeclared: true, results: r ? [r] : [] })).toBe(0);
    // Control: the same FAIL marked gating does move it, so the 0 above is the flag's doing.
    expect(auditExitCode({ repoDir: dir, tier: 'core', tierDeclared: true, results: r ? [{ ...r, advisory: false }] : [] })).not.toBe(0);
  });
});
