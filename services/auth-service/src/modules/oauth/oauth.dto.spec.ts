import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterClientBody } from './oauth.dto';

describe('RegisterClientBody', () => {
  it('accepts localhost redirect URIs used by local OAuth clients', async () => {
    const dto = plainToInstance(RegisterClientBody, {
      client_name: 'Playwright OAuth Client',
      redirect_uris: ['http://localhost:4000/oauth/callback-test'],
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects malformed redirect URIs', async () => {
    const dto = plainToInstance(RegisterClientBody, {
      client_name: 'Bad OAuth Client',
      redirect_uris: ['http://localhost:bad-port/callback'],
    });

    const errors = await validate(dto);

    expect(errors).not.toHaveLength(0);
    expect(errors[0]?.property).toBe('redirect_uris');
  });
});
