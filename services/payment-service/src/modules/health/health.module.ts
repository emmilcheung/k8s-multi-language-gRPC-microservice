import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { KafkaChecker } from './kafka.checker';
import { SchemaChecker, SchemaStartupVerifier } from './schema.checker';

@Module({
  controllers: [HealthController],
  providers: [KafkaChecker, SchemaChecker, SchemaStartupVerifier],
})
export class HealthModule {}
