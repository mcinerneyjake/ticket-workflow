import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEvidence } from './contention.js';
import ContentionEvidenceReporter, { CONTENTION_EVIDENCE_ENV, isOwnGlobalSetup } from './contentionReporter.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function evidenceFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-contention-evidence-'));
  dirs.push(dir);
  const file = path.join(dir, 'e.json');
  vi.stubEnv(CONTENTION_EVIDENCE_ENV, file);
  return file;
}

function finish(coverage: { enabled?: boolean; reportOnFailure?: boolean; thresholds?: object } | undefined, errors: readonly object[], globalSetup?: unknown): void {
  const r = new ContentionEvidenceReporter();
  r.onInit({ config: { coverage, globalSetup } });
  r.onTestRunEnd([], errors);
}

/** A package root holding `rel`, named `name` (no package.json when null). Returns the absolute path of `rel`. */
function packageFile(name: string | null, rel: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-contention-pkg-'));
  dirs.push(root);
  if (name !== null) writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

describe('ContentionEvidenceReporter', () => {
  it('writes the unhandled error count in the shape parseEvidence accepts', () => {
    const file = evidenceFile();
    finish({ enabled: false }, [new Error('a'), new Error('b')]);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toEqual({ version: 2, unhandledErrors: 2, coverageAfterFailure: false, foreignGlobalSetup: [], ownGlobalSetup: false });
  });
  it("lists every globalSetup but ticket-workflow's own, whose failed release vitest logs (tkt-e51870afd0da)", () => {
    const file = evidenceFile();
    const own = fileURLToPath(new URL('../test-run/globalSetup.ts', import.meta.url));
    const built = packageFile('ticket-workflow', path.join('dist', 'test-run', 'globalSetup.js'));
    const theirs = packageFile('consumer', 'vitest.globalSetup.ts');
    finish(undefined, [], [own, built, theirs]);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toMatchObject({ foreignGlobalSetup: [theirs], ownGlobalSetup: true });
  });
  it('reads a single globalSetup string as a one-entry list', () => {
    const file = evidenceFile();
    const theirs = packageFile('consumer', 'gs.mjs');
    finish(undefined, [], theirs);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toMatchObject({ foreignGlobalSetup: [theirs], ownGlobalSetup: false });
  });
  it("adds each project's globalSetup to the root's, once each", () => {
    const file = evidenceFile();
    const root = packageFile('consumer', 'root.mjs');
    const proj = packageFile('consumer', 'proj.mjs');
    const r = new ContentionEvidenceReporter();
    r.onInit({ config: { globalSetup: [root] }, projects: [{ config: { globalSetup: [root] } }, { config: { globalSetup: proj } }, { config: {} }] });
    r.onTestRunEnd([], []);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toMatchObject({ foreignGlobalSetup: [root, proj] });
  });
  it('writes nothing when a project carries a globalSetup entry that is not a path', () => {
    const file = evidenceFile();
    const r = new ContentionEvidenceReporter();
    r.onInit({ config: {}, projects: [{ config: { globalSetup: [42] } }] });
    r.onTestRunEnd([], []);
    expect(existsSync(file)).toBe(false);
  });
  it('writes nothing when a globalSetup entry is not a path, rather than guess it is ours', () => {
    const file = evidenceFile();
    finish(undefined, [], [packageFile('consumer', 'gs.mjs'), { file: 'gs.mjs' }]);
    expect(existsSync(file)).toBe(false);
  });
});

describe('isOwnGlobalSetup', () => {
  it.each([
    ['the source file in a ticket-workflow checkout', 'ticket-workflow', path.join('src', 'test-run', 'globalSetup.ts'), true],
    ['the built file in an installed ticket-workflow', 'ticket-workflow', path.join('dist', 'test-run', 'globalSetup.js'), true],
    ['the same path in another package', 'consumer', path.join('dist', 'test-run', 'globalSetup.js'), false],
    ['the same path with no package.json above it', null, path.join('dist', 'test-run', 'globalSetup.js'), false],
    ['another file in a ticket-workflow checkout', 'ticket-workflow', path.join('src', 'test-run', 'other.ts'), false],
    ['the source name built to .js', 'ticket-workflow', path.join('src', 'test-run', 'globalSetup.js'), false],
    ['a file whose name merely ends in the same word', 'ticket-workflow', path.join('dist', 'test-run', 'myglobalSetup.js'), false],
  ])('%s', (_label, name, rel, expected) => {
    expect(isOwnGlobalSetup(packageFile(name, rel))).toBe(expected);
  });
  it('recognizes its own path written with backslashes, as on Windows', () => {
    expect(isOwnGlobalSetup(packageFile('ticket-workflow', path.join('dist', 'test-run', 'globalSetup.js')).replaceAll('/', '\\'))).toBe(true);
  });
  it('reads an unparseable package.json as not ours', () => {
    const file = packageFile(null, path.join('src', 'test-run', 'globalSetup.ts'));
    writeFileSync(path.resolve(file, '..', '..', '..', 'package.json'), '{');
    expect(isOwnGlobalSetup(file)).toBe(false);
  });
});

describe('ContentionEvidenceReporter coverage and output path', () => {
  it.each([
    [{ enabled: true, reportOnFailure: true, thresholds: { lines: 80 } }, true],
    [{ enabled: true, reportOnFailure: true }, false],
    [{ enabled: true, reportOnFailure: true, thresholds: {} }, false],
    [{ enabled: true, reportOnFailure: false, thresholds: { lines: 80 } }, false],
    [{ enabled: true, thresholds: { lines: 80 } }, false],
    [{ enabled: false, reportOnFailure: true, thresholds: { lines: 80 } }, false],
    [undefined, false],
  ])('reads coverage %j as coverageAfterFailure=%s', (coverage, expected) => {
    const file = evidenceFile();
    finish(coverage, []);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toMatchObject({ unhandledErrors: 0, coverageAfterFailure: expected });
  });
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('writes nothing when the evidence path is %s', (_label, value) => {
    const file = evidenceFile();
    vi.stubEnv(CONTENTION_EVIDENCE_ENV, value);
    finish(undefined, [new Error('a')]);
    expect(existsSync(file)).toBe(false);
  });
  it('writes nothing when onInit never ran, rather than claim coverage was clear', () => {
    const file = evidenceFile();
    new ContentionEvidenceReporter().onTestRunEnd([], []);
    expect(existsSync(file)).toBe(false);
  });
});
