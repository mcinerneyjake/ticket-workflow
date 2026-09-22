import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { floorOf, versionCore } from './audit/checks/npmVersion.js';
import { compareSemver, type Semver } from './audit/checks/pinSpec.js';
import { isRecord } from './audit/types.js';

// tkt-61ec9c048684. The npm floor is a mechanism, not a declaration, and a test that only checked
// "a floor is declared" would pass through three different disarmed states.
//
// BOTH HALVES. `engines.npm` without engine-strict only warns — measured, a consumer install with
// an impossible floor and no `.npmrc` exits 0 and strips `libc` regardless.
//
// BOTH BOUNDS, because the floor fails two ways:
//   too LOW  admits npm 11.5.1, measured to strip `libc` from all ten optional native entries
//            (tkt-e4089552c6f6) — the defect the floor exists to refuse, and `>=11` reads as fine;
//   too HIGH excludes npm 11.19.0, what Node 24 bundles (v24.21.0), so engine-strict would
//            hard-fail this repo's own `npm ci` and, consumers inheriting the file, theirs too.
//
// AND THE SHAPE: floorOf reads only a range's lower bound, so an exact pin and a capped range yield
// the same floor as `>=11.19.0` and keep every assertion below green while refusing npm 11.19.1 and
// 11.20+ respectively. Measured; that is why the spelling itself is asserted.

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/** Measured on copies of this repo's lockfile; the ticket carries the four-arm table. */
const STRIPS_LIBC = '11.5.1';
const NODE_24_BUNDLES = '11.19.0';

/**
 * The staged blob, not the worktree file. A `.npmrc` removed from the index but left on disk would
 * otherwise keep this suite green while the committed tree ships no guard — the same reason
 * repoHygiene.test.ts scans the index. Absent or unreadable throws, so it fails red, never open.
 */
function staged(file: string): string {
  return execFileSync('git', ['show', `:${file}`], { cwd: repoRoot, encoding: 'utf8' });
}

/**
 * npm reads `.npmrc` with `ini`, and two of its rules separate an armed guard from a green test
 * over a disarmed one (both measured against npm 11.19.1's bundled `ini`): the LAST duplicate key
 * wins, not the first, and a key beneath a `[section]` header is not top-level config at all. A
 * section header therefore throws rather than being parsed past. A bare key is `true` to npm, so
 * reading it as "no value" would call an armed file disarmed.
 */
function npmrcValue(contents: string, key: string): string | undefined {
  let value: string | undefined;
  for (const raw of contents.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('[')) throw new Error(`.npmrc declares a section (${line}); keys under it are not top-level config`);
    const eq = line.indexOf('=');
    if (eq === -1) {
      if (line === key) value = 'true';
      continue;
    }
    if (line.slice(0, eq).trim() !== key) continue;
    value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return value;
}

function enginesNpm(): string {
  const parsed: unknown = JSON.parse(staged('package.json'));
  if (!isRecord(parsed)) throw new Error('package.json is not a JSON object');
  const engines = parsed.engines;
  if (!isRecord(engines)) throw new Error('package.json declares no engines object');
  const npm = engines.npm;
  if (typeof npm !== 'string') throw new Error(`package.json declares no engines.npm string: ${JSON.stringify(npm)}`);
  return npm;
}

/** Throws rather than returning a sentinel a comparison would silently treat as 0.0.0. */
function declaredFloor(): Semver {
  const spec = enginesNpm();
  const floor = floorOf(spec);
  if (floor.kind !== 'floor') throw new Error(`engines.npm ${JSON.stringify(spec)} yields no floor: ${floor.kind}`);
  return floor.version;
}

function core(version: string): Semver {
  const parsed = versionCore(version);
  if (parsed === undefined) throw new Error(`unparseable version ${JSON.stringify(version)}`);
  return parsed;
}

describe('npm floor', () => {
  it('declares an engines.npm floor a range parser can read a lower bound out of', () => {
    expect(floorOf(enginesNpm()).kind).toBe('floor');
  });

  it('spells the floor as a bare lower bound — not a pin, a caret, or a capped range', () => {
    expect(enginesNpm()).toMatch(/^>=\s*\d+\.\d+\.\d+$/);
  });

  it('enables engine-strict, without which the floor only warns', () => {
    expect(npmrcValue(staged('.npmrc'), 'engine-strict')).toBe('true');
  });

  it(`refuses npm ${STRIPS_LIBC}, measured to strip libc from the lockfile`, () => {
    expect(compareSemver(core(STRIPS_LIBC), declaredFloor())).toBeLessThan(0);
  });

  it(`admits npm ${NODE_24_BUNDLES}, which Node 24 bundles — a higher floor reddens every consumer`, () => {
    expect(compareSemver(core(NODE_24_BUNDLES), declaredFloor())).toBeGreaterThanOrEqual(0);
  });
});

describe('npmrcValue matches npm ini where it matters', () => {
  // Each row is a real disarmed-or-armed file this assertion must not misread. The first two were
  // fail-open in the first cut of this test: green suite, npm not armed.
  const rows: readonly (readonly [string, string, string | undefined])[] = [
    ['last duplicate wins, as ini does', 'engine-strict=true\nengine-strict=false\n', 'false'],
    ['a bare key is true to npm', 'engine-strict\n', 'true'],
    ['a quoted value is unquoted', 'engine-strict="true"\n', 'true'],
    ['comments are not values', '# engine-strict=true\n', undefined],
    ['an unrelated key is not the answer', 'engine-strict-ish=true\n', undefined],
  ];

  it.each(rows)('%s', (_label, contents, expected) => {
    expect(npmrcValue(contents, 'engine-strict')).toBe(expected);
  });

  it('refuses a sectioned file rather than reading a key npm would not honour', () => {
    expect(() => npmrcValue('[scope]\nengine-strict=true\n', 'engine-strict')).toThrow(/section/);
  });
});
