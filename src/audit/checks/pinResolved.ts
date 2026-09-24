import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { PACKAGE, parseGitPin, parseVersionTag, scanDeclarations } from './pinSpec.js';

const SHA = /^[0-9a-f]{40}$/;

/** `resolved` carries the commit as its `#fragment` for every git spelling npm writes. */
export function lockedSha(resolved: string): string | undefined {
  const sha = /#(?<sha>[0-9a-fA-F]{40})$/.exec(resolved)?.groups?.sha;
  return sha?.toLowerCase();
}

/** `^{}` wins: an annotated tag's plain row is the tag OBJECT, which no lock resolves to. Exact names
 *  only — ls-remote patterns match on the ref's tail. */
export function taggedCommit(stdout: string, tag: string): string | undefined {
  let direct: string | undefined;
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split('\t');
    if (sha === undefined || !SHA.test(sha.toLowerCase())) continue;
    if (ref === `refs/tags/${tag}^{}`) return sha.toLowerCase();
    if (ref === `refs/tags/${tag}`) direct = sha.toLowerCase();
  }
  return direct;
}

/** The LOCK's resolved commit vs the tag's, not the installed tree's. Advisory: see types.ts. */
export const pinResolved: AuditCheck = {
  id: 'pin-resolved',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const pkg = ctx.read('package.json');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${pkg.message}`);
    if (pkg.kind === 'missing') return makeResult(this, 'pass', `no package.json, so there is no ${PACKAGE} pin to resolve`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(pkg.contents);
    } catch {
      return makeResult(this, 'blocked', 'package.json is not valid JSON');
    }
    if (!isRecord(parsed)) return makeResult(this, 'blocked', 'package.json is not a JSON object');

    const scan = scanDeclarations(parsed);
    if (scan.kind === 'none') return makeResult(this, 'pass', `no dependency on ${PACKAGE}, so there is no pin to resolve`);
    if (scan.kind === 'invalid') return makeResult(this, 'blocked', scan.detail);

    const pin = parseGitPin(scan.spec);
    if (pin === undefined) {
      return makeResult(this, 'blocked', `the ${PACKAGE} spec ${JSON.stringify(scan.spec)} is not a recognizable git pin, so its commit cannot be determined`);
    }
    // Validated as vX.Y.Z before it reaches git's argv below, so the ref can carry no pattern syntax.
    if (pin.ref === undefined || parseVersionTag(pin.ref) === undefined) {
      return makeResult(this, 'blocked', `${PACKAGE} is not pinned to a version tag, so there is no tagged commit to compare (see pin-parity)`);
    }
    const tag = pin.ref;

    // npm installs from the shrinkwrap and ignores package-lock.json when both exist.
    const shrinkwrap = ctx.read('npm-shrinkwrap.json');
    const lockName = shrinkwrap.kind === 'missing' ? 'package-lock.json' : 'npm-shrinkwrap.json';
    const lock = shrinkwrap.kind === 'missing' ? ctx.read(lockName) : shrinkwrap;
    if (lock.kind === 'error') return makeResult(this, 'blocked', `${lockName} could not be read: ${lock.message}`);
    if (lock.kind === 'missing') {
      return makeResult(this, 'blocked', `no package-lock.json or npm-shrinkwrap.json, so the commit ${PACKAGE} resolves to cannot be determined`);
    }
    let lockParsed: unknown;
    try {
      lockParsed = JSON.parse(lock.contents);
    } catch {
      return makeResult(this, 'blocked', `${lockName} is not valid JSON`);
    }
    if (!isRecord(lockParsed)) return makeResult(this, 'blocked', `${lockName} is not a JSON object`);
    const packages = lockParsed.packages;
    if (!isRecord(packages)) {
      return makeResult(this, 'blocked', `${lockName} has no \`packages\` map (lockfileVersion 1?), so the resolved commit cannot be read — regenerate it with npm 7+`);
    }
    const entry = packages[`node_modules/${PACKAGE}`];
    if (entry === undefined) {
      if (!scan.installRequired) {
        return makeResult(this, 'pass', `${PACKAGE} is declared only as an optional/peer dependency and the lock does not install it, so there is no commit to compare`);
      }
      return makeResult(this, 'blocked', `${lockName} has no entry for ${PACKAGE}, so the resolved commit cannot be determined — run npm install`);
    }
    const resolved = isRecord(entry) && typeof entry.resolved === 'string' ? entry.resolved : undefined;
    const locked = resolved === undefined ? undefined : lockedSha(resolved);
    if (locked === undefined) {
      return makeResult(this, 'blocked', `${lockName}'s ${PACKAGE} entry carries no resolved commit sha, so it cannot be compared with ${tag}`);
    }

    const remote = `https://github.com/${pin.owner}/${pin.repo}.git`;
    const res = ctx.exec('git', ['ls-remote', '--exit-code', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: ctx.repoDir });
    if (res.kind === 'absent') return makeResult(this, 'blocked', `git is not on PATH, so the commit ${tag} names cannot be determined`);
    if (res.kind === 'error') return makeResult(this, 'blocked', `git failed: ${res.message}`);
    // --exit-code's 2 is git's definite "no such ref"; 128 and friends are "could not ask".
    if (!res.ok && res.status === 2) return makeResult(this, 'fail', `pinned ${tag} is not a tag on ${pin.owner}/${pin.repo}`);
    if (!res.ok) {
      const why = res.stderr.trim().split('\n')[0] || `git exited ${res.status == null ? 'with no exit code' : String(res.status)}`;
      return makeResult(this, 'blocked', `the commit ${tag} names on ${pin.owner}/${pin.repo} could not be determined: ${why}`);
    }
    const tagged = taggedCommit(res.stdout, tag);
    if (tagged === undefined) {
      return makeResult(this, 'blocked', `${pin.owner}/${pin.repo} answered with no row for ${tag}, so its commit cannot be determined`);
    }
    if (tagged !== locked) {
      return makeResult(
        this,
        'fail',
        `pinned ${tag} names ${tagged.slice(0, 7)} but ${lockName} resolves ${PACKAGE} to ${locked.slice(0, 7)} — a bare npm install keeps the old sha; reinstall the package explicitly, in the same dependency field, so the lock moves to the tag`,
      );
    }
    return makeResult(this, 'pass', `${lockName} resolves ${PACKAGE} to ${locked.slice(0, 7)}, the commit ${tag} names`);
  },
};
