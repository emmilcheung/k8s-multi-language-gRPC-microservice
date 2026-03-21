# infra/terraform/modules/vpc/outputs.tf

output "vpc_id" {
  description = "VPC ID."
  value       = module.vpc.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (for EKS nodes, RDS, ElastiCache, MSK)."
  value       = module.vpc.private_subnets
}

output "public_subnet_ids" {
  description = "Public subnet IDs (for ALB / Kong LB)."
  value       = module.vpc.public_subnets
}

output "intra_subnet_ids" {
  description = "Intra subnets (EKS control-plane ENIs — no internet route)."
  value       = module.vpc.intra_subnets
}
