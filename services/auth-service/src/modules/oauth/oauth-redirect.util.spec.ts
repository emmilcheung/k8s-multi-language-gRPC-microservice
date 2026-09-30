import { describe, it, expect } from 'vitest';
import { redirectUriMatches } from './oauth-redirect.util';

describe('redirectUriMatches', () => {
  const registered = ['http://127.0.0.1:19836/callback'];

  it('E-5: accepts a random loopback port (RFC 8252 §7.3: native apps bind an ephemeral port per run)', () => {
    expect(
      redirectUriMatches(registered, 'http://127.0.0.1:54321/callback'),
    ).toBe(true);
  });

  it('E-5: accepts a random port for registered [::1] and localhost URIs, and no port at all', () => {
    expect(
      redirectUriMatches(['http://[::1]/cb'], 'http://[::1]:40000/cb'),
    ).toBe(true);
    expect(
      redirectUriMatches(['http://localhost:1/cb'], 'http://localhost:2/cb'),
    ).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1/callback')).toBe(
      true,
    );
  });

  it('E-5: rejects a port change on a non-loopback URI (only loopback may vary, otherwise a code could be sent to another service on the host)', () => {
    expect(
      redirectUriMatches(
        ['https://app.example.com/cb'],
        'https://app.example.com:8443/cb',
      ),
    ).toBe(false);
    expect(
      redirectUriMatches(
        ['https://app.example.com:8443/cb'],
        'https://app.example.com:9443/cb',
      ),
    ).toBe(false);
  });

  it('E-5: a loopback registration still pins scheme, host, path and query', () => {
    for (const bad of [
      'https://127.0.0.1:54321/callback',
      'http://localhost:54321/callback',
      'http://[::1]:54321/callback',
      'http://127.0.0.1:54321/other',
      'http://127.0.0.1:54321/callback?x=1',
      'http://evil@127.0.0.1:54321/callback',
      'not a url',
    ]) {
      expect(redirectUriMatches(registered, bad)).toBe(false);
    }
  });

  it('keeps exact matching for every registered URI', () => {
    expect(
      redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb'),
    ).toBe(true);
    expect(
      redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb2'),
    ).toBe(false);
  });
  it('rejects userinfo on a loopback URI (http://user@127.0.0.1 can mislead a user about the real host)', () => {
    expect(
      redirectUriMatches(registered, 'http://user@127.0.0.1:1234/callback'),
    ).toBe(false);
    expect(
      redirectUriMatches(registered, 'http://user:pw@127.0.0.1:1234/callback'),
    ).toBe(false);
  });

  it('rejects a lookalike host such as localhost.evil.com (only the exact loopback names may vary the port)', () => {
    const localhostReg = ['http://localhost:1/cb'];
    expect(
      redirectUriMatches(localhostReg, 'http://localhost.evil.com:1234/cb'),
    ).toBe(false);
    expect(redirectUriMatches(localhostReg, 'http://evil.com:1234/cb')).toBe(
      false,
    );
  });

  it('rejects an IPv6 zone id (fe80::1%25eth0 is not the loopback address)', () => {
    expect(
      redirectUriMatches(['http://[::1]/cb'], 'http://[::1%25eth0]:1234/cb'),
    ).toBe(false);
    expect(
      redirectUriMatches(['http://[::1]/cb'], 'http://[::1%eth0]:1234/cb'),
    ).toBe(false);
  });
});
