// Launcher, not a copy. The guard itself lives in the ticket-workflow package and is versioned by
// the pin in package.json, so a fix in the package reaches this repo through `npm ci` instead of a
// hand-port — a vendored copy goes stale silently.
//
// A real file has to stay at this path: .claude/settings.json wires it, and a hook whose file cannot
// be resolved does not run at all — a silent no-guard on any fresh clone. That is why pointing
// settings.json straight at node_modules/ was rejected. Resolution failure is handled HERE instead,
// and fails CLOSED: a guard that cannot load must block, never wave work through.
//
// Only exit 2 blocks; exit 1 is a non-blocking hook ERROR. So every failure path has to reach the
// exit(2) below — an uncaught throw here would let the command through while looking like a crash.
// That covers version skew as well as a missing package: a pin whose hook exports no callable `main`
// resolves fine and then throws, which is the same fail-open in a costume.
//
// The `guard-unavailable` token is a CONTRACT, not decoration: `ticket-workflow audit` executes this
// launcher, and it is the only signal separating "the toolchain is not installed yet" from a
// launcher that runs and blocks every command. Removing it makes a wedged repo audit as inert.
try {
  const { main } = await import('ticket-workflow/hooks/guard-bash.mjs');
  if (typeof main !== 'function') {
    throw new TypeError('the installed ticket-workflow exports no callable main — pin too old?');
  }
  await main();
} catch (err) {
  process.stderr.write(
    `[guard-bash] BLOCKED (guard-unavailable): could not run the guard from ticket-workflow (${err?.code ?? err?.message ?? 'import failed'}).\n` +
      'Bash stays blocked until this resolves — run `npm ci` from a plain terminal, outside this session.\n',
  );
  process.exit(2);
}

// Reached only if main() RETURNED instead of exiting — a pin whose guard resolves and runs but
// never calls process.exit. Falling off the end here would exit 0, i.e. ALLOW: the same fail-open
// the callable-main check above guards, one step later. Measured against a stub pin exporting
// `main() { return; }`: without this line a whole-tree `git add` was allowed.
process.stderr.write('[guard-bash] BLOCKED: the guard returned without exiting — contract violation.\n');
process.exit(2);
