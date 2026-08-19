import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// tkt-2734584f8715 — a command whose directory target is not (provably) the session's repo must
// record NOTHING. The bug it replaces: attribution read the session branch regardless of where the
// command ran, so foreign-mode work appended milestones to whatever ticket the session happened to
// be on. A gap reads as a gap; a misfiled row is false evidence indistinguishable from a real one.
describe('commandToMilestones — directory-target attribution guard (tkt-2734584f8715)', () => {
  const SESSION = '/repos/session';
  const inSession = (dir) => dir === SESSION || dir.startsWith(`${SESSION}/`);

  it('records nothing for a milestone a cd moved into another repo', () => {
    expect(commandToMilestones('cd /repos/other && npm test', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones('cd /repos/other && git commit -m x', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones('cd /repos/other && npm run typecheck && npm run lint', SESSION, inSession))
      .toEqual([]);
  });

  // The specific fallback this ticket closes: resolveDir returns null for these, and "unresolvable"
  // must not mean "assume the session's repo".
  it('records nothing when the cd target cannot be resolved', () => {
    for (const cd of ['cd $TARGET', 'cd "$TARGET"', 'cd "/repos/my session"', "cd '/repos/my session'", 'cd ~someuser/x', 'cd -', 'cd'])
      expect(commandToMilestones(`${cd} && npm test`, SESSION, inSession), cd).toEqual([]);
  });

  it('still records a cd into the session repo, including a subdirectory', () => {
    expect(commandToMilestones(`cd ${SESSION} && npm test`, SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones(`cd ${SESSION}/pkg && npm run lint`, SESSION, inSession)).toEqual(['lint']);
    expect(commandToMilestones('cd sub && npm run lint', SESSION, inSession)).toEqual(['lint']);
  });

  it('drops only what follows the cd — a milestone before it still records', () => {
    expect(commandToMilestones('npm run lint && cd /repos/other && npm test', SESSION, inSession))
      .toEqual(['lint']);
  });

  // Adversary dimensions the cases above do not sample: returning home, chained cds, a relative cd
  // that escapes, and a predicate that throws. Each is a way the guard could be right once and
  // wrong on the second move.
  it('records again once a later cd returns to the session repo', () => {
    expect(commandToMilestones(`cd /repos/other && cd ${SESSION} && npm test`, SESSION, inSession))
      .toEqual(['test']);
    expect(commandToMilestones(`cd /repos/other && npm run lint && cd ${SESSION} && npm test`, SESSION, inSession))
      .toEqual(['test']);
  });

  it('follows a relative cd out of the session repo', () => {
    expect(commandToMilestones('cd ../other && npm test', SESSION, inSession)).toEqual([]);
    // ...and back in, so "relative" is not itself treated as unresolvable.
    expect(commandToMilestones('cd ../other && cd ../session && npm test', SESSION, inSession))
      .toEqual(['test']);
  });

  // A real shell restores cwd when a subshell exits, so the `outer` stack must too — in BOTH
  // directions. The second case is the one that misfiles without it: the subshell cd's home, and a
  // guard that never pops leaves `npm test` looking local when it actually runs in /repos/other.
  it('restores the directory when a subshell closes', () => {
    expect(commandToMilestones('(cd /repos/other && npm run lint) && npm test', SESSION, inSession))
      .toEqual(['test']);
    expect(commandToMilestones(`cd /repos/other && (cd ${SESSION} && git log -1) && npm test`, SESSION, inSession))
      .toEqual([]);
  });

  // The naive /&&|\|\||;|\n/ split let quoted DATA forge a segment: the fake `cd` cleared the
  // guard and a milestone was recorded for a command that never ran anywhere.
  it('does not let quoted data forge a cd that clears the guard', () => {
    expect(commandToMilestones(`cd /repos/other && echo "a && cd ${SESSION} && npm test && z"`, SESSION, inSession))
      .toEqual([]);
  });

  // matchStep keys on t[1], so these match however the directory flag is spelled after it. Hooking
  // the guard on `cd` alone left them filing under the session's ticket.
  it('follows npm/npx directory flags, not just cd', () => {
    for (const cmd of [
      'npm test --prefix /repos/other',
      'npm test --prefix=/repos/other',
      'npm run lint --prefix /repos/other',
      'npx vitest run --root /repos/other',
      'npm test --prefix',           // flag with no value → unresolvable → closed
    ]) expect(commandToMilestones(cmd, SESSION, inSession), cmd).toEqual([]);
  });

  it('still records when a directory flag points inside the session repo', () => {
    expect(commandToMilestones(`npm test --prefix ${SESSION}`, SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('npm test --prefix ./pkg', SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('npx vitest run --root .', SESSION, inSession)).toEqual(['test']);
  });

  // git's -C is a GLOBAL option before the subcommand, so a -C after one is not a path. Reading
  // `git commit -C <commit>` (reuse a message) as a directory would drop a legitimate milestone.
  it('does not mistake git commit -C <commit> for a directory', () => {
    expect(commandToMilestones('git commit -C HEAD~1', SESSION, inSession)).toEqual(['commit']);
    expect(commandToMilestones('git commit --reuse-message=HEAD~1', SESSION, inSession)).toEqual(['commit']);
  });

  // guard-bash names pushd as a known residual; here a missed move MISFILES rather than skipping a
  // check, so the wider net is required.
  it('follows pushd, and treats popd as unresolvable', () => {
    expect(commandToMilestones('pushd /repos/other && npm test', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones(`pushd ${SESSION} && npm test`, SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('popd && npm test', SESSION, inSession)).toEqual([]);
  });

  // `dir === startDir` read as "never moved" when BOTH were null, admitting the segment unchecked.
  // Two different unknowns must not compare equal.
  it('does not admit an unresolvable directory when startDir is absent', () => {
    for (const sd of [null, undefined, '']) {
      expect(commandToMilestones('cd - && npm test', sd, inSession), String(sd)).toEqual([]);
      expect(commandToMilestones('cd /repos/other && npm test', sd, inSession), String(sd)).toEqual([]);
    }
  });

  // Everything after a bare `--` is the script's, not npm's — reading it as a repo silently and
  // permanently dropped milestones from ordinary commands.
  it('stops scanning directory flags at a bare --', () => {
    expect(commandToMilestones('npm test -- --dir coverage', SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('npm run test -- -C 3', SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('npm run test:coverage -- --dir x', SESSION, inSession)).toEqual(['test']);
  });

  it('reads a repeated directory flag last-wins, as npm does', () => {
    expect(commandToMilestones(`npm test --prefix ${SESSION} --prefix /repos/other`, SESSION, inSession))
      .toEqual([]);
    expect(commandToMilestones(`npm test --prefix /repos/other --prefix ${SESSION}`, SESSION, inSession))
      .toEqual(['test']);
  });

  // tokenize stripped leading subshell punctuation but not trailing, so a closing segment's command
  // was invisible — which also made the subshell case above assert less than it appeared to.
  it('matches a milestone in a segment that closes a subshell', () => {
    expect(commandToMilestones('(npm test)', SESSION, inSession)).toEqual(['test']);
    expect(commandToMilestones('(npm run typecheck && npm run lint)', SESSION, inSession))
      .toEqual(['typecheck', 'lint']);
  });

  // splitSegments keeps a $( … ) intact, so a segment can END in a `)` that closes no subshell.
  // Counting it popped a frame nothing pushed, restoring the pre-cd directory and admitting the
  // next milestone unproven.
  it('does not treat a command substitution’s closing paren as a subshell close', () => {
    expect(commandToMilestones('(cd /repos/other && export SHA=$(git rev-parse HEAD) && npm test)', SESSION, inSession))
      .toEqual([]);
    expect(commandToMilestones('(cd /repos/other; echo $((1+1)); npm test)', SESSION, inSession))
      .toEqual([]);
    // Control: a substitution outside any subshell must not disturb an ordinary milestone.
    expect(commandToMilestones('git commit -m "$(date)"', SESSION, inSession)).toEqual(['commit']);
  });

  // A paren inside a quoted commit message closes no subshell either. An unbalanced one is the
  // case that matters: counted, it pops the frame early and admits the rest as the session's.
  it('does not count a paren inside a quoted string', () => {
    expect(commandToMilestones('(cd /repos/other && git commit -m "oops :)" && npm test)', SESSION, inSession))
      .toEqual([]);
    expect(commandToMilestones('cd /repos/other && git commit -m "done :)"', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones('git commit -m "fix(x)"', SESSION, inSession)).toEqual(['commit']);
  });

  // dirBuiltin reads only a segment's first word, so a move behind a pipeline or a compound
  // statement read as "no move at all" and the milestone after it was admitted as the session's.
  it('treats a directory builtin hidden behind a pipeline or compound statement as a move', () => {
    for (const cmd of [
      'echo x | (cd /repos/other && npm test)',
      'for d in a; do (cd /repos/other && npm test); done',
      'if true; then cd /repos/other; fi; npm test',
      'while read d; do pushd /repos/other && npm test; done',
      // Grouping punctuation fused to the word after an ordinary command word — reached by neither
      // the keyword list nor the connector pattern, so only the fused-token check catches it.
      'time (cd /repos/other && npm test)',
      'nohup (cd /repos/other && npm test)',
    ]) expect(commandToMilestones(cmd, SESSION, inSession), cmd).toEqual([]);
  });

  // ...without firing on the word appearing as ordinary data, which would drop real milestones.
  it('does not read the word cd inside a commit message as a move', () => {
    expect(commandToMilestones('git commit -m "x cd y"', SESSION, inSession)).toEqual(['commit']);
    expect(commandToMilestones('npm run cd', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones('git commit -m "how to cd around"', SESSION, inSession)).toEqual(['commit']);
  });

  // A real shell restores the OUTER subshell's directory, not the session's, when an inner one
  // closes — so lint here genuinely runs at home and must still record.
  it('restores one frame per nested subshell, not all of them', () => {
    expect(commandToMilestones('((cd /repos/other && npm test) && npm run lint)', SESSION, inSession))
      .toEqual(['lint']);
    expect(commandToMilestones('(cd /repos/other && (cd /repos/third && npm test) && npm run lint)', SESSION, inSession))
      .toEqual([]);
    // Unbalanced on either side must not pop a frame nothing pushed, nor wedge the scan.
    expect(commandToMilestones('(cd /repos/other && npm test', SESSION, inSession)).toEqual([]);
    expect(commandToMilestones('cd /repos/other && npm test)', SESSION, inSession)).toEqual([]);
  });

  // "Can't tell" is not a match: a predicate returning a truthy non-boolean is an answer the guard
  // cannot interpret, and must not take the permissive branch.
  it('accepts only a strict true from the predicate', () => {
    for (const p of [() => 'yes', () => 1, () => ({}), () => undefined, () => null])
      expect(commandToMilestones('cd /repos/other && npm test', SESSION, p)).toEqual([]);
    expect(commandToMilestones(`cd ${SESSION} && npm test`, SESSION, () => true)).toEqual(['test']);
  });

  it('propagates a throwing predicate rather than treating the failure as a match', () => {
    const throws = () => { throw new Error('git unavailable'); };
    expect(() => commandToMilestones('cd /repos/other && npm test', SESSION, throws)).toThrow();
  });

  // Fail-closed default: a caller that forgets the predicate must not get the permissive answer.
  it('records nothing for a cd-carrying command when no session predicate is supplied', () => {
    expect(commandToMilestones('cd /repos/other && npm test')).toEqual([]);
    // Control: the same command with no cd is unaffected by the guard.
    expect(commandToMilestones('npm test')).toEqual(['test']);
  });
});

// The pure-function cases above cannot see main()'s wiring: `commandToMilestones` could be perfect
// while main() never passes it a predicate. This drives the real hook end to end.
describe('hook boundary — foreign-target commands write no event (tkt-2734584f8715)', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'track-steps.mjs');
  const TICKET = 'tkt-abcdef123456';
  let root, session, other, worktree, events;

  // Git exports an absolute repo context into hook environments (tkt-cf1e0c0b3dda); inherited here
  // it would redirect these commands at the real repo and grade the wrong branch.
  const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  function initRepo(dir, branch) {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], dir);
    git(['config', 'user.email', 't@t'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(path.join(dir, 'f'), 'x\n');
    git(['add', 'f'], dir);
    git(['commit', '-qm', 'init'], dir);
    git(['switch', '-qc', branch], dir);
  }

  // Returns the event files written by one hook invocation, into a fresh events dir each time.
  function run(command) {
    const dir = mkdtempSync(path.join(events, 'ev-'));
    const env = { ...process.env, EVENTS_DIR_OVERRIDE: dir };
    for (const key of GIT_CONTEXT_VARS) delete env[key];
    spawnSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { exit_code: 0 },
        cwd: session,
      }),
      env,
      encoding: 'utf8',
    });
    return readdirSync(dir);
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tw-track-'));
    session = path.join(root, 'session');
    other = path.join(root, 'other');
    events = path.join(root, 'events');
    mkdirSync(events);
    initRepo(session, `fix/${TICKET}-x`);
    mkdirSync(path.join(session, 'sub'));
    worktree = path.join(root, 'wt');
    git(['worktree', 'add', '-q', '-b', 'side', worktree], session);
    // A DIFFERENT ticket id on the target, so a misfiled row is distinguishable from a correct one.
    initRepo(other, 'fix/tkt-000000000000-y');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Positive control. Without it, "wrote nothing" below would also pass on a hook that is inert,
  // mis-wired, or crashing on startup.
  it('writes the session ticket’s event for a command with no directory target', () => {
    expect(run('npm test')).toEqual([`${TICKET}.jsonl`]);
  });

  it('writes nothing when a cd moved the command into another repo', () => {
    expect(run(`cd ${other} && npm test`)).toEqual([]);
    expect(run(`cd ${other} && git commit -m x`)).toEqual([]);
  });

  it('writes nothing when the cd target cannot be resolved', () => {
    expect(run('cd "$TARGET" && npm test')).toEqual([]);
  });

  it('still writes when the cd stays inside the session repo', () => {
    expect(run(`cd ${session} && npm test`)).toEqual([`${TICKET}.jsonl`]);
  });

  // The unit cases above use a prefix-matching stub, which would stay green even if the predicate
  // compared paths instead of repo ROOTS. Only a real subdirectory against real git binds that.
  it('still writes from a subdirectory of the session repo', () => {
    expect(run(`cd ${path.join(session, 'sub')} && npm test`)).toEqual([`${TICKET}.jsonl`]);
  });

  it('writes nothing for an npm directory flag pointing at another repo', () => {
    expect(run(`npm test --prefix ${other}`)).toEqual([]);
  });

  // The unit stub matches prefixes, so `<session>/coverage` passes it while real repoRoot() returns
  // null for a directory that does not exist. Only the real hook binds these.
  it('still writes when a directory flag sits after a bare -- (script args, not npm’s)', () => {
    expect(run('npm test -- --dir coverage')).toEqual([`${TICKET}.jsonl`]);
    expect(run('npm run test -- -C 3')).toEqual([`${TICKET}.jsonl`]);
  });

  it('writes nothing when pushd moved the command into another repo', () => {
    expect(run(`pushd ${other} && npm test`)).toEqual([]);
  });

  // A worktree is a different branch, so the session's ticket would be the wrong one. Dropping is
  // correct here; attributing to the worktree's OWN branch is tkt-8ada0242e94e's job.
  it('writes nothing for a linked worktree of the session repo', () => {
    expect(run(`cd ${worktree} && npm test`)).toEqual([]);
  });
});
