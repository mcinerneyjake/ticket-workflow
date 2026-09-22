import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testRunHold } from './testRunHold.js';
import { auditExitCode, type AuditReport } from '../run.js';
import type { AuditContext, ReadResult } from '../types.js';

/** Stubbed reads: a path mapped to a ReadResult is returned as-is, a string is file contents. */
function run(files: Record<string, string | ReadResult>) {
  const ctx: AuditContext = {
    repoDir: '/repo',
    read: (rel) => {
      const f = files[rel];
      if (f === undefined) return { kind: 'missing' };
      return typeof f === 'string' ? { kind: 'ok', contents: f } : f;
    },
    exec: () => ({ kind: 'absent' }),
  };
  return testRunHold.run(ctx);
}

const HOLD = `await holdTestRun({ repo: 'x' });`;
const RELEASE = 'globalSetup: [TEST_RUN_GLOBAL_SETUP]';

function config(preamble: string, release: string = RELEASE): string {
  return `import { defineConfig } from 'vitest/config';
import { holdTestRun, TEST_RUN_GLOBAL_SETUP } from 'ticket-workflow/test-run';

${preamble}

export default defineConfig({
  test: { ${release} },
});
`;
}

describe('test-run-hold — the wired shape passes', () => {
  it('PASSES a top-level await before export default', () => {
    const res = run({ 'vitest.config.ts': config(HOLD) });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('vitest.config.ts');
  });

  it('PASSES a no-argument call', () => {
    expect(run({ 'vitest.config.ts': config('await holdTestRun();') }).status).toBe('pass');
  });

  it('PASSES when an un-awaited or nested call precedes the real one', () => {
    const res = run({ 'vitest.config.ts': config(`if (x) { holdTestRun(); }\n${HOLD}`) });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES a shared vite.config.ts that carries the test block', () => {
    expect(run({ 'vite.config.ts': config(HOLD) }).status).toBe('pass');
  });

  it('answers from the config an `npm --prefix` delegation points at', () => {
    const res = run({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix server run test' } }),
      'server/vitest.config.ts': config(HOLD),
      'vitest.config.ts': config(''),
    });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('server/vitest.config.ts');
  });
});

describe('test-run-hold — the negative control and its disguises', () => {
  it('FAILS the same config with the line removed', () => {
    const res = run({ 'vitest.config.ts': config('') });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('does not call holdTestRun');
  });

  it('FAILS a commented-out call — masking, not a raw grep', () => {
    expect(run({ 'vitest.config.ts': config(`// ${HOLD}`) }).status).toBe('fail');
    expect(run({ 'vitest.config.ts': config(`/* ${HOLD} */`) }).status).toBe('fail');
  });

  it('FAILS a call that exists only inside a string', () => {
    expect(run({ 'vitest.config.ts': config(`const s = '${HOLD}';`) }).status).toBe('fail');
    expect(run({ 'vitest.config.ts': config('const s = `await holdTestRun()`;') }).status).toBe('fail');
  });

  it('FAILS an un-awaited top-level call, naming why', () => {
    const res = run({ 'vitest.config.ts': config(`void holdTestRun();`) });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('without `await`');
  });

  it('FAILS a call nested in a block, a function or the config call', () => {
    for (const nested of [
      `if (process.env.X) { ${HOLD} }`,
      `async function setup() { ${HOLD} }`,
      `const p = (async () => { ${HOLD} })();`,
    ]) {
      const res = run({ 'vitest.config.ts': config(nested) });
      expect(res.status, nested).toBe('fail');
      expect(res.detail, nested).toContain('inside a block, call or condition');
    }
  });

  /** Depth 0 is not unconditional: each of these reached PASS on depth alone. */
  it('FAILS a depth-0 await that is guarded, or deferred into an arrow nobody calls', () => {
    for (const guarded of [
      `if (process.env.X) ${HOLD}`,
      `if (process.env.X)\n  ${HOLD}`,
      `if (a) foo(); else ${HOLD}`,
      `while (false) ${HOLD}`,
      `process.env.X && ${HOLD}`,
      `process.env.X || ${HOLD}`,
      `const r = x ? ${HOLD.replace(';', '')} : null;`,
      `const later = async () => ${HOLD}`,
      `for await (const _ of []) ${HOLD}`,
      `if (process.env.X) void 0, ${HOLD}`,
      // A nested template literal desyncs the masker's depth; the \`{\` still reads as a guard.
      'const s = `${`}`}`;\nif (process.env.X) {\n  ' + HOLD + '\n}',
    ]) {
      const res = run({ 'vitest.config.ts': config(guarded) });
      expect(res.status, guarded).toBe('fail');
      expect(res.detail, guarded).toContain('condition');
    }
  });

  it('PASSES a namespace-imported call', () => {
    const res = run({ 'vitest.config.ts': config(`await tw.holdTestRun();`) });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES an unguarded await after a call line with no semicolon, and an assigned one', () => {
    expect(run({ 'vitest.config.ts': config(`setup()\n${HOLD}`) }).status).toBe('pass');
    expect(run({ 'vitest.config.ts': config(`const held = ${HOLD}`) }).status).toBe('pass');
  });

  it('FAILS a lookalike name on either side', () => {
    expect(run({ 'vitest.config.ts': config('await holdTestRunLater();') }).status).toBe('fail');
    expect(run({ 'vitest.config.ts': config('await myholdTestRun();') }).status).toBe('fail');
  });

  it('FAILS a repo with no vitest config at all', () => {
    const res = run({});
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });
});

describe('test-run-hold — cannot determine is BLOCKED, never a pass', () => {
  it('BLOCKS on an unreadable config', () => {
    const res = run({ 'vitest.config.ts': { kind: 'error', message: 'EACCES: permission denied' } });
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('EACCES');
  });

  it('BLOCKS when the test script drives more than one vitest root', () => {
    const res = run({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix a run test && npm --prefix b run test' } }),
      'a/vitest.config.ts': config(HOLD),
      'b/vitest.config.ts': config(HOLD),
    });
    expect(res.status).toBe('blocked');
  });

  it('BLOCKS on a shared vite config whose test block cannot be delimited', () => {
    const res = run({ 'vite.config.ts': `export default defineConfig({ test: { exclude: [] ` });
    expect(res.status).toBe('blocked');
  });
});

/** A config body written out in full, for shapes the fixed `test: { … }` above cannot express. */
function rawConfig(body: string): string {
  return `import { defineConfig } from 'vitest/config';
import { holdTestRun, TEST_RUN_GLOBAL_SETUP } from 'ticket-workflow/test-run';

${HOLD}

export default defineConfig(${body});
`;
}

/** The hold and the release are separate dimensions; before tkt-d3e5108c3a4c only the hold varied,
 *  so a config that took a slot and never gave it back was certified. */
describe('test-run-hold — the release, which the hold alone does not prove', () => {
  it('FAILS a held config with no globalSetup at all, naming the release', () => {
    const res = run({ 'vitest.config.ts': config(HOLD, '') });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('globalSetup');
    expect(res.detail).not.toContain('does not call holdTestRun');
  });

  it('FAILS a globalSetup that runs something else', () => {
    const res = run({ 'vitest.config.ts': config(HOLD, `globalSetup: ['./db.ts']`) });
    expect(res.status, res.detail).toBe('fail');
  });

  it('PASSES the array, bare, namespace and alongside-another spellings', () => {
    for (const release of [
      RELEASE,
      'globalSetup: TEST_RUN_GLOBAL_SETUP',
      'globalSetup: [tw.TEST_RUN_GLOBAL_SETUP]',
      `globalSetup: ['./db.ts', TEST_RUN_GLOBAL_SETUP]`,
      `'globalSetup': [TEST_RUN_GLOBAL_SETUP]`,
    ]) {
      const res = run({ 'vitest.config.ts': config(HOLD, release) });
      expect(res.status, release).toBe('pass');
    }
  });

  /** This package cannot import itself by name, so the path spelling is first-class, not a fallback. */
  it('PASSES a string path to the shipped globalSetup, source or built', () => {
    for (const release of [
      `globalSetup: ['./src/test-run/globalSetup.ts']`,
      `globalSetup: ['./node_modules/ticket-workflow/dist/test-run/globalSetup.js']`,
      `globalSetup: "./src/test-run/globalSetup.mjs"`,
    ]) {
      const res = run({ 'vitest.config.ts': config(HOLD, release) });
      expect(res.status, release).toBe('pass');
    }
  });

  it('FAILS a release that is only commented out or quoted', () => {
    expect(run({ 'vitest.config.ts': config(HOLD, `/* ${RELEASE} */`) }).status).toBe('fail');
    expect(run({ 'vitest.config.ts': config(`const s = '${RELEASE}';`, '') }).status).toBe('fail');
  });

  it('FAILS a lookalike key, identifier or path', () => {
    for (const release of [
      'myGlobalSetup: [TEST_RUN_GLOBAL_SETUP]',
      'globalSetup: [TEST_RUN_GLOBAL_SETUP_OLD]',
      `globalSetup: ['./src/test-run/globalSetupHelper.ts']`,
    ]) {
      const res = run({ 'vitest.config.ts': config(HOLD, release) });
      expect(res.status, release).toBe('fail');
    }
  });

  /** The release must not mask an earlier cause: each of these is a hold defect, not a release one. */
  it('keeps the hold message when the hold itself is absent, un-awaited or nested', () => {
    for (const [preamble, expected] of [
      ['', 'does not call holdTestRun'],
      ['void holdTestRun();', 'without `await`'],
      [`if (process.env.X) { ${HOLD} }`, 'inside a block, call or condition'],
    ]) {
      const res = run({ 'vitest.config.ts': config(preamble, '') });
      expect(res.status, preamble).toBe('fail');
      expect(res.detail, preamble).toContain(expected);
    }
  });

  /** Undeterminable is BLOCKED, never a pass: the permissive answer here admits a literal from a
   *  neighbouring property, and this repo's own config carries a matching one in coverage.exclude. */
  it('BLOCKS when the value cannot be delimited, rather than reading past it', () => {
    expect(run({ 'vitest.config.ts': config(HOLD, 'globalSetup: [./unterminated') }).status).toBe('blocked');
    expect(run({ 'vitest.config.ts': `${HOLD}\nexport default { test: { globalSetup:` }).status).toBe('blocked');
  });

  it('BLOCKS on an unbalanced value instead of adopting a neighbour literal', () => {
    const res = run({
      'vitest.config.ts': rawConfig(`{
  test: {
    globalSetup: mk(,
    coverage: { exclude: ['src/test-run/globalSetup.ts'] },
  },
}`),
    });
    expect(res.status, res.detail).toBe('blocked');
  });

  it('reads past a call and a nested object in the value without stopping early', () => {
    const res = run({ 'vitest.config.ts': config(HOLD, 'globalSetup: withDb({ reset: true }, TEST_RUN_GLOBAL_SETUP)') });
    expect(res.status, res.detail).toBe('pass');
  });

  /** vitest reads `test.globalSetup` and nothing else, so mere presence is not the release. The
   *  WIRING message does not say "under test:", which is how a user lands on the first shape. */
  it('FAILS a globalSetup that is not a direct child of the test block', () => {
    for (const body of [
      `{ globalSetup: [TEST_RUN_GLOBAL_SETUP], test: { environment: 'node' } }`,
      `{ test: { typecheck: { globalSetup: [TEST_RUN_GLOBAL_SETUP] } } }`,
      `{ build: { rollupOptions: { test: { globalSetup: [TEST_RUN_GLOBAL_SETUP] } } }, test: {} }`,
    ]) {
      const res = run({ 'vitest.config.ts': rawConfig(body) });
      expect(res.status, body).toBe('fail');
    }
  });

  it('FAILS a globalSetup sitting in a dead object beside the config', () => {
    const src = `${rawConfig('{ test: {} }')}\nconst unused = { globalSetup: [TEST_RUN_GLOBAL_SETUP] };\n`;
    expect(run({ 'vitest.config.ts': src }).status).toBe('fail');
  });

  /** JS keeps the LAST duplicate key, so `some` over occurrences is the wrong quantifier. */
  it('reads the last globalSetup in the block, which is the one that runs', () => {
    const res = run({ 'vitest.config.ts': config(HOLD, `globalSetup: [TEST_RUN_GLOBAL_SETUP], globalSetup: ['./db.ts']`) });
    expect(res.status, res.detail).toBe('fail');
  });

  it('ignores a quoted globalSetup token that is not a key', () => {
    const res = run({ 'vitest.config.ts': config(`const k = 'globalSetup';`, '') });
    expect(res.status, res.detail).toBe('fail');
  });

  /** A known gap, pinned so it cannot later be mistaken for coverage: the check reads the config
   *  and never follows the reference, so a consumer's own globalSetup that calls releaseTestRun
   *  reads as unreleased. No repo wires it that way today; the message names the shape to use. */
  it('does NOT follow a local globalSetup file that might release the slot itself', () => {
    const res = run({
      'vitest.config.ts': config(HOLD, `globalSetup: ['./vitest.globalSetup.ts']`),
      'vitest.globalSetup.ts': `import { releaseTestRun } from 'ticket-workflow/test-run';\nexport default () => releaseTestRun;`,
    });
    expect(res.status, res.detail).toBe('fail');
  });

  it("PASSES this package's own config, which wires the release by path", () => {
    const own = readFileSync(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');
    const res = run({ 'vitest.config.ts': own });
    expect(res.status, res.detail).toBe('pass');
  });
});

describe('test-run-hold — advisory, and the scaffold starts wired', () => {
  it('a FAIL leaves auditExitCode at 0', () => {
    const res = run({ 'vitest.config.ts': config('') });
    expect(res.status).toBe('fail');
    expect(res.advisory).toBe(true);
    const report: AuditReport = { repoDir: '/repo', tier: 'node', tierDeclared: true, results: [res] };
    expect(auditExitCode(report)).toBe(0);
  });

  it('PASSES the init template, which also wires the release', () => {
    const template = readFileSync(new URL('../../../templates/node/vitest.config.ts', import.meta.url), 'utf8');
    expect(run({ 'vitest.config.ts': template }).status).toBe('pass');
    expect(template).toMatch(/globalSetup:\s*\[TEST_RUN_GLOBAL_SETUP\]/);
  });
});
