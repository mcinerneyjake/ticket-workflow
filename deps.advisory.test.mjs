import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Advisories this lockfile has already answered, asserted so a lockfile regeneration cannot silently
 * undo them (tkt-a4a3b8323462).
 *
 * Dependabot cannot land this one itself: its solver reports "A patched version exists for js-yaml,
 * but the available update path would downgrade gray-matter from 4.0.3 to 2.0.1" and exits 1, so
 * `update_files` has failed on every attempt since 2026-08-09 and no PR is ever opened. npm's own
 * resolver disagrees — `npm update js-yaml` moves it in one command and leaves gray-matter at 4.0.3,
 * because `^3.13.1` admits 3.15.1. The bump is therefore by hand, and this is what keeps it.
 *
 * Deliberately NOT an `overrides` entry, which was Dependabot's other suggestion. Two reasons: npm
 * already picks the highest satisfying version unaided (proven by the one-command update), so an
 * override buys nothing here; and it would force the version on any future transitive consumer inside
 * this repo without saying so. A failing test names the problem instead of hiding it.
 */
const lock = JSON.parse(readFileSync(fileURLToPath(new URL('./package-lock.json', import.meta.url)), 'utf8'));

/** Every locked copy of a package — npm nests duplicates, and one un-bumped nested copy is still the CVE. */
export function lockedVersions(name) {
  return Object.entries(lock.packages)
    .filter(([p]) => p.endsWith(`node_modules/${name}`))
    .map(([, v]) => v.version);
}

/** Numeric, not lexical: '3.9.0' > '3.15.1' as strings. Throws rather than guessing on an odd shape. */
export function atLeast(version, floor) {
  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) throw new Error(`unparseable version ${JSON.stringify(s)}`);
    return Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]);
  };
  return parse(version) >= parse(floor);
}

// GHSA-5p4m-2wfm-xmqj — quadratic CPU consumption in !!omap resolution. Transitive via gray-matter,
// which is the frontmatter parser the whole ticket engine reads through, so it is on the hot path.
const ADVISORIES = [{ name: 'js-yaml', floor: '3.15.1', ghsa: 'GHSA-5p4m-2wfm-xmqj' }];

describe('security advisories answered in the lockfile', () => {
  it.each(ADVISORIES)('$name is at or above $floor ($ghsa)', ({ name, floor }) => {
    const found = lockedVersions(name);
    // Pinned outside the assertion below: a package that vanishes from the lock would otherwise pass
    // this while the advisory goes unchecked — and a package renamed out of the tree is exactly when
    // nobody is looking.
    expect(found.length, `${name} is not in the lockfile at all`).toBeGreaterThan(0);
    for (const v of found) {
      expect(atLeast(v, floor), `${name}@${v} is below the patched ${floor}`).toBe(true);
    }
  });

  it('compares versions numerically, and refuses a version it cannot read', () => {
    // The control. Lexically '3.9.0' > '3.15.1', which would pass a naive string compare and report
    // a vulnerable tree as clean — the flattering-number failure this file exists to avoid.
    expect(atLeast('3.9.0', '3.15.1')).toBe(false);
    expect(atLeast('3.15.1', '3.15.1')).toBe(true);
    expect(atLeast('3.15.0', '3.15.1')).toBe(false);
    expect(atLeast('4.0.0', '3.15.1')).toBe(true);
    expect(() => atLeast('latest', '3.15.1')).toThrow(/unparseable/);
  });

  it('finds nested copies, not just the top-level one', () => {
    // npm hoists, but a conflicting range nests a second copy — and a check that only reads the
    // hoisted entry reports clean while the nested one is still vulnerable.
    expect(lockedVersions('gray-matter').length).toBeGreaterThan(0);
    expect(lockedVersions('a-package-that-does-not-exist')).toEqual([]);
  });
});
