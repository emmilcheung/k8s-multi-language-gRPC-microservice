# Caching & Rate Limiting

## Caching Strategy

- **Cache at the gateway (Kong)**: response caching for public, read-heavy endpoints.
- **Cache at the service**: application-level cache in Redis for expensive DB reads or aggregations.
- Cache invalidation: prefer **event-driven invalidation** (listen to domain events that mutate the entity) over time-based expiry for accuracy-critical data.
- Never cache: authentication responses, user-specific write confirmations, financial totals, any data with security implications.
- Cache-aside pattern (lazy loading) is the default. Only use write-through/write-behind when consistency requirements demand it.

## Rate Limiting

- Global rate limiting: configured in Kong using the `rate-limiting` or `rate-limiting-advanced` plugin backed by Redis (cluster mode).
- Limits applied at: IP level (anonymous), consumer/API-key level (authenticated), and per-route.
- Respond with `429 Too Many Requests` and include headers:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: <unix-timestamp>
  Retry-After: 60
  ```
- Internal services are exempt from public rate limits but have separate circuit-breaker thresholds.
