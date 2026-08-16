import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { guardrailTemplates } from './templates.js';

const REAL_TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

const tempDirs: string[] = [];
function tempCopyOfTemplates(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-templates-'));
  tempDirs.push(dir);
  cpSync(REAL_TEMPLATES_DIR, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('guardrailTemplates', () => {
  it('returns the full manifest with non-empty contents and unique target paths', () => {
    const templates = guardrailTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(12);
    const targets = templates.map((t) => t.targetPath);
    expect(new Set(targets).size).toBe(targets.length);
    for (const t of templates) {
      expect(t.contents.trim()).not.toBe('');
      expect(['core', 'node']).toContain(t.tier);
    }
  });

  it('covers every guardrail the standard names', () => {
    const targets = new Set(guardrailTemplates().map((t) => t.targetPath));
    for (const required of [
      'CLAUDE.md',
      '.gitignore',
      '.github/workflows/ci.yml',
      '.github/workflows/pr-branch-name.yml',
      '.github/dependabot.yml',
      '.claude/settings.json',
      '.claude/hooks/guard-bash.mjs',
      '.husky/pre-commit',
      'eslint.config.js',
      'tsconfig.json',
      'vitest.config.ts',
      '.nvmrc',
    ]) {
      expect(targets, `missing template for ${required}`).toContain(required);
    }
  });

  it('ships the hook as a fail-closed LAUNCHER, not a vendored guard', () => {
    const launcher = guardrailTemplates().find((t) => t.targetPath === '.claude/hooks/guard-bash.mjs');
    if (!launcher) throw new Error('launcher template missing');
    expect(launcher.contents).toContain("import('ticket-workflow/hooks/guard-bash.mjs')");
    expect(launcher.contents).toContain('process.exit(2)');
    // A vendored copy carries the guard's own logic; a launcher stays tiny.
    expect(launcher.contents.split('\n').length).toBeLessThan(40);
  });

  it('wires the launcher from settings.json at the path the launcher ships to', () => {
    const templates = guardrailTemplates();
    const settings = templates.find((t) => t.targetPath === '.claude/settings.json');
    if (!settings) throw new Error('settings template missing');
    const parsed: unknown = JSON.parse(settings.contents);
    expect(JSON.stringify(parsed)).toContain('.claude/hooks/guard-bash.mjs');
  });

  it('keeps templates user-agnostic and repo-agnostic (no /Users/ paths, no tkt- refs)', () => {
    for (const t of guardrailTemplates()) {
      expect(t.contents, `${t.targetPath} leaks a local path`).not.toContain('/Users/');
      // The branch-name workflow legitimately shows tkt- as the id FORMAT; ban refs elsewhere.
      if (t.targetPath !== '.github/workflows/pr-branch-name.yml') {
        expect(t.contents, `${t.targetPath} carries a ticket ref`).not.toMatch(/tkt-[a-z0-9]{6,}/);
      }
    }
  });

  it('ci.yml defines the literal job names the standard requires', () => {
    const templates = guardrailTemplates();
    const ci = templates.find((t) => t.targetPath === '.github/workflows/ci.yml');
    const branch = templates.find((t) => t.targetPath === '.github/workflows/pr-branch-name.yml');
    expect(ci?.contents).toMatch(/^\s{2}gate:$/m);
    expect(branch?.contents).toMatch(/^\s{2}branch-name:$/m);
  });

  it('pre-commit template carries the GIT_DIR scrub ahead of the gate', () => {
    const pre = guardrailTemplates().find((t) => t.targetPath === '.husky/pre-commit');
    if (!pre) throw new Error('pre-commit template missing');
    const scrubAt = pre.contents.indexOf('unset GIT_DIR');
    const gateAt = pre.contents.indexOf('npm run typecheck');
    expect(scrubAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(scrubAt);
  });

  it('marks .husky/pre-commit executable and nothing else — git silently ignores a non-executable hook', () => {
    const templates = guardrailTemplates();
    const executable = templates.filter((t) => t.executable).map((t) => t.targetPath);
    expect(executable).toEqual(['.husky/pre-commit']);
  });

  it('ci.yml pins actions by SHA, never by mutable tag', () => {
    const ci = guardrailTemplates().find((t) => t.targetPath === '.github/workflows/ci.yml');
    if (!ci) throw new Error('ci template missing');
    const uses = ci.contents.match(/uses:\s*\S+/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const u of uses) {
      expect(u, `${u} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('asserts the node-version sync the ci.yml comment promises: nvmrc == ci node-version', () => {
    const templates = guardrailTemplates();
    const nvmrc = templates.find((t) => t.targetPath === '.nvmrc');
    const ci = templates.find((t) => t.targetPath === '.github/workflows/ci.yml');
    const ciVersion = ci?.contents.match(/node-version:\s*'([^']+)'/)?.[1];
    expect(ciVersion).toBeDefined();
    expect(nvmrc?.contents.trim()).toBe(ciVersion);
  });

  it('every manifest source ships in the npm pack (files entry is live, not prose)', () => {
    const packJson = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    const parsed: Array<{ files: Array<{ path: string }> }> = JSON.parse(packJson);
    const packed = new Set(parsed[0].files.map((f) => f.path));
    for (const t of guardrailTemplates()) {
      expect(packed, `templates/${t.source} missing from npm pack`).toContain(`templates/${t.source}`);
    }
  });

  it('throws on a missing template file instead of returning a partial set', () => {
    const dir = tempCopyOfTemplates();
    rmSync(path.join(dir, 'core/gitignore'));
    expect(() => guardrailTemplates(dir)).toThrow(/could not be read/);
  });

  it('throws on an empty template file instead of scaffolding a blank guardrail', () => {
    const dir = tempCopyOfTemplates();
    writeFileSync(path.join(dir, 'node/nvmrc'), '\n');
    expect(() => guardrailTemplates(dir)).toThrow(/is empty/);
  });

  it('control: the untampered temp copy passes, so the two red cases above are the tamper, not the seam', () => {
    const dir = tempCopyOfTemplates();
    expect(guardrailTemplates(dir).length).toBeGreaterThanOrEqual(12);
  });
});
