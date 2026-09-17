// tkt-7aa8670dc01e, after copart-filter's tkt-d3fcab071387. Run as `prepare`. Git skips a missing
// `core.hooksPath` SILENTLY and husky's `.husky/_` is generated + self-ignored, so a linked worktree
// committed with no gate. Pointing git at the TRACKED `.husky` closes that. Husky's binary is not
// run: it rewrites the path back to `.husky/_` every time.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

const skip = (reason) => {
  console.log(`install-hooks: skipped — ${reason}`);
  process.exit(0);
};

if (process.env.HUSKY === '0') skip('HUSKY=0');

// `.git` at the cwd, not `rev-parse`: that walks upward, and a package dir nested in another repo
// would repoint THAT repo's hooks. No `.git` is also a tarball or Docker context — nothing to arm.
if (!existsSync('.git')) skip('not a git checkout root');

// An inherited GIT_DIR (npm run from inside a hook) would redirect the write to another repo.
const env = { ...process.env };
for (const v of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) delete env[v];
const git = (args) => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

// From here every failure throws: a `.git` we cannot configure is a gate that did not install.
const toplevel = git(['rev-parse', '--show-toplevel']);
if (realpathSync(toplevel) !== realpathSync(process.cwd())) {
  throw new Error(`install-hooks: .git here resolves to ${toplevel}; refusing to configure another repo`);
}
git(['config', 'core.hooksPath', '.husky']);
const written = git(['config', '--get', 'core.hooksPath']);
if (written !== '.husky') throw new Error(`install-hooks: core.hooksPath reads ${written}, not .husky`);
console.log('install-hooks: core.hooksPath = .husky');
