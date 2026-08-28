import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Packaging + execution contract for hooks/ (tkt-93e9bc5595b4).
 *
 * `guard-review-target.mjs` was wired machine-wide while being absent from `files`, so it shipped in
 * no installed copy at all — and nothing failed, because every existing test asserts a NAMED hook.
 * This file asserts the CLASS instead: whatever lives in hooks/ must be packaged, exported, and must
 * actually RUN when executed as a script — both directly and through a symlink.
 *
 * The execution half is not redundant with the packaging half. Deleting track-steps.mjs's
 * `if (isMain(...)) main()` tail left the entire 467-case suite green (control: the same mutation on
 * guard-bash.mjs turned 7 assertions red), because exporting `main` and CALLING it are different
 * claims. A telemetry hook that silently records nothing is the exact failure this catches.
 */

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(HOOKS_DIR, '..');
const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

/** Every shipped .mjs under hooks/, recursively — nested lib/ files are shipped too, and a file that
 *  is imported but unpackaged is the original bug wearing a different hat. */
function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
    return e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') ? [rel] : [];
  });
}

const allFiles = walk(HOOKS_DIR).sort();
const hookFiles = allFiles.filter((f) => !f.includes('/')); // the entrypoints; lib/ is internal

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const TICKET = 'tkt-abcdef123456';

/**
 * One probe per hook: a payload that forces an OBSERVABLE effect, so "the hook ran" is
 * distinguishable from "the module loaded and did nothing". An empty payload exits 0 on every hook,
 * which is why the naive version of this test could not have caught the deleted tail.
 */
let fixtures;
const PROBES = {
  'guard-bash.mjs': () => ({
    payload: { tool_name: 'Bash', tool_input: { command: 'git add -A' } },
    check: (r) => expect(r.status, r.stderr).toBe(2),
  }),
  'guard-ticket.mjs': () => ({
    payload: { tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } },
    check: (r) => expect(r.status, r.stderr).toBe(2),
  }),
  'guard-review-target.mjs': () => ({
    payload: {}, // decide() fails closed on a payload carrying no command name
    check: (r) => expect(r.status, r.stderr).toBe(2),
  }),
  'guard-subagent-gates.mjs': () => ({
    // agent_id present == inside a subagent; the rule only exists there, so an empty payload (which
    // exits 0) could not tell a wired hook from a dead one.
    payload: { tool_name: 'Bash', tool_input: { command: 'gh pr merge 40 --squash' }, agent_id: 'a1' },
    check: (r) => expect(r.status, r.stderr).toBe(2),
  }),
  'track-steps.mjs': () => ({
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm run typecheck' },
      tool_response: {},
      cwd: fixtures.repo,
    },
    env: { EVENTS_DIR_OVERRIDE: mkdtempSync(path.join(tmpdir(), 'tw-events-')) },
    // Exit code says nothing here (telemetry always exits 0) — the written file is the only proof.
    check: (r, env) => expect(existsSync(path.join(env.EVENTS_DIR_OVERRIDE, `${TICKET}.jsonl`)), 'no event file written').toBe(true),
  }),
  'warn-stale-worktree.mjs': () => ({
    payload: {},
    cwd: fixtures.worktree,
    env: { WORKTREE_STALE_THRESHOLD: '1' },
    check: (r) => expect(r.stdout).toContain('STALE'),
  }),
};

function runHook(file, spec, dir) {
  const env = { ...process.env, ...(spec.env ?? {}) };
  const r = spawnSync('node', [path.join(dir, file)], {
    input: JSON.stringify(spec.payload),
    cwd: spec.cwd ?? PKG_DIR,
    env,
    encoding: 'utf8',
  });
  return { ...r, env };
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-pkg-'));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'wt');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(path.join(repo, 'CLAUDE.md'), 'v1\n');
  git(['add', 'CLAUDE.md'], repo);
  git(['commit', '-qm', 'init'], repo);

  // A linked worktree that is genuinely behind main, with an instruction file changed on main —
  // the only state in which warn-stale-worktree has anything to say.
  git(['worktree', 'add', '-q', '-b', 'side', worktree], repo);
  writeFileSync(path.join(repo, 'CLAUDE.md'), 'v2 changed\n');
  git(['add', 'CLAUDE.md'], repo);
  git(['commit', '-qm', 'change'], repo);

  // track-steps only records on a branch carrying a ticket id.
  git(['switch', '-qc', `feat/${TICKET}-x`], repo);

  // A symlinked copy of every hook: pnpm and `npm link` both symlink node_modules/<pkg>, which is
  // precisely the installed-consumer path these subpath exports exist to enable.
  const links = path.join(root, 'links');
  mkdirSync(links);
  for (const f of hookFiles) symlinkSync(path.join(HOOKS_DIR, f), path.join(links, f));

  fixtures = { repo, worktree, links };
});

describe('hooks/ packaging contract', () => {
  // If the walk ever matches nothing, every assertion below passes vacuously.
  it('found the hooks to check', () => {
    expect(hookFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(allFiles)('%s is listed in package.json files', (file) => {
    expect(pkg.files).toContain(`hooks/${file}`);
  });

  it.each(hookFiles)('%s is reachable through the exports map', (file) => {
    expect(pkg.exports[`./hooks/${file}`]).toBe(`./hooks/${file}`);
  });

  it.each(hookFiles)('%s exports a callable main', async (file) => {
    const mod = await import(pathToFileURL(path.join(HOOKS_DIR, file)).href);
    expect(typeof mod.main).toBe('function');
  });

  // An explicit list, never a glob: `./hooks/*` would export the .test.mjs files too, and the point
  // of this map is that the shipped surface is auditable by reading it.
  it('exports no test files, and uses no wildcard', () => {
    const keys = Object.keys(pkg.exports);
    // Pinned OUTSIDE the loop: an emptied `exports` map contains no wildcard and no test file, so it
    // satisfies every assertion below while exporting nothing at all. The count is the real claim —
    // one subpath per hook, plus the root entry, and no fourth kind of export nobody reviewed.
    expect(keys).toHaveLength(hookFiles.length + 1);
    for (const key of keys) {
      expect(key).not.toContain('*');
      expect(key).not.toContain('.test.');
    }
  });

  // `files` and `exports` are separate lists that must agree: a file exported but unpackaged
  // resolves to nothing at the consumer, which is the same silent absence in a new disguise.
  it('exports nothing it does not also ship', () => {
    const exported = Object.keys(pkg.exports).filter((k) => k.startsWith('./hooks/'));
    // Same pin, and it adds a claim the per-hook cases above cannot make: they assert each hook IS
    // exported, this asserts nothing ELSE is — an export for a deleted hook resolves to nothing.
    expect(exported).toHaveLength(hookFiles.length);
    for (const key of exported) expect(pkg.files).toContain(key.slice(2));
  });

  it('still exports the root entry', () => {
    expect(pkg.exports['.']).toMatchObject({ default: './dist/index.js' });
  });
});

describe('hooks/ direct-execution contract', () => {
  // Class-level: a new hook with no probe fails here rather than going silently unexercised.
  it('every hook has an execution probe', () => {
    expect(Object.keys(PROBES).sort()).toEqual([...hookFiles].sort());
  });

  // `spec.check` is where the observable effect is asserted, so these two blocks carry no visible
  // `expect` of their own. That is not merely a probe artifact: a PROBES entry whose `check` forgot to
  // assert would pass in silence — the same "exits 0 having done nothing" defect this file exists to
  // catch, one level down. Asserting the check EXISTS is the guard against that.
  it.each(hookFiles)('%s runs when executed directly', (file) => {
    const spec = PROBES[file]();
    expect(spec.check, `${file} has a probe with no check`).toBeTypeOf('function');
    const r = runHook(file, spec, HOOKS_DIR);
    spec.check(r, r.env);
  });

  // The realpath comparison in lib/is-main.mjs is what makes this pass. With the naive
  // `import.meta.url === pathToFileURL(process.argv[1]).href`, Node realpaths the ESM entry point
  // but not argv[1], so the check is false through a symlink: the guard exits 0 in silence, which
  // the hook protocol reads as ALLOW. Measured before the fix — guard-bash exited 0 on a `git add -A`
  // payload that exits 2 directly.
  it.each(hookFiles)('%s runs identically through a symlink', (file) => {
    const spec = PROBES[file]();
    expect(spec.check, `${file} has a probe with no check`).toBeTypeOf('function');
    const r = runHook(file, spec, fixtures.links);
    spec.check(r, r.env);
  });
});
