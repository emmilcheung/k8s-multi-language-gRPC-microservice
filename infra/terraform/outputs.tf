# infra/terraform/outputs.tf
# Root-level outputs — consumed by CI/CD and the Helm deploy step.

output "vpc_id" {
  description = "ID of the VPC."
  value       = module.vpc.vpc_id
}

output "eks_cluster_name" {
  description = "EKS cluster name — used by kubectl and helm."
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
  sensitive   = true
}

output "eks_cluster_certificate_authority_data" {
  description = "Base64-encoded CA certificate for the EKS cluster."
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "rds_auth_endpoint" {
  description = "auth-service PostgreSQL endpoint."
  value       = module.rds.auth_endpoint
  sensitive   = true
}

output "rds_orders_endpoint" {
  description = "order-service PostgreSQL endpoint."
  value       = module.rds.orders_endpoint
  sensitive   = true
}

output "rds_payments_endpoint" {
  description = "payment-service PostgreSQL endpoint."
  value       = module.rds.payments_endpoint
  sensitive   = true
}

output "elasticache_primary_endpoint" {
  description = "Redis (ElastiCache) primary endpoint."
  value       = module.elasticache.primary_endpoint
  sensitive   = true
}

output "msk_bootstrap_brokers" {
  description = "MSK bootstrap broker string (TLS)."
  value       = module.msk.bootstrap_brokers_tls
  sensitive   = true
}

output "kong_proxy_url" {
  description = "Kong proxy load balancer DNS name."
  value       = module.kong.proxy_url
}
