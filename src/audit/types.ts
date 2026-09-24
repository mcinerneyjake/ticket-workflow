import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GuardrailTier } from '../templates.js';

export type AuditStatus = 'pass' | 'fail' | 'blocked' | 'exempt';

export interface AuditResult {
  readonly id: string;
  readonly tier: GuardrailTier;
  readonly status: AuditStatus;
  /** One line. For fail/blocked, say what to do about it. */
  readonly detail: string;
  /**
   * Advisory results are always reported but never move the exit code. Three are
   * advisory because their answer is not a conformance fact about the audited repo at all:
   * hook-arming (machine-local wiring is invisible from a repository, so PASS is unreachable and
   * gating would redden every CI forever), pin-freshness (a newer tag upstream is an upgrade
   * backlog, and gating on it would fail every open PR in an untouched repo the moment someone cuts
   * a tag elsewhere) and npm-version (the INSTALLED npm is a property of the machine, so CI would
   * be grading its own runner rather than the repo).
   *
   * tmpdir-cleanup is the deliberate exception, not a fourth instance: whether a repo removes its
   * own test fixtures IS a conformance fact about it. It is advisory for blast radius
   * (tkt-91002085c4fd) — every node-tier consumer fails it today, so gating would redden every open
   * PR in the fleet on a diff that changed nothing. Promotion to gating is a separate decision once
   * the fleet is clean, and adding a fifth advisory check on THIS precedent needs the same argument
   * made explicitly rather than inherited.
   *
   * test-run-hold is advisory on its own argument: consumers cannot pass it until they bump to the
   * release shipping `holdTestRun` (tkt-103ad27180c3). Promotion is tkt-d345e96e6d5e.
   *
   * pin-resolved IS a conformance fact, but the tag's commit is knowable only from the remote, so
   * gating would fail a required check on an unreachable network (tkt-2db61a124801).
   *
   * Everything else that cannot be determined still fails the gate — "can't check" is not
   * conformance.
   */
  readonly advisory: boolean;
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly contents: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

export type ExecResult =
  /**
   * The command ran; `ok` mirrors exit status 0. `status` is the raw exit code, which callers that
   * must tell one non-zero code from another need: the hook protocol reads exit 2 as BLOCK and exit
   * 1 as a non-blocking error, i.e. ALLOW, so collapsing both into `ok: false` would read a crashing
   * guard as a blocking one. It is optional because an injected test exec may omit it — and a caller
   * that cannot read an exit code must treat that as undetermined, never as the permissive answer.
   */
  | { readonly kind: 'ran'; readonly ok: boolean; readonly status?: number | null; readonly stdout: string; readonly stderr: string }
  /** The binary is not there (spawn ENOENT) — a BLOCKED answer, never a fail-open one. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string };

export type Exec = (cmd: string, args: readonly string[], opts?: { cwd?: string; input?: string }) => ExecResult;

export interface AuditContext {
  readonly repoDir: string;
  readonly read: (relPath: string) => ReadResult;
  readonly exec: Exec;
}

export interface AuditCheck {
  readonly id: string;
  readonly tier: GuardrailTier;
  readonly advisory?: true;
  run(ctx: AuditContext): AuditResult;
}

/** Array-REJECTING record predicate: `typeof [] === 'object'`, and an array where an object was
 *  expected must read as "could not determine", never as a record whose every key is undefined. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function makeResult(
  check: Pick<AuditCheck, 'id' | 'tier' | 'advisory'>,
  status: AuditStatus,
  detail: string,
): AuditResult {
  return { id: check.id, tier: check.tier, status, detail, advisory: check.advisory === true };
}

export function readRepoFile(repoDir: string, relPath: string): ReadResult {
  try {
    return { kind: 'ok', contents: readFileSync(path.join(repoDir, relPath), 'utf8') };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function defaultExec(cmd: string, args: readonly string[], opts?: { cwd?: string; input?: string }): ExecResult {
  const r = spawnSync(cmd, [...args], { cwd: opts?.cwd, input: opts?.input, encoding: 'utf8', timeout: 60_000 });
  if (r.error) {
    if ('code' in r.error && r.error.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', message: r.error.message };
  }
  return { kind: 'ran', ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
