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
// It is NOT silent-on-failure, though. Inside a worktree, "I could not determine
// staleness" is reported as loudly as staleness itself, because the permissive
// answer here is exactly the wrong one. Outside a worktree it prints nothing:
// that is the common case and there is genuinely nothing to say.
//
// Never fetches. The comparison is against whatever origin/<base> the local repo
// already has, so a warning is a floor, not an exact figure — a stale remote ref
// means the real drift can only be larger. formatReport says so.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Instruction files whose drift misleads an agent rather than merely aging.
// Anything read as project instructions belongs here; source files do not.
export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'];

export const DEFAULT_THRESHOLD = 15;

// Pure. `facts` is everything the git layer could learn; this decides what to say.
// Returns { level, summary, lines } — level 'ok' means print nothing.
export function assessWorktree(facts) {
  const { isLinkedWorktree, branch, behind, staleFiles, baseRef, threshold = DEFAULT_THRESHOLD } =
    facts;

  if (!isLinkedWorktree) return { level: 'ok', summary: '', lines: [] };

  // `rev-parse --abbrev-ref HEAD` yields the literal "HEAD" when detached, which
  // would otherwise render as "worktree on 'HEAD'".
  const where = !branch || branch === 'HEAD' ? 'detached worktree' : `worktree on '${branch}'`;

  // Fail loud, not open: unresolvable base ref means the check did not run.
  if (!baseRef) {
    return {
      level: 'unknown',
      summary: `Stale-worktree check could not run in this ${where}.`,
      lines: [
        `This session is in a git ${where}, but no base ref (origin/main or origin/master) could be resolved, so staleness was NOT checked.`,
        'Treat this checkout as unverified: its CLAUDE.md and other instruction files may be out of date, and a stale instruction file does not fail — it instructs.',
        'Confirm the base ref exists (git fetch origin) before trusting project instructions read here.',
      ],
    };
  }

  if (behind === null) {
    return {
      level: 'unknown',
      summary: `Stale-worktree check could not run in this ${where}.`,
      lines: [
        `This session is in a git ${where}, but the commit distance to ${baseRef} could not be computed, so staleness was NOT checked.`,
        'Treat this checkout as unverified — a stale instruction file does not fail, it instructs.',
      ],
    };
  }

  const stale = staleFiles ?? [];
  const behindThreshold = behind >= threshold;
  if (!stale.length && !behindThreshold) return { level: 'ok', summary: '', lines: [] };

  const lines = [`This session is in a git ${where}, ${behind} commit(s) behind ${baseRef}.`];

  // The specific hazard, and the reason this hook exists at all.
  if (stale.length) {
    lines.push(
      `${stale.join(', ')} changed on ${baseRef} since this branch diverged, so the cop${stale.length === 1 ? 'y' : 'ies'} here ${stale.length === 1 ? 'is' : 'are'} STALE. Read the version on ${baseRef} instead — a stale instruction file does not fail, it instructs.`,
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
    summary: stale.length
      ? `Stale ${stale.join(', ')} in this ${where} (${behind} behind ${baseRef}) — read the ${baseRef} version.`
      : `This ${where} is ${behind} commits behind ${baseRef}.`,
    lines,
  };
}

// Pure. Shapes the SessionStart hook payload: systemMessage is shown to the
// user, additionalContext is injected into the model's context.
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

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function gatherFacts(cwd, threshold = DEFAULT_THRESHOLD) {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], cwd);
  const commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  // Not a repo at all, or git unusable — there is no worktree to be stale.
  if (!gitDir || !commonDir) return { isLinkedWorktree: false };
  if (gitDir === commonDir) return { isLinkedWorktree: false };

  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const baseRef = ['origin/main', 'origin/master'].find(
    (ref) => tryGit(['rev-parse', '--verify', '--quiet', ref], cwd) !== null,
  );
  if (!baseRef) return { isLinkedWorktree: true, branch, baseRef: null, threshold };

  const behindRaw = tryGit(['rev-list', '--count', `HEAD..${baseRef}`], cwd);
  const behind = behindRaw !== null && /^\d+$/.test(behindRaw) ? Number(behindRaw) : null;

  // The direct probe for the actual defect: did an instruction file move on the
  // base branch since this branch diverged? Local edits to it are intentional
  // and must not count, which is why this diffs merge-base..baseRef and not the
  // working tree.
  const mergeBase = tryGit(['merge-base', 'HEAD', baseRef], cwd);
  let staleFiles = [];
  if (mergeBase) {
    const changed = tryGit(['diff', '--name-only', `${mergeBase}..${baseRef}`], cwd);
    if (changed !== null) {
      const changedSet = new Set(changed.split('\n').filter(Boolean));
      staleFiles = INSTRUCTION_FILES.filter((f) => changedSet.has(f));
    }
  }

  return { isLinkedWorktree: true, branch, behind, staleFiles, baseRef, threshold };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const threshold = Number(process.env.WORKTREE_STALE_THRESHOLD) || DEFAULT_THRESHOLD;
    const report = formatReport(assessWorktree(gatherFacts(process.cwd(), threshold)));
    if (report) process.stdout.write(JSON.stringify(report));
  } catch {
    // A reporting hook must never wedge a session start.
  }
  process.exit(0);
}
