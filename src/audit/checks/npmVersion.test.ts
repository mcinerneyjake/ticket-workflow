import { describe, expect, it } from 'vitest';
import { floorOf, npmVersion, versionCore } from './npmVersion.js';
import { auditExitCode } from '../run.js';
import type { AuditContext, Exec, ReadResult } from '../types.js';

/** Context is fully injected: the exec failure modes (npm absent, crashing, printing garbage) have
 *  no filesystem spelling, and a real `npm` would make the floor assertions machine-dependent. */
function ctxWith(pkg: ReadResult, exec: Exec): AuditContext {
  return { repoDir: '/repo', read: (rel) => (rel === 'package.json' ? pkg : { kind: 'missing' }), exec };
}

const pkgJson = (obj: unknown): ReadResult => ({ kind: 'ok', contents: JSON.stringify(obj) });
const npmPrints = (stdout: string): Exec => () => ({ kind: 'ran', ok: true, status: 0, stdout, stderr: '' });
/** Fails the test if the check consults npm at all — the floor branches must short-circuit first. */
const npmNeverRuns: Exec = () => {
  throw new Error('npm must not be consulted on this path');
};

function run(pkg: ReadResult, exec: Exec = npmPrints('11.19.1')) {
  return npmVersion.run(ctxWith(pkg, exec));
}

describe('npm-version — registration contract', () => {
  it('is advisory: the installed npm is a machine fact, so it must never move the gate', () => {
    expect(npmVersion.advisory).toBe(true);
    expect(npmVersion.id).toBe('npm-version');
    expect(npmVersion.tier).toBe('node');
  });
});

describe('npm-version — floor comparison', () => {
  it('passes when the installed npm is above the declared floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10' } }), npmPrints('11.19.1'));
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('11.19.1');
  });

  it('passes at the boundary — installed exactly equals a partial floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10' } }), npmPrints('10.0.0'));
    expect(res.status, res.detail).toBe('pass');
  });

  it('fails when the installed npm is below the floor, naming both versions', () => {
    const res = run(pkgJson({ engines: { npm: '>=11.5.0' } }), npmPrints('10.9.3'));
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('10.9.3');
    expect(res.detail).toContain('>=11.5.0');
  });

  /** The trap CLAUDE.md names for tags ("lexical sort puts v0.10.0 beside v0.1.0"), one component
   *  down: '10.9.0' > '10.10.0' as strings, and < as versions. */
  it('compares numerically, not lexically: 10.9.0 is BELOW a 10.10.0 floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10.10.0' } }), npmPrints('10.9.0'));
    expect(res.status, res.detail).toBe('fail');
  });

  it('does not read a two-digit minor as smaller: 10.10.0 satisfies a 10.9.0 floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10.9.0' } }), npmPrints('10.10.0'));
    expect(res.status, res.detail).toBe('pass');
  });

  it('takes the lower bound of a compound range as the floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10 <12' } }), npmPrints('11.0.0'));
    expect(res.status, res.detail).toBe('pass');
  });

  it('passes a prerelease that is above the floor', () => {
    const res = run(pkgJson({ engines: { npm: '>=10' } }), npmPrints('11.0.0-pre.0'));
    expect(res.status, res.detail).toBe('pass');
  });

  /** A prerelease sorts below its own release, so an equal numeric core must not pass. */
  it('fails a prerelease OF the floor itself — 11.0.0-pre.0 does not satisfy >=11.0.0', () => {
    const res = run(pkgJson({ engines: { npm: '>=11.0.0' } }), npmPrints('11.0.0-pre.0'));
    expect(res.status, res.detail).toBe('fail');
  });
});

/**
 * Measured on the first cut of this check, which took "the first number in the string" as the floor:
 * '<11' yielded 11 and FAILED an npm 10.9.3 that satisfies the range, advising the user to install
 * the one version it forbids. An upper bound is not a floor, and a union has no single one.
 */
describe('npm-version — a range whose lower bound cannot be read is BLOCKED, never guessed', () => {
  it('does not read an upper bound as a floor', () => {
    const res = run(pkgJson({ engines: { npm: '<11' } }), npmPrints('10.9.3'));
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('upper bound');
  });

  it('refuses a || union rather than taking its first branch', () => {
    const res = run(pkgJson({ engines: { npm: '1.x || >=10' } }), npmPrints('9.0.0'));
    expect(res.status, res.detail).toBe('blocked');
  });

  it('still reads the lower bound of a compound range with an upper bound second', () => {
    const res = run(pkgJson({ engines: { npm: '>=10 <12' } }), npmPrints('9.9.9'));
    expect(res.status, res.detail).toBe('fail');
  });

  it('reads the lower bound of a hyphen range', () => {
    const res = run(pkgJson({ engines: { npm: '10 - 12' } }), npmPrints('9.0.0'));
    expect(res.status, res.detail).toBe('fail');
  });
});

describe('npm-version — a wildcard floor is PASS, not BLOCKED', () => {
  for (const spec of ['*', 'x', 'X']) {
    it(`engines.npm ${JSON.stringify(spec)} passes without consulting npm`, () => {
      const res = run(pkgJson({ engines: { npm: spec } }), npmNeverRuns);
      expect(res.status, res.detail).toBe('pass');
    });
  }
});

describe('npm-version — no floor declared is PASS and inert, not FAIL', () => {
  it('passes, without consulting npm, when package.json has no engines block', () => {
    const res = run(pkgJson({ name: 'x' }), npmNeverRuns);
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('no engines.npm floor');
  });

  it('passes when engines exists but declares only node', () => {
    const res = run(pkgJson({ engines: { node: '>=24' } }), npmNeverRuns);
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('no engines.npm floor');
  });

  /** The check must be inert on THIS repo until tkt-61ec9c048684 declares a floor — that is the
   *  property which keeps it off every consumer's gate, so it is asserted rather than assumed. */
  it("is inert on this repo's own shape (engines: node only)", () => {
    const res = run(pkgJson({ engines: { node: '>=24' }, name: 'ticket-workflow' }), npmNeverRuns);
    expect(res.status).toBe('pass');
  });
});

describe('npm-version — undetermined is BLOCKED, never PASS', () => {
  const undetermined: readonly (readonly [string, ReadResult, Exec])[] = [
    ['package.json absent', { kind: 'missing' }, npmNeverRuns],
    ['package.json unreadable', { kind: 'error', message: 'EACCES' }, npmNeverRuns],
    ['package.json is not valid JSON', { kind: 'ok', contents: '{nope' }, npmNeverRuns],
    ['package.json is not an object', { kind: 'ok', contents: '[]' }, npmNeverRuns],
    ['engines is not an object', pkgJson({ engines: ['npm'] }), npmNeverRuns],
    ['engines.npm is not a string', pkgJson({ engines: { npm: 10 } }), npmNeverRuns],
    ['engines.npm has no parseable version', pkgJson({ engines: { npm: 'latest' } }), npmNeverRuns],
    ['npm is not on PATH', pkgJson({ engines: { npm: '>=10' } }), () => ({ kind: 'absent' })],
    ['npm exec errored', pkgJson({ engines: { npm: '>=10' } }), () => ({ kind: 'error', message: 'EPERM' })],
    [
      'npm exited non-zero',
      pkgJson({ engines: { npm: '>=10' } }),
      () => ({ kind: 'ran', ok: false, status: 1, stdout: '', stderr: 'boom' }),
    ],
    ['npm printed no version', pkgJson({ engines: { npm: '>=10' } }), npmPrints('not a version')],
    ['npm printed nothing', pkgJson({ engines: { npm: '>=10' } }), npmPrints('')],
  ];

  for (const [name, pkg, exec] of undetermined) {
    it(`${name} → blocked`, () => {
      const res = run(pkg, exec);
      expect(res.status, `${name}: ${res.detail}`).toBe('blocked');
    });
  }

  /** A ratchet, not a restatement: the loop above already proves each row is `blocked`, so asserting
   *  "none of them passed" could never go red. What is NOT otherwise pinned is the size of the list,
   *  which is what a later edit would quietly shrink. */
  it('the undetermined list has not lost rows', () => {
    expect(undetermined.length).toBeGreaterThanOrEqual(12);
  });
});

/**
 * The guarantee the whole design rests on: a FAIL here must never move a consumer's gate. Asserting
 * `advisory === true` on the object literal restates the source; this drives the real result through
 * auditExitCode, the function that actually decides. Mirrors pin-freshness's control (audit.test.ts).
 */
describe('npm-version — advisory means a FAIL cannot move the exit code', () => {
  it('a genuine FAIL leaves auditExitCode at 0', () => {
    const res = run(pkgJson({ engines: { npm: '>=99' } }), npmPrints('11.19.1'));
    expect(res.status, res.detail).toBe('fail');
    expect(res.advisory).toBe(true);
    const report = { repoDir: '/repo', tier: 'node', tierDeclared: true, results: [res] };
    expect(auditExitCode(report)).toBe(0);
  });

  it('control — the same FAIL from a NON-advisory check does move it to 2', () => {
    const gating = { ...run(pkgJson({ engines: { npm: '>=99' } }), npmPrints('11.19.1')), advisory: false };
    const report = { repoDir: '/repo', tier: 'node', tierDeclared: true, results: [gating] };
    expect(auditExitCode(report)).toBe(2);
  });
});

describe('versionCore', () => {
  it('fills absent components with 0 so a partial version compares against a full one', () => {
    expect(versionCore('10')).toEqual([10, 0, 0]);
    expect(versionCore('10.9')).toEqual([10, 9, 0]);
    expect(versionCore('11.19.1')).toEqual([11, 19, 1]);
  });

  it('returns undefined when there is no number at all', () => {
    expect(versionCore('latest')).toBeUndefined();
    expect(versionCore('')).toBeUndefined();
  });
});

describe('floorOf', () => {
  it('reads the lower bound of the range spellings that have one', () => {
    expect(floorOf('>=10')).toEqual({ kind: 'floor', version: [10, 0, 0] });
    expect(floorOf('^10.9')).toEqual({ kind: 'floor', version: [10, 9, 0] });
    expect(floorOf('~10.9.1')).toEqual({ kind: 'floor', version: [10, 9, 1] });
    expect(floorOf('11.19.1')).toEqual({ kind: 'floor', version: [11, 19, 1] });
    expect(floorOf('10.x')).toEqual({ kind: 'floor', version: [10, 0, 0] });
  });

  it('treats a wildcard as no floor rather than an unparseable one', () => {
    expect(floorOf('*').kind).toBe('none');
    expect(floorOf('  x  ').kind).toBe('none');
  });

  it('refuses the spellings whose lower bound it cannot name', () => {
    expect(floorOf('<11').kind).toBe('indeterminate');
    expect(floorOf('<=11').kind).toBe('indeterminate');
    expect(floorOf('1.x || >=10').kind).toBe('indeterminate');
    expect(floorOf('latest').kind).toBe('indeterminate');
    expect(floorOf('').kind).toBe('indeterminate');
  });
});
