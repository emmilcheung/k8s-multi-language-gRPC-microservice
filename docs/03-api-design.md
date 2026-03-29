# API Design

## External APIs (REST via Kong API Gateway)

- All external traffic enters through Kong — never expose a service pod directly.
- Use **REST + JSON** for public/client-facing APIs.
- Versioning in the path prefix: `/v1/orders`, `/v2/tickets`. Never break an existing version.

### HTTP Semantics

- `GET` — safe, idempotent reads.
- `POST` — non-idempotent creation.
- `PUT` — full replacement (idempotent).
- `PATCH` — partial update (idempotent where possible).
- `DELETE` — idempotent removal.

### HTTP Status Codes

- `200 OK`, `201 Created`, `204 No Content`
- `400 Bad Request` (validation failure), `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`
- `422 Unprocessable Entity` (semantic validation failure)
- `429 Too Many Requests` (rate limited)
- `500 Internal Server Error` (unhandled; never return stack traces)

### Error Response Format

Always use this consistent format:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable description",
    "details": [{ "field": "email", "issue": "must be a valid email" }]
  }
}
```

## Internal APIs (gRPC)

- **All synchronous service-to-service communication uses gRPC** — never REST between internal services.
- `.proto` files are the source of truth for the contract. Proto definitions live in `/proto/<domain>/<service>/v<N>/<file>.proto`.
- Use **proto3** syntax only.
- Version the package (`v1`, `v2`) — never delete or rename a field; only add new fields or new RPCs.
- Always define `google.protobuf.Timestamp` for time fields — never `string`.
- Wire IDs as `string` (UUIDs), not `int64`.
- Generated stubs live in `/libs/grpc-stubs/<lang>/` — regenerate with `make proto`.
- Set explicit deadlines on every client call (default: 5 s for reads, 10 s for writes).

### gRPC Status Codes

- `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `INTERNAL`, `UNAVAILABLE`.

## API Gateway (Kong)

- All Kong configuration is declarative (deck / KongIngress CRD) — never click-ops in the admin UI.
- Plugins applied globally (at gateway level): authentication, rate limiting, request logging, correlation ID injection.
- Plugins applied per-route: additional auth scopes, custom rate limits, request/response transformation.
- Never route internal gRPC traffic through Kong — gRPC stays on the internal cluster network.
