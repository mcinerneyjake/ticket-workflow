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
 * because `^3.13.1` admits 3.15.2. The bump is therefore by hand, and this is what keeps it.
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

/**
 * Semver precedence (semver.org §10–11), not lexical: '3.9.0' > '3.15.1' as strings. Fields compare
 * independently rather than weighted into one number, and a prerelease ranks below its own release.
 * Both were fail-open in a floor whose whole job is to stop a vulnerable version landing: packed at
 * 1e6/1e3/1 a minor or patch reaching 1000 carried into the field above, and an unanchored parse read
 * '3.15.2-beta.1' as its own release (tkt-9a6d76e61642). Throws on both arguments rather than
 * guessing, but the shape it accepts is laxer than the semver grammar — it still admits empty
 * prerelease identifiers and leading zeros, which is a fail-open no npm-written lockfile reaches
 * (measured 0/3513 real version strings). Tightening it is its own ticket.
 */
export function atLeast(version, floor) {
  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
    if (!m) throw new Error(`unparseable version ${JSON.stringify(s)}`);
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
  };
  const comparePre = (a, b) => {
    // Absent outranks present: 1.0.0 is above every 1.0.0-x.
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
    const as = a.split('.');
    const bs = b.split('.');
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
      // A prefix ranks below the longer set it prefixes: 1.0.0-alpha < 1.0.0-alpha.1.
      if (as[i] === undefined || bs[i] === undefined) return as[i] === undefined ? -1 : 1;
      const an = /^\d+$/.test(as[i]);
      const bn = /^\d+$/.test(bs[i]);
      // Numeric identifiers compare numerically, and always rank below alphanumeric ones.
      if (an !== bn) return an ? -1 : 1;
      if (an && Number(as[i]) !== Number(bs[i])) return Number(as[i]) < Number(bs[i]) ? -1 : 1;
      if (!an && as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
    }
    return 0;
  };
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  return comparePre(a.pre, b.pre) >= 0;
}

// GHSA-2883-xcg3-v3hh — maxTotalMergeKeys does not bound CPU for empty merge sources; supersedes
// GHSA-5p4m-2wfm-xmqj, whose 3.15.1 floor it raises. Transitive via gray-matter, the frontmatter
// parser the whole ticket engine reads through, so it is on the hot path (tkt-d3ca2a78c557).
// hono is unreachable today — the MCP server instantiates only StdioServerTransport — but it is a
// runtime dep every consumer inherits by tag, so the floor stands rather than being re-argued the
// day a transport changes. 4.13.5 also answers GHSA-g6gw-c38x-mqfc and GHSA-crvj-82cr-hjcx.
const ADVISORIES = [
  { name: 'js-yaml', floor: '3.15.2', ghsa: 'GHSA-2883-xcg3-v3hh' },
  { name: 'hono', floor: '4.13.5', ghsa: 'GHSA-gqvv-2mrq-wpjv' },
];

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

  it('ranks a prerelease below its own release, and does not let a field overflow the next', () => {
    // Both directions of the prerelease rule (semver §11). Only the first was fail-open, but a fix
    // that blanket-rejected prereleases would redden the gate on a version that is genuinely patched,
    // so the second is asserted to pin that the floor is compared, not the shape (tkt-9a6d76e61642).
    expect(atLeast('3.15.2-beta.1', '3.15.2')).toBe(false);
    expect(atLeast('3.15.3-rc.1', '3.15.2')).toBe(true);
    expect(atLeast('3.15.2', '3.15.2-beta.1')).toBe(true);
    expect(atLeast('3.15.2-beta.2', '3.15.2-beta.11')).toBe(false);

    // Fields are compared independently. Weighted into one number at 1e6/1e3/1, a minor or patch
    // reaching 1000 carries into the field above and reports a vulnerable version as patched.
    expect(atLeast('1.1000.0', '2.0.0')).toBe(false);
    expect(atLeast('1.0.1000', '1.1.0')).toBe(false);

    // Build metadata is not part of precedence (semver §10); a trailing fourth field is not a
    // version at all, and the unanchored parse used to truncate it silently.
    expect(atLeast('3.15.2+build.7', '3.15.2')).toBe(true);
    expect(() => atLeast('3.15.2.4', '3.15.2')).toThrow(/unparseable/);

    // The floor is parsed too. Pinned because a short-circuit added later — an early return once the
    // numeric fields decide, say — would leave a typo'd floor in ADVISORIES silently uncompared.
    expect(() => atLeast('3.15.2', 'latest')).toThrow(/unparseable/);
  });

  it('applies every prerelease precedence rule, not just the numeric one', () => {
    // One assertion per §11 rule. Without these, three of the four survive inversion with the suite
    // green — the same fail-open class this ticket closes, one level up: a later refactor flips a
    // comparison and a prerelease-floored package reports as patched (found reviewing this diff).
    expect(atLeast('1.0.0-1', '1.0.0-a')).toBe(false); // numeric ranks below alphanumeric
    expect(atLeast('1.0.0-a', '1.0.0-1')).toBe(true);
    expect(atLeast('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false); // a prefix ranks below the longer set
    expect(atLeast('1.0.0-beta', '1.0.0-alpha')).toBe(true); // alphanumeric compares ASCII-lexically
  });

  it('finds nested copies, not just the top-level one', () => {
    // npm hoists, but a conflicting range nests a second copy — and a check that only reads the
    // hoisted entry reports clean while the nested one is still vulnerable.
    expect(lockedVersions('gray-matter').length).toBeGreaterThan(0);
    expect(lockedVersions('a-package-that-does-not-exist')).toEqual([]);
  });
});
