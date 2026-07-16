import { describe, it, expect } from 'vitest';
import { commandToMilestones, extractTicketId, stateFromExit, recordsFor, HOOK_STEPS } from './track-steps.mjs';
import { STEP_IDS, BRANCH_TICKET_ID_RE } from '../src/shared/constants.js';

describe('commandToMilestones', () => {
  it('maps each recognized single command to its milestone', () => {
    expect(commandToMilestones('git switch -c feat/tkt-abc-x')).toEqual(['branch']);
    expect(commandToMilestones('git checkout -b feat/x')).toEqual(['branch']);
    expect(commandToMilestones('npm run typecheck')).toEqual(['typecheck']);
    expect(commandToMilestones('npm run lint')).toEqual(['lint']);
    expect(commandToMilestones('npm test')).toEqual(['test']);
    expect(commandToMilestones('npm run test:coverage')).toEqual(['test']);
    expect(commandToMilestones('npx vitest run server')).toEqual(['test']);
    expect(commandToMilestones('git commit -m "x"')).toEqual(['commit']);
    expect(commandToMilestones('gh pr create --base main')).toEqual(['pr_opened']);
  });

  it('collects every milestone in a compound command, in order', () => {
    expect(commandToMilestones('npm run typecheck && npm run lint && npm test'))
      .toEqual(['typecheck', 'lint', 'test']);
  });

  it('dedupes a repeated milestone', () => {
    expect(commandToMilestones('npm test && npm test')).toEqual(['test']);
  });

  it('sees through a simple VAR=val env prefix', () => {
    expect(commandToMilestones('FOO=bar npm run lint')).toEqual(['lint']);
  });

  it('returns [] for non-milestone commands', () => {
    expect(commandToMilestones('ls -la')).toEqual([]);
    expect(commandToMilestones('git status')).toEqual([]);
    expect(commandToMilestones('')).toEqual([]);
  });

  it('does not treat a plain branch switch (no -c) as a branch cut', () => {
    expect(commandToMilestones('git switch main')).toEqual([]);
  });

  it('requires the real command word (not a mention inside echo)', () => {
    expect(commandToMilestones('echo "npm run lint"')).toEqual([]);
  });
});

describe('extractTicketId', () => {
  it('pulls the ticket id out of a <type>/<id>-<slug> branch', () => {
    expect(extractTicketId('feat/tkt-512f9b15ddb8-add-telemetry')).toBe('tkt-512f9b15ddb8');
  });

  it('returns null when the branch carries no ticket id', () => {
    expect(extractTicketId('main')).toBeNull();
    expect(extractTicketId('feat/no-ticket-here')).toBeNull();
    expect(extractTicketId(null)).toBeNull();
  });

  it('uses the same id pattern as shared/constants BRANCH_TICKET_ID_RE (no drift)', () => {
    // The mint (newId), the branch-name workflow, and this hook must agree on the
    // id shape. Assert against a KNOWN 12-hex id rather than the hook's own regex
    // source, so a divergence in either pattern is caught.
    const id = 'tkt-0123456789ab';
    expect(BRANCH_TICKET_ID_RE.test(id)).toBe(true);
    expect(extractTicketId(`feat/${id}-slug`)).toBe(id);
    expect(extractTicketId('feat/tkt-XYZ-not-hex')).toBeNull();
    expect(BRANCH_TICKET_ID_RE.test('tkt-XYZ')).toBe(false);
  });
});

describe('stateFromExit', () => {
  it('maps exit 0 to passed and any non-zero to failed', () => {
    expect(stateFromExit(0)).toBe('passed');
    expect(stateFromExit(1)).toBe('failed');
    expect(stateFromExit(2)).toBe('failed');
  });
});

describe('catalog parity with shared/constants.ts', () => {
  it('every hook step is a valid shared StepId (no drift)', () => {
    for (const step of HOOK_STEPS) expect(STEP_IDS).toContain(step);
  });

  it('hook steps + status steps exactly cover the shared catalog', () => {
    // Every catalog step must be accounted for by exactly one producer: the hook
    // (shell milestones + the commit-derived review) or a status transition. This
    // still fails on an UNINTENTIONAL new step that nothing produces.
    const statusSteps = ['started', 'qa', 'done'];
    expect(new Set([...HOOK_STEPS, ...statusSteps])).toEqual(new Set(STEP_IDS));
  });

  it('the hook emits `review` (derived from commit)', () => {
    expect(HOOK_STEPS).toContain('review');
  });
});

describe('recordsFor — commit implies review', () => {
  it('records `review` (reached) just before a successful commit', () => {
    expect(recordsFor(['commit'], 'passed')).toEqual([
      { step: 'review', state: 'reached' },
      { step: 'commit', state: 'passed' },
    ]);
  });

  it('does NOT record review when the commit failed', () => {
    expect(recordsFor(['commit'], 'failed')).toEqual([{ step: 'commit', state: 'failed' }]);
  });

  it('leaves non-commit milestones untouched', () => {
    expect(recordsFor(['typecheck', 'lint'], 'passed')).toEqual([
      { step: 'typecheck', state: 'passed' },
      { step: 'lint', state: 'passed' },
    ]);
  });

  it('inserts review before commit within a compound command', () => {
    expect(recordsFor(['test', 'commit'], 'passed')).toEqual([
      { step: 'test', state: 'passed' },
      { step: 'review', state: 'reached' },
      { step: 'commit', state: 'passed' },
    ]);
  });
});
