import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vitest/node';
import { resolveVitestConfig } from './vitestConfig.js';
import { testRunHold } from './testRunHold.js';
import { vitestCollection } from './vitestCollection.js';
import { defaultExec, readRepoFile, type AuditContext } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ctxWith(files: Readonly<Record<string, string>>): AuditContext {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-vitest-config-'));
  tempDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec: defaultExec };
}

const CONFORMING = `export default { test: { exclude: ['.claude/worktrees/**'] } };\n`;
const BARE = `export default { test: { exclude: ['dist/**'] } };\n`;

function withTest(test: string, files: Readonly<Record<string, string>> = {}): AuditContext {
  return ctxWith({ 'package.json': JSON.stringify({ scripts: { test } }), ...files });
}

function resolvedFile(ctx: AuditContext): string {
  const r = resolveVitestConfig(ctx);
  return r.kind === 'found' ? r.file : `<${r.kind}>`;
}

describe('resolveVitestConfig — a --config flag names the file npm test loads (tkt-c9f680c783a6)', () => {
  // The repro: a conforming default beside the config actually run made the audit PASS on a file
  // vitest never loads.
  it('vitest-collection judges the --config file, not the unused vitest.config.ts', () => {
    const ctx = withTest('vitest run --config vitest.unit.config.ts', {
      'vitest.config.ts': CONFORMING,
      'vitest.unit.config.ts': BARE,
    });
    const res = vitestCollection.run(ctx);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('vitest.unit.config.ts');
  });

  it('test-run-hold judges the --config file too', () => {
    const held = `import { holdTestRun } from 'ticket-workflow/test-run';\nawait holdTestRun();\nexport default { test: {} };\n`;
    const ctx = withTest('vitest run --config vitest.unit.config.ts', {
      'vitest.config.ts': held,
      'vitest.unit.config.ts': BARE,
    });
    const res = testRunHold.run(ctx);
    expect(res.detail).toContain('vitest.unit.config.ts');
    expect(res.detail).toContain('does not call holdTestRun');
  });

  it.each([
    ['vitest run --config vitest.unit.config.ts'],
    ['vitest run --config=vitest.unit.config.ts'],
    ['vitest run -c vitest.unit.config.ts'],
    ['vitest run -c=vitest.unit.config.ts'],
    ["vitest run --config 'vitest.unit.config.ts'"],
    ['npx vitest run --config ./vitest.unit.config.ts'],
    ['NODE_ENV=test vitest --config vitest.unit.config.ts run'],
  ])('reads %s', (script) => {
    const ctx = withTest(script, { 'vitest.config.ts': CONFORMING, 'vitest.unit.config.ts': BARE });
    expect(resolvedFile(ctx)).toBe('vitest.unit.config.ts');
  });

  // A --config file's own directory does not move vitest's root.
  it('a --config in a subdirectory is found but not nested', () => {
    const r = resolveVitestConfig(withTest('vitest run --config config/vitest.unit.ts', { 'config/vitest.unit.ts': BARE }));
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.file).toBe('config/vitest.unit.ts');
      expect(r.nested).toBe(false);
      expect(r.dir).toBe('');
    }
  });

  it('a named vite.config.ts is taken even with no test block — vitest loads it regardless', () => {
    const ctx = withTest('vitest run --config vite.config.ts', { 'vite.config.ts': `export default { plugins: [] };\n` });
    expect(resolvedFile(ctx)).toBe('vite.config.ts');
  });

  it('a repeated identical --config across segments is one config', () => {
    const ctx = withTest('vitest run -c a.config.ts && vitest run --config=a.config.ts', { 'a.config.ts': BARE });
    expect(resolvedFile(ctx)).toBe('a.config.ts');
  });
});

describe('resolveVitestConfig — a --config it cannot follow never falls back to the defaults', () => {
  it('BLOCKS when the named file does not exist', () => {
    const ctx = withTest('vitest run --config nope.config.ts', { 'vitest.config.ts': CONFORMING });
    const r = resolveVitestConfig(ctx);
    expect(r.kind).toBe('error');
    expect(vitestCollection.run(ctx).status).toBe('blocked');
  });

  it.each([
    ['vitest run --config /abs/vitest.config.ts'],
    ['vitest run --config ~/vitest.config.ts'],
    ['vitest run --config "$CFG"'],
    ['vitest run --config ../vitest.config.ts'],
    ['vitest run --config='],
    ['vitest run --config'],
    ['vitest run --config --coverage'],
  ])('BLOCKS on an unfollowable value: %s', (script) => {
    const ctx = withTest(script, { 'vitest.config.ts': CONFORMING });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
    expect(vitestCollection.run(ctx).status).toBe('blocked');
  });

  it('two vitest segments naming different configs are ambiguous', () => {
    const ctx = withTest('vitest run -c a.config.ts && vitest run -c b.config.ts', {
      'a.config.ts': CONFORMING,
      'b.config.ts': CONFORMING,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('ambiguous');
  });

  it('a default run beside a --config run is ambiguous', () => {
    const ctx = withTest('vitest run && vitest run -c b.config.ts', {
      'vitest.config.ts': CONFORMING,
      'b.config.ts': CONFORMING,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('ambiguous');
  });

  it('a single segment naming two different configs is ambiguous too', () => {
    const ctx = withTest('vitest run -c a.config.ts --config b.config.ts', {
      'a.config.ts': CONFORMING,
      'b.config.ts': CONFORMING,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('ambiguous');
  });

  it('--no-config reads as missing: vitest runs on its defaults', () => {
    const ctx = withTest('vitest run --no-config', { 'vitest.config.ts': CONFORMING });
    expect(resolveVitestConfig(ctx).kind).toBe('missing');
  });

  // After `--` npm hands every argument to the delegate's script, so the shorthand is vitest's.
  it('a -c passed through an npm --prefix delegation after -- BLOCKS', () => {
    const ctx = withTest('npm --prefix server test -- -c ci.config.ts', {
      'server/vitest.config.ts': CONFORMING,
      'server/ci.config.ts': BARE,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
  });

  it('a -c on the npm side of an npm --prefix delegation is npm\'s, not a block', () => {
    const ctx = withTest('npm --prefix server -c run test', { 'server/vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('server/vitest.config.ts');
  });

  it.each([
    ['npx vitest@4 run --config u.config.ts'],
    ['npx --no-install vitest run --config u.config.ts'],
    ['npm exec -- vitest run --config u.config.ts'],
    ['bunx vitest run --config u.config.ts'],
    ['time vitest run --config u.config.ts'],
    ['dotenv -e .env.test -- vitest run -c u.config.ts'],
    ['node node_modules/vitest/vitest.mjs run --config u.config.ts'],
    ["sh -c 'vitest run --config u.config.ts'"],
  ])('BLOCKS a config flag on a vitest launcher it does not model: %s', (script) => {
    const ctx = withTest(script, { 'vitest.config.ts': CONFORMING, 'u.config.ts': BARE });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
  });

  it('BLOCKS a config flag one npm run hop away', () => {
    const ctx = ctxWith({
      'package.json': JSON.stringify({ scripts: { test: 'npm run test:unit', 'test:unit': 'vitest run --config u.config.ts' } }),
      'vitest.config.ts': CONFORMING,
      'u.config.ts': BARE,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
  });

  it('a config-less npm run hop still resolves the default', () => {
    const ctx = ctxWith({
      'package.json': JSON.stringify({ scripts: { test: 'npm run test:unit', 'test:unit': 'vitest run' } }),
      'vitest.config.ts': CONFORMING,
    });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('a --config carried by an npm --prefix delegation BLOCKS', () => {
    const ctx = withTest('npm --prefix server run test -- --config ci.config.ts', {
      'server/vitest.config.ts': CONFORMING,
      'server/ci.config.ts': BARE,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
  });
});

// Judging only the named file gave a false FAIL where the exclude and holdTestRun live in its base.
describe('resolveVitestConfig — a named config that builds on another local config', () => {
  const MERGED = `import { mergeConfig, defineConfig } from 'vitest/config';\nimport base from './vitest.config';\nexport default mergeConfig(base, defineConfig({ test: { include: ['src/**'] } }));\n`;

  it('BLOCKS a mergeConfig over a local base instead of failing it', () => {
    const ctx = withTest('vitest run --config vitest.unit.config.ts', { 'vitest.config.ts': CONFORMING, 'vitest.unit.config.ts': MERGED });
    const r = resolveVitestConfig(ctx);
    expect(r.kind).toBe('undeterminable');
    const res = vitestCollection.run(ctx);
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('./vitest.config');
  });

  it('BLOCKS a re-export of a local config', () => {
    const ctx = withTest('vitest run --config vitest.unit.config.ts', {
      'vitest.config.ts': CONFORMING,
      'vitest.unit.config.ts': `export { default } from './vitest.config';\n`,
    });
    expect(resolveVitestConfig(ctx).kind).toBe('undeterminable');
  });

  it('a relative import that is not a config does not block', () => {
    const ctx = withTest('vitest run --config vitest.unit.config.ts', {
      'vitest.unit.config.ts': `import { PORT } from './shared/ports';\n${BARE}`,
    });
    expect(resolvedFile(ctx)).toBe('vitest.unit.config.ts');
  });
});

describe('resolveVitestConfig — what is NOT a --config for vitest', () => {
  it('ignores a -c on a segment that never names vitest', () => {
    const ctx = withTest('eslint -c .eslintrc.json . && vitest run', { 'vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('a vitest.*.config filename on another segment is not a vitest launcher', () => {
    const ctx = withTest('prettier --config p.json vitest.ci.config.ts && vitest run', { 'vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('ignores --config on a non-vitest segment', () => {
    const ctx = withTest('tsc --config tsconfig.build.json && vitest run', { 'vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('ignores a --config inside a quoted argument', () => {
    const ctx = withTest("vitest run --reporter='--config nope.ts'", { 'vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('does not read --configLoader as --config', () => {
    const ctx = withTest('vitest run --configLoader runner', { 'vitest.config.ts': CONFORMING });
    expect(resolvedFile(ctx)).toBe('vitest.config.ts');
  });

  it('a plain vitest run still resolves the default', () => {
    expect(resolvedFile(withTest('vitest run', { 'vitest.config.ts': CONFORMING }))).toBe('vitest.config.ts');
  });
});

describe('resolveVitestConfig — candidate order is the order vitest loads (tkt-86a3dc02c9cb)', () => {
  it('reads vitest.config.mts over vitest.config.js, as vitest does', () => {
    const ctx = withTest('vitest run', { 'vitest.config.js': CONFORMING, 'vitest.config.mts': BARE });
    expect(resolvedFile(ctx)).toBe('vitest.config.mts');
  });

  it.each(['vitest.config.cts', 'vitest.config.cjs'])('finds %s when it is the only config', (name) => {
    expect(resolvedFile(withTest('vitest run', { [name]: CONFORMING }))).toBe(name);
  });

  // Catches an upstream reorder, not an added extension: only these 12 names are ever written.
  it('picks the same file as the installed vitest at every step, when every candidate has a test block', async () => {
    const names = ['vitest.config', 'vite.config'].flatMap((n) => ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((e) => n + e));
    const configs = Object.fromEntries(names.map((n) => [n, /\.c[jt]s$/.test(n) ? CONFORMING.replace('export default', 'module.exports =') : CONFORMING]));
    const ctx = ctxWith({ 'package.json': JSON.stringify({ type: 'module', scripts: { test: 'vitest run' } }), ...configs });
    const audit: string[] = [];
    const vitest: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const { viteConfig } = await resolveConfig({ root: ctx.repoDir });
      const picked = path.basename(viteConfig.configFile ?? '<none>');
      vitest.push(picked);
      audit.push(resolvedFile(ctx));
      rmSync(path.join(ctx.repoDir, picked));
    }
    expect(new Set(vitest).size).toBe(names.length);
    expect(audit).toEqual(vitest);
  });

  // Known divergence: flips red once tkt-4df3344cd0f4 lands — delete this case then.
  it.fails('reads a test-less vite.config.ts as the config, as vitest does (tkt-4df3344cd0f4)', () => {
    const ctx = withTest('vitest run', { 'vite.config.ts': 'export default { server: {} };\n', 'vite.config.mjs': CONFORMING });
    expect(resolvedFile(ctx)).not.toBe('vite.config.mjs');
  });
});
