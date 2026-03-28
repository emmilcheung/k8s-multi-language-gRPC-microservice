// Package tracing initialises the OpenTelemetry SDK for expiration-service.
// Call Init() early in main(); the returned shutdown function must be deferred.
// When OTEL_EXPORTER_OTLP_ENDPOINT is empty the SDK runs in no-op mode.
package tracing

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.uber.org/zap"
)

// Init sets up the global OTel TracerProvider and TextMapPropagator.
// Returns a shutdown function that flushes pending spans.
func Init(ctx context.Context, serviceName string, log *zap.Logger) func(context.Context) {
	collectorURL := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(serviceName),
		),
	)
	if err != nil {
		log.Warn("failed to build OTel resource, using default", zap.Error(err))
		res = resource.Default()
	}

	var tp *sdktrace.TracerProvider
	if collectorURL != "" {
		exporter, exporterErr := otlptracegrpc.New(ctx,
			otlptracegrpc.WithEndpoint(collectorURL),
			otlptracegrpc.WithInsecure(),
		)
		if exporterErr != nil {
			log.Warn("OTel exporter init failed, tracing disabled", zap.Error(exporterErr))
			tp = sdktrace.NewTracerProvider(sdktrace.WithResource(res))
		} else {
			tp = sdktrace.NewTracerProvider(
				sdktrace.WithBatcher(exporter),
				sdktrace.WithResource(res),
			)
			log.Info("OpenTelemetry tracing enabled", zap.String("endpoint", collectorURL))
		}
	} else {
		tp = sdktrace.NewTracerProvider(sdktrace.WithResource(res))
		log.Info("OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing in no-op mode")
	}

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func(ctx context.Context) {
		if err := tp.Shutdown(ctx); err != nil {
			log.Error("OTel TracerProvider shutdown error", zap.Error(err))
		}
	}
}
