import { Controller, Inject } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { status } from "@grpc/grpc-js";
import { sql } from "drizzle-orm";
import { DRIZZLE_DB, type DrizzleDB } from "../database/database.module";

const SERVICES = ["", "acme.accounts.v1.AccountsService"];

@Controller()
export class HealthGrpcController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  // SERVING only while the database answers, like the HTTP readiness probe.
  @GrpcMethod("Health", "Check")
  async check(req: { service?: string }) {
    if (!SERVICES.includes(req.service ?? "")) {
      throw new RpcException({
        code: status.NOT_FOUND,
        message: "unknown service",
      });
    }
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: "SERVING" };
    } catch {
      return { status: "NOT_SERVING" };
    }
  }
}
