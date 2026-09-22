/**
 * Minimal workflow-YAML slicing, shared by the gate's contract suites (ci.gate.test.mjs,
 * ci.npm.test.mjs). Extracted rather than duplicated: this parser is hardened against specific
 * measured defeats, and a second copy would be the one that misses the next.
 */

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
