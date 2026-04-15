# user-service

Owns user profile, preferences, and billing address data.

Auth and session token issuance remain in auth-service. This service requires `X-User-Id` on all `/api/user-settings` routes and only reads/writes data for that caller.

## Endpoints

- `GET /api/user-settings/profile`
- `PUT /api/user-settings/profile`
- `GET /api/user-settings/preferences`
- `PUT /api/user-settings/preferences`
- `GET /api/user-settings/billing-address`
- `PUT /api/user-settings/billing-address`
- `GET /healthz/live`
- `GET /healthz/ready`

## Local Run

```bash
pnpm install
# Required only when running the service directly on the host.
pnpm migrate
pnpm start:dev
```

Under Docker Compose and in the production container image, migrations run automatically before the service boots. If the schema is missing, startup fails loudly and `/healthz/ready` stays unavailable.

## Environment

See `.env.example`.
