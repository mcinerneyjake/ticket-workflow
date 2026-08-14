import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Did this module get executed directly, rather than imported?
 *
 * Realpath comparison is load-bearing, not defensive: the naive
 * `import.meta.url === pathToFileURL(process.argv[1]).href` is FALSE when the hook is reached
 * through a symlink, because Node realpaths the ESM entry point but not the argv string. A hook
 * that fails this check loads and exits 0 — which the hook protocol reads as ALLOW, so a guard
 * silently stops guarding. Measured on this package: piping a `git add -A` payload to a symlink of
 * guard-bash.mjs exited 0 in silence where direct execution exited 2 (tkt-93e9bc5595b4).
 *
 * That is not hypothetical for an installed copy — pnpm always symlinks `node_modules/<pkg>`, and
 * so does `npm link`, which is exactly the consumption path the subpath exports exist to enable.
 *
 * `realpath` is injectable so the failure branches are reachable from a test.
 */
export function isMain(moduleUrl, argv1 = process.argv[1], realpath = realpathSync) {
  if (!argv1) return false;
  try {
    return realpath(argv1) === realpath(new URL(moduleUrl));
  } catch {
    // Either path may be unresolvable (a deleted entry, a permission error). Fall back to the
    // literal comparison rather than guessing: a hook that cannot tell must not silently skip its
    // own body, and this branch still answers true for the ordinary direct-execution case.
    return moduleUrl === pathToFileURL(argv1).href;
  }
}
