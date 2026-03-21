# infra/terraform/modules/elasticache/outputs.tf

output "primary_endpoint" {
  value     = aws_elasticache_replication_group.this.primary_endpoint_address
  sensitive = true
}

output "reader_endpoint" {
  value     = aws_elasticache_replication_group.this.reader_endpoint_address
  sensitive = true
}
