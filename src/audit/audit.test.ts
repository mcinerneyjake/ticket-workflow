import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { guardrailTemplates } from '../templates.js';
import { runAudit, auditExitCode, formatAudit, AUDIT_CHECKS } from './run.js';
import { defaultExec, type Exec, type ExecResult } from './types.js';

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE_PKG = JSON.stringify({
  name: 'fixture',
  engines: { node: '>=24' },
  scripts: { typecheck: 'tsc -p tsconfig.json', lint: 'eslint .', test: 'vitest run', 'test:coverage': 'vitest run --coverage', build: 'tsc -p tsconfig.json' },
});

/** Recorded shape of a real `eslint --print-config` answer for a conforming config. */
const ESLINT_CONFORMING = JSON.stringify({
  rules: {
    '@typescript-eslint/no-explicit-any': [2],
    '@typescript-eslint/no-non-null-assertion': [2],
    '@typescript-eslint/consistent-type-assertions': [2, { assertionStyle: 'never' }],
  },
});

/**
 * A conforming repo, materialized from the REAL template set — the audit and the templates must
 * agree or init (which writes exactly these) could never scaffold a passing repo. tsc runs for real
 * through a node_modules symlink; eslint/gh answers are injected per test.
 */
function makeConformingRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-audit-'));
  tempDirs.push(dir);
  for (const t of guardrailTemplates()) {
    const target = path.join(dir, t.targetPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, t.contents);
    if (t.executable) chmodSync(target, 0o755);
  }
  writeFileSync(path.join(dir, 'package.json'), FIXTURE_PKG);
  // tsconfig's include:["src"] needs at least one input: TS 6 fails --showConfig with TS18003 on an
  // empty include (TS 7's native port tolerated it), which BLOCKS the strict probe.
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const conforming = true;\n');
  writeFileSync(
    path.join(dir, '.ticket-workflow.json'),
    JSON.stringify({ tier: 'node', exempt: { 'branch-protection': 'fixture repo, no remote' } }),
  );
  mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(path.join(PKG_ROOT, 'node_modules', '.bin', 'tsc'), path.join(dir, 'node_modules', '.bin', 'tsc'));
  return dir;
}

/** defaultExec for everything except eslint, which answers with the conforming config. */
const execWithEslint: Exec = (cmd, args, opts) => {
  if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
  return defaultExec(cmd, args, opts);
};

function statusOf(dir: string, id: string, exec: Exec = execWithEslint): { status: string; detail: string } {
  const r = runAudit(dir, exec).results.find((x) => x.id === id);
  if (!r) throw new Error(`check ${id} missing from report`);
  return r;
}

describe('audit: the conforming fixture (built from the real templates)', () => {
  it('exits 0 — every gating check PASS or EXEMPT, hook-arming advisory BLOCKED', () => {
    const dir = makeConformingRepo();
    const report = runAudit(dir, execWithEslint);
    const gating = report.results.filter((r) => !r.advisory);
    const bad = gating.filter((r) => r.status !== 'pass' && r.status !== 'exempt');
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    const arming = report.results.find((r) => r.id === 'hook-arming');
    expect(arming?.status).toBe('blocked');
    expect(arming?.advisory).toBe(true);
    expect(auditExitCode(report)).toBe(0);
    expect(report.tier).toBe('node');
    expect(report.tierDeclared).toBe(true);
  });

  it('hook-arming NEVER passes — the report always discloses it', () => {
    const dir = makeConformingRepo();
    const out = formatAudit(runAudit(dir, execWithEslint));
    expect(out).toContain('hook-arming');
    expect(out).toContain('unverifiable from the repository');
  });
});

/**
 * One mutation per check, asserting THAT check goes red by id — a catch-all "the audit failed"
 * passes when a different check fires, which is the vacuous shape this suite exists to reject.
 */
describe('audit: each check goes red on exactly its own broken guardrail', () => {
  const readBack = (p: string): string => readFileSync(p, 'utf8');
  const MUTATIONS: Array<{ id: string; expect: 'fail' | 'blocked'; mutate: (dir: string) => void }> = [
    { id: 'claude-md', expect: 'fail', mutate: (d) => rmSync(path.join(d, 'CLAUDE.md')) },
    { id: 'claude-md', expect: 'fail', mutate: (d) => writeFileSync(path.join(d, 'CLAUDE.md'), '# nothing useful\n') },
    { id: 'gitignore', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.gitignore')) },
    { id: 'gitignore', expect: 'fail', mutate: (d) => writeFileSync(path.join(d, '.gitignore'), '\n') },
    {
      id: 'ci-gate-job',
      expect: 'fail',
      mutate: (d) => {
        const p = path.join(d, '.github', 'workflows', 'ci.yml');
        writeFileSync(p, readBack(p).replace(/^ {2}gate:$/m, '  gatekeeper:'));
      },
    },
    { id: 'ci-branch-name-job', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.github', 'workflows', 'pr-branch-name.yml')) },
    { id: 'dependabot', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.github', 'dependabot.yml')) },
    { id: 'hook-launcher', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.claude', 'hooks', 'guard-bash.mjs')) },
    {
      // The three-way case that matters most: PRESENT but vendored must fail.
      id: 'hook-launcher',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, '.claude', 'hooks', 'guard-bash.mjs'), '// vendored guard\nconst RULES = [];\nprocess.exit(0);\n'),
    },
    {
      // Delegates but never blocks: the fail-open costume.
      id: 'hook-launcher',
      expect: 'fail',
      mutate: (d) =>
        writeFileSync(path.join(d, '.claude', 'hooks', 'guard-bash.mjs'), "await import('ticket-workflow/hooks/guard-bash.mjs');\n"),
    },
    {
      // A REALISTIC vendored copy: guard-sized, provenance comment naming the package path, and the
      // guard's own exit(2) — the exact shape the ~24h stale-copy incident shipped. Substring tests
      // alone certify it as a launcher.
      id: 'hook-launcher',
      expect: 'fail',
      mutate: (d) =>
        writeFileSync(
          path.join(d, '.claude', 'hooks', 'guard-bash.mjs'),
          `// vendored from ticket-workflow/hooks/guard-bash.mjs\n${'const RULES = [];\n'.repeat(80)}process.exit(2);\n`,
        ),
    },
    { id: 'hook-settings-wired', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.claude', 'settings.json')) },
    {
      id: 'hook-settings-wired',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, '.claude', 'settings.json'), JSON.stringify({ hooks: {} })),
    },
    {
      // The launcher path appearing OUTSIDE the hooks block is not wiring — a permissions entry
      // naming it must not satisfy the check.
      id: 'hook-settings-wired',
      expect: 'fail',
      mutate: (d) =>
        writeFileSync(
          path.join(d, '.claude', 'settings.json'),
          JSON.stringify({ permissions: { deny: ['.claude/hooks/guard-bash.mjs'] }, hooks: {} }),
        ),
    },
    { id: 'package-scripts', expect: 'fail', mutate: (d) => writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'fixture', engines: { node: '>=24' }, scripts: { test: 'vitest run' } })) },
    { id: 'husky-pre-commit', expect: 'fail', mutate: (d) => rmSync(path.join(d, '.husky', 'pre-commit')) },
    {
      id: 'husky-pre-commit',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, '.husky', 'pre-commit'), 'npm run typecheck && npm run lint && npm test\n'),
    },
    { id: 'eslint-rules', expect: 'fail', mutate: (d) => rmSync(path.join(d, 'eslint.config.js')) },
    {
      id: 'tsconfig-strict',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false, noEmit: true }, include: ['src'] })),
    },
    { id: 'vitest-coverage', expect: 'fail', mutate: (d) => writeFileSync(path.join(d, 'vitest.config.ts'), 'export default {};\n') },
    {
      // An empty thresholds object gates nothing; the substring 'thresholds' alone must not pass.
      id: 'vitest-coverage',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, 'vitest.config.ts'), 'export default { test: { coverage: { thresholds: {} } } };\n'),
    },
    {
      // A commented-out block is not enforcement.
      id: 'vitest-coverage',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, 'vitest.config.ts'), '// thresholds: { lines: 80 }\nexport default { test: {} };\n'),
    },
    {
      // Every marker WORD present, zero workflow content — substring matching certified this shape.
      id: 'claude-md',
      expect: 'fail',
      mutate: (d) => writeFileSync(path.join(d, 'CLAUDE.md'), 'Use the latest branch of the eslint config; see tests/ for lint sprints.\n'),
    },
    { id: 'node-version-sync', expect: 'fail', mutate: (d) => writeFileSync(path.join(d, '.nvmrc'), '26\n') },
    // BLOCKED ≠ PASS: the undeterminable state for each instrumented or readable check.
    { id: 'tsconfig-strict', expect: 'blocked', mutate: (d) => rmSync(path.join(d, 'node_modules', '.bin', 'tsc')) },
    {
      id: 'hook-settings-wired',
      expect: 'blocked',
      mutate: (d) => writeFileSync(path.join(d, '.claude', 'settings.json'), '{ not json'),
    },
  ];

  it.each(MUTATIONS.map((m, i) => [m.id, m.expect, i] as const))('%s → %s', (id, expected, i) => {
    const dir = makeConformingRepo();
    MUTATIONS[i].mutate(dir);
    const r = statusOf(dir, id);
    expect(r.status, r.detail).toBe(expected);
  });

  it('control: the unmutated fixture passes every check the mutations above turn red', () => {
    const covered = new Set(MUTATIONS.map((m) => m.id));
    // A ratchet, pinned outside the loop. Deleting mutations narrows what this control covers without
    // failing anything — and at zero it would pass while controlling nothing, the shape
    // scripts/probe/vacuous-tests.mjs screens for. Raise this floor when checks are added.
    expect(covered.size, 'the mutation set has shrunk — this control now covers less').toBeGreaterThanOrEqual(13);
    const dir = makeConformingRepo();
    const report = runAudit(dir, execWithEslint);
    for (const id of covered) {
      const r = report.results.find((x) => x.id === id);
      if (!r) throw new Error(`check ${id} missing from report`);
      expect(['pass', 'exempt'], `${id}: ${r.detail}`).toContain(r.status);
    }
  });
});

describe('audit: fixed false-verdict shapes stay fixed', () => {
  it("'.nvmrc' spelled v24 or 24.1.0 is IN sync with a 24 floor, not a FAIL", () => {
    for (const spelling of ['v24\n', '24.1.0\n']) {
      const dir = makeConformingRepo();
      writeFileSync(path.join(dir, '.nvmrc'), spelling);
      const r = statusOf(dir, 'node-version-sync');
      expect(r.status, `${JSON.stringify(spelling)}: ${r.detail}`).toBe('pass');
    }
  });

  it('a relative repoDir resolves once — no false BLOCKED from double resolution', () => {
    const dir = makeConformingRepo();
    const rel = path.relative(process.cwd(), dir);
    const r = runAudit(rel, execWithEslint).results.find((x) => x.id === 'eslint-rules');
    expect(r?.status, r?.detail).toBe('pass');
  });

  it('declaration+declarationMap in the audited tsconfig does not BLOCK the strict probe', () => {
    const dir = makeConformingRepo();
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, declaration: true, declarationMap: true, outDir: 'dist' }, include: ['src'] }),
    );
    const r = statusOf(dir, 'tsconfig-strict');
    expect(r.status, r.detail).toBe('pass');
  });

  it('an unrelated bypassable ruleset does not fail branch protection', () => {
    const dir = makeConformingRepo();
    writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'node', exempt: {} }));
    const REPO_VIEW = JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } });
    const rules = JSON.stringify([
      { type: 'pull_request', ruleset_id: 7 },
      { type: 'required_status_checks', ruleset_id: 7, parameters: { required_status_checks: [{ context: 'gate' }, { context: 'branch-name' }] } },
      { type: 'non_fast_forward', ruleset_id: 9 },
    ]);
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('get-url')) return { kind: 'ran', ok: true, stdout: 'git@github.com:o/r.git\n', stderr: '' };
      if (cmd === 'gh' && args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (cmd === 'gh' && String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: rules, stderr: '' };
      if (cmd === 'gh' && String(args[1]).endsWith('/rulesets/7')) return { kind: 'ran', ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'never' }), stderr: '' };
      if (cmd === 'gh' && String(args[1]).endsWith('/rulesets/9')) return { kind: 'ran', ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'always' }), stderr: '' };
      if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
      return defaultExec(cmd, args, opts);
    };
    const r = statusOf(dir, 'branch-protection', exec);
    expect(r.status, r.detail).toBe('pass');
  });

  it('eslint.config.cjs is found, not reported as lint-enforces-nothing', () => {
    const dir = makeConformingRepo();
    const contents = readFileSync(path.join(dir, 'eslint.config.js'), 'utf8');
    rmSync(path.join(dir, 'eslint.config.js'));
    writeFileSync(path.join(dir, 'eslint.config.cjs'), contents);
    const r = statusOf(dir, 'eslint-rules');
    expect(r.status, r.detail).toBe('pass');
  });
});

describe('audit: eslint asked, not grepped', () => {
  it('BLOCKED when the config exists but eslint is not installed', () => {
    const dir = makeConformingRepo();
    const r = statusOf(dir, 'eslint-rules', defaultExec);
    expect(r.status, r.detail).toBe('blocked');
  });

  it('FAIL when eslint resolves a required rule below error severity', () => {
    const dir = makeConformingRepo();
    const weak = JSON.stringify({ rules: { '@typescript-eslint/no-explicit-any': [1], '@typescript-eslint/no-non-null-assertion': [2], '@typescript-eslint/consistent-type-assertions': [2, { assertionStyle: 'never' }] } });
    const exec: Exec = (cmd, args, opts) =>
      cmd.endsWith('eslint') ? { kind: 'ran', ok: true, stdout: weak, stderr: '' } : defaultExec(cmd, args, opts);
    const r = statusOf(dir, 'eslint-rules', exec);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('no-explicit-any');
  });

  it('FAIL when assertionStyle is not never, even at error severity', () => {
    const dir = makeConformingRepo();
    const wrongStyle = JSON.stringify({ rules: { '@typescript-eslint/no-explicit-any': [2], '@typescript-eslint/no-non-null-assertion': [2], '@typescript-eslint/consistent-type-assertions': [2, { assertionStyle: 'as' }] } });
    const exec: Exec = (cmd, args, opts) =>
      cmd.endsWith('eslint') ? { kind: 'ran', ok: true, stdout: wrongStyle, stderr: '' } : defaultExec(cmd, args, opts);
    expect(statusOf(dir, 'eslint-rules', exec).status).toBe('fail');
  });
});

describe('audit: branch protection asked of the API', () => {
  function withGh(handler: (args: readonly string[]) => ExecResult | undefined): Exec {
    return (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('get-url')) return { kind: 'ran', ok: true, stdout: 'git@github.com:o/r.git\n', stderr: '' };
      if (cmd === 'gh') {
        const handled = handler(args);
        if (handled) return handled;
      }
      if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
      return defaultExec(cmd, args, opts);
    };
  }

  function unexempt(dir: string): void {
    writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'node', exempt: {} }));
  }

  const REPO_VIEW = JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } });
  const RULES_OK = JSON.stringify([
    { type: 'pull_request', ruleset_id: 7 },
    { type: 'required_status_checks', ruleset_id: 7, parameters: { required_status_checks: [{ context: 'gate' }, { context: 'branch-name' }] } },
  ]);

  it('PASS on active PR rule + both required checks + no bypass', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec = withGh((args) => {
      if (args.includes('repo') || args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: RULES_OK, stderr: '' };
      if (String(args[1]).includes('/rulesets/')) return { kind: 'ran', ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'never' }), stderr: '' };
      return undefined;
    });
    const r = statusOf(dir, 'branch-protection', exec);
    expect(r.status, r.detail).toBe('pass');
  });

  it('FAIL when the required checks are absent from the ACTIVE rules (a disabled ruleset never shows here)', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec = withGh((args) => {
      if (args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: JSON.stringify([]), stderr: '' };
      return undefined;
    });
    expect(statusOf(dir, 'branch-protection', exec).status).toBe('fail');
  });

  it('FAIL when a contributing ruleset is bypassable', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec = withGh((args) => {
      if (args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: RULES_OK, stderr: '' };
      if (String(args[1]).includes('/rulesets/')) return { kind: 'ran', ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'always' }), stderr: '' };
      return undefined;
    });
    const r = statusOf(dir, 'branch-protection', exec);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('bypassable');
  });

  it('PASS on empty bypass_actors even when current_user_can_bypass is absent — the CI-identity shape', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec = withGh((args) => {
      if (args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: RULES_OK, stderr: '' };
      // GitHub serializes current_user_can_bypass conditionally per caller; bypass_actors is stable.
      if (String(args[1]).includes('/rulesets/')) return { kind: 'ran', ok: true, stdout: JSON.stringify({ bypass_actors: [] }), stderr: '' };
      return undefined;
    });
    const r = statusOf(dir, 'branch-protection', exec);
    expect(r.status, r.detail).toBe('pass');
  });

  it('FAIL when bypass_actors is non-empty, regardless of the per-identity field', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec = withGh((args) => {
      if (args[0] === 'repo') return { kind: 'ran', ok: true, stdout: REPO_VIEW, stderr: '' };
      if (String(args[1]).includes('/rules/branches/')) return { kind: 'ran', ok: true, stdout: RULES_OK, stderr: '' };
      if (String(args[1]).includes('/rulesets/')) {
        return { kind: 'ran', ok: true, stdout: JSON.stringify({ bypass_actors: [{ actor_type: 'RepositoryRole' }], current_user_can_bypass: 'never' }), stderr: '' };
      }
      return undefined;
    });
    const r = statusOf(dir, 'branch-protection', exec);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('bypass actor');
  });

  it('BLOCKED when gh is absent — never PASS', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('get-url')) return { kind: 'ran', ok: true, stdout: 'git@github.com:o/r.git\n', stderr: '' };
      if (cmd === 'gh') return { kind: 'absent' };
      if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
      return defaultExec(cmd, args, opts);
    };
    const report = runAudit(dir, exec);
    const r = report.results.find((x) => x.id === 'branch-protection');
    expect(r?.status).toBe('blocked');
    expect(auditExitCode(report)).toBe(1);
  });

  it('BLOCKED when there is no origin remote', () => {
    const dir = makeConformingRepo();
    unexempt(dir);
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('get-url')) return { kind: 'ran', ok: false, stdout: '', stderr: 'error: No such remote' };
      if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
      return defaultExec(cmd, args, opts);
    };
    expect(statusOf(dir, 'branch-protection', exec).status).toBe('blocked');
  });
});

describe('audit: config and exemptions', () => {
  it('an exemption with no reason is a FAIL, not a waiver', () => {
    const dir = makeConformingRepo();
    writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'node', exempt: { 'branch-protection': '' } }));
    const r = statusOf(dir, 'branch-protection');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('NO reason');
  });

  it('a corrupt config BLOCKS every check and the exit code is non-zero', () => {
    const dir = makeConformingRepo();
    writeFileSync(path.join(dir, '.ticket-workflow.json'), '{ tier: node'); // not JSON
    const report = runAudit(dir, execWithEslint);
    expect(report.results.every((r) => r.status === 'blocked')).toBe(true);
    expect(auditExitCode(report)).not.toBe(0);
  });

  it('an unknown tier BLOCKS rather than defaulting', () => {
    const dir = makeConformingRepo();
    writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'python' }));
    const report = runAudit(dir, execWithEslint);
    expect(report.results.every((r) => r.status === 'blocked')).toBe(true);
  });

  it('no config infers the tier and says so', () => {
    const dir = makeConformingRepo();
    rmSync(path.join(dir, '.ticket-workflow.json'));
    const report = runAudit(dir, execWithEslint);
    expect(report.tier).toBe('node');
    expect(report.tierDeclared).toBe(false);
    expect(formatAudit(report)).toContain('inferred');
  });

  it('core tier runs only core checks', () => {
    const dir = makeConformingRepo();
    writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'core', exempt: { 'branch-protection': 'fixture repo, no remote' } }));
    const report = runAudit(dir, execWithEslint);
    expect(report.results.every((r) => r.tier === 'core')).toBe(true);
    expect(report.results.map((r) => r.id)).not.toContain('tsconfig-strict');
  });
});

describe('audit: exit codes', () => {
  it('FAIL → 2, and FAIL outranks BLOCKED', () => {
    const dir = makeConformingRepo();
    rmSync(path.join(dir, '.gitignore'));
    rmSync(path.join(dir, 'node_modules', '.bin', 'tsc'));
    expect(auditExitCode(runAudit(dir, execWithEslint))).toBe(2);
  });

  it('BLOCKED alone → 1: "could not determine" is never conformance', () => {
    const dir = makeConformingRepo();
    rmSync(path.join(dir, 'node_modules', '.bin', 'tsc'));
    expect(auditExitCode(runAudit(dir, execWithEslint))).toBe(1);
  });

  it('a crashing check surfaces as BLOCKED instead of aborting the report', () => {
    const dir = makeConformingRepo();
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'git') throw new Error('boom');
      if (cmd.endsWith('eslint')) return { kind: 'ran', ok: true, stdout: ESLINT_CONFORMING, stderr: '' };
      return defaultExec(cmd, args, opts);
    };
    const dir2 = dir;
    writeFileSync(path.join(dir2, '.ticket-workflow.json'), JSON.stringify({ tier: 'node', exempt: {} }));
    const report = runAudit(dir2, exec);
    const bp = report.results.find((r) => r.id === 'branch-protection');
    expect(bp?.status).toBe('blocked');
    expect(bp?.detail).toContain('crashed');
    expect(report.results.length).toBe(AUDIT_CHECKS.length);
  });
});
