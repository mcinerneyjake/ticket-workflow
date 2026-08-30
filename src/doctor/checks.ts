/**
 * Machine-wiring diagnostics — the PURE half (tkt-1baab0ae07f4).
 *
 * Every check returns OK / MISMATCH / **UNKNOWN**, never a boolean. UNKNOWN is the point of the
 * type: this tool reads machine-local files that simply are not there in CI or on a fresh clone, and
 * a checker that cannot distinguish "I looked and it is fine" from "I could not look" reports the
 * second as the first. That is the fail-open shape this package exists to reject.
 *
 * Facts are gathered elsewhere so every branch here is reachable from a test without a machine.
 */

import { STEP_IDS, STATUS_STEP, type StepId } from '../shared/constants.js';

export type Status = 'ok' | 'mismatch' | 'unknown';

export interface CheckResult {
  readonly id: string;
  readonly status: Status;
  /** One line. For mismatch/unknown, say what to do about it. */
  readonly detail: string;
}

/** A hook wired somewhere on this machine, resolved to the file it actually runs. */
export interface WiredHook {
  /** Which settings file wired it, for the remediation line. */
  readonly source: string;
  /** Canonical hook name (`guard-bash`, …), or null when the command names no known hook. */
  readonly hook: string | null;
  readonly path: string;
  /** Content hash of the file that runs, or null if it could not be read. */
  readonly sha: string | null;
  /** True when the file delegates to the installed package rather than vendoring the hook. */
  readonly isLauncher: boolean;
}

/** A wired PostToolUse command, classified by whether it is a known telemetry writer. */
export interface PostToolUseHook {
  readonly command: string;
  readonly kind: 'writer' | 'unknown';
}

export interface DoctorFacts {
  /** null when no settings file could be read at all (expected in CI). */
  readonly postToolUse: readonly PostToolUseHook[] | null;
  /** Hooks wired in the settings files that apply here; empty array is a real answer. */
  readonly guardCopies: readonly WiredHook[] | null;
  /** Content hash of each hook this package ships, keyed by name; null if unreadable. */
  readonly canonicalShas: Readonly<Record<string, string>> | null;
  /** Every distinct ticket-workflow install this machine's WIRING reaches — doctor's own is excluded. */
  readonly installs: readonly { readonly root: string; readonly version: string | null }[] | null;
  /** The version doctor itself is running from. Reported, never compared: `npx` and a source
   *  checkout both differ from the install legitimately. */
  readonly selfVersion: string | null;
  /** MCP server: was it probed at all, is one configured, did it answer `initialize`, at what version. */
  readonly mcp: {
    readonly probed: boolean;
    readonly configured: boolean;
    readonly resolved: boolean;
    readonly timedOut: boolean;
    readonly version: string | null;
  } | null;
  /**
   * Board root doctor itself resolved, plus every root the machine's wiring pins.
   *
   * `targets` is the load-bearing part: the MCP server writes status events and the telemetry hook
   * writes command events, each carrying its own `BOARD_DIR_OVERRIDE`. If those disagree, both halves
   * work and every ticket's pipeline is split across two boards, which no single-root reading can see.
   */
  readonly board: {
    readonly root: string;
    readonly via: string;
    /** The directory actually stat'd — not always `<root>/tickets`, since an override can move it. */
    readonly ticketsDir: string;
    readonly ticketsDirExists: boolean;
    readonly targets: readonly { readonly source: string; readonly root: string }[];
  } | null;
  /**
   * What guard-bash will protect in the repo doctor was run from. `protects: null` means the
   * resolver refused (ambiguous); `existing` is the subset of `protects` that this repo actually has.
   */
  readonly protectedBranch: {
    readonly current: string | null;
    readonly protects: readonly string[] | null;
    readonly existing: readonly string[];
    /** guard-bash gates its commit rule on this, so a report ignoring it names branches as protected
     *  while commits on them are allowed. */
    readonly hasRemote: boolean;
  } | null;
  /** Most recent event written by a step ONLY the hook writes, ISO-8601 UTC. */
  readonly lastHookEventAt: string | null;
  /** Now, injected so the liveness window is testable. */
  readonly now: string;
  /** Per-repo gate scripts, for reporting which milestones telemetry can record at all. */
  readonly gateScripts: Readonly<Record<string, readonly string[]>> | null;
}

const RECORDABLE = ['typecheck', 'lint', 'test'];

/** Steps the MCP service writes on a status transition — DERIVED from the mapping the service uses,
 *  so adding a status-to-step mapping cannot leave a transcribed list behind. */
export const SERVICE_WRITTEN_STEPS: readonly StepId[] = Object.values(STATUS_STEP).filter(
  (s): s is StepId => s !== undefined,
);

/**
 * `review` has TWO writers — the track-steps hook derives it from a passing `git commit`, and the
 * `record_review` MCP tool appends it directly. So it cannot witness that the hook is alive, and
 * counting it would report a healthy writer whenever a human merely cleared a review.
 */
export const AMBIGUOUS_STEPS: readonly StepId[] = ['review'];

/** Steps that ONLY the PostToolUse hook can produce. The liveness check must read these and nothing
 *  else, or moving tickets around looks identical to a working reporter. Derived, not transcribed. */
export const HOOK_ONLY_STEPS: readonly StepId[] = STEP_IDS.filter(
  (s): s is StepId => !SERVICE_WRITTEN_STEPS.includes(s) && !AMBIGUOUS_STEPS.includes(s),
);

export function checkWriterUniqueness(f: DoctorFacts): CheckResult {
  const id = 'writer-uniqueness';
  if (f.postToolUse === null) {
    return {
      id,
      status: 'unknown',
      detail: 'no settings file could be read, so the number of telemetry writers is unknown (expected in CI)',
    };
  }
  // An unclassifiable PostToolUse command may or may not append events. Guessing either way is the
  // permissive answer to "I could not check" — and a matcher that silently stops recognising a
  // renamed writer would keep reporting a confident 1.
  const unknown = f.postToolUse.filter((h) => h.kind === 'unknown');
  if (unknown.length > 0) {
    return {
      id,
      status: 'unknown',
      detail: `${unknown.length} PostToolUse hook(s) could not be classified as writer or not: ${unknown
        .map((h) => h.command)
        .join('; ')}`,
    };
  }
  const n = f.postToolUse.length;
  if (n === 1) return { id, status: 'ok', detail: 'exactly one PostToolUse telemetry writer is wired' };
  if (n === 0) {
    return {
      id,
      status: 'mismatch',
      detail: 'no PostToolUse writer is wired — pipeline milestones are being recorded nowhere',
    };
  }
  return {
    id,
    status: 'mismatch',
    detail: `${n} PostToolUse writers are wired; every milestone is logged ${n} times. Writers are per-machine — remove all but one`,
  };
}

export function checkHookWiring(f: DoctorFacts): CheckResult {
  const id = 'hook-wiring';
  if (f.guardCopies === null) {
    return { id, status: 'unknown', detail: 'no settings file could be read, so the wired hooks are unknown (expected in CI)' };
  }
  if (f.canonicalShas === null) {
    return { id, status: 'unknown', detail: 'this package\'s own hooks could not be read, so there is nothing to compare against' };
  }
  const known = f.guardCopies.filter((h) => h.hook !== null);
  const unreadable = known.filter((h) => h.sha === null);
  if (unreadable.length > 0) {
    return {
      id,
      status: 'unknown',
      detail: `${unreadable.length} wired hook(s) could not be read: ${unreadable.map((h) => h.path).join(', ')}`,
    };
  }
  // A launcher delegates to the pinned package, so its own bytes are expected to differ. Only a
  // VENDORED copy can silently drift from the shipped hook while still looking correctly wired.
  const vendored = known.filter((h) => !h.isLauncher);
  const noCanonical = vendored.filter((h) => h.hook !== null && f.canonicalShas?.[h.hook] === undefined);
  if (noCanonical.length > 0) {
    return {
      id,
      status: 'unknown',
      detail: `this package ships no hook named ${noCanonical.map((h) => h.hook).join(', ')}, so those copies cannot be compared`,
    };
  }
  const drifted = vendored.filter((h) => h.hook !== null && f.canonicalShas?.[h.hook] !== h.sha);
  if (drifted.length === 0) {
    return { id, status: 'ok', detail: `${known.length} wired hook(s), ${vendored.length} vendored, none drifted` };
  }
  return {
    id,
    status: 'mismatch',
    detail: `${drifted.length} vendored hook copy/copies differ from the shipped hook: ${drifted
      .map((h) => `${h.path} (${h.source})`)
      .join(', ')} — replace with a launcher, or re-vendor`,
  };
}

export function checkPin(f: DoctorFacts): CheckResult {
  const id = 'pin';
  const self = f.selfVersion ? ` (doctor itself is ${f.selfVersion})` : '';
  if (f.installs === null || f.installs.length === 0) {
    return {
      id,
      status: 'unknown',
      detail: `no ticket-workflow install is reachable from any wired hook, so the live version is unknown${self}`,
    };
  }
  const unreadable = f.installs.filter((i) => i.version === null);
  if (unreadable.length > 0) {
    return {
      id,
      status: 'unknown',
      detail: `install present but its version is unreadable at ${unreadable.map((i) => i.root).join(', ')}`,
    };
  }
  const versions = [...new Set(f.installs.map((i) => i.version))];
  if (versions.length > 1) {
    return {
      id,
      status: 'mismatch',
      detail: `${versions.length} different versions are live at once: ${f.installs
        .map((i) => `${i.root}=${i.version}`)
        .join(', ')} — a hook and the code it guards can disagree`,
    };
  }
  return { id, status: 'ok', detail: `${f.installs.length} wired install(s), all at ${versions[0]}${self}` };
}

export function checkMcp(f: DoctorFacts): CheckResult {
  const id = 'mcp';
  if (f.mcp === null) return { id, status: 'unknown', detail: 'the MCP configuration could not be read' };
  // "I chose not to look" and "I looked and found nothing" are different answers, and printing the
  // second for the first is the same conflation UNKNOWN exists to prevent — one level down.
  if (!f.mcp.probed) return { id, status: 'unknown', detail: 'not probed (--no-mcp)' };
  if (!f.mcp.configured) {
    return { id, status: 'unknown', detail: 'no ticket-workflow MCP server is configured for this user' };
  }
  // MISMATCH, deliberately, even though the budget expiring is genuinely ambiguous: an MCP server is
  // long-lived, so one that boots and never answers stays alive and lands here — that is the ORDINARY
  // shape of a broken server, not a rare one. UNKNOWN is exit 0 outside --strict, so routing this
  // there would let the commonest breakage exit clean. The wording carries the ambiguity instead
  // (tkt-38391beace3e).
  if (f.mcp.timedOut) {
    return {
      id,
      status: 'mismatch',
      detail: 'the configured MCP server did not answer initialize within the probe budget — it is either broken or this machine is too loaded to judge; re-run on an idle machine to tell them apart',
    };
  }
  if (!f.mcp.resolved) {
    return {
      id,
      status: 'mismatch',
      detail: 'the configured MCP server did not answer initialize — every new session will start with no board tools',
    };
  }
  return { id, status: 'ok', detail: `MCP server answers initialize${f.mcp.version ? ` (${f.mcp.version})` : ''}` };
}

export function checkBoard(f: DoctorFacts): CheckResult {
  const id = 'board';
  if (f.board === null) return { id, status: 'unknown', detail: 'the board root could not be resolved' };
  const roots = [...new Set(f.board.targets.map((t) => t.root))];
  if (roots.length > 1) {
    return {
      id,
      status: 'mismatch',
      detail: `the machine's writers point at ${roots.length} different boards: ${f.board.targets
        .map((t) => `${t.source}=${t.root}`)
        .join(', ')} — each ticket's pipeline is split across them`,
    };
  }
  if (!f.board.ticketsDirExists) {
    // Nothing named a board and the root is only the cwd fallback: that is an absence, not a defect.
    // Calling it MISMATCH made a bare machine (CI, a fresh clone) fail for having no board at all —
    // the same conflation as reporting UNKNOWN as OK, pointed the other way.
    if (f.board.targets.length === 0 && f.board.via === 'cwd') {
      return {
        id,
        status: 'unknown',
        detail: `no board is configured by any wiring, and the cwd fallback has no ${f.board.ticketsDir}`,
      };
    }
    return {
      id,
      status: 'mismatch',
      detail: `${f.board.ticketsDir} does not exist (board root ${f.board.root}, via ${f.board.via}) — every session here sees an empty board`,
    };
  }
  const agreed = roots.length === 1 ? `; wiring agrees on ${roots[0]}` : '';
  return { id, status: 'ok', detail: `board root ${f.board.root} (via ${f.board.via})${agreed}` };
}

/**
 * What guard-bash actually protects HERE.
 *
 * The interesting failure is silent: the resolver falls back to the well-known names when it cannot
 * identify the default branch, so a repo defaulting to `trunk` gets a guard protecting two branches
 * it does not have — which reads as armed and guards nothing.
 */
export function checkProtectedBranch(f: DoctorFacts): CheckResult {
  const id = 'protected-branch';
  if (f.protectedBranch === null) {
    return { id, status: 'unknown', detail: 'not a git repository, or the branch could not be resolved' };
  }
  const { current, protects, existing, hasRemote } = f.protectedBranch;
  // Checked FIRST because guard-bash returns before its branch rules when there is no remote. Naming
  // a branch as protected here would be a report of a guard that does not fire — the exact fail-open
  // this command exists to catch, produced by the command itself.
  if (!hasRemote) {
    return {
      id,
      status: 'mismatch',
      detail: `no remote is configured, so guard-bash's commit rule does not fire here — commits on ${
        protects?.join(', ') ?? 'the default branch'
      } are ALLOWED (pushes to an explicit URL are still blocked). Add a remote, or accept that this repo is unguarded`,
    };
  }
  if (protects === null) {
    return {
      id,
      status: 'mismatch',
      detail: 'the default branch is ambiguous here, so guard-bash refuses — every commit in this repo is blocked until origin/HEAD is set',
    };
  }
  if (existing.length === 0) {
    return {
      id,
      status: 'mismatch',
      detail: `guard-bash protects ${protects.join(', ')}, none of which exist here — this repo's real default branch is unguarded. Set origin/HEAD, or TICKET_WORKFLOW_PROTECTED_BRANCH`,
    };
  }
  return { id, status: 'ok', detail: `protects ${existing.join(', ')}; currently on ${current ?? 'an unresolvable branch'}` };
}

/**
 * Has the telemetry hook written anything recently?
 *
 * Deliberately blunt: this cannot prove the writer is healthy, only that it was alive within the
 * window. It reports UNKNOWN rather than MISMATCH when nothing is found, because "no events" is also
 * what a brand-new board looks like, and calling that a failure would cry wolf.
 */
export function checkReporterLiveness(f: DoctorFacts, windowHours = 72): CheckResult {
  const id = 'reporter-liveness';
  if (f.lastHookEventAt === null) {
    return {
      id,
      status: 'unknown',
      detail: 'no hook-written events found at all — cannot distinguish a dead writer from a new board',
    };
  }
  const last = Date.parse(f.lastHookEventAt);
  const now = Date.parse(f.now);
  if (Number.isNaN(last) || Number.isNaN(now)) {
    return { id, status: 'unknown', detail: 'event timestamps are unparseable' };
  }
  // Event `at` is UTC while the window is a duration, so a local-evening gap is arithmetic, not a
  // date comparison — reading dates would fire a false alarm every night at local midnight.
  const hours = (now - last) / 3_600_000;
  if (hours <= windowHours) {
    return { id, status: 'ok', detail: `last hook-written event ${Math.round(hours)}h ago` };
  }
  return {
    id,
    status: 'mismatch',
    detail: `no hook-written event for ${Math.round(hours)}h — the telemetry hook may have stopped recording silently`,
  };
}

/**
 * Which of a repo's gate steps telemetry can record at all.
 *
 * REPORTS, never fails. An absent gate script is a fact about coverage, not a misconfiguration —
 * plenty of healthy repos have no lint step — so it is UNKNOWN: those milestones are unjudgeable
 * here, which is exactly what a reader of the log needs to know before scoring the repo as skipping
 * them. Making it MISMATCH exited 2 on the README's own headline invocation, which trains the reader
 * to ignore the exit code, and `--strict` still surfaces it for a gate that wants full coverage.
 */
export function checkToolchain(f: DoctorFacts): CheckResult {
  const id = 'toolchain';
  if (f.gateScripts === null) {
    return { id, status: 'unknown', detail: 'no package scripts could be read here, so recordable gate steps are unknown' };
  }
  const missing = Object.entries(f.gateScripts).flatMap(([repo, scripts]) =>
    RECORDABLE.filter((s) => !scripts.includes(s)).map((s) => `${repo}:${s}`),
  );
  if (missing.length === 0) {
    return { id, status: 'ok', detail: 'every recordable gate step exists where telemetry expects it' };
  }
  return {
    id,
    status: 'unknown',
    detail: `gate step(s) absent, so those milestones can never be recorded: ${missing.join(', ')}`,
  };
}

export function runChecks(f: DoctorFacts): CheckResult[] {
  return [
    checkWriterUniqueness(f),
    checkHookWiring(f),
    checkPin(f),
    checkMcp(f),
    checkBoard(f),
    checkProtectedBranch(f),
    checkReporterLiveness(f),
    checkToolchain(f),
  ];
}

/** Exit code: 2 on any mismatch; also on unknown under --strict, because "could not check" must not
 *  be reported as success by a gate. */
export function exitCodeFor(results: readonly CheckResult[], strict: boolean): number {
  if (results.some((r) => r.status === 'mismatch')) return 2;
  if (strict && results.some((r) => r.status === 'unknown')) return 2;
  return 0;
}

export function formatResults(results: readonly CheckResult[]): string {
  const label: Record<Status, string> = { ok: 'OK      ', mismatch: 'MISMATCH', unknown: 'UNKNOWN ' };
  return results.map((r) => `${label[r.status]}  ${r.id.padEnd(18)} ${r.detail}`).join('\n');
}
