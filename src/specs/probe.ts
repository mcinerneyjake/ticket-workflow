import { SPEC_REF_HINT, type Ticket } from '../shared/constants.js';
import type { Exec } from '../audit/types.js';
import type { SpecBoardListing } from '../server/tickets.js';

export const SPECS_EXIT = { CLEAN: 0, FINDINGS: 1, NOT_CHECKED: 2 } as const;

export const SPEC_INDEX_PATH = 'docs/specs/README.md';

export interface SpecProbeReport {
  readonly findings: readonly string[];
  readonly notChecked: readonly string[];
  readonly clean: readonly string[];
  /** Archived spec tickets: archive_ticket accepts any prior status, so retired work owes no index entry. */
  readonly retired: readonly string[];
}

// A full sha only: a short hex ref could be a branch name, which is not a permalink.
const SHA = '[0-9a-fA-F]{40}';

type Lookup =
  | { readonly kind: 'found'; readonly stdout: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown'; readonly why: string };

// Measured 2026-10-06: gh exits 1 with `(HTTP 404)` on stderr for a missing path, an unknown commit
// AND an unknown-or-inaccessible repo. Anything else it prints is not an answer.
function ghApi(exec: Exec, endpoint: string, jq: string): Lookup {
  const r = exec('gh', ['api', endpoint, '--jq', jq]);
  if (r.kind === 'absent') return { kind: 'unknown', why: 'gh is not installed' };
  if (r.kind === 'error') return { kind: 'unknown', why: r.message };
  if (r.ok) return { kind: 'found', stdout: r.stdout.trim() };
  if (/\(HTTP 404\)/.test(r.stderr)) return { kind: 'missing' };
  return { kind: 'unknown', why: r.stderr.trim().split('\n')[0] || `gh exited ${String(r.status)}` };
}

function splitSpecRef(spec: string): { repo: string; path: string } {
  const colon = spec.indexOf(':');
  return { repo: spec.slice(0, colon), path: spec.slice(colon + 1) };
}

const PERMALINK = new RegExp(`https://github\\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/blob/(${SHA})/([A-Za-z0-9._/-]+)`, 'g');

/** Commits whose permalink in `index` names `repo`'s `path`. Owner/repo compare case-insensitively, as GitHub does. */
export function indexedCommits(index: string, repo: string, path: string): string[] {
  const shas: string[] = [];
  for (const m of index.matchAll(PERMALINK)) {
    const linkedPath = m[4].replace(/\.+$/, '');
    if (`${m[1]}/${m[2]}`.toLowerCase() === repo.toLowerCase() && linkedPath === path) shas.push(m[3].toLowerCase());
  }
  return shas;
}

// The contents API returns `encoding: "none"` and empty content for a file over 1 MB; erroring in jq
// turns that into a non-404 failure, i.e. not checked, rather than an empty index.
const INDEX_JQ = 'if .encoding == "base64" then .content else error("index content not inline (encoding \\(.encoding))") end';

class RepoView {
  private branch: Lookup | undefined;
  private readonly indexes = new Map<string, Lookup>();
  constructor(private readonly exec: Exec, readonly repo: string) {}

  defaultBranch(): Lookup {
    this.branch ??= ghApi(this.exec, `repos/${this.repo}`, '.default_branch');
    // A 404 here is "no such repo OR no access": not evidence that anything is missing.
    if (this.branch.kind === 'missing') return { kind: 'unknown', why: `repo ${this.repo} not found or not accessible` };
    if (this.branch.kind === 'found' && this.branch.stdout === '') return { kind: 'unknown', why: `repo ${this.repo} reported no default branch` };
    return this.branch;
  }

  /** A symlink or submodule at the path is not a spec file, and not proof one is missing. */
  file(path: string, ref: string): Lookup {
    const r = ghApi(this.exec, `repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, '.type');
    if (r.kind === 'found' && r.stdout !== 'file') return { kind: 'unknown', why: `${path} at ${ref} is a ${r.stdout || 'non-file'}, not a file` };
    return r;
  }

  specIndex(ref: string): Lookup {
    let index = this.indexes.get(ref);
    if (index === undefined) {
      const r = ghApi(this.exec, `repos/${this.repo}/contents/${SPEC_INDEX_PATH}?ref=${encodeURIComponent(ref)}`, INDEX_JQ);
      index = r.kind === 'found' ? { kind: 'found', stdout: Buffer.from(r.stdout, 'base64').toString('utf8') } : r;
      this.indexes.set(ref, index);
    }
    return index;
  }
}

export function checkSpecs(board: SpecBoardListing, exec: Exec): SpecProbeReport {
  const findings: string[] = [];
  const notChecked: string[] = [];
  const clean: string[] = [];
  const retired: string[] = [];
  if (board.ticketFiles === 0) {
    return { findings, notChecked: ['the board holds no ticket files — is this the right board root?'], clean, retired };
  }
  for (const u of board.unreadable) notChecked.push(`${u.file}: ${u.reason}; it may be a spec ticket`);
  for (const m of board.malformedSpec) notChecked.push(`${m.id}: malformed spec frontmatter (${SPEC_REF_HINT})`);

  const repos = new Map<string, RepoView>();
  for (const t of board.specTickets) {
    if (t.spec === null) continue;
    if (t.status === 'archived') {
      retired.push(`${t.id}: archived; ${t.spec} not checked`);
      continue;
    }
    const { repo, path } = splitSpecRef(t.spec);
    const view = repos.get(repo.toLowerCase()) ?? new RepoView(exec, repo);
    repos.set(repo.toLowerCase(), view);
    const branch = view.defaultBranch();
    if (branch.kind !== 'found') {
      notChecked.push(`${t.id}: ${branch.kind === 'unknown' ? branch.why : 'no default branch'}`);
      continue;
    }
    checkOne(t, view, path, branch.stdout, { findings, notChecked, clean });
  }
  return { findings, notChecked, clean, retired };
}

function checkOne(
  t: Ticket,
  view: RepoView,
  path: string,
  branch: string,
  out: { findings: string[]; notChecked: string[]; clean: string[] },
): void {
  const where = `${view.repo}:${path}`;
  const onBranch = view.file(path, branch);
  if (onBranch.kind === 'unknown') {
    out.notChecked.push(`${t.id}: could not read ${where} on ${branch} (${onBranch.why})`);
    return;
  }
  if (t.status !== 'done') {
    if (onBranch.kind === 'found') out.clean.push(`${t.id}: ${where} resolves on ${branch}`);
    else out.findings.push(`${t.id} (${t.status}): ${where} does not exist on ${branch}`);
    return;
  }
  let ok = true;
  if (onBranch.kind === 'found') {
    out.findings.push(`${t.id} (${t.status}): finished spec ${where} is still on ${branch}; delete it and index its permalink`);
    ok = false;
  }
  const index = view.specIndex(branch);
  if (index.kind === 'unknown') {
    out.notChecked.push(`${t.id}: could not read ${view.repo}:${SPEC_INDEX_PATH} on ${branch} (${index.why})`);
    return;
  }
  if (index.kind === 'missing') {
    out.findings.push(`${t.id} (${t.status}): ${view.repo} has no ${SPEC_INDEX_PATH} on ${branch} to index ${path}`);
    return;
  }
  const shas = indexedCommits(index.stdout, view.repo, path);
  if (shas.length === 0) {
    out.findings.push(`${t.id} (${t.status}): ${path} has no permalink in ${view.repo}:${SPEC_INDEX_PATH}`);
    return;
  }
  for (const sha of shas) {
    const atSha = view.file(path, sha);
    if (atSha.kind === 'unknown') {
      out.notChecked.push(`${t.id}: could not read ${where} at ${sha} (${atSha.why})`);
      ok = false;
    } else if (atSha.kind === 'missing') {
      out.findings.push(`${t.id} (${t.status}): permalink ${sha} does not contain ${where}`);
      ok = false;
    }
  }
  if (ok) out.clean.push(`${t.id}: ${where} finished and indexed (${shas.join(', ')})`);
}

/** Could-not-check outranks findings: a partial scan under-reports, so it is never a verdict. */
export function specsExitCode(report: SpecProbeReport): number {
  if (report.notChecked.length > 0) return SPECS_EXIT.NOT_CHECKED;
  if (report.findings.length > 0) return SPECS_EXIT.FINDINGS;
  return SPECS_EXIT.CLEAN;
}

export function formatSpecReport(report: SpecProbeReport, ticketsDir: string, specCount: number): string {
  const lines = [`board: ${ticketsDir}`, `spec tickets: ${specCount}`];
  for (const f of report.findings) lines.push(`FINDING   ${f}`);
  for (const n of report.notChecked) lines.push(`NOT CHECKED ${n}`);
  for (const c of report.clean) lines.push(`ok        ${c}`);
  for (const r of report.retired) lines.push(`retired   ${r}`);
  const verdict = report.notChecked.length > 0
    ? 'could not check everything — not a clean result'
    : report.findings.length > 0 ? `${report.findings.length} finding(s)`
    : specCount === 0 ? 'nothing to check: no spec tickets on this board' : 'clean';
  lines.push(verdict);
  return lines.join('\n');
}
