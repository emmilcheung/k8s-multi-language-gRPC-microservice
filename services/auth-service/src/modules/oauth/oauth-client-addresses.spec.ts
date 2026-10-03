import { describe, it, expect } from 'vitest';
import { describeClientAddresses } from './oauth-clients.config';

const URL_ID = 'https://app.example.com/oauth/client.json';
const client = (redirectUris: string[]) => ({ redirectUris });

describe('where the app lives vs where the code is sent', () => {
  it('a CIMD client reports the client_id host AND the redirect host of this request, with no mismatch when they are equal', () => {
    expect(
      describeClientAddresses(
        URL_ID,
        client(['https://app.example.com/cb']),
        'https://app.example.com/cb',
      ),
    ).toEqual({
      documentHost: 'app.example.com',
      redirectTargets: [{ host: 'app.example.com', loopback: false }],
      redirectMismatch: false,
    });
  });

  it('a redirect host that is not EXACTLY the client_id host is a mismatch (a shared-hosting document pointing elsewhere)', () => {
    const r = describeClientAddresses(
      'https://raw.githubusercontent.com/attacker/x/main/c.json',
      client(['https://evil.example/cb']),
      'https://evil.example/cb',
    );
    expect(r).toMatchObject({
      documentHost: 'raw.githubusercontent.com',
      redirectTargets: [{ host: 'evil.example', loopback: false }],
      redirectMismatch: true,
    });
  });

  it('no registrable-domain logic: a sibling subdomain is still a mismatch', () => {
    expect(
      describeClientAddresses(
        URL_ID,
        client(['https://login.example.com/cb']),
        'https://login.example.com/cb',
      ).redirectMismatch,
    ).toBe(true);
  });

  it.each([
    'http://localhost:8123/cb',
    'http://127.0.0.1:19836/callback',
    'http://[::1]:5000/cb',
  ])(
    'loopback redirect %s is "an app on this device", never a mismatch',
    (uri) => {
      const r = describeClientAddresses(URL_ID, client([uri]), uri);
      expect(r.redirectTargets).toHaveLength(1);
      expect(r.redirectTargets[0].loopback).toBe(true);
      expect(r.redirectMismatch).toBe(false);
    },
  );

  it('a DCR/static client has no document host and is never flagged', () => {
    const r = describeClientAddresses(
      'a-uuid',
      client(['https://cb.example.org/cb']),
      'https://cb.example.org/cb',
    );
    expect(r).toEqual({
      documentHost: undefined,
      redirectTargets: [{ host: 'cb.example.org', loopback: false }],
      redirectMismatch: false,
    });
  });

  it('with no request URI (Connected apps) it lists every registered host once, loopback entries collapsed', () => {
    const r = describeClientAddresses(
      URL_ID,
      client([
        'https://app.example.com/cb',
        'https://app.example.com/cb2',
        'https://other.example.net/cb',
        'http://localhost:1/cb',
        'http://127.0.0.1:2/cb',
      ]),
    );
    expect(r.redirectTargets).toEqual([
      { host: 'app.example.com', loopback: false },
      { host: 'other.example.net', loopback: false },
      { host: 'localhost', loopback: true },
    ]);
    expect(r.redirectMismatch).toBe(true);
  });

  it('a CIMD grant whose document left the cache still names the client_id host and flags nothing it cannot know', () => {
    expect(describeClientAddresses(URL_ID, null)).toEqual({
      documentHost: 'app.example.com',
      redirectTargets: [],
      redirectMismatch: false,
    });
  });
});
