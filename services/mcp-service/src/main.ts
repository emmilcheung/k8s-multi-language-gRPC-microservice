import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logging.ts';

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
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}

boot();
