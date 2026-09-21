import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The gate's dependency audit, asserted so it cannot be quietly dropped, widened or neutered
 * (tkt-7172e91d6e16).
 *
 * `npm audit` is the only gate step whose verdict comes from a live advisory feed rather than from
 * the diff, so it is the step a future red run is most tempted to edit. The assertions below match
 * the command **exactly** rather than by substring, because every cheap way of defeating this guard
 * keeps the substring: `… --audit-level=high || true`, `… ; exit 0`, a trailing second
 * `--audit-level=critical` (npm takes the last flag), `--omit=dev`. `if:` is checked for the same
 * reason — a skipped step does not fail its job, so the required check stays green while nothing is
 * audited. All measured, not assumed.
 *
 * The escape hatch for an advisory nobody can fix in their own PR is in CLAUDE.md → Quality gate.
 * It is never a change to this command.
 */
const AUDIT = 'npm audit --audit-level=high';

const gateYml = readFileSync(
  fileURLToPath(new URL('./.github/workflows/gate.yml', import.meta.url)),
  'utf8',
);

/** Stripped first, so a commented-out step can never satisfy a presence assertion. */
function stripComments(yaml) {
  return yaml.replace(/#.*$/gm, '');
}

/**
 * One job's lines, from its 2-space key to the next job key. The slice is load-bearing rather than
 * tidiness: `suite` is the job that has installed the lockfile, so an audit step landing in `gate`
 * would audit nothing at all.
 */
export function jobBlock(yaml, jobName) {
  const key = new RegExp(`^ {2}${jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
  const lines = stripComments(yaml).split('\n');
  const start = lines.findIndex((l) => key.test(l));
  if (start === -1) throw new Error(`no job \`${jobName}\` in the workflow`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function addKey(step, text) {
  const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(text);
  if (m) step[m[1]] = m[2].trim();
}

/**
 * A job's steps as key maps, in file order. Keys are collected from the whole step, not just the
 * dash line, so naming a step (`- name:` with `run:` beneath) is an ordinary refactor rather than a
 * suite failure. A block scalar (`- run: |`) yields `run` of `|`, which matches no command here —
 * fail-closed, which is the direction this should fail in.
 */
export function steps(yaml, jobName) {
  const lines = jobBlock(yaml, jobName).split('\n');
  const first = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (first === -1) throw new Error(`job \`${jobName}\` declares no steps`);
  const out = [];
  let dashIndent = null;
  for (const line of lines.slice(first + 1)) {
    const dash = /^(\s*)-\s+(\S.*)$/.exec(line);
    if (dash && (dashIndent === null || dash[1].length === dashIndent)) {
      dashIndent = dash[1].length;
      out.push({});
      addKey(out[out.length - 1], dash[2]);
    } else if (out.length > 0 && dashIndent !== null) {
      const kv = /^(\s+)(\S.*)$/.exec(line);
      if (kv && kv[1].length > dashIndent) addKey(out[out.length - 1], kv[2]);
    }
  }
  return out;
}

const auditSteps = (yaml) => steps(yaml, 'suite').filter((s) => /^npm audit\b/.test(s.run ?? ''));

/**
 * The guarantee, in one predicate: at least one step that is the canonical command, unconditional
 * and blocking. Stated as existence rather than "every audit step is canonical" for two reasons —
 * an `every` over a step list that the defeat removed from view is vacuously true (a block scalar
 * does exactly that), and a *stricter* extra audit step should be allowed to land without editing
 * this file. One sound step is what makes a high advisory fail the job; nothing beside it can undo
 * that.
 */
const soundAuditSteps = (yaml) =>
  auditSteps(yaml).filter(
    (s) => s.run === AUDIT && s.if === undefined && s['continue-on-error'] === undefined,
  );

describe('the CI gate audits dependencies', () => {
  it('runs npm audit in the suite job, scoped to high, with nothing appended', () => {
    const audits = auditSteps(gateYml);
    expect(audits.length, 'no `npm audit` step in the suite job').toBeGreaterThan(0);
    expect(audits.map((s) => s.run)).toContain(AUDIT);
  });

  it('blocks rather than reports, and is never conditionally skipped', () => {
    const canonical = auditSteps(gateYml).filter((s) => s.run === AUDIT);
    for (const s of canonical) {
      expect(s['continue-on-error'], 'audit step made non-blocking').toBeUndefined();
      expect(s.if, 'audit step made conditional — a skipped step does not fail its job').toBeUndefined();
    }
    expect(jobBlock(gateYml, 'suite')).not.toMatch(/^\s{4}continue-on-error/m);
    expect(soundAuditSteps(gateYml).length, 'no sound audit step survives').toBeGreaterThan(0);
  });

  it('audits the tree the gate installed, not an empty one', () => {
    const run = steps(gateYml, 'suite').map((s) => s.run ?? '');
    const ci = run.findIndex((c) => /^npm ci\b/.test(c));
    const audit = run.findIndex((c) => /^npm audit\b/.test(c));
    expect(ci, 'no `npm ci` step to audit the result of').toBeGreaterThanOrEqual(0);
    expect(audit, '`npm audit` must follow `npm ci`').toBeGreaterThan(ci);
  });

  it('slices a single job, and ignores commented-out steps', () => {
    // Positive control.
    expect(steps(gateYml, 'suite').map((s) => s.run)).toEqual(
      expect.arrayContaining(['npm ci', 'npm run lint']),
    );
    // Negative control, and the one that carries the suite: a slicer that silently returned the
    // whole file would report `npm ci` under `gate` too, making every assertion above vacuous. The
    // positive assertion beside it proves the slice is non-empty rather than trivially clean.
    expect(jobBlock(gateYml, 'gate')).toContain('needs: [suite]');
    expect(jobBlock(gateYml, 'gate')).not.toContain('npm ci');
    expect(() => jobBlock(gateYml, 'nope')).toThrow(/no job/);
  });

  // Controls on the matcher itself, against fixtures rather than the live file: each is a way the
  // guard has actually been defeated (or benignly refactored) during review.
  describe('the matcher, against known defeats', () => {
    const fixture = (step) => `jobs:\n  suite:\n    steps:\n      - run: npm ci\n${step}\n  gate:\n    needs: [suite]\n`;
    const canonical = `      - run: ${AUDIT}`;

    it('accepts the canonical step, however it is spelled', () => {
      expect(soundAuditSteps(fixture(canonical))).toHaveLength(1);
      // The benign refactor: naming a step is ordinary YAML and must not redden the suite.
      expect(
        soundAuditSteps(fixture(`      - name: Audit dependencies\n        run: ${AUDIT}`)),
      ).toHaveLength(1);
      // A *stricter* extra step is a strengthening, not a defeat — the canonical one still stands.
      expect(soundAuditSteps(fixture(`${canonical}\n      - run: npm audit --audit-level=moderate`))).toHaveLength(1);
    });

    it.each([
      ['a shell escape', `      - run: ${AUDIT} || true`],
      ['a swallowed exit', `      - run: ${AUDIT}; exit 0`],
      ['a trailing override — npm takes the last flag', `      - run: ${AUDIT} --audit-level=critical`],
      ['a narrowed tree', `      - run: ${AUDIT} --omit=dev`],
      ['a block scalar, which this matcher cannot read', `      - run: |\n          ${AUDIT}`],
      ['a conditional step', `${canonical}\n        if: false`],
      ['a non-blocking step', `${canonical}\n        continue-on-error: true`],
      ['a deleted step', '      - run: npm run lint'],
      ['a commented-out step', `      # - run: ${AUDIT}`],
    ])('rejects %s', (_, step) => {
      expect(soundAuditSteps(fixture(step))).toHaveLength(0);
    });
  });
});
