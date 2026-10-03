import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { drain } from './drain.ts';
import { createLogger } from './logging.ts';
import { shutdownTracing } from './tracing.ts';

// Stay under the chart's terminationGracePeriodSeconds (30) so the kubelet never SIGKILLs mid-drain.
const DRAIN_MS = 20_000;
const FLUSH_MS = 3_000;

function boot(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Invalid configuration');
    process.exit(1);
  }

  const logger = createLogger(config.LOG_LEVEL);
  const app = createApp({
    config,
    jwks: createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)),
    logger,
  });
  const handle = toNodeHandler(
    { fetch: app },
    { onerror: (err) => logger.error({ err }, 'request failed') },
  );
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.listen(config.PORT, () =>
    logger.info({ port: config.PORT }, 'mcp-service listening'),
  );
  let stopping = false;
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    void drain(server, shutdownTracing, {
      drainMs: DRAIN_MS,
      flushMs: FLUSH_MS,
      onTimeout: () =>
        logger.warn('drain deadline reached, closing open connections'),
    }).then(() => process.exit(0));
  });
}

boot();
