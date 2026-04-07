# End-to-End Observability Report

Generated: 2026-04-07T11:33:49.728Z

## Outcome

- Result: PASS
- Flow: seller signup -> ticket create -> buyer signup -> order create -> payment submit -> order complete
- Final order status: complete
- Payment status: completed

## Trace Verification

### Order Trace

- Trace ID: 11111111111111111111111169d4eb84
- Services observed: order-service, payment-service, ticket-service, expiration-service
- Key operations: INSERT orders_db.orders, INSERT orders_db.outbox, OrderRepository.save, OrderTicketRepository.findById, OutboxRepository.save, POST /api/orders, SELECT orders_db.order_tickets, SELECT orders_db.orders, Session.find com.ticketing.orders.entity.OrderTicket, Session.merge com.ticketing.orders.entity.Order, Session.persist com.ticketing.orders.entity.OutboxMessage, Transaction.commit

### Payment Trace

- Trace ID: 22222222222222222222222269d4eb84
- Services observed: payment-service, order-service, ticket-service
- Key operations: INSERT orders_db.outbox, OrderRepository.findByIdWithTicket, OrderRepository.save, OrderSeatRepository.findAllByOrderId, OutboxRepository.save, POST /api/payments, PaymentsController.charge, SELECT, SELECT com.ticketing.orders.entity.OrderSeat, SELECT orders_db, SELECT orders_db.order_seats, Session.merge com.ticketing.orders.entity.Order, Session.persist com.ticketing.orders.entity.OutboxMessage, Transaction.commit

## Prometheus Targets

| Job | Health | Scrape URL |
| --- | --- | --- |
| auth-service | up | http://auth-service:3000/metrics |
| expiration-service | up | http://expiration-service:8083/metrics |
| kong | up | http://kong:8100/metrics |
| order-service | up | http://order-service:8082/actuator/prometheus |
| otel-collector | up | http://otel-collector:8888/metrics |
| payment-service | up | http://payment-service:3002/metrics |
| prometheus | up | http://prometheus:9090/metrics |
| ticket-service | up | http://ticket-service:3001/metrics |
| venue-service | up | http://venue-service:3003/metrics |

## Screenshots

### Prometheus Targets

![Prometheus Targets](./screenshots/prometheus-targets.png)

### Grafana Local Platform Overview

![Grafana Local Platform Overview](./screenshots/grafana-local-platform-overview.png)

### Jaeger Order Trace

![Jaeger Order Trace](./screenshots/jaeger-order-trace.png)

### Jaeger Payment Trace

![Jaeger Payment Trace](./screenshots/jaeger-payment-trace.png)

## Notes

- Grafana was captured from the provisioned `Local Platform Overview` dashboard.
- Jaeger screenshots were captured from direct trace detail pages for the generated trace IDs.
- Prometheus remained healthy for all locally scraped application targets during this run.

