import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { attachGrpcServer } from "./grpc/grpc.setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  attachGrpcServer(app);

  const port = process.env.PORT ?? 3004;
  await app.startAllMicroservices();
  await app.listen(port);
}

void bootstrap();
