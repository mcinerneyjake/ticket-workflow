import { describe, it, expect } from 'vitest';
import { checkSpecs, formatSpecReport, indexedCommits, specsExitCode, SPECS_EXIT, SPEC_INDEX_PATH } from './probe.js';
import type { Exec, ExecResult } from '../audit/types.js';
import type { SpecBoardListing } from '../server/tickets.js';
import type { StatusId, Ticket } from '../shared/constants.js';

const REPO = 'acme/widgets';
const PATH = 'docs/specs/thing.md';
const SHA = 'abc1234def'.padEnd(40, '0');

// The shapes gh actually produced, measured 2026-10-06 (see the ticket's "Instrument facts").
const found = (stdout: string): ExecResult => ({ kind: 'ran', ok: true, status: 0, stdout, stderr: '' });
const notFound: ExecResult = { kind: 'ran', ok: false, status: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' };
const authFailure: ExecResult = { kind: 'ran', ok: false, status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n' };

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const permalink = (sha = SHA, repo = REPO, path = PATH) => `https://github.com/${repo}/blob/${sha}/${path}`;

/** A fake gh keyed by endpoint; unlisted endpoints 404, and every call is recorded. */
function fakeGh(routes: Record<string, ExecResult>) {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    expect(cmd).toBe('gh');
    const endpoint = args[1];
    calls.push(endpoint);
    return routes[endpoint] ?? notFound;
  };
  return { exec, calls };
}

const repoRoute = (branch = 'main') => ({ [`repos/${REPO}`]: found(branch) });
const fileRoute = (ref: string, path = PATH) => `repos/${REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`;
const indexRoute = (ref = 'main') => `repos/${REPO}/contents/${SPEC_INDEX_PATH}?ref=${encodeURIComponent(ref)}`;

function ticket(id: string, status: StatusId, spec: string | null = `${REPO}:${PATH}`): Ticket {
  return {
    id, title: id, type: 'task', priority: 'medium', status, order: 0, created: '', updated: '', body: '',
    project: null, blockers: [], parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec, source: null, runId: null,
  };
}

function board(specTickets: Ticket[], extra: Partial<SpecBoardListing> = {}): SpecBoardListing {
  return { specTickets, malformedSpec: [], unreadable: [], ticketFiles: Math.max(1, specTickets.length), ...extra };
}

const run = (b: SpecBoardListing, routes: Record<string, ExecResult>) => {
  const gh = fakeGh(routes);
  const report = checkSpecs(b, gh.exec);
  return { report, code: specsExitCode(report), calls: gh.calls };
};

describe('checkSpecs — open spec tickets', () => {
  it.each(['backlog', 'todo', 'in-progress', 'qa'] as const)('is clean when the file resolves on the default branch (%s)', (status) => {
    const { report, code } = run(board([ticket('tkt-1', status)]), { ...repoRoute(), [fileRoute('main')]: found('file') });
    expect(code).toBe(SPECS_EXIT.CLEAN);
    expect(report.clean).toEqual([`tkt-1: ${REPO}:${PATH} resolves on main`]);
  });

  it('reads the default branch rather than assuming main', () => {
    const { code, calls } = run(board([ticket('tkt-1', 'todo')]), { ...repoRoute('trunk/2'), [fileRoute('trunk/2')]: found('file') });
    expect(code).toBe(SPECS_EXIT.CLEAN);
    expect(calls).toContain(`repos/${REPO}/contents/${PATH}?ref=trunk%2F2`);
  });

  it('is a finding when the file does not exist on the default branch', () => {
    const { report, code } = run(board([ticket('tkt-1', 'todo')]), repoRoute());
    expect(code).toBe(SPECS_EXIT.FINDINGS);
    expect(report.findings).toEqual([`tkt-1 (todo): ${REPO}:${PATH} does not exist on main`]);
  });

  it('asks for the default branch once per repo, whatever the spelling of its owner', () => {
    const tickets = [ticket('tkt-1', 'todo'), ticket('tkt-2', 'todo', `ACME/Widgets:${PATH}`)];
    const { calls } = run(board(tickets), { ...repoRoute(), [fileRoute('main')]: found('file') });
    expect(calls.filter((c) => c === `repos/${REPO}`)).toHaveLength(1);
  });
});

describe('checkSpecs — finished spec tickets', () => {
  const indexed = (index: string) => ({ ...repoRoute(), [indexRoute()]: found(b64(index)), [fileRoute(SHA)]: found('file') });

  it('is clean when deleted from main and indexed by a resolving permalink', () => {
    const { report, code } = run(board([ticket('tkt-1', 'done')]), indexed(`- [thing](${permalink()}) — finished`));
    expect(code).toBe(SPECS_EXIT.CLEAN);
    expect(report.clean).toEqual([`tkt-1: ${REPO}:${PATH} finished and indexed (${SHA})`]);
  });

  it('is a finding when a finished spec is still on the default branch', () => {
    const routes = { ...indexed(`${permalink()}`), [fileRoute('main')]: found('file') };
    const { report, code } = run(board([ticket('tkt-1', 'done')]), routes);
    expect(code).toBe(SPECS_EXIT.FINDINGS);
    expect(report.findings).toEqual([`tkt-1 (done): finished spec ${REPO}:${PATH} is still on main; delete it and index its permalink`]);
    expect(report.clean).toEqual([]);
  });

  it('is a finding when the repo has no index file', () => {
    const { report, code } = run(board([ticket('tkt-1', 'done')]), repoRoute());
    expect(code).toBe(SPECS_EXIT.FINDINGS);
    expect(report.findings).toEqual([`tkt-1 (done): ${REPO} has no ${SPEC_INDEX_PATH} on main to index ${PATH}`]);
  });

  it.each([
    ['no permalink at all', '# Finished specs\n'],
    ['a permalink to another path', permalink(SHA, REPO, 'docs/specs/other.md')],
    ['a permalink to another repo', permalink(SHA, 'acme/gadgets')],
    ['a path that merely starts the same', permalink(SHA, REPO, `${PATH}x`)],
  ])('is a finding when the index has %s', (_label, index) => {
    const { report, code } = run(board([ticket('tkt-1', 'done')]), indexed(index));
    expect(code).toBe(SPECS_EXIT.FINDINGS);
    expect(report.findings).toEqual([`tkt-1 (done): ${PATH} has no permalink in ${REPO}:${SPEC_INDEX_PATH}`]);
  });

  it('lists an archived spec ticket as retired without asking gh anything, and stays clean', () => {
    const { report, code, calls } = run(board([ticket('tkt-1', 'archived')]), {});
    expect(code).toBe(SPECS_EXIT.CLEAN);
    expect(report.retired).toEqual([`tkt-1: archived; ${REPO}:${PATH} not checked`]);
    expect(calls).toEqual([]);
  });

  it('reads the index once per repo and ref', () => {
    const tickets = [ticket('tkt-1', 'done'), ticket('tkt-2', 'done', `${REPO}:docs/specs/other.md`)];
    const routes = { ...indexed(`${permalink()}\n${permalink(SHA, REPO, 'docs/specs/other.md')}`), [fileRoute(SHA, 'docs/specs/other.md')]: found('file') };
    const { code, calls } = run(board(tickets), routes);
    expect(code).toBe(SPECS_EXIT.CLEAN);
    expect(calls.filter((c) => c === indexRoute())).toHaveLength(1);
  });

  it('is a finding when the permalink commit does not contain the file', () => {
    const routes = { ...repoRoute(), [indexRoute()]: found(b64(permalink())) };
    const { report, code } = run(board([ticket('tkt-1', 'done')]), routes);
    expect(code).toBe(SPECS_EXIT.FINDINGS);
    expect(report.findings).toEqual([`tkt-1 (done): permalink ${SHA} does not contain ${REPO}:${PATH}`]);
  });
});

describe('checkSpecs — could not check is never clean', () => {
  it('refuses a board with no ticket files', () => {
    const { report, code, calls } = run(board([], { ticketFiles: 0 }), {});
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.notChecked[0]).toContain('no ticket files');
    expect(calls).toEqual([]);
  });

  it('reports a malformed spec as not checked (tkt-4b64e64fe997)', () => {
    const { report, code } = run(board([], { malformedSpec: [{ id: 'tkt-9', status: 'todo' }], ticketFiles: 1 }), {});
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.notChecked).toEqual([expect.stringContaining('tkt-9: malformed spec frontmatter')]);
  });

  it('reports an unreadable ticket file as not checked', () => {
    const { code, report } = run(board([], { unreadable: [{ file: 'tkt-9.md', reason: 'unparseable frontmatter' }], ticketFiles: 1 }), {});
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.notChecked).toEqual(['tkt-9.md: unparseable frontmatter; it may be a spec ticket']);
  });

  it('reads a 404 on the repo itself as no access, not as a missing file', () => {
    const { code, report } = run(board([ticket('tkt-1', 'todo')]), {});
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.notChecked).toEqual([`tkt-1: repo ${REPO} not found or not accessible`]);
    expect(report.findings).toEqual([]);
  });

  it.each([
    ['gh is absent', { kind: 'absent' } as const, 'gh is not installed'],
    ['gh fails to spawn', { kind: 'error', message: 'spawn EPERM' } as const, 'spawn EPERM'],
    ['gh errors other than 404', authFailure, 'gh: Bad credentials (HTTP 401)'],
    ['the repo reports no default branch', found(''), 'reported no default branch'],
  ])('does not check when %s', (_label, response, why) => {
    const { code, report } = run(board([ticket('tkt-1', 'todo')]), { [`repos/${REPO}`]: response });
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.notChecked[0]).toContain(why);
  });

  it.each(['symlink', 'submodule', 'dir', ''])('does not count a %j at the spec path as a resolving file', (type) => {
    const { code, report } = run(board([ticket('tkt-1', 'todo')]), { ...repoRoute(), [fileRoute('main')]: found(type) });
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.clean).toEqual([]);
    expect(report.notChecked[0]).toContain('not a file');
  });

  it('does not read an index whose content is not inline (over 1 MB) as an empty index', () => {
    const jqRefusal: ExecResult = { kind: 'ran', ok: false, status: 5, stdout: '', stderr: 'jq: error (at <stdin>:0): index content not inline (encoding none)\n' };
    const { code, report } = run(board([ticket('tkt-1', 'done')]), { ...repoRoute(), [indexRoute()]: jqRefusal });
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.findings).toEqual([]);
  });

  it('does not check a file lookup that errors other than 404', () => {
    const { code, report } = run(board([ticket('tkt-1', 'todo')]), { ...repoRoute(), [fileRoute('main')]: authFailure });
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.clean).toEqual([]);
  });

  it('does not check an index or permalink lookup that errors other than 404', () => {
    const indexFails = run(board([ticket('tkt-1', 'done')]), { ...repoRoute(), [indexRoute()]: authFailure });
    expect(indexFails.code).toBe(SPECS_EXIT.NOT_CHECKED);
    const shaFails = run(board([ticket('tkt-1', 'done')]), { ...repoRoute(), [indexRoute()]: found(b64(permalink())), [fileRoute(SHA)]: authFailure });
    expect(shaFails.code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(shaFails.report.clean).toEqual([]);
  });

  it('still prints the findings it reached beside a could-not-check, and exits 2', () => {
    const tickets = [ticket('tkt-1', 'todo'), ticket('tkt-2', 'todo', `acme/gizmos:${PATH}`)];
    const { code, report } = run(board(tickets), repoRoute());
    expect(code).toBe(SPECS_EXIT.NOT_CHECKED);
    expect(report.findings).toHaveLength(1);
    expect(report.notChecked).toEqual(['tkt-2: repo acme/gizmos not found or not accessible']);
  });
});

describe('indexedCommits', () => {
  it('matches owner/repo case-insensitively and tolerates a sentence-ending period', () => {
    expect(indexedCommits(`see ${permalink(SHA, 'ACME/Widgets')}.`, REPO, PATH)).toEqual([SHA]);
  });

  it('accepts an uppercase sha and returns it lowercased', () => {
    expect(indexedCommits(permalink(SHA.toUpperCase()), REPO, PATH)).toEqual([SHA]);
  });

  it('collects every permalink for the path', () => {
    const [a, b] = ['1'.repeat(40), '2'.repeat(40)];
    expect(indexedCommits(`${permalink(a)}\n${permalink(b)}`, REPO, PATH)).toEqual([a, b]);
  });

  // A short hex ref may be a branch name, which moves; only a full sha is a permalink.
  it('ignores a branch name, a short sha and a non-hex ref', () => {
    expect(indexedCommits([permalink('main'), permalink('abc1234'), permalink('deadbeef'), permalink('g'.repeat(40))].join(' '), REPO, PATH)).toEqual([]);
  });
});

describe('formatSpecReport', () => {
  it('never prints "clean" when anything went unchecked', () => {
    const text = formatSpecReport({ findings: [], notChecked: ['x'], clean: ['y'], retired: [] }, '/board/tickets', 1);
    expect(text).toContain('could not check everything — not a clean result');
    expect(text.split('\n').at(-1)).not.toBe('clean');
  });

  it('names the board it read, and says "nothing to check" rather than "clean" for zero spec tickets', () => {
    const empty = { findings: [], notChecked: [], clean: [], retired: [] };
    expect(formatSpecReport(empty, '/board/tickets', 0)).toBe('board: /board/tickets\nspec tickets: 0\nnothing to check: no spec tickets on this board');
    expect(formatSpecReport({ ...empty, clean: ['x'] }, '/board/tickets', 1).split('\n').at(-1)).toBe('clean');
  });
});
