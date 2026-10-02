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

  it('accepts application_type native and web, rejects anything else', async () => {
    const make = (application_type: string) =>
      plainToInstance(RegisterClientBody, {
        client_name: 'App',
        redirect_uris: ['https://app.example.com/cb'],
        application_type,
      });
    expect(await validate(make('native'))).toHaveLength(0);
    expect(await validate(make('web'))).toHaveLength(0);
    const errors = await validate(make('mobile'));
    expect(errors[0]?.property).toBe('application_type');
  });

  it('caps client_name, because the name is shown verbatim on the consent page', async () => {
    const dto = plainToInstance(RegisterClientBody, {
      client_name: 'x'.repeat(101),
      redirect_uris: ['https://app.example.com/cb'],
    });
    const errors = await validate(dto);
    expect(errors[0]?.property).toBe('client_name');
  });
});
