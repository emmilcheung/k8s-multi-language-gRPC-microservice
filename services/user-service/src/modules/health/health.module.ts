import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { SchemaChecker, SchemaStartupVerifier } from "./schema.checker";

@Module({
  controllers: [HealthController],
  providers: [SchemaChecker, SchemaStartupVerifier],
})
export class HealthModule {}
