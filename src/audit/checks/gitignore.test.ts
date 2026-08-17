import { describe, expect, it } from 'vitest';
import { ignoresWorktrees } from './gitignore.js';

describe('ignoresWorktrees', () => {
  it('accepts the exact entry', () => {
    expect(ignoresWorktrees('node_modules/\n.claude/worktrees/\n')).toBe(true);
  });

  it('accepts it without the trailing slash, and with a leading one', () => {
    expect(ignoresWorktrees('.claude/worktrees\n')).toBe(true);
    expect(ignoresWorktrees('/.claude/worktrees/\n')).toBe(true);
  });

  it('accepts ignoring all of .claude/, which is STRICTER and so also satisfies the intent', () => {
    // A check that fails a repo for doing more than asked is one people learn to work around.
    expect(ignoresWorktrees('.claude/\n')).toBe(true);
  });

  it('rejects a file that only MENTIONS it in a comment', () => {
    // The failure a substring match would have: prose about worktrees is not an ignore rule.
    expect(ignoresWorktrees('# remember to ignore .claude/worktrees/ one day\nnode_modules/\n')).toBe(false);
  });

  it('rejects a non-empty file that does not ignore it at all', () => {
    expect(ignoresWorktrees('node_modules/\ndist/\n')).toBe(false);
  });
});
