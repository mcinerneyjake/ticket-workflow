#!/usr/bin/env node
// SessionStart hook — warns when the session opened in a git worktree whose
// instruction files are stale relative to the base branch.
//
// The hazard is not untidiness. A worktree nests a full checkout, so it carries
// its own copy of CLAUDE.md. Stale prose is harmless, but a stale CLAUDE.md
// INSTRUCTS: two live cases on 2026-08-11 were a kanban worktree 52 commits
// behind whose copy answered every repo-wide grep, and an equipment-schedule
// worktree 19 behind whose copy asserted TypeScript strict mode was OFF while
// the canonical file asserted it was ON and pinned by a test
// (tkt-af10174bec77, tkt-6321b5b79986).
//
// CONTRAST with guard-bash: that hook BLOCKS (PreToolUse, exit 2). This one only
// reports — it always exits 0 and can never wedge a session.
//
// THE INVARIANT THAT MATTERS: every probe has three outcomes, never two —
// clean, stale, or COULD-NOT-CHECK. A failed probe must never render as clean.
// The first cut of this file got that wrong in four separate places (a broken
// git env, a failed merge-base, a failed diff, and an unparseable threshold all
// silently reported "fine"), which is the exact fail-open shape it was written
// to eliminate. Hence `null` — not `[]`, not `false` — for "did not run", and
// `assessWorktree` routing every null to `level: 'unknown'`.
//
// Never fetches. The comparison is against whatever base ref the local repo
// already has, so a distance is a floor, not an exact figure.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { resolveBaseRef, tryGit } from './lib/default-branch.mjs';
import { worktreeFacts } from './lib/worktree.mjs';

// Matched by BASENAME, not by exact path: nested instruction files are a
// supported Claude Code feature, so apps/web/CLAUDE.md must count.
export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'];

export const DEFAULT_THRESHOLD = 15;

/** Pure. `facts` is everything the git layer could learn; this decides what to say. */
export function assessWorktree(facts) {
  const {
    isLinkedWorktree,
    branch,
    behind,
    staleFiles,
    baseRef,
    threshold = DEFAULT_THRESHOLD,
    probeError,
  } = facts;

  if (isLinkedWorktree === false) return { level: 'ok', summary: '', lines: [] };

  const where =
    !branch || branch === 'HEAD' ? 'detached worktree' : `worktree on '${branch}'`;

  // isLinkedWorktree === null means git could not answer. Cannot assume "not a
  // worktree" — that is the permissive answer, and a poisoned GIT_CONFIG_PARAMETERS
  // or a safe.directory refusal would silently disable this hook entirely.
  if (isLinkedWorktree === null) {
    return unknown('git could not be queried', [
      `Could not determine whether this directory is a git worktree${probeError ? ` (${probeError})` : ''}, so instruction-file staleness was NOT checked.`,
      'If this IS a worktree, its CLAUDE.md may be out of date — and a stale instruction file does not fail, it instructs. Fix the git environment (look for a poisoned GIT_CONFIG_PARAMETERS, a stale GIT_DIR, or a safe.directory refusal) rather than trusting the silence.',
    ]);
  }

  if (!baseRef) {
    return unknown(`no base ref resolvable in this ${where}`, [
      `This session is in a git ${where}, but no base ref could be resolved (tried origin/HEAD, origin/main, origin/master, and local main/master), so staleness was NOT checked.`,
      'Treat this checkout as unverified: a stale instruction file does not fail, it instructs.',
    ]);
  }

  if (behind === null) {
    return unknown(`commit distance unavailable in this ${where}`, [
      `This session is in a git ${where}, but the commit distance to ${baseRef} could not be computed, so staleness was NOT checked.`,
      'Treat this checkout as unverified — a stale instruction file does not fail, it instructs.',
    ]);
  }

  // null (not []) means the merge-base or diff probe failed. "I could not look"
  // must not become "nothing changed".
  if (staleFiles === null) {
    return unknown(`instruction-file check failed in this ${where}`, [
      `This session is in a git ${where}, ${behind} commit(s) behind ${baseRef}, but whether any instruction file changed on ${baseRef} could NOT be determined (merge-base or diff failed — an unrelated history, a shallow clone, or oversized diff output will do this).`,
      `Do not assume the CLAUDE.md here is current: compare it against ${baseRef} yourself before following it.`,
    ]);
  }

  const behindThreshold = behind >= threshold;
  if (!staleFiles.length && !behindThreshold) return { level: 'ok', summary: '', lines: [] };

  const lines = [`This session is in a git ${where}, ${behind} commit(s) behind ${baseRef}.`];

  if (staleFiles.length) {
    const plural = staleFiles.length === 1;
    lines.push(
      `${staleFiles.join(', ')} changed on ${baseRef} since this branch diverged, so the cop${plural ? 'y' : 'ies'} here ${plural ? 'is' : 'are'} STALE. Read the version on ${baseRef} instead — a stale instruction file does not fail, it instructs.`,
    );
  } else {
    lines.push(
      `No instruction file has changed on ${baseRef} yet, so the copies here are still accurate — but at this distance that can stop being true mid-session.`,
    );
  }

  lines.push(
    `Compared against the local ${baseRef} without fetching, so this distance is a floor: if that ref is itself behind the remote, the real drift is larger.`,
  );

  return {
    level: 'warn',
    summary: staleFiles.length
      ? `Stale ${staleFiles.join(', ')} in this ${where} (${behind} behind ${baseRef}) — read the ${baseRef} version.`
      : `This ${where} is ${behind} commits behind ${baseRef}.`,
    lines,
  };
}

function unknown(what, lines) {
  return { level: 'unknown', summary: `Stale-worktree check did not run: ${what}.`, lines };
}

/** Pure. Truthiness would discard a deliberate 0; an unparseable value is reported, not swallowed. */
export function parseThreshold(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { threshold: DEFAULT_THRESHOLD };
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    return {
      threshold: DEFAULT_THRESHOLD,
      warning: `WORKTREE_STALE_THRESHOLD="${raw}" is not a non-negative number; using the default of ${DEFAULT_THRESHOLD}.`,
    };
  }
  return { threshold: n };
}

/** Pure. Which changed paths are instruction files, matched by basename. */
export function instructionFilesIn(changedPaths) {
  return changedPaths.filter((p) => INSTRUCTION_FILES.includes(basename(p)));
}

export function formatReport(assessment) {
  if (assessment.level === 'ok') return null;
  return {
    systemMessage: assessment.summary,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: assessment.lines.join(' '),
    },
  };
}

export function gatherFacts(cwd, threshold = DEFAULT_THRESHOLD) {
  // The primary-vs-linked probe lives in lib/worktree.mjs, shared with guard-worktree
  // (tkt-1d647fd64ce4). Its three non-linked answers collapse to two here: this hook only reports on
  // linked worktrees, so 'primary' and 'none' are equally "nothing to say", while a null kind stays
  // the could-not-check that the header's invariant turns into level: 'unknown'.
  const { kind, probeError } = worktreeFacts(cwd);
  if (kind === null) return { isLinkedWorktree: null, probeError, threshold };
  if (kind !== 'linked') return { isLinkedWorktree: false };

  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out ?? null;
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) return { isLinkedWorktree: true, branch, baseRef: null, threshold };

  const behindRaw = tryGit(['rev-list', '--count', `HEAD..${baseRef}`], cwd).out;
  const behind = behindRaw && /^\d+$/.test(behindRaw) ? Number(behindRaw) : null;

  // The direct probe for the actual defect: did an instruction file move on the
  // base branch since this branch diverged? Diffs merge-base..baseRef, not the
  // working tree, so a deliberate local edit to CLAUDE.md is not "drift".
  // --no-relative because diff.relative would make paths cwd-relative in a
  // subdirectory session and silently match nothing.
  let staleFiles = null;
  const mergeBase = tryGit(['merge-base', 'HEAD', baseRef], cwd).out;
  if (mergeBase) {
    const changed = tryGit(
      ['diff', '--no-relative', '--name-only', `${mergeBase}..${baseRef}`],
      cwd,
    );
    if (changed.out !== undefined) {
      staleFiles = instructionFilesIn(changed.out.split('\n').filter(Boolean));
    }
  }

  return { isLinkedWorktree: true, branch, behind, staleFiles, baseRef, threshold };
}

// Re-exported from lib/ so the staleness reporter and the commit guard resolve the default branch
// through ONE ladder. Two copies would drift, and a guard disagreeing with the reporter about which
// branch is protected is the kind of split that hides for weeks (tkt-f32915b3e858).
export { resolveBaseRef };

// Extracted from the direct-execution tail so a consumer can import and call it, as every hook here
// does. It keeps the trailing process.exit(0) they all have: `main` IS the I/O wiring, so a
// launcher that imports it gets the hook's real exit behaviour rather than a half-run.
export function main() {
  try {
    let payload;
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      payload = undefined;
    }
    // payload.cwd is the project dir, matching guard-bash's convention.
    const startDir = payload?.cwd ?? process.cwd();
    const { threshold, warning } = parseThreshold(process.env.WORKTREE_STALE_THRESHOLD);
    const assessment = assessWorktree(gatherFacts(startDir, threshold));
    const report = formatReport(assessment);
    if (warning) {
      // A misconfigured threshold is itself a silent-failure risk, so it is
      // surfaced even when the worktree is otherwise clean.
      const merged = report ?? {
        systemMessage: '',
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      };
      merged.systemMessage = [warning, merged.systemMessage].filter(Boolean).join(' ');
      merged.hookSpecificOutput.additionalContext = [
        warning,
        merged.hookSpecificOutput.additionalContext,
      ]
        .filter(Boolean)
        .join(' ');
      process.stdout.write(JSON.stringify(merged));
    } else if (report) {
      process.stdout.write(JSON.stringify(report));
    }
  } catch {
    // A reporting hook must never wedge a session start.
  }
  process.exit(0);
}

if (isMain(import.meta.url)) main();
