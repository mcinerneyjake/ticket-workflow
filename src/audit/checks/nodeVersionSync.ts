import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

/** The floor declared in engines (">=24" → "24"), or undefined when unparseable. */
function enginesFloor(pkgJson: string): string | undefined {
  const parsed: unknown = JSON.parse(pkgJson);
  if (typeof parsed !== 'object' || parsed === null || !('engines' in parsed)) return undefined;
  const engines = parsed.engines;
  if (typeof engines !== 'object' || engines === null || !('node' in engines) || typeof engines.node !== 'string') return undefined;
  return /(\d+)/.exec(engines.node)?.[1];
}

/**
 * .nvmrc == engines floor == CI's node-version. A floor CI never runs is how type/runtime drift goes
 * unnoticed, and each pair of these has drifted somewhere before.
 */
export const nodeVersionSync: AuditCheck = {
  id: 'node-version-sync',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    const nvmrc = ctx.read('.nvmrc');
    if (nvmrc.kind === 'missing') return makeResult(this, 'fail', '.nvmrc is absent');
    if (nvmrc.kind === 'error') return makeResult(this, 'blocked', `.nvmrc could not be read: ${nvmrc.message}`);
    // Normalize like the other two sides: 'v24' and '24.1.0' are conventional .nvmrc spellings of
    // the same major, and comparing the raw string against an extracted major fails them all.
    const nvmrcVersion = /(\d+)/.exec(nvmrc.contents.trim())?.[1];
    if (nvmrcVersion === undefined) return makeResult(this, 'fail', `.nvmrc declares no parseable version: ${JSON.stringify(nvmrc.contents.trim())}`);

    const pkg = ctx.read('package.json');
    if (pkg.kind === 'missing') return makeResult(this, 'fail', 'package.json is absent, so there is no engines floor to sync with');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${pkg.message}`);
    let floor: string | undefined;
    try {
      floor = enginesFloor(pkg.contents);
    } catch {
      return makeResult(this, 'blocked', 'package.json is not valid JSON');
    }
    if (floor === undefined) return makeResult(this, 'fail', 'package.json declares no parseable engines.node floor');

    const ci = ctx.read('.github/workflows/ci.yml');
    if (ci.kind === 'error') return makeResult(this, 'blocked', `.github/workflows/ci.yml could not be read: ${ci.message}`);
    const gateWorkflow = ci.kind === 'ok' ? ci : ctx.read('.github/workflows/gate.yml');
    if (gateWorkflow.kind === 'error') return makeResult(this, 'blocked', 'the CI workflow could not be read');
    if (gateWorkflow.kind === 'missing') return makeResult(this, 'fail', 'no ci.yml/gate.yml to compare node-version against');
    // Both spellings the standard's workflows use: a literal `node-version: '24'` and a matrix
    // `node: [24]` consumed by `node-version: ${{ matrix.node }}`.
    const ciVersion =
      /node-version:\s*'?"?(\d+)/.exec(gateWorkflow.contents)?.[1] ?? /node:\s*\[\s*(\d+)\s*\]/.exec(gateWorkflow.contents)?.[1];
    if (ciVersion === undefined) return makeResult(this, 'blocked', 'the CI workflow declares no recognizable node-version');

    if (nvmrcVersion !== floor || floor !== ciVersion) {
      return makeResult(this, 'fail', `node versions disagree: .nvmrc=${nvmrcVersion}, engines floor=${floor}, CI=${ciVersion} — bump them together`);
    }
    return makeResult(this, 'pass', `.nvmrc, engines floor and CI agree on node ${floor}`);
  },
};
