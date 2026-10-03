import pino, { type DestinationStream, type Logger } from 'pino';

/** Never log credentials, even if a request, config or auth object is logged later. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'TOKEN_EXCHANGE_CLIENT_SECRET',
  'config.TOKEN_EXCHANGE_CLIENT_SECRET',
  // Bearer (AuthInfo.token) and exchanged tokens, at any one level of nesting.
  'token',
  '*.token',
];

export function createLogger(
  level: string,
  destination?: DestinationStream,
): Logger {
  return pino(
    { level, name: 'mcp-service', redact: REDACT_PATHS },
    destination,
  );
}
