#!/usr/bin/env bash
# infra/local/setup.sh — Local Kubernetes (minikube) bootstrap script
#
# What this script does:
#   1. Verifies required tools are installed (minikube, helm, kubectl, docker)
#   2. Starts minikube if not already running
#   3. Loads service images into minikube via `minikube image load`
#      (host Docker client v1.43 is too old to talk to minikube's daemon directly)
#   4. Creates the `ticketing` namespace (idempotent)
#   4.5 Annotates the namespace so Linkerd skips mTLS on outbound Kafka connections
#       (Linkerd's proxy drops idle Kafka binary-protocol connections on reconnect)
#   5. Creates K8s Secrets for each service from infra/local/secrets.env
#   6. Runs `helm upgrade --install` for the umbrella chart
#   7. Starts minikube tunnel so Kong's LoadBalancer is reachable on localhost:8000
#      and the Kafka external listener is reachable on localhost:9093
#
# Usage:
#   chmod +x infra/local/setup.sh
#   ./infra/local/setup.sh
#
# First-time setup:
#   cp infra/local/secrets.env.example infra/local/secrets.env
#   # Fill in RSA_PRIVATE_KEY and STRIPE_SECRET_KEY in secrets.env
#   # Then run this script from the repo root.
#
# After the script completes:
#   - Kong proxy:          http://localhost:8000
#   - Next.js app:         http://localhost:8000  (served via Kong)
#   - Kafka external:      localhost:9093  (for E2E tests — publishPaymentCaptured)
#
# Requirements (install once):
#   - minikube   https://minikube.sigs.k8s.io/docs/start/
#   - helm       https://helm.sh/docs/intro/install/
#   - kubectl    https://kubernetes.io/docs/tasks/tools/
#   - docker     https://docs.docker.com/get-docker/
#
# This script is idempotent — safe to re-run after code changes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELM_CHART="${REPO_ROOT}/infra/helm"
SECRETS_FILE="${REPO_ROOT}/infra/local/secrets.env"
GATEWAY_DIR="${REPO_ROOT}/services/kong-gateway"
NAMESPACE="ticketing"

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── 1. Verify required tools ──────────────────────────────────────────────────
step "1/7  Checking required tools..."
for tool in minikube helm kubectl docker; do
  command -v "$tool" &>/dev/null || error "'$tool' is not installed. See script header for install links."
done
info "All required tools found."

# ── Check secrets.env exists ──────────────────────────────────────────────────
if [[ ! -f "${SECRETS_FILE}" ]]; then
  error "secrets.env not found.
  Please create it from the example template:
    cp infra/local/secrets.env.example infra/local/secrets.env
    # Then fill in RSA_PRIVATE_KEY and STRIPE_SECRET_KEY
  Then re-run this script."
fi

# Read secrets.env safely (grep-based, no bash source — avoids PEM parsing issues)
_read_secret() {
  local key="$1"
  # Strip surrounding quotes if present; handle KEY=value and KEY="value"
  grep -m1 "^${key}=" "${SECRETS_FILE}" | sed "s/^${key}=//" | sed "s/^[\"']//" | sed "s/[\"']$//"
}

RSA_PRIVATE_KEY="$(_read_secret RSA_PRIVATE_KEY)"
STRIPE_SECRET_KEY="$(_read_secret STRIPE_SECRET_KEY)"
KONG_RSA_PUBLIC_KEY="$(_read_secret KONG_RSA_PUBLIC_KEY)"

# Validate required secrets are present and non-empty
for var in RSA_PRIVATE_KEY STRIPE_SECRET_KEY KONG_RSA_PUBLIC_KEY; do
  val="${!var}"
  if [[ -z "${val}" || "${val}" == "REPLACE_ME"* ]]; then
    error "${var} is not set in infra/local/secrets.env. Please fill in the real value."
  fi
done

# ── 2. Start minikube ─────────────────────────────────────────────────────────
step "2/7  Starting minikube..."
if minikube status --profile minikube 2>/dev/null | grep -q "Running"; then
  info "minikube is already running."
else
  info "Starting minikube (4 CPU, 7168 MB RAM, docker driver)..."
  minikube start \
    --cpus=4 \
    --memory=7168 \
    --disk-size=30g \
    --driver=docker
fi

# ── 3. Build + load service images into minikube ──────────────────────────────
step "3/7  Building and loading service images into minikube..."

# order-service must be built from repo root — its Dockerfile copies /proto
info "  Building order-service (build context: repo root)..."
docker build \
  --file "${REPO_ROOT}/services/order-service/Dockerfile" \
  --tag order-service:local \
  --quiet \
  "${REPO_ROOT}"
minikube image load order-service:local
info "  Loaded order-service:local"

# Build and load remaining services (parallel-safe: sequential for simplicity)
# Using a space-separated "name:dir" list to avoid Bash 4 associative arrays
# (macOS ships Bash 3.2 which lacks declare -A).
for SERVICE_ENTRY in \
  "auth-service:${REPO_ROOT}/services/auth-service" \
  "ticket-service:${REPO_ROOT}/services/ticket-service" \
  "payment-service:${REPO_ROOT}/services/payment-service" \
  "expiration-service:${REPO_ROOT}/services/expiration-service" \
  "client:${REPO_ROOT}/services/client" \
; do
  SERVICE="${SERVICE_ENTRY%%:*}"
  SERVICE_DIR="${SERVICE_ENTRY#*:}"
  info "  Building ${SERVICE}..."
  docker build \
    --file "${SERVICE_DIR}/Dockerfile" \
    --tag "${SERVICE}:local" \
    --quiet \
    "${SERVICE_DIR}"
  minikube image load "${SERVICE}:local"
  info "  Loaded ${SERVICE}:local"
done

info "All service images loaded into minikube."

# ── 4. Create namespace ───────────────────────────────────────────────────────
step "4/7  Creating namespace '${NAMESPACE}'..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
info "Namespace '${NAMESPACE}' is ready."

# ── 4.5 Linkerd namespace annotation ─────────────────────────────────────────
# Linkerd's sidecar proxy handles HTTP/gRPC well but drops idle Kafka binary-
# protocol connections on reconnect (attempts TLS handshake on a raw TCP stream).
# Annotating the namespace tells Linkerd to skip mTLS on all outbound port-9092
# connections from every pod in this namespace, so Kafka clients connect cleanly.
step "4.5/7  Annotating namespace for Linkerd Kafka skip..."
kubectl annotate namespace "${NAMESPACE}" \
  config.linkerd.io/skip-outbound-ports="9092" \
  --overwrite
info "Linkerd skip-outbound-ports=9092 annotation applied to namespace '${NAMESPACE}'."

# ── 5. Create K8s Secrets ─────────────────────────────────────────────────────
step "5/7  Creating Kubernetes Secrets..."

# In-cluster hostnames (Bitnami sub-chart service names, namespace: ticketing)
PG_AUTH_HOST="ticketing-postgres-auth"
PG_ORDERS_HOST="ticketing-postgres-orders"
PG_PAYMENTS_HOST="ticketing-postgres-payments"
MONGO_HOST="ticketing-mongodb"
REDIS_HOST="ticketing-redis-master"
KAFKA_HOST="ticketing-cp-kafka.ticketing.svc.cluster.local"   # in-cluster cp-kafka broker

# Passwords (matching values-local.yaml Bitnami config)
PG_AUTH_PASS="auth-local-secret"
PG_ORDERS_PASS="orders-local-secret"
PG_PAYMENTS_PASS="payments-local-secret"

# Helper: create or replace a secret (delete + recreate for idempotency)
apply_secret() {
  local name="$1"; shift
  kubectl delete secret "${name}" -n "${NAMESPACE}" --ignore-not-found=true
  kubectl create secret generic "${name}" \
    --namespace="${NAMESPACE}" \
    "$@"
  info "  Secret '${name}' applied."
}

# auth-service-secrets
apply_secret auth-service-secrets \
  --from-literal=DATABASE_URL="postgresql://auth_user:${PG_AUTH_PASS}@${PG_AUTH_HOST}:5432/auth_db" \
  --from-literal=RSA_PRIVATE_KEY="${RSA_PRIVATE_KEY}" \
  --from-literal=JWT_EXPIRY="15m" \
  --from-literal=COOKIE_DOMAIN="localhost" \
  --from-literal=KAFKA_BROKERS="${KAFKA_HOST}:9092" \
  --from-literal=REDIS_URL="redis://${REDIS_HOST}:6379"

# ticket-service-secrets
apply_secret ticket-service-secrets \
  --from-literal=MONGO_URI="mongodb://mongo_user:mongo-local-secret@${MONGO_HOST}:27017/tickets?authSource=tickets" \
  --from-literal=MONGO_DB="tickets" \
  --from-literal=KAFKA_BROKERS="${KAFKA_HOST}:9092"

# order-service-secrets
apply_secret order-service-secrets \
  --from-literal=SPRING_DATASOURCE_URL="jdbc:postgresql://${PG_ORDERS_HOST}:5432/orders_db" \
  --from-literal=SPRING_DATASOURCE_USERNAME="orders_user" \
  --from-literal=SPRING_DATASOURCE_PASSWORD="${PG_ORDERS_PASS}" \
  --from-literal=KAFKA_BROKERS="${KAFKA_HOST}:9092" \
  --from-literal=TICKET_SERVICE_GRPC_HOST="ticketing-ticket-service.ticketing.svc.cluster.local" \
  --from-literal=TICKET_SERVICE_GRPC_PORT="50051" \
  --from-literal=ORDER_EXPIRATION_MINUTES="15"

# payment-service-secrets
apply_secret payment-service-secrets \
  --from-literal=DATABASE_URL="postgresql://payments_user:${PG_PAYMENTS_PASS}@${PG_PAYMENTS_HOST}:5432/payments_db" \
  --from-literal=STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY}" \
  --from-literal=KAFKA_BROKERS="${KAFKA_HOST}:9092"

# expiration-service-secrets
apply_secret expiration-service-secrets \
  --from-literal=REDIS_ADDR="${REDIS_HOST}:6379" \
  --from-literal=KAFKA_BROKERS="${KAFKA_HOST}:9092"

info "All secrets created."

# ── 5.5 Render Kong config ────────────────────────────────────────────────────
# Build the declarative kong.yml from the base template + minikube values.
# The rendered file is passed to helm via --set-file so no ConfigMap is needed.
step "5.5/7  Rendering Kong config for minikube..."
RENDERED_KONG_YML="${REPO_ROOT}/services/kong-gateway/kong.yml"
KONG_RSA_PUBLIC_KEY="${KONG_RSA_PUBLIC_KEY}" \
  bash "${GATEWAY_DIR}/scripts/build.sh" minikube "${RENDERED_KONG_YML}"
info "Kong config rendered: ${RENDERED_KONG_YML}"

# ── 6. Helm install/upgrade ───────────────────────────────────────────────────
step "6/7  Running helm upgrade --install..."

# Ensure dependencies are up-to-date (no-op if already fetched)
helm dependency update "${HELM_CHART}" --skip-refresh 2>/dev/null || \
  helm dependency update "${HELM_CHART}"

helm upgrade --install ticketing "${HELM_CHART}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "${HELM_CHART}/values-local.yaml" \
  --set-file "kong.dblessConfig.config=${RENDERED_KONG_YML}" \
  --set "mongodb.auth.existingSecret=" \
  --set "auth-service.secretRef=auth-service-secrets" \
  --set "ticket-service.secretRef=ticket-service-secrets" \
  --set "order-service.secretRef=order-service-secrets" \
  --set "payment-service.secretRef=payment-service-secrets" \
  --set "expiration-service.secretRef=expiration-service-secrets" \
  --timeout 10m \
  --wait

info "Helm release 'ticketing' is up."

# ── 7. Start minikube tunnel ──────────────────────────────────────────────────
step "7/7  Starting minikube tunnel..."
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗
║              Local Kubernetes stack is ready!              ║
╠══════════════════════════════════════════════════════════╣
║  Kong proxy    :  http://localhost:8000                    ║
║  Next.js app   :  http://localhost:8000  (via Kong)        ║
║  Kafka external:  localhost:9093  (E2E test producer)      ║
║                                                            ║
║  Check pods:  kubectl get pods -n ticketing                ║
║  Tear down :  helm uninstall ticketing -n ticketing        ║
║               kubectl delete namespace ticketing           ║
║               minikube stop                                ║
╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Starting minikube tunnel — you may be prompted for your sudo password."
info "Keep this terminal open. Press Ctrl+C to stop the tunnel."
echo ""

minikube tunnel
