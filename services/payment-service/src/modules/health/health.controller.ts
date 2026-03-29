import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Res } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { KafkaChecker } from './kafka.checker';

@Controller('healthz')
export class HealthController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly kafkaChecker: KafkaChecker,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    try {
      await this.db.execute(sql`SELECT 1`);
      await this.kafkaChecker.ping();
      return res.status(HttpStatus.OK).json({ status: 'ok' });
    } catch {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'unavailable', detail: 'dependency unreachable' });
    }
  }
}
