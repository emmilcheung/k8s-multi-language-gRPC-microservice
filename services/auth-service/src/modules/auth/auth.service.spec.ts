import { describe, it, expect, vi } from 'vitest';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { UsersRepository } from '../users/users.repository';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import * as argon2 from 'argon2';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<{ id: string; email: string; passwordHash: string }> = {}) {
  return {
    id: 'uuid-1',
    email: 'user@example.com',
    passwordHash: 'hashed',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Real 2048-bit RSA private key — generated for test use only, not a secret
const TEST_RSA_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA8g+qzsBeAmIHAIqftMlCN4xNhjS/wG2oglQG8mgu5CqngEGo
ZdbrgUBMC22B2VGHJvvW/AxW24uEj0/+S5g00wlJ0UkqtkAGwjgW52DtykRz1tQN
9M0NKAWayweSNoySeNWfsqJfiB4R7BB+/fpq+nFKh78DdFDPifnBMuoy7s7QDQvP
DDiw9Uu+dWMswZqQncgite/sp/ZRpy8Ufc6t37HYPrwTfo5lUX8Isn0ZDUTeE+MQ
pUacP396AbKBH5cRy+lkzalZRuTs2MUvtpK4RosVB4IMHs+3rNATJWeEsteVBb1D
e91u/Old0xDI4FLaKxWlLmdjSMQrzcetjRQCuwIDAQABAoIBAEPiBunCYtrSONp7
BbzCcDJ5w0fuxROm7QnXnLcgZn4QRDcgsqQUuKjfqjPOOwsB5SAWojy/DSC2qK80
JMF4ZuAEC9KIbVT88ahH6Ixsz2LY/Y9ympNbaeQeZkGn1uY7V9xRNF75UEcw/5+v
JJ3/Oz8OxHL7K3HUM8+i3f50VWJIy8bUuLkXd5R4Cxc3X3hbgS1ozETLc797IOqT
yUOSg6PcOZnRvo9bnovxW9KHG7I37qzoQdA8+/HTZM2+fSuDG4jNbLrch2TEVxIX
NC1qLQLe+qsYXPhYiWmxZ2hydhTYnFCCs1EFSzfYNyvN4BfQio7mDd7WGB2V15wg
zRvxDXkCgYEA/IhBG+Fh5fVUlYKHHiz/G5FkC59nYwqG3q0apNbHFIovWnSW0pQk
bRbKHxh9TaM4vB5IdZLyfT2FzwZ8LpHTaj6jKXBE+OXbgK0W/X6LYreCLAgUcwUr
TJZ/p8I0em36AWhL47R7qPEWgsl9ybJb9wH//N0/TapFb7o+imGsat0CgYEA9WKa
baoeedKo7V74NjK6m9sKhIT61LTy+X4k7iLcbiKZ8PepFfGHdWMPZe7QQIKjHCOq
+eSWug2rvZo0/IrkG7hw0bW2P0svnjKHmGgpgojdSob0zixpUjiGsvv83PQxgpso
hzcuWDp+VadRnaO1+Sl+crhQlymo4YSJFA9rTncCgYAxTIA5ayRrehtLHLI4B9y9
iwKW6kWKpjFyIyUCbRNsRRW9eOlArr71tO88ZtF/aI/Y2aiXm1pPbMVEhyWTCdDV
+uhrXIl6dZUGZ8QHNL8NRHnbErC7S5UKXI8LNvR7uiCGSdAW4dMKRhZ47dDqoTEm
5XMN8Ds9dDId/6PZ6/t22QKBgHlElZUEsbL6zMkiWgBO6bIEehorrdpY4osyMAYP
7GfxaaqQeluB1bPJlN6HOxvmc72AUwrUUTj5cJpvDyiPa1PXvsmkx8BX49yGlERZ
lcoQ4WvnbixF/nbHwKnLppd7hsxI6aqJNrobjju+SLNjKJdOTlNbi1hpGjD5UtU7
GYjZAoGBALZlXBFKURFjACUw+HK2LmRwfPH/Cbw3h5F73+8j39wzhFEQ/ANjP7sB
J2I25W+YIYqYGV3OAYNcxcveSf6+WgKAKR5VQuQQQ0nOX0seFL1xnERfXqADgZyJ
iMbpvI5mi11tnbw8iU3T0jJycMgHw7EIiCNy2czPt2BRYcwIK9Gb
-----END RSA PRIVATE KEY-----`;

// ── Mocks ─────────────────────────────────────────────────────────────────────

function makeLogger(): PinoLogger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as PinoLogger;
}

function makeUsersRepo(overrides: Partial<UsersRepository> = {}): UsersRepository {
  return {
    findByEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    ...overrides,
  } as unknown as UsersRepository;
}

function makeJwtService(overrides: Partial<JwtService> = {}): JwtService {
  return {
    sign: vi.fn().mockReturnValue('signed.jwt.token'),
    ...overrides,
  } as unknown as JwtService;
}

function makeConfigService(rsaKey = TEST_RSA_PEM): ConfigService {
  return {
    getOrThrow: vi.fn().mockReturnValue(rsaKey),
    get: vi.fn().mockReturnValue('15m'),
  } as unknown as ConfigService;
}

function makeAuthService(overrides: {
  usersRepo?: Partial<UsersRepository>;
  jwtService?: Partial<JwtService>;
  configService?: ConfigService;
} = {}): { service: AuthService; usersRepo: UsersRepository; jwtService: JwtService } {
  const usersRepo = makeUsersRepo(overrides.usersRepo);
  const jwtService = makeJwtService(overrides.jwtService);
  const configService = overrides.configService ?? makeConfigService();
  const logger = makeLogger();
  const service = new AuthService(logger, usersRepo, jwtService, configService);
  return { service, usersRepo, jwtService };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  describe('signup', () => {
    it('should return a signed JWT when email is not already in use', async () => {
      const { service, usersRepo, jwtService } = makeAuthService({
        usersRepo: {
          findByEmail: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(makeUser()),
        },
      });

      const token = await service.signup('user@example.com', 'password123');

      expect(usersRepo.findByEmail).toHaveBeenCalledWith('user@example.com');
      expect(usersRepo.create).toHaveBeenCalledOnce();
      expect(jwtService.sign).toHaveBeenCalledOnce();
      expect(token).toBe('signed.jwt.token');
    });

    it('should throw ConflictException when email is already in use', async () => {
      const { service } = makeAuthService({
        usersRepo: { findByEmail: vi.fn().mockResolvedValue(makeUser()) },
      });

      await expect(service.signup('user@example.com', 'password123')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should not store the plaintext password', async () => {
      const { service, usersRepo } = makeAuthService({
        usersRepo: {
          findByEmail: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(makeUser()),
        },
      });

      await service.signup('user@example.com', 'my-secret-password');

      const [, passwordHashArg] = (usersRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(passwordHashArg).not.toBe('my-secret-password');
      expect(passwordHashArg).toMatch(/^\$argon2id\$/);
    });
  });

  describe('signin', () => {
    it('should return a signed JWT when credentials are valid', async () => {
      const passwordHash = await argon2.hash('correctPassword', { type: argon2.argon2id });
      const { service, jwtService } = makeAuthService({
        usersRepo: {
          findByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash })),
        },
      });

      const token = await service.signin('user@example.com', 'correctPassword');

      expect(jwtService.sign).toHaveBeenCalledOnce();
      expect(token).toBe('signed.jwt.token');
    });

    it('should throw UnauthorizedException when user does not exist', async () => {
      const { service } = makeAuthService({
        usersRepo: { findByEmail: vi.fn().mockResolvedValue(null) },
      });

      await expect(service.signin('nobody@example.com', 'password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException when password is wrong', async () => {
      const passwordHash = await argon2.hash('correctPassword', { type: argon2.argon2id });
      const { service } = makeAuthService({
        usersRepo: {
          findByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash })),
        },
      });

      await expect(service.signin('user@example.com', 'wrongPassword')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should not reveal whether the email exists in the error response', async () => {
      const { service: serviceNoUser } = makeAuthService({
        usersRepo: { findByEmail: vi.fn().mockResolvedValue(null) },
      });
      const passwordHash = await argon2.hash('pass', { type: argon2.argon2id });
      const { service: serviceWrongPass } = makeAuthService({
        usersRepo: {
          findByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash })),
        },
      });

      let errNoUser: UnauthorizedException | undefined;
      let errWrongPass: UnauthorizedException | undefined;

      try { await serviceNoUser.signin('x@example.com', 'pass'); } catch (e) { errNoUser = e as UnauthorizedException; }
      try { await serviceWrongPass.signin('x@example.com', 'wrong'); } catch (e) { errWrongPass = e as UnauthorizedException; }

      const codeNoUser = (errNoUser!.getResponse() as { error: { code: string } }).error.code;
      const codeWrongPass = (errWrongPass!.getResponse() as { error: { code: string } }).error.code;
      expect(codeNoUser).toBe(codeWrongPass);
    });
  });

  describe('getJwks', () => {
    it('should return a JWKS object with one RS256 key', () => {
      const { service } = makeAuthService();

      const jwks = service.getJwks() as { keys: Array<{ alg: string; use: string; kid: string }> };

      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0].alg).toBe('RS256');
      expect(jwks.keys[0].use).toBe('sig');
      expect(jwks.keys[0].kid).toBe('auth-service-key-1');
    });

    it('should throw when the RSA key is invalid', () => {
      const { service } = makeAuthService({
        configService: makeConfigService('not-a-valid-pem-key'),
      });

      expect(() => service.getJwks()).toThrow();
    });
  });
});
