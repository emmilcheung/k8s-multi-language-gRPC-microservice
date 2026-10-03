import { describe, it, expect } from 'vitest';
import { CimdFetchError } from './cimd-fetcher';
import { validateClientMetadataDocument } from './cimd-document';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';

const URL_ID = 'https://app.example.com/oauth/client.json';

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_id: URL_ID,
    client_name: 'Example Agent',
    redirect_uris: ['https://app.example.com/callback'],
    ...over,
  });

function reason(body: string): string {
  try {
    validateClientMetadataDocument(URL_ID, body);
  } catch (e) {
    if (e instanceof CimdFetchError) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('validateClientMetadataDocument', () => {
  it('a document whose client_id differs from the URL is rejected (otherwise any host could claim another app identity)', () => {
    expect(
      reason(doc({ client_id: 'https://evil.example.com/oauth/client.json' })),
    ).toBe('invalid_document');
    expect(reason(doc({ client_id: `${URL_ID}/` }))).toBe('invalid_document');
    expect(reason(doc({ client_id: URL_ID.toUpperCase() }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ client_id: undefined }))).toBe('invalid_document');
  });

  it('a valid document becomes a third-party public client of source cimd', () => {
    const c = validateClientMetadataDocument(URL_ID, doc());
    expect(c).toMatchObject({
      clientId: URL_ID,
      clientName: 'Example Agent',
      redirectUris: ['https://app.example.com/callback'],
      pkceRequired: true,
      isFirstParty: false,
      source: 'cimd',
      applicationType: 'web',
    });
    expect(c.allowedScopes).toEqual([...OAUTH_SCOPE_NAMES]);
  });

  it('rejects invalid JSON and non-object roots', () => {
    expect(reason('{not json')).toBe('invalid_json');
    expect(reason('[]')).toBe('invalid_document');
    expect(reason('null')).toBe('invalid_document');
    expect(reason('"x"')).toBe('invalid_document');
  });

  it('redirect_uris go through the same validator DCR uses (non-empty, https or loopback only)', () => {
    expect(reason(doc({ redirect_uris: [] }))).toBe('invalid_document');
    expect(reason(doc({ redirect_uris: 'https://a.example.com/cb' }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ redirect_uris: [42] }))).toBe('invalid_document');
    expect(reason(doc({ redirect_uris: ['http://evil.example.com/cb'] }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ redirect_uris: ['javascript:alert(1)'] }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ redirect_uris: ['http://localhost:7000/cb'] }))).toBe(
      'accepted',
    );
    expect(
      reason(
        doc({
          redirect_uris: Array.from(
            { length: 11 },
            (_, i) => `https://a.example.com/cb${i}`,
          ),
        }),
      ),
    ).toBe('invalid_document');
  });

  it('CIMD clients are public: a secret-based or key-based auth method is rejected', () => {
    expect(reason(doc({ token_endpoint_auth_method: 'none' }))).toBe(
      'accepted',
    );
    expect(
      reason(doc({ token_endpoint_auth_method: 'client_secret_basic' })),
    ).toBe('invalid_document');
    expect(reason(doc({ token_endpoint_auth_method: 'private_key_jwt' }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ client_secret: 'hunter2' }))).toBe('invalid_document');
  });

  it('grant_types and response_types must be within what the AS supports', () => {
    expect(
      reason(doc({ grant_types: ['authorization_code', 'refresh_token'] })),
    ).toBe('accepted');
    expect(reason(doc({ grant_types: ['client_credentials'] }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ response_types: ['code'] }))).toBe('accepted');
    expect(reason(doc({ response_types: ['token'] }))).toBe('invalid_document');
  });

  it('client_name defaults to the host, is length-capped and rejects control / bidi characters (it is rendered on the consent page)', () => {
    expect(
      validateClientMetadataDocument(URL_ID, doc({ client_name: undefined }))
        .clientName,
    ).toBe('app.example.com');
    expect(reason(doc({ client_name: 'x'.repeat(100) }))).toBe('accepted');
    expect(reason(doc({ client_name: 'x'.repeat(101) }))).toBe(
      'invalid_document',
    );
    expect(reason(doc({ client_name: 'Evil\nApp' }))).toBe('invalid_document');
    expect(reason(doc({ client_name: 'Evil‮App' }))).toBe('invalid_document');
    expect(reason(doc({ client_name: 42 }))).toBe('invalid_document');
    for (const bad of [
      'a\u200eb',
      'a\u200bb',
      'a\u061cb',
      'a\u2028b',
      'a\u2029b',
      'a\ufeffb',
    ]) {
      expect(
        reason(doc({ client_name: bad })),
        `client_name ${JSON.stringify(bad)}`,
      ).toBe('invalid_document');
    }
  });

  it('unknown scopes are dropped like DCR drops them; extra members are ignored', () => {
    const c = validateClientMetadataDocument(
      URL_ID,
      doc({ scope: 'tickets:read root:everything', logo_uri: 'x', foo: 1 }),
    );
    expect(c.allowedScopes).toEqual(['tickets:read']);
  });

  it('application_type is native or web, defaulting to web', () => {
    expect(
      validateClientMetadataDocument(
        URL_ID,
        doc({ application_type: 'native' }),
      ).applicationType,
    ).toBe('native');
    expect(reason(doc({ application_type: 'desktop' }))).toBe(
      'invalid_document',
    );
  });
});

describe('emoji and the joiner rule', () => {
  const ok = (name: string) =>
    validateClientMetadataDocument(URL_ID, doc({ client_name: name }))
      .clientName;

  it('a plain emoji in a name is accepted', () => {
    expect(ok('Ticket Bot \u{1F3AB}')).toBe('Ticket Bot \u{1F3AB}');
  });

  it('an emoji ZWJ sequence is rejected on purpose, because U+200D is an invisible format character and invisible joiners are what the rule stops', () => {
    expect(() =>
      ok('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}'),
    ).toThrow();
  });
});
