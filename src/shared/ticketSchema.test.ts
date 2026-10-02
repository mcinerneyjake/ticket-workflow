import { describe, it, expect } from 'vitest';
import { isAutonomy, isSpecRef, readAutonomy } from './constants.js';

describe('isAutonomy', () => {
  it('accepts exactly hitl and afk', () => {
    expect(isAutonomy('hitl')).toBe(true);
    expect(isAutonomy('afk')).toBe(true);
  });

  it('rejects case variants, near-misses and empty', () => {
    for (const bad of ['AFK', 'Afk', 'HITL', 'akf', 'afk ', '', 'auto']) expect(isAutonomy(bad)).toBe(false);
  });
});

describe('readAutonomy (fail-closed read)', () => {
  it('reads afk only from the exact string', () => {
    expect(readAutonomy('afk')).toBe('afk');
  });

  it('reads every other value as hitl', () => {
    for (const v of [undefined, null, '', 'AFK', 'garbage', true, 1, ['afk'], { afk: true }]) {
      expect(readAutonomy(v)).toBe('hitl');
    }
  });
});

describe('isSpecRef', () => {
  it('accepts owner/repo:path to a markdown file', () => {
    for (const ok of [
      'mcinerneyjake/ticket-workflow:docs/specs/workflow-rewrite.md',
      'o/r:spec.md',
      'some-org/repo.name_2:a/b-c/d_e.f.md',
    ]) expect(isSpecRef(ok)).toBe(true);
  });

  it('rejects shapes the probe could not resolve on main', () => {
    for (const bad of [
      'docs/specs/x.md', // no owner/repo
      'ticket-workflow:docs/x.md', // no owner
      'o/r:docs/x.txt', // not markdown
      'o/r:docs/x.md/', // trailing slash
      'o/r:/docs/x.md', // absolute path
      'o/r:docs/../x.md', // traversal
      'o/r:./x.md', // dot segment
      'o/..:x.md', // dot-dot repo
      'o/.:x.md', // dot repo
      'o/r:docs//x.md', // empty segment
      'o/r:docs/my spec.md', // whitespace
      'o/r:docs/x.md\n', // trailing newline
      'o/r:docs/x\0.md', // NUL
      'https://github.com/o/r/blob/main/x.md', // a URL
      'o/r:docs/x.md:extra', // second colon
      '--upload-pack/r:x.md', // owner read as a git flag
      '-o/r:x.md', // leading-hyphen owner
      'o/-r:x.md', // leading-hyphen repo
      'o/r:-x.md', // leading-hyphen path
      'o/r:docs/-rf/x.md', // leading-hyphen inner segment
      'o/r:docs/X.MD', // extension is case-sensitive
      'o/r:.md', // no file name
      '', // empty
    ]) expect(isSpecRef(bad), JSON.stringify(bad)).toBe(false);
  });
});
