import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { guardrailTemplates, SKILLS_DIR } from '../../templates.js';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

export const SKILL_LINE_CAP = 120;

export function lineCount(contents: string): number {
  if (contents === '') return 0;
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}

export const skillsCurrent: AuditCheck = {
  id: 'skills-current',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    // Never empty: skillManifest throws on an empty set, which the audit's crash wrapper reports BLOCKED.
    const shipped = guardrailTemplates(undefined, 'core').filter((t) => t.targetPath.startsWith(`${SKILLS_DIR}/`));
    const missing: string[] = [];
    const drifted: string[] = [];
    const restore: string[] = [];
    for (const t of shipped) {
      const file = ctx.read(t.targetPath);
      if (file.kind === 'error') return makeResult(this, 'blocked', `${t.targetPath} could not be read: ${file.message}`);
      if (file.kind === 'missing') missing.push(t.targetPath);
      else if (file.contents !== t.contents) drifted.push(t.targetPath);
      else continue;
      restore.push(`${t.targetPath} ← templates/${t.source}`);
    }
    if (restore.length > 0) {
      const parts = [missing.length > 0 ? `missing: ${missing.join(', ')}` : '', drifted.length > 0 ? `drifted: ${drifted.join(', ')}` : ''].filter(Boolean);
      // Not `init --force`: on an existing repo it also overwrites CLAUDE.md, settings and CI.
      return makeResult(this, 'fail', `${parts.join('; ')} — restore from this release's ticket-workflow package: ${restore.join(', ')}`);
    }
    return makeResult(this, 'pass', `${shipped.length} shipped skill files match this release`);
  },
};

export const skillLineCap: AuditCheck = {
  id: 'skill-line-cap',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const root = path.join(ctx.repoDir, SKILLS_DIR);
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return makeResult(this, 'pass', `no ${SKILLS_DIR}/ directory — no skills to measure`);
      return makeResult(this, 'blocked', `${SKILLS_DIR}/ could not be listed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const over: string[] = [];
    let measured = 0;
    for (const name of names) {
      // statSync follows a symlinked skill dir; a stray file or dangling link is not a loadable skill.
      // Only ENOENT is "not a skill": EACCES on a listable-but-unsearchable dir would otherwise PASS unmeasured.
      let isDir: boolean;
      try {
        isDir = statSync(path.join(root, name)).isDirectory();
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
          return makeResult(this, 'blocked', `${SKILLS_DIR}/${name} could not be inspected: ${err instanceof Error ? err.message : String(err)}`);
        }
        isDir = false;
      }
      if (!isDir) continue;
      const rel = path.join(SKILLS_DIR, name, 'SKILL.md');
      const file = ctx.read(rel);
      if (file.kind === 'missing') continue;
      if (file.kind === 'error') return makeResult(this, 'blocked', `${rel} could not be read: ${file.message}`);
      measured++;
      const lines = lineCount(file.contents);
      if (lines > SKILL_LINE_CAP) over.push(`${name} (${lines})`);
    }
    if (over.length > 0) {
      return makeResult(this, 'fail', `SKILL.md over ${SKILL_LINE_CAP} lines: ${over.join(', ')} — move detail into sibling reference files loaded on demand`);
    }
    return makeResult(this, 'pass', `${measured} SKILL.md file(s), all ≤ ${SKILL_LINE_CAP} lines`);
  },
};
