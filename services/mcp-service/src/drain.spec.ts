import { describe, expect, it, vi } from 'vitest';
import { drain } from './drain.ts';

const fakeServer = (closesBy: 'immediately' | 'never') => {
  const calls: string[] = [];
  return {
    calls,
    server: {
      close: (cb?: (err?: Error) => void) => {
        calls.push('close');
        if (closesBy === 'immediately') cb?.();
      },
      closeIdleConnections: () => calls.push('closeIdle'),
      closeAllConnections: () => calls.push('closeAll'),
    },
  };
};

describe('shutdown drain', () => {
  it('flushes telemetry only after the server has closed, so the exit cannot cut the flush short', async () => {
    const { server, calls } = fakeServer('immediately');
    const flush = vi.fn(() => {
      calls.push('flush');
      return Promise.resolve();
    });
    await drain(server as never, flush, { drainMs: 50, flushMs: 50 });
    expect(calls).toEqual(['close', 'closeIdle', 'flush']);
  });

  it('cuts open streams once the drain deadline passes instead of waiting for SIGKILL', async () => {
    const { server, calls } = fakeServer('never');
    const onTimeout = vi.fn();
    await drain(server as never, () => Promise.resolve(), {
      drainMs: 10,
      flushMs: 10,
      onTimeout,
    });
    expect(calls).toContain('closeAll');
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('does not wait forever for a hung or failing telemetry flush', async () => {
    const { server } = fakeServer('immediately');
    const hung = drain(server as never, () => new Promise(() => undefined), {
      drainMs: 10,
      flushMs: 10,
    });
    await expect(hung).resolves.toBeUndefined();
    const failing = drain(
      server as never,
      () => Promise.reject(new Error('x')),
      {
        drainMs: 10,
        flushMs: 10,
      },
    );
    await expect(failing).resolves.toBeUndefined();
  });
});
