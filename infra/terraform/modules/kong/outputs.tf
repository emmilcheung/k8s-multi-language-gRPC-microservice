# infra/terraform/modules/kong/outputs.tf

output "proxy_url" {
  description = "Kong proxy load balancer hostname (empty until the NLB is provisioned by AWS)."
  value = try(
    data.kubernetes_service.kong_proxy.status[0].load_balancer[0].ingress[0].hostname,
    ""
  )
}

output "proxy_service_name" {
  description = "Kubernetes Service name for the Kong proxy."
  value       = "${helm_release.kong.name}-kong-proxy"
}

output "namespace" {
  description = "Kubernetes namespace where Kong is deployed."
  value       = kubernetes_namespace.infra.metadata[0].name
}

output "helm_release_status" {
  description = "Helm release status (e.g. deployed, failed)."
  value       = helm_release.kong.status
}
