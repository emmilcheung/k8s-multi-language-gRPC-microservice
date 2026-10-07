import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import * as fs from "fs";
import * as path from "path";

// Walks up from this file to the repo's proto/ directory (source checkout) or
// the one the image copies next to dist/. Fails loud if neither exists.
function findAccountsProto(): string {
  const relative = path.join("proto", "accounts", "v1", "accounts.proto");
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`accounts.proto not found above ${__dirname}`);
}

export function attachGrpcServer(app: INestApplication): void {
  const port = app.get(ConfigService).getOrThrow<number>("GRPC_PORT");
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ["acme.accounts.v1", "grpc.health.v1"],
      protoPath: [findAccountsProto(), path.join(__dirname, "health.proto")],
      url: `0.0.0.0:${port}`,
      // Field names stay snake_case, exactly as in the proto.
      loader: { keepCase: true, enums: String, defaults: true, longs: String },
    },
  });
}
