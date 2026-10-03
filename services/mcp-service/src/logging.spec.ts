import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logging.ts';

function capture(): { lines: () => string; stream: Writable } {
  let out = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { lines: () => out, stream };
}

describe('log redaction', () => {
  it('bearer and exchanged tokens are redacted wherever a logged object carries a `token` field', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info({ authInfo: { token: 'MCP-JWT-VALUE' } }, 'a');
    log.info({ exchange: { token: 'API-JWT-VALUE' } }, 'b');
    log.info({ token: 'TOP-LEVEL-VALUE' }, 'c');
    expect(lines()).not.toMatch(/MCP-JWT-VALUE|API-JWT-VALUE|TOP-LEVEL-VALUE/);
    expect(lines()).toContain('[Redacted]');
  });

  it('authorization headers and the client secret stay redacted', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info({ req: { headers: { authorization: 'Bearer SECRET-HDR' } } }, 'a');
    log.info({ config: { TOKEN_EXCHANGE_CLIENT_SECRET: 'SECRET-CFG' } }, 'b');
    expect(lines()).not.toMatch(/SECRET-HDR|SECRET-CFG/);
  });
});
