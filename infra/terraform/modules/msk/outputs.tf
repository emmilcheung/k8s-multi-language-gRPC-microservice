# infra/terraform/modules/msk/outputs.tf

output "bootstrap_brokers_tls" {
  description = "TLS bootstrap broker string for services (use with SASL/IAM)."
  value       = aws_msk_cluster.this.bootstrap_brokers_sasl_iam
  sensitive   = true
}

output "zookeeper_connect_string" {
  description = "Kept for tooling compatibility — cluster runs in KRaft mode, ZooKeeper not used."
  value       = aws_msk_cluster.this.zookeeper_connect_string
  sensitive   = true
}
