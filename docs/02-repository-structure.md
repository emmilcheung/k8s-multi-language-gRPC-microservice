# Repository & Project Structure

## Monorepo Layout

```
/
├── services/
│   ├── <service-name>/          # one directory per service
│   │   ├── src/                 # application source
│   │   ├── proto/               # .proto files owned by this service
│   │   ├── Dockerfile
│   │   ├── <lang-manifest>      # package.json / go.mod / pyproject.toml / pom.xml
│   │   └── README.md            # service-level docs (purpose, ports, env vars)
├── infra/
│   ├── k8s/                     # Kubernetes base manifests
│   ├── helm/                    # Helm charts per service
│   ├── terraform/               # EKS cluster, VPC, RDS, MSK, ElastiCache, Kong
│   └── scripts/                 # cluster bootstrap, secret seeding
├── proto/                       # shared .proto definitions (contracts between services)
├── libs/                        # shared libraries (generated gRPC stubs, common schemas)
├── docs/                        # engineering guidelines (this directory)
├── .github/workflows/           # CI/CD pipelines
└── AGENTS.md                    # agent guidelines (table of contents)
```

## Service Naming

- Kebab-case: `order-service`, `payment-service`, `notification-service`.
- Kubernetes objects follow the same name: deployment `order-service`, service `order-service`, namespace `<env>`.
- gRPC package names: `<company>.<domain>.<version>` e.g. `acme.orders.v1`.

## Language Choice

Choose the best language for the job; mixing languages across services is intentional.

- **TypeScript/Node.js** — event-driven, I/O-heavy services, BFF/API gateways.
- **Go** — high-throughput, latency-sensitive services (gRPC servers, stream processors).
- **Python** — ML inference, data pipelines, scripting.
- **Java/Kotlin** — enterprise integrations, batch workloads.

Whatever language is chosen, apply the same structural rules (validation, error handling, observability, testing) described in this documentation.
