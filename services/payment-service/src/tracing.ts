/**
 * OpenTelemetry SDK bootstrap — must be required before any other module.
 *
 * Loaded via NODE_OPTIONS="--require ./dist/tracing" in the Dockerfile CMD so it
 * runs before NestJS bootstraps any module. When OTEL_EXPORTER_OTLP_ENDPOINT is
 * not set the SDK starts in no-op mode (no traces exported), which keeps the
 * service functional in environments without an OTel Collector.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'payment-service';
const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
  }),
  // Only configure the exporter when a collector URL is provided.
  // When absent the SDK uses a no-op exporter so the service starts cleanly.
  traceExporter: collectorUrl ? new OTLPTraceExporter({ url: collectorUrl }) : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation — it is very noisy and low value
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Flush and shutdown traces on process exit
process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .catch((err: unknown) => console.error('OTel shutdown error', err));
});
