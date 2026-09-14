import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log, setLogger, type Logger } from './logger.js';

function recorder(): { calls: string[]; logger: Logger } {
  const calls: string[] = [];
  const push = (level: string) => (...args: unknown[]) => { calls.push(`${level} ${args.map(String).join(' ')}`); };
  return { calls, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

describe('logger', () => {
  afterEach(() => {
    setLogger(null);
    vi.restoreAllMocks();
  });

  describe('default', () => {
    // The global setup silences the logger; these assert the default sink itself, so restore it.
    beforeEach(() => { setLogger(null); });

    function captureStreams(): { out: string[]; err: string[] } {
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err.push(String(c)); return true; });
      return { out, err };
    }

    // info is the level that matters here: it is the one a reasonable implementation would put on
    // stdout, and under a stdio JSON-RPC transport that corrupts the protocol.
    it.each(['info', 'warn', 'error'] as const)('routes %s to stderr and never stdout', (level) => {
      const { out, err } = captureStreams();
      log[level]('[probe] hello');
      expect(out).toEqual([]);
      expect(err.join('')).toBe('[probe] hello\n');
    });

    it('formats multiple arguments the way console did', () => {
      const { err } = captureStreams();
      log.error('[tickets] failed', 'a.md', new Error('boom'));
      const line = err.join('');
      expect(line).toContain('[tickets] failed');
      expect(line).toContain('a.md');
      expect(line).toContain('boom');
      expect(line.endsWith('\n')).toBe(true);
    });

    it('does not hijack global console', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      log.error('[probe] hello');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('injection', () => {
    it('routes every level to an installed logger', () => {
      const { calls, logger } = recorder();
      setLogger(logger);
      log.info('one');
      log.warn('two');
      log.error('three');
      expect(calls).toEqual(['info one', 'warn two', 'error three']);
    });

    it('restores the stderr default on setLogger(null)', () => {
      const { calls, logger } = recorder();
      setLogger(logger);
      setLogger(null);
      const err: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err.push(String(c)); return true; });

      log.warn('[probe] after reset');

      expect(calls).toEqual([]);
      expect(err.join('')).toBe('[probe] after reset\n');
    });

    // Nearly every call site is inside a catch block that exists to swallow a fault, so a throwing
    // logger propagating from there would mask the original error.
    it('degrades to stderr when an installed logger throws, without propagating', () => {
      setLogger({
        info: () => { throw new Error('this logger is broken'); },
        warn: () => undefined,
        error: () => undefined,
      });
      const err: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err.push(String(c)); return true; });

      expect(() => { log.info('[probe] still logged'); }).not.toThrow();
      expect(err.join('')).toBe('[probe] still logged\n');
    });

    // A consumer's logger cannot reach `log` (the barrel exports only setLogger), but it can call a
    // package function that logs, which would recurse without bound — each frame's catch amplifying
    // the output on the way down.
    it('does not recurse when an installed logger logs back through the package', () => {
      let depth = 0;
      setLogger({
        info: (...args) => { depth += 1; log.info(...args); },
        warn: () => undefined,
        error: () => undefined,
      });
      const err: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err.push(String(c)); return true; });

      expect(() => { log.info('[probe] reentrant'); }).not.toThrow();
      expect(depth).toBe(1); // the nested call went to the default sink, not back around
      expect(err.join('')).toBe('[probe] reentrant\n');
    });

    // The forwarder indirection is the reason this holds. A call site that had imported the active
    // logger directly would be pinned to whichever one was installed at module load, so a later
    // swap would reach the new logger nowhere.
    it('re-points call sites already bound to log', () => {
      const first = recorder();
      const second = recorder();
      const emit = () => { log.info('x'); }; // bound before either logger exists

      setLogger(first.logger);
      emit();
      setLogger(second.logger);
      emit();

      expect(first.calls).toEqual(['info x']);
      expect(second.calls).toEqual(['info x']);
    });
  });
});
