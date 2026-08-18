import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { sweep, type Candidate, type SweepResult } from './probe.js';

/**
 * Ratchet over the vacuous-tests probe.
 *
 * The probe measures; this decides whether the measurement is acceptable. A count may hold or
 * fall, never rise: a vacuous test is worse than a missing one for agentic work, because it turns
 * the gate green and so reports the work as done.
 *
 * Three rules exist because a first cut got each wrong, every one the same shape — a check that
 * could not run reporting as a pass:
 *
 *  1. A MISSING or malformed baseline is a failure, not a pass — "I have no ceiling for this repo"
 *     must never read as "this repo is clean".
 *  2. Only reading the candidate COUNT let a sweep that screened 2 of 91 files score a clean 0.
 *     The recorded `files` is a breadth floor, so a collapsed sweep fails.
 *  3. Exit 1 meant both "ceiling breached" and "the probe threw", so a wrapper could not tell a
 *     real finding from a broken instrument. Exit codes are distinct: 1 breach, 2 usage, 3 error.
 *
 * The baseline is REPO-LOCAL — `vacuous-baseline.json` at the swept root — so the row and the tree
 * cannot name different repos, which closed the worst defect of the central-baseline design: a
 * check that swept one repo and reported another's ceiling.
 */

export const BASELINE_NAME = 'vacuous-baseline.json';

export const EXIT = { OK: 0, BREACH: 1, USAGE: 2, PROBE_ERROR: 3 } as const;

// A sweep may shrink a little as tests are consolidated; it must not collapse. Below this fraction
// of the recorded breadth, the sweep is treated as not having run rather than as a clean result.
export const BREADTH_FLOOR = 0.8;

export interface BaselineRow {
  max: number;
  files?: number;
  blocks?: number;
  asOf?: string;
  accepted?: string[];
}

export interface CheckResult {
  ok: boolean;
  kind: 'no-baseline' | 'sweep-collapsed' | 'accepted-mismatch' | 'breach' | 'below' | 'at-ceiling' | 'probe-error';
  repo: string;
  found: number | null;
  max: number | null;
  message: string;
  candidates?: Candidate[];
}

/** Pure. `found` is the probe's output; `row` the parsed baseline (or undefined). */
export function compareToBaseline(repo: string, found: SweepResult, row: unknown): CheckResult {
  const { candidates, files, blocks } = found;
  const count = candidates.length;

  if (typeof row !== 'object' || row === null || !('max' in row) || typeof row.max !== 'number') {
    return {
      ok: false,
      kind: 'no-baseline',
      repo,
      found: count,
      max: null,
      message: `No vacuous-test baseline for "${repo}", so ${count} candidate(s) could not be judged. An unknown ceiling is a failure, not a pass — add a ${BASELINE_NAME} at the repo root with numeric "max", "files" and "blocks", generated from this tool's own sweep output.`,
    };
  }
  const max = row.max;
  // A baseline with no recorded breadth would set the floor to 0 and silently disable the
  // sweep-collapse guard — "can't check breadth" must fail, not default to permissive.
  if (!('files' in row) || typeof row.files !== 'number' || !('blocks' in row) || typeof row.blocks !== 'number') {
    return {
      ok: false,
      kind: 'no-baseline',
      repo,
      found: count,
      max,
      message: `${repo}: ${BASELINE_NAME} records no sweep breadth (numeric "files" and "blocks") — without it a sweep that opened almost nothing would score a clean 0. Regenerate the baseline from the sweep's own output.`,
    };
  }
  const recordedFiles = row.files;
  const recordedBlocks = row.blocks;

  // Breadth first: a count is only meaningful if the sweep actually looked. BOTH dimensions —
  // a walk collapse shrinks `files`, but the historical failures (JSX, tagged templates) were
  // PARSE collapses: every file opened, almost no blocks seen.
  const floor = Math.floor(recordedFiles * BREADTH_FLOOR);
  const blockFloor = Math.floor(recordedBlocks * BREADTH_FLOOR);
  if (files < floor || blocks < blockFloor) {
    return {
      ok: false,
      kind: 'sweep-collapsed',
      repo,
      found: count,
      max,
      message: `${repo}: the sweep screened only ${files} test file(s) / ${blocks} block(s), against a recorded ${recordedFiles}/${recordedBlocks}. Below ${Math.round(BREADTH_FLOOR * 100)}% breadth this is treated as "the probe did not run", not as ${count} candidate(s) — a partial sweep must never pass as clean. Check the root argument and the walk's skip list.`,
    };
  }

  // Double-entry: an accepted list, when present, must account for exactly the headroom the
  // ceiling grants — a max quietly raised past its recorded accepts fails here. Count only, not
  // identity: entries carry file:line, which churns with ordinary edits above a candidate, so
  // identity-matching would red the gate on unrelated diffs. The list serves the human re-triager.
  if ('accepted' in row) {
    if (!Array.isArray(row.accepted)) {
      return {
        ok: false,
        kind: 'accepted-mismatch',
        repo,
        found: count,
        max,
        message: `${repo}: "accepted" must be an array of "file:line — reason" entries; a non-list cannot account for the ceiling's headroom.`,
      };
    }
    if (row.accepted.length !== max) {
      return {
        ok: false,
        kind: 'accepted-mismatch',
        repo,
        found: count,
        max,
        message: `${repo}: the baseline accepts ${row.accepted.length} candidate(s) but sets "max" to ${max}. Each accepted candidate is one line of headroom — re-triage and make the two agree, or drop the "accepted" list.`,
      };
    }
  }

  if (count > max) {
    return {
      ok: false,
      kind: 'breach',
      repo,
      found: count,
      max,
      candidates,
      message: `${repo}: ${count} vacuous-test candidate(s), ceiling is ${max}. A test that cannot fail turns the gate green and reports the work as done.\n${describe(candidates)}\nFix the new one, or lower the ceiling only if you removed one.`,
    };
  }

  if (count < max) {
    return {
      ok: true,
      kind: 'below',
      repo,
      found: count,
      max,
      message: `${repo}: ${count} candidate(s), below the ceiling of ${max} — lower "max" to ${count} in ${BASELINE_NAME} to keep the ratchet tight.`,
    };
  }
  return {
    ok: true,
    kind: 'at-ceiling',
    repo,
    found: count,
    max,
    message: `${repo}: ${count}/${max} (${files} files, ${blocks} blocks)`,
  };
}

// A count with no location forces a manual re-run to find the offender.
function describe(candidates: Candidate[]): string {
  const shown = candidates
    .slice(0, 20)
    .map((c) => `  ${c.file}${c.line ? `:${c.line}` : ''} — ${c.title} [${c.hits.join('; ')}]`)
    .join('\n');
  // Truncation says so — a silently capped list reads as the whole finding.
  return candidates.length > 20 ? `${shown}\n  … and ${candidates.length - 20} more` : shown;
}

/**
 * Sweep `root` and judge it against ITS OWN `vacuous-baseline.json`. The probe throwing — broken
 * controls, an empty tree, an unreadable baseline that exists — surfaces as `probe-error`, never as
 * a reassuring zero; only a baseline file that is genuinely absent reads as `no-baseline`.
 */
export function checkRoot(rootArg: string): CheckResult {
  const root = resolve(rootArg);
  const repo = basename(root);

  let row: unknown;
  try {
    row = JSON.parse(readFileSync(join(root, BASELINE_NAME), 'utf8'));
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      row = undefined; // genuinely absent — compareToBaseline turns this into no-baseline
    } else {
      return {
        ok: false,
        kind: 'probe-error',
        repo,
        found: null,
        max: null,
        message: `${repo}: ${BASELINE_NAME} exists but could not be read — this is NOT a clean result. ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  let found: SweepResult;
  try {
    found = sweep(root);
  } catch (e) {
    return {
      ok: false,
      kind: 'probe-error',
      repo,
      found: null,
      max: null,
      message: `${repo}: the probe itself failed, so nothing was screened — this is NOT a clean result. ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return compareToBaseline(repo, found, row);
}

/** The exit code a CLI wrapper should use for a result — breach and broken-instrument stay distinct. */
export function vacuousExitCode(result: CheckResult): number {
  if (result.ok) return EXIT.OK;
  return result.kind === 'breach' ? EXIT.BREACH : EXIT.PROBE_ERROR;
}
