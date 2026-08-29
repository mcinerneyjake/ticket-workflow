import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { guardrailTemplates, type GuardrailTier } from '../templates.js';
import { runAudit, auditExitCode, type AuditReport } from '../audit/run.js';
import { CONFIG_FILE } from '../audit/config.js';
import { readRepoFile, type Exec, defaultExec } from '../audit/types.js';

export interface InitResult {
  readonly targetDir: string;
  readonly tier: GuardrailTier;
  readonly wrote: readonly string[];
  /** Existed already and was deliberately left alone (package.json is never overwritten). */
  readonly preserved: readonly string[];
  readonly report: AuditReport;
  /** 2 on any gating FAIL; 1 on a gating BLOCKED outside the known fresh-scaffold set (a crashed
   *  check or a missing tool must not read as a healthy scaffold); 0 otherwise. */
  readonly exitCode: number;
  readonly humanSteps: readonly string[];
}

/** The BLOCKEDs a correct fresh scaffold produces: no node_modules yet (eslint, tsc, and the guard
 *  the launcher imports) and no remote yet (branch protection). An allowlist by id — anything else
 *  BLOCKED moves init's exit code. `hook-launcher` is here because the audit now EXECUTES the
 *  launcher: before `npm install` it correctly blocks everything, which is unverifiable rather than
 *  conformant, and must not read as a PASS. */
export const EXPECTED_FRESH_BLOCKED: ReadonlySet<string> = new Set(['eslint-rules', 'tsconfig-strict', 'branch-protection', 'hook-launcher']);

/** See the tolerance narrowing in runInit. Pinned against the check's own details by init.test.ts. */
export const LAUNCHER_ENV_NOT_READY: readonly string[] = ['cannot load the guard', 'node is not on PATH'];

export const GATE_SCRIPTS = {
  typecheck: 'tsc -p tsconfig.json',
  lint: 'eslint .',
  test: 'vitest run',
  'test:coverage': 'vitest run --coverage',
  // NOT the typecheck command again: the scaffolded tsconfig sets noEmit, so a build that just runs
  // `tsc -p` exits 0 having emitted nothing — a green build step proving nothing about the artifact.
  build: 'tsc -p tsconfig.json --noEmit false --outDir dist',
  // `prepare` is what arms the husky hooks on npm install — without it the committed pre-commit
  // file is never wired into git and the local gate silently does not exist.
  prepare: 'husky',
};

// `latest` on purpose: hand-picked majors go stale in a template and break the first install years
// later; the scaffold's first `npm install` resolves current and the lockfile pins from then on.
const DEV_DEPS = ['@eslint/js', 'eslint', 'typescript-eslint', 'globals', 'typescript', 'vitest', '@vitest/coverage-v8', 'husky'];

// Loud on failure, like guardrailTemplates: silently emitting an UNPINNED github: dependency would
// float the scaffold on default-branch HEAD, defeating the pinned-tag contract without a trace.
function selfVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  throw new Error('init: could not read this package\'s own version — refusing to emit an unpinned ticket-workflow dependency');
}

function starterPackageJson(targetDir: string, version: string): string {
  const name = path
    .basename(targetDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  return `${JSON.stringify(
    {
      name: name || 'new-repo',
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      scripts: GATE_SCRIPTS,
      devDependencies: Object.fromEntries(DEV_DEPS.map((d) => [d, 'latest'])),
      // The guard-bash launcher imports ticket-workflow/hooks/… and fails CLOSED without it — this
      // dependency is what keeps a fresh clone guarded rather than wedged.
      dependencies: { 'ticket-workflow': `github:mcinerneyjake/ticket-workflow#v${version}` },
    },
    null,
    2,
  )}\n`;
}

type TargetState = 'missing' | 'replaceable' | 'hard';

/**
 * lstat, not read: a dangling symlink reads as ENOENT but writing "through" it creates a file
 * OUTSIDE the target repo, and a live symlink must be replaced (rm the link), never followed.
 * A directory at the path — or a non-directory ancestor — is a conflict --force cannot fix.
 */
function classifyTarget(targetDir: string, rel: string): TargetState {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const ancestor = path.join(targetDir, ...parts.slice(0, i));
    try {
      if (!lstatSync(ancestor).isDirectory()) return 'hard';
    } catch {
      break; // ancestor missing → everything below it is missing too
    }
  }
  try {
    const st = lstatSync(path.join(targetDir, rel));
    return st.isDirectory() ? 'hard' : 'replaceable';
  } catch {
    return 'missing';
  }
}

export function runInit(
  targetDirInput: string,
  opts: { tier?: GuardrailTier; force?: boolean } = {},
  exec: Exec = defaultExec,
): InitResult {
  const targetDir = path.resolve(targetDirInput);
  const tier = opts.tier ?? 'node';
  const templates = guardrailTemplates(undefined, tier);

  // Conflicts are collected BEFORE anything is written: a partial scaffold that stopped at file 7
  // leaves a repo that looks initialized and is not.
  const plannedTargets = [...templates.map((t) => t.targetPath), CONFIG_FILE];
  const states = plannedTargets.map((rel) => ({ rel, state: classifyTarget(targetDir, rel) }));
  const hard = states.filter((s) => s.state === 'hard').map((s) => s.rel);
  if (hard.length > 0) {
    throw new Error(
      `cannot scaffold over: ${hard.join(', ')} — a directory sits at a template path (or a file blocks a parent directory); --force cannot fix this, move it aside first`,
    );
  }
  const replaceable = states.filter((s) => s.state === 'replaceable').map((s) => s.rel);
  if (replaceable.length > 0 && opts.force !== true) {
    throw new Error(
      `refusing to overwrite existing file(s): ${replaceable.join(', ')} — re-run with --force to overwrite them (package.json is never overwritten)`,
    );
  }

  const version = selfVersion();
  const wrote: string[] = [];
  const preserved: string[] = [];
  for (const t of templates) {
    const target = path.join(targetDir, t.targetPath);
    mkdirSync(path.dirname(target), { recursive: true });
    // rm-then-write replaces a symlink ITSELF; a bare write would follow it and clobber whatever it
    // points at, anywhere on disk.
    rmSync(target, { force: true });
    writeFileSync(target, t.contents);
    // The execute bit is part of the contract, not a nicety: git silently IGNORES a non-executable
    // .husky/pre-commit, which is a local gate that reports itself installed and never runs.
    if (t.executable) chmodSync(target, 0o755);
    wrote.push(t.targetPath);
  }
  const configTarget = path.join(targetDir, CONFIG_FILE);
  rmSync(configTarget, { force: true });
  writeFileSync(configTarget, `${JSON.stringify({ tier, exempt: {} }, null, 2)}\n`);
  wrote.push(CONFIG_FILE);

  if (tier === 'node') {
    if (readRepoFile(targetDir, 'package.json').kind === 'missing') {
      writeFileSync(path.join(targetDir, 'package.json'), starterPackageJson(targetDir, version));
      wrote.push('package.json');
    } else {
      preserved.push('package.json');
    }
  }

  const report = runAudit(targetDir, exec);
  // Tolerance for `hook-launcher` is narrowed from its id to the two ENVIRONMENT-not-ready reasons:
  // the launcher cannot load its guard yet, or node is not on PATH. Everything else that blocks it —
  // a spawn error, no exit code, or a launcher init JUST WROTE that cannot be read — says something
  // is wrong with the scaffold itself, and exiting 0 there reports a repo verified that never was.
  // The phrasings are coupling, so init.test.ts pins them against the check's real output.
  const tolerable = new Set(EXPECTED_FRESH_BLOCKED);
  const launcher = report.results.find((r) => r.id === 'hook-launcher');
  if (launcher?.status === 'blocked' && !LAUNCHER_ENV_NOT_READY.some((phrase) => launcher.detail.includes(phrase))) {
    tolerable.delete('hook-launcher');
  }
  const gating = report.results.filter((r) => !r.advisory);
  const blocked = gating.filter((r) => r.status === 'blocked');
  const isGitRepo = classifyTarget(targetDir, '.git') !== 'missing';

  const humanSteps: string[] = [];
  if (!isGitRepo) {
    // First, and non-negotiable: husky's prepare hook prints ".git can't be found" and exits ZERO
    // outside a git repo, so npm-install-then-git-init leaves the pre-commit gate silently unarmed
    // while the audit (which only reads the file) reports it present.
    humanSteps.push('run `git init` BEFORE `npm install` — husky arms hooks only inside a git repo, and skipping it exits 0 silently');
  }
  if (preserved.includes('package.json')) {
    humanSteps.push(
      `package.json existed and was left alone — ensure it declares the gate scripts (${Object.keys(GATE_SCRIPTS).join(', ')}), their devDependencies, and a ticket-workflow dependency`,
    );
  }
  if (tier === 'node') {
    humanSteps.push(
      `run \`npm install\` — it resolves the toolchain and (via prepare: husky) arms the pre-commit gate, then re-run \`ticket-workflow audit .\` (the ticket-workflow pin references v${version}; if that tag is not pushed yet, adjust the pin)`,
    );
  } else {
    humanSteps.push(
      'edit .github/workflows/ci.yml — its `gate` job runs the npm toolchain; replace those steps with your stack\'s gate commands BEFORE requiring the check, or every PR wedges on a check that can never pass',
      // A core repo has no package.json, so the `npm install` remediation the audit prints for a
      // blocked launcher has no route here: the machine-local install is the only one.
      'install the guard machine-locally (`~/.claude/tools`, holding the ticket-workflow package) — the core launcher\'s second candidate reads it, and at this tier there is no repo-local `npm install` to satisfy the first',
    );
  }
  humanSteps.push(
    'push to GitHub and protect the default branch: require a PR + status checks [gate, branch-name], with no bypass',
    'hook ARMING is machine-local (~/.claude) and can never be verified from this repo — run `ticket-workflow doctor` on each machine that works here',
  );
  for (const b of blocked) humanSteps.push(`unblock \`${b.id}\`: ${b.detail}`);

  return { targetDir, tier, wrote, preserved, report, exitCode: auditExitCode(report, tolerable), humanSteps };
}
