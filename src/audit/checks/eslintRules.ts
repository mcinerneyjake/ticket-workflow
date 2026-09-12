import path from 'node:path';
import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const CONFIG_CANDIDATES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];
const OXLINT_CANDIDATES = ['.oxlintrc.json', '.oxlintrc.jsonc'];

const REQUIRED_RULES = [
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-non-null-assertion',
  '@typescript-eslint/consistent-type-assertions',
];

/** oxlint resolves the same three under a `typescript/` prefix. Same conventions, different names. */
const OXLINT_REQUIRED_RULES = [
  'typescript/no-explicit-any',
  'typescript/no-non-null-assertion',
  'typescript/consistent-type-assertions',
];

const ASSERTIONS_RULE = 'consistent-type-assertions';

interface Linter {
  readonly bin: string;
  readonly configFile: string;
  readonly rules: readonly string[];
  /** Whether a resolved severity means "error". eslint says 2/'error'; oxlint says 'deny'. */
  readonly isError: (severity: unknown) => boolean;
  /**
   * Whether this linter's `--print-config` already applies `overrides`. eslint's is file-scoped, so
   * the answer it gives IS the answer for that path. oxlint's is not: it reports the top-level
   * severity and hands `overrides` back unapplied, so a repo that denies a rule globally and
   * switches it off for a TypeScript glob lints clean while the severity still reads `deny`.
   */
  readonly overridesApplied: boolean;
}

type Overrides =
  | { readonly kind: 'none' }
  | { readonly kind: 'touches'; readonly rules: readonly string[] }
  /** Present but not readable. The guard exists BECAUSE severity cannot be trusted under overrides,
   *  so the shape it cannot parse is the case it knows least about — never the permissive answer. */
  | { readonly kind: 'unreadable'; readonly why: string };

/** Required rules that an unapplied `overrides` block mentions — each one the resolved severity
 *  cannot speak for. Read off the printed config; absent is fine, odd-shaped is not. */
function overriddenRules(resolved: Record<string, unknown>, required: readonly string[]): Overrides {
  const blocks: unknown = resolved.overrides;
  if (blocks === undefined || blocks === null) return { kind: 'none' };
  if (!Array.isArray(blocks)) return { kind: 'unreadable', why: '`overrides` is not an array' };
  const touched = new Set<string>();
  for (const block of blocks) {
    if (!isRecord(block)) return { kind: 'unreadable', why: 'an `overrides` entry is not an object' };
    const rules: unknown = block.rules;
    // A block that sets no rules at all cannot relax one — that is absence, not an unreadable shape.
    if (rules === undefined) continue;
    if (!isRecord(rules)) return { kind: 'unreadable', why: 'an `overrides` entry has a non-object `rules`' };
    for (const rule of required) if (rule in rules) touched.add(rule);
  }
  return touched.size === 0 ? { kind: 'none' } : { kind: 'touches', rules: [...touched] };
}

type Found =
  | { readonly kind: 'found'; readonly file: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly file: string; readonly message: string };

function firstExisting(ctx: AuditContext, candidates: readonly string[]): Found {
  for (const c of candidates) {
    const r = ctx.read(c);
    // An unreadable config is BLOCKED, not "absent": every sibling check keeps those apart, and
    // an EACCES read as a missing file turns "could not look" into a confident FAIL.
    if (r.kind === 'error') return { kind: 'error', file: c, message: r.message };
    if (r.kind === 'ok') return { kind: 'found', file: c };
  }
  return { kind: 'none' };
}

/**
 * A rule's resolved entry as severity + options. The two linters disagree on the second slot:
 * eslint answers `["error", {…}]` while oxlint NESTS it, `["deny", [{…}]]` — reading oxlint's the
 * eslint way yields an array where an object was expected, so `assertionStyle` reads `undefined`
 * on a config that does set it and a conforming repo fails.
 */
function severityAndOptions(entry: unknown): { readonly severity: unknown; readonly options: unknown } {
  if (!Array.isArray(entry)) return { severity: entry, options: undefined };
  const opts: unknown = entry[1];
  return { severity: entry[0], options: Array.isArray(opts) ? opts[0] : opts };
}

/**
 * Asks the linter itself (`--print-config`), never a grep of the config source: a grep misses rules
 * inherited from a shared base and happily reads a commented-out line as live. The repo's own
 * binary answers; no binary means BLOCKED, not a guess.
 */
function auditLinter(check: AuditCheck, ctx: AuditContext, linter: Linter): AuditResult {
  const bin = path.join(ctx.repoDir, 'node_modules', '.bin', linter.bin);
  // A hypothetical path is enough: flat config resolves by pattern, not by the file existing.
  const probeFile = path.join(ctx.repoDir, 'src', 'audit-probe.ts');
  const res = ctx.exec(bin, ['--print-config', probeFile], { cwd: ctx.repoDir });
  if (res.kind === 'absent') {
    return makeResult(check, 'blocked', `${linter.configFile} exists but node_modules/.bin/${linter.bin} does not — run npm ci, then re-audit`);
  }
  if (res.kind === 'error') return makeResult(check, 'blocked', `${linter.bin} could not run: ${res.message}`);
  if (!res.ok) return makeResult(check, 'blocked', `${linter.bin} --print-config failed: ${res.stderr.trim().split('\n')[0] ?? ''}`);
  let resolved: unknown;
  try {
    resolved = JSON.parse(res.stdout);
  } catch {
    return makeResult(check, 'blocked', `${linter.bin} --print-config returned unparseable output`);
  }
  if (!isRecord(resolved) || !isRecord(resolved.rules)) {
    return makeResult(check, 'blocked', `${linter.bin} --print-config answered with an unexpected shape — cannot read resolved rules`);
  }
  const rules: Record<string, unknown> = resolved.rules;
  if (!linter.overridesApplied) {
    const overrides = overriddenRules(resolved, linter.rules);
    if (overrides.kind === 'unreadable') {
      return makeResult(check, 'blocked', `${linter.bin} --print-config does not apply overrides and ${overrides.why} — the resolved severity cannot be trusted`);
    }
    if (overrides.kind === 'touches') {
      return makeResult(check, 'blocked', `${linter.bin} --print-config does not apply overrides, and one overrides ${overrides.rules.join(', ')} — the resolved severity cannot be trusted for every file`);
    }
  }
  const notError = linter.rules.filter((r) => !linter.isError(severityAndOptions(rules[r]).severity));
  if (notError.length > 0) {
    return makeResult(check, 'fail', `rule(s) not resolved to error severity: ${notError.join(', ')}`);
  }
  const assertions = linter.rules.find((r) => r.endsWith(ASSERTIONS_RULE));
  const options = assertions === undefined ? undefined : severityAndOptions(rules[assertions]).options;
  const style = isRecord(options) ? options.assertionStyle : undefined;
  if (style !== 'never') {
    return makeResult(check, 'fail', `consistent-type-assertions resolves with assertionStyle ${JSON.stringify(style)}, not 'never'`);
  }
  return makeResult(check, 'pass', `the three TS conventions resolve to error severity (asked of ${linter.bin}, not grepped)`);
}

export const eslintRules: AuditCheck = {
  id: 'eslint-rules',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    // eslint first where both are configured: it is the heavier declaration, and preferring it
    // keeps every repo that already had one answering exactly as it did before this check grew a
    // second linter (tkt-5c0e00fae59d).
    const eslint = firstExisting(ctx, CONFIG_CANDIDATES);
    if (eslint.kind === 'error') return makeResult(this, 'blocked', `${eslint.file} could not be read: ${eslint.message}`);
    if (eslint.kind === 'found') {
      return auditLinter(this, ctx, {
        bin: 'eslint',
        configFile: eslint.file,
        rules: REQUIRED_RULES,
        isError: (s) => s === 2 || s === 'error',
        overridesApplied: true,
      });
    }
    const oxlint = firstExisting(ctx, OXLINT_CANDIDATES);
    if (oxlint.kind === 'error') return makeResult(this, 'blocked', `${oxlint.file} could not be read: ${oxlint.message}`);
    if (oxlint.kind === 'found') {
      return auditLinter(this, ctx, {
        bin: 'oxlint',
        configFile: oxlint.file,
        rules: OXLINT_REQUIRED_RULES,
        // `deny` is oxlint's spelling of error; `error` is accepted as an alias in a config and 2
        // for eslint compatibility. `warn` and `allow` are not enforcement.
        isError: (s) => s === 2 || s === 'error' || s === 'deny',
        overridesApplied: false,
      });
    }
    return makeResult(this, 'fail', 'no eslint.config.* and no .oxlintrc.* found — lint enforces nothing');
  },
};
