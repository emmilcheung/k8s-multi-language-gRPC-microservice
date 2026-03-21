# infra/terraform/modules/rds/main.tf
# RDS module — three separate PostgreSQL instances (one per service that owns a PG DB).
# auth-service, order-service, payment-service each get an isolated DB.

locals {
  name = "${var.project}-${var.environment}"
}

# Shared DB subnet group across all three instances
resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.subnet_ids

  tags = { Name = local.name }
}

# Shared security group — allows access only from within the VPC (EKS nodes)
resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Allow PostgreSQL traffic from within the VPC"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds" }
}

# ── auth-service PostgreSQL ───────────────────────────────────────────────────
resource "aws_db_instance" "auth" {
  identifier        = "${local.name}-auth"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.instance_class
  allocated_storage = 20

  db_name  = "auth_db"
  username = "auth_user"
  # Password comes from Secrets Manager — managed separately, not in Terraform state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = var.environment == "prod" ? true : false
  skip_final_snapshot = var.environment != "prod"
  deletion_protection = var.environment == "prod"

  backup_retention_period = var.environment == "prod" ? 7 : 1
  storage_encrypted       = true

  tags = { Name = "${local.name}-auth" }
}

# ── order-service PostgreSQL ──────────────────────────────────────────────────
resource "aws_db_instance" "orders" {
  identifier        = "${local.name}-orders"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.instance_class
  allocated_storage = 20

  db_name                     = "orders_db"
  username                    = "orders_user"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = var.environment == "prod" ? true : false
  skip_final_snapshot = var.environment != "prod"
  deletion_protection = var.environment == "prod"

  backup_retention_period = var.environment == "prod" ? 7 : 1
  storage_encrypted       = true

  tags = { Name = "${local.name}-orders" }
}

# ── payment-service PostgreSQL ────────────────────────────────────────────────
resource "aws_db_instance" "payments" {
  identifier        = "${local.name}-payments"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.instance_class
  allocated_storage = 20

  db_name                     = "payments_db"
  username                    = "payments_user"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = var.environment == "prod" ? true : false
  skip_final_snapshot = var.environment != "prod"
  deletion_protection = var.environment == "prod"

  backup_retention_period = var.environment == "prod" ? 7 : 1
  storage_encrypted       = true

  tags = { Name = "${local.name}-payments" }
}
