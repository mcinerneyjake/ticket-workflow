import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardrailTemplates } from '../templates.js';
import { runInit, EXPECTED_FRESH_BLOCKED, GATE_SCRIPTS, LAUNCHER_ENV_NOT_READY } from './run.js';
import { parseInitArgs, cmdInit } from '../cli/index.js';
import type { Exec } from '../audit/types.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-init-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('init end-to-end: empty dir → scaffold → audit', () => {
  it('writes every template + config + starter package.json, and NOTHING gating FAILs', () => {
    const dir = tempDir();
    const result = runInit(dir);
    for (const t of guardrailTemplates()) {
      expect(existsSync(path.join(dir, t.targetPath)), `${t.targetPath} not written`).toBe(true);
    }
    expect(existsSync(path.join(dir, '.ticket-workflow.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);

    const gating = result.report.results.filter((r) => !r.advisory);
    const failed = gating.filter((r) => r.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    const blocked = gating.filter((r) => r.status === 'blocked').map((r) => r.id);
    for (const id of blocked) expect(EXPECTED_FRESH_BLOCKED, `unexpected BLOCKED: ${id}`).toContain(id);
    expect(result.exitCode).toBe(0);
  });

  it('a CRASHED check moves the exit code even under a tolerated id — not-run is not fresh-repo state', () => {
    const dir = tempDir();
    const crashingExec: Exec = (cmd) => {
      if (cmd === 'git') throw new Error('boom');
      return { kind: 'absent' };
    };
    const result = runInit(dir, {}, crashingExec);
    expect(result.exitCode).toBe(1);
  });

  it('control: an absent toolchain blocks only the tolerated fresh-repo checks and exits 0', () => {
    const dir = tempDir();
    const absentExec: Exec = () => ({ kind: 'absent' });
    const result = runInit(dir, {}, absentExec);
    expect(result.exitCode).toBe(0);
  });

  it('sets the execute bit exactly where the manifest demands it', () => {
    const dir = tempDir();
    runInit(dir);
    const preCommit = statSync(path.join(dir, '.husky', 'pre-commit'));
    expect(preCommit.mode & 0o111, '.husky/pre-commit is not executable — git ignores it silently').not.toBe(0);
    const claudeMd = statSync(path.join(dir, 'CLAUDE.md'));
    expect(claudeMd.mode & 0o111).toBe(0);
  });

  it('starter package.json carries every GATE_SCRIPT, prepare: husky, a distinct build, and the ticket-workflow pin', () => {
    const dir = tempDir();
    runInit(dir);
    const pkg: { scripts: Record<string, string>; dependencies: Record<string, string> } = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    // Derived from the same object the implementation writes — a transcribed list here goes stale.
    for (const s of Object.keys(GATE_SCRIPTS)) {
      expect(Object.keys(pkg.scripts), `script ${s} missing`).toContain(s);
    }
    expect(pkg.scripts.prepare).toBe('husky');
    // The scaffolded tsconfig sets noEmit, so a build identical to typecheck emits nothing while
    // exiting 0 — the CI template's separate build step would gate nothing.
    expect(pkg.scripts.build).not.toBe(pkg.scripts.typecheck);
    expect(pkg.scripts.build).toContain('--noEmit false');
    expect(pkg.dependencies['ticket-workflow']).toMatch(/^github:mcinerneyjake\/ticket-workflow#v\d+\.\d+\.\d+$/);
  });

  it('does not claim done: human steps lead with git init, then npm install, protection, arming', () => {
    const dir = tempDir();
    const result = runInit(dir);
    // git init FIRST: husky's prepare exits 0 outside a git repo, silently arming nothing.
    expect(result.humanSteps[0]).toContain('git init');
    const joined = result.humanSteps.join('\n');
    expect(joined).toContain('npm install');
    expect(joined).toContain('protect the default branch');
    expect(joined).toContain('machine-local');
    for (const id of EXPECTED_FRESH_BLOCKED) {
      const r = result.report.results.find((x) => x.id === id);
      if (r?.status === 'blocked') expect(joined).toContain(id);
    }
  });

  it('omits the git-init step when the target already is a git repo', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.git'));
    const result = runInit(dir);
    expect(result.humanSteps.join('\n')).not.toContain('git init');
  });
});

describe('init refuses to overwrite', () => {
  it('throws on any existing target and writes NOTHING — no partial scaffold', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'my precious instructions\n');
    expect(() => runInit(dir)).toThrow(/refusing to overwrite.*CLAUDE\.md/);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('my precious instructions\n');
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  });

  it('a DANGLING symlink at a target is a conflict, not a missing file — writing through it lands outside the repo', () => {
    const dir = tempDir();
    const outside = path.join(tempDir(), 'stolen.md');
    symlinkSync(outside, path.join(dir, 'CLAUDE.md'));
    expect(() => runInit(dir)).toThrow(/refusing to overwrite/);
    expect(existsSync(outside)).toBe(false);
  });

  it('--force replaces a live symlink ITSELF; the linked file elsewhere is untouched', () => {
    const dir = tempDir();
    const elsewhere = path.join(tempDir(), 'linked.md');
    writeFileSync(elsewhere, 'original elsewhere\n');
    symlinkSync(elsewhere, path.join(dir, 'CLAUDE.md'));
    runInit(dir, { force: true });
    expect(readFileSync(elsewhere, 'utf8')).toBe('original elsewhere\n');
    expect(lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
  });

  it('a DIRECTORY at a target path is refused even with --force, before anything is written', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.gitignore'));
    expect(() => runInit(dir, { force: true })).toThrow(/--force cannot fix/);
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('a FILE blocking a parent directory is refused even with --force, before anything is written', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.github'));
    writeFileSync(path.join(dir, '.github', 'workflows'), 'not a directory\n');
    expect(() => runInit(dir, { force: true })).toThrow(/--force cannot fix/);
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('--force overwrites template targets', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'old\n');
    const result = runInit(dir, { force: true });
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).not.toBe('old\n');
    expect(result.wrote).toContain('CLAUDE.md');
  });

  it('package.json is NEVER overwritten, even with --force', () => {
    const dir = tempDir();
    const original = JSON.stringify({ name: 'existing', scripts: { test: 'echo hi' } });
    writeFileSync(path.join(dir, 'package.json'), original);
    const result = runInit(dir, { force: true });
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(original);
    expect(result.preserved).toContain('package.json');
    const step = result.humanSteps.join('\n');
    // The instruction derives from GATE_SCRIPTS, so it names every script the contract requires.
    for (const s of Object.keys(GATE_SCRIPTS)) expect(step).toContain(s);
  });

  it('a second init without --force refuses — the first one is not silently redone', () => {
    const dir = tempDir();
    runInit(dir);
    expect(() => runInit(dir)).toThrow(/refusing to overwrite/);
  });
});

describe('init tiers', () => {
  it('core writes only core templates and no package.json', () => {
    const dir = tempDir();
    const result = runInit(dir, { tier: 'core' });
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
    expect(existsSync(path.join(dir, 'eslint.config.js'))).toBe(false);
    expect(existsSync(path.join(dir, '.husky'))).toBe(false);
    expect(existsSync(path.join(dir, 'package.json'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, '.ticket-workflow.json'), 'utf8'))).toMatchObject({ tier: 'core' });
    expect(result.tier).toBe('core');
  });

  it('core tier warns that the scaffolded gate is npm-shaped and must be edited before it is required', () => {
    const dir = tempDir();
    const result = runInit(dir, { tier: 'core' });
    const joined = result.humanSteps.join('\n');
    expect(joined).toContain('edit .github/workflows/ci.yml');
    const editAt = result.humanSteps.findIndex((s) => s.includes('edit .github/workflows/ci.yml'));
    const requireAt = result.humanSteps.findIndex((s) => s.includes('protect the default branch'));
    expect(editAt).toBeGreaterThanOrEqual(0);
    expect(editAt).toBeLessThan(requireAt);
  });
});

describe('cmdInit target sanity', () => {
  it('refuses a target that exists as a regular file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(() => cmdInit([file])).toThrow(/not a directory/);
  });

  it('refuses a nonexistent target whose PARENT is also missing — a typo, not a new repo', () => {
    const dir = tempDir();
    expect(() => cmdInit([path.join(dir, 'porjects', 'app')])).toThrow(/parent does not exist/);
  });
});

describe('parseInitArgs', () => {
  it('defaults to cwd + node tier', () => {
    expect(parseInitArgs([])).toEqual({ targetDir: '.', tier: 'node', force: false });
  });

  it('accepts path, --tier and --force in any order', () => {
    expect(parseInitArgs(['--force', 'some/dir', '--tier', 'core'])).toEqual({ targetDir: 'some/dir', tier: 'core', force: true });
  });

  it('rejects an unknown tier, unknown flags, and multiple paths', () => {
    expect(() => parseInitArgs(['--tier', 'python'])).toThrow(/core|node/);
    expect(() => parseInitArgs(['--froce'])).toThrow(/unknown option/);
    expect(() => parseInitArgs(['/a', '/b'])).toThrow(/at most one path/);
  });
});

/**
 * tkt-c4a4a79bec8a. `init --tier core` scaffolded the launcher whose only resolution path is a bare
 * specifier needing node_modules — which the core tier, by definition, never provides. Every core
 * repo was wedged, and the text-reading audit called it a PASS.
 */
describe('init --tier core scaffolds a launcher that tier can satisfy', () => {
  it('writes the two-candidate core launcher, not the node one', () => {
    const dir = tempDir();
    runInit(dir, { tier: 'core' });
    const launcher = readFileSync(path.join(dir, '.claude', 'hooks', 'guard-bash.mjs'), 'utf8');
    // Assert what only the CORE launcher has. Every earlier version of this test passed against the
    // node launcher too — it also contains '.claude', the marker and the bare specifier — so
    // repointing the core manifest entry at the node source, the exact regression this ticket
    // fixes, left the block green (tkt-c4a4a79bec8a review).
    expect(launcher, 'core launcher has no machine-local candidate').toContain('homedir');
    expect(launcher).toContain('.claude');
    expect(launcher).toContain('tools');
    expect(launcher).toContain("import('ticket-workflow/hooks/guard-bash.mjs')");
    const nodeLauncher = guardrailTemplates(undefined, 'node').find((t) => t.targetPath === '.claude/hooks/guard-bash.mjs');
    expect(launcher, 'core scaffold got the NODE launcher').not.toBe(nodeLauncher?.contents);
  });

  it('the scaffolded core repo is never INERT, and init exits 0 without hand-editing', () => {
    const dir = tempDir();
    const result = runInit(dir, { tier: 'core' });
    const launcher = result.report.results.find((r) => r.id === 'hook-launcher');
    // pass or blocked, never fail — and which one is a property of the MACHINE, not of the scaffold:
    // it passes where ~/.claude/tools holds the package and is blocked where it does not. Asserting
    // `pass` here would bind the suite to this machine's install; templates.test.ts proves the
    // discrimination deterministically instead, with HOME pinned.
    expect(['pass', 'blocked'], `core scaffold is inert: ${launcher?.detail}`).toContain(launcher?.status);
    expect(result.exitCode).toBe(0);
  });

  it('a core scaffold writes no node-tier template', () => {
    const dir = tempDir();
    runInit(dir, { tier: 'core' });
    for (const nodeOnly of ['.husky/pre-commit', 'eslint.config.js', 'tsconfig.json', 'vitest.config.ts', '.nvmrc']) {
      expect(existsSync(path.join(dir, nodeOnly)), `${nodeOnly} is node-tier and must not be scaffolded at core`).toBe(false);
    }
  });
});

/** tkt-c4a4a79bec8a review, finding 10: tolerance was by check id, so init exited 0 on BLOCKEDs that
 *  had nothing to do with a fresh scaffold. */
describe('init tolerates hook-launcher BLOCKED only when the environment is not ready', () => {
  it('the tolerated phrases are the ones the check actually emits — not prose that drifted', () => {
    // Coupling asserted, not commented: runInit matches these substrings against hookLauncher's
    // details, so a reworded detail must redden here rather than silently stop being tolerated.
    const dir = tempDir();
    const noNode: Exec = (cmd) => (cmd === 'node' ? { kind: 'absent' } : { kind: 'absent' });
    const blocked = runInit(dir, {}, noNode).report.results.find((r) => r.id === 'hook-launcher');
    expect(blocked?.status).toBe('blocked');
    expect(LAUNCHER_ENV_NOT_READY.some((p) => blocked?.detail.includes(p)), `untolerated detail: ${blocked?.detail}`).toBe(true);
  });

  it('a spawn ERROR is not fresh-scaffold state — init exits non-zero rather than reporting success', () => {
    const dir = tempDir();
    const spawnErr: Exec = (cmd) => (cmd === 'node' ? { kind: 'error', message: 'EACCES' } : { kind: 'absent' });
    const result = runInit(dir, {}, spawnErr);
    const blocked = result.report.results.find((r) => r.id === 'hook-launcher');
    expect(blocked?.status).toBe('blocked');
    expect(result.exitCode, 'a launcher that could not be spawned must not read as a healthy scaffold').toBe(1);
  });

  it('control: the ordinary fresh scaffold still exits 0 with the launcher blocked', () => {
    const dir = tempDir();
    const result = runInit(dir, {}, () => ({ kind: 'absent' }));
    expect(result.exitCode).toBe(0);
  });
});
