import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardrailTemplates, SKILLS_DIR } from '../../templates.js';
import { AUDIT_CHECKS, auditExitCode, runOneCheck } from '../run.js';
import { lineCount, SKILL_LINE_CAP } from './skills.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const vendored = (): ReturnType<typeof guardrailTemplates> => guardrailTemplates(undefined, 'core').filter((t) => t.targetPath.startsWith(`${SKILLS_DIR}/`));

function repoWithSkills(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-skills-'));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, '.ticket-workflow.json'), JSON.stringify({ tier: 'core', exempt: {} }));
  for (const t of vendored()) {
    mkdirSync(path.dirname(path.join(dir, t.targetPath)), { recursive: true });
    writeFileSync(path.join(dir, t.targetPath), t.contents);
  }
  return dir;
}

function check(dir: string, id: string): { status: string; detail: string } {
  const r = runOneCheck(dir, id);
  if (!r) throw new Error(`${id} not applicable`);
  return r;
}

function ownSkill(dir: string, name: string, lines: number): void {
  mkdirSync(path.join(dir, SKILLS_DIR, name), { recursive: true });
  writeFileSync(path.join(dir, SKILLS_DIR, name, 'SKILL.md'), 'x\n'.repeat(lines));
}

describe('skills-current', () => {
  it('passes when every vendored file is present and byte-equal', () => {
    expect(check(repoWithSkills(), 'skills-current').status).toBe('pass');
  });

  it('fails, naming the file, when one referenced file is missing', () => {
    const dir = repoWithSkills();
    rmSync(path.join(dir, SKILLS_DIR, 'tdd', 'mocking.md'));
    const r = check(dir, 'skills-current');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`missing: ${SKILLS_DIR}/tdd/mocking.md`);
  });

  it('fails on a repo with no skills at all', () => {
    const dir = repoWithSkills();
    rmSync(path.join(dir, SKILLS_DIR), { recursive: true });
    expect(check(dir, 'skills-current').status).toBe('fail');
  });

  it('fails as drifted when a copy is edited', () => {
    const dir = repoWithSkills();
    appendFileSync(path.join(dir, SKILLS_DIR, 'standards-and-spec-review', 'SKILL.md'), 'local tweak\n');
    const r = check(dir, 'skills-current');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`drifted: ${SKILLS_DIR}/standards-and-spec-review/SKILL.md`);
    expect(r.detail, 'init --force would overwrite every other scaffolded file').not.toContain('init --force');
  });

  it('fails when a skill LICENSE loses its notice — the notice travels with every copy', () => {
    const dir = repoWithSkills();
    writeFileSync(path.join(dir, SKILLS_DIR, 'grilling', 'LICENSE'), 'MIT\n');
    expect(check(dir, 'skills-current').detail).toContain(`${SKILLS_DIR}/grilling/LICENSE`);
  });

  it('BLOCKS rather than passing when a vendored path cannot be read', () => {
    const dir = repoWithSkills();
    const target = path.join(dir, SKILLS_DIR, 'handoff', 'SKILL.md');
    rmSync(target);
    mkdirSync(target);
    expect(check(dir, 'skills-current').status).toBe('blocked');
  });

  it('points a drifted workflow skill at its own source, never at the vendored LICENSE', () => {
    const dir = repoWithSkills();
    appendFileSync(path.join(dir, SKILLS_DIR, 'implement', 'SKILL.md'), 'local tweak\n');
    const r = check(dir, 'skills-current');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`drifted: ${SKILLS_DIR}/implement/SKILL.md`);
    expect(r.detail).toContain(`${SKILLS_DIR}/implement/SKILL.md ← templates/workflow-skills/implement/SKILL.md`);
    expect(r.detail).not.toContain('LICENSE');
  });

  it('points a drifted vendored LICENSE at the one shared notice it was copied from', () => {
    const dir = repoWithSkills();
    writeFileSync(path.join(dir, SKILLS_DIR, 'grilling', 'LICENSE'), 'MIT\n');
    expect(check(dir, 'skills-current').detail).toContain(`${SKILLS_DIR}/grilling/LICENSE ← templates/skills/LICENSE`);
  });

  it("ignores a consumer's own skills beside the vendored ones", () => {
    const dir = repoWithSkills();
    ownSkill(dir, 'house-style', 10);
    expect(check(dir, 'skills-current').status).toBe('pass');
  });
});

describe('skill-line-cap', () => {
  it('passes the vendored set', () => {
    const r = check(repoWithSkills(), 'skill-line-cap');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain(`${new Set(vendored().map((t) => t.targetPath.split('/')[2])).size} SKILL.md`);
  });

  it(`passes at exactly ${SKILL_LINE_CAP} lines and fails at ${SKILL_LINE_CAP + 1}, naming the skill`, () => {
    const dir = repoWithSkills();
    ownSkill(dir, 'at-cap', SKILL_LINE_CAP);
    expect(check(dir, 'skill-line-cap').status).toBe('pass');
    ownSkill(dir, 'workflow', SKILL_LINE_CAP + 1);
    const r = check(dir, 'skill-line-cap');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(`workflow (${SKILL_LINE_CAP + 1})`);
    expect(r.detail).not.toContain('at-cap');
  });

  it('measures a symlinked skill directory', () => {
    const dir = repoWithSkills();
    const outside = mkdtempSync(path.join(tmpdir(), 'tw-skills-linked-'));
    tempDirs.push(outside);
    writeFileSync(path.join(outside, 'SKILL.md'), 'x\n'.repeat(SKILL_LINE_CAP + 5));
    symlinkSync(outside, path.join(dir, SKILLS_DIR, 'linked'));
    expect(check(dir, 'skill-line-cap').detail).toContain(`linked (${SKILL_LINE_CAP + 5})`);
  });

  it('skips a stray file and a directory with no SKILL.md', () => {
    const dir = repoWithSkills();
    writeFileSync(path.join(dir, SKILLS_DIR, 'README.md'), 'x\n'.repeat(500));
    mkdirSync(path.join(dir, SKILLS_DIR, 'empty'));
    expect(check(dir, 'skill-line-cap').status).toBe('pass');
  });

  it('passes a repo with no skills directory', () => {
    const dir = repoWithSkills();
    rmSync(path.join(dir, SKILLS_DIR), { recursive: true });
    expect(check(dir, 'skill-line-cap').status).toBe('pass');
  });

  it('BLOCKS rather than passing when a listed entry cannot be stat-ed (listable, not searchable)', () => {
    const dir = repoWithSkills();
    ownSkill(dir, 'big', SKILL_LINE_CAP + 80);
    const skills = path.join(dir, SKILLS_DIR);
    chmodSync(skills, 0o444);
    try {
      const r = check(dir, 'skill-line-cap');
      expect(r.status, r.detail).toBe('blocked');
    } finally {
      chmodSync(skills, 0o755);
    }
  });

  it('control: a dangling symlinked skill is skipped, not BLOCKED', () => {
    const dir = repoWithSkills();
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, SKILLS_DIR, 'dangling'));
    expect(check(dir, 'skill-line-cap').status).toBe('pass');
  });

  it('BLOCKS when the skills path cannot be listed', () => {
    const dir = repoWithSkills();
    rmSync(path.join(dir, SKILLS_DIR), { recursive: true });
    writeFileSync(path.join(dir, SKILLS_DIR), 'not a directory');
    expect(check(dir, 'skill-line-cap').status).toBe('blocked');
  });
});

describe('lineCount', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\n\n', 2],
  ])('%j → %i', (text, n) => {
    expect(lineCount(text)).toBe(n);
  });
});

describe('both skill checks are advisory', () => {
  it('a FAIL from either never moves the audit exit code', () => {
    for (const id of ['skills-current', 'skill-line-cap']) {
      const c = AUDIT_CHECKS.find((x) => x.id === id);
      expect(c?.advisory, id).toBe(true);
    }
    const dir = repoWithSkills();
    rmSync(path.join(dir, SKILLS_DIR, 'tdd', 'SKILL.md'));
    ownSkill(dir, 'big', SKILL_LINE_CAP + 1);
    const results = ['skills-current', 'skill-line-cap'].map((id) => runOneCheck(dir, id)).filter((r) => r !== undefined);
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail']);
    expect(auditExitCode({ repoDir: dir, tier: 'core', tierDeclared: true, results })).toBe(0);
  });
});
