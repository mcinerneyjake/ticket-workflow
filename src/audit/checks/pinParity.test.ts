import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinParity } from './pinParity.js';
import { readRepoFile, type AuditContext, type Exec } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Any exec call at all is a bug: this check must be answerable offline. */
const FORBIDDEN_EXEC: Exec = () => {
  throw new Error('pin-parity must not shell out — remote freshness belongs to pin-freshness');
};

interface Repo {
  readonly pkg?: unknown;
  readonly installed?: unknown;
}

function run({ pkg, installed }: Repo) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-pin-parity-'));
  tempDirs.push(dir);
  if (pkg !== undefined) writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  if (installed !== undefined) {
    mkdirSync(path.join(dir, 'node_modules', 'ticket-workflow'), { recursive: true });
    writeFileSync(
      path.join(dir, 'node_modules', 'ticket-workflow', 'package.json'),
      typeof installed === 'string' ? installed : JSON.stringify(installed),
    );
  }
  const ctx: AuditContext = { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec: FORBIDDEN_EXEC };
  return pinParity.run(ctx);
}

const consumer = (ref: string) => ({ dependencies: { 'ticket-workflow': `github:someowner/ticket-workflow#${ref}` } });

describe('pin-parity — deterministic and offline', () => {
  it('passes when the pinned tag is installed', () => {
    const res = run({ pkg: consumer('v0.24.0'), installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('v0.24.0');
  });

  it('is core tier and GATING — a consumer runs the audit as a required check', () => {
    expect(pinParity.tier).toBe('core');
    expect(pinParity.advisory).toBeUndefined();
  });

  // The whole point of the split: an unreachable network must not touch this answer.
  it('never shells out, so an unreachable remote cannot change the verdict', () => {
    expect(() => run({ pkg: consumer('v0.24.0'), installed: { version: '0.24.0' } })).not.toThrow();
  });
});

describe('pin-parity — does not fire on a non-consumer', () => {
  it('passes when no dependency map names the package', () => {
    expect(run({ pkg: { name: 'unrelated', dependencies: { vitest: '^3.0.0' } } }).status).toBe('pass');
  });

  it('passes when package.json is absent entirely (a core-tier repo)', () => {
    expect(run({}).status).toBe('pass');
  });

  // The self-audit trap: this package's OWN package.json names `ticket-workflow` under `bin`, and
  // CI audits this repo with `audit .`. Reading `bin` as a pin reddens the package's own gate.
  it('ignores a self-referencing `bin` entry', () => {
    const res = run({ pkg: { name: 'ticket-workflow', version: '0.24.0', bin: { 'ticket-workflow': 'dist/cli/index.js' } } });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).not.toContain('bin');
  });
});

describe('pin-parity — a declaration that cannot be read is never a PASS', () => {
  // Review finding 4: `typeof spec === 'string'` fell through to "no dependency", which both
  // returned the permissive answer AND said something false about the manifest.
  for (const value of [null, 42, { ref: 'v0.24.0' }, ['v0.24.0']]) {
    it(`blocks when the declaration is ${JSON.stringify(value)} rather than a string`, () => {
      const res = run({ pkg: { dependencies: { 'ticket-workflow': value } } });
      expect(res.status, res.detail).toBe('blocked');
      expect(res.detail, 'must not claim the package is undeclared').not.toContain('no dependency');
    });
  }

  // Review finding 5: only the first hit was read, so a second, disagreeing pin was invisible.
  it('blocks when two maps declare disagreeing specs', () => {
    const res = run({
      pkg: {
        dependencies: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.24.0' },
        devDependencies: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.9.0' },
      },
      installed: { version: '0.24.0' },
    });
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('v0.9.0');
  });

  it('accepts the same spec declared in two maps', () => {
    const spec = 'github:someowner/ticket-workflow#v0.24.0';
    const res = run({ pkg: { dependencies: { 'ticket-workflow': spec }, peerDependencies: { 'ticket-workflow': spec } }, installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('pass');
  });
});

describe('pin-parity — every dependency map counts', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    it(`reads the pin from ${field}`, () => {
      const res = run({
        pkg: { [field]: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.23.0' } },
        installed: { version: '0.24.0' },
      });
      expect(res.status, res.detail).toBe('fail');
      expect(res.detail).toContain('0.24.0');
    });
  }
});

describe('pin-parity — requested vs installed', () => {
  it('fails when the installed version is behind the pinned tag (the stale-sha state)', () => {
    const res = run({ pkg: consumer('v0.24.0'), installed: { version: '0.23.0' } });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('0.23.0');
    expect(res.detail).toContain('v0.24.0');
  });

  it('fails when the installed version is AHEAD of the pinned tag', () => {
    const res = run({ pkg: consumer('v0.23.0'), installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('fail');
  });
});

describe('pin-parity — "cannot determine" is never PASS', () => {
  it('blocks when the package is declared as a runtime dep but not installed', () => {
    expect(run({ pkg: consumer('v0.24.0') }).status).toBe('blocked');
  });

  it('blocks when the installed manifest carries no version', () => {
    expect(run({ pkg: consumer('v0.24.0'), installed: { name: 'ticket-workflow' } }).status).toBe('blocked');
  });

  it('blocks when the installed manifest is not valid JSON', () => {
    expect(run({ pkg: consumer('v0.24.0'), installed: '{ not json' }).status).toBe('blocked');
  });

  it('blocks when the consumer package.json is not valid JSON', () => {
    expect(run({ pkg: '{ not json' }).status).toBe('blocked');
  });

  it('blocks on a spec shape it cannot read as a git pin', () => {
    const res = run({ pkg: { dependencies: { 'ticket-workflow': '^0.24.0' } }, installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('blocked');
  });
});

describe('pin-parity — an optional/peer dependency may legally be absent', () => {
  // Review finding 11: absence is a legal state for these two, so BLOCKED-forever was wrong.
  for (const field of ['optionalDependencies', 'peerDependencies'] as const) {
    it(`passes when declared only in ${field} and not installed`, () => {
      const res = run({ pkg: { [field]: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.24.0' } } });
      expect(res.status, res.detail).toBe('pass');
      expect(res.detail).toContain('optional');
    });
  }

  it('still blocks when a runtime dep ALSO declares it and it is missing', () => {
    const spec = 'github:someowner/ticket-workflow#v0.24.0';
    const res = run({ pkg: { dependencies: { 'ticket-workflow': spec }, optionalDependencies: { 'ticket-workflow': spec } } });
    expect(res.status, res.detail).toBe('blocked');
  });
});

describe('pin-parity — rejection cases: a pin that is not a version tag', () => {
  it('fails a git spec with no fragment (a branch, which the standard forbids)', () => {
    const res = run({ pkg: { dependencies: { 'ticket-workflow': 'github:someowner/ticket-workflow' } }, installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('tag');
  });

  it('fails a git spec pinned to a branch name', () => {
    const res = run({ pkg: consumer('main'), installed: { version: '0.24.0' } });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('main');
  });
});
