import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandToMilestones, extractTicketId, stateFromExit, recordsFor, HOOK_STEPS } from './track-steps.mjs';
import { STEP_IDS, BRANCH_TICKET_ID_RE } from '../src/shared/constants.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'track-steps.mjs');

// Git exports an absolute repo context into hook environments (tkt-cf1e0c0b3dda); inherited here
// it would redirect these commands at the real repo and grade the wrong branch.
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// `branch` null leaves the repo on main — a repo whose branch names no ticket is its own test case.
function initRepo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', '.'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(path.join(dir, 'f'), 'x\n');
  git(['add', 'f'], dir);
  git(['commit', '-qm', 'init'], dir);
  if (branch) git(['switch', '-qc', branch], dir);
}

// Drives the real hook once into a fresh events dir and returns that dir. Returning the DIR rather
// than the file list is what lets a caller assert which ticket's log a row landed in, and what it
// said — a filename alone cannot distinguish `review`+`commit` from `commit`.
function runHook({ command, cwd, eventsRoot, exitCode = 0 }) {
  const dir = mkdtempSync(path.join(eventsRoot, 'ev-'));
  const env = { ...process.env, EVENTS_DIR_OVERRIDE: dir };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { exit_code: exitCode },
      cwd,
    }),
    env,
    encoding: 'utf8',
  });
  return dir;
}

const filesIn = (dir) => readdirSync(dir).sort();
const stepsIn = (dir, file) =>
  readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).step);
const statesIn = (dir, file) =>
  readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).state);

// commandToMilestones pairs each milestone with the directory it acted on. `@.` renders the
// "acts on the caller's own cwd by construction" case — nothing moved and nothing was named — so
// an ordinary command reads as `test@.` and a redirected one names the repo it really ran in.
const milestonesAt = (cmd, startDir) =>
  commandToMilestones(cmd, startDir).map((m) => `${m.step}@${m.dir ?? '.'}`);

describe('commandToMilestones', () => {
  it('maps each recognized single command to its milestone', () => {
    expect(milestonesAt('git switch -c feat/tkt-abc-x')).toEqual(['branch@.']);
    expect(milestonesAt('git checkout -b feat/x')).toEqual(['branch@.']);
    expect(milestonesAt('npm run typecheck')).toEqual(['typecheck@.']);
    expect(milestonesAt('npm run lint')).toEqual(['lint@.']);
    expect(milestonesAt('npm test')).toEqual(['test@.']);
    expect(milestonesAt('npm run test:coverage')).toEqual(['test@.']);
    expect(milestonesAt('npx vitest run server')).toEqual(['test@.']);
    expect(milestonesAt('git commit -m "x"')).toEqual(['commit@.']);
    expect(milestonesAt('gh pr create --base main')).toEqual(['pr_opened@.']);
  });

  it('collects every milestone in a compound command, in order', () => {
    expect(milestonesAt('npm run typecheck && npm run lint && npm test'))
      .toEqual(['typecheck@.', 'lint@.', 'test@.']);
  });

  it('dedupes a repeated milestone in the same directory', () => {
    expect(milestonesAt('npm test && npm test')).toEqual(['test@.']);
  });

  it('sees through a simple VAR=val env prefix', () => {
    expect(milestonesAt('FOO=bar npm run lint')).toEqual(['lint@.']);
  });

  it('returns [] for non-milestone commands', () => {
    expect(milestonesAt('ls -la')).toEqual([]);
    expect(milestonesAt('git status')).toEqual([]);
    expect(milestonesAt('')).toEqual([]);
  });

  it('does not treat a plain branch switch (no -c) as a branch cut', () => {
    expect(milestonesAt('git switch main')).toEqual([]);
  });

  it('requires the real command word (not a mention inside echo)', () => {
    expect(milestonesAt('echo "npm run lint"')).toEqual([]);
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
// Which repo each milestone acts on. tkt-2734584f8715 built this parsing to REFUSE a milestone it
// could not prove was the session's; tkt-8ada0242e94e keeps every case and changes the question the
// answer feeds: not "is this ours?" but "where did it run?" — so a directory that used to mean
// "dropped" now means "attributed there". The unresolvable cases still drop, and those are the ones
// that must not move.
describe('commandToMilestones — which directory each milestone acts on (tkt-2734584f8715)', () => {
  const SESSION = '/repos/session';
  const at = (cmd, startDir = SESSION) => milestonesAt(cmd, startDir);

  it('attributes a milestone to the repo a cd moved into', () => {
    expect(at('cd /repos/other && npm test')).toEqual(['test@/repos/other']);
    expect(at('cd /repos/other && git commit -m x')).toEqual(['commit@/repos/other']);
    expect(at('cd /repos/other && npm run typecheck && npm run lint'))
      .toEqual(['typecheck@/repos/other', 'lint@/repos/other']);
  });

  // resolveDir returns null for these, and "unresolvable" must not mean "assume the session's
  // repo". That fallback is the whole of tkt-8ada0242e94e's original bug, so it stays closed.
  it('records nothing when the cd target cannot be resolved', () => {
    for (const cd of ['cd $TARGET', 'cd "$TARGET"', 'cd "/repos/my session"', "cd '/repos/my session'", 'cd ~someuser/x', 'cd -', 'cd'])
      expect(at(`${cd} && npm test`), cd).toEqual([]);
  });

  // The structural guarantee that replaced the injected is-this-ours predicate: an unresolvable
  // directory is dropped HERE, so no caller can receive one and be tempted to read it as the
  // session's. The control is what keeps this from passing on a function that matches nothing.
  it('drops an unresolvable directory rather than reporting it to the caller', () => {
    for (const cmd of ['cd $TARGET && npm test', 'cd - && npm test', 'popd && npm test', 'npm test --prefix'])
      expect(at(cmd), cmd).toEqual([]);
    for (const m of commandToMilestones('cd $TARGET && npm test', SESSION)) expect(m.dir).not.toBeNull();
    // Control: the same shapes with a resolvable target DO report, so the drops above are for being
    // unresolvable and not for failing to match a milestone at all.
    expect(at('cd /repos/other && npm test')).toEqual(['test@/repos/other']);
    expect(at('pushd /repos/other && npm test')).toEqual(['test@/repos/other']);
    expect(at('npm test --prefix /repos/other')).toEqual(['test@/repos/other']);
  });

  it('resolves a cd into the session repo, including a subdirectory', () => {
    expect(at(`cd ${SESSION} && npm test`)).toEqual([`test@${SESSION}`]);
    expect(at(`cd ${SESSION}/pkg && npm run lint`)).toEqual([`lint@${SESSION}/pkg`]);
    expect(at('cd sub && npm run lint')).toEqual([`lint@${SESSION}/sub`]);
  });

  it('scopes the cd to what follows it — a milestone before it still acts on the cwd', () => {
    expect(at('npm run lint && cd /repos/other && npm test'))
      .toEqual(['lint@.', 'test@/repos/other']);
  });

  // Adversary dimensions the cases above do not sample: returning home, chained cds, and a relative
  // cd that escapes. Each is a way the tracking could be right once and wrong on the second move.
  it('follows a later cd back to the session repo', () => {
    expect(at(`cd /repos/other && cd ${SESSION} && npm test`)).toEqual([`test@${SESSION}`]);
    expect(at(`cd /repos/other && npm run lint && cd ${SESSION} && npm test`))
      .toEqual(['lint@/repos/other', `test@${SESSION}`]);
  });

  it('follows a relative cd out of the session repo', () => {
    expect(at('cd ../other && npm test')).toEqual(['test@/repos/other']);
    // ...and back in, so "relative" is not itself treated as unresolvable.
    expect(at('cd ../other && cd ../session && npm test')).toEqual([`test@${SESSION}`]);
  });

  // A real shell restores cwd when a subshell exits, so the `outer` stack must too — in BOTH
  // directions. The second case is the one that misattributes without it: the subshell cd's home,
  // and a scan that never pops leaves `npm test` looking local when it runs in /repos/other.
  it('restores the directory when a subshell closes', () => {
    expect(at('(cd /repos/other && npm run lint) && npm test'))
      .toEqual(['lint@/repos/other', 'test@.']);
    expect(at(`cd /repos/other && (cd ${SESSION} && git log -1) && npm test`))
      .toEqual(['test@/repos/other']);
  });

  // The naive /&&|\|\||;|\n/ split let quoted DATA forge a segment: the fake `cd` was read as a
  // real move, and a milestone was attributed for a command that never ran anywhere.
  it('does not let quoted data forge a cd', () => {
    expect(at(`cd /repos/other && echo "a && cd ${SESSION} && npm test && z"`)).toEqual([]);
  });

  // matchStep keys on t[1], so these match however the directory flag is spelled after it. Keying
  // on `cd` alone left them attributed to the session's ticket.
  it('follows npm/npx directory flags, not just cd', () => {
    expect(at('npm test --prefix /repos/other')).toEqual(['test@/repos/other']);
    expect(at('npm test --prefix=/repos/other')).toEqual(['test@/repos/other']);
    expect(at('npm run lint --prefix /repos/other')).toEqual(['lint@/repos/other']);
    expect(at('npx vitest run --root /repos/other')).toEqual(['test@/repos/other']);
    expect(at('npm test --prefix')).toEqual([]); // flag with no value → unresolvable → dropped
  });

  it('resolves a directory flag pointing inside the session repo', () => {
    expect(at(`npm test --prefix ${SESSION}`)).toEqual([`test@${SESSION}`]);
    expect(at('npm test --prefix ./pkg')).toEqual([`test@${SESSION}/pkg`]);
    expect(at('npx vitest run --root .')).toEqual([`test@${SESSION}`]);
  });

  // git's -C is a GLOBAL option before the subcommand, so a -C after one is not a path. Reading
  // `git commit -C <commit>` (reuse a message) as a directory would misattribute a real milestone.
  // Making `git -C <dir>` matchable at all is tkt-f1c863f0f35c, deliberately not done here.
  it('does not mistake git commit -C <commit> for a directory', () => {
    expect(at('git commit -C HEAD~1')).toEqual(['commit@.']);
    expect(at('git commit --reuse-message=HEAD~1')).toEqual(['commit@.']);
  });

  // guard-bash names pushd as a known residual; here a missed move MISATTRIBUTES rather than
  // skipping a check, so the wider net is required.
  it('follows pushd, and treats popd as unresolvable', () => {
    expect(at('pushd /repos/other && npm test')).toEqual(['test@/repos/other']);
    expect(at(`pushd ${SESSION} && npm test`)).toEqual([`test@${SESSION}`]);
    expect(at('popd && npm test')).toEqual([]);
  });

  // `dir === startDir` read as "never moved" when BOTH were null, reporting the segment as the
  // session's. Two different unknowns must not compare equal — which is why `moved` is tracked
  // separately rather than inferred.
  it('does not read an unresolvable directory as "never moved" when startDir is absent', () => {
    for (const sd of [null, undefined, '']) {
      expect(at('cd - && npm test', sd), String(sd)).toEqual([]);
      // Control: an ABSOLUTE target needs no startDir, so it still resolves. Without this the case
      // above would also pass on a function that drops everything when startDir is missing.
      expect(at('cd /repos/other && npm test', sd), String(sd)).toEqual(['test@/repos/other']);
    }
  });

  // Everything after a bare `--` is the script's, not npm's — reading it as a repo silently
  // misattributed ordinary commands to a coverage directory.
  it('stops scanning directory flags at a bare --', () => {
    expect(at('npm test -- --dir coverage')).toEqual(['test@.']);
    expect(at('npm run test -- -C 3')).toEqual(['test@.']);
    expect(at('npm run test:coverage -- --dir x')).toEqual(['test@.']);
  });

  it('reads a repeated directory flag last-wins, as npm does', () => {
    expect(at(`npm test --prefix ${SESSION} --prefix /repos/other`)).toEqual(['test@/repos/other']);
    expect(at(`npm test --prefix /repos/other --prefix ${SESSION}`)).toEqual([`test@${SESSION}`]);
  });

  // tokenize stripped leading subshell punctuation but not trailing, so a closing segment's command
  // was invisible — which also made the subshell case above assert less than it appeared to.
  it('matches a milestone in a segment that closes a subshell', () => {
    expect(at('(npm test)')).toEqual(['test@.']);
    expect(at('(npm run typecheck && npm run lint)')).toEqual(['typecheck@.', 'lint@.']);
  });

  // splitSegments keeps a $( … ) intact, so a segment can END in a `)` that closes no subshell.
  // Counting it pops a frame nothing pushed, restoring the pre-cd directory and attributing the
  // next milestone to the wrong repo.
  it('does not treat a command substitution’s closing paren as a subshell close', () => {
    expect(at('(cd /repos/other && export SHA=$(git rev-parse HEAD) && npm test)'))
      .toEqual(['test@/repos/other']);
    expect(at('(cd /repos/other; echo $((1+1)); npm test)')).toEqual(['test@/repos/other']);
    // Control: a substitution outside any subshell must not disturb an ordinary milestone.
    expect(at('git commit -m "$(date)"')).toEqual(['commit@.']);
  });

  // A paren inside a quoted commit message closes no subshell either. An unbalanced one is the case
  // that matters: counted, it pops the frame early and attributes the rest to the session.
  it('does not count a paren inside a quoted string', () => {
    expect(at('(cd /repos/other && git commit -m "oops :)" && npm test)'))
      .toEqual(['commit@/repos/other', 'test@/repos/other']);
    expect(at('cd /repos/other && git commit -m "done :)"')).toEqual(['commit@/repos/other']);
    expect(at('git commit -m "fix(x)"')).toEqual(['commit@.']);
  });

  // dirBuiltin reads only a segment's first word, so a move behind a pipeline or a compound
  // statement read as "no move at all" and the milestone after it was attributed to the session.
  // These stay DROPPED rather than attributed, and that is a DEFERRAL, not an impossibility:
  // `hiddenDirTarget` beside it does resolve the landing directory (guard-bash already uses it that
  // way), but the caller here asks only the boolean `hiddenDirMove` and discards it. Adopting the
  // resolving variant would widen this ticket into the hidden-move path; dropping is the acceptable
  // failure meanwhile, so it waits for its own ticket.
  it('treats a directory builtin hidden behind a pipeline or compound statement as an unresolvable move', () => {
    for (const cmd of [
      'echo x | (cd /repos/other && npm test)',
      'for d in a; do (cd /repos/other && npm test); done',
      'if true; then cd /repos/other; fi; npm test',
      'while read d; do pushd /repos/other && npm test; done',
      // Grouping punctuation fused to the word after an ordinary command word — reached by neither
      // the keyword list nor the connector pattern, so only the fused-token check catches it.
      'time (cd /repos/other && npm test)',
      'nohup (cd /repos/other && npm test)',
      // A RELATIVE hidden target resolves to null, and an unresolvable resolution is still a MOVE.
      // Reading null as "no move" would attribute this to the session (tkt-3006d09810f7).
      'echo x | (cd ../other && npm test)',
    ]) expect(at(cmd), cmd).toEqual([]);
  });

  // ...without firing on the word appearing as ordinary data, which would misattribute real work.
  it('does not read the word cd inside a commit message as a move', () => {
    expect(at('git commit -m "x cd y"')).toEqual(['commit@.']);
    expect(at('npm run cd')).toEqual([]);
    expect(at('git commit -m "how to cd around"')).toEqual(['commit@.']);
  });

  // A real shell restores the OUTER subshell's directory, not the session's, when an inner one
  // closes — so lint here genuinely runs at home, and the nested case runs in /repos/other.
  it('restores one frame per nested subshell, not all of them', () => {
    expect(at('((cd /repos/other && npm test) && npm run lint)'))
      .toEqual(['test@/repos/other', 'lint@.']);
    expect(at('(cd /repos/other && (cd /repos/third && npm test) && npm run lint)'))
      .toEqual(['test@/repos/third', 'lint@/repos/other']);
    // Unbalanced on either side must not pop a frame nothing pushed, nor wedge the scan.
    expect(at('(cd /repos/other && npm test')).toEqual(['test@/repos/other']);
    expect(at('cd /repos/other && npm test)')).toEqual(['test@/repos/other']);
  });
});

// The pure-function cases above cannot see main()'s wiring: `commandToMilestones` could resolve
// every directory correctly while main() still read the ticket id from the session's branch. These
// drive the real hook end to end.
describe('hook boundary — which repo a command acts on (tkt-2734584f8715)', () => {
  const TICKET = 'tkt-abcdef123456';
  const OTHER_TICKET = 'tkt-000000000000';
  let root, session, other, worktree, events;

  const run = (command) => filesIn(runHook({ command, cwd: session, eventsRoot: events }));

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
    // A DIFFERENT ticket id on the target, so a row filed under the session is distinguishable from
    // one filed under the target — the two outcomes this block exists to tell apart.
    initRepo(other, `fix/${OTHER_TICKET}-y`);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Positive control. Without it, "wrote nothing" below would also pass on a hook that is inert,
  // mis-wired, or crashing on startup.
  it('writes the session ticket’s event for a command with no directory target', () => {
    expect(run('npm test')).toEqual([`${TICKET}.jsonl`]);
  });

  // These three used to assert []: tkt-2734584f8715 refused what it could not prove was the
  // session's. tkt-8ada0242e94e resolves the target's own branch instead, so the milestone lands on
  // the target's ticket. What must NOT change is that it never lands on the session's.
  it('writes the TARGET ticket’s event when a cd moved the command into another repo', () => {
    expect(run(`cd ${other} && npm test`)).toEqual([`${OTHER_TICKET}.jsonl`]);
    expect(run(`cd ${other} && git commit -m x`)).toEqual([`${OTHER_TICKET}.jsonl`]);
  });

  it('writes nothing when the cd target cannot be resolved', () => {
    expect(run('cd "$TARGET" && npm test')).toEqual([]);
  });

  it('still writes when the cd stays inside the session repo', () => {
    expect(run(`cd ${session} && npm test`)).toEqual([`${TICKET}.jsonl`]);
  });

  // A subdirectory is not a repo root, so this binds that the branch is read from the directory
  // rather than the path being matched against a known root.
  it('still writes from a subdirectory of the session repo', () => {
    expect(run(`cd ${path.join(session, 'sub')} && npm test`)).toEqual([`${TICKET}.jsonl`]);
  });

  it('writes the TARGET ticket’s event for an npm directory flag pointing at another repo', () => {
    expect(run(`npm test --prefix ${other}`)).toEqual([`${OTHER_TICKET}.jsonl`]);
  });

  // `<session>/coverage` does not exist, so only the real hook binds that a bare -- ends npm's
  // flags — a unit stub that resolves paths without touching git cannot tell.
  it('still writes when a directory flag sits after a bare -- (script args, not npm’s)', () => {
    expect(run('npm test -- --dir coverage')).toEqual([`${TICKET}.jsonl`]);
    expect(run('npm run test -- -C 3')).toEqual([`${TICKET}.jsonl`]);
  });

  it('writes the TARGET ticket’s event when pushd moved the command into another repo', () => {
    expect(run(`pushd ${other} && npm test`)).toEqual([`${OTHER_TICKET}.jsonl`]);
  });

  // A worktree of the session repo is on its OWN branch (`side`), which names no ticket — so
  // nothing is written, and in particular not the session's ticket. This is now the general rule
  // reaching the right answer, not a special case: put a ticket branch on the worktree and it
  // would be attributed there.
  it('writes nothing for a linked worktree whose branch names no ticket', () => {
    expect(run(`cd ${worktree} && npm test`)).toEqual([]);
  });
});

// tkt-2734584f8715 made a foreign-target milestone DROP rather than misfile. Dropping is the
// ACCEPTABLE failure, not the correct one: the work happened, and it belongs to whatever ticket the
// TARGET repo's branch names. These drive the real hook, because the pure function cannot show
// which ticket's log a row landed in — the only thing that distinguishes this fix from the bug it
// replaces.
describe('hook boundary — a milestone is attributed to the repo it ran in (tkt-8ada0242e94e)', () => {
  const A = 'tkt-aaaaaaaaaaaa'; // the SESSION's ticket — where a misfiled row would land
  const B = 'tkt-bbbbbbbbbbbb'; // the TARGET's ticket — where the work actually belongs
  let root, sessionA, sessionMain, target, plainRepo, notARepo, events;

  const fromA = (command, exitCode) => runHook({ command, cwd: sessionA, eventsRoot: events, exitCode });
  const fromMain = (command) => runHook({ command, cwd: sessionMain, eventsRoot: events });

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tw-attr-'));
    events = path.join(root, 'events');
    mkdirSync(events);
    sessionA = path.join(root, 'session-a');
    sessionMain = path.join(root, 'session-main');
    target = path.join(root, 'target');
    plainRepo = path.join(root, 'plain');
    notARepo = path.join(root, 'not-a-repo');
    initRepo(sessionA, `fix/${A}-x`);
    mkdirSync(path.join(sessionA, 'sub'));
    initRepo(sessionMain, null); // stays on main — the session branch carries no ticket id
    initRepo(target, `fix/${B}-y`);
    initRepo(plainRepo, null); // a real repo whose branch names no ticket
    mkdirSync(notARepo, { recursive: true }); // a directory in no repo at all
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Positive control. Without it every "wrote B" below would also pass on a hook that files
  // everything under the target for the wrong reason, or that ignores the session entirely.
  it('still attributes an ordinary command to the session ticket', () => {
    expect(filesIn(fromA('npm test'))).toEqual([`${A}.jsonl`]);
  });

  // Row 2 of the ticket's table — the behaviour this ticket adds. Before it, this wrote nothing.
  it('attributes a foreign-target milestone to the TARGET ticket, not the session one', () => {
    expect(filesIn(fromA(`cd ${target} && npm test`))).toEqual([`${B}.jsonl`]);
  });

  // Row 1 — a session branch carrying no id must not change WHERE the work is filed, only whether
  // the session itself could ever have claimed it.
  it('attributes to the target even when the session branch carries no ticket id', () => {
    expect(filesIn(fromMain(`cd ${target} && npm test`))).toEqual([`${B}.jsonl`]);
  });

  // Row 3, both spellings. The literal path proves the target is consulted at all; the variable
  // proves resolveDir's null is not read as "the session" — that fallback IS the original bug.
  it('records nothing for a target in no repo, literal or variable', () => {
    expect(filesIn(fromA(`cd ${notARepo} && git commit -m x`))).toEqual([]);
    expect(filesIn(fromA('cd "$TMP" && git commit -m x'))).toEqual([]);
  });

  it('records nothing for a repo whose branch carries no ticket id', () => {
    expect(filesIn(fromA(`cd ${plainRepo} && npm test`))).toEqual([]);
  });

  // One command, two repos, two tickets — the reason main() must resolve per milestone rather than
  // once. An implementation that picks a single ticket passes every case above and fails this.
  it('splits a compound command across the tickets of the repos each segment ran in', () => {
    const dir = fromA(`npm run lint && cd ${target} && npm test`);
    expect(filesIn(dir)).toEqual([`${A}.jsonl`, `${B}.jsonl`].sort());
    expect(stepsIn(dir, `${A}.jsonl`)).toEqual(['lint']);
    expect(stepsIn(dir, `${B}.jsonl`)).toEqual(['test']);
  });

  // `review` rides on a passing commit (recordsFor). It must ride to the TARGET's ticket, or a
  // foreign commit stamps the SESSION ticket's review gate — a false witness on the one milestone
  // the workflow treats as a gate.
  it('carries the derived review milestone to the target ticket', () => {
    const dir = fromA(`cd ${target} && git commit -m x`);
    expect(filesIn(dir)).toEqual([`${B}.jsonl`]);
    expect(stepsIn(dir, `${B}.jsonl`)).toEqual(['review', 'commit']);
  });

  // Every boundary case above drives a PASSING command, so none of them binds that the exit state
  // reaches the target's ticket rather than the session's — nor that `review` stays ABSENT from a
  // failed commit. Without this, an implementation that emitted `review` unconditionally alongside
  // `commit` would still pass the passing-commit case above.
  it('carries a failing exit state to the target ticket, and derives no review from it', () => {
    const dir = fromA(`cd ${target} && git commit -m x`, 1);
    expect(filesIn(dir)).toEqual([`${B}.jsonl`]);
    expect(stepsIn(dir, `${B}.jsonl`)).toEqual(['commit']);
    expect(statesIn(dir, `${B}.jsonl`)).toEqual(['failed']);
  });

  // The same step in two different repos is two milestones, not one deduped row — the dedupe is
  // per directory, and collapsing it would silently drop whichever repo came second.
  it('records the same step twice when it ran in two different repos', () => {
    const dir = fromA(`npm test && cd ${target} && npm test`);
    expect(filesIn(dir)).toEqual([`${A}.jsonl`, `${B}.jsonl`].sort());
    expect(stepsIn(dir, `${A}.jsonl`)).toEqual(['test']);
    expect(stepsIn(dir, `${B}.jsonl`)).toEqual(['test']);
  });

  // ...while two directories that are ONE repo collapse to a single row, which is why main()
  // dedupes by resolved ticket and not by directory alone.
  it('collapses two directories of one repo into a single row', () => {
    const dir = fromA(`npm test && cd ${path.join(sessionA, 'sub')} && npm test`);
    expect(filesIn(dir)).toEqual([`${A}.jsonl`]);
    expect(stepsIn(dir, `${A}.jsonl`)).toEqual(['test']);
  });
});
