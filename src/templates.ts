import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GuardrailTier = 'core' | 'node';

interface ManifestEntry {
  source: string;
  targetPath: string;
  tier: GuardrailTier;
  executable?: true;
}

/** Higher wins when two manifest entries target one path. A third tier slots in here, not into a
 *  hand-written comparison at the call site. */
const TIER_SPECIFICITY: Readonly<Record<GuardrailTier, number>> = { core: 0, node: 1 };


/**
 * Exactly one entry per targetPath, most specific tier winning. Exported for its own test: the
 * equal-specificity throw is unreachable through guardrailTemplates() while the real manifest is
 * correct, and a guard nothing can exercise is a guard nobody knows is broken.
 */
export function resolveManifest(entries: ReadonlyArray<ManifestEntry>): Map<string, ManifestEntry> {
  const byTarget = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const held = byTarget.get(entry.targetPath);
    if (held === undefined) {
      byTarget.set(entry.targetPath, entry);
      continue;
    }
    // Equal specificity is a manifest BUG, not a precedence question — silently keeping the first
    // would let a copy-paste duplicate ship, and would also make the suite's unique-targetPath
    // assertion unfalsifiable, since dedupe would guarantee what it tries to check.
    if (TIER_SPECIFICITY[entry.tier] === TIER_SPECIFICITY[held.tier]) {
      throw new Error(
        `guardrailTemplates: manifest has two "${entry.tier}"-tier entries for "${entry.targetPath}" ` +
          `("${held.source}" and "${entry.source}") — one target, one entry per tier`,
      );
    }
    if (TIER_SPECIFICITY[entry.tier] > TIER_SPECIFICITY[held.tier]) byTarget.set(entry.targetPath, entry);
  }
  return byTarget;
}

export interface GuardrailTemplate {
  /** Path of the source file inside the package's templates/ directory. */
  source: string;
  /** Path the file lands at in a scaffolded repo, relative to its root. */
  targetPath: string;
  tier: GuardrailTier;
  contents: string;
  /**
   * Must be written with the execute bit set. Git silently IGNORES a non-executable
   * .husky/pre-commit ("hook was ignored because it's not set as executable") — the local gate
   * never runs, a guard failing open. A scaffolder that drops this flag ships that failure.
   */
  executable: boolean;
}

// Explicit manifest, not a directory walk: source names are npm-safe (npm strips dotfiles like
// .gitignore from published packages), and only the manifest defines what a template targets —
// a stray file under templates/ is never silently shipped.
//
// Contract the templates assume but do not supply (recorded for `init`, which owns it): the target
// repo's package.json must declare the gate scripts (typecheck, lint, test, test:coverage, build,
// prepare: husky), the devDeps they need (typescript, eslint + typescript-eslint + @eslint/js +
// globals, vitest + @vitest/coverage-v8, husky), and a ticket-workflow dependency — the guard-bash
// launcher imports 'ticket-workflow/hooks/guard-bash.mjs' and fails CLOSED without it.
const MANIFEST: ReadonlyArray<ManifestEntry> = [
  { source: 'core/CLAUDE.md', targetPath: 'CLAUDE.md', tier: 'core' },
  { source: 'core/gitignore', targetPath: '.gitignore', tier: 'core' },
  { source: 'core/github/workflows/ci.yml', targetPath: '.github/workflows/ci.yml', tier: 'core' },
  { source: 'core/github/workflows/pr-branch-name.yml', targetPath: '.github/workflows/pr-branch-name.yml', tier: 'core' },
  { source: 'core/github/dependabot.yml', targetPath: '.github/dependabot.yml', tier: 'core' },
  { source: 'core/claude/settings.json', targetPath: '.claude/settings.json', tier: 'core' },
  { source: 'core/claude/hooks/guard-bash.mjs', targetPath: '.claude/hooks/guard-bash.mjs', tier: 'core' },
  // Same targetPath as the core launcher above, one per tier: core repos have no package.json, so
  // their launcher needs a machine-local fallback the node tier must NOT have — a node repo that
  // silently ran an unpinned machine install would lose the versioned pin that is the point of it.
  { source: 'node/claude/hooks/guard-bash.mjs', targetPath: '.claude/hooks/guard-bash.mjs', tier: 'node' },
  { source: 'node/husky/pre-commit', targetPath: '.husky/pre-commit', tier: 'node', executable: true },
  { source: 'node/eslint.config.js', targetPath: 'eslint.config.js', tier: 'node' },
  { source: 'node/tsconfig.json', targetPath: 'tsconfig.json', tier: 'node' },
  { source: 'node/vitest.config.ts', targetPath: 'vitest.config.ts', tier: 'node' },
  { source: 'node/nvmrc', targetPath: '.nvmrc', tier: 'node' },
];

// src/ and dist/ both sit one level below the package root, so ../templates resolves from either.
const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** One place for tier subsumption, shared by audit's check set and init's scaffold set — two
 *  hand-copied predicates drift the moment a third tier appears. */
export function tierIncludes(repoTier: GuardrailTier, itemTier: GuardrailTier): boolean {
  return repoTier === 'node' || itemTier === 'core';
}

/**
 * The guardrail template set, read from the package's templates/ directory.
 * Fails loud: a manifest entry whose file is missing or empty throws rather
 * than returning a partial set — "could not read" must never look like a
 * smaller standard. Filtering happens BEFORE the reads, so a core-tier caller
 * is never wedged by a broken node template it would not write.
 * `templatesDir` is a test seam.
 */
function readTemplate(templatesDir: string, source: string): string {
  let contents: string;
  try {
    contents = readFileSync(path.join(templatesDir, source), 'utf8');
  } catch (err) {
    throw new Error(
      `guardrailTemplates: template "${source}" could not be read from ${templatesDir} — ` +
        `the package install is incomplete or the manifest is out of sync (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (contents.trim() === '') {
    throw new Error(`guardrailTemplates: template "${source}" is empty — refusing to scaffold a blank guardrail`);
  }
  return contents;
}

export function guardrailTemplates(templatesDir: string = DEFAULT_TEMPLATES_DIR, tier?: GuardrailTier): GuardrailTemplate[] {
  const selected = tier === undefined ? MANIFEST : MANIFEST.filter((m) => tierIncludes(tier, m.tier));
  const byTarget = resolveManifest(selected);
  const shadowed = selected.filter((m) => byTarget.get(m.targetPath) !== m);
  for (const { source } of shadowed) readTemplate(templatesDir, source);
  return [...byTarget.values()].map(({ source, targetPath, tier, executable }) => {
    const contents = readTemplate(templatesDir, source);
    return { source, targetPath, tier, contents, executable: executable === true };
  });
}
