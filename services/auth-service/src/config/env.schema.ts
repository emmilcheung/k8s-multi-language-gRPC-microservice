import { z } from 'zod';
import {
  oauthEnvFields,
  refineOAuthConfig,
} from '../modules/oauth/oauth-config';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(12),
    RSA_PRIVATE_KEY: z.string(),
    JWT_EXPIRY: z.string().default('15m'),
    JWT_COOKIE_NAME: z.string().default('token'),
    REFRESH_COOKIE_NAME: z.string().default('refreshToken'),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),
    SIGNIN_FAILURE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    SIGNIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    SIGNIN_LOCKOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    REFRESH_COOKIE_PATH: z.string().default('/'),
    ACCESS_TOKEN_COOKIE_SAME_SITE: z
      .enum(['strict', 'lax', 'none'])
      .default('strict'),
    REFRESH_TOKEN_COOKIE_SAME_SITE: z
      .enum(['strict', 'lax', 'none'])
      .default('strict'),
    COOKIE_DOMAIN: z.string().optional(),
    REDIS_URL: z.string(),
    // OAuth2 redirect helpers — used by OAuthService to build cross-service URLs.
    KONG_BASE_URL: z.string().url().default('http://localhost:8000'),
    OAUTH_CLIENT_BASE_URL: z.string().url().default('http://localhost:4000'),
    X_USER_ID_SIGNING_KEY: z.string().optional().default(''),
    ...oauthEnvFields,
  })
  .superRefine((config, ctx) => {
    refineOAuthConfig(config, ctx);
    if (
      config.NODE_ENV === 'production' &&
      (!config.X_USER_ID_SIGNING_KEY ||
        config.X_USER_ID_SIGNING_KEY.length < 32)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['X_USER_ID_SIGNING_KEY'],
        message:
          'X_USER_ID_SIGNING_KEY must be at least 32 characters in production',
      });
    }
  });
