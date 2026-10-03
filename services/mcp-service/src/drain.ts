import type { Server } from 'node:http';

type Drainable = Pick<
  Server,
  'close' | 'closeIdleConnections' | 'closeAllConnections'
>;

const after = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref());

/**
 * Stops accepting traffic, waits up to `drainMs` for in-flight requests, then cuts
 * whatever is left (long-lived SSE streams never finish on their own), and finally
 * flushes telemetry for up to `flushMs`. The caller exits afterwards, so the exit
 * can never run ahead of the flush. `drainMs + flushMs` must stay below the pod's
 * terminationGracePeriodSeconds or the kubelet sends SIGKILL first.
 */
export async function drain(
  server: Drainable,
  flush: () => Promise<void>,
  opts: { drainMs: number; flushMs: number; onTimeout?: () => void },
): Promise<void> {
  const closed = new Promise<'closed'>((resolve) =>
    server.close(() => resolve('closed')),
  );
  server.closeIdleConnections();
  if ((await Promise.race([closed, after(opts.drainMs)])) === 'timeout') {
    opts.onTimeout?.();
    server.closeAllConnections();
  }
  await Promise.race([flush().catch(() => undefined), after(opts.flushMs)]);
}
