import type { GuardrailTier } from '../templates.js';
import { isRecord, type AuditContext } from './types.js';

export const CONFIG_FILE = '.ticket-workflow.json';

export type RepoConfig =
  | {
      readonly kind: 'ok';
      readonly tier: GuardrailTier;
      /** Declared tier vs inferred-from-repo-shape, reported so a sweep can tell them apart. */
      readonly declared: boolean;
      readonly exempt: Readonly<Record<string, string>>;
    }
  /** The config exists but cannot be trusted — the whole audit is BLOCKED, not defaulted. */
  | { readonly kind: 'invalid'; readonly detail: string };

export function loadRepoConfig(ctx: AuditContext): RepoConfig {
  const file = ctx.read(CONFIG_FILE);
  if (file.kind === 'error') return { kind: 'invalid', detail: `${CONFIG_FILE} could not be read: ${file.message}` };
  if (file.kind === 'missing') {
    // No declaration: infer node when the repo has a package.json, core otherwise. Inference is
    // reported (declared: false) so a sweep can distinguish a chosen tier from a guessed one.
    const pkg = ctx.read('package.json');
    if (pkg.kind === 'error') return { kind: 'invalid', detail: `package.json could not be read: ${pkg.message}` };
    return { kind: 'ok', tier: pkg.kind === 'ok' ? 'node' : 'core', declared: false, exempt: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.contents);
  } catch (err) {
    return { kind: 'invalid', detail: `${CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { kind: 'invalid', detail: `${CONFIG_FILE} must be a JSON object` };
  const tier = parsed.tier;
  if (tier !== 'core' && tier !== 'node') {
    return { kind: 'invalid', detail: `${CONFIG_FILE} declares unknown tier ${JSON.stringify(tier)} (expected "core" or "node")` };
  }
  const exemptRaw = parsed.exempt ?? {};
  if (!isRecord(exemptRaw)) return { kind: 'invalid', detail: `${CONFIG_FILE} "exempt" must be an object of checkId → reason` };
  const exempt: Record<string, string> = {};
  for (const [id, reason] of Object.entries(exemptRaw)) {
    // A reason-less exemption is recorded as an empty string; the runner turns it into a FAIL —
    // an exemption nobody can justify is a hole, not a waiver.
    exempt[id] = typeof reason === 'string' ? reason : '';
  }
  return { kind: 'ok', tier, declared: true, exempt };
}
