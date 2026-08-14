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

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { isMain } from './lib/is-main.mjs';

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

// Returns { out } or { err } — callers must distinguish "git said no" from
// "git could not answer", so a thrown error is never flattened into null.
function tryGit(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024, // a big repo's diff must not truncate into a false "no drift"
    });
    return { out: out.trim() };
  } catch (e) {
    return { err: String(e?.stderr || e?.message || e).trim() };
  }
}

const NOT_A_REPO = /not a git repository|does not appear to be a git repository/i;

export function gatherFacts(cwd, threshold = DEFAULT_THRESHOLD) {
  const inside = tryGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.err) {
    // Genuinely outside a repo is the common case and warrants silence. Any other
    // git failure means the check could not run, which must be said out loud.
    if (NOT_A_REPO.test(inside.err)) return { isLinkedWorktree: false };
    return { isLinkedWorktree: null, probeError: firstLine(inside.err), threshold };
  }
  if (inside.out !== 'true') return { isLinkedWorktree: false };

  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], cwd);
  // --path-format=absolute needs git >= 2.31; --git-common-dir alone is older and
  // may be relative, so it is resolved against the worktree root when needed.
  let commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (commonDir.err) {
    const relative = tryGit(['rev-parse', '--git-common-dir'], cwd);
    const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
    commonDir =
      relative.out && root.out
        ? { out: relative.out.startsWith('/') ? relative.out : `${root.out}/${relative.out}` }
        : relative;
  }
  if (gitDir.err || commonDir.err) {
    return {
      isLinkedWorktree: null,
      probeError: firstLine(gitDir.err || commonDir.err),
      threshold,
    };
  }
  if (resolveReal(gitDir.out) === resolveReal(commonDir.out)) return { isLinkedWorktree: false };

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

// origin/HEAD first: it names the repo's ACTUAL default branch, so a repo on
// `develop` is not permanently alarmed about a missing origin/main. Local
// main/master last, for repos with no remote at all.
export function resolveBaseRef(cwd) {
  const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).out;
  const candidates = [
    ...(head ? [head] : []),
    'origin/main',
    'origin/master',
    'main',
    'master',
  ];
  for (const ref of candidates) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).out) return ref;
  }
  return null;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 200);
}

function resolveReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Extracted from the direct-execution tail so a consumer can import and call it, matching the other
// four hooks. It keeps the trailing process.exit(0) they all have: `main` IS the I/O wiring, so a
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
