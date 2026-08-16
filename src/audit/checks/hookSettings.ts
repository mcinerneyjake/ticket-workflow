import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

/** The launcher file existing is necessary, not sufficient: settings.json is what names it to the
 *  harness, and a launcher nothing points at never runs. */
export const hookSettings: AuditCheck = {
  id: 'hook-settings-wired',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.claude/settings.json');
    if (file.kind === 'missing') {
      return makeResult(this, 'fail', '.claude/settings.json is absent — the guard launcher is wired by nothing');
    }
    if (file.kind === 'error') return makeResult(this, 'blocked', `.claude/settings.json could not be read: ${file.message}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.contents);
    } catch (err) {
      return makeResult(this, 'blocked', `.claude/settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Search the HOOKS block only, never the whole file: the launcher path appearing in a
    // permissions entry or an env value is not wiring, and matching it there is a fail-open PASS on
    // the check that exists to catch exactly that.
    const hooks = typeof parsed === 'object' && parsed !== null && 'hooks' in parsed ? parsed.hooks : undefined;
    if (hooks === undefined || !JSON.stringify(hooks).includes('.claude/hooks/guard-bash.mjs')) {
      return makeResult(this, 'fail', 'no entry in the hooks block of .claude/settings.json points at .claude/hooks/guard-bash.mjs');
    }
    return makeResult(this, 'pass', '.claude/settings.json wires the guard-bash launcher');
  },
};
