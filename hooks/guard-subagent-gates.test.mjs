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

describe('merge is the one human gate a subagent may not cross', () => {
  it.each([
    ['gh pr merge 40 --squash --delete-branch', 'merge a pull request'],
    ['gh pr merge --auto --squash', 'merge a pull request'],
  ])('blocks `%s`', (command, fragment) => {
    const d = decide(payload(command));
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain(fragment);
  });

  it('names the agent_type in the message', () => {
    // Echoed, never matched on — it is how the follow-up (blocking a review agent's file edits)
    // becomes answerable from a real run rather than another investigation.
    expect(decide(payload('gh pr merge 40')).reason).toContain('code-reviewer');
    expect(decide(payload('gh pr merge 40', { agent_id: 'a' })).reason).toContain('unknown');
  });

  it('exits 2 end to end — only 2 blocks; an uncaught throw would exit 1 and ALLOW', () => {
    const r = run(JSON.stringify(payload('gh pr merge 40 --squash')));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Merge is a human approval gate');
  });
});

// The workflow rewrite (docs/specs/workflow-rewrite.md) lets the review/fix step commit and open the PR
// as a subagent.
describe('commit and PR-open are no longer gates', () => {
  it.each([
    'git commit -m "wip"',
    'gh pr create --base main --title x --body y',
    'gh pr edit 40 --body y',
    'gh pr ready 40',
    'npm test && git add hooks/x.mjs && git commit -m x',
    'time git commit -m x',
  ])('allows `%s` from a subagent', (command) => {
    expect(decide(payload(command)).blocked).toBe(false);
  });

  it('exits 0 end to end for a subagent commit', () => {
    expect(run(JSON.stringify(payload('git commit -m x'))).code).toBe(0);
  });
});

// guard-bash cannot judge every push shape for main: two review rounds on tkt-e8b257fc8cc4 measured
// --mirror, --all, wildcards, -c/GIT_CONFIG, --git-dir/GIT_DIR, other remotes and tags all passing it.
// Push therefore stays gated in every shape, the plain one included.
describe('a subagent push is refused in every shape', () => {
  it.each([
    'git push -u origin fix/x',
    'git push origin HEAD',
    'git push --mirror origin',
    'git push --all origin',
    'git -c remote.origin.push=HEAD:refs/heads/main push origin',
    'GIT_DIR=../primary/.git git push origin HEAD',
    'git --git-dir=/r/primary/.git push origin HEAD',
    'git push upstream master',
    'git push origin v0.30.0',
    'git -C /other/repo push',
    'time git push --all',
    'npm test && git commit -m x && git push -u origin fix/x',
  ])('blocks `%s`', (command) => {
    const d = decide(payload(command));
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('git push');
  });

  it('still refuses a git subcommand an unterminated quote swallowed', () => {
    expect(decide(payload('git -C "/a/b push origin x')).blocked).toBe(true);
  });
});

describe('destructive gh verbs stay blocked', () => {
  it.each([
    'gh pr close 40',
    'gh pr reopen 40',
    'gh pr review 40 --approve',
    'gh release create v1.0.0',
    'gh release edit v1 --draft=false',
    'gh release upload v1 a.tgz --clobber',
    'gh release delete v1.0.0',
    'gh repo delete o/r --yes',
    'gh repo edit --visibility public --accept-visibility-change-consequences',
    'gh repo edit --default-branch fix/x',
    'gh repo archive o/r',
    'gh issue delete 5',
    'gh secret set TOKEN',
    'gh workflow run merge.yml',
    'gh run rerun 123',
    'gh alias set pm "pr merge" && gh pm 40',
    'gh extension install o/gh-x',
    'gh repo sync o/fork --force',
    'gh repo sync o/r --source o/other -b main',
  ])('blocks `%s` from a subagent', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  // gh's built-in aliases (gh 2.95.0 `--help` → ALIASES) reach the same commands.
  it.each(['gh ext install o/gh-x', 'gh extensions install o/gh-x', 'gh release new v1', 'gh secret remove FOO', 'gh variable remove FOO'])(
    'blocks the built-in alias `%s`',
    (command) => {
      expect(decide(payload(command)).blocked).toBe(true);
    },
  );
});

// The control that makes every block above attributable to the SUBAGENT dimension rather than to the
// command being dangerous. Without it, a hook that blocked `git push` unconditionally would pass the
// whole suite above and wedge the main thread.
describe('the main thread is untouched', () => {
  it.each(['gh pr merge 40 --squash', 'git push -u origin fix/x', 'gh api -X PUT repos/o/r/pulls/40/merge', 'gh repo delete o/r'])(
    'allows `%s` when agent_id is absent',
    (command) => {
      expect(decide({ tool_name: 'Bash', tool_input: { command } }).blocked).toBe(false);
    },
  );

  it('exits 0 end to end for the main thread', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 40' } }));
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
      'npm test && gh pr merge 40',
      'git push; gh pr merge 40 --squash',
      'false || gh pr merge 40 --squash',
      'cd /tmp\ngh pr merge 40',
      // The exact shape the incident took: change directory into another repo, then merge there.
      // guard-bash's own main-branch rules are cwd-sensitive, so this is the shape most likely to be
      // mis-parsed (tkt-e508ad42a68a).
      'cd /Users/x/repos/some-repo && gh pr merge 40 --squash --delete-branch',
      'cd ../other-repo; gh pr create --base main --title x --body y && gh pr merge --auto',
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

  it('sees through an env prefix', () => {
    // `GH_TOKEN=…` is how a different credential gets in front of a merge (tkt-e508ad42a68a).
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
    for (const flag of ['-X DELETE', '--method POST', '--method=PATCH', '-XPUT', '-Xput']) {
      expect(decide(payload(`gh api ${flag} repos/o/r/issues/1`)).blocked, flag).toBe(true);
    }
  });

  // gh sends POST whenever a parameter is added (`gh api --help`), so "no -X" is not "GET". Reading it
  // as GET let a GraphQL mergePullRequest mutation, or a REST merge, through as a read.
  it.each([
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    'gh api repos/o/r/pulls/40/merge -f merge_method=squash',
    'gh api repos/o/r/merges -F base=main -F head=fix/x',
    'gh api repos/o/r/pulls/40/merge --raw-field merge_method=squash',
    'gh api repos/o/r/pulls/40/merge --field=merge_method=squash',
    'gh api repos/o/r/pulls/40/merge --input body.json',
    'gh api repos/o/r/pulls/40/merge -fmerge_method=squash',
  ])('blocks an implicit-POST write: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it('an explicit GET without parameters is a read', () => {
    expect(decide(payload('gh api -X GET repos/o/r/pulls/40')).blocked).toBe(false);
    expect(decide(payload('gh api --method=get repos/o/r/pulls -q .[].number')).blocked).toBe(false);
  });

  // Whitespace tokenizing cannot tell a real `-X GET` from one inside a quoted value, before OR after
  // the parameter, so a stated GET never downgrades a parameterised call (review, tkt-e8b257fc8cc4).
  it.each([
    "gh api graphql -f query='mutation -X GET { mergePullRequest }'",
    'gh api repos/o/r/pulls/40/merge -f a=b --method=GET',
    "gh api -H 'x -X GET y' graphql -f query='mutation{mergePullRequest}'",
    'gh api -X GET search/issues -f q=repo:o/r',
  ])('a stated GET cannot downgrade a parameterised call: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  // gh's flag parser expands a short cluster, so `-iXPOST` is `-i -X POST` and `-if` is `-i -f`.
  it.each([
    'gh api -iXPOST repos/o/r/pulls/40/merge',
    "gh api graphql -if query='mutation{mergePullRequest}'",
    'gh api graphql -iF query=@q.graphql',
    'gh api -iX PUT repos/o/r/pulls/40/merge',
    'gh api -X HEAD repos/o/r',
    'gh api -X',
  ])('reads a clustered or unrecognised method as a write: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it('CONTROL: `-i` alone is still a read', () => {
    expect(decide(payload('gh api -i repos/o/r/pulls/40')).blocked).toBe(false);
  });
});

// parseGh read only `VAR=` prefixes before the command word, so a reserved word, a wrapper or a path
// spelling put `gh` in a slot it never looked at — and merge is now this hook's only gate
// (tkt-bcc4f31c5b0a). Same-line forms only: a newline already splits the segment.
describe('the leading run before gh', () => {
  it.each([
    'true; then gh pr merge --squash; fi',
    'for x in a; do gh pr merge 40; done',
    'if false; then :; else gh pr merge 40; fi',
    'if false; then :; elif true; then gh pr merge 40; fi',
    'if gh pr merge 40; then :; fi',
    'while gh pr merge 40; do break; done',
    'until gh pr merge 40; do :; done',
    '! gh pr merge 40',
    'true; then ( gh pr merge 40 ); fi',
    'true; then (gh pr merge 40); fi',
    '{ gh pr merge 40; }',
  ])('a reserved word does not hide the merge: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it.each([
    'time gh pr merge 40',
    'nohup gh pr merge 40',
    'env gh pr merge 40',
    'command gh pr merge 40',
    'exec gh pr merge 40',
    'sudo -E gh pr merge 40',
    'time -p gh pr merge 40',
    'then GH_HOST=x time gh pr merge 40',
    'GH_TOKEN=x nohup env gh pr merge 40',
  ])('a wrapper does not hide the merge: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it.each([
    '/opt/homebrew/bin/gh pr merge 40',
    '/usr/local/bin/gh pr merge 40 --squash',
    './gh pr merge 40',
    'time /opt/homebrew/bin/gh pr merge 40',
  ])('a path spelling of gh does not hide the merge: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(true);
  });

  it.each([
    'echo then gh pr merge 40',
    'echo gh pr merge',
    'echo time gh pr merge 40',
    '/opt/homebrew/bin/ghx pr merge 40',
    './not-gh pr merge 40',
    'time gh pr view 40',
    'then gh pr view 40',
    '/opt/homebrew/bin/gh pr view 40',
  ])('CONTROL: data, other binaries and reads stay allowed: %s', (command) => {
    expect(decide(payload(command)).blocked).toBe(false);
  });

  it('parses the group and verb past the leading run', () => {
    expect(parseGh('then GH_HOST=x time -p /opt/homebrew/bin/gh -R o/r pr merge 40'))
      .toMatchObject({ group: 'pr', verb: 'merge' });
  });

  // KNOWN GAPS, pinned so this suite is not read as full coverage; each is a follow-up under epic
  // tkt-d841316d04f7 (review of tkt-bcc4f31c5b0a). Flip to `true` as each lands.
  it.each([
    ['value-taking wrapper flag', 'sudo -u root gh pr merge 40'],
    ['value-taking wrapper flag', 'nice -n 5 gh pr merge 40'],
    ['path-spelled wrapper', '/usr/bin/env gh pr merge 40'],
    ['wrapper outside the set', 'timeout 60 gh pr merge 40'],
    ['quoted env value with a space', 'GH_TOKEN="a b" gh pr merge 40'],
    ['escaped command word', '\\gh pr merge 40'],
    ['quoted command word', '"gh" pr merge 40'],
    ['leading redirection', '2>/dev/null gh pr merge 40'],
    ['single & is not a split point', 'true & gh pr merge 40'],
    ['coproc', 'coproc gh pr merge 40'],
    ['keyword fused to (', 'true; then(gh pr merge 40); fi'],
    ['case arm', 'case x in *) gh pr merge 40;; esac'],
    ['path-spelled git push', '/usr/bin/git push origin main'],
  ])('KNOWN GAP (%s): %s', (_label, command) => {
    expect(decide(payload(command)).blocked).toBe(false);
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
    expect(decide(payload('gh pr merge 40', { agent_id: '' })).blocked).toBe(true);
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

