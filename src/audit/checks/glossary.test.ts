import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { glossaryStub } from '../../templates.js';
import { AUDIT_CHECKS, auditExitCode, runOneCheck } from '../run.js';
import { GLOSSARY_LINE_CAP } from './glossary.js';
import { lineCount } from './skills.js';

const ID = 'glossary-line-cap';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-glossary-'));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'core', exempt: {} }));
  return dir;
}

function write(dir: string, lines: number): void {
  writeFileSync(path.join(dir, 'GLOSSARY.md'), 'x\n'.repeat(lines));
}

function check(dir: string): { status: string; detail: string } {
  const r = runOneCheck(dir, ID);
  if (!r) throw new Error(`${ID} not applicable`);
  return r;
}

describe('glossary-line-cap', () => {
  it(`passes at exactly ${GLOSSARY_LINE_CAP} lines and fails at ${GLOSSARY_LINE_CAP + 1}, naming the file and count`, () => {
    const dir = repo();
    write(dir, GLOSSARY_LINE_CAP);
    expect(check(dir).status).toBe('pass');
    write(dir, GLOSSARY_LINE_CAP + 1);
    const r = check(dir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`GLOSSARY.md (${GLOSSARY_LINE_CAP + 1})`);
  });

  it('passes with nothing to measure when GLOSSARY.md is absent', () => {
    const r = check(repo());
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('no GLOSSARY.md to measure');
  });

  it('passes an empty GLOSSARY.md', () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'GLOSSARY.md'), '');
    expect(check(dir).status).toBe('pass');
  });

  it('measures a symlinked GLOSSARY.md through the link', () => {
    const dir = repo();
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'docs', 'terms.md'), 'x\n'.repeat(GLOSSARY_LINE_CAP + 5));
    symlinkSync(path.join(dir, 'docs', 'terms.md'), path.join(dir, 'GLOSSARY.md'));
    expect(check(dir).status).toBe('fail');
  });

  it('BLOCKS rather than passing when GLOSSARY.md cannot be read', () => {
    const dir = repo();
    write(dir, GLOSSARY_LINE_CAP + 80);
    const file = path.join(dir, 'GLOSSARY.md');
    chmodSync(file, 0o000);
    try {
      const r = check(dir);
      expect(r.status, r.detail).toBe('blocked');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('BLOCKS when GLOSSARY.md is a directory', () => {
    const dir = repo();
    mkdirSync(path.join(dir, 'GLOSSARY.md'));
    expect(check(dir).status).toBe('blocked');
  });

  it('the shipped stub is within the cap', () => {
    expect(lineCount(glossaryStub())).toBeLessThanOrEqual(GLOSSARY_LINE_CAP);
  });

  it('is advisory: a FAIL never moves the audit exit code', () => {
    expect(AUDIT_CHECKS.find((c) => c.id === ID)?.advisory).toBe(true);
    const dir = repo();
    write(dir, GLOSSARY_LINE_CAP + 1);
    const r = runOneCheck(dir, ID);
    expect(r?.status).toBe('fail');
    expect(auditExitCode({ repoDir: dir, tier: 'core', tierDeclared: true, results: r ? [r] : [] })).toBe(0);
    // Control: the same FAIL marked gating does move it, so the 0 above is the flag's doing.
    expect(auditExitCode({ repoDir: dir, tier: 'core', tierDeclared: true, results: r ? [{ ...r, advisory: false }] : [] })).not.toBe(0);
  });
});
