import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Res } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';

@Controller('healthz')
export class HealthController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  // Liveness: is the process alive? No dependency checks.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: can we serve traffic? Checks DB connectivity.
  @Get('ready')
  async ready(@Res() res: Response) {
    try {
      await this.db.execute(sql`SELECT 1`);
      return res.status(HttpStatus.OK).json({ status: 'ok' });
    } catch {
      // Return 503 if DB is unreachable — Kubernetes will stop routing traffic here
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'unavailable', detail: 'database unreachable' });
    }
  }
}
