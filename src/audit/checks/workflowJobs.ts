import { readdirSync } from 'node:fs';
import path from 'node:path';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

type JobSearch =
  | { readonly kind: 'found'; readonly file: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unreadable'; readonly message: string };

/**
 * Does any workflow define a job with this literal name? Job keys sit at two-space indent under
 * `jobs:` in every workflow this standard ships; the fixture suite keeps the regex honest against a
 * real workflow file rather than trusting the pattern.
 */
function findWorkflowJob(ctx: AuditContext, jobName: string): JobSearch {
  const dir = path.join(ctx.repoDir, '.github', 'workflows');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { kind: 'not-found' };
    return { kind: 'unreadable', message: err instanceof Error ? err.message : String(err) };
  }
  // 2- or 4-space indent: both are common YAML styles for job keys, and a fixed 2 fails a
  // conforming 4-space workflow. Deeper indents stay excluded — a step map key is not a job.
  const jobKey = new RegExp(`^ {2,4}${jobName}:\\s*$`, 'm');
  for (const f of files) {
    const file = ctx.read(path.join('.github', 'workflows', f));
    if (file.kind === 'error') return { kind: 'unreadable', message: `${f}: ${file.message}` };
    if (file.kind === 'ok' && jobKey.test(file.contents)) return { kind: 'found', file: f };
  }
  return { kind: 'not-found' };
}

function jobCheck(id: string, jobName: string, why: string): AuditCheck {
  return {
    id,
    tier: 'core',
    run(ctx: AuditContext): AuditResult {
      const search = findWorkflowJob(ctx, jobName);
      switch (search.kind) {
        case 'unreadable':
          return makeResult(this, 'blocked', `.github/workflows could not be read: ${search.message}`);
        case 'not-found':
          return makeResult(this, 'fail', `no workflow defines a job literally named \`${jobName}\` — ${why}`);
        case 'found':
          return makeResult(this, 'pass', `job \`${jobName}\` defined in ${search.file}`);
      }
    },
  };
}

export const ciGateJob = jobCheck(
  'ci-gate-job',
  'gate',
  'the required status check on main must exist under that exact name',
);

export const ciBranchNameJob = jobCheck(
  'ci-branch-name-job',
  'branch-name',
  'the branch-per-ticket convention has no server-side enforcement without it',
);
