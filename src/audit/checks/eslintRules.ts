import path from 'node:path';
import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const CONFIG_CANDIDATES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];

const REQUIRED_RULES = [
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-non-null-assertion',
  '@typescript-eslint/consistent-type-assertions',
];

/**
 * Asks ESLint itself (`--print-config`), never a grep of the config source: a grep misses rules
 * inherited from a shared base and happily reads a commented-out line as live. The repo's own
 * eslint binary answers; no binary means BLOCKED, not a guess.
 */
export const eslintRules: AuditCheck = {
  id: 'eslint-rules',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    // An unreadable config is BLOCKED, not "absent": every sibling check keeps those apart, and
    // an EACCES read as a missing file turns "could not look" into a confident FAIL.
    let configFile: string | undefined;
    for (const c of CONFIG_CANDIDATES) {
      const r = ctx.read(c);
      if (r.kind === 'error') return makeResult(this, 'blocked', `${c} could not be read: ${r.message}`);
      if (r.kind === 'ok') {
        configFile = c;
        break;
      }
    }
    if (configFile === undefined) {
      return makeResult(this, 'fail', 'no eslint.config.* found — lint enforces nothing');
    }
    const eslintBin = path.join(ctx.repoDir, 'node_modules', '.bin', 'eslint');
    // A hypothetical path is enough: flat config resolves by pattern, not by the file existing.
    const probeFile = path.join(ctx.repoDir, 'src', 'audit-probe.ts');
    const res = ctx.exec(eslintBin, ['--print-config', probeFile], { cwd: ctx.repoDir });
    if (res.kind === 'absent') {
      return makeResult(this, 'blocked', `${configFile} exists but node_modules/.bin/eslint does not — run npm ci, then re-audit`);
    }
    if (res.kind === 'error') return makeResult(this, 'blocked', `eslint could not run: ${res.message}`);
    if (!res.ok) return makeResult(this, 'blocked', `eslint --print-config failed: ${res.stderr.trim().split('\n')[0] ?? ''}`);
    let resolved: unknown;
    try {
      resolved = JSON.parse(res.stdout);
    } catch {
      return makeResult(this, 'blocked', 'eslint --print-config returned unparseable output');
    }
    if (!isRecord(resolved) || !isRecord(resolved.rules)) {
      return makeResult(this, 'blocked', 'eslint --print-config answered with an unexpected shape — cannot read resolved rules');
    }
    const rules: Record<string, unknown> = resolved.rules;
    const ruleEntry = (name: string): unknown[] | undefined => {
      const v = rules[name];
      return Array.isArray(v) ? v : undefined;
    };
    const notError = REQUIRED_RULES.filter((r) => {
      const entry = ruleEntry(r);
      return entry === undefined || (entry[0] !== 2 && entry[0] !== 'error');
    });
    if (notError.length > 0) {
      return makeResult(this, 'fail', `rule(s) not resolved to error severity: ${notError.join(', ')}`);
    }
    const cta = ruleEntry('@typescript-eslint/consistent-type-assertions');
    const opts = cta?.[1];
    const style = typeof opts === 'object' && opts !== null && 'assertionStyle' in opts ? opts.assertionStyle : undefined;
    if (style !== 'never') {
      return makeResult(this, 'fail', `consistent-type-assertions resolves with assertionStyle ${JSON.stringify(style)}, not 'never'`);
    }
    return makeResult(this, 'pass', 'the three TS conventions resolve to error severity (asked of eslint, not grepped)');
  },
};
