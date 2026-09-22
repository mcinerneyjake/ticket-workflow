import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { compareSemver, type Semver } from './pinSpec.js';

/**
 * The numeric core of a plain version: '11.19.1' → [11,19,1], '10.x' → [10,0,0]. Absent components
 * are 0, so a partial spelling compares against a full version. NOT range-aware — ranges go through
 * floorOf, which decides whether a floor can be read out of them at all.
 */
export function versionCore(spec: string): Semver | undefined {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec);
  if (m?.[1] === undefined) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** A prerelease sorts BELOW its own release ('11.0.0-pre.0' < '11.0.0'), which a numeric core cannot
 *  express — so it is carried separately rather than folded into the comparison. */
export function isPrerelease(version: string): boolean {
  return /^\s*\d+(?:\.\d+){0,2}-/.test(version);
}

export type Floor =
  /** '*' — every npm satisfies it, so there is no floor to be below. */
  | { readonly kind: 'none' }
  | { readonly kind: 'floor'; readonly version: Semver }
  | { readonly kind: 'indeterminate'; readonly why: string };

/**
 * The lower bound of an `engines.npm` range, or a refusal to guess one.
 *
 * Taking "the first number in the string" is WRONG and inverts the verdict: '<11' would yield a
 * floor of 11, failing an npm 10.9.3 that actually satisfies the range and telling the user to
 * install the one version it forbids; '1.x || >=10' would yield 1 and pass an npm 9. Both measured.
 * A spelling whose lower bound this cannot name returns `indeterminate` → BLOCKED, never a guess.
 */
export function floorOf(spec: string): Floor {
  const s = spec.trim();
  if (s === '') return { kind: 'indeterminate', why: 'it is empty' };
  if (/^[*xX]$/.test(s)) return { kind: 'none' };
  // A union's floor is the minimum over branches this parser does not evaluate; refuse it outright.
  if (s.includes('||')) return { kind: 'indeterminate', why: 'a `||` union has no single lower bound this check can read' };
  const lead = /[<>=^~]+|\d/.exec(s);
  if (lead === null) return { kind: 'indeterminate', why: 'it declares no version' };
  if (lead[0].startsWith('<')) return { kind: 'indeterminate', why: 'it declares an upper bound, not a floor' };
  const version = versionCore(s);
  if (version === undefined) return { kind: 'indeterminate', why: 'it declares no parseable version' };
  return { kind: 'floor', version };
}

/**
 * Installed npm vs the repo's declared `engines.npm` floor.
 *
 * ADVISORY because the installed npm is a fact about the *machine*, not about the audited repo —
 * the same reason hook-arming is advisory (types.ts). CI's npm is not the developer's npm, so
 * gating would assert a machine property against a repository, and would redden every consumer's
 * required gate on a diff that changed nothing.
 *
 * No `engines.npm` → PASS, not FAIL: there is no floor, so nothing can be below it. That is a
 * measured absence, not an undetermined answer, which is why it does not violate the "can't check
 * is never the permissive answer" rule — every genuinely undetermined case below returns BLOCKED.
 * Whether a repo *ought* to declare a floor is a separate question (tkt-61ec9c048684); answering it
 * here would mark the whole fleet non-conformant for a standard it has not adopted yet.
 */
export const npmVersion: AuditCheck = {
  id: 'npm-version',
  tier: 'node',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const pkg = ctx.read('package.json');
    if (pkg.kind === 'missing') return makeResult(this, 'blocked', 'package.json is absent, so there is no engines.npm floor to read');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${pkg.message}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(pkg.contents);
    } catch {
      return makeResult(this, 'blocked', 'package.json is not valid JSON');
    }
    if (!isRecord(parsed)) return makeResult(this, 'blocked', 'package.json is not a JSON object');

    let floorSpec: string | undefined;
    const engines = parsed.engines;
    if (engines !== undefined) {
      if (!isRecord(engines)) return makeResult(this, 'blocked', 'package.json "engines" is not an object, so an npm floor cannot be read');
      if ('npm' in engines) {
        if (typeof engines.npm !== 'string') return makeResult(this, 'blocked', `package.json "engines.npm" is not a string: ${JSON.stringify(engines.npm)}`);
        floorSpec = engines.npm;
      }
    }
    if (floorSpec === undefined) return makeResult(this, 'pass', 'package.json declares no engines.npm floor, so there is none for the installed npm to be below');

    const floor = floorOf(floorSpec);
    if (floor.kind === 'indeterminate') {
      return makeResult(this, 'blocked', `engines.npm ${JSON.stringify(floorSpec)} gives no floor to compare against: ${floor.why}`);
    }
    if (floor.kind === 'none') {
      return makeResult(this, 'pass', `package.json declares engines.npm ${JSON.stringify(floorSpec)}, which every npm satisfies`);
    }

    const npm = ctx.exec('npm', ['--version'], { cwd: ctx.repoDir });
    if (npm.kind === 'absent') return makeResult(this, 'blocked', 'npm is not on PATH, so the installed version cannot be determined');
    if (npm.kind === 'error') return makeResult(this, 'blocked', `npm --version failed: ${npm.message}`);
    if (!npm.ok) return makeResult(this, 'blocked', `npm --version exited non-zero: ${npm.stderr.trim().split('\n')[0] ?? ''}`);

    const installedRaw = npm.stdout.trim();
    const installed = versionCore(installedRaw);
    if (installed === undefined) return makeResult(this, 'blocked', `npm --version printed no parseable version: ${JSON.stringify(installedRaw)}`);

    // A prerelease of the floor itself is BELOW it, so an equal numeric core still fails.
    const ordering = compareSemver(installed, floor.version);
    if (ordering < 0 || (ordering === 0 && isPrerelease(installedRaw))) {
      return makeResult(this, 'fail', `installed npm ${installedRaw} is below the engines.npm floor ${floorSpec} — run \`npm i -g npm@${floor.version[0]}\``);
    }
    return makeResult(this, 'pass', `installed npm ${installedRaw} satisfies the engines.npm floor ${floorSpec}`);
  },
};
