# infra/terraform/modules/eks/outputs.tf

output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value     = module.eks.cluster_endpoint
  sensitive = true
}

output "cluster_certificate_authority_data" {
  value     = module.eks.cluster_certificate_authority_data
  sensitive = true
}

output "cluster_oidc_issuer_url" {
  description = "OIDC provider URL — used to create IRSA roles for service accounts."
  value       = module.eks.cluster_oidc_issuer_url
}

output "oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

# Karpenter ────────────────────────────────────────────────────

output "karpenter_node_iam_role_name" {
  description = "IAM role assumed by Karpenter-launched nodes."
  value       = module.karpenter.node_iam_role_name
}

output "karpenter_interruption_queue_name" {
  description = <<-EOT
    SQS queue carrying spot reclaim and scheduled-maintenance notices. If this
    queue fills or its consumer stops, Karpenter only learns a node is going
    away when it is already gone.
  EOT
  value       = module.karpenter.queue_name
}
