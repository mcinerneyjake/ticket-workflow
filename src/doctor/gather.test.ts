import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gatherFacts } from './gather.js';
import { checkHookWiring, checkWriterUniqueness, checkBoard } from './checks.js';

// A fake machine: its own HOME and its own repo, so nothing here reads the real wiring. Every case
// below was reachable only from a live run before these existed — both defects this file pins were
// found by running doctor on the real machine, not by the pure suite.

let root: string;
let home: string;
let repo: string;

const settings = (dir: string, hooks: unknown): void => {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
};

const gather = (over: { cwd?: string } = {}) =>
  gatherFacts({ home, cwd: over.cwd ?? repo, probeMcpServer: false, now: '2026-08-16T00:00:00.000Z' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.claude', 'tools', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'bin'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'tools', 'hooks', 'run-hook.mjs'),
    "const { main } = await import(`ticket-workflow/hooks/${name}.mjs`);\n",
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('classifying a wired hook', () => {
  it('treats a .sh wrapper that execs run-hook.mjs as a LAUNCHER, not a vendored copy', async () => {
    // The regression this pins: the machine's telemetry writer is exactly this shape. Testing only
    // for the bare specifier classified it as vendored and then reported it drifted against a hook
    // whose bytes it does not contain — a MISMATCH invented entirely by the checker.
    const sh = path.join(home, '.claude', 'bin', 'track-steps-central.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nBOARD_DIR_OVERRIDE=${repo} exec node $HOME/.claude/tools/hooks/run-hook.mjs track-steps open\n`);
    settings(home, { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sh }] }] });

    const facts = await gather();
    const wrapper = (facts.guardCopies ?? []).find((h) => h.path === sh);
    expect(wrapper?.hook).toBe('track-steps');
    expect(wrapper?.isLauncher).toBe(true);
    expect(checkHookWiring(facts).status).toBe('ok');
  });

  it('classifies that same wrapper as the telemetry WRITER', async () => {
    const sh = path.join(home, '.claude', 'bin', 'w.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node $HOME/.claude/tools/hooks/run-hook.mjs track-steps open\n`);
    settings(home, { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sh }] }] });
    expect(checkWriterUniqueness(await gather()).status).toBe('ok');
  });

  it('reports a PostToolUse hook it cannot classify as UNKNOWN rather than counting it out', async () => {
    settings(home, {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /nowhere/mystery.mjs' }] }],
    });
    expect(checkWriterUniqueness(await gather()).status).toBe('unknown');
  });

  it('finds a VENDORED copy through $CLAUDE_PROJECT_DIR and hashes what it will actually run', async () => {
    fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
    const vendored = path.join(repo, '.claude', 'hooks', 'guard-bash.mjs');
    fs.writeFileSync(vendored, '// a stale copy of the guard\n');
    settings(repo, {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs"' }] },
      ],
    });

    const facts = await gather();
    const copy = (facts.guardCopies ?? []).find((h) => h.hook === 'guard-bash');
    expect(copy?.path).toBe(vendored);
    expect(copy?.isLauncher).toBe(false);
    expect(copy?.sha).not.toBeNull();
    // Compared against the hook this package actually ships, so the MISMATCH is real drift.
    expect(checkHookWiring(facts).status).toBe('mismatch');
  });

  it('leaves an unrelated hook unnamed, so it is neither a guard nor a writer', async () => {
    settings(home, {
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'node /x/defer-compact.mjs' }] }],
    });
    const facts = await gather();
    expect((facts.guardCopies ?? [])[0]?.hook).toBeNull();
    expect(checkHookWiring(facts).status).toBe('ok');
  });
});

describe('the set of hooks doctor can judge', () => {
  it('covers every hook this package ships — read from disk, never listed in the source', async () => {
    // A transcribed list is the same drift doctor exists to find: a hook added upstream would keep
    // passing the wiring check by being invisible to it. Generated, so this cannot go stale.
    const dir = path.resolve(import.meta.dirname, '..', '..', 'hooks');
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => f.replace(/\.mjs$/, ''));
    const facts = await gather();
    expect(onDisk.length).toBeGreaterThan(0); // the probe finds something, so a 0 below is a finding
    expect(Object.keys(facts.canonicalShas ?? {}).sort()).toEqual(onDisk.sort());
  });
});

describe('resolving which file a command runs', () => {
  it('skips the interpreter and finds the hook, not the first existing path', async () => {
    // `/usr/bin/env` is the first existing path in this perfectly ordinary command. Hashing it made
    // correct wiring report as a drifted vendored copy — a MISMATCH invented by the checker.
    settings(home, {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '/usr/bin/env node $HOME/.claude/tools/hooks/run-hook.mjs guard-bash closed' }],
        },
      ],
    });
    const facts = await gather();
    const h = (facts.guardCopies ?? [])[0];
    expect(h?.path).toBe(path.join(home, '.claude', 'tools', 'hooks', 'run-hook.mjs'));
    expect(h?.isLauncher).toBe(true);
    expect(checkHookWiring(facts).status).toBe('ok');
  });

  it('reads a board root out of the COMMAND when there is no shell wrapper', async () => {
    // Keeping only the target file's contents dropped everything the command said, so a writer
    // wired inline lost its BOARD_DIR_OVERRIDE and doctor silently fell back to cwd.
    const board = path.join(root, 'inline-board');
    fs.mkdirSync(path.join(board, 'tickets'), { recursive: true });
    settings(home, {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `BOARD_DIR_OVERRIDE=${board} node $HOME/.claude/tools/hooks/run-hook.mjs track-steps open`,
            },
          ],
        },
      ],
    });
    const facts = await gather();
    expect(facts.board?.root).toBe(board);
  });

  it('reads each hook\'s OWN command, though every launcher shares one run-hook.mjs', async () => {
    // Looking the entry up by target path hands the writer whichever hook was wired first — and
    // with it that hook's BOARD_DIR_OVERRIDE, or none at all.
    const board = path.join(root, 'writers-board');
    fs.mkdirSync(path.join(board, 'tickets'), { recursive: true });
    const launcher = `$HOME/.claude/tools/hooks/run-hook.mjs`;
    settings(home, {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${launcher} guard-bash closed` }] }],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `BOARD_DIR_OVERRIDE=${board} node ${launcher} track-steps open` }],
        },
      ],
    });
    const facts = await gather();
    expect(facts.board?.targets).toEqual([{ source: 'writer (user scope)', root: board }]);
  });
});

describe('where project settings are read from', () => {
  it('finds project scope from a SUBDIRECTORY, so a second writer cannot hide there', async () => {
    // Read from cwd, a run from repo/src misses project scope entirely — and because user scope
    // still answers, the result is not UNKNOWN but a confident "exactly one writer".
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const sub = path.join(repo, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const sh = path.join(home, '.claude', 'bin', 'w.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node $HOME/.claude/tools/hooks/run-hook.mjs track-steps open\n`);
    settings(home, { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sh }] }] });
    settings(repo, { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sh }] }] });

    const facts = await gatherFacts({ home, cwd: sub, env: {}, probeMcpServer: false, now: '2026-08-16T00:00:00.000Z' });
    const r = checkWriterUniqueness(facts);
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('2 PostToolUse writers');
  });
});

describe('board resolution', () => {
  it('reads the board the WIRING names, not the repo doctor happens to run in', async () => {
    // Without this, running doctor from any repo but the board's own reads that repo's (absent)
    // events dir and reports a dead writer — an answer produced by the caller's cwd.
    const board = path.join(root, 'central');
    fs.mkdirSync(path.join(board, 'tickets'), { recursive: true });
    const sh = path.join(home, '.claude', 'bin', 'w.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nBOARD_DIR_OVERRIDE=${board} exec node $HOME/.claude/tools/hooks/run-hook.mjs track-steps open\n`);
    settings(home, { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sh }] }] });

    const facts = await gather();
    expect(facts.board?.root).toBe(board);
    expect(facts.board?.targets).toEqual([{ source: 'writer (user scope)', root: board }]);
    expect(checkBoard(facts).status).toBe('ok');
  });
});

describe('probing the MCP server', () => {
  // A server that answers `initialize` and then exits immediately.
  //
  // HONEST LIMIT: this covers the happy path, NOT the drain race. Settling on 'exit' rather than
  // 'close' can lose a reply still buffered in the pipe, but the ordering is timing-dependent and
  // measured here it does not reproduce — with the code mutated back to 'exit' this test still
  // passes, and padding the payload past the pipe buffer only makes process.exit truncate the write,
  // which is data loss rather than the race. The fix stands on 'close' being the documented
  // drain-complete event; do not read a green here as proof of it.
  const fakeServer = (dir: string): string => {
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(
      file,
      [
        "process.stdin.once('data', () => {",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'tw', version: '9.9.9' } } }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    return file;
  };

  const wireMcp = (command: string, args: string[]): void => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { kanban: { type: 'stdio', command, args, env: { X: 'ticket-workflow' } } } }),
    );
  };

  const probe = () => gatherFacts({ home, cwd: repo, env: {}, now: '2026-08-16T00:00:00.000Z' });

  it('reads a reply from a server that answers and exits', async () => {
    wireMcp(process.execPath, [fakeServer(root)]);
    const facts = await probe();
    expect(facts.mcp?.resolved).toBe(true);
    expect(facts.mcp?.version).toBe('9.9.9');
  });

  it('MISMATCHes on a server that cannot start at all', async () => {
    wireMcp(path.join(root, 'no-such-binary'), []);
    const facts = await probe();
    expect(facts.mcp?.configured).toBe(true);
    expect(facts.mcp?.resolved).toBe(false);
  });

  it("finds a server declared in the repo's own .mcp.json, not only at user scope", async () => {
    // How the kanban repo itself wires it. Reading only ~/.claude.json reported a correctly
    // configured repo as having no server — a gate failure under --strict.
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: { kanban: { command: process.execPath, args: [fakeServer(root)], env: { X: 'ticket-workflow' } } },
      }),
    );
    const facts = await probe();
    expect(facts.mcp?.configured).toBe(true);
    expect(facts.mcp?.resolved).toBe(true);
  });
});

describe('which installs count as live', () => {
  it("excludes doctor's OWN install, reporting its version separately", async () => {
    // Counting self conflates "two versions are wired" with "I was invoked from a different copy" —
    // which npx and any source checkout both are. The pure checkPin test cannot see this: it is a
    // property of what gather collects, not of how the collected set is judged.
    settings(home, {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node $HOME/.claude/tools/hooks/run-hook.mjs guard-bash closed' }] },
      ],
    });
    const facts = await gather();
    const pkgRoot = path.resolve(import.meta.dirname, '..', '..');
    expect(facts.selfVersion).toBeTruthy();
    expect((facts.installs ?? []).map((i) => i.root)).not.toContain(pkgRoot);
  });
});

describe('a machine with nothing configured', () => {
  it('returns nulls rather than healthy-looking zeroes — the CI shape', async () => {
    const facts = await gather();
    expect(facts.postToolUse).toBeNull();
    expect(facts.guardCopies).toBeNull();
    expect(facts.gateScripts).toBeNull(); // no package.json in the temp repo
    expect(facts.protectedBranch).toBeNull(); // not a git repository
    expect(checkWriterUniqueness(facts).status).toBe('unknown');
    expect(checkHookWiring(facts).status).toBe('unknown');
  });

  it('never throws when HOME does not exist at all', async () => {
    await expect(
      gatherFacts({ home: path.join(root, 'no-such-home'), cwd: repo, probeMcpServer: false }),
    ).resolves.toBeTruthy();
  });
});

describe('gate scripts', () => {
  it('reads the cwd repo package.json when there is one', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest' } }));
    const facts = await gather();
    expect(Object.values(facts.gateScripts ?? {})[0]).toEqual(['typecheck', 'test']);
  });
});
