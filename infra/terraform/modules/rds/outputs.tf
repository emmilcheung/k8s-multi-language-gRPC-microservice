# infra/terraform/modules/rds/outputs.tf

output "auth_endpoint" {
  value     = aws_db_instance.auth.endpoint
  sensitive = true
}

output "orders_endpoint" {
  value     = aws_db_instance.orders.endpoint
  sensitive = true
}

output "payments_endpoint" {
  value     = aws_db_instance.payments.endpoint
  sensitive = true
}
