import { releaseTestRun } from './hold.js';

// Release only: vitest cleans the coverage dir between config resolution and globalSetup, so the
// acquire lives in vitest.config.ts. Branchless and coverage-excluded; hold.ts holds every decision.
export default function setup(): () => Promise<void> {
  return () => releaseTestRun();
}
