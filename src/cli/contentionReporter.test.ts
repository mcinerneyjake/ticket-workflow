import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEvidence } from './contention.js';
import ContentionEvidenceReporter, { CONTENTION_EVIDENCE_ENV } from './contentionReporter.js';

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

function finish(coverage: { enabled?: boolean; reportOnFailure?: boolean; thresholds?: object } | undefined, errors: readonly object[]): void {
  const r = new ContentionEvidenceReporter();
  r.onInit({ config: { coverage } });
  r.onTestRunEnd([], errors);
}

describe('ContentionEvidenceReporter', () => {
  it('writes the unhandled error count in the shape parseEvidence accepts', () => {
    const file = evidenceFile();
    finish({ enabled: false }, [new Error('a'), new Error('b')]);
    expect(parseEvidence(readFileSync(file, 'utf8'))).toEqual({ version: 1, unhandledErrors: 2, coverageAfterFailure: false });
  });
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
