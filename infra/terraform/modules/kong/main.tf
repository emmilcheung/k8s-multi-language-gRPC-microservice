# infra/terraform/modules/kong/main.tf
#
# Deploys Kong API Gateway in DB-less mode onto an existing EKS cluster using
# the official Kong Helm chart. The declarative configuration (routes, services,
# plugins, JWT consumers) is mounted from a Kubernetes ConfigMap whose content
# is the same `infra/kong/kong.yml` used for local Docker Compose development.
#
# Prerequisites (applied before this module):
#   - EKS cluster is running and kubectl context is configured.
#   - The `infra` namespace exists (created by this module if absent).
#   - A ConfigMap named `var.kong_config_map_name` containing the kong.yml
#     content has been applied (done by the umbrella Helm chart or separately).
#
# Provider requirements: helm ~> 2.13, kubernetes ~> 2.30
# Both providers must be configured in the calling environment's main.tf.

resource "kubernetes_namespace" "infra" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      project                        = var.project
      environment                    = var.environment
    }
  }

  # Ignore if namespace already exists (e.g. created by cluster bootstrap).
  lifecycle {
    ignore_changes = [metadata[0].annotations, metadata[0].labels]
  }
}

resource "helm_release" "kong" {
  name       = "kong"
  repository = "https://charts.konghq.com"
  chart      = "kong"
  version    = var.kong_chart_version
  namespace  = kubernetes_namespace.infra.metadata[0].name

  # Wait for all pods to be ready before marking the release as complete.
  wait    = true
  timeout = 600 # 10 minutes — Kong may pull a large image on first deploy

  # ── DB-less mode ──────────────────────────────────────────────────────────
  set {
    name  = "env.database"
    value = "off"
  }

  # Mount the declarative config from the pre-existing ConfigMap.
  set {
    name  = "dblessConfig.configMap"
    value = var.kong_config_map_name
  }

  # ── Proxy service ─────────────────────────────────────────────────────────
  set {
    name  = "proxy.type"
    value = var.proxy_service_type
  }

  # Annotate the proxy service so the AWS Load Balancer Controller provisions
  # an NLB (Network Load Balancer) rather than a CLB.
  set {
    name  = "proxy.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-type"
    value = "nlb"
  }

  set {
    name  = "proxy.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-scheme"
    value = "internet-facing"
  }

  # ── Admin API ─────────────────────────────────────────────────────────────
  # Disabled in production; enabled only when var.admin_service_enabled = true.
  set {
    name  = "admin.enabled"
    value = var.admin_service_enabled ? "true" : "false"
  }

  set {
    name  = "admin.type"
    value = "ClusterIP" # Never expose the Admin API externally.
  }

  # ── Replicas ──────────────────────────────────────────────────────────────
  set {
    name  = "replicaCount"
    value = var.replica_count
  }

  # ── Resources ─────────────────────────────────────────────────────────────
  set {
    name  = "resources.requests.cpu"
    value = var.cpu_request
  }

  set {
    name  = "resources.requests.memory"
    value = var.memory_request
  }

  set {
    name  = "resources.limits.cpu"
    value = var.cpu_limit
  }

  set {
    name  = "resources.limits.memory"
    value = var.memory_limit
  }

  # ── Probes ────────────────────────────────────────────────────────────────
  set {
    name  = "readinessProbe.httpGet.path"
    value = "/status"
  }

  set {
    name  = "readinessProbe.httpGet.port"
    value = "metrics"
  }

  set {
    name  = "livenessProbe.httpGet.path"
    value = "/status"
  }

  set {
    name  = "livenessProbe.httpGet.port"
    value = "metrics"
  }

  # ── Pod disruption budget ─────────────────────────────────────────────────
  set {
    name  = "podDisruptionBudget.enabled"
    value = "true"
  }

  set {
    name  = "podDisruptionBudget.minAvailable"
    value = "1"
  }

  # ── Topology spread ───────────────────────────────────────────────────────
  # Spread pods across availability zones to match AGENTS.md §11.1.
  set {
    name  = "topologySpreadConstraints[0].maxSkew"
    value = "1"
  }

  set {
    name  = "topologySpreadConstraints[0].topologyKey"
    value = "topology.kubernetes.io/zone"
  }

  set {
    name  = "topologySpreadConstraints[0].whenUnsatisfiable"
    value = "DoNotSchedule"
  }

  set {
    name  = "topologySpreadConstraints[0].labelSelector.matchLabels.app"
    value = "kong"
  }

  # ── Metrics (Prometheus) ──────────────────────────────────────────────────
  set {
    name  = "serviceMonitor.enabled"
    value = "true"
  }

  # ── Common labels ─────────────────────────────────────────────────────────
  set {
    name  = "commonLabels.project"
    value = var.project
  }

  set {
    name  = "commonLabels.environment"
    value = var.environment
  }

  depends_on = [kubernetes_namespace.infra]
}

# ── Data source: resolve the proxy LoadBalancer hostname after deployment ───
# This may be empty immediately after apply if the NLB is still provisioning.
# Use `terraform refresh` or re-apply to pick up the hostname once it is ready.
data "kubernetes_service" "kong_proxy" {
  metadata {
    name      = "${helm_release.kong.name}-kong-proxy"
    namespace = kubernetes_namespace.infra.metadata[0].name
  }

  depends_on = [helm_release.kong]
}
