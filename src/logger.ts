import { format } from 'node:util';

// The MCP server speaks JSON-RPC over stdio, so stdout IS the protocol framing channel: one stray
// line there desynchronises the stream for the rest of the session. Every level therefore writes to
// stderr and there is deliberately no stdout level (tkt-c2ed32531824).
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// process.stderr.write rather than the global console, which would also reach stderr: writing the
// stream directly keeps the module graph reachable from the MCP entry point free of `console`
// entirely, and that is what lets stdoutSilence.test.ts assert ZERO occurrences rather than maintain
// an exception list of the calls that happen to be safe today.
// The global console is built with ignoreErrors:true, so writing through it swallowed stream
// faults; process.stderr.write does not, and on a pipe EPIPE arrives as an async 'error' event that
// no try/catch around the write can reach — an MCP host closing the stderr pipe would turn the next
// log line into an uncaught exception and kill the server. Measured: 200 writes through the global
// console on a broken pipe exit 0, one direct stream write exits 1.
process.stderr.on('error', () => { /* a dead stderr must not take the server down */ });

function toStderr(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

const defaultLogger: Logger = { info: toStderr, warn: toStderr, error: toStderr };

let current: Logger = defaultLogger;

// null restores the default, so a test can clean up without holding its own reference to it.
export function setLogger(next: Logger | null): void {
  current = next ?? defaultLogger;
}

// Most call sites sit inside a catch block that exists to swallow a fault. An injected logger that
// throws would escape from there and mask the very error being reported — something the global
// console could never do — so a broken logger degrades to the default instead of propagating, and the line
// still gets written rather than being lost with it.
// Re-entrancy guard. An injected logger cannot reach `log` itself (the barrel exports only
// setLogger, and the exports map walls off the module), but it can call a package function that
// logs — which would recurse without bound, each frame's catch amplifying the output on the way
// down. Inside a forward, a nested call goes straight to the default sink instead.
let forwarding = false;

function forward(level: keyof Logger, args: unknown[]): void {
  if (forwarding) {
    toStderr(...args);
    return;
  }
  forwarding = true;
  try {
    current[level](...args);
  } catch {
    toStderr(...args);
  } finally {
    forwarding = false;
  }
}

// Call sites import this forwarder, never `current` directly: a direct import binds whichever logger
// was installed when the module first loaded, so a later setLogger() — a consumer's, or a test's —
// would silently not take effect at any call site already loaded.
export const log: Logger = {
  info: (...args) => forward('info', args),
  warn: (...args) => forward('warn', args),
  error: (...args) => forward('error', args),
};
