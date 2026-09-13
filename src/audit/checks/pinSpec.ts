import { isRecord } from '../types.js';

export const PACKAGE = 'ticket-workflow';

/** Declaring the package here means it must be installed for the repo to work. */
const REQUIRED_FIELDS = ['dependencies', 'devDependencies'] as const;
/** Declaring it only here does NOT imply an installed copy: absence is a legal state. */
const OPTIONAL_FIELDS = ['optionalDependencies', 'peerDependencies'] as const;

/**
 * Dependency maps ONLY. `bin` also keys this package's own name, and this repo audits itself with
 * `audit .` — reading `bin` as a pin would redden the package's own gate on every run.
 */
const DEP_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

export type DeclarationScan =
  /** No dependency map names the package: there is no pin, and nothing to check. */
  | { readonly kind: 'none' }
  /** Declared, but the declaration cannot be read as a spec. NEVER a pass: see the callers. */
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'found'; readonly spec: string; readonly installRequired: boolean };

/**
 * Every declaration site is collected, not just the first: two maps carrying disagreeing specs is a
 * real state, and stopping at the first hit reports agreement while a second pin says otherwise.
 * A present-but-unreadable value is `invalid` rather than absent — "declared as something I cannot
 * parse" and "not declared" are different answers, and only one of them is conformant.
 */
export function scanDeclarations(pkg: Record<string, unknown>): DeclarationScan {
  const found: { field: string; spec: string }[] = [];
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (!isRecord(map)) continue;
    if (!(PACKAGE in map)) continue;
    const spec = map[PACKAGE];
    if (typeof spec !== 'string') {
      return {
        kind: 'invalid',
        detail: `${PACKAGE} is declared in ${field} as ${spec === null ? 'null' : typeof spec} rather than a version spec, so the pin cannot be determined`,
      };
    }
    found.push({ field, spec });
  }
  const first = found[0];
  if (first === undefined) return { kind: 'none' };
  const distinct = [...new Set(found.map((f) => f.spec))];
  if (distinct.length > 1) {
    const sites = found.map((f) => `${f.field}=${JSON.stringify(f.spec)}`).join(', ');
    return { kind: 'invalid', detail: `${PACKAGE} is declared more than once with disagreeing specs (${sites})` };
  }
  return { kind: 'found', spec: first.spec, installRequired: found.some((f) => REQUIRED_FIELDS.some((r) => r === f.field)) };
}

export interface GitPin {
  readonly owner: string;
  readonly repo: string;
  /** Absent when the spec carries no `#fragment`, i.e. a branch pin. */
  readonly ref?: string;
}

/** The owner comes from the consumer's own spec: this package never names a consumer or an owner. */
export function parseGitPin(spec: string): GitPin | undefined {
  const m =
    /^(?:github:|git\+(?:https|ssh):\/\/(?:git@)?github\.com\/|https:\/\/github\.com\/)(?<owner>[^/#]+)\/(?<repo>[^/#]+?)(?:\.git)?(?:#(?<ref>.+))?$/.exec(
      spec,
    );
  if (!m?.groups) return undefined;
  const { owner, repo, ref } = m.groups;
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo, ref };
}

export type Semver = readonly [number, number, number];

export function parseVersionTag(tag: string): Semver | undefined {
  const m = /^v(?<maj>\d+)\.(?<min>\d+)\.(?<pat>\d+)$/.exec(tag);
  if (!m?.groups) return undefined;
  const { maj, min, pat } = m.groups;
  if (maj === undefined || min === undefined || pat === undefined) return undefined;
  return [Number(maj), Number(min), Number(pat)];
}

export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
