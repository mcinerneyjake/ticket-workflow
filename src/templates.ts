import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GuardrailTier = 'core' | 'node';

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
const MANIFEST: ReadonlyArray<{ source: string; targetPath: string; tier: GuardrailTier; executable?: true }> = [
  { source: 'core/CLAUDE.md', targetPath: 'CLAUDE.md', tier: 'core' },
  { source: 'core/gitignore', targetPath: '.gitignore', tier: 'core' },
  { source: 'core/github/workflows/ci.yml', targetPath: '.github/workflows/ci.yml', tier: 'core' },
  { source: 'core/github/workflows/pr-branch-name.yml', targetPath: '.github/workflows/pr-branch-name.yml', tier: 'core' },
  { source: 'core/github/dependabot.yml', targetPath: '.github/dependabot.yml', tier: 'core' },
  { source: 'core/claude/settings.json', targetPath: '.claude/settings.json', tier: 'core' },
  { source: 'core/claude/hooks/guard-bash.mjs', targetPath: '.claude/hooks/guard-bash.mjs', tier: 'core' },
  { source: 'node/husky/pre-commit', targetPath: '.husky/pre-commit', tier: 'node', executable: true },
  { source: 'node/eslint.config.js', targetPath: 'eslint.config.js', tier: 'node' },
  { source: 'node/tsconfig.json', targetPath: 'tsconfig.json', tier: 'node' },
  { source: 'node/vitest.config.ts', targetPath: 'vitest.config.ts', tier: 'node' },
  { source: 'node/nvmrc', targetPath: '.nvmrc', tier: 'node' },
];

// src/ and dist/ both sit one level below the package root, so ../templates resolves from either.
const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/**
 * The guardrail template set, read from the package's templates/ directory.
 * Fails loud: a manifest entry whose file is missing or empty throws rather
 * than returning a partial set — "could not read" must never look like a
 * smaller standard. `templatesDir` is a test seam.
 */
export function guardrailTemplates(templatesDir: string = DEFAULT_TEMPLATES_DIR): GuardrailTemplate[] {
  return MANIFEST.map(({ source, targetPath, tier, executable }) => {
    let contents: string;
    try {
      contents = readFileSync(path.join(templatesDir, source), 'utf8');
    } catch (err) {
      throw new Error(
        `guardrailTemplates: template "${source}" could not be read from ${templatesDir} — ` +
          `the package install is incomplete or the manifest is out of sync (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (contents.trim() === '') {
      throw new Error(`guardrailTemplates: template "${source}" is empty — refusing to scaffold a blank guardrail`);
    }
    return { source, targetPath, tier, contents, executable: executable === true };
  });
}
