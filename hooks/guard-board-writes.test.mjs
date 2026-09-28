import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, REASON, boardDirs } from './guard-board-writes.mjs';
import { BRANCH_TICKET_ID_RE } from '../src/shared/constants.js';

/**
 * Adversary list first, one case per DIMENSION (~/.claude/CLAUDE.md → "A guarantee needs an adversary
 * list before the code"). The dimensions this guard's state actually varies over:
 *
 *   path form   absolute · relative · `..` traversal · nested deeper · trailing separator
 *   tool        Edit · Write · NotebookEdit (notebook_path, a DIFFERENT field) · an unmatched tool
 *   payload     unparseable · parsed with no path · a non-string path · an empty path
 *   env         each override set · an empty-string override · neither, falling back to cwd
 *   board       DECLARED (an explicit override) · EVIDENCED (holds a tkt- file) · neither
 *   case        matching · differing (this filesystem is case-INSENSITIVE, so differing is the same file)
 *   target      a real board file · a look-alike outside any board · a non-ticket name inside one
 *
 * The two predicates are tested SEPARATELY as well as together, because the whole design claim is
 * that neither one's hole is load-bearing: shape catches an absolute write from a session whose cwd
 * resolves to the wrong board, root catches a file in the real board dirs whose name is not a
 * ticket id. A test that only ever satisfies both at once cannot tell a union from an intersection.
 *
 * EVERY boundary case here that asserts ALLOW is run with a board env that actually resolves, and
 * usually both ways. An earlier cut passed `env = {}` to those, which pointed the board at this
 * process's cwd and so disarmed the root predicate BEFORE the assertion ran — the test could not
 * distinguish "the guard does not over-block" from "the board happened to be somewhere else", and it
 * was the only test pinning the over-blocking boundary. That defect is what `describe('over-blocking
 * — the boundary this guard must not cross')` below exists to keep closed.
 */

const ID = 'tkt-482f9c7cc7a5';
const blocked = (filePath, env = {}, tool = 'Edit') =>
  decide({ tool_name: tool, tool_input: { file_path: filePath } }, env).blocked;

// A real declared board on disk, plus an undeclared directory that merely LOOKS like one.
let root;
let board;
let docsRepo;
let evidencedRepo;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tw-gbw-'));

  board = path.join(root, 'board');
  mkdirSync(path.join(board, 'tickets'), { recursive: true });
  mkdirSync(path.join(board, 'events'), { recursive: true });
  writeFileSync(path.join(board, 'tickets', `${ID}.md`), '---\n');

  // A repo whose tickets/ is ordinary documentation — the over-blocking victim.
  docsRepo = path.join(root, 'docs-repo');
  mkdirSync(path.join(docsRepo, 'tickets'), { recursive: true });
  mkdirSync(path.join(docsRepo, 'events'), { recursive: true });
  writeFileSync(path.join(docsRepo, 'tickets', 'README.md'), '# how we file tickets\n');

  // A board-per-repo consumer with NO override set: undeclared, but evidenced by its contents.
  evidencedRepo = path.join(root, 'evidenced-repo');
  mkdirSync(path.join(evidencedRepo, 'tickets'), { recursive: true });
  writeFileSync(path.join(evidencedRepo, 'tickets', `${ID}.md`), '---\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('shape predicate — root-independent, so a wrong cwd is not a hole', () => {
  // The case the root predicate alone would MISS: an unarmed session rooted in another repo writes
  // the board by absolute path. cwd resolves to a board that does not contain this file.
  it('blocks a ticket file by shape with no board env set at all', () => {
    expect(blocked(`/elsewhere/tickets/${ID}.md`, {})).toBe(true);
  });

  it('blocks an event file by shape with no board env set at all', () => {
    expect(blocked(`/elsewhere/events/${ID}.jsonl`, {})).toBe(true);
  });

  it('blocks a relative path, and one reaching through ..', () => {
    expect(blocked(`tickets/${ID}.md`, {})).toBe(true);
    expect(blocked(`../../tickets/${ID}.md`, {})).toBe(true);
    // Normalised before the parent is read, or this dirname is `..` and the shape check misses.
    expect(blocked(`board/tickets/sub/../${ID}.md`, {})).toBe(true);
  });

  it('pairs each extension with its own directory, never the other', () => {
    expect(blocked(`/repo/events/${ID}.md`, {})).toBe(false);
    expect(blocked(`/repo/tickets/${ID}.jsonl`, {})).toBe(false);
  });

  it('requires the id shape exactly — wrong length and non-hex fall through', () => {
    expect(blocked('/repo/tickets/tkt-abc.md', {})).toBe(false);
    expect(blocked(`/repo/tickets/${ID}x.md`, {})).toBe(false);
    expect(blocked('/repo/tickets/tkt-zzzzzzzzzzzz.md', {})).toBe(false);
  });

  it('requires the board dir to be the IMMEDIATE parent', () => {
    expect(blocked(`/repo/tickets/archive/${ID}.md`, {})).toBe(false);
  });
});

// Measured: writing through `Tickets/` overwrote the file in `tickets/` on this filesystem, so a
// byte comparison made one capital letter a total bypass.
describe('case folding — the same inode must reach the same verdict', () => {
  it('blocks a differently-cased board directory', () => {
    expect(blocked(`/elsewhere/tickets/${ID}.md`, {}), 'control: the lowercase spelling must block').toBe(true);
    expect(blocked(`/elsewhere/Tickets/${ID}.md`, {})).toBe(true);
    expect(blocked(`/elsewhere/EVENTS/${ID}.jsonl`, {})).toBe(true);
  });

  it('blocks a differently-cased ticket id', () => {
    expect(blocked(`/elsewhere/tickets/${ID.toUpperCase()}.md`, {})).toBe(true);
  });

  it('folds case in the root predicate too', () => {
    expect(blocked(path.join(board, 'TICKETS', 'scratch.md'), { BOARD_DIR_OVERRIDE: board })).toBe(true);
  });
});

describe('root predicate — catches what the shape misses inside a DECLARED board', () => {
  const declared = () => ({ BOARD_DIR_OVERRIDE: board });

  // The case the shape predicate alone would MISS: any file in the real tickets/ dir. list_tickets
  // parses every .md there, so an unparseable one lands in `unreadable` and shrinks every count.
  it('blocks a non-ticket-named file inside the declared tickets dir', () => {
    expect(blocked(path.join(board, 'tickets', 'scratch.md'), declared())).toBe(true);
  });

  it('blocks a nested file inside it, .history included — the board’s only undo', () => {
    expect(blocked(path.join(board, 'tickets', '.history', ID, 'v1.md'), declared())).toBe(true);
  });

  it('blocks inside the declared events dir', () => {
    expect(blocked(path.join(board, 'events', 'anything.log'), declared())).toBe(true);
  });

  it('allows a sibling of the board dirs', () => {
    expect(blocked(path.join(board, 'src', 'index.ts'), declared())).toBe(false);
  });

  // A prefix match on the string would block this; a path-segment comparison does not.
  it('allows a directory whose name merely starts with the board dir name', () => {
    expect(blocked(path.join(board, 'tickets-archive', 'x.md'), declared())).toBe(false);
  });

  it('refuses to treat the board dir itself as a file inside it', () => {
    expect(blocked(path.join(board, 'tickets'), declared())).toBe(false);
  });

  it('normalises .. before deciding, so traversal back into the board is caught', () => {
    expect(blocked(path.join(board, 'src', '..', 'tickets', 'scratch.md'), declared())).toBe(true);
  });

  it('honours a per-directory override as its own declaration', () => {
    const env = { TICKETS_DIR_OVERRIDE: path.join(board, 'tickets') };
    expect(blocked(path.join(board, 'tickets', 'scratch.md'), env)).toBe(true);
  });
});

/**
 * The regression that matters most. `CLAUDE_PROJECT_DIR` is set in EVERY session, so firing the root
 * predicate on it blocked every Edit into any repo whose tickets/ is documentation — measured
 * `/repo/tickets/README.md` → blocked, `/repo/events/index.ts` → blocked. Each ALLOW case here is
 * run with the board env genuinely pointing at that directory, so it cannot pass vacuously.
 */
describe('over-blocking — the boundary this guard must not cross', () => {
  it('allows ordinary docs in an UNDECLARED, unevidenced tickets/ directory', () => {
    const env = { CLAUDE_PROJECT_DIR: docsRepo };
    // The board env really does resolve here — this is the condition the earlier vacuous test lacked.
    expect(boardDirs(env)[0].dir, 'precondition: the board must resolve to this repo').toBe(path.join(docsRepo, 'tickets'));
    expect(blocked(path.join(docsRepo, 'tickets', 'README.md'), env)).toBe(false);
    expect(blocked(path.join(docsRepo, 'tickets', 'guide.md'), env)).toBe(false);
    expect(blocked(path.join(docsRepo, 'events', 'index.ts'), env)).toBe(false);
  });

  // ...but a real board file in that same directory is still caught, by shape. Losing the root
  // predicate there must not mean losing the guard.
  it('still blocks a real ticket file in that same undeclared directory', () => {
    expect(blocked(path.join(docsRepo, 'tickets', `${ID}.md`), { CLAUDE_PROJECT_DIR: docsRepo })).toBe(true);
  });

  it('DECLARING that same repo the board restores the root predicate', () => {
    expect(blocked(path.join(docsRepo, 'tickets', 'README.md'), { BOARD_DIR_OVERRIDE: docsRepo })).toBe(true);
  });

  // The board-per-repo default the README documents: no override, but the directory holds tickets.
  it('EVIDENCE restores it too — an undeclared directory that holds a tkt- file is a board', () => {
    expect(blocked(path.join(evidencedRepo, 'tickets', 'scratch.md'), { CLAUDE_PROJECT_DIR: evidencedRepo })).toBe(true);
  });

  it('treats an unreadable or absent directory as no evidence, and does not block on it', () => {
    const missing = path.join(docsRepo, 'no-such-dir');
    expect(blocked(path.join(missing, 'tickets', 'scratch.md'), { CLAUDE_PROJECT_DIR: missing })).toBe(false);
  });
});

// A stated residual, pinned so it cannot change silently in either direction. Closing it would mean
// discovering every board on the machine, which nothing here can do.
describe('residual — a non-id name in ANOTHER repo’s board is not covered', () => {
  it('allows what neither predicate can reach, and blocks the id-named file beside it', () => {
    const env = { BOARD_DIR_OVERRIDE: board };
    expect(blocked(path.join(evidencedRepo, 'tickets', `${ID}.md`), env), 'shape still reaches this').toBe(true);
    expect(blocked(path.join(evidencedRepo, 'tickets', 'scratch.md'), env)).toBe(false);
    expect(blocked(path.join(evidencedRepo, 'tickets', '.history', ID, 'v1.md'), env)).toBe(false);
  });
});

describe('boardDirs — the package precedence, mirrored', () => {
  it('prefers the per-directory overrides over the board root, and marks both declared', () => {
    const dirs = boardDirs({ BOARD_DIR_OVERRIDE: board, TICKETS_DIR_OVERRIDE: '/t', EVENTS_DIR_OVERRIDE: '/e' });
    expect(dirs.map((d) => d.dir)).toEqual([path.resolve('/t'), path.resolve('/e')]);
    expect(dirs.every((d) => d.declared)).toBe(true);
  });

  it('falls back to CLAUDE_PROJECT_DIR, then cwd — neither of which DECLARES a board', () => {
    const fromProject = boardDirs({ CLAUDE_PROJECT_DIR: board });
    expect(fromProject.map((d) => d.dir)).toEqual([path.join(board, 'tickets'), path.join(board, 'events')]);
    expect(fromProject.some((d) => d.declared), 'CLAUDE_PROJECT_DIR is not a board declaration').toBe(false);

    const fromCwd = boardDirs({});
    expect(fromCwd.map((d) => d.dir)).toEqual([path.join(process.cwd(), 'tickets'), path.join(process.cwd(), 'events')]);
    expect(fromCwd.some((d) => d.declared)).toBe(false);
  });

  // `||` not `??`, exactly as src/paths.ts documents: an empty override must fall through rather
  // than resolve the board to a relative `tickets` under cwd — and must not declare one either.
  it('lets an empty-string override fall through instead of taking it as a path', () => {
    const dirs = boardDirs({ BOARD_DIR_OVERRIDE: '', CLAUDE_PROJECT_DIR: board });
    expect(dirs.map((d) => d.dir)).toEqual([path.join(board, 'tickets'), path.join(board, 'events')]);
    expect(dirs.some((d) => d.declared), 'an empty override declares nothing').toBe(false);
    expect(boardDirs({ TICKETS_DIR_OVERRIDE: '', BOARD_DIR_OVERRIDE: board })[0].dir).toBe(path.join(board, 'tickets'));
  });

  it('resolves a relative override rather than comparing it raw', () => {
    expect(path.isAbsolute(boardDirs({ TICKETS_DIR_OVERRIDE: 'rel/tickets' })[0].dir)).toBe(true);
  });
});

// Same pin track-steps.test.mjs carries for its own inline copy: the mint, the branch-name workflow
// and this hook must agree on the id shape, or the shape predicate silently stops matching.
describe('id pattern parity with shared/constants BRANCH_TICKET_ID_RE', () => {
  it('agrees on a known-good id and on a known-bad one', () => {
    const known = 'tkt-0123456789ab';
    expect(BRANCH_TICKET_ID_RE.test(known)).toBe(true);
    expect(blocked(`/repo/tickets/${known}.md`, {})).toBe(true);
    expect(BRANCH_TICKET_ID_RE.test('tkt-XYZ')).toBe(false);
    expect(blocked('/repo/tickets/tkt-XYZ.md', {})).toBe(false);
  });
});

describe('tool surface — every matched tool, and only those', () => {
  it.each(['Edit', 'Write', 'NotebookEdit'])('blocks a board write from %s', (tool) => {
    expect(blocked(`/repo/tickets/${ID}.md`, {}, tool)).toBe(true);
  });

  // NotebookEdit names its target notebook_path, not file_path. Reading only file_path would let it
  // through while every other test stayed green.
  it('reads notebook_path, which NotebookEdit uses instead of file_path', () => {
    const payload = { tool_name: 'NotebookEdit', tool_input: { notebook_path: `/repo/tickets/${ID}.md` } };
    expect(decide(payload, {}).blocked).toBe(true);
  });

  it('judges the path, not the tool name — an unmatched tool with a board path still blocks', () => {
    // The matcher is what scopes this hook; decide() must not silently depend on it as a second gate.
    // REASON says so rather than promising reads are unaffected, which this would contradict.
    expect(blocked(`/repo/tickets/${ID}.md`, {}, 'Read')).toBe(true);
  });
});

describe('payload edges — the two fail directions, which are opposite on purpose', () => {
  // ALLOW, knowingly. Same trade as guard-worktree's armedState on a malformed session id: wedging
  // every Edit on the machine over a payload shape we cannot attribute is the worse failure. It is a
  // residual, not a guarantee.
  it('allows a parsed payload that names no path', () => {
    expect(decide({ tool_name: 'Edit', tool_input: {} }, {}).blocked).toBe(false);
    expect(decide({ tool_name: 'Edit' }, {}).blocked).toBe(false);
    expect(decide({}, {}).blocked).toBe(false);
    expect(decide(null, {}).blocked).toBe(false);
  });

  it('allows a non-string path rather than coercing it', () => {
    expect(decide({ tool_name: 'Edit', tool_input: { file_path: 42 } }, {}).blocked).toBe(false);
    expect(decide({ tool_name: 'Edit', tool_input: { file_path: ['/repo/tickets/x.md'] } }, {}).blocked).toBe(false);
  });

  it('allows an empty path string, which names nothing', () => {
    expect(decide({ tool_name: 'Edit', tool_input: { file_path: '' } }, {}).blocked).toBe(false);
  });

  it('always supplies a reason that routes to update_ticket, naming no consumer-specific command', () => {
    const { reason } = decide({ tool_name: 'Edit', tool_input: { file_path: `/repo/tickets/${ID}.md` } }, {});
    expect(reason).toBe(REASON);
    expect(reason).toContain('update_ticket');
    // tkt-0361525dbf9f: wired at user scope, this fires in every repo on the machine, so it must not
    // hand all of them a script that exists in one.
    expect(reason).not.toMatch(/npm run |just /);
    // It must not promise something decide() does not do — it judges the path, not the tool.
    expect(reason).not.toMatch(/Reading the file is unaffected/);
  });
});

describe('hook entrypoint (stdin → exit code)', () => {
  const hook = fileURLToPath(new URL('./guard-board-writes.mjs', import.meta.url));
  const run = (input, env = {}) => spawnSync('node', [hook], { input, encoding: 'utf8', env: { ...process.env, ...env } });

  it('exits 2 and surfaces the reason on a board write', () => {
    const r = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: `/repo/tickets/${ID}.md` } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('update_ticket');
  });

  it('exits 0 on an ordinary source edit', () => {
    const r = run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/index.ts' } }));
    expect(r.status, r.stderr).toBe(0);
  });

  // FAIL CLOSED. guard-worktree-precheck.mjs already exits 2 here on the same matcher set, so this
  // direction costs no availability that is not already spent, and the alternative is a guard that
  // reports success on a call it never judged.
  it('exits 2 on unparseable stdin', () => {
    expect(run('not json').status).toBe(2);
  });

  it('carries the env precedence through the real process, with a control', () => {
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(board, 'tickets', 'scratch.md') } });
    // Consulted-but-not-wired is the shape this catches: decide() reading the env proves nothing
    // about main() passing it through.
    expect(run(payload, { BOARD_DIR_OVERRIDE: board }).status).toBe(2);
    expect(run(payload, { BOARD_DIR_OVERRIDE: docsRepo }).status, 'the control must NOT block').toBe(0);
  });
});
