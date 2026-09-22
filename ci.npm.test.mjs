import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { steps } from './ci.workflow.mjs';
import {
  floorOf, versionCore, verdict, isFloorOnly, isPrerelease, compareCore, readFloorSpec,
} from './scripts/checkCiNpm.mjs';
import {
  floorOf as canonicalFloorOf,
  versionCore as canonicalVersionCore,
  isPrerelease as canonicalIsPrerelease,
} from './src/audit/checks/npmVersion.js';
import { compareSemver } from './src/audit/checks/pinSpec.js';

/**
 * CI's npm is an unpinned floating input that `engine-strict` makes gate-critical (tkt-877dd0a70e1e,
 * filed by tkt-61ec9c048684's review). `setup-node` resolves whatever npm the runner image's cached
 * Node bundles, and the floor sits exactly at it — src/npmFloor.test.ts owns that measured pair;
 * it is deliberately not restated here.
 *
 * The guard is deliberately an assertion, not a pin. Force-installing an npm would make the engine
 * check pass by construction and hide the one thing CI currently proves for consumers, who inherit
 * this repo's `.npmrc`: that a stock Node 24 satisfies the floor (tkt-61ec9c048684, arm A).
 */
const GUARD = 'node scripts/checkCiNpm.mjs';

const gateYml = readFileSync(
  fileURLToPath(new URL('./.github/workflows/gate.yml', import.meta.url)),
  'utf8',
);

const guardSteps = (yaml) => steps(yaml, 'suite').filter((s) => s.run === GUARD);

/** Unconditional and blocking: a skipped step does not fail its job, so the gate would stay green. */
const soundGuardSteps = (yaml) =>
  guardSteps(yaml).filter((s) => s.if === undefined && s['continue-on-error'] === undefined);

describe('the CI gate binds its npm to the engines floor', () => {
  it('runs the guard in the suite job, unconditional and blocking', () => {
    expect(guardSteps(gateYml).length, 'no npm-floor guard step in the suite job').toBeGreaterThan(0);
    expect(soundGuardSteps(gateYml).length, 'no sound npm-floor guard step survives').toBeGreaterThan(0);
  });

  it('runs before `npm ci`, which is the command it exists to explain', () => {
    const run = steps(gateYml, 'suite').map((s) => s.run ?? '');
    const guard = run.indexOf(GUARD);
    const ci = run.findIndex((c) => /^npm ci\b/.test(c));
    expect(guard, 'no npm-floor guard step').toBeGreaterThanOrEqual(0);
    expect(ci, 'no `npm ci` step for the guard to precede').toBeGreaterThanOrEqual(0);
    expect(guard, 'the guard must precede `npm ci` or EBADENGINE reports first').toBeLessThan(ci);
  });

  // Controls on the matcher, against fixtures rather than the live file.
  describe('the matcher, against known defeats', () => {
    const fixture = (step) => `jobs:\n  suite:\n    steps:\n${step}\n      - run: npm ci\n  gate:\n    needs: [suite]\n`;
    const canonical = `      - run: ${GUARD}`;

    it('accepts the canonical step, however it is spelled', () => {
      expect(soundGuardSteps(fixture(canonical))).toHaveLength(1);
      expect(
        soundGuardSteps(fixture(`      - name: Check CI npm against the floor\n        run: ${GUARD}`)),
      ).toHaveLength(1);
    });

    it.each([
      ['a conditional step', `${canonical}\n        if: false`],
      ['a non-blocking step', `${canonical}\n        continue-on-error: true`],
      ['a shell escape', `      - run: ${GUARD} || true`],
      ['a swallowed exit', `      - run: ${GUARD}; exit 0`],
      ['a block scalar, which this matcher cannot read', `      - run: |\n          ${GUARD}`],
      ['a commented-out step', `      # - run: ${GUARD}`],
      ['a deleted step', '      - run: npm run lint'],
    ])('rejects %s', (_, step) => {
      expect(soundGuardSteps(fixture(step))).toHaveLength(0);
    });
  });
});

/**
 * The guard runs before `npm ci`, so it cannot import the canonical parser in
 * src/audit/checks/npmVersion.ts and carries a copy. These hold the two to agreement over one
 * corpus, so the copy cannot drift into disagreeing about a floor — which is the only way the
 * duplication could hurt. Every row that inverts a naive "first number in the string" reading is
 * present deliberately.
 */
describe('the guard parses floors exactly as the audit check does', () => {
  const CORPUS = [
    '>=11.19.0', '>= 11.19.1', '11.19.0', '^11', '~11.19', '11', '24.0.0-rc.1',
    '*', 'x', 'X',
    '<11', '<=11.19.0', '1.x || >=10', '>=10 || >=12', '', '   ', 'latest', 'abc',
  ];

  it.each(CORPUS)('agrees on %o', (spec) => {
    expect(floorOf(spec)).toEqual(canonicalFloorOf(spec));
    expect(versionCore(spec)).toEqual(canonicalVersionCore(spec));
  });

  it('the corpus is discriminating, not uniformly one verdict', () => {
    const kinds = new Set(CORPUS.map((s) => floorOf(s).kind));
    expect(kinds, 'a corpus that is all one kind would pass a broken parser').toEqual(
      new Set(['floor', 'none', 'indeterminate']),
    );
  });
});

describe('the verdict', () => {
  it('admits an npm above the floor', () => {
    const v = verdict('>=11.19.0', '11.20.0');
    expect(v.ok).toBe(true);
    expect(v.message).not.toContain('no headroom');
  });

  it('admits an npm exactly at the floor, and says there is no headroom', () => {
    const v = verdict('>=11.19.0', '11.19.0');
    expect(v.ok).toBe(true);
    expect(v.message).toContain('no headroom');
  });

  it('refuses an npm below the floor, naming both versions', () => {
    const v = verdict('>=11.19.0', '11.5.1');
    expect(v.ok).toBe(false);
    expect(v.message).toContain('11.5.1');
    expect(v.message).toContain('>=11.19.0');
  });

  it('refuses a prerelease of the floor, which sorts below its own release', () => {
    expect(verdict('>=11.19.0', '11.19.0-rc.1').ok).toBe(false);
  });

  it('passes when there is no floor at all, and when every npm satisfies it', () => {
    expect(verdict(undefined, '1.0.0').ok).toBe(true);
    expect(verdict('*', '1.0.0').ok).toBe(true);
  });

  // The fail-closed half: an undetermined answer is never the permissive one.
  it.each([
    ['an upper bound, not a floor', '<11'],
    ['a union with no single lower bound', '1.x || >=10'],
    ['an empty spec', ''],
    ['a spec declaring no version', 'latest'],
  ])('refuses %s rather than guessing', (_, spec) => {
    expect(verdict(spec, '11.19.1').ok).toBe(false);
  });

  it('refuses an unparseable installed version', () => {
    expect(verdict('>=11.19.0', 'not-a-version').ok).toBe(false);
  });
});

/**
 * Exit status, not just the pure verdict: a `main()` that computed the right answer and exited 0
 * regardless would be a guard that reports success, and no assertion above would notice.
 * `npm --version` is shimmed on PATH because the real one cannot be asked to be old.
 */
describe('the script as CI runs it', () => {
  const script = fileURLToPath(new URL('./scripts/checkCiNpm.mjs', import.meta.url));
  // These three are the only tests here that spawn a subprocess, and this suite is measurably
  // load-sensitive under parallelism (tkt-2eb570851bad). Headroom over the 20s default so a busy
  // machine reports the guard's verdict rather than a timeout.
  const SPAWN_TIMEOUT_MS = 60_000;

  function runWithNpmVersion(version) {
    const dir = mkdtempSync(join(tmpdir(), 'tw-cinpm-'));
    try {
      const shim = join(dir, 'npm');
      writeFileSync(shim, `#!/bin/sh\necho "${version}"\n`);
      chmodSync(shim, 0o755);
      try {
        const stdout = execFileSync('node', [script], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
          cwd: dirname(script),
        });
        return { code: 0, output: stdout };
      } catch (err) {
        return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 when the shimmed npm clears the floor — the positive control', () => {
    const { code, output } = runWithNpmVersion('99.0.0');
    expect(code, 'the shim itself must work, or the failure below proves nothing').toBe(0);
    expect(output).toContain('99.0.0');
  }, SPAWN_TIMEOUT_MS);

  it('exits non-zero when the shimmed npm is below the floor', () => {
    const { code, output } = runWithNpmVersion('11.5.1');
    expect(code).not.toBe(0);
    expect(output).toContain('11.5.1');
    expect(output).toContain('BELOW');
  }, SPAWN_TIMEOUT_MS);

  it('exits non-zero when npm cannot be run at all', () => {
    // `process.execPath`, never 'node': pointing PATH at an empty dir also hides node, so spawning
    // by name fails with ENOENT and status null BEFORE the guard runs — `err.status ?? 1` then
    // manufactures a pass and the branch is never exercised. Measured; this control did exactly
    // that in its first cut.
    const dir = mkdtempSync(join(tmpdir(), 'tw-cinpm-empty-'));
    try {
      let code = 0;
      let output = '';
      try {
        execFileSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, PATH: dir }, cwd: dirname(script) });
      } catch (err) {
        code = err.status;
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      expect(code, 'an npm it cannot run is not an npm that satisfies the floor').toBe(1);
      expect(output, 'the guard must have run and reported, not failed to spawn').toContain('npm --version failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT_MS);
});

/**
 * The remaining duplicated helpers. The corpus above covers floorOf/versionCore; these two were
 * unheld in the first cut while the header claimed the copy "cannot drift silently" — and comparator
 * fixes are not hypothetical here (the commit before this branch was one).
 */
describe('the guard agrees with the canonical helpers it copies', () => {
  const VERSIONS = ['11.19.0', '11.19.1', '11.5.1', '12.0.0', '11.19.0-rc.1', '0.0.1', '11', '11.19'];

  it.each(VERSIONS)('agrees on whether %o is a prerelease', (v) => {
    expect(isPrerelease(v)).toBe(canonicalIsPrerelease(v));
  });

  it('the prerelease corpus is discriminating', () => {
    expect(VERSIONS.some(isPrerelease), 'no prerelease in the corpus').toBe(true);
    expect(VERSIONS.some((v) => !isPrerelease(v)), 'no release in the corpus').toBe(true);
  });

  it.each([
    ['11.19.0', '11.19.1'], ['11.19.1', '11.19.0'], ['11.19.0', '11.19.0'],
    ['12.0.0', '11.99.99'], ['11.5.1', '11.19.0'], ['2.0.0', '10.0.0'],
  // Sign, not magnitude: compareSemver returns the raw difference (5 - 19) while compareCore
  // normalizes to -1/0/1. Both are consumed as `< 0` / `=== 0`, so agreeing on sign IS agreeing.
  ])('orders %o against %o as compareSemver does', (a, b) => {
    const [ca, cb] = [versionCore(a), versionCore(b)];
    expect(Math.sign(compareCore(ca, cb))).toBe(Math.sign(compareSemver(ca, cb)));
  });
});

/**
 * npm enforces the whole range, this check reads only a floor — so any spec that is not a bare
 * lower bound must refuse rather than compare. Each row below PASSED in the first cut with an
 * npm 12.3.0 shim while `npm ci` would have refused it (measured).
 */
describe('a spec that is not a bare lower bound is refused, not floor-read', () => {
  it.each(['^11.19.0', '~11.19.0', '>=11.19.0 <12', '11.19.0', '>11.19.0', '=11.19.0'])(
    'refuses %o even when the installed npm clears its lower bound',
    (spec) => {
      expect(isFloorOnly(spec)).toBe(false);
      const v = verdict(spec, '12.3.0');
      expect(v.ok, 'npm would refuse this range; the guard must not report green').toBe(false);
      expect(v.message).toContain('not a bare lower bound');
    },
  );

  it.each(['>=11.19.0', '>= 11.19.1', '>=11', '>=11.19'])('still admits the sound spelling %o', (spec) => {
    expect(isFloorOnly(spec)).toBe(true);
    expect(verdict(spec, '12.3.0').ok).toBe(true);
  });

  it("this repo's own engines.npm is a spelling the guard can answer", () => {
    const pkg = readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8');
    const { ok, floorSpec } = readFloorSpec(pkg);
    expect(ok).toBe(true);
    expect(isFloorOnly(floorSpec), `engines.npm ${floorSpec} would make the CI guard refuse`).toBe(true);
  });
});

/**
 * A malformed `engines` left floorSpec undefined in the first cut, which verdict() reads as "no
 * floor" — so the guard printed "no engines.npm floor" and exited 0 while engine-strict enforced
 * nothing. Fail-closed now: an undetermined shape is never the permissive answer.
 */
describe('a malformed package.json refuses rather than reporting no floor', () => {
  it.each([
    ['engines as a string', '{"engines":">=11.19.0"}'],
    ['engines as an array', '{"engines":["x"]}'],
    ['engines as null', '{"engines":null}'],
    ['engines.npm not a string', '{"engines":{"npm":11}}'],
    ['a top-level array', '[]'],
    ['a top-level string', '"hello"'],
    ['invalid JSON', '{'],
  ])('refuses %s', (_, text) => {
    expect(readFloorSpec(text).ok).toBe(false);
  });

  it.each([
    ['no engines key', '{}'],
    ['engines without npm', '{"engines":{"node":">=24"}}'],
  ])('reads %s as a genuine absence, which is a measured answer', (_, text) => {
    const r = readFloorSpec(text);
    expect(r.ok).toBe(true);
    expect(r.floorSpec).toBeUndefined();
  });
});
