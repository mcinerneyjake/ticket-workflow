import { isRecord, makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { PACKAGE, parseGitPin, parseVersionTag, scanDeclarations } from './pinSpec.js';

/**
 * The pin is a version tag, and the installed copy is that version. Both halves are DETERMINISTIC
 * and OFFLINE on purpose: this check gates (a consumer runs `audit .` as a required check), so it
 * must never depend on another repo's network or timeline. Remote freshness is `pin-freshness`,
 * which is advisory for that reason.
 *
 * It catches the state a bare `npm install` leaves — the previously resolved sha is kept, so a
 * bumped pin sits above an older tree and the versions disagree. It does NOT catch drift where the
 * pinned tag and the installed tree carry the SAME version string but different shas (a tag that
 * trails `main`); that needs the tag's commit from the remote, so it is `pin-resolved`, advisory.
 *
 * Every undeterminable answer is BLOCKED, never PASS. Not applicable — no dependency map names the
 * package — is a genuine PASS, and is the state this package itself is in via its own `bin` entry.
 */
export const pinParity: AuditCheck = {
  id: 'pin-parity',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const pkg = ctx.read('package.json');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${pkg.message}`);
    // No package.json at all: a core-tier repo has no npm pin to be stale.
    if (pkg.kind === 'missing') return makeResult(this, 'pass', `no package.json, so there is no ${PACKAGE} pin to check`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(pkg.contents);
    } catch {
      return makeResult(this, 'blocked', 'package.json is not valid JSON');
    }
    if (!isRecord(parsed)) return makeResult(this, 'blocked', 'package.json is not a JSON object');

    const scan = scanDeclarations(parsed);
    if (scan.kind === 'none') return makeResult(this, 'pass', `no dependency on ${PACKAGE}, so there is no pin to check`);
    if (scan.kind === 'invalid') return makeResult(this, 'blocked', scan.detail);

    const pin = parseGitPin(scan.spec);
    if (pin === undefined) {
      return makeResult(this, 'blocked', `the ${PACKAGE} spec ${JSON.stringify(scan.spec)} is not a recognizable git pin, so the pinned tag cannot be determined`);
    }
    if (pin.ref === undefined) {
      return makeResult(this, 'fail', `${PACKAGE} is pinned to ${JSON.stringify(scan.spec)} with no #fragment — the standard requires a tag, never a branch`);
    }
    const pinned = parseVersionTag(pin.ref);
    if (pinned === undefined) {
      return makeResult(this, 'fail', `${PACKAGE} is pinned to ${JSON.stringify(pin.ref)}, which is not a version tag (vX.Y.Z) — a fix reaches consumers only through a tag cut`);
    }
    const pinnedVersion = `${pinned[0]}.${pinned[1]}.${pinned[2]}`;

    const installed = ctx.read(`node_modules/${PACKAGE}/package.json`);
    if (installed.kind === 'missing') {
      // Declared only as optional/peer: absence is legal, so there is no parity to assert. The
      // init narrowing ANCHORS on the wording below, so keep the required-field sentence first.
      if (!scan.installRequired) {
        return makeResult(this, 'pass', `${PACKAGE} is declared only as an optional/peer dependency and is not installed, so there is no parity to check`);
      }
      return makeResult(this, 'blocked', `${PACKAGE} is pinned to ${pin.ref} but is not installed, so the installed version cannot be compared`);
    }
    if (installed.kind === 'error') return makeResult(this, 'blocked', `the installed ${PACKAGE} manifest could not be read: ${installed.message}`);
    let installedParsed: unknown;
    try {
      installedParsed = JSON.parse(installed.contents);
    } catch {
      return makeResult(this, 'blocked', `the installed ${PACKAGE} manifest is not valid JSON`);
    }
    const installedVersion = isRecord(installedParsed) && typeof installedParsed.version === 'string' ? installedParsed.version : undefined;
    if (installedVersion === undefined) {
      return makeResult(this, 'blocked', `the installed ${PACKAGE} manifest declares no version, so the pin cannot be compared`);
    }
    if (installedVersion !== pinnedVersion) {
      return makeResult(this, 'fail', `pinned ${pin.ref} but ${installedVersion} is installed — a bare npm install keeps the previously resolved sha; reinstall so the tree matches the pin`);
    }
    return makeResult(this, 'pass', `${PACKAGE} is pinned to ${pin.ref} and that version is installed`);
  },
};
