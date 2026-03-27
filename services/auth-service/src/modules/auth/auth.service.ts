import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as argon2 from 'argon2';
import { createPublicKey } from 'crypto';
import { UsersRepository } from '../users/users.repository';

export interface JwtPayload {
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface CurrentUser {
  id: string;
  email: string;
}

@Injectable()
export class AuthService {
  private readonly rsaPrivateKey: string;

  constructor(
    @InjectPinoLogger(AuthService.name)
    private readonly logger: PinoLogger,
    private readonly usersRepo: UsersRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    // Load and validate RSA private key at construction time (fail loudly)
    const raw = this.config.getOrThrow<string>('RSA_PRIVATE_KEY');
    // Support both raw PEM and base64-encoded PEM (useful for env var injection)
    this.rsaPrivateKey = raw.includes('-----BEGIN')
      ? raw.replace(/\\n/g, '\n')
      : Buffer.from(raw, 'base64').toString('utf-8');
  }

  async signup(email: string, password: string): Promise<string> {
    const existing = await this.usersRepo.findByEmail(email);
    if (existing) {
      throw new ConflictException({
        error: {
          code: 'EMAIL_IN_USE',
          message: 'An account with this email already exists',
        },
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MiB
      timeCost: 3,
      parallelism: 4,
    });

    const user = await this.usersRepo.create(email, passwordHash);
    this.logger.info({ userId: user.id }, 'User created');

    return this.issueToken({ sub: user.id, email: user.email });
  }

  async signin(email: string, password: string): Promise<string> {
    const user = await this.usersRepo.findByEmail(email);
    if (!user) {
      // Constant-time failure to prevent user enumeration
      await argon2.hash('dummy-constant-time-comparison');
      throw new UnauthorizedException({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    this.logger.info({ userId: user.id }, 'User signed in');
    return this.issueToken({ sub: user.id, email: user.email });
  }

  getJwks(): object {
    try {
      const publicKey = createPublicKey(this.rsaPrivateKey);
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        keys: [
          {
            ...jwk,
            use: 'sig',
            alg: 'RS256',
            kid: 'auth-service-key-1',
          },
        ],
      };
    } catch (err) {
      this.logger.error({ err }, 'Failed to export JWKS public key');
      throw new InternalServerErrorException({
        error: { code: 'JWKS_ERROR', message: 'Failed to load JWKS' },
      });
    }
  }

  private issueToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    // jwtService.sign has return type `any` — double-cast avoids no-unsafe-return/assignment
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.jwtService.sign(payload) as string;
  }
}
