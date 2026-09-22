// tkt-877dd0a70e1e. Runs BEFORE `npm ci`, so it may import nothing from node_modules or dist/.
//
// `.npmrc` sets engine-strict, which turns the engines.npm floor into a refusal rather than a
// warning. That makes whichever npm setup-node supplied a gate-critical input — and it is the runner
// image's cached Node that decides which one, not anything this repo pins. This step names that
// failure before `npm ci` hits it, so the job dies with a sentence instead of an opaque EBADENGINE.
//
// Deliberately an assertion, NOT a pin: CI on a stock Node 24 is the only thing proving the floor is
// satisfiable by consumers, who inherit this .npmrc (tkt-61ec9c048684). Force-installing an npm here
// would make the engine check pass by construction and hide their breakage behind a green gate.
//
// The measured floor-vs-bundled-npm pair is NOT restated here; src/npmFloor.test.ts owns it.
//
// floorOf/versionCore duplicate src/audit/checks/npmVersion.ts, which cannot be imported at this
// point in the job (it is TypeScript, and dist/ is not built until `npm ci` runs `prepare`).
// ci.npm.test.mjs holds every duplicated function to its canonical counterpart over a corpus.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from '../hooks/lib/is-main.mjs';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** '11.19.1' → [11,19,1]; absent components are 0. NOT range-aware — that is floorOf's job. */
export function versionCore(spec) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec);
  if (m?.[1] === undefined) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * The lower bound of an `engines.npm` range, or a refusal to guess one. Taking "the first number in
 * the string" inverts the verdict on '<11' and on '1.x || >=10', so a spelling whose lower bound
 * cannot be named returns `indeterminate` — which this script treats as a failure, never a pass.
 *
 * Kept equivalent to npmVersion.ts's floorOf; isFloorOnly below carries the extra strictness this
 * script needs, so that equivalence stays testable.
 */
export function floorOf(spec) {
  const s = spec.trim();
  if (s === '') return { kind: 'indeterminate', why: 'it is empty' };
  if (/^[*xX]$/.test(s)) return { kind: 'none' };
  if (s.includes('||')) return { kind: 'indeterminate', why: 'a `||` union has no single lower bound this check can read' };
  const lead = /[<>=^~]+|\d/.exec(s);
  if (lead === null) return { kind: 'indeterminate', why: 'it declares no version' };
  if (lead[0].startsWith('<')) return { kind: 'indeterminate', why: 'it declares an upper bound, not a floor' };
  const version = versionCore(s);
  if (version === undefined) return { kind: 'indeterminate', why: 'it declares no parseable version' };
  return { kind: 'floor', version };
}

/**
 * Whether a spec means ONLY "at least this", which is the single shape a floor comparison is sound
 * for. npm's engine-strict does full semver RANGE satisfaction, so '^11.19.0', '~11.19.0',
 * '>=11.19.0 <12' and the exact pin '11.19.0' all REFUSE an npm that clears their lower bound —
 * reading a floor out of them reports green and lets `npm ci` die with the very EBADENGINE this step
 * exists to pre-empt. Measured against the real script with an npm 12.3.0 shim: all four passed.
 */
export function isFloorOnly(spec) {
  return /^>=\s*\d+(?:\.\d+){0,2}\s*$/.test(spec.trim());
}

/** A prerelease sorts BELOW its own release, which a numeric core cannot express. */
export function isPrerelease(version) {
  return /^\s*\d+(?:\.\d+){0,2}-/.test(version);
}

export function compareCore(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * package.json's engines.npm, or a refusal. Every malformed shape is a refusal rather than "no
 * floor": an `engines` reshaped to a bare string leaves engine-strict enforcing nothing, and
 * answering "there is no floor to be below" there would be affirmatively false.
 */
export function readFloorSpec(pkgText) {
  let parsed;
  try {
    parsed = JSON.parse(pkgText);
  } catch {
    return { ok: false, message: 'package.json is not valid JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, message: 'package.json is not a JSON object' };
  const engines = parsed.engines;
  if (engines === undefined) return { ok: true, floorSpec: undefined };
  if (!isRecord(engines)) {
    return { ok: false, message: `package.json "engines" is not an object, so an npm floor cannot be read: ${JSON.stringify(engines)}` };
  }
  if (!('npm' in engines)) return { ok: true, floorSpec: undefined };
  if (typeof engines.npm !== 'string') {
    return { ok: false, message: `package.json "engines.npm" is not a string: ${JSON.stringify(engines.npm)}` };
  }
  return { ok: true, floorSpec: engines.npm };
}

/**
 * The verdict, as data, so the tests can drive every branch without a runner image. `ok: false` is
 * returned for every undetermined case too — a floor this cannot read is not a floor that is
 * satisfied.
 */
export function verdict(floorSpec, installedRaw) {
  if (floorSpec === undefined) {
    return { ok: true, message: 'package.json declares no engines.npm floor, so CI npm has none to be below' };
  }
  const floor = floorOf(floorSpec);
  if (floor.kind === 'indeterminate') {
    return { ok: false, message: `engines.npm ${JSON.stringify(floorSpec)} gives no floor to compare against: ${floor.why}` };
  }
  if (floor.kind === 'none') {
    return { ok: true, message: `engines.npm ${JSON.stringify(floorSpec)} is satisfied by every npm` };
  }
  if (!isFloorOnly(floorSpec)) {
    return {
      ok: false,
      message:
        `engines.npm ${JSON.stringify(floorSpec)} is not a bare lower bound, and npm enforces the whole ` +
        `range — this check compares only a floor, so it cannot answer soundly. Spell the floor as ` +
        `">=x.y.z" (src/npmFloor.test.ts asserts that spelling) or extend this check.`,
    };
  }
  const installed = versionCore(installedRaw);
  if (installed === undefined) {
    return { ok: false, message: `npm --version printed no parseable version: ${JSON.stringify(installedRaw)}` };
  }
  const ordering = compareCore(installed, floor.version);
  if (ordering < 0 || (ordering === 0 && isPrerelease(installedRaw))) {
    return {
      ok: false,
      message:
        `CI npm ${installedRaw} is BELOW the engines.npm floor ${floorSpec}, so \`npm ci\` would refuse ` +
        `(engine-strict). This is not a CI-only problem: consumers inherit .npmrc, so the floor is ` +
        `unsatisfiable on a stock Node here too. Lower the floor to what this Node bundles, or raise ` +
        `the workflow's node-version — do not force-install an npm, which hides it (tkt-877dd0a70e1e).`,
    };
  }
  const exact = ordering === 0 ? ' — exactly at the floor, no headroom' : '';
  return { ok: true, message: `CI npm ${installedRaw} satisfies the engines.npm floor ${floorSpec}${exact}` };
}

function fail(message) {
  console.error(`check-ci-npm: ${message}`);
  process.exit(1);
}

function main() {
  let pkgText;
  try {
    pkgText = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  } catch (err) {
    fail(`package.json could not be read: ${err.message}`);
  }

  const floor = readFloorSpec(pkgText);
  if (!floor.ok) fail(floor.message);

  let installedRaw;
  try {
    installedRaw = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    fail(`npm --version failed: ${err.message}`);
  }

  const { ok, message } = verdict(floor.floorSpec, installedRaw);
  console[ok ? 'log' : 'error'](`check-ci-npm: ${message}`);
  process.exit(ok ? 0 : 1);
}

if (isMain(import.meta.url)) main();
