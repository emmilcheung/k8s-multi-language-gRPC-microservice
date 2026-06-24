package kafka

import (
	"context"
	"fmt"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type kafkaHeaderCarrier struct {
	headers *[]confluent.Header
}

func (c kafkaHeaderCarrier) Get(key string) string {
	for _, header := range *c.headers {
		if header.Key == key {
			return string(header.Value)
		}
	}
	return ""
}

func (c kafkaHeaderCarrier) Set(key, value string) {
	for index, header := range *c.headers {
		if header.Key == key {
			(*c.headers)[index].Value = []byte(value)
			return
		}
	}
	*c.headers = append(*c.headers, confluent.Header{Key: key, Value: []byte(value)})
}

func (c kafkaHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(*c.headers))
	for _, header := range *c.headers {
		keys = append(keys, header.Key)
	}
	return keys
}

func startKafkaConsumerSpan(ctx context.Context, topic string, headers []confluent.Header) (context.Context, trace.Span) {
	return StartKafkaConsumerSpan(ctx, topic, headers)
}

// StartKafkaConsumerSpan extracts the W3C trace context from Kafka message
// headers and starts a consumer span as a child of the remote producer span.
// Exported so that other internal packages (e.g. search.Indexer) can propagate
// trace context from consumed messages without duplicating the carrier logic.
func StartKafkaConsumerSpan(ctx context.Context, topic string, headers []confluent.Header) (context.Context, trace.Span) {
	parent := otel.GetTextMapPropagator().Extract(ctx, kafkaHeaderCarrier{headers: &headers})
	return otel.Tracer("ticket-service").Start(
		parent,
		fmt.Sprintf("kafka consume %s", topic),
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination.name", topic),
		),
	)
}

func startKafkaProducerSpan(ctx context.Context, topic string) (context.Context, trace.Span, []confluent.Header) {
	spanCtx, span := otel.Tracer("ticket-service").Start(
		ctx,
		fmt.Sprintf("kafka publish %s", topic),
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination.name", topic),
		),
	)
	headers := make([]confluent.Header, 0, 4)
	otel.GetTextMapPropagator().Inject(spanCtx, kafkaHeaderCarrier{headers: &headers})
	return spanCtx, span, headers
}

func injectKafkaContextHeaders(ctx context.Context, headers []confluent.Header) []confluent.Header {
	cloned := append([]confluent.Header(nil), headers...)
	otel.GetTextMapPropagator().Inject(ctx, kafkaHeaderCarrier{headers: &cloned})
	return cloned
}

func recordSpanError(span trace.Span, err error) {
	if err == nil {
		return
	}
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
}
