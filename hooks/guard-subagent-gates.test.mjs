import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, parseGh } from './guard-subagent-gates.mjs';

const HOOK = fileURLToPath(new URL('./guard-subagent-gates.mjs', import.meta.url));

const SUB = { agent_id: 'agent_01ABC', agent_type: 'code-reviewer' };

function payload(command, extra = SUB) {
  return { tool_name: 'Bash', tool_input: { command }, ...extra };
}

// Spawns the real hook, because what the harness observes is an EXIT CODE, not a return value.
function run(input) {
  const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input });
  if (r.error) throw r.error;
  return { code: r.status, stderr: r.stderr };
}

describe('the incident: a subagent crossing a human gate', () => {
  // Each of these is a step the 2026-08-16 review subagent actually performed.
  it.each([
    ['git commit -m "wip"', 'git commit'],
    ['git push -u origin fix/x', 'git push'],
    ['gh pr create --base main --title x --body y', 'open a pull request'],
    ['gh pr merge 40 --squash --delete-branch', 'merge a pull request'],
  ])('blocks `%s`', (command, fragment) => {
    const d = decide(payload(command));
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain(fragment);
  });

  it('names the agent_type in the message', () => {
    // Echoed, never matched on — it is how the follow-up (blocking a review agent's file edits)
    // becomes answerable from a real run rather than another investigation.
    expect(decide(payload('git push')).reason).toContain('code-reviewer');
    expect(decide(payload('git push', { agent_id: 'a' })).reason).toContain('unknown');
  });

  it('exits 2 end to end — only 2 blocks; an uncaught throw would exit 1 and ALLOW', () => {
    const r = run(JSON.stringify(payload('gh pr merge 40 --squash')));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('may never cross one');
  });
});

// The control that makes every block above attributable to the SUBAGENT dimension rather than to the
// command being dangerous. Without it, a hook that blocked `git push` unconditionally would pass the
// whole suite above and wedge the main thread.
describe('the main thread is untouched', () => {
  it.each(['git commit -m x', 'git push', 'gh pr create --base main', 'gh pr merge 40 --squash'])(
    'allows `%s` when agent_id is absent',
    (command) => {
      expect(decide({ tool_name: 'Bash', tool_input: { command } }).blocked).toBe(false);
    },
  );

  it('exits 0 end to end for the main thread', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } }));
    expect(r.code).toBe(0);
  });
});

describe('a reviewer can still read and report', () => {
  // The over-restriction failure mode: a guard that leaves reviews unable to do their job. These are
  // the calls the official code-review command makes.
  it.each([
    'git log --oneline -20',
    'git diff origin/main...HEAD',
    'git show HEAD',
    'gh pr view 40 --json files',
    'gh pr diff 40',
    'gh pr list --state open',
    'gh pr checks 40',
    'gh api repos/o/r/pulls/40/comments',
    'gh pr comment 40 --body-file review.txt',
    'gh issue comment 5 --body x',
    'npm test',
    'rg "TODO" src/',
  ])('allows `%s` from a subagent', (command) => {
    expect(decide(payload(command)).blocked).toBe(false);
  });
});

describe('the disguised shapes', () => {
  it('sees a gate in any position of a compound command', () => {
    for (const command of [
      'npm test && git push',
      'git add -p; git commit -m x',
      'false || gh pr merge 40 --squash',
      'cd /tmp\ngit push origin main',
      // The exact shape the incident took: change directory into another repo, then merge there.
      // guard-bash's own main-branch rules are cwd-sensitive, so this is the shape most likely to be
      // mis-parsed (tkt-e508ad42a68a).
      'cd /Users/x/repos/some-repo && gh pr merge 40 --squash --delete-branch',
      'cd ../other-repo; gh pr create --base main --title x --body y',
    ]) {
      expect(decide(payload(command)).blocked, command).toBe(true);
    }
  });

  it('blocks a merge whether or not the PR number is explicit', () => {
    // `gh pr merge` with no number merges the PR for the CURRENT branch — the form used by this
    // project's own workflow, and the one an agent reaches for by default.
    for (const command of ['gh pr merge', 'gh pr merge --squash --delete-branch', 'gh pr merge 40']) {
      expect(decide(payload(command)).blocked, command).toBe(true);
    }
  });

  it('sees through an env prefix and `git -C <dir>`', () => {
    expect(decide(payload('GIT_AUTHOR_NAME=x git commit -m y')).blocked).toBe(true);
    expect(decide(payload('git -C /other/repo push')).blocked).toBe(true);
    // The gh half of the same shape, and the one that matters most here: `GH_TOKEN=…` is how a
    // different credential gets in front of a merge (tkt-e508ad42a68a).
    expect(decide(payload('GH_TOKEN=ghp_x gh pr merge 40 --squash')).blocked).toBe(true);
  });

  it('does NOT fire on a mention of a gate inside quoted data', () => {
    // The inverse error, and the more damaging one here: a guard that blocks a reviewer for quoting
    // the command it is reporting on would make reviews unusable.
    for (const command of [
      'echo "git push"',
      "gh pr comment 40 --body 'the PR ran git push before CI'",
      'rg "gh pr merge" .github/',
    ]) {
      expect(decide(payload(command)).blocked, command).toBe(false);
    }
  });

  it('treats `gh api` as a write only when the method is one', () => {
    expect(decide(payload('gh api repos/o/r/issues')).blocked).toBe(false);
    for (const flag of ['-X DELETE', '--method POST', '--method=PATCH']) {
      expect(decide(payload(`gh api ${flag} repos/o/r/issues/1`)).blocked, flag).toBe(true);
    }
  });
});

describe('what happens when it cannot tell', () => {
  it('BLOCKS a subagent whose command it cannot read — the rule is known to apply', () => {
    for (const input of [{ tool_input: {} }, { tool_input: { command: 42 } }, {}]) {
      const d = decide({ ...SUB, ...input });
      expect(d.blocked).toBe(true);
      expect(d.reason).toContain('could not be checked');
    }
  });

  it('treats an empty-string agent_id as a subagent, not as the main thread', () => {
    // `''` is falsy; only `undefined`/`null` mean main thread. A truthiness check here would hand a
    // subagent the main thread's permissions.
    expect(decide(payload('git push', { agent_id: '' })).blocked).toBe(true);
  });

  it('exits 1 — visible but NOT blocking — on an unreadable payload', () => {
    // Exit 1 surfaces stderr without wedging; exit 0 would be the silent fail-open. Blocking here
    // would stop every main-thread Bash call on the machine over a case the rule never covers.
    for (const raw of ['', '   ', 'not json', '{"unclosed":']) {
      const r = run(raw);
      expect(r.code, JSON.stringify(raw)).toBe(1);
      expect(r.stderr).toContain('NOT CHECKED');
    }
  });
});

describe('parseGh', () => {
  it('returns null for anything that is not a gh invocation', () => {
    for (const s of ['echo gh pr merge', 'ghost pr merge', 'git push', 'gh']) {
      expect(parseGh(s), s).toBeNull();
    }
  });

  // Found by this test, not by review: dropping only `-`-prefixed tokens left `owner/repo` as the
  // group, so `gh -R owner/repo pr merge` sailed past the gate. A repo-targeting merge is exactly the
  // shape the incident took.
  it.each([
    'gh -R owner/repo pr merge 40 --squash',
    'gh --repo owner/repo pr merge 40',
    'gh --repo=owner/repo pr merge 40',
    'gh --hostname github.com pr merge 40',
    // A BARE-WORD value (a local GHE host). The value-shaped backstop cannot see this one — nothing
    // about `localhost` says "flag value" — so it is the case that gives the named-flag skip its own
    // reason to exist. Without it a mutation deleting that skip left all 36 tests green.
    'gh --hostname localhost pr merge 40',
  ])('does not let a value-taking global flag hide the gate: %s', (command) => {
    expect(parseGh(command)).toMatchObject({ group: 'pr', verb: 'merge' });
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it('still finds the group when an UNKNOWN value-taking flag precedes it', () => {
    // The backstop: a flag added by a future gh release is not in the skip set, so its value would
    // otherwise be read as the group and the gate would go unrecognised.
    expect(parseGh('gh --future-flag some/value pr merge 40')).toMatchObject({ group: 'pr', verb: 'merge' });
  });
});
