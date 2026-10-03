/**
 * OpenTelemetry bootstrap. Loaded before the app via
 * NODE_OPTIONS="--import ./dist/tracing.js" (ESM equivalent of auth-service's
 * --require). With OTEL_EXPORTER_OTLP_ENDPOINT unset the SDK exports nothing,
 * so the service still starts without a collector.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'mcp-service',
    [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
  }),
  traceExporter: collectorUrl
    ? new OTLPTraceExporter({ url: collectorUrl })
    : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

/** Called by main's single SIGTERM handler, after the server has drained. */
export const shutdownTracing = (): Promise<void> => sdk.shutdown();
