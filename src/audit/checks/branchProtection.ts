import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

interface BranchRule {
  readonly type: string;
  readonly ruleset_id?: number;
  readonly parameters?: { readonly required_status_checks?: readonly { readonly context: string }[] };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Asks the GitHub API, never a text grep — a ruleset that exists but is `disabled` must not read as
 * protection, and `/rules/branches/<branch>` aggregates ACTIVE rulesets only, which answers that for
 * free. Bypass is then asserted per contributing ruleset (`current_user_can_bypass: never`): a
 * protection the auditor could bypass is a fence with a private gate.
 *
 * `gh` absent, unauthenticated, no origin, or an unparseable answer → BLOCKED. In CI (where this
 * check gates), `gh` and GITHUB_TOKEN are present, so BLOCKED there means genuinely misconfigured.
 * A local-only repo declares the exemption in .ticket-workflow.json instead.
 */
export const branchProtection: AuditCheck = {
  id: 'branch-protection',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const origin = ctx.exec('git', ['-C', ctx.repoDir, 'remote', 'get-url', 'origin']);
    if (origin.kind === 'absent') return makeResult(this, 'blocked', 'git is not on PATH, so the remote cannot be determined');
    if (origin.kind === 'error') return makeResult(this, 'blocked', `git failed: ${origin.message}`);
    if (!origin.ok) return makeResult(this, 'blocked', 'no `origin` remote — branch protection is not determinable (a deliberately local-only repo should declare the exemption in .ticket-workflow.json)');

    const repoView = ctx.exec('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd: ctx.repoDir });
    if (repoView.kind === 'absent') return makeResult(this, 'blocked', '`gh` is not on PATH, so branch protection cannot be checked');
    if (repoView.kind === 'error') return makeResult(this, 'blocked', `gh failed: ${repoView.message}`);
    if (!repoView.ok) return makeResult(this, 'blocked', `gh could not read the repo (unauthenticated, or no GitHub remote): ${repoView.stderr.trim().split('\n')[0] ?? ''}`);
    const view = parseJson(repoView.stdout);
    const nameWithOwner =
      typeof view === 'object' && view !== null && 'nameWithOwner' in view && typeof view.nameWithOwner === 'string'
        ? view.nameWithOwner
        : undefined;
    const defaultBranch =
      typeof view === 'object' && view !== null && 'defaultBranchRef' in view &&
      typeof view.defaultBranchRef === 'object' && view.defaultBranchRef !== null &&
      'name' in view.defaultBranchRef && typeof view.defaultBranchRef.name === 'string'
        ? view.defaultBranchRef.name
        : undefined;
    if (!nameWithOwner || !defaultBranch) return makeResult(this, 'blocked', 'gh answered but the repo name or default branch was missing from it');

    const rulesRes = ctx.exec('gh', ['api', `repos/${nameWithOwner}/rules/branches/${defaultBranch}`], { cwd: ctx.repoDir });
    if (rulesRes.kind !== 'ran' || !rulesRes.ok) {
      const msg = rulesRes.kind === 'ran' ? rulesRes.stderr.trim().split('\n')[0] : rulesRes.kind;
      return makeResult(this, 'blocked', `the branch-rules API could not be read: ${msg}`);
    }
    const rules = parseJson(rulesRes.stdout);
    if (!Array.isArray(rules)) return makeResult(this, 'blocked', 'the branch-rules API returned something other than a rule list');
    const typedRules: BranchRule[] = rules.filter(
      (r): r is BranchRule => typeof r === 'object' && r !== null && 'type' in r && typeof r.type === 'string',
    );

    const hasPr = typedRules.some((r) => r.type === 'pull_request');
    const requiredContexts = typedRules
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => r.parameters?.required_status_checks?.map((c) => c.context) ?? []);
    const missing = ['gate', 'branch-name'].filter((c) => !requiredContexts.includes(c));
    if (!hasPr || missing.length > 0) {
      const parts = [
        !hasPr ? 'no active rule requires a pull request' : null,
        missing.length > 0 ? `required checks missing: ${missing.join(', ')}` : null,
      ].filter((p): p is string => p !== null);
      return makeResult(this, 'fail', `${defaultBranch} is not protected to the standard — ${parts.join('; ')} (disabled rulesets do not count)`);
    }

    // Every ruleset contributing THE RULES THE STANDARD REQUIRES must be non-bypassable. Only
    // those: an unrelated active ruleset (say, non_fast_forward with admin bypass) says nothing
    // about whether the PR/checks floor can be stepped around.
    const rulesetIds = [
      ...new Set(
        typedRules
          .filter((r) => r.type === 'pull_request' || r.type === 'required_status_checks')
          .map((r) => r.ruleset_id)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ];
    for (const id of rulesetIds) {
      const rs = ctx.exec('gh', ['api', `repos/${nameWithOwner}/rulesets/${id}`], { cwd: ctx.repoDir });
      if (rs.kind !== 'ran' || !rs.ok) return makeResult(this, 'blocked', `ruleset ${id} could not be read to verify bypass`);
      const parsed = parseJson(rs.stdout);
      const bypass =
        typeof parsed === 'object' && parsed !== null && 'current_user_can_bypass' in parsed ? parsed.current_user_can_bypass : undefined;
      if (bypass === undefined) return makeResult(this, 'blocked', `ruleset ${id} reports no bypass field — cannot assert no-bypass`);
      if (bypass !== 'never') {
        return makeResult(this, 'fail', `ruleset ${id} is bypassable (current_user_can_bypass: ${String(bypass)}) — the floor must have no bypass`);
      }
    }
    return makeResult(this, 'pass', `${defaultBranch} requires a PR + checks [gate, branch-name] with no bypass (${rulesetIds.length} active ruleset(s))`);
  },
};
