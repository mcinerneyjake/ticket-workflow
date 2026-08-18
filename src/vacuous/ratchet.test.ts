import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BREADTH_FLOOR, EXIT, checkRoot, compareToBaseline, vacuousExitCode, type CheckResult } from './ratchet.js';
import { cmdVacuous, main } from '../cli/index.js';
import type { SweepResult } from './probe.js';

// A row wide enough that the breadth floor is satisfied by the `found` fixtures.
const row = (over: Record<string, unknown> = {}) => ({ max: 4, files: 10, blocks: 100, ...over });
const found = (n: number, over: Partial<SweepResult> = {}): SweepResult => ({
  candidates: Array.from({ length: n }, (_, i) => ({
    file: `src/x${i}.test.ts`,
    line: i + 1,
    title: `case ${i}`,
    hits: ['EMPTY-LOOP'],
  })),
  files: 10,
  blocks: 100,
  ...over,
});

describe('compareToBaseline', () => {
  it('passes when the count equals the ceiling', () => {
    expect(compareToBaseline('r', found(4), row()).ok).toBe(true);
  });

  it('fails when the count rises above the ceiling', () => {
    const r = compareToBaseline('r', found(5), row());
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('breach');
    expect(r.message).toContain('ceiling is 4');
  });

  it('names the offending file and line, not just a count', () => {
    const r = compareToBaseline('r', found(5), row());
    expect(r.message).toContain('src/x0.test.ts:1');
    expect(r.message).toContain('EMPTY-LOOP');
  });

  it('passes but asks for a tighter ceiling when the count falls', () => {
    const r = compareToBaseline('r', found(2), row());
    expect(r.ok).toBe(true);
    expect(r.message).toContain('lower "max" to 2');
  });

  it('FAILS on a missing or malformed baseline rather than passing', () => {
    for (const bad of [undefined, {}, { max: 'zero' }, null, 'not an object']) {
      const r = compareToBaseline('unknown-repo', found(3), bad);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('could not be judged');
    }
  });

  it('fails a missing baseline even when the probe found nothing', () => {
    expect(compareToBaseline('unknown-repo', found(0), undefined).ok).toBe(false);
  });

  // A count is only meaningful if the sweep actually looked.
  it('FAILS a collapsed sweep rather than scoring it clean', () => {
    const r = compareToBaseline('r', found(0, { files: 2, blocks: 9 }), row({ files: 91 }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('sweep-collapsed');
    expect(r.message).toContain('did not run');
  });

  it('tolerates a small shrink in breadth', () => {
    const files = Math.ceil(10 * BREADTH_FLOOR);
    expect(compareToBaseline('r', found(0, { files }), row({ files: 10 })).ok).toBe(true);
  });

  // The historical parse collapses (JSX, tagged templates) opened every file and saw almost no
  // blocks — a files-only floor scores that a clean 0.
  it('FAILS a parse collapse: files intact, blocks gone', () => {
    const r = compareToBaseline('r', found(0, { files: 10, blocks: 3 }), row({ blocks: 100 }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('sweep-collapsed');
  });

  it('FAILS a baseline that records no breadth rather than disabling the collapse guard', () => {
    const r = compareToBaseline('r', found(0, { files: 2, blocks: 9 }), { max: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('records no sweep breadth');
  });

  // Double-entry: the accepted list, when present, must account for exactly the ceiling's headroom
  // — a max quietly raised past its recorded accepts must fail, not pass with room to spare.
  it('FAILS when the accepted list disagrees with the ceiling', () => {
    const r = compareToBaseline('r', found(2), row({ accepted: ['src/a.test.ts:1 — reason'] }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('accepted-mismatch');
    expect(r.message).toContain('accepts 1 candidate(s) but sets "max" to 4');
  });

  it('passes when the accepted list matches the ceiling', () => {
    const accepted = ['a:1 — x', 'b:2 — y', 'c:3 — z', 'd:4 — w'];
    expect(compareToBaseline('r', found(4), row({ accepted })).ok).toBe(true);
  });

  it('FAILS a non-list accepted value instead of skipping the check', () => {
    const r = compareToBaseline('r', found(2), row({ accepted: 'src/a.test.ts:1 — reason' }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('accepted-mismatch');
    expect(r.message).toContain('must be an array');
  });
});

describe('vacuousExitCode keeps a finding distinct from a broken instrument', () => {
  const shaped = (kind: CheckResult['kind'], ok: boolean): CheckResult =>
    ({ ok, kind, repo: 'r', found: 0, max: 0, message: '' });

  it('maps ok to 0, breach to 1, and every could-not-check to 3', () => {
    expect(vacuousExitCode(shaped('at-ceiling', true))).toBe(EXIT.OK);
    expect(vacuousExitCode(shaped('below', true))).toBe(EXIT.OK);
    expect(vacuousExitCode(shaped('breach', false))).toBe(EXIT.BREACH);
    for (const kind of ['no-baseline', 'sweep-collapsed', 'accepted-mismatch', 'probe-error'] as const) {
      expect(vacuousExitCode(shaped(kind, false)), kind).toBe(EXIT.PROBE_ERROR);
    }
  });
});

// The seam that matters: sweep() -> compareToBaseline on its FAILING path, driven through a real
// tree with a real baseline file rather than hand-built fixtures.
describe('checkRoot end to end against real trees', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ratchet-'));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    // Two clean tests plus one vacuous one, in the shape the probe detects. The clean ones must
    // assert a COMPUTED value against a literal — the probe correctly flags `expect(1).toBe(1)` as
    // LITERAL, which is what a first draft of these fixtures tripped over.
    writeFileSync(
      path.join(dir, 'src/a.test.ts'),
      "import {it,expect} from 'vitest';\nconst n = [1,2,3].length;\nit('ok', () => { expect(n).toBe(3); });\n",
    );
    writeFileSync(
      path.join(dir, 'src/b.test.ts'),
      "import {it,expect} from 'vitest';\nconst m = [1,2].length;\nit('ok too', () => { expect(m).toBe(2); });\n",
    );
    writeFileSync(
      path.join(dir, 'src/vacuous.test.ts'),
      "import {it,expect} from 'vitest';\nit('asserts nothing', () => { const s=[1,2,3]; for (const x of s.filter((n)=>n>99)) { expect(x).toBeGreaterThan(99); } });\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeBaseline = (over: Record<string, unknown> = {}) =>
    writeFileSync(path.join(dir, 'vacuous-baseline.json'), JSON.stringify({ max: 0, files: 3, blocks: 3, ...over }));

  it('BREACHES on a real vacuous test, naming it', () => {
    writeBaseline();
    const r = checkRoot(dir);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('breach');
    expect(r.found).toBe(1);
    expect(r.message).toContain('vacuous.test.ts');
  });

  it('passes the same tree once the ceiling allows it', () => {
    writeBaseline({ max: 1 });
    expect(checkRoot(dir).ok).toBe(true);
  });

  it('FAILS a root with no baseline file rather than passing it', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'ratchet-nobase-'));
    writeFileSync(path.join(bare, 'a.test.ts'), "it('ok', () => { expect(f()).toBe(1); });\n");
    const r = checkRoot(bare);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('no-baseline');
    expect(r.message).toContain('could not be judged');
    rmSync(bare, { recursive: true, force: true });
  });

  it('reports an unreadable baseline as an error, never as absent', () => {
    writeBaseline();
    writeFileSync(path.join(dir, 'vacuous-baseline.json'), '{ not json');
    const r = checkRoot(dir);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('probe-error');
    expect(r.message).toContain('NOT a clean result');
  });

  it('reports a probe error as an error, never as clean', () => {
    // A root with no test files makes sweep() throw; that must not read as 0.
    const empty = mkdtempSync(path.join(tmpdir(), 'ratchet-empty-'));
    writeFileSync(path.join(empty, 'vacuous-baseline.json'), JSON.stringify({ max: 0, files: 3 }));
    const r = checkRoot(empty);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('probe-error');
    expect(r.message).toContain('NOT a clean result');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('this repo against its own ceiling', () => {
  // The enforcement point — the same dogfood every consumer repo gets: a repo-local baseline plus
  // one gate test. `fileURLToPath`, not URL.pathname, so a space in a parent directory cannot
  // percent-encode the root out of existence.
  it('has no more vacuous-test candidates than its baseline allows', () => {
    const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const result = checkRoot(root);
    expect(result.ok, result.message).toBe(true);
  });
});

/**
 * The CLI contract, in-process. Exit codes are asserted via `process.exitCode` — cmdVacuous never
 * calls process.exit — and reset afterward so a failing expectation cannot leak a red exit into
 * the vitest run itself. The symlinked-invocation hazard is `isMain`'s, covered in cli/index.test.
 */
describe('cmdVacuous', () => {
  let dir: string;
  const logged: string[] = [];
  const errored: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ratchet-cli-'));
    writeFileSync(path.join(dir, 'a.test.ts'), "it('nothing', () => { use(x); });\n");
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errored.push(args.map(String).join(' ')); });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    logged.length = 0;
    errored.length = 0;
  });

  it('exits 2 on a usage error, which no finding may share', () => {
    cmdVacuous([]);
    expect(process.exitCode).toBe(EXIT.USAGE);
    cmdVacuous(['--wat', dir]);
    expect(process.exitCode).toBe(EXIT.USAGE);
    // The single-dash typo must be usage too — as a path it would exit 3 and read as a probe error.
    cmdVacuous(['-check', dir]);
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('is routed by main()', async () => {
    const saved = process.argv;
    process.argv = [saved[0] ?? 'node', 'cli', 'vacuous'];
    try {
      await main();
      expect(process.exitCode).toBe(EXIT.USAGE);
    } finally {
      process.argv = saved;
    }
  });

  it('sweeps and prints candidates as JSON without --check', () => {
    cmdVacuous([dir]);
    expect(process.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(logged.join('\n'));
    if (typeof parsed !== 'object' || parsed === null || !('candidates' in parsed)) throw new Error('no candidates in output');
    expect(Array.isArray(parsed.candidates) && parsed.candidates.length).toBe(1);
  });

  it('exits 1 on a breach with --check, naming the offender', () => {
    writeFileSync(path.join(dir, 'vacuous-baseline.json'), JSON.stringify({ max: 0, files: 1, blocks: 1 }));
    cmdVacuous([dir, '--check']);
    expect(process.exitCode).toBe(EXIT.BREACH);
    expect(logged.join('\n')).toContain('a.test.ts');
    rmSync(path.join(dir, 'vacuous-baseline.json'));
  });

  it('exits 3 when the probe cannot run, distinct from a breach', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'ratchet-cli-empty-'));
    cmdVacuous([empty]);
    expect(process.exitCode).toBe(EXIT.PROBE_ERROR);
    expect(errored.join('\n')).toContain('no test files');
    rmSync(empty, { recursive: true, force: true });
  });
});
