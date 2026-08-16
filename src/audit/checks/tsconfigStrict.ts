import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

/** Errors under strict (TS7006 implicitAny), compiles clean without it. */
const STRICT_FIXTURE = 'export function auditProbe(x) { return x; }\n';

/** Options that would make the throwaway project unresolvable or write files; everything else is
 *  carried verbatim so the fixture compiles under the repo's real settings. */
const STRIPPED_OPTIONS = new Set([
  'types', 'typeRoots', 'paths', 'baseUrl', 'rootDir', 'outDir', 'declaration', 'declarationDir',
  // declarationMap/emitDeclarationOnly require `declaration`, which is stripped — leaving either
  // behind makes the scratch project self-contradictory (TS5069) and BLOCKS every published-package
  // repo before strictness is ever tested.
  'declarationMap', 'emitDeclarationOnly',
  'composite', 'incremental', 'tsBuildInfoFile', 'plugins',
]);

/**
 * Makes the COMPILER answer. TS 6 defaults `strict` to true, so an absent key is not `false`, and
 * `--showConfig` omits defaulted values — no reading of tsconfig text can say what the compiler will
 * do. So: resolve the repo's options with its own tsc, re-apply them to a fixture that only errors
 * under strict, and read which way the compile goes. The repo's own tsc missing → BLOCKED.
 */
export const tsconfigStrict: AuditCheck = {
  id: 'tsconfig-strict',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    const tsconfig = ctx.read('tsconfig.json');
    if (tsconfig.kind === 'missing') return makeResult(this, 'fail', 'tsconfig.json is absent');
    if (tsconfig.kind === 'error') return makeResult(this, 'blocked', `tsconfig.json could not be read: ${tsconfig.message}`);

    const tscBin = path.join(ctx.repoDir, 'node_modules', '.bin', 'tsc');
    const shown = ctx.exec(tscBin, ['--showConfig', '-p', ctx.repoDir]);
    if (shown.kind === 'absent') {
      return makeResult(this, 'blocked', 'node_modules/.bin/tsc does not exist — run npm ci, then re-audit');
    }
    if (shown.kind === 'error') return makeResult(this, 'blocked', `tsc could not run: ${shown.message}`);
    if (!shown.ok) {
      // tsc writes diagnostics (TS18003 "no inputs", etc.) to STDOUT — read it first; an unrelated
      // stderr warning must not displace the actual diagnostic.
      const firstLine = (shown.stdout.trim() || shown.stderr.trim()).split('\n')[0] ?? '';
      return makeResult(this, 'blocked', `tsc --showConfig failed: ${firstLine}`);
    }
    let resolved: unknown;
    try {
      resolved = JSON.parse(shown.stdout);
    } catch {
      return makeResult(this, 'blocked', 'tsc --showConfig returned unparseable output');
    }
    const options =
      typeof resolved === 'object' && resolved !== null && 'compilerOptions' in resolved &&
      typeof resolved.compilerOptions === 'object' && resolved.compilerOptions !== null
        ? Object.fromEntries(Object.entries(resolved.compilerOptions).filter(([k]) => !STRIPPED_OPTIONS.has(k)))
        : {};

    const scratch = mkdtempSync(path.join(tmpdir(), 'tw-strict-'));
    try {
      writeFileSync(
        path.join(scratch, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { ...options, noEmit: true }, include: ['fixture.ts'] }),
      );
      writeFileSync(path.join(scratch, 'fixture.ts'), STRICT_FIXTURE);
      const compile = ctx.exec(tscBin, ['-p', scratch]);
      if (compile.kind !== 'ran') return makeResult(this, 'blocked', 'tsc vanished between showConfig and the fixture compile');
      if (!compile.ok && compile.stdout.includes('TS7006')) {
        return makeResult(this, 'pass', 'the fixture that only errors under strict errored — the compiler is strict here');
      }
      if (compile.ok) {
        return makeResult(this, 'fail', 'an implicit-any fixture compiled clean — this tsconfig is not strict');
      }
      // It failed for some OTHER reason (an option the scratch project cannot honor): the strictness
      // question was not answered, and "could not check" is not a pass.
      return makeResult(this, 'blocked', `the fixture compile failed for reasons other than strictness: ${compile.stdout.trim().split('\n')[0] ?? ''}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};
