import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { KafkaChecker } from './kafka.checker';

@Module({ controllers: [HealthController], providers: [KafkaChecker] })
export class HealthModule {}
