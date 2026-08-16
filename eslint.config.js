import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Generated/build output — gitignored, but flat config does not read .gitignore, so every
  // generated dir `eslint .` could traverse must be listed. templates/ is DATA this package ships,
  // not code it runs; .claude/worktrees/ holds full second checkouts.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'templates/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Enforce the CLAUDE.md TypeScript conventions in lint, not just prose:
      // no `as` casts, no non-null `!`, no `any`. `as const` stays allowed.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
    },
  },
  {
    languageOptions: { globals: globals.node },
  },
);
