# Makefile — Local Kubernetes (minikube) deployment
#
# Usage:
#   make help          — show all available targets
#   make up            — full bootstrap: start minikube, build images, deploy
#   make deploy        — re-deploy only (skip minikube start + image builds)
#   make build         — build and load all service images into minikube
#   make tunnel        — expose Kong + Kafka on localhost via minikube tunnel
#   make down          — tear down the Helm release and namespace
#   make stop          — stop minikube
#   make status        — show all pods in the ticketing namespace
#   make logs          — tail logs for a specific service  (make logs SVC=auth-service)
#   make restart       — rolling restart a specific service (make restart SVC=client)
#   make secrets       — (re)create all Kubernetes secrets from infra/local/secrets.env
#   make kong-config   — re-render kong.yml from kong.base.yml template
#   make helm-upgrade  — run helm upgrade --install only (fastest re-deploy)
#
# First-time setup (run from the repo root):
#   1. cp infra/local/secrets.env.example infra/local/secrets.env
#   2. Fill in RSA_PRIVATE_KEY, KONG_RSA_PUBLIC_KEY, STRIPE_SECRET_KEY
#   3. make -C infra/local up   (or: cd infra/local && make up)

# ── Configuration ─────────────────────────────────────────────────────────────

REPO_ROOT     := $(shell cd "$(dir $(abspath $(lastword $(MAKEFILE_LIST))))/../.." && pwd)
HELM_CHART    := $(REPO_ROOT)/infra/helm
SECRETS_FILE  := $(REPO_ROOT)/infra/local/secrets.env
GATEWAY_DIR   := $(REPO_ROOT)/services/kong-gateway
KONG_YML      := $(GATEWAY_DIR)/kong.yml
NAMESPACE     := ticketing
HELM_RELEASE  := ticketing

# Read a value from infra/local/secrets.env without sourcing the file
_secret = $(shell grep -m1 "^$(1)=" "$(SECRETS_FILE)" 2>/dev/null | sed 's/^$(1)=//' | sed "s/^[\"']//" | sed "s/[\"']$$//")

# ── Colours ───────────────────────────────────────────────────────────────────
CYAN  := \033[0;36m
GREEN := \033[0;32m
RESET := \033[0m

# ── Infra image versions (must match what the Helm chart requests) ────────────
# Bitnami only publishes :latest on Docker Hub — pinned tags don't exist there.
# We pull :latest, retag to the exact version the chart expects, then load into
# minikube so kubelet finds them locally (imagePullPolicy: IfNotPresent).
POSTGRESQL_IMG := docker.io/bitnami/postgresql:17.5.0-debian-12-r6
MONGODB_IMG    := docker.io/bitnami/mongodb:8.0.9-debian-12-r1
REDIS_IMG      := docker.io/bitnami/redis:7.4.2-debian-12-r4
CP_KAFKA_IMG   := confluentinc/cp-kafka:7.7.1
KONG_IMG       := kong:3.9

# ── Phony targets ─────────────────────────────────────────────────────────────
.PHONY: help up deploy build build-order build-services load-infra-images \
        secrets kong-config helm-upgrade \
        tunnel status logs restart \
        down stop clean

# ─────────────────────────────────────────────────────────────────────────────
## help : Show this help message
# ─────────────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Ticketing platform — local Kubernetes deployment"
	@echo ""
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "up"                "Full bootstrap (minikube + images + deploy)"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "deploy"            "Re-deploy without rebuilding images"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "build"             "Build + load all service images into minikube"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "load-infra-images" "Pull + load Bitnami/Kong/Kafka images into minikube"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "helm-upgrade"      "Run helm upgrade only (fastest re-deploy)"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "kong-config"       "Re-render Kong config from template"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "secrets"           "Re-create all Kubernetes secrets"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "tunnel"            "Start minikube tunnel (sudo required)"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "status"            "Show all pods in the ticketing namespace"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "logs"              "Tail logs  — make logs SVC=auth-service"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "restart"           "Rolling restart — make restart SVC=client"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "down"              "Uninstall Helm release + delete namespace"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "stop"              "Stop minikube"
	@printf "  $(CYAN)%-20s$(RESET) %s\n" "clean"             "down + stop (full teardown)"
	@echo ""
	@echo "  Endpoints after 'make tunnel':"
	@echo "    Kong / Next.js app : http://localhost:8000"
	@echo "    Kafka (E2E tests)  : localhost:9093"
	@echo ""

# ─────────────────────────────────────────────────────────────────────────────
## up : Full bootstrap — start minikube, build images, create secrets, deploy
# ─────────────────────────────────────────────────────────────────────────────
up: _check-secrets _check-tools _minikube-start load-infra-images build secrets kong-config helm-upgrade
	@echo ""
	@printf "$(GREEN)╔══════════════════════════════════════════════════════════╗$(RESET)\n"
	@printf "$(GREEN)║         Local Kubernetes stack is ready!                 ║$(RESET)\n"
	@printf "$(GREEN)╠══════════════════════════════════════════════════════════╣$(RESET)\n"
	@printf "$(GREEN)║  Kong / Next.js : http://localhost:8000                  ║$(RESET)\n"
	@printf "$(GREEN)║  Kafka (E2E)    : localhost:9093                         ║$(RESET)\n"
	@printf "$(GREEN)║                                                          ║$(RESET)\n"
	@printf "$(GREEN)║  Run 'make tunnel' in a separate terminal to expose      ║$(RESET)\n"
	@printf "$(GREEN)║  the LoadBalancer services on localhost.                 ║$(RESET)\n"
	@printf "$(GREEN)╚══════════════════════════════════════════════════════════╝$(RESET)\n"

# ─────────────────────────────────────────────────────────────────────────────
## deploy : Re-deploy without rebuilding images (secrets + kong-config + helm)
# ─────────────────────────────────────────────────────────────────────────────
deploy: _check-secrets secrets kong-config helm-upgrade

# ─────────────────────────────────────────────────────────────────────────────
## build : Build all service Docker images and load them into minikube
# ─────────────────────────────────────────────────────────────────────────────
build: build-order build-services
	@echo "All images loaded into minikube."

# order-service uses the repo root as its Docker build context (copies /proto)
build-order:
	@echo "  Building order-service (context: repo root)..."
	@docker build \
		--file $(REPO_ROOT)/services/order-service/Dockerfile \
		--tag order-service:local \
		--quiet \
		$(REPO_ROOT)
	@minikube image load order-service:local
	@echo "  Loaded order-service:local"

# All other services use their own directory as the build context
build-services:
	@for svc in auth-service ticket-service payment-service expiration-service client; do \
		echo "  Building $$svc..."; \
		docker build \
			--file $(REPO_ROOT)/services/$$svc/Dockerfile \
			--tag $$svc:local \
			--quiet \
			$(REPO_ROOT)/services/$$svc; \
		minikube image load $$svc:local; \
		echo "  Loaded $$svc:local"; \
	done

# ─────────────────────────────────────────────────────────────────────────────
## load-infra-images : Pull backing-service images and load them into minikube
##
## Bitnami only publishes :latest on Docker Hub — pinned tags return "manifest
## unknown". We pull :latest, retag to the exact version the Helm chart
## requests, then 'minikube image load' so kubelet finds them locally.
## Skips each image if it is already present in minikube's image cache.
# ─────────────────────────────────────────────────────────────────────────────
load-infra-images:
	@echo "Loading infrastructure images into minikube..."
	@_load_bitnami() { \
		full_tag="$$1"; \
		src_tag="$$2"; \
		img_name=$$(echo "$$full_tag" | cut -d: -f1); \
		if minikube image ls 2>/dev/null | grep -qF "$$full_tag"; then \
			echo "  Already loaded: $$full_tag"; \
		else \
			echo "  Pulling $$src_tag → retag → $$full_tag"; \
			docker pull --quiet "$$src_tag"; \
			docker tag "$$src_tag" "$$full_tag"; \
			minikube image load "$$full_tag"; \
			echo "  Loaded $$full_tag"; \
		fi; \
	}; \
	_load_direct() { \
		full_tag="$$1"; \
		if minikube image ls 2>/dev/null | grep -qF "$$full_tag"; then \
			echo "  Already loaded: $$full_tag"; \
		else \
			echo "  Pulling $$full_tag"; \
			docker pull --quiet "$$full_tag"; \
			minikube image load "$$full_tag"; \
			echo "  Loaded $$full_tag"; \
		fi; \
	}; \
	_load_bitnami "$(POSTGRESQL_IMG)" "docker.io/bitnami/postgresql:latest"; \
	_load_bitnami "$(MONGODB_IMG)"    "docker.io/bitnami/mongodb:latest"; \
	_load_bitnami "$(REDIS_IMG)"      "docker.io/bitnami/redis:latest"; \
	_load_direct  "$(CP_KAFKA_IMG)"; \
	_load_direct  "$(KONG_IMG)"
	@echo "All infrastructure images loaded."

# ─────────────────────────────────────────────────────────────────────────────
## secrets : Create (or recreate) all Kubernetes secrets from secrets.env
# ─────────────────────────────────────────────────────────────────────────────
secrets: _check-secrets _namespace
	@echo "Creating Kubernetes secrets..."
	@RSA_PRIVATE_KEY='$(call _secret,RSA_PRIVATE_KEY)' \
	STRIPE_SECRET_KEY='$(call _secret,STRIPE_SECRET_KEY)' \
	 bash -c '\
		_apply() { \
			kubectl delete secret "$$1" -n $(NAMESPACE) --ignore-not-found=true 2>/dev/null; \
			kubectl create secret generic "$$1" --namespace=$(NAMESPACE) "$${@:2}"; \
			echo "  Secret '"'"'$$1'"'"' applied."; \
		}; \
		\
		_apply auth-service-secrets \
			--from-literal=DATABASE_URL="postgresql://auth_user:auth-local-secret@ticketing-postgres-auth:5432/auth_db" \
			--from-literal=RSA_PRIVATE_KEY="$$RSA_PRIVATE_KEY" \
			--from-literal=JWT_EXPIRY="15m" \
			--from-literal=COOKIE_DOMAIN="localhost" \
			--from-literal=KAFKA_BROKERS="ticketing-cp-kafka.ticketing.svc.cluster.local:9092" \
			--from-literal=REDIS_URL="redis://ticketing-redis-master:6379"; \
		\
		_apply ticket-service-secrets \
			--from-literal=MONGO_URI="mongodb://mongo_user:mongo-local-secret@ticketing-mongodb:27017/tickets?authSource=tickets" \
			--from-literal=MONGO_DB="tickets" \
			--from-literal=KAFKA_BROKERS="ticketing-cp-kafka.ticketing.svc.cluster.local:9092"; \
		\
		_apply order-service-secrets \
			--from-literal=SPRING_DATASOURCE_URL="jdbc:postgresql://ticketing-postgres-orders:5432/orders_db" \
			--from-literal=SPRING_DATASOURCE_USERNAME="orders_user" \
			--from-literal=SPRING_DATASOURCE_PASSWORD="orders-local-secret" \
			--from-literal=KAFKA_BROKERS="ticketing-cp-kafka.ticketing.svc.cluster.local:9092" \
			--from-literal=TICKET_SERVICE_GRPC_HOST="ticketing-ticket-service.ticketing.svc.cluster.local" \
			--from-literal=TICKET_SERVICE_GRPC_PORT="50051" \
			--from-literal=ORDER_EXPIRATION_MINUTES="15"; \
		\
		_apply payment-service-secrets \
			--from-literal=DATABASE_URL="postgresql://payments_user:payments-local-secret@ticketing-postgres-payments:5432/payments_db" \
			--from-literal=STRIPE_SECRET_KEY="$$STRIPE_SECRET_KEY" \
			--from-literal=KAFKA_BROKERS="ticketing-cp-kafka.ticketing.svc.cluster.local:9092"; \
		\
		_apply expiration-service-secrets \
			--from-literal=REDIS_ADDR="ticketing-redis-master:6379" \
			--from-literal=KAFKA_BROKERS="ticketing-cp-kafka.ticketing.svc.cluster.local:9092"; \
	'
	@echo "All secrets created."

# ─────────────────────────────────────────────────────────────────────────────
## kong-config : Re-render Kong declarative config from the base template
# ─────────────────────────────────────────────────────────────────────────────
kong-config: _check-secrets
	@echo "Rendering Kong config for minikube..."
	@KONG_RSA_PUBLIC_KEY='$(call _secret,KONG_RSA_PUBLIC_KEY)' \
		bash $(GATEWAY_DIR)/scripts/build.sh minikube $(KONG_YML)
	@echo "Kong config written to $(KONG_YML)"

# ─────────────────────────────────────────────────────────────────────────────
## helm-upgrade : Run helm upgrade --install (fastest way to re-deploy after config changes)
# ─────────────────────────────────────────────────────────────────────────────
helm-upgrade: _namespace
	@echo "Running helm upgrade --install..."
	@helm dependency update $(HELM_CHART) --skip-refresh 2>/dev/null || \
		helm dependency update $(HELM_CHART)
	@helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(NAMESPACE) \
		--create-namespace \
		--values $(HELM_CHART)/values-local.yaml \
		--set-file "kong.dblessConfig.config=$(KONG_YML)" \
		--set "mongodb.auth.existingSecret=" \
		--set "auth-service.secretRef=auth-service-secrets" \
		--set "ticket-service.secretRef=ticket-service-secrets" \
		--set "order-service.secretRef=order-service-secrets" \
		--set "payment-service.secretRef=payment-service-secrets" \
		--set "expiration-service.secretRef=expiration-service-secrets" \
		--timeout 10m \
		--wait
	@echo "Helm release '$(HELM_RELEASE)' is up."

# ─────────────────────────────────────────────────────────────────────────────
## tunnel : Expose Kong (port 8000) and Kafka (port 9093) on localhost
##          Keep this running in a separate terminal. Requires sudo on macOS.
# ─────────────────────────────────────────────────────────────────────────────
tunnel:
	@echo "Starting minikube tunnel — you may be prompted for your sudo password."
	@echo "Keep this terminal open. Press Ctrl+C to stop."
	@minikube tunnel

# ─────────────────────────────────────────────────────────────────────────────
## status : Show all pods in the ticketing namespace
# ─────────────────────────────────────────────────────────────────────────────
status:
	@kubectl get pods -n $(NAMESPACE)

# ─────────────────────────────────────────────────────────────────────────────
## logs : Tail logs for a specific service
##        Usage: make logs SVC=auth-service
# ─────────────────────────────────────────────────────────────────────────────
logs:
ifndef SVC
	@echo "Usage: make logs SVC=<service-name>"
	@echo "Available services: auth-service ticket-service order-service payment-service expiration-service client"
else
	@kubectl logs -n $(NAMESPACE) deploy/ticketing-$(SVC) -c $(SVC) --follow
endif

# ─────────────────────────────────────────────────────────────────────────────
## restart : Rolling restart a specific service deployment
##           Usage: make restart SVC=client
# ─────────────────────────────────────────────────────────────────────────────
restart:
ifndef SVC
	@echo "Usage: make restart SVC=<service-name>"
	@echo "Available services: auth-service ticket-service order-service payment-service expiration-service client"
else
	@kubectl rollout restart deployment/ticketing-$(SVC) -n $(NAMESPACE)
	@kubectl rollout status deployment/ticketing-$(SVC) -n $(NAMESPACE)
endif

# ─────────────────────────────────────────────────────────────────────────────
## down : Uninstall the Helm release and delete the namespace
# ─────────────────────────────────────────────────────────────────────────────
down:
	@echo "Uninstalling Helm release '$(HELM_RELEASE)'..."
	@helm uninstall $(HELM_RELEASE) -n $(NAMESPACE) 2>/dev/null || true
	@echo "Deleting namespace '$(NAMESPACE)'..."
	@kubectl delete namespace $(NAMESPACE) --ignore-not-found=true
	@echo "Teardown complete."

# ─────────────────────────────────────────────────────────────────────────────
## stop : Stop minikube
# ─────────────────────────────────────────────────────────────────────────────
stop:
	@minikube stop

# ─────────────────────────────────────────────────────────────────────────────
## clean : Full teardown — uninstall release, delete namespace, stop minikube
# ─────────────────────────────────────────────────────────────────────────────
clean: down stop
	@echo "Done. Run 'make up' to start fresh."

# ── Internal helpers (prefixed with _ — not shown in help) ───────────────────

_check-tools:
	@for tool in minikube helm kubectl docker; do \
		command -v $$tool >/dev/null 2>&1 || \
			{ echo "ERROR: '$$tool' is not installed."; exit 1; }; \
	done

_check-secrets:
	@test -f $(SECRETS_FILE) || { \
		echo "ERROR: $(SECRETS_FILE) not found."; \
		echo "Run: cp infra/local/secrets.env.example infra/local/secrets.env"; \
		echo "Then fill in RSA_PRIVATE_KEY, KONG_RSA_PUBLIC_KEY, and STRIPE_SECRET_KEY."; \
		exit 1; \
	}
	@grep -q "^RSA_PRIVATE_KEY=REPLACE_ME" $(SECRETS_FILE) 2>/dev/null && \
		{ echo "ERROR: RSA_PRIVATE_KEY is still a placeholder in secrets.env"; exit 1; } || true
	@grep -q "^KONG_RSA_PUBLIC_KEY=REPLACE_ME" $(SECRETS_FILE) 2>/dev/null && \
		{ echo "ERROR: KONG_RSA_PUBLIC_KEY is still a placeholder in secrets.env"; exit 1; } || true

_minikube-start:
	@if minikube status --profile minikube 2>/dev/null | grep -q "Running"; then \
		echo "minikube is already running."; \
	else \
		echo "Starting minikube (4 CPU, 7168 MB RAM)..."; \
		minikube start --cpus=4 --memory=7168 --disk-size=30g --driver=docker; \
	fi

_namespace:
	@kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null
	@kubectl annotate namespace $(NAMESPACE) \
		config.linkerd.io/skip-outbound-ports="9092" \
		--overwrite 2>/dev/null || true
