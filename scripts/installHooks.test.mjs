import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tkt-7aa8670dc01e. Git skips a missing `core.hooksPath` SILENTLY, and husky's `.husky/_` is generated
// and self-ignored, so a linked worktree had no hook and committed with no gate (commit 93365c3).
// The invariant: the hook git ACTUALLY resolves is tracked, relative and executable.

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'scripts', 'installHooks.mjs');
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function hermeticEnv(extra = {}) {
  const env = { ...process.env };
  for (const v of GIT_CONTEXT_VARS) delete env[v];
  delete env.HUSKY;
  return { ...env, ...extra };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: hermeticEnv() }).trim();

// Unset is a failure too: git then falls back to the untracked `.git/hooks`.
function configuredHooksPath(cwd) {
  const r = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd, encoding: 'utf8', env: hermeticEnv() });
  return r.status === 0 ? r.stdout.trim() : '';
}

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function tempRepo() {
  const dir = tempDir('tw-install-hooks-');
  git(['init', '-q', '-b', 'main'], dir);
  return dir;
}

const install = (cwd, env = {}) => spawnSync(process.execPath, [INSTALL], { cwd, encoding: 'utf8', env: hermeticEnv(env) });

describe('the pre-commit hook git will actually run in this repo', () => {
  const hooksPath = configuredHooksPath(REPO);
  const indexEntry = () => (hooksPath === '' || path.isAbsolute(hooksPath) ? '' : git(['ls-files', '-s', `${hooksPath}/pre-commit`], REPO));

  it('has a configured, RELATIVE hooks path, so every worktree resolves its own copy', () => {
    expect(hooksPath, 'core.hooksPath is unset — run npm install').not.toBe('');
    expect(path.isAbsolute(hooksPath)).toBe(false);
  });

  it('is TRACKED, so a fresh worktree has it with no npm install', () => {
    expect(indexEntry(), `${hooksPath}/pre-commit is not tracked — run npm install`).not.toBe('');
  });

  it('is executable in the index AND on disk', () => {
    expect(indexEntry().startsWith('100755 ')).toBe(true);
    expect(() => accessSync(path.join(REPO, hooksPath, 'pre-commit'), constants.X_OK)).not.toThrow();
  });

  it('is what prepare installs — husky itself would rewrite the path back to .husky/_', () => {
    const { scripts } = JSON.parse(git(['show', ':package.json'], REPO));
    expect(scripts.prepare).toMatch(/^node scripts\/installHooks\.mjs && /);
    expect(scripts.prepare).not.toMatch(/\bhusky\b/);
  });
});

describe('scripts/installHooks.mjs', () => {
  it('points a repo at the tracked .husky, replacing husky\'s generated .husky/_', () => {
    const dir = tempRepo();
    git(['config', 'core.hooksPath', '.husky/_'], dir);
    const r = install(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(configuredHooksPath(dir)).toBe('.husky');
  });

  it('is idempotent on a second run', () => {
    const dir = tempRepo();
    expect(install(dir).status).toBe(0);
    expect(install(dir).status).toBe(0);
    expect(configuredHooksPath(dir)).toBe('.husky');
  });

  it('installs from a linked worktree, whose .git is a file', () => {
    const dir = tempRepo();
    // CI runners carry no git identity, so a commit without one fails there only.
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], dir);
    const wt = path.join(dir, 'wt');
    git(['worktree', 'add', '-q', '--detach', wt], dir);
    const r = install(wt);
    expect(r.status, r.stderr).toBe(0);
    expect(configuredHooksPath(dir)).toBe('.husky');
  });

  it('never writes a PARENT repo\'s config from a subdirectory that is not a checkout root', () => {
    // A package directory nested in someone else's repo must not repoint that repo's hooks.
    const dir = tempRepo();
    git(['config', 'core.hooksPath', 'theirs'], dir);
    const nested = path.join(dir, 'vendor', 'pkg');
    mkdirSync(nested, { recursive: true });
    const r = install(nested);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not a git checkout root/);
    expect(configuredHooksPath(dir)).toBe('theirs');
  });

  it('ignores an ambient GIT_DIR naming a different repo', () => {
    const target = tempRepo();
    const bystander = tempRepo();
    const r = install(target, { GIT_DIR: path.join(bystander, '.git') });
    expect(r.status, r.stderr).toBe(0);
    expect(configuredHooksPath(target)).toBe('.husky');
    expect(configuredHooksPath(bystander)).toBe('');
  });

  it('skips, exit 0, outside any git repository — a failing prepare breaks npm install', () => {
    const dir = tempDir('tw-install-hooks-nogit-');
    const r = install(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not a git checkout root/);
  });

  it('honours HUSKY=0 without touching the config', () => {
    const dir = tempRepo();
    git(['config', 'core.hooksPath', '.husky/_'], dir);
    const r = install(dir, { HUSKY: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/HUSKY=0/);
    expect(configuredHooksPath(dir)).toBe('.husky/_');
  });

  it('fails LOUD when a per-worktree config shadows the value it wrote', () => {
    const dir = tempRepo();
    git(['config', 'extensions.worktreeConfig', 'true'], dir);
    git(['config', '--worktree', 'core.hooksPath', '.husky/_'], dir);
    const r = install(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reads \.husky\/_/);
  });

  it('fails LOUD, writing nothing, when a .git here resolves to an enclosing repo', () => {
    // An unusable `.git` makes git walk upward: skipping would report a gate that never runs, and
    // writing would repoint the enclosing repo.
    const dir = tempRepo();
    git(['config', 'core.hooksPath', 'theirs'], dir);
    const nested = path.join(dir, 'pkg');
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    const r = install(nested);
    expect(r.status).not.toBe(0);
    expect(configuredHooksPath(dir)).toBe('theirs');
  });
});
