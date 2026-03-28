/**
 * Next.js built-in instrumentation hook (O-01).
 * This file is loaded once by the Next.js runtime before any page or API route.
 * @vercel/otel auto-wires the OTel SDK with sensible defaults for Next.js App Router.
 *
 * Set OTEL_EXPORTER_OTLP_ENDPOINT at runtime to export traces to a collector.
 * When not set, the SDK operates in no-op mode (no traces exported).
 */
import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'client',
  });
}
