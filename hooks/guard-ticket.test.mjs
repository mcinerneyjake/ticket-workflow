import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, judge, specParentVerdict, REASON, TICKET_ID, createReason } from './guard-ticket.mjs';
import { getTicket } from '../src/server/tickets.js';
import { BRANCH_TICKET_ID_RE } from '../src/shared/constants.js';
import { setupTempTicketDirs } from '../src/test-support/tempTicketDirs.js';

const isBlocked = (toolName, toolInput = {}) =>
  decide(toolName === undefined ? {} : { tool_name: toolName, tool_input: toolInput }).blocked;

describe('decide — blocks only create_ticket', () => {
  it('blocks the real create tool id', () => {
    expect(isBlocked('mcp__kanban__create_ticket', { title: 'x' })).toBe(true);
  });

  it('blocks a bare create_ticket (server-rename defensive)', () => {
    expect(isBlocked('create_ticket')).toBe(true);
  });

  // Creation-only scope: body/summary/structured updates and delete stay Claude's.
  it('allows update_ticket even with a body (implementation summaries are Claude-authored)', () => {
    expect(isBlocked('mcp__kanban__update_ticket', { id: 'tkt-1', body: '## Implementation summary\n…' })).toBe(false);
  });

  it('allows a structured-field-only update', () => {
    expect(isBlocked('mcp__kanban__update_ticket', { id: 'tkt-1', status: 'done' })).toBe(false);
  });

  it('allows delete_ticket', () => {
    expect(isBlocked('mcp__kanban__delete_ticket', { id: 'tkt-1' })).toBe(false);
  });

  it('allows the read tools', () => {
    expect(isBlocked('mcp__kanban__list_tickets')).toBe(false);
    expect(isBlocked('mcp__kanban__get_ticket', { id: 'tkt-1' })).toBe(false);
    expect(isBlocked('mcp__kanban__start_ticket', { id: 'tkt-1' })).toBe(false);
  });

  it('does not match a tool whose name merely contains create_ticket mid-string', () => {
    expect(isBlocked('mcp__kanban__create_ticket_draft')).toBe(false);
  });

  // Fail CLOSED: the settings matcher routes only create_ticket here, so no readable
  // tool name is treated as the create call. guard-bash's FIELD-level analogue goes the
  // other way — a command-less event is allowed, because its matcher is all of Bash and
  // blocking would wedge BashOutput. Reach, not a weaker rule (see guard-ticket.mjs).
  it('fails closed on an absent or non-string tool name', () => {
    expect(isBlocked(undefined)).toBe(true);
    expect(decide({ tool_name: 42 }).blocked).toBe(true);
  });

  it('always supplies a reason, and the shipped default names no consumer-specific command', () => {
    const { reason } = decide({ tool_name: 'mcp__kanban__create_ticket' }, {});
    expect(reason).toBe(REASON);
    // The defect (tkt-0361525dbf9f): this guard is wired at USER scope, so it fires in every repo on
    // the machine, and it used to hand every one of them `npm run agent` — a script that exists in one.
    expect(reason).not.toMatch(/npm run |\/api\//);
    // Still actionable rather than merely vague: it says where to look instead of naming a command.
    expect(reason).toContain('TICKET_WORKFLOW_CREATE_REASON');
  });
});

// The consumer seam. Same shape as guard-bash's TICKET_WORKFLOW_PROTECTED_BRANCH: the policy ships, the
// concrete command comes from the environment that actually has one.
describe('createReason — the consumer override', () => {
  it('replaces the default when set', () => {
    const mine = 'Run `just file-ticket "<report>"` — one issue per run.';
    expect(createReason({ TICKET_WORKFLOW_CREATE_REASON: mine })).toBe(mine);
    expect(decide({ tool_name: 'create_ticket' }, { TICKET_WORKFLOW_CREATE_REASON: mine }).reason).toBe(mine);
  });

  it('falls back to the default when unset, blank, or whitespace', () => {
    // Blocking with an empty explanation is barely better than failing open, and unset-vs-empty is a
    // distinction no caller means to draw.
    for (const env of [{}, { TICKET_WORKFLOW_CREATE_REASON: '' }, { TICKET_WORKFLOW_CREATE_REASON: '   \n' }]) {
      expect(createReason(env), JSON.stringify(env)).toBe(REASON);
    }
  });

  it('trims, so a trailing newline from a shell heredoc is not part of the message', () => {
    expect(createReason({ TICKET_WORKFLOW_CREATE_REASON: '  do the thing\n' })).toBe('do the thing');
  });
});

describe('hook entrypoint (stdin → exit code)', () => {
  const hook = fileURLToPath(new URL('./guard-ticket.mjs', import.meta.url));
  const runHook = (payload) => spawnSync('node', [hook], { input: payload, encoding: 'utf8' });

  it('exits 2 and surfaces the reason on a create_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('create_ticket is blocked');
  });

  // What the consumer actually depends on: the override has to survive the spawn and reach the stderr a
  // blocked session reads. Asserting createReason() alone would leave main() free to ignore it — the
  // "consulted but not wired" shape. Driven through the real process, with the default as the control.
  it('carries a consumer override all the way to stderr', () => {
    const mine = 'FILE-IT-THIS-WAY: run `just ticket --create-only "<report>"`, one issue per run';
    const payload = JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } });
    const withOverride = spawnSync('node', [hook], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, TICKET_WORKFLOW_CREATE_REASON: mine },
    });
    expect(withOverride.status).toBe(2);
    expect(withOverride.stderr).toContain(mine);
    // The control: without it the same call prints the shipped default instead, so the assertion above
    // is attributable to the env var and not to the message merely being long.
    expect(runHook(payload).stderr).not.toContain('FILE-IT-THIS-WAY');
  });

  it('exits 0 on an update_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__update_ticket', tool_input: { id: 'tkt-1', body: 'x' } }));
    expect(r.status).toBe(0);
  });

  it('exits 2 on unparseable stdin (fails closed)', () => {
    expect(runHook('not json').status).toBe(2);
  });
});

describe('id pattern parity with shared/constants BRANCH_TICKET_ID_RE', () => {
  it('is the anchored form of the minted id pattern', () => {
    expect(TICKET_ID.source).toBe(`^${BRANCH_TICKET_ID_RE.source}$`);
  });
});

// The spec-parent exception, driven through the REAL service getTicket against a temp board.
describe('judge — the spec-parent exception', () => {
  const dirs = setupTempTicketDirs('tw-guard-ticket');
  const SPEC = 'owner/repo:docs/specs/x.md';
  const PARENT = 'tkt-0123456789ab';
  const create = (toolInput) => ({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'slice', ...toolInput } });
  const realLoad = async () => getTicket;

  function writeTicket(id, fields) {
    const all = { title: 'Spec', type: 'task', priority: 'medium', status: 'todo', order: '1', created: "'2026-01-01T00:00:00.000Z'", updated: "'2026-01-01T00:00:00.000Z'", ...fields };
    const lines = Object.entries(all).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
    writeFileSync(path.join(dirs.tickets, `${id}.md`), ['---', ...lines, '---', ''].join('\n'));
  }

  it.each(['backlog', 'todo', 'in-progress', 'qa'])('admits a create under an open spec parent (%s)', async (status) => {
    writeTicket(PARENT, { status, spec: SPEC });
    expect(await judge(create({ parent: PARENT }), {}, realLoad)).toEqual({ blocked: false });
  });

  it.each(['done', 'archived'])('blocks a create under a closed spec parent (%s)', async (status) => {
    writeTicket(PARENT, { status, spec: SPEC });
    const r = await judge(create({ parent: PARENT }), {}, realLoad);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain(`parent ${PARENT} is a closed spec ticket (status ${status})`);
  });

  it('blocks a parent with no spec field — the base rule, not the exception', async () => {
    writeTicket(PARENT, {});
    const r = await judge(create({ parent: PARENT }), {}, realLoad);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('is not a spec ticket');
  });

  // getTicket reads a malformed on-disk spec as null; that is what keeps this closed.
  it.each(['not-a-ref', "'owner/repo:../x.md'", "'owner/repo:x.txt'"])('blocks a parent whose spec on disk is malformed (%s)', async (spec) => {
    writeTicket(PARENT, { spec });
    expect((await judge(create({ parent: PARENT }), {}, realLoad)).blocked).toBe(true);
  });

  it('blocks a parent that does not exist', async () => {
    const r = await judge(create({ parent: PARENT }), {}, realLoad);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain(`parent ${PARENT} could not be read (Ticket not found`);
  });

  it('blocks a parent with unparseable frontmatter or an invalid status', async () => {
    writeFileSync(path.join(dirs.tickets, `${PARENT}.md`), '---\ntitle: [unclosed\nspec: owner/repo:x.md\n---\n');
    expect((await judge(create({ parent: PARENT }), {}, realLoad)).blocked).toBe(true);
    writeTicket(PARENT, { status: 'bogus', spec: SPEC });
    expect((await judge(create({ parent: PARENT }), {}, realLoad)).blocked).toBe(true);
  });

  it('blocks when the board itself cannot be read', async () => {
    writeTicket(PARENT, { spec: SPEC });
    const notADir = path.join(dirs.tickets, `${PARENT}.md`);
    const saved = process.env.TICKETS_DIR_OVERRIDE;
    process.env.TICKETS_DIR_OVERRIDE = notADir; // ENOTDIR, not ENOENT: a real fault, rethrown
    try {
      const r = await judge(create({ parent: PARENT }), {}, realLoad);
      expect(r.blocked).toBe(true);
      expect(r.reason).toContain('could not be read');
    } finally {
      process.env.TICKETS_DIR_OVERRIDE = saved;
    }
  });

  it.each([42, '', 'tkt-abc', 'TKT-0123456789AB', `../${PARENT}`, `${PARENT}.md`, { id: PARENT }])('blocks a malformed parent id %j without reading the board', async (parent) => {
    const read = vi.fn(getTicket);
    const r = await judge(create({ parent }), {}, async () => read);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('is not a current-format ticket id');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the unchanged base message when no parent is given, without loading the service', async () => {
    for (const toolInput of [{}, { parent: null }]) {
      const load = vi.fn(realLoad);
      expect(await judge(create(toolInput), {}, load)).toEqual({ blocked: true, reason: REASON });
      expect(load).not.toHaveBeenCalled();
    }
  });

  it('blocks a create that itself carries `spec`, without reading the board', async () => {
    writeTicket(PARENT, { spec: SPEC });
    for (const spec of [SPEC, '', 'garbage']) {
      const load = vi.fn(realLoad);
      const r = await judge(create({ parent: PARENT, spec }), {}, load);
      expect(r.blocked, JSON.stringify(spec)).toBe(true);
      expect(r.reason).toContain('a create carrying `spec` is a spec ticket');
      expect(load).not.toHaveBeenCalled();
    }
    // The control: `spec: null` is no spec, so the same parent admits.
    expect(await judge(create({ parent: PARENT, spec: null }), {}, realLoad)).toEqual({ blocked: false });
  });

  it('blocks when the service layer cannot be loaded', async () => {
    writeTicket(PARENT, { spec: SPEC });
    const r = await judge(create({ parent: PARENT }), {}, async () => { throw new Error('Cannot find module dist/index.js'); });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('the board service could not be loaded (Cannot find module dist/index.js)');
  });

  it('carries a consumer override, then the reason the exception was not met', async () => {
    const r = await judge(create({ parent: PARENT }), { TICKET_WORKFLOW_CREATE_REASON: 'MINE' }, realLoad);
    expect(r.reason).toMatch(/^MINE\nSpec-parent exception not met: parent tkt-0123456789ab could not be read/);
  });

  it('leaves non-create tools and the missing-tool-name case exactly as decide() rules them', async () => {
    writeTicket(PARENT, { spec: SPEC });
    const load = vi.fn(realLoad);
    expect(await judge({ tool_name: 'mcp__kanban__update_ticket', tool_input: { id: 'tkt-1', parent: PARENT } }, {}, load)).toEqual({ blocked: false });
    // Fails closed with no tool name even when a valid spec parent is present.
    expect((await judge({ tool_input: { parent: PARENT } }, {}, load)).blocked).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('specParentVerdict — a getTicket that misbehaves', () => {
  it('blocks a read that never answers, at the deadline', async () => {
    const v = await specParentVerdict('tkt-0123456789ab', () => new Promise(() => {}), 50);
    expect(v).toEqual({ admit: false, why: 'parent tkt-0123456789ab could not be read (no answer within 50ms)' });
  });

  it('admits a read that answers before the deadline', async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ spec: 'o/r:x.md', status: 'todo' }), 10));
    expect((await specParentVerdict('tkt-0123456789ab', slow, 1_000)).admit).toBe(true);
  });

  it('refuses a ticket with a spec but no readable status, and a null ticket', async () => {
    expect((await specParentVerdict('tkt-0123456789ab', async () => ({ spec: 'o/r:x.md' }))).admit).toBe(false);
    expect((await specParentVerdict('tkt-0123456789ab', async () => null)).admit).toBe(false);
  });
});

// The real module loader (`../dist/index.js` beside the hook), exercised without depending on a fresh
// build: the hook is copied into a temp package whose dist is a stub.
describe('hook entrypoint — the spec-parent path through the real loader', () => {
  const OPEN = 'tkt-aaaaaaaaaaaa';
  const payload = (parent) => JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x', parent } });
  let pkg;
  const hooksDir = fileURLToPath(new URL('.', import.meta.url));
  const run = (parent) => spawnSync('node', [path.join(pkg, 'hooks', 'guard-ticket.mjs')], { input: payload(parent), encoding: 'utf8' });

  beforeAll(() => {
    pkg = mkdtempSync(path.join(tmpdir(), 'tw-guard-ticket-pkg-'));
    mkdirSync(path.join(pkg, 'hooks', 'lib'), { recursive: true });
    copyFileSync(path.join(hooksDir, 'guard-ticket.mjs'), path.join(pkg, 'hooks', 'guard-ticket.mjs'));
    copyFileSync(path.join(hooksDir, 'lib', 'is-main.mjs'), path.join(pkg, 'hooks', 'lib', 'is-main.mjs'));
  });
  afterAll(() => rmSync(pkg, { recursive: true, force: true }));

  it('blocks a spec-parented create when there is no build to load', () => {
    rmSync(path.join(pkg, 'dist'), { recursive: true, force: true });
    const r = run(OPEN);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('the board service could not be loaded');
  });

  it('admits through the loaded getTicket, and blocks a parent it refuses', () => {
    mkdirSync(path.join(pkg, 'dist', 'server'), { recursive: true });
    // Mirrors the real shape: the service logs through a module-level logger that setLogger replaces.
    writeFileSync(
      path.join(pkg, 'dist', 'logger.js'),
      'const loud = { info: (m) => process.stderr.write(m), warn: (m) => process.stderr.write(m), error: (m) => process.stderr.write(m) };\n' +
        'let current = loud;\nexport function setLogger(next) { current = next ?? loud; }\n' +
        'export const log = { error: (m) => current.error(m) };\n',
    );
    writeFileSync(
      path.join(pkg, 'dist', 'server', 'tickets.js'),
      `import { log } from '../logger.js';\nexport async function getTicket(id) {\n  if (id === '${OPEN}') return { id, spec: 'o/r:x.md', status: 'todo' };\n  log.error('FILE-SNIPPET-LEAK');\n  throw new Error('Ticket not found: ' + id);\n}\n`,
    );
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module' }));
    expect(run(OPEN).status).toBe(0);
    const refused = run('tkt-bbbbbbbbbbbb');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('Spec-parent exception not met: parent tkt-bbbbbbbbbbbb could not be read');
    // The service's own log line (a file snippet, in the real build) must not reach the model.
    expect(refused.stderr).not.toContain('FILE-SNIPPET-LEAK');
  });
});
