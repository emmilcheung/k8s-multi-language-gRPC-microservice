import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, register } from 'prom-client';

const SERVICE_NAME = 'auth-service';
const REQUEST_COUNT_METRIC = 'http_requests_total';
const REQUEST_DURATION_METRIC = 'http_request_duration_seconds';

type HttpLabels = 'service' | 'method' | 'route' | 'status_code';

function getOrCreateCounter(registry: Registry): Counter<HttpLabels> {
  const existing = registry.getSingleMetric(REQUEST_COUNT_METRIC);
  if (existing) {
    return existing as Counter<HttpLabels>;
  }

  return new Counter<HttpLabels>({
    name: REQUEST_COUNT_METRIC,
    help: 'Total number of HTTP requests received',
    labelNames: ['service', 'method', 'route', 'status_code'],
    registers: [registry],
  });
}

function getOrCreateHistogram(registry: Registry): Histogram<HttpLabels> {
  const existing = registry.getSingleMetric(REQUEST_DURATION_METRIC);
  if (existing) {
    return existing as Histogram<HttpLabels>;
  }

  return new Histogram<HttpLabels>({
    name: REQUEST_DURATION_METRIC,
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['service', 'method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
}

function resolveRoute(req: Request): string {
  const routePath = extractRoutePath((req as { route?: unknown }).route);
  if (typeof routePath === 'string') {
    return `${req.baseUrl || ''}${routePath}`;
  }

  if (Array.isArray(routePath)) {
    return `${req.baseUrl || ''}${routePath.join('|')}`;
  }

  return req.path || req.originalUrl.split('?')[0] || 'unknown';
}

function extractRoutePath(route: unknown): string | string[] | undefined {
  if (typeof route !== 'object' || route === null || !('path' in route)) {
    return undefined;
  }

  const value = (route as { path?: unknown }).path;
  if (typeof value === 'string') {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === 'string')
  ) {
    return value;
  }

  return undefined;
}

@Injectable()
export class HttpRedMetricsMiddleware implements NestMiddleware {
  private readonly requestCounter = getOrCreateCounter(register);
  private readonly requestDuration = getOrCreateHistogram(register);

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const labels = {
        service: SERVICE_NAME,
        method: req.method,
        route: resolveRoute(req),
        status_code: String(res.statusCode),
      } as const;

      this.requestCounter.inc(labels);
      this.requestDuration.observe(labels, durationSeconds);
    });

    next();
  }
}
