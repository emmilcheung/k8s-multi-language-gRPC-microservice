import { Module } from "@nestjs/common";
import { AccountsModule } from "../modules/accounts/accounts.module";
import { AccountsGrpcController } from "./accounts.grpc.controller";
import { HealthGrpcController } from "./health.grpc.controller";

@Module({
  imports: [AccountsModule],
  controllers: [AccountsGrpcController, HealthGrpcController],
})
export class GrpcModule {}
