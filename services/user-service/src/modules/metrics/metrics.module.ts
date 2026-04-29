import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { PrometheusModule } from "@willsoto/nestjs-prometheus";
import { HttpRedMetricsMiddleware } from "./http-red.middleware";
import { MetricsController } from "./metrics.controller";

@Module({
  imports: [
    PrometheusModule.register({
      path: "/metrics",
      defaultMetrics: { enabled: true },
    }),
  ],
  controllers: [MetricsController],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpRedMetricsMiddleware).forRoutes("*");
  }
}
