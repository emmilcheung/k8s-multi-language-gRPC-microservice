# Kubernetes & EKS Deployment

## Manifest Conventions

Use **Helm charts** per service — no raw manifest files checked in (except cluster bootstrap).

Chart values are environment-specific: `values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`.

Every Deployment must define:
- `resources.requests` and `resources.limits` (CPU and memory) — no unbounded pods.
- `livenessProbe` and `readinessProbe`.
- `terminationGracePeriodSeconds` (≥ 30 s for graceful shutdown).
- `podDisruptionBudget` (at least 1 pod always available in prod).
- `topologySpreadConstraints` or `podAntiAffinity` to spread across AZs.

Replicas: minimum 2 in staging, minimum 3 in production.

Use `HorizontalPodAutoscaler` (HPA) with CPU and/or custom metrics.

## Namespace Strategy

```
<service>-dev
<service>-staging
<service>-prod
infra          # Kong, observability stack, cert-manager
```

## Configuration & Secrets

- ConfigMaps for non-sensitive config (feature flags, tuning params).
- Secrets via External Secrets Operator pulling from AWS Secrets Manager — never commit secret values.
- Environment variable naming: `SCREAMING_SNAKE_CASE`.

## Networking

- Services communicate via Kubernetes `Service` DNS: `<service-name>.<namespace>.svc.cluster.local`.
- Use `NetworkPolicy` to restrict ingress/egress — only allow known communication paths.
- Kong Ingress Controller manages external ingress — no `NodePort` in production.

## Release Checks

- Before order-service migration `V8__order_idempotency.sql` runs in an environment, this must return no rows, or the unique index fails and Flyway aborts:
  `SELECT reservation_id FROM orders WHERE reservation_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;`
- The index build blocks writes to `orders` while it runs. Outside a small table, build it first by hand, outside a transaction, and let the migration's `IF NOT EXISTS` make it a no-op:
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_orders_reservation_id ON orders (reservation_id) WHERE reservation_id IS NOT NULL;`
  A failed concurrent build leaves an invalid index that `IF NOT EXISTS` skips silently: check `pg_index.indisvalid` and drop it before retrying.

## EKS-Specific

- Use managed node groups with Karpenter for auto-scaling.
- IAM Roles for Service Accounts (IRSA) — never use long-lived AWS credentials in pods.
- Enable EKS control plane logging (API, audit, authenticator, controller manager, scheduler).
- Use AWS Load Balancer Controller for `Service` type `LoadBalancer`.
- Store Terraform state in S3 + DynamoDB lock — never local state in CI.
