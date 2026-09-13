import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { PACKAGE, compareSemver, parseGitPin, parseVersionTag, scanDeclarations, type Semver } from './pinSpec.js';

interface RemoteTag {
  readonly tag: string;
  readonly version: Semver;
}

/**
 * Sorted HERE rather than trusted from `--sort=v:refname`: a git that ignores the flag returns
 * lexical order, where v0.9.1 outranks v0.24.0, and the newest tag would read as a downgrade.
 * Peeled `^{}` rows duplicate every annotated tag, so they are dropped.
 */
export function remoteVersionTags(stdout: string): RemoteTag[] {
  const tags: RemoteTag[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /refs\/tags\/(?<tag>\S+?)(?:\^\{\})?$/.exec(line.trim());
    const tag = m?.groups?.tag;
    if (tag === undefined || seen.has(tag)) continue;
    const version = parseVersionTag(tag);
    if (version === undefined) continue;
    seen.add(tag);
    tags.push({ tag, version });
  }
  return tags.sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * ADVISORY, and that is the whole design of it: "a newer version exists upstream" is an upgrade
 * backlog, not a conformance defect of the repo being audited. Consumers run `audit .` as a
 * REQUIRED check, so gating on this would fail every open PR in an untouched repo the moment a tag
 * is cut here, and would make a green gate depend on network reachability. Reported, never gating.
 *
 * Statuses still carry the real answer: FAIL when the pin is behind, BLOCKED when the remote cannot
 * be reached. Never PASS for an answer it could not determine.
 */
export const pinFreshness: AuditCheck = {
  id: 'pin-freshness',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const pkg = ctx.read('package.json');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${pkg.message}`);
    if (pkg.kind === 'missing') return makeResult(this, 'pass', `no package.json, so there is no ${PACKAGE} pin to age`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(pkg.contents);
    } catch {
      return makeResult(this, 'blocked', 'package.json is not valid JSON');
    }
    if (!isRecord(parsed)) return makeResult(this, 'blocked', 'package.json is not a JSON object');

    const scan = scanDeclarations(parsed);
    if (scan.kind === 'none') return makeResult(this, 'pass', `no dependency on ${PACKAGE}, so there is no pin to age`);
    if (scan.kind === 'invalid') return makeResult(this, 'blocked', scan.detail);

    const pin = parseGitPin(scan.spec);
    if (pin === undefined) {
      return makeResult(this, 'blocked', `the ${PACKAGE} spec ${JSON.stringify(scan.spec)} is not a recognizable git pin, so it cannot be compared with the remote`);
    }
    // Which ref is pinned is pin-parity's FAIL to report; here it only means "no version to age".
    if (pin.ref === undefined || parseVersionTag(pin.ref) === undefined) {
      return makeResult(this, 'blocked', `${PACKAGE} is not pinned to a version tag, so there is no version to compare with the remote (see pin-parity)`);
    }

    const remote = `https://github.com/${pin.owner}/${pin.repo}.git`;
    const tagsRes = ctx.exec('git', ['ls-remote', '--tags', '--sort=v:refname', '--exit-code', remote], { cwd: ctx.repoDir });
    if (tagsRes.kind === 'absent') return makeResult(this, 'blocked', 'git is not on PATH, so the newest tag cannot be determined');
    if (tagsRes.kind === 'error') return makeResult(this, 'blocked', `git failed: ${tagsRes.message}`);
    if (!tagsRes.ok) {
      // `||`, not `??`: split always yields at least '', so `??` never fires — and --exit-code
      // firing on a tagless remote is exactly the case that answers with an EMPTY stderr.
      const why = tagsRes.stderr.trim().split('\n')[0] || `git exited ${String(tagsRes.status)}`;
      return makeResult(this, 'blocked', `the tags of ${pin.owner}/${pin.repo} could not be listed, so "newest" is undetermined: ${why}`);
    }
    const tags = remoteVersionTags(tagsRes.stdout);
    const newest = tags[tags.length - 1];
    if (newest === undefined) {
      return makeResult(this, 'blocked', `${pin.owner}/${pin.repo} reports no version tags, so "newest" cannot be determined`);
    }
    if (!tags.some((t) => t.tag === pin.ref)) {
      return makeResult(this, 'fail', `pinned ${pin.ref} is not a tag on ${pin.owner}/${pin.repo} (newest there is ${newest.tag})`);
    }
    if (newest.tag !== pin.ref) {
      return makeResult(this, 'fail', `pinned ${pin.ref} but ${newest.tag} is the newest tag on ${pin.owner}/${pin.repo} — bump the pin`);
    }
    return makeResult(this, 'pass', `pinned ${pin.ref} is the newest tag on ${pin.owner}/${pin.repo}`);
  },
};
