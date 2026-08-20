// Shell-command directory parsing, shared by the hooks that must judge WHICH repo a command acts on
// (tkt-2734584f8715). guard-bash needs it to apply a repo's protected-branch rules to that repo;
// track-steps needs it to refuse attributing a milestone to a repo the command never touched. One
// copy, because two would drift on exactly the edge cases both hooks fail closed on.

import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// null rather than a guess — a wrong dir judges one repo by another's branch.
export function resolveDir(dir, target) {
  const quoted = /^["']/.test(target);
  const balanced = quoted && target.length > 1 && target.at(-1) === target[0];
  if (quoted && !balanced) return null; // whitespace-split upstream truncated a quoted path
  const t = balanced ? target.slice(1, -1) : target;
  if (!t || t.includes('$') || t.includes('*')) return null;
  if (t === '~') return homedir();
  if (t.startsWith('~/')) return join(homedir(), t.slice(2));
  if (t.startsWith('~')) return null; // ~user
  if (isAbsolute(t)) return t;
  return dir ? resolve(dir, t) : null;
}

// The directory builtin a segment invokes, if any, plus its raw target token.
//
// Deliberately NOT substitution-aware: `SHA=$( cd /x && … )` — one space — reads as a move of the
// caller here, and the spelling `$(cd` does not. That inconsistency is real and pre-dates
// tkt-3006d09810f7, which reverted its own fix for it: identifying the name on masked text while
// returning a masked target dropped the `$` resolveDir refuses on, and identifying it on tokens
// rather than the whole string lost the `^[({\s]+` strip that lets `( FOO=bar cd /x` reach `cd`.
// Both regressions were fail-opens. Fixing it needs its own adversary list, not a rider on this one.
function dirBuiltin(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/);
  let cmd = 0;
  while (cmd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmd])) cmd++;
  return { name: tokens[cmd], target: tokens[cmd + 1] };
}

// undefined = not a cd; null = unresolvable (`cd -`, bare `cd`, a variable). Callers must decide
// what null means for them: guard-bash falls back to the session repo (a bogus cd cannot exempt
// itself from the branch rules), track-steps records nothing (a bogus cd cannot misfile a
// milestone). Both are the fail-CLOSED reading of null for that hook.
export function cdTarget(segment, dir) {
  const { name, target } = dirBuiltin(segment);
  if (name !== 'cd') return undefined;
  if (!target || target.startsWith('-')) return null; // `cd`, `cd -`, `cd -P …`
  return resolveDir(dir, target);
}

// As cdTarget, but also `pushd`/`popd`. track-steps needs the wider net because a move it misses
// MISFILES a milestone onto a real ticket. guard-bash calls cdTarget, so a SEGMENT-INITIAL `pushd`
// is invisible to it — a gap, not a documented residual: its header names neither this nor `pushd`
// (measured, zero occurrences), and mid-segment `pushd` does reach it through hiddenDirTarget, so
// the two positions disagree. `popd` returns to a stack this does not track, so it reports
// unresolvable rather than guessing — the fail-closed reading.
export function dirTarget(segment, dir) {
  const { name, target } = dirBuiltin(segment);
  if (name === 'popd') return null;
  if (name !== 'cd' && name !== 'pushd') return undefined;
  if (!target || target.startsWith('-')) return null;
  return resolveDir(dir, target);
}

// Split a compound command into top-level segments on && || ; and newline —
// but NOT inside single/double quotes or $( … ) command substitutions. So data
// (a commit-message heredoc body, a quoted JS string that happens to contain
// `&&` or git verbs) is never mis-parsed as a separate command. Not a full shell
// parser — it covers the shapes the workflow actually produces; a stray
// unbalanced `)` inside a heredoc body is the known residual.
export function splitSegments(command) {
  const segments = [];
  let buf = '';
  let sq = false;   // inside '...'
  let dq = false;   // inside "..."
  let subst = 0;    // depth of $( … )
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (sq) { buf += c; if (c === "'") sq = false; continue; }
    if (c === "'" && !dq) { buf += c; sq = true; continue; }
    if (c === '"' && subst === 0) { buf += c; dq = !dq; continue; }
    if (c === '$' && next === '(') { buf += '$('; subst++; i++; continue; }
    if (subst > 0 && c === '(') { buf += c; subst++; continue; }
    if (subst > 0 && c === ')') { buf += c; subst--; continue; }
    if (!dq && subst === 0) {
      if (c === '&' && next === '&') { segments.push(buf); buf = ''; i++; continue; }
      if (c === '|' && next === '|') { segments.push(buf); buf = ''; i++; continue; }
      if (c === ';' || c === '\n') { segments.push(buf); buf = ''; continue; }
    }
    buf += c;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// The subshell parens a segment really opens and closes — those outside quotes and outside a
// `$( … )` substitution. splitSegments deliberately keeps a substitution intact, so a segment can
// END in a `)` that closes no subshell (`export SHA=$(git rev-parse HEAD)`); counting it pops a
// frame nothing pushed, silently restoring a pre-`cd` directory. Counted, not regex-matched, for
// exactly that reason (tkt-2734584f8715).
export function subshellParens(segment) {
  let sq = false, dq = false, subst = 0, open = 0, close = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (sq) { if (c === "'") sq = false; continue; }
    if (c === "'" && !dq) { sq = true; continue; }
    if (c === '"' && subst === 0) { dq = !dq; continue; }
    if (c === '$' && segment[i + 1] === '(') { subst++; i++; continue; }
    if (subst > 0) { if (c === '(') subst++; else if (c === ')') subst--; continue; }
    if (dq) continue;
    if (c === '(') open++;
    else if (c === ')') close++;
  }
  return { open, close };
}

// A directory builtin that is not the segment's first word, hidden behind a pipeline, a compound
// statement or a group — `echo x | (cd /other && npm test)`, `do (cd /other …`, `then cd /other`.
// dirBuiltin reads only the first word, so these looked like "no move at all" and the milestone
// after them was admitted as the session's. Where it moved to is unknowable here, so the caller
// must treat this as unresolvable rather than as no move.
const DIR_BUILTINS = new Set(['cd', 'pushd', 'popd']);
const COMMAND_POSITION = new Set(['|', '||', '&', '&&', ';', '{', '(', 'then', 'do', 'else', 'elif']);

// Text that is DATA rather than this segment's command: a `cd` in a commit message moved nothing,
// and one inside `$( … )` moves a subshell that exits before the next command runs. Masked to a
// filler rather than deleted, and LENGTH-PRESERVING, for two reasons: the check below reads the
// PREVIOUS token to decide whether a `cd` sits in command position, so collapsing a span would fuse
// its neighbours and invent one; and callers recover a raw token by slicing the original at the
// masked offsets. guard-bash refuses a commit on these answers, so a false positive blocks a
// legitimate commit whose message merely contains `&& cd` (tkt-3006d09810f7).
//
function maskData(segment) {
  let out = '';
  let sq = false, dq = false, subst = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (sq) { out += '_'; if (c === "'") sq = false; continue; }
    if (c === "'" && !dq) { out += '_'; sq = true; continue; }
    if (c === '"' && subst === 0) { out += '_'; dq = !dq; continue; }
    // Two characters for two, because hiddenDirTarget recovers a raw token by slicing the ORIGINAL
    // at these offsets: a one-character shift yields a different, real-looking directory.
    if (c === '$' && segment[i + 1] === '(') { out += '__'; subst++; i++; continue; }
    if (subst > 0) {
      if (c === '(') subst++;
      else if (c === ')') subst--;
      out += '_';
      continue;
    }
    out += dq ? '_' : c;
  }
  return out;
}

// Tokens of `masked`, each carrying the offsets that locate it in the ORIGINAL string.
function tokensWithIndex(masked) {
  const out = [];
  for (const m of masked.matchAll(/\S+/g)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// The directory a hidden move lands in: undefined = no hidden move, null = one we cannot name.
// Returning the TARGET rather than a boolean is what keeps this from wedging legitimate work —
// guard-bash blocks on an unnameable directory, and `echo x | (cd /some/repo && …)` names one
// perfectly well (tkt-3006d09810f7).
export function hiddenDirTarget(segment, dir) {
  const toks = tokensWithIndex(maskData(segment));
  for (let i = 1; i < toks.length; i++) {
    const bare = toks[i].text.replace(/^[({]+/, '');
    if (!DIR_BUILTINS.has(bare)) continue;
    // Grouping punctuation fused to the word (`(cd`) is itself the command position. Otherwise the
    // previous token must be one — so `git commit -m "x cd y"` stays a commit, not a move.
    const fused = toks[i].text !== bare;
    if (!fused && !(COMMAND_POSITION.has(toks[i - 1].text) || /[|&;({]$/.test(toks[i - 1].text))) continue;
    if (bare === 'popd') return null; // returns to a stack this does not track
    const next = toks[i + 1];
    if (!next) return null;
    // The raw token, not the masked one: a quoted path must reach resolveDir with its quotes.
    const target = segment.slice(next.start, next.end).replace(/[)}]+$/, '');
    if (!target || target.startsWith('-')) return null;
    return resolveDir(dir, target);
  }
  return undefined;
}

// One implementation, so the two cannot drift: any resolution — including an unresolvable one — is
// still a move, and only `undefined` means there was none.
export function hiddenDirMove(segment) {
  return hiddenDirTarget(segment, null) !== undefined;
}
