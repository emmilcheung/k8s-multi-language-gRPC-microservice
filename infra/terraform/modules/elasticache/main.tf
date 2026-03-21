# infra/terraform/modules/elasticache/main.tf
# ElastiCache Redis cluster — used by auth-service (refresh tokens),
# expiration-service (delayed jobs), and Kong (rate-limit counters).

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Allow Redis traffic from within the VPC"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-redis" }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "Redis for ${local.name}"

  node_type          = var.node_type
  num_cache_clusters = var.environment == "prod" ? 3 : 1
  port               = 6379

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  automatic_failover_enabled = var.environment == "prod" ? true : false

  tags = { Name = local.name }
}
