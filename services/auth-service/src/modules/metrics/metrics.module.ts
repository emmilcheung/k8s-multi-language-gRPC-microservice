import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { HttpRedMetricsMiddleware } from './http-red.middleware';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpRedMetricsMiddleware).forRoutes('*');
  }
}
