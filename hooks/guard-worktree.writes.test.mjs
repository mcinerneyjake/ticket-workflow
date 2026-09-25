import { describe, it, expect, beforeAll } from 'vitest';
import { decide } from './guard-worktree.mjs';
import { buildFixtures, realKind, SID, TICKET } from '../src/test-support/guardWorktreeFixtures.mjs';

// guard-worktree's NON-GIT write rules (tkt-12cbf1b396aa), in a file of their own: appended to
// guard-worktree.test.mjs they pushed that file's first process spawn past testTimeout.

let fx;
beforeAll(() => {
  fx = buildFixtures();
});

const running = (command, cwd) => ({ session_id: SID, tool_name: 'Bash', tool_input: { command }, cwd });
const verdict = (payload) => decide(payload, { ticket: TICKET, kindOf: realKind });

describe('bash: non-git writes judged by where they land (tkt-12cbf1b396aa)', () => {
  const into = (rest) => () => `cd ${fx.primary} && ${rest}`;

  it.each([
    ['sed -i', into("sed -i '' s/v1/v2/ tracked.txt")],
    ['sed with an attached in-place suffix', into('sed -Ei.bak s/v1/v2/ tracked.txt')],
    ['perl -pi', into("perl -pi -e 's/v1/v2/' tracked.txt")],
    ['a truncating redirect', into('echo x > tracked.txt')],
    ['an appending redirect', into('echo x >> tracked.txt')],
    ['a redirect fused to its word', into('echo x >tracked.txt')],
    ['an fd-prefixed redirect to a file', into('node run.js 2>err.log')],
    ['an &> redirect', into('node run.js &> out.log')],
    ['a clobbering redirect', into('echo x >| tracked.txt')],
    ['a heredoc into a file', into('cat > new.txt <<EOF\nx\nEOF')],
    ['tee', into('echo x | tee new.txt')],
    ['rm', into('rm tracked.txt')],
    ['mv', into('mv tracked.txt moved.txt')],
    ['cp into the primary', into('cp /etc/hosts copied.txt')],
    ['touch', into('touch new.txt')],
    ['mkdir', into('mkdir -p newdir/sub')],
    ['npm install', into('npm install')],
    ['npm ci', into('npm ci')],
    ['npm install behind --prefix naming the primary', () => `npm --prefix ${fx.primary} install left-pad`],
    ['bare yarn, which installs', into('yarn')],
    ['a writer behind a wrapper', into('echo tracked.txt | xargs rm')],
    ['a writer in a then-branch', into('if true; then touch new.txt; fi')],
    ['a writer after a pushd', () => `pushd ${fx.primary}; touch new.txt`],
    ['an absolute redirect into the primary, no cd', () => `echo x > ${fx.primary}/tracked.txt`],
    ['an absolute rm into the primary, no cd', () => `rm ${fx.primary}/tracked.txt`],
    ['a redirect into an ignored dir of the primary', () => `echo x > ${fx.primary}/ignored/note.txt`],
    ['a relative write after an unresolvable cd', () => 'cd $TARGET && touch new.txt'],
    ['a redirect to a variable after a cd into the primary', into('echo x > "$OUT"')],
    ['a git read whose output is redirected into the primary', into('git log > log.txt')],
  ])('blocks from a linked worktree: %s', (_label, command) => {
    expect(verdict(running(command(), fx.linked)).blocked).toBe(true);
  });

  it.each([
    ['cat', into('cat tracked.txt')],
    ['ls', into('ls -la')],
    ['grep', into('grep -n v1 tracked.txt')],
    ['git status', into('git status')],
    ['npm run', into('npm run build')],
    ['sed without -i', into("sed -n '1p' tracked.txt")],
    ['stderr to /dev/null', into('ls nope 2>/dev/null')],
    ['an fd duplication', into('ls 2>&1')],
    ['a quoted >', into('echo ">" tracked.txt')],
    ['a [[ ]] string comparison', into('[[ a > b ]] && echo y')],
    ['an input redirect', into('wc -l < tracked.txt')],
    ['a cp OUT of the primary into the worktree', () => `cp ${fx.primary}/tracked.txt ${fx.linked}/copy.txt`],
    ['tee with no file, which only passes data through', into('echo x | tee')],
    ['perl whose attached -I/-M argument contains an i', into('perl -Ilib -MList::Util -ne print tracked.txt')],
  ])('allows read-only work after a cd into the primary: %s', (_label, command) => {
    expect(verdict(running(command(), fx.linked)).blocked).toBe(false);
  });

  it.each([
    ['sed -i', "sed -i '' s/v1/v2/ tracked.txt"],
    ['a redirect', 'echo x > tracked.txt'],
    ['a heredoc', 'cat > new.txt <<EOF\nx\nEOF'],
    ['rm', 'rm tracked.txt'],
    ['npm install', 'npm install'],
    ['a redirect to a variable', 'echo x > "$OUT"'],
  ])('allows the same write inside a linked worktree: %s', (_label, command) => {
    // Without these, the block cases above would also pass if the guard refused every writer.
    expect(verdict(running(command, fx.linked)).blocked).toBe(false);
  });

  it.each([
    ['a directory that is no repo', () => `cd ${fx.plain} && touch new.txt`],
    ['/dev/null', into('echo x > /dev/null')],
    ['a nested worktree inside the primary', () => `cd ${fx.nested} && echo x > tracked.txt`],
  ])('allows a write that lands outside the primary: %s', (_label, command) => {
    expect(verdict(running(command(), fx.linked)).blocked).toBe(false);
  });

  it('blocks a relative write when the session itself sits in the primary', () => {
    // The Edit rule already refuses the primary from any cwd; a redirect is the same write.
    expect(verdict(running('echo x > tracked.txt', fx.primary)).blocked).toBe(true);
  });

  it('restores the directory when a subshell closes', () => {
    const cmd = `(cd ${fx.primary} && ls) && echo x > tracked.txt`;
    expect(verdict(running(cmd, fx.linked)).blocked).toBe(false);
  });

  it('does not read an escaped > before a pipe as a clobber that hides the next command', () => {
    // From a worktree, so the fused token's accidental "redirect to ./git" lands somewhere allowed.
    expect(verdict(running(`echo \\>|git -C ${fx.primary} checkout -- .`, fx.linked)).blocked).toBe(true);
  });

  describe('review round 1', () => {
    it.each([
      ['a cp whose destination is followed by 2>/dev/null', () => `cp /etc/hosts ${fx.primary}/x 2>/dev/null`],
      ['a cp whose destination is followed by > /dev/null', () => `cp /etc/hosts ${fx.primary}/x > /dev/null`],
      ['an ln whose destination is followed by 2>&1', () => `ln -s /etc/hosts ${fx.primary}/l 2>&1`],
      ['a quoted arithmetic expansion before a redirect', into('echo "$((1+2))" > tracked.txt')],
      ['a spaced quoted arithmetic expansion before a redirect', into('echo "$(( 1 + 2 ))" > tracked.txt')],
      ['a [[ used as an argument before a redirect', into('echo [[ > tracked.txt')],
      ['an absolute glob in the primary', () => `rm -rf ${fx.primary}/*.txt`],
      ['an absolute path with a variable leaf in the primary', () => `echo x > ${fx.primary}/$NAME`],
      ['npm install with --prefix after the subcommand', () => `npm install --prefix ${fx.primary}`],
      ['bun install with --cwd after the subcommand', () => `bun install --cwd ${fx.primary}`],
      ['npm with a value-taking flag before install', into('npm --loglevel warn install')],
      ['pnpm --filter before add', into('pnpm --filter x add y')],
      ['npm version', into('npm version patch')],
      ['npm pkg set', into('npm pkg set name=x')],
      ['a path-qualified writer', into('/bin/rm tracked.txt')],
      ['a backslash-escaped writer', into('\\rm tracked.txt')],
      ['a quoted writer name', into('"rm" tracked.txt')],
      ['a writer after a leading redirect', () => `2>/dev/null rm ${fx.primary}/tracked.txt`],
      ['a dangling symlink into the primary', () => 'echo x > dangling-into-primary'],
      ['perl -0pi', into('perl -0pi -e s/a/b/ tracked.txt')],
      ['a cd whose own redirect lands in the primary', () => `cd /tmp 2> ${fx.primary}/err.log`],
      ['a pushd whose own redirect lands in the primary', () => `pushd /tmp > ${fx.primary}/log.txt`],
    ])('blocks from a linked worktree: %s', (_label, command) => {
      expect(verdict(running(command(), fx.linked)).blocked).toBe(true);
    });

    it.each([
      ['chmod whose mode reads like a relative path', () => `chmod +x ${fx.linked}/f`],
      ['truncate -s 0', () => `truncate -s 0 ${fx.linked}/f`],
      ['mkdir -m 755', () => `mkdir -m 755 ${fx.linked}/d`],
      ['sed -i whose script reads like a relative path', () => `sed -i 's/a/b/' ${fx.linked}/f`],
      ['perl -pi -e', () => `perl -pi -e 's/a/b/' ${fx.linked}/f`],
      ['npm install --dry-run', () => 'npm install --dry-run'],
      ['yarn --version', () => 'yarn --version'],
    ])('allows a write aimed at the worktree from a session sitting in the primary: %s', (_label, command) => {
      expect(verdict(running(command(), fx.primary)).blocked).toBe(false);
    });
  });

  describe('review round 2', () => {
    const P = () => fx.primary;
    it.each([
      ['rm fed by xargs from a find in the primary', () => `find ${P()} -name x | xargs rm`],
      ['sed -i fed by xargs from a grep of the primary', () => `grep -rl v1 ${P()} | xargs sed -i s/v1/v2/`],
      ['tee behind |&', () => `make |& tee ${P()}/build.log`],
      ['a leading redirect before a cd', () => `2>/dev/null cd ${P()} && touch new.txt`],
      ['a redirect fused to a cd operand', () => `cd ${P()}>/dev/null && touch new.txt`],
      ['a leading redirect before git', () => `2>/dev/null git -C ${P()} checkout -- .`],
      ['chmod with a dash-led mode', () => `chmod -x ${P()}/tracked.txt`],
      ['a second redirect fused into one token', () => `ls 2>/dev/null>${P()}/t`],
      ['an output redirect fused after an input one', () => `sort <in>${P()}/t`],
      ["a quoted '$((' before a redirect", () => `grep -n '$((' f > ${P()}/t`],
      ['BSD sed -I', () => `sed -I '' s/a/b/ ${P()}/tracked.txt`],
      ['npm r', into('npm r left-pad')],
      ['npm audit fix', into('npm audit fix')],
    ])('blocks from a linked worktree: %s', (_label, command) => {
      expect(verdict(running(command(), fx.linked)).blocked).toBe(true);
    });

    it('blocks an install in a worktree whose node_modules links into its primary', () => {
      expect(verdict(running('npm ci', fx.foreignWt)).blocked).toBe(true);
    });

    it('still judges a heredoc body that has no terminator', () => {
      expect(verdict(running('cat <<EOF\necho x > t', fx.primary)).blocked).toBe(true);
    });

    it.each([
      ["BSD sed -i ''", () => `sed -i '' 's/a/b/' ${fx.linked}/f`],
      ["BSD sed -i '' -e", () => `sed -i '' -e 's/a/b/' ${fx.linked}/f`],
      ['perl -i -pe', () => `perl -i -pe 's/a/b/' ${fx.linked}/f`],
      ['perl -pi -we', () => `perl -pi -we 's/a/b/' ${fx.linked}/f`],
      ['a global npm install', () => 'npm i -g left-pad'],
      ['a bare npm version, which only prints', () => 'npm version'],
    ])('allows from a session sitting in the primary: %s', (_label, command) => {
      expect(verdict(running(command(), fx.primary)).blocked).toBe(false);
    });

    it.each([
      ['rm of the node_modules link itself', () => 'rm -rf node_modules', () => fx.foreignWt],
      ['ln -sfn replacing the node_modules link', () => `ln -sfn ${fx.foreign}/node_modules node_modules`, () => fx.foreignWt],
      ['rm of a link into the primary', () => 'rm link-to-primary.txt', () => fx.linked],
      ['unlink of a dangling link into the primary', () => 'unlink dangling-into-primary', () => fx.linked],
      ['ln -s with one operand, which links in the cwd', () => `ln -s ${fx.primary}/tracked.txt`, () => fx.linked],
    ])('allows an operation on the link, not its target: %s', (_label, command, cwd) => {
      expect(verdict(running(command(), cwd())).blocked).toBe(false);
    });
  });

  describe('review round 3', () => {
    const P = () => fx.primary;
    it.each([
      // Blocked on origin/main, where heredoc bodies were judged line by line; a body fed to a
      // shell is the code that runs, so it must never be skipped as data.
      ['git inside a bash heredoc', () => `bash <<'EOF'\ngit -C ${P()} checkout -- .\nEOF`],
      ['git inside a heredoc piped to sh', () => `cat <<'EOF' | sh\ngit -C ${P()} checkout -- .\nEOF`],
      ['git after a here-string whose word looks like a delimiter', () => `cat <<<EOF\ngit -C ${P()} checkout -- .\nEOF`],
      ['git after a comment holding a heredoc marker', () => `echo hi # <<EOF\ngit -C ${P()} checkout -- .\nEOF`],
      ['git after an arithmetic shift', () => `echo $((1<<2))\ngit -C ${P()} checkout -- .\n2`],
    ])('blocks from a linked worktree, as origin/main does: %s', (_label, command) => {
      expect(verdict(running(command(), fx.linked)).blocked).toBe(true);
    });

    it.each([
      ['rm -rf of the node_modules link with a trailing slash', () => 'rm -rf node_modules/'],
      ['ln -s onto a link to a directory in the primary', () => 'ln -s /etc/hosts node_modules'],
      ['mv onto a link to a directory in the primary', () => 'mv foo.txt node_modules'],
      ['npm install behind an unknown value flag', () => `cd ${fx.foreign} && npm -w pkg install`],
      ['yarn workspace add', () => `cd ${fx.foreign} && yarn workspace pkg add left-pad`],
      ['xargs -I{} rm fed from the primary', () => `find ${fx.foreign} -name tracked.txt | xargs -I{} rm {}`],
    ])('blocks from a worktree whose node_modules links into its primary: %s', (_label, command) => {
      expect(verdict(running(command(), fx.foreignWt)).blocked).toBe(true);
    });

    it.each([
      ['ln -sfn, which replaces the link itself', () => `ln -sfn ${fx.foreign}/node_modules node_modules`],
      ['mv of the link itself to a new name', () => 'mv node_modules nm-old'],
    ])('still allows an operation on the link: %s', (_label, command) => {
      expect(verdict(running(command(), fx.foreignWt)).blocked).toBe(false);
    });
  });

  it('blocks a symlink in the worktree whose target is in the primary', () => {
    expect(verdict(running('echo x > link-to-primary.txt', fx.linked)).blocked).toBe(true);
  });

  describe('review round 4', () => {
    it.each([
      ['a redirect through a relative dangling link reached via node_modules', () => 'echo x > node_modules/.bin/dl', () => fx.foreignWt],
      ['a redirect to a dangling link that sits in the primary', () => `echo x > ${fx.primary}/dang-out`, () => fx.linked],
    ])('blocks: %s', (_label, command, cwd) => {
      expect(verdict(running(command(), cwd())).blocked).toBe(true);
    });

    it.each([
      ['npm test with a trailing arg that names a write verb', () => 'npm test -- -t install'],
      ['npm run ci', () => 'npm run ci'],
      ['npm run agent with unquoted words', () => 'npm run agent -- --yes --create-only fix install'],
      ['yarn test add', () => 'yarn test add'],
      ['pnpm test update', () => 'pnpm test update'],
      ['a redirect under $TMPDIR', () => 'echo x > "$TMPDIR/out.json"'],
      ['a redirect under $HOME', () => 'node x.mjs > $HOME/x.json 2>&1'],
      ['tee under ${TMPDIR}', () => 'node x.mjs | tee "${TMPDIR}/log"'],
    ])('allows from a session sitting in the primary: %s', (_label, command) => {
      expect(verdict(running(command(), fx.primary)).blocked).toBe(false);
    });

    it('does not trust $TMPDIR once the command reassigns it', () => {
      expect(verdict(running(`TMPDIR=${fx.primary}; echo x > "$TMPDIR/f"`, fx.primary)).blocked).toBe(true);
    });
  });
});
